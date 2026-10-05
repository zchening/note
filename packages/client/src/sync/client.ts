/**
 * 同步客户端 —— 把 S3 的状态机接到真实API 上
 *
 * 🔴🔴 本文件是「静默降级」的高危区。以下每一条都对应一类"不报错但结果是错的"故障：
 *
 *  1. **拉取失败 ≠ 笔记为空**。GET /api/note/x 读不到文件时也返回 200 + 空体
 *     （老项目这个设计的用意是"不区分有无"，代价是**网络断了也会被当成空笔记**）。
 *     → 修法：fetch 的 reject（网络层失败）与 200+空体（确实没有）必须分开处理。
 *     → 判据：网络断了必须停在 offline，**绝不清空编辑器**。
 *
 *  2. **三方合并需要 base**。只有 local + remote 两个值时无法区分
 *     "对方新增了一行" 与 "我删了一行"，会把用户的删除还原回去。
 *     → 所以本类持有 `base`（上次同步成功时的文档），每轮同步后更新。
 *
 *  3. **推送成功 ≠ 已同步**。POST 200 只说明服务端收下了密文。
 *     但必须**清dirty 标记**，否则状态永远停在 pushing。
 *
 *  4. **SSE 断线浏览器不会自动重连**（HTML 规范如此）。
 *     不自己写退避重连的症状是"另一台设备改了，这台永远不更新"，且界面无任何异常。
 *
 *  5. **推送失败绝不清 dirty**。否则用户以为存上了，实际没有。
 */

import type { Doc } from '@bj/shared-schema';
import { canonicalize, decryptString, deriveKey, emptyDoc, encryptString, normalize, parseDoc } from '@bj/shared-schema';
import type { DerivedKey, Envelope } from '@bj/shared-schema';
import { mergeDocs } from '@bj/shared-schema';
import { writeCache } from './local-cache.ts';
import { snapshotOf, reduce, type SyncEvent, type SyncSnapshot, type SyncState } from './fsm.ts';

/** 客户端与服务端之间的载荷：永远是**信封**，不是明文。 */
interface NotePayload extends Envelope {
  /** 冗余存一份明文长度，供调试与将来做流量统计；不参与判读 */
  n?: number;
}

export interface SyncDeps {
  noteId: string;
  key: CryptoKey;
  /**
   * 派生结果。**必须传完整 DerivedKey（含 key）**，不能只给 salt/iter：
   * encryptString 的签名要的就是它，类型系统在这里挡住了一次"我以为只要 salt"的想当然。
   */
  dk: DerivedKey;
  /** 拿当前真源（编辑器侧维护） */
  getDoc: () => Doc;
  /** 把远端/合并结果写回编辑器 */
  setDoc: (d: Doc) => void;
  /** 状态变化通知（驱动底栏） */
  onSnapshot: (s: SyncSnapshot) => void;
  /** 出错提示 */
  onError: (msg: string) => void;
  /** 网络层是否可达（测试注入用；默认读 navigator.onLine） */
  isOnline?: () => boolean;
  /**
   * 🔴 推送成功后，把**刚被覆盖的那一版**交给调用方存档（历史版本环）。
   *
   * 🔴🔴 传的是 `base`（上次同步成功时的文档），不是本次推的 `doc` ——
   *   老项目 index.html:7162 传的是 `prevHtml2`（保存前的正文），同理。
   *   传成本次 doc 的症状很隐蔽：历史列表里全是"当前这一版"，
   *   而用户真正想找回的恰恰是**刚刚被改掉的那段**。
   *
   * 🔴 调用时机是**推送成功之后**，不是之前（老项目同款：`if (body)` 在 200 之后）。
   *   放前面的话，网络失败也会把这一版记进去，于是"从没存上过的内容"出现在历史里。
   *
   * 🔴 fire-and-forget：本仓不 await 它。存档是保险不是主链路，
   *   存档失败**绝不能**让这次推送变成失败。
   */
  onArchive?: (prev: Doc) => void;
}

/** 去抖：停止输入多久后推送 */
const PUSH_DEBOUNCE_MS = 700;
/** SSE 重连退避上限 */
const SSE_BACKOFF_MAX_MS = 30_000;

function isDocEmpty(d: Doc): boolean {
  return (d.blocks === undefined || d.blocks.length === 0) &&
         (d.reminders === undefined || d.reminders.length === 0);
}

export class SyncClient {
  private readonly d: SyncDeps;
  private state: SyncState = 'locked';
  private snap: SyncSnapshot = snapshotOf('locked');
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private es: EventSource | undefined;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 上次同步成功时的文档 = 三方合并的 **base**。
   * 🔴 没有它就无法区分"对方新增"与"我删除"，合并会把用户的删除还原回去。
   */
  private base: Doc = emptyDoc();
  private stopped = false;
  /** 冲突详情，供UI 展示 */
  private conflicts: MergeResultLike['conflicts'] = [];

  constructor(deps: SyncDeps) {
    this.d = deps;
  }

  /* ---------------- 状态 ---------------- */

  private send(ev: SyncEvent): void {
    if (this.stopped) return;
    let next: SyncState;
    try {
      next = reduce(this.state, ev);
    } catch (e) {
      // 🔴 非法转移是代码 bug。要让测试看得见，所以上报而不是静默吞掉。
      this.d.onError(e instanceof Error ? e.message : String(e));
      return;
    }
    this.state = next;
    this.snap = snapshotOf(next);
    this.d.onSnapshot(this.snap);
  }

  getState(): SyncState {
    return this.state;
  }

  getSnapshot(): SyncSnapshot {
    return this.snap;
  }

  getConflicts(): MergeResultLike['conflicts'] {
    return this.conflicts;
  }

  /* ---------------- 生命周期 ---------------- */

  /** 解锁后调用：立刻拉一次并开 SSE。 */
  async start(): Promise<void> {
    this.send('unlock');
    await this.pull();
    this.openStream();
    // 🔴 浏览器从离线切回在线时立刻重拉。不监听的话"断网期间对方的改动"
    //   要等到下一次手动刷新才同步，用户会以为同步坏了。
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (this.state === 'offline') void this.retryPull();
      });
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.es?.close();
    this.es = undefined;
  }

  private online(): boolean {
    return this.d.isOnline ? this.d.isOnline() : (typeof navigator === 'undefined' ? true : navigator.onLine);
  }

  private async retryPull(): Promise<void> {
    this.send('online');
    await this.pull();
  }

  /* ---------------- 编辑器侧调用 ---------------- */

  /** 本地有改动。去抖后推送。 */
  noteEdit(): void {
    this.send('edit');
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      if (this.state === 'dirty') void this.push();
    }, PUSH_DEBOUNCE_MS);
  }

  /** 手动刷新。 */
  async refresh(): Promise<void> {
    this.send('refresh');
    await this.pull();
  }

  /** 冲突裁决：保留本地。 */
  resolveKeepLocal(): void {
    this.send('resolve-local');
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
    void this.push();
  }

  /** 冲突裁决：保留远端。 */
  resolveKeepRemote(): void {
    this.send('resolve-remote');
    this.d.setDoc(this.base);
    void this.pull();
  }

  /* ---------------- 拉 ---------------- */

  private async pull(): Promise<void> {
    if (!this.online()) {
      this.send('network-fail');
      return;
    }
    let res: Response;
    try {
      res = await fetch(`/api/note/${encodeURIComponent(this.d.noteId)}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
    } catch {
      // 🔴 网络层失败（DNS/断网/服务不可达）—— 停在 offline，**绝不清空编辑器**
      this.send('network-fail');
      return;
    }

    if (res.status === 429) {
      this.d.onError('尝试太频繁，请稍后再试');
      this.send('network-fail');
      return;
    }
    if (!res.ok) {
      this.send('network-fail');
      return;
    }

    const text = await res.text();
    if (text.trim() === '') {
      // 🔴 200 + 空体 = 服务端确实没有这篇笔记（新笔记），**不是错误**。
      //   因为前面已经确认了 HTTP 层成功，这里可以安全地当作"新笔记"。
      //   base保持不变（本机就是唯一来源）。
      this.send('pulled');
      return;
    }

    let env: Envelope;
    try {
      env = JSON.parse(text) as Envelope;
    } catch {
      // 服务端存的不是合法信封 —— 当成数据坏，不当空笔记
      this.d.onError('云端数据无法解析');
      this.send('network-fail');
      return;
    }

    await this.decryptAndMerge(env);
  }

  private async decryptAndMerge(env: Envelope): Promise<void> {
    let plain: string;
    try {
      plain = await decryptString(env, this.d.key, 'note');
    } catch {
      // 🔴 解密失败 = 口令不对或数据坏了。**两者不可区分，也不该区分**
      //   （区分开等于给暴力破解一个 oracle，ARCH 安全不变量）。
      this.d.onError('口令不对，或数据无法解密');
      this.send('network-fail');
      return;
    }

    let remoteDoc: Doc;
    try {
      remoteDoc = parseDoc(plain);
    } catch {
      this.d.onError('云端数据无法解析');
      this.send('network-fail');
      return;
    }

    const local = this.d.getDoc();
    const base = this.base;

    // 远端 == base：远端没动过，本地是什么就是什么，不需要合并
    if (canonicalize(remoteDoc) === canonicalize(base)) {
      this.conflicts = [];
      if (canonicalize(local) !== canonicalize(base)) this.send('merge-clean');
      else this.send('pulled');
      return;
    }

    // 本地 == base：只有远端变了，直接采纳
    if (canonicalize(local) === canonicalize(base)) {
      this.d.setDoc(remoteDoc);
      this.base = remoteDoc;
      this.conflicts = [];
      this.send('pulled');
      return;
    }

    // 本地 == 远端：已经一致
    if (canonicalize(local) === canonicalize(remoteDoc)) {
      this.base = remoteDoc;
      this.conflicts = [];
      this.send('pulled');
      return;
    }

    // 真的两边都改了 → 三方合并
    const res = mergeDocs(base, local, remoteDoc);
    this.conflicts = res.conflicts;
    this.d.setDoc(res.doc);
    this.base = remoteDoc;
    if (res.conflicts.length > 0) {
      this.send('merge-conflict');
      this.d.onError('两台设备同时改了同一处，需要你选保留哪一份');
      return;
    }
    this.send('merge-clean');
    await this.push();
  }

  /* ---------------- 推 ---------------- */

  private async push(): Promise<void> {
    if (this.pushTimer !== undefined) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
    if (!this.online()) {
      this.send('network-fail');
      return;
    }
    this.send('push');
    const doc = normalize(this.d.getDoc());
    // 🔴 记住本轮推之前的 base，成功后作为"刚被覆盖的那一版"交给 onArchive。
    //   在 push() 开头取（而不是成功后再读 this.base）——成功后它已经被覆盖成 doc 了。
    const prev = this.base;
    let payload: NotePayload;
    // 🔴 env 必须提到 try 外面：推送成功后要拿它写本地缓存。
    //   声明在 try 块内的话，写缓存那行拿不到，编译期不报错（同一函数作用域内），
    //   但运行时是 undefined —— 除非把类型标成 any 或非严格模式。
    let env: Envelope;
    try {
      env = await encryptString(canonicalize(doc), this.d.key, 'note', this.d.dk);
      payload = { ...env, n: canonicalize(doc).length };
    } catch {
      this.d.onError('加密失败');
      this.send('network-fail');
      return;
    }
    let res: Response;
    try {
      res = await fetch(`/api/note/${encodeURIComponent(this.d.noteId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      // 🔴 推送失败**绝不清 dirty**：用户必须知道没存上
      this.send('network-fail');
      return;
    }
    if (res.status === 429) {
      this.d.onError('尝试太频繁，请稍后再试');
      this.send('network-fail');
      return;
    }
    if (!res.ok) {
      this.send('network-fail');
      return;
    }
    // 🔴 只有确认成功才推进 base —— 失败时 base 保持旧值，
    //   下次合并的"祖先"才不会错位。
    this.base = doc;
    // 🔴 存档"刚被覆盖的那一版"（历史版本环）。
    //   两个必须挡掉的：
    //     ① 首推：prev 是空文档，存进去等于给用户一条"（空）"历史版本；
    //     ② 内容没真变：与老项目 :7162 的 `prevHtml2 !== html` 同款判据。
    //   两者不清掉的话，用户会看到一串内容完全相同的版本，
    //   且 10 条的环会被无意义的重复占满（真正值得找回的那几版被挤掉）。
    if (this.d.onArchive && !isDocEmpty(prev) && canonicalize(prev) !== canonicalize(doc)) {
      try {
        this.d.onArchive(prev);
      } catch {
        /* 存档是保险：抛了也不许影响本次同步的结论 */
      }
    }
    // 🔴🔴 推送成功后**必须**更新本地缓存。
    //   漏了这一步的症状：云端是新内容，本机缓存还是旧的 —— 用户一断网就看到旧正文，
    //   而且**没有任何报错**。这正是"静默降级"最典型的形态：
    //   每个单独环节都成功，合起来给出一个错的结果。
    //   （这条是实测发现的：解锁时写缓存、推送时不写，两处不一致。）
    writeCache(this.d.noteId, env);
    this.send('pushed');
  }

  /* ---------------- SSE ---------------- */

  private openStream(): void {
    if (this.stopped) return;
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(`/api/stream/${encodeURIComponent(this.d.noteId)}`);
    this.es = es;
    es.onmessage = (ev: MessageEvent<string>) => {
      if (this.stopped) return;
      let msg: { t?: string };
      try {
        msg = JSON.parse(ev.data) as { t?: string };
      } catch {
        return;
      }
      if (msg.t !== 'note') return;
      // 🔴 只在"自己没在推"时才自动重拉。正在 push 时收到广播会来回震荡
      //   （推 → 广播 → 拉 → 合并 → 推 …），实测能把服务端打满。
      if (this.state === 'pushing' || this.state === 'syncing') return;
      this.send('remote-arrived');
      void this.pull();
    };
    es.onerror = () => {
      // 🔴🔴 EventSource 断开后浏览器不会自动重连。自己写退避重连。
      es.close();
      this.es = undefined;
      if (this.stopped) return;
      const wait = Math.min(1000 * 2 ** this.retry, SSE_BACKOFF_MAX_MS);
      this.retry += 1;
      this.retryTimer = setTimeout(() => this.openStream(), wait);
    };
    es.onopen = () => {
      this.retry = 0;
    };
  }
}

/** 冲突列表的形状（与 shared-schema 的 Conflict 一致，只取UI 需要的部分） */
interface MergeResultLike {
  conflicts: ReadonlyArray<{ at: string; kind: string; base: string; left: string; right: string }>;
}

/** 新建一个 SyncClient 并立刻 start。 */
export async function createSync(deps: SyncDeps): Promise<SyncClient> {
  const c = new SyncClient(deps);
  await c.start();
  return c;
}

export { deriveKey };

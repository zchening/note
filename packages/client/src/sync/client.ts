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
  /**
   * 出错提示 ——🔴 **用户可见文案**，会被main.ts:1567-1569 直接
   * `footStatus('offline', msg)` 推到屏幕底栏。
   *
   * ⇒ 只有"用户能据此行动"的错误才能走这里（口令不对、解析失败、429…）。
   * **内部异常 / 编程错误绝不许走这里**：老项目的底栏文案是一份 30 句白名单
   *（`grep -o "setStatus(\(true\|false\), *'[^']*'" index.html | sort -u` 可复现），
   * 里面**从来没有**"非法状态转移"这种词；把内部异常塞进来等于给用户看调试信息。
   * 内部错误请走 {@link SyncDeps.onInternalError}。
   */
  onError: (msg: string) => void;
  /**
   * 内部/编程错误通道 —— **不进 UI**，只做可观测。
   *
   * 🔴🔴 为什么必须有它（不能"反正没人看就吞掉"）：静默吞掉会让状态机变成
   *   不可观测的黑洞，症状是"同步偶尔不推、也不报错、也不提示"，
   *   也就是本文件头列的那类静默降级。所以内部错误必须**看得见**，
   *   只是不能**让用户看见**。
   *
   * 选它的理由：SyncDeps 上原有的两条通道都会污染底栏 ——
   *   onSnapshot 驱动底栏文案（main.ts:1560-1565），onError 直接 footStatus。
   *   没有任何一条既有通道能"可观测但不打扰用户"，所以必须新增一条。
   *
   * 不传时退化为 `console.warn`（开发态可见、线上不打扰用户），
   * 因此**不传也不会丢日志**，且不必让 main.ts 立刻配合就能修掉用户报障。
   */
  onInternalError?: (msg: string, err: unknown) => void;
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
  /**
   * 🔴 待落本地缓存的密文信封（由 `noteEdit` → `stageEnv` 提前备好）。
   * 页面卸载时 `flushPending` 直接拿它写 localStorage，不等去抖也不等网络。
   * 见 flushPending 的注释（那是这个字段存在的唯一理由）。
   */
  private pendingEnv: Envelope | undefined;
  /** stageEnv 的序号：只认最后一次编辑的结果，见 stageEnv 注释里的并发段。 */
  private envSeq = 0;
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
      // 🔴🔴🔴 非法转移是**代码 bug**，不是用户错误。此前这里调`this.d.onError(msg)`，
      //   而 main.ts:1567-1569 的 onError 是 `footStatus('offline', msg)`
      //   —— 直接把内部异常消息当用户可见文案推到屏幕底栏。
      //   用户报障原文：「底部状态栏快速闪出红点 +『最后同步：非法状态转移：…』」。
      //   老版本不会有这个现象，因为它**根本没有状态机**，底栏只有 setStatus(on, text)
      //   （index.html:1723）一个函数，文案是 30 句固定白名单，
      //   SSE 收到推送后的动作是 `sseSource.onmessage = () => { poll(); }`
      //   （index.html:10047）—— **重新拉一次，永远不报状态错误**。
      //
      //   ⇒ 改走 onInternalError：可观测（不许黑洞），但不污染底栏。
      //   fsm.ts 已按老项目口径补齐 6 条真实时序会踩到的边，
      //   这里仍兜住，是为了让"再有新漏的边"退化成控制台一行日志而非用户可见红点。
      this.reportInternal(`同步状态机非法转移：${this.state} --${ev}-->`, e);
      return;
    }
    this.state = next;
    this.snap = snapshotOf(next);
    this.d.onSnapshot(this.snap);
  }

  /**
   * 上报内部/编程错误：**可观测，但不进 UI**。
   *
   * 不传 onInternalError 时退化为 console.warn —— 开发态能在控制台看到，
   * 线上不会打扰用户；因此调用方不配合也不会把日志丢掉。
   */
  private reportInternal(msg: string, err: unknown): void {
    if (this.d.onInternalError) {
      this.d.onInternalError(msg, err);
      return;
    }
    console.warn(`[notesync] ${msg}`, err);
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
    // 🔴🔴 同时**立刻**启动一次信封构造挂到 pendingEnv —— 不等去抖窗口。
    //   理由见 flushPending() 的注释：700ms 窗口内卸载时，数据必须已经能落到本地。
    //   加密是异步且很贵的（PBKDF2 600,000 次），所以这里是"发起"而不是"等结果"；
    //   pendingEnv 会被**后一次**编辑的结果覆盖（后写的版本才是要存的那一版）。
    void this.stageEnv();
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      if (this.state === 'dirty') void this.push();
    }, PUSH_DEBOUNCE_MS);
  }

  /**
   * 构造待推信封并挂到 `pendingEnv`（供页面卸载时抢在网络之前落本地）。
   *
   * 🔴🔴 旧实现只在 `push()` 里写缓存，而 `noteEdit()` 到 `push()` 之间有 700ms 去抖 ——
   *   实测（探针 probe-cache-vs-cloud）打字后立刻查，缓存键**根本不存在**。
   *   ⇒ 数据在那 700ms 里只存在于内存，页面一卸载就没了（probe-ep01-flow 实锤）。
   *
   * 🔴 为什么不能在 `noteEdit` 里同步写缓存：加密是异步的（PBKDF2 600,000 次），
   *   同步写只能写到"上一版"的内容 —— 那等于把旧内容当成新内容存回去。
   *
   * 🔴 并发安全：连着打字时会有多次 stageEnv 在飞，靠 `envSeq` 序号**只认最后一次**。
   *   不做这件事的话，先发后到的 completion 会用旧信封覆盖新的 pendingEnv
   *   —— 症状是"用户最后敲的那几个字在页面上可见，但落盘的是前一版"，
   *   而且**只在网络慢时出现**，极难复现。
   */
  private async stageEnv(): Promise<void> {
    const seq = ++this.envSeq;
    const doc = normalize(this.d.getDoc());
    try {
      const env = await encryptString(canonicalize(doc), this.d.key, 'note', this.d.dk);
      if (seq !== this.envSeq) return; // 已有更新的一次在飞，这次的结果作废
      this.pendingEnv = env;
    } catch {
      // 加密失败不写 pendingEnv —— flushPending 会跳过本地落盘，
      // 那正好是对的：没有有效信封就别写，宁可让这次编辑在下次 push 时重新走一遍。
    }
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

  /**
   * 页面即将离开时把待推的内容**立刻**落盘 + 推掉，不等去抖窗口。
   *
   * 🔴🔴 老项目有同款兜底：`window.addEventListener('pagehide', flushDirtySave)`
   *   （index.html:10080，注释里叫"脏内容与在途保存的卸载兜底链"）。
   *   本项目此前**没有**这条，于是坐实了一个数据丢失缺陷，探针 probe-ep01-flow 实锤：
   *     打完 A/空行/B 立刻 reload → 重载后真源 `{"v":1}`，**刚打的字与空行全丢**。
   *
   * 🔴🔴 为什么"提前到 push 之前写缓存"**不够**（我走过一遍）：
   *   缓存写在 `push()` 内部，而 `noteEdit()` 到 `push()` 之间还有
   *   `PUSH_DEBOUNCE_MS = 700` 的去抖窗口 —— 实测（probe-cache-vs-cloud）
   *   打字后立刻查：缓存键**不存在**。所以 700ms 内卸载，那一步根本没执行。
   *   ⇒ 落盘必须在**事件处理器里当场**做，不能委托给"稍后会跑的 push"。
   *
   * 🔴🔴 但加密是**异步且很贵**的（PBKDF2 600,000 次），`pagehide` 里 await 是来不及的
   *   —— 事件处理器不会被等，异步 continuation 页面已卸载 ⇒ 等于什么都没做。
   *   所以这里走**老项目同款的另一条路**：把待推的**明文信封构造**提前准备好。
   *   实现方式是：每次 `noteEdit()` 就启动一次加密并把结果挂到 `pendingEnv`，
   *   `flushPending()` 直接拿它写缓存 —— 不等 push、不等网络。
   *
   * 🔴 为什么 `pagehide` 而不是 `beforeunload`：
   *   `beforeunload` 会阻塞卸载、且在移动端/bfcache 场景经常不触发；
   *   `pagehide` 覆盖"关闭/刷新/前进后退/BFCache 入库"四种路径，是老项目选它的原因。
   *
   * 🔴 不能用 `sendBeacon`：推的是**密文信封**，而解密 key 只在内存里
   *   （`currentDk`），页面卸载后服务端拿不到；而 `sendBeacon` 也不支持 PUT/自定义头。
   *
   * 🔴 最坏情况的诚实说明：这一条**不能 100% 保证云端收到**（fetch 可能被浏览器丢弃）。
   *   但**本机那份是同步写进 localStorage 的**，所以"本机丢字"这个用户可见的故障
   *   被彻底消除了；剩下的只是"换台设备要晚几秒才看到"，由下次push/SSE 补上。
   */
  flushPending(): void {
    if (this.pushTimer !== undefined) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
    }
    if (this.pendingEnv !== undefined) {
      // 🔴 抢在网络之前落本地：本地副本是权威，云端只是备份。
      try {
        writeCache(this.d.noteId, this.pendingEnv);
      } catch {
        /* 存不下不抛：见 push() 里同一处 try 的注释 */
      }
      this.pendingEnv = undefined;
    }
    if (this.state !== 'dirty') return;
    void this.push();
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
    // 🔴🔴🔴 本地缓存必须在**发请求之前**写，不能等 push 成功。
    //
    //   实测缺陷（探针 probe-cache-vs-cloud 量化）：
    //     打完字立刻查 → syncState=dirty、**缓存键根本不存在**（数据只在内存）
    //     等 1500ms  → idle、缓存键出现（251 字节）
    //   也就是说旧实现在"编辑完成 → push 返回"这段窗口里，**唯一的副本在内存里**。
    //   用户在这个窗口内刷新/关页面/切走（`PUSH_DEBOUNCE_MS=700` 就是这个窗口），
    //   重载后真源回到 `{"v":1}` —— **刚打的字与空行全丢**（探针 probe-ep01-flow 实锤）。
    //
    //   🔴 为什么这样才是对的语义：本地副本是**权威**，云端是备份。
    //     离线优先的客户端就该"先落本地、再谈上传"。push 失败时用户重新打开
    //     仍能看到自己刚写的内容 —— 这才是本地优先；而旧实现把"本地能不能读到"
    //     挂在"云端写成功没有"上，等于把网络状态当成了本地数据的前置条件。
    //   🔴 与 `resolveKeepLocal` 的差别：那条是"用户明确选保留本地"，
    //     需要连 base 一起推进；这里只落缓存，base不动（远端还没收到），
    //     所以下次 push 仍会带上这一版，合并语义不受影响。
    //   🔴 写缓存仍包 try：localStorage 配额满/隐私模式抛异常时，
    //     不能因此把整次推送搞失败（离线能力是增强项，见 local-cache.ts 的注释）。
    try {
      writeCache(this.d.noteId, env);
    } catch {
      /* 存不下不抛：继续推云端，本机这份丢了是降级不是失败 */
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
    // 🔴 缓存已在本函数**发请求之前**写过（见上面那段注释：本地是权威、云端是备份）。
    //   此前这里在 push 成功后才 writeCache，等于把"本机能不能读回自己的内容"
    //   挂在"云端写成功没有"上 —— 探针 probe-cache-vs-cloud 实测：
    //   编辑完成到 push 返回之间，缓存键**根本不存在**，数据只在内存里。
    //   那个窗口里刷新页面，最后一批编辑全丢（probe-ep01-flow 实锤 reload 后 {"v":1}）。
    //   同理清掉 pendingEnv：这一版已经上云，页面若此刻卸载不必再落一遍本地。
    this.pendingEnv = undefined;
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
      // 🔴🔴 conflict 态**同样不自动重拉** —— 与老项目 index.html:9947 同款：
      //   `if (pendingRemoteNote) { pendingRemoteNote = note; return; }`
      //   （:9955、:9966 三处同款守卫，注释写"挂起期不消费版本、不应用"）
      //   语义是"存起来等用户拍板"，**不是**趁用户还没裁决就再合并一次。
      //   探针实测 E3'：不挡的话，一次推送会在 conflict 态连抛两条异常
      //   （conflict --remote-arrived-->，以及随后的 conflict --merge-conflict-->），
      //   而第二条意味着用户没拍板文档就被改了 —— 比报错更糟。
      //   注意 fsm.ts 里 conflict 态**故意没有** remote-arrived 边，两处是配套的。
      if (this.state === 'conflict') return;
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

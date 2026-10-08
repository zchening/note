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
import { getWriteKey } from './write-key.ts';
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
  /**
   * 🔴🔴🔴 **解锁时那一刻的真源**，用来给三方合并的 base 播种（用户报障第 1 条）。
   *
   * 🔴 病态：`base` 的初值曾是 `emptyDoc()` 且**从未**被初始化过。
   *   于是每次刚打开一篇笔记，本机是"有内容"、base 是"空"、远端也是"有内容"
   *   ⇒ 第一个分支（远端 == base）不成立、第二个分支（本机 == base）不成立
   *   ⇒ 直接掉进三方合并 ⇒ 判出一堆冲突。
   *   **用户看到的就是"每次开篇都弹同步冲突"**，而两台设备其实一致。
   *
   * 🔴 老项目依据：`index.html:3450` 在解锁时就把 `lastHtml` 设成服务端内容 ——
   *   base 一开始就是"上次同步成功的那一版"，而不是"空文档"。
   *
   * 🔴 不传 ⇒ 退回 `emptyDoc()`（旧行为）。判据 SYNC-BASE-02 钉这条。
   */
  initialDoc?: Doc;
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
/**
 * 🔴 轮询基线间隔（老项目 `POLL_INTERVAL = 2000`）。
 * 2 秒是老项目在 v10 之后定稿的值，本项目照抄**不做"优化"**——
 * 调小只会增加服务端压力与移动端耗电，而 SSE 已经承担了"有变化立刻到"的职责。
 *
 * 🔴 导出是为了让判据**按真实周期等**而不是在测试里另写一个 2000 ——
 *   "测试里那个数字"与"实现里那个数字"一旦不一致，判据就在测另一个东西，
 *   而且会以"测试全绿"的形式骗过去（本项目栽过：判据写死 600 字符采样窗口，
 *   而实现注释一变长就恒红）。
 */
export const POLL_INTERVAL_MS = 2_000;
/** SSE 重连退避上限 */
const SSE_BACKOFF_MAX_MS = 30_000;

function isDocEmpty(d: Doc): boolean {
  return (d.blocks === undefined || d.blocks.length === 0) &&
         (d.reminders === undefined || d.reminders.length === 0);
}

/**
 * 🔴 判两份文档"实质相同"（用户报障第 1 条，B-④ 装饰等价豁免）。
 *
 * 两层：
 *   ① `canonicalize(normalize(x))` —— 压掉"同一内容多种表示"：
 *      相邻同格式 span 合并、相邻同类型列表合并、空段落剔除（见 canonical.ts:179-196）。
 *      **裸 canonicalize 做不到这些**，而客户端导出的一定是合并后的形态。
 *   ② 剥离提醒下划线/删除线标记（`span.rem`）——
 *      标记是**渲染层**的产物，由 `reconcileReminders` 本地算出，
 *      两台设备算出不同的标记是**正常的**（用户可能只在一台上加了提醒）。
 *      把它们算进等价性，等于"提醒标记差异 = 冲突"，而正文一个字没动。
 *
 * 🔴🔴 为什么 ② 不能省（老项目没有这一层，但老项目也没有提醒标记）：
 *   提醒标记不进加密正文的语义、却进 blockSig 的计算 ⇒ 不剥离的话，
 *   「他端新增一条提醒」会被判成"两台设备同时改了同一处"。
 */
function eq(a: Doc, b: Doc): boolean {
  return canonicalize(stripRemMarks(normalize(a))) === canonicalize(stripRemMarks(normalize(b)));
}

/** 深拷贝并剥掉所有 span 上的 `rem` 标记。不可变输入，不改调用方的东西。 */
function stripRemMarks(d: Doc): Doc {
  const clone = JSON.parse(JSON.stringify(d)) as Doc;
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const it of x) walk(it);
      return;
    }
    if (typeof x !== 'object' || x === null) return;
    const o = x as Record<string, unknown>;
    //🔴 只删 span 上的 rem：字段名恰好也是 'rem' 的其它结构（本版没有）不受影响，
    //   而放宽成"删所有叫 rem 的键"会在将来引入 reminders 时误伤真源字段。
    if (typeof o.t === 'string' && 'rem' in o) delete o.rem;
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(clone.blocks);
  return clone;
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
  /** 🔴 轮询定时器。必须在 stop() 里 clearInterval（见 stop 的注释）。 */
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** 🔴🔴 重入锁：上一次 pull 还没 await 完时为 true（见 pull() 的守卫注释）。 */
  private pulling = false;
  /**
   * 上次同步成功时的文档 = 三方合并的 **base**。
   * 🔴 没有它就无法区分"对方新增"与"我删除"，合并会把用户的删除还原回去。
   */
  private base: Doc;
  private stopped = false;
  /** 冲突详情，供UI 展示 */
  private conflicts: MergeResultLike['conflicts'] = [];

  constructor(deps: SyncDeps) {
    this.d = deps;
    // 🔴 base 播种（B-①，见 SyncDeps.initialDoc 的注释）。
    //   放在构造器而不是 start()：start() 之前 getDoc() 可能还没绑上编辑器
    //   （main.ts 的 startSyncFor 在 mountEditor 之后调，但换笔记的时序不保证），
    //   而 initialDoc 是调用方**显式**传进来的，不依赖任何时序。
    this.base = deps.initialDoc ?? emptyDoc();
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

  /**
   * 诊断只读读数（老项目 `index.html:1970` 的 `sse=open|closed` 同款）。
   *
   * 🔴 为什么需要这个口：SSE 的 `es` 是private 的，而"事件流到底开没开"
   *   是「对方改了但我收不到」这类问题**唯一**能一眼定生死的信息。
   *   老项目把它挂在 `window.sseSource` 上（`collectDiagLines` 直读），
   *   bj 不做全局挂载，所以给类加一个只读出口。
   *
   * 🔴 `lastSyncAt` / `skip` **故意返回 null**（不编读数）：
   *   老项目的 `lastSyncAt` 挂在每次 poll 成功处、`__pollSkipCount` 数的是
   *   「轮询被连续打字推迟」的次数。bj 的同步是 SSE 推送 + 显式 pull，
   *   **没有轮询、也就没有"推迟"这个概念** —— 编一个假计数器上去，
   *   诊断面板就成了"看着有读数其实没这回事"的骗人东西。
   */
  diagState(): { sse: 'open' | 'closed'; state: SyncState; lastSyncAt: number | null; skip: number | null } {
    return { sse: this.es ? 'open' : 'closed', state: this.state, lastSyncAt: null, skip: null };
  }

  /* ---------------- 生命周期 ---------------- */

  /** 解锁后调用：立刻拉一次并开 SSE。 */
  async start(): Promise<void> {
    this.send('unlock');
    // 🔴🔴 base 也要在这里同步一次（B-① 的补充）：
    //   initialDoc 是"解锁那一刻"的快照，而 start() 之前用户可能已经编辑过
    //   （例如扫码落地时 mountEditor 先跑、startSyncFor 后跑）。
    //   只在构造器播种一次的话，base 会比真源旧 ⇒ 第一个 pull 立刻判冲突。
    //   口径与老项目 index.html:3450 一致：base = 上次同步成功的那一版。
    if (this.d.initialDoc) this.base = this.d.initialDoc;
    await this.pull('syncing');
    // 首次解锁即向服务端登记本机凭据（老项目 claimNote，index.html:2250-2261）。
    // 纯登记不挡主链路：fire-and-forget，失败（网络/404 新笔记）不影响任何读写，
    // 下一次解锁/保存仍会再试；403 才当场说（多半口令在别处改过）。
    void this.claim();
    this.openStream();
    this.startPoll();
    // 🔴 浏览器从离线切回在线时立刻重拉。不监听的话"断网期间对方的改动"
    //   要等到下一次手动刷新才同步，用户会以为同步坏了。
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (this.state === 'offline') void this.retryPull();
      });
    }
  }

  /**
   * 🔴🔴 2 秒轮询基线（老项目 `POLL_INTERVAL = 2000`，index.html:10040/10045/10066）。
   *
   * 🔴🔴🔴 **SSE 只是加速器，轮询才是基线** —— 这是老项目与bj 的关键结构差异，
   *   也是用户报障第 1 条"不管怎么刷新都没法取到"的另一面：
   *   SSE 会因为代理断开、EventSource 在某些移动端浏览器上根本连不上等原因静默失效，
   *   而老项目**即便 SSE 全挂，2 秒轮询仍然保证最终一致**。bj 此前只有 SSE，
   *   ⇒ SSE 一挂就变成"永远不同步"，且界面毫无提示。
   *
   * 🔴 轮询回调**先发 `remote-arrived` 再 pull**，理由见方法体里的三条注释
   *   （`send('pulled')` 在 idle 态是非法转移 + `remote-arrived` 正是
   *   "有人告诉我该拉了"这个语义）。`pull()` 自己会在 decryptAndMerge 里
   *   按需 send('pulled') / send('merge-clean')。
   */
  private startPoll(): void {
    if (this.stopped) return;
    if (this.pollTimer !== undefined) return;
    this.pollTimer = setInterval(() => {
      // 🔴🔴🔴 必须先发`remote-arrived`，不能直接 pull()。
      //
      //   病态（探针probe4 实锤）：直接 pull() 时decryptAndMerge 结尾会
      //   `send('pulled')`，而此刻状态是 **idle** —— fsm 里 idle 只接受
      //   remote-arrived / refresh / edit / lock（见 fsm.ts:232-235）
      //   ⇒ 每 2 秒抛一条 IllegalTransitionError。
      //   症状：**每 2 秒一条 console.warn**，日志被刷满、CPU 空转，
      //   而同步**其实不工作**（因为抛异常那条路的用户可见分支不执行合并）。
      //
      //   🔴 而且 `send('remote-arrived')` 正是"有人告诉我该拉了"这个语义：
      //   fsm 有一条 `idle --remote-arrived--> syncing`（fsm.ts:233），
      //   于是 pull 拿到的是 syncing 态，守卫也认得（用 fromStateEntry 放行）。
      //
      //   老项目同款：index.html:10047 的 `sseSource.onmessage = () => { poll(); }`
      //   走的是同一条路（先更新 lastRemoteNote 再进poll）。
      if (this.state === 'conflict' || this.state === 'pushing' || this.state === 'syncing') return;
      this.send('remote-arrived');
      this.pullFromTimer('syncing');
    }, POLL_INTERVAL_MS);
    // 🔴 Node/单测环境下 setInterval 会吊住进程；真浏览器不需要 unref，
    //   但加上它在任何环境都无害（浏览器忽略这个方法）。
    (this.pollTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * 🔴🔴🔴 定时器/SSE 回调里发起的拉，**必须自带错误边界**。
   *
   * 老项目依据：`poll()` 整个函数体包在 try 里（index.html:9933），
   *   catch 分三类报状态（:10026-10030）—— locked / 离线 / 其余"同步中断"。
   *   也就是说老项目明确规定：**轮询里出的任何问题都只降级成状态文案，绝不许逃出去**。
   *
   * 不加会怎样（探针 probe8 实锤）：
   *   `setInterval` 回调里的 rejected promise 是**未捕获异常**，
   *   在浏览器里变成 `unhandledrejection`，在 Node/单测里直接终止进程。
   *   症状是"同步毫无征兆地死了"——不弹任何提示、不进底栏状态、
   *   而且**每 2 秒复发一次**（拉一次炸一次）。
   *
   * 🔴 为什么走 onInternalError 而不是 onError：
   *   底栏文案是老项目 30 句白名单里的东西（见 FSM-xxxx 判据文件头），
   *   "同步中断"那类降级由 `pullInner` 内部的 network-fail 分支自己报，
   *   轮询的兜底 catch 只该留给**没被任何分支接住的意外**——
   *   那属于内部/编程错误，走内部通道可观测、不入 UI（FSM-13 钉的就是这条纪律）。
   */
  private pullFromTimer(fromStateEntry: SyncState): void {
    void this.pull(fromStateEntry).catch((e: unknown) => {
      // 🔴 v1.13.0 修正：reportInternal 的签名是 (msg: string, err: unknown)，
      //   此前这里只传了一个 Error —— TS 报 TS2554，且真正想报的"这条轮询拉失败了"
      //   这句话整个丢掉了（只留了一个异常对象，控制台看不出是哪条路径炸的）。
      this.reportInternal('轮询拉取失败（已被降级，不影响其他功能）', e);
    });
  }

  /**
   * 推的fire-and-forget 收口。与 `pullFromTimer` 同款理由：
   * `void this.push()` 的 rejected promise 是**未捕获异常**（浏览器 `unhandledrejection`、
   * Node 直接终止进程），而 `push()` 里有两处会在 try 之外抛：
   * `normalize(this.d.getDoc())`（用户文档读不出来时）与 `send()` 的IllegalTransitionError。
   *
   * 🔴 为什么必须现在就收口，而不是"等 push 自己补catch"：
   *   独立复核实测（把 `deps.getDoc` 换成抛异常的桩）：
   *   `void this.push()` 一次改动就产出 2 条 `unhandledRejection`
   *   （一次走 `noteEdit` 的去抖窗口、一次走 `flushPending`），
   *   而 `onError` / `onInternalError` **都是空的** ——
   *   也就是说 `pullFromTimer` 修掉的"每 2 秒复发一次的未捕获异常"，
   *   在推这条路上**原样存在**。收口不彻底等于没修。
   *
   * 🔴 与 pullFromTimer 同款：走 `reportInternal`（可观测、不入 UI 底栏）。
   *   推失败的用户可见口径由 `pushInner` 自己的分支报（network-fail 等），
   *   这里只是兜底那些没被任何分支接住的意外。
   */
  private pushFromTimer(): void {
    void this.push().catch((e: unknown) => {
      this.reportInternal('推送调度失败（已被降级，不影响其他功能）', e);
    });
  }

  /**
   * 信封构造的 fire-and-forget 收口。
   *
   * 🔴 `stageEnv` 的 `try` **只包住 `encryptString`**，`normalize(this.d.getDoc())`
   *   在它之前（`stageEnv` 开头）⇒ `getDoc` 抛异常时整个 promise 直接 reject。
   *   它由 `noteEdit` 用 `void`发起，且**每次编辑都发一次** ——
   *   也就是"用户每敲一个字就有一次未捕获异常"的可能。
   *
   * 🔴 与 pushFromTimer 的区别：**它失败是静默的、且是设计内的**。
   *   `stageEnv` 的 catch 分支已经明确"不写 pendingEnv，让下次 push 重走一遍"；
   *   所以这里同样只走内部通道记一笔，不改状态、不报 UI。
   */
  private stageEnvFromTimer(): void {
    void this.stageEnv().catch((e: unknown) => {
      this.reportInternal('信封构造失败（下次编辑会重试，不影响其他功能）', e);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    // 🔴🔴 必须清轮询。不清的话换笔记后**旧实例仍在每 2 秒拉一次**，
    //   症状是"明明只有一篇笔记在编辑，底栏的同步时间却一直在跳"，
    //   而且流量翻倍。这条由 SYNC-POLL-01 的 clearInterval 断言钉住。
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.es?.close();
    this.es = undefined;
  }

  private online(): boolean {
    return this.d.isOnline ? this.d.isOnline() : (typeof navigator === 'undefined' ? true : navigator.onLine);
  }

  private async retryPull(): Promise<void> {
    this.send('online');
    await this.pull(this.state);
  }

  /* ---------------- 编辑器侧调用 ---------------- */

  /** 本地有改动。去抖后推送。 */
  noteEdit(): void {
    // 🔴🔴🔴 conflict 态下的编辑**必须显式处理**（用户报障第 1 条的病灶 B）。
    //
    //   病态：`this.send('edit')` 在 conflict 态会抛 IllegalTransitionError
    //   （fsm 故意不给这条边，因为"用户没拍板就改文档"是危险的），
    //   而 `send` 的 catch 把它降级成 `reportInternal` ⇒ **只 console.warn，
    //   用户零感知**。紧接着 `setTimeout` 里 `if (this.state === 'dirty')`
    //   恒不成立（状态还是 conflict）⇒ **push 永不执行**。
    //   净效果：用户在冲突挂起期间打的字，一个字都推不出去，且没有任何提示。
    //
    //   🔴 用户拍板：**只修「推不上去」，不改可编辑性**。
    //   ⇒ 不放开 fsm 的 conflict→edit 边（那是"要不要在挂起期允许编辑"的产品决定，
    //     放开它会让未拍板的文档被改，比推不上去更糟）。
    //   ⇒ 只做一件事：让这次编辑**有出路** —— 走 `resolve-local`
    //     （"以本机为准重新推"），语义与用户点「保留本机」完全一致，
    //     但不需要用户先意识到"我卡住了"再点一次。
    if (this.state === 'conflict') {
      this.pendingEnv = undefined;
      if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
      // send('resolve-local') 是 conflict 态**有**的边（见 fsm.ts），
      // 它会把状态带回 dirty，于是下面这条去抖就能真的推。
      this.send('resolve-local');
      // 🔴 TS 收窄修正：上面 `if (this.state === 'conflict')` 已把 this.state 收窄成
      //   字面量 'conflict'，而 TS 不知道 send() 会改状态 ⇒ 直接比 'dirty' 报 TS2367。
      //   运行时语义与原意完全一致（只是"防御性不可达检查"），故用局部变量重读，
      //   不加 any、不改判据。
      const afterResolve = this.state as SyncState;
      if (afterResolve !== 'dirty') {
        // 理论上不可达（fsm 有这条边）。真不可达时必须让用户看见，
        // 而不是继续静默 —— 判据 SYNC-PUSH-02 钉的就是"不许只上报不处理"。
        this.d.onError('本地改动推不上去，请先处理同步冲突');
        return;
      }
    } else {
      this.send('edit');
    }
    // 🔴🔴 同时**立刻**启动一次信封构造挂到 pendingEnv —— 不等去抖窗口。
    //   理由见 flushPending() 的注释：700ms 窗口内卸载时，数据必须已经能落到本地。
    //   加密是异步且很贵的（PBKDF2 600,000 次），所以这里是"发起"而不是"等结果"；
    //   pendingEnv 会被**后一次**编辑的结果覆盖（后写的版本才是要存的那一版）。
    this.stageEnvFromTimer();
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      if (this.state === 'dirty') this.pushFromTimer();
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
    // 🔴 同 resolveKeepRemote：refresh 的目标态通常也是 syncing，
    //   不传就会被守卫挡掉 ⇒ 用户点"手动刷新"完全没反应（而按钮点是有效动画）。
    await this.pull(this.state);
  }

  /** 冲突裁决：保留本地。 */
  resolveKeepLocal(): void {
    this.send('resolve-local');
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
    this.pushFromTimer();
  }

  /** 冲突裁决：保留远端。 */
  resolveKeepRemote(): void {
    this.send('resolve-remote');
    this.d.setDoc(this.base);
    // 🔴 必须传 fromStateEntry：fsm 里 resolve-remote 的目标态是 syncing，
    //   不传的话这次拉会被 syncing 守卫挡掉 ⇒ "保留远端"点了没反应。
    //   走 pullFromTimer 是因为这里同样是 `void`（fire-and-forget）⇒ 同样必须有边界。
    this.pullFromTimer('syncing');
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
    this.pushFromTimer();
  }

  /* ---------------- 拉 ---------------- */

  private async pull(fromStateEntry?: SyncState): Promise<void> {
    // 🔴🔴🔴 三道守卫，**每一条都是轮询上线的前提**（缺任一条，2 秒轮询就是故障放大器）：
    //
    //   ① conflict —— `pull()` 里原本**没有**这层守卫（只有 SSE 回调里有，
    //      见 openStream）。轮询是主动调用，不经过 SSE 那条路 ⇒
    //      冲突挂起期间每 2 秒进一次 decryptAndMerge ⇒ 撞上 `send('merge-conflict')`
    //      ⇒ 每 2 秒抛一条 IllegalTransitionError（被 reportInternal 吞成 console.warn）。
    //      语义上是"挂起期不消费版本、不应用"（与老项目 index.html:9947 的
    //      pendingRemoteNote 守卫同款），SSE 那条守卫的注释已经写明理由。
    //
    //   ②/③ pushing / syncing —— 老项目有等价物 `inflightWrites`，
    //      bj 此前只在 SSE 回调里有（client.ts 的 `state === 'pushing' || 'syncing'`）。
    //      轮询撞进去的震荡形态：推 → 拉到自己的回声 → 合并 → 又触发推 …
    //      SSE 那条注释实测过"能把服务端打满"，轮询的触发频率更高。
    //
    // 🔴🔴🔴 **`fromStateEntry` 这条参数是必需的，不是可选的洁癖** ——
    //   fsm 里 `unlock` 的**唯一合法结果就是 `syncing`**（fsm.ts:230），
    //   而 `start()` 是 `send('unlock')` 之后紧接着 `await this.pull()`。
    //   ⇒ 守卫若只看"当前是不是 syncing"，**start() 自己的第一次拉会被自己挡死**，
    //     状态永远停在 syncing，整条同步链路一次都不跑。
    //   症状极隐蔽：**没有报错、没有异常**，只是底栏时间永远不更新，
    //   而所有"同步内容"的判据都还能过（它们测的是 pull 拉到了什么，不是 pull 有没有被调）。
    //   这个 bug 是探针（probe1）先抓到的、判据当时尚未覆盖 ——
    //   教训：**守卫必须区分「这次拉是我自己发起的」与「那次拉是别人发起的」**，
    //   不能笼统地按状态挡。
    //
    // 🔴 语义：`fromStateEntry` 是"调用方刚刚 send 出来的目标状态"。
    //   它等于当前状态 ⇒ 说明这次拉就是那次状态转移的一部分，放行。
    const mine = fromStateEntry !== undefined && fromStateEntry === this.state;
    if (!mine) {
      if (this.state === 'conflict' || this.state === 'pushing' || this.state === 'syncing') return;
    }
    // 🔴 `pulling` 自守卫防的是**重入**（上一次还没 await 完，轮询又敲进来）。
    if (this.pulling) return;
    this.pulling = true;
    try {
      await this.pullInner();
    } finally {
      this.pulling = false;
    }
  }

  private async pullInner(): Promise<void> {
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

    // 🔴🔴🔴 三个比较**全部**改用 `eq`（= canonicalize(normalize(·))）——
    //   病态是它们原本用裸 `canonicalize`，而 canonicalize **不做**"相邻同格式
    //   span 合并"与"相邻同类型列表合并"（那是 normalize 的活，见 canonical.ts:179-196）。
    //   后果：客户端导出的 doc 一定是被 Lexical 合并过的形态，
    //   而 base 里存的是上一轮远端原样 —— 两端字节不同但**内容完全一样**，
    //   于是每次 pull 都判"本地和 base 不同、远端和 base 不同" ⇒ 掉进三方合并。
    //   这是用户报障第 1 条"老版本不会这么频繁提醒冲突"的主因之一。
    //
    //   老项目有五处比 bj 少冲突，第一处就是这个（index.html:9616-9619 的
    //   isDecorativelyEqual / :9704-9706 的 backfillLastHtmlIfDecorativelyEqual）。
    if (eq(remoteDoc, base)) {
      this.conflicts = [];
      // 🔴🔴🔴 `merge-clean` 之后**必须真的推一次**，不能 send 完就 return。
      //
      //   病态（e2e E2E-S2/E2E-S3 实锤，诊断脚本采样 26 秒）：
      //     `merge-clean` 的语义是"合并干净、**本地确有改动要推上去**"，
      //     它把状态从 syncing/dirty 推进 **pushing** —— 于是必须由谁来发那次 POST。
      //     而 `noteEdit()` 的 700ms 去抖定时器只认 `state === 'dirty'` 才推，
      //     此刻状态已经是 pushing ⇒ **定时器永不触发** ⇒ 状态永久停在 pushing。
      //     实测：服务端其实收到了密文（`serverHas=true`、密文里没有明文），
      //     但底栏永远停在"推送中…"，换设备也取不回（E2E-S3 那条直接红）。
      //     —— 典型"不报错但结果是错的"：用户以为同步坏了，且没有任何提示。
      //
      //   🔴 为什么 v1.13.0 之前不发作：这三处比较原本用裸 `canonicalize`，
      //     本地（Lexical 合并过）与 base（远端原样）字节常不相等 ⇒
      //     掉进函数末尾三方合并那条分支，而那条分支**有** `await this.push()`。
      //     改成 `eq`（normalize 后比较）之后本分支命中率大增 ⇒ 打字后必然卡住。
      //   ⇒ 凡新增 `send('merge-clean')` 的调用点，必须逐个确认后面真有一次 push。
      if (!eq(local, base)) {
        this.send('merge-clean');
        await this.push();
      } else {
        this.send('pulled');
      }
      return;
    }

    // 本地 == base：只有远端变了，直接采纳
    if (eq(local, base)) {
      this.d.setDoc(remoteDoc);
      this.base = remoteDoc;
      this.conflicts = [];
      // 🔴🔴 采纳远端必须同步刷新本机离线缓存（2026-10-08 对抗审计 S4）：
      //   不刷的话缓存里还是旧信封，而 unlock 的缓存命中分支**不查服务器** ——
      //   下次离线（或弱网）重开这篇，用户看到的是被静默回滚的旧版。
      //   与 push 成功路径（~:828）和 unlock.ts:195 的写缓存同一条通路同一条契约；
      //   写进去的就是刚从服务器拉到的信封本体，与真源同源，换口令场景无分叉。
      //   🔴 三方合并分支不走这里：合并结果以本地新内容为准、随后的 push 会写缓存。
      try {
        writeCache(this.d.noteId, env);
      } catch {
        // 不能因此把整次采纳搞失败（离线缓存是增强项，见 local-cache.ts 文件头）
      }
      this.send('pulled');
      return;
    }

    // 本地 == 远端：已经一致
    if (eq(local, remoteDoc)) {
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

  /**
   * 认领：首次解锁即向服务端登记本机凭据（writeKey）。
   *
   * 移植老项目 claimNote（index.html:2250-2261）逐条语义：
   *  - 纯登记：不改正文、不动版本，失败不影响任何读写（网络类失败静默，
   *    下一次解锁/保存仍会再试，绝不因此打断打开笔记这条路）；
   *  - 404（服务端还没有这篇）= 新笔记，建档交给首推那一枪，同样静默；
   *  - 403 必须当场说，不能等用户保存到被拒才发现——此刻本机密钥已作废
   *    （多半是口令在别处改过）。文案与老项目逐字一致。
   */
  private async claim(): Promise<void> {
    const wk = await getWriteKey(this.d.noteId, this.d.key, this.d.dk);
    if (!wk) return; // 没口令=没有凭据，不认领（也绝不能用别的凭据去认领）
    try {
      const r = await fetch(`/api/note/${encodeURIComponent(this.d.noteId)}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-note-key': wk },
        body: '{}',
      });
      if (r.status === 403) {
        this.d.onError('本机保存的密钥已失效（口令可能在其他设备改过）。请退出锁定、重新输入口令解锁本篇，否则无法保存。');
      }
    } catch {
      /* 网络类失败静默：下一次解锁/保存仍会再试 */
    }
  }

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
      // 写入凭据（老项目 x-note-key 同款）：有就带上，没有就不带——
      // off/new-only 档照写成功，full 档由服务端拒（下面 403 分支给出可见错误）。
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const wk = await getWriteKey(this.d.noteId, this.d.key, this.d.dk);
      if (wk) headers['x-note-key'] = wk;
      res = await fetch(`/api/note/${encodeURIComponent(this.d.noteId)}`, {
        method: 'POST',
        headers,
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
    if (res.status === 403) {
      // 凭据被服务端拒（老项目凭据闸 full 档）：多半是口令在别处改过、本机密钥已作废。
      // 🔴 必须可见——静默失败 = 用户以为存上了，实际没有。文案与 claim 同款（老项目逐字）。
      this.d.onError('本机保存的密钥已失效（口令可能在其他设备改过）。请退出锁定、重新输入口令解锁本篇，否则无法保存。');
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
      // 🔴🔴🔴 必须传 'syncing'，与 startPoll 回调同款 —— 这是探针 probe7 实锤的
      //   一个真 bug：`send('remote-arrived')` 刚把状态推进 `syncing`，
      //   而 `pull()` 的守卫写着「syncing 不许拉」⇒ **SSE 自己发起的拉被自己挡死**。
      //   症状：收得到推送、状态显示 syncing、但一个 GET 都不发（探针里
      //   `FETCH GET` 只出现一次，deliverSse 之后再无网络请求，1200ms 后卡在 syncing）。
      //   也就是说：SSE 这条路在改动前能拉，改动后彻底哑火 —— 而用户看到的是
      //   "同步偶尔不更新"，没有任何报错。
      //   与 probe1 同一个根因（守卫必须区分「这次拉是我发起的」与「那次拉是别人发起的」），
      //   上一轮只改了 startPoll 那一处，漏了这里。**凡新增 pull() 调用点，
      //   必须逐个核对自己是不是刚刚 send 过状态机事件。**
      this.pullFromTimer('syncing');
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

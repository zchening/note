/**
 * 飞行记录器（v3.0.9 诊断版）—— 先取证，再修复。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 为什么必须有它（豆包「智能整理」丢字四轮未中）：
 *   v3.0.5 门控时机 / v3.0.6 树手术纳管 / v3.0.7 合并回灌两闸 / v3.0.8 整段
 *   改写会话窗口 —— 四层修复全部基于「程序化动树 ⇒ InputConnection 错位」
 *   这一条**推论**，而用户实测仍丢。Android 的 InputConnection 桌面无法复现，
 *   继续盲改是自欺。唯一出路：把真机上「丢字那一刻前后」的事件流原样带回来。
 *
 * ── 它回答哪一个二分问题 ─────────────────────────────────────────────────
 *   看 `upd`（update 监听器导出的正文本长度）的时间线：
 *     · 长度在**单个** `in:bi`/`in:i` 事件内从 4 段掉到 1 段
 *       ⇒ 丢失发生在 Lexical 自己处理 IME 事件的内部（beforeinput 拦截链），
 *         与我们的同步/回灌完全无关 ⇒ 修 Lexical 交互层；
 *     · 长度先完整、后被某个 `tree:*`（setDoc / rebuild / refreshDone）砸回去
 *       ⇒ 仍有未纳管的程序化动树路径 ⇒ 继续收口门控；
 *     · 长度在 `vis`/`err` 附近归零 ⇒ 页面重载/崩溃，走第三条路。
 *
 * ── 红线 ─────────────────────────────────────────────────────────────────
 *   🔴🔴 **绝不记录正文内容**：本项目笔记是端到端加密，日志会被用户粘贴到
 *     聊天里发出来。每条事件只带：事件名 + 长度 + 短哈希（djb2 前 8 位）+
 *     计数。哈希只用于"两次内容是否相同"的比对，不可逆推内容。
 *   🔴 观察者纪律：所有监听一律**只读**，不 preventDefault、不 stopPropagation、
 *     不改任何时序（capture 阶段被动监听）。记录器本身绝不允许成为新的
 *     "程序化动树"——它不碰编辑器，只写 localStorage。
 *   🔴 开销纪律：ring buffer 上限 400 条（约 60KB 封顶）；localStorage 落盘
 *     按 500ms 节流，但 pagehide/visibilitychange/error 三条**同步落盘**
 *     （丢字现场常伴随页面被杀，延迟落盘会丢最后几条——恰恰是最重要的几条）。
 */

export interface FlightEvent {
  /** 相对记录器启动的毫秒数（可读，不用换算时区）。 */
  t: number;
  /** 事件类型（见文件头分类）。 */
  type: string;
  /** 短详情：长度/哈希/计数，绝不含内容。 */
  d: string;
}

/** ring 上限：400 条 × ~150B ≈ 60KB，localStorage 单键放得下。 */
const CAP = 400;
/** 落盘节流：打字期每 500ms 最多写一次。 */
const SAVE_EVERY_MS = 500;
/** localStorage 键：bj 前缀（与 favs/diag 同款纪律）。 */
const LS_KEY = 'notesync_bj_flight';

let buf: FlightEvent[] = [];
let startedAt = 0;
let startWall = '';
let loaded = false;
let lastSaveAt = 0;

/** 存储句柄注入点（判据里换内存实现；生产默认 localStorage）。 */
export interface FlightStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}
let store: FlightStore | undefined;
function st(): FlightStore | undefined {
  if (store) return store;
  if (typeof localStorage !== 'undefined') return localStorage;
  return undefined;
}
/** 判据专用：换存储 + 清空内存态（生产不调用）。 */
export function _flightTestReset(s?: FlightStore): void {
  buf = [];
  startedAt = 0;
  startWall = '';
  loaded = false;
  lastSaveAt = 0;
  store = s;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = st()?.getItem(LS_KEY);
    if (raw) {
      const j = JSON.parse(raw) as { startWall?: string; buf?: FlightEvent[] };
      if (Array.isArray(j.buf)) buf = j.buf.slice(-CAP);
      if (typeof j.startWall === 'string') startWall = j.startWall;
    }
  } catch {
    /* 损坏的存档：当没有，不阻塞记录 */
  }
}

function persist(): void {
  try {
    st()?.setItem(LS_KEY, JSON.stringify({ startWall, buf }));
  } catch {
    /* 隐私模式/满：丢日志不丢功能 */
  }
}

/** djb2 短哈希（比对用，不可逆推内容）。 */
export function flightHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 记一条事件。
 *
 * @param type 事件分类：`in:bi`/`in:i`/`in:cs`/`in:ce`（输入法事件）、
 *   `upd`（update 导出长度）、`bulk`（整段删除触发）、`push>`/`push<`、
 *   `pull:*`（合并分支）、`tree:*`（程序化动树）、`gate:*`（门控拦下）、
 *   `state`（同步状态机）、`vis`、`err`。
 * @param d 短详情（长度/哈希/计数），会被截到 140 字符。
 * @param flush 为 true 时立即同步落盘（pagehide / error 用），默认走节流。
 */
export function recordFlight(type: string, d: string, flush = false): void {
  ensureLoaded();
  const now = Date.now();
  if (!startedAt) {
    startedAt = now;
    if (!startWall) startWall = new Date(now).toISOString();
  }
  buf.push({ t: now - startedAt, type, d: d.slice(0, 140) });
  if (buf.length > CAP) buf.splice(0, buf.length - CAP);
  if (flush) {
    lastSaveAt = now;
    persist();
    return;
  }
  if (now - lastSaveAt >= SAVE_EVERY_MS) {
    lastSaveAt = now;
    persist();
  }
}

/** 诊断面板用：格式化全部事件（含表头：墙钟起点 + 条数）。 */
export function flightLines(): string[] {
  ensureLoaded();
  const head = `flight ${buf.length} 条（起点 ${startWall || 'n/a'}，t=相对毫秒）`;
  return [head, ...buf.map((e) => `${String(e.t).padStart(8, ' ')} ${e.type} ${e.d}`)];
}

/** 清空（诊断面板"清空日志"按钮 / 判据用）。 */
export function clearFlight(): void {
  buf = [];
  startedAt = 0;
  startWall = '';
  try {
    st()?.removeItem(LS_KEY);
  } catch {
    /* 同上 */
  }
}

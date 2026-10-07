/**
 * 光标诊断面板（老项目 `index.html:1926-2082` 的 `collectDiagLines`）
 *
 * 🔴🔴 本文件存在的理由（老项目 :1927 原文）：
 *   「用于在真实浏览器里定位 caret 类问题—— headless 不做真实合成，
 *     『能打字但看不见光标』这类现象**只能靠真机读数确认**。」
 *   ⇒ 所以它必须是**纯只读**的：不改 DOM、不抢焦点（浮层 `pointer-events:none`），
 *     不开启时零开销。任何一行写操作都会让"取证"这件事本身失真。
 *
 * ── 分层（与 egg/word-trigger.ts 同款：纯逻辑 + DOM 桥）────────────────────
 *   · `renderDiagLines(readings)` —— **纯函数**，把一次快照排成 10 组文本。
 *     node 单测直接喂假读数，不需要 DOM。
 *   · `collectDiagReadings(deps)` —— DOM 侧采集，全部读数经 `deps` 注入。
 *   · `buildDiagModal` / `mountDiagOverlay` —— 两个入口的 DOM。
 *
 * ── 🔴🔴 「不编读数」纪律（本文件最承重的一条）──────────────────────────
 *   bj 没有的探针一律写 `n/a`，**并在 {@link NA_REASONS} 里记明为什么**。
 *   编一个假的 0 上去比不写更坏：诊断面板的全部价值就是"这行数字是真的"，
 *   一旦某行是编的，用户会拿它当证据去判断"到底有没有问题"，
 *   而错误的证据比没有证据危险得多（会指向根本不存在的病因）。
 *
 * ── 为什么每组压成一行（老项目是散的多行）────────────────────────────────
 *   老项目第 3 组会连着push 5 行（ranges / node / connected / rects / block）。
 *   bj 压成一行、用两个空格分隔，理由是**可数**：诊断面板的回归判据要能
 *   断言"恰好 10 组、第 7 组是 caret:……"，散行时"删掉某组"与
 *   "把某组拆成两行"分不清。信息量一字不减（老项目的行尾换行没有语义）。
 */

import { COPY } from '../ui/copy.ts';
import type { ScanDiag } from '../scan/engine.ts';

/** 不可得的读数统一写这个（老项目写 `'?'`，bj 写 `n/a` —— 更明确是"没有"而非"忘了"）。 */
export const NA = 'n/a';

/**
 * 10 组读数的组 id。**顺序即屏上顺序**，判据按它逐组钉。
 *
 * 🔴 老项目没有这张表（它是按 push 顺序隐式表达的），bj 显式化，
 *   理由与 registry.EGGS 同款：隐式顺序一改，判据就悄悄换了目标。
 */
export const DIAG_GROUPS = [
  'ver', //  1 版本 + 输入法组字态
  'focus', //  2 焦点落点 + 文档焦点 + 光标色
  'sel', //   3 选区/光标几何（老项目的 5 行压成 1 行）
  'editor', // 4 编辑器 innerHTML（截断）
  'native', // 5 原生桥 + 闹钟排上数 + 精确闹钟权限
  'sync', //   6 SSE + 上次同步 + 推迟计数
  'caret', //  7 光标挪移/打字推迟探针
  'rem', //    8 提醒数/未来数/上次原生同步/远端挂起/本地版本
  'conflict', // 9 冲突链路七个探针
  'strike', //  10 删除线完整性
] as const;

export type DiagGroup = (typeof DIAG_GROUPS)[number];

/**
 * 🔴 每个 `n/a` 的原因。**渲染不读它，是给人看的**——
 *   写在代码注释里的话，读数一旦被截图发出去，对方看到 `n/a` 只会猜，
 *   而猜错的成本是"去查一个 bj 根本不存在的问题"。
 */
export const NA_REASONS: Readonly<Record<string, string>> = {
  exact: 'bj 的 ensureExactAlarmPermission 只在**首次**调用（写 EXACT_ALARM_ASKED_KEY 后直接 return false），不留历史值 ⇒ 没有"当前权限"可读',
  lastSync: 'bj 是 SSE 推送 + 显式 pull，**没有轮询**；老项目的 lastSyncAt 挂在 poll 成功处，bj 无对应事件',
  skip: '同上：老项目 __pollSkipCount 数的是"轮询被连续打字推迟"，bj 没有轮询也就没有"推迟"这个概念',
  typeDefer: 'bj 用 Lexical，无 relocate/打字守卫这套自研探针（那是老项目手写 contentEditable 的产物）',
  relocated: '同 typeDefer',
  kept: '同 typeDefer',
  pendingRemote: 'bj 的远端冲突走"冲突条 + 用户显式选保留哪边"，没有"远端挂起等本地清空"这个中间态',
  localVer: 'bj 真源只有 schema 版本 Doc.v，**没有本地内容版本号**（三方合并靠 base 文档而非 localVer 自增）',
  a1: '老项目 v7.5.0 的壳中间态早退计数，bj 无此中间态',
  f1: '老项目的等价草稿自动清理，bj 无等价草稿机制',
  rcBar: 'bj 的提醒冲突走 getConflicts() 统一裁决，无独立的"提醒 409 挂条"计数',
  wconBar: 'bj 无"正文 409 挂条"这条独立链路（正文冲突合并在 mergeDocs 内）',
  wconAM: '同上，无自动合并成功计数',
  l2AM: 'bj 无 poll 二级合并（无 poll）',
  rbd: 'bj 无"打字中延条"机制（远端到达即时进裁决，不延后）',
};

/** 一次采样的原始读数。**每个字段 nullable = 取不到 ⇒ 渲染成 `n/a`。**
 *
 *  🔴 用 `null` 而不用 0/'' 当"没有"：0 是一个**合法读数**
 *     （`strike.s=0` 表示真的一处删除线都没有），拿它冒充"没采到"就又骗人了。
 */
export interface DiagReadings {
  /* 1 */
  version: string;
  composing: boolean | null;
  /* 2 */
  activeEl: string | null;
  docFocus: boolean | null;
  caretColor: string | null;
  /* 3 */
  rangeCount: number | null;
  collapsed: boolean | null;
  /** 选区起点所在节点的可读描述（`TEXT"ab"` 或 `P`）。 */
  node: string | null;
  nodeOffset: number | null;
  connected: boolean | null;
  inEditor: boolean | null;
  rects: number | null;
  /** 选区包围盒 `x,y,w,h`（已取整）。 */
  bcr: string | null;
  block: string | null;
  /* 4 */
  editorHtml: string | null;
  /* 5 */
  native: 'APK' | 'web' | null;
  bridge: 'ok' | 'none' | null;
  /** 原生回报的排上条数。 */
  scheduled: number | null;
  /** 精确闹钟权限。bj 不可得 ⇒ null。 */
  exact: boolean | null;
  /* 6 */
  sse: 'open' | 'closed' | null;
  syncState: string | null;
  lastSyncAt: number | null;
  skip: number | null;
  /* 7 */
  relocated: number | null;
  kept: number | null;
  typeDefer: number | null;
  /* 8 */
  remTotal: number | null;
  remFuture: number | null;
  lastNativeSync: string | null;
  pendingRemote: boolean | null;
  localVer: number | null;
  /* 9 —— 键名与老项目探针同名，便于并排比对两份输出 */
  a1: number | null;
  f1: number | null;
  rcBar: number | null;
  wconBar: number | null;
  wconAM: number | null;
  l2AM: number | null;
  rbd: number | null;
  /* 10 */
  /** 手打删除线数（不含已推送 `rem-done`）。 */
  strikeS: number | null;
  /** 紧贴裸文本的删除线数（>0 即发生过格式弹出/取消拆分残留）。 */
  strikeSBare: number | null;
  /* 附：扫码自检（老项目 :2012，同为"屏幕上零信息"的一类问题） */
  scan: ScanDiag | null;
}

/** 空读数：所有字段都是 null。给判据与"什么都采不到"的真实场景共用。 */
export function naReadings(version: string): DiagReadings {
  return {
    version,
    composing: null,
    activeEl: null,
    docFocus: null,
    caretColor: null,
    rangeCount: null,
    collapsed: null,
    node: null,
    nodeOffset: null,
    connected: null,
    inEditor: null,
    rects: null,
    bcr: null,
    block: null,
    editorHtml: null,
    native: null,
    bridge: null,
    scheduled: null,
    exact: null,
    sse: null,
    syncState: null,
    lastSyncAt: null,
    skip: null,
    relocated: null,
    kept: null,
    typeDefer: null,
    remTotal: null,
    remFuture: null,
    lastNativeSync: null,
    pendingRemote: null,
    localVer: null,
    a1: null,
    f1: null,
    rcBar: null,
    wconBar: null,
    wconAM: null,
    l2AM: null,
    rbd: null,
    strikeS: null,
    strikeSBare: null,
    scan: null,
  };
}

/** 截断（老项目 :1936 `cut`）。`n` 是**保留长度**，超出加省略号。 */
export function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

const b = (v: boolean | null): string => (v === null ? NA : v ? 'yes' : 'no');
const n = (v: number | string | null): string => (v === null || v === '' ? NA : String(v));

/** 「几秒前」/「从未」。bj 的 `lastSyncAt` 为 null 时**必须**显示 `never` 而不是 `n/a`
 *  —— 它是"确定没有过"（还没同步过），与"采不到"不是一回事。 */
function ago(at: number | null, now: number): string {
  if (at === null) return 'never';
  return Math.round((now - at) / 1000) + 's前';
}

/**
 * 🔴 本文件的核心：**纯函数**，把一次读数快照排成 10 组文本。
 *
 * @param r 读数快照
 * @param now `Date.now()` 注入（便于判据钉住"几秒前"这类时间相关输出）
 */
export function renderDiagLines(r: DiagReadings, now: number): string[] {
  const L: string[] = [];

  // 1 版本 + 组字态（老项目 :1939）
  L.push(`ver ${r.version}  composing=${b(r.composing)}`);

  // 2 焦点 + 文档焦点 + 光标色（老项目 :1941-1942）
  L.push(
    `focus=${n(r.activeEl)}  docFocus=${b(r.docFocus)}  caretColor=${n(r.caretColor)}`,
  );

  // 3 选区几何（老项目 :1944-1958 的 5 行压成 1 行，见文件头说明）
  //   🔴 没有选区时后半段全是 n/a：老项目是整段不 push，
  //   而 bj 固定占一行 —— 否则「第 3 组在不在」这件事无法判定，
  //   而"光标类问题恰好就是没有选区的时候"（ranges=1/collapsed=true 是常态，
  //   真正异常是 ranges=0），把最该看的一组变成"有时整段消失"是最坏的选择。
  L.push(
    `sel ranges=${n(r.rangeCount)}  collapsed=${b(r.collapsed)}` +
      `  node=${n(r.node)}@${n(r.nodeOffset)}` +
      `  connected=${b(r.connected)}  inEditor=${b(r.inEditor)}` +
      `  rects=${n(r.rects)}  bcr=${n(r.bcr)}  block=${n(r.block)}`,
  );

  // 4 编辑器 HTML（老项目 :1960，截断到 70）
  L.push(`editor=${n(r.editorHtml === null ? null : cut(r.editorHtml, 70))}`);

  // 5 原生桥 + 闹钟（老项目 :1965-1969）
  L.push(
    `native=${n(r.native)}  bridge=${n(r.bridge)}  scheduled=${n(r.scheduled)}  exact=${b(r.exact)}`,
  );

  // 6 SSE + 上次同步 + 推迟计数（老项目 :1970-1972）
  //   🔴 多带一个 `state=`：bj 的同步状态机有 6 个态（fsm.ts），
  //   老项目那个 `sse=open` 之外没有状态维度，而"事件流开着但状态卡在 offline"
  //   恰恰是最常见的一种坏 —— 没有 state 就得靠猜。
  L.push(
    `sync sse=${n(r.sse)}  state=${n(r.syncState)}` +
      `  lastSync=${ago(r.lastSyncAt, now)}  skip=${n(r.skip)}`,
  );

  // 7 光标挪移/打字推迟探针（老项目 :1975-1977）
  L.push(`caret relocated=${n(r.relocated)}  kept=${n(r.kept)}  typeDefer=${n(r.typeDefer)}`);

  // 8 提醒与远端（老项目 :1979-1983）
  L.push(
    `rem=${n(r.remTotal)}  future=${n(r.remFuture)}  lastNativeSync=${n(r.lastNativeSync)}` +
      `  pendingRemote=${n(r.pendingRemote === null ? null : r.pendingRemote ? 1 : 0)}  localVer=${n(r.localVer)}`,
  );

  // 9 冲突链路七探针（老项目 :1987-1993）
  L.push(
    `conflict a1=${n(r.a1)}  f1=${n(r.f1)}  rcBar=${n(r.rcBar)}  wconBar=${n(r.wconBar)}` +
      `  wconAM=${n(r.wconAM)}  l2AM=${n(r.l2AM)}  rbd=${n(r.rbd)}`,
  );

  // 10 删除线完整性（老项目 :1998-2001）
  L.push(`strike s=${n(r.strikeS)}  sBare=${n(r.strikeSBare)}`);

  // 附：扫码自检（老项目 :2018）。不算进 10 组，但同属"屏上零信息"的一类问题。
  L.push(
    r.scan === null
      ? `scan ${COPY.diag.scanNone}`
      : `scan engine=${n(r.scan.engine)}  frames=${n(r.scan.frames)}  hits=${n(r.scan.hits)}` +
          `  miss=${n(r.scan.miss)}  errs=${n(r.scan.errs)}  cam=${n(r.scan.cam)}` +
          `  dec=${n(r.scan.dec)}  result=${n(r.scan.result)}  err0=${n(r.scan.err0)}`,
  );

  return L;
}

/**
 * 组 id → 该组首行的前缀。判据用它做"第 N 组是什么"的反向定位。
 * 键是 {@link renderDiagLines} 里各组的**头一个词**。
 */
export const DIAG_GROUP_HEADS: Readonly<Record<DiagGroup, string>> = {
  ver: 'ver ',
  focus: 'focus=',
  sel: 'sel ranges=',
  editor: 'editor=',
  native: 'native=',
  sync: 'sync sse=',
  caret: 'caret relocated=',
  rem: 'rem=',
  conflict: 'conflict a1=',
  strike: 'strike s=',
};
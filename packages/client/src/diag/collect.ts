/**
 * 诊断读数的 **DOM 采集层**（老项目 `index.html:1938-2057` 那段 try 块）
 *
 * 🔴 本文件**只读**。任何一处写操作（改 class / focus / 读后即清）
 *   都会让"取证"这件事本身失真 —— 用户看到的是被诊断改过的页面，
 *   而我们要定位的恰恰是"页面此刻长什么样"。
 *
 * 🔴 为什么读数一律经 `deps` 注入而不是直接摸 `window`：
 *   判据要能在 node 里喂假读数验证 `renderDiagLines`，
 *   而"采集"与"排版"两件事混在一起时，判据就只能去测排版。
 */

import { getRemBridge } from '../reminder/native-rem.ts';
import { naReadings, renderDiagLines, type DiagReadings } from './lines.ts';

/** 采集所需的外部读数。**每一项都可缺省** —— 缺省即渲染成 `n/a`。 */
export interface DiagDeps {
  /** 版本号（`version.ts` 的 APP_VERSION）。 */
  version: string;
  /** 编辑器根 DOM。老项目直接读全局 `editor`。 */
  editorHost: () => HTMLElement | null;
  /** 输入法组字态。Lexical 有现成的 `isComposing()`，老项目读全局变量。 */
  composing: () => boolean | null;
  /** 是否壳内（APK）。老项目 `isNativeApp()`。 */
  isNative: () => boolean;
  /** 同步状态机的诊断出口（`SyncClient.diagState()`）。没建客户端时给 null。 */
  sync: () => { sse: 'open' | 'closed'; state: string; lastSyncAt: number | null; skip: number | null } | null;
  /** 当前真源（拿提醒数 / 未来数）。没打开笔记时给 null。 */
  doc: () => { reminders?: { at: string }[] } | null;
  /** 扫码自检（`window.__NOTESYNC_SCAN_DIAG__`）。 */
  scan: () => DiagReadings['scan'];
  /** 上次原生闹钟同步的结论（`native-rem` 侧留存；没留存过给 null）。 */
  lastNativeSync: () => { note: string; at: number; scheduled: number | null } | null;
  /** 飞行记录器（v3.0.9 诊断版）：格式化的事件流。不给 = 不追加该区块。 */
  flight?: () => string[];
}

/** 从 DOM 里取「活动元素」的可读名（老项目 :1941 `ae.id || ae.nodeName`）。 */
function activeElName(win: Window): string | null {
  const ae = win.document.activeElement;
  if (!ae) return null;
  return ae.id || ae.nodeName || null;
}

/** 编辑器光标色（老项目 :1942 `getComputedStyle(editor).caretColor`）。 */
function caretColor(win: Window, host: HTMLElement): string | null {
  const v = win.getComputedStyle(host).caretColor;
  return v || null;
}

/** 选区几何（老项目 :1943-1959）。**没有选区时逐项返回 null**（渲染成 n/a）。 */
function readSelection(win: Window, host: HTMLElement | null): Pick<
  DiagReadings,
  'rangeCount' | 'collapsed' | 'node' | 'nodeOffset' | 'connected' | 'inEditor' | 'rects' | 'bcr' | 'block'
> {
  // 🔴 显式标注类型：`const out = { rangeCount: null, … }` 会被推成
  //   `{ rangeCount: null; … }`，随后 `out.rangeCount = sel.rangeCount` 直接编译不过。
  //   （strict + noUncheckedIndexedAccess 下这是必踩的一处。）
  const out: Pick<
    DiagReadings,
    'rangeCount' | 'collapsed' | 'node' | 'nodeOffset' | 'connected' | 'inEditor' | 'rects' | 'bcr' | 'block'
  > = {
    rangeCount: null,
    collapsed: null,
    node: null,
    nodeOffset: null,
    connected: null,
    inEditor: null,
    rects: null,
    bcr: null,
    block: null,
  };
  const sel = win.getSelection?.();
  if (!sel) return out;
  out.rangeCount = sel.rangeCount;
  out.collapsed = sel.isCollapsed;
  if (!sel.rangeCount) return out;
  try {
    const r = sel.getRangeAt(0);
    const sc = r.startContainer;
    out.node = sc.nodeType === 3 ? 'TEXT' + JSON.stringify((sc.nodeValue || '').slice(0, 10)) : sc.nodeName;
    out.nodeOffset = r.startOffset;
    out.connected = sc.isConnected;
    out.inEditor = host ? host.contains(r.commonAncestorContainer) : null;
    const rects = r.getClientRects();
    const bb = r.getBoundingClientRect();
    out.rects = rects.length;
    out.bcr = [bb.x, bb.y, bb.width, bb.height].map((v) => Math.round(v)).join(',');
    // 往上找块级祖先（老项目 :1953-1957 的 while）。到 host 为止。
    let blk: Node | null = sc.nodeType === 3 ? sc.parentElement : sc;
    while (blk && host && blk.parentElement !== host && blk !== host) blk = blk.parentElement;
    if (blk && host && blk !== host && (blk as HTMLElement).getBoundingClientRect) {
      const bb2 = (blk as HTMLElement).getBoundingClientRect();
      out.block = `${blk.nodeName} h=${Math.round(bb2.height)}`;
    }
  } catch {
    // 读数失败绝不让整份诊断挂掉 —— 少一行比一行都不出强
  }
  return out;
}

/**
 * 删除线计数（老项目 :1997-2002 的 `strike: s= sBare=`）。
 *
 * 🔴🔴 **口径差异（老项目按标签 `<s>`，bj 按 class `.ns-s`）**：
 *   老项目正文是自管 HTML，删除线就是 `<s>` 标签（`:1998`
 *   `querySelectorAll('s:not(.rem-done)')`）。bj 走 Lexical，
 *   删除线由 theme 的 `text.strikethrough: 'ns-s'` 渲染成 `<span class="ns-s">`
 *   —— **照抄 `<s>` 选择器会恒为 0**，而 0 在这一行是"合法读数"，
 *   于是诊断会自信地报「一处删除线都没有」，把用户引向错误的结论。
 *   🔴 所以选择器必须是 `.ns-s`，并在判据里钉住这一点。
 *
 * `sBare` = 紧贴裸文本的删除线（老项目 :2000-2001）：
 *   >0 即发生过 Blink 格式弹出或取消拆分残留 —— 用户报障「末字母失去删除线」
 *   时复制本行即可定位。
 */
export function readStrike(host: HTMLElement | null): { s: number; sBare: number } {
  if (!host) return { s: 0, sBare: 0 };
  const all = Array.from(host.querySelectorAll('.ns-s:not(.rem-done)'));
  const bare = all.filter((s) => {
    const prev = s.previousSibling;
    const next = s.nextSibling;
    return (
      (prev !== null && prev.nodeType === 3 && prev.nodeValue) ||
      (next !== null && next.nodeType === 3 && next.nodeValue)
    );
  });
  return { s: all.length, sBare: bare.length };
}

/**
 * 采一次完整读数。
 *
 * @param now 注入 `Date.now()`（`lastSync` 的"几秒前"要用；判据也靠它定住输出）
 */
export function collectDiagReadings(deps: DiagDeps, now: number): DiagReadings {
  const r = naReadings(deps.version);
  const win = typeof window !== 'undefined' ? window : undefined;
  if (!win) return r; // 无 DOM 环境（node 直跑）：全部 n/a，绝不抛

  const host = deps.editorHost();
  try {
    r.composing = deps.composing();
  } catch {
    r.composing = null;
  }
  r.activeEl = activeElName(win);
  try {
    r.docFocus = win.document.hasFocus();
  } catch {
    r.docFocus = null;
  }
  if (host) {
    try {
      r.caretColor = caretColor(win, host);
    } catch {
      r.caretColor = null;
    }
    try {
      r.editorHtml = host.innerHTML;
    } catch {
      r.editorHtml = null;
    }
  }
  Object.assign(r, readSelection(win, host));

  /* 5 原生桥（老项目 :1963-1969）。bridge 走 native-rem.getRemBridge ——
     🔴 刻意复用生产探测函数（顺序承重，见 native-rem.ts 文件头），
        诊断自己再写一遍 `window.Capacitor?.Plugins?.RemBridge` 就是分叉的开始。 */
  try {
    r.native = deps.isNative() ? 'APK' : 'web';
    r.bridge = getRemBridge(win) ? 'ok' : 'none';
  } catch {
    r.native = null;
    r.bridge = null;
  }
  try {
    const last = deps.lastNativeSync();
    // 🔴 `scheduled` 只在**真的报过数**时给值。老项目是
    //   `window.__remNativeScheduled != null ? … : '?'`，口径一致：
    //   "还没同步过"（null）与"同步了但一条没排上"（0）是两回事，必须能分辨。
    r.scheduled = last !== null && last.scheduled !== null ? last.scheduled : null;
    r.lastNativeSync = last !== null ? `${last.note} ${Math.round((now - last.at) / 1000)}s前` : null;
  } catch {
    r.scheduled = null;
    r.lastNativeSync = null;
  }
  // 🔴 `exact` 恒为 null（写 null 不写 false）：bj 的
  //   ensureExactAlarmPermission 只在首次调用、不留历史值（见 NA_REASONS.exact）。
  //   写 false 等于断言"没有精确闹钟权限"，而真相是"不知道"。

  /* 6 同步（老项目 :1970-1972） */
  try {
    const s = deps.sync();
    if (s !== null) {
      r.sse = s.sse;
      r.syncState = s.state;
      r.lastSyncAt = s.lastSyncAt;
      r.skip = s.skip;
    }
  } catch {
    r.sse = null;
  }

  /* 8 提醒（老项目 :1979-1983 的 rem / future） */
  try {
    const d = deps.doc();
    const list = d !== null ? (d.reminders ?? []) : null;
    if (list !== null) {
      r.remTotal = list.length;
      // 🔴 `future` 的意义（老项目 :1980 注释）：scheduled=0 时要能分辨
      //   「全部过期」与「根本没同步」。所以它数的是 at > now，不是 list.length。
      r.remFuture = list.filter((x) => Date.parse(x.at) > now).length;
    }
  } catch {
    r.remTotal = null;
    r.remFuture = null;
  }
  /* 7 / 8 余下 / 9 全部字段保持 null ⇒ 渲染成 n/a（理由见 lines.ts NA_REASONS） */

  /* 10 删除线 */
  try {
    const st = readStrike(host);
    r.strikeS = st.s;
    r.strikeSBare = st.sBare;
  } catch {
    r.strikeS = null;
    r.strikeSBare = null;
  }

  try {
    r.scan = deps.scan();
  } catch {
    r.scan = null;
  }

  return r;
}

/**
 * 采一次并排版。老项目 `window.collectDiagLines()` 同名同义。
 *
 * 🔴 与老项目的差异：老项目整段包在一个 try 里，任何异常都变成一行 `ERR msg`。
 *   bj 拆成"每项各自 try"（见 collectDiagReadings），因为**丢掉整份读数只留一行
 *   ERR 是最坏的处理** —— 用户拿到手的是"诊断信息生成失败"，而实际只是某个
 *   可选读数取不到（老项目那条 catch 正是被 :2012 的 sessionStorage 解析异常触发过，
 *   结果整份 10 组读数全丢）。现在坏一项只坏一项。
 */
export function collectDiagLines(deps: DiagDeps, now: number): string[] {
  const lines = renderDiagLines(collectDiagReadings(deps, now), now);
  // 🔴 飞行记录器（v3.0.9 诊断版）：追加在读数之后，面板的复制按钮一并带走。
  //   独立 try：日志读数坏了不许拖垮 10 组诊断读数（与本函数"每项各自 try"同款纪律）。
  if (deps.flight) {
    try {
      lines.push('', '── 飞行日志（只含事件名/长度/哈希，绝不含正文）──', ...deps.flight());
    } catch (e) {
      lines.push('', '── 飞行日志生成失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }
  return lines;
}
/**
 * 诊断面板的两个入口 —— **模态**（关于页标题连点 4 次）与**常驻浮层**（`?diag`）
 *
 * 🔴 老项目文件头原文（:1926-1928）：
 *   「光标诊断浮层（?diag 开启）。用于在真实浏览器里定位 caret 类问题——
 *     headless 不做真实合成，『能打字但看不见光标』这类现象只能靠真机读数确认。
 *     **纯只读**：不改DOM、不抢焦点（pointer-events:none），不开启时零开销。」
 *
 * 🔴🔴 三条照抄纪律：
 *   1. **浮层 `pointer-events:none`** —— 它压在页面右下角，不挡任何东西。
 *      老项目没这条时浮层会吃掉点击，用户以为是页面某个按钮坏了。
 *   2. **不开启时零开销** —— 定时器只在 `bootDiag` 之后存在；模块顶层的
 *     `setInterval` 会在用户根本没打开过诊断时也一直唤醒主线程。
 *   3. **模态是一次性快照，浮层是 250ms 实时刷新**（老项目 :1933-1934 注释）。
 *      反过来做（模态持续刷新）会让"复制按钮复制的文本"在点下去的那一瞬变了。
 */

import { COPY } from '../ui/copy.ts';
import { ICON_X } from '../ui/icons.ts';
import { collectDiagLines, type DiagDeps } from './collect.ts';

export interface DiagPanel {
  /** 打开模态（老项目 `openDiagModal()`）。**打开即打彩蛋埋点**（:8219 `nsEggUnlock('diag')`）。 */
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  /** 打开常驻浮层。已开着则无操作（老项目 `if (diagBox) return`）。 */
  boot: () => void;
  /** 收浮层。老项目 `stopDiag()`。 */
  stop: () => void;
  /** 浮层是否开着。 */
  overlayOn: () => boolean;
  /** 立即刷新浮层一次（不重设定时器）。 */
  refresh: () => void;
  /** 取当前读数文本（判据与复制共用一条路径）。 */
  text: () => string;
}

/**
 * 关于页标题的 800ms/4 连点**已移出本文件** ⇒ `diag/tap.ts`。
 *
 * 🔴 移出的理由：`update/ota-ui.ts` 只该为"标题被点了 4 次"问一声，
 *   不该因为这一句 import 整个诊断面板（模态 DOM + 250ms 浮层 + 复制降级链）。
 *   这里是重导出，纯粹为了让"诊断相关的东西都在 diag/ 下"这条导航线索不断。
 */
export {
  ABOUT_TAP_MS,
  ABOUT_TAP_TIMES,
  REAL_SCHED,
  aboutTapHit,
  createAboutTapper,
  type TapSched,
  type Tapper,
} from './tap.ts';

/** 浮层刷新间隔（老项目 :2072 `setInterval(…, 250)`）。 */
export const DIAG_OVERLAY_MS = 250;

/**
 * `?diag` 查询参数判定（老项目 :2079 `location.search.indexOf('diag') !== -1` 的**收紧版**）。
 *
 * 🔴🔴 为什么不用 indexOf：老项目那样写的话，路径里含 "diag" 的**笔记名**
 *   （例如 `/my-diagnostic`）会顺带把诊断浮层打开。症状是
 *   「打开某篇笔记后右下角莫名多一块黑底绿字」—— 用户完全无法自查，
 *   而且**零报错**（页面一切正常，只是多了个浮层）。
 *   bj 改为按 `?diag` / `&diag` 精确匹配，且**必须是完整的 query 项**。
 *
 * @param search `location.search`（含前导 `?`）
 */
export function hasDiagFlag(search: string): boolean {
  return /[?&]diag(?:[=&]|$)/.test(search);
}

/** 浮层跨重载保持的存储键。**bj 前缀**，不复用老项目的 `notesync_diag`
 *  （同款纪律见 registry.EGG_KEY / favs / rem-native 的 EXACT_ALARM_ASKED_KEY）。 */
export const DIAG_KEY = 'notesync_bj_diag';

/** 真机反复取证用：浮层开着就跨重载保持（老项目 :2080）。 */
export function diagFlagStored(win?: unknown): boolean {
  const w = (win ?? (typeof window !== 'undefined' ? window : undefined)) as
    | { localStorage?: { getItem(k: string): string | null } }
    | undefined;
  try {
    return w?.localStorage?.getItem(DIAG_KEY) === '1';
  } catch {
    return false;
  }
}

/** 开浮层时写标记（老项目那条 localStorage 路径的另一半）。写不下静默。 */
export function rememberDiagFlag(win?: unknown): void {
  const w = (win ?? (typeof window !== 'undefined' ? window : undefined)) as
    | { localStorage?: { setItem(k: string, v: string): void } }
    | undefined;
  try {
    w?.localStorage?.setItem(DIAG_KEY, '1');
  } catch {
    /* 隐私模式写不进：只影响"跨重载保持"，不影响本次浮层 */
  }
}

export function buildDiagPanel(host: HTMLElement, deps: DiagDeps, hooks: {
  /** 打开模态时打彩蛋埋点。老项目 :8219 `nsEggUnlock('diag')` —— 连点与图鉴 replay 两条路都记。 */
  onUnlock: () => void;
  /** 关闭后归还焦点（桌面端失焦后光标不绘制 —— 老项目红线 10）。 */
  onClosed: () => void;
}): DiagPanel {
  /* ---------------- 模态（老项目 #diagMask + #diagContent + #diagCopy） ---------------- */
  const mask = document.createElement('div');
  mask.className = 'mask hidden';
  mask.id = 'diagMask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-label', COPY.diag.title);

  const box = document.createElement('div');
  box.className = 'box diag-box';

  const head = document.createElement('div');
  head.className = 'modal-head';
  const h1 = document.createElement('h1');
  h1.textContent = COPY.diag.title;
  const x = document.createElement('button');
  x.className = 'box-x';
  x.type = 'button';
  x.title = COPY.close;
  x.setAttribute('aria-label', COPY.close);
  // 🔴 用 ICON_X 的 SVG 而不是字形 '×'：全站关闭键都是同一枚 24 视框/描边 2 的路径
  //   （老项目 :667/679），字形 × 的大小与笔画粗细由系统字体决定，并排看会明显"轻一号"。
  //   走 innerHTML 是安全的：ICON_X 是本项目自产的常量字符串，无外部输入。
  x.innerHTML = ICON_X();
  head.append(h1, x);

  const pre = document.createElement('pre');
  pre.className = 'diag-pre';
  pre.id = 'diagContent';
  // 🔴 老项目用 textContent（:8221），不是 innerHTML —— 读数里含 innerHTML 截断
  //   与用户正文，尖括号一旦被当 HTML 解析就是注入面。
  pre.setAttribute('role', 'status');
  pre.setAttribute('aria-live', 'polite');

  const copyBtn = document.createElement('button');
  // 🔴 不挂自定义类：`.box button:not(.box-x)` 已是全站通栏按钮规则（老项目 :518 同款）。
  //   另起一个类名会落进"样式表里根本没有对应规则"的老坑（见 styles.css:450 注释）。
  copyBtn.type = 'button';
  copyBtn.id = 'diagCopy';
  copyBtn.textContent = COPY.diag.copy;

  box.append(head, pre, copyBtn);
  mask.append(box);
  host.append(mask);

  let open = false;
  let lastText = '';

  const close = (): void => {
    if (!open) return;
    open = false;
    mask.classList.add('hidden');
    hooks.onClosed();
  };

  const snapshot = (): string => {
    try {
      return collectDiagLines(deps, Date.now()).join('\n');
    } catch (e) {
      // 🔴 老项目 :8222 的 catch 同款，但**兜底文案要说清是生成失败**，
      //   否则用户会以为诊断面板坏了（实际是某个读数抛错）。
      return `${COPY.diag.fail}: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  /**
   * 复制（老项目 :8226-8243）。
   *
   * 🔴 三处细节逐条照抄：
   *   ① `navigator.clipboard.writeText` 缺失/拒绝 ⇒ 走 `fallbackCopyText`。
   *   ② 成功后 2200ms 自动收起提示条，**且带"文案仍是它才清"的守卫**（老项目 :8231）——
   *      少了守卫会把随后出现的其它提示（比如"已保存到相册"）误清掉。
   *   ③ `document.execCommand('copy')` 已废弃但**必须留**：非安全上下文
   *      （http 局域网直连、老 WebView）上clipboard API 根本不存在，
   *      删掉它等于这些环境下复制功能彻底消失、且零报错。
   */
  const fallbackCopyText = (txt: string, done: () => void): void => {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.append(ta);
    ta.select();
    try {
      if (document.execCommand('copy')) done();
    } catch {
      /* 复制失败不提示：用户已经点了，按钮无反应本身就是反馈 */
    }
    ta.remove();
  };

  const onCopy = (): void => {
    const txt = pre.textContent || '';
    const done = (): void => {
      const el = document.getElementById('uploadNote');
      if (!el) return;
      el.textContent = COPY.diag.copied;
      el.dataset.kind = 'ok';
      window.setTimeout(() => {
        // 🔴 守卫：只有"现在显示的仍是本条提示"才收（老项目 :8232 原文）
        if (el.textContent === COPY.diag.copied) el.remove();
      }, COPY.diag.copiedMs);
    };
    const nav = navigator as Navigator & {
      clipboard?: { writeText: (t: string) => Promise<void> };
    };
    if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      nav.clipboard.writeText(txt).then(done, () => fallbackCopyText(txt, done));
    } else {
      fallbackCopyText(txt, done);
    }
  };

  x.onclick = close;
  copyBtn.onclick = onCopy;
  mask.onclick = (e) => {
    // 🔴 点遮罩空白处才关（老项目 :8244 `if (e.target === diagMask)`）。
    //   无条件 close 会让"点按钮时事件冒泡到遮罩"把刚打开的面板秒关。
    if (e.target === mask) close();
  };

  /* ---------------- 常驻浮层（老项目 #caretDiag） ---------------- */
  let box2: HTMLElement | null = null;
  let timer: number | undefined;

  const refresh = (): void => {
    if (!box2) return;
    box2.textContent = lastText;
  };

  const paint = (): void => {
    lastText = snapshot();
    refresh();
  };

  const boot = (): void => {
    if (box2) return; // 幂等（老项目 :2062 `if (diagBox) return`）
    box2 = document.createElement('div');
    box2.id = 'caretDiag';
    // 🔴 class 承重，颜色全部走 var(--diag-*)/var(--mono)（老项目是 cssText 内联）。
    //   内联样式写颜色会绕过 ui/theme.ts 的色板，改配色时这块必被漏掉
    //   —— 而它恰恰是最该跟着主题走的一块（或者说最不该，但更不该的是"没人管它"）。
    box2.className = 'ns-caret-diag';
    // 🔴 pointer-events:none 是**纪律**（老项目 :1928），压一条注释在 CSS 里
    document.body.append(box2);
    paint();
    // 🔴 定时器**只在 boot 之后创建**（纪律②）。卸载时必须清 —— 见 stop()。
    timer = window.setInterval(paint, DIAG_OVERLAY_MS);
  };

  const stop = (): void => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
    box2?.remove();
    box2 = null;
  };

  // 🔴 老项目 :8246：滚动笔记即关闭诊断模态（用户拍板"滚动即视为离开诊断"）。
  //   只关模态不动浮层 —— 浮层是取证用的，用户就是要一边滚一边看读数。
  const onScroll = (): void => {
    if (open) close();
  };
  document.addEventListener('scroll', onScroll, true);

  return {
    open: () => {
      // 🔴 埋点在**取读数之前**：老项目 :8219 就是第一行 `nsEggUnlock('diag')`。
      //   放最后的话，生成失败那次连点就白点了（用户会以为没触发）。
      hooks.onUnlock();
      lastText = snapshot();
      pre.textContent = lastText;
      mask.classList.remove('hidden');
      open = true;
    },
    close,
    isOpen: () => open,
    boot,
    stop,
    overlayOn: () => box2 !== null,
    refresh,
    text: () => lastText,
  };
}

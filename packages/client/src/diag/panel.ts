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
 * 🔴🔴 打开模态后的**输入宽限期**（毫秒）。
 *
 * 为什么必须有（用户报障第 1 条「App 里点 4 下关于标题，诊断弹窗不出现」实锤：
 * 关于页确实关了 —— 说明 4 连点判定成功、`openDiagModal()` 也跑了，
 * 但弹窗没露面）：连点是一个**手势**，第 4 下命中时用户的手指往往还悬在
 * 屏幕上，第 5 下"是不是没点上"的补点在 ~150-400ms 后落在刚展开的
 * `#diagMask` 空白处，被 `mask.onclick` 的 `e.target === mask` 分支秒关；
 * 真机上的 incidental scroll（软键盘收起 / 视口变化 / 手指微小拖动都被
 * Chromium 算成 scroll 事件）经 `onScroll` 同样致命。
 *
 * 这两类输入的共同点：都发生在 `.box` 的 `nsRise` 入场动画（.5s）结束之前 ——
 * 用户**根本没见过那个弹窗**，"滚动即视为离开诊断"（v3.1.2 用户拍板）
 * 这条规则在这段时间里无从谈起，它保护的是"看完了滚走"，不是"还没看清就没了"。
 *
 * 取 700ms：长于 500ms 的入场动画（保证先被看见），也长过"补点第 5 下"的
 * 典型间隔。代价是"故意点遮罩空白处关弹窗"要晚 700ms 生效 —— 用户仍可
 * **立刻**用右上角 × 关闭，所以这个代价不换任何功能。
 */
export const DIAG_INPUT_GRACE_MS = 700;

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

  // 🔴🔴 v3.1.3/v3.1.4/v3.1.5：导出/分享 .txt 文件 —— 真机剪贴板复制不全（400 条
  //   日志被截断），用户要求"存成文本文件/传电脑/发微信"。五级链（🔴 每级结束都要
  //   有反馈——v3.1.3 的「点了没反应」正是全链静默的结果）：
  //   ① App 壳原生分享 DiagExport.shareText：写文件 + 拉系统分享面板（微信/QQ/
  //      文件管理器/USB 一条路——用户原话「点击后直接把诊断信息.txt分享到微信」）；
  //   ② App 壳原生落盘 DiagExport.saveText → Download/NoteSync（分享面板不可用
  //      时的退路；壳内 a[download] 是哑弹、WebView 无 navigator.share——
  //      MainActivity:167 注释与 v8.0.8 导出图片链路双实锤）；
  //   ③ 网页 navigator.share（Android Chrome 系统分享面板，File 对象）；
  //   ④ 桌面 Blob + a[download]；
  //   ⑤ 全部不可用 ⇒ 兜底复制全文，复制成败都有明确提示（绝不静默）。
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.id = 'diagExport';
  exportBtn.textContent = COPY.diag.exportFile;

  // 🔴🔴🔴 v3.1.5：反馈条收进**弹窗自己的 DOM**。v3.1.3/v3.1.4 把反馈写进
  //   #uploadNote（编辑器上传状态条），而诊断面板在**非编辑器态**照样能开
  //   （?diag 直开、关于页连点标题——用户真机日志 inEditor=no 实锤）——那时
  //   #uploadNote 不存在，`if (!el) return` 把每一级反馈都咽掉，用户看到的
  //   就是「点击按钮没反应」。反馈面必须与触发面同生共死。
  const diagNote = document.createElement('div');
  diagNote.className = 'diag-note';
  diagNote.id = 'diagNote';
  diagNote.setAttribute('role', 'status');
  diagNote.setAttribute('aria-live', 'polite');
  diagNote.hidden = true;

  const flash = (msg: string, kind: string): void => {
    diagNote.textContent = msg;
    diagNote.dataset.kind = kind;
    diagNote.hidden = false;
    window.setTimeout(() => {
      // 🔴 与老项目 :8232 同款守卫：只有"现在显示的仍是本条"才收
      if (diagNote.textContent === msg) diagNote.hidden = true;
    }, COPY.diag.copiedMs);
  };

  const onExport = async (): Promise<void> => {
    const txt = pre.textContent || '';
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const name =
      `notesync-diag-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
    // ① App 壳原生分享（🔴 每次现读 Capacitor.Plugins.DiagExport——native-img-save 同款纪律）
    const cap = (window as unknown as { Capacitor?: { Plugins?: { DiagExport?: { shareText?: (o: { name: string; content: string }) => Promise<{ ok?: boolean; path?: string; error?: string }>; saveText?: (o: { name: string; content: string }) => Promise<{ ok?: boolean; path?: string; error?: string }> } } } }).Capacitor;
    const plug = cap?.Plugins?.DiagExport;
    if (plug && typeof plug.shareText === 'function') {
      try {
        const r = await plug.shareText({ name, content: txt });
        if (r && r.ok) {
          // 用户随后在分享面板点取消也到此为止（native 侧无法区分，不打扰）
          flash(COPY.diag.exportedShare, 'ok');
          return;
        }
      } catch {
        /* 原生分享失败 → 落到下一级（仅落盘） */
      }
    }
    // ② App 壳原生落盘（分享面板不可用/无分享应用时的退路）
    if (plug && typeof plug.saveText === 'function') {
      try {
        const r = await plug.saveText({ name, content: txt });
        if (r && r.ok) {
          flash(COPY.diag.exported, 'ok');
          return;
        }
      } catch {
        /* 原生桥失败 → 落到下一级 */
      }
    }
    // ③ 网页系统分享面板（Android Chrome）
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[]; title?: string }) => Promise<void>;
    };
    if (typeof nav.share === 'function' && typeof nav.canShare === 'function') {
      try {
        const file = new File([txt], name, { type: 'text/plain' });
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title: name });
          return; // 用户在分享面板点取消（AbortError）也到此为止，不打扰
        }
      } catch {
        /* 分享失败/取消 → 降级下载 */
      }
    }
    // ④ 桌面浏览器：Blob + a[download]
    try {
      const url = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      flash(COPY.diag.exportedDownloaded, 'ok');
      return;
    } catch {
      /* 下载也不可用 → 兜底复制 */
    }
    // ⑤ 全部不可用：兜底复制全文（onCopy 自带成功/失败反馈，绝不静默；
    //   成功文案用「导出不可用，已复制全文」——说清为什么得到的是复制而不是文件）
    onCopy(COPY.diag.exportFallbackCopy);
  };
  exportBtn.onclick = () => {
    void onExport();
  };

  // 🔴🔴 v3.2.4：按钮顺序改为「复制」在前、「分享导出」在后 —— 用户报障第 2 条
  //   「诊断报告上面有两个按钮，一个是复制什么的，一个是分享什么的，你把这
  //    两个按钮的位置给我换一换」。判据 DIAG-17 正向钉死这个顺序。
  //   （v3.1.4 之前是 exportBtn 在前，那之前只有 copyBtn 一个键。）
  box.append(head, pre, copyBtn, exportBtn, diagNote);
  mask.append(box);
  host.append(mask);

  let open = false;
  let lastText = '';
  /** 打开时刻（`Date.now()`）。宽限期与"滚动即离开"两条规则都从它算起。 */
  let openedAt = 0;

  /**
   * 是否还在打开后的输入宽限期内。
   *
   * 🔴 用 `Date.now() - openedAt` 而不是"记一个 setTimeout 到点置 false"：
   *   后者在页面被挂起（切后台）时定时器不跑，回来时宽限期已经"过期"了，
   *   而真机上切后台再回来恰恰是 scroll 噪声最多的时候。
   */
  const inInputGrace = (): boolean => Date.now() - openedAt < DIAG_INPUT_GRACE_MS;

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
   * 🔴 v3.1.5：失败**不再静默**。老注释写"按钮无反应本身就是反馈"——那是把
   *   产品缺陷当设计；真机 v3.1.3 报障「点击按钮没反应」的最后一环就是这里：
   *   execCommand 返 false 且无提示 ⇒ 用户无从判断是没点上还是没成功。
   */
  const fallbackCopyText = (txt: string, done: () => void): void => {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    if (ok) done();
    else flash(COPY.diag.copyFailed, 'err');
  };

  /**
   * 复制。`successMsg` 供导出链的兜底级传更贴切的文案（「导出不可用，已复制
   * 全文」比泛泛的「已复制诊断信息」多说清了一层为什么）；不传走默认。
   */
  const onCopy = (successMsg?: string): void => {
    const txt = pre.textContent || '';
    const done = (): void => {
      flash(successMsg ?? COPY.diag.copied, 'ok');
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
  copyBtn.onclick = () => {
    onCopy();
  };
  // 🔴🔴 v3.2.4：打开后的**输入宽限期**。详见 DIAG_INPUT_GRACE_MS 的注释。
  //   mask.onclick 与 onScroll 这两条"用户走了"的关闭路径都必须过它 ——
  //   否则连点第 4 下刚展开的弹窗会被同一手势的第 5 下补点秒关。
  mask.onclick = (e) => {
    // 🔴 点遮罩空白处才关（老项目 :8244 `if (e.target === diagMask)`）。
    //   无条件 close 会让"点按钮时事件冒泡到遮罩"把刚打开的面板秒关。
    if (e.target === mask && !inInputGrace()) close();
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
  // 🔴🔴 v3.1.2：模态**自己内容区的滚动不算"离开诊断"**——真机报障实测：
  //   400 条飞行日志必然超高 .diag-pre（max-height 56vh + overflow:auto），
  //   用户必须**在 pre 里滑动**才能看到底部关键事件段；capture 监听连自家
  //   pre 的滚动一起收 ⇒ "点一下/滑一下弹窗就秒关、想下滑看底部也不行"。
  //   滚动目标在模态内（pre/box）一律忽略，只有模态**之外**的滚动
  //   （滚笔记正文）才视为离开。
  // 🔴🔴🔴 v3.2.4：再加一道**输入宽限期**（用户报障第 1 条「点 4 下关于标题，
  //   诊断弹窗不出现」实锤）。4 连点命中时用户的手指往往还悬在屏幕上，
  //   第 5 下"是不是没点上"的补点在 ~150-400ms 后落在刚展开的 #diagMask
  //   空白处，被 mask.onclick 秒关；真机的 incidental scroll（软键盘收起 /
  //   视口变化 / 手指微小拖动都被 Chromium 算成 scroll 事件）同样致命。
  //   这两类输入都发生在 `.box` 的 nsRise 入场动画（.5s）结束之前 ——
  //   用户**根本没见过那个弹窗**，"滚动即离开"根本无从谈起。
  const onScroll = (e: Event): void => {
    if (!open) return;
    if (e.target instanceof Node && mask.contains(e.target)) return;
    if (inInputGrace()) return;
    close();
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
      // 🔴 必须在最后一行：宽限期从"弹窗真的可见"这一刻起算。
      //   写在前面的话，生成读数（400 条飞行日志的字符串拼接）耗掉的时间
      //   会凭空吃掉宽限期 —— 而那正是最需要被保护的那一段。
      openedAt = Date.now();
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

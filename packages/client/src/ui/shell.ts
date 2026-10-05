/**
 * 应用外壳：顶栏 7 键 + 编辑器区 + 底栏状态区 + 皮肤覆膜层
 *
 * 🔴🔴 三条复刻纪律（与pages.ts 同源，见 ARCH.md §4.2.1）：
 *   1. **顶栏 9 个 button 但只有 7 个可见**。themeBtn / lock 被 CSS `display:none`
 *      永久隐藏（功能已迁入菜单）。我第一版想"干脆不画"，那是**复刻失败** ——
 *      老项目 DOM 里就有这两个按钮，靠样式隐藏；将来若要恢复显示只需去掉 CSS。
 *      行为契约是"看不见"，不是"不存在"。
 *   2. **编辑器没有富文本块工具栏**。老项目无 formatBlock / 无标题键 / 无列表键 /
 *      无引用 / 无代码块 / 无分割线 / 无 slash 命令。真实能力只有三类：
 *      行首标记（折叠）、顶栏键（删除线 / 图片）、纯文本自动识别。
 *      所以这里**绝不能**因为"编辑器框架都引了 Lexical，形状按钮顺手就加"而加工具栏。
 *   3. 文案从 copy.ts 取，颜色从 var(--*) 取。
 *
 * 皮肤三态环：连点左上角 logo **7 次**前进一格（默认 → 终端绿 → 打字机纸 → 默认）。
 * 🔴 连点计数是 ephemeral UI 态，与折叠开合同样**不进真源**。
 */

import { COPY, TOPBAR_HIDDEN_IDS, TOPBAR_VISIBLE_IDS } from './copy.ts';
import {
  ICON_COPY,
  ICON_EXPORT,
  ICON_MENU,
  ICON_QR,
  ICON_REFRESH,
  ICON_SCAN,
  ICON_STRIKE,
  ICON_REMIND,
  ICON_UPLOAD,
  LOGO,
  LOGO_SM,
} from './icons.ts';
import { bodyClassFor, nextSkin, SKIN_LABELS, SKIN_WORDS, skinOverlayStyle, type SkinName } from './theme.ts';

/** 连点多少下才切皮肤（老项目原文：7 下） */
const SKIN_TAP_TARGET = 7;
/** 两次点击间隔上限：超过就算重新开始数。防止"隔几分钟点一下"误触 */
const SKIN_TAP_WINDOW_MS = 1200;

export type TopbarAction =
  | 'strike'
  | 'remind'
  | 'upload'
  | 'copy'
  | 'exportImg'
  | 'scan'
  | 'qr';

/** 顶栏 7 个可见键 → 图标 + title。文案全在 copy.ts。 */
const TOPBAR_ITEMS: ReadonlyArray<{ id: string; act: TopbarAction; icon: () => string; title: string }> = [
  { id: 'strikeBtn', act: 'strike', icon: ICON_STRIKE, title: COPY.titleStrike },
  { id: 'remBtn', act: 'remind', icon: ICON_REMIND, title: COPY.titleRemind },
  { id: 'uploadBtn', act: 'upload', icon: ICON_UPLOAD, title: COPY.titleUpload },
  { id: 'copyBtn', act: 'copy', icon: ICON_COPY, title: COPY.titleCopy },
  { id: 'exportImgBtn', act: 'exportImg', icon: ICON_EXPORT, title: COPY.titleExport },
  { id: 'scanBtn', act: 'scan', icon: ICON_SCAN, title: COPY.titleScan },
  { id: 'qrBtn', act: 'qr', icon: ICON_QR, title: COPY.titleQr },
];

export interface ShellCallbacks {
  onTopbar: (act: TopbarAction) => void;
  onMenu: () => void;
  onRefresh: () => void;
  /** 七连点切皮肤后回调，参数是新皮肤名。 */
  onSkin?: (skin: SkinName) => void;
}

export interface Shell {
  root: HTMLElement;
  editorHost: HTMLElement;
  /** 顶栏 logo 字标，随皮肤变（默认 / NOTE-SYNC.EXE / N O T E S Y N C）。 */
  brand: HTMLElement;
  foot: HTMLElement;
  setStatus: (state: 'connecting' | 'synced' | 'offline', detail?: string) => void;
  setSkin: (skin: SkinName, night: boolean) => void;
}

export function buildShell(host: HTMLElement, cb: ShellCallbacks): Shell {
  // 🔴 顶栏按钮的 HTML 一次性拼好；themeBtn / lock **必须画出来**（靠 CSS 隐藏）。
  const visible = TOPBAR_ITEMS.map(
    (it) =>
      `<button type="button" id="${it.id}" class="ns-ic" data-act="${it.act}" ` +
      `title="${it.title}" aria-label="${it.title}">${it.icon()}</button>`,
  ).join('');

  host.innerHTML = `
<div class="shell" id="shell">
  <header class="ns-top">
    <span class="ns-brand" id="brand" role="button" tabindex="0" aria-label="${COPY.brandName}" title="${COPY.brandName}">
      <span class="ns-mark" id="brandMark">${LOGO_SM()}</span>
      <b id="brandWord">${SKIN_WORDS.default}</b>
      <span id="brandNote" class="hidden"></span>
      <span id="nsBadge" aria-hidden="true"><i class="ns-be"></i><i class="ns-bt"></i></span>
    </span>
    <span class="sp"></span>
    ${visible}
    <button type="button" id="${TOPBAR_HIDDEN_IDS[0]}" class="ns-ic" title="${COPY.titleMenu}" aria-hidden="true" tabindex="-1"></button>
    <button type="button" id="${TOPBAR_HIDDEN_IDS[1]}" class="ns-ic" title="${COPY.menuLock}" aria-hidden="true" tabindex="-1"></button>
  </header>
  <div class="ns-main" id="nsMain"></div>
  <footer class="ns-foot">
    <button type="button" id="menuBtn" title="${COPY.titleMenu}" aria-label="${COPY.titleMenu}" aria-haspopup="dialog">${ICON_MENU()}</button>
    <span class="dot" id="syncDot"></span>
    <span id="syncText">${COPY.statusConnecting}</span>
    <button type="button" id="refreshBtn" title="${COPY.titleRefresh}" aria-label="${COPY.titleRefresh}">${ICON_REFRESH()}</button>
  </footer>
</div>
<div id="skinFx" aria-hidden="true"></div>`.trim();

  const root = host.querySelector<HTMLElement>('#shell');
  const main = host.querySelector<HTMLElement>('#nsMain');
  const brand = host.querySelector<HTMLElement>('#brand');
  const brandWord = host.querySelector<HTMLElement>('#brandWord');
  const foot = host.querySelector<HTMLElement>('.ns-foot');
  const dot = host.querySelector<HTMLElement>('#syncDot');
  const syncText = host.querySelector<HTMLElement>('#syncText');
  const skinFx = host.querySelector<HTMLElement>('#skinFx');
  if (!root || !main || !brand || !brandWord || !foot || !dot || !syncText || !skinFx) {
    throw new Error('应用外壳结构不完整：buildShell 与模板不同源');
  }

  // 编辑器宿主：Lexical 的 root 元素。
  // 🔴 contenteditable / role / aria 三件套**显式写出来**，不指望 Lexical 顺带设。
  //   少写 role=textbox 屏幕阅读器读不到；少写 aria-multiline 读屏软件会当成单行输入框
  //   （回车换行没有提示）。老项目也显式写了这两条。
  const editorHost = document.createElement('div');
  editorHost.id = 'editor-host';
  editorHost.setAttribute('contenteditable', 'true');
  editorHost.setAttribute('role', 'textbox');
  editorHost.setAttribute('aria-label', COPY.editorAria);
  editorHost.setAttribute('aria-multiline', 'true');
  // 🔴 空态占位符（老项目 index.html:341 读 data-ph，:746 写这个字面量）。
  //   少了它，空编辑器是一片空白 —— 用户不知道这里能不能点、能不能打字。
  //   注意 CSS 侧不能照抄老项目的 `:empty`：Lexical 永远至少留一个
  //   <p class="ns-p"><br></p>，:empty 恒不成立（详见 styles.css 里的注释）。
  editorHost.setAttribute('data-ph', COPY.editorPlaceholder);
  editorHost.spellcheck = false;
  editorHost.className = 'ns-editor';
  main.appendChild(editorHost);

  for (const b of host.querySelectorAll<HTMLButtonElement>('button.ns-ic[data-act]')) {
    const act = b.dataset.act as TopbarAction;
    b.addEventListener('click', () => cb.onTopbar(act));
  }
  host.querySelector<HTMLButtonElement>('#menuBtn')?.addEventListener('click', () => cb.onMenu());
  host.querySelector<HTMLButtonElement>('#refreshBtn')?.addEventListener('click', () => cb.onRefresh());

  /* ---- 皮肤三态环：连点 logo 7 次前进一格 ---- */
  let taps = 0;
  let tapTimer: ReturnType<typeof setTimeout> | undefined;
  let skin: SkinName = 'default';
  const countTap = (): void => {
    taps += 1;
    if (tapTimer !== undefined) clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      taps = 0;
    }, SKIN_TAP_WINDOW_MS);
    if (taps < SKIN_TAP_TARGET) return;
    taps = 0;
    skin = nextSkin(skin);
    cb.onSkin?.(skin);
  };
  brand.addEventListener('click', countTap);
  brand.addEventListener('keydown', (e) => {
    // 🔴 role=button 必须自己处理 Enter/Space，否则键盘用户进不去皮肤环
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      countTap();
    }
  });

  const setSkin = (next: SkinName, night: boolean): void => {
    skin = next;
    brandWord.textContent = SKIN_WORDS[next];
    brand.title = SKIN_LABELS[next];
    // 🔴 default 档必须**清空**背景：残留一层扫描线是最难察觉的UI 漂移
    skinFx.style.background = skinOverlayStyle(next, night);
    document.body.className = bodyClassFor(night ? 'dark' : 'light', next);
  };

  const setStatus = (state: 'connecting' | 'synced' | 'offline', detail?: string): void => {
    dot.className = state === 'connecting' ? 'dot' : state === 'synced' ? 'dot on' : 'dot off';
    if (state === 'connecting') {
      syncText.textContent = COPY.statusConnecting;
    } else if (state === 'offline') {
      syncText.textContent = COPY.offlinePrefix + (detail ?? '');
      syncText.className = 'offlinebar';
    } else {
      // 同步成功：老项目是"静默"，不额外加前缀，避免每次保存都跳字
      syncText.textContent = detail ?? '';
      syncText.className = '';
    }
  };

  setStatus('connecting');
  return { root, editorHost, brand, foot, setStatus, setSkin };
}

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
  /**
   * 🔴 当前笔记名（老项目 index.html:10135 那个 `noteId`）。
   *
   * 空串 = 首页，老项目首页**维持「NoteSync」字标**，不显示笔记名。
   * 非空时按老项目 :10135 的判据决定：App 内或非桌面级指针设备 → 顶栏品牌位显示笔记名。
   */
  noteId?: string;
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

export type FootState = 'connecting' | 'synced' | 'offline';

/**
 * 底栏状态文案 —— **导出来是为了让单测能直接钉它**。
 *
 * 🔴🔴 这段逻辑原先内嵌在 setStatus 里，用户报障「底部没有已同步三个字」时444 条单测全绿：
 *   没有任何一条断言碰过 synced 分支的**渲染结果**。行内代码靠"读一遍觉得对"是不作数的，
 *   抽成纯函数后测试才能真的验它（见 test/ui-contract.test.mjs 的 S4-D1）。
 *
 * 🔴 抄老项目时抄错过的语义，务必记住：
 *   老项目 `setStatus(on, text)` = `statusText.textContent = text`（**无条件**赋值），
 *   同步成功时 7 处调用都传 '已同步' ⇒ 底栏**有**这三个字。
 *   它的"静默"来自**不调 setStatus**，不是靠空串表达。
 *   照着写成 `detail ?? ''` 就等于把"静默"翻译成了"空"——
 *   而 `footFor('idle')` 恰好返回 `{s:'synced'}` 不带 detail，两边一夹，底栏全空。
 *
 * @param detail 该状态下的补充说明（如「收藏最多 100 篇」「保存中…」）。
 *   🔴 detail **优先于**默认文案：e2e 07-fav 断言的收藏封顶提示走的就是这条。
 *   用 `||` 而非 `??`：空串也该回落到默认文案，否则又是一个"同步完底栏空掉"的入口。
 */
export function footText(state: FootState, detail?: string): string {
  if (state === 'offline') return COPY.offlinePrefix + (detail ?? '');
  if (state === 'connecting') return detail || COPY.statusConnecting;
  return detail || COPY.statusSynced;
}

/**
 * 顶栏品牌位要不要让位给笔记名 —— 老项目 index.html:10135 的判据，逐字翻译。
 *
 * 🔴🔴 判据是 `noteId && (isNativeApp() || !CHIP_HOVER_OK)`，**不是**视口宽度：
 *   `CHIP_HOVER_OK`（老项目 :6490）是 `(hover: hover) and (pointer: fine)`，
 *   即「桌面级输入设备」。所以：
 *   - App 内无条件显示（老项目 v7.3.2：App 无地址栏，看不见笔记名）；
 *   - 手机网页也显示（老项目 v7.4.0 推翻过「网页端零感知」，用户拍板扩到移动网页）；
 *   - PC 网页（有精确指针 + 可 hover）维持「NoteSync」字标不动。
 *
 * 🔴 桌面/手机是**互斥**而不是并存：命中时必须把 `#brandWord`（字标 `b`）藏掉。
 *   两者同显就是「NoteSync + 笔记名」并排，老项目专门在 :10133 注释里为此藏 `b`。
 *   `max-width:560px` 媒体查询只藏 `header .brand b`、**不碰 `#brandNote`**
 *   （老项目 :293对 :104-106 的刻意取舍），所以窄屏靠本函数显示、宽屏靠媒体查询藏字标，
 *   两侧共同保证「手机上只看到笔记名，桌面上只看到 NoteSync」。
 *
 * @param noteId 当前笔记名；空串 = 首页（老项目首页维持字标，不显示笔记名）
 * @param hoverFine `matchMedia('(hover: hover) and (pointer: fine)').matches` 的结果
 * @param isNativeApp 是否在 App 壳内（`window.__NOTESYNC_NATIVE__ === true`）
 */
export function shouldShowBrandNote(noteId: string, hoverFine: boolean, isNativeApp: boolean): boolean {
  return noteId !== '' && (isNativeApp || !hoverFine);
}

/**
 * 笔记名的展示形态 —— 老项目 index.html:10136-10137 的 `decodeURIComponent` 兜底。
 *
 * 🔴 首页名只允许 `[A-Za-z0-9_-]`（老项目 :10132），所以解码**只**为兼容二维码配对
 *   留下来的历史中文名。老项目用 try/catch 兜住非法百分号，手敲 `/a%zz` 会走到这条。
 */
export function brandNoteText(noteId: string): string {
  try {
    return decodeURIComponent(noteId);
  } catch {
    return noteId;
  }
}

/** `(hover: hover) and (pointer: fine)` 的安全读取。老项目 :6490 直读 matchMedia，
 *  但 jsdom/老 WebView 上 matchMedia 可能不存在 —— 那时按"非桌面"处理（显示笔记名）。 */
function isHoverFine(): boolean {
  try {
    return !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  } catch {
    return false;
  }
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
  const brandNote = host.querySelector<HTMLElement>('#brandNote');
  const foot = host.querySelector<HTMLElement>('.ns-foot');
  const dot = host.querySelector<HTMLElement>('#syncDot');
  const syncText = host.querySelector<HTMLElement>('#syncText');
  const skinFx = host.querySelector<HTMLElement>('#skinFx');
  if (!root || !main || !brand || !brandWord || !brandNote || !foot || !dot || !syncText || !skinFx) {
    throw new Error('应用外壳结构不完整：buildShell 与模板不同源');
  }

  /* ---- 移动端顶栏显示笔记名（老项目 index.html:10135-10145）----
   * 🔴🔴 这一段原先**整段缺失**：模板里画了 `<span id="brandNote" class="hidden">`、
   *   CSS 也抄了老项目 :106 的样式，但全仓库没有任何代码给它写值或去掉 hidden
   *   ⇒ 那个 span 永远 display:none，手机端顶栏只有一枚 logo（用户报障第3 条）。
   *
   * 判据必须是 `isNativeApp() || !CHIP_HOVER_OK`，**不能**换成视口宽度判断：
   * 那样「窄窗桌面」会既显示笔记名又被媒体查询藏掉字标，或反之。
   */
  const noteId = cb.noteId ?? '';
  if (shouldShowBrandNote(noteId, isHoverFine(), window.__NOTESYNC_NATIVE__ === true)) {
    brandNote.textContent = brandNoteText(noteId);
    brandNote.classList.remove('hidden');
    // 老项目 :10142-10143 `document.querySelector('header .brand b').style.display='none'`
    // 宽屏时避免「NoteSync + 笔记名」同显；≤560px 时 b 已被 CSS 藏，再设也无副作用。
    brandWord.style.display = 'none';
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
    syncText.textContent = footText(state, detail);
    syncText.className = state === 'offline' ? 'offlinebar' : '';
  };

  setStatus('connecting');
  return { root, editorHost, brand, foot, setStatus, setSkin };
}

/**
 * 浏览器端入口 —— 页面状态机 + Lexical 编辑器 + 主题/皮肤
 *
 * 四个互斥页面（老项目就是这么做的，不引路由库）：
 *   landing 落地页 / pass 口令页 / home 首页提示页 / editor 编辑器
 *
 * 🔴🔴 四条硬纪律（违反任何一条都属于"看起来能跑、实际已漂移"）：
 *   1. **不引 React / 任何 UI 框架**。选 Lexical 的理由是"不重踩 contenteditable 的坑"，
 *      不是"顺手把 React 也带进来"。UI 外壳是顶栏 7 键 + 菜单 11 项 + 落地页，
 *      命令式 DOM 就够；引框架要多背 ~40KB gzip、要处理并发渲染与 Lexical 自己
 *      update 批次的时序冲突 —— 收益远小于代价。
 *   2. **APK 内绝不注册 SW**（见文件头 registerSW）。
 *   3. **行为注册必须在 setRootElement 之后**（见 behaviors.ts，漏了打不了字且零报错）。
 *   4. 折叠开合、皮肤档位、主题手动态**都是 ephemeral UI 态，不进真源**。
 *
 * 页面判定（老项目 URL 规则）：
 *   /                 → landing
 *   /<name> 且 name 是彩蛋保留字 → 彩蛋入口（S8 接）
 *   /<name> 且本机已记住口令 → editor
 *   /<name> 且没有口令     → pass
 *   /<name> 且口令错/数据坏 → pass（**同一句错误文案**，见 ARCH 安全不变量）
 */

import {
  $createRangeSelection,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  createEditor,
  FORMAT_TEXT_COMMAND,
  type EditorState,
  type LexicalEditor,
} from 'lexical';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';

import { APP_VERSION, BUILD_DATE, SCHEMA_VERSION } from './version.ts';
import { registerBehaviors } from './behaviors.ts';
import { insertFoldAtCaret, registerCommands } from './commands.ts';
import { ALL_NODES } from './node-registry.ts';
import { docToLexical, lexicalToDoc } from './serialize.ts';
import { canonicalize, emptyDoc, normalize, resolveKey, type DerivedKey, type Doc } from '@bj/shared-schema';
import { SyncClient } from './sync/client.ts';
import type { SyncState } from './sync/fsm.ts';
import { changePassphrase, lockNote, unlock, unlockIfRemembered } from './sync/unlock.ts';
import { buildHome, buildLanding, buildPass } from './ui/pages.ts';
import { buildShell, type Shell, type TopbarAction } from './ui/shell.ts';
import { COPY } from './ui/copy.ts';
import { buildMenu, type MenuState } from './ui/menu.ts';
import { applyThemeVars, resolveTheme, type SkinName, type ThemeName } from './ui/theme.ts';
import { sanitizeNoteName } from './ui/landing-logic.ts';
import { reconcileReminders, dueReminders } from './reminder/reconcile.ts';
import { ReminderUI } from './reminder/ui.ts';
import { handleImageUpload } from './image/upload.ts';
import { browserStore, favListOf, readFavs, toggleFav, FAVS_MAX } from './fav/favs.ts';
import { buildEggLayer, scanEggTriggers, type EggLayer } from './egg/layer.ts';
import { eggBrowserStore, isEggRoute } from './egg/registry.ts';
import { exportNotePng } from './export/index.ts';
import { buildPairPanel } from './scan/panel.ts';
import { buildScanLayer } from './scan/layer.ts';
import { parsePairLink } from './scan/pair-link.ts';
import type { ScanDiag } from './scan/engine.ts';

declare global {
  interface Window {
    __NOTESYNC_NATIVE__?: boolean;
    __NOTESYNC_BUILD__?: { version: string; date: string; sha: string };
    __NOTESYNC_EDITOR__?: LexicalEditor;
    /** 读取最近一次提交的真源快照（深拷贝）。正式接口，非调试后门。 */
    __NOTESYNC_DOC__?: () => Doc;
    /** 当前页面名（landing / pass / home / editor）。e2e 与 S5 同步都读它。 */
    __NOTESYNC_PAGE__?: () => string;
    /**
     * 在光标处插入折叠块。**正式接口**，不是调试后门：
     * 折叠块是纯编辑器内结构，菜单/快捷键/未来的 MCP 都要走它，
     * e2e 也用它造场景（造场景走生产代码，才不会测一份只有测试才有的路径）。
     */
    __NOTESYNC_INSERT_FOLD__?: () => void;
    /**
     * 真源的 canonical 字节。
     *
     * 🔴 为什么必须暴露它而不是让 e2e 自己 `JSON.stringify`：
     *   canonical 有四条规则（schema 键序、默认值省略、无空格 UTF-8、数组序即文档序），
     *   e2e 手写一份 JSON.stringify 等于**手写第二份实现**，
     *   判出来的"往返无损"是假的（键序不同就判红、键序巧合就对）。
     *   这与本项目"测试判据不许手写第二份实现"的纪律同源。
     */
    __NOTESYNC_CANON__?: (d: Doc) => string;
    /**
     * 用当前真源重建编辑器 —— 等价于"刷新后重新导入"。
     * e2e 用它验往返无损（import → export → import 逐字节相等）。
     */
    __NOTESYNC_RELOAD_FROM_DOC__?: () => void;
    /**
     * 读 Lexical **自己眼里的**选区（不是 DOM 选区）。
     *
     * 🔴 为什么需要这个钩子：折叠收起护栏（$parkCaretOnFoldHead）改的是
     *   **Lexical 选区**，而 e2e 从 `window.getSelection()` 读到的是 **DOM 选区**。
     *   两者在 reconcile 之后可能不一致 —— 只看 DOM 会分不清
     *   「护栏根本没执行」和「护栏执行了但被 Lexical 覆盖回去」。
     *   这个钩子把两边都读出来对比，才能定性到底是哪一层的问题。
     */
    __NOTESYNC_SEL__?: () => {
      lexKey: string | null;
      lexOffset: number | null;
      lexType: string | null;
      collapsed: boolean | null;
      nodeText: string | null;
    } | null;
    /**
     * 打开某个彩蛋门牌（正式接口）。
     * e2e 用它走真实路径进游戏 —— 造场景走生产代码，
     * 才不会测一份只有测试才有的路径。
     */
    __NOTESYNC_EGG_OPEN__?: (id: string) => boolean;
    /** 彩蛋图鉴是否开着（e2e 判图鉴渲染）。 */
    __NOTESYNC_EGG_CODEX__?: () => boolean;
    /** 主动打开图鉴（与 `?eggs` 同一条生产路径）。 */
    __NOTESYNC_EGG_CODEX_OPEN__?: () => void;
    /**
     * 最近一次扫码自检（引擎/帧数/错误摘要）。正式接口。
     * 🔴 只含元信息，**不含扫码内容** —— 码里带着口令。
     */
    __NOTESYNC_SCAN_DIAG__?: () => { engine: string; frames: number; errs: number; result: string } | null;
    /**
     * 解析一个配对链接（生产解析器本体）。正式接口。
     *
     * 🔴🔴 为什么必须暴露它：判"出码能扫通"若在测试里手写一份 URL 解析，
     *   判出来的往返无损是**假的**（URL 的 origin 归一、fragment 边界、
     *   base64url padding 三处最容易分叉，而分叉只在真机上偶发）。
     *   这与 __NOTESYNC_CANON__ 同源：判据不许手写第二份实现。
     *
     * 🔴 只回显判定的**结构**（笔记名 + 口令长度），
     *   不回显口令本身 —— 免得这个钩子变成一个"把口令打印到控制台"的入口。
     */
    __NOTESYNC_PARSE_PAIR__?: (raw: string) => { ok: boolean; noteId?: string; passLen?: number; reason?: string };
    /**
     * Capacitor 全局（App 壳注入）。
     *
     * 🔴 必须声明成宽松形态而不是 `any`：桥对象由壳在运行时塞进来，
     *   编译期无从知道形状；这里只声明本项目**实际用到的那一个方法**，
     *   访问不存在的插件时返回 undefined（而不是崩）。
     */
    Capacitor?: {
      Plugins?: Record<
        string,
        { copyImage?: (o: { base64: string; mime: string }) => Promise<{ ok?: boolean }> }
      >;
    };
  }
}

/** Lexical 主题 class 名。CSS 在 ui/styles.css，节点侧在 nodes.ts，两边必须一致。 */
const THEME = {
  paragraph: 'ns-p',
  quote: 'ns-quote',
  heading: { h1: 'ns-h1', h2: 'ns-h2', h3: 'ns-h3' },
  list: {
    ul: 'ns-ul',
    ol: 'ns-ol',
    listitem: 'ns-li',
    nested: { listitem: 'ns-li-nested' },
  },
  link: 'ns-link',
  text: {
    bold: 'ns-b',
    italic: 'ns-i',
    underline: 'ns-u',
    strikethrough: 'ns-s',
    code: 'ns-c',
  },
} as const;

/* ---------------- 主题 / 皮肤 ---------------- */

/**
 * 🔴 手动主题态是**纯内存态，刻意不写 localStorage** —— 老项目就是这样：
 *   刷新或重新解锁一律回到时间规则（19:00–07:00 夜间）。
 *   写进 localStorage 会被当成"新功能"，首屏颜色就与老项目不一致了。
 */
let manualDark: boolean | null = null;
let currentTheme: ThemeName = 'light';
let currentSkin: SkinName = 'default';
/** 当前外壳引用。皮肤与主题都要经它重绘 —— 两处各写一份判定必然漂移。 */
let shellRef: Shell | undefined;

function repaint(): void {
  applyThemeVars(currentTheme, document.documentElement);
  // 🔴 菜单里的主题项是互斥双文案（夜间模式 / 日间模式）+ 月亮/太阳图标。
  //   不跟着重画就会出现"已经是白天了，菜单还写夜间模式" —— 典型的静默漂移。
  menuState.night = currentTheme === 'dark';
  menuRef?.render();
  shellRef?.setSkin(currentSkin, currentTheme === 'dark');
}

function applyTheme(): void {
  currentTheme = resolveTheme(manualDark, new Date());
  repaint();
}

/* ---------------- 路由 ---------------- */

/** 从 pathname 取笔记名（去掉首尾斜杠、URL 解码）。取不到返回空串。 */
function noteNameFromPath(): string {
  const parts = location.pathname.split('/').filter((p) => p !== '');
  const first = parts[0];
  // 🔴 noUncheckedIndexedAccess 下 parts[0] 是 string | undefined。
  //   这里显式收窄而不是 ! —— 断言会把"以后改了 filter 条件"变成静默 bug。
  if (first === undefined) return '';
  try {
    return decodeURIComponent(first);
  } catch {
    // 🔴 非法百分号编码（手敲 %zz 就会遇到）不能让整页崩，回退到原始片段
    return first;
  }
}

/* ---------------- 路由 ---------------- */

/* ---------------- 提醒：往正文插一行 ---------------- */

/**
 * 🔴 面板打开瞬间的正文选区（老项目 panelSavedSel）。
 *
 * 为什么必须存：面板里的输入框一获焦，编辑器就丢光标；等用户点「添加」时
 * 已经无从知道该往哪插。老项目也是这么做的 —— 打开面板时 `saveSelection()`，
 * 提交时 `restoreSelectionInBlock()` 再插。
 *
 * 用 Lexical 自己的 selection API（$getSelection/$setSelection）而不是 DOM Range：
 * DOM Range 在 reconcile 后就失效了，存下来再 set 会抛 "Unable to find an active
 * editor state"。存 Range 的**序列化形态**（anchor/focus 节点 key + offset）才活得下来。
 */
let panelSavedSel: {
  anchorKey: string;
  anchorOffset: number;
  focusKey: string;
  focusOffset: number;
} | null = null;

function saveEditorSelection(): void {
  const ed = editor;
  if (!ed) return;
  ed.getEditorState().read(() => {
    // 🔴 收窄成 RangeSelection：$getSelection() 的返回类型是 BaseSelection，
    //   它没有 anchor/focus（只有 isCollapsed/getTextContent 等），
    //   不收窄就 TS2339。NodeSelection / GridSelection 的锚点语义完全不同，
    //   硬取 anchor 会拿到 undefined，插行时静默插到文档开头。
    const sel = $getSelection();
    if (!sel || !$isRangeSelection(sel)) {
      panelSavedSel = null;
      return;
    }
    panelSavedSel = {
      anchorKey: String(sel.anchor.key),
      anchorOffset: sel.anchor.offset,
      focusKey: String(sel.focus.key),
      focusOffset: sel.focus.offset,
    };
  });
}

/**
 * 在正文里插入一行提醒文字，并把光标落到它**后面那个空行**的行首
 * （老项目 v7.3.2：连续添加多个提醒时文字不会连在一起）。
 *
 * 🔴 用 `$insertText` 而不是自己拼 TextNode 再 append：
 *   前者走 Lexical 自己的选区更新与撤销栈合并（Ctrl+Z 能一步撤掉整行），
 *   后者要自己处理选区，容易出现"文字插进去了但光标还在原地"。
 */
function insertRemLineToEditor(text: string): void {
  const ed = editor;
  if (!ed) return;
  ed.update(
    () => {
      // 1) 恢复面板打开时的选区。
      //    🔴 用 $getNodeByKey 而不是 ed.getEditorState()._nodeMap：
      //      后者是私有字段，bundled ESM 下改名/压缩即失效，且失败时报
      //      "undefined is not a function" 这种完全指不到错的错。
      if (panelSavedSel) {
        const anchor = $getNodeByKey(panelSavedSel.anchorKey);
        const focus = $getNodeByKey(panelSavedSel.focusKey);
        if (anchor && focus) {
          const sel = $createRangeSelection();
          sel.anchor.set(anchor.getKey(), panelSavedSel.anchorOffset, 'text');
          sel.focus.set(focus.getKey(), panelSavedSel.focusOffset, 'text');
          $setSelection(sel);
        }
      }
      // 2) 插提醒行文字
      //    🔴🔴 用 **RangeSelection.insertText() 实例方法**，不用 $insertText：
      //      实测 0.52 里 $insertText 定义在 lexical/dist/Lexical.dev.js 内，
      //      但**没有从 lexical 的 .d.ts 导出**（typecheck 报 TS2305）；
      //      而 @lexical/selection 只导出 $moveCharacter 之类，也没有它。
      //      实例方法是**公开且有类型**的入口，语义相同（走 Lexical 自己的选区更新
      //      与撤销栈合并，Ctrl+Z 能一步撤掉整行）。
      const sel = $getSelection();
      if (!sel || !$isRangeSelection(sel)) {
        // 🔴🔴 无选区时**追加到文末**，不能直接 return。
        //   探针实测：全新笔记（文档只有一个空段落）从未聚焦过时 $getSelection() 返回 null，
        //   我第一版直接 return —— 于是「面板加的第一条提醒根本没进正文」，
        //   紧接着对账按「正文里找不到时间串」判死，净结果是加了个寂寞。
        //   老项目 insertNodeAtCaret 也是这个语义：无光标就落到末尾。
        const root = $getRoot();
        root.append($createParagraphNode().append($createTextNode(text)));
        root.append($createParagraphNode());
        return;
      }
      sel.insertText(text);
      // 3) 换行 + 再补一个空行（老项目 v7.3.2：连续添加不连行）
      //    🔴 用 insertNodes 而不是自己 append —— 后者不更新选区，
      //      症状是「文字插进去了但光标还在原地」，连续加第二条会插到第一行中间。
      sel.insertNodes([$createParagraphNode()]);
      sel.insertNodes([$createParagraphNode()]);
    },
    { discrete: true },
  );
  panelSavedSel = null;
}

/* ---------------- 应用装配 ---------------- */

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app 不存在：index.html 与本文件不同源');
// 🔴 显式标注成HTMLElement：模块顶层的 throw 窄化传不进下面这些函数体，
//   于是每个 build*(app) 调用点都报一遍"可能是 null" —— 一次收口，别处干净。
const app: HTMLElement = appEl;

let editor: LexicalEditor | undefined;
/** 外壳根节点。同步状态回调要往它身上写 dataset，作用域必须在 mountEditor 之外。 */
let root: HTMLElement | undefined;
let setFootStatus: ((s: 'connecting' | 'synced' | 'offline', d?: string) => void) | undefined;

/* ---- 上传状态条（老项目 showUploadStatus 同款） ---- */

/** 上传提示条的自动收起计时器。🔴 换文案前必须清掉旧的，否则会出现"新文案被旧计时器提前收走"。 */
let uploadNoteTimer: number | undefined;

/**
 * 显示上传状态。
 *
 * 🔴 为什么不用底栏 setStatus：底栏那一行是**同步状态**的位置
 *   （connecting / synced / offline），拿它显示"正在压缩图片"会让用户
 *   以为同步坏了。老项目是独立浮层，这里照搬。
 *
 * @param kind 'doing' 过程 / 'ok' 成功 / 'bad' 失败
 * @param autoHideMs 自动收起毫秒；0 = 常驻（过程态就靠调用方重发覆盖）
 */
function showUploadNote(kind: 'doing' | 'ok' | 'bad', text: string, autoHideMs: number): void {
  let el = document.getElementById('uploadNote');
  if (!el) {
    el = document.createElement('div');
    el.id = 'uploadNote';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  // 🔴 走 textContent，不走 innerHTML：文案里含用户文件名/云端返回的原因，
  //   一旦有尖括号就是注入面（S4 已立的 XSS 收口口径）。
  el.textContent = text;
  el.dataset.kind = kind;
  if (uploadNoteTimer !== undefined) {
    clearTimeout(uploadNoteTimer);
    uploadNoteTimer = undefined;
  }
  if (autoHideMs > 0) {
    uploadNoteTimer = window.setTimeout(() => {
      el?.remove();
      uploadNoteTimer = undefined;
    }, autoHideMs);
  }
}

function hideUploadNote(): void {
  if (uploadNoteTimer !== undefined) {
    clearTimeout(uploadNoteTimer);
    uploadNoteTimer = undefined;
  }
  document.getElementById('uploadNote')?.remove();
}

/**
 * 隐藏的 file input —— 图片选择的唯一入口。
 *
 * 🔴 为什么藏在 DOM 里而不是 `input.click()` 临时造一个：
 *   iOS Safari 对**用户手势链外**的 input.click() 会直接忽略，
 *   症状是"点上传没反应且零报错"。挂在 DOM 里有两个好处：
 *   ① 手势链完整（点在按钮上 → 按钮 handler 内 click 它，仍在手势内）；
 *   ② accept 属性让系统直接给"照片"选择器而不是文件管理器。
 */
let uploadInput: HTMLInputElement | undefined;

/**
 * 建立（并记住）隐藏的 file input。
 *
 * 🔴🔴 必须是**启动即建**，不能等点上传按钮才建。
 *   我第一版挂在 pickImage() 里懒创建，e2e 一跑就报「未找到 nsUploadInput」——
 *   而这不只是测试问题：**懒创建意味着「第一次点击必须成功」**，
 *   一旦那次 appendChild 失败（或被扩展/内核拦了一次），按钮就永久是死的，
 *   且症状是"点了没反应零报错"。
 *   提前建好 = 第一次点击与第 n 次点击走完全同一条路径。
 */
function ensureUploadInput(): HTMLInputElement {
  if (uploadInput) return uploadInput;
  const el = document.createElement('input');
  el.type = 'file';
  el.accept = 'image/*';
  el.id = 'nsUploadInput';
  // 必须藏起来但**不能 display:none** —— display:none 的 input 在部分
  // 内核里不可点击（等于死按钮）。用视觉隐藏，保留可交互性。
  el.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
  el.addEventListener('change', () => {
    const f = el.files?.[0];
    // 🔴 必须清空 value：同一个文件连选两次，第二次不触发 change
    //   （value 没变），用户会以为"点了没反应"。
    el.value = '';
    const ed = editor;
    if (!f || !ed) return;
    void handleImageUpload(f, ed, {
      noteId: currentNote,
      base: location.origin,
      onStatus: (m) => showUploadNote('doing', m, 0),
      onOk: () => showUploadNote('ok', COPY.uploadOk, COPY.uploadOkMs),
      onError: (m) => showUploadNote('bad', m, COPY.uploadFailMs),
    }).then((ok) => {
      // 🔴 成功才收键盘：失败时图片没插进去，编辑器还该留着继续用。
      //   判据用 handleImageUpload 的**返回值**，不是"看提示条是什么态"——
      //   后者在两个提示同屏、或提示条已被收起计时器删掉时就不成立了。
      if (ok) dismissKeyboardForTouch();
    });
  });
  document.body.appendChild(el);
  uploadInput = el;
  return el;
}

function pickImage(): void {
  // 🔴 开选前先收掉上一条提示：上一条失败提示还挂着（4.5 秒驻留）时
  //   又发起新上传，两条提示会在同一位置叠着、互相盖住失败原因。
  hideUploadNote();
  ensureUploadInput().click();
}

/**
 * 触屏下收起软键盘。
 *
 * 🔴 移植自老项目 v9.5.1 `dismissKeyboardForTouch`：
 *   blur 是唯一能让移动端键盘收起的可靠手段（设 readonly 那些花招在
 *   新版 WebKit 上已失效）。但**桌面端不能 blur** ——
 *   用户正在打字时误触图片上传，编辑器一失焦、光标就丢了。
 *   判据用「粗指针 + 无精确指针」，即 (hover: none) 且 (pointer: coarse)。
 */
function dismissKeyboardForTouch(): void {
  try {
    if (!window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  } catch {
    // 收起键盘失败绝不影响主流程
  }
}

/**
 * 原生桥：复制图片到系统剪贴板。
 *
 * 🔴 为什么需要它（老项目 v7.7.0 血泪）：Android WebView 对
 *   `navigator.clipboard.write` 写图片**长期不可用**，而导出长图的主要场景
 *   就是手机。这条桥是那条路上唯一确定性的出口。
 *
 * 🔴 桥不存在时返回 false 而不是抛错：调用方会继续往下走分享/预览阶梯，
 *   抛错会把整条回退链断掉（症状是"有原生桥的机器上分享面板也不弹了"）。
 */
async function nativeCopyImage(base64: string, mime: string): Promise<boolean> {
  try {
    const br = window.Capacitor?.Plugins?.ImgClip;
    if (!br || typeof br.copyImage !== 'function') return false;
    const res = await br.copyImage({ base64, mime });
    return res?.ok === true;
  } catch {
    return false;
  }
}

let currentPage = 'boot';
let currentNote = '';

/**
 * 本次会话用过的口令（**只在内存里**，不落盘、不进 localStorage）。
 *
 * 🔴🔴 为什么需要它：新项目的 CryptoKey 是 extractable:false，**物理上导不出**，
 *   所以出配对码时拿不到"另一台设备需要的那件东西"。那件东西就是口令本身
 *   （见 scan/pair-link.ts 的架构分叉说明）。
 *
 * 🔴🔴 为什么放内存而不是 localStorage：
 *   老项目把 raw key 写进 localStorage，XSS 一次就能拿走并离线解开全部历史密文，
 *   改口令也救不回来（历史密文已被解开）。新项目不能为了"出码方便"再开后门。
 *   内存副本的暴露窗口 = 本次页面会话，且不跨刷新；XSS 当场能读，
 *   但要长期窃取必须每次会话都注入 —— 与"密钥永不可导出"的口径一致。
 *
 * 🔴 锁定时必须清（见 menuLock 分支）。不清的话"退出锁定"就是假的，
 *   用户以为清干净了，实际上点配对码还是能出。
 */
let sessionPass = '';

/** 供配对码用；锁定后为 ''。 */
function passForPair(): string | null {
  return sessionPass === '' ? null : sessionPass;
}

/** 收藏态与链接打开方式是**本机偏好**（老项目：仅对本机生效），存 localStorage。 */
const prefKey = (k: string): string => `notesync_bj_pref_${k}`;
function readPref(k: string, dflt: string): string {
  try {
    return localStorage.getItem(prefKey(k)) ?? dflt;
  } catch {
    return dflt;
  }
}
function writePref(k: string, v: string): void {
  try {
    localStorage.setItem(prefKey(k), v);
  } catch {
    /* 存不下就本次会话内有效 */
  }
}

const menuState: MenuState = {
  // 🔴 进编辑器时就要算好"这篇是否已收藏"：菜单是打开时才渲染的，
  //   而收藏项是互斥双文案 —— 状态没喂进去的话，用户会看到「收藏笔记」
  //   点一下却变成「取消收藏」，第一次点像是没用。
  faved: false,
  night: false,
  linkInApp: readPref('linkInApp', '1') === '1',
  favList: [],
  histList: [],
  conflicts: [],
};

/** 收藏的localStorage 口。老项目是纯本机键（notesync_favs），本项目独立前缀。 */
const favStore = browserStore();

/** 彩蛋层。懒建于第一次需要时（门牌/图鉴/触发点），不进编辑器就不建。 */
let eggLayer: EggLayer | undefined;

/**
 * 懒建彩蛋层。
 *
 * 🔴 为什么懒建：彩蛋层会往 body 上挂粒子 canvas 与徽章。
 *   用户只是打开一篇笔记去写字，不该为此付出一次 DOM 构建。
 */
function ensureEggLayer(): EggLayer | undefined {
  if (eggLayer) return eggLayer;
  try {
    eggLayer = buildEggLayer(app, eggBrowserStore(), {
      bodyText: () => {
        // 🔴 只给**纯文本**：游戏只是抽词当素材，不该看到真源结构。
        const st = editor?.getEditorState();
        let out = '';
        st?.read(() => {
          out = $getRoot().getTextContent();
        });
        return out;
      },
      favs: () => readFavs(favStore),
      curNote: () => currentNote,
      refocus: () => {
        // 图鉴/游戏关闭后把焦点还给编辑器（老项目红线10：桌面失焦光标不绘制）
        try {
          editor?.focus();
        } catch {
          /* 归还焦点失败不影响使用 */
        }
      },
      onGameClosed: () => {
        // 🔴 门牌路径（/snake）进游戏时落地页从未渲染过，退出后不重画就是空白页。
        //   currentPage==='egg' 正是"这局是靠门牌开的"的唯一可靠证据 ——
        //   菜单里开桌宠时 currentPage 是 'editor'，那里什么都不用做。
        if (currentPage !== 'egg') return;
        // 🔴 顺手把地址栏拉回 '/'：门牌路径的外壳是"同址 pushState"，
        //   close() 判定 pathname 没变就不还原 —— 于是留在 /snake 上，
        //   用户一刷新又被弹回游戏。回落地页却留着游戏URL，是最难查的一类"幽灵状态"。
        try {
          history.replaceState({}, '', '/');
        } catch {
          /* file:// 等极端环境没有 history，落地页照常显示 */
        }
        showLanding();
        goto('landing');
      },
    });
    eggLayer.bindTriggers();
    return eggLayer;
  } catch (e) {
    // 🔴 彩蛋层坏掉绝不能连带笔记不可用：它是娱乐层，不是数据层
    console.warn('[notesync] 彩蛋层初始化失败（不影响笔记）', e);
    eggLayer = undefined;
    return undefined;
  }
}

// 🔴🔴 正式 e2e 钩子：**在模块作用域注册**，不挂在 ensureEggLayer 里面。
//   挂在里面的话，钩子只在那次懒建之后才存在 —— 于是"编辑器里直接调
//   __NOTESYNC_EGG_OPEN__('snake')"拿到 undefined，而调用方看到的是
//   "is not a function"，完全指不到真正的原因（层还没建）。
//   钩子本身就是懒的：被调时才 ensureEggLayer，语义不变但始终可调。
window.__NOTESYNC_EGG_OPEN__ = (id: string): boolean => ensureEggLayer()?.openByRoute(id) ?? false;
window.__NOTESYNC_EGG_CODEX__ = (): boolean => eggLayer?.codexOpen() ?? false;
window.__NOTESYNC_EGG_CODEX_OPEN__ = (): void => {
  ensureEggLayer()?.openCodex();
};

let menuRef: ReturnType<typeof buildMenu> | undefined;

function goto(page: string): void {
  currentPage = page;
  window.__NOTESYNC_PAGE__ = () => currentPage;
}

/**
 * 顶栏 7 键的处理器。
 *
 * 🔴 S4 只做两件事：把删除线这类**纯编辑器内**的操作接上，
 *   其余（图片、复制、导出、扫码、二维码）分别属于 S5/S6。
 *   未接的键**不弹"敬请期待"** —— 那是老项目没有的文案，用户会以为是坏了；
 *   静默无反馈也不行（用户会反复点），所以在底栏给一行短状态。
 */
function onTopbar(act: TopbarAction): void {
  const ed = editor;
  switch (act) {
    case 'strike': {
      if (!ed) return;
      // 🔴🔴 必须用**公开**的 FORMAT_TEXT_COMMAND，不能自己拼 payload 调 dispatchCommand：
      //   富文本命令的 payload 形态是包内约定，0.52 起还多了 Extension 体系，
      //   写死会静默失效（不报错、不生效、单元测试也测不出来）。
      //   FORMAT_TEXT_COMMAND 的语义就是"切换"，与老项目顶栏删除线一致。
      ed.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough');
      return;
    }
    case 'remind': {
      // 顶栏铃铛 = 打开提醒面板（老项目同一入口）
      reminderRef?.togglePanel();
      return;
    }
    case 'upload': {
      // 顶栏上箭头 = 选图上传（老项目同一入口）
      pickImage();
      return;
    }
    case 'exportImg': {
      // 🔴 必须判编辑器在不在：顶栏在编辑器卸载后仍留在 DOM 里，
      //   此时点导出会 buildCard(null) 抛 TypeError，症状是"退出后误点顶栏就报错"。
      const host = document.getElementById('editor-host');
      if (!ed || !host) {
        setFootStatus?.('offline', COPY.exportNoEditor);
        return;
      }
      void exportNotePng({
        editorHost: host,
        noteId: currentNote,
        brandSvg: document.querySelector('#brandMark svg'),
        dismissKeyboard: () => dismissKeyboardForTouch(),
        onStatus: (kind, text, autoHideMs) => {
          // 🔴 复用上传状态条而不是底栏：底栏那一行是同步状态的位置，
          //   拿来显示"正在生成图片"会让用户以为同步坏了（老项目同款口径）。
          showUploadNote(kind, text, autoHideMs);
        },
        isNativeApp: window.__NOTESYNC_NATIVE__ === true,
        nativeCopyImage,
        okMs: COPY.exportOkMs,
        failMs: COPY.exportFailMs,
      });
      return;
    }
    case 'scan': {
      // 🔴 收键盘：光标在笔记内点扫一扫不弹软键盘（老项目 v7.5.1 口径）。
      dismissKeyboardForTouch();
      openScanner();
      return;
    }
    case 'qr': {
      dismissKeyboardForTouch();
      // 🔴 顶栏在编辑器卸载后仍留在 DOM 里，出码必须判当前笔记在不在 ——
      //   否则 buildPairLink 会出指向空篇名的码，扫过去是「打不开」。
      if (!currentNote || currentPage !== 'editor') {
        setFootStatus?.('offline', COPY.pairNoKey);
        return;
      }
      buildPairPanel({
        passphrase: passForPair(),
        noteId: currentNote,
        origin: location.origin,
        onClosed: () => {
          // 🔴 关闭必须归还焦点（老项目红线）：否则用户关掉弹窗后
          //   光标停在 body 上，接着敲键盘什么都不会发生。
          const host = document.getElementById('editor-host');
          if (host) {
            try {
              host.focus();
            } catch {
              /* 极端环境无 focus */
            }
          }
        },
      });
      return;
    }
    default:
      setFootStatus?.('connecting');
      return;
  }
}

/**
 * 挂载编辑器。
 * 🔴 `initial` 必须由调用方给**已解密**的文档，绝不能在这里再自己去拉 ——
 *   解密是异步的，在 mountEditor 内部拉会出现"编辑器先显示空的，
 *   稍后内容才闪进来"的中间态，而用户在这半秒内打字就会被打断。
 */
function mountEditor(name: string, initialDoc?: Doc): void {
  currentNote = name;
  // 🔴 收藏态与收藏夹列表必须在**挂菜单之前**算好：菜单是打开时读这两个值的，
  //   留到 onMenu 回调里算就晚了（那时 innerHTML 已经渲染完，用户会先看到
  //   「收藏笔记」点一下才变「取消收藏」）。
  menuState.faved = readFavs(favStore).indexOf(name) >= 0;
  menuState.favList = favListOf(favStore);

  const shell = buildShell(app, {
    onTopbar: (act) => void onTopbar(act),
    onMenu: () => {
      // 打开前重算一次：可能在别的笔记里加过收藏（换设备/开两个标签）
      menuState.faved = readFavs(favStore).indexOf(name) >= 0;
      menuState.favList = favListOf(favStore);
      menuRef?.open();
    },
    onRefresh: () => location.reload(),
    onSkin: (skin) => {
      currentSkin = skin;
      shellRef?.setSkin(skin, currentTheme === 'dark');
    },
  });
  shellRef = shell;
  setFootStatus = shell.setStatus;
  // 首屏就把皮肤摆对（default 档也要调一次：清空残留纹路）
  shell.setSkin(currentSkin, currentTheme === 'dark');

  // 菜单面板挂在 shell 之后（同一宿主内，用fixed 定位，互不影响）
  menuRef = buildMenu(app, menuState, {
    onClose: () => menuRef?.close(),
    onHome: () => {
      history.pushState({}, '', '/');
      route();
    },
    onToggleFav: () => {
      // 🔴 收藏是**本机键**（不进真源、不同步）—— 老项目 v5.55 拍板。
      //   收藏表达"这台设备上我常看哪几篇"，塞进真源会让两台设备互相覆盖。
      const r = toggleFav(favStore, name);
      menuState.faved = r.faved;
      //🔴 收藏夹列表必须同刻重算：老项目 toggle 后立刻 writeFavs，
      //   而收藏夹视图若还读旧缓存，进去会看到刚才取消的那条还在。
      menuState.favList = favListOf(favStore);
      // 超上限时如实告知挤掉了谁 —— 不说的话用户查不到自己刚收藏的
      if (r.evicted !== null) {
        setFootStatus?.('synced', COPY.favFull(FAVS_MAX));
      }
    },
    onOpenFav: (n) => {
      location.href = '/' + encodeURIComponent(n);
    },
    onSaveHist: () => {
      // S5 接真源后落历史版本；S4 先给明确的空态反馈而不是静默无响应
      menuState.histList = [
        { at: new Date().toISOString().slice(0, 16).replace('T', ' '), label: '（S5 接入后可用）' },
        ...menuState.histList,
      ];
    },
    onOpenHist: () => {
      /* 历史版本回滚在 S5 接真源后开放 */
    },
    onLinkMode: (inApp) => {
      menuState.linkInApp = inApp;
      writePref('linkInApp', inApp ? '1' : '0');
    },
    onBackup: () => {
      location.href = '/backup';
    },
    onPet: () => {
      // 🔴 桌宠是**彩蛋门牌**（老项目：菜单「桌宠」直接进 /pet），
      //   不跳路由：走 openByRoute 才能复用游戏外壳与音效。
      ensureEggLayer()?.openByRoute('pet');
    },
    onToggleTheme: () => {
      // 🔴 手动切换是**内存态，刻意不写 localStorage**（老项目行为）：
      //   刷新或重新解锁一律回到时间规则。写进存储就等于给老项目加了个它没有的功能。
      manualDark = currentTheme === 'dark' ? false : true;
      applyTheme();
    },
    onChangePass: () => {
      // 重设口令：真走换密钥（解旧密文 → 用新口令重加密 → 推上去 → 换本机密钥）。
      // 🔴 绝不能只清个"记住"标记了事 —— 那样用户下次进来会被要求输新口令，
      //   而云端还是旧口令的密文，于是**这篇笔记从此再也解不开**。
      void doChangePassphrase();
    },
    onLock: () => {
      // 锁定 = 只清本机密钥与缓存，云端数据不动（老项目行为）。
      // 🔴🔴 必须先清会话口令。锁定的语义是"这台设备不再持有任何凭据"，
      //   而口令留在内存里的话，配对码还能照出 —— 用户以为锁了，
      //   实际上任何能操作这台机器的人扫一下屏幕就能拿走口令。
      sessionPass = '';
      void lockNote(name).then(() => location.reload());
    },
    onAbout: () => {
      location.href = '/about';
    },
    onKeepLocal: () => {
      // 保留本机：把当前内容推上去，覆盖云端。
      // 🔴 必须走 sync 客户端而不是直接 POST：它持有 base，
      //   直接推会让下次三方合并的祖先错位。
      syncRef?.resolveKeepLocal();
    },
    onKeepRemote: () => {
      // 保留云端：丢弃本机改动。
      //🔴 这一步是**破坏性**的（用户本机输入的字会消失），
      //   所以必须由用户显式点选，不能由程序自动裁决。
      syncRef?.resolveKeepRemote();
    },
  });

  const { root: shellRoot, editorHost } = shell;
  shellRoot.dataset.note = name;
  shellRoot.dataset.version = APP_VERSION;
  shellRoot.dataset.schema = String(SCHEMA_VERSION);
  shellRoot.dataset.build = BUILD_DATE;
  // 🔴 root 提到模块级：同步状态的回调（onSnapshot）要写 root.dataset.syncState，
  //   而那个回调在 mountEditor 之外触发。留在局部会直接 ReferenceError，
  //   且只在这条路径上炸 —— 表现为"底栏不更新"，与状态机无关。
  root = shellRoot;

  const ed = createEditor({
    namespace: 'NoteSyncBJ',
    theme: THEME,
    // 🔴 必须给全量清单（内置 + 自定义），少一个就在运行时抛
    //   "Attempted to create node X that was not configured"，症状是整篇文档变空
    nodes: [...ALL_NODES],
    onError(e: Error) {
      // 不吞异常：空白页类故障的取证入口就是这里
      console.error('[notesync] editor error', e);
    },
  });

  ed.setRootElement(editorHost);
  // 🔴🔴 行为注册必须在 setRootElement 之后、任何 update 之前。
  //   漏掉它 = 编辑器能显示但打不了字，且**零报错**（详见 behaviors.ts 文件头）。
  registerBehaviors(ed);
  // 🔴 自定义命令（插入折叠块等）也要注册。漏掉的表现是
  //   「菜单点了没反应、零报错」—— dispatchCommand 进了没有监听者的黑洞，
  //   与文件头behaviors.ts 记的 registerRichText 那条P0 是同一个形状。
  registerCommands(ed);

  /* ---- 提醒层接线 ---- */
  // 🔴 对账必须发生在 docToLexical **之前**：对账会把提醒的 rem 标记挂到
  //   正文的 span 上，而序列化是按 span.rem 渲染下划线的。
  //   顺序反了 ⇒ 首屏正文没有下划线，要等下一次 update 才补上（闪一下）。
  const reconciled = reconcileReminders(initialDoc ?? emptyDoc());
  const initial = reconciled.doc;

  reminderRef?.destroy();
  reminderRef = new ReminderUI({
    getDoc: () => latestDoc,
    setDoc: (d) => {
      // 🔴🔴🔴 只写 reminders，**绝不整体替换文档**。
      //
      //   探针实测（zz-probe）：面板加提醒后 `编辑器文本 = ""`、真源 `{"v":1}`。
      //   根因是我原来写的 `docToLexical(d)` —— 它 `root.clear()` 后按 blocks 重建整棵树。
      //   而面板流程是「先 insertLine 插正文行、再 setDoc 写 reminders」，
      //   第二次调用把刚插进去的那一行**连同光标一起冲掉**，
      //   于是正文空、时间串消失，紧接着对账按「正文里找不到时间串」把提醒判死。
      //   净结果：面板正常收起、服务器确实收到了一次推送，**但什么都没存下来**，
      //   界面上零报错。这是本项目最危险的一类故障（看起来成功、实际丢数据）。
      //
      //   reminders 是**真源字段**，而 Lexical 树里只有 span.rem 标记、没有提醒列表，
      //   所以它天然是「树外」的数据：改它不需要动树。
      //   正确做法：先把新 reminders 记进 latestDoc，再让**下划线标记**由对账写回树里。
      latestDoc = d;
      // 立刻把 rem 标记铺到正文（对账只改标记，不动用户输入）
      const marked = reconcileReminders(d);
      latestDoc = marked.doc;
      editor?.update(
        () => {
          docToLexical(marked.doc);
        },
        { discrete: true },
      );
    },
    onPanelToggle: () => reminderRef?.togglePanel(),
    insertLine: (text) => insertRemLineToEditor(text),
    saveSelection: () => saveEditorSelection(),
  });

  let latestDoc: Doc = initial;

  // 🔴 必须在 docToLexical 之前挂监听：initial 那一次 update 也要留下快照，
  //   否则首次 commit 之前 latestDoc 停在空文档，e2e 读到的是"从未提交过"的假象。
  ed.registerUpdateListener(({ editorState }: { editorState: EditorState }) => {
    // 🔴 state.read() 回调外节点句柄失效 —— 整段导出必须在回调内部完成
    const before = latestDoc;
    // 🔴🔴🔴 导出基准的 reminders 必须来自 **latestDoc**（可能是刚被 setDoc 写进去的新值），
    //   不能来自"上一次提交时的旧值"，也不能来自任何缓存副本。
    //
    //   reminders 是**真源字段**，而 Lexical 树里只有 span.rem 标记，没有"提醒列表"这个概念
    //   —— 也就是说导出时必须由外部把这份列表喂进来。喂哪一份是这一行唯一的关键：
    //
    //   我第一版喂的是 `before`（= 上一次 update 结束时的 latestDoc），看着"稳"，实际：
    //     用户在面板点添加 → setDoc(新 reminders) → docToLexical → 触发本监听
    //     → 导出拿旧 reminders（空）→ 对账把新提醒判死 → latestDoc 回到空
    //   症状：面板正常收起、UI 一切正常，**只有提醒列表永远是空的**，零报错。
    //
    //   正确口径：latestDoc 是唯一真源快照，setDoc 已同步更新过它，
    //   所以直接用 latestDoc.reminders 即可。
    //
    // 🔴🔴 每次导出后**立刻对账**：用户改完正文，对账要马上算出提醒的增删，
    //   并把下划线 / 删除线挂回 span。漏了这一步的症状是"改了时间，提醒列表不变"，
    //   而界面上没有任何提示 —— 与"对账算错了"表现完全一样，极难自查。
    const exported = normalize(lexicalToDoc(editorState, latestDoc.reminders ?? []));
    const rec = reconcileReminders(exported);
    latestDoc = rec.doc;
    shellRoot.dataset.lastDocBytes = String(new TextEncoder().encode(JSON.stringify(latestDoc)).length);

    // 对账可能改了 rem 标记（正文没变但标记变了）→ 此时必须把结果写回编辑器，
    //   否则下划线永远不显示。判据是 canonical 不等：写回自身不会引起无限循环，
    //   因为第二次对账拿到已带标记的文档，算出的结果与自身相同。
    if (canonicalize(rec.doc) !== canonicalize(exported)) {
      const snapshot = latestDoc;
      ed.update(() => {
        docToLexical(snapshot);
      }, { discrete: true });
    }

    // 对账报出的增删要通知 UI：新增的排进调度，删掉的从调度里消失
    if (rec.added.length > 0 || rec.removed.length > 0) reminderRef?.schedule();

    // 🔴 彩蛋条件触发（数字梗 / notesync 烟花）。
    //   判据跑在**已提交的真源文本**上，不是按键事件上 ——
    //   按键时输入法还在组字，拿到的是半截文本，会漏判也会误判。
    if (eggLayer) scanEggTriggers(eggLayer, latestDocText());

    // 🔴 只有内容真变了才推。
    //   少了这个判断：docToLexical 的首次 update、以及 merge 把远端内容写回来时，
    //   都会触发一次"编辑"，于是**刚拉下来的内容立刻被推回去** ——
    //   两台设备会互相回声，永不停歇，且服务端被打满。
    if (canonicalize(latestDoc) !== canonicalize(before)) syncRef?.noteEdit();
  });

  ed.update(() => docToLexical(initial), { discrete: true });

  // 暴露真源读取口。**这不是调试后门**：S5 的加密入口、S4 的自动保存、
  // 以及 e2e 的「输入是否真进了真源」判据都走它，是正式接口的一部分。
  window.__NOTESYNC_DOC__ = (): Doc => structuredClone(latestDoc);
  window.__NOTESYNC_EDITOR__ = ed;
  window.__NOTESYNC_INSERT_FOLD__ = () => {
    if (ed) insertFoldAtCaret(ed);
  };
  // 🔴 复用生产代码那份 canonicalize，不给测试第二份实现
  window.__NOTESYNC_CANON__ = (d: Doc): string => canonicalize(d);
  window.__NOTESYNC_RELOAD_FROM_DOC__ = () => {
    const snapshot = structuredClone(latestDoc);
    ed.update(
      () => {
        docToLexical(snapshot);
      },
      { discrete: true },
    );
  };
  // 🔴 只读探针：把 Lexical 侧选区读出来，供 e2e 与 DOM 选区对照。
  //   必须在 editor.getEditorState().read(...) 里读 —— 选区是 editor state 的一部分，
  //   在 update 之外直接 $getSelection() 拿不到（会抛或返回 null）。
  window.__NOTESYNC_SEL__ = () => {
    const state = ed.getEditorState();
    let out: ReturnType<NonNullable<Window['__NOTESYNC_SEL__']>> = null;
    state.read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      out = {
        lexKey: String(sel.anchor.key),
        lexOffset: sel.anchor.offset,
        lexType: sel.anchor.type,
        collapsed: sel.isCollapsed(),
        nodeText: sel.anchor.getNode().getTextContent(),
      };
    });
    return out;
  };
  editor = ed;
  goto('editor');

  /* ---- 提醒：补弹 + 起调度 ---- */
  // 🔴🔴 补弹（catch-up）：老项目 v6.3 起"过期静默，无补弹"指的是**不重复响**，
  //   但下次打开时必须提示已过的提醒 —— 顶栏 title 原文就写着
  //   「提醒（到点通知或下次打开提示）」，这后半句就是指这个。
  //   所以这里补弹，但**只弹卡、不响铃**（不响铃才叫"提示"而不是"惊吓"）。
  //   判据用 dueReminders（未完成 + at <= now），已完成的永远不补弹。
  const missed = dueReminders(initial).filter((r) => !r.done);
  if (missed.length > 0) {
    window.setTimeout(() => reminderRef?.showCard(missed, true), 500);
  }
  // 起调度。到点由 schedule() 自己算下一条并重排。
  reminderRef?.schedule();

  // 🔴🔴 同步在首次 update **之后**才启动。
  //   顺序反了会怎样：start() 立刻 pull → setDoc(远端) → 触发 update → noteEdit()
  //   → 把刚拉下来的内容当成"用户刚编辑的"推回去。两台设备互相回声，永不停歇。
  //   这就是上面那个 canonicalize 比较存在的原因：即便顺序变了也不会误推。
  void startSyncFor(name);
}

/** 当前笔记的同步实例。切笔记时必须先 stop()，否则旧实例的 SSE 还在跑。 */
let syncRef: SyncClient | undefined;

/** 当前笔记的提醒 UI。切笔记时必须先 destroy()，否则旧 chip/卡片/面板留在页面上，
 *  而它们的调度器还持有旧文档 ⇒ 上一篇笔记的提醒会在这一篇里炸出来。 */
let reminderRef: ReminderUI | undefined;

/**
 * 同步状态（9 态）→ 底栏（3 态）。
 * 🔴 这个映射必须**穷举**且有 default 兜底：状态机加了新状态而这里没跟上时，
 *   TypeScript 会因为 switch 不完整而报错（好）；但如果这里改成 if 链或断言成any，
 *   新状态就会静默落到"看起来正常"的分支上 —— 底栏显示"已同步"而实际正在推送。
 *   所以：switch + 每个 case 显式 return + default 兜底成connecting（最保守）。
 */
function footFor(s: SyncState): { s: 'connecting' | 'synced' | 'offline'; d?: string } {
  switch (s) {
    case 'idle':
      return { s: 'synced' };
    case 'offline':
      return { s: 'offline', d: '离线中，改动会在恢复后自动同步' };
    case 'conflict':
      return { s: 'offline', d: '两台设备改了同一处，正在等你选保留哪一份' };
    case 'dirty':
    case 'pushing':
      return { s: 'connecting', d: '正在保存' };
    default:
      return { s: 'connecting' };
  }
}

async function startSyncFor(name: string): Promise<void> {
  syncRef?.stop();
  syncRef = undefined;
  const dk = await deriveKeyFor(name);
  if (!dk) {
    // 拿不到密钥（理论上不该发生：能进编辑器就说明解锁成功过）
    setFootStatus?.('offline', '本机密钥不可用，请刷新页面');
    return;
  }
  const c = new SyncClient({
    noteId: name,
    key: dk.key,
    dk,
    getDoc: () => window.__NOTESYNC_DOC__?.() ?? emptyDoc(),
    setDoc: (d) => {
      // 远端/合并结果写回编辑器。**必须包在 update 里**，
      // 直接改 Lexical 内部状态会在渲染之外改文档，症状是"内容变了但重绘没跟上"。
      editor?.update(() => {
        docToLexical(d);
      }, { discrete: true });
    },
    onSnapshot: (s) => {
      const f = footFor(s.state);
      setFootStatus?.(f.s, f.d);
      if (root) root.dataset.syncState = s.state;
      if (s.state === 'conflict') showConflictHint();
    },
    onError: (msg) => {
      setFootStatus?.('offline', msg);
    },
  });
  syncRef = c;
  await c.start();
  // 🔴 新笔记：解锁时拿到的是空文档且云端也没有，必须立刻推一次，
  //   否则"这篇笔记存在"这件事只存在于本机 —— 换台设备输入同一口令，
  //   服务端返回 200 空体，会被当成另一篇新笔记，用户以为自己记的两篇笔记丢了。
  if (pendingFresh) {
    pendingFresh = false;
    c.noteEdit();
  }
}

/** 本次解锁是否为首建（需要首推）。 */
let pendingFresh = false;

/**
 * 真源的纯文本（给彩蛋层抽词用）。
 *
 * 🔴 只给**纯文本**，绝不给真源结构：游戏只是拿词当素材
 *   （砖面字/ 蛇身 / 基地名），把 reminders、rem 标记这些喂进去
 *   没有意义，且会让"游戏能改真源"这个不该有的可能性看起来存在。
 */
function latestDocText(): string {
  const d = window.__NOTESYNC_DOC__?.();
  if (!d) return '';
  const parts: string[] = [];
  const walk = (bs: Doc['blocks']): void => {
    for (const b of bs ?? []) {
      for (const s of b.spans ?? []) parts.push(s.t);
      if (b.title) for (const s of b.title) parts.push(s.t);
      if (b.text) parts.push(b.text);
      if (b.children) walk(b.children);
      parts.push('\n');
    }
  };
  walk(d.blocks);
  return parts.join('');
}

async function deriveKeyFor(name: string): Promise<DerivedKey | undefined> {
  const rec = await resolveKey(name);
  if (!rec) return undefined;
  return { key: rec.key, saltB64: rec.salt, iter: rec.iter };
}

/**
 * 扫码结果落地 —— 不管从哪一级引擎扫出来的，都只走这一个入口判定。
 *
 * 🔴🔴 落地方式刻意**不**用 `location.assign(dest)`（老项目做法）：
 *   那是把口令塞进 URL 后整页重载 —— 口令一旦进地址栏，就会进浏览器历史、
 *   进"最近访问"、可能被同步到别的设备。这里改成**原地 unlock()**：
 *   口令只经过内存，落地后 URL 保持干净。
 *   代价是要走完整的解锁链路（派生 + 解密远端），与手输口令完全同一条 ——
 *   这正是要的：一条路径，一种失败语义。
 */
async function handleScanRaw(raw: string): Promise<void> {
  // 🔴 解析**只经由** resolveScan 一处，落地路径与 e2e 钩子共用它。
  //   两处各写一遍判定的话，改了一边就会表现为
  //   "钩子说能解、实际扫进去说口令不对" —— 极难自查。
  const { parsed, shape } = resolveScan(raw);
  if (!parsed.ok || !shape.ok || !parsed.link || !shape.noteId) {
    scanFeedback(COPY.scanNotPair, COPY.scanOkMs);
    return;
  }
  const { noteId, passphrase } = parsed.link;
  showUploadNote('doing', COPY.pairLanded, 0);
  const r = await unlock({ noteId, passphrase });
  if (!r.ok) {
    // 🔴🔴 与手输口令**同一句文案**（ARCH 安全不变量）：
    //   这里绝不能因为"是从二维码来的"就换成更具体的原因 ——
    //   那等于给暴力破解一个 oracle。
    showUploadNote('bad', r.message, COPY.uploadFailMs);
    scanFeedback(r.message, COPY.scanOkMs);
    return;
  }
  sessionPass = passphrase;
  pendingFresh = r.fresh;
  // 🔴 落地后把地址栏拉正：扫码时用户可能停在任意页（落地页/别的笔记），
  //   挂载编辑器却不改 URL，刷新一下会回到原来那页 —— 看着像"内容自己跑了"。
  history.replaceState({}, '', '/' + encodeURIComponent(noteId));
  mountEditor(noteId, r.doc);
}

/**
 * 最近一次扫码自检。
 * 🔴 挂到 window 是**正式接口**，不是调试后门：e2e 要靠它判"走了哪条引擎、
 *   试了几帧、有没有报错"（"点了没反应"是这类问题唯一的症状），
 *   诊断页也要读它 —— 用户不该为了知道自己机器上出了什么事而去看控制台。
 * 🔴 只落元信息（引擎/帧数/错误摘要），**绝不落扫码内容**：码里带着口令。
 */
let scanDiag: ScanDiag | null = null;
window.__NOTESYNC_SCAN_DIAG__ = (): ScanDiag | null => (scanDiag ? { ...scanDiag } : null);
window.__NOTESYNC_PARSE_PAIR__ = (raw: string) => resolveScan(raw).shape;

/** 扫码结果的形状：能不能解得开 + 笔记名 + 口令长度。
 *
 * 🔴🔴 为什么只回显 passLen 而不回显口令：
 *   钩子挂在 window 上，任何页面脚本都能调。若把口令放进 shape，
 *   它就从一个"测试钩子"变成"任何人可读的口令出口" ——
 *   而口令正是这个功能要保护的东西。有 passLen 已经足够让 e2e 判往返。
 */
interface PairShape {
  ok: boolean;
  noteId?: string;
  passLen?: number;
  reason?: string;
}

/**
 * `parsePairLink` 的**唯一调用点** —— 落地路径与 e2e 钩子都从这里过。
 * 🔴 判定口径只写一遍：分叉的根源从来不是"忘了改"，而是"改了一处"。
 */
function resolveScan(raw: string): { parsed: ReturnType<typeof parsePairLink>; shape: PairShape } {
  const parsed = parsePairLink(raw, location.origin);
  if (parsed.ok) {
    return {
      parsed,
      shape: { ok: true, noteId: parsed.link.noteId, passLen: parsed.link.passphrase.length },
    };
  }
  return { parsed, shape: { ok: false, reason: parsed.reason } };
}

/**
 * 打开取景层。
 * 🔴 重入锁用**带过期的时间戳**而不是布尔（老项目闸 R2 实锤）：
 *   布尔锁在"权限框永不返回"时会把扫一扫**永久**锁死，而它本要防的
 *   只是"探测那几秒连点两下叠两层取景框"。过期后放行并说明，
 *   比让按钮永久失灵好。
 */
let scanBusyAt = 0;
const SCAN_BUSY_MS = 90_000;

/**
 * 扫码反馈统一口（老项目 v7.7.0 同款分流）。
 *
 * 🔴🔴 为什么不直接 setFootStatus：底栏 `#foot` 属于编辑器外壳，
 *   在落地页**根本不存在** —— setFootStatus?.() 里的 `?.` 会静默跳过，
 *   于是"点扫码 → 相机起不来 → 提示写在不存在的地方"= 用户什么都没看到，
 *   只觉得按钮坏了。这正是 SCAN-E06 实锤的那一类。
 *
 * 🔴 自动收回带「文案仍是它才清」守卫（老项目红线 15）：
 *   无守卫时，先来的短提示会被后来的定时器清掉，
 *   症状是"错误信息闪一下就没了"，用户根本来不及读。
 */
let scanMsgTimer: number | null = null;
function scanFeedback(msg: string, autoHideMs = 0): void {
  if (scanMsgTimer !== null) {
    clearTimeout(scanMsgTimer);
    scanMsgTimer = null;
  }
  if (currentPage === 'editor') {
    // 底栏那一行是同步状态的位置，借它显示会让用户以为同步坏了
    setFootStatus?.('offline', msg);
    if (autoHideMs > 0) {
      scanMsgTimer = window.setTimeout(() => {
        scanMsgTimer = null;
        setFootStatus?.('synced');
      }, autoHideMs);
    }
    return;
  }
  const w = document.getElementById('landingScanMsg');
  if (!w) return;
  w.textContent = msg;
  w.classList.remove('hidden');
  if (autoHideMs > 0) {
    scanMsgTimer = window.setTimeout(() => {
      scanMsgTimer = null;
      // 🔴 守卫：只有当前显示的仍是这条消息时才收。
      if (w.textContent === msg) w.classList.add('hidden');
    }, autoHideMs);
  }
}

function openScanner(): void {
  const now = Date.now();
  if (scanBusyAt && now - scanBusyAt < SCAN_BUSY_MS) {
    scanFeedback(COPY.scanBusy);
    return;
  }
  scanBusyAt = now;
  try {
    buildScanLayer({
      onResult: (raw) => {
        // 🔴 命中什么（含空串 = 用户取消）都要放锁，
        //   否则取消一次后 90 秒内点不动扫一扫。
        scanBusyAt = 0;
        if (raw === '') return;
        void handleScanRaw(raw);
      },
      onHint: (text) => {
        // 🔴 取景期的"为什么扫不出"是**常驻状态行**，浮层自己会显示。
        //   这里也写一份是为了浮层收场后（相机失败那条路）原因不丢 ——
        //   浮层一拆，那行字就没了，用户只剩一个"点了没反应"的印象。
        scanFeedback(text);
      },
      onDiag: (d) => {
        scanDiag = d;
      },
      onClosed: () => {
        scanBusyAt = 0;
      },
    });
  } catch (e) {
    scanBusyAt = 0;
    scanFeedback(COPY.scanStartFail);
    console.error('[scan] 取景层构建失败', e);
  }
}

/** 冲突提示。裁决入口在菜单里，这里只把冲突条目显示出来。 */
function showConflictHint(): void {
  const c = syncRef;
  if (!c) return;
  const list = c.getConflicts();
  if (list.length === 0) return;
  menuState.conflicts = list.map((x) => ({ at: x.at, label: x.right || x.left }));
  menuRef?.render();
  // 🔴 冲突必须**主动**把用户带到裁决处，不能只在下巴上写一行字。
  //   底栏那行字会被滚动、被切页面、被时间规则重绘冲掉；
  //   而冲突不裁决的后果是"两边内容反复互相覆盖"，用户还以为网络在抽风。
  //   这里自动打开菜单的冲突视图 —— 一次交互就能改完，不打断编辑。
  menuRef?.openView('conflict');
}

/** 口令错 / 数据坏 —— 同一句话，不区分（ARCH 安全不变量：区分开等于给暴力破解 oracle） */
const PASS_ERROR = '口令不对，或数据无法解密';

function showLanding(): void {
  buildLanding(app, {
    onOpen: (name, isEgg) => {
      if (isEgg) {
        // 🔴 S8 接彩蛋层。这里**先跳到该门牌对应的路由**而不是弹提示 ——
        //   点了没反应是最糟的体验；路由会由彩蛋层接管（S8 前是 404 提示页）。
        location.href = '/' + name;
        return;
      }
      location.href = '/' + encodeURIComponent(name);
    },
    onScan: () => {
      // 🔴 落地页的「扫码打开笔记」与顶栏 scanBtn 走**同一个** openScanner，
      //   判定与降级逻辑不许分叉（分叉迟早出一处认不出另一处的码）。
      openScanner();
    },
  });
  goto('landing');
}

function showHome(): void {
  buildHome(app);
  goto('home');
}

function showPass(name: string): void {
  buildPass(app, {
    onSubmit: async (pass) => {
      // 🔴🔴 这里必须真解锁，**不能**先放行再补。
      //   "解锁成功但正文是空的"是本项目最危险的故障形态：用户会以为云端没内容，
      //   重写一遍推上去，把另一台设备上的正文覆盖掉 —— 静默的数据丢失。
      const r = await unlock({ noteId: name, passphrase: pass });
      if (!r.ok) return r.message;
      // 🔴 会话口令在**解锁成功之后**才记：失败的尝试不该把口令留在内存里。
      sessionPass = pass;
      pendingFresh = r.fresh;
      mountEditor(name, r.doc);
      return null;
    },
    onClose: () => {
      history.pushState({}, '', '/');
      showLanding();
    },
  });
  goto('pass');
}

/** 改口令的完整流程：从提示页拿新口令 → 换密钥 → 落盘。 */
async function doChangePassphrase(): Promise<void> {
  const next = window.prompt('输入新的口令');
  if (next === null) return;
  if (next.length === 0) {
    setFootStatus?.('offline', '新口令不能为空');
    return;
  }
  // 🔴 必须先验老口令。changePassphrase 内部会解老密文来确认，
  //   这里不需要重复问一次 —— 用户输错老口令时它会返回同一句文案。
  const doc = window.__NOTESYNC_DOC__?.() ?? emptyDoc();
  const old = window.prompt('再输入一次当前口令以确认');
  if (old === null) return;
  const r = await changePassphrase(currentNote, old, next, doc);
  if (!r.ok) {
    setFootStatus?.('offline', r.message);
    return;
  }
  // 🔴 会话口令必须同步换成新的。忘了这一步的话，配对码里还是**旧口令**，
  //   另一台设备扫了必然解不开 —— 而本机一切正常，症状是"配对功能坏了"。
  sessionPass = next;
  setFootStatus?.('synced', '口令已改，下次用新口令');
  // 换完密钥必须重建同步实例：它持有的是旧密钥
  await startSyncFor(currentNote);
}

function route(): void {
  const raw = noteNameFromPath();
  if (raw === '') {
    showLanding();
    return;
  }
  const name = sanitizeNoteName(raw);
  if (name === '') {
    // 路径里只有非法字符（如 /中文）→净化后为空，回落地页而不是报错
    showLanding();
    return;
  }
  if (isEggRoute(name)) {
    // 🔴 彩蛋门牌：**不进编辑器**（老项目口径 —— 门牌是保留字，不新建笔记）。
    //   伪路由（about/help/api…）不是门牌，回首页提示页而不是进游戏。
    //   未实现的门牌由 openByRoute 自己给可见提示并回落地页，绝不静默白屏。
    //🔴🔴 必须**先 ensureEggLayer 再问 doorOfPath**：
    //   直接访问 /snake（分享链接、收藏书签、APK 冷启）时彩蛋层还没懒建，
    //   `eggLayer?.doorOfPath()` 返回 undefined ≠ 'snake'，于是掉进 showHome ——
    //   症状是"门牌链接打不开游戏，只看到一个首页提示"，而首页提示不会报错。
    //   （本条由 e2e EGG-E02 抓到：门牌直达是首屏路径，不是边角情况。）
    if (eggLayer === undefined) ensureEggLayer();
    if (eggLayer?.doorOfPath() === name.toLowerCase()) {
      ensureEggLayer();
      if (eggLayer && !eggLayer.openByRoute(name)) {
        // 门牌存在但没映射出实现 —— 回落地页，别停在一个什么都不做的编辑器
        showLanding();
      }
      goto('egg');
      return;
    }
    // 非门牌的保留字：至少不是白屏
    showHome();
    return;
  }
  // 🔴 "本机记不记得"由**能不能取到密钥**决定，不是 localStorage 里一个布尔标记。
  //   老项目用标记当记忆，于是"标记在、密钥没了"时依然进编辑器 = 假成功。
  //   resolveKey 走内存 → IndexedDB，都拿不到才要口令。
  void (async () => {
    const rec = await unlockIfRemembered(name);
    if (rec && rec.ok) {
      pendingFresh = false;
      mountEditor(name, rec.doc);
      return;
    }
    showPass(name);
  })();
}

function boot(): void {
  applyTheme();
  // 🔴 隐藏的 file input 必须在启动时就建好（见 ensureUploadInput 的注释）：
  //   懒创建会让"第一次点击"成为唯一能走通的机会，一旦那次失败按钮就永久是死的。
  ensureUploadInput();
  route();
  // 口令页关闭回落地页用的是 pushState，所以要监听 popstate
  window.addEventListener('popstate', () => {
    // 🔴 游戏外壳自己 push 了历史（进游戏时压一条，退出时 back回去）。
    //   不在这里重跑 route()，否则 popstate 会把用户又送回游戏页 ——
    //   症状是"退出游戏后又弹回游戏，循环往复且关不掉"。
    if (eggLayer?.shell.isOpen()) return;
    route();
  });
  //🔴 ?eggs 直开图鉴（老项目同款：与 ?diag 同一套路）。
  //   必须在 route 之后：门牌路径下 route 会进游戏，此时不该再叠图鉴。
  if (location.search.indexOf('eggs') >= 0 && !eggLayer?.shell.isOpen()) {
    ensureEggLayer()?.openCodex();
  }
  document.getElementById('boot')?.remove();
}

/**
 * 注册 ServiceWorker。
 * 🔴 APK 内不注册（见文件头）。策略两条：缓存名带版本、失败不影响使用。
 */
function registerSW(): void {
  if (window.__NOTESYNC_NATIVE__) return;
  if (!('serviceWorker' in navigator)) return;
  const url = new URL('sw.js', location.href);
  navigator.serviceWorker.register(url).catch((e: unknown) => {
    // 注册失败不能影响使用：离线能力是增强项，不是前提
    console.warn('[notesync] SW 注册失败（不影响使用）', e);
  });
}

try {
  boot();
  registerSW();
} catch (e) {
  console.error('[notesync] 启动失败', e);
  const box = document.createElement('div');
  box.className = 'ns-fatal';
  box.textContent = '启动失败：' + (e instanceof Error ? e.message : String(e));
  app.appendChild(box);
}

export {};

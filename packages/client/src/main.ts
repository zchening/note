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

import { createEditor, FORMAT_TEXT_COMMAND, type EditorState, type LexicalEditor } from 'lexical';

import { APP_VERSION, BUILD_DATE, SCHEMA_VERSION } from './version.ts';
import { registerBehaviors } from './behaviors.ts';
import { ALL_NODES } from './node-registry.ts';
import { docToLexical, lexicalToDoc } from './serialize.ts';
import { emptyDoc, normalize, type Doc } from '@bj/shared-schema';
import { buildHome, buildLanding, buildPass } from './ui/pages.ts';
import { buildShell, type Shell, type TopbarAction } from './ui/shell.ts';
import { buildMenu, type MenuState } from './ui/menu.ts';
import { applyThemeVars, resolveTheme, type SkinName, type ThemeName } from './ui/theme.ts';
import { isEggRoute, sanitizeNoteName } from './ui/landing-logic.ts';

declare global {
  interface Window {
    __NOTESYNC_NATIVE__?: boolean;
    __NOTESYNC_BUILD__?: { version: string; date: string; sha: string };
    __NOTESYNC_EDITOR__?: LexicalEditor;
    /** 读取最近一次提交的真源快照（深拷贝）。正式接口，非调试后门。 */
    __NOTESYNC_DOC__?: () => Doc;
    /** 当前页面名（landing / pass / home / editor）。e2e 与 S5 同步都读它。 */
    __NOTESYNC_PAGE__?: () => string;
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

/* ---------------- 口令记忆 ---------------- */

/**
 * 本机是否已记住某笔记的口令。
 *
 * 🔴 S4 只落"记住与否"这一个比特，真正的密钥存取在 S5 的 crypto 层接手
 *   （CryptoKey 存 IndexedDB，extractable:false）。这里刻意**不假装**已经有密钥 ——
 *   一个"看起来解锁了其实没解"的假成功，比明确要求输入口令糟糕得多。
 */
const passKey = (name: string): string => `notesync_bj_has_${name}`;
function hasPass(name: string): boolean {
  try {
    return localStorage.getItem(passKey(name)) === '1';
  } catch {
    // 隐私模式 / 存储被禁用：当作没记住，退回要求输入
    return false;
  }
}
function rememberPass(name: string): void {
  try {
    localStorage.setItem(passKey(name), '1');
  } catch {
    /* 存不下就本次会话内有效，不打扰用户 */
  }
}

/* ---------------- 应用装配 ---------------- */

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app 不存在：index.html 与本文件不同源');
// 🔴 显式标注成HTMLElement：模块顶层的 throw 窄化传不进下面这些函数体，
//   于是每个 build*(app) 调用点都报一遍"可能是 null" —— 一次收口，别处干净。
const app: HTMLElement = appEl;

let editor: LexicalEditor | undefined;
let setFootStatus: ((s: 'connecting' | 'synced' | 'offline', d?: string) => void) | undefined;
let currentPage = 'boot';
let currentNote = '';
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
  faved: false,
  night: false,
  linkInApp: readPref('linkInApp', '1') === '1',
  favList: [],
  histList: [],
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
      // 提醒靠正文里的时间标记（S5 的自动识别），S4 只需说明这一机制
      setFootStatus?.('synced', '在正文里写时间即可加提醒');
      return;
    }
    default:
      setFootStatus?.('connecting');
      return;
  }
}

function mountEditor(name: string): void {
  const initial: Doc = emptyDoc();
  currentNote = name;

  const shell = buildShell(app, {
    onTopbar: (act) => void onTopbar(act),
    onMenu: () => menuRef?.open(),
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
      menuState.faved = !menuState.faved;
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
      location.href = '/pet';
    },
    onToggleTheme: () => {
      // 🔴 手动切换是**内存态，刻意不写 localStorage**（老项目行为）：
      //   刷新或重新解锁一律回到时间规则。写进存储就等于给老项目加了个它没有的功能。
      manualDark = currentTheme === 'dark' ? false : true;
      applyTheme();
    },
    onChangePass: () => {
      // S5 接：重设口令要重新派生密钥。S4 先清记住标记，下次进来重新问口令
      try {
        localStorage.removeItem(passKey(currentNote));
      } catch {
        /* ignore */
      }
    },
    onLock: () => {
      try {
        localStorage.removeItem(passKey(currentNote));
      } catch {
        /* ignore */
      }
      location.reload();
    },
    onAbout: () => {
      location.href = '/about';
    },
  });

  const { root, editorHost } = shell;
  root.dataset.note = name;
  root.dataset.version = APP_VERSION;
  root.dataset.schema = String(SCHEMA_VERSION);
  root.dataset.build = BUILD_DATE;

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

  let latest: Doc = initial;

  // 🔴 必须在 docToLexical 之前挂监听：initial 那一次 update 也要留下快照，
  //   否则首次 commit 之前 latest 停在空文档，e2e 读到的是"从未提交过"的假象。
  ed.registerUpdateListener(({ editorState }: { editorState: EditorState }) => {
    // 🔴 state.read() 回调外节点句柄失效 —— 整段导出必须在回调内部完成
    latest = normalize(lexicalToDoc(editorState, initial.reminders));
    root.dataset.lastDocBytes = String(new TextEncoder().encode(JSON.stringify(latest)).length);
  });

  ed.update(() => docToLexical(initial), { discrete: true });

  // 暴露真源读取口。**这不是调试后门**：S5 的加密入口、S4 的自动保存、
  // 以及 e2e 的「输入是否真进了真源」判据都走它，是正式接口的一部分。
  window.__NOTESYNC_DOC__ = (): Doc => structuredClone(latest);
  window.__NOTESYNC_EDITOR__ = ed;
  editor = ed;
  goto('editor');
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
      // 扫一扫是 S6 的能力（需后端签发配对票据）。现在给明确反馈而不是静默无响应。
      location.href = '/' + encodeURIComponent(location.pathname.slice(1) || 'scan');
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
      if (pass.length === 0) return PASS_ERROR;
      // 🔴 S4 只校验"非空"并记住标记；真正的密钥派生 + 解密在 S5 接上。
      //   这里绝不能先放行再补 —— 那会造成"解锁成功但正文是空的"这种静默故障。
      rememberPass(name);
      mountEditor(name);
      return null;
    },
    onClose: () => {
      history.pushState({}, '', '/');
      showLanding();
    },
  });
  goto('pass');
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
    // 彩蛋门牌：S8 接管。现在落到首页提示页，至少不是白屏。
    showHome();
    return;
  }
  if (hasPass(name)) mountEditor(name);
  else showPass(name);
}

function boot(): void {
  applyTheme();
  route();
  // 口令页关闭回落地页用的是 pushState，所以要监听 popstate
  window.addEventListener('popstate', () => route());
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

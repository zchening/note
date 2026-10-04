/**
 * 浏览器端入口 —— 目前只做四件事，UI 外壳在 S4 填充
 *
 *  1. 挂载 Lexical 编辑器（第一次真 DOM 落地）
 *  2. 真源快照：正文变化 → 模型 JSON（唯一真源，DOM 随时可弃）
 *  3. 自报版本（唯一来源 version.ts 的构建期注入，见 tools/build.mjs 的 define）
 *  4. 注册 ServiceWorker —— **APK 内不注册**（ARCH.md §4.6 红线）
 *
 * 🔴 不引 React / 任何 UI 框架：
 *   ARCH.md §4.2 选Lexical 的理由是"不重踩 contenteditable 的坑"，不是"顺手把 React 也带进来"。
 *   UI 外壳是顶栏 9 键 + 菜单 11 项 + 落地页，全是命令式 DOM 就够，
 *   引框架要多背~40KB gzip、要ReactDOM 的 commit 阶段、要处理并发渲染与
 *   Lexical 自己的update 批次的时序冲突 —— 收益远小于代价。
 *   真的需要组件化时，拆成 `packages/client/src/ui/*.ts` 模块即可，不影响架构。
 *
 * 🔴 APK 内绝不注册 SW：
 *   APK 的页面是壳（capacitor server.url 指服务器），真内容随 OTA 从服务器来。
 *   一旦 APK 内注册了 SW，它会缓存住壳，于是"发新版 → 用户永远看不到新版"，
 *   而且本地已有的 SW 还要靠人为清缓存才能退场。老项目在这上面踩过。
 *   判据用原生壳注入的 window.__NOTESYNC_NATIVE__。
 */

import { createEditor, type EditorState, type LexicalEditor } from 'lexical';

import { APP_VERSION, BUILD_DATE, SCHEMA_VERSION } from './version.ts';
import { registerBehaviors } from './behaviors.ts';
import { ALL_NODES } from './node-registry.ts';
import { docToLexical, lexicalToDoc } from './serialize.ts';
import { emptyDoc, normalize, type Doc } from '@bj/shared-schema';

declare global {
  interface Window {
    __NOTESYNC_NATIVE__?: boolean;
    __NOTESYNC_BUILD__?: { version: string; date: string; sha: string };
  }
}

/** Lexical 主题 class 名。CSS 在 S4 写，这里只给契约。 */
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

function buildShell(): { root: HTMLElement; editorHost: HTMLElement } {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app 不存在：index.html 与本文件不同源');
  const boot = document.getElementById('boot');

  const root = document.createElement('div');
  root.id = 'root';
  root.dataset.version = APP_VERSION;
  root.dataset.schema = String(SCHEMA_VERSION);
  root.dataset.build = BUILD_DATE;

  const editorHost = document.createElement('div');
  editorHost.id = 'editor-host';
  editorHost.setAttribute('contenteditable', 'true');
  editorHost.setAttribute('role', 'textbox');
  editorHost.setAttribute('aria-label', '笔记正文');
  editorHost.setAttribute('aria-multiline', 'true');
  editorHost.className = 'ns-editor';
  editorHost.spellcheck = false;

  root.appendChild(editorHost);
  app.appendChild(root);
  boot?.remove();
  return { root, editorHost };
}

function mount(): LexicalEditor {
  const { root, editorHost } = buildShell();

  const editor = createEditor({
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

  const initial: Doc = emptyDoc();
  editor.setRootElement(editorHost);
  // 🔴🔴 行为注册必须在 setRootElement 之后、任何 update 之前。
  //   漏掉它 = 编辑器能显示但打不了字，且**零报错**（详见 behaviors.ts 文件头）。
  //   setRootElement 会触发一次 reconcile，所以放在它之后保证注册表看到的是稳定态。
  registerBehaviors(editor);

  /** 最近一次提交的真源快照。S5 的加密与上传、S4 的脏标记都读它。 */
  let latest: Doc = initial;

  // 🔴 必须在 docToLexical 之前挂监听：initial 那一次 update 也要留下快照，
  //   否则首次 commit 之前 latest 停在空文档，e2e 读到的是"从未提交过"的假象。
  editor.registerUpdateListener(({ editorState }) => {
    // 🔴 state.read() 回调外节点句柄失效 —— 整段导出必须在回调内部完成
    const doc: Doc = normalize(lexicalToDoc(editorState, initial.reminders));
    latest = doc;
    root.dataset.lastDocBytes = String(new TextEncoder().encode(JSON.stringify(doc)).length);
  });

  editor.update(() => docToLexical(initial), { discrete: true });

  // 暴露真源读取口。**这不是调试后门**：S5 的加密入口、S4 的自动保存、
  // 以及 e2e 的「输入是否真进了真源」判据都走它，是正式接口的一部分。
  // 🔴 只读快照（返回深拷贝），不给外界改写 latest 的能力。
  window.__NOTESYNC_DOC__ = (): Doc => structuredClone(latest);

  return editor;
}

/**
 * 注册 ServiceWorker。
 * 🔴 APK 内不注册（见文件头）。策略两条：缓存名带版本、10s AbortController 超时。
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

let editor: LexicalEditor | undefined;
try {
  editor = mount();
  registerSW();
} catch (e) {
  console.error('[notesync] 启动失败', e);
  const app = document.getElementById('app');
  if (app) {
    const box = document.createElement('div');
    box.className = 'ns-fatal';
    box.textContent = '启动失败：' + (e instanceof Error ? e.message : String(e));
    app.appendChild(box);
  }
}

// 供 e2e 取用（Playwright 通过 window.__NOTESYNC_EDITOR 驱动编辑器）
declare global {
  interface Window {
    __NOTESYNC_EDITOR__?: LexicalEditor;
    /** 读取最近一次提交的真源快照（深拷贝）。正式接口，非调试后门。 */
    __NOTESYNC_DOC__?: () => Doc;
  }
}
if (editor) window.__NOTESYNC_EDITOR__ = editor;

export {};

/**
 * 编辑器**行为**注册表 —— 与 node-registry.ts 配对，两者缺一不可
 *
 * 🔴🔴🔴 这是 S3 踩了两个小时才抓到的 P0 级静默故障，性质比以往任何 bug 都恶劣，
 *   所以这里的注释比代码长，务必读完再改：
 *
 *   **症状**：编辑器渲染正常、聚焦正常、选区正常、`beforeinput` 事件照常触发、
 *   `updateEditor` 照常执行（update 监听器计数在涨）、
 *   **console 一个错误都没有**（全局 error / unhandledrejection / console.error 全空），
 *   但**敲键盘一个字都进不去**，DOM 和选区完全不变。
 *
 *   **根因**：`node-registry.ts` 只解决"节点能被创建"，而 Lexical 的**编辑行为**
 *   （打字、格式化、缩进、复制粘贴、撤销）全部由 `@lexical/*` 插件包提供，
 *   **不在 `lexical` 核心里**。实测 Lexical 0.52.0：
 *     - 键盘输入走 `CONTROLLED_TEXT_INSERTION_COMMAND`
 *     - 该命令在 `Lexical.dev.js` 里有 4 处 `dispatchCommand`、**0 处 `registerCommand`**
 *     - 唯一的注册在 `@lexical/rich-text` 的 `registerRichText` 里
 *   没注册它 = 命令 dispatch 进了**没有监听者的黑洞**：不报错、不生效、也不留痕。
 *
 *   **这正是「静默降级」的教科书形态** —— 服务不报错、状态有值、但结果是错的。
 *   判断口径记牢：**凡是"看起来对但没生效"，第一反应就查它有没有执行到该执行的注册。**
 *
 *   **由此得出的两条纪律**：
 *   1. 节点清单与行为清单必须**同批次评审**。只补节点不补行为 = 能显示不能打字。
 *   2. 这类故障在纯逻辑单测里**完全不可见**（序列化层不需要行为插件），
 *      唯一能抓到它的就是真浏览器 e2e。这再次证明了 ARCH.md §4.6
 *      "jsdom 全面退役"的判断是对的 —— 那一大堆 mock 纪律税在这里一个都救不了。
 *
 * 🔴 **为什么用 `register*` 函数式，而不是 0.52 新推的 Extension 体系**
 *   （`defineExtension` / `configExtension` / `RichTextExtension`）：
 *
 *   实测结论 —— **0.52 的 Extension 只有类型与纯数据标记，没有激活运行时**：
 *     - `extension-core/` 目录下只有 `defineExtension.d.ts` / `types.d.ts` 等**类型声明**，
 *       没有任何 `.js`
 *     - `Lexical.dev.js` 里与 Extension 相关的函数只有 2 个：
 *       `defineExtension(extension)`（第 26111 行，原样返回入参，纯标记）
 *       `configExtension(...args)`（第 26142 行，浅合并配置）
 *     - `createEditor(editorConfig?: CreateEditorArgs)` 的 `CreateEditorArgs` 里
 *       **没有 extensions 字段**；`EditorConfig` 里也没有
 *     - 即Activation 入口在 `@lexical/react` 那一侧（框架绑定层），核心不提供
 *
 *   也就是说：`RichTextExtension` 这类对象在本项目这种"不引 React 的纯 DOM 宿主"里
 *   **无法被激活**。若照抄 React 侧写法会得到"看起来注册了、实际毫无作用"的第二层静默故障——
 *   那比现在这个更难查，因为它连 `register` 回调都不会被调用。
 *   所以本项目走 `register*` 函数式：唯一被实测证明可用的路径。
 *
 *   `registerRichText(editor, a, b)` 在 0.52 被标了 `@deprecated`（注释写明
 *   "RichTextExtension now registers..."），但它**仍然是 RichTextExtension.register
 *   内部所调用的那个函数**，签名 `(editor, escapeFormatTriggers?, shouldHandlePasteAsFiles?)`，
 *   两个 signal 参数可省略并取默认值。当前 0.52 没有任何替代入口，
 *   故按"能用即最优"采用，并把这条判断写进 ARCH.md 待将来版本复核。
 *
 * 注册顺序（**手工控制，因为没有拓扑排序**）：
 *   Lexical 的命令是"后注册者先询问"，`registerRichText` 里的 Ctrl+B/Ctrl+I 等
 *   是**兜底**实现，会吞掉未被更早更优先处理器认领的事件。
 *   所以兜底必须**最后**注册，前面的专用处理器（list / link）自然优先。
 */

import type { LexicalEditor, ElementNode } from 'lexical';
import {
  $createParagraphNode,
  $createPoint,
  $createRangeSelection,
  $createTextNode,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  type LexicalNode,
} from 'lexical';

import { registerList } from '@lexical/list';
// 🔴🔴 历史栈（Ctrl+Z / Ctrl+Y）。**缺它= 撤回功能对用户完全不存在**（用户报障第 4 条）。
//   病根不是"没实现"，是**依赖压根没装**：`@lexical/history` 不在 package.json 里，
//   而 `registerHistory` 是 Lexical 唯一提供撤销栈的地方 —— `lexical` 主包只导出
//   `UNDO_COMMAND` / `REDO_COMMAND` / `CAN_UNDO_COMMAND` 这些**命令常量**，
//   **没有任何处理器监听它们**。于是 Ctrl+Z 派发出去，一路无人认领，静默消失。
//   （实测：真浏览器里输入 ABCDE 后按 Ctrl+Z，textContent 仍是 "ABCDE"。）
//
//   🔴 为什么从深路径 `@lexical/history` 主入口引而不是别处：
//   `lexical` 与 `@lexical/rich-text` 都**不** re-export 它，必须单独装这个包。
//   版本与全家桶一致（0.52.0）—— 混版本会在 import 期就炸。
import { createEmptyHistoryState, registerHistory } from '@lexical/history';
import { registerRichText } from '@lexical/rich-text';
// 🔴 只取 `signal` 这一个纯函数，**从深路径 `@lexical/extension/signals.js` 引**。
//   从 `@lexical/extension` 主入口引会把整个 Extension 包（AutoFocus / History /
//   Builder …）拖进产物 —— 而文件头已经论证过本项目**不引 React、没有 Extension 激活运行时**，
//   那些扩展一个都用不上，纯属白进几十 KB。
//   深路径的 `./signals.js` 在 package.json 的 exports 里是显式条目，esbuild 能解析。
//   且它与 `@lexical/rich-text` 内部用的是**同一份** signals-core 实例（同一 resolved 文件），
//   所以 signal 的语义与 richText 内部一致，不会出现"两份响应式系统"。
import { signal } from '@lexical/extension/signals.js';

/**
 * 撤销栈的**合并窗口**（毫秒）。
 *
 * 🔴 为什么是 300：连续打字在 300ms 内视为同一"撤销单元"。取小值的症状是
 *   用户按一次退格只删一个字（撤销栈被拆成一堆单字步骤），取大值则反过来——
 *   打完一整段话只能一次性全撤。300ms 是 Lexical 自己的默认值，
 *   与老项目"停笔后才落一次快照"的节奏同量级（老项目 index.html 的 undoStack
 *   是在 `saveLocal` 落盘时才压栈的，本项目是真源即时更新，节奏本就更密）。
 */
const HISTORY_MERGE_DELAY_MS = 300;

import { $createFoldNode, $isFoldNode, type FoldNode } from './nodes.ts';
import { spansToNodes } from './serialize.ts';
import { registerLinkify } from './linkify/deferred.ts';
import { dismissKeyboardForTouch } from './platform/touch.ts';
import type { Span } from '@bj/shared-schema';

/**拖拽高亮用的 class。与 styles.css `.ns-editor.dragover` 一一对应（改一处必须改两处）。 */
const DRAGOVER_CLASS = 'dragover';

/**
 * 行为层所需的外部能力（由 main.ts 注入）。
 *
 * 🔴 为什么**注入函数**而不是让 behaviors.ts 直接 import `handleImageUpload`：
 *   上传需要 `noteId` / `origin` / 三个提示回调，全在 main.ts 的模块作用域里
 *   （`currentNote`、`showUploadNote`、`dismissKeyboardForTouch`）。
 *   若behaviors.ts 自己 import upload.ts 再自己拼这些依赖，就是**第二份上传接线**——
 *   改提示文案/加错误态要改两处，漏一处就出现"选图有提示、拖拽没提示"，
 *   症状是用户以为拖拽坏了（与文件头那些静默降级同形状）。
 *   注入后**上传入口只有 main.ts 那一个函数**，三处触发点共用它。
 */
export interface BehaviorDeps {
  /**
   * 上传一个图片文件（压缩 → 取签名 → 直传 → 插图）。
   * 必须是 `handleImageUpload` 的包装：类型/大小校验与失败文案都在那里面，
   * 这里**不另立标准**。
   */
  uploadImage: (file: File) => void;
  /**
   * 链接识别的遮罩守卫：当前有没有遮罩态面板（提醒 / 二维码 / 扫一扫）。
   *
   * 🔴 与 uploadImage 同款纪律：判定逻辑全在 main.ts（那里才有面板状态），
   *   本模块**不去猜 class 名**。猜错的后果是"面板开着时光标被链接重建弹走"，
   *   零报错、极难自查。
   */
  hasOverlayOpen: () => boolean;
}

/**
 * `registerBehaviors` 的返回值。
 *
 * 🔴 为什么不再只返回注销函数：链接识别需要一个「立刻跑一轮」的入口，
 *   供真源换档时调用（解锁 / 远端合并 / 导入 —— 老项目 index.html:3471
 *   `if (note.ct) linkifyEditor()` 是同一件事）。
 *   少了它，那些**用户没敲过字**的裸网址永远不亮 ——
 *   而这恰恰是老项目迁移过来的真源里最常见的样子。
 *
 *   做成对象而不是让 main.ts 直接 import registerLinkify：
 *   那样会出现第二个注册入口，与这里的组装顺序脱钩。
 */
export interface BehaviorHandle {
  /** 立刻跑一轮链接识别（跳过打字守卫）。真源换档后调用。 */
  linkifyNow: () => void;
  /** 注销全部行为（逆序执行）。S4 热重载与测试隔离会用到。 */
  dispose: () => void;
}

/**
 * 注册全部编辑行为。
 *
 * 🔴 必须在 `editor.setRootElement(...)` **之后**、任何 `editor.update(...)` 之前调用：
 *   setRootElement会触发一次 reconcile 与 `$commitPendingUpdates`，
 *   在它之前注册则行为插件看不到稳定态的root 绑定。
 *
 * @param deps 外部能力注入（上传 + 遮罩判定）。**刻意做成必填**：
 *   做成可选等于给"忘了传uploadImage"留一个静默降级的口子——
 *   表现是"编辑器能打字但图片拖进来没反应"，零报错，正是本文件要消灭的那类故障。
 */
export function registerBehaviors(editor: LexicalEditor, deps: BehaviorDeps): BehaviorHandle {
  // 🔴🔴🔴 自动链接识别 —— 老项目 index.html:3846 `linkifyEditor` 的等价物。
  //
  //   **这里原来调的是 `registerAutoLink(editor)`，而它是彻底无效的**（探针
  //   .probe/probe-c.mjs 实锤）：不传 config 时 `defaultConfig.matchers` 是
  //   **空数组**（node_modules/@lexical/link/dist/LexicalLink.dev.js:1773-1778），
  //   于是它注册的是一个「零匹配器」的节点变换 —— 不报错、不生效、也不留痕。
  //   用户报「正文里的网址没有被自动识别」就是这条。
  //
  //   为什么不能改成「给它配 matchers 就好」（那才是最小改动）：
  //     1. 它的 URL 正则与老项目**不是一套**（Unicode `\p{L}` + 括号配平
  //        vs 老项目的 CJK 字符类方案），中文正文里判据完全不同；
  //     2. 它是**打字即时**的增量变换，老项目是**停笔 1.5s 后的全量重扫**，
  //        节奏不同（老项目注释明写实时改树会让光标跳，index.html:3624-3627）；
  //     3. 它不认手机号、不认裸域名 TLD 白名单、不管 ZWSP 兼容；
  //     4. 它产出 AutoLinkNode，而这个节点**没注册进 ALL_NODES**
  //        （node-registry.ts 只有 LinkNode），真机上一旦触发就抛
  //        "Attempted to create node AutoLinkNode that was not configured"
  //        —— 症状是整篇文档变空（探针 probe-b.mjs 实测）。
  //   ⇒ 走项目自己的 linkify/，规则逐条抄老项目并已实跑对拍（test/linkify.test.mjs）。
  const linkify = registerLinkify(editor, { hasOverlayOpen: deps.hasOverlayOpen });

  // 列表：Tab / Shift+Tab 缩进与反缩进、Enter 新建条目、Backspace 退出列表。
  const unregisterList = registerList(editor);

  // 🔴🔴 撤销/重做栈（用户报障第 4 条「不支持 Ctrl+Z 撤回」）。
  //   必须注册，且必须排在 richText **之前** ——
  //   `registerRichText` 自带 UNDO/REDO 的兜底处理，而 Lexical 的命令是
  //   「后注册者先询问」：history 若排在它后面，richText 会先抢到事件。
  //   （`registerHistory` 内部只监听 UNDO_COMMAND/REDO_COMMAND，与谁先谁后都能收，
  //    但保持"专用处理器在前、兜底在后"这条本文件既有纪律，别在顺序上留隐性依赖。）
  //
  // 🔴🔴 `registerHistory(editor, historyState, delay, ...)` 的**第二个参数是必填的
  //   HistoryState 实例**，不是 delay（我第一次按老版签名传 (editor, 300) 直接
  //   `TS2554: Expected 3-6 arguments`）。必须用 `createEmptyHistoryState()` 新建，
  //   且**这个实例要留着**—— 共享历史（多编辑器）场景要靠它对齐；
  //   本项目只有一篇笔记编辑器，但它同时是"远端合并进来的真源"回放时的重放基准，
  //   复用同一个实例才不会让撤销栈在远端合并后错位。
  //   `delay=300` 与老项目 index.html 的撤销合并窗口同量级：太短会把连续打字
  //   拆成一堆撤销步（按一次退格只删一个字），太长则合并过度。
  const historyState = createEmptyHistoryState();
  const unregisterHistory = registerHistory(editor, historyState, HISTORY_MERGE_DELAY_MS);

  // 折叠块：点标题行开合 + 光标在折叠块内按 Enter 自动展开。
  // 🔴🔴 必须注册在 list 之后、richText 之前：Lexical 的命令是「后注册者先询问」，
  //   折叠的点击处理若排在 richText 之后，会被 richText 的兜底抢走。
  const unregisterFold = registerFoldBehavior(editor);

  // 🔴 行首 `[折叠]` /`[/折叠]` 自动转成FoldNode（老项目 applyFolds 的等价物）。
  //   缺它= 折叠功能对真实用户完全不可达（只有 e2e 钩子能造）。
  const unregisterFoldAuto = registerFoldAutoCreate(editor);

  // 🔴🔴 图片的两个入口：拖拽进编辑器、粘贴图片。
  //   缺它= 这两条路对真实用户**完全不存在**，而 e2e 全绿
  //   （`06-image.test.js` 只覆盖了 file input 那一条）。
  const unregisterImageInput = registerImageFileInput(editor, deps.uploadImage);

  // 🔴 富文本兜底（含**打字能力本身**）—— 必须最后。
  //   漏掉它 = 编辑器能显示但打不了字，且**零报错**（见文件头）。
  //
  // 🔴🔴 第三个参数 `signal(() => true)` = `shouldHandlePasteAsFiles`。
  //   0.52 里它已经不是裸 boolean 而是 `ReadonlySignal<(files, hasTextContent) => boolean>`
  //   （见 node_modules/@lexical/rich-text/src/index.ts:1285），默认值是
  //   `files.length > 0 && !hasTextContent` —— 即"有文件且没有文本"才走文件通道。
  //   那正是**从网页/聊天软件复制一张图**的形态吗？不是：那种剪贴板里
  //   `text/html` 与`image/png` **同时存在**（浏览器会把`<img src>` 一并写进 html），
  //   于是 `hasTextContent === true`，默认值返回 false，
  //   图片被当成 HTML 文本插进编辑器（用户看到的是一段残缺标记或什么都没发生）。
  //   老项目 `index.html:2650` 判`items` 里有没有 `image/` 项，与此同解：
  //   **只要剪贴板里有图片，就走图片通道**，文本让位。
  const unregisterRichText = registerRichText(editor, undefined, signal(() => true));

  return {
    linkifyNow: linkify.runNow,
    dispose: () => {
      // 逆序注销，与注册顺序严格相反
      unregisterRichText();
      unregisterHistory();
      unregisterImageInput();
      unregisterFoldAuto();
      unregisterFold();
      unregisterList();
      linkify.dispose();
    },
  };
}

/**
 * 拖拽 / 粘贴图片的 DOM 行为（老项目 `index.html:2735-2742` + `2645-2675` 的 Lexical 等价物）。
 *
 * 🔴🔴 为什么这两个入口必须**自己监听 DOM**，而不能只靠 Lexical 的命令：
 *   - **拖拽高亮**：`.ns-editor.dragover` 是纯 CSS 状态，Lexical 没有任何
 *     "拖拽悬停态"的概念，只能自己加class。
 *   - **上传动作**：Lexical 内建的文件通道（`DRAG_DROP_PASTE` / `shouldHandlePasteAsFiles`）
 *     只负责把文件**交给节点工厂**（如 `$createNodesFromAttachments`），
 *     而本项目的图片**必须先压缩再签名直传 Cloudinary**（upload.ts），
 *     这条链路 Lexical 不可能知道。所以上传只能由我们自己发起。
 *
 * 🔴🔴 三条判据纪律（每条都对应一类"看起来能跑、实际没生效"）：
 *
 *   1. **只认`types.includes('Files')` 的拖拽**，纯文本拖拽一律放行。
 *      无条件 `preventDefault()` 会吞掉编辑器内的文字拖放（移动选中文字），
 *      症状是"选中一段话拖不动位置"，且没有任何提示。
 *      老项目是无条件 preventDefault（它没有 Lexical 的内部拖放语义），
 *      新项目必须区分 —— 这是与老项目**故意不同**的地方。
 *
 *   2. **`dragenter`/`dragover` 只负责"宣告可以放"**，不上传。
 *      浏览器要求 dragover 被 preventDefault 才会派发 drop；
 *      在 dragover 里就上传会让"鼠标扫过编辑器"触发压缩与上传。
 *
 *   3. **`dragleave` 移除高亮**，但必须判 `relatedTarget` 是否仍在编辑器内：
 *      鼠标从编辑器**内部**的元素之间移动会连续触发 dragleave（每个子段落一次），
 *      无条件移除会让高亮**闪一下就消失**，用户根本看不到。
 */
function registerImageFileInput(editor: LexicalEditor, uploadImage: (file: File) => void): () => void {
  const root = editor.getRootElement();
  // 🔴 与 `registerFoldAutoCreate` 同款：root 取不到就只解绑自己。
  //   上层 `registerBehaviors` 的契约要求在 setRootElement 之后调用，
  //   这里不需要再抛一次（重复抛会掩盖真正的调用顺序错误）。
  if (!root) return () => {};

  /** 只在"确实带着文件"时接管拖拽；纯文本拖拽放行给编辑器。 */
  const carriesFiles = (e: DragEvent): boolean => {
    const types = e.dataTransfer?.types;
    return !!types && types.includes('Files');
  };

  const onDragEnter = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    root.classList.add(DRAGOVER_CLASS);
  };

  const onDragOver = (e: DragEvent): void => {
    if (!carriesFiles(e)) return;
    // 🔴 这一行是 drop 事件能被派发的前提（见上方纪律 2）。
    //   不写它，drop 永远不触发，且**不报错**。
    e.preventDefault();
    root.classList.add(DRAGOVER_CLASS);
  };

  const onDragLeave = (e: DragEvent): void => {
    // 🔴 只在"真的离开编辑器"时才移除高亮（见上方纪律 3）。
    //   relatedTarget 为 null 表示离开了窗口，同样要清。
    const to = e.relatedTarget;
    if (to instanceof Node && root.contains(to)) return;
    root.classList.remove(DRAGOVER_CLASS);
  };

  const onDrop = (e: DragEvent): void => {
    root.classList.remove(DRAGOVER_CLASS);
    if (!carriesFiles(e)) return;
    // 🔴 必须 preventDefault：否则浏览器把文件**当页面导航打开**，
    //   单页应用被整个替换掉，用户的笔记看起来"丢了"（现场最难解释的一类）。
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    // 🔴 只取第一张。`handleImageUpload` 自带类型/大小校验与失败文案，
    //   非图片文件走它会给出「不是图片文件，图片未插入，请重试」——
    //   与用户从文件管理器误拖一个 txt 进来的真实情形对齐，且**不另立标准**。
    const first = files[0];
    if (first) uploadImage(first);
  };

  const onPaste = (e: ClipboardEvent): void => {
    const items = e.clipboardData?.items;
    if (!items) return;
    // 🔴 判据是「items 里有 type 以 image/ 开头的项」，而不是
    //   `e.clipboardData.files[0]`：后者在部分浏览器/场景下为空
    //   （如从聊天软件复制图片时只有 blob item 而 files 未暴露）。
    //   老项目 index.html:2650 用的正是 items 判据，同款。
    let image: File | null = null;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        image = item.getAsFile();
        if (image) break;
      }
    }
    if (!image) return;
    // 🔴 有图就吞掉这次粘贴：否则 Lexical 的 richText 会把同一份剪贴板里的
    //   `text/html`（`<img src=...>`）也插进编辑器，
    //   结果是"图片上传了一张 + 编辑器里还多出一段图片标记"。
    //   没有图片时**不 preventDefault**，让 Lexical 的 richText 正常处理纯文本粘贴。
    e.preventDefault();
    uploadImage(image);
  };

  root.addEventListener('dragenter', onDragEnter);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);
  root.addEventListener('paste', onPaste);

  return () => {
    root.removeEventListener('dragenter', onDragEnter);
    root.removeEventListener('dragover', onDragOver);
    root.removeEventListener('dragleave', onDragLeave);
    root.removeEventListener('drop', onDrop);
    root.removeEventListener('paste', onPaste);
    root.classList.remove(DRAGOVER_CLASS);
  };
}

/**
 * 折叠块交互。
 *
 * 形态与老项目一致：**标题行常驻，正文块可折叠**（老项目用行内锚 `span.ns-fold-mark`
 * + `ns-fold-body` 跨块分组；新项目用 `FoldNode` 这个 ElementNode 承载，
 * 结构上更干净，代价是要自己画标题行与正文容器）。
 *
 * 🔴🔴 开合态是 **ephemeral UI 态**（ARCH红线 R3）：`setOpen` 走 Lexical 的
 *   getWritable（会进 undo 快照），但 docToLexical / lexicalToDoc 两侧都不读它。
 *   若哪天把它写进 canonical，"我手机上展开一个折叠块"就会和电脑端产生一次
 *   **纯噪音同步冲突** —— 两个人什么都没改，却提示"两台设备改了同一处"。
 *
 * 🔴 点标题不能吞掉焦点：老项目是"点一下展开，光标仍在正文"，
 *   这里实现为「点标题只切换开合，不移动光标」，与老项目一致。
 *   吞掉焦点的话，用户想接着在正文里打字就必须多点一次，体感明显变差。
 */
function registerFoldBehavior(editor: LexicalEditor): () => void {
  const onClick = editor.registerCommand<MouseEvent>(
    CLICK_COMMAND,
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return false;
      // 🔴🔴🔴 命中判据：**只有三角（::before）才切换开合，点标题文字不切**。
      //   用户拍板：点标题文字 = 光标进去（可改标题）；点三角 = 展开/收起。
      //   与老项目一致：index.html `editor.addEventListener('click', e => {
      //     const mark = e.target.closest('span.ns-fold-mark');   // ← 只认三角那个 span
      //     if (!mark) return;                                    // ← 点标题文字直接不管
      //   })`。
      //
      //   bj 此前判的是 `.ns-fold > :first-child`（**整行**）⇒ 点文字也会展开/收起，
      //   用户报障「点击标题不符合预期地可以展开/收起」。
      //
      //   🔴 怎么判"点在三角上"：三角是 ::before（**没有自己的 DOM 盒子**），
      //   所以不能用 `target.closest('.ns-tri')`。可靠办法是**几何判据**：
      //   三角在标题行左侧，宽度固定（收起态 border-left 8px ⇒ 视觉宽约 8px，
      //   加上 margin-left 3px ⇒ 命中区取标题行左起 0~22px，与老项目
      //   `.ns-fold-mark::after` 那枚 18×20 透明感应区同量级）。
      //   命中区必须够大到手指点得到，又不能宽到吃掉标题第一个字。
      const foldDom = target.closest('.ns-fold');
      if (!foldDom) return false;
      const head = target.closest('.ns-fold > :first-child');
      if (!head || !foldDom.contains(head)) return false;
      // 点在正文的点击一律放行（用户可能正在编辑正文）
      if (!head.contains(target)) return false;
      // 🔴 几何判据：命中区 = 标题行左起 22px 内
      const hr = head.getBoundingClientRect();
      if (event.clientX - hr.left > 22) return false;
      // 🔴🔴 用 `$getNearestNodeFromDOMNode` 拿节点，**不要读 `dom.__lexicalKey`**。
      //   后者是 Lexical 挂在 DOM 上的**内部字段**，不保证存在、不保证名字不变：
      //   读不到就静默 return false，症状是「点标题毫无反应且零报错」——
      //   和 S5-d 那个「chip 只绑 keydown 没绑 click」是同一类：handler 压根没被调用。
      //   官方 API 在 bundled ESM 下可靠（走 DOM→key 的反查表，不碰私有字段）。
      const node = $getNearestNodeFromDOMNode(target);
      const fold = $isFoldNode(node) ? node : $getParentFold(node);
      if (!fold) return false;
      // 🔴 归一化要在切 open **之前**判：此刻光标还停在原位置，
      //   收起是 CSS 的 display:none，选区对象本身不会自动跑掉。
      const willCollapse = fold.open;
      fold.setOpen(!fold.open);
      if (willCollapse) $parkCaretOnFoldHead(fold);
      // 🔴🔴🔴 触屏必须收一次键盘（老项目 index.html:4425 折叠 click 处理器收尾第三行：
      //   `try { dismissKeyboardForTouch(); } catch (err) {}`
      //   注释原文：「触屏兜底：个别内核 touchstart 早于 mousedown 已聚焦，开合后收一次键盘（桌面/组字期为 no-op）」）。
      //
      //   病：点三角是**在 contenteditable 里点**，多数内核会顺手把焦点给编辑器 ——
      //   手机上那就是软键盘弹起来。用户明明只是收起了折叠列表（用户报障第 11 条）。
      //   桌面端这条是 no-op（`dismissKeyboardForTouch` 只认纯触屏），行为零变化。
      //
      // 🔴🔴🔴 **为什么必须延到 rAF，不能同步调**（探针实测，2026-10-07）：
      //   同步 blur **确实生效了**（trace：`blur#1=BODY` → `sync-after-dispatch=BODY`），
      //   但 handler 一返回，Lexical 就 commit 这次 update —— commit 会把 DOM Selection
      //   写进 contenteditable，**Chromium 在这一步隐式把焦点还给编辑器**
      //   （trace 紧接 `focus#4=DIV#editor-host.ns-editor`，之后 raf1/t0/t16/t120 全在编辑器）。
      //
      //   🔬 **不是谁调了 `.focus()`**：探针把 `HTMLElement.prototype.focus` 整个换掉
      //   抓栈，`__focusStacks` 是**空数组** —— 焦点是浏览器内部行为，JS 层抓不到调用点。
      //   所以"在 handler 里再补一次 focus/blur"这种改法注定无效，必须让开 commit 那一拍。
      //
      //   老项目为什么同步调就够了：它是**原生 contenteditable**，`applyFolds()` 里
      //   直接改 innerHTML，没有"commit 阶段回写 Selection"这一步 ⇒ 同步 blur 就是终态。
      //   bj 走 Lexical，多出来的正是这一拍。
      try {
        dismissKeyboardForTouch();
        requestAnimationFrame(() => {
          dismissKeyboardForTouch();
        });
      } catch {
        /* 收键盘失败绝不影响开合本身 */
      }
      // 不 preventDefault：标题行是 contenteditable 的一部分，
      // 阻止会让部分内核把点击当作文本选择起点。
      return true;
    },
    COMMAND_PRIORITY_LOW,
  );

  // 🔴 收起态标题上按 Enter：把**光标后的标题文字**搬到折叠块**外面**（用户报障第 5 条）。
  const unregisterEnter = registerFoldEnter(editor);

  return () => {
    onClick();
    unregisterEnter();
  };
}

/**
 * 🔴🔴 收起态的折叠标题上按 Enter —— **本组唯一会静默丢内容的一条**（用户报障第 5 条）。
 *
 * 症状：「收起时在标题末尾回车，应在折叠列表**外部**下方插空行，而非折叠列表内部」+
 *   「光标定位到标题中间回车，光标后方的文字应出现在外部下方一行」。
 *
 * 🔴🔴🔴 病根是三层叠加，缺一层都修不对（我为这条白绕了三轮）：
 *   ① Lexical 的 richText 对 ElementNode 内的回车默认**在容器内分裂** ⇒ 落进 body。
 *      而收起时正文 `display:none` ⇒ **字跑进看不见的地方**（内容损坏，不是功能缺失）。
 *   ② 手动 `parent.insertAfter(新段落)` 会在折叠块父级是 **root** 时抛
 *      **Lexical #55 `insertAfter: cannot be called on root nodes`**。
 *      抛错发生在 handler 内 ⇒ Lexical 认为命令未处理、回落richText ⇒ 症状与"没拦"一样。
 *      ⇒ 必须用 `$insertNodes([...])`。
 *   ③ 🔴 **就算插进去了也不生效**：新段落是**空的**，而空段落会被导出丢弃
 *      （`serialize.ts`：`if (spans.length === 0 && n.getType() === 'paragraph') return null`，
 *      设计如此——空段落是真源里不存在的形态）。
 *      空占位活不过一轮 update 往返 ⇒ 用户随后打的字又落回标题。
 *
 * ⇒ **正解不是"插一个空段落"，而是把标题切开**：光标后的文字搬成一个**非空**的
 *   段落放到折叠块**外面**，标题只保留前半段。非空段落不会被丢弃，于是：
 *     - 光标在中间 ⇒ 后半段出现在外部下方一行（用户第 2 小条）
 *     - 光标在末尾 ⇒ 后半段为空，此时**不留段落**（留了也会被丢），
 *       光标停在标题末尾，让用户直接打字落在标题末尾之外——
 *       ⚠️ 这一支需要在 title 末尾之外**没有**可落点时另想办法，本轮只实现"有可落点"的主路径。
 */
function registerFoldEnter(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    KEY_ENTER_COMMAND,
    (event) => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;

      const anchor = sel.anchor.getNode();
      const headPara = $isElementNode(anchor) ? anchor : anchor.getParent();
      if (!headPara || !$isElementNode(headPara)) return false;
      const fold = $getParentFold(headPara);
      if (fold === null) return false;
      // 标题 = 折叠块第一个子段落（nodes.ts 的设计，见其 createDOM 注释）
      if (fold.getFirstChild()?.getKey() !== headPara.getKey()) return false;
      // 只在收起态拦：展开态在正文里回车必须仍是"正文内分裂"
      if (fold.open) return false;
      if (fold.getParent() === null) return false;

      // 取标题 spans 与光标在其中的偏移
      const kids = headPara.getChildren();
      const spans: Span[] = [];
      let offset = 0;
      let cutAt = -1;
      for (const k of kids) {
        if (!$isTextNode(k)) return false;
        const t = k.getTextContent();
        spans.push({ t });
        const start = offset;
        offset += t.length;
        // 🔴🔴 cutAt 必须是 **start + sel.anchor.offset**，不是 offset（= 该 node 的末尾）。
        //   我第一版写成 `k.is(anchor) ? offset : …` ⇒ 无论光标在标题哪个位置，
        //   切点都落在**最后一个字之后** ⇒ 标题永不被切开（实测 cutAt 恒等于标题长度）。
        //   这就是"改了没反应"的原因，不是 Lexical 的问题。
        if (k.is(anchor)) cutAt = start + sel.anchor.offset;
      }
      if (cutAt < 0) return false;

      // 🔴 按**累计偏移**逐段切，不能对每段都用同一个 cutAt ——
      //   那样第 2 段之后全错位（此前写成 map+reduce 的嵌套表达式，
      //   既语法错、逻辑也错：每段都从头量）。
      const headSpans: Span[] = [];
      const tailSpans: Span[] = [];
      let acc = 0;
      for (const s of spans) {
        const start = acc;
        const end = acc + s.t.length;
        acc = end;
        if (start < cutAt) {
          headSpans.push({ ...s, t: s.t.slice(0, Math.min(s.t.length, cutAt - start)) });
        }
        if (end > cutAt) {
          tailSpans.push({ ...s, t: s.t.slice(Math.max(0, cutAt - start)) });
        }
      }
      const headText = headSpans.map((s) => s.t).join('');
      const tailText = tailSpans.map((s) => s.t).join('');

      // 标题侧：改写为前半段（非空才写，空则保留原标题）
      if (headText !== '') {
        headPara.clear();
        headPara.append(...spansToNodes(headSpans, new Set()));
        fold.setTitle(headSpans);
      }

      // 块外侧：只在**后半段非空**时建段落（空段落会被导出丢弃，留了也白留）
      if (tailText !== '') {
        const out = $createParagraphNode();
        out.append(...spansToNodes(tailSpans, new Set()));
        // 🔴🔴 `$insertNodes` 是**在当前选区处**插入，而此刻选区在折叠标题里
        //   ⇒ 直接调会把新段落塞进**折叠块内部**（= 块外没拿到东西，内部又多一块）。
        //   必须先把选区移到"折叠块这个节点本身"（元素选区），
        //   `$insertNodes` 才会把它插成**折叠块的后继兄弟**。
        const sel2 = $createRangeSelection();
        sel2.anchor.set(fold.getKey(), 0, 'element');
        sel2.focus.set(fold.getKey(), 0, 'element');
        $setSelection(sel2);
        $insertNodes([out]);
        out.selectEnd();
      } else {
        // 光标在末尾：停在标题末尾，不额外造会被丢弃的空段落
        headPara.selectEnd();
      }

      event?.preventDefault();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}

/** 行首折叠标记的文本。老项目 `index.html:4204 applyFolds` 用的就是这两个串。 */
const FOLD_OPEN_MARK = '[折叠]';
const FOLD_CLOSE_MARK = '[/折叠]';

/**
 * 自动建组的标题序号。**与 `commands.ts` 的 `foldSeq` 是两套计数器**，
 * 各自只给自己那条路径用 —— 共享一个会让"菜单插入"和"手打自动建"
 * 互相污染序号（用户在菜单插了第3 个，手打建出来的会跳到 5）。
 * 用户看到的是"折叠块 1 / 2 / 3"，两套计数器各自连续即可。
 */
let foldAutoSeq = 0;

/**
 * 🔴🔴🔴 行首 `[折叠]` → FoldNode 的自动识别（老项目 `applyFolds` 的 Lexical 等价物）。
 *
 * **为什么必须补这个**：老项目用户键入 `[折叠]` 就变成折叠块（`index.html:3977`
 * 在输入链末尾调`applyFolds()`，`foldSeedArmed` 只在 `insertText` 时置位）。
 * 新项目**这条路径完全不存在** —— `$createFoldNode` 只有两个调用点：
 *   - `commands.ts:49`（仅挂在 `__NOTESYNC_INSERT_FOLD__` 测试钩子上）
 *   - `serialize.ts:168`（从模型 JSON 还原，即**已有**文档里的折叠块）
 * ⇒ 用户手动键入 `[折叠]` 只是一行普通文本，**折叠功能对真实用户完全不可达**，
 *   而 e2e 全绿（它用钩子造场景）。这是典型的"测试通过但功能不可达"。
 *
 * **判据为什么只看「段首精确等于标记」**：
 *   - 老项目是「行首 `[折叠]`」触发，**不是**全文搜索 —— 否则正文里
 *     提到"[折叠]"三个字也会被吞掉变成结构，内容丢失。
 *   - 精确相等（`text === '[折叠]'`）而非 `startsWith`：因为用户紧接着
 *     要在**同一段**打标题。`[折叠]我的标题`这种要支持，所以判据是
 *     「以标记开头 + 标记后无内容或仅有空白」。
 *   - 已在FoldNode 内部的段落一律不处理（`$getParentFold` 命中就return），
 *     否则用户给折叠块改名时会被二次吞掉。
 *
 * **只在这一帧跑**：注册在 `editor.registerUpdateListener` 上，但靠
 * `dirty` 判定跳过非本帧输入，避免每次远端合并都重扫全文（O(n) 扫描
 * 挂在每次 update 上会在大文档上明显卡顿）。
 */
function $promoteFoldMarks(editor: LexicalEditor): void {
  const DBG = (window as unknown as { __FOLD_DBG__?: string[] }).__FOLD_DBG__;
  const dbg = (s: string): void => {
    if (DBG) DBG.push(s);
  };
  dbg('enter');
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) {
    dbg('no-collapsed-range-selection');
    return;
  }
  const anchor = sel.anchor.getNode();
  dbg('anchorType=' + anchor.getType());
  if (!$isTextNode(anchor)) {
    dbg('anchor-not-textnode');
    return;
  }
  // 🔴 判据用 `.is()`，不用 `===`：Lexical 节点是不可变快照对象，
  //   不同 editor state 下引用不同（behaviors.ts:207 已记过这条铁证）。
  if ($getParentFold(anchor) !== null) {
    dbg('inside-fold-skip');
    return;
  }

  const raw = anchor.getTextContent();
  dbg('raw=' + JSON.stringify(raw));
  if (!raw.includes(FOLD_OPEN_MARK)) {
    dbg('no-mark');
    return;
  }

  const startsFold = raw.startsWith(FOLD_OPEN_MARK);
  const startsClose = raw.startsWith(FOLD_CLOSE_MARK);
  if (!startsFold && !startsClose) {
    dbg('not-at-start');
    return;
  }
  // 🔴🔴🔴 闭合锚**绝不能**被当成开标记去建组。
  //   老项目 index.html:4101 `foldLeadInfo` 只匹配 FOLD_MARK（`[折叠]`），
  //   闭合锚另有 `foldEndKind`（:4101-4103）那一套判定，两者从不相交。
  //   本函数此前把两种标记合流处理，一旦放开门把判据（见下），
  //   用户打 `[/折叠]` 就会被**新建一个折叠块** —— 而老项目里闭合锚的语义是
  //   "把这一行挂到组尾/压成零高"，不是开新组。
  //   症状极隐蔽：正文里凭空多出一个空折叠块，且用户看不出多出来的是什么。
  if (startsClose) {
    dbg('close-mark-skip');
    return;
  }

  // 🔴🔴🔴 标记后**允许有内容**（老项目 index.html:4101 foldLeadInfo 的判据是
  //   `orig.slice(lead).indexOf(FOLD_MARK) === 0` —— 只看**行首**，后面跟什么都算把手）。
  //   本条曾写成 `if (rest.trim() !== '') return`，要求标记后必须为空，
  //   于是「用户打完标记紧接着打标题」这个**最自然的用法永远不成立**：
  //   用户输入 `[折叠]买菜清单`，rest = "买菜清单" 非空 → 直接 return → 什么也没发生。
  //   症状是"折叠功能我根本用不了"，而界面上没有任何提示说为什么
  //   （用户报障第 19 条：「怎么在笔记正文添加折叠列表」）。
  //
  //   为什么当初要加这条限制：怕用户正文里提到"[折叠]"三个字被误吞成结构。
  //   但那个担心已被"必须行首"这一条挡住了 —— 行中出现这三个字不会命中。
  //   老项目行首语义（v7.3.1 F2）不能动，所以这里照抄老项目，不自己加严。
  const rest = raw.slice(FOLD_OPEN_MARK.length);

  const para = anchor.getParent();
  if (para === null || !$isElementNode(para)) {
    dbg('parent-not-element');
    return;
  }
  // 🔴 只处理**段落的第一个孩子**是标记的情况。若标记在段落中间
  //   （用户先打了别的字再打标记），结构上不成立，不动。
  const first = para.getFirstChild();
  dbg('firstKey=' + (first ? first.getKey() : 'null') + ' anchorKey=' + anchor.getKey());
  if (first?.getKey() !== anchor.getKey()) {
    dbg('not-first-child');
    return;
  }

  // 标题 = 标记之后到段末的可见文字（老项目：把手行的标题就是行首标记之后的那截）
  // 🔴 剥零宽字符（ZWSP/ZWNJ/BOM/word-joiner）：老项目 linkify 会往长词里插 ZWSP
  //   （index.html:10944 nsStripZW 就是干这个的），标记与标题之间也可能有。
  //   不剥的话标题里会藏一个不可见字符 —— 用户看着是"买菜清单"，
  //   点开折叠后标题前后多一个幽灵字符，复制出去还带着它。
  const title = rest.replace(/[‌‍⁠﻿]/g, '');
  // 🔴🔴🔴 标题 span **不能是空串**。FoldNode.getTextContent() 走
  //   `title.map(s => s.t).join('')`，空标题会让折叠块文本为空 ——
  //   而序列化/复制/搜索都读它。更要紧的是：老项目新建的折叠块，
  //   标题占位就是"折叠块 N"（`commands.ts:47` 同款），不是空。
  //   这里用同样的占位，保证用户点开就看到可辨认的把手。
  const placeholder = `折叠块${String(++foldAutoSeq)}`;
  const titleSpans: Span[] = [{ t: title === '' ? placeholder : title }];
  const headText: string = titleSpans[0]?.t ?? placeholder;

  const head = $createParagraphNode();
  head.append($createTextNode(headText));
  const fold = $createFoldNode(JSON.stringify(titleSpans), true);
  fold.append(head);

  // 🔴🔴🔴 吸收：把手以下的块要搬进这个 FoldNode（用户报障第 6 条）。
  //
  // 老项目权威判据**不是读源码推的**，是真浏览器实测（Playwright 打开老项目
  // index.html，逐字符固定节奏敲键盘，读 `#editor` 直接子块的 className）。
  // 场景与实测结果（详见 test/fold-absorb.test.mjs 文件头）：
  //   [折叠] / 内容一 / 内容二 / (空)      → 组内 = 内容一 + 内容二
  //   [折叠]买菜清单 / 内容一 / 内容二     → 同上
  //   [折叠] / 内容一 / (空) / 组外        → 组内 = 内容一；**空行与其后内容留在组外**
  //   [折叠]组一 / 甲 / [折叠]组二 / 丙→ 组一只吃到「甲」，下一个把手截断
  //   [折叠]买菜 / 1、橙子 / 2、苹果 / [/折叠] → 独立行锚**不进正文**，它前面那些才是
  //
  // ⇒ 三条边界规则：
  //   R1 从把手的**下一块**开始吸（不是从把手本身）
  //   R2 遇**空行**停 —— 口径是老项目 **v10.1.2**（`index.html:4382-4388`，
  //      「建组那一刻按『空行切』定界，并立刻落一枚闭合锚把边界冻住」）
  //   R3 遇**下一个把手**停（两组不串味）；无空行则一路收到文末
  //
  // 🔴🔴 **v10.0.3 与 v10.1.2 不是新旧取代，别只读源码就下结论**：
  //   `index.html:4034-4040`（v10.0.3）写着「空行彻底退出边界判定 → 标题以下全归组」，
  //   `applyFolds:4289-4298` 的定界循环也确实只有两个 break。看起来 v10.1.2 已被取代 —— **错**。
  //   v10.1.2 版本号更大、且注释明写「（用户拍板）」，它由 `applyFolds:4286` 在
  //   `seedArmed && 本帧新增把手` 时调 `seedFoldGroup:4399-4404`，**保留了
  //   `isBlankFoldLine` break 并立刻补锚把边界冻住**。
  //   ⇒ 现行口径 = v10.1.2：**建组帧**按空行切，之后组内可自由打空行（边界已冻结）。
  //   沿革注释描述的是被 v10.1.2 **收紧过**的那条路径，不是被删掉了。
  //   （Agent 在这条上两次栽相反的错，两次都是只读源码下结论 —— 详见
  //    `$collectFoldAbsorb` 里那段长注释。）
  //
  // 🔴 为什么不能靠 `$insertNodes` 之后再"找后面的兄弟"：本函数此刻
  //   `para` 还在 root 上、其后兄弟也都还在，中途改结构会让 `para` 的
  //   `getNextSibling()` 链在遍历过程中失效（Lexical 节点是不可变快照，
  //   边搬边取下一兄弟会拿到已 detach 的节点）。所以**先收集、后一次性搬**。
  const absorb = $collectFoldAbsorb(para);
  for (const node of absorb.absorbed) {
    fold.append(node);
  }
  if (absorb.absorbed.length === 0) {
    // 一个都没吸到 ⇒ 补一个空正文段，否则 FoldNode 只有标题、
    // 用户点开无处可打字（老项目是 `ns-fold-body` 的 gap 段）。
    fold.append($createParagraphNode());
  }
  if (absorb.anchorRemoved && absorb.anchorNode && absorb.anchorNode.isAttached()) {
    absorb.anchorNode.remove();
  }

  // 🔴🔴🔴 判据：`para.getFirstChild()?.getKey() === anchor.getKey()` 之后
  //   **不能**直接 `para.replace(fold)`。实测（探针记录）：
  //     enter → anchorType=text → raw="[折叠]" → firstKey=2 anchorKey=2 → REPLACED-OK
  //   探针说替换成功，但**真源与 DOM 一字未变**。
  //   原因：fold / head / body 三个节点都是**游离**的（从未 append 进 root），
  //   `Node.replace()` 在 Lexical 里是 "replace this node with that node"，
  //   对未挂载的目标节点走的是 `removeNode` + 一次 no-op 插入，
  //   **不抛错、不告警** —— 又是静默降级。
  //
  // 🔴🔴🔴 顺序：**先删 para，再插 fold**。
  //
  //   早先写的是 `$insertNodes([fold]); para.remove();`（注释里还写"顺序不能反"）——
  //   **错的方向**。它在 headless 单测里 4/4 全绿，但挂载 rootElement 的真实编辑器里
  //   `$insertNodes` 会把 fold 插到 para **之前**并接管选区，
  //   此后 `para` 已不是可稳定 remove 的挂载节点 ⇒ `para.remove()` **静默不生效**
  //   （不抛错、不告警 —— 又是静默降级）。
  //   e2e 实测症状：**原文凭空多出一份**（内容复制损坏，最严重的一类）：
  //     DOM: DIV.ns-fold:"内容一内容二"   ← 折叠块
  //          P.ns-p:"内容一"              ← 🔴 原文残留，复制粘贴会带出两份
  //   FOLD-14（11-fold-autocreate.test.js）钉的就是这条。
  //
  //   🔴 教训：**headless 单测绿 ≠ 真编辑器绿**。`$insertNodes` 的行为分叉点在
  //     "有没有 rootElement"，而 headless 夹具永远测不到那一支。
  //     凡涉及挂载/选区/DOM 顺序的判据，必须落在 e2e。
  //
  //   反过来先删再插就干净：`para.remove()` 先把原段落摘出树，
  //   `$insertNodes([fold])` 按**当前树**算插入点 ⇒ fold 落到 para 原来的位置。
  //   光标也不会弹到文档开头：$insertNodes 会把选区放进新插入的 fold。
  // 🔴🔴🔴 必须用**树上重新取到的节点**来删，不能用闭包里那个 `para` 引用。
  //
  //   踩坑过程（每一版都被 e2e FOLD-14 抓住，全部报"内容一"残留）：
  //     v1 `$insertNodes([fold]); para.remove();`
  //        → 插到 para 之前并接管选区，para 引用失效 ⇒ 静默不删
  //     v2 `para.remove(); $insertNodes([fold]);`（以为只是顺序问题）
  //        → 顺序对了，但**这个 `para` 是 `$isElementNode(anchor.getParent())`
  //           那一轮拿到的快照引用**；本函数中间又做了 `$collectFoldAbsorb`
  //           与多次 `fold.append(...)`，Lexical 的节点在 update 期间会
  //           被换成新版本的对象 ⇒ `para.remove()` 作用在一个**旧版本**上，
  //           静默不生效（不抛错）。
  //   正解：记下 `para.getKey()`，删之前用 `$getNodeByKey(key)` 取**当前版本**。
  //   `$getNodeByKey` 在 update 内返回的是可写（getLatest）节点。
  //
  // 🔴🔴🔴 但光"删 para 再 $insertNodes" 还不够 —— **会插到文档开头，凭空多出空壳块**。
  //   探针 G 实测（场景 组一/甲内容/[折叠]组二/乙内容，dbg: absorbed=1 吸收本身是对的）：
  //     FINAL 真源: fold(折叠块1)[]  fold(组一)[甲内容]  fold(折叠块1)[组二|乙内容]
  //     DOM:        ["", "组一甲内容", "折叠块1组二乙内容"]
  //   ⇒ 最前面多了一个**空的** fold(折叠块1)，真正的组一被挤到第二位。
  //   原因：`para.remove()` 会把**选区一起摘掉**（选区锚点就在 para 内），
  //   `$insertNodes([fold])` 按"当前选区"算插入点 ⇒ 选区已失效 ⇒ 落到 root 开头。
  //   ⇒ 必须**显式指定插入位置**：删 para 之前记住它在 root 里的**下一个兄弟**，
  //     删完把 fold 插到那个兄弟**之前**；没有下一个兄弟就 append 到 root末尾。
  //   （不能用 `para.insertAfter(fold)`：fold 是游离节点，
  //     ElementNode.insertAfter 要求目标已挂载 —— 那正是上面记的"replace 对游离目标 no-op"同款坑。）
  const paraKey = para.getKey();
  const anchorNext = para.getNextSibling();
  const anchorNextKey = anchorNext === null ? null : anchorNext.getKey();
  para.remove();
  const live = $getNodeByKey(paraKey);
  if (live !== null) live.remove();

  if (anchorNextKey === null) {
    $getRoot().append(fold);
  } else {
    const anchor = $getNodeByKey(anchorNextKey);
    if (anchor === null) $getRoot().append(fold);
    else anchor.insertBefore(fold);
  }
  // 🔴 光标必须显式落进新块。`para.remove()` 把选区一起摘了，
  //   不重落的话用户会看到"打完了标记，光标不见了"—— 下一次按键会打到未知位置。
  //   落点用 `commands.ts` 的 placeCaret 同款口径：**update 内用节点 API 落选区**，
  //   落点选"正文第一段的末尾"（buildHead 刚建的那一段还没有孩子，
  //   所以要用 paragraph 的 end-of-line point，不是 text point）。
  try {
    const firstBody = fold.getChildAtIndex(1) ?? fold.getFirstChild();
    if ($isElementNode(firstBody)) {
      const sel2 = $createRangeSelection();
      const p = $createPoint(firstBody.getKey(), firstBody.getChildrenSize(), 'element');
      sel2.anchor = p;
      sel2.focus = p;
      $setSelection(sel2);
    }
  } catch (eCaret) {
    // 光标落点失败**不许**影响建组本身（正文已经正确成形）
  }
  dbg('INSERTED-OK absorbed=' + absorb.absorbed.length + ' paraRemoved=' + (live === null));
}

/**
 * 收集「把手以下、到边界为止」应当被吸进折叠组的块。老项目 `applyFolds`
 * （index.html:4289-4298）的 Lexical 等价物，边界规则见 `$promoteFoldMarks` 里
 * R1~R3 的注释（判据来自源码 + 真浏览器实测，不是猜）。
 *
 * @param handlePara 把手所在段落（它的下一块才是正文起点）
 */
function $collectFoldAbsorb(handlePara: ElementNode): {
  absorbed: ElementNode[];
  anchorNode: ElementNode | null;
  anchorRemoved: boolean;
} {
  const absorbed: ElementNode[] = [];
  let anchorNode: ElementNode | null = null;
  let anchorRemoved = false;

  let cur = handlePara.getNextSibling();
  while (cur !== null) {
    if (!$isElementNode(cur)) break;
    const node: ElementNode = cur;
    const text = node.getTextContent();

    // R2 独立行锚：`[/折叠]`。老项目把它排除在正文外（ns-fold-endline 压 0 高）。
    //   注意必须在 R3 之前判：`[/折叠]` 与 `[折叠]` 前缀相似但**不是**把手。
    if (text.trim() === FOLD_CLOSE_MARK) {
      anchorNode = node;
      anchorRemoved = true;
      dbgAbsorb('stop-anchor');
      break;
    }

    // R3 下一个把手截断（两组不串味）。
    //
    // 🔴🔴🔴 必须**同时认两种把手**，这是 e2e 探针抓到的结构损坏级 bug：
    //   老项目 `applyFolds:4290` 判的是 `foldLeadInfo(blocks[k])`，
    //   而 `foldLeadInfo`（index.html:4079-4080）对**已渲染**的把手块同样命中
    //   ——它认的是「首子是 ns-fold-mark span」或「行首 [折叠] 文本」两条。
    //   ⇒ 一个**已经建好的 FoldNode** 就是把手，必须截断。
    //
    //   我第一版只判文本前缀 `startsWith('[折叠]')`，漏了 FoldNode 这一支。
    //   症状（探针E 实测，场景 组一/甲内容/[折叠]组二/乙内容）：
    //     敲完第3 行时它自己建了一个 fold（title=折叠块1, children=[组二, 乙内容]），
    //     之后我回首行补 `[折叠]` 建组一 ⇒ **R3 没命中**，
    //     整个第二个 fold 被吞进组一，DOM 变成：
    //       DIV.ns-fold:"组一甲内容折叠块1组二乙内容"   ← 一个块里塞了两组
    //     而组一的标题还退化成占位符 `折叠块1`（= 把第二个 fold 的标题当成了自己标题）。
    //   这是内容损坏 + 标题错位，比"吞掉几行正文"严重得多。
    if ($isFoldNode(cur) || text.replace(/^[‌‍⁠﻿]+/, '').startsWith(FOLD_OPEN_MARK)) {
      dbgAbsorb('stop-next-handle');
      break;
    }

    // R2 空行截断 —— 口径是**老项目 v10.1.2**（`index.html:4382-4388`，
    // 「v10.1.2（用户拍板）：建组那一刻按『空行切』定界，并立刻落一枚闭合锚把边界冻住」）：
    //   「在标题行行首敲 [折叠] 时只吞紧邻的连续非空行 —— 紧随的空行与其后的内容留在组外；
    //     但组内此后可以自由打空行（边界由锚冻结，不再重算）。」
    //   配例（老项目逐字）：
    //     甲 / 空 / A          → 空组，锚挂把手行尾，空行与 A 全在组外
    //     甲 / 乙 / 丙丁 / 空 / A → 组内＝乙、丙丁，空行与 A 在组外
    //
    // 🔴🔴 **别被 v10.0.3 那段沿革注释骗了**（`index.html:4034-4040` 写着
    //   「空行彻底退出边界判定 → 标题以下全归组」）。那是**每帧重算**路径
    //   （`applyFolds:4289-4298` 只有两个 break，空行走 `:4307` 被标
    //   `ns-fold-gap`，靠引导线表达"组内的可见空隙"）。
    //   而 v10.1.2 比它**更晚**，走的是 `seedFoldGroup:4399-4404`（由
    //   `applyFolds:4286` 在 `seedArmed && 本帧新增把手` 时调一次）：
    //   它保留 `isBlankFoldLine` break，并**立刻补一枚 `[/折叠]` 锚把边界冻住**。
    //   ⇒ 两者不是"新旧取代"，而是"v10.1.2 用锚把 v10.0.3 的空行宽松限制在正确处"：
    //     **建组那一刻**按空行切，之后组内可以自由打空行（不再重算边界）。
    //
    // 🔴 我（Agent）在这条上栽过两次相反的错，两次都是**只读源码就下结论**：
    //   第一次照抄 seedFoldGroup 写了空行 break，却没意识到判据文件头钉的是
    //   「空行不截断」，红的是判据；
    //   第二次反向"纠错"，把 break 删掉并断言 v10.1.2 是遗留路径 —— 方向正好反了。
    //   真判据：**版本号更大的那次拍板才是现行口径**；v10.0.3 的沿革注释
    //   描述的是被 v10.1.2 收紧过的那条路径，不是把它删掉了。
    //
    // bj 侧等价实现：FoldNode 的边界由 children 范围天然表达，
    //   不需要可见锚文本（老项目要落锚只是因为它是 contenteditable，
    //   边界得靠 DOM 标记冻结）—— 但**"建组帧按空行切"这个时序必须照做**，
    //   否则「打完标题随手敲个空行、后面正文全掉出组」正是用户报障第 6 条的原症状。
    const blank = text.replace(/[‌‍⁠﻿]/g, '').trim() === '' && !$hasImageChild(node);
    if (blank) {
      dbgAbsorb('stop-blank');
      break;
    }

    absorbed.push(node);
    cur = node.getNextSibling();
  }

  return { absorbed, anchorNode, anchorRemoved };
}

/** 折叠块里是否含图片（空行判定用；老项目 isBlankFoldLine 的 img 排除项）。 */
function $hasImageChild(node: ElementNode): boolean {
  return node.getChildren().some((c) => c.getType() === 'image' || c.getType() === 'decorator');
}

/** 吸收边界的调试记录（与 $promoteFoldMarks 共用同一个 __FOLD_DBG__ 通道）。 */
function dbgAbsorb(s: string): void {
  const DBG = (window as unknown as { __FOLD_DBG__?: string[] }).__FOLD_DBG__;
  if (DBG) DBG.push('absorb:' + s);
}

/**
 * 把「本帧有纯文本插入」当作折叠识别的触发条件。
 *
 * 🔴 为什么不能挂在**每次** update 上：$promoteFoldMarks 里是段首精确匹配，
 *   挂在远端合并 / 撤销 /格式化这些 update 上会做无意义的全文扫描，
 *   大文档（几百段）下每次按键都多扫一遍 = 可感知的卡顿。
 *   老项目用 `foldSeedArmed` 标志位做同一件事（`index.html:5033`：
 *   `if (realType && (it === 'insertText' || it.indexOf('insertComposition') === 0))`），
 *   这里照搬这个思路 —— 判据放在**DOM beforeinput** 上，编辑器 update
 *   时读标志位，读完立刻清（老项目 `index.html:4208` 同样"取完即清"，
 *   注释写明"异常路径也不留下 armed，否则下一轮撤销/开合会被误判成新建组再切一刀"）。
 */
function registerFoldAutoCreate(editor: LexicalEditor): () => void {
  let armed = false;

  const onBeforeInput = (ev: Event): void => {
    const e = ev as InputEvent;
    // 合成输入（中文/日文 IME 打字）也要 arm：老项目判据含
    // `insertComposition` 前缀，理由是 IME 上屏那一下才真正落下文字。
    const t = e.inputType ?? '';
    armed = t === 'insertText' || t.startsWith('insertComposition');
  };

  const root = editor.getRootElement();
  root?.addEventListener('beforeinput', onBeforeInput);

  const unregisterUpdate = editor.registerUpdateListener(({ editorState, dirtyElements }) => {
    if (!armed) return;
    // 🔴🔴🔴 取完即清，且**必须清在前面**（老项目 index.html:4208 同款纪律：
    //   "异常路径也不留下 armed，否则下一轮撤销/开合会被误判成新建组再切一刀"）。
    armed = false;
    if (dirtyElements.size === 0 && editorState.isEmpty()) return;
    // 🔴🔴🔴 这里**不能**直接 editor.update()：registerUpdateListener 的回调
    //   是在 Lexical **自己的 update 事务提交过程中**被调用的，此时发起嵌套
    //   editor.update() 会被 Lexical 判为"嵌套更新"并**静默丢弃**
    //   （不抛错、不生效 —— 又是静默降级）。
    //   老项目是命令式 DOM 操作（applyFolds 直接改innerHTML），不存在这个问题；
    //   Lexical 下必须**推迟到下一个宏任务**，让它成为一次独立的事务。
    //   判据记忆口诀：listener 里只"读+记"，改写一律 setTimeout 出去。
    setTimeout(() => {
      if (editor.isEditable() === false) return;
      promoteFoldMarksNow(editor);
    }, 0);
  });

  return () => {
    unregisterUpdate();
    root?.removeEventListener('beforeinput', onBeforeInput);
  };
}

/**
 * 🔴 触发一次折叠自动建组 —— **生产路径与测试判据共用的唯一入口**。
 *
 *   为什么要专门抽这个函数：自动建组的真实链路是
 *     beforeinput(armed) → registerUpdateListener → setTimeout → editor.update
 *   单元测试（headless Lexical，不挂 rootElement）**走不到 beforeinput**，
 *   所以判据没法驱动真实链路。
 *   早先我在判据里自己写 `globalThis.__NOTESYNC_FOLD_PROMOTE__` 钩子，
 *   结果判据红的原因只是"钩子不存在"—— **红得没有意义**，
 *   那种红证明不了bug 存在，是自欺欺人（违反"恒真/假红断言等于没有断言"）。
 *   现在这个包装函数与setTimeout 里调的是**同一个函数**，
 *   判据红 ⇒ 生产实现真的没做吸收，判据绿 ⇒ 生产实现真的做了。
 */
export function promoteFoldMarksNow(editor: LexicalEditor): void {
  editor.update(() => $promoteFoldMarks(editor), { discrete: true });
}

/**
 * 把光标从「收起的隐藏正文」弹回**标题末尾**（老项目 `foldCaretNormalize` 同款护栏）。
 *
 * 🔴🔴 为什么必须有这个护栏（老项目注释里写着「探针实锤」）：
 *   真实路径是「展开 → 点进正文打字 → 点标题三角收起」。收起后正文整块
 *   `display:none`，屏幕上什么都看不见，但**光标还在里面**。用户接着按退格，
 *   啃掉的是**标题的字** —— 这是内容损坏，比功能缺失严重得多。
 *
 * 🔴 落点取标题末尾，不是行最左位。老项目注释解释得很清楚：
 *   自动落最左位的话，下一记退格会走「原子整删 `[折叠]`」，
 *   一记键把整组折叠结构连同隐形 `[/折叠]` 锚一起删掉，还自动上云。
 *   「自动落点不许是一步就出事的位置」。
 *
 * 🔴 只在光标确实落在本块内时才动（老项目先 `editor.contains(...)` 再判 hide，
 *   同向）。不许因为「点了一下标题」就顺手把别处的光标拽过来。
 *
 * 🔴 只处理 collapsed 选区：扩选状态老项目也是直接 return 的，这里保持同款，
 *   不自作聪明去推断跨选落点。
 */
function $parkCaretOnFoldHead(fold: FoldNode): void {
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;

  // 🔴🔴🔴 判据一：必须沿 getParent() 链上溯，**不能靠 sel.getNodes()**。
  //
  //   探针实锤（2026-10-05）：折叠正文里 collapsed 选区下
  //     sel.getNodes() 只返回 **1 个节点**（正文那个 TextNode，key=7），
  //     折叠块自身（key=5）**不在里面** —— getNodes 对 collapsed 选区
  //     只返回「选区触及的节点」，**不含任何祖先**。
  //   所以 .some(n => n === fold || $getParentFold(n) === fold) 恒 false，
  //   护栏静默失效：光标留在 display:none 的正文里，退格啃标题。
  //
  // 🔴🔴🔴 判据二：比节点**必须用 .is()，绝不能用引用相等 ===**。
  //
  //   同一次探针的下一层铁证：parentFoldKey 与 foldKey 都是 5（同一个节点），
  //   但 === 判 false。
  //   原因：Lexical 的节点是**不可变快照对象**，getWritable() / getLatest()
  //   在不同 editor state 下会给出**不同的对象实例**（key 相同、内容相同、
  //   引用不同）。官方 .d.ts 原文：
  //     "Returns true if the provided node is the exact same one as this node,
  //      from Lexical's perspective. **Always use this instead of referential
  //      equality.**"
  //   我第一版写的正是被官方明令禁止的引用相等 —— 判据恒 false、护栏恒失效、
  //   零报错。这是本项目「静默降级」清单上的又一条。
  const parentFold = $getParentFold(sel.anchor.getNode());
  if (!parentFold || !parentFold.is(fold)) return;

  const head = fold.getFirstChild();
  // 🔴 `getFirstChild()` 的声明返回 `LexicalNode | null`（基类上没有
  //   getLastDescendant），必须先用 `$isElementNode` 收窄，否则 TS2339。
  if (!head || !$isElementNode(head)) return;

  // 🔴 用 `getLastDescendant()` 而不是 `getAllTextNodes()` ——
  //   后者在 0.52 **已被删除**（TS2339），`getLastDescendant<T>()` 的类型参数
  //   也已标 @deprecated。按官方口径：不传类型参数，拿回来再用类型守卫收窄。
  const last = head.getLastDescendant();

  // 🔴🔴 落点必须走 `$createPoint` + `$setSelection`，**不能写 sel.anchor.set(...)**。
  //   `RangeSelection.anchor` 的声明类型是 `PointType`（TextPointType | ElementPointType
  //   的联合），TS 解析联合上的同名方法时报 TS2349「不是可调用表达式」——
  //   即使运行时它就是对象方法、也确实是官方 Point API。
  //   绕法不是加 `as any`（那会丢掉这层的类型保护），而是：
  //   `$createRangeSelection()` 建一个空选区 → 直接改写它的 anchor/focus 字段
  //   （声明里两者都是可读的 `PointType`，赋 `$createPoint(...)` 的返回值合法）
  //   → `$setSelection`。全程类型安全，且只用公开导出。
  const point = last && $isTextNode(last)
    ? $createPoint(last.getKey(), last.getTextContentSize(), 'text')
    : $createPoint(head.getKey(), 0, 'element');

  const next = $createRangeSelection();
  next.anchor = point;
  next.focus = point;
  next.format = sel.format;
  next.style = sel.style;
  $setSelection(next);
}

/** 从任意节点向上找到最近的 FoldNode（点标题时命中的是 head 段落本身，不是 FoldNode）。 */
function $getParentFold(node: LexicalNode | null): FoldNode | null {
  let cur: LexicalNode | null = node;
  // 上限 5 层：DOM 单层（.ns-fold > 标题段落 / 正文段落），节点树上最多两层。
  //   设上限是为了在「DOM 与节点树失配」时能退出，而不是死循环。
  for (let i = 0; i < 5 && cur; i += 1) {
    if ($isFoldNode(cur)) return cur;
    cur = cur.getParent();
  }
  return null;
}

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

import type { LexicalEditor } from 'lexical';
import {
  $createParagraphNode,
  $createPoint,
  $createRangeSelection,
  $createTextNode,
  $getNearestNodeFromDOMNode,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  type LexicalNode,
} from 'lexical';

import { registerAutoLink } from '@lexical/link';
import { registerList } from '@lexical/list';
import { registerRichText } from '@lexical/rich-text';

import { $createFoldNode, $isFoldNode, type FoldNode } from './nodes.ts';
import type { Span } from '@bj/shared-schema';

/**
 * 注册全部编辑行为。
 *
 * 🔴 必须在 `editor.setRootElement(...)` **之后**、任何 `editor.update(...)` 之前调用：
 *   setRootElement 会触发一次 reconcile 与 `$commitPendingUpdates`，
 *   在它之前注册则行为插件看不到稳定态的 root 绑定。
 *
 * @returns 注销函数（逆序执行）。S4 热重载与测试隔离会用到。
 */
export function registerBehaviors(editor: LexicalEditor): () => void {
  // 自动链接：输入 URL / 邮箱并敲空格或标点时自动转链接。
  // 🔴 用 `registerAutoLink` 而不是 `registerLink`：后者的签名是
  //   `registerLink(editor, stores: NamedSignalsOutput<LinkConfig>)`，
  //   第二个参数是 Extension 体系内部的 signal store —— 本项目不引React 就没有它，
  //   TS2554 直接报出来。`registerAutoLink(editor, config?)` 才是纯文本输入路径
  //   需要的那个入口，且 config 可整体省略。
  const unregisterAutoLink = registerAutoLink(editor);

  // 列表：Tab / Shift+Tab 缩进与反缩进、Enter 新建条目、Backspace 退出列表。
  const unregisterList = registerList(editor);

  // 折叠块：点标题行开合 + 光标在折叠块内按 Enter 自动展开。
  // 🔴🔴 必须注册在 list 之后、richText 之前：Lexical 的命令是「后注册者先询问」，
  //   折叠的点击处理若排在 richText 之后，会被 richText 的兜底抢走。
  const unregisterFold = registerFoldBehavior(editor);

  // 🔴 行首 `[折叠]` /`[/折叠]` 自动转成FoldNode（老项目 applyFolds 的等价物）。
  //   缺它= 折叠功能对真实用户完全不可达（只有 e2e 钩子能造）。
  const unregisterFoldAuto = registerFoldAutoCreate(editor);

  // 🔴 富文本兜底（含**打字能力本身**）—— 必须最后。
  //   漏掉它 = 编辑器能显示但打不了字，且**零报错**（见文件头）。
  const unregisterRichText = registerRichText(editor);

  return () => {
    // 逆序注销，与注册顺序严格相反
    unregisterRichText();
    unregisterFoldAuto();
    unregisterFold();
    unregisterList();
    unregisterAutoLink();
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
      // 🔴 命中判据是 `.ns-fold > :first-child`（标题段落），与 styles.css 一一对应。
      //   不用 `closest('.ns-fold')` 再判断点在标题还是正文 —— 后者要在正文里
      //   排除一切点击，边界多且脆；而「标题是第一个子段落」是结构事实，判据唯一。
      // 🔴 判据必须用 **child combinator**：只写 `.ns-fold` 会命中整个折叠块，
      //   于是点正文也会切换开合（用户正在编辑正文，块忽然收起，光标丢失）。
      const foldDom = target.closest('.ns-fold');
      if (!foldDom) return false;
      const head = target.closest('.ns-fold > :first-child');
      if (!head || !foldDom.contains(head)) return false;
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
      // 不 preventDefault：标题行是 contenteditable 的一部分，
      // 阻止会让部分内核把点击当作文本选择起点。
      return true;
    },
    COMMAND_PRIORITY_LOW,
  );

  return () => {
    onClick();
  };
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

  // 标记后面必须只剩空白（用户还没打标题）—— 打了就说明标题已在，
  // 这时**不**自动建组，让用户能自由编辑标题（老项目同款：先打完再识别）。
  const rest = startsClose ? raw.slice(FOLD_CLOSE_MARK.length) : raw.slice(FOLD_OPEN_MARK.length);
  if (rest.trim() !== '') {
    dbg('rest-not-blank=' + JSON.stringify(rest));
    return;
  }

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

  // 标题 = 标记之后到段末的可见文字（当前恒为空，标题随后由用户接着打）
  const title = rest;
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
  const body = $createParagraphNode();
  const fold = $createFoldNode(JSON.stringify(titleSpans), true);
  fold.append(head, body);

  // 🔴🔴🔴 判据：`para.getFirstChild()?.getKey() === anchor.getKey()` 之后
  //   **不能**直接 para.replace(fold)。实测（探针记录）：
  //     enter → anchorType=text → raw="[折叠]" → firstKey=2 anchorKey=2 → REPLACED-OK
  //   探针说替换成功，但**真源与 DOM 一字未变**。
  //   原因：fold / head / body 三个节点都是**游离**的（从未append 进 root），
  //   `Node.replace()` 在 Lexical 里是 "replace this node with that node"，
  //   对未挂载的目标节点走的是 `removeNode` +一次 no-op 插入，
  //   **不抛错、不告警** —— 又是静默降级。
  //   正确姿势：走 `$insertNodes`（由 Lexical 负责挂载 + 选区落到新节点），
  //   再把原段落删掉。顺序不能反：先插后删，光标才不会被弹到文档开头。
  $insertNodes([fold]);
  if (para.isAttached()) para.remove();
  dbg('INSERTED-OK');
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
      editor.update(() => $promoteFoldMarks(editor), { discrete: true });
    }, 0);
  });

  return () => {
    unregisterUpdate();
    root?.removeEventListener('beforeinput', onBeforeInput);
  };
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

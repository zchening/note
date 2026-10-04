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

import { registerAutoLink } from '@lexical/link';
import { registerList } from '@lexical/list';
import { registerRichText } from '@lexical/rich-text';

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

  // 🔴 富文本兜底（含**打字能力本身**）—— 必须最后。
  //   漏掉它 = 编辑器能显示但打不了字，且**零报错**（见文件头）。
  const unregisterRichText = registerRichText(editor);

  return () => {
    // 逆序注销，与注册顺序严格相反
    unregisterRichText();
    unregisterList();
    unregisterAutoLink();
  };
}

/**
 * 编辑器命令 —— 顶栏/菜单动作 → Lexical 行为的唯一通道
 *
 * 🔴 为什么单独一个文件：命令是「用户动作」与「文档变更」之间的接缝，
 *   散在 main.ts 里会让「哪些动作会改真源」这件事无法一眼看全，
 *   而它恰恰是同步正确性的关键（改真源 = 会推送 = 会产生合并）。
 *
 * 🔴 折叠块为什么用**自定义命令**而不是直接 API 调用：
 *   插入折叠块要动当前选区（把选区包进新的 FoldNode），
 *   而选区只能在 editor.update() 内改。让命令自己管update，
 *   调用方就只管dispatch —— 将来加键盘快捷键时不用再关心事务边界。
 */
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_EDITOR,
  type LexicalEditor,
} from 'lexical';

import { $createFoldNode, $isFoldNode } from './nodes.ts';
import { COPY } from './ui/copy.ts';
import { createCommand, type LexicalCommand, type LexicalNode } from 'lexical';

/** 「在光标处插入折叠块」命令。 */
export const INSERT_FOLD: LexicalCommand<{ title?: string } | undefined> =
  createCommand('NOTESYNC_INSERT_FOLD');

/**
 * 插入折叠块。参数：初始标题（默认走文案表，不在命令里写死中文）。
 *
 * 🔴 `seq` 用闭包计数而不是 `crypto.randomUUID()`：标题序号是**给用户看的**，
 *   随机 id 在列表里完全没法读，而"折叠块 2 / 折叠块 3"用户一眼就知道是第几个。
 */
let foldSeq = 0;

function insertFoldHandler(payload: { title?: string } | undefined): boolean {
  {
    const sel = $getSelection();
    if (!$isRangeSelection(sel)) return false;
    const title = payload?.title ?? `${COPY.foldDefaultTitle}${foldSeq > 0 ? ` ${foldSeq + 1}` : ''}`;
    foldSeq += 1;
    // 标题段落 + 一个空正文段落：空正文是必需的，否则用户点开无处打字。
    const head = $createParagraphNode();
    head.append($createTextNode(title));
    const body = $createParagraphNode();
    const fold = $createFoldNode(JSON.stringify([{ t: title }]), true);
    // 🔴 append() 在 .d.ts 里返回 `ElementNode | null`（Lexical 的历史签名）。
    //   这里刚 new 出来的节点不可能append 失败，非空断言是安全的；
    //   写成 if (fold.append(...)) 判空反而会在"理论上不可能"时静默不插入 ——
    //   那种"点了没反应"的故障比崩掉更难查。
    fold.append(head, body);
    $insertNodes([fold]);
    return true;
  }
}

/**
 * 把选区落到「第一个折叠块」的指定位置。**正式接口**（e2e 造场景用）。
 *
 * 🔴🔴 为什么必须提供它，而不是让 e2e 自己设 DOM 选区：
 *   `document.createRange()` 设的 DOM 选区**不会同步到 Lexical 内部选区**，
 *   之后 `keyboard.press('Enter')` 根本不进编辑器 ⇒ e2e 会把
 *   「实现有效」误判成「修复无效」。我在这上面白绕了很久才发现。
 *   而"点击标题行"也不是解法：点标题就是切换开合（既有设计），
 *   一敲折叠块被打开，拦截器判据②`!fold.open` 就不成立、按设计放行。
 *
 * 🔴 `ed.getRootElement()` 返回的是 **DOM 元素**、没有 `getChildren()`；
 *   拿 Lexical 节点必须用 `$getRoot()`（编辑器状态里的根节点）。
 *
 * @param where 'title-end' 标题末尾 ｜ 'body-start' 正文开头
 * @param offset 标题内的**字符偏移**（仅 'title-end' 有效）。不传 = 末尾。
 *   🔴 e2e 需要把光标放到标题**中间**来验"回车切开标题"（用户报障第 5 条第2 小条），
 *   而键盘方向键在无头环境下**移不动** Lexical 内部选区（实测 cutAt 恒等于末尾），
 *   所以必须由参数把位置**算准**，而不是靠模拟按键。
 * @returns 是否成功落到目标（false = 文档里没有折叠块）
 */
function $caretIntoFirstFold(where: 'title-end' | 'body-start', offset?: number): boolean {
  const root = $getRoot();
  const fold = root.getChildren().find((c) => $isFoldNode(c));
  if (!$isFoldNode(fold)) return false;
  if (where === 'title-end') {
    // 🔴 标题 = 折叠块的第一个子段落（nodes.ts FoldNode 的设计，见其 createDOM 注释）
    const head = fold.getFirstChild();
    if (!head) return false;
    if (offset === undefined) {
      head.selectEnd();
      return true;
    }
    // 落到指定字符偏移：跨多个 text node 时按累计长度找
    if (!$isElementNode(head)) return false;
    let acc = 0;
    for (const k of head.getChildren()) {
      if (!$isTextNode(k)) continue;
      const len = k.getTextContent().length;
      if (acc + len >= offset) {
        const at = Math.max(0, Math.min(len, offset - acc));
        k.select(at, at);
        return true;
      }
      acc += len;
    }
    head.selectEnd();
    return true;
  }
  // body-start：正文第一个段落；没有正文就退到标题末尾（并如实返回，让调用方知道）
  const head = fold.getFirstChild();
  const body = head ? head.getNextSibling() : null;
  if (!body) {
    if (head) head.selectEnd();
    return false;
  }
  body.selectStart();
  return true;
}

/** 把选区落到文档最后一个块（用于验"折叠块外面"的落点）。 */
function $caretAfterAllBlocks(): boolean {
  const blocks = $getRoot().getChildren();
  const last = blocks[blocks.length - 1];
  if (!last) return false;
  last.selectEnd();
  return true;
}

/** 注册全部自定义命令。返回注销函数。 */
export function registerCommands(editor: LexicalEditor): () => void {
  return editor.registerCommand(INSERT_FOLD, insertFoldHandler, COMMAND_PRIORITY_EDITOR);
}

/** 在光标处插入一个折叠块。 */
export function insertFoldAtCaret(editor: LexicalEditor): void {
  editor.update(
    () => {
      editor.dispatchCommand(INSERT_FOLD, undefined);
    },
    { discrete: true },
  );
}

/** 当前光标是否在折叠块里（菜单用它决定"折叠/展开"文案）。 */
export function $caretInFold(): boolean {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return false;
  // 🔴 getNode() 的返回类型含null（锚点可能落在已删除的节点上）。
  //   显式收窄成 `LexicalNode | null` 再进循环，不靠断言 ——
  //   断言在"锚点真为 null"时会变成后续的 undefined.getParent()，报错指向别处。
  let cur: LexicalNode | null = sel.anchor.getNode();
  for (let i = 0; i < 5 && cur; i += 1) {
    if ($isFoldNode(cur)) return true;
    cur = cur.getParent();
  }
  return false;
}

/**
 * 把选区落到指定位置（e2e 造场景用）。**正式接口**。
 *
 * 🔴 必须走 `editor.update(..., {discrete:true})`：Lexical 的选区只能在
 *   读函数（`$` 开头）里改，而那些函数只在 update 事务内可用。
 *   `discrete: true` 让它同步提交 —— 否则 e2e 紧接着读状态会读到旧值。
 */
export function placeCaret(
  editor: LexicalEditor,
  where: 'fold-title-end' | 'fold-body-start' | 'after-blocks',
  offset?: number,
): boolean {
  let ok = false;
  editor.update(
    () => {
      ok =
        where === 'after-blocks'
          ? $caretAfterAllBlocks()
          : $caretIntoFirstFold(where === 'fold-title-end' ? 'title-end' : 'body-start', offset);
    },
    { discrete: true },
  );
  // 🔴🔴 必须让**根元素拿到 DOM 焦点**，否则键盘输入根本不进来。
  //   Lexical 的"选区"有两层：编辑器状态里的节点选区 + 真实 DOM 选区。
  //   上面 update 里设的是前者；后者由 focus + 浏览器自己的 caret 跟随。
  //   实测只设前者时 `placeCaret` 返回 true、`keyboard.type('ZZZ')` 却什么也没打进去 ——
  //   症状与"实现无效"完全一样，极易误判（我在这上面又绕了一轮）。
  if (ok) {
    const rootEl = editor.getRootElement();
    if (rootEl) {
      rootEl.focus();
      // 🔴 focus() 之后再选一次：focus 会把 DOM caret 复位到上次位置，
      //   顺序反了的话 DOM 选区与节点选区会错位。
      // 🔴🔴 offset **必须再传一次**：漏传会让这一次无条件落回末尾
      //   （我第一版就漏了，于是 placeCaret(3) 实测 offset=6，前功尽弃）。
      editor.update(
        () => {
          $caretIntoFirstFold(where === 'fold-title-end' ? 'title-end' : 'body-start', offset);
        },
        { discrete: true },
      );
    }
  }
  return ok;
}

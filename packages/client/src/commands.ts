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
  $getSelection,
  $insertNodes,
  $isRangeSelection,
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

/**
 * 重建前后的**光标保位** —— 纯 Lexical 逻辑，可在 node --test 里直测
 *
 * 🔴🔴🔴 本文件存在的理由：用户报障 2026-10-14
 *   「不管是通过提醒面板添加提醒，还是通过正文里面添加提醒，
 *     添加成功之后，光标怎么一下子就从我添加提醒的位置跳到正文的最后面了？」
 *
 * ── 病态 ──────────────────────────────────────────────────────────────
 *   `docToLexical` 是 **`root.clear()` + 整篇重建**（serialize.ts:546）。
 *   加一条提醒后写真源要走它、对账算出整篇重建也走它；
 *   重建中所有节点 key 换新，**选区随之丢失**，Lexical 默认把光标落到 root 末尾。
 *   于是用户的光标"嗖"一下跑到正文最后一行 —— 添加前后正文一个字没变，
 *   只有光标乱跳，全程零报错。这是最容易让人以为"App 抽风"的那类故障。
 *
 * ── 为什么按「纯文本偏移」而不是按「节点 key」恢复 ────────────────────
 *   保存 anchorKey 那一套（`panelSavedSel`）只在**节点没换**时才有效：
 *   插行路径 insertRemLineToEditor 用它是对的（插入不换兄弟节点）。
 *   但 `docToLexical` 换掉**每一个** key，`$getNodeByKey(旧 key)` 恒为 null
 *   ⇒ 照 key 恢复必然落空（于是又回到文末）。
 *   纯文本偏移是**内容坐标**，重建前后正文逐字相等 ⇒ 偏移可直接映射回去。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────
 *   · 偏移口径**不含块间换行**（getAllTextNodes 只算文本节点内容）——
 *     读与恢复走同一口径即可自洽；块序号由"落在第几个文本节点"自然得出。
 *   · element 锚点（空段落里的光标）取该元素**起始处**的字符数 ——
 *     空段落里没有 TextNode 可落，退到段首比掉到文末合理得多。
 *   · 恢复**不改变** DOM 焦点（只写编辑器选区）——用户此刻焦点可能还在面板
 *     按钮/输入框上，抢焦点会把输入法键盘顶掉。
 */

import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type TextNode,
} from 'lexical';

/** 重建前调用：光标相对全文纯文本的偏移；无选区返回 null。 */
export function $readCaretOffset(): number | null {
  const sel = $getSelection();
  if (!sel || !$isRangeSelection(sel)) return null;
  const anchorNode = sel.anchor.getNode();
  const texts = $getRoot().getAllTextNodes();
  let off = 0;
  for (const t of texts) {
    if (t.getKey() === anchorNode.getKey()) return off + sel.anchor.offset;
    if (!t.isBefore(anchorNode)) break;
    off += t.getTextContentSize();
  }
  // element 锚点（空段落）／anchor 落在最后一个文本节点之后：取其起始处的累计值
  return off;
}

/** 重建后调用：按偏移把光标放回去。off 为 null 表示重建前无选区（不抢）。 */
export function $restoreCaretAt(off: number | null): void {
  if (off === null) return;
  const texts = $getRoot().getAllTextNodes();
  const place = (t: TextNode, at: number): void => {
    const size = t.getTextContentSize();
    const i = Math.max(0, Math.min(at, size));
    const sel = $createRangeSelection();
    sel.anchor.set(t.getKey(), i, 'text');
    sel.focus.set(t.getKey(), i, 'text');
    $setSelection(sel);
  };
  let acc = 0;
  for (const t of texts) {
    const size = t.getTextContentSize();
    if (off <= acc + size) {
      place(t, off - acc);
      return;
    }
    acc += size;
  }
  // 偏移超出（正文变短）⇒ 落到最后一个文本节点末尾，绝不落到 root 末尾之外
  const last: TextNode | undefined = texts[texts.length - 1];
  if (last) place(last, last.getTextContentSize());
}

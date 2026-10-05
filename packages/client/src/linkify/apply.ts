/**
 * 链接识别 —— Lexical 应用层
 *
 * 🔴🔴🔴 本文件是「模型 JSON 真源」架构下与老项目**最本质的差异**所在，
 *   所以先把差异讲清楚，否则后面每一条判据都会被误读成"多余"：
 *
 *   老项目是 contenteditable + DOM 即真源，所以它的 linkify 只能做**DOM 手术**：
 *   拆掉所有自动链接 → 拍平杂散 span → 遍历文本节点 → `replaceWith(buildLinkSafe(...))`，
 *   再手工用"块内字符偏移"保存/恢复选区。老项目为了这件事自建了一整套撤销栈
 *   （index.html:2464-2501 记着原生撤销栈被 linkify 清空的全过程）。
 *
 *   本项目的真源是模型 JSON，Lexical 只是视图。所以正确形态是**改节点树**：
 *   `TextNode.splitText()` 切段 → 中段塞进 `LinkNode` → 选区由 Lexical 自己维护
 *   （实测 .probe/probe-f.mjs：`splitText` 内部就有完整的选点重定位逻辑，
 *   见 node_modules/lexical/src/nodes/LexicalTextNode.ts:1053-1140）。
 *   我们**不需要**保存/恢复选区，也**不需要**碰撤销栈 —— 这是架构升级的红利。
 *
 *   但「延迟 1500ms」这条节奏必须**一字不差地照抄**（老项目 index.html:3631-3638）：
 *   打字过程中实时改树会让光标跳，老项目为此专门做了 `linkifyDeferred`。
 *   理由与实现见 linkify/deferred.ts。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴🔴 `splitText` 的真实签名是**变参绝对偏移**，不是 (start, end) 对：
 *
 *     splitText(...splitOffsets: number[]): TextNode[]
 *
 *   它把入参 sort 后 push(textLength)，再按这些偏移切片，返回**全部**片段
 *   （探针 .probe/probe-f.mjs F1 实锤：`splitText(2,4)` 于 "abcdef"
 *   得到 3 段 `ab|cd|ef`，`splitText(0,6)` 只得到 1 段）。
 *
 *   我第一版按 `splitText(start, end)` 写，结果**切点完全错位**：
 *   探针 F2/F3 实测 `splitText(30, 44)` 把 `https://b.com CCC` 整段
 *   包进了链接（因为它切的是 30 与「文末 44」两处，中段自然吞到尾巴）。
 *   症状是"链接文字吞掉了后面的正文"，用户可见且丢不了。
 *   ⇒ 必须**一次性把所有边界偏移传进去**，让它一次切完。
 */

import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import { $createLinkNode } from '@lexical/link';

import { hasLinkableText, recognizeParts, stripZeroWidth, type Part } from './recognize.ts';

/**
 * 祖先链里**不该**进入链接识别的节点类型。
 *
 * 🔴 判据是**节点类型字符串**，不用 `instanceof` —— bundled ESM 下同一个类
 *   可能被加载成两份引用，`instanceof` 静默失效（serialize.ts:296-299 记着
 *   同一个坑：症状是"链接丢了 href"，零报错）。
 */
const SKIP_ANCESTORS: ReadonlySet<string> = new Set([
  'code', // 代码块：URL 是代码的一部分，不是正文
  'code-highlight', // @lexical/code 的行内高亮壳
  'link', // 手动链接 + 已识别的自动链接（幂等性靠这条）
  'autolink', // registerAutoLink 若将来被真正启用，它也产出这个类型
  'reminder-mark', // 提醒标记：归 reconcile.ts 管，链接识别不得插进去
]);

/** 文本节点的祖先里有没有该跳过的类型。 */
function $hasSkippedAncestor(node: LexicalNode): boolean {
  let cur: LexicalNode | null = node.getParent();
  // 上限 8 层：DOM 深度有限，设上限是为了在节点树与预期失配时能退出而非死循环
  for (let i = 0; i < 8 && cur; i += 1) {
    if (SKIP_ANCESTORS.has(cur.getType())) return true;
    cur = cur.getParent();
  }
  return false;
}

/** 收集候选文本节点（排除项已在 $hasSkippedAncestor 里滤掉）。 */
function $collectCandidates(): TextNode[] {
  const out: TextNode[] = [];
  const walk = (nodes: readonly LexicalNode[]): void => {
    for (const n of nodes) {
      if ($isTextNode(n)) {
        if (!$hasSkippedAncestor(n)) out.push(n);
        continue;
      }
      if ($isElementNode(n)) walk(n.getChildren());
      // Decorator（图片）不参与行内文本流，不进候选
    }
  };
  walk($getRoot().getChildren());
  return out;
}

/**
 * 对**单个** TextNode 应用识别，就地切段并包裹。
 *
 * @returns 是否真的改了树（false = 无命中，调用方可据此跳过写回）
 */
export function $applyToTextNode(node: TextNode): boolean {
  const raw = node.getTextContent();
  // 🔴🔴🔴 早退判据必须喂**剥掉零宽之后**的文本（老项目 index.html:3949
  //   在判早退之前就已经把 nodeValue 剥过一遍了 —— 它的 linkifyEditor 顺序是
  //   「剥 ZWSP → 收集 → 早退」，不是「早退 → 剥」）。
  //
  //   我第一版写的是 `hasLinkableText([raw])`（未剥），后果实测（探针 probe-j.mjs ④）：
  //   老项目迁移来的 `13800\u200B138000` 里没有 11 位**连续**数字，
  //   `phoneTest` 不命中 ⇒ 早退 ⇒ **手机号永远不被识别**，
  //   而 `recognizeParts` 本来是能识别的（它内部先剥）。
  //   症状极具迷惑性：普通手机号能点亮，老笔记里带 ZWSP 的那些不能 ——
  //   用户只会说"我以前的笔记里电话号码不亮"，怎么也想不到是零宽字符。
  if (!hasLinkableText([stripZeroWidth(raw)])) return false;

  const parts = recognizeParts(raw);
  // 没有任何链接片段 ⇒ 无事可做。
  // 🔴 判据是「有没有非 text 片段」而不是「parts 长度 > 1」：denyAsUrl 命中的
  //   URL 走 addText 分支，parts 可能有多个却全是 text 片段（老项目 3740-3741）。
  //   那种情况下若照着 parts 重建，就等于把 ZWSP 回插策略**换成了新策略** ——
  //   而真源不该因为一次「识别」被改写。
  if (!parts.some((p) => p.kind !== 'text')) return false;

  // 🔴🔴 **可见字符必须逐字不变**。
  //   recognizeParts 在**剥掉零宽之后**的串上识别，所以 parts 拼起来比原文少几个
  //   不可见字符（那正是我们要的：把老项目留下的 ZWSP 归一掉）。
  //   但**绝不能顺带改掉任何可见字符** —— 那是静默的内容篡改，
  //   用户既发现不了也无法撤销。
  //   ⇒ 判据是「剥零宽后逐字相等」。
  //   （我第一版写成 `!== raw`，把含 ZWSP 的与不含的**都**放行了/拦住了，
  //   判据与 recognizeParts 的实际口径脱节 —— 探针 G1 实测普通网址不产生链接。
  //   判据必须与被调用方的实际行为对齐，不能凭想象写。）
  if (stripZeroWidth(parts.map((p) => p.t).join('')) !== stripZeroWidth(raw)) return false;

  applyParts(node, raw, parts);
  return true;
}

/**
 * 把 TextNode 按 parts 切开，非 text 片段包进 LinkNode。
 *
 * 🔴🔴🔴 **切点必须一次性传给 `splitText`，且它是变参绝对偏移**：
 *   `splitText(...offsets: number[])` 把入参 sort 后 `push(textLength)` 再切片，
 *   返回**全部**片段（探针 .probe/probe-f.mjs F1 实锤：
 *   `splitText(2,4)` 于 "abcdef" 得到 `ab|cd|ef` 三段）。
 *   所以 `splitText(start, end)` 恰好就是"在 start 与 end 两处下刀"，
 *   中间那段自然落到索引 1 —— 官方 `@lexical/link` 正是这么用的
 *   （LexicalLink.dev.js:1531-1552的 `splitText(startIndex, endIndex)`）。
 *
 *   ⚠️ 但**不要**把「切出来的那一段」直接 `append` 进 LinkNode：
 *   `append` 会**移动**节点（把它从父节点摘下来），此后再 `piece.replace(ln)`
 *   就是对一个已无父节点的节点做替换 —— **静默无效**。
 *   探针 .probe/probe-h.mjs 实锤了这个坑：切出来的链接段凭空消失，
 *   段落里只剩前后两段纯文本，`changed` 却返回 true。
 *   症状是"识别跑了、什么都没变"，零报错 —— 与本项目消灭的
 *   「静默降级」完全同形状。官方写法是**新建**一个 TextNode 再 replace。
 *   本实现照官方写法，并显式搬运 format/style/detail。
 */
function applyParts(node: TextNode, text: string, parts: readonly Part[]): void {
  // 🔴🔴 切点**必须取 Part 自带的 srcStart/srcEnd**（原文坐标），
  //   绝不能拿 `p.t.length` 累加 —— t 是**剥掉零宽之后**的片段文本，
  //   与原文区间长度不同（老项目迁移来的正文里 ZWSP 就在 URL 中间）。
  //   实测（.probe/probe-g.mjs G7）：用 t.length 累加会让链接段整体错位，
  //   切出 `https://exam\u200Bple.co` 而 href 是 `https://example.com` ——
  //   **显示的地址与实际地址不一致**，且正文被切坏一截。
  const links: Array<{ start: number; end: number; href: string }> = [];
  const offsets: number[] = [];
  for (const p of parts) {
    if (p.kind !== 'text' && p.href !== undefined && p.srcEnd > p.srcStart) {
      links.push({ start: p.srcStart, end: p.srcEnd, href: p.href });
      offsets.push(p.srcStart, p.srcEnd);
    }
  }
  if (links.length === 0) return;

  const pieces = node.splitText(...offsets);

  // splitText 返回的片段按偏移升序；用**原文累计长度**把每段对回它的区间。
  // 🔴 这里累加的是原文坐标（piece 本身就在原文上），与 links 的坐标系一致。
  let cursor = 0;
  for (const piece of pieces) {
    const len = piece.getTextContentSize();
    const start = cursor;
    cursor += len;
    if (len === 0) continue;
    const link = links.find((l) => l.start === start && l.end === start + len);
    if (!link) continue;
    // 🔴 新建 TextNode（而不是搬 piece）—— 理由见本函数注释里那个静默失效的坑。
    //   format/style/detail 三件必须显式搬：老项目铁律「删除线不得被 linkify 破坏」
    //   就落在这里。探针 probe-e.mjs E3 实测：切段后各段 format 仍是 4。
    //   🔴 文本取**原文**里的那一段（含 ZWSP），不能用 part.t ——
    //   用 t 会把老项目留下的 ZWSP 从显示文字里抹掉（那是一次静默的内容改写）。
    const inner = $createTextNode(text.slice(link.start, link.end));
    inner.setFormat(piece.getFormat());
    inner.setStyle(piece.getStyle());
    inner.setDetail(piece.getDetail());
    // 🔴 target/rel 与老项目 index.html:3746-3747 逐字一致。
    //   noopener 是必须的：链接文本来自用户输入、href 可能指向任意外站，
    //   没有它则目标页能通过 window.opener 反向操纵本页。
    const ln = $createLinkNode(link.href);
    ln.setTarget('_blank');
    ln.setRel('noopener noreferrer');
    ln.append(inner);
    piece.replace(ln);
  }
}

/**
 * 对整篇编辑器跑一轮链接识别。**必须在 `editor.update()` 内调用。**
 *
 * @returns 实际改动的文本节点数（供调用方判断是否需要写回模型）
 */
export function $linkifyEditor(): number {
  const candidates = $collectCandidates();
  let changed = 0;
  // 倒序遍历：切段会改树，正序遍历时后续节点的引用可能已失效
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const n = candidates[i];
    // 🔴 noUncheckedIndexedAccess 下 candidates[i] 是 TextNode | undefined。
    //   倒序 + continue 的组合下 i 不会越界，但类型系统不知道 —— 显式收窄。
    if (n === undefined) continue;
    if (!n.isAttached()) continue;
    if ($applyToTextNode(n)) changed += 1;
  }
  return changed;
}

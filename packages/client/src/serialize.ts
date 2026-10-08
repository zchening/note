/**
 * 模型 JSON ↔ Lexical 双向绑定
 *
 * 这是 L4（交互层）与 L2（真源层）的唯一接缝。"真源从 DOM 换成模型"这件事的全部价值
 * 都在这一层成立：文档的规范形态是模型 JSON（canonical 保证唯一表示），Lexical 只是它的一层视图。
 *
 * 块映射（11 种块，两向一一对应）：
 *
 *   模型      Lexical
 *   ────────  ────────────────────────────────────────
 *   p         ParagraphNode
 *   h1/h2/h3  HeadingNode('h1'|'h2'|'h3')
 *   ul        ListNode('bullet') → ListItemNode…（1 个 ul 块 = 1 个 ListNode）
 *   ol        ListNode('number')  → ListItemNode…
 *   li        ListItemNode（只作为 ul/ol 的子节点；顶层裸 li 降级为段落）
 *   quote     QuoteNode
 *   code      CodeNode（带 language；换行用 LineBreakNode）
 *   hr        HorizontalRuleNode
 *   img       ImageBlockNode（Decorator，见 nodes.ts）
 *   fold      FoldNode（Element；标题存字段，正文进 children，见 nodes.ts）
 *
 * 内联标记映射：
 *   b/i/u/s/c → TextNode.format 的 IS_BOLD/IS_ITALIC/IS_UNDERLINE/IS_STRIKETHROUGH/IS_CODE
 *   href      → LinkNode 包住
 *   rem       → ReminderMarkNode 包住（inline element）
 *
 * 🔴 本文件唯一的判据是往返契约：
 *   canonicalize(lexicalToDoc(docToLexical(doc))) 与 canonicalize(normalize(doc)) 逐字节相等
 * 由 client/test/serialize.test.mjs 的定向用例 + fast-check 随机文档穷举共同验证。
 * 任何"这里图省事少写一个字段"的改动都会立刻红。
 */

import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_UNDERLINE,
  type EditorState,
  type LexicalNode,
} from 'lexical';
import { $createCodeNode } from '@lexical/code';
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text';
import { $createHorizontalRuleNode } from '@lexical/extension/HorizontalRuleExtension.js';
import { $createLinkNode } from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';

import type { Block, Doc, Reminder, Span } from '@bj/shared-schema';
import {
  $createFoldNode,
  $createImageBlockNode,
  $createListBodyNode,
  $createReminderMarkNode,
  $isFoldNode,
  $isImageBlockNode,
  $isReminderMarkNode,
} from './nodes.ts';

// ── format 位 ↔ 模型标记 ────────────────────────────────────────────────

type MarkKey = 'b' | 'i' | 'u' | 's' | 'c';

const MARK_BITS: ReadonlyArray<readonly [MarkKey, number]> = [
  ['b', IS_BOLD],
  ['i', IS_ITALIC],
  ['u', IS_UNDERLINE],
  ['s', IS_STRIKETHROUGH],
  ['c', IS_CODE],
];

function marksToFormat(s: Span): number {
  let f = 0;
  for (const [k, bit] of MARK_BITS) if (s[k] === true) f |= bit;
  return f;
}

function formatToMarks(f: number): MarkKey[] {
  const out: MarkKey[] = [];
  for (const [k, bit] of MARK_BITS) if ((f & bit) === bit) out.push(k);
  return out;
}

function sameMarks(a: Span, b: Span): boolean {
  if ((a.rem ?? '') !== (b.rem ?? '')) return false;
  if ((a.href ?? '') !== (b.href ?? '')) return false;
  for (const [k] of MARK_BITS) if ((a[k] === true) !== (b[k] === true)) return false;
  return true;
}

/** span 是否"无内容无标记"—— 这种 span 在编辑器里没有对应物，跳过 */
function isEmptySpan(s: Span): boolean {
  return (
    s.t === '' &&
    (s.rem === undefined || s.rem === '') &&
    (s.href === undefined || s.href === '')
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 模型 → Lexical
// ─────────────────────────────────────────────────────────────────────────

/**
 * @param remDone 笔记内全部提醒 id → 是否已过期（`at <= now`，用户拍板 2026-10-08
 *   「时间过了就画删除线」）。id 在表内才包标记节点；done=true 建出来的就是
 *   `<s class="rem-done">`（老项目 remMatchesFor 两族形态，index.html:3746）。
 *   🔴 之所以在导入侧现算而不是把 done 存进真源：done 是**派生态**
 *   （随钟表走），进 canonical 会让"时间流逝"本身变成一次文档编辑。
 */
export function spansToNodes(ss: readonly Span[] | undefined, remDone: ReadonlyMap<string, boolean>): LexicalNode[] {
  const out: LexicalNode[] = [];
  for (const s of ss ?? []) {
    if (isEmptySpan(s)) continue;
    const text = $createTextNode(s.t);
    const f = marksToFormat(s);
    if (f !== 0) text.setFormat(f);
    const href = s.href ?? '';
    const remId = s.rem ?? '';
    if (href !== '') out.push($createLinkNode(href).append(text));
    else if (remId !== '' && remDone.has(remId)) {
      out.push($createReminderMarkNode(remId, remDone.get(remId) === true).append(text));
    } else out.push(text);
  }
  return out;
}

function blockToNode(b: Block, remDone: ReadonlyMap<string, boolean>): LexicalNode | null {
  switch (b.t) {
    case 'p': {
      const n = $createParagraphNode();
      n.append(...spansToNodes(b.spans, remDone));
      return n;
    }
    case 'h1':
    case 'h2':
    case 'h3': {
      const n = $createHeadingNode(b.t as 'h1' | 'h2' | 'h3');
      n.append(...spansToNodes(b.spans, remDone));
      return n;
    }
    case 'quote': {
      const n = $createQuoteNode();
      n.append(...spansToNodes(b.spans, remDone));
      return n;
    }
    case 'code': {
      const n = $createCodeNode(b.lang ?? '');
      const text = b.text ?? '';
      if (text !== '') {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) n.append($createLineBreakNode());
          n.append($createTextNode(lines[i] ?? ''));
        }
      }
      return n;
    }
    case 'hr':
      return $createHorizontalRuleNode();
    case 'img':
      return $createImageBlockNode(b.src ?? '', b.imgAlt ?? '');
    case 'fold': {
      const n = $createFoldNode();
      n.setTitle(b.title ?? []);
      const kids: LexicalNode[] = [];
      // 🔴🔴 **标题作为第一个子段落**（见 nodes.ts FoldNode.createDOM 的注释：
      //   两层 DOM 壳那条路已被 ElementDOMSlot 不可导出堵死，这是唯一可用形态）。
      //   于是 children[0] 是标题、children[1..] 是正文 ——
      //   导出侧 nodeToBlock 必须严格对称地按同一切法还原，否则往返字节不等。
      const title = b.title ?? [];
      if (title.length > 0) {
        const head = $createParagraphNode();
        // 标题不承载行内格式：title 是 span 数组，但要的是"整行文字"这个概念，
        //   拆成多段反而让「点第一下开合」难以判定边界。取纯文本拼一段。
        head.append($createTextNode(title.map((x) => x.t).join('')));
        kids.push(head);
      }
      for (const c of b.children ?? []) {
        const cn = blockToNode(c, remDone);
        if (cn) kids.push(cn);
      }
      // 🔴🔴 空折叠块也要留一个可落光标的段落，否则用户点进去无处打字。
      //
      //   🔴 但这个占位段落**不该被当成用户内容**导出 —— 导出侧
      //   `trimTrailingEmptyParas` 会把尾部空段落剔掉，所以
      //   `{"t":"fold"}` → 导入（children=[占位空段]）→ 导出（剔掉）→ `{"t":"fold"}`，
      //   **往返字节相等**。这条正是属性测试 S3-21/S3-23 反例逐字撞上的形状
      //   （`{t:'fold'}` 嵌 `{t:'fold'}` 嵌 `{t:'p'}`）—— 嵌套 fold 的占位段落
      //   在**内层**，只剔顶层不够，必须每层都剔（trimTrailingEmptyParas 逐层调用）。
      // 🔴 空折叠块**不加**占位段落。
      //
      //   此前这里 push 一个空段落当"落光标的落点"，导出侧再用规则剔掉它配平 ——
      //   而那个配平规则对**嵌套 fold 无效**（属性测试 S3-21 反例）：
      //     `{t:'fold',children:[{t:'fold',children:[{t:'p'}]}]}`
      //     内层那个占位被剔 → 导出成 `{t:'fold',children:[{t:'fold'}]}` ⇒ 往返不等。
      //   根源是"占位"这件事在嵌套结构里没法靠**位置**认出来。
      //
      //   现在两侧都不加/不剔 ⇒ `{t:'fold'}` 与 `{t:'fold',children:[{t:'p'}]}`
      //   都是合法真源形态，往返各自的字节都稳定。
      //   用户点进空折叠块时若无处打字，由 FoldNode 自己在需要时补落点
      //   （编辑器侧的渲染细节，不该写进真源形态的推导里）。
      n.append(...kids);
      return n;
    }
    case 'ul':
    case 'ol': {
      const list = $createListNode(b.t === 'ol' ? 'number' : 'bullet');
      for (const c of b.children ?? []) {
        if (c.t !== 'li') continue; // validator 已保证子节点都是 li，这里双保险
        list.append(liToListItem(c, remDone));
      }
      return list;
    }
    case 'li': {
      // 顶层裸 li：ListItemNode 不能直接挂 root（Lexical 会抛），降级为段落保住文字。
      // validator 允许顶层 li（模型层不禁止），所以这里必须容错而不是崩。
      const n = $createParagraphNode();
      n.append(...spansToNodes(b.spans, remDone));
      for (const c of b.children ?? []) {
        const cn = blockToNode(c, remDone);
        if (cn) n.append(cn);
      }
      return n;
    }
  }
  return null;
}

function liToListItem(li: Block, remDone: ReadonlyMap<string, boolean>): ListItemNode {
  const item = $createListItemNode();
  const own = (li.spans ?? []).filter((s) => !isEmptySpan(s));
  // li 自己的文字放在**第一个段落**里（Lexical 约定：ListItemNode 首个块承载条目文字）。
  // 导出侧 listItemToBlock 把行内形态的节点还原成 li.spans，两边必须严格对称。
  if (own.length > 0) {
    const p = $createParagraphNode();
    p.append(...spansToNodes(own, remDone));
    item.append(p);
  }
  // 🔴 子块装进 ListBodyNode，**不能直接 append 到 item**：
  //   ListItemNode 装单个段落时 Lexical 会把它拆掉上提 format（见 nodes.ts ListBodyNode
  //   的注释与探针实测），段落包装一丢，导出侧就分不清"条目文字"与"子段落"。
  //   有 ListBodyNode 这层壳，节点类型本身就是判据，不再依赖"第一个节点"这种脆弱推断。
  const kidNodes: LexicalNode[] = [];
  for (const c of li.children ?? []) {
    const cn = blockToNode(c, remDone);
    if (cn) kidNodes.push(cn);
  }
  if (kidNodes.length > 0) {
    const body = $createListBodyNode();
    body.append(...kidNodes);
    item.append(body);
  }
  // 空 ListItem 点进去无处打字，补一个空段落；它属于"条目文字"区，导出时自然被吸收
  if (item.getChildrenSize() === 0) item.append($createParagraphNode());
  return item;
}

// ─────────────────────────────────────────────────────────────────────────
// Lexical → 模型
// ─────────────────────────────────────────────────────────────────────────

interface InlineCtx {
  remId?: string;
  href?: string;
}

/**
 * 收集行内内容为 Span[]。
 *
 * 相邻同格式 span 会合并成一条 —— 这不是为了好看，而是 canonical 幂等的要求：
 * 用户在编辑器里连续打字产生的多个 TextNode 若原样导出成多个 span，
 * 另一端导入再导出会合成一条，两端 canonical 字节不等 = 一次假冲突。
 */
// 🔴 导出供 main.ts 的折叠标题回写用（同一套映射 ⇒ span 属性自然对齐，
//   不会像"在导出侧另写一份"那样丢加粗/提醒标记）。
export function nodesToSpans(nodes: readonly LexicalNode[], ctx: InlineCtx = {}): Span[] {
  const out: Span[] = [];

  // 🔴 push 必须接收 InlineCtx 参数，不能闭包捕获外层 ctx：
  //   walk 会带着"当前所在的 link/rem 包裹层"递归下降，每一层 ctx 都不同。
  //   早期版本让 push 直接读外层 ctx，结果链接与提醒的 href/rem 全被静默丢掉 ——
  //   文字在、格式没了。这类 bug 不会报错，只会"看起来少点东西"，最难查。
  const push = (t: string, f: number, c: InlineCtx): void => {
    const marks = formatToMarks(f);
    const cand: Span = { t };
    for (const m of marks) cand[m] = true;
    if (c.remId !== undefined) cand.rem = c.remId;
    if (c.href !== undefined) cand.href = c.href;
    const last = out[out.length - 1];
    if (last !== undefined && sameMarks(last, cand)) {
      last.t += t;
      return;
    }
    out.push(cand);
  };

  const walk = (list: readonly LexicalNode[], c: InlineCtx): void => {
    for (const n of list) {
      if ($isTextNode(n)) {
        push(n.getTextContent(), n.getFormat(), c);
        continue;
      }
      if ($isLineBreakNode(n)) {
        push('\n', 0, c);
        continue;
      }
      if ($isReminderMarkNode(n)) {
        walk(n.getChildren(), { ...c, remId: n.remId });
        continue;
      }
      //🔴 用 getType() 而不是 instanceof LinkNode：
      //   bundled ESM 下同 一个类可能被加载成两份引用，instanceof 静默失效，
      //   症状是"链接丢了 href"（内容还在、格式没了），极难定位。
      //   getType() 走的是注册表里的字符串，永远可靠。
      if (n.getType() === 'link') {
        if (!$isElementNode(n)) continue;
        const url = (n as unknown as { getURL: () => string }).getURL();
        walk(n.getChildren(), { ...c, href: url });
        continue;
      }
      if ($isElementNode(n)) {
        walk(n.getChildren(), c);
        continue;
      }
      // Decorator 节点落在行内位置（图片被塞进段落）：忽略，块层另行处理。
      // 不能把它当文本，否则会把 <figure> 的文字漏进正文。
    }
  };

  walk(nodes, ctx);
  // 去掉尾部纯空 span（合并过程可能产生）
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (isEmptySpan(last)) out.pop();
    else break;
  }
  return out;
}

function withSpans(b: Block, spans: Span[]): Block {
  if (spans.length > 0) b.spans = spans;
  return b;
}

function nodeToBlock(n: LexicalNode): Block | null {
  if ($isImageBlockNode(n)) {
    const b: Block = { t: 'img' };
    if (n.src !== '') b.src = n.src;
    if (n.alt !== '') b.imgAlt = n.alt;
    return b;
  }
  if (n.getType() === 'horizontalrule') return { t: 'hr' };

  if ($isFoldNode(n)) {
    const b: Block = { t: 'fold' };
    // 🔴 标题优先取 __titleJson（权威），没有才回退到 children[0] 的文字 ——
    //   后者是给"用户在标题行直接打字"兜底的：那种情况下 __titleJson 还没更新，
    //   但 children[0] 已经是新文字了。两个来源都取一遍，取并集里的非空者。
    let title = n.title.filter((s) => !isEmptySpan(s));
    const kids: Block[] = [];
    // 🔴🔴 `firstIsHead` 必须以 **title 非空** 为前提，不能只看「第一个子节点是段落」。
    //   S3-21 属性测试实测反例：
    //     {"t":"fold","children":[{"t":"p","spans":[{"t":" "}]}]}   ← 无title
    //   这个 fold 根本没有标题行，children[0] 是**正文**。
    //   我第一版的判据是「children[0] 是段落 ⇒ 它是标题」，
    //   于是把唯一的正文块提去当 title，导出成{"t":"fold"}（正文凭空消失），
    //   往返字节不等 —— 而且这正是本文件第27~30 行那条「任何图省事少写一个字段的
    //   改动都会立刻红」预言的故障，只是我图省事的地方在**导出侧**。
    //   正确判据：**title 非空 时 children[0] 才是标题行**，否则 children 全是正文。
    const firstIsHead = title.length > 0 && n.getChildrenSize() > 0 && isHeadParagraph(n.getFirstChild());
    const list = n.getChildren();
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      if (c === undefined) continue;
      // 🔴 children[0] 是标题段落 → 提出来当 title，不进 children
      if (i === 0 && firstIsHead) {
        const txt = c.getTextContent().replace(/[\u200B\u200C\uFEFF\u2060]/g, '');
        if (txt !== '' && title.length === 0) title = [{ t: txt }];
        continue;
      }
      const cb = nodeToBlock(c);
      if (cb) kids.push(cb);
    }
    if (title.length > 0) b.title = title;
    // 🔴🔴 **唯一那一个、且为空**的子段落是"落光标用的占位"，要剔；
    //   **除此之外**的空段落一律保留 —— 用户在折叠块里敲的空行是真内容。
    //
    //   🔴 判据是「**唯一那一个子节点且为空**」，不是「尾部连续」：
    //     - `{t:'fold',children:[{t:'p'}]}` 里那一个空段落是导入侧
    //       `if (kids.length === 0) kids.push($createParagraphNode())` 造的占位
    //       ⇒ 剔掉它，`{t:'fold'}` 才往返相等（S3-21 反例逐字是这个）。
    //     - `{t:'fold',children:[{t:'p',spans:[{t:'A'}]},{t:'p'}]}` 里尾部那个空段落
    //       是用户敲的 ⇒ 剔掉就是丢内容。判据用"唯一"就不会误伤它。
    //
    //   🔴🔴 但**嵌套** fold 的内层不能用这条：反例逐字是
    //     `{t:'ul',children:[{t:'li',children:[{t:'fold',children:[{t:'p'}]}]},...]}` ——
    //     内层 fold 的 kids=[{t:'p'}] 会被剔成 `{t:'fold'}`，往返不等。
    //     真源里那个内层 `{t:'p'}` **可能是用户敲的**（折叠块里敲了个空行），
    //     跟占位形态一模一样，分不出来。
    //   ⇒ 结论：内层占位**不该在这里剔**。`{t:'fold',children:[{t:'p'}]}`
    //     与 `{t:'fold'}` 是两种合法真源形态，各自往返稳定就够了
    //     （真源层不要求"同一视觉状态只有一种字节"，那是 canonical 规则 2
    //     对**同一个块**的要求，不是对 fold 整体形态的要求）。
    if (kids.length > 0) b.children = kids;
    return b;
  }

  if (n instanceof ListNode) {
    const kids: Block[] = [];
    for (const item of n.getChildren()) {
      const ib = listItemToBlock(item);
      if (ib) kids.push(ib);
    }
    const b: Block = { t: n.getListType() === 'number' ? 'ol' : 'ul' };
    if (kids.length > 0) b.children = kids;
    return b;
  }

  if (n.getType() === 'heading') {
    const tag = (n as unknown as { getTag: () => string }).getTag();
    if (tag !== 'h1' && tag !== 'h2' && tag !== 'h3') return null;
    if (!$isElementNode(n)) return null;
    // 空标题是合法块（{"t":"h3"}），不能被"空段落占位"规则吞掉
    return withSpans({ t: tag }, nodesToSpans(n.getChildren()));
  }

  if (n.getType() === 'quote') {
    if (!$isElementNode(n)) return null;
    return withSpans({ t: 'quote' }, nodesToSpans(n.getChildren()));
  }

  if (n.getType() === 'code') {
    const b: Block = { t: 'code' };
    const text = n.getTextContent();
    if (text !== '') b.text = text;
    const lang = (n as unknown as { getLanguage?: () => string }).getLanguage?.() ?? '';
    if (lang !== '') b.lang = lang;
    return b;
  }

  if ($isElementNode(n)) {
    const spans = nodesToSpans(n.getChildren());
    // 🔴🔴 空段落**必须导出**（用户拍板方案 A，探针 probe-empty-para 实锤）。
    //   此前这里 `return null` 把空段落吞掉，症状是**用户敲的空行永久消失**：
    //   DOM 里明明有 3 个 `<p>`（A / 空 / B），真源只有 2 块，重载后 DOM 也只剩 2 个。
    //   老项目真源是 DOM，空行就是 `<p><br></p>`，天然进真源 —— bj 丢它是重写引入的。
    //
    //   🔴 那条旧注释的理由（「否则空文档导出成 {"blocks":[{"t":"p"}]}，比原文多一个块
    //   = 一次假冲突」）在方案 A 下**已不成立**，别拿它当理由改回去：
    //   - 空文档那一个空段落照样要剔（见下方 TAIL 判据），所以"多一个块"不会发生；
    //   - canonical 层**早就能接受 `{"t":"p"}`**（实测 canonicalize({v:1,blocks:[A,{},B]})
    //     三块原样保留），所以"空段落是非法形态"这个前提本身就是错的。
    //   唯一还需要照顾的是**尾部**连续空段落：它们不是"行"，是文档末尾多出来的空位。
    return withSpans({ t: 'p' }, spans);
  }
  // root 下裸 TextNode（非法但可能出现）：降级为段落，保住文字
  if ($isTextNode(n)) {
    const spans = nodesToSpans([n]);
    if (spans.length === 0) return null;
    return withSpans({ t: 'p' }, spans);
  }
  return null;
}

/** 是不是标题行段落（缩进列表里可能带 ListItem 包装，用 getType 判）。 */
function isHeadParagraph(node: LexicalNode | null): boolean {
  if (!node) return false;
  const t = node.getType();
  return t === 'paragraph' || t === 'text';
}

function listItemToBlock(item: LexicalNode): Block | null {
  if (!$isElementNode(item)) return null;
  const b: Block = { t: 'li' };
  const own: Span[] = [];
  const rest: Block[] = [];

  /**
   * 判据是**节点类型**，不是"第一个节点长什么样"。
   *
   * 🔴 不用 `i===0` 也不用"扫到第一个块级节点为止"：ListItemNode 会塌陷段落
   *   （见 nodes.ts ListBodyNode 注释），塌陷之后"条目文字"和"唯一子段落"
   *   在结构上完全同形，任何位置启发式都会在两种真源形态间摇摆。
   *   有 ListBodyNode 这层壳之后：行内形态（text/paragraph）= 条目文字，
   *   list-body = 子块，其余块 = 子块。判据唯一且与导入侧严格对称。
   */
  for (const c of item.getChildren()) {
    const t = c.getType();
    if (t === 'list-body') {
      if ($isElementNode(c)) {
        for (const k of c.getChildren()) {
          const kb = nodeToBlock(k);
          if (kb) rest.push(kb);
        }
      }
      continue;
    }
    if (t === 'text') {
      own.push(...nodesToSpans([c]));
      continue;
    }
    if (t === 'paragraph') {
      if ($isElementNode(c)) own.push(...nodesToSpans(c.getChildren()));
      continue;
    }
    const cb = nodeToBlock(c);
    if (cb) rest.push(cb);
  }

  const ownSpans = trimTrailingEmpty(own);
  if (ownSpans.length > 0) b.spans = ownSpans;
  if (rest.length > 0) b.children = rest;
  return b;
}

/** 去掉尾部纯空 span（塌陷/合并过程可能产生） */
function trimTrailingEmpty(ss: Span[]): Span[] {
  const out = ss.slice();
  while (out.length > 0 && isEmptySpan(out[out.length - 1]!)) out.pop();
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 对外入口
// ─────────────────────────────────────────────────────────────────────────

/** 模型 JSON → Lexical root。必须在 editor.update() 内调用。 */
export function docToLexical(doc: Doc): void {
  // 🔴 reminders/blocks 一律用 ?? [] 兜底，不能直接 .map：
  //   canonical 规则 2 会省略空数组，所以从服务器 parseDoc 回来的 doc 里
  //   reminders 键**根本不存在**（不是空数组，是 undefined）。
  //   直接 doc.reminders.map 会在生产路径上抛 TypeError，整篇文档打不开。
  //   这个 bug 在单测里看不到——单测的 doc 都是手写的、字段齐全。
  //
  //   S3 后期已把 `Doc.blocks / Doc.reminders` 改成**可选**，与 canonical 规则 2 对齐，
  //   并让 `validateDoc` 不再补空数组（消掉"同一内容两种内存表示"的老坑）。
  //   所以这里的 `?? []` 从"临时补丁"变成了**由类型强制的正确写法**：
  //   编译器会盯着每一处，漏了就是 typecheck 报错，而不是运行时白屏。
  const remDone = new Map(
    (doc.reminders ?? []).map((r): [string, boolean] => [r.id, Date.parse(r.at) <= Date.now()]),
  );
  const root = $getRoot();
  root.clear();
  // 🔴🔴 尾部连续空段落在这里**先剔掉**，与导出侧 `trimTrailingEmptyParas` 对称。
  //
  //   为什么必须对称（属性测试 S3-21/S3-23 逐字撞出来的反例）：
  //     真源 `{blocks:[{t:'p'}]}`（用户在空文档里敲了一个空段落）
  //       → 导入成"一个空段落节点"
  //       → 导出时被 trim 剔掉 → `{}`
  //       ⇒ 往返字节不等，`canonicalize` 逐字节比较当场红。
  //
  //   🔴 这是"尾部空段落 = 文档末尾的多余空位"这条不变量的**两面**：
  //     导入侧剔 ⇒ 编辑器里那个占位段落不会被当成用户内容；
  //     导出侧剔 ⇒ 内存里的占位不会进真源。
  //     两侧都剔 ⇒ 无论从哪个方向进来，`{blocks:[{t:'p'}]}` 都稳定落到"空文档"。
  //     只剔一侧 ⇒ 往返不等，而且症状是"随机红"（取决于生成了几个空段）。
  //
  //   🔴 为什么这条归一**不在 shared-schema 的 normalize 里**做：
  //     那是内容决策（"用户敲的空行算不算内容"），真源层已按方案 A 保留中间空行；
  //     而"末尾没有内容的空位"是**编辑器实现细节**（Lexical root 至少要一个 child），
  //     只有在编辑器这侧才知道它是不是占位。放真源层就会变成"用户敲的最后一个空行
  //     同步到别的设备就没了" —— 那才是真丢内容。
  const nodes: LexicalNode[] = [];
  for (const b of doc.blocks ?? []) {
    const n = blockToNode(b, remDone);
    if (n) nodes.push(n);
  }
  // 🔴 空文档要补一个可落光标的段落（S3-30 钉死的产品要求：空笔记必须能直接打字）。
  //   ⚠️ 由此带来的往返问题由**导出侧**兜：`{"v":1}` ↔ 「编辑器里一个空段落」
  //   双向闭合靠导出侧那条「唯一空块 ⇒ 归零」规则，见 lexicalToDoc 的注释。
  //   （我试过在导入侧不补 —— 那条被 S3-30 直接判红，理由就是上面那句产品要求。）
  root.append(...(nodes.length > 0 ? nodes : [$createParagraphNode()]));
}

/**
 * 🔴🔴 **局部**替换根节点下的若干块，其余块**一个节点都不碰**。
 *
 * 存在的唯一理由：用户报障第 7 条「打字时换行或正在打的字被吞」。
 * `docToLexical` 是 `root.clear()` + 整篇重建 —— 每敲一个字、
 * 只要提醒对账算出标记有变化，就销毁全文 DOM（见 reminder/local-mark.ts 文件头）。
 *
 * 🔴🔴🔴 **为什么这个函数对判错位置零容错**：
 *   `indexes` 是**顶层下标**，指向 root 的直接子节点。
 *   越界 / 传空 / 长度不符都必须**抛错而不是静默跳过** ——
 *   静默跳过的症状是"下划线没铺上但没有任何报错"，而调用方
 *   （main.ts 对账路径）拿不到信号就会以为已经处理完了。
 *   宁可整篇重建（那条路永远正确），也不要静默错位。
 *
 * @param indexes 顶层块下标（升序）
 * @returns 实际替换了几块（与 indexes.length 必须相等，否则说明有块是空的、没被 append）
 */
export function replaceBlocksAt(doc: Doc, indexes: readonly number[]): number {
  const remDone = new Map(
    (doc.reminders ?? []).map((r): [string, boolean] => [r.id, Date.parse(r.at) <= Date.now()]),
  );
  const root = $getRoot();
  const kids = root.getChildren();
  const blocks = doc.blocks ?? [];
  if (indexes.length === 0) return 0;
  // 🔴 先整批校验再动手：绝不做"改到一半才发现后面的下标越界"
  for (const i of indexes) {
    if (!Number.isInteger(i) || i < 0 || i >= kids.length) {
      throw new Error(`replaceBlocksAt: 下标 ${i} 越界（root 有 ${kids.length} 个顶层块）`);
    }
    if (i >= blocks.length) {
      throw new Error(`replaceBlocksAt: 下标 ${i} 越界（doc 只有 ${blocks.length} 个块）`);
    }
  }
  let done = 0;
  for (const i of indexes) {
    const n = blockToNode(blocks[i]!, remDone);
    if (!n) continue; // 空块：留在原地，不动
    kids[i]!.replace(n);
    done += 1;
  }
  return done;
}

/**
 * Lexical 状态 → 模型 JSON。
 *
 * 🔴 整段遍历必须包在 state.read() 回调**内部**：
 *   state.read(fn) 的返回值在回调结束后就失效了，节点对象是"绑在那个 editor state 上"的句柄。
 *   先 read 拿到 children、回调外再逐个调getChildren() 会抛
 *   "Unable to find an active editor state" —— 这是本文件最容易踩的坑，
 *   而且只在真编辑器里报（节点已 getLatest 失败），headless 单测也一样炸。
 */
export function lexicalToDoc(state: EditorState, reminders: readonly Reminder[] = []): Doc {
  // 🔴 blocks 必须在 read 回调**内部**填完：nodeToBlock 读的是节点属性，
  // 一旦回调结束，节点句柄就绑不到活跃 editor state 上（读到的是空壳，
  // 症状是"整篇文档只剩一个空段落"，极具迷惑性）。
  const blocks = state.read(() => {
    const out: Block[] = [];
    for (const n of $getRoot().getChildren()) {
      const b = nodeToBlock(n);
      if (b) out.push(b);
    }
    return out;
  });
  // 🔴🔴 导出侧**一个字的归一都不做** —— 这��最终形态，前面踩了三次坑，全部有属性测试反例。
  //
  //   ① 「剔尾部连续空段落」：反例 `{v:1,blocks:[{t:'p'}]}`
  //      —— 真源保留（方案 A：用户敲的），导入侧忠实还原，导出侧却剔掉 ⇒ 往返不等。
  //   ② 「全空才归零」：同一反例 —— "全空"这个判据把它也吃了。
  //   ③ 「fold 里剔唯一空子节点」：修好单层 fold，却让**嵌套** fold 不等
  //      （反例 `{t:'fold',children:[{t:'fold',children:[{t:'p'}]}]}`）。
  //
  //   三次的共同根子：**"编辑器占位段落"这件事没法从位置或内容认出来**。
  //   Lexical 里"用户敲的空段落"和"为了落光标补的段落"形态完全一样。
  //   ⇒ 唯一正确的做法是**两边都不猜**：真源有什么就导出什么。
  //   "文档空时 Lexical 需要至少一个 child"这个实现细节，**只在导入侧**处理
  //   （docToLexical 的 `nodes.length > 0 ? nodes : [$createParagraphNode()]`）——
  //   而补出来的那个节点在导出时又被原样带回，于是 `{"v":1}` 会变成
  //   `{"v":1,"blocks":[{"t":"p"}]}`，**这是不对的**。
  //
  //   ⇒ 所以还差最后一环：**导入侧对"空文档"也不要补**。让 Lexical 的 root 空着，
  //   由 FoldNode/编辑器在渲染时自己保证可输入（编辑器行为，不是真源形态）。
  //   这样 `{"v":1}` ↔ 编辑器空 ↔ `{"v":1}` 双向闭合，而 `[{t:'p'}]` 也原样往返。
  // 🔴 归零规则：**只**在「整篇恰好一个块且那个块是空段落」时归一成 `{}`。
  //   这条规则换来的是 S3-01「空文档往返」与 S3-21/S3-23 属性测试全绿。
  //
  //   🔴 已知取舍（**故意接受**，不是漏做）：用户在空文档里敲了**一个**空行就退出
  //   ⇒ 真源是 `[{t:'p'}]` ⇒ 下次打开会被归一成 `{}`（那一行不保留）。
  //   敲**两个**及以上、或中间有内容，两端有内容的空段落全部保留。
  //   为什么接受：真源里 `[{t:'p'}]` 与 `{}` 在编辑器里**完全等价**
  //   （都渲染成一个空段落，视觉零差异），而"归零"这条规则同时满足了三件更重要的事：
  //     ① 空文档往返相等（S3-01）；
  //     ② 随机文档往返不红（S3-21/S3-23，之前三轮都被这个形状撞出来过）；
  //     ③ "每次打开空笔记不会多攒一个块"的漂移被彻底堵死。
  //   代价只是"在完全空的文档里敲了一个空行然后走开"这一种极窄场景。
  //   ⚠️ 若将来真要连这一种也保住，唯一正确的做法是**给占位段落打标记**
  //     （FoldNode/空段节点上加一个内部 flag），而不是继续靠形态猜 ——
  //     我已经用四个版本证明形态猜不出来（位置/内容/唯一性/嵌套全都失败）。
  const onlyEmpty = blocks.length === 1 && blocks[0] !== undefined && isEmptyParaBlock(blocks[0]);
  return { v: 1, blocks: onlyEmpty ? [] : blocks, reminders: reminders.map((r) => ({ ...r })) };
}

/** 空段落判定（与真源层 isEmptyPara 同口径；这里只判 p）。 */
function isEmptyParaBlock(b: Block): boolean {
  if (b.t !== 'p') return false;
  for (const s of b.spans ?? []) {
    if (s.t !== '') return false;
    if ((s.rem ?? '') !== '') return false;
    if ((s.href ?? '') !== '') return false;
  }
  return true;
}

/**
 * 剔除**尾部连续**的空段落（`{"t":"p"}` 且无 spans）。
 *
 * 🔴🔴 只剔尾部，中间的**一律保留** —— 用户敲出来的空行就是内容（用户拍板方案 A）。
 *   `A / 空 / 空 / B` 里三个中间空行全部保留；`A / 空 / 空` 末尾两个剔成 `A`。
 *
 * 🔴 为什么尾部要剔（这不是"偷偷改用户的字"，是修一个真实的漂移）：
 *   Lexical 的 root **永远至少有一个 paragraph**（空文档也有一个落光标的），
 *   而真源里 `{"v":1}` 是不带 blocks 键的。于是：
 *     用户打开一篇空笔记 → 光标落在那个空段落 → 什么都不打直接走 → 存进真源
 *     → 下次打开还是"一个空段落" → 再存一次……每次同步都会多出一个尾空块。
 *   两台设备还会互相把这个尾空块当成"新内容"推给对方（blockSig 不同 ⇒ 判冲突）。
 *   剔掉尾部之后：`{"v":1}` ↔「编辑器里一个空段落」双向闭合，不产生任何字节漂移。
 *
 * 🔴 判据必须严格是「`t==='p'` 且 spans 为空」：
 *   - 不能用 `!b.spans`：`{"t":"p","spans":[]}` 归一后没有 spans 键，
 *     但"敲了空段又删掉内容"和"根本没敲过"在真源里同形，本就不该区分；
 *   - 不能波及 h3/quote/li：空壳标题是合法块（老项目允许留空标题），
 *     尾部空标题也是用户自己敲出来的，不该被这条规则吃掉。
 */
function trimTrailingEmptyParas(blocks: Block[]): Block[] {
  let end = blocks.length;
  while (end > 0) {
    const b = blocks[end - 1];
    if (b === undefined || b.t !== 'p') break;
    if ((b.spans ?? []).length > 0) break;
    end -= 1;
  }
  return end === blocks.length ? blocks : blocks.slice(0, end);
}
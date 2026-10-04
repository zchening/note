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

function spansToNodes(ss: readonly Span[] | undefined, remIds: ReadonlySet<string>): LexicalNode[] {
  const out: LexicalNode[] = [];
  for (const s of ss ?? []) {
    if (isEmptySpan(s)) continue;
    const text = $createTextNode(s.t);
    const f = marksToFormat(s);
    if (f !== 0) text.setFormat(f);
    const href = s.href ?? '';
    const remId = s.rem ?? '';
    if (href !== '') out.push($createLinkNode(href).append(text));
    else if (remId !== '' && remIds.has(remId)) {
      out.push($createReminderMarkNode(remId).append(text));
    } else out.push(text);
  }
  return out;
}

function blockToNode(b: Block, remIds: ReadonlySet<string>): LexicalNode | null {
  switch (b.t) {
    case 'p': {
      const n = $createParagraphNode();
      n.append(...spansToNodes(b.spans, remIds));
      return n;
    }
    case 'h1':
    case 'h2':
    case 'h3': {
      const n = $createHeadingNode(b.t as 'h1' | 'h2' | 'h3');
      n.append(...spansToNodes(b.spans, remIds));
      return n;
    }
    case 'quote': {
      const n = $createQuoteNode();
      n.append(...spansToNodes(b.spans, remIds));
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
      for (const c of b.children ?? []) {
        const cn = blockToNode(c, remIds);
        if (cn) kids.push(cn);
      }
      // 空折叠块也要留一个可落光标的段落，否则用户点进去无处打字
      if (kids.length === 0) kids.push($createParagraphNode());
      n.append(...kids);
      return n;
    }
    case 'ul':
    case 'ol': {
      const list = $createListNode(b.t === 'ol' ? 'number' : 'bullet');
      for (const c of b.children ?? []) {
        if (c.t !== 'li') continue; // validator 已保证子节点都是 li，这里双保险
        list.append(liToListItem(c, remIds));
      }
      return list;
    }
    case 'li': {
      // 顶层裸 li：ListItemNode 不能直接挂 root（Lexical 会抛），降级为段落保住文字。
      // validator 允许顶层 li（模型层不禁止），所以这里必须容错而不是崩。
      const n = $createParagraphNode();
      n.append(...spansToNodes(b.spans, remIds));
      for (const c of b.children ?? []) {
        const cn = blockToNode(c, remIds);
        if (cn) n.append(cn);
      }
      return n;
    }
  }
  return null;
}

function liToListItem(li: Block, remIds: ReadonlySet<string>): ListItemNode {
  const item = $createListItemNode();
  const own = (li.spans ?? []).filter((s) => !isEmptySpan(s));
  // li 自己的文字放在**第一个段落**里（Lexical 约定：ListItemNode 首个块承载条目文字）。
  // 导出侧 listItemToBlock 把行内形态的节点还原成 li.spans，两边必须严格对称。
  if (own.length > 0) {
    const p = $createParagraphNode();
    p.append(...spansToNodes(own, remIds));
    item.append(p);
  }
  // 🔴 子块装进 ListBodyNode，**不能直接 append 到 item**：
  //   ListItemNode 装单个段落时 Lexical 会把它拆掉上提 format（见 nodes.ts ListBodyNode
  //   的注释与探针实测），段落包装一丢，导出侧就分不清"条目文字"与"子段落"。
  //   有 ListBodyNode 这层壳，节点类型本身就是判据，不再依赖"第一个节点"这种脆弱推断。
  const kidNodes: LexicalNode[] = [];
  for (const c of li.children ?? []) {
    const cn = blockToNode(c, remIds);
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
function nodesToSpans(nodes: readonly LexicalNode[], ctx: InlineCtx = {}): Span[] {
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
    const title = n.title.filter((s) => !isEmptySpan(s));
    if (title.length > 0) b.title = title;
    const kids: Block[] = [];
    for (const c of n.getChildren()) {
      const cb = nodeToBlock(c);
      if (cb) kids.push(cb);
    }
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
    // 空段落是真源里不存在的形态（canonical 会省略空 spans），
    // 但编辑器需要一个空段落当落光标的落点。导出时把这个"占位"还回去 ——
    // 否则空文档导出成 {"blocks":[{"t":"p"}]}，比原文多一个块 = 一次假冲突。
    // 🔴 只对 paragraph 生效。标题/引用/列表项的空壳是真源里的合法块
    //   （{"t":"h3"}、{"t":"quote"}），吞掉它们会造成"块凭空消失"的数据丢失。
    if (spans.length === 0 && n.getType() === 'paragraph') return null;
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
  const remIds = new Set((doc.reminders ?? []).map((r) => r.id));
  const root = $getRoot();
  root.clear();
  const nodes: LexicalNode[] = [];
  for (const b of doc.blocks ?? []) {
    const n = blockToNode(b, remIds);
    if (n) nodes.push(n);
  }
  root.append(...(nodes.length > 0 ? nodes : [$createParagraphNode()]));
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
  return { v: 1, blocks, reminders: reminders.map((r) => ({ ...r })) };
}
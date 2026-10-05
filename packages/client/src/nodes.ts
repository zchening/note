/**
 * 自定义 Lexical 节点：提醒标记 / 折叠块 / 图片块
 *
 * ARCH.md §4.2 的三条判定在这里落地：
 *  - 折叠块 = ElementNode（走 children，参与文本流、复制、导出）
 *  - 提醒标记 = **inline ElementNode**（不是 decorator，理由见下）
 *  - 图片 = DecoratorNode（图片是真嵌入 UI，不参与行内文本流，这正是 decorator 的适用场景）
 *
 * 🔴 提醒为什么不用 decorator：
 *   提醒标记要参与文本流的合并（canonical 里它是 span.rem，跨端字符级合并要看到它）、
 *   要能被选区跨过、要随文本复制。decorator 节点在 Lexical 里是"光标到此为止"的原子，
 *   选区跨不过去，两端合并时也拿不到它的字符位置 —— 会退化成"整块替换"，
 *   正是老项目"两端各改一个字就整段覆盖"那类 bug 的温床。
 *
 * 🔴 折叠开合状态是 ephemeral UI 状态（ARCH.md 红线 R3）：
 *   它存在 FoldNode.__open 里（会参与 Lexical 自己的 undo/redo 快照），
 *   但 **docToLexical / lexicalToDoc 两侧都不读它**。
 *   真源（canonical JSON）里永远没有 open 字段 —— 否则"我手机上展开一个折叠块"
 *   会和电脑端产生一次纯噪音同步冲突。
 *
 * 序列化范式照 Lexical 0.52 官方节点（LinkNode / ListItemNode）：
 *   接口声明合并里声明 exportJSON 重载与 updateFromJSON，
 *   类里只实现 updateFromJSON；exportJSON 由 Lexical 的 schema 生成器提供。
 *   手写 exportJSON 会与基类的重载签名冲突（TS2416），且字段顺序就不再受 schema 约束。
 */

import {
  $applyNodeReplacement,
  DecoratorNode,
  ElementNode,
  type LexicalNode,
  type LexicalParseJSON,
  type NodeKey,
  type SerializedElementNode,
  type SerializedLexicalNode,
  type SerializedPartial,
  type Spread,
} from 'lexical';
import type { Span } from '@bj/shared-schema';

// ─────────────────────────────────────────────────────────────────────────
// ReminderMarkNode —— inline element，包住被提醒标记的文本
// ─────────────────────────────────────────────────────────────────────────

export type SerializedReminderMarkNode = Spread<
  { remId: string },
  SerializedElementNode
>;

export class ReminderMarkNode extends ElementNode {
  __remId: string;

  /** @internal */
  override $config() {
    return this.config('reminder-mark', { extends: ElementNode });
  }

  static override getType(): string {
    return 'reminder-mark';
  }

  static override clone(node: ReminderMarkNode): ReminderMarkNode {
    return new ReminderMarkNode(node.__remId, node.__key);
  }

  // 第一个参数必须带默认值：Lexical 要求这样才能合成 static importJSON
  // （否则它无法"凭空"造出一个节点来解析 JSON）。
  constructor(remId = '', key?: NodeKey) {
    super(key);
    this.__remId = remId;
  }

  get remId(): string {
    return this.getLatest().__remId;
  }

  /** inline：必须与文本同处一个行内流，否则选区跨不过去 */
  override isInline(): boolean {
    return true;
  }

  /** 空标记节点没法落光标，让 Lexical 直接删掉 */
  override canBeEmpty(): boolean {
    return false;
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('u');
    dom.className = 'rem-mark';
    dom.setAttribute('data-rem', this.__remId);
    return dom;
  }

  override updateDOM(prev: ReminderMarkNode): boolean {
    // 内容变化由子 TextNode 自己的 reconcile 负责；这里只关心 id 变了没
    return prev.__remId !== this.__remId;
  }

  override updateFromJSON(serialized: LexicalParseJSON<SerializedReminderMarkNode>): this {
    return super
      .updateFromJSON(serialized)
      .setRemId(typeof serialized.remId === 'string' ? serialized.remId : '');
  }

  setRemId(remId: string): this {
    this.getWritable().__remId = remId;
    return this;
  }

  override afterCloneFrom(prev: this): void {
    // 🔴 必须先调 super：Lexical 会检查"覆盖了 afterCloneFrom 却不调父类"的违规，
    //   命中即抛 $cloneWithProperties 异常 → getWritable() 失败 → setOpen/setTitle
    //   静默不生效（open 恒 false）。症状极具迷惑性：功能看起来"没实现"，
    //   而不报"字段写丢了"，所以靠"展开/收起后 canonical 字节不变"这种测试根本测不出来。
    super.afterCloneFrom(prev);
    this.__remId = prev.__remId;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ReminderMarkNode {
  exportJSON(compact?: false): SerializedReminderMarkNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedReminderMarkNode>;
  updateFromJSON(serialized: LexicalParseJSON<SerializedReminderMarkNode>): this;
}

export function $createReminderMarkNode(remId: string): ReminderMarkNode {
  return $applyNodeReplacement(new ReminderMarkNode(remId));
}

export function $isReminderMarkNode(
  node: LexicalNode | null | undefined,
): node is ReminderMarkNode {
  return node instanceof ReminderMarkNode;
}

// ─────────────────────────────────────────────────────────────────────────
// FoldNode —— 折叠块。标题存字段（不进 children），children 是块正文
// ─────────────────────────────────────────────────────────────────────────

export type SerializedFoldNode = Spread<
  { titleJson: string; open: boolean },
  SerializedElementNode
>;

export class FoldNode extends ElementNode {
  /**
   * 标题以 canonical span 数组的 JSON 存字段：
   * 结构化、不受用户输入影响（用户能把标题写成任何文字都不会破坏结构），
   * 且不需要额外的子节点来承载它 —— 标题不是"块内的一个段落"，它是这个块的把手。
   */
  __titleJson: string;
  /** ephemeral UI 状态，见文件头红线 R3 */
  __open: boolean;

  /** @internal */
  override $config() {
    return this.config('fold', { extends: ElementNode });
  }

  static override getType(): string {
    return 'fold';
  }

  static override clone(node: FoldNode): FoldNode {
    return new FoldNode(node.__titleJson, node.__open, node.__key);
  }

  constructor(titleJson = '[]', open = false, key?: NodeKey) {
    super(key);
    this.__titleJson = titleJson;
    this.__open = open;
  }

  get titleJson(): string {
    return this.getLatest().__titleJson;
  }

  /** 标题 span 数组。JSON 解析失败时返回空数组而不是抛 —— 一个坏标题不该让整篇文档打不开 */
  get title(): Span[] {
    try {
      const v: unknown = JSON.parse(this.getLatest().__titleJson);
      return Array.isArray(v) ? (v as Span[]) : [];
    } catch {
      return [];
    }
  }

  setTitle(spans: readonly Span[]): this {
    this.getWritable().__titleJson = JSON.stringify(spans);
    return this;
  }

  get open(): boolean {
    return this.getLatest().__open;
  }

  setOpen(open: boolean): this {
    this.getWritable().__open = open;
    return this;
  }

  /**
   * 🔴🔴 开合状态走 `data-open` **属性**，不是 class。
   *   ui/styles.css 里写的是 `.ns-fold[data-open="true"]` / `[data-open="false"]`，
   *   我第一版在 createDOM 里只切 class（`ns-fold open`）——
   *   症状是**折叠永远展不开**，而节点本身、序列化、点击逻辑全都正常，
   *   单测与序列化测试全绿。只有真浏览器点一下才看得出来。
   *   两处口径不一致的这类 bug 必须靠"CSS 选择器与节点输出一一对照"来抓，
   *   所以下面把属性名写进注释，与 styles.css 那一行一一对应。
   */
  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'ns-fold';
    dom.dataset.open = this.__open ? 'true' : 'false';
    return dom;
  }

  override updateDOM(prev: FoldNode, dom: HTMLElement): boolean {
    if (prev.__open !== this.__open) {
      dom.dataset.open = this.__open ? 'true' : 'false';
      return true;
    }
    return false;
  }

  /** 折叠块的文本 = 标题 + 正文（复制、导出、搜索都靠它） */
  override getTextContent(): string {
    const title = this.title
      .map((s) => s.t)
      .join('');
    const body = this.getChildren()
      .map((c) => c.getTextContent())
      .join('\n');
    return body ? title + '\n' + body : title;
  }

  override updateFromJSON(serialized: LexicalParseJSON<SerializedFoldNode>): this {
    const node = super.updateFromJSON(serialized);
    const tj = serialized.titleJson;
    node.getWritable().__titleJson = typeof tj === 'string' ? tj : '[]';
    node.getWritable().__open = serialized.open === true;
    return node;
  }

  override afterCloneFrom(prev: this): void {
    super.afterCloneFrom(prev);
    this.__titleJson = prev.__titleJson;
    this.__open = prev.__open;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface FoldNode {
  exportJSON(compact?: false): SerializedFoldNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedFoldNode>;
  updateFromJSON(serialized: LexicalParseJSON<SerializedFoldNode>): this;
}

export function $createFoldNode(titleJson = '[]', open = false): FoldNode {
  return $applyNodeReplacement(new FoldNode(titleJson, open));
}

export function $isFoldNode(node: LexicalNode | null | undefined): node is FoldNode {
  return node instanceof FoldNode;
}

// ─────────────────────────────────────────────────────────────────────────
// ImageBlockNode —— 图片块。Decorator 路径（图片不参与行内文本流）
// ─────────────────────────────────────────────────────────────────────────

export type SerializedImageBlockNode = Spread<
  { src: string; alt: string },
  SerializedLexicalNode
>;

export class ImageBlockNode extends DecoratorNode<HTMLElement> {
  __src: string;
  __alt: string;

  /** @internal */
  override $config() {
    return this.config('image-block', { extends: DecoratorNode });
  }

  static override getType(): string {
    return 'image-block';
  }

  static override clone(node: ImageBlockNode): ImageBlockNode {
    return new ImageBlockNode(node.__src, node.__alt, node.__key);
  }

  // 第一个参数必须带默认值，原因同 ReminderMarkNode
  constructor(src = '', alt = '', key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__alt = alt;
  }

  get src(): string {
    return this.getLatest().__src;
  }

  get alt(): string {
    return this.getLatest().__alt;
  }

  setSrc(src: string): this {
    this.getWritable().__src = src;
    return this;
  }

  setAlt(alt: string): this {
    this.getWritable().__alt = alt;
    return this;
  }

  override isInline(): boolean {
    return false;
  }

  override decorate(): HTMLElement {
    const wrap = document.createElement('figure');
    wrap.className = 'ns-img';
    const img = document.createElement('img');
    img.src = this.__src;
    img.alt = this.__alt;
    img.loading = 'lazy';
    img.decoding = 'async';
    // 图床是外链，不带 referrer 免泄露访问页地址（老项目同策略）
    img.referrerPolicy = 'no-referrer';
    wrap.appendChild(img);
    return wrap;
  }

  override getTextContent(): string {
    return '';
  }

  override updateFromJSON(serialized: LexicalParseJSON<SerializedImageBlockNode>): this {
    const node = super.updateFromJSON(serialized);
    const sv = serialized.src;
    node.getWritable().__src = typeof sv === 'string' ? sv : '';
    const av = serialized.alt;
    node.getWritable().__alt = typeof av === 'string' ? av : '';
    return node;
  }

  override afterCloneFrom(prev: this): void {
    super.afterCloneFrom(prev);
    this.__src = prev.__src;
    this.__alt = prev.__alt;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ImageBlockNode {
  exportJSON(compact?: false): SerializedImageBlockNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedImageBlockNode>;
  updateFromJSON(serialized: LexicalParseJSON<SerializedImageBlockNode>): this;
}

export function $createImageBlockNode(src: string, alt = ''): ImageBlockNode {
  return $applyNodeReplacement(new ImageBlockNode(src, alt));
}

export function $isImageBlockNode(
  node: LexicalNode | null | undefined,
): node is ImageBlockNode {
  return node instanceof ImageBlockNode;
}

// ─────────────────────────────────────────────────────────────────────────
// ListBodyNode —— 列表项里"条目正文"的容器（承载 li.children）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 🔴 这个节点存在的唯一理由：Lexical 的 ListItemNode **装不下两层结构**。
 *
 * 现象（探针实测，不是猜测）：
 *   ListItemNode 只有一个子段落时，Lexical 的 after 钩子 setFormatFromChildren
 *   会把那个段落**拆掉**，把它的 format 上提到 ListItemNode 自身
 *   （node_modules/@lexical/list/src/LexicalListItemNode.ts:723）。
 *   于是 `{"t":"li","children":[{"t":"p","spans":[{"t":" ","c":true}]}]}`
 *   导入后变成 `listitem > text` —— 段落包装消失，导出时无法区分
 *   「这个字是条目自己的」还是「这是一个子段落」，往返字节不等。
 *
 * 为什么绕不开：那个钩子读的是 `!listItemNode.getFormatType()`，
 * 预设 format(0) 仍是 falsy，短路不了（探针 12 实测）。
 * 不用 ListItemNode 的 ElementNode（QuoteNode 等）则完整保留段落结构（探针 13 实测）。
 *
 * 所以映射改成：li 的**条目文字**仍然走 ListItemNode（原生，行为最正），
 * li 的**子块**装进 ListBodyNode，两层各归其位，导出时靠节点类型精确区分。
 */
export class ListBodyNode extends ElementNode {
  /** @internal */
  override $config() {
    return this.config('list-body', { extends: ElementNode });
  }

  static override getType(): string {
    return 'list-body';
  }

  static override clone(node: ListBodyNode): ListBodyNode {
    return new ListBodyNode(node.__key);
  }

  /**
   * 🔴 `key` 必须写成 `key: NodeKey | undefined = undefined`，**不能用 `key?: NodeKey`**。
   *
   *   Lexical 判定「能否合成 static importJSON / 是否自带 clone」看的是
   *   `Klass.length` —— JS 里 `length` 是**形参个数，不计可选参数**，
   *   所以 `constructor(key?: NodeKey)` 的 length 仍是 1，Lexical 认为你有一个必填参数，
   *   直接抛 "must implement a static importJSON method since its constructor has
   *   N required arguments (expecting 0)"。
   *   写成带显式 `= undefined` 默认值，length 才是 0。
   *   这个错一抛就是**整个 editor 建不起来**，全部测试一起红，与本节点毫无关系。
   *   官方 TabNode 源码里就写着这条注释（Lexical.dev.js:12309）。
   */
  constructor(key: NodeKey | undefined = undefined) {
    super(key);
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'ns-list-body';
    return dom;
  }

  override getTextContent(): string {
    return this.getChildren()
      .map((c) => c.getTextContent())
      .join('\n');
  }
}

export function $createListBodyNode(): ListBodyNode {
  return $applyNodeReplacement(new ListBodyNode());
}

export function $isListBodyNode(
  node: LexicalNode | null | undefined,
): node is ListBodyNode {
  return node instanceof ListBodyNode;
}

// ─────────────────────────────────────────────────────────────────────────
// 节点注册表 —— editor 创建时一次性注册
// ─────────────────────────────────────────────────────────────────────────

export const CUSTOM_NODES = [
  ReminderMarkNode,
  FoldNode,
  ImageBlockNode,
  ListBodyNode,
] as const;
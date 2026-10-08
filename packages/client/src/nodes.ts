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
  { remId: string; done?: boolean },
  SerializedElementNode
>;

export class ReminderMarkNode extends ElementNode {
  __remId: string;
  /**
   * 🔴 **派生态，不进 canonical**：对应该提醒「时间已过」（用户拍板 2026-10-08：
   *   时间过了就画删除线，不依赖是否推送成功——老项目 v5.54 起同款实时判断，
   *   index.html:3765「v5.54 起按时间实时判断，REM_DONE 已确认标记退役」）。
   *   done=true 时 createDOM 输出 `<s class="rem-done">`（老项目 :3737 同款标签与类），
   *   false 输出 `<u class="rem-mark">`。
   *   它随 Lexical JSON 往返（与 FoldNode.open 的 ephemeral 同款待遇），
   *   但 lexicalToDoc 导出 span 时**只读 remId** —— canonical 里永远没有 done。
   */
  __done: boolean;

  /** @internal */
  override $config() {
    return this.config('reminder-mark', { extends: ElementNode });
  }

  static override getType(): string {
    return 'reminder-mark';
  }

  static override clone(node: ReminderMarkNode): ReminderMarkNode {
    return new ReminderMarkNode(node.__remId, node.__done, node.__key);
  }

  // 第一个参数必须带默认值：Lexical 要求这样才能合成 static importJSON
  // （否则它无法"凭空"造出一个节点来解析 JSON）。三个参数全带默认 ⇒ length 仍为 0。
  constructor(remId = '', done = false, key?: NodeKey) {
    super(key);
    this.__remId = remId;
    this.__done = done;
  }

  get remId(): string {
    return this.getLatest().__remId;
  }

  get done(): boolean {
    return this.getLatest().__done;
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
    // 🔴 标签与类名都按 done 切（老项目 remMatchesFor :3746-3739：
    //   未来 = u.rem-mark 下划线；过期 = s.rem-done 删除线，两族 CSS 并存）。
    const dom = document.createElement(this.__done ? 's' : 'u');
    dom.className = this.__done ? 'rem-done' : 'rem-mark';
    dom.setAttribute('data-rem', this.__remId);
    return dom;
  }

  override updateDOM(prev: ReminderMarkNode): boolean {
    // 内容变化由子 TextNode 自己的 reconcile 负责；这里只关心 id / done 变没变。
    // 🔴 返回 true = 让 Lexical 卸载重建（createDOM 重新按 done 选标签）——
    //   ImageBlockNode.updateDOM 同款先例：返回 true 才能换掉标签名本身。
    return prev.__remId !== this.__remId || prev.__done !== this.__done;
  }

  override updateFromJSON(serialized: LexicalParseJSON<SerializedReminderMarkNode>): this {
    return super
      .updateFromJSON(serialized)
      .setRemId(typeof serialized.remId === 'string' ? serialized.remId : '')
      .setDone(serialized.done === true);
  }

  setRemId(remId: string): this {
    this.getWritable().__remId = remId;
    return this;
  }

  setDone(done: boolean): this {
    this.getWritable().__done = done;
    return this;
  }

  override afterCloneFrom(prev: this): void {
    // 🔴 必须先调 super：Lexical 会检查"覆盖了 afterCloneFrom 却不调父类"的违规，
    //   命中即抛 $cloneWithProperties 异常 → getWritable() 失败 → setOpen/setTitle
    //   静默不生效（open 恒 false）。症状极具迷惑性：功能看起来"没实现"，
    //   而不报"字段写丢了"，所以靠"展开/收起后 canonical 字节不变"这种测试根本测不出来。
    super.afterCloneFrom(prev);
    this.__remId = prev.__remId;
    this.__done = prev.__done;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ReminderMarkNode {
  exportJSON(compact?: false): SerializedReminderMarkNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedReminderMarkNode>;
  updateFromJSON(serialized: LexicalParseJSON<SerializedReminderMarkNode>): this;
}

export function $createReminderMarkNode(remId: string, done = false): ReminderMarkNode {
  return $applyNodeReplacement(new ReminderMarkNode(remId, done));
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
   *   纪律：凡是「CSS 选择器与节点输出一一对照」的地方，改名必须两处同改。
   *
   * 🔴 DOM 是**单层**：标题不是额外的 DOM 壳，而是 children 的**第一个子节点**
   *   （一个段落，导出时提出来当 title 字段、导入时塞回第一个位置）。
   *
   *   我第一版想在 createDOM 里造 `.ns-fold-head` + `.ns-fold-body` 两层壳、
   *   靠 `getDOMSlot` 把 children 挂进 body。实测**此路不通（已放弃，别再试）**：
   *     - ElementNode.getDOMSlot 的返回类型是 `ElementDOMSlot`（不是 DOMSlot），
   *       而 `ElementDOMSlot` **没有从 'lexical' 导出**（只在内部 .d.ts 里），
   *       拿不到构造函数 → TS2416「类型不兼容」+ TS1362「不能当值用」。
   *     - 就算硬造，ElementDOMSlot 还要求 getManagedLineBreak /
   *       getDecoratorBoundaryAnchor 等 8 个方法，纯装饰用途填它们纯属噪音。
   *   结论：**"标题 = 第一个子段落"** 是这里唯一既能用 Lexical 原生机制、
   *   又不污染真源模型的形态。CSS 的 `.ns-fold > :first-child` 承担标题行样式。
   */
  override createDOM(): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'ns-fold';
    dom.dataset.open = this.__open ? 'true' : 'false';
    return dom;
  }

  override updateDOM(prev: FoldNode, dom: HTMLElement): boolean {
    if (prev.__open === this.__open) return false;
    dom.dataset.open = this.__open ? 'true' : 'false';
    return true;
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

  /**
   * 🔴🔴🔴 本项目是**纯 DOM 宿主（不引 React）**，所以 `decorate()` 的返回值
   *   **必须由 createDOM 自己挂上去**。
   *
   *   探针实锤（2026-10-05）：第一版按 React 侧的习惯分成
   *   createDOM 造 figure + decorate 造 img，结果渲染出的是
   *     `<figure class="ns-img" data-lexical-decorator="true" contenteditable="false"></figure>`
   *   —— **空壳**。而真源里 img 块已经在了（用户数据没错、提示条也报"上传成功"），
   *   属于纯视觉层的静默失效：数据对、界面空。
   *
   *   根因：Lexical 0.52 的 `$decorateDOM` 在默认 DOMRenderConfig 里是
   *   **空函数**（`Lexical.dev.js:19530`原话`() => {}`），
   *   它是留给 @lexical/react 去挂载的。纯 DOM 侧没人调 decorate，
   *   返回值就永远不会被放进 createDOM 给的那只壳里。
   *
   *   ⇒ 本项目的正确形态是：**createDOM 里一次把壳和内容都造好**，
   *   decorate 保留（基类契约 + 未来接 React 时用），但不再承担"挂载"职责。
   */
  override createDOM(): HTMLElement {
    const dom = document.createElement('figure');
    dom.className = 'ns-img';
    // 官方要求 createDOM 返回**恰好一个** HTMLElement（不支持嵌套元素），
    // 所以壳是 figure、内容是它唯一的子节点 <img>。
    dom.appendChild(this.buildImg());
    return dom;
  }

  /**
   * src / alt 变了要重建 —— 返回 true 让 Lexical 卸载重建。
   *
   * 🔴 不能返回 false：图片已经渲染完，用户看不到变化，只能靠重建。
   *   返回 false 的后果是"改了图的地址但画面不变"，属于静默失效。
   */
  override updateDOM(prev: ImageBlockNode): boolean {
    return prev.__src !== this.__src || prev.__alt !== this.__alt;
  }

  /**
   * 造 <img>。**唯一造图的地方**，createDOM 与 decorate 共用 ——
   * 避免两处各造一份、改了一处忘了另一处（那会让刷新前后表现不一致）。
   */
  private buildImg(): HTMLImageElement {
    const img = document.createElement('img');
    // 🔴 走 src / alt **属性赋值**，不走 innerHTML（云端 URL 属外部输入）
    img.src = this.__src;
    img.alt = this.__alt;
    // 🔴 不加 loading="lazy"：老项目是裸 <img src>（无 loading/decoding），
    //   移动端 lazy 会让未进入视口的图高度塌成 0，只剩 border 一条横线。
    //   笔记内图片数量有限，无 lazy 的性能必要。
    img.decoding = 'async';
    // 图床是外链，不带 referrer 免泄露访问页地址（老项目同策略）
    img.referrerPolicy = 'no-referrer';
    return img;
  }

  /**
   * 返回 createDOM 那只 figure 的**内部内容**（官方分工：createDOM 给外壳，
   * decorate 给内容）。纯 DOM 宿主下本方法不再被自动调用（见 createDOM 注释），
   * 保留它是基类契约，且接@lexical/react 时即刻生效。
   */
  override decorate(): HTMLElement {
    return this.buildImg();
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
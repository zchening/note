/**
 * 真源模型 —— 块类型与内联标记定义
 *
 * 设计约束（ARCH.md §4.1）：
 *  - 块类型清单以老项目 sanitizer 实际允许的能力为基准，不多做也不少做
 *  - 全部字段可选且"值为默认即省略"（canonical 规则 2），故所有可选字段类型含 undefined
 *  - 递归结构只允许出现在 fold.children 与 li.children（父子关系显式，不靠缩进猜）
 */

/** 强调标记：老项目工具栏只有删除线，但 contenteditable 原生 Ctrl+B/I/U 会产生 b/i/u —— 一并建模，否则丢数据 */
export interface Span {
  /** 文本内容（可为空串，承载纯标记的锚点） */
  t: string;
  b?: true;
  i?: true;
  u?: true;
  s?: true;
  /** 行内代码 */
  c?: true;
  /** 提醒 id：引用 doc.reminders 里的条目，正文不重复存时间与文案 */
  rem?: string;
  /** 链接目标；存在时该 span 整体是链接 */
  href?: string;
}

export type BlockT =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'ul'
  | 'ol'
  | 'li'
  | 'quote'
  | 'code'
  | 'hr'
  | 'img'
  | 'fold';

export interface Block {
  t: BlockT;
  /** p/h1..h3/li/quote 的行内内容 */
  spans?: Span[];
  /** code 块的纯文本（含换行与缩进，全是普通字符，不存在协议前缀冲突） */
  text?: string;
  /** code 块语言标记 */
  lang?: string;
  /** img 块图片地址（图床外链，非 data URI） */
  src?: string;
  imgAlt?: string;
  /** fold 块标题 */
  title?: Span[];
  /** fold 块子块（显式父子，不靠缩进猜） */
  children?: Block[];
}

export interface Reminder {
  /** 稳定 id：真源里提醒不依附正文，增删块不影响它 */
  id: string;
  /** 完整 ISO 带偏移，绝不存裸本地时间（换设备/跨时区不错） */
  at: string;
  text: string;
  done?: true;
}

export interface Doc {
  /** schema 版本，用于将来演进 */
  v: 1;
  blocks: Block[];
  reminders: Reminder[];
}

/** canonical 序列化中每个对象类型的键顺序（规则 1：按 schema 定义顺序，不是字典序） */
export const BLOCK_KEY_ORDER: ReadonlyArray<keyof Block> = [
  't',
  'spans',
  'text',
  'lang',
  'src',
  'imgAlt',
  'title',
  'children',
] as const;

export const SPAN_KEY_ORDER: ReadonlyArray<keyof Span> = [
  't',
  'b',
  'i',
  'u',
  's',
  'c',
  'rem',
  'href',
] as const;

export const REMINDER_KEY_ORDER: ReadonlyArray<keyof Reminder> = [
  'id',
  'at',
  'text',
  'done',
] as const;

export const DOC_KEY_ORDER: ReadonlyArray<keyof Doc> = ['v', 'blocks', 'reminders'] as const;

/** 块类型白名单：任何不在此表内的 t 一律拒绝（确定性拒绝） */
export const BLOCK_TYPES: ReadonlySet<string> = new Set<BlockT>([
  'p',
  'h1',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'quote',
  'code',
  'hr',
  'img',
  'fold',
]);

/** 允许 children 的块类型（其余带 children 一律拒绝） */
export const BLOCKS_WITH_CHILDREN: ReadonlySet<string> = new Set(['fold', 'li', 'ul', 'ol']);

export function emptyDoc(): Doc {
  return { v: 1, blocks: [], reminders: [] };
}

/** 取块的纯文本（合并与签名用；不读 spans 之外的字段） */
export function blockText(b: Block): string {
  if (b.t === 'code') return b.text ?? '';
  if (b.t === 'hr' || b.t === 'img') return '';
  if (b.t === 'fold') {
    const own = spansText(b.title ?? []);
    const kids = (b.children ?? []).map(blockText).join('\n');
    return own + (kids ? '\n' + kids : '');
  }
  if (b.t === 'li') {
    const own = spansText(b.spans ?? []);
    const kids = (b.children ?? []).map(blockText).join('\n');
    return own + (kids ? '\n' + kids : '');
  }
  return spansText(b.spans ?? []);
}

export function spansText(ss: Span[]): string {
  let out = '';
  for (const s of ss) out += s.t;
  return out;
}

/**
 * 手写 validator —— 不用 zod / valibot
 *
 * 为什么不用现成校验库（ARCH.md 红线 R3）：
 *  密钥在浏览器里，运行时依赖 = 投毒面。恶意依赖在 import 期就能读到 CryptoKey。
 *  校验库省下的那点代码远不及这个风险值钱。代价是手写约 200 行，纯函数，好测。
 *
 * 校验器的三条硬性要求：
 *  1. 确定性：同样的输入永远给同样的错误码（不留 Date.now()/随机数）
 *  2. 完备性：任何非 canonical 表示都要在这里或 canonical.ts 被拒
 *  3. 无副作用：不修改传入对象
 */

import {
  BLOCKS_WITH_CHILDREN,
  BLOCK_TYPES,
  type Block,
  type Doc,
  type Reminder,
  type Span,
} from './types.ts';

/** 错误码表：调用方按码做本地化，不要匹配 message 文本 */
export type ErrCode =
  | 'E_ROOT'
  | 'E_VERSION'
  | 'E_BLOCKS_TYPE'
  | 'E_REMINDERS_TYPE'
  | 'E_BLOCK_SHAPE'
  | 'E_BLOCK_TYPE_UNKNOWN'
  | 'E_CHILDREN_NOT_ALLOWED'
  | 'E_SPAN_SHAPE'
  | 'E_SPAN_MARK'
  | 'E_SPAN_REM_MISSING'
  | 'E_REMINDER_SHAPE'
  | 'E_REMINDER_DUP_ID'
  | 'E_REMINDER_AT_FORMAT'
  | 'E_LANG_TOO_LONG';

export class ValidateError extends Error {
  readonly code: ErrCode;
  /** 出错路径，如 blocks[3].children[0].spans[2].rem */
  readonly path: string;
  constructor(code: ErrCode, path: string) {
    super(`${code} @ ${path}`);
    this.name = 'ValidateError';
    this.code = code;
    this.path = path;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** 完整 ISO 8601 带时区偏移：2026-10-05T08:30:00+08:00 —— 裸本地时间一律拒（换设备会错） */
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 语言标记上限，防止有人塞 1MB 字符串进 code.lang */
const LANG_MAX = 32;

function validateSpan(s: unknown, path: string, remIds: ReadonlySet<string>): void {
  if (!isPlainObject(s)) throw new ValidateError('E_SPAN_SHAPE', path);
  if (typeof s['t'] !== 'string') throw new ValidateError('E_SPAN_SHAPE', path + '.t');
  // 标记字段只允许 true；出现 false / 0 / 'true' 一律拒（canonical 规则 2 的反面：不接受显式默认值）
  for (const k of ['b', 'i', 'u', 's', 'c'] as const) {
    if (k in s && s[k] !== true) throw new ValidateError('E_SPAN_MARK', `${path}.${k}`);
  }
  for (const k of ['rem', 'href'] as const) {
    if (k in s && typeof s[k] !== 'string') throw new ValidateError('E_SPAN_SHAPE', `${path}.${k}`);
  }
  // 引用完整性：span 指向的提醒必须真的存在，否则是悬空引用（老项目就栽在这：删提醒残留标记）
  const rem = s['rem'];
  if (typeof rem === 'string' && rem !== '' && !remIds.has(rem)) {
    throw new ValidateError('E_SPAN_REM_MISSING', `${path}.rem`);
  }
  // 未声明的键一律拒：防止前端偷偷往 span 上挂 UI 状态，同步过去变成两端的噪音
  const known = new Set(['t', 'b', 'i', 'u', 's', 'c', 'rem', 'href']);
  for (const k of Object.keys(s)) {
    if (!known.has(k)) throw new ValidateError('E_SPAN_SHAPE', `${path}.${k}(未知键)`);
  }
}

function validateSpans(v: unknown, path: string, remIds: ReadonlySet<string>): Span[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ValidateError('E_SPAN_SHAPE', path);
  v.forEach((s, i) => validateSpan(s, `${path}[${i}]`, remIds));
  return v as Span[];
}

function validateBlock(
  b: unknown,
  path: string,
  remIds: ReadonlySet<string>,
  depth: number,
): void {
  if (!isPlainObject(b)) throw new ValidateError('E_BLOCK_SHAPE', path);
  const t = b['t'];
  if (typeof t !== 'string' || !BLOCK_TYPES.has(t)) {
    throw new ValidateError('E_BLOCK_TYPE_UNKNOWN', path + '.t');
  }
  const known = new Set(['t', 'spans', 'text', 'lang', 'src', 'imgAlt', 'title', 'children']);
  for (const k of Object.keys(b)) {
    if (!known.has(k)) throw new ValidateError('E_BLOCK_SHAPE', `${path}.${k}(未知键)`);
  }
  if (b['spans'] !== undefined) validateSpans(b['spans'], `${path}.spans`, remIds);
  if (b['title'] !== undefined) validateSpans(b['title'], `${path}.title`, remIds);
  for (const k of ['text', 'lang', 'src', 'imgAlt'] as const) {
    if (k in b && b[k] !== undefined && typeof b[k] !== 'string') {
      throw new ValidateError('E_BLOCK_SHAPE', `${path}.${k}`);
    }
  }
  const lang = b['lang'];
  if (typeof lang === 'string' && lang.length > LANG_MAX) {
    throw new ValidateError('E_LANG_TOO_LONG', `${path}.lang`);
  }
  if (b['children'] !== undefined) {
    if (!BLOCKS_WITH_CHILDREN.has(t)) {
      throw new ValidateError('E_CHILDREN_NOT_ALLOWED', `${path}.children`);
    }
    const kids = b['children'];
    if (!Array.isArray(kids)) throw new ValidateError('E_BLOCK_SHAPE', `${path}.children`);
    // 深度上限 32：递归结构必须有硬边界，否则恶意/损坏密文可打爆调用栈
    if (depth >= 32) throw new ValidateError('E_BLOCK_SHAPE', `${path}.children(超深)`);
    kids.forEach((k, i) => validateBlock(k, `${path}.children[${i}]`, remIds, depth + 1));
  }
}

function validateReminder(r: unknown, path: string, seen: Set<string>): void {
  if (!isPlainObject(r)) throw new ValidateError('E_REMINDER_SHAPE', path);
  const known = new Set(['id', 'at', 'text', 'done']);
  for (const k of Object.keys(r)) {
    if (!known.has(k)) throw new ValidateError('E_REMINDER_SHAPE', `${path}.${k}(未知键)`);
  }
  if (typeof r['id'] !== 'string' || r['id'] === '') {
    throw new ValidateError('E_REMINDER_SHAPE', path + '.id');
  }
  if (seen.has(r['id'])) throw new ValidateError('E_REMINDER_DUP_ID', path + '.id');
  seen.add(r['id']);
  if (typeof r['text'] !== 'string') throw new ValidateError('E_REMINDER_SHAPE', path + '.text');
  if ('done' in r && r['done'] !== true) {
    throw new ValidateError('E_REMINDER_SHAPE', path + '.done');
  }
  const at = r['at'];
  if (typeof at !== 'string' || !AT_RE.test(at)) {
    throw new ValidateError('E_REMINDER_AT_FORMAT', path + '.at');
  }
  // at 必须能被 Date 解析且不是 Invalid Date（正则过了但 2026-13-45 这种还要拒）
  if (Number.isNaN(Date.parse(at))) {
    throw new ValidateError('E_REMINDER_AT_FORMAT', path + '.at');
  }
}

/**
 * 校验文档结构。**只校验，不改数据** —— 返回的就是 `raw` 本身（同一对象引用）。
 * 抛 ValidateError 表示拒绝；不返回"带 warning 的结果"——拒绝必须确定。
 *
 * 🔴🔴 为什么不再补 `blocks:[] / reminders:[]`（原先 `raw ?? []` 的行为）：
 *   那个"补空数组"是**同一内容两种内存表示**的老坑本体：
 *     - canonical 字节里空数组必须省略（规则 2）
 *     - 但 validateDoc 返回的内存对象里却带着 `blocks: []`
 *   于是 `parseDoc(canonicalize(normalize(d)))` 的返回值 ≠ `normalize(d)`，
 *   内存态与字节态各说各话。代价是实打实的：
 *     · 调用方每处都要写 `?? []` 兜底（serialize.ts 里那些补丁就是它逼出来的）
 *     · 一旦漏一处就是**运行时 TypeError**（实测炸点：`doc.reminders.map` 读 undefined →整页白屏）
 *   现在 `Doc.blocks / Doc.reminders` 是**可选**的，与 canonical 规则 2 对齐，
 *   内存态与字节态统一为"空即缺省"。需要数组的调用方自己写 `(doc.blocks ?? [])`，
 *   那是**显式**的、可被 review 看见的，而不是被validate 悄悄塞进来的。
 */
export function validateDoc(raw: unknown): Doc {
  if (!isPlainObject(raw)) throw new ValidateError('E_ROOT', '$');
  if (raw['v'] !== 1) throw new ValidateError('E_VERSION', '$.v');
  for (const k of Object.keys(raw)) {
    if (k !== 'v' && k !== 'blocks' && k !== 'reminders') {
      throw new ValidateError('E_ROOT', `$.${k}(未知键)`);
    }
  }
  const remsRaw = raw['reminders'];
  if (remsRaw !== undefined && !Array.isArray(remsRaw)) {
    throw new ValidateError('E_REMINDERS_TYPE', '$.reminders');
  }
  const rems: readonly Reminder[] = remsRaw ?? [];
  const seen = new Set<string>();
  rems.forEach((r, i) => validateReminder(r, `$.reminders[${i}]`, seen));
  const remIds: ReadonlySet<string> = seen;

  const blocksRaw = raw['blocks'];
  if (blocksRaw !== undefined && !Array.isArray(blocksRaw)) {
    throw new ValidateError('E_BLOCKS_TYPE', '$.blocks');
  }
  const blocks: readonly Block[] = blocksRaw ?? [];
  blocks.forEach((b, i) => validateBlock(b, `$.blocks[${i}]`, remIds, 0));

  // 原样返回：块与提醒的校验只读不写，键序与键存在性完全保持调用方给定的形态。
  // （上面已逐项断言过 v / blocks / reminders 三个键的类型与存在性，
  //   所以这里的断言是安全的，不是"绕过校验"。）
  return raw as unknown as Doc;
}

/** 便捷：直接校验一个 Doc 对象（前端内存态用） */
export function isValidDoc(v: unknown): v is Doc {
  try {
    validateDoc(v);
    return true;
  } catch {
    return false;
  }
}

/** 收集文档里被 span 引用到的提醒 id（删提醒前先算差集，清干净） */
export function referencedRemIds(doc: Doc): Set<string> {
  const out = new Set<string>();
  const walk = (ss: Span[] | undefined): void => {
    if (!ss) return;
    for (const s of ss) if (typeof s.rem === 'string' && s.rem !== '') out.add(s.rem);
  };
  const walkBlocks = (bs: Block[] | undefined): void => {
    if (!bs) return;
    for (const b of bs) {
      walk(b.spans);
      walk(b.title);
      walkBlocks(b.children);
    }
  };
  walkBlocks(doc.blocks);
  return out;
}

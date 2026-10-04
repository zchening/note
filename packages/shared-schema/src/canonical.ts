/**
 * canonical 序列化 —— 真源唯一性由本文件保证，不靠人守纪律
 *
 * 四条规则（ARCH.md §4.1）：
 *  1. 键顺序按 schema 定义顺序（BLOCK_KEY_ORDER 等），不是字典序
 *  2. 值为默认值的字段一律省略（false/undefined/空数组不写）
 *  3. 无空格无缩进，UTF-8，数组顺序即文档顺序
 *  4. 序列化结果进密文
 *
 * 为什么必须是代码保证：老项目 44% 的 bug 来自"同一份内容有 N 种字符串表示"，
 * 被迫写 5 个等价性补丁函数逐个兜。canonical 化把这个 N 压回 1。
 */

import {
  BLOCK_KEY_ORDER,
  DOC_KEY_ORDER,
  REMINDER_KEY_ORDER,
  SPAN_KEY_ORDER,
  type Block,
  type Doc,
  type Reminder,
  type Span,
} from './types.ts';
import { ValidateError, validateDoc } from './validate.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 拒绝类：一切"这份数据不可信"的信号。调用方只需 catch 这一个类型 */
export class NotCanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotCanonicalError';
  }
}


/** 标记字段：只存 true，false 与 undefined 一律省略 */
function mark(v: boolean | undefined): true | undefined {
  return v === true ? true : undefined;
}

function str(v: string | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function spansJson(ss: Span[] | undefined): Json[] | undefined {
  if (!ss || ss.length === 0) return undefined;
  return ss.map(canonSpan);
}

function canonSpan(s: Span): Json {
  const o: Record<string, Json> = { t: s.t };
  for (const k of SPAN_KEY_ORDER) {
    if (k === 't') continue;
    const v = s[k];
    if (k === 'b' || k === 'i' || k === 'u' || k === 's' || k === 'c') {
      const m = mark(v as boolean | undefined);
      if (m !== undefined) o[k] = m;
    } else if (k === 'rem' || k === 'href') {
      const t = str(v as string | undefined);
      if (t !== undefined) o[k] = t;
    }
  }
  return o;
}

function blocksJson(bs: Block[] | undefined): Json[] | undefined {
  if (!bs || bs.length === 0) return undefined;
  return bs.map(canonBlock);
}

function canonBlock(b: Block): Json {
  const o: Record<string, Json> = { t: b.t };
  for (const k of BLOCK_KEY_ORDER) {
    if (k === 't') continue;
    switch (k) {
      case 'spans': {
        const v = spansJson(b.spans);
        if (v !== undefined) o.spans = v;
        break;
      }
      case 'title': {
        const v = spansJson(b.title);
        if (v !== undefined) o.title = v;
        break;
      }
      case 'text':
      case 'lang':
      case 'src':
      case 'imgAlt': {
        const v = str(b[k] as string | undefined);
        if (v !== undefined) o[k] = v;
        break;
      }
      case 'children': {
        const v = blocksJson(b.children);
        if (v !== undefined) o.children = v;
        break;
      }
    }
  }
  return o;
}

function canonReminder(r: Reminder): Json {
  const o: Record<string, Json> = { id: r.id, at: r.at, text: r.text };
  const d = mark(r.done);
  if (d !== undefined) o.done = d;
  return o;
}

/**
 * 文档 → canonical 字符串（无空格、UTF-8、键序固定）
 *
 * 输入允许稀疏（blocks / reminders 缺失或 undefined）—— canonicalize 同时是
 * "归一入口"，前端从任何地方拼出来的半成品对象都能安全过一遍。缺省即空数组。
 * 空数组在输出里一律省略（规则 2），所以 `{"v":1}` 就是空文档的唯一表示。
 */
export function canonicalize(doc: Doc): string {
  const o: Record<string, Json> = { v: doc.v };
  const bs = doc.blocks ?? [];
  const rs = doc.reminders ?? [];
  if (bs.length > 0) o.blocks = bs.map(canonBlock);
  if (rs.length > 0) o.reminders = rs.map(canonReminder);
  return JSON.stringify(o);
}

/**
 * 解析并要求"当且仅当 canonical"：
 *  1. 结构合法（validateDoc 负责，含引用完整性、深度上限、未知键拒绝）
 *  2. 重新序列化后与输入逐字节相等 —— 这条同时钉住键顺序、默认值省略、无空格
 * 这是"接受当且仅当 canonical"的实现方式：不比较语义，比较字节。
 *
 * 顺序很重要：先 validate 再比字节。反过来的话，非法结构可能被"恰好字节相等"
 * 蒙混过关（例如 blocks 缺失时 canonicalize 输出 {"v":1}，与非法输入字节相同）。
 */
export function parseDoc(input: string): Doc {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new NotCanonicalError('不是合法 JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NotCanonicalError('顶层必须是对象');
  }
  // validate 抛的是 ValidateError，不是 NotCanonicalError —— 统一包装，
  // 让调用方只需 catch 一种异常（"这份数据不可信"），错误码仍从 cause 里拿
  let doc: Doc;
  try {
    doc = validateDoc(raw);
  } catch (e) {
    if (e instanceof ValidateError) {
      throw new NotCanonicalError(`结构非法：${e.code} @ ${e.path}`);
    }
    throw e;
  }
  if (canonicalize(doc) !== input) {
    throw new NotCanonicalError('非 canonical 表示（键顺序、默认值省略或空白不符合规范）');
  }
  return doc;
}

/**
 * 便捷：任意 Doc 归一（调用方手上若是从别处构造的对象，先过一遍）。
 *
 * 输出与 parseDoc 同构：blocks / reminders 一定是数组（空文档得到 [] 而非 undefined）。
 * 这一点必须与 parseDoc 一致，否则"同一份内容有两种内存形态"的老问题会在
 * 测试断言里反复咬人（第一版就因为这里不一致白红了两轮）。
 */
export function normalize(doc: Doc): Doc {
  return validateDoc(JSON.parse(canonicalize(doc)));
}

/**
 * 块签名（合并对齐用）= 该块自身的 canonical JSON。
 *
 * 为什么不用「类型 + 纯文本」这种摘要：img 块纯文本是空串，两张不同的图摘要相同，
 * 会被误判成「这块没变」而静默丢掉一边的改动。直接用 canonical 是唯一无损的做法，
 * 代价只是签名长一点（合并只在本地跑，不在渲染热路径上）。
 */
export function blockSig(b: Block): string {
  return JSON.stringify(canonBlock(b));
}

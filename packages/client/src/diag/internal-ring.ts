/**
 * 内部错误的**环形缓冲**（只落内存，绝不上报）
 *
 * 🔴🔴🔴 零知识红线：**本文件不许出现 fetch / WebSocket / XHR / localStorage /
 *   IndexedDB / 任何网络或落盘调用**。它是"把黑洞变成可复制文本"的地方，
 *   不是"把错误送出去"的地方。要上报得由用户**主动**按复制键把这段文本
 *   贴给人 —— 那是另一条路径（diag/panel.ts），与本文件无关。
 *
 * 🔴 为什么需要它（P1-8 的病因）：
 *   `main.ts` 的 `onInternalError` 此前只 `console.warn`；`sync/client.ts`
 *   在不传该回调时同样退化为 `console.warn`（client.ts:371-376）。
 *   真机 APK 上没有控制台 ⇒ 同步状态机一旦反复抛 IllegalTransitionError，
 *   用户看到的是"同步静默死"，开发者拿到的是零线索。console 不是出口，
 *   它只是"开发机上恰好能看见"。
 *
 * 🔴 为什么是**环形**而不是数组（内存上界）：
 *   内部错误是**可能每轮同步都抛**的（client.ts:621 记过：第一次之后每轮都抛）。
 *   无界数组在长会话里会稳定增长直到把内存吃干净 —— 而它存的恰恰是
 *   "没人会去看"的诊断文本。固定 100 条 + 丢最旧，保证无论跑多久都是常数内存。
 *
 * 🔴 为什么**不**落盘：
 *   落盘 = 把内部错误文本写进本机持久存储。那些文本里可能夹着调用方拼进来的
 *   上下文（noteId、状态名、事件名），而"写进去容易、删干净难"。
 *   本模块的定位是**当场可复制的取证**，不是历史归档 —— 会话内够用即可。
 */

/** 环容量（条）。超过即丢最旧的一条。 */
export const INTERNAL_RING_MAX = 100;

/**
 * 单条记录的字段长度上限（字符）。
 *
 * 🔴 没有它，"固定 100 条"就只保证了**条数**上界、没保证**字节**上界 ——
 *   一条 10MB 的 message 就能把环撑爆。取值只求能看清，不求完整。
 */
const FIELD_MAX = 200;

/** 一条内部错误记录。 */
export interface InternalErrorRecord {
  /** 记录时刻（`Date.now()`）。 */
  ts: number;
  /** 人类可读的一句话。**必填** —— 它是唯一恒有的线索。 */
  msg: string;
  /** 同步状态机的状态名（有就给）。 */
  state?: string | undefined;
  /** 触发它的事件名（有就给）。 */
  event?: string | undefined;
  /**
   * 错误对象的 `name: message`（有就给）。
   *
   * 🔴 只存这两个字段的**文本**，绝不存 stack：stack 里可能夹着调用栈上的
   *   局部变量形态，而这里要的是"哪一类错"，不是"在哪一行"。
   */
  err?: string | undefined;
}

/** `pushInternalError` 的入参。 */
export interface InternalErrorInput {
  msg: string;
  state?: string | undefined;
  event?: string | undefined;
  /** 原样收 `unknown`：调用方手里通常是 `catch (e)` 出来的那个东西。 */
  err?: unknown;
}

/**
 * 🔴 模块级单值是有意的：内部错误是**进程级**的事实，
 *   不存在"这篇笔记的内部错误"这种分桶。
 */
const ring: InternalErrorRecord[] = [];

/** 截断到 FIELD_MAX，且把换行压成空格（一行一条是"可复制"的前提）。 */
function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > FIELD_MAX ? `${flat.slice(0, FIELD_MAX)}…` : flat;
}

/** `unknown` → 一行文本；拿不出东西时返回 `undefined`（那就**不写**这个键）。 */
function errText(e: unknown): string | undefined {
  if (e === undefined || e === null) return undefined;
  if (e instanceof Error) return oneLine(`${e.name}: ${e.message}`);
  if (typeof e === 'string') return oneLine(e);
  let s: string;
  try {
    s = JSON.stringify(e);
  } catch {
    s = '';
  }
  if (typeof s !== 'string' || s === '' || s === 'undefined') {
    try {
      s = String(e);
    } catch {
      s = '';
    }
  }
  return s === '' ? undefined : oneLine(s);
}

/**
 * 压一条内部错误。
 *
 * 🔴 本函数**绝不抛**（调用方就是 catch 块里的人）。任何一步出问题都吞掉，
 *   "记不下来"永远比"记的时候又炸一次"好。
 */
export function pushInternalError(input: InternalErrorInput): void {
  try {
    const rec: InternalErrorRecord = { ts: Date.now(), msg: oneLine(input.msg) };
    // 🔴 exactOptionalPropertyTypes：可选字段**不许显式赋 undefined** ——
    //   拿不到值就干脆不写这个键，而不是写 `state: undefined`。
    if (input.state !== undefined) rec.state = oneLine(input.state);
    if (input.event !== undefined) rec.event = oneLine(input.event);
    const et = errText(input.err);
    if (et !== undefined) rec.err = et;
    ring.push(rec);
    // 🔴🔴 唯一的容量闸。去掉这一行 = 环变无界数组 = P1-8 的"内存上界"假成立。
    if (ring.length > INTERNAL_RING_MAX) {
      ring.splice(0, ring.length - INTERNAL_RING_MAX);
    }
  } catch {
    /* 记不下来就算了，绝不能反过来打断调用方 */
  }
}

/**
 * 只读快照（按**入环顺序**，最旧在前）。
 *
 * 🔴 返回**副本**：调用方拿到 list() 之后环继续转，
 *   直接交出内部数组的话，他手上的数组会在他脚下变化。
 */
export function listInternalErrors(): InternalErrorRecord[] {
  return ring.slice();
}

/** 环内条数。 */
export function internalErrorCount(): number {
  return ring.length;
}

/** 清空。供"复制完就清"与测试复位用。 */
export function clearInternalErrors(): void {
  ring.length = 0;
}

/** `ts` → `MM-DD HH:mm:ss`（含秒：内部错误的间隔常是秒级）。 */
function fmtTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 一键可复制的文本。
 *
 * 🔴 形状刻意是"一行头 + 每行一条"：用户复制出去能直接贴进聊天框，
 *   不需要再解释哪一段是什么。空的环也给一句话，而不是空串 ——
 *   空串会被当成"复制失败"。
 */
export function snapshotInternalErrorsText(): string {
  if (ring.length === 0) return '内部错误环：空（本次会话没有记录到内部错误）';
  const lines: string[] = [
    `内部错误环：最近 ${ring.length} 条（上限 ${INTERNAL_RING_MAX}，仅内存、未上报）`,
  ];
  for (let i = 0; i < ring.length; i += 1) {
    const r = ring[i];
    // 🔴 noUncheckedIndexedAccess：下标取值必须判空，不能假设一定有
    if (!r) continue;
    const parts: string[] = [`#${i + 1}`, fmtTs(r.ts)];
    if (r.state !== undefined) parts.push(`state=${r.state}`);
    if (r.event !== undefined) parts.push(`event=${r.event}`);
    parts.push(`msg=${r.msg}`);
    if (r.err !== undefined) parts.push(`err=${r.err}`);
    lines.push(parts.join(' | '));
  }
  return lines.join('\n');
}

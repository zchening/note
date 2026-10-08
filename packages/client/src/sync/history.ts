/**
 * 历史版本客户端 —— 服务端快照环的读写两端
 *
 * 🔴🔴 本文件的高危区只有一条，但它是本项目的核心红线：
 *
 *   **服务端只见密文。** 快照走的是与正常笔记保存**完全同一条**加密路径 ——
 *   同一个 `canonicalize` + 同一个 `encryptString(..., 'note', dk)` + 同一个
 *   `fetch`。这里若自己另写一份加密（比如省事只用 iv+ct、或者换个 AAD 标签），
 *   症状是"历史版本功能好像能用"，但服务端从此能看出"这一版的明文长度"，
 *   而且换口令那条路会静默失效。**复用下面的 `sealDoc` 一处，不许分叉。**
 *
 * 移植依据：老项目 index.html:8466-8478（snapshotHistory）+ :8481-8533（loadHistList），
 * 端点形态见老项目 server.js:458-547。
 *
 * 三条与老项目的差异，都因为新架构不同：
 *  1. 存的是 `Doc`（Lexical 真源）而不是 innerHTML —— 老项目那份 HTML 里还夹着
 *     折叠块的展开态，属于 ephemeral UI 态；本项目它压根不在真源里（见 nodes.ts）。
 *  2. 自动快照 60s 节流沿用老项目同值（打字场景不能每 300ms 挤掉一个老版本）。
 *  3. "这一版不存在"由服务端给 200 + 空体，客户端据此判 `null`（不是当网络错误重试）。
 */

import { canonicalize, decryptString, encryptString, normalize, parseDoc } from '@bj/shared-schema';
import type { DerivedKey, Doc, Envelope } from '@bj/shared-schema';
import { getWriteKey } from './write-key.ts';

/** 服务端列表里的一条（**不含密文**，与老项目同款：列表不下发正文） */
export interface HistoryMeta {
  ts: number;
  v: number;
  manual: boolean;
  size: number;
}

/** 环上限，与服务端 HISTORY_MAX 同值。客户端只用于提示，不做裁剪。 */
export const HISTORY_MAX = 10;

/** 自动快照节流（毫秒）。老项目 :8469 同值同理由。 */
const AUTO_SNAPSHOT_THROTTLE_MS = 60_000;

const histUrl = (noteId: string): string => `/api/note/${encodeURIComponent(noteId)}/history`;

/**
 * 🔴🔴 **全项目唯一**的"把真源封成信封"的地方。
 *
 * 与 sync/client.ts 的 push() 用的是同一个 `canonicalize` + 同一个
 * `encryptString(..., 'note', dk)` —— 同一把密钥、同一个 AAD 标签。
 * AAD 必须都是 `'note'`：历史与正文用同一 AAD，恢复出来的那份密文才能被
 * 当成"当前正文"直接推回去（恢复走的就是正常保存路径）。
 * 分叉成两个标签的话，恢复要额外做一次转译，而那次转译就是下一个能悄悄错的地方。
 */
async function sealDoc(doc: Doc, key: CryptoKey, dk: DerivedKey): Promise<Envelope> {
  return encryptString(canonicalize(normalize(doc)), key, 'note', dk);
}

/**
 * 拉历史版本列表（**按时间倒序**，最新在上）。
 *
 * 🔴 网络层失败与"这篇没有历史"必须分开：前者返回 `null`，
 *   后者返回 `[]`。合成一个空数组的话，界面显示"暂无历史版本"，
 *   而真实原因是"网络断了"—— 用户会以为改动没被记下来。
 */
export async function fetchHistoryList(noteId: string): Promise<HistoryMeta[] | null> {
  let res: Response;
  try {
    res = await fetch(histUrl(noteId), { headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch {
    return null;
  }
  if (res.status === 429) return null;
  if (!res.ok) return null;
  let list: HistoryMeta[];
  try {
    const j = (await res.json()) as { list?: HistoryMeta[] };
    list = Array.isArray(j.list) ? j.list : [];
  } catch {
    return null;
  }
  // 服务端按入栈顺序（旧的在前）；最新在上（老项目 list.slice().reverse()）
  return list.slice().reverse();
}

/**
 * 取某一版并解密成真源。
 *
 * @returns 那一版的 `Doc`；**没有这一版**时是 `null`。
 *   `null` 有两种来由（服务端 200 空体 / 解不开），调用方**不得**区分 ——
 *   区分开等于给暴力破解一个 oracle（ARCH 安全不变量，与解锁失败同一句文案）。
 */
export async function fetchHistoryDoc(
  noteId: string,
  ts: number,
  key: CryptoKey,
): Promise<Doc | null> {
  let res: Response;
  try {
    res = await fetch(`${histUrl(noteId)}/${ts}`, { headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const text = await res.text();
  // 🔴 200 + 空体 = 服务端确实没有这一版（与笔记读同款语义），不是错误
  if (text.trim() === '') return null;
  let env: Envelope;
  try {
    env = JSON.parse(text) as Envelope;
  } catch {
    return null;
  }
  try {
    return parseDoc(await decryptString(env, key, 'note'));
  } catch {
    // 解不开 = 口令不对或这版已失效。两者不可区分，也不该区分
    return null;
  }
}

/**
 * 存一版快照。
 *
 * @returns 服务端给的时间戳；失败时 `null`。
 *   快照是**保险不是主链路**（老项目 :8477 注释：失败静默）——
 *   但调用方要拿返回值决定给不给用户提示，所以这里如实回 null。
 */
export async function pushHistory(
  noteId: string,
  doc: Doc,
  key: CryptoKey,
  dk: DerivedKey,
  manual: boolean,
): Promise<number | null> {
  let env: Envelope;
  try {
    env = await sealDoc(doc, key, dk);
  } catch {
    return null;
  }
  let res: Response;
  try {
    // 历史快照写入与正文写入同一道凭据闸（正门锁了侧门不锁等于白装，
    // 老项目 wkJsonHeaders 同款）。失败静默的口径不变：拿不到凭据就不带，
    // 服务端拒了也只是这次快照没存上（保险不是主链路）。
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const wk = await getWriteKey(noteId, key, dk);
    if (wk) headers['x-note-key'] = wk;
    res = await fetch(histUrl(noteId), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...env, manual }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const j = (await res.json()) as { ts?: number };
    return Number.isInteger(j.ts) ? (j.ts as number) : null;
  } catch {
    return null;
  }
}

/**
 * 自动快照节流器。
 *
 * 🔴 为什么要节流：自动快照每次保存都打一次，而保存是去抖 700ms 一轮。
 *   不节流的话连续打字 30 秒能把 10 条的环全冲掉，只剩最后几十秒的内容 ——
 *   而用户想找回的恰恰是"一小时前那段"。
 *
 * 老项目用模块级 `lastAutoSnap` 单值（本项目同一时刻只服务一篇笔记，等价）。
 * `manual=true`（菜单里显式点「新增历史版本」）**不过节流**：那是用户明确要的。
 */
let lastAutoSnap = 0;

export function autoSnapshotThrottled(now: number): boolean {
  if (now - lastAutoSnap < AUTO_SNAPSHOT_THROTTLE_MS) return false;
  lastAutoSnap = now;
  return true;
}

/** 供测试复位节流器（不导出到生产路径）。 */
export function _resetAutoSnapshot(): void {
  lastAutoSnap = 0;
}

/**
 * 时间戳 → `MM-DD HH:mm`（月-日 时:分）。
 *
 * 🔴🔴 2026-10-09 修订：改回老项目 `fmtSyncShort`（index.html:5386-5391 **逐字**）的形状。
 *   2026-10-08 曾改成含年含秒的 `YYYY-MM-DD HH:mm:ss` 且下游去掉 ellipsis 截断，
 *   但用户复核后明确要求「改回老版本『不换行、超出省略』，时间戳格式 mm-dd hh:mm」。
 *   老项目历史行用的就是 `fmtSyncShort(item.ts)`（:8494），**不是**含年的 `fmtSyncTime`。
 *
 * 🔴 不自己写一套格式化：老项目那处是全项目共用的，
 *   这里另写一个就会与「最后同步」那行的时间长得不一样。
 *   手动标记由调用方拼（老项目 :8493 `+ (item.manual ? ' · 手动' : '')`）。
 */
export function fmtHistTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

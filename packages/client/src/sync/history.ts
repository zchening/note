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
 * 自动快照节流器 —— **按 noteId 分桶**。
 *
 * 🔴 为什么要节流：自动快照每次保存都打一次，而保存是去抖 700ms 一轮。
 *   不节流的话连续打字 30 秒能把 10 条的环全冲掉，只剩最后几十秒的内容 ——
 *   而用户想找回的恰恰是"一小时前那段"。
 *
 * 🔴🔴 为什么必须**按 noteId 分桶**（P1-3 的病因）：
 *   老项目用模块级 `lastAutoSnap` **单值**，那句"本项目同一时刻只服务一篇笔记"
 *   在老项目里成立，在本项目**不成立** —— 本项目支持多 mountEditor / 中途换笔记。
 *   单值的症状：A 笔记刚自动存了一版，60 秒内切到 B 编辑 ⇒ B 的自动快照
 *   **一律被吞**，B 收不到任何自动版本，而界面零报错（节流返回 false 是"合法"的）。
 *   `manual=true`（菜单里显式点「新增历史版本」）**不过节流**：那是用户明确要的。
 *
 * 🔴🔴 为什么必须**有上限**（分桶带来的新风险：内存无界）：
 *   Map 的 key 是 noteId，用户每新建一篇笔记就多一个 key，且 key **永不过期**
 *   （60 秒窗口只决定"这一桶要不要存"，不决定"这一桶要不要留"）。
 *   长会话 + 大量笔记 ⇒ Map 随笔记数无限增长。这比单值那个 bug 更隐蔽：
 *   它不报错、不丢功能，只是内存一路涨到被系统回收（APK 上就是闪退）。
 *   ⇒ 超过 `MAX_TRACKED_NOTES` 个 key 时丢**最久没被快照过**的那些桶。
 *   丢桶的代价只是"那篇笔记的下一次自动快照可以立刻存"（节流被重置），
 *   而节流本来就是保险不是主链路 —— 这是唯一可以安全丢弃的东西。
 */

/** 桶数上限。超过即丢最旧的桶（理由见上）。 */
export const MAX_TRACKED_NOTES = 200;

/**
 * noteId → 上次自动快照时刻。
 *
 * 🔴 用 Map 而不是对象字面量：noteId 是**用户输入**的（笔记名/url 片段），
 *   拿它当对象 key 会撞上 `__proto__` / `constructor` 这类原型属性。
 */
const lastAutoSnap = new Map<string, number>();

/**
 * 老调用方式（不传 noteId）走的桶。
 *
 * 🔴 留它是为了**向后兼容**：既有 `autoSnapshotThrottled(now)` 的调用点在改完
 *   之前仍是单值语义，行为不变（同一时刻只服务一篇笔记）。
 *   新调用点请一律传 noteId。
 */
const LEGACY_KEY = '';

/**
 * 裁到 `max` 个桶，返回丢掉的桶数。
 *
 * 🔴 丢的是**迭代序最前**的桶：下面的写入路径是"先 delete 再 set"，
 *   于是 Map 的迭代序 = 「最近快照过」从旧到新 —— 头部正是最久没动的笔记。
 */
function trimBuckets(max: number): number {
  const over = lastAutoSnap.size - max;
  if (over <= 0) return 0;
  let dropped = 0;
  // 🔴 边迭代边删是安全的：Map 迭代器允许删除**已经走过**的条目。
  const it = lastAutoSnap.keys();
  for (let i = 0; i < over; i += 1) {
    const n = it.next();
    if (n.done) break;
    lastAutoSnap.delete(n.value);
    dropped += 1;
  }
  return dropped;
}

/**
 * 手动裁剪（供"换笔记 / 退出编辑器"这类时刻显式收口）。
 * @returns 丢掉的桶数
 */
export function pruneAutoSnapshot(max: number = MAX_TRACKED_NOTES): number {
  return trimBuckets(max);
}

/**
 * 这一刻**该**为 `noteId` 存一版自动快照吗？是则同时把时刻记进桶里。
 *
 * 🔴 是"问 + 记"合一（不是纯查询）：分桶之后就没有"只问不记"的调用方了，
 *   拆成两个函数反而会让"问了没记"这种漏记成为可能。
 *
 * @param now `Date.now()`
 * @param noteId 当前笔记 id。不传 = 老的单桶语义（向后兼容，见 LEGACY_KEY）
 */
export function autoSnapshotThrottled(now: number, noteId?: string): boolean {
  const key = noteId === undefined || noteId === '' ? LEGACY_KEY : noteId;
  const last = lastAutoSnap.get(key) ?? 0;
  if (now - last < AUTO_SNAPSHOT_THROTTLE_MS) return false;
  // 🔴 先 delete 再 set：**刷新插入序**，把这一桶挪到末尾（= 最近用过）。
  //   只 set 不 delete 的话，老桶的插入序原地不动，裁剪时会被当成最旧的先丢。
  lastAutoSnap.delete(key);
  lastAutoSnap.set(key, now);
  trimBuckets(MAX_TRACKED_NOTES);
  return true;
}

/** 当前记了几个桶（测试钉内存上界用；生产不读）。 */
export function _autoSnapshotBucketCount(): number {
  return lastAutoSnap.size;
}

/** 供测试复位节流器（不导出到生产路径）。 */
export function _resetAutoSnapshot(): void {
  lastAutoSnap.clear();
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

/**
 * 提醒到点触发的**选择纯函数** —— Bug7（用户报障 2026-10-08）
 *
 * 🔴🔴 为什么单独一个文件：rearm 唤醒时「该 fire 谁」是老项目 v5.54 用户拍板 A
 *   （index.html:7533「过期彻底静默（用户拍板 A）：过期提醒不再补弹卡片，直接排下一条
 *   未来提醒」）的**全部语义所在**，而这段判定此前埋在 reminder/ui.ts 的定时器回调里，
 *   在 node 里不可测 —— 不可测的语义就会被"顺手优化"掉。
 *
 *   bj 此前 rearm() 的口径是「醒来扫一遍所有 due，不在 firedIds 就 fire」：
 *   firedIds 只在内存，点「刷新」（= location.reload()）即丢 ⇒ **每次刷新都把
 *   全部过期提醒炸成一张卡**（用户实测截图：一张卡里塞满过期条目）。
 *   修复后 rearm 只排**未来**的下一条，唤醒时只 fire「当初为它而设」的那条
 *   （±60s 容差，与 RemReceiver.kt 的晚到丢弃线同源）；页面加载时已过期的
 *   一律静默。
 */

/** 最小形状（ui.ts 的 due 列表元素，避免反向依赖 Lexical/DOM 层）。 */
export interface FireableReminder {
  id: string;
  at: string;
}

/** 与 RemReceiver.kt 的丢弃线同源：晚到超过 60s 一律不响（用户拍板：错过的不再弹）。 */
export const FIRE_LATENESS_TOLERANCE_MS = 60_000;

/**
 * 给定「本次唤醒是为哪条提醒而设的」（scheduledAtMs）与当前 due 列表，
 * 算出该 fire 的那几条。
 *
 * @param scheduledAtMs 排程时记下的目标时刻；`undefined` = 没有"为谁而设"的 timer
 *        （典型：页面刚加载、还没有排过任何未来提醒）⇒ **一条都不 fire** ——
 *        这正是"加载时已过期的一律静默"的实现点。
 * @param due 当前已到点的提醒列表（调用方用 dueReminders 算）
 * @param firedIds 本会话已响过的 id（防同一条在 schedule() 重排后重复响）
 */
export function pickFireableAt<T extends FireableReminder>(
  due: readonly T[],
  scheduledAtMs: number | undefined,
  firedIds: ReadonlySet<string>,
): T[] {
  if (scheduledAtMs === undefined) return [];
  const out: T[] = [];
  for (const r of due) {
    if (firedIds.has(r.id)) continue;
    const at = Date.parse(r.at);
    if (!Number.isFinite(at)) continue;
    // 容差带：正常唤醒 now≈at；深睡晚触发 now>at 但不超过 60s。只认"为它而设"的那条。
    if (Math.abs(at - scheduledAtMs) <= FIRE_LATENESS_TOLERANCE_MS) out.push(r);
  }
  return out;
}

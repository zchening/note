/**
 * 条件触发彩蛋的**纯逻辑层** —— 数字梗粒子 / notesync 烟花
 *
 * 🔴🔴 本文件每一条判据都从老项目 `TraeProject/notesync/index.html` **逐字抽出**：
 *   - 数字梗词表与 emoji：`NS_DIGITS`（:5363）
 *   - 尾匹配（长梗优先）与判定式：`nsDigitHit`（:5364）
 *   - notesync 尾匹配：`nsFwHit`（:5485）+ `NS_FW_WORD`（:5461）
 *   - 跳变闩锁：`nsDigitArmed`（:5412-5413、:5445-5447）/ `nsFwArmed`（:5462、:5443）
 *
 * 🔴🔴 **为什么动效绝不能挂在"是否首次发现"上**（本次要治的根因）：
 *   老项目里"放动效"和"记图鉴"是**两件互不相干的事** ——
 *   `nsBurst`/`nsFirework` 由跳变闩锁驱动、**每次成梗都放**；
 *   `nsEggUnlock` 只是顺手记一笔图鉴，而且是**放完之后**才调用。
 *   bj 此前把两者合成一句 `if (markDiscovered(...)) burst(...)`，
 *   而 `markDiscovered` 只在**首次**返回 true 并写进 localStorage ——
 *   症状就是用户报的"第一次之后再也没见过动效"。
 *   🔴 故本文件只管"该不该放"，记账交给调用方**无条件**调 `markDiscovered`。
 *
 * 抽成纯函数是为了能在 node 里钉死：老项目那段埋在 `document` 的 input 监听与
 * TreeWalker 里，jsdom 下不可测 ⇒ "闩锁被优化掉了"这类回归**没有任何判据能拦住**。
 */

import { NUM_GAGS, NUM_GAG_EMOJI } from './registry.ts';

/**
 * 光标前缀的取尾窗口。老项目 v8.3.0 起取 12（`nsCaretPrefix(r…, 12)` :5425）。
 * 🔴 12 是老项目定的：够 `notesync`（8 字）留富余，又不至于扫到上一段落。
 */
export const GAG_TAIL_WINDOW = 12;

/** 老项目 `NS_FW_WORD`（:5461）。 */
export const FW_WORD = 'notesync';

/**
 * 长梗优先的尾匹配顺序。
 *
 * 🔴 老项目 `NS_DIGITS` 的数组顺序本身就是长优先：`[['1314',…],['666',…],…]`。
 *   照抄这个顺序，将来往 `NUM_GAGS` 里加词才不会踩"短的抢在长的前面"的坑。
 */
const GAGS_LONG_FIRST: readonly number[] = [...NUM_GAGS].sort(
  (a, b) => String(b).length - String(a).length,
);

/** 老项目 `nsDigitHit`（:5364）：纯尾匹配（长梗优先）。命中返回该梗的 emoji。 */
export function digitGagEmoji(tail: string): string | null {
  const s = tail ?? '';
  for (const n of GAGS_LONG_FIRST) {
    const p = String(n);
    if (s.length >= p.length && s.slice(-p.length) === p) return NUM_GAG_EMOJI[n] ?? null;
  }
  return null;
}

/** 老项目 `nsFwHit`（:5485）：纯尾匹配、大小写不敏感。只判定，不改正文。 */
export function fwHit(tail: string): boolean {
  const s = (tail ?? '').toLowerCase();
  return s.length >= FW_WORD.length && s.slice(-FW_WORD.length) === FW_WORD;
}

/**
 * 跳变闩锁。老项目 `nsDigitArmed` / `nsFwArmed` **各自都只是一个布尔**。
 *
 * 🔴 语义方向别弄反：
 *   - 命中且未在梗态 ⇒ **放一次**并上膛；
 *   - 已在梗态（连打 666→6666）⇒ 不放；
 *   - 脱梗（光标前缀不再成梗）⇒ **重新上膛**，下次成梗再放。
 */
export interface GagLatch {
  armed: boolean;
}

export function buildGagLatch(): GagLatch {
  return { armed: false };
}

/** 本次该放的数字梗 emoji；`null` = 不放。 */
export function gagFire(latch: GagLatch, tail: string): string | null {
  const emo = digitGagEmoji(tail);
  if (!emo) {
    latch.armed = false; // 老项目 :5445：脱离梗形即重新上膛
    return null;
  }
  if (latch.armed) return null; // 老项目 :5446：已在梗态 —— 连打不重复爆发
  latch.armed = true;
  return emo;
}

/** 本次该不该放 notesync 烟花。 */
export function fwFire(latch: GagLatch, tail: string): boolean {
  if (!fwHit(tail)) {
    latch.armed = false;
    return false;
  }
  if (latch.armed) return false;
  latch.armed = true;
  return true;
}

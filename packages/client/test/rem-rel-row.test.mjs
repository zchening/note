/**
 * RELROW 时间识别的**行内边界**（用户报障 2026-10-15）
 *
 * 报障链：先通过「提醒面板」添加一条（面板会往正文插一行「时间　事项」，
 * 分隔符是**全角空格 U+3000**）→ 再在正文里手写「明天下午4:30事项」→
 * 光标移上去点「添加提醒」→ chip 显示已添加，但真源里**立刻被对账判死**，
 * 用户看到"点了没反应、没添加成功"（且那一串永远没有下划线）。
 *
 * 根因（time-parse.ts `collectRelTimeMatches` 内）：
 *   `if (text.slice(0, start).indexOf('　') !== -1) continue;`
 *   本意是"面板插入行的事项区里别再捞时刻（防幽灵提醒）"，
 *   但它看的是**整段前缀**——面板行一带全角空格，
 *   其后**每一行**的相对时间（"明天下午4:30"）都被整段作废，
 *   对账因此在正文里找不到它 ⇒ 刚添的提醒被判死。
 *
 * 🔴 本文件同时钉住正、反两个方向：
 *   正向：面板行之后的**下一行**相对时间必须被识别（否则提醒存不住）
 *   反向：**同一行**事项区里的时刻仍必须被抑制（否则冒出幽灵提醒）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTimeMatches } from '../src/reminder/time-parse.ts';
import { reconcileReminders } from '../src/reminder/reconcile.ts';

// 🔴 NOW 显式写死，不依赖 Date.now()（判据纪律：时钟依赖的判据会自己骗自己）
const NOW = new Date(2026, 9, 15, 0, 50, 0).getTime();

const hitsOf = (text, now = NOW) =>
  collectTimeMatches(text, now).map((m) => text.slice(m.index, m.index + m.length));

test('RELROW-01 🔴 面板插入行之后，下一行的相对时间必须仍被识别', () => {
  // 面板插入行（带全角空格）+ 用户手写的下一行
  const text = '2026-10-15 0:50　第一条\n明天下午4:30事项';
  const hits = hitsOf(text);
  assert.ok(
    hits.some((h) => h.includes('2026-10-15')),
    '面板插入行自身的时间必须识别，实际=' + JSON.stringify(hits),
  );
  assert.ok(
    hits.some((h) => h.includes('明天')),
    '🔴 下一行的「明天下午4:30」必须被识别——面板行的全角空格不得**跨行**作废后续相对时间，实际=' +
      JSON.stringify(hits),
  );
});

test('RELROW-02 🔴 反向：同一行事项区里的时刻仍必须被抑制（防幽灵提醒）', () => {
  // 「9:30」落在全角空格之后的**同一行**事项区里 ⇒ 不许被当成独立提醒时间
  const text = '2026-10-15 0:50　事项里还有个 9:30 要记';
  const hits = hitsOf(text);
  assert.ok(
    !hits.some((h) => h.trim() === '9:30'),
    '同一行事项区里的时刻必须被抑制（否则每条事项里的时刻都会变成幽灵提醒），实际=' +
      JSON.stringify(hits),
  );
});

test('RELROW-03 🔴 承重：面板行 + 手写相对时间，对账后两条提醒都必须活着', () => {
  const short = collectTimeMatches('明天下午4:30事项', NOW)[0];
  assert.ok(short, '前置：单独文本里应能解析出「明天下午4:30」');
  const doc = {
    v: 1,
    blocks: [
      { t: 'p', spans: [{ t: '2026-10-15 0:50　第一条' }] },
      { t: 'p', spans: [{ t: '明天下午4:30事项' }] },
    ],
    reminders: [
      { id: 'r1', at: new Date(2026, 9, 15, 0, 50, 0).toISOString(), text: '第一条' },
      { id: 'r2', at: new Date(short.at).toISOString(), text: '事项' },
    ],
  };
  const rec = reconcileReminders(doc, NOW);
  assert.equal(
    (rec.doc.reminders ?? []).length,
    2,
    '两条提醒都必须活着（第二条被判死＝用户点添加后真源里没有，正是报障现场）',
  );
  const marked = [];
  for (const b of rec.doc.blocks ?? []) {
    for (const s of b.spans ?? []) if (s.rem !== undefined) marked.push(s.t);
  }
  assert.ok(
    marked.some((t) => t.includes('明天')),
    '第二条对应的正文时间串必须被打上标记（用户可见的下划线），实际标记=' + JSON.stringify(marked),
  );
});

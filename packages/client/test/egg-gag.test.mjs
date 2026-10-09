/**
 * 数字梗 / notesync 烟花的**纯逻辑**单测（GAG 系列）
 *
 * 🔴 这组测试保护两件最容易静默坏掉的事：
 *   1. **词表与 emoji 是老项目那份**（不是 bj 自创的 888/6666，也不是"所有梗都撒 🔥"）
 *   2. **跳变闩锁还在** —— 它决定"每次成梗都放"还是"只放一次"。
 *      埋在 DOM 监听里时它**没有任何判据能拦住**被优化掉，故抽成纯函数钉在这里。
 *
 * 🔴🔴 每条判据都标注了老项目 index.html 的行号来源，**不许凭推理改判据**：
 *   老判据钉错口径与"实现回退"会长得一模一样。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GAG_TAIL_WINDOW,
  digitGagEmoji,
  fwFire,
  fwHit,
  gagFire,
  buildGagLatch,
} from '../src/egg/gag.ts';
import { NUM_GAGS, NUM_GAG_EMOJI } from '../src/egg/registry.ts';

test('GAG-01 🔴 数字梗词表逐字等于老项目 NS_DIGITS（index.html:5363）', () => {
  // 🔴 老项目是 [['1314','🎆'],['666','🔥'],['520','💕'],['233','😂']]。
  //   bj 曾经是 [666,520,1314,888,6666] —— 少了 233、多了老项目没有的 888/6666。
  assert.deepEqual([...NUM_GAGS], [1314, 666, 520, 233]);
  assert.equal(NUM_GAGS.includes(233), true, '老项目的 233 必须回来');
  assert.equal(NUM_GAGS.includes(888), false, '老项目没有 888');
  assert.equal(NUM_GAGS.includes(6666), false, '老项目没有 6666');
});

test('GAG-02 🔴 四个梗各有各的 emoji（不是所有梗都撒同一个 🔥）', () => {
  assert.deepEqual({ ...NUM_GAG_EMOJI }, { 1314: '🎆', 666: '🔥', 520: '💕', 233: '😂' });
  // 逐个取，且与"统一撒 🔥"反向钉：1314 绝不能是 🔥
  assert.notEqual(NUM_GAG_EMOJI[1314], '🔥', '1314 不该和 666 同一个 emoji');
});

test('GAG-03 🔴 纯尾匹配（老项目 nsDigitHit :5364）：只看光标前那几个字', () => {
  assert.equal(digitGagEmoji('1314'), '🎆');
  assert.equal(digitGagEmoji('666'), '🔥');
  assert.equal(digitGagEmoji('520'), '💕');
  assert.equal(digitGagEmoji('233'), '😂');
  // 文中/前邻数字也算：老项目 v8.2.1 正是为"3点666 被吞"重做的（:5358-5362）
  assert.equal(digitGagEmoji('3点666'), '🔥', '光标前是「3点666」时应命中（老项目实锤的口径）');
  // 尾匹配 ⇒ "1666" 的尾三位是 666，老项目同样命中（不是"独立数字串"判定）
  assert.equal(digitGagEmoji('1666'), '🔥', '老项目是纯尾匹配，前邻数字不挡');
  // 没成梗
  assert.equal(digitGagEmoji('66'), null, '66 还没成梗');
  assert.equal(digitGagEmoji('13145'), null, '尾不是梗（5 结尾）');
  assert.equal(digitGagEmoji(''), null);
});

test('GAG-04 🔴🔴 跳变闩锁：连打不重爆、脱梗即重新上膛（老项目 :5412/:5445）', () => {
  const latch = buildGagLatch();
  assert.equal(gagFire(latch, '66'), null, '没成梗不放');
  assert.equal(gagFire(latch, '666'), '🔥', '第一次成梗要放');
  assert.equal(latch.armed, true, '放完即上膛');
  // 连打 666→6666：尾仍是 666 ⇒ 已在梗态，不放
  assert.equal(gagFire(latch, '6666'), null, '同梗连打不许重复爆发（老项目 :5446）');
  // 脱梗 ⇒ 解上膛
  assert.equal(gagFire(latch, '66'), null, '脱梗不放');
  assert.equal(latch.armed, false, '脱梗必须重新上膛，否则下次永远不放');
  // 再成梗 ⇒ 又要放（这条是"只放一次"那个 bug 的正面判据）
  assert.equal(gagFire(latch, '666'), '🔥', '重新上膛后再次成梗必须再放一次');
});

test('GAG-05 🔴 notesync 尾匹配大小写不敏感（老项目 nsFwHit :5485）', () => {
  assert.equal(fwHit('notesync'), true);
  assert.equal(fwHit('NoteSync'), true, '老项目 toLowerCase 后比较');
  assert.equal(fwHit('NOTESYNC'), true);
  assert.equal(fwHit('xnotesync'), true, '纯尾匹配：前面有字也算');
  assert.equal(fwHit('notesyncx'), false, '尾不是 notesync 就不算');
  assert.equal(fwHit('notesyn'), false, '还没打完');
});

test('GAG-06 🔴 notesync 闩锁同款跳变（老项目 nsFwArmed :5462）', () => {
  const latch = buildGagLatch();
  assert.equal(fwFire(latch, 'notesyn'), false);
  assert.equal(fwFire(latch, 'notesync'), true, '成词要放');
  assert.equal(fwFire(latch, 'notesync'), false, '还在词内不许连放');
  assert.equal(fwFire(latch, 'abc'), false, '离词');
  assert.equal(fwFire(latch, 'notesync'), true, '离词后重新成词必须再放');
});

test('GAG-07 取尾窗口是老项目的 12（v8.3.0 :5425）', () => {
  assert.equal(GAG_TAIL_WINDOW, 12);
  // 窗口够 notesync（8 字）留富余
  assert.ok(GAG_TAIL_WINDOW >= 'notesync'.length, '窗口必须容得下 notesync');
});

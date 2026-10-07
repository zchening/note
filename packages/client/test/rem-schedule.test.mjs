/**
 * 提醒到点触发的**选择纯函数**（FIRE- 系列）—— Bug7 用户报障
 *
 * 🔴🔴 背景：点「刷新」= location.reload()，重载后 bj 的 rearm() 会把**所有已过期**
 *   的提醒全部弹卡（firedIds 只在内存，重载即丢）—— 用户实测每次刷新都炸出一张
 *   塞满过期提醒的响铃卡。
 *
 *   老项目 v5.54 的现行口径（index.html:7533 注释原文「v5.54 过期彻底静默（用户拍板 A）：
 *   过期提醒不再补弹卡片，直接排下一条未来提醒」）：
 *     - 页面加载时已过期的提醒**一律不弹**；
 *     - 只有「页面开着时到点的那一条」（即 timer 为它而设、到点自然唤醒的那条）才响；
 *     - 设备深睡晚触发有限容忍（RemReceiver :60s 丢弃线同源）。
 *
 *   bj 此前 rearm() 是「醒来扫一遍所有 due，不在 firedIds 就 fire」—— 语义完全不同。
 *   修复后 rearm 只排**未来**的下一条，唤醒时只 fire「当初为它而设」的那条；
 *   本文件把「唤醒时该 fire 谁」抽成纯函数钉死，让"扫描所有 due"这类回归
 *   在 node 里就能拦住。
 *
 * 判据纪律：全部 import 生产代码；每条「应该有」配一条「不应该有」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickFireableAt } from '../src/reminder/schedule.ts';

const R = (id, atMs) => ({ id, at: new Date(atMs).toISOString() });
const T0 = new Date(2026, 9, 8, 15, 0, 0).getTime();

test('FIRE-01 🔴 页面加载（无在途 timer）时，已过期的提醒一条都不 fire', () => {
  const due = [R('a', T0 - 3600_000), R('b', T0 - 60_000)];
  const out = pickFireableAt(due, undefined, new Set());
  assert.deepEqual(out, [], '加载时已过期的提醒必须全部静默（老项目 v5.54 用户拍板 A）');
});

test('FIRE-02 为它而设的 timer 醒来：只 fire 恰好到点的那条', () => {
  const due = [R('past', T0 - 3600_000), R('due', T0 - 1000), R('future', T0 + 3600_000)];
  const out = pickFireableAt(due, T0, new Set());
  assert.deepEqual(out.map((r) => r.id), ['due'], '只 fire 当初排程的那条，过期与未来都不动');
});

test('FIRE-03 同一时刻多条提醒一起 fire（同 at 合法）', () => {
  const due = [R('x', T0), R('y', T0)];
  const out = pickFireableAt(due, T0, new Set());
  assert.equal(out.length, 2);
});

test('FIRE-04 已 fire 过的（firedIds）不重复 fire', () => {
  const due = [R('due', T0)];
  const out = pickFireableAt(due, T0, new Set(['due']));
  assert.deepEqual(out, []);
});

test('FIRE-05 深睡晚触发在 60s 容差内仍 fire（与 RemReceiver 丢弃线同源）', () => {
  const due = [R('late', T0 - 30_000)];
  const out = pickFireableAt(due, T0, new Set());
  assert.deepEqual(out.map((r) => r.id), ['late'], '晚到 30s 属可容忍，必须响');
});

test('FIRE-06 晚到超过 60s 不 fire（与 RemReceiver 丢弃线同源）', () => {
  const due = [R('toolate', T0 - 61_000)];
  const out = pickFireableAt(due, T0, new Set());
  assert.deepEqual(out, [], '晚到超过 60s 一律丢弃');
});

/**
 * 历史版本时间戳格式闸 —— 用户报障「改回老版本 mm-dd hh:mm」
 *
 * 🔴🔴 背景（2026-10-08 → 2026-10-09 来回改过两次，必须钉死）：
 *   老项目历史行用的是 `fmtSyncShort(item.ts)`（index.html:8494），形状是
 *   `MM-DD HH:mm`（月-日 时:分，**无年无秒**），且行上 `.hist-meta` 是
 *   `white-space:nowrap + text-overflow:ellipsis`（index.html:469 逐字）。
 *   2026-10-08 曾改成含年含秒的 `YYYY-MM-DD HH:mm:ss` 并去掉截断；
 *   用户复核后要求**改回老版本形状**。本判据把这条钉住，防止再来回漂。
 *
 * 🔴 纪律：import 生产代码里的 fmtHistTime，不把实现抄进测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installBrowserShims } from './dom-shims.mjs';
installBrowserShims();

const { fmtHistTime } = await import('../src/sync/history.ts');

test('HIST-FMT-01 🔴 时间戳形状是 MM-DD HH:mm（老项目 fmtSyncShort 逐字）', () => {
  // 2026-03-07 09:05 → "03-07 09:05"
  const t = new Date(2026, 2, 7, 9, 5, 42).getTime();
  assert.equal(fmtHistTime(t), '03-07 09:05');
});

test('HIST-FMT-02 反向：不含年份、不含秒（老项目那处就没有）', () => {
  const t = new Date(2026, 2, 7, 9, 5, 42).getTime();
  const s = fmtHistTime(t);
  assert.ok(!/\d{4}/.test(s), `不该出现 4 位年份：${s}`);
  // 秒：形状里冒号只出现一次（时:分），两次就是带秒了
  assert.equal((s.match(/:/g) ?? []).length, 1, `不该带秒：${s}`);
  assert.match(s, /^\d{2}-\d{2} \d{2}:\d{2}$/, `形状必须是 MM-DD HH:mm：${s}`);
});

test('HIST-FMT-03 月/日/时/分一律零填充两位（个位数不塌成一位）', () => {
  const t = new Date(2026, 0, 3, 4, 5, 0).getTime(); // 01-03 04:05
  assert.equal(fmtHistTime(t), '01-03 04:05');
});

test('HIST-FMT-04 12 月 31 日 23:59 边界不溢出', () => {
  const t = new Date(2026, 11, 31, 23, 59, 59).getTime();
  assert.equal(fmtHistTime(t), '12-31 23:59');
});

test('HIST-FMT-05 🔴 styles.css 的历史行必须是 nowrap + ellipsis 截断（老项目 :469）', () => {
  // 🔴 与时间格式是**同一条用户诉求的两半**：格式改回 mm-dd hh:mm，
  //   行上也要改回"不换行、超出省略"。只改一半 = 用户看到的还是另一种样子。
  //   判据读 CSS 源码（去掉注释），避免"注释里写着 nowrap"骗过正则。
  const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = noComment.match(/\.list-row\s+\.hist-meta\s*\{[^}]*\}/);
  assert.ok(m, 'styles.css 应有 .list-row .hist-meta 规则');
  const rule = m[0];
  assert.match(rule, /white-space:\s*nowrap/, '.hist-meta 必须 nowrap（不换行）');
  assert.match(rule, /text-overflow:\s*ellipsis/, '.hist-meta 必须 ellipsis（超出省略）');
  assert.match(rule, /overflow:\s*hidden/, '.hist-meta 必须 overflow:hidden（省略号的前提）');
});

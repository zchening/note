/**
 * v3.0.11 跨段组字串塌方守卫判据（COMPOSE 系列）
 *
 * ── 它要钉住什么 ─────────────────────────────────────────────────────────
 *   豆包智能整理把整篇正文作为一个组字串替换，Lexical 原生合成回灌只回灌 anchor
 *   单节点 ⇒ 跨段时正文被吞。守卫在 update 监听里检测「合成中（输入事件流 isComposing
 *   驱动）+ 单帧灾难性塌方」，命中即把真源回退到塌方前那帧。
 *
 * ── 变异说明（先红后改）──────────────────────────────────────────────────
 *   把 decideCollapseRestore 的 `multiBlock` 分支删掉 ⇒ COMPOSE-01 红；
 *   把 `relDrop` 判据删掉 ⇒ 116→100 这种小幅删除被误拦 ⇒ COMPOSE-02 红；
 *   把极端塌方兜底分支删掉 ⇒ 漏捕获 compositionstart 时整篇被吞无兜底
 *     ⇒ COMPOSE-03 红；把 `minPrev` 判据删掉 ⇒ 短文档正常编辑误伤
 *     ⇒ COMPOSE-04 红；把 observe 的 composing 门控删掉（composing=false 也回退）
 *     ⇒ 非合成期也回退 ⇒ COMPOSE-06 红；v3.0.10 漏拦真因：守卫只靠 compositionstart
 *     激活 ⇒ 豆包智能整理不发该事件时从不触发 ⇒ COMPOSE-09 专门钉这个回归。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideCollapseRestore, ComposeGuard, DEFAULT_COMPOSE_GUARD } from '../src/sync/compose-guard.ts';

const CFG = DEFAULT_COMPOSE_GUARD;

test('COMPOSE-01 🔴 跨段合成 + 116→19 灾难性塌方必须回退', () => {
  const d = decideCollapseRestore({ currentLen: 19, prevLen: 116, multiBlock: true, cfg: CFG });
  assert.equal(d.restore, true, '跨段整理塌方应回退');
  assert.match(d.reason, /multiBlock collapse/);
});

test('COMPOSE-02 🔴 跨段合成但删除未越 absDrop（116→80）不得误拦', () => {
  // drop=36 >= absDrop(30)，但 current(80) >= prev*(1-relDrop)=58 ⇒ rel-ok 不回退
  const d = decideCollapseRestore({ currentLen: 80, prevLen: 116, multiBlock: true, cfg: CFG });
  assert.equal(d.restore, false, '未越相对阈值不应回退');
  assert.equal(d.reason, 'rel-ok');
});

test('COMPOSE-03 🔴 极端单帧塌方（116→19，没捕获到 compositionstart）仍兜底', () => {
  const d = decideCollapseRestore({ currentLen: 19, prevLen: 116, multiBlock: false, cfg: CFG });
  assert.equal(d.restore, true, '极端塌方必须兜底');
  assert.match(d.reason, /extreme collapse/);
});

test('COMPOSE-04 🔴 单块中等删除（116→50）不得回退（避免误伤正常编辑）', () => {
  const d = decideCollapseRestore({ currentLen: 50, prevLen: 116, multiBlock: false, cfg: CFG });
  assert.equal(d.restore, false, '单块中等删除不应回退');
});

test('COMPOSE-05 🔴 短文档（prev<minPrev）不参与判定', () => {
  const d = decideCollapseRestore({ currentLen: 1, prevLen: 30, multiBlock: true, cfg: CFG });
  assert.equal(d.restore, false);
  assert.equal(d.reason, 'prev<min');
});

test('COMPOSE-06 🔴 非合成期（composing=false）绝不应回退', () => {
  const g = new ComposeGuard();
  // 未 begin 且 composing=false：observe 应直接 not-composing
  assert.equal(g.observe(19, false).restore, false);
  assert.equal(g.observe(19, false).reason, 'not-composing');
});

test('COMPOSE-09 🔴🔴 回归：漏掉 compositionstart 时，composing=true 的塌方仍须回退', () => {
  // v3.0.10 漏拦真因：豆包智能整理只发 insertCompositionText、不发 compositionstart，
  // 守卫从不激活 ⇒ 塌方被漏掉。这里模拟"从未 begin"，但每帧 composing=true（输入事件流
  // 的 isComposing 可靠）。守卫必须兜住单帧灾难性塌方，且 lastLen 每帧维护使 prevLen 正确。
  const g = new ComposeGuard();
  g.observe(100, true); // prevLen=0→100，drop 为负，不回退；但 lastLen 维护为 100
  g.observe(116, true); // lastLen=116
  const hit = g.observe(19, true); // 单帧 116→19，composing=true，compositionstart 从未触发
  assert.equal(hit.restore, true, '漏 compositionstart 时塌方仍须回退');
  assert.match(hit.reason, /extreme collapse/, '走极端塌方兜底（multiBlock 未知）');
  assert.equal(g.didRestore, true);
  // 之后即便 composing 转 false，不应再误回退
  assert.equal(g.observe(116, false).restore, false);
});

test('COMPOSE-07 🔴 状态机：begin→增长不回退→塌方回退→恢复不回退→end 后不回退', () => {
  const g = new ComposeGuard();
  g.begin(true, 100);
  assert.equal(g.isActive, true);
  assert.equal(g.isMultiBlock, true);
  // 组字串增长到 116（正常构建）
  assert.equal(g.observe(116, true).restore, false);
  // 单帧塌方 116→19
  const hit = g.observe(19, true);
  assert.equal(hit.restore, true);
  assert.equal(g.didRestore, true);
  // 重建回 116，不得再回退（drop 为负）
  assert.equal(g.observe(116, true).restore, false);
  // compositionend 后即便再塌方也不回退
  g.end();
  assert.equal(g.isActive, false);
  assert.equal(g.observe(19, false).restore, false);
  assert.equal(g.observe(19, false).reason, 'not-composing');
});

test('COMPOSE-08 🔴 单块 + 阈值边界（current 恰好 = prev*(1-relDrop) 不算塌方）', () => {
  // prev=116, relDrop=0.5 ⇒ 阈值 58；current=58 时 currentLen > 58 为假，恰等于阈值⇒不回退
  const d = decideCollapseRestore({ currentLen: 58, prevLen: 116, multiBlock: true, cfg: CFG });
  assert.equal(d.restore, false, '恰好等于相对阈值边界不算灾难性');
});

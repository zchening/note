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

/* ============ WD 系列（v3.0.14）：组字会话水位线 —— 撤稿吞字守卫 ============ */
/*
 * v3.0.13 真机日志钉死的新丢字形状：collapse=17 全在早期、drop=2→6（4 次组字中
 * 缩水全部低于塌方阈值）、最终文档只剩第一句 13 字 —— 渐进放血 + 收尾撤稿对
 * 「单帧灾难性塌方」模型全盲。守卫改为盯**会话水位线**：一段组字会话
 * （composing 连续为真）内记峰值长度与峰值帧文档；会话结束（composing 转假）
 * 时若真源比峰值掉了超过 max(floorAbs, peak*floorRel) ⇒ 撤稿吞字 ⇒ 回写峰值帧。
 * 此时组字已结束，重建不再杀活组字，无对抗。
 */

import { WithdrawGuard, DEFAULT_WITHDRAW_GUARD } from '../src/sync/compose-guard.ts';

const WCFG = DEFAULT_WITHDRAW_GUARD;
/** 假文档：长度即内容（纯对象，守卫只存引用不解释）。 */
const fakeDoc = (n) => ({ tag: 'doc' + n });

test('WD-01 🔴 撤稿吞字：会话内涨到峰值，结束时真源被啃短 ⇒ 必须回写峰值帧', () => {
  const g = new WithdrawGuard(WCFG);
  const peakDoc = fakeDoc(108); // 持引用：断言的是同一帧的 exported 对象
  // 会话：组字帧 1→108（每帧 composing=true，长度递增）
  for (let n = 1; n <= 108; n += 1) {
    const d = g.observe(n, true, n - 1, n === 108 ? peakDoc : fakeDoc(n));
    assert.equal(d.restore, false, '会话进行中绝不触发');
  }
  // 会话结束帧：composing=false，真源被啃到 13（豆包撤稿形状）
  const end = g.observe(13, false, 108, fakeDoc(13));
  assert.equal(end.restore, true, '🔴 峰值 108 → 结束 13，掉幅 95 远超阈值，必须判撤稿');
  assert.equal(end.doc, peakDoc, '🔴 必须回写峰值那帧的文档（第 108 帧的 exported）');
  assert.ok(end.reason.includes('108'), 'reason 必须带峰值与当前长度便于取证');
});

test('WD-02 会话内修订缩水不触发（只在会话结束帧判定）', () => {
  const g = new WithdrawGuard(WCFG);
  for (let n = 1; n <= 108; n += 1) g.observe(n, true, n - 1, fakeDoc(n));
  // 语音重识别修订：组字继续，串变短（composing 仍 true）
  assert.equal(g.observe(88, true, 108, fakeDoc(88)).restore, false);
  assert.equal(g.observe(70, true, 88, fakeDoc(70)).restore, false);
  // 修订后又涨回并超过旧峰值 ⇒ 峰值随行进更新
  const d2 = g.observe(120, true, 70, fakeDoc(120));
  assert.equal(d2.restore, false);
  // 正常收尾：结束时长度 ≈ 峰值 ⇒ 不回写
  const end = g.observe(119, false, 120, fakeDoc(119));
  assert.equal(end.restore, false, '掉幅 1 在容差内，是正常收尾不是撤稿');
});

test('WD-03 容差：结束时掉幅在 max(floorAbs, peak*floorRel) 内不回写', () => {
  const g = new WithdrawGuard(WCFG);
  for (let n = 1; n <= 108; n += 1) g.observe(n, true, n - 1, fakeDoc(n));
  // 豆包收尾去填充词（呃/那个）：掉 13 字 < max(12, 108*0.15=16.2) ⇒ 保留
  const end = g.observe(95, false, 108, fakeDoc(95));
  assert.equal(end.restore, false, '掉幅 13 ≤ 容差 16.2，是正常润色不是撤稿');
});

test('WD-04 小会话也保护：peak=20，结束时被啃到 6（掉 14 > max(12, 3)）⇒ 回写', () => {
  const g = new WithdrawGuard(WCFG);
  const peakDoc = fakeDoc(20);
  for (let n = 1; n <= 20; n += 1) g.observe(n, true, n - 1, n === 20 ? peakDoc : fakeDoc(n));
  const end = g.observe(6, false, 20, fakeDoc(6));
  assert.equal(end.restore, true, '短口述被撤稿同样要救（floorAbs=12 兜住小会话）');
  assert.equal(end.doc, peakDoc);
});

test('WD-05 会话结束后重新武装：新会话的 base/peak 全部重置', () => {
  const g = new WithdrawGuard(WCFG);
  for (let n = 1; n <= 108; n += 1) g.observe(n, true, n - 1, fakeDoc(n));
  g.observe(13, false, 108, fakeDoc(13)); // 会话1 结束（撤稿）
  // 新会话：从 14 涨到 40，正常结束
  for (let n = 14; n <= 40; n += 1) {
    const d = g.observe(n, true, n - 1, fakeDoc(n));
    assert.equal(d.restore, false, '新会话不得被旧会话的峰值污染');
  }
  const end = g.observe(40, false, 40, fakeDoc(40));
  assert.equal(end.restore, false, '新会话正常收尾');
  // 新会话被撤稿：峰值必须是新会话的 40，不是旧会话的 108
  const peakDoc2 = fakeDoc(40);
  for (let n = 1; n <= 40; n += 1) g.observe(n, true, n - 1, n === 40 ? peakDoc2 : fakeDoc(n));
  const end2 = g.observe(5, false, 40, fakeDoc(5));
  assert.equal(end2.restore, true, '第二次撤稿同样要救');
  assert.equal(end2.doc, peakDoc2, '回写的必须是**本会话**峰值帧（40），不是上会话的 108');
});

test('WD-06 无会话时 composing=false 是 no-op', () => {
  const g = new WithdrawGuard(WCFG);
  const d = g.observe(10, false, 12, fakeDoc(10));
  assert.equal(d.restore, false, '没进过组字会话，普通编辑永不触发');
});

test('WD-07 🔴 撤稿恢复后本帧不得再触发（幂等：守卫状态已复位）', () => {
  const g = new WithdrawGuard(WCFG);
  for (let n = 1; n <= 50; n += 1) g.observe(n, true, n - 1, fakeDoc(n));
  const end = g.observe(5, false, 50, fakeDoc(5));
  assert.equal(end.restore, true);
  // 恢复动作本身也是一次 update（长度跳回 50）：composing 仍 false，无会话 ⇒ no-op
  const again = g.observe(50, false, 5, fakeDoc(50));
  assert.equal(again.restore, false, '恢复帧自身不得再触发（否则无限循环）');
});

test('WD-08 🔴 ce 的 flush 先到（长度未变）、撤稿下一帧才落地 ⇒ 宽限窗内必须救', () => {
  // e2e 探针实测的真机时序：in:ce → upd len=108 d=0 → upd len=13 d=-95。
  const g = new WithdrawGuard(WCFG);
  const peakDoc = fakeDoc(108);
  for (let n = 1; n <= 108; n += 1) g.observe(n, true, n - 1, n === 108 ? peakDoc : fakeDoc(n));
  // ce flush 帧：composing=false 但长度还是 108 ⇒ 不触发，但进入宽限
  const flush = g.observe(108, false, 108, fakeDoc(108));
  assert.equal(flush.restore, false, 'flush 帧长度未变，不得触发');
  assert.equal(g.isSessionActive, true, '🔴 必须处于 ending 宽限态，不能就此收场');
  // 撤稿落地帧：真源被啃到 13
  const end = g.observe(13, false, 108, fakeDoc(13));
  assert.equal(end.restore, true, '🔴 撤稿落地时必须救回峰值');
  assert.equal(end.doc, peakDoc);
});

test('WD-09 宽限窗只有 2 帧：过期后不再回写（不与用户后续编辑对抗）', () => {
  const g = new WithdrawGuard(WCFG);
  for (let n = 1; n <= 108; n += 1) g.observe(n, true, n - 1, fakeDoc(n));
  g.observe(108, false, 108, fakeDoc(108)); // flush 帧（宽限 2 帧）
  g.observe(107, false, 108, fakeDoc(107)); // 第 1 帧：掉 1 容差内
  const late = g.observe(13, false, 107, fakeDoc(13)); // 第 2 帧：宽限耗尽
  assert.equal(late.restore, false, '🔴 宽限耗尽后不得再回写（用户可能已在手动编辑）');
  assert.equal(g.isSessionActive, false, '会话必须已收场');
});

test('WD-10 宽限期内组字恢复 ⇒ pending 中止，峰值以当前帧重续（修订不是撤稿）', () => {
  const g = new WithdrawGuard(WCFG);
  for (let n = 1; n <= 108; n += 1) g.observe(n, true, n - 1, fakeDoc(n));
  g.observe(108, false, 108, fakeDoc(108)); // flush 帧
  // 组字恢复（comp=1 帧又来了，当前 60）：缩水是修订，撤稿判定必须中止
  const r = g.observe(60, true, 108, fakeDoc(60));
  assert.equal(r.restore, false);
  assert.equal(g.peak, 60, '峰值以恢复帧为基准重续，不背历史 108');
  // 新会话正常收尾：不得回写 108
  const end = g.observe(59, false, 60, fakeDoc(59));
  assert.equal(end.restore, false, '掉幅 1 容差内；历史峰值 108 不得复活');
});

/* ── v3.1.3：单段组字中的「宿主替换错位」兜底 ──────────────────────────────
 * 🔴 真机 v3.1.1/v3.1.2 日志钉死（用户报「说着说着自动截断、后面录不进去」）：
 *   组字串 d=143 恒定，树 143→49（掉 66%，extreme 兜底差 6 字没过：49 >
 *   143×0.3=42.9）→ 旧判定 single-block 放行 ⇒ 残串写进真源并 push 到云端
 *   （push len=96，内容真丢）；随后 49→9（prevLen=49 < extreme 的 80 下限）
 *   再次放行。指纹：**组字串没变短而树骤降** = 串在树丢（宿主替换区域错位），
 *   不是用户删字（删字会连组字串一起变短）。
 * ── 变异说明：把 composing-mismatch 分支删掉 ⇒ COMPOSE-10 红。 */
test('COMPOSE-10 🔴🔴 单段组字中宿主替换错位（串仍在、树骤降）必须拦（真机钉死）', () => {
  // 真机第一掉：143→49，组字串 143 恒定（远长于 49+12）
  const d = decideCollapseRestore({ currentLen: 49, prevLen: 143, multiBlock: false, cfg: CFG, composingDataLen: 143 });
  assert.equal(d.restore, true, '🔴 组字串仍远长于文档 = 宿主替换错位，必须拦下回写');
  assert.match(d.reason, /composing-mismatch/);
  // 真机第二掉：49→9，组字串 140 仍在（extreme 因 prev<80 不会命中）
  const d2 = decideCollapseRestore({ currentLen: 9, prevLen: 49, multiBlock: false, cfg: CFG, composingDataLen: 140 });
  assert.equal(d2.restore, true, '🔴 二次掉幅同样必须拦');
  // 反例：组字串与树一起变短（55 ≈ 树 50）＝真删字/真修订 ⇒ 不得拦
  //（50 < 71.5 过 rel、50 > 42.9 不过 extreme → 只能靠新分支放行语义钉住）
  const d3 = decideCollapseRestore({ currentLen: 50, prevLen: 143, multiBlock: false, cfg: CFG, composingDataLen: 55 });
  assert.equal(d3.restore, false, '组字串同步变短 = 真删字，不得拦（防止对抗合法修订）');
  // 向后兼容：不传 composingDataLen（旧调用方/旧判据）保持旧行为
  const d4 = decideCollapseRestore({ currentLen: 49, prevLen: 143, multiBlock: false, cfg: CFG });
  assert.equal(d4.restore, false, '未喂组字串长度时保持旧行为（COMPOSE-04 兼容）');
});

test('COMPOSE-11 🔴 守卫 observe 必须把组字串长度喂进判定（main.ts 接线）', () => {
  // main.ts 的 observe 调用点必须传 lastBiDataLen —— 否则新分支在生产里永远拿不到串长
  const g = new ComposeGuard(CFG);
  for (let n = 1; n <= 143; n += 1) g.observe(n, true);
  const d = g.observe(49, true, 143);
  assert.equal(d.restore, true, '🔴 observe 第三参（组字串长）必须参与判定');
  assert.match(d.reason, /composing-mismatch/);
  // 不传第三参 ⇒ 旧行为
  const g2 = new ComposeGuard(CFG);
  for (let n = 1; n <= 143; n += 1) g2.observe(n, true);
  const d2 = g2.observe(49, true);
  assert.equal(d2.restore, false, '未传串长时保持旧行为');
});

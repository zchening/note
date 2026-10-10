/**
 * 「整段改写会话窗口」判据（SYNC-IME-BULK 系列，v3.0.8）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 用户报障（v3.0.7 上线后"还是不行"）：
 *   豆包输入法「智能整理 / 精炼润色」把整篇笔记改写后，只剩最后一段，
 *   前面的「帮我记录3件事」和前两条全丢。小米自带笔记同样操作不丢。
 *
 * ── 病根 ───────────────────────────────────────────────────────────────────
 *   智能整理的输入序列是「大段删除原文 → 静默（"识别优化中"）→ 分批插入整理稿」。
 *   删除与批次之间的静默**超过**既有的两个时间窗（1.5s 活跃期 + 4s 组字冷却）：
 *   那一刻组字态早已结束，`canApply()` 按时间判定"没在输入"开门放行 ⇒
 *   一切程序化动树（回灌 / 补铺 / 链接识别 / 折叠建组）都能在批次间隙下刀。
 *   Android 输入法靠 `InputConnection` 的文本视图定位，树一动视图就错位，
 *   它下一次 `commitText` 按旧偏移操作 ⇒ 前面几段被整段替换（用户报障原文）。
 *
 * ── 修法（见 ime-gate.ts 的 BULK_REWRITE_MS / noteBulkEdit / canEditTree）──
 *   时间窗盖不住它 ⇒ 用**结构痕迹**触发：main.ts 的 update 监听器发现
 *   「这次 update 删掉了 ≥ 8 个字符」⇒ `noteBulkEdit()` 开一个**固定长度**
 *   （6s，不滑动）的会话窗口，期间 `canEditTree()` 恒 false ——
 *   它比 `canApply()` 只多这一条，回灌 / 补铺 / 链接识别 / 折叠建组全部改判它。
 *   6s 后必然放行（下轮轮询自动重试，推迟不排队）。
 *
 * ── 判据纪律 ───────────────────────────────────────────────────────────────
 *   · 时间相关判据**必须注入时钟**（now 参数）。
 *   · 变异验证（先红后改）：把 `ime-gate.ts` 里 `canEditTree()` 的
 *     `if (bulkActive()) return false;` 一行删掉 ⇒ BULK-01 / BULK-02 / BULK-04 红；
 *     把 `noteBulkEdit()` 的 `lastBulkEditAt = now();` 删掉 ⇒ BULK-01 红
 *     （窗口从未打开）；把 BULK-03 靶心（固定长度）对应的"输入续窗"逻辑加回去
 *     （noteInput 里顺手刷新 lastBulkEditAt）⇒ BULK-03 红。四向验证过。
 *   · `canApply()` 的语义必须**原封不动**：bulk 窗口只叠加在 canEditTree 上，
 *     谁要是因为这个改动让 canApply 在 bulk 窗口内变 false，BULK-05 会红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImeGate,
  TYPE_ACTIVE_MS,
  COMPOSE_COOLDOWN_MS,
  BULK_REWRITE_MS,
} from '../src/sync/ime-gate.ts';

/** 一个不挂真 DOM 的宿主（与 VOICE-01 同款），拿到事件处理器以便驱动。 */
function fakeHost() {
  const handlers = {};
  return {
    host: {
      addEventListener: (k, f) => { handlers[k] = f; },
      removeEventListener: () => undefined,
    },
    handlers,
  };
}

/* ------------------------------------------------------------------ *
 * SYNC-IME-BULK-01 🔴 整段删除 ⇒ 窗口内 canEditTree 恒 false，canApply 不受影响
 * ------------------------------------------------------------------ */
test('SYNC-IME-BULK-01 noteBulkEdit 开窗：canEditTree 关而 canApply 保持原语义', () => {
  let t = 1000;
  const gate = createImeGate(() => t);

  // 没有任何输入痕迹的新门控：两个谓词都放行
  assert.equal(gate.canApply(), true, '新门控无输入痕迹时 canApply 必须放行');
  assert.equal(gate.canEditTree(), true, '新门控无输入痕迹时 canEditTree 必须放行');

  // 模拟豆包智能整理的第一步：大段删除（update 监听器据此调 noteBulkEdit）
  gate.noteBulkEdit();

  // 🔴 靶心 1：窗口内动树谓词必须关。
  //   此刻既没组字、也没打字 —— canApply 的时间窗全开，唯有 bulk 窗口在拦。
  assert.equal(gate.bulkActive, true, 'noteBulkEdit 之后 bulkActive 必须为真');
  assert.equal(
    gate.canEditTree(),
    false,
    '🔴 整段删除后的会话窗口内禁止一切程序化动树（回灌/补铺/链接识别/折叠建组）',
  );
  // 🔴 靶心 2：canApply 语义**原封不动** —— bulk 窗口只叠加在 canEditTree 上，
  //   不许反向污染（client.ts 的旧注入点、以及任何"只判 canApply"的路径不受影响）。
  assert.equal(
    gate.canApply(),
    true,
    'bulk 窗口不得改变 canApply 的语义（它只挡时间窗；动树判定是 canEditTree 的事）',
  );
});

/* ------------------------------------------------------------------ *
 * SYNC-IME-BULK-02 🔴 窗口是**固定长度**：到点必须放行（否则远端永远进不来）
 * ------------------------------------------------------------------ */
test('SYNC-IME-BULK-02 窗口过 BULK_REWRITE_MS 后必须放行', () => {
  let t = 1000;
  const gate = createImeGate(() => t);
  gate.noteBulkEdit();

  // 窗口最后一毫秒：仍须关（右界本身在窗口内）
  t = 1000 + BULK_REWRITE_MS - 1;
  assert.equal(gate.canEditTree(), false, '窗口右界之前必须仍关');

  // 过了右界：必须放行 —— 否则一次大段删除之后远端内容永远回不来（同步变"坏"）
  t = 1000 + BULK_REWRITE_MS + 1;
  assert.equal(gate.bulkActive, false, '过右界后 bulkActive 必须为假');
  assert.equal(gate.canEditTree(), true, '🔴 窗口过期后必须放行（推迟不排队，下轮轮询重试）');
});

/* ------------------------------------------------------------------ *
 * SYNC-IME-BULK-03 🔴 窗口**不滑动**：窗口内继续打字不得续窗
 * ------------------------------------------------------------------ */
test('SYNC-IME-BULK-03 窗口内的普通输入（noteInput）不得延长窗口', () => {
  let t = 1000;
  const gate = createImeGate(() => t);
  gate.noteBulkEdit();

  // 窗口中段用户一直在打字（批次插入正是这种形态）
  t = 1000 + BULK_REWRITE_MS / 2;
  gate.noteInput();
  assert.equal(gate.canEditTree(), false, '窗口中段仍在窗口内，必须关');

  // 🔴 靶心：从**开窗时刻**算起满 6s ⇒ 必须放行。
  //   若实现错成"输入也续窗"（每次 noteInput 刷新 lastBulkEditAt），
  //   这里的 3000ms 前刚输入过 ⇒ 窗口会错误地仍开着 ⇒ 这条红。
  t = 1000 + BULK_REWRITE_MS + 1;
  assert.equal(
    gate.canEditTree(),
    true,
    '🔴 窗口必须从开窗时刻算固定长度：窗口内的打字/批次插入不得续窗，否则豆包连续分批插入期间远端永远进不来',
  );
});

/* ------------------------------------------------------------------ *
 * SYNC-IME-BULK-04 🔴 窗口与组字态正交：compositionend 不清窗，两者叠加恒关
 * ------------------------------------------------------------------ */
test('SYNC-IME-BULK-04 组字期间/结束后 bulk 窗口仍在：canEditTree 两条闸是叠加关系', () => {
  const { host, handlers } = fakeHost();
  let t = 1000;
  const gate = createImeGate(() => t);
  gate.attach(host);

  // 组字中开窗（真实场景：删除与插入都发生在输入法的操作里）
  handlers['compositionstart']();
  gate.noteBulkEdit();
  assert.equal(gate.composing, true, '组字态为真（前置自检）');
  assert.equal(gate.canEditTree(), false, '组字中 + 窗口内必须关');
  assert.equal(gate.canApply(), false, '组字中 canApply 本来就关（不受 bulk 影响）');

  // 组字结束（真实 compositionend，t 仍为 1000）⇒ 把时间推到
  // 「组字冷却与打字活跃期都过期、但 bulk 窗口（1000+6000）未过期」：
  // 这正是豆包"批次间隙"的形态 —— 输入法早就不组字了，可它还在分批插入。
  handlers['compositionend']();
  t = 1000 + COMPOSE_COOLDOWN_MS + TYPE_ACTIVE_MS + 100; // = 5600 < 7000
  assert.equal(gate.canApply(), true, '组字冷却与活跃期全过 ⇒ canApply 放行');
  assert.equal(gate.bulkActive, true, 'compositionend 不得清除 bulk 窗口（删除痕迹仍在窗口内）');
  assert.equal(
    gate.canEditTree(),
    false,
    '🔴 组字结束 ≠ 改写会话结束：bulk 窗口未过期前仍禁止动树（批次间隙正是这种形态）',
  );
});

/* ------------------------------------------------------------------ *
 * SYNC-IME-BULK-05 🔴 正交性收口：开窗不伪造时间窗痕迹，打字不开 bulk 窗
 * ------------------------------------------------------------------ */
test('SYNC-IME-BULK-05 noteBulkEdit 只开自己的窗，noteInput 绝不开 bulk 窗', () => {
  let t = 1000;
  const gate = createImeGate(() => t);
  gate.noteBulkEdit();
  assert.equal(gate.typingActive, false, '开窗不得伪造打字活跃期');
  assert.equal(gate.composeCooling, false, '开窗不得伪造组字冷却');
  assert.equal(gate.composing, false, '开窗不得伪造组字态');

  // 反向：普通打字（noteInput）只续活跃期，绝不开 bulk 窗。
  // 🔴 必须用**新门控**验证 —— 上面那个门控已开窗，6s 内 bulkActive 恒真，
  //   在它上面断言 bulkActive===false 是自欺（我第一版就栽在这：时间线自相矛盾）。
  let t2 = 5000;
  const g2 = createImeGate(() => t2);
  g2.noteInput();
  assert.equal(g2.typingActive, true, 'noteInput 置活跃期（前置自检）');
  assert.equal(g2.bulkActive, false, '🔴 noteInput 不得开 bulk 窗（触发器只有 noteBulkEdit 一条）');
  assert.equal(g2.canApply(), false, '活跃期内 canApply 照旧关（原语义回归检查）');
  assert.equal(g2.canEditTree(), false, '活跃期内 canEditTree 照旧关（经 canApply 叠加）');
});

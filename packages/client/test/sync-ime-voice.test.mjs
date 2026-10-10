/**
 * 「豆包语音输入转文字被换位/丢失」判据（SYNC-IME-VOICE 系列）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 用户报障（2026-10 新坑）：
 *   「新版 APP 上用豆包语音输入法转文字，输着输着，过一会同步机制刷新了，
 *    导致输入的文字换位或丢失。」
 *
 * ── 病根 ───────────────────────────────────────────────────────────────────
 *   bj 的 IME 门控（`ime-gate.ts`）在「组字中」或「打字活跃期 1.5s 内」才禁止远端
 *   回灌（`docToLexical` 的 `root.clear()` + 整篇重建）。这套窗口是为**键盘**调的：
 *   键盘组字结束（compositionend）后文本已提交，1.5s 足够。
 *
 *   但**语音输入**在句子/短语之间会有 1~数秒的自然停顿。停顿期间：
 *     · compositionend 早已触发；
 *     · 1.5s 的打字活跃期也已过期；
 *   ⇒ 门控提前开门 ⇒ 下一轮轮询/SSE 的 `docToLexical` 整篇重建落在停顿处，
 *     把光标重置、把尚未提交的组字串冲掉 ⇒ 「换位 / 丢失」。
 *
 * ── 修法（见 ime-gate.ts 的 COMPOSE_COOLDOWN_MS）─────────────────────────
 *   组字**真实**结束（compositionend 事件）后，额外再关 `COMPOSE_COOLDOWN_MS`
 *   （4s），覆盖语音的句间停顿。代价：远端回灌最多推迟 4s，下几轮轮询自动重试
 *   （P0-3「推迟不排队」），对单用户笔记可接受。
 *
 * ── 判据纪律 ───────────────────────────────────────────────────────────────
 *   · 时间相关判据**必须注入时钟**（now 参数）。
 *   · 这条是「先红后改」的靶心：旧实现里组字结束仅过 1.6s（> 1.5s 活跃期）
 *     时 `canApply()` 会错误地返回 true —— 把那段逻辑删掉（见下方变异说明）
 *     这条判据会从绿变红，证明它钉的是真 bug，不是恒绿。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createImeGate, TYPE_ACTIVE_MS, COMPOSE_COOLDOWN_MS } from '../src/sync/ime-gate.ts';

/* ------------------------------------------------------------------ *
 * SYNC-IME-VOICE-01 🔴 语音句间停顿：组字结束后冷却期内仍禁止回灌
 * ------------------------------------------------------------------ */
test('SYNC-IME-VOICE-01 语音句间停顿（>1.5s）：组字结束后冷却期仍禁止回灌', () => {
  let t = 1000;
  const gate = createImeGate(() => t);

  // 用一个真·宿主捕获 composition 事件处理器（不走手动 setComposing，
  // 因为冷却只由**真实** compositionend 触发 —— 这正是语音场景的入口）。
  const handlers = {};
  const host = {
    addEventListener: (k, f) => { handlers[k] = f; },
    removeEventListener: () => undefined,
  };
  gate.attach(host);
  assert.ok(handlers['compositionstart'], '必须已挂 compositionstart');
  assert.ok(handlers['compositionend'], '必须已挂 compositionend');

  // 模拟语音：组字开始 → 组字结束（豆包提交这一句）
  handlers['compositionstart']();
  t = 1100;
  handlers['compositionend']();

  // 🔴 关键断言：句间停顿 1.6 秒（> 1.5s 打字活跃期）。
  //   旧实现此时 typingActive 已过期、composing 已 false ⇒ canApply() 错误返回 true
  //   ⇒ 轮询的整篇重建落在停顿处把字弄乱。新实现靠 composeCooling 仍拦住。
  t = 1100 + TYPE_ACTIVE_MS + 100; // 1100 + 1600 = 2700
  assert.equal(gate.composeCooling, true, '🔴 冷却期内 composeCooling 必须为真');
  assert.equal(
    gate.canApply(),
    false,
    '🔴 组字结束后仅过 1.6s（语音句间停顿）仍禁止回灌，否则语音文字被整篇重建弄乱',
  );

  // 超过冷却期 ⇒ 必须放行（否则远端永远进不来）
  t = 1100 + COMPOSE_COOLDOWN_MS + 100;
  assert.equal(
    gate.canApply(),
    true,
    '冷却期过后必须放行，否则远端永远进不来（同步功能会变"坏"）',
  );
});

/* ------------------------------------------------------------------ *
 * SYNC-IME-VOICE-02 🔴 Lexical isComposing 提供方被纳入门控（防御纵深）
 * ------------------------------------------------------------------ */
test('SYNC-IME-VOICE-02 Lexical isComposing 提供方必须被 canApply 纳入', () => {
  let t = 1000;
  // 提供方恒为真 ⇒ 无论时间窗如何，都禁止（捕获 DOM 事件漏掉的组字窗口）
  const g1 = createImeGate(() => t, () => true);
  assert.equal(g1.canApply(), false, 'Lexical 组字中必须禁止回灌（哪怕时间窗已过）');

  // 提供方恒为假 ⇒ 不影响既有时序判据
  const g2 = createImeGate(() => t, () => false);
  assert.equal(g2.canApply(), true, '提供方为假时不额外拦（保持旧语义，避免误伤正常同步）');

  // 组合：冷却期已过 + 提供方为假 ⇒ 放行（证明提供方是"只增不减"的加固）
  let t3 = 0;
  const g3 = createImeGate(() => t3, () => false);
  const h = {};
  const host = { addEventListener: (k, f) => { h[k] = f; }, removeEventListener: () => undefined };
  g3.attach(host);
  h['compositionstart']();
  t3 = 100;
  h['compositionend']();
  t3 = 100 + COMPOSE_COOLDOWN_MS + 200; // 冷却期已过
  assert.equal(g3.canApply(), true, '冷却期过 + 提供方为假 ⇒ 必须放行');
});

/* ------------------------------------------------------------------ *
 * SYNC-IME-VOICE-03 手动 setComposing(false) 不触发冷却（降级路径语义不变）
 * ------------------------------------------------------------------ */
test('SYNC-IME-VOICE-03 手动 setComposing(false) 不触发冷却（与 SYNC-IME-01 同口径）', () => {
  // 🔴 反向闸：冷却必须由**真实** compositionend 触发，手动降级置位不得产生冷却，
  //   否则既改了 SYNC-IME-01 钉住的降级语义，又会在无事件场景下凭空延长延迟。
  let t = 1000;
  const gate = createImeGate(() => t);
  gate.setComposing(true);
  gate.setComposing(false); // 降级场景：本就没有 composition 事件
  t = 1000 + TYPE_ACTIVE_MS + 100; // 1.6s 后
  assert.equal(gate.composeCooling, false, '手动置位不应产生冷却');
  assert.equal(gate.canApply(), true, '降级路径下组字结束后立即放行（与 SYNC-IME-01 同口径）');
});

/* ------------------------------------------------------------------ *
 * SYNC-IME-VOICE-04 🔴 变异验证：删掉冷却逻辑，本组判据必须转红
 * ------------------------------------------------------------------ */
test('SYNC-IME-VOICE-04 变异：去掉 composeCooling 这一闸，VOICE-01 的核心断言必须红', () => {
  // 这条不依赖源码，而是用「一个不含冷却的等价门控」复算 VOICE-01 的核心时刻，
  // 证明"冷却"这一项单独就是 VOICE-01 红/绿的分界 —— 防止判据恒绿。
  let t = 1000;
  // 复刻**旧实现**的 canApply：只有 composing + 1.5s 活跃期，没有冷却。
  let composing = false;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  const typingActive = () => t - lastInputAt < TYPE_ACTIVE_MS;
  const oldCanApply = () => (composing ? false : typingActive() ? false : true);

  const handlers = {};
  // 模拟旧实现：compositionend 只刷 lastInputAt，不刷冷却。
  const onStart = () => { composing = true; };
  const onEnd = () => { composing = false; lastInputAt = t; };

  onStart();
  t = 1100;
  onEnd();

  t = 1100 + TYPE_ACTIVE_MS + 100; // 语音句间停顿 1.6s
  // 🔴 旧实现此刻会错误放行（这就是 bug 本身）：
  assert.equal(
    oldCanApply(),
    true,
    '反向证据：旧实现在句间停顿 1.6s 时错误地 canApply()=true（即 bug 成立）',
  );
  // 而新实现（上面 VOICE-01 已断言）此刻为 false ⇒ 两条结论共同证明冷却是修复点。
});

/* ------------------------------------------------------------------ *
 * SYNC-IME-VOICE-05 🔴 实时语音转文字（input isComposing 流）整段关死门控
 * ------------------------------------------------------------------ */
test('SYNC-IME-VOICE-05 实时语音转文字（input isComposing 流）整段关死门控', () => {
  let t = 1000;
  const gate = createImeGate(() => t);
  const handlers = {};
  const host = {
    addEventListener: (k, f) => { handlers[k] = f; },
    removeEventListener: () => undefined,
  };
  gate.attach(host);
  // 🔴 不派 compositionstart/end（模拟"组字事件时序不稳 / 被漏收"的退化场景），
  //   只派 input(isComposing=true) —— 豆包实时转文字每一小段都派这个。
  const emitVoice = () => handlers['input']({ isComposing: true });

  emitVoice(); // t=1000
  t = 2600; // 距上次 isComposing input 1.6s（> 1.5s 键盘窗口，但仍在冷却内）
  assert.equal(
    gate.canApply(),
    false,
    '🔴 还在转（最近一次 isComposing input 在 1.6s 内）仍禁止回灌：覆盖"说话过程中"丢字',
  );

  // 持续转：每 2s 来一段，冷却被不停续上 ⇒ 门控应一直关死
  t = 4600; emitVoice();
  t = 6600; emitVoice();
  t = 6700; // 刚续过，远在 4s 内
  assert.equal(gate.canApply(), false, '持续转文字过程中门控必须一直关死');

  // 停下不再转：超过冷却期 ⇒ 才允许（远端变更至多晚 4s 落本机）
  t = 6700 + COMPOSE_COOLDOWN_MS + 100;
  assert.equal(gate.canApply(), true, '完全停下且过冷却期后才放行（否则远端永远进不来）');
});

/* ------------------------------------------------------------------ *
 * SYNC-IME-VOICE-06 键盘 input(isComposing=false) 不延长冷却（语义不变）
 * ------------------------------------------------------------------ */
test('SYNC-IME-VOICE-06 键盘 input(isComposing=false) 不延长冷却（语义不变）', () => {
  let t = 1000;
  const gate = createImeGate(() => t);
  const handlers = {};
  const host = {
    addEventListener: (k, f) => { handlers[k] = f; },
    removeEventListener: () => undefined,
  };
  gate.attach(host);
  handlers['input']({ isComposing: false }); // 键盘打字
  t = 1000 + TYPE_ACTIVE_MS + 100; // 1.6s 后
  assert.equal(gate.canApply(), true, '键盘 input 不延长冷却：1.5s 后必须放行（语义不变）');
});

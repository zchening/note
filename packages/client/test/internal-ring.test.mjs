/**
 * P1-8 内部错误环形缓冲判据
 *
 * 🔴🔴 纪律：
 *   · **import 生产代码**，不把实现抄进测试（`INTERNAL_RING_MAX` 也是从生产模块取，
 *     测试里不许再写一个 100 —— 那样改了容量测试还绿，等于没钉）；
 *   · 每条"应该有"配一条"不应该有"；
 *   · 变异验证：把生产的容量闸改成无界 ⇒ RING-01/02/04 必须转红（见文件尾注释）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERNAL_RING_MAX,
  clearInternalErrors,
  internalErrorCount,
  listInternalErrors,
  pushInternalError,
  snapshotInternalErrorsText,
} from '../src/diag/internal-ring.ts';

/** 每个用例都从空环开始：环是模块级单值，用例之间会互相污染。 */
function fresh() {
  clearInternalErrors();
}

/** 连推 n 条，msg 依次是 `E0..E{n-1}`。 */
function pushN(n, prefix = 'E') {
  for (let i = 0; i < n; i += 1) pushInternalError({ msg: `${prefix}${i}` });
}

// ═══════════════════════════════════════════════════════════════════════════
// 容量（P1-8 的核心：环必须有上界）
// ═══════════════════════════════════════════════════════════════════════════

test('RING-01 🔴 推超过容量 N 条 ⇒ 长度**恰好**等于 N（应该有上界）', () => {
  fresh();
  pushN(INTERNAL_RING_MAX + 137);
  assert.equal(internalErrorCount(), INTERNAL_RING_MAX, '环长度必须恰好等于容量');
  assert.equal(listInternalErrors().length, INTERNAL_RING_MAX);
  // 🔴 再推更多，长度不许再涨（无界数组的症状就是"越推越长"）
  pushN(50, 'F');
  assert.equal(internalErrorCount(), INTERNAL_RING_MAX, '继续推也不许超过容量');
});

test('RING-02 🔴 保留的是**最近** N 条，最旧的被丢（应该/不应该成对）', () => {
  fresh();
  const total = INTERNAL_RING_MAX + 40;
  pushN(total);
  const list = listInternalErrors();
  // 应该有：最后一条是刚推的那条
  assert.equal(list[list.length - 1]?.msg, `E${total - 1}`, '最后一条必须是最近推的');
  // 应该有：第一条是"第 total-N 条"（前面 total-N 条已被挤掉）
  assert.equal(list[0]?.msg, `E${total - INTERNAL_RING_MAX}`, '最旧保留的那条必须正好是第 total-N 条');
  // 🔴 不应该有：被挤掉的最旧一条（E0）绝不在环里
  assert.equal(
    list.some((r) => r.msg === 'E0'),
    false,
    'E0 已被挤掉，不该还在环里（还在 = 没丢最旧）',
  );
  assert.equal(
    list.some((r) => r.msg === `E${total - INTERNAL_RING_MAX - 1}`),
    false,
    '最后被挤掉的那条也不该在环里',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// clear / snapshot
// ═══════════════════════════════════════════════════════════════════════════

test('RING-03 clear() 后为 0（应该有），且 snapshot 明确说"空"（不是空串）', () => {
  fresh();
  pushN(5);
  assert.equal(internalErrorCount(), 5);
  clearInternalErrors();
  assert.equal(internalErrorCount(), 0, 'clear 后必须是 0');
  assert.equal(listInternalErrors().length, 0);
  const txt = snapshotInternalErrorsText();
  assert.ok(txt.length > 0, '空环的 snapshot 不许是空串（会被当成复制失败）');
  assert.match(txt, /空/, `空环的 snapshot 应说明是空的：${txt}`);
});

test('RING-04 🔴 snapshotText 含最近那条的关键字（应该有）且不含被挤掉那条（不应该有）', () => {
  fresh();
  pushN(INTERNAL_RING_MAX + 10);
  pushInternalError({ msg: 'BOOM-LAST-MARKER', state: 'pushing', event: 'remote-arrived' });
  const txt = snapshotInternalErrorsText();
  // 应该有
  assert.ok(txt.includes('BOOM-LAST-MARKER'), `snapshot 应含最近那条：${txt}`);
  assert.ok(txt.includes('state=pushing'), `snapshot 应带 state：${txt}`);
  assert.ok(txt.includes('event=remote-arrived'), `snapshot 应带 event：${txt}`);
  // 🔴 不应该有：被挤掉的 E0 / E9 绝不在快照里。
  //   用行尾锚定而不是 includes：`msg=E9` 是 `msg=E90` 的子串，includes 会假红。
  assert.ok(!/msg=E0$/m.test(txt), `snapshot 不该含被挤掉的 E0：${txt}`);
  assert.ok(!/msg=E9$/m.test(txt), `snapshot 不该含被挤掉的 E9：${txt}`);
  // 每行一条：行数 = 1 行头 + N 条
  assert.equal(txt.split('\n').length, INTERNAL_RING_MAX + 1, 'snapshot 应是 1 行头 + N 条');
});

// ═══════════════════════════════════════════════════════════════════════════
// 可选字段（exactOptionalPropertyTypes 纪律）
// ═══════════════════════════════════════════════════════════════════════════

test('RING-05 🔴 没给的字段**不该出现这个键**（不应该有），给了的必须有（应该有）', () => {
  fresh();
  pushInternalError({ msg: '只有一句话' });
  const bare = listInternalErrors()[0];
  assert.ok(bare);
  assert.equal(bare.msg, '只有一句话');
  // 🔴 不应该有：可选字段必须"键不存在"，而不是值为 undefined
  assert.equal('state' in bare, false, '没给 state 就不该有这个键');
  assert.equal('event' in bare, false, '没给 event 就不该有这个键');
  assert.equal('err' in bare, false, '没给 err 就不该有这个键');
  // 应该有：给了的必须落进来
  pushInternalError({ msg: '齐全', state: 'idle', event: 'tick', err: new TypeError('坏了') });
  const full = listInternalErrors()[1];
  assert.ok(full);
  assert.equal(full.state, 'idle');
  assert.equal(full.event, 'tick');
  assert.ok(full.err?.includes('TypeError'), `err 应含 name：${String(full.err)}`);
  assert.ok(full.err?.includes('坏了'), `err 应含 message：${String(full.err)}`);
});

test('RING-06 🔴 错误对象只取 name/message —— stack **绝不**进记录（不应该有）', () => {
  fresh();
  // 函数名是本用例的独有标记：它只可能出现在 stack 里
  const err = (function ringProbeStackMarkerFn() {
    return new Error('栈里才有我');
  })();
  assert.ok((err.stack ?? '').includes('ringProbeStackMarkerFn'), '前提：这个函数名确实在 stack 里');
  pushInternalError({ msg: '带错误对象', err });
  const txt = snapshotInternalErrorsText();
  assert.ok(txt.includes('栈里才有我'), 'message 应在');
  assert.ok(
    !txt.includes('ringProbeStackMarkerFn'),
    `stack 里的函数名不该进记录（只存 name:message）：${txt}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 健壮性 / 上界
// ═══════════════════════════════════════════════════════════════════════════

test('RING-07 🔴 push 绝不抛（调用方就是 catch 块里的人）', () => {
  fresh();
  const circular = { name: '环引用' };
  circular.self = circular; // JSON.stringify 会抛
  assert.throws(() => JSON.stringify(circular), '前提：这个对象确实 stringify 不了');
  // 应该有：这些奇形怪状的入参都不许把 push 打炸，且记录照样落进来
  pushInternalError({ msg: '怪入参', err: circular });
  pushInternalError({ msg: '', err: null });
  pushInternalError({ msg: '纯字符串 err', err: '直接是字符串' });
  pushInternalError({ msg: '数字 err', err: 42 });
  assert.equal(internalErrorCount(), 4, '四条都该落进来（push 不许静默吞掉记录）');
});

test('RING-08 list() 返回副本（应该有），改它不影响环、环转也不改它（不应该有）', () => {
  fresh();
  pushInternalError({ msg: 'A' });
  const snap = listInternalErrors();
  assert.equal(snap.length, 1);
  snap.length = 0; // 改副本
  assert.equal(internalErrorCount(), 1, '改返回值不该影响环内');
  pushInternalError({ msg: 'B' });
  assert.equal(snap.length, 0, '🔴 环继续转不该让旧数组变长（说明交出的是内部数组）');
  assert.equal(internalErrorCount(), 2);
});

test('RING-09 🔴 单条长度有上界（否则"固定 100 条"只管条数不管字节）', () => {
  fresh();
  pushInternalError({ msg: 'x'.repeat(50_000) });
  const rec = listInternalErrors()[0];
  assert.ok(rec);
  assert.ok(rec.msg.length <= 201, `单条 msg 必须有长度上界，实得 ${rec.msg.length}`);
  // 🔴 换行必须被压平（一行一条是"可复制"的前提）
  pushInternalError({ msg: '前\n后\r\n再\t后' });
  assert.equal(listInternalErrors()[1]?.msg.includes('\n'), false, 'msg 里不许留换行');
});

/* ──────────────────────────────────────────────────────────────────────────
 * 变异验证记录（本次实跑）
 *   把 internal-ring.ts 的容量闸 `if (ring.length > INTERNAL_RING_MAX)` 临时
 *   改成 `if (false)`（= 无界数组）⇒ RING-01 / RING-02 / RING-04 三条**全部转红**
 *   （长度变成 137+，list[0].msg 是 E0，snapshot 行数暴涨）。恢复后转绿。
 * ────────────────────────────────────────────────────────────────────────── */

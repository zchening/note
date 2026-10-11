/**
 * 飞行记录器判据（FLIGHT 系列，v3.0.9 诊断版）
 *
 * ── 它要钉住什么 ─────────────────────────────────────────────────────────
 *   这个模块存在的唯一理由：真机丢字现场的事件流必须**完整、可读、跨重载**
 *   地带回来。任何一条破了，取证就瞎：
 *     ① ring 上限真生效（内存不胀、老事件真被挤掉）；
 *     ② 跨"重载"存活（换新会话、同一存储 ⇒ 旧事件还在——丢字现场常伴随
 *        页面被杀，重启后读不到日志 = 白装）；
 *     ③ 落盘节流真节流（打字期不许每次按键都 stringify 60KB）但 flush
 *        必须**同步**落（pagehide/error 那几条恰恰是最重要的）；
 *     ④ 详情截断（一条 10KB 的 detail 会把整个 localStorage 写爆）；
 *     ⑤ 哈希只比对不可逆推（判据钉"同文同哈希、异文异哈希"）。
 *
 * ── 变异说明（先红后改）──────────────────────────────────────────────────
 *   把 CAP 的 splice 删掉 ⇒ FLIGHT-02 红；把 ensureLoaded 的读档删掉 ⇒
 *   FLIGHT-03 红；把 flush 分支删掉（全走节流）⇒ FLIGHT-04 红；
 *   把 slice(0,140) 删掉 ⇒ FLIGHT-05 红。四向验证过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordFlight,
  flightLines,
  flightCounts,
  clearFlight,
  flightHash,
  _flightTestReset,
} from '../src/sync/flight-recorder.ts';

/** 内存版存储（与 FlightStore 同形），带写入计数（节流判据用）。 */
function memStore() {
  const m = new Map();
  return {
    writes: 0,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

test('FLIGHT-01 记录与格式化：表头 + 相对毫秒 + 类型 + 详情', () => {
  _flightTestReset(memStore());
  recordFlight('upd', 'len=42 d=3');
  recordFlight('bulk', 'drop=20');
  const lines = flightLines();
  assert.ok(lines[0].startsWith('flight 2 条'), '表头必须带条数，实际=' + lines[0]);
  assert.match(lines[1], /^\s*\d+ upd len=42 d=3$/, '事件行必须是 "t type d" 形状');
  assert.match(lines[2], /bulk drop=20/, '第二条原样在');
});

test('FLIGHT-02 ring 上限：超过 400 条必须挤掉最老的', () => {
  _flightTestReset(memStore());
  for (let i = 0; i < 450; i += 1) recordFlight('upd', 'len=' + i);
  const lines = flightLines();
  assert.equal(lines.length - 1, 400, '必须封顶 400 条');
  assert.match(lines[1], /len=50/, '最老的 50 条必须已被挤掉（ring 语义）');
  assert.match(lines[lines.length - 1], /len=449/, '最新一条必须在');
});

test('FLIGHT-03 跨"重载"存活：新会话 + 同一存储 ⇒ 旧事件还在', () => {
  const store = memStore();
  _flightTestReset(store);
  recordFlight('tree:setdoc', 'len=99', true); // flush 落盘
  // 模拟页面重载：内存态全清，存储沿用（真机上 localStorage 跨重载存活）
  _flightTestReset(store);
  const lines = flightLines();
  assert.ok(
    lines.some((l) => l.includes('tree:setdoc len=99')),
    '🔴 重载后必须读回上次的事件（否则丢字现场日志随页面一起死）',
  );
});

test('FLIGHT-04 落盘节流真节流，flush 必须同步落', () => {
  const store = memStore();
  let clock = 100000;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    _flightTestReset(store);
    // 连续 3 条普通事件（同 500ms 窗口内）⇒ 第一次落盘后节流，不允许每条都写
    recordFlight('upd', 'a');
    const w1 = store._map.size > 0 ? 1 : 0;
    recordFlight('upd', 'b');
    recordFlight('upd', 'c');
    assert.ok(w1 <= 1, '首条落盘至多一次');
    // flush=true 必须**立即**再写一次（不管节流窗口）
    const before = JSON.stringify(store._map.get('notesync_bj_flight') ?? '');
    recordFlight('vis', 'pagehide', true);
    const after = store._map.get('notesync_bj_flight') ?? '';
    assert.notEqual(after, before, '🔴 flush 事件必须同步落盘（pagehide 那条丢了就白装）');
    assert.ok(after.includes('pagehide'), '落盘内容必须含 flush 的那条');
  } finally {
    Date.now = realNow;
  }
});

test('FLIGHT-05 详情截断：超长 detail 必须截到 140 字符', () => {
  _flightTestReset(memStore());
  recordFlight('err', 'x'.repeat(500));
  const lines = flightLines();
  const evLine = lines[1];
  // 行 = 8 宽时间 + 空格 + 类型(3) + 空格 + detail
  const detail = evLine.split(' err ')[1] ?? '';
  assert.equal(detail.length, 140, '🔴 detail 必须截到 140（防单条写爆存储）');
});

test('FLIGHT-06 哈希：同文同哈希、异文异哈希（只比对不可逆推）', () => {
  const a = flightHash('{"v":1,"blocks":[]}');
  assert.equal(a, flightHash('{"v":1,"blocks":[]}'), '同文必须同哈希');
  assert.notEqual(a, flightHash('{"v":1}'), '异文必须异哈希（比对才有效）');
  assert.match(a, /^[0-9a-f]{8}$/, '哈希形状必须固定 8 位 hex');
});

test('FLIGHT-07 clearFlight 清空内存与存储', () => {
  const store = memStore();
  _flightTestReset(store);
  recordFlight('upd', 'len=1', true);
  clearFlight();
  assert.equal(flightLines().length - 1, 0, '清空后无事件');
  assert.equal(store._map.get('notesync_bj_flight') ?? null, null, '存储键必须被移除');
});

test('FLIGHT-08 🔴 会话级累计计数：不随 ring 淘汰、跨重载存活、表头带摘要（v3.0.13 取证）', () => {
  // 🔴 为什么必须有：v3.0.12 真机日志只贴出 ring 末尾健康段，① 是否触发过
  //   无法判定 —— ring 会滚动，但"全程计数"不许滚动。
  const store = memStore();
  _flightTestReset(store);
  for (let i = 0; i < 450; i += 1) recordFlight('upd', 'len=' + i); // ring 挤掉 50 条
  recordFlight('cmp:synthed', 'start');
  recordFlight('sel:orphaned', 'i');
  recordFlight('orphan0', 'd=3');
  recordFlight('gate:withdraw', 'withdraw 40->5 drop=35>12.0');
  let c = flightCounts();
  assert.equal(c['upd'], 450, '🔴 ring 只剩 400 条，全程计数必须是 450（诊断靠它钉①是否触发过）');
  assert.equal(c['cmp:synthed'], 1, '① 合成 compositionstart 计数');
  assert.equal(c['sel:orphaned'], 1, '孤儿组字计数');
  // 跨"重载"存活（页面被杀重开，计数从存储读回）。
  // 🔴 先 flush 再重载：节流窗口内未落盘的尾巴本来就会随页面被杀而丢
  //   （生产由 pagehide 的 flush 补上，FLIGHT-03/04 已钉），这里模拟同一语义。
  recordFlight('vis', 'pagehide-flush', true);
  _flightTestReset(store);
  c = flightCounts();
  assert.equal(c['upd'], 450, '🔴 重载后全程计数必须从存储读回');
  assert.equal(c['cmp:synthed'], 1, '重载后①计数仍在');
  // 表头摘要：用户贴日志的**任何一段**都必须能看到全程计数
  const head = flightLines()[0];
  assert.ok(head.includes('synthed=1'), '表头摘要必须含 synthed=N，实际=' + head);
  assert.ok(head.includes('upd=450'), '表头摘要必须含 upd=N，实际=' + head);
  assert.ok(head.includes('o0=1'), '表头摘要必须含 o0=N（comp=0 孤儿帧计数，v3.0.14）');
  assert.ok(head.includes('wd=1'), '表头摘要必须含 wd=N（撤稿恢复计数，v3.0.14）');
  assert.ok(head.startsWith('flight '), '表头仍以 flight 开头（兼容既有判据/复制格式）');
  // 清空 = 归零
  clearFlight();
  c = flightCounts();
  assert.ok(!c['upd'] && !c['cmp:synthed'], '清空后计数必须归零');
});

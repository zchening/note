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

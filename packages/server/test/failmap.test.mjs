/**
 * failMap 持久化测试
 *
 * 这一层是本次重构相对老项目的实质改进（老项目纯内存，重启清零），
 * 所以必须有测试证明"重启后锁还在"，否则改了跟没改一样。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FAIL_LIMIT,
  LOCK_DURATION,
  FAIL_WINDOW,
  loadSnapshot,
  saveSnapshot,
  recordFail,
  recordOk,
  checkLimit,
  sweep,
  dumpAll,
  size,
} from '../src/failmap.js';

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-failmap-'));
  return path.join(d, 'failmap.json');
}

/** 每个用例独立文件 + 独立模块实例（node:test 里用 query 串做 import 变体） */
async function fresh(file) {
  return import(`../src/failmap.js?v=${encodeURIComponent(file)}`);
}

test('落盘：失败记录能写到文件并读回', async () => {
  const f = tmpFile();
  const m = await fresh(f);
  m.loadSnapshot(f);
  const key = '1.2.3.4:note1';
  m.recordFail(key);
  m.recordFail(key);
  assert.equal(m.checkLimit(key).locked, false, '两次不该锁');
  assert.ok(m.saveSnapshot(), '落盘应成功');
  assert.ok(fs.existsSync(f), '快照文件应存在');

  const m2 = await fresh(f + '2');
  const n = m2.loadSnapshot(f);
  assert.equal(n, 1, '应恢复 1 条');
  assert.equal(m2.checkLimit(key).locked, false);
  assert.equal(m2.dumpAll()[key].count, 2, '计数应恢复');
});

test('落盘：达到阈值后锁定，重启后锁仍在（老项目这里是丢的）', async () => {
  const f = tmpFile();
  const m = await fresh(f);
  m.loadSnapshot(f);
  const key = '9.9.9.9:noteX';
  for (let i = 0; i < FAIL_LIMIT; i++) m.recordFail(key);
  const st = m.checkLimit(key);
  assert.equal(st.locked, true, '达阈值必须锁');
  assert.ok(st.retryAfter > 0 && st.retryAfter <= LOCK_DURATION / 1000);
  m.saveSnapshot();

  // 模拟进程重启：全新模块实例读回
  const m2 = await fresh(f + '2');
  m2.loadSnapshot(f);
  const st2 = m2.checkLimit(key);
  assert.equal(st2.locked, true, '🔴 重启后锁丢了 —— 这正是老项目的薄弱点');
  assert.ok(st2.retryAfter > 0);
});

test('落盘：快照损坏时按空表继续，不崩服务', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ 这不是 JSON', 'utf8');
  const m = await fresh(f);
  const n = m.loadSnapshot(f);
  assert.equal(n, 0, '损坏快照应恢复 0 条');
  assert.equal(m.size(), 0);
  // 仍能正常工作
  m.recordFail('a:b');
  assert.equal(m.size(), 1);
});

test('落盘：快照里已过期的记录不恢复（否则文件只增不减）', async () => {
  const f = tmpFile();
  const old = Date.now() - LOCK_DURATION - 1000;
  const stale = Date.now() - FAIL_WINDOW - 1000;
  fs.writeFileSync(
    f,
    JSON.stringify({
      'ip:locked': { count: 99, firstFail: old, lockedAt: old },
      'ip:window': { count: 3, firstFail: stale, lockedAt: null },
      'ip:live': { count: 2, firstFail: Date.now(), lockedAt: null },
    }),
    'utf8',
  );
  const m = await fresh(f);
  const n = m.loadSnapshot(f);
  assert.equal(n, 1, '只应恢复未过期的那条');
  const all = m.dumpAll();
  assert.ok(all['ip:live']);
  assert.ok(!all['ip:locked']);
  assert.ok(!all['ip:window']);
});

test('落盘：字段类型不对的条目被跳过，不污染内存表', async () => {
  const f = tmpFile();
  fs.writeFileSync(
    f,
    JSON.stringify({
      good: { count: 1, firstFail: Date.now(), lockedAt: null },
      bad1: { count: 'x', firstFail: Date.now() },
      bad2: null,
      bad3: 42,
    }),
    'utf8',
  );
  const m = await fresh(f);
  assert.equal(m.loadSnapshot(f), 1);
  assert.ok(m.dumpAll().good);
});

test('窗口过期后计数重置（连续爆破不该无限累积）', async () => {
  const f = tmpFile();
  const m = await fresh(f);
  m.loadSnapshot(f);
  const key = '5.5.5.5:n';
  const t0 = Date.now();
  // 第一次在窗口内
  m.recordFail(key, t0);
  m.recordFail(key, t0 + 1000);
  assert.equal(m.dumpAll()[key].count, 2);
  // 窗口外再来一次 → 计数从头开始
  m.recordFail(key, t0 + FAIL_WINDOW + 2000);
  assert.equal(m.dumpAll()[key].count, 1, '窗口外应重置计数');
});

test('recordOk 清零（登录成功后不再累计）', async () => {
  const f = tmpFile();
  const m = await fresh(f);
  m.loadSnapshot(f);
  const key = '6.6.6.6:n';
  m.recordFail(key);
  m.recordFail(key);
  assert.equal(m.size(), 1);
  m.recordOk(key);
  assert.equal(m.size(), 0, '成功一次应清掉');
});

test('已锁定的 key 重复上报失败不重复计数（否则一次锁定后疯狂累加）', async () => {
  const f = tmpFile();
  const m = await fresh(f);
  m.loadSnapshot(f);
  const key = '7.7.7.7:n';
  for (let i = 0; i < FAIL_LIMIT + 10; i++) m.recordFail(key);
  assert.equal(m.checkLimit(key).locked, true);
  assert.equal(m.dumpAll()[key].count, FAIL_LIMIT, '锁定后不应继续累加');
});

test('sweep 清掉过期记录', async () => {
  const f = tmpFile();
  const m = await fresh(f);
  m.loadSnapshot(f);
  const key = '8.8.8.8:n';
  m.recordFail(key, Date.now() - FAIL_WINDOW - 5000);
  m.sweep();
  assert.equal(m.size(), 0);
});

test('落盘失败不抛错（限流是防护层，不能把主服务带崩）', async () => {
  const f = path.join(os.tmpdir(), 'bj-nonexistent-dir-xyz', 'sub', 'failmap.json');
  const m = await fresh(f);
  m.loadSnapshot(f);
  m.recordFail('x:y');
  // 目录不存在时 mkdir 递归会创建 —— 所以这里换个思路：把路径设成不可写的
  const bad = path.join(f, 'failmap.json'); // 用文件当目录
  const m2 = await fresh(bad);
  m2.loadSnapshot(bad);
  m2.recordFail('x:y');
  const ok = m2.saveSnapshot();
  assert.equal(typeof ok, 'boolean', 'saveSnapshot 必须返回布尔而不是抛异常');
});

test('快照里 lockedAt 为 null 的记录不视为已锁', async () => {
  const f = tmpFile();
  fs.writeFileSync(
    f,
    JSON.stringify({ k: { count: 5, firstFail: Date.now(), lockedAt: null } }),
    'utf8',
  );
  const m = await fresh(f);
  m.loadSnapshot(f);
  assert.equal(m.checkLimit('k').locked, false);
  assert.equal(m.dumpAll()['k'].lockedAt, null);
});

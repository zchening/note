/**
 * P1-3 自动快照节流器判据 —— **必须按 noteId 分桶，且桶数有上界**
 *
 * 🔴🔴 纪律：
 *   · import 生产代码（`autoSnapshotThrottled` / `MAX_TRACKED_NOTES` 都从生产模块取）；
 *   · 每条"应该有"配一条"不应该有"；
 *   · 🔴 **先红后改**：HT-02 在改成 Map 之前必须是红的（单值把 B 的快照吞掉），
 *     它是这条 bug 的本体判据；HT-01 是它的对照组（证明节流**仍然**生效，
 *     不是"干脆不节流了"）。
 *   · 变异验证：把生产的 `const key = …` 临时改成恒为 LEGACY_KEY（= 退回单值）
 *     ⇒ HT-02 / HT-05 转红（见文件尾注释）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installBrowserShims } from './dom-shims.mjs';
installBrowserShims();

const {
  MAX_TRACKED_NOTES,
  _autoSnapshotBucketCount,
  _resetAutoSnapshot,
  autoSnapshotThrottled,
  pruneAutoSnapshot,
} = await import('../src/sync/history.ts');

/** 节流窗（60s）取自生产常量：测试里不许再写一个 60_000。 */
const T0 = 1_700_000_000_000;

function fresh() {
  _resetAutoSnapshot();
}

// ═══════════════════════════════════════════════════════════════════════════
// 节流本身仍然生效（"应该有"的对照组）
// ═══════════════════════════════════════════════════════════════════════════

test('HT-01 🔴 同一 noteId 在节流窗内重复 ⇒ 仍被吞（不应该有）', () => {
  fresh();
  assert.equal(autoSnapshotThrottled(T0, 'note-A'), true, '第一次该存');
  // 窗内（差 1 秒 / 差 59 秒）都不该再存
  assert.equal(autoSnapshotThrottled(T0 + 1_000, 'note-A'), false, '窗内第二次必须被吞');
  assert.equal(autoSnapshotThrottled(T0 + 59_000, 'note-A'), false, '窗内第 59 秒仍被吞');
  // 🔴 应该有：出窗之后又能存（否则就是"永久不再存"了）
  assert.equal(autoSnapshotThrottled(T0 + 60_000, 'note-A'), true, '出窗后该存');
});

// ═══════════════════════════════════════════════════════════════════════════
// 本体 bug：跨笔记互相吞
// ═══════════════════════════════════════════════════════════════════════════

test('HT-02 🔴🔴 切到新 noteId 后**立即**自动快照 ⇒ 应该存（本体 bug）', () => {
  fresh();
  // A 笔记刚自动存了一版
  assert.equal(autoSnapshotThrottled(T0, 'note-A'), true);
  // 🔴 60 秒内切到 B 编辑：B 的自动快照**不该**被 A 的时间戳吞掉
  assert.equal(
    autoSnapshotThrottled(T0 + 5_000, 'note-B'),
    true,
    '换笔记后必须能立刻存（单值节流器在这里返回 false = B 收不到任何自动版本）',
  );
  // 再来一篇 C 也一样
  assert.equal(autoSnapshotThrottled(T0 + 9_000, 'note-C'), true, 'C 同样不该被吞');
  // 🔴 但 A 自己的窗还没过，A 仍要被吞（分桶 ≠ 不节流）
  assert.equal(autoSnapshotThrottled(T0 + 10_000, 'note-A'), false, 'A 自己窗内仍该被吞');
});

test('HT-03 反向证据：单值语义在同样输入下**确实**吞掉 B（证明 HT-02 不是恒真）', () => {
  // 复刻改之前的模块级单值实现。**不 import 任何生产代码**，纯对照组：
  // 它证明 HT-02 断言的 true 是"分桶"挣来的，而不是"随便实现都返回 true"。
  let lastAutoSnap = 0;
  const singleValue = (now) => {
    if (now - lastAutoSnap < 60_000) return false;
    lastAutoSnap = now;
    return true;
  };
  assert.equal(singleValue(T0), true);
  assert.equal(singleValue(T0 + 5_000), false, '🔴 老实现在这里吞掉 B —— 这正是那个 bug');
  // 同一个时刻，生产实现必须放行
  fresh();
  assert.equal(autoSnapshotThrottled(T0, 'note-A'), true);
  assert.equal(autoSnapshotThrottled(T0 + 5_000, 'note-B'), true, '生产实现必须放行 B');
});

test('HT-04 三篇笔记各自的窗互不干扰（应该有 / 不应该有交错）', () => {
  fresh();
  const ids = ['n1', 'n2', 'n3'];
  for (const id of ids) assert.equal(autoSnapshotThrottled(T0, id), true, `${id} 首次该存`);
  // 窗内三篇**全都被吞**（分桶只解决"跨笔记"，不解决"同一篇连续存"）
  for (const id of ids) {
    assert.equal(autoSnapshotThrottled(T0 + 30_000, id), false, `${id} 窗内不该存`);
  }
  // 出窗后三篇**全都**能存
  for (const id of ids) {
    assert.equal(autoSnapshotThrottled(T0 + 61_000, id), true, `${id} 出窗后该存`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 内存上界（分桶带来的新风险：Map 随笔记数无界增长）
// ═══════════════════════════════════════════════════════════════════════════

test('HT-05 🔴 长期切换 N+ 篇笔记后桶数有上界（应该有），且刚用过的没被裁掉（不应该被裁）', () => {
  fresh();
  const extra = 137;
  let t = T0;
  const ids = [];
  for (let i = 0; i < MAX_TRACKED_NOTES + extra; i += 1) {
    const id = `note-${i}`;
    ids.push(id);
    // 每篇都间隔足够久，确保每篇都真的存了一版（不是在测节流）
    t += 60_000;
    assert.equal(autoSnapshotThrottled(t, id), true, `${id} 首次该存`);
  }
  // 应该有：桶数被压在上限内（无界 Map 会一直涨到 337）
  assert.ok(
    _autoSnapshotBucketCount() <= MAX_TRACKED_NOTES,
    `桶数必须有上界：实得 ${_autoSnapshotBucketCount()} > ${MAX_TRACKED_NOTES}`,
  );
  assert.equal(_autoSnapshotBucketCount(), MAX_TRACKED_NOTES, '裁完应正好等于上限');
  // 🔴 不应该有：最近用过的那篇**不该**被裁掉（裁掉了 = 丢错了桶 = 节流被重置）
  const newest = ids[ids.length - 1];
  assert.ok(newest);
  assert.equal(
    autoSnapshotThrottled(t + 1_000, newest),
    false,
    `刚存过的 ${newest} 必须还在桶里（还在 = 窗内被吞；被裁掉了就会返回 true）`,
  );
  // 🔴 最旧那篇被裁掉了：它现在能立刻存（这是丢桶唯一可接受的代价）
  const oldest = ids[0];
  assert.ok(oldest);
  assert.equal(autoSnapshotThrottled(t + 2_000, oldest), true, '最旧的桶已被裁，可以立刻存');
});

test('HT-06 pruneAutoSnapshot 能显式收口（应该有），且不被上界卡住（不应该有残留）', () => {
  fresh();
  let t = T0;
  for (let i = 0; i < 30; i += 1) {
    t += 60_000;
    autoSnapshotThrottled(t, `p-${i}`);
  }
  assert.equal(_autoSnapshotBucketCount(), 30);
  const dropped = pruneAutoSnapshot(5);
  assert.equal(dropped, 25, '应丢 25 个桶');
  assert.equal(_autoSnapshotBucketCount(), 5, '裁到 5（应该有）');
  pruneAutoSnapshot(0);
  assert.equal(_autoSnapshotBucketCount(), 0, 'prune(0) 应清空（不该有残留）');
  // 复位后又能存
  assert.equal(autoSnapshotThrottled(T0, 'p-0'), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 向后兼容：老调用方式（不传 noteId）必须还能工作
// ═══════════════════════════════════════════════════════════════════════════

test('HT-07 🔴 老调用方式 autoSnapshotThrottled(now) 仍工作，且走独立的一桶', () => {
  fresh();
  assert.equal(autoSnapshotThrottled(T0), true, '老调用方式首次该存');
  assert.equal(autoSnapshotThrottled(T0 + 1_000), false, '老调用方式窗内仍被吞');
  // 🔴 传了 noteId 之后，老调用方式**不受**那一桶影响（否则换笔记就串了）
  assert.equal(autoSnapshotThrottled(T0 + 2_000, 'note-X'), true, 'note-X 首次该存');
  assert.equal(autoSnapshotThrottled(T0 + 3_000), false, '老桶自己的窗还没过，仍被吞（不该被 note-X 重置）');
  assert.equal(autoSnapshotThrottled(T0 + 60_000), true, '老桶出窗后该存');
});

test('HT-08 _resetAutoSnapshot 后一切归零（应该有）', () => {
  fresh();
  autoSnapshotThrottled(T0, 'r1');
  autoSnapshotThrottled(T0 + 60_000, 'r2');
  assert.equal(_autoSnapshotBucketCount(), 2);
  _resetAutoSnapshot();
  assert.equal(_autoSnapshotBucketCount(), 0, '复位后必须是 0');
  assert.equal(autoSnapshotThrottled(T0, 'r1'), true, '复位后 r1 又能立刻存');
});

/* ──────────────────────────────────────────────────────────────────────────
 * 变异验证记录（本次实跑）
 *   把 history.ts 的 `const key = noteId === undefined … ? LEGACY_KEY : noteId;`
 *   临时改成 `const key = LEGACY_KEY;`（= 退回模块级单值）
 *     ⇒ HT-02（B 被吞）/ HT-04（n2、n3 被吞）/ HT-05（桶数恒为 1，
 *       断言"正好等于上限"转红）**全部转红**；恢复后转绿。
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * e2e：v3.0.14 组字会话水位线（撤稿吞字守卫）
 *
 * 🔴🔴🔴 为什么必须是 e2e：撤稿恢复走「update 监听判定 → 回写真源 → 重建树」
 *   全链路，任何一环（composing 口径、守卫状态、docToLexical、对账 return）
 *   断了都是静默假绿。桌面无豆包，用钩子模拟真机 v3.0.13 日志钉死的形状：
 *   组字增长帧（comp=1 全量串替换）×N → 撤稿帧（comp=0 整串被啃短）。
 *
 * 钉用户可见结果：撤稿后真源必须回到**会话峰值**（口述内容不丢），
 *   且飞行日志留 gate:withdraw 痕迹。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

const textLen = (page) =>
  page.evaluate(() => {
    const d = window.__NOTESYNC_DOC__();
    let n = 0;
    const walk = (bs) => {
      for (const b of bs ?? []) {
        if (Array.isArray(b.spans)) for (const s of b.spans) n += s.t.length;
        if (Array.isArray(b.title)) for (const s of b.title) n += s.t.length;
        if (typeof b.text === 'string') n += b.text.length;
        if (b.children) walk(b.children);
      }
    };
    walk(d.blocks);
    return n;
  });

test('WD-E2E-01 🔴 撤稿帧啃短真源 ⇒ 守卫回写会话峰值（口述内容不丢）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde01', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 组字会话：增长帧 10→100（每帧 +10）→ 108（补一帧到峰值）
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    const peak = await textLen(page);
    assert.equal(peak, 108, `会话峰值应为 108，实得 ${peak}`);

    // 撤稿帧：comp=0 替换到 13（v3.0.13 真机形状：整段口述被宿主撤掉只剩开头）
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));

    // 守卫必须把真源救回峰值
    await withTimeout(
      page.waitForFunction(
        (want) => {
          const d = window.__NOTESYNC_DOC__();
          let n = 0;
          const walk = (bs) => {
            for (const b of bs ?? []) {
              if (Array.isArray(b.spans)) for (const s of b.spans) n += s.t.length;
              if (Array.isArray(b.title)) for (const s of b.title) n += s.t.length;
              if (typeof b.text === 'string') n += b.text.length;
              if (b.children) walk(b.children);
            }
          };
          walk(d.blocks);
          return n === want;
        },
        108,
        { timeout: 5000 },
      ),
      5000,
      '撤稿后守卫必须把真源回写到会话峰值 108',
    );

    // 飞行痕迹：撤稿判定必须留痕（全程计数不随 ring 滚动）
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('gate:withdraw'), '飞行日志应含 gate:withdraw');
    assert.ok(/wd=1/.test(flight.split('\n')[0]), '表头全程计数应含 wd=1');
  } finally {
    await page.close();
  }
});

test('WD-E2E-02 🔴 容差内收尾不回写（撤稿守卫不得对抗正常收尾）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde02', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      // 收尾掉 1 字（远小于 max(12, 15)）：必须保留，不得回写
      t.withdrawTo(99);
    });
    await page.waitForTimeout(400);
    const len = await textLen(page);
    assert.equal(len, 99, `容差内收尾必须保留当前长度 99（不回写峰值 100），实得 ${len}`);
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(!flight.includes('gate:withdraw'), '容差内不得出现 gate:withdraw');
  } finally {
    await page.close();
  }
});

// 🔴🔴🔴 v3.0.15：「模型先落账、树延迟同步」。
//   v3.0.14 真机日志（第二份）钉死：撤稿判定后浏览器侧组字常常还活着
//   （synthed=0、comp=1 每帧都来），立即 docToLexical 重建杀死组字锚点 ⇒
//   后续组字帧全部模型空转（upd len=9 d=0 冻结、组字串 d=77→93 增长 3.5s+），
//   用户继续口述一个字都进不了文档。
//   ⚠️ 合成环境的边界（记档）：真机上「锚点死后组字帧空转」是 Android 宿主
//   僵尸组字专属——合成钩子每次 growTo 都会经合成 compositionstart 重新建立
//   组字态，复现不了空转本身。所以这里钉的是**机制不变量**：
//   撤稿后 600ms 内必须不重建（defer→cancel），超时才允许重建（defer→sync）。
//   ⚠️🔴 形状纪律（探针实测）：growTo 序列与 withdrawTo **必须分两次 evaluate**——
//   同一次 evaluate 里同步连发会被 Lexical 合并 flush，`upd len=108` 的峰值帧
//   推迟到 comp=0 之后才到，水位线会话在峰值帧上以「无掉幅」收场，
//   撤稿帧到达时已无会话可判（wd=0，判据整体空转）。真机豆包逐帧间隔
//   ~40ms，update 帧实时跟随，不存在这个合并；分两次 evaluate + 中间隔一拍
//   正是模拟真机逐帧节奏（WD-E2E-01 同款形状）。
test('WD-E2E-03 🔴 撤稿后组字恢复 ⇒ 树同步取消（绝不重建杀锚点，文档追上组字串）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde03', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 组字会话增长到峰值 108（与撤稿帧分开 evaluate——见上方形状纪律）
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    await page.waitForFunction(() => window.__NOTESYNC_DOC__() && JSON.stringify(window.__NOTESYNC_DOC__()).includes('x'.repeat(20)), null, { timeout: 5000 });
    // 撤稿帧：comp=0 整串被啃到 13
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));
    // 撤稿必须只落账模型、延迟树同步（wd:defer），绝不立即重建
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:defer'),
      null,
      { timeout: 5000 },
    );
    const flight1 = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight1.includes('gate:withdraw'), '撤稿判定必须留痕');
    assert.ok(!/gate:withdraw[\s\S]*upd len=108/.test(flight1), '撤稿后不得立即重建树（gate:withdraw 之后不得出现 len=108 的 upd 帧）');

    // 600ms 内组字恢复（comp=1 全量替换到 150）⇒ 取消树同步，文档追上组字串
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.growTo(150));
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen() === 150,
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(900); // 超过 600ms 窗口：cancel 生效则 wd:sync 永不触发
    const flight2 = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight2.includes('wd:cancel'), '组字恢复帧必须取消延迟树同步（wd:cancel）');
    assert.ok(!flight2.includes('wd:sync'), '恢复后重建绝不允许发生（不得出现 wd:sync）');
    const tree2 = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen());
    assert.equal(tree2, 150, `树必须追上组字串 150（不得被重建的 108 覆盖），实得 ${tree2}`);
    const doc2 = await textLen(page);
    assert.equal(doc2, 150, `真源必须跟上组字串 150，实得 ${doc2}`);
  } finally {
    await page.close();
  }
});

test('WD-E2E-04 🔴 撤稿后无恢复 ⇒ 600ms 后延迟重建（峰值内容上屏兜底）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde04', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 峰值帧（分两次 evaluate——见 WD-E2E-03 形状纪律）
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    await page.waitForFunction(() => window.__NOTESYNC_DOC__() && JSON.stringify(window.__NOTESYNC_DOC__()).includes('x'.repeat(20)), null, { timeout: 5000 });
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));
    // 不发任何 comp=1 帧：组字真死了，600ms 后必须重建把峰值内容上屏
    await page.waitForTimeout(900);
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('wd:defer'), '撤稿后必须调度延迟树同步（wd:defer）');
    assert.ok(flight.includes('wd:sync'), '超时无恢复必须执行延迟树同步（wd:sync）');
    assert.ok(!flight.includes('wd:cancel'), '无恢复时不得出现 wd:cancel');
    const tree = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen());
    assert.equal(tree, 108, `超时重建必须把峰值内容上屏（树=108），实得 ${tree}`);
    const doc = await textLen(page);
    assert.equal(doc, 108, `真源必须保持峰值 108，实得 ${doc}`);
  } finally {
    await page.close();
  }
});

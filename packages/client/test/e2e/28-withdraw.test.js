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

/**
 * e2e：飞行记录器取证链路（FLIGHT-E2E 系列，v3.0.9 诊断版）
 *
 * 🔴🔴🔴 为什么这条必须是 e2e（判据纪律：至少一条从最外层真实入口进）：
 *   单元判据钉的是记录器模块本身；而取证链路的真实形状是
 *     用户在编辑器里打字 → capture 探针捕获 beforeinput/input → recordFlight
 *     → localStorage → 诊断面板的 collectDiagLines → 用户点复制发给我。
 *   中间任何一环断了（探针没挂、diag 没接线、面板没追加），单元判据全绿
 *   而取证是瞎的 —— 那就白发了诊断版。这条钉的就是**整链**。
 *
 *   判据钉用户可见的最终产物：诊断文本里必须出现飞行日志区块，
 *   且含有这次真实打字产生的输入事件与 update 长度记录。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 路径纪律同 05-fold.test.js：必须 4 级到仓库根的 www。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

test('FLIGHT-E2E-01 🔴 打字产生的事件必须出现在诊断文本的飞行日志区块里', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'fl01', 'pw');
  try {
    // 清空本机记录（e2e 共享浏览器 profile 的 localStorage，不清会读到上一条测试的事件）
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    await page.keyboard.type('取证链路测试', { delay: 20 });
    // 等 update 事件落进记录器（节流 500ms，留够一轮）
    await withTimeout(
      page.waitForFunction(
        () => (localStorage.getItem('notesync_bj_flight') ?? '').includes('"upd"'),
        null,
        { timeout: 5000 },
      ),
      5000,
      'upd 事件必须落进 localStorage',
    );

    // 🔴 最外层真实入口：诊断面板同一条 collectDiagLines 通路
    const diag = await page.evaluate(() => window.__NOTESYNC_DIAG__());
    assert.ok(diag.includes('飞行日志'), '诊断文本必须含飞行日志区块');
    assert.ok(/in:bi insertText/.test(diag), '必须捕获到真实打字的 beforeinput 事件');
    assert.ok(/upd len=\d+ d=\d+/.test(diag), '必须有 update 长度记录（取证主动脉）');
    // 反向闸：**飞行日志区块内**绝不含正文内容（端到端加密纪律，日志会被粘贴传播）。
    //   🔴 判据只圈飞行日志区块：诊断面板**选择区读数**（collect.ts:81）本来就
    //   渲染光标所在文本节点的前 10 字符（老项目 :1941 同款，自有设备自查用），
    //   拿整份诊断文本断言"不含正文"是钉错对象。
    const flightSection = diag.slice(diag.indexOf('飞行日志'));
    assert.ok(!flightSection.includes('取证链路测试'), '🔴 飞行日志绝不允许记录正文内容');
  } finally {
    await page.close();
  }
});

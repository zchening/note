/**
 * e2e：跨段组字串塌方守卫（COMPOSE-E2E 系列，v3.0.10）
 *
 * 🔴🔴🔴 为什么必须是 e2e（判据纪律：至少一条从最外层真实入口进）：
 *   单元判据钉的是 decideCollapseRestore / ComposeGuard 本身；而守卫真正生效的
 *   形状是「编辑器里真实 update 监听 → 检测到塌方 → 把真源回退 + 重建树」。
 *   桌面无法复现 Android InputConnection 的原生塌方，这条用真实 compositionstart
 *   事件 + 真实 ed.update 塌方，戳进**同一个 update 监听**，验证守卫确实把真源
 *   从损坏态救回，且飞行记录器留下 gate:collapse / cmp:start 痕迹。
 *
 *   判据钉用户可见的最终产物：__NOTESYNC_DOC__ 的长度必须恢复回塌方前的字数，
 *   且飞行日志含 gate:collapse。恢复态绿 + 变异态（下面注释掉的对照）红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

test('COMPOSE-E2E-01 🔴 合成中单帧塌方必须被守卫救回真源', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'cmp01', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 敲两段正文（跨块），每段 72 字、共 144 字 —— 贴近"整篇笔记"场景，且越过守卫阈值
    const base = '笔记内容测试文本';
    const part1 = base.repeat(12);
    const part2 = base.repeat(12);
    await page.keyboard.type(part1, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.keyboard.type(part2, { delay: 5 });

    const typedLen = await page.evaluate(() => {
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
    assert.ok(typedLen >= 110, `塌方前正文应 >=110 字，实得 ${typedLen}`);

    // 全选（让 compositionstart 时选区跨块 ⇒ multiBlock=true，走主判据路径）
    await page.keyboard.press('Control+A');
    // 触发真实 compositionstart（喂守卫 active + 算 multiBlock）
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.start());
    assert.equal(await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.guardActive()), true);

    // 真实 ed.update 塌方：把整篇替换成 19 字短串（模拟 Lexical 原生合成回灌吞字）
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.collapse('被吞后的短文本'));

    // 守卫应在 update 监听里把真源回退到塌方前的字数
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
          return n >= want - 2;
        },
        typedLen,
        { timeout: 5000 },
      ),
      5000,
      '守卫必须把真源从塌方态救回原字数',
    );

    const recoveredLen = await page.evaluate(() => {
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
    assert.ok(recoveredLen >= typedLen - 2, `救回字数应≈塌方前（${typedLen}），实得 ${recoveredLen}`);

    // 飞行记录器必须留下塌方守卫痕迹
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('gate:collapse'), '飞行日志应含 gate:collapse');
    assert.ok(flight.includes('cmp:start'), '飞行日志应含 cmp:start（合成起止已喂守卫）');

    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.end());
  } finally {
    await page.close();
  }
});

test('COMPOSE-E2E-02 🔴🔴 回归：无 compositionstart、仅 insertCompositionText 塌方也必须被守卫救回', async () => {
  // v3.0.10 漏拦真因：豆包智能整理只发 insertCompositionText、不发 compositionstart，
  // 守卫从不激活。这条用 collapseNoStart 钩子模拟该真实入口（含 isComposing=true 的
  // beforeinput，但绝不发 compositionstart），验证守卫即便没收到 compositionstart 也能兜住塌方。
  const page = await openEditor(h.browser(), h.baseUrl(), 'cmp02', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    const base = '笔记内容测试文本';
    const part1 = base.repeat(12);
    const part2 = base.repeat(12);
    await page.keyboard.type(part1, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.keyboard.type(part2, { delay: 5 });

    const typedLen = await page.evaluate(() => {
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
    assert.ok(typedLen >= 110, `塌方前正文应 >=110 字，实得 ${typedLen}`);

    // 全选（让 beforeinput 时选区跨块 ⇒ multiBlock=true），但**绝不发 compositionstart**
    await page.keyboard.press('Control+A');
    assert.equal(
      await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.guardActive()),
      false,
      '未发 compositionstart 时守卫应处于未激活（v3.0.10 正因此漏拦）',
    );

    // 模拟豆包智能整理：仅 insertCompositionText（isComposing=true），不发 compositionstart
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.collapseNoStart('被吞后的短文本'));

    // 守卫应在 update 监听里把真源回退到塌方前的字数（即便从未 compositionstart）
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
          return n >= want - 2;
        },
        typedLen,
        { timeout: 5000 },
      ),
      5000,
      '守卫(无compositionstart)必须把真源从塌方态救回原字数',
    );

    const recoveredLen = await page.evaluate(() => {
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
    assert.ok(recoveredLen >= typedLen - 2, `救回字数应≈塌方前（${typedLen}），实得 ${recoveredLen}`);

    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('gate:collapse'), '飞行日志应含 gate:collapse（无 compositionstart 也触发）');
    assert.ok(!flight.includes('cmp:start'), '本测试未发 compositionstart，飞行日志不应含 cmp:start');
  } finally {
    await page.close();
  }
});

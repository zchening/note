/**
 * e2e：v3.0.12 豆包语音治本（合成 compositionstart）+ 重建重锚
 *
 * 🔴🔴🔴 为什么必须是 e2e（判据纪律：至少一条从最外层真实入口进）：
 *   ① 的合成 compositionstart 依赖「在 Lexical 的 beforeinput 监听器之前、于 capture
 *   相位向 editorHost 派发 compositionstart」这一时序，只能在真实浏览器里验证；
 *   单测若用扁平夹具会越过子树盲区，骗自己绿。桌面无豆包，用真实 beforeinput 事件
 *   （insertCompositionText + isComposing=true、不发真实 compositionstart）模拟豆包入口。
 *
 *   钉用户可见结果：① probeSynthCompose 必须使 ed.isComposing() 置位（绕过孤儿分支）；
 *   ③ 重建后原生选区仍落在编辑器内（不脱锚到外壳节点）；① 不能破坏正常打字。
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

test('VOICE-01 🔴 豆包只发 insertCompositionText（不发 compositionstart）必须使 ed.isComposing() 置位', async () => {
  // ① 治本回归：修复前 ed.isComposing() 恒 false（孤儿分支吞字）；修复后应为 true。
  const page = await openEditor(h.browser(), h.baseUrl(), 'voice01', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    await page.keyboard.type('先打几个字', { delay: 5 });

    const composing = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.probeSynthCompose());
    assert.equal(composing, true, '只发 insertCompositionText(isComposing=true) 时 ed.isComposing() 必须置位（① 治本）');

    // ⑤ 埋点：合成路径必须留下痕迹
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('cmp:synthed'), '飞行日志应含 cmp:synthed（合成 compositionstart）');
    assert.ok(flight.includes('sel:orphaned'), '飞行日志应含 sel:orphaned（DOM 组字但 Lexical 未组字）');

    // 复位合成态，避免污染后续
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.end());
  } finally {
    await page.close();
  }
});

test('VOICE-02 🔴 重建（塌方回退）后原生选区仍落在编辑器内（不脱锚到外壳）', async () => {
  // ③ 防御回归：root.clear() 重建后若原选区锚在已移除节点，必须重锚到编辑器内，
  //   否则原生 caret 停在外壳（v3.0.11 诊断 anchor=关于NoteSync、inEditor=no）。
  const page = await openEditor(h.browser(), h.baseUrl(), 'voice02', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 两段正文（跨块）以命中守卫主判据（豆包智能整理=全选替换，跨段），贴近真实场景
    const base = '笔记内容测试文本';
    const part1 = base.repeat(12);
    const part2 = base.repeat(12);
    await page.keyboard.type(part1, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.keyboard.type(part2, { delay: 5 });

    const typedLen = await textLen(page);
    assert.ok(typedLen >= 110, `塌方前正文应 >=110 字，实得 ${typedLen}`);

    // 全选后模拟豆包智能整理（只 insertCompositionText、不发 compositionstart）触发塌方重建
    await page.keyboard.press('Control+A');
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.collapseNoStart('被吞后的短文本'));

    // 守卫必须救回真源
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
      '塌方后守卫必须把真源救回',
    );

    // ③ 关键断言：重建后原生选区必须落在编辑器宿主（.ns-editor）内，而非外壳节点
    const inEditor = await page.evaluate(() => {
      const host = document.querySelector('.ns-editor');
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      return host ? host.contains(sel.getRangeAt(0).commonAncestorContainer) : false;
    });
    assert.equal(inEditor, true, '重建后原生选区必须落在编辑器内（不脱锚到外壳）');
  } finally {
    await page.close();
  }
});

test('VOICE-03 🔴 ① 合成 compositionstart 不能破坏正常键盘打字', async () => {
  // 回归：① 只在该拦截的组字入口触发，普通 insertText 路径不受影响。
  const page = await openEditor(h.browser(), h.baseUrl(), 'voice03', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    await page.keyboard.type('正常键盘输入一段中文', { delay: 5 });
    const len = await textLen(page);
    assert.ok(len >= 9, `正常打字必须完整进入真源，实得 ${len}`);
    // 普通打字不应触发合成 compositionstart
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(!flight.includes('cmp:synthed'), '普通键盘打字不应触发合成 compositionstart');
  } finally {
    await page.close();
  }
});

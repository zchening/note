/**
 * REMSEQ e2e 提醒添加的**序列场景**（用户报障 2026-10-15）
 *
 * 报障原文：「先通过提醒面板添加一个提醒，然后在正文里面输入『明天下午4:30事项』，
 *   光标移上去之后点击『添加提醒』按钮。点了没反应，这个框还在，也没有添加成功。」
 *
 * 🔴🔴 为什么必须单独一份：现有 REM-03 只测"干净笔记里第一次 chip 添加"，
 *   从没测过"面板已经加过一条之后再用 chip 加第二条"这条**序列**——
 *   而两条路径共用 setDoc / 铺标记 / chipData，序列态正是最容易串味的地方。
 *
 * 覆盖：
 *   REMSEQ-01 面板加一条 → 正文手写时间串 → 点 chip 加第二条：chip 必须变确认卡 + 真源两条
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

/** 把光标放到**含有指定片段**的文本节点里的某个偏移（不看全文偏移，块序号无关）。 */
async function caretInto(page, snippet, offsetInSnippet) {
  return page.evaluate(
    ({ snip, off }) => {
      const host = document.querySelector('.ns-editor');
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const i = (node.textContent || '').indexOf(snip);
        if (i !== -1) {
          const r = document.createRange();
          r.setStart(node, i + off);
          r.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          document.dispatchEvent(new Event('selectionchange'));
          return { node: node.textContent, at: i + off };
        }
        node = walker.nextNode();
      }
      return null;
    },
    { snip: snippet, off: offsetInSnippet },
  );
}

const remCount = (page) =>
  page.evaluate(() => (window.__NOTESYNC_DOC__().reminders || []).length);

test('REMSEQ-01 🔴 面板加一条后，正文里再点 chip 加第二条必须成功', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'remseq01', 'pw');
  try {
    // ① 先通过「提醒面板」添加第一条（默认时间 = 当前 +5 分钟，天然未来）
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rem-form .ns-rem-add', { timeout: 8000 });
    await page.fill('.ns-rem-form .ns-rem-input', '第一条事项');
    await page.click('.ns-rem-form .ns-rem-add');
    await page.waitForFunction(
      () => (window.__NOTESYNC_DOC__().reminders || []).length >= 1,
      null,
      { timeout: 8000 },
    );
    assert.equal(await remCount(page), 1, '前置：面板应已加进第一条');

    // ② 正文里手写一个相对时间串（用户原话的形态）
    await page.click('.ns-editor');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('明天下午4:30事项', { delay: 15 });
    await page.waitForTimeout(400);

    // ③ 光标落到时间串上 → chip 浮出
    const placed = await caretInto(page, '下午4:30', 3);
    assert.ok(placed, '应能在正文里定位到「下午4:30」这个时间串');
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 8000 });
    const chipTxt = await page.textContent('#timeChip');
    assert.ok(chipTxt.includes('添加提醒'), `chip 应显示「添加提醒」，实际=${chipTxt}`);

    // ④ 点 chip —— 用户报障就是这一步"点了没反应"
    await page.click('#timeChip');
    const became = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('#timeChip');
          return el && el.textContent.includes('提醒已添加') ? el.textContent : null;
        },
        null,
        { timeout: 8000 },
      )
      .then((hh) => hh.jsonValue())
      .catch(() => null);
    assert.ok(became, '点「添加提醒」后 chip 必须变成确认卡（用户报障：点了没反应、框还在）');
    assert.equal(await remCount(page), 2, '真源里应恰好两条提醒');
  } finally {
    await page.close();
  }
});

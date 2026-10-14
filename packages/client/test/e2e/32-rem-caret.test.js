/**
 * REMC e2e 添加提醒后**光标不许乱跳**（用户报障 2026-10-14）
 *
 * 报障原文：「不管是通过提醒面板添加提醒，还是通过正文里面添加提醒，
 *   添加成功之后，光标怎么一下子就从我添加提醒的位置跳到正文的最后面了？」
 *
 * 🔴🔴 为什么必须 e2e：光标落在哪一行是**真浏览器选区**的结果，
 *   jsdom/node 里没有 selection、没有 focus，单测测不到这一类症状。
 *
 * 覆盖：
 *   REMC-E1 面板添加提醒（会往正文插一行「时间　事项」）→ 光标不得跑到文末
 *   REMC-E2 正文 chip 添加提醒（不插行、块数不变）→ 光标应留在原来那一行
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

/**
 * 光标所在的**顶层块序号**（0 起）+ 全局块数。
 * 🔴 用块序号而不是"字符偏移"：面板添加会插入新行，偏移口径随之变化，
 *    块序号才对得上用户嘴里的"跳到第几行"。
 */
const caretBlock = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('.ns-editor');
    if (!host) return null;
    const kids = Array.from(host.children);
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return { index: -1, total: kids.length };
    let n = sel.anchorNode;
    if (n.nodeType === 3) n = n.parentElement;
    while (n && n.parentElement !== host) n = n.parentElement;
    return { index: n ? kids.indexOf(n) : -1, total: kids.length };
  });

/** 与 04-reminder.test.js 同源：把光标移到正文第 off 个字符。 */
async function caretTo(page, offset) {
  return page.evaluate((off) => {
    const host = document.querySelector('.ns-editor');
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let left = Math.max(0, off);
    let node = walker.nextNode();
    let last = null;
    while (node) {
      const len = (node.textContent || '').length;
      if (left <= len) break;
      left -= len;
      last = node;
      node = walker.nextNode();
    }
    if (!node) { node = last; left = node ? node.textContent.length : 0; }
    if (!node) throw new Error('编辑器里没有文本节点');
    const r = document.createRange();
    r.setStart(node, left);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  }, offset);
}

test('REMC-E1 🔴 面板添加提醒后，光标不得跳到正文最后一行', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'remc01', 'pw');
  try {
    // 三行正文，光标落在**第一行**中间（不是行尾、不是末行）
    await page.click('.ns-editor');
    await page.keyboard.type('第一行内容', { delay: 12 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('第二行内容', { delay: 12 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('第三行内容', { delay: 12 });
    await page.waitForTimeout(300);
    await caretTo(page, 2); // 第一行中间
    const before = await caretBlock(page);
    assert.equal(before.index, 0, '前置条件：光标应在第一行');

    await page.click('#remBtn');
    await page.waitForSelector('.ns-rem-form .ns-rem-add', { timeout: 8000 });
    await page.fill('.ns-rem-form .ns-rem-input', '2333测试');
    await page.click('.ns-rem-form .ns-rem-add');
    await page.waitForTimeout(1500);

    const after = await caretBlock(page);
    // 面板会插一行「时间　事项」，插在光标处 ⇒ 光标最多落在紧邻其后，
    // **绝不允许跑到最后一块**（用户报障症状）。
    assert.notEqual(
      after.index,
      -1,
      '添加后光标必须还在正文里（实测拿不到光标，说明选区被整篇重建冲掉了）',
    );
    assert.ok(
      after.index < after.total - 1,
      `光标不得落到正文最后一行：添加前第 ${before.index + 1} 行（共 ${before.total}），添加后第 ${after.index + 1} 行（共 ${after.total}）`,
    );
  } finally {
    await page.close();
  }
});

test('REMC-E2 🔴 正文里（chip）添加提醒后，光标应留在原来那一行', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'remc02', 'pw');
  try {
    const tomorrow = await page.evaluate(() => {
      const d = new Date(Date.now() + 24 * 3600000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getMonth() + 1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    await page.click('.ns-editor');
    await page.keyboard.type(`${tomorrow} 开会`, { delay: 12 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('第二行内容', { delay: 12 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('第三行内容', { delay: 12 });
    await page.waitForTimeout(300);
    await caretTo(page, 4); // 第一行的时间串上
    const before = await caretBlock(page);
    assert.equal(before.index, 0, '前置条件：光标应在第一行');

    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 8000 });
    await page.click('#timeChip');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#timeChip');
        return !!(el && el.textContent.includes('提醒已添加'));
      },
      null,
      { timeout: 8000 },
    );
    await page.waitForTimeout(1200);

    const after = await caretBlock(page);
    // chip 路径不插行 ⇒ 块数不变，光标应还在原来那一行
    assert.equal(after.total, before.total, 'chip 添加不该改变行数');
    assert.equal(
      after.index,
      before.index,
      `chip 添加后光标应留在原行：期望第 ${before.index + 1} 行，实际第 ${after.index + 1} 行（共 ${after.total}）`,
    );
  } finally {
    await page.close();
  }
});

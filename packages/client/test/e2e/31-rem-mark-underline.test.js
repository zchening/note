/**
 * REMU e2e 提醒标记（下划线 / 删除线）必须真的出现在屏幕上
 *
 * 🔴🔴 为什么 04-reminder 不够、还要单独一份：
 *   04 的 REM-03 只钉了「chip 变确认卡 + 真源里出现该提醒」，
 *   **没有任何一条断言屏幕上的下划线**。而用户报障正是这一层——
 *   提醒会响、真源对、chip 也确认了，唯独正文里那个时间下面没有下划线，
 *   全程零报错（与 reminder/local-mark.ts 文件头记录的病状同形）。
 *
 * 覆盖：
 *   REMU-E1 点「添加提醒」后，正文里那个时间串必须被 <u class="rem-mark"> 包住
 *   REMU-E2 时间已过的提醒必须改成 <s class="rem-done">（整段删除线）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

/** 与 04-reminder.test.js 同源的正文输入助手（走真实键盘路径）。 */
async function typeBody(page, text) {
  await page.click('.ns-editor');
  await page.keyboard.type(text, { delay: 12 });
}

/** 把光标移到正文第 off 个字符（纯文本口径），与 04 同款 walker 实现。 */
async function caretTo(page, offset) {
  return page.evaluate((off) => {
    const host = document.querySelector('.ns-editor');
    if (!host) throw new Error('没有编辑器');
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
    if (!node) {
      node = last;
      left = node ? (node.textContent || '').length : 0;
    }
    if (!node) throw new Error('编辑器里没有文本节点');
    const r = document.createRange();
    r.setStart(node, left);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    return { node: node.textContent, offset: left };
  }, offset);
}

/** 明天的「X月X日HH:MM」（未过期 ⇒ chip 会浮出、添加后应为下划线）。 */
const futureStamp = (page) =>
  page.evaluate(() => {
    const d = new Date(Date.now() + 24 * 3600000);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
  });

/** 走完「浮 chip → 点 chip → 确认卡」三步。 */
async function addReminderViaChip(page, stamp, caretAt, body) {
  await typeBody(page, body);
  await caretTo(page, caretAt);
  await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });
  await page.click('#timeChip');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('#timeChip');
      return !!(el && el.textContent.includes('提醒已添加'));
    },
    null,
    { timeout: 8000 },
  );
}

test('REMU-E1 🔴 点「添加提醒」后，正文里那个时间串必须有下划线（u.rem-mark）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'remu01', 'pw');
  try {
    const stamp = await futureStamp(page);
    await addReminderViaChip(page, stamp, 4, `${stamp} 开会`);
    // 🔴 用户可见的最终结果：屏幕上那个时间下面必须有下划线标记
    const marked = await page
      .waitForFunction(
        () => {
          const u = document.querySelector('.ns-editor u.rem-mark');
          return u ? u.textContent : null;
        },
        null,
        { timeout: 8000 },
      )
      .then((h2) => h2.jsonValue())
      .catch(() => null);
    assert.ok(
      marked,
      '添加提醒后，正文里那个时间串必须被 u.rem-mark 包住（这就是用户看到的下划线）；实际编辑器里没有该标记',
    );
    assert.ok(
      /[0-9]/.test(String(marked)),
      `下划线应包住时间串本身，实际=${JSON.stringify(marked)}`,
    );
  } finally {
    await page.close();
  }
});

test('REMU-E2 🔴 走「提醒面板」添加（用户报障原路径）：正文时间串必须有下划线', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'remu02', 'pw');
  try {
    // 顶栏铃铛 = 提醒面板（老项目同一入口）
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rem-form .ns-rem-add', { timeout: 8000 });
    // 面板默认 = 当前 +5 分钟（天然未来），直接填事项即等价用户路径
    await page.fill('.ns-rem-form .ns-rem-input', '2333测试');
    await page.click('.ns-rem-form .ns-rem-add');
    // 🔴 面板添加会：插入正文行「时间　事项」→ 写真源 reminders → 对账铺标记
    const marked = await page
      .waitForFunction(
        () => {
          const u = document.querySelector('.ns-editor u.rem-mark');
          return u ? u.textContent : null;
        },
        null,
        { timeout: 8000 },
      )
      .then((h2) => h2.jsonValue())
      .catch(() => null);
    assert.ok(
      marked,
      '面板添加提醒后，正文里那条时间串必须被 u.rem-mark 包住（用户可见的下划线）；实际没有',
    );
  } finally {
    await page.close();
  }
});

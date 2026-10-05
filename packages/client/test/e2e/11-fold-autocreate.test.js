/**
 * e2e：行首 `[折叠]` 自动识别（FOLD-07 / FOLD-08）
 *
 * 🔴🔴🔴 这两条是补 P0 的回归闸，来源是一次真实缺陷审计：
 *   `05-fold.test.js` 原有 6 条测试**全部**用 `window.__NOTESYNC_INSERT_FOLD__()`
 *   这个测试钩子造折叠块，**没有一条模拟用户手打**。
 *   于是「$createFoldNode 只有钩子与序列化两个调用点、手打 `[折叠]` 一行普通文本」
 *   这个 P0 缺陷在 CI 上全绿通过了 —— 测试造的是它自己认识的东西，
 *   测不到用户唯一能走的那条路。
 *
 *   判据纪律：**验收路径必须是用户真实路径**（聚焦编辑器 → 逐字敲键盘）。
 *   任何"通过钩子造出来"的折叠块测试都不能证明折叠功能对用户可用。
 *
 * 覆盖两条：
 *   FOLD-07  段首键入 `[折叠]` → 变成真 fold 块（不是普通文本）
 *   FOLD-08  正文中间出现 `[折叠]` **不得**被吞（老项目判据是"行首"，不是全文搜索）
 *            —— 这条是反向闸：防止把"修复"做成"全文替换标记"这种内容损坏
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 路径纪律同 05-fold.test.js：必须 4 级到仓库根的 www。
// 写成 3 级会拿到 packages/www（不存在），症状是 bodyHTML 只剩几十字符。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

const canon = (page) =>
  page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));

test('FOLD-07🔴 段首键入 [折叠] 变成真 fold 块（用户真实路径，非钩子）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f07', 'pw');
  try {
    await page.click('.ns-editor');
    // 🔴 必须用 keyboard.type 逐字敲：它会走真实 beforeinput(inputType=insertText)
    //   与 Lexical 的文本插入链。page.evaluate 塞 innerHTML 走不到这条路，
    //   那样测就又变成"造了个测试专用路径"。
    await page.keyboard.type('[折叠]', { delay: 20 });

    // 等识别完成：监听器用 editor.update(..., {discrete:true})，下一帧就位。
    await withTimeout(
      page.waitForFunction(
        () => (window.__NOTESYNC_DOC__().blocks || []).some((b) => b.t === 'fold'),
        null,
        { timeout: 8000 },
      ),
      8000,
      '手打 [折叠] 后真源里应出现 fold 块',
    );

    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    const fold = (doc.blocks || []).find((b) => b.t === 'fold');
    assert.ok(fold, '应存在 fold 块，实际=' + JSON.stringify(doc));

    // DOM 侧也要对：真的渲染成了 .ns-fold 容器（不只是模型里有个 fold）
    const domFold = await page.$('.ns-fold');
    assert.ok(domFold, 'DOM 里应出现 .ns-fold 容器');
    const open = await page.getAttribute('.ns-fold', 'data-open');
    assert.equal(open, 'true', '新建折叠块应是展开态（open=true），否则用户无法直接往里打字');

    // 标记文本必须被消费掉，不能留在可见标题里
    const headText = await page.evaluate(() => {
      const el = document.querySelector('.ns-fold > :first-child');
      return el ? el.textContent : '';
    });
    assert.ok(
      !headText.includes('[折叠]'),
      '标题里不该残留 [折叠] 标记文本，实际="' + headText + '"',
    );
  } finally {
    await page.close();
  }
});

test('FOLD-08 🔴 正文中间的 [折叠] 不得被吞成结构（防内容损坏的反向闸）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f08', 'pw');
  try {
    await page.click('.ns-editor');
    // 🔴🔴 判据是「**行首** `[折叠]`」，不是全文搜索（老项目同款）。
    //   所以反向闸的正确姿势是：让标记落在**同一段的开头之后**，
    //   即前面先有字。**不能按 Enter** —— 换行后标记就成了新段落的开头，
    //   那是合法的行首，代码识别成折叠块是**正确行为**。
    //   （我第一版写成"打完一段按 Enter 再打标记"，结果断言反向失败：
    //     代码是对的、测试是错的。这类"把对的判成错的"必须改测试而不是改实现。）
    await page.keyboard.type('这段话里提到[折叠]两个字', { delay: 20 });

    // 给识别逻辑充足的时间跑（若它错误地全文搜索，这里就会被吞）
    await page.waitForTimeout(1200);

    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    const folds = (doc.blocks || []).filter((b) => b.t === 'fold');
    assert.equal(
      folds.length,
      0,
      '段落中间的 [折叠] 不该被转成结构，会吞掉用户内容。真源=' + JSON.stringify(doc),
    );

    // 原文必须完好
    const before = await canon(page);
    assert.ok(
      before.includes('这段话里提到'),
      '用户原文应完好，实际=' + before,
    );
  } finally {
    await page.close();
  }
});

test('FOLD-09 🔴 换行后在**行首**打标记应正常识别（用户真实写法）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f09', 'pw');
  try {
    await page.click('.ns-editor');
    await page.keyboard.type('前言段落', { delay: 20 });
    await page.keyboard.press('Enter');
    // 这一行是**新段落的开头**，正是老项目 applyFolds 的识别场景
    await page.keyboard.type('[折叠]', { delay: 20 });

    await withTimeout(
      page.waitForFunction(
        () => (window.__NOTESYNC_DOC__().blocks || []).some((b) => b.t === 'fold'),
        null,
        { timeout: 8000 },
      ),
      8000,
      '换行后行首打 [折叠] 应识别成 fold 块',
    );

    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    // 前言段落必须完好（识别不能吃掉上文）
    const texts = (doc.blocks || []).map((b) => JSON.stringify(b)).join('');
    assert.ok(texts.includes('前言段落'), '上文应完好，真源=' + JSON.stringify(doc));
  } finally {
    await page.close();
  }
});

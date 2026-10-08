/**
 * e2e：打印样式（PRINT 系列）—— 真浏览器 + `emulateMedia({media:'print'})`
 *
 * 🔴🔴 为什么必须用真浏览器的 computedStyle，不能正则匹配 CSS 字符串：
 *   本项目的纪律里记过「425 测试全绿、导出图照样丢正文」那次翻车 ——
 *   正则匹配 CSS 源码在 specificity 算错时**恒绿**。打印这条尤其危险：
 *   bj 的展开态三角是**另一条规则** `.ns-fold[data-open="true"] > :first-child::before`
 *   （specificity (0,2,1)），会压过打印块里单写的 `.ns-fold > :first-child::before`
 *   （(0,1,1)）。只匹配字符串的话，"打印块里有 display:none" 恒为真，
 *   而真机上打印展开的折叠块**照样画出三角**。
 *   ⇒ 唯一可信的判据是 `getComputedStyle(el, '::before')` 在 print 媒体下的读数。
 *
 * 🔴 老项目 index.html:423 那条 @media print 的 6 条声明里，"去三角"挂了
 *   **两个选择器**（`.ns-fold-mark::before` + `.ns-fold-open>.ns-fold-mark::before`），
 *   就是为了覆盖展开态。本文件钉的正是"两态在打印下都必须没三角"。
 *
 * 路径纪律：走真实用户路径（落地页 → 口令页 → 编辑器），不直接 goto。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 必须是 4 级（e2e → test → client → packages → 仓库根）。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });
const PASS = 'pw';

/** 造一个折叠块（默认展开态），返回后可直接读伪元素。 */
async function makeFold(page) {
  await page.click('.ns-editor');
  await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
  await page.waitForSelector('.ns-fold', { timeout: 10_000 });
  await page.waitForTimeout(300);
}

/** 读标题段落 ::before（三角）在**当前媒体**下的 computed 读数。 */
const readTriangle = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.ns-fold > :first-child');
    if (!el) return null;
    const cs = getComputedStyle(el, '::before');
    return {
      content: cs.content,
      display: cs.display,
      borderLeftWidth: cs.borderLeftWidth,
      borderTopWidth: cs.borderTopWidth,
      width: cs.width,
      height: cs.height,
    };
  });

test('PRINT-01 🔴 打印态：**展开**的折叠块三角必须消失（老项目 :423 两态都杀）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'pr01', PASS);
  try {
    await makeFold(page);
    // 前置自证：新建折叠块是展开态（否则下面等于在测收起态，判据落空）
    assert.equal(await page.getAttribute('.ns-fold', 'data-open'), 'true', '前置：应为展开态');

    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(150);
    const tri = await readTriangle(page);
    assert.ok(tri, '应能找到折叠标题段落');
    // 🔴 应该有：打印下三角必须被去掉。
    //   ⚠️ 别把 content 写成 'none' —— 老项目 :423 的写法是 `content:''`，
    //   浏览器 computed 把它归一成空串 `""`（不是关键字 none）。三角真正消失靠的是
    //   `display:none` + 边框清零（三角是 border 画的，只清 content 会留下一枚画出来的三角）。
    assert.equal(tri.display, 'none', `打印态三角 display 应为 none，实际=${JSON.stringify(tri)}`);
    assert.ok(tri.content === '""' || tri.content === 'none', `打印态三角 content 应无字形，实际=${JSON.stringify(tri)}`);
    // 🔴 不应该有：边框/尺寸不许残留
    assert.equal(tri.borderLeftWidth, '0px', `打印态三角左边框应清零，实际=${JSON.stringify(tri)}`);
    assert.equal(tri.borderTopWidth, '0px', `打印态三角上边框应清零，实际=${JSON.stringify(tri)}`);
    assert.equal(tri.width, '0px', `打印态三角宽应清零，实际=${JSON.stringify(tri)}`);
    assert.equal(tri.height, '0px', `打印态三角高应清零，实际=${JSON.stringify(tri)}`);
  } finally {
    await page.close();
  }
});

test('PRINT-02 反向闸：屏幕态展开三角仍在（打印规则不许误伤屏幕）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'pr02', PASS);
  try {
    await makeFold(page);
    const tri = await readTriangle(page); // 默认 screen 媒体
    assert.ok(tri, '应能找到折叠标题段落');
    // 🔴 不应该有：屏幕下三角必须是活的（inline-block + 实心边非零）
    assert.equal(tri.display, 'inline-block', `屏幕态三角 display 应为 inline-block，实际=${JSON.stringify(tri)}`);
    assert.notEqual(tri.content, 'none', `屏幕态三角 content 不该是 none，实际=${JSON.stringify(tri)}`);
    // 🔴 展开态三角是"向下"的：**实心边在 border-top**（桌面 8px / 移动断点 9px），
    //   而 border-left 是透明侧边（4px / 5px）—— 别照着收起态去写 border-left。
    assert.ok(parseFloat(tri.borderTopWidth) > 0, `屏幕态展开三角上边框应非零，实际=${JSON.stringify(tri)}`);
  } finally {
    await page.close();
  }
});

test('PRINT-03 🔴 打印态：**收起**的折叠块正文必须显出来（老项目 :423 还原正文）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'pr03', PASS);
  try {
    await makeFold(page);
    // 在正文里打字，再收起
    await page.click('.ns-fold > :not(:first-child)');
    await page.keyboard.type('打印必须看得见的正文');
    await page.waitForTimeout(300);
    await page.click('.ns-fold > :first-child', { position: { x: 8, y: 10 } });
    await page.waitForFunction(
      () => document.querySelector('.ns-fold')?.getAttribute('data-open') === 'false',
      { timeout: 5000 },
    );
    await page.waitForTimeout(200);

    const bodySel = '.ns-fold > :not(:first-child)';
    // 前置自证：屏幕态收起时正文确实是隐藏的（否则"打印显出来"是恒真）
    const screenDisplay = await page.evaluate(
      (s) => getComputedStyle(document.querySelector(s)).display,
      bodySel,
    );
    assert.equal(screenDisplay, 'none', `前置：屏幕收起态正文应 display:none，实际=${screenDisplay}`);

    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(150);
    const printDisplay = await page.evaluate(
      (s) => getComputedStyle(document.querySelector(s)).display,
      bodySel,
    );
    // 🔴 应该有：打印时收起的正文必须还原成可见（否则整段正文丢在纸外）
    assert.notEqual(printDisplay, 'none', `打印态收起正文必须可见，实际 display=${printDisplay}`);
    // 🔴 同时三角也要没了（收起的折叠块同样不该在纸上留三角）
    const tri = await readTriangle(page);
    assert.equal(tri.display, 'none', `打印态收起折叠块三角也应消失，实际=${JSON.stringify(tri)}`);
    assert.ok(tri.content === '""' || tri.content === 'none', `打印态收起三角 content 应无字形，实际=${JSON.stringify(tri)}`);
  } finally {
    await page.close();
  }
});

test('PRINT-04 反向闸：屏幕态收起正文仍藏（打印规则不许误伤屏幕）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'pr04', PASS);
  try {
    await makeFold(page);
    await page.click('.ns-fold > :first-child', { position: { x: 8, y: 10 } });
    await page.waitForFunction(
      () => document.querySelector('.ns-fold')?.getAttribute('data-open') === 'false',
      { timeout: 5000 },
    );
    await page.waitForTimeout(200);
    const display = await page.evaluate(
      (s) => getComputedStyle(document.querySelector(s)).display,
      '.ns-fold > :not(:first-child)',
    );
    assert.equal(display, 'none', `屏幕态收起正文必须仍藏，实际 display=${display}`);
  } finally {
    await page.close();
  }
});
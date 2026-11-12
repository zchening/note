/**
 * e2e 34：首屏 critical CSS 兜底（构建模板里的内联 <style>）
 *
 * 复刻的是「HTML 到了、app.css / app.js 都没拿到」这一**资源不可得形状**：
 * 404 + JSON + nosniff 会让 UA 拒绝把它当 CSS 用，于是外链样式整份失效。
 *
 * 🔴 这里只构造形状，**不宣称线上那次故障的真因**：当次无静态资源访问日志、
 *    壳内 webContentsDebuggingEnabled 关闭，故障不可复原。别把本文件的 404 形状
 *    当成事故结论写进任何注释或发布说明。
 *
 * 🔴 为什么 app.js 也要拦：不拦的话 boot() 会执行并 boot.remove()，
 *    #boot 根本不存在，「居中」这条断言就无从量起。
 *
 * 🔴 判据一律查用户可见终态（computedStyle / isVisible / boundingBox），
 *    不拿 classList 当结论 —— class 在、样式没到，用户看到的仍是裸 DOM。
 *
 * 三条：
 *   CSS-FALL-01 兜底生效：冲突条不可见、冲突文案不可见、#boot 仍在且铺满视口居中；
 *   CSS-FALL-02 变异自证：把内联块剥掉再加载，01 的「不可见」必须翻成「可见」，
 *                        证明 01 不是恒真断言（剥离前先 assert 目标串存在，
 *                        replace 静默失败会造出假「有牙」）；
 *   CSS-FALL-03 顺序：内联块必须位于 stylesheet link 之前（真源 + 产物都钉），
 *                    否则同特异性下后加载的 app.css 盖不住兜底规则。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..');
const WWW = join(ROOT, 'www');
const BUILD = join(ROOT, 'tools', 'build.mjs');

const CRITICAL_OPEN = '<style id="ns-critical">';
const CRITICAL_RE = /<style id="ns-critical">[\s\S]*?<\/style>/;
const STYLE_LINK = '<link rel="stylesheet"';

const h = installHarness(test, { dir: WWW });

const DEAD_RES = {
  status: 404,
  contentType: 'application/json',
  headers: { 'x-content-type-options': 'nosniff' },
  body: '{"error":"not found"}',
};

/** 只取 HTML 模板本体，避开 build.mjs 里大段注释中的同形字样。 */
function templateSlice(src) {
  const from = src.indexOf('<!doctype html>');
  const to = src.indexOf('</html>', from);
  assert.ok(from >= 0 && to > from, '找不到 index.html 模板本体');
  return src.slice(from, to);
}

async function openDeadAssets(mutatedHtml) {
  const page = await h.browser().newPage();
  await page.route('**/app.css', (route) => route.fulfill(DEAD_RES));
  await page.route('**/app.js', (route) => route.fulfill(DEAD_RES));
  if (mutatedHtml != null) {
    await page.route(
      (url) => url.pathname === '/' || url.pathname === '/index.html',
      (route) => route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: mutatedHtml,
      }),
    );
  }
  await page.goto(h.baseUrl(), { waitUntil: 'domcontentloaded' });
  return page;
}

test('CSS-FALL-01 🔴 资源全丢时不得裸奔：冲突条藏住、载入态居中', async () => {
  const page = await openDeadAssets();
  try {
    // 「不应有」：本该 hidden 的 DOM 不许露出来
    const display = await page.locator('#draftBar').evaluate((el) => getComputedStyle(el).display);
    assert.equal(display, 'none', 'app.css 失效时 #draftBar 必须仍被内联 .hidden 藏住');
    assert.equal(await page.locator('#draftBar').isVisible(), false, '冲突条不许可见');
    assert.equal(await page.getByText('检测到同步冲突').isVisible(), false, '冲突文案不许可见');

    // 「应有」：#boot 仍在，且不是贴顶的一小行
    assert.equal(await page.locator('#boot').isVisible(), true, '#boot 必须可见');
    assert.equal((await page.locator('#boot').textContent())?.trim(), '载入中…');
    const box = await page.locator('#boot').boundingBox();
    const vh = page.viewportSize().height;
    assert.ok(box && box.height >= vh - 2,
      `#boot 应铺满视口高度（实测 ${box?.height}，视口 ${vh}）`);
    const cs = await page.locator('#boot').evaluate((el) => {
      const s = getComputedStyle(el);
      return { d: s.display, ai: s.alignItems, jc: s.justifyContent };
    });
    assert.equal(cs.d, 'flex', '#boot 应为 flex 居中容器');
    assert.equal(cs.ai, 'center');
    assert.equal(cs.jc, 'center');
  } finally {
    await page.close();
  }
});

test('CSS-FALL-02 🔴 变异自证：剥掉内联兜底必须重现裸奔', async () => {
  const html = await readFile(join(WWW, 'index.html'), 'utf8');
  const m = CRITICAL_RE.exec(html);
  assert.ok(m, `产物 index.html 缺少 ${CRITICAL_OPEN} 内联兜底块（忘了 build 或模板被改）`);
  const mutated = html.replace(m[0], '');
  assert.ok(!CRITICAL_RE.test(mutated), '剥离失败：变异 HTML 里仍残留内联兜底块');
  assert.ok(templateSlice(mutated).includes(STYLE_LINK), '剥离必须保留 stylesheet link，否则场景失真');

  const page = await openDeadAssets(mutated);
  try {
    assert.equal(await page.locator('#draftBar').isVisible(), true,
      '剥掉内联兜底后冲突条必须可见 —— 否则 01 是恒真断言、根本没有牙');
    assert.equal(await page.getByText('检测到同步冲突').isVisible(), true,
      '剥掉内联兜底后冲突文案必须可见');
  } finally {
    await page.close();
  }
});

test('CSS-FALL-03 🔴 内联块必须在 stylesheet link 之前（真源 + 产物）', async () => {
  for (const [label, file] of [
    ['真源 build.mjs', BUILD],
    ['产物 www/index.html', join(WWW, 'index.html')],
  ]) {
    const src = await readFile(file, 'utf8');
    const body = templateSlice(src);
    const m = CRITICAL_RE.exec(body);
    assert.ok(m, `${label} 的 HTML 模板里缺少内联兜底块`);
    const styleAt = body.indexOf(m[0]);
    const linkAt = body.indexOf(STYLE_LINK);
    assert.ok(linkAt >= 0, `${label} 缺少 stylesheet link`);
    assert.ok(styleAt < linkAt,
      `${label}：内联块(${styleAt}) 必须在 link(${linkAt}) 之前，否则 app.css 覆盖不了兜底规则`);
  }
});

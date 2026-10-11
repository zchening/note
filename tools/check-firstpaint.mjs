/**
 * 首屏闸：入口脚本 defer + CSS 外链 —— **在真浏览器里**验，不读源码就下结论。
 *
 * 🔴 为什么必须有这个脚本：
 *   这两条改的是**产物**（www/ 由 tools/build.mjs 生成），改错了不会有任何单测报红 ——
 *   esbuild 照样出包、单测照常绿，只有真打开页面才看得出"整站没样式"。
 *   而"整站没样式"在 CI 日志里是**一片绿**，一路飘到用户手机上。
 *
 * 🔴 为什么判 computedStyle 而不判 HTML 文本：
 *   产物里有 `<link rel="stylesheet" href="app.css">` 这一行，
 *   **不等于**样式真的生效了（文件 404、路径错、preload 当 stylesheet 用、
 *   只给了 preload 没给 stylesheet —— 后者是本项目最容易犯的一种：
 *   preload 只负责提前下载，**不负责应用**）。
 *   本项目纪律里"判 CSS 补丁生效必须读真浏览器 computedStyle"说的就是这件事。
 *
 * 🔴 挑哪几个属性当判据：必须是**浏览器默认值之外**的值，
 *   否则撤掉样式表之后它照样绿（恒真断言＝没有断言）。
 *   实测过：body 的 font-size 在样式丢失时**仍是 16px**（浏览器默认恰好同值），
 *   所以真正顶用的是 display:flex / flex-direction:column / line-height:25.6px /
 *   transition-duration:.3s —— 这四个在默认 UA 样式下分别是 block / row / normal / 0s。
 *   ⚠️ 别再把 font-size:16px 当成"样式生效"的证据。
 *
 * 用法（必须先 build）：
 *   node tools/check-firstpaint.mjs [www目录]   默认 www
 *
 * 退出码：任一判据不成立 → 1。
 */

import { chromium } from 'playwright';
import { serveStatic, makeApiStore, withTimeout } from '../packages/client/test/e2e/harness.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'www');

let red = 0;
const ok = (label, cond, extra = '') => {
  console.log((cond ? '✅ ' : '❌ ') + label + (extra ? `  —— ${extra}` : ''));
  if (!cond) red++;
};

/* ---------- 产物侧：文件真的存在、真的被引用 ---------- */
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const cssPath = join(dir, 'app.css');
ok('产物里有 app.css 且非空', existsSync(cssPath) && readFileSync(cssPath).length > 0);
ok('index.html 用 <link rel="stylesheet"> 引用 app.css',
  /<link rel="stylesheet" href="app\.css">/.test(html));
ok('index.html 用 <link rel="preload" as="style"> 预载 app.css',
  /<link rel="preload" as="style" href="app\.css">/.test(html));
// 「不应该有」：CSS 不再整段内联进 HTML（内联时期 162KB）
const inlineStyle = /<style>([\s\S]*?)<\/style>/.exec(html);
ok('index.html 里**不再**有大段内联 CSS', !inlineStyle || inlineStyle[1].length < 200,
  inlineStyle ? `残留 ${inlineStyle[1].length} 字符` : '无 <style>');
ok('入口脚本带 defer', /<script src="app\.js" defer>/.test(html));

/* ---------- 真浏览器侧 ---------- */
const { srv, base } = await serveStatic(dir, makeApiStore());
const browser = await withTimeout(chromium.launch(), 60_000, 'chromium.launch');
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
await page.goto(base);

// ① 页面正常渲染（#li 是落地页输入框，e2e 的 openEditor 也走它）
let liVisible = false;
try {
  await page.waitForSelector('#li', { timeout: 20_000 });
  liVisible = await page.isVisible('#li');
} catch { /* 下面统一报 */ }
ok('页面正常渲染：#li 可见', liVisible, liVisible ? '' : `pageerror=${errs.join(' | ') || '(无)'}`);

// ② script 真的带 defer（读 DOM 属性，不是读源码）
const deferAttr = await page
  .$eval('script[src="app.js"]', (el) => ({ deferProp: el.defer, hasAttr: el.hasAttribute('defer') }))
  .catch(() => null);
ok('script[src=app.js].defer === true', deferAttr?.deferProp === true && deferAttr?.hasAttr === true,
  deferAttr ? JSON.stringify(deferAttr) : '找不到该 script');

// ③ 外链样式表**被加载且解析出规则**（不是空文件、不是 404）
const sheets = await page.evaluate(() =>
  [...document.styleSheets].map((s) => ({
    href: s.href ?? '',
    rules: (() => { try { return s.cssRules.length; } catch { return -1; } })(),
  })),
);
const appCss = sheets.find((s) => s.href.endsWith('/app.css'));
ok('document.styleSheets 里有 app.css 且解析出规则', !!appCss && appCss.rules > 100,
  appCss ? `href=${appCss.href} rules=${appCss.rules}` : `实际=${JSON.stringify(sheets)}`);

// ④ computedStyle：样式真的作用到了元素上
const cs = await page.evaluate(() => {
  const b = getComputedStyle(document.body);
  return {
    display: b.display,
    flexDirection: b.flexDirection,
    lineHeight: b.lineHeight,
    transitionDuration: b.transitionDuration,
    bg: b.backgroundColor,
  };
});
// 下面四个在 UA 默认样式下分别是 block / row / normal / 0s，所以撤掉样式表必然转红
ok('computedStyle: body display === flex（默认 block）', cs.display === 'flex', cs.display);
ok('computedStyle: body flex-direction === column（默认 row）', cs.flexDirection === 'column', cs.flexDirection);
ok('computedStyle: body line-height === 25.6px（16px×1.6，默认 normal）', cs.lineHeight === '25.6px', cs.lineHeight);
ok('computedStyle: body transition-duration === 0.3s（默认 0s）',
  cs.transitionDuration === '0.3s, 0.3s', cs.transitionDuration);
ok('computedStyle: body 背景色不是透明（--bg 令牌解析出来了）',
  cs.bg !== 'rgba(0, 0, 0, 0)' && cs.bg !== 'transparent', cs.bg);

await browser.close();
await new Promise((r) => srv.close(r));

console.log(red === 0 ? '\n✅ 首屏闸通过（defer + CSS 外链，真浏览器验过）' : `\n❌ 首屏闸未通过（${red} 项）`);
process.exit(red === 0 ? 0 : 1);

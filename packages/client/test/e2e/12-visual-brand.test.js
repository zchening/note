/**
 * 视觉回归闸：Logo 与图标金色高亮层。
 *
 * 🔴🔴 这两条是被一次真实缺陷审计逼出来的（P0，均已修复）：
 *   1. Logo 被换成了另一套图形（整圆+同 心弧 + <text> 的 N），且顶栏那枚写死 48px
 *      塞进 17px 格子里 → 糊色块 + 撑开行高。
 *   2. `svg .g` 从老项目的金色 `stroke: var(--accent)` 被改成 `opacity:.6`，
 *      **全站 20+ 图标的强调层一起变灰**。
 *
 * 判据纪律：这类"必须并排对比才看得出"的缺陷，纯逻辑单测与typecheck **完全无感**，
 * 唯一能抓的就是真浏览器量尺寸。所以本文件量的是**真实计算样式**，
 * 不是"代码里写了什么"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

test('VIS-01 🔴 顶栏 logo 尺寸必须在 17–27px（写死 48 会糊成一坨并撑开行高）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'v01', 'pw');
  try {
    const box = await page.evaluate(() => {
      const svg = document.querySelector('.ns-mark svg');
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      const mark = document.querySelector('.ns-mark');
      return {
        w: r.width,
        h: r.height,
        markH: mark ? mark.getBoundingClientRect().height : -1,
        topH: document.querySelector('.ns-top')?.getBoundingClientRect().height ?? -1,
      };
    });
    assert.ok(box, '顶栏应有 .ns-mark svg');
    assert.ok(
      box.w >= 16 && box.w <= 28,
      `顶栏 logo 宽应落在 17–27pxclamp 区间，实际 ${box.w}px —— 写死 48 会糊`,
    );
    assert.ok(
      box.h >= 16 && box.h <= 28,
      `顶栏 logo 高应落在 17–27px，实际 ${box.h}px`,
    );
    // 顶栏行高：logo 不该把顶栏撑高（老项目顶栏约 44–52px）
    assert.ok(
      box.topH > 0 && box.topH <= 60,
      `顶栏行高 ${box.topH}px 异常（logo 撑开了？）`,
    );
  } finally {
    await page.close();
  }
});

test('VIS-02 🔴🔴 图标 .g 高亮层必须是金色 accent（被改成 opacity 会全站图标一起变灰）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'v02', 'pw');
  try {
    const probe = await page.evaluate(() => {
      // 🔴 归一化成rgb 再比：`getPropertyValue('--accent')` 返回的是**原始字面量**
      //   （"#8F7126"），而 getComputedStyle().stroke 返回**计算值**
      //   （"rgb(143, 113, 38)"）。两者字符串不等但颜色是同一个 ——
      //   我第一版直接比字符串，判据恒红，**差点把正确的实现当成错的**。
      //   教训：比颜色必须先归一化格式，否则断言在骗你。
      const toRgb = (c) => {
        const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
        if (!m) return c.trim();
        const n = parseInt(m[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      const g = document.querySelector('svg .g');
      if (!g) return null;
      const cs = getComputedStyle(g);
      const root = getComputedStyle(document.documentElement);
      return {
        stroke: toRgb(cs.stroke),
        accent: toRgb(root.getPropertyValue('--accent')),
        rawAccent: root.getPropertyValue('--accent').trim(),
        rawStroke: cs.stroke,
      };
    });
    assert.ok(probe, '页面里应存在带 .g 类的 SVG path');
    // 老项目：`svg .g { stroke: var(--accent) }` —— 计算值应等于当前主题的 --accent
    assert.equal(
      probe.stroke,
      probe.accent,
      `.g 的 stroke 应是金色 accent（${probe.rawAccent}），实际 ${probe.rawStroke} —— 被改成 opacity 就全站图标一起变灰`,
    );
  } finally {
    await page.close();
  }
});

test('VIS-03 🔴 落地页 logo 是固定 48px 且有双弧环+直角尖+path 描边 N', async () => {
  // 落地页是**未解锁**状态，要单独走一遍（openEditor 会跳编辑器）
  const page = await h.browser().newPage();
  try {
    await page.goto(h.baseUrl());
    await page.waitForSelector('.ns-logo', { timeout: 15_000 });
    const info = await page.evaluate(() => {
      const svg = document.querySelector('.ns-logo');
      const r = svg.getBoundingClientRect();
      return {
        w: r.width,
        h: r.height,
        pathCount: svg.querySelectorAll('path').length,
        hasText: !!svg.querySelector('text'),
        hasCircle: !!svg.querySelector('circle'),
      };
    });
    assert.equal(info.hasText, false, 'N 必须是 <path> 描边字形，用 <text> 会随系统字体变形');
    assert.equal(info.hasCircle, false, '老项目 logo 没有闭合 circle，多出来的整圆是另画的');
    // 双弧环 2 + 直角尖 2 + N 1 = 5 条 path
    assert.equal(info.pathCount, 5, `logo 应有 5 条 path（双弧2+直角尖2+N1），实际 ${info.pathCount}`);
    assert.ok(Math.abs(info.w - 48) < 1, `落地页 logo 应为 48px，实际 ${info.w}px`);
    assert.ok(Math.abs(info.h - 48) < 1, `落地页 logo 应为 48px，实际 ${info.h}px`);
  } finally {
    await page.close();
  }
});

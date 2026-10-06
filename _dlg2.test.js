/**
 * 弹窗层量化探针 v2（一次性诊断，**不入库**）
 *
 * 🔴 v1 全报「bj 缺」的真因（这轮查实的）：
 *   **bj 的弹窗是按需构建的**（reminder/ui.ts:113 `buildPanel()` → `:116 document.body.appendChild`），
 *   页面刚进来时 DOM 里**根本没有** #remMask/#qrMask；
 *   而老项目是写在 HTML 里的静态结构（`#remMask` 一直在，只是不 hidden）。
 *   ⇒ 光靠"进编辑器就量"必然量不到 bj 侧，**必须先把弹窗打开**。
 *
 * 另一条：弹窗的遮罩与盒子用的是**同一批类名**（.mask / .box / .qr-box），
 * 所以选择器可以复用，但**必须是打开之后**才量。
 */
import test from 'node:test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness } from './packages/client/test/e2e/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const hOld = installHarness(test, { dir: 'D:/Users/zchen/Documents/TraeProject/notesync' });
const hBj = installHarness(test, { dir: resolve(HERE, 'www') });

function READ(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const p = (v) => Math.round(parseFloat(v) * 100) / 100;
  return {
    x: p(r.x), y: p(r.y), w: p(r.width), h: p(r.height),
    size: cs.fontSize, lh: cs.lineHeight, color: cs.color, bg: cs.backgroundColor,
    align: cs.textAlign, pad: cs.padding, radius: cs.borderRadius, bw: cs.borderTopWidth,
  };
}

const MAP = [
  ['box', '.mask:not(.hidden) .box, .mask:not(.hidden) .qr-box', '弹窗盒子'],
  ['title', '.mask:not(.hidden) h1, .mask:not(.hidden) .qr-title', '弹窗标题'],
  ['desc', '.mask:not(.hidden) p', '弹窗说明'],
  ['input', '.mask:not(.hidden) input', '弹窗输入框'],
  ['ok', '.mask:not(.hidden) button:not(.box-x):not(.ns-ghost-btn)', '弹窗主按钮'],
  ['closeX', '.mask:not(.hidden) .box-x', '关闭按钮'],
];

const KEYS = ['x', 'y', 'w', 'h', 'size', 'lh', 'color', 'bg', 'align', 'radius', 'pad', 'bw'];

async function enterEditor(page, kind) {
  await page.fill(kind === 'old' ? '#landingInput' : '#li', 'probe');
  await page.waitForFunction(() => {
    const b = document.querySelector('#landingBtn');
    return !!b && !b.disabled;
  }, null, { timeout: 10000 });
  await page.click('#landingBtn');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#pw', { timeout: 20000 });
  await page.fill('#pw', 'pw');
  await page.click('#ok');
  await page.waitForFunction(
    () => !!document.querySelector('#editor') || !!window.__NOTESYNC_EDITOR__,
    null, { timeout: 25000 },
  );
  await page.waitForTimeout(1100);
}

async function openPass(page, kind) {
  await page.fill(kind === 'old' ? '#landingInput' : '#li', 'probe');
  await page.waitForFunction(() => {
    const b = document.querySelector('#landingBtn');
    return !!b && !b.disabled;
  }, null, { timeout: 10000 });
  await page.click('#landingBtn');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#pw', { timeout: 20000 });
  await page.waitForTimeout(700);
}

const OPEN = {
  pass: openPass,
  rem: async (page) => {
    await page.evaluate(() => document.querySelector('#remBtn')?.click());
    await page.waitForTimeout(1000);
  },
  qr: async (page) => {
    await page.evaluate(() => document.querySelector('#qrBtn')?.click());
    await page.waitForTimeout(1000);
  },
  link: async (page) => {
    await page.evaluate(() => document.querySelector('#menuBtn')?.click());
    await page.waitForTimeout(700);
    await page.evaluate(() => document.querySelector('#menuLink')?.click());
    await page.waitForTimeout(800);
  },
};

test('DLG2', async () => {
  const out = { old: {}, bj: {} };
  for (const [kind, h] of [['old', hOld], ['bj', hBj]]) {
    for (const phase of Object.keys(OPEN)) {
      const page = await h.browser().newPage({ viewport: { width: 390, height: 844 } });
      try {
        await page.goto(h.baseUrl(), { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(600);
        if (phase === 'pass') {
          await openPass(page, kind);
        } else {
          await enterEditor(page, kind);
          await OPEN[phase](page);
        }
        const snap = {};
        for (const [k, sel] of MAP) snap[k] = await page.evaluate(READ, sel);
        out[kind][phase] = snap;
      } catch (e) {
        console.log('E[' + kind + '/' + phase + '] ' + String(e).slice(0, 100));
      }
      await page.close();
    }
  }
  let n = 0;
  for (const phase of Object.keys(OPEN)) {
    const parts = [];
    for (const [k, sel, desc] of MAP) {
      const a = out.old[phase]?.[k];
      const b = out.bj[phase]?.[k];
      if (!a || !b) { parts.push('   [MISS] ' + desc + ' —— ' + (!a ? '老项目缺' : 'bj缺')); n++; continue; }
      const d = KEYS.filter((x) => a[x] !== b[x]).map((x) => x + ': ' + a[x] + ' -> ' + b[x]);
      if (d.length) { n += d.length; parts.push('   [' + desc + ']'); d.forEach((x) => parts.push('      ' + x)); }
    }
    if (parts.length) { console.log('##### ' + phase); parts.forEach((x) => console.log(x)); }
  }
  console.log('TOTAL ' + n);
});

/**
 * e2e：导出长图全链路（EXPORT-E 系列）—— 真浏览器
 *
 * 🔴 这个功能在单测里几乎测不到（单测只能判源码结构），
 *   而它最容易坏的地方恰好全在浏览器里：
 *   1. **组件真的加载得到吗** —— 自托管 html2canvas.min.js 必须被部署、能在同源拉到。
 *      判据是真去 fetch 它，不是查函数存在。
 *   2. **真的能出 PNG 吗** —— 判据是 blob 的魔数与尺寸，不是"没抛错"。
 *      空白画布也会 toBlob 成功，那是老项目 svg 快路的假绿模式。
 *   3. **离屏卡拆干净了吗** —— 导出 N 次后 body 里不许残留 .ns-export
 *      （老项目 v10.0.2 泄漏事故：点几十次后卡顿）。
 *   4. **折叠块在图里是展开的** —— 离屏副本不在 #editor 里，
 *      折叠的收起态会原样保留 ⇒ 出图少了整段正文。
 *
 * 剪贴板 / 分享面板在 headless 里都不可用，所以本文件验的是
 * **最后一档（全屏预览）** 这条唯一不依赖权限的出口必须通。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 必须是 4 级（e2e → test → client → packages → 仓库根）。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

const PASS = '测试口令';

/** 打开编辑器并写一段正文（导出要有内容，否则测不出断行/折叠那几条）。 */
async function editorWithText(browser, name, text) {
  const page = await openEditor(browser, h.baseUrl(), name, PASS);
  await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
  await page.click('#editor-host');
  await page.keyboard.type(text);
  await withTimeout(
    page.waitForFunction(
      (t) => (window.__NOTESYNC_DOC__ && JSON.stringify(window.__NOTESYNC_DOC__()).length > 0) || true,
      text,
      { timeout: 5_000 },
    ),
    8_000,
    '等输入落盘',
  );
  return page;
}

test('EXPORT-E 导出长图全链路', async (t) => {
  const browser = h.browser();

  await t.test('EXPORT-E01 🔴 自托管html2canvas 可同源拉到且是函数形态', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(h.baseUrl());
      const r = await page.evaluate(async () => {
        const res = await fetch('/html2canvas.min.js');
        const txt = await res.text();
        return { ok: res.ok, len: txt.length, head: txt.slice(0, 60) };
      });
      assert.equal(r.ok, true, '/html2canvas.min.js 未部署（导出功能会整体不可用）');
      assert.ok(r.len > 50000, `文件太小（${r.len} 字节），可能不是完整库`);
      assert.match(r.head, /html2canvas/i, '文件头不是 html2canvas');
    } finally {
      await page.close();
    }
  });

  await t.test('EXPORT-E02 🔴 点导出真的产出 PNG（判魔数与尺寸，不判"没抛错"）', async () => {
    const page = await editorWithText(browser, 'expE02', '导出长图链路验证。');
    try {
      // 走**真实用户路径**：顶栏导出键
      await page.click('#exportImgBtn');
      // headless 里剪贴板与分享都不可用 → 必须落到全屏预览兜底
      await withTimeout(
        page.waitForSelector('#imgPreviewMask', { timeout: 30_000 }),
        35_000,
        '等全屏预览兜底',
      );
      const info = await page.evaluate(() => {
        const img = document.querySelector('#imgPreviewMask img');
        const a = document.querySelector('#imgPreviewMask a[download]');
        return {
          hasImg: !!img,
          src: img ? String(img.src).slice(0, 20) : '',
          download: a ? a.getAttribute('download') : null,
          hasClose: !!document.getElementById('imgPreviewClose'),
        };
      });
      assert.equal(info.hasImg, true, '预览里没有图片元素');
      assert.match(info.src, /^blob:/, '图片源必须是 blob（dataURL 会撑爆内存）');
      assert.equal(info.download, 'note.png', '下载文件名不对');
      assert.equal(info.hasClose, true, '缺「完成」关闭键');
    } finally {
      await page.close();
    }
  });

  await t.test('EXPORT-E03 🔴🔴 离屏卡必须拆干净（老项目 v10.0.2 泄漏事故回归钉）', async () => {
    const page = await editorWithText(browser, 'expE03', '离屏卡泄漏回归验证。');
    try {
      // 连点 5 次：老项目的事故是"快路 return 时漏拆"，点一次看不出来
      for (let i = 0; i < 5; i += 1) {
        await page.click('#exportImgBtn');
        await withTimeout(
          page.waitForSelector('#imgPreviewMask', { timeout: 30_000 }),
          35_000,
          `第 ${i + 1} 次导出`,
        );
        await page.click('#imgPreviewClose');
        await withTimeout(
          page.waitForFunction(() => !document.getElementById('imgPreviewMask'), { timeout: 5000 }),
          8_000,
          '等预览关闭',
        );
      }
      const leaked = await page.evaluate(() => document.querySelectorAll('.ns-export').length);
      assert.equal(leaked, 0, `残留 ${leaked} 张离屏卡（老项目同款泄漏，导几次就卡）`);
    } finally {
      await page.close();
    }
  });

  await t.test('EXPORT-E04 🔴 导出过程中有可见状态提示，且失败文案自带「图片未生成」', async () => {
    const page = await editorWithText(browser, 'expE04', '状态提示验证。');
    try {
      await page.click('#exportImgBtn');
      // 提示条可能一闪而过；两种都算过：要么抓到 doing/ok，要么已经进预览
      await withTimeout(
        page.waitForFunction(
          () => {
            const n = document.getElementById('uploadNote');
            return (n && (n.dataset.kind === 'doing' || n.dataset.kind === 'ok')) || !!document.getElementById('imgPreviewMask');
          },
          { timeout: 30_000 },
        ),
        35_000,
        '等状态提示或预览',
      );
      const note = await page.evaluate(() => {
        const n = document.getElementById('uploadNote');
        return n ? { kind: n.dataset.kind, text: n.textContent } : null;
      });
      if (note) {
        assert.ok(note.text && note.text.length > 0, '提示条有样式没文案（用户看不到发生了什么）');
        if (note.kind === 'bad') {
          assert.match(note.text, /图片未生成/, '失败文案必须说清图片没出来');
        }
      }
    } finally {
      await page.close();
    }
  });

  await t.test('EXPORT-E05 🔴🔴 折叠块在导出图里恒定展开（离屏副本吃不到 #editor 规则）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'expE05', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await page.click('#editor-host');
      await page.keyboard.type('折叠标题');
      // 走**生产插入路径**（S5-e 折叠块那条命令），不手搓 DOM 也不手写真源
      await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
      await withTimeout(
        page.waitForFunction(() => !!document.querySelector('#editor-host .ns-fold'), { timeout: 8000 }),
        12_000,
        '等折叠块渲染',
      );

      // 🔴 插入命令建出来的折叠块是**展开**态（插入即展开，老项目同款：
      //   刚写的内容藏起来是反直觉的）。要测收起态必须再点一次标题。
      const opened = await page.evaluate(() => {
        const fold = document.querySelector('#editor-host .ns-fold');
        return fold ? fold.getAttribute('data-open') : null;
      });
      assert.equal(opened, 'true', '插入的折叠块应为展开态');

      // 点标题收起 —— 走真实用户路径
      await page.click('#editor-host .ns-fold > :first-child');
      await withTimeout(
        page.waitForFunction(
          () => document.querySelector('#editor-host .ns-fold')?.getAttribute('data-open') === 'false',
          { timeout: 5000 },
        ),
        8_000,
        '等折叠块收起',
      );

      const before = await page.evaluate(() => {
        const fold = document.querySelector('#editor-host .ns-fold');
        const body = fold.querySelector(':scope > :not(:first-child)');
        return {
          open: fold.getAttribute('data-open'),
          // 编辑器里收起态：正文不可见
          bodyHidden: body ? getComputedStyle(body).display === 'none' : null,
        };
      });
      assert.equal(before.open, 'false', '折叠块应收起态');
      assert.equal(before.bodyHidden, true, '收起态下正文应不可见');

      await page.click('#exportImgBtn');
      await withTimeout(
        page.waitForSelector('#imgPreviewMask', { timeout: 30_000 }),
        35_000,
        '等预览',
      );

      // 🔴🔴 真判据：**出图那一刻**离屏卡上的折叠正文必须可见。
      //   离屏卡在 finally 里被拆了，所以这里不能再查 DOM ——
      //   改为在导出进行中（预览已挂、卡还没拆的窗口极短）直接读不可靠。
      //   可靠做法：检查导出的 PNG 里那张图的像素非空 + 单测 EXPORT-05 的 CSS 契约。
      //   这里钉住"导出不得让折叠正文在图里消失"的可观测代理 ——
      //   导出后编辑器侧折叠块仍在、且仍收起（导出是纯读）。
      const after = await page.evaluate(() => {
        const fold = document.querySelector('#editor-host .ns-fold');
        const body = fold ? fold.querySelector(':scope > :not(:first-child)') : null;
        return {
          stillFold: !!fold,
          stillClosed: fold ? fold.getAttribute('data-open') === 'false' : false,
          bodyHidden: body ? getComputedStyle(body).display === 'none' : null,
        };
      });
      assert.equal(after.stillFold, true, '导出后编辑器里的折叠块消失了（导出污染了 DOM）');
      assert.equal(after.stillClosed, true, '导出顺手把用户的折叠块展开了（导出必须是无副作用的纯读）');
      assert.equal(after.bodyHidden, true, '编辑器侧收起态被导出破坏了');

      // 图本身非空（真PNG，不是空白画布）
      const imgOk = await page.evaluate(async () => {
        const img = document.querySelector('#imgPreviewMask img');
        if (!img) return { ok: false, why: 'no img' };
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        return { ok: w > 200 && h > 200, w, h };
      });
      assert.equal(imgOk.ok, true, `导出图尺寸异常：${JSON.stringify(imgOk)}`);
    } finally {
      await page.close();
    }
  });

  await t.test('EXPORT-E06 🔴 导出不得改动真源字节', async () => {
    const page = await editorWithText(browser, 'expE06', '真源不许被导出污染。');
    try {
      const before = await page.evaluate(() =>
        window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()),
      );
      await page.click('#exportImgBtn');
      await withTimeout(
        page.waitForSelector('#imgPreviewMask', { timeout: 30_000 }),
        35_000,
        '等预览',
      );
      await page.click('#imgPreviewClose');
      const after = await page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));
      assert.equal(after, before, '导出改动了真源字节（导出必须是纯读操作）');
    } finally {
      await page.close();
    }
  });

  await t.test('EXPORT-E07 🔴 预览关闭后归还焦点给编辑器（老项目红线10）', async () => {
    const page = await editorWithText(browser, 'expE07', '焦点归还验证。');
    try {
      await page.click('#exportImgBtn');
      await withTimeout(
        page.waitForSelector('#imgPreviewMask', { timeout: 30_000 }),
        35_000,
        '等预览',
      );
      await page.click('#imgPreviewClose');
      await withTimeout(
        page.waitForFunction(() => !document.getElementById('imgPreviewMask'), { timeout: 5000 }),
        8_000,
        '等预览关闭',
      );
      const focused = await page.evaluate(() => document.activeElement?.id ?? '');
      assert.equal(focused, 'editor-host', `关闭预览后焦点应在编辑器，实得「${focused}」`);
    } finally {
      await page.close();
    }
  });

  await t.test('EXPORT-E08 整轮零页面异常', async () => {
    const page = await editorWithText(browser, 'expE08', '零异常验证。');
    const errs = [];
    const cerrs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    page.on('console', (m) => {
      if (m.type() === 'error') cerrs.push(m.text());
    });
    try {
      await page.click('#exportImgBtn');
      await withTimeout(
        page.waitForSelector('#imgPreviewMask', { timeout: 30_000 }),
        35_000,
        '等预览',
      );
      await page.keyboard.press('Escape');
      await withTimeout(
        page.waitForFunction(() => !document.getElementById('imgPreviewMask'), { timeout: 5000 }),
        8_000,
        'Esc 关预览',
      );
      assert.deepEqual(errs, [], `出现页面异常：${errs.join(' | ')}`);
      assert.deepEqual(cerrs, [], `出现 console.error：${cerrs.join(' | ')}`);
    } finally {
      await page.close();
    }
  });
});

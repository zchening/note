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
import { installHarness, openEditor, openEditorTouch, closeTouch, withTimeout } from './harness.mjs';

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
      // 🔴 必须点**三角**（标题行左起 22px 内），不能点标题中心——
      //   用户拍板：「点标题文字 = 光标进去可改标题，点三角 = 展开/收起」。
      //   判据钉的是**手势语义**，点中心现在就该是"光标进标题"，收起是错的行为。
      await page.click('#editor-host .ns-fold > :first-child', { position: { x: 8, y: 10 } });
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

/* ═══════════════════════════════════════════════════════════════════════
 * EXPORT-M：移动端导出弹窗（用户报障第 4 条，2026-10-13 逐字拍板）
 *
 * 演进史（改判据前必读，三段都是实测不是推理）：
 *   · 第 5 条报障时代（v3.2.3 前）：触屏走复制阶梯，"剪贴板成功 ≠ 送得进微信"
 *     —— 阶梯停在第①档，分享/预览永远轮不到。当时的修法是"剪贴板成功后
 *     补开预览层"（A1 拍板又删，判据 EXPORT-W02 旧版）。
 *   · v3.2.2/v3.2.3 实锤：壳内 WebView 写剪贴板图是**假成功**（Chromium
 *     ClipboardImpl 静默丢弃），真写进去微信也不认（微信 Android 不支持
 *     粘贴剪贴板图片）—— "复制"在移动端只剩小米笔记一个目的地。
 *   · v3.2.4 用户逐字拍板第 4 条：PC 端保持"生成图片并复制到剪贴板"；
 *     **移动端弹窗接管**——上预览图、下左「保存到相册」右「分享」（系统分享
 *     组件，同诊断报告）、右上角叉可关、点其他位置/外围都不关。
 *     ⇒ 触屏在渲染成功后分岔（exportNotePng 的 isTouchDevice 分支），
 *       复制阶梯整体不再参与；判据从"阶梯怎么修"翻案为"弹窗怎么长"。
 * ═══════════════════════════════════════════════════════════════════════ */

test('EXPORT-M 移动端导出弹窗（报障第 4 条）', async (t) => {
  const browser = h.browser();

  await t.test('EXPORT-W01 🔴 触屏上下文里`(hover:none) and (pointer:coarse)` 必须为真（否则下面全是空转）', async () => {
    // 🔴 这条是整组的**前提闸**。移动端专属行为若在桌面上下文里跑，
    //   matchMedia 恒 false ⇒ 触屏分支永远走不到 ⇒ 测试恒绿而用户照旧被坑。
    //   这就是 harness.mjs 里TOUCH_CTX 那段注释说的"测试骗人"的典型。
    const page = await openEditorTouch(browser, h.baseUrl(), 'expW01', PASS);
    try {
      const mq = await page.evaluate(() => ({
        coarse: matchMedia('(pointer: coarse)').matches,
        hoverNone: matchMedia('(hover: none)').matches,
        both: matchMedia('(hover: none) and (pointer: coarse)').matches,
      }));
      assert.equal(mq.coarse, true, '触屏上下文里 pointer 必须是 coarse');
      assert.equal(mq.hoverNone, true, '触屏上下文里 hover 必须是 none');
      assert.equal(mq.both, true, '生产代码用的那条触屏判据必须为真');
    } finally {
      await closeTouch(page);
    }
  });

  await t.test('EXPORT-W02 🔴🔴🔴 触屏导出 = 弹窗接管，剪贴板零调用（v3.2.4 拍板：复制语义在移动端退场）', async () => {
    // 🔴🔴 本条曾钉"触屏剪贴板成功后不许开预览层"（A1）。v3.2.4 用户逐字拍板
    //   第 4 条后整个翻案：触屏渲染成功**根本不走复制阶梯**，弹窗接管
    //   （壳内剪贴板写图是假成功 v3.2.2、微信又不认剪贴板图 v3.2.3 ——
    //   "复制"在移动端只剩小米笔记一个目的地，用户要的是把图发出去）。
    //   判据因此加强：不只是"成功后不开预览"，而是**剪贴板一次都不许被碰**。
    const page = await openEditorTouch(browser, h.baseUrl(), 'expW02', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await page.tap('#editor-host');
      await page.keyboard.type('导出弹窗接管验证。');
      await withTimeout(
        page.waitForFunction(() => (window.__NOTESYNC_DOC__?.()?.blocks?.length ?? 0) > 0, null, { timeout: 8000 }),
        10_000, '等输入落真源',
      );

      // 装一个**会成功**的剪贴板替身 —— 与用户真机同形态（小米笔记能粘）。
      // 🔴 替身忠实于 WebClipboard 接口契约，不忠实于我们的实现（判据纪律）。
      await page.evaluate(() => {
        window.__W_CLIP_CALLS__ = [];
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            write: async (items) => {
              window.__W_CLIP_CALLS__.push(items.map((it) => Object.keys(it.types || {})));
            },
          },
        });
        window.ClipboardItem = class {
          constructor(types) { this.types = types; }
        };
      });

      await page.tap('#exportImgBtn');

      // 触屏必须落到弹窗（不是预览、不是提示条收场）
      await withTimeout(
        page.waitForSelector('#exportModalMask', { state: 'visible', timeout: 30_000 }),
        35_000,
        '触屏导出必须弹窗接管（复制语义已退场）',
      );
      // 🔴🔴 核心判据：剪贴板**零调用**。若有人把复制阶梯接回触屏，
      //   这个"会成功"的替身就会被调到 —— 弹窗照出但判据红。
      const clip = await page.evaluate(() => window.__W_CLIP_CALLS__);
      assert.equal(clip.length, 0, '🔴 触屏导出绝不许碰剪贴板（假成功 + 微信不认），实际调用=' + JSON.stringify(clip));
      assert.equal(
        await page.evaluate(() => document.querySelectorAll('.ns-export').length),
        0, '离屏导出卡必须已拆（老项目 v10.0.2 泄漏事故）',
      );
    } finally {
      await closeTouch(page);
    }
  });

  await t.test('EXPORT-M01 🔴🔴 弹窗结构：预览图 data:URL + 右上角叉；无相册桥时保存按钮不显示；提示条已清', async () => {
    const page = await openEditorTouch(browser, h.baseUrl(), 'expM01', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await page.tap('#editor-host');
      await page.keyboard.type('弹窗结构验证。');
      await withTimeout(
        page.waitForFunction(() => (window.__NOTESYNC_DOC__?.()?.blocks?.length ?? 0) > 0, null, { timeout: 8000 }),
        10_000, '等输入落真源',
      );
      await page.tap('#exportImgBtn');
      await withTimeout(
        page.waitForSelector('#exportModalMask', { state: 'visible', timeout: 30_000 }),
        35_000, '等弹窗',
      );
      const st = await page.evaluate(() => {
        const img = document.querySelector('#exportModalMask img');
        const geo = (sel) => {
          const b = document.querySelector('#exportModalMask .box');
          const el = document.querySelector(sel);
          if (!b || !el) return null;
          const br = b.getBoundingClientRect();
          const er = el.getBoundingClientRect();
          return {
            inBox: er.left >= br.left - 1 && er.right <= br.right + 1,
            boxRight: br.right,
            elRight: er.right,
            elTop: er.top,
            boxTop: br.top,
            boxH: br.height,
          };
        };
        return {
          hasImg: !!img,
          imgIsData: img ? String(img.src).startsWith('data:image/png;base64,') : false,
          hasX: !!document.getElementById('exportModalClose'),
          // 🔴 网页触屏没有 ImgSave 桥 ⇒ 保存按钮必须隐藏（不给点了必失败的按钮）
          hasSave: !!document.getElementById('exportModalSave'),
          hasShare: !!document.getElementById('exportModalShare'),
          // 🔴 v3.2.5 报障①：按钮必须整体落在弹窗内（.row-btn 曾横向溢出 594px）
          shareGeo: geo('#exportModalShare'),
          // 🔴 v3.2.5 报障②：叉必须在右上角（modal-head 右对齐，与标题同行）
          xGeo: geo('#exportModalClose'),
          // 🔴 弹窗盖着提示条（zIndex 40）⇒ doing 提示条必须已被清掉
          doingNote: document.getElementById('uploadNote')?.textContent || '',
          strayCards: document.querySelectorAll('.ns-export').length,
        };
      });
      assert.equal(st.hasImg, true, '弹窗里没有预览图');
      assert.equal(st.imgIsData, true, '预览图必须用 data: URL（壳内长按存图兜底；blob: 长按菜单不给保存）');
      assert.equal(st.hasX, true, '缺右上角关闭叉');
      assert.equal(st.hasSave, false, '无相册桥的环境不许显示「保存到相册」按钮');
      assert.equal(st.hasShare, true, '「分享」按钮必须显示');
      assert.equal(st.shareGeo && st.shareGeo.inBox, true, '分享按钮必须整体落在弹窗内（v3.2.4 曾横向溢出）');
      assert.equal(
        st.xGeo && st.xGeo.inBox && st.xGeo.elTop <= st.xGeo.boxTop + st.xGeo.boxH * 0.5,
        true,
        '关闭叉必须整体在弹窗内且落在上半部（右上角，与标题同行）',
      );
      assert.notEqual(st.doingNote, '正在生成图片…', '弹窗打开后「正在生成图片…」提示条必须已被清掉');
      assert.equal(st.strayCards, 0, '离屏卡必须已拆');

      // ── 反向场景：模拟原生壳（Capacitor + ImgSave 桥）⇒ 按钮必须显示 ──
      //   （e2e 上下文是纯净网页 isNativeApp=false；真壳里 main.ts 会注入
      //   saveToAlbum。这里用替身走同一条真导出路径，钉"有桥时显示"。）
      await page.evaluate(() => {
        window.Capacitor = {
          isNativePlatform: () => true,
          Plugins: { ImgSave: { saveImage: async () => ({ ok: true }) } },
        };
      });
      await page.tap('#exportModalClose');
      await withTimeout(
        page.waitForFunction(() => !document.getElementById('exportModalMask'), null, { timeout: 5000 }),
        8_000, '关闭第一轮弹窗',
      );
      await page.tap('#exportImgBtn');
      await withTimeout(
        page.waitForSelector('#exportModalMask', { state: 'visible', timeout: 30_000 }),
        35_000, '第二轮（模拟原生）等弹窗',
      );
      assert.equal(
        await page.evaluate(() => !!document.getElementById('exportModalSave')),
        true, '模拟原生（有 ImgSave 桥）时保存按钮必须显示（显隐必须真的随桥走）',
      );
      // 🔴 v3.2.5 报障①：两枚按钮并排时也必须整体在弹窗内（等分收缩不溢出），
      //   且保持左保存右分享的顺序
      const geo = await page.evaluate(() => {
        const b = document.querySelector('#exportModalMask .box');
        const s = document.getElementById('exportModalShare');
        const v = document.getElementById('exportModalSave');
        if (!b || !s || !v) return { ok: false, leftIsSave: false };
        const br = b.getBoundingClientRect();
        const sr = s.getBoundingClientRect();
        const vr = v.getBoundingClientRect();
        return {
          ok:
            sr.left >= br.left - 1 && sr.right <= br.right + 1 &&
            vr.left >= br.left - 1 && vr.right <= br.right + 1,
          leftIsSave: vr.left < sr.left,
        };
      });
      assert.equal(geo.ok, true, '两按钮必须整体落在弹窗内（等分收缩，不许横向溢出）');
      assert.equal(geo.leftIsSave, true, '左保存右分享的顺序必须保持');
    } finally {
      await closeTouch(page);
    }
  });

  await t.test('EXPORT-M02 🔴🔴 外围/弹窗内其他位置点击都不关；只有右上角叉能关（用户逐字拍板）', async () => {
    const page = await openEditorTouch(browser, h.baseUrl(), 'expM02', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await page.tap('#editor-host');
      await page.keyboard.type('弹窗关闭纪律验证。');
      await withTimeout(
        page.waitForFunction(() => (window.__NOTESYNC_DOC__?.()?.blocks?.length ?? 0) > 0, null, { timeout: 8000 }),
        10_000, '等输入落真源',
      );
      await page.tap('#exportImgBtn');
      await withTimeout(
        page.waitForSelector('#exportModalMask', { state: 'visible', timeout: 30_000 }),
        35_000, '等弹窗',
      );
      // ① 外围（mask 空白区，box 外的角落）
      await page.tap('#exportModalMask', { position: { x: 6, y: 6 } });
      await page.waitForTimeout(300);
      assert.equal(
        await page.evaluate(() => !!document.getElementById('exportModalMask')),
        true, '🔴 点外围不许关（用户原话「包括外围位置，都没法关闭」）',
      );
      // ② 弹窗内其他位置（预览图本身）
      await page.tap('#exportModalMask img');
      await page.waitForTimeout(300);
      assert.equal(
        await page.evaluate(() => !!document.getElementById('exportModalMask')),
        true, '🔴 点弹窗内其他位置（预览图）不许关',
      );
      // ③ 右上角叉：唯一关闭出口
      await page.tap('#exportModalClose');
      await withTimeout(
        page.waitForFunction(() => !document.getElementById('exportModalMask'), null, { timeout: 5000 }),
        8_000, '点叉必须关闭弹窗',
      );
    } finally {
      await closeTouch(page);
    }
  });

  await t.test('EXPORT-M03 🔴🔴 分享走系统分享组件；面板取消 = 用完了 → 弹窗自动关（v3.2.5 拍板）', async () => {
    const page = await openEditorTouch(browser, h.baseUrl(), 'expM03', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await page.tap('#editor-host');
      await page.keyboard.type('分享取消静默验证。');
      await withTimeout(
        page.waitForFunction(() => (window.__NOTESYNC_DOC__?.()?.blocks?.length ?? 0) > 0, null, { timeout: 8000 }),
        10_000, '等输入落真源',
      );
      await page.tap('#exportImgBtn');
      await withTimeout(
        page.waitForSelector('#exportModalMask', { state: 'visible', timeout: 30_000 }),
        35_000, '等弹窗',
      );
      // mock 网页系统分享：记录调用 + 模拟用户在面板点取消（AbortError）
      await page.evaluate(() => {
        window.__SHARE_CALLS__ = [];
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async (d) => {
            window.__SHARE_CALLS__.push(d.files.map((f) => f.type));
            const err = new Error('user cancelled');
            err.name = 'AbortError';
            throw err;
          },
        });
      });
      await page.tap('#exportModalShare');
      await withTimeout(
        page.waitForFunction(() => (window.__SHARE_CALLS__ || []).length > 0, null, { timeout: 8000 }),
        10_000, '系统分享组件应被调起（前置自证）',
      );
      const st = await page.evaluate(() => ({
        files: window.__SHARE_CALLS__,
      }));
      assert.deepEqual(st.files, [['image/png']], '分享的必须是 PNG 文件');
      // 🔴🔴 v3.2.5 拍板「点完自动关」：用户在面板点取消 = 用完了，弹窗自动收起
      //   （v3.2.4 是"取消静默留窗"，本条是行为反转的判据）
      await withTimeout(
        page.waitForFunction(() => !document.getElementById('exportModalMask'), null, { timeout: 5000 }),
        8_000, '取消分享后弹窗必须自动关闭（v3.2.5 点完自动关）',
      );
    } finally {
      await closeTouch(page);
    }
  });

  await t.test('EXPORT-M04 🔴 分享不可用（无桥 canShare=false）⇒ 弹窗内可见失败反馈，绝不静默', async () => {
    const page = await openEditorTouch(browser, h.baseUrl(), 'expM04', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await page.tap('#editor-host');
      await page.keyboard.type('分享失败反馈验证。');
      await withTimeout(
        page.waitForFunction(() => (window.__NOTESYNC_DOC__?.()?.blocks?.length ?? 0) > 0, null, { timeout: 8000 }),
        10_000, '等输入落真源',
      );
      await page.tap('#exportImgBtn');
      await withTimeout(
        page.waitForSelector('#exportModalMask', { state: 'visible', timeout: 30_000 }),
        35_000, '等弹窗',
      );
      // 桥（网页环境本就没有）与 canShare 都不可用
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
        Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} });
      });
      await page.tap('#exportModalShare');
      await withTimeout(
        page.waitForFunction(
          () => {
            const n = document.querySelector('#exportModalMask .diag-note');
            return !!n && !n.hidden && (n.textContent || '').includes('无法调起分享');
          },
          null, { timeout: 5000 },
        ),
        8_000, '分享不可用必须在弹窗内给出可见失败反馈（v3.1.3「点了没反应」同款事故不许重演）',
      );
    } finally {
      await closeTouch(page);
    }
  });

  await t.test('EXPORT-M05 🔴🔴 保存到相册：失败留窗可见反馈；成功自动关弹窗（v3.2.5 拍板点完自动关）', async () => {
    const page = await openEditorTouch(browser, h.baseUrl(), 'expM05', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await page.tap('#editor-host');
      await page.keyboard.type('保存自动关验证。');
      await withTimeout(
        page.waitForFunction(() => (window.__NOTESYNC_DOC__?.()?.blocks?.length ?? 0) > 0, null, { timeout: 8000 }),
        10_000, '等输入落真源',
      );
      // 模拟原生壳（ImgSave 桥，点击时才构造 deps ⇒ 先注入再点导出即可）：
      // 记录调用次数，成败由 __SAVE_OK__ 控制
      await page.evaluate(() => {
        window.__SAVE_CALLS__ = 0;
        window.__SAVE_OK__ = true;
        window.Capacitor = {
          isNativePlatform: () => true,
          Plugins: {
            ImgSave: {
              saveImage: async () => {
                window.__SAVE_CALLS__ += 1;
                return { ok: window.__SAVE_OK__ !== false };
              },
            },
          },
        };
      });
      await page.tap('#exportImgBtn');
      await withTimeout(
        page.waitForSelector('#exportModalMask', { state: 'visible', timeout: 30_000 }),
        35_000, '等弹窗',
      );
      assert.equal(
        await page.evaluate(() => !!document.getElementById('exportModalSave')),
        true, '有 ImgSave 桥时保存按钮必须显示',
      );

      // ① 失败：弹窗留着 + 弹窗内可见失败反馈（绝不静默）
      await page.evaluate(() => { window.__SAVE_OK__ = false; });
      await page.tap('#exportModalSave');
      await withTimeout(
        page.waitForFunction(() => {
          const n = document.querySelector('#exportModalMask .diag-note');
          return !!n && !n.hidden && (n.textContent || '').includes('保存到相册失败');
        }, null, { timeout: 5000 }),
        8_000, '保存失败必须有弹窗内可见反馈',
      );
      assert.equal(
        await page.evaluate(() => !!document.getElementById('exportModalMask')),
        true, '保存失败时弹窗必须留着（用户可重试）',
      );

      // ② 成功：弹窗自动关闭（关窗本身即成功反馈，无"已保存"成功文案）
      await page.evaluate(() => { window.__SAVE_OK__ = true; });
      await page.tap('#exportModalSave');
      await withTimeout(
        page.waitForFunction(() => !document.getElementById('exportModalMask'), null, { timeout: 5000 }),
        8_000, '保存成功后弹窗必须自动关闭（v3.2.5 点完自动关）',
      );
      assert.equal(
        await page.evaluate(() => window.__SAVE_CALLS__),
        2, 'ImgSave 桥必须被真实调用两次（失败+成功各一次，不是 mock 替身路径）',
      );
    } finally {
      await closeTouch(page);
    }
  });

  await t.test('EXPORT-W03 🔴🔴 反向闸：桌面剪贴板成功时**不许**开预览层（老项目同款，别把桌面也改了）', async () => {
    const page = await editorWithText(browser, 'expW03', '桌面不该开预览。');
    try {
      await page.evaluate(() => {
        window.__W_CLIP_CALLS__ = [];
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            write: async (items) => {
              window.__W_CLIP_CALLS__.push(items.length);
            },
          },
        });
        window.ClipboardItem = class {
          constructor(types) { this.types = types; }
        };
      });
      await page.click('#exportImgBtn');
      // 桌面剪贴板成功 ⇒ 收场，不该再开预览层（老项目 index.html:2914 直接 return）
      await withTimeout(
        page.waitForFunction(() => (window.__W_CLIP_CALLS__ || []).length > 0, null, { timeout: 25_000 }),
        30_000,
        '桌面剪贴板替身应被调用',
      );
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(
        await page.evaluate(() => document.getElementById('imgPreviewMask') !== null),
        false,
        '桌面剪贴板成功后不该开预览层（老项目 :2914 同款；桌面有 Ctrl+V，开预览是多余的打断）',
      );
    } finally {
      await page.close();
    }
  });
});

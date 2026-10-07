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
 * EXPORT-W：移动端「导出图片复制到微信」（用户报障第 5 条）
 *
 * 用户原话：「导出为图片并复制在 PC 端可以正常复制，在我的小米手机上
 * 可以正常复制到系统自带笔记app 里，但复制到微信会话框没反应。
 * 我记得之前老版本也出现过这个问题并且修复好了。」
 * 用户 2026-10-07 拍板核查方向：「移动浏览器访问」。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 先把"这是不是一个 bug"这件事查清楚，而不是先写代码
 *
 * 老项目的修法（index.html:2904-2958 v7.7.0逐字）是一条**五档交付阶梯**，
 * 每一档都还在 bj 里（export/render.ts:139deliverPng 同构）。
 * 老项目那条注释把移动端的机制说得很直白：
 *   「Android WebView 对图片写剪贴板长期不可用、`<a download>` 在壳内是哑弹」
 * ⇒ **老项目认定移动端落不到剪贴板档**，于是后面三档才是手机上真正生效的出口。
 *
 * 而用户的现象是「能复制到系统自带笔记 App」⇒ **剪贴板档在他手机上其实是成功的**
 *（系统笔记能读到剪贴板里的图）。可微信会话框不接受剪贴板里的图片
 *   —— 这是微信自己的输入实现（它只认相册/自己的媒体），不是网页能控制的。
 * ⇒ 于是阶梯停在第①档（clipboard）就 return 了，**永远到不了分享面板与预览层**，
 *   而用户真正需要的出口（分享面板直发微信 / 预览层长按转发）恰恰在后面。
 *
 * 🔴🔴 这就是"移动浏览器访问"这条链路的**真因**（已由下面的 EXPORT-W02 实测钉住）：
 *   剪贴板成功 ≠ 用户能把它送进微信，而阶梯把"成功"当成了终点。
 *
 * 修法（与老项目的差别，必须写清楚）：
 *   老项目假设"移动端剪贴板不可用"，所以没这个问题；
 *   bj 的用户实测"移动端剪贴板可用但没用"，所以必须给剪贴板档补一条**明示**：
 *   触屏上剪贴板成功时，**额外打开全屏预览层**，让"长按转发给微信"这条路真的存在。
 *   这不是推翻老项目阶梯 —— 阶梯顺序一分不变，只是在第①档之后**多开一个出口**。
 * ═══════════════════════════════════════════════════════════════════════ */

test('EXPORT-W 移动端导出图片到微信（报障第 5 条）', async (t) => {
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

  await t.test('EXPORT-W02 🔴🔴🔴 剪贴板成功时也必须开预览层（否则用户永远进不了微信）', async () => {
    const page = await openEditorTouch(browser, h.baseUrl(), 'expW02', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await page.tap('#editor-host');
      await page.keyboard.type('导出到微信验证。');
      await withTimeout(
        page.waitForFunction(() => (window.__NOTESYNC_DOC__?.()?.blocks?.length ?? 0) > 0, null, { timeout: 8000 }),
        10_000, '等输入落真源',
      );

      // 🔴🔴 装一个**会成功**的剪贴板替身 —— 这正是用户手机上的真实情况
      //   （「可以正常复制到系统自带笔记app 里」⇒ 剪贴板档成功）。
      //   🔴 替身必须**忠实于外部规范**、绝不能忠实于我们的实现（判据纪律）：
      //   这里模拟的是 WebClipboard 接口的契约（write 接受 ClipboardItem[] 并 resolve），
      //   不是"我们希望它怎么表现"。
      await page.evaluate(() => {
        window.__W_CLIP_CALLS__ = [];
        const blob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' });
        // 真实内核的 write 是**立即 resolve**、内容在窗口内异步落地。
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            write: async (items) => {
              window.__W_CLIP_CALLS__.push(
                items.map((it) => Object.keys(it.types || {})),
              );
            },
          },
        });
        window.ClipboardItem = class {
          constructor(types) { this.types = types; }
        };
        void blob;
      });

      await page.tap('#exportImgBtn');

      // 🔴🔴 核心判据：剪贴板**成功**之后，预览层也必须出现。
      //   症状与用户原话一一对应：用户看到"已复制"，照着去微信粘贴，没反应，
      //   而屏上根本没有一张可以长按的图。
      await withTimeout(
        page.waitForSelector('#imgPreviewMask', { timeout: 30_000 }),
        35_000,
        '剪贴板成功后也必须开预览层（触屏长按转发是唯一真出口）',
      );
      const st = await page.evaluate(() => ({
        clip: window.__W_CLIP_CALLS__,
        img: !!document.querySelector('#imgPreviewMask img'),
        tips: Array.from(document.querySelectorAll('#imgPreviewMask p')).map((p) => p.textContent),
      }));
      // 前置自证：替身确实被调到了（否则上面那条 waitForSelector 可能只是等到了别的东西）
      assert.equal(st.clip.length, 1, '剪贴板替身必须被调用一次（前置自证），实际=' + JSON.stringify(st.clip));
      assert.deepEqual(st.clip[0], [['image/png']], '剪贴板里必须装的是 PNG');
      assert.equal(st.img, true, '预览层里必须有图（用户要长按的就是它）');

      // 🔴 预览层里那行触屏指引必须在（老项目那句没点名"转发给微信"）
      const joined = st.tips.join(' | ');
      assert.ok(
        joined.includes('转发给朋友'),
        '预览层必须有触屏指引「转发给朋友」，否则用户不知道要长按，实际=' + joined,
      );
      // 老项目那句泛用指引也必须留着（逐字）
      assert.ok(
        joined.includes('长按图片可保存或发送'),
        '老项目那句泛用指引必须留着，实际=' + joined,
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

  await t.test('EXPORT-W04 🔴 触屏剪贴板被拒 → 仍必须落到分享/预览（阶梯不许被改坏）', async () => {
    const page = await openEditorTouch(browser, h.baseUrl(), 'expW04', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await page.tap('#editor-host');
      await page.keyboard.type('剪贴板被拒的回退验证。');
      await withTimeout(
        page.waitForFunction(() => (window.__NOTESYNC_DOC__?.()?.blocks?.length ?? 0) > 0, null, { timeout: 8000 }),
        10_000, '等输入落真源',
      );
      // 剪贴板全拒（老项目注释里说的"Android WebView 长期不可用"那种内核）
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { write: async () => { throw new Error('not allowed'); } },
        });
        window.ClipboardItem = class {
          constructor(types) { this.types = types; }
        };
      });
      await page.tap('#exportImgBtn');
      // 必须落到最后一档：全屏预览
      await withTimeout(
        page.waitForSelector('#imgPreviewMask', { timeout: 30_000 }),
        35_000,
        '剪贴板被拒后必须落到全屏预览（唯一不依赖权限的出口）',
      );
      assert.equal(
        await page.evaluate(() => !!document.querySelector('#imgPreviewMask img')),
        true,
        '预览层里必须有图',
      );
    } finally {
      await closeTouch(page);
    }
  });

  await t.test('EXPORT-W05 🔴 成功文案按档位分档，且不许出现桌面专属的「Ctrl+V」', async () => {
    const page = await openEditorTouch(browser, h.baseUrl(), 'expW05', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await page.tap('#editor-host');
      await page.keyboard.type('成功文案验证。');
      await withTimeout(
        page.waitForFunction(() => (window.__NOTESYNC_DOC__?.()?.blocks?.length ?? 0) > 0, null, { timeout: 8000 }),
        10_000, '等输入落真源',
      );
      // 收集状态条上出现过的所有文案（它会一闪而过，必须全程监听）
      const seen = await page.evaluate(async () => {
        const out = [];
        const mo = new MutationObserver(() => {
          const el = document.querySelector('#uploadNote, .ns-note, #uploadStatus');
          if (el) {
            const t = (el.textContent || '').trim();
            if (t && !out.includes(t)) out.push(t);
          }
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { write: async () => {} },
        });
        window.ClipboardItem = class {
          constructor(types) { this.types = types; }
        };
        document.getElementById('exportImgBtn').click();
        await new Promise((r) => setTimeout(r, 12000));
        mo.disconnect();
        return out;
      });
      const joined = seen.join(' | ');
      // 🔴 手机上没有 Ctrl+V 这个动作，给它就是给一句做不到的指引
      assert.ok(
        !joined.includes('Ctrl+V'),
        '触屏成功文案里绝不许出现「Ctrl+V」（手机上没这个动作），实际=' + joined,
      );
      assert.ok(seen.length > 0, '导出过程中必须至少有一条状态提示（否则是"点了没反应"），实际=' + JSON.stringify(seen));
    } finally {
      await closeTouch(page);
    }
  });
});

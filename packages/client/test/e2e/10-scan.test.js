/**
 * e2e：扫码配对全链路（SCAN-E 系列）—— 真浏览器
 *
 * 🔴 这个功能的单测只能判纯逻辑（编解码、裁剪、降级判据），
 *   而它最容易坏的地方全在浏览器里：
 *   1. **vendor 库真的同源加载得到吗** —— jsQR / qrcode-generator 必须部署到位。
 *      判据是真去 fetch 并检查形态，不是查函数存在（本机 www/ 里有不代表线上有，
 *      这正是 S6 修过的缺口：html2canvas 曾只存在于本机，CI 产物残缺）。
 *   2. **出码真的画出东西了吗** —— 判据是 canvas 的非白像素数，
 *      不是"没抛错"（白画布也是画布）。
 *   3. **配对链接能被自己解析回来吗** —— 判据用**生产解析器**跑一遍，
 *      造一份第二份实现去判会得到假绿。
 *   4. **摄像头起不来时给的是人话吗** —— headless 没摄像头，
 *      这恰好是"相机起不来"这条分支的天然测试环境。
 *   5. **出码浮层的 Esc 与 document 监听** —— 残留监听会在关掉后继续劫持按键。
 *
 * 取景层本身（真实解码）无法在 headless 验证 —— 没有摄像头画面。
 * 判据因此落在**可验证的边界**上：浮层建得起来、状态行说人话、
 * 取消能收口（流与监听都清干净）、自检数据挂在正式接口上。
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

/** 判一块 canvas 上有多少非白像素（真出过码 vs 白画布的唯一可靠区别）。 */
const nonWhitePixels = (page, sel) =>
  page.evaluate((s) => {
    const cv = document.querySelector(s);
    if (!cv) return -1;
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
    }
    return n;
  }, sel);

test('SCAN-E 扫码配对全链路', async (t) => {
  const browser = h.browser();

  await t.test('SCAN-E01 🔴 两个 vendor 库都同源加载得到且形态正确', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(h.baseUrl());
      const r = await page.evaluate(async () => {
        const out = {};
        for (const [k, path, want] of [
          ['jsqr', '/jsQR.js', 'jsQR'],
          ['qrc', '/qrcode-generator.js', 'qrcode'],
        ]) {
          const res = await fetch(path);
          const txt = await res.text();
          out[k] = { status: res.status, len: txt.length, hasGlobal: txt.includes(want) };
        }
        return out;
      });
      // 🔴 判据是真 fetch + 看体积与全局名，不是在 page 里 eval 一下了事
      //   —— 后者在"文件 404 但 HTML 回落成首页"时会假绿（www 静态服务器
      //   对未知路径回 index.html，于是 fetch 200 + 一堆 HTML + 找不到 jsQR）。
      assert.equal(r.jsqr.status, 200);
      assert.ok(r.jsqr.len > 50000, 'jsQR.js 体积异常小（可能被回落成 index.html）：' + r.jsqr.len);
      assert.ok(r.jsqr.hasGlobal, 'jsQR.js 里找不到 jsQR 符号');
      assert.equal(r.qrc.status, 200);
      assert.ok(r.qrc.len > 10000, 'qrcode-generator.js 体积异常小：' + r.qrc.len);
      assert.ok(r.qrc.hasGlobal, 'qrcode-generator.js 里找不到 qrcode 符号');
    } finally {
      await page.close();
    }
  });

  await t.test('SCAN-E02 🔴 出码画布真有码（判非白像素，不判没抛错）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'scanq1', PASS);
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    try {
      await page.click('#qrBtn');
      await withTimeout(page.waitForSelector('#qrCanvas', { timeout: 15_000 }), 18_000, '等出码');

      const n = await nonWhitePixels(page, '#qrCanvas');
      // 🔴 白画布也是画布：只判"没抛错"会让"qrcode 加载了但 make() 静默失败"假绿。
      //   2000 个黑像素是"至少画了个定位图案"的下限。
      assert.ok(n > 2000, '二维码画布几乎是空白（黑像素 ' + n + '）');

      // 静区：最外一圈必须全白。缺静区时摄像头定位失败率极高，
      //   症状是"我这台扫得出、那台扫半天没反应"（老项目 v7.5.1）。
      const quiet = await page.evaluate(() => {
        const cv = document.querySelector('#qrCanvas');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let dark = 0;
        const band = Math.max(2, Math.floor(cv.width * 0.02));
        for (let y = 0; y < band; y++) {
          for (let x = 0; x < cv.width; x++) {
            const i = (y * cv.width + x) * 4;
            if (d[i] < 128) dark++;
          }
        }
        for (let y = cv.height - band; y < cv.height; y++) {
          for (let x = 0; x < cv.width; x++) {
            const i = (y * cv.width + x) * 4;
            if (d[i] < 128) dark++;
          }
        }
        return dark;
      });
      assert.equal(quiet, 0, '二维码上下静区被吃了（暗像素 ' + quiet + '）');
      assert.deepEqual(errs, [], '出码过程有页面错误');
    } finally {
      await page.close();
    }
  });

  await t.test('SCAN-E03 🔴 解析器口径由生产实现把守（不测第二条实现）', async () => {
    // 🔴🔴 判据必须用**生产解析器**（__NOTESYNC_PARSE_PAIR__），
    //   绝不在测试里手写一份 URL 解析 —— origin 归一 / fragment 边界 /
    //   base64url padding 三处最容易分叉，而分叉只在真机上偶发
    //   （与 __NOTESYNC_CANON__ 拒绝"手写第二份 canonical"同源纪律）。
    //
    // 🔴 为什么这里不验"出码 → 扫码"的完整往返：
    //   那个往返需要摄像头（headless 没有），而链接的**内容**生产代码刻意
    //   不挂到 window（挂了就等于把口令开成一个可读的窗口）。
    //   所以分工是：链接形态与编解码由单测 PAIR-01/02/03/09 用真函数钉死，
    //   e2e 这一条钉的是"生产环境里解析器在、且四条关键拒答口径正确"。
    const page = await openEditor(browser, h.baseUrl(), 'scanq2', PASS);
    try {
      await page.click('#qrBtn');
      await withTimeout(page.waitForSelector('#qrCanvas', { timeout: 15_000 }), 18_000, '等出码');

      const r = await page.evaluate((origin) => {
        const fn = window.__NOTESYNC_PARSE_PAIR__;
        if (typeof fn !== 'function') return { noHook: true };
        const enc = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return {
          good: fn(origin + '/scanq2#p=' + enc('pw')),
          // 异域必须拒 —— 开放重定向防线
          evil: fn('https://evil.example.com/scanq2#p=' + enc('pw')),
          // 老项目的 #k= 密钥码必须拒：那是**另一把钥匙的字节**，
          //   当口令喂进 PBKDF2 只会得到「口令不对」，用户想不到真正原因。
          oldKey: fn(origin + '/scanq2#k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
          // 无载荷必须拒（那是"扫到一张普通链接"）
          empty: fn(origin + '/scanq2'),
        };
      }, await page.evaluate(() => location.origin));

      assert.equal(r.noHook, undefined, '生产解析器钩子未挂上');
      assert.equal(r.good.ok, true, '同源合法链接应解得开：' + JSON.stringify(r.good));
      assert.equal(r.good.noteId, 'scanq2');
      // 只回显长度不回显口令 —— 钩子不能变成"打印口令到控制台"的入口
      assert.equal(r.good.passLen, 2, '应回显口令长度');
      assert.equal(JSON.stringify(r.good).includes('pw"'), false, '不得回显口令本身');
      assert.equal(r.evil.ok, false, '异域必须拒');
      assert.equal(r.oldKey.ok, false, '老项目 #k= 密钥码必须拒');
      assert.equal(r.empty.ok, false, '无载荷必须拒');
    } finally {
      await page.close();
    }
  });

  await t.test('SCAN-E04 🔴 Esc 能关出码浮层，点码可全屏放大', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'scanq3', PASS);
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    try {
      await page.click('#qrBtn');
      await withTimeout(page.waitForSelector('#pairMask', { timeout: 15_000 }), 18_000, '等浮层');
      assert.ok(await page.$('#pairMask'), '出码浮层未挂上');

      // 点码 → 全屏放大（老项目 v7.5.1：反光/夜里对拍，260px 小码物理上扫不出）
      await page.click('#qrCanvas');
      await withTimeout(page.waitForSelector('#qrLarge.show', { timeout: 5_000 }), 8_000, '等放大层');
      const largeDark = await nonWhitePixels(page, '#qrLarge canvas');
      assert.ok(largeDark > 2000, '放大层码是空白的（黑像素 ' + largeDark + '）');
      // 🔴 放大态按 DPR 取设备像素，位图宽度必须 ≥480（低于此识别率断崖）
      const largeW = await page.evaluate(() => document.querySelector('#qrLarge canvas')?.width ?? 0);
      assert.ok(largeW >= 480, '放大层位图宽应 ≥480，实得 ' + largeW);
      // 点任意处收回（元素常驻 DOM，只是去掉 .show）
      await page.click('#qrLarge');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await page.$('#qrLarge.show'), null, '点放大层任意处应收回');

      // Esc 关浮层
      await page.keyboard.press('Escape');
      await withTimeout(page.waitForSelector('#pairMask', { state: 'detached', timeout: 5_000 }), 8_000, 'Esc 关浮层');
      assert.equal(await page.$('#pairMask'), null, 'Esc 后浮层必须拆掉');

      // 🔴 关掉后再按 Esc 不得报错 —— 残留 keydown 监听会在这里暴露
      await page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(errs, [], '关浮层后有页面错误（可能是 document 监听没摘干净）');
    } finally {
      await page.close();
    }
  });

  await t.test('SCAN-E05 🔴 关闭出码浮层后焦点归还编辑器', async () => {
    // 老项目红线：关弹窗后光标必须回到正文，否则接着敲键盘什么都不会发生。
    const page = await openEditor(browser, h.baseUrl(), 'scanq4', PASS);
    try {
      await page.click('#qrBtn');
      await withTimeout(page.waitForSelector('#pairMask', { timeout: 15_000 }), 18_000, '等浮层');
      await page.click('#qrClose');
      await withTimeout(page.waitForSelector('#pairMask', { state: 'detached', timeout: 5_000 }), 8_000, '关浮层');
      await new Promise((r) => setTimeout(r, 200));
      const id = await page.evaluate(() => document.activeElement?.id ?? '');
      assert.equal(id, 'editor-host', '关闭后焦点应归还 #editor-host，实得 ' + (id || '(空)'));
    } finally {
      await page.close();
    }
  });

  await t.test('SCAN-E06 🔴 落地页扫码失败必须给**可见**原因', async () => {
    // 🔴🔴 这条钉的是 SCAN-E06 抓到的一个真缺陷：
    //   扫码反馈原先一律走 setFootStatus，而底栏 #foot 属于编辑器外壳，
    //   **在落地页根本不存在** —— `setFootStatus?.()` 的可选调用静默跳过，
    //   于是"点扫码 → 相机起不来 → 提示写在不存在的地方"= 用户什么都没看到，
    //   只觉得按钮坏了。修法是 scanFeedback 分流：编辑器页走底栏，
    //   落地页走专用的 #landingScanMsg（与输入校验用的 #landingWarn 分开，
    //   否则下一次敲键盘就把错误信息清掉了）。
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    try {
      await page.goto(h.baseUrl());
      await withTimeout(page.waitForSelector('#landingScan', { timeout: 15_000 }), 18_000, '等落地页');

      // headless 没有摄像头 ⇒ 必然走"相机起不来"那条路
      await page.click('#landingScan');
      await new Promise((r) => setTimeout(r, 2500));

      const st = await page.evaluate(() => ({
        mask: document.querySelector('#scanMask') !== null,
        msg: (() => {
          const w = document.getElementById('landingScanMsg');
          return w && !w.classList.contains('hidden') ? (w.textContent ?? '') : '';
        })(),
        // 🔴 可见性判据：不是"有文字"，而是"真的有盒子且不是透明/零高"
        msgBox: (() => {
          const w = document.getElementById('landingScanMsg');
          if (!w) return null;
          const r = w.getBoundingClientRect();
          const cs = getComputedStyle(w);
          return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, opacity: cs.opacity };
        })(),
      }));

      const gave = st.msg.includes('摄像头') || st.msg.includes('扫码');
      assert.ok(st.mask || gave, '点扫码后既没开层也没给原因：' + JSON.stringify(st));
      if (!st.mask) {
        assert.ok(gave, '相机起不来时必须给可见原因，实得 msg=' + JSON.stringify(st.msg));
        // 🔴 提示必须**真的看得见**：有文字但零尺寸 = 用户还是什么都没看到
        assert.ok(st.msgBox && st.msgBox.h > 8 && st.msgBox.display !== 'none',
          '提示有文字但不可见：' + JSON.stringify(st.msgBox));
        assert.notEqual(st.msgBox?.opacity, '0', '提示透明度为 0（等于没显示）');
      }

      // 自检数据必须挂上（正式接口，诊断页与 e2e 都读它）
      const hasHook = await page.evaluate(() => typeof window.__NOTESYNC_SCAN_DIAG__ === 'function');
      assert.equal(hasHook, true, '扫码自检钩子未挂上（诊断页与 e2e 都靠它）');

      assert.deepEqual(errs, [], '落地页扫码有页面错误');
    } finally {
      await page.close();
    }
  });

  await t.test('SCAN-E07 🔴 连点扫一扫不叠层（重入锁）', async () => {
    // 老项目 v10.1.4 血泪：布尔重入锁失灵时连点两下会叠出两层取景框，
    //   两层抢同一个镜头，句柄互踩，且上层关掉后下层再也关不掉。
    const page = await openEditor(browser, h.baseUrl(), 'scanq5', PASS);
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    try {
      await page.click('#scanBtn');
      await new Promise((r) => setTimeout(r, 400));
      await page.click('#scanBtn');
      await new Promise((r) => setTimeout(r, 400));
      await page.click('#scanBtn');
      await new Promise((r) => setTimeout(r, 800));
      const count = await page.evaluate(() => document.querySelectorAll('#scanMask').length);
      assert.ok(count <= 1, '叠出了多层取景框：' + count);
      // 收尾：关掉可能还开着的层
      await page.evaluate(() => document.querySelector('#scanCancel')?.click());
      await new Promise((r) => setTimeout(r, 300));
      const after = await page.evaluate(() => document.querySelectorAll('#scanMask').length);
      assert.equal(after, 0, '取消后浮层必须拆干净');
      assert.deepEqual(errs, [], '取景层开收有页面错误');
    } finally {
      await page.close();
    }
  });
});

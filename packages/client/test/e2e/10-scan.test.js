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
      // 🔴🔴 必须**等条件**，不能死等固定时长。
      //
      //   固定 2500ms 的实证（v1.13.0）：同一份代码连跑，有时 t+800ms 就拿到
      //   「扫码启动失败」，有时 t+2500ms 还是「层已拆、原因未到」⇒ 判据随机红。
      //   两种错都比测试红更糟：慢机器上假红会让人以为是这次改动引入的回归，
      //   快机器上假绿会放过"从来不给原因"这种真 bug。
      //   ⇒ 轮询等到「层还在」或「原因已可见」为止，最多 12 秒。
      //   🔴 条件必须是**终态**「层已收场 且 原因可见」，不能是「层还在 或 原因可见」。
      //     后者是恒真的：层建起来那一瞬间条件就满足，而层最终必然被拆，
      //     ⇒ 变异成"写了文案但仍是 hidden"时判据照样绿（我第一版就是这么写的，
      //        变异实测：删掉 `classList.remove('hidden')` 后 E06 依然全绿）。
      //     这条纪律与"判『看不见』要用可见性"是同一族：**判终态，别判中间态**。
      await withTimeout(
        page.waitForFunction(() => {
          if (document.querySelector('#scanMask') !== null) return false; // 层还没收场
          const w = document.getElementById('landingScanMsg');
          if (!w || w.classList.contains('hidden')) return false;
          if ((w.textContent ?? '').length === 0) return false;
          // 🔴 还得等**入场动画落位**：这个警示位是 `#landing .landing-in` 的子节点，
          //   带 animation-delay 且 fill-mode 是 backwards ⇒ 刚 remove('hidden') 的
          //   那一刻 opacity 实测是 **0**，读到它会被后面的"透明度为 0"断言打回。
          //   （与切皮肤气泡那条同款：.show 到 opacity:1 有过渡，立刻读是中间值。）
          return Number(getComputedStyle(w).opacity) > 0.9;
        }, null, { timeout: 12_000 }),
        15_000,
        '等「取景层已收场 + 原因可见」这个终态',
      );

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
      // 🔴🔴 本条曾写 `count <= 1`，而**0 也满足 <= 1** ——
      //   于是「浮层建好但从未 append 到 document.body」这条真 bug 长期全绿：
      //   用户点「扫一扫」→ 浏览器弹摄像头权限 → 允许 → 屏幕上什么都不出，
      //   控制台零报错（buildScanLayer 里每个环节都"成功"了）。
      //   教训：判「浮层可用」必须钉住"它进过 document.body"，而不是"此刻在不在"。
      //
      // 🔴 headless 没有摄像头 ⇒ getUserMedia 必失败 ⇒ 层会走 catch 分支被 cleanup 立即拆掉。
      //   所以**不能**断言"此刻 DOM 里还有 #scanMask"（老项目 v10.1.4 的降级路径就是这样）。
      //   正确的判据是「挂载发生过」+「相机不可用时给出了可见原因」。
      //   怎么证明挂载发生过：在点击**之前**给 document.body 打一个 MutationObserver 哨兵，
      //   记录 #scanMask 曾经被插入 —— 这比断言"此刻还在"更贴合真实用户能感知的东西。
      const seen = await page.evaluate(() => new Promise((resolve) => {
        const hits = [];
        // 🔴🔴🔴 底栏文案必须**持续观察**，不能只在窗口末尾读一次当前值。
        //
        //   原写法：`foot: document.querySelector('#syncText')?.textContent`
        //   ——在 1400ms 那个**单一瞬时点**读，于是变成一场三方赛跑：
        //     相机探测失败 → `deps.onHint(reason)` 异步写入「未检测到可用摄像头…」
        //     2 秒轮询 →把底栏回写成「已同步」
        //   谁最后落地，取决于 getUserMedia 的拒绝时刻与轮询节拍谁靠后。
        //   实测（同产物、同环境）连跑三轮：1 轮绿、2 轮红，红时读到
        //   `{added:1, removed:1, nowInBody:false, foot:"已同步"}`。
        //
        //   🔴 这与 `18-qr-migrate` 的 QR-M01 是**同一个病**：
        //     「判据读得太早 / 采样点选在了状态还在变化的窗口里」。
        //     产品行为是对的（`layer.ts:400` 的 `deps.onHint(reason)` 确实给了可见原因，
      //     文案见 `copy.ts` 的 `scanNoCamera`，逐字含「摄像头」），
        //     变的只是判据恰好落在了提示被轮询覆盖之后的那一帧。
        //   🔴 纪律：**等被断言的那个事实本身**。用户能感知的是
        //     "那一刻屏幕上出现过原因"，不是"第1400 毫秒它还在不在"。
        const foots = [];
        const mo = new MutationObserver((muts) => {
          for (const m of muts) {
            for (const n of m.addedNodes) {
              if (n && n.id === 'scanMask') hits.push('added');
            }
            for (const n of m.removedNodes) {
              if (n && n.id === 'scanMask') hits.push('removed');
            }
          }
          // 每次 DOM 变化都把当前底栏文案留档一份（去重由调用方做）
          const t = document.querySelector('#syncText')?.textContent ?? '';
          if (foots[foots.length - 1] !== t) foots.push(t);
        });
        mo.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        // 点三下（含重入锁验证）——必须在哨兵挂好**之后**点，否则观察不到挂载过程
        const btn = document.getElementById('scanBtn');
        for (let i = 0; i < 3; i += 1) btn.click();
        // 🔴 采样窗口的**右界**取 2600ms：必须跨过一整轮 2 秒轮询节拍，
        //   否则"提示出现过"这件事本身就可能被窗口切掉（采样窗口是 bug 的藏身处）。
        setTimeout(() => {
          mo.disconnect();
          // 收尾时再补一帧，兜住"最后一次变化恰好在disconnect 之前"的情况
          const t = document.querySelector('#syncText')?.textContent ?? '';
          if (foots[foots.length - 1] !== t) foots.push(t);
          const added = hits.filter((x) => x === 'added').length;
          const removed = hits.filter((x) => x === 'removed').length;
          resolve({
            added,
            removed,
            nowInBody: !!document.querySelector('#scanMask'),
            foot: document.querySelector('#syncText')?.textContent ?? '',
            // 🔴 整个窗口内底栏出现过的**全部**文案（不只是最后一帧）
            foots,
          });
        }, 2600);
      }));
      // 🔴 至少挂载过一次，且**最多一次**（重入锁不许叠层）
      assert.ok(seen.added >= 1, '取景层从未挂到 document.body（用户点扫一扫屏幕上什么都没有）：' + JSON.stringify(seen));
      assert.ok(seen.added <= 1, `叠出了多层取景框（挂载 ${seen.added} 次）：` + JSON.stringify(seen));
      // headless 无摄像头：层被拆掉是**正确降级**，但必须留下可见原因（老项目 v10.1.4）
      //
      // 🔴🔴🔴 分支条件必须由**结构事实**定，不能用"此刻层还在不在 body 里"。
      //
      //   原写法 `if (!seen.nowInBody)`：这是一个**采样瞬时值**，
      //   于是变异 `deps.onHint(reason)` → `void reason`（真的不给可见原因了）
      //   之后，层仍然会在某一刻被拆掉，但若那一刻采样还没走到，
      //   整段"必须给可见原因"的断言就被**整段跳过** ⇒ 判据全绿。
      //   实测：施加该变异后 SCAN-E06 转红，而本条 SCAN-E07 **照样全绿**。
      //
      //   🔴 纪律：**"条件跳过"型弱断言 = 没有断言**。
      //     断言能不能执行，必须由被测系统自己产生的结构痕迹决定
      //     （这里就是"层确实被拆过"），不能由"我采样那一刻的状态"决定。
      //   🔴 与上面「等被断言的事实本身」同源：
      //     要钉的是"用户看到过原因"这件已经发生的事，
      //     而"层被拆过"就是它的充分条件，且不会随采样时刻漂移。
      if (seen.removed >= 1) {
        // 🔴🔴🔴 必须**逐字**比对相机失败的那几条文案，不能用宽正则。
        //
        //   原写法 `/摄像头|相机|扫码/.test(seen.foot)` ——「扫码」二字命中的是
        //   `copy.ts` 的 `scanBusy: '扫码已在进行中'`（连点三下时的重入锁忙碌提示）。
        //   那条**恰好也在本场景出现**，于是判据被一句与病因无关的文案顶住了。
        //   取证实锤（变异 `deps.onHint(reason)` → `void reason`，即真的不给原因了）：
        //     `foots: ["· 最后同步：扫码已在进行中","已同步","连接中…","已同步","连接中…","已同步"]`
        //   六帧里**没有一帧**提到摄像头，但正则判true ⇒ 断言合法地放过了这个 bug。
        //
        //   🔴 纪律：**恒真断言 = 没有断言**。正则越宽，越可能命中一条"恰好也在"的无关文案。
        //     要钉用户看到的那句话，就逐字写出来。
        //   老项目 v10.1.4 同口径只有三条（`ui/copy.ts` 的 scanNeedHttps / scanDenied / scanNoCamera，
        //   另有 scanCompFail「扫码组件加载失败」与 scanStartFail「扫码启动失败」——
        //   后两条也只对"相机起不来"有意义，一并纳入，宁可多认不可漏认）。
        const CAMERA_FAIL_HINTS = [
          '当前环境无法调用摄像头',// scanNeedHttps
          '相机权限被拒绝',                      // scanDenied
          '未检测到可用摄像头',                  // scanNoCamera
          '扫码组件加载失败',// scanCompFail
          '扫码启动失败',                        // scanStartFail
        ];
        const everHinted = seen.foots.some((t) => CAMERA_FAIL_HINTS.some((h) => t.includes(h)));
        assert.ok(
          everHinted,
          '相机不可用时层被拆了却**从未**给过可见原因，用户只看到"点了没反应"。'
          + `整个 ${2600}ms 窗口里底栏只出现过：${JSON.stringify(seen.foots)}`,
        );
        // 🔴 反向闸：光有"出现过"不够，得证明这不是句常驻文案在骗人——
        //   窗口里必然同时出现过同步状态（那条一直在），所以要求两者并存。
        assert.ok(
          seen.foots.length >= 2,
          '🔴 整个窗口底栏只出现过一帧文案，采样窗口窄到可能切掉提示：'
          + JSON.stringify(seen.foots),
        );
        // 🔴🔴 为什么这里**不再**加一条"忙碌提示不算原因"的额外断言：
        //   ·「忙碌提示一次都不许出现」是在钉一个不存在的行为（连点三下本就该出）
        //     ⇒ 必然恒红或被迫放宽成恒真；
        //   ·「原因出现过」与上面 `everHinted` 逐字同义 ⇒ 恒真。
        //   🔴 纪律：**恒真断言 = 没有断言**；加断言前先问「它与已有断言是否同义」。
        //
        //   宽正则被忙碌提示骗过这件事，已经由**变异实验**钉住了（不是靠再加断言）：
        //     `deps.onHint(reason)` → `void reason` 之后，`foots` 六帧全是
        //     ["· 最后同步：扫码已在进行中","已同步","连接中…","已同步","连接中…","已同步"]，
        //     宽正则判true、逐字判 false —— 差别正在于此处。
        //   ⇒ 防回归靠的是「逐字比对这份清单」这件事本身，
        //     日后有人把清单放宽回正则，本条的失败信息里会留着上面那段foots 可供对照。
      } else {
        // 🔴 走到这里说明层挂上去就没被拆过 —— 在 headless 无摄像头环境下这本身可疑。
        //   钉住它，否则"removed 一直为 0"就能把上面整段断言静默绕过。
        assert.ok(
          seen.added === 0,
          '🔴 层挂上了却从未被拆掉：headless 没有摄像头，getUserMedia 必失败，'
          + `必然要走「立即收口 + 给可见原因」那条路（added=${seen.added} removed=${seen.removed}）`,
        );
      }
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

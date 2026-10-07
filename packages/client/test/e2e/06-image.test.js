/**
 * e2e：图片上传全链路（IMG 系列）—— 真浏览器
 *
 * 🔴 本文件要验的不是"能插进一张图"，而是三件容易静默出错的事：
 *   1. **签名 FormData 的字段集合与顺序对** —— 多带一个未签参数云端就 400，
 *      而 400 的提示含糊到没法查。
 *   2. **往返无损** —— 图片是 DecoratorNode，导出/导入后 canonical 逐字节相等。
 *   3. **零内联注入面** —— URL 来自云端响应，必须走 src 属性赋值而非 innerHTML。
 *
 * 图床用Playwright 的 route 拦截冒充（不连真云端）：
 *   真实云端会因签名不合约 400，我们要的是"**客户端发的对不对**"，
 *   所以拦截器按云端算法**重算一遍签名**：算得出⇒放行并回一个假 secure_url；
 *   算不出⇒回400。这样签名错会被真判红，而不是被"反正拦截了"掩盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installHarness,
  openEditor,
  openEditorTouch,
  closeTouch,
  withTimeout,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 必须是 4 级（e2e → test → client → packages → 仓库根）
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

/** 假图床参数（与服务端 upsign 的期望一致）。 */
const CLOUD = {
  name: 'bjtest',
  apiKey: 'test-api-key',
  secret: 'test-upsign-secret',
  preset: 'bj_signed',
  folder: 'notesync_bj',
};

/**
 * 云端算法**独立重算**（不 import 被测实现，见 image-upload.test.mjs UPLOAD-06 同理）。
 *
 * 🔴🔴 这份是**真 Cloudinary 的替身**，所以必须忠实于云端规范，不能忠实于我们的实现：
 *   1. 待签串按**参数名字典序**（folder < timestamp < upload_preset）
 *      —— 云端 401 时把 "String to sign" 原样报回来过，就是这个顺序。
 *   2. 签名是 **`SHA1(串 + secret)`，不是 HMAC**（2026-10-06 实测：
 *      老项目票直传 200、我们票 401，cloud/key/preset/folder/secret 全同，
 *      唯一差别就是这个算法）。
 *
 *   我上一版这里写的是 HMAC + `timestamp&folder&upload_preset` —— 与我们的实现
 *   **错得一模一样**，于是"两端一起错" ⇒ 这条校验**恒绿**，线上 401 一直没人发现。
 *   替身漂移比没有替身更危险：它给出的是**假的绿灯**。
 */
function cloudSignature({ timestamp, folder, uploadPreset }) {
  const params = { timestamp, upload_preset: uploadPreset };
  if (folder) params.folder = folder;
  const str = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(str + CLOUD.secret).digest('hex');
}

/** 真源的 canonical 字节（复用页面里已加载的 canonicalize，不手写第二份）。 */
const canon = (page) =>
  page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));

/**
 * 装上假图床 + 假签发端点。
 * @returns {{seen: Array, errors: string[]}} seen 收集每次直传的字段
 */
async function installFakeCloud(page) {
  const seen = [];
  const errors = [];

  // 签发端点：返回合法票
  await page.route('**/api/upsign', async (route) => {
    const req = route.request();
    // 🔴 反向自证：content-type 少了就说明客户端没带，那是真bug，必须判红
    if (!(req.headers()['content-type'] || '').includes('application/json')) {
      errors.push('upsign 缺 application/json（会被当 simple 请求，跨域可滥要签名）');
    }
    const ts = 1759600000;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cloudName: CLOUD.name,
        apiKey: CLOUD.apiKey,
        timestamp: ts,
        signature: cloudSignature({
          timestamp: ts,
          folder: CLOUD.folder,
          uploadPreset: CLOUD.preset,
        }),
        uploadPreset: CLOUD.preset,
        folder: CLOUD.folder,
      }),
    });
  });

  // 图床：按云端算法重算签名，算不出就 400
  await page.route('**/api.cloudinary.com/**', async (route) => {
    const req = route.request();
    const post = req.postData() || '';
    const get = (k) => {
      const m = new RegExp(`name="${k}"\\r?\\n(?:.*\\r?\\n)*?\\r?\\n(.+)`).exec(post);
      return m ? m[1].trim() : '';
    };
    const fields = {
      api_key: get('api_key'),
      timestamp: get('timestamp'),
      signature: get('signature'),
      upload_preset: get('upload_preset'),
      folder: get('folder'),
    };
    seen.push({ fields, hasFile: /name="file"/.test(post) });

    const expect = cloudSignature({
      timestamp: Number(fields.timestamp),
      folder: fields.folder,
      uploadPreset: fields.upload_preset,
    });
    if (fields.signature !== expect) {
      errors.push(
        `签名不符：发出${fields.signature}，云端应算 ${expect}（timestamp=${fields.timestamp} folder="${fields.folder}" preset=${fields.upload_preset}）`,
      );
      await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"bad signature"}' });
      return;
    }
    // 🔴 反向自证：不该出现的未签参数
    for (const bad of ['public_id', 'transformation']) {
      if (post.includes(`name="${bad}"`)) {
        errors.push(`直传里出现了未签参数 ${bad}（云端会判签名不符）`);
      }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ secure_url: `https://res.cloudinary.com/${CLOUD.name}/image/upload/bj_test.jpg` }),
    });
  });

  return { seen, errors };
}

/** 造一张 1x1 PNG 的 File 并直接塞进 file input。 */
async function attachImage(page) {
  // 1x1 透明 PNG
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await page.evaluate(async (dataB64) => {
    const bin = atob(dataB64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], '测试图片.png', { type: 'image/png' });
    const input = document.getElementById('nsUploadInput');
    if (!input) throw new Error('未找到 nsUploadInput');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, b64);
}

test('IMG-01 🔴 签名 FormData 字段与云端算法一致（不多带未签参数）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'i01', 'pw');
  try {
    const { seen, errors } = await installFakeCloud(page);
    await page.click('.ns-editor');
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'ok', { timeout: 15000 }),
      20000,
      '等上传成功提示',
    );
    assert.deepEqual(errors, [], `假图床判定上传有问题：\n${errors.join('\n')}`);
    assert.equal(seen.length, 1, '应恰好直传一次，实际=' + seen.length);
    assert.equal(seen[0].hasFile, true, 'FormData 必须带 file 字段');
    assert.equal(seen[0].fields.api_key, CLOUD.apiKey);
    assert.equal(seen[0].fields.upload_preset, CLOUD.preset);
    assert.equal(seen[0].fields.folder, CLOUD.folder);
  } finally {
    await page.close();
  }
});

test('IMG-02 🔴 图片进真源且往返无损（DecoratorNode 不丢 src）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'i02', 'pw');
  try {
    const { errors } = await installFakeCloud(page);
    await page.click('.ns-editor');
    await page.keyboard.type('图前面');
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'ok', { timeout: 15000 }),
      20000,
      '等上传成功提示',
    );
    assert.deepEqual(errors, [], errors.join('\n'));

    // 真源里应有 img 块
    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    const imgBlocks = (doc.blocks || []).filter((b) => b.t === 'img');
    assert.equal(imgBlocks.length, 1, '真源应有一个 img 块，实际=' + JSON.stringify(doc.blocks));
    assert.ok(
      String(imgBlocks[0].src || '').includes('bj_test.jpg'),
      'img 块应带云端返回的 src，实际=' + JSON.stringify(imgBlocks[0]),
    );

    // 往返无损
    const before = await canon(page);
    await page.evaluate(() => window.__NOTESYNC_RELOAD_FROM_DOC__());
    await page.waitForTimeout(500);
    const after = await canon(page);
    assert.equal(after, before, `图片往返应无损。\n前=${before}\n后=${after}`);
  } finally {
    await page.close();
  }
});

test('IMG-03 🔴 云端 URL 走 src 赋值，不进 innerHTML（注入面收口）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'i03', 'pw');
  try {
    await installFakeCloud(page);
    await page.click('.ns-editor');
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'ok', { timeout: 15000 }),
      20000,
      '等上传成功提示',
    );
    await page.waitForTimeout(300);
    const info = await page.evaluate(() => {
      const fig = document.querySelector('.ns-img');
      const img = document.querySelector('.ns-img img');
      return {
        hasFig: !!fig,
        hasImg: !!img,
        src: img ? img.getAttribute('src') : null,
        referrerPolicy: img ? img.getAttribute('referrerpolicy') : null,
        // 判据：图片必须真在 DOM 里（不是一段字符串）
        inDom: img instanceof HTMLImageElement,
      };
    });
    assert.equal(info.hasFig, true, '应有 figure.ns-img 容器');
    assert.equal(info.inDom, true, 'img 必须是真实元素（不是 innerHTML 拼出来的字符串）');
    assert.ok(info.src && info.src.includes('bj_test.jpg'), 'src 应为云端返回地址，实际=' + info.src);
    // 🔴 外链图床不带 referrer，避免泄露访问页地址（老项目同策略）
    assert.equal(info.referrerPolicy, 'no-referrer', '外链图片应设 no-referrer');
  } finally {
    await page.close();
  }
});

test('IMG-04 🔴 签发失败必须看得见（提示条 + 图片未插入）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'i04', 'pw');
  try {
    // 签发端点直接 501（对应"服务器未启用上传签名"）
    await page.route('**/api/upsign', (route) =>
      route.fulfill({ status: 501, contentType: 'application/json', body: '{"error":"upsign not configured"}' }),
    );
    await page.click('.ns-editor');
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'bad', { timeout: 15000 }),
      20000,
      '等失败提示',
    );
    const note = await page.evaluate(() => {
      const el = document.getElementById('uploadNote');
      return { kind: el?.dataset.kind, text: el?.textContent || '' };
    });
    // 🔴 失败文案必须包含「未插入 + 请重试」——
    //   老项目 v10.0.0 关键路径止血：用户只看到图片没出来会以为功能坏了。
    assert.ok(note.text.includes('未插入'), '失败文案须说明图片未插入，实际=' + note.text);
    assert.ok(note.text.includes('请重试'), '失败文案须给出下一步（请重试），实际=' + note.text);

    // 确认真源里确实没有多出图片
    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    const n = (doc.blocks || []).filter((b) => b.t === 'img').length;
    assert.equal(n, 0, '失败时不应插入任何 img 块');
  } finally {
    await page.close();
  }
});

test('IMG-05 🔴 同一文件连选两次都能上传（value 必须清空）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'i05', 'pw');
  try {
    const { seen } = await installFakeCloud(page);
    await page.click('.ns-editor');
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'ok', { timeout: 15000 }),
      20000,
      '等第一次成功',
    );
    await page.waitForTimeout(2600); // 等成功提示自动收掉，避免遮住第二次
    // 同一个文件再选一次
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'ok', { timeout: 15000 }),
      20000,
      '等第二次成功',
    );
    assert.equal(seen.length, 2, '同一文件连选两次都应触发上传，实际直传次数=' + seen.length);
  } finally {
    await page.close();
  }
});

/* ================================================================== *
 * 报障第 7 条：移动端「插入图片方式」二选一 + 上传后移动端显示异常
 * ================================================================== */

test('IMG-06 🔴🔴 触屏点上传必须先弹「插入图片方式」，桌面直接开文件框（老项目 :2807）', async () => {
  // 老项目 index.html:2825
  //   uploadBtn.addEventListener('click', () => { if (CHIP_HOVER_OK) { pickUploadFile(false); return; } nsUpMenuOpen(); });
  // ⇒ **判据是 CHIP_HOVER_OK（精确指针），不是"是不是手机"**。
  //   平板 + 触控笔 / 插了鼠标的触屏本 / 桌面触屏一体机都走直开文件框那条，
  //   与 platform/touch.ts 的 `restoreEditorFocus` 同一口径（any-pointer: fine 放行）。
  //
  // 🔴 老项目弹窗文案逐字（:2807-2818）：
  //   h1「插入图片」/ sub「选一种方式，图片会自动压缩上传」/ 「拍 照」/ 「从相册选择」
  //   且「从相册选择」带 ghost-btn 类（但那个类是**死规则**，见 replication-discipline §2，
  //   真实渲染与其他按钮同款 —— 所以判据**不钉**它的视觉，只钉它确实可点）。
  const page = await openEditorTouch(h.browser(), h.baseUrl(), 'img06', 'pw');
  try {
    let fileBoxOpened = 0;
    await page.exposeFunction('__img06FileBox', () => { fileBoxOpened += 1; });
    // 拦点击：老项目是 `fileInput.click()`，真浏览器会开系统文件框（headless 里开不了），
    // 所以把 input.click() 换成计数 —— 这样能判"有没有直接开文件框"。
    await page.evaluate(() => {
      const el = document.getElementById('nsUploadInput');
      if (!el) throw new Error('未找到 nsUploadInput');
      el.click = () => { window.__img06FileBox(); };
    });

    // 🔴 顶栏上传键的真实 id 是 `uploadBtn`（ui/shell.ts:53 `{ id: 'uploadBtn', act: 'upload' }`），
    //   **不是**我第一版写的 `topUpBtn`。判据里猜 id 的后果是干等 5s，报错像"按钮没反应"。
    await page.tap('#uploadBtn');
    await withTimeout(
      page.waitForSelector('#nsUpModal', { state: 'visible', timeout: 5000 }),
      6000, '触屏点上传应弹出「插入图片方式」',
    );

    const modal = await page.evaluate(() => {
      const m = document.getElementById('nsUpModal');
      const box = m.querySelector('.box');
      const btns = [...m.querySelectorAll('button')].map((b) => ({
        text: b.textContent, cls: b.className, ghost: b.classList.contains('ghost-btn'),
      }));
      const h1 = m.querySelector('h1');
      const sub = m.querySelector('p');
      const cs = getComputedStyle(sub);
      return {
        h1: h1 ? h1.textContent : null,
        sub: sub ? sub.textContent : null,
        subFS: cs.fontSize, subLH: cs.lineHeight, subColor: cs.color, subMargin: cs.margin,
        btns,
        boxAlign: box ? getComputedStyle(box).textAlign : null,
      };
    });
    assert.equal(modal.h1, '插入图片', '弹窗标题（老项目 :2810 逐字）');
    assert.equal(modal.sub, '选一种方式，图片会自动压缩上传',
      '弹窗副标题（老项目 :2811 逐字）');
    assert.equal(modal.subFS, '12.5px', '副标题字号（老项目内联 font-size:12.5px）');
    assert.equal(modal.boxAlign, 'center', '弹窗内容居中（老项目 box.style.textAlign=center）');
    // 「拍 照」中间那个空格是老项目逐字的，不能写成「拍照」
    assert.deepEqual(modal.btns.map((b) => b.text), ['拍 照', '从相册选择'],
      '两个按钮文案（老项目 :2813-2814 逐字，含「拍 照」的空格）');
    assert.equal(modal.btns[1].ghost, true,
      '「从相册选择」必须挂 ghost-btn 类（老项目 :2814；视觉不钉，只钉类名在位）');

    // 反向：弹窗开着时**不许**已经开过文件框（触屏必须先选方式）
    assert.equal(fileBoxOpened, 0, '触屏必须先弹二选一，不许直接开文件框');
  } finally {
    await closeTouch(page);
  }
});

test('IMG-07 🔴🔴 桌面点上传直接开文件框，不弹二选一（老项目 CHIP_HOVER_OK 那一支）', async () => {
  // 🔴 这是 IMG-06 的**反向断言**：只写"触屏要弹"的话，
  //   把 pickImage() 改成永远弹模态也能变绿 —— 而那会让桌面用户每次都多点一次。
  const page = await openEditor(h.browser(), h.baseUrl(), 'img07', 'pw');
  try {
    await page.evaluate(() => {
      const el = document.getElementById('nsUploadInput');
      if (!el) throw new Error('未找到 nsUploadInput');
      window.__img07FileBox = 0;
      el.click = () => { window.__img07FileBox += 1; };
    });
    await page.click('#uploadBtn');
    await page.waitForFunction(() => window.__img07FileBox === 1, { timeout: 5000 });
    // 反向：桌面**不该**出现二选一
    const hasModal = await page.evaluate(() => !!document.getElementById('nsUpModal'));
    assert.equal(hasModal, false, '桌面（有精确指针）必须直开文件框，不弹「插入图片方式」');
  } finally {
    await page.close();
  }
});

test('IMG-08 🔴🔴🔴 触屏长按图片必须弹自建菜单（放大查看/保存到相册/复制图片链接）', async () => {
  // 🔴🔴 这条钉的是**用户报障第 7 条的后半段「移动端图片显示异常」**。
  //
  //   探针实测（触屏390x844，真浏览器）：
  //     tap('.ns-img img') → { zoom: false, menu: false }**什么都不发生**
  //   而 bj 的 `styles.css:1607-1670` **已经把`#nsZoom` 查看器与 `#nsImgMenu`
  //   长按菜单的整套样式抄过来了**（含暗底、44px 大按钮、safe-area、nsMenuFade 动画）。
  //   ⇒ 那是**死 CSS**：样式在、行为一行都没有。
  //   文件头自己写着「点击放大/长按弹菜单的交互是另一批的事」——
  //   那一批一直没做，而用户在移动端看到的就是"图片点了没反应、长按也没用"。
  //
  //   老项目 index.html:5519`nsImgMenu` 三项逐字：
  //     「放大查看」/「保存到相册」/「复制图片链接」
  //   长按触发点:index.html:5628（`mousedown` 起定时器 / `touchstart` 同款），
  //   且老项目有 `html.ns-no-callout #editor img{-webkit-touch-callout:none}`
  //   ——iOS/Android 原生长按菜单会与自建菜单打架，必须关掉。
  //
  //🔴 为什么这条与 IMG-06 分开：IMG-06 管"插图前的二选一"，
  //   这条管"图插进去之后能不能在手机上正常看/存"——两件事、两个失败面。
  const page = await openEditorTouch(h.browser(), h.baseUrl(), 'img08', 'pw');
  try {
    await installFakeCloud(page);
    await page.tap('.ns-editor');
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'ok', { timeout: 15000 }),
      20000, '等上传成功',
    );

    // 反向前置：手机上**不许**出现原生 callout（它会盖住自建菜单/抢走手势）
    //
    // 🔴🔴 这里**不能**读 `getComputedStyle(img).webkitTouchCallout`—— 判据写过一版，
    //   实测恒为 `undefined`，白跑一轮才发现是**判据本身钉在浏览器不实现的属性上**：
    //   探针实测（桌面 Chromium 141，触屏上下文）：
    //     `getComputedStyle(img).webkitTouchCallout`          → undefined
    //     `getPropertyValue('-webkit-touch-callout')`         → ""
    //     手工 `img.style.webkitTouchCallout='none'` 再读     → 仍是 undefined
    //     `document.styleSheets` 里那条规则的 cssText          → `html.ns-no-callout .ns-editor img { }`（**空体**）
    //   ⇒ 桌面 Chromium 解析时就把这个webkit 专有属性**整个丢掉**，
    //   声明根本不存在。读它 = 钉一个在测试环境恒不存在的值，永远修不红。
    //
    //   改钉**真正决定用户能不能存图的机制**，且两侧都可判定（探针实测）：
    //     触屏  { hasClass: true,  matches: true  }
    //     桌面  { hasClass: false, matches: false }
    //   即：类挂在 <html> 上（决定规则是否命中）＋ 图片真的匹配那条选择器。
    //   这两条合起来等价于"触屏下 callout 被关"，且不会在别的内核上假红。
    const callout = await page.evaluate(() => {
      const img = document.querySelector('.ns-img img');
      return {
        hasClass: document.documentElement.classList.contains('ns-no-callout'),
        matches: !!img && img.matches('html.ns-no-callout .ns-editor img'),
      };
    });
    assert.equal(callout.hasClass, true,
      `触屏端必须给 <html> 挂 ns-no-callout（老项目 index.html:377），实测=${callout.hasClass}`);
    assert.equal(callout.matches, true,
      `挂上类之后规则必须真的命中正文图片（选择器对齐 styles.css:1674），实测=${callout.matches}`);

    // 长按（生产实现用 pointerdown 起定时器，这里用真 pointer 事件）
    const box = await page.evaluate(() => {
      const img = document.querySelector('.ns-img img');
      const r = img.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();

    await withTimeout(
      page.waitForSelector('#nsImgMenu', { state: 'visible', timeout: 5000 }),
      6000, '长按图片应弹出自建菜单',
    );
    const menu = await page.evaluate(() => {
      const m = document.getElementById('nsImgMenu');
      const items = [...m.querySelectorAll('button')].map((b) => b.textContent);
      const cs = getComputedStyle(m);
      return {
        items,
        zIndex: cs.zIndex,
        position: cs.position,
        minWidth: cs.minWidth,
        radius: cs.borderRadius,
        inDom: document.body.contains(m),
      };
    });
    // 老项目 :5523-5525 逐字，含「复制图片链接」这五个字（不是「复制链接」）
    assert.deepEqual(menu.items, ['放大查看', '保存到相册', '复制图片链接'],
      '长按菜单三项逐字（老项目 index.html:5523-5525）');
    assert.equal(menu.position, 'fixed', '菜单是 fixed 定位（老项目 :368）');
    assert.equal(menu.zIndex, '89', 'z序89（老项目 :368；必须在查看器 88 之上、图鉴 90 之下）');
    assert.equal(menu.inDom, true, '菜单挂在 body 上');

    // 「放大查看」必须真的能开查看器（不然这一项是装饰）
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#nsImgMenu button')].find((x) => x.textContent === '放大查看');
      b.click();
    });
    await withTimeout(
      page.waitForSelector('#nsZoom', { state: 'visible', timeout: 5000 }),
      6000, '「放大查看」应打开查看器',
    );
    const zoom = await page.evaluate(() => {
      const z = document.getElementById('nsZoom');
      return {
        hasImg: !!z.querySelector('.nz-stage img'),
        barBtns: [...z.querySelectorAll('.nz-bar button')].map((b) => b.textContent),
        hasX: !!z.querySelector('.nz-x'),
        tip: (z.querySelector('.nz-tip') || {}).textContent || '',
      };
    });
    assert.equal(zoom.hasImg, true, '查看器里必须有图');
    // 老项目 :5461 底栏两项逐字
    assert.deepEqual(zoom.barBtns, ['复制链接', '保存到相册'], '查看器底栏两项（老项目 :5461）');
    assert.equal(zoom.hasX, true, '查看器必须有关闭 ×（老项目 :5463）');
    // 触屏提示语必须与桌面不同（老项目 :5459 按 nsHoverPointer 分支）
    assert.match(zoom.tip, /双指缩放/, `触屏查看器提示必须是「双指缩放…」，实际="${zoom.tip}"`);

    // 反向：关掉查看器后菜单不该复活
    await page.evaluate(() => {
      const x = document.querySelector('#nsZoom .nz-x');
      if (x) x.click();
    });
    await withTimeout(
      page.waitForFunction(() => !document.getElementById('nsZoom'), { timeout: 5000 }),
      6000, '×应关掉查看器',
    );
    const menuGone = await page.evaluate(() => !document.getElementById('nsImgMenu'));
    assert.equal(menuGone, true, '开查看器时菜单应已关闭（老项目 nsImgOpenZoom 先 nsImgMenuClose）');
  } finally {
    await closeTouch(page);
  }
});

test('IMG-09 🔴 桌面点图片直接开查看器，不弹长按菜单（老项目 nsHoverPointer 分支）', async () => {
  // 🔴 IMG-08 的**反向断言**：只写"触屏要弹菜单"的话，
  //   把长按菜单改成永远弹也会变绿——而桌面用户点图片就该直接进查看器。
  const page = await openEditor(h.browser(), h.baseUrl(), 'img09', 'pw');
  try {
    await installFakeCloud(page);
    await page.click('.ns-editor');
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'ok', { timeout: 15000 }),
      20000, '等上传成功',
    );
    await page.click('.ns-img img');
    await withTimeout(
      page.waitForSelector('#nsZoom', { state: 'visible', timeout: 5000 }),
      6000, '桌面点图片应直接开查看器',
    );
    const menuGone = await page.evaluate(() => !document.getElementById('nsImgMenu'));
    assert.equal(menuGone, true, '桌面单击路径不该弹长按菜单');
    // 反向：桌面**不许**挂 ns-no-callout。它会顺带禁掉桌面右键的原生能力，
    //   而桌面有鼠标，右键菜单是正常路径 —— 无条件挂等于给桌面加缺陷。
    const noCallout = await page.evaluate(() =>
      document.documentElement.classList.contains('ns-no-callout'));
    assert.equal(noCallout, false,
      '桌面端不该挂 ns-no-callout（老项目只在触屏分支加，桌面要保留右键原生菜单）');
    const tip = await page.evaluate(() => (document.querySelector('#nsZoom .nz-tip') || {}).textContent || '');
    assert.match(tip, /滚轮缩放/, `桌面查看器提示必须是「滚轮缩放…」，实际="${tip}"`);
    // 反向：查看器底栏与长按菜单第三项**文案不同**，别把两处写成一样
    //   （老项目 :5461 底栏「复制链接」三个字/ :5525 菜单「复制图片链接」五个字）。
    const barBtns = await page.evaluate(() =>
      [...document.querySelectorAll('#nsZoom .nz-bar button')].map((b) => b.textContent));
    assert.deepEqual(barBtns, ['复制链接', '保存到相册'], '桌面查看器底栏两项（老项目 :5461）');
  } finally {
    await page.close();
  }
});

/* ================================================================== *
 * 退格删图：把「bj 现有行为」钉住
 * ================================================================== */

/**
 * IMG-10~12 为什么存在 —— 这是一条**反向结论的守卫**，不是新功能判据。
 *
 * 老项目 index.html:4586-4621 有一段 `imgBeforeCaret` + keydown 接线，
 * 专门处理「光标在**行内** `<img>` 右侧按退格 → 删掉整张图」。
 * 差异盘点时把这条列为 bj 的 P1 缺口（"bj 无任何 registerBackspace"）。
 *
 * 🔴 真浏览器实测（2026-10-07 探针，四个位置逐一定位）结论是**不适用，不要移植**：
 *   老项目的图片是**裸行内 `<img>`**（直接 `range.insertNode(img)` 插进文本流）；
 *   bj 的图片是 `ImageBlockNode extends DecoratorNode` 且 `isInline(): false`，
 *   **永远独占一个块**。所以"光标紧贴图片右侧"这个形态在 bj **构造不出来**，
 *   而块级 decorator 的退格行为由 Lexical 内建（rich-text 的
 *   KEY_BACKSPACE_COMMAND → DELETE_CHARACTER_COMMAND）已经处理得很好：
 *     图在文末（光标是块光标）→ 一次退格删图
 *     图后有文字段，光标落在该段行首 → 一次退格删图
 *     点图片选中（NodeSelection）→ 一次退格删图
 *     图后有**空段落** → 第一次退格收掉空段落并选中图片，第二次删图（教科书行为）
 *
 * ⇒ 照抄 `imgBeforeCaret` 只会得到一段**永不命中**的死代码
 *   （与 `window.__NOTESYNC_NATIVE__` 那次同形状：声明在、判定永不成立）。
 *
 * 但这三条判据必须留下：将来谁若改了节点模型（比如把图片改成 inline），
 *   或 Lexical 升级改了 decorator 的退格语义，"删不掉图"会**零报错**地回归，
 *   而届时没人会想起当年为什么判定不用做。
 */

/**
 * 等到真源里图块数变成 `want`。
 *
 * 🔴🔴 不能用固定 `waitForTimeout`：编辑器是 debounce 写真源，固定等待在慢机器上
 *   读到的是**还没落盘的真源**。第一次跑 IMG-12 就是这么红的 ——
 *   报出来像"删除没持久化"，差点让人去改产品代码（20-empty-para.test.js 记过同款）。
 *   等条件：真 bug 会超时并报清楚，慢机器会自己多等一会儿。
 */
const waitImgCount = (page, want, label) =>
  withTimeout(
    page.waitForFunction(
      (w) => {
        const d = window.__NOTESYNC_DOC__?.();
        if (!d || typeof d !== 'object') return false;
        return (d.blocks ?? []).filter((b) => b.t === 'img').length === w;
      },
      want,
      { timeout: 15_000 },
    ),
    18_000,
    label,
  );

test('IMG-10 🔴🔴 图在文末：一次退格就删掉整张图', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'i10', 'pw');
  try {
    await installFakeCloud(page);
    await page.click('.ns-editor');
    await page.keyboard.type('AAA');
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'ok', { timeout: 15000 }),
      20000, '等上传成功',
    );
    await page.waitForTimeout(600);
    const before = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal((before.blocks || []).filter((b) => b.t === 'img').length, 1, '前置：应有一张图');

    await page.keyboard.press('Backspace');
    await waitImgCount(page, 0, 'IMG-10 等真源里图块数到 0');

    const after = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal((after.blocks || []).filter((b) => b.t === 'img').length, 0,
      `文末的图应被一次退格删掉，实际=${JSON.stringify(after.blocks)}`);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.ns-img').length), 0, 'DOM 里也不该再有图');
    // 反向：正文不能被顺手吃掉
    const txt = await page.evaluate(() => document.querySelector('.ns-editor')?.textContent || '');
    assert.match(txt, /AAA/, `删图不该吃掉正文，实际="${txt}"`);
  } finally {
    await page.close();
  }
});

test('IMG-11 🔴🔴 图后有文字段：光标落在该段行首，一次退格删图', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'i11', 'pw');
  try {
    await installFakeCloud(page);
    await page.click('.ns-editor');
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'ok', { timeout: 15000 }),
      20000, '等上传成功',
    );
    await page.waitForTimeout(600);
    await page.keyboard.type('CCC');
    await page.waitForTimeout(400);
    // 光标移到 CCC 行首（Home 在本编辑器里能落到段首）
    await page.keyboard.press('Home');
    await page.waitForTimeout(200);
    await page.keyboard.press('Backspace');
    await waitImgCount(page, 0, 'IMG-11 等真源里图块数到 0');

    const after = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal((after.blocks || []).filter((b) => b.t === 'img').length, 0,
      `图后段落行首退格应删掉图，实际=${JSON.stringify(after.blocks)}`);
    // 反向：后一段的文字必须原样留下（删的是图，不是那一行）
    const txt = await page.evaluate(() => document.querySelector('.ns-editor')?.textContent || '');
    assert.match(txt, /CCC/, `删图不该吃掉后一段文字，实际="${txt}"`);
  } finally {
    await page.close();
  }
});

test('IMG-12 🔴🔴 图后是空段落：两次退格删掉图，且删除结果能持久化（重载后不复活）', async () => {
  // 🔴 这一条刻意**不**走"点图片选中"：桌面点图片会打开查看器（IMG-09 已断言），
  //   退格落在查看器上而不是编辑器 —— 那不是"删不掉图"，是另一条路径。
  //   真实用户在这里的形态是：插图后系统留了一个空段落，光标就在那个空段落里按退格。
  //   教科书行为：**第一次**退格收掉空段落并选中图片，**第二次**删图。
  const page = await openEditor(h.browser(), h.baseUrl(), 'i12', 'pw');
  try {
    await installFakeCloud(page);
    await page.click('.ns-editor');
    await page.keyboard.type('BBB');
    await attachImage(page);
    await withTimeout(
      page.waitForFunction(() => document.querySelector('#uploadNote')?.dataset.kind === 'ok', { timeout: 15000 }),
      20000, '等上传成功',
    );
    await page.waitForTimeout(600);
    // 打一个字再删掉它 ⇒ 稳定造出"图 + 后面的空段落、光标在空段落"这个形态
    await page.keyboard.type('Z');
    await page.waitForTimeout(400);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
    const pre = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal((pre.blocks || []).filter((b) => b.t === 'img').length, 1, '前置：此时图应还在');

    await page.keyboard.press('Backspace'); // 收掉空段落、选中图
    await page.waitForTimeout(300);
    await page.keyboard.press('Backspace'); // 删图
    await waitImgCount(page, 0, 'IMG-12 等真源里图块数到 0');

    const after = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal((after.blocks || []).filter((b) => b.t === 'img').length, 0,
      `两次退格后应删掉图，实际=${JSON.stringify(after.blocks)}`);
    // 反向：正文不能被顺手吃掉
    const txt = await page.evaluate(() => document.querySelector('.ns-editor')?.textContent || '');
    assert.match(txt, /BBB/, `删图不该吃掉正文，实际="${txt}"`);

    // 🔴 持久化是另一半：只删 DOM 不写真源 ⇒ 重载后图"复活"，
    //   用户以为删掉了，隔天打开又在那儿。
    await page.reload();
    await page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20000 });
    // 重载要走解密 + 拉远端 + 写真源，等"真源可读"而不是等固定秒数
    await withTimeout(
      page.waitForFunction(() => {
        const d = window.__NOTESYNC_DOC__?.();
        return !!d && typeof d === 'object' && Array.isArray(d.blocks) && d.blocks.length > 0;
      }, { timeout: 20_000 }),
      24_000,
      'IMG-12 等重载后真源就绪',
    );
    const reloaded = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal((reloaded.blocks || []).filter((b) => b.t === 'img').length, 0,
      `重载后不该复活，实际=${JSON.stringify(reloaded.blocks)}`);
  } finally {
    await page.close();
  }
});

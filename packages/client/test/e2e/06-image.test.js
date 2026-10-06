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
import { installHarness, openEditor, withTimeout } from './harness.mjs';

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

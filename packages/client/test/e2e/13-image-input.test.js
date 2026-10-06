/**
 * e2e：图片的**拖拽**与**粘贴**两个入口（IMGIN 系列）
 *
 * 🔴🔴🔴 这两条是补 P0 的回归闸，来源与 `11-fold-autocreate.test.js` 完全同形：
 *   `06-image.test.js` 的 5 条测试**全部**走 `nsUploadInput` 的 change 事件，
 *   也就是只有"点顶栏按钮选图"那一条路。
 *   而拖拽与粘贴这两个入口此前**在src 里一行都没有**
 *   （`grep "'drop'\|'dragover'\|'paste'" packages/client/src/behaviors.ts` 命中 0），
 *   e2e 却全绿 —— 测试造的是它自己认识的东西，测不到用户唯一能走的那两条路。
 *
 *   判据纪律：**验收路径必须是用户真实路径**（真的派发DragEvent / ClipboardEvent），
 *   任何"调个内部函数造出img 块"的测试都不能证明这两个入口对用户可用。
 *
 * 覆盖四条：
 *   IMGIN-01  粘贴一张图 → 真源有 img block + DOM 有 img 元素 + src 是签名 URL（正向）
 *   IMGIN-02  拖拽**非图片**文件 → **不得**创建 img block（反向闸，防止"见文件就插图"）
 *   IMGIN-03  纯文本粘贴 → **不得**创建 img block，且文本进了编辑器（反向闸，
 *             防"为了插图把纯文本粘贴也吞了"这种内容损坏）
 *   IMGIN-04  拖拽高亮 class 的进出（dragenter/dragover 加、dragleave/drop 撤）
 *             —— 这条是拖拽**唯一**的视觉反馈，撤不掉等于用户全程看不见提示
 *
 * 图床用 Playwright 的 route 拦截冒充（与 06-image.test.js 同款，不连真云端）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 路径纪律同 06-image.test.js：必须 4 级到仓库根的 www。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

/** 假图床参数（与 06-image.test.js 同值，避免两处漂移）。 */
const CLOUD = {
  name: 'bjtest',
  apiKey: 'test-api-key',
  secret: 'test-upsign-secret',
  preset: 'bj_signed',
  folder: 'notesync_bj',
};

/**
 * 云端算法**独立重算**（不 import 被测实现）。
 *
 * 🔴 与 06-image.test.js 同款替身，**必须忠实于真 Cloudinary 规范**：
 *   字典序拼串 + `SHA1(串 + secret)`（不是 HMAC）。
 *   我上一版这里写成 HMAC + `timestamp&folder&upload_preset`，与我们的实现错得一样，
 *   于是两端一起错 ⇒ 校验恒绿，线上 401 一直没人发现。
 */
function cloudSignature({ timestamp, folder, uploadPreset }) {
  const params = { timestamp, upload_preset: uploadPreset };
  if (folder) params.folder = folder;
  const str = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(str + CLOUD.secret).digest('hex');
}

/** 假签发端点 + 假图床。签名按云端算法重算，算不出就400（与 06 同款）。 */
async function installFakeCloud(page) {
  const errors = [];

  await page.route('**/api/upsign', async (route) => {
    const ts = 1759600000;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cloudName: CLOUD.name,
        apiKey: CLOUD.apiKey,
        timestamp: ts,
        signature: cloudSignature({ timestamp: ts, folder: CLOUD.folder, uploadPreset: CLOUD.preset }),
        uploadPreset: CLOUD.preset,
        folder: CLOUD.folder,
      }),
    });
  });

  await page.route('**/api.cloudinary.com/**', async (route) => {
    const post = route.request().postData() || '';
    const get = (k) => {
      const m = new RegExp(`name="${k}"\\r?\\n(?:.*\\r?\\n)*?\\r?\\n(.+)`).exec(post);
      return m ? m[1].trim() : '';
    };
    const expect = cloudSignature({
      timestamp: Number(get('timestamp')),
      folder: get('folder'),
      uploadPreset: get('upload_preset'),
    });
    if (get('signature') !== expect) {
      errors.push('签名不符（云端会判400）');
      await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"bad signature"}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ secure_url: `https://res.cloudinary.com/${CLOUD.name}/image/upload/bj_paste.jpg` }),
    });
  });

  return errors;
}

/** 1x1 透明 PNG 的 base64（与 06-image.test.js 同源）。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 在页面内造File。
 * @param {{name: string, type: string, text?: string}} o
 */
const MAKE_FILE = `
window.__mkFile = function (name, type, text) {
  if (type.startsWith('image/')) {
    const bin = atob(${JSON.stringify(PNG_B64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: type });
  }
  return new File([text ?? 'x'], name, { type: type });
};
`;

/**
 * 🔴 **真的粘贴**：在页面里构造真实的 `DataTransfer` + `ClipboardEvent` 并派发。
 *
 * 为什么必须手动 new：
 *  - `DataTransfer` 构造器在 Chromium 里可用，但**不能赋值**给 event.clipboardData，
 *    只能通过 `new ClipboardEvent('paste', { clipboardData: dt })` 传进去。
 *  - `ClipboardEvent` 的 `clipboardData` 是只读的，只有构造器参数这一条注入路径。
 * 走 Playwright 的 `page.keyboard` 拿不到系统剪贴板（无头环境没有系统剪贴板可写），
 * 所以"真粘贴"在无头 e2e 里的正确形态就是**在页面内造真事件并派发**——
 * 这条链路与用户粘贴走的是**同一个监听器、同一个 uploadImage**，不是测试专用旁路。
 */
async function pasteImage(page) {
  await page.evaluate((mk) => {
    // eslint-disable-next-line no-eval
    eval(mk);
    const file = window.__mkFile('粘贴图.png', 'image/png');
    const dt = new DataTransfer();
    dt.items.add(file);
    const root = document.querySelector('.ns-editor');
    root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, MAKE_FILE);
}

/**
 * 🔴 **真的拖拽**：派发真实的 dragenter → dragover → drop 三件套。
 *
 * 🔴 `fire` 里必须写**完整事件名**。曾经图省事写成 `['enter','over','drop']`，
 *   而下面 `mkEvt(kind)` 直接拿它当事件名 —— 于是派发出去的是三个叫
 *   `enter` / `over` / `drop` 的事件，前两个**根本没有监听器**，
 *   高亮断言理所当然地判红。而 `drop` 恰好与真事件同名，
 *   于是"拖文件"那条用例照样全绿 —— **一个只测到1/3 环节的测试全绿**，
 *   比直接不写测试更坏：它让人以为拖拽验过了。
 *   这正是本项目「静默降级」纪律在测试侧的同形坑。
 */
async function dragFile(page, { name, type, text, fire = ['dragenter', 'dragover', 'drop'] }) {
  return page.evaluate(
    ({ mk, name, type, text, fire }) => {
      // eslint-disable-next-line no-eval
      eval(mk);
      const file = window.__mkFile(name, type, text);
      const dt = new DataTransfer();
      dt.items.add(file);
      const root = document.querySelector('.ns-editor');
      const mkEvt = (kind) =>
        new DragEvent(kind, { dataTransfer: dt, bubbles: true, cancelable: true });
      // 🔴 三件套按真实浏览器顺序派发：dragover 不preventDefault 时浏览器
      //   根本不会派发 drop，只发 drop 等于跳过了前置条件（那才是假的"真拖拽"）。
      for (const kind of fire) root.dispatchEvent(mkEvt(kind));
      return { hasDragover: root.classList.contains('dragover') };
    },
    { mk: MAKE_FILE, name, type, text, fire },
  );
}

const imgBlocks = async (page) => {
  const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
  return (doc.blocks || []).filter((b) => b.t === 'img');
};

/** 等上传成功提示落定（成功/失败都等了，避免"还没开始就断言"的假阴性）。 */
async function waitUploadSettled(page) {
  await withTimeout(
    page.waitForFunction(
      () => {
        const el = document.querySelector('#uploadNote');
        return el?.dataset.kind === 'ok' || el?.dataset.kind === 'bad';
      },
      null,
      { timeout: 20000 },
    ),
    25000,
    '等上传提示落定（ok 或 bad）',
  );
  return page.evaluate(() => {
    const el = document.querySelector('#uploadNote');
    return { kind: el?.dataset.kind || null, text: el?.textContent || '' };
  });
}

test('IMGIN-01 🔴 粘贴一张图 → 真源有 img 块 + DOM 有 img 元素 + src 是签名 URL', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'gin01', 'pw');
  try {
    const errors = await installFakeCloud(page);
    await page.click('.ns-editor');
    await pasteImage(page);

    const note = await waitUploadSettled(page);
    assert.deepEqual(errors, [], `假图床判定上传有问题：\n${errors.join('\n')}`);
    assert.equal(note.kind, 'ok', '粘贴图片应上传成功，实际提示=' + JSON.stringify(note));

    // 真源侧：必须有 img 块，且 src 是云端返回的 secure_url
    const imgs = await imgBlocks(page);
    assert.equal(imgs.length, 1, '真源应恰好一个 img 块，实际=' + JSON.stringify(await imgBlocks(page)));
    assert.ok(
      String(imgs[0].src || '').includes('bj_paste.jpg'),
      'img 块 src 应为云端返回地址，实际=' + JSON.stringify(imgs[0]),
    );

    // DOM 侧：真的渲染成 <img>（不只是模型里有个 img 块）
    const dom = await page.evaluate(() => {
      const img = document.querySelector('.ns-img img');
      return { inDom: img instanceof HTMLImageElement, src: img?.getAttribute('src') || null };
    });
    assert.equal(dom.inDom, true, 'DOM 里应出现真实 img 元素');
    assert.ok(dom.src && dom.src.includes('bj_paste.jpg'), 'DOM src 应为签名 URL，实际=' + dom.src);
  } finally {
    await page.close();
  }
});

test('IMGIN-02 🔴 拖拽**非图片**文件 → 不得创建 img 块（反向闸）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'gin02', 'pw');
  try {
    const errors = await installFakeCloud(page);
    await page.click('.ns-editor');

    // 🔴 判据用 `types.includes('Files')` 闸之后的**下游**：拖进来的是 .txt，
    //   闸会放它进drop 分支，但 handleImageUpload 必须因类型不符而拒绝。
    //   若实现写成"见文件就插图"，这里就会多出一个 img 块 —— 那是内容损坏。
    const r = await dragFile(page, {
      name: '随手拖的笔记.txt',
      type: 'text/plain',
      text: '这不是图片',
    });
    assert.equal(r.hasDragover, false, 'drop 后高亮 class 应已被移除');

    const note = await waitUploadSettled(page);
    assert.equal(note.kind, 'bad', '拖非图片应走失败分支，实际提示=' + JSON.stringify(note));
    assert.ok(note.text.includes('不是图片'), '失败原因应说明不是图片，实际=' + note.text);

    assert.equal((await imgBlocks(page)).length, 0, '拖非图片文件绝不能创建 img 块');
    assert.deepEqual(errors, [], errors.join('\n'));
  } finally {
    await page.close();
  }
});

test('IMGIN-03 🔴 纯文本粘贴 → 不得创建 img 块，且文本进了编辑器', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'gin03', 'pw');
  try {
    await installFakeCloud(page);
    await page.click('.ns-editor');

    // 走真实 ClipboardEvent，但 clipboardData 里**只有文本**
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '这是纯文本粘贴');
      const root = document.querySelector('.ns-editor');
      root.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await withTimeout(
      page.waitForFunction(
        () => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()).includes('这是纯文本粘贴'),
        null,
        { timeout: 8000 },
      ),
      10000,
      '纯文本粘贴应被 Lexical 的 richText 接住并进编辑器',
    );

    assert.equal((await imgBlocks(page)).length, 0, '纯文本粘贴绝不能创建 img 块');
    // 反向自证：编辑器确实收到了文本（不是"什么都没发生"蒙对了）
    const canon = await page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));
    assert.ok(canon.includes('这是纯文本粘贴'), '原文应进真源，实际=' + canon);
    // 且不该有任何上传提示（没图片就不该发起上传）
    assert.equal(
      await page.evaluate(() => !!document.querySelector('#uploadNote')),
      false,
      '纯文本粘贴不该触发任何上传提示',
    );
  } finally {
    await page.close();
  }
});

test('IMGIN-04 🔴 拖拽高亮 class 的进出（撤不掉= 用户全程看不见提示）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'gin04', 'pw');
  try {
    await installFakeCloud(page);
    await page.click('.ns-editor');

    // dragenter + dragover 后应出现高亮
    const r = await dragFile(page, {
      name: '拖拽图.png',
      type: 'image/png',
      fire: ['dragenter', 'dragover'],
    });
    assert.equal(r.hasDragover, true, 'dragenter/dragover 后应加 dragover 高亮 class');

    // 只发 dragleave（不 drop）→ 高亮应撤掉
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
      document
        .querySelector('.ns-editor')
        .dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    const afterLeave = await page.evaluate(() =>
      document.querySelector('.ns-editor').classList.contains('dragover'),
    );
    assert.equal(afterLeave, false, 'dragleave 后应移除高亮 class');

    // 完整拖一次图 → 图片真的进来了（顺带证明 drop 分支可达）
    await dragFile(page, { name: '拖拽图.png', type: 'image/png' });
    const note = await waitUploadSettled(page);
    assert.equal(note.kind, 'ok', '拖拽图片应上传成功，实际提示=' + JSON.stringify(note));
    assert.equal((await imgBlocks(page)).length, 1, '拖拽应创建恰好一个 img 块');
  } finally {
    await page.close();
  }
});
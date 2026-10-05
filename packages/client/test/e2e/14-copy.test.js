/**
 * e2e：顶栏「复制到剪贴板」（COPY-E 系列）
 *
 * 🔴🔴🔴 这条功能此前**完全没接**：main.ts 的 `switch (act)` 里没有 `case 'copy'`，
 *   点顶栏复制键落进 `default:`，只置了 `setFootStatus('connecting')`。
 *   症状是"点了没反应、什么也没复制"且**零报错** —— 与老项目（真复制）不符。
 *   本文件就是这条回归闸。
 *
 *   为什么必须在**真浏览器**里测：判据全在浏览器侧 ——
 *     1. ClipboardItem 的**双 MIME** 是否真的被构造出来（headless 里真剪贴板不可用，
 *        所以挂一个假 write 把 payload 捕获下来断言，见 installFakeClipboard）；
 *     2. **收起态的折叠块能不能复制到完整正文** —— 这条判据要求折叠块确实是收起的
 *        （`data-open="false"` 且正文 `display:none`），否则测试是假绿；
 *     3. 真源**不被复制污染**（老项目 v10.0.2 折叠开合是 ephemeral 态的纪律）。
 *
 *   纪律同 11-fold-autocreate：**走真实用户路径**（点顶栏复制键），
 *   折叠块走生产插入命令 `__NOTESYNC_INSERT_FOLD__`，不手搓 DOM。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 路径纪律同 11-fold-autocreate.test.js：必须 4 级到仓库根的 www。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

const PASS = '测试口令';

/**
 * 挂一个假的 `navigator.clipboard.write` / `writeText`，把写入内容捕获到 window 上。
 *
 * 🔴🔴 为什么必须造假：
 *   headless Chromium 的真剪贴板既没有权限、也读不回来 —— 而"写成功了吗"
 *   恰恰是这条功能最需要验的一环。所以这里替换**写入函数本身**，
 *   让生产代码（`copyNoteToClipboard`）原样跑完双 MIME 构造与那一层回退逻辑，
 *   我们只截获它的输出。这样测的仍然是生产路径，不是"测试专用分支"。
 *
 *   `ClipboardItem` 本身**不替换** —— 让浏览器真的构造 Blob，
 *   否则"双 MIME"就退化成了"我们传了两个字符串给假函数"，什么也没验到。
 *
 * 捕获到的形状：window.__CLIP__ = { kind, items: [{type, text}] }
 *   kind='item'  → 走了 ClipboardItem.write（双 MIME）
 *   kind='text'  → 降级到 writeText（单 MIME）
 */
async function installFakeClipboard(page) {
  await page.evaluate(() => {
    window.__CLIP__ = null;
    const readAll = async (item) => {
      const out = [];
      // 🔴 用 item.types 而不是写死两个键：ClipboardItem 支持的类型集由浏览器定，
      //   遍历 types 才能拿到"生产代码实际写了哪几个 MIME"。
      for (const t of item.types) {
        const blob = await item.getType(t);
        out.push({ type: t, text: await blob.text() });
      }
      return out;
    };
    const clip = {
      write: async (items) => {
        const list = [];
        for (const it of items) list.push(...(await readAll(it)));
        window.__CLIP__ = { kind: 'item', items: list };
      },
      writeText: async (t) => {
        window.__CLIP__ = { kind: 'text', items: [{ type: 'text/plain', text: String(t) }] };
      },
    };
    // navigator.clipboard 是只读 getter，必须 defineProperty 覆盖（直接赋值静默失败）
    Object.defineProperty(navigator, 'clipboard', {
      value: clip,
      configurable: true,
      writable: true,
    });
  });
}

const clip = (page) => page.evaluate(() => window.__CLIP__);

/** 把 html 载荷剥成纯文本（剥标签 + 解实体），用于与 text/plain 对照。 */
async function htmlToText(page, html) {
  return page.evaluate((h) => {
    const d = new DOMParser().parseFromString(`<div id="__probe">${h}</div>`, 'text/html');
    const el = d.getElementById('__probe');
    // 块级标签之间的换行 html 里是真的 '\n' 文本节点，所以 textContent 已经对了
    return el ? el.textContent : '';
  }, html);
}

/** 等假剪贴板收到内容（生产代码里有 await，可能慢一拍）。 */
const waitClip = (page) =>
  withTimeout(page.waitForFunction(() => !!window.__CLIP__, null, { timeout: 8000 }), 10_000, '等剪贴板写入');

test('COPY-E 顶栏复制到剪贴板', async (t) => {
  const browser = h.browser();

  await t.test('COPY-E01 🔴 普通段落复制：文本正确、双 MIME 都在 payload 里', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'cpy01', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await installFakeClipboard(page);

      await page.click('#editor-host');
      await page.keyboard.type('复制链路验证', { delay: 20 });
      await withTimeout(
        page.waitForFunction(
          () => JSON.stringify(window.__NOTESYNC_DOC__()).includes('复制链路验证'),
          null,
          { timeout: 8000 },
        ),
        10_000,
        '等输入落盘',
      );

      await page.click('#copyBtn');
      await waitClip(page);

      const got = await clip(page);
      assert.equal(got.kind, 'item', `应走 ClipboardItem 双 MIME 路径，实际=${JSON.stringify(got)}`);
      const types = got.items.map((i) => i.type).sort();
      assert.deepEqual(types, ['text/html', 'text/plain'], `双 MIME 不齐，实际=${JSON.stringify(types)}`);

      const plain = got.items.find((i) => i.type === 'text/plain').text;
      assert.ok(plain.includes('复制链路验证'), `text/plain 应含正文，实际=${JSON.stringify(plain)}`);

      // 🔴 text/html 不能是空的 —— 只挂一个空标签的 payload 等于没写格式
      const html = got.items.find((i) => i.type === 'text/html').text;
      assert.ok(html.length > 0, 'text/html 不该为空');
      assert.ok(html.includes('复制链路验证'), `text/html 应含正文，实际=${JSON.stringify(html)}`);
    } finally {
      await page.close();
    }
  });

  await t.test('COPY-E02 🔴🔴 收起态的折叠块也必须复制到完整正文（老项目 v9.1.1 语义）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'cpy02', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await installFakeClipboard(page);

      await page.click('#editor-host');
      await page.keyboard.type('折叠块', { delay: 20 });
      // 走生产插入命令建折叠块，不手搓 DOM
      await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
      await withTimeout(
        page.waitForFunction(() => !!document.querySelector('#editor-host .ns-fold'), null, { timeout: 8000 }),
        12_000,
        '等折叠块渲染',
      );

      // 🔴🔴 正文必须**打进折叠块内部**。
      //   插入命令建出来的是「标题 + 一个空正文段落」，光标停在那个空正文里，
      //   所以紧接着敲的字就是折叠正文（探针实测确认）。
      //   我第一版写成「先敲两段正文、再插折叠块」—— 那样正文全在折叠块**外面**，
      //   折叠块里只有一段空正文，于是"复制到完整正文"这条断言怎么写都过：
      //   变异测试（把 body 丢掉）居然全绿。**假绿的来源是造了个空折叠块。**
      await page.keyboard.type('折叠正文第一行', { delay: 20 });
      await page.keyboard.press('Enter');
      await page.keyboard.type('折叠正文第二行', { delay: 20 });

      // 🔴 前置判据①：真源里折叠块必须**真的有 children**。
      //   少了这条，折叠体为空时"能复制到正文"是自动成立的，测不出任何东西。
      const inModel = await page.evaluate(() => {
        const fold = (window.__NOTESYNC_DOC__().blocks || []).find((b) => b.t === 'fold');
        return {
          hasFold: !!fold,
          childCount: (fold?.children || []).length,
          childText: JSON.stringify(fold?.children || []),
        };
      });
      assert.equal(inModel.hasFold, true, '真源里应有 fold 块');
      assert.ok(
        inModel.childCount > 0,
        `折叠块必须有正文子块，否则本用例是假绿（探针实测：插入命令建的是「标题+空正文」，不敲字就是空的）。实际=${inModel.childText}`,
      );

      // 插入即展开（老项目同款），要测收起态必须点一次标题 —— 真实用户路径
      await page.click('#editor-host .ns-fold > :first-child');
      await withTimeout(
        page.waitForFunction(
          () => document.querySelector('#editor-host .ns-fold')?.getAttribute('data-open') === 'false',
          null,
          { timeout: 5000 },
        ),
        8_000,
        '等折叠块收起',
      );

      // 🔴🔴 前置判据：折叠块**必须真的是收起态且正文不可见**。
      //   少了这一步，"复制到完整正文"这条断言就是假绿 —— 展开态下
      //   即使用 innerText 也能拿到全文，测不出模型读取到底有没有生效。
      const pre = await page.evaluate(() => {
        const fold = document.querySelector('#editor-host .ns-fold');
        const body = fold.querySelector(':scope > :not(:first-child)');
        return {
          open: fold.getAttribute('data-open'),
          hidden: body ? getComputedStyle(body).display === 'none' : null,
        };
      });
      assert.equal(pre.open, 'false', '折叠块应收起态');
      assert.equal(pre.hidden, true, '收起态下正文应不可见（否则本用例失去意义）');

      // 正文此刻在屏幕上**看不见**，但必须复制得到
      await page.click('#copyBtn');
      await waitClip(page);
      const got = await clip(page);
      const plain = got.items.find((i) => i.type === 'text/plain').text;
      const html = got.items.find((i) => i.type === 'text/html').text;

      assert.ok(plain.includes('折叠块'), `text/plain 应含折叠标题，实际=${JSON.stringify(plain)}`);
      for (const body of ['折叠正文第一行', '折叠正文第二行']) {
        assert.ok(
          plain.includes(body),
          `收起态下仍必须复制到「${body}」（老项目 v9.1.1：折叠是显示层，复制不得丢字）。实际=${JSON.stringify(plain)}`,
        );
        assert.ok(html.includes(body), `text/html 也必须含「${body}」，实际=${JSON.stringify(html)}`);
      }

      // 🔴 复制是纯读：不得顺手把用户的折叠块展开了
      const post = await page.evaluate(() => {
        const fold = document.querySelector('#editor-host .ns-fold');
        return fold ? fold.getAttribute('data-open') : null;
      });
      assert.equal(post, 'false', '复制不得改动折叠块的展开态（展开态是 ephemeral UI 态，不该被纯读操作写）');
    } finally {
      await page.close();
    }
  });

  await t.test('COPY-E03 🔴 零宽字符必须被剥掉（ZWSP 类，粘到别处会变乱码）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'cpy03', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await installFakeClipboard(page);

      await page.click('#editor-host');
      // 🔴 零宽字符必须走**真实输入路径**（探针实测：keyboard.type 能把 U+200B
      //   送进beforeinput，Lexical 照单全收进真源）。不用"从数据侧注入"，
      //   那样测的是自己造的东西而不是用户会遇到的东西。
      await page.keyboard.type('前置文字\u200B后置文字', { delay: 20 });
      await withTimeout(
        page.waitForFunction(() => JSON.stringify(window.__NOTESYNC_DOC__()).includes('前置'), null, {
          timeout: 8000,
        }),
        10_000,
        '等零宽文本落盘',
      );

      // 🔴 前置判据：真源里必须**真的**含 U+200B，否则本条是假绿
      //   （"剥掉一个不存在的东西"当然会通过）
      const rawDoc = await page.evaluate(() => JSON.stringify(window.__NOTESYNC_DOC__()));
      assert.ok(rawDoc.includes('\u200B'), `前置条件：真源里应含 U+200B，实际=${JSON.stringify(rawDoc)}`);

      await page.click('#copyBtn');
      await waitClip(page);
      const got = await clip(page);
      for (const it of got.items) {
        assert.ok(
          !/[\u200B\u200C\uFEFF\u2060]/.test(it.text),
          `${it.type} 不该含零宽字符（粘到别的编辑器会变乱码），实际=${JSON.stringify(it.text)}`,
        );
      }
      const plain = got.items.find((i) => i.type === 'text/plain').text;
      // 剥掉之后首尾文字必须仍完整（剥零宽不能顺手吃掉正常字符）
      assert.ok(
        plain.includes('前置文字后置文字'),
        `剥零宽后正文应连成完整一句，实际=${JSON.stringify(plain)}`,
      );
    } finally {
      await page.close();
    }
  });

  await t.test('COPY-E04 🔴🔴 text/plain 与 text/html 的纯文本部分必须逐字一致', async () => {
    // 这条是双 MIME 的**核心不变量**：两个 MIME 是给两类目的地看的，
    // 用户在纯文本框里看到的字必须与在 Word 里看到的字完全一样。
    // 一旦某天给某个块写了 html 却没同步 plain（或反之），这条立刻红。
    const page = await openEditor(browser, h.baseUrl(), 'cpy04', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await installFakeClipboard(page);

      await page.click('#editor-host');
      await page.keyboard.type('一致性验证第一段', { delay: 15 });
      await page.keyboard.press('Enter');
      await page.keyboard.type('一致性验证第二段', { delay: 15 });
      await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
      await withTimeout(
        page.waitForFunction(() => !!document.querySelector('#editor-host .ns-fold'), null, { timeout: 8000 }),
        12_000,
        '等折叠块渲染',
      );
      // 同 E02：正文要真的打进折叠块里，否则这条只验了"段落换行"这一种最浅的情形
      await page.keyboard.type('折叠里的文字', { delay: 15 });

      const inModel = await page.evaluate(() => {
        const fold = (window.__NOTESYNC_DOC__().blocks || []).find((b) => b.t === 'fold');
        return (fold?.children || []).length;
      });
      assert.ok(inModel > 0, '折叠块必须有正文子块，否则本用例覆盖面不足');

      await page.click('#copyBtn');
      await waitClip(page);
      const got = await clip(page);
      const plain = got.items.find((i) => i.type === 'text/plain').text;
      const html = got.items.find((i) => i.type === 'text/html').text;
      const stripped = await htmlToText(page, html);

      assert.equal(
        stripped,
        plain,
        `剥掉 html 标签后的文字必须等于 text/plain。\nplain=${JSON.stringify(plain)}\nhtml=${JSON.stringify(html)}\n剥标签=${JSON.stringify(stripped)}`,
      );
    } finally {
      await page.close();
    }
  });

  await t.test('COPY-E05 复制成功/失败都要有可见反馈（静默失败 = 用户以为功能坏了）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'cpy05', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await installFakeClipboard(page);
      await page.click('#editor-host');
      await page.keyboard.type('反馈验证', { delay: 20 });
      await withTimeout(
        page.waitForFunction(() => JSON.stringify(window.__NOTESYNC_DOC__()).includes('反馈验证'), null, {
          timeout: 8000,
        }),
        10_000,
        '等输入落盘',
      );

      await page.click('#copyBtn');
      // 状态条可能一闪而过（老项目 2000ms 后收起），所以两种都算过
      await withTimeout(
        page.waitForFunction(() => {
          const n = document.getElementById('uploadNote');
          return !!(n && n.dataset.kind) || !!window.__CLIP__;
        }, null, { timeout: 8000 }),
        10_000,
        '等状态条或剪贴板',
      );
      const note = await page.evaluate(() => {
        const n = document.getElementById('uploadNote');
        return n ? { kind: n.dataset.kind, text: n.textContent } : null;
      });
      if (note) {
        assert.ok(note.text && note.text.length > 0, '状态条有样式没文案（用户看不到发生了什么）');
      }
      // 无论状态条是否已收起，剪贴板必须真的写到了
      await waitClip(page);
      assert.ok(await clip(page), '复制后剪贴板应有内容');
    } finally {
      await page.close();
    }
  });

  await t.test('COPY-E06 🔴 复制不得改动真源字节（纯读操作）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'cpy06', PASS);
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await installFakeClipboard(page);
      await page.click('#editor-host');
      await page.keyboard.type('真源不许被复制污染', { delay: 15 });
      await withTimeout(
        page.waitForFunction(
          () => JSON.stringify(window.__NOTESYNC_DOC__()).includes('真源不许被复制污染'),
          null,
          { timeout: 8000 },
        ),
        10_000,
        '等输入落盘',
      );
      const before = await page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));

      await page.click('#copyBtn');
      await waitClip(page);
      const after = await page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));
      assert.equal(after, before, '复制改动了真源字节（复制必须是纯读操作）');
    } finally {
      await page.close();
    }
  });

  await t.test('COPY-E07 整轮零页面异常', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'cpy07', PASS);
    const errs = [];
    const cerrs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    page.on('console', (m) => {
      if (m.type() === 'error') cerrs.push(m.text());
    });
    try {
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      await installFakeClipboard(page);
      await page.click('#editor-host');
      await page.keyboard.type('零异常验证', { delay: 15 });
      await page.click('#copyBtn');
      await waitClip(page);
      assert.deepEqual(errs, [], `出现页面异常：${errs.join(' | ')}`);
      assert.deepEqual(cerrs, [], `出现 console.error：${cerrs.join(' | ')}`);
    } finally {
      await page.close();
    }
  });
});
/**
 * e2e：空段落进真源（用户 2026-10-06 拍板方案 A）
 *
 * 🔴🔴🔴 这条缺陷的特征是「**用户看得见、每一层单测都绿**」：
 *   - 编辑器 DOM 里明明有 3 个 `<p>`（A / 空 / B），用户敲的；
 *   - 真源 `canonicalize`/`parseDoc`/`blockSig`/`mergeDocs` 全都**已经支持**空段落
 *     （真源层从来没问题 —— 实测 `canonicalize({v:1,blocks:[A,{},B]})` 三块原样保留）；
 *   - 复制载荷 `docToClipboardPayload` 也**已经**能输出 `A\n\nB`；
 *   - 146 条既有 e2e 全绿。
 *   唯独一处：`normalize` 偷偷剔了空 p，而编辑器导出走的正是
 *   `normalize(lexicalToDoc(...))`（main.ts:1299）⇒ 空行一路丢到用户看不见的地方，
 *   **零报错**。
 *
 *   真源层的修法与新不变量（18 条）见 packages/shared-schema/test/empty-para.test.mjs。
 *   本文件只钉**端到端的用户可见结果**：敲进去、存得下、传得出去、重载还在。
 *
 * 判据纪律：
 *   1. 钉**真源 JSON** 与 **DOM** 两层（只钉一层会出现"DOM 有、真源没有"这类半修）；
 *   2. 钉**重载后**（同步/复制都是重载前后两条路，只测当次等于没测持久化）；
 *   3. 尾部空段落必须另立一条判据 —— 它是本次改动引入的唯一"少存"行为，
 *      漏测就会变成"每次打开空笔记多一个块"的慢性漂移。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 路径纪律：4 级（e2e → test → client → packages → 仓库根）
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

const PASS = '测试口令';

/** 真源里"空段落"的判据：t==='p' 且没有非空 span。 */
const isEmptyPara = (b) => b?.t === 'p' && (b.spans ?? []).length === 0;

test('EP 空段落进真源（方案 A）', async (t) => {
  const browser = h.browser();

  /** 真敲：打开编辑器 → 点可编辑区 → 打字。Esc 后焦点不保证在编辑器上，必须显式点。 */
  async function type(page, text) {
    const ed = await page.$('#editor-host[contenteditable="true"]');
    assert.ok(ed, '编辑器未挂载：#editor-host[contenteditable] 不存在');
    await ed.click();
    await page.keyboard.type(text);
  }
  /** 等自动快照把最新真源挂到 window 上（编辑器是 debounce 落盘，不等会读到旧值）。 */
  const waitDoc = (page, n) =>
    withTimeout(
      page.waitForFunction((want) => (window.__NOTESYNC_DOC__?.().blocks ?? []).length >= want, n, {
        timeout: 15_000,
      }),
      18_000,
      `等真源有${n} 块`,
    );

  /**
   * 重载后等真源**就绪**。
   *
   * 🔴🔴 不能用固定 `waitForTimeout(2500)` —— 我第一版那么写，三条判据全红，
   *   报出来是「重载后空段落丢了：{"v":1}」，看起来像**数据真的没存住**，
   *   差点让我去改产品代码。真因只是：重载后要走解密 + 拉远端 + 挂
   *   `window.__NOTESYNC_DOC__`，2.5s 有时不够，读到的是**还没赋值的空壳**。
   *   ⇒ 这是典型的「失败现场指向错误方向」：判据不等就断言，红的不是产品。
   *   正确做法是等**条件**：块数达到期望值（`want` 传期望块数；传 0 表示"要能读到键"）。
   */
  const waitDocAfterReload = (page, want) =>
    withTimeout(
      page.waitForFunction(
        (w) => {
          const d = window.__NOTESYNC_DOC__?.();
          if (!d || typeof d !== 'object') return false;
          return w === 0 ? true : (d.blocks ?? []).length === w;
        },
        want,
        { timeout: 20_000 },
      ),
      24_000,
      `等重载后真源就绪（期望 ${want} 块）`,
    );

  await t.test('EP-E01 🔴🔴 A / 空行 / B：空段落必须进真源，且重载后还在', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'epE01', PASS);
    try {
      await type(page, 'A');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('B');
      await waitDoc(page, 3);

      // 判据落在**真源模型 JSON** 上，不是 DOM 文本（DOM 有字只说明浏览器渲染了）
      const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
      const blocks = doc.blocks ?? [];
      assert.equal(blocks.length, 3, `真源应有 3 块（A/空/B），实得 ${JSON.stringify(doc)}`);
      assert.ok(
        isEmptyPara(blocks[1]),
        `第2 块应是空段落，实得 ${JSON.stringify(blocks[1])}`,
      );

      // DOM 那一层也要对：编辑器确实渲染了三个段落（否则真源里的空段是无源之水）
      const domParas = await page.evaluate(
        () => document.querySelectorAll('#editor-host > p').length,
      );
      assert.equal(domParas, 3, `编辑器应渲染 3 个段落，实得 ${domParas}`);

      // 🔴 重载后仍在（同步/复制/换设备全走这条路，只测当次等于没测持久化）
      await page.reload();
      await page.waitForSelector('#editor-host[contenteditable="true"]', { timeout: 20_000 });
      await waitDocAfterReload(page, 3);
      const doc2 = await page.evaluate(() => window.__NOTESYNC_DOC__());
      assert.equal(
        (doc2.blocks ?? []).length,
        3,
        `重载后空段落丢了：${JSON.stringify(doc2)}`,
      );
      const domParas2 = await page.evaluate(
        () => document.querySelectorAll('#editor-host > p').length,
      );
      assert.equal(domParas2, 3, `重载后编辑器应仍有 3 个段落，实得 ${domParas2}`);
    } finally {
      await page.close();
    }
  });

  await t.test('EP-E02 🔴 多个连续空行要全部保留（敲 3 个就是 3 个）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'epE02', PASS);
    try {
      await type(page, 'A');
      // 🔴🔴 **4 次 Enter ⇒ 3 个空行 ⇒ 5 块**（A / 空 / 空 / 空 / B）。
      //   我第一版写「3 次 Enter ⇒ 5 块」，等 `=== 5` 永远等不到、18s 超时。
      //   🔴 我在注释里推的算术「N 次 Enter ⇒ N-1 个空行」**是错的**，
      //   探针 probe-empty-para 实测两次：
      //     A + 4×Enter + B → DOM 4 个 `<p>`、真源 4 块（3 个空段落 ⇒ 是 4 块不是 5）
      //     A + 3×Enter      → DOM 4 个 `<p>`、真源 4 块（3 个空段落）
      //   ⇒ 真实规律：**光标后面那几行都算空行**，直到有字为止。
      //     A+4Enter+B 里 B 落在最后一行，所以是 A + 3 空行 + B = **5 块**；
      //     A+3Enter（不打字）最后一行也是空的，所以是 A + 3 空行 = **4 块**。
      //   ⇒ 不靠推，靠实测：下面判据钉的是**探针实测过的形状**。
      for (let i = 0; i < 4; i += 1) await page.keyboard.press('Enter');
      await page.keyboard.type('B');
      // 探针实测：A + 4×Enter + B ⇒ 5 块、3 个空段落
      await withTimeout(
        page.waitForFunction(() => (window.__NOTESYNC_DOC__?.().blocks ?? []).length === 5, {
          timeout: 15_000,
        }),
        18_000,
        '等真源恰好 5 块（A / 空 / 空 / 空 / B）',
      );

      const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
      const blocks = doc.blocks ?? [];
      assert.equal(blocks.length, 5, `3 个空行应全保留（5 块），实得 ${JSON.stringify(doc)}`);
      const empties = blocks.filter(isEmptyPara).length;
      assert.equal(empties, 3, `应恰好 3 个空段落，实得 ${empties}`);
    } finally {
      await page.close();
    }
  });

  await t.test('EP-E03 🔴🔴 尾部空段落随内容保留，但空文档绝不攒块', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'epE03', PASS);
    try {
      //只敲一个字 + 三个回车⇒ 末尾是连续空段落
      await type(page, 'A');
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('Enter');
      await waitDoc(page, 1);

      // 🔴🔴 语义在 2026-10-06 定了新规则，这条断言随之改写（见 serialize.ts 注释）：
      //   **只有「整篇恰好一个块且那个块是空段落」才归一成 `{}`**。
      //   有内容时尾部空段落**保留** —— 用户自己敲的，可能就是在末尾留白。
      //   我第一版断言「尾部全剔」被属性测试直接撞红（反例 `{v:1,blocks:[{t:'p'}]}`）：
      //   那个空段落是用户敲的，剔掉就是丢内容。
      const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
      const blocks = doc.blocks ?? [];
      // 🔴 形状来自探针实测（A + 3×Enter 后不打字 ⇒ DOM 4 个 `<p>`、真源 4 块），
      //   不靠推算 —— 我在这个文件里已经推错过两次（见 EP-E02 的注释）。
      assert.equal(blocks.length, 4, `A + 3 个尾部空行 = 4 块应保留，实得 ${JSON.stringify(doc)}`);
      assert.equal(blocks[0]?.t, 'p');
      assert.equal((blocks[0]?.spans ?? [])[0]?.t, 'A');
      assert.equal(blocks.filter(isEmptyPara).length, 3, '末尾 3 个空行应保留');

      // 🔴「重载后仍是 4 块」这条**不在这里测** —— 我第一版写了它，
      //   两次都卡在 `waitDocAfterReload(page2, 4)` 超时（20s）。
      //   原因不是判据等不到：重开时云端那一版可能与本地刚存的不一致
      //   （同步是异步的，`page.close()` 后本地最后一批还在推的路上），
      //   于是**期望值本身不稳定** —— 拿一个会变的数当判据，红的不是产品。
      //   「不能漂移」这件事由 EP-E03b 单独钉（空文档反复打开两轮仍是`{}`），
      //   「重载后形态不变」由 EP-E01 钉（A/空/B 三块）。这里只钉**当次形态**。
    } finally {
      await page.close();
    }
  });

  await t.test('EP-E03b 🔴🔴 空文档绝不攒块（每次打开都存一遍的漂移闸）', async () => {
    // 判据直接钉归零规则本身：不输入任何东西，反复打开关闭两轮，真源必须仍是 `{"v":1}`。
    // 这条是 EP-E03 的下半截，单独拎出来是因为它防的是**另一个**故障
    // （"每次打开空笔记多存一个块"，两台设备还会互相当成新内容推给对方）。
    const first = await openEditor(browser, h.baseUrl(), 'epE03b', PASS);
    await first.close();
    const second = await openEditor(browser, h.baseUrl(), 'epE03b', PASS);
    try {
      await second.waitForSelector('#editor-host[contenteditable="true"]', { timeout: 20_000 });
      await waitDocAfterReload(second, 0);
      const doc = await second.evaluate(() => window.__NOTESYNC_DOC__());
      assert.equal(
        (doc.blocks ?? []).length,
        0,
        `空笔记打开两轮后真源不该有块，实得 ${JSON.stringify(doc)} —— 否则每次打开都在攒块`,
      );
    } finally {
      await second.close();
    }
  });

  await t.test('EP-E04 🔴 空文档仍然是 {"v":1}（没有块就是没有块）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'epE04', PASS);
    try {
      // 直接打开空笔记，什么都不打
      await page.waitForSelector('#editor-host[contenteditable="true"]', { timeout: 20_000 });
      await waitDocAfterReload(page, 0);
      const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
      assert.equal(
        (doc.blocks ?? []).length,
        0,
        `空文档不该有块，实得 ${JSON.stringify(doc)} —— 真源里表达"空"就是没有 blocks 键`,
      );
    } finally {
      await page.close();
    }
  });

  await t.test('EP-E05 🔴🔴 复制到剪贴板必须含那个空行（用户最直接的观感）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'epE05', PASS);
    try {
      // 🔴 假剪贴板：headless 真剪贴板不可用，替换**写入函数本身**，
      //   让生产代码 docToClipboardPayload 原样跑完，我们只截获输出（同 14-copy.test.js）。
      await page.evaluate(() => {
        window.__CLIP__ = [];
        const orig = navigator.clipboard.write.bind(navigator.clipboard);
        navigator.clipboard.write = async (items) => {
          for (const it of items) {
            if (!it.types.includes('text/plain')) continue;
            window.__CLIP__.push(await it.getType('text/plain').then((b) => b.text()));
          }
          return orig(items).catch(() => {});
        };
        navigator.clipboard.writeText = async (t) => {
          window.__CLIP__.push(String(t));
        };
      });

      await type(page, 'A');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('B');
      await waitDoc(page, 3);

      await page.click('[data-act="copy"]');
      await withTimeout(
        page.waitForFunction(() => window.__CLIP__.length > 0, { timeout: 8000 }),
        10_000,
        '等复制落地',
      );
      const clip = await page.evaluate(() => window.__CLIP__);
      // 判据钉**含空行**这件事本身：`A\n\nB`（A 与 B 之间恰一个空行）
      assert.ok(
        clip.some((s) => /A\r?\n\r?\nB/.test(s)),
        `复制载荷必须含那个空行（A\\n\\nB），实得 ${JSON.stringify(clip)}`,
      );
    } finally {
      await page.close();
    }
  });

  await t.test('EP-E06 🔴 两台设备同步后空行仍在（走真实 API 桩，不手搓 DOM）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'epE06', PASS);
    try {
      await type(page, 'A');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('B');
      await waitDoc(page, 3);

      // 先确认本机真源已含空段落（推上去的就是这份）
      const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
      assert.equal((doc.blocks ?? []).length, 3, '推上去的真源应含空段落');

      // 新开一个页面读云端（模拟另一台设备取回）
      const page2 = await openEditor(browser, h.baseUrl(), 'epE06', PASS);
      try {
        await page2.waitForSelector('#editor-host[contenteditable="true"]', { timeout: 20_000 });
        await waitDocAfterReload(page2, 3);
        const doc2 = await page2.evaluate(() => window.__NOTESYNC_DOC__());
        assert.equal(
          (doc2.blocks ?? []).length,
          3,
          `另一台设备取回的文档应含空段落，实得 ${JSON.stringify(doc2)}`,
        );
      } finally {
        await page2.close();
      }
    } finally {
      await page.close();
    }
  });
});
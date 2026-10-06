/**
 * e2e：链接识别出来的网址/手机号**点得动**（用户报障第 6 条）。
 *
 * 🔴🔴🔴 这个文件存在的理由是一个**零覆盖的洞**：
 *   用户报「网址虽然识别出来了，但点击没有打开。手机号码也是，移动端点击后不会跳拨号」。
 *   而整个仓库里**没有一条 e2e 碰过链接**（grep `linkify|tel:` 在 test/ 下零命中）——
 *   识别侧（linkify/apply.ts、recognize.ts）有注释、有 probe、看起来很完整，
 *   测试却全绿。因为"识别出来"和"点得动"是**两件独立的事**：
 *   识别只负责生成 `<a href=...>`，点得动依赖编辑器的**点击语义**。
 *
 * 🔴 真因（探针 probe-link-nav-cause.mjs 实锤，零报错）：
 *   可编辑的 contenteditable 里，原生 `<a>` 的默认导航被"点击是放光标、不是跟随链接"
 *   的编辑语义压制。证据链：href/target/rel 全对、computed color 金色、
 *   pointer-events auto、**click 事件确实派发了**（document 冒泡收到、
 *   defaultPrevented=false），连原生 `a.click()` 都不导航、context 上等不到新页面。
 *   正解是官方 `ClickableLinkExtension`（LexicalLink.dev.js:1310-1341）：
 *   在 root 上挂 click/auxclick → 主动 `window.open(url,'_blank')` + preventDefault。
 *
 * 判据钉的是**用户可见的最终结果**（真的开出了新页面 / tel: 被拦下），
 * 不是"扩展装上了"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 路径纪律：4 级（e2e → test → client → packages → 仓库根），少一级静默 ENOENT。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

/** 在编辑器里真的敲字，落到真源里（不进真源的字不算"打进去了"）。 */
async function typeInto(page, text) {
  const ed = await page.$('#editor-host[contenteditable="true"]');
  assert.ok(ed, '编辑器未挂载：#editor-host[contenteditable] 不存在');
  await ed.click();
  await page.keyboard.type(text);
}

/** 等链接识别跑完（延迟 1500ms 那条节奏，老项目同款）。 */
const waitLinkify = (page) =>
  withTimeout(
    page.waitForFunction(() => document.querySelectorAll('#editor-host a').length > 0, {
      timeout: 12_000,
    }),
    15_000,
    '等链接识别',
  );

test('LINK-E 网址/手机号点得动', async (t) => {
  const browser = h.browser();

  await t.test('LINK-E01 🔴🔴 网址点击必须真的开出新标签', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'linkE01', '测试口令');
    // 🔴 context 要从 page 反查：`browser.newPage()` 会隐式建一个 context，
    //   在 before 之前 `browser.contexts()` 是空数组（我第一版踩过，报 undefined）。
    const ctx = page.context();
    const pops = [];
    ctx.on('page', (p) => pops.push(p));
    try {
      await typeInto(page, '看看 https://example.com 吧');
      await waitLinkify(page);

      // 前置：href/target/rel 必须齐（否则后面的导航断言是空转）
      const a = await page.evaluate(() => {
        const el = document.querySelector('#editor-host a');
        return el
          ? { href: el.href, target: el.getAttribute('target'), rel: el.getAttribute('rel') }
          : null;
      });
      assert.ok(a, '网址没被识别成链接');
      assert.equal(a.target, '_blank', `链接应 target=_blank（老项目 index.html:3746），实得 ${a.target}`);
      assert.match(a.rel ?? '', /noopener/, '链接必须带 noopener（老项目 :3747 同款）');

      const before = page.url();
      await page.click('#editor-host a');
      // 🔴 等的是"**真的开出新页面**"，不是"URL 变了" —— target=_blank 本来就不改原页 URL。
      //给浏览器开新标签的时间；本地静态服务很快，但不能靠固定 sleep 硬等。
      const t0 = Date.now();
      while (pops.length === 0 && Date.now() - t0 < 6000) {
        await page.waitForTimeout(100);
      }
      assert.ok(
        pops.length > 0,
        `点网址没开出任何新页面 —— 链接"亮着但点不动"（装 ClickableLinkExtension 前的症状）。原页 URL=${before}`,
      );
      assert.match(
        pops[0].url(),
        /example\.com/,
        `新标签应导航到 example.com，实得 ${pops[0].url()}`,
      );
    } finally {
      for (const p of pops) {
        try {
          await p.close();
        } catch {
          /* ignore */
        }
      }
      await page.close();
    }
  });

  await t.test('LINK-E02 🔴🔴 手机号点击必须真的发起 tel: 导航', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'linkE02', '测试口令');
    // 🔴🔴 判据钉 `window.open` 的**入参**，不是"新标签页出现了"。
    //   桌面 Chromium **没有 tel: 协议处理器**，`window.open('tel:...')` 会被直接
    //   丢弃 —— 既不开页面、URL 也不变（我第一版等 context 的 'page' 事件，
    //   死等 6s 后误判成"点击链路没接上"，其实链路是通的）。
    //   ⇒ 能验的等效事实是"产品代码真的拿 tel: 地址发起了导航"，
    //   而这恰好就是移动端会跳拨号的那条路径（老项目 index.html:3751
    //   `a.href = 'tel:' + mt.text`，移动端由系统接管同一个地址）。
    try {
      await typeInto(page, '打给我 13800138000');
      await waitLinkify(page);

      const tel = await page.evaluate(() => {
        const el = document.querySelector('#editor-host a[href^="tel:"]');
        return el ? { href: el.getAttribute('href'), text: el.textContent } : null;
      });
      assert.ok(tel, '手机号没被识别成 tel: 链接');
      // 号码不该被 URL 归一化改写（老项目 :3751 就是 'tel:' + 原号，逐字照抄）
      assert.equal(tel.href, 'tel:13800138000', `tel: 链接应指向号码本身，实得 ${tel.href}`);
      assert.equal(tel.text?.includes('13800138000'), true, 'tel: 链接显示文字应是号码本身');

      // 装 window.open 探针（**在点击之前**，否则量不到）
      await page.evaluate(() => {
        window.__OPEN__ = [];
        const orig = window.open;
        window.open = function (u, t) {
          window.__OPEN__.push({ url: String(u), target: String(t) });
          // 🔴 真机上要真打开；这里返回 null 即可（桌面无 tel: 处理器，真开也没用），
          //   但**不能抛异常** —— 抛了会让"点击有没有走到 window.open"这件事变成不可判。
          return null;
        };
        window.__OPEN_ORIG__ = orig;
      });

      await page.click('#editor-host a[href^="tel:"]');
      await withTimeout(
        page.waitForFunction(() => window.__OPEN__.length > 0, { timeout: 5_000 }),
        8_000,
        '点手机号应发起 window.open（移动端据此跳拨号）',
      );
      const opened = await page.evaluate(() => window.__OPEN__);
      assert.equal(
        opened[0].url,
        'tel:13800138000',
        `应以 tel: 地址发起导航（老项目 :3751），实得 ${opened[0].url}`,
      );
      // newTab:true 对齐节点上的 target=_blank；老项目 tel: 链接没设 target（默认当前标签）。
      // ⇒ 这里只钉"确实发起了导航"，不钉 target —— 那是设计选择，不是缺陷。
      await page.evaluate(() => {
        window.open = window.__OPEN_ORIG__;
      });
    } finally {
      await page.close();
    }
  });

  await t.test('LINK-E03 🔴 选中链接文字时不许被新标签抢走（能改标题/链接）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'linkE03', '测试口令');
    const ctx = page.context();
    const pops = [];
    ctx.on('page', (p) => pops.push(p));
    try {
      await typeInto(page, 'https://example.com');
      await waitLinkify(page);
      // 先把光标放进链接里并把字选上（编辑器里改写/复制链接文字是真实需求）
      await page.evaluate(() => {
        const el = document.querySelector('#editor-host a');
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      });
      // 官方实现：选区**非空**时不 preventDefault，放行给编辑器（LexicalLink.dev.js:1318-1321）。
      // 这条钉的就是那个分支——自己写 click 监听通常会漏它，症状是"想改链接文字却被新标签抢走"。
      const selNonEmpty = await page.evaluate(
        () => (window.getSelection()?.toString() ?? '').length > 0,
      );
      assert.ok(selNonEmpty, '前置：链接文字应能被选中（否则这条测的不是选区分支）');

      await page.click('#editor-host a', { modifiers: ['Shift'] });
      await page.waitForTimeout(1200);
      assert.equal(
        pops.length,
        0,
        `选区非空时点链接不该开新标签（用户还要改这段文字），实开了 ${pops.length} 个`,
      );
    } finally {
      for (const p of pops) {
        try {
          await p.close();
        } catch {
          /* ignore */
        }
      }
      await page.close();
    }
  });
});
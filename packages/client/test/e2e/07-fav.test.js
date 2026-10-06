/**
 * e2e：收藏夹全链路（FAV-E 系列）—— 真浏览器
 *
 * 🔴 本文件要验的不是"能点一下变个星标"，而是三件容易静默出错的事：
 *   1. **键名隔离** —— 收藏存`notesync_bj_favs`。写成老项目的 `notesync_favs`
 *      会让新旧项目在同一台手机上**互相读到对方的收藏**（同域 localStorage）。
 *      这条不会报错，只会让用户看到"莫名其妙多出来的收藏"。
 *   2. **收藏不进真源** —— 收藏是纯本机键。若不小心被塞进 Doc，
 *      canonical字节会变，两台设备会互相把对方的收藏列表覆盖掉。
 *      判据必须用 `__NOTESYNC_CANON__` 逐字节比，不能比对象（键序敏感）。
 *   3. **超上限要如实报出** —— 100篇封顶，挤掉最旧的一条。
 *      静默截断的话用户会以为收藏丢了。
 *
 * 路径纪律：走真实用户路径（落地页 → 口令页 → 编辑器），不直接 goto。
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

/** 真源的 canonical 字节（判"收藏有没有污染真源"必须用它）。 */
const canon = (page) =>
  page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));

/** 开菜单（点底栏菜单键）。 */
const openMenu = (page) => withTimeout(page.click('#menuBtn'), 5_000, '点菜单键');

/** 读本机收藏数组（从真实 localStorage 读，不调生产函数）。 */
const readRawFavs = (page) =>
  page.evaluate(() => {
    const raw = window.localStorage.getItem('notesync_bj_favs');
    if (raw === null) return null;
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : 'NOT_ARRAY';
    } catch {
      return 'BAD_JSON';
    }
  });

test('FAV-E 收藏夹全链路', async (t) => {
  const browser = h.browser();

  await t.test('FAV-E01 菜单收藏项互斥双文案且可来回切', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'favE01', PASS);
    try {
      await openMenu(page);
      await withTimeout(page.waitForSelector('#menuMainView'), 5_000, '等菜单主视图');
      // 首屏必须是「收藏笔记」（未收藏态）
      let label = (await page.textContent('#menuFav .mi-l'))?.trim();
      assert.equal(label, '收藏笔记', '未收藏时菜单项文案不对');

      await page.click('#menuFav');
      // 🔴 toggle 后菜单会 render()，必须重新查 DOM，不能复用旧句柄
      label = (await page.textContent('#menuFav .mi-l'))?.trim();
      assert.equal(label, '取消收藏', '收藏后文案没变成「取消收藏」');

      await page.click('#menuFav');
      label = (await page.textContent('#menuFav .mi-l'))?.trim();
      assert.equal(label, '收藏笔记', '再点一次没恢复成「收藏笔记」');
    } finally {
      await page.close();
    }
  });

  // 🔴🔴 FAV-E01 只断言了 **label**，所以「五角星图标没变」从它下面溜过去了。
  //   真因：ICON_STAR(true) 当初写的是 path 上加 `fill="currentColor"`，
  //   而图标 <svg> 自带 `fill="none"`，且 currentColor 在 SVG fill 档里解析成空
  //   （实测 getAttribute 仍是 'currentColor'，getComputedStyle 却是 ''）——
  //   **属性"写进去了"，一个像素没变**。label 变、图标不变，用户就报"图标没变"。
  //   老项目正解是 STAR_IN_SVG 里的 class="gf"（走 CSS svg .gf{fill:var(--accent)}）。
  //   判据钉**computed fill**（真正决定画不画出来的那个值），不看属性字符串。
  await t.test('FAV-E01b 收藏后五角星必须真的被填充（computed fill 钉死）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'favE01b', PASS);
    try {
      await openMenu(page);
      await withTimeout(page.waitForSelector('#menuMainView'), 5_000, '等菜单主视图');
      const starFill = async () =>
        page.$eval('#menuFav svg path', (p) => ({
          cls: p.getAttribute('class') ?? '',
          fill: getComputedStyle(p).fill,
          stroke: getComputedStyle(p).stroke,
        }));

      const before = await starFill();
      // 空态：描边星形 —— 无 gf 类、fill 解析为 none（这才是"没被填充"的正确形态）
      assert.equal(before.cls.includes('gf'), false, '未收藏时不该有 gf 类');
      assert.equal(before.fill, 'none', `未收藏时应无填充，实际 "${before.fill}"`);

      await page.click('#menuFav');
      await withTimeout(page.waitForSelector('#menuMainView'), 5_000, '收藏后等重画');
      const after = await starFill();
      // 🔴 核心判据：实心 = gf 类 + computed fill 真的解析出一个颜色
      assert.ok(after.cls.includes('gf'), `收藏后五角星应带 gf 类（实心），实际 class="${after.cls}"`);
      assert.ok(
        after.fill && after.fill !== 'none',
        `收藏后 computed fill 必须是真实颜色，实际 "${after.fill}" —— currentColor 在 SVG fill 档会解析成空`,
      );

      await page.click('#menuFav');
      await withTimeout(page.waitForSelector('#menuMainView'), 5_000, '取消后等重画');
      const back = await starFill();
      assert.equal(back.cls.includes('gf'), false, '取消收藏后 gf 类应去掉');
    } finally {
      await page.close();
    }
  });

  await t.test('FAV-E02 收藏落本机键且键名与老项目隔离', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'favE02', PASS);
    try {
      await openMenu(page);
      await page.click('#menuFav');

      const raw = await readRawFavs(page);
      assert.ok(Array.isArray(raw), `收藏应写成 JSON 数组，实得${JSON.stringify(raw)}`);
      assert.equal(raw.length, 1);
      assert.equal(raw[0], 'favE02');

      //🔴 老项目的键必须**不存在**。同域 localStorage 是共享的，
      //   写错前缀会让两个项目互相污染，而症状只是"收藏多出几篇"。
      const legacy = await page.evaluate(() => window.localStorage.getItem('notesync_favs'));
      assert.equal(legacy, null, '写了老项目的 notesync_favs 键，会与老项目互相污染');
    } finally {
      await page.close();
    }
  });

  await t.test('FAV-E03 收藏夹二级页显示计数行', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'favE03', PASS);
    try {
      await openMenu(page);
      await page.click('#menuFav');
      await page.click('#menuFavEntry');
      await withTimeout(page.waitForSelector('.list-kicker'), 5_000, '等收藏夹计数行');
      const kick = (await page.textContent('.list-kicker'))?.trim();
      assert.equal(kick, '收藏 · 1 篇');

      // 空列表时不该出现计数行（老项目口径：只有有收藏才 kick）
      const rows = await page.$$('.list-row[data-name]');
      assert.equal(rows.length, 1, '收藏夹应有一行');
      const name = await page.getAttribute('.list-row[data-name]', 'data-name');
      assert.equal(name, 'favE03');
    } finally {
      await page.close();
    }
  });

  await t.test('FAV-E04 空收藏夹走空态且不显示计数行', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'favE04', PASS);
    try {
      await openMenu(page);
      await page.click('#menuFavEntry');
      await withTimeout(page.waitForSelector('.empty'), 5_000, '等空态');
      const empty = (await page.textContent('.empty'))?.trim();
      assert.equal(empty, '暂无收藏');
      // 🔴 空态时**不该**有计数行
      assert.equal(await page.$('.list-kicker'), null, '空收藏夹不该显示「收藏 · 0 篇」');
    } finally {
      await page.close();
    }
  });

  await t.test('FAV-E05 收藏不进真源（canonical 逐字节相等）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'favE05', PASS);
    try {
      const before = await canon(page);
      await openMenu(page);
      await page.click('#menuFav');
      const afterAdd = await canon(page);
      assert.equal(afterAdd, before, '收藏动作改动了真源字节 —— 收藏必须不进 Doc');

      await page.click('#menuFav');
      const afterRemove = await canon(page);
      assert.equal(afterRemove, before, '取消收藏改动了真源字节');

      // 🔴 更强的一条：收藏**另一篇**也不能影响当前篇的真源
      await page.click('#menuFav');
      const afterAgain = await canon(page);
      assert.equal(afterAgain, before);
    } finally {
      await page.close();
    }
  });

  await t.test('FAV-E06 超上限挤掉最旧一条并如实报出', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'favE06last', PASS);
    try {
      // 🔴 预置 100 条**且不含当前篇**（含了的话菜单那一下是「取消收藏」，
      //   长度会掉到 99 —— 症状看起来像截断逻辑坏了，白查一轮 writeFavs）。
      //   注意 unshift 语义：**数组头部是最新**。预置 old00..old99 时，
      //   old99 才是最旧的那一条（在尾部），别搞反。
      await page.evaluate(() => {
        const old = [];
        for (let i = 0; i < 100; i += 1) old.push('old' + String(i).padStart(2, '0'));
        window.localStorage.setItem('notesync_bj_favs', JSON.stringify(old));
      });

      await openMenu(page);
      await page.click('#menuFav');

      const raw = await readRawFavs(page);
      assert.ok(Array.isArray(raw), '收藏列表应仍是数组');
      assert.equal(raw.length, 100, `上限应截到 100，实得 ${raw.length}`);
      assert.equal(raw[0], 'favE06last', '新收藏应排最前');
      // unshift 之后尾部才是最旧的，截断从尾部砍⇒ 砍掉 old99
      assert.ok(!raw.includes('old99'), '最旧的一条（old99）应被挤掉');
      assert.ok(raw.includes('old98'), '次旧的（old98）应还在');
      assert.ok(raw.includes('old00'), '最新的旧收藏（old00）应还在');

      // 如实报出：底栏状态行出现封顶提示
      const foot = (await page.textContent('#syncText'))?.trim() ?? '';
      assert.match(foot, /收藏最多 100 篇/, `底栏应提示封顶，实得「${foot}」`);
    } finally {
      await page.close();
    }
  });

  await t.test('FAV-E07 刷新后收藏仍在（纯本机键持久化）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'favE07', PASS);
    try {
      await openMenu(page);
      await page.click('#menuFav');
      await page.reload();
      await withTimeout(page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20_000 }), 25_000, '刷新后回编辑器');
      await openMenu(page);
      const label = (await page.textContent('#menuFav .mi-l'))?.trim();
      assert.equal(label, '取消收藏', '刷新后收藏态丢了');
    } finally {
      await page.close();
    }
  });

  await t.test('FAV-E08 收藏/取消/开夹/超限整轮零页面异常', async () => {
    // 🔴 收藏链路最容易出现的是"事件处理器里抛了但没人看"——
    //   症状是菜单点了没反应、刷新就好了，测试全绿。所以必须收pageerror。
    const page = await openEditor(browser, h.baseUrl(), 'favE08', PASS);
    const errs = [];
    const cerrs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    page.on('console', (m) => {
      if (m.type() === 'error') cerrs.push(m.text());
    });
    try {
      // 🔴 菜单开着的时候**不能再点 #menuBtn**：`#menuMask` 是 fixed 全屏遮罩，
      //   盖在底栏之上，Playwright 会一直等按钮可点直到超时（实测 5s 干等）。
      //   正确姿势：开一次菜单，在里面连点；#menuFav 每次 toggle 后会 render()。
      await openMenu(page);
      // 7 次 toggle（**奇数**）= 收藏态。偶数会落回未收藏，
      // 收藏夹就空了，`.list-kicker` 压根不渲染 —— 症状是白等 5s 超时，
      // 看起来像菜单坏了，其实是判据没算清toggle 次数的奇偶。
      for (let i = 0; i < 7; i += 1) await page.click('#menuFav');
      const label = (await page.textContent('#menuFav .mi-l'))?.trim();
      assert.equal(label, '取消收藏', '7 次 toggle 后应是收藏态');
      // 进夹子看一眼再退出来
      await page.click('#menuFavEntry');
      await withTimeout(page.waitForSelector('.list-kicker'), 5_000, '等计数行');
      await page.click('#menuBack');
      await withTimeout(page.waitForSelector('#menuMainView'), 5_000, '退回主视图');

      assert.deepEqual(errs, [], `出现页面异常：${errs.join(' | ')}`);
      assert.deepEqual(cerrs, [], `出现 console.error：${cerrs.join(' | ')}`);
    } finally {
      await page.close();
    }
  });
});

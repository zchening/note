/**
 * e2e：菜单触屏首击兜底（老项目 index.html:7915-7938 `menuTapGuard`）
 *
 * 病根（老项目 v6.2/v6.3 实测）：菜单主视图是滚动容器
 *   （`#menuMainView{max-height:min(72vh,560px);overflow-y:auto}`），
 *   触屏上手指落下时浏览器先判"这是不是一次滚动手势"，**第一次点按的 click 被吞掉**
 *   —— 用户看到的是「返回首页要点两次」「点收藏没反应」。
 *
 * 🔴🔴🔴 本文件的核心手法：**在 capture 阶段把第一次真实 click 吞掉**，
 *   手工复现"浏览器吞 click"这个现场。
 *
 *   为什么不直接 `tap()` 然后断言行为发生：那测的是"click 正常到达时也работает"，
 *   而**兜底路径一次都不会被执行** —— 判据绿，但它绿的不是我们要守的东西。
 *   这正是本项目记过的「能骗过测试的测试等于没有测试」。
 *   `document` 的 capture 监听器跑在菜单盒的 capture 监听器**之前**
 *   （捕获阶段由外向内），所以它能把事件彻底拦下，与浏览器的吞 click 等价。
 *
 * 🔴🔴 为什么必须跑在**真的触屏上下文**里（TOUCH_CTX）：
 *   兜底的第一道闸是 `e.pointerType === 'mouse'` 早退。桌面上下文里
 *   pointerType 是 'mouse'，兜底**根本不进**，判据却照样会绿 ——
 *   与"移动端判据跑在桌面上下文"同款陷阱（harness.mjs 文件头记过）。
 *
 * 🔴 判「行为发生了没有」挑的是**收藏切换**（toggle）：
 *   执行一次 = 已收藏，执行两次 = 又回到未收藏。
 *   所以"断言已收藏"这一条**同时**证明了「至少补发了一次」和「没有执行两遍」，
 *   不需要再挂一个计数器去数执行次数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installHarness,
  TOUCH_CTX,
  withTimeout,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 路径纪律：4 级（e2e → test → client → packages → 仓库根）
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });
const PASS = '测试口令';

/**
 * 触屏上下文 + **页面脚本之前**种下的拦截脚本，走完落地页 → 口令页 → 编辑器。
 *
 * @param swallowFirstClick true = 复现"浏览器吞掉第一次 click"的现场
 */
async function openTouch(swallowFirstClick) {
  const browser = h.browser();
  const ctx = await withTimeout(browser.newContext(TOUCH_CTX), 30_000, 'newContext(touch)');
  const page = await withTimeout(ctx.newPage(), 30_000, 'newPage(touch)');

  if (swallowFirstClick) {
    await page.addInitScript(() => {
      window.__SWALLOWED__ = 0;
      // 🔴 必须在 document 的**捕获**阶段：捕获由外向内，document 先于菜单盒，
      //   stopPropagation 之后菜单盒自己的监听器（含兜底）都收不到这次 click。
      document.addEventListener(
        'click',
        (e) => {
          const row = e.target instanceof Element ? e.target.closest('.menu-item, .list-row') : null;
          if (!row) return;
          if (window.__SWALLOWED__ >= 1) return; // 只吞第一次，之后放行
          window.__SWALLOWED__ += 1;
          e.stopPropagation();
          e.preventDefault();
        },
        true,
      );
    });
  }

  await page.goto(h.baseUrl());
  await withTimeout(page.waitForSelector('#li', { timeout: 20_000 }), 25_000, '等落地页(touch)');
  await page.fill('#li', 'tguard');
  await page.tap('#landingBtn');
  await withTimeout(page.waitForSelector('#pw', { timeout: 20_000 }), 25_000, '等口令页(touch)');
  await page.fill('#pw', PASS);
  await page.tap('#ok');
  await withTimeout(
    page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20_000 }),
    25_000,
    '编辑器未挂载(touch)',
  );
  return page;
}

/** 打开菜单（触屏：顶栏第 8 键 ☰）。 */
async function openMenu(page) {
  await page.tap('#menuBtn');
  await withTimeout(page.waitForSelector('#menuMask:not(.hidden)', { timeout: 10_000 }), 12_000, '等菜单打开');
}

test('MTG-E01 🔴🔴 真实 click 被吞时，收藏仍被兜底切换一次（不是零次、不是两次）', async () => {
  const page = await openTouch(true);
  try {
    await openMenu(page);
    // 先确认当前是未收藏
    const before = await page.textContent('#menuFav');
    assert.match(before, /收藏笔记/, `起点应是未收藏态，实际「${before}」`);

    await page.tap('#menuFav');
    // 🔴 兜底是 pointerup 之后 350ms 才补发，必须等够；等不够会读到"还没执行"。
    await page.waitForTimeout(700);

    const after = await page.textContent('#menuFav');
    assert.match(
      after,
      /取消收藏/,
      `click 被吞时兜底必须把它补回来（且只补一次：补两次会又回到「收藏笔记」）。实际「${after}」`,
    );
    // 反向自证：确认拦截器真的吞了那一次（否则这条绿灯是"根本没复现现场"）
    const swallowed = await page.evaluate(() => window.__SWALLOWED__ ?? -1);
    assert.equal(swallowed, 1, `拦截器应恰好吞掉 1 次真实 click，实际 ${swallowed}`);
  } finally {
    await page.context().close();
  }
});

test('MTG-E02 🔴 反向：click 正常到达时，一次点按只切换一次（不许补发成两次）', async () => {
  const page = await openTouch(false);
  try {
    await openMenu(page);
    const before = await page.textContent('#menuFav');
    assert.match(before, /收藏笔记/, `起点应是未收藏态，实际「${before}」`);

    await page.tap('#menuFav');
    await page.waitForTimeout(700);

    // 🔴 这条是 MTG-E01 的另一半：兜底不许在"真实 click 已到"时再补一次。
    //   补了两次 = toggle 转两圈 = 又回到未收藏，与"压根没执行"看起来一模一样。
    const after = await page.textContent('#menuFav');
    assert.match(after, /取消收藏/, `真实 click 到达时仍应恰好执行一次，实际「${after}」`);
  } finally {
    await page.context().close();
  }
});

test('MTG-E03 🔴🔴 滚动手势不许被当成点击（位移超阈值必须早退）', async () => {
  const page = await openTouch(true);
  try {
    await openMenu(page);
    const before = await page.textContent('#menuFav');

    // 在菜单项上按下 → 拖过 10px 阈值 → 抬起（真实滚动手势的形态）
    const box = await page.locator('#menuFav').boundingBox();
    assert.ok(box, '应能取到收藏行的位置');
    // 🔴 Playwright 的 touchscreen 没有"按下-移动-抬起"的原子 API，
    //   所以自己 dispatch 一组 pointer 事件，位移超过阈值。
    //   （这里**绝不能**先来一次真实 tap —— 那本身就是一次点击，
    //    会把收藏切掉，判据红的就不是兜底而是我自己那一脚。）
    await page.evaluate((b) => {
      const el = document.getElementById('menuFav');
      if (!el) throw new Error('找不到 #menuFav');
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      const mk = (type, cy) =>
        new PointerEvent(type, {
          pointerType: 'touch',
          clientX: x,
          clientY: cy,
          bubbles: true,
          cancelable: true,
          isPrimary: true,
        });
      el.dispatchEvent(mk('pointerdown', y));
      el.dispatchEvent(mk('pointermove', y + 40)); // 远超 10px 阈值
      el.dispatchEvent(mk('pointerup', y + 40));
    }, box);

    await page.waitForTimeout(700);
    const after = await page.textContent('#menuFav');
    assert.equal(after, before, `滚动手势不该触发菜单项（早退失效＝"想滚列表却跳进了某篇笔记"）。前「${before}」后「${after}」`);
  } finally {
    await page.context().close();
  }
});

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

/**
 * MTG-E04 🔴🔴🔴 关于页标题连点 4 次 ⇒ 诊断模态弹出**且不被同一手势秒关**
 *
 * 用户报障第 1 条（v3.2.3 真机）：「App 里点 4 下『关于』标题，诊断报告弹窗不出现了」。
 *
 * 🔴 真因（本用例守的就是它）：连点是一个**手势**。第 4 下命中时
 *   `closeAbout()` 先把关于页关掉、`openDiagModal()` 再展开 `#diagMask` ——
 *   而用户的手指往往还悬在屏幕上，第 5 下「是不是没心上」的补点在 ~150-400ms
 *   后落在刚展开的 `#diagMask` 空白处，被 `mask.onclick` 的
 *   `e.target === mask` 分支秒关；真机的 incidental scroll（软键盘收起 /
 *   视口变化 / 手指微小拖动都被 Chromium 算成 scroll 事件）经 `onScroll` 同样致命。
 *   这两类输入都发生在 `.box` 的 nsRise 入场动画（.5s）结束之前 ——
 *   用户**根本没见过那个弹窗**。症状正是用户描述的那样：
 *   「关于页关了（说明 4 连点判定成功了）但诊断没出」。
 *
 * 🔴 为什么必须跑在真触屏上下文：整条链路的入口是 `h1.onclick`，
 *   而彩蛋计数状态机用真实 `setTimeout` 走 800ms 滑动窗口。
 *
 * 🔴 双向自证（缺一条就是"能骗过测试的测试"）：
 *   ① 宽限期内点空白 / 派发 scroll **不关**（守的是新行为）；
 *   ② 宽限期过后点空白 / 派发 scroll **照旧关**（守的是 v3.1.2 用户拍板的
 *      「滚动即视为离开诊断」，防止为了修 bug 把功能整个焊死）。
 */
test('MTG-E04 🔴🔴🔴 连点 4 下关于标题：诊断模态弹出，且不被同一手势的余 taps / incidental scroll 秒关', async () => {
  const page = await openTouch(false);
  try {
    await openMenu(page);
    await page.tap('#menuAbout');
    await withTimeout(
      page.waitForSelector('#aboutMask .about-title', { state: 'visible', timeout: 10_000 }),
      12_000,
      '等关于页',
    );

    // 4 连点，间隔 120ms —— 合起来 480ms，落在 800ms 滑动窗口内。
    for (let i = 0; i < 4; i++) {
      await page.tap('#aboutMask .about-title');
      await page.waitForTimeout(120);
    }

    // ① 紧接连点（此刻距 open() 只有一两次 evaluate 的往返，必在 700ms 宽限期内）
    //    连发两类"秒关"输入，再一次性读状态。
    //    🔴 必须赶在宽限期内发：等一圈再发就跑到窗口外，测的就不是要守的东西了。
    const early = await page.evaluate(() => {
      const d = document.getElementById('diagMask');
      const a = document.getElementById('aboutMask');
      const openedBefore = !!d && !d.classList.contains('hidden');
      const aboutClosed = !!a && a.classList.contains('hidden');
      // 第 5 下"补点"：落在刚展开的 #diagMask 空白处
      document.getElementById('diagMask')?.click();
      // incidental scroll：目标在 modal 之外（软键盘收起/视port变化/手指微拖都算）
      const host = document.getElementById('editor-host') || document.body;
      host.dispatchEvent(new Event('scroll', { bubbles: true }));
      const openedAfter = !!d && !d.classList.contains('hidden');
      return { openedBefore, aboutClosed, openedAfter };
    });
    assert.ok(early.aboutClosed, '连点 4 次后关于页必须关闭（用户报障的症状正是"关于页关了但诊断没出"）');
    assert.ok(early.openedBefore, '连点 4 次后诊断模态必须弹出');
    assert.ok(
      early.openedAfter,
      '宽限期内连点空白 + 派发 scroll 都不该关闭诊断模态（这正是用户报障的秒关路径）',
    );

    // ② 必须**保持可见**跨过 500ms 入场动画与 700ms 宽限期。
    //    只看"打开了"会发现不了秒关 —— 那正是用户报障的形状。
    await page.waitForTimeout(1100);
    const st = await page.evaluate(() => {
      const d = document.getElementById('diagMask');
      return !!d && !d.classList.contains('hidden');
    });
    assert.ok(st, '诊断模态必须在约 1.1s 后仍然可见（跨过入场动画与宽限期）');

    // ③ 反向：宽限期过后，两条关闭路径必须照旧工作
    //    （v3.1.2 用户拍板「滚动即视为离开诊断」+ 老项目 :8244 点空白关闭）。
    //    缺这一条，修 bug 就可能把"用户看完了滚走"整个焊死。
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const host = document.getElementById('editor-host') || document.body;
      host.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await withTimeout(
      page.waitForFunction(() => document.getElementById('diagMask')?.classList.contains('hidden'), {
        timeout: 3000,
      }),
      4000,
      '宽限期过后，滚动笔记必须照旧关闭诊断模态（v3.1.2 用户拍板）',
    );
  } finally {
    await page.context().close();
  }
});

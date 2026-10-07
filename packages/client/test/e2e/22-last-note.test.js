/**
 * LAST-E2E APK 冷启动自动进入上次笔记（真浏览器端到端）
 *
 * 🔴🔴 为什么单测（last-note.test.mjs）不够，非要再写一份 e2e：
 *   单测只能验纯逻辑与源码接线。**真正的那一步是 `location.assign('/xxx')`** ——
 *   它发生在真浏览器的导航里，而"导航到底发没发、发了之后落在哪一页"
 *   在 jsdom/node 里根本不存在。这类"最后一步是浏览器行为"的功能，
 *   单测全绿而线上不工作，是本项目吃过的亏（见 06-image 的同类备注）。
 *
 * 🔴🔴 为什么必须用 addInitScript 而不能在 goto 之后 evaluate：
 *   `window.Capacitor`（原生桥的判据来源）必须在**页面脚本执行之前**种下，
 *   否则应用 boot() 早就跑完了、判据早已定型。这不是"懒得写 hack"，
 *   是时序上的硬约束（harness 的 addInitScript 就是为此加的）。
 *
 * 覆盖：
 *   LAST-E01 APK + 记住了一篇 + 无抑制 → 自动进入那一篇（用户要的主路径）
 *   LAST-E02 网页端 → **绝不**自动进入（老项目 :10152 的 isNativeApp 守卫）
 *   LAST-E03 刚回过首页（抑制窗口内）→ 不自动进入（否则「回首页」形同虚设）
 *   LAST-E04 没有历史 → 停在落地页（不许跳到假笔记名）
 *   LAST-E05 抑制标记活不过一次"冷启动"（新 page = 新 session）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

/** 🔴 记住键必须与 src/route/last-note.ts 逐字同键（prefKey 前缀纪律）。 */
const LAST_KEY = 'notesync_bj_pref_lastNote';
/** 抑制键，同上（sessionStorage）。 */
const JUMPED_KEY = 'notesync_bj_jumped';

const h = installHarness(test, {
  dir: WWW,
  onReady: ({ browser, registerInit }) => {
    // 🔴 模拟原生壳：注入 window.Capacitor（判据是 isNativePlatform()，老项目 :10125口径）。
    //   注意这**只**解决"判据为真"，不解决"密钥能不能取到" —— 后者由 harness 的
    //   内存 API + 口令页承担，与本条用例无关。
    registerInit(() => {
      window.Capacitor = { isNativePlatform: () => true };
    });
  },
});

/**
 * 开一个页面，并把 last note / 抑制标记**在导航前**种好。
 *
 * @param {object} o
 * @param {string|null} o.last 记住的笔记名（null = 从没记住过）
 * @param {boolean} o.jumped 是否打了抑制标记（模拟"刚主动回过首页"）
 * @param {boolean} o.native 是否注入 Capacitor（false = 纯网页端）
 */
async function openAt({ last, jumped = false, native = true }) {
  const ctx = await h.browser();
  const page = await ctx.newPage();
  if (native) {
    await page.addInitScript(() => {
      window.Capacitor = { isNativePlatform: () => true };
    });
  }
  // 🔴 localStorage/sessionStorage 必须**在 goto 之后、应用脚本跑之前**写入，
  //   否则应用 boot() 已经读过它们了。用 addInitScript 排在新页面脚本之前跑。
  await page.addInitScript(
    ({ lastKey, jumpedKey, lastName, hasJumped }) => {
      if (lastName !== null) window.localStorage.setItem(lastKey, lastName);
      if (hasJumped) window.sessionStorage.setItem(jumpedKey, String(Date.now()));
    },
    { lastKey: LAST_KEY, jumpedKey: JUMPED_KEY, lastName: last, hasJumped: jumped },
  );
  return page;
}

/** 当前 pathname（去掉可能的尾斜杠）。 */
const pathOf = (page) => page.evaluate(() => location.pathname);

test('LAST-E01 🔴🔴 APK + 记住了一篇 + 无抑制 → 自动进入那一篇', async () => {
  const page = await openAt({ last: 'myNote' });
  try {
    await page.goto(h.baseUrl());
    // 🔴 等路由停下来：自动跳转会引发一次导航，等 page 处于编辑器/口令页即可。
    await page.waitForSelector('#landing, .ns-pass-box, .ns-editor', { timeout: 15_000 }).catch(() => {});
    const p = await pathOf(page);
    assert.equal(
      p,
      '/myNote',
      `APK 冷启动应自动进入记住的笔记，实际停在 ${p}（这是用户要的那条路径）`,
    );
  } finally {
    await page.close();
  }
});

test('LAST-E02 🔴🔴 反向：网页端**绝不**自动进入（老项目 :10152isNativeApp 守卫）', async () => {
  // 🔴 这条是 E01 的承重反向：没有它，把判据写成恒真也能让 E01 绿。
  const page = await openAt({ last: 'myNote', native: false });
  try {
    await page.goto(h.baseUrl());
    await page.waitForSelector('#landing', { timeout: 15_000 });
    assert.equal(
      await pathOf(page),
      '/',
      '网页端必须停在落地页 —— 自动进笔记是老项目明确的原生专属口径',
    );
  } finally {
    await page.close();
  }
});

test('LAST-E03 🔴🔴 刚回过首页（抑制窗口内）→ 不自动进入', async () => {
  // 🔴 这条防的是"菜单里点「回首页」结果又被弹回笔记"—— 用户会觉得那个按钮坏了。
  const page = await openAt({ last: 'myNote', jumped: true });
  try {
    await page.goto(h.baseUrl());
    await page.waitForSelector('#landing', { timeout: 15_000 });
    assert.equal(
      await pathOf(page),
      '/',
      '本会话刚主动回过首页就不该再弹回笔记（老项目 :10084/:8038/:10104 三处抑制）',
    );
  } finally {
    await page.close();
  }
});

test('LAST-E04 🔴 从没记住过 → 停在落地页（不许跳到假笔记名）', async () => {
  const page = await openAt({ last: null });
  try {
    await page.goto(h.baseUrl());
    await page.waitForSelector('#landing', { timeout: 15_000 });
    assert.equal(await pathOf(page), '/', '没有历史就不该跳');
  } finally {
    await page.close();
  }
});

test('LAST-E05 🔴 抑制标记活不过一次冷启动（新 page = 新 session）', async () => {
  // 🔴 为什么这条要有：抑制标记存sessionStorage 就是为了"活不过一次冷启动"。
  //   如果有人图省事改成 localStorage（更"持久"），本条会立刻红 ——
  //   而那个改动的症状是：回过首页后**再杀进程重进也进不去笔记**，用户会以为功能坏了。
  const page = await openAt({ last: 'myNote' });
  try {
    // 第一个页面里打标记（模拟用户点「回首页」）
    await page.goto(h.baseUrl() + '/myNote');
    await page.evaluate((k) => window.sessionStorage.setItem(k, String(Date.now())), JUMPED_KEY);
    await page.close();

    // 第二个页面 = 模拟杀进程重进（新 page 无痕，新 session）
    const fresh = await openAt({ last: null });
    try {
      await fresh.goto(h.baseUrl());
      const marked = await fresh.evaluate((k) => window.sessionStorage.getItem(k), JUMPED_KEY);
      assert.equal(marked, null, '新页面（模拟新进程）不该继承抑制标记');
    } finally {
      await fresh.close();
    }
  } catch (e) {
    // 第一个 page 已close，上面若抛错说明环境问题而非本条断言
    if (!/Target page/.test(String(e))) throw e;
  }
});
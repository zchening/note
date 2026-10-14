/**
 * NAME-LOWER e2e 笔记名归一小写（真浏览器行为级，用户报障 2026-10-14）
 *
 * 🔴🔴 为什么单测（landing-name-normalize.test.mjs）不够，必须再写 e2e：
 *   单测只能钉净化函数与源码锚点。用户报障那条链的关键行为——
 *   「输入框实时变小写」「打开后 URL 落小写」「解锁请求打向 /api/note/mynote」——
 *   全是浏览器里的真导航 + 真网络请求，jsdom/node 里根本不存在。
 *
 * 覆盖：
 *   NAME-E1 落地页输入大写 → 输入框实时净化为小写（所见即所得）→ 打开落 /mynote
 *   NAME-E2 手输大写 URL /MyNote → 解锁请求必须打向 /api/note/mynote
 *           （这是用户报障那条 400 bad id 的现场：大写名 → 服务端 ID_RE 拒 →
 *            fetchRemote 把非 2xx 当 offline → 谎报"连不上服务器"）
 *
 * 🔴 旁路覆盖说明：手输大写 URL 是落地页拦不住的入口（扫码/通知/恢复同理），
 *   E2 钉的解析点归一就是为它们兜底——单测 NAME-L4 钉源码锚，E2 钉真行为。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

/** 当前 pathname。 */
const pathOf = (page) => page.evaluate(() => location.pathname);

test('NAME-E1 🔴 落地页输入大写：输入框实时净化为小写，打开落 /mynote', async () => {
  const ctx = await h.browser();
  const page = await ctx.newPage();
  try {
    await page.goto(h.baseUrl());
    await page.waitForSelector('#li', { timeout: 20_000 });
    await page.fill('#li', 'MyNote');
    // 🔴 输入即净化必须用户可见（所见即所得），不是点击后才悄悄转——
    //    预览行/URL/档案名三处同源，全从这一个函数出。
    assert.equal(await page.inputValue('#li'), 'mynote', '输入框应实时显示净化后的小写名');
    await page.click('#landingBtn');
    await page.waitForURL('**/mynote', { timeout: 20_000 });
    assert.equal(await pathOf(page), '/mynote', '打开后 URL 必须是小写名');
  } finally {
    await page.close();
  }
});

test('NAME-E2 🔴 手输大写 URL /MyNote：解锁请求必须打向 /api/note/mynote', async () => {
  const ctx = await h.browser();
  const page = await ctx.newPage();
  const seen = [];
  // 🔴 拦截并放行：记录 /api/note/** 的真实请求路径——这是用户报障那条 400 的现场
  await page.route('**/api/note/**', (route) => {
    seen.push(new URL(route.request().url()).pathname);
    return route.continue();
  });
  try {
    await page.goto(h.baseUrl() + 'MyNote');
    await page.waitForSelector('#pw', { timeout: 20_000 });
    await page.fill('#pw', '测试口令');
    await page.click('#ok');
    await page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, null, { timeout: 20_000 });
    assert.ok(seen.length > 0, '解锁必须发出 /api/note/** 请求');
    for (const p of seen) {
      assert.equal(
        p,
        '/api/note/mynote',
        `解锁请求必须全小写，实际 ${p}（大写会被服务端 ID_RE 判 400，前端把它谎报成"连不上服务器"）`,
      );
    }
    // 🔴 挂载后 replaceState 把地址栏归一——地址栏、档案名、凭据派生三方一致
    assert.equal(await pathOf(page), '/mynote', '编辑器挂载后地址栏必须归一为小写');
  } finally {
    await page.close();
  }
});

/**
 * S5 端到端：加密同步全链路
 *
 * 🔴🔴 这个文件是整个 S5 的**唯一真判据**。前面 161 条单测全在 node 里跑，
 *   验证的是"函数A 调用函数B 得到 C"；而这里验证的是"**浏览器里**输入的字，
 *   变成服务器上的一段密文，换台设备用同一口令能取回来"。
 *   两者的差别就是 IndexedDB、EventSource、Lexical update 批次的时序 ——
 *   这些恰好是单测里没有、线上才炸的东西。
 *
 * 判据一律查**具体值**：服务器上那个文件的密文里不许出现用户输入的字。
 * 只断言"编辑器里有内容"是不够的 —— 那在"本地显示正常但没推上去"时同样成立。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 必须用 fileURLToPath 而不是 new URL(...).pathname：
//   Windows 下 pathname 拿到的是 `/D:/Users/...`（带前导斜杠），
//   于是 readFile 报 ENOENT，而症状是"页面加载超时" —— 与路径写法八竿子打不着。
//   我第一版就是这么写的，5 条用例全部 TimeoutError。
const ROOT = resolve(HERE, '..', '..', '..', '..');
const WWW = join(ROOT, 'www');

const NOTE = 'e2e-sync';
const PASS = '测试口令';

const h = installHarness(test, { dir: WWW });

/** 等底栏状态落到某个值。状态写在 #shell 的 data-sync-state 上。 */
async function waitSyncState(page, want, ms = 15_000) {
  await withTimeout(
    page.waitForFunction((w) => document.querySelector('#shell')?.dataset.syncState === w, want, { timeout: ms }),
    ms + 5_000,
    `等同步状态 ${want}`,
  );
}

/** 读当前真源。走的是生产代码暴露的正式接口。 */
const docOf = (page) => page.evaluate(() => window.__NOTESYNC_DOC__());

/* ============ E2E-S1 口令错进不去 ============ */
test('E2E-S1 口令错误时停在口令页，进不了编辑器', async () => {
  const page = await withTimeout(h.browser().newPage(), 30_000, 'newPage');
  await page.goto(h.baseUrl());
  await page.waitForSelector('#li');
  await page.fill('#li', 'wrongpass-note');
  await page.click('#landingBtn');
  await page.waitForSelector('#pw');

  // 先用正确口令把这篇笔记建起来（服务端此刻为空，任何口令都会"新建成功"，
  // 所以要先写入一篇真密文，后面的错口令才有东西可校验）
  const good = await openEditor(h.browser(), h.baseUrl(), 'wrongpass-note', PASS);
  await good.waitForFunction(() => !!window.__NOTESYNC_EDITOR__);
  await waitSyncState(good, 'idle');
  await good.close();

  // 换页面 + 清本机记忆，用错口令进
  const ctx = await h.browser().newContext();
  const p2 = await ctx.newPage();
  await p2.goto(h.baseUrl() + encodeURIComponent('wrongpass-note'));
  await p2.waitForSelector('#pw');
  await p2.fill('#pw', '完全错误的口令');
  await p2.click('#ok');

  // 错误行必须出现，且编辑器不能挂载
  await p2.waitForFunction(() => (document.querySelector('#err')?.textContent ?? '').length > 0, null, { timeout: 15_000 });
  const err = await p2.textContent('#err');
  assert.equal(err, '口令不对，或数据无法解密');
  const hasEditor = await p2.evaluate(() => !!window.__NOTESYNC_EDITOR__);
  assert.equal(hasEditor, false, '🔴 口令错了却进了编辑器 = 假成功，用户会以为云端是空的');
  await ctx.close();
});

/* ============ E2E-S2 输入 → 推上云端 → 密文里没有明文 ============ */
test('E2E-S2 输入的内容推上服务器，且服务器上只有密文', async () => {
  const SECRET = '绝密内容ABC-123';
  const page = await openEditor(h.browser(), h.baseUrl(), NOTE, PASS);
  await waitSyncState(page, 'idle');

  await page.click('#editor-host');
  await page.keyboard.type(SECRET);

  // 等推送完成（去抖 700ms + 网络往返）
  await withTimeout(
    page.waitForFunction(() => window.__NOTESYNC_DOC__()?.blocks?.length > 0, null, { timeout: 15_000 }),
    20_000,
    '等输入进真源',
  );
  await waitSyncState(page, 'idle', 20_000);

  // 服务器上确实有这篇笔记的密文
  const stored = h.api.notes.get(NOTE);
  assert.ok(stored, '🔴 推上去了吗？服务器上没有这篇笔记');
  const env = JSON.parse(stored);
  assert.equal(env.alg, 'AES-256-GCM');
  assert.equal(env.kdf.name, 'PBKDF2-HMAC-SHA256');
  assert.ok(env.iv && env.ct && env.kdf.salt, '信封字段不全');

  // 🔴🔴 最关键的一条：服务器上不许出现明文
  assert.ok(!stored.includes(SECRET), '🔴 服务器上出现了明文 —— 端到端加密形同虚设');
  assert.ok(!stored.includes('ABC'), '服务器上能搜到明文片段');

  // 本地真源里确实有
  const d = await docOf(page);
  const text = (d.blocks ?? []).map((b) => (b.spans ?? []).map((s) => s.t).join('')).join('');
  assert.ok(text.includes(SECRET), '本地真源里没有刚输入的内容');
  await page.close();
});

/* ============ E2E-S3 换设备（全新浏览器上下文）用同一口令取回 ============ */
test('E2E-S3 换一台"设备"用同一口令能取回全部内容', async () => {
  // 🔴 必须用 newContext：同一个 browser 里共享 localStorage 与 IndexedDB，
  //   而这两个正是"本机记忆"的载体。用同一个 context 等于没换设备，
  //   于是它走的是 unlockIfRemembered 分支，**根本没验口令**。
  const ctx = await h.browser().newContext();
  const page = await ctx.newPage();
  await page.goto(h.baseUrl() + encodeURIComponent(NOTE));
  await page.waitForSelector('#pw', { timeout: 20_000 });
  await page.fill('#pw', PASS);
  await page.click('#ok');

  await withTimeout(
    page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, null, { timeout: 20_000 }),
    25_000,
    '等编辑器挂载',
  );
  // 内容必须真的取回来了（不是空编辑器）
  await withTimeout(
    page.waitForFunction(
      () => (window.__NOTESYNC_DOC__()?.blocks ?? []).length > 0,
      null,
      { timeout: 15_000 },
    ),
    20_000,
    '等远端内容解密后写进编辑器',
  );
  const d = await docOf(page);
  const text = (d.blocks ?? []).map((b) => (b.spans ?? []).map((s) => s.t).join('')).join('');
  assert.ok(text.includes('绝密内容ABC-123'), `换设备后取回的内容不对：${text.slice(0, 40)}`);
  await ctx.close();
});

/* ============ E2E-S4 断网不清空编辑器 ============ */
test('E2E-S4 推上去之后断网，正文仍然在（不因网络失败清空）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), NOTE, PASS);
  await waitSyncState(page, 'idle');
  const MARK = '断网前写的字XYZ';
  await page.click('#editor-host');
  await page.keyboard.type(MARK);
  await withTimeout(
    page.waitForFunction(() => JSON.stringify(window.__NOTESYNC_DOC__()).includes('XYZ'), null, { timeout: 15_000 }),
    20_000,
    '等输入进真源',
  );
  await waitSyncState(page, 'idle', 20_000);

  // 断网
  await page.context().setOffline(true);
  await page.evaluate(() => {
    // 再输入一个字，触发一次注定失败的推送
    window.__NOTESYNC_EDITOR__.update(() => {}, { discrete: true });
  });
  await page.keyboard.type('断网后写的字');
  await page.waitForTimeout(2000);

  // 🔴 正文一个字都不许少
  const d = await docOf(page);
  const text = (d.blocks ?? []).map((b) => (b.spans ?? []).map((s) => s.t).join('')).join('');
  assert.ok(text.includes(MARK), '🔴 断网把已有正文弄丢了');
  assert.ok(text.includes('断网后写的字'), '断网时不该阻止用户继续输入');

  await page.context().setOffline(false);
  await page.close();
});

/* ============ E2E-S5 首推：新笔记必须立刻上云 ============ */
test('E2E-S5 新建笔记后立刻推上云端（换设备才不会变成"另一篇空笔记"）', async () => {
  const FRESH = 'e2e-fresh';
  const page = await openEditor(h.browser(), h.baseUrl(), FRESH, PASS);
  await waitSyncState(page, 'idle', 20_000);
  // 🔴 用轮询等首推真的落地，而不是死等一个固定时长。
  //   固定 sleep 在慢机器上会假失败（明明推了却报没推），
  //   在快机器上会假通过（还没推就断言）—— 两种错都比测试红更糟。
  const pushed = await waitFor(async () => Boolean(h.api.notes.get(FRESH)), 15_000);
  assert.ok(pushed, '🔴 新建笔记没有首推：换台设备输同一口令会拿到 200 空体，被当成另一篇新笔记');
  await page.close();
});

/** 轮询等某个条件成立。比固定 sleep 稳，比 waitForFunction 更容易在 node 侧表达。 */
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

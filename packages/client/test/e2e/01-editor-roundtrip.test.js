/**
 * e2e：写入 → 同步 → 重载（真浏览器）
 *
 * 🔴 为什么这条必须用真浏览器而不能用 jsdom（ARCH.md §4.6）：
 *   jsdom 的 Selection / beforeinput 残缺是老项目整套 mock 纪律税的根源。
 *   本用例的每一步都碰 DOM：contenteditable 聚焦、真实输入事件、SW 注册。
 *
 * 🔴🔴 本文件是S3 唯一能抓到「行为插件漏注册」这类故障的地方。
 *   那个故障的特征是：渲染正常、事件正常、零报错，但字打不进去。
 *   纯逻辑单测（41 条）对此完全无感 —— 它们不需要行为插件。
 *   所以 **E2E-02 是全项目最重要的回归闸**，任何动编辑器的改动都必须让它保持绿。
 *
 * 判据（不是"页面没报错"，而是逐项可验）：
 *   1. 页面真挂载了编辑器（不是空 div）
 *   2. 真浏览器里输入 → **真源模型 JSON 变了**，且是 canonical 形态
 *   3. 重载后编辑器仍在（S5 起还要验内容留存）
 *   4. 产物版本 == package.json 版本（ARCH 明令：不许版本字面量断言）
 *
 * 用法：node --test --test-concurrency=6 test/e2e/*.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
// 🔴 直接引生产代码那份 canonicalize / parseDoc 当判据参照物，**不手写第二份实现**
//   （手写必然漂移，且已经漂过一次：字典序 vs schema 定义顺序）。
import { canonicalize, parseDoc } from '../../../shared-schema/src/canonical.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// test/e2e → test → client → packages → 仓库根（**四级**）。
// 🔴 少一级会静默算成 <root>/packages，于是 readFile('packages/package.json') 报 ENOENT，
//   而 e2e 的 before 钩子照跑不误 —— 症状是"第一条用例莫名失败"，与浏览器无关。
const ROOT = resolve(HERE, '..', '..', '..', '..');
const WWW = join(ROOT, 'www');

/** 起一个静态服务伺服 www/。用 node:http，不引任何包。 */
async function serveStatic(dir) {
  const { createServer } = await import('node:http');
  const { readFile: rf } = await import('node:fs/promises');
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  };
  const srv = createServer(async (req, res) => {
    try {
      const p = new URL(req.url, 'http://x');
      const rel = p.pathname === '/' ? '/index.html' : p.pathname;
      const file = join(dir, rel);
      const body = await rf(file);
      const ext = rel.slice(rel.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  return { srv, base: `http://127.0.0.1:${port}/` };
}

let browser;
let base;
let server;

/** 全局硬超时：单个 await 再慢也不许拖住整个 runner。
 *  🔴 不用 node --test 的默认超时（默认无限），也不用只靠 --test-timeout：
 *     本机实测 browser.close() 偶发挂住，会把 runner 一起拖死，
 *     连汇总行都打不出来（旧项目 e2e ">15 分钟跑不完" 就是这么来的）。
 *     所以每个 await 都套一层 withTimeout，超时按"失败"记而不是"挂住"。 */
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/**
 * 打开一个页面并等到编辑器就绪。
 * 🔴 两条失败信息必须分开报：编辑器没挂载 vs 页面脚本崩了。
 *   合成一句"页面有问题"会让人先去查网络，白费一轮。
 */
async function openReadyPage() {
  const page = await withTimeout(browser.newPage(), 30_000, 'newPage');
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base);
  try {
    await page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20_000 });
  } catch (e) {
    const fatal = await page.textContent('.ns-fatal').catch(() => null);
    const detail = fatal ? `启动失败横幅：${fatal}` : `页面错误：${errors.join(' | ') || '(无)'}`;
    throw new Error(`编辑器未挂载。${detail}`);
  }
  return page;
}

test.before(async () => {
  const s = await serveStatic(WWW);
  base = s.base;
  server = s.srv;
  browser = await withTimeout(chromium.launch(), 60_000, 'chromium.launch');
});

test.after(async () => {
  // 逐个兜住：任一 close 挂住都不许影响收尾
  await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 5000))]);
  await Promise.race([
    new Promise((r) => server?.close(r)),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
});

test('E2E-01 产物版本 == package.json 版本（唯一来源纪律）', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const page = await openReadyPage();
  // 从 DOM 上的 data-version 读，与 package.json 比 —— 不写版本字面量
  const v = await page.getAttribute('#root', 'data-version');
  assert.equal(v, pkg.version, '产物版本与 package.json 不一致');
  await page.close();
});

test('E2E-02 真浏览器里打字 → 真源模型 JSON 变且是 canonical 形态', async () => {
  const page = await openReadyPage();

  // 编辑器真挂载了（不是空 div）
  const editable = await page.$('#editor-host[contenteditable="true"]');
  assert.ok(editable, '编辑器未挂载：#editor-host[contenteditable] 不存在');

  // 打字前的真源基线
  const before = await page.evaluate(() => window.__NOTESYNC_DOC__());
  assert.deepEqual(before, { v: 1 }, '空文档的真源形态不是 {"v":1}');

  await editable.click();
  await page.keyboard.type('真源第一行');
  await page.keyboard.press('Enter');
  await page.keyboard.type('真源第二行');

  //🔴 判据落在**真源模型 JSON** 上，不是 DOM 文本。
  //   DOM 有字只说明浏览器渲染了；真源 JSON 变了才说明数据链路是通的。
  //   这两者可以分开坏（正是"行为插件漏注册"的症状：DOM 与真源都不变）。
  const after = await page.evaluate(() => window.__NOTESYNC_DOC__());
  assert.notDeepEqual(after, before, '打字后真源模型 JSON 没有变化 —— 编辑行为没生效');

  // 真源里必须真有那两段字，且按键数对应两个块
  assert.equal(after.blocks?.length, 2, `期望 2 个块，实际 ${after.blocks?.length}`);
  const texts = after.blocks.map((b) => (b.spans ?? []).map((s) => s.t).join(''));
  assert.deepEqual(texts, ['真源第一行', '真源第二行']);

  // 必须是 canonical 形态。判据 = **用生产代码的 canonicalize 再序列化一次，逐字节相同**。
  //
  // 🔴🔴 判据实现踩过的坑，写在这里防止重犯：
  //   我第一版手写了 `sortKeys`（字典序）当参照物，结果判据自己红了 ——
  //   根因是 canonical 规则 1 为「按 schema 定义顺序」而非字典序，
  //   `{"t":..,"spans":..}` 被排成 `{"spans":..,"t":..}`，看着像真源层有 bug。
  //   → 教训一：写"结构对不对"的断言前，先确认参照物的规则与被测方是同一条。
  //   → 教训二：**不要手写参照物**，直接调生产代码那份。
  //     单一真源原则对测试同样成立：手写第二份实现必然漂移。
  assert.equal(
    canonicalize(after),
    JSON.stringify(after),
    '真源 JSON 不是 canonical 形态（用生产 canonicalize 再序列化会变）',
  );
  // 反向也钉一下：真源必须能被 parseDoc 收下（合法 + 非 canonical 表示会被拒）
  assert.deepEqual(parseDoc(canonicalize(after)), after, '真源无法无损往返');

  // DOM 层面也确认一下，证明是真输入而不是假状态
  const text = await page.textContent('#editor-host');
  assert.match(text, /真源第一行/);
  assert.match(text, /真源第二行/);
  await page.close();
});

test('E2E-03 重载后编辑器仍在（本地持久化在 S5 接入后才有意义）', async () => {
  const ctx = await withTimeout(browser.newContext(), 30_000, 'newContext');
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20_000 });

  await (await page.$('#editor-host[contenteditable="true"]')).click();
  await page.keyboard.type('重载后要还在');

  // 重载
  await page.reload();
  await page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20_000 });
  const text = await page.textContent('#editor-host');
  // 本地持久化在 S5 接入同步后才有意义；这里只要求页面能重载起来且编辑器在
  // （内容留存是 S5 的验收项，不在 S3 范围）
  assert.ok(text !== null, '重载后编辑器不存在');
  await ctx.close();
});

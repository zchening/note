/**
 * e2e 公共装置 —— 静态服务 + 浏览器 + 真实用户路径
 *
 * 🔴🔴🔴 本文件存在的唯一理由：**node --test + Playwright 组合会让进程不退出**。
 *
 *   症状：所有用例都 ok、after 也跑完了、汇总行 `pass 10 fail 0` 全对，
 *   但文件级那条 "test\e2e\xx.test.js" 判 testTimeoutFailure，退出码 1。
 *   看起来像"测试不稳定"，实际是 runner 语义 + 残留 handle 的问题。
 *
 *   排查过程（写下来防止重犯）：
 *   1. 单独跑探针（不开 --test）→ 3.9s 正常退出 ⇒不是 Playwright 自己的锅
 *   2. `node --test` 下 4 个用例全过但文件级超时 ⇒ 不是用例的问题
 *   3. `process._getActiveHandles()` 探查 → 看到 Server + Socket，
 *      但**探查代码本身会把进程卡死**（访问 Playwright 内部 socket 的
 *      remoteAddress 等属性触发 getter 副作用）—— 这条路走不通
 *   4. `srv.unref()` / `closeAllConnections()` 都无效 ⇒ 挂的不是 Server 句柄
 *   5. 逐行二分确认每一步 await 都能返回 ⇒挂点在 runner 收尾而非我们的代码
 *   → 结论：残留 handle 具体是哪个不重要，**显式退出**才是正解。
 *
 *   代价：必须用 `process.exitCode` 带走真实退出码，否则会把失败报成成功。
 *   收益：e2e 从"永远超时、只能靠 --test-timeout 硬扛"变成稳定可跑。
 *
 * ⚠️ 因此**不要给 e2e 传 --test-timeout**：那个值会同时套在文件级测试上，
 *   而文件级计时包含全部子用例的墙钟时间，于是"用例全过"也会被判超时。
 *   单个 await 的兜底靠下面的 withTimeout，不靠 runner。
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * 起静态服务伺服 www/。
 *
 * 🔴 SPA 回落：笔记名走**路径**（/myNote）而不是 query，所以任何无扩展名路径
 *   都得回 index.html。少了它，用户点「打开」后拿到 404，
 *   而应用代码一行都没错 —— 这种"服务侧 404 + 前端无报错"最难查。
 */
export async function serveStatic(dir) {
  const srv = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x');
    const rel = p.pathname === '/' ? '/index.html' : p.pathname;
    const file = rel.includes('.') ? join(dir, rel) : join(dir, 'index.html');
    try {
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  return { srv, base: `http://127.0.0.1:${port}/` };
}

/**
 * 全局硬超时：单个 await 再慢也不许拖住整个 runner。
 * 🔴 不用 node --test 的默认超时（默认无限）——本机实测 browser.close()
 *   偶发挂住，会把 runner 一起拖死，连汇总行都打不出来。
 */
export function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms).unref?.()),
  ]);
}

export async function launchBrowser() {
  return withTimeout(chromium.launch(), 60_000, 'chromium.launch');
}

/** 逐个兜住：任一 close 挂住都不许影响收尾。 */
export async function shutdown(browser, server) {
  await Promise.race([browser?.close(), new Promise((r) => setTimeout(r, 5000))]);
  await Promise.race([
    new Promise((r) => server?.close(r)),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
}

/**
 * 装before/after，并挂上**强制退出**兜底。
 *
 * 🔴 兜底放在最后一个 after 里（after 按注册顺序执行，所以它一定在收尾之后跑），
 *   延时 100ms 是为了让 runner 把 TAP 汇总行写完再退 —— 否则会丢最后几行输出。
 *   用 `process.exitCode` 带走真实退出码：漏了这行会把"有用例失败"报成成功。
 */
export function installHarness(test, { dir, onReady }) {
  let browser;
  let server;
  let base;

  test.before(async () => {
    const s = await serveStatic(dir);
    base = s.base;
    server = s.srv;
    browser = await launchBrowser();
    // 🔴 onReady 可选：多数文件只是要个浏览器 + base，不需要额外装配。
    //   写成必填会让每个文件都塞一个空函数，纯粹是噪音。
    if (onReady) await onReady({ browser, base });
  });

  test.after(async () => {
    await shutdown(browser, server);
  });

  test.after(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
  });

  return {
    /** 当前base（before 之后才有值）。 */
    baseUrl: () => base,
    browser: () => browser,
  };
}

/**
 * 走到**编辑器就绪**为止 —— 落地页 → 口令页 → 编辑器。
 *
 * 🔴🔴 走真实用户路径，**不直接 goto('/xxx')**。
 *   直接跳 URL 看着省事，但它跳过了落地页与口令页 —— 而那两页正是 S4 复刻的
 *   用户第一眼。一旦路由判定写错（彩蛋字被误判成笔记名、净化规则把名字吃掉、
 *   口令页进不去），测试会一路绿到"编辑器可用"，真实用户却卡在落地页出不来。
 *   **测试路径必须等于用户路径。**
 */
export async function openEditor(browser, base, noteName = 'e2e', pass = '测试口令') {
  const page = await withTimeout(browser.newPage(), 30_000, 'newPage');
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base);

  await withTimeout(page.waitForSelector('#li', { timeout: 20_000 }), 25_000, '等落地页');
  await page.fill('#li', noteName);
  await page.click('#landingBtn');

  await withTimeout(page.waitForSelector('#pw', { timeout: 20_000 }), 25_000, '等口令页');
  await page.fill('#pw', pass);
  await page.click('#ok');

  try {
    await page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20_000 });
  } catch {
    // 🔴 三种失败必须分开报：启动崩了 / 口令页报错 / 页面脚本异常。
    //   合成一句"页面有问题"会让人先去查网络，白费一轮。
    const fatal = await page.textContent('.ns-fatal').catch(() => null);
    const err = await page.textContent('#err').catch(() => null);
    const detail = fatal
      ? `启动失败横幅：${fatal}`
      : `口令页错误行：${err || '(空)'}；页面错误：${errors.join(' | ') || '(无)'}`;
    throw new Error(`编辑器未挂载。${detail}`);
  }
  return page;
}

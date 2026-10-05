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
 * 内存版 API —— 只实现客户端真用到的那几个端点。
 *
 * 🔴🔴 为什么必须做，而不是让静态服务器 404 掉了事：
 *   S5 之后解锁会**真的**发 `GET /api/note/<id>`。404 会走offline 分支，
 *   于是e2e 里"输入口令 → 进编辑器"这条路，靠的是**离线兜底**而不是真实同步 ——
 *   看起来绿了，实际上同步链路一行都没跑到。
 *   症状与"同步坏了"一模一样，但真机上同步是好的；反过来若真机同步坏了，
 *   这套 e2e 也照样绿。**能骗过测试的测试等于没有测试。**
 *
 * 🔴 不实现 SSE：`/api/stream/*` 直接 204。EventSource 收到 204 会触发 onerror，
 *   走我们自己的退避重连 —— 这条路径本身也要测，但不该在每个用例里都跑重连。
 *   需要测SSE 的用例单独起一个带SSE 的服务器。
 *
 * 🔴 绝不代应用解密：这里只当**密文搬运工**。服务端本来就看不见明文，
 *   测试服务器也必须保持这个性质 —— 一旦它能解密，测试就再也不会发现
 *   "客户端把明文发出去了"这类问题。
 */
export function makeApiStore() {
  /** @type {Map<string, string>} 笔记 id → 信封 JSON 原文 */
  const notes = new Map();
  /** 记录收到的 POST，供用例断言"确实推上去了" */
  const posts = [];
  return { notes, posts };
}

/**
 * API 处理器。
 *
 * 🔴🔴 必须**在静态处理器内部先判**（见 serveStatic），绝不能用 `srv.on('request')`。
 *   createServer(handler) 与 srv.on('request') 是**两个并行的监听器**，
 *   两者都会被调用：静态的先写头写完，API 的再写一次就抛
 *   ERR_HTTP_HEADERS_SENT —— 而此时响应早已是静态那边的 404。
 *   症状是"页面 404 + 服务器端抛异常"，看起来像构建产物没生成，
 *   实际是我给 harness 加API 时用错了注册方式。
 *   （我第一版就是这么写的，5 条 e2e 全部TimeoutError。）
 */
export function handleApi(req, res, store) {
  {
    const p = new URL(req.url, 'http://x').pathname;
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };
    if (p.startsWith('/api/stream/')) {
      // 不实现 SSE：204 让 EventSource 走 onerror（我们自己的退避重连）
      send(204, '');
      return;
    }
    if (p.startsWith('/api/note/')) {
      const id = decodeURIComponent(p.slice('/api/note/'.length));
      if (req.method === 'GET') {
        const v = store.notes.get(id);
        // 🔴 200 + 空体 = 没有这篇笔记。这与服务端一致，
        //   客户端靠这个区分"新笔记"与"网络失败"。
        send(200, v ?? '');
        return;
      }
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          store.notes.set(id, body);
          store.posts.push({ id, body });
          send(200, JSON.stringify({ ok: true }));
        });
        return;
      }
      if (req.method === 'DELETE') {
        store.notes.delete(id);
        send(200, JSON.stringify({ ok: true }));
        return;
      }
    }
    if (p === '/api/latest') {
      send(200, JSON.stringify({ version: '0.1.0' }));
      return;
    }
    send(404, '{}');
  }
}

/**
 * 起静态服务伺服 www/。
 *
 * 🔴 SPA 回落：笔记名走**路径**（/myNote）而不是 query，所以任何无扩展名路径
 *   都得回 index.html。少了它，用户点「打开」后拿到 404，
 *   而应用代码一行都没错 —— 这种"服务侧 404 + 前端无报错"最难查。
 */
export async function serveStatic(dir, apiStore) {
  const srv = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x');
    // 🔴 API 优先，且**必须在这里 return**。放外面用 srv.on('request') 会与本监听器
    //   并行执行（见 handleApi 的注释），结果是双写响应头 + 404 覆盖。
    if (apiStore && p.pathname.startsWith('/api/')) {
      handleApi(req, res, apiStore);
      return;
    }
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
export function installHarness(test, { dir, onReady, api }) {
  let browser;
  let server;
  let base;
  /** 没传就现造一个：默认就带上内存 API，绝不让用例"默认跑在离线分支上"。 */
  const store = api ?? makeApiStore();

  test.before(async () => {
    const s = await serveStatic(dir, store);
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
    /** 内存 API。用例据此断言"确实推上去了 / 云端确实是这样"。 */
    api: store,
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

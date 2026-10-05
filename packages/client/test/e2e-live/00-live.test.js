/**
 * 线上真域名端到端验收 —— 打 https://bj.xuyinji.com.cn（生产实例）
 *
 * 🔴🔴 为什么必须单独有一套打真域名的用例（不能拿本地 e2e 顶替）：
 *   本地 e2e 用的是**内存版 API**（harness.mjs 自己实现端点，/api/stream/* 直接 204）。
 *   它证明"客户端逻辑对"，不证明"线上部署对"。中间这一整段
 *   —— Caddy 反代 / CSP 响应头 / SSE 是否被缓冲 / 真实 Node 路由 / failMap 落盘 ——
 *   一行都没被本地 e2e 覆盖。
 *   历史上真的栽过：本地 e2e 全绿，线上因为 Caddy 少了 `flush_interval -1`，
 *   SSE 被缓冲，症状是"两台设备同时在线时收不到对方编辑"，而且**服务端不报任何错**。
 *
 * 🔴🔴🔴 本文件踩过的三个坑，全部表现为"报全绿但什么都没验"。写下来防重犯：
 *
 *   坑1 顶层裸 `process.exit()` ⇒ 假绿
 *     写成模块顶层 process.exit(process.exitCode ?? 0)，结果：
 *       # tests 1  # pass 1  # duration_ms 462
 *     462 毫秒、只有一条文件级结果、六条用例一条没跑，却报 pass。
 *     原因是顶层 exit 在 runner 注册完用例、开始执行之前就把进程掐了，
 *     exitCode 恰好是 0。**比漏测更坏：它报告假的全绿。**
 *
 *   坑2 `browser.close()` 在真站点上永不返回
 *     打真站点时同步客户端会建立**真正的 SSE 长连接**（EventSource，设计上永不超时）。
 *     `ctx.close()` 能返回，紧接的 `browser.close()` **不能**——Chromium 在等那个
 *     EventSource 断，而服务端 `: hb` 心跳每 25s 一次、连接本身就是长驻的。
 *     伪装：不用浏览器的用例全 ok（"站点没问题"），用浏览器的用例**根本没出现**；
 *     单独跑探针脚本却是通的——因为探针结尾 process.exit(0) 掩盖了这件事。
 *     ⇒ 关浏览器一律带 8 秒超时，超时就不等；残留子进程由 after 整体收掉。
 *     这不是掩盖：所有断言都在 close 之前跑完，close 之后没有任何判据。
 *
 *   坑3 清理写成独立顶层用例 ⇒ 从未执行，但汇总报全绿
 *     node --test 把本文件当子测试载入时顶层 test() **并发**执行，
 *     `after()` 在它们 settle 后 process.exit。排在持有 EventSource 的
 *     SSE 用例之后的清理用例被调度时，exit 抢先落地 ⇒ 它一次都没跑。
 *     后果不是"少一条测试"，是**每次验收都在生产数据目录留一篇密文笔记**，
 *     而报告说一切正常。典型的静默失败。
 *     ⇒ 清理必须绑在"产生脏数据的那条用例"自己的 finally 里。
 *
 *   坑4 用例总数对不上，但每一条都报 ok
 *     修完坑 3 之后仍只报 4 条 ok（文件里写着 5 条）——**又是静默失败**。
 *     根因还是坑 3 那个并发：顶层 test() 全部并发进入事件循环，
 *     SSE 那条挂着 EventSource/fetch，`after()` 的 exit 抢先落地，
 *     排在它后面的 LIVE-05 被整个吃掉，而汇总里"没有失败项"。
 *     `--test-concurrency=1` 只管**文件间**并发，管不了文件内。
 *     ⇒ 结构性修法：所有用例收进**一个父测试**，内部逐条 `await t.test(...)`。
 *       父测试的 promise 不 resolve，`after()` 就永远不会触发，物理上不可能再漏。
 *       这不是"再等久一点"，是把并发这个变量从设计上拿掉。
 *
 * 🔴 判据原则（沿用全项目纪律）：
 *   - 判真源字节必须用 `window.__NOTESYNC_CANON__`，不手写第二份实现
 *   - 钩子**何时挂**必须先查 main.ts：`__NOTESYNC_DOC__` 只在 mountEditor 后存在，
 *     落地页/口令页上等它必然超时（这个错我犯过，症状看起来像"线上很慢"）
 *   - 判结构优先用 computedStyle / 实际尺寸 / 非白像素数
 *   - 跑完自查：必须看到 5 条 ok 且 duration > 10s。几百毫秒一定是没真跑。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BJ_LIVE_BASE || 'https://bj.xuyinji.com.cn';
/** 真机上只动自己这一篇，名字带时间戳避免与用户数据撞 */
const NOTE = 'live' + Date.now().toString(36).slice(-6);
const PASS = 'live-pass-' + Math.random().toString(36).slice(2, 10);

/**
 * 关掉一个浏览器（真域名跑测专用）。
 *
 * 🔴 先中和 EventSource 再关 ctx：把 close() 改成幂等 no-op，
 *   这样关上下文时不会又触发一轮关闭握手。
 * 🔴 两步都带 8 秒超时：见文件头"坑 2"。
 */
async function closeCleanly(ctx, browser) {
  for (const p of ctx.pages()) {
    await p
      .evaluate(() => {
        const ES = window.EventSource;
        if (ES && ES.prototype) ES.prototype.close = function close() {};
      })
      .catch(() => {});
  }
  await Promise.race([
    ctx.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  await Promise.race([
    browser.close().catch(() => {}),
    // 🔴 这个超时必须给：少了它整个文件会挂在 teardown 上，
    //   表现成"文件级失败 exitCode 143"，把所有用例的真实结论全部盖掉。
    new Promise((r) => setTimeout(r, 8000)),
  ]);
}

// 🔴 五个步骤写成独立函数，而不是五条顶层 test()。
//   原因见文件头"坑 4"：顶层 test() 并发，after() 抢先 exit 会静默吃掉末尾用例。
//   收进单个父测试后，父 promise 不 resolve，after 就不可能触发。
async function s01() {
  // 🔴 先用最朴素的方式确认"站点活着且头是对的"，再开浏览器。
  //   顺序反过来的话，浏览器失败时你分不清是站点问题还是浏览器问题。
  const r = await fetch(BASE + '/', { redirect: 'follow' });
  assert.equal(r.status, 200, '首页应 200，实际 ' + r.status);
  const html = await r.text();
  assert.ok(html.includes('app.js'), '首页应引用 app.js');
  assert.ok(!html.includes('cdn.jsdelivr.net'), '新项目不该依赖外部 CDN');

  const csp = r.headers.get('content-security-policy') || '';
  assert.ok(csp.includes("default-src 'self'"), '应有 CSP，实际：' + csp.slice(0, 80));
  // 🔴 关键：新项目 CSP 里**不该**有 cdn.jsdelivr.net。
  //   本地 e2e 测不到响应头，只有打真域名能抓到"清单忘改"这类漏。
  assert.ok(!csp.includes('jsdelivr'), 'CSP 不该放行 jsdelivr（新项目全自托管）');
  // 🔴 nosniff 由 Node 服务端发（server.js 的 send / serveStatic），
  //   Caddy 侧刻意不写 —— 两层都发时浏览器收到 "nosniff, nosniff"。
  //   判据是"值恰好等于 nosniff"而不是"含 nosniff"：
  //   后者遇到重复会报红，却说不出到底是哪两层在管。
  //   🔴 我为"去重"在 Caddy 写过 `-X-Content-Type-Options`，结果头**彻底消失**——
  //     那个语法删的是"代理链上游传来的"，而作用点在反代之后，
  //     把服务端发的那份也一起删了。真域名 e2e 抓到的正是空字符串。
  //     本地内存服务器不可能发现（它压根不发真实响应头）。
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff',
    'X-Content-Type-Options 应恰好一次且为 nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');

  for (const p of ['/app.js', '/sw.js', '/jsQR.js', '/qrcode-generator.js', '/html2canvas.min.js']) {
    const x = await fetch(BASE + p);
    assert.equal(x.status, 200, p + ' 应 200，实际 ' + x.status);
    const len = (await x.arrayBuffer()).byteLength;
    assert.ok(len > 1000, p + ' 体积异常小：' + len + 'B（可能是错误页被当静态资源返回）');
  }
}

async function s02() {
  // 🔴 这条是新旧架构的硬约定，写错会让"新建第一篇笔记"走错分支。
  //   老服务端注释原话：给 4xx 会让客户端当网络错误重试。
  const r = await fetch(`${BASE}/api/note/${NOTE}-nope`);
  assert.equal(r.status, 200, '不存在应回 200，实际 ' + r.status);
  const t = await r.text();
  assert.equal(t.trim(), '', '应为空体，实际：' + t.slice(0, 80));
}

async function s03() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 记录真实网络：断言"确实把密文 POST 上去了"，而不是只看 UI 变了
  const net = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/note/')) {
      net.push({ url: req.url(), method: req.method(), body: req.postData() });
    }
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  try {
    // 🔴 等钩子必须用 `__NOTESYNC_PAGE__`，**不能**用 `__NOTESYNC_DOC__`。
    //   `__NOTESYNC_DOC__` / `__NOTESYNC_CANON__` 是在 mountEditor() 里挂的
    //   （main.ts:957/963），落地页与口令页都还没进编辑器 ⇒ 钩子不存在。
    //   我第一版在 goto('/') 之后就等 __NOTESYNC_DOC__，于是每次都超时——
    //   而超时时长 30s×多个用例，看起来像"线上很慢"或"网络不通"，
    //   真正原因只是等错了钩子。判据里引用钩子前必须确认它**何时挂**。
    await page.goto(BASE + '/' + NOTE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__NOTESYNC_PAGE__ !== undefined, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__NOTESYNC_PAGE__()), 'pass',
      '新笔记首开应进口令页');

    // 口令页：真实 id 是 #pw / #ok（见 packages/client/src/ui/pages.ts:133）
    await page.waitForSelector('#pw', { timeout: 30000 });
    await page.fill('#pw', PASS);
    // 🔴 #ok 在输入为空时是 disabled —— 必须等它解禁再点，
    //   否则 click 会被静默吞掉，然后一直等 contenteditable 超时，
    //   报错信息指向"编辑器没出现"，完全看不出是按钮没解禁。
    await page.waitForFunction(() => !document.querySelector('#ok').disabled, { timeout: 10000 });
    await page.click('#ok');

    await page.waitForSelector('[contenteditable="true"]', { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.__NOTESYNC_PAGE__()), 'editor', '解锁后应进编辑器页');

    // 🔴 零包袱：解锁瞬间真源必须是空文档 {"v":1}，一条块都没有。
    //   判据走真源钩子 __NOTESYNC_CANON__（不手写第二份序列化实现）。
    //   放在打字**之前**判：打字后就分不清"本来就没有"和"刚输入的"。
    const empty = await page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));
    assert.equal(empty, '{"v":1}', '新笔记解锁后真源应是空文档，实际：' + empty.slice(0, 80));

    // 真键盘输入进编辑器
    const ed = page.locator('[contenteditable="true"]').first();
    await ed.click();
    await page.keyboard.type('线上验收 abc', { delay: 40 });
    await page.waitForFunction(
      () => (window.__NOTESYNC_DOC__().blocks || []).length > 0,
      { timeout: 20000 },
    );

    // 真源字节必须走真源函数判，不手写第二份 canonical
    const canon = await page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));
    assert.ok(canon.includes('线上验收 abc'), '真源应含刚输入的文字：' + canon.slice(0, 120));

    // 等推送（同步 debounce）—— 用服务端直读做判据，不靠客户端的 UI 状态
    let stored = '';
    for (let i = 0; i < 40; i++) {
      const t = await (await fetch(`${BASE}/api/note/${NOTE}`, { cache: 'no-store' })).text();
      if (t.trim().length > 0) { stored = t; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(stored.length > 0, '40 次轮询（20s）后服务端仍没有这篇，说明同步没推上去');

    // 🔴 服务端只见密文
    assert.ok(!stored.includes('线上验收 abc'), '🔴 服务端不得出现明文正文');
    const env = JSON.parse(stored);
    assert.equal(env.v, 1, '信封版本');
    assert.equal(env.alg, 'AES-256-GCM');
    assert.equal(env.kdf.name, 'PBKDF2-HMAC-SHA256');
    assert.equal(env.kdf.iter, 600000, 'PBKDF2 迭代必须是 600000（真源层口径）');
    assert.ok(typeof env.kdf.salt === 'string' && env.kdf.salt.length > 0, 'kdf.salt 应非空');
    assert.ok(typeof env.iv === 'string' && env.iv.length > 0, 'iv 应非空');
    assert.ok(typeof env.ct === 'string' && env.ct.length > 20, 'ct 应非空');

    // 确实 POST 过（证明"服务端有这篇"不是别的原因）
    assert.ok(net.some((r) => r.method === 'POST'), '应真的 POST 过密文');
    // 🔴 写用 POST 不用 PUT：新服务端没有 PUT 路由，
    //   若哪天有人照抄老项目的 PUT 写法，这里会安静地拿到 404。
    assert.ok(!net.some((r) => r.method === 'PUT'), '不应发 PUT');

    // 客户端自己也要能读回（走真解锁，不是本地缓存）
    const reloaded = await ctx.newPage();
    await reloaded.goto(BASE + '/' + NOTE, { waitUntil: 'domcontentloaded' });
    await reloaded.waitForFunction(() => window.__NOTESYNC_PAGE__ !== undefined, { timeout: 30000 });
    if ((await reloaded.evaluate(() => window.__NOTESYNC_PAGE__())) === 'pass') {
      await reloaded.fill('#pw', PASS);
      await reloaded.waitForFunction(() => !document.querySelector('#ok').disabled, { timeout: 10000 });
      await reloaded.click('#ok');
    }
    await reloaded.waitForSelector('[contenteditable="true"]', { timeout: 30000 });
    // 🔴🔴 这里必须等，不能一进编辑器就断言 DOM 文本。
    //   我第一版是 `waitForSelector` 之后直接读 textContent，结果读到空串就报红
    //   「第二台设备应能读到同一篇，实际：」—— 看起来像同步坏了，
    //   真去查服务端却是好的：Lexical 渲染是异步的，进编辑器 ≠ 内容已挂上。
    //   症状和"同步失效"几乎一样，但它根本不是同步问题。
    //   判据改成**等真源非空**（与第一台设备同口径），不靠 DOM 抽取文本。
    const synced = await reloaded
      .waitForFunction(
        () => ((window.__NOTESYNC_DOC__ && window.__NOTESYNC_DOC__().blocks) || []).length > 0,
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false);
    assert.ok(synced,
      '第二台设备进编辑器后 30s 内真源仍为空 —— 这才是真的同步没生效（服务端已确认有密文）');
    const canon2 = await reloaded.evaluate(() =>
      window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));
    assert.ok(canon2.includes('线上验收 abc'),
      '第二台设备应读到同一篇，真源实际：' + canon2.slice(0, 120));
    await reloaded.close();

    assert.deepEqual(pageErrors, [], '页面不应有未捕获异常：' + pageErrors.join(' | '));
  } finally {
    // 🔴🔴 清理绑在这里（产生脏数据的那条用例自己的 finally），不能另立用例。
    //   见文件头"坑 3"：独立顶层用例会因并发调度 + after 抢先 exit 而**从未执行**，
    //   而汇总仍报全绿 —— 每次验收都在生产目录留一篇密文笔记而没人知道。
    //   无论本用例成功、失败还是中途抛错，这次清理都一定会跑。
    try {
      const del = await fetch(`${BASE}/api/note/${NOTE}`, { method: 'DELETE' });
      assert.ok(del.status === 200 || del.status === 204, '清理：删除应成功，实际 ' + del.status);
      const left = await (await fetch(`${BASE}/api/note/${NOTE}`)).text();
      assert.equal(left.trim(), '', '清理：删除后服务端应为空体，实际还剩 ' + left.length + 'B');
    } finally {
      await closeCleanly(ctx, browser);
    }
  }
}

async function s04() {
  // 🔴🔴 这条是 Caddy 段落的直接判据。少写 keepalive off / flush_interval -1 时，
  //   连接会建立成功（HTTP 200），只是数据卡在代理层不下来 —— **不报任何错**。
  //   所以"能不能连上"不算判据，必须"连上之后能收到服务端主动推的字节"。
  //
  // 🔴 写法坑：不能用 fetch + AbortController 读完就不管。
  //   abort 只掐断请求，**响应体的 ReadableStream 还挂着**，undici 的 socket 池
  //   一直持有连接 ⇒ 进程不退出。这与 e2e/harness.mjs 开头记的是同一类问题。
  //   ⇒ 必须显式 reader.cancel()。下面用真实 reader 读首帧，读到即 cancel。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let reader = null;
  try {
    const res = await fetch(`${BASE}/api/stream/${NOTE}-sse`, {
      headers: { Accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200, 'SSE 应 200，实际 ' + res.status);
    const ct = res.headers.get('content-type') || '';
    assert.ok(ct.includes('text/event-stream'), 'SSE Content-Type 应为 text/event-stream，实际：' + ct);

    // 🔴 判"Caddy 没缓冲"的真判据：读**首帧**数据。
    //   服务端连上就写 `: hello\n\n`（server.js:384），若代理把数据缓冲住，
    //   这一步会一直等到 abort 才拿到空 —— 于是超时/空，就是"被缓冲了"。
    reader = res.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, 'SSE 首读应是数据而非流结束');
    const head = Buffer.from(first.value).toString('utf8');
    assert.ok(head.startsWith(': hello'),
      'SSE 连上后应立刻收到服务端的 hello 注释帧（Caddy 若缓冲则拿不到），实际：' + JSON.stringify(head));
    // 🔴🔴 判据只能到这里为止。
    //   我第一版还加了一句 `assert.ok(!reader.closed, 'reader 应仍开放')` ——
    //   **`reader.closed` 不是"流是否还开着"，它是"流是否已关闭"的 Promise**，
    //   永远 truthy，而 `!Promise` 恒为 false。所以这条断言在流好好开着时也红。
    //   症状极坏：看起来像"Caddy 把流关了"，而真去查代理层什么都查不到。
    //   ⇒ "能立刻收到 hello 帧"本身已经证明链路通，不需要再判流还活着。
  } finally {
    clearTimeout(timer);
    if (reader) await reader.cancel().catch(() => {});
    ctrl.abort();
  }
}

async function s05() {
  // 🔴 验"零包袱"承诺：新项目不预置任何笔记，落地页必须提供从零开始的入口。
  //   🔴 落地页**没有** __NOTESYNC_DOC__（它在 mountEditor 里才挂），
  //   所以这里不能去读真源——真源的"空"已在 LIVE-03 解锁后判过。
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__NOTESYNC_PAGE__ !== undefined, { timeout: 30000 });
    const p1 = await page.evaluate(() => window.__NOTESYNC_PAGE__());
    assert.ok(['landing', 'pass', 'home'].includes(p1), '落地后应在 landing/pass/home 之一，实际：' + p1);
    const html = await page.content();
    assert.ok(/<button|<input|<a\s/.test(html), '落地页应提供新建/进入的交互入口');
  } finally {
    await closeCleanly(ctx, browser);
  }
}

/**
 * 唯一的顶层用例：把五步**串行**跑完。
 *
 * 🔴🔴 为什么必须是单父测试而不是五条顶层 test()（文件头"坑 3 / 坑 4"）：
 *   顶层 test() 在本文件里是并发的，`after()` 的 process.exit 会在
 *   末尾用例 settle 之前抢先落地，把它整个吃掉 —— 而汇总里**没有失败项**。
 *   我连续两次被这个坑骗到：一次丢掉清理（生产目录留密文笔记），
 *   一次丢掉 LIVE-05（"4 条全绿"其实少跑一条）。
 *   父测试不 resolve ⇒ after 不会触发 ⇒ 漏跑在结构上不再可能。
 *   `--test-concurrency=1` 挡不住这个：它只管文件间并发。
 */
test('LIVE 线上真域名验收（bj.xuyinji.com.cn，5 步串行）', async (t) => {
  await t.test('LIVE-01 线上站点：TLS + 首页 + 静态资源 + CSP 头', s01);
  await t.test('LIVE-02 服务端契约：读不存在返回 200 空体（不是 404）', s02);
  await t.test('LIVE-03 端到端：解锁 → 写 → 落库 → 读回 → 服务端只见密文', s03);
  await t.test('LIVE-04 SSE 端点真的保持连接（不被 Caddy 缓冲）', s04);
  await t.test('LIVE-05 落地页：零包袱，有可点入口', s05);
});

after(() => {
  // 🔴🔴🔴 这里**不能**无脑 process.exit。
  //   踩过两次：
  //     一次是顶层裸 exit 抢在 runner 开始前 ⇒ 假绿（1 条 / 462ms）；
  //     一次是收进父测试后仍 exit ⇒ 5 条**全跑完了**（ok 5 确实打出来了），
  //     但 exit 抢在 runner flush 汇总之前，把父测试的 ok 行和 # tests 统计
  //     一起吃掉，输出停在「4 条全绿」。**跑对了却报得像少跑一条。**
  //   判断依据是那次 no-exit 对照实验：trace 打印在 ok 5 之前，
  //   说明 after 触发时 s05 其实**已经 settle**（runner 还没 flush）。
  //   ⇒ 结论：exit 的作用只是"掐掉残留句柄让进程退出"，
  //     不该承担"结束测试"职责；而它一跑就毁掉汇总。
  //   ⇒ 改成：先给事件循环一拍自然排空，仍不退出才兜底 exit。
  //     setImmediate 让 runner 的 flush 先落地；unref 的定时器不阻止退出。
  setImmediate(() => {
    setTimeout(() => {
      if (process.env.BJ_LIVE_TRACE === '1') {
        console.error('[trace] 兜底 exit 生效（事件循环未排空）');
      }
      process.exit(process.exitCode ?? 0);
    }, 300).unref();
  });
});

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
  /** @type {Map<string, Map<string, {body:string, manual:boolean}>>} 笔记 id → (ts → 快照) */
  // 🔴 S9 接入真历史链路后新增。漏了它，历史相关用例的表现是
  //   "点了新增历史版本但列表一直空" —— 看起来像应用 bug，实际是桩没这条路由。
  const history = new Map();
  return { notes, posts, history };
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
    // 快照序号（服务端生成 ts 的替身：单调递增整数，够用且不撞）
    let histSeq = 1000;
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
      const rest = p.slice('/api/note/'.length);
      // 🔴🔴 历史版本子路径 `/api/note/<id>/history[/<ts>]` **必须先于笔记本体判定**。
      //   S9 接入真历史链路后，这个前缀会落到下面的笔记分支里，
      //   于是 id 变成 "vvw05/history"，POST 被当成"存一篇叫 vvw05/history 的笔记"，
      //   GET 返回 200 + 空体 —— 而客户端把空体读成"没有历史版本"，
      //   点「新增历史版本」后列表永远空着，测试只报一句
      //   `waiting for locator('.list-row[data-at]') to be visible` 超时。
      //   这类"测试桩没跟上新能力"的失败看起来像应用 bug，实际是桩缺路由。
      const hi = rest.indexOf('/history');
      if (hi > 0) {
        const id = decodeURIComponent(rest.slice(0, hi));
        const tail = rest.slice(hi + '/history'.length); // '' | '/<ts>'
        const hist = store.history.get(id) ?? new Map();
        store.history.set(id, hist);
        if (req.method === 'GET' && tail === '') {
          // 🔴🔴 响应形态必须是 `{list:[...]}`（服务端 server.js:405
          //   `sendJson(res,200,{list: hist.list.map(...)})`），
          //   **不是裸数组**。客户端 fetchHistoryList 读的是 `j.list`
          //   （sync/history.ts:71 `Array.isArray(j.list) ? j.list : []`），
          //   桩若返回裸数组，客户端会静默解析成`[]` ——
          //   症状是「PUT 成功、GET 也返回了数据，但列表永远空」，
          //   而网络面板里两条都是 200，看起来一切正常。
          //   这就是本项目记过的「桩与服务端契约漂移」：桩不是测试的附属品，
          //   它是**契约的第二份实现**，错了就把真 bug 伪装成应用 bug。
          const items = [...hist.entries()]
            .map(([ts, v]) => ({ ts: Number(ts), v: 1, manual: !!v.manual, size: v.body.length }))
            .sort((a, b) => a.ts - b.ts); // 服务端按入栈顺序，旧的在前
          send(200, JSON.stringify({ list: items }));
          return;
        }
        if (req.method === 'GET' && tail.startsWith('/')) {
          const ts = decodeURIComponent(tail.slice(1));
          const v = hist.get(ts);
          // 🔴🔴🔴 响应必须是 **envelope 本体**（ct/iv/kdf/alg 各自成字段），
          //   **不是** `{body: "<整段 JSON 字符串>"}`。
          //   桩此前把 PUT 的原始 body 当字符串存下来，读的时候再 JSON.stringify 一次
          //   ⇒ 客户端拿到 `{"body":"{\"v\":1,\"ct\":…}"}`，
          //   而 fetchHistoryDoc 读的是 `env.ct`（sync/history.ts:107）⇒ undefined
          //   ⇒ 解密抛错 ⇒ 返回 null ⇒ 界面显示「该版本不可用」。
          //   症状极具欺骗性：**列表出得来、点恢复也"成功"了**（那是因为
          //   restoreHistVersion 与预览走同一个 fetchHistoryDoc，都null，
          //   而恢复的提示与"本来就没什么可恢复的"长得一样），
          //   只有真去比对响应体才看得出多了一层壳。
          //   服务端 server.js:412 那一段是**摊平**返回六个字段的，桩必须同款：
          //   桩不是测试的附属品，它是**契约的第二份实现**。
          if (!v) {
            // 200 + 空体 = 这一版不存在（与服务端一致，客户端据此判"该版本不可用"）
            send(200, '');
            return;
          }
          let env = null;
          try {
            const parsed = JSON.parse(v.body);
            //只要信封真正需要的字段齐了就算这一版可读
            if (parsed && typeof parsed.ct === 'string' && typeof parsed.iv === 'string') {
              env = { ts: Number(ts), v: parsed.v, alg: parsed.alg, kdf: parsed.kdf, iv: parsed.iv, ct: parsed.ct };
            }
          } catch {
            env = null;
          }
          if (env === null) {
            // 坏信封：这一版读不出来。同样回空体（与"解不开"同路，客户端都当不可用）
            send(200, '');
            return;
          }
          send(200, JSON.stringify(env));
          return;
        }
        // 🔴🔴 写入用 **PUT**（sync/history.ts pushHistory），不是 POST。
        //   🔟 ts 由**服务端生成**并在响应里回 `{ts}`（客户端 body 不带 ts，
        //   它从 `j.ts` 读回来）。桩若自己造 ts 或只认 POST，
        //   客户端就拿不到合法 ts → 列表行渲染不出来 → 用例只报一句超时，
        //   看起来像应用 bug。
        if ((req.method === 'PUT' || req.method === 'POST') && tail === '') {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            let manual = false;
            try {
              manual = !!JSON.parse(body).manual;
            } catch {
              // 非法 JSON：回 400，与服务端一致（客户端据此报失败而不是静默成功）
              send(400, JSON.stringify({ error: 'bad body' }));
              return;
            }
            // 单调递增整数当 ts，与服务端"取当前毫秒"同量级，且保证不撞
            histSeq += 1;
            const ts = histSeq;
            hist.set(String(ts), { body, manual });
            send(200, JSON.stringify({ ok: true, ts }));
          });
          return;
        }
      }
      const id = decodeURIComponent(rest);
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
  return openEditorAt(browser, base, noteName, pass, null);
}

/**
 * 🔴🔴🔴 把页面时钟**钉死**在某个时刻的openEditor。
 *
 * **为什么必须有这个**：项目里已经吃过两次「测试依赖真实时钟」的亏，
 *   而这类失败有个共同特征 —— **同一个断言在两个时刻得到两个结论**，
 *   且它自己不知道自己依赖了时钟：
 *     ① 老项目 `nsBadgeAt`（index.html:6574）：深夜 22:00–06:00 或节日**必然显示**徽章。
 *        于是「徽章默认 display:none」这条断言白天恒绿、深夜恒红。
 *     ② 主题跟随时间（07:00/19:00 切日夜）：跨 19:00 那条边界时颜色断言整片翻红。
 *
 * **为什么不用 `Date.now()` mock 源码**：那要去改产品代码里的时钟来源，
 *   为了测试去动生产逻辑是本末倒置。这里用 Playwright 的 `page.clock`，
 *   在**页面外**冻结时间，产品代码一行不动。
 *
 * @param {{iso: string}} opts.iso 固定时刻（带时区偏移，避免本机时区参与判定）
 */
export async function openEditorAt(browser, base, noteName, pass, opts) {
  const page = await withTimeout(browser.newPage(), 30_000, 'newPage');
  if (opts && opts.iso) {
    await page.clock.install({ time: new Date(opts.iso) });
  }
  const errors = [];
  const consoleErrs = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  // 🔴 console.error 也要收：模块顶层抛错时 pageerror 未必触发，
  //   而 boot() 里的 catch 会 console.error('[notesync] 启动失败' + 堆栈) ——
  //   那是定位"整页白屏"最直接的线索。
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrs.push(m.text());
  });
  await page.goto(base);

  /**
   * 等一个选择器，超时就把页面自身的错误一并抛出。
   *
   * 🔴🔴 为什么值得单独抽出来：裸 `waitForSelector` 超时只说
   *   "waiting for locator('#li') to be visible"，**不包含任何页面上下文**。
   *   实测 10 条 e2e 一起 TimeoutError，我只能回头手工复现才知道是启动崩了。
   *   把 pageerror + console.error + 启动失败横幅 + 错误行四路诊断
   *   挂在超时点上，是一次性省掉整轮猜测的投入。
   */
  const waitOrExplain = async (selector, label) => {
    try {
      return await withTimeout(page.waitForSelector(selector, { timeout: 20_000 }), 25_000, label);
    } catch (e) {
      const fatal = await page.textContent('.ns-fatal').catch(() => null);
      const errRow = await page.textContent('#err').catch(() => null);
      const bodyLen = await page.evaluate(() => document.body?.innerHTML.length ?? -1).catch(() => -2);
      throw new Error(
        `${label} 超时（找 ${selector}）。` +
        `bodyHTML长度=${bodyLen}；` +
        `启动失败横幅=${fatal || '(无)'}；` +
        `页面错误行=${errRow || '(空)'}；` +
        `pageerror=${errors.join(' | ') || '(无)'}；` +
        `console.error=${consoleErrs.join(' | ') || '(无)'}；` +
        `原始=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  await waitOrExplain('#li', '等落地页');
  await page.fill('#li', noteName);
  await page.click('#landingBtn');

  await waitOrExplain('#pw', '等口令页');
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

/**
 * ============================================================================
 * 触屏装置 —— 移动端判据必须在**真的触屏上下文**里跑
 * ============================================================================
 *
 * 🔴🔴🔴 为什么不能直接 `browser.newPage({ hasTouch: true })`：
 *   bj 的触屏判据是 `matchMedia('(hover: none) and (pointer: coarse)')`。
 *   本机实测（Playwright 1.x + Chromium）：
 *     isMobile+hasTouch → coarse:true  hoverFine:false  anyFine:false   ← 触屏
 *     hasTouch only     → coarse:true  hoverFine:false  anyFine:false   ← 同上
 *     desktop           → coarse:false hoverFine:true   anyFine:true    ← 桌面
 *   也就是说 **`hasTouch` 就够**，但必须显式给 `isMobile` 更保险（不同内核版本
 *   对 hover/pointer 的模拟实现有差异，实测已确认本机这套两个都给最稳）。
 *
 * 🔴🔴🔴 为什么"触屏判据"本身必须落在这条链上而不是 mock 掉：
 *   用户报障第 8/10/11 条（"关闭弹窗后键盘被打开"）全部是**触屏专属行为**。
 *   在桌面上下文里跑，`(hover: none) and (pointer: coarse)` 恒 false，
 *   于是"移动端不该 focus"那条守卫永远走不到 ⇒ **测试恒绿、用户照旧被弹键盘**。
 *   这就是"测试骗人"的典型：它绿不是因为对，是因为压根没进那条分支。
 *
 * ⚠️ 关闭弹层用 `Esc` 而不是点遮罩：Playwright 的 `page.click('.mask')` 命中
 *   `pointer-events` 判定，浮层开着时顶栏按钮"visible 但点不到"（本项目纪律）。
 *   `Esc` 走真实事件路径，与用户按返回键一致。
 */
export const TOUCH_CTX = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/**
 * 走到**编辑器就绪**为止，但全程在触屏上下文里。
 *
 * 🔴 与 `openEditor` 的差别只有两处，其余逐步同款（落地页 → 口令 → 编辑器）：
 *   ① 自己开 context（`browser.newPage()` 隐式建的 context 是桌面的，改不了）
 *   ② 用 `tap()` 而不是 `click()`（触屏语义；Chromium 下 click 也能过，
 *      但语义不对，将来加 touchstart 路径的判据会骗人）
 *
 * 🔴 返回值是 page；**调用方负责 `page.context().close()`**
 *   （`page.close()` 不会关掉自建 context，泄漏到文件末尾会让 after 挂住）。
 */
export async function openEditorTouch(browser, base, noteName = 'e2e', pass = '测试口令') {
  const ctx = await withTimeout(browser.newContext(TOUCH_CTX), 30_000, 'newContext(touch)');
  const page = await withTimeout(ctx.newPage(), 30_000, 'newPage(touch)');
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base);
  try {
    await withTimeout(page.waitForSelector('#li', { timeout: 20_000 }), 25_000, '等落地页(touch)');
    await page.fill('#li', noteName);
    await page.tap('#landingBtn');
    await withTimeout(page.waitForSelector('#pw', { timeout: 20_000 }), 25_000, '等口令页(touch)');
    await page.fill('#pw', pass);
    await page.tap('#ok');
    await withTimeout(
      page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20_000 }),
      25_000, '编辑器未挂载(touch)',
    );
  } catch (e) {
    const bodyLen = await page.evaluate(() => document.body?.innerHTML.length ?? -1).catch(() => -2);
    throw new Error(
      `触屏路径失败：${e instanceof Error ? e.message : String(e)}` +
      `；bodyHTML长度=${bodyLen}；pageerror=${errors.join(' | ') || '(无)'}`,
    );
  }
  return page;
}

/**
 * 触屏上下文的收尾：**必须关 context**。
 * 只 `page.close()` 会留下活着的 context，文件末尾的 browser.close() 偶尔就挂住。
 */
export async function closeTouch(page) {
  await page.context().close();
}

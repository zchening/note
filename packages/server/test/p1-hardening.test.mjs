/**
 * 阶段 3「加固」判据 —— SRV-P1-09~P1-14
 *
 * 🔴🔴 本文件的存在理由：阶段 3 六条改的都是**安全闸与静默失效**类问题，
 *   它们的共同特征是「改错了不会红、只会悄悄失去保护」——
 *   XFF 照旧可伪造、读写桶照旧共用、ETag 永远不等、CSP 白加。
 *   所以每条都必须有能**转红**的判据，而不是"看着像做了"。
 *
 * 🔴 形态：能打真 HTTP 的打真 HTTP（起隔离进程，见 server.test.mjs 的 boot 纪律）；
 *   纯函数（clientIp 判定）直接 import 生产模块 `net-ip.js`
 *   —— 判据必须 import 生产代码，抄进测试的判据恒绿。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clientIpFrom, isTrustedProxy } from '../src/net-ip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

let child = null;
let base = '';
let dataDir = '';
let wwwDir = '';
let deployDir = '';
let port = 0;

async function boot() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-hard-'));
  wwwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-hard-www-'));
  fs.writeFileSync(
    path.join(wwwDir, 'index.html'),
    '<!doctype html><html><body><div id="app">hi</div></body></html>',
    'utf8',
  );
  deployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-hard-dep-'));
  fs.mkdirSync(path.join(deployDir, 'apk'), { recursive: true });
  port = 21000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NS_BJ_PORT: String(port),
      NOTESYNC_BJ_DATA_DIR: dataDir,
      NOTESYNC_BJ_WWW: wwwDir,
      NOTESYNC_BJ_DEPLOY: deployDir,
      NS_BJ_VERSION: '9.9.9-hard',
      NS_BJ_BUILD_DATE: '2026-10-11',
      // 🔴 起步用 off：P1-9 那条要一个"已存在但未认领"的档，
      //   full 档下无凭据写不进去就造不出这个前提。
      NS_BJ_WK_MODE: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务端 12 秒内没起来');
}

test.before(async () => {
  await boot();
});

// 🔴 清理必须等 exit 事件（见 server.test.mjs 里那段 ENOTEMPTY 的血泪注释）。
test.after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  for (const d of [dataDir, wwwDir, deployDir]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

const putNote = (id, text, headers = {}) =>
  fetch(`${base}/api/note/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: text,
  });

/* ============ P1-10：XFF 只有可信前置才认（纯函数，直接 import 生产代码） ============ */

test('SRV-01 非可信来源伪造 XFF 一律忽略（限流桶不可被客户端写）', () => {
  // 「不应该有」：伪造的 XFF 不得生效
  assert.equal(
    clientIpFrom({ 'x-forwarded-for': '1.2.3.4' }, '203.0.113.9', ''),
    '203.0.113.9',
    '来源不可信时 XFF 必须被完全忽略（否则每次换 XFF 就换一个限流桶）',
  );
  // 多段伪造也一样
  assert.equal(
    clientIpFrom({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }, '203.0.113.9', ''),
    '203.0.113.9',
    '多段 XFF 在非可信来源下同样必须忽略',
  );
});

test('SRV-02 可信前置（回环 / 显式配置）才取 XFF 末段', () => {
  // 「应该有」①：回环（本机 Caddy）⇒ 认 XFF
  assert.equal(
    clientIpFrom({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }, '127.0.0.1', ''),
    '1.2.3.4',
    '来自本机反代时必须取 XFF **末段**（首段是客户端可伪造的，老项目 v5.52 的教训）',
  );
  // 「应该有」②：显式配置的可信代理
  assert.equal(isTrustedProxy('10.0.0.7', '10.0.0.7, 10.0.0.8'), true, '显式列出的代理必须可信');
  assert.equal(
    clientIpFrom({ 'x-forwarded-for': '5.5.5.5' }, '10.0.0.7', '10.0.0.7, 10.0.0.8'),
    '5.5.5.5',
    '显式可信代理的 XFF 必须被采信',
  );
  // 「不应该有」：未列出的地址即使在同一网段也不算可信
  assert.equal(isTrustedProxy('10.0.0.9', '10.0.0.7, 10.0.0.8'), false, '未列出的地址不得算可信');
});

test('SRV-03 无 XFF 时一律回落到 socket 地址（任何档位下都成立）', () => {
  assert.equal(clientIpFrom({}, '203.0.113.9', ''), '203.0.113.9');
  assert.equal(clientIpFrom({}, '127.0.0.1', ''), '127.0.0.1');
  assert.equal(clientIpFrom({ 'x-forwarded-for': '    ' }, '203.0.113.9', ''), '203.0.113.9', '空白 XFF 等同没有');
});

/* ============ P1-11：/api/fail 读写分桶（真 HTTP） ============ */

test('SRV-04 匿名自报失败不得牵连 GET 读（低代价 DoS 被切断）', async () => {
  const id = 'srv04note';
  const r1 = await putNote(id, JSON.stringify({ v: 1, ct: 'AAA', iv: 'x', kdf: { name: 'PBKDF2', iter: 600000, salt: 's' } }));
  assert.equal(r1.status, 200, '前提：笔记要能写进去');

  // 读到 200（前提：这篇存在，不会走 scan miss 记读桶）
  const g0 = await fetch(`${base}/api/note/${id}`);
  assert.equal(g0.status, 200, '前提：存在的笔记能读到');

  // 匿名自报失败 30 次（远超锁定阈值）
  for (let i = 0; i < 30; i += 1) {
    await fetch(`${base}/api/fail?id=${id}`, { method: 'POST' });
  }
  // 🔴 GET /api/fail 查的是**读桶**：自报进的是写桶 ⇒ 读桶仍应干净
  const st = await (await fetch(`${base}/api/fail?id=${id}`)).json();
  assert.equal(st.locked, false, '自报必须只进写桶：读桶不得被污染（否则受害者连自己的笔记都读不到）');

  // 「应该有」核心断言：笔记依然读得到
  const g1 = await fetch(`${base}/api/note/${id}`);
  assert.equal(g1.status, 200, '匿名自报 30 次后，GET 读必须仍然 200（此前会被 429 锁死 10 分钟）');
  const body = await g1.text();
  assert.ok(body.includes('AAA'), '读到的必须是原正文');
});

/* ============ P1-14：ETag / 304 短路（真 HTTP） ============ */

test('SRV-05 同一内容两次 GET 的 ETag 必须相同（可复现，否则 304 永不命中）', async () => {
  const id = 'srv05note';
  await putNote(id, JSON.stringify({ v: 1, ct: 'BBB' }));
  const a = await fetch(`${base}/api/note/${id}`);
  const b = await fetch(`${base}/api/note/${id}`);
  assert.equal(a.headers.get('etag'), b.headers.get('etag'), '同一内容的 ETag 必须稳定可复现');
  assert.ok(a.headers.get('etag'), 'GET 笔记必须带 ETag 头');
});

test('SRV-06 If-None-Match 命中 ⇒ 304 且空体（轮询短路真的省掉全量拉取）', async () => {
  const id = 'srv06note';
  await putNote(id, JSON.stringify({ v: 1, ct: 'CCC' }));
  const first = await fetch(`${base}/api/note/${id}`);
  const etag = first.headers.get('etag');
  const cached = await fetch(`${base}/api/note/${id}`, { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304, '内容未变必须返回 304');
  assert.equal(await cached.text(), '', '304 必须是空体（否则省不掉传输）');
});

test('SRV-07 内容变了 ETag 必须跟着变（否则客户端永远看不到更新）', async () => {
  const id = 'srv07note';
  await putNote(id, JSON.stringify({ v: 1, ct: 'DDD' }));
  const e1 = (await fetch(`${base}/api/note/${id}`)).headers.get('etag');
  await putNote(id, JSON.stringify({ v: 1, ct: 'EEE' }));
  const e2 = (await fetch(`${base}/api/note/${id}`)).headers.get('etag');
  assert.notEqual(e1, e2, '内容变了 ETag 必须变 —— 不变的话客户端永远拉不到新内容（比不做还糟）');
});

/* ============ P1-12：全站 CSP（真 HTTP） ============ */

test('SRV-08 HTML 文档响应必须带 CSP，且不得放行 unsafe-eval', async () => {
  const r = await fetch(`${base}/`);
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp, 'HTML 响应必须带 Content-Security-Policy（全仓此前零 CSP）');
  assert.match(csp, /default-src/, 'CSP 必须含 default-src');
  assert.match(csp, /object-src 'none'/, 'CSP 必须禁 object-src');
  assert.doesNotMatch(csp, /unsafe-eval/, 'CSP 不得放行 unsafe-eval（全仓无 eval，需要它就应该换库）');
});

test('SRV-08b 🔴🔴🔴 img-src 必须放行图床投递域名（用户报障：上传成功但图片是一条横线）', async () => {
  // 🔴🔴 真因（v3.2.3 真机报障第 5 条「上传/拍照后图片显示成一条横线」）：
  //   图片上传是**直传 Cloudinary**（client/image/upload.ts），插入笔记的就是
  //   云端返回的 secure_url；而 CSP 的 img-src 此前只有 `'self' data: blob:`，
  //   connect-src 却又给了 `https:` ⇒ 上传请求过得去（用户看到"上传成功"），
  //   **图片本身被 CSP 挡死** ⇒ `<img>` 加载失败 ⇒ 零高度 + 1px 边框 = 一条横线。
  //
  // 🔴🔴 为什么把客户端上传主机**读出来**再比，而不是在判据里写死域名：
  //   写死的话，将来有人把 upload.ts 的图床换掉（或换成自建 OSS），
  //   CSP 这条会**静静地继续放行一个再也不用的域名**，而新域名照旧被挡 ——
  //   症状与本次一模一样（上传成功、图是一条线），且没有任何判据会红。
  //   两边互相绑定后，改任何一边另一边必须红。
  const uploadSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'client', 'src', 'image', 'upload.ts'),
    'utf8',
  );
  const host = /https:\/\/([a-z0-9.-]+\.[a-z]{2,})\/v1_1\//.exec(uploadSrc);
  assert.ok(host, '应从 upload.ts 读出上传主机（读不到说明直传 URL 形态变了，本判据需同步更新）');
  const uploadHost = host[1];
  // 投递域名：Cloudinary 的 secure_url 是 res.cloudinary.com/<cloud_name>/...
  //   —— 与上传主机（api.cloudinary.com）不是同一个，必须分别放行。
  const deliverHost = 'res.cloudinary.com';

  const r = await fetch(`${base}/`);
  const csp = r.headers.get('content-security-policy') || '';
  const imgSrc = /(?:^|; )img-src ([^;]+)/.exec(csp);
  assert.ok(imgSrc, 'CSP 必须含 img-src，实际：' + csp);
  const allow = imgSrc[1];
  assert.ok(
    allow.includes(deliverHost),
    `img-src 必须放行图床投递域名 ${deliverHost}（笔记内图片就是它的 secure_url，` +
      `不放行 ⇒ <img> 加载失败 ⇒ 屏幕上一条横线）。实际 img-src：${allow}`,
  );
  // 反向自证：上传主机本身靠 connect-src 放行，不能误加到 img-src 里充数
  assert.ok(
    !allow.includes(uploadHost),
    `img-src 里不该出现上传主机 ${uploadHost}（那是 connect-src 的职责；` +
      `放它只会让判据看起来像过了，图片照旧是一条横线）`,
  );
  const connSrc = /(?:^|; )connect-src ([^;]+)/.exec(csp);
  assert.ok(connSrc && connSrc[1].includes('https:'),
    'connect-src 必须放行 https:（上传直传图床走它）');
});

/* ============ P1-9：已存在但未认领的档，首次写只登记不覆盖正文 ============ */

test('SRV-09 full 档下未认领档的首次带凭据写：只登记、正文一字不动', async () => {
  const id = 'srv09note';
  const original = JSON.stringify({ v: 1, ct: 'ORIGINAL-BODY' });
  const r1 = await putNote(id, original);
  assert.equal(r1.status, 200, '前提：off 档下无凭据能写进去（造出"已存在但未认领"的档）');

  // 热切到 full（guards 有 5s 缓存，等它过期）
  fs.writeFileSync(path.join(dataDir, 'wk-mode.txt'), 'full', 'utf8');
  await new Promise((r) => setTimeout(r, 6000));

  // 带一个**任意**凭据写新正文 —— 这正是抢注攻击的形状
  const r2 = await putNote(
    id,
    JSON.stringify({ v: 1, ct: 'ATTACKER-BODY' }),
    { 'x-note-key': 'A'.repeat(44) },
  );
  assert.equal(r2.status, 200, '首次登记本身是允许的（合法认领也走这条路）');
  const j = await r2.json();
  assert.equal(j.claimOnly, true, '必须明确告知"这次只登记了"（调用方据此知道正文还没写上去）');

  // 「应该有」核心断言：正文未被覆盖
  const g = await fetch(`${base}/api/note/${id}`);
  const txt = await g.text();
  assert.ok(txt.includes('ORIGINAL-BODY'), '未认领档的首次写**不得覆盖正文**（这是数据永久丢失的路径）');
  assert.ok(!txt.includes('ATTACKER-BODY'), '攻击者的正文不得落盘');
});

/* ============ P1-13：写失败不回显服务器路径（源码级） ============ */

test('SRV-10 失败响应不得回显异常原文（fs 错误含服务器绝对路径）', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(
    code,
    /detail:\s*String\(/,
    '失败响应不得带 detail: String(e...)（fs 错误会泄出服务器绝对路径）',
  );
  // 「应该有」：详细原因改走服务端日志（否则线上排障只剩一句 write failed）
  assert.match(code, /console\.error\('\[write failed\]/, '详细错误必须进服务端日志而不是响应体');
});

/**
 * 变异验证记录（2026-10-11 实跑）：
 *  - 把 net-ip.js 的 `isTrustedProxy(ra, extra)` 改成恒 true ⇒ SRV-01 红（SRV-02/03 仍绿 ⇒ 专一）。
 *  - 把 /api/fail 的 POST 改回共用 key（去掉 ':w'）⇒ SRV-04 红。
 *  - 把 ETag 的 304 返回删掉（总是 200）⇒ SRV-06 红。
 *  - 把 ETag 改成固定串 ⇒ SRV-07 红（SRV-05 仍绿 ⇒ 专一）。
 *  - 删掉 CSP 响应头 ⇒ SRV-08 红。
 *  - 删掉 server.js 的 claimOnly 分支 ⇒ SRV-09 红（正文被覆盖）。
 *  - 把 `detail: String(e && e.message)` 加回去 ⇒ SRV-10 红。
 * 恢复后 `MUT` grep 归零、十条全绿。
 */

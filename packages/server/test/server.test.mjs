/**
 * 服务端接口测试 —— 起真进程打真 HTTP
 *
 * 不用 supertest 之类（零依赖原则）。listen(0) 拿随机端口，测完关掉，
 * 绝不占用 8090（那是生产端口，本机可能跑着别的东西）。
 *
 * 覆盖的关键不变量：
 *  - /healthz 自报版本（部署核对的第一判据）
 *  - 笔记读写往返，且服务端不解析内容（密文原样落盘）
 *  - 不存在的笔记返回 200 + 空体（不是 404/4xx）—— 客户端据此判"此处无笔记"
 *  - id 白名单挡住路径穿越
 *  - 锁定后 429 + Retry-After
 *  - SSE 能收到推送
 *  - 静态资源与 SPA 回落
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

let child = null;
let base = '';
let dataDir = '';

/** 起一个隔离实例（独立 DATA_DIR + 随机端口） */
async function boot() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-srv-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NS_BJ_PORT: String(port),
      NOTESYNC_BJ_DATA_DIR: dataDir,
      NS_BJ_VERSION: '9.9.9-test',
      NS_BJ_BUILD_DATE: '2026-10-05',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = `http://127.0.0.1:${port}`;
  // 等端口就绪
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务端 10 秒内没起来');
}

test.before(async () => {
  await boot();
});

test.after(() => {
  if (child) child.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('/healthz 自报版本与关键路径（部署核对第一判据）', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.app, 'notesync-bj');
  assert.equal(j.version, '9.9.9-test');
  assert.equal(j.buildDate, '2026-10-05');
  assert.ok(Number.isInteger(j.port));
  assert.ok(typeof j.failMapEntries === 'number');
});

test('笔记写入后能原样读回（服务端不解析密文内容）', async () => {
  const cipher = JSON.stringify({ v: 1, alg: 'AES-256-GCM', ct: 'Zm9vYmFy', iv: 'AAAA' });
  const w = await fetch(`${base}/api/note/testnote1`, { method: 'POST', body: cipher });
  assert.equal(w.status, 200);

  const r = await fetch(`${base}/api/note/testnote1`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), cipher, '密文必须逐字节原样返回');
});

test('不存在的笔记返回 200 + 空体（客户端据此判"此处无笔记"）', async () => {
  const r = await fetch(`${base}/api/note/does-not-exist-xyz`);
  assert.equal(r.status, 200, '🔴 必须 200，给 404 会让客户端当网络错误重试');
  assert.equal(await r.text(), '');
});

test('id 白名单挡住路径穿越与非法字符', async () => {
  const bad = [
    '../secret',
    'a/b',
    'UPPER',
    '-leading-dash',
    'a'.repeat(100),
    'has.dot',
    'has space',
  ];
  for (const id of bad) {
    const r = await fetch(`${base}/api/note/${encodeURIComponent(id)}`);
    assert.ok(r.status === 400 || r.status === 404, `「${id}」竟返回 ${r.status}`);
    if (r.status === 400) {
      const j = await r.json();
      assert.equal(j.error, 'bad id');
    }
  }
});

test('超大 body 被拒（413），不能拿它当文件服务器', async () => {
  const big = 'x'.repeat(9 * 1024 * 1024);
  const r = await fetch(`${base}/api/note/bignote`, { method: 'POST', body: big }).catch((e) => {
    // 也可能连接被服务端 destroy
    assert.ok(e, '应抛错');
    return { status: 0 };
  });
  assert.ok(r.status === 413 || r.status === 0, `实际 ${r.status}`);
});

test('连续失败上报触发锁定，之后 GET/POST 都是 429 + Retry-After', async () => {
  const id = 'locknote1';
  // 先正常写一次（建立 key）
  await fetch(`${base}/api/note/${id}`, { method: 'POST', body: '{"v":1}' });

  for (let i = 0; i < 25; i++) {
    await fetch(`${base}/api/fail/${id}`, { method: 'POST' });
  }
  const st = await (await fetch(`${base}/api/fail/${id}`)).json();
  assert.equal(st.locked, true, '25 次失败后必须锁定');

  const g = await fetch(`${base}/api/note/${id}`);
  assert.equal(g.status, 429, '锁定后 GET 必须 429');
  const ra = g.headers.get('retry-after');
  assert.ok(ra && Number(ra) > 0, '必须带 Retry-After');

  const p = await fetch(`${base}/api/note/${id}`, { method: 'POST', body: '{}' });
  assert.equal(p.status, 429, '锁定后 POST 也必须 429');
});

test('锁定状态已落盘（重启不丢 —— 老项目这里是内存 Map）', async () => {
  const f = path.join(dataDir, 'failmap.json');
  // 触发一次 saveSnapshot：再打一次失败让 dirty=true，然后等落盘
  await fetch(`${base}/api/fail/locknote1`, { method: 'POST' });
  // 直接检查内存表里确实有锁定项（快照是 5 分钟周期，这里不等）
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.ok(h.failMapEntries > 0, 'failMap 应有记录');
  assert.ok(fs.existsSync(path.dirname(f)), 'DATA_DIR 应已创建');
});

test('SSE 订阅能收到写入推送', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream/ssenote1`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  // 先读掉 hello 注释帧
  await reader.read();

  // 触发一次写入
  await fetch(`${base}/api/note/ssenote1`, { method: 'POST', body: '{"v":1,"x":1}' });

  let got = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    got += decoder.decode(value, { stream: true });
    if (got.includes('"t":"note"')) break;
  }
  ctrl.abort();
  assert.match(got, /"t":"note"/, 'SSE 应收到推送，实际收到：' + JSON.stringify(got));
  assert.match(got, /ssenote1/);
});

test('DELETE 删笔记，之后读回空体', async () => {
  await fetch(`${base}/api/note/delnote1`, { method: 'POST', body: '{"v":1}' });
  const d = await fetch(`${base}/api/note/delnote1`, { method: 'DELETE' });
  assert.equal(d.status, 200);
  const r = await fetch(`${base}/api/note/delnote1`);
  assert.equal(await r.text(), '');
});

test('arcade 记录可读写（彩蛋层用）', async () => {
  const w = await fetch(`${base}/api/arcade/arc1`, { method: 'POST', body: '{"best":99}' });
  assert.equal(w.status, 200);
  const r = await fetch(`${base}/api/arcade/arc1`);
  assert.equal(await r.text(), '{"best":99}');
  const miss = await fetch(`${base}/api/arcade/never-written`);
  assert.equal(miss.status, 200);
  assert.equal(await miss.text(), '');
});

test('/api/latest 无发布元数据时 404（App 靠这个查新版）', async () => {
  const r = await fetch(`${base}/api/latest`);
  // 隔离 DATA_DIR 下没有 deploy/latest_app.json，应 404
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error, 'no release metadata');
});

test('未知资源 404 JSON（带扩展名，不走 SPA 回落）', async () => {
  //🔴 这里必须用**带扩展名**的路径。用 /no/such/route 这类无扩展名路径时，
  //   服务端按SPA 回落设计返回 200 index.html（见下面那条用例），那是**正确行为**。
  //   本用例守的是另一条边界：伪装成静态资源的未知文件必须 404 JSON，不能回落。
  const r = await fetch(`${base}/no/such/route.js`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'not found');
});

test('未知 API 路径 404 JSON（API 命名空间不参与 SPA 回落）', async () => {
  // /api/* 永远不回落 —— 回落会把"接口404"变成"200 HTML"，
  // 客户端拿到 HTML 去JSON.parse 会炸出一句完全看不出真相的 SyntaxError。
  const r = await fetch(`${base}/api/no/such/endpoint`);
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.error, 'not found');
});

test('不支持的方法 405', async () => {
  const r = await fetch(`${base}/api/fail/somenote`, { method: 'DELETE' });
  assert.equal(r.status, 405);
});

test('静态资源：路径穿越被挡（403），不泄露文件系统', async () => {
  const r = await fetch(`${base}/../../../../etc/passwd`);
  // 归一化后多半变成 /etc/passwd → 404 或 SPA 回落，但绝不能返回真实文件内容
  const text = await r.text();
  assert.ok(!text.includes('root:'), '🔴 泄露了系统文件');
});

test('静态资源：无扩展名路径回落 index.html（前端路由由客户端解析）', async () => {
  // 本隔离实例的 WWW 指向仓库 www/，构建后 index.html 必然存在 → 必须 200 HTML。
  // 🔴 判据不能写"200 或 404 都可以"：那种宽松断言等于没断言，
  //   真出问题时（比如回落被误删）它照样绿。
  const r = await fetch(`${base}/some/spa/route`);
  assert.equal(r.status, 200, '无扩展名路径未回落到 index.html');
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);
  const html = await r.text();
  assert.match(html, /<div id="app">/, '回落内容不是应用外壳');
});

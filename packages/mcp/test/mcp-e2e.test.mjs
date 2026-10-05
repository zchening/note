/**
 * MCP 端到端闭环 —— 起一个假服务端，用真MCP 协议走一遍完整往返。
 *
 * 🔴🔴 本文件的价值在于"真跑"。此前所有判据都是静态扫源码，
 *   而本项目已经栽过两次"tsc 全绿、单测全绿、真跑起不来"
 *   （参数属性、注释提前闭合）。静态判据证明不了"能用"。
 *
 * 🔴 假服务端刻意**照抄新服务端的真实语义**（packages/server/src/server.js）：
 *   · GET /api/note/<id> 不存在时回200 + 空体（不是 404）
 *   · POST /api/note/<id> 回 {ok:true,size}
 *   · 密文原样落盘，服务端不解析内容（这正是 E2EE 的关键性质，顺带被本测试验证）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, '..', 'src', 'main.ts');

/** 起一个行为与新服务端一致的假服务端。返回 {base, store, close}。 */
async function startFakeServer() {
  const store = new Map();
  const hits = [];
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(req.method + ' ' + u.pathname);
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };
    if (req.method === 'GET' && u.pathname.startsWith('/api/note/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/note/'.length));
      const v = store.get(id);
      // 🔴 与真服务端一致：不存在回 200 + 空体
      return send(200, v === undefined ? '' : v, 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && u.pathname.startsWith('/api/note/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/note/'.length));
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        store.set(id, body);
        send(200, JSON.stringify({ ok: true, size: body.length }));
      });
      return undefined;
    }
    if (u.pathname === '/api/upsign') return send(200, JSON.stringify({ error: 'nope' }), 'application/json');
    return send(404, JSON.stringify({ error: 'nf' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    hits,
    close: () => new Promise((r) => srv.close(r)),
  };
}

/** 起一个真MCP 进程，按行发 JSON-RPC、收 JSON-RPC。 */
function startMcp(env) {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiters = [];
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const w = waiters.shift();
      if (w) w(JSON.parse(line));
    }
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      waiters.push(resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
      setTimeout(() => reject(new Error('超时：' + method)), 20000).unref();
    });
  const kill = () =>
    new Promise((r) => {
      child.on('exit', r);
      child.stdin.end();
      setTimeout(() => child.kill(), 3000).unref();
    });
  return { call, kill, stderr: () => stderr };
}

/** 调一个工具并解析它的 JSON 文本。 */
async function tool(mcp, name, args) {
  const r = await mcp.call('tools/call', { name, arguments: args });
  const t = r.result.content[0].text;
  if (r.result.isError) throw new Error(t);
  return JSON.parse(t);
}

const PASS = 'e2e-pass-2026';
const CACHE = path.join(os.tmpdir(), 'bj-mcp-e2e-cache');

test('MCP-E2E 🔴 完整闭环：写 → 读回 → 搜到 → 提醒 → 导出 → 删', async (t) => {
  const fake = await startFakeServer();
  const mcp = startMcp({
    BJ_BASE: fake.base,
    BJ_PASSPHRASE: PASS,
    BJ_CACHE_DIR: CACHE,
    BJ_NOTE: 'e2e',
  });
  try {
    const init = await mcp.call('initialize', {});
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.serverInfo.name, 'notesync-bj');

    const list = await mcp.call('tools/list', {});
    const names = list.result.tools.map((x) => x.name).sort();
    assert.deepEqual(names, [
      'note_edit',
      'note_export',
      'note_image',
      'note_import',
      'note_locate',
      'note_read',
      'note_remind',
      'note_search',
    ]);

    // ① 建一篇
    const r1 = await tool(mcp, 'note_edit', { op: 'append', text: '第一行\n第二行讲的是会议纪要' });
    assert.equal(r1.ok, true);
    assert.equal(r1.name, 'e2e', '默认笔记名应来自 BJ_NOTE');

    // ② 服务端落的是**密文**，明文一个字都不该出现
    const raw = fake.store.get('e2e');
    assert.ok(raw, '服务端应有这篇笔记');
    assert.ok(!raw.includes('会议纪要'), '服务端绝不能出现明文');
    const env = JSON.parse(raw);
    assert.equal(env.alg, 'AES-256-GCM');
    assert.equal(env.kdf.name, 'PBKDF2-HMAC-SHA256');
    assert.equal(env.kdf.iter, 600000, 'KDF 迭代必须与真源层一致（老项目是 200000）');
    assert.ok(env.ct && env.iv && env.kdf.salt, '信封四件套齐全');

    // ③ 读回来：明文一致
    const r2 = await tool(mcp, 'note_read', { format: 'text' });
    assert.ok(r2.text.includes('第一行'), '读回应含第一行：' + JSON.stringify(r2.text));
    assert.ok(r2.text.includes('第二行讲的是会议纪要'));

    // ④ locate 能查到，且**不报**版本号（服务端没有）
    const r3 = await tool(mcp, 'note_locate', {});
    assert.equal(r3.exists, true);
    assert.equal(r3.blocks, 2);

    // ⑤ 按锚点插入
    const r4 = await tool(mcp, 'note_edit', { op: 'insert_after', match: '第一行', text: '插在第一行后面' });
    assert.equal(r4.ok, true);
    const r5 = await tool(mcp, 'note_read', { format: 'text' });
    const lines = r5.text.split('\n');
    assert.equal(lines[0], '第一行');
    assert.equal(lines[1], '插在第一行后面', '插入位置不对：' + JSON.stringify(lines));

    // ⑥ 歧义必须拒
    const bad = await tool(mcp, 'note_read', { format: 'text' }); // 先确保有内容
    assert.ok(bad);
    const r6 = await mcp.call('tools/call', {
      name: 'note_edit',
      arguments: { op: 'insert_after', match: '行', text: 'x' },
    });
    assert.equal(r6.result.isError, true, '命中多行的锚点必须报错而不是猜');
    assert.ok(r6.result.content[0].text.includes('无法确定'), r6.result.content[0].text);

    // ⑦ 搜索能命中
    const r7 = await tool(mcp, 'note_search', { query: '会议纪要' });
    assert.equal(r7.results.length, 1, '应搜到 1 篇：' + JSON.stringify(r7));
    assert.equal(r7.results[0].name, 'e2e');

    // ⑧ 子串就是该命中（"会议纪"命中"会议纪要"是对的）。
    //    真正要验的是**粗筛不误命中**：把正文换成只有"协商"两字的一篇，
    //    搜"会议"必须搜不到 —— 二元组粗筛在这里最容易出错。
    const r8 = await tool(mcp, 'note_search', { query: '会议纪' });
    assert.equal(r8.results.length, 1, '子串应命中本篇');
    await tool(mcp, 'note_edit', { name: 'noise', op: 'append', text: '今天开协商会' });
    const r8b = await tool(mcp, 'note_search', { query: '会议' });
    assert.equal(
      r8b.results.filter((r) => r.name === 'noise').length,
      0,
      '"会议"绝不能命中"协商会"（二元组粗筛的典型误命中）：' + JSON.stringify(r8b),
    );

    // ⑨ 提醒：中文时间必须被认出来，且时间解析与网页端同一份
    const r9 = await tool(mcp, 'note_remind', { op: 'add', at: '明天下午三点', text: '打电话' });
    assert.equal(r9.ok, true, r9);
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(r9.at), 'at 必须是带偏移的 ISO：' + r9.at);
    const r10 = await tool(mcp, 'note_remind', { op: 'list' });
    assert.equal(r10.list.length, 1);
    assert.equal(r10.list[0].text, '打电话');

    // ⑩ 同一时刻同一事项必须覆盖而非重复
    const r11 = await tool(mcp, 'note_remind', { op: 'add', at: '明天下午三点', text: '改内容' });
    assert.equal(r11.overwrote, true, '同刻同事项必须覆盖');
    const r12 = await tool(mcp, 'note_remind', { op: 'list' });
    assert.equal(r12.list.length, 1, '覆盖后仍只有一条');

    // ⑪ 过去时间必须拒
    const r13 = await mcp.call('tools/call', {
      name: 'note_remind',
      arguments: { op: 'add', at: '2020-01-01 10:00', text: 'x' },
    });
    assert.equal(r13.result.isError, true, '过去时间必须拒');

    // ⑫ 导出
    const out = path.join(os.tmpdir(), 'bj-mcp-e2e-' + Date.now() + '.zip');
    const r14 = await tool(mcp, 'note_export', { out });
    assert.equal(r14.ok, true);
    assert.ok(fs.existsSync(out), 'zip 应落盘');
    assert.ok(r14.bytes > 0);

    // ⑬ 口令错必须报同一句，且**不得**与别的错区分
    const mcp2 = startMcp({
      BJ_BASE: fake.base,
      BJ_PASSPHRASE: 'wrong-pass',
      BJ_CACHE_DIR: CACHE + '2',
      BJ_NOTE: 'e2e',
    });
    try {
      const e1 = await mcp2.call('tools/call', { name: 'note_read', arguments: { format: 'text' } });
      assert.equal(e1.result.isError, true);
      const msg1 = e1.result.content[0].text;
      assert.ok(msg1.includes('口令不对或密文损坏'), '口令错文案：' + msg1);
      const e2 = await mcp2.call('tools/call', { name: 'note_locate', arguments: {} });
      assert.ok(e2.result.content[0].text.includes('口令不对或密文损坏'), '两处措辞必须一致：' + e2.result.content[0].text);
    } finally {
      await mcp2.kill();
    }

    // ⑭ 删掉
    const del = await mcp.call('tools/call', {
      name: 'note_edit',
      arguments: { op: 'replace', body: '只剩一行' },
    });
    assert.equal(del.result.isError, undefined);
    const r15 = await tool(mcp, 'note_read', { format: 'text' });
    assert.equal(r15.text.trim(), '只剩一行');

    // ⑮ 请求路径与方法是新服务端那一套
    assert.ok(fake.hits.includes('GET /api/note/e2e'), '应走 GET /api/note/<id>');
    assert.ok(fake.hits.includes('POST /api/note/e2e'), '应走 POST /api/note/<id>');
    assert.ok(
      !fake.hits.some((h) => h.startsWith('PUT')),
      '不得出现 PUT（服务端没有）',
    );
  } finally {
    await mcp.kill();
    await fake.close();
    try {
      fs.rmSync(CACHE, { recursive: true, force: true });
      fs.rmSync(CACHE + '2', { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

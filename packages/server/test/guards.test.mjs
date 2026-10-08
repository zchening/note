/**
 * 凭据闸（writeKey）+ 扫描守卫 + 门牌保留名测试 —— 起真进程打真 HTTP
 *
 * 移植判据（与老项目 server.js v10.0.0 语义逐条对应）：
 *  - off 档：行为与无闸逐字相同（不拒任何写）——但 PUT 别名必须存在（老 MCP 兼容）
 *  - claim：纯登记、幂等、错凭据硬 403、哈希不出门、不建档
 *  - full 档：已认领无凭据 403 / 错凭据 403 / wkOld 自证原子换绑 / 真新建无凭据 403
 *  - DELETE 与 history 追加同闸（正门锁了侧门不锁等于白装）
 *  - RESERVED 只挡新建；扫描守卫只记 GET miss
 *
 * 两实例分档：env 固定档位，避免 wkMode() 5s 缓存拖慢测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 🔴 判据必须 import 生产代码（抄进测试的判据恒绿）。guards 单独成文件就是为了这个。
import { wkHash, RESERVED_IDS } from '../src/guards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

const ENV_NOTE = {
  v: 1,
  alg: 'AES-256-GCM',
  kdf: { name: 'PBKDF2', iter: 600000, salt: 'czNhbHQ' },
  iv: 'aXZ2',
  ct: 'Y3RjdA',
};

const CRED_A = 'cred-aaaa-1111-aaaa-1111';
const CRED_B = 'cred-bbbb-2222-bbbb-2222';
const CRED_C = 'cred-cccc-3333-cccc-3333';

/** 起一个隔离实例（独立 DATA_DIR + WWW + DEPLOY + 随机端口 + 指定档位） */
async function boot(extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-guard-d-'));
  const wwwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-guard-w-'));
  fs.writeFileSync(path.join(wwwDir, 'index.html'), '<!doctype html><html><body></body></html>', 'utf8');
  const deployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-guard-dep-'));
  fs.mkdirSync(path.join(deployDir, 'apk'), { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NS_BJ_PORT: String(port),
      NOTESYNC_BJ_DATA_DIR: dataDir,
      NOTESYNC_BJ_WWW: wwwDir,
      NOTESYNC_BJ_DEPLOY: deployDir,
      NS_BJ_VERSION: '9.9.9-test',
      NS_BJ_BUILD_DATE: '2026-10-08',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { child, base, dataDir };
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('服务端 10 秒内没起来');
}

const post = (base, id, body, headers = {}) =>
  fetch(`${base}/api/note/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const put = (base, id, body, headers = {}) =>
  fetch(`${base}/api/note/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const get = (base, id) => fetch(`${base}/api/note/${id}`);
const claim = (base, id, cred) =>
  fetch(`${base}/api/note/${id}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cred ? { 'x-note-key': cred } : {}) },
    body: '{}',
  });
const del = (base, id, cred) =>
  fetch(`${base}/api/note/${id}`, { method: 'DELETE', headers: cred ? { 'x-note-key': cred } : {} });

/* ================================================================
 * 实例 A：off 档（默认）——行为与无闸逐字相同，但登记/别名要可用
 * ================================================================ */
test('off 档', async (t) => {
  const { child, base, dataDir } = await boot(); // 不设 NS_BJ_WK_MODE → off
  t.after(() => child.kill());

  await t.test('POST 写笔记成功且 GET 读回同文（应有读写往返）', async () => {
    const w = await post(base, 'guard-a1', ENV_NOTE);
    assert.equal(w.status, 200);
    const g = await get(base, 'guard-a1');
    assert.equal(g.status, 200);
    assert.deepEqual(await g.json(), ENV_NOTE);
  });

  await t.test('PUT 别名与 POST 同效（老 MCP 兼容，不应再 404）', async () => {
    const body2 = { ...ENV_NOTE, ct: 'cHV0cw' };
    const w = await put(base, 'guard-a1', body2);
    assert.equal(w.status, 200);
    const g = await (await get(base, 'guard-a1')).json();
    assert.equal(g.ct, 'cHV0cw');
  });

  await t.test('claim 登记成功且幂等，错凭据硬 403（不应静默换绑）', async () => {
    const c1 = await claim(base, 'guard-a1', CRED_A);
    assert.equal(c1.status, 200);
    assert.equal((await c1.json()).claimed, true);
    const c2 = await claim(base, 'guard-a1', CRED_A);
    assert.equal(c2.status, 200);
    const c3 = await claim(base, 'guard-a1', CRED_B);
    assert.equal(c3.status, 403);
  });

  await t.test('wkHash 落盘但不出门（"是否已认领"本身是探测信号）', async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'notes', 'guard-a1.json'), 'utf8'));
    assert.equal(raw.wkHash, wkHash(CRED_A));
    const g = await (await get(base, 'guard-a1')).json();
    assert.equal('wkHash' in g, false);
    assert.equal(g.ct, 'cHV0cw'); // 其余字段原样
  });

  await t.test('off 档下无凭据写已认领笔记仍放行（off 的全部承诺就是行为不变）', async () => {
    const w = await post(base, 'guard-a1', { ...ENV_NOTE, ct: 'b2Zm' });
    assert.equal(w.status, 200);
  });

  await t.test('claim 不建档：不存在的笔记 404（不应顺手建档）', async () => {
    const c = await claim(base, 'guard-nope', CRED_A);
    assert.equal(c.status, 404);
  });

  await t.test('门牌保留名只挡新建（snake 等应 400，普通名不应）', async () => {
    assert.equal(RESERVED_IDS.has('snake'), true); // 判据钉住清单本身来自生产代码
    const r1 = await post(base, 'snake', ENV_NOTE);
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).error, 'reserved name');
    const r2 = await post(base, 'guard-normal', ENV_NOTE);
    assert.equal(r2.status, 200);
  });

  await t.test('扫描守卫：80 个不存在的 GET 之后第 81 个 429', async () => {
    for (let i = 0; i < 80; i++) {
      const g = await get(base, `ghost-${i}`);
      assert.equal(g.status, 200); // 不存在也应 200+空体（形状不可改）
      assert.equal(await g.text(), '');
    }
    const g81 = await get(base, 'ghost-81');
    assert.equal(g81.status, 429);
  });
});

/* ================================================================
 * 实例 B：full 档——凭据硬要求
 * ================================================================ */
test('full 档', async (t) => {
  const { child, base, dataDir } = await boot({ NS_BJ_WK_MODE: 'full' });
  t.after(() => child.kill());

  await t.test('真新建无凭据 403 credential required + mode', async () => {
    const w = await post(base, 'guard-b1', ENV_NOTE);
    assert.equal(w.status, 403);
    const j = await w.json();
    assert.equal(j.error, 'credential required');
    assert.equal(j.mode, 'full');
  });

  await t.test('带凭据新建 200 并自动认领；此后无凭据/错凭据 403、对凭据 200', async () => {
    const w1 = await post(base, 'guard-b1', ENV_NOTE, { 'x-note-key': CRED_A });
    assert.equal(w1.status, 200);
    const w2 = await post(base, 'guard-b1', { ...ENV_NOTE, ct: 'eA' });
    assert.equal(w2.status, 403);
    assert.equal((await w2.json()).error, 'credential required');
    const w3 = await post(base, 'guard-b1', { ...ENV_NOTE, ct: 'eA' }, { 'x-note-key': CRED_B });
    assert.equal(w3.status, 403);
    assert.equal((await w3.json()).error, 'forbidden');
    const w4 = await post(base, 'guard-b1', { ...ENV_NOTE, ct: 'eA' }, { 'x-note-key': CRED_A });
    assert.equal(w4.status, 200);
  });

  await t.test('wkOld 自证原子换绑：新凭据 + wkOld=旧凭据 → 200；旧凭据此后失效；wkOld 不落盘', async () => {
    const body = { ...ENV_NOTE, ct: 'c3dhcA', wkOld: CRED_A };
    const w = await post(base, 'guard-b1', body, { 'x-note-key': CRED_C });
    assert.equal(w.status, 200);
    const oldGone = await post(base, 'guard-b1', { ...ENV_NOTE, ct: 'eA' }, { 'x-note-key': CRED_A });
    assert.equal(oldGone.status, 403);
    const newOk = await post(base, 'guard-b1', { ...ENV_NOTE, ct: 'eA' }, { 'x-note-key': CRED_C });
    assert.equal(newOk.status, 200);
    const raw = fs.readFileSync(path.join(dataDir, 'notes', 'guard-b1.json'), 'utf8');
    assert.equal(raw.includes('wkOld'), false);
    assert.equal(JSON.parse(raw).wkHash, wkHash(CRED_C));
  });

  await t.test('DELETE 同闸：无凭据 403、带凭据 200', async () => {
    const d1 = await del(base, 'guard-b1');
    assert.equal(d1.status, 403);
    const d2 = await del(base, 'guard-b1', CRED_C);
    assert.equal(d2.status, 200);
    assert.equal(fs.existsSync(path.join(dataDir, 'notes', 'guard-b1.json')), false);
  });

  await t.test('history 追加同闸：无凭据 403、带凭据 200', async () => {
    await post(base, 'guard-b2', ENV_NOTE, { 'x-note-key': CRED_A });
    const histBody = { ...ENV_NOTE, manual: true };
    const h1 = await put(base, 'guard-b2/history', histBody);
    assert.equal(h1.status, 403);
    const h2 = await put(base, 'guard-b2/history', histBody, { 'x-note-key': CRED_A });
    assert.equal(h2.status, 200);
    const list = await (await get(base, 'guard-b2/history')).json();
    assert.equal(list.list.length, 1);
  });
});

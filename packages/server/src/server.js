/**
 * NoteSync bj 服务端 —— 零依赖 Node HTTP
 *
 * 设计取舍（ARCH.md §4.5）：
 *  - 零运行时依赖。服务端看到的是密文，密钥在浏览器；多一个依赖就多一个
 *    能读 DATA_DIR 的第三方代码。这里只用 node: 内置模块。
 *  - JSDoc // @ts-check + 单独的 tsconfig.server.json 做类型检查（不引 tsc 到运行时）。
 *  - SSE 单向推送 + POST 写入，不上 WebSocket：零依赖 Node 上 WS 是纯负资产
 *    （要自己实现握手/分帧/心跳/重连，代码量翻三倍，收益为零）。
 *  - 端口 8090（老项目 8080），数据目录 C:/Services/NoteSyncBj —— 与老项目六维隔离。
 *
 * 接口刻意与老项目保持一致（/api/note/:id、/api/upsign、/api/latest、/api/fail、
 * /api/arcade、SSE），这样 MCP server 可以零改动切到新实例。
 */

// @ts-check
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import * as failmap from './failmap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

const PORT = Number(process.env.NS_BJ_PORT || 8090);
const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = process.env.NOTESYNC_BJ_DATA_DIR || path.join(APP_DIR, 'data');
const WWW_DIR = process.env.NOTESYNC_BJ_WWW || path.join(APP_DIR, 'www');
const APP_VERSION = process.env.NS_BJ_VERSION || '0.0.0-dev';
const BUILD_DATE = process.env.NS_BJ_BUILD_DATE || 'unknown';

/** 单条笔记密文上限 8MB —— 超了直接拒，避免有人拿它当文件服务器 */
const MAX_BODY = 8 * 1024 * 1024;

const NOTES_DIR = path.join(DATA_DIR, 'notes');
const META_DIR = path.join(DATA_DIR, 'meta');
const ARCADE_DIR = path.join(DATA_DIR, 'arcade');
const FAILMAP_FILE = path.join(DATA_DIR, 'failmap.json');

for (const d of [DATA_DIR, NOTES_DIR, META_DIR, ARCADE_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ------------------------------------------------------------------ *
 * 安全不变量（从老项目继承，不许放宽）
 * ------------------------------------------------------------------ */

/** 笔记 id 白名单：小写字母数字与少量符号，禁止路径穿越与超长名 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * 取客户端 IP。
 *
 * Caddy 反代把真实 IP 追加在 XFF **末尾**，首段是客户端可伪造的。
 * 取首段等于任何人都能靠轮换 XFF 头绕过失败锁定，必须取末段。
 * （老项目 v5.52 踩过这个坑，注释留着，别改回去。）
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ------------------------------------------------------------------ *
 * 响应helpers
 * ------------------------------------------------------------------ */

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

function sendJson(res, code, obj, headers = {}) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY) {
        reject(Object.assign(new Error('BODY_TOO_LARGE'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * SSE
 * ------------------------------------------------------------------ */

/** @type {Map<string, Set<import('node:http').ServerResponse>>} */
const sseClients = new Map();
let sseActive = 0;

function sseAdd(id, res) {
  if (!sseClients.has(id)) sseClients.set(id, new Set());
  sseClients.get(id).add(res);
  sseActive++;
}

function sseDel(id, res) {
  const set = sseClients.get(id);
  if (set) {
    set.delete(res);
    sseActive--;
    if (set.size === 0) sseClients.delete(id);
  }
}

function sseBroadcast(id, payload) {
  const set = sseClients.get(id);
  if (!set || set.size === 0) return 0;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  let n = 0;
  for (const res of set) {
    try {
      res.write(frame);
      n++;
    } catch {
      // 客户端已断：顺手清掉，别让 Set 越积越大（老项目这里漏了）
      set.delete(res);
    }
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * 存储（密文原样落盘，服务端不解析内容）
 * ------------------------------------------------------------------ */

function notePath(id) {
  return path.join(NOTES_DIR, `${id}.json`);
}

function metaPath(id) {
  return path.join(META_DIR, `${id}.json`);
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch {
    // Windows 上 rename 到已存在文件会失败
    await fsp.rm(file, { force: true });
    await fsp.rename(tmp, file);
  }
}

/* ------------------------------------------------------------------ *
 * 图床签名（Cloudinary upload preset 的 HMAC，v10.0.0 起服务端签发）
 * ------------------------------------------------------------------ */

const UPSIGN_SECRET = process.env.NS_BJ_UPSIGN_SECRET || '';
const UPSIN_PRESET = process.env.NS_BJ_UPSIGN_PRESET || '';
const CLOUD_NAME = process.env.NS_BJ_CLOUD_NAME || '';

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method || 'GET';

  /* ---------- 健康检查（自报版本，部署核对用） ---------- */
  if (method === 'GET' && p === '/healthz') {
    return sendJson(res, 200, {
      ok: true,
      app: 'notesync-bj',
      version: APP_VERSION,
      buildDate: BUILD_DATE,
      port: PORT,
      dataDir: DATA_DIR,
      failMapEntries: failmap.size(),
      sseActive,
      uptimeSec: Math.floor(process.uptime()),
      node: process.version,
    });
  }

  /* ---------- App 升级元数据（App 唯一查新版的地方） ---------- */
  if (method === 'GET' && p === '/api/latest') {
    const f = path.join(APP_DIR, 'deploy', 'latest_app.json');
    try {
      const txt = await fsp.readFile(f, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(txt);
    } catch {
      return sendJson(res, 404, { error: 'no release metadata' });
    }
  }

  /* ---------- 失败上报 / 锁定查询 ---------- */
  if (p === '/api/fail' || p.startsWith('/api/fail/')) {
    const id = p === '/api/fail' ? url.searchParams.get('id') || '' : p.slice('/api/fail/'.length);
    if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
    const key = `${clientIp(req)}:${id}`;
    if (method === 'GET') {
      const st = failmap.checkLimit(key);
      return sendJson(res, 200, st);
    }
    if (method === 'POST') {
      const st = failmap.recordFail(key);
      return sendJson(res, st.locked ? 429 : 200, st, st.locked ? { 'Retry-After': String(st.retryAfter) } : {});
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  /* ---------- 笔记读 ---------- */
  if (method === 'GET' && p.startsWith('/api/note/')) {
    const id = p.slice('/api/note/'.length);
    if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
    const key = `${clientIp(req)}:${id}`;
    const st = failmap.checkLimit(key);
    if (st.locked) {
      return sendJson(res, 429, { error: 'locked' }, { 'Retry-After': String(st.retryAfter) });
    }
    try {
      const txt = await fsp.readFile(notePath(id), 'utf8');
      // 解密失败也要给 200 + 空体：客户端据此判定"此处无笔记"，
      // 给 4xx 会让它当成网络错误重试（老项目这个坑踩过）
      return send(res, 200, txt);
    } catch {
      return send(res, 200, '');
    }
  }

  /* ---------- 笔记写 ---------- */
  if (method === 'POST' && p.startsWith('/api/note/')) {
    const id = p.slice('/api/note/'.length);
    if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
    const key = `${clientIp(req)}:${id}`;
    const st = failmap.checkLimit(key);
    if (st.locked) {
      return sendJson(res, 429, { error: 'locked' }, { 'Retry-After': String(st.retryAfter) });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      if (e && e.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: 'too large' });
      return sendJson(res, 400, { error: 'bad body' });
    }
    const text = body.toString('utf8');
    try {
      await writeAtomic(notePath(id), text);
      failmap.recordOk(key);
      sseBroadcast(id, { t: 'note', id, v: Date.now() });
      return sendJson(res, 200, { ok: true, size: text.length });
    } catch (e) {
      return sendJson(res, 500, { error: 'write failed', detail: String(e && e.message) });
    }
  }

  /* ---------- 删除 ---------- */
  if (method === 'DELETE' && p.startsWith('/api/note/')) {
    const id = p.slice('/api/note/'.length);
    if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
    try {
      await fsp.rm(notePath(id), { force: true });
      sseBroadcast(id, { t: 'del', id, v: Date.now() });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: 'delete failed' });
    }
  }

  /* ---------- SSE 订阅 ---------- */
  if (method === 'GET' && p.startsWith('/api/stream/')) {
    const id = p.slice('/api/stream/'.length);
    if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': hello\n\n');
    sseAdd(id, res);
    // 心跳：穿过 Caddy / Cloudflare 的空闲超时，否则长连接会被静默掐断
    const hb = setInterval(() => {
      try {
        res.write(': hb\n\n');
      } catch {
        clearInterval(hb);
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(hb);
      sseDel(id, res);
    });
    return undefined;
  }

  /* ---------- 图床签名 ---------- */
  if (method === 'POST' && p === '/api/upsign') {
    if (!UPSIGN_SECRET) return sendJson(res, 501, { error: 'upsign not configured' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha1', UPSIGN_SECRET).update(`timestamp=${ts}`).digest('hex');
    return sendJson(res, 200, { timestamp: ts, signature: sig, cloudName: CLOUD_NAME, preset: UPSIN_PRESET });
  }

  /* ---------- 小游戏记录（彩蛋层用） ---------- */
  if (p.startsWith('/api/arcade')) {
    const id = p === '/api/arcade' ? url.searchParams.get('id') || '' : p.slice('/api/arcade/'.length);
    if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
    if (method === 'GET') {
      try {
        return send(res, 200, await fsp.readFile(path.join(ARCADE_DIR, `${id}.json`), 'utf8'));
      } catch {
        return send(res, 200, '');
      }
    }
    if (method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 413, { error: 'too large' });
      }
      try {
        await writeAtomic(path.join(ARCADE_DIR, `${id}.json`), body.toString('utf8'));
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 500, { error: 'write failed' });
      }
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  /* ---------- 静态资源 ---------- */
  if (method === 'GET' || method === 'HEAD') {
    // 🔴 `/api/*` 永不走 SPA 回落。
    //   前面所有 API 分支都没命中 → 这里就是"接口不存在"，必须 404 JSON。
    //   若让它落进 serveStatic 的无扩展名回落，客户端会拿到 200 + index.html，
    //   然后 JSON.parse 炸出一句 `Unexpected token '<' in JSON`——
    //   报错位置离真正的原因（接口路径拼错了）十万八千里，且完全看不出是404 被吃掉了。
    //   与 sw.js 里"`/api/*` 永不走缓存"是同一条纪律的两面：一个管离线，一个管回落。
    if (p === '/api' || p.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'not found' });
    }
    return serveStatic(p, res, method === 'HEAD');
  }

  return sendJson(res, 404, { error: 'not found' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(p, res, headOnly) {
  let rel = p === '/' ? '/index.html' : p;
  // 路径穿越：解析后必须仍在 WWW_DIR 内
  const target = path.resolve(WWW_DIR, '.' + rel);
  if (!target.startsWith(path.resolve(WWW_DIR))) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const st = await fsp.stat(target);
    if (st.isDirectory()) {
      const idx = path.join(target, 'index.html');
      const buf = await fsp.readFile(idx);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(headOnly ? undefined : buf);
    }
    const buf = await fsp.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      // index.html 不缓存（保证发版即时生效），带 hash 的资源可以长缓存
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(headOnly ? undefined : buf);
  } catch {
    // SPA 回落：非资源路径一律给 index.html
    if (!path.extname(rel)) {
      try {
        const buf = await fsp.readFile(path.join(WWW_DIR, 'index.html'));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
        });
        return res.end(headOnly ? undefined : buf);
      } catch {
        /* 落到 404 */
      }
    }
    return sendJson(res, 404, { error: 'not found' });
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

const restored = failmap.loadSnapshot(FAILMAP_FILE);
failmap.startSnapshotTimer();
failmap.installExitHook();

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error('[server] 未捕获异常：', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
    else res.end();
  });
});

// SSE 长连接不能被默认超时掐断
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 72000;

server.listen(PORT, () => {
  console.log(`[notesync-bj] v${APP_VERSION} (${BUILD_DATE}) 监听 :${PORT}`);
  console.log(`[notesync-bj] DATA_DIR = ${DATA_DIR}`);
  console.log(`[notesync-bj] WWW_DIR = ${WWW_DIR}`);
  console.log(`[notesync-bj] failMap 恢复 ${restored} 条`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[notesync-bj] 收到 ${sig}，退出`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

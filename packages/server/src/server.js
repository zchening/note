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
import { upsignSign } from './upsign.js';
import * as guards from './guards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

const PORT = Number(process.env.NS_BJ_PORT || 8090);
const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = process.env.NOTESYNC_BJ_DATA_DIR || path.join(APP_DIR, 'data');
const WWW_DIR = process.env.NOTESYNC_BJ_WWW || path.join(APP_DIR, 'www');
// 🔴 OTA 元数据与 APK 的根目录。默认值与改动前逐字节一致（生产行为不变），
//   单独可覆盖是为了让测试能隔离 deploy/ —— 否则判据只能往真实仓库写假 APK。
const DEPLOY_DIR = process.env.NOTESYNC_BJ_DEPLOY || path.join(APP_DIR, 'deploy');
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

guards.init(DATA_DIR); // wk-mode.txt 档位文件定位（热切用，见 guards.js）

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

/* ---------- 凭据闸配套：笔记档读取（解析版） ---------- */

function noteExists(id) {
  try {
    return fs.existsSync(notePath(id));
  } catch {
    return false;
  }
}

/**
 * 读笔记档并解析。损坏/半截文件按 {} 处理（与"没有"同形，不抛、不 500）——
 * 老项目 readNote 对坏档静默回落 EMPTY 同款口径；凭据判据只关心 wkHash 字段。
 */
async function readNoteParsed(id) {
  try {
    const obj = JSON.parse(await fsp.readFile(notePath(id), 'utf8'));
    if (obj && typeof obj === 'object') return obj;
  } catch {
    // 没有 / 坏档：按空处理
  }
  return {};
}

/* ------------------------------------------------------------------ *
 * 历史版本快照环
 *
 * 🔴 移植依据：老项目 server.js:350-365（存储）+ :458-547（三个端点）逐条比对，
 *   **不靠推理定案**。
 *
 * 形态照老项目：独立文件 `<id>.hist.json`、FIFO 上限 10 条、列表只回元数据
 * （ts/v/manual/size，**不下发密文**，省流量）、相同密文不重复入栈、
 * 手动打点不参与挤出（先挤自动）、同毫秒去重。
 *
 * 🔴🔴 与老项目的三处**有意分歧** —— 都是新架构不同导致的，不是图省事：
 *
 *  1. **"没有这一版"返回 200 + 空体，不是 404**（老项目此处给 404）。
 *     本项目铁律：4xx 会让客户端当成网络错误去重试，而"这一版不存在"是正常状态。
 *     取单版时给 200 + 空体，客户端据此判"没有这一版"，与 GET /api/note/:id 同款。
 *
 *  2. **本段必须排在笔记读分支之前**。ID_RE 不含斜杠，
 *     `/api/note/abc/history` 落进主分支会被切成 `id="abc/history"` → 400。
 *     （老项目 :458 的注释记的是同一个坑。）且匹配用正则直判而不是
 *     `p.includes('/history')` —— 后者会把**笔记名恰好叫 history** 的那篇
 *     （`/api/note/history`）误吞掉，而笔记名是用户自己起的。
 *
 *  3. **快照存整个信封，不只 `{ct, iv}`**。新项目 envelope 自描述
 *     （ARCH.md §4.2.3），decryptString 会校验 v / alg / kdf.name / kdf.iter ——
 *     只存 ct/iv 解不开，且报错长得像"数据坏了"。返回形状仍是老项目
 *     `{ts, ct, iv}` 的超集（多带 v/alg/kdf），客户端挑信封字段喂 decryptString。
 *
 *  不移植老项目的"孤儿快照 403"：那条是 writeKey 灰度期的配套，而新项目解锁时
 *  **不建笔记档**（首推才落盘）—— 加上它会让"新笔记手动打第一个点"直接失败。
 *  任意 id 造文件的攻击面与既有的 `POST /api/note/:id` 完全一致，本端点不扩大它。
 * ------------------------------------------------------------------ */

/** 快照环上限。与老项目 HISTORY_MAX 同值，不擅自放宽。 */
const HISTORY_MAX = 10;

function histPath(id) {
  return path.join(NOTES_DIR, `${id}.hist.json`);
}

async function readHist(id) {
  try {
    const h = JSON.parse(await fsp.readFile(histPath(id), 'utf8'));
    if (h && Array.isArray(h.list)) return h;
  } catch {
    // 没有 / 半截坏文件：按空环处理（与笔记读同款，不抛、不 500）
  }
  return { list: [] };
}

async function writeHist(id, h) {
  await writeAtomic(histPath(id), JSON.stringify(h));
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
 * 图床签名（Cloudinary upload preset 的 HMAC，服务端签发）
 *
 * 🔴 移植依据：老项目 server.js:647-668（v10.0.0 形态）逐条比对。
 *   **不靠推理定案**，老源码读过。
 *
 * 为什么必须服务端签发：
 *   免签名 preset 直传的年代，cloud_name + preset 名就印在页面源码里 ——
 *   任何人拿它就能往本站图床账号白图：烧配额、塞违规内容连累封号。
 *   改法：preset 转 Signed，签名由本端点签发。云端 secret 只当**配额闸门**，
 *   不碰笔记明文，零知识不破。
 *
 * 已知边界（照老项目原样写进说明，不夸大）：
 *   本服务零知识，无从判断客户端是否已解锁，所以这一版拦的是
 *   「不经我服务器 + 无限量」；真正的「解锁才能签发」等 writeKey
 *   全量强制后在同一处加一行校验即可。
 * ------------------------------------------------------------------ */

const UPSIGN_SECRET = process.env.NS_BJ_UPSIGN_SECRET || '';
const UPSIGN_PRESET = process.env.NS_BJ_UPSIGN_PRESET || '';
const UPSIGN_FOLDER = process.env.NS_BJ_UPSIGN_FOLDER || '';
const UPSIGN_KEY = process.env.NS_BJ_UPSIGN_KEY || '';
const CLOUD_NAME = process.env.NS_BJ_CLOUD_NAME || '';

/**
 * 签名算法**不在本文件**，见 `./upsign.js`。
 *
 * 🔴 为什么要拆出去：判据必须 `import` 生产代码，而本文件是会自动 listen 的入口，
 *   import 它会顺带起一个服务。拆成纯函数才能被单测直接引用。
 *   ⚠ 部署时必须把 upsign.js 与 server.js 一起上传（同级目录）。
 *
 * 🔴 2026-10-06 订正：这里**曾经**写成 HMAC-SHA1，而 Cloudinary 要的是
 *   `SHA1(待签串 + api_secret)`。同 cloud/key/preset/folder/secret 下，
 *   老项目的票直传 200、我们的票 401 —— 实测证据与推导过程见 upsign.js 文件头。
 *   （我上一次只改了拼串顺序就宣告"根因是顺序"，是没验到底；两个 bug 是独立的。）
 */

/** upsign 配额闸门（按 IP，老项目同款内存 Map + 120s 过期清理）。 */
const upsignQuotaMap = new Map();
function upsignQuota(ip) {
  const now = Date.now();
  let r = upsignQuotaMap.get(ip);
  if (!r) {
    r = { m: 0, ms: now, d: 0, ds: now };
    upsignQuotaMap.set(ip, r);
  }
  if (now - r.ms >= 60000) {
    r.m = 0;
    r.ms = now;
  }
  if (now - r.ds >= 86400000) {
    r.d = 0;
    r.ds = now;
  }
  r.m += 1;
  r.d += 1;
  // 上界与老项目一致：分钟 12 次、日 200 次
  if (r.m > 12 || r.d > 200) {
    return { ok: false, retryAfter: Math.max(0, Math.ceil((60000 - (now - r.ms)) / 1000)) };
  }
  return { ok: true };
}


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
    const f = path.join(DEPLOY_DIR, 'latest_app.json');
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

  /* ---------- 认领笔记（凭据登记） ----------
   * 🔴 移植老项目 server.js:430-456（v10.0.0 B1）逐条比对。
   * 客户端首次解锁即调用，把「本机从口令派生出的写入凭据」登记到服务端。
   * 纯登记：不改正文、不递增版本；已认领且凭据相符=幂等成功；
   * 已认领而凭据不符=硬 403（绝不静默换绑——那是"可卸掉的防护"）。
   * 不建档：名字不存在直接 404，建档仍由首次写入负责。三种模式都允许认领——
   * off 档提前登记，正是为了让扫一遍笔记之后切 new-only/full 时存量已在保护圈内。
   * 🔴 必须排在通用 POST /api/note/ 分支之前：/api/note/x/claim 的 id 含斜杠，
   *   落到通用分支会被 validId 判 400。
   */
  if (method === 'POST' && /^\/api\/note\/[^/]+\/claim$/.test(p)) {
    const id = p.slice('/api/note/'.length, -'/claim'.length);
    if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
    req.resume(); // POST 带体：先抽干，任何分支都不留悬挂请求体
    const ip = clientIp(req);
    const key = `${ip}:${id}`;
    const st = failmap.checkLimit(key);
    if (st.locked) {
      return sendJson(res, 429, { error: 'locked' }, { 'Retry-After': String(st.retryAfter) });
    }
    const wkLock = guards.wkLimited(ip, id); // 认领端点同样要节流，否则它是绕过凭据锁的枚举入口
    if (wkLock) {
      return sendJson(res, 429, { error: 'locked', retryAfter: wkLock });
    }
    const wk = guards.wkHashFromReq(req);
    if (!wk) return sendJson(res, 400, { error: 'no credential' });
    if (!noteExists(id)) return sendJson(res, 404, { error: 'not found' });
    const cur = await readNoteParsed(id);
    // 损坏/半截档（认不出盐）此时认领会把真档覆写成「空档 + 外来哈希」= 打开一次即永久毁文。
    // 故一律拒写，并用 404 同形不多给信号（老项目复核②）。两种信封格式都认：
    // 本项目 {kdf:{salt}} / 老格式 {salt}——服务端不解析正文，只认"有没有盐"。
    const hasSalt = (cur.kdf && typeof cur.kdf.salt === 'string' && cur.kdf.salt) || (typeof cur.salt === 'string' && cur.salt);
    if (!hasSalt) return sendJson(res, 404, { error: 'not found' });
    const claimed = typeof cur.wkHash === 'string' && cur.wkHash.length === 64;
    if (claimed && cur.wkHash !== wk) {
      guards.wkRecordFail(ip, id);
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (!claimed) {
      cur.wkHash = wk; // 只加字段，其余原样不动
      await writeAtomic(notePath(id), JSON.stringify(cur));
      console.log('[claim] ' + id);
    }
    return sendJson(res, 200, { ok: true, claimed: true, v: cur.v || 0 });
  }

  /* ---------- 历史版本 ----------
   * 🔴🔴 必须排在下面笔记读分支**之前**：ID_RE 不含斜杠，
   *   `/api/note/abc/history` 会被笔记读分支切成 `id="abc/history"` → 400。
   *   （老项目 server.js:458 记的是同一个坑。）
   *   匹配用正则直判而不是 `p.includes('/history')`：后者会把笔记名恰好叫
   *   `history` 的那篇（`/api/note/history`）误吞进本段。
   *
   * GET  /api/note/:id/history      → 元数据列表（ts/v/manual/size，不含密文）
   * GET  /api/note/:id/history/:ts  → 那一版的信封（ct/iv/kdf/alg）
   * PUT  /api/note/:id/history      → 追加一版快照 {…信封, manual}
   */
  {
    const hm = /^\/api\/note\/([^/]+)\/history(?:\/(\d+))?$/.exec(p);
    if (hm) {
      const id = hm[1];
      if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
      const key = `${clientIp(req)}:${id}`;
      const st = failmap.checkLimit(key);
      if (st.locked) {
        return sendJson(res, 429, { error: 'locked' }, { 'Retry-After': String(st.retryAfter) });
      }

      if (method === 'GET') {
        const hist = await readHist(id);
        if (hm[2] !== undefined) {
          const item = hist.list.find((x) => String(x.ts) === hm[2]);
          // 🔴 没有这一版 = 200 + 空体（本项目铁律，与 GET /api/note/:id 同款）。
          //   给 404 会让客户端把它当成网络错误去重试，而"这一版不存在"是正常状态。
          if (!item) return send(res, 200, '');
          return sendJson(res, 200, {
            ts: item.ts,
            v: item.v,
            alg: item.alg,
            kdf: item.kdf,
            iv: item.iv,
            ct: item.ct,
          });
        }
        return sendJson(res, 200, {
          list: hist.list.map((x) => ({ ts: x.ts, v: x.v, manual: !!x.manual, size: (x.ct || '').length })),
        });
      }

      if (method === 'PUT') {
        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          if (e && e.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: 'too large' });
          return sendJson(res, 400, { error: 'bad body' });
        }
        let obj;
        try {
          obj = JSON.parse(body.toString('utf8') || '{}');
        } catch {
          return sendJson(res, 400, { error: 'bad json' });
        }
        // 🔴 必填校验按**自描述 envelope** 的实际需要列，不按老项目的 {ct, iv} 两项：
        //   少 kdf 就解不开（且报错长得像"数据坏了"），少 alg/v 同理。
        if (
          !obj ||
          typeof obj.ct !== 'string' || !obj.ct ||
          typeof obj.iv !== 'string' || !obj.iv ||
          !obj.kdf || typeof obj.kdf.name !== 'string' || !obj.kdf.name ||
          typeof obj.kdf.salt !== 'string' || !obj.kdf.salt ||
          !Number.isInteger(obj.kdf.iter)
        ) {
          return sendJson(res, 400, { error: 'missing fields' });
        }
        // 历史环追加快照同样是写入，必须过同一道凭据闸（正门锁了侧门不锁等于白装，
        // 老项目 server.js:524-526 同一注释）。
        const wkLockH = guards.wkLimited(clientIp(req), id);
        if (wkLockH) return sendJson(res, 429, { error: 'locked', retryAfter: wkLockH });
        const wkcH = guards.wkCheckNote(req, clientIp(req), id, await readNoteParsed(id), obj, noteExists);
        if (!wkcH.ok) return sendJson(res, wkcH.code, wkcH.mode ? { error: wkcH.error, mode: wkcH.mode } : { error: wkcH.error });
        const hist = await readHist(id);
        let ts = Date.now();
        // 同毫秒去重：否则两次快照 ts 相同，GET /:ts 永远只命中第一条
        while (hist.list.some((x) => x.ts === ts)) ts++;
        const item = {
          ts,
          v: Number.isInteger(obj.v) ? obj.v : 1,
          alg: typeof obj.alg === 'string' ? obj.alg : 'AES-256-GCM',
          kdf: { name: obj.kdf.name, iter: obj.kdf.iter, salt: obj.kdf.salt },
          iv: obj.iv,
          ct: obj.ct,
          manual: !!obj.manual,
        };
        const last = hist.list[hist.list.length - 1];
        // 相同密文不重复入栈（否则连点两次「新增历史版本」会得到两条一模一样的）
        if (!last || last.ct !== item.ct || last.iv !== item.iv) {
          hist.list.push(item);
          while (hist.list.length > HISTORY_MAX) {
            // 手动打点优先保留：先挤自动的，全是手动才挤最早那条
            let idx = hist.list.findIndex((x) => !x.manual);
            if (idx === -1) idx = 0;
            hist.list.splice(idx, 1);
          }
          try {
            await writeHist(id, hist);
          } catch (e) {
            return sendJson(res, 500, { error: 'write failed', detail: String(e && e.message) });
          }
          failmap.recordOk(key);
          // 🔴 写后广播与 POST 笔记同款，让另一台设备的快照环也跟着更新。
          //   last-write-wins：服务端不合并、不比版本号，后写覆盖先写。
          sseBroadcast(id, { t: 'hist', id, v: Date.now() });
        }
        return sendJson(res, 200, { ok: true, ts: item.ts, count: hist.list.length });
      }

      return sendJson(res, 405, { error: 'method not allowed' });
    }
  }

  /* ---------- 笔记读 ---------- */
  if (method === 'GET' && p.startsWith('/api/note/')) {
    const id = p.slice('/api/note/'.length);
    if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
    const ip = clientIp(req);
    const key = `${ip}:${id}`;
    const st = failmap.checkLimit(key);
    if (st.locked) {
      return sendJson(res, 429, { error: 'locked' }, { 'Retry-After': String(st.retryAfter) });
    }
    // 扫描守卫（老项目 server.js:556-559 同款）：响应形状一字不改
    // （旧客户端靠 200+空体判新建），只在旁路记 miss。
    const scan = guards.scanCheck(ip);
    if (scan.blocked) {
      return sendJson(res, 429, { error: 'locked', retryAfter: scan.retryAfter });
    }
    try {
      const txt = await fsp.readFile(notePath(id), 'utf8');
      // 凭据哈希不出门：「是否已认领」本身就是探测者想要的信号（老项目 server.js:560-563）。
      // JSON.parse 每次产出新对象，delete 即安全剥除，其余键与序逐字不变。
      const obj = JSON.parse(txt);
      if (obj && typeof obj === 'object' && 'wkHash' in obj) {
        delete obj.wkHash;
        return send(res, 200, JSON.stringify(obj));
      }
      return send(res, 200, txt);
    } catch {
      // 解密失败/没有这篇也要给 200 + 空体：客户端据此判定"此处无笔记"，
      // 给 4xx 会让它当成网络错误重试（老项目这个坑踩过）
      guards.scanRecordMiss(ip);
      return send(res, 200, '');
    }
  }

  /* ---------- 笔记写（POST 本项目客户端 / PUT 老客户端与 MCP 兼容别名） ---------- */
  if ((method === 'POST' || method === 'PUT') && p.startsWith('/api/note/')) {
    // 门牌保留名：新建（服务器无此档）时才挡，存量笔记仍可正常读写（老项目 server.js:569-573）。
    const id = p.slice('/api/note/'.length);
    if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
    if (guards.RESERVED_IDS.has(id) && !noteExists(id)) {
      return sendJson(res, 400, { error: 'reserved name' });
    }
    const ip = clientIp(req);
    const key = `${ip}:${id}`;
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
    // ===== 凭据闸（三态 off / new-only / full，判据见 guards.js，移植自老项目 v10.0.0）=====
    // 服务端只挑 wkHash 落库；wkOld（改口令自证用）验完即弃，绝不持久化。
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      obj = null;
    }
    const wkLock = guards.wkLimited(ip, id);
    if (wkLock) return sendJson(res, 429, { error: 'locked', retryAfter: wkLock });
    const cur = await readNoteParsed(id);
    const wkc = guards.wkCheckNote(req, ip, id, cur, obj, noteExists);
    if (!wkc.ok) return sendJson(res, wkc.code, wkc.mode ? { error: wkc.error, mode: wkc.mode } : { error: wkc.error });
    let toWrite = text;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      delete obj.wkOld;
      delete obj.wkHash;
      if (wkc.swap || wkc.claim) obj.wkHash = wkc.wk;
      else if (wkc.claimed && typeof cur.wkHash === 'string') obj.wkHash = cur.wkHash;
      toWrite = JSON.stringify(obj);
    }
    try {
      await writeAtomic(notePath(id), toWrite);
      failmap.recordOk(key);
      sseBroadcast(id, { t: 'note', id, v: Date.now() });
      return sendJson(res, 200, { ok: true, size: toWrite.length });
    } catch (e) {
      return sendJson(res, 500, { error: 'write failed', detail: String(e && e.message) });
    }
  }

  /* ---------- 删除（凭据闸同写入：能解密 ⇔ 能删） ---------- */
  if (method === 'DELETE' && p.startsWith('/api/note/')) {
    const id = p.slice('/api/note/'.length);
    if (!validId(id)) return sendJson(res, 400, { error: 'bad id' });
    const ip = clientIp(req);
    const wkLock = guards.wkLimited(ip, id);
    if (wkLock) return sendJson(res, 429, { error: 'locked', retryAfter: wkLock });
    const wkc = guards.wkCheckNote(req, ip, id, await readNoteParsed(id), null, noteExists);
    if (!wkc.ok) return sendJson(res, wkc.code, wkc.mode ? { error: wkc.error, mode: wkc.mode } : { error: wkc.error });
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
    if (!UPSIGN_SECRET || !UPSIGN_PRESET || !CLOUD_NAME || !UPSIGN_KEY) {
      return sendJson(res, 501, { error: 'upsign not configured' });
    }
    // 🔴🔴 强制 JSON content-type —— 这不是"多余的校验"。
    //   不要求的话这是 **simple 请求**，任意恶意网页都能跨域连发要签名；
    //   要求了就触发 CORS 预检，而本服务不回 ACAO 头，浏览器直接拦死。
    //   老项目 v5.52 的 /api/fail 用的是同一手法。
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      return sendJson(res, 400, { error: 'bad content-type' });
    }
    // 🔴 用通用 readBody（已有 MAX_BODY 上限），不自己再读一遍流。
    //   upsign 的 body 只是一小段 JSON（{note}），走通用上限足够；
    //   自己实现一个 4096 的读法等于多一条能漂移的路径。
    let raw;
    try {
      raw = (await readBody(req)).toString('utf8');
    } catch (e) {
      if (e && e.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: 'too large' });
      return sendJson(res, 400, { error: 'bad body' });
    }
    let o = {};
    try {
      o = JSON.parse(raw || '{}');
    } catch {
      // 半截坏 JSON 不该 500：按空对象处理，照样走配额与签发
      o = {};
    }
    const q = upsignQuota(clientIp(req));
    if (!q.ok) {
      return sendJson(res, 429, { error: 'too many', retryAfter: q.retryAfter });
    }
    const ts = Math.floor(Date.now() / 1000);
    const sig = upsignSign({
      secret: UPSIGN_SECRET,
      timestamp: ts,
      folder: UPSIGN_FOLDER,
      uploadPreset: UPSIGN_PRESET,
    });
    // 🔴 日志只记时间与归属笔记，**绝不记 secret / 签名**。
    const note = typeof o.note === 'string' && validId(o.note) ? o.note : '-';
    console.log(`[upsign] ts=${ts} note=${note}`);
    return sendJson(res, 200, {
      cloudName: CLOUD_NAME,
      apiKey: UPSIGN_KEY,
      timestamp: ts,
      signature: sig,
      uploadPreset: UPSIGN_PRESET,
      folder: UPSIGN_FOLDER,
    });
  }

  /* ---------- 小游戏记录（彩蛋层用） ----------
   * 🔴 v2.1.0 移植老项目街机档案语义（server.js:727-773 逐条比对）：
   *  - id 允许大写（老桌宠护照 ns1:id=39CLCAR9 是 8 位大写数字），id 取路径 [4] 段；
   *  - GET/PUT 必须带 x-arcade-key 且 sha256 命中 keyHash，钥匙错与不存在同形 404（防枚举）；
   *  - GET 回包剥掉 keyHash 与 id（连哈希都不出门）；
   *  - PUT 合并（counters 取最大、shelf 并集排序），绝不整篇覆盖——跨设备互抹即此根因；
   *  - POST 建档 {id,key}：服务端只留哈希；已存在回同形 {ok:true}（不泄露"该 id 已被占"）。
   *  兼容：小写 id（本项目早期形状）继续走无鉴权存取；老护照迁移建档走大写 id 有鉴权。
   */
  if (p.startsWith('/api/arcade')) {
    const aid = (p === '/api/arcade' ? url.searchParams.get('id') || '' : p.slice('/api/arcade/'.length));
    const ARC_ID_RE = /^[A-Z0-9]{4,16}$/;
    // 🔴🔴 只认**字面大写**的 id 走老版鉴权路（老护照 `ns1:id=39CLCAR9` 是 8 位大写）。
    //   绝不能先 `toUpperCase` 再判 —— 那样 `arc1` 这类**本项目早期的小写形状**会被
    //   误判成大写档案 ⇒ 无钥匙一律 404，旧数据凭空消失（判据见 test/server.test.mjs
    //   「arcade 记录可读写（彩蛋层用）」，A3(终) 曾把这条打成红）。
    const isUpperArc = typeof aid === 'string' && ARC_ID_RE.test(aid);
    const arcadePath = path.join(ARCADE_DIR, `${aid}.json`);

    // 建档（老版 POST /api/arcade {id,key}）：id 在**体**里，**不看路径段** ——
    //   客户端认领老护照正是 POST 到无 id 段的 `/api/arcade`（egg/pet.ts adoptNs1Code）。
    //   体里没有合法的 id+key ⇒ 落到下面「早期形状」的裸写入（裸 body、小写 id）。
    if (method === 'POST') {
      let raw;
      try {
        raw = await readBody(req);
      } catch {
        return sendJson(res, 413, { error: 'too large' });
      }
      let inc0 = null;
      try {
        inc0 = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        inc0 = null;
      }
      const kid0 = String((inc0 && inc0.id) || '').toUpperCase();
      const kk0 = String((inc0 && inc0.key) || '');
      if (inc0 && typeof inc0 === 'object' && ARC_ID_RE.test(kid0) && kk0.length >= 8 && kk0.length <= 64) {
        const createPath = path.join(ARCADE_DIR, `${kid0}.json`);
        if (fs.existsSync(createPath)) return sendJson(res, 200, { ok: true });
        const rec0 = { id: kid0, keyHash: guards.wkHash(kk0), counters: {}, shelf: [], updatedAt: Number(inc0.updatedAt) || Date.now(), born: Date.now() };
        try {
          await writeAtomic(createPath, JSON.stringify(rec0));
          return sendJson(res, 200, { ok: true });
        } catch {
          return sendJson(res, 500, { error: 'write failed' });
        }
      }
      if (!validId(aid)) return sendJson(res, 400, { error: 'bad id' });
      try {
        await writeAtomic(arcadePath, raw.toString('utf8'));
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 500, { error: 'write failed' });
      }
    }

    if (isUpperArc && (method === 'GET' || method === 'PUT')) {
      // 老版语义：凭据必带、哈希必中、同形 404
      const k = req.headers['x-arcade-key'];
      const kh = typeof k === 'string' && k.length >= 8 && k.length <= 64 ? guards.wkHash(k) : null;
      let rec = null;
      try {
        rec = JSON.parse(await fsp.readFile(arcadePath, 'utf8'));
      } catch {
        rec = null;
      }
      if (!kh || !rec || rec.keyHash !== kh) return sendJson(res, 404, { error: 'not found' });
      if (method === 'GET') {
        const pub = { ...rec };
        delete pub.keyHash;
        delete pub.id;
        return send(res, 200, JSON.stringify(pub));
      }
      // PUT：合并回档（counters 逐键取最大、shelf 并集排序上限 512）
      let inc;
      try {
        inc = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
      if (!inc || typeof inc !== 'object') return sendJson(res, 400, { error: 'bad body' });
      const merged = { ...rec };
      merged.counters = merged.counters || {};
      const ic = inc.counters && typeof inc.counters === 'object' ? inc.counters : {};
      for (const kk of Object.keys(ic).slice(0, 40)) {
        const v = Number(ic[kk]);
        if (!Number.isFinite(v)) continue;
        const prev = Number(merged.counters[kk]);
        if (!Number.isFinite(prev) || v > prev) merged.counters[kk] = Math.min(v, 1e12);
      }
      const shelfSet = new Set(
        [...(merged.shelf || []), ...(inc.shelf || [])]
          .map(Number)
          .filter((n) => Number.isFinite(n) && n >= 0 && n < 512),
      );
      merged.shelf = [...shelfSet].sort((a, b) => a - b);
      merged.updatedAt = Number(inc.updatedAt) || Date.now();
      try {
        await writeAtomic(arcadePath, JSON.stringify(merged));
        return sendJson(res, 200, { ok: true, updatedAt: merged.updatedAt || 0 });
      } catch {
        return sendJson(res, 500, { error: 'write failed' });
      }
    }

    // bj 早期形状：小写 id、无鉴权裸读（旧数据必须还能读回来）。
    //   PUT 到小写 id 仍是 405 —— 老版对非档案 id 也只在 GET/POST 上有语义。
    if (!validId(aid)) return sendJson(res, 400, { error: 'bad id' });
    if (method === 'GET') {
      try {
        return send(res, 200, await fsp.readFile(arcadePath, 'utf8'));
      } catch {
        return send(res, 200, '');
      }
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  /* ---------- APK 直下（v9.3.2 同款，逻辑照搬老项目 server.js:685-728） ----------
   *
   * 🔴 为什么必须有本路由：bj 的 App 是 Capacitor 壳，`capacitor.config.json` 的
   *   `server.url` 指向 https://bj.xuyinji.com.cn —— 壳加载**线上站**，网页体验随
   *   www/ 部署即时生效（这正是"体验素材与老版本一致"的前提）。但壳自身的
   *   在线升级（OTA）要去哪儿下 APK？原生 downloadApk 只校验 https 不锁域名，
   *   所以由本路由直出 /dl/*.apk，无需改 Caddy、无需重编壳。
   *
   * 🔴🔴 Range 断点续传是**必备**不是加分项：安卓 DownloadManager 在低带宽
   *   （实测 3Mbps）下靠 Range 分段续传，老项目踩过"续传跨发版读到新旧混装字节"
   *   导致 packageInfo is null 的死循环。故新版本走**固定名 /dl/vX.Y.Z.apk
   *   （发版上传、永不覆盖）**，latest_app.json 的下载 URL 指向它，URL 内容不可变。
   *   同时保留 /dl/latest.apk（覆盖式）兼容旧壳与手输链接。
   *
   * 🔴 文件名走严格白名单正则，无路径穿越面（照搬老项目，不自己"优化"）。
   */
  const dlMatch = /^\/dl\/(latest|v\d+(?:\.\d+)*)\.apk$/.exec(p);
  if (dlMatch && (method === 'GET' || method === 'HEAD')) {
    const fname = dlMatch[1] + '.apk';
    const f = path.join(DEPLOY_DIR, 'apk', fname);
    let st;
    try { st = await fsp.stat(f); } catch { return sendJson(res, 404, { error: 'no apk' }); }
    const total = st.size;
    const baseHdr = {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="NoteSync-' + fname + '"',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Last-Modified': st.mtime.toUTCString(),
    };
    const rm = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (rm) {
      let start = rm[1] === '' ? null : parseInt(rm[1], 10);
      let end = rm[2] === '' ? null : parseInt(rm[2], 10);
      // bytes=-N  = 末尾 N 字节（后缀区间）
      if (start === null && end !== null) { start = Math.max(0, total - end); end = total - 1; }
      if (start === null) start = 0;
      if (end === null || end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, Object.assign({ 'Content-Range': 'bytes */' + total }, baseHdr));
        return res.end();
      }
      res.writeHead(206, Object.assign({
        'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
        'Content-Length': String(end - start + 1),
      }, baseHdr));
      if (method === 'HEAD') return res.end();
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, Object.assign({ 'Content-Length': String(total) }, baseHdr));
    if (method === 'HEAD') return res.end();
    return fs.createReadStream(f).pipe(res);
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

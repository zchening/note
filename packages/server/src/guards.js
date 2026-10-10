/**
 * 写入凭据闸（writeKey）+ 笔记名扫描守卫 + 门牌保留名
 *
 * 🔴 移植依据：老项目 server.js v10.0.0（:85-176 wk 闸、:178-202 扫描守卫、
 *   :248 保留名、:430-456 claim 端点、:567-624 写入路径）逐条比对，**不靠推理定案**。
 *   语义一句话：「能解密 ⇔ 能写入」——不知道口令的人派生不出凭据，
 *   服务端只存 sha256(writeKey)，零知识不变。
 *
 * 与老项目的两处**适配性差异**（语义不变，形态适配本项目）：
 *  1. 客户端凭据来源不同：老项目从可导出 raw key 做 HMAC-SHA256；
 *     本项目密钥 extractable:false（红线 #4），客户端改用口令做域分离 PBKDF2
 *     （见 packages/client/src/sync/write-key.ts）。服务端只认 sha256(凭据)，
 *     两种派生法对它完全同形——本文件不关心凭据怎么来。
 *  2. env 名走本项目口径 `NS_BJ_WK_MODE`（老项目是 NOTESYNC_WK_MODE）；
 *     档位文件同样是 DATA_DIR/wk-mode.txt、文件优先、5s 缓存热切。
 *
 * 三态（与老项目逐字一致）：
 *  - off：全部放行（行为与无闸逐字相同，灰度起步档）
 *  - new-only：只挡「真新建且无凭据」与「已认领且无凭据的宽限期内的不匹配」
 *  - full：已认领的笔记无凭据一律 403
 */

// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const WK_HEADER = 'x-note-key';
const WK_MIN = 16;
const WK_MAX = 128; // 32 字节 base64url=43 字符，留双侧余量（老项目同值）

/** 门牌保留名：新建（服务器无此档）时才挡，存量笔记仍可正常读写，不毁用户数据。
 *  与老项目 server.js:248 同清单。 */
export const RESERVED_IDS = new Set(['mirror', 'snake', 'dragon', 'brick', 'satoshi', 'bitcoin', 'tank', 'spacex', 'tesla', 'pet']);

/* ------------------------------------------------------------------ *
 * 档位
 * ------------------------------------------------------------------ */

let _wkMode = { v: '', at: 0 };
let _wkModeFile = '';

/** 注入 DATA_DIR（server.js 启动时调用一次） */
export function init(dataDir) {
  _wkModeFile = path.join(dataDir, 'wk-mode.txt');
}

export function wkMode() {
  const now = Date.now();
  if (now - _wkMode.at < 5000) return _wkMode.v;
  let m = String(process.env.NS_BJ_WK_MODE || 'off').trim();
  try {
    const f = fs.readFileSync(_wkModeFile, 'utf8').trim();
    if (f) m = f; // 文件优先：写一个字节即热切，不必重启服务（老项目同款）
  } catch { /* 文件不存在就用 env/默认 */ }
  if (m !== 'off' && m !== 'new-only' && m !== 'full') m = 'off';
  _wkMode = { v: m, at: now };
  return m;
}

/**
 * 🔴🔴 P1-2（选 A：fail-closed）启动期凭据闸配置校验。
 *
 * 语义：
 *  - **完全未配置**（env 未设且文件不存在）→ 允许，默认 `off`，但返回 `warned:true`
 *    让启动打一行醒目告警（灰度起步档，本就承诺无锁）。
 *  - **显式给出非法值**（env 设了非空非法的，或 wk-mode.txt 写了非空非法的）→
 *    **抛错**。服务据此在启动期 fatal 退出，绝不"静默退化成 off 让写闸失效"带病运行。
 *   这是 P1-2 的核心：配置 typo 过去会悄悄关掉写闸，等于线上零保护而不自知。
 *
 * 注意：**仅启动期校验**。运行期 5s 热切仍是原 `wkMode()`（非法值退 off）——
 * 因为热切写错一个字节不该把正在跑的服务直接崩掉（那比短暂无保护更糟）。
 * 真正的保护由"启动期已 exit"保证：非法配置根本起不来。
 *
 * 调用方必须在 `init(DATA_DIR)` 之后、监听端口之前调用本函数。
 */
const WK_VALID = new Set(['off', 'new-only', 'full']);

export function checkWkModeConfig() {
  let raw = null;
  let source = 'default';
  try {
    const f = fs.readFileSync(_wkModeFile, 'utf8').trim();
    if (f) { raw = f; source = 'wk-mode.txt'; }
  } catch { /* 文件不存在 = 未配置 */ }
  if (raw === null) {
    const e = process.env.NS_BJ_WK_MODE;
    if (e !== undefined && e.trim() !== '') { raw = e.trim(); source = 'NS_BJ_WK_MODE'; }
  }
  if (raw === null) {
    return { mode: 'off', warned: true, source: 'default' };
  }
  if (!WK_VALID.has(raw)) {
    throw new Error(
      `[guards] 致命：wk-mode 配置值 "${raw}"（来源 ${source}）非法。` +
      `合法值为 off / new-only / full。拒绝以无保护状态启动（P1-2 fail-closed）。`,
    );
  }
  return { mode: raw, warned: false, source };
}

/* ------------------------------------------------------------------ *
 * 凭据哈希
 * ------------------------------------------------------------------ */

export function wkHash(k) {
  return crypto.createHash('sha256').update(String(k)).digest('hex');
}

/** @param {import('node:http').IncomingMessage} req */
export function wkHashFromReq(req) {
  const k = req.headers[WK_HEADER];
  if (typeof k !== 'string' || k.length < WK_MIN || k.length > WK_MAX) return null;
  return wkHash(k);
}

/* ------------------------------------------------------------------ *
 * 凭据失败独立桶（只挡写入，绝不牵连 GET）
 *
 * 若与口令爆破共用 failMap，不升级的旧客户端每次自动保存都记一次失败，
 * 攒够就把「老版本不能写」升级成「老版本连自己的笔记都看不到」（老项目闸 R2-B，
 * 不可接受的误伤）。阈值 60 与老项目同值：真持有者永远撞不到，只有脚本化抢注才会被限。
 * ------------------------------------------------------------------ */

const WK_FAIL_LIMIT = 60;
const WK_FAIL_WINDOW = 10 * 60 * 1000;
const WK_LOCK = 10 * 60 * 1000;
/** @type {Map<string, { n: number, first: number, lockedAt: number }>} */
const wkFailMap = new Map(); // 'ip:id' -> rec

export function wkRecordFail(ip, id) {
  const key = ip + ':' + id;
  const now = Date.now();
  let r = wkFailMap.get(key);
  // 窗口滚动只重置计数，绝不清 lockedAt——否则锁到点自动解，等于没锁（老项目复核意见）
  if (!r || now - r.first > WK_FAIL_WINDOW) {
    r = { n: 0, first: now, lockedAt: (r && r.lockedAt) || 0 };
    wkFailMap.set(key, r);
  }
  r.n++;
  if (r.n >= WK_FAIL_LIMIT) r.lockedAt = now;
  if (wkFailMap.size > 5000) {
    for (const [k, v] of wkFailMap) {
      if (now - v.first > WK_FAIL_WINDOW && !v.lockedAt) wkFailMap.delete(k);
    }
  }
}

/** @returns {number} 剩余锁定秒数，0 = 未锁 */
export function wkLimited(ip, id) {
  const r = wkFailMap.get(ip + ':' + id);
  if (!r || !r.lockedAt) return 0;
  const left = WK_LOCK - (Date.now() - r.lockedAt);
  if (left <= 0) {
    wkFailMap.delete(ip + ':' + id);
    return 0;
  }
  return Math.ceil(left / 1000);
}

/* ------------------------------------------------------------------ *
 * 主判据（写入/历史快照写入/删除/claim 共用，抄三处=改一处忘两处）
 *
 * 【B1 语义】未认领的笔记接受第一次凭据登记（=认领）；一旦认领，凭据不符一律硬 403，
 * 绝不自动降级（自动降级 = 攻击者先用错凭据撞一下就能卸掉防护再覆盖）。
 * 代价：真主认领前，知道笔记名的人可抢先登记「冻结写入」——但他本来就能直接覆盖
 * （off/new-only 下无凭据写入仍放行），抢注未给他新的破坏力；恢复通道只有一步：
 * 删掉该档的 wkHash 字段。真主认领完成后窗口永久关闭。
 * ------------------------------------------------------------------ */

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} ip
 * @param {string} id
 * @param {Record<string, any>} cur 当前笔记档（不存在时传 {}）
 * @param {Record<string, any> | null} [obj] 请求体（删除等无体场景不传）
 * @param {(id: string) => boolean} noteExists
 */
export function wkCheckNote(req, ip, id, cur, obj, noteExists) {
  const wk = wkHashFromReq(req);
  const claimed = typeof cur.wkHash === 'string' && cur.wkHash.length === 64;
  if (wk) {
    if (claimed && cur.wkHash !== wk) {
      const old = obj && typeof obj.wkOld === 'string' ? obj.wkOld : '';
      if (old.length >= WK_MIN && old.length <= WK_MAX && wkHash(old) === cur.wkHash) {
        return { ok: true, wk, claimed: true, swap: true }; // 旧凭据自证 → 原子换绑（改口令路径）
      }
      // off 档一律不拒——off 的全部承诺就是「行为与今天逐字相同、不发任何锁」，
      // 把 mismatch 检查放在 mode 之前等于让 off 档也能把人锁死，自相矛盾（老项目复核②）
      if (wkMode() === 'off') return { ok: true, wk, claimed: true };
      wkRecordFail(ip, id);
      return { ok: false, code: 403, error: 'forbidden' };
    }
    if (claimed) return { ok: true, wk, claimed: true };
    // B1：未认领的档一律接受第一次凭据登记（=认领），存量笔记因此才能进保护圈
    return { ok: true, wk, claimed: false, claim: true };
  }
  const mode = wkMode();
  if (claimed) {
    if (mode === 'full') {
      wkRecordFail(ip, id);
      return { ok: false, code: 403, error: 'credential required', mode };
    }
    return { ok: true, wk: null, claimed: true }; // off / new-only：已认领笔记的宽限期
  }
  if (mode !== 'off' && !noteExists(id)) {
    // 只挡「真新建且无凭据」，存量永不因此被拒
    wkRecordFail(ip, id);
    return { ok: false, code: 403, error: 'credential required', mode };
  }
  return { ok: true, wk: null, claimed: false };
}

/* ------------------------------------------------------------------ *
 * 笔记名扫描守卫
 *
 * GET 一个不存在的名字会拿到 200+空体（形状不可改，客户端靠它判新建），
 * 于是名字存在性可被枚举。凭据上线后枚举收益降到「知道某人有叫 work 的笔记」，
 * 这里再补一道按 IP 的 misses 计数收紧。阈值 80/10 分钟与老项目闸 R2-D 同值：
 * 共享出口（CGNAT/校园网）下攻击者用自己那份流量就能把同段邻居一起挡在读取外，
 * 误伤代价大于收益；它防的只是低价值的存在性探测。
 * ------------------------------------------------------------------ */

const SCAN_WINDOW = 10 * 60 * 1000;
const SCAN_LIMIT = 80;
/** @type {Map<string, { n: number, first: number }>} */
const scanMap = new Map(); // ip -> rec

export function scanCheck(ip) {
  const now = Date.now();
  const rec = scanMap.get(ip);
  if (!rec || now - rec.first > SCAN_WINDOW) return { blocked: false, retryAfter: 0 };
  return rec.n >= SCAN_LIMIT
    ? { blocked: true, retryAfter: Math.ceil((SCAN_WINDOW - (now - rec.first)) / 1000) }
    : { blocked: false, retryAfter: 0 };
}

export function scanRecordMiss(ip) {
  const now = Date.now();
  const rec = scanMap.get(ip);
  if (!rec || now - rec.first > SCAN_WINDOW) {
    scanMap.set(ip, { n: 1, first: now });
    return;
  }
  rec.n++;
  if (scanMap.size > 5000) {
    for (const [k, v] of scanMap) {
      if (now - v.first > SCAN_WINDOW) scanMap.delete(k);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of scanMap) {
    if (now - v.first > SCAN_WINDOW) scanMap.delete(k);
  }
}, 5 * 60 * 1000).unref();

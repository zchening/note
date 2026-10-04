/**
 * 失败计数与锁 —— 落盘版（修老项目"重启即清空"的薄弱点）
 *
 * 老项目的 failMap 是纯内存 Map，进程一重启（发版、崩溃、机器重启）全部清零，
 * 攻击者只要等一次重启就又能重新开始爆破。这是"看起来有防护其实没有"的典型。
 *
 * 本模块把它变成：
 *  - 5 分钟落一次 JSON 快照到 DATA_DIR/failmap.json（原子写：先写 .tmp 再 rename）
 *  - 启动时读回，把已落锁的记录恢复（未锁定的计数也恢复，保守取向）
 *  - 落盘失败只记日志不抛错 —— 限流是防护，不是业务主链路，不能因它把服务搞挂
 *
 * 参数沿用老项目（20 次 / 10 分钟窗口 / 锁 10 分钟），不擅自加严：
 * 真防爆破靠的是客户端 PBKDF2 600k 次，不是锁人；锁太狠会把连错几次口令的
 * 正常用户关在自己笔记外面（老项目注释里明确记了这个教训）。
 */

import fs from 'node:fs';
import path from 'node:path';

export const FAIL_LIMIT = 20;
export const FAIL_WINDOW = 10 * 60 * 1000;
export const LOCK_DURATION = 10 * 60 * 1000;
const SNAPSHOT_INTERVAL = 5 * 60 * 1000;


/* key -> rec */
const failMap = new Map();
let snapshotPath = '';
let dirty = false;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 原子写：先写 .tmp 再 rename。Windows 上 rename 到已存在文件会失败，先删再改名 */
export function saveSnapshot() {
  if (!snapshotPath) return false;
  try {
    ensureDir(snapshotPath);
    const tmp = snapshotPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(failMap)), 'utf8');
    try {
      fs.renameSync(tmp, snapshotPath);
    } catch {
      fs.rmSync(snapshotPath, { force: true });
      fs.renameSync(tmp, snapshotPath);
    }
    dirty = false;
    return true;
  } catch (e) {
    // 落盘失败只记日志：限流是防护层，不该把主服务带崩
    console.error('[failmap] 快照写入失败：', e instanceof Error ? e.message : String(e));
    return false;
  }
}

export function loadSnapshot(file) {
  snapshotPath = file;
  try {
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    let n = 0;
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'object' || v === null) continue;
      const rec = v;
      if (typeof rec.count !== 'number' || typeof rec.firstFail !== 'number') continue;
      // 启动时顺手清掉已过期的，不让快照无限增长
      const expired =
        rec.lockedAt != null ? now - rec.lockedAt >= LOCK_DURATION : now - rec.firstFail >= FAIL_WINDOW;
      if (expired) continue;
      failMap.set(k, {
        count: rec.count,
        firstFail: rec.firstFail,
        lockedAt: typeof rec.lockedAt === 'number' ? rec.lockedAt : null,
      });
      n++;
    }
    return n;
  } catch (e) {
    console.error('[failmap] 快照读取失败（按空表继续）：', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

export function startSnapshotTimer() {
  const t = setInterval(() => {
    sweep();
    if (dirty) saveSnapshot();
  }, SNAPSHOT_INTERVAL);
  t.unref(); // 别因为这个定时器让进程活不下去
  if (typeof t.unref === 'function') t.unref();
}

/** 清掉过期记录（锁到期 / 窗口过期） */
export function sweep(now = Date.now()) {
  for (const [key, rec] of failMap) {
    if (rec.lockedAt !== null) {
      if (now - rec.lockedAt >= LOCK_DURATION) failMap.delete(key);
    } else if (now - rec.firstFail >= FAIL_WINDOW) {
      failMap.delete(key);
    }
  }
}


export function checkLimit(key, now = Date.now()) {
  const rec = failMap.get(key);
  if (rec && rec.lockedAt !== null) {
    if (now - rec.lockedAt < LOCK_DURATION) {
      return { locked: true, retryAfter: Math.ceil((LOCK_DURATION - (now - rec.lockedAt)) / 1000) };
    }
    failMap.delete(key); // 锁定过期
  }
  return { locked: false, retryAfter: 0 };
}

export function recordFail(key, now = Date.now()) {
  const existing = failMap.get(key);
  if (existing && existing.lockedAt !== null) {
    return checkLimit(key, now); // 已锁定，不重复计数
  }
  let rec;
  if (!existing || now - existing.firstFail > FAIL_WINDOW) {
    rec = { count: 0, firstFail: now, lockedAt: null };
  } else {
    rec = existing;
  }
  rec.count++;
  if (rec.count >= FAIL_LIMIT) rec.lockedAt = now;
  failMap.set(key, rec);
  dirty = true;
  return checkLimit(key, now);
}

export function recordOk(key) {
  if (failMap.delete(key)) dirty = true;
}

export function size() {
  return failMap.size;
}

export function dumpAll() {
  return Object.fromEntries(failMap);
}

/** 进程退出前落一次盘（SIGINT/SIGTERM/beforeExit） */
export function installExitHook() {
  const save = () => {
    if (dirty) saveSnapshot();
  };
  process.on('exit', save);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      save();
      process.exit(0);
    });
  }
}

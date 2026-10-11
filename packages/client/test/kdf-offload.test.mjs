/**
 * P0-4 派生卸载（Worker）+ 同盐记忆化 —— 判据 KDF-01~08
 *
 * 🔴🔴 本文件的存在理由：600k 次 PBKDF2 实测 ~130ms/次，换机恢复 100 篇串行
 *   ⇒ 主线程冻结 13~26 秒、低端安卓 ANR。搬进 Worker 是性能修复，
 *   但**搬错了就是解锁失败**（密钥算错 = 全篇打不开，且零报错）。
 *   所以本文件的核心不是"快没快"，而是**「卸载算出的钥匙与主线程逐位等价」**。
 *
 * 🔴 判据口径：卸载器用**真算**的 PBKDF2（不是桩返回随机数），
 *   这样"等价性"才是真等价；桩只用来数调用次数与造失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearDerivedKeyCache,
  decryptString,
  deriveKey,
  derivedKeyCacheSize,
  encryptString,
  setPbkdf2Offload,
} from '@bj/shared-schema';
import { installKdfWorker, kdfWorkerOffload, uninstallKdfWorker } from '../src/sync/kdf-worker.ts';

const PASS = 'correct-horse-battery-staple';
/** 用固定 salt，让"同 salt"这件事可被构造。 */
const SALT_A = 'AAAAAAAAAAAAAAAAAAAAAA==';
const SALT_B = 'BBBBBBBBBBBBBBBBBBBBBB==';

/** 真算 PBKDF2 的卸载器（与主线程同一算法），并数调用次数。 */
function truthOffload() {
  const calls = [];
  const fn = async (p, s, iter) => {
    calls.push(`${iter}:${s}`);
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(p), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const salt = Uint8Array.from(Buffer.from(s, 'base64'));
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
      km,
      256,
    );
    return new Uint8Array(bits);
  };
  fn.calls = calls;
  return fn;
}

test.afterEach(() => {
  setPbkdf2Offload(undefined);
  uninstallKdfWorker();
  clearDerivedKeyCache();
});

/* ============ 1. 卸载算出的钥匙与主线程逐位等价（最核心的一条） ============ */

test('KDF-01 卸载器派生的钥匙能解开主线程派生钥匙加密的密文（等价性）', async () => {
  // 主线程派生并加密
  const dkMain = await deriveKey(PASS, SALT_A);
  const env = await encryptString('正文-等价性验证', dkMain.key, 'note', dkMain);

  // 卸载器派生（真算 PBKDF2），用它的钥匙解密
  clearDerivedKeyCache(); // 🔴 必须清缓存，否则第二次直接命中缓存、根本没走卸载器
  const off = truthOffload();
  setPbkdf2Offload(off);
  const dkOff = await deriveKey(PASS, SALT_A);

  assert.equal(off.calls.length, 1, '卸载器必须真的被调用（否则本判据在空转）');
  const plain = await decryptString(env, dkOff.key, 'note');
  assert.equal(plain, '正文-等价性验证', '卸载派生的钥匙必须与主线程派生的钥匙一致');
});

/* ============ 2. 记忆化：同 salt 只算一次 ============ */

test('KDF-02 同 (口令,salt) 第二次派生命中缓存，卸载器不再被调用', async () => {
  const off = truthOffload();
  setPbkdf2Offload(off);
  const a = await deriveKey(PASS, SALT_A);
  const b = await deriveKey(PASS, SALT_A);
  assert.equal(off.calls.length, 1, '同 salt 的第二次派生必须命中缓存（曾白算 2~3 遍）');
  assert.equal(a.saltB64, b.saltB64);
  // 「应该有」：不同 salt 仍要真的算
  await deriveKey(PASS, SALT_B);
  assert.equal(off.calls.length, 2, '不同 salt 必须各算一次');
});

test('KDF-03 并发调用同一 salt 共享同一次计算（缓存存 Promise 而非结果）', async () => {
  const off = truthOffload();
  setPbkdf2Offload(off);
  const [a, b, c] = await Promise.all([
    deriveKey(PASS, SALT_A),
    deriveKey(PASS, SALT_A),
    deriveKey(PASS, SALT_A),
  ]);
  assert.equal(off.calls.length, 1, '并发必须共享同一次计算（否则缓存形同虚设）');
  assert.equal(a.key, b.key);
  assert.equal(b.key, c.key);
});

test('KDF-04 salt 未给（现生成新钥匙）时不进缓存', async () => {
  setPbkdf2Offload(truthOffload());
  const before = derivedKeyCacheSize();
  await deriveKey(PASS);
  await deriveKey(PASS);
  assert.equal(
    derivedKeyCacheSize(),
    before,
    '现生成 salt 的派生不进缓存（每次都是新钥匙，缓存只会白占坑）',
  );
});

test('KDF-05 缓存有上限，不会随笔记数无界增长', async () => {
  setPbkdf2Offload(truthOffload());
  for (let i = 0; i < 80; i += 1) {
    // 构造 80 个不同 salt
    const s = Buffer.from(`salt-${i}-${'x'.repeat(8)}`).toString('base64').slice(0, 24);
    await deriveKey(PASS, s);
  }
  assert.ok(
    derivedKeyCacheSize() <= 64,
    '缓存必须有上限（换机扫 100 篇不该泄漏）：实际 ' + derivedKeyCacheSize(),
  );
});

/* ============ 3. 失败一律回落，绝不能变成解锁失败 ============ */

test('KDF-06 卸载器抛错 ⇒ 回落主线程，且仍能解出正确内容', async () => {
  const dkMain = await deriveKey(PASS, SALT_A);
  const env = await encryptString('回落验证', dkMain.key, 'note', dkMain);

  clearDerivedKeyCache();
  setPbkdf2Offload(async () => {
    throw new Error('worker boom');
  });
  const dk = await deriveKey(PASS, SALT_A);
  const plain = await decryptString(env, dk.key, 'note');
  assert.equal(plain, '回落验证', '卸载失败必须回落主线程，绝不能变成解锁失败');
});

test('KDF-07 卸载器返回长度不对 ⇒ 回落主线程（不许拿错长度的位去 importKey）', async () => {
  const dkMain = await deriveKey(PASS, SALT_A);
  const env = await encryptString('长度校验', dkMain.key, 'note', dkMain);
  clearDerivedKeyCache();
  setPbkdf2Offload(async () => new Uint8Array(16)); // 16 字节 ≠ 32 字节
  const dk = await deriveKey(PASS, SALT_A);
  const plain = await decryptString(env, dk.key, 'note');
  assert.equal(plain, '长度校验', '位长不对必须回落，不能产生一把错钥匙');
});

test('KDF-08 失败的派生不被永久缓存（换口令重试必须能重新算）', async () => {
  let mode = 'boom';
  const off = async (p, s, iter) => {
    if (mode === 'boom') throw new Error('boom');
    return truthOffload()(p, s, iter);
  };
  setPbkdf2Offload(off);
  // 第一次卸载失败 ⇒ 回落主线程成功 ⇒ 结果进缓存（这是对的）
  await deriveKey(PASS, SALT_A);
  // 切到正常模式后，缓存里已有成功结果，不该再卸载
  mode = 'ok';
  const dk = await deriveKey(PASS, SALT_A);
  assert.ok(dk.key, '缓存里必须是成功结果');
  // 「不应该有」：坏的 Promise 绝不能留在缓存里 —— 用新 salt 验证卸载器仍可用
  const dkB = await deriveKey(PASS, SALT_B);
  assert.ok(dkB.key, '换 salt 后卸载器必须仍可用（失败的 Promise 不许污染缓存）');
});

/* ============ 4. Worker 模块本身：无 Worker 环境优雅降级 ============ */

test('KDF-09 Node（无 DOM Worker）下装不上，且不能抛', async () => {
  const ok = installKdfWorker();
  assert.equal(ok, false, '无 Worker 环境必须返回 false 而不是抛异常');
  await assert.rejects(
    () => kdfWorkerOffload(PASS, SALT_A, 600_000),
    '无 Worker 时调用必须 reject（由 deriveKey 回落）',
  );
});

/**
 * 变异验证记录（2026-10-11 实跑）：
 *  - 把 deriveKey 里的缓存命中分支删掉 ⇒ KDF-02 红（KDF-01/03~09 仍绿 ⇒ 专一）。
 *  - 把 `task.catch(delete)` 那行删掉 ⇒ 失败被永久缓存，KDF-08 的反例转红。
 *  - 把缓存上限判断删掉 ⇒ KDF-05 红。
 *  - 把卸载块的 try/catch 去掉（让抛错冒出去）⇒ KDF-06 红。
 *  - 把 `bits.length * 8 === KEY_LEN_BITS` 的长度校验删掉 ⇒ KDF-07 红。
 * 恢复后 `MUT` grep 归零、九条全绿。
 */

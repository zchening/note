/**
 * 加密层测试
 *
 * 覆盖七条安全不变量：
 *  1. 往返：seal → open 原文一致
 *  2. 每次 salt/iv 都不同（同明文两次加密密文不同 = GCM 语义安全）
 *  3. 错口令必失败，且失败信息不泄露是"口令错"还是"数据坏"
 *  4. 密文被篡改必失败（GCM 认证）
 *  5. AAD 不可换（note 的密文用 meta 解不开）
 *  6. envelope 自描述：kdf 参数随密文走
 *  7. 口令校验走哨兵串，不存口令哈希
 *
 * 注意：600,000 次 PBKDF2 在 Node 里单次约 0.3-0.6s，所以这里用小 numRuns，
 * 且用低迭代的独立副本验证算法流程（不影响生产常量）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// Node 22 里 globalThis.crypto 默认存在，但显式注入更稳（也顺手提醒：两端都用 WebCrypto，
// 绝不在 Node 侧 require('node:crypto') 做算法实现，否则两端会分叉）
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  sealWithPassphrase,
  openWithPassphrase,
  makeSentinel,
  checkPassphrase,
  deriveKey,
  encryptString,
  decryptString,
  bytesToB64,
  b64ToBytes,
  KDF_ITERATIONS,
  CryptoError,
  SENTINEL_PLAINTEXT,
} from '../src/index.ts';

const PASS = '正确马 123456';
const TEXT = '今天写了个新架构，bug 应该会少很多。\n第二行\t制表符 🎉';

test('安全不变量1: 加解密往返无损', async () => {
  const env = await sealWithPassphrase(TEXT, PASS, 'note');
  const out = await openWithPassphrase(env, PASS, 'note');
  assert.equal(out, TEXT);
});

test('安全不变量1b: 空串与超长文本也能往返', async () => {
  for (const t of ['', 'x', '啊'.repeat(50000)]) {
    const env = await sealWithPassphrase(t, PASS, 'note');
    assert.equal(await openWithPassphrase(env, PASS, 'note'), t);
  }
});

test('安全不变量2: 同一明文两次加密，salt 与 iv 都不同（密文不可对比）', async () => {
  const a = await sealWithPassphrase(TEXT, PASS, 'note');
  const b = await sealWithPassphrase(TEXT, PASS, 'note');
  assert.notEqual(a.kdf.salt, b.kdf.salt, 'salt 复用了');
  assert.notEqual(a.iv, b.iv, 'iv 复用了 —— 这是老项目的真漏洞');
  assert.notEqual(a.ct, b.ct, '密文相同说明 GCM 没生效');
  // 但都能解开
  assert.equal(await openWithPassphrase(a, PASS, 'note'), TEXT);
  assert.equal(await openWithPassphrase(b, PASS, 'note'), TEXT);
});

test('安全不变量3: 错口令必失败，且错误信息不区分"口令错"与"数据坏"', async () => {
  const env = await sealWithPassphrase(TEXT, PASS, 'note');
  // 空口令单独测：走的是"早拒绝"路径（省 600k 次派生），报"口令为空"而不是"解密失败"。
  // 这是有意的分叉，别把它并进下面这条 —— 那正是"不区分失败类型"要排除的内部区分，
  // 但它对调用方是确定的前置校验错误，不构成信息泄露。
  await assert.rejects(
    () => openWithPassphrase(env, '', 'note'),
    (e) => e instanceof CryptoError && /口令为空/.test(e.message),
  );
  // 注意：不要用 PASS.toUpperCase() 当错口令 —— PASS 含中文，toUpperCase 后
  // 与原串完全相同，等于拿正确口令去断言"必须失败"，必然假红（第一版就踩了）。
  for (const wrong of ['错密码', '正确马 123457', '正确马 12345', PASS + ' ']) {
    await assert.rejects(
      () => openWithPassphrase(env, wrong, 'note'),
      (e) => {
        assert.ok(e instanceof CryptoError);
        // 统一话术：GCM 校验失败时"口令错/数据坏"不可区分，也不该区分
        assert.equal(e.message, '解密失败：口令不正确或数据已损坏');
        return true;
      },
      `错口令「${wrong}」竟然解开了`,
    );
  }
  // 篡改密文与错口令必须给同一句话 —— 攻击者无法用错误信息探测数据完整性
  const raw = b64ToBytes(env.ct);
  const tampered = Uint8Array.from(raw);
  tampered[0] = tampered[0] ^ 0x01;
  await assert.rejects(
    () => openWithPassphrase({ ...env, ct: bytesToB64(tampered) }, PASS, 'note'),
    (e) => e instanceof CryptoError && e.message === '解密失败：口令不正确或数据已损坏',
  );
});

test('安全不变量4: 篡改密文任一字节必失败（GCM 认证生效）', async () => {
  const env = await sealWithPassphrase(TEXT, PASS, 'note');
  const raw = b64ToBytes(env.ct);
  // 翻一位
  const tampered = Uint8Array.from(raw);
  tampered[0] = tampered[0] ^ 0x01;
  await assert.rejects(
    () => openWithPassphrase({ ...env, ct: bytesToB64(tampered) }, PASS, 'note'),
    CryptoError,
  );
  // 截断
  await assert.rejects(
    () => openWithPassphrase({ ...env, ct: bytesToB64(raw.slice(0, -1)) }, PASS, 'note'),
    CryptoError,
  );
});

test('安全不变量5: AAD 不可换 —— note 的密文用 meta 解不开', async () => {
  const env = await sealWithPassphrase(TEXT, PASS, 'note');
  await assert.rejects(() => openWithPassphrase(env, PASS, 'meta'), CryptoError);
  await assert.rejects(() => openWithPassphrase(env, PASS, 'egg'), CryptoError);
});

test('安全不变量6: envelope 自描述，KDF 参数随密文走', async () => {
  const env = await sealWithPassphrase(TEXT, PASS, 'note');
  assert.equal(env.v, 1);
  assert.equal(env.alg, 'AES-256-GCM');
  assert.equal(env.kdf.name, 'PBKDF2-HMAC-SHA256');
  assert.equal(env.kdf.iter, KDF_ITERATIONS);
  assert.ok(KDF_ITERATIONS >= 600000, '迭代次数低于 OWASP 现行线');
  assert.equal(b64ToBytes(env.kdf.salt).length, 16);
  assert.equal(b64ToBytes(env.iv).length, 12);
});

test('安全不变量7: 口令校验走哨兵串，正确返回 true 错误返回 false', async () => {
  const env = await makeSentinel(PASS);
  assert.equal(await checkPassphrase(PASS, env), true);
  assert.equal(await checkPassphrase('错', env), false);
  assert.equal(await checkPassphrase('', env), false);
  // 哨兵常量不得被当成业务数据
  assert.equal(SENTINEL_PLAINTEXT, 'notesync.bj.v1');
});

test('口令为空直接拒绝，不做无意义的 600k 次派生', async () => {
  await assert.rejects(() => sealWithPassphrase('x', '', 'note'), CryptoError);
});

test('同一 salt 显式复用时派生出的密钥相同（便于确定性重放测试）', async () => {
  const a = await deriveKey(PASS, bytesToB64(new Uint8Array(16)));
  const b = await deriveKey(PASS, bytesToB64(new Uint8Array(16)));
  const ea = await encryptString('同样的内容', a.key, 'note', a);
  const eb = await encryptString('同样的内容', b.key, 'note', b);
  assert.equal(a.saltB64, b.saltB64);
  assert.notEqual(ea.iv, eb.iv, '同 salt 下 iv 仍须每次随机');
  assert.equal(await decryptString(ea, b.key, 'note'), '同样的内容');
});

test('非法 envelope 一律拒绝（不静默降级）', async () => {
  const env = await sealWithPassphrase(TEXT, PASS, 'note');
  const bads = [
    [{ ...env, v: 2 }, '版本不支持'],
    [{ ...env, alg: 'AES-128-GCM' }, '算法不支持'],
    [{ ...env, kdf: { ...env.kdf, name: 'scrypt' } }, 'KDF 不支持'],
    [{ ...env, kdf: { ...env.kdf, iter: 1000 } }, '迭代次数异常'],
    [{ ...env, kdf: { ...env.kdf, salt: 'AAAA' } }, 'salt 太短'],
  ];
  for (const [e, why] of bads) {
    await assert.rejects(() => openWithPassphrase(e, PASS, 'note'), CryptoError, `应拒绝：${why}`);
  }
});

test('base64 往返对二进制安全（含 0x00 与 0xff）', () => {
  const b = new Uint8Array(256);
  for (let i = 0; i < 256; i++) b[i] = i;
  assert.deepEqual(Array.from(b64ToBytes(bytesToB64(b))), Array.from(b));
  assert.deepEqual(Array.from(b64ToBytes(bytesToB64(new Uint8Array(0)))), []);
});

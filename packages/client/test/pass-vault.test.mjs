/**
 * 口令保险箱单测（PV 系列）
 *
 * 🔴 为什么要单独测它：它是"点扫码配对/扫码换机**不再**要输口令"的开关，
 *   而它同时又是**唯一一处把口令落到盘上**的地方。
 *   功能错 ⇒ 用户每次都要输（用户报障原话）；
 *   安全错 ⇒ 口令以明文躺在 localStorage（比老项目还差）。
 *   两条都要钉，缺一条就会有人"为了修功能"退化成明文。
 *
 * 判据纪律：import 生产代码（../src/sync/pass-vault.ts），不抄实现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * localStorage 桩
 *
 * 🔴 必须在 import 被测模块**之前**装好：node 里没有 localStorage，
 *   而模块里的函数是在**调用时**才去取这个全局，所以先装再调即可。
 * ------------------------------------------------------------------ */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
};

const { savePassVault, readPassVault, dropPassVault } = await import('../src/sync/pass-vault.ts');
const { deriveKey, encryptString } = await import('../../shared-schema/src/crypto.ts');

const PASS = '我的口令 123';
const dkA = await deriveKey(PASS);
const dkB = await deriveKey(PASS); // 同口令不同 salt ⇒ 另一把钥匙

test('PV-01 存进去能原样读回（记忆解锁后拿得出口令）', async () => {
  await savePassVault('pv01', PASS, dkA);
  assert.equal(await readPassVault('pv01', dkA.key), PASS);
});

test('PV-02 🔴 换了密钥就读不出来（改口令/清 IndexedDB 后自动失效）', async () => {
  await savePassVault('pv02', PASS, dkA);
  assert.equal(
    await readPassVault('pv02', dkB.key),
    undefined,
    '另一把钥匙不能解开保险箱 —— 否则"改了口令还能用旧保险箱"',
  );
});

test('PV-03 删掉之后读不到（锁定必须同时删）', async () => {
  await savePassVault('pv03', PASS, dkA);
  assert.equal(await readPassVault('pv03', dkA.key), PASS);
  dropPassVault('pv03');
  assert.equal(await readPassVault('pv03', dkA.key), undefined);
});

/**
 * 🔴🔴 这条是**这个模块存在的理由**，也是最容易被"顺手改坏"的一条。
 *   为了修"每次都要输口令"，最省事的写法是把口令明文 setItem 进去 ——
 *   功能一样能用，测试 PV-01/03 照样绿，只有这条会红。
 */
test('PV-04 🔴🔴 localStorage 里绝不能出现口令明文', async () => {
  await savePassVault('pv04', PASS, dkA);
  const raw = localStorage.getItem('notesync_bj_pass_pv04') ?? '';
  assert.notEqual(raw, '', '保险箱根本没写进去（存失败被静默吞了？）');
  assert.ok(!raw.includes(PASS), `口令以明文落盘了：${raw.slice(0, 80)}`);
  // 反向再钉一层：也不该出现 base64 裸编码的口令（那等于明文）
  const b64 = Buffer.from(PASS, 'utf8').toString('base64');
  assert.ok(!raw.includes(b64), '口令的 base64 裸编码落盘了（等同于明文）');
});

test('PV-05 🔴 localStorage 不可用（隐私模式/配额满）时**不抛**，退化成读不到', async () => {
  const real = globalThis.localStorage;
  // 连 getItem 都抛，模拟最坏情况
  globalThis.localStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceeded'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  try {
    await savePassVault('pv05', PASS, dkA); // 不该抛
    assert.equal(await readPassVault('pv05', dkA.key), undefined); // 不该抛
    dropPassVault('pv05'); // 不该抛
  } finally {
    globalThis.localStorage = real;
  }
});

/**
 * AAD 域分离：一段"正文密文"不该被当成口令保险箱解开。
 * 少了这条，把 AAD 写死成 'note' 也能过 PV-01，两个用途就串了。
 */
test('PV-06 🔴 正文密文（AAD=note）不能被当口令保险箱读出来', async () => {
  const env = await encryptString(PASS, dkA.key, 'note', dkA);
  localStorage.setItem('notesync_bj_pass_pv06', JSON.stringify(env));
  assert.equal(
    await readPassVault('pv06', dkA.key),
    undefined,
    'AAD 域分离失效：正文密文被当成口令保险箱解开了',
  );
});

test('PV-07 空口令不落盘（空串不是有效口令，存了只会污染判断）', async () => {
  await savePassVault('pv07', '', dkA);
  assert.equal(localStorage.getItem('notesync_bj_pass_pv07'), null);
});

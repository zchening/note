/**
 * 解锁分支里 `kdf.iter` 的校验判据 —— 钉住"删掉死变量**没有**拆掉安全网"
 *
 * 🔴 背景（P1-4 死代码清理）：
 *   `sync/unlock.ts` 的「远端有信封」分支里曾有 `const iter = remote.env.kdf.iter;`，
 *   声明后**从未被读取**。删它之前必须回答一个问题：
 *   "它本来是不是该做迭代次数校验？" —— 若是，删掉就等于拆掉一道闸。
 *   实测结论：那道闸**已经在下游生效** —— `decryptString()` 对同一个 env 判
 *   `!Number.isInteger(kdf.iter) || kdf.iter < 100_000`（shared-schema/src/crypto.ts:165），
 *   本文件下面那次 decryptString 调用必然走到它。
 *
 * 🔴🔴 所以本文件的职责不是"测删除"这个动作，而是**钉住那道闸仍然在**：
 *   万一哪天有人把 crypto.ts 的判据挪走或放宽，这里必须立刻转红，
 *   而不是让 unlock.ts 留着一行"看起来校验过"的死代码。
 *
 * 纪律：信封一律用生产代码 `encryptString` 造（不手写第二份实现）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installBrowserShims } from './dom-shims.mjs';
import { canonicalize, deriveKey, encryptString, normalize } from '@bj/shared-schema';

installBrowserShims();

const { unlock, unlockIfRemembered, PASS_ERROR } = await import('../src/sync/unlock.ts');

const PASS = '测试口令';
/** 全套共用一把钥匙（盐决定一切，见 unlock.test.mjs 文件头）。 */
const DK = await deriveKey(PASS, 'AAAAAAAAAAAAAAAAAAAAAA==');

function docOf(...texts) {
  return normalize({ v: 1, blocks: texts.map((t) => ({ t: 'p', spans: [{ t }] })) });
}

async function seal(d) {
  return encryptString(canonicalize(d), DK.key, 'note', DK);
}

/** 把信封的 kdf.iter 换成给定值（其余字节不动）。 */
function withIter(env, iter) {
  return { ...env, kdf: { ...env.kdf, iter } };
}

function fetchOnce(body) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

test('UK-01 🔴 对照组：正常 iter（KDF 原值）必须解锁成功（证明下面两条不是"整体坏了才失败"）', async () => {
  const env = await seal(docOf('正常内容'));
  assert.ok(Number.isInteger(env.kdf.iter) && env.kdf.iter >= 100_000, `前提：生产的 iter 本就达标：${env.kdf.iter}`);
  const r = await unlock({ noteId: 'uk-1', passphrase: PASS, fetchImpl: fetchOnce(env) });
  assert.equal(r.ok, true, '正常信封必须解锁成功');
});

test('UK-02 🔴 iter 被改成 5（< 100_000）⇒ 必须失败，绝不假成功（不应该有）', async () => {
  const env = withIter(await seal(docOf('内容')), 5);
  const r = await unlock({ noteId: 'uk-2', passphrase: PASS, fetchImpl: fetchOnce(env) });
  assert.equal(r.ok, false, '迭代次数异常的信封必须被拒（放行 = 弱口令信封可被强推）');
  assert.equal(!r.ok && r.reason, 'pass');
  // 🔴 文案必须是同一句：单列一种"数据坏"的文案就是给爆破一个 oracle
  assert.equal(!r.ok && r.message, PASS_ERROR);
  // 🔴 不该留下密钥：否则下次"记忆解锁"拿着错的记忆进编辑器
  assert.equal(await unlockIfRemembered('uk-2'), undefined, '失败时绝不该留下密钥');
});

test('UK-03 iter 不是整数（字符串 / 缺失）⇒ 失败且不抛（应该有 fail，不应该有 throw）', async () => {
  for (const [name, bad] of [['字符串', 'abc'], ['缺失', undefined]]) {
    const env = withIter(await seal(docOf('内容')), bad);
    // 应该有：返回 fail，而不是把异常抛给调用方
    const r = await unlock({ noteId: `uk-3-${name}`, passphrase: PASS, fetchImpl: fetchOnce(env) });
    assert.equal(r.ok, false, `iter=${name} 必须失败`);
    assert.equal(!r.ok && r.message, PASS_ERROR, `iter=${name} 的文案必须是同一句`);
  }
});

test('UK-04 🔴 删掉的死变量确实没参与派生：iter 达标但与密钥无关时仍照常解锁', async () => {
  // 远端信封的 iter 与派生**无关**（deriveKey 只吃 salt，用全局 KDF_ITER）。
  // 把 iter 改成一个**达标但不同**的值 ⇒ 仍应解锁成功。
  // 这条钉住"删掉的是未读变量"，不是"删掉了一处生效的校验"。
  const env = withIter(await seal(docOf('另一篇')), DK.iter + 1_000);
  const r = await unlock({ noteId: 'uk-4', passphrase: PASS, fetchImpl: fetchOnce(env) });
  assert.equal(r.ok, true, 'iter 达标但与派生无关 ⇒ 照常解锁（证明它不参与派生）');
  assert.equal(canonicalize(r.ok ? r.doc : null), canonicalize(docOf('另一篇')));
});

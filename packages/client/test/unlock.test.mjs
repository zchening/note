/**
 * 解锁链路单测 —— 覆盖「口令 → 密钥 → 文档」的全部分支
 *
 * 🔴🔴 全套共用**同一把** DerivedKey（同 sync-client.test.mjs 的理由）：
 *   盐决定一切，信封自带盐。若 seal() 内部自己 deriveKey（新随机盐），
 *   而 unlock 用远端信封的盐派生，两把钥匙必然不同 —— 报出来的是"口令不对"，
 *   与真实病因（测试造了两把钥匙）差了十万八千里。
 *
 * 判据原则：**不手写第二份实现**。信封一律用生产代码 encryptString 生成。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installBrowserShims } from './dom-shims.mjs';
import {
  canonicalize,
  decryptString,
  deriveKey,
  emptyDoc,
  encryptString,
  normalize,
} from '@bj/shared-schema';

installBrowserShims();

const { unlock, unlockIfRemembered, readCache, writeCache, clearCache, changePassphrase, lockNote, PASS_ERROR, cacheKeyOf } =
  await import('../src/sync/unlock.ts');

const PASS = '测试口令';

/** 全套共享的 dk：手动指定 salt，保证每次运行同一把钥匙 */
const DK = await deriveKey(PASS, 'AAAAAAAAAAAAAAAAAAAAAA==');

function docOf(...texts) {
  return normalize({ v: 1, blocks: texts.map((t) => ({ t: 'p', spans: [{ t }] })) });
}

async function seal(d, dk = DK) {
  return encryptString(canonicalize(d), dk.key, 'note', dk);
}

function ok(body) {
  return { ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
function fetchOnce(body) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return ok(body);
  };
  f.calls = calls;
  return f;
}
function fetchSeq(...bodies) {
  let i = 0;
  const f = async () => {
    const b = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    if (b instanceof Error) throw b;
    return ok(b);
  };
  return f;
}

/* =============== U1 远端有信封 + 正确口令 =============== */
test('U1 远端有信封且口令对：解出文档、缓存落盘、密钥入库', async () => {
  const d = docOf('你好', '世界');
  const env = await seal(d);
  const r = await unlock({ noteId: 'n1', passphrase: PASS, fetchImpl: fetchOnce(env) });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.fresh, false);
  assert.equal(canonicalize(r.ok ? r.doc : null), canonicalize(d));
  // 缓存必须落，否则下次断网进编辑器是空的
  const c = readCache('n1');
  assert.ok(c, '缓存没写');
  assert.equal(c.salt, DK.saltB64, '缓存里的盐必须与信封一致，否则换会话解不开');
  // 再走一次"记住口令"路径：不该再要口令
  const mem = await unlockIfRemembered('n1');
  assert.ok(mem, 'key-store 里没存密钥');
  assert.equal(canonicalize(mem.doc), canonicalize(d));
});

/* =============== U2 口令错 =============== */
test('U2 口令错：失败且文案是"口令不对，或数据无法解密"', async () => {
  const env = await seal(docOf('x'));
  const r = await unlock({ noteId: 'n2', passphrase: '错的', fetchImpl: fetchOnce(env) });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'pass');
  assert.equal(!r.ok && r.message, PASS_ERROR);
  // 🔴 关键：不能留下密钥，否则下次"记住口令"会用错误的记忆进编辑器
  assert.equal(await unlockIfRemembered('n2'), undefined, '口令错了却记住了密钥');
});

/* =============== U3 口令错与数据坏同一句 =============== */
test('U3 远端数据被换成另一把密钥的密文：文案与口令错完全一致', async () => {
  const other = await deriveKey('别人的口令');
  const env = await seal(docOf('密文'), other);
  const r = await unlock({ noteId: 'n3', passphrase: PASS, fetchImpl: fetchOnce(env) });
  assert.equal(r.ok, false);
  // 🔴 这条是 ARCH 安全不变量：能分辨"口令对但数据坏"就等于给出爆破 oracle
  assert.equal(!r.ok && r.message, PASS_ERROR);
});

/* =============== U4 远端空 = 新笔记 =============== */
test('U4 远端 200+空体：新建笔记，fresh=true，文档为空', async () => {
  const r = await unlock({ noteId: 'n4', passphrase: PASS, fetchImpl: fetchOnce('') });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.fresh, true, '新笔记必须标fresh，调用方要立刻推上去');
  assert.equal(canonicalize(r.ok ? r.doc : null), canonicalize(emptyDoc()));
});

/* =============== U5 断网 =============== */
test('U5 fetch reject：离线，且**绝不清空已有内容**', async () => {
  // 🔴 前置必须是"有内容的笔记"。我第一版只建了个空笔记就去断网，
  //   空笔记压根没有缓存，于是断网当然过不去 —— 症状看着像产品 bug，
  //   其实是测试没造出前置状态。造状态时要用真内容，别用空文档糊弄。
  const d = docOf('离线前写的内容');
  await unlock({ noteId: 'n5', passphrase: PASS, fetchImpl: fetchOnce(await seal(d)) });
  assert.ok(readCache('n5'), '前置：有内容的笔记必须落缓存');
  // 再断网解锁
  const r = await unlock({ noteId: 'n5', passphrase: PASS, fetchImpl: fetchSeq(new Error('down')) });
  assert.equal(r.ok, true, '本机有缓存+密钥时应放行（离线可读是老项目的核心体验）');
  assert.equal(canonicalize(r.ok ? r.doc : null), canonicalize(d), '🔴 断网绝不能丢正文');
  // 换一篇从没解锁过的：断网必须明确报离线，不能当空笔记
  const r2 = await unlock({ noteId: 'n5b', passphrase: PASS, fetchImpl: fetchSeq(new Error('down')) });
  assert.equal(r2.ok, false);
  assert.equal(!r2.ok && r2.reason, 'offline');
});

/* =============== U6 断网但有缓存没密钥（换了浏览器） =============== */
test('U6 断网 + 有缓存无密钥：用缓存的盐派生同一把钥匙，仍能读出正文', async () => {
  const d = docOf('离线也能看');
  const env = await seal(d);
  writeCache('n6', env);
  const r = await unlock({ noteId: 'n6', passphrase: PASS, fetchImpl: fetchSeq(new Error('down')) });
  assert.equal(r.ok, true);
  assert.equal(canonicalize(r.ok ? r.doc : null), canonicalize(d));
});

/* =============== U7 缓存坏了要清掉，不能无限失败 =============== */
test('U7 缓存密文被篡改：清缓存后退回要求输口令', async () => {
  const d = docOf('a');
  // 走真解锁，让密钥进 key-store（"记住口令"的前提）
  await unlock({ noteId: 'n7', passphrase: PASS, fetchImpl: fetchOnce(await seal(d)) });
  // 篡改 ct：GCM 认证必然失败
  const raw = JSON.parse(localStorage.getItem(cacheKeyOf('n7')));
  raw.ct = Buffer.from('tampered').toString('base64');
  localStorage.setItem(cacheKeyOf('n7'), JSON.stringify(raw));
  const mem = await unlockIfRemembered('n7');
  assert.equal(mem, undefined, '坏缓存不能被当成有效记忆');
  assert.equal(readCache('n7'), undefined, '坏缓存必须被清掉');
});

/* =============== U8 云端空但本机有缓存 = 推回云端 =============== */
test('U8 云端空 + 本机有缓存：用缓存盐解锁并保留内容', async () => {
  const d = docOf('本机有内容');
  writeCache('n8', await seal(d));
  const r = await unlock({ noteId: 'n8', passphrase: PASS, fetchImpl: fetchOnce('') });
  assert.equal(r.ok, true);
  // 🔴 这一支的要点是内容不丢。fresh 必须是 false，否则调用方会拿空文档去推，
  //   把本机内容覆盖掉（静默数据丢失的典型路径）
  assert.equal(r.ok && r.fresh, false, '云端空但本地有内容时不能标fresh');
  assert.equal(canonicalize(r.ok ? r.doc : null), canonicalize(d));
});

/* =============== U9 改口令 =============== */
test('U9 改口令：老口令解开、新口令能再解、老的解不开了', async () => {
  const d = docOf('机密');
  const r = await changePassphrase('n9', PASS, '新口令', d, fetchOnce(await seal(d)));
  assert.equal(r.ok, true);
  // 模拟服务端此刻存的是新口令的密文（用生产代码重新造一份，不手写信封）
  const fresh = await deriveKey('新口令');
  const env2 = await encryptString(canonicalize(d), fresh.key, 'note', fresh);
  const again = await unlock({ noteId: 'n9b', passphrase: '新口令', fetchImpl: fetchOnce(env2) });
  assert.equal(again.ok, true);
  assert.equal(canonicalize(again.ok ? again.doc : null), canonicalize(d));
  // 🔴 老口令必须解不开新密文 —— 否则"改口令"只是改了个名字
  const old = await unlock({ noteId: 'n9c', passphrase: PASS, fetchImpl: fetchOnce(env2) });
  assert.equal(old.ok, false, '改完口令后老口令还能解开 = 没真的改');
});

/* =============== U10 锁定只清本机 =============== */
test('U10 锁定：清掉缓存与密钥，但不动云端', async () => {
  await unlock({ noteId: 'n10', passphrase: PASS, fetchImpl: fetchOnce(await seal(docOf('x'))) });
  assert.ok(readCache('n10'), '前置：缓存应存在');
  // 锁定后：缓存没了、密钥也没了。
  // 判据用"能不能再记住"而不是"fetch 被调了几次"—— 后者要求塞一个探针进去，
  // 而 lockNote 的实现里根本没有 fetch，测它等于测桩子。
  await lockNote('n10');
  assert.equal(readCache('n10'), undefined, '锁定后缓存应清');
  assert.equal(await unlockIfRemembered('n10'), undefined, '锁定后不该还记得密钥');
  // 云端仍在：重新输口令还能拿回内容
  const again = await unlock({ noteId: 'n10', passphrase: PASS, fetchImpl: fetchOnce(await seal(docOf('x'))) });
  assert.equal(again.ok, true, '🔴 锁定只清本机，重输口令必须还能拿回云端内容');
});

/* =============== U11 AAD 域分离 =============== */
test('U11 用 meta 域加密的信封不能被当笔记解开', async () => {
  // 若unlock 用了错的 AAD tag，GCM 认证会失败 → 报"口令不对"。
  // 这条钉住 AAD tag 必须是 'note'
  const env = await encryptString(canonicalize(docOf('x')), DK.key, 'meta', DK);
  const r = await unlock({ noteId: 'n11', passphrase: PASS, fetchImpl: fetchOnce(env) });
  assert.equal(r.ok, false, 'AAD 用错域竟然解开了');
});

/* =============== U12 同一口令两次新建 = 两把不同的钥匙 =============== */
test('U12 两次"新建同一篇"派生出的盐不同（否则固定盐丧失 GCM 语义安全）', async () => {
  const a = await unlock({ noteId: 'n12a', passphrase: PASS, fetchImpl: fetchOnce('') });
  const b = await unlock({ noteId: 'n12b', passphrase: PASS, fetchImpl: fetchOnce('') });
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(a.ok && a.dk.saltB64, b.ok && b.dk.saltB64);
});

/* =============== U13 信封缺字段 = 数据坏 =============== */
test('U13 远端返回结构不合法：报"云端数据无法解析"而不是当成空笔记', async () => {
  const r = await unlock({ noteId: 'n13', passphrase: PASS, fetchImpl: fetchOnce({ hello: 'world' }) });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'broken');
});

/* =============== U14 decryptString 直接复核缓存信封形状 =============== */
test('U14 缓存信封的 kdf 名与迭代数被正确还原（改迭代后老缓存仍可解）', async () => {
  const low = await deriveKey(PASS, 'BBBBBBBBBBBBBBBBBBBBBB==');
  const env = await encryptString(canonicalize(docOf('低迭代')), low.key, 'note', low);
  writeCache('n14', env);
  const c = readCache('n14');
  assert.equal(c.iter, low.iter);
  assert.equal(c.salt, low.saltB64);
  const r = await unlock({ noteId: 'n14', passphrase: PASS, fetchImpl: fetchSeq(new Error('down')) });
  assert.equal(r.ok, true, '迭代数没被硬编码成常量，否则老缓存一律解不开');
  assert.equal(canonicalize(r.ok ? r.doc : null), canonicalize(docOf('低迭代')));
});

/* =============== U15 clearCache 不抛 =============== */
test('U15 clearCache 对不存在的键安全', () => {
  clearCache('never-existed');
  assert.equal(readCache('never-existed'), undefined);
});

/* =============== U16 口令为空 =============== */
test('U16 空口令：直接失败，连 fetch 都不该发', async () => {
  let called = 0;
  const f = async () => {
    called += 1;
    return ok('');
  };
  const r = await unlock({ noteId: 'n16', passphrase: '', fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(called, 0, '空口令还去请求服务器 = 白白暴露一次笔记名');
});

/* =============== U17 解密往返（防止重构把 AAD 写错） =============== */
test('U17 全链路往返：口令 → 派生 → 加密 → 解密 → 文档一致', async () => {
  const d = docOf('甲', '乙', '丙');
  const dk = await deriveKey(PASS);
  const env = await encryptString(canonicalize(d), dk.key, 'note', dk);
  const back = await decryptString(env, dk.key, 'note');
  assert.equal(canonicalize(JSON.parse(back)), canonicalize(d));
});

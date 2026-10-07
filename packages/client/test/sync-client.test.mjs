/**
 * 同步客户端单测 —— 全部靠注入的 fake fetch，在 node 里跑
 *
 * 🔴🔴 本文件针对「静默降级」类故障。那类故障的特征是：不报错、有返回、结果是错的。
 *   所以判据一律钉**具体值**，绝不用 `assert.ok(x === a || x === b)` 这种"都可以"的宽松断言。
 *
 * 覆盖的每一条都对应 sync/client.ts 文件头列的一类故障：
 *   N1 网络层失败（fetch reject）→ offline，且**本地文档一字不少**
 *   N2 200+空体 = 新笔记，不是错误
 *   N3 解密失败 → 文案**不区分**口令错/数据坏（ARCH 安全不变量）
 *   N4 推送失败 → 停在 offline，dirty 不许被清
 *   N5 去抖：连续打字只推一次
 *   N6 远端没动 → 本地原样
 *   N7 只有远端动 → 直接采纳远端
 *   N8 两边都动（改不同处）→ 合并后推上去
 *   N9 两边改同一处 → conflict 态 + 冲突详情可读
 *   N10 429 → 提示 + offline
 *   E1 推上去的是真信封，AAD 用 note 域，载荷里**不许出现明文**
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// 🔴 必须先装垫片再import 被测模块：writeCache 在 push 成功后会碰 localStorage，
//   没有它就是 ReferenceError，症状是"S5-N5 去抖用例莫名红了"，与去抖无关。
import { installBrowserShims } from './dom-shims.mjs';
installBrowserShims();

const { canonicalize, decryptString, deriveKey, encryptString, emptyDoc, parseDoc } = await import('../../shared-schema/src/index.ts');
const { SyncClient } = await import('../src/sync/client.ts');
const { readCache, clearCache } = await import('../src/sync/local-cache.ts');

const PASS = 'pw';

/** 造一份文档；不传行则为空文档（空文档是 `{v:1}`，不带空数组） */
function docOf(...lines) {
  if (lines.length === 0) return { v: 1 };
  // 🔴 块类型字段是 `t` 不是 `k`（真源 schema，见 shared-schema/src/types.ts）。
  //   写错字段名不会报类型错（测试文件是 .mjs，无类型检查），
  //   只会在 validateDoc 里报 E_BLOCK_TYPE_UNKNOWN —— 症状是"同步不工作了"，
  //   与"测试数据写错"八竿子打不着。
  return { v: 1, blocks: lines.map((t) => ({ t: 'p', spans: [{ t }] })) };
}

const textsOf = (d) => (d.blocks ?? []).map((b) => (b.spans ?? []).map((s) => s.t).join(''));

/**
 * fake fetch：按调用序号取handler。
 * 🔴 必须是"按序号可编程"而不是固定响应 —— 第一版用固定响应，
 *   第二条用例就因为继承了第一条的响应而假绿（症状：测试全过、线上仍有 bug）。
 */
function fakeFetch(handlers) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, method: (init && init.method) || 'GET' });
    const h = handlers[calls.length - 1];
    if (typeof h === 'function') return h(url, init);
    if (h instanceof Error) throw h;
    return h;
  };
  f.calls = calls;
  return f;
}

const ok = (body) => ({
  ok: true,
  status: 200,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

const tooMany = () => ({
  ok: false,
  status: 429,
  text: async () => '{"error":"locked"}',
  json: async () => ({ error: 'locked' }),
});

/**
 * 🔴🔴 全套用例共用**同一把** DerivedKey。
 *
 * 踩过的坑：最初让 `seal()` 内部自己 `deriveKey`，于是信封用一把 key、
 * 客户端持有另一把 key，解密必然失败 —— 报出来的是"口令不对，或数据无法解密"，
 *   与真实病因（测试里密钥不一致）差了十万八千里。
 *
 * 语义依据：`encryptString` 生成的信封里带着 salt，`decryptString` 用**信封里的 salt**
 *   重算密钥。所以"同一口令"必须意味着**同一 salt**，否则派生出的 key 不同。
 *   生产代码里这一点由 key-store 持久化 salt 保证；测试里就得手工共享同一把 dk。
 */
const SHARED_DK = await deriveKey(PASS);

/** 用共享密钥加密一份文档，产出服务端该存的东西 */
async function seal(d, dk = SHARED_DK) {
  return encryptString(canonicalize(d), dk.key, 'note', dk);
}

/**
 * 搭一个受控 SyncClient。
 * @param opts.doc 本地初始文档（用一个可变的 holder，之后可随时改）
 * @param opts.setDoc 替换写回回调（默认写进holder）
 *
 * 🔴🔴 **返回的 c 由用例自己负责 stop()**（收尾在用例末尾显式调）。
 *   起因是 2 秒轮询基线（老项目 index.html:10040 同款）：不 stop 的话，
 *   轮询会在用例跑完之后继续打 fetch。
 *   症状极其恶劣 —— 用例 `t.after` 里 clearCache(NOTE) 已经执行完了，
 *   轮询才把内容推上去、把缓存又写回一版 ⇒ **后一个用例读到的是前一用例的残留**；
 *   而 fakeFetch 的响应队列按序号取，队列耗尽后返回 undefined，
 *   pullInner 读 `res.status` 就抛"Cannot read properties of undefined"——
 *   报错完全指不到被测的东西。这正是 S5-E1/C1/C2/C2b/C3 五条集体变红的真因。
 */
async function mkClient(ctx, handlers, opts = {}) {
  const holder = { doc: opts.doc ?? emptyDoc() };
  const snaps = [];
  const errs = [];
  const dk = opts.dk ?? SHARED_DK;
  const c = new SyncClient({
    // 🔴 noteId 必须可注入：缓存类用例要拿独立 noteId，
    //   否则三条用例共用 'n1' 的缓存，后一条测的就不是自己的前置状态了。
    noteId: opts.noteId ?? 'n1',
    key: dk.key,
    dk,
    getDoc: () => holder.doc,
    setDoc: (d) => { holder.doc = d; },
    onSnapshot: (s) => snaps.push(s.state),
    onError: (m) => errs.push(m),
    isOnline: opts.isOnline ?? (() => true),
  });
  // 🔴🔴 用 t.after 而不是让每条用例自己记得调 stop() ——
  //   手写 17 次必漏，而漏掉的后果**不是报错**，是下一个用例读到上一用例的残留。
  ctx.after(() => c.stop());
  return { c, doc: () => holder.doc, setDoc: (d) => { holder.doc = d; }, snaps, errs };
}

/** 等去抖到期（PUSH_DEBOUNCE_MS = 700，留足余量） */
const settle = () => new Promise((r) => setTimeout(r, 950));

/* ---------------- N1 网络层失败 ---------------- */

test('S5-N1 fetch reject → offline，且本地文档一字不少', async (tc) => {
  globalThis.fetch = fakeFetch([new Error('network down')]);
  const t = await mkClient(tc, []);
  // 模拟"我刚打完字"：本地有内容，base 还是空的
  t.setDoc(docOf('我写的字'));
  await t.c.start();
  assert.equal(t.c.getState(), 'offline', `网络失败必须停在 offline，实际 ${t.c.getState()}`);
  assert.deepEqual(textsOf(t.doc()), ['我写的字'], '🔴 网络失败绝不能清空本地文档');
});

test('S5-N1b navigator 报离线时连 fetch 都不该发', async (tc) => {
  const h = fakeFetch([ok('')]);
  globalThis.fetch = h;
  const t = await mkClient(tc, [], { isOnline: () => false });
  await t.c.start();
  assert.equal(t.c.getState(), 'offline');
  assert.equal(h.calls.length, 0, '已知离线还发请求 = 白等一个超时');
});

/* ---------------- N2 200 + 空体 ---------------- */

test('S5-N2 200+空体 → 当作新笔记，不报错', async (tc) => {
  globalThis.fetch = fakeFetch([ok('')]);
  const t = await mkClient(tc, []);
  await t.c.start();
  assert.equal(t.c.getState(), 'idle', '空体应判定为"服务端无此笔记"');
  assert.deepEqual(t.errs, [], '空体不是错误，不该弹提示');
});

/* ---------------- N3 解密失败 ---------------- */

test('S5-N3 解密失败 → 同一句文案，不区分口令错/数据坏', async (tc) => {
  // 用**另一把**密钥加密，模拟"口令不对"（客户端持有的是 SHARED_DK）
  const wrongDk = await deriveKey('口令不对');
  const env = await seal(docOf('远端内容'), wrongDk);
  globalThis.fetch = fakeFetch([ok(env)]);
  const t = await mkClient(tc, []);
  await t.c.start();
  assert.equal(t.c.getState(), 'offline', '解不开应停在 offline');
  assert.equal(t.errs.length, 1, `应恰好一条错误提示，实际 ${t.errs.length}`);
  // 🔴 安全不变量：区分开等于给暴力破解一个 oracle
  assert.equal(t.errs[0], '口令不对，或数据无法解密');
});

/* ---------------- N4 推送失败不清 dirty ---------------- */

test('S5-N4 推送失败 → 停在 offline，绝不回idle', async (tc) => {
  globalThis.fetch = fakeFetch([ok(''), new Error('post failed')]);
  const t = await mkClient(tc, []);
  await t.c.start();          // GET 空体 → pulled → idle
  t.setDoc(docOf('本地字'));
  t.c.noteEdit();             // → dirty
  await settle();
  assert.equal(t.c.getState(), 'offline', `推送失败应停在 offline，实际 ${t.c.getState()}`);
});

/* ---------------- N5 去抖 ---------------- */

test('S5-N5 连续打字只推一次（去抖 700ms）', async (tc) => {
  const h = fakeFetch([ok(''), ok({ ok: true })]);
  globalThis.fetch = h;
  const t = await mkClient(tc, []);
  t.setDoc(docOf('abc'));
  await t.c.start();
  for (let i = 0; i < 20; i++) t.c.noteEdit();
  await settle();
  const posts = h.calls.filter((x) => x.method === 'POST');
  assert.equal(posts.length, 1, `20 次编辑应只推 1 次，实际 ${posts.length}`);
});

/* ---------------- N6 远端没动 ---------------- */

test('S5-N6 远端 == base → 本地原样保留（不覆盖）', async (tc) => {
  const envBase = await seal(docOf('共同祖先'));
  // 🔴 第三条是**这次推送**的响应。缺了它的症状极其费解：
  //   `merge-clean` 之后会真的发一次 POST（本地确有改动要推），
  //   而 fakeFetch 按序号取 handler，队列耗尽返回 undefined
  //   ⇒ push 读 `res.status` 抛 "Cannot read properties of undefined"
  //   ⇒ 报错指向 push，与"本地有没有被覆盖"八竿子打不着。
  const h = fakeFetch([ok(envBase), ok(envBase), ok({ ok: true })]);
  globalThis.fetch = h;
  const t = await mkClient(tc, []);
  t.setDoc(docOf('共同祖先'));
  await t.c.start();          // 拉一次：本地==base==远端 → pulled，base 填好

  t.setDoc(docOf('共同祖先', '本地新增'));
  await t.c.refresh();        // 再拉：远端仍是 base，本地已改 ⇒ merge-clean
  const texts = textsOf(t.doc());
  assert.ok(texts.includes('本地新增'), `本地新增被覆盖了：${JSON.stringify(texts)}`);
  assert.ok(texts.includes('共同祖先'), `原有内容丢了：${JSON.stringify(texts)}`);
  // 🔴 补一条推送判据：本地有改动 + 远端未变 ⇒ 必须真的推上去。
  //   只 send('merge-clean') 而不 push 的话，状态会永久停在 pushing
  //   （去抖定时器只认 dirty），服务端收不到这一版。
  assert.ok(
    h.calls.some((c) => c.method === 'POST'),
    '🔴 本地有改动、远端未变，却没发 POST = merge-clean 之后无人推送（状态永久停在 pushing）',
  );
});

/* ---------------- N7 只有远端动 ---------------- */

test('S5-N7 本地 == base、远端变了 → 直接采纳远端', async (tc) => {
  const envBase = await seal(docOf('祖先'));
  const envNew = await seal(docOf('祖先', '远端新增'));
  globalThis.fetch = fakeFetch([ok(envBase), ok(envNew)]);
  const t = await mkClient(tc, []);
  t.setDoc(docOf('祖先'));
  await t.c.start();
  await t.c.refresh();
  const texts = textsOf(t.doc());
  assert.ok(texts.includes('远端新增'), `远端新增未采纳：${JSON.stringify(texts)}`);
});

/* ---------------- N8 两边都动（改不同处） ---------------- */

test('S5-N8 两边改不同处 → 三方合并后推上去', async (tc) => {
  const envBase = await seal(docOf('A', 'B', 'C'));
  const envRemote = await seal(docOf('A', 'B', 'C', '远端尾'));
  globalThis.fetch = fakeFetch([ok(envBase), ok(envRemote), ok({ ok: true })]);
  const t = await mkClient(tc, []);
  t.setDoc(docOf('A', 'B', 'C'));
  await t.c.start();

  t.setDoc(docOf('本地头', 'A', 'B', 'C'));
  await t.c.refresh();
  const texts = textsOf(t.doc());
  assert.ok(texts.includes('本地头'), `本地新增丢了：${JSON.stringify(texts)}`);
  assert.ok(texts.includes('远端尾'), `远端新增丢了：${JSON.stringify(texts)}`);
  assert.equal(t.c.getState(), 'idle', '合并无冲突且已推送，应回 idle');
  // base必须已推进到合并结果 —— 否则下一轮合并的"祖先"错位
  const h = globalThis.fetch;
  assert.equal(h.calls.filter((x) => x.method === 'POST').length, 1, '合并后应恰好推一次');
});

/* ---------------- N9 冲突 ---------------- */

test('S5-N9 两边改同一处 → conflict 态 + 冲突详情可读', async (tc) => {
  const envBase = await seal(docOf('原文'));
  const envRemote = await seal(docOf('远端改的'));
  globalThis.fetch = fakeFetch([ok(envBase), ok(envRemote)]);
  const t = await mkClient(tc, []);
  t.setDoc(docOf('原文'));
  await t.c.start();

  t.setDoc(docOf('本地改的'));
  await t.c.refresh();
  assert.equal(t.c.getState(), 'conflict', `应停在 conflict，实际 ${t.c.getState()}`);
  const cs = t.c.getConflicts();
  assert.ok(cs.length > 0, '冲突详情不能为空，否则用户无从裁决');
  assert.equal(typeof cs[0].at, 'string');
  assert.ok(cs[0].at.length > 0, '冲突必须有定位串');
  assert.equal(typeof cs[0].left, 'string');
  assert.equal(typeof cs[0].right, 'string');
});

/* ---------------- N10 429 ---------------- */

test('S5-N10 429 → 提示 + offline', async (tc) => {
  globalThis.fetch = fakeFetch([tooMany()]);
  const t = await mkClient(tc, []);
  await t.c.start();
  assert.equal(t.c.getState(), 'offline');
  assert.match(t.errs[0], /尝试太频繁/);
});

/* ---------------- E1 信封与 AAD ---------------- */

test('S5-E1 推上去的是真信封，AAD 用 note 域，载荷里无明文', async (tc) => {
  const h = fakeFetch([ok(''), ok({ ok: true })]);
  globalThis.fetch = h;
  const t = await mkClient(tc, []);
  t.setDoc(docOf('密文测试'));
  await t.c.start();
  t.c.noteEdit();
  await settle();
  const post = h.calls.find((x) => x.method === 'POST');
  assert.ok(post, '应有一次 POST');
  const env = JSON.parse(post.init.body);
  assert.equal(env.v, 1);
  assert.equal(env.alg, 'AES-256-GCM');
  // 🔴 KDF 名的完整拼写是 PBKDF2-HMAC-SHA256（不是 PBKDF2）。
  //   断言写成 'PBKDF2' 会因为前缀相同而"看起来对"，改成 exactEqual 才拦得住漂移。
  assert.equal(env.kdf.name, 'PBKDF2-HMAC-SHA256');
  assert.ok(env.iv && env.ct, '信封必须有 iv/ct');
  assert.ok(env.kdf.salt, '信封必须带 salt');
  // 🔴 服务器上不该出现明文
  assert.ok(!post.init.body.includes('密文测试'), '🔴 载荷里出现了明文，加密没生效');
  // 反向：同一把钥匙 + AAD=note 能解开
  const pt = await decryptString(env, SHARED_DK.key, 'note');
  assert.deepEqual(parseDoc(pt), docOf('密文测试'));
});

test('S5-E2 AAD 域分离：note 密文不能用 meta 域解开', async (tc) => {
  // 🔴 用途域分离的意义就在这条：否则同一把钥匙下，
  //   "笔记正文"的密文可以被当"口令哨兵"拿去解锁，反之亦然。
  const env = await encryptString('x', SHARED_DK.key, 'note', SHARED_DK);
  await assert.rejects(
    () => decryptString(env, SHARED_DK.key, 'meta'),
    /解密失败/,
    'AAD 不匹配的密文竟然解开了，域分离失效',
  );
});

/* ======================================================================
 * 下面三条针对「推送成功后的本地缓存」。
 *
 * 🔴🔴 这组是实测才发现的缺陷的钉子：
 *   原来只有「解锁时写缓存」，推送成功后不写。症状是云端已是新内容、
 *   本机缓存还是旧的，用户一断网就看到旧正文，且**界面上没有任何报错**。
 *   每个单独环节都成功，合起来给出一个错的结果 —— 静默降级的教科书形态。
 *   没有测试钉住它，下一个人做"重构"时会理所当然地把它删掉。
 * ====================================================================== */

test('S5-C1 推送成功后本地缓存必须更新（断网时不回退到旧内容）', async (tc) => {
  const NOTE = 'cache-note';
  clearCache(NOTE);
  const h = fakeFetch([ok(''), ok({ ok: true })]);
  globalThis.fetch = h;
  const t = await mkClient(tc, [], { noteId: NOTE });
  t.setDoc(docOf('第一版'));
  await t.c.start();
  t.c.noteEdit();
  await settle();
  // 推送成功了，缓存里就该有第一版
  const c1 = readCache(NOTE);
  assert.ok(c1, '推送成功后本地缓存为空 → 断网会看到旧内容');
  assert.deepEqual(parseDoc(await decryptString(toEnv(c1), SHARED_DK.key, 'note')), docOf('第一版'));

  // 第二版：再推一次，缓存必须跟着变
  const h2 = fakeFetch([ok(''), ok({ ok: true })]);
  globalThis.fetch = h2;
  t.setDoc(docOf('第二版'));
  t.c.noteEdit();
  await settle();
  const c2 = readCache(NOTE);
  assert.deepEqual(parseDoc(await decryptString(toEnv(c2), SHARED_DK.key, 'note')), docOf('第二版'),
    '🔴 缓存还停在第一版：断网后用户会看到自己已经改掉的内容');
  clearCache(NOTE);
});

test('S5-C2 推送失败时缓存**不许**更新（否则以为存上了）', async (tc) => {
  const NOTE = 'cache-fail';
  clearCache(NOTE);
  // 先成功推一版，让缓存有内容
  const h1 = fakeFetch([ok(''), ok({ ok: true })]);
  globalThis.fetch = h1;
  const t = await mkClient(tc, [], { noteId: NOTE });
  t.setDoc(docOf('已存'));
  await t.c.start();
  t.c.noteEdit();
  await settle();
  const before = readCache(NOTE);
  assert.ok(before);

  // 再推一版，但 POST 失败。
  // 🔴 这里**不能**多给一个 ok('')：fakeFetch 是按调用序号取响应的，
  //   多一个就变成 POST 拿到 ok → 推送"成功"→ 缓存合法更新 → 用例测的其实不是失败路径。
  //   第二个 h2 的第 0 次调用就是 POST（没有再调 start()，所以没有 GET）。
  const h2 = fakeFetch([new Error('post failed')]);
  globalThis.fetch = h2;
  t.setDoc(docOf('没存上'));
  t.c.noteEdit();
  await settle();
  const after = readCache(NOTE);
  // 🔴🔴 语义在 2026-10-06 改了（用户报障连带查出，见下），断言随之反转。
  //
  //   旧断言「推送失败 ⇒ 缓存不许更新」的**出发点**是对的：别让用户以为存上了。
  //   但它把"本地副本"当成了"云端的镜像"，于是：
  //     本地只有"云端确认过的那一版" ⇒ 断网时用户读回的是**旧内容**，
  //     而他明明刚写完 —— 探针probe-cache-vs-cloud 实测：编辑完成到 push 返回之间，
  //     缓存键**根本不存在**，数据只在内存里；那一刻刷新页面，字全丢
  //     （probe-ep01-flow 实锤 reload 后 `{"v":1}`）。
  //   ⇒ 那是真的**丢数据**，比"以为存上了"严重得多。
  //
  //   现在：本地副本是**权威**（先落本地），云端是备份。所以推送失败时
  //   **缓存应该更新** —— 那不是"以为存上了"，那是用户真的写了、真的能读回来。
  //   至于"云端没收到"，由底栏状态（`network-fail` 态，见 S5-C1）如实告知用户，
  //   那才是"有没有存上"的正确位置 —— 不该由本地缓存承担。
  assert.notEqual(
    after.ct,
    before.ct,
    '🔴 推送失败时本地缓存也应更新：本地副本是权威，不该因为网络断就把用户刚写的内容弄丢',
  );
  clearCache(NOTE);
});

test('S5-C2b 🔴🔴 页面卸载前必须把待推内容落本地（老项目 pagehide → flushDirtySave 同款）', async (tc) => {
  const NOTE = 'flush-on-unload';
  clearCache(NOTE);
  const h1 = fakeFetch([ok(''), ok({ ok: true })]);
  globalThis.fetch = h1;
  const t = await mkClient(tc, [], { noteId: NOTE });
  t.setDoc(docOf('起手'));
  await t.c.start();
  t.c.noteEdit();
  await settle();
  const before = readCache(NOTE);
  assert.ok(before, '前置：应有缓存');

  // 🔴 这一版**故意不调 settle**（不走去抖窗口），
  //   模拟"PUSH_DEBOUNCE_MS = 700 的窗口内用户就关掉了页面"。
  //   fetch 给一个 reject —— 这正是真实场景：页面正在卸载，请求会被浏览器丢弃。
  //   🔴 不能给空队列：fakeFetch 队列空时返回 undefined，
  //   而 push 会读 `res.status` ⇒ 抛 "Cannot read properties of undefined"，
  //   报错完全指不到被测的东西（同"点不可见元素"那类噪声）。
  const h2 = fakeFetch([new Error('页面卸载，请求被丢弃')]);
  globalThis.fetch = h2;
  t.setDoc(docOf('关页面前敲的最后一句'));
  t.c.noteEdit();
  t.c.flushPending();

  // 断言要等 stageEnv 的加密完成（它是 fire-and-forget）
  for (let i = 0; i< 40 && readCache(NOTE)?.ct === before.ct; i += 1) await settle();
  const after = readCache(NOTE);
  assert.notEqual(
    after.ct,
    before.ct,
    '🔴 flushPending 之后缓存仍未更新 = 页面卸载时最后一批编辑全丢（用户刷新就没了）',
  );
  // 反向：不许把"还没落地的旧内容"清掉 —— 本地是权威，云端失败也不许回滚本地
  assert.ok(after.ct && after.iv, '缓存信封必须完整（有内容才有资格谈丢不丢）');
  clearCache(NOTE);
});

test('S5-C3 缓存信封的盐与信封一致（换会话能解开自己写的密文）', async (tc) => {
  const NOTE = 'cache-salt';
  clearCache(NOTE);
  const h = fakeFetch([ok(''), ok({ ok: true })]);
  globalThis.fetch = h;
  const t = await mkClient(tc, [], { noteId: NOTE });
  t.setDoc(docOf('盐要对'));
  await t.c.start();
  t.c.noteEdit();
  await settle();
  const c = readCache(NOTE);
  assert.equal(c.salt, SHARED_DK.saltB64, '缓存里的盐与实际用的钥匙不配对');
  assert.equal(c.iter, SHARED_DK.iter, '缓存里必须存KDF 迭代数，否则将来调高迭代后老缓存全废');
  clearCache(NOTE);
});

test('S5-MC1 远端未变、本地有改动：merge-clean 之后必须真的推一次（不许永久卡在 pushing）', async (tc) => {
  const NOTE = 'merge-clean-push';
  clearCache(NOTE);
  // 🔴🔴 远端必须返回**非空**信封。
  //   坑：GET 返回空体时 `pullInner` 有"200+空体=新笔记"的短路
  //   （`send('pulled')` 后直接 return），**根本进不了** `eq(remoteDoc, base)` 这一支
  //   ⇒ 判据会测到一条永远走不到的路径上，恒绿且毫无意义（我第一版就是这么写的）。
  // 🔴 用函数型 handler（按 method 分流）而不是按序号的固定序列：
  //   2 秒轮询会持续打 GET，固定序列很快耗尽 ⇒ 后续 fetch 拿到 undefined ⇒
  //   报错完全指不到被测的东西（本文件 mkClient 的注释已记过这个坑）。
  const envBase = await seal(docOf('共同的祖先'));
  const h = fakeFetch(
    Array.from({ length: 60 }, () => (url, init) =>
      init && init.method === 'POST' ? ok({ ok: true }) : ok(envBase)),
  );
  globalThis.fetch = h;

  const t = await mkClient(tc, [], { noteId: NOTE });
  await t.c.start();
  assert.equal(t.snaps.at(-1), 'idle', '前置：远端为空且本地无改动时应当直接落到 idle');

  // 本地改动（等价用户打字）⇒ dirty，并排了一个 700ms 的去抖推送
  t.setDoc(docOf('我刚打的字'));
  t.c.noteEdit();
  assert.equal(t.snaps.at(-1), 'dirty', '前置：本地改动后应当是 dirty');

  // 🔴🔴 关键一步：**在去抖窗口内**触发一次拉（模拟 SSE 广播 / 2 秒轮询先到一步）。
  //   dirty --refresh--> syncing ⇒ pull 判「远端 == base 且本地 != base」
  //   ⇒ send('merge-clean') ⇒ **pushing**。
  //   病态实现在这一支 send 完就 return，**没有真的 push**；
  //   而去抖定时器只认 `state === 'dirty'` 才推 ⇒ 状态永久停在 pushing。
  //   v1.13.0 把三处比较从裸 `canonicalize` 换成 `eq`（normalize 后比较）之后，
  //   "打字后"必然命中这一支 ⇒ e2e 的 E2E-S2/E2E-S3 直接红。
  await t.c.refresh();

  // 等过去抖窗口（700ms），看有没有人把这次改动真的推出去
  await settle();

  const posts = h.calls.filter((c) => c.method === 'POST');
  assert.ok(
    posts.length >= 1,
    '🔴 本地有改动却一个 POST 都没发 = 状态停在 pushing 而无人推送（底栏永远"推送中…"）',
  );
  assert.equal(posts.length, 1, `🔴 推了 ${posts.length} 次：一次改动只该推一次`);
  assert.equal(t.snaps.at(-1), 'idle', `🔴 推完必须回到 idle，实测停在 ${t.snaps.at(-1)}`);
  clearCache(NOTE);
});

/** 缓存 → 信封（测试侧还原，供 decryptString 用） */
function toEnv(c) {
  return { v: 1, alg: 'AES-256-GCM', kdf: { name: 'PBKDF2-HMAC-SHA256', iter: c.iter, salt: c.salt }, iv: c.iv, ct: c.ct };
}

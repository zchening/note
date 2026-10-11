/**
 * 离线草稿单测（DR 系列）
 *
 * 🔴 为什么要单独测它：草稿是"用户唯一没损失数据的地方"。
 *   同步链路上的任何一环出错（断网、推送失败、页面被杀），用户还剩最后一份底线；
 *   这条底线一旦自己断了（清早了、跨笔记串了、解不开没兜住），损失不可恢复且零报错。
 *
 * 判据纪律：import 生产代码（../src/sync/draft.ts），不抄实现。
 *   本文件不做任何加解密，全部由 draft.ts 与 shared-schema 完成。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * localStorage 桩（必须在 import 被测模块**之前**装好）
 * 同 pass-vault.test.mjs：node 里没有 localStorage，模块在**调用时**才取全局。
 * 额外记账 `writes`，用来钉「内容没变时不写盘」这条。
 * ------------------------------------------------------------------ */
let writes = 0;
const store = new Map();
const realLs = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    writes += 1;
    store.set(k, String(v));
  },
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
};
globalThis.localStorage = realLs;

/** 把 localStorage 换成"只写就抛 QuotaExceeded"的坏实现，跑完还原 */
async function withQuotaExceeded(fn) {
  globalThis.localStorage = {
    getItem: realLs.getItem,
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem: realLs.removeItem,
  };
  try {
    await fn();
  } finally {
    globalThis.localStorage = realLs;
  }
}

const DR = await import('../src/sync/draft.ts');
const { canonicalize, normalize } = await import('../../shared-schema/src/canonical.ts');
const { deriveKey } = await import('../../shared-schema/src/crypto.ts');

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 判定用的密钥 deriv 出来很贵（600k 次 PBKDF2），全文件共用两把。 */
const KEY_A = await deriveKey('草稿测试口令 A');
const KEY_B = await deriveKey('草稿测试口令 B 完全不同的口令');

const ctxA = (noteId) => ({ noteId, dk: KEY_A });
const ctxB = (noteId) => ({ noteId, dk: KEY_B });

/** 一篇带正文 + 提醒的文档（提醒也是真源的一部分，草稿得一起覆盖） */
const srcDoc = () => ({
  v: 1,
  blocks: [
    { t: 'p', spans: [{ t: '家里 WiFi 密码 hunter2-绝密九五二七', rem: 'r1' }] },
    { t: 'ul', children: [{ t: 'li', spans: [{ t: '去买牛奶' }] }] },
  ],
  reminders: [{ id: 'r1', at: '2026-10-12T08:30:00+08:00', text: '交电费' }],
});

/** 只动提醒，正文一个字没改 —— 用来证明"提醒也是冲突判定内容" */
const srcDocRemOnly = () => ({
  v: 1,
  blocks: [
    { t: 'p', spans: [{ t: '家里 WiFi 密码 hunter2-绝密九五二七', rem: 'r1' }] },
    { t: 'ul', children: [{ t: 'li', spans: [{ t: '去买牛奶' }] }] },
  ],
  reminders: [
    { id: 'r1', at: '2026-10-12T08:30:00+08:00', text: '交电费', done: true },
  ],
});

const cloudDoc = () => ({
  v: 1,
  blocks: [{ t: 'p', spans: [{ t: '云端这一版是旧内容 Alpha-001' }] }],
});

const canonOf = (d) => canonicalize(normalize(d));

/* ================================================================== *
 * DR-01 落草稿 → 重新读：canonical 逐字相等（有可能）
 *      换一个 noteId 读 ⇒ 读不到（不可能）
 * ================================================================== */
test('DR-01 🔴 存进去能原样读回；换一篇笔记读不到（按 noteId 隔离）', async () => {
  const note = 'dr01-note';
  const src = srcDoc();
  assert.equal(await DR.saveDraft(ctxA(note), src, 7), true, '首次保存应当真的落盘');

  const got = await DR.readDraft(ctxA(note));
  assert.ok(got !== undefined, '刚落的草稿读不回来');
  assert.equal(
    canonOf(got.doc),
    canonOf(src),
    '读回来的 doc 与写进去的 doc canonical 后必须逐字相等',
  );
  assert.equal(got.baseRev, 7, 'baseRev 必须原样往返');

  // 反向（“不可能有”）：另一篇笔记的同一个 map 里不该读到这篇的东西
  assert.equal(
    await DR.readDraft(ctxA('dr01-另一篇笔记')),
    undefined,
    '草稿按 noteId 隔离失效：跨笔记串了',
  );
  assert.equal(DR.hasDraft('dr01-另一篇笔记'), false);
  assert.equal(DR.hasDraft(note), true);
});

/* ================================================================== *
 * DR-02 正文没变时重复调用不写盘（不可能有）
 *      内容真变了要写（可能有）
 * ================================================================== */
test('DR-02 🔴 内容没变时重复保存**不写盘**；内容真变了才写', async () => {
  const note = 'dr02-note';
  const src = srcDoc();

  writes = 0;
  await DR.saveDraft(ctxA(note), src, 1);
  assert.equal(writes, 1, '首次保存应写一次');

  // 敲十个字形状完全一样的值（模拟每次按键都调 saveDraft）
  for (let i = 0; i < 10; i += 1) {
    await DR.saveDraft(ctxA(note), srcDoc(), 1);
  }
  assert.equal(writes, 1, '内容没变还往盘里写 —— 每次按键都加密一遍的退化');

  // 配对（“有可能有”）：真改了必须写
  await DR.saveDraft(ctxA(note), cloudDoc(), 2);
  assert.equal(writes, 2, '内容真变了却没落盘 —— 离线保护失效');
  assert.equal(canonOf((await DR.readDraft(ctxA(note))).doc), canonOf(cloudDoc()));
});

/* ================================================================== *
 * DR-03 与云端内容一致 ⇒ 恢复成 none，且草稿被清掉（有可能）
 * ================================================================== */
test('DR-03 草稿与云端一致 ⇒ 恢复到 none 且草稿被清（草稿已无意义）', async () => {
  const note = 'dr03-note';
  const cloud = cloudDoc();
  await DR.saveDraft(ctxA(note), cloud, 3);
  assert.equal(DR.hasDraft(note), true);

  const res = await DR.restoreDraftIfNeeded(ctxA(note), cloud);
  assert.deepEqual(res, { kind: 'none' }, '内容一致时不该弹「保留本机 / 使用云端」');
  assert.equal(DR.hasDraft(note), false, '内容一致的草稿没被清掉');
  assert.equal(DR.isDraftPending(note), false);
});

/* ================================================================== *
 * DR-04 与云端不一致 ⇒ 返回 conflict，带出 doc 与 baseRev（有可能）
 *      且它只是"提示"，此时草稿必须还在盘上（不可能丢）
 * ================================================================== */
test('DR-04 🔴 与云端不一致 ⇒ 返回 conflict 且带出 doc/baseRev；草稿仍在盘上', async () => {
  const note = 'dr04-note';
  const src = srcDoc();
  await DR.saveDraft(ctxA(note), src, 42);

  const res = await DR.restoreDraftIfNeeded(ctxA(note), cloudDoc());
  assert.equal(res.kind, 'conflict', '本机草稿与云端不同，必须让用户选');
  if (res.kind !== 'conflict') return;
  assert.equal(canonOf(res.doc), canonOf(src), '带出来的 doc 必须是草稿里的那份');
  assert.equal(res.baseRev, 42, 'baseRev 必须带出来给调用方推进');

  // “不可能有”：还没做选择，草稿绝不能已经没了
  assert.equal(DR.hasDraft(note), true, '还没让用户选，草稿就丢了');
  assert.equal(DR.isDraftPending(note), true);
});

/** 提醒也是真源的一部分：只有提醒变了，同样得判冲突 */
test('DR-05 🔴 只有**提醒**变了也算冲突（一份加密草稿覆盖正文 + 提醒）', async () => {
  const note = 'dr05-note';
  const remOnly = srcDocRemOnly();
  await DR.saveDraft(ctxA(note), remOnly, 9);

  const res = await DR.restoreDraftIfNeeded(ctxA(note), srcDoc());
  assert.equal(res.kind, 'conflict', '只改提醒也得判冲突 —— 否则提醒改动被静默丢弃');
  if (res.kind !== 'conflict') return;
  const r0 = res.doc.reminders?.[0];
  assert.ok(r0 !== undefined && r0.done === true, '草稿里的 done 标记没带出来');
});

/* ================================================================== *
 * DR-06 解密失败（换密钥）⇒ 静默清除 + 返回 none + 不抛（有可能 + 不可能抛）
 * ================================================================== */
test('DR-06 🔴🔴 解不开（换了密钥）⇒ 静默清除、返回 none、**不抛异常**', async () => {
  const note = 'dr06-note';
  await DR.saveDraft(ctxA(note), srcDoc(), 5);
  assert.equal(DR.hasDraft(note), true);

  let threw = null;
  let res;
  try {
    // 换一把密钥：老密钥加密的草稿必然解不开（改口令 / 清 IndexedDB 后的情形）
    res = await DR.restoreDraftIfNeeded(ctxB(note), cloudDoc());
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, `解密失败不该抛，抛了就是解锁流程整条崩：${String(threw)}`);
  assert.deepEqual(res, { kind: 'none' }, '解不开的草稿应当被当成陈旧数据');
  assert.equal(DR.hasDraft(note), false, '解不开的陈旧草稿没被清掉 —— 之后每次都白解一遍');
  assert.equal(DR.isDraftPending(note), false);
});

/** 密文被改坏（磁盘比特翻转 / 被别的程序写花）同样按陈旧处理 */
test('DR-07 密文被改坏 ⇒ 同 DR-06，静默清除且返回 none', async () => {
  const note = 'dr07-note';
  await DR.saveDraft(ctxA(note), srcDoc(), 5);
  const bad = JSON.parse(localStorage.getItem(DR.draftKeyOf(note)));
  bad.ct = 'A'.repeat(bad.ct.length);
  localStorage.setItem(DR.draftKeyOf(note), JSON.stringify(bad));

  const res = await DR.restoreDraftIfNeeded(ctxA(note), cloudDoc());
  assert.deepEqual(res, { kind: 'none' });
  assert.equal(DR.hasDraft(note), false, '改坏的密文没被清掉');
});

/* ================================================================== *
 * DR-08 🔴🔴 草稿挂起期间 clearDraft() 不清（不可能有——数据丢失红线）
 * ================================================================== */
test('DR-08 🔴🔴 草稿条挂起期间 clearDraft() **绝不清**（用户还没做选择）', async () => {
  const note = 'dr08-note';
  const src = srcDoc();
  await DR.saveDraft(ctxA(note), src, 11);

  // 挂起前：clear 应该好使
  assert.equal(DR.clearDraft(note), true, '没挂起时 clearDraft 应当能删');
  assert.equal(DR.hasDraft(note), false);

  // 重新落一份并挂起
  await DR.saveDraft(ctxA(note), src, 11);
  const res = await DR.restoreDraftIfNeeded(ctxA(note), cloudDoc());
  assert.equal(res.kind, 'conflict');
  assert.equal(DR.isDraftPending(note), true);

  assert.equal(DR.clearDraft(note), false, '挂起期间 clearDraft 必须被挡住');
  assert.equal(DR.hasDraft(note), true, '🔴🔴 草稿条还在屏幕上，草稿却没了');

  // force 是唯一的破例通道（给"用户明确另选"的场景用）
  assert.equal(DR.clearDraft(note, { force: true }), true);
  assert.equal(DR.hasDraft(note), false);
});

/** 挂起期间也不允许用新内容覆盖正在被仲裁的那份草稿 */
test('DR-09 🔴 挂起期间 saveDraft() 不覆盖正在仲裁的草稿', async () => {
  const note = 'dr09-note';
  const src = srcDoc();
  await DR.saveDraft(ctxA(note), src, 13);
  assert.equal((await DR.restoreDraftIfNeeded(ctxA(note), cloudDoc())).kind, 'conflict');

  assert.equal(await DR.saveDraft(ctxA(note), cloudDoc(), 99), false, '挂起期间不该改写草稿');
  const still = await DR.readDraft(ctxA(note));
  assert.equal(canonOf(still.doc), canonOf(src), '正在仲裁的那份草稿被后来的编辑盖掉了');
  assert.equal(still.baseRev, 13);
});

/* ================================================================== *
 * DR-10 用户选「保留本机」：applyDraft 带出内容并解锁 clearDraft
 *      用户选「使用云端」：discardDraft 删掉
 * ================================================================== */
test('DR-10 保留本机 ⇒ applyDraft 带出 doc/baseRev；此时 clearDraft 才生效', async () => {
  const note = 'dr10-note';
  const src = srcDoc();
  await DR.saveDraft(ctxA(note), src, 21);
  assert.equal((await DR.restoreDraftIfNeeded(ctxA(note), cloudDoc())).kind, 'conflict');

  const picked = DR.applyDraft(note);
  assert.ok(picked !== undefined, 'applyDraft 必须返回可回灌的内容');
  if (picked === undefined) return;
  assert.equal(canonOf(picked.doc), canonOf(src));
  assert.equal(picked.baseRev, 21);

  // 🔴 选择了「保留本机」但**还没推送成功**，草稿不能先删 —— 推失败就全没了
  assert.equal(DR.hasDraft(note), true, 'applyDraft 不该立刻删草稿（要等推送成功）');
  assert.equal(DR.isDraftPending(note), false, '做完选择就该解除挂起');

  // 推送成功后调用方调 clearDraft —— 这一下必须生效
  assert.equal(DR.clearDraft(note), true);
  assert.equal(DR.hasDraft(note), false);
});

test('DR-11 使用云端 ⇒ discardDraft 删掉草稿', async () => {
  const note = 'dr11-note';
  await DR.saveDraft(ctxA(note), srcDoc(), 23);
  assert.equal((await DR.restoreDraftIfNeeded(ctxA(note), cloudDoc())).kind, 'conflict');

  DR.discardDraft(note);
  assert.equal(DR.hasDraft(note), false, '选了「使用云端」草稿没删');
  assert.equal(DR.isDraftPending(note), false);
  assert.deepEqual(await DR.restoreDraftIfNeeded(ctxA(note), cloudDoc()), { kind: 'none' });
});

/* ================================================================== *
 * DR-12 resetDraftSession() 清空挂起态（有可能有）
 * ================================================================== */
test('DR-12 🔴 resetDraftSession() 之后挂起态被清空', async () => {
  const note = 'dr12-note';
  await DR.saveDraft(ctxA(note), srcDoc(), 31);
  assert.equal((await DR.restoreDraftIfNeeded(ctxA(note), cloudDoc())).kind, 'conflict');
  assert.equal(DR.isDraftPending(note), true);

  DR.resetDraftSession();

  assert.equal(DR.isDraftPending(note), false, 'reset 之后挂起态还在 —— 切笔记会串到下一篇');
  // 已经有：选完之后 clearDraft 该能删
  assert.equal(DR.clearDraft(note), true);
  assert.equal(DR.hasDraft(note), false);
});

/** 反向：reset 只清**内存会话态**，绝不删盘上的草稿（切笔记不能把另一篇的草稿毁了） */
test('DR-13 🔴 resetDraftSession() **不删** localStorage 里的草稿记录', async () => {
  const note = 'dr13-note';
  await DR.saveDraft(ctxA(note), srcDoc(), 33);
  DR.resetDraftSession();
  assert.equal(DR.hasDraft(note), true, 'reset 把盘上的离线草稿删了 —— 数据丢失');
  // 会话态没了 ⇒ 下一次保存会重写入盘（无害的重算，不该被当成"没变"）
  assert.equal(await DR.saveDraft(ctxA(note), srcDoc(), 33), true);
});

/* ================================================================== *
 * DR-14 localStorage 抛 QuotaExceeded ⇒ 不冒泡（不可能抛）
 * ================================================================== */
test('DR-14 🔴 localStorage 写满（QuotaExceeded）⇒ 不冒泡，主流程继续', async () => {
  const note = 'dr14-note';
  let threw = null;
  try {
    await withQuotaExceeded(async () => {
      assert.equal(await DR.saveDraft(ctxA(note), srcDoc(), 41), false, '写失败应当如实返回 false');
      // 后续主流程继续跑：读不到就当没草稿，同样不能炸
      assert.equal(await DR.readDraft(ctxA(note)), undefined);
      assert.equal(await DR.flushDraft(ctxA(note)), false);
      DR.clearDraft(note);
      DR.discardDraft(note);
      DR.resetDraftSession();
    });
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, `配额满不该冒泡到编辑主流程：${String(threw)}`);
});

/** removeItem 也抛（隐私模式最坏情况）时同样不许炸 */
test('DR-15 removeItem 也抛 ⇒ 不冒泡', async () => {
  const note = 'dr15-note';
  await DR.saveDraft(ctxA(note), srcDoc(), 43);
  globalThis.localStorage = {
    getItem: realLs.getItem,
    setItem: realLs.setItem,
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  let threw = null;
  try {
    DR.clearDraft(note);
    DR.discardDraft(note);
  } catch (e) {
    threw = e;
  } finally {
    globalThis.localStorage = realLs;
  }
  assert.equal(threw, null, `删除失败不该冒泡：${String(threw)}`);
});

/* ================================================================== *
 * DR-16 🔴🔴 密文不泄露明文：localStorage 里存的字符串不含任何可识别明文
 * ================================================================== */
test('DR-16 🔴🔴 localStorage 里存的草稿串**不含**原文任何可识别片段', async () => {
  const note = 'dr16-note';
  const src = srcDoc();
  await DR.saveDraft(ctxA(note), src, 51);

  const raw = localStorage.getItem(DR.draftKeyOf(note)) ?? '';
  assert.notEqual(raw, '', '草稿根本没写进去（写失败被静默吞了？）');

  const canonical = canonOf(src);
  const secrets = [
    'hunter2-绝密九五二七',
    '去买牛奶',
    '交电费',
    canonical,
    Buffer.from(canonical, 'utf8').toString('base64'),
    encodeURIComponent(canonical),
  ];
  for (const s of secrets) {
    assert.ok(!raw.includes(s), `明文/可直接还原的编码落盘了：${s.slice(0, 40)}`);
  }

  // 再钉一层：任意连续 3 个**汉字**都不该出现在记录里。
  // 🔴 只挑汉字段：中文 UTF-8 每字 3 字节且全 >= 0x80，不可能出现在
  //   base64/JSON 这种纯 ASCII 串里（真出现就是明文落盘，不是巧合）；
  //   而 "hunter2" 这类 ASCII 词的碎片可能随机撞上 base64 字符，不构成判据。
  const cjk = '家里密码绝密九五二七去买牛奶交电费';
  for (let i = 0; i + 3 <= cjk.length; i += 1) {
    const win = cjk.slice(i, i + 3);
    assert.ok(!raw.includes(win), `正文片段 "${win}" 出现在了草稿记录里`);
  }
});

/* ================================================================== *
 * DR-17 flushDraft：关页前兜底重写一次（有可能有）
 * ================================================================== */
test('DR-17 flushDraft 绕过"内容没变"的短路，强制重写一次', async () => {
  const note = 'dr17-note';
  await DR.saveDraft(ctxA(note), srcDoc(), 61);
  writes = 0;
  await DR.saveDraft(ctxA(note), srcDoc(), 61);
  assert.equal(writes, 0, '短路应当生效');
  assert.equal(await DR.flushDraft(ctxA(note)), true, 'flush 必须能强制落一次盘');
  assert.equal(writes, 1);
  assert.equal(canonOf((await DR.readDraft(ctxA(note))).doc), canonOf(srcDoc()));
});

/** 另一处的密钥写过的草稿，本篇读不出来（密钥是隔离边界） */
test('DR-18 🔴 别把密钥混用：换一把密钥读不出这篇的草稿', async () => {
  const note = 'dr18-note';
  await DR.saveDraft(ctxA(note), srcDoc(), 63);
  // “不可能有”：换一把密钥读不到
  assert.equal(await DR.readDraft(ctxB(note)), undefined, '换密钥还能读出来 —— 密钥隔离失效');
  // “有可能有”：原钥匙照样读得到
  assert.ok((await DR.readDraft(ctxA(note))) !== undefined);
});

/* ================================================================== *
 * DR-19 同一个上下文里换一篇笔记，内容相同也要各自落盘
 *       —— 会话态按 noteId 分桶，不能让 A 的"已写过"把 B 的第一份草稿吃掉
 * ================================================================== */
test('DR-19 🔴 换第一篇笔记时内容相同也必须各存一份（会话态按 noteId 分桶）', async () => {
  const noteA = 'dr19-a';
  const noteB = 'dr19-b';
  const src = srcDoc();

  assert.equal(await DR.saveDraft(ctxA(noteA), src, 71), true);
  assert.equal(await DR.saveDraft(ctxA(noteB), src, 72), true, 'B 的第一份草稿被 A 的会话态短路了');
  assert.equal(DR.hasDraft(noteA), true);
  assert.equal(DR.hasDraft(noteB), true);

  const gotB = await DR.readDraft(ctxA(noteB));
  assert.ok(gotB !== undefined);
  if (gotB === undefined) return;
  assert.equal(canonOf(gotB.doc), canonOf(src));
  assert.equal(gotB.baseRev, 72, 'baseRev 也必须是 B 自己那份');
});

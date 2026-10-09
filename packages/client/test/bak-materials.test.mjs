/**
 * 「换机恢复后免输口令」生产判据（BAK-MAT 系列）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 本文件钉的是**用户报障第 3 条**：
 *   「在一台新设备扫描换机备份码恢复收藏夹的笔记，成功恢复后，
 *     进入那几篇收藏的笔记不应该再次要求输入口令。」
 *
 * ── 为什么不能照抄老项目 ──────────────────────────────────────────────────
 *   老项目的清单装的是 **raw key 本身**（老项目 collectBackupEntries 里
 *   `out.push([id, k])`，k 是 localStorage 里那把 44 字符 base64 的密钥）。
 *   扫到清单 = 拿到全部钥匙，零输入。
 *   bj 的密钥是 `extractable:false` 的 CryptoKey，**WebCrypto 层面物理上导不出
 *   raw 字节**。要照抄就得先把它降级成可导出 —— 那是亲手拆掉本项目最重要的
 *   一条安全属性（XSS 拿到密钥 = 离线解开全部历史密文）。
 *   ⇒ 装的是 **salt + 自证块**（见 bak-note.ts 的 BakMaterial 注释）。
 *
 * ── 🔴🔴 为什么"自证块"是必需的，不是锦上添花 ─────────────────────────────
 *   bj 是**每篇一把独立锁**（独立 salt + 独立派生）。只装 salt 的话，
 *   恢复端 `deriveKey(备份码口令, salt)` 算得出一把钥匙，但**算得出 ≠ 是那一把**：
 *   若用户给不同笔记设了不同口令，派生出来的是一把错钥匙。而
 *   `unlockIfRemembered`（sync/unlock.ts:147-149）那条"只有密钥没有缓存"分支
 *   **照样返回 ok:true** ⇒ 用户看到的是一个**空编辑器**，正文在云端好好躺着。
 *   **空编辑器 + 零报错 = 静默的数据丢失**，比老实问一次口令糟得多。
 *   ⇒ 必须真的用那把钥匙解开一段自证密文，解不开就判"这篇口令不同"。
 *
 * ── 判据纪律 ───────────────────────────────────────────────────────────────
 *   · 本文件**真跑**（node --test），不扫 main.ts 源码判行为
 *   · 每条「应该有」配一条「不应该有」
 *   · 自证类判据的反向闸 = 「换一把钥匙 / 改一个字节 / 改口令，全部必须转 null」
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectBakMaterials,
  makeBakMaterial,
  materialPass,
  proveBakMaterial,
  proveBakMaterials,
} from '../src/migrate/bak-materials.ts';
import { BAK_PROOF_TEXT, buildBakDoc, decodeBakText, encodeBakText } from '../src/migrate/bak-note.ts';
import { deriveKey, decryptString, encryptString, SENTINEL_PLAINTEXT } from '@bj/shared-schema';

/* ── 本地脚手架 ──────────────────────────────────────────────────────────── */

/** 把 Envelope 摊成可比较的形状（自证块在清单里是 JSON 字符串）。 */
function envOf(mat) {
  return JSON.parse(mat.c);
}

test('BAK-MAT-01 自证块只能用该篇那把钥匙解开', async () => {
  const dk = await deriveKey('口令甲');
  const mat = await makeBakMaterial(dk);

  // 「应该有」：同一把钥匙能解出定长常量明文
  assert.equal(await decryptString(envOf(mat), dk.key, 'meta'), BAK_PROOF_TEXT);

  // 🔴 「不应该有」：另一把钥匙（不同 salt ⇒ 不同密钥）必须解不开。
  //   这条是本设计的**承重墙**：它保证材料里没有任何"可离线试"的密钥信息。
  const other = await deriveKey('口令甲', (await deriveKey('x', 'AAAAAAAAAAAAAAAAAAAAAA==')).saltB64);
  await assert.rejects(() => decryptString(envOf(mat), other.key, 'meta'));

  // 🔴 「不应该有」：材料里绝不能出现 44 字符的 raw AES key（老项目装的就是那个）。
  assert.equal(typeof mat.s, 'string');
  assert.equal(mat.s.length, 24, 'salt 是 16 字节 base64（24 字符），不是 32 字节密钥');
  assert.notEqual(mat.c, mat.s, '自证块与 salt 不得是同一个东西');
});

test('BAK-MAT-02 proveBakMaterial：正确口令过、错口令 null、改一个字节 null、没材料 null', async () => {
  const dk = await deriveKey('口令甲');
  const mat = await makeBakMaterial(dk);

  // 「应该有」：正确口令派生出同一把钥匙（salt 必须与材料一致，否则派生出来是另一把）
  const good = await proveBakMaterial('口令甲', mat);
  assert.ok(good, '正确口令应自证通过');
  assert.equal(good.saltB64, mat.s, '派生必须用材料里的 salt');
  assert.equal(await decryptString(envOf(mat), good.key, 'meta'), BAK_PROOF_TEXT);

  // 🔴 三条「不应该有」：错口令 / 篡改密文 / 没材料，全部返回 null。
  //   注意是 **null 而不是抛** —— 抛的话调用方就得 try/catch 包住每一篇，
  //   而漏掉一处 catch 的后果是整个恢复流程崩掉（那一篇本该只是"要口令"）。
  assert.equal(await proveBakMaterial('口令乙', mat), null, '错口令必须 null');
  assert.equal(await proveBakMaterial('', mat), null, '空口令必须 null');

  const tampered = { s: mat.s, c: mat.c.replace(/.$/, 'A') };
  assert.equal(await proveBakMaterial('口令甲', tampered), null, '改一个字节必须 null');

  assert.equal(await proveBakMaterial('口令甲', null), null, '没材料必须 null');
});

test('BAK-MAT-07 🔴🔴 明文必须比对：同 AAD 的哨兵密文顶替自证块必须被拒', async () => {
  // 🔴🔴🔴 这条是本文件**最容易被漏掉的承重墙**，判据设计的由来：
  //   第一版判据只验"能解开"，于是把 `proveBakMaterial` 里的
  //   `if (plain !== BAK_PROOF_TEXT) return null` 改成 `if (plain === undefined)`
  //   （即只验 GCM 通过、不看解出来是什么）—— **七条判据全绿**。
  //
  //   而"不看解出来是什么"是**可利用**的：`makeSentinel` 用的 AAD 正是 'meta'
  //   （与 PROOF_AAD 同值），哨兵密文 `notesync.bj.v1` 是任何拿到本机的人
  //   （或一次 XSS、或口令保险箱本身）都能读到的公开信封。
  //   把它塞进材料里 ⇒ 只验 GCM 的实现会给出一把**派生不出正文**的钥匙 ⇒
  //   `unlockIfRemembered` 照样返回 ok:true ⇒ **空编辑器 + 零报错**。
  //
  //   ⇒ 所以"解开了"不等于"对"，必须比对明文是那个定长常量。
  const dk = await deriveKey('口令甲');
  const mat = await makeBakMaterial(dk);

  // 用**同一把钥匙、同一个 AAD** 加密一段**别的**明文 —— 攻击者能拿到的正是这种
  const forged = { s: mat.s, c: JSON.stringify(await encryptString('notesync.bj.v1', dk.key, 'meta', dk)) };
  assert.equal(await proveBakMaterial('口令甲', forged), null, '同钥匙同AAD的别段密文必须被拒');

  // 🔴 更狠的一层：**用同一把钥匙 + 同一个 AAD 加密一段"看起来很合法"的明文**。
  //   注意这里必须显式传 `mat.s` —— 否则 deriveKey 拿随机盐，派生出的钥匙与 mat
  //   那把不同，GCM 在第一道门就失败，这条用例就变成"什么都测不到"的恒绿
  //   （第一版正是这么写的：变异 1 之下它照样绿，白写一条）。
  const sentinelLike = await encryptString(SENTINEL_PLAINTEXT, dk.key, 'meta', {
    key: dk.key,
    saltB64: mat.s,
    iter: dk.iter,
  });
  assert.equal(await proveBakMaterial('口令甲', { s: mat.s, c: JSON.stringify(sentinelLike) }), null,
    '合法信封 + 非法明文必须被拒');

  // 🔴 反向闸：真材料仍然必须通过（防止"上面几条把实现改成永远返回 null"）
  assert.ok(await proveBakMaterial('口令甲', mat), '真材料必须仍然自证通过');
});

test('BAK-MAT-03 collectBakMaterials：下标严格跟随，没钥匙的篇为 null', async () => {
  const ids = ['alpha', 'bravo', 'charlie'];
  const salts = {};
  
  const deriveFor = async (id) => {
    const dk = await deriveKey('口令甲');
    salts[id] = dk.saltB64;
    // 'bravo' 模拟"本机没这把钥匙"（比如那篇从没在本机解锁过）
    if (id === 'bravo') return undefined;
    return dk;
  };

  const mats = await collectBakMaterials(ids, deriveFor);
  assert.equal(mats.length, 3, '材料数必须与篇数同长');
  assert.ok(mats[0], 'alpha 应有材料');
  assert.equal(mats[1], null, 'bravo 本机没钥匙 ⇒ null（那篇恢复后照常要口令）');
  assert.ok(mats[2], 'charlie 应有材料');

  // 🔴 承重：下标不能错位（给 A 篇装 B 篇的钥匙，症状是随机的某篇打不开）
  assert.equal(mats[0].s, salts.alpha);
  assert.equal(mats[2].s, salts.charlie);
  assert.notEqual(mats[0].s, mats[2].s, '两篇的 salt 必须不同（否则等于一把钥匙开两篇）');

  // 🔴 「不应该有」：deriveFor 抛异常的那篇也不能拖垮整批
  const mats2 = await collectBakMaterials(['x', 'y'], async (id) => {
    if (id === 'x') throw new Error('boom');
    return deriveKey('口令甲');
  });
  assert.equal(mats2[0], null, '抛异常的篇退化成 null');
  assert.ok(mats2[1], '后面的篇照常出材料');
});

test('BAK-MAT-04 proveBakMaterials：只对自证通过的篇 put，且报数与实际一致', async () => {
  const ids = ['a', 'b', 'c'];
  const mats = [];
  // a、c 用口令甲；b 用口令乙（用户给这篇单独设了别的口令）
  for (const [pass] of [['口令甲'], ['口令乙'], ['口令甲']]) {
    mats.push(await makeBakMaterial(await deriveKey(pass)));
  }

  const put = [];
  const r = await proveBakMaterials(ids, mats, '口令甲', async (id, dk) => {
    put.push([id, dk.saltB64]);
  });

  // 「应该有」：a、c 免输；b 口令不同 ⇒ 老老实实要口令
  assert.deepEqual(r.exempt, ['a', 'c'], '只有自证通过的篇免输');
  assert.deepEqual(r.needPass, ['b'], '口令不同的篇必须进 needPass');
  assert.equal(put.length, 2, 'put 次数必须等于免输篇数（多一次就是给错钥匙了）');
  assert.deepEqual(
    put.map((x) => x[0]),
    ['a', 'c'],
  );
  assert.equal(put[0][1], mats[0].s, 'put 的必须是材料里那把钥匙的派生结果');

  // 🔴 「不应该有」：b 绝不能被 putKey。
  //   这一条是**静默数据丢失的唯一防线** —— 给错钥匙 ⇒ 空编辑器 + 零报错。
  assert.equal(put.some((x) => x[0] === 'b'), false, '口令不同的篇绝不许被写钥匙');

  // 🔴 报数必须与实际 put 一致（恢复卡上要如实报"N 篇已免输"）
  assert.equal(r.exempt.length, put.length, '报数与实际 put 不一致 = 谎报');
});

test('BAK-MAT-05 proveBakMaterials：空口令 / 全无材料 ⇒ 零 put', async () => {
  const ids = ['a', 'b'];
  const mats = [await makeBakMaterial(await deriveKey('口令甲')), await makeBakMaterial(await deriveKey('口令甲'))];

  let n = 0;
  const r1 = await proveBakMaterials(ids, mats, '', async () => {
    n++;
  });
  assert.equal(n, 0, '空口令必须零 put');
  assert.equal(r1.exempt.length, 0);
  assert.deepEqual(r1.needPass, ['a', 'b'], '空口令 ⇒ 全部照常要口令');

  n = 0;
  const r2 = await proveBakMaterials(ids, [null, null], '口令甲', async () => {
    n++;
  });
  assert.equal(n, 0, '全无材料必须零 put');
  assert.deepEqual(r2.exempt, []);
  assert.deepEqual(r2.needPass, ['a', 'b']);
});

test('BAK-MAT-06 端到端：出码装材料 → 编码 → 解码 → 免输', async () => {
  const ids = ['note1', 'note2'];
  const deriveFor = async () => deriveKey('统一口令');

  // 出码侧
  const mats = await collectBakMaterials(ids, deriveFor);
  const text = encodeBakText(ids, 1_700_000_000_000, mats);
  assert.ok(text, '清单应能编码');

  // 中间形态：备份笔记正文 → 解码
  const doc = buildBakDoc(ids, 1_700_000_000_000, mats);
  assert.ok(doc, '应造得出备份笔记真源');
  const back = decodeBakText(doc.blocks[0].text);
  assert.ok(back, '清单应能解码');
  assert.deepEqual(back.ids, ids);
  assert.equal(back.mats.length, 2);
  assert.ok(back.mats[0], '材料应随篇名一起往返');

  // 恢复侧
  const put = [];
  const r = await proveBakMaterials(back.ids, back.mats, '统一口令', async (id) => {
    put.push(id);
  });
  assert.deepEqual(put, ids, '两篇都应免输');
  assert.equal(r.exempt.length, 2);
  assert.equal(r.needPass.length, 0);

  // 🔴 端到端的反向闸：换一个口令 ⇒ 零免输（不是"部分免输"）
  let n = 0;
  const r2 = await proveBakMaterials(back.ids, back.mats, '错误口令', async () => {
    n++;
  });
  assert.equal(n, 0, '口令不对必须零 put');
  assert.deepEqual(r2.needPass, ids);
});

/* ── v4：材料自带各篇自己的口令（用户报障「备份笔记携带各篇自己的口令」）────── */

const BAK_PREFIX = 'notesync-bak:1:';
function manifestJson(text) {
  return Buffer.from(
    text.slice(BAK_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString('utf8');
}

test('BAK-MAT-08 makeBakMaterial 的 p 字段：有口令才写，空/缺省不写', async () => {
  const dk = await deriveKey('口令甲');
  // 「不应该有」：不传 / 空串 ⇒ 不得写 p（那篇恢复时照旧回落备份码口令 + 自证）
  assert.equal((await makeBakMaterial(dk)).p, undefined, '不传口令不得写 p');
  assert.equal((await makeBakMaterial(dk, '')).p, undefined, '空串不得写 p');
  // 「应该有」：传了口令 ⇒ 原样写进 p
  assert.equal((await makeBakMaterial(dk, '口令甲')).p, '口令甲', '传了口令必须写 p');
});

test('BAK-MAT-09 materialPass：材料自带 p 优先，没有才回落（出码/恢复共用）', () => {
  assert.equal(materialPass({ s: 'x'.repeat(8), c: 'y', p: '甲' }, '乙'), '甲', '有 p 必须用 p');
  assert.equal(materialPass({ s: 'x'.repeat(8), c: 'y' }, '乙'), '乙', '无 p 回落');
  assert.equal(materialPass(null, '乙'), '乙', '没材料回落');
  assert.equal(materialPass(undefined, '乙'), '乙', 'undefined 回落');
  assert.equal(materialPass({ s: 'x'.repeat(8), c: 'y', p: '' }, '乙'), '乙', '空 p 视同没有');
});

test('BAK-MAT-10 🔴🔴 v4 端到端：各篇口令不同，材料自带 p ⇒ 恢复**零输入**全免输', async () => {
  // 三篇各设各的口令（正是老项目"装 raw key"能覆盖、而 v3 覆盖不到的场景）
  const ids = ['n1', 'n2', 'n3'];
  const mats = [
    await makeBakMaterial(await deriveKey('口令甲'), '口令甲'),
    await makeBakMaterial(await deriveKey('口令乙'), '口令乙'),
    await makeBakMaterial(await deriveKey('口令丙'), '口令丙'),
  ];

  // 编码升 v4 + p 往返保留
  const text = encodeBakText(ids, 1, mats);
  assert.ok(manifestJson(text).startsWith('{"v":4,'), '材料带 p 必须编 v4');
  const back = decodeBakText(text);
  assert.ok(back, 'v4 必须能解码');
  assert.deepEqual(back.mats.map((m) => m && m.p), ['口令甲', '口令乙', '口令丙'], 'p 必须随材料往返');

  // 恢复：fallback 口令**完全为空**（模拟"记忆解锁进来、sessionPass 为空"）
  //   —— 材料自带 p ⇒ 三篇全部免输。这正是用户诉求的落点。
  const put = [];
  const r = await proveBakMaterials(back.ids, back.mats, '', async (id) => {
    put.push(id);
  });
  assert.deepEqual(r.exempt, ids, '三篇不同口令也必须全部免输');
  assert.deepEqual(r.needPass, [], '不该有需要口令的篇');
  assert.deepEqual(put, ids, '报数必须与实际 put 一致');

  // 🔴🔴 反向闸：把 p 全剥掉 ⇒ 同一批材料在空 fallback 下**全 needPass**。
  //   这条证明"p 是承重的"，而不是"随便怎么都能免输"（恒绿陷阱）。
  const stripped = back.mats.map((m) => ({ s: m.s, c: m.c }));
  let n = 0;
  const r2 = await proveBakMaterials(back.ids, stripped, '', async () => {
    n++;
  });
  assert.equal(n, 0, '没有 p 且 fallback 为空 ⇒ 零 put');
  assert.deepEqual(r2.needPass, ids, '没有 p 就必须逐篇要口令');
});

test('BAK-MAT-11 v4 升档闸：材料带 p ⇒ v4；无 p ⇒ 不得误升 v4', async () => {
  const withP = encodeBakText(['a'], 1, [await makeBakMaterial(await deriveKey('x'), 'p')], null);
  assert.ok(manifestJson(withP).startsWith('{"v":4,'), '有 p 编 v4');
  const noP = encodeBakText(['a'], 1, [await makeBakMaterial(await deriveKey('x'))], null);
  const j2 = manifestJson(noP);
  assert.ok(j2.startsWith('{"v":2,'), '无 p 的材料仍是 v2，不得误升 v4');
  assert.ok(!/,"p":/.test(j2), 'v2 不得写 p 字段');
});

test('BAK-MAT-12 collectBakMaterials 的 passFor 通路：读到就写进材料，抛错不连坐', async () => {
  const ids = ['a', 'b'];
  const deriveFor = async () => deriveKey('统一');
  const mats = await collectBakMaterials(ids, deriveFor, (id) => {
    if (id === 'a') return 'A的口令';
    throw new Error('vault boom'); // 保险箱读失败
  });
  assert.equal(mats[0].p, 'A的口令', '读到的口令必须写进材料');
  assert.ok(mats[0].s, '材料本身照常产出');
  assert.equal(mats[1].p, undefined, 'passFor 抛错的篇不写 p（不连坐）');
  assert.ok(mats[1].s, '抛错也不能让那篇整份没材料');
});

test('BAK-MAT-13 🔴 p 的形状闸：坏 p（非串/空）当没有，不喂进 deriveKey', async () => {
  const dk = await deriveKey('口令甲');
  const mat = await makeBakMaterial(dk, '口令甲');
  // 与生产 encodeBakText 同款：非 ASCII 转 \uXXXX 再 btoa（否则 atob 侧是 Latin-1 乱码）
  const wrap = (p) => {
    const json = JSON.stringify({ v: 4, ts: 1, f: ['a'], m: [{ s: mat.s, c: mat.c, p }], e: [] })
      .replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    return (
      BAK_PREFIX +
      Buffer.from(json, 'latin1').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    );
  };

  for (const bad of [123, null, '', true, {}]) {
    const back = decodeBakText(wrap(bad));
    assert.ok(back, `坏 p=${JSON.stringify(bad)} 不该让整份作废`);
    assert.equal(back.mats[0].p, undefined, `非字符串/空 p=${JSON.stringify(bad)} 必须被丢弃`);
  }
  // 反向闸：合法 p 必须保留（防止"上面几条把实现改成永远丢 p"）
  assert.equal(decodeBakText(wrap('口令甲')).mats[0].p, '口令甲', '合法 p 必须保留');
});

test('BAK-MAT-14 🔴🔴 非 ASCII 口令不得让 encodeBakText 抛（btoa 只吃 Latin-1）', async () => {
  // 回归：v4 起 `p` 是用户口令原样，JSON.stringify 默认不转义非 ASCII
  // ⇒ 直接 btoa 抛 InvalidCharacterError ⇒ 出码整个失败（症状与口令内容无关，极难自查）。
  for (const pass of ['口令甲🔑', 'pässwörd', '😀emoji', '中文口令']) {
    const dk = await deriveKey(pass);
    const text = encodeBakText(['a'], 1, [await makeBakMaterial(dk, pass)], null);
    assert.ok(text, `口令 ${JSON.stringify(pass)} 必须能出码（不得抛）`);
    const back = decodeBakText(text);
    assert.ok(back, `口令 ${JSON.stringify(pass)} 必须能解码`);
    assert.equal(back.mats[0].p, pass, `非 ASCII 口令必须逐字往返（${JSON.stringify(pass)}）`);
    // 真自证通过：派生出的钥匙必须解得出自证块
    assert.ok(await proveBakMaterials(back.ids, back.mats, '', async () => {}).then((r) => r.exempt.length === 1));
  }
});

test('BAK-MAT-15 🔴🔴 回传 effPass：p 自证失败回落到备份码口令成功时，回传备份码口令（不是那个错的 p）', async () => {
  // 病态场景（对抗审 MAJOR）：材料自带 p 与自证块不一致
  //   （多设备 keystore 不同步 / 生成侧 bug）。真钥由「真口令」派生，但 p 写成了「假口令」。
  const dk = await deriveKey('真口令');
  const bad = await makeBakMaterial(dk, '假口令');

  const seen = [];
  const r = await proveBakMaterials(['a'], [bad], '真口令', async (id, _dk, effPass) => {
    seen.push([id, effPass]);
  });
  assert.deepEqual(r.exempt, ['a'], '回落口令能自证 ⇒ 必须免输');
  // 🔴 承重：回传的必须是**真正通过自证**的「真口令」，而不是材料里那个错的 p。
  //   回传错的 p ⇒ 保险箱记错口令 + 凭据派生错 ⇒ 那篇改完存不进服务器（full 档 403）。
  assert.deepEqual(seen, [['a', '真口令']], '回传的必须是实际自证成功的口令');

  // 反向闸 1：p 正确时，回传的就是 p（防"上面改成永远回传 fallback"的假修）
  const good = await makeBakMaterial(await deriveKey('甲口令'), '甲口令');
  const seen2 = [];
  await proveBakMaterials(['a'], [good], '备份码口令', async (id, _dk, effPass) => {
    seen2.push([id, effPass]);
  });
  assert.deepEqual(seen2, [['a', '甲口令']], 'p 正确时必须回传 p');

  // 反向闸 2：p 与回落口令**都**失败 ⇒ 零 put、零回传
  let n = 0;
  const r3 = await proveBakMaterials(['a'], [bad], '又一个错口令', async () => {
    n++;
  });
  assert.equal(n, 0, '两次都失败必须零 put');
  assert.deepEqual(r3.needPass, ['a']);
});

test('BAK-MAT-16 🔴🔴🔴 第二道自证：材料自证通过但钥匙打不开该篇信封 ⇒ 绝不写钥匙', async () => {
  // 该篇真实信封：真钥由「真口令」派生
  const realDk = await deriveKey('真口令');
  const env = await encryptString('正文内容', realDk.key, 'note', realDk);
  // 材料由**另一把错钥匙**自证（p 也写错口令）⇒ 材料自证会通过，但那把钥匙打不开 env。
  //   正是"多设备 keystore 不同步"的形状：材料自洽，却指向一把打不开正文的钥匙。
  const wrongDk = await deriveKey('假口令');
  const mat = await makeBakMaterial(wrongDk, '假口令');

  let n = 0;
  const r = await proveBakMaterials(['n'], [mat], '假口令', async () => {
    n++;
  }, [env]);
  // 「不应该有」：绝不许 putKey（写进去 = 空编辑器 + 零报错 = 静默数据丢失）
  assert.equal(n, 0, '钥匙打不开该篇信封 ⇒ 一篇都不许 putKey');
  assert.deepEqual(r.exempt, [], '不许谎报已免输');
  assert.deepEqual(r.needPass, ['n'], '必须如实计入 needPass');

  // 反向闸 1：真材料 + 真信封 ⇒ 通过（防"上面改成永远 needPass"的假修）
  const goodMat = await makeBakMaterial(realDk, '真口令');
  const put = [];
  const r2 = await proveBakMaterials(['n'], [goodMat], '真口令', async (id) => {
    put.push(id);
  }, [env]);
  assert.deepEqual(put, ['n'], '钥匙解得开信封 ⇒ 必须免输');
  assert.deepEqual(r2.exempt, ['n']);

  // 反向闸 2：不给 envs ⇒ 退回材料自证口径（错钥匙会被豁免）——
  //   钉住"第二道自证确实由 envs 驱动"，而不是碰巧恒绿。
  let n3 = 0;
  await proveBakMaterials(['n'], [mat], '假口令', async () => {
    n3++;
  });
  assert.equal(n3, 1, '不给信封时无可验 ⇒ 退回材料自证口径');
});

/* ── 接线层（main.ts 只做接线，所以这一层只能是源码扫描）─────────────────── */

test('BAK-MAT-W1 接线：出码装材料、恢复才 putKey', async () => {
  const fs = await import('node:fs/promises');
  const url = new URL('../src/main.ts', import.meta.url);
  const main = await fs.readFile(url, 'utf8');

  // 出码侧必须调 collectBakMaterials 并把材料传进 buildBakDoc
  assert.match(main, /collectBakMaterials\(/, 'makeBakBackup 必须为每篇装材料');
  assert.match(main, /buildBakDoc\(entries,\s*now,\s*mats(,\s*envs)?\)/, '材料必须传进 buildBakDoc（不传就还是 v1，恢复端拿不到）');

  // 恢复侧必须调 proveBakMaterials（自证），且必须真写钥匙
  assert.match(main, /proveBakMaterials\(/, 'applyBakRestore 必须走自证，不能只靠 putKey');
  assert.match(main, /putKey\(/, '必须真写钥匙，否则免输只是界面话术');

  // 🔴🔴🔴 本条判据的**承重点**：applyBakRestore 内「先验后写」的顺序。
  //   自证通过才 put 是本设计的全部安全边界，一旦退化成"先 put 再自证"
  //   （或干脆无条件 put），用户就会拿到一把可能错的钥匙，而
  //   `unlockIfRemembered`（sync/unlock.ts:147-149）会拿它当"本机记不记得"
  //   的凭据返回 ok:true ⇒ **空编辑器 + 零报错**。
  //
  //   🔴 为什么用 indexOf 比位置而不用括号解析：
  //   本仓缩进风格统一（2 空格），而**"某语句在不在某块内"的可靠信号是
  //   位置先后**，不是括号配平 —— 手写括号解析器必错（本项目栽过）。
  //   这里要的就是"proveBakMaterials 调用出现在 putKey 之前"这一条。
  const seg = main.slice(main.indexOf('async function applyBakRestore'));
  assert.ok(seg.length > 0, '应能找到 applyBakRestore');
  const iProve = seg.indexOf('proveBakMaterials(');
  const iPut = seg.indexOf('putKey(');
  assert.ok(iProve >= 0, 'applyBakRestore 内必须有自证调用');
  assert.ok(iPut >= 0, 'applyBakRestore 内必须有写钥匙');
  assert.ok(iProve < iPut, '必须先自证再写钥匙（顺序反了 = 静默数据丢失）');

  // 🔴 反向闸：自证的**结果**必须真的驱动写钥匙，而不是算完丢掉。
  //   `proveBakMaterials(...)` 若不接回调，恢复端一篇都不会免输，
  //   而症状是"功能像是没实现"——本地全绿、真机报障，最难查的一种。
  //   🔴 原判据 `/onPutKey|async \(id/` 是**近似恒真**的：`async \(id` 一个什么都不做的
  //   空回调也命中（对抗审 MINOR 修）。改为断言调用段内**真的有 putKey**。
  const callLine = seg.slice(iProve, iProve + 1000);
  assert.match(callLine, /async \(id/, 'proveBakMaterials 必须接上写钥匙的回调');
  assert.match(callLine, /putKey\(/, '回调体内必须真写钥匙，否则免输只是界面话术');
});

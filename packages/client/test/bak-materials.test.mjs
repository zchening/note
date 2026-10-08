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
  const callLine = seg.slice(iProve, iProve + 260);
  assert.match(callLine, /onPutKey|async \(id/, 'proveBakMaterials 必须接上写钥匙的回调');
});

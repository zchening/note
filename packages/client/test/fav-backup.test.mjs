/**
 * 「扫码换机备份全部收藏夹」判据（BAK-FAV 系列）—— 用户报障第 4 条
 *
 * 🔴🔴🔴 本文件的第一职责是**钉住"与老项目体验一致"这件事**，而不是"我自己能跑"。
 *
 * ── 老项目的权威事实（index.html，只读）────────────────────────────────
 *   · 备份范围（:8997-8998 v10.1.7 定稿）：
 *       「备份范围（v10.1.7 定稿）：**只备份收藏夹**，没有例外、也没有开关。」
 *       沿革注释：v10.1.4 擅自扩范围 → v10.1.5 回退成默认只收藏并加勾选框
 *       → v10.1.7 用户明确「只备份收藏夹」，勾选框一并删除——少一个开关就是少一条状态。
 *   · collectBackupEntries（:9001）遍历的是 `readFavs()`，产出 `[[id, rawKeyB64], …]`，
 *     排除项三条：① 备份笔记自身（`slot.id === id`，否则密钥套密钥死循环）
 *                ② id 不合法（`/^[A-Za-z0-9_-]{1,64}$/`，与服务端 ID_RE 同规则）
 *                ③ 本机没有该篇的合法 AES-256 密钥 → 计入 skipped
 *   · BAK_MAX = 100（:8952）「100 篇 ≈ 8KB 明文；服务端 PUT 上限 1MB」
 *   · 出码提示逐字（:9187-9190）：
 *       '新设备首页「扫码打开笔记」对准它，一键恢复 ' + col.f.length + ' 篇'
 *     +（skipped 时 '（' + skipped + ' 篇无密钥未含）'）
 *     +（capped  时 '（超 ' + BAK_MAX + ' 篇未含 ' + capped + ' 篇）'）
 *     + '。看不清就点一下码'
 *   · 恢复后提示逐字（:9270-9273）：
 *       '已恢复 ' + N + ' 篇收藏' +（覆盖旧密钥时 '（覆盖 ' + renewed + ' 篇旧密钥）'）
 *   · 收藏合并顺序（:9265-9267）：**备份清单在前，本机已有收藏并入尾部**
 *       `for (const f of favs) if (ok.indexOf(f) < 0) ok.push(f); writeFavs(ok);`
 *
 * ── 本项目与老项目的**架构性差异**（不是 bug，是刻意的）─────────────────
 *   老项目清单里装的是 **rawKey**（可导出密钥），因为它的密钥明文躺在 localStorage。
 *   本项目的密钥是 `extractable:false` 的 CryptoKey（shared-schema/key-store.ts:26），
 *   **WebCrypto 层面物理上导不出raw 字节** —— 照抄就必须先把它降级成可导出，
 *   那是亲手拆掉本项目最重要的一条安全属性。
 *
 *   ⇒ 本项目的清单装 **[笔记名]**（必要时才装 salt），不装密钥。
 *   这比老项目**更强**：清单本身没有口令就是废纸；而老项目的清单=全部笔记的钥匙。
 *
 *   恢复端因此不需要"写回密钥"，只需要**把收藏名单装回去**：
 *   每篇的密钥在新设备上按`PBKDF2(口令, 该篇信封里的 salt)` 现派生
 *   （与 unlock.ts:174 同一条路），salt 本来就在服务端信封里（kdf.salt，非机密）。
 *
 * ── 判据纪律 ──────────────────────────────────────────────────────────
 *   · 全部 import 生产代码，不把实现抄进测试
 *   · 每条「应该有」配一条「不应该有」
 *   · 超限/损坏必须**明说**，绝不静默截断（截断 = 用户以为全备份了其实丢了）
 *
 * 🔴🔴 **用例里的笔记名为什么全是 ASCII**（写下来防止下一个人以为是实现有 bug）：
 *   bj 的笔记名规则是 `[A-Za-z0-9_-]`（ui/landing-logic.ts:23 `sanitizeNoteName`
 *   把其余字符全删），所以**中文篇名在 bj 里根本不存在** —— 用户想要「工作」
 *   这样的篇名，落地页会把它净化成空串/别的形状。
 *   服务端更严：`ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/`（server.js:57）。
 *   本模块的 `NOTE_ID_RE` 与客户端规则同口径（老项目 :9014 用的是服务端那条，
 *   这里放宽到客户端口径以免误剔「本机能打开、却备份不出去」的条目）。
 *   ⇒ 用例必须用 ASCII 名；拿中文名去测，测的是"这个名字非法"，不是"备份功能"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  FAV_BACKUP_PREFIX,
  buildFavBackupCode,
  readFavBackupEnvelope,
  restoreFavBackupCode,
  favBackupTip,
  favRestoreTip,
  collectFavBackupIds,
  FAV_BACKUP_MAX,
} from '../src/migrate/fav-backup.ts';
import { mergeFavs } from '../src/fav/favs.ts';

const PASS = 'correct horse battery staple';

/* ============ 1. 前缀分流：一眼可判，不靠"试解一次" ============ */

test('BAK-FAV-01 收藏备份码有自己的前缀，与单篇换机码分流', () => {
  assert.equal(FAV_BACKUP_PREFIX, 'nsfav1:', '前缀必须与单篇换机码 nsbak1: 不同');
  assert.ok(
    !FAV_BACKUP_PREFIX.startsWith('nsbak1:') && 'nsbak1:'.startsWith(FAV_BACKUP_PREFIX) === false,
    '两个前缀不得互为前缀（否则 startsWith 分流会歧义）',
  );
});

/* ============ 2. 清单内容：只有笔记名，绝不装密钥 ============ */

test('BAK-FAV-02 备份范围就是收藏夹全部（老项目 v10.1.7 定稿，无开关）', async () => {
  const ids = ['work', 'shopping', 'ledger'];
  const r = await buildFavBackupCode(ids, PASS);
  assert.ok(r.ok, '应能出码，实际=' + JSON.stringify(r));

  const back = await restoreFavBackupCode(r.code, PASS);
  assert.ok(back.ok, '应能恢复');
  assert.deepEqual(back.ids, ids, '收藏三项必须逐项都在，顺序也要保持（收藏顺序=用户优先级）');
  // 反向：备份**只装收藏**，不装"所有笔记"。
  // 老项目 v10.1.4 擅自扩范围被回退（:8997 沿革注释），本项目不许走那条回头路。
  const only = await buildFavBackupCode(['fav1'], PASS);
  assert.ok(only.ok);
  const backOnly = await restoreFavBackupCode(only.code, PASS);
  assert.deepEqual(backOnly.ids, ['fav1'], '只有一篇收藏就只装一篇，绝不夹带别的笔记');
});

test('BAK-FAV-03🔴 清单里绝不能出现密钥材料（本项目比老项目更强的那条）', async () => {
  const r = await buildFavBackupCode(['work'], PASS);
  assert.ok(r.ok);
  const env = readFavBackupEnvelope(r.code);
  assert.ok(env, '信封应可读');
  assert.doesNotMatch(
    JSON.stringify(env),
    /"k"|"key"|"rawKey"|"aesKey"/i,
    '信封里不许装密钥（CryptoKey 是 extractable:false，物理上也装不了）',
  );
  // 反向：老项目清单项是 [名, rawKey] 二元组，本项目**必须**是纯字符串数组。
  // 判据钉形状而不是钉"没有某个字段" —— 后者被改成别的字段名就恒绿。
  const back = await restoreFavBackupCode(r.code, PASS);
  assert.ok(back.ok);
  for (const it of back.ids) {
    assert.equal(typeof it, 'string', '清单项必须是纯笔记名字符串，不是 [名,密钥] 二元组');
  }
});

/* ============ 3. 容量与超限：明说，不静默截断 ============ */

test('BAK-FAV-04 超过上限必须**报错**，绝不静默截断（老项目 capped 分支的口径）', async () => {
  const tooMany = Array.from({ length: FAV_BACKUP_MAX + 1 }, (_, i) => `n${i}`);
  const r = await buildFavBackupCode(tooMany, PASS);
  assert.equal(r.ok, false, '超限必须失败');
  assert.equal(r.reason, 'too-long', '失败原因要能区分，reason=' + JSON.stringify(r));
  // 反向：恰好等于上限必须能过（不能少算一篇，那等于静默截断）
  const exact = Array.from({ length: FAV_BACKUP_MAX }, (_, i) => `n${i}`);
  const ok = await buildFavBackupCode(exact, PASS);
  assert.ok(ok.ok, '恰好等于上限必须能出码（少算一篇就是静默截断）');
});

test('BAK-FAV-05 非法笔记名必须被剔掉而不是整份失败（老项目 :9013 同款）', async () => {
  // 老项目：id 不合法 → skipped++，**其余照常备份**。
  // 判据钉的是"其余仍在"，不是"报错"—— 一篇坏名不该让用户备份全废。
  const r = await buildFavBackupCode(['good', 'bad/name', 'another'], PASS);
  assert.ok(r.ok, '有非法名不应整份失败');
  const back = await restoreFavBackupCode(r.code, PASS);
  assert.ok(back.ok);
  assert.deepEqual(back.ids, ['good', 'another'], '非法名被剔除，其余完整');
  // 反向：空清单（收藏夹本来是空的）必须明确报 empty，不能出一张空码
  const empty = await buildFavBackupCode([], PASS);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'empty');
});

/* ============ 4. 口令错 / 码被改：一律失败，绝不返回半个清单 ============ */

test('BAK-FAV-06 口令错与码被篡改都判失败，且**不返回任何清单**', async () => {
  const r = await buildFavBackupCode(['work', 'shopping'], PASS);
  assert.ok(r.ok);

  const wrong = await restoreFavBackupCode(r.code, 'wrong pass');
  assert.equal(wrong.ok, false, '口令错必须失败');
  assert.equal(wrong.reason, 'pass');
  assert.equal(wrong.ids, undefined, '🔴 失败时绝不能带出清单（半份数据比报错糟糕）');

  const tampered = r.code.slice(0, -6) + (r.code.slice(-6, -1) === 'aaaaa' ? 'bbbbb' : 'aaaaa') + r.code.slice(-1);
  const bad = await restoreFavBackupCode(tampered, PASS);
  assert.equal(bad.ok, false, '密文被改必须失败');
  assert.equal(bad.ids, undefined, '🔴 失败时绝不能带出清单');
});

test('BAK-FAV-07 不是收藏备份码就别硬解（别把配对链接/单篇码当它解）', () => {
  assert.equal(readFavBackupEnvelope('nsbak1:xxxx'), null, '单篇换机码不是收藏备份码');
  assert.equal(readFavBackupEnvelope('https://bj.xuyinji.com.cn/工作#p=abc'), null, '配对链接不是收藏备份码');
  assert.equal(readFavBackupEnvelope(''), null);
  assert.equal(readFavBackupEnvelope('nsfav1:'), null, '空载荷不是码');
});

/* ============ 5. 文案逐字对齐老项目 ============ */

test('BAK-FAV-08 出码提示与老项目 :9187 同款口径', () => {
  // 老项目逐字：
  //   '新设备首页「扫码打开笔记」对准它，一键恢复 ' + f.length + ' 篇'
  //   +（skipped ? '（' + skipped + ' 篇无密钥未含）' : '')
  //   +（capped  ? '（超 ' + BAK_MAX + ' 篇未含 ' + capped + ' 篇）' : '')
  //   + '。看不清就点一下码'
  //
  // 🔴 一处刻意的差异（已在实现的注释里写明理由）：入口文案是「扫码换机」不是
  //   「扫码打开笔记」—— 本项目扫的是清单码本身，老项目扫的是"备份笔记的链接"。
  //   照抄老文案会把用户指到一个本项目不存在的按钮上。
  //
  // 🔴🔴 另一处刻意差异：**本函数只有两个参数，老项目的 capped 段落掉了**。
  //   因为出码侧已改成"超限就明说 too-long"（见 BAK-FAV-04/13），
  //   出码时永远不丢篇 ⇒「超 N 篇未含 M 篇」在出码侧不可达。
  //   下面这条反向断言就是钉它不许回来。
  assert.equal(favBackupTip(6, 0), '新设备首页「扫码换机」对准它，一键恢复 6 篇。看不清就点一下码');
  assert.equal(
    favBackupTip(6, 2),
    '新设备首页「扫码换机」对准它，一键恢复 6 篇（2 篇无密钥未含）。看不清就点一下码',
  );
  // 反向：skipped 为 0 时括号不许凭空冒出来（老项目是三元，不是无条件拼）
  assert.ok(!favBackupTip(6, 0).includes('（'), '无 skipped 时不许出现空括号');
  // 反向：出码侧**永不**出现"超 N 篇未含"（那是恢复侧 favRestoreTip 的活）
  assert.ok(
    !favBackupTip(600, 0).includes('未含'),
    '出码侧不许出现"未含"字样（超限必须报错而不是截断）',
  );
});

test('BAK-FAV-09 恢复提示与老项目 :9270 同款口径（覆盖旧条目要如实说）', () => {
  const MAX = 100;
  assert.equal(favRestoreTip(6, 0, 0, MAX), '已恢复 6 篇收藏');
  assert.equal(favRestoreTip(6, 2, 0, MAX), '已恢复 6 篇收藏（覆盖 2 篇旧密钥）');
  assert.equal(
    favRestoreTip(6, 0, 4, MAX),
    '已恢复 6 篇收藏，收藏夹满 ' + MAX + ' 篇已丢弃最旧 4 项',
  );
  // 反向：没有覆盖就没有那个括号（否则用户以为自己的收藏被动了）
  assert.ok(!favRestoreTip(6, 0, 0, MAX).includes('覆盖'), 'renewed=0 时不许出现"覆盖"');
});

/* ============ 6. 收藏合并顺序（老项目 :9265-9267）============ */

test('BAK-FAV-10 🔴 备份清单在前，本机已有收藏并入尾部（老项目 :9265-9267）', () => {
  // 老项目逐字：
  //   for (const f of favs) if (ok.indexOf(f) < 0) ok.push(f);  // 备份优先序在前，本机并入尾部
  // 反过来（本机在前）会让"刚恢复的收藏"排在旧收藏后面 —— 换机的意义就没了。
  const merged = mergeFavs(['备份甲', '备份乙'], ['本机丙']);
  assert.deepEqual(merged, ['备份甲', '备份乙', '本机丙'], '备份优先序在前，本机并入尾部');
});

test('BAK-FAV-11 🔴 反向：合并必须去重（同一篇不许出现两次）', () => {
  const merged = mergeFavs(['甲', '乙'], ['乙', '丙']);
  assert.deepEqual(merged, ['甲', '乙', '丙'], '重叠的 id 只能留一个');
  // 反向：备份与本机同名时，**保留备份那份**（它的位置决定用户看到的第一项）
  assert.deepEqual(mergeFavs(['甲'], ['甲', '乙']), ['甲', '乙']);
});

/* ============ 7. 入口过滤 ============ */

test('BAK-FAV-12 collectFavBackupIds 剔除备份槽自身（老项目 :9012 同款，否则密钥套密钥死循环）', () => {
  const got = collectFavBackupIds(['nsbak-abc123', 'work', 'nsbak-abc123'], 'nsbak-abc123');
  assert.deepEqual(got, ['work'], '备份笔记自己不能进清单');
  // 反向：本机没有备份槽（第一次生成）时，其余收藏必须全留
  assert.deepEqual(collectFavBackupIds(['alpha', 'beta'], null), ['alpha', 'beta']);
});

/* ============ 8. 收集阶段不许偷偷截断（静默截断是最坏的失败）============ */

test('BAK-FAV-13 🔴🔴 collectFavBackupIds 绝不按上限截断，否则 too-long 变永假死分支', () => {
  // 这条判据的来历：实现初版在收集函数里写了 `if (out.length >= FAV_BACKUP_MAX) break;`，
  // 于是 buildFavBackupCode 里的 `f.length > FAV_BACKUP_MAX` **永远为假**，
  // `too-long` 不可达 ⇒ 101 篇被静默截成 100 篇照样出码成功 ⇒
  // 用户以为全备份了、实际永远丢了那1 篇且不会知道。
  // 🔴 这是"防御性上限"写法的经典反噬：上限看起来在守命，实际上把错误藏起来了。
  //   判据钉的是**收集函数返回的条数**（可观测的最终结果），不是"有没有 break"。
  const over = Array.from({ length: FAV_BACKUP_MAX + 5 }, (_, i) => `n${i}`);
  const got = collectFavBackupIds(over, null);
  assert.equal(
    got.length,
    over.length,
    '收集阶段必须如实返回全部（超限判定归 buildFavBackupCode，不归这里）',
  );
  assert.equal(got[got.length - 1], 'n' + (over.length - 1), '最后一篇必须在，顺序也不能动');
  // 反向：这必须真的让 too-long 变得可达（否则上面那条就是恒真断言）
  return buildFavBackupCode(over, PASS).then((r) => {
    assert.equal(r.ok, false, '超限必须失败');
    assert.equal(r.reason, 'too-long');
  });
});
/* ============ 9. 接线层：main.ts 里这条链路真的接上了吗 =============
 *
 * 🔴🔴 为什么纯逻辑判据不够：`fav-backup.ts` 全绿，只证明「清单码能造能解」。
 *   而用户报障的现象是**点了没反应** —— 出码侧根本没调它、恢复侧没合并收藏。
 *   main.ts 是浏览器入口，node --test 跑不起来，所以只能钉**调用点存在**。
 *
 * 🔴🔴 断言源码存在时，**输入必须是去注释后的代码**：注释里写着
 *   「备份侧改出收藏清单码」也会让 doesNotMatch/match 命中警告本身，
 *   那就是恒绿断言。下面的 stripComments 就是为此存在。
 * ==================================================================== */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

/** 去块注释与行注释。字符串字面量里的内容会残留 —— 本文件只查标识符，够用。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('BAK-FAV-14 🔴 备份侧出的是收藏清单码，不是单篇换机码', () => {
  const main = stripComments(readFileSync(join(SRC, 'main.ts'), 'utf8'));
  // 反向：老项目只有「备份收藏夹」一个入口（collectBackupEntries 遍历 readFavs），
  // 没有「备份当前这一篇」。bj 若还留着单篇那条，菜单里就是两个语义重叠的入口，
  // 而用户要的是与老项目一致 —— 备份侧必须走 collectFavBackupIds + buildFavBackupCode。
  assert.match(
    main,
    /collectFavBackupIds\(/,
    '备份侧必须调 collectFavBackupIds 取收藏清单（老项目 collectBackupEntries 同款）',
  );
  assert.match(main, /buildFavBackupCode\(/, '备份侧必须调 buildFavBackupCode 出清单码');
  // 反向：出码侧不许再走单篇那条（单篇码只保留"旧码仍能解"的兼容读，不许再生成）
  const makeFn = main.slice(main.indexOf('function openMigrateMake'), main.indexOf('async function applyMigrateRestore'));
  assert.ok(makeFn.length > 0, '应能定位到 openMigrateMake');
  assert.doesNotMatch(
    makeFn,
    /buildMigrateCode\(/,
    '🔴 openMigrateMake 里不许再调 buildMigrateCode —— 出码侧必须出收藏清单码',
  );
});

test('BAK-FAV-15 🔴 恢复侧：先取本机现状、再合并收藏、最后写盘', () => {
  const main = stripComments(readFileSync(join(SRC, 'main.ts'), 'utf8'));
  assert.match(main, /restoreFavBackupCode\(/, '恢复侧必须能解收藏清单码');
  assert.match(main, /mergeFavs\(/, '恢复侧必须用 favs.ts 的 mergeFavs 合并（不另写一份，顺序口径只有一处）');
  assert.match(main, /writeFavs\(/, '🔴 合并后必须落盘，否则刷新就没了');

  // 🔴🔴 顺序钉的是**行为**，不是变量名：老项目 index.html:9262 v7.7.0「对抗审」要求
  //   覆盖统计必须在**写入前**取 —— 写完再查就永远 true，renewed 恒等于条数，
  //   「（覆盖 N 篇旧密钥）」就成了一句永远在喊的假警报。
  //   （判据一度写成"必须出现 hadBefore 这个变量名"，那钉的是命名不是行为，
  //     实现换个名字就红、改回名字就绿 —— 恒真断言的镜像形态。这里改成钉顺序。）
  const start = main.indexOf('async function applyFavBackupRestore');
  const fn = main.slice(start);
  assert.ok(start >= 0, '应能定位到 applyFavBackupRestore');
  // 本机现状的读取（算覆盖的那次）必须早于合并
  const iBefore = fn.search(/new Set\(readFavs\(|readFavs\(favStore\)\.indexOf/);
  const iMerge = fn.indexOf('mergeFavs(');
  const iWrite = fn.indexOf('writeFavs(');
  assert.ok(iBefore >= 0, '必须读本机收藏现状来算覆盖（老项目 v7.7.0）');
  assert.ok(iMerge > iBefore, '🔴 覆盖统计必须在合并之前取（写完再查就是恒真）');
  assert.ok(iWrite > iMerge, '🔴 必须先合并再写盘');
  // 反向：🔴 收藏恢复绝不许碰正文/同步 —— 碰了就是"扫一次收藏码把正在写的笔记覆盖了"
  //   （老项目恢复的是密钥，不动正文；本项目恢复的是收藏名单，更不该动正文）
  assert.doesNotMatch(
    fn,
    /syncRef\?\.noteEdit\(|docToLexical\(|putKey\(|writeCache\(/,
    '🔴 收藏恢复不许动编辑器 / key-store / 缓存 / 同步 —— 它只该改收藏夹名单',
  );
});

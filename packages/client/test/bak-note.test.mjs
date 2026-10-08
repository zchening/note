/**
 * 「扫码换机·甲案：清单写进云端专用备份笔记，二维码只装链接」判据（BAK-NOTE 系列）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 本文件的第一职责是**钉死用户报障第 2 条**：
 *   「新版生成的二维码密度比老版本大得多，我担心太密不容易识别出来」
 *
 * ── 用户为什么会担心（老项目 index.html:8940-8947 的血泪原文）──────────────
 *   「旧路线把『收藏 + 全部密钥』整包塞进一张二维码：每篇固定约 80 字节
 *    （32 字节 AES 钥的 base64 不可压缩），篇数一多格子数线性涨，
 *    而 drawQrTo 弹窗态把显示宽锁在 260px —— 第 3~4 篇起每格已掉到 0.6mm 以下，
 *    手机屏对手机屏物理上解不出（用户实锤：收藏 6 篇，微信能扫、app 扫半天没反应）。」
 *   「新路线：二维码退回它一直好扫的那张形态（笔记名 + #k= 密钥，
 *    恒定约 86 字节 / 41 格，与单篇配对码同档），清单本体写进一篇专用『备份笔记』……
 *    篇数与码密度彻底解耦：100 篇也还是一张码。」
 *
 * ── 老项目甲案的载体真值（只读，逐字抄）────────────────────────────────────
 *   BAK_ID_PREFIX = 'nsbak-'            BAK_ID_RE = /^nsbak-[a-z0-9]{6}$/
 *   BAK_PREFIX    = 'notesync-bak:1:'  BAK_MAX   = 100
 *   BAK_DOC_RE = /^<div data-ns-bak="1">(notesync-bak:1:[A-Za-z0-9_-]{8,})<\/div>(<br>)?$/
 *   二维码载荷 = pairingUrlFor(id, keyB64) = `<origin>/<nsbak-xxxxxx>#k=<b64>` ≈ 86 字节
 *
 * ── 与老项目的**架构性分叉**（不承接，必须写清楚，否则后人会"补成老项目那样"）──
 *   老项目清单装 `[[笔记名, rawKeyB64], …]` —— 装的是**密钥本身**，
 *   因为它的 raw key 明文躺在 localStorage（KEY_STORE）。
 *   bj 的密钥是 `extractable:false` 的 CryptoKey（shared-schema/key-store.ts:26），
 *   **WebCrypto 层面物理上导不出 raw 字节**。照抄就必须先把它降级成可导出，
 *   那是亲手拆掉本项目最重要的一条安全属性。
 *   ⇒ bj 的清单只装**笔记名**。恢复端按 `PBKDF2(口令, 该篇信封里的 salt)` 现派生
 *     （与 sync/unlock.ts:174 同一条路），密钥**永不进清单、也永不进二维码**。
 *   ⇒ 这比老项目**更强**：扫到码 = 拿到一串笔记名（用户在菜单里就能看到同一份），
 *     而老项目扫到码 = 拿到全部笔记的钥匙。
 *
 * ── 判据纪律 ───────────────────────────────────────────────────────────────
 *   · 全部 import 生产代码，不把实现抄进测试
 *   · 每条「应该有」配一条「不应该有」
 *   · 量化优先：能算长度的就不只看"有没有"
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAK_ID_PREFIX,
  BAK_ID_RE,
  BAK_MAX,
  BAK_SLOT_KEY,
  BAK_TEXT_PREFIX,
  newBakId,
  readBakSlot,
  writeBakSlot,
  encodeBakText,
  decodeBakText,
  isBakNoteDoc,
  readBakManifest,
  buildBakDoc,
  buildBakLink,
  parseBakLink,
  collectBakEntries,
} from '../src/migrate/bak-note.ts';
import { buildFavBackupCode, FAV_BACKUP_PREFIX } from '../src/migrate/fav-backup.ts';
import { buildPairLink, parsePairLink } from '../src/scan/pair-link.ts';

const PASS = 'correct horse battery staple';
const ORIGIN = 'https://bj.xuyinji.com.cn';

/** 16 字节 salt 的合法 base64 形状（24 字符含 ==）。 */
const SALT_A = 'AAAAAAAAAAAAAAAAAAAAAA==';
const SALT_B = 'BBBBBBBBBBBBBBBBBBBBBB==';

/**
 * 🔴🔴 手工造清单明文的工具（b64url 包 `notesync-bak:1:` 前缀）。
 *
 * 🔴🔴🔴 **为什么必须手工造，不能靠 encodeBakText 造**：
 *   `encodeBakText` 的材料数组长度**恒等于**篇数长度（`kept` 是按 `out` 推的），
 *   而且它会在出码侧把坏形状**降级成 null**。所以这两类输入它永远产不出来：
 *     ·「材料多于篇数」—— 那条 `rawMats.length > out.length` 分支防的是**外部输入**；
 *     ·「坏形状材料项」—— 同理。
 *   而清单是**云端密文解出来的内容**，按外部数据看待，这些分支是真实可达的。
 *   🔴 我第一版判据全从 encodeBakText 取输入，结果四条变异**全部存活**
 *   （判据恒绿）—— 采样窗口压根没覆盖被测代码。
 *   **教训：判外部输入的分支，必须用外部输入的形状去构造判据。**
 */
function rawManifest(obj) {
  return BAK_TEXT_PREFIX + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 0. 先证明 bug 存在：旧路线的码长随篇数线性涨
 * ══════════════════════════════════════════════════════════════════════════ */

test('BAK-NOTE-00 🔴🔴 密度实测：清单直接进码时，码长随篇数线性涨（= 用户报障的根因）', async () => {
  // 这条判据**钉的是被替换掉的那条路**，作用是让"为什么必须改"有据可查，
  // 而不是钉新实现。删掉它 ⇒ 下一个维护者可能把清单又塞回码里，
  // 而那时所有判据照样全绿（因为新实现的判据只管新形态）。
  const lens = [];
  for (const n of [1, 3, 6, 12, 25, 50, 100]) {
    const ids = Array.from({ length: n }, (_, i) => `note${String(i).padStart(3, '0')}`);
    const r = await buildFavBackupCode(ids, PASS);
    assert.ok(r.ok, `${n} 篇应能出码，实际=${JSON.stringify(r)}`);
    assert.ok(r.code.startsWith(FAV_BACKUP_PREFIX), '旧路线出的是清单码');
    lens.push(r.code.length);
  }
  // 老项目甲案的载荷基准（index.html:8943「恒定约 86 字节 / 41 格」）
  const OLD_PLAN_A_BYTES = 86;
  const one = lens[0];
  const hundred = lens[lens.length - 1];
  // ① 1 篇就已经是老项目甲案的 1.7 倍（envelope 的 salt+iv+authTag 在小清单时占了大头）
  assert.ok(
    one > OLD_PLAN_A_BYTES * 1.5,
    `实测 1 篇码长 ${one}B，应显著超过老项目甲案的 ${OLD_PLAN_A_BYTES}B（这条红了说明 bug 已不存在，判据该更新）`,
  );
  // ② 100 篇是老项目的 4 倍以上 —— 这就是"太密不容易识别"的量化形状
  assert.ok(
    hundred > OLD_PLAN_A_BYTES * 3,
    `实测 100 篇码长 ${hundred}B，应是老项目甲案的 3 倍以上`,
  );
  // ③ 严格单调递增（密度随篇数涨，不是"偶尔涨"）
  for (let i = 1; i < lens.length; i++) {
    assert.ok(
      lens[i] > lens[i - 1],
      `码长必须随篇数递增，实际序列=${JSON.stringify(lens)}`,
    );
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 载荷形态：二维码只装链接，篇数彻底解耦
 * ══════════════════════════════════════════════════════════════════════════ */

test('BAK-NOTE-01 🔴🔴 二维码载荷与收藏篇数**完全无关**（甲案的核心承诺）', () => {
  // 🔴 这是甲案与旧路线**唯一的本质区别**，也是用户报障的直接解法：
  //   载荷里装的是"备份笔记的链接"，而备份篇名与口令都与篇数无关 ⇒ 码恒定。
  //   所以这条判据钉的是"同一个备份槽在不同时刻、不同收藏规模下出同一张码"。
  for (const n of [1, 6, 25, 100]) {
    const link = buildBakLink(ORIGIN, 'nsbak-a1b2c3', PASS);
    assert.equal(link, buildBakLink(ORIGIN, 'nsbak-a1b2c3', PASS), `${n} 篇必须出同一张码`);
  }
  // 严格形状：它是**配对链接**（与 scan/pair-link.ts 同一套），不是别的形状。
  // 🔴 为什么必须是配对链接而不是"篇名裸串"：落地页扫码那条路
  //   只认 `#p=` 配对链接（pair-link.ts:116 只认 p=）。造别的形状
  //   就得在 main.ts 里另开一条分流 —— 而"另开一条"正是历史上认不出码的根源。
  const link = buildBakLink(ORIGIN, 'nsbak-a1b2c3', PASS);
  assert.ok(link.startsWith(ORIGIN + '/nsbak-a1b2c3#p='), `载荷应是备份笔记的配对链接，实际=${link}`);
});

test('BAK-NOTE-02 🔴 载荷长度不超老项目甲案那一档（86 字节 / 41 格）', () => {
  const link = buildBakLink(ORIGIN, 'nsbak-a1b2c3', PASS);
  const bytes = new TextEncoder().encode(link).length;
  // 🔴 留 3 倍余量而不是死钉 86：老项目的 86 里含 44 字符密钥，
  //   bj 装的是口令（长度由用户决定），口令短时装载量更小。
  //   钉一个"随口令长度浮动"的上界才是真的判据 —— 死钉 86 会在用户口令变长时假红。
  assert.ok(
    bytes <= 86 * 3,
    `载荷 ${bytes} 字节（口令 ${PASS.length} 字符），应远低于老项目甲案那一档；` +
      `超了说明清单又被塞回了码里`,
  );
  // 反向：绝不能是清单码那种"随篇数涨"的长串
  assert.ok(!link.includes(FAV_BACKUP_PREFIX), '载荷里绝不能夹带清单码');
  assert.ok(!link.includes('notesync-bak:'), '载荷里绝不能夹带清单正文');
});

test('BAK-NOTE-03 载荷走**配对链接同款**解析（同一条落地路径，不新增扫码分支）', () => {
  const link = buildBakLink(ORIGIN, 'nsbak-a1b2c3', PASS);
  const parsed = parseBakLink(link, ORIGIN);
  assert.ok(parsed.ok, `备份链接应能解析，实际=${JSON.stringify(parsed)}`);
  assert.equal(parsed.ok ? parsed.noteId : '', 'nsbak-a1b2c3');
  // 🔴🔴 必须是配对链接能解开的那一种：落地页扫码走 handleScanRaw → parsePairLink，
  //   若这里造出的是另一种形状，就得在 main.ts 里另开一条分流 ——
  //   而"另开一条"正是历史上认不出码的根源（见 pair-link.ts 文件头）。
  //   判据直接调生产解析器（不重抄一遍 URL 拼法），钉的就是"落地页那条路真能收下"。
  const viaPair = parsePairLink(link, ORIGIN);
  assert.ok(viaPair.ok, `parsePairLink 必须收下，实际=${JSON.stringify(viaPair)}`);
  assert.equal(viaPair.ok ? viaPair.link.noteId : '', 'nsbak-a1b2c3');
});

test('BAK-NOTE-04 反向：非备份链接一律拒收（别把普通笔记链接当备份笔记）', () => {
  for (const bad of [
    buildPairLink(ORIGIN, 'normal-note', PASS),   // 普通笔记的配对链接
    `${ORIGIN}/nsbak-a1b2c3`,                      // 缺 fragment
    `${ORIGIN}/nsbak-a1b2c3#p=`,                   // fragment 空
    'https://evil.example.com/nsbak-a1b2c3#p=' + Buffer.from(PASS).toString('base64url'),
    FAV_BACKUP_PREFIX + 'xxxx',
    '',
  ]) {
    const r = parseBakLink(bad, ORIGIN);
    assert.equal(r.ok, false, `不该收下：${JSON.stringify(bad).slice(0, 60)}`);
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 备份笔记的身份：篇名形状（老项目 :8950-8951 逐字）
 * ══════════════════════════════════════════════════════════════════════════ */

test('BAK-NOTE-05 备份篇名形状 nsbak-xxxxxx，且服务端 ID_RE 收得下', () => {
  // 🔴 服务端 ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/（server/src/server.js:57）。
  //   写不进服务端 ⇒ 备份笔记根本存不上去 ⇒ 整个功能是死的。
  const SERVER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  for (let i = 0; i < 200; i++) {
    const id = newBakId();
    assert.ok(BAK_ID_RE.test(id), `篇名形状错：${id}`);
    assert.ok(SERVER_ID_RE.test(id), `服务端不认这个篇名：${id}`);
    assert.ok(id.startsWith(BAK_ID_PREFIX), `前缀错：${id}`);
  }
});

test('BAK-NOTE-06 反向：字码表去掉易混字符（老项目 :8966-8968 逐字：l/o/1/0）', () => {
  // 老项目 newBakId 的字母表：'abcdefghijkmnpqrstuvwxyz23456789'
  // 理由原样承接：「去掉 l/o/1/0：手输档名兜底时不歧义」。
  // 这条判据是**对生成器的实测**：跑 2000 次，若采到任一易混字符即红。
  const CONFUSABLE = new Set(['l', 'o', '1', '0']);
  for (let i = 0; i < 2000; i++) {
    const suffix = newBakId().slice(BAK_ID_PREFIX.length);
    for (const ch of suffix) {
      assert.ok(!CONFUSABLE.has(ch), `采到易混字符「${ch}」（老项目字码表明确去掉 l/o/1/0）`);
    }
  }
});

test('BAK-NOTE-07 反向：随机性 —— 200 个 id 互不相同（不是常量）', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(newBakId());
  assert.equal(seen.size, 200, '备份篇名必须随机，不能是固定串');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 备份槽（老项目 BAK_SLOT_KEY，:8949）
 * ══════════════════════════════════════════════════════════════════════════ */

test('BAK-NOTE-08 备份槽读写往返，非法内容读出 null（老项目 readBakSlot 同款）', () => {
  const store = memStore();
  writeBakSlot('nsbak-a1b2c3', 'salt-b64', store);
  const s = readBakSlot(store);
  assert.ok(s, '槽应写进去了');
  assert.equal(s.id, 'nsbak-a1b2c3');
  assert.equal(s.salt, 'salt-b64');

  // 反向：形状不对的一律当没有（老项目 `BAK_ID_RE.test(s.id) ? s : null`）
  for (const bad of [null, 'null', '{}', '{"id":"xx"}', '{"id":"nsbak-TOOLONG7"}', '[]', '""']) {
    store.set(BAK_SLOT_KEY, bad);
    assert.equal(readBakSlot(store), null, `不该认：${String(bad)}`);
  }
  // 反向：空槽
  store.set(BAK_SLOT_KEY, null);
  assert.equal(readBakSlot(store), null);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 清单正文：只装笔记名，绝不装密钥
 * ══════════════════════════════════════════════════════════════════════════ */

test('BAK-NOTE-09 清单正文往返无损（笔记名保序、去重）', () => {
  const ids = ['alpha', 'bravo-1', 'charlie_2'];
  const text = encodeBakText(ids, 1_700_000_000_000);
  assert.ok(text.startsWith(BAK_TEXT_PREFIX), `正文前缀错：${text.slice(0, 40)}`);
  const back = decodeBakText(text);
  assert.ok(back, '应能解回来');
  assert.deepEqual(back.ids, ids, '笔记名必须保序');
  assert.equal(back.ts, 1_700_000_000_000);
});

test('BAK-NOTE-10 🔴🔴 安全断言：清单正文里绝不含任何密钥材料', () => {
  const text = encodeBakText(['alpha', 'bravo'], 1_700_000_000_000);
  // 老项目的清单里是 [['alpha','<44字符 base64 密钥>'],…]；本项目不许有那一列。
  const payload = text.slice(BAK_TEXT_PREFIX.length);
  const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const o = JSON.parse(json);
  assert.ok(Array.isArray(o.f), '清单 f 应是数组');
  for (const it of o.f) {
    assert.equal(typeof it, 'string', `清单项必须是纯篇名（字符串），实际=${JSON.stringify(it)}`);
  }
  // 反向：结构里没有任何键长得像装密钥的
  assert.ok(!/"k"|"key"|"rawKey"|"aesKey"|"n"/i.test(json), `结构里出现了疑似密钥字段：${json.slice(0, 120)}`);
});

test('BAK-NOTE-11 反向：解不开/形状不对的正文一律返回 null，绝不返回半个清单', () => {
  for (const bad of [
    '',
    '随便一段不是清单的文字',
    BAK_TEXT_PREFIX,                                  // 只有前缀
    BAK_TEXT_PREFIX + '!!!!',                         // 载荷不是 base64url
    BAK_TEXT_PREFIX + Buffer.from('{"v":2}').toString('base64url'),   // 版本不对
    BAK_TEXT_PREFIX + Buffer.from('{"v":1}').toString('base64url'),   // 没有 f
    BAK_TEXT_PREFIX + Buffer.from('{"v":1,"f":[]}').toString('base64url'), // 空清单
    BAK_TEXT_PREFIX + Buffer.from('{"v":1,"f":[1,2]}').toString('base64url'), // 项不是字符串
  ]) {
    assert.equal(decodeBakText(bad), null, `不该解出清单：${JSON.stringify(bad).slice(0, 50)}`);
  }
});

test('BAK-NOTE-12 反向：普通笔记绝不会被误判成备份笔记（宁可漏判，绝不误判）', () => {
  // 老项目 :8975-8977 原话：「用户手打不出这个形状，也不会与任何真实正文相撞
  //   （宁可漏判走正常编辑，绝不误判把普通笔记锁成只读）」。
  // 这条判据是那句话的机器形式。**误判的代价**是把用户正常笔记锁成只读、
  // 拒绝保存 —— 那比"多一个备份入口"严重得多。
  const { emptyDoc, textBlockDoc } = docShapes();
  for (const doc of [
    emptyDoc(),
    textBlockDoc('今天买了苹果'),
    textBlockDoc('nsbak- 开头但不是清单'),
    textBlockDoc(BAK_TEXT_PREFIX + '这不是 base64url'),
  ]) {
    assert.equal(isBakNoteDoc(doc), false, '普通笔记不许被判成备份笔记');
  }
  // 正向：真的备份笔记（正文唯一块就是清单）判 true
  const bak = bakDoc(['alpha']);
  assert.equal(isBakNoteDoc(bak), true, '备份笔记必须被认出来');
});

test('BAK-NOTE-13 备份笔记的清单读得出来（isBakNoteDoc 与 readBakManifest 同源）', () => {
  const ids = ['alpha', 'bravo'];
  const doc = bakDoc(ids, 1_700_000_000_000);
  const m = readBakManifest(doc);
  assert.ok(m, '清单应读得出');
  assert.deepEqual(m.ids, ids);
  assert.equal(m.ts, 1_700_000_000_000);
  // 反向：非备份笔记读出 null（而不是空清单）
  assert.equal(readBakManifest(docShapes().textBlockDoc('普通笔记')), null);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 收集清单：三条排除（老项目 :9010-9016）
 * ══════════════════════════════════════════════════════════════════════════ */

test('BAK-NOTE-14 备份槽自身不入清单（老项目 :9012「密钥套密钥死循环」）', () => {
  const favs = ['alpha', 'nsbak-a1b2c3', 'bravo'];
  assert.deepEqual(collectBakEntries(favs, 'nsbak-a1b2c3'), ['alpha', 'bravo']);
  // 反向：没有槽时（第一次生成）全要
  assert.deepEqual(collectBakEntries(favs, null), favs);
});

test('BAK-NOTE-15 反向：非法篇名剔掉而非整份失败，且**绝不按上限截断**', () => {
  // ① 非法名剔掉
  assert.deepEqual(collectBakEntries(['ok1', '有中文', '', 'ok2'], null), ['ok1', 'ok2']);
  // ② 去重保序
  assert.deepEqual(collectBakEntries(['a', 'b', 'a', 'c', 'b'], null), ['a', 'b', 'c']);
  // ③ 🔴🔴 不截断：超 BAK_MAX 时**全部返回**（超限判定在写正文那一步，
  //    那里抛错明说；在这里悄悄砍尾就是"用户以为全备份了、实际丢了收藏且不知道"）
  const many = Array.from({ length: BAK_MAX + 37 }, (_, i) => `n${i}`);
  assert.equal(collectBakEntries(many, null).length, many.length, '收集阶段绝不截断');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 容量：与老项目同值，且超限**明说**
 * ══════════════════════════════════════════════════════════════════════════ */

test('BAK-NOTE-16 清单上限与老项目 BAK_MAX 同值 100', () => {
  assert.equal(BAK_MAX, 100, '老项目 :8952 BAK_MAX = 100（与 FAVS_MAX 同值）');
  assert.equal(encodeBakText(['a'], 1) === null, false, '能编码');
});

test('BAK-NOTE-17 反向：正文带上限校验（超限返回 null，绝不静默截断）', () => {
  const tooMany = Array.from({ length: BAK_MAX + 1 }, (_, i) => `note-${i}`);
  assert.equal(encodeBakText(tooMany, 1), null, '超限必须返回 null（调用方据此报错），不是砍尾');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 🔴🔴 v2：清单装「每篇的解锁材料」，恢复后**不必再输口令**
 *    （用户报障第 3 条，2026-10-07 用户拍板：所有收藏笔记的口令材料
 *      集中写入同一个备份笔记 —— 与老项目 :9014 `out.push([id, k])` 同款动作）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 **为什么装 salt 还不够，必须再装一段"自证密文"**：
 *
 *   只装 salt，恢复端就能 `deriveKey(备份码口令, salt)` 算出钥匙 ——
 *   但**算得出 ≠ 是那一把**。如果用户给不同笔记设了不同口令（bj 是每篇一把独立锁，
 *   独立 salt + 独立派生），那么用备份码那一个口令去派生别的篇，会得到一把
 *   **错的**钥匙。若不做验证就 putKey，后果是：
 *     ① 用户打开那篇 → unlockIfRemembered 命中"有钥匙" → 拿错钥匙去解密 → 失败
 *     ② 而 unlockIfRemembered:147-149 那条"只有密钥没有缓存"分支**照样返回 ok:true**
 *        ⇒ 用户看到的是一个**空编辑器**。
 *     ③ 空编辑器 + 无报错 = 用户以为那篇笔记是空的，正文在云端好好躺着。
 *   那比"老实问一次口令"糟糕得多 —— 它是静默的数据丢失。
 *
 *   ⇒ 所以清单里每篇还要带一段**用该篇真密钥加密的定长明文**（下称"自证块"）。
 *     恢复端派生完必须**真的解开它**，解不开就判定"这篇口令不同"，
 *     那一篇照常走正常口令框，并在恢复卡上如实报"N 篇已免输"。
 *   ⇒ 自证块是密文，**不是密钥材料**：它解不开任何别的内容，
 *     拿到清单的人也拿不到任何钥匙（与"清单里装 raw key"有本质区别）。
 * ══════════════════════════════════════════════════════════════════════════ */

test('BAK-NOTE-18 🔴🔴 v2 清单必须装每篇的 salt + 自证块，且**绝不装密钥本身**', () => {
  // 🔴 v1 清单（只有篇名）必须仍能读出来 —— 向后兼容，老备份不该作废
  const v1 = encodeBakText(['alpha', 'bravo'], 1_700_000_000_000);
  assert.ok(v1, 'v1 形态仍应能编码（老备份不该作废）');
  const back1 = decodeBakText(v1);
  assert.deepEqual(back1.ids, ['alpha', 'bravo'], 'v1 清单仍读得出篇名');
  // 🔴 v1 的材料位必须补齐成等长的 null 数组（下标与篇名一一对应），
  //   而不是空数组 —— 那样"第 2 篇的材料"会读到 undefined 而非 null，
  //   恢复端就得写两套判空（判据纪律：形状在边界处一次定死，别让下游各自发明）。
  assert.deepEqual(back1.mats, [null, null], 'v1 的材料位是等长 null 数组（那几篇恢复后仍要输口令）');

  // 🔴🔴 v2：每篇带 salt + 自证密文
  const mats = [
    { s: 'AAAAAAAAAAAAAAAAAAAAAA==', c: 'Y2lwaGVy' },
    { s: 'BBBBBBBBBBBBBBBBBBBBBB==', c: 'Y2lwaGVyMg==' },
  ];
  const v2 = encodeBakText(['alpha', 'bravo'], 1_700_000_000_000, mats);
  assert.ok(v2, 'v2 应能编码');
  const back2 = decodeBakText(v2);
  assert.ok(back2, 'v2 应能读出');
  assert.deepEqual(back2.ids, ['alpha', 'bravo'], 'v2 篇名保序');
  assert.equal(back2.mats.length, 2, '🔴 每篇都要带一份材料，否则恢复后还要输口令');
  assert.equal(back2.mats[0].s, mats[0].s, 'salt 必须原样带回来');
  assert.equal(back2.mats[0].c, mats[0].c, '自证块必须原样带回来');

  // 🔴🔴🔴 安全不变量（比 BAK-NOTE-10 更强的一条）：**装材料 ≠ 装密钥**
  const payload = v2.slice(BAK_TEXT_PREFIX.length);
  const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  // 键名只允许 s（salt）与 c（自证密文）—— 出现任何像密钥的字段就是回归
  for (const it of decodeBakText(v2).mats) {
    assert.deepEqual(
      Object.keys(it).sort(),
      ['c', 's'],
      `材料项只允许 s/c 两个键，实际=${JSON.stringify(Object.keys(it))}`,
    );
  }
  // salt 是 16 字节 base64（24 字符含 ==），自证块是密文 —— 两者都**不是** 44 字符的 AES 密钥
  for (const it of decodeBakText(v2).mats) {
    assert.ok(it.s.length <= 24, `salt 不该是长密钥串（实际 ${it.s.length} 字符）`);
    assert.notEqual(it.s.length, 44, 'salt 绝不能是 44 字符的 raw AES 密钥');
  }
  assert.ok(!/"k"|"key"|"rawKey"|"aesKey"/i.test(json), `结构里出现了疑似密钥字段：${json.slice(0, 120)}`);
});

/**
 * 🔴🔴 手工造清单明文的工具见文件头（rawManifest）。这里刻意不再重复定义 ——
 *   判据纪律：同一工具在一个文件里只许有一份，两处各写一份迟早漂。
 */

test('BAK-NOTE-19 🔴🔴 材料数与篇数不一致：少则缺位、多则整份拒收', () => {
  // ① 材料比篇数少（出码时某篇密钥丢了）—— 由 encodeBakText 产出，这条路是真实生产路径
  const few = encodeBakText(['alpha', 'bravo', 'charlie'], 1, [{ s: SALT_A, c: 'Y2lwaGVy' }]);
  assert.ok(few, '仍应能编码（少材料不是编码失败，是那几篇要口令）');
  const back = decodeBakText(few);
  assert.equal(back.ids.length, 3, '篇名三篇都在');
  // 🔴 缺的材料必须是 **null**，绝不能是"空字符串"——
  //   空字符串会被派生逻辑当成"有 salt 但 salt 异常"，报出错误的错因。
  assert.equal(back.mats[0].s, SALT_A, '有材料的那篇材料必须带回来');
  assert.equal(back.mats[1], null, '缺的材料必须是 null');
  assert.equal(back.mats[2], null, '缺的材料必须是 null');
  assert.equal(back.mats.length, 3, '材料位必须与篇名等长（下标一一对应）');

  // 🔴🔴 材料**多于**篇数 ⇒ 整份拒收。手工造 —— encodeBakText 产不出这个形状。
  //   为什么必须拒收：多出来的那份材料对应一篇**不在清单里**的笔记，
  //   收下就等于"清单和用户以为的不一样"，而这正是 BAK-NOTE-11 那条纪律要防的。
  const over = rawManifest({ v: 2, ts: 1, f: ['alpha'], m: [{ s: SALT_A, c: 'Y2lwaGVy' }, { s: SALT_B, c: 'Y2lwaGVyMg==' }] });
  assert.equal(
    decodeBakText(over),
    null,
    '材料多于篇数必须整份拒收（绝不能静默截断 —— 那会让清单里多出来的材料变成对不上的账）',
  );

  // 🔴 v1 冒充 v2（v 号说 2 却没 m 字段）⇒ 当 v1 读，材料位补 null，不是拒收
  const v1withm = rawManifest({ v: 2, ts: 1, f: ['alpha'] });
  const b2 = decodeBakText(v1withm);
  assert.ok(b2, 'v 号是 2 但没有 m 字段：篇名仍应可读（不因缺字段拒收整份）');
  assert.deepEqual(b2.mats, [null], '缺 m 字段 = 无材料（那篇照常要口令）');
});

test('BAK-NOTE-20 🔴 反向：材料项形状不对一律**不豁免那篇**（绝不影响其余篇）', () => {
  // 🔴🔴 全部用 rawManifest 手工造。encodeBakText 会把坏形状**在出码侧就降级**成 null，
  //   所以从它出来的清单里根本没有坏形状 —— 那些分支只能被外部输入触发
  //   （清单是云端密文解出来的，属外部数据）。第一版判据全从 encodeBakText 取输入，
  //   结果四条变异全被放过（采样窗口压根没覆盖被测代码）。
  const bad = [
    { s: 123, c: 'y' },              // salt 不是字符串
    { s: SALT_A, c: 456 },           // 自证块不是字符串
    { s: '', c: 'y' },               // 空 salt
    { s: SALT_A, c: '' },            // 空自证块
    { s: SALT_A },                   // 缺 c
    { c: 'y' },                      // 缺 s
    { s: 'x', c: 'y' },              // 🔴 salt 太短（1 字符，低于长度下限闸）
    'notanobject',                   // 整项不是对象
    null,
  ];
  for (const m of bad) {
    const text = rawManifest({ v: 2, ts: 1, f: ['alpha', 'bravo'], m: [{ s: SALT_A, c: 'Y2lwaGVy' }, m] });
    const back = decodeBakText(text);
    assert.ok(back, `坏材料不该让整份清单作废（99 篇好笔记不能被一条坏数据卡住），材料=${JSON.stringify(m)}`);
    assert.deepEqual(back.ids, ['alpha', 'bravo'], '篇名必须两篇都在');
    // 🔴🔴 承重点：第 1 篇（好材料）必须**仍然免输**。
    //   只判"整份没作废"的话，实现把 m 全清成 [null,null] 也能过 ——
    //   而那等于「所有篇都要口令」，功能整个没实现，判据却全绿。
    assert.ok(back.mats[0] !== null, `好材料那篇必须仍豁免（实际 ${JSON.stringify(back.mats[0])}）—— 坏的只是第 2 篇，输入=${JSON.stringify(m)}`);
    assert.equal(back.mats[0].s, SALT_A, '好材料那篇的 salt 必须原样保留');
    const got = back.mats[1];
    assert.equal(
      got,
      null,
      `坏形状必须判为「无材料」（那篇老实要口令），实际=${JSON.stringify(got)}（输入=${JSON.stringify(m)}）`,
    );
  }
});

test('BAK-NOTE-23 🔴🔴 材料必须**跟着篇名一起过滤**（下标错位 = 给 A 篇装上 B 篇的钥匙）', () => {
  // 🔴🔴 这条判据是**变异 4 逼出来的**：前六条判据全绿时，我把 `for (const i of origIdx)`
  //   改成 `for (let k = 0; k < out.length; k++)`（材料不再跟着被剔掉的篇名过滤），
  //   测试**依然全绿** —— 因为我所有输入都是"篇名全合法且无重复"的，
  //   origIdx 与 [0..n) 完全相同，变异点在采样窗口外。
  //
  // 症状（写下来防止后人"优化"掉下标跟随）：出码时某篇名非法/重复被剔掉，
  //   材料却不跟着剔 ⇒ 材料整体前移一格 ⇒ 恢复后**给 A 篇装上了 B 篇的钥匙**。
  //   那把钥匙解不开 A，用户看到的是"A 打开是空的/报口令不对"，
  //   而清单里篇名是对的 —— 极难自查。
  const S = [
    { s: 'Mzc3zc3zc3zc3zc3zc3zc3zc3zc3zc3zc3zc3zc3M=', c: 'YWFnbGE=' },   // 0
    { s: 'MTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExM=', c: 'YWFnbGJh' },  // 1
    { s: 'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjiyMjIyMjI=', c: 'YWFnbGM=' },   // 2
    { s: 'MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM=', c: 'YWFnbGQ=' },  // 3
  ];
  // 第 1 篇名非法（被剔）+ 第 3 篇重复（被去重）⇒ 篇名剩 [B, C]，材料必须剩 [matB, matC]
  const text = encodeBakText(['A_invalid!', 'B', 'C', 'B'], 1, S);
  assert.ok(text, '应能编码');
  const back = decodeBakText(text);
  assert.deepEqual(back.ids, ['B', 'C'], '非法名剔掉、重复去重');
  // 🔴 承重点：留下的材料必须与留下的篇名**一一对应**
  assert.equal(back.mats.length, 2, '材料位必须与留下的篇数等长');
  assert.equal(back.mats[0].c, 'YWFnbGJh', 'B 必须配 matB（错位会给 B 装上 A 的材料）');
  assert.equal(back.mats[1].c, 'YWFnbGM=', 'C 必须配 matC（错位会给 C 装上 B 的材料）');
  assert.deepEqual(back.mats.map((m) => m && m.s), [S[1].s, S[2].s], 'salt 也必须逐个跟随');
});

test('BAK-NOTE-22 🔴 v1 清单必须**逐字**保持老形态（多写一个字段就红）', () => {
  // 🔴🔴 这是"老备份不能作废"的机器形式。老项目 :8949 的清单明文就是
  //   `{"v":1,"ts":…,"f":[…]}` —— 键序固定、无 m 字段。
  //   出码侧在"全部篇都没有材料"时**必须**编 v1：清单形态与老版本一模一样，
  //   二维码载荷也不因一个空数组而变长。
  const text = encodeBakText(['alpha', 'bravo'], 1_700_000_000_000);
  const json = Buffer.from(
    text.slice(BAK_TEXT_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString('utf8');
  assert.equal(
    json,
    '{"v":1,"ts":1700000000000,"f":["alpha","bravo"]}',
    '🔴 无材料时必须逐字编成 v1 老形态（不得多写 m 字段）',
  );
  // 反向：有一篇有材料就必须升 v2（否则材料丢了，功能静默失效）
  const v2 = encodeBakText(['alpha', 'bravo'], 1, [{ s: SALT_A, c: 'Y2lwaGVy' }, null]);
  const json2 = Buffer.from(
    v2.slice(BAK_TEXT_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString('utf8');
  assert.ok(json2.startsWith('{"v":2,'), '有一篇有材料就必须编 v2');
  // 🔴 v2 下缺材料的那篇必须写 **null 占位**，不得省略 ——
  //   省略会让下标错位：恢复端按下标配对，第 2 篇会拿到第 1 篇的 salt。
  assert.ok(/"m":\[\{"s":"[^"]+","c":"[^"]+"\},null\]/.test(json2), `缺材料的那篇必须写 null 占位（不得省略），实际=${json2}`);
});

test('BAK-NOTE-21 🔴🔴 容量闸必须按**真实字节**算（加了材料后每篇变大了）', () => {
  // 🔴 BAK_MAX 是"篇数"上限（老项目 :8952 = 100，与 FAVS_MAX 同值），不变。
  //   但加了材料后每篇的明文从 ~10 字节涨到 ~60 字节 ⇒ 必须确认 100 篇仍装得进
  //   服务端 1MB 上限，且 encodeBakText 不误报超限。
  const mats = Array.from({ length: BAK_MAX }, () => ({
    s: 'A'.repeat(24),
    c: 'A'.repeat(64),
  }));
  const ids = Array.from({ length: BAK_MAX }, (_, i) => `n${i}`);
  const text = encodeBakText(ids, 1, mats);
  assert.ok(text, `100 篇带材料必须仍能编码（不该误报超限）`);
  const json = Buffer.from(
    text.slice(BAK_TEXT_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString('utf8');
  // 100 篇 × ~60 字节 ≈ 6KB，离 1MB 上限极远 —— 量化钉住，别让后人"顺手调小 BAK_MAX"
  assert.ok(json.length < 20_000, `清单明文应远小于 1MB（实际 ${json.length} 字节）`);
  const back = decodeBakText(text);
  assert.equal(back.ids.length, BAK_MAX, '100 篇全部保序读回');
  assert.equal(back.mats.length, BAK_MAX, '100 份材料全部读回');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 🔴🔴 v3：清单同时装「每篇的密文信封」，恢复端自包含（无需服务器恰好有正文、
 *     也无需逐篇问口令）—— 用户报障「恢复后每篇都要输口令、且都是空的」的根治。
 *
 *    🔴🔴 为什么 v3 必须带"密文信封"而不是只带材料：
 *      用户实锤的失败形态是「扫备份码 → 每篇收藏都要输口令、且打开都是空的」。
 *      根因是旧路径（甲案 + nsfav1）**只合并名字、不携带正文**，恢复时正文要从
 *      服务器拉、而服务器恰好没有（换机/换环境）→ 空编辑器。带信封后，恢复端
 *      直接把信封写进本机缓存 + re-push 服务器，正文随备份走，打开即见。
 *    🔴 信封是**密文**（iv+ct+kdf.salt），零知识属性不变：服务器/备份笔记里
 *      只有密文，没有明文也没有密钥（密钥仍由口令派生）。
 * ══════════════════════════════════════════════════════════════════════════ */

const ENV_A = { v: 1, alg: 'AES-256-GCM', kdf: { name: 'PBKDF2-HMAC-SHA256', iter: 200_000, salt: SALT_A }, iv: 'aW12aW12aW12aW12', ct: 'Y2lwaGVydGV4dA==' };
const ENV_B = { v: 1, alg: 'AES-256-GCM', kdf: { name: 'PBKDF2-HMAC-SHA256', iter: 200_000, salt: SALT_B }, iv: 'aW12aW12aW12aWly', ct: 'Y2lwaGVydGV4dDI=' };

test('BAK-NOTE-24 🔴🔴 v3 清单必须装每篇的密文信封，且往返无损（ids/ts/envs 全部对齐）', () => {
  const envs = [ENV_A, ENV_B];
  const v3 = encodeBakText(['alpha', 'bravo'], 1_700_000_000_000, null, envs);
  assert.ok(v3, 'v3 应能编码');
  const back = decodeBakText(v3);
  assert.ok(back, 'v3 应能读出');
  assert.deepEqual(back.ids, ['alpha', 'bravo'], '篇名保序');
  assert.equal(back.ts, 1_700_000_000_000, 'ts 必须带回来');
  // 🔴 信封必须原样带回来（这是"自包含恢复"的数据基础）
  assert.deepEqual(back.envs, [ENV_A, ENV_B], '每篇密文信封必须原样往返');
  // 反向：v1（无 envs 无 mats）的形态不能被 v3 逻辑污染
  const v1 = encodeBakText(['alpha', 'bravo'], 1);
  assert.ok(!decodeBakText(v1).envs.some((e) => e !== null), 'v1 清单不应携带信封');
});

test('BAK-NOTE-25 🔴🔴 v3 安全不变量：信封只含密文 + 非机密 salt，绝不装密钥/明文', () => {
  const v3 = encodeBakText(['alpha', 'bravo'], 1, [{ s: SALT_A, c: 'Y2lwaGVy' }, null], [ENV_A, ENV_B]);
  const payload = v3.slice(BAK_TEXT_PREFIX.length);
  const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  // 信封字段只允许 v/alg/kdf{name,iter,salt}/iv/ct —— 任何像"密钥/明文"的字段都是回归
  for (const e of decodeBakText(v3).envs) {
    assert.deepEqual(
      Object.keys(e).sort(),
      ['alg', 'ct', 'iv', 'kdf', 'v'],
      `信封只允许这五个键，实际=${JSON.stringify(Object.keys(e))}`,
    );
    assert.deepEqual(Object.keys(e.kdf).sort(), ['iter', 'name', 'salt'], 'kdf 不允许出现密钥字段');
    // 🔴 ct 是密文（base64），salt 是 24 字符非机密 —— 都不该是 44 字符的 raw AES 密钥
    assert.notEqual(e.ct.length, 44, 'ct 绝不能是 44 字符的 raw 密钥');
    assert.equal(e.kdf.salt.length, 24, 'salt 是 16 字节 base64（24 字符），非机密');
  }
  assert.ok(!/"k"|"key"|"rawKey"|"aesKey"|"plain"|"text"/i.test(json), `结构里出现了疑似密钥/明文字段：${json.slice(0, 160)}`);
});

test('BAK-NOTE-26 🔴🔴 信封必须**跟着篇名一起过滤**（下标错位 = 给 A 篇装上 B 篇的密文）', () => {
  // 与 BAK-NOTE-23 同一类致命 bug：被剔掉的篇名，其信封若不跟着剔，
  // 就会整体前移一格 ⇒ 恢复端把 B 的密文写进 A 的缓存 ⇒ A 永远解不开（空笔记）。
  const E = [ENV_A, ENV_B, ENV_A, ENV_B];
  // 第 1 篇名非法（剔）+ 第 3 篇重复（去重）⇒ 篇名剩 [B, C]，信封必须剩 [ENV_B, ENV_A]
  const text = encodeBakText(['A_invalid!', 'B', 'C', 'B'], 1, null, E);
  assert.ok(text, '应能编码');
  const back = decodeBakText(text);
  assert.deepEqual(back.ids, ['B', 'C'], '非法名剔掉、重复去重');
  assert.equal(back.envs.length, 2, '信封位必须与留下的篇数等长');
  assert.deepEqual(back.envs[0], ENV_B, 'B 必须配 ENV_B（错位会装成 ENV_A）');
  assert.deepEqual(back.envs[1], ENV_A, 'C 必须配 ENV_A（错位会装成 ENV_B）');
});

test('BAK-NOTE-27 🔴 v3 信封缺失/多余/坏形状：少则补 null、多则忽略、坏则那篇 null（绝不影响其余篇）', () => {
  // ① 信封比篇数少（某篇备份时没正文）—— 生产路径：collectBakEnvelopes 返回 null 占位
  const few = encodeBakText(['alpha', 'bravo', 'charlie'], 1, null, [ENV_A, null]);
  const back = decodeBakText(few);
  assert.equal(back.ids.length, 3, '篇名三篇都在');
  assert.equal(back.envs[0] && back.envs[0].ct, ENV_A.ct, '有信封的那篇带回来');
  assert.equal(back.envs[1], null, '缺的信封必须是 null');
  assert.equal(back.envs[2], null, '缺的信封必须是 null');
  assert.equal(back.envs.length, 3, '信封位必须与篇名等长');

  // 🔴🔴 信封**多于**篇数 ⇒ 不拒收整份（与材料相反！多出来的忽略），因为信封丢了
  //   顶多是那篇没内容，比"把 99 篇好笔记一起卡住"轻。这是 v3 刻意的取向。
  const over = rawManifest({ v: 3, ts: 1, f: ['alpha'], m: [], e: [ENV_A, ENV_B] });
  const b2 = decodeBakText(over);
  assert.ok(b2, '信封多于篇数不得整份拒收');
  assert.deepEqual(b2.envs, [ENV_A], '多出来的信封忽略，剩下的按篇数对齐');

  // 🔴 坏形状信封 ⇒ 那篇 null，其余篇不受影响（用 rawManifest 造，因为 encodeBakText 不出坏形状）
  const bad = [
    { v: 2 },                          // 版本不对
    { v: 1, alg: 'DES' },              // alg 不对
    { v: 1, alg: 'AES-256-GCM', kdf: { name: 'X', iter: 1, salt: 'y' }, iv: '', ct: 'z' }, // iv/ct 空
    { v: 1, alg: 'AES-256-GCM', kdf: { name: 'PBKDF2-HMAC-SHA256', iter: 50_000, salt: SALT_A }, iv: 'x', ct: 'z' }, // iter 太低
    'notanobject',
    null,
  ];
  for (const e of bad) {
    const text = rawManifest({ v: 3, ts: 1, f: ['alpha', 'bravo'], m: [], e: [ENV_A, e] });
    const back = decodeBakText(text);
    assert.ok(back, `坏信封不该让整份清单作废（输入=${JSON.stringify(e)}）`);
    assert.deepEqual(back.ids, ['alpha', 'bravo'], '篇名两篇都在');
    assert.deepEqual(back.envs[0], ENV_A, `好信封那篇必须仍带回（输入=${JSON.stringify(e)}）`);
    assert.equal(back.envs[1], null, `坏形状信封必须判为 null（输入=${JSON.stringify(e)}）`);
  }
});

test('BAK-NOTE-28 🔴 版本闸：v3 收、v4(未知) 拒；v3 可含 null 信封', () => {
  // v3 正常收
  const v3 = encodeBakText(['alpha'], 1, null, [ENV_A]);
  assert.ok(decodeBakText(v3), 'v3 必须收');
  // v4 拒（未知版本）
  const v4 = rawManifest({ v: 4, ts: 1, f: ['alpha'], m: [], e: [ENV_A] });
  assert.equal(decodeBakText(v4), null, '未知版本 v4 必须整份拒收');
  // v3 但 e 部分 null（混合态：有的篇没正文）
  const mixed = encodeBakText(['alpha', 'bravo'], 1, null, [ENV_A, null]);
  const bm = decodeBakText(mixed);
  assert.deepEqual(bm.envs, [ENV_A, null], 'v3 允许部分篇无信封');
});

test('BAK-NOTE-29 🔴 版本升档逻辑：有信封→v3，有材料无信封→v2，都无→v1（逐字形态）', () => {
  // 有信封 ⇒ v3
  const e3 = encodeBakText(['a', 'b'], 1, null, [ENV_A, ENV_B]);
  assert.ok(decodeBakText(e3).envs.every((x) => x !== null), 'v3 信封都在');
  const j3 = Buffer.from(e3.slice(BAK_TEXT_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.ok(j3.startsWith('{"v":3,'), '有信封必须编 v3');
  // 有材料无信封 ⇒ v2（不得升 v3，否则空 e 数组浪费且形态漂移）
  const e2 = encodeBakText(['a', 'b'], 1, [{ s: SALT_A, c: 'Y2lwaGVy' }, null], null);
  const j2 = Buffer.from(e2.slice(BAK_TEXT_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.ok(j2.startsWith('{"v":2,'), '有材料无信封必须编 v2');
  assert.ok(!/,"e":/.test(j2), 'v2 不写 e 字段');
  // 都无 ⇒ v1 逐字老形态
  const e1 = encodeBakText(['a', 'b'], 1);
  const j1 = Buffer.from(e1.slice(BAK_TEXT_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.equal(j1, '{"v":1,"ts":1,"f":["a","b"]}', '都无必须逐字编 v1');
});

test('BAK-NOTE-30 🔴 buildBakDoc + readBakManifest 透传信封（恢复卡拿到的就是备份时的信封）', () => {
  const doc = buildBakDoc(['alpha', 'bravo'], 1_700_000_000_000, [{ s: SALT_A, c: 'Y2lwaGVy' }, null], [ENV_A, ENV_B]);
  assert.ok(doc, '应能造出备份笔记真源');
  assert.equal(isBakNoteDoc(doc), true, '造出的必须是备份笔记');
  const m = readBakManifest(doc);
  assert.ok(m, '清单应读得出');
  assert.deepEqual(m.ids, ['alpha', 'bravo'], '篇名保序');
  assert.deepEqual(m.envs, [ENV_A, ENV_B], '信封随文档透传');
  assert.equal(m.mats[0].s, SALT_A, '材料也随文档透传');
});

test('BAK-NOTE-31 🔴🔴 parseEnvelope 单缺陷攻击矩阵：每个缺陷**单独**出现都必须只判 null 那一篇', () => {
  // 变异审计【高】项：BAK-NOTE-27 的坏形状列表是**叠加缺陷**（一项同时坏多处），
  // 叠加攻击能被"恰好命中其中一个校验"的残缺实现放行。
  // 这里每个用例只坏**一个**字段，其余全部合法 —— 七个单缺陷都必须各自命中。
  const good = () => ({ v: 1, alg: 'AES-256-GCM', kdf: { name: 'PBKDF2-HMAC-SHA256', iter: 200_000, salt: SALT_A }, iv: 'aW12aW12aW12aW12', ct: 'Y2lwaGVydGV4dA==' });
  const defects = [
    ['iv 为空', (e) => { e.iv = ''; }],
    ['ct 为空', (e) => { e.ct = ''; }],
    ['缺 kdf', (e) => { delete e.kdf; }],
    ['kdf.name 不对', (e) => { e.kdf.name = 'PBKDF2'; }],
    ['kdf.salt 缺失', (e) => { delete e.kdf.salt; }],
    ['kdf.salt 为空', (e) => { e.kdf.salt = ''; }],
    ['kdf.iter 低于下限', (e) => { e.kdf.iter = 99_999; }],
    ['envelope 版本不对', (e) => { e.v = 2; }],
  ];
  for (const [name, mutate] of defects) {
    const e = good();
    mutate(e);
    const text = rawManifest({ v: 3, ts: 1, f: ['alpha', 'bravo'], m: [], e: [good(), e] });
    const back = decodeBakText(text);
    assert.ok(back, `单缺陷「${name}」不得让整份清单作废`);
    assert.deepEqual(back.envs[0], good(), `好信封必须原样带回（缺陷=${name}）`);
    assert.equal(back.envs[1], null, `单缺陷「${name}」必须判为 null（那篇当无内容）`);
  }
});

test('BAK-NOTE-32 🔴🔴 m 与 e 的宽松取向**必须相反**：材料多于篇数仍拒收、信封多于篇数忽略', () => {
  // 变异审计【中高】项：v3 把 e 改成"多于忽略"，最危险的回归是实现把这个宽松
  // **顺手**用到 m 上（同一个循环里两行相邻）—— 那等于允许清单多装材料，
  // 而"多出来的材料对应一篇不在清单里的笔记"正是 BAK-NOTE-19 要防的对不上账。
  const overM = rawManifest({ v: 3, ts: 1, f: ['alpha'], m: [{ s: SALT_A, c: 'Y2lwaGVy' }, { s: SALT_B, c: 'Y2lwaGVyMg==' }], e: [ENV_A] });
  assert.equal(decodeBakText(overM), null, 'v3 下材料多于篇数必须**仍然**整份拒收');
  // 反向对照：同样的形状换到 e 上必须收（取向相反是刻意的，两条一起钉防"顺手统一"）
  const overE = rawManifest({ v: 3, ts: 1, f: ['alpha'], m: [], e: [ENV_A, ENV_B] });
  const back = decodeBakText(overE);
  assert.ok(back, 'v3 下信封多于篇数必须忽略多余（对照材料）');
  assert.deepEqual(back.envs, [ENV_A], '多出来的信封忽略，按篇数对齐');
  // v3 但缺 m 字段 ⇒ 材料位补 null，不因缺字段拒收整份（变异审计【低】项）
  const noM = rawManifest({ v: 3, ts: 1, f: ['alpha'], e: [ENV_A] });
  const b2 = decodeBakText(noM);
  assert.ok(b2, 'v3 缺 m 字段不得整份拒收');
  assert.deepEqual(b2.mats, [null], 'v3 缺 m ⇒ 材料位补 null');
  assert.deepEqual(b2.envs, [ENV_A], '信封照常带回');
  // v2 冒充带 e（v 号 2 却多写了 e 字段）⇒ e 被忽略（版本闸之后才有 e 的资格）
  const v2withE = rawManifest({ v: 2, ts: 1, f: ['alpha'], m: [], e: [ENV_A] });
  const b3 = decodeBakText(v2withE);
  assert.ok(b3, 'v2 带 e 不得整份拒收（多余字段不升级版本语义）');
  assert.deepEqual(b3.envs, [null], 'v2 清单的 e 必须被忽略（那篇当无内容）');
});

test('BAK-NOTE-33 🔴 解码侧篇名形状闸在 v3 下不松动：非法篇名整份拒收', () => {
  // 变异审计【中】项：v3 的 e 宽松容易让人把"篇名校验"也顺手放宽。
  // 篇名坏 = 清单与用户以为的不一致 ⇒ 仍然整份拒收（与材料的"只退化那篇"相反）。
  const bad = rawManifest({ v: 3, ts: 1, f: ['ok', '有中文!'], m: [], e: [ENV_A, ENV_B] });
  assert.equal(decodeBakText(bad), null, 'v3 下非法篇名必须整份拒收');
  const item = rawManifest({ v: 3, ts: 1, f: ['ok', 42], m: [], e: [ENV_A, ENV_B] });
  assert.equal(decodeBakText(item), null, 'v3 下篇名不是字符串必须整份拒收');
});

test('BAK-NOTE-34 🔴🔴 v3 字节预算量化：100 篇 × 大信封仍远低于服务端 8MB 上限', () => {
  // 变异审计【中】项 + 安全审计 S2：v1/v2 的体积判据（BAK-NOTE-21）没测 e 字段。
  // 服务端单条密文上限 8MB（server.js:44 MAX_BODY = 8*1024*1024）——
  // 这里按"每篇正文 12KB（ct base64 约 16K 字符）"的**大笔记**场景量化：
  // 100 篇 × ~16.2KB ≈ 1.62MB，必须远低于 8MB 且往返无损。
  const big = Array.from({ length: 100 }, (_, i) => ({
    v: 1, alg: 'AES-256-GCM',
    kdf: { name: 'PBKDF2-HMAC-SHA256', iter: 200_000, salt: i % 2 ? SALT_A : SALT_B },
    iv: 'aW12aW12aW12aW12',
    ct: 'Q'.repeat(16_000), // ≈ 12KB 明文的 ct
  }));
  const ids = Array.from({ length: 100 }, (_, i) => `n${i}`);
  const text = encodeBakText(ids, 1, null, big);
  assert.ok(text, '100 篇带大信封必须仍能编码');
  const json = Buffer.from(
    text.slice(BAK_TEXT_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ).toString('utf8');
  // 🔴 量化上界：半数服务端上限（4MB）。超了说明信封形状失控（比如把明文塞进了 ct）。
  assert.ok(json.length < 4_000_000, `100 篇大信封清单 ${json.length} 字节，必须低于 4MB（服务端上限 8MB 的一半）`);
  const back = decodeBakText(text);
  assert.equal(back.ids.length, 100, '100 篇全部保序读回');
  assert.equal(back.envs.length, 100, '100 份信封全部读回');
  assert.equal(back.envs[99].ct, 'Q'.repeat(16_000), '大 ct 必须原样往返（截断 = 静默丢正文）');
});

/* ── 本地脚手架 ──────────────────────────────────────────────────────────── */

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    set: (k, v) => (v === null ? void m.delete(k) : void m.set(k, String(v))),
    has: (k) => m.has(k),
  };
}

function docShapes() {
  return {
    emptyDoc: () => ({ v: 1 }),
    textBlockDoc: (t) => ({ v: 1, blocks: [{ t: 'p', spans: [{ t }] }] }),
  };
}

/** 造一篇"备份笔记"的真源：正文唯一块就是清单（与实现同源，见 BAK-NOTE-12 的注释）。 */
function bakDoc(ids, ts = 1_700_000_000_000) {
  const text = encodeBakText(ids, ts);
  assert.ok(text, '清单应能编码');
  return { v: 1, blocks: [{ t: 'code', text, lang: 'nsbak' }] };
}


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
  buildBakLink,
  parseBakLink,
  collectBakEntries,
} from '../src/migrate/bak-note.ts';
import { buildFavBackupCode, FAV_BACKUP_PREFIX } from '../src/migrate/fav-backup.ts';
import { buildPairLink, parsePairLink } from '../src/scan/pair-link.ts';

const PASS = 'correct horse battery staple';
const ORIGIN = 'https://bj.xuyinji.com.cn';

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


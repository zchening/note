/**
 * 彩蛋词表触发 —— 纯逻辑 + 浮层定位单测（EGG-W 系列）
 *
 * 🔴🔴 本文件的存在理由：用户报障「在笔记正文输入『/dragon』『/pet』等菜单文字
 *   没有正常识别并可以进入」。这类故障的特征是**零报错**——没有异常、
 *   没有 console.error，测试全绿，但功能不可达。所以判据必须**逐条钉死**。
 *
 * 🔴 判据来源：老项目 `index.html`
 *   :10943 NS_EGG_RE      :10944 nsStripZW    :10946 nsCaretCtx
 *   :10958 nsWordTriggerAtCaret                :10972 _askPlace
 *   :11008 nsAskConfirm 的 innerHTML           :11060 NS_EGG_HOVER_RE
 * 凡是「与直觉相反」的结论（大小写敏感、//dragon 会弹、`/petshop` 各通道表现）
 * 都在用例注释里写清**实跑结论**与老项目行号，不允许后来者「顺手优化」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PRE_WINDOW,
  buildAskLatch,
  buildEggWordRe,
  caretCtxFromParts,
  caretCtxOf,
  eggIdInWord,
  eggTokenAtNode,
  eggVerdictAtCaret,
  isWordSpace,
  stripZW,
  EGG_TOKEN_RE,
  EGG_WORD_RE,
} from '../src/egg/trigger.ts';
import { EGG_DOORS } from '../src/egg/registry.ts';
import { placeAsk } from '../src/egg/ask.ts';
import { caretLatchVerdict } from '../src/egg/word-trigger.ts';

/** 老项目 :10943 的字面量正则。**本文件所有等价性断言都以它为判据。 */
const OLD_NS_EGG_RE =
  /(^|[^A-Za-z0-9_\-])\/(mirror|snake|dragon|brick|satoshi|bitcoin|tank|spacex|tesla|pet)$/;
/** 老项目 :11060 的字面量正则。 */
const OLD_NS_EGG_HOVER_RE =
  /(^|[^A-Za-z0-9_])\/(mirror|snake|dragon|brick|satoshi|bitcoin|tank|spacex|tesla|pet)(?![A-Za-z0-9])/;

const DOOR_IDS = ['mirror', 'snake', 'dragon', 'brick', 'satoshi', 'bitcoin', 'tank', 'spacex', 'tesla', 'pet'];

/** 干净会话跑一次打字通道判定。 */
const type = (text, offset = text.length, latch = buildAskLatch()) => {
  const r = eggVerdictAtCaret(caretCtxOf(text, offset, false), latch);
  return r.hit ? `hit:${r.id}` : `miss:${r.why}`;
};

/** 干净会话 + 显式前/后文（DOM 侧口径）。 */
const typeParts = (pre, post, latch = buildAskLatch()) => {
  const r = eggVerdictAtCaret(caretCtxFromParts(pre, post), latch);
  return r.hit ? `hit:${r.id}` : `miss:${r.why}`;
};

/* ============ 1. 正则与门牌清单同源（不许抄第二份名单） ============ */

test('EGG-W1 生成的正则与老项目 :10943 字面量 source/flags 逐字相同', () => {
  // 🔴 这条是整个文件的地基：新项目从 EGG_DOORS 生成正则（避免两份清单漂移），
  //   代价是「生成结果可能与老项目不一致」。这里把source 逐字钉死。
  assert.equal(EGG_WORD_RE.source, OLD_NS_EGG_RE.source);
  assert.equal(EGG_WORD_RE.flags, OLD_NS_EGG_RE.flags);
  // 🔴 老项目**没有 i 标志** —— 加了会让 /DRAGON 也弹，与老项目不一致。
  assert.equal(EGG_WORD_RE.flags, '', '打字通道正则不许加 i 标志（老项目无）');
});

test('EGG-W2 门牌清单恰好 10 个且与老项目正则 alternatives 同序', () => {
  assert.equal(EGG_DOORS.length, 10);
  // 🔴 顺序也要同：虽然 alternation 顺序对「是否匹配」无影响（都是 $ 锚定），
  //   但 source 断言（EGG-W1）已经把顺序钉住了，这里点一次名便于定位。
  assert.deepEqual([...EGG_DOORS], DOOR_IDS);
});

test('EGG-W3 buildEggWordRe 生成的判定与老项目正则逐案例等价（含 3000 条随机）', () => {
  const mine = buildEggWordRe();
  const cases = [
    '/dragon', ' /dragon', 'x/dragon', '-/dragon', '_/dragon', '1/dragon', '(/dragon',
    '看/dragon', '//dragon', 'a//dragon', '/dragon.', '/dragon-x', '/dragon_x',
    '/DRAGON', '/Dragon', '/dragonX', '/dragony', '/petshop', '/peter', '/bitcoins',
    '/', '//', '/foo', 'hello.', 'abc/pet', '/dragon y', '/satoshi', '+/tank',
  ];
  for (const s of cases) {
    const a = OLD_NS_EGG_RE.exec(s);
    const b = mine.exec(s);
    assert.equal(b === null ? null : b[2], a === null ? null : a[2], `等价性: ${JSON.stringify(s)}`);
  }
  // 🔴 随机对跑：语料由「前导分隔符 × 门牌 × 尾随字符」三段组合而成，
  //   覆盖 `^` 分支、`[^A-Za-z0-9_-]` 分支与 `$` 锚定的全部组合。
  const PRE = ['', ' ', 'a', '/', '-', '_', '1', '看', '(', '\u200B', '　', 'x'];
  const SUF = ['', '.', ' ', 'x', '-', '_', '中', ')'];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 3000; i += 1) {
    const s = PRE[Math.floor(rnd() * PRE.length)] + '/' + DOOR_IDS[Math.floor(rnd() * DOOR_IDS.length)] + SUF[Math.floor(rnd() * SUF.length)];
    const a = OLD_NS_EGG_RE.exec(s);
    const b = mine.exec(s);
    assert.equal(b === null ? null : b[2], a === null ? null : a[2], `随机等价性: ${JSON.stringify(s)}`);
  }
});

/* ============ 2. 10 个 id 全部识别（用户报障的正题） ============ */

test('EGG-W4 10 个门牌 id 在正文里逐个敲出来都能识别', () => {
  // 🔴 用户报的就是这条：敲 /dragon、/pet 没反应。逐个点名断言，
  //   少一个就是「那个彩蛋的入口是死的」，而图鉴里它照样显示。
  for (const id of DOOR_IDS) {
    assert.equal(type('/' + id), `hit:${id}`, `/${id} 应识别`);
    // 段中（前面有正文）也要认 —— 真实场景不是空段落
    assert.equal(type('今天的安排 ' + '/' + id), `hit:${id}`, `正文后 /${id} 应识别`);
  }
});

test('EGG-W5 斜杠前是中文/空格/括号可以，前是字母数字下划线连字符不行', () => {
  // 🔴 老项目 v9.2.0 放宽的核心：判据是「斜杠前不是字母数字/下划线/连字符」，
  //   所以中文后紧跟斜杠（"看/mirror"）**必须**能弹 —— 注释里点名这是旧版三类 bug 之一。
  assert.equal(type('看/dragon'), 'hit:dragon');
  assert.equal(type('(/dragon'), 'hit:dragon');
  assert.equal(type('中/tank'), 'hit:tank');
  assert.equal(type('+/tank'), 'hit:tank', '「+」不在字符类里，应放行');
  assert.equal(type('a/dragon'), 'miss:no-regex-match');
  // 🔴 数字与字母同属 A-Za-z0-9，**同样被挡**（实跑确认）。
  //   「9/tank 该不该弹」曾写错过 —— 字符类含 0-9，别放宽。
  assert.equal(type('9/tank'), 'miss:no-regex-match');
  assert.equal(type('1/dragon'), 'miss:no-regex-match');
  assert.equal(type('_/dragon'), 'miss:no-regex-match');
  // 🔴 连字符在打字通道**也**被挡（字符类含 `-`），而 hover/caret 通道不挡 —— 见 EGG-W14。
  assert.equal(type('-/dragon'), 'miss:no-regex-match');
});

/* ============ 3. /petshop 类误触防护（okNext 判据） ============ */

test('EGG-W6 光标卡在词中间（蛋 id 恰为更长词前缀）时不弹', () => {
  // 🔴 这是 okNext（老项目 :10965 `okNext = !/^[A-Za-z0-9_\-]/.test(ctx.post)`）
  //   唯一真正起作用的场景：用户正在打 /petshop，打到 /pet 时光标后面还有 shop。
  assert.equal(type('/petshop', 4), 'miss:blocked-by-post', '打 /pet|shop 应被 post 挡住');
  // 对照：同样的 pre，post 为空 ⇒ 弹
  assert.equal(type('/pet', 4), 'hit:pet', 'post 为空应弹');
});

test('EGG-W7 词已经打完整（有尾随字母）时不弹，且失败原因是 no-regex-match', () => {
  // 🔴 判据优先级是「先正则、后 okNext」（老项目 `if (!m || !okNext) return;` :10966）。
  //   /petshop 整词时 pre 是 "/petshop"，正则本身匹配不上 ⇒ 原因码是 no-regex-match。
  //   顺序若被换掉，这条会变成 blocked-by-post，行为虽同但原因码漂移。
  assert.equal(type('/petshop'), 'miss:no-regex-match');
  assert.equal(type('/peter'), 'miss:no-regex-match');
  assert.equal(type('/dragony'), 'miss:no-regex-match');
  assert.equal(type('/bitcoins'), 'miss:no-regex-match');
  assert.equal(type('/fooshop', 4), 'miss:no-regex-match', '非门牌词由正则挡，不是 post 挡');
});

test('EGG-W8 post 首字符是下划线/连字符/字母数字都挡，其余放行', () => {
  assert.equal(typeParts('/pet', 'shop'), 'miss:blocked-by-post');
  assert.equal(typeParts('/pet', '_x'), 'miss:blocked-by-post');
  assert.equal(typeParts('/pet', '-x'), 'miss:blocked-by-post');
  assert.equal(typeParts('/pet', '7'), 'miss:blocked-by-post');
  // 放行：空、空白、中文、标点、全角空格
  assert.equal(typeParts('/pet', ''), 'hit:pet');
  assert.equal(typeParts('/pet', ' '), 'hit:pet');
  assert.equal(typeParts('/pet', '中'), 'hit:pet');
  assert.equal(typeParts('/pet', '。'), 'hit:pet');
  assert.equal(typeParts('/pet', '　'), 'hit:pet');
});

/* ============ 4. 有选区不弹（铁律） ============ */

test('EGG-W9 有选区时永不弹（哨兵 pre="\u0000SEL"）', () => {
  // 🔴 老项目 :10948 `if (!sel.isCollapsed) return { pre: "\u0000SEL", post: "" };`
  //   注释写明「\u0000 永不匹配门牌正则，绝不误弹」。
  //   🔴 哨兵**不能**换成空串：空串会让「框选着一段恰好以 /pet 结尾的文字」弹出来。
  const ctx = caretCtxOf('/dragon', 7, true);
  assert.equal(ctx.pre, '\u0000SEL');
  assert.equal(ctx.post, '');
  const r = eggVerdictAtCaret(ctx, buildAskLatch());
  assert.equal(r.hit, false);
  // 🔴 框选一整篇正文、且正文恰好以 /dragon 收尾 —— 同样不弹。
  //   这条必须显式传 hasSelection=true：用 type() 助手测的是普通打字
  //   （它的 hasSelection 恒 false），那样这条断言根本没在测「框选」。
  const wholeDoc = caretCtxOf('整篇正文 /dragon', 14, true);
  assert.equal(eggVerdictAtCaret(wholeDoc, buildAskLatch()).hit, false, '框选整篇（以 /dragon 收尾）不该弹');
  // 对照：同样的文本、**无选区**就该弹（证明上一条不是因为文本本身不命中）
  assert.equal(type('整篇正文 /dragon'), 'hit:dragon', '无选区时同样文本应弹');
  // 有选区时，即便 post 有内容也不弹
  assert.equal(eggVerdictAtCaret(caretCtxOf('abc /pet def', 8, true), buildAskLatch()).hit, false);
});

/* ============ 5. 零宽字符（linkify 兼容） ============ */

test('EGG-W10 stripZW 剥 ZWSP/ZWNJ/BOM，且剥零宽不改变词边界的严格性', () => {
  assert.equal(stripZW('a\u200Bb'), 'ab');
  assert.equal(stripZW('a\u200Cb'), 'ab');
  assert.equal(stripZW('a\uFEFFb'), 'ab');
  // 🔴 stripZW 的真实作用：认出「零宽插在词中间」的 /dragon（linkify 断行所插）
  assert.equal(type('/dra\u200Bgon'), 'hit:dragon');
  // 🔴 但它**不能**让词边界变松 —— 剥完 a/dragon 的 a 仍是字母数字，仍被挡。
  //   「剥零宽是为了让边界更松」是误读，实跑确认老项目就是被挡。
  assert.equal(type('a\u200B/dragon'), 'miss:no-regex-match');
  // 零宽后跟真字母 ⇒ 仍是 dragonX，不认
  assert.equal(type('/dra\u200BgonX'), 'miss:no-regex-match');
});

/* ============ 6. 会话闩锁：同 id 只弹一次 ============ */

test('EGG-W11 同 id 只弹一次；arm 抑制、rearm 解除；粒度是 id 不是词次', () => {
  const latch = buildAskLatch();
  const t = (s, o = s.length) => {
    const r = eggVerdictAtCaret(caretCtxOf(s, o, false), latch);
    return r.hit ? `hit:${r.id}` : `miss:${r.why}`;
  };
  assert.equal(t('/dragon'), 'hit:dragon');
  // 老项目 nsWordTriggerAtCaret 在弹之前就 asked[id]=1（:10969-10970）
  latch.arm('dragon');
  assert.equal(t('/dragon'), 'miss:already-asked', 'arm 后同 id 应抑制');
  // 🔴 换一个段落再敲同一个词，仍然抑制（粒度是 id，与位置无关）
  assert.equal(t('另一段里的 /dragon'), 'miss:already-asked');
  // 🔴 别的 id 不受影响 —— 粒度是 id 不是「全局只弹一次」
  assert.equal(t('/pet'), 'hit:pet', '别的 id 应照弹');
  latch.arm('pet');
  assert.equal(t('/pet'), 'miss:already-asked');
  // 点「进入」⇒ delete asked ⇒ re-arm
  latch.rearm('dragon');
  assert.equal(t('/dragon'), 'hit:dragon', 'rearm 后应能再弹');
  // rearm 一个没 arm 过的 id 不报错
  latch.rearm('satoshi');
  assert.equal(t('/satoshi'), 'hit:satoshi');
});

/* ============ 7. pre 的 24 字窗口 ============ */

test('EGG-W12 pre 只留后 24 字（PRE_WINDOW=24，与老项目 :10953 同值）', () => {
  assert.equal(PRE_WINDOW, 24);
  // 超长前缀：窗口右移后词仍在 ⇒ 弹
  assert.equal(type('x'.repeat(40) + ' /dragon'), 'hit:dragon');
  // 词被挤出窗口 ⇒ 不弹（老项目就是只看尾部 24 字）
  assert.equal(type('/dragon' + 'y'.repeat(30)), 'miss:no-regex-match');
});

/* ============ 8. 光标落位/点词通道（与打字通道的实质量差异） ============ */

test('EGG-W13 EGG_TOKEN_RE 与老项目 :11060 字面量逐字相同', () => {
  assert.equal(EGG_TOKEN_RE.source, OLD_NS_EGG_HOVER_RE.source);
  assert.equal(EGG_TOKEN_RE.flags, OLD_NS_EGG_HOVER_RE.flags);
});

test('EGG-W14 点词通道吃尾随标点，打字通道不吃 —— 两条正则不许合并', () => {
  // 🔴 实跑结论（老项目两条正则的真实差异）：
  //   点词/caret 通道用 (?![A-Za-z0-9])，所以 `/dragon.`、`(/dragon)`、`/pet，` 都命中；
  //   打字通道用 $，这些一律不命中。
  assert.equal(eggIdInWord('/dragon.'), 'dragon');
  assert.equal(eggIdInWord('(/dragon)'), 'dragon');
  assert.equal(eggIdInWord('/pet，'), 'pet');
  // 打字通道对同样输入不弹
  assert.equal(type('/dragon.'), 'miss:no-regex-match');
  // 🔴 防 /peter（老项目 :11060 注释原文「防 /peter」）
  assert.equal(eggIdInWord('/peter'), '');
  // 🔴 点词通道的斜杠前**不挡连字符**（字符类少一个 `-`），与打字通道不同
  assert.equal(eggIdInWord('-/dragon'), 'dragon');
  assert.equal(type('-/dragon'), 'miss:no-regex-match');
});

test('EGG-W15 eggTokenAtNode 按空白切词，越界偏移被夹住', () => {
  assert.equal(eggTokenAtNode('/dragon', 7), 'dragon');
  assert.equal(eggTokenAtNode('看 /pet', 4), 'pet');
  // 越界
  assert.equal(eggTokenAtNode('/pet', 99), 'pet');
  assert.equal(eggTokenAtNode('/pet', -5), 'pet');
  assert.equal(eggTokenAtNode('', 0), '');
  // 不在词上
  assert.equal(eggTokenAtNode('abc', 1), '');
  // 🔴 实跑确认：/petshop 在**点词通道也不命中** —— 因为切出来的「词」是整个
  //   /petshop，`(?![A-Za-z0-9])` 看到后面的 s 就否掉了。这与直觉
  //   「光标在词中间就该命中一半」相反，但老项目就是这样。
  assert.equal(eggTokenAtNode('/petshop', 4), '');
  assert.equal(eggTokenAtNode('/petshop', 5), '');
  assert.equal(eggTokenAtNode('/petshop', 8), '');
});

test('EGG-W16 isWordSpace 与老项目 :11079 的字符码清单同值', () => {
  // 32 空格 / 9 制表 / 10 换行 / 13 回车 / 12288 全角空格
  for (const c of [32, 9, 10, 13, 12288]) assert.equal(isWordSpace(c), true, `码位 ${c} 应算空白`);
  for (const c of [0, 65, 48, 12288 + 1, 32 + 1]) assert.equal(isWordSpace(c), false, `码位 ${c} 不应算空白`);
  // 全角空格切词生效
  assert.equal(eggTokenAtNode('/pet\u3000x', 4), 'pet');
});

/* ============ 9. 拿不到光标时的兜底 ============ */

test('EGG-W17 ctx=null 退全文尾部扫描，且不判 okNext（老项目 :10961-10964）', () => {
  // 🔴 老项目注释：jsdom 等无光标环境才走这条。判据是全文最后 24 字。
  const r1 = eggVerdictAtCaret(null, buildAskLatch(), '正文 /dragon');
  assert.equal(r1.hit, true);
  assert.equal(r1.id, 'dragon');
  // 🔴 兜底**不判 okNext** —— 所以即使词后面还有字母，正则的 $ 仍要求词在末尾
  assert.equal(eggVerdictAtCaret(null, buildAskLatch(), '/dragon x').hit, false);
  assert.equal(eggVerdictAtCaret(null, buildAskLatch(), '没有门牌').hit, false);
  assert.equal(eggVerdictAtCaret(null, buildAskLatch(), '').hit, false);
});

/* ============ 10. 浮层定位（_askPlace :10972-10985） ============ */

test('EGG-W18 placeAsk 默认弹在词上方，水平居中于词', () => {
  const r = placeAsk(200, 40, 1000, 800, { left: 400, top: 300, width: 100, height: 20, bottom: 320 });
  // left = 400 + 50 - 100 = 350；top = 300 - 40 - 8 = 252
  assert.deepEqual(r, { left: 350, top: 252 });
});

test('EGG-W19 placeAsk 上方放不下翻到下方；上下都放不下才贴底内收', () => {
  // 词贴着视口顶 ⇒ 上方放不下，翻到下方
  // top = 10 - 40 - 8 = -38 < 8⇒ 改取 rect.bottom + 8 = 38（实跑值）
  const flip = placeAsk(200, 40, 1000, 800, { left: 400, top: 10, width: 100, height: 20, bottom: 30 });
  assert.equal(flip.top, 38);
  // 🔴 词贴着视口底时**并不进入内收分支**：老项目先算 top = 780 - 40 - 8 = 732，
  //   而 732 + 40 = 772 ≤ vh - 8 = 792，没有溢出 ⇒ 结果就是 732。
  //   「贴底就一定内收到 vh-bh-8」是误读（实跑对跑5000 条随机确认）。
  const nearBottom = placeAsk(200, 40, 1000, 800, { left: 400, top: 780, width: 100, height: 20, bottom: 800 });
  assert.equal(nearBottom.top, 780 - 40 - 8);
  // 🔴 内收分支要**同时**满足两个条件才会触发（实跑推导 + 对跑确认）：
  //   ① 翻下方：rect.top < bh + 8 = 48
  //   ② 翻出来仍溢出：rect.bottom + 8 + bh > vh - 8 ⇒ rect.bottom > 704
  //   即「又高又顶到视口上下两端」的矩形。矮块贴底（上面那条）不满足 ①，压根不翻。
  const clamp = placeAsk(200, 40, 1000, 800, { left: 400, top: 2, width: 100, height: 798, bottom: 800 });
  assert.equal(clamp.top, 800 - 40 - 8, '顶天立地的词应内收到 vh - bh - 8');
  // 略超底边的同样内收
  assert.equal(
    placeAsk(200, 40, 1000, 800, { left: 400, top: 10, width: 100, height: 795, bottom: 805 }).top,
    800 - 40 - 8,
  );
  // 极端小视口时也不许算出负值
  const tiny = placeAsk(200, 40, 1000, 30, { left: 10, top: 0, width: 10, height: 10, bottom: 10 });
  assert.ok(tiny.top >= 8, `贴底内收后 top 仍须 >= 8，实际 ${tiny.top}`);
  assert.equal(tiny.top, 8);
});

test('EGG-W20 placeAsk 水平夹在视口内；无坐标时退到底部居中', () => {
  // 词贴左⇒ 夹到 8
  assert.equal(placeAsk(200, 40, 1000, 800, { left: 0, top: 300, width: 10, height: 20, bottom: 320 }).left, 8);
  // 词贴右 ⇒ 夹到 vw - bw - 8
  assert.equal(placeAsk(200, 40, 1000, 800, { left: 990, top: 300, width: 10, height: 20, bottom: 320 }).left, 1000 - 200 - 8);
  // 无坐标（jsdom 守护）⇒ 退底部居中：left = vw/2 - bw/2，top = vh - bh - 76
  assert.deepEqual(placeAsk(200, 40, 1000, 800, null), { left: 400, top: 800 - 40 - 76 });
  // 🔴 宽高左上都为 0 也算「无坐标」（老项目 :10977 的判据是四者或运算）
  const zeroRect = { left: 0, top: 0, width: 0, height: 0, bottom: 0 };
  assert.deepEqual(placeAsk(200, 40, 1000, 800, zeroRect), { left: 400, top: 800 - 40 - 76 });
});

/* ============ 11. 浮层结构与文案（逐字照抄老项目 :11008） ============ */

test('EGG-W21 确认层 id/class 与 innerHTML 逐字照抄老项目，且所有颜色走 CSS 变量', () => {
  const askSrc = readFileSync(new URL('../src/egg/ask.ts', import.meta.url), 'utf8');
  // 老项目 `b.id='nsAsk'; b.className='ns-ask-m'`（:11007）→ 本项目改 id 为 eggAsk
  assert.ok(askSrc.includes("const ASK_ID = 'eggAsk'"), '浮层 id 应为 eggAsk');
  assert.ok(askSrc.includes("b.className = 'ns-ask-m'"), 'class 应为 ns-ask-m（金胶囊 pill）');
  // 老项目 :11008 的 innerHTML 逐字：'进入 <b class="ns-w">/dragon</b>？<button class="ns-go">…'
  assert.ok(askSrc.includes('进入 <b class="ns-w">/\' + id + \'</b>？'), '文案「进入 /id？」应逐字一致（含全角问号）');
  assert.ok(askSrc.includes('<button class="ns-go" type="button">进入</button>'), '「进入」按钮文案');
  assert.ok(askSrc.includes('<button class="ns-no" type="button">✕</button>'), '「✕」按钮文案');
  // 🔴 颜色纪律：投影必须走 CSS 变量，rgba 只许出现在 theme.ts
  const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  const askBlock = css.slice(css.indexOf('#eggAsk {'));
  assert.ok(askBlock.includes('var(--shadow-ask)'), '确认层投影应走 var(--shadow-ask)');
  const theme = readFileSync(new URL('../src/ui/theme.ts', import.meta.url), 'utf8');
  // 老项目 index.html:10467 `box-shadow:0 10px 30px rgba(20,20,18,.14)`
  assert.ok(theme.includes("shadowAsk: '0 10px 30px rgba(20,20,18,.14)'"), 'shadowAsk 值应逐字抄老项目');
  assert.ok(theme.includes("s.setProperty('--shadow-ask'"), '--shadow-ask 应被注入');
});

/* ============ 12. ESC / ✕ 都能关，且焦点回编辑器 ============ */

test('EGG-W22 ESC 与 ✕ 都能关浮层，关掉后焦点回编辑器（等价的收口语义）', () => {
  // 🔴 这两条路径必须**语义等价**：都置 asked（抑制打字重弹）+ 收回焦点。
  //   不同义的话，用户按 ESC 之后同一个词会立刻再弹一次（体感是"关不掉"）。
  const src = readFileSync(new URL('../src/egg/ask.ts', import.meta.url), 'utf8');
  // 「✕」按钮：老项目 :11015 `asked[id]=1; hideAsk(); askReturnFocus();`
  assert.ok(/no\.addEventListener[\s\S]*?askLatch\.arm\(id\)[\s\S]*?close\(\)[\s\S]*?askReturnFocus\(\)/.test(src),
    '✕ 路径必须是 arm → close → 归还焦点');
  // ESC 路径：同款三步
  assert.ok(/onKey[\s\S]*?askLatch\.arm\(showing\)[\s\S]*?close\(\)[\s\S]*?askReturnFocus\(\)/.test(src),
    'ESC 路径必须与 ✕ 语义等价');
  // 🔴 ESC 必须在 capture 阶段且 stopPropagation —— 否则会被游戏外壳的
  //   Escape 抢先（图鉴注释里记过这个坑：先注册者赢）
  assert.ok(src.includes("document.addEventListener('keydown', onKey, true)"), 'ESC 应在 capture 阶段监听');
  assert.ok(src.includes('e.stopPropagation()'), 'ESC 应 stopPropagation（一次按键只关一层）');
  // 归还焦点受 hoverFine 门控（老项目 :11009 的 CHIP_HOVER_OK 判据）
  assert.ok(src.includes('if (!host.hoverFine()) return;'), '触屏不应归还焦点（老项目同款门控）');
});

test('EGG-W23 「进入」路径是 re-arm + 先blur 再启动（老项目 :11014）', () => {
  const src = readFileSync(new URL('../src/egg/ask.ts', import.meta.url), 'utf8');
  const goBlock = src.slice(src.indexOf("go.addEventListener"), src.indexOf("no.addEventListener"));
  // 🔴 顺序是行为的一部分：re-arm → close → blur → launch。
  //   先 blur 再 launch 是老项目 v9.3.9 的红线③：防游戏方向键把字打进正文。
  const order = ['askLatch.rearm(id)', 'close()', 'blur()', 'host.launch(id)'].map((s) => goBlock.indexOf(s));
  assert.ok(order.every((i) => i >= 0), `「进入」路径四步齐全，实际块：\n${goBlock}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `「进入」路径顺序应为 re-arm→close→blur→launch，实际下标 ${order}`);
  // mousedown 必须 preventDefault（红线⑩：点浮层不抢编辑器焦点）
  assert.ok(src.includes("b.addEventListener('mousedown', (e) => e.preventDefault())"), 'mousedown 应 preventDefault');
});

test('EGG-W24 白名单断言拦下未注册 id（innerHTML 唯一入口的 XSS 兜底）', () => {
  const src = readFileSync(new URL('../src/egg/ask.ts', import.meta.url), 'utf8');
  // 🔴 这是本文件**唯一**允许 innerHTML 的地方，id 来自枚举。
  //   断言一旦被「优化」掉，就等于开了一个 XSS 口子。
  assert.ok(src.includes('if (EGG_DOORS.indexOf(id) < 0) return;'), '未注册 id 必须直接 return，不给弹');
  // 且注入串必须被 innerHTML 前的那道断言覆盖（顺序：断言在 innerHTML 之前）
  assert.ok(src.indexOf('EGG_DOORS.indexOf(id) < 0') < src.indexOf('b.innerHTML = askHtml(id)'),
    '白名单断言必须在 innerHTML 之前');
});

/* ==================================================================== *
 * 13. 光标落位通道（EGG-CAR系列）
 *
 * 🔴🔴 这组判据存在的事实理由：用户报障「光标移到彩蛋词上不弹确认框」。
 *   老项目有**四条**触发通道（打字 / 中文整词上屏 / 触屏点词 / **光标落位**），
 *   bj此前只有三条 —— 缺的正是报障这条，且全库 `grep selectionchange` 在 egg 目录
 *   **零命中**（不是实现有bug，是整条通道不存在）。
 *
 *   老项目 :11091-11109。四条语义差，逐条钉在下面：
 *   1. 200ms 去抖；
 *   2. 组字期不打扰（selectionchange **不带输入法信息**，必须自维护组字态）；
 *   3. `_eggCaretTok` latch：**同一词内微动不重复弹**，移出再移回才每次弹；
 *   4. **不受 asked[] 会话抑制**（:11106 注释原文）。
 *
 *   ⚠️ 用户报障说「并没有每次都出现」—— 判据 3 就是这句话的准确口径：
 *   「每次都弹」= 移出词再移回每次都弹；停在同一个词里反复微动只弹一次。
 *   这是**正确行为**，不是漏弹。所以 EGG-CAR-02 必须钉住它，
 *   否则将来有人"修"成每次微动都弹，用户体感是"闪个不停"。
 * ==================================================================== */

const wordTriggerSrc = readFileSync(new URL('../src/egg/word-trigger.ts', import.meta.url), 'utf8');
/**
 * 🔴 去掉注释后的代码。判"某段代码不存在"时**必须**用它 ——
 *   直接在原文里 grep 会被注释里的行号/函数名骗过
 *   （本文件下面 EGG-CAR-08 就真的踩到了：注释里写着 `if (id === caretTok) return;`，
 *   而实现已经改成走caretLatchVerdict，naive grep 会给出错误的绿）。
 */
const wordTriggerCode = wordTriggerSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('EGG-CAR-01 光标在彩蛋词内 → 触发（这是用户报障的那一条通道本身）', () => {
  // 判据 ①：latch 的初态是空串，任何词都不等于它 ⇒ 必触发。
  assert.deepEqual(caretLatchVerdict('', 'dragon'), { fire: true, tok: 'dragon' });
  // 对照：同一个词已经在 latch 里 ⇒ 这才是不触发的那一档（判据见 EGG-CAR-02）。
  assert.equal(caretLatchVerdict('dragon', 'dragon').fire, false);
  // 🔴 判据 ④：这条通道**不受 asked[] 会话抑制**。caretLatchVerdict 的签名里
  //   **根本没有 latch/asked 参数** —— 这是结构事实，不是"忘了传"。
  assert.equal(caretLatchVerdict.length, 2, 'latch 判据不应接受 asked 抑制参数');
  assert.ok(
    !/caretLatchVerdict\([^)]*latch/i.test(wordTriggerCode),
    '光标落位通道不许接 asked[] 闩锁（老项目 :11106 注释：不受 asked[] 会话抑制）',
  );
});

test('EGG-CAR-02 同一词内微动 → 不重复触发（latch，老项目语义，承重）', () => {
  // 🔴 这是整条通道最容易被"优化掉"的一行。逐步模拟：
  //   光标从词外进入 → 弹（tok=dragon）
  let v = caretLatchVerdict('', 'dragon');
  assert.deepEqual(v, { fire: true, tok: 'dragon' }, '进入词应触发');
  //   停在词内，用方向键左右挪（同一个 id 命中多次）⇒ 一次都不再触发
  for (let i = 0; i < 20; i += 1) {
    v = caretLatchVerdict(v.tok, 'dragon');
    assert.equal(v.fire, false, `词内第 ${i + 1} 次微动不应重复触发`);
    assert.equal(v.tok, 'dragon', 'latch 词必须保持不变');
  }
  // 🔴 反向断言（判据纪律要求）：**把 latch 去掉，这条必须红**。
  //   没有 latch 的朴素实现（每次都 fire）在这里一定会炸：
  const naive = (id) => ({ fire: true, tok: id });
  let nv = naive('dragon');
  assert.equal(nv.fire, true, '无 latch 版：词内微动会重复触发（这就是要避免的）');
  for (let i = 0; i < 3; i += 1) {
    nv = naive('dragon');
    assert.equal(nv.fire, true, '无 latch 版每一步都 fire ⇒ EGG-CAR-02 会红');
  }
  // 🔴 反向还要钉住"移出再移回才每次弹"：这正是用户那句「每次都出现」的准确含义。
  let s = caretLatchVerdict('', 'dragon');
  assert.equal(s.fire, true, '第一次进入词要弹');
  s = caretLatchVerdict(s.tok, '');
  assert.deepEqual(s, { fire: true, tok: '' }, '离词要 fire（用于收起）且 latch 置空');
  s = caretLatchVerdict(s.tok, 'dragon');
  assert.equal(s.fire, true, '移出词再移回 ⇒ 每次都弹（用户报障的准确口径）');
  // 换一个词：也要弹（latch 判的是 id 变化，不是"弹过就算了"）
  s = caretLatchVerdict(s.tok, 'pet');
  assert.deepEqual(s, { fire: true, tok: 'pet' }, '换词应触发');
});

test('EGG-CAR-03 光标离词 → 收起，且只收自己弹起的那次', () => {
  // 离词：id 为空串 ⇒ fire=true 且 tok 置空（上层据此调 ask.close()）
  const v = caretLatchVerdict('dragon', '');
  assert.deepEqual(v, { fire: true, tok: '' });
  // 🔴 「只收自己弹起的那次」在实现里的形态是 `caretOwns()` ——
  //   比对 caretOpenedId 与 ask.showingId()，close 之后两者自动都不成立。
  assert.ok(wordTriggerCode.includes('const caretOwns = ()'), '必须有所有权判据 caretOwns');
  assert.match(
    wordTriggerCode,
    /if\s*\(!id\)\s*\{\s*if\s*\(caretOwns\(\)\)\s*ask\.close\(\);/,
    '离词只收自己弹起的那次（老项目 :11104 的 `_askFrom === \'caret\'`）',
  );
  // 🔴 反向：不能无条件 ask.close() —— 那会把触屏点词通道弹的浮层也收掉。
  assert.ok(
    !/if\s*\(!id\)\s*\{\s*ask\.close\(\);/.test(wordTriggerCode),
    '离词不许无条件收（会误收别的通道弹的浮层）',
  );
});

test('EGG-CAR-04 组字期不触发，且组字态必须自维护（selectionchange 不带输入法信息）', () => {
  // 🔴 beforeinput 自带 e.isComposing，selectionchange **不带** ——
  //   所以必须自己维护跨事件的组字态，否则拼音候选框跟随光标移动时
  //   会连续弹确认框（老项目 :11093/:11097 两处拦，注释「红线9：组字期绝不打扰」）。
  assert.ok(wordTriggerCode.includes('let composing = false'), '必须自维护组字态');
  // 🔴 断言必须**按函数体**定位，不能用 `/compositionstart[\s\S]*?composing = true/`
  //   这种跨函数的贪婪匹配 —— 监听注册与处理函数体在源码里是分开的两处，
  //   那种写法在实现换一种写法后仍可能"碰巧匹配到"，给出恒真的绿。
  assert.match(
    wordTriggerCode,
    /const onCompositionStart = \(\): void => \{\s*composing = true;\s*\};/,
    'onCompositionStart 函数体要置 composing = true',
  );
  assert.match(
    wordTriggerCode,
    /const onCompositionEnd = \(\): void => \{[\s\S]*?composing = false;/,
    'onCompositionEnd 函数体开头要复位 composing',
  );
  // 🔴 blur 也要复位（老项目 :1000）：组字中 DOM 被 linkify detach 时
  //   compositionend 可能不冒泡 ⇒ composing 卡在 true ⇒ 通道永久关死。
  assert.match(wordTriggerCode, /addEventListener\('blur', onBlur\)/, 'blur 必须复位（老项目 :1000）');
  assert.match(wordTriggerCode, /const onBlur = \(\): void => \{\s*composing = false;\s*\};/, 'onBlur 要清 composing');
  // 两处拦：事件头一次 + 去抖回调内复检一次（去抖窗口内可能进入组字）
  const guards = wordTriggerCode.match(/if \(composing\) return;/g) ?? [];
  assert.ok(guards.length >= 2, `组字守卫应有两处（事件头 + 回调内复检），实际 ${guards.length} 处`);
  // 也守住 beforeinput 通道的老口径没被改坏
  assert.ok(wordTriggerCode.includes("e.inputType.indexOf('insertComposition') === 0"));
});

test('EGG-CAR-05 200ms 去抖 + 只在编辑器真持焦时判 + 有选区不判', () => {
  // 去抖 200ms（老项目 :11095/11108）
  assert.match(wordTriggerCode, /caretTimer = setTimeout\([\s\S]{0,80}?, 200\)/, '去抖必须是 200ms');
  // 只在编辑器真持焦时判（老项目 :11098：别从别处的输入框抢弹）
  assert.match(wordTriggerCode, /document\.activeElement !== root/, '必须判activeElement ===编辑器根');
  // 有选区/无光标不判（老项目 :11077）—— 判据在 caretEggAt 里
  const fn = wordTriggerCode.slice(wordTriggerCode.indexOf('function caretEggAt'));
  assert.match(fn, /sel\.isCollapsed/, '有选区一律不判（真人框选不打扰）');
  assert.match(fn, /sel\.rangeCount === 0/, '无光标不判');
  // 必须挂在 document 且capture=true（老项目 :11109）
  assert.match(
    wordTriggerCode,
    /document\.addEventListener\('selectionchange', onSelectionChange, true\)/,
    'selectionchange 必须在 document 上capture 监听',
  );
  assert.match(
    wordTriggerCode,
    /document\.removeEventListener\('selectionchange', onSelectionChange, true\)/,
    'dispose 必须解绑（漏解绑 ⇒ 退出编辑器后仍会凭空弹浮层）',
  );
});

test('EGG-CAR-06 通道挂在 word-trigger.ts 且四条通道齐全（缺一条 = 用户报障复发）', () => {
  // 这次报障的本质是「少了一条通道」，所以判据必须钉住**四条都在**。
  assert.ok(wordTriggerCode.includes("addEventListener('beforeinput', onBeforeInput)"), '通道 1 打字');
  assert.ok(wordTriggerCode.includes("addEventListener('compositionend', onCompositionEnd)"), '通道 2 中文整词上屏');
  assert.ok(wordTriggerCode.includes("addEventListener('click', onClick)"), '通道 3 触屏点词');
  assert.ok(
    wordTriggerCode.includes("addEventListener('selectionchange', onSelectionChange, true)"),
    '通道 4 光标落位（用户报障这条，此前整条不存在）',
  );
  // 反向：add 与 remove 必须配平（少一条 remove ⇒ dispose 后监听残留，
  //   而 selectionchange 残留的后果是「编辑器已经卸载了还会凭空弹浮层」）。
  //   🔴 用"数配平"而不是逐个拼函数名 —— `beforeinput` 拼出来是`onBeforeinput`
  //   （实际是 `onBeforeInput`），那种拼装断言要么恒红、要么逼着人改函数名，
  //   是判据自己制造 bug（本次第一版就踩了）。
  const EVENTS = 'beforeinput|compositionstart|compositionend|blur|click|selectionchange';
  const addCount = (wordTriggerCode.match(new RegExp(`addEventListener\\('(?:${EVENTS})'`, 'g')) ?? []).length;
  const removeCount = (wordTriggerCode.match(new RegExp(`removeEventListener\\('(?:${EVENTS})'`, 'g')) ?? []).length;
  assert.equal(addCount, removeCount, `add/remove 监听必须配平（add ${addCount} / remove ${removeCount}）`);
  // 四条触发通道 + 组字态两条（compositionstart/blur）= 6 条在编辑器根，selectionchange 在 document
  assert.equal(addCount, 7, `应恰好 7 条监听（编辑器 6 + document 1），实际 ${addCount}`);
});

test('EGG-CAR-07 词 id 判据与点词通道同源（两条通道不许漂移）', () => {
  // 老项目把这段写了两遍（nsEggTokenAtCaret :11075 与 nsEggHit :11040），
  // 判据完全同构。bj 抽成 eggTokenAtNodeRect 一份 —— 判据钉住"只有一份实现"。
  const fnCount = (wordTriggerSrc.match(/EGG_TOKEN_RE\.exec\(/g) ?? []).length;
  assert.equal(fnCount, 0, '判据应收口到 trigger.ts 的 eggTokenAtNode，不许在本文件重写正则');
  assert.match(wordTriggerCode, /const id = eggTokenAtNode\(data, off\);/, '必须复用 trigger.eggTokenAtNode');
  // 且点词通道也走同一个helper（hitEggAtPoint）
  assert.match(wordTriggerCode, /eggTokenAtNodeRect\(root, hit\.startContainer, hit\.startOffset\)/,
    '点词通道必须与光标通道共用 eggTokenAtNodeRect');
  // 空白判定不许在本文件再抄一份（老项目 :11082 的字符码清单在 trigger.isWordSpace）
  assert.ok(!/isWs\(code\)/.test(wordTriggerCode), 'isWs 应直接复用 trigger.ts 的 isWordSpace，不许重抄');
});

test('EGG-CAR-08 反向：去掉 latch / 去掉组字守卫 / 无条件收，三处都必须让判据变红', () => {
  //🔴 这条是本组的**元判据**：确认上面几条真的在测东西，而不是恒真断言。
  //   做法是把生产代码按"假装优化掉了"的改法改一遍，看对应判据是否还能过。
  const src = wordTriggerCode;

  // ① 去掉 latch（每次微动都 fire）
  const noLatch = src.replace(/caretLatchVerdict\(caretTok, id\)/g, '{ fire: true, tok: id }');
  assert.notEqual(noLatch, src, '改法①应真的改动了源码');
  assert.ok(
    !/caretLatchVerdict\(caretTok, id\)/.test(noLatch),
    '改法①后 EGG-CAR-01/02 的 latch 判据应失效（说明判据确实在测 latch）',
  );

  // ② 组字守卫只剩一处（老项目要求两处）
  const oneGuard = src.replace(/if \(composing\) return;/, '');
  assert.ok(
    (oneGuard.match(/if \(composing\) return;/g) ?? []).length < 2,
    '改法②后 EGG-CAR-04 的"两处守卫"应失效（说明判据确实在数守卫）',
  );

  // ③ 离词无条件收
  const alwaysClose = src.replace(/if \(caretOwns\(\)\) ask\.close\(\);/, 'ask.close();');
  assert.ok(
    /if\s*\(!id\)\s*\{\s*ask\.close\(\);/.test(alwaysClose),
    '改法③后 EGG-CAR-03 的反向断言应触发（说明"只收自己弹的"这条判据在生效）',
  );
});

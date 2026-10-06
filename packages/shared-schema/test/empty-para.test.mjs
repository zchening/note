/**
 * 空段落进真源（用户拍板方案A）—— **新不变量**，与 core.test.mjs 的六条并列。
 *
 * 🔴🔴 为什么这条要单开文件而不是往 core.test.mjs 里加：
 *   它改的是**既定架构不变量**（canonical 递归剔除空段落），
 *   牵动的不只是"能不能存"，而是下面这四条会一起松动：
 *     ① canonical 幂等（多轮normalize 逐字节不变）
 *     ② 往返无损（同一内容只有一种合法字节 ⇒ 空段落必须只有**一种**形态）
 *     ③ 归一幂等（normalize(normalize(d)) === normalize(d)）
 *     ④ 合并语义（blockSig 对空段落必须稳定，否则两台设备会误判"这段变了"）
 *   放在core.test.mjs 里会被那30 条既有断言淹没；单开文件是为了
 *   "这条不变量一旦被谁悄悄推翻，能一眼看出是哪一条"。
 *
 * 🔴 老项目为什么需要这个：老项目真源是 DOM，空行就是 `<p><br></p>`，天然进真源。
 *   bj 真源是模型 JSON，原设计按"空段落是编辑器占位、不该进真源"把它剔掉了 ——
 *   于是「A / 空行 / B」复制出来变成「A / B」，**同步过去也丢空行**（用户报障）。
 *   代价是那份不变量的注释里写着的所有顾虑（相邻列表合并、往返、冲突判定）必须重新验证。
 *
 * 判据纪律：**每条"应该保留"的断言都必须同时配一条"不该多出来"的反向断言**。
 *   只钉"空段落保住了"会把"连标题的空壳、列表项的空壳都保住了"这种过度实现放过去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  canonicalize,
  parseDoc,
  normalize,
  isValidDoc,
  blockSig,
  mergeDocs,
  emptyDoc,
} from '../src/index.ts';

const P = (t) => ({ t: 'p', spans: [{ t }] });
const EMPTY_P = { t: 'p' };

/**
 * 取块数组。🔴 两个必须记住的事实，我第一版都踩了：
 *   1. `canonicalize(d)` 返回的是**字符串**（canonical JSON 字节），不是对象。
 *      判据里要 `JSON.parse(canonicalize(d))` 才是对象 —— 我第一版直接把返回值
 *      当对象用，于是每条判据都报 `Cannot read properties of undefined` /
 *      `顶层必须是对象`，**16 条红全是判据自己的 bug**。判据自己红等于没判据。
 *   2. blocks 键**可能整体不存在**（空文档走 `{"v":1}`，canonical 规则 2 不留空数组键）
 *      ⇒ 不能直接 `out.blocks.length`。
 */
const blocksOf = (d) => d.blocks ?? [];
/** canonicalize → 解析回对象。 */
const canonObj = (d) => JSON.parse(canonicalize(d));

/* ============ 1. 基本形态：空段落必须留在真源里 ============ */

test('空段落-01 三段夹一个空段落，空段落必须留在真源里', () => {
  const doc = { v: 1, blocks: [P('A'), EMPTY_P, P('B')] };
  const out = canonObj(doc);
  assert.equal(blocksOf(out).length, 3, `空段落被剔了：${JSON.stringify(out)}`);
  assert.deepEqual(
    blocksOf(out)[1],
    EMPTY_P,
    `中间的空段落应原样保留（无 spans 键），实得 ${JSON.stringify(out.blocks[1])}`,
  );
});

test('空段落-02 多个连续空行要**全部**保留（用户敲了 3 个空行就是 3 个空行）', () => {
  const doc = { v: 1, blocks: [P('A'), EMPTY_P, EMPTY_P, EMPTY_P, P('B')] };
  const out = canonicalize(doc);
  assert.equal(blocksOf(canonObj(doc)).length, 5, `连续空行被合并/剔除了：${JSON.stringify(canonObj(doc))}`);
});

test('空段落-03 只有空段落也要保留（哪怕全文没有一个字）', () => {
  const doc = { v: 1, blocks: [EMPTY_P, EMPTY_P] };
  const out = canonicalize(doc);
  assert.equal(blocksOf(canonObj(doc)).length, 2, `全空文档被清空了：${JSON.stringify(canonObj(doc))}`);
});

test('空段落-04 首尾的空段落同样保留（不只保留中间的）', () => {
  const doc = { v: 1, blocks: [EMPTY_P, P('A'), EMPTY_P] };
  const out = canonicalize(doc);
  assert.equal(blocksOf(canonObj(doc)).length, 3, `首尾空段落被剔了：${JSON.stringify(canonObj(doc))}`);
});

/* ============ 2. 幂等：新形态自己 normalize 自己不能变 ============ */

test('空段落-05 normalize 幂等（含空段落时）', () => {
  const doc = { v: 1, blocks: [P('A'), EMPTY_P, P('B'), EMPTY_P] };
  const once = normalize(doc);
  const twice = normalize(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once, 'normalize 不幂等 —— 空段落这条新不变量被破坏了');
});

test('空段落-06 canonicalize 幂等（含空段落时），逐字节不变', () => {
  const doc = { v: 1, blocks: [P('A'), EMPTY_P, P('B')] };
  const one = canonicalize(doc);
  // 🔴 canonicalize 的返回值**已经是字符串**，不要再 JSON.stringify 一层
  //   （我第一版写成 JSON.parse(JSON.stringify(one)) ⇒ one 成了 "{}"，判据自己红）。
  const two = canonicalize(JSON.parse(one));
  assert.equal(two, one, 'canonicalize 不幂等');
});

test('空段落-07 空段落形态必须**唯一**：加了 spans:[] 要归一成没有该键', () => {
  // canonical 规则 2：空数组省略。所以 {t:'p',spans:[]} 与 {t:'p'} 是同一件事，
  // 必须只留一种字节形态，否则"同一内容两种合法表示"⇒ 往返与冲突判定全乱。
  const withEmptyArray = { v: 1, blocks: [{ t: 'p', spans: [] }] };
  const out = canonObj(withEmptyArray);
  assert.equal(
    Object.prototype.hasOwnProperty.call(blocksOf(out)[0], 'spans'),
    false,
    `空段落不该带 spans 键（哪怕是空数组）：${JSON.stringify(blocksOf(out)[0])}`,
  );
  assert.ok(isValidDoc(out), '归一后的形态必须是合法文档');
});

/* ============ 3. 往返无损 ============ */

test('空段落-08 往返无损：parseDoc(canonicalize(d)) 深等于 canonicalize(d)', () => {
  const doc = { v: 1, blocks: [P('A'), EMPTY_P, P('B')] };
  const c = canonObj(doc);
  const back = parseDoc(canonicalize(doc));
  assert.deepEqual(back, c, '往返丢了东西（多半是空段落没被 parseDoc 接受）');
});

test('空段落-09 空段落的合法字节只有一种（parseDoc 拒掉带 spans:[] 的形态）', () => {
  assert.ok(isValidDoc(parseDoc('{"v":1,"blocks":[{"t":"p"}]}')), '无 spans 的空段落应当合法');
  assert.throws(
    () => parseDoc('{"v":1,"blocks":[{"t":"p","spans":[]}]}'),
    /非 canonical/,
    '带 spans:[] 的空段落应当被判非 canonical（同一内容只能有一种字节）',
  );
});

/* ============ 4. 反向闸：不该保留的东西不能被"顺手保留" ============ */

test('空段落-10 🔴 反向闸：标题/ 引用 / 列表项的空壳**早就**合法，别声称是新加的', () => {
  // 这条是钉住"我没顺手扩大范围"：空壳标题此前就能进真源（isEmptyPara 只认 p），
  // 本次改动只动了 p。别把"空壳合法"当成新能力写进注释。
  for (const t of ['h3', 'quote']) {
    const out = canonObj({ v: 1, blocks: [{ t }, P('x')] });
    assert.equal(blocksOf(out).length, 2, `${t} 的空壳被剔了 —— 超出本次改动范围，属回归`);
  }
});

test('空段落-11 🔴 反向闸：空 children 数组仍然要被省略（canonical 规则 2 没变）', () => {
  const out = canonObj({ v: 1, blocks: [{ t: 'ul', children: [] }] });
  assert.equal(
    Object.prototype.hasOwnProperty.call(blocksOf(out)[0], 'children'),
    false,
    `空 children 数组应被省略：${JSON.stringify(out)}`,
  );
});

/* ============ 5. 相邻列表合并：空段落必须能"隔开"两个列表 ============ */

test('空段落-12 空段落能隔开两个相邻同类型列表（不再被剔掉后误合并）', () => {
  const li = (t) => ({ t: 'li', spans: [{ t }] });
  const doc = {
    v: 1,
    blocks: [
      { t: 'ul', children: [li('a')] },
      EMPTY_P,
      { t: 'ul', children: [li('b')] },
    ],
  };
  const out = canonObj(doc);
  // 这条是"让空段落进真源"最直接的用户价值：
  // 用户在两个列表之间敲了一个空行，那两个列表就**不该**被合成一个。
  assert.equal(blocksOf(out).length, 3, `空行没能隔开两个列表：${JSON.stringify(out)}`);
  assert.equal(blocksOf(out)[0].t, 'ul');
  assert.equal(blocksOf(out)[2].t, 'ul');
});

test('空段落-13 没有空行时两个相邻同类型列表仍然要合并（这条旧不变量不能被破坏）', () => {
  const li = (t) => ({ t: 'li', spans: [{ t }] });
  const doc = {
    v: 1,
    blocks: [{ t: 'ul', children: [li('a')] }, { t: 'ul', children: [li('b')] }],
  };
  // 🔴🔴 这条必须用 `normalize` 判，**不能用 `canonicalize`** —— 我第一版写错了对象，
  //   于是报"相邻列表没合并"并让我以为改动破了旧不变量。
  //   实测分工是：**合并相邻列表是 `normalize` 的职责**：
  //     canonicalize([ul,ul]) → 原样输出两个 ul（它只管键序/形态）
  //     parseDoc(那个输出)     → **拒收**（相邻同类型列表是非 canonical 形态）
  //     normalize([ul,ul])     → 合成一个 ul
  //   所以"该合并"这件事的判据是 normalize 的输出，canonicalize 这里就该保持不动。
  //   连带的道理：canonicalize 保留空段落、normalize 也保留（本次改动），
  //   **两条路径只在"形态归一"上分工，内容语义上必须一致** —— 那才是本次要守的不变量。
  const out = normalize(doc);
  assert.equal(blocksOf(out).length, 1, `相邻同类型列表没合并：${JSON.stringify(out)}`);
  assert.equal(blocksOf(out)[0].children.length, 2);
  // 反向：canonicalize 必须原样保留（不越权做合并），否则 normalize 就没活干了
  assert.equal(
    blocksOf(canonObj(doc)).length,
    2,
    'canonicalize 不该合并相邻列表 —— 那是 normalize 的职责，越权会让两条路径语义不一致',
  );
});

/* ============ 6. 冲突判定：blockSig 对空段落必须稳定 ============ */

test('空段落-14 blockSig 对空段落稳定，且与非空段落必不同', () => {
  const sigEmpty = blockSig(EMPTY_P);
  const sigEmpty2 = blockSig({ t: 'p' });
  assert.equal(sigEmpty, sigEmpty2, '两个空段落的签名必须相同');
  const sigA = blockSig(P('A'));
  assert.notEqual(sigEmpty, sigA, '空段落与非空段落签名相同 ⇒ 合并会把它们当同一段');
});

test('空段落-15 合并：一方加了个空行，另一方不动 ⇒ 空行必须在（不丢）', () => {
  const base = { v: 1, blocks: [P('A'), P('B')] };
  const withBlank = { v: 1, blocks: [P('A'), EMPTY_P, P('B')] };
  // 🔴 mergeDocs 的入参是**归一后的对象**，不是 canonical 字符串
  //   （canonicalize 返回字符串这件事我在这条又忘了一次，判据直接报"空行丢了"）。
  const merged = mergeDocs(normalize(base), normalize(withBlank), normalize(base));
  assert.ok(
    merged.conflicts.length === 0,
    `不该报冲突：${JSON.stringify(merged.conflicts)}`,
  );
  assert.ok(
    blocksOf(merged.doc).some((b) => b.t === 'p' && !b.spans),
    `加的空行在合并后丢了：${JSON.stringify(merged.doc)}`,
  );
});

/* ============ 7. 属性测试：随机文档下新不变量必须恒成立 ============ */

test('空段落-16 属性测试：任意含空段落的文档，normalize 与 canonicalize 都幂等', () => {
  const emptyPara = fc.constant({ t: 'p' });
  const textPara = fc.stringMatching(/[A-Za-z一-龥]{1,6}/u).map((t) => ({ t: 'p', spans: [{ t }] }));
  const para = fc.oneof(emptyPara, textPara);
  fc.assert(
    fc.property(fc.array(para, { minLength: 0, maxLength: 8 }), (blocks) => {
      const doc = blocks.length > 0 ? { v: 1, blocks } : { v: 1 };
      const c1 = canonicalize(doc);
      const c2 = canonicalize(JSON.parse(c1));
      assert.equal(JSON.stringify(c2), JSON.stringify(c1), `canonicalize 不幂等：${JSON.stringify(doc)}`);
      const n1 = normalize(doc);
      const n2 = normalize(JSON.parse(JSON.stringify(n1)));
      assert.deepEqual(n2, n1, `normalize 不幂等：${JSON.stringify(doc)}`);
      // 空段落不能被吞：一个都没丢
      const inCount = blocks.length;
      const outCount = n1.blocks?.length ?? 0;
      assert.equal(outCount, inCount, `块数变了：${inCount} → ${outCount}（${JSON.stringify(doc)}）`);
    }),
    { numRuns: 300 },
  );
});

test('空段落-17 属性测试：任意含空段落的文档都必须是合法文档', () => {
  const emptyPara = fc.constant({ t: 'p' });
  const textPara = fc.stringMatching(/[A-Za-z一-龥]{1,6}/u).map((t) => ({ t: 'p', spans: [{ t }] }));
  const para = fc.oneof(emptyPara, textPara);
  fc.assert(
    fc.property(fc.array(para, { minLength: 1, maxLength: 8 }), (blocks) => {
      const c = canonObj({ v: 1, blocks });
      assert.ok(isValidDoc(c), `归一结果不是合法文档：${JSON.stringify(c)}`);
    }),
    { numRuns: 300 },
  );
});

/* ============ 8. emptyDoc 形态不变 ============ */

test('空段落-18 emptyDoc 的 canonical 形态仍是 {"v":1}（没有块就是没有块）', () => {
  // 🔴 canonicalize 返回字符串，别再 JSON.stringify（我第一版包了一层，
  //   于是期望 '{"v":1}' 实际拿到 '"{\"v\":1}"' —— 判据自己红）。
  assert.equal(canonicalize(emptyDoc()), '{"v":1}');
});
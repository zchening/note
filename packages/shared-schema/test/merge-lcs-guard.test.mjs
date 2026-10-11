/**
 * P0-5 判据：字符级 diff3 的 LCS 规模守卫
 *
 * 对应三类改动，每条都成"应该有 / 不应该有"一对：
 *  (a) 阈值保护   —— 超预算必须走冲突路径，绝不给一份被悄悄截断或错乱的结果
 *  (b) 公共前后缀裁剪 —— 必须与不裁剪逐字等价（off-by-one 探针 + 边界探针）
 *  (c) 异常兜底   —— 分配失败/极端规模都不许冒泡
 *  另有：阈值内仍要真正合并（不能一律判冲突）、六条不变量不被破坏
 *
 * 全部 import 生产代码，不复制实现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeDocs, spansText } from '../src/index.ts';

/* ---------------- 工具 ---------------- */

const textDoc = (t) => ({ v: 1, blocks: [{ t: 'p', spans: [{ t }] }] });

const mergedText = (r) => spansText(r.doc.blocks?.[0]?.spans ?? []);

/** Conflict 里记录的 base/left/right 是 CharTok[] 的 JSON；还原成纯文本 */
const tokText = (json) => JSON.parse(json).map((t) => t.ch).join('');

/**
 * 把一条 Conflict 记录还原成"能直接看"的原文。
 * 字符级记录是 CharTok[]（拼 ch），块级记录是 Block[]（没法拼，直接退回原 JSON 串）。
 * 两种都兼容，断言才不会因为记录落在哪一层而失真。
 */
const plainOf = (json) => {
  const v = JSON.parse(json);
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'ch' in v[0]) {
    return v.map((t) => t.ch).join('');
  }
  return json;
};

const rep = (ch, n) => ch.repeat(n);

/** n 个两两不同的字符。全同字符的输入会让 LCS 无从分辨删的是哪一个，构造时必须避开 */
const uniq = (n) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');

/** 文本里某个片段出现的次数（非重叠） */
const countOf = (hay, needle) => hay.split(needle).length - 1;

/* ================= (b) 裁剪等价性 ================= */

/**
 * 为什么先写裁剪：这是三件事里唯一会**改变输出**的优化（阈值只影响"能不能合并"，
 * 异常兜底只在极端态触发），做错就是静默错字，必须先钉死。
 *
 * 判据的思路：不复制一份"不裁剪的实现"进测试（那是抄实现，等于没测），
 * 而是挑**正解可以由构造直接推出来**的输入 —— 两侧都是纯插入 / 纯删除、
 * 且落在互不重叠的位置，那么正确结果就是 base 与两侧编辑的并集。
 * 裁剪一旦差一位（多切/少切一个字符），结果就会重复、丢字或错位。
 */

test('P0-5-b 裁剪-1 首尾大段相同、两侧各在中间插入：结果逐字等于可推导的正解', () => {
  const P = rep('前', 400);
  const X = rep('中', 200);
  const S = rep('后', 400);
  const base = P + X + S;
  const left = P + '甲' + X + S; // 在 P 之后插入
  const right = P + X + '乙' + S; // 在 S 之前插入

  const r = mergeDocs(textDoc(base), textDoc(left), textDoc(right));

  // 正解由构造直接得出：两侧都是纯新增、互不重叠 ⇒ 并集，且不该有冲突
  assert.equal(mergedText(r), P + '甲' + X + '乙' + S, '裁剪差位就会错字/重复/丢字');
  assert.equal(r.conflicts.length, 0, '互不重叠的新增不该报冲突');
});

test('P0-5-b 裁剪-2 编辑落在最首/最末（off-by-one 探针）：不错位、不吞字', () => {
  const base = uniq(1000);

  // 插入在最前 + 插入在最后
  const r1 = mergeDocs(textDoc(base), textDoc('L' + base), textDoc(base + 'R'));
  assert.equal(mergedText(r1), 'L' + base + 'R', '首/尾插入被裁剪吃掉或重复了');

  // 删除最前一个 + 删除最后一个
  const r2 = mergeDocs(textDoc(base), textDoc(base.slice(1)), textDoc(base.slice(0, -1)));
  assert.equal(mergedText(r2), base.slice(1, -1), '首/尾删除没有正确叠加');
  assert.equal(r2.conflicts.length, 0);
});

test('P0-5-b 裁剪-3 首尾大段相同 + 一侧改中间、另一侧末尾追加：两侧改动都保留', () => {
  const P = rep('前', 400);
  const S = rep('后', 400);
  const base = P + rep('中', 200) + S;
  const left = P + rep('新', 200) + S; // 改中间
  const right = base + '追加'; // 末尾追加

  const r = mergeDocs(textDoc(base), textDoc(left), textDoc(right));

  assert.equal(mergedText(r), P + rep('新', 200) + S + '追加');
  assert.equal(r.conflicts.length, 0);
});

test('P0-5-b 裁剪-4 不应该有：裁剪不许把公共前后缀重复输出或吞掉', () => {
  const P = rep('前', 300);
  const S = rep('后', 300);
  const base = P + '中' + S;

  // 两侧都原样保留（右侧与 base 相同）⇒ 必须逐字等于左侧
  const r = mergeDocs(textDoc(base), textDoc(P + '中改' + S), textDoc(base));
  const out = mergedText(r);
  assert.equal(countOf(out, P), 1, '公共前缀重复了');
  assert.equal(countOf(out, S), 1, '公共后缀重复了');
  assert.equal(out, P + '中改' + S);
});

/* ================= (a) 阈值保护 ================= */

/**
 * 阈值内的"两侧并发编辑同一大块"：正解是两侧编辑的并集。
 * 用可计数的可识别片段（A0;…A49; / B1;…B99; 交错插在互不重叠的位置）来构造，
 * 这样"丢段"和"重复"都能被计数直接抓出来，而不是靠肉眼比对一坨字。
 */

function interleaveCase(n = 100) {
  const marks = Array.from({ length: n }, (_, i) => `<${i}>`);
  const base = marks.join('');
  const left = marks.map((m, i) => (i % 2 === 0 ? m + `A${i};` : m)).join('');
  const right = marks.map((m, i) => (i % 2 === 1 ? m + `B${i};` : m)).join('');
  return { base, left, right, n };
}

test('P0-5-a 阈值内-1 两侧交错编辑同一大块：每一侧的每个片段都各出现一次', () => {
  const { base, left, right, n } = interleaveCase();
  const out = mergedText(mergeDocs(textDoc(base), textDoc(left), textDoc(right)));

  for (let i = 0; i < n; i++) {
    assert.equal(countOf(out, `<${i}>`), 1, `锚点 <${i}> 丢了或重复了`);
    const tok = i % 2 === 0 ? `A${i};` : `B${i};`;
    assert.equal(countOf(out, tok), 1, `${tok} 丢了或重复了`);
  }
  // 长度也钉死：base + 两侧各自的新增，不多不少
  const expectLen =
    base.length +
    Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `A${i};` : `B${i};`)).join('').length;
  assert.equal(out.length, expectLen, '多了或少了字符');
});

test('P0-5-a 阈值内-2 顺序正确：片段紧跟自己的锚点，锚点自身不重排', () => {
  const { base, left, right, n } = interleaveCase();
  const out = mergedText(mergeDocs(textDoc(base), textDoc(left), textDoc(right)));

  let cursor = -1;
  for (let i = 0; i < n; i++) {
    const at = out.indexOf(`<${i}>`, cursor + 1);
    assert.ok(at > cursor, `<${i}> 顺序乱了`);
    const tok = i % 2 === 0 ? `A${i};` : `B${i};`;
    assert.ok(out.startsWith(tok, at + `<${i}>`.length), `${tok} 没有紧跟在 <${i}> 后面`);
    cursor = at;
  }
});

test('P0-5-a 阈值内-3 不应该有：阈值内不许一律判冲突（那就等于阉割了合并）', () => {
  const { base, left, right } = interleaveCase();
  const r = mergeDocs(textDoc(base), textDoc(left), textDoc(right));
  assert.equal(r.conflicts.length, 0, '互不重叠的编辑被误判成冲突');
  const out = mergedText(r);
  assert.ok(out.includes('A0;') && out.includes('B1;'), '两侧内容没有都进来');
});

/**
 * 超阈值：单块 5000 字、两侧都改、且没有公共前后缀可裁。
 * 期望不是"合并出一个结果"，而是**认怂**：报冲突 + 采纳 left + 双版本进 Conflict 记录。
 */

test('P0-5-a 超阈值-1 单块两侧全改（5000 字）：走冲突路径，双版本都留得下', () => {
  const N = 5000;
  const base = rep('基', N);
  const left = rep('左', N);
  const right = rep('右', N);
  const r = mergeDocs(textDoc(base), textDoc(left), textDoc(right));

  assert.equal(r.conflicts.length, 1, '超阈值必须判冲突（而不是硬算出一个结果）');
  const c = r.conflicts[0];
  assert.equal(c.kind, 'text');
  // 不丢：冲突记录里两侧原文都能还原出来
  assert.equal(tokText(c.left), left, 'left 版本丢失');
  assert.equal(tokText(c.right), right, 'right 版本丢失');
  assert.equal(tokText(c.base), base, 'base 版本丢失');
});

test('P0-5-a 超阈值-2 不应该有：不许给出被截断/错乱的"半合并"结果', () => {
  const N = 5000;
  const left = rep('左', N);
  const right = rep('右', N);
  const r = mergeDocs(textDoc(rep('基', N)), textDoc(left), textDoc(right));
  const out = mergedText(r);

  assert.equal(out, left, '文档侧应完整采纳 left，而不是被截断');
  assert.notEqual(out.length, 0, '不该产出空段');
  assert.ok(!out.includes('右'), '不该把 right 的字符混进 left 的结果里（那是错乱拼接）');
});

/* ================= (c) 异常兜底 ================= */

test('P0-5-c 极端规模（2 万字两侧都改）：不抛异常，走冲突路径', () => {
  const N = 20_000;
  const base = rep('基', N);
  const left = rep('左', N);
  const right = rep('右', N);

  let r;
  assert.doesNotThrow(() => {
    r = mergeDocs(textDoc(base), textDoc(left), textDoc(right));
  }, '异常冒到调用方了');

  assert.ok(r.conflicts.length >= 1, '极端规模必须判冲突');
  assert.equal(mergedText(r), left);
  assert.equal(tokText(r.conflicts[0].right), right, 'right 版本丢失');
});

test('P0-5-c 分配器抛错（stub 注入 Uint32Array）：被吞掉并降级为冲突，不冒泡', () => {
  const Real = globalThis.Uint32Array;
  const base = 'abcdef';
  const left = 'abcdefX';
  const right = 'abcdefY';

  // 对照组：正常情况下这个输入能真正合并（不是靠冲突蒙混过关）
  const ok = mergeDocs(textDoc(base), textDoc(left), textDoc(right));
  assert.equal(mergedText(ok), 'abcdefXY', '对照组：正常分配时本应合并出并集');
  assert.equal(ok.conflicts.length, 0);

  let r;
  try {
    globalThis.Uint32Array = function () {
      throw new Error('QuotaExceeded: 模拟分配失败');
    };
    assert.doesNotThrow(() => {
      r = mergeDocs(textDoc(base), textDoc(left), textDoc(right));
    }, '分配异常冒到调用方了');
  } finally {
    globalThis.Uint32Array = Real;
  }

  assert.ok(r.conflicts.length >= 1, '分配失败必须降级为冲突，不能假装合并成功');
  assert.equal(mergedText(r), left, '降级时应采纳 left');
  assert.equal(globalThis.Uint32Array, Real, 'stub 必须还原');
});

/**
 * "不丢段"的正确判法：Conflict 记录携带的是**该变更簇内两侧各自的差异段**，
 * 两侧一致的部分由文档本体承载。所以"不丢"= 文档 ∪ 冲突记录 ⊇ 两侧全集。
 * （簇外共享部分本来就在文档里，若硬要求单条记录含全文，反而会把簇划分的语义搞错。）
 */
test('P0-5-c 不应该有：分配失败时也不许丢段（文档 ∪ 冲突记录 = 两侧全集）', () => {
  const Real = globalThis.Uint32Array;
  const base = 'abcdef';
  const left = 'abcdefX';
  const right = 'abcdefY';
  let r;
  try {
    globalThis.Uint32Array = function () {
      throw new Error('QuotaExceeded');
    };
    r = mergeDocs(textDoc(base), textDoc(left), textDoc(right));
  } finally {
    globalThis.Uint32Array = Real;
  }
  const c = r.conflicts[0];
  // 用 plainOf：降级可能发生在块级（记录是 Block[]）也可能在字符级（记录是 CharTok[]），
  // 两种形态下都必须能取回两侧的差异段
  const doc = mergedText(r);
  assert.equal(doc, left, '文档侧应完整保留 left');
  assert.ok(plainOf(c.left).includes('X'), 'left 的差异段丢了');
  assert.ok(plainOf(c.right).includes('Y'), 'right 的差异段丢了');
  // 合起来仍是两侧全集：left 全文在文档里，right 独有的 'Y' 在记录里
  assert.ok(doc.includes('abcdef'), '共享部分丢了');
  assert.ok(`${doc}${plainOf(c.right)}`.includes('Y'), 'right 的独有内容无处可寻');
});

/* ================= 不变量不被破坏 ================= */

test('P0-5 不变量-1 大文档（8000 字）合并吸收：merge(a,a,b)===b', () => {
  const a = textDoc(rep('甲', 8000));
  const b = textDoc(rep('乙', 8000)); // 与 a 完全不同 ⇒ 触发超预算分支
  const r = mergeDocs(a, a, b);
  assert.equal(mergedText(r), rep('乙', 8000), '吸收律被阈值守卫破坏了');
  assert.equal(r.conflicts.length, 0, '一侧没动就不该有冲突');
});

test('P0-5 不变量-2 大文档（8000 字）合并吸收：merge(a,b,a)===b', () => {
  const a = textDoc(rep('甲', 8000));
  const b = textDoc(rep('乙', 8000));
  const r = mergeDocs(a, b, a);
  assert.equal(mergedText(r), rep('乙', 8000), '吸收律被阈值守卫破坏了');
  assert.equal(r.conflicts.length, 0);
});

test('P0-5 不变量-3 纯函数：大文档合并不修改入参', () => {
  const base = textDoc(rep('基', 3000) + '中' + rep('尾', 3000));
  const left = textDoc(rep('基', 3000) + '左改' + rep('尾', 3000));
  const right = textDoc(rep('基', 3000) + '中' + rep('尾', 3000) + '右加');
  const snap = JSON.stringify([base, left, right]);

  const r1 = mergeDocs(base, left, right);
  const r2 = mergeDocs(base, left, right);

  assert.equal(JSON.stringify([base, left, right]), snap, '入参被改了');
  assert.equal(JSON.stringify(r1.doc), JSON.stringify(r2.doc), '同输入同输出被破坏');
  assert.equal(mergedText(r1), rep('基', 3000) + '左改' + rep('尾', 3000) + '右加');
  assert.equal(r1.conflicts.length, 0);
});

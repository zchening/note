/**
 * 真源层属性测试 —— 六条不变量，全部用 fast-check 随机跑
 *
 * 这六条正是老项目 128 条 bug 的根因所在，每条对应一类历史 bug：
 *  1. canonical 幂等：canonicalize(canonicalize) 逐字节不变（老项目"保存后再打开样式变了"）
 *  2. 往返无损：parseDoc(canonicalize(d)) 深等于 d（老项目"重载丢一次编辑"）
 *  3. 拒绝确定：非法输入永远被拒，且错误码稳定（不因顺序/时序变化）
 *  4. 归一幂等：normalize(normalize(d)) === normalize(d)
 *  5. 合并吸收：merge(a,a,b)===b 且 merge(a,b,a)===b（老项目"同步后自己改的又回来了"）
 *  6. 合并确定性：同输入同输出，且不修改入参
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  canonicalize,
  parseDoc,
  normalize,
  NotCanonicalError,
  validateDoc,
  ValidateError,
  blockSig,
  mergeDocs,
  emptyDoc,
  referencedRemIds,
  isValidDoc,
} from '../src/index.ts';
import { docArb, docWithRefsArb } from './arbs.mjs';

const NUM_RUNS = 300;

/* ---------------- 1. canonical 幂等 ---------------- */

test('不变量1: canonicalize 幂等 —— 反复序列化逐字节不变', () => {
  fc.assert(
    fc.property(docArb, (d) => {
      const a = canonicalize(d);
      const b = canonicalize(JSON.parse(a));
      const c = canonicalize(JSON.parse(b));
      assert.equal(b, a, '第二次序列化变了');
      assert.equal(c, a, '第三次序列化变了');
    }),
    { numRuns: NUM_RUNS },
  );
});

/* ---------------- 2. 往返无损 ---------------- */

test('不变量2: parseDoc(canonicalize(d)) 等于 normalize(d)', () => {
  // 注意：断言对象是 normalize(d) 而不是 d。canonical 规则 2 规定"空数组省略"，
  // 而生成器会产出 children:[] / blocks:[] 这类形态 —— 往返后省略它们正是设计意图。
  // 用 d 直接比会把 canonical 的核心规则误判成 bug（第一版就是这么写错的）。
  fc.assert(
    fc.property(docArb, (d) => {
      const round = parseDoc(canonicalize(d));
      assert.deepEqual(round, normalize(d));
    }),
    { numRuns: NUM_RUNS },
  );
});

test('不变量2-bis: 无空数组形态的文档，往返严格等于原对象', () => {
  // 补上"文档本身已 canonical"这个前提下的强往返断言，避免上一条的宽松掩盖真 bug
  fc.assert(
    fc.property(docArb, (d) => {
      const can = canonicalize(d);
      if (can !== JSON.stringify(d)) return; // 本身非 canonical（如带空数组），跳过
      assert.deepEqual(parseDoc(can), JSON.parse(can));
    }),
    { numRuns: NUM_RUNS },
  );
});

test('不变量2b: 带 rem 引用的文档同样往返无损', () => {
  fc.assert(
    fc.property(docWithRefsArb, (d) => {
      const round = parseDoc(canonicalize(d));
      assert.deepEqual(round, normalize(d));
    }),
    { numRuns: NUM_RUNS },
  );
});

test('不变量2c: 随机生成器产出的文档都必须是合法文档（生成器自身正确性）', () => {
  fc.assert(
    fc.property(docWithRefsArb, (d) => {
      assert.ok(isValidDoc(d), '生成器产出了非法文档，测试会假绿');
    }),
    { numRuns: NUM_RUNS },
  );
});

/* ---------------- 3. 拒绝确定 ---------------- */

test('不变量3a: 非 canonical 表示一律拒绝（空白、键序、显式默认值）', () => {
  const bad = [
    '{ "v":1 }', // 有空格
    '{"blocks":[],"v":1}', // 键序不对（v 必须在最前）
    '{"v":1,"reminders":[]}', // 空数组应省略
    '{"v":1,"blocks":[],"reminders":[]}', // 同上
    '{"v":1,"reminders":[],"blocks":[]}', // 键序反了 + 空数组
    'not json at all',
    '[]',
    '"str"',
    'null',
    '{"v":2}',
  ];
  for (const s of bad) {
    assert.throws(() => parseDoc(s), NotCanonicalError, `应拒绝：${s}`);
  }
});

test('不变量3b: 显式 false 标记被拒（canonical 规则2）', () => {
  const s = '{"v":1,"blocks":[{"t":"p","spans":[{"t":"x","b":false}]}]}';
  assert.throws(() => parseDoc(s), NotCanonicalError);
});

test('不变量3c: 未知键被拒（防止私挂 UI 状态进真源）', () => {
  const s = '{"v":1,"blocks":[{"t":"p","spans":[{"t":"x","_ui":1}]}]}';
  assert.throws(() => parseDoc(s), NotCanonicalError);
});

test('不变量3d: validator 错误码确定：同样输入永远同一码', () => {
  const mk = () => ({ v: 1, blocks: [{ t: 'nope' }], reminders: [] });
  const a = (() => {
    try {
      validateDoc(mk());
      return 'no-throw';
    } catch (e) {
      return e instanceof ValidateError ? e.code : 'other';
    }
  })();
  for (let i = 0; i < 50; i++) {
    let code = 'no-throw';
    try {
      validateDoc(mk());
    } catch (e) {
      code = e instanceof ValidateError ? e.code : 'other';
    }
    assert.equal(code, a, '错误码不稳定');
  }
  assert.equal(a, 'E_BLOCK_TYPE_UNKNOWN');
});

test('不变量3e: 结构性错误各自给出正确错误码', () => {
  const cases = [
    [{ v: 2, blocks: [], reminders: [] }, 'E_VERSION'],
    [{ v: 1, blocks: 'x', reminders: [] }, 'E_BLOCKS_TYPE'],
    [{ v: 1, blocks: [], reminders: 'x' }, 'E_REMINDERS_TYPE'],
    [{ v: 1, blocks: [{ t: 'p', children: [{ t: 'p' }] }], reminders: [] }, 'E_CHILDREN_NOT_ALLOWED'],
    [
      { v: 1, blocks: [], reminders: [{ id: 'a', at: '2026-10-05T08:30:00+08:00', text: 'x' }, { id: 'a', at: '2026-10-05T08:30:00+08:00', text: 'y' }] },
      'E_REMINDER_DUP_ID',
    ],
    [{ v: 1, blocks: [], reminders: [{ id: 'a', at: '2026-10-05 08:30', text: 'x' }] }, 'E_REMINDER_AT_FORMAT'],
    [{ v: 1, blocks: [], reminders: [{ id: 'a', at: '2026-13-45T99:99:99Z', text: 'x' }] }, 'E_REMINDER_AT_FORMAT'],
    [{ v: 1, blocks: [{ t: 'p', spans: [{ t: 'x', rem: 'ghost' }] }], reminders: [] }, 'E_SPAN_REM_MISSING'],
    [{ v: 1, blocks: [{ t: 'code', lang: 'x'.repeat(33) }], reminders: [] }, 'E_LANG_TOO_LONG'],
  ];
  for (const [doc, code] of cases) {
    let got = 'no-throw';
    try {
      validateDoc(doc);
    } catch (e) {
      got = e instanceof ValidateError ? e.code : `other:${String(e)}`;
    }
    assert.equal(got, code, `输入 ${JSON.stringify(doc).slice(0, 80)}`);
  }
});

test('不变量3f: 深嵌套超限被拒（不打爆调用栈）', () => {
  let b = { t: 'p', spans: [{ t: 'leaf' }] };
  for (let i = 0; i < 40; i++) b = { t: 'fold', title: [{ t: 'x' }], children: [b] };
  let code = 'no-throw';
  try {
    validateDoc({ v: 1, blocks: [b], reminders: [] });
  } catch (e) {
    code = e instanceof ValidateError ? e.code : 'other';
  }
  assert.equal(code, 'E_BLOCK_SHAPE');
});

/* ---------------- 4. normalize 幂等 ---------------- */

test('不变量4: normalize 幂等且输出必 canonical', () => {
  fc.assert(
    fc.property(docArb, (d) => {
      const n1 = canonicalize(normalize(d));
      const n2 = canonicalize(normalize(JSON.parse(n1)));
      assert.equal(n2, n1);
      // normalize 的结果一定能被 parseDoc 接受
      assert.doesNotThrow(() => parseDoc(n1));
    }),
    { numRuns: NUM_RUNS },
  );
});

/* ---------------- 5. 合并吸收律 ---------------- */

test('不变量5a: merge(a,a,b) 深等于 b（本地没动，远端改动全盘接收）', () => {
  fc.assert(
    fc.property(docArb, docArb, (a, b) => {
      const r = mergeDocs(a, a, b);
      assert.equal(canonicalize(r.doc), canonicalize(b), '远端改动未被完整接收');
      assert.equal(r.conflicts.length, 0, '一侧无改动时不该有冲突');
    }),
    { numRuns: 120 },
  );
});

test('不变量5b: merge(a,b,a) 深等于 b', () => {
  fc.assert(
    fc.property(docArb, docArb, (a, b) => {
      const r = mergeDocs(a, b, a);
      assert.equal(canonicalize(r.doc), canonicalize(b), '本地改动未被完整接收');
      assert.equal(r.conflicts.length, 0);
    }),
    { numRuns: 120 },
  );
});

test('不变量5c: merge(a,a,a) === a 且无冲突', () => {
  fc.assert(
    fc.property(docArb, (a) => {
      const r = mergeDocs(a, a, a);
      assert.equal(canonicalize(r.doc), canonicalize(a));
      assert.equal(r.conflicts.length, 0);
    }),
    { numRuns: 200 },
  );
});

/* ---------------- 6. 合并确定性 + 不改入参 ---------------- */

test('不变量6a: 合并是纯函数，不修改任何入参', () => {
  fc.assert(
    fc.property(docArb, docArb, docArb, (a, l, r) => {
      const a0 = canonicalize(a);
      const l0 = canonicalize(l);
      const r0 = canonicalize(r);
      mergeDocs(a, l, r);
      assert.equal(canonicalize(a), a0, 'base 被改了');
      assert.equal(canonicalize(l), l0, 'left 被改了');
      assert.equal(canonicalize(r), r0, 'right 被改了');
    }),
    { numRuns: 200 },
  );
});

test('不变量6b: 同输入同输出（可重复）', () => {
  fc.assert(
    fc.property(docArb, docArb, docArb, (a, l, r) => {
      const x = canonicalize(mergeDocs(a, l, r).doc);
      const y = canonicalize(mergeDocs(a, l, r).doc);
      assert.equal(x, y);
    }),
    { numRuns: 200 },
  );
});

test('不变量6c: 合并结果必定是合法文档（不会有半成品状态）', () => {
  fc.assert(
    fc.property(docArb, docArb, docArb, (a, l, r) => {
      const m = mergeDocs(a, l, r);
      assert.ok(isValidDoc(m.doc), '合并产出了非法文档');
    }),
    { numRuns: 200 },
  );
});

/* ---------------- 合并语义（定向用例，不靠随机） ---------------- */

test('合并语义: 一端加段另一端改段，两边改动都在', () => {
  const a = {
    v: 1,
    blocks: [
      { t: 'p', spans: [{ t: '第一段' }] },
      { t: 'p', spans: [{ t: '第二段' }] },
      { t: 'p', spans: [{ t: '第三段' }] },
    ],
    reminders: [],
  };
  const l = structuredClone(a);
  l.blocks[0].spans = [{ t: '第一段改' }];
  const r = structuredClone(a);
  r.blocks.splice(1, 0, { t: 'p', spans: [{ t: '插入段' }] });

  const m = mergeDocs(a, l, r);
  const texts = m.doc.blocks.map((b) => b.spans?.[0]?.t ?? '');
  assert.ok(texts.includes('第一段改'), '左改的丢了：' + JSON.stringify(texts));
  assert.ok(texts.includes('插入段'), '右插的丢了：' + JSON.stringify(texts));
  assert.ok(texts.includes('第二段'), '未动的段丢了');
  assert.ok(texts.includes('第三段'), '未动的末段丢了');
  assert.equal(m.conflicts.length, 0);
});

test('合并语义: 同一段两端改不同字，字符级合并保留双方', () => {
  const a = { v: 1, blocks: [{ t: 'p', spans: [{ t: 'abcdef' }] }], reminders: [] };
  const l = structuredClone(a);
  l.blocks[0].spans = [{ t: 'abcXef' }];
  const r = structuredClone(a);
  r.blocks[0].spans = [{ t: 'abcdeY' }];
  const m = mergeDocs(a, l, r);
  const t = m.doc.blocks[0].spans?.map((s) => s.t).join('') ?? '';
  assert.ok(t.includes('X'), '左改的字符丢了：' + t);
  assert.ok(t.includes('Y'), '右改的字符丢了：' + t);
  assert.ok(t.startsWith('abc'), '公共前缀丢了：' + t);
});

test('合并语义: 一端删段、另一端不动，删除成立（不复活）', () => {
  const a = {
    v: 1,
    blocks: [
      { t: 'p', spans: [{ t: 'A' }] },
      { t: 'p', spans: [{ t: 'B' }] },
      { t: 'p', spans: [{ t: 'C' }] },
    ],
    reminders: [],
  };
  const l = structuredClone(a);
  l.blocks.splice(1, 1);
  const r = structuredClone(a);
  const m = mergeDocs(a, l, r);
  const texts = m.doc.blocks.map((b) => b.spans?.[0]?.t ?? '');
  assert.deepEqual(texts, ['A', 'C'], '被删的段复活了：' + JSON.stringify(texts));
});

test('合并语义: 一端删段、另一端改同段 → 报冲突且不丢内容', () => {
  const a = {
    v: 1,
    blocks: [
      { t: 'p', spans: [{ t: 'A' }] },
      { t: 'p', spans: [{ t: 'B' }] },
    ],
    reminders: [],
  };
  const l = structuredClone(a);
  l.blocks.splice(1, 1);
  const r = structuredClone(a);
  r.blocks[1].spans = [{ t: 'B改' }];
  const m = mergeDocs(a, l, r);
  assert.equal(m.conflicts.length, 1, '删改同段必须报冲突');
  assert.equal(m.conflicts[0].kind, 'block');
  const texts = m.doc.blocks.map((b) => b.spans?.[0]?.t ?? '');
  assert.ok(texts.includes('B改'), '被改的内容丢了');
});

test('合并语义: 两张不同图片不会被误判成同一块', () => {
  const a = { v: 1, blocks: [{ t: 'img', src: 'https://x.test/a.png' }], reminders: [] };
  const l = structuredClone(a);
  l.blocks[0].src = 'https://x.test/changed.png';
  const r = structuredClone(a);
  r.blocks[0].src = 'https://x.test/b.png';
  const m = mergeDocs(a, l, r);
  assert.equal(m.conflicts.length, 1, '图片同块不同内容应报冲突');
  assert.equal(m.doc.blocks[0].src, 'https://x.test/changed.png');
});

test('合并语义: 提醒按 id 合并，done 单向推进', () => {
  const a = {
    v: 1,
    blocks: [],
    reminders: [{ id: 'r1', at: '2026-10-05T08:30:00+08:00', text: '喝水' }],
  };
  const l = structuredClone(a);
  l.reminders[0].done = true;
  const r = structuredClone(a);
  r.reminders[0].text = '多喝水';
  const m = mergeDocs(a, l, r);
  assert.equal(m.doc.reminders.length, 1);
  assert.equal(m.doc.reminders[0].done, true, '勾选状态丢了');
  assert.equal(m.conflicts.length, 0);
});

test('合并语义: 折叠块内子块独立合并', () => {
  const a = {
    v: 1,
    blocks: [
      {
        t: 'fold',
        title: [{ t: '标题' }],
        children: [
          { t: 'p', spans: [{ t: '子1' }] },
          { t: 'p', spans: [{ t: '子2' }] },
        ],
      },
    ],
    reminders: [],
  };
  const l = structuredClone(a);
  l.blocks[0].children[0].spans = [{ t: '子1改' }];
  const r = structuredClone(a);
  r.blocks[0].children.splice(1, 0, { t: 'p', spans: [{ t: '子插入' }] });
  const m = mergeDocs(a, l, r);
  const kids = m.doc.blocks[0].children?.map((b) => b.spans?.[0]?.t ?? '') ?? [];
  assert.ok(kids.includes('子1改'), '子块左改丢了：' + JSON.stringify(kids));
  assert.ok(kids.includes('子插入'), '子块右插丢了：' + JSON.stringify(kids));
  assert.ok(kids.includes('子2'), '子块未动的丢了');
});

/* ---------------- 工具函数 ---------------- */

test('blockSig 对不同内容必不同（对齐不失真的前提）', () => {
  const a = blockSig({ t: 'img', src: 'https://x.test/a.png' });
  const b = blockSig({ t: 'img', src: 'https://x.test/b.png' });
  assert.notEqual(a, b);
  assert.equal(a, blockSig({ t: 'img', src: 'https://x.test/a.png' }), '同内容签名应稳定');
});

test('emptyDoc 的 canonical 形式是 {"v":1}', () => {
  assert.equal(canonicalize(emptyDoc()), '{"v":1}');
});

test('referencedRemIds 只报真被引用的 id', () => {
  const d = {
    v: 1,
    blocks: [{ t: 'p', spans: [{ t: 'x', rem: 'r1' }, { t: 'y' }] }],
    reminders: [
      { id: 'r1', at: '2026-10-05T08:30:00+08:00', text: 'a' },
      { id: 'r2', at: '2026-10-05T08:30:00+08:00', text: 'b' },
    ],
  };
  const s = referencedRemIds(d);
  assert.ok(s.has('r1'));
  assert.ok(!s.has('r2'), '未被引用的提醒不该算引用');
});

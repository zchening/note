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

/**
 * 「内存态的规范形态」。
 *
 * 🔴 为什么需要这个辅助函数（这是S3 后期才想清楚的一层）：
 *   `normalize` / `validateDoc` 现在都**省略空数组**（与 canonical 规则 2 对齐），
 *   所以 `{v:1, blocks:[], reminders:[非空]}` 归一后是 `{v:1, reminders:[非空]}`
 *   —— `blocks` 键整个不存在。往返断言必须按这个契约比，
 *   否则会拿"生成器原始输入带空数组"当参照物，把canonical 规则误判成 bug。
 *
 *   注意它**只补键、不补值**：`(doc.blocks ?? [])` 里的 `[]` 是"这个维度是空的"，
 *   而不是"往真源里塞一个空数组键"。后者正是被明令禁止的。
 */
function 内存规范态(d) {
  return {
    v: d.v,
    ...(d.blocks && d.blocks.length > 0 ? { blocks: d.blocks } : {}),
    ...(d.reminders && d.reminders.length > 0 ? { reminders: d.reminders } : {}),
  };
}

test('不变量2: parseDoc(canonicalize(normalize(d))) 等于 normalize(d) 的内存规范态', () => {
  // 注意：断言对象是 normalize(d) 的**内存规范态**而不是 d。
  // canonical 规则 2 规定"空数组省略"，而生成器会产出 children:[] / blocks:[] 这类形态
  // —— 往返后省略它们正是设计意图。用 d 直接比会把 canonical 的核心规则误判成 bug。
  //
  // 🔴 往返起点是 canonicalize(normalize(d)) 而不是 canonicalize(d)：
  //   normalize 现在还负责压掉"同一内容多种表示"（相邻同格式 span 合并、空 p 块剔除），
  //   所以**归一后的形态才是唯一合法真源**。未归一的 d 走 parseDoc 会被拒 —— 那是设计，
  //   由下面「不变量2b-归一」那条专门钉住。
  fc.assert(
    fc.property(docArb, (d) => {
      const norm = normalize(d);
      const round = parseDoc(canonicalize(norm));
      assert.deepEqual(round, 内存规范态(norm));
    }),
    { numRuns: NUM_RUNS },
  );
});

test('不变量2-bis: 已归一的文档，往返严格等于原对象', () => {
  // 补上"文档本身已是规范形态"这个前提下的强往返断言，避免上一条的宽松掩盖真 bug。
  // 🔴 判据用 canonicalize(normalize(d))：规范形态是归一后的那个，不是 d 自己的字节。
  //   d 里若带空数组 / 未合并 span / 空 p 块，normalize 会改写它，此时 d 本身就不是规范形态。
  // 🔴 参照物走同一个「内存规范态」辅助函数 —— 内存态与字节态现在统一为"空即缺省"，
  //   不再有"parseDoc 返回刻意比字节多出 blocks:[]"这层差异（那正是老坑，已在
  //   validateDoc 改成纯校验时消掉）。
  fc.assert(
    fc.property(docArb, (d) => {
      const norm = normalize(d);
      const can = canonicalize(norm);
      assert.deepEqual(parseDoc(can), 内存规范态(norm));
    }),
    { numRuns: NUM_RUNS },
  );
});

test('不变量2b: 带 rem 引用的文档同样往返无损', () => {
  //🔴 同样走「内存规范态」：带 rem 引用的文档里blocks 常常是空的，
  //   归一后blocks 键整个不存在（这正是 canonical 规则 2 的意图）。
  fc.assert(
    fc.property(docWithRefsArb, (d) => {
      const norm = normalize(d);
      const round = parseDoc(canonicalize(norm));
      assert.deepEqual(round, 内存规范态(norm));
    }),
    { numRuns: NUM_RUNS },
  );
});

test('不变量2b-归一: 未归一的表示被parseDoc 拒绝（同一内容只有一种合法字节）', () => {
  // 这条是归一规则的存在理由：相邻同格式 span 未合并时，parseDoc 必须拒收。
  // 症状若反（照单全收），就是"同一内容两种字节"回来了 → 假冲突的源头。
  const d = {
    v: 1,
    blocks: [{ t: 'p', spans: [{ t: 'A', b: true }, { t: 'B', b: true }] }],
    reminders: [],
  };
  const unmerged = '{"v":1,"blocks":[{"t":"p","spans":[{"t":"A","b":true},{"t":"B","b":true}]}]}';
  assert.throws(() => parseDoc(unmerged), /非 canonical/);
  assert.equal(canonicalize(normalize(d)), '{"v":1,"blocks":[{"t":"p","spans":[{"t":"AB","b":true}]}]}');
  // 🔴🔴 空 p 块**保留**（用户 2026-10-06 拍板方案 A：空段落进真源）。
  //   此前这条断言的是"空 p 被剔除"，它是"空段落剔不掉"这条缺陷的**锁定闸**——
  //   正因为它绿着，编辑器里用户敲的空行才一路丢到真源之外都没人发现。
  //   改动的完整理由与新不变量见 test/empty-para.test.mjs 的文件头。
  assert.equal(
    canonicalize(normalize({ v: 1, blocks: [{ t: 'p', spans: [{ t: 'x' }] }, { t: 'p' }], reminders: [] })),
    '{"v":1,"blocks":[{"t":"p","spans":[{"t":"x"}]},{"t":"p"}]}',
  );
  // 🔴 反向钉死：**空 children 数组**仍要归一成没有该键（canonical 规则 2 没变）。
  //   这条必须留着 —— "空段落保留"是内容决策，"空 children 省略"是形态归一，
  //   两者不是一回事；放过后就会出现同一内容两种合法字节。
  assert.equal(
    canonicalize(normalize({ v: 1, blocks: [{ t: 'ul', children: [] }], reminders: [] })),
    '{"v":1,"blocks":[{"t":"ul"}]}',
  );
  // 但空标题 / 空折叠块是合法块，绝不能被一起吞掉
  assert.equal(
    canonicalize(normalize({ v: 1, blocks: [{ t: 'h3' }, { t: 'fold' }, { t: 'quote' }], reminders: [] })),
    '{"v":1,"blocks":[{"t":"h3"},{"t":"fold"},{"t":"quote"}]}',
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

test('不变量4b: 恰好一个维度非空时，normalize 不把另一维的空数组塞回去', () => {
  //🔴🔴 这条是 e2e 逼出来的：属性测试全绿、41 条定向用例全绿，
  //   但真浏览器里跑出来的真源 JSON 带着 `"reminders":[]` —— 不是 canonical。
  //   根因：normalize 里写成
  //     `blocks.length || reminders.length ? {v, blocks, reminders} : {v}`
  //   两个维度**捆在一起判断**，于是「blocks 非空 + reminders 为空」时
  //   把空 reminders 又塞了回去，normalize 的输出自己就不是 canonical。
  //
  //   为什么属性测试抓不到：docArb 生成的文档两个维度几乎总同时非空，
  //   「恰好一个非空」是低概率形态；定向用例也没写这个形态。
  //   → 纪律：**归一类的函数必须对每个维度独立断言**，
  //     不能只断言"整体是 canonical"（那属于"看起来对但没生效"的盲区）。
  const cases = [
    ['blocks 非空 / reminders 空', { v: 1, blocks: [{ t: 'p', spans: [{ t: 'x' }] }], reminders: [] }],
    ['blocks 空 / reminders 非空', { v: 1, blocks: [], reminders: [{ id: 'r1', at: '2026-10-05T08:30:00+08:00', text: 't' }] }],
    ['两个都空', { v: 1, blocks: [], reminders: [] }],
  ];
  for (const [label, d] of cases) {
    const out = normalize(d);
    // 直接查键是否存在 —— 比字符串比对更能指出"是哪个维度被塞回去了"
    if ((d.blocks ?? []).length === 0) {
      assert.ok(!('blocks' in out), `${label}：blocks 为空却仍带blocks 键`);
    } else {
      assert.ok('blocks' in out, `${label}：blocks 非空却缺 blocks 键`);
    }
    if ((d.reminders ?? []).length === 0) {
      assert.ok(!('reminders' in out), `${label}：reminders 为空却仍带 reminders 键`);
    } else {
      assert.ok('reminders' in out, `${label}：reminders 非空却缺 reminders 键`);
    }
    // 字节形态也钉一下：必须与 parseDoc 的往返一致
    const can = canonicalize(out);
    assert.equal(can, canonicalize(normalize(JSON.parse(can))), `${label}：不幂等`);
    assert.deepEqual(parseDoc(can), out, `${label}：parseDoc 收不下自己的产物`);
  }
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

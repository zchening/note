/**
 * 序列化层 + 同步状态机 测试
 *
 * 守的不变量（ARCH.md §8 冻结探针第 6 条）：
 *   「模型 → 序列化 → 解析：往返无损」
 *
 * 本文件是那个探针的可执行版本。判据是**逐字节相等**，不是"深等于"：
 *   canonicalize(lexicalToDoc(docToLexical(doc))) === canonicalize(normalize(doc))
 * 用深等于会漏掉一类真实故障：两端对同一内容排出不同的 span 切分，
 * 深比较看着一样，canonical 字节不同 = 一次假冲突 = 用户看到"两边都改过"。
 *
 * 为什么能在 Node 里跑（没有浏览器）：
 *   Lexical 的 headless 模式（createEditor() 不挂 rootElement）能完整走
 *   update / read / getEditorState，全程不碰 DOM，所以序列化层可脱离浏览器单测。
 *   DOM 相关行为（选区、输入法、光标、IME）全部留给 Playwright e2e（ARCH.md §4.6）。
 *
 * 🔴 本文件是 .mjs 不是 .ts：Node 的类型剥离只对 .ts 生效，
 * .mjs 里写 TS 语法会在运行时报 SyntaxError 而不是 tsc 报错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { createEditor, $getRoot } from 'lexical';
import { canonicalize, normalize } from '../../shared-schema/src/canonical.ts';
import { docToLexical, lexicalToDoc } from '../src/serialize.ts';
import { $createReminderMarkNode, $isFoldNode } from '../src/nodes.ts';
import { ALL_NODES } from '../src/node-registry.ts';
import {
  ALL_EVENTS,
  ALL_STATES,
  IllegalTransitionError,
  canTransition,
  reduce,
  snapshotOf,
} from '../src/sync/fsm.ts';

// ── 工具 ────────────────────────────────────────────────────────────────

function newEditor() {
  // 0.52 起节点在 createEditor 时一次性传入（LexicalNodeConfig = Klass），
  // 没有 registerNode 方法了。必须给**全量**清单：少一个就在运行时抛
  // "not configured to be used on the editor"，症状是整篇文档变空。
  return createEditor({ nodes: ALL_NODES });
}

/** 模型 → Lexical → 模型 → canonical 字节 */
function roundTrip(doc) {
  const editor = newEditor();
  editor.update(() => docToLexical(doc), { discrete: true });
  const back = lexicalToDoc(editor.getEditorState(), doc.reminders);
  return canonicalize(normalize(back));
}

/** 参照答案：直接对模型做normalize + canonicalize */
function canonicalOf(doc) {
  return canonicalize(normalize(doc));
}

// ── 定向用例：每种块类型至少一条 ────────────────────────────────────────

test('S3-01空文档往返', () => {
  assert.equal(roundTrip({ v: 1, blocks: [], reminders: [] }), '{"v":1}');
});

test('S3-02 段落 + 全部五种标记', () => {
  const doc = {
    v: 1,
    reminders: [],
    blocks: [
      {
        t: 'p',
        spans: [
          { t: '普通' },
          { t: '粗', b: true },
          { t: '斜', i: true },
          { t: '下划', u: true },
          { t: '删除', s: true },
          { t: '代码', c: true },
          { t: '全标', b: true, i: true, u: true, s: true, c: true },
        ],
      },
    ],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-03 三级标题', () => {
  const doc = {
    v: 1,
    reminders: [],
    blocks: [
      { t: 'h1', spans: [{ t: '一' }] },
      { t: 'h2', spans: [{ t: '二' }] },
      { t: 'h3', spans: [{ t: '三' }] },
    ],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-04 引用', () => {
  const doc = { v: 1, reminders: [], blocks: [{ t: 'quote', spans: [{ t: '引用一段' }] }] };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-05 代码块含语言与多行', () => {
  const doc = {
    v: 1,
    reminders: [],
    blocks: [{ t: 'code', lang: 'js', text: 'const a = 1;\nreturn a;' }],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-06 无语言代码块', () => {
  const doc = { v: 1, reminders: [], blocks: [{ t: 'code', text: '裸文本' }] };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-07 分割线', () => {
  const doc = { v: 1, reminders: [], blocks: [{ t: 'hr' }] };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-08 图片块带 alt', () => {
  const doc = {
    v: 1,
    reminders: [],
    blocks: [{ t: 'img', src: 'https://cdn.example.com/a.png', imgAlt: '一张图' }],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-09 无序列表（含嵌套）', () => {
  const doc = {
    v: 1,
    reminders: [],
    blocks: [
      {
        t: 'ul',
        children: [
          { t: 'li', spans: [{ t: '第一项' }] },
          { t: 'li', spans: [{ t: '第二项' }] },
          {
            t: 'li',
            spans: [{ t: '带子列表' }],
            children: [{ t: 'ul', children: [{ t: 'li', spans: [{ t: '子项' }] }] }],
          },
        ],
      },
    ],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-10 有序列表', () => {
  const doc = {
    v: 1,
    reminders: [],
    blocks: [
      {
        t: 'ol',
        children: [
          { t: 'li', spans: [{ t: '一' }] },
          { t: 'li', spans: [{ t: '二' }] },
        ],
      },
    ],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-11 折叠块带标题与子块', () => {
  const doc = {
    v: 1,
    reminders: [],
    blocks: [
      {
        t: 'fold',
        title: [{ t: '这一段折叠' }],
        children: [
          { t: 'p', spans: [{ t: '里面的正文' }] },
          { t: 'p', spans: [{ t: '第二段' }] },
        ],
      },
    ],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-12 空折叠块（无标题无子块）', () => {
  const doc = { v: 1, reminders: [], blocks: [{ t: 'fold' }] };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-13 折叠块嵌套折叠块（深度 2）', () => {
  const doc = {
    v: 1,
    reminders: [],
    blocks: [
      {
        t: 'fold',
        title: [{ t: '外层' }],
        children: [
          {
            t: 'fold',
            title: [{ t: '内层' }],
            children: [{ t: 'p', spans: [{ t: '最深' }] }],
          },
        ],
      },
    ],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-14 链接 span', () => {
  const doc = {
    v: 1,
    reminders: [],
    blocks: [
      { t: 'p', spans: [{ t: '点我', href: 'https://example.com' }, { t: '后面' }] },
    ],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-15 提醒标记 span（引用真实存在的提醒）', () => {
  const doc = {
    v: 1,
    reminders: [{ id: 'r1', at: '2026-10-06T08:30:00+08:00', text: '记得交房租' }],
    blocks: [{ t: 'p', spans: [{ t: '明天', rem: 'r1' }, { t: '要交房租' }] }],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-16 提醒标记与其它标记叠加', () => {
  const doc = {
    v: 1,
    reminders: [{ id: 'r2', at: '2026-10-06T09:00:00+08:00', text: 'x' }],
    blocks: [
      { t: 'p', spans: [{ t: '粗提醒', b: true, rem: 'r2' }, { t: '普通' }] },
    ],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-17 已完成提醒：done 只在 reminders，标记仍在正文', () => {
  const doc = {
    v: 1,
    reminders: [{ id: 'r3', at: '2026-10-06T09:00:00+08:00', text: 'x', done: true }],
    blocks: [{ t: 'p', spans: [{ t: '做过的事', rem: 'r3', s: true }] }],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-18 全部 12 种块类型混排', () => {
  const doc = {
    v: 1,
    reminders: [{ id: 'rx', at: '2026-10-06T10:00:00+08:00', text: '混排' }],
    blocks: [
      { t: 'h1', spans: [{ t: '标题' }] },
      {
        t: 'p',
        spans: [{ t: '正文', b: true }, { t: '链接', href: 'https://a.example' }],
      },
      { t: 'h2', spans: [{ t: '二级' }] },
      { t: 'quote', spans: [{ t: '引用' }] },
      { t: 'ul', children: [{ t: 'li', spans: [{ t: '项目一' }] }] },
      { t: 'ol', children: [{ t: 'li', spans: [{ t: '序号一' }] }] },
      { t: 'code', lang: 'py', text: 'print(1)' },
      { t: 'hr' },
      { t: 'img', src: 'https://cdn.example.com/x.jpg', imgAlt: '图' },
      {
        t: 'fold',
        title: [{ t: '折叠标题' }],
        children: [{ t: 'p', spans: [{ t: '折叠内' }] }],
      },
      { t: 'p', spans: [{ t: '提醒', rem: 'rx' }] },
      { t: 'h3', spans: [{ t: '三级' }] },
    ],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

// ── 红线 R3：折叠开合状态不进真源 ─────────────────────────────────────

test('S3-19红线R3：展开或收起折叠块，canonical 字节不变', () => {
  const base = {
    v: 1,
    reminders: [],
    blocks: [
      {
        t: 'fold',
        title: [{ t: '标题' }],
        children: [{ t: 'p', spans: [{ t: '正文' }] }],
      },
    ],
  };
  const reference = canonicalOf(base);

  for (const open of [true, false]) {
    const editor = newEditor();
    editor.update(() => docToLexical(base), { discrete: true });
    editor.update(
      () => {
        for (const n of $getRoot().getChildren()) setFoldOpenDeep(n, open);
      },
      { discrete: true },
    );
    const back = lexicalToDoc(editor.getEditorState(), []);
    assert.equal(
      canonicalize(normalize(back)),
      reference,
      `open=${open} 时canonical 字节变了 —— ephemeral 状态泄漏进真源`,
    );
  }
});

function setFoldOpenDeep(node, open) {
  // 用 $isFoldNode 而不是 constructor.name：类型剥离后类名不保证保留。
  if ($isFoldNode(node)) node.setOpen(open);
  if (typeof node.getChildren === 'function') {
    for (const c of node.getChildren()) setFoldOpenDeep(c, open);
  }
}

test('S3-20 红线R3：open 确实被写进了节点（证明上条不是"因为没实现所以字节不变"）', () => {
  const base = {
    v: 1,
    reminders: [],
    blocks: [
      { t: 'fold', title: [{ t: 'T' }], children: [{ t: 'p', spans: [{ t: 'B' }] }] },
    ],
  };
  const seen = [];
  for (const open of [true, false]) {
    const editor = newEditor();
    editor.update(() => docToLexical(base), { discrete: true });
    editor.update(
      () => {
        for (const n of $getRoot().getChildren()) setFoldOpenDeep(n, open);
      },
      { discrete: true },
    );
    editor.getEditorState().read(() => {
      for (const n of $getRoot().getChildren()) seen.push(n.open);
    });
  }
  assert.deepEqual(seen, [true, false], 'FoldNode.open 没有随设置变化，上一条测试是假通过');
});

// ── 属性测试：随机文档往返 ──────────────────────────────────────────────

const textArb = fc.string({ maxLength: 12 });

const spanArb = fc
  .record({
    t: textArb,
    b: fc.option(fc.constant(true), { nil: undefined }),
    i: fc.option(fc.constant(true), { nil: undefined }),
    u: fc.option(fc.constant(true), { nil: undefined }),
    s: fc.option(fc.constant(true), { nil: undefined }),
    c: fc.option(fc.constant(true), { nil: undefined }),
  })
  .map((r) => {
    const out = {};
    for (const k of ['t', 'b', 'i', 'u', 's', 'c']) {
      if (r[k] !== undefined) out[k] = r[k];
    }
    return out;
  })
  .filter((s) => s.t !== '');

function spansBlock(t) {
  return fc
    .record({ t: fc.constant(t), spans: fc.array(spanArb, { maxLength: 4 }) })
    .map((r) => (r.spans.length > 0 ? r : { t: r.t }));
}

// 🔴 自引用（fold/li 的 children 里还有 inlineBlockArb）必须用 fc.let 惰性求值。
// 直接写 const A = fc.oneof(..., fc.array(A)) 会在构造期就求值 A（TDZ 或拿到 undefined），
// 症状是 fast-check 内部 "Cannot read properties of undefined (reading 'generate')" ——
// 报错发生在 fast-check 的generator 里，与真正的缺陷无关，极易误判成"属性测试发现了 bug"。
const lazyInlineBlock = fc.letrec((tie) => ({
  block: fc.oneof(
    spansBlock('p'),
    spansBlock('h1'),
    spansBlock('h2'),
    spansBlock('h3'),
    spansBlock('quote'),
    fc
      .record({
        t: fc.constant('code'),
        text: fc.string({ maxLength: 20 }),
        lang: fc.option(fc.constantFrom('js', 'py', 'ts'), { nil: undefined }),
      })
      .map((r) => {
        const b = { t: 'code' };
        if (r.text !== '') b.text = r.text;
        if (r.lang !== undefined) b.lang = r.lang;
        return b;
      }),
    fc.constant({ t: 'hr' }),
    fc
      .record({
        src: fc.constantFrom('https://cdn.example.com/1.png', 'https://cdn.example.com/2.jpg'),
        imgAlt: fc.string({ maxLength: 6 }),
      })
      .map((r) => {
        const b = { t: 'img', src: r.src };
        if (r.imgAlt !== '') b.imgAlt = r.imgAlt;
        return b;
      }),
    fc
      .record({
        title: fc.array(spanArb, { maxLength: 2 }),
        children: fc.array(tie('block'), { maxLength: 3 }),
      })
      .map((r) => {
        const b = { t: 'fold' };
        if (r.title.length > 0) b.title = r.title;
        if (r.children.length > 0) b.children = r.children;
        return b;
      }),
    fc
      .record({
        t: fc.constantFrom('ul', 'ol'),
        children: fc.array(
          fc
            .record({
              spans: fc.array(spanArb, { maxLength: 3 }),
              children: fc.array(tie('block'), { maxLength: 2 }),
            })
            .map((r) => {
              const b = { t: 'li' };
              if (r.spans.length > 0) b.spans = r.spans;
              if (r.children.length > 0) b.children = r.children;
              return b;
            }),
          { minLength: 1, maxLength: 3 },
        ),
      })
      .map((r) => r),
  ),
})).block;

const reminderArb = fc
  .record({
    at: fc.constantFrom('2026-10-06T08:30:00+08:00', '2026-10-07T09:00:00Z'),
    text: fc.string({ maxLength: 8 }),
    done: fc.option(fc.constant(true), { nil: undefined }),
  })
  // id 由外层按索引注入，保证唯一 —— 用 fc.uniqueArray 的 selector 去重会
  // 在 maxLength + selector 组合下崩（NoopSlicedGenerator 内部空引用）。
  .map((r) => ({ at: r.at, text: r.text, done: r.done }));

const docArb = fc
  .record({
    blocks: fc.array(lazyInlineBlock, { maxLength: 6 }),
    reminders: fc.array(reminderArb, { maxLength: 3 }),
  })
  .map((r) => ({
    v: 1,
    blocks: r.blocks,
    reminders: r.reminders.map((x, i) => {
      const o = { id: 'r' + i, at: x.at, text: x.text };
      if (x.done !== undefined) o.done = true;
      return o;
    }),
  }));

test('S3-21 属性测试：随机文档往返无损（canonical 逐字节相等）', () => {
  fc.assert(
    fc.property(docArb, (doc) => {
      assert.equal(roundTrip(doc), canonicalOf(doc));
    }),
    { numRuns: 400 },
  );
});

test('S3-22 属性测试：往返幂等（连做两次结果不变）', () => {
  fc.assert(
    fc.property(docArb, (doc) => {
      const once = roundTrip(doc);
      assert.equal(roundTrip(JSON.parse(once)), once);
    }),
    { numRuns: 250 },
  );
});

test('S3-23 属性测试：提醒被引用时标记必须重建（span.rem 不能丢）', () => {
  fc.assert(
    fc.property(docArb, (doc) => {
      if (doc.reminders.length === 0) return;
      const editor = newEditor();
      const enriched = JSON.parse(JSON.stringify(doc));
      enriched.blocks = [
        { t: 'p', spans: [{ t: '正文', rem: doc.reminders[0].id }] },
        ...enriched.blocks,
      ];
      editor.update(() => docToLexical(enriched), { discrete: true });
      const back = lexicalToDoc(editor.getEditorState(), enriched.reminders);
      assert.equal(canonicalize(normalize(back)), canonicalOf(enriched));
    }),
    { numRuns: 150 },
  );
});

test('S3-24 属性测试：悬空提醒引用被安全忽略（不抛、不影响其余内容）', () => {
  fc.assert(
    fc.property(docArb, (doc) => {
      const broken = JSON.parse(JSON.stringify(doc));
      broken.blocks = [{ t: 'p', spans: [{ t: '悬空', rem: '不存在的id' }] }, ...broken.blocks];
      const out = roundTrip(broken);
      assert.ok(out.includes('"v":1'));
      // 悬空引用被丢掉，剩下的内容必须完整
      assert.ok(!out.includes('不存在的id'));
    }),
    { numRuns: 150 },
  );
});

// ── 序列化层的额外不变量 ───────────────────────────────────────────────

test('S3-25 相邻同格式 span 必须合并（否则两端 canonical 字节不等 = 假冲突）', () => {
  const doc = {
    v: 1,
    reminders: [],
    blocks: [{ t: 'p', spans: [{ t: '第一段改' }, { t: '第一段' }] }],
  };
  const parsed = JSON.parse(roundTrip(doc));
  const spans = parsed.blocks[0].spans ?? [];
  assert.equal(spans.length, 1, `期望合并为 1 个 span，实际 ${spans.length}`);
  assert.equal(spans[0].t, '第一段改第一段');
});

test('S3-26 空 span 被丢弃（编辑器里没有对应物）', () => {
  const editor = newEditor();
  editor.update(
    () =>
      docToLexical({
        v: 1,
        reminders: [],
        blocks: [{ t: 'p', spans: [{ t: '' }, { t: '有字' }, { t: '' }] }],
      }),
    { discrete: true },
  );
  const back = lexicalToDoc(editor.getEditorState(), []);
  const spans = back.blocks[0].spans ?? [];
  assert.equal(spans.length, 1);
  assert.equal(spans[0].t, '有字');
});

test('S3-27 顶层裸 li 降级为段落（不崩、不丢字）', () => {
  const out = roundTrip({ v: 1, reminders: [], blocks: [{ t: 'li', spans: [{ t: '孤儿项' }] }] });
  assert.ok(out.includes('孤儿项'), out);
});

test('S3-28 FoldNode 的标题不混进正文块序列', () => {
  const editor = newEditor();
  editor.update(
    () =>
      docToLexical({
        v: 1,
        reminders: [],
        blocks: [
          {
            t: 'fold',
            title: [{ t: '把手文字' }],
            children: [{ t: 'p', spans: [{ t: '正文文字' }] }],
          },
        ],
      }),
    { discrete: true },
  );
  const back = lexicalToDoc(editor.getEditorState(), []);
  assert.equal(back.blocks.length, 1);
  assert.equal(back.blocks[0].t, 'fold');
  assert.deepEqual(back.blocks[0].title, [{ t: '把手文字' }]);
  assert.equal(back.blocks[0].children[0].spans[0].t, '正文文字');
});

test('S3-29 ReminderMarkNode 是 inline 且 canBeEmpty 为 false', () => {
  const editor = newEditor();
  let isInline = null;
  let canBeEmpty = null;
  editor.update(
    () => {
      const node = $createReminderMarkNode('r1');
      isInline = node.isInline();
      canBeEmpty = node.canBeEmpty();
      node.remove();
    },
    { discrete: true },
  );
  assert.equal(isInline, true);
  assert.equal(canBeEmpty, false);
});

test('S3-30 空文档导入后编辑器可用（必须留一个可落光标的段落）', () => {
  const editor = newEditor();
  editor.update(() => docToLexical({ v: 1, blocks: [], reminders: [] }), { discrete: true });
  const count = editor.getEditorState().read(() => $getRoot().getChildrenSize());
  assert.equal(count, 1);
});

// ── 同步状态机 ─────────────────────────────────────────────────────────

test('S3-31 FSM：边表与 reducer 一致（穷举 8×14 = 112 组合）', () => {
  for (const from of ALL_STATES) {
    for (const ev of ALL_EVENTS) {
      if (!canTransition(from, ev)) {
        assert.throws(
          () => reduce(from, ev),
          (e) => e instanceof IllegalTransitionError && e.from === from && e.ev === ev,
          `${from}--${ev}--> 应当抛 IllegalTransitionError`,
        );
      } else {
        const next = reduce(from, ev);
        assert.ok(ALL_STATES.includes(next), `${from}--${ev}--> 返回了非法状态 ${next}`);
      }
    }
  }
});

test('S3-32 FSM：locked 态只有解锁一条路', () => {
  assert.deepEqual(
    ALL_EVENTS.filter((ev) => canTransition('locked', ev)),
    ['unlock'],
  );
});

test('S3-33 FSM：主干流程 锁定→同步→干净→脏→推送→干净', () => {
  assert.equal(reduce('locked', 'unlock'), 'syncing');
  assert.equal(reduce('syncing', 'pulled'), 'idle');
  assert.equal(reduce('idle', 'edit'), 'dirty');
  assert.equal(reduce('dirty', 'push'), 'pushing');
  assert.equal(reduce('pushing', 'pushed'), 'idle');
});

test('S3-34 FSM：离线时编辑只标 dirty，绝不尝试推送', () => {
  assert.equal(reduce('offline', 'edit'), 'offline');
  assert.equal(snapshotOf('offline').offline, true);
  assert.equal(reduce('offline', 'online'), 'syncing');
});

test('S3-35 FSM：推送中用户又打字 → 回 dirty（会再推一次，不丢）', () => {
  assert.equal(reduce('pushing', 'edit'), 'dirty');
});

test('S3-36 FSM：冲突态只能由用户裁决或重拉解除', () => {
  assert.equal(reduce('syncing', 'merge-conflict'), 'conflict');
  assert.equal(snapshotOf('conflict').needResolve, true);
  assert.equal(snapshotOf('conflict').readOnly, true);
  assert.equal(canTransition('conflict', 'edit'), false, '未裁决时不该允许继续打字覆盖对方');
  assert.equal(reduce('conflict', 'resolve-local'), 'dirty');
  assert.equal(reduce('conflict', 'resolve-remote'), 'syncing');
});

test('S3-37 FSM：推送失败落offline；锁定可从任何非锁态发生', () => {
  assert.equal(reduce('pushing', 'network-fail'), 'offline');
  for (const st of ALL_STATES) {
    if (st === 'locked') continue;
    assert.equal(reduce(st, 'lock'), 'locked', `${st}--lock--> 应回 locked`);
  }
});

test('S3-38 FSM：snapshot 四个投影与状态一致', () => {
  assert.equal(snapshotOf('locked').locked, true);
  assert.equal(snapshotOf('locked').readOnly, true);
  assert.equal(snapshotOf('dirty').unsaved, true);
  assert.equal(snapshotOf('pushing').unsaved, true);
  assert.equal(snapshotOf('idle').unsaved, false);
  assert.equal(snapshotOf('offline').offline, true);
});
// ── 回归钉：S3 修bug 过程中被逼出来的三条硬约束 ─────────────────────────

test('S3-39 列表项子块装进 ListBodyNode（否则段落被 Lexical 塌陷，层级丢失）', () => {
  // 这条钉住"为什么要有 ListBodyNode 这个节点"：
  // ListItemNode 装单个带 format 的段落时，Lexical 的 setFormatFromChildren
  // 会把段落拆掉、format 上提到 ListItemNode（LexicalListItemNode.ts:723）。
  // 于是"条目自己的字"与"唯一的子段落"结构上同形，导出侧无法区分。
  const doc = {
    v: 1,
    reminders: [],
    blocks: [
      {
        t: 'ul',
        children: [{ t: 'li', children: [{ t: 'p', spans: [{ t: '子', c: true }] }] }],
      },
    ],
  };
  const editor = newEditor();
  editor.update(() => docToLexical(doc), { discrete: true });
  // 结构断言：子块必须在 list-body 里，且带 format 的段落包装没被拆
  editor.getEditorState().read(() => {
    const ul = $getRoot().getFirstChild();
    const li = ul.getFirstChild();
    assert.equal(li.getType(), 'listitem');
    const kids = li.getChildren();
    assert.equal(kids.length, 1, `期望恰好一个 list-body，实际 ${kids.length} 个：${kids.map((k) => k.getType())}`);
    assert.equal(kids[0].getType(), 'list-body');
  });
  // 往返字节不变
  assert.equal(roundTrip(doc), canonicalOf(doc));
});

test('S3-40 条目文字与子块并存时两层各归其位（不互相吞）', () => {
  // 有条目文字 + 有子块：文字进 listitem 直属，子块进 list-body
  const doc = {
    v: 1,
    reminders: [],
    blocks: [
      {
        t: 'ol',
        children: [
          {
            t: 'li',
            spans: [{ t: '条目' }],
            children: [{ t: 'p', spans: [{ t: '正文1' }] }, { t: 'p', spans: [{ t: '正文2' }] }],
          },
        ],
      },
    ],
  };
  assert.equal(roundTrip(doc), canonicalOf(doc));
  // 条目无文字、只有子块：不能把子块搬成条目文字
  const noOwn = {
    v: 1,
    reminders: [],
    blocks: [{ t: 'ul', children: [{ t: 'li', children: [{ t: 'p', spans: [{ t: 'X' }] }] }] }],
  };
  assert.equal(roundTrip(noOwn), canonicalOf(noOwn));
});

test('S3-41 相邻同类型列表在真源层已合并（编辑器结构上装不下两个独立同型列表）', () => {
  // Lexical 的 ListNode transform 会把紧邻的同类型 ul/ol 合成一个
  // （源码注释：merges adjacent same-type lists），所以真源层必须先合并。
  // 异类型不合并（ul 接ol 是合法的两段）。
  const same = { v: 1, reminders: [], blocks: [{ t: 'ul' }, { t: 'ul' }] };
  assert.equal(canonicalOf(same), '{"v":1,"blocks":[{"t":"ul"}]}');
  const diff = { v: 1, reminders: [], blocks: [{ t: 'ul' }, { t: 'ol' }] };
  assert.equal(canonicalOf(diff), '{"v":1,"blocks":[{"t":"ul"},{"t":"ol"}]}');
  // 顺序铁律：先剔空 p 再合并 —— [ul,空p, ul] 里两个 ul 会因剔空而变成相邻
  const withGap = {
    v: 1,
    reminders: [],
    blocks: [{ t: 'ul' }, { t: 'p' }, { t: 'ul' }],
  };
  assert.equal(canonicalOf(withGap), '{"v":1,"blocks":[{"t":"ul"}]}');
});

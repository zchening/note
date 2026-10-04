/**
 * 任意 Doc 生成器（fast-check arbitrary）
 *
 * 关键：必须能生成「刁钻」文档，否则属性测试是自欺欺人。
 * 覆盖：空文档、超长文本、控制字符、emoji（含代理对）、深嵌套 fold、
 * 只有默认值的字段（测 canonical 省略规则）、多图同块（测 blockSig 不失真）。
 *
 * 为什么是 .mjs 而不是 .ts：Node 原生类型剥离不处理 .js/.mjs 里的 TS 语法，
 * 测试文件一律写成纯 JS（类型检查交给 src 与 tsc）。
 */

import fc from 'fast-check';

const T = true;

/** 剔除值为 undefined 的键：canonical 不接受显式 undefined（生成器必须与 validator 同契约） */
const stripUndefined = (o) => {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
};

const textArb = fc.oneof(
  fc.constant(''),
  fc.string({ unit: 'binary', minLength: 1, maxLength: 12 }),
  fc.constantFrom('你好', '🎉🎊', 'á combining', 'ß', '𝕳𝖊𝖑𝖑𝖔', 'a\nb', '　全角', '零宽'),
  fc
    .array(fc.constantFrom('a', '好', '🎉', ' ', '\n', '\t', ''), { minLength: 1, maxLength: 20 })
    .map((a) => a.join('')),
);

/**
 * 标记字段：只有"键不存在"或 true 两种合法态。
 *
 * 关键：不能用 fc.option(..., {nil: undefined}) —— 那会产出**显式 undefined 键**
 * （`{t:'x', b: undefined}`），而 validator 正确地拒绝它（`'b' in s` 为真）。
 * 这里显式剔除 undefined 值，保证生成器只产出 canonical 认可的形态。
 * 这个错配本身就是一条收获：validator 的"未知键/显式默认值一律拒"确实在生效。
 */
const mark = () => fc.option(fc.constant(T), { nil: undefined });

const spanArb = fc
  .record({ t: textArb, b: mark(), i: mark(), u: mark(), s: mark(), c: mark() })
  .map((s) => {
    const out = { t: s.t };
    for (const k of ['b', 'i', 'u', 's', 'c']) if (s[k] === true) out[k] = true;
    return out;
  });

const spansArb = fc.array(spanArb, { maxLength: 8 });

const plainBlockArb = fc.oneof(
  ...['p', 'h1', 'h2', 'h3', 'quote'].map((t) =>
    fc.record({ t: fc.constant(t), spans: spansArb }, { requiredKeys: ['t', 'spans'] }),
  ),
  fc
    .record(
      {
        t: fc.constant('code'),
        text: textArb,
        lang: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
      },
      { requiredKeys: ['t', 'text'] },
    )
    .map(stripUndefined),
  fc.record({ t: fc.constant('hr') }, { requiredKeys: ['t'] }),
  fc
    .record(
      {
        t: fc.constant('img'),
        src: fc.constantFrom('https://x.test/a.png', 'https://x.test/b.jpg', 'https://x.test/a.png'),
        imgAlt: fc.option(fc.constant('图'), { nil: undefined }),
      },
      { requiredKeys: ['t', 'src'] },
    )
    .map(stripUndefined),
  fc.record({ t: fc.constant('li'), spans: spansArb }, { requiredKeys: ['t', 'spans'] }),
  fc.record({ t: fc.constant('ul') }, { requiredKeys: ['t'] }),
  fc.record({ t: fc.constant('ol') }, { requiredKeys: ['t'] }),
  fc.record({ t: fc.constant('fold'), title: spansArb }, { requiredKeys: ['t', 'title'] }),
);

/** 容器块（可带 children），depth 控制嵌套深度 */
function blockArb(depth) {
  if (depth <= 0) return plainBlockArb;
  const container = fc.oneof(
    fc.record(
      {
        t: fc.constant('fold'),
        title: spansArb,
        children: fc.array(blockArb(depth - 1), { maxLength: 3 }),
      },
      { requiredKeys: ['t', 'title'] },
    ),
    fc.record(
      {
        t: fc.constant('li'),
        spans: spansArb,
        children: fc.array(blockArb(depth - 1), { maxLength: 3 }),
      },
      { requiredKeys: ['t', 'spans'] },
    ),
    fc.record(
      { t: fc.constant('ul'), children: fc.array(blockArb(depth - 1), { maxLength: 3 }) },
      { requiredKeys: ['t', 'children'] },
    ),
    fc.record(
      { t: fc.constant('ol'), children: fc.array(blockArb(depth - 1), { maxLength: 3 }) },
      { requiredKeys: ['t', 'children'] },
    ),
  );
  return fc.oneof(plainBlockArb, container);
}

const remIdArb = fc
  .array(fc.string({ minLength: 1, maxLength: 6, unit: 'grapheme' }), { minLength: 1, maxLength: 6 })
  .map((a) => a.join(''));

const AT = '2026-10-05T08:30:00+08:00';

/**
 * 文档生成器。reminders 的 id 强制去重（抽 id 集合再映射），
 * 否则 validate 会因 E_REMINDER_DUP_ID 拒绝，测试就变成在测 validator 而非 canonical。
 * span.rem 一律不生成（悬空引用），引用完整性由 validator 定向用例单独钉。
 */
export const docArb = fc
  .record(
    {
      blocks: fc.array(blockArb(2), { maxLength: 8 }),
      ids: fc.uniqueArray(remIdArb, { minLength: 0, maxLength: 4 }),
    },
    { requiredKeys: ['blocks', 'ids'] },
  )
  .map(({ blocks, ids }) => ({
    v: 1,
    blocks,
    reminders: ids.map((id) => ({ id, at: AT, text: 'r-' + id })),
  }));

/** 带 span.rem 的合法文档（用于引用完整性与「删提醒要清干净」测试） */
export const docWithRefsArb = fc
  .record(
    {
      blocks: fc.array(
        fc.record({ t: fc.constant('p'), spans: spansArb }, { requiredKeys: ['t', 'spans'] }),
        { maxLength: 5 },
      ),
      ids: fc.uniqueArray(remIdArb, { minLength: 1, maxLength: 4 }),
    },
    { requiredKeys: ['blocks', 'ids'] },
  )
  .map(({ blocks, ids }) => {
    const reminders = ids.map((id) => ({ id, at: AT, text: 'r-' + id }));
    // 按块序轮转分配 rem 引用；t 为空的 span 不挂标记（那是纯锚点，语义上无内容）
    let k = 0;
    const withRefs = blocks.map((b) => ({
      ...b,
      spans: (b.spans ?? []).map((s) => {
        if (s.t.length > 0 && k < ids.length) {
          const pick = ids[k % ids.length];
          k++;
          return { ...s, rem: pick };
        }
        return s;
      }),
    }));
    return { v: 1, blocks: withRefs, reminders };
  });

/** 纯文本串（给 diff3 字符级测试做更针对性的输入） */
export const textLineArb = fc
  .array(fc.string({ minLength: 1, maxLength: 20, unit: 'grapheme' }), { maxLength: 6 })
  .map((a) => a.join(''));

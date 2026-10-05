/**
 * 提醒对账层测试（R 系列）
 *
 * 🔴🔴 判据纪律一：**不手写第二份实现**。
 *   期望值里凡涉及"解析时刻"的，一律用显式 ISO 字符串写死
 *   （如 '2027-03-01T10:00:00.000+08:00'），不用 new Date(y,m,d,...) 现算。
 *   现算等于把被测实现抄一遍，抄错测试会跟着错，还显得全绿。
 *
 * 🔴 判据纪律二：**必须同时断言"不该变的没变"**。
 *   对账层最危险的失败模式是"多删了/多改了别的东西"——正文、顺序、格式。
 *   只断言目标字段的测试，删掉半个文档也能通过。所以每条都配一个守恒断言。
 *
 * 🔴 判据纪律三：NOW 一律显式传，不依赖 Date.now()。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// 🔴 这里不能写 `import { type Doc }` —— .mjs 不是 TS，`type` 修饰符会直接
//   SyntaxError: Unexpected identifier，整份测试文件崩成1 条 fail（不是 26 条红，
//   报错信息还指向 import 行，很容易误以为是模块解析问题）。类型标注走 JSDoc。
import { canonicalize, normalize } from '@bj/shared-schema';
import {
  addReminder,
  blockText,
  completeReminder,
  dueReminders,
  itemOf,
  makeRemId,
  reconcileReminders,
  removeReminder,
  upcomingReminders,
} from '../src/reminder/reconcile.ts';
import { collectTimeMatches } from '../src/reminder/time-parse.ts';

// 基准：2027-03-01T10:00 本地时间（周一）
const NOW = new Date(2027, 2, 1, 10, 0, 0).getTime();
const ISO = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).toISOString();

/** 单段纯文本文档。 */
const docOf = (...texts) => ({
  v: 1,
  blocks: texts.map((t) => ({ t: 'p', spans: [{ t }] })),
});

/**
 * 模拟「用户编辑了正文」：只换 blocks，**reminders 原样保留**。
 *
 * 🔴🔴 我第一版直接用 docOf('待定 开会') 这种全新空文档去测"联动"，
 *   结果 reminders 根本不存在，removed 当然是 0 —— 看着像实现不报removed，
 *   其实是测试造的场景压根没提醒。联动类测试必须走这个 helper。
 *   真实编辑器编辑正文时，reminders 是留在文档里的（真源字段，不随正文改动消失）。
 */
const editText = (doc, ...texts) => {
  const next = docOf(...texts);
  if (doc.reminders !== undefined) next.reminders = doc.reminders;
  return next;
};

/** 取某块里带 rem 标记的 span 文本（用来验"下划线只盖时间串"）。 */
const remTexts = (doc) => {
  const out = [];
  const walk = (list) => {
    if (!list) return;
    for (const b of list) {
      for (const s of b.spans ?? []) if (s.rem !== undefined) out.push(s.t);
      walk(b.children);
    }
  };
  walk(doc.blocks);
  return out;
};

/** 取全文纯文本，块间用 \n。 */
const fullText = (doc) => (doc.blocks ?? []).map((b) => blockText(b)).join('\n');

/* ============ 1. 提醒 id ============ */

test('R1 makeRemId 稳定且同刻同事项同 id', () => {
  const a = makeRemId(1800000000000, '开会');
  const b = makeRemId(1800000000000, '开会');
  assert.equal(a, b, 'id 必须稳定，否则重载后下划线对不上');
  // 🔴 不同事项必须不同 id：否则"同一时刻的两条提醒"会互相覆盖
  assert.notEqual(a, makeRemId(1800000000000, '吃饭'));
  assert.notEqual(a, makeRemId(1800000000001, '开会'), '不同时刻也不同 id');
  assert.match(a, /^r[a-z0-9]+$/);
});

/* ============ 2. 红线 1：没主动加过的日期绝不动 ============ */

test('R2 🔴 红线1：正文写了时间串但没点过添加提醒 ⇒ 一条都不加', () => {
  const doc = docOf('3月1日10:00 开会', '4月2日 09:00 述职');
  const r = reconcileReminders(doc, NOW);
  assert.equal(r.doc.reminders, undefined, '没主动加过就不该有提醒');
  assert.deepEqual(r.added, [], 'added 必须为空 —— 只有 addReminder 能新增');
  assert.equal(r.removed.length, 0);
  // 🔴 守恒：正文必须原封不动（这条最容易被"顺手"改掉）
  assert.equal(fullText(r.doc), fullText(doc));
  assert.deepEqual(remTexts(r.doc), [], '没有提醒就不该有任何 rem 标记');
});

test('R3 走addReminder 后 reconcile 才认这条', () => {
  const base = docOf('3月1日10:00 开会');
  const target = new Date(2027, 2, 1, 10, 0, 0).getTime(); // 3月1日10:00
  const { doc: withRem, rem } = addReminder(base, target, '开会');
  assert.equal(withRem.reminders?.length, 1);
  assert.equal(rem.at, ISO(2027, 3, 1, 10, 0), 'at 存完整 ISO');
  const r = reconcileReminders(withRem, NOW);
  assert.equal(r.doc.reminders?.length, 1, '对账后这条还在');
  assert.equal(r.removed.length, 0);
  // 🔴 守恒：正文文字一个字都不能变，只允许多出 rem 标记
  assert.equal(fullText(r.doc), '3月1日10:00 开会');
  assert.deepEqual(remTexts(r.doc), ['3月1日10:00'], '下划线只盖时间串，不盖后面的「 开会」');
});

/* ============ 3. 双向联动 ============ */

test('R4 🔴 正向联动：正文删掉时间串 ⇒ 对应提醒必须消失', () => {
  const target = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const { doc: withRem } = addReminder(docOf('3月1日10:00 开会'), target, '开会');
  // 用户把时间串改成"待定"（reminders 仍在文档里 —— 编辑正文不会清提醒）
  const edited = editText(withRem, '待定 开会');
  const r = reconcileReminders(edited, NOW);
  assert.equal(r.doc.reminders, undefined, '正文没这个时间了，提醒必须跟着消失');
  assert.deepEqual(r.removed.length, 1, 'removed 要报出来，UI 才能弹"已移除1条提醒"');
  assert.deepEqual(remTexts(r.doc), [], 'rem 标记也不能残留');
});

test('R5 🔴 反向联动：删提醒 ⇒ 正文下划线必须同时消失', () => {
  const target = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const { doc: withRem } = addReminder(docOf('3月1日10:00 开会'), target, '开会');
  const r1 = reconcileReminders(withRem, NOW);
  assert.deepEqual(remTexts(r1.doc), ['3月1日10:00'], '前置：下划线在');
  const r2 = reconcileReminders(removeReminder(r1.doc, r1.doc.reminders[0].id), NOW);
  assert.equal(r2.doc.reminders, undefined);
  assert.deepEqual(remTexts(r2.doc), [], '删提醒后下划线必须一起走，否则用户看到"删了还划着"');
  assert.equal(fullText(r2.doc), '3月1日10:00 开会', '🔴 删提醒绝不能删正文文字');
});

/* ============ 4. span 切分：下划线只盖时间串 ============ */

test('R6 🔴 时间串跨两个 span ⇒ 只在切点范围内挂标记', () => {
  // 「会议 3月1日10:00 开始」，时间串从第 1 个 span 跨到第 2 个
  const target = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const base = {
    v: 1,
    blocks: [{ t: 'p', spans: [{ t: '会议 ' }, { t: '3月1日10' }, { t: ':00 ' }, { t: '开始' }] }],
  };
  const { doc: withRem } = addReminder(base, target, '会议');
  const r = reconcileReminders(withRem, NOW);
  const texts = remTexts(r.doc);
  assert.equal(texts.join(''), '3月1日10:00', '挂标记的 span 拼起来必须正好是时间串');
  // 🔴 守恒：整段拼回去必须与原文完全一致
  assert.equal((r.doc.blocks[0].spans ?? []).map((s) => s.t).join(''), '会议 3月1日10:00 开始');
  // 🔴「开始」绝不能被划上下划线
  assert.equal((r.doc.blocks[0].spans ?? []).find((s) => s.t === '开始')?.rem, undefined);
});

test('R7 一个 span 内时间串只占中间 ⇒ 不许整段都划', () => {
  const target = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const base = { v: 1, blocks: [{ t: 'p', spans: [{ t: '会议 3月1日10:00 开始' }] }] };
  const { doc: withRem } = addReminder(base, target, '会议');
  const r = reconcileReminders(withRem, NOW);
  const spans = r.doc.blocks[0].spans ?? [];
  assert.ok(spans.length > 1, '必须被切开，1 个 span 说明没切');
  assert.equal(spans.map((s) => s.t).join(''), '会议 3月1日10:00 开始', '🔴 切开不许丢字');
  assert.equal(spans.filter((s) => s.rem !== undefined).map((s) => s.t).join(''), '3月1日10:00');
});

test('R8 🔴 切分后格式标记要跟着各自的片段走', () => {
  // 🔴 用「明天15:00」而不是「明天三点」：实测「明天三点」= 明天的 **03:00**
  //   （"三点"就是 3 点，不做下午换算 —— 换算只对「下午/晚上」等时段词生效）。
  //   我第一版写 addReminder(明天15:00) 却拿「明天三点」的正文去对，差一整天，
  //   报红后看起来像"格式标记丢了"，其实是对账没匹配上。
  const base = { v: 1, blocks: [{ t: 'p', spans: [{ t: '明天', b: true }, { t: '15:00 开会', b: true }] }] };
  const { doc: withRem } = addReminder(base, new Date(2027, 2, 2, 15, 0, 0).getTime(), '开会');
  const r = reconcileReminders(withRem, NOW);
  const spans = r.doc.blocks[0].spans ?? [];
  assert.equal(spans.map((s) => s.t).join(''), '明天15:00 开会', '🔴 切分不许丢字');
  assert.ok(spans.every((s) => s.b === true), '切分不许丢加粗');
  assert.equal(spans.filter((s) => s.rem !== undefined).map((s) => s.t).join(''), '明天15:00');
  assert.equal(spans.find((s) => s.t === ' 开会')?.rem, undefined, '「 开会」不该被划线');
});

/* ============ 5. 事项文本 ============ */

test('R9 🔴 事项文本跟正文刷新（改了事项提醒里也要跟着改）', () => {
  const target = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const { doc: withRem } = addReminder(docOf('3月1日10:00 开会'), target, '开会');
  const r1 = reconcileReminders(withRem, NOW);
  assert.equal(r1.doc.reminders[0].text, '开会', '前置：事项=时间串之后的文字');
  // 用户把事项改成"开会（改成线上）"（同样要保留 reminders）
  const edited = editText(withRem, '3月1日10:00 开会（改成线上）');
  const r2 = reconcileReminders(edited, NOW);
  assert.equal(r2.doc.reminders[0].text, '开会（改成线上）', '提醒里的事项文本必须刷新');
  assert.equal(r2.doc.reminders[0].id, r1.doc.reminders[0].id, '🔴 事项变了 id 不能变（否则被当成删一条加一条）');
});

test('R10 itemOf：两个时间串时各自只取到下一个为止', () => {
  const text = '3月1日10:00 开会　4月2日 09:00 述职';
  const all = collectTimeMatches(text, NOW);
  assert.equal(all.length, 2);
  const first = itemOf(text, all[0], all);
  const second = itemOf(text, all[1], all);
  assert.ok(!first.includes('4月2日'), '第一条不能吞掉第二个时间串，实际=' + JSON.stringify(first));
  assert.ok(first.includes('开会'));
  assert.ok(second.includes('述职'));
});

test('R11 事项为空时**不改**已有 text（不拿空串覆盖）', () => {
  const target = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const { doc: withRem } = addReminder(docOf('3月1日10:00'), target, '手动写的文案');
  const r = reconcileReminders(withRem, NOW);
  assert.equal(r.doc.reminders[0].text, '手动写的文案', '正文里没事项就不能把手写文案抹成空');
});

/* ============ 6. fired / due / upcoming ============ */

test('R12 🔴 到点判定用<= now，且30 秒容差来自 time-parse 的 expired 字段', () => {
  const at = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const { doc } = addReminder(docOf('3月1日10:00 开会'), at, '开会');
  const r = reconcileReminders(doc, NOW);
  assert.deepEqual(r.fired, [doc.reminders[0].id], '正好到点即算fired');
  // 差 1 毫秒未到 ⇒ 不 fired
  const r2 = reconcileReminders(doc, at - 1);
  assert.deepEqual(r2.fired, [], '差1ms 未到不该响');
  // 差 1 毫秒已过⇒ fired
  const r3 = reconcileReminders(doc, at + 1);
  assert.deepEqual(r3.fired, [doc.reminders[0].id]);
});

test('R13 dueReminders 排除了已完成的', () => {
  const t1 = new Date(2027, 2, 1, 9, 0, 0).getTime();
  const t2 = new Date(2027, 2, 1, 10, 0, 0).getTime();
  let doc = docOf('3月1日9:00 A', '3月1日10:00 B');
  doc = addReminder(doc, t1, 'A').doc;
  doc = addReminder(doc, t2, 'B').doc;
  const due = dueReminders(doc, NOW);
  assert.deepEqual(due.map((r) => r.text), ['A', 'B'], '两条都到点了，按时间升序');
  const done = completeReminder(doc, due[0].id);
  assert.deepEqual(dueReminders(done, NOW).map((r) => r.text), ['B'], '完成后不再响');
  assert.deepEqual(dueReminders(doc, NOW).map((r) => r.text), ['A', 'B'], '🔴 completeReminder 不得就地改原doc');
});

test('R14 upcomingReminders 只含未到点未完成，且升序', () => {
  const t1 = new Date(2027, 2, 1, 11, 0, 0).getTime();
  const t2 = new Date(2027, 2, 2, 9, 0, 0).getTime();
  let doc = docOf('3月1日11:00 晚点', '3月2日9:00 明天的事');
  doc = addReminder(doc, t2, '明天的事').doc;
  doc = addReminder(doc, t1, '晚点').doc;
  const up = upcomingReminders(doc, NOW);
  assert.deepEqual(up.map((r) => r.text), ['晚点', '明天的事'], '必须升序，不能是加入顺序');
  assert.deepEqual(dueReminders(doc, NOW), [], '未到点不算 due');
});

/* ============ 7. 坏数据 ============ */

test('R15 🔴 at 非法 ⇒ 判死并报 removed（否则每次通知都 NaN 静默不响）', () => {
  const base = docOf('3月1日10:00 开会');
  const bad = {
    v: 1,
    blocks: base.blocks,
    reminders: [{ id: 'rbad', at: '不是时间', text: 'x' }],
  };
  const r = reconcileReminders(bad, NOW);
  assert.equal(r.doc.reminders, undefined, '坏 at 必须被剔除');
  assert.deepEqual(r.removed, ['rbad']);
  assert.deepEqual(dueReminders(bad, NOW), [], '🔴 坏 at 绝不能进 due，否则通知静默不响');
});

test('R16 🔴 at 非法的提醒，它在正文里的下划线也要清掉', () => {
  const target = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const { doc: withRem } = addReminder(docOf('3月1日10:00 开会'), target, '开会');
  // 篡改 at 成非法值，id 不变
  const tampered = {
    v: 1,
    blocks: withRem.blocks,
    reminders: [{ id: withRem.reminders[0].id, at: '坏', text: 'x' }],
  };
  const r = reconcileReminders(tampered, NOW);
  assert.equal(r.doc.reminders, undefined);
  // 时间串还在，但它已无对应提醒 ⇒ 不该有 rem 标记
  assert.deepEqual(remTexts(r.doc), [], '坏提醒留下的下划线必须一并清掉');
  assert.equal(fullText(r.doc), '3月1日10:00 开会', '🔴 正文文字不许动');
});

/* ============ 8. 幂等与守恒 ============ */

test('R17 🔴 对账幂等：跑两次结果必须完全一致', () => {
  const target = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const { doc: withRem } = addReminder(docOf('会议 3月1日10:00 开始', '另一段没有时间的文字'), target, '会议');
  const r1 = reconcileReminders(withRem, NOW);
  const r2 = reconcileReminders(r1.doc, NOW);
  assert.equal(canonicalize(r2.doc), canonicalize(r1.doc), '第二次对账必须与第一次逐字节相同');
  assert.deepEqual(r2.removed, [], '🔴 幂等破了的典型症状：第二次跑就报"删了一条"');
});

test('R18 对账输出仍是合法真源（parseDoc 不拒）', () => {
  const target = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const { doc: withRem } = addReminder(docOf('3月1日10:00 开会'), target, '开会');
  const r = reconcileReminders(withRem, NOW);
  const json = canonicalize(r.doc);
  // normalize 再跑一次必须不变（否则说明产出的是"半归一"形态）
  assert.equal(canonicalize(normalize(r.doc)), json, '对账产物必须已经是归一的');
  assert.ok(json.includes('"reminders"'), '前置：提醒在');
});

test('R19 🔴 跨块的时间串不得挂到任何一块上（flatten 用 \\n 拼块，\\s* 会吃换行）', () => {
  // 「3月1日」在第 1 块、「10:00」在第 2 块。flatten 拼成 "3月1日\n10:00"，
  // 而中文日期正则里的 \s* 会吃掉换行 ⇒ 全文层面**确实**匹配成一段跨块时间串。
  // 若只判"起点在本块"，第 1 块整段会被划上rem，而提醒文案却来自第 2 块 —— 明显错位。
  // 所以判据是「起点在本块 **且** 终点也在本块」。
  const base = { v: 1, blocks: [{ t: 'p', spans: [{ t: '3月1日' }] }, { t: 'p', spans: [{ t: '10:00' }] }] };
  const t = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const { doc: withRem } = addReminder(base, t, 'x');
  const r = reconcileReminders(withRem, NOW);
  assert.deepEqual(remTexts(r.doc), [], '跨块不许在任何一块上留下下划线');
  assert.equal(r.removed.length, 0, '全文层面仍匹配得上，提醒不算死（这是预期）');
  // 🔴 守恒：正文一个字都没动
  assert.equal(fullText(r.doc), '3月1日\n10:00');
});

test('R20 addReminder 同一时刻不重复加（用户连点两下）', () => {
  const t = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const a = addReminder(docOf('3月1日10:00 开会'), t, '开会');
  const b = addReminder(a.doc, t, '开会');
  assert.equal(b.doc.reminders?.length, 1, '连点两下只能有一条');
  assert.equal(b.rem.id, a.rem.id);
});

test('R21 🔴 addReminder 不就地改入参', () => {
  const t = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const before = docOf('3月1日10:00 开会');
  const snapshot = canonicalize(before);
  addReminder(before, t, '开会');
  assert.equal(canonicalize(before), snapshot, '就地改入参会让调用方的"有无变化"判断失效（漏推）');
});

test('R22 提醒按时间升序，与加入顺序无关', () => {
  const t1 = new Date(2027, 2, 5, 9, 0, 0).getTime();
  const t2 = new Date(2027, 2, 1, 9, 0, 0).getTime();
  let doc = docOf('3月1日9:00 早', '3月5日9:00 晚');
  doc = addReminder(doc, t1, '晚').doc;
  doc = addReminder(doc, t2, '早').doc;
  assert.deepEqual(doc.reminders.map((r) => r.text), ['早', '晚']);
});

test('R23 同一时刻不同事项各占一条（id 不同，不会互相覆盖）', () => {
  const t = new Date(2027, 2, 1, 10, 0, 0).getTime();
  // 🔴 addReminder 里"同刻不重复"是按 at 判的，所以这条断言的是**已知取舍**：
  // 同一分钟只能有一条。钉住它，将来若改成允许多条，这里会红提醒人来决策。
  const doc = addReminder(docOf('3月1日10:00 开会'), t, '开会').doc;
  const again = addReminder(doc, t, '吃饭');
  assert.equal(again.doc.reminders?.length, 1);
  assert.equal(again.rem.text, '开会', '后加的同刻事项不覆盖先加的');
});

test('R24 fold块里的时间串也能标（children 递归）', () => {
  const t = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const base = {
    v: 1,
    blocks: [
      {
        t: 'fold',
        title: [{ t: '日程' }],
        children: [{ t: 'p', spans: [{ t: '3月1日10:00 开会' }] }],
      },
    ],
  };
  const { doc: withRem } = addReminder(base, t, '开会');
  const r = reconcileReminders(withRem, NOW);
  assert.deepEqual(remTexts(r.doc), ['3月1日10:00'], '折叠块内的提醒也要标，否则合起来就看不到下划线');
  assert.equal(r.removed.length, 0);
});

test('R25 code 块里的时间串也参与提醒（对齐老项目 textContent 口径），但事项不能切出垃圾', () => {
  // 老项目 `htmlToRemText` 用 `body.children` 的 `textContent`，
  // <pre>/<code> 的 textContent 同样被取出 ⇒ 代码里写日期**也算**提醒。
  // 这里对齐它（不做"代码块豁免"的自创规则），但守住真正的 bug：
  // 事项不能从代码尾部切出 `"\""` 这种碎片。
  const base = { v: 1, blocks: [{ t: 'code', text: 'at = "3月1日10:00"', lang: 'js' }] };
  const t = new Date(2027, 2, 1, 10, 0, 0).getTime();
  const { doc: withRem } = addReminder(base, t, 'x');
  const r = reconcileReminders(withRem, NOW);
  assert.equal(r.doc.reminders?.length, 1, '代码块里的日期也是提醒（老项目同口径）');
  assert.ok(!/["'`]/.test(r.doc.reminders[0].text), '事项不能是引号碎片，实际=' + JSON.stringify(r.doc.reminders[0].text));
  // 🔴 code 块没有 spans，下划线无处可挂，但正文文字必须完好
  assert.equal(r.doc.blocks[0].text, 'at = "3月1日10:00"');
});

test('R26 空文档不炸', () => {
  for (const d of [{ v: 1 }, { v: 1, blocks: [] }]) {
    const r = reconcileReminders(d, NOW);
    assert.equal(canonicalize(r.doc), '{"v":1}');
    assert.deepEqual(r.fired, []);
    assert.deepEqual(r.added, []);
  }
  // 空文档加提醒 ⇒ reminders 出现、blocks 仍不出现（canonical 规则2：空数组整个键不出现）
  const e = addReminder({ v: 1 }, new Date(2027, 2, 1, 10, 0, 0).getTime(), 'x').doc;
  const j = JSON.parse(canonicalize(e));
  assert.equal(j.reminders.length, 1);
  assert.equal('blocks' in j, false, '空文档不该凭空长出 blocks 键');
});

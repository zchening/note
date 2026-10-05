/**
 * 提醒时间格式化测试（F 系列）
 *
 * 🔴 本文件守的是一条极隐蔽的链路：
 *   面板添加提醒 → 回写正文一行「时间　事项」→ 下次对账要靠解析层认出这条提醒。
 *   这条链上任何一环格式漂移，用户体感都是"提醒刚加就没了"，而且**界面上没有任何报错**。
 *   所以这里不只测每个函数的输出，还测**它们互逆**（写入的东西解析层认得）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtLate, fmtRelDay, fmtRemInsert, fmtRemTime, itemForChip, matchAtCaret } from '../src/reminder/format.ts';
import { collectTimeMatches } from '../src/reminder/time-parse.ts';

const NOW = new Date(2027, 2, 1, 10, 0, 0).getTime(); // 2027-03-01 10:00 周一
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

/* ============ 1. fmtRemTime：显示格式 ============ */

test('F1 fmtRemTime 用短形态不补零（月日都不补）', () => {
  // 🔴 判据逐字写死：这是用户看惯的样子，改成 03-01 就是改体验
  assert.equal(fmtRemTime(at(2027, 3, 1, 10, 0)), '2027-3-1 10:00');
  assert.equal(fmtRemTime(at(2027, 12, 25, 8, 5)), '2027-12-25 8:05');
  assert.equal(fmtRemTime(at(2027, 3, 1, 0, 0)), '2027-3-1 0:00');
  // 分钟必须补零（"8:5"会被解析器读成别的）
  assert.equal(fmtRemTime(at(2027, 3, 1, 8, 5)), '2027-3-1 8:05');
});

test('F2 fmtRemTime 接受 ISO 字符串与非法值', () => {
  // 🔴🔴 判据必须**时区无关**，这是 CI 抓出来的真实缺陷。
  //   初版写死 `fmtRemTime('2027-03-01T10:00:00.000+08:00') === '2027-3-1 10:00'` ——
  //   而 fmtRemTime 用的是 getFullYear/getHours 等**本地时区** getter（这是对的设计：
  //   用户看到的提醒时刻就该是用户所在时区的钟点）。
  //   ⇒ 那条断言只在 GMT+8 成立。开发者本机在 GMT+8 → 长期全绿；
  //     GitHub Actions runner 是 **UTC** → 同一个值渲染成 2:00 → CI 红。
  //   这类"本地绿、CI红"最坑的地方在于：它看起来像实现坏了，而实现是对的。
  //   修法不是把实现改成按偏移渲染（那会让东八区用户看到UTC 钟点，反而错），
  //   而是把断言构造成时区无关：先用本机时区造出那个时刻，再取它的 ISO 串。
  //   这样测的回到用例本意 ——「接受 ISO 字符串」这件事本身。
  const local = new Date(2027, 2, 1, 10, 0, 0); // 本机时区的 2027-3-1 10:00
  assert.equal(fmtRemTime(local.toISOString()), '2027-3-1 10:00',
    'ISO 字符串应被接受，且按本地时区渲染成同样的钟点');
  // 带偏移的串也一并验（提醒模型存的是带偏移的完整 ISO，这是实际入参形态）
  assert.equal(fmtRemTime('2027-03-01T10:00:00.000+08:00'),
    fmtRemTime(Date.parse('2027-03-01T10:00:00.000+08:00')),
    '带偏移的 ISO 应与同一时刻的本地渲染一致（同一个时刻不该有两种显示）');

  assert.equal(fmtRemTime('不是时间'), '', '非法值返回空串而不是 "NaN-NaN-NaN"');
  assert.equal(fmtRemTime(Number.NaN), '');
});

/* ============ 2. 互逆：写入的东西解析层必须认得 ============ */

test('F3 🔴🔴 写入正文的提醒行，解析层必须原样认回（提醒不会自己消失）', () => {
  // 这一条是整条链路的命门：面板加提醒 → fmtRemInsert 回写正文 →
  // 下次对账用 collectTimeMatches 找它。认不回来 ⇒ 提醒被判死 ⇒ 用户体感"刚加就没了"。
  const samples = [
    [2027, 3, 1, 10, 0],
    [2027, 12, 25, 8, 5],
    [2027, 3, 1, 0, 0],
    [2027, 3, 1, 23, 59],
    [2026, 1, 1, 0, 0],
  ];
  for (const [y, mo, d, h, mi] of samples) {
    const t = at(y, mo, d, h, mi);
    const line = `${fmtRemInsert(t)}　${y}年的会`; // 全角空格分隔事项（老项目回写格式）
    const hits = collectTimeMatches(line, NOW);
    assert.equal(hits.length, 1, `应恰好命中 1 条，实际 ${hits.length}：${JSON.stringify(line)}`);
    assert.equal(hits[0].at, t, `时刻必须完全一致：${JSON.stringify(line)} → ${new Date(hits[0].at)}`);
    // 命中的范围必须正好是时间那一段，事项不能被吞进匹配里
    assert.equal(line.slice(hits[0].index, hits[0].index + hits[0].length), fmtRemInsert(t));
  }
});

test('F4 事项区（全角空格之后）的**相对时间**不再命中；绝对日期不受此约束（老项目口径）', () => {
  // 🔴 老项目实跑结论：`2027-3-1 10:00　4月2日 09:00 述职` 命中 **2 条**。
  //   事项区规则**只作用于相对时间**，绝对日期形态（`4月2日 09:00`）不受它约束。
  //   我第一版断言"只认一条"，报红后抽老项目代码实跑才发现真值是 2 —— 不是移植漏掉。
  //   规则的本意：防止面板回写的**相对**时间被事项里的相对表达重复命中。
  const relLine = `${fmtRemInsert(at(2027, 3, 1, 10, 0))}　明天 9:30 复查`;
  assert.equal(collectTimeMatches(relLine, NOW).length, 1, '事项里的「明天 9:30」被事项区规则挡住');
  const absLine = `${fmtRemInsert(at(2027, 3, 1, 10, 0))}　4月2日 09:00 述职`;
  assert.equal(collectTimeMatches(absLine, NOW).length, 2, '绝对日期不受事项区约束（老项目行为，钉住别"顺手修正"）');
});

/* ============ 3. fmtRelDay ============ */

test('F5 fmtRelDay 今天/明天/后天/昨天按日界算，不按 24 小时算', () => {
  const sod = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = sod(new Date(NOW));
  assert.equal(fmtRelDay(today + 23 * 3600000, NOW), '今天', '今晚 23 点仍算今天');
  assert.equal(fmtRelDay(today + 86400000 + 3600000, NOW), '明天');
  assert.equal(fmtRelDay(today + 2 * 86400000, NOW), '后天');
  assert.equal(fmtRelDay(today - 86400000, NOW), '昨天');
});

test('F6 fmtRelDay 跨月与跨年', () => {
  assert.equal(fmtRelDay(at(2027, 3, 5), NOW), '3月5日', '同年不写年');
  assert.equal(fmtRelDay(at(2028, 1, 2), NOW), '2028年1月2日', '跨年必须带年份');
  assert.equal(fmtRelDay(at(2026, 12, 31), NOW), '2026年12月31日', '往年也带年份');
  assert.equal(fmtRelDay('不是时间', NOW), '');
});

/* ============ 4. fmtLate ============ */

test('F7 fmtLate 不足一分钟按 1 分钟，够一小时折算小时', () => {
  assert.equal(fmtLate(NOW - 500, NOW), '1 分钟', '刚过 0.5 秒也要说 1 分钟，不能显示 0');
  assert.equal(fmtLate(NOW - 12 * 60000, NOW), '12 分钟');
  assert.equal(fmtLate(NOW - 60 * 60000, NOW), '1 小时');
  assert.equal(fmtLate(NOW - 3.4 * 3600000, NOW), '3 小时', '3.4 小时四舍五入成 3');
  assert.equal(fmtLate(NOW - 3.6 * 3600000, NOW), '4 小时');
});

/* ============ 5. matchAtCaret：光标贴住即命中 ============ */

test('F8 matchAtCaret 贴住即命中（首字前/末字后都算）', () => {
  // 🔴 样例必须选**未来**的时刻。基准 NOW 就是 2027-03-01 10:00，
  //   我第一版拿「3月1日10:00」当例子，它恰好等于基准 ⇒ expired=true
  //   ⇒ matchAtCaret 按老项目铁律不返回 ⇒ 看着像"贴住不命中"的 bug，其实是样例选错。
  const text = '会议 3月1日11:00 开始';
  const m = collectTimeMatches(text, NOW)[0];
  assert.ok(m);
  assert.equal(m.expired, false, '前置：这条必须是未来的');
  for (let off = m.index; off <= m.index + m.length; off += 1) {
    assert.ok(matchAtCaret(text, off, NOW), `偏移 ${off} 应命中（时间串起点 ${m.index}）`);
  }
  assert.equal(matchAtCaret(text, m.index - 1, NOW), null, '时间串前一格不该命中');
  assert.equal(matchAtCaret(text, m.index + m.length + 1, NOW), null);
});

test('F9 🔴 已过期的时间串不命中（老项目 v5.39 铁律：零打扰）', () => {
  // 基准 NOW = 2027-03-01 10:00，造一条今天但已过的：3月1日9:00
  const text = '今天 3月1日9:00 的事';
  const m = collectTimeMatches(text, NOW)[0];
  assert.ok(m, '前置：解析层认得它');
  assert.equal(m.expired, true, '前置：它已过期');
  for (let off = m.index; off <= m.index + m.length; off += 1) {
    assert.equal(matchAtCaret(text, off, NOW), null, `已过期的 ${off} 偏移不该出 chip`);
  }
  // 反面：同一条里换成 11:00 就该能出 chip
  const future = '今天 3月1日11:00 的事';
  const fm = collectTimeMatches(future, NOW)[0];
  assert.equal(fm.expired, false);
  assert.ok(matchAtCaret(future, fm.index, NOW), '未来的必须能出 chip');
});

test('F10 🔴 过期判定只认 time-parse 的 expired 字段，matchAtCaret 绝不自算', () => {
  // 这条守的不是某个具体秒数，而是**判定来源唯一**。
  // 30 秒容差（at <= now + 30000 判过期）的窗口极窄，用秒级样例去钉它
  // 既难写又会变成"抄一遍实现"。真正会出事的形态是：matchAtCaret 自己
  // 用 `at <= now` 重算一遍 expired。两处各算一次必然漂移，
  // 漂移的表现是"chip 显示还能点，点了却加不上"或反过来"明明过期还能加"。
  const line = '3月1日11:00 开会';
  for (const now of [NOW, NOW + 3600000, NOW - 3600000]) {
    const m = collectTimeMatches(line, now)[0];
    const shown = matchAtCaret(line, m.index, now) !== null;
    assert.equal(shown, !m.expired,
      `now=${new Date(now).toString().slice(0, 24)} 时 chip 显隐必须与 expired 字段一致`);
  }
  // 显式钉住容差语义：at 恰好等于 now 时，at <= now+30000 ⇒ expired
  const exact = collectTimeMatches('3月1日10:00', NOW)[0];
  assert.equal(exact.at, NOW, '前置：这条解析出来正好等于基准时刻');
  assert.equal(exact.expired, true, 'at == now 必须算过期（容差只往未来放宽）');
  assert.equal(matchAtCaret('3月1日10:00', 0, NOW), null);
});

test('F11 matchAtCaret 多个时间串时取最短的那个（更贴合点的那个）', () => {
  const text = '3月1日10:00 与 3月1日';
  const all = collectTimeMatches(text, NOW);
  const big = all.find((m) => m.length > 5);
  assert.ok(big);
  // 落在「3月1日」内部的偏移，若短的那个也覆盖它，应取短的
  const short = all.find((m) => m.length < 5);
  if (short) {
    const r = matchAtCaret(text, short.index, NOW);
    assert.equal(r.length, short.length, '取最短命中');
  }
});

test('F12 matchAtCaret 空串与无命中', () => {
  assert.equal(matchAtCaret('', 0, NOW), null);
  assert.equal(matchAtCaret('完全没有时间', 5, NOW), null);
});

/* ============ 6. itemForChip ============ */

test('F13 itemForChip 取时间串之后到下一个时间串之前的文字', () => {
  const text = '3月1日10:00 开会　4月2日 09:00 述职';
  const all = collectTimeMatches(text, NOW);
  const first = all[0];
  const it = itemForChip(text, first, NOW);
  assert.ok(it.includes('开会'), '实际=' + JSON.stringify(it));
  assert.ok(!it.includes('4月2日'), '不能吞掉下一个时间串');
});

test('F14 itemForChip 纯符号不算事项', () => {
  const text = 'at = "3月1日10:00"';
  const m = collectTimeMatches(text, NOW)[0];
  assert.equal(itemForChip(text, m, NOW), '', '只切出引号时视为无事项');
});

test('F15 itemForChip 带字的小尾巴是合法事项（不能误杀）', () => {
  const text = '3月1日10:00（改线上）';
  const m = collectTimeMatches(text, NOW)[0];
  assert.ok(itemForChip(text, m, NOW).includes('改线上'), '纯标点才丢，带字的要留');
});

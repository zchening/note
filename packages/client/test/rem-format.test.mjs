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

import { fmtChipDay, fmtChipTime, fmtLate, fmtRemInsert, itemForChip, matchAtCaret } from '../src/reminder/format.ts';
import { collectTimeMatches } from '../src/reminder/time-parse.ts';

const NOW = new Date(2027, 2, 1, 10, 0, 0).getTime(); // 2027-03-01 10:00 周一
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

/* ============ 1. fmtChipTime：显示格式（老项目 index.html:6047 逐字） ============ */

test('F1 fmtChipTime 今天带「今天」前缀、否则「M月D日」且不带年', () => {
  // 🔴 老项目是「有今天前缀就不带年、没今天前缀才带月日」的二选一：
  //   `d.toDateString() === now.toDateString() ? '今天 ' + hm : md + ' ' + hm`
  //   bj 此前恒 `YYYY-M-D HH:mm`（带年、无今天前缀）⇒ **两个分支都不对**。
  assert.equal(fmtChipTime(at(2027, 3, 1, 10, 0), NOW), '今天 10:00', '今天 → 今天前缀，且不带年');
  assert.equal(fmtChipTime(at(2027, 3, 2, 8, 5), NOW), '3月2日 08:05', '非今天 → 月日，不带年，月日不补零');
  assert.equal(fmtChipTime(at(2027, 12, 25, 8, 5), NOW), '12月25日 08:05');
  // 🔴 分钟/小时必须补零（老项目 `String(x).padStart(2,'0')`）
  assert.equal(fmtChipTime(at(2027, 3, 2, 9, 5), NOW), '3月2日 09:05', '小时与分钟都补零');
  // 同一天但不同时间也算「今天」（按日历天，不按 24 小时）
  assert.equal(fmtChipTime(at(2027, 3, 1, 23, 59), NOW), '今天 23:59');
  assert.equal(fmtChipTime(at(2027, 3, 1, 0, 0), NOW), '今天 00:00');
});

test('F2 fmtChipTime 接受 ISO 字符串与非法值（时区无关断言）', () => {
  // 🔴🔴 判据必须**时区无关**（老坑：写死 +08:00 只在 GMT+8 成立，CI 是 UTC ⇒ 假红）。
  const local = new Date(2027, 2, 1, 10, 0, 0); // 本机时区的 2027-3-1 10:00
  assert.equal(fmtChipTime(local.toISOString(), NOW), '今天 10:00',
    'ISO 字符串应被接受，且按本地时区渲染成同样的钟点');
  assert.equal(fmtChipTime('2027-03-01T10:00:00.000+08:00', NOW),
    fmtChipTime(Date.parse('2027-03-01T10:00:00.000+08:00'), NOW),
    '带偏移的 ISO 应与同一时刻的本地渲染一致');
  assert.equal(fmtChipTime('不是时间', NOW), '', '非法值返回空串而不是 "NaN-NaN-NaN"');
  assert.equal(fmtChipTime(Number.NaN, NOW), '');
});

/* ============ 2. 互逆：写入的东西解析层必须认得 ============ */

test('F3 🔴🔴 写入正文的提醒行，解析层必须原样认回（提醒不会自己消失）', () => {
  // 这一条是整条链路的命门：面板加提醒 → fmtRemInsert 回写正文 →
  // 下次对账用 collectTimeMatches 找它。认不回来 ⇒ 提醒被判死 ⇒ 用户体感"刚加就没了"。
  // 🔴🔴 本条同时是「显示格式不许污染回写格式」的守卫：
  //   fmtChipTime 今天给的是「今天 10:00」，若回写也走它，解析层 reShort 认不出 ⇒ 提醒判死。
  assert.equal(fmtRemInsert(at(2027, 3, 1, 10, 0)), '2027-3-1 10:00', '回写必须是绝对形态');
  assert.notEqual(fmtRemInsert(at(2027, 3, 1, 10, 0)), fmtChipTime(at(2027, 3, 1, 10, 0), NOW),
    '回写与显示必须是两个函数：今天这天的回写绝不能是「今天 10:00」');
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
  const relLine = `${fmtRemInsert(at(2027, 3, 1, 10, 0))}　明天 9:30 复查`;
  assert.equal(collectTimeMatches(relLine, NOW).length, 1, '事项里的「明天 9:30」被事项区规则挡住');
  const absLine = `${fmtRemInsert(at(2027, 3, 1, 10, 0))}　4月2日 09:00 述职`;
  assert.equal(collectTimeMatches(absLine, NOW).length, 2, '绝对日期不受事项区约束（老项目行为，钉住别"顺手修正"）');
});

/* ============ 3. fmtChipDay：chip 首行右上角相对日（老项目 index.html:6053 chipDayLabel 逐字） ============ */

test('F5 fmtChipDay 同日返回空、明天/后天/周X/X天后（老项目五分支逐条）', () => {
  // 🔴🔴 同日必须返回**空串**而不是「今天」：老项目注释写明
  //   「fmtRemTime 已带「今天」前缀，再挂标签是重复」。bj 此前同日返回「今天」
  //   ⇒ 首行右侧多一个冗余标签。且老项目**没有「昨天」分支**（过期串不浮 chip）。
  const sod = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = sod(new Date(NOW));
  assert.equal(fmtChipDay(today, NOW), '', '同日返回空串（不挂标签）');
  assert.equal(fmtChipDay(today + 23 * 3600000, NOW), '', '今晚 23 点仍是同一天 ⇒ 空串');
  assert.equal(fmtChipDay(today + 86400000, NOW), '明天');
  assert.equal(fmtChipDay(today + 2 * 86400000, NOW), '后天');
  // 🔴 3~6 天 → 「周X」。NOW 是 2027-03-01 周一，故 +3 天 = 周四。
  assert.equal(fmtChipDay(today + 3 * 86400000, NOW), '周四', 'n<7 显示周几');
  assert.equal(fmtChipDay(today + 6 * 86400000, NOW), '周日', 'n=6 仍是本周（周日）');
  assert.equal(fmtChipDay(today + 7 * 86400000, NOW), '7天后', 'n>=7 显示 X天后');
  assert.equal(fmtChipDay(today + 30 * 86400000, NOW), '30天后');
  // 过去的日子（老项目 n<=0 一律空）
  assert.equal(fmtChipDay(today - 86400000, NOW), '', '过去返回空串（老项目无「昨天」分支）');
  assert.equal(fmtChipDay('不是时间', NOW), '');
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

test('F11 🔴 多个候选在相接处同时命中 ⇒ 取**起点最前**的（与老项目 all.find 同款）', () => {
  // 🔴 用户报障第 4 条：「周日19点 …」有时被识别成「今天19点」。
  //   老项目 matchTimeAt（index.html:6299）在**按 index 升序**的数组上
  //   `find(offset >= r.index && …)` ⇒ 取第一个 ⇒ 起点最前（通常也最长、最具体）。
  //   bj 旧实现取**最短**的 ⇒ 相接处会选到后面那个更短的串。
  //
  //   collectTimeMatches 返回**非重叠**匹配，所以只有"前一个的终点 == 后一个的起点"
  //   时两个串才会同时覆盖同一偏移 —— 这就是唯一的"多候选"形状。
  const text = '3月2日10:00明天10点';
  const all = collectTimeMatches(text, NOW);
  assert.equal(all.length, 2, '前置：两个时间串都要被解析出来');
  const long = all[0]; // 3月2日10:00（len 9）
  const short = all[1]; // 明天10点（len 5）
  assert.equal(text.slice(long.index, long.index + long.length), '3月2日10:00');
  assert.equal(text.slice(short.index, short.index + short.length), '明天10点');
  assert.equal(short.index, long.index + long.length, '前置：两者在边界相接');
  assert.equal(long.expired, false, '前置：长串不能是过期串（过期不浮 chip，会被跳过）');

  // 边界偏移：两个串都覆盖它 ⇒ 必须取起点最前的长串
  const r = matchAtCaret(text, short.index, NOW);
  assert.equal(r.index, long.index, '相接处取起点最前的那个（更长、更具体）');
  assert.equal(r.length, long.length);

  // 🔴 反向：只被短串覆盖的偏移（不与长串重叠）⇒ 必须取短串，不许"永远取最前"
  const r2 = matchAtCaret(text, short.index + 2, NOW);
  assert.equal(r2.index, short.index, '只被短串覆盖时取短串');
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

test('F16 🔴 itemForChip 事项不跨行（用户报障第 2 条：加提醒吞掉下面几行）', () => {
  // 旧实现 end 一路切到下一个时间串或 text.length ⇒ 把下面几行也当事项。
  // 与 reconcile.itemOf 共用"截到本行行尾"的口径，两处必须逐字一致。
  const text = '3月1日10:00 开会\n第二行内容\n第三行内容';
  const m = collectTimeMatches(text, NOW)[0];
  assert.equal(itemForChip(text, m, NOW), '开会', '必须只取时间串所在那一行');
});

test('F17 itemForChip 事项超 20 字截断加省略号（与老项目 itemAfterMatch :6045 同口径）', () => {
  const text = '3月1日10:00 ' + '一二三四五六七八九十'.repeat(3); // 30 字
  const m = collectTimeMatches(text, NOW)[0];
  const it = itemForChip(text, m, NOW);
  assert.equal(it, '一二三四五六七八九十一二三四五六七八九十…', '20 字 + 省略号');
  assert.equal(it.length, 21);
});

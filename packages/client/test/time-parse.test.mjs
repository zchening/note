/**
 * 时间识别单测 —— 全部 now 注入，不依赖真实时钟
 *
 * 🔴🔴 判据纪律：期望值一律用**显式时刻**写死（如 `2027-03-01T10:00`），
 *   不用 `new Date(y, m, d, h, mi)` 现算。现算等于把被测函数的实现抄一遍，
 *   一旦抄错（时区、跨年进位），测试会跟着错，还显得全绿。
 *
 * 🔴 now 固定为 2026-10-05T09:00（周一，UTC+8 本地时间），
 *   这样"下周五""本周日"这些相对语义的期望值是确定的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectRelTimeMatches,
  collectTimeMatches,
  cnNum,
  matchTimeAt,
  normFullWidth,
  parseTimeMatches,
  parseTimeMatchesLong,
  resolveTimeAt,
} from '../src/reminder/time-parse.ts';

/** 基准时刻：2026-10-05 09:00 本地（周一） */
const NOW = new Date(2026, 9, 5, 9, 0, 0).getTime();

/** 把某天的某时刻转成毫秒。用 new Date 是为了让测试跟随本地时区。 */
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

/** ISO 本地串，便于失败时一眼看出差在哪 */
const show = (ms) => new Date(ms).toString().slice(0, 24);

/* =============== 全角归一 =============== */
test('T1 全角数字/冒号/斜杠归一为半角，且长度不变', () => {
  const full = '９-１０　２０：０４';
  const half = normFullWidth(full);
  assert.equal(half, '9-10　20:04');
  // 🔴 长度必须相等 —— 归一会改变 index/length 的口径，
  //   长度变了正文标记就会错位（症状是"下划线盖住旁边一个字"）。
  assert.equal(half.length, full.length);
});

test('T2 U+3000 全角空格**不**被归一（它是事项区分隔符）', () => {
  assert.equal(normFullWidth('a　b'), 'a　b');
});

/* =============== 绝对时间 =============== */
test('T3 完整数字格式 2027-03-01 10:00', () => {
  const r = collectTimeMatches('会议 2027-03-01 10:00 开始', NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].at, at(2027, 3, 1, 10, 0));
  assert.equal(r[0].expired, false);
  assert.equal(show(r[0].at), show(at(2027, 3, 1, 10, 0)));
});

test('T4 中文完整日期 2027年5月1日 07:00 带年份，不按今年解析', () => {
  const r = collectTimeMatches('2027年5月1日 07:00', NOW);
  assert.equal(r.length, 1);
  // 🔴 这条是老项目 v7.1.0 修的 bug：不带年份解析会让未来年份被误判过期
  assert.equal(r[0].at, at(2027, 5, 1, 7, 0));
  assert.equal(r[0].expired, false);
});

test('T5 短格式（无年份）按今年解析，且已过就是过期', () => {
  // 现在是 2026-10-05，1月1日必然已过
  const r = collectTimeMatches('1月1日 09:00', NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].at, at(2026, 1, 1, 9, 0), '短格式必须按今年（2026）解析');
  assert.equal(r[0].expired, true);
  // 🔴🔴 不做"顺延明年"兜底（老项目 v6.3 移除）：
  //   兜底会把过去的日期判成明年同刻 → 过期提醒照样弹"添加提醒"入口。
  assert.notEqual(r[0].at, at(2027, 1, 1, 9, 0), '短格式竟然顺延到了明年');
});

test('T6 非法日期不命中（2月30日 / 13月 / 25:00）', () => {
  assert.equal(collectTimeMatches('2027-02-30 10:00', NOW).length, 0, '2月30日应当不命中');
  assert.equal(collectTimeMatches('2027-13-01 10:00', NOW).length, 0, '13月应当不命中');
  assert.equal(collectTimeMatches('2027-03-01 25:00', NOW).length, 0, '25点应当不命中');
  assert.equal(collectTimeMatches('2027-03-01 10:70', NOW).length, 0, '70分应当不命中');
});

test('T7 边界：闰年 2028-02-29 命中，2027-02-29 不命中', () => {
  assert.equal(collectTimeMatches('2028-02-29 10:00', NOW).length, 1);
  assert.equal(collectTimeMatches('2027-02-29 10:00', NOW).length, 0);
});

/* =============== 相对时间 =============== */
test('T8 明天/后天/大后天', () => {
  const t = (s) => collectTimeMatches(s, NOW)[0]?.at;
  assert.equal(t('明天 10:00'), at(2026, 10, 6, 10, 0));
  assert.equal(t('后天 10:00'), at(2026, 10, 7, 10, 0));
  assert.equal(t('大后天 10:00'), at(2026, 10, 8, 10, 0));
  assert.equal(t('今天 10:00'), at(2026, 10, 5, 10, 0));
});

test('T9 下周五 = 本周五 + 7（基准是周一）', () => {
  const r = collectTimeMatches('下周五 10:00', NOW);
  assert.equal(r.length, 1);
  // 2026-10-05 是周一 → 本周五 = 10-09，下周五 = 10-16
  assert.equal(r[0].at, at(2026, 10, 16, 10, 0));
});

test('T10 这周三 / 裸周三 在基准周内，而「本周三」**不**解析', () => {
  // 基准周一 → 本周三 = 10-07
  assert.equal(collectTimeMatches('周三 10:00', NOW)[0].at, at(2026, 10, 7, 10, 0));
  assert.equal(collectTimeMatches('这周三 10:00', NOW)[0].at, at(2026, 10, 7, 10, 0));
  // 🔴「本周X」刻意不收（老项目原样）：收了它，「本周五」里的"周五"就会被
  //   当成裸周几抢走，产生两条提醒。而"本周"与"这周"同义，用"这周"即可。
  //
  //   🔴 上面两条（周三/这周三）第一版是**红的**，返回周一 10-05 而非 10-07。
  //   我当时误判为"老项目的既有行为"，靠推理给自己找台阶 —— 真相是我的
  //   WD_SEG 把 `(这|下)` 漏了问号，裸「周三」匹配不上分支 A，退化成只捞裸时刻
  //   「10:00」于是返回今天。教训：**移植差异不许靠推理定案，抽老项目代码实跑比对**。
  assert.equal(collectTimeMatches('本周三 10:00', NOW).length, 0);
  // 修好之后，裸周几一族必须全部落在基准周内（这一组就是防止退化回"今天"的钉子）
  assert.equal(collectTimeMatches('周五 10:00', NOW)[0].at, at(2026, 10, 9, 10, 0));
  assert.equal(collectTimeMatches('周日 10:00', NOW)[0].at, at(2026, 10, 11, 10, 0));
  assert.equal(collectTimeMatches('礼拜五 10:00', NOW)[0].at, at(2026, 10, 9, 10, 0));
  assert.equal(collectTimeMatches('周三', NOW).length, 0, '裸周几无时刻不构成提醒');
});

test('T11 「上周五」刻意不解析（解析它会让裸「周五」被抢）', () => {
  assert.equal(collectTimeMatches('上周五 10:00', NOW).length, 0, '上周五竟然被解析了');
  // 反面：裸「周五」仍要能命中
  assert.equal(collectTimeMatches('周五 10:00', NOW).length, 1);
});

test('T12 时段换算：下午/中午/晚上/凌晨', () => {
  const h = (s) => collectTimeMatches(s, NOW)[0]?.at;
  assert.equal(h('今天 下午3点'), at(2026, 10, 5, 15, 0));
  assert.equal(h('今天 中午2点'), at(2026, 10, 5, 14, 0));
  assert.equal(h('今天 晚上8点'), at(2026, 10, 5, 20, 0));
  //🔴 晚上 1-5 点 = 次日凌晨（日期 +1）
  assert.equal(h('今天 晚上2点'), at(2026, 10, 6, 2, 0));
  // 🔴 晚上 12 点 = 次日 00:xx
  assert.equal(h('今天 晚上12点'), at(2026, 10, 6, 0, 0));
  assert.equal(h('今天 凌晨12点'), at(2026, 10, 5, 0, 0));
  assert.equal(h('今天 上午9点'), at(2026, 10, 5, 9, 0));
});

test('T13 中文数字时刻：三点 / 十点半 / 两点 / 十二点', () => {
  const h = (s) => collectTimeMatches(s, NOW)[0]?.at;
  assert.equal(h('今天 三点'), at(2026, 10, 5, 3, 0));
  assert.equal(h('今天 十点半'), at(2026, 10, 5, 10, 30));
  assert.equal(h('今天 两点'), at(2026, 10, 5, 2, 0));
  assert.equal(h('今天 十二点'), at(2026, 10, 5, 12, 0));
  // 🔴 「一刻」被 MIN 吃成"一分" ⇒ 3:01，length 6（吃到「今天 三点一刻」）。
  //   我第一版注释写的是"一刻不被支持、只取到三点"，那是**我猜的**，报红后
  //   抽老项目代码实跑才发现真值是 3:01 —— 老项目一直如此，不是移植 bug。
  //   钉住它：将来谁"顺手修正"这里，等于改了老项目既有行为，要先问过用户。
  const partial = collectTimeMatches('今天 三点一刻半', NOW);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].at, at(2026, 10, 5, 3, 1));
  assert.equal(partial[0].length, 6, '吃到「今天 三点一刻」，尾巴「半」当普通文字');
});

test('T14 「点钟M分」形态', () => {
  const h = (s) => collectTimeMatches(s, NOW)[0]?.at;
  assert.equal(h('明天 8点30分'), at(2026, 10, 6, 8, 30));
  assert.equal(h('明天 8点半'), at(2026, 10, 6, 8, 30));
  assert.equal(h('明天 8点20'), at(2026, 10, 6, 8, 20));
});

test('T15 本月N日 / 下月N号，且超当月天数不命中', () => {
  const h = (s) => collectTimeMatches(s, NOW)[0]?.at;
  assert.equal(h('本月12日 10:00'), at(2026, 10, 12, 10, 0));
  assert.equal(h('这个月12号 10:00'), at(2026, 10, 12, 10, 0));
  assert.equal(h('下月3号 10:00'), at(2026, 11, 3, 10, 0));
  // 🔴 超当月天数必须用**基准月真的没有那个日子**的例子，且期望值来自老项目实跑：
  //   2026 年 2 月只有 28 天 ⇒ 29/30/31 一律 0 条（不是"进位到3月"，是直接不命中）。
  //   我第一版断言「本月29日 → 1 条」，那是我以为会进位，实跑证明不会。
  const FEB = new Date(2026, 1, 10, 9, 0, 0).getTime(); // 2026年2月
  assert.equal(collectTimeMatches('本月28日 10:00', FEB).length, 1, '2月28日是本月最后一天，必须命中');
  assert.equal(collectTimeMatches('本月29日 10:00', FEB).length, 0, '2026年2月没有29日');
  assert.equal(collectTimeMatches('本月30日 10:00', FEB).length, 0, '2026年2月没有30日');
  assert.equal(collectTimeMatches('本月0日 10:00', NOW).length, 0);
  // 反面：真的有大月的月份，31 日就该命中（防止把"上限"写成硬编码 30）
  assert.equal(collectTimeMatches('本月31日 10:00', NOW).length, 1, '10月有31日');
  assert.equal(collectTimeMatches('本月32日 10:00', NOW).length, 0);
});

/* =============== 事项区防护 =============== */
test('T16 全角空格之后的事项内容不二次命中（幽灵提醒防护）', () => {
  // 面板回写格式：「2026-10-06 10:00　记得买牛奶3盒」—— 事项里的数字不该被当时间
  const line = '2026-10-06 10:00　记得买牛奶3盒';
  const r = collectTimeMatches(line, NOW);
  assert.equal(r.length, 1, `幽灵提醒：命中了 ${r.length} 条`);
  assert.equal(r[0].index, 0);
});

test('T17 「本月30日 10点」非法时，同串的裸「10点」也不许命中（2月无30日）', () => {
  const FEB = new Date(2026, 1, 10, 9, 0, 0).getTime();
  const r = collectTimeMatches('本月30日 10点', FEB);
  assert.equal(r.length, 0, `非法 match 必须占位，否则裸时刻会二次命中：${JSON.stringify(r)}`);
  // 对照：合法日期时应当恰好命中一条
  const ok = collectTimeMatches('本月28日 10点', FEB);
  assert.equal(ok.length, 1, '2026年2月28日合法，应命中一条');
});

test('T18「第3点」不命中（"第"字挡住裸时刻）', () => {
  assert.equal(collectTimeMatches('第3点开会', NOW).length, 0);
});

test('T19 裸时刻命中（无日期段）', () => {
  const r = collectTimeMatches('下午3:30 出发', NOW);
  assert.ok(r.length >= 1);
});

/* =============== cnNum =============== */
test('T20 cnNum 中文数字', () => {
  assert.equal(cnNum('三'), 3);
  assert.equal(cnNum('十'), 10);
  assert.equal(cnNum('十二'), 12);
  assert.equal(cnNum('二十'), 20);
  assert.equal(cnNum('二十三'), 23);
  assert.equal(cnNum('两'), 2);
  assert.equal(cnNum('35'), 35);
  assert.equal(cnNum('零'), 0, '零在字表里，是合法的 0');
  // 非法组合返 NaN，由调用方判不命中（不抛 —— 抛会让整个解析挂掉）
  assert.ok(Number.isNaN(cnNum('零十')));
  assert.ok(Number.isNaN(cnNum('百')));
});

/* =============== resolveTimeAt =============== */
test('T21 resolveTimeAt 非法返回 null，合法返回毫秒', () => {
  assert.equal(resolveTimeAt(2027, 13, 1, 10, 0), null);
  assert.equal(resolveTimeAt(2027, 2, 30, 10, 0), null);
  assert.equal(resolveTimeAt(2027, 3, 1, 24, 0), null);
  assert.equal(resolveTimeAt(2027, 3, 1, 10, 0), at(2027, 3, 1, 10, 0));
});

/* =============== 4000 字上限 =============== */
test('T22 超过 4000 字返回空（老项目 v7.4.0 的硬上限）', () => {
  const long = 'x'.repeat(4001) + ' 10:00';
  assert.equal(parseTimeMatches(long).length, 0);
  // 恰好 4000 字要能扫
  const okLen = 'x'.repeat(4000 - 6) + ' 10:00';
  assert.equal(parseTimeMatches(okLen).length, 1);
});

test('T23 长文走分段版，index 偏移必须正确（否则事项接到隔壁行的时间上）', () => {
  const filler = 'x'.repeat(4100);
  const text = `${filler}\n2026-12-25 08:00　冬至吃饺子`;
  const r = parseTimeMatchesLong(text, NOW);
  assert.equal(r.length, 1, '长文里的时间串必须能被扫到');
  assert.equal(r[0].at, at(2026, 12, 25, 8, 0));
  // 🔴 index 必须指向原文里的真实位置
  assert.equal(text.slice(r[0].index, r[0].index + r[0].length), '2026-12-25 08:00');
});

/* =============== matchTimeAt =============== */
test('T24 matchTimeAt 含前后沿（点首字/刚输完末字都算命中）', () => {
  const s = '会议 10:00 开始';
  const m = collectTimeMatches(s, NOW)[0];
  assert.ok(matchTimeAt(s, m.index, NOW), '正好在起始下标应命中');
  assert.ok(matchTimeAt(s, m.index + m.length, NOW), '正好在结束下标应命中');
  assert.equal(matchTimeAt(s, 0, NOW), null, '远离时间串不该命中');
});

/* =============== 排序 =============== */
test('T25 多个时间串按位置排序', () => {
  const s = '明天10:00 然后 2027-05-01 09:00 还有 下周五 08:00';
  const r = collectTimeMatches(s, NOW);
  assert.equal(r.length, 3);
  for (let i = 1; i < r.length; i += 1) {
    assert.ok(r[i].index > r[i - 1].index, '结果必须按正文位置排序（合并与标记都依赖它）');
  }
});

/* =============== 幂等 =============== */
test('T26 归一再跑一次不变（幂等）', () => {
  const a = normFullWidth('９-１０　２０：０４');
  assert.equal(normFullWidth(a), a);
});

/* =============== 相对时间的相对性 =============== */
test('T27 collectRelTimeMatches 可独立调用且与总入口口径一致', () => {
  const s = '明天下午三点';
  const rel = collectRelTimeMatches(s, NOW);
  const all = collectTimeMatches(s, NOW);
  assert.equal(rel.length, 1);
  assert.equal(all.length, 1);
  assert.equal(rel[0].at, all[0].at);
  assert.equal(all[0].at, at(2026, 10, 6, 15, 0));
});

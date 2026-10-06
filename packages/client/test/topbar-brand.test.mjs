/**
 * TOP- 顶栏契约闸 —— 移动端笔记名 / 节日徽章 / 每日一句话
 *
 * 🔴🔴 这批用例对应用户报障第 3 条（手机端顶栏没有笔记名）与第 5 条（深夜徽章不对）。
 *   两条报障的共同形状是：**结构早就画好了、样式也抄对了，但没有任何代码给它填内容**，
 *   于是「看起来实现了」而实际永远不显示 —— 读代码通读一遍是发现不了的，
 *   只能靠断言把"应该有"钉住、把"不应该有"钉死。
 *
 * 覆盖：
 *   TOP-1 shell.shouldShowBrandNote —— 老项目 index.html:10135 判据（App / 非桌面指针）
 *   TOP-2 shell.brandNoteText      —— 老项目 :10136-1017 的 decodeURIComponent 兜底
 *   TOP-3 fx.festKeyAt             —— 老项目 :6547nsFestAt（表 + 元旦 + 春节初二初三）
 *   TOP-4 fx.isLateNight           —— 老项目 :6576`h >= 22 || h < 6`（**含 05 点档**）
 *   TOP-5 fx.badgeAt               —— 老项目 :6574-6579深夜**优先于**节日
 *   TOP-6 fx 文案逐字（10 档 em/tx + 28 句每日一句话）
 *   TOP-7 fx.pickDailyLine         —— 老项目 :8423-8439 当天/切篇/不重复/让位
 *   TOP-8 theme 夜间时段≠ 徽章深夜时段（防"顺手统一"）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { brandNoteText, shouldShowBrandNote } from '../src/ui/shell.ts';
import { badgeAt, festKeyAt, isFestival, isLateNight, pickDailyLine } from '../src/egg/fx.ts';
import { isNightByClock } from '../src/ui/theme.ts';
import { COPY } from '../src/ui/copy.ts';

/*
 *🔴 为什么这里的"老项目原文"是**内联字面量**而不是去读 index.html：
 *   单测必须能在任何机器上跑（CI、别人的克隆）。老项目在仓库之外，
 *   按绝对路径读它会让这条用例在别的机器上直接ENOENT 崩掉 ——
 *   "测试因为环境缺文件而红"是最坏的一种红：它训练人忽略红灯。
 *   所以约定与 ui-contract.test.mjs 同款：**字面量内联 + 注明出处行号**，
 *   抄错时靠人肉比对老项目那一行。
 */

/* ---------------- TOP-1 顶栏笔记名的显示判据 ---------------- */

/*
 * 🔴 这条判据的**本体**是「桌面/手机互斥」，所以每条正向都必须配一条反向：
 *   只断"手机显示"而不断"桌面不显示"的话，把判据写成永远 true 也能全绿。
 */
test('TOP-1 🔴 App 内 / 无精确指针 → 显示笔记名（老项目 index.html:10135）', () => {
  assert.equal(shouldShowBrandNote('abc', true, true), true, 'App 内即便 hoverFine 也显示');
  assert.equal(shouldShowBrandNote('abc', false, true), true, 'App 内非桌面指针也显示');
  assert.equal(shouldShowBrandNote('abc', false, false), true, '手机网页（无 hover+fine）显示');
});

test('TOP-1 🔴 反向：PC 网页（有精确指针）**不**显示，首页也**不**显示', () => {
  assert.equal(
    shouldShowBrandNote('abc', true, false),
    false,
    '桌面级输入设备维持「NoteSync」字标（老项目 v7.4.0 推翻过"网页端零感知"的那次改动只扩到移动端）',
  );
  // 🔴 首页（noteId 空）两个环境都不显示 —— 老项目 :10132「首页维持 NoteSync」
  assert.equal(shouldShowBrandNote('', true, true), false, 'App 内首页也不该显示笔记名');
  assert.equal(shouldShowBrandNote('', false, false), false, '手机首页也不该显示笔记名');
});

/* ---------------- TOP-2 笔记名的解码兜底 ---------------- */

test('TOP-2 🔴 URL 编码的中文名要解出来；非法百分号要原样留着不崩', () => {
  assert.equal(brandNoteText('%E4%B8%AD%E6%96%87'), '中文', '二维码配对留下的历史中文名要还原');
  assert.equal(brandNoteText('abc'), 'abc', '纯 ASCII 名原样');
  // 🔴 老项目 :10137 是 try/catch 兜底，不是抛异常：手敲 /a%zz 不能让整页崩
  assert.equal(brandNoteText('a%zz'), 'a%zz', '非法百分号编码应回落原文，不是抛错');
});

/* ---------------- TOP-3 节日判档 ---------------- */

/*
 * 🔴 老项目 NS_FEST（index.html:6520）是「年份|年内条目」表，条目 = `MMDD` + 两字母 key。
 *   这里**只**内联 2026 与 2033 两段——它们覆盖了三个易错点：
 *     · 2026：常规一轮（除夕 0216 / 春节 0217 / 元宵 0303 / 中秋 0925）
 *     · 2033-01-01：腊八恰落元旦，是「查表优先于元旦特判」的唯一现成反例（老项目 :6546注释）
 *   整张表 37 段不内联：太长且逐行抄错的概率比抄 2 段高得多，
 *   而抄错的段会被下面「2026/2033 三个具体日子」的判据当场抓住。
 */
const NS_FEST_2026 = '20260126lb,0216cx,0217cj,0303yx,0619dy,0819qx,0925zq,1018cy';
const NS_FEST_2033 = '20330108lb,0130cx,0131cj,0214yx,0601dy,0801qx,0908zq,1001cy';

test('TOP-3 🔴 节日表逐字抄自老项目，且 2026 除夕/春节/中秋三档能判出来', () => {
  const fxSrc = readFileSync(new URL('../src/egg/fx.ts', import.meta.url), 'utf8');
  const block = fxSrc.match(/const NS_FEST = \[([\s\S]*?)\]\.join/);
  assert.ok(block, 'fx.ts 里应有 NS_FEST 表');
  const segs = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(
    segs.includes(NS_FEST_2026),
    `2026 段必须逐字等于老项目原文\n  期望 ${NS_FEST_2026}`,
  );
  assert.ok(
    segs.includes(NS_FEST_2033),
    `2033 段必须逐字等于老项目原文\n  期望 ${NS_FEST_2033}`,
  );

  // 2026-02-16 除夕 / 02-17 春节初一 / 09-25 中秋
  assert.equal(festKeyAt(new Date(2026, 1, 16)), 'cx', '2026-02-16 应是除夕');
  assert.equal(festKeyAt(new Date(2026, 1, 17)), 'cj', '2026-02-17 应是春节初一');
  assert.equal(festKeyAt(new Date(2026, 8, 25)), 'zq', '2026-09-25 应是中秋');
});

test('TOP-3 🔴 春节档含初二初三（靠日期差算，不在表里）；平日与表外年份返回 null', () => {
  assert.equal(festKeyAt(new Date(2026, 1, 18)), 'cj', '春节初二仍属 cj 档');
  assert.equal(festKeyAt(new Date(2026, 1, 19)), 'cj', '春节初三仍属 cj 档');
  // 🔴 反向：初四不是春节（差 3 天），平日不是节日
  assert.equal(festKeyAt(new Date(2026, 1, 20)), null, '初四必须落回 null');
  assert.equal(festKeyAt(new Date(2026, 5, 15)), null, '普通日子必须落回 null');
  // 🔴 反向：老项目表止于 2060，"过期自然静默"是设计，别改成循环取模
  assert.equal(festKeyAt(new Date(2070, 1, 17)), null, '表外年份应静默返回 null');
  assert.equal(isFestival(new Date(2026, 1, 17)), true, 'isFestival 与 festKeyAt 同源');
  assert.equal(isFestival(new Date(2026, 5, 15)), false, '平日不是节日');
});

/* ---------------- TOP-4 深夜时段边界 ---------------- */

test('TOP-4 🔴 深夜是 22:00–06:00，05 点档必须算深夜（老项目 :6576 h < 6）', () => {
  assert.equal(isLateNight(new Date(2026, 9, 5, 22, 0)), true, '22:00 起算深夜');
  assert.equal(isLateNight(new Date(2026, 9, 5, 23, 30)), true, '23:30 是深夜');
  assert.equal(isLateNight(new Date(2026, 9, 5, 5, 59)), true, '05:59 仍是深夜（本项目此前漏了这一小时）');
  assert.equal(isLateNight(new Date(2026, 9, 5, 0, 0)), true, '00:00 是深夜');
});

test('TOP-4 🔴 反向：06:00 与 21:59 都**不是**深夜（这条钉住上下边界）', () => {
  assert.equal(isLateNight(new Date(2026, 9, 5, 6, 0)), false, '06:00 起算白天（老项目 h < 6 是严格小于）');
  assert.equal(isLateNight(new Date(2026, 9, 5, 21, 59)), false, '21:59 还不到深夜');
  assert.equal(isLateNight(new Date(2026, 9, 5, 12, 0)), false, '正午不是深夜');
  // 🔴 深夜不是节日：isLateNight 与 isFestival 是两个独立判据，不许互相吞掉
  assert.equal(isFestival(new Date(2026, 9, 5, 23, 0)), false, '深夜不改变是否节日');
});

/* ---------------- TOP-5 徽章状态机 ---------------- */

/*
 * 🔴🔴 顺序是这里最容易错的地方：老项目 :6573 写明「深夜(22:00-06:00)优先于节日——
 *   大过年的深夜也先劝睡」。本项目此前是节日优先，于是除夕深夜显示「节日快乐」。
 */
test('TOP-5 🔴 深夜优先于节日：除夕夜里必须是🌙 劝睡，不是🧨（老项目 :6573-6576）', () => {
  const b = badgeAt(new Date(2026, 1, 16, 23, 0));
  assert.equal(b?.em, '🌙', '除夕深夜的 emoji 应是 🌙');
  assert.equal(b?.tx, '夜深了，写完这条就睡', '除夕深夜的文案应是劝睡那句');
  // 🔴 反向：同一档在白天/非深夜时段必须是节日档 —— 否则"深夜优先"就成了"永远深夜"
  const day = badgeAt(new Date(2026, 1, 16, 12, 0));
  assert.equal(day?.em, '🧨', '除夕白天应是 🧨');
  assert.equal(day?.tx, '除夕夜，岁末归档愉快', '除夕白天应是除夕那句');
});

test('TOP-5 🔴 平日无徽章（返回 null，不是空文案对象）', () => {
  assert.equal(badgeAt(new Date(2026, 5, 15, 12, 0)), null, '2026-06-15 正午无档');
  assert.equal(badgeAt(new Date(2070, 5, 15, 12, 0)), null, '表外年份也无档');
  // 🔴 元旦硬规则：老项目 :6552 `if (md === '0101') return 'nj'`，但**查表优先**
  //   （老项目 :6546 注释：腊八恰落 1-1 时显腊八文案）。
  //   老项目点名的年份是 2031/ 2050 —— 两年都是 0101lb。
  assert.equal(festKeyAt(new Date(2031, 0, 1)), 'lb', '2031-01-01 是腊八，查表优先于元旦特判');
  assert.equal(festKeyAt(new Date(2050, 0, 1)), 'lb', '2050-01-01 同理');
  // 🔴 反向：普通元旦（表里没有 0101 的年份）必须走特判给 nj
  assert.equal(festKeyAt(new Date(2026, 0, 1)), 'nj', '2026-01-01 应是元旦');
});

/* ---------------- TOP-6 文案与 emoji 逐字 ---------------- */

/*
 * 🔴 老项目 index.html:6521-6532 `NS_FEST_META` 十个档的 em/tx 全量内联。
 *   用户报障第 5 条就是这一张表：emoji 与文案是**同一个契约**，
 *   只对文案不对 emoji 等于没复刻（深夜显示成 🎆 会让人以为在过年）。
 */
const OLD_FEST_META = {
  nj: ['🎆', '新年好，记下今年的第一笔'],
  cx: ['🧨', '除夕夜，岁末归档愉快'],
  cj: ['🧧', '过年好！'],
  yx: ['🏮', '元宵安康，别忘了吃汤圆'],
  dy: ['🐉', '端午安康'],
  qx: ['✨', '今宵胜却人间无数'],
  zq: ['🌕', '但愿人长久'],
  cy: ['🍂', '重阳安康'],
  lb: ['🥣', '先喝粥，再记笔记'],
  night: ['🌙', '夜深了，写完这条就睡'],
};

/** 老项目 index.html:8412-8420 `DAILY_LINES`，28 句逐字。 */
const OLD_DAILY_LINES = [
  '来啦，今天整点啥？', '又打开我，谢了啊。', '早，先把脑子里的事倒出来。', '想到啥写啥，别憋着。',
  '走你，记一笔。', '我在呢，说吧。', '脑子空了？写下来就满了。', '今天也别硬记。',
  '边想边写，别求一次到位。', '记两笔，比记一天稳。', '你负责想，我负责记。', '先把待办掏空。',
  '来都来了，记一下。', '想到就做，做到就记。', '别怕字少，够用就行。', '一句话也是进度。',
  '脑子里那摊我帮你盯着。', '先记上，回头再说。', '你忙你的，笔给你递着。', '这会儿的事，趁热记。',
  '别跟我客气，随便写。', '记完就踏实了。', '灵感这东西，落纸才算数。', '今天想记住点啥？',
  '交给我，你接着忙。', '写下来，就忘不掉了。', '想到哪记到哪。', '有事儿就说，我记着呢。',
];

test('TOP-6 🔴 徽章十档 em/tx 与老项目 index.html:6521-6532 逐字一致', () => {
  const keys = Object.keys(OLD_FEST_META);
  assert.equal(keys.length, 10, '老项目应有十档（八个节日 + 腊八 + 深夜）');
  // 🔴 反向：档位集合必须**恰好**是这十个，多一个（例如自创的「情人节」）也要红
  assert.deepEqual(Object.keys(COPY.badge).sort(), [...keys].sort(), 'COPY.badge 的档位集合必须与老项目一致');
  for (const k of keys) {
    assert.equal(COPY.badge[k]?.em, OLD_FEST_META[k][0], `${k} 的 emoji 必须逐字等于老项目`);
    assert.equal(COPY.badge[k]?.tx, OLD_FEST_META[k][1], `${k} 的文案必须逐字等于老项目`);
  }
  // 🔴 用户报障第 5 条的核心：深夜档的 emoji 是 🌙 不是 🎆
  assert.equal(COPY.badge.night.em, '🌙', '深夜档 emoji 应是 🌙');
  assert.notEqual(COPY.badge.night.em, '🎆', '深夜档不能是元旦那枚 🎆');
  // 🔴 反向：元旦那档的 🎆 必须留着 —— 上面的 notEqual 不是"删掉所有 🎆"
  assert.equal(COPY.badge.nj.em, '🎆', '元旦档的 🎆 是老项目原文，不许被连带删掉');
});

test('TOP-6 🔴 每日一句话池与老项目 index.html:8412-8420 逐字一致', () => {
  // 🔴 老项目是 **28** 句（不是 27）。写死数字是为了"池子增删时测试必须一起改"。
  assert.equal(OLD_DAILY_LINES.length, 28, '老项目 DAILY_LINES 应为 28 句');
  assert.deepEqual([...COPY.dailyLines], OLD_DAILY_LINES, '每日一句话必须逐字等于老项目，一个标点都不许改');
  assert.equal(new Set(COPY.dailyLines).size, 28, '池内不该有重复句（否则概率分布会偏）');
});

/* ---------------- TOP-7 每日一句话的触发规则 ---------------- */

/** 造一个只读的 localStorage 桩。 */
const lsOf = (o) => ({ get: (k) => (k in o ? o[k] : '') });

test('TOP-7🔴 每天第一篇 + 每次换到不同笔记各算一次；同日同篇刷新不打扰', () => {
  const today = new Date(2026, 9, 5, 10, 0);
  // 当天第一次进任何一篇 → 递
  assert.notEqual(pickDailyLine('a', today, lsOf({}), false), null, '当天首次应递');
  // 记上"今天已递过 a"之后，再进 a（同日同篇=刷新）→ 不递
  const afterA = { [COPY.greetDayKey]: '20261005', [COPY.greetNoteKey]: 'a' };
  assert.equal(pickDailyLine('a', today, lsOf(afterA), false), null, '同日同篇刷新不该打扰');
  // 换到 b → 又递（老项目 :8429 `diffNote`）
  assert.notEqual(pickDailyLine('b', today, lsOf(afterA), false), null, '换到不同笔记应再递一次');
  // 🔴 反向：首页永远不递（老项目 :8423 `if (!noteId) return`）
  assert.equal(pickDailyLine('', today, lsOf({}), false), null, '首页不该递');
});

test('TOP-7 🔴 同位浮层在场时让位，且让位**不消耗**当天/切篇记账', () => {
  const today = new Date(2026, 9, 5, 10, 0);
  assert.equal(pickDailyLine('a', today, lsOf({}), true), null, '浮层在场时应让位');
  // 🔴 让位只发生在"取句"这一步，记账由 dayGreet 在拿到句子后才写 ——
  //   所以让位后换个时刻/换个笔记仍应能递上（老项目 :8433 注释：不消耗记账）。
  assert.notEqual(
    pickDailyLine('a', new Date(2026, 9, 6, 10, 0), lsOf({}), false),
    null,
    '次日仍应能递（让位不写死记账）',
  );
});

test('TOP-7 🔴 不与上一句重复（老项目 :8437-8439 的 pool 过滤）', () => {
  const today = new Date(2026, 9, 5, 10, 0);
  const lastLine = COPY.dailyLines[0];
  const line = pickDailyLine(
    'a',
    today,
    lsOf({ [COPY.greetLineKey]: lastLine }),
    false,
    // rnd 固定取 0 ⇒ 取pool[0]。pool 已滤掉 lastLine，所以结果必不等于 lastLine。
    () => 0,
  );
  assert.notEqual(line, lastLine, '不该递出与上次相同的那句');
  assert.ok(COPY.dailyLines.includes(line), '递出的句子必须来自老项目池子');
  // 🔴 反向：rnd=1.0（越界上界）时回落全池末句，仍必须是池内的一句、不是 undefined
  const edge = pickDailyLine('a', today, lsOf({ [COPY.greetLineKey]: lastLine }), false, () => 1);
  assert.ok(edge !== null && COPY.dailyLines.includes(edge), 'rnd 越界也要递出池内的一句');
});

/* ---------------- TOP-8 主题夜间时段 ≠ 徽章深夜时段 ---------------- */

/*
 * 🔴 这条是**防合并**闸：主题夜间是 19:00–07:00（老项目 :1009-1010），
 *   徽章深夜是 22:00–06:00（老项目 :6576）。两个数字**故意不同**：
 *   配色时段管主题切换，文案时段管"劝你睡"。曾有人在 18:47 看到金色徽章而误以为主题判错，
 *   于是把两处"统一"成一个函数 —— 那会让 19:00–22:00 之间凭空多出四小时劝睡。
 */
test('TOP-8 🔴 主题夜间（19–07）与徽章深夜（22–06）是两件事，不许统一', () => {
  assert.equal(isNightByClock(new Date(2026, 9, 5, 20, 0)), true, '20:00 已是夜间模式');
  assert.equal(isLateNight(new Date(2026, 9, 5, 20, 0)), false, '但 20:00 不是深夜，不该劝睡');
  assert.equal(isNightByClock(new Date(2026, 9, 5, 6, 30)), true, '06:30 仍是夜间模式');
  assert.equal(isLateNight(new Date(2026, 9, 5, 6, 30)), false, '但 06:30 已过深夜，不该劝睡');
  // 🔴 反向：深夜窗口内也同时是夜间模式（这一段两者是一致的，别把上面的差异扩大到荒谬）
  assert.equal(isNightByClock(new Date(2026, 9, 5, 23, 0)), true, '23:00 两者都成立');
  assert.equal(isLateNight(new Date(2026, 9, 5, 23, 0)), true, '23:00 两者都成立');
});

/* ---------------- TOP-9 反向闸：老项目没有的东西不许留在代码里 ---------------- */

test('TOP-9 🔴 bj 自创的四时问候/节日快乐文案必须已删干净', () => {
  // 🔴🔴 必须**剥掉注释**再扫：fx.ts 的文件头与festKeyAt 的注释里
  //   合法地引用了「节日快乐」这三个字（说明"此前是自创的、已删"）。
  //   直接对源码 includes 会把这段说明当成残留 —— 那就是一条训练人忽略红灯的用例。
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const fxCode = stripComments(readFileSync(new URL('../src/egg/fx.ts', import.meta.url), 'utf8'));
  const copyCode = stripComments(readFileSync(new URL('../src/ui/copy.ts', import.meta.url), 'utf8'));

  for (const bad of ['节日快乐', '四时', '问候池']) {
    assert.ok(!fxCode.includes(bad), `fx.ts 不该再有自创文案「${bad}」`);
    assert.ok(!copyCode.includes(bad), `copy.ts 不该再有自创文案「${bad}」`);
  }
  // 🔴 旧的写死 emoji 变量必须消失，否则又会被某个分支用回去
  assert.ok(!fxCode.includes('BADGE_EMOJI'), 'BADGE_EMOJI 常量必须删（emoji 改为按档取）');
  // 🔴 反向：老项目深夜原文必须留着 —— 别把该留的一起删了（这条防"过度清理"）
  assert.ok(copyCode.includes('夜深了，写完这条就睡'), '老项目深夜原文必须保留');
  assert.equal(COPY.badge.night.em, '🌙', '深夜档 emoji 必须还在');
});
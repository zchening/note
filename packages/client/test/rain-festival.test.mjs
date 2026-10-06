/**
 * RN- 节日雨闸 —— 雨下什么字符由「当天的节日档」决定（RN- 系列）
 *
 * 🔴🔴 这批用例治的是一种**典型静默降级**：功能在跑、粒子在飞、屏幕上很热闹，
 *   但下的是**硬编码的雪花** `'❄✦❅•❄✧'` —— 过年下雪、端午下雪、生日下雪，
 *   唯一跟着日子变的是顶栏那枚徽章。用户报障会是「彩蛋和老版本不一样」，
 *   而任何"粒子数量正常/动画在动/性能没问题"的检查都发现不了它。
 *
 * 老项目真源：
 *   :6599-6600  `var meta = NS_FEST_META[key]; if (!meta || !meta.rain.length) return;`
 *   :6609`s.textContent = meta.rain[i % meta.rain.length];`   ← **轮转**，不是随机
 *   :6521-6532  NS_FEST_META 九档 + night 的 `rain` 值（逐字，见下）
 *   :6647`const f = nsFestAt(new Date());`  ← **判雨只看节日档，不看深夜**
 *   :6619      注释「深夜+节日=🌙 先劝睡，雨仍走节日 meta」
 *
 * 🔴 约定与 topbar-brand.test.mjs 同款：老项目原文**内联字面量** + 注明行号。
 *   单测不能按绝对路径去读仓库外的index.html（别的机器上会 ENOENT）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { festKeyAt, rainCharsFor } from '../src/egg/fx.ts';
import { COPY } from '../src/ui/copy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 去掉注释，只留**可执行代码**。
 *
 * 🔴 为什么必须去注释再扫：本文档自己在注释里就引用了`'❄✦❅•❄✧'`
 *   这串坏字符（说明"此前硬编码的就是它"），而判据要问的是
 *   「**代码**里还有没有硬编码雪花」，不是「文件里有没有出现这串字」。
 *   不去注释的话，这条判据会被自己的说明文字判红 —— 那是典型的假红。
 *
 *   注释形式只有两种（fx.ts 里没有任何 `http://` 这类含 `//` 的字符串，
 *   所以逐行剥 `//` 不会误伤URL）。
 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

/**
 * 老项目 index.html:6521-6532 `NS_FEST_META` 的 `rain` 字段，**逐字内联**。
 * 🔴 这是判据的**本体**：少一档、错一个字、或退回雪花，这张表就会与实现分叉。
 */
const OLD_NS_FEST_META_RAIN = {
  nj: ['🎆'],
  cx: ['🧨'],
  cj: ['🎆', '🧧', '🏮'],
  yx: ['🏮'],
  dy: ['🐉', '🍙'],
  qx: ['✨', '🪶'],
  zq: ['🌕'],
  cy: ['🍂'],
  lb: ['🥣'],
  night: [],
};

/**
 * 老项目节日表里各档的**公历日期**（从 NS_FEST :6520 取 2026 那一条，
 * 因为 2026 是表里唯一能被 `new Date(2026, …)` 直接构造出「非夜深时段」的整年）。
 *🔴 这里必须用**本地**日期构造（`new Date(y, m, d, h)`），
 *   用 `new Date('2026-06-19')` 会按 UTC 解析 ⇒ 在东八区偏成 6/18，
 *   判据就变成"碰巧命中另一档"，抄错也发现不了。
 */
const DATES_2026 = {
  nj: [2026, 0, 1],
  cx: [2026, 1, 16],
  cj: [2026, 1, 17],
  yx: [2026, 2, 3],
  lb: [2026, 0, 26],
  dy: [2026, 5, 19],
  qx: [2026, 7, 19],
  zq: [2026, 8, 25],
  cy: [2026, 9, 18],
};

/* ---------------- RN-1 各节日档返回该节日的 emoji ---------------- */

test('RN-1 🔴 十个档位的雨字符须逐字等于老项目 NS_FEST_META.rain（:6522-6531）', () => {
  for (const [k, want] of Object.entries(OLD_NS_FEST_META_RAIN)) {
    // COPY.badge 是值的唯一来源，先钉住它（抄错 emoji 时这里会红）
    assert.deepEqual(
      [...COPY.badge[k].rain],
      want,
      `COPY.badge.${k}.rain 与老项目 :6522-6531 不一致`,
    );
  }
});

test('RN-1 🔴 命中节日档时 rainCharsFor 返回**该节日的 emoji**（不是雪花）', () => {
  for (const [k, [y, m, d]] of Object.entries(DATES_2026)) {
    // 12:00 = 明确的白昼，绕开时段判据，单测只验「节日 → 该节日的雨」
    const when = new Date(y, m, d, 12, 0, 0);
    assert.equal(festKeyAt(when), k, `${y}-${m + 1}-${d} 应判为 ${k}，先确认档位本身没漂`);
    assert.deepEqual(
      [...rainCharsFor(when)],
      OLD_NS_FEST_META_RAIN[k],
      `${k} 档的雨字符应逐字等于老项目 :6522-6531`,
    );
  }
});

test('RN-1 🔴 春节档三种字符都要在（老项目 :6609 的`i % len` 轮转前提）', () => {
  // 反向：若实现改成随机取字符，30 个雨点里很可能缺一种 ——
  //   而用户是靠"看到了三种"来判断"这是过年的雨"的。
  assert.equal(rainCharsFor(new Date(2026, 1, 17, 12)).length, 3, '春节档应有 3 种雨字符');
  assert.equal(OLD_NS_FEST_META_RAIN.cj.length, 3);
});

/* ---------------- RN-2 非节日不下雨 ---------------- */

test('RN-2 🔴 非节日返回空数组 = **不下雨**，不是退回下雪花', () => {
  // 2026-06-01既不在表里、也不是元旦、也不是春节初二初三 ⇒ festKeyAt 必为 null
  const plain = new Date(2026, 5, 1, 12, 0, 0);
  assert.equal(festKeyAt(plain), null, '2026-06-01 不该命中任何节日档');
  assert.deepEqual([...rainCharsFor(plain)], [], '非节日必须返回空数组（不下雨）');
});

test('RN-2 🔴 深夜 + 非节日 → 空数组（老项目 :6648 hasRain 守卫的等价）', () => {
  // 🔴 注意：深夜**本身**不是"不下雨"的理由（老项目 :6647 只看 nsFestAt）。
  //   这里取的是"深夜且当天没有节日" ⇒ 两条判据都否定 ⇒ 必然无雨。
  const late = new Date(2026, 5, 1, 23, 30, 0);
  assert.deepEqual([...rainCharsFor(late)], [], '深夜的非节日应无雨');
});

test('RN-2 🔴 深夜档 night 的 rain 是空数组（老项目 :6531 逐字）', () => {
  // `festKeyAt` 永远不返回 'night'（它只吐表里 9 个key + nj/cj），
  //   所以这条断言钉的是**表里的值**，不是可达路径 —— 抄老项目时别把它删了。
  assert.deepEqual([...COPY.badge.night.rain], [], 'night 档 rain 必须逐字等于老项目 :6531 的空数组');
});

/* ---------------- RN-3 除夕深夜仍下雨（老项目 :6619 那条注释） ---------------- */

test('RN-3 🔴 除夕深夜**照样下鞭炮雨**（老项目 :6647 只看 nsFestAt，不看深夜）', () => {
  // 🔴🔴 这条是反向闸，防的是"看起来更合理"的自我修正。
  //   老项目 :6619 注释原文：「深夜+节日=🌙 先劝睡，**雨仍走节日 meta**」。
  //   若实现里给雨也套上 `isLateNight`（像 badgeAt :6576 那样），
  //   大年夜的鞭炮就没了 —— 那是自己发明的差异，比下雪花更难解释。
  const eve = new Date(2026, 1, 16, 23, 30, 0);
  assert.deepEqual([...rainCharsFor(eve)], ['🧨'], '除夕深夜的雨应仍是 🧨（老项目 :6523/:6619）');
});

/* ---------------- RN-4 反向：源码里不许再有硬编码雪花 ---------------- */

test('RN-4 🔴 fx.ts 里不许再硬编码「❄✦❅•❄✧」这类与节日无关的雨字符', () => {
  // 🔴 扫的是**去注释后的代码** —— 判据问的是"代码里还有没有"，不是"文件里有没有出现"。
  //   （本文件自己的注释就引用了这串坏字符，不去注释必假红。）
  const code = codeOnly(readFileSync(resolve(HERE, '..', 'src', 'egg', 'fx.ts'), 'utf8'));
  // 🔴 反向断言的写法很讲究：**只查这一串**，不查所有非 ASCII。
  //   查"所有非 ASCII"会连 emoji 与中文注释一起判红（等于把实现锁死成不能写注释）。
  assert.ok(
    !code.includes('❄✦❅•❄✧'),
    'fx.ts 里仍硬编码雪花串——那正是"任何时候都下雪花"的根因（老项目 :6609 是 meta.rain[i % len]）',
  );
  // 也不能出现单片雪花当兜底字符（`?? '❄'` / `|| '❄'` 这类）
  assert.ok(!/['"]❄['"]/.test(code), "不许拿单片雪花当兜底字符（老项目空数组 = 直接 return）");
});

test('RN-4 🔴 rain() 的空字符集必须**直接返回**（老项目 :6600 的 `if (!meta.rain.length) return`）', () => {
  const src = readFileSync(resolve(HERE, '..', 'src', 'egg', 'fx.ts'), 'utf8');
  const body = src.slice(src.indexOf('export function rain('));
  const head = body.slice(0, body.indexOf('const end ='));
  assert.ok(
    /if\s*\(\s*!chars\.length\s*\)\s*return;/.test(head),
    'rain() 必须对空字符集直接 return —— 兜底成雪花就是本次要治的静默降级',
  );
});

test('RN-4 🔴 rain() 必须用轮转下标取字符（老项目 :6609 `i % len`），不是随机', () => {
  const src = readFileSync(resolve(HERE, '..', 'src', 'egg', 'fx.ts'), 'utf8');
  const body = src.slice(src.indexOf('export function rain('));
  assert.ok(
    /ch:\s*chars\[\s*i\s*%\s*chars\.length\s*\]/.test(body),
    "取字符须逐字等于老项目 :6609 的 `meta.rain[i % meta.rain.length]`（轮转，不是随机）",
  );
  assert.ok(
    !/chars\[Math\.floor\(Math\.random\(\)/.test(body),
    '不许改成随机取字符：轮转才能保证每种字符都出现（用户靠这个判断"这是过年的雨"）',
  );
});
/**
 * 彩蛋注册表纯逻辑单测（EGG 系列）
 *
 * 🔴 这组测试保护的是三件最容易静默坏掉的事：
 *   1. **门牌清单是唯一真源**（路由判定 / 落地页文案 / 图鉴条目三处同源）
 *   2. **图鉴计数永不自相矛盾**（分子 ≤ 分母，且分母 = 注册表长度）
 *   3. **已发现记录不会被写坏后拖垮整层**（坏 JSON / 已下架 id / 非对象）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EGG_DOORS,
  EGG_KEY,
  EGG_TOTAL,
  EGGS,
  RESERVED_ROUTES,
  bodyWords,
  doorOf,
  eggById,
  eggCountText,
  hasFireworkWord,
  isEggRoute,
  markDiscovered,
  numGagsIn,
  readDiscovered,
} from '../src/egg/registry.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 内存版 localStorage。 */
function memStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  };
}

test('EGG-01 🔴🔴 门牌 10 枚、条目 17 条（与老项目 NS_EGG_LIST 同长）', () => {
  // 🔴 用**逐条断言**而不是只断言长度：删掉一枚再加一枚，长度不变但清单错了，
  //   而"少一枚门牌"的症状是用户输/snake 进了空白编辑器（零报错）。
  assert.deepEqual(EGG_DOORS, [
    'mirror', 'snake', 'dragon', 'brick', 'satoshi',
    'bitcoin', 'tank', 'spacex', 'tesla', 'pet',
  ]);
  assert.equal(EGG_TOTAL, 17);
  assert.equal(EGG_TOTAL, EGGS.length, '总数必须由注册表推导，不另写死');
});

test('EGG-02 🔴🔴 每个 id 唯一，且 hint 非空（图鉴要显示）', () => {
  const ids = new Set();
  for (const e of EGGS) {
    assert.ok(!ids.has(e.id), `id 重复：${e.id}`);
    ids.add(e.id);
    assert.ok(e.name.trim() !== '', `${e.id} 缺 name`);
    assert.ok(e.hint.trim() !== '', `${e.id} 缺 hint（已发现后要显示怎么撞见的）`);
  }
});

test('EGG-03🔴 门牌必须是保留字，非门牌的伪路由也必须保留', () => {
  for (const d of EGG_DOORS) {
    assert.equal(isEggRoute(d), true, `${d} 是门牌，路由必须拦下（否则当笔记名放行）`);
    assert.equal(doorOf(d), d);
  }
  // 老项目另有一批 404/工具字面，放行会让用户拿到空白编辑器
  for (const r of ['about', 'help', 'admin', 'api', 'www', 'backup']) {
    assert.ok(RESERVED_ROUTES.has(r), `${r} 应是保留字`);
    assert.equal(isEggRoute(r), true);
  }
});

test('EGG-04 🔴 门牌判定大小写不敏感（老项目 toLowerCase 口径）', () => {
  assert.equal(isEggRoute('SNAKE'), true);
  assert.equal(isEggRoute('Snake'), true);
  assert.equal(doorOf('PET'), 'pet');
  // 非门牌的普通笔记名不许被判成蛋
  assert.equal(isEggRoute('mynote'), false);
  assert.equal(isEggRoute(''), false);
  assert.equal(doorOf('mynote'), '');
});

test('EGG-05 🔴🔴 图鉴计数行：分子永不大于分母（老项目的自愈不了的老病）', () => {
  // 场景：某版本下架了一枚蛋，但老记录里还有它的 id。
  // 老项目 nsEggMap() 读回来直接用 → 显示 12 / 11 FOUND，**永远自愈不了**。
  const s = memStore({ [EGG_KEY]: JSON.stringify({ snake: 1, gone_egg: 1, brick: 1 }) });
  const got = readDiscovered(s);
  assert.equal(got.has('gone_egg'), false, '已下架的 id 必须被过滤掉');
  assert.equal(got.size, 2);
  assert.equal(eggCountText(got.size), '2 / 17 FOUND');
});

test('EGG-06 🔴🔴 发现记录坏掉不得抛，也不得把已发现的弄丢', () => {
  assert.equal(readDiscovered(memStore({ [EGG_KEY]: '{bad json' })).size, 0);
  assert.equal(readDiscovered(memStore({ [EGG_KEY]: '[1,2,3]' })).size, 0, '数组不是对象');
  assert.equal(readDiscovered(memStore({ [EGG_KEY]: '"str"' })).size, 0);
  assert.equal(readDiscovered(memStore({ [EGG_KEY]: 'null' })).size, 0);
  // 值为 0 / 字符串的不算已发现（老项目只认 1）
  const s = memStore({ [EGG_KEY]: JSON.stringify({ snake: 0, brick: 1, tank: 'yes' }) });
  const got = readDiscovered(s);
  assert.deepEqual([...got].sort(), ['brick']);
});

test('EGG-07 🔴 markDiscovered 幂等：已发现不重复写盘', () => {
  const s = memStore();
  assert.equal(markDiscovered(s, 'snake', true), true, '首次记成功');
  //🔴 关键：不幂等的话，"每次 update 扫一次词表"的触发点会每秒写 localStorage，
  //   移动端症状是"打几个字就卡"，极难归因。
  assert.equal(markDiscovered(s, 'snake', true), false, '二次应判重返回 false');
  assert.equal(readDiscovered(s).size, 1);
  // 未注册的门牌不许进记录（否则会污染计数）
  assert.equal(markDiscovered(s, 'not_an_egg', true), false);
  assert.equal(markDiscovered(s, 'snake', false), false, '未命中不该写');
  assert.equal(readDiscovered(s).size, 1);
});

test('EGG-08 🔴 写入失败（隐私模式）不抛 —— 发现记录是装饰性数据', () => {
  const boom = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  // 不抛就是过
  markDiscovered(boom, 'snake', true);
});

test('EGG-09 🔴 键名必须是 notesync_bj_ 前缀，绝不复用老项目', () => {
  assert.equal(EGG_KEY, 'notesync_bj_eggs');
  assert.notEqual(EGG_KEY, 'notesync_eggs');
});

test('EGG-10 🔴 落地页必须复用 registry 的保留字（不许再写一份字面量）', () => {
  const ll = readFileSync(resolve(HERE, '..', 'src', 'ui', 'landing-logic.ts'), 'utf8');
  // 🔴 判据是「不再自己 new Set([...])」：S4 阶段这里就是 `new Set(['pet',...])`，
  //   少 9 枚门牌且零报错。现在只许 re-export。
  assert.ok(
    /import\s*\{[^}]*RESERVED_ROUTES[^}]*\}\s*from\s*'\.\.\/egg\/registry\.ts'/.test(ll),
    'landing-logic 必须从 registry 导入保留字',
  );
  assert.ok(
    !/new Set\(\s*\[/.test(ll),
    'landing-logic 里不许再出现字面量清单（会与 registry 漂移）',
  );
  // 同理，menu/pages 也不许自己判 isEggRoute
  const pages = readFileSync(resolve(HERE, '..', 'src', 'ui', 'pages.ts'), 'utf8');
  assert.ok(pages.includes("from './landing-logic.ts'"), 'pages 应统一从 landing-logic 取');
});

test('EGG-11 🔴🔴 数字梗按完整数字串判定，不能被年份误报', () => {
  assert.deepEqual(numGagsIn('今天666'), [666]);
  assert.deepEqual(numGagsIn('520 我爱你'), [520]);
  // 🔴 关键反例：1666 里的 666 不是梗（用户只是写年份）
  assert.deepEqual(numGagsIn('生于1666年'), []);
  assert.deepEqual(numGagsIn('第 666 天'), [666], '带空格仍是完整串');
  assert.deepEqual(numGagsIn('66'), [], '两位数不是梗');
  assert.deepEqual(numGagsIn('a1.666b'), [], '小数点相邻不算独立数字串');
});

test('EGG-12 notesync 烟花：不分大小写，三种形态都认', () => {
  assert.equal(hasFireworkWord('notesync'), true);
  assert.equal(hasFireworkWord('NoteSync'), true);
  assert.equal(hasFireworkWord('N O T E S Y N C'), true);
  assert.equal(hasFireworkWord('NOTE-SYNC.EXE'), true);
  assert.equal(hasFireworkWord('随便写点什么'), false);
});

test('EGG-13🔴 正文抽词：中文 2 字一词、英文按空白、单词太短丢弃', () => {
  const w = bodyWords('今天 天气 不错 下午去公园走走 顺便买点水果', 4);
  assert.ok(w.length > 0, '词足够时必须返回词');
  // 去重
  assert.equal(new Set(w).size, w.length, '不得有重复词');
  // 词不足时返回空（调用方据此回退到收藏/待办）
  assert.deepEqual(bodyWords('短', 8), []);
  // 英文按整词
  const e = bodyWords('hello world foo bar', 4);
  assert.ok(e.includes('hello') && e.includes('world'));
});

test('EGG-14 每个非门牌蛋的 hint 不许出现"访问 /xxx"（那是门牌的说话方式）', () => {
  // 不是正确性断言，是**文案一致性**闸：老项目里条件触发类的 hint 一律是
  // "怎么撞见的"，门牌类才是"访问 /xxx"。混了会让人以为必须输网址。
  for (const e of EGGS) {
    if (e.door) continue;
    assert.ok(
      !e.hint.includes('访问 /'),
      `${e.id} 是条件触发类，hint 不该写"访问 /"：${e.hint}`,
    );
  }
  for (const e of EGGS) {
    if (!e.door) continue;
    assert.ok(
      e.hint.includes('访问 /') || e.hint.includes('正文敲'),
      `${e.id} 是门牌类，hint 应说明怎么进：${e.hint}`,
    );
  }
});

test('EGG-15 🔴 badge 是唯一 replayable=false 的（它是自动冒出来的）', () => {
  const no = EGGS.filter((e) => !e.replayable).map((e) => e.id);
  assert.deepEqual(no, ['badge'], 'badge 没法主动复现；出现第二个就要想清楚');
  assert.ok(eggById('badge') !== undefined);
  assert.equal(eggById('not_exist'), undefined);
});

/* ════════════════════════════════════════════════════════════════════════
 * 以下三条是 e2e（08-egg.test.js）抓到真缺陷之后补的结构钉。
 * 它们**不是**重复 e2e，而是把"为什么会坏"提前钉在源码层：
 *  e2e 要真浏览器才跑得到，源码钉每次 build 都跑。
 * ════════════════════════════════════════════════════════════════════════ */

/** 取某个 class 的类体（边界 = 下一个顶层 class/interface/export）。 */
function classBody(source, className) {
  const at = source.indexOf(`class ${className}`);
  assert.ok(at > 0, `未找到 class ${className}`);
  const after = source.slice(at + 1);
  const next = after.search(/\n(class |interface |export )/);
  return next > 0 ? after.slice(0, next) : after;
}

const SHELL_SRC = readFileSync(resolve(HERE, '..', 'src', 'egg', 'shell.ts'), 'utf8');
const MAIN_SRC = readFileSync(resolve(HERE, '..', 'src', 'main.ts'), 'utf8');
const CSS_SRC = readFileSync(resolve(HERE, '..', 'src', 'ui', 'styles.css'), 'utf8');

test('EGG-16 🔴🔴 dom 型（桌宠/镜像）也必须建 HUD 与退出键', () => {
  // 真缺陷：dom 型分支原来只挂一个空 mount 就走人，于是
  //   桌宠在桌面能按 Esc 退出、在手机 touch 端**根本出不来**（只能杀进程重开）。
  const launch = SHELL_SRC.slice(SHELL_SRC.indexOf('if (isDomGame(def))'));
  const branch = launch.slice(0, launch.indexOf('buildShellDom(def)'));
  assert.match(branch, /mk\('div', 'ns-hud'\)/, 'dom 型分支没建 HUD');
  assert.match(branch, /mk\('span', 'ns-x'/, 'dom 型分支没建退出键');
  //🔴 退出键必须显式包一层箭头函数：直接把 close 当监听器会把 Event 对象
  //   当 fromPop（truthy），UI 退出恒走"不动历史"分支，返回键留在游戏页。
  assert.match(branch, /addEventListener\('click', \(\) => close\(false\)\)/);
  assert.match(branch, /ns-dom/, "dom 型外壳要带 ns-dom 类（决定透明底）");
});

test('EGG-17 🔴🔴 HUD 必须压在 dom 舞台之上（退出键不能被盖住）', () => {
  // 真缺陷：舞台是 fixed inset:0，HUD 无定位时会被盖 ——
  //   症状是"退出键看得见、点不动"。Playwright 的 hit-test 报
  //   `.ns-pet-stage intercepts pointer events`，真机表现是按着没反应。
  // 🔴 必须按 `.ns-hud {` 精确切块：用裸 indexOf('.ns-hud') 会命中
  //   `.ns-hud .ns-x` 之类的前缀，拿到半条声明，判据就成了假红。
  const hudAt = CSS_SRC.indexOf('.ns-hud {');
  assert.ok(hudAt > 0, 'CSS 里找不到 .ns-hud 规则块');
  const hud = CSS_SRC.slice(hudAt, CSS_SRC.indexOf('}', hudAt));
  assert.match(hud, /position:\s*relative/, 'HUD 缺 position:relative');
  assert.match(hud, /z-index:\s*2/, 'HUD 缺 z-index（会被 fixed 舞台盖住）');

  // 舞台的 z-index 只在 .ns-game 层叠上下文**内部**比较，必须低于 HUD
  // 🔴 同样要按规则切块：上面那段注释里就写着 "z-index(2)"，
  //   用 indexOf('.ns-pet-stage') 起切会命中注释里的自述，判据就成了假红。
  const stageAt = CSS_SRC.indexOf('.ns-pet-stage, .ns-mirror-stage {');
  assert.ok(stageAt > 0, 'CSS 里找不到 dom 舞台规则');
  const stage = CSS_SRC.slice(stageAt, CSS_SRC.indexOf('}', stageAt));
  const z = Number(stage.match(/z-index:\s*(\d+)/)?.[1] ?? '999');
  assert.ok(z < 2, `舞台 z-index(${z}) 必须低于 HUD(2)，否则退出键点不动`);
});

test('EGG-18 🔴🔴 门牌直达与退出后重画落地页（e2e 抓到的两个真缺陷）', () => {
  // 缺陷1：`eggLayer?.doorOfPath()` 在懒建前返回 undefined → 直接访问 /snake
  //   （分享链接、书签、APK 冷启）掉进 showHome，门牌链接打不开游戏。
  //   修法：判门前先 ensureEggLayer。
  const route = MAIN_SRC.slice(MAIN_SRC.indexOf('function route()'));
  const eggBranch = route.slice(0, route.indexOf('unlockIfRemembered'));
  assert.match(
    eggBranch,
    /if \(eggLayer === undefined\) ensureEggLayer\(\)/,
    '门牌判定前必须先建彩蛋层（否则门牌直达失效）',
  );

  // 缺陷2：门牌进游戏退出后整页空白（落地页从未渲染，currentPage 停在 egg）。
  assert.match(MAIN_SRC, /onGameClosed:/, '缺 onGameClosed 回调');
  const closed = MAIN_SRC.slice(MAIN_SRC.indexOf('onGameClosed:'));
  assert.match(closed.slice(0, 500), /currentPage !== 'egg'/, 'onGameClosed 未按页面态守卫');
  assert.match(
    closed.slice(0, 700),
    /history\.replaceState\(\{\}, '', '\/'\)/,
    '退出后必须把地址栏从 /snake 拉回 /（否则一刷新又被弹回游戏）',
  );

  // close() 必须在历史还原**之后**才回调，且只在真的开着一局时回调
  //   （launch 内部会先 close 清理上一局，不判会误触发）
  const closeFn = SHELL_SRC.slice(SHELL_SRC.indexOf('function close(fromPop: boolean)'));
  const closeBody = closeFn.slice(0, closeFn.indexOf('\n  return {'));
  assert.match(closeBody, /const wasOpen = cur !== null;/, 'close 未判是否真开着局');
  assert.ok(
    closeBody.indexOf('hooks.onClosed?.()') > closeBody.indexOf('prevPath = undefined'),
    'onClosed 必须在历史还原之后回调（否则回调读到的还是游戏页路径）',
  );
  assert.match(closeBody, /if \(wasOpen\) hooks\.onClosed\?\.\(\);/, 'onClosed 未用 wasOpen 守卫');
});

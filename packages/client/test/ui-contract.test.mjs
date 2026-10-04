/**
 * UI 契约闸 —— 纯逻辑部分（不需要浏览器）
 *
 * 🔴🔴 本文件是 S4 的**第一道闸**，钉住"用户可见行为与老项目一致"这件事。
 *   用户明确要求「体验/UI和现在完全一致」，而"一致"是最容易悄悄漂移的东西：
 *   改个标点、删个字、调个时间边界，用户不会说"坏了"，只会说"感觉不一样了"。
 *   所以可见文案与判定逻辑必须**逐字断言**，一个标点都不放过。
 *
 * 覆盖：
 *   1. 可见文案逐条（与老项目 index.html 逐字比对，抄写时手误立刻红）
 *   2. 菜单 11 项 id 齐全、顶栏 7 可见 + 2 隐藏
 *   3. 落地页输入净化规则
 *   4. 主题时间规则边界（19:00-07:00）与三级优先级
 *   5. 皮肤三态环推进与字标
 *
 * 浏览器部分（键位可见性、面板切换、DOM 结构）在 e2e 里，见 test/e2e/02-ui-shell.test.js。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  applyThemeVars,
  bodyClassFor,
  isNightByClock,
  nextSkin,
  PALETTE,
  resolveTheme,
  skinOverlayStyle,
  SKIN_LABELS,
  SKIN_WORDS,
} from '../src/ui/theme.ts';
import { COPY, MENU_ITEM_IDS, TOPBAR_HIDDEN_IDS, TOPBAR_VISIBLE_IDS } from '../src/ui/copy.ts';
import { isEggRoute, sanitizeNoteName } from '../src/ui/landing-logic.ts';

/* ---------------- 1. 可见文案逐条 ---------------- */

test('S4-C1 落地页文案逐字与老项目一致', () => {
  // 🔴 这些字抄自TraeProject/notesync/index.html。改任何一个都会红。
  assert.equal(COPY.brandName, 'NoteSync');
  assert.equal(COPY.landingSub, '落笔即心安');
  assert.equal(COPY.landingPlaceholder, '笔记名（英文/数字）');
  assert.equal(COPY.landingBtnOpen, '打开');
  assert.equal(COPY.landingBtnEgg, '打开彩蛋');
  assert.equal(COPY.landingWarn, '仅支持英文、数字、下划线和短横线');
  assert.equal(COPY.landingUrlPrefix, '你的笔记网址为：');
  assert.equal(COPY.landingScan, '扫码打开笔记');
  assert.equal(COPY.trustCipher, '服务器只见密文');
  assert.equal(COPY.trustNoAccount, '无需账号');
  assert.equal(COPY.trustScan, '扫码跨设备');
});

test('S4-C2 口令页与首页文案逐字一致（含全角括号与句号）', () => {
  assert.equal(COPY.passTitle, '输入口令');
  //🔴 这一句最容易在复制粘贴时丢句号或把全角括号变半角，单独断一条
  assert.equal(
    COPY.passHint,
    '此口令用于在本机派生加密密钥，不会发送到服务器。每台新设备首次打开需输入一次，之后自动记住。',
  );
  assert.ok(COPY.passHint.endsWith('。'), '说明句末句号丢了');
  // 🔴 这句里不能出现半角括号 —— 老项目原文用的是中文标点，混进半角会显得像乱码
  assert.ok(!COPY.passHint.includes('('), '说明里混进了半角左括号');
  assert.ok(!COPY.passHint.includes(')'), '说明里混进了半角右括号');
  assert.equal(COPY.passBtn, '解 锁', '「解 锁」中间是空格，不是「解锁」');
  assert.equal(COPY.passCloseTitle, '返回首页');
  assert.equal(COPY.homeHintLead, '请在 URL 后加笔记名访问，例如：');
});

test('S4-C3 菜单 11 项文案逐字一致', () => {
  assert.equal(COPY.menuHome, '返回首页');
  assert.equal(COPY.menuFavOn, '收藏笔记');
  assert.equal(COPY.menuFavOff, '取消收藏');
  assert.equal(COPY.menuFavEntry, '收藏夹');
  assert.equal(COPY.menuHistEntry, '历史版本');
  assert.equal(COPY.menuLink, '打开链接');
  assert.equal(COPY.menuBackup, '扫码换机');
  assert.equal(COPY.menuPet, '桌宠');
  assert.equal(COPY.menuThemeDark, '夜间模式');
  assert.equal(COPY.menuThemeLight, '日间模式');
  assert.equal(COPY.menuPass, '修改口令');
  assert.equal(COPY.menuLock, '退出锁定');
  assert.equal(COPY.menuAbout, '关于 NoteSync');
});

test('S4-C4 二级视图与底栏文案逐字一致', () => {
  assert.equal(COPY.back, '返回');
  assert.equal(COPY.favEmpty, '暂无收藏');
  assert.equal(COPY.histEmpty, '暂无历史版本');
  assert.equal(COPY.histSave, '新增历史版本');
  assert.equal(COPY.linkKicker, '链接打开方式');
  assert.equal(COPY.linkInApp, '应用内');
  assert.equal(COPY.linkBrowser, '系统浏览器');
  // 🔴 这句末尾有句号，且"仅对本机生效"是关键承诺（不能被改成全局设置）
  assert.equal(COPY.linkHint, '笔记里的网址默认打开方式，仅对本机生效。');
  assert.equal(COPY.statusConnecting, '连接中…', '是竖排省略号…，不是...');
  assert.equal(COPY.offlinePrefix, '· 最后同步：');
});

test('S4-C5 顶栏 7 键 title 逐字一致（含全角括号）', () => {
  assert.equal(COPY.titleStrike, '删除线');
  assert.equal(COPY.titleRemind, '提醒（到点通知或下次打开提示）');
  assert.equal(COPY.titleUpload, '上传图片');
  assert.equal(COPY.titleCopy, '复制到剪贴板');
  assert.equal(COPY.titleExport, '导出为图片并复制');
  assert.equal(COPY.titleScan, '扫一扫');
  assert.equal(COPY.titleQr, '二维码配对');
  assert.equal(COPY.titleMenu, '菜单');
  assert.equal(COPY.titleRefresh, '刷新');
});

test('S4-C6 彩蛋门牌提示句式', () => {
  assert.equal(COPY.eggReservedTip('pet'), 'pet 是彩蛋门牌，不会新建笔记');
});

/* ---------------- 2. 键位与菜单结构 ---------------- */

test('S4-S1 菜单恰好 11 项且无重复', () => {
  assert.equal(MENU_ITEM_IDS.length, 11);
  assert.equal(new Set(MENU_ITEM_IDS).size, 11, '菜单项 id 有重复');
  // 逐个点名，防止有人"顺手"改 id 而清单没跟
  assert.deepEqual(
    [...MENU_ITEM_IDS],
    ['menuHome', 'menuFav', 'menuFavEntry', 'menuHistEntry', 'menuLink',
     'menuBackup', 'menuPet', 'menuTheme', 'menuPass', 'menuLock', 'menuAbout'],
  );
});

test('S4-S2 顶栏7 可见 + 2 隐藏，两组不相交', () => {
  assert.equal(TOPBAR_VISIBLE_IDS.length, 7);
  assert.equal(TOPBAR_HIDDEN_IDS.length, 2);
  assert.deepEqual([...TOPBAR_HIDDEN_IDS], ['themeBtn', 'lock']);
  // 🔴 交集必须为空：themeBtn/lock 出现在可见清单里就等于"多画了两个按钮"
  for (const id of TOPBAR_HIDDEN_IDS) {
    assert.ok(!TOPBAR_VISIBLE_IDS.includes(id), `${id} 同时出现在可见与隐藏清单`);
  }
});

/* ---------------- 3. 落地页输入净化 ---------------- */

test('S4-N1 输入净化只留英文/数字/下划线/短横线', () => {
  assert.equal(sanitizeNoteName('abc'), 'abc');
  assert.equal(sanitizeNoteName('a_b-c'), 'a_b-c');
  assert.equal(sanitizeNoteName('123'), '123');
  // 中文、空格、全角符号、斜杠一律剔除
  assert.equal(sanitizeNoteName('我的笔记'), '我的笔记'.replace(/[^A-Za-z0-9_-]/g, ''));
  assert.equal(sanitizeNoteName('a b'), 'ab');
  assert.equal(sanitizeNoteName('a/b?c=d'), 'abcd');
  assert.equal(sanitizeNoteName('a<b>c'), 'abc');
  assert.equal(sanitizeNoteName('a💡b'), 'ab');
  assert.equal(sanitizeNoteName(''), '');
  // 幂等：净化两次与一次相同（否则"边打字边净化"会抖）
  const once = sanitizeNoteName('a b中c');
  assert.equal(sanitizeNoteName(once), once);
});

/* ---------------- 4. 主题 ---------------- */

test('S4-T1 时间规则边界：19:00-07:00 为夜间（老项目原文）', () => {
  const at = (h, m = 0) => new Date(2026, 9, 5, h, m);
  // 日间
  assert.equal(isNightByClock(at(7, 0)), false, '07:00 整应是白天（规则是 <420才夜间）');
  assert.equal(isNightByClock(at(12, 0)), false);
  assert.equal(isNightByClock(at(18, 59)), false, '18:59 应是白天');
  // 夜间
  assert.equal(isNightByClock(at(19, 0)), true, '19:00 整应是夜间（规则是 >=1140）');
  assert.equal(isNightByClock(at(23, 59)), true);
  assert.equal(isNightByClock(at(0, 0)), true);
  assert.equal(isNightByClock(at(6, 59)), true, '06:59 应是夜间');
});

test('S4-T2 主题优先级只有两级：手动 > 时间规则（老项目没有"跟随系统"）', () => {
  const noon = new Date(2026, 9, 5, 12, 0);
  const night = new Date(2026, 9, 5, 22, 0);
  // 手动优先：白天手动选夜间 / 夜里手动选白天
  assert.equal(resolveTheme(true, noon), 'dark');
  assert.equal(resolveTheme(false, night), 'light');
  // 无手动 → 时间规则
  assert.equal(resolveTheme(null, noon), 'light');
  assert.equal(resolveTheme(null, night), 'dark');
  // 🔴 只有两个参数。老项目主题就日/夜两态，菜单里是两个互斥项，没有"跟随系统"。
  //   多加一层就意味着某些机器上首屏颜色与老项目不同 = 复刻失败。
  assert.equal(resolveTheme.length, 2, 'resolveTheme 不该有第三个参数（系统跟随层）');
});

test('S4-T3 色板逐字与老项目一致（浅色暖白，拒纯白）', () => {
  assert.equal(PALETTE.light.bg, '#FBFBF8');
  assert.equal(PALETTE.light.fg, '#1C1C1A');
  assert.equal(PALETTE.light.muted, '#98958A');
  assert.equal(PALETTE.light.line, '#ECEAE2');
  assert.equal(PALETTE.light.accent, '#8F7126');
  assert.equal(PALETTE.light.boxBg, '#FFFFFF');
  assert.equal(PALETTE.light.danger, '#C0453E');
  assert.equal(PALETTE.dark.bg, '#0F0F11');
  assert.equal(PALETTE.dark.fg, '#E9E8E3');
  assert.equal(PALETTE.dark.accent, '#D4B068');
  // 🔴 用户明确"浅色高级风、拒黑底"：浅色底必须是暖白，不能被改成纯白
  assert.notEqual(PALETTE.light.bg, '#FFFFFF', '浅色底被改成纯白了');
});

test('S4-T4 body class 组合正确（dark / skin-a / skin-b 可共存）', () => {
  assert.equal(bodyClassFor('light', 'default'), '');
  assert.equal(bodyClassFor('dark', 'default'), 'dark');
  assert.equal(bodyClassFor('light', 'terminal'), 'skin-a');
  assert.equal(bodyClassFor('light', 'typewriter'), 'skin-b');
  // 夜间 + 复古皮肤要能同时生效（老项目皮肤环内点日夜只换配色、不出环）
  assert.equal(bodyClassFor('dark', 'terminal'), 'dark skin-a');
  assert.equal(bodyClassFor('dark', 'typewriter'), 'dark skin-b');
});

test('S4-T5 applyThemeVars 写进 CSS 变量且切dark class', () => {
  // 造个最小 DOM 替身：只用到 style.setProperty 与 classList.toggle
  const props = new Map();
  const classes = new Set();
  const fake = {
    style: { setProperty: (k, v) => props.set(k, v) },
    classList: {
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
  };

  applyThemeVars('light', fake);
  assert.equal(props.get('--bg'), '#FBFBF8');
  assert.equal(classes.has('dark'), false);
  // 🔴 先取浅色的遮罩色，再切夜间 —— 取值顺序错了这条断言就变成自己比自己
  const lightMask = props.get('--mask-bg');

  applyThemeVars('dark', fake);
  assert.equal(props.get('--bg'), '#0F0F11');
  assert.equal(classes.has('dark'), true, '切夜间必须加 body.dark（CSS 全靠这个类）');

  // 🔴 变量名不许变：CSS 里写的是 var(--accent-soft)，对不上就静默失效
  for (const k of ['--bg', '--fg', '--muted', '--line', '--accent', '--accent-soft',
    '--ring', '--box-bg', '--upload-bg', '--hover', '--danger', '--serif', '--mono',
    '--mask-bg']) {
    assert.ok(props.has(k), `缺少 CSS 变量 ${k}`);
  }
  // 🔴 遮罩色必须随主题变：写死一个值 = 夜间模式下遮罩还是暖调深色
  assert.notEqual(props.get('--mask-bg'), lightMask, '遮罩色没随主题切换');
});

/* ---------------- 4b. 皮肤覆膜层 ---------------- */

test('S4-T6 覆膜层纹理随皮肤与昼夜变化，default 档必须完全空', () => {
  // 🔴 default 档残留一层扫描线是最难察觉的 UI 漂移（用户看不出"少了什么"，只觉得"脏"）
  assert.equal(skinOverlayStyle('default', false), '');
  assert.equal(skinOverlayStyle('default', true), '');
  // 终端绿：昼夜不同深浅
  const scanDay = skinOverlayStyle('terminal', false);
  const scanNight = skinOverlayStyle('terminal', true);
  assert.notEqual(scanDay, scanNight, '终端绿扫描线昼夜应不同');
  assert.ok(scanDay.includes('repeating-linear-gradient'));
  // 打字机纸：横竖双向格线
  const paper = skinOverlayStyle('typewriter', false);
  assert.ok(paper.includes('to bottom') && paper.includes('to right'), '打字机纸应有横竖两种格线');
  assert.notEqual(paper, skinOverlayStyle('typewriter', true));
});

test('S4-T7 颜色字面量只允许出现在 theme.ts（纪律闸）', () => {
  // 🔴 纪律的机械校验：CSS 与渲染函数里出现颜色字面量 = 改配色时会漏改。
  //   症状是"夜间模式某处还是浅色的"，极难联想到是色板漏了。
  const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  // 去掉注释后再找，避免"注释里写了颜色名"造成误报
  const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const hex = cssNoComment.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], `styles.css 出现颜色字面量${JSON.stringify(hex)}，应改用 var(--*)`);
  const rgba = cssNoComment.match(/rgba?\(/g) ?? [];
  assert.deepEqual(rgba, [], `styles.css 出现 rgba 字面量 ${rgba.length} 处，应提到 ui/theme.ts 的 OVERLAY`);

  // 渲染模块（除 theme.ts 自身）同样不许带颜色
  for (const f of ['copy.ts', 'icons.ts', 'pages.ts', 'landing-logic.ts']) {
    const src = readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8');
    const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hits = noComment.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? [];
    assert.deepEqual(hits, [], `ui/${f} 出现颜色字面量 ${JSON.stringify(hits)}`);
  }
});

/* ---------------- 5. 皮肤三态环 ---------------- */

test('S4-K1 七连点前进一格、四连点回默认', () => {
  // 老项目：连点logo 7 次沿 默认→终端绿→打字机纸→默认 前进一格
  let s = 'default';
  s = nextSkin(s); assert.equal(s, 'terminal', '第 1 次应是终端绿');
  s = nextSkin(s); assert.equal(s, 'typewriter', '第 2 次应是打字机纸');
  s = nextSkin(s); assert.equal(s, 'default', '第 3 次应回到默认（三态成环）');
});

test('S4-K2 皮肤字标与提示文案逐字一致', () => {
  assert.equal(SKIN_WORDS.default, 'NoteSync');
  assert.equal(SKIN_WORDS.terminal, 'NOTE-SYNC.EXE');
  assert.equal(SKIN_WORDS.typewriter, 'N O T E S Y N C');
  assert.equal(SKIN_LABELS.default, '已恢复默认');
  assert.equal(SKIN_LABELS.terminal, '复古 · 终端绿');
  assert.equal(SKIN_LABELS.typewriter, '复古 · 打字机纸');
  // 🔴 打字机纸字标是逐字加空格，漏一个就变不成效果
  assert.equal(SKIN_WORDS.typewriter, 'N O T E S Y N C');
  assert.equal(SKIN_WORDS.typewriter.split(' ').length, 8, '打字机纸字标应是 8 个字母段');
  assert.equal(SKIN_WORDS.typewriter.replace(/ /g, ''), 'NOTESYNC', '字标去掉空格应还原成 NoteSync');
});

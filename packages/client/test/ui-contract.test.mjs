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
  skinTokens,
  SKIN_LABELS,
  SKIN_PALETTE,
  SKIN_WORDS,
} from '../src/ui/theme.ts';
import { COPY, MENU_ITEM_IDS, TOPBAR_HIDDEN_IDS, TOPBAR_VISIBLE_IDS } from '../src/ui/copy.ts';
// 🔴 import 生产代码里的 footText，不是把它的逻辑抄进测试 —— 抄一遍就恒真了（见 S4-D1 注释）
import { footText } from '../src/ui/shell.ts';
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
  // 🔴 口径变更（用户报障第 6 条「文案和颜色和老版本不一样」）：
  //   老项目 index.html:10187-10192 把提示行拆成**两段**——
  //   `<b>/门牌名</b>` + 裸文字「 是彩蛋门牌，不会新建笔记」，
  //   因为 `.eggtip b{color:var(--accent);font-weight:600}` 要求**只有门牌名金黄**。
  //   合成一整句就没法单独上色，bj 此前正是整行同一颜色。
  //   拼接后的整行文本（用户实际看到的）必须逐字等于老项目。
  assert.equal(COPY.eggReservedTipSuffix, ' 是彩蛋门牌，不会新建笔记');
  assert.equal(`/${'pet'}${COPY.eggReservedTipSuffix}`, '/pet 是彩蛋门牌，不会新建笔记');
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
  // 🔴🔴 打字机纸：**只有横向**稿纸线（老项目 index.html:317-318 逐字）。
  //   2026-10-09 修订（用户报障第 9 条）：此前这里断言的是"横竖双向格线"，
  //   那是把老项目"打字机稿纸"误读成"工程方格纸"的旧实现；老项目实为单向红线。
  //   判据跟着改成「有横向 + **无纵向**」——"应该有"配一条"不应该有"。
  const paper = skinOverlayStyle('typewriter', false);
  assert.ok(paper.includes('to bottom'), '打字机纸应有横向稿纸线');
  assert.ok(!paper.includes('to right'), '打字机纸不应有纵向格线（老项目只有横向）');
  assert.notEqual(paper, skinOverlayStyle('typewriter', true));
});

/* ---------------- 4c. 皮肤整站换色（用户报障第 9 条） ---------------- */

/** 造最小 DOM 替身：只用到 style.setProperty 与 classList.toggle。 */
function fakeRoot() {
  const props = new Map();
  const classes = new Set();
  return {
    props,
    classes,
    el: {
      style: { setProperty: (k, v) => props.set(k, v) },
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    },
  };
}

test('S4-T8 🔴🔴 皮肤必须**整站换色**（老项目 NS_SKIN_PALETTES），default 档绝不覆盖', () => {
  // 🔴🔴 用户报障第 9 条的正身：此前 applyThemeVars 只吃主题、不吃皮肤，
  //   于是「终端绿 / 打字机纸」只换了字形，**配色仍是暖白底 + 品牌金** ——
  //   与老项目并排一眼看出。这条判据钉的就是"皮肤真的换了色"。

  // ① default 档：一律走主主题，绝不覆盖
  const d = fakeRoot();
  applyThemeVars('light', d.el, 'default');
  assert.equal(d.props.get('--bg'), PALETTE.light.bg, 'default 档不该改底色');
  assert.equal(d.props.get('--accent'), PALETTE.light.accent, 'default 档不该改强调色');
  assert.equal(d.props.get('--caret'), PALETTE.light.fg, 'default 档 caret 应回落到 --fg');
  // 反向：不传第三参（旧调用形态）必须与传 'default' 等价 —— 别让可选参数改变语义
  const d2 = fakeRoot();
  applyThemeVars('light', d2.el);
  assert.equal(d2.props.get('--bg'), d.props.get('--bg'), '不传皮肤应等价于 default');

  // ② 皮肤档：九档色逐档对齐 SKIN_PALETTE，且与主主题不同
  for (const skin of ['terminal', 'typewriter']) {
    for (const night of [false, true]) {
      const theme = night ? 'dark' : 'light';
      const want = SKIN_PALETTE[skin][night ? 'night' : 'day'];
      const r = fakeRoot();
      applyThemeVars(theme, r.el, skin);
      assert.equal(r.props.get('--bg'), want.bg, `${skin}/${theme} 底色必须换`);
      assert.equal(r.props.get('--fg'), want.fg, `${skin}/${theme} 字色必须换`);
      assert.equal(r.props.get('--muted'), want.muted, `${skin}/${theme} 次要字色必须换`);
      assert.equal(r.props.get('--line'), want.line, `${skin}/${theme} 线色必须换`);
      assert.equal(r.props.get('--box-bg'), want.box, `${skin}/${theme} 卡片底必须换`);
      assert.equal(r.props.get('--accent'), want.accent, `${skin}/${theme} 强调色必须换`);
      assert.equal(r.props.get('--accent-soft'), want.soft, `${skin}/${theme} 强调软底必须换`);
      assert.equal(r.props.get('--dot-idle'), want.dot, `${skin}/${theme} 空闲点必须换`);
      assert.equal(r.props.get('--caret'), want.caret, `${skin}/${theme} 光标色必须换`);
      // 与主主题**确实不同**（否则"换了色"是空话）
      assert.notEqual(want.bg, PALETTE[theme].bg, `${skin}/${theme} 底色必须区别于主主题`);
    }
  }

  // ③ 四档两两不同（终端绿昼/夜、打字机昼/夜各是各的）
  const seen = new Set();
  for (const skin of ['terminal', 'typewriter']) {
    for (const night of [false, true]) {
      seen.add(SKIN_PALETTE[skin][night ? 'night' : 'day'].bg);
    }
  }
  assert.equal(seen.size, 4, '四档皮肤底色必须两两不同（复制粘贴会撞色）');

  // ④ 反向：皮肤只覆盖九类，其余令牌（--ring/--danger）保持主主题值 ——
  //   老项目皮肤 CSS 也只改九类；顺手全改会把删除线/危险色一起带偏。
  const r2 = fakeRoot();
  applyThemeVars('light', r2.el, 'terminal');
  assert.equal(r2.props.get('--danger'), PALETTE.light.danger, '皮肤不该动危险色');
});

test('S4-T9 skinTokens：default 返回 null（= 不覆盖），皮肤档返回当日/夜九档', () => {
  assert.equal(skinTokens('default', false), null);
  assert.equal(skinTokens('default', true), null);
  assert.deepEqual(skinTokens('terminal', true), SKIN_PALETTE.terminal.night);
  assert.deepEqual(skinTokens('typewriter', false), SKIN_PALETTE.typewriter.day);
  // 🔴 键必须齐九档（少一档 = 那一处静默不换色，且没有任何报错）
  for (const skin of ['terminal', 'typewriter']) {
    for (const night of [false, true]) {
      assert.deepEqual(
        Object.keys(skinTokens(skin, night)).sort(),
        ['accent', 'bg', 'box', 'caret', 'dot', 'fg', 'line', 'muted', 'soft'],
        `${skin}/${night} 必须齐九档`,
      );
    }
  }
});

test('S4-T7 颜色字面量只允许出现在 theme.ts（纪律闸）', () => {
  // 🔴 纪律的机械校验：CSS 与渲染函数里出现颜色字面量 = 改配色时会漏改。
  //   症状是"夜间模式某处还是浅色的"，极难联想到是色板漏了。
  const css = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
  // 去掉注释后再找，避免"注释里写了颜色名"造成误报
  const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const hex = cssNoComment.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], `styles.css 出现颜色字面量${JSON.stringify(hex)}，应改用 var(--*)`);
  // 🔴🔴 颜色函数要一次查全：只查 rgba( 时 rgb(/hsl(/hwb()/color() 会从缝里漏出去。
  //   本闸第一版就漏了 rgba(255,255,255,.04) 这种"内描边"，因为它藏在
  //   box-shadow 里而不是看起来像颜色的属性上 —— 判据不能靠"看起来像颜色"。
  const rgba = cssNoComment.match(/(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/g) ?? [];
  assert.deepEqual(rgba, [], `styles.css 出现颜色函数 ${rgba.length} 处，应提到 ui/theme.ts 的 OVERLAY`);

  // 🔴 反向也钉一下：新增的固定色必须真的在色板里，不能是"顺手加了变量名但没人注入"
  //   （症状 = 扫码时那块变成透明/继承色，比直接写死还难查）。
  const theme = readFileSync(new URL('../src/ui/theme.ts', import.meta.url), 'utf8');
  for (const v of ['--qr-paper', '--scan-stage-a', '--scan-stage-b', '--scan-stage-edge', '--scan-stage-text']) {
    assert.ok(theme.includes(v.slice(2)), `色板里应有${v}的定义`);
  }

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

/* ---------------- 底栏状态文案（用户报障第 3 条）---------------- */

/**
 * 🔴🔴 这条断言的来历值得留着，别当"补个文案"删掉。
 *
 * 报障原话：「底部没有已同步三个字」。
 * 真因不是漏抄一个字，而是**抄错了语义**：
 *   - 老项目 `setStatus(on, text)` = `statusText.textContent = text`（**无条件**赋值），
 *     同步成功时 7 处调用都传 '已同步'，所以底栏**有**这三个字；
 *   - bj 抄成了 `textContent = detail ?? ''`，注释写"老项目是静默"——
 *     但老项目的"静默"来自**不调 setStatus**，不是靠空串表达；
 *   - 而 `footFor('idle')` 恰好返回 `{s:'synced'}` 不带 detail
 *     ⇒ `'' ?? ''` ⇒ 同步完成后底栏**一个字都没有**。
 *
 * 为什么此前 444 条单测全绿：没有任何一条断言碰过 synced 分支的**渲染结果**，
 * `COPY.statusSynced` 这个键**压根不存在**，自然也没人断言它。
 *
 * 🔴🔴 判据的关键教训（我第一版就踩了）：**别在测试里重抄一遍实现**。
 *   第一版把三分支原样抄进测试，结果把 shell.ts 改回buggy 形式它**照样绿**——
 *   恒真断言等于没有断言。所以下面直接 import 生产代码里的 `footText`，
 *   它改了测试才红。同理，测试编号必须唯一：本文件已有一处 S4-C6（彩蛋门牌），
 *   重复编号会让失败定位指向错的用例，这条用 S4-D1。
 */
test('S4-D1 底栏三态文案：synced 必须显示「已同步」，不得为空串', () => {
  // 1) 字面量逐字（老项目 index.html 里 setStatus(true, '已同步') 的同一个串）
  assert.equal(COPY.statusSynced, '已同步', '同步成功文案必须逐字等于老项目的「已同步」');

  // 2) 🔴 真正的判据：跑**生产代码里那个函数**，不是测试里抄的副本
  // footFor('idle') 不传 detail —— 这条正是本次实锤的触发路径
  assert.equal(footText('synced', undefined), '已同步', 'idle 同步完成后底栏必须有文案');
  assert.notEqual(footText('synced', undefined), '', '绝不允许退化成空串');

  // detail 优先：e2e 07-fav 断言的「收藏最多 100 篇」走的就是这条
  assert.equal(footText('synced', '收藏最多 100 篇'), '收藏最多 100 篇', 'detail 必须优先于默认文案');
  assert.equal(footText('connecting', undefined), '连接中…', '无 detail 时回落连接中');
  // 🔴 footFor 把 dirty/pushing 映到 connecting 并带 d='保存中…'，
  //    此前该detail 被无条件写 statusConnecting吞掉，"保存中…"与"连接中…"完全同形。
  assert.equal(footText('connecting', '保存中…'), '保存中…', 'connecting 态的 detail 不得被吞');
  assert.equal(footText('offline', '离线中'), '· 最后同步：离线中', '离线态走 offlinePrefix 前缀');

  // 3) 🔴 空串必须回落默认文案（`||` 而非 `??` 的理由）：
  //    detail 传空串若被当成有效值，用户改一次密码就又看到"底栏空了"。
  assert.equal(footText('synced', ''), '已同步', '空串 detail 应回落到默认文案，不得渲染成空');
  assert.equal(footText('connecting', ''), '连接中…', '空串 detail 不应渲染成空');
});

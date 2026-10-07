/**
 * BTN-xxxx 判据 —— 用户报障第 2 条「弹窗内下方按钮颜色不对」
 *
 * 🔴🔴 这条是上一批引入的回归。**根因是判据读漏了老项目的一条运行时 `!important`**，
 *   所以本批的判据必须把那件事写清楚，否则同一个错会再犯一次。
 *
 * 老项目真相（index.html）：
 *   · :1063 在 themeCssCore()（:1045-1067）里，由 applyTheme 在 :1269 **无条件**挂到
 *     documentElement：
 *       .box button:not(:disabled):not(.box-x){
 *         background:${p.fg}!important;color:${p.bg}!important;
 *         -webkit-text-fill-color:${p.bg}!important}
 *     specificity (0,3,1) + !important
 *   · 因此源码 :518 的 `.box button.ghost-btn{background:none;color:var(--muted);…}`
 *     **实际不生效**：background/color/font-weight 被吃回，只剩 margin-top:10px 与 border
 *   · 真实渲染：非禁用、非 .box-x 的按钮一律 `--fg` 深底 / `--bg` 浅字
 *     （日间实测 rgb(28,28,26) 底 / rgb(251,251,248) 字）
 *
 * 上一批的错误：误以为非禁用按钮底色来自基础规则的 `--fg` 之外还另有"次要按钮"，
 * 于是加了一条 `.box button:not(.box-x):not(:disabled){background:var(--hover); …}`
 * 去"模拟 ghost-btn" —— `--hover` 日间是 rgba(28,28,26,.05)，几乎等于页面底色，
 * 于是把深底刷成**浅灰淡底**。用户看到的就是"按钮颜色和老版本不一样"。
 *
 * 判据纪律：
 *   · 必须读**样式表声明**（生产产物 styles.css），不把期望值抄进测试当实现
 *   · 每条「应该有」配一条「不应该有」
 *   · 断言「某段 CSS 不存在」时，输入必须是**去注释后的 CSS**
 *     （注释里写着"绝不在这里写 xxx"会让 doesNotMatch 命中警告本身）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
/**
 * 🔴🔴 去注释后的 CSS。断言"某条规则不存在"时**必须**用它当输入：
 *   本文件注释里就写着「绝不许再叠加一条覆写」这类警告，
 *   拿原始CSS 去 doesNotMatch 会命中**那句警告本身**，判据红在假的地方。
 */
const CSS_BODY = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取一条规则（按选择器精确匹配），拿不到返回空串 */
function rule(selector) {
  const re = new RegExp('(^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = CSS_BODY.match(re);
  return m ? m[2].trim() : '';
}

/* ---------------- 1. 金标：非禁用按钮是深底浅字（老项目 :1063）---------------- */

test('BTN-01 `.box button:not(.box-x)` 底色走 --upload-bg、字色走 --bg', () => {
  const base = rule('.box button:not(.box-x)');
  assert.ok(base, '缺 .box button:not(.box-x) 基础规则（老项目 :516 同款）');
  // --upload-bg 就是 --fg / --bg 二选一（theme.ts:91 日间 #1C1C1A、:121 夜间 #E9E8E3），
  // 与老项目 :1063 的 `${p.fg}` 底等价。
  assert.match(base, /background:\s*var\(--upload-bg\)/, '弹窗按钮底色必须走 --upload-bg（≡ 老项目 :1063 的 --fg）');
  assert.match(base, /color:\s*var\(--bg\)/, '弹窗按钮字色必须走 --bg（≡ 老项目 :1063 的 --bg）');
});

test('BTN-02 主题里 --upload-bg 确实取 --fg 语义（日间深色），确保上一条不是空转', () => {
  // 🔴 这条是为了防止 BTN-01 变成"两个变量恰好都叫不出错的空断言"。
  const theme = readFileSync(new URL('../src/ui/theme.ts', import.meta.url), 'utf8');
  // 日间 uploadBg 深色（≈ 老项目日间 --fg #1C1C1A），夜间浅色
  assert.match(theme, /uploadBg:\s*'#1C1C1A'/, '日间 --upload-bg 应是深色（老项目实测底rgb(28,28,26)）');
  assert.match(theme, /uploadBg:\s*'#E9E8E3'/, '夜间 --upload-bg 应是浅色');
  // 反向：--hover 是"几乎等于页面底色"的淡色，绝不能拿它当按钮底
  assert.match(theme, /hover:\s*'rgba\(28,28,26,\.05\)'/, '--hover 是极淡的叠色，用它当按钮底就是本次回归的根因');
});

/* ---------------- 2. 反向：那条 --hover刷底规则必须不存在（回归守卫）---------------- */

test('BTN-03 反向：styles.css 里不存在 `.box button:not(.box-x):not(:disabled)` 这条覆写', () => {
  const found = CSS_BODY.match(/\.box button:not\(\.box-x\):not\(:disabled\)\s*\{/g) ?? [];
  assert.deepEqual(
    found,
    [],
    '老项目非禁用按钮的真实渲染由 :1063 的 !important 决定（--fg 底 / --bg 字），'
    + '不许再叠加一条"次要按钮"覆写把它刷成浅色',
  );
});

test('BTN-04 反向：任何 .box button 规则都不许拿 --hover 当background', () => {
  // 比 BTN-03 更宽的守卫：将来若有人换个选择器（如 :not(.box-x):hover 之类）再刷一次，同样拦住。
  // 只在 .box button* 的规则块内找 background 里的 --hover。
  const btnRules = CSS_BODY.match(/\.box button[^{]*\{[^}]*\}/g) ?? [];
  const offenders = btnRules.filter((r) => /background:[^;}]*--hover/.test(r));
  assert.deepEqual(
    offenders,
    [],
    `.box button 的底色不许走 --hover（老项目是 --fg 深底）：\n${offenders.join('\n')}`,
  );
});

test('BTN-05 ghost-btn 只照抄运行时**活下来**的那两条声明', () => {
  // 🔴🔴🔴 本条原先断言「`.box button.ghost-btn{` 一条都不许存在」，**那个判据是错的**
  //   （老判据钉错 —— 2026-10-07 真浏览器取证推翻）。
  //
  //   真值（Playwright 打开老项目 index.html，日间主题，改口令弹窗 #cpMask 内实读
  //   getComputedStyle(#cpCancel)）：
  //     marginTop        = 10px          ← 存活
  //     borderTopWidth   = 1px / solid   ← 存活
  //     background       = rgb(28,28,26)  = --fg（深底，被 :1063 !important 吃回）
  //     color            = rgb(251,251,248) = --bg（同上）
  //     fontWeight       = 400           ← 被吃回
  //   ⇒ 老项目 :1063 的 `!important` 覆盖层只声明 background/color/-webkit-text-fill-color，
  //   **不碰 margin-top 与 border**，所以这两条确实存活。
  //   而 bj 的 buildChangePass(pages.ts:220) 给「取消」挂了 class="ghost-btn"，
  //   样式表里却没有对应规则 ⇒ 类名挂了等于没挂，两枚按钮贴死（用户报障第 5 条）。
  //
  //   ⇒ 判据改成：照抄 margin-top/border，且**只准抄这两条**。
  const ghost = rule('.box button.ghost-btn');
  assert.ok(ghost, '缺 .box button.ghost-btn 规则（老项目 :518 的类名必须被样式表接住）');
  assert.match(ghost, /margin-top:\s*10px/, '老项目 #cpCancel 实测 marginTop=10px');
  assert.match(ghost, /border:\s*1px solid var\(--line\)/, '老项目 #cpCancel 实测 border=1px solid');
  // 反向：背景/字色/字重三条在老项目被 !important 吃回，照抄会做出老项目没有的样式
  assert.doesNotMatch(ghost, /background/, '老项目 ghost-btn 的 background 被 :1063 !important 吃回，不许照字面写');
  assert.doesNotMatch(ghost, /color/, '老项目 ghost-btn 的 color 被 :1063 !important 吃回，不许照字面写');
  assert.doesNotMatch(ghost, /font-weight/, '老项目 ghost-btn 的 font-weight 被 :1063 !important 吃回');
});

/* ---------------- 3. 禁用态保持不变（这条不许被本次修改带坏）---------------- */

test('BTN-06 禁用态照抄老项目 :522：--line 底 / --muted 字 / opacity 1', () => {
  const dis = rule('.box button:not(.box-x):disabled');
  assert.ok(dis, '缺禁用态规则');
  assert.match(dis, /background:\s*var\(--line\)/, '禁用底色走 --line（老项目 :522）');
  assert.match(dis, /color:\s*var\(--muted\)/, '禁用字色走 --muted');
  assert.match(dis, /opacity:\s*1/, '禁用态是"浅灰底+灰字"，不是整枚变淡（老项目明确写 1）');
  // 反向：禁用态不得被本次改动沾上 --upload-bg
  assert.doesNotMatch(dis, /--upload-bg/, '禁用态必须仍是 --line 底，与非禁用态区分开');
});

/* ---------------- 4. 通栏规则本身没被碰（老项目 :516）---------------- */

test('BTN-07 `.box button:not(.box-x)` 的通栏规则完好（老项目 :516）', () => {
  const base = rule('.box button:not(.box-x)');
  assert.match(base, /width:\s*100%/, '弹窗内每一个按钮都吃通栏规则（老项目 :516 同选择器）');
  assert.match(base, /height:\s*46px/, '老项目 46px 高');
  assert.match(base, /border-radius:\s*10px/);
  assert.match(base, /font-size:\s*15px/);
  // 反向：`:not(.box-x)` 的排除是承重的——.box-x 是 36x36 方键，
  // 被通栏规则覆盖会渲染成 46px 实底条（老项目 v6.2 专门为此加的排除）
  assert.match(
    CSS_BODY,
    /\.box button:not\(\.box-x\)/,
    '选择器必须保留 :not(.box-x) 排除',
  );
});
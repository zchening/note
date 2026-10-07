/**
 * 视觉/行为对齐闸 —— 本批（用户报障第 3/4/5/7/8/9/12 条 + 彩蛋顶栏螃蟹）
 *
 * 🔴🔴 这批问题的共同形态是「**看起来不一样，但说不清差在哪**」，
 *   所以判据全部落在**可量化的具体值**上：选择器、字号、内边距、SVG 几何。
 *   凡是"写了就以为生效了"的写法一律不用 —— 断言必须打在**产物**上
 *   （import 生产代码 / 读样式表声明），不是打在源码字符串上。
 *
 * 🔴 每条"应该有"都配一条"不应该有"的反向断言。只写金标时，
 *   "把金标和实现一起改"会让判据重新变绿（见 ARCH 纪律）。
 *
 * 老项目金标出处（逐字抄，非推理）：
 *   index.html:437-447 菜单项 / 二级页左起笔
 *   index.html:478/480 列表与主菜单限高
 *   index.html:494-497 收藏/历史空态
 *   index.html:509     .box（无 max-height / 无 overflow）
 *   index.html:511-518 .box h1 / p / input / button / ghost-btn
 *   index.html:465-476 .hist-item 一族
 *   index.html:701/706/712 三个二级页返回行文案 =「返回」
 *   index.html:1025-1026 ICON_MOON / ICON_SUN（stroke-width 1.7）
 *   index.html:10422-10434 #nsPet 一族
 *   index.html:11200 桌宠 SVG
 *   index.html:3002-3115 导出离屏卡（属性打在折叠把手上）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EXPORT_FOLD_CSS } from '../src/export/card.ts';
import { COPY } from '../src/ui/copy.ts';
import { ICON_MOON, ICON_SUN } from '../src/ui/icons.ts';
import { adoptPet, PET_SVG, readPet } from '../src/egg/pet.ts';

const CSS = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
/** 去注释后的 CSS：注释里写着"老项目没有 max-height"不该让判据红。 */
const CSS_BODY = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取一条规则（按选择器精确匹配），拿不到返回空串。 */
function rule(selector) {
  const re = new RegExp('(^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = CSS_BODY.match(re);
  return m ? m[2].trim() : '';
}

/**
 * 读源码时**必须先去注释**。
 *
 * 🔴🔴 这批判据第一版就栽在这里：注释里写着「绝不在这里写 `wrap.dataset.nsExport = '1'`」，
 *   于是 `doesNotMatch(/wrap\.dataset\.nsExport/)` 命中的是**那句警告**而不是真代码 ——
 *   判据红在假的地方，真代码删掉它反而不红。
 * 同款还有「历史行不许有 fav-go」：注释里正在解释"老项目 .fav-row 有 .fav-go"，
 *   一并被匹配上。
 * ⇒ 凡"断言某段代码不存在"的判据，输入必须是**去掉注释的代码**。
 */
function code(fileUrl) {
  return readFileSync(fileUrl, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/* ---------------- 1. 菜单栏间距（报障第 5 条）---------------- */

test('VP-01 菜单视图容器必须是块级、无 gap（老项目 :480 只有 max-height + overflow-y）', () => {
  // 🔴 老项目 `#menuMainView{max-height:min(72vh,560px);overflow-y:auto}` —— 没有 display、没有 gap。
  //   bj 此前 `display:flex;flex-direction:column;gap:8px`：
  //   ① 凭空多出 8px 间距；② flex 列 + max-height 会把行压扁（46 → 42）。
  const r = rule('#menuMainView, .menu-view');
  assert.match(r, /display:\s*block/, '菜单视图必须是块级');
  assert.doesNotMatch(r, /display:\s*flex/, '菜单视图不许是 flex（会把行压扁）');
  assert.doesNotMatch(r, /gap\s*:/, '菜单视图不许有 gap（老项目的间距全部来自行自身 margin-bottom）');
  // 反向：gap 不许出现在任何 .menu-view 组合里
  assert.doesNotMatch(CSS_BODY, /\.menu-view[^{]*\{[^}]*gap\s*:/, '.menu-view 不许带 gap');
  // 老项目那两个限高值必须原样在
  assert.match(rule('#menuMainView'), /max-height:\s*min\(72vh,\s*560px\)/);
  assert.match(rule('#menuMainView'), /overflow-y:\s*auto/);
});

test('VP-02 菜单项间距由行自身承担：margin-bottom 5px + 标签 15px（老项目 :437）', () => {
  const item = rule('.menu-item');
  assert.match(item, /margin-bottom:\s*5px/, '行间距 5px 是老项目原文');
  assert.match(item, /padding:\s*9px 12px/);
  assert.match(item, /gap:\s*12px/);
  // 🔴 标签字号必须是 15px：14px 时整行只有 42px（只够 min-height），
  //   15px 时内容把行撑到 46px —— 这是"菜单栏间距比老版本大"的另一半根因。
  const lab = rule('.menu-item .mi-l, #menuThemeLabel');
  assert.match(lab, /font-size:\s*15px/, '标签必须 15px（老项目 .menu-item 字号）');
});

/* ---------------- 2. 滚动条（报障第 7 条）---------------- */

test('VP-03 `.box` 不许带 max-height / overflow（老项目 :509 没有 ⇒ 老项目不可能有滚动条）', () => {
  const box = rule('.box');
  assert.match(box, /padding:\s*34px 30px 28px/, '.box 内边距应对齐老项目');
  assert.doesNotMatch(box, /max-height/, '.box 带 max-height ⇒ 每个弹窗都成了滚动容器');
  assert.doesNotMatch(box, /overflow/, '.box 带 overflow ⇒ 弹窗/菜单盒会多出滚动条');
  // 反向：需要限高滚动的地方必须**各自单独开**，不能靠 .box 兜着
  const scan = readFileSync(new URL('../src/scan/layer.ts', import.meta.url), 'utf8');
  assert.match(
    scan,
    /max-height:calc\(100vh - 48px\);overflow:auto/,
    '扫一扫层必须自己开限高滚动（老项目 :8599 用行内样式）',
  );
  const list = rule('.list-scroll');
  assert.match(list, /max-height:\s*min\(50vh,\s*400px\)/, '历史/收藏列表限高应对齐老项目 :478');
  assert.match(list, /-webkit-overflow-scrolling:\s*touch/, '老项目 :478 的 touch 惯性也要抄');
});

test('VP-04 `.box h1` / `.box p` 必须以元素选择器存在（老项目 :511-512）', () => {
  // 🔴🔴 老项目是 `.box h1` / `.box p`（元素选择器），bj 此前只有
  //   `.modal-head h1` / `.box .hint`（类名选择器）⇒ 改口令弹窗的 h1/p
  //   一路吃到浏览器默认（实测 32px/700 与 16px/fg，老项目是 18px/600 与 13px/muted）。
  const h1 = rule('.box h1');
  assert.match(h1, /font-size:\s*18px/, '缺这条 ⇒ 弹窗标题变 32px');
  assert.match(h1, /font-weight:\s*600/);
  assert.match(h1, /margin:\s*0 0 8px/);
  assert.match(h1, /letter-spacing:\s*\.02em/);
  const p = rule('.box p');
  assert.match(p, /font-size:\s*13px/, '缺这条 ⇒ 弹窗说明变 16px');
  assert.match(p, /color:\s*var\(--muted\)/, '缺这条 ⇒ 弹窗说明是近黑而不是 muted');
  assert.match(p, /margin:\s*0 0 20px/);
  assert.match(p, /line-height:\s*1\.7/);
  // 反向：`.box .hint` 优先级必须高于 `.box p`（口令页那段走自己的规则）
  const hint = rule('.box .hint');
  assert.ok(hint, '.box .hint 规则必须留着（口令页说明段）');
});

test('VP-05 `.box input` 必须是元素选择器（老项目 :513 不带属性限定）', () => {
  const inp = rule('.box input');
  assert.ok(inp, '.box input 规则缺失');
  assert.match(inp, /height:\s*46px/);
  assert.match(inp, /border-radius:\s*10px/);
  assert.match(inp, /font-size:\s*15px/);
  assert.match(inp, /color:\s*var\(--fg\)/, '缺 color ⇒ 夜间输入的字看不见');
  // 反向：限定成 [type=password] 会让将来新增的非密码输入框静默退回浏览器默认
  assert.doesNotMatch(CSS_BODY, /\.box input\[type=/, '.box input 不许收窄到某个 type');
});

test('VP-06 弹窗按钮底色由老项目 :1063 的 !important 决定（非禁用一律 --fg 底 / --bg 字）', () => {
  // 🔴🔴🔴 本条原先断言「次要按钮底色走 --hover」，**那个前提是错的**，
  //   上一批因此留了一条 `.box button:not(.box-x):not(:disabled){background:var(--hover)}`，
  //   把深底刷成浅灰淡底 —— 用户报障第 2 条「弹窗内下方按钮颜色不对」的真实根因。
  //
  //   真相：老项目**运行时注入**了一条 `!important` 主题覆盖
  //   （applyTheme 在 index.html:1269 无条件挂上，模板在 themeCssCore() :1045-1067），
  //   其中 :1063 是：
  //     .box button:not(:disabled):not(.box-x){
  //       background:${p.fg}!important;color:${p.bg}!important;-webkit-text-fill-color:${p.bg}!important}
  //   specificity (0,3,1) + !important ⇒ ghost-btn（0,2,1）的
  //   background/color/font-weight 全被吃回，**只有 margin-top 与 border 活下来**。
  //   日间实测：底 rgb(28,28,26)=--fg，字 rgb(251,251,248)=--bg。
  //
  //   ⇒ 判据改成钉这条：非禁用按钮**没有**单独的覆写规则，底色由
  //     `.box button:not(.box-x)` 的 --upload-bg（≡ --fg/--bg 二选一）决定。
  // 🔴🔴🔴 追加（2026-10-07 真浏览器取证）：VP-06 末尾原先还断言
  //   「`.box button.ghost-btn{` 一条都不许存在」——**那条是错的**。
  //   上一批据源码字面推断「整条 ghost-btn 都被吃回」，但 :1063 的覆盖层
  //   只声明 background/color/-webkit-text-fill-color，**不碰 margin-top 与 border**。
  //   Playwright 实读老项目 #cpCancel：marginTop=10px、border=1px solid、底 --fg、字 --bg、字重 400。
  //   ⇒ ghost-btn 规则**必须存在**，但只准含 margin-top/border，背景与字色一律照抄就会做过头。
  const ghost = rule('.box button.ghost-btn');
  assert.ok(ghost, '缺 .box button.ghost-btn 规则（用户报障第 5 条：两枚按钮贴死）');
  assert.match(ghost, /margin-top:\s*10px/, '老项目 #cpCancel 实测 marginTop=10px');
  assert.match(ghost, /border:\s*1px solid var\(--line\)/, '老项目 #cpCancel 实测 border=1px solid');
  assert.doesNotMatch(ghost, /background/, 'ghost-btn 的 background 被 :1063 !important 吃回，不许照字面写');

  // 反向钉死：不得存在任何"非禁用按钮另刷底色"的规则。
  // 这是本条判据的**金标**——把 --upload-bg 改成 --hover 就会红，避免再次回归。
  const override = CSS_BODY.match(/\.box button:not\(\.box-x\):not\(:disabled\)\s*\{/g) ?? [];
  assert.deepEqual(override, [], '非禁用按钮的老项目真实渲染由 :1063 的 !important 决定，不许再叠加一条覆写');

  // 金标：底色走 --upload-bg、字色走 --bg（与老项目 --fg 底 / --bg 字等价）
  const base = rule('.box button:not(.box-x)');
  assert.ok(base, '缺 .box button:not(.box-x) 基础规则');
  assert.match(base, /background:\s*var\(--upload-bg\)/, '弹窗按钮底色必须走 --upload-bg（老项目 :1063 的 --fg）');
  assert.match(base, /color:\s*var\(--bg\)/, '弹窗按钮字色必须走 --bg（老项目 :1063 的 --bg）');

  // 反向：--hover 是"浅灰淡底"（日间 rgba(28,28,26,.05)），绝不能出现在按钮底色上
  assert.doesNotMatch(base, /--hover/, '按钮底色不许走 --hover：那会把深底刷成浅灰淡底');

  const dis = rule('.box button:not(.box-x):disabled');
  assert.match(dis, /background:\s*var\(--line\)/, '老项目 :522 禁用底色走 --line');
  assert.match(dis, /color:\s*var\(--muted\)/);
  assert.match(dis, /opacity:\s*1/, '禁用态是"浅灰底+灰字"，不是整枚变淡');
  // 修改口令弹窗里两枚新口令框之间要有间距（老项目 :491）
  assert.match(rule('#cpNew, #cpNew2'), /margin-top:\s*12px/);
});

/* ---------------- 3. 配对弹窗 / 历史版本（报障第 4、8 条）---------------- */

test('VP-07 二级页返回行文案是「返回」而不是页名（老项目 :701/706/712）', () => {
  assert.equal(COPY.back, '返回');
  const menu = readFileSync(new URL('../src/ui/menu.ts', import.meta.url), 'utf8');
  // 三个二级页都用 backRow()；backRow 走 COPY.back
  assert.match(menu, /const backRow = \(\): string => head\(COPY\.back\);/);
  // 反向：backRow 不得再接受页名参数（那正是"把标题当返回文案"的写法）
  assert.doesNotMatch(menu, /backRow\s*=\s*\(\s*\w+\s*:/, 'backRow 不许接页名参数');
  // 空态构图（老项目 :494-497）
  const empty = rule('.empty');
  assert.match(empty, /flex-direction:\s*column/);
  assert.match(empty, /gap:\s*8px/);
  assert.match(empty, /font-size:\s*12\.5px/);
  assert.match(empty, /padding:\s*22px 0 16px/);
  assert.match(rule('.empty-ic, .empty-ic > svg'), /width:\s*22px/, '空态图标 22px');
  assert.match(rule('.empty-ic'), /opacity:\s*\.55/);
});

test('VP-08 历史行与收藏行不同族：无右箭头 + 9px/13px（老项目 :456 vs :465）', () => {
  const menu = code(new URL('../src/ui/menu.ts', import.meta.url));
  // 历史行片段里不许出现 fav-go 箭头（老项目 .hist-item 没有这一列）
  const histBlock = menu.slice(menu.indexOf('const renderHist'), menu.indexOf('const renderConflict'));
  assert.ok(histBlock.length > 0, '找不到 renderHist');
  assert.doesNotMatch(histBlock, /fav-go/, '历史行不许有右箭头（老项目 .hist-item 没有）');
  assert.doesNotMatch(histBlock, /ICON_CHEVRON/, '历史行不许有右箭头');
  assert.match(histBlock, /list-row hist-row/, '历史行必须挂 hist-row 才能拿到 9px/13px');
  const histRow = rule('.list-row.hist-row');
  assert.match(histRow, /padding:\s*9px 12px/, '老项目 .hist-item 是 9px 12px（收藏行是 10px）');
  assert.match(histRow, /font-size:\s*13px/, '老项目 .hist-item 是 13px（收藏行是 14px）');
  // 反向：收藏行仍应是 10px/14px
  const listRow = rule('.list-row');
  assert.match(listRow, /padding:\s*10px 12px/);
  assert.match(listRow, /font-size:\s*14px/);
});

/* ---------------- 4. 图标（报障第 9 条）---------------- */

test('VP-09 日间太阳 / 夜间月亮必须逐字等于老项目 ICON_SUN / ICON_MOON（:1025-1026）', () => {
  // 🔴 老项目菜单里的日夜间项用的是**顶栏档 1.7** 的常量（applyTheme → syncThemeMenuItem），
  //   不是菜单档 1.9。此前 bj 用 MENU(1.9)，整列比其它菜单行细一号。
  assert.match(ICON_SUN(), /stroke-width="1\.7"/, '太阳描边必须是 1.7（老项目 ICON_SUN）');
  assert.match(ICON_MOON(), /stroke-width="1\.7"/, '月亮描边必须是 1.7（老项目 ICON_MOON）');
  // 几何：小日面 r4.2 + 圈外八根短芒 + 金心 r1.4
  assert.match(ICON_SUN(), /<circle cx="12" cy="12" r="4\.2"\/>/);
  assert.match(ICON_SUN(), /<circle class="gf" cx="12" cy="12" r="1\.4"\/>/);
  for (const d of ['M12 2.6v2', 'M12 19.4v2', 'M2.6 12h2', 'M19.4 12h2', 'M5.3 5.3 6.8 6.8', 'M17.2 17.2 18.7 18.7', 'M18.7 5.3 17.2 6.8', 'M6.8 17.2 5.3 18.7']) {
    assert.ok(ICON_SUN().includes(`<path d="${d}"/>`), `太阳少一根芒：${d}`);
  }
  // 反向：大圆 r8.5 / 大金心 r3.4 是本项目原先那版"另一个画法"，必须不再出现
  assert.doesNotMatch(ICON_SUN(), /r="8\.5"/, '不许再用撑满整格的大圆（老项目日面只占三分之一）');
  assert.doesNotMatch(ICON_SUN(), /r="3\.4"/, '不许再用大金心（老项目是 r1.4）');
  // 月亮几何逐字
  assert.ok(ICON_MOON().includes('<path d="M20.6 14.3A8.7 8.7 0 0 1 9.7 3.4a8.7 8.7 0 1 0 10.9 10.9Z"/>'));
  assert.ok(ICON_MOON().includes('<path class="gf" d="M17.3 3.2l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6Z"/>'));
});

/* ---------------- 5. 导出图左上角多余箭头（报障第 3 条）---------------- */

test('VP-10 导出卡不许把 data-ns-export 打在 wrap 上（老项目 :3098-3099）', () => {
  // 🔴🔴 根因：bj 在 buildCard 里写了 `wrap.dataset.nsExport = '1'`，
  //   属性落在**整张离屏卡**上 ⇒ `[data-ns-export]::before` 的 ▼ 被画在卡片正文流最前面
  //   ＝导出图左上角凭空多一个箭头；同时 font-size:0 还作用到整张卡。
  //   老项目只在 `.ns-fold-mark` 那一枚行内小 span 上打属性。
  const card = code(new URL('../src/export/card.ts', import.meta.url));
  const fn = card.slice(card.indexOf('export function buildCard'));
  assert.doesNotMatch(fn, /wrap\.dataset\.nsExport/, 'buildCard 不许给离屏卡打 data-ns-export');
  assert.match(fn, /wrap\.className = 'ns-export'/, '老项目这一步是加 class（:3098）');
  // 反向：CSS 里也不许再有作用于整张卡的那条 [data-ns-export] 基规则
  assert.doesNotMatch(EXPORT_FOLD_CSS, /\[data-ns-export\]\{/, '不许有打在整张卡上的 [data-ns-export] 基规则');
  // 折叠把手上必须有 ▼（老项目 :3104）且要撤掉编辑器那枚边框三角
  // 🔴 选择器必须带 `.ns-fold[data-ns-export-fold][data-open]` 前缀（0,4,0），
  //   才压得住收起态基规则的 (0,3,0) —— 见 export.test.mjs EXPORT-05 的 specificity 计算。
  assert.match(
    EXPORT_FOLD_CSS,
    /\.ns-fold\[data-ns-export-fold\]\[data-open\] > :first-child::before/,
    '补丁选择器短了 ⇒ 压不过收起态的 display:none ⇒ 导出图丢折叠正文（报障第 11 条）',
  );
  assert.match(EXPORT_FOLD_CSS, /25BC/, '导出图折叠三角必须是 ▼ 字形');
  assert.match(EXPORT_FOLD_CSS, /border:0/, '必须把边框三角撤掉，否则出现两个三角');
  // 恒定展开 + 缩进引导线仍在
  assert.match(
    EXPORT_FOLD_CSS,
    /\.ns-fold\[data-ns-export-fold\]\[data-open\] > :not\(:first-child\)\{display:block\}/,
    '恒定展开规则的选择器同样必须带 .ns-fold 前缀',
  );
  assert.match(EXPORT_FOLD_CSS, /border-left:2px solid var\(--line\)/);
});

/* ---------------- 6. 修改口令弹窗（报障第 12 条）---------------- */

test('VP-11 修改口令弹窗文案逐字等于老项目 #cpMask（index.html:780-793）', () => {
  assert.equal(COPY.cpTitle, '修改口令');
  assert.equal(COPY.cpHintHtml, '修改后本机立即用新口令重新加密；<br>其他设备需用<b>新口令</b>重新打开此笔记。');
  assert.equal(COPY.cpOldPh, '当前口令');
  assert.equal(COPY.cpNewPh, '新口令');
  assert.equal(COPY.cpNew2Ph, '再次输入');
  assert.equal(COPY.cpNext, '下一步');
  assert.equal(COPY.cpDone, '确 定');
  assert.equal(COPY.cpCancel, '取消');
  assert.equal(COPY.cpVerifying, '验证中…');
  assert.equal(COPY.cpRotating, '重新加密中…');
  assert.equal(COPY.cpEmpty, '新口令不能为空');
  assert.equal(COPY.cpMismatch, '两次输入的新口令不一致');

  const pages = readFileSync(new URL('../src/ui/pages.ts', import.meta.url), 'utf8');
  // 结构逐项对齐：h1 + p + 三框 + err + 两个按钮
  assert.match(pages, /id="cpMask"/);
  assert.match(pages, /id="cpBox"/);
  assert.match(pages, /<h1>\$\{COPY\.cpTitle\}<\/h1>/);
  assert.match(pages, /id="cpOld" type="password"/);
  assert.match(pages, /id="cpNew" type="password"[^>]*class="hidden"/);
  assert.match(pages, /id="cpNew2" type="password"[^>]*class="hidden"/);
  assert.match(pages, /id="cpErr"/);
  assert.match(pages, /id="cpOk" disabled/);
  assert.match(pages, /id="cpCancel" class="ghost-btn"/);
  // 🔴 反向：两阶段形态不许塌回"一次问完"，也不许回退成 window.prompt
  assert.match(pages, /const toStage1 = \(\): void =>/, '必须保留"先验旧口令、再设新口令"两阶段');
  assert.ok(!/window\.prompt/.test(pages), '弹窗不许用 window.prompt（阻塞原生框，夜间一片白）');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('async function doChangePassphrase'));
  assert.ok(!/window\.prompt/.test(fn), '改口令流程不许用 window.prompt');
  assert.match(fn, /onVerifyOld/, '必须先验旧口令');
  assert.match(fn, /verifiedOld/, '阶段一验过的口令要留给阶段二用');
});

/* ---------------- 7. 桌宠：常驻顶栏那只螃蟹（报障第 6 条）---------------- */

/** 极简 localStorage 垫片：只给 EggStore 需要的两个方法。 */
function withStorage(fn) {
  const map = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, String(v)),
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
  };
  try {
    return fn();
  } finally {
    delete globalThis.window;
  }
}

test('VP-12 桌宠 SVG 逐字等于老项目 :11200，且默认不领养', () => {
  assert.equal(
    PET_SVG,
    '<svg viewBox="0 0 26 26" aria-hidden="true">' +
      '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
      '<path d="M4 18c0-5 3.6-8.6 8.6-8.6S21 13 21 18"/>' +
      '<path d="M4 18h17"/>' +
      '<path d="M8 18v2.6M13 18v2.6M18 18v2.6"/>' +
      '</g>' +
      '<circle cx="9.6" cy="13.4" r="1.2" fill="var(--accent)" stroke="none"/>' +
      '<circle cx="15.6" cy="13.4" r="1.2" fill="var(--accent)" stroke="none"/>' +
      '</svg>',
  );
  // 反向：emoji 🦀 / 🐾 字形是本项目出过的两次事故（用户报过"一个大脚丫"）
  assert.doesNotMatch(PET_SVG, /[\u{1F980}\u{1F43E}]/u, '不许用 emoji 代替描边螃蟹');

  withStorage(() => {
    assert.deepEqual(readPet(), { adopted: false, asleep: false, last: 0 }, '老项目：默认关（adopted 缺省 false）');
    adoptPet();
    assert.equal(readPet().adopted, true, '访问 /pet 即领养');
    adoptPet();
    assert.equal(readPet().adopted, true, '领养必须幂等');
  });
});

test('VP-13 顶栏螃蟹的样式与走位常量必须是老项目原值（:10422-10434 / :11209-11213）', () => {
  const pet = rule('#nsPet');
  assert.match(pet, /position:\s*absolute/);
  assert.match(pet, /bottom:\s*-11px/, '老项目骑在 header 下沿（bottom:-11px）');
  assert.match(pet, /width:\s*24px/);
  assert.match(pet, /height:\s*24px/);
  assert.match(pet, /border-radius:\s*7px/);
  assert.match(pet, /padding:\s*1px/);
  assert.match(pet, /z-index:\s*5/);
  assert.match(pet, /background:\s*var\(--bg\)/, '必须垫底色，否则正文从螃蟹背后透出');
  assert.match(rule('#nsPet svg'), /width:\s*22px/);
  assert.match(rule('#nsPet.asleep'), /opacity:\s*\.42/);
  // 走位：每 60ms 走 0.35px、起点 14、左边界 10、右边界留 34
  const petTs = code(new URL('../src/egg/pet.ts', import.meta.url));
  assert.match(petTs, /const WALK_STEP = 0\.35;/);
  assert.match(petTs, /const WALK_EVERY_MS = 60;/);
  assert.match(petTs, /const X_MIN = 10;/);
  assert.match(petTs, /const X_START = 14;/);
  assert.match(petTs, /const X_RIGHT_GAP = 34;/);
  assert.match(petTs, /el\.id = 'nsPet';/, 'id 必须是老项目的 #nsPet');
  // 反向：横向爬行必须真写 translateX（"会动"这件事本身要钉住）
  assert.match(petTs, /el\.style\.transform = `translateX\(\$\{x\}px\)`/);
  // 接线：挂载点必须在 buildShell 之后、锁定时要拆
  const main = code(new URL('../src/main.ts', import.meta.url));
  assert.match(main, /shellRef = shell;[\s\S]{0,200}mountPet\(\);/, '桌宠必须在 buildShell 之后挂');
  assert.match(main, /unmountPet\(\);[\s\S]{0,120}lockNote\(/, '锁定时必须拆桌宠定时器');
  const layer = code(new URL('../src/egg/layer.ts', import.meta.url));
  assert.match(layer, /if \(key === 'pet'\) \{\s*adoptPet\(\);\s*mountPet\(/, '访问 /pet 必须领养并挂上');
});

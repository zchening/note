/**
 * 视觉回归闸（第三批）：视图层 20–28 条。
 *
 * 这 9 条的共性与前两批完全一致：**单看任一处都不算错，并排对比才刺眼**，
 * 所以 typecheck 与纯逻辑单测对它们**完全无感** —— 本文件量的是**真实计算样式**。
 *
 * 逐条对应用户验收清单：
 *   20 菜单主视图项：justify-content:center + 图标 26px（上一批误改成 20px）
 *   21 二级视图标题行：必须是标准 .menu-item 结构（返回 26px + .mi-l 112px 左对齐）
 *   22 .list-kicker：等宽 10.5px + uppercase + .14em 字距 + 金色引导圆点
 *   23 收藏/历史列表行：图标列 + 等宽名 + 右箭头列 + 容器独立滚动限高
 *   24 顶栏 560px 媒体查询整段
 *   25 关于页：衬线标题 18px + 52px 金线 + 行 flex 居中 + 作者行金色衬线
 *   26 升级弹窗：版本号 22px 金色衬线 / 正文 13.5px·1.95·500 / 进度条 6px / 消息行等宽
 *   27 首页提示页 .home：h1 24px/500/.04em、p 14px/1.9、code 13px、padding 20px
 *   28 图片查看器 #nsZoom + 长按菜单 #nsImgMenu 整块 + 徽章改顶栏内联
 *
 * 六条判据陷阱（都是前两批真踩到的，本批继续规避）：
 *   1. **比颜色必须与当前主题令牌比，不能写死 rgb**。harness 落在夜间主题，
 *      写死日间值会恒红。归一化时 getPropertyValue 给**原始字面量**（"#8F7126"），
 *      getComputedStyle 给**计算值**（"rgb(143, 113, 38)"）—— 不归一化等于跟判据自己较劲。
 *   2. **小数 px 量不到就去看样式表声明文本**（declOf）。dpr=1 下 Chromium
 *      把 border-width 量化到整数设备像素。
 *   3. **getComputedStyle 返回活的声明对象**，节点remove 之后再读得空串 → 先取快照。
 *   4. **background 简写会让 backgroundColor 返回空串** → 要读 longhand。
 *   5. **position:fixed 只写 bottom 时 top 返回 used value**，不是 auto。
 *   6. **@keyframes 的 keyText 归一化后是 '0%'/'100%'**，不是 from/to。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, openEditorAt, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 路径纪律：必须 4 级（e2e → test → client → packages → 仓库根）。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

/** 剥掉 px。'17px' → 17 */
const px = (v) => parseFloat(String(v));

/** 颜色归一化：把 hex / rgb() / rgba() 三种写法统一成 `rgb(r, g, b)` 或 `rgba(r, g, b, a)`。 */
const toRgb = (c) => {
  const s = String(c).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const parts = fn[1].split(',').map((p) => p.trim());
    const rgb = parts.slice(0, 3).map((p) => parseFloat(p)).join(', ');
    if (parts.length >= 4) {
      const a = parseFloat(parts[3]);
      const alpha = a === 0 ? '0' : a === 1 ? '1' : String(a);
      return `rgba(${rgb}, ${alpha})`;
    }
    return `rgb(${rgb})`;
  }
  return s;
};

/**
 * 🔴🔴 字体栈比较必须**归一化空白与引号** —— 这是本批真踩到的判据陷阱：
 *   `--mono` 的令牌字面量是 `ui-monospace,SFMono-Regular,"SF Mono",Consolas,Menlo,monospace`
 *   （逗号后**没有**空格），而 getComputedStyle 返回的**计算值**是
 *   `ui-monospace, SFMono-Regular, "SF Mono", Consolas, Menlo, monospace`（逗号后**有**空格）。
 *   两者是同一个字体栈，但 `includes()` 直接比**恒假**。
 *   判据自己写错的时候，报红的是"看起来正确的实现" —— 差一点就去改 CSS。
 *   （第一版就是直接 `fontFamily.includes(monoToken)`，6 条用例全红。）
 */
const fontKey = (f) =>
  String(f)
    .replace(/["']/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();

/** 字体栈比较：两个栈归一化后必须**逐段相等**（顺序也是契约的一部分）。 */
const fontEq = (computed, token) => fontKey(computed) === fontKey(token);

/**
 * 从**样式表声明文本**里取某个选择器的某条声明值。
 * 用于 getComputedStyle 量不到的小数 px（dpr=1 下 border-width 被量化到整数）。
 * 🔴 page.evaluate 是**序列化**执行的：外部函数不会被带进浏览器上下文，
 *   所以每个用例里都要自己内联一份 toRgb / declOf。这不是重复，是机制约束。
 */

/** 开菜单。 */
const openMenu = (page) => withTimeout(page.click('#menuBtn'), 5_000, '点菜单键');

/** 打开关于页（走真实路径：底栏菜单 → 关于 NoteSync）。 */
async function openAbout(page) {
  await openMenu(page);
  await page.waitForSelector('#menuAbout', { timeout: 10_000 });
  await page.click('#menuAbout');
  await page.waitForSelector('#aboutMask .about-title', { state: 'visible', timeout: 10_000 });
}

/* ========================================================================
 * 20/ 21 / 22 —— 菜单主视图项、二级视图标题行、计数行
 * ======================================================================== */

test('VVW-01 🔴🔴 菜单主视图项必须居中且图标 26px（漏 center 贴左 / 图标 20px 整列变小气）', async () => {
  // 老项目 index.html:437 `justify-content:center` / :443 `.menu-item svg{width:26px;height:26px;flex:none}`
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw01', 'pw');
  try {
    await openMenu(page);
    await page.waitForSelector('.menu-box .menu-item', { timeout: 10_000 });
    const m = await page.evaluate(() => {
      const item = document.querySelector('.menu-box .menu-item');
      if (!item) return null;
      const cs = getComputedStyle(item);
      const ic = item.querySelector('.ic');
      const svg = ic ? ic.querySelector('svg') : null;
      // 快照必须在节点被改动前取
      return {
        justify: cs.justifyContent,
        display: cs.display,
        icW: ic ? parseFloat(getComputedStyle(ic).width) : -1,
        icH: ic ? parseFloat(getComputedStyle(ic).height) : -1,
        svgW: svg ? parseFloat(getComputedStyle(svg).width) : -1,
        svgH: svg ? parseFloat(getComputedStyle(svg).height) : -1,
        n: document.querySelectorAll('.menu-box .menu-item').length,
      };
    });
    assert.ok(m, '菜单里应有 .menu-item');
    assert.equal(m.display, 'flex', `菜单项应是 flex 容器，实际 ${m.display}`);
    assert.equal(
      m.justify,
      'center',
      `主菜单项应 justify-content:center（老项目 :437），实际 ${m.justify} —— flex 默认 flex-start 会让整组贴左`,
    );
    assert.ok(m.n >= 9, `主菜单应有 9+ 行，实际 ${m.n}`);
    // 图标 26px：包裹 span 与内部 svg 都必须是 26（只给 span 定尺寸的话 svg 会撑成 300×150）
    assert.equal(m.icW, 26, `菜单图标列应 26px，实际 ${m.icW}px`);
    assert.equal(m.icH, 26, `菜单图标列高应 26px，实际 ${m.icH}px`);
    assert.equal(m.svgW, 26, `菜单图标本体应 26px，实际 ${m.svgW}px —— 20px 会让 11 行同屏的整列图标变小一号`);
    assert.equal(m.svgH, 26, `菜单图标本体高应 26px，实际 ${m.svgH}px`);
  } finally {
    await page.close();
  }
});

test('VVW-02 🔴🔴 二级视图标题行必须是标准菜单行（.menu-item + 26px 返回图标 + 112px 左对齐标签）', async () => {
  // 老项目 index.html:701 `<div id="menuFavBack" class="menu-item">…</div>` + :447 左起笔
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw02', 'pw');
  try {
    await openMenu(page);
    await page.click('#menuFavEntry');
    await page.waitForSelector('#menuBack', { timeout: 10_000 });
    const m = await page.evaluate(() => {
      const back = document.querySelector('#menuBack');
      if (!back) return null;
      const cs = getComputedStyle(back);
      const ic = back.querySelector('.ic');
      const svg = ic ? ic.querySelector('svg') : null;
      const lbl = back.querySelector('.mi-l');
      const lcs = lbl ? getComputedStyle(lbl) : null;
      return {
        cls: back.className,
        isMenuItem: back.classList.contains('menu-item'),
        hasIconCol: !!ic,
        hasLabel: !!lbl,
        justify: cs.justifyContent,
        minH: parseFloat(cs.minHeight),
        icW: ic ? parseFloat(getComputedStyle(ic).width) : -1,
        svgW: svg ? parseFloat(getComputedStyle(svg).width) : -1,
        labelW: lcs ? parseFloat(lcs.width) : -1,
        labelAlign: lcs ? lcs.textAlign : '',
        labelText: lbl ? lbl.textContent.trim() : '',
        // 二级视图容器（.menu-sub）必须让行左起笔
        subLeft: (() => {
          const sub = document.querySelector('.menu-sub');
          return sub ? getComputedStyle(sub.querySelector('.menu-item')).justifyContent : '';
        })(),
      };
    });
    assert.ok(m, '二级视图应有 #menuBack');
    assert.equal(
      m.isMenuItem,
      true,
      `二级视图标题行必须**就是** .menu-item（老项目 :701），实际 class="${m.cls}" —— 另画一行会让同一个"菜单项"在两层视图里长成两种样子`,
    );
    assert.equal(m.hasIconCol, true, '返回行应有图标列（老项目是一枚 26px 返回箭头）');
    assert.equal(m.hasLabel, true, '返回行应有 .mi-l 标签列');
    // 🔴 只断言"标签列有文案"，**不钉死具体字**。老项目这一行写「返回」
    //   （index.html:701），本项目沿用所属视图名（「收藏夹」）。
    //   那是 copy.ts 的文案口径问题，不属本批视觉范围 —— 判据越界会把文案改成红的。
    assert.ok(
      m.labelText.length > 0,
      `返回行标签列应有文案，实际为「${m.labelText}」`,
    );
    assert.equal(m.svgW, 26, `返回图标应 26px（与主菜单同规格），实际 ${m.svgW}px`);
    assert.equal(m.labelW, 112, `标签列应定宽 112px（老项目 .mi-l），实际 ${m.labelW}px`);
    assert.equal(m.labelAlign, 'left', `标签列应左对齐，实际 ${m.labelAlign}`);
    assert.equal(
      m.subLeft,
      'flex-start',
      `二级视图内的行应左起笔（老项目 :447），实际 ${m.subLeft} —— 主菜单那套居中逻辑漏到二级页会让图标列悬空`,
    );
    assert.ok(m.minH >= 42, `菜单行高应 ≥42px，实际 ${m.minH}px`);
  } finally {
    await page.close();
  }
});

test('VVW-03 🔴 .list-kicker 必须是等宽 10.5px + uppercase + 金色引导圆点', async () => {
  // 老项目 index.html:462-463
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw03', 'pw');
  try {
    // 先造一条收藏，计数行只在有收藏时出现（老项目同款口径）
    await openMenu(page);
    await page.click('#menuFav');
    await page.click('#menuFavEntry');
    await page.waitForSelector('.list-kicker', { timeout: 10_000 });
    const m = await page.evaluate(() => {
      const k = document.querySelector('.list-kicker');
      if (!k) return null;
      const cs = getComputedStyle(k);
      const dot = getComputedStyle(k, '::before');
      const root = getComputedStyle(document.documentElement);
      const toRgb = (c) => {
        const s = String(c).trim();
        const hex = /^#([0-9a-f]{6})$/i.exec(s);
        if (hex) {
          const n = parseInt(hex[1], 16);
          return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
        }
        return s;
      };
      return {
        fontFamily: cs.fontFamily,
        mono: toRgb(root.getPropertyValue('--mono')),
        fontSize: parseFloat(cs.fontSize),
        transform: cs.textTransform,
        letterSpacing: cs.letterSpacing,
        color: toRgb(cs.color),
        muted: toRgb(root.getPropertyValue('--muted')),
        padT: parseFloat(cs.paddingTop),
        padL: parseFloat(cs.paddingLeft),
        padB: parseFloat(cs.paddingBottom),
        dotW: parseFloat(dot.width),
        dotH: parseFloat(dot.height),
        dotRadius: parseFloat(dot.borderTopLeftRadius),
        dotBg: toRgb(dot.backgroundColor),
        dotBgRaw: dot.backgroundColor,
        accent: toRgb(root.getPropertyValue('--accent')),
      };
    });
    assert.ok(m, '收藏夹二级页应有 .list-kicker 计数行');
    assert.ok(
      fontEq(m.fontFamily, m.mono),
      `计数行应吃等宽字体 --mono（${m.mono}），实际 ${m.fontFamily} —— 比例体读起来像说明文字，与下方列表没有层级`,
    );
    assert.equal(m.fontSize, 10.5, `计数行字号应 10.5px，实际 ${m.fontSize}px`);
    assert.equal(m.transform, 'uppercase', `计数行应 uppercase，实际 ${m.transform}`);
    // 字距：.14em × 10.5px = 1.47px
    // 🔴 letterSpacing 是**带单位字符串**，不 parseFloat 就是 "1.47px" - 1.47 = NaN。
    assert.ok(
      Math.abs(px(m.letterSpacing) - 10.5 * 0.14) < 0.05,
      `计数行字距应 .14em（≈1.47px），实际 ${m.letterSpacing}`,
    );
    assert.equal(m.color, m.muted, `计数行应吃 --muted（${m.muted}），实际 ${m.color}`);
    assert.equal(m.padT, 6, `计数行上内边距应 6px，实际 ${m.padT}px`);
    assert.equal(m.padL, 4, `计数行左内边距应 4px，实际 ${m.padL}px`);
    assert.equal(m.padB, 10, `计数行下内边距应 10px，实际 ${m.padB}px`);
    // 金色引导圆点：直径 5px + 圆形 + 吃 --accent
    assert.equal(m.dotW, 5, `引导圆点应5×5px，实际 ${m.dotW}×${m.dotH}px`);
    assert.equal(m.dotH, 5, `引导圆点高应 5px，实际 ${m.dotH}px`);
    assert.ok(
      m.dotRadius >= 2.5,
      `引导圆点应是圆形（radius 2.5px），实际 ${m.dotRadius}px`,
    );
    // 🔴 陷阱4：background 简写会让 backgroundColor 在某些引擎返回空串。
    //   这里若取到空串就退回读 background 简写，两个都空才判失败。
    assert.ok(
      m.dotBgRaw !== '' || m.dotBg !== '',
      '引导圆点应有背景色（老项目是金色 var(--accent)）',
    );
    assert.equal(
      m.dotBg,
      m.accent,
      `引导圆点应是金色 --accent（${m.accent}），实际 "${m.dotBgRaw}"`,
    );
  } finally {
    await page.close();
  }
});

/* ========================================================================
 * 23 —— 收藏/历史列表行
 * ======================================================================== */

test('VVW-04 🔴🔴 列表行必须有图标列 + 等宽名 + 右箭头列，且容器独立滚动限高', async () => {
  // 老项目 index.html:456-461（.fav-row/.fav-star 18px/.fav-name mono 13.5px/.fav-go 14px）
  //                :465-473（.hist-item/.hist-clock 16px/.hist-meta mono 12.5px/按钮 32px）
  //                :478（容器 max-height:min(50vh,400px)）
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw04', 'pw');
  try {
    await openMenu(page);
    await page.click('#menuFav');
    await page.click('#menuFavEntry');
    await page.waitForSelector('.list-row[data-name]', { timeout: 10_000 });
    const m = await page.evaluate(() => {
      const toRgb = (c) => {
        const s = String(c).trim();
        const hex = /^#([0-9a-f]{6})$/i.exec(s);
        if (hex) {
          const n = parseInt(hex[1], 16);
          return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
        }
        return s;
      };
      const row = document.querySelector('.list-row[data-name]');
      if (!row) return null;
      const root = getComputedStyle(document.documentElement);
      const star = row.querySelector('.fav-star');
      const name = row.querySelector('.fav-name');
      const go = row.querySelector('.fav-go');
      const starSvg = star ? star.querySelector('svg') : null;
      const goSvg = go ? go.querySelector('svg') : null;
      const ncs = name ? getComputedStyle(name) : null;
      const scs = getComputedStyle(document.querySelector('.list-scroll') || row);
      return {
        hasStar: !!star,
        hasName: !!name,
        hasGo: !!go,
        starW: star ? parseFloat(getComputedStyle(star).width) : -1,
        starSvgW: starSvg ? parseFloat(getComputedStyle(starSvg).width) : -1,
        starColor: star ? toRgb(getComputedStyle(star).color) : '',
        accent: toRgb(root.getPropertyValue('--accent')),
        nameFamily: ncs ? ncs.fontFamily : '',
        mono: toRgb(root.getPropertyValue('--mono')),
        nameSize: ncs ? parseFloat(ncs.fontSize) : -1,
        goW: go ? parseFloat(getComputedStyle(go).width) : -1,
        goSvgW: goSvg ? parseFloat(getComputedStyle(goSvg).width) : -1,
        goColor: go ? toRgb(getComputedStyle(go).color) : '',
        muted: toRgb(root.getPropertyValue('--muted')),
        scrollMaxH: scs.maxHeight,
        scrollOverflowY: scs.overflowY,
      };
    });
    assert.ok(m, '收藏夹应有一行 .list-row[data-name]');
    assert.equal(m.hasStar, true, '收藏行应有图标列 .fav-star（老项目 18px 金星）');
    assert.equal(m.hasName, true, '收藏行应有名字列 .fav-name');
    assert.equal(m.hasGo, true, '收藏行应有右箭头列 .fav-go（"这一行可以进去"的唯一暗示）');
    assert.equal(m.starW, 18, `金星列应 18px，实际 ${m.starW}px`);
    assert.equal(m.starSvgW, 18, `金星图标本体应 18px，实际 ${m.starSvgW}px`);
    assert.equal(m.starColor, m.accent, `金星应是金色 --accent（${m.accent}），实际 ${m.starColor}`);
    assert.ok(
      fontEq(m.nameFamily, m.mono),
      `名字列应走等宽体 --mono（${m.mono}），实际 ${m.nameFamily} —— 比例体读起来只是普通正文`,
    );
    assert.equal(m.nameSize, 13.5, `名字列字号应 13.5px，实际 ${m.nameSize}px`);
    assert.equal(m.goW, 14, `右箭头列应 14px，实际 ${m.goW}px`);
    assert.equal(m.goSvgW, 14, `右箭头图标本体应 14px，实际 ${m.goSvgW}px`);
    assert.equal(m.goColor, m.muted, `右箭头应是 muted（${m.muted}），实际 ${m.goColor}`);
    // 容器限高：min(50vh,400px)。headless 默认视口 1280×720 → 50vh = 360px
    assert.ok(
      m.scrollMaxH !== 'none',
      `列表容器应有独立限高（老项目 min(50vh,400px)），实际 ${m.scrollMaxH} —— 无限高时条目一多就把菜单盒撑出屏幕`,
    );
    assert.ok(
      Math.abs(px(m.scrollMaxH) - Math.min(360, 400)) < 1,
      `列表容器限高应= min(50vh,400px) ≈ 360px（视口 720），实际 ${m.scrollMaxH}`,
    );
    assert.equal(
      m.scrollOverflowY,
      'auto',
      `列表容器应 overflow-y:auto，实际 ${m.scrollOverflowY}`,
    );
  } finally {
    await page.close();
  }
});

test('VVW-05 🔴🔴 历史行要有时钟列 + 等宽 meta，且「新增历史版本」是独立菜单行', async () => {
  // 老项目 index.html:465-473 + :709（menuHistSave 与返回行同构，都是 .menu-item）
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw05', 'pw');
  try {
    await openMenu(page);
    await page.click('#menuHistEntry');
    await page.waitForSelector('#histSave', { timeout: 10_000 });
    await page.click('#histSave');
    await page.waitForSelector('.list-row[data-at]', { timeout: 10_000 });
    const m = await page.evaluate(() => {
      const toRgb = (c) => {
        const s = String(c).trim();
        const hex = /^#([0-9a-f]{6})$/i.exec(s);
        if (hex) {
          const n = parseInt(hex[1], 16);
          return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
        }
        return s;
      };
      const row = document.querySelector('.list-row[data-at]');
      if (!row) return null;
      const root = getComputedStyle(document.documentElement);
      const clock = row.querySelector('.hist-clock');
      const meta = row.querySelector('.hist-meta');
      const go = row.querySelector('.fav-go');
      const clockSvg = clock ? clock.querySelector('svg') : null;
      const mcs = meta ? getComputedStyle(meta) : null;
      const save = document.querySelector('#histSave');
      const saveIc = save ? save.querySelector('.ic') : null;
      return {
        hasClock: !!clock,
        hasMeta: !!meta,
        hasGo: !!go,
        clockW: clock ? parseFloat(getComputedStyle(clock).width) : -1,
        clockSvgW: clockSvg ? parseFloat(getComputedStyle(clockSvg).width) : -1,
        metaFamily: mcs ? mcs.fontFamily : '',
        mono: toRgb(root.getPropertyValue('--mono')),
        metaSize: mcs ? parseFloat(mcs.fontSize) : -1,
        metaColor: mcs ? toRgb(mcs.color) : '',
        muted: toRgb(root.getPropertyValue('--muted')),
        saveIsMenuItem: save ? save.classList.contains('menu-item') : false,
        saveHasIcon: !!saveIc,
        saveIcW: saveIc ? parseFloat(getComputedStyle(saveIc).width) : -1,
        saveLabel: save ? (save.querySelector('.mi-l')?.textContent ?? '').trim() : '',
      };
    });
    assert.ok(m, '历史页应有一行 .list-row[data-at]');
    assert.equal(m.hasClock, true, '历史行应有图标列 .hist-clock（老项目 16px 时钟）');
    assert.equal(m.hasMeta, true, '历史行应有等宽 meta 列');
    assert.equal(m.hasGo, true, '历史行也应有右箭头列（老项目 .fav-go 同款）');
    assert.equal(m.clockW, 16, `时钟列应 16px，实际 ${m.clockW}px`);
    assert.equal(m.clockSvgW, 16, `时钟图标本体应 16px，实际 ${m.clockSvgW}px`);
    assert.ok(
      fontEq(m.metaFamily, m.mono),
      `meta 列应走等宽体 --mono（${m.mono}），实际 ${m.metaFamily}`,
    );
    assert.equal(m.metaSize, 12.5, `meta 列字号应 12.5px（老项目 :469），实际 ${m.metaSize}px`);
    assert.equal(m.metaColor, m.muted, `meta 列应是 muted（${m.muted}），实际 ${m.metaColor}`);
    assert.equal(
      m.saveIsMenuItem,
      true,
      '「新增历史版本」应是独立的 .menu-item 行（老项目 :709），不该塞进标题行当小按钮',
    );
    assert.equal(m.saveHasIcon, true, '「新增历史版本」应带图标（老项目一枚加号）');
    assert.equal(m.saveIcW, 26, `加号图标应 26px，实际 ${m.saveIcW}px`);
    assert.equal(m.saveLabel, '新增历史版本', `文案应为「新增历史版本」，实际「${m.saveLabel}」`);
  } finally {
    await page.close();
  }
});

/* ========================================================================
 * 24 —— 顶栏 560px 媒体查询
 * ======================================================================== */

test('VVW-06 🔴🔴🔴 顶栏窄屏（≤560px）规则整段：gap 6 / padding 12 / 字标隐藏 / 键 27px', async () => {
  // 老项目 index.html:293 `@media (max-width:560px){ header{gap:6px;padding:12px 12px}
  //   header .brand b{display:none} header button{width:27px;height:27px}
  //   header button svg{width:16px;height:16px} }`
  // 🔴 这段整段缺失时症状不是"少个样式"，而是**窄屏顶栏整个撑爆**：
  //   7 个 31px 键 + 10px 间距已超 375px，品牌字标再被挤一下就把工具键顶出屏幕。
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw06', 'pw');
  try {
    await page.setViewportSize({ width: 560, height: 720 });
    // 视口变了要给媒体查询一帧生效时间
    await page.waitForFunction(() => window.innerWidth === 560, { timeout: 5_000 });
    const m = await page.evaluate(() => {
      const top = document.querySelector('.ns-top');
      if (!top) return null;
      const cs = getComputedStyle(top);
      const word = document.querySelector('.ns-brand b');
      const btn = document.querySelector('.ns-top button.ns-ic');
      const svg = btn ? btn.querySelector('svg') : null;
      return {
        gap: parseFloat(cs.gap),
        padT: parseFloat(cs.paddingTop),
        padL: parseFloat(cs.paddingLeft),
        padR: parseFloat(cs.paddingRight),
        wordDisplay: word ? getComputedStyle(word).display : 'NONE',
        btnW: btn ? parseFloat(getComputedStyle(btn).width) : -1,
        btnH: btn ? parseFloat(getComputedStyle(btn).height) : -1,
        svgW: svg ? parseFloat(getComputedStyle(svg).width) : -1,
        svgH: svg ? parseFloat(getComputedStyle(svg).height) : -1,
        innerW: window.innerWidth,
      };
    });
    assert.ok(m, '应有 .ns-top');
    assert.equal(m.innerW, 560, `视口应为 560px，实际 ${m.innerW}px`);
    assert.equal(m.gap, 6, `窄屏顶栏 gap 应 6px，实际 ${m.gap}px —— 10px 会把右侧工具键顶出屏幕`);
    assert.equal(m.padT, 12, `窄屏顶栏上内边距应 12px，实际 ${m.padT}px`);
    assert.equal(m.padL, 12, `窄屏顶栏左内边距应 12px，实际 ${m.padL}px`);
    assert.equal(m.padR, 12, `窄屏顶栏右内边距应 12px，实际 ${m.padR}px`);
    assert.equal(m.wordDisplay, 'none', `窄屏品牌字标 b 应隐藏，实际 ${m.wordDisplay}`);
    assert.equal(m.btnW, 27, `窄屏顶栏键应27×27px，实际 ${m.btnW}×${m.btnH}px`);
    assert.equal(m.btnH, 27, `窄屏顶栏键高应 27px，实际 ${m.btnH}px`);
    assert.equal(m.svgW, 16, `窄屏顶栏图标应 16px，实际 ${m.svgW}px`);
    assert.equal(m.svgH, 16, `窄屏顶栏图标高应 16px，实际 ${m.svgH}px`);
  } finally {
    await page.close();
  }
});

/* ========================================================================
 * 25 —— 关于页
 * ======================================================================== */

test('VVW-07 🔴🔴 关于页标题必须是 18px 衬线 600 + 字距 1px + 下方 52px 金线', async () => {
  // 老项目 index.html:253-254
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw07', 'pw');
  try {
    await openAbout(page);
    const m = await page.evaluate(() => {
      const toRgb = (c) => {
        const s = String(c).trim();
        const hex = /^#([0-9a-f]{6})$/i.exec(s);
        if (hex) {
          const n = parseInt(hex[1], 16);
          return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
        }
        const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
        if (fn) {
          const parts = fn[1].split(',').map((p) => p.trim());
          const rgb = parts.slice(0, 3).map((p) => parseFloat(p)).join(', ');
          if (parts.length >= 4) {
            const a = parseFloat(parts[3]);
            return `rgba(${rgb}, ${a === 0 ? '0' : a === 1 ? '1' : String(a)})`;
          }
          return `rgb(${rgb})`;
        }
        return s;
      };
      const t = document.querySelector('#aboutMask .about-title');
      if (!t) return null;
      const cs = getComputedStyle(t);
      const after = getComputedStyle(t, '::after');
      const root = getComputedStyle(document.documentElement);
      return {
        fontFamily: cs.fontFamily,
        serif: toRgb(root.getPropertyValue('--serif')),
        fontSize: parseFloat(cs.fontSize),
        fontWeight: parseInt(cs.fontWeight, 10),
        letterSpacing: cs.letterSpacing,
        align: cs.textAlign,
        lineW: parseFloat(after.width),
        lineH: parseFloat(after.height),
        lineDisplay: after.display,
        lineBg: after.backgroundColor,
        lineOpacity: parseFloat(after.opacity),
        lineBgDecl: after.background,
        accent: toRgb(root.getPropertyValue('--accent')),
      };
    });
    assert.ok(m, '关于页应有 .about-title');
    assert.ok(
      fontEq(m.fontFamily, m.serif),
      `关于页标题应吃衬线体 --serif（${m.serif}），实际 ${m.fontFamily} —— 「扉页式小号衬线标题」是老项目 v7.0 收敛出来的版式`,
    );
    assert.equal(m.fontSize, 18, `关于页标题应 18px，实际 ${m.fontSize}px`);
    assert.equal(m.fontWeight, 600, `关于页标题字重应 600，实际 ${m.fontWeight}`);
    assert.equal(m.letterSpacing, '1px', `关于页标题字距应 1px，实际 ${m.letterSpacing}`);
    assert.equal(m.align, 'center', `关于页标题应居中，实际 ${m.align}`);
    // 金线：52×1 的 display:block
    assert.equal(m.lineW, 52, `标题下方金线应52px 宽，实际 ${m.lineW}px`);
    assert.equal(m.lineH, 1, `金线应 1px 高，实际 ${m.lineH}px`);
    assert.equal(m.lineDisplay, 'block', `金线应是 display:block，实际 ${m.lineDisplay}`);
    assert.equal(
      parseFloat(m.lineOpacity),
      0.8,
      `金线透明度应 .8（老项目压了一档，不是纯金），实际 ${m.lineOpacity}`,
    );
    // 🔴 陷阱4：background 简写可能让 backgroundColor 返回空串 → 退回读 background 简写
    const lineColor = m.lineBg !== '' ? m.lineBg : m.lineBgDecl;
    const toRgb2 = (c) => {
      const s = String(c).trim();
      const hex = /^#([0-9a-f]{6})$/i.exec(s);
      if (hex) {
        const n = parseInt(hex[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      }
      return s;
    };
    assert.ok(lineColor && lineColor !== 'rgba(0, 0, 0, 0)', '金线应有可见的底色');
    assert.equal(
      toRgb2(lineColor),
      m.accent,
      `金线应是金色 --accent（${m.accent}），实际 "${lineColor}"`,
    );
  } finally {
    await page.close();
  }
});

test('VVW-08 🔴🔴 关于页行必须 flex 居中 + 键 11.5px muted + 值 110px 定宽左对齐 tabular-nums', async () => {
  // 老项目 index.html:256-258
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw08', 'pw');
  try {
    await openAbout(page);
    const m = await page.evaluate(() => {
      const toRgb = (c) => {
        const s = String(c).trim();
        const hex = /^#([0-9a-f]{6})$/i.exec(s);
        if (hex) {
          const n = parseInt(hex[1], 16);
          return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
        }
        return s;
      };
      const row = document.querySelector('#aboutMask .about-row');
      if (!row) return null;
      const cs = getComputedStyle(row);
      const k = row.querySelector('.about-k');
      const v = row.querySelector('.about-v');
      const kcs = k ? getComputedStyle(k) : null;
      const vcs = v ? getComputedStyle(v) : null;
      const root = getComputedStyle(document.documentElement);
      // 作者行
      const arow = document.querySelector('#aboutMask .about-author');
      const aname = arow ? arow.querySelector('.about-v') : null;
      const acs = aname ? getComputedStyle(aname) : null;
      return {
        display: cs.display,
        justify: cs.justifyContent,
        alignItems: cs.alignItems,
        gap: parseFloat(cs.gap),
        lineHeight: cs.lineHeight,
        fontSize: parseFloat(cs.fontSize),
        kSize: kcs ? parseFloat(kcs.fontSize) : -1,
        kLetter: kcs ? kcs.letterSpacing : '',
        kColor: kcs ? toRgb(kcs.color) : '',
        muted: toRgb(root.getPropertyValue('--muted')),
        vW: vcs ? parseFloat(vcs.width) : -1,
        vAlign: vcs ? vcs.textAlign : '',
        vWeight: vcs ? parseInt(vcs.fontWeight, 10) : -1,
        vNum: vcs ? vcs.fontVariantNumeric : '',
        vBreak: vcs ? vcs.wordBreak : '',
        authorExists: !!arow,
        authorColor: acs ? toRgb(acs.color) : '',
        authorFamily: acs ? acs.fontFamily : '',
        authorSize: acs ? parseFloat(acs.fontSize) : -1,
        authorWeight: acs ? parseInt(acs.fontWeight, 10) : -1,
        authorLetter: acs ? acs.letterSpacing : '',
        authorW: acs ? parseFloat(acs.width) : -1,
        accent: toRgb(root.getPropertyValue('--accent')),
        serif: toRgb(root.getPropertyValue('--serif')),
        // 关闭键必须绝对定位，否则它会把居中标题挤偏
        xPosition: (() => {
          const x = document.querySelector('#aboutMask .box-x');
          return x ? getComputedStyle(x).position : '';
        })(),
      };
    });
    assert.ok(m, '关于页应有 .about-row');
    assert.equal(m.display, 'flex', `关于页行应是 flex（老项目 :256），实际 ${m.display} —— grid 定宽左对齐是另画的一套`);
    assert.equal(m.justify, 'center', `关于页行应整体居中，实际 ${m.justify}`);
    assert.equal(m.alignItems, 'baseline', `关于页行应 align-items:baseline（键值基线齐），实际 ${m.alignItems}`);
    assert.equal(m.gap, 10, `键值间距应 10px，实际 ${m.gap}px`);
    assert.equal(m.fontSize, 12.5, `关于页行字号应 12.5px，实际 ${m.fontSize}px`);
    // line-height:2 → 计算值 = 12.5 × 2 = 25px
    // 🔴 getComputedStyle 返回的是**带单位字符串**（"25px"），不是数字 ——
    //   不 parseFloat 就是 "25px" - 25 = NaN，判据恒红。
    assert.ok(
      Math.abs(px(m.lineHeight) - 25) < 0.6,
      `关于页行行高应 2（=25px），实际 ${m.lineHeight}`,
    );
    assert.equal(m.kSize, 11.5, `键列字号应 11.5px，实际 ${m.kSize}px`);
    assert.equal(m.kLetter, '1px', `键列字距应 1px，实际 ${m.kLetter}`);
    assert.equal(m.kColor, m.muted, `键列应是 muted（${m.muted}），实际 ${m.kColor}`);
    assert.equal(m.vW, 110, `值列应定宽 110px（老项目 .about-v），实际 ${m.vW}px`);
    assert.equal(m.vAlign, 'left', `值列应左对齐（与键列一起居中），实际 ${m.vAlign}`);
    assert.equal(m.vWeight, 600, `值列字重应 600，实际 ${m.vWeight}`);
    assert.ok(
      m.vNum.includes('tabular-nums'),
      `值列应 tabular-nums（版本号逐位对齐），实际 "${m.vNum}"`,
    );
    assert.equal(m.vBreak, 'break-all', `值列应 word-break:break-all（长APK 名不溢出），实际 ${m.vBreak}`);
    // 作者行：金色衬线 14px 不加粗
    assert.equal(m.authorExists, true, '关于页应有作者行');
    assert.equal(m.authorColor, m.accent, `作者名应是金色 --accent（${m.accent}），实际 ${m.authorColor}`);
    assert.ok(
      fontEq(m.authorFamily, m.serif),
      `作者名应吃衬线体 --serif（${m.serif}），实际 ${m.authorFamily}`,
    );
    assert.equal(m.authorSize, 14, `作者名字号应 14px，实际 ${m.authorSize}px`);
    assert.equal(m.authorWeight, 400, `作者名字重应 400（不加粗），实际 ${m.authorWeight}`);
    assert.equal(m.authorLetter, '0.5px', `作者名字距应 .5px，实际 ${m.authorLetter}`);
    assert.equal(m.authorW, 110, `作者名值列应同为 110px（与上面几行左右缘齐），实际 ${m.authorW}px`);
    assert.equal(
      m.xPosition,
      'absolute',
      `关于页关闭键应绝对定位浮在盒内右上，实际 ${m.xPosition} —— 参与排版会把居中标题挤偏`,
    );
  } finally {
    await page.close();
  }
});

/* ========================================================================
 * 26 —— 升级弹窗
 * ======================================================================== */

test('VVW-09 🔴🔴 升级弹窗版本号必须 22px 金色衬线 600，说明 13.5px/1.95/500，进度条 6px', async () => {
  // 老项目 index.html:263-271
  // 🔴 升级弹窗由 buildAboutOverlay **建在关于页同一次挂载里**（ota-ui.ts:120-164），
  //   而那个浮层是 onAbout 才懒建的（main.ts:857）—— 不先开关于页，
  //   #updVer/#updNotes/#updMsg/#updBar 一个都不在 DOM 里。
  //   "有更新"的真实路径要真机壳 + 服务端发版，本地跑不通，
  //   所以按 id 量真实计算样式：元素在、样式表在，量到的就是用户会看到的那一套。
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw09', 'pw');
  try {
    await openAbout(page);
    const m = await page.evaluate(() => {
      const toRgb = (c) => {
        const s = String(c).trim();
        const hex = /^#([0-9a-f]{6})$/i.exec(s);
        if (hex) {
          const n = parseInt(hex[1], 16);
          return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
        }
        return s;
      };
      const ver = document.getElementById('updVer');
      const notes = document.getElementById('updNotes');
      const msg = document.getElementById('updMsg');
      const bar = document.getElementById('updBar');
      const ubox = document.getElementById('updMask')?.querySelector('.box');
      if (!ver || !notes || !msg || !bar) return null;
      const root = getComputedStyle(document.documentElement);
      const vcs = getComputedStyle(ver);
      const ncs = getComputedStyle(notes);
      const mcs = getComputedStyle(msg);
      const fill = getComputedStyle(bar.parentElement);
      return {
        vSize: parseFloat(vcs.fontSize),
        vWeight: parseInt(vcs.fontWeight, 10),
        vFamily: vcs.fontFamily,
        vColor: toRgb(vcs.color),
        vLetter: vcs.letterSpacing,
        vLine: vcs.lineHeight,
        nSize: parseFloat(ncs.fontSize),
        nLine: parseFloat(ncs.lineHeight),
        nWeight: parseInt(ncs.fontWeight, 10),
        nAlign: ncs.textAlign,
        mFamily: mcs.fontFamily,
        mSize: parseFloat(mcs.fontSize),
        mMinH: parseFloat(mcs.minHeight),
        mAlign: mcs.textAlign,
        trackH: parseFloat(fill.height),
        trackRadius: parseFloat(fill.borderTopLeftRadius),
        boxAlign: ubox ? getComputedStyle(ubox).textAlign : '',
        serif: toRgb(root.getPropertyValue('--serif')),
        mono: toRgb(root.getPropertyValue('--mono')),
        accent: toRgb(root.getPropertyValue('--accent')),
      };
    });
    assert.ok(m, '升级弹窗的常驻元素应齐全（#updVer/#updNotes/#updMsg/#updBar）');
    assert.equal(m.vSize, 22, `版本号应 22px，实际 ${m.vSize}px —— 15px 把它压成了普通正文一行`);
    assert.equal(m.vWeight, 600, `版本号字重应 600，实际 ${m.vWeight}`);
    assert.ok(
      fontEq(m.vFamily, m.serif),
      `版本号应吃衬线体 --serif（${m.serif}），实际 ${m.vFamily}`,
    );
    assert.equal(m.vColor, m.accent, `版本号应是金色 --accent（${m.accent}），实际 ${m.vColor}`);
    // 字距 .04em × 22px = 0.88px（letterSpacing 是带单位字符串，必须 parseFloat）
    assert.ok(
      Math.abs(px(m.vLetter) - 22 * 0.04) < 0.02,
      `版本号字距应 .04em（≈0.88px），实际 ${m.vLetter}`,
    );
    // line-height 1.25 × 22 = 27.5（同样是带单位字符串）
    assert.ok(
      Math.abs(px(m.vLine) - 27.5) < 0.6,
      `版本号行高应 1.25（=27.5px），实际 ${m.vLine}`,
    );
    assert.equal(m.nSize, 13.5, `说明文字字号应 13.5px，实际 ${m.nSize}px`);
    // 行高 1.95 × 13.5 = 26.325
    assert.ok(
      Math.abs(m.nLine - 13.5 * 1.95) < 0.6,
      `说明文字行高应 1.95（≈26.3px），实际 ${m.nLine}`,
    );
    assert.equal(m.nWeight, 500, `说明文字字重应 500（老项目 v9.3.4 方案B），实际 ${m.nWeight}`);
    assert.equal(m.nAlign, 'left', `说明文字应左对齐（多行条目左缘齐），实际 ${m.nAlign}`);
    assert.ok(
      fontEq(m.mFamily, m.mono),
      `消息行应走等宽体 --mono（${m.mono}，下载进度是机器输出），实际 ${m.mFamily}`,
    );
    assert.equal(m.mSize, 11.5, `消息行字号应 11.5px，实际 ${m.mSize}px`);
    assert.equal(m.mMinH, 18, `消息行min-height 应 18px（不跳行），实际 ${m.mMinH}px`);
    assert.equal(m.mAlign, 'left', `消息行应左对齐，实际 ${m.mAlign}`);
    assert.equal(m.trackH, 6, `进度条应 6px 高，实际 ${m.trackH}px —— 5px 那点进度在手机上几乎看不见`);
    assert.ok(
      m.trackRadius >= 3,
      `进度条圆角应 3px（半圆头），实际 ${m.trackRadius}px`,
    );
    assert.equal(
      m.boxAlign,
      'center',
      `升级弹窗盒应整体居中（老项目 :263），实际 ${m.boxAlign}`,
    );
  } finally {
    await page.close();
  }
});

/* ========================================================================
 * 27 —— 首页提示页 .home
 * ======================================================================== */

test('VVW-10 🔴🔴 首页提示页 h1 24px/500/.04em + p 14px/1.9 + code 13px + padding 20px', async () => {
  // 老项目 index.html:541-544
  // 走真实用户路径：落地页输入一个保留字 → 路由回首页提示页（不是白屏）。
  const page = await h.browser().newPage();
  try {
    await page.goto(h.baseUrl());
    await page.waitForSelector('#li', { timeout: 15_000 });
    await page.fill('#li', 'about');
    await page.click('#landingBtn');
    await page.waitForSelector('#home', { timeout: 15_000 });
    const m = await page.evaluate(() => {
      const home = document.querySelector('.home');
      const h1 = home?.querySelector('h1');
      const p = home?.querySelector('p');
      const code = home?.querySelector('code');
      if (!home || !h1 || !p || !code) return null;
      const hs = getComputedStyle(home);
      const h1s = getComputedStyle(h1);
      const ps = getComputedStyle(p);
      const cs = getComputedStyle(code);
      const root = getComputedStyle(document.documentElement);
      return {
        pad: parseFloat(hs.padding),
        align: hs.textAlign,
        h1Family: h1s.fontFamily,
        h1Size: parseFloat(h1s.fontSize),
        h1Weight: parseInt(h1s.fontWeight, 10),
        h1Letter: h1s.letterSpacing,
        pSize: parseFloat(ps.fontSize),
        pLine: parseFloat(ps.lineHeight),
        pColor: ps.color,
        codeSize: parseFloat(cs.fontSize),
        codeFamily: cs.fontFamily,
        serif: root.getPropertyValue('--serif').trim(),
        mono: root.getPropertyValue('--mono').trim(),
        muted: root.getPropertyValue('--muted').trim(),
      };
    });
    assert.ok(m, '保留字应回首页提示页 .home（不是白屏）');
    assert.equal(m.pad, 20, `.home 内边距应 20px，实际 ${m.pad}px —— 24px 会让提示字挤成两行`);
    assert.equal(m.align, 'center', `.home 应居中，实际 ${m.align}`);
    assert.ok(
      fontEq(m.h1Family, m.serif),
      `.home h1 应吃衬线体 --serif（${m.serif}），实际 ${m.h1Family}`,
    );
    assert.equal(m.h1Size, 24, `.home h1 应 24px，实际 ${m.h1Size}px —— 22px 让首屏标题"没有分量"`);
    assert.equal(m.h1Weight, 500, `.home h1 字重应 500，实际 ${m.h1Weight}`);
    // 字距 .04em × 24 = 0.96px
    assert.ok(
      Math.abs(parseFloat(m.h1Letter) - 24 * 0.04) < 0.02,
      `.home h1 字距应 .04em（≈0.96px），实际 ${m.h1Letter}`,
    );
    assert.equal(m.pSize, 14, `.home p 应 14px，实际 ${m.pSize}px`);
    // 行高 1.9 × 14 = 26.6
    assert.ok(
      Math.abs(m.pLine - 14 * 1.9) < 0.6,
      `.home p 行高应 1.9（≈26.6px），实际 ${m.pLine}`,
    );
    assert.equal(m.codeSize, 13, `.home code 应 13px，实际 ${m.codeSize}px`);
    assert.ok(
      fontEq(m.codeFamily, m.mono),
      `.home code 应走等宽体 --mono（${m.mono}），实际 ${m.codeFamily}`,
    );
  } finally {
    await page.close();
  }
});

/* ========================================================================
 * 28 —— 图片查看器 / 长按菜单 / 徽章挂点
 * ======================================================================== */

test('VVW-11 🔴🔴 查看器与长按菜单 CSS 变量必须已定义（功能是下一批，样式这一批钉死）', async () => {
  // 老项目 index.html:59-93（:root 与 body.dark 的 zoom 六档）+ :348-375（两块整CSS）
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw11', 'pw');
  try {
    const m = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const v = (n) => root.getPropertyValue(n).trim();
      // 令牌 + 关键声明（去样式表里取，因为 DOM 里此刻还没有 #nsZoom 元素）
      const declOf = (selector, prop) => {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules;
          try {
            rules = Array.from(sheet.cssRules);
          } catch {
            continue;
          }
          for (const r of rules) {
            if (r.selectorText === selector) {
              const got = r.style.getPropertyValue(prop);
              if (got) return got.trim();
            }
          }
        }
        return '';
      };
      return {
        tokens: {
          zoomBg: v('--zoom-bg'),
          zoomInk: v('--zoom-ink'),
          zoomChip: v('--zoom-chip'),
          zoomLine: v('--zoom-line'),
          zoomDim: v('--zoom-dim'),
          zoomSolid: v('--zoom-solid'),
          imgMenuShadow: v('--img-menu-shadow'),
        },
        decls: {
          zoomPosition: declOf('#nsZoom', 'position'),
          zoomZ: declOf('#nsZoom', 'z-index'),
          zoomAnim: declOf('#nsZoom', 'animation'),
          imgMenuPosition: declOf('#nsImgMenu', 'position'),
          imgMenuZ: declOf('#nsImgMenu', 'z-index'),
          imgMenuMinW: declOf('#nsImgMenu', 'min-width'),
          imgMenuRadius: declOf('#nsImgMenu', 'border-radius'),
          imgMenuPad: declOf('#nsImgMenu', 'padding'),
          barBg: declOf('#nsZoom .nz-bar', 'background'),
          btnMinH: declOf('#nsZoom .nz-bar button', 'min-height'),
          btnMaxW: declOf('#nsZoom .nz-bar button', 'max-width'),
          xW: declOf('#nsZoom .nz-x', 'width'),
          imgMaxW: declOf('#nsZoom img', 'max-width'),
          imgMaxH: declOf('#nsZoom img', 'max-height'),
          menuFadeExists: (() => {
            for (const sheet of Array.from(document.styleSheets)) {
              let rules;
              try {
                rules = Array.from(sheet.cssRules);
              } catch {
                continue;
              }
              for (const r of rules) {
                if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'nsMenuFade') {
                  const frames = Array.from(r.cssRules).map((k) => k.keyText);
                  return frames.join('|');
                }
              }
            }
            return '';
          })(),
        },
      };
    });
    // 六档 zoom 令牌：日/夜两档都由 theme.ts 注入
    for (const [k, val] of Object.entries(m.tokens)) {
      assert.ok(val !== '', `CSS 变量 --${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} 必须已定义（老项目 zoom 六档）`);
    }
    // 日间也必须是暗底：照片要看清必须暗背景
    assert.ok(
      m.tokens.zoomBg !== '',
      '--zoom-bg 必须有值（日间也压深到近黑，白底浅色图在查看器里等于一片糊）',
    );
    assert.notEqual(
      m.tokens.zoomSolid,
      '',
      '--zoom-solid 必须有值（底栏要**不透明**实底，老项目 v9.3.7记过半透明底被亮图冲淡的bug）',
    );
    // z序：查看器 88、菜单 89，图鉴 90 最高
    assert.equal(m.decls.zoomPosition, 'fixed', `#nsZoom 应position:fixed，实际 ${m.decls.zoomPosition}`);
    assert.equal(m.decls.zoomZ, '88', `#nsZoom z-index 应 88，实际 ${m.decls.zoomZ}`);
    assert.equal(m.decls.imgMenuPosition, 'fixed', `#nsImgMenu 应 position:fixed，实际 ${m.decls.imgMenuPosition}`);
    assert.equal(m.decls.imgMenuZ, '89', `#nsImgMenu z-index 应 89，实际 ${m.decls.imgMenuZ}`);
    assert.equal(m.decls.imgMenuMinW, '150px', `#nsImgMenu min-width 应 150px，实际 ${m.decls.imgMenuMinW}`);
    assert.equal(m.decls.imgMenuRadius, '12px', `#nsImgMenu 圆角应 12px，实际 ${m.decls.imgMenuRadius}`);
    assert.equal(m.decls.imgMenuPad, '5px', `#nsImgMenu 内边距应 5px，实际 ${m.decls.imgMenuPad}`);
    assert.equal(m.decls.barBg, 'var(--zoom-solid)', `底栏应吃 --zoom-solid 实底，实际 ${m.decls.barBg}`);
    assert.equal(m.decls.btnMinH, '44px', `底栏按钮触控区应 ≥44px（老项目 v9.3.0），实际 ${m.decls.btnMinH}`);
    assert.equal(m.decls.btnMaxW, '220px', `底栏按钮最大宽应 220px，实际 ${m.decls.btnMaxW}`);
    assert.equal(m.decls.xW, '38px', `关闭键应 38px 圆形，实际 ${m.decls.xW}`);
    assert.equal(m.decls.imgMaxW, '92vw', `图最大宽应 92vw，实际 ${m.decls.imgMaxW}`);
    assert.equal(m.decls.imgMaxH, '82vh', `图最大高应 82vh（给底栏与顶栏留位），实际 ${m.decls.imgMaxH}`);
    // 🔴 陷阱6：keyText 归一化后是 '0%'/'100%'，不是 from/to
    assert.equal(
      m.decls.menuFadeExists,
      '0%|100%',
      `应存在 @keyframes nsMenuFade（老项目 menuFade 加 ns 前缀避免撞名），实际 keyText="${m.decls.menuFadeExists}"`,
    );
  } finally {
    await page.close();
  }
});

test('VVW-12 🔴🔴 彩蛋徽章必须在顶栏品牌内联（不是 fixed 浮在右上角），窄屏只留图标', async () => {
  // 老项目 index.html:653（挂点在 header .brand 里）/ :298-302（胶囊样式）/ :321（560px 只留裸 emoji）
  //
  // 🔴🔴🔴 本条曾断言「徽章默认 display:none」，而它**长期是条定时炸弹**：
  //   老项目 index.html:6574 `nsBadgeAt` —— 深夜（22:00–06:00）或节日**必然显示**徽章。
  //   这条用例一旦在深夜跑，"默认隐藏"就必然不成立；白天跑又恒绿。
  //   同一个断言在两个时刻得到两个结论，而它自己不知道自己依赖了时钟。
  //   （与项目记过的「测试里写死日历日期 = 定时炸弹」同源，只是这次写死的是**时刻**。）
  // 修法：把页面时钟**固定**在下午 2 点（既非深夜也非节日），两个断言都成立。
  const page = await openEditorAt(h.browser(), h.baseUrl(), 'vvw12', 'pw', {
    iso: '2026-10-05T14:00:00',
  });
  try {
    const m = await page.evaluate(() => {
      const b = document.getElementById('nsBadge');
      if (!b) return null;
      const cs = getComputedStyle(b);
      const brand = document.querySelector('.ns-brand');
      const top = document.querySelector('.ns-top');
      return {
        inBrand: !!b.closest('.ns-brand'),
        inTop: !!b.closest('.ns-top'),
        position: cs.position,
        display: cs.display,
        radius: cs.borderTopLeftRadius,
        padT: parseFloat(cs.paddingTop),
        padL: parseFloat(cs.paddingLeft),
        fontSize: parseFloat(cs.fontSize),
        letter: cs.letterSpacing,
        gap: parseFloat(cs.gap),
        pointerEvents: cs.pointerEvents,
        beExists: !!b.querySelector('.ns-be'),
        btExists: !!b.querySelector('.ns-bt'),
        brandIsFlex: brand ? getComputedStyle(brand).display : '',
        topChildCount: top ? top.children.length : -1,
        // 通知与徽章同在顶栏内：fixed 时会盖住工具键
        coversTools: (() => {
          if (!b || cs.position !== 'fixed') return false;
          const btn = document.querySelector('.ns-top button.ns-ic');
          if (!btn) return false;
          const a = b.getBoundingClientRect();
          const c = btn.getBoundingClientRect();
          return !(a.right < c.left || a.left > c.right || a.bottom < c.top || a.top > c.bottom);
        })(),
      };
    });
    assert.ok(m, '顶栏品牌里应有常驻挂点 #nsBadge');
    assert.equal(m.inBrand, true, '徽章挂点必须在 .ns-brand 里（老项目 :653 `header .brand` 内联）');
    assert.equal(m.inTop, true, '徽章应落在顶栏内');
    assert.equal(
      m.position,
      'static',
      `徽章应随品牌流式排布（position:static），实际 ${m.position} —— fixed到右上角会压在顶栏工具键上方`,
    );
    assert.equal(m.coversTools, false, '徽章不该盖住顶栏工具键');
    // 默认隐藏，show 时才inline-flex
    assert.equal(m.display, 'none', `徽章默认应 display:none，实际 ${m.display}`);
    // 加show 后应变 inline-flex 并挂上入场动画
    const shown = await page.evaluate(() => {
      const b = document.getElementById('nsBadge');
      if (!b) return null;
      b.classList.add('show');
      const cs = getComputedStyle(b);
      const snap = {
        display: cs.display,
        animName: cs.animationName,
        animDur: cs.animationDuration,
        radius: cs.borderTopLeftRadius,
        padL: parseFloat(cs.paddingLeft),
        fontSize: parseFloat(cs.fontSize),
      };
      return snap;
    });
    // 🔴 判据不能写死 'inline-flex'：#nsBadge 是 .ns-brand（display:flex）的**子项**，
    //   而 CSS 规定 flex item 的 display 会被**块级化**（inline-flex → flex）。
    //   老项目 :299 写的也是 inline-flex，但它同样在 `header .brand`（flex）里，
    //   所以老项目量到的也是 flex —— 判据写死 inline-flex 就是在把对的实现报成错的。
    //   要断的是"show 时从 none 变成可见的弹性盒"，两种写法都算过。
    assert.ok(
      shown.display === 'flex' || shown.display === 'inline-flex',
      `加 .show 后应变成可见的弹性盒（flex item 会被块级化为 flex），实际 ${shown.display}`,
    );
    assert.equal(shown.animName, 'nsBadgePop', `入场动画应是 nsBadgePop，实际 ${shown.animName}`);
    assert.equal(shown.animDur, '0.45s', `入场动画应 .45s，实际 ${shown.animDur}`);
    assert.equal(shown.radius, '999px', `徽章应是 999px胶囊，实际 ${shown.radius}`);
    assert.equal(shown.padL, 8, `胶囊左内边距应 8px（老项目 padding:3px 10px 3px 8px），实际 ${shown.padL}px`);
    assert.equal(shown.fontSize, 12, `徽章字号应 12px，实际 ${shown.fontSize}px`);
    assert.equal(m.beExists, true, '徽章应有图标列 .ns-be（560px 下只剩它）');
    assert.equal(m.btExists, true, '徽章应有文字列 .ns-bt（560px 下隐藏）');
    assert.equal(m.pointerEvents, 'none', `徽章应pointer-events:none（绝不打断输入），实际 ${m.pointerEvents}`);
    // 窄屏：脱掉胶囊皮，只留裸 emoji
    await page.setViewportSize({ width: 560, height: 720 });
    await page.waitForFunction(() => window.innerWidth === 560, { timeout: 5_000 });
    const narrow = await page.evaluate(() => {
      const b = document.getElementById('nsBadge');
      if (!b) return null;
      const cs = getComputedStyle(b);
      const bt = b.querySelector('.ns-bt');
      const be = b.querySelector('.ns-be');
      return {
        pad: cs.padding,
        border: cs.borderTopWidth,
        bg: cs.backgroundColor,
        gap: parseFloat(cs.gap),
        btDisplay: bt ? getComputedStyle(bt).display : '',
        beDisplay: be ? getComputedStyle(be).display : '',
      };
    });
    assert.ok(narrow, '窄屏下仍应能读到徽章');
    assert.equal(narrow.pad, '0px', `窄屏徽章应脱掉内边距（老项目 v8.2.3），实际 ${narrow.pad}`);
    assert.equal(narrow.border, '0px', `窄屏徽章应脱掉描边，实际 ${narrow.border}`);
    assert.equal(narrow.bg, 'rgba(0, 0, 0, 0)', `窄屏徽章应无底色，实际 ${narrow.bg}`);
    assert.equal(narrow.gap, 0, `窄屏徽章 gap 应 0，实际 ${narrow.gap}`);
    assert.equal(
      narrow.btDisplay,
      'none',
      `窄屏应隐藏文字只留图标（老项目 :321），实际 ${narrow.btDisplay}`,
    );
  } finally {
    await page.close();
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * 历史版本「预览」（用户报障第 4 条「历史版本页面没有预览按钮」）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 🔴🔴 为什么"每行有预览按钮"这件事本身就得钉：
 *
 *   此前每行只有 `[恢复]`。而**恢复是不可逆的**（老项目明确"历史不删，
 *   恢复不动快照环"）—— 用户想确认"这一版到底写了什么"只能靠先看一眼。
 *   缺预览不是少个按钮，是**逼用户盲操作一个不可逆动作**。
 *
 * 🔴 判据打**真实点击**并读回 DOM：
 *   预览是"点开/收起"同一个按钮的两种结果（老项目同款），所以要连点两次验收起，
 *   否则"只会开不会收"也是一种坏，而只点一次的断言看不见。
 */
// 🔴 编号 VVW-13：此前与关于页那条**重号**（都叫 VVW-07），
//   重号会让失败定位指向错的用例（同 S4-C6 撞号的教训）。
test('VVW-13 🔴 历史每行 [预览][恢复] 两枚按钮，预览能内联展开也能收起', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw06', 'pw');
  try {
    await openMenu(page);
    await page.click('#menuHistEntry');
    await page.waitForSelector('#histSave', { timeout: 10_000 });
    // 打一个快照，才有一行可预览
    await page.click('#histSave');
    await page.waitForSelector('.list-row[data-at]', { timeout: 10_000 });

    // 1) 两枚按钮都在，且文案逐字对齐老项目
    const btns = await page.evaluate(() => {
      const row = document.querySelector('.list-row[data-at]');
      return {
        restore: row?.querySelector('[data-restore]')?.textContent?.trim() ?? null,
        preview: row?.querySelector('[data-preview]')?.textContent?.trim() ?? null,
        inBtns: !!row?.querySelector('.hist-btns'),
      };
    });
    assert.equal(btns.restore, '恢复', '恢复按钮文案不对');
    assert.equal(btns.preview, '预览', '缺「预览」按钮（用户报障第 4 条）');
    assert.ok(btns.inBtns, '两枚按钮应包在 .hist-btns 里（gap 与不压缩靠它）');

    // 2) 点预览 → 内联展开 .hist-preview，且菜单**不关**（老项目同款：预览是"看一眼"）
    // 🔴🔴 必须先等元素**稳定**再点：每次 render() 都整块 innerHTML 换掉按钮，
    //   Playwright 的 actionability 检查会看到节点在换而一直重试（实测报
    //   'element is not stable'）。这不是产品的 bug，是断言与实现的时序没对齐。
    await page.waitForSelector('.list-row[data-at] [data-preview]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.click('.list-row[data-at] [data-preview]');
    await page.waitForSelector('.list-row[data-at] .hist-preview', { timeout: 10_000 });
    const opened = await page.evaluate(() => {
      const row = document.querySelector('.list-row[data-at]');
      const pv = row?.querySelector('.hist-preview');
      return {
        menuStillOpen: !!document.querySelector('.menu-box'),
        hasPreview: !!pv,
        text: (pv?.textContent ?? '').trim().slice(0, 40),
        rowOpen: row?.classList.contains('hist-open') ?? false,
        // 🔴 几何闸：预览块必须真的占位（max-height 120px + 可滚）
        h: pv ? Math.round(pv.getBoundingClientRect().height) : 0,
        overflowY: pv ? getComputedStyle(pv).overflowY : '',
        whiteSpace: pv ? getComputedStyle(pv).whiteSpace : '',
      };
    });
    assert.ok(opened.menuStillOpen, '点预览不该关掉菜单（否则把要看的东西关在门后）');
    assert.ok(opened.hasPreview, '预览块没渲染出来');
    assert.ok(opened.rowOpen, '展开的行应有 hist-open 类（一眼可辨）');
    assert.ok(opened.h > 0, '预览块高度为 0 —— 视觉上等于没出现');
    assert.equal(opened.overflowY, 'auto', '长版本必须可滚（老项目 max-height:120px+overflow-y:auto）');
    // 🔴 pre-wrap 是功能性的：去掉它预览里的空行会消失，用户会以为恢复后也丢内容
    assert.equal(opened.whiteSpace, 'pre-wrap', '预览必须保留换行/空行（white-space:pre-wrap）');

    // 3) 再点一次 → 收起（同一按钮的两种结果）
    await page.waitForSelector('.list-row[data-at] [data-preview]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.click('.list-row[data-at] [data-preview]');
    await page.waitForFunction(
      () => !document.querySelector('.list-row[data-at] .hist-preview'),
      { timeout: 10_000 },
    );
    const closed = await page.evaluate(() => ({
      menuStillOpen: !!document.querySelector('.menu-box'),
      rowOpen: document.querySelector('.list-row[data-at]')?.classList.contains('hist-open') ?? false,
    }));
    assert.ok(closed.menuStillOpen, '收起预览不该关菜单');
    assert.equal(closed.rowOpen, false, '收起后 hist-open 类应去掉');
  } finally {
    await page.close();
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * 链接打开方式二级页（用户报障第 4 条）
 * 「设置链接弹窗不同…且没有显示系统浏览器图标…没有选中状态」
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 🔴🔴 这条盯的是三处**同时**缺失的组合，缺任一条测试都会红：
 *   ① 两行各自的**专属图标**（应用内=手机 / 系统浏览器=地球）。
 *      bj 此前是一个**通用槽位**，浏览器那行干脆没图标
 *      —— 而"两行各一个图标"正是这个控件是"二选一"而非"两个链接"的视觉暗示。
 *   ② 选中标记是**对勾**（老项目 `.tick`），不是五角星。
 *      复选框画成星星 ⇒ 语义变成"收藏"，用户会误操作。
 *   ③ `.tick` 默认 `visibility:hidden`、选中才 visible
 *      —— 靠可见性表达选中，而不是插/删 DOM（两行结构对称，切换时不跳行）。
 *
 * 🔴 判据同时钉 aria-checked 与视觉可见性：**两个都要**。
 *   只钉 aria 的话，"样式全丢"的退化测不出来（属性照样在）。
 */
test('VVW-14 🔴 链接打开方式：两行各有专属图标 + 选中行显示对勾', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw14', 'pw');
  try {
    await openMenu(page);
    await page.click('#menuLink');
    await page.waitForSelector('#linkInApp', { timeout: 10_000 });

    const rows = await page.evaluate(() =>
      ['linkInApp', 'linkBrowser'].map((id) => {
        const r = document.querySelector('#' + id);
        const tick = r?.querySelector('.tick');
        return {
          id,
          checked: r?.getAttribute('aria-checked') ?? null,
          // 专属图标 = 第一个 svg（第二个是 .tick 对勾）
          iconPaths: (r?.querySelectorAll('svg')[0]?.querySelectorAll('path,rect,circle').length) ?? 0,
          iconW: Math.round(r?.querySelectorAll('svg')[0]?.getBoundingClientRect().width ?? 0),
          tickExists: !!tick,
          tickVisible: tick ? getComputedStyle(tick).visibility : '(no tick)',
          rowH: Math.round(r?.getBoundingClientRect().height ?? 0),
        };
      }),
    );

    const [inApp, browser] = rows;
    // ① 两行都必须有专属图标，且尺寸一致（老项目 26px）
    for (const r of rows) {
      assert.ok(r.iconPaths > 0, `${r.id} 缺专属图标（用户报障「没有显示系统浏览器图标」）`);
      assert.equal(r.iconW, 26, `${r.id} 图标尺寸应 26px，实际 ${r.iconW}`);
    }
    // 🔴 浏览器那行不能是"没有图标"（这条单独立一条，因为它是用户原话点名的）
    assert.ok(browser.iconPaths > 0, '系统浏览器一行没有图标');
    assert.notEqual(inApp.iconPaths, 0, '应用内一行没有图标');

    // ②③ 两行都必备 .tick，且**恰好一行**可见
    for (const r of rows) {
      assert.ok(r.tickExists, `${r.id} 缺 .tick 选中标记容器`);
    }
    assert.equal(inApp.tickVisible, 'visible', '应用内（默认选中）应显示对勾');
    assert.equal(browser.tickVisible, 'hidden', '系统浏览器未选中时对勾应隐藏');
    // 行高与老项目一致 46px
    for (const r of rows) assert.equal(r.rowH, 46, `${r.id} 行高应 46px，实际 ${r.rowH}`);

    // 切到浏览器：勾必须跟着走（这是"选中状态"的核心行为）
    await page.click('#linkBrowser');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() =>
      ['linkInApp', 'linkBrowser'].map((id) => ({
        id,
        checked: document.querySelector('#' + id)?.getAttribute('aria-checked'),
        tickVisible: document.querySelector('#' + id + ' .tick')
          ? getComputedStyle(document.querySelector('#' + id + ' .tick')).visibility
          : '(no tick)',
      })),
    );
    assert.equal(after[0].checked, 'false', '切到浏览器后应用内应变为未选中');
    assert.equal(after[1].checked, 'true', '切到浏览器后浏览器应变为选中');
    assert.equal(after[0].tickVisible, 'hidden', '切走后应用内的对勾应隐藏');
    assert.equal(after[1].tickVisible, 'visible', '切到浏览器后对勾应显示');
  } finally {
    await page.close();
  }
});

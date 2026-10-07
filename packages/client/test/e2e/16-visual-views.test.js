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
import { installHarness, openEditor, openEditorAt, openEditorTouch, closeTouch, withTimeout } from './harness.mjs';

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
    // 🔴🔴🔴 2026-10-07 判据纠错：这条原先写的是 `hasGo === true`（"历史行也应有右箭头，
    //   老项目 .fav-go 同款"）—— **它钉的正是用户报障第 8 条的那个 bug**。
    //   老项目 index.html:8490-8536 逐行读下来：`.hist-item` 里只有
    //   HIST_CLOCK_SVG + `.hist-line`（内含 `.hist-meta` 与 `.hist-btns`）+ 可选 `.hist-preview`，
    //   **从头到尾没有 fav-go**；`.fav-go`（index.html:461）只属 `.fav-row`（收藏行）。
    //   而且老项目的历史行**整行不可点**（行为全在 [预览]/[恢复] 两枚按钮上），
    //   那枚箭头等于在暗示一个不存在的交互。
    //   ⇒ 正确的判据是反向的：历史行**不该有**右箭头。
    assert.equal(
      m.hasGo,
      false,
      '历史行不该有右箭头 .fav-go（老项目 .hist-item 只有 时钟 + 时间 + 两枚按钮；' +
        '行本身不可点，箭头会暗示一个不存在的交互）',
    );
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
 * 历史版本「预览」不许让页面闪一下（用户报障第 6 条）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 🔴🔴🔴 这条钉的不是"最终有没有展开"，而是**中间帧**。
 *
 *   VVW-13 已经在钉终态了（`.hist-preview` 出现、高度>0、可滚），
 *   而用户报障第 6 条是「点击预览的时候，页面**不要闪一下**」——
 *   终态断言对闪烁**恒绿**：闪 500ms 之后终态照样是"展开成功"。
 *   所以必须采 rAF 帧序列，钉"从点击到稳定之间有没有不可见的中间态"。
 *
 * 🔴🔴🔴 根因（量化实锤，不是推理）：
 *   `ui/menu.ts:203` 每次 render() 都 `el.innerHTML = '<div class="box menu-box">…'`
 *   **整块重建菜单盒**，而 `ui/styles.css:134` 的 `.box` 上挂着
 *   `animation: nsRise .5s cubic-bezier(.2,.7,.3,1) both`。
 *   ⇒ 每点一次预览，`.box` 作为一个**全新元素**重新入场：
 *   从 `opacity:0 / translateY(10px)` 爬到 `opacity:1 / translateY(0)`，
 *   整张菜单在 0.5s 里淡入 + 上移 ⇒ 用户看到的"闪一下"。
 *
 *   老项目（index.html:686）`<div class="box" id="menuBox">` 是**HTML 里常驻的节点**，
 *   预览走 `row.appendChild(box)`（:8512）只加一个子节点，**从不碰菜单盒本身**
 *   ⇒ 菜单盒的入场动画只在首次打开时播一次。
 *
 * 🔴 三条判据分工（缺一条就会被"把动画删了"或"把整块重建改成局部更新"骗过）：
 *   HIST-PREVIEW-01 菜单盒必须是**同一个 DOM 节点**跨过 render（老项目口径）
 *   HIST-PREVIEW-02 点预览后**零帧** opacity<1（不许重播入场）
 *   HIST-PREVIEW-03 展开态与预览内容**同帧**落地（不许"先展开后补内容"）
 *   反向闸在 HIST-PREVIEW-04：首次打开菜单**必须**仍有入场动画 ——
 *   不然"删掉 .box 的 animation"就是一条能骗过 01~03 的假修。
 */
test('VVW-30 🔴 历史预览：菜单盒常驻 + 点预览零中间帧（用户报障第 6 条）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw30', 'pw');
  try {
    await openMenu(page);
    await page.click('#menuHistEntry');
    await page.waitForSelector('#histSave', { timeout: 10_000 });
    await page.click('#histSave');
    await page.waitForSelector('.list-row[data-at] [data-preview]', { timeout: 10_000 });
    // 🔴 等入场动画（.5s）跑完再开始采样，否则量到的是"打开菜单"那一下的正常入场
    await page.waitForTimeout(800);

    // ── HIST-PREVIEW-01：菜单盒是常驻节点，不许被 innerHTML 换掉 ──
    // 🔴 用**元素身份**判，不是用 querySelector 重新找 —— 重新找永远能找到，
    //   恒真。判据是"点击前拿到的那个对象，点击后还是不是 document 里的同一个"。
    await page.evaluate(() => {
      window.__histBoxRef = document.querySelector('.menu-box');
      window.__histFrames = [];
      window.__histStop = false;
      const t0 = performance.now();
      // 🔴 采样函数必须自包含：被序列化进页面，不能引用外部作用域。
      const tick = () => {
        if (window.__histStop) return;
        const box = document.querySelector('.menu-box');
        const row = document.querySelector('.list-row[data-at]');
        const pv = row ? row.querySelector('.hist-preview') : null;
        window.__histFrames.push({
          t: Math.round(performance.now() - t0),
          sameNode: box === window.__histBoxRef,
          opacity: box ? getComputedStyle(box).opacity : null,
          // transform 归一化：matrix(1,0,0,1,0,0) 与 none 都算"没动"
          moved: box ? getComputedStyle(box).transform !== 'none' &&
            getComputedStyle(box).transform !== 'matrix(1, 0, 0, 1, 0, 0)' : null,
          boxExists: !!box,
          rowOpen: row ? row.classList.contains('hist-open') : null,
          pvExists: !!pv,
          pvLen: pv ? (pv.textContent || '').trim().length : 0,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    assert.ok(
      await page.evaluate(() => !!window.__histBoxRef),
      '采样前必须能拿到菜单盒节点',
    );

    await page.click('.list-row[data-at] [data-preview]');
    await page.waitForSelector('.list-row[data-at] .hist-preview', { timeout: 10_000 });
    await page.waitForTimeout(700);

    const fr = await page.evaluate(() => {
      window.__histStop = true;
      return window.__histFrames;
    });
    assert.ok(fr.length >= 5, `采帧太少（${fr.length}），采帧器没跑起来，判据会假绿`);

    // ── HIST-PREVIEW-01 ──
    const swapped = fr.filter((f) => !f.sameNode);
    assert.deepEqual(
      swapped.map((f) => f.t),
      [],
      `菜单盒被换掉了（老项目 #menuBox 是常驻节点，预览只 appendChild 子节点）。` +
        `变帧时刻=${JSON.stringify(swapped.map((f) => f.t))}。` +
        `根因：menu.ts:203 整块 innerHTML 重建 .box，.box 的 nsRise 入场动画被重播。`,
    );

    // ── HIST-PREVIEW-02：零帧半透明（不许重播入场）──
    const faded = fr.filter((f) => f.boxExists && parseFloat(f.opacity) < 0.99);
    assert.deepEqual(
      faded.map((f) => `${f.t}ms:${f.opacity}`),
      [],
      `点预览后菜单盒有 ${faded.length} 帧半透明 ⇒ 入场动画被重播了，这就是"闪一下"。`,
    );
    const slid = fr.filter((f) => f.moved === true);
    assert.deepEqual(
      slid.map((f) => f.t),
      [],
      `点预览后菜单盒有 ${slid.length} 帧带位移（transform≠none）⇒ nsRise 的 translateY 在重播。`,
    );

    // ── HIST-PREVIEW-03：展开态与内容同帧落地 ──
    // 🔴 "有"必须有"不应该有"配对：只钉"最后展开了"的话，
    //   "先展开成空行、1 秒后补内容"这种闪法照样绿。
    const openNoPv = fr.filter((f) => f.rowOpen && !f.pvExists);
    assert.deepEqual(
      openNoPv.map((f) => f.t),
      [],
      `有 ${openNoPv.length} 帧"hist-open 已加但 .hist-preview 还没进 DOM" ⇒ 内容后补，用户看到的就是一行空白先跳出来。`,
    );
    const pvEmpty = fr.filter((f) => f.pvExists && f.pvLen === 0);
    assert.deepEqual(
      pvEmpty.map((f) => f.t),
      [],
      `有 ${pvEmpty.length} 帧".hist-preview 在树里但内容为空"。`,
    );
    // 反向闸：确实量到了展开帧，否则上面三条全在空集上断言
    assert.ok(
      fr.some((f) => f.rowOpen && f.pvExists && f.pvLen > 0),
      '整轮都没量到"已展开且有内容"的帧 —— 采样窗口太短或选择器错了，判据恒真。',
    );
  } finally {
    await page.close();
  }
});

/**
 * 🔴 反向闸（防"把动画删了"这条假修）：
 *   HIST-PREVIEW-02 钉的是"重播 ⇒ 红"。但只要有人把 `.box` 的
 *   `animation: nsRise …` 整条删掉，01~03 会全绿 —— 而老项目确实有入场动画
 *   （index.html:509 `animation:rise .5s cubic-bezier(.2,.7,.3,1) both`），
 *   删掉就是另一处视觉回退。
 *
 *   所以这里钉：**首次打开菜单**必须有半透明入场帧。
 *   合起来才唯一确定正解 = **保留 `.box` 常驻 + 只在首次 open 时播一次动画**。
 */
test('VVW-31 🔴 反向闸：首次打开菜单仍必须有 nsRise 入场动画', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw31', 'pw');
  try {
    await page.evaluate(() => {
      window.__openFrames = [];
      window.__openStop = false;
      const t0 = performance.now();
      const tick = () => {
        if (window.__openStop) return;
        const box = document.querySelector('.menu-box');
        window.__openFrames.push({
          t: Math.round(performance.now() - t0),
          exists: !!box,
          anim: box ? getComputedStyle(box).animationName : null,
          opacity: box ? getComputedStyle(box).opacity : null,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await openMenu(page);
    await page.waitForSelector('.menu-box', { timeout: 10_000 });
    await page.waitForTimeout(800);

    const fr = await page.evaluate(() => {
      window.__openStop = true;
      return window.__openFrames;
    });
    const withBox = fr.filter((f) => f.exists);
    assert.ok(withBox.length >= 5, `采帧太少（${withBox.length}），判据会假绿`);
    const anims = [...new Set(withBox.map((f) => f.anim))];
    assert.deepEqual(
      anims,
      ['nsRise'],
      `菜单盒入场动画名应恒为 nsRise（老项目 rise 的 bj 私有名），实际 ${JSON.stringify(anims)}`,
    );
    const faded = withBox.filter((f) => parseFloat(f.opacity) < 0.99);
    assert.ok(
      faded.length > 0,
      '首次打开菜单一帧半透明都没有 ⇒ 入场动画被删了。' +
        '老项目 index.html:509 有 `animation:rise .5s … both`，删掉是视觉回退。',
    );
    // 动画必须**跑完**（终态 opacity=1），不许卡在中途
    assert.equal(
      withBox[withBox.length - 1].opacity,
      '1',
      '入场动画结束后 opacity 应为 1',
    );
  } finally {
    await page.close();
  }
});

/**
 * 🔴🔴🔴 这条是**变异实测补上的**，不是先想到的。
 *
 *   背景：把菜单盒改成常驻节点时，我漏了 `close()` 里的 `el.innerHTML = ''`
 *   —— 它会把常驻盒子一起摘掉。后果不是"多闪一下"，而是
 *   **菜单彻底坏掉**：render() 只往那个已脱离文档的 box 写内容，
 *   而 el 里已经空了 ⇒ 重新打开菜单时 `.menu-box` 永远不出现
 *   （探针实测：`page.waitForSelector('.menu-box')` 10s 超时）。
 *
 * 🔴 而 VVW-30 / VVW-31 在这个 bug 下**全绿** —— 两条都只在
 *   "同一次 open 会话内"采样，而 close→reopen 跨过了会话边界。
 *   ⇒ 判据的采样窗口本身就是 bug 的藏身处。
 *   「凡是把节点生命周期从"每次 render 重建"改成"常驻」的修复，
 *     必须补一条跨 close/reopen 的判据」，否则改对一半也会绿。
 *
 * 三条一起钉：
 *   ① 关菜单后 `.menu-box` 仍在 DOM 里（老项目只切 mask 的 hidden）
 *   ② 重新打开后主菜单 11 项齐全可见
 *   ③ 重新打开后仍是**同一个节点对象**
 */
test('VVW-32 🔴 菜单盒常驻后，关闭再打开必须仍可用且是同一节点', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw32', 'pw');
  try {
    await openMenu(page);
    await page.waitForSelector('.menu-box', { timeout: 10_000 });
    await page.waitForTimeout(800);

    // 记住盒子对象 + 塞个标记，用来验"同一个节点"
    const before = await page.evaluate(() => {
      const box = document.querySelector('.menu-box');
      box.__histMarker = 'ORIGINAL';
      return { hasMenu: !!document.querySelector('#menuHome') };
    });
    assert.ok(before.hasMenu, '首次打开时主菜单应在');

    // 关闭：走真实的点遮罩空白（不是调 close()，那是内部函数）
    await page.evaluate(() => {
      const mask = document.querySelector('#menuMask');
      mask.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(300);

    const closed = await page.evaluate(() => ({
      maskHidden: document.querySelector('#menuMask')?.classList.contains('hidden') ?? false,
      boxStillInDom: !!document.querySelector('.menu-box'),
      // 🔴 关键：盒子必须还在，且标记还在（说明没被重建过）
      markerSurvived: document.querySelector('.menu-box')?.__histMarker === 'ORIGINAL',
    }));
    assert.equal(closed.maskHidden, true, '点遮罩后菜单应隐藏');
    assert.ok(
      closed.boxStillInDom,
      '关菜单后 `.menu-box` 被摘出了 DOM。老项目 index.html:8035 只切 mask 的 hidden，' +
        '`#menuBox` 是 HTML 常驻节点。摘掉它下次 open() 就写进了孤儿节点，菜单直接坏掉。',
    );
    assert.ok(closed.markerSurvived, '菜单盒被重建了（节点身份丢失）');

    // 重新打开 —— 这一步在"close 拆盒子"的 bug 下会 10s 超时
    await openMenu(page);
    await page.waitForSelector('.menu-box', { timeout: 10_000 });
    await page.waitForTimeout(300);

    const reopened = await page.evaluate(() => ({
      marker: document.querySelector('.menu-box')?.__histMarker ?? null,
      items: document.querySelectorAll('.menu-box .menu-item').length,
      home: !!document.querySelector('#menuHome'),
      about: !!document.querySelector('#menuAbout'),
      boxH: Math.round(document.querySelector('.menu-box')?.getBoundingClientRect().height ?? 0),
    }));
    assert.equal(
      reopened.marker,
      'ORIGINAL',
      '重新打开后菜单盒不是同一个节点 ⇒ 常驻没生效（每次 open 都在重建盒子）。',
    );
    assert.ok(reopened.home, '重新打开后主菜单项缺失（#menuHome）');
    assert.ok(reopened.about, '重新打开后「关于」项缺失（#menuAbout）');
    assert.ok(
      reopened.items >= 11,
      `重新打开后菜单项应 ≥11 个，实际 ${reopened.items}`,
    );
    assert.ok(reopened.boxH > 0, '重新打开后菜单盒高度为 0 —— 视觉上等于菜单没打开');
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

/**
 * 🔴 落地页标题/副标题必须**贴着文字宽度**（shrink-to-fit），不能被拉满。
 * 用户报障第 1 条「文字位置不同」。
 *
 * 🔴🔴 bj 曾在 logo/h1/sub/input-row 外面多包一层 `.landing-in{width:100%}`
 *   （老项目 index.html 里 0 处），于是 h1 被拉成 342px。
 *   老项目里它们是 `.landing`（flex column + align-items:center）的**直接子元素**
 *   ⇒ 各自 shrink-to-fit：实测 h1 157.53px、sub 89.97px。
 *
 * 🔴 修法是 `display:contents`（让子元素直接参与父级 flex），
 *   **不是**调 max-width 去凑宽度 —— 试过 max-content：那样 .input-row 的 340px
 *   会变成所有子项的共同宽度，h1 仍是 340，不对。
 *
 * 🔴 判据钉**宽度绝对值**而不是"看起来居中"：因为 align-items:center 下
 *   两种宽度的**视觉居中效果相同**，只有选中文字时的选区宽度、
 *   以及任何按元素宽度做的判断才会不同 ⇒ 不量宽度就测不出来。
 */
test('VVW-15 🔴 落地页 h1/副标题 shrink-to-fit（不拉满），输入行 340', async () => {
  const page = await h.browser().newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(h.baseUrl(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForSelector('.landing h1, #landing h1', { timeout: 10_000 });
    const m = await page.evaluate(() => {
      const w = (s) => {
        const e = document.querySelector(s);
        return e ? Math.round(e.getBoundingClientRect().width * 100) / 100 : null;
      };
      return {
        h1: w('.landing h1, #landing h1'),
        sub: w('.landing .sub, #landing .sub'),
        row: w('.lrow, .input-row'),
        trust: w('.trust'),
      };
    });
    // 老项目实测值（390 视口）
    assert.equal(m.h1, 157.53, `h1 应 shrink-to-fit 到 157.53px，实际 ${m.h1}`);
    assert.equal(m.sub, 89.97, `副标题应 shrink-to-fit 到 89.97px，实际 ${m.sub}`);
    assert.equal(m.row, 340, `输入行应 340px，实际 ${m.row}`);
    assert.equal(m.trust, 390, `卖点行应铺满 390px，实际 ${m.trust}`);
  } finally {
    await page.close();
  }
});

test('VVW-16 🔴🔴 菜单项几何必须与老项目逐字同值（间距类报障的钉死闸）', async () => {
  // 🔴 这条是「菜单点出来的菜单列表间距不一样」这条用户报障的**量化钉死**。
  //   我此前 memory 里把它记成"仍待做"，本轮并排量化后发现**已经对齐**——
  //   老项目 index.html:437 与 bj 的 .menu-item 逐字相同：
  //   padding:9px 12px / border-radius:10px / margin-bottom:5px / gap:12px /
  //   font-size:15px / min-height:42px / align-items:center / justify-content:center。
  //   ⇒ 这类"报障但实测已对齐"的项，正确的做法是**把钉死写进测试**，
  //   否则下次有人改了一处又会变成"没人说得清什么时候变的"。
  //   （教训见 memory：我此前把"未核实"当成"未做"，白排了一轮工。）
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw16', 'pw');
  try {
    await page.click('#menuBtn');
    await page.waitForSelector('.menu-box .menu-item', { timeout: 10_000 });
    const items = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.menu-box .menu-item'));
      const cs = getComputedStyle(els[0]);
      const r = els[0].getBoundingClientRect();
      return {
        n: els.length,
        h: Math.round(r.height),
        pad: cs.padding,
        radius: cs.borderRadius,
        mb: cs.marginBottom,
        gap: cs.gap,
        fs: cs.fontSize,
        align: cs.alignItems,
        justify: cs.justifyContent,
        // 主菜单九行居中（老项目 v8.0.1 起"整组居中"，用户反馈过贴左大片空=失衡）
        firstCentered: Math.abs(
          (els[0].getBoundingClientRect().left + r.width / 2) -
            (window.innerWidth / 2),
        ),
      };
    });
    assert.ok(items.n >= 9, `菜单至少 9 项（老项目 10 项含口令），实得 ${items.n}`);
    assert.equal(items.pad, '9px 12px', `.menu-item 内边距应 9px 12px，实际 ${items.pad}`);
    assert.equal(items.radius, '10px', `圆角应 10px，实际 ${items.radius}`);
    assert.equal(items.mb, '5px', `项间距（margin-bottom）应 5px，实际 ${items.mb}`);
    assert.equal(items.gap, '12px', `图标与文字间距应 12px，实际 ${items.gap}`);
    assert.equal(items.fs, '15px', `字号应 15px，实际 ${items.fs}`);
    assert.equal(items.h, 46, `行高应 46px，实际 ${items.h}`);
    // 🔴🔴 2026-10-07 判据纠错：这条原先断言 42px，注释还写"老项目 v7.0.1 从 48 瘦身" ——
    //   **42 是 bj 自己的 bug 值，不是老项目的值**。本轮同视口并排量化实测（同 Playwright、
    //   同 390×844、同日间模式、逐项读 getBoundingClientRect）：
    //     老项目 .menu-item 行高 46、行顶间隔 51（= 46 + margin-bottom 5）
    //     bj 修复前          行高 42、行顶间隔 55
    //   42 的真因：bj 的菜单视图容器是 `display:flex;flex-direction:column;gap:8px`，
    //   flex 项在 `max-height:min(72vh,560px)` 下被 `flex-shrink:1` **压扁**，
    //   min-height:42px 恰好成了压扁后的下限。老项目是块级容器，行不会被压。
    //   既然用户报的是"间距比老版本大"，判据就该钉老项目的 46 而不是 bj 的 42。
    //   行高是"内容撑出来的"（26 图标 + 9+9 padding + 1+1 border），别去改 min-height。
    assert.equal(items.align, 'center', '图标与文字应纵向居中');
    assert.equal(items.justify, 'center', '主菜单整组应居中（老项目 v8.0.1）');
    // 反向：菜单盒内不许再有 box-x（老项目菜单里从来没有关闭 X）
    assert.equal(
      await page.evaluate(() => !!document.querySelector('.menu-box .box-x')),
      false,
      '菜单盒内不该有 .box-x',
    );
  } finally {
    await page.close();
  }
});

test('VVW-17 🔴 提醒滚轮几何与配色必须与老项目同值（滚轮颜色这条报障）', async () => {
  // 老项目 index.html:235-242 与 bj styles.css:1006 逐字相同：
  // wrap 54x150 / border var(--line) / radius 12px / background var(--box-bg)；
  // mid 绝对定位 left:5px right:5px top:50% height:50px；
  // 中间高亮条上下两条 1.5px solid var(--accent)。
  // 用户报的"右侧的滚轮颜色不一样"若再次出现，先量这四个数再动代码。
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw17', 'pw');
  try {
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rem-wheel-wrap', { timeout: 10_000 });
    const w = await page.evaluate(() => {
      const wrap = document.querySelector('.ns-rem-wheel-wrap');
      const mid = document.querySelector('.ns-rem-wheel-mid');
      const it = document.querySelector('.ns-rem-wheel-it');
      const root = getComputedStyle(document.documentElement);
      const toRgb = (c) => {
        const m = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
        if (!m) return String(c).trim();
        const n = parseInt(m[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      const wrapCs = getComputedStyle(wrap);
      const midCs = mid ? getComputedStyle(mid) : null;
      const itCs = it ? getComputedStyle(it) : null;
      const wr = wrap.getBoundingClientRect();
      return {
        size: [Math.round(wr.width), Math.round(wr.height)],
        radius: wrapCs.borderRadius,
        bgIsToken: wrapCs.backgroundColor,
        bgToken: toRgb(root.getPropertyValue('--box-bg')),
        borderIsToken: wrapCs.borderTopColor,
        lineToken: toRgb(root.getPropertyValue('--line')),
        midBorder: midCs ? midCs.borderTopWidth + ' ' + midCs.borderTopStyle + ' ' + midCs.borderTopColor : null,
        // 🔴 颜色**单独取**：midBorder 那个拼接串里颜色本身含空格，
        //   在 Node 侧切字符串会切坏（见下方断言处的注释）。
        midColor: midCs ? midCs.borderTopColor : null,
        midSize: mid ? [Math.round(mid.getBoundingClientRect().width), Math.round(mid.getBoundingClientRect().height)] : null,
        accentToken: toRgb(root.getPropertyValue('--accent')),
        itSize: it ? [Math.round(it.getBoundingClientRect().width), Math.round(it.getBoundingClientRect().height)] : null,
        itFont: itCs ? itCs.fontSize : null,
        itColor: itCs ? itCs.color : null,
      };
    });
    assert.deepEqual(w.size, [54, 150], `滚轮外框应 54x150，实际 ${w.size}`);
    assert.equal(w.radius, '12px', `圆角应 12px，实际 ${w.radius}`);
    assert.equal(w.bgIsToken, w.bgToken, `底色必须吃 --box-bg 令牌（实测 ${w.bgIsToken} vs 令牌 ${w.bgToken}）`);
    assert.equal(w.borderIsToken, w.lineToken, `描边必须吃 --line 令牌（实测 ${w.borderIsToken}）`);
    assert.deepEqual(w.midSize, [42, 50], `中间高亮条应 42x50，实际 ${w.midSize}`);
    // 🔴🔴 描边宽度必须读**样式表声明文本**，不能读 computed ——
    //   dpr=1 的 Chromium 把 border-width 量化到整数设备像素，声明的 1.5px 会被报成 1px
    //   （本文件文件头第 2 条已记「小数 px 量不到就去看样式表声明文本」，
    //   我第一版仍按 computed 写，于是把 1.5 自己判成 1、红了）。
    const decl = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const r of rules) {
          if (r.selectorText === '.ns-rem-wheel-mid') return r.cssText;
        }
      }
      return null;
    });
    assert.ok(decl, '样式表里应有 .ns-rem-wheel-mid 规则');
    assert.match(decl, /border-top:\s*1\.5px solid/, `上边线声明应为 1.5px，实际 ${decl}`);
    assert.match(decl, /border-bottom:\s*1\.5px solid/, `下边线声明应为 1.5px，实际 ${decl}`);
    assert.match(decl, /var\(--accent\)/, `描边色必须走令牌，实际 ${decl}`);
    // 🔴 配色断言一律**与当前主题令牌比**，不能写死 rgb ——
    //   harness落在夜间主题，写死日间值会恒红（12-visual-brand VIS-02 已记这条）。
    // 🔴 `midBorder` 是「宽 style 颜色」三段拼接，而**颜色里本身带空格**
    //   （`rgb(212, 176, 104)`）—— 我第一版用 `split(' ').pop()` 取末段，
    //   拿到的是 `'104)'`。判据自己写错，报错完全指不到被测的东西。
    //   正确做法：在页面里就把颜色单独取出来比，别在 Node 侧切字符串。
    assert.equal(
      w.midColor,
      w.accentToken,
      `高亮条描边色应吃 --accent 令牌=${w.accentToken}，实际 ${w.midColor}`,
    );
    assert.equal(w.itFont, '15px', `滚轮项字号应 15px，实际 ${w.itFont}`);
    assert.deepEqual(w.itSize, [52, 50], `滚轮项应 52x50（老项目 .rem-wheel-it 高 50），实际 ${w.itSize}`);
  } finally {
    await page.close();
  }
});

test('VVW-18 🔴 二维码配对弹窗的警示与画布几何（弹窗按钮/警示这条报障）', async () => {
  // 老项目 index.html:526-538 与 bj styles.css:1279-1298 逐字相同：
  // .qr-box{text-align:center} / .qr-title 18px 600 / #qrHolder min-height:236px
  // / #qrCanvas radius:12px + 1px var(--line) + 纸白底 / #qrLarge 88vmin + pixelated。
  // 用户报的"扫一扫、二维码配对弹窗下面两个按钮不一样"，量化后确认是**已对齐**；
  // 这条把它钉住，免得下次回归。
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw18', 'pw');
  try {
    await page.click('#qrBtn');
    await page.waitForSelector('#pairMask .qr-box', { timeout: 12_000 });
    const q = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const toRgb = (c) => {
        const m = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
        if (!m) return String(c).trim();
        const n = parseInt(m[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      const box = document.querySelector('#pairMask .qr-box');
      const title = document.querySelector('#pairMask .qr-title');
      const holder = document.querySelector('#qrHolder');
      const canvas = document.querySelector('#qrCanvas');
      const warn = document.querySelector('#pairMask .ns-qr-warn');
      const closeBtn = document.querySelector('#pairMask .box-x');
      const boxCs = getComputedStyle(box);
      const titleCs = title ? getComputedStyle(title) : null;
      const holderCs = holder ? getComputedStyle(holder) : null;
      const canvasCs = canvas ? getComputedStyle(canvas) : null;
      const warnCs = warn ? getComputedStyle(warn) : null;
      const closeCs = closeBtn ? getComputedStyle(closeBtn) : null;
      return {
        boxAlign: boxCs.textAlign,
        titleFont: titleCs ? titleCs.fontSize : null,
        titleWeight: titleCs ? titleCs.fontWeight : null,
        titleLs: titleCs ? titleCs.letterSpacing : null,
        holderMinH: holderCs ? holderCs.minHeight : null,
        holderMb: holderCs ? holderCs.marginBottom : null,
        canvasRadius: canvasCs ? canvasCs.borderRadius : null,
        canvasBg: canvasCs ? canvasCs.backgroundColor : null,
        paperToken: toRgb(root.getPropertyValue('--qr-paper')),
        warnFont: warnCs ? warnCs.fontSize : null,
        warnColor: warnCs ? warnCs.color : null,
        dangerToken: toRgb(root.getPropertyValue('--danger')),
        mutedToken: toRgb(root.getPropertyValue('--muted')),
        warnLines: warn ? Math.round(warn.getBoundingClientRect().height / parseFloat(getComputedStyle(warn).lineHeight)) : null,
        hasCloseBtn: !!closeBtn,
        closeSize: closeBtn ? [Math.round(closeBtn.getBoundingClientRect().width), Math.round(closeBtn.getBoundingClientRect().height)] : null,
        hasCloseIcon: !!closeBtn?.querySelector('svg'),
        closeStroke: closeBtn?.querySelector('svg')
          ? getComputedStyle(closeBtn.querySelector('svg')).strokeWidth
          : null,
        btnCount: document.querySelectorAll('#pairMask button').length,
        // 底部关闭键（老项目 `button#qrClose`，无 class）
        closeBtnText: document.getElementById('qrClose')?.textContent ?? '',
        closeBtnW: Math.round(document.getElementById('qrClose')?.getBoundingClientRect().width ?? 0),
        closeBtnH: Math.round(document.getElementById('qrClose')?.getBoundingClientRect().height ?? 0),
        closeBtnUsesBoxRule: (() => {
          const b = document.getElementById('qrClose');
          if (!b) return false;
          const cs = getComputedStyle(b);
          // `.box button:not(.box-x)` 是通栏实底（老项目 :516）；若被改成透明胶囊就是没吃这条
          return cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.width !== 'auto';
        })(),
      };
    });
    assert.equal(q.boxAlign, 'center', '.qr-box 应 text-align:center');
    assert.equal(q.titleFont, '18px', `标题应 18px，实际 ${q.titleFont}`);
    assert.equal(q.titleWeight, '600', `标题应 600，实际 ${q.titleWeight}`);
    assert.equal(q.titleLs, '0.36px', `标题字距应 .02em=0.36px，实际 ${q.titleLs}`);
    assert.equal(q.holderMinH, '236px', `码区最小高应 236px，实际 ${q.holderMinH}`);
    assert.equal(q.holderMb, '12px', `码区下边距应 12px，实际 ${q.holderMb}`);
    assert.equal(q.canvasRadius, '12px', `码圆角应 12px，实际 ${q.canvasRadius}`);
    assert.equal(q.canvasBg, q.paperToken, `码底色应吃 --qr-paper 令牌（实测 ${q.canvasBg}）`);
    // 🔴🔴 2026-10-07 判据纠错：这两条原先断言「警示 12px / 颜色 = --danger」，
    //   抄的是老项目 index.html:537 `.qr-warn{font-size:12px;color:#C0453E}`
    //   **的字面**。同视口并排量化实测**老项目自己的** `#qrMask .qr-warn`：
    //     font-size 13px / color rgb(152,149,138)=--muted / line-height 22.1px(=1.7) / margin 0 0 14px
    //   —— `.qr-warn`(0,1,0) 被 `.box p`(0,1,1) 压掉了：`.box p{font-size:13px;
    //     color:var(--muted);margin:0 0 20px;line-height:1.7}` 在 :512、`.qr-box p`
    //     在 :528 又把 margin 改回 14px。也就是说 **`.qr-warn` 的字号与颜色在老项目里是死规则**。
    //   （同款死规则还有 `.box button.ghost-btn`，见 visual-parity 的 VP-06。）
    //   ⇒ 判据必须钉实测值。用户报障第 4 条「配对弹窗文案字体大小、颜色和老版本不同」
    //   的正解就是回到这个实测值，而不是回到那条死规则。
    assert.equal(q.warnFont, '13px', `警示字号应 13px（老项目实测；其 .qr-warn 的 12px 是死规则），实际 ${q.warnFont}`);
    assert.equal(q.warnColor, q.mutedToken, `警示颜色应吃 --muted（老项目实测 ${q.warnColor}）`);
    assert.notEqual(
      q.warnColor,
      q.dangerToken,
      '警示**不是** --danger：老项目的 .qr-warn 颜色被 .box p 压掉，实际渲染为 muted',
    );
    // 🔴🔴 反向钉死（我第一版把方向写反了，被判据自己抓出来）：
    //   老项目 `index.html:771-780` 的**扫码配对面板没有右上角 X** ——
    //   结构是 `.box.qr-box > h1.qr-title + p + #qrHolder + p.qr-warn + button#qrClose`，
    //   退出只有底部那个「关 闭」按钮。
    //   （有 `.box-x` 的是 `#remPanel` 那个**提醒**面板，见 index.html:679。）
    //   我写判据时凭"弹窗就该有关闭键"的常识写了 `assert.ok(hasCloseBtn)`，
    //   结果第一条就红 —— 是**判据**错，不是产品错。教训与"菜单那个 X"同源：
    //   「该有/不该有」必须查老项目源码，不能凭常识。
    assert.equal(
      q.hasCloseBtn,
      false,
      '扫码配对面板不该有右上角 .box-x（老项目 :771-780 只有底部「关 闭」按钮）',
    );
    // 底部关闭键必须在（老项目 `button#qrClose`）
    assert.equal(q.btnCount, 1, `配对面板应只有 1 个按钮（关 闭），实际 ${q.btnCount}`);
    assert.ok(q.closeBtnText.length > 0, '底部关闭键必须有文案');
    assert.ok(
      q.closeBtnW > 0 && q.closeBtnH >= 44,
      `关闭键触控区应 ≥44px 高（顶栏触控区纪律），实际 ${q.closeBtnW}x${q.closeBtnH}`,
    );
    assert.equal(
      q.closeBtnUsesBoxRule,
      true,
      '关闭键必须吃 `.box button` 的通栏规则（老项目 :516 同款），不许自定义成小胶囊',
    );
  } finally {
    await page.close();
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * 两条「被更特异规则吃掉」的样式（用户报障：历史预览 / 提醒关闭钮颜色）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 🔴🔴🔴 VVW-19 历史版本「预览」展开的文本框必须**换行到按钮下方独占一行**。
 *
 * 现象（用户报障第 3 条）：老版本点预览后，按钮**下方**出现一个带滚动条的文本框；
 * bj 的预览块挤在时间戳右边，被压成窄窄一条。
 *
 * 🔴 根因是 `.list-row` 缺 `flex-wrap: wrap`：
 *   老项目 index.html:465 `.hist-item{display:flex;flex-wrap:wrap;align-items:center;…}`
 *   —— `flex-wrap:wrap` 是 `width:100%` 能换行的**唯一前提**。
 *   bj 的 `.list-row`（styles.css:960）只有 `display:flex`，没有 wrap，
 *   于是 `.hist-preview{width:100%}` 不是"占满一行"，而是"在当行里被 flex 压扁"。
 *
 * 🔴 量化实测（390×844，同一结构分别挂到两套真实样式表内，读 getBoundingClientRect）：
 *   老项目：flex-wrap=wrap，hist-preview 宽 = 容器全宽（390）
 *   bj 改前：flex-wrap=nowrap，hist-preview 宽 = 263.39（被压到不足 2/3）
 *
 * 🔴🔴 判据必须钉**用户可见的最终结果**（预览块的 top 与按钮行的 bottom 关系、
 *   以及宽度接近容器宽），不能只钉 `flex-wrap` 这个实现值 ——
 *   钉实现值的话，"把预览改成绝对定位"也能变绿，而那显然不是老项目。
 */
test('VVW-19 🔴🔴 历史预览文本框必须换行独占一行（老项目 flex-wrap:wrap）', async () => {
  // 🔴 时钟钉死：提醒快照要"非空正文"，而断言里不出现任何依赖真实时钟的值。
  //   固定在 2026-10-05 14:00，下面的相对日判断才在本地/UTC 下同一结论。
  const page = await openEditorAt(h.browser(), h.baseUrl(), 'vvw19', 'pw', {
    iso: '2026-10-05T14:00:00+08:00',
  });
  try {
    // 🔴🔴 先敲正文再开菜单：菜单是遮罩，开着时 `.ns-editor` 虽然在 DOM 里、
    //   但**点不到**（Playwright 报 'element is not visible'，等 30s 超时）。
    //   症状看起来像"编辑器坏了"，实际是遮罩挡着 —— 与判据本身无关。
    await page.click('.ns-editor');
    await page.keyboard.type('第一行正文第二行正文第三行正文第四行正文');
    await page.waitForTimeout(400);

    await openMenu(page);
    await page.click('#menuHistEntry');
    await page.waitForSelector('#histSave', { timeout: 10_000 });
    await page.click('#histSave');
    await page.waitForSelector('.list-row[data-at]', { timeout: 10_000 });

    await page.waitForSelector('.list-row[data-at] [data-preview]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.click('.list-row[data-at] [data-preview]');
    await page.waitForSelector('.list-row[data-at] .hist-preview', { timeout: 10_000 });
    await page.waitForTimeout(300);

    const g = await page.evaluate(() => {
      const row = document.querySelector('.list-row[data-at]');
      const pv = row.querySelector('.hist-preview');
      const btns = row.querySelector('.hist-btns');
      const rowCs = getComputedStyle(row);
      const pvCs = getComputedStyle(pv);
      const pvR = pv.getBoundingClientRect();
      const rowR = row.getBoundingClientRect();
      const btnR = btns.getBoundingClientRect();
      // 内容盒（去掉 padding 与 border）
      const innerW = rowR.width - 24 - 2; // 左右 padding 12+12 + 左右 border 1+1
      return {
        rowWrap: rowCs.flexWrap,
        pvW: pvR.width,
        innerW,
        pvTop: pvR.top,
        btnBottom: btnR.bottom,
        maxH: pvCs.maxHeight,
        overflowY: pvCs.overflowY,
      };
    });

    // 🔴 主判据：预览块必须落在按钮行**下方**（换行独占一行）
    assert.ok(
      g.pvTop >= g.btnBottom - 1,
      `预览块必须换行到按钮下方（老项目 flex-wrap:wrap）。` +
      `实测 pvTop=${g.pvTop.toFixed(1)} btnBottom=${g.btnBottom.toFixed(1)}，rowWrap=${g.rowWrap}。` +
      `挤在同行时用户看到的就是"时间戳右边一条窄文本"，不是老版本的下方文本框。`,
    );
    // 🔴 宽度判据：预览块**边框盒**宽应等于行内容宽（老项目 width:100%）。
    //   ⚠️ 比的是 border-box 宽度，不是"内容宽"：`.hist-preview` 自己有
    //   `padding:9px 12px` + `border-left:2px`，把它的 border-box 宽再减内距
    //   去比行宽，会永远差 26px —— 我第一版就这么写，红了才发现是自己算错。
    //   两边都 box-sizing:border-box（`* { box-sizing: border-box }`），可直接比。
    assert.ok(
      g.pvW >= g.innerW - 1,
      `预览块应占满行内容宽（老项目 width:100%）。实测 pvW=${g.pvW.toFixed(1)} innerW=${g.innerW.toFixed(1)}，rowWrap=${g.rowWrap}。`,
    );
    // 🔴 滚动条：长版本必须可滚（老项目 max-height:120px + overflow-y:auto）
    assert.equal(g.maxH, '120px', `预览块限高应120px（老项目同值），实测 ${g.maxH}`);
    assert.equal(g.overflowY, 'auto', '预览块必须可滚（老项目 overflow-y:auto）');
  } finally {
    await page.close();
  }
});

/**
 * 🔴🔴🔴 VVW-20 提醒面板「已添加提醒」那行的关闭钮颜色/字号/边框必须与老项目逐值同。
 *
 * 现象（用户报障第 4 条）：bj 的关闭钮是**深底白字的大按钮**，老项目是
 * **透明底 + 深字 + 一圈浅灰细描边的小胶囊**。
 *
 * 🔴 根因（量化实测，读命中该元素的全部规则）：bj 的 `.ns-rem-off` 只有
 *   **(0,1,0)**，而弹窗通栏按钮规则 `.box button:not(.box-x)` 是 **(0,2,1)**
 *   ⇒ 声明被**结构性压过**，渲染成 bg=--fg / color=--bg / font-size:15px /
 *   padding:0 14px / border-radius:10px。
 *   老项目靠 `#remBoxList .rem-row button`（含 ID，**(1,2,1)**）压过同款通栏规则，
 *   所以拿到自己的小胶囊样式。bj 没有 ID 级选择器，就没这个保护。
 *
 * 🔴 老项目真机实测金标（390×844，读 computed，不是读源码）：
 *   color=rgb(28,28,26)  background=transparent  border=1px rgb(236,234,226)
 *   font-size=12px  line-height=normal  padding=4px 12px  border-radius=8px
 *
 * 🔴 用令牌比对而不是写死 rgb：harness 可能落在夜间主题（见本文件头部纪律第 1 条）。
 */
test('VVW-20 🔴🔴 提醒已设行的关闭钮必须是小胶囊（被通栏按钮规则吃掉这条）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'vvw20', 'pw');
  try {
    // 🔴🔴 走**提醒面板**加这一条，不走 chip。
    //   我第一版在正文敲 `12-31 10:00` 等 chip 弹出来，5 秒/10 秒两次超时。
    //   真因不是提醒坏了，是 `time-parse` 的短格式 `reShort`
    //   （`(\d{1,2})[-/](\d{1,2})[ T　](\d{1,2}):(\d{2})`）**一律按今年解析**，
    //   而"今年 12-31"在本机时钟（2026-10）看着是未来… 但探针跑的时候
    //   页面时钟已被 harness 的其它用例影响，实测取到的是已过期分支 ⇒ chip 不浮。
    //   ⇒ 这条判据要钉的是**关闭钮的样式**，造提醒的路径必须选**确定能成**的那条：
    //   面板「添加」默认填当前 +5 分钟（同款被 REM-07/REM-08 钉过），不依赖任何时间串解析。
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 10_000 });
    await page.fill('.ns-rem-input', '买菜和水果');
    await page.click('.ns-rem-add');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 1, { timeout: 5000 }),
      6000, '等提醒进真源',
    );
    // 重开面板看已设行
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rem-off', { state: 'visible', timeout: 10_000 });

    const g = await page.evaluate(() => {
      const off = document.querySelector('.ns-rem-off');
      if (!off) return { missing: true };
      const cs = getComputedStyle(off);
      const root = getComputedStyle(document.documentElement);
      const toRgb = (c) => {
        const m = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
        if (!m) return String(c).trim();
        const n = parseInt(m[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${(n >> 255) & 255})`.replace(
          `${(n >> 8) & 255}, ${(n >> 255) & 255}`,
          `${(n >> 8) & 255}, ${n & 255}`,
        );
      };
      const r = off.getBoundingClientRect();
      return {
        // 🔴 关键判据：文字色必须与弹窗通栏按钮**相反**
        //   （通栏是 color:var(--bg) 浅字深底；关闭钮是老项目的小胶囊 = color:var(--fg) 深字）
        color: cs.color,
        bg: cs.backgroundColor,
        fg: toRgb(root.getPropertyValue('--fg')),
        bgTok: toRgb(root.getPropertyValue('--bg')),
        borderColor: cs.borderTopColor,
        line: toRgb(root.getPropertyValue('--line')),
        borderW: cs.borderTopWidth,
        fs: cs.fontSize,
        lh: cs.lineHeight,
        pad: cs.padding,
        radius: cs.borderRadius,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
    assert.ok(!g.missing, '提醒面板里应有已添加行的关闭钮（.ns-rem-off）');

    // 🔴 1) 文字色必须是 --fg（深），不是 --bg（浅）。这一条最直击"颜色不一样"。
    assert.equal(g.color, g.fg,
      `关闭钮文字色必须是 --fg（老项目 :283 color:var(--fg)），实测 ${g.color}，fg=${g.fg}。` +
      `被 .box button:not(.box-x) 压过时会变成 --bg（浅）——那正是"深底白字大按钮"的来源。`);
    // 🔴 2) 背景必须透明（老项目 background:none）
    assert.ok(g.bg === 'transparent' || g.bg === 'rgba(0, 0, 0, 0)',
      `关闭钮背景必须透明（老项目 background:none），实测 ${g.bg}`);
    // 🔴 3) 一圈 1px 浅灰描边（老项目 border:1px solid var(--line)）
    assert.equal(g.borderW, '1px', `关闭钮描边应 1px（老项目同值），实测 ${g.borderW}`);
    assert.equal(g.borderColor, g.line,
      `关闭钮描边色必须是 --line，实测 ${g.borderColor}，line=${g.line}`);
    // 🔴 4) 字号/内距/圆角逐值（老项目 :283 font-size:12px; padding:4px 12px; border-radius:8px）
    assert.equal(g.fs, '12px', `关闭钮字号应 12px（老项目同值），实测 ${g.fs}（被压过会变 15px）`);
    assert.equal(g.pad, '4px 12px', `关闭钮内距应 4px 12px，实测 ${g.pad}（被压过会变 0px 14px）`);
    assert.equal(g.radius, '8px', `关闭钮圆角应 8px，实测 ${g.radius}（被压过会变 10px）`);
    // 🔴 5) 高度量级：小胶囊约 28px，通栏按钮是 46px
    assert.ok(g.h <= 34,
      `关闭钮应是小胶囊（高 ≤34px），实测 ${g.h}px —— 46px 说明吃的是弹窗通栏按钮规则`);
  } finally {
    await page.close();
  }
});

/**
 * ============================================================================
 * 21 / 22 / 23 —— 落地页（用户报障第 6 条）
 * ============================================================================
 *
 * 🔴🔴🔴 本组三条的根因是**同一个**：`pages.ts` 末尾的 `input.focus()`。
 *
 *   老项目 `index.html` 全文 `grep '\.focus()'` 共 39 处，**没有一处是落地页输入框**
 *   （`li` 只在 :10163 被 `getElementById` 取出来，从不 focus）。
 *   bj `pages.ts:114` 有 `input.focus()`（注释写"老项目也这样"——**这句是错的**）。
 *
 *   连锁后果有两条，都不是"样式没抄"，而是行为被这一行改掉了：
 *     ① 落地页一进来就触发 `focus` 事件 → `#landing` 挂上 `.trust-away`
 *        → `.trust{opacity:0}` ⇒ **"服务器只见密文/无需账号/扫码跨设备"三行永久不可见**。
 *        这就是用户说的"这三个文案和对应图标没出现"。
 *        （老项目的淡出是**聚焦时**才发生，且软键盘弹出才需要让位；
 *          bj 一进来就聚焦 ⇒ 一进来就淡出，键盘还没弹就先没了。）
 *     ② 入场动画 `rise` 的 `both` fill-mode 与 `.trust` 的 `animation-fill-mode:backwards`
 *        是一对；少了动画时 `.trust` 那条 `backwards` 是空转。
 *
 *   判据钉的是**用户可见的最终结果**（三行文案真的可见 / 真的逐级延迟出现），
 *   不是钉"有没有调 focus()"——后者会把"改成 focus 时机"也算绿。
 */

/**
 * 打开落地页（未解锁），钉住视口 390×844 与老项目量化同视口。
 * 🔴 必须走**根路径** `/`：带笔记名（`/vvw21`）会被路由直接送进口令页，
 *   落地页根本不渲染 ⇒ `waitForSelector('#li')` 15s 超时（VVW-15 同款做法）。
 */
async function openLanding(browser, baseUrl) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await withTimeout(page.waitForSelector('#li'), 15_000, '等落地页');
  return page;
}

test('VVW-21 🔴🔴🔴 落地页必须逐级淡入上移（老项目 rise 动画），且不得一进来就把信任行淡出', async () => {
  // 老项目 index.html:550-559 + :586
  //   #landing>*{animation:rise .7s cubic-bezier(.2,.7,.3,1) both}
  //   #landing>*:nth-child(2){animation-delay:.06s} … :nth-child(9){animation-delay:.48s}
  //   @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  const page = await openLanding(h.browser(), h.baseUrl());
  try {
    // 🔴🔴 动画判定必须**等动画跑完再读终值**。
    //   我第一版在 goto 后立刻读 opacity，拿到的是 0.164427（rise 的中间帧），
    //   报红信息写的是"挂着 .trust-away"——**判据自己写错了，症状与真因无关**。
    //   ⇒ 这里等 `getAnimations()` 全部 finish（超时兜底），再读终态。
    await page.evaluate(() => Promise.all(
      Array.from(document.getAnimations()).map((a) => a.finished.catch(() => {})),
    )).catch(() => {});
    await page.waitForTimeout(150);

    const g = await page.evaluate(() => {
      // 🔴 不写逗号选择器：`#landing .a, #landing .b` 返回**文档顺序第一个命中任一分支**的元素
      //   （本文件头部纪律），这里要的是全部子节点，逐个读。
      const kids = Array.from(document.querySelectorAll('#landing .landing-in > *'));
      const cs = (e) => getComputedStyle(e);
      const trust = document.querySelector('#landing .trust');
      return {
        n: kids.length,
        tags: kids.map((e) => e.tagName + '.' + (e.className || e.id)),
        animNames: kids.map((e) => cs(e).animationName),
        animDelays: kids.map((e) => cs(e).animationDelay),
        animDur: kids.length ? cs(kids[0]).animationDuration : '',
        animTiming: kids.length ? cs(kids[0]).animationTimingFunction : '',
        trustOpacity: trust ? cs(trust).opacity : null,
        landingClasses: document.getElementById('landing')?.className ?? null,
        // 关键行为证据：一进来焦点就该在 body（老项目从不 focus 落地页输入框）
        activeId: document.activeElement ? document.activeElement.id : '',
      };
    });

    // 🔴 1) 三行信任文案必须**真的可见** —— 这是用户报障的原话
    //   （"这三个文案和对应图标没出现"）。
    assert.equal(
      g.trustOpacity, '1',
      `信任行三行文案（服务器只见密文/无需账号/扫码跨设备）必须可见（动画结束后），` +
      `实测 opacity=${g.trustOpacity}，#landing class="${g.landingClasses}"。` +
      `opacity 0 = 挂着 .trust-away —— bj pages.ts 末尾曾有 input.focus()，一进来就触发 focus 事件；` +
      `老项目全文 39 处 .focus() 无一处是落地页输入框。`,
    );
    assert.ok(
      !/\btrust-away\b/.test(String(g.landingClasses)),
      `落地页初始不得带 .trust-away（那是"聚焦输入时"的让位态），实测 class="${g.landingClasses}"`,
    );
    assert.notEqual(
      g.activeId, 'li',
      `落地页刚打开时焦点不该落在输入框上（老项目从不 focus 它），实测 activeElement=#${g.activeId}` +
      ` —— 这同时也是移动端一进落地页就弹软键盘的来源`,
    );

    // 🔴 2) 逐级入场：每个直接子节点都要有 rise 动画
    assert.ok(g.n >= 9, `落地页 .landing-in 子节点应 ≥9（老项目 9 个），实测 ${g.n}：${JSON.stringify(g.tags)}`);
    for (let i = 0; i < g.n; i++) {
      assert.equal(
        g.animNames[i], 'nsLandingRise',
        `第 ${i + 1} 个子节点（${g.tags[i]}）animation-name 应为 nsLandingRise` +
        `（值逐字等于老项目 rise），实测 "${g.animNames[i]}" —— 没有它就是"刷新时从上到下依次出现"整条缺失。` +
        `⚠️ 注意不能只断言"声明在"：display:contents 的元素动画无效果，判据必须逐个子节点读。`,
      );
    }
    assert.equal(g.animDur, '0.7s', `入场动画时长应 0.7s（老项目同值），实测 ${g.animDur}`);
    assert.match(
      g.animTiming, /cubic-bezier\(0\.2, 0\.7, 0\.3, 1\)/,
      `入场缓动应 cubic-bezier(.2,.7,.3,1)（老项目同值），实测 ${g.animTiming}`,
    );

    // 🔴 3) 逐级延迟 0 / .06 / .12 …，且**必须单调不减**。
    //   🔴 为什么不逐个钉死具体值：老项目用 `:nth-child(n)` 步进，而 bj 比老项目多一个
    //   内部用的 #landingScanMsg 警示位（老项目 grep landingScanMsg = 0 命中），
    //   所以纯 nth-child 会把 .trust 推成 .54s。老项目"最后一行可见元素"的步进是 .48s
    //   —— 那是用户眼睛看到的节奏，所以实现选择把 .trust 钉回 .48s（见 styles.css）。
    //   ⇒ 判据钉「单调不减 + 首项 0s + 末项 .48s」，这三条合起来就锁住了"从上到下依次出现"，
    //   又不会因为内部多一个不可见节点而误红。
    const delays = g.animDelays.map((d) => parseFloat(d));
    assert.equal(delays[0], 0, `第一个子节点不应延迟（老项目 :nth-child(1) 无 delay），实测 ${g.animDelays[0]}`);
    for (let i = 1; i < delays.length; i++) {
      assert.ok(
        delays[i] >= delays[i - 1],
        `入场延迟必须单调不减（自上而下依次出现），第 ${i + 1} 项 ${g.animDelays[i]} < 第 ${i} 项 ${g.animDelays[i - 1]}`,
      );
    }
    assert.ok(
      Math.abs(delays[delays.length - 1] - 0.48) < 0.001,
      `最后一行可见元素的延迟应 .48s（老项目 :nth-child(9) 的步进值 = 用户看到的收尾节奏），` +
      `实测 ${g.animDelays[delays.length - 1]}`,
    );
  } finally {
    await page.close();
  }
});

test('VVW-22 🔴🔴 网址预览行必须逐值同老项目 .urlline，且笔记名是金黄加粗', async () => {
  // 老项目 index.html:583-584
  //   #landing .urlline{color:var(--muted);font-size:12.5px;margin:16px 0 0;
  //                   line-height:1.7;letter-spacing:.03em;max-width:340px;word-break:break-all}
  //   #landing .urlline .u-name{color:var(--accent);font-weight:600;letter-spacing:.02em}
  // bj 改前实测（探针 _probe_out5.json）：
  //   font-size:12px / letter-spacing:normal / line-height:19.2px / margin-top:10px / max-width:none
  //   且整行是**单一纯文本**，没有金黄 span
  const page = await openLanding(h.browser(), h.baseUrl());
  try {
    // 初始：整行必须隐身（老项目 :639 `class="urlline hidden"`）——
    // 反向断言：不能一进来就闪一行光杆域名。
    assert.equal(
      await page.evaluate(() => document.getElementById('landingUrl').classList.contains('hidden')),
      true,
      '网址行初始必须 hidden（老项目 index.html:639 带 hidden），空输入不该闪光杆域名',
    );
    await page.fill('#li', 'my_note-1');
    await withTimeout(
      page.waitForFunction(() => !document.getElementById('landingUrl').classList.contains('hidden'), { timeout: 3000 }),
      4000, '输入合法名后网址行应显形',
    );

    const g = await page.evaluate(() => {
      const toRgb = (c) => {
        const m = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
        if (!m) return String(c).trim();
        const n = parseInt(m[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      const row = document.getElementById('landingUrl');
      const nameSpan = document.getElementById('landingUrlName');
      const cs = getComputedStyle(row);
      const root = getComputedStyle(document.documentElement);
      return {
        fs: cs.fontSize,
        lh: cs.lineHeight,
        ls: cs.letterSpacing,
        mt: cs.marginTop,
        maxW: cs.maxWidth,
        color: cs.color,
        muted: toRgb(root.getPropertyValue('--muted')),
        wb: cs.wordBreak,
        rowText: row.textContent,
        // 金黄 span
        hasNameSpan: !!nameSpan,
        nameText: nameSpan ? nameSpan.textContent : '',
        nameColor: nameSpan ? getComputedStyle(nameSpan).color : '',
        nameFw: nameSpan ? getComputedStyle(nameSpan).fontWeight : '',
        nameLs: nameSpan ? getComputedStyle(nameSpan).letterSpacing : '',
        accent: toRgb(root.getPropertyValue('--accent')),
      };
    });

    assert.equal(g.fs, '12.5px', `网址行字号应 12.5px（老项目同值），实测 ${g.fs}（12px 会让整行小一号）`);
    assert.equal(g.lh, '21.25px', `网址行行高应 21.25px（12.5×1.7），实测 ${g.lh}`);
    assert.equal(g.ls, '0.375px', `网址行字距应 0.375px（.03em×12.5），实测 ${g.ls} —— 用户报障「字体间距不一样」`);
    assert.equal(g.mt, '16px', `网址行上外距应 16px（老项目同值），实测 ${g.mt}`);
    assert.equal(g.maxW, '340px', `网址行限宽应 340px（老项目同值），实测 ${g.maxW}`);
    assert.equal(g.wb, 'break-all', `网址行应 word-break:break-all（老项目同值），实测 ${g.wb}`);
    assert.equal(g.color, g.muted, `网址行文字色应 --muted，实测 ${g.color}`);

    // 🔴 金黄笔记名：这条是用户报障里点名的「老版本笔记名是金黄色」
    assert.ok(g.hasNameSpan,
      `网址行里必须有独立笔记名 span（老项目 #landingUrlName.u-name），实测无 —— ` +
      `整行单一纯文本时笔记名只能是 muted 灰，正是"笔记名不是金黄色"的来源`);
    assert.equal(g.nameText, 'my_note-1', `金黄 span 只装笔记名，实测 "${g.nameText}"`);
    assert.equal(g.nameColor, g.accent,
      `笔记名必须是 --accent 金黄（老项目 .urlline .u-name），实测 ${g.nameColor}，accent=${g.accent}`);
    assert.equal(g.nameFw, '600', `笔记名字重应 600（老项目同值），实测 ${g.nameFw}`);
    assert.equal(g.nameLs, '0.25px', `笔记名字距应 0.25px（.02em×12.5），实测 ${g.nameLs}`);

    // 反向：整行文案仍要完整（老项目 `你的笔记网址为：&nbsp;<域名>/<笔记名>`）
    assert.match(g.rowText, /你的笔记网址为：/, `网址行文案应含前缀，实测 "${g.rowText}"`);
  } finally {
    await page.close();
  }
});

test('VVW-23 🔴 信任行三段结构与几何（老项目 #landing .trust > span）', async () => {
  // 老项目 index.html:586-588
  //   #landing .trust{position:absolute;left:0;right:0;bottom:44px;
  //     bottom:calc(44px + env(safe-area-inset-bottom));display:flex;justify-content:center;
  //     color:var(--muted);font-size:11.5px;letter-spacing:.05em;
  //     transition:opacity .25s;animation-fill-mode:backwards}
  //   #landing .trust>span{display:flex;flex-direction:column;align-items:center;
  //     gap:7px;margin:0 13px}
  //   #landing .trust svg{width:17px;height:17px;color:var(--muted);display:block}
  //
  // 🔴 bj 改前：`.trust` 下有 **6 个 span**（每项是"外层 span 套一个纯文字 span"），
  //   老项目是 **3 个**（svg + 裸文字直接挂在外层 span 里）。
  //   结构差异本身不算 bug，但多出来的内层 span 会被 `.trust > span` 的
  //   column + gap:7px 变成"文字行自己又是一个 flex item" ⇒ 图标与文字间距多一层。
  const page = await openLanding(h.browser(), h.baseUrl());
  try {
    const g = await page.evaluate(() => {
      const trust = document.querySelector('.trust');
      if (!trust) return { missing: true };
      const cs = getComputedStyle(trust);
      const spans = Array.from(trust.children);
      return {
        n: spans.length,
        fs: cs.fontSize,
        ls: cs.letterSpacing,
        justify: cs.justifyContent,
        pos: cs.position,
        fill: cs.animationFillMode,
        // 每项：外层 span 内应恰好 1 个 svg + 1 个裸文字节点（老项目结构）
        perItem: spans.map((s) => ({
          tag: s.tagName,
          svgCount: s.querySelectorAll('svg').length,
          childKinds: Array.from(s.childNodes).map((n) =>
            n.nodeType === 3 ? 'text' : n.nodeType === 1 ? n.tagName : String(n.nodeType)),
          text: s.textContent.trim(),
          gap: getComputedStyle(s).gap,
          margin: getComputedStyle(s).margin,
        })),
        svgW: (() => { const s = trust.querySelector('svg'); return s ? parseFloat(getComputedStyle(s).width) : -1; })(),
      };
    });
    assert.ok(!g.missing, '落地页应有 .trust 信任行');
    assert.equal(g.n, 3, `信任行应是 3 项（老项目 3 个 span），实测 ${g.n} 个子元素`);
    assert.equal(g.fs, '11.5px', `信任行字号应 11.5px（老项目同值），实测 ${g.fs}`);
    assert.equal(g.ls, '0.575px', `信任行字距应 0.575px（.05em×11.5），实测 ${g.ls}`);
    assert.equal(g.justify, 'center', `信任行应 justify-content:center（老项目同值），实测 ${g.justify}`);
    assert.equal(g.pos, 'absolute', `信任行应 position:absolute 贴底（老项目同值），实测 ${g.pos}`);
    assert.equal(g.fill, 'backwards',
      `信任行 animation-fill-mode 必须是 backwards（老项目 v7.9.1 闸R2/R3：` +
      `rise 的 both 会把 to 帧 opacity:1 永久锁死、压过聚焦淡出），实测 ${g.fill}`);
    assert.equal(g.svgW, 17, `信任行图标应 17px（老项目同值），实测 ${g.svgW}`);
    // 三项文案逐字
    assert.deepEqual(
      g.perItem.map((x) => x.text),
      ['服务器只见密文', '无需账号', '扫码跨设备'],
      `信任行三段文案必须逐字是老项目原文，实测 ${JSON.stringify(g.perItem.map((x) => x.text))}`,
    );
    // 🔴 反向断言：每项内部不得有多余包裹 span（老项目是 svg + 裸文字）
    for (const [i, it] of g.perItem.entries()) {
      assert.equal(it.svgCount, 1, `第 ${i + 1} 项应有且仅有 1 个 svg，实测 ${it.svgCount}`);
      assert.ok(
        !it.childKinds.includes('SPAN'),
        `第 ${i + 1} 项内不得再套 span（老项目是 svg + 裸文字直接挂外层 span），` +
        `实测子节点 ${JSON.stringify(it.childKinds)} —— 多一层 span 会被 column+gap 多加一层间距`,
      );
      assert.equal(it.gap, '7px', `第 ${i + 1} 项图标与文字间距应 7px（老项目 gap:7px），实测 ${it.gap}`);
      assert.equal(it.margin, '0px 13px', `第 ${i + 1} 项左右外距应 13px（老项目同值），实测 ${it.margin}`);
    }
  } finally {
    await page.close();
  }
});

/**
 * ============================================================================
 * 24 —— 落地页「警示行 / 彩蛋提示行 / 扫码入口」的间距与配色
 * ============================================================================
 *
 * 用户报障第 6 条里「按钮、图标、元素大小、文案、颜色、位置、字体和老版本不一样」
 * 这一句，拆开逐值比对后落在下面三处**声明缺失**上（老项目 index.html 原文）：
 *
 *   #landing .warn{color:#C0453E;font-size:12px;margin:14px 0 0;letter-spacing:.04em}
 *     bj `.warn{margin-top:8px; font-size:12px; color:var(--danger)}`
 *     ⇒ 差：上外距 8 vs 14、**整行无字距**。
 *
 *   #landing .scan-row{margin:26px 0 0}
 *     bj 直接把 `.lscan` 挂在 `.landing-in` 下，**没有任何 26px 上边距**
 *     ⇒ 扫码胶囊紧贴上一行 —— 这正是"位置不一样"最显眼的一处。
 *
 *   #landing .eggtip{margin:12px 0 0;max-width:340px;width:100%;font-size:11px;
 *                     line-height:1.7;letter-spacing:.04em;color:var(--muted)}
 *   #landing .eggtip b{color:var(--accent);font-weight:600}
 *     bj `.legghint{margin-top:4px;font-size:12px;color:var(--accent);min-height:1em}`
 *     ⇒ 差：字号 12 vs 11、行高 normal vs 1.7、无字距/无限宽、
 *       **整行金黄**（老项目是 muted 灰，只有<b>门牌名</b>是金黄 600），
 *       以及用 min-height 硬撑空行（老项目初始 hidden，压根不占位）。
 */

/** 读样式表里命中该元素的全部规则（探针同款手法，用来定位"被谁吃掉"）。 */
const rulesOf = `((el) => {
  const out = [];
  for (const ss of Array.from(document.styleSheets)) {
    let rules; try { rules = ss.cssRules; } catch (e) { continue; }
    for (const r of Array.from(rules)) {
      if (!r.selectorText) continue;
      let m = false;
      try { m = el.matches(r.selectorText); } catch (e) { m = false; }
      if (m) out.push(r.selectorText);
    }
  }
  return out;
})`;

test('VVW-24 🔴 落地页警示行/彩蛋提示行/扫码入口的间距与配色必须逐值同老项目', async () => {
  const page = await openLanding(h.browser(), h.baseUrl());
  try {
    // ① 警示行：先造出"中文被净化"的场景
    await page.fill('#li', '我的笔记');
    await withTimeout(
      page.waitForFunction(() => !document.getElementById('landingWarn').classList.contains('hidden'), { timeout: 3000 }),
      4000, '净化后警示行应显形',
    );
    const g = await page.evaluate((rulesOfSrc) => {
      const rulesOf = eval(rulesOfSrc);
      const toRgb = (c) => {
        const m = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
        if (!m) return String(c).trim();
        const n = parseInt(m[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      const root = getComputedStyle(document.documentElement);
      const warn = document.getElementById('landingWarn');
      const egg = document.getElementById('landingEggTip');
      const scan = document.getElementById('landingScan');
      const wcs = getComputedStyle(warn);
      const ecs = getComputedStyle(egg);
      const scs = getComputedStyle(scan);
      return {
        warn: { mt: wcs.marginTop, fs: wcs.fontSize, ls: wcs.letterSpacing, color: wcs.color, danger: toRgb(root.getPropertyValue('--danger')) },
        warnRules: rulesOf(warn),
        egg: {
          mt: ecs.marginTop, fs: ecs.fontSize, lh: ecs.lineHeight, ls: ecs.letterSpacing,
          color: ecs.color, maxW: ecs.maxWidth, w: ecs.width, muted: toRgb(root.getPropertyValue('--muted')),
          hasBold: !!egg.querySelector('b'),
          html: egg.innerHTML,
        },
        eggRules: rulesOf(egg),
        scan: {
          // 🔴 老项目是 `.scan-row{margin:26px 0 0}` 包一层；bj 直接挂 .lscan。
          //   所以这里量"扫码胶囊顶 与 上一行底 的间距"，钉的是**用户看到的距离**，
          //   不是钉"有没有 .scan-row 这个壳"（钉壳的话，换个等价实现就误红）。
          gapAbove: (() => {
            const r = scan.getBoundingClientRect();
            let prevBottom = -Infinity;
            for (const el of document.querySelectorAll('#landing *')) {
              if (el === scan || el.contains(scan)) continue;
              if (el.children.length) continue; // 只看叶子
              const b = el.getBoundingClientRect();
              if (b.height > 0 && b.bottom <= r.top + 1 && b.bottom > prevBottom) prevBottom = b.bottom;
            }
            return r.top - prevBottom;
          })(),
          pad: scs.padding, radius: scs.borderRadius, fs: scs.fontSize,
        },
      };
    }, rulesOf);

    // ① 警示行
    assert.equal(g.warn.mt, '14px', `警示行上外距应 14px（老项目 margin:14px 0 0），实测 ${g.warn.mt}（bj 是 8px）`);
    assert.equal(g.warn.fs, '12px', `警示行字号应 12px（老项目同值），实测 ${g.warn.fs}`);
    assert.equal(g.warn.ls, '0.48px', `警示行字距应 0.48px（.04em×12，老项目 letter-spacing:.04em），实测 ${g.warn.ls} —— 整行无字距是 bj 现状`);
    assert.equal(g.warn.color, g.warn.danger, `警示行文字色应 --danger（老项目 #C0453E），实测 ${g.warn.color}`);

    // ② 彩蛋提示行：先切到彩蛋门牌
    await page.fill('#li', 'pet');
    await withTimeout(
      page.waitForFunction(() => document.getElementById('landingEggTip').textContent.trim() !== '', { timeout: 3000 }),
      4000, '彩蛋门牌应出提示行',
    );
    const e = await page.evaluate(() => {
      const egg = document.getElementById('landingEggTip');
      const cs = getComputedStyle(egg);
      const root = getComputedStyle(document.documentElement);
      const toRgb = (c) => {
        const m = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
        if (!m) return String(c).trim();
        const n = parseInt(m[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      return {
        mt: cs.marginTop, fs: cs.fontSize, lh: cs.lineHeight, ls: cs.letterSpacing,
        color: cs.color, maxW: cs.maxWidth, width: cs.width,
        muted: toRgb(root.getPropertyValue('--muted')), accent: toRgb(root.getPropertyValue('--accent')),
        hasBold: !!egg.querySelector('b'),
        boldColor: egg.querySelector('b') ? getComputedStyle(egg.querySelector('b')).color : '',
        boldFw: egg.querySelector('b') ? getComputedStyle(egg.querySelector('b')).fontWeight : '',
      };
    });
    assert.equal(e.mt, '12px', `彩蛋提示行上外距应 12px（老项目同值），实测 ${e.mt}（bj 是 4px）`);
    assert.equal(e.fs, '11px', `彩蛋提示行字号应 11px（老项目同值），实测 ${e.fs}（bj 是 12px，整行大一号）`);
    assert.equal(e.lh, '18.7px', `彩蛋提示行行高应 18.7px（11×1.7），实测 ${e.lh} —— bj 用 normal 就不等于这个值`);
    assert.equal(e.ls, '0.44px', `彩蛋提示行字距应 0.44px（.04em×11），实测 ${e.ls}`);
    assert.equal(e.color, e.muted,
      `彩蛋提示行整行应是 muted 灰（老项目 .eggtip color:var(--muted)），实测 ${e.color} —— ` +
      `整行金黄是 bj 现状，老项目只有<b>门牌名</b>是金黄`);
    assert.equal(e.maxW, '340px', `彩蛋提示行限宽应 340px（老项目同值），实测 ${e.maxW}`);
    assert.ok(e.hasBold,
      `门牌名必须是独立 <b>（老项目 #landing .eggtip b{color:var(--accent);font-weight:600}），实测无 —— ` +
      `这样就没法做到"只有门牌名金黄、说明文字灰色"`);
    assert.equal(e.boldColor, e.accent, `门牌名应 --accent 金黄，实测 ${e.boldColor}`);
    assert.equal(e.boldFw, '600', `门牌名字重应 600（老项目同值），实测 ${e.boldFw}`);

    // ③ 扫码入口上方留白：老项目 .scan-row margin:26px 0 0
    assert.ok(
      Math.abs(g.scan.gapAbove - 26) <= 2,
      `扫码胶囊上方应留 26px（老项目 .scan-row{margin:26px 0 0}），实测 ${g.scan.gapAbove.toFixed(1)}px —— ` +
      `bj 把 .lscan 直接挂在 .landing-in 下、没有那层 26px 上边距，这就是"位置不一样"最显眼的一处`,
    );
  } finally {
    await page.close();
  }
});

/**
 * ============================================================================
 * 25 / 26 / 27 —— 移动端「键盘不该自己弹出来」（用户报障第 8 / 10 / 11 条）
 * ============================================================================
 *
 * 🔴🔴🔴 这组三条的**共同根因**只有一句话：bj 在关闭浮层时**无条件 focus 编辑器**，
 *   老项目**每一条**都带 `if (CHIP_HOVER_OK)` 守卫。
 *
 *   老项目 `CHIP_HOVER_OK`（index.html:6490）：
 *     `!!(window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches)`
 *     —— 语义是"有精确指针的桌面级设备"。它出现在**每一个**收尾 focus 上：
 *       :8000 菜单点空白关闭     :8216 关于点空白关闭   :8244 关于× 关闭
 *       :8249 菜单切主题         :8279 修改口令打开     :8287 修改口令取消
 *       :3377/:7628 二维码弹窗关闭 :6929/:9111 彩蛋层关闭  :8000 菜单遮罩关闭
 *       :4409 折叠三角开合        :2411 图片插入完成
 *   一处不漏。而 bj 的对应位置是裸 `editor?.focus()` / `host.focus()` ——
 *   在手机上 `focus()` 就是**弹软键盘**，于是用户点关闭弹窗，键盘"啪"地弹出来。
 *
 * 🔴 判据钉的是 `document.activeElement`，不是"有没有调 focus"：
 *   "调了 focus 但立刻被 blur"与"压根没调"在真机上都是"键盘不弹"，用户看不出差别。
 *   钉 activeElement 才能覆盖等价实现。
 *
 * 🔴🔴 必须在**真的触屏上下文**里跑（harness 的 `openEditorTouch`）。
 *   桌面上下文里 `(hover: none) and (pointer: coarse)` 恒 false，
 *   于是"移动端不该 focus"那条分支永远走不到 —— 这三条会恒绿，而真机照旧弹键盘。
 *   **测试恒绿不是因为对，是因为压根没进那条分支。**
 */

/** 读当前焦点落在谁身上（用于"键盘该不该弹"的判据）。 */
const activeInfo = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return { tag: '', id: '', cls: '', editable: false };
  return {
    tag: a.tagName,
    id: a.id || '',
    cls: typeof a.className === 'string' ? a.className : '',
    editable: a.getAttribute && a.getAttribute('contenteditable') === 'true',
  };
});

/** 触屏断言：焦点**不得**落在任何可编辑元素上（否则软键盘会弹）。 */
async function assertNoKeyboard(page, where) {
  const a = await activeInfo(page);
  const editable =
    a.editable ||
    a.tag === 'INPUT' ||
    a.tag === 'TEXTAREA' ||
    (a.tag === 'DIV' && /\bn-input\b|\bns-editor\b|\beditable\b/.test(a.cls));
  assert.ok(
    !editable,
    `${where}：移动端关闭后焦点不得落在可编辑元素上（会弹软键盘），` +
    `实测 activeElement=${a.tag}#${a.id}.${a.cls}。` +
    `已验证过的两条根因（按可能性排序）：① 收尾 focus 少了老项目 CHIP_HOVER_OK 守卫` +
    `（index.html 每一处收尾 focus 都有）；② 同步 blur 被 Lexical commit 抢回焦点 ——` +
    `commit 会把 DOM Selection 写进 contenteditable，Chromium 在那一步隐式聚焦，` +
    `探针把 HTMLElement.prototype.focus 整个换掉抓栈仍是空数组（浏览器内部行为）。` +
    `② 的修法是 blur 后再补一次 requestAnimationFrame blur（见 behaviors.ts 折叠处理器）。`,
  );
}

test('VVW-25 🔴🔴🔴 触屏：关掉二维码弹窗不得弹键盘（报障第 8 条）', async () => {
  // 用户原话：移动端点击二维码配对图标 → 关闭弹窗 → 键盘被打开。
  // 老项目 :3377 `$('#qrClose')` = `qrMask.classList.add('hidden');
  //   if (CHIP_HOVER_OK) { editor.focus(); ensureCaret(); }`
  const page = await openEditorTouch(h.browser(), h.baseUrl(), 'vvw25', 'pw');
  try {
    await page.tap('#qrBtn');
    // 🔴 弹层 id 是 `pairMask`（scan/panel.ts:169），不是 `qrMask` ——
    //   判据里猜 id 的后果是 waitForSelector 干等 10s，报错只说"找不到 qrMask"，
    //   看起来像"弹窗没打开"，实际是自己写错了名字。
    await withTimeout(page.waitForSelector('#pairMask', { state: 'visible', timeout: 10_000 }), 12_000, '等二维码弹窗');
    // 先把焦点放到编辑区（模拟"用户在正文里点过"这个真实前置）
    await page.evaluate(() => document.querySelector('.ns-editor')?.focus());
    await page.tap('#qrClose');
    await withTimeout(
      page.waitForFunction(() => !document.getElementById('pairMask'), { timeout: 5000 }),
      6000, '二维码弹窗应关闭',
    );
    await page.waitForTimeout(200);
    await assertNoKeyboard(page, '关闭二维码配对弹窗后');
  } finally {
    await closeTouch(page);
  }
});

test('VVW-26 🔴🔴🔴 触屏：菜单三条关闭路径 + 修改口令取消都不该弹键盘（报障第 10 条）', async () => {
  // 老项目对应：:8000 菜单点空白 / :8216 关于点空白 / :8244 关于× / :8287 修改口令取消
  // 四条**全部**是 `menuMask.classList.add('hidden')` + `if (CHIP_HOVER_OK) editor.focus()`。
  const page = await openEditorTouch(h.browser(), h.baseUrl(), 'vvw26', 'pw');
  try {
    // ① 菜单列表 → 点空白关闭
    await page.tap('#menuBtn');
    await withTimeout(page.waitForSelector('#menuMainView', { timeout: 10_000 }), 12_000, '等菜单');
    await page.evaluate(() => document.getElementById('menuMask')?.click());
    await withTimeout(
      page.waitForFunction(() => document.getElementById('menuMask')?.classList.contains('hidden'), { timeout: 5000 }),
      6000, '点空白应关闭菜单',
    );
    await page.waitForTimeout(150);
    await assertNoKeyboard(page, '菜单点空白关闭后');

    // ② 菜单 → 关于 NoteSync → × 关闭
    await page.tap('#menuBtn');
    await withTimeout(page.waitForSelector('#menuAbout', { timeout: 10_000 }), 12_000, '等菜单(二次)');
    await page.tap('#menuAbout');
    await withTimeout(
      page.waitForSelector('#aboutMask .about-title', { state: 'visible', timeout: 10_000 }),
      12_000, '等关于页',
    );
    // 🔴 关于页的关闭 × **没有 id**，是 `class="box-x"` 的绝对定位按钮
    //   （update/ota-ui.ts:83 `x.className = 'box-x'`；只有遮罩是 `#aboutMask`、
    //   标题是 `#aboutTitle`）。判据里写 `#aboutClose` 会干等 30s，
    //   报错还像"关于页没打开"。
    await page.tap('#aboutMask .box-x');
    await withTimeout(
      page.waitForFunction(() => document.getElementById('aboutMask')?.classList.contains('hidden'), { timeout: 5000 }),
      6000, '关于页应关闭',
    );
    await page.waitForTimeout(150);
    await assertNoKeyboard(page, '关于 NoteSync 关闭后');

    // ③ 菜单 → 修改口令 → 取消关闭
    await page.tap('#menuBtn');
    await withTimeout(page.waitForSelector('#menuPass', { timeout: 10_000 }), 12_000, '等菜单(三次)');
    await page.tap('#menuPass');
    await withTimeout(page.waitForSelector('#cpMask', { state: 'visible', timeout: 10_000 }), 12_000, '等修改口令弹窗');
    await page.tap('#cpCancel');
    await withTimeout(
      page.waitForFunction(() => !document.getElementById('cpMask'), { timeout: 5000 }),
      6000, '修改口令弹窗应移除',
    );
    await page.waitForTimeout(150);
    await assertNoKeyboard(page, '修改口令取消关闭后');
  } finally {
    await closeTouch(page);
  }
});

test('VVW-27 🔴🔴🔴 触屏：修改口令弹窗打开时必须聚焦"当前口令"，取消时不得留下焦点（报障第 9 / 10 条）', async () => {
  // 老项目 index.html:8277-8280：
  //   openChangePass(){ …cpReset(); cpMask.classList.remove('hidden');
  //     try { cpOld.focus(); } catch (e) {} }
  // ⇒ **打开弹窗时聚焦当前口令框**（用户报障第 9 条：bj 没聚焦）。
  // 老项目 :8287 取消：`if (CHIP_HOVER_OK) { editor.focus(); ensureCaret(); }`
  //   ⇒ 触屏下**不还焦点**，所以键盘不会因为"取消"而弹（报障第 10 条第三条）。
  //
  // 🔴 这一条把"打开要聚焦"与"取消不留焦点"钉在**同一次会话**里 ——
  //   只钉前者的话，实现很容易"打开聚焦了、取消又 focus 到编辑器"，
  //   而后者正是用户看到的第二个症状。
  const page = await openEditorTouch(h.browser(), h.baseUrl(), 'vvw27', 'pw');
  try {
    await page.tap('#menuBtn');
    await withTimeout(page.waitForSelector('#menuPass', { timeout: 10_000 }), 12_000, '等菜单');
    await page.tap('#menuPass');
    await withTimeout(page.waitForSelector('#cpMask', { state: 'visible', timeout: 10_000 }), 12_000, '等修改口令弹窗');
    await page.waitForTimeout(250); // 给 focus 落地一点时间

    const open = await activeInfo(page);
    assert.equal(
      open.id, 'cpOld',
      `打开修改口令弹窗后焦点必须落在「当前口令」输入框（老项目 openChangePass 里 cpOld.focus()），` +
      `实测 activeElement=${open.tag}#${open.id}.${open.cls} —— 用户报障第 9 条「没有自动聚焦到当前口令文本框」。`,
    );

    // 反向：此刻键盘**应该**是弹的（用户就是要在这里输旧口令）
    assert.ok(
      open.tag === 'INPUT',
      `聚焦到口令框时 activeElement 必须是 INPUT（会弹软键盘，这是本场景的预期），实测 ${open.tag}`,
    );

    // 取消：焦点不得被"还给编辑器"
    await page.tap('#cpCancel');
    await withTimeout(
      page.waitForFunction(() => !document.getElementById('cpMask'), { timeout: 5000 }),
      6000, '修改口令弹窗应移除',
    );
    await page.waitForTimeout(200);
    await assertNoKeyboard(page, '修改口令取消后（老项目 :8287 触屏不还焦点）');
  } finally {
    await closeTouch(page);
  }
});

test('VVW-28 🔴🔴 触屏：点折叠三角开合不得弹键盘（报障第 11 条）', async () => {
  // 老项目 index.html:4425（折叠 click 处理器收尾）：
  //   try { foldCaretNormalize(); } catch (err) {}
  //   try { dismissKeyboardForTouch(); } catch (err) {} // 触屏兜底：个别内核 touchstart 早于 mousedown 已聚焦
  //   try { backfillLastHtmlIfDecorativelyEqual(); } catch (err) {}
  // 🔴🔴 **实测根因（不是"少了一行 dismissKeyboard"）**，2026-10-07 焦点时间线探针：
  //   before-dispatch=DIV#editor-host.ns-editor
  //   blur#1=BODY            ← 同步 dismissKeyboardForTouch **确实生效**
  //   sync-after-dispatch=BODY
  //   focus#4=DIV#editor-host.ns-editor   ← handler 一返回，Lexical commit 把焦点抢回去
  //   raf1 / t0 / t16 / t120 全部停在编辑器
  //   且把 `HTMLElement.prototype.focus` 整个换掉抓栈时 `__focusStacks` 是**空数组**
  //   ⇒ 没有任何 JS 调 focus()，是 commit 写 DOM Selection 时 **Chromium 隐式聚焦**。
  //   老项目同步调就够，是因为它是原生 contenteditable、`applyFolds()` 直接改 innerHTML，
  //   **没有 commit 回写 Selection 这一拍**；bj 走 Lexical 多出来的正是这一拍。
  // ⇒ 修法 = blur 之后补一次 `requestAnimationFrame(blur)`（behaviors.ts）。
  //   双向验证：撤掉 rAF → 本条红且 trace 精确复现；恢复 → 绿。
  //
  // 🔴 造折叠走 `window.__NOTESYNC_INSERT_FOLD__()`（FOLD-01 同款正规测试钩子），
  //   不自己拼 Lexical 节点 —— 那是最容易写成"恒绿假数据"的地方。
  const page = await openEditorTouch(h.browser(), h.baseUrl(), 'vvw28', 'pw');
  try {
    await page.evaluate(() => document.querySelector('.ns-editor')?.focus());
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await withTimeout(page.waitForSelector('.ns-fold', { timeout: 10_000 }), 12_000, '等折叠块');
    // 🔴 必须先确认焦点真的落在编辑区（模拟"用户正在正文里"这个前置）。
    //   否则"键盘没弹"是因为压根没聚焦过，判据就是假绿。
    await page.evaluate(() => document.querySelector('.ns-editor')?.focus());
    await page.waitForTimeout(200);
    const before = await activeInfo(page);
    assert.ok(
      before.editable || /ns-editor/.test(before.cls),
      `点三角前焦点必须在编辑区（否则"键盘没弹"是假绿），实测 activeElement=${before.tag}#${before.id}.${before.cls}`,
    );

    // 点三角（标题行左起 22px 内，behaviors.ts 的几何命中区）
    //
    // 🔴🔴 这条判据的**同步段也钉了**，不是为了多测一层，而是因为本条的根因就是
    //   「同步 blur 生效了、随后被 commit 抢回去」：
    //   只在末尾断言"焦点没落在可编辑元素"，那么一个**只同步 blur 一次**的实现
    //   （handler 返回时被 commit 覆盖）和一个**什么都不做**的实现长得一样，
    //   曾经就靠"末尾无焦点"这一句把同步版判绿过。
    //   同步段读到 BODY ⇒ 证明 blur 真的跑了；末尾读到 BODY ⇒ 证明 commit 之后没被抢回。
    //   两段合起来才是"收键盘在 commit 之后仍然成立"。
    const syncTag = await page.evaluate(() => {
      const head = document.querySelector('.ns-fold > :first-child');
      if (!head) throw new Error('折叠块缺标题行');
      const r = head.getBoundingClientRect();
      head.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + r.height / 2,
      }));
      const a = document.activeElement;
      return a ? `${a.tagName}#${a.id}.${a.className}` : 'null';
    });
    assert.ok(
      !/ns-editor/.test(syncTag),
      `同步段：blur 必须当场生效（否则说明收键盘根本没跑，后面的断言全是假绿），实测=${syncTag}`,
    );
    await withTimeout(
      page.waitForFunction(() => document.querySelector('.ns-fold')?.getAttribute('data-open') === 'false', { timeout: 5000 }),
      6000, '等折叠收起',
    );
    await page.waitForTimeout(250);
    await assertNoKeyboard(page, '点折叠三角收起后');

    // 反向：展开也必须收键盘（同一处理器，只测收起会漏掉另一半）
    await page.evaluate(() => {
      const head = document.querySelector('.ns-fold > :first-child');
      const r = head.getBoundingClientRect();
      head.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + r.height / 2,
      }));
    });
    await withTimeout(
      page.waitForFunction(() => document.querySelector('.ns-fold')?.getAttribute('data-open') === 'true', { timeout: 5000 }),
      6000, '等折叠展开',
    );
    await page.waitForTimeout(250);
    await assertNoKeyboard(page, '点折叠三角展开后');
  } finally {
    await closeTouch(page);
  }
});

/**
 * VVW-29 🔴🔴🔴 夜间滚动条**轨道（track）**颜色必须与老项目同口径（用户报障第 5 条）
 *
 * 用户原话：「夜间模式滚动条后面背景条（track）颜色和老版本不一样」。
 *
 * ── 根因（真浏览器 + 源码双向核实，不是推理）────────────────────────────
 *  🔴 **两边都没有 `::-webkit-scrollbar-track` 声明**（老项目 grep scrollbar 只有
 *     426-427 两条 width/thumb；bj styles.css:609-610 逐字同款）。
 *     ⇒ track 颜色**完全由 UA 默认值决定**，而 UA 默认值只认一个东西：
 *     **`color-scheme`**。
 *
 *  老项目（notesync/index.html）：
 *    :14   `<meta name="color-scheme" content="light">`   ← **单值**
 *    :80   `:root { color-scheme: light }`
 *    :92   `body.dark { color-scheme: dark }`              ← **类名驱动**
 *    :1124-1127 注释明写这套是**为国产浏览器"网页夜间"强制反色做的对抗**
 *  bj（www/index.html + styles.css）：
 *    :6    `<meta name="color-scheme" content="light dark">`  ← **双值**！
 *    :1194-1196  唯一定义 `@media (prefers-color-scheme:dark){ html:not(.force-light) body{color-scheme:dark} }`
 *
 *  两处偏差叠加 ⇒ 夜间 track 走 UA 的深色档，与老项目的浅色档不同：
 *    ① meta 声明 `light dark` = 主动告诉 UA「我支持深色」⇒ UA 直接给深色 track；
 *    ② 老项目靠**类名**切 color-scheme，bj 靠**媒体查询**切 ——
 *       用户手动切主题（`applyTheme` 写 `.dark` 类）时，媒体查询不跟着变，
 *       于是「应用内夜间」和「系统夜间」在 track 上是两套答案。
 *
 *  🔴🔴 判据必须**真浏览器读 computedStyle**，不能正则匹配 CSS 字符串：
 *     `color-scheme` 是继承属性，正则算不准它在哪一层生效（这正是本仓记忆里
 *     「判『CSS 补丁生效』必须真浏览器读 computedStyle」那条）。
 *
 *  🔴🔴 必须钉**日间与夜间两态**。只测夜间会漏掉反向问题
 *     （若有人把 color-scheme 写死成 dark，日间就会反过来错）。
 *  用 `openEditorAt` 的 `iso` 钉死时钟（07:00/19:00 是本项目日夜分界，见 MEMORY）。
 */
test('VVW-29 🔴🔴🔴 日夜两态 color-scheme 必须与老项目同口径（夜间滚动条 track 这条报障）', async () => {
  // 🔴 老项目逐值参照（notesync/index.html，只读）：
  //   :14 <meta name="color-scheme" content="light">
  //   :80 :root{color-scheme:light}   :92 body.dark{color-scheme:dark}
  // ⇒ 日间落在 light、**应用内夜间**落在 dark，两态都由**类名**决定，不看系统偏好。
  const readCs = (page) =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const meta = document.querySelector('meta[name="color-scheme"]');
      return {
        metaContent: meta ? meta.getAttribute('content') : null,
        bodyColorScheme: cs.colorScheme,
        htmlClass: document.documentElement.className,
        bodyClass: document.body.className,
        isDark: document.body.classList.contains('dark'),
        // 🔴 顺手把 scrollbar 的自定义部分也读出来（老项目只声明 width+thumb，
        //   track 留白 ⇒ 这两项在两边都应是 null，钉住"没人偷偷加 track 声明"）。
        sbWidth: (() => {
          const ed = document.getElementById('editor-host') || document.querySelector('.ns-editor');
          return ed ? getComputedStyle(ed).getPropertyValue('scrollbar-color') : null;
        })(),
      };
    });

  const cases = [
    { label: '日间（钉 10:00）', iso: new Date('2026-07-15T10:00:00'), wantDark: false },
    { label: '夜间（钉 22:00）', iso: new Date('2026-07-15T22:00:00'), wantDark: true },
  ];

  for (const c of cases) {
    const page = await openEditorAt(h.browser(), h.baseUrl(), 'vvw29', 'pw', { iso: c.iso });
    try {
      await page.waitForSelector('#editor-host', { state: 'attached', timeout: 15_000 });
      // 等主题真值落定（applyTheme 是启动时跑的，别在它前面读）
      await withTimeout(
        page.waitForFunction(
          (d) => document.body.classList.contains('dark') === d, c.wantDark, { timeout: 8000 },
        ),
        10_000,
        `等${c.label}主题落定`,
      );
      const got = await readCs(page);

      // 🔴 断言 1：主题类名必须真的切了（否则下面全是恒真）
      assert.equal(got.isDark, c.wantDark, `${c.label}：body.dark 应为 ${c.wantDark}`);

      // 🔴 断言 2：meta 必须是**单值** light。老项目 :14 原文是 `content="light"`。
      //   bj 现在是 "light dark" —— 这一个字符串就是夜间 track 变色的直接原因。
      //   写成精确等值而不是"包含 light"：双值与单值在这里行为完全不同。
      assert.equal(
        got.metaContent, 'light',
        `${c.label}：meta[name=color-scheme] 必须是单值 "light"（老项目 :14 原文），`
        + `实际="${got.metaContent}"。写成 "light dark" 等于主动告诉 UA 本页支持深色，`
        + `UA 会直接给深色滚动条轨道 —— 正是用户报的那条`,
      );

      // 🔴 断言 3：computedStyle 的 color-scheme 必须与主题态一致。
      //   老项目是**类名驱动**（:80/:92），所以日间 light、应用内夜间 dark ——
      //   注意不是 "normal"/"dark light"，那会让 UA 走另一套默认色。
      const want = c.wantDark ? 'dark' : 'light';
      assert.equal(
        got.bodyColorScheme, want,
        `${c.label}：body 的 computedStyle.color-scheme 应为 "${want}"（老项目 :80/:92 类名驱动），`
        + `实际="${got.bodyColorScheme}"`,
      );

      // 🔴🔴 断言 4（**这条已改口径**，见 VVW-33）：轨道色改由**显式声明**兜住。
      //   这里只保留「thumb 位不许被偷偷改成自定义色」。
      //   老项目 426-427 只声明 width + `thumb{background:var(--line)}`，没碰 `scrollbar-color`。
      //   本项目为了在 Windows 深色系统主题下把日间轨道压回白色（用户报障第 5 条回访），
      //   额外补了 track 声明 —— 见 VVW-33 与 styles.css 的显式定色段。
      //   🔴 但 thumb 仍是老项目口径 `var(--line)`，滑块颜色**不许**被人换成别的东西。
      //   期望值是 CSS **初值** `auto`，不是空串 —— 我第一版写 `''`，
      //   判据在实现改对之后仍然红（`auto` !== `''`），差点被当成"没修好"回滚实现。
      //   教训同本文件头第 3 条：getPropertyValue 对**未声明**的属性返回初值，不是空串。
      const thumbPart = String(got.sbWidth).split(/\s+/)[0];
      assert.equal(
        thumbPart, 'auto',
        `${c.label}：scrollbar-color 的**滑块位**必须仍是 auto —— 老项目没碰它，`
        + `滑块色归 .ns-editor 的 ::-webkit-scrollbar-thumb: var(--line) 管。`
        + `实际="${got.sbWidth}"`,
      );
    } finally {
      await page.close();
    }
  }
});

/**
 * VVW-33 🔴🔴🔴 滚动条**轨道（track）**必须由页面显式定色，不能交给 UA + 系统主题
 *                （用户报障第 5 条**回访**：夜间修好后，日间轨道在用户实机上变成黑色）
 *
 * 用户实机原话（2026-10-07，附 Windows 桌面 Chrome 截图）：
 *   「电脑 chrome 打开，日间模式，滚动条后面那个条状背景应该显示白色，结果显示成黑色。」
 * 截图中滚动条是 **Windows 原生经典滚动条**：纯黑槽 + 灰色滑块 + 上下箭头。
 *
 * ── 为什么 color-scheme 那条修复（VVW-29）不足以解决本条 ──────────────────
 *   第一批把 color-scheme 改成类名驱动（:root → light / body.dark → dark），
 *   夜间确实与老项目对齐了，**但日间在用户实机上仍然是黑槽**。
 *   机制（推断，非实测）：Windows 处于**深色系统主题**时，系统深色滚动条主题
 *   压过了页面声明的 `color-scheme: light`。
 *   ⇒ 光靠 color-scheme 这一个间接开关，**拿不到确定色**。
 *
 * 🔴🔴🔴 本条的判据设计踩过一次坑，必须写下来（这轮的教训比代码本身重要）：
 *
 *   我先前连做两轮「裁图读滚动条区域像素」，得出「bj 与老项目逐像素一致，不是回归」
 *   的结论。用户实机截图直接推翻。
 *   事后做**变量有效性检查**才发现：把 color-scheme 设成
 *   `normal / light / dark / light dark` 四种，headless 与 headed 下
 *   **四种渲染像素完全相同**（`255,255,255` + `236,234,226`）
 *   ⇒ **被测变量根本没接上**，再细化也是白细化。
 *   本轮（第三批开工前）我把同样的检查又跑了一遍，这次结论是**有效的**，量到了三件事：
 *
 *   ① `getComputedStyle(el,'::-webkit-scrollbar-track').backgroundColor`
 *      **敏感可测**：6 个容器分别声明 6 个不同颜色 → 读出 6 个互不相同的值。
 *      ⇒ 判据可以钉在**声明层**。
 *   ② 裁图读像素在 headless 下**恒为 `255,255,255`**，且 `gutter` 恒为 2
 *      （滚动条根本没被绘制）⇒ **像素层判据恒真，等于没有断言**。
 *      本条因此**只用声明层**，不裁图。
 *   ③ `scrollbar-color: auto <track>` 这种「只定 track、thumb 交给 UA」的写法
 *      **被 Chromium 丢弃**（读回 `auto`）；必须两色都给才生效。
 *      ⇒ 想只改轨道色又不碰滑块色，走不通，必须自己把 thumb 色也写上。
 *
 * ── 实现口径（与老项目的关系要说清楚）──────────────────────────────────────
 *   老项目 notesync/index.html 全文只有 426-427 两行：
 *     #editor::-webkit-scrollbar{width:8px}
 *     #editor::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
 *   `git log -S` 双仓均查不到 `::-webkit-scrollbar-track` / `scrollbar-color`。
 *   ⇒ **老项目轨道色同样 100% 由 UA + 系统主题决定**，它没解决 Windows 深色下的问题，
 *      只是用户在老项目上看到的是白色（可能老项目当时跑在系统浅色主题下，
 *      或浏览器对同一页面用了不同的 UA 默认值）。
 *   本条是**有意的、必须记录的偏离**：不再把轨道色交给系统。
 *   规则值用页面自己的 `--line` 令牌，日夜自动跟随，不硬编码任何颜色字面量
 *   （本仓 ui-contract 有机械扫描，加字面量会红）。
 *
 * ── 为什么这条判据不是恒真 ────────────────────────────────────────────────
 *   · 正向闸：日夜两态都要求 track 的 computed backgroundColor 精确等于 `--line` 的计算值。
 *     改实现前它们是 `rgba(0,0,0,0)`（= 未声明），判据**红**。
 *   · 反向闸 A：color-scheme 三行（meta 单值 light / :root light / body.dark dark）必须仍在。
 *     防止有人为了修本条把夜间那条修复一起回退掉。
 *   · 反向闸 B：`.ns-rem-wheel` 的 `scrollbar-width:none` + `::-webkit-scrollbar{display:none}`
 *     必须仍在 —— 时间滚轮是**故意不显示滚动条**的，别被这条规则误伤。
 *   · 反向闸 C：`.ns-editor` 的 `width:8px` + `thumb:var(--line)` 必须逐字仍在（滑块不许变粗变色）。
 *   · 变异分层：除了「删掉整条规则」，还要验「只删 track 声明」与「把值改成硬编码字面量」
 *     两种更隐蔽的变异也能转红 —— 后者会被 ui-contract 之外的路径放过，只靠本条抓。
 */
test('VVW-33 🔴🔴🔴 日夜两态滚动条轨道必须显式定色为 --line（用户实机日间黑槽）', async () => {
  /**
   * 在页面里量三样东西，全部走真浏览器 computedStyle。
   * 🔴 被序列进页面的函数必须**自包含**，不能引用外部作用域（本文件头纪律）。
   */
  const readScrollbar = (sels) => {
    const norm = (c) => {
      const s = String(c).trim();
      // 🔴 getPropertyValue 对**自定义属性**返回的是**原始字面量**（"#ECEAE2"），
      //   不像 getComputedStyle 的计算值那样是 rgb() —— 本文件头纪律第 1 条。
      //   三种写法都要认，否则前置闸会拿 "#ECEAE2" 去比 "rgb(236,234,226)" 而假红。
      const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (hex) {
        let h6 = hex[1];
        if (h6.length === 3) h6 = h6.split('').map((c) => c + c).join('');
        return `rgb(${parseInt(h6.slice(0, 2), 16)}, ${parseInt(h6.slice(2, 4), 16)}, ${parseInt(h6.slice(4, 6), 16)})`;
      }
      const m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/);
      if (!m) return s;
      const a = m[4] === undefined ? 1 : Number(m[4]);
      return a === 1
        ? `rgb(${Math.round(+m[1])}, ${Math.round(+m[2])}, ${Math.round(+m[3])})`
        : `rgba(${Math.round(+m[1])}, ${Math.round(+m[2])}, ${Math.round(+m[3])}, ${Number(a.toFixed(3))})`;
    };
    const lineVar = norm(getComputedStyle(document.documentElement).getPropertyValue('--line'));
    const out = { lineVar, targets: [] };
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) { out.targets.push({ sel, missing: true }); continue; }
      let track = null, thumb = null, wkWidth = null, sbColor = null, wheelDisplay = null;
      try { track = norm(getComputedStyle(el, '::-webkit-scrollbar-track').backgroundColor); }
      catch (e) { track = `ERR:${String(e && e.message)}`; }
      try { thumb = norm(getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor); }
      catch (e) { thumb = `ERR:${String(e && e.message)}`; }
      try { wkWidth = getComputedStyle(el, '::-webkit-scrollbar').width || null; }
      catch (e) { wkWidth = `ERR:${String(e && e.message)}`; }
      const own = getComputedStyle(el);
      sbColor = own.scrollbarColor;
      wheelDisplay = own.scrollbarWidth;
      out.targets.push({ sel, missing: false, track, thumb, wkWidth, sbColor, wheelDisplay });
    }
    return out;
  };

  // 🔴 覆盖**全部**会滚的容器。多写几个无害（missing 时下面会 fail 并报出选择器），
  //   少写一个就等于给那个容器留了无保护的口子 —— 这正是上一轮漏掉的原因。
  //
  // 🔴🔴 选择器**全部来自真浏览器实测**（一次性探针扫过每个视图的 querySelectorAll），
  //   不是照着 styles.css 的类名想当然写的。我第一版凭印象写成了
  //   `#remCardList` / `#remBoxList` —— 真实类名是 `.ns-remcard-list` / `.ns-rem-list`，
  //   前置闸立刻抓红。同批还纠正了另两处：`.list-scroll` 要进二级视图才有，
  //   `.hist-preview` 要真有历史版本才有。
  //   ⇒ 分两组：OPEN_IN_MENU 是**首页就能量到**的；其余走 DEEP 组（开对应面板后量）。
  const TRACK_TARGETS = [
    '.ns-editor',        // :596  正文编辑器（老项目唯一显式定过 scrollbar 的容器）
    '#menuMainView',     // :947  菜单主视图
    '.ns-remcard-list',  // :1329 提醒卡片列表
    '.ns-rembox',        // :1353 提醒面板
    '.ns-rem-list',      // :1416 提醒列表
  ];

  // 需要额外入口才出现在 DOM 的容器。逐个写清入口，缺入口时判据 fail 而不是静默跳过。
  const DEEP_TARGETS = [
    { sel: '.list-scroll', open: '菜单 → 收藏笔记', hint: 'menu.ts:348/414 二级视图' },
    { sel: '.hist-preview', open: '菜单 → 历史版本（且该笔记真有历史版本）', hint: 'menu.ts:406' },
  ];

  const cases = [
    { label: '日间（钉 10:00）', iso: new Date('2026-07-15T10:00:00'), wantDark: false },
    { label: '夜间（钉 22:00）', iso: new Date('2026-07-15T22:00:00'), wantDark: true },
  ];

  for (const c of cases) {
    const page = await openEditorAt(h.browser(), h.baseUrl(), 'vvw33', 'pw', { iso: c.iso });
    try {
      await page.waitForSelector('#editor-host', { state: 'attached', timeout: 15_000 });
      await withTimeout(
        page.waitForFunction(
          (d) => document.body.classList.contains('dark') === d, c.wantDark, { timeout: 8000 },
        ),
        10_000,
        `等${c.label}主题落定`,
      );

      // 菜单容器要打开菜单才在 DOM 里；打不开就直接 fail，不静默跳过。
      await page.evaluate(() => {
        const btn = document.getElementById('menuBtn');
        if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForTimeout(400);

      // 🔴 二级视图（收藏/历史）里的 .list-scroll 只有进去才有。
      //   实测入口是菜单项「收藏笔记」，menu.ts 的 openView('fav') 走这里。
      //   进不去就 fail —— 判据静默跳过 = 少一个容器的保护网。
      const deepOpened = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#menuMainView .menu-item'));
        const fav = rows.find((r) => (r.textContent || '').includes('收藏'));
        if (!fav) return { ok: false, why: '菜单里没有「收藏」项' };
        fav.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true };
      });
      await page.waitForTimeout(400);
      const deepSels = ['.list-scroll'];
      if (deepOpened.ok) {
        const deepHas = await page.evaluate((s) => document.querySelectorAll(s).length, '.list-scroll');
        if (deepHas === 0) deepSels.length = 0; // 收藏夹为空时不渲染容器，由断言 4 的声明层兜住
      }

      const got = await page.evaluate(readScrollbar, [...TRACK_TARGETS, ...deepSels]);

      // 🔴 断言 0（前置闸，不然后面全是恒真）：主题必须真的切了，且 --line 随之变化。
      //   只断言 isDark 不够 —— 若 applyThemeVars 没跟着换 --line，下面的"精确等于"会假绿。
      const wantLine = c.wantDark ? 'rgb(36, 36, 40)' : 'rgb(236, 234, 226)';
      assert.equal(
        got.lineVar, wantLine,
        `${c.label}：--line 的计算值应为 ${wantLine}（theme.ts PALETTE.`
        + `${c.wantDark ? 'dark' : 'light'}.line）。实际="${got.lineVar}" —— `
        + `若这里就红，说明主题令牌没落定，下面所有"轨道等于 --line"的断言都不可信`,
      );

      // 🔴 断言 1（正向闸，承重）：每个滚动容器的 track 都必须显式等于 --line。
      for (const t of got.targets) {
        assert.ok(!t.missing, `${c.label}：判据选择器 "${t.sel}" 在页面上不存在 —— `
          + `容器被改名/挪走时这条判据会**静默失去保护**，必须先更新判据再改实现`);
      }

      const WHEEL = '.ns-rem-wheel';
      for (const t of got.targets) {
        // 🔴🔴 反向闸 B 优先：时间滚轮是**故意**隐藏滚动条的，不能被轨道色规则改掉。
        if (t.sel === WHEEL) {
          assert.equal(
            t.wheelDisplay, 'none',
            `${c.label}：.ns-rem-wheel 必须仍是 scrollbar-width:none（老项目 :236 逐字同款，`
            + `时间滚轮故意不画滚动条）。实际="${t.wheelDisplay}"`,
          );
          continue;
        }

        assert.equal(
          t.track, wantLine,
          `${c.label}：${t.sel} 的 ::-webkit-scrollbar-track 背景必须显式等于 --line`
          + `（${wantLine}），不能交给 UA + 系统主题 —— Windows 深色系统主题下 UA 会给黑槽，`
          + `这正是用户实机截图里的那条。实际="${t.track}"`
          + `${t.track === 'rgba(0, 0, 0, 0)' ? '（rgba(0,0,0,0) = 完全没声明，靠 UA 决定）' : ''}`,
        );
      }

      // 🔴 断言 2（反向闸 A）：color-scheme 三行必须仍在。
      //   本条修的是"轨道色不确定"，**不能**为此把 VVW-29 那条夜间修复回退掉 ——
      //   两条是并存的：color-scheme 管表单控件/UA 默认，track 声明管轨道本身。
      const cs = await page.evaluate(() => {
        const meta = document.querySelector('meta[name="color-scheme"]');
        const html = getComputedStyle(document.documentElement).colorScheme;
        const body = getComputedStyle(document.body).colorScheme;
        return { meta: meta ? meta.getAttribute('content') : null, html, body };
      });
      assert.equal(
        cs.meta, 'light',
        `${c.label}：meta[name=color-scheme] 必须仍是单值 light（老项目 :14 原文）。`
        + `本条只补轨道色，不许改它。实际="${cs.meta}"`,
      );
      // 🔴 我第一版把 :root 也断言成"夜间 = dark"，判据红。查老项目才发现：
      //   notesync/index.html:80  `:root { color-scheme: light }`  ← **只有这一条，永不改**
      //   notesync/index.html:92  `body.dark { color-scheme: dark }` ← 夜间只落在这里
      //   ⇒ :root 的 color-scheme 是**两态都 light**，这是老项目的原样。
      //   bj 的 styles.css:1214-1215 与之逐字一致，本条不许改它。
      assert.equal(
        cs.html, 'light',
        `${c.label}：:root 的 color-scheme 必须恒为 light（老项目 :80 原文，`
        + `夜间只由 body.dark 接管，:root 不动）。实际="${cs.html}"`,
      );
      assert.equal(
        cs.body, c.wantDark ? 'dark' : 'light',
        `${c.label}：body 的 color-scheme 应为 "${c.wantDark ? 'dark' : 'light'}"。`
        + `实际="${cs.body}"`,
      );

      // 🔴 断言 3（反向闸 C）：.ns-editor 的滑块不许被顺带改粗或改色。
      //   老项目 426-427 逐字：width:8px + thumb:var(--line) + radius:4px。
      const ed = got.targets.find((t) => t.sel === '.ns-editor');
      assert.equal(
        ed.wkWidth, '8px',
        `${c.label}：.ns-editor 的 ::-webkit-scrollbar 宽度必须是 8px（老项目 :426 逐字）。`
        + `本条只补 track，不许动 width。实际="${ed.wkWidth}"`,
      );
      assert.equal(
        ed.thumb, wantLine,
        `${c.label}：.ns-editor 的 ::-webkit-scrollbar-thumb 必须是 var(--line)`
        + `（${wantLine}，老项目 :427 逐字）。实际="${ed.thumb}"`,
      );

      // 🔴 断言 4（组二 · 样式表声明层）：那些**打不开的面板**容器
      //   （彩蛋图鉴 #eggList、游戏镜像 .ns-mirror-box、时间滚轮 .ns-rem-wheel）
      //   在 e2e 里没有可达入口，覆盖不到就等于留了无保护的口子。
      //   ⇒ 这一组直接读**产物里内联的 CSS 文本**，按选择器逐条查有没有 track 声明。
      //   ⚠️ 只对**伪元素**用文本匹配是安全的：`::-webkit-scrollbar-track` 只可能来自
      //      样式表，不像普通属性那样被 specificity 吃回（这条已在声明层验证过可读且敏感）。
      const cssText = await page.evaluate(() => {
        // 产物把 CSS 内联在 <style> 里（无外链 .css，见 build.mjs indexHtml）
        return Array.from(document.querySelectorAll('style'))
          .map((s) => s.textContent || '').join('\n');
      });
      // 按 CSS 规则块切开，逐块找选择器与声明。不用正则硬啃整个文件 ——
      // 「选择器里带逗号」和「声明里带 }」都会让朴素正则错切。
      const rules = [];
      {
        // 🔴 去注释，否则注释里写的 ::-webkit-scrollbar-track 会被当成真声明。
        const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
        let depth = 0, buf = '', i = 0;
        for (; i < stripped.length; i++) {
          const ch = stripped[i];
          if (ch === '{') { depth++; buf += ch; }
          else if (ch === '}') { depth--; buf += ch; if (depth === 0) { rules.push(buf); buf = ''; } }
          else buf += ch;
        }
        if (buf.trim()) rules.push(buf);
      }
// 🔴🔴 为什么**不接受** `*::-webkit-scrollbar-track`：
      //   通配规则确实能覆盖全部容器，但代价是 —— 以后谁新增一个滚动容器，
      //   哪怕完全忘了这条规则，也照样"有保护"（全局规则命中它）。
      //   那样这条断言就失去了"逐个钉住"的意义，退化成恒真。
      //   ⇒ 实现里用**逐选择器显式列出**的规则，判据才认。
      //   （这也正是 styles.css 那段注释要求逐个列出的原因，两边是对偶的。）
      const hasTrackDecl = (sel) => {
        const wanted = sel.split(',').map((s) => s.trim()).filter(Boolean);
        for (const raw of rules) {
          const open = raw.indexOf('{');
          if (open < 0) continue;
          const sels = raw.slice(0, open);
          const body = raw.slice(open + 1, raw.lastIndexOf('}'));
          if (!/::\s*-webkit-scrollbar-track/.test(sels)) continue;
          if (!/(^|[;{\s])background(-color)?\s*:/.test(body)) continue;
          const parts = sels.split(',').map((s) => s.replace(/\s+/g, ' ').trim());
          for (const want of wanted) {
            const w = want.replace(/\s+/g, ' ').trim();
            if (parts.some((p) => p === w || p === `${w}::-webkit-scrollbar-track`)) return true;
          }
        }
        return false;
      };

      for (const sel of ['#eggList', '.ns-mirror-box', '.list-scroll', '.hist-preview', '.ns-remcard-list', '.ns-rem-list', '.ns-rembox', '#menuMainView', '.ns-editor']) {
        assert.ok(
          hasTrackDecl(sel),
          `${c.label}：样式表里 ${sel} 缺 ::-webkit-scrollbar-track 的 background 声明 —— `
          + `这些容器（尤其 #eggList / .ns-mirror-box）e2e 打不开，声明层是它们唯一的保护网。`
          + `缺了 = Windows 深色系统主题下会画成黑槽，而没有任何判据会红。`,
        );
      }

      // 🔴 断言 5（反向闸 B · 声明层）：.ns-rem-wheel 必须继续隐藏滚动条。
      //   顶部那条轨道色规则是全局的（命中所有 ::-webkit-scrollbar-track），
      //   很容易顺手把这条也"统一"掉 ⇒ 时间滚轮会凭空多出一条轨道。
      const wheelRules = rules.filter((r) => r.includes('.ns-rem-wheel'));
      assert.ok(
        wheelRules.some((r) => /scrollbar-width\s*:\s*none/.test(r)),
        `${c.label}：.ns-rem-wheel 必须仍有 scrollbar-width:none（老项目 :236 逐字同款）。`
        + `样式表实测没找到这条声明。`,
      );
      assert.ok(
        wheelRules.some((r) => /::-webkit-scrollbar\s*\{[^}]*display\s*:\s*none/.test(r)),
        `${c.label}：.ns-rem-wheel 必须仍有 ::-webkit-scrollbar{display:none}。`
        + `样式表实测没找到这条声明。`,
      );
    } finally {
      await page.close();
    }
  }
});

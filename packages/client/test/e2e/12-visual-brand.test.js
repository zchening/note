/**
 * 视觉回归闸：Logo 与图标金色高亮层。
 *
 * 🔴🔴 这两条是被一次真实缺陷审计逼出来的（P0，均已修复）：
 *   1. Logo 被换成了另一套图形（整圆+同 心弧 + <text> 的 N），且顶栏那枚写死 48px
 *      塞进 17px 格子里 → 糊色块 + 撑开行高。
 *   2. `svg .g` 从老项目的金色 `stroke: var(--accent)` 被改成 `opacity:.6`，
 *      **全站 20+ 图标的强调层一起变灰**。
 *
 * 判据纪律：这类"必须并排对比才看得出"的缺陷，纯逻辑单测与typecheck **完全无感**，
 * 唯一能抓的就是真浏览器量尺寸。所以本文件量的是**真实计算样式**，
 * 不是"代码里写了什么"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

test('VIS-01 🔴 顶栏 logo 尺寸必须在 17–27px（写死 48 会糊成一坨并撑开行高）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'v01', 'pw');
  try {
    const box = await page.evaluate(() => {
      const svg = document.querySelector('.ns-mark svg');
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      const mark = document.querySelector('.ns-mark');
      return {
        w: r.width,
        h: r.height,
        markH: mark ? mark.getBoundingClientRect().height : -1,
        topH: document.querySelector('.ns-top')?.getBoundingClientRect().height ?? -1,
      };
    });
    assert.ok(box, '顶栏应有 .ns-mark svg');
    assert.ok(
      box.w >= 16 && box.w <= 28,
      `顶栏 logo 宽应落在 17–27pxclamp 区间，实际 ${box.w}px —— 写死 48 会糊`,
    );
    assert.ok(
      box.h >= 16 && box.h <= 28,
      `顶栏 logo 高应落在 17–27px，实际 ${box.h}px`,
    );
    // 顶栏行高：logo 不该把顶栏撑高（老项目顶栏约 44–52px）
    assert.ok(
      box.topH > 0 && box.topH <= 60,
      `顶栏行高 ${box.topH}px 异常（logo 撑开了？）`,
    );
  } finally {
    await page.close();
  }
});

test('VIS-02 🔴🔴 图标 .g 高亮层必须是金色 accent（被改成 opacity 会全站图标一起变灰）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'v02', 'pw');
  try {
    const probe = await page.evaluate(() => {
      // 🔴 归一化成rgb 再比：`getPropertyValue('--accent')` 返回的是**原始字面量**
      //   （"#8F7126"），而 getComputedStyle().stroke 返回**计算值**
      //   （"rgb(143, 113, 38)"）。两者字符串不等但颜色是同一个 ——
      //   我第一版直接比字符串，判据恒红，**差点把正确的实现当成错的**。
      //   教训：比颜色必须先归一化格式，否则断言在骗你。
      const toRgb = (c) => {
        const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
        if (!m) return c.trim();
        const n = parseInt(m[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      const g = document.querySelector('svg .g');
      if (!g) return null;
      const cs = getComputedStyle(g);
      const root = getComputedStyle(document.documentElement);
      return {
        stroke: toRgb(cs.stroke),
        accent: toRgb(root.getPropertyValue('--accent')),
        rawAccent: root.getPropertyValue('--accent').trim(),
        rawStroke: cs.stroke,
      };
    });
    assert.ok(probe, '页面里应存在带 .g 类的 SVG path');
    // 老项目：`svg .g { stroke: var(--accent) }` —— 计算值应等于当前主题的 --accent
    assert.equal(
      probe.stroke,
      probe.accent,
      `.g 的 stroke 应是金色 accent（${probe.rawAccent}），实际 ${probe.rawStroke} —— 被改成 opacity 就全站图标一起变灰`,
    );
  } finally {
    await page.close();
  }
});

test('VIS-03 🔴 落地页 logo 是固定 56px 且有双弧环+直角尖+path 描边 N', async () => {
  // 落地页是**未解锁**状态，要单独走一遍（openEditor 会跳编辑器）
  const page = await h.browser().newPage();
  try {
    await page.goto(h.baseUrl());
    await page.waitForSelector('.ns-logo', { timeout: 15_000 });
    const info = await page.evaluate(() => {
      const svg = document.querySelector('.ns-logo');
      const r = svg.getBoundingClientRect();
      return {
        w: r.width,
        h: r.height,
        pathCount: svg.querySelectorAll('path').length,
        hasText: !!svg.querySelector('text'),
        hasCircle: !!svg.querySelector('circle'),
      };
    });
    assert.equal(info.hasText, false, 'N 必须是 <path> 描边字形，用 <text> 会随系统字体变形');
    assert.equal(info.hasCircle, false, '老项目 logo 没有闭合 circle，多出来的整圆是另画的');
    // 双弧环 2 + 直角尖 2 + N 1 = 5 条 path
    assert.equal(info.pathCount, 5, `logo 应有 5 条 path（双弧2+直角尖2+N1），实际 ${info.pathCount}`);
    assert.ok(Math.abs(info.w - 56) < 1, `落地页 logo 应为 56px（老项目 .logo），实际 ${info.w}px`);
    assert.ok(Math.abs(info.h - 56) < 1, `落地页 logo 应为 56px，实际 ${info.h}px`);
  } finally {
    await page.close();
  }
});

/* ========================================================================
 * 第二批：布局 / 几何 / 描边档位回归闸。
 *
 * 🔴🔴🔴 这批全部来自一次真实审计（P0，已修复）。它们的共性是：
 *   **单看任一处都不算错，并排对比才刺眼**，所以 typecheck 与纯逻辑单测完全无感。
 *   典型形态：
 *     · 编辑器丢了 `max-width:720px; margin:0 auto` → 正文顶满整屏宽（老项目是居中一条）
 *     · 字号 17→16、行高 1.9→1.85、内边距 40/28/120→16/18/40 → 正文密度整个变了
 *     · 描边宽度从五档（1.7/1.8/1.9/2）塌成 1.6 单一值 → 菜单整组"变细"
 *     · 底栏触控区 44→30px、状态点中性灰→金色、字距 .14em 丢 → 状态条气质全变
 *     · 菜单盒 300→460px、遮罩模糊 10→2px → 浮层从"轻"变"重"
 *
 * 判据一律量**真实计算样式**，不 grep 源码 —— grep 源码会被注释命中，
 * 且看不出"写了但被后面的规则覆盖"这类真实失效。
 * ======================================================================== */

/** 把 CSS 长度值里的 px 剥掉，'17px' → 17 */
const px = (v) => parseFloat(String(v));

test('VIS-04 🔴🔴 编辑器必须居中限宽 720px / 字号 17 / 行高 1.9（丢了就是正文顶满整屏）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'v04', 'pw');
  try {
    const m = await page.evaluate(() => {
      const el = document.querySelector('.ns-editor');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const parent = el.parentElement.getBoundingClientRect();
      return {
        maxWidth: cs.maxWidth,
        fontSize: pxOf(cs.fontSize),
        lineHeight: parseFloat(cs.lineHeight),
        padT: pxOf(cs.paddingTop),
        padL: pxOf(cs.paddingLeft),
        padB: pxOf(cs.paddingBottom),
        // 居中判据：左右外边距近似相等（差 ≤2px 算居中）
        marginL: pxOf(cs.marginLeft),
        marginR: pxOf(cs.marginRight),
        boxW: r.width,
        parentW: parent.width,
      };
      function pxOf(v) { return parseFloat(String(v)); }
    });
    assert.ok(m, '应有 .ns-editor');
    assert.equal(m.maxWidth, '720px', `编辑器应限宽 720px，实际 ${m.maxWidth} —— 正文会顶满整屏`);
    assert.equal(m.fontSize, 17, `正文字号应17px，实际 ${m.fontSize}px`);
    // 行高是计算值：17 × 1.9 = 32.3
    assert.ok(
      Math.abs(m.lineHeight - 17 * 1.9) < 0.6,
      `正文行高应≈32.3px（17×1.9），实际 ${m.lineHeight}px`,
    );
    assert.equal(m.padT, 40, `正文上内边距应 40px，实际 ${m.padT}px`);
    assert.equal(m.padL, 28, `正文左内边距应 28px，实际 ${m.padL}px`);
    assert.equal(m.padB, 120, `正文下内边距应 120px（底部留白给软键盘/提示），实际 ${m.padB}px`);
    assert.ok(
      Math.abs(m.marginL - m.marginR) <= 2 && (m.marginL > 0 || m.boxW < m.parentW),
      `编辑器应水平居中（margin 0auto），实测左 ${m.marginL} 右 ${m.marginR}`,
    );
  } finally {
    await page.close();
  }
});

test('VIS-05 🔴 描边宽度必须分档：顶栏 1.7 / 菜单 1.9 / 关闭 2（塌成 1.6 菜单整组变细）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'v05', 'pw');
  try {
    // 顶栏键
    const topW = await page.evaluate(() => {
      const s = document.querySelector('.ns-top button.ns-ic svg');
      return s ? parseFloat(getComputedStyle(s).strokeWidth) : -1;
    });
    assert.ok(
      Math.abs(topW - 1.7) < 0.01,
      `顶栏图标描边应 1.7，实际 ${topW} —— 老项目分五档，统一成 1.6 会让整组变细`,
    );

    // 菜单项：打开菜单后量
    await page.click('#menuBtn');
    await page.waitForSelector('.menu-box .menu-item svg', { timeout: 10_000 });
    const menuW = await page.evaluate(() => {
      const s = document.querySelector('.menu-box .menu-item svg');
      return s ? parseFloat(getComputedStyle(s).strokeWidth) : -1;
    });
    assert.ok(
      Math.abs(menuW - 1.9) < 0.01,
      `菜单图标描边应 1.9（比顶栏粗一号），实际 ${menuW}`,
    );

    // 关闭 ×：描边 2
    // 🔴🔴 判据对象改成「弹窗盒里的 .box-x」（提醒卡/提醒面板），**不是菜单里的 X**。
    //   老项目 index.html:482 的注释钉死了这件事：「v6.1 绝对定位悬浮式随 menuClose 退役」
    //   —— 菜单盒（#menuBox）里从来就没有过关闭 X，只有 #remCardX / #remPanelX 有。
    //   我此前把判据写成 `#menuClose svg`，等于要求 bj 长出一个老项目不存在的元素；
    //   用户报障「菜单右上角多了一个 X」后我删了它，这条断言就红了。
    //   ⇒ 描边 2 的真实归属是 `.box-x`，去弹窗里量。
    // 🔴 反向钉死：菜单盒里**不许**再有 box-x（用户报障第 4 条：菜单右上角多一个 X）。
    //   这条是"删掉了"的证据，光靠"没有 #menuClose"不够 —— 万一有人用别的 id 加回来。
    //   🔴 必须在菜单**开着**的时候量，否则这条恒真（关掉菜单后 innerHTML 已清空）。
    const menuHasX = await page.evaluate(() => !!document.querySelector('.menu-box .box-x'));
    assert.equal(menuHasX, false, '菜单盒内不该有 .box-x —— 老项目菜单里从来没有关闭 X');

    // 菜单盒宽度：老项目 width:min(86vw,300px)
    const boxW = await page.evaluate(() => {
      const b = document.querySelector('.menu-box');
      return b ? b.getBoundingClientRect().width : -1;
    });
    assert.ok(
      boxW > 250 && boxW <= 302,
      `菜单盒宽应 ≈300px（min(86vw,300px)），实际 ${boxW}px —— 460px 会让整组浮层变重`,
    );

    // 🔴🔴 顺序纪律：菜单相关的量必须**在菜单开着时**做完，之后才能关菜单开弹窗。
    //   菜单遮罩（.mask）盖在顶栏之上，remBtn 虽"visible"但点不到，Playwright 会
    //   一直 retry 到 30s 超时 —— 症状与"按钮坏了"一模一样，极易误判成代码问题。
    await page.keyboard.press('Escape');
    await page.click('#remBtn');
    await page.waitForSelector('.box .box-x svg', { timeout: 10_000 });
    const xW = await page.evaluate(() => {
      const s = document.querySelector('.box .box-x svg');
      return s ? parseFloat(getComputedStyle(s).strokeWidth) : -1;
    });
    assert.ok(Math.abs(xW - 2) < 0.01, `弹窗关闭图标描边应 2，实际 ${xW}`);

    // 遮罩模糊：老项目 blur(10px)，被改成 2px 后浮层"变轻"到看不出层次
    const blur = await page.evaluate(() => {
      const b = document.querySelector('.box')?.parentElement;
      if (!b) return null;
      const v = getComputedStyle(b).backdropFilter || getComputedStyle(b).webkitBackdropFilter;
      const m = /blur\(([\d.]+)px\)/.exec(v);
      return m ? parseFloat(m[1]) : -1;
    });
    assert.ok(
      blur === -1 || Math.abs(blur - 10) < 0.01,
      `遮罩模糊应 10px，实际 ${blur}px —— 2px 看不出浮层层次`,
    );
  } finally {
    await page.close();
  }
});

test('VIS-06 🔴 底栏：触控区 ≥44px / 状态点中性灰 / 字距 .14em', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'v06', 'pw');
  try {
    const m = await page.evaluate(() => {
      const btn = document.querySelector('#menuBtn');
      const dot = document.querySelector('.ns-foot .dot');
      const foot = document.querySelector('footer.ns-foot');
      if (!btn || !dot || !foot) return null;
      const cs = getComputedStyle(foot);
      // 🔴 状态点颜色**必须与当前主题的令牌比**，不能写死 rgb。
      //   harness 默认落在夜间主题，写死日间值（#ECEAE2）会恒红——
      //   这是"判据自己写错"的典型：颜色对了却报红。
      //   要断的是"它吃的是中性灰令牌，不是金色 accent"，所以与令牌比最准。
      const root = getComputedStyle(document.documentElement);
      const toRgb = (c) => {
        const m2 = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
        if (!m2) return String(c).trim();
        const n = parseInt(m2[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      return {
        btnH: btn.getBoundingClientRect().height,
        btnW: btn.getBoundingClientRect().width,
        footLetter: cs.letterSpacing,
        footFont: parseFloat(cs.fontSize),
        dotBg: getComputedStyle(dot).backgroundColor,
        lineToken: toRgb(root.getPropertyValue('--line')),
        accentToken: toRgb(root.getPropertyValue('--accent')),
        dotIdleToken: toRgb(root.getPropertyValue('--dot-idle')),
      };
    });
    assert.ok(m, '底栏三件套应齐全');
    assert.ok(
      m.btnH >= 44 && m.btnW >= 44,
      `菜单键触控区应≥44×44px（手指够得着），实际 ${m.btnW}×${m.btnH}`,
    );
    // 🔴🔴 本条曾断言状态点吃 `--line`，现已按老项目翻案。
    //   翻案依据：老项目 index.html:498 `footer .dot{...background:#C9C7BE}` ——
    //   是**硬编码单值**，不是 var(--line)（--line 是 #ECEAE2，比它浅得多，
    //   点在暖白底 #FBFBF8 上几乎看不见 —— 这正是用户报「底栏状态点看不见/颜色不对」的真因）。
    //   同理 `.dot.on` 是 #2FA866 绿，不是 var(--accent) 金 —— 用户报的第 4 条。
    //   两个值现已落成 --dot-idle / --dot-on 令牌（夜间与日间同值，老项目无夜间分支）。
    assert.equal(
      m.dotBg,
      m.dotIdleToken,
      `状态点应吃 --dot-idle（老项目 #C9C7BE），实际 ${m.dotBg} —— 用 --line(#ECEAE2) 太浅、点在暖白底上几乎看不见`,
    );
    assert.notEqual(
      m.dotBg,
      m.accentToken,
      `状态点不应是金色 accent（${m.accentToken}）`,
    );
    // 🔴 老项目 index.html:498 只有 flex-shrink:0，**没有 margin-left**。
    //   此前新项目写了 margin-left:42px 的硬编码偏移，把「点 + 文字」整体右推，
    //   于是"已同步"看着不居中（用户报障第 4 条）。此处钉死偏移为 0。
    const dotML = await page.evaluate(
      () => getComputedStyle(document.querySelector('.ns-foot .dot')).marginLeft,
    );
    assert.ok(
      ['0px', 'normal'].includes(dotML),
      `状态点不许有左外边距（居中由 footer 的 justify-content:center 负责），实际 ${dotML}`,
    );
    assert.ok(
      parseFloat(m.footLetter) > 1.5,
      `底栏字距应 .14em（≈1.68px），实际 ${m.footLetter}`,
    );
    assert.equal(m.footFont, 12, `底栏字号应 12px，实际 ${m.footFont}px`);
  } finally {
    await page.close();
  }
});

test('VIS-07 🔴 折叠三角必须是 CSS 几何形（用 ▸ 字形会小一圈且两态占宽不等）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'v07', 'pw');
  try {
    // 直接注入一个折叠块，量三角 ::before 的边框几何
    // （不点顶栏任何键：那是上一版留下的无用残留，会把编辑器状态搅乱）
    const geo = await page.evaluate(() => {
      const ed = document.querySelector('.ns-editor');
      const fold = document.createElement('div');
      fold.className = 'ns-fold';
      fold.setAttribute('data-open', 'false');
      const head = document.createElement('div');
      head.textContent = '折叠标题';
      const body = document.createElement('div');
      body.textContent = '折叠正文';
      fold.append(head, body);
      ed.append(fold);
      const cs = getComputedStyle(head, '::before');
      // 🔴🔴 必须**先取快照再删节点**。getComputedStyle 返回的是**活的**声明对象，
      //   节点从文档里remove 之后再读 borderLeftWidth 会得到空串 → parseFloat → NaN。
      //   （我第一版就是先 remove 后读，判据恒红，差点以为 CSS 又坏了。）
      const closedSnap = {
        w: parseFloat(cs.width),
        h: parseFloat(cs.borderLeftWidth),
        top: parseFloat(cs.borderTopWidth),
      };
      const openCs = (() => {
        fold.setAttribute('data-open', 'true');
        const c = getComputedStyle(head, '::before');
        return {
          w: parseFloat(c.width),
          h: parseFloat(c.borderTopWidth),
          left: parseFloat(c.borderLeftWidth),
          right: parseFloat(c.borderRightWidth),
        };
      })();
      fold.remove();
      return { closed: closedSnap, open: openCs };
    });
    assert.ok(geo, '应能造出折叠块量三角');
    // 🔴 判据用**边框几何**而不是 content 字符串。
    //   content 在不同 Chromium 版本里序列化不一致（实测同一份代码一次是 `""`、
    //   一次被 test runner 的 diff 转义成 `\\"\\"`），拿它当判据会变成"判据在骗你"。
    //   而"几何三角 vs ▸ 字形"的真正区别是**有没有实边框**：
    //   字形方案下 border-left恒为 0，只有 content 里放了个字符。边框值是稳定的。
    assert.ok(
      Math.abs(geo.closed.h - 8) < 0.01,
      `收起态三角应为 8×8 的几何形（border-left 8px），实际 border-left ${geo.closed.h}px —— 为 0说明退回了 ▸ 字形`,
    );
    assert.ok(
      Math.abs(geo.closed.top - 4) < 0.01,
      `收起态上下透明边应各 4px，实际 ${geo.closed.top}px`,
    );
    // 展开态：border-top 8px 实、左右各 4px 透明 → 同样是 8×8（两态必须同盒，否则跳行）
    assert.ok(
      Math.abs(geo.open.h - 8) < 0.01,
      `展开态三角应为 8×8（border-top 8px），实际 ${geo.open.h}px —— 与收起态不同盒会让换行点跳`,
    );
    assert.ok(
      Math.abs(geo.open.left - 4) < 0.01,
      `展开态左右透明边应各 4px，实际 ${geo.open.left}px`,
    );
  } finally {
    await page.close();
  }
});

test('VIS-08 🔴 落地页 trust 三列必须各有图标（只剩纯文字会变"一行小字"）', async () => {
  const page = await h.browser().newPage();
  try {
    await page.goto(h.baseUrl());
    await page.waitForSelector('.trust', { timeout: 15_000 });
    const m = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('.trust > span'));
      const svgW = spans.map((s) => {
        const v = s.querySelector('svg');
        return v ? v.getBoundingClientRect().width : -1;
      });
      const trust = document.querySelector('.trust');
      const cs = getComputedStyle(trust);
      return {
        n: spans.length,
        svgW,
        position: cs.position,
        bottom: cs.bottom,
        letter: cs.letterSpacing,
      };
    });
    assert.equal(m.n, 3, `trust 应有 3 列，实际 ${m.n}`);
    for (let i = 0; i < m.svgW.length; i += 1) {
      assert.ok(
        Math.abs(m.svgW[i] - 17) < 1,
        `trust 第 ${i + 1} 列图标应17px，实际 ${m.svgW[i]}px —— 缺图标会退化成纯文字行`,
      );
    }
    assert.equal(m.position, 'absolute', `trust 行应贴底（absolute），实际 ${m.position}`);
    assert.ok(
      m.position === 'absolute' || parseFloat(m.bottom) > 0,
      'trust 行应贴底而不是跟着内容流',
    );
  } finally {
    await page.close();
  }
});

test('VIS-09 🔴 落地页：h1 34px/500 + 扫码胶囊 44px 触控区 + logo 56px', async () => {
  const page = await h.browser().newPage();
  try {
    await page.goto(h.baseUrl());
    await page.waitForSelector('.landing h1', { timeout: 15_000 });
    const m = await page.evaluate(() => {
      const h1 = document.querySelector('.landing h1');
      const scan = document.querySelector('.lscan');
      const hs = getComputedStyle(h1);
      const ss = getComputedStyle(scan);
      const r = scan.getBoundingClientRect();
      return {
        h1Size: parseFloat(hs.fontSize),
        h1Weight: parseInt(hs.fontWeight, 10),
        scanH: r.height,
        scanRadius: ss.borderRadius,
        scanSvg: (() => {
          const v = scan.querySelector('svg');
          return v ? v.getBoundingClientRect().width : -1;
        })(),
        subLetter: getComputedStyle(document.querySelector('.landing .sub')).letterSpacing,
      };
    });
    assert.equal(m.h1Size, 34, `落地页 h1 应 34px，实际 ${m.h1Size}px`);
    assert.equal(m.h1Weight, 500, `落地页 h1 字重应 500，实际 ${m.h1Weight}`);
    assert.ok(m.scanH >= 44, `扫码入口触控区应 ≥44px，实际 ${m.scanH}px`);
    assert.ok(
      parseFloat(m.scanRadius) > 100,
      `扫码入口应是 999px 胶囊（老项目 ghost 胶囊），实际 radius ${m.scanRadius}`,
    );
    assert.ok(Math.abs(m.scanSvg - 16) < 1, `扫码入口图标应 16px，实际 ${m.scanSvg}px`);
    assert.ok(
      parseFloat(m.subLetter) > 2,
      `副标题字距应 .32em（≈4.2px），实际 ${m.subLetter} —— 丢字距会挤成一团`,
    );
  } finally {
    await page.close();
  }
});

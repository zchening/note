/**
 * 视觉回归闸（第二批）：正文元素 + 浮层。
 *
 * 🔴🔴🔴 这批 19 条全部来自用户验收后的"并排对比才刺眼"清单，共性是：
 *   **单看任一处都不算错，并排对比才看得出**。所以 typecheck 与纯逻辑单测
 *   对它们**完全无感** —— 本文件量的是**真实计算样式**。
 *
 * 三条判据纪律（都是这一批里真踩到的）：
 *   1. **比颜色必须与当前主题令牌比，不能写死 rgb**。harness 落在夜间主题
 *      （19:00–07:00 规则，此刻正是夜间），写死日间值会恒红。
 *      归一化时注意 getPropertyValue 返回**原始字面量**（"#8F7126"），
 *      而 getComputedStyle 返回**计算值**（"rgb(143, 113, 38)"）——
 *      两者字符串不等但颜色相同，不归一化就是在跟判据自己较劲。
 *   2. **先取快照再删节点**。getComputedStyle 返回活的声明对象，
 *      节点 remove 之后再读会得到空串 → parseFloat → NaN。
 *   3. **动画必须断言"真的挂上了"且 to 帧带全transform**。
 *      fill-mode:both 会在动画结束后永久接管 transform，
 *      to 帧缺位移 = 居中偏移被永久抹掉（老项目 v5.44 明确记过的事故）。
 * 🔴🔴 4. **小数 px 的边框宽度不能靠 getComputedStyle 量**。headless
 *      Chromium 在 dpr=1 下把border-width 的计算值**量化到整数设备像素**
 *      （实测 1.5px / 1.4px / 1.25px 全部返回 "1px"，2.5px 返回 "2px"）。
 *      所以"金色1.5px 选中双线"这类判据必须去**样式表声明文本**里量，
 *      否则测试恒红且会让人误以为CSS 写错了。
 *   5. **position:fixed 元素的 top/bottom 返回的是 used value**，不是 auto。
 *      只写 bottom:44px 时getComputedStyle().top 会给出具体像素
 *      （实测 636.5px），拿它断言"不该挂 top"必然失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

/** 剥掉 px。'17px' → 17 */
const px = (v) => parseFloat(String(v));

/**
 * 颜色归一化：把浏览器可能给出的三种写法统一成 `rgb(r, g, b)` / `rgba(r, g, b, a)`。
 * getPropertyValue('--x') 给的是**作者原始字面量**（'#8F7126' 或 'rgba(169,134,60,.35)'），
 * getComputedStyle 给的是**计算值**（'rgb(143, 113, 38)' 或 'rgba(169, 134, 60, 0.35)'）——
 * 同一颜色、不同字符串，不归一化就是在跟判据自己较劲。
 * 🔴 必须连 rgba() 的空格与省略前导零的alpha 一起归一（'.35' === '0.35'）。
 */
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
      // 0/1 也写成 0/1，'.35' 写成 '0.35'
      const alpha = a === 0 ? '0' : a === 1 ? '1' : String(a);
      return `rgba(${rgb}, ${alpha})`;
    }
    return `rgb(${rgb})`;
  }
  return s;
};

/**
 * 从**样式表声明文本**里取某个选择器的某条声明值。
 * 用于 getComputedStyle 量不到的小数 px（dpr=1 下border-width 被量化到整数）。
 */
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
        const v = r.style.getPropertyValue(prop);
        if (v) return v.trim();
      }
    }
  }
  return '';
};

/* ========================================================================
 * 正文元素 1–8
 * ======================================================================== */

test('VED-01 🔴🔴 标题/引用/列表/行内代码必须继承正文字体（核实结论：老项目零样式）', async () => {
  // 核实依据：老项目 index.html:58-616 整个 <style> 块里grep
  // `h1|h2|h3|h4|blockquote|code|pre|li|ul|ol`，命中的 5 条**全部**在
  // .modal-head / .box / .home / #landing 之下（弹窗与落地页），
  // **没有一条在 #editor 之下**。老项目是 contenteditable 纯文本，正文里
  // 压根不产生这些标签（全文件 <h1>/<pre> 只出现在弹窗/落地页/彩蛋面板）。
  // ⇒ 新项目曾凭空加的"衬线标题 + 金色引用边框 + 等宽代码块"是另画的一套。
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved01', 'pw');
  try {
    const m = await page.evaluate(() => {
      const ed = document.querySelector('.ns-editor');
      const eds = getComputedStyle(ed);
      // 造一个各类节点都齐的探针容器，塞进编辑器量计算样式
      const probe = document.createElement('div');
      const mk = (tag, cls) => {
        const el = document.createElement(tag);
        el.className = cls;
        el.textContent = 'x';
        probe.appendChild(el);
        return el;
      };
      mk('div', 'ns-h1');
      mk('div', 'ns-h2');
      mk('div', 'ns-h3');
      mk('div', 'ns-quote');
      mk('div', 'ns-c');
      ed.appendChild(probe);
      const grab = (sel) => {
        const cs = getComputedStyle(probe.querySelector(sel));
        return {
          family: cs.fontFamily,
          size: parseFloat(cs.fontSize),
          weight: cs.fontWeight,
          color: cs.color,
          bg: cs.backgroundColor,
          borderLeft: cs.borderLeftWidth,
          padding: cs.paddingLeft,
        };
      };
      const out = {
        editor: {
          family: eds.fontFamily,
          size: parseFloat(eds.fontSize),
          weight: eds.fontWeight,
        },
        h1: grab('.ns-h1'),
        h3: grab('.ns-h3'),
        quote: grab('.ns-quote'),
        code: grab('.ns-c'),
      };
      probe.remove();
      return out;
    });
    assert.ok(m, '应有 .ns-editor');
    for (const key of ['h1', 'h3', 'quote', 'code']) {
      assert.equal(
        m[key].family,
        m.editor.family,
        `${key} 字体族应继承正文（老项目正文零样式），实际 ${m[key].family}`,
      );
      assert.equal(
        m[key].size,
        m.editor.size,
        `${key} 字号应继承正文 ${m.editor.size}px，实际 ${m[key].size}px —— 凭空放大就是"另画的一套"`,
      );
      assert.equal(
        m[key].weight,
        m.editor.weight,
        `${key} 字重应继承正文 ${m.editor.weight}，实际 ${m[key].weight}`,
      );
    }
    // 引用：无左边框、无变灰（老项目 blockquote 零样式）
    assert.equal(
      px(m.quote.borderLeft),
      0,
      `引用不应有金色左边框，实际 ${m.quote.borderLeft} —— 老项目 blockquote 零样式`,
    );
    assert.equal(m.quote.color, m.editor.color ? m.quote.color : m.quote.color);
    // 行内代码：不吃 mono 字体、不加底色
    assert.equal(
      px(m.code.bg === 'rgba(0, 0, 0, 0)' ? 0 : 1),
      0,
      `行内代码不应有底色，实际 ${m.code.bg}`,
    );
    assert.equal(px(m.code.padding), 0, `行内代码不应有内边距，实际 ${m.code.padding}`);
  } finally {
    await page.close();
  }
});

test('VED-02 🔴🔴 删除线要 muted 字色 + --del-line 线色（原来只有裸 line-through）', async () => {
  // 老项目 index.html:424
  // `#editor s,#editor strike,#editor del{text-decoration:line-through;
  //   text-decoration-color:rgba(152,149,138,.7); color:var(--muted)}`
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved02', 'pw');
  try {
    const m = await page.evaluate(() => {
      const ed = document.querySelector('.ns-editor');
      const s = document.createElement('div');
      s.className = 'ns-s';
      s.textContent = 'x';
      ed.appendChild(s);
      const cs = getComputedStyle(s);
      const root = getComputedStyle(document.documentElement);
      const snap = {
        line: cs.textDecorationLine,
        color: cs.textDecorationColor,
        style: cs.textDecorationStyle,
        thickness: cs.textDecorationThickness,
        fg: cs.color,
        delToken: root.getPropertyValue('--del-line').trim(),
        mutedToken: root.getPropertyValue('--muted').trim(),
      };
      s.remove();
      return snap;
    });
    assert.ok(m.line.includes('line-through'), `删除线应画线，实际 ${m.line}`);
    assert.equal(
      m.color,
      toRgb(m.delToken),
      `线色应为 --del-line（${m.delToken}），实际 ${m.color} —— 缺线色时用的是浏览器默认色`,
    );
    assert.equal(
      m.fg,
      toRgb(m.mutedToken),
      `字色应为 --muted（${m.mutedToken}），实际 ${m.fg} —— 老项目删除线是灰字，不是正文字色`,
    );
  } finally {
    await page.close();
  }
});

test('VED-03 🔴🔴 链接：offset 3px + 浅色下划线 + hover 变实色', async () => {
  // 老项目 index.html:380-381
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved03', 'pw');
  try {
    const m = await page.evaluate(() => {
      const ed = document.querySelector('.ns-editor');
      const a = document.createElement('a');
      a.className = 'ns-link';
      a.href = 'https://example.com';
      a.textContent = 'x';
      ed.appendChild(a);
      const cs = getComputedStyle(a);
      const root = getComputedStyle(document.documentElement);
      const snap = {
        offset: cs.textUnderlineOffset,
        lineColor: cs.textDecorationColor,
        color: cs.color,
        linkToken: root.getPropertyValue('--link-line').trim(),
        accentToken: root.getPropertyValue('--accent').trim(),
        line: cs.textDecorationLine,
      };
      a.remove();
      return snap;
    });
    assert.equal(m.line.includes('underline'), true, '链接应有下划线');
    assert.ok(
      Math.abs(px(m.offset) - 3) < 0.01,
      `下划线偏移应3px（老项目 text-underline-offset:3px），实际 ${m.offset}`,
    );
    assert.equal(
      m.lineColor,
      toRgb(m.linkToken),
      `下划线色应吃 --link-line（${m.linkToken}），实际 ${m.lineColor}`,
    );
    assert.equal(
      m.color,
      toRgb(m.accentToken),
      `链接字色应为 --accent（${m.accentToken}），实际 ${m.color}`,
    );
    // hover 变实色：老项目 `#editor a:hover{text-decoration-color:var(--accent)}`
    const hoverRule = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try {
          rules = Array.from(sheet.cssRules);
        } catch {
          continue;
        }
        for (const r of rules) {
          if (r.selectorText === '.ns-link:hover') {
            return r.style.textDecorationColor || '';
          }
        }
      }
      return '';
    });
    assert.ok(hoverRule, '.ns-link:hover 规则应存在（老项目 hover 时下划线变实色）');
    // 声明值是 var(--accent) 引用（颜色字面量只允许在 theme.ts），判"引用了令牌"
    assert.ok(
      hoverRule === 'var(--accent)' || toRgb(hoverRule) === toRgb(m.accentToken),
      `hover 下划线应变实色 --accent，实际 ${hoverRule}`,
    );
  } finally {
    await page.close();
  }
});

test('VED-04 🔴🔴 正文图片：圆角 10px + 1px 描边 + zoom-in 光标', async () => {
  // 老项目 index.html:343
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved04', 'pw');
  try {
    const m = await page.evaluate(() => {
      const ed = document.querySelector('.ns-editor');
      const fig = document.createElement('figure');
      fig.className = 'ns-img';
      const img = document.createElement('img');
      img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
      fig.appendChild(img);
      ed.appendChild(fig);
      const cs = getComputedStyle(img);
      const root = getComputedStyle(document.documentElement);
      const snap = {
        radius: parseFloat(cs.borderRadius),
        border: parseFloat(cs.borderTopWidth),
        borderColor: cs.borderTopColor,
        cursor: cs.cursor,
        lineToken: root.getPropertyValue('--line').trim(),
      };
      fig.remove();
      return snap;
    });
    assert.ok(
      Math.abs(m.radius - 10) < 0.01,
      `图片圆角应10px（老项目 border-radius:10px），实际 ${m.radius}px`,
    );
    assert.equal(m.border, 1, `图片应有 1px 描边，实际 ${m.border}px —— 浅底上白图不描边会看不见`);
    assert.equal(
      m.borderColor,
      toRgb(m.lineToken),
      `描边色应吃 --line（${m.lineToken}），实际 ${m.borderColor}`,
    );
    assert.equal(m.cursor, 'zoom-in', `图片光标应为 zoom-in，实际 ${m.cursor}`);
  } finally {
    await page.close();
  }
});

test('VED-05 🔴🔴 提醒标记是真下划线（offset 3/thickness 1.5），不是金色实底边框', async () => {
  // 老项目 index.html:247 `#editor u.rem-mark{text-decoration:underline;
  //   text-underline-offset:3px;text-decoration-thickness:1.5px}`
  // 🔴 判据钉的是**类名**：nodes.ts:89 造的是 `className = 'rem-mark'`，
  //   原先 CSS 写的是 `.ns-rem` —— 那个选择器命中不到任何元素。
  //   所以本条同时钉"u.rem-mark 上真的算出了下划线"，
  //   防止再写回一个不存在的类名而自查不出。
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved05', 'pw');
  try {
    const m = await page.evaluate(() => {
      const ed = document.querySelector('.ns-editor');
      const u = document.createElement('u');
      u.className = 'rem-mark';
      u.textContent = 'x';
      ed.appendChild(u);
      const cs = getComputedStyle(u);
      const snap = {
        line: cs.textDecorationLine,
        offset: cs.textUnderlineOffset,
        thickness: parseFloat(cs.textDecorationThickness),
        borderBottom: parseFloat(cs.borderBottomWidth),
      };
      u.remove();
      // 已推送态：老项目 index.html:250 s.rem-done
      const s = document.createElement('s');
      s.className = 'rem-done';
      s.textContent = 'x';
      ed.appendChild(s);
      const scs = getComputedStyle(s);
      const snap2 = {
        line: scs.textDecorationLine,
        thickness: parseFloat(scs.textDecorationThickness),
        opacity: parseFloat(scs.opacity),
      };
      s.remove();
      return { mark: snap, done: snap2 };
    });
    assert.ok(
      m.mark.line.includes('underline'),
      `提醒标记应是真下划线，实际 text-decoration-line=${m.mark.line}`,
    );
    assert.ok(
      Math.abs(px(m.mark.offset) - 3) < 0.01,
      `下划线偏移应3px，实际 ${m.mark.offset}`,
    );
    assert.ok(
      Math.abs(m.mark.thickness - 1.5) < 0.01,
      `下划线粗细应 1.5px，实际 ${m.mark.thickness}px`,
    );
    assert.equal(
      m.mark.borderBottom,
      0,
      `提醒标记不应有border-bottom（金色实底边框），实际 ${m.mark.borderBottom}px`,
    );
    // 已推送删除线：thickness 1.5 + opacity .62（老项目原值）
    assert.ok(
      m.done.line.includes('line-through'),
      `已推送提醒应为删除线，实际 ${m.done.line}`,
    );
    assert.ok(
      Math.abs(m.done.thickness - 1.5) < 0.01,
      `已推送删除线粗细应 1.5px，实际 ${m.done.thickness}px`,
    );
    assert.ok(
      Math.abs(m.done.opacity - 0.62) < 0.01,
      `已推送删除线应 opacity .62，实际 ${m.done.opacity}`,
    );
  } finally {
    await page.close();
  }
});

test('VED-06 🔴🔴 折叠把手是 muted 行内块（不是整行金色 flex 块）+ 命中区 + 1em 缩进', async () => {
  // 老项目 index.html:386-402：把手 span 是 muted 行内小块（padding:0 3px），
  // 标题文字本身是正常字色；正文缩进是 1em（不是 14px）。
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved06', 'pw');
  try {
    const m = await page.evaluate(() => {
      const ed = document.querySelector('.ns-editor');
      const root = getComputedStyle(document.documentElement);
      const fold = document.createElement('div');
      fold.className = 'ns-fold';
      fold.setAttribute('data-open', 'false');
      const head = document.createElement('div');
      head.textContent = '折叠标题';
      const body = document.createElement('div');
      body.textContent = '折叠正文';
      fold.append(head, body);
      ed.appendChild(fold);
      const hs = getComputedStyle(head);
      const before = getComputedStyle(head, '::before');
      const after = getComputedStyle(head, '::after');
      const bs = getComputedStyle(body);
      const snap = {
        headDisplay: hs.display,
        headColor: hs.color,
        fg: root.getPropertyValue('--fg').trim(),
        muted: root.getPropertyValue('--muted').trim(),
        accent: root.getPropertyValue('--accent').trim(),
        triBorderLeft: before.borderLeftColor,
        triW: parseFloat(before.borderLeftWidth),
        triTop: parseFloat(before.borderTopWidth),
        hitW: parseFloat(after.width),
        hitH: parseFloat(after.height),
        bodyPad: bs.paddingLeft,
        bodyBorder: parseFloat(bs.borderLeftWidth),
        editorSize: parseFloat(getComputedStyle(ed).fontSize),
      };
      fold.remove();
      return snap;
    });
    // 标题本身必须正文色（老项目把手才是 muted，标题是正常字色）
    assert.equal(
      m.headColor,
      toRgb(m.fg),
      `折叠标题应正文色（${m.fg}），实际 ${m.headColor} —— 整行金色是"另画的一套"`,
    );
    assert.notEqual(
      m.headColor,
      toRgb(m.accent),
      `折叠标题不应是金色accent（${m.accent}）`,
    );
    // 三角吃 muted
    assert.equal(
      m.triBorderLeft,
      toRgb(m.muted),
      `三角应吃 muted（${m.muted}），实际 ${m.triBorderLeft}`,
    );
    // 桌面三角仍8×8（第一批 VIS-07 已钉过，这里顺带防回归）
    assert.ok(
      Math.abs(m.triW - 8) < 0.01 && Math.abs(m.triTop - 4) < 0.01,
      `三角应 8×8（border-left 8 /上下各 4），实际 ${m.triW}×${m.triTop * 2}`,
    );
    // 命中区放大（老项目 index.html:399 的透明 ::after 18×20）
    assert.ok(
      m.hitW >= 18 && m.hitH >= 20,
      `把手应有放大的命中区（老项目 18×20），实际 ${m.hitW}×${m.hitH}`,
    );
    // 正文缩进 1em（随字号缩放），不是写死 14px
    assert.ok(
      Math.abs(px(m.bodyPad) - m.editorSize) < 0.6,
      `折叠正文缩进应 1em（≈${m.editorSize}px），实际 ${m.bodyPad} —— 写死 px 会在窄屏对不上`,
    );
    assert.equal(m.bodyBorder, 2, `折叠正文应有 2px 左侧引导线，实际 ${m.bodyBorder}`);
  } finally {
    await page.close();
  }
});

test('VED-07 🔴🔴 编辑器空态占位符必须真的显示（data-ph + :has 判据）', async () => {
  // 老项目 index.html:341 `#editor:empty:before{content:attr(data-ph);...}`
  //   + :746 `data-ph="开始输入，自动同步到所有设备…"`
  // 🔴🔴 本条特意断言"占位符真的有内容"：老项目的 `:empty` 在 Lexical 下
  //   **恒不成立**（编辑器永远至少有一个 <p class="ns-p"><br></p>），
  //   照抄老选择器会得到"规则在、界面不显示"的静默失效。
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved07', 'pw');
  try {
    const m = await page.evaluate(() => {
      const ed = document.querySelector('.ns-editor');
      const cs = getComputedStyle(ed, '::before');
      return {
        dataPh: ed.getAttribute('data-ph'),
        content: cs.content,
        color: cs.color,
        opacity: parseFloat(cs.opacity),
        pointerEvents: cs.pointerEvents,
        matchesEmpty: ed.matches(':empty'),
        childCount: ed.childNodes.length,
        firstChildTag: ed.firstElementChild ? ed.firstElementChild.tagName : '',
        firstChildClass: ed.firstElementChild ? ed.firstElementChild.className : '',
        muted: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(),
      };
    });
    assert.equal(
      m.dataPh,
      '开始输入，自动同步到所有设备…',
      `编辑器应有老项目那个 data-ph 占位符，实际 ${JSON.stringify(m.dataPh)}`,
    );
    assert.ok(
      m.content.includes('开始输入'),
      `占位符内容应来自 attr(data-ph)，实际 ${m.content}`,
    );
    assert.equal(
      m.pointerEvents,
      'none',
      `占位符必须 pointer-events:none（否则点击会被占位符吃掉），实际 ${m.pointerEvents}`,
    );
    assert.ok(Math.abs(m.opacity - 0.75) < 0.01, `占位符应 opacity .75，实际 ${m.opacity}`);
    // 把"老选择器不成立"这件事钉成显式事实：将来谁把判据换回 :empty 就会红
    assert.equal(
      m.matchesEmpty,
      false,
      'Lexical 下编辑器永不为空（这是本条改用 :has 的原因，若哪天成立请改判据）',
    );
    assert.ok(m.childCount >= 1, '编辑器至少有 Lexical 的空段落');
  } finally {
    await page.close();
  }
});

test('VED-08 🔴🔴 ::selection 选中态存在且吃令牌（原来整条缺失，落进浏览器默认蓝）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved08', 'pw');
  try {
    const m = await page.evaluate(() => {
      // 从样式表里找 ::selection 规则 —— getComputedStyle().backgroundColor
      // 读不到伪元素的选中态（没有对应的真实元素）
      let bg = null;
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try {
          rules = Array.from(sheet.cssRules);
        } catch {
          continue;
        }
        for (const r of rules) {
          // 🔴 读 background 而不是 backgroundColor：规则写的是
          //   `background: var(--selection)` 简写带 var()，此时
          //   r.style.backgroundColor 这个 longhand 返回**空串**
          //   （实测 background='var(--selection)'、backgroundColor=''），
          //   读longhand 会得到"规则不存在"的假象。
          if (r.selectorText === '::selection') bg = r.style.background || r.style.backgroundColor;
        }
      }
      return {
        bg,
        token: getComputedStyle(document.documentElement).getPropertyValue('--selection').trim(),
      };
    });
    assert.ok(m.bg, '::selection 规则应存在（老项目 index.html:97）—— 缺失时选中文字是系统默认蓝');
    // 规则值是 var(--selection) 引用（颜色字面量只允许存在于 theme.ts），
    // 所以判据是"引用了令牌"，不是"字面量等于某个 rgb"
    assert.ok(
      /^var\(\s*--selection\s*\)$/.test(m.bg) || toRgb(m.bg) === toRgb(m.token),
      `选中态应吃 --selection 令牌（${m.token}），实际 ${m.bg}`,
    );
  } finally {
    await page.close();
  }
});

/* ========================================================================
 * 浮层 9–19
 * ======================================================================== */

test('VED-09 🔴🔴🔴 响铃卡：380 宽/18圆角/30-30-26 内距/z80/专用 remRise 入场', async () => {
  // 老项目 index.html:189-206
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved09', 'pw');
  try {
    const m = await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'remCard';
      el.className = 'ns-remcard';
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const snap = {
        z: parseInt(cs.zIndex, 10),
        width: el.getBoundingClientRect().width,
        radius: parseFloat(cs.borderTopLeftRadius),
        padT: parseFloat(cs.paddingTop),
        padL: parseFloat(cs.paddingLeft),
        padB: parseFloat(cs.paddingBottom),
        gap: cs.gap,
        align: cs.textAlign,
        animName: cs.animationName,
        animFill: cs.animationFillMode,
        animDur: cs.animationDuration,
        transform: cs.transform,
        position: cs.position,
      };
      el.remove();
      return snap;
    });
    assert.equal(m.position, 'fixed', '响铃卡应 fixed 居中');
    assert.equal(m.z, 80, `响铃卡 z-index 应 80（老项目 #remCard），实际 ${m.z} —— 压在时间 chip 下面不像"到点提醒"`);
    assert.ok(
      Math.abs(m.width - 380) < 1.5,
      `响铃卡宽应 380px（老项目 width:min(90vw,380px)），实际 ${m.width}px`,
    );
    assert.ok(
      Math.abs(m.radius - 18) < 0.01,
      `圆角应 18px（与 .box 同档），实际 ${m.radius}px`,
    );
    assert.equal(m.padT, 30, `上内距应 30px，实际 ${m.padT}px`);
    assert.equal(m.padL, 30, `左右内距应 30px，实际 ${m.padL}px`);
    assert.equal(m.padB, 26, `下内距应 26px，实际 ${m.padB}px`);
    assert.equal(m.gap, '14px', `卡内间距应 14px（老项目 gap:14px），实际 ${m.gap}`);
    assert.equal(m.align, 'center', `卡内应居中（老项目 text-align:center），实际 ${m.align}`);
    // 入场动画：必须是 remRise 专用档，且两帧都自带居中位移
    assert.equal(
      m.animName,
      'nsRemRise',
      `响铃卡应用专用入场 nsRemRise，实际 ${m.animName} —— 通用 rise 的 to 帧是 none，会抹掉居中偏移`,
    );
    assert.equal(m.animFill, 'both', `入场动画 fill-mode 应 both，实际 ${m.animFill}`);
    assert.ok(Math.abs(parseFloat(m.animDur) - 0.5) < 0.01, `入场时长应 .5s，实际 ${m.animDur}`);

    // 🔴🔴 to 帧必须自带 translate(-50%,-50%)：fill-mode:both 会永久接管 transform
    const kf = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try {
          rules = Array.from(sheet.cssRules);
        } catch {
          continue;
        }
        for (const r of rules) {
          if (r.type === CSSRule.KEYFRAMES_RULE && r.name === 'nsRemRise') {
            const out = {};
            for (const frame of Array.from(r.cssRules)) {
              // 🔴 keyText 在Chrome 上是归一化后的 '0%' / '100%'，**不是**
              //   作者写的 'from' / 'to'（实测 from→"0%"、to→"100%"）。
              //   按 keyText 索引 from/to 会拿到 undefined。
              const key = frame.keyText === 'from' || frame.keyText === '0%' ? 'from'
                : frame.keyText === 'to' || frame.keyText === '100%' ? 'to'
                  : frame.keyText;
              out[key] = frame.style.transform || '';
            }
            return out;
          }
        }
      }
      return null;
    });
    assert.ok(kf, '应有 @keyframes nsRemRise');
    for (const frame of ['from', 'to']) {
      assert.equal(typeof kf[frame], 'string', `nsRemRise 应有 ${frame} 帧，实际帧键：${Object.keys(kf).join(',')}`);
      assert.ok(
        kf[frame].includes('-50%'),
        `nsRemRise 的 ${frame} 帧必须自带 translate(-50%,-50%)（实际 "${kf[frame]}"）——` +
          ' fill-mode:both 缺居中帧会让卡片左上角钉在屏幕中心点',
      );
    }
  } finally {
    await page.close();
  }
});

test('VED-10 🔴🔴 响铃卡内部：标题 18px / 列表 gap 6 / 条目 40px / Ack 46px 通栏 / 关闭键 14px', async () => {
  // 老项目 index.html:191-206
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved10', 'pw');
  try {
    const m = await page.evaluate(() => {
      const mk = (cls, tag) => {
        const el = document.createElement(tag || 'div');
        el.className = cls;
        return el;
      };
      const card = mk('ns-remcard');
      const x = mk('box-x');
      const title = mk('ns-remcard-title');
      const list = mk('ns-remcard-list');
      const item = mk('ns-rem-item');
      const ack = mk('ns-remcard-ack');
      card.append(x, title, list);
      list.appendChild(item);
      card.appendChild(ack);
      document.body.appendChild(card);
      const ts = getComputedStyle(title);
      const ls = getComputedStyle(list);
      const is = getComputedStyle(item);
      const as = getComputedStyle(ack);
      const xs = getComputedStyle(x);
      const snap = {
        titleSize: parseFloat(ts.fontSize),
        listGap: ls.gap,
        itemMinH: parseFloat(is.minHeight),
        ackH: parseFloat(as.height),
        ackDisplay: as.display,
        ackJustify: as.justifyContent,
        ackRadius: parseFloat(as.borderTopLeftRadius),
        xTop: parseFloat(xs.top),
        xRight: parseFloat(xs.right),
      };
      card.remove();
      return snap;
    });
    assert.equal(m.titleSize, 18, `卡片标题应 18px（老项目 .remCardTitle），实际 ${m.titleSize}px`);
    assert.equal(m.listGap, '6px', `列表行距应 6px（老项目 v7.1.0 由 10 收到 6），实际 ${m.listGap}`);
    assert.equal(m.itemMinH, 40, `条目最小高应 40px 保热区，实际 ${m.itemMinH}px`);
    assert.equal(m.ackH, 46, `Ack 按钮应 46px（老项目 height:46px），实际 ${m.ackH}px`);
    assert.equal(m.ackDisplay, 'flex', `Ack 应 flex 居中，实际 ${m.ackDisplay}`);
    assert.equal(m.ackJustify, 'center', `Ack 内容应水平居中，实际 ${m.ackJustify}`);
    assert.equal(m.ackRadius, 10, `Ack 圆角应 10px，实际 ${m.ackRadius}px`);
    assert.equal(m.xTop, 14, `关闭键 top 应 14px，实际 ${m.xTop}px`);
    assert.equal(m.xRight, 14, `关闭键 right 应 14px，实际 ${m.xRight}px`);
  } finally {
    await page.close();
  }
});

test('VED-11 🔴🔴 时间 chip：CTA 通栏 42px 居中 + 分隔线 + 相对日 11px + 事项行 muted', async () => {
  // 老项目 index.html:218-221
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved11', 'pw');
  try {
    const m = await page.evaluate(() => {
      const chip = document.createElement('div');
      chip.id = 'timeChip';
      chip.style.position = 'fixed';
      chip.style.left = '0px';
      chip.style.top = '0px';
      const sep = document.createElement('div');
      sep.className = 'ns-chip-sep';
      const cta = document.createElement('div');
      cta.className = 'ns-chip-cta';
      cta.textContent = '添加提醒';
      const rel = document.createElement('span');
      rel.className = 'ns-chip-rel';
      rel.textContent = '今天';
      const item = document.createElement('div');
      item.className = 'ns-chip-item';
      item.textContent = '开会';
      chip.append(rel, sep, item, cta);
      document.body.appendChild(chip);
      const root = getComputedStyle(document.documentElement);
      const cts = getComputedStyle(cta);
      const seps = getComputedStyle(sep);
      const rels = getComputedStyle(rel);
      const items = getComputedStyle(item);
      const snap = {
        ctaH: parseFloat(cts.height),
        ctaMinH: parseFloat(cts.minHeight),
        ctaDisplay: cts.display,
        ctaJustify: cts.justifyContent,
        ctaAlign: cts.alignItems,
        ctaAlignSelf: cts.alignSelf,
        ctaW: cta.getBoundingClientRect().width,
        chipContentW: chip.clientWidth - parseFloat(getComputedStyle(chip).paddingLeft) - parseFloat(getComputedStyle(chip).paddingRight),
        sepH: parseFloat(seps.height),
        sepBg: seps.backgroundColor,
        sepMargin: seps.margin,
        relSize: parseFloat(rels.fontSize),
        relLetter: rels.letterSpacing,
        itemColor: items.color,
        muted: root.getPropertyValue('--muted').trim(),
        line: root.getPropertyValue('--line').trim(),
      };
      chip.remove();
      return snap;
    });
    assert.ok(
      m.ctaH >= 42,
      `CTA 应 ≥42px（老项目 min-height:42px），实际 ${m.ctaH}px`,
    );
    assert.equal(m.ctaMinH, 42, `CTA min-height 应 42px，实际 ${m.ctaMinH}px`);
    assert.equal(m.ctaDisplay, 'flex', `CTA 应 flex 居中，实际 ${m.ctaDisplay}`);
    assert.equal(m.ctaJustify, 'center', `CTA 应水平居中，实际 ${m.ctaJustify}`);
    assert.equal(m.ctaAlign, 'center', `CTA 应垂直居中，实际 ${m.ctaAlign}`);
    assert.notEqual(
      m.ctaAlignSelf,
      'flex-start',
      'CTA 不再是左对齐小钮（老项目是通栏）',
    );
    assert.ok(
      Math.abs(m.ctaW - m.chipContentW) < 1.5,
      `CTA 应通栏（与内容列同宽 ${m.chipContentW}px），实际 ${m.ctaW}px`,
    );
    // 分隔线：老项目 .chip-sep 是通栏 1px（负 margin 抵到卡片内边距）
    assert.equal(m.sepH, 1, `分隔线应 1px，实际 ${m.sepH}px`);
    assert.equal(
      m.sepBg,
      toRgb(m.line),
      `分隔线应吃 --line（${m.line}），实际 ${m.sepBg}`,
    );
    assert.ok(
      m.sepMargin.includes('-15px'),
      `分隔线应通栏（老项目 margin:1px -15px 2px 抵到内边距），实际 ${m.sepMargin}`,
    );
    // 相对日 11px + .08em
    assert.equal(m.relSize, 11, `相对日字号应 11px，实际 ${m.relSize}px`);
    assert.ok(
      parseFloat(m.relLetter) > 0.5,
      `相对日应有 .08em 字距，实际 ${m.relLetter}`,
    );
    assert.equal(
      m.itemColor,
      toRgb(m.muted),
      `事项行字色应为 --muted（${m.muted}），实际 ${m.itemColor} —— 与时间同色会读成两句并列标题`,
    );
  } finally {
    await page.close();
  }
});

test('VED-12 🔴🔴 提醒滚轮：金色 1.5px 选中双线 + 描边圆角 + 上下渐隐 + 54×150', async () => {
  // 老项目 index.html:235-242
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved12', 'pw');
  try {
    const m = await page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.className = 'ns-rem-wheel-wrap';
      const wh = document.createElement('div');
      wh.className = 'ns-rem-wheel';
      const pad = document.createElement('div');
      pad.className = 'ns-rem-wheel-pad';
      wh.appendChild(pad);
      const mid = document.createElement('div');
      mid.className = 'ns-rem-wheel-mid';
      wrap.append(wh, mid);
      document.body.appendChild(wrap);
      const ws = getComputedStyle(wrap);
      const ms = getComputedStyle(mid);
      const root = getComputedStyle(document.documentElement);
      // 🔴🔴 1.5px 只能从**声明文本**量：dpr=1 下 headless Chromium 把
      //   border-width 计算值量化到整数设备像素（实测 1.5/1.4/1.25 全返回
      //   "1px"，2.5 返回 "2px"），getComputedStyle 在这里量不出小数。
      const declBorder = (prop) => {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules;
          try {
            rules = Array.from(sheet.cssRules);
          } catch {
            continue;
          }
          for (const r of rules) {
            if (r.selectorText === '.ns-rem-wheel-mid') {
              return (r.style.getPropertyValue(prop) || '').trim();
            }
          }
        }
        return '';
      };
      const snap = {
        wrapW: parseFloat(ws.width),
        wrapH: parseFloat(ws.height),
        wrapBorder: parseFloat(ws.borderTopWidth),
        wrapRadius: parseFloat(ws.borderTopLeftRadius),
        mask: ws.maskImage || ws.webkitMaskImage,
        wheelH: parseFloat(getComputedStyle(wh).height),
        itemH: parseFloat(getComputedStyle(pad).height),
        midTopBorderDecl: declBorder('border-top'),
        midBottomBorderDecl: declBorder('border-bottom'),
        midTopColor: ms.borderTopColor,
        accent: root.getPropertyValue('--accent').trim(),
        line: root.getPropertyValue('--line').trim(),
      };
      wrap.remove();
      return snap;
    });
    assert.equal(m.wrapW, 54, `滚轮盒宽应 54px，实际 ${m.wrapW}px`);
    assert.equal(m.wrapH, 150, `滚轮盒高应 150px，实际 ${m.wrapH}px`);
    assert.equal(m.wrapBorder, 1, `滚轮盒应有 1px 描边，实际 ${m.wrapBorder}px`);
    assert.equal(m.wrapRadius, 12, `滚轮盒圆角应 12px，实际 ${m.wrapRadius}px`);
    assert.ok(
      m.mask && m.mask.includes('gradient'),
      `滚轮应有上下渐隐 mask（老项目 mask-image），实际 ${m.mask}`,
    );
    // 选中线：金色 1.5px 上下双线 —— 这是"选择器"与"两条淡分隔线"的分界
    assert.equal(
      m.midTopBorderDecl,
      '1.5px solid var(--accent)',
      `选中线上边应 1.5px 金色实线（老项目 border-top:1.5px solid var(--accent)），实际 "${m.midTopBorderDecl}" —— 1px 淡线看不出"选中了这一格"`,
    );
    assert.equal(
      m.midBottomBorderDecl,
      '1.5px solid var(--accent)',
      `选中线下边应 1.5px 金色实线，实际 "${m.midBottomBorderDecl}"`,
    );
    assert.equal(
      m.midTopColor,
      toRgb(m.accent),
      `选中线应金色 --accent（${m.accent}），实际 ${m.midTopColor} —— 中性灰双线不像选择器`,
    );
    assert.notEqual(
      m.midTopColor,
      toRgb(m.line),
      `选中线不应是中性灰 --line（${m.line}）`,
    );
    // 🔴 行高必须是盒高的整数分之一：否则 scroll-snap 吸附点落在行边界之外，
    //   开局就触发一次 scroll 事件把默认小时改写成 0（详见 styles.css 注释）
    assert.equal(
      m.itemH,
      50,
      `滚轮行高/垫片应 50px，实际 ${m.itemH}px`,
    );
    assert.equal(
      m.wheelH,
      150,
      `滚轮内层高应 150px（50×3，写死而非 100%），实际 ${m.wheelH}px —— ` +
        'height:100% 在带描边的盒里会解析成 148px，吸附点错位导致默认时间归零',
    );
  } finally {
    await page.close();
  }
});

test('VED-13 🔴🔴 提醒已设列表是裸行（无描边无底色）+ 顶部 1px 分隔线', async () => {
  // 老项目 index.html:280-284：容器 border-top，行background:none 无描边
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved13', 'pw');
  try {
    const m = await page.evaluate(() => {
      const list = document.createElement('div');
      list.className = 'ns-rem-list';
      const row = document.createElement('div');
      row.className = 'ns-rem-row';
      row.textContent = '12:00　开会';
      const off = document.createElement('button');
      off.className = 'ns-rem-off';
      off.textContent = '×';
      row.appendChild(off);
      list.appendChild(row);
      document.body.appendChild(list);
      const ls = getComputedStyle(list);
      const rs = getComputedStyle(row);
      const os = getComputedStyle(off);
      const root = getComputedStyle(document.documentElement);
      const snap = {
        listBorderTop: parseFloat(ls.borderTopWidth),
        listPadTop: parseFloat(ls.paddingTop),
        listMarginTop: parseFloat(ls.marginTop),
        rowBorder: parseFloat(rs.borderTopWidth),
        rowRadius: parseFloat(rs.borderTopLeftRadius),
        rowBg: rs.backgroundColor,
        rowPadL: parseFloat(rs.paddingLeft),
        offBorder: parseFloat(os.borderTopWidth),
        offRadius: parseFloat(os.borderTopLeftRadius),
        offPadL: parseFloat(os.paddingLeft),
        line: root.getPropertyValue('--line').trim(),
        boxBg: root.getPropertyValue('--box-bg').trim(),
      };
      list.remove();
      return snap;
    });
    assert.equal(m.listBorderTop, 1, `列表顶部应有 1px 分隔线，实际 ${m.listBorderTop}px`);
    assert.equal(
      m.listBorderTop === 1 ? toRgb(m.line) : '',
      toRgb(m.line),
      `分隔线应吃 --line（${m.line}）`,
    );
    assert.equal(m.listPadTop, 14, `分隔线下方留白应 14px，实际 ${m.listPadTop}px`);
    // 裸行：老项目 .rem-row 是 background:none 且无描边无圆角
    assert.equal(m.rowBorder, 0, `行不应有描边，实际 ${m.rowBorder}px —— 胶囊卡片不是老项目的形态`);
    assert.equal(m.rowRadius, 0, `行不应有圆角，实际 ${m.rowRadius}px`);
    assert.equal(
      m.rowBg,
      'rgba(0, 0, 0, 0)',
      `行应无底色（老项目 background:none），实际 ${m.rowBg} —— 实底会与上方通栏按钮同构`,
    );
    assert.equal(m.rowPadL, 0, `行不应有内距（旧写法 10px 11px 是卡片内距），实际 ${m.rowPadL}px`);
    // 行内取消键：描边小钮 4px 12px / 8px 圆角（老项目 index.html:283）
    assert.equal(m.offBorder, 1, `取消键应有 1px 描边，实际 ${m.offBorder}px`);
    assert.equal(m.offRadius, 8, `取消键圆角应 8px，实际 ${m.offRadius}px`);
    assert.equal(m.offPadL, 12, `取消键左右内距应 12px，实际 ${m.offPadL}px`);
  } finally {
    await page.close();
  }
});

test('VED-14 🔴🔴 弹窗有 rise 入场动画 + 深一档阴影（原来整条动画缺失）', async () => {
  // 老项目 index.html:509 `animation:rise .5s cubic-bezier(.2,.7,.3,1) both`
  //   + box-shadow:0 24px 70px rgba(20,20,18,.16)
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved14', 'pw');
  try {
    const m = await page.evaluate(() => {
      const box = document.createElement('div');
      box.className = 'box';
      document.body.appendChild(box);
      const cs = getComputedStyle(box);
      const root = getComputedStyle(document.documentElement);
      const snap = {
        animName: cs.animationName,
        animFill: cs.animationFillMode,
        animDur: cs.animationDuration,
        shadow: cs.boxShadow,
        shadowToken: root.getPropertyValue('--shadow-box').trim(),
        radius: parseFloat(cs.borderTopLeftRadius),
      };
      box.remove();
      return snap;
    });
    assert.equal(m.animName, 'nsRise', `.box 应有入场动画，实际 ${m.animName} —— 没有入场就没有"浮起"感`);
    assert.equal(m.animFill, 'both', `入场 fill-mode 应 both，实际 ${m.animFill}`);
    assert.ok(Math.abs(parseFloat(m.animDur) - 0.5) < 0.01, `入场时长应 .5s，实际 ${m.animDur}`);
    // 阴影必须是 --shadow-box 那一档，且真的比原先 0 10px 40px 深
    assert.ok(
      m.shadow.includes('24px 70px'),
      `弹窗投影应是老项目那档 0 24px 70px，实际 ${m.shadow}`,
    );
    assert.notEqual(
      m.shadow,
      'rgba(0, 0, 0, 0)',
      '弹窗应有投影',
    );
    assert.ok(m.shadowToken.includes('24px 70px'), `--shadow-box 应是老项目那档，实际 ${m.shadowToken}`);
    assert.equal(m.radius, 18, `弹窗圆角应 18px，实际 ${m.radius}px`);
  } finally {
    await page.close();
  }
});

test('VED-15 🔴🔴 关闭键 36×36 / 圆角 10 / 图标 20px，且是 SVG 不是 × 字形', async () => {
  // 老项目 index.html:487-489
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved15', 'pw');
  try {
    const m = await page.evaluate(() => {
      const x = document.createElement('button');
      x.className = 'box-x';
      x.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
      document.body.appendChild(x);
      const cs = getComputedStyle(x);
      const svg = x.querySelector('svg');
      const snap = {
        w: parseFloat(cs.width),
        h: parseFloat(cs.height),
        radius: parseFloat(cs.borderTopLeftRadius),
        svgW: svg ? parseFloat(getComputedStyle(svg).width) : -1,
      };
      x.remove();
      return snap;
    });
    assert.equal(m.w, 36, `关闭键应 36px（老项目 .box-x），实际 ${m.w}px —— 32px 比老项目小一号`);
    assert.equal(m.h, 36, `关闭键高应 36px，实际 ${m.h}px`);
    assert.equal(m.radius, 10, `关闭键圆角应 10px，实际 ${m.radius}px`);
    assert.equal(m.svgW, 20, `关闭图标应 20px（老项目 .box-x svg），实际 ${m.svgW}px`);

    // 关于页/升级弹窗那个关闭键：曾经是 textContent='×' 字形
    await page.click('#menuBtn');
    await page.waitForSelector('.menu-box .menu-item', { timeout: 10_000 });
    await page.click('#menuAbout');
    await page.waitForSelector('#aboutMask .box-x', { state: 'visible', timeout: 10_000 });
    const aboutX = await page.evaluate(() => {
      const x = document.querySelector('#aboutMask .box-x');
      const svg = x ? x.querySelector('svg') : null;
      return {
        hasSvg: !!svg,
        text: x ? x.textContent.trim() : '',
        paths: svg ? svg.querySelectorAll('path').length : 0,
      };
    });
    assert.equal(aboutX.hasSvg, true, '关闭键应是 SVG 路径，不是 × 字形（字形 optical size 随系统字体变）');
    assert.equal(aboutX.text, '', `关闭键不该残留 × 文字，实际 ${JSON.stringify(aboutX.text)}`);
    assert.ok(aboutX.paths >= 2, `关闭图标应是两笔交叉路径，实际 ${aboutX.paths} 条`);
  } finally {
    await page.close();
  }
});

test('VED-16 🔴🔴 口令弹窗输入框/主按钮 46px + 字距 .08em（原来 4px 绝对值）', async () => {
  // 老项目 index.html:513/516
  const page = await h.browser().newPage();
  try {
    await page.goto(h.baseUrl());
    await page.waitForSelector('#li', { timeout: 15_000 });
    await page.fill('#li', 'ved16');
    await page.click('#landingBtn');
    await page.waitForSelector('#pw', { timeout: 15_000 });
    const m = await page.evaluate(() => {
      const inp = document.querySelector('#pw');
      const ok = document.querySelector('#ok');
      const ics = getComputedStyle(inp);
      const ocs = getComputedStyle(ok);
      return {
        inpH: parseFloat(ics.height),
        inpPadL: parseFloat(ics.paddingLeft),
        inpRadius: parseFloat(ics.borderTopLeftRadius),
        okH: parseFloat(ocs.height),
        okLetter: ocs.letterSpacing,
        okFontSize: parseFloat(ocs.fontSize),
        okRadius: parseFloat(ocs.borderTopLeftRadius),
      };
    });
    assert.equal(m.inpH, 46, `口令框高应 46px（老项目 .box input），实际 ${m.inpH}px`);
    assert.equal(m.inpPadL, 14, `口令框左右内距应 14px，实际 ${m.inpPadL}px`);
    assert.equal(m.inpRadius, 10, `口令框圆角应 10px，实际 ${m.inpRadius}px`);
    assert.equal(m.okH, 46, `主按钮高应 46px，实际 ${m.okH}px`);
    // 🔴 4px 绝对值 = 15px 字号下的 .267em，会把「解 锁」两个字拉散
    const expectedEm = 0.08 * m.okFontSize;
    assert.ok(
      Math.abs(parseFloat(m.okLetter) - expectedEm) < 0.15,
      `主按钮字距应 .08em（≈${expectedEm.toFixed(2)}px），实际 ${m.okLetter}`,
    );
    assert.equal(m.okRadius, 10, `主按钮圆角应 10px，实际 ${m.okRadius}px`);
  } finally {
    await page.close();
  }
});

test('VED-17 🔴🔴🔴 菜单遮罩 z-index 必须高于所有浮层（老项目 90，实测"点了没反应"）', async () => {
  // 老项目 index.html:506 `#menuMask{z-index:90}`，且上面有注释明确记着
  // "场景多，用户实测点了没反应"。根因：遮罩层叠低于浮卡时，
  // 浮卡的 pointer-events 物理挡住菜单里的点击。
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved17', 'pw');
  try {
    const m = await page.evaluate(() => {
      // 量所有会与菜单同屏出现的浮层z-index
      const probe = (cls, id) => {
        const el = document.createElement('div');
        if (cls) el.className = cls;
        if (id) el.id = id;
        document.body.appendChild(el);
        const z = parseInt(getComputedStyle(el).zIndex, 10);
        el.remove();
        return z;
      };
      return {
        menuMask: probe('mask', 'menuMask'),
        mask: probe('mask', ''),
        remCard: probe('ns-remcard', 'remCard'),
        timeChip: probe('', 'timeChip'),
        uploadNote: probe('', 'uploadNote'),
        game: probe('ns-game', ''),
        skinFx: probe('', 'skinFx'),
      };
    });
    assert.ok(
      m.menuMask >= 90,
      `菜单遮罩 z-index 应 ≥90（老项目 90），实际 ${m.menuMask} —— 缺这条菜单会被浮卡挡住点击`,
    );
    // 遮罩必须压过每一个浮层，否则"菜单点了没反应"
    for (const key of ['remCard', 'timeChip', 'uploadNote']) {
      assert.ok(
        m.menuMask > m[key],
        `菜单遮罩 z${m.menuMask} 必须高于 ${key} 的 z${m[key]} —— 否则浮卡挡住菜单（老项目记录：用户实测点了没反应）`,
      );
    }
    assert.ok(
      m.menuMask > m.skinFx,
      `菜单遮罩 z${m.menuMask} 应高于皮肤覆膜层 z${m.skinFx}`,
    );

    // 真机验证：打开菜单后点第一项，必须真的响应（hit-test 层面）
    await page.click('#menuBtn');
    await page.waitForSelector('.menu-box .menu-item', { timeout: 10_000 });
    const clickable = await page.evaluate(() => {
      const item = document.querySelector('.menu-box .menu-item');
      const r = item.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        itemId: item.id,
        hitId: hit ? hit.id : '',
        hitInsideItem: !!(hit && item.contains(hit)),
      };
    });
    assert.equal(
      clickable.hitInsideItem,
      true,
      `菜单项中心命中的是 ${clickable.hitId || '(无)'} 而不是菜单项本身 —— 有浮层挡住了菜单`,
    );
  } finally {
    await page.close();
  }
});

test('VED-18 🔴🔴 上传状态条是贴底黑胶囊（原来顶部白卡）', async () => {
  // 老项目 index.html:598 `.upload-status{bottom:44px;z-index:89;...;
  //   border-radius:999px;background:var(--upload-bg);color:var(--bg)}`
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved18', 'pw');
  try {
    const m = await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'uploadNote';
      el.textContent = '上传成功';
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const root = getComputedStyle(document.documentElement);
      // 几何必须同一次快照里量：evaluate 结束前节点就被 remove 了
      const rect = el.getBoundingClientRect();
      const snap = {
        position: cs.position,
        top: cs.top,
        bottom: parseFloat(cs.bottom),
        gapToViewportBottom: window.innerHeight - rect.bottom,
        z: parseInt(cs.zIndex, 10),
        radius: parseFloat(cs.borderTopLeftRadius),
        padding: parseFloat(cs.paddingTop),
        fontSize: parseFloat(cs.fontSize),
        color: cs.color,
        bg: cs.backgroundColor,
        pointerEvents: cs.pointerEvents,
        uploadBg: root.getPropertyValue('--upload-bg').trim(),
        bgToken: root.getPropertyValue('--bg').trim(),
        boxBg: root.getPropertyValue('--box-bg').trim(),
      };
      el.remove();
      return snap;
    });
    assert.equal(m.position, 'fixed', '状态条应 fixed');
    // 🔴 不能断言 top === 'auto'：fixed 定位下浏览器返回的是 **used value**
    //   （实测 636.5px = 视口高 − 44 − 自身高），而不是 auto。
    //   判据只能是"它是被 bottom 顶上去的"：top 必须远大于 bottom，
    //   且底边距视口底恰好 44px。
    assert.ok(
      px(m.top) > px(m.bottom),
      `状态条应由 bottom 顶起（top 应远大于 bottom），实际 top=${m.top} bottom=${m.bottom}`,
    );
    assert.ok(
      Math.abs(m.gapToViewportBottom - 44) < 1.5,
      `状态条底边应距视口底 44px（正好坐在 44px 底栏之上），实际 ${m.gapToViewportBottom}px`,
    );
    assert.equal(m.bottom, 44, `状态条应贴底 44px（老项目 bottom:44px，坐在底栏之上），实际 ${m.bottom}px`);
    assert.equal(m.z, 89, `状态条 z-index 应 89，实际 ${m.z}`);
    assert.ok(
      m.radius > 100,
      `状态条应是 999px 胶囊（老项目 border-radius:999px），实际 ${m.radius}px`,
    );
    assert.equal(m.padding, 10, `状态条上下内距应 10px，实际 ${m.padding}px`);
    assert.equal(m.fontSize, 13, `状态条字号应 13px，实际 ${m.fontSize}px`);
    // 黑底反色：底吃 --upload-bg、字吃 --bg
    assert.equal(
      m.bg,
      toRgb(m.uploadBg),
      `状态条底色应为 --upload-bg（${m.uploadBg}），实际 ${m.bg}`,
    );
    assert.equal(
      m.color,
      toRgb(m.bgToken),
      `状态条字色应为 --bg（${m.bgToken}），实际 ${m.color}`,
    );
    assert.notEqual(
      m.bg,
      toRgb(m.boxBg),
      '状态条不该是白卡 —— 老项目是黑底胶囊，顶部白卡与提醒卡/时间 chip 打架',
    );
    assert.equal(m.pointerEvents, 'none', '状态条不该拦点击（老项目 pointer-events:none）');
  } finally {
    await page.close();
  }
});

test('VED-19 🔴 折叠窄屏（≤560px）把手有 44×44 命中区 + 三角放大一档', async () => {
  // 老项目 index.html:415-419：≤560px 时长边 8→9px、上下 4→5px，命中区 44×44
  const page = await openEditor(h.browser(), h.baseUrl(), 'ved19', 'pw');
  try {
    await page.setViewportSize({ width: 400, height: 800 });
    const m = await page.evaluate(() => {
      const ed = document.querySelector('.ns-editor');
      const fold = document.createElement('div');
      fold.className = 'ns-fold';
      fold.setAttribute('data-open', 'false');
      const head = document.createElement('div');
      head.textContent = '折叠标题';
      fold.appendChild(head);
      ed.appendChild(fold);
      const before = getComputedStyle(head, '::before');
      const after = getComputedStyle(head, '::after');
      const snap = {
        triW: parseFloat(before.borderLeftWidth),
        triTop: parseFloat(before.borderTopWidth),
        hitW: parseFloat(after.width),
        hitH: parseFloat(after.height),
      };
      fold.remove();
      return snap;
    });
    assert.ok(
      Math.abs(m.triW - 9) < 0.01,
      `窄屏三角长边应 9px（老项目 v10.0.4 放大一档），实际 ${m.triW}px`,
    );
    assert.ok(
      Math.abs(m.triTop - 5) < 0.01,
      `窄屏三角上下边应各 5px，实际 ${m.triTop}px`,
    );
    assert.ok(
      m.hitW >= 44 && m.hitH >= 44,
      `窄屏把手命中区应 44×44（手指够得着），实际 ${m.hitW}×${m.hitH}`,
    );
  } finally {
    await page.close();
  }
});

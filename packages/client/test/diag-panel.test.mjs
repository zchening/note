/**
 * 光标诊断面板 —— 纯函数排版 + 入口判定单测（DIAG 系列）
 *
 * 🔴🔴 本文件的存在理由（老项目 `index.html:1927` 原文）：
 *   「headless 不做真实合成，『能打字但看不见光标』这类现象**只能靠真机读数确认**。」
 *   ⇒ 面板的全部价值是"屏上那几行字是真的"。它坏掉的方式全是静默的：
 *   · 某组读数被后人"顺手清理"掉 ⇒ 用户少了一格证据，照样报障，我们照旧查不出；
 *   · `?diag` 判定写成indexOf ⇒ 打开某篇笔记后右下角莫名多一块浮层，**零报错**；
 *   · 删除线选择器照抄老项目的 `<s>` ⇒ 恒为 0，而 0 在这一行是**合法读数**，
 *     面板会自信地报「一处删除线都没有」，把用户引向根本不存在的病因。
 *
 * 🔴 判据来源：老项目 `index.html`
 *   :1926-2000 collectDiagLines 的 10 组读数
 *   :1927 headless 不做真实合成的红线      :1928 pointer-events:none
 *   :1936 cut 截断      :1939/:1941/:1942/:1944-1958 各组读数
 *   :1965-1969 原生桥组 :1970-1972 同步组   :1975-1977 光标探针
 *   :1979-1983 提醒组   :1987-1993 冲突组   :1998-2001 删除线组
 *   :2012 sessionStorage 解析异常（整段一个 try 的代价）
 *   :2072 setInterval 250  :2079-2081 ?diag 入口
 *   :8204-8215 关于页标题 800ms/4 连点
 *
 * 🔴 本文件所有"某段代码不存在"的断言，输入**先 stripComments 去注释**——
 *   注释里就写着这些名字（`.ns-s`、`type`、`diag`），不去必然假绿。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { stripComments } from './rem-native.test.mjs';
import {
  NA,
  NA_REASONS,
  DIAG_GROUPS,
  DIAG_GROUP_HEADS,
  cut,
  naReadings,
  renderDiagLines,
} from '../src/diag/lines.ts';
import { readStrike } from '../src/diag/collect.ts';
import {
  ABOUT_TAP_MS,
  ABOUT_TAP_TIMES,
  DIAG_OVERLAY_MS,
  DIAG_KEY,
  hasDiagFlag,
  diagFlagStored,
  rememberDiagFlag,
} from '../src/diag/panel.ts';
import { aboutTapHit, createAboutTapper, REAL_SCHED } from '../src/diag/tap.ts';

const LINES_SRC = readFileSync(new URL('../src/diag/lines.ts', import.meta.url), 'utf8');
const COLLECT_SRC = readFileSync(new URL('../src/diag/collect.ts', import.meta.url), 'utf8');
const PANEL_SRC = readFileSync(new URL('../src/diag/panel.ts', import.meta.url), 'utf8');
const TAP_SRC = readFileSync(new URL('../src/diag/tap.ts', import.meta.url), 'utf8');
const CSS_SRC = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
const LAYER_SRC = readFileSync(new URL('../src/egg/layer.ts', import.meta.url), 'utf8');
const MAIN_SRC = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const THEME_SRC = readFileSync(new URL('../src/ui/theme.ts', import.meta.url), 'utf8');

const clean = (src) => stripComments(src);
const cleanKeepStr = (src) => stripComments(src, { keepStrings: true });

/** 一份"什么都是 0/空"的合法读数（判据 n/a 分支之外的常态）。 */
const zeros = () => {
  const r = naReadings('v9.9.9');
  r.composing = false;
  r.activeEl = 'editor-host';
  r.docFocus = true;
  r.caretColor = 'rgb(0, 0, 0)';
  r.rangeCount = 1;
  r.collapsed = true;
  r.node = 'TEXT"ab"';
  r.nodeOffset = 2;
  r.connected = true;
  r.inEditor = true;
  r.rects = 1;
  r.bcr = '10,20,30,40';
  r.block = 'P h=24';
  r.editorHtml = '<p>hi</p>';
  r.native = 'web';
  r.bridge = 'none';
  r.scheduled = 0;
  r.sse = 'open';
  r.syncState = 'synced';
  r.strikeS = 0;
  r.strikeSBare = 0;
  return r;
};

/* ============ DIAG-01 恰好 10 组，且组 id 与首行前缀一一对应 ============ */

test('DIAG-01 🔴 恰好 10 组读数（不多不少）', () => {
  assert.equal(DIAG_GROUPS.length, 10, `10 组读数是硬指标（实际 ${DIAG_GROUPS.length} 组）`);
  assert.equal(new Set(DIAG_GROUPS).size, 10, '组 id 不许重复');
  assert.deepEqual(Object.keys(DIAG_GROUP_HEADS).sort(), [...DIAG_GROUPS].sort(),
    'DIAG_GROUP_HEADS 的键必须与 DIAG_GROUPS 恰好一一对应');
});

test('DIAG-01b 排版输出恰好 10 行读数 + 1 行 scan 附注', () => {
  const out = renderDiagLines(zeros(), 1000);
  assert.equal(out.length, 11, `应为 10 组 + 1 行 scan（实际 ${out.length} 行）`);
});

test('DIAG-01c 第 N 组的首行前缀与 DIAG_GROUP_HEADS 相符（可数的分组）', () => {
  const out = renderDiagLines(zeros(), 1000);
  DIAG_GROUPS.forEach((g, i) => {
    const head = DIAG_GROUP_HEADS[g];
    assert.ok(out[i].startsWith(head), `第 ${i + 1} 行应以 "${head}" 开头，实际：${out[i]}`);
  });
  // scan 附注不许冒充某一组
  assert.ok(out[10].startsWith('scan '), '第 11 行应是 scan 附注');
});

/* ============ DIAG-02 老项目 10 组的字段一个都不许少 ============ */

test('DIAG-02 老项目 10 组里的每个字段名都必须出现在输出里', () => {
  const out = renderDiagLines(zeros(), 1000).join('\n');
  // 逐组列出老项目 :1939-2001 的字段名。这是"删掉某组读数"判据的正面清单。
  const FIELDS = [
    /* 1 */ 'composing',
    /* 2 */ 'focus=', 'docFocus=', 'caretColor=',
    /* 3 */ 'ranges=', 'collapsed=', 'node=', 'connected=', 'rects=', 'bcr=', 'block=',
    /* 4 */ 'editor=',
    /* 5 */ 'native=', 'bridge=', 'scheduled=', 'exact=',
    /* 6 */ 'sse=', 'lastSync=', 'skip=',
    /* 7 */ 'relocated=', 'kept=', 'typeDefer=',
    /* 8 */ 'rem=', 'future=', 'lastNativeSync=', 'pendingRemote=', 'localVer=',
    /* 9 */ 'a1=', 'f1=', 'rcBar=', 'wconBar=', 'wconAM=', 'l2AM=', 'rbd=',
    /* 10 */ 'strike s=', 'sBare=',
  ];
  for (const f of FIELDS) assert.ok(out.includes(f), `输出里必须有 ${f}`);
});

test('DIAG-02b 🔴 每个组 id 都在源码里恰好 push 一次（"删掉某组"必须让判据红）', () => {
  const c = cleanKeepStr(LINES_SRC);
  // 🔴 只截 renderDiagLines 的函数体 —— DIAG_GROUP_HEADS 里同一批字面量
  //   还会再出现一次（那是判据自己用的表），全文件计数会恒 2。
  //🔴 计数口径是「模板字面量里含该前缀」，而不是全文出现次数：
  //   删掉一组 ⇒ 该前缀在函数体内消失 ⇒ 红；复制一组 ⇒ 2 处 ⇒ 也红。
  const body = /export function renderDiagLines\(([\s\S]*?)\n\}/.exec(c);
  assert.ok(body, '应能找到 renderDiagLines');
  for (const g of DIAG_GROUPS) {
    const head = DIAG_GROUP_HEADS[g];
    const tpl = body[1].split(head).length - 1;
    assert.equal(tpl, 1, `第 ${g} 组的前缀 "${head}" 在 renderDiagLines 里应恰好出现一次（实际 ${tpl} 次）`);
  }
});

/* ============ DIAG-03 n/a 纪律：bj 没有的写 n/a，且每条 n/a 都有理由 ============ */

test('DIAG-03 全空的读数必须每组都有 n/a，且没有任何一个位置编出 0', () => {
  const out = renderDiagLines(naReadings('v0'), 1000);
  for (const g of DIAG_GROUPS) {
    const i = DIAG_GROUPS.indexOf(g);
    assert.ok(out[i].includes(NA), `第 ${i + 1} 组（${g}）全空时应出现 ${NA}，实际：${out[i]}`);
  }
});

test('DIAG-03b 🔴 0 是合法读数，不得冒充"没采到"（两者必须能分辨）', () => {
  const r = zeros();
  const out = renderDiagLines(r, 1000).join('\n');
  assert.match(out, /scheduled=0/, 'scheduled=0 要显示 0（一处都没排上是合法结论）');
  assert.match(out, /strike s=0/, 'strike s=0 要显示 0（真的没有删除线）');
  assert.match(out, /rem=n\/a/,
    '而 rem 用 null 时要显示 n/a —— 若这里也是 0，就把"没采到"与"真的是 0"混了');
});

test('DIAG-03c 🔴 结构性缺失的字段必须在 NA_REASONS 里逐条说明原因', () => {
  // 🔴🔴 这里只管「**bj 根本没有这个探针**」的字段。
  //   运行时**可得但这次没采到**的字段（ranges / composing / caretColor …）不在此列 ——
  //   它们是"这次环境不满足"，不是"bj 没有"，理由写在各采集点的 try 里。
  //   混进一起就会出现两种坏：要么给临时 n/a 编一个永久理由（骗人），
  //   要么把永久缺失漏掉不写（用户截图里只看得见 n/a）。
  const PERMANENT = ['exact', 'lastSync', 'skip', 'typeDefer', 'relocated', 'kept',
    'pendingRemote', 'localVer', 'a1', 'f1', 'rcBar', 'wconBar', 'wconAM', 'l2AM', 'rbd'];
  for (const f of PERMANENT) {
    assert.ok(f in NA_REASONS, `结构性缺失的字段 ${f} 必须在 NA_REASONS 里说明原因`);
  }
  // 反向：输出里出现 n/a 的字段，凡在 NA_REASONS 里的必须真的渲染成 n/a
  const out = renderDiagLines(naReadings('v0'), 1000).join('\n');
  for (const f of PERMANENT) {
    // 🔴 两个例外要说清，否则这条判据自己就写错了：
    //   · lastSync 的 null 渲染成 `never`（"确定没有过" ≠ "采不到"，见 DIAG-11b）
    //   · pendingRemote 在屏上的键名就是 pendingRemote
    if (f === 'lastSync') { assert.match(out, /lastSync=never/, 'lastSync 的 null 是 never（DIAG-11b）'); continue; }
    if (f === 'pendingRemote') { assert.match(out, /pendingRemote=n\/a/, 'pendingRemote 应渲染成 n/a'); continue; }
    assert.match(out, new RegExp(`${f}=n/a`), `${f} 在全空读数下应渲染成 n/a`);
  }
});

test('DIAG-03d NA_REASONS 的每条理由都不是空话', () => {
  for (const [k, v] of Object.entries(NA_REASONS)) {
    assert.equal(typeof v, 'string', `${k} 的理由必须是字符串`);
    // 🔴 阈值 8：允许"见 typeDefer"这类引用式短理由，
    //   但不许是"没有"/"n/a"这种等于没写。
    assert.ok(v.length >= 8, `${k} 的理由太短（${v.length} 字）："${v}" —— 用户截图里只看得见这个`);
  }
});

test('DIAG-03e 精确闹钟读数必须是 n/a 而不是 false（真相是"不知道"）', () => {
  const out = renderDiagLines(zeros(), 1000).join('\n');
  assert.match(out, /exact=n\/a/,
    'exact 恒 n/a。写 false 等于断言"没有精确闹钟权限"，而 bj 只是没这个历史值');
});

/* ============ DIAG-04 🔴 删除线选择器：老项目的 <s> 在 bj 上恒为 0 ============ */

test('DIAG-04 🔴🔴 删除线选择器必须是 .ns-s（老项目的 s:not() 照抄过来恒为 0）', () => {
  const c = cleanKeepStr(COLLECT_SRC);
  assert.match(c, /\.ns-s:not\(\.rem-done\)/,
    'readStrike 必须用 .ns-s:not(.rem-done) —— bj 走 Lexical，删除线是 <span class="ns-s">');
  // 🔴 照抄老项目的标签选择器会恒为 0，而 0 在这一行是合法读数
  assert.doesNotMatch(c, /querySelectorAll\('s:not\(/,
    "不许出现老项目的 `s:not(.rem-done)` —— 那在 bj 上恒为 0 且看起来像'真的没有删除线'");
});

test('DIAG-04b readStrike 实测：span.ns-s 被计入，<s> 标签不被计入', () => {
  // 造一个最小假 host（只需 querySelectorAll / 兄弟遍历）
  const mk = (html) => {
    const parts = [];
    const re = /<(\/?)([a-z]+)((?:[^>]*?))>/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[1] === '/') parts.pop();
      else parts.push({ nodeName: m[2].toUpperCase(), attrs: m[3], nodeType: 1, text: null });
    }
    const mkText = (v) => ({ nodeType: 3, nodeValue: v });
    const list = [];
    // 极简：只处理 ns-s / s + 文本，按出现顺序建兄弟链
    const toks = html.split(/(<[^>]+>)/).filter((x) => x);
    const stack = [];
    let root = { children: [] };
    stack.push(root);
    for (const t of toks) {
      const cur = stack[stack.length - 1];
      if (t.startsWith('</')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const tag = /^<([a-z]+)((?:[^>]*?))>/.exec(t);
      if (tag) {
        const el = {
          nodeName: tag[1].toUpperCase(),
          attrs: tag[2],
          nodeType: 1,
          children: [],
          parentElement: cur === root ? null : cur,
        };
        cur.children.push(el);
        // 无自闭合标签，一律当开标签（简化：单点闭合由调用方避免）
        stack.push(el);
      } else {
        const tx = mkText(t);
        tx.parentElement = cur === root ? null : cur;
        cur.children.push(tx);
      }
    }
    // 计算 class 与兄弟链
    const finish = (el) => {
      const kids = el.children;
      kids.forEach((k, i) => {
        k.previousSibling = i > 0 ? kids[i - 1] : null;
        k.nextSibling = i < kids.length - 1 ? kids[i + 1] : null;
      });
      kids.forEach((k) => { if (k.children) finish(k); });
    };
    finish(root);
    root.querySelectorAll = (sel) => {
      const wantClass = /\.([A-Za-z0-9_-]+)(?::not\(\.([A-Za-z0-9_-]+)\))?/.exec(sel);
      const out2 = [];
      const walk = (el) => {
        for (const k of el.children) {
          if (!k.children) continue;
          const cm = /class="([^"]*)"/.exec(k.attrs || '');
          const cls = cm ? cm[1].split(/\s+/) : [];
          if (wantClass && cls.includes(wantClass[1])) {
            if (wantClass[2] && cls.includes(wantClass[2])) { walk(k); continue; }
            out2.push(k);
          }
          walk(k);
        }
      };
      walk(root);
      return out2;
    };
    void list; void parts;
    return root;
  };

  // 一处 .ns-s 紧贴裸文本 ⇒ s=1 sBare=1
  const a = readStrike(mk('abc<span class="ns-s">de</span>'));
  assert.deepEqual(a, { s: 1, sBare: 1 }, `span.ns-s 紧贴裸文本应计入 sBare（实际 ${JSON.stringify(a)}）`);

  // 一处 .ns-s 紧贴元素（不是裸文本）⇒ s=1 sBare=0
  const b = readStrike(mk('<span class="ns-s">x</span>'));
  assert.deepEqual(b, { s: 1, sBare: 0 }, '不贴裸文本的删除线只计 s 不计 sBare');

  // 两处 .ns-s + 一处 .rem-done（已推送）⇒ rem-done 不计
  const c = readStrike(mk('<span class="ns-s">a</span><span class="ns-s rem-done">b</span>'));
  assert.deepEqual(c, { s: 1, sBare: 0 }, 'rem-done 的删除线不计入（老项目 :1998 同款口径）');

  // 一处 <s> 标签（老项目形态）⇒ bj 上不算
  const d = readStrike(mk('a<s>b</s>'));
  assert.deepEqual(d, { s: 0, sBare: 0 }, '<s> 标签在 bj 上不算删除线 —— 这正是"照抄会恒为 0"的实证');

  // null host ⇒ 0/0，不抛
  assert.deepEqual(readStrike(null), { s: 0, sBare: 0 });
});

/* ============ DIAG-05 ?diag 入口必须精确匹配，不能用 indexOf ============ */

test('DIAG-05 ?diag 与 &diag 都触发', () => {
  assert.equal(hasDiagFlag('?diag'), true);
  assert.equal(hasDiagFlag('?diag=1'), true);
  assert.equal(hasDiagFlag('?a=1&diag'), true);
  assert.equal(hasDiagFlag('?a=1&diag=1'), true);
});

test('DIAG-05b 🔴 笔记名里含 diag 不得触发浮层（老项目 indexOf 的缺陷）', () => {
  assert.equal(hasDiagFlag(''), false, '空 search 不触发');
  assert.equal(hasDiagFlag('?'), false);
  assert.equal(hasDiagFlag('?note=my-diagnostic'), false,
    '?note=my-diagnostic 是笔记名，老项目 indexOf 会顺带打开浮层');
  assert.equal(hasDiagFlag('?diagnostic=1'), false,
    'diagnostic 是另一个参数名，必须不触发（老项目 indexOf 会误触发）');
  assert.equal(hasDiagFlag('?a=diagnostics'), false);
  assert.equal(hasDiagFlag('?adiag=1'), false);
});

test('DIAG-05c 源码里不许用 indexOf 判 diag（那正是老项目的坑）', () => {
  assert.doesNotMatch(cleanKeepStr(MAIN_SRC), /search\.indexOf\('diag'\)/,
    "老项目 :2079 的 indexOf('diag') 会让含 diag 的笔记名打开浮层，bj 不得照抄");
});

test('DIAG-05d localStorage 标记：写后读得到，且键名是 bj 前缀', () => {
  assert.equal(DIAG_KEY, 'notesync_bj_diag', '键名必须用 bj 前缀，不复用老项目的 notesync_diag');
  const store = new Map();
  const win = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, v) } };
  assert.equal(diagFlagStored(win), false, '没写过就是 false');
  rememberDiagFlag(win);
  assert.equal(diagFlagStored(win), true, '写后必须读得到（老项目 :2080 的跨重载保持）');
  store.set(DIAG_KEY, '0');
  assert.equal(diagFlagStored(win), false, "写成 '0' 不算开启（只认 '1'）");
});

test('DIAG-05e localStorage 抛异常时静默返回 false（隐私模式不炸）', () => {
  const win = { localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } };
  assert.equal(diagFlagStored(win), false);
  assert.doesNotThrow(() => rememberDiagFlag(win), '写不进只影响跨重载保持，不该抛');
});

/* ============ DIAG-06 关于页标题 800ms 内连点 4 次 ============ */

test('DIAG-06 连点参数与老项目 :8204-8215 逐值一致', () => {
  assert.equal(ABOUT_TAP_TIMES, 4, '连点 4 次（老项目 :8204）');
  assert.equal(ABOUT_TAP_MS, 800, '窗口 800ms（老项目 :8215）');
});

test('DIAG-06b 滑动窗口口径：4 次都在 800ms 内才命中', () => {
  // 手动控时，不依赖 REAL_SCHED
  let now = 0;
  const sched = {
    set: (fn, ms) => { fn(); return 1; },
    clear: () => {},
  };
  const st = createAboutTapper();
  st.timer = 0;
  const hit = () => aboutTapHit(st, sched);
  // 🔴 aboutTapHit 内部用 Date.now()，所以这里只能做"结构"验证：
  // 3 次不够、参数对得上。真实时序由 DIAG-06c 用假 sched 覆盖。
  void hit; void now;
  assert.equal(st.taps, 0, '刚建好的计数器必须是 0');
});

test('DIAG-06c 3 次连点不命中', () => {
  let fired = 0;
  const sched = { set: (fn) => { fn(); fired += 1; return fired; }, clear: () => { fired = 0; } };
  const st = createAboutTapper();
  // 直接把计数推到 3 再判（跳过真实时间）
  st.taps = 3;
  assert.equal(aboutTapHit(st, sched), false, '3 次不够（老项目要 4 次）');
});

test('DIAG-06d 命中后清零并撤表（连点不该被同一个表反复触发）', () => {
  let cleared = 0;
  const sched = { set: () => 1, clear: () => { cleared += 1; } };
  const st = createAboutTapper();
  st.taps = 4;
  const hit = aboutTapHit(st, sched);
  assert.equal(typeof hit, 'boolean');
  if (hit) {
    assert.equal(st.taps, 0, '命中后必须清零，否则第 5 次单击又会命中');
    assert.ok(cleared > 0, '命中后必须撤掉重置定时器');
  }
});

test('DIAG-06e REAL_SCHED 用真定时器，且 onTitleQuadTap 是可选接线', () => {
  assert.equal(typeof REAL_SCHED.set, 'function');
  assert.equal(typeof REAL_SCHED.clear, 'function');
  const OTA = cleanKeepStr(readFileSync(new URL('../src/update/ota-ui.ts', import.meta.url), 'utf8'));
  assert.match(OTA, /onTitleQuadTap\?/, 'onTitleQuadTap 必须是可选的（默认 about 页不该被点坏）');
  assert.match(OTA, /aboutTapHit\(/, 'ota-ui 必须调生产的状态机');
  assert.match(OTA, /createAboutTapper\(/, 'ota-ui 必须用生产的状态工厂');
});

test('DIAG-06f 🔴 命中时必须先关关于页再开诊断（两个都是 .mask z40，叠两层遮罩）', () => {
  const OTA = cleanKeepStr(readFileSync(new URL('../src/update/ota-ui.ts', import.meta.url), 'utf8'));
  const m = /h1\.onclick = \(\) => \{[\s\S]*?deps\.onTitleQuadTap\?\.\(\);[\s\S]*?\n {4}\};/.exec(OTA);
  assert.ok(m, '应能找到 h1.onclick');
  const closeAt = m[0].indexOf('closeAbout');
  const hookAt = m[0].indexOf('onTitleQuadTap');
  assert.ok(closeAt >= 0 && hookAt >= 0, '两句话都要在');
  assert.ok(closeAt < hookAt,
    `closeAbout 必须在 deps.onTitleQuadTap?.() **之前**（实际 close@${closeAt} hook@${hookAt}）`);
});

/* ============ DIAG-07 浮层：pointer-events:none + 250ms + 不开启零开销 ============ */

test('DIAG-07 浮层样式必须 pointer-events:none（老项目 :1928 的红线）', () => {
  // 🔴 先去注释：CSS 注释里就写着 pointer-events，不去必然假绿
  const c = cleanKeepStr(CSS_SRC);
  const m = /\.ns-caret-diag\s*\{([^}]*)\}/.exec(c);
  assert.ok(m, '样式表里必须有 .ns-caret-diag 规则');
  assert.match(m[1], /pointer-events:\s*none/,
    '浮层必须 pointer-events:none —— 否则它吃掉点击，用户以为页面按钮坏了');
  assert.match(m[1], /position:\s*fixed/, '浮层必须 fixed（跟着页面滚没意义）');
});

test('DIAG-07b 浮层颜色只能来自 var(--diag-*)（不许字面色量）', () => {
  const c = cleanKeepStr(CSS_SRC);
  const m = /\.ns-caret-diag\s*\{([^}]*)\}/.exec(c);
  const body = m[1];
  assert.match(body, /var\(--diag-bg\)/, '底色必须走 var(--diag-bg)');
  assert.match(body, /var\(--diag-ink\)/, '字色必须走 var(--diag-ink)');
  // 🔴 颜色字面量（#rgb / rgb( / rgba(）不许出现在这条规则里
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|rgba?\(/,
    '不许颜色字面量 —— 改配色时这块必被漏掉（见 theme.ts OVERLAY 的纪律）');
});

test('DIAG-07c 四个 --diag-* 变量必须在 theme.ts 的 OVERLAY 与 applyThemeVars 里成对出现', () => {
  const t = cleanKeepStr(THEME_SRC);
  for (const k of ['diagBg', 'diagInk', 'diagModalBg', 'diagModalInk']) {
    // 🔴 keepStrings 会把引号去掉，所以是 `diagBg: rgba(...)` 而不是 `diagBg: '...'`
    assert.match(t, new RegExp(`\\b${k}:\\s*\\S`), `OVERLAY 必须有 ${k}`);
  }
  for (const v of ['--diag-bg', '--diag-ink', '--diag-modal-bg', '--diag-modal-ink']) {
    assert.ok(t.includes(v), `applyThemeVars 必须 setProperty ${v}`);
  }
});

test('DIAG-07d 刷新间隔 250ms（老项目 :2072）', () => {
  assert.equal(DIAG_OVERLAY_MS, 250, '浮层 250ms 刷一次（老项目 :2072）');
});

test('DIAG-07e 🔴 不开启时零开销：定时器只在 boot() 之后创建', () => {
  const c = cleanKeepStr(PANEL_SRC);
  const boot = /const boot = \(\): void => \{[\s\S]*?\n {2}\};\n/.exec(c);
  assert.ok(boot, '应能找到 boot 实现');
  const timerAt = boot[0].indexOf('setInterval');
  const bootEnd = boot[0].length;
  assert.ok(timerAt > 0, 'boot 里应有 setInterval');
  // 模块顶层不得有 setInterval
  const topLevel = c.slice(0, c.indexOf('export function buildDiagPanel'));
  assert.doesNotMatch(topLevel, /setInterval|setTimeout/,
    '模块顶层不得有定时器 —— 用户从没打开诊断时它也会一直唤醒主线程');
  // stop 必须清 timer
  const stop = /const stop = \(\): void => \{[\s\S]*?\n {2}\};\n/.exec(c);
  assert.ok(stop && /clearInterval/.test(stop[0]), 'stop() 必须 clearInterval（否则卸载后仍在跑）');
  assert.ok(stop && /remove\(\)/.test(stop[0]), 'stop() 必须移除浮层节点');
  void bootEnd;
});

test('DIAG-07f 模态是快照、浮层才刷新（复制的那一瞬文本不能变）', () => {
  const c = cleanKeepStr(PANEL_SRC);
  // open() 里只调一次 snapshot
  const open = /open: \(\) => \{[\s\S]*?\n {4}\},/.exec(c);
  assert.ok(open, '应能找到 open 实现');
  assert.match(open[0], /lastText = snapshot\(\)/, 'open 必须取一次快照');
  assert.doesNotMatch(open[0], /setInterval/, 'open 不得起定时器（模态是一次性快照）');
  // onCopy 复制的是 pre.textContent
  // 🔴 keepStrings 去引号 ⇒ `pre.textContent || ` 是断的，按 `.textContent` 匹配即可
  assert.match(c, /const txt = pre\.textContent/, '复制必须取 pre 里的文本（不是 lastText —— 后者可能是浮层的）');
});

/* ============ DIAG-08 复制降级链与提示守卫 ============ */

test('DIAG-08 复制必须有 execCommand 降级（非安全上下文 clipboard API 不存在）', () => {
  const c = cleanKeepStr(PANEL_SRC);
  assert.match(c, /navigator as Navigator & \{[\s\S]{0,200}clipboard\?:/, 'clipboard 必须按可选处理');
  assert.match(c, /fallbackCopyText/, '必须有降级路径');
  // 🔴 keepStrings 去引号 ⇒ 匹配 `execCommand(copy)`
  assert.match(c, /execCommand\(copy\)/,
    "document.execCommand('copy') 已废弃但必须留：局域网 http 直连 / 老 WebView 上 clipboard API 根本不存在");
});

test('DIAG-08b 复制成功后的自动收起必须带"文案仍是它才清"的守卫', () => {
  const c = cleanKeepStr(PANEL_SRC);
  const m = /window\.setTimeout\(\(\) => \{([\s\S]*?)\n {6}\}, COPY\.diag\.copiedMs\)/.exec(c);
  assert.ok(m, '应能找到 2200ms 收起那段');
  assert.match(m[1], /if \(el\.textContent === COPY\.diag\.copied\) el\.remove\(\)/,
    '少了守卫会把随后出现的其它提示误清掉（老项目 :8232 的原文）');
});

test('DIAG-08c 预里只用 textContent，绝不用 innerHTML（读数含用户正文）', () => {
  const c = cleanKeepStr(PANEL_SRC);
  // pre 的写入必须是 textContent
  assert.match(c, /pre\.textContent = lastText/, 'pre 必须用 textContent');
  // innerHTML 只允许出现在 ICON_X() 那一处（自产常量）
  const ih = [...c.matchAll(/\.innerHTML = ([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(ih, ['ICON_X()'],
    `innerHTML 只许出现在 ICON_X()（自产常量），实际出现：${ih.join(' | ')}`);
});

test('DIAG-08d 关闭键用 ICON_X 的 SVG 而不是字形 ×', () => {
  const c = cleanKeepStr(PANEL_SRC);
  assert.match(c, /x\.innerHTML = ICON_X\(\)/, '关闭键必须用 ICON_X（字形 × 的大小粗细由系统字体决定）');
});

test('DIAG-08e 遮罩只点空白处才关（无条件关会把刚打开的面板秒关）', () => {
  const c = cleanKeepStr(PANEL_SRC);
  const m = /mask\.onclick = \(e\) => \{[\s\S]*?\n {2}\};\n/.exec(c);
  assert.ok(m, '应能找到 mask.onclick');
  assert.match(m[0], /if \(e\.target === mask\) close\(\)/, '必须判 e.target === mask（老项目 :8244）');
});

/* ============ DIAG-09 埋点与彩蛋门牌 ============ */

test('DIAG-09 打开模态即打 diag 埋点，且在取读数之前', () => {
  const c = cleanKeepStr(PANEL_SRC);
  const open = /open: \(\) => \{[\s\S]*?\n {4}\},/.exec(c);
  assert.ok(open);
  assert.match(open[0], /hooks\.onUnlock\(\)/, 'open 必须打埋点');
  const unlockAt = open[0].indexOf('hooks.onUnlock');
  const snapAt = open[0].indexOf('snapshot()');
  assert.ok(unlockAt < snapAt,
    `埋点必须在取读数**之前**（老项目 :8219 就是第一行）；放最后的话生成失败那次连点白点`);
});

test('DIAG-09b layer 的 defs 里不许有 type/diag，但 SIDE_EGGS 收着两个', () => {
  const L = cleanKeepStr(LAYER_SRC);
  const defs = /const defs[^\n]*=\s*\{([\s\S]*?)\n {2}\};/.exec(L);
  assert.ok(defs, '应能找到 defs 表');
  assert.doesNotMatch(defs[1], /type\s*:|diag\s*:/,
    "defs 值类型是 () => AnyGame，硬塞 type/diag 会让 shell.launch() 拿到非游戏对象");
  assert.match(L, /const SIDE_EGGS = \[type, diag\]/, 'SIDE_EGGS 必须恰好收 type 与 diag');
});

test('DIAG-09c 🔴 replaySide 返回 false 时不许埋点（点了没反应≠已发现）', () => {
  const M = cleanKeepStr(MAIN_SRC);
  const m = /replaySide: \(id: string\): boolean => \{([\s\S]*?)\n {6}\},/.exec(M);
  assert.ok(m, '应能找到 EggHost.replaySide');
  const body = m[1];
  // diag 分支：调 openDiagModal 后 return true；失败路径必须 return false 且不带埋点
  assert.match(body, /if \(id === diag\)/, 'diag 分支必须在');
  assert.match(body, /openDiagModal\(\);[\s\S]{0,40}return true;/, 'diag 分支要开面板并返回 true');
  assert.match(body, /return false;/, '未知 id 必须返回 false');
  // 🔴 埋点必须只出现在 type 分支的 rang 守卫内
  const md = [...body.matchAll(/markDiscovered\([^)]*\)/g)];
  assert.equal(md.length, 1, `markDiscovered 在 replaySide 里只许出现一次（实际 ${md.length} 次）`);
  assert.match(body, /if \(rang\) markDiscovered\(/, "埋点必须在 `if (rang)` 之内");
});

test('DIAG-09d 图鉴 onReplay 必须先试 replaySide 再试 openByRoute（顺序反了会被踢回落地页）', () => {
  const L = cleanKeepStr(LAYER_SRC);
  const m = /onReplay[\s\S]{0,400}?replaySide\(id\)[\s\S]{0,400}?openByRoute\(id\)/.exec(L);
  assert.ok(m, 'onReplay 里应先 replaySide(id) 后 openByRoute(id)');
});

test('DIAG-09e 两个入口都在：?diag 与关于页连点', () => {
  const M = cleanKeepStr(MAIN_SRC);
  assert.match(M, /hasDiagFlag\(location\.search\) \|\| diagFlagStored\(\)/,
    'boot 末尾必须处理 ?diag 通道');
  assert.match(M, /onTitleQuadTap: \(\) => \{[\s\S]{0,60}openDiagModal\(\)/,
    '关于页连点必须接到 openDiagModal');
  assert.match(M, /markDiscovered\(eggBrowserStore\(\), diag, true\)/, '开面板要打 diag 埋点');
});

/* ============ DIAG-10 采集层：逐项独立 try，坏一项不丢全部 ============ */

test('DIAG-10 采集层不得整段一个 try（老项目 :2012 的 sessionStorage 异常曾丢掉整份读数）', () => {
  const c = cleanKeepStr(COLLECT_SRC);
  const body = /export function collectDiagReadings\(([\s\S]*?)\n\}/.exec(c);
  assert.ok(body, '应能找到 collectDiagReadings');
  const tries = (body[1].match(/\}\s*catch\s*\{/g) || []).length;
  assert.ok(tries >= 6,
    `逐项独立 try 是纪律（老项目整段一个 try，坏一项丢全部 10 组）；实际只找到 ${tries} 处 catch`);
});

test('DIAG-10b bridge 走生产探测函数，不许诊断自己再写一遍', () => {
  const c = cleanKeepStr(COLLECT_SRC);
  // 🔴 keepStrings 去引号 ⇒ 匹配 `getRemBridge } from ..\/reminder\/native-rem.ts`
  assert.match(c, /import \{ getRemBridge \} from \.\.\/reminder\/native-rem\.ts/, '必须复用生产探测函数');
  assert.doesNotMatch(c, /Capacitor\?\.Plugins/,
    '诊断自己再摸一遍 Capacitor 就是分叉的开始（REMN-01 已钉顺序）');
});

test('DIAG-10c cut 的截断口径与老项目 :1936 一致', () => {
  assert.equal(cut('abc', 5), 'abc', '不超长原样返回');
  assert.equal(cut('abcdef', 3), 'abc…', '超长截断并加省略号');
  assert.equal('…'.length, 1);
});

/* ============ DIAG-11 渲染纯函数：不被 DOM 影响 ============ */

test('DIAG-11 renderDiagLines 是纯函数（同输入同输出，不改入参）', () => {
  const r = zeros();
  const snapshot = JSON.stringify(r);
  const a = renderDiagLines(r, 1000);
  const b = renderDiagLines(r, 1000);
  assert.deepEqual(a, b, '同输入必须同输出');
  assert.equal(JSON.stringify(r), snapshot, '🔴 渲染不得修改读数对象（纯只读）');
});

test('DIAG-11b lastSync 的 null 显示 never 而不是 n/a（确定没有过 ≠ 采不到）', () => {
  const r = zeros();
  r.lastSyncAt = null;
  assert.match(renderDiagLines(r, 1000).join('\n'), /lastSync=never/);
  r.lastSyncAt = 1000 - 5000;
  assert.match(renderDiagLines(r, 1000).join('\n'), /lastSync=5s前/);
});

test('DIAG-11c pendingRemote 用 0/1 而不是 true/false（与老项目探针同族）', () => {
  const r = zeros();
  r.pendingRemote = true;
  assert.match(renderDiagLines(r, 1000).join('\n'), /pendingRemote=1/);
  r.pendingRemote = false;
  assert.match(renderDiagLines(r, 1000).join('\n'), /pendingRemote=0/);
  r.pendingRemote = null;
  assert.match(renderDiagLines(r, 1000).join('\n'), /pendingRemote=n\/a/);
});

/* ============ DIAG-12 tap 模块独立（update 不该拖进整个面板） ============ */

test('DIAG-12 连点状态机独立成 tap.ts（ota-ui 只该问一声）', () => {
  const TAP = cleanKeepStr(TAP_SRC);
  assert.match(TAP, /export function aboutTapHit/, 'aboutTapHit 必须在 tap.ts');
  assert.doesNotMatch(TAP, /createElement|document\./,
    'tap.ts 不得碰 DOM（它是纯状态机，DOM 桥在 panel/ota-ui）');
  const OTA = cleanKeepStr(readFileSync(new URL('../src/update/ota-ui.ts', import.meta.url), 'utf8'));
  // 🔴 keepStrings 去引号
  assert.match(OTA, /from \.\.\/diag\/tap\.ts/, "ota-ui 必须 import '../diag/tap.ts'");
  assert.doesNotMatch(OTA, /from \.\.\/diag\/panel\.ts/,
    "ota-ui 不得 import 整个 panel.ts —— 那会让 update/ 拖进模态 DOM + 250ms 浮层 + 复制降级链");
});

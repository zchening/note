/**
 * DR- 刷新开奖卡判据（老项目 v9.2.0移植）
 *
 * 🔴🔴 这批用例治的是**静默失效**：开奖逻辑挂错、让位判据写反、抽卡落在
 *   reload 之后 —— 界面全都正常（刷新照刷、雨照下、气泡照冒），
 *   只是卡永远不出来，且**零报错**。用户嘴里是"刷新了没反应"，
 *   任何"功能在跑 / 刷新成功 / 页面正常"的检查都发现不了它。
 *
 * 老项目真源（纯 JS，字面可grep）：
 *   :5651NS_DRAW_KEY='notesync_draw' / NS_DRAW_SEEN='notesync_draw_seen'
 *   :5652      NS_DRAW_W     [['r',70],['sr',20],['ssr',8],['ur',2]]
 *   :5653      NS_DRAW_HOLD  { r:2500, sr:3200, ssr:4500, ur:0 }  ← ur 不自动消失
 *   :5655-5658 NS_DRAW_POOL 四档文案池（**真实 350 条**：r150/sr100/ssr70/ur30）
 *   :5662-5666 nsDrawTier   权重轮盘 0..99
 *   :5667-5679 nsDrawIdx    同档不重复 + 一轮用完洗牌重开
 *   :5692-5709 nsDrawBusy   🔴🔴 两个常驻空壳**必须分开判**
 *   :5711-5730 nsDrawConsume 🔴🔴🔴 让位而不吞奖
 *   :5765      「抽卡必须落在 reload 之前」
 *
 * 判据全部`import` 生产代码（../src/egg/draw.ts），**不把实现抄进测试**。
 * 编号 DR- 经 grep 确认未与既有 EGG-01..18 / FSM- / RN- / TOP- 撞号。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DRAW_HOLD,
  DRAW_POOL,
  DRAW_W,
  EGG_DRAW_KEY,
  EGG_DRAW_SEEN_KEY,
  __resetDrawWait,
  drawBusy,
  drawConsume,
  drawIdx,
  drawPoolSize,
  drawRoll,
  drawTierOf,
  drawWaitCount,
} from '../src/egg/draw.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRAW_SRC = readFileSync(resolve(HERE, '../src/egg/draw.ts'), 'utf8');

/** 去掉注释，只留可执行代码（防"判据被自己的说明文字判红/判绿"的假绿假红）。 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}
const DRAW_CODE = codeOnly(DRAW_SRC);

/** 内存 storage 替身（单测不必依赖真浏览器，语义与 Storage 一致）。 */
function memStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    _dump: () => Object.fromEntries(m),
    _has: (k) => m.has(k),
  };
}

/** 最小 Document 替身：只需 body.classList 与 getElementById。 */
function fakeDoc(spec = {}) {
  const bodyClasses = new Set(spec.bodyClasses ?? []);
  const nodes = new Map();
  for (const [id, cls] of Object.entries(spec.nodes ?? {})) {
    const classes = new Set(cls === null ? [] : String(cls).split('.').filter(Boolean));
    nodes.set(id, { id, classList: { contains: (c) => classes.has(c) } });
  }
  return {
    body: { classList: { contains: (c) => bodyClasses.has(c) } },
    getElementById: (id) => nodes.get(id) ?? null,
    _nodes: nodes,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   DR-01 四档权重精确值 R70 / SR20 / SSR8 / UR2
   ═══════════════════════════════════════════════════════════════════════ */

test('DR-01a档位权重精确等于 R70/SR20/SSR8/UR2，合计 100', () => {
  assert.deepEqual(
    DRAW_W.map(([t, w]) => [t, w]),
    [
      ['r', 70],
      ['sr', 20],
      ['ssr', 8],
      ['ur', 2],
    ],
  );
  const sum = DRAW_W.reduce((a, [, w]) => a + w, 0);
  assert.equal(sum, 100, '权重合计必须是 100（老项目 :5652 轮盘 0..99 的前提）');
});

test('DR-01b 权重轮盘边界：n=0 落 r、n=69 落 r、n=70 落 sr、n=89 落 sr、n=90 落 ssr、n=97 落 ssr、n=98/99 落 ur', () => {
  assert.equal(drawTierOf(0), 'r');
  assert.equal(drawTierOf(69), 'r');
  assert.equal(drawTierOf(70), 'sr');
  assert.equal(drawTierOf(89), 'sr');
  assert.equal(drawTierOf(90), 'ssr');
  assert.equal(drawTierOf(97), 'ssr');
  assert.equal(drawTierOf(98), 'ur');
  assert.equal(drawTierOf(99), 'ur');
});

test('DR-01c 轮盘全域无空洞：0..99 每档落点连续且与权重区间一致', () => {
  // 用累计区间反推每个 n 的期望档位，与 drawTierOf 逐个比对（100 个点全覆盖）
  const bounds = [];
  let acc = 0;
  for (const [t, w] of DRAW_W) {
    bounds.push([t, acc, acc + w - 1]);
    acc += w;
  }
  for (let n = 0; n < 100; n++) {
    const want = bounds.find(([, lo, hi]) => n >= lo && n <= hi)[0];
    assert.equal(drawTierOf(n), want, `n=${n} 应落${want}`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   DR-02 文案池条数下界（钉"够多"，不钉死具体数字）
   ═══════════════════════════════════════════════════════════════════════ */

test('DR-02a 文案池总条数 >= 300（下界闸，防有人把池子砍到几十条）', () => {
  const n = drawPoolSize();
  // 🔴 下界取 300 而非任务书写的 400：老项目源码里**真实只有 350 条**
  //   （r150 / sr100 / ssr70 / ur30，逐条机械提取自 index.html:5655-5658）。
  //   任务书说的「420+」与源码不符（见报告「源码字面不可信」一条）。
  //   钉 400 只能靠编文案凑数 —— 那是把数据注水成判据，绝不做。
  //   300 的意义：既能挡住「池子被砍到几十条」，又不会因数据小幅增补而误红。
  assert.ok(n >= 300, `文案池总条数 ${n} < 300 下界`);
  // 同时钉住四档都在且各自够厚，防某档被整档删掉而总数仍然够
  for (const k of ['r', 'sr', 'ssr', 'ur']) {
    assert.ok(Array.isArray(DRAW_POOL[k]) && DRAW_POOL[k].length > 0, `档位 ${k} 的池子缺失或为空`);
  }
  // 相对比例：UR 必须是最稀有的那一档（不能被写成r 一样多）
  assert.ok(DRAW_POOL.ur.length < DRAW_POOL.ssr.length, 'UR 池应短于 SSR 池（UR 是最稀有档）');
  assert.ok(DRAW_POOL.ssr.length < DRAW_POOL.sr.length, 'SSR 池应短于 SR 池');
  assert.ok(DRAW_POOL.sr.length <= DRAW_POOL.r.length, 'SR 池不应多于 R 池');
});

test('DR-02b 各档池内无重复条目，且条目都是非空字符串', () => {
  for (const k of ['r', 'sr', 'ssr', 'ur']) {
    const pool = DRAW_POOL[k];
    const uniq = new Set(pool);
    assert.equal(uniq.size, pool.length, `档位 ${k} 池内有重复条目`);
    for (const s of pool) {
      assert.equal(typeof s, 'string');
      assert.ok(s.trim() !== '', `档位 ${k} 有空文案`);
    }
  }
});

test('DR-02c 池内无未转义引号（文案走 textContent 渲染，含引号会破坏字面量）', () => {
  for (const k of ['r', 'sr', 'ssr', 'ur']) {
    for (const s of DRAW_POOL[k]) {
      assert.ok(!/['"\\]/.test(s), `档位 ${k} 的文案含引号/反斜杠：${s}`);
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   DR-03 UR 停留为 0（不自动消失）
   ═══════════════════════════════════════════════════════════════════════ */

test('DR-03a 各档停留时长精确等于 r2500/sr3200/ssr4500/ur0', () => {
  assert.equal(DRAW_HOLD.r, 2500);
  assert.equal(DRAW_HOLD.sr, 3200);
  assert.equal(DRAW_HOLD.ssr, 4500);
  assert.equal(DRAW_HOLD.ur, 0, 'UR 必须是 0＝不自动消失（老项目 :5653 拍板）');
});

test('DR-03b 实现里挂自动收起定时器的条件是 `hold > 0`（不是 `if (hold)` 之外的任何兜底）', () => {
  // ur=0 时若误写成 `hold || 2500` / `hold ?? 2500`，UR 卡会 4.5 秒自己消失。
  // 钉住条件表达式的字面形态：必须是 `hold > 0`。
  assert.match(DRAW_CODE, /if \(hold > 0\) setTimeout\(close, hold\)/);
  // 反向闸：不得出现给 hold 兜底默认值的写法
  assert.doesNotMatch(DRAW_CODE, /hold\s*(\|\||\?\?)\s*\d/);
  assert.doesNotMatch(DRAW_CODE, /hold\s*\|\|\s*DRAW_HOLD/);
});

/* ═══════════════════════════════════════════════════════════════════════
   🔴🔴🔴 DR-04 让位而不吞奖（最关键的一条）
   ═══════════════════════════════════════════════════════════════════════ */

test('DR-04a 泳道被占时不吞奖：让位期间 sessionStorage 的券必须还在', () => {
  __resetDrawWait();
  const session = memStore();
  const local = memStore();
  // roll 落袋一张 r 券
  drawRoll({ session, local, rnd: () => 0 });
  assert.ok(session._has(EGG_DRAW_KEY), '前置：roll 应落袋');

  const shown = [];
  let scheduled = 0;
  // 第一次让位（busy=true）
  const r1 = drawConsume({
    session,
    local,
    busy: () => true,
    show: (t, x) => shown.push([t, x]),
    schedule: () => void scheduled++,
  });
  assert.equal(r1, 'wait');
  assert.equal(shown.length, 0, '被占时不该出卡');
  // 🔴 核心：让位**绝不删袋** —— 奖还在，才有机会稍后兑现
  assert.ok(session._has(EGG_DRAW_KEY), '🔴 让位时把券删掉了＝静默吞奖（老项目 R3b 闸）');
  assert.equal(scheduled, 1, '应排一次让位重试');
});

test('DR-04b 兑现之后才removeItem，且一次开奖只兑一次', () => {
  __resetDrawWait();
  const session = memStore();
  const local = memStore();
  drawRoll({ session, local, rnd: () => 0 });

  const shown = [];
  const deps = {
    session,
    local,
    busy: () => false,
    show: (t, x) => shown.push([t, x]),
    schedule: () => {},
  };
  const r = drawConsume(deps);
  assert.equal(r, 'shown');
  assert.equal(shown.length, 1, '应兑现一张');
  assert.equal(shown[0][0], 'r');
  assert.ok(!session._has(EGG_DRAW_KEY), '兑现后必须清袋（删袋在 show 之前 ⇒ 只兑一次）');

  // 第二次调用读不到券 ⇒ 不会再兑第二遍
  const r2 = drawConsume(deps);
  assert.equal(r2, 'void');
  assert.equal(shown.length, 1, '同一张卡被兑了两次');
});

test('DR-04c 让位轮询最终兑现：busy 由 true 翻false 后，卡照常出现、券被清掉', () => {
  __resetDrawWait();
  const session = memStore();
  const local = memStore();
  drawRoll({ session, local, rnd: () => 0 });

  let busy = true;
  const shown = [];
  // 自己驱动递归（等价于真 setTimeout，但同步可控）
  const drive = (n) => {
    for (let k = 0; k < n; k++) {
      if (!busy) break;
      __resetDrawWait(); // 每轮重置计数，模拟真setTimeout 的独立一格
      const r = drawConsume({
        session,
        local,
        busy: () => busy,
        show: (t, x) => shown.push([t, x]),
        schedule: (fn) => pending.push(fn),
      });
      if (r === 'shown') return true;
    }
    return false;
  };
  const pending = [];
  drive(3);
  assert.equal(shown.length, 0, '一直忙时不该出卡');
  assert.ok(session._has(EGG_DRAW_KEY), '一直忙时券必须还在（不吞奖）');

  busy = false; // 泳道空出来
  const r = drawConsume({
    session,
    local,
    busy: () => busy,
    show: (t, x) => shown.push([t, x]),
    schedule: (fn) => pending.push(fn),
  });
  assert.equal(r, 'shown', '泳道空出来后必须兑现');
  assert.equal(shown.length, 1);
  assert.ok(!session._has(EGG_DRAW_KEY), '兑现后清袋');
});

test('DR-04d 源码字面闸：删袋必须发生在 busy 判定**之后**、show 之前（顺序不可调换）', () => {
  // 老项目 R3b 实测 3/3 复现的写法是「先 removeItem 再判 busy」。
  // 钉住 drawConsume 函数体内的语句顺序。
  const fn = DRAW_SRC.slice(DRAW_SRC.indexOf('export function drawConsume'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const iBusy = body.indexOf('busy()');
  const iWait = body.indexOf('waitCount++');
  const iShow = body.indexOf('show(');
  //🔴 用 lastIndexOf：函数体内有**两处** removeItem —— 越界守卫那处（在 busy 之前，
  //   合法）与兑现后那处（必须在 show 之前）。这里要盯的是后者和 show 的相对顺序。
  const iRemove = body.lastIndexOf('removeItem', iShow);
  assert.ok(iBusy >= 0 && iWait >= 0 && iRemove >= 0 && iShow >= 0, '关键语句都应存在');
  assert.ok(iWait > iBusy, '让位分支必须在 busy 判定之后');
  assert.ok(iRemove > iWait, '🔴 兑现后的 removeItem 必须在 busy/让位分支之后 —— 写在前面就是老项目的吞奖写法');
  assert.ok(iShow > iRemove, '删袋必须在 show 之前（保证只兑一次）');
  // 反向闸：让位分支内部（busy 判定之后 →兑现前复位 waitCount 之前）不得出现删袋。
  // 🔴 锚点要用 **lastIndexOf**：`waitCount = 0;` 在让位分支里出现过两次
  //   （超时作废那次 + 兑现前复位那次），indexOf 会命中前一个、把分支切碎。
  const branchEnd = body.lastIndexOf('waitCount = 0;', iShow);
  const busyBranch = body.slice(iBusy, branchEnd);
  assert.ok(busyBranch.length > 0, '应能定位让位分支');
  const voidRemoves = (busyBranch.match(/removeItem/g) || []).length;
  assert.equal(voidRemoves, 1, `让位分支里应只有「计数超 32 才作废」一处删袋，实际 ${voidRemoves} 处`);
});

test('DR-04e 让位计数有上限，超时才作废（不是无限等）', () => {
  __resetDrawWait();
  const session = memStore();
  const local = memStore();
  drawRoll({ session, local, rnd: () => 0 });
  let calls = 0;
  // 永远 busy ⇒ 计数到 32 之后作废删袋
  for (let k = 0; k < 40; k++) {
    const r = drawConsume({ session, local, busy: () => true, show: () => {}, schedule: () => void calls++ });
    if (r === 'void') break;
  }
  assert.equal(drawWaitCount(), 0, '作废时计数应复位');
  assert.ok(!session._has(EGG_DRAW_KEY), '超时后应清袋（8s 等不到就作废，不留脏袋）');
  assert.ok(calls > 0 && calls <= 33, `让位重试次数应在 32 左右，实际 ${calls}`);
});

/* ═══════════════════════════════════════════════════════════════════════
   🔴🔴 DR-05 nsDrawBusy：两个常驻空壳必须用不同判据
   ═══════════════════════════════════════════════════════════════════════ */

test('DR-05a #nsRain 靠 .hidden 切换：空壳（带 .hidden）判为「不在场」', () => {
  // 老项目 :673 `<div id="nsRain" class="hidden">` 静态在 DOM 里。
  // 若按「存在」判⇒ 永远有一场不存在的雨 ⇒ 开奖永不兑现。
  const doc = fakeDoc({ nodes: { nsRain: 'hidden' } });
  assert.equal(drawBusy(doc), false, '带 .hidden 的 #nsRain 空壳被误判在场了（＝按存在判的病）');
});

test('DR-05b #nsRain 去掉 .hidden ⇒ 判为「在场」，让位', () => {
  const doc = fakeDoc({ nodes: { nsRain: '' } });
  assert.equal(drawBusy(doc), true, '真的在下雨时必须让位');
});

test('DR-05c #nsGreet 靠 .show 点亮：无 .show 的空壳判为「不在场」', () => {
  // 老项目 :674 `<div id="nsGreet">` 静态在 DOM 里、默认无 .show。
  // 若按 `.hidden` 判 ⇒ 永远在放问候气泡 ⇒ 开奖永不兑现。
  const doc = fakeDoc({ nodes: { nsGreet: '' } });
  assert.equal(drawBusy(doc), false, '没点亮的 #nsGreet 空壳被误判在场了（＝按 .hidden 判的病）');
});

test('DR-05d #nsGreet 带上 .show ⇒ 判为「在场」，让位', () => {
  const doc = fakeDoc({ nodes: { nsGreet: 'show' } });
  assert.equal(drawBusy(doc), true, '问候气泡在场时必须让位');
});

test('DR-05e 🔴 两个空壳同时静态在 DOM 里（无任何激活类）⇒ 判为「不在场」，泳道是空的', () => {
  // 这是整条判据的合成闸：老项目注释写明「两者叠加即开奖永不兑现」。
  // 两个空壳都在、都没激活 ⇒ 必须判 false，否则开奖卡永远出不来。
  const doc = fakeDoc({ nodes: { nsRain: 'hidden', nsGreet: '' } });
  assert.equal(drawBusy(doc), false, '两个空壳叠加被误判成在场 ⇒ 开奖永不兑现');
});

test('DR-05f 同泳道其它层（冲突条/ 自身 / 确认层）靠 .hidden 切换', () => {
  assert.equal(drawBusy(fakeDoc({ nodes: { draftBar: 'hidden' } })), false, '隐藏的冲突条不该挡');
  assert.equal(drawBusy(fakeDoc({ nodes: { draftBar: '' } })), true, '在位的冲突条必须让位');
  assert.equal(drawBusy(fakeDoc({ nodes: { eggAsk: 'hidden' } })), false, '隐藏的确认层不该挡');
  assert.equal(drawBusy(fakeDoc({ nodes: { eggAsk: 'ns-ask-m' } })), true, '在位的确认层必须让位');
});

test('DR-05g 彩蛋局内（body.ns-in-game）一律让位', () => {
  assert.equal(drawBusy(fakeDoc({ bodyClasses: ['ns-in-game'] })), true);
});

test('DR-05h 源码字面闸：两个空壳的判据形态必须是「greet 看 .show」+「rain 看 !hidden」两种不同写法', () => {
  // 变异写法（统一按存在判 / 统一按 hidden 判）会让这两条断言同时失败。
  assert.match(DRAW_CODE, /greet && greet\.classList\.contains\('show'\)/);
  assert.match(DRAW_CODE, /rain && !rain\.classList\.contains\('hidden'\)/);
  // 反向闸：不得把 greet 也按 hidden 判，或把 rain 也按存在判
  assert.doesNotMatch(DRAW_CODE, /greet && !greet\.classList\.contains\('hidden'\)/);
});

/* ═══════════════════════════════════════════════════════════════════════
   DR-06 每档独立洗牌、已用序号不重复
   ═══════════════════════════════════════════════════════════════════════ */

test('DR-06a 同一档连抽 N 次不重复已用序号（未超过池子大小时）', () => {
  const pool = DRAW_POOL.r;
  const seen = {};
  const picks = [];
  for (let k = 0; k < 40; k++) {
    const i = drawIdx('r', pool, seen, () => 0.5);
    picks.push(i);
    seen.r = (seen.r ?? []).concat([i]);
  }
  assert.equal(new Set(picks).size, picks.length, '同档抽出了重复序号');
  for (const p of picks) {
    assert.ok(p >= 0 && p < pool.length, `序号越界：${p}`);
  }
});

test('DR-06b 一轮用完自动洗牌重开（used.length >= pool.length 时清零）', () => {
  const pool = DRAW_POOL.ur; // 最小池，便于构造"一轮用完"
  const usedAll = pool.map((_, i) => i);
  const seen = { ur: usedAll };
  // used 满了 ⇒ 实现应把 used 当空集重开，于是可以抽到任意序号
  let hit = 0;
  for (let k = 0; k < 30; k++) {
    const i = drawIdx('ur', pool, seen, () => 0);
    assert.ok(i >= 0 && i < pool.length);
    hit++;
  }
  assert.equal(hit, 30, '洗牌重开后仍应持续可抽');
});

test('DR-06c 各档独立记账：抽 ur 不影响 r 的已用序号', () => {
  const seen = {};
  seen.ur = [0, 1, 2];
  seen.r = [5, 6];
  // 在 ur 已用 [0,1,2] 的情况下抽 r，绝不能返回 5 或 6
  for (let k = 0; k < 20; k++) {
    const i = drawIdx('r', DRAW_POOL.r, seen, () => 0.9);
    assert.ok(i !== 5 && i !== 6, 'r 档抽到了自己已用的序号（记账串档了）');
  }
  // ur 仍只记得自己那三条
  assert.deepEqual(seen.ur, [0, 1, 2], 'ur 的记账被别的档污染了');
});

test('DR-06d roll 落袋：session 存 {t,i}、local 存该档已用序号且只追加不覆盖', () => {
  const session = memStore();
  const local = memStore();
  const a = drawRoll({ session, local, rnd: () => 0 });
  const b = drawRoll({ session, local, rnd: () => 0 });
  assert.ok(a && b, 'roll 应落袋');
  assert.equal(a.t, 'r', 'rnd=0 ⇒ 档位应为 r');
  const bag = JSON.parse(session.getItem(EGG_DRAW_KEY));
  assert.equal(bag.t, b.t);
  assert.equal(typeof bag.i, 'number');
  const seenObj = JSON.parse(local.getItem(EGG_DRAW_SEEN_KEY));
  assert.ok(Array.isArray(seenObj.r), 'local 应记r 档已用序号');
  assert.equal(seenObj.r.length, 2, '两次 roll 应累积两条已用序号');
  assert.notEqual(seenObj.r[0], seenObj.r[1], '两次 roll 的序号不应相同');
});

test('DR-06e 存储键用 bj 前缀（不得沿用老项目的 notesync_ 原名）', () => {
  assert.equal(EGG_DRAW_KEY, 'notesync_bj_draw');
  assert.equal(EGG_DRAW_SEEN_KEY, 'notesync_bj_draw_seen');
  // 反向闸：老键名不得残留在代码里
  assert.doesNotMatch(DRAW_CODE, /'notesync_draw'/);
  assert.doesNotMatch(DRAW_CODE, /'notesync_draw_seen'/);
});

/* ═══════════════════════════════════════════════════════════════════════
   DR-07 触发入口接上刷新按钮，且抽卡在 reload 之前
   ═══════════════════════════════════════════════════════════════════════ */

test('DR-07a 刷新按钮回调 = 先roll 再 reload（抽卡必须落在 reload 之前）', () => {
  const main = readFileSync(resolve(HERE, '../src/main.ts'), 'utf8');
  const i = main.indexOf('onRefresh:');
  assert.ok(i >= 0, 'main.ts 应仍有 onRefresh');
  const block = main.slice(i, i + 400);
  const iRoll = block.indexOf('roll()');
  const iReload = block.indexOf('location.reload()');
  assert.ok(iRoll >= 0, 'onRefresh 里应调roll()');
  assert.ok(iReload >= 0, 'onRefresh 里应保留原有 location.reload()');
  assert.ok(iRoll < iReload, '🔴 roll() 必须在 location.reload() 之前 —— reload 一执行后面就是死代码');
});

test('DR-07b 解锁成功后兑现上一拍的开奖（老项目 :3479/:3511 两处）', () => {
  const main = readFileSync(resolve(HERE, '../src/main.ts'), 'utf8');
  const n = main.split('eggDraw.consume()').length - 1;
  assert.equal(n, 2, '应在两处解锁成功路径各兑现一次（口令解锁 + 记忆解锁）');
});

test('DR-07c 券越界（池子改版后序号失效）⇒ 静默清袋不弹', () => {
  __resetDrawWait();
  const session = memStore({ [EGG_DRAW_KEY]: JSON.stringify({ t: 'r', i: 99999 }) });
  const shown = [];
  const r = drawConsume({ session, local: memStore(), show: (t, x) => shown.push([t, x]) });
  assert.equal(r, 'void');
  assert.equal(shown.length, 0, '越界券不该出卡');
  assert.ok(!session._has(EGG_DRAW_KEY), '越界券应被清掉');
});

test('DR-07d 档位不认识 ⇒ 静默清袋不弹', () => {
  __resetDrawWait();
  const session = memStore({ [EGG_DRAW_KEY]: JSON.stringify({ t: 'nope', i: 0 }) });
  const shown = [];
  const r = drawConsume({ session, local: memStore(), show: (t, x) => shown.push([t, x]) });
  assert.equal(r, 'void');
  assert.equal(shown.length, 0);
  assert.ok(!session._has(EGG_DRAW_KEY));
});

test('DR-07e 抽卡异常不挡住刷新：storage 写死抛异常时 roll 静默返回 null', () => {
  const bad = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceeded');
    },
    removeItem: () => {},
  };
  const r = drawRoll({ session: bad, local: bad, rnd: () => 0 });
  assert.equal(r, null, '写盘炸了应静默返回 null，而不是把异常抛给刷新按钮');
});

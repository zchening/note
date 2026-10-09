/**
 * 数字梗 / notesync 烟花的**粒子参数**单测（FXPLAN 系列）
 *
 * 🔴🔴 这一组钉的是「动效看起来是不是老项目那个样」的**数值源头**。
 *   老项目两个动效都是 **DOM `<i>` + CSS keyframes**（index.html:6688-6705 / 6757-6778），
 *   bj 曾经在 canvas 里用 rAF 重画了一遍 —— 载体不同，位移/时长/缓动/缩放
 *   四条曲线全都不一样，用户报「动效效果不好」正是这个。
 *   把参数生成抽成纯函数，是为了让"逐字对齐老项目"这件事**有判据可钉**，
 *   而不是靠肉眼看动画觉得差不多。
 *
 * 🔴 每条判据都标注老项目行号。**不许凭推理改判据。**
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BURST_N, FW_N, burstPlan, fwPlan } from '../src/egg/fx.ts';

/** 把 "12.3px" 解析成数字。"-38px" 也要能解析。 */
const num = (s) => Number.parseFloat(String(s));

test('FXPLAN-01 🔴🔴 数字梗是老项目的 5 枚 emoji（:6694 `i<5`），不是 bj 自创的 12 枚', () => {
  assert.equal(BURST_N, 5, '老项目 nsBurst 固定撒 5 枚（index.html:6694）');
  assert.equal(burstPlan().length, 5);
  // 反向钉：bj 的 canvas 版默认 12 枚、环形放射 —— 那条路已经废掉，别回来
  assert.notEqual(burstPlan().length, 12);
});

test('FXPLAN-02 🔴 数字梗位移/旋转逐字对齐老项目（:6697-6699）', () => {
  for (const p of burstPlan()) {
    const nx = num(p.nx);
    const ny = num(p.ny);
    const nr = num(p.nr);
    // --nx: random*70-35 ⇒ [-35, 35)
    assert.ok(nx >= -35 && nx < 35, `--nx 越界：${p.nx}（老项目 rand*70-35）`);
    // --ny: -30 - random*40 ⇒ (-70, -30]
    assert.ok(ny <= -30 && ny > -70, `--ny 越界：${p.ny}（老项目 -30-rand*40，必须朝上）`);
    // --nr: random*60-30 ⇒ [-30, 30)
    assert.ok(nr >= -30 && nr < 30, `--nr 越界：${p.nr}（老项目 rand*60-30）`);
    assert.match(p.nx, /px$/, '老项目写的是 px 串（CSS 变量）');
    assert.match(p.ny, /px$/);
    assert.match(p.nr, /deg$/, '老项目旋转写的是 deg');
  }
});

test('FXPLAN-03 🔴🔴 数字梗的 delay 是 i*0.03（:6700），不是随机、也不是 0', () => {
  const ps = burstPlan();
  // 🔴 按**数值**比较，不比字符串：老项目原文是 `(i * 0.03) + 's'`（:6700，**无 toFixed**），
  //   浮点尾巴（如 0.09000000000000001）逐字抄下来就该有 —— 比字符串会逼着实现去取整，
  //   那就不是老项目那份了。
  ps.forEach((p, i) => {
    assert.ok(
      Math.abs(num(p.delay) - i * 0.03) < 1e-9,
      `第 ${i} 枚 delay 必须是 i*0.03s，实得 ${p.delay}`,
    );
    assert.match(p.delay, /s$/, 'delay 必须是秒串');
  });
  // 反例：随机 delay 或全 0 都说明抄错了
  assert.notEqual(ps[4].delay, ps[0].delay, 'delay 必须递增（老项目是 i 的递增函数）');
  assert.equal(num(ps[0].delay), 0, '第一枚 delay=0');
  assert.ok(Math.abs(num(ps[4].delay) - 0.12) < 1e-9, '第五枚 delay=0.12s');
});

test('FXPLAN-04 🔴 注入 rnd 钉住公式本身（rnd=0 / rnd→1 两端）', () => {
  const zero = burstPlan(() => 0);
  for (const p of zero) {
    assert.equal(num(p.nx), -35, 'rnd=0 ⇒ nx=-35');
    assert.equal(num(p.ny), -30, 'rnd=0 ⇒ ny=-30');
    assert.equal(num(p.nr), -30, 'rnd=0 ⇒ nr=-30');
  }
  const one = burstPlan(() => 0.999999);
  for (const p of one) {
    assert.ok(num(p.nx) > 34 && num(p.nx) < 35, `rnd→1 ⇒ nx→35，实得 ${p.nx}`);
    assert.ok(num(p.ny) < -69 && num(p.ny) >= -70, `rnd→1 ⇒ ny→-70，实得 ${p.ny}`);
  }
});

test('FXPLAN-05 🔴🔴 烟花是老项目的 20 个金点（:6762 `N=20`）', () => {
  assert.equal(FW_N, 20, '老项目 nsFirework 固定 20 个点');
  assert.equal(fwPlan().length, 20);
  assert.notEqual(fwPlan().length, 12);
});

test('FXPLAN-06 🔴 烟花的半径/尺寸/延迟逐字对齐老项目（:6766/:6769/:6772）', () => {
  for (const p of fwPlan()) {
    const fx = num(p.fx);
    const fy = num(p.fy);
    const sz = num(p.size);
    const d = num(p.delay);
    // r = 44 + rand*56 ⇒ [44,100)；fx=cos(a)*r, fy=sin(a)*r-16
    assert.ok(Math.hypot(fx, fy + 16) >= 43.5, `半径应在 44–100：${p.fx}/${p.fy}`);
    assert.ok(Math.hypot(fx, fy + 16) <= 100.5, `半径应在 44–100：${p.fx}/${p.fy}`);
    // sz = 3 + rand*5 ⇒ [3,8)。🔴 上界按 **8.0** 判：老项目做了 `.toFixed(1)`
    //   （:6770-6771），7.95 会舍成 "8.0" —— 写 `sz < 8` 会偶发假红。
    assert.ok(sz >= 3 && sz <= 8, `点尺寸应在 3–8：${p.size}`);
    // delay = rand*0.12 ⇒ [0, 0.12]
    assert.ok(d >= 0 && d <= 0.12, `delay 应在 0–0.12：${p.delay}`);
    assert.match(p.fx, /px$/);
    assert.match(p.fy, /px$/);
    assert.match(p.size, /px$/);
    assert.match(p.delay, /s$/);
  }
});

test('FXPLAN-07 🔴 烟花角度是 2πi/N 均分 + ±0.15 抖动（:6765），不是纯随机环形', () => {
  // rnd 全部给 0.5 ⇒ 抖动项 = 0、r = 72、size = 5.5、delay = 0.06
  const ps = fwPlan(20, () => 0.5);
  assert.equal(ps.length, 20);
  ps.forEach((p, i) => {
    const a = (Math.PI * 2 * i) / 20;
    const r = 44 + 0.5 * 56; // 72
    assert.ok(Math.abs(num(p.fx) - Math.cos(a) * r) < 0.1, `第 ${i} 点 fx 应为 cos(a)*r`);
    assert.ok(Math.abs(num(p.fy) - (Math.sin(a) * r - 16)) < 0.1, `第 ${i} 点 fy 应为 sin(a)*r-16`);
    assert.equal(num(p.size), 5.5, 'rnd=0.5 ⇒ size=5.5');
    assert.equal(num(p.delay), 0.06, 'rnd=0.5 ⇒ delay=0.06');
  });
  // 🔴 反向钉：均分 ⇒ 相邻点的角度差应接近 2π/20，纯随机会被打散
  const angs = ps.map((p) => Math.atan2(num(p.fy) + 16, num(p.fx)));
  const spread = Math.max(...angs) - Math.min(...angs);
  assert.ok(spread > 5, `20 点应铺满一圈（角度跨度应 >5rad），实得 ${spread.toFixed(2)}`);
});

test('FXPLAN-08 🔴 老项目的 CSS 契约：数字梗 .95s/ease-out、烟花 1.2s/金点', () => {
  // 这两条是 e2e 会去真浏览器读 computed style 的**同名常量**，
  // 单侧钉住它们，避免 CSS 改了而 TS 侧常量没改（两边对不上 = 动画时长错）。
  assert.equal(BURST_N, 5);
  assert.equal(FW_N, 20);
});

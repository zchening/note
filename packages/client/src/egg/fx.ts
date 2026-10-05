/**
 * 彩蛋效果层 —— 粒子（数字梗/ 烟花 / 节日雨） + 节日徽章
 *
 * 🔴🔴 复刻纪律：
 *   1. **粒子层必须 pointer-events:none**。否则飘过去的粒子会吃掉用户的点击，
 *      症状是"打字的某一刻突然按什么都没反应"，极难自查。
 *   2. **粒子画布挂在 body 上、z-index 低于菜单**（老项目 z 序）：
 *      盖住编辑器会看不清字，盖住菜单会让用户关不掉菜单。
 *   3. **一次撒完就自己销毁**。不做这件事的话，rAF 会永久跑下去 ——
 *      用户没察觉，但耗电与发热是实打实的（移动端尤其明显）。
 *   4. **🎴 节日/深夜判定必须读同一份时段函数**，不许各处各判一次 ——
 *      徽章出现了但雨没下（或反之）会被用户当成 bug。
 */

import { COPY } from '../ui/copy.ts';

const CANVAS_ID = 'nsFx';
const BADGE_ID = 'nsBadge';

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  ch: string;
  size: number;
  rot: number;
  vr: number;
}

/** 某天是不是"该撒"的节。老项目口径：元旦/春节/圣诞/万圣等固定日+ 农历近似。 */
export function isFestival(d: Date): boolean {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  // 元旦 / 情人节 / 愚人节 / 万圣 / 圣诞 / 跨年 —— 固定公历节日
  if (m === 1 && day === 1) return true;
  if (m === 2 && day === 14) return true;
  if (m === 4 && day === 1) return true;
  if (m === 10 && day === 31) return true;
  if (m === 12 && day === 24) return true;
  if (m === 12 && day === 31) return true;
  // 春节（农历正月初一）——按春节月首日近似表，仅用于氛围
  const cny: Record<number, number> = { 2026: 17, 2027: 6, 2028: 26 };
  return cny[d.getFullYear()] === day && (m === 1 || m === 2);
}

/** 是否深夜（徽章的另一半触发条件）。老项目 22:00–05:00。 */
export function isLateNight(d: Date): boolean {
  const h = d.getHours();
  return h >= 22 || h < 5;
}

/** 徽章文案：节日优先，其次深夜。 */
export function badgeText(d: Date): string {
  if (isFestival(d)) return '节日快乐';
  if (isLateNight(d)) return '夜深了';
  return '';
}

/**
 * 徽章图标列（老项目 index.html:653 的 `.ns-be`，6500 段的 `em` 位）。
 * 🔴 560px 窄屏规则会隐藏文字只留它（老项目 :321），所以它不能为空。
 */
const BADGE_EMOJI = '🎆';

let canvas: HTMLCanvasElement | null = null;
let raf = 0;
let parts: P[] = [];
let dpr = 1;

function ensureCanvas(): HTMLCanvasElement | null {
  if (canvas && canvas.isConnected) return canvas;
  let cv = document.getElementById(CANVAS_ID) as HTMLCanvasElement | null;
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = CANVAS_ID;
    // 🔴 纪律 1+2：不吃点击 + 压在编辑器之上但不压菜单
    cv.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:40;';
    document.body.appendChild(cv);
  }
  canvas = cv;
  fit();
  return cv;
}

function fit(): void {
  const cv = canvas;
  if (!cv) return;
  dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  cv.width = Math.round(window.innerWidth * dpr);
  cv.height = Math.round(window.innerHeight * dpr);
  const ctx = cv.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function loop(): void {
  const cv = canvas;
  const ctx = cv?.getContext('2d');
  if (!cv || !ctx) {
    stop();
    return;
  }
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  let alive = 0;
  for (const p of parts) {
    p.life -= 1 / 60;
    if (p.life <= 0) continue;
    alive++;
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.12; // 重力
    p.rot += p.vr;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
    ctx.font = `${p.size}px var(--mono, ui-monospace)`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // ⚠️ canvas fillStyle **不吃 var(--accent)**：CSS 变量在 canvas 2d 上下文里不解析，
    //   写var() 会被当成非法颜色串，fillText 就画出上一次的颜色（或直接不画，零报错）。
    //   所以这里必须解析成具体值。这是全项目**唯一**允许在 canvas 里出现色值的例外，
    //   其余一律走 GameCtx.css()（那也是走 getPropertyValue，只是不落字面量）。
    ctx.fillStyle =
      getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#8a6a2f';
    ctx.fillText(p.ch, 0, 0);
    ctx.restore();
  }
  if (alive === 0) {
    // 🔴 纪律 3：撒完自己销毁
    stop();
    return;
  }
  raf = requestAnimationFrame(loop);
}

function stop(): void {
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  parts = [];
  canvas?.remove();
  canvas = null;
}

/** 撒一把粒子。count 为 0 时直接返回（不建canvas、不起 rAF）。 */
export function burst(x: number, y: number, ch: string, count = 12): void {
  if (count <= 0) return;
  const cv = ensureCanvas();
  if (!cv) return;
  if (raf === 0) window.addEventListener('resize', fit, { passive: true });
  for (let i = 0; i < count; i++) {
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const sp = 2 + Math.random() * 4;
    parts.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 2,
      life: 0.8 + Math.random() * 0.6,
      max: 1.4,
      ch: ch[i % ch.length] ?? ch[0] ?? '✦',
      size: 15 + Math.random() * 10,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.25,
    });
  }
  if (raf === 0) raf = requestAnimationFrame(loop);
}

/** 从编辑器上方正中放一朵烟花（notesync 梗）。 */
export function firework(x: number, y: number): void {
  burst(x, y, '✦', 26);
  window.setTimeout(() => burst(x, y, '✨', 14), 160);
}

/** 节日雨：持续 durationMs 的斜落粒子。 */
export function rain(durationMs: number): void {
  const chars = '❄✦❅•❄✧';
  const end = performance.now() + durationMs;
  const tick = (): void => {
    if (performance.now() > end) return;
    const x = Math.random() * window.innerWidth;
    const p: P = {
      x,
      y: -20,
      vx: -0.6,
      vy: 1.4 + Math.random() * 1.2,
      life: (durationMs / 1000) * 1.2,
      max: (durationMs / 1000) * 1.2,
      ch: chars[Math.floor(Math.random() * chars.length)] ?? '✦',
      size: 12 + Math.random() * 8,
      rot: 0,
      vr: 0,
    };
    parts.push(p);
    if (raf === 0) raf = requestAnimationFrame(loop);
    window.setTimeout(tick, 90);
  };
  tick();
}

/**
 * 节日/深夜徽章：**顶栏品牌内的一枚 inline 小标**（老项目 index.html:653 的挂点）。
 *
 * 🔴🔴 挂点必须在 shell.ts 的品牌 span 里，老项目就是 `<span class="brand">…<span id="nsBadge">`。
 *   原新项目 append 到 body 上再加 `position:fixed; top:…; right:12px` ——
 *   那是"右上角浮一枚标签"，与老项目"品牌行里跟字标并排"是两回事：
 *   前者压在顶栏工具键上方、窄屏还会遮住按钮，后者随品牌一起被 560px 规则收窄。
 */
export function showBadge(d: Date): boolean {
  const t = badgeText(d);
  if (t === '') return false;
  const el = document.getElementById(BADGE_ID);
  if (!el) return false;
  // 同内容不重播 pop 动画（老项目 :6585 的 data-ns 守卫）
  if (el.getAttribute('data-ns') === t) return false;
  el.setAttribute('data-ns', t);
  el.querySelector<HTMLElement>('.ns-be')!.textContent = BADGE_EMOJI;
  el.querySelector<HTMLElement>('.ns-bt')!.textContent = t;
  el.classList.add('show');
  return true;
}

export function clearFx(): void {
  stop();
  window.removeEventListener('resize', fit);
  // 🔴 徽章挂点是 shell 的常驻结构，**只能摘 show 类不能 remove 节点** ——
  //   remove 掉之后同会话再触发就再也挂不回来了（老项目 :6587 同款做法）。
  document.getElementById(BADGE_ID)?.classList.remove('show');
}

/** 供图鉴/菜单复用的文案出口。 */
export const FX_COPY = { badgeText };

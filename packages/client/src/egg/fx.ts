/**
 * 彩蛋效果层 —— 粒子（数字梗/ 烟花 / 节日雨） + 节日/深夜徽章 + 每日一句话
 *
 * 🔴🔴 复刻纪律：
 *   1. **粒子层必须 pointer-events:none**。否则飘过去的粒子会吃掉用户的点击，
 *      症状是"打字的某一刻突然按什么都没反应"，极难自查。
 *   2. **粒子画布挂在 body 上、z-index 低于菜单**（老项目 z 序）：
 *      盖住编辑器会看不清字，盖住菜单会让用户关不掉菜单。
 *   3. **一次撒完就自己销毁**。不做这件事的话，rAF 会永久跑下去 ——
 *      用户没察觉，但耗电与发热是实打实的（移动端尤其明显）。
 *   4. **节日/深夜判定必须读同一份时段函数**，不许各处各判一次 ——
 *      徽章出现了但雨没下（或反之）会被用户当成 bug。
 *   5. 🔴 **顶栏胶囊（`#nsBadge`）与顶部每日一句话（`#nsDayToast`）是两样东西**，
 *      不要合并，也不要用一个的判据去推另一个：
 *      前者是 emoji + 一句短语、跟着 `badgeAt()` 走；
 *      后者是纯文案一句、跟着 localStorage 的「当天/切篇」记账走，4.2 秒自收。
 *
 * 🔴 本项目此前自创过一套"四时问候"，用户拍板**老项目没有的就去掉** ——
 *   那套已删干净，现在这里的文案全部来自老项目 index.html。
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

/**
 * 节日/深夜档位表 —— 老项目 index.html:6521-6532 `NS_FEST_META` **逐字**。
 *
 * 🔴🔴 本项目此前是**自创**的一层：只有 `badgeText()` 返回两句自造文案
 *   （「节日快乐」「夜深了」）+ 一枚写死的 🎆。用户报障第 5 条正是这个 ——
 *   深夜该显示的是🌙 与「夜深了，写完这条就睡」，而不是 🎆 与「夜深了」。
 *   emoji 与文案是**同一个契约**：换文案不换 emoji 会让深夜看起来像在过年。
 *
 * 文案与 emoji 都在 ui/copy.ts（`COPY.badge`），本文件只管"哪天命中哪档"。
 */
const FEST_META = COPY.badge;

/** 老项目 index.html:6520 `NS_FEST` 原表 —— 2024–2060 公历节日直出表。
 *格式：`年份 | 年内条目`，条目是 `MMDD + 两字母节日 key`，`|` 分隔年份。
 * 🔴 这张表是**运行时数据**不是装饰：老项目注释写明「过期自然静默，免运行时农历换算」，
 *   所以年份跨过2060 后 `festKeyAt` 返回 null，徽章自动不冒—— 不要"顺手"改成循环取模。 */
const NS_FEST = [
  '20240118lb,0209cx,0210cj,0224yx,0610dy,0810qx,0917zq,1011cy',
  '20250107lb,0128cx,0129cj,0212yx,0531dy,0829qx,1006zq,1029cy',
  '20260126lb,0216cx,0217cj,0303yx,0619dy,0819qx,0925zq,1018cy',
  '20270115lb,0205cx,0206cj,0220yx,0609dy,0808qx,0915zq,1008cy',
  '20280104lb,0125cx,0126cj,0209yx,0528dy,0826qx,1003zq,1026cy',
  '20290122lb,0212cx,0213cj,0227yx,0616dy,0816qx,0922zq,1016cy',
  '20300111lb,0202cx,0203cj,0217yx,0605dy,0805qx,0912zq,1005cy',
  '20310101lb,0122cx,0123cj,0206yx,0624dy,0824qx,1001zq,1024cy',
  '20320120lb,0210cx,0211cj,0225yx,0612dy,0812qx,0919zq,1012cy',
  '20330108lb,0130cx,0131cj,0214yx,0601dy,0801qx,0908zq,1001cy',
  '20340127lb,0218cx,0219cj,0305yx,0620dy,0820qx,0927zq,1020cy',
  '20350116lb,0207cx,0208cj,0222yx,0610dy,0810qx,0916zq,1009cy',
  '20360105lb,0127cx,0128cj,0211yx,0530dy,0828qx,1004zq,1027cy',
  '20370123lb,0214cx,0215cj,0301yx,0618dy,0817qx,0924zq,1017cy',
  '20380112lb,0203cx,0204cj,0218yx,0607dy,0807qx,0913zq,1007cy',
  '20390102lb,0123cx,0124cj,0207yx,0527dy,0826qx,1002zq,1026cy',
  '20400121lb,0211cx,0212cj,0226yx,0614dy,0814qx,0920zq,1014cy',
  '20410110lb,0131cx,0201cj,0215yx,0603dy,0803qx,0910zq,1003cy,1230lb',
  '20420121cx,0122cj,0205yx,0622dy,0822qx,0928zq,1022cy',
  '20430118lb,0209cx,0210cj,0224yx,0611dy,0811qx,0917zq,1011cy',
  '20440107lb,0129cx,0130cj,0213yx,0531dy,0731qx,1005zq,1029cy',
  '20450125lb,0216cx,0217cj,0303yx,0619dy,0819qx,0925zq,1018cy',
  '20460114lb,0205cx,0206cj,0220yx,0608dy,0808qx,0915zq,1008cy',
  '20470103lb,0125cx,0126cj,0209yx,0529dy,0827qx,1004zq,1027cy',
  '20480122lb,0213cx,0214cj,0228yx,0615dy,0816qx,0922zq,1016cy',
  '20490111lb,0201cx,0202cj,0216yx,0604dy,0805qx,0911zq,1005cy',
  '20500101lb,0122cx,0123cj,0206yx,0623dy,0823qx,0930zq,1024cy',
  '20510120lb,0210cx,0211cj,0225yx,0613dy,0812qx,0919zq,1013cy',
  '20520109lb,0131cx,0201cj,0215yx,0601dy,0801qx,0907zq,1030cy',
  '20530127lb,0218cx,0219cj,0305yx,0620dy,0820qx,0926zq,1020cy',
  '20540116lb,0207cx,0208cj,0222yx,0610dy,0810qx,0916zq,1009cy',
  '20550105lb,0127cx,0128cj,0211yx,0530dy,0829qx,1005zq,1028cy',
  '20560124lb,0214cx,0215cj,0229yx,0617dy,0817qx,0924zq,1017cy',
  '20570112lb,0203cx,0204cj,0218yx,0606dy,0806qx,0913zq,1007cy',
  '20580102lb,0123cx,0124cj,0207yx,0625dy,0825qx,1002zq,1025cy',
  '20590121lb,0211cx,0212cj,0226yx,0614dy,0814qx,0921zq,1014cy',
  '20600111lb,0201cx,0202cj,0216yx,0603dy,0802qx,0909zq,1002cy,1230lb',
].join('|');

type FestKey = keyof typeof FEST_META;

/** 'yyyyMMdd' → 节日 key。老项目 :6533 `NS_FEST_ROWS`。 */
const FEST_ROWS: Record<string, string> = {};
/** 年份 → 该年春节初一（'yyyyMMdd'）。老项目 :6534 `NS_CJ_BY_YEAR`。 */
const CJ_BY_YEAR: Record<string, string> = {};
for (const seg of NS_FEST.split('|')) {
  const y = seg.slice(0, 4);
  for (const it of seg.slice(4).split(',')) {
    const ds = y + it.slice(0, 4);
    const k = it.slice(4);
    FEST_ROWS[ds] = k;
    if (k === 'cj') CJ_BY_YEAR[y] = ds;
  }
}

/**
 * 公历日期 → 节日 key（无则null）。老项目 index.html:6547-6561 `nsFestAt`。
 *
 * 🔴 叠加规则照抄：查表**优先于**元旦特判 —— 腊八恰落公历 1-1（2033/ 2050 年）时
 *   显腊八文案，而不是元旦。这条顺序反了就是一次跨几十年的显示漂移。
 * 🔴 春节档= 初一至初三，所以初二/初三天要靠 `CJ_BY_YEAR` 做日期差算，不入表。
 */
export function festKeyAt(date: Date): FestKey | null {
  const md =
    String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0');
  const y = date.getFullYear();
  const k = FEST_ROWS[y + md];
  if (k !== undefined) return k as FestKey;
  if (md === '0101') return 'nj';
  const cj = CJ_BY_YEAR[y];
  if (cj) {
    const cjMs = Date.UTC(+cj.slice(0, 4), +cj.slice(4, 6) - 1, +cj.slice(6, 8));
    const nowMs = Date.UTC(y, date.getMonth(), date.getDate());
    const diff = Math.round((nowMs - cjMs) / 86_400_000);
    if (diff === 1 || diff === 2) return 'cj';
  }
  return null;
}

/**
 * 是否深夜。老项目 index.html:6576：`h >= 22 || h < 6`（22:00–06:00）。
 *
 * 🔴🔴 此前本项目写的是 `h >= 22 || h < 5` —— **少一小时**。
 *   05:00–05:59 这一小时在老项目是深夜（🌙 劝睡），在本项目是"没有徽章"。
 *   用户报障第 5 条说的"深夜显示不对"有一半来自这个边界。
 *   🔴 别和 theme.ts 的 `isNightByClock`（19:00–07:00，夜间模式）混为一谈：
 *     那是**配色**时段（老项目 :1009-1010），这是**文案**时段（老项目 :6576），两个数不一样。
 */
export function isLateNight(d: Date): boolean {
  const h = d.getHours();
  return h >= 22 || h < 6;
}

/** 某天是不是"该撒"的节。老项目口径 = `festKeyAt` 命中表（不含夜深档）。 */
export function isFestival(d: Date): boolean {
  return festKeyAt(d) !== null;
}

/**
 * 徽章状态机 —— 老项目 index.html:6574-6579 `nsBadgeAt`。
 *
 * 🔴🔴 **深夜优先于节日**（老项目 :6573 注释：大过年的深夜也先劝睡）。
 *   本项目此前是 `isFestival` 优先，于是除夕深夜显示「节日快乐」，
 *   而老项目显示「夜深了，写完这条就睡」。顺序反了就是语义反了。
 *
 * @returns 该档的 emoji 与文案；无档返回 null。
 */
export function badgeAt(d: Date): { em: string; tx: string } | null {
  if (isLateNight(d)) return FEST_META.night;
  const k = festKeyAt(d);
  return k ? FEST_META[k] : null;
}

/**
 * 徽章文案 —— 只有文案的那一半（emoji 走 `badgeAt`）。
 *
 * 🔴 保留这个函数是因为 `FX_COPY` 出口与图鉴复用它；判档一律走 `badgeAt`。
 */
export function badgeText(d: Date): string {
  return badgeAt(d)?.tx ?? '';
}

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

/**
 * 🔴🔴 该下什么字符 —— 老项目 index.html:6599-6600 `nsRainStart` 首两行**逐字**：
 *   `var meta = NS_FEST_META[key]; if (!meta || !meta.rain.length) return;`
 *   `s.textContent = meta.rain[i % meta.rain.length];`
 *
 * 即：**雨的内容由当天的节日档决定**，而且是**该节日的 emoji** ——
 *   过年下🎆🧧🏮、端午下 🐉🍙、重阳下 🍂（值全在 ui/copy.ts 的 `COPY.badge`，逐字抄自老项目 :6521-6532）。
 *
 * 🔴🔴 降级必须是「**不下雨**」，不是「退回下雪花」。
 *   bj 此前 `rain()` 里硬编码 `const chars = '❄✦❅•❄✧'` —— **任何时候都在下雪花**，
 *   圣诞下雪、端午下雪、生日下雪，只有 emoji 不同。
 *   症状是「界面看着挺热闹，但没有任何一处和今天是什么日子有关」——
 *   属于"功能在跑、结果全错"的静默降级，最难被用户归因。
 *
 * 🔴🔴 **判档只看 `festKeyAt`，不套 `isLateNight`** —— 这是逐字照抄老项目 :6647：
 *   `const f = nsFestAt(new Date());`（不是 `nsBadgeAt`）。
 *   后果是**除夕深夜照样下鞭炮雨**，只有顶栏徽章换成 🌙 劝睡（老项目 :6619
 *   `greetSrc || meta` 那句注释「深夜+节日=🌙 先劝睡，**雨仍走节日 meta**」就是这个意思）。
 *   如果这里改成"深夜一律不下雨"，大年夜的鞭炮就没了 —— 那是自己发明的差异。
 *   `night` 档的 `rain: []`（老项目 :6531）是给"万一判到 night 就不雨"留的口子，
 *   而 `festKeyAt` 永远不返回 `'night'`（它只吐表里的 9 个节日 key + nj/cj），
 *   所以那条分支实际不可达 —— 保留原值是为了与老项目逐字一致，不是为了走它。
 *
 * @param d 判定时刻。老项目用的是**当前时刻**（`nsFestWelcome` 里 `new Date()`）。
 * @returns 该档的雨字符；查不到节日档（含夜深但当天非节日）返回**空数组**（= 不下雨）。
 */
export function rainCharsFor(d: Date): readonly string[] {
  const k = festKeyAt(d);
  if (!k) return [];
  const chars = FEST_META[k].rain;
  // 🔴 老项目 :6600 的守卫是 `!meta.rain.length` ⇒ 空数组即"这一档没有雨"。
  //   照抄这个语义，不要在这里补默认雪花 —— 那正是本次要治的退化。
  return chars.length ? chars : [];
}

/**
 * 当前在下的雨有几场。**必须计数**：两场雨重叠时，先结束那场的定时器若直接
 * 摘 `ns-raining`，后一场还在下却让位判据失效 ⇒ 问候/下雨期间照样弹开奖卡。
 */
let rainDepth = 0;

/**
 * 节日雨：持续 durationMs 的斜落粒子。
 *
 * @param durationMs 雨持续时长。
 * @param chars 该下什么字符。**必须**由 `rainCharsFor(d)` 给（老项目 :6609
 *   `meta.rain[i % meta.rain.length]`）—— 空数组 ⇒ **直接返回，什么都不撒**。
 */
export function rain(durationMs: number, chars: readonly string[] = rainCharsFor(new Date())): void {
  // 🔴 空字符集 = 这一档不该有雨（老项目 :6600 的 `return`）。绝不能兜底成雪花。
  if (!chars.length) return;
  const end = performance.now() + durationMs;
  // 🔴 让位标记：开奖卡的 `drawBusy()` 要判「节日雨在场时不弹卡」（老项目 nsDrawBusy 判
  //   `#nsRain:not(.hidden)`）。bj 的雨是 canvas 粒子层、无常驻节点，故在雨期间给
  //   `body` 挂 `.ns-raining`，雨停自动摘 —— 让 drawBusy 有一个与老项目同义的在场判据。
  //   🔴 必须挂在 `body` 上而不是 canvas 上：canvas 是 burst/firework 共用的，按存在判会误判。
  //   🔴🔴 摘标记必须按**计数**（不是每场雨各自一把 setTimeout 直接 remove）：
  //     两场雨重叠时，先结束那场的定时器会把标记摘掉，而另一场还在下 ——
  //     症状是"雨还在飘、开奖卡却已经弹出来"，且偶发（取决于重叠时机）。
  if (typeof document !== 'undefined' && document.body) {
    rainDepth += 1;
    document.body.classList.add('ns-raining');
  }
  window.setTimeout(() => {
    if (typeof document === 'undefined' || !document.body) return;
    rainDepth = Math.max(0, rainDepth - 1);
    if (rainDepth === 0) document.body.classList.remove('ns-raining');
  }, durationMs + 600);

  /** 老项目 :6609 的 `i`：这是第几个雨点（0 起）。用来 `i % len` 轮转字符。 */
  let i = 0;
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
      // 🔴 老项目 :6609 是 `meta.rain[i % meta.rain.length]`（**轮转**，不是随机）。
      //   轮转才能保证 30 个雨点里三种字符都出现；改成随机会有缺席的种类，
      //   而用户是靠"看到了三种"来判断"这是过年的雨"的。
      ch: chars[i % chars.length] ?? '',
      size: 12 + Math.random() * 8,
      rot: 0,
      vr: 0,
    };
    i += 1;
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
  const b = badgeAt(d);
  if (!b) return false;
  const el = document.getElementById(BADGE_ID);
  if (!el) return false;
  // 🔴 守卫比对的是 `em + tx`（老项目 index.html:6584），不是只有文案 ——
  //   只比文案的话，同一句文案换档（如春节→除夕文案都是短句）就不会重播动画。
  const ns = b.em + b.tx;
  if (el.getAttribute('data-ns') === ns) return false;
  el.setAttribute('data-ns', ns);
  // 🔴 560px 窄屏规则会隐藏文字只留它（老项目 :321），所以 emoji 列不能为空。
  el.querySelector<HTMLElement>('.ns-be')!.textContent = b.em;
  el.querySelector<HTMLElement>('.ns-bt')!.textContent = b.tx;
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

/* ───────────────────────── 每日一句话（老项目 v9.3.9） ───────────────────────── */

/** 气泡挂点 id。老项目 index.html:8446 `#nsDayToast`。*/
const DAY_TOAST_ID = 'nsDayToast';

/** 老项目 :8425 的 `ymd`：`yyyyMMdd` 本地日期串（不是 UTC —— 跨时区会差一天）。 */
function greetDayKey(d: Date): string {
  return (
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0')
  );
}

/** localStorage 读；老项目 :8427 用 try/catch 包着（隐私模式下写入会抛）。 */
function lsGet(k: string): string {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}

/**
 * 该不该递这句 —— 老项目 index.html:8423-8436 的判定，抽成纯函数是为了能钉测试。
 *
 * 🔴 规则（逐条对老项目）：
 *   1. 首页（noteId 为空）不递；
 *   2. 当天已递过**且**还是同一篇（刷新）→ 不递（不打扰）；
 *   3. 节日问候气泡 `#nsGreet` 在场 → 让位（不叠两层）；
 *   4. 更新提示 pill `#versionToast` 在场 → 让位，且**不消耗**当天/切篇记账
 *      （老项目 :8433 注释：不消耗，下次开笔记再试）；
 *   5. 草稿/冲突条 `#draftBar` 在位 → 让位。
 *
 * @returns 该递的一句；不该递返回 null。
 */
export function pickDailyLine(
  noteId: string,
  now: Date,
  ls: { get(k: string): string },
  /** 同位浮层是否在场（`#nsGreet` / `#versionToast` / `#draftBar`）。 */
  blocked: boolean,
  rnd: () => number = Math.random,
): string | null {
  if (noteId === '') return null;
  const ymd = greetDayKey(now);
  const lastDay = ls.get(COPY.greetDayKey);
  const lastNote = ls.get(COPY.greetNoteKey);
  const lastLine = ls.get(COPY.greetLineKey);
  const firstToday = lastDay !== ymd;
  const diffNote = lastNote !== noteId;
  // 当天弹过且还是这篇（刷新）→ 不打扰
  if (!(firstToday || diffNote)) return null;
  if (blocked) return null;
  // 不与上一次重复（老项目 :8437-8439）；池被滤空时回落全池
  const pool = COPY.dailyLines.filter((s) => s !== lastLine);
  const use = pool.length > 0 ? pool : [...COPY.dailyLines];
  //🔴 `?? use[0]` 不是老项目行为（老项目直接取 `pool[i]`，越界就是 undefined→ 渲染出空toast）。
  //   加它是因为 rnd 是**测试注入口**，而 `Math.random()` 恒返回 [0,1)、
  //   越界只在注入口给1 时发生。返回空串会让气泡显示成"有壳无字"，
  //   那是最难察觉的一类 UI 漂移，所以宁可递第一句。
  return use[Math.floor(rnd() * use.length)] ?? use[0] ?? '';
}

/**
 * 递一句「每日一句话」气泡 —— 老项目 index.html:8421-8451 `nsDayGreet`。
 *
 * 🔴 渲染位置是**顶部居中**（`top:54px`，老项目 :114-115），不是正文上方 ——
 *   与顶栏那枚胶囊（`#nsBadge`）是两样互不相关的东西，别合并。
 * 🔴 计时 4.2 秒（老项目 :8449），不是别的浮层用的 2/3/5秒。
 *
 * @param noteId 当前笔记名（空串 = 首页不递）
 * @returns 实际递出去的那句；没递返回 null。
 */
export function dayGreet(noteId: string, now: Date = new Date()): string | null {
  try {
    const blocked =
      !!document.querySelector('#nsGreet.show') ||
      !!document.querySelector('#versionToast.show') ||
      // 🔴 v1.13.0：切档气泡与每日一句**同一个位置**（styles.css 里两个 id 共用一条规则），
      //   同时出现就是两层胶囊叠在一起。老项目 :8433 的让位规则适用于所有同位浮层，
      //   而它的切档气泡用的正是 `#versionToast` —— 所以"切完皮肤不让问候弹"
      //   是老项目的既有行为，bj 换了 id 就得把它补进这张清单。
      //   🔴 也让位**不消耗**当天记账（老项目同条注释：下次开笔记再试）。
      !!document.querySelector('#skinToast.show') ||
      !!document.querySelector('#draftBar:not(.hidden)');
    const line = pickDailyLine(
      noteId,
      now,
      { get: lsGet },
      blocked,
    );
    if (line === null) return null;
    const ymd = greetDayKey(now);
    const firstToday = lsGet(COPY.greetDayKey) !== ymd;
    try {
      localStorage.setItem(COPY.greetNoteKey, noteId);
      localStorage.setItem(COPY.greetLineKey, line);
      if (firstToday) localStorage.setItem(COPY.greetDayKey, ymd);
    } catch {
      /* 隐私模式写不进去：不影响这一句递出去 */
    }
    let el = document.getElementById(DAY_TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = DAY_TOAST_ID;
      document.body.appendChild(el);
    }
    el.textContent = line;
    // 重启入场动画（老项目 :8448 同款：摘 show → 强制回流 → 加 show）
    el.classList.remove('show');
    void (el as HTMLElement & { offsetWidth?: number }).offsetWidth;
    el.classList.add('show');
    window.setTimeout(() => el?.classList.remove('show'), COPY.greetMs);
    return line;
  } catch {
    // 🔴 老项目整段包 try/catch（:8422/:8450）：问候是氛围，不许它把进笔记的流程带崩。
    return null;
  }
}

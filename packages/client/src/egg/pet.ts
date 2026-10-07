/**
 * 桌宠（老项目叫「桌宠」，本体是一只螃蟹）—— **常驻顶栏下沿左右爬行**
 *
 * 🔴🔴🔴 移植依据：老项目 index.html
 *   · :11183 `petBlank()`  … adopted **缺省 false**（「默认关」是用户拍板的）
 *   · :11198 `petMount()`  … 挂 header 下沿、0 占宽、每 60ms 走 0.35px
 *   · :11200 SVG           … 身体弧线 + 三条腿 + 两只金色眼睛（viewBox 0 0 26 26）
 *   · :10422-10434 样式    … absolute/bottom:-11px + 上下浮动 + 睡着/点头两态
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么单独立一个模块（而不是塞进 egg/games.ts）
 *
 *   games.ts 里的 `petGame()` 是**彩蛋门牌 /pet 的页面**（打开游戏外壳、占满舞台），
 *   而这一只是**任何笔记页都常驻在顶栏下沿的那只**——两者形态完全不同：
 *     · 门牌页：一屏一舞台、有退出按钮、进去才出现；
 *     · 常驻那只：24×24 骑在 header 下沿、不占布局、每 60ms 横向走一段。
 *   bj 此前只有前者，于是用户报障「螃蟹在顶栏爬行」——**它压根没被实现过**。
 *
 * 🔴 领养语义照抄老项目：**访问 /pet 即领养**（`petBlank().adopted` 默认 false，
 *   所以不领养就永远不出现，别做成"默认开"）。
 */

import { eggBrowserStore } from './registry.ts';

const PET_KEY = 'notesync_bj_pet';

export interface PetState {
  /** 是否领养过。老项目缺省 false = 默认关。 */
  adopted: boolean;
  /**
   * 形态档 0-3 → 幼体/成体/胖体/长老（老项目 `['幼体','成体','胖体','长老'][p.stage]`，:11326）。
   *
   * 🔴🔴 **只升不降**（老项目 :11220 `if (st > PET.stage)`）：`ate` 只会累加，
   *   形态却可能因为换养成一只吃字少的档案而回退 —— 老项目靠这条 `>` 把回退吃掉。
   *   判据 PET-03 钉死这条。
   */
  stage: number;
  /** 累计吃掉的字数（老项目 `PET.ate`）。只记计数，**吞掉的原文一个字都不落盘**（红线）。 */
  ate: number;
  /** 醒着的天数（老项目 `PET.days`，按 `born` 现算，clamp ≥1）。 */
  days: number;
  /**
   * 16 格柜子（老项目 `PET.shelf`）。存的是**索引 0-15**，不是名字 ——
   * 名字在 `PET_TRINKET` 里按索引取。存名字的话，改一次文案就要迁移全部老存档。
   */
  shelf: number[];
  /** 领养时刻（ms）。`days` 由它现算，多端一致。 */
  born: number;
  /** 最近一次互动时间戳（ms）。 */
  last: number;
  /** 睡着（点它唤醒）。老项目：7 天不碰就睡，永不死。 */
  asleep: boolean;
  /**
   * 放归时刻（ms），0 = 没放归过（老项目 `PET.retiredAt`）。
   *
   * 🔴 放归**不删数据**，只是打这个时间戳 + 睡着（老项目 :11381-11386），
   *   档案保留 30 天可原样认领。所以这个字段一旦非 0，就还认得回来。
   */
  retiredAt: number;
  /**
   * 学舌/对话计数（老项目 `talked`）。
   *
   * 🔴 老项目 `petBlank` 里声明了它，但**全库再无任何一处读写**
   *   （已 grep：`talked` 只出现在 :11183 那一行）。所以它是一个**只有初值、没有消费者**的字段。
   *   这里照样补上以保持存档形状与老项目同构（换养时字段一一对应），
   *   但**不给它编造用途** —— 凭空让点击数 +1 就是给老项目加它没有的功能。
   */
  talked: number;
}

/** 柜子格数。老项目 `PET.shelf.length >= 16` / 面板「柜子 N / 16」。 */
export const SHELF_SIZE = 16;

/**
 * 16 件收藏品（老项目 `PET_TRINKET`，:11191 **逐字**）。
 *
 * 🔴 顺序即索引：`shelf` 存的下标必须能索引到这里，判据 PET-06 钉死长度 16。
 */
export const PET_TRINKET: readonly string[] = [
  '橡皮鸭', '半块砖', '1987 硬币', '迷你恐龙', '会响的勺', '空白便签', '亮的那颗', '断齿梳子',
  '三叶草', '旧车票', '玻璃珠', '铁环', '贝壳', '小螺丝', '火柴盒', '月亮碎片',
] as const;

/** 形态名（老项目面板 `['幼体','成体','胖体','长老'][p.stage]`，:11326 逐字）。 */
export const STAGE_NAMES: readonly string[] = ['幼体', '成体', '胖体', '长老'] as const;

/**
 * 吃字数 → 形态档（老项目 :11219 逐字）：
 * `st = ate > 9000 ? 3 : ate > 3000 ? 2 : ate > 600 ? 1 : 0`
 *
 * 🔴🔴 **全是 `>` 不是 `>=`**：ate 恰好 600 仍是幼体，601 才升成体。
 *   写成 `>=` 的话「吃了 600 字」那天就提前升档，与老项目不符。
 *   判据 PET-01 把 8 个边界值全钉死。
 */
export function stageForAte(ate: number): number {
  return ate > 9000 ? 3 : ate > 3000 ? 2 : ate > 600 ? 1 : 0;
}

/** 形态档 → 名字。越界回退「幼体」而不是 `undefined`（存档被写坏时不许面板出 `undefined`）。 */
export function stageName(stage: number): string {
  return STAGE_NAMES[stage] ?? STAGE_NAMES[0] ?? '幼体';
}

/** 醒着几天（老项目 :11295/:11319 `1 + floor((now - born) / day)`，clamp ≥1）。 */
export function daysSince(born: number, now: number): number {
  return Math.max(1, 1 + Math.floor((now - born) / DAY_MS));
}

const DAY_MS = 86_400_000;

function blank(): PetState {
  return {
    adopted: false,
    stage: 0,
    ate: 0,
    days: 1,
    shelf: [],
    // 🔴 `born` 给 now（老项目 :11183 同款）：它是 `days` 的基准，
    //   给 0 会让 `daysSince` 算出天文数字级别的天数。
    born: Date.now(),
    // 🔴🔴 这里**刻意保留 bj 原有的 `last: 0`**，而不是老项目的 `Date.now()`。
    //   老项目那个 now 是个无用值 —— `last` 的所有消费者都先判 `adopted`
    //   （`withSleep` 的 `!s.adopted` 早退、面板要先进 /pet 才领养），
    //   所以「未领养时 last 是 0 还是 now」用户永远看不到。
    //   而 bj 此前就是 0，且 VP-12 逐字钉着这条 ⇒ 改它属于**没人要求的语义变更**，
    //   还顺手让一条既有判据变红。此处按"不改无关行为"纪律保留 0。
    last: 0,
    asleep: false,
    retiredAt: 0,
    talked: 0,
  };
}

/**
 * 读桌宠状态。
 *
 * 🔴 读不出来必须回落成「未领养」而不是抛错：localStorage 在隐私模式/借壳里会抛，
 *   抛出去的话整个 boot 挂掉 ⇒ **整个应用打不开**。桌宠是装饰，不配这个风险。
 */
export function readPet(): PetState {
  try {
    const raw = eggBrowserStore().getItem(PET_KEY);
    if (!raw) return blank();
    const j = JSON.parse(raw) as Partial<PetState>;
    return normalize(j);
  } catch {
    return blank();
  }
}

/**
 * 把任意存档补成合法 `PetState` —— **老存档兼容的唯一入口**。
 *
 * 🔴🔴🔴 本函数是本次移植里**风险最高的一行**：老用户的 localStorage 里躺着的是
 *   **只有 3 个字段**的 `{adopted, asleep, last}`（bj 此前的形状）。若这里不做
 *   逐字段兜底，`stage/ate/shelf` 会是 `undefined` ⇒ 面板显示 `吃了 undefined 字`、
 *   `p.shelf.length` 抛错 ⇒ **老用户的螃蟹变空壳甚至白屏**。
 *   ⇒ 一律「读得到就用，读不到/类型不对就回退成 `blank()` 的对应项」。
 *
 * 老项目对照：`petLoad()` 用 `Object.assign(petBlank(), o)`（:11185）——
 * 同样式「先铺满默认值再盖上存档」，所以**缺字段的老存档在老项目上也是补默认值**，
 * 行为一致。差别是老项目那份没做类型校验（`stage: "3"` 会原样留着），
 * 这里多做一层类型判断（判据 PET-02 钉死）。
 */
function normalize(j: Partial<PetState>): PetState {
  const d = blank();
  const born = typeof j.born === 'number' && j.born > 0 ? j.born : d.born;
  return {
    adopted: j.adopted === true,
    stage: intIn(j.stage, 0, 0, 3),
    ate: numAtLeast(j.ate, 0),
    // 🔴 `days` 不信存档，一律按 `born` 现算（老项目 :11319 v9.3.2 同款：
    //   天数按同步好的 born 现算，多端一致；clamp≥1 防某端时钟超前算出 0/负）。
    days: daysSince(born, Date.now()),
    shelf: normShelf(j.shelf),
    born,
    last: typeof j.last === 'number' ? j.last : 0,
    asleep: j.asleep === true,
    retiredAt: numAtLeast(j.retiredAt, 0),
    talked: numAtLeast(j.talked, 0),
  };
}

/** 有界整数。越界或类型不对一律回退 `dflt`（存档被手改过也不能让面板炸）。 */
function intIn(v: unknown, dflt: number, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  const n = Math.floor(v);
  return n < lo || n > hi ? dflt : n;
}

/** 非负数。`NaN`/`Infinity`/负数/非数一律回退 0。 */
function numAtLeast(v: unknown, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return dflt;
  return v;
}

/**
 * 柜子归一化：滤掉非整数/越界/重复，且**升序**。
 *
 * 🔴 重复项必须去重：`shelf.length` 是面板「柜子 N / 16」与 `petVend` 的
 *   「还剩几格」判据，重复项会让「柜子 17 / 16」这种自相矛盾的数字出现。
 * 🔴 升序：老项目 `petVend` push 后 `sort((a,b)=>a-b)`（:11286），面板按索引取名，
 *   顺序不同 ⇒ 同一柜子显示成另一批收藏品。
 */
function normShelf(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isInteger(x)) continue;
    if (x < 0 || x >= SHELF_SIZE) continue;
    if (out.indexOf(x) < 0) out.push(x);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** 把新状态落盘。 */
export function writePet(s: PetState): void {
  try {
    eggBrowserStore().setItem(PET_KEY, JSON.stringify(s));
  } catch {
    /* 写不进就只在内存里活着，不影响其它功能 */
  }
}

/**
 * 领养（访问 /pet 时调用）。幂等。
 *
 * 🔴🔴 **只补 `adopted`，绝不能重置别的字段**（老项目 :11348 逐字同款：
 *   `PET.adopted = true; PET.asleep = false; PET.last = Date.now()`）。
 *   写成 `writePet(blank())` 的话，二次访问 /pet 会把「已养 300 天、柜子集齐、
 *   胖体」的档案**清零回幼体** —— 这是最难自查的一类数据丢失。
 */
export function adoptPet(): void {
  const s = readPet();
  if (s.adopted) return;
  writePet({ ...s, adopted: true, asleep: false, last: Date.now() });
}

/**
 * 吃 n 个字：累加计数 + 升档（老项目 `petEat`，:11217-11224 逐字）。
 *
 * 🔴🔴 红线：只记**字节计数**，吞掉的原文一个字都不落盘（老项目 :11217 注释
 *   原文「只记字节计数，吞掉的原文一个字都不落盘（红线）」）。
 *
 * @param n 吃掉的字数。非正数按 0 处理（老项目没有这道判据，
 *   但 `Math.min(400, sel.length || 12)` 恒为正；这里补上以免脏调用把计数写负）。
 * @returns 升档后的状态；`stage` 变化时用于触发音效。
 */
export function eatChars(n: number): PetState {
  const s = readPet();
  const ate = s.ate + (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
  // 老项目 :11219 逐字：阈值算出的档位
  const want = stageForAte(ate);
  // 🔴 `>` 不是 `>=`：与老项目一致，**只升不降**（换养成吃字少的档案也不掉档）。
  const stage = want > s.stage ? want : s.stage;
  const next: PetState = { ...s, ate, stage, last: Date.now() };
  writePet(next);
  return next;
}

/**
 * 摆摊：带回一件**没用的小收藏品**（老项目 `petVend`，:11281-11289 逐字）。
 *
 * 老项目：满 16 格返回 -1（`if (PET.shelf.length >= 16) return -1`），
 * 于是「柜子集齐」之后就不再发新件 —— **集齐即封顶**，不是无限发。
 *
 * @param rand 取随机数的函数（注入以便判据钉死）。必须返回 [0,1)。
 * @returns 新柜子与带回的索引；柜子已满返回 -1。
 */
export function vendTrinket(rand: () => number = Math.random): {
  shelf: number[];
  got: number;
} {
  const s = readPet();
  if (s.shelf.length >= SHELF_SIZE) return { shelf: s.shelf, got: -1 };
  const free: number[] = [];
  for (let i = 0; i < SHELF_SIZE; i++) if (s.shelf.indexOf(i) < 0) free.push(i);
  if (!free.length) return { shelf: s.shelf, got: -1 };
  const pick = free[Math.floor(rand() * free.length)];
  // 🔴 越界兜底：rand() 若被污染返回 1，index 会是 undefined ⇒ shelf 里出现
  //   一个不存在的索引，面板 `PET_TRINKET[undefined]` 显示 undefined。
  const got = pick === undefined ? -1 : pick;
  if (got < 0) return { shelf: s.shelf, got: -1 };
  const shelf = s.shelf.concat([got]).sort((a, b) => a - b);
  writePet({ ...s, shelf });
  return { shelf, got };
}

/**
 * 7 天没互动就睡着（老项目 petTick：`since > 7*day`，:11296）。
 *
 * 🔴🔴 **永不死，只睡着**（老项目 :11296 注释原文「永不死，只睡着」）。
 *   所以这里**只写 `asleep: true`**，绝不写任何「死亡」标记 ——
 *   `PetState` 里根本没有 `dead` 字段就是这条不变量的结构保证。
 *   判据 PET-04 钉死：7 天后 `asleep === true` 且**没有**死亡态字段。
 *
 * ⚠️ 另有一条老项目注释里的口径要记牢（:11297 `if (since > 3*day) return;`）：
 *   睡过之后 3 天内不再打扰（不弹偷字/学舌/摆摊事件），**不是**「三天后死」。
 */
function withSleep(s: PetState): PetState {
  if (!s.adopted || s.asleep) return s;
  if (s.last > 0 && Date.now() - s.last > 7 * DAY_MS) {
    const next = { ...s, asleep: true };
    writePet(next);
    return next;
  }
  return s;
}

/** 7 天判据的天数常量。老项目 `since > 7 * day`。 */
export const SLEEP_AFTER_DAYS = 7;

/**
 * 「让它去睡」—— 手动睡。
 *
 * 🔴🔴 **必须同时刷 `last`**（老项目 :11352 注释原文：「睡眠必须刷 last，
 *   否则 petMount 的『3 天内』守卫会把它当场叫回来」）。
 *   只写 `asleep = true` 而不刷 last ⇒ 7 天守卫与 3 天守卫都基于旧 last，
 *   下一次 `withSleep` 立刻又把它判成睡够 7 天，表现为「点了睡又自己醒了」。
 */
export function sleepPet(): PetState {
  const next = { ...readPet(), asleep: true, last: Date.now() };
  writePet(next);
  return next;
}

/**
 * 点它一下 ⇒ 唤醒（老项目 :11212 `PET.asleep = false; PET.last = Date.now()`）。
 *
 * @returns 是否真的做了一次「唤醒」（原本醒着则 false）。
 */
export function wakePet(): boolean {
  const s = readPet();
  if (!s.asleep) return false;
  writePet({ ...s, asleep: false, last: Date.now() });
  return true;
}

/**
 * 「放归」（老项目 :11381-11386 逐字）：**收起并打 `retiredAt`，不删任何数据**。
 *
 * 🔴 面板按钮写的是「放归（档案保留 30 天）」—— 语义是**档案还在**、
 *   30 天内可原样认领回来，所以这里**只打时间戳**。
 *   🔴🔴 绝不能顺手 `shelf = []`：柜子集齐是用户攒出来的，删掉不可恢复。
 */
export function retirePet(): PetState {
  const next = { ...readPet(), asleep: true, retiredAt: Date.now() };
  writePet(next);
  return next;
}

/** 放归后是否还在 30 天保留期内。老项目文案口径：`retiredAt` 之后 30 天。 */
export const RETIRE_KEEP_DAYS = 30;

export function withinRetireWindow(retiredAt: number, now: number): boolean {
  if (retiredAt <= 0) return false;
  return now - retiredAt < RETIRE_KEEP_DAYS * DAY_MS;
}

/**
 * 桌宠 SVG —— **老项目 index.html:11200 逐字**。
 *
 * 🔴🔴 别"顺手改成 emoji 🦀"：用户报障「宠物是一个大脚丫」就是 emoji 字形顶替的产物
 *   （本仓库历史记录在案）。这里是 26×26 viewBox 的描边螃蟹：弧形身体 + 三条腿 +
 *   两只金色实心眼睛。
 */
export const PET_SVG =
  '<svg viewBox="0 0 26 26" aria-hidden="true">' +
  '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
  '<path d="M4 18c0-5 3.6-8.6 8.6-8.6S21 13 21 18"/>' +
  '<path d="M4 18h17"/>' +
  '<path d="M8 18v2.6M13 18v2.6M18 18v2.6"/>' +
  '</g>' +
  '<circle cx="9.6" cy="13.4" r="1.2" fill="var(--accent)" stroke="none"/>' +
  '<circle cx="15.6" cy="13.4" r="1.2" fill="var(--accent)" stroke="none"/>' +
  '</svg>';

/** 走动的三个常量也是老项目的原值，别当参数调。 */
const WALK_STEP = 0.35;
const WALK_EVERY_MS = 60;
const X_MIN = 10;
const X_START = 14;
/** 右边界留 34px：螃蟹 24px 宽 + 10px 余量，撞边时整只仍在头里。 */
const X_RIGHT_GAP = 34;

let timer: number | null = null;

/**
 * 挂桌宠到顶栏（幂等）。
 *
 * @param onNod 用户点它一下时的回调（弹音效/图鉴计数）。
 * @returns 是否真的挂上了（未领养 / 无 header / 已挂 ⇒ false）。
 */
export function mountPet(onNod?: () => void): boolean {
  if (typeof document === 'undefined') return false;
  const header = document.querySelector<HTMLElement>('header.ns-top');
  if (!header) return false;
  const state = withSleep(readPet());
  if (!state.adopted) return false;
  const existing = document.getElementById('nsPet');
  if (existing) return false;

  const el = document.createElement('div');
  el.id = 'nsPet';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = PET_SVG;
  header.appendChild(el);
  if (state.asleep) el.classList.add('asleep');

  let x = X_START;
  let dir = 1;
  timer = window.setInterval(() => {
    if (document.hidden) return;
    x += dir * WALK_STEP;
    const max = header.clientWidth - X_RIGHT_GAP;
    if (x > max) {
      x = max;
      dir = -1;
    }
    if (x < X_MIN) {
      x = X_MIN;
      dir = 1;
    }
    el.style.transform = `translateX(${x}px)` + (state.asleep ? ' translateY(2px)' : '');
  }, WALK_EVERY_MS);

  el.addEventListener('click', () => {
    // 🔴 睡着 ⇒ 只唤醒（老项目 :11212 逐字：唤醒走 `fx('wake')` 分支，
    //   **不** 走 `onNod` 那个 `purr` 分支）。
    if (wakePet()) {
      state.asleep = false;
      el.classList.remove('asleep');
      return;
    }
    // 醒着 ⇒ 只是「摸一下」，刷 last（不算吃字：老项目点螃蟹**不**走 petEat，
    //   吃字只来自正文输入与复制，见 :11304-11311 与 :11225-11332）。
    writePet({ ...readPet(), last: Date.now() });
    onNod?.();
    el.classList.add('talk');
    window.setTimeout(() => el.classList.remove('talk'), 520);
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return true;
}

/** 拆掉桌宠（锁定/退出时用；否则定时器会一直跑）。 */
export function unmountPet(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  document.getElementById('nsPet')?.remove();
}

/* ------------------------------------------------------------------ *
 * 每日随机事件（老项目 petTick，index.html:11290-11303）
 * ------------------------------------------------------------------ */

/** 事件跑的间隔。老项目 `setInterval(petTick, 45000)` —— 45 秒。 */
export const TICK_EVERY_MS = 45_000;

/**
 * 「多久没找它了就不再打扰」的天数。老项目 :11297 `if (since > 3 * 864e5) return;`
 * 注释写的是「睡过就不打扰」。
 *
 * 🔴🔴 这条**不是**「三天后死」。它只是把「7 天 ⇒ 睡着」与「3 天 ⇒ 别popup 事件」
 * 两条守卫叠在一起，净效果是「3 天内没互动就什么都不发生，7 天后睡着，永不死」。
 * 老项目源码字面上很容易读成后者，注释里那句「睡过就不打扰」才是作者意图。
 */
export const QUIET_AFTER_DAYS = 3;

/** 每日事件间隔概率（老项目 :11298-11301 的三个阈值，逐字）。 */
const ROLL_STEAL = 0.22;
const ROLL_ECHO = 0.34;
/** 🔴 `roll < 0.42` 才摆摊 —— 那是**累计**概率，不是「42% 概率摆摊」。 */
const ROLL_VEND = 0.42;

export interface PetTick {
  /** 睡着（含「刚好睡满 7 天」这一拍）。 */
  slept: boolean;
  /** 摆摊带回的索引，-1 = 没带。 */
  got: number;
  /** 柜子是否已集齐（16/16）。用于面板追加「（柜子集齐，形态变了）」。 */
  shelfFull: boolean;
}

/**
 * 跑一拍每日事件（老项目 `petTick`，:11290-11302）。
 *
 * 🔴 顺序**必须照抄**，三道守卫的先后是有意义的：
 *   1. `!adopted || asleep || hidden` ⇒ 直接返回（睡着时不做任何事）
 *   2. 刷 `days = 1 + floor((now - born) / day)`
 *   3. `since > 7 天` ⇒ **睡着并 return**（这一拍不再跑事件）
 *   4. `since > 3 天` ⇒ return（3 天内没互动，不打扰）
 *   5. 掷骰：<0.22 偷字 / <0.34 学舌 / <0.42 摆摊
 *
 * 把 3 与 4 的顺序对调，行为几乎一样但「7 天那一次」会同时掷骰；
 * 老项目是 return 掉的，这里照抄。
 *
 * @param rand 注入随机数（判据要能钉死边界）。默认 `Math.random`。
 * @param hasEcho 本机是否还记得剪贴板短句（老项目 `petEcho.length`）。
 *   bj 未移植学舌/偷字两道（依赖 Range 盖字与正文 DOM 手术，触碰编辑器红线），
 *   但**掷骰顺序保留**，这样 0.34 那档恒不成立、0.42 的摆摊概率与老项目一致。
 */
export function petTick(rand: () => number = Math.random, hasEcho = false): PetTick {
  const s = readPet();
  const none: PetTick = { slept: false, got: -1, shelfFull: s.shelf.length >= SHELF_SIZE };
  if (!s.adopted || s.asleep) return none;
  const now = Date.now();
  const since = now - s.last;
  if (s.born) writePet({ ...s, days: daysSince(s.born, now) });
  if (since > SLEEP_AFTER_DAYS * DAY_MS) {
    // 永不死，只睡着（老项目 :11296 注释原文）
    writePet({ ...s, asleep: true, days: daysSince(s.born, now) });
    return { slept: true, got: -1, shelfFull: s.shelf.length >= SHELF_SIZE };
  }
  if (since > QUIET_AFTER_DAYS * DAY_MS) return none;
  const roll = rand();
  // 🔴🔴🔴 下面三档是**老项目 :11299-11301 的 else-if 链**，不是三段互斥的区间。
  //   这两者差别很大，是本轮最容易照抄错的一处：
  //
  //     if (roll < 0.22) petSteal();
  //     else if (roll < 0.34 && petEcho.length) petBubble(...);
  //     else if (roll < 0.42) { petVend() }
  //
  //   🔴 老项目**没有**「学舌档 0.22~0.34」这个概念。那一段的判据是
  //   `roll < 0.34 && petEcho.length` —— `petEcho` 为空（从没用过复制）
  //   时这一支**为假**，于是 0.22~0.34 那一段**继续往下落到摆摊支**。
  //   ⇒ 没复制过时，摆摊的真实概率是 0.22~0.42 = **20%**；
  //     复制过（petEcho 非空）时才是 0.34~0.42 = 8%。
  //   写成"0.22~0.34 是学舌档、不摆摊"就把 8% 悄悄变成 8%（看着对），
  //   但在"没复制过"的老用户身上会**少发一半的 trinket** ——
  //   而这类差异不报错、不崩溃，只是柜子永远集不齐。
  //   判据 PET-10 把两个口径都钉死。
  if (roll < ROLL_STEAL) {
    // 偷字（0~0.22）：老项目用 Range 量一个字的位置再盖一块贴片、3 秒吐回，
    // 属于「碰正文 DOM」—— bj 是 Lexical，操作它会毁选区/撤销/块结构
    // （红线 1/4/5/11）。本轮不移植，但**保留这一档的空档**，
    //   否则摆摊概率会从 20%/8% 涨到 100%。
    return none;
  }
  // 学舌（0.22~0.34，且 petEcho 非空）：老项目 `else if (roll < 0.34 && petEcho.length)`。
  // bj 未移植学舌（学舌要把剪贴板文本留在内存，属红线区），所以这一支恒为假，
  // 于是按老项目语义**自然落穿**到下面的摆摊支。
  if (hasEcho && roll < ROLL_ECHO) return none;
  if (roll < ROLL_VEND) {
    const v = vendTrinket(rand);
    return { slept: false, got: v.got, shelfFull: v.shelf.length >= SHELF_SIZE };
  }
  return none;
}

/** 起每日事件的定时器（老项目 :11303）。返回句柄，交给 {@link unmountPet} 之外的生命周期管。 */
export function startPetTick(onVend?: (got: number, shelfFull: boolean) => void): number {
  const h = window.setInterval(() => {
    try {
      const t = petTick();
      if (t.got >= 0) onVend?.(t.got, t.shelfFull);
    } catch {
      /* 事件失败绝不能把定时器带崩 */
    }
  }, TICK_EVERY_MS);
  return h;
}

/* ------------------------------------------------------------------ *
 * 面板文案（老项目 index.html:11326 逐字）
 * ------------------------------------------------------------------ */

/**
 * 档案行：`吃了 N 字 · 醒着 N 天 · 柜子 N / 16`。
 *
 * 🔴 千分位是 `toLocaleString('en-US')`（老项目 :11326 逐字）——
 *   用默认 locale 在部分环境会出「9,001」以外的分组（如 `9 001`），与老项目不一致。
 */
export function petArchiveLine(s: PetState): string {
  const ate = s.ate.toLocaleString('en-US');
  return `吃了 ${ate} 字 · 醒着 ${s.days} 天 · 柜子 ${s.shelf.length} / ${SHELF_SIZE}`;
}

/* ------------------------------------------------------------------ *
 * 换养用的档案串（本机自包含，不过网）
 * ------------------------------------------------------------------ */

/** 档案串前缀。`ns2` = 本项目自有的形状（老项目云端护照是 `ns1:`，走服务端 arcade）。 */
const ARC_PREFIX = 'ns2:';

/**
 * 剥掉零宽字符与 BOM。
 *
 * 🔴 linkify 给长词断行时会在串里插 U+200B，用户从笔记里复制出来就带着它 ——
 *   老项目 v9.3.1 为此专门加了一行剥离（:11473 注释：粘进笔记保存后
 *   「再从笔记复制来换养/认领就永远『格式不对』」）。
 *   同款事故在这里也必须挡一次，否则用户明明粘对了却一直报格式不对，
 *   错误信息离真正的原因十万八千里。
 */
function stripInvisible(s: string): string {
  return s.replace(/[﻿]/g, '');
}

/**
 * 导出档案串（粘给另一台设备换养）。
 *
 * 🔴🔴 只含**计数与形态**（stage/ate/days/born/talked/shelf），
 *   **绝不含任何笔记原文**（老项目 :11329 面板说明原文「档案只存计数与形态，
 *   不含任何笔记原文」）。这里更严格：连 `last` 都不导（那是本机交互节奏）。
 */
export function petArchiveCode(s: PetState): string {
  const shelf = s.shelf.length ? `;shelf=${s.shelf.join(',')}` : '';
  return `${ARC_PREFIX}stage=${s.stage};ate=${s.ate};days=${s.days};born=${s.born};talked=${s.talked}${shelf}`;
}

/** 档案串解析失败的原因。 */
export type PetCodeError = 'empty' | 'format' | 'shape';

/**
 * 解析档案串。
 *
 * 🔴 逐项校验而不是一把梭：解析结果要**直接落盘并驱动面板数字**，
 *   一个 `stage=99` 就能让形态名显示成 `undefined`。
 */
export function parsePetArchiveCode(raw: string): { state?: PetState; err?: PetCodeError } {
  const txt = stripInvisible(String(raw ?? '')).trim();
  if (!txt) return { err: 'empty' };
  if (txt.indexOf(ARC_PREFIX) !== 0) return { err: 'format' };
  const kv: Record<string, string> = {};
  for (const seg of txt.slice(ARC_PREFIX.length).split(';')) {
    const i = seg.indexOf('=');
    if (i <= 0) continue;
    kv[seg.slice(0, i)] = seg.slice(i + 1);
  }
  const stage = Number(kv['stage']);
  const ate = Number(kv['ate']);
  const born = Number(kv['born']);
  if (!Number.isInteger(stage) || stage < 0 || stage > 3) return { err: 'shape' };
  if (!Number.isFinite(ate) || ate < 0) return { err: 'shape' };
  if (!Number.isFinite(born) || born <= 0) return { err: 'shape' };
  const shelf = normShelf(
    (kv['shelf'] ?? '')
      .split(',')
      .filter((x) => x !== '')
      .map(Number),
  );
  const talked = Number(kv['talked']);
  const now = Date.now();
  return {
    state: normalize({
      adopted: true,
      stage,
      ate,
      born,
      shelf,
      talked: Number.isFinite(talked) && talked >= 0 ? talked : 0,
      // 换养来的是一只**醒着**的宠物（老项目 :11496
      // `if (!PET.asleep) PET.last = Date.now()` 同款口径）。
      asleep: false,
      last: now,
      retiredAt: 0,
    }),
  };
}

/**
 * 换养：拿另一只宠物的档案串接管本机档案（老项目 :11369-11379「换养这只」）。
 *
 * 🔴 语义是「换一只养」而不是「两只并养」：落盘后本机原来那只的档案被**接管**。
 *
 * @returns 成功返回新档案；失败返回 `{ err }`，调用方据此显示老项目那句反馈。
 */
export function adoptArchiveCode(raw: string): { state?: PetState; err?: PetCodeError } {
  const r = parsePetArchiveCode(raw);
  if (!r.state) return r;
  writePet(r.state);
  return r;
}


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
  /** 睡着（点它唤醒）。老项目：7 天不碰就睡，永不死。 */
  asleep: boolean;
  /** 最近一次互动时间戳（ms）。 */
  last: number;
}

const DAY_MS = 86_400_000;

function blank(): PetState {
  return { adopted: false, asleep: false, last: 0 };
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
    return {
      adopted: j.adopted === true,
      asleep: j.asleep === true,
      last: typeof j.last === 'number' ? j.last : 0,
    };
  } catch {
    return blank();
  }
}

function writePet(s: PetState): void {
  try {
    eggBrowserStore().setItem(PET_KEY, JSON.stringify(s));
  } catch {
    /* 写不进就只在内存里活着，不影响其它功能 */
  }
}

/** 领养（访问 /pet 时调用）。幂等。 */
export function adoptPet(): void {
  const s = readPet();
  if (s.adopted) return;
  writePet({ adopted: true, asleep: false, last: Date.now() });
}

/** 7 天没互动就睡着（老项目 petTick：`since > 7*day`）。永不死，只睡着。 */
function withSleep(s: PetState): PetState {
  if (!s.adopted || s.asleep) return s;
  if (s.last > 0 && Date.now() - s.last > 7 * DAY_MS) {
    const next = { ...s, asleep: true };
    writePet(next);
    return next;
  }
  return s;
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
    const s = readPet();
    if (s.asleep) {
      const next = { ...s, asleep: false, last: Date.now() };
      writePet(next);
      state.asleep = false;
      el.classList.remove('asleep');
      return;
    }
    writePet({ ...s, last: Date.now() });
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

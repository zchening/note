/**
 * 关于页标题的**连点状态机**（老项目 `index.html:8204-8215`）
 *
 * 🔴 为什么要单独一个文件：`update/ota-ui.ts` 只该为「标题被点了 4 次」问一声，
 *   不该因此 import 整个诊断面板（模态 DOM + 250ms 浮层 + 复制降级链）。
 *   把状态机放这里，两个消费方（ota-ui 的标题、任何未来入口）都只依赖这 30 行。
 *
 * 🔴🔴 口径必须是**滑动窗口**而不是固定窗口：
 *   老项目那段是 `clearTimeout` + `setTimeout(…, 800)`，即
 *   「**最后一次**点击后 800ms 内不再点就清零」。
 *   两种口径在"匀速连点"下结果相同，在「快 3 次 → 停 1s → 再点 1 次」下不同：
 *     滑动窗口 = 清零后重新数 ⇒ **不触发**
 *     固定窗口 = 第 1 次点击起算 800ms ⇒ 触发
 *   照抄老项目就必须实现滑动窗口；而这也只有在**能注入计时器**时才测得到
 *   （否则判据得在真浏览器里等 1 秒），所以 `sched` 是必填依赖。
 */

/** 连点阈值与窗口（老项目 :8204-8215 逐值）。 */
export const ABOUT_TAP_TIMES = 4;
export const ABOUT_TAP_MS = 800;

/** 计时器注入。生产传 {@link REAL_SCHED}，判据传假时钟。 */
export interface TapSched {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
}

/** 真计时器。抽成常量只为让生产与判据共用同一个默认。 */
export const REAL_SCHED: TapSched = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clear: (id) => globalThis.clearTimeout(id),
};

/** 跨点击的计数态。**由调用方持有**（每次打开关于页可以新建一份）。 */
export interface Tapper {
  taps: number;
  timer: number | null;
}

export function createAboutTapper(): Tapper {
  return { taps: 0, timer: null };
}

/**
 * 记一次点击，返回是否该触发诊断模态。
 *
 * 🔴 命中后必须**清零并撤表**：不清的话第 5 次点击会在 800ms 内立刻再触发一次，
 *   而老项目用户会连点第 5、6 次找"这彩蛋是不是坏了"。
 */
export function aboutTapHit(state: Tapper, sched: TapSched): boolean {
  if (state.timer !== null) sched.clear(state.timer);
  state.taps += 1;
  state.timer = sched.set(() => {
    state.taps = 0;
    state.timer = null;
  }, ABOUT_TAP_MS);
  if (state.taps < ABOUT_TAP_TIMES) return false;
  state.taps = 0;
  if (state.timer !== null) {
    sched.clear(state.timer);
    state.timer = null;
  }
  return true;
}
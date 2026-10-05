/**
 * 彩蛋游戏外壳 —— HUD + 画面 + 结束卡，十个游戏共用（老项目 nsGameShell 同款）
 *
 * 🔴🔴 四条架构纪律（都是老项目真机踩出来的）：
 *   1. **色值一律从 `cssVar()` 读，绝不硬编码**。老项目 v9.2.0 的根因修复：
 *      旧版从 `documentElement` 读自定义属性，而夜间色板声明在 `body.dark` 上。
 *           自定义属性只向下继承、绝不上浮——html 永远看不见 body 那份覆盖，
 *           于是八个 canvas 蛋无论日夜一律拿到日间色板：
 *      夜间把「日间的近黑前景」画在「夜间的近黑底」上，几乎隐形。
 *      用户报"很多游戏夜间没优化、看不清"，根因是**做的从来没生效**。
 *      这里**直接读 body**，并且每次读都重新 getPropertyValue（主题会切）。
 *   2. **`dt` 上限 0.05s**。切后台再回来时浏览器一次性给出巨大的 dt，
 *      不夹住会让角色一帧穿过整屏（用户看到的是"闪了一下就死了"）。
 *   3. **keydown 与 keyup 都要绑**。缺 keyup 等于"按下的键永远抬不起来"。
 *   4. **rAF 循环必须能彻底停干净**（close 时 caf + 解绑 resize + 解绑 key），
 *      否则退出游戏后 CPU 仍 100%，且下一次进游戏会有两个循环同时跑。
 *
 * 🎮 游戏接口（每个游戏导出一个对象）：
 *   id/tip/reset/start/frame(dt)/draw/… 详见 GameDef。
 */

import { COPY } from '../ui/copy.ts';

export interface GameCtx {
  /** CSS 变量当前值（已 trim）。取不到返回 ''，调用方需有兜底。 */
  css: (name: string) => string;
  /** 画布逻辑尺寸（CSS 像素，已按 stage 算好）。 */
  w: () => number;
  h: () => number;
  /** 上报分数（写 HUD）。 */
  setScore: (n: number | string) => void;
  /** 上报关卡/提示（写 HUD 中间那格；传空串清空）。 */
  setLevel: (s: string) => void;
  /** 结束并弹结算卡。rows 是 [标签, 值] 对。 */
  end: (title: string, rows: Array<[string, string]>) => void;
  /** 音效。 */
  fx: (name: FxName) => void;
}

export type FxName = 'tap' | 'start' | 'eat' | 'die' | 'coin' | 'shot' | 'thrust' | 'brk' | 'burp' | 'up' | 'enter';

export interface GameDef {
  id: string;
  tip: string;
  /**
   * 开局/重开。
   *
   * 🔴 必填（不写成可选）是刻意的：早期版本把 start/draw 设成可选，
   *   结果"某个游戏忘写 draw"编译器放行，运行时表现为**进游戏一片空白且零报错**。
   *   不建canvas 的 dom 型游戏走 `DomGameDef`（见下），它在类型上就没有这两个字段。
   */
  start: (g: GameCtx) => void;
  /** 每帧绘制（paused 时也调 —— 暂停画面要留在屏上）。 */
  draw: (g: GameCtx) => void;
  /** 每帧推进（秒）。paused / over 时不调。 */
  frame?: (dt: number, g: GameCtx) => void;
  /** 画布尺寸变化（旋转屏后必须重算，否则绘制与命中错位）。 */
  resize?: (w: number, h: number, g: GameCtx) => void;
  /* ---- 输入（可选；坐标已是画布内CSS 像素） ---- */
  down?: (x: number, y: number, g: GameCtx) => void;
  move?: (x: number, y: number, g: GameCtx) => void;
  up?: (x: number, y: number, g: GameCtx) => void;
  /** 抬手时判定为「划动」。dir是 'U'|'D'|'L'|'R'。 */
  swipe?: (dir: 'U' | 'D' | 'L' | 'R', g: GameCtx) => void;
  /** 抬手时判定为「点一下」。 */
  tap?: (g: GameCtx) => void;
  /** 键盘长按类游戏（spacex/tesla）用。 */
  key?: (down: boolean, e: KeyboardEvent, g: GameCtx) => void;
}

/**
 * 非canvas 型彩蛋（镜像/ 桌宠）—— 自带画面，不建 canvas 外壳。
 *
 * 🔴 为什么单独一个类型而不是给 GameDef 加个可选 `dom`：
 *   那样"canvas 型游戏误写了 dom"就变成合法代码，运行时表现为
 *   **没有 canvas、也没有画面，白屏且零报错**。分成两个类型后，
 *   这个错误在 TypeScript 里就红。
 */
export interface DomGameDef {
  id: string;
  tip: string;
  dom: (mount: HTMLElement, g: GameCtx) => void;
}

/** 两种游戏定义的联合。 */
export type AnyGame = GameDef | DomGameDef;

/** 是不是 dom 型（判据是 dom 字段在不在，不靠 id 白名单）。 */
export function isDomGame(d: AnyGame): d is DomGameDef {
  return typeof (d as DomGameDef).dom === 'function';
}

export interface ShellHooks {
  /**
   * 游戏外壳**彻底拆掉之后**回调一次（无论从退出键、返回键还是再来一局）。
   *
   * 🔴 为什么必须有：门牌路径（/snake）进游戏时，路由层只调了 `goto('egg')`，
   *   落地页从未被渲染过。用户退出游戏后 body 里什么都不剩 ——
   *   症状是"点退出后一片空白，按什么都回不来，只能刷新"。
   *   只有外壳自己知道"我什么时候真的拆干净了"，所以回调挂在这里。
   */
  onClosed?: () => void;
}

export interface Shell {
  launch: (def: AnyGame) => void;
  close: (fromPop: boolean) => void;
  pause: (on: boolean) => void;
  isOpen: () => boolean;
  isPaused: () => boolean;
  /** 供音效引擎与彩蛋层读当前局。 */
  current: () => AnyGame | null;
}

const X_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>';

const SOUND_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M4 9.5v5h3.2L12 18.6V5.4L7.2 9.5H4Z"/>' +
  '<path d="M16 9.4a3.6 3.6 0 0 1 0 5.2M18.4 7a7 7 0 0 1 0 10"/></svg>';

function mk(tag: string, cls?: string, html?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export function buildShell(
  sound: { muted: () => boolean; toggle: () => void; fx: (n: FxName) => void },
  hooks: ShellHooks = {},
): Shell {
  let cur: AnyGame | null = null;
  let raf = 0;
  let last = 0;
  let paused = false;
  let over = false;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let root: HTMLElement | undefined;
  let cv: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | null = null;
  let stage: HTMLElement | undefined;
  let prevPath: string | undefined;
  let pushed = false;

  /**
   * 读 CSS 变量 —— **必须读 body**（见文件头纪律 1）。
   * 每次都重新 getPropertyValue，因为主题会切；
   * getComputedStyle 返回 live 对象，不必每次重新取元素。
   */
  const cssVar = (name: string): string => {
    const el = document.body || document.documentElement;
    const v = getComputedStyle(el).getPropertyValue(name);
    return v ? v.trim() : '';
  };

  const g: GameCtx = {
    css: cssVar,
    w: () => W,
    h: () => H,
    setScore: (n) => {
      const e = root?.querySelector('.ns-sc');
      if (e) e.textContent = String(n);
    },
    setLevel: (s) => {
      const e = root?.querySelector('.ns-lv');
      if (e) e.textContent = s || '';
    },
    end: (title, rows) => showEnd(title, rows),
    fx: (n) => sound.fx(n),
  };

  const fit = (): void => {
    if (!stage || !cv) return;
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const r = stage.getBoundingClientRect();
    // 🔴 兜底下限：stage 还没布局时 getBoundingClientRect 全是 0，
    //   而 W=0 会让所有除法算出 Infinity/NaN，draw 里整屏空白且零报错。
    W = Math.max(200, Math.round(r.width));
    H = Math.max(160, Math.round(r.height));
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (cur && !isDomGame(cur)) cur.resize?.(W, H, g);
  };

  const onResize = (): void => fit();

  const keyHandler = (e: KeyboardEvent): void => {
    if (!cur) return;
    if (e.key === 'Escape') {
      close(false);
      return;
    }
    if (e.key === 'p' || e.key === 'P') {
      paused = !paused;
      g.setLevel(paused ? COPY.gamePaused : '');
      return;
    }
    if (!isDomGame(cur)) cur.key?.(e.type === 'keydown', e, g);
  };

  function buildShellDom(def: GameDef): void {
    // 🔴 这里的断言是**冗余的防御**（GameDef 里 start/draw 已必填），
    //   留着是因为 JS 调用方（未来接MCP / 动态注册）绕得过类型系统。
    //   症状参考：漏 draw ⇒ 进游戏一片空白且零报错。
    if (typeof def.start !== 'function' || typeof def.draw !== 'function') {
      throw new Error(`彩蛋 ${def.id} 缺 start/draw（canvas 型必须实现）`);
    }
    root = mk('div', 'ns-game');
    root.id = 'nsGame';
    const hud = mk('div', 'ns-hud');
    const x = mk('span', 'ns-x', X_SVG + `<b>${COPY.gameExit}</b>`);
    // 🔴 退出按钮必须显式传 false：直接把 close 当监听器会把 Event 对象
    //   当 fromPop（truthy），UI 退出恒走「不动历史」分支 —— 于是返回键留在游戏页。
    x.addEventListener('click', () => close(false));
    hud.appendChild(x);
    hud.appendChild(mk('span', 'ns-gate', '/' + def.id));
    hud.appendChild(mk('span', 'ns-lv'));
    hud.appendChild(mk('span', 'ns-sp'));
    hud.appendChild(mk('span', 'ns-sc', '0'));
    const mute = mk('span', 'ns-mute' + (sound.muted() ? ' off' : ''), SOUND_SVG);
    mute.setAttribute('role', 'button');
    mute.setAttribute('tabindex', '0');
    const tog = (e: Event): void => {
      e.stopPropagation();
      sound.toggle();
      mute.classList.toggle('off', sound.muted());
    };
    mute.addEventListener('click', tog);
    mute.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') tog(e);
    });
    hud.appendChild(mute);
    root.appendChild(hud);

    stage = mk('div', 'ns-stage');
    cv = document.createElement('canvas');
    cv.id = 'nsCv';
    stage.appendChild(cv);
    root.appendChild(stage);
    root.appendChild(mk('div', 'ns-tip', def.tip || ''));

    const card = mk('div', 'ns-over hidden');
    const inner = mk('div', 'ns-card');
    inner.appendChild(mk('h2'));
    inner.appendChild(mk('div', 'ns-rows'));
    const btns = mk('div', 'ns-btns');
    const back = document.createElement('button');
    back.className = 'ns-back';
    back.textContent = COPY.gameBack;
    back.addEventListener('click', () => close(false));
    const again = document.createElement('button');
    again.className = 'ns-again';
    again.textContent = COPY.gameAgain;
    again.addEventListener('click', () => {
      sound.fx('tap');
      restart();
    });
    btns.appendChild(back);
    btns.appendChild(again);
    inner.appendChild(btns);
    card.appendChild(inner);
    root.appendChild(card);

    document.body.appendChild(root);
    ctx = cv.getContext('2d');
    bindInput(cv, def);
    fit();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    document.addEventListener('keydown', keyHandler);
    document.addEventListener('keyup', keyHandler);
  }

  /**
   * 输入绑定。
   *
   * 🔴 触屏四命门（老项目总结，缺一条就"手机上手感不对"）：
   *   划动阈值 18px、**抬手才生效**、一次划动只改一次向（不吃连击）、
   *   tap 需 400ms 内且未移动过。
   *   抬手才生效是因为按下就改向时，手指落点附近的连续微抖会被吃成多次转向。
   */
  function bindInput(canvas: HTMLCanvasElement, def: GameDef): void {
    let sx = 0;
    let sy = 0;
    let tracking = false;
    let moved = false;
    let t0 = 0;
    const pos = (e: PointerEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (!sound.muted()) sound.fx('enter');
        tracking = true;
        moved = false;
        const p = pos(e);
        sx = p.x;
        sy = p.y;
        t0 = Date.now();
        def.down?.(p.x, p.y, g);
        // 🔴 必须 preventDefault：否则会滚页面/触发文本选择，
        //   屏幕上表现为"游戏往上窜了一截"。
        e.preventDefault();
      },
      { passive: false },
    );
    canvas.addEventListener(
      'pointermove',
      (e) => {
        const p = pos(e);
        if (tracking && (Math.abs(p.x - sx) > 8 || Math.abs(p.y - sy) > 8)) moved = true;
        def.move?.(p.x, p.y, g);
      },
      { passive: true },
    );
    const up = (e: PointerEvent): void => {
      if (!tracking) return;
      tracking = false;
      const p = pos(e);
      const dx = p.x - sx;
      const dy = p.y - sy;
      if (Math.abs(dx) >= 18 || Math.abs(dy) >= 18) {
        def.swipe?.(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : dy > 0 ? 'D' : 'U', g);
      } else if (!moved && Date.now() - t0 < 400) {
        def.tap?.(g);
      }
      def.up?.(p.x, p.y, g);
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  function showEnd(title: string, rows: Array<[string, string]>): void {
    over = true;
    const card = root?.querySelector<HTMLElement>('.ns-over');
    const inner = card?.querySelector<HTMLElement>('.ns-card');
    if (!card || !inner) return;
    const h2 = inner.querySelector('h2');
    if (h2) h2.textContent = title;
    const box = inner.querySelector<HTMLElement>('.ns-rows');
    if (box) {
      box.textContent = '';
      for (const r of rows) {
        const d = document.createElement('div');
        const s = document.createElement('span');
        s.textContent = r[0];
        const b = document.createElement('b');
        b.textContent = r[1];
        d.appendChild(s);
        d.appendChild(b);
        box.appendChild(d);
      }
    }
    card.classList.remove('hidden');
  }

  function hideEnd(): void {
    const card = root?.querySelector<HTMLElement>('.ns-over');
    card?.classList.add('hidden');
    over = false;
  }

  function restart(): void {
    if (!cur || isDomGame(cur)) return;
    hideEnd();
    //🔴 与 launch 同口径清 paused：结束卡期间切过后台的话，
    //   不清就是「点了再来一局仍定格」——用户会以为按钮坏了。
    paused = false;
    g.setLevel('');
    cur.start(g);
    last = 0;
  }

  function loop(ts: number): void {
    raf = requestAnimationFrame(loop);
    if (!cur || isDomGame(cur)) return;
    if (!last) last = ts;
    // 🔴 dt 必须夹上限：切后台再回来时浏览器一次性给出巨大 dt，
    //   不夹的话角色一帧穿过整屏 —— 症状是"闪一下就死了"。
    let dt = (ts - last) / 1000;
    last = ts;
    if (dt > 0.05) dt = 0.05;
    if (dt < 0) dt = 0;
    if (!paused && !over) {
      try {
        cur.frame?.(dt, g);
      } catch {
        // 🔴 单帧异常不能让整个 rAF 停摆（否则游戏冻在画面上、零报错）
      }
    }
    try {
      cur.draw(g);
    } catch {
      // 同上：draw 抛了也继续跑
    }
  }

  function launch(def: AnyGame): void {
    close(false);
    cur = def;
    paused = false;
    over = false;
    // 🔴 记住进入前的路径，退出时还原。
    //   用 pushState 而非 replaceState：这样系统返回手势会先"退出游戏"
    //   而不是直接离开笔记 —— 游戏里按返回键期望的是回笔记，不是回落地页。
    if (prevPath === undefined) {
      prevPath = location.pathname;
      try {
        history.pushState({ nsGame: true }, '', location.href);
        pushed = true;
      } catch {
        // 极端环境（file://）下没有 history 也能玩，只是返回键行为不同
      }
    }
    if (isDomGame(def)) {
      // 🔴🔴 dom 型（镜像/桌宠）**也要建 HUD**。
      //   原来的写法只挂一个空 mount 就走人，于是手机用户进得去出不来 ——
      //   退出键在 HUD 里，而这个分支没有 HUD；键盘 Esc 在桌面上能收，
      //   真机 touch 端没有 Esc。症状是"桌宠一开就关不掉，只能杀进程重开"。
      //   一并把 tip 也挂上，老项目两个 dom 型都有提示语。
      root = mk('div', 'ns-game ns-dom');
      root.id = 'nsGame';
      const dhud = mk('div', 'ns-hud');
      const dx = mk('span', 'ns-x', X_SVG + `<b>${COPY.gameExit}</b>`);
      // 与 canvas 型同款陷阱：不能直接把 close 当监听器（Event 会被当 fromPop）
      dx.addEventListener('click', () => close(false));
      dhud.appendChild(dx);
      dhud.appendChild(mk('span', 'ns-gate', '/' + def.id));
      root.appendChild(dhud);

      const mount = mk('div', 'ns-dom-stage');
      // 🔴 dom 型实现会给自己 `mount.className = 'ns-pet-stage'`（老项目口径）。
      //   所以 ns-dom-stage 是**父容器**，画面挂在里面的子div ——
      //   别指望 mount 自己留着 ns-dom-stage，会被实现覆盖掉。
      root.appendChild(mount);
      document.body.appendChild(root);
      def.dom(mount, g);
      if (def.tip) root.appendChild(mk('div', 'ns-tip', def.tip));
      // 🔴 仍要绑 keydown：不然这类型蛋**按 Esc 收不掉**（老项目真机实测）
      document.addEventListener('keydown', keyHandler, true);
      return;
    }
    buildShellDom(def);
    def.start(g);
    last = 0;
    raf = requestAnimationFrame(loop);
    sound.fx('start');
  }

  function close(fromPop: boolean): void {
    // 🔴 只有**真的开着一局**才算"退出一局"。launch() 内部会先调 close(false)
    //   清理上一局，若不判这一下，onClosed 会在换局时误触发 ——
    //   症状是"从图鉴点第二个彩蛋，图鉴刚关掉落地页就闪出来了"。
    const wasOpen = cur !== null;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    // 冒泡阶段的监听器与 keyHandler 是同一个函数引用，remove 一次即可
    document.removeEventListener('keydown', keyHandler);
    document.removeEventListener('keyup', keyHandler);
    document.removeEventListener('keydown', keyHandler, true);
    root?.remove();
    root = undefined;
    cv = undefined;
    ctx = null;
    stage = undefined;
    cur = null;
    over = false;
    paused = false;
    last = 0;
    // 还原路径：
    //  - fromPop（浏览器返回触发的 popstate）→ 不要再动历史，否则**再退一次**
    //  - 否则 push 过就 back，没 push 过就 replace 回去
    if (!fromPop && prevPath != null && location.pathname !== prevPath) {
      if (pushed) {
        try {
          history.back();
        } catch {
          /* ignore */
        }
      } else {
        try {
          history.replaceState({}, '', prevPath);
        } catch {
          /* ignore */
        }
      }
    } else if (fromPop && prevPath != null && location.pathname !== prevPath) {
      try {
        history.replaceState({}, '', prevPath);
      } catch {
        /* ignore */
      }
    }
    pushed = false;
    prevPath = undefined;
    // 🔴 必须**在历史还原之后**才回调：否则回调里读 location.pathname
    //   拿到的还是游戏页路径，重画落地页的判断会基于错的路径。
    if (wasOpen) hooks.onClosed?.();
  }

  return {
    launch,
    close,
    isOpen: () => cur !== null,
    isPaused: () => paused,
    current: () => cur,
    pause: (on) => {
      paused = on;
      g.setLevel(on ? COPY.gamePaused : '');
    },
  };
}

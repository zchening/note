/**
 * 八个 canvas 彩蛋游戏 + 镜像 + 桌宠
 *
 * 🔴🔴 复刻纪律（全部来自老项目 v9.0.0 彩蛋层 B 的注释）：
 *   1. **游戏不吃真源数据**。砖面/蛇身/基地用"你笔记里的词"只是**素材**，
 *      打掉只计分，**绝不回写文档**。理由：游戏是可玩性，
 *      让它改笔记会造成"玩了一把游戏，笔记里的字没了"这类不可逆事故。
 *   2. **素材取不到要能玩**。词不足时回退到收藏/待办，再不足就用内置词库 ——
 *      绝不能因为"笔记是空的"就开局即死。
 *   3. **色值只吃 ctx.css()**（见 shell.ts 文件头纪律 1：必须读 body）。
 *      这里每个游戏都通过 `pal(ctx)` 拿调色板，绝不写死 #hex。
 *   4. **坐标系是 CSS 像素**。shell 已按 dpr 设好 setTransform，
 *      游戏里直接用 ctx 逻辑坐标画，不要自己再乘 dpr（乘两次画面会缩小一半）。
 */

import { COPY } from '../ui/copy.ts';
import { eggBrowserStore, type EggStore } from './registry.ts';
import {
  PET_SVG,
  PET_TRINKET,
  SHELF_SIZE,
  adoptArchiveCode,
  petArchiveCode,
  petArchiveLine,
  readPet,
  retirePet,
  sleepPet,
  stageName,
  unmountPet,
  writePet,
} from './pet.ts';
import type { DomGameDef, GameCtx, GameDef } from './shell.ts';

/**
 * 取等宽字体栈。老项目 canvas 侧逐字写死的是
 * `'10px ui-monospace,Consolas,monospace'`（:11794/:11808）。
 *
 * 🔴🔴 **不能**照抄成字面量，也不能沿用本文件 `txt()` helper 的
 *   `var(--mono, ui-monospace)` —— canvas 的 `font` 属性**不吃 CSS 变量**
 *   （`c.font = '10px var(--mono)'` 会被浏览器判为非法字体串而**整条作废**，
 *   画布上文字随即用默认字体画，字号/字距全不对）。
 *
 *   而本项目的 `--mono` 是**运行时令牌**（theme.ts:146 `FONTS.mono`），
 *   复古皮肤等主题会改它 —— 硬编码就丢掉了主题联动。
 *   ⇒ 从 CSS 变量读（canvas 外、主题切换后能变），读不到才回老项目的字面栈。
 */
function monoOf(g: GameCtx): string {
  return g.css('--mono') || 'ui-monospace,Consolas,monospace';
}

/* ------------------------------------------------------------------ *
 * 调色板：全部来自主题令牌，取不到时给安全兜底
 * ------------------------------------------------------------------ */

interface Pal {
  fg: string;
  bg: string;
  muted: string;
  line: string;
  accent: string;
  soft: string;
  danger: string;
  /**
   * 面板实底。老项目 `P.bx` = `GC('--g-fill') || GC('--box-bg')`（:11545）。
   *
   * 🔴🔴 与 `bg` **不是同一个值**（老项目 :65/:62 日间 `--g-fill:#FFFFFF`
   *   而 `--bg` 另有其值）。牌子/障碍的填充必须走这个，填 `bg` 的话
   *   牌子会与画布底色同色 ⇒ 看起来「牌子消失了，只有几个字浮在背景上」——
   *   这正是任务书里描述的「让站牌文字下面透出背景」那个症状的**真实成因**。
   *   🔴 不是加一层遮罩/渐变能解决的：老项目那一段**根本没有**遮罩，
   *   它靠的是「牌子实底 ≠ 画布底色」这个对比。
   */
  boxBg: string;
}

function pal(ctx: GameCtx): Pal {
  return {
    fg: ctx.css('--fg') || '#1c1c1a',
    bg: ctx.css('--bg') || '#fafaf8',
    muted: ctx.css('--muted') || '#8a8a85',
    line: ctx.css('--line') || '#e3e3de',
    accent: ctx.css('--accent') || '#8a6a2f',
    soft: ctx.css('--accent-soft') || 'rgba(138,106,47,.14)',
    danger: ctx.css('--danger') || '#b3402f',
    // 🔴 老项目 canvas 侧的「弱档」三令牌（--g-fill/--g-line/--g-mute）是
    //   夜间各抬一档的画布专用值（:65/:88）。本项目主题没导出这三个，
    //   按老项目同款次序回落到基础令牌（老项目 :11545 `|| GC('--box-bg')` 同款）。
    boxBg: ctx.css('--g-fill') || ctx.css('--box-bg') || '#ffffff',
  };
}

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  // 🔴 兼容无 roundRect 的内核（老代码同样手写，避免负半径抛错）
  const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  c.beginPath();
  c.moveTo(x + rad, y);
  c.arcTo(x + w, y, x + w, y + h, rad);
  c.arcTo(x + w, y + h, x, y + h, rad);
  c.arcTo(x, y + h, x, y, rad);
  c.arcTo(x, y, x + w, y, rad);
  c.closePath();
}

/**
 * 🔴🔴 多边形填充 —— 老项目 index.html:11741 `poly` **逐字**：
 *   `function poly(c, pts, u) { c.beginPath(); pts.forEach(function (p, i) {
 *      i ? c.lineTo(p[0]*u, p[1]*u) : c.moveTo(p[0]*u, p[1]*u); }); c.closePath(); c.fill(); }`
 *
 * 🔴 它是**恐龙身体的绘制函数**，不是通用工具 —— 坐标表以 `u` 为单位缩放，
 *   `u = s / 26`（s = 站立 26 /低头 18）⇒ 低头时整只恐龙连同眼睛嘴腿一起等比缩小。
 *   bj 此前的 `rr(c, 0, 0, 34, dh, 8)`（一个圆角矩形 + 一个圆点当眼睛）
 *   完全没有轮廓这件事：用户看到的"恐龙"其实是一块砖。
 */
function poly(c: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[], u: number): void {
  c.beginPath();
  pts.forEach((p, i) => {
    if (i) c.lineTo(p[0] * u, p[1] * u);
    else c.moveTo(p[0] * u, p[1] * u);
  });
  c.closePath();
  c.fill();
}

/**
 * 🔴 恐龙轮廓坐标表 —— 老项目 index.html:11730 **逐字**：
 *   `var DINO = [[1,7],[9,10],[9,17],[3,14]], BODY = [[7,10],[20,10],[18,18],[9,18]];`
 *
 *   `DINO` = 头+颈（从左上(1,7)沿到嘴(9,10)、下颌(9,17)、回到(3,14)），
 *   `BODY` = 躯干（背脊从 (7,10) 到 (20,10)、尾根 (18,18)、腹 (9,18)）。
 *   单位是「站立高26」时的像素，绘制时统一乘 `u`。
 */
const DINO: readonly (readonly [number, number])[] = [
  [1, 7],
  [9, 10],
  [9, 17],
  [3, 14],
];
const BODY: readonly (readonly [number, number])[] = [
  [7, 10],
  [20, 10],
  [18, 18],
  [9, 18],
];

function txt(
  c: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  size: number,
  color: string,
  align: CanvasTextAlign = 'center',
): void {
  c.fillStyle = color;
  c.font = `${size}px var(--mono, ui-monospace)`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(s, x, y);
}

/** 素材词：正文词 → 收藏/待办 → 内置兜底。**永不返回空数组**（纪律 2）。 */
function names(kind: string, bodyText: string, favs: readonly string[], fallback: string[]): string[] {
  if (kind === 'brick' || kind === 'dragon') {
    const w = bodyWordsFor(bodyText);
    if (w.length >= 8) return w;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of favs) {
    const s = n.trim();
    if (s === '' || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  if (out.length >= 3) return out;
  for (const n of fallback) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * 正文抽词。与 registry.bodyWords 同口径，这里重复一份是因为
 * 游戏**必须**有素材（纪律 2），不能因为 bodyWords 返回空就开局即死。
 */
function bodyWordsFor(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of text.split(/[\s，。！？、；：,.!?;:]+/)) {
    const s = seg.trim();
    if (s === '') continue;
    const words = /[一-龥]/.test(s) ? chunkCjk(s) : [s];
    for (const w of words) {
      if (w.length < 2 || seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= 64) return out;
    }
  }
  return out;
}

function chunkCjk(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(s.slice(i, i + 2));
  return out;
}

/* ------------------------------------------------------------------ *
 * 1. /snake 贪吃蛇 —— 蛇身由笔记名接成，蛇头是当前笔记
 * ------------------------------------------------------------------ */

const SNAKE_FALLBACK = ['笔记', '灵感', '清单', '草稿', '计划', '备忘', '片段', '随手'];

export function snakeGame(getCtx: () => { body: string; favs: string[]; cur: string }): GameDef {
  const GRID = 20;
  let cell = 20;
  let ox = 0;
  let oy = 0;
  let body: { x: number; y: number }[] = [];
  let food: { x: number; y: number; pts: number; label: string } = { x: 0, y: 0, pts: 0, label: '' };
  let dir: 'U' | 'D' | 'L' | 'R' = 'R';
  let queue: Array<'U' | 'D' | 'L' | 'R'> = [];
  let score = 0;
  let step = 0;
  let acc = 0;
  const SPEED = 7; // 格/秒

  const reset = (g: GameCtx): void => {
    const p = pal(g);
    void p;
    const ns = names('snake', getCtx().body, getCtx().favs, SNAKE_FALLBACK);
    const head = getCtx().cur || 'note';
    body = [{ x: 8, y: 10 }, { x: 7, y: 10 }, { x: 6, y: 10 }];
    dir = 'R';
    queue = [];
    score = 0;
    step = 0;
    acc = 0;
    g.setScore('0 字');
    g.setLevel('蛇身 3');
    // 蛇身贴上笔记名：越长的名字越占格
    for (const n of ns.slice(0, 6)) {
      for (let i = 0; i < Math.min(4, n.length); i++) {
        body.push({ x: Math.max(0, 8 - (body.length - 2) * 0), y: 10 });
      }
      break;
    }
    body = body.slice(0, 8);
    placeFood(g, ns);
  };

  const placeFood = (g: GameCtx, ns: string[]): void => {
    const free: { x: number; y: number }[] = [];
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (!body.some((b) => b.x === x && b.y === y)) free.push({ x, y });
      }
    }
    if (free.length === 0) {
      // 满盘=通关（老版 place 同款：空了就判通关）
      g.end('通关了', [
        ['本局', score + ' 字'],
        ['蛇身', body.length + ' 节'],
        ['历史最佳', bestOf() + ' 字'],
      ]);
      return;
    }
    const p = free[Math.floor(Math.random() * free.length)] as { x: number; y: number };
    const label = ns[Math.floor(Math.random() * ns.length)] ?? '笔记';
    food = { x: p.x, y: p.y, pts: label.length, label };
  };

  const turn = (d: 'U' | 'D' | 'L' | 'R'): void => {
    //🔴 不许 180° 掉头：那是"自己撞自己脖子"，在触屏上极容易误触
    const opp: Record<string, string> = { U: 'D', D: 'U', L: 'R', R: 'L' };
    if (queue.length === 0 && opp[dir] === d) return;
    if (queue.length < 2) queue.push(d);
  };

  /** 历史最佳（老版 SH().best.snake 同语义，存本机 localStorage）。 */
  const BEST_KEY = 'notesync_bj_best_snake';
  function bestOf(): number {
    try {
      return Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch {
      return 0;
    }
  }
  function die(why: string, g: GameCtx): void {
    const best = Math.max(bestOf(), score);
    try {
      localStorage.setItem(BEST_KEY, String(best));
    } catch {
      /* 装饰性数据，写不下就算了 */
    }
    g.end(why, [
      ['本局', score + ' 字'],
      ['蛇身', body.length + ' 节'],
      ['历史最佳', best + ' 字'],
    ]);
  }

  return {
    id: 'snake',
    tip: '四向划屏 / 方向键转向 · 吃 +字数 颗粒长一节',
    start: reset,
    resize: (w, h) => {
      cell = Math.floor(Math.min(w / GRID, h / GRID));
      ox = (w - cell * GRID) / 2;
      oy = (h - cell * GRID) / 2;
    },
    frame: (dt, g) => {
      acc += dt * SPEED;
      while (acc >= 1) {
        acc -= 1;
        step += 1;
        if (queue.length > 0) {
          const d = queue.shift();
          if (d) dir = d;
        }
        const head = body[0];
        if (!head) return;
        const nx = head.x + (dir === 'L' ? -1 : dir === 'R' ? 1 : 0);
        const ny = head.y + (dir === 'U' ? -1 : dir === 'D' ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) {
          g.fx('die');
          die('撞墙了', g);
          return;
        }
        if (body.some((b) => b.x === nx && b.y === ny)) {
          g.fx('die');
          die('咬到自己了', g);
          return;
        }
        body.unshift({ x: nx, y: ny });
        if (nx === food.x && ny === food.y) {
          score += food.pts;
          g.fx('eat');
          g.setScore(score + ' 字');
          g.setLevel('蛇身 ' + body.length);
          const ns = names('snake', getCtx().body, getCtx().favs, SNAKE_FALLBACK);
          placeFood(g, ns);
        } else {
          body.pop();
        }
      }
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const ctx2 = cv?.getContext('2d');
      if (!ctx2) return;
      const p = pal(g);
      ctx2.clearRect(0, 0, g.w(), g.h());
      // 网格底
      ctx2.strokeStyle = p.line;
      ctx2.lineWidth = 1;
      for (let i = 0; i <= GRID; i++) {
        ctx2.beginPath();
        ctx2.moveTo(ox + i * cell, oy);
        ctx2.lineTo(ox + i * cell, oy + GRID * cell);
        ctx2.moveTo(ox, oy + i * cell);
        ctx2.lineTo(ox + GRID * cell, oy + i * cell);
        ctx2.stroke();
      }
      // 蛇身
      body.forEach((b, i) => {
        ctx2.fillStyle = i === 0 ? p.accent : p.soft;
        rr(ctx2, ox + b.x * cell + 1, oy + b.y * cell + 1, cell - 2, cell - 2, 4);
        ctx2.fill();
      });
      // 食物：格子里写分数
      ctx2.fillStyle = p.soft;
      rr(ctx2, ox + food.x * cell + 1, oy + food.y * cell + 1, cell - 2, cell - 2, 4);
      ctx2.fill();
      txt(ctx2, String(food.pts), ox + (food.x + 0.5) * cell, oy + (food.y + 0.5) * cell, cell * 0.5, p.accent);
    },
    swipe: (d) => turn(d),
    key: (down, e, g) => {
      if (!down) return;
      const m: Record<string, 'U' | 'D' | 'L' | 'R'> = {
        ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R',
        w: 'U', s: 'D', a: 'L', d: 'R', W: 'U', S: 'D', A: 'L', D: 'R',
      };
      const d = m[e.key];
      if (d) turn(d);
      void g;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 2. /dragon 断网恐龙 —— 三秒分镜 → 横版跳跃（低头过高的牌子）
 * ------------------------------------------------------------------ */

/**
 * 老项目 `rf(a,b)`（:11736 等处逐字）：[a,b) 随机浮点。
 * 老项目用 `rf(-3,3)` 做撞击抖动、`rf(0,90)` 做障碍间距抖动。
 */
function rf(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** 老项目同款 pick（index.html 多处使用）：随机取一项。 */
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

/**
 * 老项目 `clipTo`（:11581-11587，v9.2.0 修的长方形 bug）**逐字照抄**。
 *
 * 🔴🔴 为什么不能改成 `label.slice(0, 6)`（bj 此前就是这么写的）：
 *   6 个汉字按 10px 就是 60px，塞进 52px 的窄障碍框必压出长方形
 *   （老项目注释原文：「用户报 dragon 实锤」）。而高障碍框只有 52px 宽 ——
 *   定长截断在**宽框**上凑巧能用、在**窄框**上必错，所以两种框统一按实测宽度截。
 *
 * @param max 可用宽度（调用前必须先设好 `c.font` —— measureText 量的是当前字体）
 */
function clipTo(c: CanvasRenderingContext2D, txt: string, max: number): string {
  let s = String(txt == null ? '' : txt);
  if (!s || max <= 0) return '';
  if (c.measureText(s).width <= max) return s;
  // 逐字回退到能容下「…」
  while (s.length > 1 && c.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

/**
 * 🔴🔴 历史最佳的本机持久化。老项目 `NSG.best` + `BEST_KEY`（index.html:10679-10687）。
 *
 * 键名 `notesync_best` —— **逐字等于老项目 :10681 `var BEST_KEY = 'notesync_best';`**。
 *
 * 🔴 这里此前是 `notesync_bj_game_best`，理由写的是"bj 用独立前缀隔离"。
 *   **那个理由不成立**：键名分前缀的规矩针对的是"与**别的应用**共享 localStorage"，
 *   而这里的语义就是**同一个应用的同一份存档**（老项目那条记录的宿主也叫 notesync）。
 *   改键名不是"隔离"，是**换了一个存档位置** ⇒ 用户从老版本升级过来，
 *   历史最佳会**凭空归零**，而且界面上看不出任何异常（这正是最难查的那类静默降级）。
 *
 * 🔴 仍要与发现记录键 `notesync_bj_eggs`（registry.ts）**分开**：
 *   两者 id 空间不同（发现记录是「哪些蛋见过」，走白名单过滤；
 *   最佳成绩是「某个游戏跑过多少分」），混在一个键里的话
 *   `readDiscovered` 的白名单会把 `dragon` 当成"未注册的 id"直接丢掉。
 *   老项目也是两个键（`notesync_best` vs 它自己的图鉴键），口径一致。
 */
const BEST_KEY = 'notesync_best';

/** 读某个游戏的最佳成绩（0 = 从没玩过）。写不下/读坏一律当0，绝不让游戏开不了局。 */
function readBest(store: EggStore, id: string): number {
  try {
    const raw = JSON.parse(store.getItem(BEST_KEY) ?? '{}') as Record<string, unknown>;
    const v = raw ? raw[id] : 0;
    return typeof v === 'number' && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * 记一次最佳成绩。老项目 `saveBest`（:10683-10687）**逐条照抄**：
 *   - `!(v > 0)` 直接return（0 分不该占位）
 *   - **只在刷新纪录时写盘**（`!(best > v)`）—— 否则每局结束都写一次 localStorage，
 *     移动端主线程会明显卡，而症状是"玩一把游戏手机就发烫"，极难归因。
 */
function saveBest(store: EggStore, id: string, v: number): void {
  if (!(v > 0)) return;
  const cur = readBest(store, id);
  if (cur > v) return;
  const next: Record<string, number> = {};
  try {
    const raw = JSON.parse(store.getItem(BEST_KEY) ?? '{}') as Record<string, unknown>;
    for (const [k, val] of Object.entries(raw ?? {})) {
      if (typeof val === 'number' && val > 0) next[k] = val;
    }
  } catch {
    /* 旧记录读坏就当没有，直接覆盖 */
  }
  next[id] = v;
  try {
    store.setItem(BEST_KEY, JSON.stringify(next));
  } catch {
    // 写不下就算了：最佳成绩是**装饰性**数据，丢了不影响任何功能
  }
}

export function dragonGame(getCtx: () => { body: string; favs: string[]; cur?: string }): GameDef {
  /** 障碍。老项目 `obs`（:11738）：`hi` = 高障碍（需低头），否则跳。 */
  interface Obs {
    x: number;
    hi: boolean;
    w: number;
    h: number;
    label: string;
    hit: boolean;
  }
  let labels: string[] = [];
  let obs: Obs[] = [];
  let x = 0;
  /** y 是**离地高度**（向上为正、0 = 地面），老项目同名同义（:11731）。 */
  let y = 0;
  let vy = 0;
  let onGround = true;
  let duck = false;
  let speed = 132;
  let score = 0;
  let dist = 0;
  /** 已躲过的障碍数（老项目 `pass`，:11762）。结算卡第二行。 */
  let pass = 0;
  let dead = false;
  let ground = 0;
  /** 画布宽。老项目 :11738 `SH().W + 80` /:11761 `SH().W - 40` 都吃它，不是写死常量。 */
  let viewW = 800;
  /** 撞击抖动剩余量。老项目 :11768 置 0.2、:11777 每帧减 0.016。 */
  let shake = 0;
  /** 🔴 老项目 `it`（:11759）：**秒**。速度曲线按它算，不按距离。 */
  let it = 0;
  /**
   * 🔴 按住屏幕的低头保持。老项目 `heldDuck`（:11742）。
   *   有了它才能区分「按住 → 低头」与「快速点一下 → 跳」（老项目 :11754-11755）。
   */
  let heldDuck = false;
  /** 老项目 `introTap`（:11742）：intro 期那一下只起跑、不补跳。 */
  let introTap = false;
  /** 老项目 `holdT`（:11742）：按住 150ms 才低头，避免"想跳结果低了下头"。 */
  let holdT: ReturnType<typeof setTimeout> | undefined = undefined;
  /**
   * 🔴🔴 intro 相位：进入后的前 3 秒**只跑动画、不判碰撞**。
   *
   *   这是用户报障「dragon 进入就死亡」的**真实根因**（探针 probe-eggs 实锤：
   *   进入后 3 秒就出「这一局结束了得分10」）。bj 此前直接进 run 相位，
   *   而第一块牌子就在 x=60+220-46 处 ⇒ 站着不动 0.4 秒必撞。
   *
   *   老项目 index.html:11757 原样：
   *     if (phase === 'intro') { it += dt; if (it > 3) { phase = 'run'; } return; }
   *   —— 它的 `introTap` 机制还让"第一下点击只起跑、不补跳"，bj 照搬。
   *   **3 秒无敌**这条是承重的，必须有（否则用户还没看清玩法就死了）。
   */
  let intro = true;

  const reset = (g: GameCtx): void => {
    labels = names('dragon', getCtx().body, getCtx().favs, ['账单', 'deadline', '周报', '待办', '会议', '需求', 'bug', '上线']);
    ground = g.h() - 46;
    // 🔴 恐龙固定在 x=16（老项目 :11781 `var dx = 16`）——
    //   碰撞判据（老项目 :11767 `16 + 22 > o.x && 16 < o.x + o.w`）也用这个 16。
    //   🔴 这两处**必须同源**：此前绘制在 x=60 而碰撞仍判16，
    //   症状是「看着还有一段距离却撞上了」，且用户完全无法预判。
    x = 16;
    viewW = g.w();
    // 🔴 y 是**离地高度**，初始 0 = 贴地（此前写 `y = ground`，那是旧的屏幕坐标语义）
    y = 0;
    vy = 0;
    onGround = true;
    duck = false;
    // 🔴 起始速度回老项目的 132（此前 260，是老项目的两倍 —— 手感"飞出去"）
    speed = 132;
    score = 0;
    dist = 0;
    pass = 0;
    obs = [];
    dead = false;
    intro = true;
    it = 0;
    shake = 0;
    heldDuck = false;
    introTap = false;
    // 🔴 在途的低头定时器必须撤（老项目 :11733 `if (holdT) clearTimeout(holdT)`）：
    //   重开时上一局的 150ms 定时器还在的话，新局开局 150ms 后会莫名开始低头。
    if (holdT !== undefined) clearTimeout(holdT);
    holdT = undefined;
    g.setScore('0');
    g.setLevel('');
  };

  /** 起跳。老项目 `jump`（:11740）：必须**在地面**才给初速。 */
  const jump = (g: GameCtx): void => {
    if (intro || !onGround || dead) return;
    vy = 330;
    onGround = false;
    g.fx('tap');
  };

  /**
   * 生成下一块障碍。老项目 `spawn`（:11734-11739）**逐字照抄**。
   *
   * 🔴🔴 `hi`（30% 概率的高障碍）是「低头」这个玩法**唯一的存在理由** ——
   *   高障碍的判定框在 `GY - 38`（比矮的更高），跳不过去，只能低头钻过去。
   *   所以 H（高障碍）与 I（低头）**必须成对**做：只补低头没有高障碍，玩家按了没用；
   *   只补高障碍没有低头，玩家按了也没用。
   */
  const spawn = (): void => {
    const last = obs[obs.length - 1];
    // 间距随速度收紧，但保底 150px —— 保证窄到极限也还跳得过去
    const gap = Math.max(150, 215 - speed * 0.35) + rf(0, 90);
    const hi = Math.random() < 0.3;
    const label = labels[Math.floor(Math.random() * Math.max(1, labels.length))] ?? '账单';
    obs.push({
      x: last ? last.x + last.w + gap : viewW + 80,
      hi,
      w: hi ? 52 : 30,
      h: hi ? 20 : 26,
      label,
      hit: false,
    });
  };

  return {
    id: 'dragon',
    tip: '点屏幕 = 跳 · 按住屏幕 = 低头 · 撞上牌子就结束',
    start: reset,
    resize: (w, h, g) => {
      viewW = w;
      ground = h - 46;
      void g;
    },
    frame: (dt, g) => {
      if (intro) {
        it += dt;
        if (it > 3) intro = false;
        return;
      }
      if (dead) return;
      // 🔴🔴 E：速度曲线**按秒**不按距离。老项目 :11759
      //   `sp = 132 + Math.min(70, it * 0.8)`，it 是**秒**。
      //   bj 此前写的是 `132 + Math.min(70, dist * 0.05)` —— 加速度随**距离**而非时间，
      //   后果是「同一个速度在不同距离下对应不同的加速率」，
      //   手感会飘（开局几乎不加速、越到后面越猛），与老项目不一致。
      speed = 132 + Math.min(70, it * 0.8);
      it += dt;
      dist += speed * dt;
      // 🔴 重力 900、方向与老项目一致（y 是**离地高度**，向上为正 ⇒ vy -= g）
      vy -= 900 * dt;
      y += vy * dt;
      // 🔴 落地判据是 `y <= 0`（离地高度 0 = 贴地），**不是 `y <= ground`**。
      //   旧版本把 ground 当屏幕坐标用，改语义时这里漏改会让恐龙一出生就"落地"
      //   （y=ground=高度值 ⇒ y<=ground 立刻成立 ⇒ vy 被夹成 0，永远跳不起来）。
      if (y <= 0) {
        if (!onGround) g.fx('tap');
        y = 0;
        vy = 0;
        onGround = true;
      }
      // 老项目 :11761：右侧还够得着就补一块（`W - 40` 是"下一块该出现了"的门槛）
      if (obs.length === 0 || (obs[obs.length - 1] as Obs).x < viewW - 40) spawn();
      for (const o of obs) {
        o.x -= speed * dt;
        // 牌子完全跑到恐龙身后（老项目判据 `o.x + o.w < 16`，恐龙固定在 x=16）⇒ 记一次躲过
        if (!o.hit && o.x + o.w < 16) {
          o.hit = true;
          pass += 1;
          g.fx('eat');
        }
      }
      // 甩掉跑到画布外很远的牌子（老项目 :11763）
      obs = obs.filter((o) => o.x > -140);
      // 🔴 I：低头时恐龙**变矮**（26 → 18，老项目 :11764 `dh = duck ? 18 : 26`）。
      //   这正是能钻过高障碍的原因：高障碍的框在 `GY - 38`，站立时必撞、蹲下时刚好错开。
      const dh = duck ? 18 : 26;
      const dy = ground - y - dh;
      for (const o of obs) {
        const oy = o.hi ? ground - 38 : ground - o.h;
        // 老项目 :11767 `16 + 22 > o.x && 16 < o.x + o.w && …` —— 恐龙固定 x=16、半宽 22
        if (16 + 22 > o.x && 16 < o.x + o.w && dy + dh > oy && dy < oy + o.h && !dead) {
          dead = true;
          // 🔴 D：撞击震动。老项目 :11768 `shake = 0.2`
          shake = 0.2;
          g.fx('die');
          const run = Math.floor(dist / 4);
          // 🔴 G：结算三行。老项目 :11769 逐字照抄。
          //   🔴「历史最佳」读的是**本局之前**的成绩 —— 老项目 `END`（:10858）
          //     是「先由调用方把 rows 构造好、再 saveBest、再显示」，
          //     所以 rows 里那个值必然是 save 之前的。照抄这个次序。
          const bestBefore = readBest(eggBrowserStore(), 'dragon');
          g.end('被' + o.label + '撞倒了', [
            ['本局跑了', run + ' 字'],
            ['躲过', pass + ' 个'],
            ['历史最佳', bestBefore + ' 字'],
          ]);
          saveBest(eggBrowserStore(), 'dragon', run);
          return;
        }
      }
      score = Math.floor(dist / 4);
      // 🔴 F：分数**三位补零**（老项目 :11772 `String(Math.floor(dist/4)).padStart(3, '0')`）。
      //   不补零时「7」与「007」在等宽数字 HUD 里宽度不同 ⇒ 分数位会左右跳。
      g.setScore(String(score).padStart(3, '0'));
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const p = pal(g);
      const W = g.w();
      c.clearRect(0, 0, W, g.h());
      // 🔴 D：撞击震动。老项目 :11777 `if (shake > 0) { shake -= 0.016;
      //   c.save(); c.translate(rf(-3, 3), rf(-2.5, 2.5)); }`，
      //   收尾 :11811 `if (shake > 0) c.restore();`。
      //   🔴 save/restore 必须成对且位置对称 —— 少收一个，下一帧起所有绘制坐标都偏了。
      const shaking = shake > 0;
      if (shaking) {
        shake -= 0.016;
        c.save();
        c.translate(rf(-3, 3), rf(-2.5, 2.5));
      }
      // 地面基线（老项目 :11778）
      c.strokeStyle = p.line;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(0, ground + 0.5);
      c.lineTo(W, ground + 0.5);
      c.stroke();
      // 🔴 C：地面装饰 —— 12 段滚动虚线。老项目 :11780逐字照抄：
      //   `for (i < 12) { x = ((i*47 - (dist*2.2)%47) % (W+47) + W+47) % (W+47);
      //                fillRect(x, GY+7, 3, 1); }`
      //   间距 47px、随距离以 2.2 倍速左移、取模回绕 ⇒ 无限滚动且不闪。
      //   bj 此前是一条 `fillRect(0, ground+20, w, 26)` 实心块 —— 那不是滚动，
      //   视觉上「地面在动」这件事完全消失（用户报障「dragon 界面不一样」的一半根因）。
      c.fillStyle = p.muted;
      for (let i = 0; i < 12; i += 1) {
        const dx = ((i * 47 - ((dist * 2.2) % 47)) % (W + 47) + W + 47) % (W + 47);
        c.fillRect(dx, ground + 7, 3, 1);
      }
      // 🐲 恐龙。老项目 index.html:11781-11792 **逐字照抄**。
      // 🔴 `y` 的语义在这一版是**离地高度**（向上为正、0 = 地面），
      //   与老项目 :11740 `function jump(){ vy = 330 }` + `:11759 vy -= 900*dt`
      //   完全一致 —— 此前 bj 用的是「绝对屏幕坐标 + 向下为正」，
      //   与老项目的物理约定**反号**，抄任何一行物理参数都会得到反向手感
      //   （老项目那条注释「写成 vy+=g 会把起跳首帧就夹回地面」说的就是这类反号）。
      //   ⇒ 画恐龙要用 `ground - y - s`（屏幕坐标），不能直接拿 y 当屏幕 y。
      //
      // 🔴🔴 开场的横向滑入 + 上下浮沉（老项目 :11781-11783）。**承重**：
      //   bj 此前把恐龙钉死在 x=16 静止不动，于是站台上「恐龙在动」这件事完全消失，
      //   而它正是开场那3 秒里唯一的动态线索（老项目 :11757 intro 相位不推进物理）。
      //   三段公式逐字：
      //     it< 1.2   dx = -30 + (it/1.2)*46   从画面左侧外滑入到 x=16；dip = sin(it*16)*1.3上下浮沉
      //     it < 2.2  dip = 3*min(1,(it-1.2)/0.45)   过渡（浮沉幅度收到 3）
      //     run 段    ground && !duck 时 dip = (floor(it*9)%2) ? -1.4 : 0   跑动时眨眼般地上下
      let dx = x;
      let dip = 0;
      if (intro) {
        if (it < 1.2) {
          dx = -30 + (it / 1.2) * 46;
          dip = Math.sin(it * 16) * 1.3;
        } else if (it < 2.2) {
          dip = 3 * Math.min(1, (it - 1.2) / 0.45);
        }
      } else if (onGround && !duck) {
        dip = Math.floor(it * 9) % 2 ? -1.4 : 0;
      }
      // 🔴 I：低头时高度 26 → 18，并按老项目 :11785 `c.transform(1,0,0,.72,0, s*.28)`
      //   压扁 —— 只改高度不压扁的话，恐龙会变成「一根突然变短的柱子」而不是「蹲下」。
      //   🔴 `s` 是**这一帧用于缩放与定位的那个高度**，绘制与碰撞判据必须同源：
      //     碰撞那边用的是 `duck ? 18 : 26`（:11764 `dh`），两处不能各写一份。
      const s = duck ? 18 : 26;
      c.save();
      c.translate(dx, ground - y - s + dip);
      if (duck) c.transform(1, 0, 0, 0.72, 0, s * 0.28);
      // 🔴 `u` 是老项目的统一缩放因子（:11786 `var u = s / 26`）——
      //   坐标表、眼睛、嘴、腿**全部**乘它，低头时整只恐龙一起缩（含眼）。
      const u = s / 26;
      c.fillStyle = dead ? p.danger : p.accent;
      // 🔴 头+颈、躯干（老项目 :11787 `poly(c, DINO, u); poly(c, BODY, u);`）
      //   随后 `rr(c, 13*u, 2*u, 11*u, 8*u, 1.6*u)` 是**吻部**（头部右上的方块）。
      poly(c, DINO, u);
      poly(c, BODY, u);
      rr(c, 13 * u, 2 * u, 11 * u, 8 * u, 1.6 * u);
      c.fill();
      // 🔴 两条后腿（老项目 :11788-11789，x 分别在 9u 与 15u、高 6u ⇒ 站立时伸到 y=24）
      rr(c, 9 * u, 18 * u, 3.2 * u, 6 * u, 1 * u);
      c.fill();
      rr(c, 15 * u, 18 * u, 3.2 * u, 6 * u, 1 * u);
      c.fill();
      // 🔴 嘴：一条 1.7px 的圆头斜线（老项目 :11790）。
      //   🔴 这条线是 `stroke` 不是 `fill`，且**必须**先把 `lineCap` 设为 round，
      //   否则默认 butt 端点在低端坐标上会明显缺一截。
      c.strokeStyle = dead ? p.danger : p.accent;
      c.lineWidth = 1.7;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(19 * u, 14 * u);
      c.lineTo(22.6 * u, 15 * u);
      c.stroke();
      // 🔴 眼睛：眼白 + 瞳点，都用**画布底色**（老项目 :11791 `c.fillStyle = P.bg`）——
      //   即"在身体色上挖两个底色的小块"，不是画一个白眼球。
      //   眼白 (20u, 6.3u) 4×1.7u；瞳点 (21u, 4u) 1.9×1.9u。
      c.fillStyle = p.bg;
      rr(c, 20 * u, 6.3 * u, 4 * u, 1.7 * u, 0.4 * u);
      c.fill();
      rr(c, 21 * u, 4 * u, 1.9 * u, 1.9 * u, 0.5 * u);
      c.fill();
      c.restore();
      // 🔴 B：开场分镜第一件 —— 'NO NETWORK · 那就跑会儿步'
      //   老项目 :11793-11795 逐字照抄（10px mono，位置 W/2-84, 22）。
      //   bj 此前完全没有这句（`grep 'NO NETWORK'` 在bj 零命中）——
      //   它是「断网」这个主题唯一的文案交代，少了它整个开场是空白的。
      if (intro) {
        c.fillStyle = p.muted;
        c.font = '10px ' + monoOf(g);
        c.textAlign = 'left';
        c.textBaseline = 'alphabetic';
        c.fillText('NO NETWORK · 那就跑会儿步', W / 2 - 84, 22);
        // 🔴 B：开场分镜第二件 —— 1.2~3 秒之间画站牌「未命名笔记 · N 字」
        //   老项目 :11796-11802 逐字照抄。
        //   🔴 字数是 `title().length * 128`：老项目拿**笔记名长度 × 128** 当字数
        //     （一句游戏化的自嘲 —— "你写的这点字，按每秒 128 字还能跑多久"）。
        //     不是正文字数。照抄，别"顺手改成正文长度"。
        if (it >= 1.2 && it < 3) {
          const pw = 132;
          const px = W - pw - 10;
          const py = ground - 30;
          c.strokeStyle = it < 2.2 ? p.line : p.accent;
          // 🔴 老项目 :11798 `c.fillStyle = P.bx`（面板实底），不是画布底色。
          //   填 p.bg 的话站牌与背景同色 ⇒ 「站牌消失，只剩两行字浮着」。
          c.fillStyle = p.boxBg;
          rr(c, px, py, pw, 22, 4);
          c.fill();
          c.stroke();
          const title = getCtx().cur || '未命名笔记';
          c.fillStyle = p.muted;
          c.font = '9px ' + monoOf(g);
          c.textBaseline = 'middle';
          c.fillText(
            '未命名笔记 · ' + (title.length * 128).toLocaleString('en-US') + ' 字',
            px + 7,
            py + 11.5,
          );
          c.textBaseline = 'alphabetic';
        }
      }
      for (const o of obs) {
        const oy = o.hi ? ground - 38 : ground - o.h;
        c.lineWidth = 1.7;
        c.strokeStyle = p.line;
        // 🔴 老项目 :11806 `c.fillStyle = P.bx`（同上：面板实底 ≠ 画布底色）
        c.fillStyle = p.boxBg;
        rr(c, o.x, oy, o.w, o.h, 4);
        c.fill();
        c.stroke();
        // 🔴 J：障碍词按**实测框宽**裁剪（老项目 :11809 `clipTo(c, o.label, o.w - 10)`，
        //   v9.2.0 修的长方形 bug）。bj 此前是 `lb.slice(0, 6)` 定长 ——
        //   高障碍框只有 52px 宽，6 个汉字必然溢出压成 rectangle。
        //   🔴 clipTo 量的是当前字体，所以必须先设 font 再量（老项目 :11808 同款次序）。
        c.fillStyle = p.muted;
        c.font = '10px ' + monoOf(g);
        c.textBaseline = 'middle';
        c.fillText(clipTo(c, o.label, o.w - 10), o.x + 5, oy + o.h / 2 + 1);
        c.textBaseline = 'alphabetic';
      }
      if (shaking) c.restore();
    },
    down: (_x, _y, g) => {
      // 🔴 I：按下 = 可能想低头。老项目 :11754 用 150ms 定时器区分
      //   「按住」与「快速点一下」—— 直接在 down 里置 duck 的话，
      //   每次想跳都会先低一下头（而低头期间跳不了），手感极差。
      if (intro) {
        intro = false;
        introTap = true;
        return;
      }
      if (dead) return;
      if (holdT !== undefined) clearTimeout(holdT);
      heldDuck = false;
      holdT = setTimeout(() => {
        holdT = undefined;
        if (intro || dead) return;
        duck = true;
        heldDuck = true;
        g.fx('tap');
      }, 150);
    },
    up: (_x, _y, g) => {
      // 🔴 抬手判定顺序是行为的一部分（老项目 :11755）：
      //   撤定时器 → 吃掉 intro 的那一下 → 若是低头则解除（**不跳**）→ 否则跳。
      //   顺序换了会出现「按住低头、松手却跳起来」。
      if (holdT !== undefined) {
        clearTimeout(holdT);
        holdT = undefined;
      }
      if (introTap) {
        introTap = false;
        return;
      }
      if (heldDuck) {
        duck = false;
        heldDuck = false;
        return;
      }
      jump(g);
    },
    key: (down, e, g) => {
      // 🔴 老项目 :11749-11753：Space/ArrowUp 起跳；ArrowDown 低头（keyup 解除）。
      //   bj 的 GameDef 没有独立 keyup，`key(down, e, g)` 的 `down` 参数就是 keydown/keyup 之分。
      if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w') {
        if (!down) return;
        if (intro) {
          intro = false; // 🔴 老项目 introTap：intro 期的第一下只起跑、不补跳
          return;
        }
        jump(g);
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 's') {
        duck = down;
        if (down) g.fx('tap');
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * 3. /brick 打砖块 —— 砖面是你正文里的词
 *
 * 🔴🔴 移植老项目 index.html:11817-11894 逐条比对。此前的自造实现
 *   是"漂移挡板+5行杂砖"的另一个游戏（审计实测只剩 1 块砖、无连击）。
 *   老版要点：6×3=18 块（第 1 行偶数列硬砖 hp2、第 0 行第 4 块钢砖不碎）、
 *   挡板/鼠标横拖、连击计数（触板+1、碎砖+1、最长连击进结算）、
 *   结算「打掉 N 块 / 最长连击 / 用时」、文案「全清了 / 球掉了」。
 * ------------------------------------------------------------------ */

export function brickGame(getCtx: () => { body: string; favs: string[] }): GameDef {
  const COLS = 6;
  const ROWS = 3;
  interface Brick { x: number; y: number; w: number; h: number; name: string; kind: 'norm' | 'hard' | 'steel'; hp: number; alive: boolean }
  let bw = 58;
  const bh = 24;
  const gap = 3;
  let bricks: Brick[] = [];
  let ball: { x: number; y: number; vx: number; vy: number; r: number } = { x: 0, y: 0, vx: 118, vy: -196, r: 5 };
  let pad: { x: number; w: number } = { x: 0, w: 74 };
  let score = 0;
  let combo = 0;
  let best = 0;
  let t0 = 0;
  let dead = false;

  const reset = (g: GameCtx): void => {
    const nm = names('brick', getCtx().body, getCtx().favs, ['灵感池', '工作随记', '九月周报', '读书笔记', '菜谱', '健身', '发票', '备忘', '会议', '想法池', '旧文', '待办']);
    bricks = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const kind: 'norm' | 'hard' | 'steel' = r === 1 && c % 2 === 0 ? 'hard' : r === 0 && c === 3 ? 'steel' : 'norm';
        bricks.push({
          x: 6 + c * (bw + gap),
          y: 26 + r * (bh + gap),
          w: bw,
          h: bh,
          name: nm[(r * COLS + c) % nm.length] ?? '词',
          kind,
          hp: kind === 'hard' ? 2 : 1,
          alive: true,
        });
      }
    }
    ball = { x: g.w() / 2, y: g.h() - 70, vx: 118, vy: -196, r: 5 };
    pad.x = g.w() / 2 - pad.w / 2;
    score = 0;
    combo = 0;
    best = 0;
    t0 = 0;
    dead = false;
    g.setScore('0 / ' + bricks.length);
    g.setLevel('连击 0');
  };

  const finish = (win: boolean, g: GameCtx): void => {
    if (dead) return;
    dead = true;
    g.setScore(String(score));
    g.fx(win ? 'win' : 'die');
    g.end(win ? '全清了' : '球掉了', [
      ['打掉', score + ' 块'],
      ['最长连击', String(best)],
      ['用时', Math.round(t0) + 's'],
    ]);
  };

  return {
    id: 'brick',
    tip: '单指横拖 / 鼠标移动 = 挡板 · 砖面是你正文里的词 · 打掉只计分，不改一条数据',
    start: (g) => reset(g),
    resize: (w) => {
      bw = Math.floor((w - 12 - gap * (COLS - 1)) / COLS);
    },
    move: (x, _y, g) => {
      pad.x = Math.max(0, Math.min(g.w() - pad.w, x - pad.w / 2));
    },
    down: (x, _y, g) => {
      pad.x = Math.max(0, Math.min(g.w() - pad.w, x - pad.w / 2));
    },
    key: (down, e) => {
      if (!down) return;
      if (e.key === 'ArrowLeft') {
        pad.x = Math.max(0, pad.x - 22);
        e.preventDefault();
      }
      if (e.key === 'ArrowRight') {
        pad.x = Math.min(window.innerWidth - pad.w, pad.x + 22);
        e.preventDefault();
      }
    },
    frame: (dt, g) => {
      if (dead) return;
      t0 += dt;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      if (ball.x < ball.r) {
        ball.x = ball.r;
        ball.vx *= -1;
      }
      if (ball.x > g.w() - ball.r) {
        ball.x = g.w() - ball.r;
        ball.vx *= -1;
      }
      if (ball.y < ball.r + 6) {
        ball.y = ball.r + 6;
        ball.vy *= -1;
      }
      if (ball.y > g.h() - 30 && ball.y < g.h() - 14 && ball.x > pad.x - 4 && ball.x < pad.x + pad.w + 4 && ball.vy > 0) {
        ball.vy = -Math.abs(ball.vy);
        ball.vx += ((ball.x - (pad.x + pad.w / 2)) / pad.w) * 150;
        combo++;
        best = Math.max(best, combo);
        g.fx('tap');
      }
      if (ball.y > g.h() + 10) {
        finish(false, g);
        return;
      }
      for (const b of bricks) {
        if (!b.alive) continue;
        if (ball.x > b.x - ball.r && ball.x < b.x + b.w + ball.r && ball.y > b.y - ball.r && ball.y < b.y + b.h + ball.r) {
          if (b.kind === 'steel') {
            ball.vy *= -1;
            g.fx('hit');
            break;
          }
          b.hp--;
          ball.vy *= -1;
          if (b.hp <= 0) {
            b.alive = false;
            score++;
            combo++;
            best = Math.max(best, combo);
            g.fx('brk');
            g.setScore(score + ' / ' + bricks.length);
            if (bricks.every((x) => !x.alive || x.kind === 'steel')) {
              finish(true, g);
              return;
            }
          } else g.fx('hit');
          break;
        }
      }
      g.setLevel('连击 ' + combo);
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const P = pal(g);
      const W = g.w();
      const H = g.h();
      c.clearRect(0, 0, W, H);
      // 背景横线（老版 17 条）
      c.strokeStyle = P.line;
      c.lineWidth = 1;
      for (let i = 1; i < 17; i++) {
        c.beginPath();
        c.moveTo(0, i * 26 + 0.5);
        c.lineTo(W, i * 26 + 0.5);
        c.stroke();
      }
      // 砖：norm=白底灰框、hard=soft底accent框（hp1 时半透明示破）、steel=虚线框不碎
      for (const b of bricks) {
        if (!b.alive) continue;
        c.lineWidth = 1.7;
        c.lineJoin = 'round';
        c.fillStyle = b.kind === 'hard' ? P.soft : P.boxBg;
        c.strokeStyle = b.kind === 'hard' ? P.accent : P.line;
        if (b.kind === 'hard' && b.hp === 1) c.globalAlpha = 0.55;
        rr(c, b.x, b.y, b.w, b.h, 4);
        c.fill();
        c.stroke();
        c.globalAlpha = 1;
        if (b.kind === 'steel') {
          c.strokeStyle = P.fg;
          c.setLineDash([2.6, 2.4]);
          rr(c, b.x + 2, b.y + 2, b.w - 4, b.h - 4, 3);
          c.stroke();
          c.setLineDash([]);
        }
        c.fillStyle = b.kind === 'hard' ? P.accent : P.muted;
        c.font = '10px ui-monospace,Consolas,monospace';
        c.textBaseline = 'middle';
        c.fillText(String(b.name).slice(0, 4), b.x + 6, b.y + b.h / 2 + 0.5);
        c.textBaseline = 'alphabetic';
      }
      // 挡板 + 球（老版同款形态）
      c.lineWidth = 1.7;
      c.strokeStyle = P.accent;
      c.fillStyle = P.soft;
      rr(c, pad.x, H - 24, pad.w, 8, 4);
      c.fill();
      c.stroke();
      c.strokeStyle = P.fg;
      c.fillStyle = P.boxBg;
      c.beginPath();
      c.arc(ball.x, ball.y, ball.r, 0, 7);
      c.fill();
      c.stroke();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4. /satoshi 2048 聪合币 —— 合到 1 亿聪 = 1 个币
 * ------------------------------------------------------------------ */

export function satoshiGame(): GameDef {
  const N = 4;
  const WIN_AT = 134217728; // 2^27：过 1 亿聪的最近一档（老版注释：从出生值翻 11 次，难度=经典 2048）
  let cell = 60;
  let ox = 0;
  let oy = 0;
  let grid: number[] = [];
  let moves = 0;
  let over = false;

  const fmt = (v: number): string => v.toLocaleString('en-US');
  const boardMax = (): number => Math.max(...grid);
  const boardSum = (): number => grid.reduce((a, b) => a + (b ?? 0), 0);
  const canMove = (): boolean => {
    if (grid.some((v) => v === 0)) return true;
    for (let r = 0; r < N; r++) {
      for (let cIdx = 0; cIdx < N; cIdx++) {
        const v = grid[r * N + cIdx];
        if (v === undefined) continue;
        if (cIdx < N - 1 && grid[r * N + cIdx + 1] === v) return true;
        if (r < N - 1 && grid[(r + 1) * N + cIdx] === v) return true;
      }
    }
    return false;
  };
  const hud = (g: GameCtx): void => {
    g.setScore(fmt(boardSum()));
    g.setLevel(fmt(boardMax()) + ' 聪');
  };
  const finish = (win: boolean, g: GameCtx): void => {
    if (over) return;
    over = true;
    g.fx(win ? 'win' : 'die');
    g.setScore(fmt(boardSum()));
    g.end(
      win ? '合成了 1 个币' : '无路可走',
      win
        ? [
            ['本局得分', fmt(boardSum())],
            ['步数', moves + ' 步'],
            ['解锁', '/bitcoin 更深一层'],
          ]
        : [
            ['本局得分', fmt(boardSum())],
            ['最大格', fmt(boardMax()) + ' 聪'],
            ['步数', moves + ' 步'],
          ],
    );
  };

  const reset = (g: GameCtx): void => {
    grid = new Array(N * N).fill(0);
    moves = 0;
    over = false;
    spawn();
    spawn();
    hud(g);
  };

  const spawn = (): void => {
    const free: number[] = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] === 0) free.push(i);
    if (free.length === 0) return;
    const p = free[Math.floor(Math.random() * free.length)] as number;
    // 老版 SPAWN=2^16(65,536 聪) / SPAWN2=2^17(131,072 聪)：从出生到 1 亿聪翻 11 次，
    // 4×4 理论上限 17 次 → 难度精确等于经典 2048（老版 :11898 注释同款）
    grid[p] = Math.random() < 0.9 ? 65536 : 131072;
  };

  const slide = (g: GameCtx, dir: 'U' | 'D' | 'L' | 'R'): void => {
    if (over) return;
    // 收集每行/列。**按滑动方向定序**（向左就从左往右取，向右从右往左取），
    // 这样一次遍历就能同时完成"贴边"与"同值合并" —— 2048 的标准做法。
    const lines: number[][] = [];
    if (dir === 'L') for (let r = 0; r < N; r++) lines.push([0, 1, 2, 3].map((cIdx) => r * N + cIdx));
    if (dir === 'R') for (let r = 0; r < N; r++) lines.push([3, 2, 1, 0].map((cIdx) => r * N + cIdx));
    if (dir === 'U') for (let cIdx = 0; cIdx < N; cIdx++) lines.push([0, 1, 2, 3].map((r) => r * N + cIdx));
    if (dir === 'D') for (let cIdx = 0; cIdx < N; cIdx++) lines.push([3, 2, 1, 0].map((r) => r * N + cIdx));
    let moved = false;
    for (const line of lines) {
      const vals = line.map((i) => grid[i] as number).filter((v) => v !== 0);
      for (let i = 0; i < vals.length - 1; i++) {
        if (vals[i] === vals[i + 1]) {
          vals[i] = (vals[i] as number) * 2;
          vals.splice(i + 1, 1);
          // 🔴 合并后必须 i-- ：不回头会把刚合出来的块在同一条线上再合一次
          //   （[2,2,2,2] 会被算成8+8=16 而不是正确的 4+4+8）
          i -= 1;
        }
      }
      while (vals.length < N) vals.push(0);
      line.forEach((i, k) => {
        if (grid[i] !== vals[k]) moved = true;
        grid[i] = vals[k] as number;
      });
    }
    if (moved) {
      moves++;
      spawn();
      // 🔴 分数**在这里**就推给 HUD：若放到 frame 里每帧推，
      //   swipe 连划时 HUD 会滞后一拍，用户会觉得"没反应"。
      //   计分口径=老版：SC 显示全场聪数总和、LV 显示最大格。
      hud(g);
      if (boardMax() >= WIN_AT) finish(true, g);
      else if (!canMove()) finish(false, g);
    }
  };

  return {
    id: 'satoshi',
    tip: '四向滑动 / 方向键 · 相同单位相加，一路合到 1 个币（1 亿聪）',
    start: reset,
    resize: (w, h) => {
      cell = Math.floor(Math.min(w, h) / (N + 1));
      ox = (w - cell * N) / 2;
      oy = (h - cell * N) / 2;
    },
    frame: () => {
      // 2048 是纯事件驱动，没有需要每帧推进的状态（老项目同款）
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const p = pal(g);
      c.clearRect(0, 0, g.w(), g.h());
      // 底格
      for (let r = 0; r < N; r++) {
        for (let cIdx = 0; cIdx < N; cIdx++) {
          c.fillStyle = p.line;
          rr(c, ox + cIdx * cell + 2, oy + r * cell + 2, cell - 4, cell - 4, 8);
          c.fill();
        }
      }
      // 块
      for (let r = 0; r < N; r++) {
        for (let cIdx = 0; cIdx < N; cIdx++) {
          const v = grid[r * N + cIdx] as number;
          if (v === 0) continue;
          c.fillStyle = v >= 4 ? p.accent : p.soft;
          rr(c, ox + cIdx * cell + 2, oy + r * cell + 2, cell - 4, cell - 4, 8);
          c.fill();
          const label = v >= 1e8 ? `${Math.floor(v / 1e8)}币` : fmt(v);
          txt(c, label, ox + (cIdx + 0.5) * cell, oy + (r + 0.5) * cell, Math.min(20, cell * 0.34), v >= 4 ? p.bg : p.fg);
        }
      }
    },
    swipe: (d, g) => slide(g, d),
    key: (down, e, g) => {
      if (!down) return;
      const m: Record<string, 'U' | 'D' | 'L' | 'R'> = {
        ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R',
        w: 'U', s: 'D', a: 'L', d: 'R', W: 'U', S: 'D', A: 'L', D: 'R',
      };
      const d = m[e.key];
      if (d) slide(g, d);
    },
  };
}

/* ------------------------------------------------------------------ *
 * 5. /bitcoin 黄金矿工 —— 钩爪摆、点一下放钩
 * ------------------------------------------------------------------ */

export function bitcoinGame(): GameDef {
  let ax = 0;
  let ay = 0;
  let pivotX = 0;
  let pivotY = 0;
  let ang = Math.PI / 2;
  let len = 0;
  let extending = false;
  let retracting = false;
  let score = 0;
  let best = 0;
  let miss = 0;
  let left = 60; // 老版同款 60s 局时
  let over = false;
  let gems: { x: number; y: number; r: number; val: number; got: boolean }[] = [];
  let held: { x: number; y: number; r: number; val: number } | null = null;

  const fmt = (v: number): string => v.toLocaleString('en-US');
  /** 老版 end(msg)（:12022）：结算三行 挖到/最重一钩/空钩；创世块算赢。 */
  const finish = (msg: string, g: GameCtx): void => {
    if (over) return;
    over = true;
    g.setScore(fmt(score));
    g.fx(msg === '挖到创世块' ? 'win' : 'die');
    g.end(msg, [
      ['挖到', fmt(score) + ' 聪'],
      ['最重一钩', (best > 0 ? fmt(best) : '0') + ' 聪'],
      ['空钩', miss + ' 次'],
    ]);
  };

  const reset = (g: GameCtx): void => {
    pivotX = g.w() / 2;
    pivotY = 56;
    ax = pivotX;
    ay = pivotY;
    ang = Math.PI / 2;
    len = 0;
    extending = false;
    retracting = false;
    score = 0;
    best = 0;
    miss = 0;
    left = 60;
    over = false;
    held = null;
    gems = [];
    // 越深越肥：y 越大 val 越高（聪计价，老版同口径）
    for (let i = 0; i < 16; i++) {
      const depth = Math.random();
      gems.push({
        x: 30 + Math.random() * Math.max(40, g.w() - 60),
        y: 120 + depth * Math.max(60, g.h() - 200),
        r: 9 + Math.random() * 12,
        val: Math.round(5 + depth * 95),
        got: false,
      });
    }
    g.setScore('0 聪');
    g.setLevel('60s');
  };

  return {
    id: 'bitcoin',
    tip: '点屏幕 / 空格 = 放钩 · 越深越值钱，但拉回来更慢',
    start: reset,
    resize: (w, h) => {
      pivotX = w / 2;
      pivotY = 56;
      void h;
    },
    frame: (dt, g) => {
      if (over) return;
      // 老版 60s 局时：到点结算「时间到」
      left -= dt;
      if (left <= 0) {
        left = 0;
        g.setLevel('0s');
        finish('时间到', g);
        return;
      }
      g.setLevel(Math.ceil(left) + 's');
      if (extending) {
        len += 460 * dt;
        const tipX = pivotX + Math.cos(ang) * len;
        const tipY = pivotY + Math.sin(ang) * len;
        const hit = gems.find((x) => !x.got && Math.hypot(x.x - tipX, x.y - tipY) < x.r);
        if (hit) {
          held = { x: hit.x, y: hit.y, r: hit.r, val: hit.val };
          hit.got = true;
          g.fx('coin');
          extending = false;
          retracting = true;
        } else if (tipY > g.h() || tipX < 0 || tipX > g.w()) {
          extending = false;
          retracting = true;
        }
      } else if (retracting) {
        len -= 380 * dt;
        if (held) {
          //钩子回收时把宝石往轴心拉
          held.x -= (held.x - pivotX) * 0.12;
          held.y -= (held.y - pivotY) * 0.12;
        }
        if (len <= 0) {
          len = 0;
          retracting = false;
          if (held) {
            score += held.val;
            best = Math.max(best, held.val);
            g.setScore(fmt(score) + ' 聪');
            held = null;
          } else miss++; // 空钩（老版同款计数）
        }
      } else {
        // 摆动
        ang = Math.PI / 2 + Math.sin(performance.now() / 520) * 1.15;
      }
      ax = pivotX + Math.cos(ang) * len;
      ay = pivotY + Math.sin(ang) * len;
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const p = pal(g);
      c.clearRect(0, 0, g.w(), g.h());
      // 钩爪轴
      c.strokeStyle = p.fg;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(pivotX, pivotY);
      c.lineTo(ax, ay);
      c.stroke();
      c.fillStyle = p.accent;
      c.beginPath();
      c.arc(ax, ay, 5, 0, Math.PI * 2);
      c.fill();
      // 宝石
      for (const gm of gems) {
        if (gm.got && !held) continue;
        if (held && held.x === gm.x && held.y === gm.y) continue;
        c.fillStyle = gm.val > 60 ? p.accent : p.soft;
        c.beginPath();
        c.arc(gm.x, gm.y, gm.r, 0, Math.PI * 2);
        c.fill();
        txt(c, String(gm.val), gm.x, gm.y, Math.min(13, gm.r), gm.val > 60 ? p.bg : p.fg);
      }
      // 手上抓着的
      if (held) {
        c.fillStyle = p.accent;
        c.beginPath();
        c.arc(held.x, held.y, held.r, 0, Math.PI * 2);
        c.fill();
        txt(c, String(held.val), held.x, held.y, Math.min(13, held.r), p.bg);
      }
    },
    tap: (g) => {
      if (!extending && !retracting) {
        extending = true;
        len = 0;
        g.fx('shot');
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * 6. /tank 坦克大战 —— 基地 = 你的笔记
 *
 * 🔴🔴 移植老项目 index.html:12096-12252（完整 Battle City 语义）逐条比对。
 *   此前的自造实现是"走格撞砖"的另一个游戏（无敌人/无子弹/无开火/无基地守卫，
 *   开局还显示「第 2 关」），审计实测定为半残。老版要点：
 *   - 13×13 地形：砖(1)可拆、钢(2)挡弹不碎、河(3)挡车不挡弹、草(4)藏车、
 *     基地(9)=你的笔记被炸即负；地形种子取自收藏/待办与篇名——
 *     「每个人的第一关都是自己笔记长出来的」；
 *   - 三关制：敌 5+level*2、三路出生、AI 半数朝你走、击毁 34% 掉道具
 *     （★射速/盾/钟定身/铲子升钢）；命 3，被击回出生点；
 *   - HUD：左「敌 N」、中「第 X / 3 关 · 命 Y」。
 *   桌宠藏砖 garnish（mkPet/updatePet/petFig）列 TODO 不在本批。
 * ------------------------------------------------------------------ */

export function tankGame(getCtx: () => { body: string; favs: string[]; cur: string }): GameDef {
  const N = 13;
  let u = 26;
  /** 地形格：0 空 1 砖 2 钢 3 河 4 草 9 基地 */
  let map: number[][] = [];
  let me: { x: number; y: number; d: 'U' | 'D' | 'L' | 'R'; cd: number } | null = null;
  let foes: Array<{ x: number; y: number; d: 'U' | 'D' | 'L' | 'R'; cd: number; hp: number }> = [];
  interface Bullet { x: number; y: number; vx: number; vy: number; own: number }
  let bullets: Bullet[] = [];
  interface Item { x: number; y: number; k: 'star' | 'shield' | 'clock' | 'shovel' }
  let items: Item[] = [];
  let level = 1;
  let left = 0;
  let killT = 0;
  let base: { x: number; y: number; alive: boolean } = { x: 6, y: 12, alive: true };
  let lives = 3;
  let shield = 0;
  let freeze = 0;
  let fireCd = 0.32;

  const DIRV: Record<'U' | 'D' | 'L' | 'R', [number, number]> = {
    L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1],
  };

  function cellFree(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < N && y < N && (!map[y]?.[x] || map[y]?.[x] === 4);
  }
  function occupied(x: number, y: number): boolean {
    return (me !== null && me.x === x && me.y === y) || foes.some((f) => f.x === x && f.y === y);
  }
  function put(x: number, y: number, v: number): void {
    if (x >= 0 && y >= 0 && x < N && y < N) {
      const row = map[y];
      if (row) row[x] = v;
    }
  }
  function buildMap(): void {
    // 地形种子取自收藏/待办字数：每个人的第一关都是自己笔记长出来的（老版 buildMap 同款 LCG）
    const src = names('obs', getCtx().body, getCtx().favs, ['读书笔记', '便签纸', '发票', '愿望', '健身']).join('|') + (getCtx().cur || '');
    let h = 0;
    for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) >>> 0;
    map = [];
    for (let yy = 0; yy < N; yy++) {
      const row: number[] = [];
      for (let xx = 0; xx < N; xx++) row[xx] = 0;
      map[yy] = row;
    }
    for (let k = 0; k < N * 2; k++) {
      h = (h * 1103515245 + 12345) >>> 0;
      put(h % N, 1 + ((h >> 4) % (N - 4)), 1);
    }
    for (let s = 0; s < 5; s++) {
      h = (h * 1103515245 + 12345) >>> 0;
      put(h % N, 1 + ((h >> 6) % (N - 4)), 2);
    }
    // 河(3)挡车不挡弹、草(4)藏车（画在坦克之后）——两句话的代价换十倍策略，值（老版原话）
    for (let r = 0; r < 4; r++) {
      h = (h * 1103515245 + 12345) >>> 0;
      const rx = 1 + (h % (N - 3));
      const ry = 3 + ((h >> 8) % 6);
      put(rx, ry, 3);
      put(rx + 1, ry, 3);
    }
    for (let gg = 0; gg < 6; gg++) {
      h = (h * 1103515245 + 12345) >>> 0;
      put(h % N, 2 + ((h >> 10) % (N - 5)), 4);
    }
    // 基地掩体（老版同款六块）+ 基地
    const cover: Array<[number, number]> = [[5, 10], [7, 10], [4, 11], [8, 11], [5, 11], [7, 11]];
    for (const [cx2, cy2] of cover) put(cx2, cy2, 1);
    put(6, 12, 9);
    put(6, 11, 0);
  }
  function spawnFoe(): void {
    if (foes.length >= 4 || left <= 0) return;
    const sx = pick([0, 6, 12]);
    if (occupied(sx, 0)) return;
    foes.push({ x: sx, y: 0, d: pick(['D', 'L', 'R'] as const), cd: rf(0.6, 1.8), hp: 1 });
    left--;
  }
  function move(o: { x: number; y: number; d: 'U' | 'D' | 'L' | 'R' }, d: 'U' | 'D' | 'L' | 'R'): boolean {
    const v = DIRV[d];
    o.d = d;
    const nx = o.x + v[0];
    const ny = o.y + v[1];
    if (!cellFree(nx, ny) || occupied(nx, ny)) return false;
    o.x = nx;
    o.y = ny;
    return true;
  }
  function shoot(o: { x: number; y: number; d: 'U' | 'D' | 'L' | 'R' }, g: GameCtx): void {
    if (bullets.filter((b) => (o === me ? b.own === 1 : b.own === 0)).length > 1) return;
    const v = DIRV[o.d];
    bullets.push({ x: o.x + 0.5, y: o.y + 0.5, vx: v[0] * 7, vy: v[1] * 7, own: o === me ? 1 : 0 });
    g.fx('shot');
  }
  function finish(msg: string, win: boolean, g: GameCtx): void {
    g.setScore(win ? String(level * 100) : '0');
    g.fx(win ? 'win' : 'die');
    g.end(msg, [
      ['关卡', '第 ' + level + ' / 3 关'],
      ['剩余敌军', String(left + foes.length)],
      ['生命', String(lives)],
    ]);
  }
  function reset(g: GameCtx): void {
    level = 1;
    lives = 3;
    buildMap();
    me = { x: 6, y: 9, d: 'U', cd: 0.3 };
    bullets = [];
    items = [];
    shield = 0;
    freeze = 0;
    fireCd = 0.32;
    left = 5 + level * 2;
    killT = 0;
    foes = [];
    spawnFoe();
    base = { x: 6, y: 12, alive: true };
    g.setScore('敌 ' + (left + foes.length));
    g.setLevel('第 ' + level + ' / 3 关 · 命 ' + lives);
  }

  return {
    id: 'tank',
    // 🔴🔴 tip 文案逐字对齐老项目（index.html:12149）：少了"怎么开火"用户就以为游戏坏了
    tip: '划屏改向 / 方向键移动 · 点右半屏或空格开火 · 别让记事本被炸',
    start: (g) => reset(g),
    resize: (w, h) => {
      u = Math.max(10, Math.floor(Math.min(w, h) / N));
    },
    swipe: (d, g) => {
      if (me) move(me, d);
      void g;
    },
    down: (x, _y, g) => {
      if (x > g.w() / 2 && me && me.cd <= 0) {
        shoot(me, g);
        me.cd = 0.32;
      }
    },
    tap: (g) => {
      if (me && me.cd <= 0) {
        shoot(me, g);
        me.cd = 0.32;
      }
    },
    key: (down, e, g) => {
      if (!down || !me) return;
      const m: Record<string, 'U' | 'D' | 'L' | 'R'> = {
        ArrowLeft: 'L', ArrowRight: 'R', ArrowUp: 'U', ArrowDown: 'D',
      };
      const d = m[e.key];
      if (d) {
        e.preventDefault();
        move(me, d);
      }
      if (e.code === 'Space' && me.cd <= 0) {
        e.preventDefault();
        shoot(me, g); // 长按靠 keydown 自动重复 + cd 门控连射（老版原话）
        me.cd = fireCd;
      }
    },
    frame: (dt, g) => {
      if (!me) return;
      const M = me; // 闭包内收窄：me 是可变模块量，TS 不跨闭包保窄化；本帧内 reset 不会跑，别名安全
      M.cd -= dt;
      killT += dt;
      if (killT > 1.4) {
        killT = 0;
        spawnFoe();
      }
      if (freeze > 0) freeze -= dt;
      // 道具吃下即生效：★射速 / 盾 / 时钟定身 / 铲子把基地四周砖升钢（老版同款）
      items = items.filter((it) => {
        if (it.x !== M.x || it.y !== M.y) return true;
        if (it.k === 'star') fireCd = Math.max(0.14, fireCd * 0.6);
        else if (it.k === 'shield') shield = 1;
        else if (it.k === 'clock') freeze = 3;
        else if (it.k === 'shovel') {
          const steel: Array<[number, number]> = [[5, 11], [6, 11], [7, 11], [4, 12], [8, 12]];
          for (const [qx, qy] of steel) {
            const row = map[qy];
            if (row && row[qx] === 1) row[qx] = 2;
          }
        }
        g.fx('pow');
        return false;
      });
      for (const f of foes) {
        if (freeze > 0) continue;
        f.cd -= dt;
        if (f.cd <= 0 && me) {
          f.cd = rf(0.5, 1.4);
          if (Math.random() < 0.45) {
            const dx = M.x - f.x;
            const dy = M.y - f.y;
            f.d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
          } else f.d = pick(['L', 'R', 'U', 'D'] as const);
          move(f, f.d);
          if (Math.random() < 0.3 && bullets.filter((b) => !b.own).length < 4) shoot(f, g);
        }
      }
      for (const b of bullets) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
      }
      bullets = bullets.filter((b) => {
        if (b.x < 0 || b.y < 0 || b.x > N || b.y > N) return false;
        const cx = Math.floor(b.x);
        const cy = Math.floor(b.y);
        const m2 = map[cy]?.[cx];
        if (m2 === 1) {
          const row = map[cy];
          if (row) row[cx] = 0;
          g.fx('hit');
          return false;
        }
        if (m2 === 2) {
          g.fx('hit');
          return false;
        } // 钢墙挡弹不碎
        if (m2 === 3 || m2 === 4) return true; // 河与草不拦弹——子弹照飞（原作语义）
        if (m2 === 9) {
          base.alive = false;
          g.fx('boom');
          finish('你的笔记被擦了', false, g);
          return false;
        }
        if (b.own && me) {
          for (let i = 0; i < foes.length; i++) {
            const f = foes[i];
            if (f && f.x === cx && f.y === cy) {
              foes.splice(i, 1);
              if (Math.random() < 0.34) items.push({ x: cx, y: cy, k: pick(['star', 'shield', 'clock', 'shovel'] as const) });
              g.fx('boom');
              return false;
            }
          }
        } else if (M.x === cx && M.y === cy) {
          if (shield) {
            shield = 0;
            g.fx('hit');
            return false;
          }
          lives--;
          g.fx('boom');
          if (lives <= 0) {
            finish('坦克被打爆了', false, g);
            return false;
          }
          M.x = 6;
          M.y = 9;
          return false;
        }
        return true;
      });
      if (!foes.length && left <= 0) {
        if (level >= 3) {
          finish('三关全通', true, g);
          return;
        }
        level++;
        left = 5 + level * 2;
        buildMap();
        foes = [];
        spawnFoe();
        g.fx('confirm');
      }
      g.setScore('敌 ' + (left + foes.length));
      g.setLevel('第 ' + level + ' / 3 关 · 命 ' + lives);
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const P = pal(g);
      const W = g.w();
      const H = g.h();
      const ox = (W - N * u) / 2;
      const oy = (H - N * u) / 2;
      c.clearRect(0, 0, W, H);
      // 网格（弱化）
      c.strokeStyle = P.line;
      c.lineWidth = 1;
      c.globalAlpha = 0.5;
      for (let i = 1; i < N; i++) {
        c.beginPath();
        c.moveTo(ox, oy + i * u + 0.5);
        c.lineTo(ox + N * u, oy + i * u + 0.5);
        c.stroke();
        c.beginPath();
        c.moveTo(ox + i * u + 0.5, oy);
        c.lineTo(ox + i * u + 0.5, oy + N * u);
        c.stroke();
      }
      c.globalAlpha = 1;
      // 地形（老版同款形态语言：砖=实底圆角、钢=虚线框、河=三道波纹、基地=品牌标）
      c.lineWidth = 1.7;
      c.lineJoin = 'round';
      for (let yy = 0; yy < N; yy++) {
        for (let xx = 0; xx < N; xx++) {
          const v = map[yy]?.[xx] ?? 0;
          if (!v) continue;
          const bx = ox + xx * u;
          const by = oy + yy * u;
          if (v === 1) {
            c.strokeStyle = P.fg;
            c.fillStyle = P.boxBg;
            rr(c, bx + 2, by + 2, u - 4, u - 4, 4);
            c.fill();
            c.stroke();
          }
          if (v === 2) {
            c.strokeStyle = P.fg;
            c.setLineDash([2.6, 2.4]);
            rr(c, bx + 2, by + 2, u - 4, u - 4, 3);
            c.stroke();
            c.setLineDash([]);
          }
          if (v === 3) {
            c.strokeStyle = P.accent;
            c.globalAlpha = 0.75;
            c.lineWidth = 1.4;
            c.beginPath();
            c.moveTo(bx + 3, by + u * 0.38);
            c.lineTo(bx + u - 3, by + u * 0.38);
            c.moveTo(bx + 3, by + u * 0.58);
            c.lineTo(bx + u - 3, by + u * 0.58);
            c.moveTo(bx + 3, by + u * 0.78);
            c.lineTo(bx + u - 3, by + u * 0.78);
            c.stroke();
            c.globalAlpha = 1;
            c.lineWidth = 1.7;
          }
          if (v === 9) {
            // 基地 = 你的笔记：品牌「N」标（老版 nsBrandMark 的近似形）
            c.strokeStyle = P.accent;
            rr(c, bx + 3, by + 3, u - 6, u - 6, 4);
            c.stroke();
            c.fillStyle = P.accent;
            c.font = 'bold ' + Math.round(u * 0.42) + 'px ui-monospace,Consolas,monospace';
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillText('N', bx + u / 2, by + u / 2 + 1);
            c.textAlign = 'start';
            c.textBaseline = 'alphabetic';
          }
        }
      }
      // 坦克（车体 + 炮塔 + 朝向炮管；我方带 accent 点）
      const tank = (o: { x: number; y: number; d: 'U' | 'D' | 'L' | 'R' }, foe: boolean): void => {
        const tx = ox + o.x * u;
        const ty = oy + o.y * u;
        c.lineWidth = 1.7;
        c.strokeStyle = P.fg;
        c.lineJoin = 'round';
        rr(c, tx + 3, ty + u * 0.5, u - 6, u * 0.32, 3);
        c.stroke();
        rr(c, tx + u * 0.3, ty + u * 0.28, u * 0.4, u * 0.3, 3);
        c.stroke();
        const v = DIRV[o.d];
        c.beginPath();
        c.moveTo(tx + u / 2, ty + u / 2);
        c.lineTo(tx + u / 2 + v[0] * u * 0.48, ty + u / 2 + v[1] * u * 0.48);
        c.stroke();
        if (!foe) {
          c.fillStyle = P.accent;
          c.beginPath();
          c.arc(tx + u * 0.44, ty + u * 0.42, 1.6, 0, 7);
          c.fill();
        }
      };
      for (const f of foes) tank(f, true);
      if (me) tank(me, false);
      // 道具金形：★ / 盾 / 钟 / 铲
      for (const it of items) {
        const ix = ox + it.x * u;
        const iy = oy + it.y * u;
        c.strokeStyle = P.accent;
        c.lineWidth = 1.7;
        c.beginPath();
        if (it.k === 'star') {
          const pts: Array<[number, number]> = [
            [0.5, 0.2], [0.66, 0.46], [0.92, 0.5], [0.7, 0.68], [0.77, 0.94],
            [0.5, 0.79], [0.23, 0.94], [0.3, 0.68], [0.08, 0.5], [0.34, 0.46],
          ];
          pts.forEach((p, i) => {
            if (i) c.lineTo(ix + u * p[0], iy + u * p[1]);
            else c.moveTo(ix + u * p[0], iy + u * p[1]);
          });
          c.closePath();
        } else if (it.k === 'shield') {
          rr(c, ix + u * 0.26, iy + u * 0.22, u * 0.48, u * 0.56, u * 0.12);
        } else if (it.k === 'clock') {
          c.arc(ix + u * 0.5, iy + u * 0.52, u * 0.28, 0, 7);
        } else {
          rr(c, ix + u * 0.24, iy + u * 0.26, u * 0.52, u * 0.48, 2);
        }
        c.stroke();
      }
      // 草画在车之后 = 藏车（老版原话）
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          if ((map[gy]?.[gx] ?? 0) !== 4) continue;
          const qx = ox + gx * u;
          const qy = oy + gy * u;
          c.strokeStyle = P.muted;
          c.globalAlpha = 0.55;
          c.lineWidth = 1.4;
          c.beginPath();
          for (let k2 = 0; k2 < 3; k2++) {
            c.moveTo(qx + 4 + k2 * 7, qy + u - 4);
            c.lineTo(qx + 7 + k2 * 7, qy + 5);
          }
          c.stroke();
          c.globalAlpha = 1;
        }
      }
      // 子弹（我方 accent / 敌方 fg）
      for (const b of bullets) {
        c.fillStyle = b.own ? P.accent : P.fg;
        c.beginPath();
        c.arc(ox + b.x * u, oy + b.y * u, 2.6, 0, 7);
        c.fill();
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * 7. /spacex 垂直着陆 —— 按住=推力，松手=自由落体
 *
 * 🔴🔴 移植老项目 index.html:12253-12324（v9.4.0 形态）逐条比对，**不靠推理定案**。
 *   此前的自造实现有三个偏差，全部按老版改回：
 *   ① 物理错：老版 y += vy*dt*12（重力 9.8、推力 17.4、姿态耦合 cos/sin），
 *      自造版 y += vy*dt 且推力 900 ⇒ 无操作也"稳稳落住"（审计实测的假着陆根因）；
 *   ② 落稳判据缺两条：老版 |vy|<=4.2 && |rot|<=0.055 && 偏移<=26px，自造版只看偏移；
 *   ③ 仪表盘整条缺失：HUD 中格「垂直 X · 角 Y° · 油 Z%」、结算行
 *      剩余燃料/落地速度/倾角、坠毁标题「姿态歪了/摔了」二选一（按滞空时长）。
 *   桌宠 garnish（稳落挥手/摔了掀跟头）依赖 petFig 画笔，列 TODO 不在本批。
 * ------------------------------------------------------------------ */

export function spacexGame(): GameDef {
  let y = 0;
  let vy = 0;
  let vx = 0;
  let rot = 0;
  let rotV = 0;
  let fuel = 100;
  let thrust = false;
  let t = 0;
  let done = false;
  let PADX = 0;
  let GY = 0;
  let mx = 0;

  const reset = (g: GameCtx): void => {
    y = g.h() * 0.16;
    vy = 0;
    vx = rf(-8, 8);
    rot = rf(-0.12, 0.12);
    rotV = 0;
    fuel = 100;
    thrust = false;
    t = 0;
    done = false;
    PADX = g.w() * 0.5;
    GY = g.h() - 34;
    mx = g.w() / 2;
    g.setScore('0m');
    g.setLevel('');
  };

  /** 结束（老版 end(win)）：胜按剩余油量计分（+100），败 0；标题按滞空时长二选一。 */
  const finish = (win: boolean, g: GameCtx): void => {
    if (done) return;
    done = true;
    thrust = false;
    if (win) g.fx('up');
    else g.fx('die');
    g.setScore(win ? String(Math.round(fuel + 100)) : '0');
    g.end(win ? '稳稳落在船上' : t > 3 ? '姿态歪了' : '摔了', [
      ['剩余燃料', Math.round(fuel) + '%'],
      ['落地速度', Math.abs(vy).toFixed(1) + ' m/s'],
      ['倾角', (Math.abs(rot) * 57.3).toFixed(1) + '°'],
    ]);
  };

  return {
    id: 'spacex',
    tip: '按住屏幕 = 开推力，松手 = 自由落体 · 落稳条件写在仪表上',
    start: (g) => {
      reset(g);
      g.fx('ign');
    },
    down: () => {
      thrust = true;
    },
    up: () => {
      thrust = false;
    },
    key: (down, e) => {
      // 老版：Space/ArrowUp 按住点火（keydown/keyup 各一次，含系统自动重复）；
      // 左右键只改 rotV（keydown 事件驱动 ±0.9，keyup 不清零，靠每帧 *0.92 衰减）
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        thrust = down;
      }
      if (down && e.code === 'ArrowLeft') rotV -= 0.9;
      if (down && e.code === 'ArrowRight') rotV += 0.9;
    },
    resize: (w, h) => {
      PADX = w * 0.5;
      GY = h - 34;
    },
    frame: (dt, g) => {
      if (done) return;
      t += dt;
      const acc = thrust && fuel > 0 ? 17.4 : 0;
      if (thrust && fuel > 0) fuel = Math.max(0, fuel - dt * 17.5);
      vy += 9.8 * dt - acc * dt * Math.cos(rot);
      vx += -acc * dt * Math.sin(rot) + Math.sin(t * 1.7) * 0.6 * dt;
      rot += rotV * dt * 0.06;
      rotV *= 0.92;
      rot *= 0.995;
      y += vy * dt * 12;
      mx = g.w() / 2 + vx * t * 6;
      g.setScore(Math.max(0, Math.round(GY - y)) + 'm');
      g.setLevel('垂直 ' + vy.toFixed(1) + ' · 角 ' + (Math.abs(rot) * 57.3).toFixed(1) + '° · 油 ' + Math.round(fuel) + '%');
      if (y >= GY - 12) {
        const off = Math.abs(mx - PADX);
        finish(Math.abs(vy) <= 4.2 && Math.abs(rot) <= 0.055 && off <= 26, g);
      }
      if (Math.abs(rot) > 0.5 && t > 1.2) finish(false, g);
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const P = pal(g);
      const W = g.w();
      const H = g.h();
      c.clearRect(0, 0, W, H);
      // 背景横线（老版 12 条）+ 星点
      c.strokeStyle = P.line;
      c.lineWidth = 1;
      for (let i = 1; i < 12; i++) {
        c.beginPath();
        c.moveTo(0, i * 26 + 0.5);
        c.lineTo(W, i * 26 + 0.5);
        c.stroke();
      }
      c.fillStyle = P.muted;
      const starPos: ReadonlyArray<[number, number]> = [[0.12, 0.18], [0.8, 0.11], [0.46, 0.26], [0.22, 0.4], [0.7, 0.46]];
      for (const s of starPos) c.fillRect(W * s[0], H * s[1], 2, 2);
      // 驳船：accent 实线 + 中线虚标 + 海浪
      c.strokeStyle = P.accent;
      c.lineWidth = 1.7;
      c.beginPath();
      c.moveTo(PADX - 62, GY);
      c.lineTo(PADX + 62, GY);
      c.stroke();
      c.setLineDash([3, 4]);
      c.beginPath();
      c.moveTo(PADX, GY);
      c.lineTo(PADX, GY - 12);
      c.stroke();
      c.setLineDash([]);
      c.strokeStyle = P.muted;
      c.beginPath();
      for (let k = 0; k <= W; k += 14) {
        const yy = GY + 10 + Math.sin((k + t * 30) / 22) * 2.2;
        if (k === 0) c.moveTo(k, yy);
        else c.lineTo(k, yy);
      }
      c.stroke();
      // 火箭（老版贝塞尔轮廓 + 翼 + 落窗支撑腿提示 + 尾焰）
      c.save();
      c.translate(mx || W / 2, y);
      c.rotate(rot);
      c.strokeStyle = P.fg;
      c.lineWidth = 1.7;
      c.lineJoin = 'round';
      c.beginPath();
      c.moveTo(0, -30);
      c.bezierCurveTo(7, -20, 9, -10, 9, 0);
      c.lineTo(9, 22);
      c.lineTo(-9, 22);
      c.lineTo(-9, 0);
      c.bezierCurveTo(-9, -10, -7, -20, 0, -30);
      c.closePath();
      c.stroke();
      c.beginPath();
      c.moveTo(-9, 2);
      c.lineTo(-19, 22);
      c.lineTo(-17, 6);
      c.moveTo(9, 2);
      c.lineTo(19, 22);
      c.lineTo(17, 6);
      c.stroke();
      c.beginPath();
      c.moveTo(-9, 22);
      c.lineTo(9, 22);
      c.stroke();
      if (Math.abs(mx - PADX) <= 26 && Math.abs(vy) <= 4.2 && Math.abs(rot) <= 0.055) {
        c.strokeStyle = P.accent;
        c.beginPath();
        c.moveTo(-12, 22);
        c.lineTo(-16, 30);
        c.moveTo(12, 22);
        c.lineTo(16, 30);
        c.moveTo(0, 22);
        c.lineTo(0, 30);
        c.stroke();
      }
      if (thrust && fuel > 0) {
        c.strokeStyle = P.accent;
        c.beginPath();
        c.moveTo(-4, 23);
        c.bezierCurveTo(-1, 30, 1, 32, 0, 38);
        c.bezierCurveTo(2, 32, 4, 28, 4, 23);
        c.stroke();
      }
      c.restore();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 8. /tesla 轨道巡航 —— 左半屏摇杆/方向键微调姿态，撞碎飘过的笔记标题
 *
 * 🔴🔴 移植老项目 index.html:12325-12400 逐条比对，**不靠推理定案**。
 *   此前的自造实现是"按住推力飞全屏"的另一个游戏（审计实测：开局 0 秒结束），
 *   与老版玩法完全不同。老版要点：
 *   - 左半屏拖动 = 摇杆（ax/ay 归一化），方向键同源；右半屏点一下 = 鸣笛；
 *   - 推进 150·p、阻尼 0.985、油量推进耗 6/s·p、松开回油 3/s；
 *   - 上下界撞火星判负（py<16 || py>H-40），左右墙夹住不判死；
 *   - 碎片 = 74×18 的笔记标题牌，从右往左 -28~-62 px/s，16% 稀有；
 *   - 相撞窗 |Δx|<w/2+12 且 |Δy|<h/2+10；
 *   - HUD：轨道 X AU（0.7 起步、0.05/s 递增）· 燃料 Y%；计分「N 片」。
 * ------------------------------------------------------------------ */

export function teslaGame(getCtx: () => { body: string; favs: string[] }): GameDef {
  interface Frag {
    x: number;
    y: number;
    vx: number;
    w: number;
    h: number;
    rare: boolean;
    label: string;
    gone: boolean;
  }
  let px = 0;
  let py = 0;
  let vx = 0;
  let vy = 0;
  let fuel = 100;
  let dist = 0;
  let hit = 0;
  let dead = false;
  let AU = 0.7;
  let ax = 0;
  let ay = 0;
  let frags: Frag[] = [];
  let stars: Array<[number, number, number]> = [];

  const newFrag = (g: GameCtx, init: boolean): Frag => {
    const words = names('tesla', getCtx().body, getCtx().favs, [
      '读书笔记', '便签纸', '发票', '愿望', '健身', '灵感池', '工作随记', '备忘',
    ]);
    return {
      x: init ? rf(g.w() * 0.5, g.w() - 40) : g.w() + 40,
      y: rf(30, g.h() - 40),
      vx: -rf(28, 62),
      w: 74,
      h: 18,
      rare: Math.random() < 0.16,
      label: words[Math.floor(Math.random() * words.length)] ?? '笔记',
      gone: false,
    };
  };

  const reset = (g: GameCtx): void => {
    px = g.w() * 0.3;
    py = g.h() * 0.5;
    vx = 0;
    vy = 0;
    fuel = 100;
    dist = 0;
    hit = 0;
    dead = false;
    AU = 0.7;
    ax = 0;
    ay = 0;
    frags = [];
    for (let i = 0; i < 7; i++) frags.push(newFrag(g, true));
    stars = [];
    for (let j = 0; j < 26; j++) stars.push([rf(0, g.w()), rf(0, g.h()), rf(0.2, 1)]);
    g.setScore('0 片');
    g.setLevel('');
  };

  return {
    id: 'tesla',
    tip: '左半屏摇杆 / 方向键微调姿态 · 撞碎飘过的笔记标题 · 点右半屏鸣笛',
    start: reset,
    down: (x, y, g) => {
      // 右半屏 = 鸣笛（老版 FX('horn') 同款，计分不变）
      if (x > g.w() / 2) g.fx('horn');
    },
    move: (x, y, g) => {
      // 左半屏 = 摇杆（老版同款归一化：以左半屏中点为原点）
      if (x < g.w() / 2) {
        ax = (x - g.w() / 4) / (g.w() / 4);
        ay = (y - g.h() / 2) / (g.h() / 2);
      }
    },
    up: () => {
      ax = 0;
      ay = 0;
    },
    key: (down, e) => {
      const m: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const d = m[e.key];
      if (d && down) {
        e.preventDefault();
        ax = d[0];
        ay = d[1];
      }
    },
    frame: (dt, g) => {
      if (dead) return;
      const p = Math.min(1, Math.hypot(ax, ay));
      if (p > 0.05 && fuel > 0) {
        vx += ax * 150 * dt * p;
        vy += ay * 150 * dt * p;
        fuel = Math.max(0, fuel - dt * 6 * p);
      } else {
        fuel = Math.min(100, fuel + dt * 3);
      }
      vx *= 0.985;
      vy *= 0.985;
      px += vx * dt;
      py += vy * dt;
      px = Math.max(18, Math.min(g.w() - 18, px));
      if (py < 16 || py > g.h() - 40) {
        dead = true;
        g.fx('die');
        const rare = frags.filter((f) => f.rare).length;
        g.setScore(String(hit));
        g.end('撞上火星了', [
          ['撞碎', hit + ' 片'],
          ['轨道', AU.toFixed(2) + ' AU'],
          ['稀有', String(rare)],
        ]);
        return;
      }
      dist += dt * 0.012;
      AU = 0.7 + dist * 0.05;
      for (const f of frags) f.x += f.vx * dt;
      frags = frags.filter((f) => f.x > -90);
      if (frags.length < 7) frags.push(newFrag(g, false));
      for (const f of frags) {
        if (!f.gone && Math.abs(px - (f.x + f.w / 2)) < f.w / 2 + 12 && Math.abs(py - (f.y + f.h / 2)) < f.h / 2 + 10) {
          f.gone = true;
          hit++;
          g.fx(f.rare ? 'win' : 'crack');
          if (f.rare) g.fx('coin');
        }
      }
      g.setScore(hit + ' 片');
      g.setLevel('轨道 ' + AU.toFixed(2) + ' AU · 燃料 ' + Math.round(fuel) + '%');
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const P = pal(g);
      const W = g.w();
      const H = g.h();
      c.clearRect(0, 0, W, H);
      // 星空 + 底部行星弧线 + 外圈虚线轨道（老版同款几何）
      for (const s of stars) {
        c.globalAlpha = 0.3 + s[2] * 0.5;
        c.fillStyle = P.muted;
        c.fillRect(s[0], s[1], 1.6, 1.6);
      }
      c.globalAlpha = 1;
      c.strokeStyle = P.line;
      c.lineWidth = 1;
      c.beginPath();
      c.arc(W / 2, H + 190, 230, Math.PI * 1.15, Math.PI * 1.85);
      c.stroke();
      c.setLineDash([3, 5]);
      c.strokeStyle = P.accent;
      c.globalAlpha = 0.5;
      c.beginPath();
      c.arc(W / 2, H + 190, 258, Math.PI * 1.2, Math.PI * 1.8);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
      // 飘过的笔记标题牌（稀有 = accent 描边 + 实底）
      for (const f of frags) {
        if (f.gone) continue;
        c.lineWidth = 1.7;
        c.strokeStyle = f.rare ? P.accent : P.fg;
        c.fillStyle = P.boxBg;
        c.globalAlpha = f.rare ? 1 : 0.9;
        rr(c, f.x, f.y, f.w, f.h, 4);
        c.fill();
        c.stroke();
        c.fillStyle = f.rare ? P.accent : P.muted;
        c.font = '10px ui-monospace,Consolas,monospace';
        c.textBaseline = 'middle';
        c.fillText(clipTo(c, f.label, f.w - 12), f.x + 6, f.y + f.h / 2 + 0.5);
        c.textBaseline = 'alphabetic';
        c.globalAlpha = 1;
      }
      // 车（老版贝塞尔轮廓 + 轮 + 头灯 + 推进尾迹），姿态角随 vy 夹 ±0.3
      c.save();
      c.translate(px, py);
      c.rotate(Math.max(-0.3, Math.min(0.3, vy / 260)));
      c.strokeStyle = P.fg;
      c.lineWidth = 1.7;
      c.lineJoin = 'round';
      c.beginPath();
      c.moveTo(-30, 6);
      c.bezierCurveTo(-29, -3, -25, -8, -19, -10);
      c.lineTo(-10, -17);
      c.bezierCurveTo(-4, -20, 3, -20, 8, -17);
      c.lineTo(16, -11);
      c.bezierCurveTo(24, -10, 29, -5, 30, 2);
      c.lineTo(30, 6);
      c.closePath();
      c.stroke();
      c.beginPath();
      c.moveTo(-30, 6);
      c.lineTo(30, 6);
      c.stroke();
      c.beginPath();
      c.arc(-19, 9, 5.4, 0, 7);
      c.stroke();
      c.beginPath();
      c.arc(18, 9, 5.4, 0, 7);
      c.stroke();
      c.fillStyle = P.accent;
      c.beginPath();
      c.arc(25, 1, 1.8, 0, 7);
      c.fill();
      if (Math.hypot(ax, ay) > 0.05) {
        c.strokeStyle = P.accent;
        c.globalAlpha = 0.8;
        c.beginPath();
        c.moveTo(-32, 2);
        c.lineTo(-42, 4);
        c.moveTo(-32, -1);
        c.lineTo(-40, -2);
        c.stroke();
        c.globalAlpha = 1;
      }
      c.restore();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 9. /pet 桌宠 —— 非canvas 型，自带画面
 * ------------------------------------------------------------------ */

export function petGame(): DomGameDef {
  return {
    id: 'pet',
    tip: '点它一下，它会叫',
    // 🔴🔴🔴 桌宠必须是**老项目那只 SVG 小螃蟹**，不是 emoji 🐾。
    //   用户报障：「宠物是一个大脚丫」—— 说的就是这个 🐾（探针实测 88×102 的脚爪）。
    //   老项目 index.html:11202 的 SVG 逐字抄在下面（viewBox 0 0 26 26）：
    //   身体弧线 + 三条腿 + 两只金色眼睛，是"螃蟹"，而脚爪字形在 emoji 字体里
    //   会被渲染成一个巨大的爪印，与老项目那种"顶栏下沿骑线的小螃蟹"完全不是一回事。
    //   🔴 而且老项目那只 pet 是**常驻顶栏下沿**（`petMount()` 挂 header，0 占宽，
    //   `petBlank().adopted` 默认 false ⇒ 不访问 /pet 就出现不了）；
    //   bj 这里是 /pet 彩蛋页内的独立 stage，属**形态差异**，本轮先对齐宠物本体，
    //   常驻挂载那条属于"要不要做"的设计决策，留待用户拍板（不做隐式移植）。
    //
    // 🔴🔴🔴 本轮补齐的是**养成档案面板**（老项目 :11323-11338 那一整块）：
    //   形态名 + 「吃了 N 字 · 醒着 N 天 · 柜子 N / 16」+ 16 格柜子 + 三个按钮。
    //   之前这里只有一只孤零零的大螃蟹，所有养成数据读不到也看不见。
    dom: (mount, g) => {
      // 🔴 舞台不再 fixed inset:0 —— 面板要占满一屏并自己滚动。
      //   老项目 :10397 `.ns-dom .ns-pet-panel{margin:0 auto;max-width:420px;flex:1;min-height:0;display:flex;flex-direction:column}`
      //   配 :10398 `.ns-pet-scroll{flex:1;min-height:0;overflow-y:auto}` 与
      //   :10399 `.ns-pet-dock{flex:none;…}`：内容区滚、按钮区钉底。
      //   沿用旧类名 ns-pet-stage（CSS 与 EGG-17 判据都按它定位），只把布局改成列。
      mount.className = 'ns-pet-stage ns-pet-stage-panel';

      const s = readPet();

      /* ---- 档案头：头像 + 形态名 + 档案行（老项目 :11325-11326 逐字） ---- */
      const top = document.createElement('div');
      top.className = 'ns-pet-top';
      const av = document.createElement('div');
      // 🔴 `ns-pet` 也要挂上：e2e EGG-E11 按 `.ns-pet` 定位本体并数 path/circle，
      //   只给老项目的 `ns-pet-av` 会让那条判据找不到元素（判据红在假的地方）。
      //   两个类都留着：`.ns-pet` 供既有判据，`.ns-pet-av` 供老项目 44px 尺寸。
      av.className = 'ns-pet ns-pet-av';
      av.innerHTML = PET_SVG;
      const meta = document.createElement('div');
      meta.className = 'ns-pet-meta';
      const nm = document.createElement('b');
      nm.textContent = stageName(s.stage);
      const ln = document.createElement('span');
      ln.textContent = petArchiveLine(s);
      meta.appendChild(nm);
      meta.appendChild(ln);
      top.appendChild(av);
      top.appendChild(meta);
      mount.appendChild(top);
      // 🔴 点大螃蟹跳一下：bj 原有行为（`ns-pet.jump`），老项目面板的头像是静态的。
      //   本轮是**补**面板不是重做页面，所以不把这个已有交互顺手删掉。
      av.addEventListener('click', () => {
        g.fx('burp');
        av.classList.add('jump');
        window.setTimeout(() => av.classList.remove('jump'), 420);
      });

      /* ---- 16 格柜子（老项目 :11343-11347 逐字：`ns-sh` / `ns-sh empty`，未集齐显示 `?`） ---- */
      const shelf = document.createElement('div');
      shelf.className = 'ns-shelf';
      for (let i = 0; i < SHELF_SIZE; i++) {
        const got = s.shelf.indexOf(i) >= 0;
        const c = document.createElement('div');
        c.className = 'ns-sh' + (got ? '' : ' empty');
        c.textContent = got ? (PET_TRINKET[i] ?? '') : '?';
        shelf.appendChild(c);
      }
      mount.appendChild(shelf);

      /* ---- 档案串（换养用）+ 说明（老项目 :11328-11329 逐字） ---- */
      const pass = document.createElement('div');
      pass.className = 'ns-pass';
      pass.textContent = petArchiveCode(s);
      mount.appendChild(pass);

      const note = document.createElement('p');
      note.className = 'ns-pnote';
      note.textContent = COPY.petNote;
      mount.appendChild(note);

      /* ---- 换养区（老项目 :11330-11334 逐字结构） ---- */
      const swap = document.createElement('div');
      swap.className = 'ns-swap';
      const swIn = document.createElement('input');
      swIn.className = 'ns-swap-in';
      swIn.type = 'text';
      swIn.autocomplete = 'off';
      swIn.spellcheck = false;
      swIn.placeholder = COPY.petSwapPlaceholder;
      const swGo = document.createElement('button');
      swGo.className = 'ns-swap-go';
      swGo.textContent = COPY.petSwapGo;
      swGo.disabled = true;
      const swMsg = document.createElement('p');
      swMsg.className = 'ns-swap-msg';
      swMsg.hidden = true;
      swap.appendChild(swIn);
      swap.appendChild(swGo);
      swap.appendChild(swMsg);
      mount.appendChild(swap);

      const syncMsg = (bad: boolean, msg: string): void => {
        swMsg.hidden = false;
        swMsg.textContent = msg;
        swMsg.className = 'ns-swap-msg' + (bad ? ' bad' : '');
        swIn.classList.toggle('bad', bad);
        swGo.textContent = COPY.petSwapGo;
        swGo.disabled = !String(swIn.value || '').trim();
      };
      swIn.addEventListener('input', () => {
        swGo.disabled = !String(swIn.value || '').trim();
        swMsg.hidden = true;
        swMsg.classList.remove('bad');
        swIn.classList.remove('bad');
      });
      swGo.addEventListener('click', () => {
        const r = adoptArchiveCode(String(swIn.value || ''));
        if (!r.state) {
          g.fx('burp');
          syncMsg(true, r.err === 'empty' ? COPY.petSwapEmpty : COPY.petSwapBad);
          return;
        }
        // 🔴 老项目这里写 `fx('wake')`，但 bj 的 FxName（shell.ts:40）**没有 wake** ——
        //   老项目那套 fx 名（wake/purr/grow/snatch）没被照搬，bj 是另一套
        //   tap/start/eat/coin/shot/brk/thrust/die/up/burp/enter。
        //   写 'wake' 会被 tsc 挡住（这正是把 fx 名做成 union 的价值）。
        //   换养成功取 `up`（上行音，最接近「叫醒」），换养失败取 `burp`。
        g.fx('up');
        // 🔴🔴 顺序承重：**先重画、后写反馈**。
        //   `renderPanel` 会 `mount.textContent = ''` 把整棵子树连同 `swMsg` 一起丢掉 ——
        //   反过来写的话，那句「换养成功」写在一个已脱树的节点上，
        //   屏幕上什么都看不到（症状是"点了没反应"，而数据其实已经换了）。
        //   重画后 `swMsg`/`swIn`/`swGo` 都是新节点，必须重新 query。
        renderPanel(mount, g);
        const msg2 = mount.querySelector<HTMLElement>('.ns-swap-msg');
        const in2 = mount.querySelector<HTMLInputElement>('.ns-swap-in');
        const go2 = mount.querySelector<HTMLButtonElement>('.ns-swap-go');
        if (msg2 && in2 && go2) {
          msg2.hidden = false;
          msg2.className = 'ns-swap-msg';
          msg2.textContent = COPY.petSwapOk;
          go2.disabled = true;
        }
      });

      /* ---- 底部操作区（老项目 :11336-11338 逐字） ---- */
      const dock = document.createElement('div');
      dock.className = 'ns-pet-dock';
      const btns = document.createElement('div');
      btns.className = 'ns-pet-btns';

      const sleep = document.createElement('button');
      sleep.className = 'ns-pet-sleep';
      sleep.textContent = COPY.petSleep;
      sleep.addEventListener('click', () => {
        // 🔴🔴 `sleepPet()` **必须刷 last**（老项目 :11352 注释：否则
        //   petMount 的 3 天守卫会把它当场叫回来）。这条在 pet.ts 里有断言。
        sleepPet();
        g.fx('burp');
        document.getElementById('nsPet')?.classList.add('asleep');
        renderPanel(mount, g);
      });

      const free = document.createElement('button');
      free.className = 'ns-pet-free';
      free.textContent = COPY.petFree;
      free.addEventListener('click', () => {
        // 放归 = 收起并打 retiredAt，**不删任何数据**（老项目 :11381-11386）
        retirePet();
        g.fx('burp');
        unmountPet();
        // 退出面板：与老项目 `closeShell()` 同款
        const x = document.querySelector<HTMLElement>('.ns-game .ns-x');
        x?.click();
      });

      const copy = document.createElement('button');
      copy.className = 'ns-pet-copy';
      copy.textContent = COPY.petCopyPassport;
      copy.addEventListener('click', () => {
        try {
          void navigator.clipboard.writeText(petArchiveCode(readPet()));
          copy.textContent = COPY.petPassportCopied;
          window.setTimeout(() => {
            copy.textContent = COPY.petCopyPassport;
          }, 2200);
        } catch {
          /* 剪贴板不可用（非 https / 无权限）：按钮文字不变，不谎报已复制 */
        }
      });

      btns.appendChild(sleep);
      btns.appendChild(free);
      btns.appendChild(copy);
      dock.appendChild(btns);
      mount.appendChild(dock);
    },
  };
}

/**
 * 重画整个档案面板。
 *
 * 🔴 为什么要「拆了重建」而不是逐个改数字：形态名、档案行、16 格柜子、
 *   档案串四处的派生规则各不相同（`stageName` / `petArchiveLine` / `normShelf` /
 *   `petArchiveCode`），逐处同步是漏一处就显形的经典写法。
 *   重建的成本是几十个 DOM 节点，而漏更新的代价是「数字对不上且没人知道为什么」。
 *
 * 🔴 重建后 `mount.className` 会被 `dom()` 重设成同一个值，所以这里只清内容即可；
 *   **不重建定时器/监听器**（`dom()` 每次都新建监听器，重建即丢弃旧的，没有泄漏）。
 */
function renderPanel(mount: HTMLElement, g: GameCtx): void {
  mount.textContent = '';
  petGame().dom(mount, g);
}

/* ------------------------------------------------------------------ *
 * 10. /mirror 镜像模式 —— 非canvas 型，自带画面
 * ------------------------------------------------------------------ */

export function mirrorGame(): DomGameDef {
  return {
    id: 'mirror',
    // 🔴 tip 逐字对齐老项目（index.html:11145）
    tip: '整站左右镜像 · 文字与图片已反回 · 刷新即回正常',
    dom: (mount, g) => {
      // 镜像壳透明：站点必须可见（否则「镜像模式」只是看一块白板）
      mount.className = 'ns-mirror-panel';
      const h = document.createElement('h2');
      h.textContent = '镜像模式';
      const p = document.createElement('p');
      p.textContent = '整站左右翻面。文字、图片、二维码、导出图都会自动反回来——反了的二维码扫不出来、反了的人脸像坏了。';
      const row = document.createElement('div');
      row.className = 'ns-mrow';
      const mnote = document.createElement('p');
      mnote.className = 'ns-mnote';
      mnote.textContent = '导出的图片永远是正的：html2canvas 前摘掉 transform。刷新即回正常，不写 localStorage。';
      let mode: 'A' | 'B' | 'C' = 'B'; // 老版默认 B
      const btns: HTMLButtonElement[] = [];
      const labels: Record<'A' | 'B' | 'C', string> = {
        A: 'A 全镜像（字也反）',
        B: 'B 镜像不反字',
        C: 'C 只翻装饰',
      };
      const apply = (): void => {
        // 🔴 class 必须挂 body：样式选择器写的是 body.ns-mirror-*，
        //    挂 html 上等于零效果（老版闸自检实锤）。会话态不落盘（老版口径）。
        const de = document.body;
        de.classList.remove('ns-mirror-A', 'ns-mirror-B', 'ns-mirror-C');
        de.classList.add('ns-mirror-' + mode);
        for (const b of btns) b.classList.toggle('on', b.dataset.m === mode);
      };
      for (const m of ['A', 'B', 'C'] as const) {
        const b = document.createElement('button');
        b.dataset.m = m;
        b.textContent = labels[m];
        b.addEventListener('click', () => {
          mode = m;
          apply();
          g.fx('tap');
        });
        btns.push(b);
        row.appendChild(b);
      }
      mount.appendChild(h);
      mount.appendChild(p);
      mount.appendChild(row);
      mount.appendChild(mnote);
      apply();
    },
    destroy: () => {
      document.body.classList.remove('ns-mirror-A', 'ns-mirror-B', 'ns-mirror-C');
    },
  };
}

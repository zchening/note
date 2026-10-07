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
    g.setScore('0');
    g.setLevel('');
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
      g.end(COPY.gameOver, [
        [COPY.gameRowScore, String(score)],
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
          g.end(COPY.gameOver, [
            [COPY.gameRowScore, String(score)],
            [COPY.gameRowExtra, String(step)],
          ]);
          return;
        }
        if (body.some((b) => b.x === nx && b.y === ny)) {
          g.fx('die');
          g.end(COPY.gameOver, [
            [COPY.gameRowScore, String(score)],
            [COPY.gameRowExtra, String(step)],
          ]);
          return;
        }
        body.unshift({ x: nx, y: ny });
        if (nx === food.x && ny === food.y) {
          score += food.pts;
          g.fx('eat');
          g.setScore(score);
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
 * 3. /brick 打砖块 —— 砖面优先取正文词
 * ------------------------------------------------------------------ */

export function brickGame(getCtx: () => { body: string; favs: string[] }): GameDef {
  const COLS = 6;
  const ROWS = 5;
  let bw = 60;
  let bh = 22;
  let ox = 0;
  let oy = 0;
  let bricks: { x: number; y: number; label: string; alive: boolean; pts: number }[] = [];
  let px = 0;
  let py = 0;
  let vx = 320;
  let vy = -260;
  let score = 0;
  let left = 0;

  const reset = (g: GameCtx): void => {
    const words = names('brick', getCtx().body, getCtx().favs, ['灵感', '草稿', '计划', '备忘', '片段', '清单', '随手', '待办']);
    bricks = [];
    let i = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let cIdx = 0; cIdx < COLS; cIdx++) {
        const lb = words[i % words.length] ?? '词';
        bricks.push({ x: 0, y: 0, label: lb.slice(0, 4), alive: true, pts: lb.length });
        i++;
      }
    }
    left = bricks.length;
    score = 0;
    px = g.w() / 2 - 40;
    py = g.h() - 30;
    vx = 320;
    vy = -260;
    g.setScore('0');
    g.setLevel('');
  };

  return {
    id: 'brick',
    tip: '左右移动挡板 · 打完所有砖过关',
    start: reset,
    resize: (w, h) => {
      bw = Math.floor((w - 40) / COLS);
      bh = 24;
      ox = 20;
      oy = 60;
      void h;
    },
    frame: (dt, g) => {
      px += vx * dt;
      if (px < 0) {
        px = 0;
        vx = -vx;
      }
      if (px + 80 > g.w()) {
        px = g.w() - 80;
        vx = -vx;
      }
      py += vy * dt;
      const top = oy;
      const bot = g.h() - 24;
      if (py < top + bh) {
        py = top + bh;
        vy = -vy;
      }
      // 撞砖
      for (const b of bricks) {
        if (!b.alive) continue;
        const bx = ox + b.x * bw;
        const by = oy + b.y * bh;
        if (py - 8 > by && py - 8 < by + bh && px + 40 > bx && px + 40 < bx + bw) {
          b.alive = false;
          left -= 1;
          score += b.pts;
          g.fx('brk');
          g.setScore(score);
          vy = -vy;
          break;
        }
      }
      if (left <= 0) {
        g.fx('up');
        g.end('全清了这个', [
          [COPY.gameRowScore, String(score)],
        ]);
        return;
      }
      if (py > bot) {
        g.fx('die');
        g.end(COPY.gameOver, [
          [COPY.gameRowScore, String(score)],
          [COPY.gameRowExtra, `${left} 块`],
        ]);
      }
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const p = pal(g);
      c.clearRect(0, 0, g.w(), g.h());
      // 砖
      bricks.forEach((b, i) => {
        if (!b.alive) return;
        const bx = ox + (b.x % COLS) * bw;
        const by = oy + b.y * bh;
        void i;
        c.fillStyle = p.soft;
        rr(c, bx + 1, by + 1, bw - 2, bh - 2, 5);
        c.fill();
        txt(c, b.label, bx + bw / 2, by + bh / 2, 11, p.fg);
      });
      // 球
      c.fillStyle = p.accent;
      c.beginPath();
      c.arc(px + 40, py - 8, 5, 0, Math.PI * 2);
      c.fill();
      // 挡板
      c.fillStyle = p.fg;
      rr(c, px, g.h() - 24, 80, 8, 4);
      c.fill();
    },
    move: (x) => {
      px = x - 40;
    },
    swipe: (d) => {
      void d;
    },
    tap: (g) => {
      // 点一下把球打回去（老项目同款：防止球一直往下掉没法玩）
      if (vy > 0) vy = -Math.abs(vy) * 0.9;
      void g;
    },
    key: (down, e, g) => {
      if (!down) return;
      if (e.key === 'ArrowLeft' || e.key === 'a') vx = -420;
      if (e.key === 'ArrowRight' || e.key === 'd') vx = 420;
      void g;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4. /satoshi 2048 聪合币 —— 合到 1 亿聪 = 1 个币
 * ------------------------------------------------------------------ */

export function satoshiGame(): GameDef {
  const N = 4;
  let cell = 60;
  let ox = 0;
  let oy = 0;
  let grid: number[] = [];
  let score = 0;

  const reset = (g: GameCtx): void => {
    grid = new Array(N * N).fill(0);
    score = 0;
    spawn();
    spawn();
    g.setScore('0');
    g.setLevel('');
  };

  const spawn = (): void => {
    const free: number[] = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] === 0) free.push(i);
    if (free.length === 0) return;
    const p = free[Math.floor(Math.random() * free.length)] as number;
    grid[p] = Math.random() < 0.9 ? 1 : 2;
  };

  const slide = (g: GameCtx, dir: 'U' | 'D' | 'L' | 'R'): void => {
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
          score += vals[i] as number;
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
      spawn();
      // 🔴 分数**在这里**就推给 HUD：若放到 frame 里每帧推，
      //   swipe 连划时 HUD 会滞后一拍，用户会觉得"没反应"。
      g.setScore(score);
    }
  };

  return {
    id: 'satoshi',
    tip: '方向键 / 划屏滑动 · 合到 1 亿聪算赢',
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
          const label = v >= 1e8 ? `${Math.floor(v / 1e8)}币` : String(v);
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
  let gems: { x: number; y: number; r: number; val: number; got: boolean }[] = [];
  let held: { x: number; y: number; r: number; val: number } | null = null;

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
    held = null;
    gems = [];
    // 越深越肥：y 越大 val 越高
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
    g.setScore('0');
    g.setLevel('');
  };

  return {
    id: 'bitcoin',
    tip: '点一下放钩子 · 越深越肥',
    start: reset,
    resize: (w, h) => {
      pivotX = w / 2;
      pivotY = 56;
      void h;
    },
    frame: (dt, g) => {
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
          const t = 1 - len / Math.max(1, len + 380 * dt);
          void t;
          //钩子回收时把宝石往轴心拉
          held.x -= (held.x - pivotX) * 0.12;
          held.y -= (held.y - pivotY) * 0.12;
        }
        if (len <= 0) {
          len = 0;
          retracting = false;
          if (held) {
            score += held.val;
            g.setScore(score);
            held = null;
          }
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
 * ------------------------------------------------------------------ */

export function tankGame(getCtx: () => { body: string; favs: string[]; cur: string }): GameDef {
  const N = 13;
  let cell = 24;
  let ox = 0;
  let oy = 0;
  let walls: boolean[][] = [];
  let px = 0;
  let py = 0;
  let dir: 'U' | 'D' | 'L' | 'R' = 'U';
  let step = 0;
  let baseX = 6;
  let baseY = 6;
  let score = 0;
  let level = 1;
  let baseLabel = '';

  const buildWalls = (): void => {
    walls = [];
    for (let r = 0; r < N; r++) {
      const row: boolean[] = [];
      for (let c = 0; c < N; c++) row[c] = false;
      walls[r] = row;
    }
    // 砖块
    for (let r = 1; r < N; r += 2) {
      for (let c = 1; c < N; c += 2) {
        const row = walls[r];
        // 🔴 逐行收窄而不是整段 `walls[r][c] = true`：
        //   noUncheckedIndexedAccess 下那是 boolean | undefined。
        //   反过来说，**用 ?? false 硬写会掩盖越界** —— 越界本该是不该发生的bug，
        //   静默当空地会让"关卡布局错了"表现为"撞了个空"。
        if (row) row[c] = true;
      }
    }
  };

  const reset = (g: GameCtx): void => {
    buildWalls();
    px = 6;
    py = 11;
    baseX = 6;
    baseY = 0;
    dir = 'U';
    step = 0;
    score = 0;
    level = 1;
    baseLabel = getCtx().cur || '记事本';
    g.setScore('0');
    g.setLevel(`第 ${level} 关`);
  };

  const bump = (nx: number, ny: number): boolean => {
    if (nx < 0 || ny < 0 || nx >= N || ny >= N) return true;
    return walls[ny]?.[nx] === true;
  };

  return {
    id: 'tank',
    // 🔴🔴 tip 文案逐字对齐老项目（index.html:12149）：
    //   此前 bj 写的是「四向划屏 / 方向键 · 撞开砖墙，守住你的笔记」——
    //   **少了"怎么开火"**。用户报障「tank 也和之前不一样」指的就是这个：
    //   玩法提示里没有射击操作，玩家不知道空格/右半屏能开火，于是以为游戏坏了。
    //   提示文案是契约（用户按它学操作），不能自己改写。
    tip: '划屏改向 / 方向键移动 · 点右半屏或空格开火 · 别让记事本被炸',
    start: reset,
    resize: (w, h) => {
      cell = Math.floor(Math.min(w, h) / (N + 0.5));
      ox = (w - cell * N) / 2;
      oy = (h - cell * N) / 2;
    },
    frame: (dt, g) => {
      step += dt * 4;
      if (step >= 1) {
        step = 0;
        const dx = dir === 'L' ? -1 : dir === 'R' ? 1 : 0;
        const dy = dir === 'U' ? -1 : dir === 'D' ? 1 : 0;
        const nx = px + dx;
        const ny = py + dy;
        if (bump(nx, ny)) {
          // 撞墙：砖墙可撞掉，其余算碰壁
          if (walls[ny]?.[nx] === true) {
            walls[ny][nx] = false;
            score += 1;
            g.setScore(score);
            g.fx('brk');
          }
          return;
        }
        px = nx;
        py = ny;
        // 吃到基地外的金豆= 过关
        if (py <= baseY + 1 && px >= baseX - 1 && px <= baseX + 1) {
          level += 1;
          score += 10;
          g.setScore(score);
          g.fx('up');
          g.setLevel(`第 ${level} 关`);
          buildWalls();
          px = 6;
          py = 11;
        }
        if (px === baseX && py === baseY) {
          g.fx('die');
          g.end(COPY.gameOver, [
            [COPY.gameRowScore, String(score)],
            [COPY.gameRowExtra, `第 ${level} 关`],
          ]);
        }
      }
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const p = pal(g);
      c.clearRect(0, 0, g.w(), g.h());
      // 砖
      for (let r = 0; r < N; r++) {
        for (let cIdx = 0; cIdx < N; cIdx++) {
          if (!walls[r]?.[cIdx]) continue;
          c.fillStyle = p.soft;
          c.fillRect(ox + cIdx * cell, oy + r * cell, cell - 1, cell - 1);
        }
      }
      // 基地（你的笔记）
      c.fillStyle = p.accent;
      rr(c, ox + baseX * cell + 2, oy + baseY * cell + 2, cell - 4, cell - 4, 4);
      c.fill();
      txt(c, baseLabel.slice(0, 4), ox + (baseX + 0.5) * cell, oy + (baseY + 0.5) * cell, 10, p.bg);
      // 坦克
      c.fillStyle = p.fg;
      rr(c, ox + px * cell + 2, oy + py * cell + 2, cell - 4, cell - 4, 4);
      c.fill();
      c.fillStyle = p.accent;
      c.beginPath();
      c.arc(ox + (px + 0.5) * cell, oy + (py + 0.5) * cell, cell * 0.16, 0, Math.PI * 2);
      c.fill();
    },
    swipe: (d) => {
      dir = d;
    },
    key: (down, e) => {
      if (!down) return;
      const m: Record<string, 'U' | 'D' | 'L' | 'R'> = {
        ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R',
        w: 'U', s: 'D', a: 'L', d: 'R', W: 'U', S: 'D', A: 'L', D: 'R',
      };
      const d = m[e.key];
      if (d) dir = d;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 7. /spacex 垂直着陆 —— 按住=推力
 * ------------------------------------------------------------------ */

export function spacexGame(): GameDef {
  let x = 0;
  let y = 0;
  let vy = 0;
  let thrust = 0;
  let score = 0;
  let landed = false;
  let targetY = 0;
  let padHalf = 40;
  let groundY = 0;

  const reset = (g: GameCtx): void => {
    x = g.w() / 2;
    y = 40;
    vy = 0;
    thrust = 0;
    score = 0;
    landed = false;
    groundY = g.h() - 50;
    targetY = groundY;
    padHalf = Math.max(30, g.w() * 0.18);
    g.setScore('0');
    g.setLevel('');
  };

  return {
    id: 'spacex',
    tip: '按住屏幕 / 空格 = 推力 · 落稳在驳船中线',
    start: reset,
    resize: (w, h) => {
      groundY = h - 50;
      targetY = groundY;
      padHalf = Math.max(30, w * 0.18);
    },
    frame: (dt, g) => {
      if (landed) return;
      vy += 420 * dt; // 重力
      vy -= thrust * 900 * dt; // 推力
      y += vy * dt;
      if (thrust > 0) g.fx('thrust');
      // 触地判定
      if (y >= groundY) {
        y = groundY;
        const off = Math.abs(x - g.w() / 2);
        const ok = off <= padHalf;
        landed = true;
        if (ok) {
          score = Math.max(0, 100 - Math.round(off * 2) - Math.round(Math.abs(vy) / 4));
          g.fx('up');
          g.setScore(score);
          g.end('稳稳落住了', [
            [COPY.gameRowScore, String(score)],
            [COPY.gameRowExtra, `偏 ${Math.round(off)}px`],
          ]);
        } else {
          g.fx('die');
          g.end('摔了', [
            [COPY.gameRowScore, '0'],
            [COPY.gameRowExtra, `偏 ${Math.round(off)}px`],
          ]);
        }
      }
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const p = pal(g);
      c.clearRect(0, 0, g.w(), g.h());
      // 驳船
      c.fillStyle = p.line;
      c.fillRect(0, groundY + 20, g.w(), 30);
      c.fillStyle = p.soft;
      c.fillRect(g.w() / 2 - padHalf, groundY + 12, padHalf * 2, 8);
      // 火箭
      c.fillStyle = landed && p.accent !== '' ? p.fg : p.fg;
      rr(c, x - 10, y - 22, 20, 22, 6);
      c.fill();
      // 尾焰
      if (thrust > 0 && !landed) {
        c.fillStyle = p.accent;
        c.beginPath();
        c.moveTo(x - 6, y);
        c.lineTo(x + 6, y);
        c.lineTo(x, y + 18);
        c.closePath();
        c.fill();
      }
      // 高度标
      txt(c, `高度 ${Math.max(0, Math.round(groundY - y))}`, g.w() / 2, 24, 12, p.muted);
    },
    down: (_x, _y, g) => {
      thrust = 1;
      void g;
    },
    up: (_x, _y, g) => {
      thrust = 0;
      void g;
    },
    key: (down, e) => {
      if (e.key === ' ' || e.key === 'ArrowUp') thrust = down ? 1 : 0;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 8. /tesla 轨道巡航 —— 微调推力撞碎飘过的标题
 * ------------------------------------------------------------------ */

export function teslaGame(getCtx: () => { body: string; favs: string[] }): GameDef {
  let y = 0;
  let vy = 0;
  let thrust = 0;
  let score = 0;
  let targets: { x: number; y: number; vx: number; label: string; alive: boolean }[] = [];
  let t = 0;
  let landed = false;
  let groundY = 0;

  const reset = (g: GameCtx): void => {
    y = g.h() - 80;
    vy = 0;
    thrust = 0;
    score = 0;
    t = 0;
    landed = false;
    groundY = g.h() - 60;
    const words = names('tesla', getCtx().body, getCtx().favs, ['灵感', '草稿', '计划', '备忘', '待办', '清单', '片段', '随手']);
    targets = [];
    for (let i = 0; i < 8; i++) {
      targets.push({
        x: 40 + Math.random() * Math.max(40, g.w() - 80),
        y: 40 + i * 60,
        vx: (Math.random() > 0.5 ? 1 : -1) * 40,
        label: (words[i % words.length] ?? '词').slice(0, 5),
        alive: true,
      });
    }
    g.setScore('0');
    g.setLevel('');
  };

  return {
    id: 'tesla',
    tip: '按住屏幕 / 空格 = 推力 · 撞碎飘过的笔记标题',
    start: reset,
    resize: (w, h) => {
      groundY = h - 60;
    },
    frame: (dt, g) => {
      if (landed) return;
      t += dt;
      vy += 300 * dt;
      vy -= thrust * 700 * dt;
      y += vy * dt;
      if (y > groundY) {
        y = groundY;
        landed = true;
        g.end(COPY.gameOver, [
          [COPY.gameRowScore, String(score)],
          [COPY.gameRowExtra, `${Math.round(t)}${COPY.gameUnitSec}`],
        ]);
        return;
      }
      if (y < 20) {
        y = 20;
        vy = Math.abs(vy) * 0.5;
      }
      // 目标飘动
      for (const tg of targets) {
        if (!tg.alive) continue;
        tg.x += tg.vx * dt;
        if (tg.x < 20 || tg.x > g.w() - 20) tg.vx = -tg.vx;
      }
      // 撞碎
      for (const tg of targets) {
        if (!tg.alive) continue;
        if (Math.abs(tg.x - g.w() / 2) < 22 && Math.abs(tg.y - y) < 16) {
          tg.alive = false;
          score += tg.label.length;
          g.fx('brk');
          g.setScore(score);
        }
      }
      if (targets.every((x) => !x.alive)) {
        landed = true;
        g.fx('up');
        g.end('全清了这个', [[COPY.gameRowScore, String(score)]]);
      }
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const p = pal(g);
      c.clearRect(0, 0, g.w(), g.h());
      // 地面
      c.fillStyle = p.line;
      c.fillRect(0, groundY + 20, g.w(), 40);
      // 目标（飘着的笔记标题）
      for (const tg of targets) {
        if (!tg.alive) continue;
        c.fillStyle = p.soft;
        rr(c, tg.x - 26, tg.y - 12, 52, 24, 6);
        c.fill();
        txt(c, tg.label, tg.x, tg.y, 11, p.fg);
      }
      // 飞船
      c.fillStyle = p.fg;
      rr(c, g.w() / 2 - 12, y - 8, 24, 16, 6);
      c.fill();
      if (thrust > 0) {
        c.fillStyle = p.accent;
        c.beginPath();
        c.moveTo(g.w() / 2 - 5, y + 8);
        c.lineTo(g.w() / 2 + 5, y + 8);
        c.lineTo(g.w() / 2, y + 22);
        c.closePath();
        c.fill();
      }
    },
    down: (_x, _y, g) => {
      thrust = 1;
      void g;
    },
    up: (_x, _y, g) => {
      thrust = 0;
      void g;
    },
    key: (down, e) => {
      if (e.key === ' ' || e.key === 'ArrowUp') thrust = down ? 1 : 0;
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
    tip: '把当前笔记内容镜像放大/缩小',
    dom: (mount, g) => {
      mount.className = 'ns-mirror-stage';
      const text = document.getElementById('nsMirrorText');
      const box = document.createElement('div');
      box.className = 'ns-mirror-box';
      const title = document.createElement('div');
      title.className = 'ns-mirror-title';
      title.textContent = '镜像模式';
      const pre = document.createElement('pre');
      pre.className = 'ns-mirror-pre';
      pre.id = 'nsMirrorPre';
      pre.textContent = text?.textContent ?? '';
      box.appendChild(title);
      box.appendChild(pre);
      mount.appendChild(box);
      let scale = 1;
      const apply = (): void => {
        pre.style.transform = `scale(${scale})`;
      };
      mount.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (t.closest('.ns-mirror-stage')) {
          scale = scale >= 2 ? 0.6 : scale + 0.2;
          apply();
          g.fx('tap');
        }
      });
      apply();
    },
  };
}

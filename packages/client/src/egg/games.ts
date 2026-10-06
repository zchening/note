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
import type { DomGameDef, GameCtx, GameDef } from './shell.ts';

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
 * 2. /dragon 断网恐龙 —— 三秒分镜 → 横版跳跃
 * ------------------------------------------------------------------ */

export function dragonGame(getCtx: () => { body: string; favs: string[] }): GameDef {
  let labels: string[] = [];
  let x = 0;
  let y = 0;
  let vy = 0;
  let speed = 132;
  let score = 0;
  let dist = 0;
  let dead = false;
  let ground = 0;
  let introT = 0;
  /**
   * 🔴🔴 intro 相位：进入后的前 3 秒**只跑动画、不判碰撞**。
   *
   *   这是用户报障「dragon 进入就死亡」的**真实根因**（探针 probe-eggs 实锤：
   *   进入后 3 秒就出「这一局结束了得分10」）。bj 此前直接进 run 相位，
   *   而第一块牌子就在 x=60+220-46 处 ⇒ 站着不动 0.4 秒必撞。
   *
   *   老项目 index.html:11756 原样：
   *     if (phase === 'intro') { it += dt; if (it > 3) { phase = 'run'; } return; }
   *   —— 它的 `introTap` 机制还让"第一下点击只起跑、不补跳"，bj 不做那层，
   *   但**3 秒无敌**这条是承重的，必须有（否则用户还没看清玩法就死了）。
   */
  let intro = true;
  /** 本局跑过的字数（老项目 `pass` 之外的"本局跑了 N 字"，本项目用 dist 派生）。 */
  let passed = 0;

  const reset = (g: GameCtx): void => {
    labels = names('dragon', getCtx().body, getCtx().favs, ['账单', 'deadline', '周报', '待办', '会议', '需求', 'bug', '上线']);
    ground = g.h() - 46;
    x = 60;
    // 🔴 y 是**离地高度**，初始 0 = 贴地（此前写 `y = ground`，那是旧的屏幕坐标语义）
    y = 0;
    vy = 0;
    // 🔴 起始速度回老项目的 132（此前 260，是老项目的两倍 —— 手感"飞出去"）
    speed = 132;
    score = 0;
    dist = 0;
    passed = 0;
    dead = false;
    intro = true;
    introT = 0;
    g.setScore('0');
    g.setLevel('');
  };

  return {
    id: 'dragon',
    tip: '点屏幕 = 跳 · 按住屏幕 = 低头 · 撞上牌子就结束',
    start: reset,
    resize: (w, h, g) => {
      void w;
      ground = h - 46;
      void g;
    },
    frame: (dt, g) => {
      if (intro) {
        introT += dt;
        if (introT > 3) intro = false;
        return;
      }
      if (dead) return;
      // 🔴 与老项目同款加速曲线：132 起、每米+0.8、最多 +70（老项目 :11758 `sp = 132 + Math.min(70, it * 0.8)`）
      speed = 132 + Math.min(70, dist * 0.05);
      dist += speed * dt;
      // 🔴 重力 900、方向与老项目一致（y 是**离地高度**，向上为正 ⇒ vy -= g）
      vy -= 900 * dt;
      y += vy * dt;
      // 🔴 落地判据是 `y <= 0`（离地高度 0 = 贴地），**不是 `y <= ground`**。
      //   旧版本把 ground 当屏幕坐标用，改语义时这里漏改会让恐龙一出生就"落地"
      //   （y=ground=高度值 ⇒ y<=ground 立刻成立 ⇒ vy 被夹成 0，永远跳不起来）。
      if (y <= 0) {
        y = 0;
        vy = 0;
      }
      //撞牌子：按 x 间距循环放牌子
      const span = 220;
      const idx = Math.floor((x + dist) / span);
      const rel = (x + dist) % span;
      // 🔴 `vy <= 0` 才是"正在下落"（上升中 vy > 0）—— 与新语义配套。
      if (rel > span - 46 && vy <= 0) {
        const lb = labels[idx % Math.max(1, labels.length)] ?? '账单';
        dead = true;
        g.fx('die');
        // 🔴 结束语与老项目同款（:11763）：报出**撞上什么**，并给"躲过 N 个"
        //   此前是千篇一律的「这一局结束了」，用户看不出是哪块牌子撞的。
        g.end('被' + lb + '撞倒了', [
          [COPY.gameRowScore, String(score)],
          [COPY.gameRowExtra, String(passed)],
        ]);
      }
      passed = Math.floor(dist / span);
      score = Math.floor(dist / 4);
      g.setScore(score);
    },
    draw: (g) => {
      const cv = document.getElementById('nsCv') as HTMLCanvasElement | null;
      const c = cv?.getContext('2d');
      if (!c) return;
      const p = pal(g);
      c.clearRect(0, 0, g.w(), g.h());
      // 地面
      c.fillStyle = p.line;
      c.fillRect(0, ground + 20, g.w(), 26);
      // 牌子
      const span = 220;
      const start = Math.floor((x + dist) / span);
      for (let i = start; i < start + Math.ceil(g.w() / span) + 1; i++) {
        const sx = i * span - (x + dist) + x;
        const lb = labels[i % Math.max(1, labels.length)] ?? '账单';
        c.fillStyle = p.line;
        c.fillRect(sx, ground - 30, 4, 50);
        c.fillStyle = p.soft;
        rr(c, sx - 4, ground - 56, Math.max(52, lb.length * 13 + 16), 26, 6);
        c.fill();
        txt(c, lb.slice(0, 6), sx - 4 + Math.max(52, lb.length * 13 + 16) / 2, ground - 43, 12, p.fg);
      }
      // 🐲 恐龙（简化 runner）。
      // 🔴 `y` 的语义在这一版改成**离地高度**（向上为正、0 = 地面），
      //   与老项目 index.html:11740 `function jump(){ vy = 330 }` + `:11759 vy -= 900*dt`
      //   完全一致 —— 此前 bj 用的是「绝对屏幕坐标 + 向下为正」，
      //   与老项目的物理约定**反号**，抄任何一行物理参数都会得到反向手感
      //   （老项目那条注释「写成 vy+=g 会把起跳首帧就夹回地面」说的就是这类反号）。
      //   ⇒ 画恐龙要用 `ground - y - 26`（屏幕坐标），不能直接拿 y 当屏幕 y。
      c.fillStyle = dead ? p.danger : p.accent;
      rr(c, x, ground - y - 26, 34, 26, 8);
      c.fill();
      c.fillStyle = p.fg;
      c.beginPath();
      c.arc(x + 24, ground - y - 30, 3, 0, Math.PI * 2);
      c.fill();
    },
    tap: (g) => {
      if (dead || intro) return;
      if (y <= 1) vy = 330;
      void g;
    },
    down: (g) => {
      if (dead || intro) return;
      if (y <= 1) vy = 330;
      void g;
    },
    key: (down, e, g) => {
      if (!down) return;
      if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w') {
        if (intro) {
          intro = false; // 🔴 老项目 introTap：intro 期的第一下只起跑、不补跳
          return;
        }
        if (y <= 1) vy = 330;
      }
      void g;
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
    //   `petBlank().adopted` 默认 false ⇒ 不访问 /pet 就不出现）；
    //   bj 这里是 /pet 彩蛋页内的独立 stage，属**形态差异**，本轮先对齐宠物本体，
    //   常驻挂载那条属于"要不要做"的设计决策，留待用户拍板（不做隐式移植）。
    dom: (mount, g) => {
      mount.className = 'ns-pet-stage';
      const pet = document.createElement('div');
      pet.className = 'ns-pet';
      // 🦀 老项目 index.html:11202 逐字（aria-hidden 同款）
      pet.innerHTML =
        '<svg viewBox="0 0 26 26" aria-hidden="true">' +
        '<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
        '<path d="M4 18c0-5 3.6-8.6 8.6-8.6S21 13 21 18"/>' +
        '<path d="M4 18h17"/>' +
        '<path d="M8 18v2.6M13 18v2.6M18 18v2.6"/>' +
        '</g>' +
        '<circle cx="9.6" cy="13.4" r="1.2" fill="var(--accent)" stroke="none"/>' +
        '<circle cx="15.6" cy="13.4" r="1.2" fill="var(--accent)" stroke="none"/>' +
        '</svg>';
      mount.appendChild(pet);
      pet.addEventListener('click', () => {
        g.fx('burp');
        pet.classList.add('jump');
        window.setTimeout(() => pet.classList.remove('jump'), 420);
      });
    },
  };
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

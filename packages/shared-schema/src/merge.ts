/**
 * 冲突合并 —— 两层，纯函数，无 IO、无随机、无 Date.now
 *
 * 为什么要两层（ARCH.md §4.3）：
 *  单层字符 diff3 在块级结构变动（插段、删段、折叠块套娃）时会把整篇搅成乱麻，
 *  老项目就是吃了这个亏。块级先按内容签名（LCS）把"同一块"的对应关系钉死，
 *  块内再用字符级 diff3 拼同一块的两种改法。这样"设备A改第1段、设备B改第3段"
 *  必然无损合并。
 *
 * 算法（标准 diff3，两层共用同一份实现）：
 *  1. base↔left、base↔right 各做一次 LCS 对齐，得到"哪个 base 块在两侧的对应下标"
 *     以及"两侧各自在什么位置插了块"
 *  2. 两侧都原样保留了同一个 base 块 → 该位置是**稳定锚点**，直接透传
 *  3. 锚点把序列切成若干**变更簇**，每簇内三段（base/left/right）做局部三方判定：
 *       只有一侧改 → 取那侧；两侧改成一样 → 取该结果；两侧改法不同 → 进簇内
 *       对齐逐块 mergeOne，删-vs-改 的情形显式报冲突
 *  4. 冲突绝不静默丢弃：产出 Conflict 列表交 UI 让人选
 *
 * 契约（属性测试钉死）：
 *  - merge(a, a, b) === b 且 merge(a, b, a) === b（一侧没动时另一侧全盘接收）
 *  - merge(a, a, a) === a，无冲突
 *  - 纯函数：不修改任何入参，同输入同输出
 *  - 结果必定是合法 Doc（不留半成品状态）
 */

import { blockSig, canonicalize } from './canonical.ts';
import { emptyDoc, type Block, type Doc, type Reminder, type Span } from './types.ts';

export interface Conflict {
  /** 冲突定位串，例：blocks[3] / blocks[3].children[0] / reminders.r1 */
  at: string;
  kind: 'block' | 'reminder' | 'text';
  /** base / left / right 三方各自的表示，UI 展示用（DELETED 表示该侧删了） */
  base: string;
  left: string;
  right: string;
}

export interface MergeResult {
  doc: Doc;
  conflicts: Conflict[];
}

const DELETED = '（删除）';

/* ------------------------------------------------------------------ *
 * LCS 对齐
 * ------------------------------------------------------------------ */

type AlignOp =
  | { k: 'same'; base: number; other: number }
  | { k: 'del'; base: number }
  | { k: 'ins'; other: number };

/**
 * 经典 LCS 对齐（返回编辑脚本）。文档规模下 O(n·m) 完全够用：
 * 单文档规模由 validate 的深度/字段约束把住，真到十万块再换 Myers。
 * @param eq 相等判定，默认按字符串全等。块级簇内会放宽成"同类型即同一块的两版"
 *   —— 否则"两端把同一段各改一个字"会被当成一块删除 + 一块新增，
 *   永远进不到 mergeOne，字符级合并形同虚设。
 */
function lcsAlign(base: string[], other: string[], eq?: (a: string, b: string) => boolean): AlignOp[] {
  const same = eq ?? ((a: string, b: string): boolean => a === b);
  const n = base.length;
  const m = other.length;
  if (n === 0 || m === 0) {
    const ops: AlignOp[] = [];
    for (let i = 0; i < n; i++) ops.push({ k: 'del', base: i });
    for (let j = 0; j < m; j++) ops.push({ k: 'ins', other: j });
    return ops;
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = same(base[i]!, other[j]!)
        ? dp[(i + 1) * w + (j + 1)]! + 1
        : Math.max(dp[(i + 1) * w + j]!, dp[i * w + (j + 1)]!);
    }
  }
  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(base[i]!, other[j]!)) {
      ops.push({ k: 'same', base: i, other: j });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) {
      ops.push({ k: 'del', base: i });
      i++;
    } else {
      ops.push({ k: 'ins', other: j });
      j++;
    }
  }
  while (i < n) ops.push({ k: 'del', base: i++ });
  while (j < m) ops.push({ k: 'ins', other: j++ });
  return ops;
}

interface Align {
  /** match[bi] = side 中与 base[bi] 同签名且被配对的下标，-1 = 未配对 */
  match: number[];
  /** ins[i] = base[i] 之前 side 独有的下标；ins[n] = 末尾 */
  ins: number[][];
  /** side 中被 same 配对到的下标集合 */
  kept: Set<number>;
}

function alignOf(base: string[], side: string[], eq?: (a: string, b: string) => boolean): Align {
  const match = new Array<number>(base.length).fill(-1);
  const ins: number[][] = Array.from({ length: base.length + 1 }, () => []);
  const kept = new Set<number>();
  let cur = 0;
  for (const op of lcsAlign(base, side, eq)) {
    if (op.k === 'same') {
      match[op.base] = op.other;
      kept.add(op.other);
      cur = op.base + 1;
    } else if (op.k === 'del') {
      cur = op.base + 1;
    } else {
      ins[cur]!.push(op.other);
    }
  }
  return { match, ins, kept };
}

/* ------------------------------------------------------------------ *
 * 通用三方序列合并（块级与字符级共用）
 * ------------------------------------------------------------------ */

type SigFn<T> = (x: T) => string;

function segEq<T>(a: T[], b: T[], sig: SigFn<T>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (sig(a[i]!) !== sig(b[i]!)) return false;
  return true;
}

/**
 * 三方序列合并。
 * @param mergeOne 三方都有对应时如何合并（base 缺失 = 该块至少一侧是新增）
 * @param onConflict 簇内两侧改法不同且构成删-vs-改时上报
 */
function seqDiff3<T>(
  base: T[],
  left: T[],
  right: T[],
  sig: SigFn<T>,
  mergeOne: (b: T | undefined, l: T, r: T) => T,
  onConflict: (b: T[], l: T[], r: T[]) => void,
  pairable?: (l: T, r: T) => boolean,
): T[] {
  const bs = base.map(sig);
  const ls = left.map(sig);
  const rs = right.map(sig);
  const A = alignOf(bs, ls);
  const B = alignOf(bs, rs);

  // 稳定锚点：两侧都原样保留的 base 位置
  const anchors: number[] = [];
  for (let i = 0; i < base.length; i++) {
    if (A.match[i]! >= 0 && B.match[i]! >= 0) anchors.push(i);
  }

  const out: T[] = [];
  let bi = 0;
  let ai = 0;
  let ci = 0;
  for (let k = 0; k <= anchors.length; k++) {
    const nextBase = k < anchors.length ? anchors[k]! : base.length;
    const nextLeft = k < anchors.length ? A.match[nextBase]! : left.length;
    const nextRight = k < anchors.length ? B.match[nextBase]! : right.length;
    const bSeg = base.slice(bi, nextBase);
    const lSeg = left.slice(ai, nextLeft);
    const rSeg = right.slice(ci, nextRight);
    if (bSeg.length > 0 || lSeg.length > 0 || rSeg.length > 0) {
      out.push(...mergeChunk(bSeg, lSeg, rSeg, sig, mergeOne, onConflict, pairable));
    }
    if (k < anchors.length) {
      // 锚点透传：两侧内容与 base 相同，取 left（与"本地所见"一致）
      out.push(left[nextLeft]!);
      bi = nextBase + 1;
      ai = nextLeft + 1;
      ci = nextRight + 1;
    }
  }
  return out;
}

/** 簇内局部三方合并：先判"只有一侧改"这类简单情形，再逐块对齐 */
function mergeChunk<T>(
  bSeg: T[],
  lSeg: T[],
  rSeg: T[],
  sig: SigFn<T>,
  mergeOne: (b: T | undefined, l: T, r: T) => T,
  onConflict: (b: T[], l: T[], r: T[]) => void,
  /** 同位置配对判定：默认按签名。块级要放宽到"同类型即视为同一块的两版"，
   *  否则"两端把同一段各改一个字"会被当成两块新增/删除，永远进不到 mergeOne */
  pairable?: (l: T, r: T) => boolean,
): T[] {
  const bl = segEq(bSeg, lSeg, sig);
  const br = segEq(bSeg, rSeg, sig);
  if (bl && br) return bSeg.slice();
  if (bl) return rSeg.slice(); // left 未动 → 采纳 right
  if (br) return lSeg.slice(); // right 未动 → 采纳 left
  if (segEq(lSeg, rSeg, sig)) return lSeg.slice();

  // 两侧都动了：把 lSeg 与 rSeg 对齐，逐块合并
  // pairable 工作在元素上；没给就用签名相等
  const canPair: (a: T, b: T) => boolean = pairable ?? ((a, b) => sig(a) === sig(b));
  // baseMap 必须用同一个放宽判定：否则 l↔r 配上了、l↔base 却配不上，
  // mergeOne 会拿到 base=undefined，被误判成"两侧各自新增"而放弃字符级合并
  const mapBL = baseMap(bSeg, lSeg, sig, canPair);
  const LR = alignOfElems(lSeg, rSeg, canPair);
  const leftKeptBase = new Set<number>();
  for (const v of mapBL.values()) if (v >= 0) leftKeptBase.add(v);
  const rightKept = LR.kept;

  const out: T[] = [];
  for (let li = 0; li < lSeg.length; li++) {
    const ri = LR.match[li]!;
    if (ri >= 0) {
      const bj = mapBL.get(li);
      out.push(mergeOne(bj === undefined ? undefined : bSeg[bj], lSeg[li]!, rSeg[ri]!));
      continue;
    }
    // lSeg[li] 在 rSeg 没有对应
    const bj = mapBL.get(li);
    if (bj === undefined) {
      out.push(lSeg[li]!); // left 纯新增 → 采纳
      continue;
    }
    // left 保留了 base[bj]，right 侧没有
    if (sig(lSeg[li]!) === sig(bSeg[bj]!)) continue; // left 也没改 → 干净删除，采纳删除
    onConflict(bSeg, lSeg, rSeg); // 改 vs 删 → 冲突，保 left
    out.push(lSeg[li]!);
  }
  // rSeg 里 left 侧没有的：三种可能，必须分清
  //  ① right 纯新增 → 采纳
  //  ② right 保留着某个 base 块原样，而 left 改过它 → left 的改動已在上面循环输出，
  //     这里必须**跳过**，否则同一段会出现两次（第一段 / 第一段改 这种重复）
  //  ③ right 拿新内容替换掉某个 left 删了的 base 块 → 删 vs 改，报冲突并采纳 right
  for (let ri = 0; ri < rSeg.length; ri++) {
    if (rightKept.has(ri)) continue;
    const si = sig(rSeg[ri]!);
    let baseHit = -1;
    for (let bj = 0; bj < bSeg.length; bj++) {
      if (sig(bSeg[bj]!) === si) {
        baseHit = bj;
        break;
      }
    }
    if (baseHit >= 0) {
      // ② 或 ③
      if (!leftKeptBase.has(baseHit)) continue; // left 删了、right 保留原样 → 采纳删除
      continue; // ③ 已在上面输出过 left 的改法，这里跳过避免重复
    }
    let replaces = false;
    for (let bj = 0; bj < bSeg.length; bj++) {
      if (leftKeptBase.has(bj)) continue; // left 保留了它，谈不上"删 vs 改"
      replaces = true; // left 删了它，right 又换了新内容 → 冲突
      break;
    }
    if (replaces) onConflict(bSeg, lSeg, rSeg);
    out.push(rSeg[ri]!);
  }
  return out;
}

/** 建立 lSeg 下标 → bSeg 下标 的映射（未配对 = left 新增） */
function baseMap<T>(
  bSeg: T[],
  lSeg: T[],
  sig: SigFn<T>,
  pairable?: (a: T, b: T) => boolean,
): Map<number, number> {
  const m = new Map<number, number>();
  const bs = bSeg.map(sig);
  const ls = lSeg.map(sig);
  const ops =
    pairable === undefined
      ? lcsAlign(bs, ls)
      : lcsAlignPairs(bSeg, lSeg, pairable);
  for (const op of ops) {
    if (op.k === 'same') m.set(op.other, op.base);
  }
  return m;
}

/** 元素级 LCS：pairable 判定"这两个元素算同一个"，用于放宽对齐（如"同类型块"） */
function lcsAlignPairs<T>(
  base: T[],
  side: T[],
  pairable: (a: T, b: T) => boolean,
): AlignOp[] {
  const n = base.length;
  const m = side.length;
  if (n === 0 || m === 0) {
    const ops: AlignOp[] = [];
    for (let i = 0; i < n; i++) ops.push({ k: 'del', base: i });
    for (let j = 0; j < m; j++) ops.push({ k: 'ins', other: j });
    return ops;
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = pairable(base[i]!, side[j]!)
        ? dp[(i + 1) * w + (j + 1)]! + 1
        : Math.max(dp[(i + 1) * w + j]!, dp[i * w + (j + 1)]!);
    }
  }
  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (pairable(base[i]!, side[j]!)) {
      ops.push({ k: 'same', base: i, other: j });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) {
      ops.push({ k: 'del', base: i });
      i++;
    } else {
      ops.push({ k: 'ins', other: j });
      j++;
    }
  }
  while (i < n) ops.push({ k: 'del', base: i++ });
  while (j < m) ops.push({ k: 'ins', other: j++ });
  return ops;
}

/** 元素级对齐（输出 match/ins/kept） */
function alignOfElems<T>(base: T[], side: T[], pairable: (a: T, b: T) => boolean): Align {
  const match = new Array<number>(base.length).fill(-1);
  const ins: number[][] = Array.from({ length: base.length + 1 }, () => []);
  const kept = new Set<number>();
  let cur = 0;
  for (const op of lcsAlignPairs(base, side, pairable)) {
    if (op.k === 'same') {
      match[op.base] = op.other;
      kept.add(op.other);
      cur = op.base + 1;
    } else if (op.k === 'del') {
      cur = op.base + 1;
    } else {
      ins[cur]!.push(op.other);
    }
  }
  return { match, ins, kept };
}

/* ------------------------------------------------------------------ *
 * span 序列合并（字符级）
 * ------------------------------------------------------------------ */

/** 字符 token：字符本身 + 全部内联标记。字符级 diff3 的最小粒度 */
interface CharTok {
  ch: string;
  b?: true;
  i?: true;
  u?: true;
  s?: true;
  c?: true;
  rem?: string;
  href?: string;
}

function spansToToks(ss: Span[]): CharTok[] {
  const out: CharTok[] = [];
  for (const s of ss) {
    // 逐 code point 切：按 UTF-16 码元切会把 emoji 劈成两半
    for (const ch of s.t) {
      const t: CharTok = { ch };
      if (s.b) t.b = true;
      if (s.i) t.i = true;
      if (s.u) t.u = true;
      if (s.s) t.s = true;
      if (s.c) t.c = true;
      if (s.rem !== undefined && s.rem !== '') t.rem = s.rem;
      if (s.href !== undefined && s.href !== '') t.href = s.href;
      out.push(t);
    }
  }
  return out;
}

function toksToSpans(ts: CharTok[]): Span[] {
  const out: Span[] = [];
  let cur: Span | null = null;
  for (const t of ts) {
    if (cur && sameMarks(cur, t)) {
      cur.t += t.ch;
      continue;
    }
    if (cur) out.push(cur);
    const s: Span = { t: t.ch };
    if (t.b) s.b = true;
    if (t.i) s.i = true;
    if (t.u) s.u = true;
    if (t.s) s.s = true;
    if (t.c) s.c = true;
    if (t.rem !== undefined) s.rem = t.rem;
    if (t.href !== undefined) s.href = t.href;
    cur = s;
  }
  if (cur) out.push(cur);
  return out;
}

function sameMarks(s: Span, t: CharTok): boolean {
  return (
    !!s.b === !!t.b &&
    !!s.i === !!t.i &&
    !!s.u === !!t.u &&
    !!s.s === !!t.s &&
    !!s.c === !!t.c &&
    (s.rem ?? undefined) === (t.rem ?? undefined) &&
    (s.href ?? undefined) === (t.href ?? undefined)
  );
}

function tokSig(t: CharTok): string {
  return JSON.stringify([t.ch, !!t.b, !!t.i, !!t.u, !!t.s, !!t.c, t.rem ?? null, t.href ?? null]);
}

const charSig = (c: string): string => JSON.stringify(c);

function mergeSpans(b: Span[], l: Span[], r: Span[], at: string, conflicts: Conflict[]): Span[] {
  const bt = spansToToks(b);
  const lt = spansToToks(l);
  const rt = spansToToks(r);
  const toks = seqDiff3<CharTok>(
    bt,
    lt,
    rt,
    tokSig,
    // 字符层没有"合并"概念：两侧对同一位置的标记不同，也算改动，
    // 由 seqDiff3 的 del/ins 通道处理（结果里两个标记的字符都在，不丢字）
    (_b, ll) => ll,
    (bs, ls, rs) => {
      conflicts.push({
        at,
        kind: 'text',
        base: JSON.stringify(bs),
        left: JSON.stringify(ls),
        right: JSON.stringify(rs),
      });
    },
  );
  return toksToSpans(toks);
}

/* ------------------------------------------------------------------ *
 * 块合并
 * ------------------------------------------------------------------ */

const blockSigFn: SigFn<Block> = blockSig;

function mergeBlock(
  b: Block | undefined,
  l: Block,
  r: Block,
  at: string,
  conflicts: Conflict[],
): Block {
  // base 无此块 = 至少一侧新增。两侧都新增且内容不同 → 采纳 left 并报冲突
  if (b === undefined) {
    if (blockSigFn(l) !== blockSigFn(r)) {
      conflicts.push({ at, kind: 'block', base: DELETED, left: blockSigFn(l), right: blockSigFn(r) });
    }
    return l;
  }
  const bk = blockSigFn(b);
  if (blockSigFn(l) === bk) return r;
  if (blockSigFn(r) === bk) return l;
  if (blockSigFn(l) === blockSigFn(r)) return l;

  if (b.t !== l.t || b.t !== r.t) {
    conflicts.push({ at, kind: 'block', base: bk, left: blockSigFn(l), right: blockSigFn(r) });
    return l;
  }

  const out: Block = { t: l.t };

  if (l.t === 'code') {
    const m = seqDiff3<string>(
      (b.text ?? '').split(''),
      (l.text ?? '').split(''),
      (r.text ?? '').split(''),
      charSig,
      (_bb, ll) => ll,
      (bs, ls, rs) => {
        conflicts.push({
          at: at + '.text',
          kind: 'text',
          base: bs.join(''),
          left: ls.join(''),
          right: rs.join(''),
        });
      },
    );
    out.text = m.join('');
    const lang = l.lang !== undefined ? l.lang : r.lang;
    if (lang !== undefined) out.lang = lang;
    return out;
  }

  if (l.t === 'hr') return out;

  if (l.t === 'img') {
    // img 块的 src 在类型上可选，但语义必需（validate 不强制是刻意的：
    // 允许导入过程中的半成品态存在）。这里兜成空串而不是抛错 ——
    // 合并层不能因一份畸形数据把整次同步打断，交给上层渲染时空 src 显示占位。
    const bSrc = b.src ?? '';
    const lSrc = l.src ?? '';
    const rSrc = r.src ?? '';
    const lChanged = lSrc !== bSrc;
    const rChanged = rSrc !== bSrc;
    out.src = lChanged ? lSrc : rSrc;
    if (lChanged && rChanged && lSrc !== rSrc) {
      conflicts.push({
        at: at + '.src',
        kind: 'block',
        base: bSrc,
        left: lSrc,
        right: rSrc,
      });
    }
    const alt = l.imgAlt !== b.imgAlt ? l.imgAlt : r.imgAlt;
    if (alt !== undefined) out.imgAlt = alt;
    return out;
  }

  if (l.spans !== undefined || r.spans !== undefined || b.spans !== undefined) {
    const s = mergeSpans(b.spans ?? [], l.spans ?? [], r.spans ?? [], at + '.spans', conflicts);
    if (s.length > 0) out.spans = s;
  }
  if (l.t === 'fold' && (l.title !== undefined || r.title !== undefined || b.title !== undefined)) {
    const s = mergeSpans(b.title ?? [], l.title ?? [], r.title ?? [], at + '.title', conflicts);
    if (s.length > 0) out.title = s;
  }
  if (l.children !== undefined || r.children !== undefined || b.children !== undefined) {
    const kids = mergeBlockList(
      b.children ?? [],
      l.children ?? [],
      r.children ?? [],
      at + '.children',
      conflicts,
    );
    if (kids.length > 0) out.children = kids;
  }
  return out;
}

function mergeBlockList(
  b: Block[],
  l: Block[],
  r: Block[],
  at: string,
  conflicts: Conflict[],
): Block[] {
  return seqDiff3<Block>(
    b,
    l,
    r,
    blockSigFn,
    (bb, ll, rr) => mergeBlock(bb, ll, rr, at, conflicts),
    (bs, ls, rs) => {
      conflicts.push({
        at,
        kind: 'block',
        base: bs.map(blockSigFn).join(' | ') || DELETED,
        left: ls.map(blockSigFn).join(' | ') || DELETED,
        right: rs.map(blockSigFn).join(' | ') || DELETED,
      });
    },
    // 簇内放宽：同类型即视为"同一块的两个版本"，让 mergeOne 有机会跑字符级合并。
    // 只放宽配对，不放宽"是否改动"的判定（那仍走 sig 比较），所以不会引入假合并。
    (ll, rr) => ll.t === rr.t,
  );
}

/* ------------------------------------------------------------------ *
 * 提醒合并（按 id 三方合并）
 * ------------------------------------------------------------------ */

function remEq(a: Reminder, b: Reminder): boolean {
  return a.at === b.at && a.text === b.text && !!a.done === !!b.done;
}

/**
 * 提醒按**字段**级三方合并，而不是整条原子合并。
 *
 * 为什么必须字段级：一条提醒有三个正交字段（时间、文案、是否完成）。
 * 手机上勾了"已完成"，电脑上同时改了文案 —— 这是两个设备的正常协作，
 * 不是冲突。整条原子比较会把它判成冲突逼用户选，是假冲突。
 * 老项目没有"完成态"所以没暴露这个问题，一加上就炸。
 */
function mergeReminderFields(
  bv: Reminder | undefined,
  lv: Reminder,
  rv: Reminder,
): Reminder {
  if (bv === undefined) {
    // 两侧各自新增同 id：字段级无从比较（没有 base），同值取任一，异值取 left
    return remEq(lv, rv) ? lv : { ...lv };
  }
  const pick = <K extends 'at' | 'text' | 'done'>(k: K): Reminder[K] | undefined => {
    const b = bv[k];
    const l = lv[k];
    const r = rv[k];
    if (JSON.stringify(l) === JSON.stringify(r)) return l;
    if (JSON.stringify(l) === JSON.stringify(b)) return r;
    if (JSON.stringify(r) === JSON.stringify(b)) return l;
    return l; // 三方全异 → 取 left，并由调用方记为字段级冲突
  };
  // at / text 是 Reminder 的必填字段，运行时必然有值（三方都过 validate），
  // 这里兜成空串只是为了满足类型系统；不会产出非法数据。
  const out: Reminder = { id: lv.id, at: pick('at') ?? '', text: pick('text') ?? '' };
  const done = pick('done');
  if (done === true) out.done = true;
  return out;
}

/** 字段级是否真的冲突（三方全异才算；"两端各改一个字段"不算） */
function remFieldConflict(bv: Reminder | undefined, lv: Reminder, rv: Reminder): boolean {
  if (bv === undefined) return !remEq(lv, rv);
  for (const k of ['at', 'text', 'done'] as const) {
    const b = JSON.stringify(bv[k]);
    const l = JSON.stringify(lv[k]);
    const r = JSON.stringify(rv[k]);
    if (l === r) continue;
    if (l === b || r === b) continue; // 只有一侧改这个字段 → 无冲突
    return true; // 两端都改且改得不同
  }
  return false;
}

/**
 * 输出顺序：left 的原始顺序 + 仅存在于 right/base 的追加在后。
 *
 * 不用字典序（第一版用了 sort()，结果 merge(a,a,b) 与 b 的数组顺序不同，
 * 吸收律测试直接红）。理由：提醒在 UI 里有展示顺序（按时间排），
 * 而这个数组的顺序会进 canonical 参与块级 LCS 对齐 —— 用某一侧的稳定顺序
 * 比每次重排更利于两端收敛。字典序虽确定，但会让"远端只是加了一条"变成
 * 整份文档的顺序抖动，徒增冲突。
 */
function reminderOrder(l: Reminder[], r: Reminder[], b: Reminder[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...l, ...r, ...b]) {
    if (!seen.has(x.id)) {
      seen.add(x.id);
      out.push(x.id);
    }
  }
  return out;
}

function mergeReminders(
  b: Reminder[],
  l: Reminder[],
  r: Reminder[],
  conflicts: Conflict[],
): Reminder[] {
  const bMap = new Map(b.map((x) => [x.id, x]));
  const lMap = new Map(l.map((x) => [x.id, x]));
  const rMap = new Map(r.map((x) => [x.id, x]));
  const sorted = reminderOrder(l, r, b);
  const out: Reminder[] = [];
  for (const id of sorted) {
    const bv = bMap.get(id);
    const lv = lMap.get(id);
    const rv = rMap.get(id);

    if (lv !== undefined && rv !== undefined) {
      if (remFieldConflict(bv, lv, rv)) {
        conflicts.push({
          at: `reminders.${id}`,
          kind: 'reminder',
          base: bv === undefined ? DELETED : JSON.stringify(bv),
          left: JSON.stringify(lv),
          right: JSON.stringify(rv),
        });
      }
      out.push(mergeReminderFields(bv, lv, rv));
      continue;
    }

    if (lv !== undefined) {
      // right 没有：right 删了（或两侧各自新增、只有 left 有）
      // base 也没有 → 纯新增，必须采纳（与 right 分支对称，第一版两边都写错成 continue）
      if (bv === undefined) {
        out.push(lv);
        continue;
      }
      if (remEq(bv, lv)) continue; // left 未改、right 删了 → 采纳删除
      conflicts.push({
        at: `reminders.${id}`,
        kind: 'reminder',
        base: JSON.stringify(bv),
        left: JSON.stringify(lv),
        right: DELETED,
      });
      out.push(lv);
      continue;
    }

    if (rv !== undefined) {
      // right 有、left 没有。base 也没有 → 纯新增，必须采纳（第一版这里误写成
      // "bv === undefined 就跳过"，把远端独有的新提醒整条丢了 —— 吸收律测试逮到）
      if (bv === undefined) {
        out.push(rv);
        continue;
      }
      if (remEq(bv, rv)) continue; // right 未改、left 删了 → 采纳删除
      conflicts.push({
        at: `reminders.${id}`,
        kind: 'reminder',
        base: JSON.stringify(bv),
        left: DELETED,
        right: JSON.stringify(rv),
      });
      out.push(rv);
      continue;
    }
    // 两侧都删了 → 不输出
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 三方合并文档。
 * @param base 上次同步时的共同祖先
 * @param left 本地当前态
 * @param right 服务端下发的远端态
 */
export function mergeDocs(base: Doc, left: Doc, right: Doc): MergeResult {
  const conflicts: Conflict[] = [];
  const blocks = mergeBlockList(
    base.blocks ?? [],
    left.blocks ?? [],
    right.blocks ?? [],
    'blocks',
    conflicts,
  );
  const reminders = mergeReminders(
    base.reminders ?? [],
    left.reminders ?? [],
    right.reminders ?? [],
    conflicts,
  );
  return { doc: { v: 1, blocks, reminders }, conflicts };
}

/** 深拷贝一份规范化文档（不改动入参） */
export function cloneDoc(d: Doc): Doc {
  return JSON.parse(canonicalize(d)) as Doc;
}

export { emptyDoc };

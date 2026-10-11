/**
 * 基准脚本 —— 不是单测，不进 `node --test test/*.test.mjs`（文件名不以 .test.mjs 结尾）
 *
 * 用途：实测字符级 diff3（seqDiff3 / lcsAlign）的耗时与内存随单块字符数的增长曲线。
 * 手动跑：
 *   cd packages/shared-schema && node test/bench-diff3.mjs
 *
 * 为什么单独一个文件：单测要秒级跑完，而这里要量 5000 字档的 O(n·m) 展开，
 * 放进单测会拖慢每次回归。数据只用于给人看，不做断言（判据在 merge-lcs-guard.test.mjs）。
 */

import { mergeDocs } from '../src/index.ts';

/* 确定性伪随机：同一 seed 每次跑出同样的文本，改前/改后才可比 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 大字符集（常用汉字区间抽样）：字符重复率低 ⇒ LCS 匹配少 ⇒ 贴近最坏情况 */
const ALPHABET = (() => {
  const out = [];
  for (let i = 0; i < 2000; i++) out.push(String.fromCodePoint(0x4e00 + i * 7));
  return out;
})();

function randText(rnd, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  return s;
}

const docOf = (text) => ({ v: 1, blocks: [{ t: 'p', spans: [{ t: text }] }] });

/** 词表：真实文本里字符是高度重复的，LCS 能找到大量匹配（与随机字符形成对照） */
const WORDS = [
  '同步', '笔记', '加密', '设备', '段落', '标题', '提醒', '图片', '折叠', '清单',
  '本地', '远端', '冲突', '合并', '历史', '版本', '编辑', '删除', '插入', '导出',
];

function wordText(rnd, n) {
  let s = '';
  while (s.length < n) s += WORDS[Math.floor(rnd() * WORDS.length)] + '，';
  return s.slice(0, n);
}

/** 把 text 从 start 起的 len 个字符换成 filler（长度对齐，保证三段等长便于比较） */
function splice(text, start, len, filler) {
  return text.slice(0, start) + filler + text.slice(start + len);
}

/**
 * 三种编辑形态：
 *  - word  ：真实编辑 —— 词构成的正文，两侧各在中间改掉几处（LCS 有大量匹配，冲突少）
 *  - middle：中间 10% 两侧各改成**互不相干**的字符（审计口径；匹配极少 ⇒ 冲突暴多）
 *  - full  ：整段重写（最坏情况）—— 裁剪无用，只能靠阈值兜住
 */
function makeCase(n, kind) {
  const rnd = mulberry32(0xc0ffee + n);
  if (kind === 'word') {
    const base = wordText(rnd, n);
    const holes = [
      [Math.floor(n * 0.2), 20],
      [Math.floor(n * 0.5), 20],
      [Math.floor(n * 0.8), 20],
    ];
    let left = base;
    let right = base;
    for (const [start, len] of holes) {
      left = splice(left, start, len, '甲'.repeat(len));
      right = splice(right, start, len, '乙'.repeat(len));
    }
    return { base: docOf(base), left: docOf(left), right: docOf(right) };
  }
  const base = randText(rnd, n);
  let left;
  let right;
  if (kind === 'middle') {
    const start = Math.floor(n * 0.45);
    const len = Math.max(1, Math.floor(n * 0.1));
    const end = Math.min(n, start + len);
    const lEdit = randText(rnd, end - start);
    const rEdit = randText(rnd, end - start);
    left = base.slice(0, start) + lEdit + base.slice(end);
    right = base.slice(0, start) + rEdit + base.slice(end);
  } else {
    left = randText(rnd, n);
    right = randText(rnd, n);
  }
  return { base: docOf(base), left: docOf(left), right: docOf(right) };
}

function benchOnce(n, kind) {
  const { base, left, right } = makeCase(n, kind);
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const res = mergeDocs(base, left, right);
  const t1 = performance.now();
  const heapAfter = process.memoryUsage().heapUsed;
  return {
    ms: t1 - t0,
    heapDeltaKiB: (heapAfter - heapBefore) / 1024,
    conflicts: res.conflicts.length,
    outLen: (res.doc.blocks?.[0]?.spans?.[0]?.t ?? '').length,
  };
}

function bench(n, kind, reps) {
  // 预热一次，避开 JIT 首次编译的噪声
  benchOnce(n, kind);
  let best = Infinity;
  let heap = 0;
  let conflicts = 0;
  let outLen = 0;
  for (let i = 0; i < reps; i++) {
    const r = benchOnce(n, kind);
    if (r.ms < best) best = r.ms;
    heap = Math.max(heap, r.heapDeltaKiB);
    conflicts = r.conflicts;
    outLen = r.outLen;
  }
  // 字符级 LCS 的理论表大小：seqDiff3 里 lcsAlign 被调 2 次（base↔left、base↔right）
  // 加上簇内 baseMap / alignOfElems 各一次，保守按 2 张主表估
  const tableBytes = (n + 1) * (n + 1) * 4;
  return {
    n,
    kind,
    ms: best,
    heapKiB: heap,
    tableMiB: (tableBytes * 2) / 1024 / 1024,
    conflicts,
    outLen,
  };
}

const SIZES = [500, 1000, 2000, 5000];
const rows = [];
for (const kind of ['word', 'middle', 'full']) {
  for (const n of SIZES) {
    const reps = n >= 2000 ? 2 : 3;
    const r = bench(n, kind, reps);
    rows.push(r);
    console.log(
      `[${kind.padEnd(6)}] n=${String(n).padStart(4)}  ${r.ms.toFixed(1).padStart(8)} ms  ` +
        `heapΔ=${r.heapKiB.toFixed(0).padStart(7)} KiB  LCS表(2张)≈${r.tableMiB.toFixed(1).padStart(6)} MiB  ` +
        `conflicts=${r.conflicts}  outLen=${r.outLen}`,
    );
  }
}

console.log('\n--- 汇总表（改前/改后对照用，直接粘进汇报）---');
console.log('| 形态 | 字符数 | 耗时(ms) | 堆增量(KiB) |');
for (const r of rows) {
  console.log(`| ${r.kind} | ${r.n} | ${r.ms.toFixed(1)} | ${r.heapKiB.toFixed(0)} |`);
}

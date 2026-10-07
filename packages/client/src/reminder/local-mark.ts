/**
 * 提醒打标的**局部改写** —— 把「整篇重建」降级成「只重写 rem 归属变了的块」
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 本文件存在的理由：用户报障第 7 条「经常打字的时候结果换行或者正在打的字被吞掉」
 *
 * ── 病态（结构性，不是偶发）─────────────────────────────────────────────
 *   `registerUpdateListener` 每一次 Lexical update 都跑（零 debounce），
 *   跑完立刻 `reconcileReminders`，只要算出标记有变化就
 *   `ed.update(() => docToLexical(snapshot), { discrete: true })`。
 *   而 `docToLexical` 是 **`root.clear()` + 整篇重建**（serialize.ts:546）。
 *
 *   ⇒ 用户每敲一个字，就可能触发一次整篇 DOM 销毁重建。
 *   ⇒ 组字中的拼音串、当前选区、正在折叠的列表状态，全在这条路上被冲掉。
 *
 *   老项目对照（index.html:6975-6979 `scheduleRemMarkRefresh`）：
 *     `clearTimeout` + **`setTimeout(..., 400)`** + `if (!isLinkifying)` 闸
 *     —— 打标手术被合并成 400ms 一次、且组字中让位。
 *     bj 此前是「零 debounce + 每次整篇重建」，比老项目激进一个数量级。
 *
 * ── 为什么可以只改局部（这个前提是承重的，不是想当然）──────────────────
 *   `reconcileReminders` 的 `markAll` 只写 `span.rem` 字段
 *   （reminder/reconcile.ts:191 `b.spans = markSpans(...)`），
 *   **正文纯文本一个字都不改**；第四步 `r.text = it` 改的是
 *   `Reminder.text`（真源里的提醒文案），同样不碰正文。
 *
 *   ⇒ 对账前后 `blockText` 逐字相等。
 *   ⇒ 所以「rem 归属没变的块」在编辑器里**已经是对的**，不需要重建。
 *      重建它只会白白销毁它的 DOM 与选区。
 *
 * ── 为什么不能用「整篇比较」来代替逐块比较 ─────────────────────────────
 *   整篇只要有一处标记变了，就回到 `root.clear()` ⇒ 回到病态。
 *   逐块比较让「改动面积」正比于「真正需要改的块数」，
 *   长文档里加一条提醒只碰 1 个块，而不是全文。
 *
 * ── 与 IME 门控的关系（**不是替代，是串联**）────────────────────────────
 *   `ime-gate.ts` 挡的是「组字中不许回灌」；
 *   本文件挡的是「即使放行，也不该重建没变的块」。
 *   两个都去掉才会复现第 7 条；只去掉其一，第 7 条仍会以更轻的形态复发。
 */

/** 一段行内内容的「纯文本 + 每个字符所属的 remId」，用于逐块比对。 */
export interface BlockFingerprint {
  /** 纯文本（含 '\n'，与 flatten 的拼接口径一致）。 */
  text: string;
  /** 与 text 等长的数组，每格是那一个字符的 remId（无标记则空串）。 */
  rems: string[];
}

/** 取一段行内内容的指纹。**长度即 rems.length**，这是本文件的核心不变量。 */
export function fingerprintOf(spans: ReadonlyArray<{ t: string; rem?: string }>): BlockFingerprint {
  let text = '';
  const rems: string[] = [];
  for (const s of spans) {
    const rem = s.rem ?? '';
    for (const ch of s.t) {
      text += ch;
      rems.push(rem);
    }
  }
  return { text, rems };
}

/** 两个指纹是否**完全**一致（纯文本与 rem 归属都一致）。 */
export function sameFingerprint(a: BlockFingerprint, b: BlockFingerprint): boolean {
  if (a.text !== b.text) return false;
  for (let i = 0; i < a.rems.length; i += 1) {
    if (a.rems[i] !== b.rems[i]) return false;
  }
  return true;
}

/**
 * 逐块对齐两个块列表，返回**下标对应关系**。
 *
 * 🔴🔴 为什么必须按下标对齐而不是靠内容查找：
 *   `root.clear()` 那条路上，编辑器里的第 i 个块与真源里的第 i 个块
 *   **在结构上一一对应**（docToLexical 就是顺序 append）。
 *   而按内容查找（`find(b => sameText(b, cur))`）在重复段落上会错位：
 *   文档里有三个「开会」，删掉中间那个之后，后面两个会**都**被匹配到第一个
 *   ⇒ 局部改写把标记铺到错误的块上。
 *   症状是"下划线跑到了别的段"，且极难复现（取决于正文有没有重复段落）。
 *
 *   返回 `null` 表示两边长度不等 —— 调用方**必须整篇重建**（结构变了，
 *   逐块对齐没有意义）。这不是可以"凑合"的降级。
 */
export function alignBlocks(
  before: readonly BlockFingerprint[],
  after: readonly BlockFingerprint[],
): number[] | null {
  if (before.length !== after.length) return null;
  const out: number[] = [];
  for (let i = 0; i < before.length; i += 1) out.push(i);
  return out;
}

/** 一次局部改写的结论。 */
export interface LocalMarkPlan {
  /** 需要重建的块下标（升序、去重）。其余块**一个字都不许碰**。 */
  rebuild: number[];
  /**
   * 必须整篇重建的原因；`null` 表示可以走局部路径。
   *
   * `'block-count'`：块数变了（对账自己不改块数，所以这条命中等于有 bug，
   *   但仍必须整篇重建 —— 宁可多重建一次，也不能错位铺标记）。
   */
  fullRebuildReason: 'block-count' | null;
}

/**
 * 算出「这次对账需要重建哪些块」。
 *
 * @param before 对账**前**编辑器里的块指纹（从 Lexical 当前树取，不是从真源取）
 * @param after  对账**后**的块指纹（从 `rec.doc` 取）
 */
export function planLocalMarkRewrite(
  before: readonly BlockFingerprint[],
  after: readonly BlockFingerprint[],
): LocalMarkPlan {
  const idx = alignBlocks(before, after);
  if (idx === null) return { rebuild: [], fullRebuildReason: 'block-count' };
  const rebuild: number[] = [];
  for (const i of idx) {
    if (!sameFingerprint(before[i]!, after[i]!)) rebuild.push(i);
  }
  return { rebuild, fullRebuildReason: null };
}

/* ------------------------------------------------------------------ *
 * 接 main.ts 用的两个适配（刻意留在本文件，与规划逻辑同源可测）
 * ------------------------------------------------------------------ */

/**
 * 一句话：一个块的指纹 = 自己的行内内容 + 全部子孙的行内内容（聚合，不展平）。
 *
 * 🔴🔴 只声明"它至少是个块"，不 import `Block`：
 *   shared-schema 的 `Block.children` 是可变 `Block[]`，
 *   而真源 doc 在本仓多处是 `readonly Block[]`（`exactOptionalPropertyTypes: true`），
 *   直接 import 会在这两个 readonly 口径之间打架。结构兼容即可，不必是同一个类型。
 */
type FingerprintNode = {
  text?: string;
  spans?: ReadonlyArray<{ t: string; rem?: string }>;
  title?: ReadonlyArray<{ t: string; rem?: string }>;
  children?: ReadonlyArray<FingerprintNode>;
};

/**
 * 取一份真源 Doc 的**顶层块**指纹数组。
 *
 * 🔴🔴🔴 **一格对一根顶层块，绝不把 children 展平成额外下标** ——
 *   `replaceBlocksAt` 的 `indexes` 指向 root 的**直接子节点**，
 *   而 docToLexical 的 blockToNode 对 `fold` 是**一个 FoldNode 装全部子块**
 *   （serialize.ts:167）。若把子树展平，算出来的下标会指向 fold 内部
 *   ⇒ 轻则越界抛错，重则**铺错位置**（标记跑到别的块上）。
 *
 * 🔴🔴🔴 **但子树内容必须聚合进那一格，否则"感知变化"这一半就瞎了** ——
 *   这是一个真实回归（复核独立发现，判据 REMLOCAL-09~12 钉住）：
 *   只取顶层时，`fold` 的顶层纯文本 = `title`（`reconcile.blockText` 对 fold
 *   走 `b.title` 分支）⇒ 子块里任何 rem 变化都不改变顶层指纹；
 *   `ul/ol` 既无 text 也无 spans 也无 title ⇒ 兜底成 `{text:'',rems:[]}`
 *   ⇒ 对列表项完全盲。两者都让 `chooseRewritePath` 返回 `'none'` ⇒ 零写
 *   ⇒ **折叠块/列表里的提醒下划线永远铺不上、也永远删不掉**，
 *     而真源里 rem 是对的、提醒会响、屏上没有下划线、全程零报错。
 *
 *   ⇒ 两件事必须分开做：**下标只到顶层，内容要递归聚合**。
 *
 * 🔴 块的纯文本口径必须与 `reconcile.blockText` 一致（text / spans / title 三选一），
 *   否则两边算出的 `text` 对不上，`sameFingerprint` 会把"没变的块"判成"变了"。
 *
 * 🔴 聚合用 '\n' 连接（与 `reconcile.flatten` 的块间换行同款），
 *   否则相邻两块「AB」+「CD」与「ABCD」会算出同一个 text。
 */
export function blockFingerprintsOf(doc: {
  blocks?: ReadonlyArray<FingerprintNode>;
}): BlockFingerprint[] {
  const out: BlockFingerprint[] = [];
  for (const b of doc.blocks ?? []) {
    out.push(fingerprintOfNode(b));
  }
  return out;
}

function fingerprintOfNode(b: FingerprintNode): BlockFingerprint {
  // 🔴 先按 blockText 的三选一口径取自己的部分。三者都缺（如 ul/hr）
  //   ⇒ 这一格从子块起头，不贡献任何"自己的"行内内容。
  let own: BlockFingerprint;
  if (typeof b.text === 'string') {
    // code 块：没有行内结构，整块一个 rem（正常是空串）
    own = fingerprintOf([{ t: b.text }]);
  } else if (Array.isArray(b.spans)) {
    own = fingerprintOf(b.spans);
  } else if (Array.isArray(b.title)) {
    own = fingerprintOf(b.title);
  } else {
    own = fingerprintOf([{ t: '' }]);
  }

  if (!Array.isArray(b.children) || b.children.length === 0) return own;

  // 🔴 递归聚合子孙：每一层的 text 与 rems 都要并进来。
  //   用 '\n' 分隔，与 reconcile.flatten 的块间换行同口径（防「AB」+「CD」撞「ABCD」）。
  let text = own.text;
  let rems = own.rems;
  for (const child of b.children) {
    const sub = fingerprintOfNode(child as FingerprintNode);
    if (text !== '' && sub.text !== '') {
      text += '\n';
      rems.push('');
    } else if (text === '' && sub.text === '') {
      // 两边都空：跳过，避免引入一个无意义的换行
    }
    text += sub.text;
    for (const r of sub.rems) rems.push(r);
  }
  return { text, rems };
}

/**
 * 局部重写的**决策**：给定 before/after 指纹，返回该走哪条路。
 *
 * 🔴 为什么把"全都要改就整篇重建"这条判据放在**纯逻辑**里而不是 main.ts：
 *   它是一条真实的性能不变量（改动面积不该随文档长度线性增长），
 *   放在调用方就变成"测不到"—— 出处越靠近 IO，越难被单测钉住。
 *
 * @param total 顶层块总数（用 before.length 即可）
 */
export function chooseRewritePath(plan: LocalMarkPlan, total: number): 'none' | 'local' | 'full' {
  if (plan.fullRebuildReason !== null) return 'full';
  if (plan.rebuild.length === 0) return 'none';
  // 🔴 每一块都要改 ⇒ 局部比整篇还多绕一圈，直接整篇。
  //   `total === 0` 那种空文档退化情形也归到 full（此时 rebuild 必为空，
  //   上面的 'none' 已经先返回了，所以走不到这里）。
  if (plan.rebuild.length >= total) return 'full';
  return 'local';
}

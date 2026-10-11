/**
 * v3.0.10 —— 跨段组字串塌方守卫
 *
 * ── 真因（见飞行记录器 v3.0.9 取证，用户 v3.0.9 日志）──────────────────────
 *   豆包「智能整理/精炼润色」把整篇正文作为一个组字串（insertCompositionText）
 *   替换。Lexical 的 composition 模型基于**单个 TextNode**（composition key =
 *   anchor 节点），$updateSelectedTextFromDOM → $updateTextNodeFromDOMContent
 *   只读 `getAnchorTextFromDOM(anchorNode)` 那一个 DOM 节点的文本写回那一个
 *   节点（Lexical.dev.js:21095 / 21108 / 21119）。
 *
 *   当组字串跨多个段落、整篇被收进 anchor 节点、其余段落 DOM 被浏览器移除时，
 *   Lexical 只回灌 anchor 那 19 字，其余 97 字随模型 reconcile 被吞 —— 单条
 *   update 内 116→19，全程零 tree:* / gate:*（四道 IME 门控都没触发，因为根本
 *   没走程序化动树，是 Lexical 原生合成回灌自己吞的）。
 *
 * ── 修法 ─────────────────────────────────────────────────────────────────
 *   在 update 监听里检测「合成进行中 + 单帧灾难性塌方」，发生时立刻把真源回退到
 *   塌方前那帧（`before`），并重建树，避免把损坏状态写回真源 / 推到远端。
 *
 *   🔴 双保险触发条件（避免误伤正常打字）：
 *     ① 跨段合成（组字输入事件时选区跨多个顶层块，豆包整理=全选替换）；
 *     ② 极端的单帧塌方（即便没捕获到 compositionstart，丢字 >70% 且 prev 很大
 *        也兜住）。正常打字每帧只是几个字的增删，两类都碰不到。
 * 🔴🔴 激活由输入事件流的 isComposing 驱动（beforeinput/input 的 isComposing，
 *   含 compositionstart 与 insertCompositionText 两条路径），不再只靠 compositionstart
 *   DOM 事件 —— 豆包智能整理常不发 compositionstart，v3.0.10 因此从不激活而漏拦。
 *
 * ── 判据纪律 ─────────────────────────────────────────────────────────────
 *   decideCollapseRestore 是纯函数，COMPOSE-01~06 钉它；ComposeGuard 状态机
 *   COMPOSE-07~09 钉它。真实塌方无法在桌面复现（Android InputConnection 专属），
 *   桌面用 e2e 26 驱动真实 update 监听 + 合成事件模拟验证，真机靠飞行记录器回传。
 */

export interface ComposeGuardConfig {
  /** 绝对丢字阈值（字符）：单帧丢掉这么多才算"灾难性"。 */
  absDrop: number;
  /** 相对丢字阈值（0..1）：current < prev*(1-relDrop) 才算。 */
  relDrop: number;
  /** prev 至少多长才参与判定（短文档少量删除不误伤）。 */
  minPrev: number;
  /** 极端塌方判定：current < prev*extremeRel 且 prev > minPrev 的若干倍。 */
  extremeRel: number;
  /** 极端塌方判定：prev 需超过 minPrev 的倍数。 */
  extremePrevMult: number;
}

export const DEFAULT_COMPOSE_GUARD: ComposeGuardConfig = {
  absDrop: 30,
  relDrop: 0.5,
  minPrev: 40,
  extremeRel: 0.3,
  extremePrevMult: 2,
};

export interface CollapseDecision {
  restore: boolean;
  reason: string;
}

/**
 * 纯判定：给定当前帧与上一帧正文本长度，决定是否要把真源回退到塌方前。
 *
 * 🔴 先红后改的反例（删实现=下限，组合攻击才算真判据）：
 *   - 把 `multiBlock` 分支删掉 ⇒ 跨段整理不再被拦（COMPOSE-01 红）；
 *   - 把 `relDrop` 判据删掉 ⇒ 116→100 这种小幅删除也误拦（COMPOSE-02 红）；
 *   - 把极端塌方分支删掉 ⇒ 没捕获到 compositionstart 时整篇被吞无兜底
 *     （COMPOSE-03 红）；
 *   - 把 `minPrev` 判据删掉 ⇒ 短文档正常编辑误伤（COMPOSE-04 红）。
 */
export function decideCollapseRestore(opts: {
  currentLen: number;
  prevLen: number;
  multiBlock: boolean;
  cfg: ComposeGuardConfig;
}): CollapseDecision {
  const { currentLen, prevLen, multiBlock, cfg } = opts;
  if (prevLen < cfg.minPrev) return { restore: false, reason: 'prev<min' };
  const drop = prevLen - currentLen;
  if (drop < cfg.absDrop) return { restore: false, reason: 'drop<abs' };
  if (currentLen >= prevLen * (1 - cfg.relDrop)) return { restore: false, reason: 'rel-ok' };
  // 跨段合成：只要单帧灾难性塌方就回退（豆包整理=全选替换，塌方即丢字）。
  if (multiBlock) {
    return { restore: true, reason: `multiBlock collapse ${prevLen}->${currentLen}` };
  }
  // 极端塌方兜底：单帧丢掉 >70% 且原文很长 —— 正常打字绝不会这样。
  if (currentLen < prevLen * cfg.extremeRel && prevLen > cfg.minPrev * cfg.extremePrevMult) {
    return { restore: true, reason: `extreme collapse ${prevLen}->${currentLen}` };
  }
  return { restore: false, reason: 'single-block' };
}

/**
 * 状态机：compositionstart 调 begin()，每个组字输入事件调 noteComposingInput()，
 * 每次 update 调 observe(currentLen, composing)。observe 用「上一帧长度」做判定，
 * 再更新跟踪。
 *
 * 🔴🔴 v3.0.11 修正（v3.0.10 漏拦真因）：激活不再只靠 compositionstart DOM 事件。
 *   豆包「智能整理/精炼润色」常**只发 insertCompositionText、不发 compositionstart**，
 *   导致 v3.0.10 的守卫从不激活 ⇒ 塌方被漏掉（用户侧仍丢字）。故 observe 的
 *   composing 由**输入事件流的 isComposing** 决定（beforeinput/input 的 isComposing
 *   可靠，v3.0.9 飞行日志证到 `in:i insertCompositionText comp=1`），且 lastLen
 *   每帧都维护，漏掉 compositionstart 时 prevLen 依然正确。
 */
export class ComposeGuard {
  private active = false;
  private multiBlock = false;
  private lastLen = 0;
  private restored = false;
  private readonly cfg: ComposeGuardConfig;

  constructor(cfg: ComposeGuardConfig = DEFAULT_COMPOSE_GUARD) {
    this.cfg = cfg;
  }

  /** compositionstart：捕获跨段标志 + 基准长度（豆包整理=全选替换）。 */
  begin(multiBlock: boolean, currentLen: number): void {
    this.active = true;
    this.multiBlock = this.multiBlock || multiBlock;
    this.lastLen = currentLen;
    this.restored = false;
  }

  /** 组字输入事件（insertCompositionText，常不发 compositionstart 时的兜底）：同样喂跨段标志。 */
  noteComposingInput(multiBlock: boolean): void {
    this.active = true;
    this.multiBlock = this.multiBlock || multiBlock;
  }

  end(): void {
    this.active = false;
    this.multiBlock = false;
  }

  get isActive(): boolean {
    return this.active;
  }

  get isMultiBlock(): boolean {
    return this.multiBlock;
  }

  get didRestore(): boolean {
    return this.restored;
  }

  /**
   * 每帧调一次。
   * @param composing 本次 update 是否处在组字中 —— 由输入事件流的 isComposing 决定，
   *   不再只依赖 compositionstart DOM 事件（豆包智能整理常不发它，v3.0.10 因此漏拦）。
   * 🔴 无论是否激活都维护 lastLen，使 prevLen 始终为上一帧真实长度，
   *   漏掉 compositionstart 时也能正确判定单帧塌方。
   */
  observe(currentLen: number, composing: boolean): CollapseDecision {
    const prevLen = this.lastLen;
    this.lastLen = currentLen;
    if (!composing) {
      this.active = false;
      return { restore: false, reason: 'not-composing' };
    }
    this.active = true;
    const dec = decideCollapseRestore({
      currentLen,
      prevLen,
      multiBlock: this.multiBlock,
      cfg: this.cfg,
    });
    if (dec.restore) this.restored = true;
    return dec;
  }
}

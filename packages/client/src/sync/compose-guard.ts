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
 * 🔴🔴 v3.1.5 判据顺序修正（真机 v3.1.4 日志钉死）：composing-mismatch 指纹
 *   （组字串远长于文档**且树真在掉**）必须**先于一切幅度阈值**判定。v3.1.3 把它
 *   放在 drop<abs / rel-ok / minPrev 之后 —— 而真机的第二跳正是 21→9（帧间仅掉
 *   12 字 < absDrop=30，且 prevLen=21 < minPrev=40），两个早退把分支闷死，
 *   残串落账、组字帧全程空转。该指纹与帧间掉幅**大小**无关：串还在、树远低于串
 *   = 写入没落地（宿主替换区域错位），本身就是必拦信号。
 *   ⚠️ 但"树纹丝不动 + 串远长于树"是锚点死亡空转形状，**故意不拦**（留给
 *   v3.0.19 的空转检测：4 帧 ⇒ wd:dead + wd:reboot 自愈）——mismatch 拦它会让
 *   scheduleDeferredTreeSync 每帧清零 stall 计数，reboot 永远数不到 4
 *   （WD-E2E-05/06/07 实锤）。分工：树在掉 ⇒ 拦+冻结保模型；树冻住 ⇒ reboot。
 *
 * 🔴 先红后改的反例（删实现=下限，组合攻击才算真判据）：
 *   - 把 `multiBlock` 分支删掉 ⇒ 跨段整理不再被拦（COMPOSE-01 红）；
 *   - 把 `relDrop` 判据删掉 ⇒ 116→100 这种小幅删除也误拦（COMPOSE-02 红）；
 *   - 把极端塌方分支删掉 ⇒ 没捕获到 compositionstart 时整篇被吞无兜底
 *     （COMPOSE-03 红）；
 *   - 把 `minPrev` 判据删掉 ⇒ 短文档正常编辑误伤（COMPOSE-04 红）。
 *   - 把 composing-mismatch 分支删掉 ⇒ 单段宿主替换错位漏拦（COMPOSE-10 红）；
 *   - 把 mismatch 分支挪回幅度阈值之后 ⇒ 真机 21→9 形状重新漏拦（COMPOSE-12 红）；
 *   - 把 mismatch 的 `currentLen < prevLen` 条件删掉 ⇒ 空转帧被 collapse 拦，
 *     stall 计数每帧被清零 ⇒ reboot 不触发（WD-E2E-05/06/07 红）。
 */
export function decideCollapseRestore(opts: {
  currentLen: number;
  prevLen: number;
  multiBlock: boolean;
  cfg: ComposeGuardConfig;
  /** 🔴🔴 v3.1.3：组字串长度（beforeinput 的 data 长度，可选）。语义：组字中
   *  树长骤降但组字串仍远长于文档（> current + 12）＝宿主替换区域错位把树啃了
   *  （串还在、树丢了）——不是用户删字（删字会连组字串一起变短）⇒ 必拦。
   *  不传（旧调用方/旧判据）保持旧行为。 */
  composingDataLen?: number;
}): CollapseDecision {
  const { currentLen, prevLen, multiBlock, cfg, composingDataLen } = opts;
  // 🔴🔴🔴 v3.1.5：指纹优先——但只拦**树在掉**的帧。组字串远长于文档 = 组字
  //   写入没落地（宿主替换区域错位/锚点死亡），与帧间掉幅大小、文档长短都无关，
  //   必须先于下面所有幅度阈值判定（真机 v3.1.4：21→9 帧间掉 12 字 +
  //   prevLen=21<minPrev，两个早退曾把 v3.1.3 的分支闷死；COMPOSE-12 钉这形状）。
  //   🔴 为什么必须带 `currentLen < prevLen`（树真掉了）而不是只看串远长于树：
  //   「树纹丝不动 + 串远长于树」是**锚点死亡空转**形状，归空转检测管
  //   （连续 4 帧 ⇒ wd:dead + wd:reboot 自愈）。mismatch 若也拦这种帧，每个
  //   空转帧都会走 collapse restore ⇒ scheduleDeferredTreeSync 把 stall 计数
  //   清零 ⇒ reboot 永远数不到 4（WD-E2E-05/06/07 实锤红过）。两个机制按
  //   「树在掉 ⇒ 拦+冻结保模型」/「树冻住 ⇒ reboot 救屏幕」分工，互不踩踏。
  if (composingDataLen != null && currentLen < prevLen && composingDataLen > currentLen + 12) {
    return { restore: true, reason: `composing-mismatch ${prevLen}->${currentLen} d=${composingDataLen}` };
  }
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
  // 🔴 v3.1.3 原位的单段「宿主替换错位」兜底已上移到函数顶部（v3.1.5：
  //   放这里会被 drop<abs / prev<min 早退闷死——真机 21→9 实锤）。
  //   真机 v3.1.1/v3.1.2 日志：143→49（掉 66%，extreme 差 6 字没过）与
  //   49→9（prevLen=49 < 80 下限）两次全部 single-block 放行 ⇒ 残串写进真源
  //   并 push 到云端（内容真丢）。指纹一致：组字串恒定（143/140）而树骤降。
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
   * @param composingDataLen 🔴 v3.1.3：组字串长度（beforeinput 的 data 长度），
   *   喂「宿主替换错位」判定（composing-mismatch）——不传保持旧行为。
   * 🔴 无论是否激活都维护 lastLen，使 prevLen 始终为上一帧真实长度，
   *   漏掉 compositionstart 时也能正确判定单帧塌方。
   */
  observe(
    currentLen: number,
    composing: boolean,
    composingDataLen?: number,
  ): CollapseDecision {
    const prevLen = this.lastLen;
    this.lastLen = currentLen;
    if (!composing) {
      this.active = false;
      return { restore: false, reason: 'not-composing' };
    }
    this.active = true;
    // 🔴 exactOptionalPropertyTypes 全开：可选属性不接受显式 undefined，
    //   用条件展开只在真有值时带上键。
    const dec = decideCollapseRestore({
      currentLen,
      prevLen,
      multiBlock: this.multiBlock,
      cfg: this.cfg,
      ...(composingDataLen != null ? { composingDataLen } : {}),
    });
    if (dec.restore) this.restored = true;
    return dec;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * v3.0.14 —— 组字会话水位线（撤稿吞字守卫）
 *
 * ── 真因（v3.0.13 真机日志钉死的新形状）─────────────────────────────────
 *   塌方守卫盯的是「单帧灾难性掉幅」（≥30 字且 ≥50%）。v3.0.13 真机两份日志：
 *   collapse=17 全在早期、组字中缩水（compose:drop）2→6 次**全部低于阈值**、
 *   最终文档只剩第一句 13 字 —— 豆包语音的丢字走了另一条路：
 *   组字会话内渐进放血（语音重识别修订，每步 -20 左右，碰不到阈值）+
 *   会话收尾时整段撤稿（compositionend 后组字内容被宿主整体撤掉）。
 *   单帧模型对这两类**全盲**。
 *
 * ── 修法：盯会话水位线，不盯单帧 ────────────────────────────────────────
 *   一段组字会话（composing 连续为真）内记**峰值长度**与**峰值帧文档**；
 *   会话结束（composing 转假的那帧）时若真源比峰值掉了超过
 *   max(floorAbs, peak × floorRel) ⇒ 判「撤稿吞字」⇒ 把峰值帧文档回写真源。
 *   此时组字已结束，重建不再杀活组字，与输入法无对抗：
 *     - 会话内修订缩水：不触发（只看会话结束帧），峰值随增长更新；
 *     - 收尾去填充词（呃/那个，掉十几字）：floorRel=15% 容差内不误伤；
 *     - 撤稿（掉到只剩开头一句）：掉幅远超容差 ⇒ 救回整段口述。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 *   WD-01~07（compose-guard.test.mjs）先红后改；e2e 28 钉真实 update 监听
 *   全链路（组字增长 → 撤稿帧 → 真源回到峰值）。
 * ───────────────────────────────────────────────────────────────────────── */

export interface WithdrawGuardConfig {
  /** 会话结束帧：掉幅超过 max(floorAbs, peak×floorRel) 才判撤稿。 */
  floorAbs: number;
  floorRel: number;
}

export const DEFAULT_WITHDRAW_GUARD: WithdrawGuardConfig = {
  floorAbs: 12,
  floorRel: 0.15,
};

export interface WithdrawDecision {
  restore: boolean;
  /** 判撤稿时回写的峰值帧文档（守卫不解释内容，只存引用）。 */
  doc: unknown;
  peakLen: number;
  currentLen: number;
  reason: string;
}

export class WithdrawGuard {
  /** active=组字会话进行中；ending=组字态已转假、撤稿宽限窗口（见下）；idle=无会话。 */
  private phase: 'idle' | 'active' | 'ending' = 'idle';
  private peakLen = 0;
  private peakDoc: unknown = null;
  /** ending 相位剩余判定次数：ce 的 flush update 常在真源被啃短**之前**到达
   *  （e2e 探针实测：in:ce → upd len=108 d=0 → upd len=13 d=-95），会话结束
   *  帧看到的还是峰值长度 ⇒ 判定必须再宽限 2 帧，等撤稿落地。 */
  private evalsLeft = 0;
  /** 🔴🔴🔴 v3.3.2：ending 宽限窗口的**时间**收口时刻。豆包润色是用户说完隔数秒
   *  才点豆包触发的非组字整段替换（insertText comp=0，121→44），它会作为 cmp:end
   *  之后下一个 comp=0 帧落进 ending 窗口被误判「撤稿」回滚、润色被吃掉。原窗口
   *  按帧计数（evalsLeft）无法区分「cmp:end 同帧 flush 延迟掉字（<33ms）」与
   *  「数秒后的刻意润色」，所以这里再按时间收口：超 endingWindowMs 的 comp=0 掉字
   *  是刻意编辑（润色/手删），不回滚。 */
  private endingEnteredAt = 0;
  private readonly endingWindowMs = 1500;
  private readonly cfg: WithdrawGuardConfig;

  constructor(cfg: WithdrawGuardConfig = DEFAULT_WITHDRAW_GUARD) {
    this.cfg = cfg;
  }

  get isSessionActive(): boolean {
    return this.phase !== 'idle';
  }

  get peak(): number {
    return this.peakLen;
  }

  private evaluate(currentLen: number): WithdrawDecision {
    const peak = this.peakLen;
    const peakDoc = this.peakDoc;
    const drop = peak - currentLen;
    const threshold = Math.max(this.cfg.floorAbs, peak * this.cfg.floorRel);
    if (drop > threshold && peakDoc != null) {
      // 撤稿实锤：消费掉 pending（恢复帧自身 composing=false 且 phase=idle ⇒ 幂等）
      this.phase = 'idle';
      this.peakLen = 0;
      this.peakDoc = null;
      this.evalsLeft = 0;
      return {
        restore: true,
        doc: peakDoc,
        peakLen: peak,
        currentLen,
        reason: `withdraw ${peak}->${currentLen} drop=${drop}>${threshold.toFixed(1)}`,
      };
    }
    return { restore: false, doc: null, peakLen: peak, currentLen, reason: 'within-tolerance' };
  }

  /**
   * 每次 update 调一次（与 ComposeGuard.observe 同一调用点，同一 composing 口径）。
   * @param currentLen 本帧导出文档的正文本长度
   * @param composing 本帧是否组字中（输入事件流 isComposing ∨ editor.isComposing()）
   * @param prevLen 上一帧长度（仅日志/未来扩展用；会话起点基准不需要单独存）
   * @param exported 本帧导出文档（守卫只存引用，用于撤稿时回写峰值帧）
   */
  observe(
    currentLen: number,
    composing: boolean,
    prevLen: number,
    exported: unknown,
  ): WithdrawDecision {
    if (composing) {
      if (this.phase === 'ending') {
        // 组字还在继续（comp=1 帧又来了）⇒ 刚才的缩水是**修订**不是撤稿：
        // 中止 pending，峰值以当前帧为基准重续（继续对抗历史峰值会与输入法打架）。
        this.phase = 'active';
        this.peakLen = currentLen;
        this.peakDoc = exported;
        this.evalsLeft = 0;
        return { restore: false, doc: null, peakLen: this.peakLen, currentLen, reason: 'resumed' };
      }
      if (this.phase === 'idle') {
        this.phase = 'active';
        this.peakLen = currentLen;
        this.peakDoc = exported;
        return { restore: false, doc: null, peakLen: this.peakLen, currentLen, reason: '' };
      }
      if (currentLen > this.peakLen) {
        this.peakLen = currentLen;
        this.peakDoc = exported;
      }
      return { restore: false, doc: null, peakLen: this.peakLen, currentLen, reason: '' };
    }
    // composing=false：
    if (this.phase === 'active') {
      // 组字态转假的第一帧：立即判定（撤稿已在同一帧落地时这里直接命中），
      // 同时进入 ending 宽限（ce 的 flush 先到、撤稿后到的情况靠这两帧兜住）。
      this.phase = 'ending';
      this.evalsLeft = 2;
      this.endingEnteredAt = Date.now();
      return this.evaluate(currentLen);
    }
    if (this.phase === 'ending') {
      // 🔴🔴🔴 v3.3.2：时间窗外（>endingWindowMs）的 comp=0 掉字 = 用户/豆包
      //  刻意编辑（润色或手删），不是 IME 同步塌方 ⇒ 直接判 idle、不回滚。
      //  cmp:end 同步塌方在 <33ms 内落地（远小于窗口）；豆包润色隔数秒才来。
      if (Date.now() - this.endingEnteredAt > this.endingWindowMs) {
        this.phase = 'idle';
        this.peakLen = 0;
        this.peakDoc = null;
        this.evalsLeft = 0;
        return {
          restore: false,
          doc: null,
          peakLen: 0,
          currentLen,
          reason: 'ending-window-expired t=' + (Date.now() - this.endingEnteredAt),
        };
      }
      this.evalsLeft -= 1;
      if (this.evalsLeft <= 0) {
        this.phase = 'idle';
        this.peakLen = 0;
        this.peakDoc = null;
        return { restore: false, doc: null, peakLen: 0, currentLen, reason: 'pending-expired' };
      }
      return this.evaluate(currentLen);
    }
    return { restore: false, doc: null, peakLen: 0, currentLen, reason: '' };
  }
}

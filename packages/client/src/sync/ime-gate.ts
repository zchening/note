/**
 * IME（输入法组字）门控 —— 用户报障第 7 条的第一半
 *
 *   「经常打字的时候结果换行或者正在打的字被吞掉，
 *     不知道是不是因为打字的时候笔记在同步导致。」
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴🔴🔴 **病根不是"同步"，是"回灌"。**
 *   bj 有三条把远端内容整篇写回编辑器的路径：
 *     ① main.ts 的 `setDoc` → `docToLexical`（合并/采纳远端后）
 *     ② main.ts 的 Lexical `registerUpdateListener` → 对账后 `docToLexical` 整篇重写
 *     ③ 提醒面板 `setDoc` 后的回灌
 *   三条**都没有 IME 门控**。而 `docToLexical` 是 `root.clear()` + 整篇重建 ——
 *   它在**输入法正在组字**时执行，等于把未上屏的拼音串与编辑器已提交的文本对调，
 *   轻则吞字、重则吞掉刚敲的回车。
 *
 * ── 老项目的四道门（逐条承接，index.html 是唯一行为参照）──────────────────
 *   ① 输入事件入口就拦（`beforeinput`/按键层）
 *   ② `applyRemoteBody` 的**首行**就 return（应用远端前先判组字中）
 *   ③ `autoMergeSave`（自动合并保存）里判组字中
 *   ④ 轮询应用远端前额外判**打字活跃期**（最后一次输入不足 1.5 秒就推迟）
 *
 * ── 🔴🔴 为什么 bj 不能照抄老项目的"模块级单例 isComposing" ────────────────
 *   老项目 index.html 是一个文件、全局一个编辑器 ⇒ 模块级单例就够。
 *   bj 是多页 SPA：同一标签页里会反复 `mountEditor`（换笔记、进出备份笔记…），
 *   模块级标志会在**旧编辑器卸载、新编辑器挂载**之间残留：
 *     · 残留 true ⇒ 新编辑器**永远**不回灌（看起来"同步坏了"）
 *     · 残留 false ⇒ 恰恰相反，什么都拦不住
 *   ⇒ 必须做成**按挂载实例独立**的门控，由 `mountEditor` 显式创建与解绑。
 *   这是本模块存在的唯一理由，也是它不能被"简化成一个布尔变量"的原因。
 */

/** 打字活跃期：最后一次输入距今不足这个毫秒数，就认为用户正在打字。 */
const TYPE_ACTIVE_MS = 1_500;

/**
 * 🔴🔴 组字结束后的冷却期（语音输入专用，用户报障 2026-10 新坑）。
 *
 *   键盘 IME 组字结束（compositionend）后文本已提交，1.5s 的 typingActive 足够。
 *   但**语音输入**（豆包等输入法的语音转文字）在句子/短语之间会有 1~数秒的
 *   **自然停顿**：停顿期间 `compositionend` 早已触发、1.5s 活跃期也已过期 ⇒
 *   门控提前打开 ⇒ 下一轮轮询/SSE 的 `docToLexical`（`root.clear()` + 整篇重建）
 *   落在停顿处，把光标重置、把尚未提交的组字串冲掉 ⇒ 用户报障的
 *   「语音转文字被换位 / 丢失」。
 *
 *   ⇒ 组字结束后**额外**再关 `COMPOSE_COOLDOWN_MS`，覆盖语音的句间停顿。
 *   代价：远端回灌最多推迟这么久 —— 下几轮轮询会自动重试（P0-3「推迟不排队」），
 *   对单用户笔记可接受；多端实时协同的变更会在语音停下后至多冷却期那么久才落本机。
 */
const COMPOSE_COOLDOWN_MS = 4_000;

/**
 * 🔴🔴 「整段改写会话窗口」（豆包「智能整理/精炼润色」专用，2026-10-11）。
 *
 *   老项目与小米自带笔记在同样的操作下**不丢字**，是因为它们压根没有
 *   "网页在输入过程中程序化改树"这件事；而 bj 有（Lexical 的回灌 / 补铺 /
 *   链接识别 / 折叠建组）。只要**一次编辑删掉了大段正文**，就说明输入法
 *   很可能正在做「整段删除 → 分批插入」的改写 —— 这一段时间内**一切程序化
 *   动树都必须让路**，否则 Android 的 `InputConnection` 文本视图与 DOM 错位，
 *   输入法下一次 `commitText` 按旧偏移操作 ⇒ 前面几段被整段替换。
 *
 *   🔴 为什么不用"打字活跃期"去覆盖：活跃期是 1.5 秒的**时间窗**，
 *     而豆包「识别优化中」的静默、以及批次之间的间隙都可能超过它
 *     ⇒ 时间窗会提前开门，正好在它还在改的那一刻放行手术。
 *   🔴 为什么是**结构痕迹**而不是时间巧合：触发条件是「这次编辑删掉了
 *     ≥ 8 个字符」（由调用方判定后调 `noteBulkEdit()`），是真实发生在
 *     文档上的结构变化，不依赖"上一次输入是多久之前"这种采样。
 *   🔴 窗口是**固定长度**不是滑动的：输入持续也不会无限延长，
 *     6 秒后必然放行（远端改动最多推迟这么久落地，下一轮轮询会自动重试）。
 */
const BULK_REWRITE_MS = 6_000;

export interface ImeGate {
  /** 组字中（含 compositionstart 之后、compositionend 之前）。 */
  readonly composing: boolean;
  /** 用户最近仍在打字（活跃期未过）。 */
  readonly typingActive: boolean;
  /** 组字刚结束的冷却期内（覆盖语音句间停顿）。 */
  readonly composeCooling: boolean;
  /** 输入法正在"整段改写"正文的会话窗口内（见 noteBulkEdit）。 */
  readonly bulkActive: boolean;
  /** 现在**能不能**往编辑器里回灌。 */
  canApply(): boolean;
  /**
   * 现在**能不能动树**（回灌 / 补铺 / 链接识别 / 折叠建组 —— 一切程序化改 DOM）。
   *
   * 🔴🔴 与 `canApply()` 的差别就一条：它**额外**被"整段改写会话窗口"挡住。
   *   `canApply()` 只挡"组字中 / 冷却期 / 打字活跃期"这三个**时间窗**，
   *   而输入法（豆包「智能整理」）整段删除原文、再**分批**插入整理稿时，
   *   批次之间的静默可能超过 1.5 秒 ⇒ 时间窗开 ⇒ 我们在它还在改的时候动树。
   */
  canEditTree(): boolean;
  /** 记一次"整段改写"（输入法大段删除原文）。 */
  noteBulkEdit(): void;
  /** 绑定到编辑器宿主。返回解绑函数（mountEditor 必须调它）。 */
  attach(host: HTMLElement): () => void;
  /** 手动置组字态（给没有 composition 事件的降级场景/判据用）。 */
  setComposing(v: boolean): void;
  /** 记一次输入（打活跃期）。 */
  noteInput(): void;
}

/**
 * 建一个门控。
 *
 * 🔴 `now` 显式注入：活跃期判定依赖时钟，判据里必须能**确定性地**推进时间，
 *   靠真实 `Date.now()` 写的判据要么恒绿要么恒红（时间相关判据的经典陷阱）。
 *
 * 🔴🔴 `isComposing` 可选注入：Lexical 编辑器自身的组字态（防御纵深）。
 *   它捕获 DOM 门控（`compositionstart/end`）可能漏掉的组字窗口 —— 比如语音输入
 *   把组字串挂在 Lexical 内部、但 composition 事件因时序/宿主元素问题没被本门控收到。
 *   它**只增不减**地加固 `canApply()`，不会削弱既有判据。
 */
export function createImeGate(
  now: () => number = Date.now,
  isComposing?: () => boolean,
): ImeGate {
  let composing = false;
  // 🔴🔴 初值必须是"从来没有输入过"，**不能**是 0。
  //   `now()` 是 epoch 毫秒（1.7e12 量级），`now() - 0` 是个巨大的正数，
  //   恰好能让 `typingActive()` 返回 false —— 但那是**靠数的大小碰巧对的**：
  //   判据里把时钟注成 `() => 1000` 这种小值时，`1000 - 0 = 1000 < 1500`
  //   ⇒ 刚建的门控立刻判成"正在打字" ⇒ canApply 恒 false ⇒
  //   **首次挂载编辑器时远端内容永远进不来**（症状："刷新取不到"）。
  //   用 -Infinity 表达"从未输入"，与时钟量级无关。
  let lastInputAt = Number.NEGATIVE_INFINITY;
  // 🔴🔴 组字结束时间戳，初值同 "从未组过字"。
  let lastComposeEndAt = Number.NEGATIVE_INFINITY;
  let lastBulkEditAt = Number.NEGATIVE_INFINITY;

  const typingActive = (): boolean => now() - lastInputAt < TYPE_ACTIVE_MS;
  const composeCooling = (): boolean => now() - lastComposeEndAt < COMPOSE_COOLDOWN_MS;
  const bulkActive = (): boolean => now() - lastBulkEditAt < BULK_REWRITE_MS;

  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    // 🔴 compositionend 之后**立刻**把最近输入时间刷新：
    //   组字完成的那一刻正是用户最可能在等回显的时刻，
    //   用旧的 lastInputAt（可能是 5 秒前打字的开头）会让活跃期立刻过期
    //   ⇒ 紧接着到来的远端回灌正好穿过门控 ⇒ 吞掉刚上屏的字。
    composing = false;
    lastInputAt = now();
    // 🔴🔴 语音输入冷却起点：豆包等语音在句间停顿可达数秒，
    //   仅 1.5s 活跃期会在停顿中提前开门 ⇒ 轮询的整篇重建落在停顿处把字弄乱。
    //   冷却只由**真实** compositionend 事件触发（手动 setComposing 不触发，见下），
    //   因为"刚组完字"这回事只有真实事件知道。
    lastComposeEndAt = now();
  };
  const onBlur = (): void => {
    // 🔴🔴 blur 复位是老项目 index.html:1000 明确有的，本仓两处 IME 门控
    //   （linkify/deferred.ts、egg/word-trigger.ts）**都只挂了 compositionend**。
    //   漏它的症状：点走时组字被打断（切窗口、点菜单、扫码），
    //   composing 卡在 true ⇒ 那之后**整篇再也回灌不了**，
    //   症状是"同步功能坏了"，而本机一切正常 —— 极难自查。
    composing = false;
  };
  const onInput = (e: Event): void => {
    lastInputAt = now(); // 现有：键盘 1.5s 活跃期
    // 🔴🔴 语音/IME 组字中的 input（isComposing=true）⇒ 延长冷却窗。
    //   豆包实时转文字时，每一小段都派 input(isComposing=true)；
    //   只要"还在转"，冷却就一直被续上 ⇒ 门控整段关死，轮询的整篇重建进不来
    //   ⇒ 用户在**说话过程中**的文本不会被同步冲掉（用户 2026-10 澄清的场景）。
    //   键盘的 input 事件 isComposing=false ⇒ 不延长（键盘仍走 1.5s 活跃期，语义不变）。
    //   注意：这里只读事件的 isComposing，绝不 preventDefault，不影响输入本身。
    const ie = e as unknown as { isComposing?: boolean };
    if (ie.isComposing === true) lastComposeEndAt = now();
  };

  return {
    get composing() {
      return composing;
    },
    get typingActive() {
      return typingActive();
    },
    get composeCooling() {
      return composeCooling();
    },
    get bulkActive() {
      return bulkActive();
    },
    canApply(): boolean {
      // 🔴🔴 Lexical 内部组字态（防御纵深）：捕获 DOM 门控可能漏掉的组字窗口。
      if (isComposing && isComposing()) return false;
      // 🔴 组字中绝对不许回灌（这是老项目四道门里的第 ①②③道）；
      //   打字活跃期也不回灌（第④道，1.5 秒静默推迟）。
      //   两条是**或**关系：组字中时 typingActive 大概率为真，但不必依赖它 ——
      //   依赖"大概率"就等于把一条正确性判据建在时序巧合上。
      if (composing) return false;
      // 🔴🔴 组字刚结束的冷却期（覆盖语音句间停顿 > 1.5s 的窗口），
      //   必须独立拦住 —— 否则语音停顿中门控开门、整篇重建把字弄乱。
      if (composeCooling()) return false;
      if (typingActive()) return false;
      return true;
    },
    canEditTree(): boolean {
      // 🔴🔴🔴 比回灌更严：程序化改树还要躲开"整段改写会话窗口"。
      //   输入法大段删除原文后还在分批插入时，时间窗可能恰好开着 ——
      //   那一刻动树就是把 Android InputConnection 的视图打歪。
      //   `canApply()` 本身保持原语义（回灌/合并判它，语义不变），
      //   这里只是在其上**叠加**一条，只增不减。
      if (!this.canApply()) return false;
      if (bulkActive()) return false;
      return true;
    },
    noteBulkEdit(): void {
      lastBulkEditAt = now();
    },
    attach(host: HTMLElement): () => void {
      host.addEventListener('compositionstart', onCompositionStart);
      host.addEventListener('compositionend', onCompositionEnd);
      host.addEventListener('blur', onBlur, true);
      host.addEventListener('input', onInput);
      return () => {
        host.removeEventListener('compositionstart', onCompositionStart);
        host.removeEventListener('compositionend', onCompositionEnd);
        host.removeEventListener('blur', onBlur, true);
        host.removeEventListener('input', onInput);
      };
    },
    setComposing(v: boolean): void {
      composing = v;
      // 🔴 手动置位**不**触发冷却（`lastComposeEndAt` 不动）：
      //   这是降级场景（本来就没有 composition 事件，"刚组完字"无从判断），
      //   且现有 SYNC-IME-01 钉的就是这条无事件的降级路径，保持语义不变。
    },
    noteInput(): void {
      lastInputAt = now();
    },
  };
}

export { TYPE_ACTIVE_MS, COMPOSE_COOLDOWN_MS, BULK_REWRITE_MS };

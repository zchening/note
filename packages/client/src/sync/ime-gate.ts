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

export interface ImeGate {
  /** 组字中（含 compositionstart 之后、compositionend 之前）。 */
  readonly composing: boolean;
  /** 用户最近仍在打字（活跃期未过）。 */
  readonly typingActive: boolean;
  /** 现在**能不能**往编辑器里回灌。 */
  canApply(): boolean;
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
 */
export function createImeGate(now: () => number = Date.now): ImeGate {
  let composing = false;
  // 🔴🔴 初值必须是"从来没有输入过"，**不能**是 0。
  //   `now()` 是 epoch 毫秒（1.7e12 量级），`now() - 0` 是个巨大的正数，
  //   恰好能让 `typingActive()` 返回 false —— 但那是**靠数的大小碰巧对的**：
  //   判据里把时钟注成 `() => 1000` 这种小值时，`1000 - 0 = 1000 < 1500`
  //   ⇒ 刚建的门控立刻判成"正在打字" ⇒ canApply 恒 false ⇒
  //   **首次挂载编辑器时远端内容永远进不来**（症状："刷新取不到"）。
  //   用 -Infinity 表达"从未输入"，与时钟量级无关。
  let lastInputAt = Number.NEGATIVE_INFINITY;

  const typingActive = (): boolean => now() - lastInputAt < TYPE_ACTIVE_MS;

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
  };
  const onBlur = (): void => {
    // 🔴🔴 blur 复位是老项目 index.html:1000 明确有的，本仓两处 IME 门控
    //   （linkify/deferred.ts、egg/word-trigger.ts）**都只挂了 compositionend**。
    //   漏它的症状：点走时组字被打断（切窗口、点菜单、扫码），
    //   composing 卡在 true ⇒ 那之后**整篇再也回灌不了**，
    //   症状是"同步功能坏了"，而本机一切正常 —— 极难自查。
    composing = false;
  };
  const onInput = (): void => {
    lastInputAt = now();
  };

  return {
    get composing() {
      return composing;
    },
    get typingActive() {
      return typingActive();
    },
    canApply(): boolean {
      // 🔴 组字中绝对不许回灌（这是老项目四道门里的第 ①②③道）；
      //   打字活跃期也不回灌（第④道，1.5 秒静默推迟）。
      //   两条是**或**关系：组字中时 typingActive 大概率为真，但不必依赖它 ——
      //   依赖"大概率"就等于把一条正确性判据建在时序巧合上。
      if (composing) return false;
      if (typingActive()) return false;
      return true;
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
    },
    noteInput(): void {
      lastInputAt = now();
    },
  };
}

export { TYPE_ACTIVE_MS };

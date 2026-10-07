/**
 * 触屏 / 焦点纪律 —— 全项目**唯一**出处。
 *
 * 🔴🔴🔴 为什么要单独成文件（而不是继续放在 main.ts 里）：
 *   `behaviors.ts`（折叠开合）也需要 `dismissKeyboardForTouch`，
 *   而 `main.ts` **import** behaviors.ts —— 反向 import 就是循环依赖，
 *   症状是模块顶层拿到 undefined 的函数引用、点折叠三角时抛
 *   "dismissKeyboardForTouch is not a function"（首次点击才炸，控制台一片安静）。
 *   ⇒ 凡是"两边都要用"的东西，必须落在比它们都低的一层。
 *
 * 🔴🔴🔴 三条纪律（全部照老项目 index.html 现行口径，判据见 e2e VVW-25~28）：
 *
 *   1. **收尾 focus 必须带 `CHIP_HOVER_OK` 守卫**。
 *      手机上 `focus()` 就是弹软键盘 —— 用户点关闭弹窗时并没有打算打字。
 *      老项目在**每一处**收尾 focus 上都有这道守卫（:3377 / :6929 / :7628 /
 *      :8000 / :8216 / :8244 / :8249 / :8287 / :9111），一处不漏；
 *      bj 此前全是裸 `editor.focus()`，于是用户报障第 8 / 10 / 11 条。
 *
 *   2. **触屏判据与桌面判据不是互补的**，中间有一整类设备
 *      （平板 + 触控笔 / 插了鼠标的触屏本 / 桌面触屏一体机）。
 *      老项目 2026-10-07 起用 `POINTER_FINE()`（`(any-pointer: fine)`）**放行**那类，
 *      本模块照办：`restoreEditorFocus` 认精确指针（含 any-pointer），
 *      `dismissKeyboard` 只认**纯触屏**（hover:none + pointer:coarse）。
 *      两套判据各自的方向不能反，否则桌面端会在误触时把光标丢掉。
 *
 *   3. **判不准时选"不做"**。老内核 matchMedia 可能缺失或整个函数抛异常：
 *      此时一律按**触屏**处理（不还焦点、不 blur）。
 *      代价是用户多点一下正文；反过来"键盘乱弹"是用户直接看得见的错。
 */

/** 纯触屏：无 hover 且主指针粗。老项目口径 `(hover: none) and (pointer: coarse)`。 */
export function isTouchDevice(): boolean {
  try {
    return !!window.matchMedia?.('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/**
 * 触屏下收起软键盘。
 *
 * 🔴 blur 是移动端唯一可靠的收键盘手段（`readonly` 那些花招在新版 WebKit 已失效）。
 *   但**桌面端绝不能 blur** —— 用户正在打字时误触上传，编辑器一失焦光标就丢了。
 *
 * 🔴 匹配不到（老 WebView / matchMedia 缺失）时按**桌面**处理：
 *   不收键盘的代价远小于"桌面打字打到一半光标没了"。
 */
export function dismissKeyboardForTouch(): void {
  try {
    if (!isTouchDevice()) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  } catch {
    // 收起键盘失败绝不影响主流程
  }
}

/**
 * 关闭浮层后把焦点还给编辑器 —— **只在设备真有精确指针时做**。
 *
 * 🔴 老项目 CHIP_HOVER_OK 是 `(hover: hover) and (pointer: fine)`，
 *   而它自己后来（v9.3.x「触屏误报 fine」之后）又用 `POINTER_FINE()` =
 *   `(any-pointer: fine)` 放行"有精确指针"设备。本函数取**更宽**的那个口径：
 *   只要存在任何精确指针（插了鼠标的触屏本 / 触控笔），关掉弹窗后就该能直接接着打字，
 *   不该逼用户多点一下。
 *
 * @param getEl 取编辑器元素。传函数而不是元素本身，是为了让本模块不依赖全局编辑器引用
 *              （main.ts 的 `editor` 是模块内 let，会随页面切换被重新赋值）。
 */
export function restoreEditorFocus(getEl: () => HTMLElement | null | undefined): void {
  try {
    // 🔴 两条都查：`any-pointer: fine` 覆盖插了鼠标的触屏本；
    //   `hover: hover` 覆盖桌面触屏一体机（primary 是 coarse 但 hover 能力在）。
    //   任一命中就还焦点。
    const mq = window.matchMedia;
    if (!mq) return;
    const fine =
      !!mq('(any-pointer: fine)').matches || !!mq('(hover: hover)').matches;
    if (!fine) return;
    getEl()?.focus();
  } catch {
    // 归还焦点失败不该影响"浮层已关闭"这件事
  }
}
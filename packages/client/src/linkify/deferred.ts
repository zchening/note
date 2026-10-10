/**
 * 链接识别的**延迟调度** —— 老项目 `linkifyDeferred` 的 Lexical 等价物
 *
 * 🔴🔴🔴 这条节奏是**铁律**，不是调优项。
 *
 *   老项目 index.html:3627-3638 的注释把理由写得很直白：
 *     「连续打字中（<1.5s）推迟一切 DOM 手术（linkify/poll 远端应用），
 *       斩断「手术 → 光标落不可绘制位 → relocate」链条的第一环」
 *   也就是说：**实时 linkify 会让光标跳**。这不是"可能有抖动"，
 *   而是老项目为此付出了自建撤销栈的代价（index.html:2464-2501）。
 *
 *   两个数字必须原样照抄，理由分别是：
 *     - **1500ms**（`Date.now() - lastTypeAt < 1500` ⇒ 再等等）
 *       末次击键后停笔 1.5 秒才真正动刀。太短则光标还在动，用户会看到
 *       链接在打字中途忽然出现 / 文字忽然重排。
 *     - **600ms**（顺延的重试间隔）
 *       停笔判定是轮询式的：没到 1.5s 就 600ms 后再看一眼。
 *       照抄它而不是"算一次剩余时间"—— 后者在连续击键下会产生
 *       一串不均匀的等待，用户能感觉到节奏不齐。
 *
 * 🔴 守卫的**三个条件是与的关系**（老项目 index.html:3632 原文）：
 *
 *     if (Date.now() - lastTypeAt < 1500 && !remPanelOpen && document.activeElement === editor)
 *
 *   即「只有**又近在打字、又没有遮罩面板、且焦点在编辑器里**才推迟」。
 *   老项目注释解释了后两条为何必须存在：面板开着或焦点不在编辑器时，
 *   lastTypeAt 可能被**程序化回写**（面板添加提醒会走 input 链改正文），
 *   那种场景根本没有打字，推迟会让下划线晚 ~1.6s 才出现（e2e V545-1 实锤）。
 *   我第一版把后两条写成了 `||` 分支（"没有遮罩就跑"）——语义正好相反，
 *   症状是用户点开提醒面板时链接立刻重建、光标被弹走。
 *   ⇒ 三个条件必须**同时成立**才推迟。抄这条时照抄连接词，不要照抄意图。
 */

import type { LexicalEditor } from 'lexical';
import { $linkifyEditor } from './apply.ts';

/** 老项目 index.html:3632：末次击键后多久算停笔 */
export const QUIET_MS = 1500;
/** 老项目 index.html:3634：停笔未满时的顺延间隔 */
export const RETRY_MS = 600;
/** 老项目 index.html:5050：输入后多久第一次尝试 */
export const FIRST_DELAY_MS = 500;

export interface LinkifyDeps {
  /**
   * 有遮罩态面板打开吗（提醒面板 / 二维码 / 扫一扫）。
   *
   * 老项目是直接读模块级的 `remPanelOpen` 变量；本项目是纯 DOM 宿主，
   * 没有那个变量，由 main.ts 注入判定 —— **不让本模块去猜 class 名**
   * （猜错的后果是"面板开着时链接照跑、光标被弹走"，且零报错）。
   */
  hasOverlayOpen: () => boolean;
  /**
   * 编辑器此刻**允许动树**吗（IME 门控）。不传 = 总是允许（保持旧行为）。
   *
   * 🔴🔴 为什么需要这一条（语音输入丢字，2026-10 报障）：
   *   本模块原有的两道守卫是「组字中」（靠 `beforeinput` 的 inputType 前缀
   *   `insertComposition`）与「停笔 1.5s」。前者在**不走 composition 通道的输入法**
   *   （部分语音输入法直接 `commitText`）下恒为 false；后者在语音的句间停顿
   *   （常 > 1.5s）里会过期。两道一起失效 ⇒ 用户还在说话时链接识别动了树。
   *
   *   链接识别是真的**增删节点**（把裸网址包成 LinkNode），与回灌/补铺同属
   *   "输入过程中的 DOM 手术"：Android 输入法按 `InputConnection` 的文本视图
   *   定位，网页一改树，视图就与真实 DOM 错位，输入法下一次提交会按旧偏移
   *   操作 ⇒ 整段正文被替换成它以为的那一小段（"只剩第一句"）。
   */
  canEdit?: () => boolean;
}

export interface LinkifyHandle {
  /**
   * 立刻跑一轮（跳过打字守卫）。
   *
   * 🔴 用于「真源刚换过」的时刻：解锁、远端合并、导入。
   *   那些路径下正文里**早就存在**的裸网址（老项目迁移来的真源，
   *   见 recognize.ts 的 stripZeroWidth 注释）不会因为"用户没打字"而自动变链接。
   *   老项目 index.html:3471 是同一件事：`if (note.ct) linkifyEditor()`。
   */
  runNow: () => void;
  /** 注销（解绑 DOM 监听与所有计时器）。 */
  dispose: () => void;
}

/**
 * 注册延迟链接识别。
 *
 * @returns 句柄：runNow（真源换档时用）与 dispose（注销）
 */
/**
 * 链接识别「要不要再等等」的判据 —— 抽成纯函数是为了能被单测钉住。
 *
 * 🔴🔴 两道闸是**互补**的，缺任一条都会被某类输入法绕过：
 *   ① 老项目的停笔闸（`typingNow && !overlayOpen && focused`，index.html:3632）：
 *      连续打字中推迟，斩断"手术 → 光标落不可绘制位 → relocate"链条。
 *   ② IME 门控闸（`!canEdit`）：覆盖①认不出的场景 ——
 *      不走 composition 通道的输入法（部分语音输入法直接 commitText）
 *      让①里的 typingNow 在句间停顿（常 > 1.5s）后过期，
 *      于是链接识别在用户还在说话时动刀。
 */
export interface LinkifyGuard {
  /** 最近还在打字（末次击键距今 < QUIET_MS）。 */
  typingNow: boolean;
  /** 有遮罩态面板开着。 */
  overlayOpen: boolean;
  /** 焦点在编辑器根元素上。 */
  focused: boolean;
  /** IME 门控允许动树吗（组字中 / 语音冷却期为 false）。 */
  canEdit: boolean;
}

export function shouldDeferLinkify(g: LinkifyGuard): boolean {
  // ① 老项目停笔闸：三个条件是**与**（连接词照抄，别改成或）
  if (g.typingNow && !g.overlayOpen && g.focused) return true;
  // ② IME 闸
  if (!g.canEdit) return true;
  return false;
}

export function registerLinkify(editor: LexicalEditor, deps: LinkifyDeps): LinkifyHandle {
  let timer: number | null = null;
  /** 末次击键时间戳。老项目 index.html:3626 `lastTypeAt` */
  let lastTypeAt = 0;
  /** 组字中绝不手术。老项目 index.html:3851 `if (isComposing) return;` */
  let isComposing = false;
  let running = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 焦点是否在编辑器根元素上。老项目判据 `document.activeElement === editor`。 */
  const hasFocus = (): boolean => {
    const root = editor.getRootElement();
    if (!root) return false;
    return root.ownerDocument?.activeElement === root;
  };

  const run = (): void => {
    // 🔴 组字中直接返回。老项目 index.html:3851。
    //   组字中途改树会 detach 组字目标节点，compositionend 丢失后 isComposing
    //   永久卡死、光标消失（老项目 v7.3.2 记的用户报障）。
    //   兜底重跑由 compositionend 负责，见 onCompositionEnd。
    if (isComposing) return;
    // 🔴 重入守卫。老项目 index.html:3848 `if (isLinkifying) return;`
    if (running) return;
    running = true;
    try {
      // 🔴🔴 必须 `discrete: true` 且回调内只碰节点。
      //   直接在 update 回调外调 $linkifyEditor 会抛
      //   "Unable to find an active editor"（探针 probe-d.mjs 实测过该错误原文）。
      editor.update(() => {
        $linkifyEditor();
      }, { discrete: true });
    } finally {
      running = false;
    }
  };

  /**
   * 老项目 index.html:3631-3638 `linkifyDeferred` 的等价物。
   *
   * 🔴 三个守卫条件是**与**：又近在打字、又无遮罩、焦点在编辑器 ⇒ 推迟 600ms 再看。
   */
  const tryLinkify = (): void => {
    clearTimer();
    if (
      shouldDeferLinkify({
        typingNow: Date.now() - lastTypeAt < QUIET_MS,
        overlayOpen: deps.hasOverlayOpen(),
        focused: hasFocus(),
        canEdit: deps.canEdit ? deps.canEdit() : true,
      })
    ) {
      timer = setTimeout(tryLinkify, RETRY_MS);
      return;
    }
    run();
  };

  const schedule = (delay: number): void => {
    clearTimer();
    timer = setTimeout(tryLinkify, delay);
  };

  /**
   * 触发时机：DOM `beforeinput`（判据形态与 registerFoldAutoCreate 同款）。
   *
   * 🔴 为什么用 beforeinput 而不是 Lexical 的 update 监听：
   *   老项目在 `input` 事件里读 `inputType`（index.html:5033-5034），
   *   `beforeinput` 是同一份信息在**写入 DOM 之前**的形态。
   *   选它是为了能拿到 inputType —— 没有 inputType 就分不清
   *   「用户敲了一个字」与「远端合并改写了正文」。后者绝不能刷新 lastTypeAt：
   *   会把一次程序化改动误判成打字，链接识别于是无限推迟（老项目为此专门
   *   在 line 5034 排除了 undo/redo，本项目照抄）。
   */
  const onBeforeInput = (ev: Event): void => {
    const e = ev as InputEvent;
    const t = e.inputType ?? '';
    isComposing = t.startsWith('insertComposition');
    if (t === 'historyUndo' || t === 'historyRedo') {
      // 🔴 老项目 index.html:5034 的 `it !== 'historyUndo' && it !== 'historyRedo'`。
      //   撤销是瞬时操作，不是"还在打字"。刷新时间戳会让连续撤销时链接永不触发。
      return;
    }
    lastTypeAt = Date.now();
    schedule(FIRST_DELAY_MS);
  };

  /**
   * 组字结束兜底：老项目 index.html:993-994 的「组字期间被拦掉的手术兜底重调度」。
   *
   * 🔴 不做这一步的故障：组字中 run() 直接 return，那一次 linkify 就**永久丢了**
   *   —— 用户输入法上屏的那串文字里若有网址，链接永远不出现，直到用户再敲一个字。
   *   症状是"用输入法打完网址，链接不亮；再随便敲一个字就好了"。
   */
  const onCompositionEnd = (): void => {
    isComposing = false;
    schedule(FIRST_DELAY_MS);
  };

  const root = editor.getRootElement();
  root?.addEventListener('beforeinput', onBeforeInput);
  root?.addEventListener('compositionend', onCompositionEnd);

  return {
    runNow: () => {
      clearTimer();
      // 🔴 抹掉打字时间戳：否则守卫会以为"刚刚还在打字"而推迟 1.5s，
      //   真源刚换档时用户会看到正文先裸着、过一会儿才变链接。
      lastTypeAt = 0;
      run();
    },
    dispose: () => {
      clearTimer();
      root?.removeEventListener('beforeinput', onBeforeInput);
      root?.removeEventListener('compositionend', onCompositionEnd);
    },
  };
}

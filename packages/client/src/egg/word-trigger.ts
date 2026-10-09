/**
 * 彩蛋词表触发 —— **编辑器桥**（Lexical → DOM 光标 → 确认浮层）
 *
 * 🔴🔴 本文件解决的是「老项目的 `editor` 是一个 contenteditable DOM 节点，
 *   新项目是 Lexical」这个唯一真差异。老项目的 `nsCaretCtx` 直接
 *   `editor.contains(r.startContainer)` + `blockOf(...)` + `document.createRange()`，
 *   新项目的等价物就是**同一个编辑器根 DOM 节点**（`#editor-host`）——
 *   Lexical 只是把状态托管在 JS 里，渲染出来的仍是那棵 contenteditable DOM。
 *   所以**取 pre/post 这条路径可以逐字照抄老项目**，不必绕到 Lexical 节点树上。
 *
 * 🔴 为什么**不**用 `$getSelection().anchor.getNode()` 那条路（这很诱人）：
 *   1. Lexical 节点是不可变快照，跨 state 引用会变（behaviors.ts:563 已记此铁证）；
 *   2. collapsed 选区的 `sel.getNodes()` **不含任何祖先**（behaviors.ts:554 同款探针实锤），
 *      判「光标是否在本块内」得沿 `getParent()` 链上溯，很容易写错；
 *   3. 老项目判据是**块内偏移**（跨 span 拼接的纯文本），而 Lexical 的
 *      TextNode 是按格式化切分的 —— 同一个视觉块可能有多个 TextNode，
 *      「块内偏移」得自己按节点树重算，等于把老项目的 `blockOf`重写一遍。
 *   ⇒ 走 DOM Range：判据与老项目同构，且**唯一**一套口径，不会两处漂移。
 *
 * 🔴🔴 **输入期绝不改 DOM**（铁律④）。老项目是在 `beforeinput` 里
 *   `setTimeout(..., 0)` 之后再取 pre/post（:11023-11025），
 *   本文件照抄这个时序：DOM 读取一律在**下一个宏任务**。
 *   在 beforeinput 里同步读也可以，但**绝不能**在 beforeinput 里改 DOM ——
 *   那会让光标跳到别处，用户看到"字打不进去"。
 *
 * 🔴 触发通道共**四条**：**打字** / **中文整词上屏** / **触屏点词** /
 *   **光标落位**（selectionchange）。**不移植 hover**：
 *   老项目 v9.4.1（用户拍板，:11059）在 PC 端去掉了「鼠标悬停即弹」，
 *   扫过 /pet /dragon 不再弹。本项目照此口径。
 *
 * 🔴🔴 光标落位通道（老项目 :11091-11109）是**第四条独立通道**，不是打字通道的
 *   附属品。三条语义差在手就能感到，必须钉住：
 *   1. **不看 `asked[]`**（老项目 :11106 注释原文「不受 asked[] 会话抑制」）——
 *      用户主动把光标移回词上是**主动行为**，与"又打了一遍"不是一回事。
 *   2. **latch 的是「词」而不是「位置」**（`_eggCaretTok`）：停在同一个词内
 *      反复微动（方向键左右挪、同词里点不同位置）**只弹一次**；
 *      「移出词再移回」才每次都弹。用户报障说的「并没有每次都出现」
 *      准确口径就是这个 —— 不是漏弹，是同词内微动被latch 挡掉了（且这是对的）。
 *   3. **只收自己弹起的那次**（`_askFrom === 'caret'`）：点词弹的浮层不该被
 *      光标路收走，反之亦然。老项目 :11104 就是这个判据。
 */

import {
  buildAskLatch,
  eggTokenAtNode,
  eggVerdictAtCaret,
  caretCtxFromParts,
  isWordSpace,
  type AskLatch,
  type CaretCtx,
} from './trigger.ts';
import { buildEggAsk, type EggAsk } from './ask.ts';

export interface EggWordDeps {
  /** 启动彩蛋游戏。 */
  launch: (id: string) => void;
  /** 归还焦点到编辑器。 */
  refocus: () => void;
}

export interface EggWordBinding {
  /** 手动跑一次打字通道判定（给 e2e 钩子用）。 */
  check: () => void;
  /**
   * 手动跑一次**光标落位通道**判定（跳过 200ms 去抖，给 e2e 钩子用）。
   *
   * 🔴 为什么单独暴露：这条通道的判据全在 `window.getSelection()` 上，
   *   真机上手动挪光标去对位置太脆，测试需要能直接驱动。
   */
  caretCheck: () => void;
  /** 收起浮层。 */
  hide: () => void;
  /** 浮层是否在展示。 */
  isOpen: () => boolean;
  /** 当前展示的蛋 id（空串 = 没展示）。 */
  showingId: () => string;
  /** 解绑全部监听。 */
  dispose: () => void;
}

/**
 * 「块」= 光标所在的那一段。老项目 `blockOf`（:5292）向上找第一个 DIV/P。
 * 🔴 Lexical 的段落渲染成 `<p>`，与老项目判据天然对齐；
 *   找不到（理论上不会：root 自己就是 DIV）时退回 root。
 */
function blockOf(node: Node | null, root: HTMLElement): HTMLElement {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n.nodeType === 1) {
      const tag = (n as Element).tagName;
      if (tag === 'DIV' || tag === 'P') return n as HTMLElement;
    }
    n = n.parentNode;
  }
  return root;
}

/**
 * 取光标所在块内的 pre/post。老项目 `nsCaretCtx`（:10946）的 DOM 等价物。
 *
 * 🔴 三条返回约定与老项目**完全一致**：
 *   - 无选区（jsdom 守护）→ `null`（上层退全文尾部扫描）
 *   - **有选区** → `{pre:'\u0000SEL', post:''}`，绝不误弹（铁律：真人框选不打扰）
 *   - 光标不在编辑器内 → `null`
 *   - `pre` 只留后 24 字（老项目 :10953）
 *
 * @param caretRectOut 出参：光标所在矩形，供浮层锚定（老项目 `_askCaretRect` :10962）
 */
/**
 * 导出给条件触发（数字梗 / notesync 烟花）复用 —— 那边的判定面同样是光标上下文。
 * 🔴 不另写第二套取法：两套实现迟早漂，而漂移零报错。
 */
export function caretCtx(
  root: HTMLElement,
  caretRectOut: { rect: DOMRect | null },
): CaretCtx | null {
  try {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    if (!sel.isCollapsed) return { pre: '\u0000SEL', post: '' };
    const r = sel.getRangeAt(0);
    if (!root.contains(r.startContainer)) return null;
    const block = blockOf(r.startContainer, root);
    const a = document.createRange();
    a.selectNodeContents(block);
    try {
      a.setEnd(r.startContainer, r.startOffset);
    } catch {
      return null;
    }
    const b = document.createRange();
    b.selectNodeContents(block);
    try {
      b.setStart(r.startContainer, r.startOffset);
    } catch {
      return null;
    }
    // 锚定矩形：老项目 :10962-10970 取最后一个 client rect，退化到 bounding box
    try {
      const rs = r.getClientRects();
      if (rs && rs.length) {
        caretRectOut.rect = rs[rs.length - 1] ?? null;
      } else {
        const bb = r.getBoundingClientRect();
        caretRectOut.rect = bb && (bb.width || bb.height || bb.left || bb.top) ? bb : null;
      }
    } catch {
      caretRectOut.rect = null;
    }
    return caretCtxFromParts(a.toString(), b.toString());
  } catch {
    return null;
  }
}

/**
 * 光标落位通道的闩锁判定（老项目 `_eggCaretTok` :11091-11102 的**纯逻辑部分**）。
 *
 * 🔴🔴 抽成纯函数是刻意的：这条通道的全部承重语义就是下面这四行，
 *   而它们原本埋在 `selectionchange` 的 setTimeout 回调里 —— 那段代码在 node 里
 *   不可测（要 DOM + 定时器），于是"latch 被优化掉了"这种回归**没有任何判据能拦住**。
 *   抽出来之后 `EGG-CAR-*` 系列能直接 import 它做穷举对跑。
 *
 * @param prevTok 上一次判定时的词 id（离词时为 `''`）
 * @param id 本次光标所在词（离词 / 非文本节点 / 有选区时为 `''`）
 * @returns `fire=false` = 同词内微动，不重复弹；`fire=true` = 该弹（或该收）
 */
export function caretLatchVerdict(prevTok: string, id: string): { fire: boolean; tok: string } {
  // 老项目 :11101 `if (id === _eggCaretTok) return;`
  if (id === prevTok) return { fire: false, tok: prevTok };
  // 老项目 :11102 `_eggCaretTok = id;` —— 注意**离词时 id 为空串，latch 被置空**，
  // 这正是「移出词再移回，每次都弹」的实现方式（注释见老项目 :11101）。
  return { fire: true, tok: id };
}

/**
 * 「文本节点 + 节点内偏移」→ 该偏移所在的彩蛋词 + 该词的矩形。
 *
 * 🔴🔴 这是**光标落位通道**（老项目 `nsEggTokenAtCaret` :11075-11089）与
 *   **触屏点词通道**（`nsEggHit` :11040-11056）**共用**的那一步 ——
 *   两个通道的判据本就同构（同一个 `NS_EGG_HOVER_RE`、同一套空白切词），
 *   老项目只是把它写了两遍。抽出来是为了让「两条通道不许漂移」成为结构事实。
 */
function eggTokenAtNodeRect(
  root: HTMLElement,
  node: Node | null,
  offsetInNode: number,
): { id: string; rect: DOMRect | null } {
  const empty = { id: '', rect: null as DOMRect | null };
  // 🔴 必须是可见文本节点：命中元素节点说明点在字与字的缝上（老项目 :11047/:11080）。
  if (!node || node.nodeType !== 3 || !root.contains(node)) return empty;
  // nodeType === 3 不做类型收窄，TS 仍视其为 Node —— 必须显式 `instanceof Text`
  // 才能读 `.data`（老项目是纯 JS 才敢直接读）。
  if (!(node instanceof Text)) return empty;
  const data: string = node.data;
  const off = Math.max(0, Math.min(offsetInNode, data.length));
  // 词 id 判据复用 trigger.ts 的 `eggTokenAtNode`（内含空白切词 + EGG_TOKEN_RE），
  // 空白判定与老项目 :11082 的字符码清单同源（`isWordSpace`）。
  const id = eggTokenAtNode(data, off);
  if (!id) return empty;
  // 锚定矩形：老项目 :11088 —— 用**同一个词范围**建 Range，而不是光标那一个字符。
  //   少了这一步浮层会锚在词首字符上，「弹在词旁」就变成了「弹在词头上」。
  let i = off;
  while (i > 0 && !isWordSpace(data.charCodeAt(i - 1))) i -= 1;
  let j = off;
  while (j < data.length && !isWordSpace(data.charCodeAt(j))) j += 1;
  let rect: DOMRect | null = null;
  try {
    const rg = document.createRange();
    rg.setStart(node, i);
    rg.setEnd(node, Math.min(j, data.length));
    rect = rg.getBoundingClientRect();
  } catch {
    rect = null;
  }
  return { id, rect };
}

/**
 * 绑定彩蛋词表触发。
 *
 * @param root 编辑器根 DOM（`#editor-host`，即 `editor.getRootElement()`）
 */
export function bindEggWordTrigger(root: HTMLElement, deps: EggWordDeps): EggWordBinding {
  const latch: AskLatch = buildAskLatch();
  // 🔴 老项目 CHIP_HOVER_OK（:6490 `matchMedia('(hover: hover) and (pointer: fine)')`）的等价判据。
  //   用途只有一个：关闭浮层后要不要归还焦点（老项目 :11009）。
  const hoverFine = (): boolean => {
    try {
      return !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
    } catch {
      return true; // matchMedia 不可用时按桌面处理（老项目同款：!!undefined === false，但此处回退更安全）
    }
  };
  const ask: EggAsk = buildEggAsk({ refocus: deps.refocus, launch: deps.launch, hoverFine }, latch);

  /**
   * 🔴 组字期标记（老项目模块级 `isComposing` :983-1000 的等价物）。
   *
   *   为什么打字通道不用它、只有光标通道用：`beforeinput` 事件自带 `e.isComposing`
   *   与 `inputType` 前缀，逐事件判就够（见 onBeforeInput）。但 `selectionchange`
   *   **不带任何输入法信息** —— 组字过程中浏览器会连续派发它（拼音候选框跟随光标移动），
   * 老项目 :11093 与 :11097 两处都拦，注释写明「红线9：组字期绝不打扰」。
   *   ⇒ 必须自己维护一份跨事件的持续态。
   *
   *   `blur` 也要复位（老项目 :1000，注释记了真实故障）：组字中 DOM 被 linkify 手术
   *   detach 掉时 `compositionend` 可能不冒泡，标记卡在 true 会把这条通道**永久关死**。
   */
  let composing = false;

  /** 组字开始（老项目 :984）。 */
  const onCompositionStart = (): void => {
    composing = true;
  };

  /**
   * 🔴 组字中失焦即复位（老项目 :1000，注释里记了真实故障）。
   *   漏了这条：linkify 的 DOM 手术 detach 掉组字目标节点时 `compositionend`
   *   可能不冒泡，`composing` 卡在 true ⇒ 光标落位通道**永久关死**，
   *   症状是「偶发再也不弹」，极难归因。
   */
  const onBlur = (): void => {
    composing = false;
  };

  /**
   * 🔴 老项目 `_askFrom`（:11103-11105）的等价物：**当前浮层是不是光标路弹的**。
   *
   * 老项目那行是三档（`hover`/`tap`/`caret`）的字符串比较；bj 没有 hover 通道
   * （v9.4.1 已去，:11059），所以只剩 caret 一档要判。**为什么用「id 比对」而不是
   * 一个 `_askFrom` 变量**：老项目 `hideAsk` 会顺手把 `_askFrom` 清空，
   * 而 bj 的 `ask.close()`（ask.ts）**不碰**这个状态 —— 用单一变量的话，
   * 「点 ✕ 关掉后」这个边缘态会误判成"还是光标路弹的"，下次离词就去收一个
   * 别的通道弹的浮层。比对 `showingId()` 则 close 之后自动不成立，无需手工清。
   */
  let caretOpenedId = '';

  /**
   * 老项目 `_eggCaretTok`（:11091）：光标落位通道的**词闩锁**。
   *
   * 🔴🔴 这是整条通道最容易被"优化掉"的一行，而它承载的正是老项目
   *   :11101 注释写明的语义：「光标停在同一个彩蛋词内微动不重复弹；
   *   离开词会置空，下次再进来才弹」。
   *   去掉它 ⇒ 方向键在词内左右挪一下就重弹一次（用户看到的是"闪个不停"）。
   */
  let caretTok = '';
  /** 在途的 200ms 去抖定时器。`undefined` = 无在途。 */
  let caretTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  /** 当前展示的浮层是不是光标路弹起的（老项目 :11104 `_askFrom === 'caret'`）。 */
  const caretOwns = (): boolean => caretOpenedId !== '' && ask.showingId() === caretOpenedId;

  /** 打字通道判定（老项目 `nsWordTriggerAtCaret` :10958）。 */
  const check = (): void => {
    const box: { rect: DOMRect | null } = { rect: null };
    const ctx = caretCtx(root, box);
    // 🔴 拿不到光标时退回全文尾部扫描且**不判 okNext**（老项目 :10961-10964）。
    const r = eggVerdictAtCaret(ctx, latch, root.textContent ?? '');
    if (!r.hit) return;
    // 🔴 老项目在弹之前就置 asked（:10969-10970）—— 顺序照抄：
    //   置位必须在 ask.open 之前，否则 open 抛错会导致这个词**永久可弹**。
    latch.arm(r.id);
    ask.open(r.id, box.rect);
  };

  /* ---- 通道 1：打字。老项目 :11021-11029 ---- */
  const onBeforeInput = (ev: Event): void => {
    const e = ev as InputEvent;
    // 组字期不打扰（老项目 :11022：isComposing / insertComposition* 前缀）。
    // 🔴 但 `insertComposition*` 本身**要**放行到后面的 insertText 之外单独处理吗？
    //   老项目是 `if (... insertComposition) return;` —— 组字中一律不判。
    if (e.isComposing || (e.inputType && e.inputType.indexOf('insertComposition') === 0)) return;
    // 粘贴 / 替换文本不算（老项目 :11023，防误触：粘一大段进来里含 /pet 就弹）。
    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertReplacementText') return;
    if (e.inputType !== 'insertText') return;
    // 🔴 setTimeout 0：老项目 :11025 同款。**不是**性能考虑，
    //   而是此刻 DOM 尚未提交新字符，取 pre/post 会拿到**上一个**状态。
    setTimeout(() => {
      try {
        check();
      } catch {
        /* 判定失败绝不能打断输入 */
      }
    }, 0);
  };

  /* ---- 通道 2：中文输入法整词上屏。老项目 :11030-11032 ----
     Chromium 拼音 commit 不派 insertText，只发 compositionend。
     漏这条 ⇒ 中文状态下敲 /mirror 永不弹（老项目 v8.3.1 闸二 CDP 真机实锤）。 */
  const onCompositionEnd = (): void => {
    // 🔴 组字态复位（老项目 :986 `isComposing = false` 在最前面）。
    //   顺序承重：必须**先**复位再排 setTimeout(0)，否则那次 check 跑的时候
    //   composing 仍是 true，光标落位通道会在组字刚结束时误判。
    composing = false;
    setTimeout(() => {
      try {
        check();
      } catch {
        /* 同上 */
      }
    }, 0);
  };

  /* ---- 通道 3：触屏点词。老项目 :11062-11070（仅 !CHIP_HOVER_OK 分支） ----
     🔴 PC 端**不**接这条（v9.4.1 去 hover）。判据与老项目一致：
     点中彩蛋词 → 弹在词旁；点空白 → 收。 */
  const onClick = (e: MouseEvent): void => {
    if (hoverFine()) return; // PC：老项目 v9.4.1 已去掉这条通道
    const hit = hitEggAtPoint(root, e.clientX, e.clientY);
    if (hit.id) {
      // 🔴 stopPropagation（老项目 :11064闸 P0）：否则冒泡到 document 的
      //   「点空白收」把刚弹的又秒删（真机表现是闪一下就没）。
      e.stopPropagation();
      ask.open(hit.id, hit.rect);
    } else {
      ask.close();
    }
  };

  /** 点编辑器以外（弹窗/其它控件）→ 收。老项目 :11068。 */
  const onDocClick = (e: MouseEvent): void => {
    if (hoverFine()) return;
    const b = document.getElementById('eggAsk');
    if (b && !b.contains(e.target as Node)) ask.close();
  };

  /* ---- 通道 4：光标落位。老项目 :11091-11109 ----
     🔴 这是用户报障「光标移到彩蛋词上不弹确认框」的那一条，
        bj 此前**完全没有**（全库无selectionchange 监听）。

     语义逐条照抄老项目：
       - 200ms 去抖（:11095/11108）：方向键连按时 selectionchange 连发，不去抖会狂弹。
       - 组字期两次拦（:11093 事件头+ :11097 回调内复检）：去抖窗口内可能进入组字。
       - 只在编辑器真持焦时判（:11098）：别从别处的输入框抢弹。
       - `_eggCaretTok` latch（:11101-11102）：**同一词内微动不重复弹**。
         这正是用户说「并没有每次都出现」的准确口径 —— 移出词再移回每次都弹，
         停在同一个词里反复微动只弹一次（这是对的，不是漏弹）。
       - 离词只收**自己弹起的那次**（:11104）。
       - **不受 asked[] 会话抑制**（:11106 注释原文）：主动把光标移回词上是主动行为。
     */
  const caretVerdict = (): void => {
    try {
      if (composing) return; // 红线9复检（老项目 :11097）
      if (document.activeElement !== root) return; // 只在编辑器真持焦时判（:11098）
      const h = caretEggAt(root);
      const id = h.id;
      // 🔴 latch 比的是**词 id**，不是位置。老项目 :11101-11102
      //   「离开词会置空，下次再进来才弹」—— 置空就发生在下面 tok 那行。
      const v = caretLatchVerdict(caretTok, id);
      caretTok = v.tok;
      if (!v.fire) return;
      // 离词 → 收，且**只收自己弹起的那次**（老项目 :11104 的 `_askFrom === 'caret'`）。
      if (!id) {
        if (caretOwns()) ask.close();
        return;
      }
      caretOpenedId = id;
      ask.open(id, h.rect);
    } catch {
      /* 判定失败绝不能打断输入 */
    }
  };

  const onSelectionChange = (): void => {
    if (composing) return; // 红线9（老项目 :11093）
    if (caretTimer !== undefined) clearTimeout(caretTimer);
    caretTimer = setTimeout(() => {
      caretTimer = undefined;
      caretVerdict();
    }, 200);
  };

  root.addEventListener('beforeinput', onBeforeInput);
  root.addEventListener('compositionstart', onCompositionStart);
  root.addEventListener('compositionend', onCompositionEnd);
  root.addEventListener('blur', onBlur);
  root.addEventListener('click', onClick);
  document.addEventListener('click', onDocClick);
  // 🔴 capture=true（老项目 :11109）：selectionchange 不冒泡，但捕获阶段能收到，
  //   且能抢在任何冒泡监听之前。
  document.addEventListener('selectionchange', onSelectionChange, true);

  return {
    check,
    caretCheck: () => {
      if (caretTimer !== undefined) clearTimeout(caretTimer);
      caretTimer = undefined;
      caretVerdict();
    },
    hide: () => ask.close(),
    isOpen: () => ask.isOpen(),
    showingId: () => ask.showingId(),
    dispose: () => {
      root.removeEventListener('beforeinput', onBeforeInput);
      root.removeEventListener('compositionstart', onCompositionStart);
      root.removeEventListener('compositionend', onCompositionEnd);
      root.removeEventListener('blur', onBlur);
      root.removeEventListener('click', onClick);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('selectionchange', onSelectionChange, true);
      // 🔴 在途去抖定时器必须撤：dispose 后它再跑一次会凭空弹出一个浮层，
      //   而外壳已经拆了 —— 表现为「退出游戏后编辑器上方凭空冒出个胶囊」。
      if (caretTimer !== undefined) clearTimeout(caretTimer);
      caretTimer = undefined;
      caretTok = '';
      caretOpenedId = '';
      ask.close();
    },
  };
}

/**
 * 光标落位通道的「取词 + 取词矩形」。老项目 `nsEggTokenAtCaret`（:11075-11090）
 * 的 DOM 取值部分；判定部分复用 `eggTokenAtNodeRect`（与点词通道同源）。
 */
function caretEggAt(root: HTMLElement): { id: string; rect: DOMRect | null } {
  const empty = { id: '', rect: null as DOMRect | null };
  let sel: Selection | null = null;
  try {
    sel = window.getSelection();
  } catch {
    return empty;
  }
  // 🔴 有选区或无光标一律不判（老项目 :11077）。真人框选时绝不该弹。
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return empty;
  let r: Range;
  try {
    r = sel.getRangeAt(0);
  } catch {
    return empty;
  }
  return eggTokenAtNodeRect(root, r.startContainer, r.startOffset);
}

/** 指针命中彩蛋词。老项目 `nsEggHit`（:11062）。 */
function hitEggAtPoint(
  root: HTMLElement,
  x: number,
  y: number,
): { id: string; rect: DOMRect | null } {
  const empty = { id: '', rect: null as DOMRect | null };
  let hit: Range | null = null;
  const anyDoc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (anyDoc.caretRangeFromPoint) {
    hit = anyDoc.caretRangeFromPoint(x, y);
  } else if (anyDoc.caretPositionFromPoint) {
    const pp = anyDoc.caretPositionFromPoint(x, y);
    if (pp) {
      const rr = document.createRange();
      rr.setStart(pp.offsetNode, pp.offset);
      rr.collapse(true);
      hit = rr;
    }
  }
  if (!hit) return empty;
  // 🔴 命中判定与矩形**全部**委托给 eggTokenAtNodeRect ——
  //   老项目把这段写了两遍（nsEggHit :11048-11055 与 nsEggTokenAtCaret :11081-11089），
  //   两份判据同构。这里收口成一份，让「两条通道不许漂移」成为结构事实。
  return eggTokenAtNodeRect(root, hit.startContainer, hit.startOffset);
}

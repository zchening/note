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
 * 🔴 触发通道只有**打字**与**触屏点词**两条。**不移植 hover**：
 *   老项目 v9.4.1（用户拍板，:11059）在 PC 端去掉了「鼠标悬停即弹」，
 *   扫过 /pet /dragon 不再弹。本项目照此口径。
 */

import {
  buildAskLatch,
  eggTokenAtNode,
  eggVerdictAtCaret,
  caretCtxFromParts,
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
function caretCtx(
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

  root.addEventListener('beforeinput', onBeforeInput);
  root.addEventListener('compositionend', onCompositionEnd);
  root.addEventListener('click', onClick);
  document.addEventListener('click', onDocClick);

  return {
    check,
    hide: () => ask.close(),
    isOpen: () => ask.isOpen(),
    showingId: () => ask.showingId(),
    dispose: () => {
      root.removeEventListener('beforeinput', onBeforeInput);
      root.removeEventListener('compositionend', onCompositionEnd);
      root.removeEventListener('click', onClick);
      document.removeEventListener('click', onDocClick);
      ask.close();
    },
  };
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
  const node: Node | null = hit.startContainer;
  // 🔴 必须是可见文本节点（老项目 :11066）：命中元素节点说明点在字与字的缝上。
  //   🔴 `nodeType === 3` 不做类型收窄，TS 仍视其为 Node —— 必须显式
  //   `instanceof Text`（老项目是纯 JS 才敢直接读 `.data`）。
  if (!(node instanceof Text) || !root.contains(node)) return empty;
  const data: string = node.data;
  const off = Math.max(0, Math.min(hit.startOffset, data.length));
  // 空白边界与老项目 :11079 的 isWs 同款（用字符码而非正则）
  let i = off;
  while (i > 0 && !isWs(data.charCodeAt(i - 1))) i -= 1;
  let j = off;
  while (j < data.length && !isWs(data.charCodeAt(j))) j += 1;
  const id = eggTokenAtNode(data, off);
  if (!id) return empty;
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

function isWs(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12288;
}

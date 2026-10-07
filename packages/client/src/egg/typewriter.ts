/**
 * 打字机音 —— **纯逻辑闸 + DOM 桥**（老项目 index.html:6783-6878）
 *
 * 🔴🔴 三条纪律（全部来自老项目注释里记着的真实故障）：
 *
 *   1. **只在复古皮肤环内发声，出环或静音即停。**
 *      老项目 `index.html:6783` 的文件头注释原文。守卫做在**纯逻辑层**
 *      （`tyKeydown` / `tyBeforeInput` / `tyCompositionEnd` 的第一行）而不是 DOM 桥里，
 *      这样"守卫被后人'顺手优化掉'"这件事能被单测直接抓住 —— 症状是
 *      默认皮肤下打字也会响，而那种"多了一点声音"的回归**永远不会有人报**。
 *
 *   2. **双通道 + 两处去重，缺一条就有一半机型哑火。**
 *      老项目 v8.3.1 方案B 的原话（`:6844-6845`）：触屏软键盘敲字符基本不发 keydown，
 *      桌面 IME 组字期字母又被静默 —— 只挂 keydown 通道的话，
 *      **中文状态下永远只剩回车响**。beforeinput 通道是兜底，不是冗余。
 *
 *   3. **同字符 50ms 连发抑制，抑制时也要链式占窗。**
 *      老项目 `:6863` 标注的实测（冻时钟实锤）：长按 auto-repeat 会逐次派发
 *      `insertText`（`e.repeat` 只守得住 keydown 那条死通道）。
 *      只记"上一声"的话33ms×2=66ms 就越窗漏响；链式占窗才拦得住。
 *
 * 🔴 为什么"打不出一声"也要记 `compAt` / `enterAt`：
 *   老项目 `:6867`「兜底响过即占住防重窗」—— 软键盘连打两次回车会叠双铃。
 *
 * 🔴 24ms 高速连打节流**不在本文件**：老项目把它放在发声函数 `nsTypeSound` 里
 *   （`:6805`，回车豁免），归sound.ts 所有。本文件的闸只管"该不该发"，
 *   声层管"发得出来发不出来"—— 与老项目分层一致。
 */

import type { SkinName } from '../ui/theme.ts';

/** 三个音种。老项目 `nsTypeSound(kind)` 的 kind 全集就这三个。 */
export type TyKind = 'key' | 'space' | 'enter';

/** keydown ↔ beforeinput 双通道去重（老项目 :6862：两事件同tick）。 */
export const TY_DUAL_MS = 10;
/** compositionend 刚兜过底时吞掉随后的 insertText（老项目 :6860）。 */
export const TY_COMP_MS = 60;
/** 同字符连发抑制（老项目 :6863）。🔴 抑制时也链式占窗。 */
export const TY_SAME_CHAR_MS = 50;
/** 换行铃去重（老项目 :6866）：keydown 刚响过就吞掉 beforeinput 的换行类二击。 */
export const TY_ENTER_MS = 300;

/**
 * 去重闸的可变状态。**每篇笔记一份**（跟着编辑器走，不进真源）。
 *
 * 老项目把这五个变量写成模块级 `let`（:6786/:6832）—— 单页应用里等价，
 * 因为整个页面只有一个编辑器。bj 的编辑器同样单例（`ui/shell.ts` 的
 * `editorHost` 是页内唯一），所以一份状态就够；但仍然收进对象而不是散成
 * 五个模块级变量，为的是**能被单测反复构造**而不互相污染。
 */
export interface TyGate {
  /** 上一次回车铃时刻（300ms 换行去重+ 兜底响过即占窗）。 */
  enterAt: number;
  /** 上一次 compositionend 时刻（60ms 吞随后的 insertText）。 */
  compAt: number;
  /** keydown 通道的字符与时刻（10ms 双通道去重的"keydown 侧"）。 */
  kdAt: number;
  kdData: string;
  /** beforeinput 通道上一记的字符与时刻（50ms 同字符抑制的"上一次"）。 */
  lastData: string;
  lastDataAt: number;
}

export function newTyGate(): TyGate {
  return { enterAt: 0, compAt: 0, kdAt: 0, kdData: '', lastData: '', lastDataAt: 0 };
}

/**
 * 是否在复古皮肤环内。
 *
 * 🔴 三态环里 `default` 是**环外**（老项目 `nsSkin === 0`），
 *   `terminal` / `typewriter` 两档是环内。判据放在这里而不是散在三个通道里，
 *   是为了让"环内"这个概念**只有一份**。
 */
export function inRetroRing(skin: SkinName): boolean {
  return skin !== 'default';
}

/** 会产生可见字符的 inputType（老项目 :6857 白名单）。粘贴/拖拽/删除一律不响。 */
export function isSoundInputType(inputType: string): boolean {
  return (
    inputType === 'insertText' ||
    inputType.indexOf('insertLine') === 0 ||
    inputType === 'insertParagraph'
  );
}

/** keydown 通道的输入。`inEditor` 由 DOM 桥判好传进来（判据本身在纯逻辑层，不在桥里）。 */
export interface TyKeyDown {
  key: string;
  /** 长按自动重复。老项目 :6836：不是新击键，不过滤会以 24ms 顶格连响。 */
  repeat: boolean;
  /** 229 = iOS WebKit 软键盘组字期，此时 key 不可信（老项目 :6837）。 */
  keyCode: number;
  /** ⌘/Ctrl/Alt 组合键不是"打字"。 */
  mod: boolean;
  inEditor: boolean;
}

/**
 * keydown 通道（老项目 :6833-6843）。返回该发的音种，不该发返回 null。
 *
 * 🔴 `repeat` 与 `keyCode === 229` 两条是这一通道**唯一**的防线
 *   （老项目 :6836-6837），去掉任何一条都会在真机上变成"按住一个键哗哗响"。
 */
export function tyKeydown(g: TyGate, skin: SkinName, e: TyKeyDown, now: number): TyKind | null {
  // 🔴 复古皮肤守卫：环外一律不发声（纪律①）。判据 TY-04 钉这一行。
  if (!inRetroRing(skin)) return null;
  if (e.mod) return null;
  if (e.repeat) return null;
  if (e.keyCode === 229) return null;
  if (!e.inEditor) return null;
  if (e.key === 'Enter') {
    g.enterAt = now;
    return 'enter';
  }
  if (e.key === ' ') return 'space';
  // 逐字母：英文直打与拼音组字期同通道（老项目 v8.3.2 用户拍板）。
  // 记下字符与时刻，供 beforeinput 的 10ms 双通道去重。
  if (e.key && e.key.length === 1) {
    g.kdAt = now;
    g.kdData = e.key;
    return 'key';
  }
  return null;
}

/** beforeinput 通道的输入。 */
export interface TyBeforeInput {
  inputType: string;
  /** 插入的文本。老项目 :6861 显式判 `typeof === 'string'`，null 要当空串。 */
  data: string | null;
  inEditor: boolean;
}

/**
 * beforeinput 通道（老项目 :6850-6870）。**两处去重都在这里。**
 *
 * 🔴 这一通道是"产生可见字符"的权威判据：软键盘 / 实体键 / 英文直打各响一声，
 *   粘贴 / 拖拽 / 撤回 / 补全 / 删除不响。老项目 :6848-6849 的口径逐字照抄。
 */
export function tyBeforeInput(g: TyGate, skin: SkinName, e: TyBeforeInput, now: number): TyKind | null {
  // 🔴 复古皮肤守卫：与 keydown 通道同一守卫（纪律①）。判据 TY-04 钉这一行。
  if (!inRetroRing(skin)) return null;
  if (!e.inEditor) return null;
  const ty = e.inputType || '';
  if (!isSoundInputType(ty)) return null;
  if (ty === 'insertText') {
    // compositionend 刚兜过底：吞掉双通道二击（老项目 :6860，120→60ms 是实测定过的）。
    if (now - g.compAt < TY_COMP_MS) return null;
    const d = typeof e.data === 'string' ? e.data : '';
    // 双通道去重：桌面物理键 keydown 刚响过同字符（两事件同 tick）。
    if (d && d === g.kdData && now - g.kdAt < TY_DUAL_MS) return null;
    // 🔴🔴 同字符 50ms 连发抑制（纪律③）。**抑制时也链式占窗**（`lastDataAt = now`）——
    //   只记"上一声"的话 33ms×2=66ms 越窗漏响（老项目 :6863 的冻时钟实锤）。
    if (d && d === g.lastData && now - g.lastDataAt < TY_SAME_CHAR_MS) {
      g.lastDataAt = now;
      return null;
    }
    g.lastData = d;
    g.lastDataAt = now;
    return 'key';
  }
  // 换行类：keydown 刚响过回车铃就吞掉二击（老项目 :6866）。
  if (now - g.enterAt < TY_ENTER_MS) return null;
  // 🔴 兜底响过即占住防重窗（老项目 :6867）：软键盘连打两次回车不叠双铃。
  g.enterAt = now;
  return 'enter';
}

/**
 * IME 整词上屏兜底（老项目 :6871-6878）。
 *
 * 🔴 为什么需要：部分国产 WebView 的 commit **不派 `insertText`**（`insertCompositionText`
 *   又被白名单排除），不挂这条通道的话中文打字会整段哑火 ——
 *   而这种哑火在桌面上测不出来（Blink 会派 insertText）。
 *
 * @param isComposing 老项目 `:6873` 的防御：显式 false 的伪事件不响。
 */
export function tyCompositionEnd(
  g: TyGate,
  skin: SkinName,
  isComposing: boolean,
  now: number,
): TyKind | null {
  // 🔴 复古皮肤守卫：三条通道同一守卫（纪律①）。判据 TY-04 钉这一行。
  if (!inRetroRing(skin)) return null;
  if (isComposing === false) return null;
  g.compAt = now;
  return 'key';
}

/* ------------------------------------------------------------------ *
 * DOM 桥
 * ------------------------------------------------------------------ */

export interface TyDeps {
  /** 当前皮肤（复古皮肤判定的唯一真源，`ui/theme.ts` 的 SkinName）。 */
  skin: () => SkinName;
  /**
   * 真的发声。`force` = 图鉴「再玩一次」点播示例音，
   * 绕开静音门（老项目 `nsTypeSound('enter', true)`）但**仍走 ctx running 检查**。
   * @returns 是否真的响了（`false` = 静音 / ctx 未解锁）。彩蛋埋点靠它。
   */
  play: (kind: TyKind, force?: boolean) => boolean;
}

export interface TyBinding {
  gate: TyGate;
  dispose: () => void;
}

/**
 * 挂三条输入通道。
 *
 * 🔴 三条都挂 **`document`** 而不是 `root`（老项目 `:6833/:6850/:6871` 同款）：
 *   `beforeinput` / `compositionend` 在部分内核里是从 `contenteditable` 派到
 *   document 才被观察到的，挂 root 会漏。编辑区内判据（`inEditor`）在纯逻辑层做，
 *   桥只负责取事件字段。
 *
 * @param root 编辑器根 DOM（`#editor-host`）
 */
export function bindTypewriterSound(root: HTMLElement, deps: TyDeps): TyBinding {
  const g = newTyGate();
  const inEditor = (t: EventTarget | null): boolean => t === root || root.contains(t as Node);

  const onKeydown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    const kind = tyKeydown(
      g,
      deps.skin(),
      {
        key: e.key,
        repeat: e.repeat,
        keyCode: e.keyCode,
        mod: e.metaKey || e.ctrlKey || e.altKey,
        inEditor: inEditor(e.target),
      },
      Date.now(),
    );
    if (kind !== null) deps.play(kind);
  };

  const onBeforeInput = (ev: Event): void => {
    const e = ev as InputEvent;
    const kind = tyBeforeInput(
      g,
      deps.skin(),
      { inputType: e.inputType, data: e.data, inEditor: inEditor(e.target) },
      Date.now(),
    );
    if (kind !== null) deps.play(kind);
  };

  const onCompositionEnd = (ev: Event): void => {
    const e = ev as CompositionEvent;
    // 🔴 `CompositionEvent.isComposing` 不在 TS 的 DOM lib 里（它是后加的、
    //   且部分 WebView 根本不带这个属性）—— 只能自己声明这个可选字段。
    //   🔴 关键：**读不到时必须当 true**（这条通道是"组字上屏没派 insertText"
    //   的唯一兜底），所以下面传的是 `raw?.isComposing !== false`：
    //   属性缺失 ⇒ undefined ⇒ !== false ⇒ true ⇒ 照响。
    //   写成 `?? true` 也对，但 `!== false` 顺带把"显式 false 的防御性伪事件"
    //   留在门外（老项目 :6873 那条判定的原意）。
    const raw = e as CompositionEvent & { isComposing?: boolean };
    const kind = tyCompositionEnd(g, deps.skin(), raw.isComposing !== false, Date.now());
    if (kind !== null) deps.play(kind);
  };

  document.addEventListener('keydown', onKeydown);
  document.addEventListener('beforeinput', onBeforeInput);
  document.addEventListener('compositionend', onCompositionEnd);

  return {
    gate: g,
    dispose: (): void => {
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('beforeinput', onBeforeInput);
      document.removeEventListener('compositionend', onCompositionEnd);
    },
  };
}

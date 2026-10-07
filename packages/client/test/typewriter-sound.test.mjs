/**
 * 打字机音（复古皮肤）—— 纯逻辑闸 + 声层节流单测（TY 系列）
 *
 * 🔴🔴 本文件的存在理由：打字机音的所有故障都是**零报错**的。
 *   · 守卫被"顺手优化"掉 ⇒ 默认皮肤下打字也响 ⇒ 多一点声音，**永远不会有人报障**；
 *   · 50ms 链式占窗被简化成"只记上一声" ⇒ 长按 auto-repeat 漏响 ⇒ 也没人报；
 *   · 24ms 节流被挪进闸门 ⇒ 与 fx() 的 60ms 混成一套 ⇒ 某个音偶尔不响 ⇒ 没法复现。
 *   所以判据必须**逐条钉死**，且每条都能在改动后真的变红。
 *
 * 🔴 判据来源：老项目 `index.html`
 *   :6783 只在复古皮肤环内的文件头纪律   :6798 WebAudio 合成（非采样）
 *   :6805 24ms 高速节流（回车豁免）      :6833 keydown 通道
 *   :6836 repeat 过滤   :6837 keyCode 229 过滤
 *   :6850 beforeinput 通道  :6857 inputType 白名单  :6860 comp 60ms
 *   :6862 双通道 10ms     :6863 同字符 50ms 链式占窗
 *   :6866 换行 300ms      :6867 兜底响过即占窗      :6871 compositionend 兜底
 *
 * 🔴 本文件所有断言都**先 stripComments 去注释**再数出现次数 —— 注释里就写着
 *   `50` / `300` / `inRetroRing` 这些名字，不去必然假绿。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { stripComments } from './rem-native.test.mjs';
import {
  TY_DUAL_MS,
  TY_COMP_MS,
  TY_SAME_CHAR_MS,
  TY_ENTER_MS,
  newTyGate,
  inRetroRing,
  isSoundInputType,
  tyKeydown,
  tyBeforeInput,
  tyCompositionEnd,
  bindTypewriterSound,
} from '../src/egg/typewriter.ts';

const TY_SRC = readFileSync(new URL('../src/egg/typewriter.ts', import.meta.url), 'utf8');
const SOUND_SRC = readFileSync(new URL('../src/egg/sound.ts', import.meta.url), 'utf8');

/** 去注释后的源码（判"某段代码不存在"/"共 N 处"时必须先做这一步）。 */
const clean = (src) => stripComments(src);
/**
 * 去注释但保留字符串字面量**内容**（判"某个字面量必须出现"时用这个）。
 *
 * 🔴🔴 注意它**连引号一起去掉**：`'keydown'` ⇒ `keydown`。
 *   所以下面的字面量匹配一律写**无引号**形态。这不是笔误 ——
 *   写成 `'keydown'` 会恒不匹配，看起来像"判据抓到了问题"，其实是判据自己写错了。
 *   （默认模式更糟：整个字面量变成 `""`，任何 `xxx('')` 形态的断言都恒真。）
 */
const cleanKeepStr = (src) => stripComments(src, { keepStrings: true });

/** keydown 事件的默认载荷（合法的一击）。 */
const KD = (over = {}) => ({
  key: 'a',
  repeat: false,
  keyCode: 65,
  mod: false,
  inEditor: true,
  ...over,
});
/** beforeinput 事件的默认载荷。 */
const BI = (over = {}) => ({ inputType: 'insertText', data: 'a', inEditor: true, ...over });

/* ============ TY-01 四个去重窗口的字面量必须与老项目一致 ============ */

test('TY-01 四个去重窗口的字面量与老项目 :6860/:6862/:6863/:6866 一致', () => {
  assert.equal(TY_DUAL_MS, 10, '双通道窗口必须是 10ms（老项目 :6862）');
  assert.equal(TY_COMP_MS, 60, 'compositionend 吞随后的 insertText 窗口必须是 60ms（老项目 :6860）');
  assert.equal(TY_SAME_CHAR_MS, 50, '同字符连发抑制窗口必须是 50ms（老项目 :6863）');
  assert.equal(TY_ENTER_MS, 300, '换行铃去重窗口必须是 300ms（老项目 :6866）');
});

test('TY-01b 四个常量在源码里各只被导出一次（防止有人另开一份 50ms）', () => {
  const c = clean(TY_SRC);
  for (const name of ['TY_DUAL_MS', 'TY_COMP_MS', 'TY_SAME_CHAR_MS', 'TY_ENTER_MS']) {
    const decl = c.split(`export const ${name} =`).length - 1;
    assert.equal(decl, 1, `${name} 必须恰好导出一次（发现 ${decl} 处）`);
  }
});

/* ============ TY-02 复古皮肤环：三态里只有 default 在环外 ============ */

test('TY-02 inRetroRing 只把 default 判为环外', () => {
  assert.equal(inRetroRing('default'), false, 'default 是环外（老项目 nsSkin===0）');
  assert.equal(inRetroRing('terminal'), true, 'terminal 是环内');
  assert.equal(inRetroRing('typewriter'), true, 'typewriter 是环内');
});

test('TY-02b 环判定只有一份实现（不许三条通道各写一遍 skin !== "default"）', () => {
  // 🔴 keepStrings 后字面量**不带引号**（见 cleanKeepStr 的注释）。
  const c = cleanKeepStr(TY_SRC);
  const lit = c.split('skin !== default').length - 1;
  assert.equal(lit, 1, `skin !== default 字面量应只在 inRetroRing 里出现一次（发现 ${lit} 处）`);
  // 🔴 返回类型标注（`: boolean {`）必须在正则里显式吃掉，否则 `{` 匹配不上。
  assert.match(c, /function inRetroRing\([^)]*\)\s*:\s*boolean\s*\{\s*return skin !== default;/,
    'inRetroRing 必须直接返回该判定，不许夹别的条件');
});

/* ============ TY-03 复古皮肤守卫：三条通道第一行就是它 ============ */

test('TY-03 三条通道在默认皮肤下一律不发声（环外守卫的行为面）', () => {
  const g1 = newTyGate();
  assert.equal(tyKeydown(g1, 'default', KD({ key: 'Enter' }), 1000), null, 'keydown 环外不发');
  assert.equal(tyBeforeInput(newTyGate(), 'default', BI(), 1000), null, 'beforeinput 环外不发');
  assert.equal(tyCompositionEnd(newTyGate(), 'default', true, 1000), null, 'compositionend 环外不发');
  // 🔴 更强的一条：环外**连状态都不许改**。否则"切出皮肤前的那一次回车"
  //   仍然会占掉 300ms 窗，用户切回来立刻按回车听不到声 —— 而这零报错。
  assert.equal(g1.enterAt, 0, '环外不得占用 enterAt 窗');
  const g2 = newTyGate();
  tyBeforeInput(g2, 'default', BI(), 1000);
  assert.equal(g2.lastDataAt, 0, '环外不得占用 lastDataAt 窗');
});

test('TY-03b 守卫必须在函数体的第一条语句（不许排在别的判断之后）', () => {
  const c = clean(TY_SRC);
  // 三个函数的签名行 → 到第一个 `if` 之间的内容必须**只有**守卫本身。
  for (const fn of ['tyKeydown', 'tyBeforeInput', 'tyCompositionEnd']) {
    const sig = c.indexOf(`export function ${fn}(`);
    assert.notEqual(sig, -1, `${fn} 必须导出`);
    // 🔴 参数里有对象类型标注（`e: TyKeyDown` 之类没有，但返回类型前的
    //   `): TyKind | null {` 才是函数体起点）—— 必须从**返回值类型之后**找 `{`，
    //   直接找第一个 `{` 会落在别处。
    const m = /\)\s*:\s*[^;{]*\{/.exec(c.slice(sig));
    assert.ok(m, `${fn} 签名后应有返回值类型 + 开括号（实际：${JSON.stringify(c.slice(sig, sig + 160))}）`);
    const bodyStart = sig + m.index + m[0].length;
    // 守卫是「守卫 + return null」两句，取到第一个分号为止。
    const guard = /if \(!inRetroRing\(skin\)\) return null;/.exec(c.slice(bodyStart));
    assert.ok(guard,
      `${fn} 体内找不到复古皮肤守卫（实际开头：${JSON.stringify(c.slice(bodyStart, bodyStart + 120))}）`);
    const before = c.slice(bodyStart, bodyStart + guard.index);
    assert.equal(before.trim(), '',
      `${fn} 的守卫之前不许有任何别的语句（实际前置：${JSON.stringify(before)}）`);
  }
});

/* ============ TY-04 同字符 50ms 抑制 + 链式占窗 ============ */

test('TY-04 同字符 50ms 内连发被抑制', () => {
  const g = newTyGate();
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1000), 'key', '第一声要响');
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1030), null, '30ms 内同字符要抑制');
});

test('TY-04b 🔴 抑制时必须链式占窗（33ms×2=66ms 的老项目实测口径）', () => {
  const g = newTyGate();
  tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1000);
  // 三击：0 / 33 / 66ms。若"只记上一声"，第三击（66 - 0 = 66 > 50）会漏响。
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1033), null, '第二击抑制');
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1066), null,
    '第三击（距第一声 66ms）仍须抑制 —— 说明 lastDataAt 被链式刷新过');
});

test('TY-04c 链式占窗的实证：第三击之后距第四击 40ms 仍须抑制', () => {
  const g = newTyGate();
  tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1000);
  tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1040);
  tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1080);
  // 距**最近一次被抑制**的那一记（1080）只过了 40ms；若占窗没刷新，40+80=120>50 会响。
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1120), null,
    '占窗必须以最近一次事件为基准，而不是以"上一次响过的"为基准');
});

test('TY-04d 不同字符不受 50ms 抑制约束（这条闸只管同字符）', () => {
  const g = newTyGate();
  tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1000);
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: 'b' }), 1005), 'key',
    '5ms 内的另一个字符要响');
});

test('TY-04e 超窗必响（50ms 是抑制窗不是禁音）', () => {
  const g = newTyGate();
  tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1000);
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1060), 'key', '60ms 后同字符要响');
});

test('TY-04f 抑制逻辑必须在源码里真的写了对 lastDataAt 的赋值（防"注释提到但没做"）', () => {
  const c = clean(TY_SRC);
  const m = /if \(d && d === g\.lastData && now - g\.lastDataAt < TY_SAME_CHAR_MS\) \{([^}]*)\}/.exec(c);
  assert.ok(m, '源码里应能找到同字符抑制分支');
  assert.match(m[1], /g\.lastDataAt = now;/,
    '抑制分支体内必须有 lastDataAt = now（链式占窗）；只 return null 等于只记上一声');
});

/* ============ TY-05 双通道 10ms 去重 ============ */

test('TY-05 keydown 后 10ms 内的同字符 insertText 被吞（两事件同 tick）', () => {
  const g = newTyGate();
  assert.equal(tyKeydown(g, 'typewriter', KD({ key: 'a' }), 1000), 'key', 'keydown 通道响');
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1005), null, 'beforeinput 二击要吞');
});

test('TY-05b 超 10ms 的同字符不吞（软键盘路径不受影响）', () => {
  const g = newTyGate();
  tyKeydown(g, 'typewriter', KD({ key: 'a' }), 1000);
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: 'a' }), 1020), 'key', '20ms 后要放行');
});

test('TY-05c 双通道去重只对同字符生效', () => {
  const g = newTyGate();
  tyKeydown(g, 'typewriter', KD({ key: 'a' }), 1000);
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: 'b' }), 1001), 'key', '异字符不受 10ms 约束');
});

/* ============ TY-06 compositionend 60ms 吞随后的 insertText ============ */

test('TY-06 compositionend 后 60ms 内的 insertText 被吞', () => {
  const g = newTyGate();
  assert.equal(tyCompositionEnd(g, 'typewriter', true, 1000), 'key', '组字上屏要响兜底声');
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: '中' }), 1040), null, '随后的 insertText 吞掉');
});

test('TY-06b 超 60ms 放行（用户继续打字要能再响）', () => {
  const g = newTyGate();
  tyCompositionEnd(g, 'typewriter', true, 1000);
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ data: '中' }), 1100), 'key', '100ms 后放行');
});

test('TY-06c isComposing 显式 false 的伪事件不响（老项目 :6873 的防御）', () => {
  assert.equal(tyCompositionEnd(newTyGate(), 'typewriter', false, 1000), null,
    '显式 false 是防御性伪事件，不该发声');
});

/* ============ TY-07 换行铃 300ms 去重 + 兜底响过即占窗 ============ */

test('TY-07 keydown 回车后 300ms 内的换行类 insertText 被吞', () => {
  const g = newTyGate();
  assert.equal(tyKeydown(g, 'typewriter', KD({ key: 'Enter' }), 1000), 'enter', '回车响');
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ inputType: 'insertLineBreak' }), 1200), null,
    '200ms 内的换行二击要吞');
});

test('TY-07b 🔴 兜底响过即占窗（软键盘连打两次回车不叠双铃，老项目 :6867）', () => {
  const g = newTyGate();
  // 没有 keydown 参与，纯 beforeinput 连打两次回车
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ inputType: 'insertParagraph' }), 1000), 'enter');
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ inputType: 'insertParagraph' }), 1100), null,
    '兜底响过也必须占住 300ms 窗');
});

test('TY-07c 超 300ms 放行', () => {
  const g = newTyGate();
  tyBeforeInput(g, 'typewriter', BI({ inputType: 'insertLineBreak' }), 1000);
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ inputType: 'insertLineBreak' }), 1400), 'enter',
    '400ms 后第二记换行要响');
});

test('TY-07d 兜底占窗必须写 enterAt（源码层）', () => {
  const c = cleanKeepStr(TY_SRC);
  assert.match(c, /if \(now - g\.enterAt < TY_ENTER_MS\) return null;\s*g\.enterAt = now;\s*return enter;/,
    '换行分支必须"判窗 → 占窗 → 返回"三步连写');
});

/* ============ TY-08 inputType 白名单：只有产生可见字符的才响 ============ */

test('TY-08 白名单与老项目 :6857 一致', () => {
  for (const t of ['insertText', 'insertLineBreak', 'insertParagraph', 'insertCompositionText'.replace('Composition', 'Line')]) {
    assert.equal(isSoundInputType(t), true, `${t} 应响`);
  }
  assert.equal(isSoundInputType('insertFromPaste'), false, '粘贴不响');
  assert.equal(isSoundInputType('insertFromDrop'), false, '拖拽不响');
  assert.equal(isSoundInputType('deleteContentBackward'), false, '删除不响');
  assert.equal(isSoundInputType('insertCompositionText'), false, '组字中插��要响（老项目 :6874 的口径）');
  assert.equal(isSoundInputType(''), false, '空 inputType 不响');
});

test('TY-08b 白名单外的输入即使在编辑器内也不发声（行为面）', () => {
  const g = newTyGate();
  assert.equal(tyBeforeInput(g, 'typewriter', BI({ inputType: 'insertFromPaste', data: 'x' }), 1000), null);
  // 🔴 粘贴不该占掉 enterAt / lastData 窗，否则粘贴一次后紧接着的回车会哑掉。
  assert.equal(g.enterAt, 0, '粘贴不得占换行窗');
  assert.equal(g.lastDataAt, 0, '粘贴不得占同字符窗');
});

/* ============ TY-09 keydown 通道的三条过滤 ============ */

test('TY-09 keydown 通道过滤 repeat / keyCode 229 / 组合键 / 编辑区外', () => {
  assert.equal(tyKeydown(newTyGate(), 'typewriter', KD({ repeat: true }), 1000), null, '长按 repeat 不响');
  assert.equal(tyKeydown(newTyGate(), 'typewriter', KD({ keyCode: 229 }), 1000), null, '组字期 229 不响');
  assert.equal(tyKeydown(newTyGate(), 'typewriter', KD({ mod: true }), 1000), null, '组合键不响');
  assert.equal(tyKeydown(newTyGate(), 'typewriter', KD({ inEditor: false }), 1000), null, '编辑区外不响');
});

test('TY-09b 三个音种齐备：Enter→enter / 空格→space / 单字符→key', () => {
  assert.equal(tyKeydown(newTyGate(), 'typewriter', KD({ key: 'Enter' }), 1), 'enter');
  assert.equal(tyKeydown(newTyGate(), 'typewriter', KD({ key: ' ' }), 1), 'space');
  assert.equal(tyKeydown(newTyGate(), 'typewriter', KD({ key: 'a' }), 1), 'key');
  assert.equal(tyKeydown(newTyGate(), 'typewriter', KD({ key: 'ArrowLeft' }), 1), null, '非字符键不响');
  assert.equal(tyKeydown(newTyGate(), 'typewriter', KD({ key: 'Shift' }), 1), null, 'Shift 不响');
});

/* ============ TY-10 DOM 桥：三条监听都挂 document 且 add/remove 配平 ============ */

test('TY-10 三条通道都挂 document（不是 root）—— beforeinput/compositionend 在部分内核只在 document 上被观察到', () => {
  const c = cleanKeepStr(TY_SRC);
  for (const ev of ['keydown', 'beforeinput', 'compositionend']) {
    // 🔴 keepStrings 后字面量不带引号（见 cleanKeepStr 的注释）
    assert.match(c, new RegExp(`document\\.addEventListener\\(${ev}`),
      `${ev} 必须挂 document`);
    assert.match(c, new RegExp(`document\\.removeEventListener\\(${ev}`),
      `${ev} 必须有对应的 removeEventListener（否则 dispose 是假的）`);
  }
});

test('TY-10b add 与 remove 的事件名与顺序一一对应', () => {
  const c = cleanKeepStr(TY_SRC);
  const adds = [...c.matchAll(/document\.addEventListener\(([a-z]+)/g)].map((m) => m[1]);
  const removes = [...c.matchAll(/document\.removeEventListener\(([a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(adds, removes, 'add/remove 的事件名与顺序必须完全一致');
  assert.deepEqual(adds, ['keydown', 'beforeinput', 'compositionend'], '三条通道各挂一次');
});

/* ============ TY-11 声层：复用 egg/sound.ts 的唯一 AudioContext ============ */

test('TY-11 🔴 打字机音不得新造 AudioContext（多 ctx 会被浏览器限制，老项目 :6798 的合成全在唯一 ctx 里）', () => {
  const tyClean = clean(TY_SRC);
  assert.doesNotMatch(tyClean, /new AudioContext|new (webkitAudioContext|OfflineAudioContext)/,
    'egg/typewriter.ts 绝不允许出现 new AudioContext —— ctx 的唯一所有者是 egg/sound.ts');
  assert.doesNotMatch(tyClean, /createOscillator|createGain|createBiquadFilter|AudioBufferSourceNode/,
    '合成节点不属于闸门层（老项目把合成放在 nsTypeSound 里，归声层）');
});

test('TY-11b 声层 type() 必须走 actx()（既有唯一 ctx），不得自行开 ctx', () => {
  const s = clean(SOUND_SRC);
  const m = /type:\s*\(kind[\s\S]*?\n {4}\},\n/.exec(s);
  assert.ok(m, 'sound.ts 里应能找到 type 的实现块');
  const body = m[0];
  assert.match(body, /actx\(\)/, 'type() 必须用 actx() 拿既有 ctx');
  assert.doesNotMatch(body, /new AudioContext/, 'type() 不得 new AudioContext');
  assert.match(body, /muted/, '必须判静音（老项目 tyMuted）');
});

test('TY-11c 白噪声缓冲按 ctx 缓存（跨 ctx 复用会把上一个 ctx 的采样搬过来 = 静音或爆音）', () => {
  const s = clean(SOUND_SRC);
  assert.match(s, /tyNoiseCtx === c/,
    '噪声缓冲必须以"当前 ctx 是同一个"为缓存判据，否则换 ctx 后拿到的是旧采样');
  assert.match(s, /tyNoise\s*=/, '必须有 tyNoise 缓存槽');
  assert.match(s, /tyNoiseCtx\s*=/, '必须记录 tyNoiseCtx');
});

/* ============ TY-12 24ms 高速节流归声层，且回车豁免 ============ */

test('TY-12 24ms 节流在声层不在闸门（与老项目分层一致）', () => {
  const tyClean = clean(TY_SRC);
  assert.doesNotMatch(tyClean, /tyLastAt/,
    '闸门层不得持有发声节流状态（老项目 :6805 把它放在 nsTypeSound 里）');
  assert.doesNotMatch(tyClean, /\b24\b/,
    '闸门层不得出现 24 这个节流窗口（它归声层）');
});

test('TY-12b 声层 24ms 节流存在，且回车豁免', () => {
  const s = cleanKeepStr(SOUND_SRC);
  assert.match(s, /tyLastAt/, '声层必须有 tyLastAt');
  const m = /kind !== enter && now - tyLastAt < 24/.test(s);
  assert.ok(m, '声层必须有"非回车才过节流"的 24ms 闸（回车必须豁免，否则连打回车会丢音）');
});

test('TY-12c 🔴 24ms 与 fx() 的 60ms 是两套独立节流（合成两套会让某个音永远不响或永远响）', () => {
  const s = cleanKeepStr(SOUND_SRC);
  const uses = s.split('tyLastAt').length - 1;
  assert.ok(uses >= 3, `tyLastAt 至少要被"声明 + 判 + 写"三处引用（实际 ${uses} 处）`);
  // fx() 的 60ms 仍在（老项目音效用另一套窗口）
  assert.match(s, /60/, 'fx() 的 60ms 节流必须仍在');
  // type() 不得复用 fx()
  const m = /\n {4}type: \(kind, force\)[\s\S]*?\n {4}\}[,;]/.exec(s);
  assert.ok(m, 'sound.ts 里应能找到 type 的实现块');
  assert.doesNotMatch(m[0], /\bfx\(/, 'type() 不得复用 fx()（节流窗口与音色都不同）');
});

/* ============ TY-13 静音门：force 只绕静音，不绕 ctx 未解锁 ============ */

test('TY-13 静音时 type() 返回 false（彩蛋埋点靠这个返回值，不能静默当成功）', () => {
  const s = cleanKeepStr(SOUND_SRC);
  const m = /\n {4}type: \(kind, force\)[\s\S]*?\n {4}\}[,;]/.exec(s);
  assert.ok(m, 'sound.ts 里应能找到 type 的实现块');
  assert.match(m[0], /!force && muted/, '静音早退必须是 `!force && muted`（force 绕静音）');
  assert.match(m[0], /c\.state !== running/,
    '必须再判 ctx.state —— force（点播示例音）也不能在 ctx 未解锁时假装成功');
  assert.match(m[0], /return true/, '成功路径要 return true');
  assert.match(m[0], /return false/, '静音路径要 return false');
});

/* ============ TY-14 埋点接线：真响才 markDiscovered ============ */

test('TY-14 主模块必须把彩蛋 type 的埋点挂在"真的响了"上', () => {
  const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const c = cleanKeepStr(MAIN);
  assert.match(c, /bindTypewriterSound\(/, 'main.ts 必须调 bindTypewriterSound');
  const m = /play: \(kind, force\) => \{[\s\S]*?\n {6}\},/.exec(c);
  assert.ok(m, 'main.ts 必须提供 play 回调');
  assert.match(m[0], /markDiscovered\(eggBrowserStore\(\), type, true\)/,
    "play 回调里必须 markDiscovered(eggBrowserStore(), 'type', true)");
  // 🔴 埋点必须在"真的响了"的守卫之内，否则静音也会被记成体验过。
  assert.match(m[0], /if \(rang\) markDiscovered/, '埋点必须挂在 if (rang) 之内');
});

test('TY-14b 图鉴 replay 走声层点播（force=true），且 layer 里 type/diag 不在 defs 里', () => {
  const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const c = cleanKeepStr(MAIN);
  assert.match(c, /id === type[\s\S]{0,160}type\(enter, true\)/,
    "replaySide('type') 必须调 type('enter', true)（force 绕静音点播示例音）");
  const LAYER = cleanKeepStr(readFileSync(new URL('../src/egg/layer.ts', import.meta.url), 'utf8'));
  // 🔴 defs 带类型标注（`const defs: Record<string, () => AnyGame> = {`），
  //   正则里必须把那一句显式吃掉，否则 `{` 之前就断了。
  const defs = /const defs[^\n]*=\s*\{([\s\S]*?)\n {2}\};/.exec(LAYER);
  assert.ok(defs, '应能找到 layer.ts 的 defs 表');
  assert.doesNotMatch(defs[1], /type\s*:|diag\s*:/,
    "defs 的值类型是 () => AnyGame，塞 type/diag 会让 shell.launch() 拿到非游戏对象");
  assert.match(LAYER, /const SIDE_EGGS = \[type, diag\]/,
    'SIDE_EGGS 必须恰好是 type 与 diag 两个');
});

/* ============ TY-15 复古皮肤切换要打 skin 埋点（老项目 :1744-1759） ============ */

test('TY-15 切进复古皮肤要 markDiscovered(skin)', () => {
  const MAIN = cleanKeepStr(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'));
  const m = /skin !== default\) markDiscovered\(eggBrowserStore\(\), skin, true\)/.test(MAIN);
  assert.ok(m, "onSkin 里应有 `if (skin !== 'default') markDiscovered(..., 'skin', true)`");
});

/**
 * ST- 切皮肤反馈气泡（老项目 index.html:1737-1743 `say()` + :1758）
 *
 * 老项目为什么要有这个气泡：七连点是**隐蔽彩蛋**，切档后左上角字标变了
 * （NoteSync → NOTE-SYNC.EXE → N O T E S Y N C），但那行字本来就在角落里；
 * 而档位名只写在 `brand.title`（原生 tooltip）上 —— **触屏没有 hover**，
 * 手机用户连点七下后唯一能看到的只有"配色变了"，说不出变成了哪一档。
 * bj v1.13.0 之前没有这个气泡，正是这个状态。
 *
 * 🔴🔴 本文件钉的不是"气泡长什么样"，而是三件会**静默退化**的事：
 *   1. 气泡**只由七连点**触发 —— 挂在 `setSkin()` 里 ⇒ 每次打开笔记先弹 1.5s
 *      （`setSkin` 首屏就要调一次清残留纹路），那是把彩蛋变成骚扰。
 *   2. CSS 里 `#skinToast` **真的有规则** —— 只建元素没建样式 = "有壳无字"，
 *      本项目在 `.ns-qr-warn` 上栽过同款（"用了类名 ≠ 样式命中它"）。
 *   3. 每日一句**让位**给同位气泡 —— 老项目 :8433 的让位清单里那一项就是
 *      皮肤气泡（它复用的 `#versionToast`），bj 换了 id 就得补进清单，
 *      否则切完皮肤两层胶囊叠在 `top:54px` 同一个位置。
 *
 * 文案三句（`已恢复默认` / `复古 · 终端绿` / `复古 · 打字机纸`）由
 * ui-contract.test.mjs S4 钉着，这里**不重复钉**（重复钉 = 改文案要改两处）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SKIN_TOAST_ID } from '../src/ui/shell.ts';

/** 源码（去注释）—— 用于"接线在不在"这类结构性判据。 */
function codeOf(rel) {
  const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 从 `const name = ` 处按花括号配平截出函数体（不含结尾 `}`）。
 *
 * 🔴 同 last-note.test.mjs 的 `sliceBlock`：按固定长度 slice 会越过函数尾，
 *   把紧随其后的正确代码一起吃进来 ⇒ 判据恒红（红在别人的代码上）。
 */
function blockOf(code, decl) {
  const start = code.indexOf(decl);
  assert.ok(start >= 0, `源码里应能找到 ${decl}`);
  const open = code.indexOf('{', start);
  assert.ok(open > 0, `${decl} 后面应该有一个 {`);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i);
    }
  }
  throw new Error(`${decl} 的花括号不配平，判据自身有问题`);
}

const SHELL = codeOf('src/ui/shell.ts');
const CSS = codeOf('src/ui/styles.css');
const FX = codeOf('src/egg/fx.ts');

/* ---------------- ST-1 触发点：只在七连点里、且在切档之后 ---------------- */

test('ST-1 🔴🔴 气泡只由七连点触发，绝不挂在 setSkin 里（首屏不许弹）', () => {
  const countTap = blockOf(SHELL, 'const countTap = ');
  const setSkin = blockOf(SHELL, 'const setSkin = ');

  assert.ok(countTap.includes('saySkin('), '七连点里必须弹气泡');
  assert.ok(!setSkin.includes('saySkin'), 'setSkin 里绝不能弹 —— 首屏那一次会变成骚扰');

  // 顺序：先切档、后报。反过来气泡里显示的是**旧档名**。
  const at = countTap.indexOf('saySkin(');
  const setAt = countTap.indexOf('cb.onSkin?.(skin)');
  assert.ok(setAt >= 0, '七连点里必须先切档（cb.onSkin）');
  assert.ok(at > setAt, `必须先切档再弹气泡，实际 saySkin@${at} / onSkin@${setAt}`);
});

test('ST-1 🔴 反向：全文件 saySkin 只能有「1 处定义 + 1 处调用」', () => {
  // 🔴 恒真断言 = 没有断言。只判"至少有一处调用"的话，
  //   将来某人把它也塞进 onThemeChange（切日夜也弹）照样全绿。
  const defs = SHELL.match(/const saySkin = /g) ?? [];
  const calls = SHELL.match(/saySkin\(/g) ?? [];
  assert.equal(defs.length, 1, `saySkin 应只有 1 处定义，实际 ${defs.length}`);
  assert.equal(calls.length, 1, `saySkin 应只有 1 处调用，实际 ${calls.length}`);
});

/* ---------------- ST-2 时长与文案来源 ---------------- */

test('ST-2 🔴 驻留 1500ms（老项目 index.html:1742 的 1500，不是每日一句的 4.2s）', () => {
  const m = /const SKIN_TOAST_MS = (\d+);/.exec(SHELL);
  assert.ok(m, '应能读到 SKIN_TOAST_MS 常量');
  assert.equal(Number(m[1]), 1500, `切档气泡驻留应为 1500ms，实际 ${m[1]}`);
});

test('ST-2 🔴🔴 文案取 SKIN_LABELS，不在气泡里另写字面量', () => {
  const say = blockOf(SHELL, 'const saySkin = ');
  assert.ok(say.includes('SKIN_LABELS['), '文案必须取自 theme.ts 的 SKIN_LABELS（与 tooltip 同源）');
  // 反向：另写字面量 ⇒ 改 tooltip 不改气泡，两处漂移
  for (const lit of ['已恢复默认', '复古', '打字机纸', '终端绿']) {
    assert.ok(!say.includes(lit), `气泡里不得内联文案字面量「${lit}」`);
  }
});

/* ---------------- ST-3 入场动画必须能重播 ---------------- */

test('ST-3 🔴 连续切档时第二句也要淡入（摘 show → 强制回流 → 加 show）', () => {
  const say = blockOf(SHELL, 'const saySkin = ');
  const rm = say.indexOf("classList.remove('show')");
  const reflow = say.indexOf('offsetWidth');
  const add = say.indexOf("classList.add('show')");
  assert.ok(rm >= 0 && add > rm, '应先摘 show 再加 show');
  assert.ok(reflow > rm && reflow < add, '中间必须有一次强制回流，否则浏览器把两次 class 变更合并 ⇒ 第二句没有淡入');
});

/* ---------------- ST-4 CSS 真的有规则（不是"有元素没样式"） ---------------- */

test('ST-4 🔴🔴 #skinToast 在 styles.css 里与 #nsDayToast 并列有规则', () => {
  // 🔴 必须去注释后再匹配：注释里写着 `#skinToast` 会让这条断言**恒绿**。
  assert.ok(/,\s*#skinToast\s*\{/.test(CSS), '应与 #nsDayToast 共用同一条规则（选择器并列，不是通配）');
  assert.ok(/,\s*#skinToast\.show\s*\{/.test(CSS), '.show 态也要并列，否则气泡永不显现');
  // 反向：只写一条 opacity:0 的规则 = 元素永远隐形
  assert.ok(/#skinToast\.show[^{]*\{[^}]*opacity:\s*1/.test(CSS), '.show 必须把 opacity 提到 1');
});

/* ---------------- ST-5 每日一句让位清单 ---------------- */

test('ST-5 🔴 每日一句让位清单必须含 #skinToast.show（两层胶囊同在 top:54px）', () => {
  assert.ok(FX.includes('#skinToast.show'), 'fx.ts 的同位浮层清单要补上切档气泡');
  // 反向：别为了加新的把老的删了
  assert.ok(FX.includes('#versionToast.show'), '让位清单里原有的 #versionToast 不能被顺手删掉');
  assert.ok(FX.includes('#nsGreet.show'), '让位清单里原有的 #nsGreet 不能被顺手删掉');
});

/* ---------------- ST-6 id 唯一出处 ---------------- */

test('ST-6 🔴 挂点 id 从 shell.ts 导出，值固定为 skinToast', () => {
  // 🔴 导入生产代码的常量，不在测试里抄一份字面量（抄了就永远一致，判据恒绿）
  assert.equal(SKIN_TOAST_ID, 'skinToast');
  assert.ok(
    SHELL.includes(`toastEl.id = SKIN_TOAST_ID`),
    '元素 id 必须取这个常量，不写字面量（改一处忘了另一处 = 样式挂不上）',
  );
});

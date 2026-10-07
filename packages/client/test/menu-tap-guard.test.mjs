/**
 * MTG- 菜单触屏首击兜底（老项目 index.html:7915-7938 `menuTapGuard`）
 *
 * 病根（老项目 v6.2/v6.3 实测，不是推测）：菜单主视图是滚动容器
 *   （bj：`#menuMainView{max-height:min(72vh,560px);overflow-y:auto}`），
 *   触屏上手指落下时浏览器先判"这是不是一次滚动手势"，于是**第一次点按的 click
 *   被吞掉** —— 用户看到的是「返回首页要点两次」。
 *
 * 🔴 `touch-action: manipulation`（bj `.menu-item` 里也有）**管不了这个**：
 *   它只去掉双击缩放那 300ms 延迟。靠 CSS 就等于没修。
 *
 * 🔴🔴 本文件钉的是**四段时序的完整性**。任何一段漏掉都不是"功能弱一点"，
 *   而是变成**更坏的 bug**，所以每条都配了反向断言：
 *     pointerdown 记起点  → 漏了：不知道有没有位移 ⇒ 滚动也被当成点击
 *     pointermove 判位移  → 漏了：**想滚列表却跳进了某篇笔记**
 *     pointerup  后补发   → 漏了：兜底根本不存在（等于没做这个功能）
 *     click 吞迟到的真click → 漏了：**一次点击执行两遍**（开两个弹层 / 发两次请求）
 *
 * 真浏览器行为判据见 test/e2e/23-menu-tap-guard.test.js（本文件只钉源码结构，
 * 因为"click 被浏览器吞掉"这个现场只能靠 e2e 里的 capture 拦截器复现）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 源码（去注释）—— 用于"接线在不在"这类结构性判据。 */
function codeOf(rel) {
  const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 从 `decl` 处按花括号配平截出块体（不含结尾 `}`）。 */
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

/**
 * 截出一次 `addEventListener(...)` 调用的**圆括号内部**（不含首尾括号）。
 *
 * 🔴 为什么按圆括号配平而不是按行：监听器写成多行（参数各占一行），
 *   按固定行数 slice 会切在参数中间，判据读到的东西与语义无关。
 */
function listenerInner(code, evt) {
  const re = new RegExp(`\\.addEventListener\\(\\s*'${evt}'`);
  const m = re.exec(code);
  assert.ok(m, `应能找到 ${evt} 的 addEventListener`);
  const open = m.index + m[0].length - 1; // 指到 ( 之后的第一个字符位置（'evt' 的引号处）
  // 从 'evt' 的引号往回找真正的左括号
  const paren = code.lastIndexOf('(', open);
  let depth = 0;
  for (let i = paren; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(paren + 1, i);
    }
  }
  throw new Error(`${evt} 的监听器圆括号不配平，判据自身有问题`);
}

const MENU = codeOf('src/ui/menu.ts');
const GUARD = blockOf(MENU, 'function tapGuard(');
const RENDER = blockOf(MENU, 'const render = ');

/* ---------------- MTG-1 四段监听齐全、都在常驻 box 上、都 capture ---------------- */

test('MTG-1 🔴🔴 四个 pointer 监听一个都不能少，且都挂在常驻 box 上', () => {
  for (const evt of ['pointerdown', 'pointermove', 'click', 'pointerup']) {
    const re = new RegExp(`\\bbox\\s*\\.addEventListener\\(\\s*'${evt}'`);
    assert.ok(re.test(GUARD), `${evt} 必须挂在常驻的 box 上（不是每次 render 的行）`);
  }
  // 反向：render() 里不许出现 pointer 接线（那会每次重画重新接一次，close 清内容时还丢）
  assert.ok(!RENDER.includes('pointerup'), 'render() 里不许接 pointerup（盒子常驻、只换内容）');
});

test('MTG-1 🔴 四个监听都必须在**捕获阶段**（capture=true）', () => {
  // 🔴 为什么必须是 capture：兜底要在**行的 click 处理器之前**先看到 click，
  //   才能在"迟到的真实 click"到达时把它吞掉。冒泡阶段早就执行完了。
  for (const evt of ['pointerdown', 'pointermove', 'click', 'pointerup']) {
    const inner = listenerInner(GUARD, evt);
    assert.ok(/,\s*true\s*,?\s*$/.test(inner.trim()), `${evt} 的第三个参数必须是 true（捕获阶段），实际尾部=…${inner.trim().slice(-40)}`);
  }
});

/* ---------------- MTG-2 三个数值照老项目原文 ---------------- */

test('MTG-2 🔴 位移阈值 10 / 等待 350 / 合成窗口 800（老项目原文）', () => {
  const num = (name) => {
    const m = new RegExp(`const ${name} = (\\d+);`).exec(GUARD);
    assert.ok(m, `应能读到常量 ${name}`);
    return Number(m[1]);
  };
  assert.equal(num('MOVE_TOLERANCE_PX'), 10, '位移阈值（老项目 :7924 的 10）');
  assert.equal(num('SYNTH_WAIT_MS'), 350, '等真实 click 的时长（老项目 :7935 的 350）');
  assert.equal(num('SYNTH_WINDOW_MS'), 800, '吞迟到 click 的窗口（老项目 :7934 的 800）');
});

/* ---------------- MTG-3 覆盖范围：比老项目多一个 .list-row ---------------- */

test('MTG-3 🔴🔴 兜底行必须含 .list-row（老项目只写 .menu-item，漏了二级页）', () => {
  // 🔴 老项目那句只写 `.menu-item`，但收藏夹 / 历史版本列表**同样是滚动容器**
  //   （bj `.list-scroll` 带 max-height + overflow-y），病根完全一样。
  //   这里按病根补齐，判据防止有人"照老项目字面"把它缩回去。
  assert.ok(GUARD.includes('.menu-item'), '主菜单行要兜底');
  assert.ok(GUARD.includes('.list-row'), '二级页的列表行同样要兜底（同病根，老项目漏了）');
});

/* ---------------- MTG-4 早退：真滚动 / 鼠标 都不许补发 ---------------- */

test('MTG-4 🔴🔴 pointerup 必须早退：鼠标、已判定为滚动、无起点', () => {
  const up = listenerInner(GUARD, 'pointerup');
  assert.ok(up.includes("e.pointerType === 'mouse'"), '鼠标没有"手势吞 click"这回事，不该走补发路径');
  assert.ok(/\bmoved\b/.test(up), '已判定为滚动手势时必须早退 —— 漏这条的症状是"想滚列表却跳进了某篇笔记"');
  assert.ok(/\bstart\b/.test(up), '没有起点（异常路径）时也要早退');
});

test('MTG-4 🔴 反向：pointermove 必须**真的**按位移置位，不能恒 false/恒 true', () => {
  const mv = listenerInner(GUARD, 'pointermove');
  assert.ok(mv.includes('MOVE_TOLERANCE_PX'), '位移阈值必须来自那个常量，不写字面量');
  assert.ok(/Math\.abs\(e\.clientX - start\.x\)/.test(mv), '横向位移要判');
  assert.ok(/Math\.abs\(e\.clientY - start\.y\)/.test(mv), '纵向位移也要判（只判一维 ⇒ 横向拖动被误当成点击）');
});

/* ---------------- MTG-5 重复执行防护 ---------------- */

test('MTG-5 🔴🔴 补发后必须吞掉迟到的真实 click（防一次点击执行两遍）', () => {
  const click = listenerInner(GUARD, 'click');
  assert.ok(click.includes('synthUntil'), '要用合成窗口判"这是不是迟到的那一次"');
  assert.ok(click.includes('e.isTrusted'), '只吞**真实**点击；补发的那次 isTrusted=false，绝不能自己吞自己');
  assert.ok(click.includes('e.stopPropagation()'), '吞的方式是阻断传播，不是只记一笔');
  assert.ok(click.includes('e.preventDefault()'), '顺带阻止默认行为');
  assert.ok(click.includes('gotClick = true'), '没迟到时要记下"真实 click 已到"，否则每次都会白白补发一次');
});

test('MTG-5 🔴 反向：补发前必须先看真实 click 到没到', () => {
  const up = listenerInner(GUARD, 'pointerup');
  assert.ok(up.includes('if (gotClick) return;'), '真实 click 已到就不许再补 —— 漏这条等于把每次点击都执行两遍');
  assert.ok(up.includes('synthUntil = Date.now()'), '补发的同时要打开吞迟到 click 的窗口');
});

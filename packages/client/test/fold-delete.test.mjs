/**
 * FOLD-DEL 判据（v3.2.5 报障⑤）：折叠块删除整块
 *   长按标题文字 ≥600ms → 确认弹窗 → FoldNode.remove()（标题+正文整块）
 *
 * 🔴 此前折叠块没有任何"删除整块"的路：展开态按键一律不拦（FOLD-BS2），
 *   收起态拦截全是"并入"语义，正文收起时无光标入口 —— 块一旦创建就永生。
 *
 * 判据分两档跑（stripComments keepStrings 保留内容但**去引号**，默认剥掉字符串）：
 *   - KEEP（剥注释+留串内容）：代码结构断言 —— 注释里会复述 API 名（#337 教训
 *     原文），不剥就会"注释骗绿"（与 EXPORT-29/30 同源纪律）。
 *   - RAW：字符串字面量断言（'mouse' / 'pointermove' 等带引号的实参）。
 * 行为级在 e2e 05-fold FOLD-LP1~3。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPY } from '../src/ui/copy.ts';
import { stripComments } from './rem-native.test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEH_RAW = readFileSync(new URL('../src/behaviors.ts', import.meta.url), 'utf8');
const BEH_KEEP = stripComments(BEH_RAW, { keepStrings: true });

// 🔴 切片：长按注册函数 与 确认弹窗函数，各自独立断言（防别处同名串骗绿）
const lpAt = BEH_KEEP.indexOf('function registerFoldLongPress');
const cfAt = BEH_KEEP.indexOf('function openFoldDeleteConfirm');
const LP = lpAt >= 0 && cfAt > lpAt ? BEH_KEEP.slice(lpAt, cfAt) : '';
const CF = cfAt >= 0 ? BEH_KEEP.slice(cfAt) : '';
const lpRawAt = BEH_RAW.indexOf('function registerFoldLongPress');
const LP_RAW = lpRawAt >= 0 ? BEH_RAW.slice(lpRawAt) : '';

test('FOLD-DEL1 🔴🔴 长按删除链路必须存在且接线进 registerFoldBehavior', () => {
  assert.ok(LP, '缺 registerFoldLongPress');
  assert.ok(CF, '缺 openFoldDeleteConfirm');
  // 清理链：dispose 必须能摘干净（S4 热重载/测试隔离纪律）
  assert.ok(BEH_KEEP.includes('unregisterFoldLongPress'), '长按注册必须进了清理链（unregister）');
  // 阈值：600ms 长按 / 10px 滚动取消（常量声明在函数前，全文断言）
  assert.ok(BEH_KEEP.includes('FOLD_LONG_PRESS_MS = 600'), '长按阈值必须是 600ms');
  assert.ok(BEH_KEEP.includes('FOLD_LONG_PRESS_SLOP_PX = 10'), '滚动取消阈值必须是 10px');
});

test('FOLD-DEL2 🔴🔴 手势判据：只认触屏、排除三角区、移动/抬起取消、吞系统菜单', () => {
  // 只认 touch/pen：桌面鼠标按住 = 拖选，与长按无关（字符串字面量 → RAW 判）
  assert.ok(LP_RAW.includes("event.pointerType === 'mouse'"), '必须排除 mouse 指针');
  // 三角区留给点按开合（CLICK 同款 22px 几何判据），长按不认
  assert.ok(/clientX - hr\.left <= 22/.test(LP), '长按必须排除左 22px 三角区');
  // 触屏长按的系统选择菜单：contextmenu 里 preventDefault 吞掉
  assert.ok(LP.includes('onMenu') && LP.includes('preventDefault()'), '触屏长按必须吞掉系统 contextmenu');
  // 取消路径要全：滚动（move）/ 抬起（up）/ 系统打断（cancel）（字符串实参 → RAW 判）
  for (const ev of ['pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(LP_RAW.includes(`'${ev}'`), `缺 ${ev} 监听（长按取消路径不全）`);
  }
  // 🔴🔴 Lexical #337 教训（探针实锤）：$getNearestNodeFromDOMNode 内部走
  //   "活跃编辑器"上下文，裸 DOM 事件里没有 ⇒ 长按处只许记 DOM 元素，
  //   节点解析必须延到确认时在 editor.update 里做（KEEP 已剥注释，防注释骗绿）。
  assert.ok(!LP.includes('$getNearestNodeFromDOMNode'), '长按处不许解析 Lexical 节点（#337，会炸）');
  assert.ok(!LP.includes('getEditorState().read'), '长按处不许开 read 上下文（#337 同根）');
  assert.ok(LP.includes('pressHeadEl'), '长按处必须记标题 DOM 元素（确认时再解节点）');
});

test('FOLD-DEL3 🔴🔴 删除执行：update 内 DOM 反查 + isAttached 守卫 + 选区钉邻块 + canEdit 双门控', () => {
  // 删除必须在 editor.update 里（进撤销栈 + 走真源同步），不许裸 DOM 改树
  assert.ok(/editor\.update\(\(\) => \{[\s\S]*?node\.remove\(\)/.test(CF),
    '删除必须在 editor.update 里执行 FoldNode.remove()');
  // 🔴 节点解析必须在 update 上下文里从 DOM 反查（#337 教训：长按处只有 DOM）
  assert.ok(CF.includes('$getNearestNodeFromDOMNode'), '确认时必须在 update 里从 DOM 反查 FoldNode');
  // 确认框开着的时候块可能已被远端合并换掉/删掉：必须 isAttached + isConnected 守卫
  assert.ok(CF.includes('isAttached()'), '删除必须 isAttached 守卫（防远端已删/撤销）');
  assert.ok(CF.includes('isConnected'), 'DOM 反查前必须 isConnected 守卫（防远端已换 DOM）');
  // 选区钉到邻块：防"删完打字没反应"（无效选区静默故障）
  assert.ok(/selectStart\(\)|selectEnd\(\)/.test(CF), '删除后必须把选区钉到邻块');
  // canDelete 门控两处：按下时（LP）+ 确认时（CF）。🔴 不能复用 canEditTree
  //   —— 它叠了 typingActive（1.5s 打字活跃期），会把"打完字立刻长按"拦成
  //   「点了没反应」（探针实锤）；main.ts 喂的是只含 组字/语音冷却/整段改写
  //   三个真危险窗的 canFoldDelete。
  assert.ok(LP.includes('canDelete && !canDelete()'), '按下时必须过 canDelete 门控');
  assert.ok(CF.includes('canDelete && !canDelete()'), '确认删除时必须再过一次 canDelete 门控');
  // 🔴 判据钉门控来源：main.ts 必须喂 canFoldDelete（不许改回 canEditTree）
  const MAIN_SRC = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.ok(MAIN_SRC.includes('canFoldDelete'), 'main.ts 缺 canFoldDelete 注入');
  assert.ok(
    MAIN_SRC.includes('!imeGate.composing') && MAIN_SRC.includes('!imeGate.bulkActive'),
    'canFoldDelete 必须只躲 组字/语音冷却/整段改写 三个危险窗（不许叠 typingActive）',
  );
});

test('FOLD-DEL4 🔴🔴 COPY 契约：确认框文案逐字且真的被消费', () => {
  assert.equal(COPY.foldDeleteTitle, '删除折叠块');
  assert.equal(COPY.foldDeleteBody, '折叠标题和里面的内容会一起删除。');
  assert.equal(COPY.foldDeleteCancel, '取消');
  assert.equal(COPY.foldDeleteOk, '删 除');
  // 文案必须真的被 behaviors 消费（防只加文案不接线）
  for (const k of ['foldDeleteTitle', 'foldDeleteBody', 'foldDeleteCancel', 'foldDeleteOk']) {
    assert.ok(BEH_KEEP.includes(`COPY.${k}`), `behaviors.ts 缺 COPY.${k} 消费点`);
  }
});

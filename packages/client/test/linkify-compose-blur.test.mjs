/**
 * P1-1 组字态卡死判据 —— 「组字中点走 ⇒ 链接识别永久停摆」
 *
 * 🔴🔴 纪律：
 *   · import 生产代码（`registerLinkify` / `FIRST_DELAY_MS` 都从生产模块取，
 *     等在这里手写 500 就等于没钉）；
 *   · 每条"应该有"配一条"不应该有"；
 *   · 🔴 **先红后改**：DB-01 / DB-05 在加 blur 监听之前必须是红的
 *     （没有 blur 监听 ⇒ 组字态卡死、runNow 空转），改完转绿；
 *     变异验证：把生产的 `root?.addEventListener('blur', onBlur)` 临时注掉
 *     ⇒ DB-01 / DB-04 转红（见文件尾注释）。
 *
 * 🔴 为什么能在 node 里跑：`registerLinkify` 只碰 `editor.getRootElement()`
 *   与 `editor.update(...)`。这里给它一个**假 root**（自带 add/remove/dispatch 的
 *   最小 EventTarget）＋把 update **转发给真 headless Lexical 编辑器** ——
 *   于是 `$linkifyEditor()` 跑在真编辑器状态里，"网址有没有变成链接"是
 *   **真的**链接节点，不是"update 被调用了几次"这种代理指标。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';

import { ALL_NODES } from '../src/node-registry.ts';
import { lexicalToDoc } from '../src/serialize.ts';
import { FIRST_DELAY_MS, registerLinkify } from '../src/linkify/deferred.ts';

/** 等待 ms 毫秒（真定时器：被测代码用的是 setTimeout，不能假时间）。 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 搭一套：`root` 是假 DOM 节点（能派事件、能数监听），
 * `editor.update` 转发给真 headless 编辑器（于是识别是真的识别）。
 */
function harness(text) {
  const real = createEditor({ nodes: ALL_NODES });
  real.update(() => {
    const p = $createParagraphNode();
    p.append($createTextNode(text));
    $getRoot().append(p);
  }, { discrete: true });

  const listeners = new Map();
  const add = (type, fn) => {
    const a = listeners.get(type);
    if (a) a.push(fn);
    else listeners.set(type, [fn]);
  };
  const remove = (type, fn) => {
    const a = listeners.get(type);
    if (!a) return;
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };

  const root = {
    // 🔴 生产代码读的是 `root.ownerDocument?.activeElement === root`
    ownerDocument: { activeElement: null },
    addEventListener: add,
    removeEventListener: remove,
    /** 同步派发（生产监听就是同步注册的普通函数）。 */
    dispatch(type, ev) {
      const list = (listeners.get(type) ?? []).slice();
      for (const fn of list) fn({ type, ...(ev ?? {}) });
    },
    count(type) {
      return (listeners.get(type) ?? []).length;
    },
  };

  let updates = 0;
  const editor = {
    getRootElement: () => root,
    update: (fn, opts) => {
      updates += 1;
      real.update(fn, opts);
    },
  };

  const handle = registerLinkify(editor, { hasOverlayOpen: () => false, canEdit: () => true });

  return {
    root,
    handle,
    updates: () => updates,
    /** 真源里的链接 span（真的链接节点，不是"跑过"的代理指标）。 */
    links: () =>
      (lexicalToDoc(real.getEditorState(), []).blocks ?? []).flatMap((b) =>
        (b.spans ?? []).filter((s) => s.href !== undefined),
      ),
    focus: () => {
      root.ownerDocument.activeElement = root;
    },
    unfocus: () => {
      root.ownerDocument.activeElement = null;
    },
  };
}

/** 进入"组字中"（输入法正在拼字，尚未上屏）。 */
function startComposing(h) {
  h.focus();
  h.root.dispatch('beforeinput', { inputType: 'insertCompositionText' });
}

// ═══════════════════════════════════════════════════════════════════════════
// 本体：blur 必须复位组字态
// ═══════════════════════════════════════════════════════════════════════════

test('DB-01 🔴🔴 组字中派 blur ⇒ 识别态复位，此后网址**能**被识别（应该有）', () => {
  const h = harness('看 https://example.com 结束');
  startComposing(h);
  // 组字中点走：焦点离开 + blur 事件（浏览器此时**不派** compositionend）
  h.unfocus();
  h.root.dispatch('blur');
  // 此后输入网址 ⇒ 必须能识别出来
  h.handle.runNow();
  const links = h.links();
  assert.equal(links.length, 1, 'blur 之后必须能识别（卡死的话这里是 0，且零报错）');
  assert.equal(links[0]?.href, 'https://example.com');
  h.handle.dispose();
});

test('DB-02 🔴 对照组：不派 blur ⇒ 组字态仍卡死（不应该有 —— 证明 DB-01 不是恒真）', () => {
  const h = harness('看 https://example.com 结束');
  startComposing(h);
  // 不派 blur：compositionend 没来，识别态就该还卡着（组字中不手术是铁律）
  h.handle.runNow();
  assert.equal(
    h.links().length,
    0,
    '组字中绝不手术：没收到结束信号就不该识别（有链接 = 铁律被破）',
  );
  h.handle.dispose();
});

test('DB-03 正常出口未被破坏：compositionend 后照样能识别（应该有）', () => {
  const h = harness('看 https://example.com 结束');
  startComposing(h);
  h.root.dispatch('compositionend');
  h.handle.runNow();
  assert.equal(h.links().length, 1, 'compositionend 这条原路径必须照旧工作');
  h.handle.dispose();
});

// ═══════════════════════════════════════════════════════════════════════════
// 复位之外还要"重新调度"（组字期间欠着的那一轮要补跑）
// ═══════════════════════════════════════════════════════════════════════════

test('DB-04 🔴 blur 后**自动**补跑那一轮（不靠 runNow），网址自己变链接（应该有）', async () => {
  const h = harness('看 https://example.com 结束');
  startComposing(h);
  h.unfocus(); // 焦点真的离开了 ⇒ 老项目停笔闸不成立 ⇒ 不该被推迟
  h.root.dispatch('blur');
  assert.equal(h.links().length, 0, '前提：blur 的当下还没识别（只排了队）');
  await wait(FIRST_DELAY_MS + 400);
  const links = h.links();
  assert.equal(links.length, 1, 'blur 之后那一轮必须自动补上（用户不该被要求再敲一个字）');
  assert.equal(links[0]?.href, 'https://example.com');
  h.handle.dispose();
});

test('DB-05 🔴 没在组字时 blur ⇒ 不该白跑一轮（不应该有）', async () => {
  const h = harness('看 https://example.com 结束');
  h.focus();
  // 普通插入（不是组字）：isComposing 为 false
  h.root.dispatch('beforeinput', { inputType: 'insertText' });
  h.handle.runNow(); // 先把这一轮的账结掉，让下面的计数干净
  const base = h.updates();
  assert.equal(h.links().length, 1, '前提：此时已经识别过');
  h.unfocus();
  h.root.dispatch('blur'); // 不在组字中 ⇒ 不该排任何活
  await wait(FIRST_DELAY_MS + 400);
  assert.equal(h.updates(), base, '不在组字中的 blur 不该再排一轮（blur 是高频事件）');
  h.handle.dispose();
});

// ═══════════════════════════════════════════════════════════════════════════
// 注册 / 解绑（漏解绑 = 泄漏）
// ═══════════════════════════════════════════════════════════════════════════

test('DB-06 🔴 注册时必须有 blur 监听（应该有）', () => {
  const h = harness('x');
  assert.equal(h.root.count('blur'), 1, '没有 blur 监听 ⇒ 组字态卡死（P1-1 的病因）');
  assert.equal(h.root.count('beforeinput'), 1);
  assert.equal(h.root.count('compositionend'), 1);
  h.handle.dispose();
});

test('DB-07 🔴 dispose() 同步解绑全部监听（应该有：全为 0；不应该有：残留）', async () => {
  const h = harness('x');
  h.handle.dispose();
  // 应该有：三类监听全部归零（漏掉 blur = 一次监听泄漏）
  assert.equal(h.root.count('blur'), 0, 'dispose 后 blur 监听必须是 0');
  assert.equal(h.root.count('beforeinput'), 0, 'dispose 后 beforeinput 必须是 0');
  assert.equal(h.root.count('compositionend'), 0, 'dispose 后 compositionend 必须是 0');
  // 🔴 不应该有：解绑之后再派事件不该有任何动静（也不该抛）
  const base = h.updates();
  h.root.dispatch('beforeinput', { inputType: 'insertText' });
  h.root.dispatch('blur');
  h.root.dispatch('compositionend');
  await wait(FIRST_DELAY_MS + 400);
  assert.equal(h.updates(), base, '解绑后不该再排任何一轮');
});

/* ──────────────────────────────────────────────────────────────────────────
 * 变异验证记录（本次实跑）
 *   把 deferred.ts 的 `root?.addEventListener('blur', onBlur);` 临时注掉
 *     ⇒ DB-01（links 为 0）/ DB-04（等不到链接）/ DB-06（count('blur') 为 0）
 *       三条**全部转红**；恢复后转绿。
 *   另：把 dispose 里的 `removeEventListener('blur', onBlur)` 临时注掉
 *     ⇒ DB-07 转红（count 为 1）。恢复后转绿。
 * ────────────────────────────────────────────────────────────────────────── */

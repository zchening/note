/**
 * e2e：写入 → 真源 → 重载（真浏览器，走完整用户路径）
 *
 * 🔴 为什么这条必须用真浏览器而不能用 jsdom（ARCH.md §4.6）：
 *   jsdom 的 Selection / beforeinput 残缺是老项目整套 mock 纪律税的根源。
 *   本用例的每一步都碰 DOM：contenteditable 聚焦、真实输入事件、落地页净化、
 *   口令页提交、SW 注册。
 *
 * 🔴🔴 本文件是全项目唯一能抓到「行为插件漏注册」这类故障的地方。
 *   那个故障的特征是：渲染正常、事件正常、零报错，但字打不进去。
 *   纯逻辑单测对此完全无感 —— 它们不需要行为插件。
 *   所以 **E2E-02 是全项目最重要的回归闸**，任何动编辑器的改动都必须让它保持绿。
 *
 * 判据（不是"页面没报错"，而是逐项可验）：
 *   1. 产物版本 == package.json 版本（ARCH 明令：不许版本字面量断言）
 *   2. 真浏览器里输入 → **真源模型 JSON 变了**，且是 canonical 形态
 *   3. 重载后编辑器仍在（S5 起还要验内容留存）
 *
 * 用法：node --test --test-concurrency=6 test/e2e/*.test.js
 *🔴 **不要传 --test-timeout**，原因见 harness.mjs 文件头。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 🔴 直接引生产代码那份 canonicalize / parseDoc 当判据参照物，**不手写第二份实现**
//   （手写必然漂移，且已经漂过一次：字典序 vs schema 定义顺序）。
import { canonicalize, parseDoc } from '../../../shared-schema/src/canonical.ts';
import { installHarness, openEditor } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// test/e2e → test → client → packages → 仓库根（**四级**）。
// 🔴 少一级会静默算成 <root>/packages，于是 readFile('packages/package.json') 报 ENOENT，
//   而 e2e 的 before 钩子照跑不误 —— 症状是"第一条用例莫名失败"，与浏览器无关。
const ROOT = resolve(HERE, '..', '..', '..', '..');
const WWW = join(ROOT, 'www');

const h = installHarness(test, { dir: WWW });

test('E2E-01 产物版本 == package.json 版本（唯一来源纪律）', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const page = await openEditor(h.browser(), h.baseUrl(), 'e2e1');
  // 从 DOM 上的 data-version 读，与 package.json 比 —— 不写版本字面量
  // 🔴 选择器是 #shell 不是 #root：S4 起外壳由 ui/shell.ts 渲染，根元素 id 叫 shell。
  const v = await page.getAttribute('#shell', 'data-version');
  assert.equal(v, pkg.version, '产物版本与 package.json 不一致');
  await page.close();
});

test('E2E-02 真浏览器里打字 → 真源模型 JSON 变且是 canonical 形态', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'e2e2');

  // 编辑器真挂载了（不是空 div）
  const editable = await page.$('#editor-host[contenteditable="true"]');
  assert.ok(editable, '编辑器未挂载：#editor-host[contenteditable] 不存在');

  // 打字前的真源基线
  const before = await page.evaluate(() => window.__NOTESYNC_DOC__());
  assert.deepEqual(before, { v: 1 }, '空文档的真源形态不是 {"v":1}');

  await editable.click();
  await page.keyboard.type('真源第一行');
  await page.keyboard.press('Enter');
  await page.keyboard.type('真源第二行');

  // 🔴 判据落在**真源模型 JSON** 上，不是 DOM 文本。
  //   DOM 有字只说明浏览器渲染了；真源 JSON 变了才说明数据链路是通的。
  //   这两者可以分开坏（正是"行为插件漏注册"的症状：DOM 与真源都不变）。
  const after = await page.evaluate(() => window.__NOTESYNC_DOC__());
  assert.notDeepEqual(after, before, '打字后真源模型 JSON 没有变化 —— 编辑行为没生效');

  // 真源里必须真有那两段字，且按键数对应两个块
  assert.equal(after.blocks?.length, 2, `期望 2 个块，实际 ${after.blocks?.length}`);
  const texts = after.blocks.map((b) => (b.spans ?? []).map((s) => s.t).join(''));
  assert.deepEqual(texts, ['真源第一行', '真源第二行']);

  // 必须是 canonical 形态。判据 = **用生产代码的canonicalize 再序列化一次，逐字节相同**。
  //
  // 🔴🔴 判据实现踩过的坑，写在这里防止重犯：
  //   我第一版手写了 `sortKeys`（字典序）当参照物，结果判据自己红了 ——
  //   根因是 canonical 规则 1 为「按 schema 定义顺序」而非字典序，
  //   `{"t":..,"spans":..}` 被排成 `{"spans":..,"t":..}`，看着像真源层有 bug。
  //   → 教训一：写"结构对不对"的断言前，先确认参照物的规则与被测方是同一条。
  //   → 教训二：**不要手写参照物**，直接调生产代码那份。
  //     单一真源原则对测试同样成立：手写第二份实现必然漂移。
  assert.equal(
    canonicalize(after),
    JSON.stringify(after),
    '真源 JSON 不是 canonical 形态（用生产 canonicalize 再序列化会变）',
  );
  // 反向也钉一下：真源必须能被 parseDoc 收下（合法 + 非 canonical 表示会被拒）
  assert.deepEqual(parseDoc(canonicalize(after)), after, '真源无法无损往返');

  // DOM 层面也确认一下，证明是真输入而不是假状态
  const text = await page.textContent('#editor-host');
  assert.match(text, /真源第一行/);
  assert.match(text, /真源第二行/);
  await page.close();
});

test('E2E-03 重载后编辑器仍在（本地持久化在 S5 接入后才有意义）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'e2e3');

  await (await page.$('#editor-host[contenteditable="true"]')).click();
  await page.keyboard.type('重载后要还在');

  // 重载。同一个 context 里 localStorage 还在 → 不再问口令，直接进编辑器
  // 🔴 这条同时验了"记住口令"这个行为：若记住失效，重载后会停在口令页，
  //   而症状是 waitForFunction 超时，不会有人想到是 localStorage 的问题。
  await page.reload();
  await page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20_000 });
  const text = await page.textContent('#editor-host');
  // 本地持久化在 S5 接入同步后才有意义；这里只要求页面能重载起来且编辑器在
  // （内容留存是 S5 的验收项，不在 S3 范围）
  assert.ok(text !== null, '重载后编辑器不存在');
  await page.close();
});

/* ══════════════════════════════════════════════════════════════════════
 * 撤销 / 重做（用户报障第 4 条「不支持 Ctrl+Z 撤回」）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 🔴🔴 这条盯的是一个**依赖缺失**型故障，判据必须打到真实键盘事件：
 *
 *   病根不是"没实现撤销"，是**`@lexical/history` 压根没装**。
 *   `lexical` 主包只导出 `UNDO_COMMAND` / `REDO_COMMAND` / `CAN_UNDO_COMMAND`
 *   这些**命令常量**，但**没有任何处理器监听它们** —— 键盘事件派发出去，
 *   一路无人认领，静默消失。实测：输入 ABCDE 后按 Ctrl+Z，textContent 仍是 "ABCDE"。
 *   而 444 条单测全绿：没人断言过"按 Ctrl+Z 之后正文会变短"。
 *
 * 判据打**真实按键**（page.keyboard.press）而不是派发命令常量：
 *   派发常量只能证明"常量被谁认领"，而用户遇到的是按键没反应；
 *   两者之间隔着浏览器的按键→命令映射，那一段也要验。
 */
test('E2E-UNDO1 Ctrl+Z 撤回 / Ctrl+Y 重做（撤销栈真的接上了）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'e2eUndo');
  try {
    await (await page.$('#editor-host[contenteditable="true"]')).click();
    await page.keyboard.type('ABCDE');
    // 🔴 必须等合并窗口（300ms）走完，否则这几个字还在合并中，
    //   撤的是"半个单元"，断言会飘。
    await new Promise((r) => setTimeout(r, 600));

    const text = () => page.textContent('#editor-host');
    assert.equal(await text(), 'ABCDE', '输入后正文不对');

    await page.keyboard.press('Control+z');
    await new Promise((r) => setTimeout(r, 600));
    const afterUndo = await text();
    assert.notEqual(afterUndo, 'ABCDE', 'Ctrl+Z 之后正文没变短 —— 撤销栈没接上');
    assert.equal(afterUndo, '', `一次 Ctrl+Z 应撤掉整段合并单元，实际「${afterUndo}」`);

    await page.keyboard.press('Control+y');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await text(), 'ABCDE', 'Ctrl+Y 重做没把内容恢复回来');
  } finally {
    await page.close();
  }
});

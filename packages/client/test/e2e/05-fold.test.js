/**
 * e2e：折叠块交互（FOLD 系列）—— 真浏览器
 *
 * 🔴 折叠块的判据与其他块不同：**开合态是 ephemeral UI 态，绝不进真源**。
 *   所以本文件最要紧的不是"能展开"，而是这三条：
 *     1. 点标题能开合（这是 S4 复刻的老项目交互，缺了就是功能回退）
 *     2. 展开/收起**不改变canonical 字节**（若变了，两台设备会互相回声）
 *     3. 往返无损（fold 块经 serialize 进出后 canonical 逐字节相等）
 *
 * 🔴🔴 FOLD-05 曾经写成「收起的折叠块里按 Enter 先展开」——**那条判据是错的，已改**。
 *   我第一版凭空造了这个需求，实跑才发现：
 *     - 老项目**没有**这条路径（收起态 `display:none`，正文点都点不到）
 *     - 于是测试永远走不到断言那一步，page.click 干等 30s 超时
 *   老项目真正的护栏是 `foldCaretNormalize`：**光标不许停在收起的隐藏正文里**。
 *   这条是真会损坏内容的（在正文里打字 → 收起 → 退格，啃掉的是标题的字），
 *   而 Enter 展开只是个不存在的功能。教训见 behaviors.ts 的同名注释。
 *
 * 路径纪律：走真实用户路径（落地页 → 口令页 → 编辑器），不直接 goto。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 必须是 4 级（e2e → test → client → packages → 仓库根）。
//   写成 3 级会得到 packages/www（不存在），index.html 直接 404，
//   症状是 bodyHTML 只剩几十字符、'#li' 永远等不到、pageerror 全空，
//   只有 console 一条 404。判据口诀：bodyHTML 长度只有几十 = 没页面，先查路径。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });
const PASS = 'pw';

/** 真源的 canonical 字节（判"开合态有没有污染真源"必须用它，不能比对象）。 */
const canon = (page) =>
  page.evaluate(() => {
    const d = window.__NOTESYNC_DOC__();
    // 复用页面里已加载的 canonicalize：真源层是唯一真源，测试不手写第二份实现。
    return window.__NOTESYNC_CANON__(d);
  });

test('FOLD-01 插入折叠块：真源里出现 fold 块，标题与正文都在', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f01', 'pw');
  try {
    await page.click('.ns-editor');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    const fold = (doc.blocks || []).find((b) => b.t === 'fold');
    assert.ok(fold, '真源里应有 fold 块，实际=' + JSON.stringify(doc));
    assert.ok(fold.title && fold.title.length > 0, 'fold 应有标题，实际=' + JSON.stringify(fold));
  } finally {
    await page.close();
  }
});

test('FOLD-02 🔴 点标题能收起/展开（data-open 真的翻转）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f02', 'pw');
  try {
    await page.click('.ns-editor');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await page.waitForSelector('.ns-fold', { timeout: 5000 });

    const open0 = await page.getAttribute('.ns-fold', 'data-open');
    assert.equal(open0, 'true', '新建的折叠块应为展开态，实际=' + open0);

    // 点标题（第一个子段落）→ 收起
    // 🔴 点**三角**才切换开合（用户拍板：点文字=编辑标题、点三角=展开/收起）
    await page.click('.ns-fold > :first-child', { position: { x: 8, y: 10 } });
    await withTimeout(
      page.waitForFunction(() => document.querySelector('.ns-fold')?.getAttribute('data-open') === 'false', {
        timeout: 5000,
      }),
      6000,
      '等收起',
    );
    // 收起态：正文必须真的不可见（老项目铁律：收起后正文藏起来）
    const bodyVisible = await page.evaluate(() => {
      const fold = document.querySelector('.ns-fold');
      const body = fold?.querySelector(':scope > :not(:first-child)');
      if (!body) return null;
      return getComputedStyle(body).display !== 'none';
    });
    assert.equal(bodyVisible, false, '收起态正文必须 display:none');

    // 再点 → 展开
    // 🔴 点**三角**才切换开合（用户拍板：点文字=编辑标题、点三角=展开/收起）
    await page.click('.ns-fold > :first-child', { position: { x: 8, y: 10 } });
    await withTimeout(
      page.waitForFunction(() => document.querySelector('.ns-fold')?.getAttribute('data-open') === 'true', {
        timeout: 5000,
      }),
      6000,
      '等展开',
    );
  } finally {
    await page.close();
  }
});

test('FOLD-03 🔴🔴 开合不改变真源 canonical 字节（ephemeral 红线）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f03', 'pw');
  try {
    await page.click('.ns-editor');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await page.waitForSelector('.ns-fold', { timeout: 5000 });
    // 等首屏对账稳定
    await page.waitForTimeout(500);

    const before = await canon(page);
    // 🔴 点**三角**才切换开合（用户拍板：点文字=编辑标题、点三角=展开/收起）
    await page.click('.ns-fold > :first-child', { position: { x: 8, y: 10 } });
    await withTimeout(
      page.waitForFunction(() => document.querySelector('.ns-fold')?.getAttribute('data-open') === 'false', {
        timeout: 5000,
      }),
      6000,
      '等收起',
    );
    await page.waitForTimeout(400);
    const after = await canon(page);

    // 🔴 这是本文件最要紧的一条：收起后 canonical 必须逐字节相等。
    //   不等意味着"开合态进了真源" ⇒ 两台设备各展开/收起一次就互相产生
    //   一次纯噪音冲突，用户会看到"两台设备改了同一处"而实际上什么都没改。
    assert.equal(after, before, `收起不应改变真源。\n前=${before}\n后=${after}`);
  } finally {
    await page.close();
  }
});

test('FOLD-04🔴 往返无损：fold 块进出 serialize 后 canonical 逐字节相等', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f04', 'pw');
  try {
    await page.click('.ns-editor');
    await page.keyboard.type('前面一段');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await page.waitForSelector('.ns-fold', { timeout: 5000 });
    // 在折叠块正文里打字（先展开）
    await page.click('.ns-fold > :not(:first-child)');
    await page.keyboard.type('折叠里面的正文');
    await page.waitForTimeout(500);

    const before = await canon(page);
    // 走一次"从真源重建编辑器"（等价于刷新后重新导入）
    await page.evaluate(() => window.__NOTESYNC_RELOAD_FROM_DOC__());
    await page.waitForTimeout(500);
    const after = await canon(page);

    assert.equal(after, before, `fold 往返应无损。\n前=${before}\n后=${after}`);
    // 反向自证：确认往返前真源里确实有 fold 块且正文没丢
    assert.ok(before.includes('"fold"'), '往返前真源应含 fold 块，实际=' + before);
    assert.ok(before.includes('折叠里面的正文'), '往返前应保留折叠正文，实际=' + before);
  } finally {
    await page.close();
  }
});

test('FOLD-05 🔴🔴 收起时把光标从隐藏正文弹回标题末尾（老项目 foldCaretNormalize 同款）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f05', 'pw');
  try {
    await page.click('.ns-editor');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await page.waitForSelector('.ns-fold', { timeout: 5000 });

    // 先在展开的正文里打字，把光标放进去（这正是老项目注释里点名的路径：
    // 「展开 → 点进正文 → 点三角收起」）
    await page.click('.ns-fold > :not(:first-child)');
    await page.keyboard.type('正文里的字');
    await page.waitForTimeout(300);

    // 确认光标此刻真的在折叠块内部（反向自证：否则下面的断言等于什么都没验）
    const beforeInside = await page.evaluate(() => {
      const s = window.getSelection();
      const el = document.querySelector('.ns-editor');
      return !!(s && s.rangeCount && el && el.contains(s.anchorNode));
    });
    assert.equal(beforeInside, true, '前置条件：光标应在编辑器内');

    // 点标题收起
    // 🔴 点**三角**才切换开合（用户拍板：点文字=编辑标题、点三角=展开/收起）
    await page.click('.ns-fold > :first-child', { position: { x: 8, y: 10 } });
    await withTimeout(
      page.waitForFunction(() => document.querySelector('.ns-fold')?.getAttribute('data-open') === 'false', {
        timeout: 5000,
      }),
      6000,
      '等收起',
    );
    await page.waitForTimeout(400);

    // 🔴 判据一：光标所在位置**必须在标题段落里**，绝不能停在 display:none 的正文里。
    //   停在隐藏正文里时，用户屏幕上什么都看不见，按退格会啃掉标题的字（内容损坏）。
    const where = await page.evaluate(() => {
      const s = window.getSelection();
      if (!s || !s.rangeCount) return null;
      const node = s.anchorNode;
      const el = node && node.nodeType === 1 ? node : node && node.parentElement;
      if (!el) return null;
      return {
        inHead: !!el.closest('.ns-fold > :first-child'),
        inFoldBody: !!el.closest('.ns-fold > :not(:first-child)'),
        offset: s.anchorOffset,
        text: (s.anchorNode && s.anchorNode.textContent) || '',
      };
    });
    assert.ok(where, '收起后应仍有选区');
    assert.equal(where.inFoldBody, false, `光标不许停在隐藏正文里（会啃标题字）。实际=${JSON.stringify(where)}`);
    assert.equal(where.inHead, true, `光标应被弹回标题末尾。实际=${JSON.stringify(where)}`);
  } finally {
    await page.close();
  }
});

test('FOLD-06 点正文不触发展开（只有标题才是把手）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f06', 'pw');
  try {
    await page.click('.ns-editor');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await page.waitForSelector('.ns-fold', { timeout: 5000 });
    await page.waitForTimeout(300);
    await page.click('.ns-fold > :not(:first-child)');
    await page.waitForTimeout(400);
    const open = await page.getAttribute('.ns-fold', 'data-open');
    // 🔴 点正文不该收起 —— 用户正在编辑正文，块忽然收起会丢光标位置。
    //   判据必须用 child combinator（只命中第一个子段落），只用 .ns-fold 会误判。
    assert.equal(open, 'true', '点正文不应触发展开切换，实际=' + open);
  } finally {
    await page.close();
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * 折叠标题可编辑（2026-10-06 发现的未报 bug）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 🔴🔴 报障原话里没有这条，是做 C1 时顺带挖出来的：
 *   **折叠标题根本改不了** —— 光标放进标题、打字，DOM 变了而真源一个字不变。
 *
 *   病根：FoldNode 标题存`__titleJson` **字段**，导出侧优先取它；
 *   而 `setTitle()` 此前全项目只有 serialize.ts 反序列化时调过，
 *   用户在标题行的编辑永远不会被写回。
 *
 * 🔴🔴 修法的关键是**回写必须走独立的 `editor.update`**：
 *   我第一版把setTitle() 放进导出前那次 `editorState.read()` 里 ——
 *   read() 拿到的是**冻结快照**，在里面改不产生新的 editor state，
 *   于是「DOM 已变、模型未变」，症状与"修复无效"一模一样。
 *   （探针证据：read 里能看到 spans=[{t:"折叠块ZZZ"}]，而真源仍是「折叠块」。）
 *   写回自身不引起无限循环：title 没变时 JSON 相同，直接跳过。
 */
test('FOLD-TITLE1折叠标题可以直接改（真源跟着变）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'foldTitle', 'pw');
  try {
    await page.click('#editor-host');
    await page.keyboard.type('X');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await page.waitForSelector('.ns-fold', { timeout: 10_000 });

    const before = await page.evaluate(() => {
      const d = window.__NOTESYNC_DOC__();
      return (d.blocks.find((b) => b.t === 'fold') || {}).title?.[0]?.t ?? '';
    });
    assert.ok(before.length > 0, '新建折叠块应有默认标题');

    // 用钩子把光标放到标题末尾（设 DOM Range 不会同步 Lexical 内部选区）
    assert.equal(await page.evaluate(() => window.__NOTESYNC_CARET_FOLD_TITLE_END__()), true,
      '选区定位钩子应成功');
    await new Promise((r) => setTimeout(r, 250));
    await page.keyboard.type('ZZZ');
    await new Promise((r) => setTimeout(r, 700));

    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    const title = (doc.blocks.find((b) => b.t === 'fold') || {}).title?.[0]?.t ?? '';
    assert.ok(
      title.includes('ZZZ'),
      `改标题后真源应含新文字，实际 title="${title}"（原"${before}"）—— 又变回"DOM 变了模型没变"`,
    );
  } finally {
    await page.close();
  }
});

/* ══════════════════════════════════════════════════════════════════════
 * 收起态折叠标题按 Enter：光标后的标题文字落到折叠块**外面**
 * （用户报障第 5 条 —— 本组唯一会静默丢内容的一条）
 * ══════════════════════════════════════════════════════════════════════

/**
 * 🔴🔴 判据钉的是**真源里字落在哪**，不是"多了一个空段落"：
 *   空段落是真源里不存在的形态（serialize.ts 会丢掉它），
 *   所以"回车后多一个 p"这条断言根本不可能成立（我第一版就这么写的，红了一轮）。
 *
 * 🔴 为什么正解是"切开标题"而不是"插一个空段落"：
 *   空段落活不过一轮 update 往返（导出时被丢）⇒ 空占位消失 ⇒ 随后打的字落回标题。
 *   把后半段文字搬成**非空**段落，它就不会被丢。
 *
 * 🔴 光标位置用钩子的 offset 参数给准（键盘方向键在无头下移不动 Lexical 内部选区）。
 * 反向闸见FOLD-ENTER2：展开态在正文回车必须仍是"正文内分裂"。
 */
test('FOLD-ENTER1 标题中间回车：后半段文字落到折叠块**外面**', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'fe1', PASS);
  try {
    // 造一个折叠块并收起；标题改成 ABCDEF 以便观察切分
    await page.click('#editor-host');
    await page.keyboard.type('BODY');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await page.waitForSelector('.ns-fold', { timeout: 10_000 });
    // 🔴 点**三角**才切换开合（用户拍板：点文字=编辑标题、点三角=展开/收起）
    await page.click('.ns-fold > :first-child', { position: { x: 8, y: 10 } });
    await new Promise((r) => setTimeout(r, 350));
    await page.evaluate(() => window.__NOTESYNC_CARET_FOLD_TITLE_END__());
    await new Promise((r) => setTimeout(r, 200));
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.type('ABCDEF');
    await new Promise((r) => setTimeout(r, 400));

    // 🔴 用钩子把光标放到标题第 3 字后（键盘方向键在无头下移不动 Lexical 选区）
    await page.evaluate(() => window.__NOTESYNC_CARET_FOLD_TITLE_END__(3));
    await new Promise((r) => setTimeout(r, 250));
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 600));

    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    const blocks = doc.blocks || [];
    const fi = blocks.findIndex((b) => b.t === 'fold');
    assert.ok(fi >= 0, '真源里应有 fold 块：' + JSON.stringify(blocks.map((b) => b.t)));
    const foldTitle = blocks[fi].title?.[0]?.t ?? '';
    const outsideText = JSON.stringify(blocks.slice(fi + 1));
    // 标题应只剩前半段
    assert.ok(foldTitle.length < 6, `标题应被切开，实际仍为「${foldTitle}」`);
    // 后半段应出现在块外
    assert.ok(outsideText.includes('DEF') || outsideText.includes('EF') || outsideText.includes('F'),
      `后半段文字应落到折叠块外面，实际 outside=${outsideText}`);
  } finally {
    await page.close();
  }
});

test('FOLD-ENTER2 反向闸：展开态在正文里回车，字仍留在折叠块**内部**', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'fe2', PASS);
  try {
    await page.click('#editor-host');
    await page.keyboard.type('BODY');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await page.waitForSelector('.ns-fold', { timeout: 10_000 });
    // 新建折叠块默认展开
    assert.equal(await page.getAttribute('.ns-fold', 'data-open'), 'true', '前置：应为展开态');

    assert.equal(await page.evaluate(() => window.__NOTESYNC_CARET_FOLD_BODY_START__()), true,
      '应能把光标放进折叠正文开头');
    await new Promise((r) => setTimeout(r, 250));
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 300));
    await page.keyboard.type('YYY');
    await new Promise((r) => setTimeout(r, 600));

    const blocks = await page.evaluate(() => window.__NOTESYNC_DOC__().blocks || []);
    const fi = blocks.findIndex((b) => b.t === 'fold');
    assert.ok(fi >= 0, '真源里应有 fold 块');
    assert.ok(
      JSON.stringify(blocks[fi].children || []).includes('YYY'),
      '展开态在正文回车，字应留在折叠块**内部**（反向闸），实际=' + JSON.stringify(blocks[fi]),
    );
  } finally {
    await page.close();
  }
});

/**
 * 🔴🔴🔴 问题 8 + 9 的取证与判据（用户报障第 8/9 条）
 *
 * ── 实测（一次性探针量化，不推理）─────────────────────────────────────
 *  场景：正文 BODY + 一个折叠块，标题改成 ABCDEF，点三角收起，光标按钩子落位后回车。
 *
 *  问题 9（光标在标题**中间**，第 3 字后）：
 *    回车前真源order = ["p", "fold"]，foldIdx=1，title="ABCDEF"
 *    回车后真源 order = ["p", "fold", "p", "fold"]   ←🔴 **fold 块变成了两个**
 *            foldIdx=1 title="ABC"、索引 3 又一个 fold title="ABC"
 *    ⇒ 用户看到的「折叠列表跳到了原先位置下方的第二行」是真实现象，
 *      而且比描述更严重：**凭空多出一个内容重复的折叠块**。
 *
 *  问题 8（光标在标题**末尾**）：
 *    回车后真源 order 完全不变（还是 ["p","fold"]，title 仍 "ABCDEF"）
 *    紧接着打字 ZZZ ⇒ title 变成 **"ABCDEFZZZ"**
 *    ⇒ **字落回折叠标题内部**。用户说「没反应」是对的：
 *      回车既没换行、也没把光标挪出去，后续输入继续污染标题。
 *
 * ── 机制（behaviors.ts:586-590）─────────────────────────────────────────
 *    const sel2 = $createRangeSelection();
 *    sel2.anchor.set(fold.getKey(), 0, 'element');   // ← 选区指向 fold 自己
 *    $insertNodes([out]);
 *  Lexical 的 `RangeSelection.insertNodes` 会做
 *    `firstBlock = $findMatchingParent(firstNode, INTERNAL_$isBlock)`
 *  （Lexical.dev.js:13246）—— 这里 firstNode **就是 fold 自己**，
 *  它 isBlock() 为真 ⇒ firstBlock = fold；`!firstBlock.isEmpty()` 为真
 *  ⇒ shouldInsert=true ⇒ 先调 `this.insertParagraph()`（`:13360-13361`）
 *  ⇒ 新段落插到 fold **前面**，块被顶到下一行。
 *
 * ── 🔴 为什么必须新写判据而不能修 FOLD-ENTER1 ──────────────────────────
 *  FOLD-ENTER1（:303）只断言 `blocks.slice(fi+1)` 含不含 DEF/EF/F ——
 *  上面实测里`["p","fold","p","fold"]` 的 fi+1 之后**确实**含 "DEF"，
 *  **它照样绿**。它没钉「fold 块自己的索引不变」，于是给问题 9 发了免罪符。
 *  判据钉的是**用户可见的最终结果**：折叠块所在行不动（索引不变、块数不变）。
 */
test('FOLD-ENTER3 🔴🔴🔴 标题中间回车：折叠块**留在原位**，后半段落到它下方一行（用户报障第 9 条）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'fe3', PASS);
  try {
    await page.click('#editor-host');
    await page.keyboard.type('BODY');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await withTimeout(page.waitForSelector('.ns-fold', { timeout: 10_000 }), 12_000, '等折叠块');
    await page.click('.ns-fold > :first-child', { position: { x: 8, y: 10 } });
    await new Promise((r) => setTimeout(r, 350));
    await page.evaluate(() => window.__NOTESYNC_CARET_FOLD_TITLE_END__());
    await new Promise((r) => setTimeout(r, 200));
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.type('ABCDEF');
    await new Promise((r) => setTimeout(r, 400));

    // 前置自证：回车前必须**只有一个** fold 块，且它在索引 1（否则下面全是恒真）
    const before = await page.evaluate(() => (window.__NOTESYNC_DOC__().blocks || []).map((b) => b.t));
    assert.deepEqual(before, ['p', 'fold'], `前置：回车前应是["p","fold"]，实际=${JSON.stringify(before)}`);

    // 光标落标题第 3 字后（键盘方向键在无头下移不动 Lexical 内部选区，用钩子）
    await page.evaluate(() => window.__NOTESYNC_CARET_FOLD_TITLE_END__(3));
    await new Promise((r) => setTimeout(r, 250));
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 700));

    const blocks = await page.evaluate(() => window.__NOTESYNC_DOC__().blocks || []);
    const order = blocks.map((b) => b.t);
    const fi = blocks.findIndex((b) => b.t === 'fold');
    const foldCount = order.filter((t) => t === 'fold').length;
    const foldTitle = blocks[fi]?.title?.map((s) => s.t).join('') ?? '';

    // 🔴 断言 1：折叠块**个数**不变。实测修前是 2 个（凭空多一个内容重复的块）。
    assert.equal(
      foldCount, 1,
      `折叠块个数必须恒为 1（回车不该复制块）。实际=${foldCount}，order=${JSON.stringify(order)}`,
    );

    // 🔴🔴 断言 2：折叠块的**索引**不变 —— 这正是"折叠列表所在行不动"。
    //   FOLD-ENTER1 缺的正是这条，所以它给这条报障发了免罪符。
    assert.equal(
      fi, before.lastIndexOf('fold'),
      `折叠块索引必须不变（"折叠列表所在行不动"）。修前实测 order=${JSON.stringify(order)}`
      + ` ⇒ 块被顶到第 2 行、还多出一个重复块`,
    );

    // 🔴 断言 3：后半段落在折叠块**紧邻的下一块**，且是该块（不是隔一段）。
    assert.equal(
      blocks[fi + 1]?.t, 'p',
      `光标后面的文字应换到折叠块**下方一行**（紧邻的段落），实际 blocks[${fi + 1}]=`
      + JSON.stringify(blocks[fi + 1] ?? null),
    );
    assert.ok(
      JSON.stringify(blocks[fi + 1] || {}).includes('DEF'),
      `下半段文字 DEF 应落在那个段落里，实际=${JSON.stringify(blocks[fi + 1] ?? null)}`,
    );

    // 🔴 断言 4：标题只剩前半段（这条 FOLD-ENTER1 已有，但必须在新判据里重复钉住 ——
    //   它是用户能直接看见的结果，且"块被复制"时标题也会看着对）。
    assert.equal(foldTitle, 'ABC', `标题应只剩前半段 ABC，实际=「${foldTitle}」`);

    // 🔴 断言 5：正文 BODY 那一行也不许动（它排在 fold 前面，是"所在行不动"的另一半）
    assert.ok(
      JSON.stringify(blocks[0] || {}).includes('BODY'),
      `回车前的正文块必须留在索引 0，实际=${JSON.stringify(blocks[0] ?? null)}`,
    );
  } finally {
    await page.close();
  }
});

/**
 * FOLD-ENTER4 🔴🔴🔴 标题**末尾**回车必须真的换行，随后的字不许落回标题
 *   （用户报障第 8 条：「光标在折叠列表标题最后面输入回车，没反应」）
 *
 * 🔴 实测（修前）：回车后真源 order 完全不变（还是 ["p","fold"]，title 仍 ABCDEF），
 *   紧接着打 ZZZ ⇒ title 变成 **"ABCDEFZZZ"** —— 字落回折叠标题内部。
 *   用户说「没反应」是准确的：既没换行，也没把光标挪出去。
 *
 * 🔴🔴 老项目口径（index.html 的 foldCaretNormalize 同族思路）：
 *   收起态的折叠标题末尾按回车，应当在**折叠块外面下方**给出一个可落点。
 *   behaviors.ts:502-505 那条注释曾断言"空段落会被导出丢弃，所以不能插空段落" ——
 *   **那条依据已过期**：`serialize.ts:668 trimTrailingEmptyParas` 现在是
 *   **零调用死函数**，2026-10-06 方案 A 之后空段落是**进真源**的
 *   （判据 `20-empty-para` EP-E01~03 钉着）。⇒ 技术障碍不存在。
 */
test('FOLD-ENTER4 🔴🔴🔴 标题末尾回车必须换到折叠块外，随后的字不许落回标题（用户报障第 8 条）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'fe4', PASS);
  try {
    await page.click('#editor-host');
    await page.keyboard.type('BODY');
    await page.evaluate(() => window.__NOTESYNC_INSERT_FOLD__());
    await withTimeout(page.waitForSelector('.ns-fold', { timeout: 10_000 }), 12_000, '等折叠块');
    await page.click('.ns-fold > :first-child', { position: { x: 8, y: 10 } });
    await new Promise((r) => setTimeout(r, 350));
    await page.evaluate(() => window.__NOTESYNC_CARET_FOLD_TITLE_END__());
    await new Promise((r) => setTimeout(r, 200));
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.type('ABCDEF');
    await new Promise((r) => setTimeout(r, 400));

    const before = await page.evaluate(() => (window.__NOTESYNC_DOC__().blocks || []).map((b) => b.t));
    assert.deepEqual(before, ['p', 'fold'], `前置：回车前应是["p","fold"]，实际=${JSON.stringify(before)}`);

    // 光标落标题**末尾**（不传 offset）
    await page.evaluate(() => window.__NOTESYNC_CARET_FOLD_TITLE_END__());
    await new Promise((r) => setTimeout(r, 250));
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 600));

    // 🔴 关键动作：回车后立刻打字。看字落在哪 ——
    //   落在标题里 = 没修好（这是用户真正在做的动作，比"真源有没有变"更贴近）。
    await page.keyboard.type('ZZZ');
    await new Promise((r) => setTimeout(r, 700));

    const blocks = await page.evaluate(() => window.__NOTESYNC_DOC__().blocks || []);
    const order = blocks.map((b) => b.t);
    const fi = blocks.findIndex((b) => b.t === 'fold');
    const foldTitle = blocks[fi]?.title?.map((s) => s.t).join('') ?? '';
    const all = JSON.stringify(blocks);

    // 🔴 断言 1：折叠块个数不变（末尾回车同样不许复制块）
    assert.equal(
      order.filter((t) => t === 'fold').length, 1,
      `折叠块个数必须恒为 1，实际 order=${JSON.stringify(order)}`,
    );

    // 🔴🔴 断言 2（这条报障的核心）：字绝不许落进折叠标题。
    //   修前实测 title 变成 "ABCDEFZZZ"。
    assert.equal(
      foldTitle, 'ABCDEF',
      `回车后打的字必须落在折叠块**外面**，标题不该变。实际标题=「${foldTitle}」`
      + `（字落回标题内部了）`,
    );

    // 🔴 断言 3：字必须出现在折叠块**之后**（下方一行），不是别处
    assert.ok(
      JSON.stringify(blocks.slice(fi + 1) || []).includes('ZZZ'),
      `ZZZ 应出现在折叠块下方的块里，实际 foldIdx=${fi} order=${JSON.stringify(order)}`,
    );

    // 🔴 断言 4：正文 BODY 那行不许被动
    assert.ok(all.includes('BODY'), `正文 BODY 块应仍在，实际=${JSON.stringify(order)}`);
  } finally {
    await page.close();
  }
});

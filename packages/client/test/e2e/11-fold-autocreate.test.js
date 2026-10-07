/**
 * e2e：行首 `[折叠]` 自动识别（FOLD-07 / FOLD-08）
 *
 * 🔴🔴🔴 这两条是补 P0 的回归闸，来源是一次真实缺陷审计：
 *   `05-fold.test.js` 原有 6 条测试**全部**用 `window.__NOTESYNC_INSERT_FOLD__()`
 *   这个测试钩子造折叠块，**没有一条模拟用户手打**。
 *   于是「$createFoldNode 只有钩子与序列化两个调用点、手打 `[折叠]` 一行普通文本」
 *   这个 P0 缺陷在 CI 上全绿通过了 —— 测试造的是它自己认识的东西，
 *   测不到用户唯一能走的那条路。
 *
 *   判据纪律：**验收路径必须是用户真实路径**（聚焦编辑器 → 逐字敲键盘）。
 *   任何"通过钩子造出来"的折叠块测试都不能证明折叠功能对用户可用。
 *
 * 覆盖两条：
 *   FOLD-07  段首键入 `[折叠]` → 变成真 fold 块（不是普通文本）
 *   FOLD-08  正文中间出现 `[折叠]` **不得**被吞（老项目判据是"行首"，不是全文搜索）
 *            —— 这条是反向闸：防止把"修复"做成"全文替换标记"这种内容损坏
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 路径纪律同 05-fold.test.js：必须 4 级到仓库根的 www。
// 写成 3 级会拿到 packages/www（不存在），症状是 bodyHTML 只剩几十字符。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

const canon = (page) =>
  page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));

test('FOLD-07🔴 段首键入 [折叠] 变成真 fold 块（用户真实路径，非钩子）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f07', 'pw');
  try {
    await page.click('.ns-editor');
    // 🔴 必须用 keyboard.type 逐字敲：它会走真实 beforeinput(inputType=insertText)
    //   与 Lexical 的文本插入链。page.evaluate 塞 innerHTML 走不到这条路，
    //   那样测就又变成"造了个测试专用路径"。
    await page.keyboard.type('[折叠]', { delay: 20 });

    // 等识别完成：监听器用 editor.update(..., {discrete:true})，下一帧就位。
    await withTimeout(
      page.waitForFunction(
        () => (window.__NOTESYNC_DOC__().blocks || []).some((b) => b.t === 'fold'),
        null,
        { timeout: 8000 },
      ),
      8000,
      '手打 [折叠] 后真源里应出现 fold 块',
    );

    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    const fold = (doc.blocks || []).find((b) => b.t === 'fold');
    assert.ok(fold, '应存在 fold 块，实际=' + JSON.stringify(doc));

    // DOM 侧也要对：真的渲染成了 .ns-fold 容器（不只是模型里有个 fold）
    const domFold = await page.$('.ns-fold');
    assert.ok(domFold, 'DOM 里应出现 .ns-fold 容器');
    const open = await page.getAttribute('.ns-fold', 'data-open');
    assert.equal(open, 'true', '新建折叠块应是展开态（open=true），否则用户无法直接往里打字');

    // 标记文本必须被消费掉，不能留在可见标题里
    const headText = await page.evaluate(() => {
      const el = document.querySelector('.ns-fold > :first-child');
      return el ? el.textContent : '';
    });
    assert.ok(
      !headText.includes('[折叠]'),
      '标题里不该残留 [折叠] 标记文本，实际="' + headText + '"',
    );
  } finally {
    await page.close();
  }
});

test('FOLD-08 🔴 正文中间的 [折叠] 不得被吞成结构（防内容损坏的反向闸）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f08', 'pw');
  try {
    await page.click('.ns-editor');
    // 🔴🔴 判据是「**行首** `[折叠]`」，不是全文搜索（老项目同款）。
    //   所以反向闸的正确姿势是：让标记落在**同一段的开头之后**，
    //   即前面先有字。**不能按 Enter** —— 换行后标记就成了新段落的开头，
    //   那是合法的行首，代码识别成折叠块是**正确行为**。
    //   （我第一版写成"打完一段按 Enter 再打标记"，结果断言反向失败：
    //     代码是对的、测试是错的。这类"把对的判成错的"必须改测试而不是改实现。）
    await page.keyboard.type('这段话里提到[折叠]两个字', { delay: 20 });

    // 给识别逻辑充足的时间跑（若它错误地全文搜索，这里就会被吞）
    await page.waitForTimeout(1200);

    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    const folds = (doc.blocks || []).filter((b) => b.t === 'fold');
    assert.equal(
      folds.length,
      0,
      '段落中间的 [折叠] 不该被转成结构，会吞掉用户内容。真源=' + JSON.stringify(doc),
    );

    // 原文必须完好
    const before = await canon(page);
    assert.ok(
      before.includes('这段话里提到'),
      '用户原文应完好，实际=' + before,
    );
  } finally {
    await page.close();
  }
});

test('FOLD-09 🔴 换行后在**行首**打标记应正常识别（用户真实写法）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f09', 'pw');
  try {
    await page.click('.ns-editor');
    await page.keyboard.type('前言段落', { delay: 20 });
    await page.keyboard.press('Enter');
    // 这一行是**新段落的开头**，正是老项目 applyFolds 的识别场景
    await page.keyboard.type('[折叠]', { delay: 20 });

    await withTimeout(
      page.waitForFunction(
        () => (window.__NOTESYNC_DOC__().blocks || []).some((b) => b.t === 'fold'),
        null,
        { timeout: 8000 },
      ),
      8000,
      '换行后行首打 [折叠] 应识别成 fold 块',
    );

    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    // 前言段落必须完好（识别不能吃掉上文）
    const texts = (doc.blocks || []).map((b) => JSON.stringify(b)).join('');
    assert.ok(texts.includes('前言段落'), '上文应完好，真源=' + JSON.stringify(doc));
  } finally {
    await page.close();
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * 折叠块的**吸收**（FOLD-10 起）—— 用户报障第 6 条
 *
 * 🔴🔴🔴 这个文件的判据与 05-fold 的六条是**不同的两件事**：
 *   05-fold 造折叠块靠 `__NOTESYNC_INSERT_FOLD__()` 钩子（结构对不对）；
 *   这里全部靠**真键盘逐字敲**（用户唯一能走的那条路）。
 *   吸收恰恰只发生在后者 —— `$promoteFoldMarks` 是**输入监听器**里调的，
 *   钩子造出来的折叠块**根本不会经过它**。
 *   ⇒ 用钩子测吸收，测的是一个用户永远走不到的功能（恒绿陷阱）。
 *
 * ── 老项目的权威规则（**真浏览器实测**，不是读源码推的）────────────────
 *   探针：Playwright 打开老项目 index.html，逐行敲 `#editor`，读直接子块 className。
 *   🔴 探针自身的两个坑（写下来防止下一个人重踩）：
 *     ① `reset` 必须 `innerHTML='<div><br></div>'`，不能用 `''`——
 *        空 contenteditable 里打字，Chromium 只生成**裸文本节点**（无 div 壳），
 *        而 `applyFolds` 迭代 `editor.children`（只含元素）⇒ 裸文本对它完全不可见
 *        ⇒ 误报"把手块凭空消失、根本没折叠"。第一版探针全场cls=(none) 就是这个。
 *     ② 老项目的 `input` 链在本机探针里没让 `foldSeedArmed` 置位（打字四行后
 *        一条 ns-fold 都没有）。必须显式 `foldSeedArmed = true; window.applyFolds()`
 *        手动跑一次生产定界函数本体（index.html:4782 暴露）才拿到折叠态。
 *        🔴 `foldSeedArmed` 是顶层 **let**（:4389）**不挂 window**——
 *           `window.foldSeedArmed = true` 只会造一个无关属性，必须裸标识符赋值。
 *
 *   实测结果：
 *     D1 [折叠]/内容一/(空)/组外→ ns-fold-body"内容一[/折叠]" | (none)"" | (none)"组外"
 *     D2 [折叠]/内容一/内容二/(空)     → 内容一 | 内容二[/折叠] | (none)""
 *     D3 [折叠]/内容一/(空)/组外/(空)/更后 → 内容一[/折叠] | (none) | (none)组外 | (none) | (none)更后
 *   ⇒ 现行口径 = **v10.1.2**（index.html:4382-4388「用户拍板」）：
 *     R1 从标记所在行的**下一块**开始吸
 *     R2 遇**空行**截断（空行与它后面的内容都不进块）
 *     R3 遇**下一个折叠标记**截断
 *     R4 独立成行的 `[/折叠]` 是**锚**：不进正文、也不留在块外
 *
 * 🔴🔴🔴 **v10.0.3 与 v10.1.2 两套空行规则并存，只读源码必然判错**（Agent 两次栽相反的错）：
 *   index.html:4034-4040（v10.0.3）写着「空行彻底退出边界判定 → 标题以下全归组」，
 *   `applyFolds:4289-4298` 的定界循环也确实只有两个 break ⇒ 看起来 v10.1.2 是遗留路径。
 *   **错**：v10.1.2 版本号更大、注释明写「（用户拍板）」，由 `applyFolds:4286` 在
 *   `seedArmed && 本帧新增把手` 时调 `seedFoldGroup:4399-4404`，**保留 isBlankFoldLine break
 *   并立刻补锚把边界冻住**；且 `applyFolds:4208` 证实 `seedArmed` 取完即清
 *   ⇒ **建组定界整个生命周期只判一次**，与 bj 的 `$collectFoldAbsorb` 同一时机。
 *   D1/D2/D3 实测就是这条口径的证据。**版本号更大的那次拍板才是现行口径。**
 *
 * 🔴🔴🔴 **bj 与老项目的关键架构差异（决定了判据该怎么写）**：
 *   老项目是**DOM 命令式**：`applyFolds` 挂在 input 链上，**每帧重新划界**，
 *   锚会持续往后挪；bj 是**模型真源**：`$promoteFoldMarks` 由
 *   `registerFoldAutoCreate` 在 `beforeinput(armed)` → update listener → setTimeout
 *   触发，**只在"敲完 `]` 那一刻"跑一次**（dbg 实测 `INSERTED-OK absorbed=0`，
 *   此时把手下面还是空的）。之后 `$promoteFoldMarks` 开头那道
 *   `inside-fold-skip` 守卫会让后续输入**直接长在 FoldNode 内部**，不再重划界。
 *   ⇒ 用户真正会遇到的路径是**「先写好内容，再回行首补打 `[折叠]`」**，
 *     而不是"边敲边自动重划界"。FOLD-11/12/13 因此必须按前一种路径构造，
 *     否则测的是一个 bj 里不存在的机制（假红）。
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 读某个 fold 块的**正文纯文本**数组（一段一个元素）。
 *
 * 🔴🔴🔴 **不要 slice(1)** —— 真源里 fold.children **不含标题段**。
 *   `FoldNode` 的 DOM/节点树里 children[0] 是标题段（nodes.ts 的设计），
 *   但 `serialize.ts:359` 的 `nodeToBlock` 会把那个标题段**提去当 title 字段**、
 *   **不导出进 children**。所以 `__NOTESYNC_DOC__()` 里：
 *     fold = { t:'fold', title:[{t:'标题'}], children:[正文段…] }   ← children 全是正文
 *   实测（探针D）：
 *     输入 标题/内容一/内容二 + 行首补[折叠] → absorbed=2
 *     → {title:[{t:"标题"}], children:[{内容一},{内容二}]}
 *
 *   🔴 我在这里栽过两次同类错，两次都是判据自己读错字段、**恒假或恒真**：
 *     第一版写 `f.kids`（真源里根本没这个键，恒为[] ⇒ 四条判据一起红）
 *     第二版"修"成 `f.children.slice(1)`（以为 children[0] 是标题）
 *     —— 于是把正文**第一段跳掉了**：FOLD-10 报`实际=内容二`（丢了内容一）、
 *        FOLD-11/13 报 `实际=`（整段跳空）。红得毫无意义。
 *   纪律：**判据读真源字段前，先把真源 JSON 打出来看一眼**，
 *     不要凭"节点树结构"推"真源结构"—— 这两者在导出侧会分叉。
 *
 * 🔴 段落是 `{t:'p', spans:[…]}`，文本在 spans 里，所以这里拼一遍纯文本——
 *   判据要判的是"这段字在不在块里"，不是"JSON 长什么样"。
 */
async function foldBodyTexts(page, idx = 0) {
  return page.evaluate((i) => {
    const f = (window.__NOTESYNC_DOC__().blocks || []).filter((b) => b.t === 'fold')[i];
    if (!f) return null;
    return (f.children || []).map((c) => {
      if (!c || c.t !== 'p') return JSON.stringify(c);
      return (c.spans || []).map((s) => (typeof s === 'string' ? s : s.t || '')).join('');
    });
  }, idx);
}

/** 逐行敲，每行后回车（走真实输入链）。 */
async function typeLines(page, lines) {
  await page.click('.ns-editor');
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(lines[i], { delay: 20 });
  }
}

/**
 * 把光标落到第 idx 块的**首字符前**，模拟"用户回到行首补打标记"。
 *
 * 🔴🔴 必须走真实 Selection + focus，不能用 `page.evaluate` 直接改编辑器状态：
 *   `$promoteFoldMarks` 的入口判据是 `sel.isCollapsed() && $isTextNode(anchor)`
 *   && `para.getFirstChild() === anchor`，只有真选中态过得去。
 *
 * 🔴 这条路径是 bj 里**唯一真会触发吸收**的路径（建组帧在"敲完 ] 那一刻"，
 *   下面必然是空的）—— 见文件头"bj 与老项目的关键架构差异"。
 */
async function caretAtBlockStart(page, idx) {
  await page.evaluate((i) => {
    const ed = document.querySelector('.ns-editor');
    const blk = ed.children[i];
    if (!blk) throw new Error('第 ' + i + ' 块不存在');
    const target = blk.firstChild || blk;
    const r = document.createRange();
    r.setStart(target, 0);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    ed.focus();
  }, idx);
}

/** 等真源里出现 n 个非 fold 段落（"先写内容"那一步的落点确认）。 */
const waitParas = (page, n) =>
  withTimeout(
    page.waitForFunction(
      (k) =>
        (window.__NOTESYNC_DOC__().blocks || []).filter((b) => b.t !== 'fold').length >= k,
      n,
      { timeout: 8000 },
    ),
    8000,
    '等段落落进真源',
  );

const waitFold = (page, n = 1) =>
  withTimeout(
    page.waitForFunction(
      (k) => (window.__NOTESYNC_DOC__().blocks || []).filter((b) => b.t === 'fold').length >= k,
      n,
      { timeout: 8000 },
    ),
    8000,
    '等折叠块成形',
  );

test('FOLD-10 🔴🔴 无空行时整段全被吸进折叠块（老项目 v10.1.2 建组帧口径）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f10', 'pw');
  try {
    // 🔴🔴 构造方式必须是「先写内容，再回行首补标记」，理由同 FOLD-11。
    //   🔴 旧版本这条判据写成"边敲边建组"（['[折叠]','内容一','内容二','']），
    //   当时是**绿的**—— 但它绿得没有意义：那个路径下 bj 的建组帧`absorbed=0`
    //   （dbg 实测），内容是后续输入**直接长在 FoldNode 内**，
    //   断言"都进块"恰好成立 ⇒ **测的不是吸收**。
    //   同一条判据在有空行时立刻翻红（见 FOLD-11），正是这个原因。
    //   现在改成真会触发吸收的路径。
    await typeLines(page, ['标题', '内容一', '内容二']);
    await waitParas(page, 3);

    await caretAtBlockStart(page, 0);
    await page.keyboard.type('[折叠]', { delay: 20 });
    await waitFold(page, 1);

    const body = await foldBodyTexts(page, 0);
    assert.ok(body, '应有 fold 块');
    const texts = body.map((t) => String(t));
    const joined = texts.join('|');
    // 🔴🔴 吸收必须发生：内容一、内容二都进块，且**顺序不变**
    assert.ok(joined.includes('内容一'), '内容一应被吸进块，实际=' + joined);
    assert.ok(joined.includes('内容二'), '内容二应被吸进块，实际=' + joined);
    assert.ok(
      texts.findIndex((t) => t.includes('内容一')) < texts.findIndex((t) => t.includes('内容二')),
      '吸收必须保持原顺序，实际=' + joined,
    );
    // 🔴🔴 反向闸：被吸走的段落**不许留在块外**
    //   （不吸的话真源是 [fold, 内容一, 内容二] 三块；吸了应该是 [fold] 一块）
    const topBlocks = await page.evaluate(() =>
      (window.__NOTESYNC_DOC__().blocks || []).map((b) => b.t),
    );
    assert.equal(
      topBlocks.filter((t) => t === 'fold').length,
      1,
      '顶层只该有一个 fold，实际=' + topBlocks.join('|'),
    );
    assert.equal(
      topBlocks.filter((t) => t === 'para').length,
      0,
      '🔴 被吸走的段落不该留在顶层（标题原段落也必须删掉），实际=' + topBlocks.join('|'),
    );
  } finally {
    await page.close();
  }
});

test('FOLD-11 🔴🔴 空行截断：空行与它后面的内容都不进块（老项目 v10.1.2 R2，实测场景 D1）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f11', 'pw');
  try {
    // 🔴🔴 构造方式必须是「先写内容，再回行首补标记」——
    //   bj 的吸收只在建组帧（敲完 `]` 那一刻）判一次，那时下面必然是空的
    //   ⇒ 边敲边建组测不到吸收（dbg: INSERTED-OK absorbed=0），只会测到
    //   "后续输入直接长在 FoldNode 内"。详见文件头"关键架构差异"。
    //   D1 场景：标题行 / 内容一 / (空) / 组外
    await typeLines(page, ['标题', '内容一', '', '组外内容']);
    await waitParas(page, 4);

    await caretAtBlockStart(page, 0);
    await page.keyboard.type('[折叠]', { delay: 20 });
    await waitFold(page, 1);

    const texts = (await foldBodyTexts(page, 0)).map((t) => String(t)).join('|');
    assert.ok(texts.includes('内容一'), '空行前的内容应进块，实际=' + texts);
    // 🔴🔴 这条是本条判据的核心：**空行截断**
    assert.ok(!texts.includes('组外内容'), '🔴 空行后的内容不该进块（R2 截断），实际=' + texts);
    // 反向闸 ①：组外那段必须还在（只是不在块里，不许被吃掉）
    const top = await page.evaluate(() => JSON.stringify(window.__NOTESYNC_DOC__()));
    assert.ok(top.includes('组外内容'), '🔴 组外内容必须完好，不许被吞');
    // 反向闸 ②：标题也不该重复出现在块外（FOLD-14 同款内容守恒）
    const tops = await page.evaluate(() =>
      (window.__NOTESYNC_DOC__().blocks || [])
        .filter((b) => b.t !== 'fold')
        .map((b) => (b.spans || []).map((s) => (typeof s === 'string' ? s : s.t || '')).join('')),
    );
    assert.ok(
      !tops.includes('标题'),
      '🔴 原标题段落必须被删掉，不许在块外残留（内容复制损坏），实际块外=' +
        JSON.stringify(tops),
    );
  } finally {
    await page.close();
  }
});

test('FOLD-12 🔴🔴🔴 下一个把手截断（R3）：第一个组不许把第二个折叠块吞进来', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f12', 'pw');
  try {
    // 构造：先写好「组一 / 甲内容 / [折叠]组二 / 乙内容」，再把标记补到首行。
    //   敲到 `[折叠]组二` 那一行时它**自己就会建一个 fold**（探针实测），
    //   所以补标记那一刻，第二个把手已经是个 FoldNode 了。
    //
    // 🔴🔴 这正是 R3 的关键一格：**已建好的 FoldNode 也是把手**。
    //   老项目 `applyFolds:4290` 判`foldLeadInfo(blocks[k])`，
    //   而 foldLeadInfo 对**已渲染**的把手块同样命中（认ns-fold-mark span 那一条），
    //   不只认行首 `[折叠]` 文本。
    //我第一版 R3 只判文本前缀 ⇒漏掉 FoldNode 这一支，症状是结构损坏：
    //     DIV.ns-fold:"组一甲内容折叠块1组二乙内容"   ← 两组被塞进同一个块
    //   且组一的标题退化成占位符 `折叠块1`（把第二个 fold 的标题当成了自己的）。
    await typeLines(page, ['组一', '甲内容', '[折叠]组二', '乙内容']);
    await withTimeout(
      page.waitForFunction(
        () =>
          (window.__NOTESYNC_DOC__().blocks || []).filter((b) => b.t === 'fold').length >= 1,
        null,
        { timeout: 8000 },
      ),
      8000,
      '第二个把手应先自己建组',
    );

    await caretAtBlockStart(page, 0);
    await page.keyboard.type('[折叠]', { delay: 20 });
    await waitFold(page, 2);

    const b0 = (await foldBodyTexts(page, 0)).map((t) => String(t)).join('|');
    const b1 = (await foldBodyTexts(page, 1)).map((t) => String(t)).join('|');

    // 反向闸 ①：组一只该吃到「甲内容」
    assert.ok(b0.includes('甲内容'), '第一组应含甲内容，实际=' + b0);
    // 🔴🔴 R3：组一**不许**含第二个把手的任何内容
    assert.ok(!b0.includes('组二'), '🔴 R3：第一个组不该含第二个把手的标题，实际=' + b0);
    assert.ok(!b0.includes('乙内容'), '🔴 R3：第一个组不该含乙内容，实际=' + b0);
    // 🔴🔴 反向闸 ②：顶层**只能有两个fold**，不许多出空壳块
    //   （我第一版漏判 FoldNode 时，真源是 3 个 fold，第一个 children=[] 空壳）
    const shape = await page.evaluate(() =>
      (window.__NOTESYNC_DOC__().blocks || []).map((b) => b.t),
    );
    assert.equal(
      shape.filter((t) => t === 'fold').length,
      2,
      '🔴🔴 只该有两个折叠组，不许凭空多出空壳，实际=' + shape.join('|'),
    );
    assert.equal(
      shape.filter((t) => t === 'para').length,
      0,
      '🔴🔴 原段落必须都被收进各自的组，实际顶层=' + shape.join('|'),
    );
    // 反向闸 ③：第二个组自己吃到「乙内容」（证明它没被组一吃掉，而是独立成组）
    assert.ok(b1.includes('乙内容'), '🔴 第二个组应含乙内容，实际=' + b1);
    assert.ok(!b1.includes('甲内容'), '🔴 第二个组不该含甲内容，实际=' + b1);
  } finally {
    await page.close();
  }
});

test('FOLD-13 🔴 独立成行的 [/折叠] 是锚：那一行不进正文（老项目 R4）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f13', 'pw');
  try {
    // 标题行 / 内容一 / [/折叠] / 内容二
    //   先写好再补标记 ⇒ 组应吃到「内容一」，**锚行停住**（老项目 R4：
    //   锚行被标 ns-fold-endline 压0 高，**不进正文**），锚后的内容二留组外。
    await typeLines(page, ['标题', '内容一', '[/折叠]', '内容二']);
    await waitParas(page, 4);

    await caretAtBlockStart(page, 0);
    await page.keyboard.type('[折叠]', { delay: 20 });
    await waitFold(page, 1);

    const texts = (await foldBodyTexts(page, 0)).map((t) => String(t)).join('|');
    assert.ok(texts.includes('内容一'), '内容一应进组，实际=' + texts);
    // 🔴🔴 R4：锚行本身**绝不能**进正文（否则用户会看到一行"[/折叠]"当内容）
    assert.ok(!texts.includes('[/折叠]'), '🔴 锚行不该进正文，实际=' + texts);
    // 🔴 锚行截断 ⇒ 锚之后的内容二不该进组
    assert.ok(!texts.includes('内容二'), '🔴 锚行应截断吸收，内容二不该进组，实际=' + texts);
    // 反向闸 ①：锚行也不该留在块外成为一段可见正文
    const top = await page.evaluate(() => JSON.stringify(window.__NOTESYNC_DOC__()));
    assert.ok(!top.includes('[/折叠]'), '🔴 锚行不该作为独立段落留在真源里，实际=' + top);
    // 反向闸 ②：内容二必须完好地留在块外（不许被吞）
    assert.ok(top.includes('内容二'), '🔴 内容二必须完好，不许被吞');
  } finally {
    await page.close();
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * FOLD-14 🔴🔴🔴 内容守恒：建组不许让原文凭空多出一份
 *
 * 🔴🔴🔴 这条是**真浏览器才抓得到**的 bug，headless 单测 4/4 全绿：
 *   behaviors.ts 走的是 `$insertNodes([fold]); para.remove();`
 *   —— 在**挂载了 rootElement 的真实编辑器**里，`$insertNodes` 会把 fold
 *   插到 para 之前并接管选区，此后`para` 已不是可稳定 remove 的挂载节点，
 *   `para.remove()` **静默不生效**（不抛错、不告警）。
 *   症状：折叠块里有一份正文，**块外又残留一份同样的原文**。
 *   e2e 探针实测（修复前）：
 *     DOM: DIV.ns-fold:"内容一内容二"   ← 折叠块
 *          P.ns-p:"内容一"              ← 🔴 原文重复
 *
 *   🔴 这类"内容凭空复制"是**最严重**的用户可见损坏（复制粘贴会带出两份），
 *   所以必须钉死，且必须**配反向断言**：不只断言"块里有"，还要断言"块外没有"。
 * ═══════════════════════════════════════════════════════════════════════ */

test('FOLD-14 🔴🔴🔴 标记打在已有文字行首：原文不许在块外残留一份（内容守恒）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'f14', 'pw');
  try {
    // 先写好两行，再把标记补到首行行首 —— 这是"给已有内容加折叠"的真实路径
    await typeLines(page, ['内容一', '内容二']);
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().blocks || []).length >= 2, null, {
        timeout: 8000,
      }),
      8000,
      '两段应先落在真源里',
    );

    // 光标落到首行行首（与 FOLD-11/12/13 同一路径）
    await caretAtBlockStart(page, 0);
    await page.keyboard.type('[折叠]', { delay: 20 });
    await waitFold(page, 1);

    // 标题 = 首行文字，正文 = 被吸进来的第二行
    const fold = await page.evaluate(() => {
      const f = (window.__NOTESYNC_DOC__().blocks || []).find((b) => b.t === 'fold');
      return f ? { title: f.title, kids: (f.children || []).length } : null;
    });
    assert.ok(fold, '应生成 fold 块');
    assert.equal(
      (fold.title || []).map((s) => s.t).join(''),
      '内容一',
      '标题应是首行原文',
    );

    // 🔴🔴🔴 反向闸（这条才是抓 bug 的）：块外**不许**再有"内容一"这个段落
    const tops = await page.evaluate(() =>
      (window.__NOTESYNC_DOC__().blocks || [])
        .filter((b) => b.t !== 'fold')
        .map((b) => (b.spans || []).map((s) => (typeof s === 'string' ? s : s.t || '')).join('')),
    );
    assert.ok(
      !tops.includes('内容一'),
      '🔴🔴 原标题段落必须被删掉，不许在块外残留一份（内容复制损坏），实际块外=' +
        JSON.stringify(tops),
    );
    // DOM 侧同样钉一次：正文只应出现一次
    const domTexts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.ns-editor > *')).map((e) => e.textContent || ''),
    );
    assert.equal(
      domTexts.filter((t) => t.includes('内容一')).length,
      1,
      '🔴🔴 DOM 里"内容一"只该出现一次，实际=' + JSON.stringify(domTexts),
    );
  } finally {
    await page.close();
  }
});

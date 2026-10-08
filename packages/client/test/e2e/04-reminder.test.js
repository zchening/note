/**
 * 提醒全链路 e2e（REM 系列）—— 真浏览器
 *
 * 🔴🔴 为什么提醒必须走 e2e 而不是单测：
 *   提醒的一半价值在**交互**上 —— 光标落在时间串上 chip 才出现、点 CTA 才加提醒、
 *   加完 chip 变确认卡、响铃卡在页内弹。这些都是 DOM 行为，jsdom 测不了
 *   （本仓刻意不装 jsdom，守"零依赖"投毒防线）。
 *
 * 🔴🔴 为什么"没装 jsdom"这件事本身要写下来：
 *   一旦有人顺手 `npm i -D jsdom` 装上，测试就会分成"一半 jsdom 一半 e2e"两套口径，
 *   两套对"chip 何时显示"的判据很容易不一致 —— 于是出现"单测绿、真机不弹 chip"。
 *
 * 路径纪律：走真实用户路径（落地页 → 口令页 → 编辑器），不直接 goto。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, openEditorAt, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 必须用 resolve 拼绝对路径，不能用 new URL('../../../www/', import.meta.url).pathname
//   —— Windows 下 pathname 带前导斜杠（/D:/Users/...），readFile 直接 ENOENT，
//   症状是全部用例TimeoutError（我第一版就这么写的）。
//
// 🔴🔴 必须是 **4 级**（e2e → test → client → packages → 仓库根），不是 3 级。
//   我照抄 03 头部时写成 '..','..','..'，得到 packages/www —— 那个目录不存在，
//   于是 index.html 直接 404。症状极具欺骗性：bodyHTML 只剩 74 字符、
//   '#li' 永远等不到、pageerror 与启动失败横幅全是空的（因为压根没有页面），
//   只有 console 里一条 "Failed to load resource: 404"。
//   我在这上面绕了很久去查 main.ts 和启动流程 —— 真凶是路径少一级。
//   判据口诀：**bodyHTML 长度只有几十 = 没页面，别查 JS，先查 WWW 路径。**
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

/** 在编辑器里输入一段纯文本（走真键盘，触发真input 事件）。 */
async function typeBody(page, text) {
  await page.click('.ns-editor');
  await page.keyboard.type(text);
}

/**
 * 把光标移到全文第 offset 个字符处。
 *
 * 🔴🔴 Range.setStart 的签名是 `setStart(node, offset)` —— 第一个参数必须是
 *   **节点**，第二个才是节点内偏移。我第一版写成 `r.setStart(left, left)`
 *   （把偏移当节点传），报`parameter 1 is not of type 'Node'`，
 *   9 条用例一起红，报错还落在 evaluate 内部，看着像页面坏了。
 *
 * 健壮性：offset 超界就钳到最后，且**必须自己派发 selectionchange** ——
 *   programmatic改Range 在各内核不一定触发该事件，不补就静默不命中 chip。
 */
async function caretTo(page, offset) {
  return page.evaluate((off) => {
    const el = document.querySelector('.ns-editor');
    if (!el) throw new Error('找不到 .ns-editor');
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = Math.max(0, off);
    let node = walker.nextNode();
    let last = null;
    while (node) {
      const len = (node.textContent || '').length;
      if (left <= len) break;
      left -= len;
      last = node;
      node = walker.nextNode();
    }
    if (!node) {
      // 越界：钳到最后一个文本节点末尾
      node = last;
      left = node ? (node.textContent || '').length : 0;
    }
    if (!node) throw new Error('编辑器里没有文本节点，无法定位光标');
    const r = document.createRange();
    r.setStart(node, left);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    return { node: node.textContent, offset: left };
  }, offset);
}

test('REM-01 时间 chip：光标落在未过期时间串上浮出「添加提醒」', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem01', 'pw');
  try {
    // NOW 之前的时间会过期，chip 不出现；用明天的时刻
    const tomorrow = await page.evaluate(() => {
      const d = new Date(Date.now() + 24 * 3600000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getMonth() + 1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    await typeBody(page, `会议 ${tomorrow} 开始`);
    // 光标放到时间串中间
    const idx = 3 + 4;
    await caretTo(page, idx);
    const visible = await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 }).catch(() => null);
    assert.ok(visible, 'chip 应出现');
    const txt = await page.textContent('#timeChip');
    assert.ok(txt.includes('添加提醒'), '实际=' + txt);
  } finally {
    await page.close();
  }
});

test('REM-02 🔴 已过期的时间串不浮 chip（老项目零打扰铁律）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem02', 'pw');
  try {
    // 昨天的时刻：解析层会标 expired
    const yesterday = await page.evaluate(() => {
      const d = new Date(Date.now() - 24 * 3600000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getMonth() + 1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    await typeBody(page, `会议 ${yesterday} 已经过去了`);
    await caretTo(page, 3 + 4);
    // 给一点时间让 selectionchange 处理完
    await page.waitForTimeout(300);
    const hidden = await page.evaluate(() => {
      const el = document.querySelector('#timeChip');
      return !el || el.classList.contains('hidden');
    });
    assert.ok(hidden, '已过期的时间串不该出 chip');
  } finally {
    await page.close();
  }
});

test('REM-03 点「添加提醒」后 chip 变确认卡，且真源里出现该提醒', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem03', 'pw');
  try {
    const tomorrow = await page.evaluate(() => {
      const d = new Date(Date.now() + 24 * 3600000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getMonth() + 1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    await typeBody(page, `${tomorrow} 开会`);
    await caretTo(page, 4);
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });
    await page.click('#timeChip');
    // chip 变确认卡
    const chipTxt = await withTimeout(
      page.waitForFunction(() => {
        const el = document.querySelector('#timeChip');
        return el && el.textContent.includes('提醒已添加') ? el.textContent : null;
      }, { timeout: 5000 }),
      6000, '等确认卡',
    );
    assert.ok(String(chipTxt).includes('提醒已添加'));
    // 🔴 真源里必须真的有提醒
    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal(doc.reminders.length, 1, '真源里应恰好一条提醒');
    assert.ok(doc.reminders[0].at, '必须有 at');
    // 事项应刷新为「 开会」附近的内容
    assert.ok(doc.reminders[0].text.includes('开会') || doc.reminders[0].text === '',
      '事项应含「开会」，实际=' + JSON.stringify(doc.reminders[0].text));
  } finally {
    await page.close();
  }
});

test('REM-04 🔴 加了提醒后正文出现下划线（span带 rem 标记）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem04', 'pw');
  try {
    const tomorrow = await page.evaluate(() => {
      const d = new Date(Date.now() + 24 * 3600000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getMonth() + 1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    await typeBody(page, `${tomorrow} 开会`);
    await caretTo(page, 4);
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });
    await page.click('#timeChip');
    // 🔴 等对账把rem 标记挂回 span（对账在 update 监听里跑，是异步的）
    //
    // 🔴🔴 选择器是 **`u.rem-mark`**，不是 `.ns-rem` —— 我第一版写 `.ns-rem`，
    //   而 ReminderMarkNode.createDOM() 建的是 `<u class="rem-mark" data-rem="...">`
    //   （见 nodes.ts）。于是这个选择器**永远匹配不到**，用例 timeout，
    //   而产品其实完全正常（探针实测下划线数 = 1）。
    //   这是"测试判据手写了一份和实现不同的口径"的典型：两边都要改，且必须改对。
    //   判据以**生产代码的类名**为准，不以自己想当然的命名为准。
    await withTimeout(
      page.waitForFunction(() => document.querySelectorAll('.ns-editor u.rem-mark').length > 0, { timeout: 5000 }),
      6000, '等下划线出现',
    );
    const marked = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.ns-editor u.rem-mark')).map((e) => e.textContent));
    assert.equal(marked.join(''), tomorrow, '下划线应正好盖住时间串，实际=' + JSON.stringify(marked));
    // 🔴 事项不能被划上
    const allText = await page.evaluate(() => document.querySelector('.ns-editor').textContent);
    assert.ok(allText.includes('开会'), '正文文字必须完整');
  } finally {
    await page.close();
  }
});

test('REM-05 🔴 正文删掉时间串，提醒自动消失（联动）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem05', 'pw');
  try {
    const tomorrow = await page.evaluate(() => {
      const d = new Date(Date.now() + 24 * 3600000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getMonth() + 1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    await typeBody(page, `${tomorrow} 开会`);
    await caretTo(page, 4);
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });
    await page.click('#timeChip');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 1, { timeout: 5000 }),
      6000, '等提醒进真源',
    );
    // 全选删除
    await page.click('.ns-editor');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 0, { timeout: 5000 }),
      6000, '等提醒被判死',
    );
    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal((doc.reminders || []).length, 0, '正文删了时间串，提醒必须消失');
  } finally {
    await page.close();
  }
});

test('REM-06 顶栏铃铛打开提醒面板，面板里有「添加提醒」', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem06', 'pw');
  try {
    await page.click('#remBtn');
    const box = await page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 5000 });
    assert.ok(box, '面板应显示');
    const txt = await page.textContent('.ns-rembox');
    assert.ok(txt.includes('添加提醒'), '实际=' + txt);
    // 滚轮应存在（时/分各一）
    const wheels = await page.evaluate(() => ({
      hh: !!document.querySelector('.ns-rem-wheel-hh'),
      mm: !!document.querySelector('.ns-rem-wheel-mm'),
    }));
    assert.ok(wheels.hh && wheels.mm, '时/分滚轮都应存在，实际=' + JSON.stringify(wheels));
    // 默认时刻 = 当前 +5 分钟（老项目 v5.42）
    const defaulted = await page.evaluate(() => {
      const hh = document.querySelector('.ns-rem-wheel-hh');
      const mm = document.querySelector('.ns-rem-wheel-mm');
      return { hh: Number(hh.dataset.val), mm: Number(mm.dataset.val) };
    });
    const now = new Date(Date.now() + 5 * 60000);
    assert.equal(defaulted.hh, now.getHours(), '小时轮默认值应为 +5 分钟处的小时');
  } finally {
    await page.close();
  }
});

test('REM-07 面板里加一条提醒，真源出现该提醒，面板自动收起', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem07', 'pw');
  try {
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 5000 });
    await page.fill('.ns-rem-input', '开会');
    await page.click('.ns-rem-add');
    // 面板收起
    await withTimeout(
      page.waitForSelector('.ns-rembox', { state: 'hidden', timeout: 5000 }),
      6000, '等面板收起',
    );
    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal((doc.reminders || []).length, 1, '应恰好一条提醒');
    assert.equal(doc.reminders[0].text, '开会');
  } finally {
    await page.close();
  }
});

test('REM-08 面板里点 × 取消提醒，真源里消失', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem08', 'pw');
  try {
    // 先加一条
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 5000 });
    await page.fill('.ns-rem-input', '开会');
    await page.click('.ns-rem-add');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 1, { timeout: 5000 }),
      6000, '等提醒进真源',
    );
    // 再开面板点×
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 5000 });
    await page.click('.ns-rem-off');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 0, { timeout: 5000 }),
      6000, '等提醒被取消',
    );
    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal((doc.reminders || []).length, 0);
  } finally {
    await page.close();
  }
});

test('REM-09🔴 提醒要真推上服务器（不只是本地）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem09', 'pw');
  try {
    const tomorrow = await page.evaluate(() => {
      const d = new Date(Date.now() + 24 * 3600000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getMonth() + 1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    await typeBody(page, `${tomorrow} 开会`);
    await caretTo(page, 4);
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });
    await page.click('#timeChip');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 1, { timeout: 5000 }),
      6000, '等提醒进真源',
    );
    // 🔴🔴 等推送必须**轮询服务器 store**，不能等页面里的东西。
    //   我第一版写的是 `waitForFunction(() => __NOTESYNC_DOC__().reminders.length === 1)`
    //   —— 那是**本地**状态，在这条断言之前早就成立了，等于什么都没等；
    //   然后立刻去读 h.api.notes，此时 debounce（700ms）还没走完，必然读不到。
    //   症状：断言「服务器上应有这条笔记」失败，但产品其实完全正常。
    //   判据纪律：**跨进程/跨边界（浏览器→服务器）的断言，等的是那一侧的状态**。
    //   轮询上限给 8 秒：首推 + 编辑推 + 加密往返都留足余量。
    const deadline = Date.now() + 8000;
    let raw = null;
    while (Date.now() < deadline) {
      const v = h.api.notes.get('rem09');
      if (v !== undefined && v !== null) {
        raw = typeof v === 'string' ? v : JSON.stringify(v);
        break;
      }
      await page.waitForTimeout(200);
    }
    assert.ok(raw !== null, '服务器上应有这条笔记（等了 8 秒仍没收到推送）');
    // 密文不该含明文：提醒、事项、时间串全部加密，服务器只见信封
    for (const secret of ['提醒', '开会', tomorrow, 'reminders']) {
      assert.ok(!raw.includes(secret), `服务器密文里不该出现「${secret}」，实际=${raw.slice(0, 200)}`);
    }
    // 反向自证：信封本身该是合法 JSON 且含密文字段
    //（证明上面不是"因为压根没内容"而过的）。
    // 🔴 `v` 是**数字** 1（信封版本号），不是字符串 —— 我第一版断言 `typeof env.v === 'string'`，
    //   于是一条本来完全正常的用例红了。信封形态见 shared-schema/src/crypto.ts。
    const env = JSON.parse(raw);
    assert.equal(env.v, 1, '信封版本应为数字 1，实际=' + JSON.stringify(env.v));
    assert.equal(env.alg, 'AES-256-GCM', '算法应为 AES-256-GCM');
    assert.equal(env.kdf?.name, 'PBKDF2-HMAC-SHA256', 'KDF 名称必须完整拼写');
    assert.ok(typeof env.iv === 'string' && env.iv.length > 0, '信封必须有 iv');
    assert.ok(typeof env.ct === 'string' && env.ct.length > 0, '信封必须有密文 ct');
  } finally {
    await page.close();
  }
});

test('REM-10 🔴 XSS：提醒事项含 HTML 时不得执行', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem10', 'pw');
  try {
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 5000 });
    const payload = '<img src=x onerror="window.__pwned=1">';
    await page.fill('.ns-rem-input', payload);
    await page.click('.ns-rem-add');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 1, { timeout: 5000 }),
      6000, '等提醒进真源',
    );
    // 等 chip 消失（1.6秒后自动隐藏）
    await page.waitForTimeout(2000);
    const pwned = await page.evaluate(() => !!window.__pwned);
    assert.ok(!pwned, 'XSS被执行了');
    // 重新打开面板：列表里应显示为**纯文本**
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 5000 });
    const rowTxt = await page.textContent('.ns-rem-row');
    assert.ok(rowTxt.includes('<img'), '应显示原始字符串作为文本，实际=' + rowTxt);
    // 页面里不该有真的 img 元素
    const imgCount = await page.evaluate(() => document.querySelectorAll('.ns-rembox img').length);
    assert.equal(imgCount, 0, '不该把 payload 解析成真的img 元素');
  } finally {
    await page.close();
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * REM-11 提醒 chip 的 DOM 形态（用户报障第 2 条的 DOM 侧）
 *
 * 🔴🔴 为什么纯逻辑判据不够：rem-format.test.mjs 的 F1/F5 钉的是
 *   `fmtChipTime`/`fmtChipDay` 两个**函数返回值**（今天几点几分、周几、X天后），
 *   但用户截图里看到的是**排版**：时间在不在最左、是不是加粗、右边有没有留白、
 *   事项和按钮之间有没有那条线。这些全是 DOM 顺序 + CSS，jsdom 测不了。
 *
 * 🔴🔴 判据一律读**真浏览器 getComputedStyle / getBoundingClientRect**：
 *   读 CSS 源文本会踩"选择器 specificity 算错 ⇒ 恒绿"的坑（本仓已栽过，
 *   v1.8.0 导出折叠补丁就是这么漏过一整批）。
 *
 * ── 老项目的权威形态（index.html:6410-6424，只读）────────────────────────
 *   hd行：[clock(绝对时间，加粗)]  ......  [rel(相对日)]
 *   下一行：事项（截断）
 *   然后：sep 分隔线
 *   然后：「添加提醒」CTA
 * ═══════════════════════════════════════════════════════════════════════ */

test('REM-11 🔴 提醒 chip：时间在首行最左且加粗、同日不挂相对日、事项与按钮之间有分隔线', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem11', 'pw');
  try {
    // 用「明天」：老项目对同日的口径是**不显示**右侧（if (dayTxt) 才挂），
    // 那条分支没有相对日元素可测；要测"最左且加粗"用非今日更稳（不会被秒跳）。
    const tomorrow = await page.evaluate(() => {
      const d = new Date(Date.now() + 24 * 3600000);
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getMonth() + 1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    await typeBody(page, `会议 ${tomorrow} 开始`);
    // 光标压在时间串上（时间串前有「会议 」3 个字）
    await caretTo(page, 3 + 4);
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });

    // ── ① 首行顺序 + 加粗：时间必须在最左（老项目 index.html:6410-6418）──
    const hd = await page.evaluate(() => {
      const h = document.querySelector('#timeChip .ns-chip-hd');
      if (!h) return null;
      const kids = Array.from(h.children).map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { cls: el.className, text: el.textContent, weight: cs.fontWeight, left: r.left };
      });
      return { kids, hdLeft: h.getBoundingClientRect().left };
    });
    assert.ok(hd, '首行 .ns-chip-hd 必须存在');
    assert.equal(hd.kids[0].cls, 'ns-chip-clock', '首行第一个必须是时间（老项目时间在最左）');
    const clockWeight = Number(hd.kids[0].weight);
    assert.ok(
      clockWeight >= 600,
      '时间必须加粗（老项目 :6410 b标签），实测 fontWeight=' + hd.kids[0].weight,
    );
    assert.ok(
      hd.kids[0].left < hd.hdLeft + 2,
      '时间必须贴首行左缘（实测 left=' + hd.kids[0].left + ' vs 行左缘 ' + hd.hdLeft + '）',
    );

    // 🔴 反向：相对日必须挂在**右边**且不与时间重叠。
    //   老项目是 space-between 的两端；bj 此前是「相对日左 / 时间右」——
    //   那是用户截图里"左小右大、主次颠倒"的直接原因。
    if (hd.kids.length > 1) {
      assert.equal(hd.kids[1].cls, 'ns-chip-rel', '第二个应是相对日');
      assert.ok(
        hd.kids[1].left > hd.kids[0].left,
        '🔴 相对日必须在时间右侧（实测 ' + hd.kids[0].left + ' vs ' + hd.kids[1].left + '）',
      );
    }

    // ── ② 分隔线：.ns-chip-sep 节点必须真的存在且有高度 ──
    //   🔴 这条是本轮真正的漏项：bj 的样式表**早就有** .ns-chip-sep 规则
    //   （styles.css:1108），但 showChip() 从没创建过这个元素 ——
    //   典型的「有样式没节点」，规则恒不命中，症状恰好是"老项目有、bj 没有"。
    const sep = await page.evaluate(() => {
      const s = document.querySelector('#timeChip .ns-chip-sep');
      if (!s) return null;
      const r = s.getBoundingClientRect();
      const cs = getComputedStyle(s);
      return { h: r.height, border: cs.borderTopWidth + ' ' + cs.borderTopStyle, mt: cs.marginTop };
    });
    assert.ok(sep, '🔴 .ns-chip-sep 节点必须存在（老项目 :6424 有这条分隔线）');
    assert.ok(sep.h > 0, '分隔线必须有高度，实际=' + sep.h + '（有节点但没高度= 规则没命中）');

    // 🔴 反向：分隔线必须在**事项与 CTA 之间**（不是随便塞在哪儿）
    const order = await page.evaluate(() => {
      const chip = document.querySelector('#timeChip');
      if (!chip) return null;
      return Array.from(chip.children).map((el) => el.className);
    });
    const iItem = order.indexOf('ns-chip-item');
    const iSep = order.indexOf('ns-chip-sep');
    const iCta = order.indexOf('ns-chip-cta');
    assert.ok(iItem >= 0 && iSep >= 0 && iCta >= 0, 'chip 必须有事项行/分隔线/CTA 三段，实际=' + order.join('|'));
    assert.ok(iItem < iSep && iSep < iCta, `分隔线必须夹在事项与 CTA 之间，实际顺序 ${order.join('>')}`);
  } finally {
    await page.close();
  }
});

test('REM-12 🔴 同日的提醒：首行右侧不挂相对日元素（老项目 if (dayTxt) 口径）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem12', 'pw');
  try {
    // 今天稍晚一刻钟（避开跨分钟/跨小时的抖动，也确保未过期）
    const today = await page.evaluate(() => {
      const d = new Date(Date.now() + 15 * 60000);
      const p = (x) => String(x).padStart(2, '0');
      return `今天${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    await typeBody(page, `提醒 ${today} 交`);
    await caretTo(page, 3 + 5);
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });

    const got = await page.evaluate(() => {
      const h = document.querySelector('#timeChip .ns-chip-hd');
      if (!h) return null;
      const rel = h.querySelector('.ns-chip-rel');
      return {
        clockText: (h.querySelector('.ns-chip-clock') || {}).textContent || '',
        hasRel: !!rel,
        // 首行右侧的横向位置：老项目同日是「时间独占一行、右边全空」
        clockRight: ((h.querySelector('.ns-chip-clock') || {}).getBoundingClientRect() || {}).right || 0,
        hdRight: h.getBoundingClientRect().right,
      };
    });
    assert.ok(got, '首行必须存在');
    // 🔴 同日：绝对时间必须带「今天」前缀（老项目 :6410 的 today 分支）
    assert.ok(got.clockText.includes('今天'), '同日必须显示「今天几点几分」，实际=' + got.clockText);
    // 🔴🔴 同日**不许挂**相对日元素：挂一个空 span 会在 space-between 下
    //   把加粗时间挤离左缘，症状是"今天的提醒时间不贴左、和明天的不一样"。
    assert.equal(got.hasRel, false, '同日不许挂 .ns-chip-rel（老项目 if (dayTxt) 才挂）');
  } finally {
    await page.close();
  }
});

/* ═══════════════ 事项不跨行（老项目 caretInfoInEditor 块级口径）═══════════════ */

/**
 * 🔴🔴🔴 REM-13 提醒 chip 的事项**只取时间串所在那一行**，不得吞掉下面各行。
 *
 * 现象（用户报障第 1 条）：正文输入
 *     2027-3-1 10:00　买菜和水果 ↵
 *     第二行文字 ↵
 *     第三行文字
 * 把光标移到第一行的时间串上，chip 里的事项显示成
 *     「买菜和水果第二行文字第三行文字」
 *
 * 🔴 根因不是"少了个 trim"，是**取文本的粒度**错了：
 *   旧实现拿 `editable.textContent`（所有块无分隔符拼接）+ 全编辑器偏移，
 *   `itemForChip` 的 `end` 回退到 text.length ⇒ 后面所有块一起进事项。
 *   老项目 index.html:6305 `caretInfoInEditor()` 返回的是
 *   **块级 textContent + 块内偏移**，所以天然不跨行。
 *
 * 🔴 老项目真机对照（量化实测 390×844，非源码推断）：
 *   infoText = "2027-3-1 10:00　买菜和水果"   itemAfterMatch = "买菜和水果"
 */
test('REM-13 🔴🔴 chip 事项只取本行，不得把下面各行吞进来', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem13', 'pw');
  try {
    await page.click('.ns-editor');
    await page.keyboard.type('2027-3-1 10:00　买菜和水果');
    await page.keyboard.press('Enter');
    await page.keyboard.type('第二行文字');
    await page.keyboard.press('Enter');
    await page.keyboard.type('第三行文字');
    await page.waitForTimeout(300);

    // 光标移回第一行时间串上（offset 3 落在 "2027" 里）
    await caretTo(page, 3);
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });

    const got = await page.evaluate(() => {
      const c = document.querySelector('#timeChip');
      return {
        item: (c.querySelector('.ns-chip-item') || {}).textContent || '',
        editorText: document.querySelector('.ns-editor').textContent,
      };
    });

    assert.equal(got.item, '买菜和水果',
      '事项必须是本行时间串之后的文字，实际=' + JSON.stringify(got.item));

    // 🔴 反向断言：下面两行一个字都不许进事项。
    //   只有正向断言时，"把整篇正文都当事项"这种更离谱的错法也能变绿。
    for (const forbidden of ['第二行文字', '第三行文字']) {
      assert.ok(!got.item.includes(forbidden),
        '事项不得包含下一行的内容：' + forbidden + '，实际=' + JSON.stringify(got.item));
    }
    // 🔴 前三行确实都在正文里 —— 证明上面两条不是因为"没输入进去"而绿的
    assert.ok(got.editorText.includes('第二行文字') && got.editorText.includes('第三行文字'),
      '正文必须真的有三行，editorText=' + JSON.stringify(got.editorText));
  } finally {
    await page.close();
  }
});

/**
 * 🔴 REM-14 同一行内**两个**时间串：事项只到下一个时间串为止（老项目 itemAfterMatch 同款）。
 *
 * 与 REM-13 配对：REM-13 钉"不跨块"，本条钉"同行按下一个时间串截断"。
 * 两者都绿才说明切法与老项目 `itemAfterMatch`（index.html:6041）一致。
 */
test('REM-14 同行第二个时间串会截断事项（老项目 itemAfterMatch 同款）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem14', 'pw');
  try {
    await page.click('.ns-editor');
    await page.keyboard.type('2027-3-1 10:00　买菜　2027-3-2 09:00　水果');
    await page.waitForTimeout(300);

    await caretTo(page, 3);
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });
    const first = await page.evaluate(() =>
      (document.querySelector('#timeChip .ns-chip-item') || {}).textContent || '');
    assert.equal(first, '买菜', '第一个时间串的事项只到下一个时间串前，实际=' + JSON.stringify(first));

    // 光标移到第二个时间串上（跳过 "2027-3-1 10:00　买菜　" 共 18 字符）
    await caretTo(page, 18 + 3);
    await page.waitForTimeout(400);
    const second = await page.evaluate(() => ({
      item: (document.querySelector('#timeChip .ns-chip-item') || {}).textContent || '',
      visible: !document.querySelector('#timeChip').classList.contains('hidden'),
    }));
    assert.equal(second.visible, true, '第二个时间串也应浮 chip');
    assert.equal(second.item, '水果', '第二个时间串的事项=' + JSON.stringify(second.item));
  } finally {
    await page.close();
  }
});

test('REM-15 🔴🔴 提醒面板开着时，遮罩守卫必须认得出来（链接识别延迟守卫的前提）', async () => {
  // 🔴🔴 这条判的是**一个恒失效的守卫**，不是界面。
  //
  //   `main.ts hasOverlayPanelOpen()` 是链接识别延迟守卫的一项（老项目 index.html:3632
  //   的 `!remPanelOpen`）：面板开着时正文不可编辑，那种场景没有新输入，
  //   若也把识别推迟 1.5s，用户会看到"打开面板时点正文，光标被链接重建弹走"。
  //
  //   病：`hasOverlayPanelOpen()` 问的是 `document.querySelector('.ns-rem-mask:not(.hidden)')`，
  //   而提醒面板的真实 DOM 是 `reminder/ui.ts` `mask.className = 'mask hidden'` ——
  //   **既没有 `.ns-rem-mask` 也没有任何 id** ⇒ 该查询恒返回 null ⇒ 守卫静默失效。
  //   同一条函数里 `querySelector('.ns-scan:not(.hidden)')` 同样恒 null
  //   （扫一扫真实根元素是 `#scanMask`，scan/layer.ts:66-67）。
  //
  // 🔴 为什么钉 DOM 事实而不是钉 `hasOverlayPanelOpen` 的返回值：
  //   它在 main.ts 里，import 就会把整个应用启动起来。所以这里钉**它所依赖的事实**
  //   （提醒遮罩有稳定 id / 开着时没有 hidden / 关掉后 hidden 回去）。
  //   🔴 扫一扫那一支（`#scanMask`）**本条不覆盖** —— 打开取景框要真摄像头，
  //   本仓刻意不在共享 harness 里造假 MediaStream（见 MEMORY 的 Playwright 纪律）。
  //   它由源码层对齐保证：守卫查的 id 与 scan/layer.ts:67 建的一致。
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem15', 'pw');
  try {
    // 面板未开时：遮罩可以在 DOM 里，但必须挂着 hidden
    const closed = await page.evaluate(() => {
      const m = document.getElementById('remMask');
      return { exists: !!m, hidden: m ? m.classList.contains('hidden') : null };
    });
    assert.equal(closed.exists, true,
      '提醒遮罩必须有一个稳定 id（守卫靠它查；此前它只有 class="mask hidden"，守卫恒失效）');
    assert.equal(closed.hidden, true, '面板未打开时遮罩必须带 hidden');

    await page.click('#remBtn');
    await withTimeout(page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 5000 }), 6000, '等提醒面板');

    const open = await page.evaluate(() => {
      const m = document.getElementById('remMask');
      return {
        hidden: m ? m.classList.contains('hidden') : null,
        // 守卫真正的判据式（与 main.ts 现在的实现同款）
        guardRem: !!(m && !m.classList.contains('hidden')),
      };
    });
    assert.equal(open.hidden, false, '面板打开后遮罩必须摘掉 hidden');
    assert.equal(open.guardRem, true,
      '面板开着时守卫的第一分支必须为真（此前 .ns-rem-mask 恒 null ⇒ 整条守卫失效）');

    // 关闭面板 → hidden 必须回去（反向断言）
    await page.evaluate(() => {
      const x = document.querySelector('#remMask .box-x');
      if (x) x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await withTimeout(
      page.waitForFunction(() => document.getElementById('remMask')?.classList.contains('hidden'), { timeout: 5000 }),
      6000, '关闭后遮罩应回到 hidden',
    );
  } finally {
    await page.close();
  }
});

/* ══════════ Bug6/2（2026-10-08 用户报障）══════════ */

/**
 * REM-16 🔴 相对时间串（周日下午两点）chip 加提醒 → 下划线 + 真源
 *
 * 🔴 Bug6 用户报障「周日下午两点 喝水…添加为提醒事项成功后，时间串下面是没有下划线的」。
 *   真浏览器实测（HEAD）：chip 路径对相对时间串的下划线**是好的**——本条把它钉成
 *   常驻回归闸：凡动 reconcile / spansToNodes(remIds 闸) / ReminderMarkNode 的改动，
 *   必须让这条保持绿。相对格式与 REM-04 的冒号格式走的是同一条对账路，
 *   差异只在字符串形态——所以它俩**必须各钉一条**（输入形状不同，能拦的回归不同）。
 */
test('REM-16 🔴 相对时间串 chip 加提醒：下划线盖住时间串（Bug6 回归闸）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem16', 'pw');
  try {
    await typeBody(page, '周日下午两点 喝水');
    await new Promise((r) => setTimeout(r, 300));
    await caretTo(page, 2);
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });
    await page.click('#timeChip');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 1, { timeout: 5000 }),
      6000, '等提醒进真源',
    );
    await withTimeout(
      page.waitForFunction(() => document.querySelectorAll('.ns-editor u.rem-mark').length > 0, { timeout: 5000 }),
      6000, '等下划线出现',
    );
    const marked = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.ns-editor u.rem-mark')).map((e) => e.textContent));
    assert.equal(marked.join(''), '周日下午两点', `下划线应正好盖住相对时间串，实际=${JSON.stringify(marked)}`);
    const allText = await page.evaluate(() => document.querySelector('.ns-editor').textContent);
    assert.ok(allText.includes('喝水'), '正文文字必须完整');
  } finally {
    await page.close();
  }
});

/**
 * REM-17 🔴🔴 空笔记里点进正文再开面板加提醒（Bug2 用户形状）
 *
 * 🔴🔴 病根：用户先点进**空正文**（光标=空段落的 element 锚点）再开面板，
 *   saveEditorSelection 把 element 锚点存下来、insertRemLineToEditor 恢复时
 *   把它**强设成 'text' 类型** → sel.insertText 静默空转 → 插行没进正文 →
 *   提醒被对账按「正文找不到时间串」判死 → 正文、提醒面板两边什么都没有，
 *   且**面板照常收起、零报错**。
 *
 * 🔴 REM-07 此前只测「不碰正文直接开面板」的形状（panelSavedSel=null → 文末追加），
 *   这类形状盲区正是本项目判据纪律里说的「输入形状决定判据能发现哪类 bug」。
 */
test('REM-17 🔴🔴 空笔记点进正文再开面板加提醒（Bug2 用户形状）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'rem17', 'pw');
  try {
    // 用户形状：先点进空正文（空段落 element 锚点），再开面板
    await page.click('.ns-editor');
    await new Promise((r) => setTimeout(r, 300));
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 5000 });
    await page.fill('.ns-rem-input', '开会');
    await page.click('.ns-rem-add');
    await withTimeout(
      page.waitForSelector('.ns-rembox', { state: 'hidden', timeout: 5000 }),
      6000, '等面板收起',
    );
    const doc = await page.evaluate(() => window.__NOTESYNC_DOC__());
    assert.equal((doc.reminders || []).length, 1, `真源应恰好一条提醒，实际=${JSON.stringify(doc.reminders || [])}`);
    const body = await page.evaluate(() => document.querySelector('.ns-editor').textContent);
    assert.ok(body.includes('开会'), `正文应出现提醒时间串行，实际=${JSON.stringify(body)}`);
  } finally {
    await page.close();
  }
});

/* ═════════════ REM-18..21：v2.0.1 批（用户报障 2026-10-08）═══════════════
 * ① 删除线渲染整个缺失（grep rem-done 全库零挂载，CSS 是死代码）；
 * ② 删时间串片段后下划线残留（IME 门控推迟标记回写且无补铺）；
 * ③ 补弹一张卡塞全部过期提醒 + 「过期了X分钟」噪音文案；
 * ④ 面板删光未来提醒后不收起、手机上每次重渲染都弹键盘。
 */

test('REM-18 🔴 到点后正文标记 u.rem-mark → s.rem-done（用户拍板「时间过了就画」）', async () => {
  // 🔴🔴 假钟 install 必须放在 **click chip 之前、其余流程之后**：
  //   rearm 排的 setTimeout（schedule()）要在假钟下排，fastForward 才推得动；
  //   而 install 一旦发生 rAF 全停，放在最前面会让打开/打字阶段的渲染间歇性
  //   停摆（实测三红两绿的根因）。openEditor（真钟）负责打开与打字，
  //   install 卡在「下划线已铺上、还差一次假钟推进」的窗口里。
  const page = await openEditor(h.browser(), h.baseUrl(), `rem18-${Date.now()}`, 'pw');
  try {
    const stamp = await page.evaluate(() => {
      const d = new Date(Date.now() + 120_000); // 🔴 +120s：分钟取整后 at-now 恒 >30s 容差，chip 不会误判过期
      const p = (x) => String(x).padStart(2, '0');
      return `${d.getMonth() + 1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
    });
    await typeBody(page, `${stamp} 开会`);
    await page.waitForTimeout(300); // 🔴 打字后等 Lexical DOM reconcile（REM-13 同款，防 caretTo 读到半截树）
    await caretTo(page, 4);
    try {
      await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });
    } catch (e) {
      const dbg = await page.evaluate(() => {
        const sel = window.getSelection();
        return {
          text: document.querySelector('.ns-editor')?.textContent ?? '',
          anchor: sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startOffset : -1,
          container: sel && sel.rangeCount > 0 ? String(sel.getRangeAt(0).startContainer.nodeName) : '(none)',
          active: document.activeElement?.className ?? '(none)',
          chip: document.querySelector('#timeChip')?.className ?? '(no chip)',
        };
      });
      throw new Error(`${e.message}；现场=${JSON.stringify(dbg)}`);
    }
    await page.clock.install(); // ← 此刻接管 timer；rearm 的 setTimeout 在 setDoc 之后才排，必被接管
    await page.click('#timeChip');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 1, { timeout: 5000 }),
      6000, '等提醒进真源',
    );
    await withTimeout(
      page.waitForFunction(() => document.querySelectorAll('.ns-editor u.rem-mark').length > 0, { timeout: 5000 }),
      6000, '等未来侧下划线铺上',
    );
    // 推进到提醒时刻之后 → fireScheduled 醒 → fire → refreshDone → 节点重建为 <s>
    await page.clock.fastForward(125_000);
    await withTimeout(
      page.waitForSelector('.ns-editor s.rem-done', { timeout: 8000 }),
      9000, '等到点后标记变删除线',
    );
    const marks = await page.evaluate(() => ({
      done: document.querySelectorAll('.ns-editor s.rem-done').length,
      future: document.querySelectorAll('.ns-editor u.rem-mark').length,
      // 🔴 时间段与事项段是 markSpans 切出的**两个相邻 <s>**（各自挂同一 remId），
      //    单取第一个会漏掉事项段 —— 判"整段覆盖"必须 join 全部
      text: Array.from(document.querySelectorAll('.ns-editor s.rem-done')).map((e) => e.textContent).join(''),
    }));
    assert.ok(marks.done >= 1, '过期标记必须是 s.rem-done');
    assert.equal(marks.future, 0, '同一串不得同时残留下划线形态');
    assert.ok(marks.text.includes('开会'), '删除线整段覆盖到事项（老项目 v6.3 口径）');
  } finally {
    await page.close();
  }
});

test('REM-19 🔴🔴 正文删掉时间串片段（删分钟）：提醒判死 + 正文无标记残留（用户报障 2026-10-08 行为闸）', async () => {
  // 🔴🔴 形状说明：桌面 e2e 的 Backspace 走 contenteditable 原生路径（与真机
  //   beforeinput 不同构），无法在 e2e 里复现「DOM 删了/树没删」的分叉，也就无法
  //   隔离出补铺通道做单向验证（变异测试实证：在线形态同步回灌会兜底）。
  //   本条钉的是**用户可见行为的最终一致**：删掉分钟后，真源判死 + 正文无任何
  //   残留标记。补铺（IME 门控推迟回写的最终一致兜底）在 main.ts 门控分支内，
  //   由代码走查覆盖；真机验收以用户实测为准。
  const page = await openEditor(h.browser(), h.baseUrl(), `rem19-${Date.now()}`, 'pw');
  try {
    await typeBody(page, '2026-10-18 18:18 哈哈');
    await page.waitForTimeout(300); // 🔴 打字后等 Lexical DOM reconcile（REM-13 同款）
    await caretTo(page, 4);
    await page.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });
    await page.click('#timeChip');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 1, { timeout: 5000 }),
      6000, '等提醒进真源',
    );
    await withTimeout(
      page.waitForSelector('.ns-editor u.rem-mark', { timeout: 5000 }),
      6000, '等下划线铺上',
    );
    // 🔴🔴 全选重打「已删掉分钟的正文」（REM-05 已证的 Lexical 命令路径：
    //   Control+a + 输入都是 Lexical 命令，树与 DOM 由 Lexical 自己同步）。
    //   打字活跃期内对账判死：真源 reminders 必须归零、正文不得残留任何标记。
    await page.click('.ns-editor');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('2026-10-18 18: 哈哈');
    const after = await page.evaluate(() => document.querySelector('.ns-editor')?.textContent ?? '');
    assert.ok(after.startsWith('2026-10-18 18: '), `前置：分钟必须真被删掉，实际=${JSON.stringify(after)}`);
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 0, { timeout: 5000 }),
      6000, '等提醒被判死',
    );
    await withTimeout(
      page.waitForFunction(() => document.querySelectorAll('.ns-editor u.rem-mark').length === 0, { timeout: 5000 }),
      8000, '等正文标记清零（最终一致）',
    );
    const body = await page.evaluate(() => document.querySelector('.ns-editor')?.textContent ?? '');
    assert.ok(body.includes('2026-10-18 18:'), '🔴 摘标记绝不许动正文文字');
  } finally {
    await page.close();
  }
});

test('REM-20 🔴 补弹只弹离现在最近一条（无「还有 N 条」行，用户拍板 2026-10-08 修订）', async () => {
  // 🔴 唯一笔记名 + pageA/pageB **共用同一个名字**（pageB 要打开同一篇）
  const note = `rem20-${Date.now()}`;
  const pageA = await openEditor(h.browser(), h.baseUrl(), note, 'pw');
  try {
    // 两条提醒：+90s 与 +150s（分钟精度取整后必不同分钟）
    const stamps = [];
    for (const delaySec of [120, 180]) { // 🔴 分钟取整后 at-now 恒 >30s 容差
      const stamp = await pageA.evaluate((d) => {
        const t = new Date(Date.now() + d * 1000);
        const p = (x) => String(x).padStart(2, '0');
        return `${t.getMonth() + 1}月${t.getDate()}日${p(t.getHours())}:${p(t.getMinutes())}`;
      }, delaySec);
      stamps.push(stamp);
      await typeBody(pageA, stamps.length === 1 ? `${stamp} 第一` : `\n${stamp} 第二`);
      await pageA.waitForTimeout(300); // 🔴 打字后等 Lexical DOM reconcile（REM-13 同款）
      // 光标放到本行时间串中间（时间串起点 = 已有全文长度或 0，+4）
      const off = await pageA.evaluate((idx) => {
        const el = document.querySelector('.ns-editor');
        const text = el?.textContent ?? '';
        const at = text.indexOf(idx === 0 ? '第一' : '第二');
        return Math.max(0, at - 9);
      }, stamps.length - 1);
      await caretTo(pageA, off);
      await pageA.waitForSelector('#timeChip:not(.hidden)', { timeout: 5000 });
      await pageA.click('#timeChip');
      // 🔴 waitForFunction 的断言在**页面上下文**里跑，闭包变量进不去 —— 目标条数必须传 arg
      const want = stamps.length;
      await withTimeout(
        pageA.waitForFunction((n) => (window.__NOTESYNC_DOC__().reminders || []).length === n, want, { timeout: 5000 }),
        6000, `等第 ${want} 条提醒进真源`,
      );
    }
    await withTimeout(
      pageA.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 2, { timeout: 5000 }),
      6000, '等两条提醒都进真源',
    );
    // 🔴🔴 必须**等推送落地再关页**：推送走 700ms 去抖，Playwright 的 close()
    //   不派发 pagehide/beforeunload，本地兜底没机会跑 —— 关早了 pageB 拉到的是
    //   没有 reminders 的旧版，catch-up 恒空（第一轮就是这么红的）。
    await pageA.waitForTimeout(1500);
  } finally {
    await pageA.close();
  }
  // 🔴 pageB 的假钟设在 8 分钟后：打开时两条提醒都已过期 → 走 catch-up 补弹
  const pageB = await openEditorAt(h.browser(), h.baseUrl(), note, 'pw', {
    iso: new Date(Date.now() + 8 * 60_000).toISOString(),
  });
  try {
    // 补弹排在 mountEditor 后 500ms 的 setTimeout 里 —— 假钟静止，必须推一下
    await pageB.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20_000 });
    await pageB.clock.fastForward(1_000);
    await withTimeout(
      pageB.waitForSelector('#remCard:not(.hidden)', { timeout: 8000 }),
      9000, '等补弹卡出现',
    );
    // 🔴 先 dump 真源再断言：卡没弹时能直接看出是"服务器没数据"还是"补弹没跑"
    const remsB = await pageB.evaluate(() => (window.__NOTESYNC_DOC__().reminders ?? []).map((r) => r.at));
    const card = await pageB.evaluate(() => ({
      items: document.querySelectorAll('#remCard .ns-rem-item').length,
      first: document.querySelector('#remCard .ns-rem-when')?.textContent ?? '',
      more: document.querySelector('#remCard .ns-rem-more')?.textContent ?? '',
      late: document.querySelectorAll('#remCard .ns-rem-late').length,
    }));
    assert.equal(card.items, 1, `补弹只弹最近一条，绝不整列表塞一张卡（真源=${JSON.stringify(remsB)}）`);
    assert.ok(card.first.includes('第二'), `弹的必须是离现在最近的那条（at 最大、过期最晚），实际=${card.first}`);
    assert.equal(card.more, '', `「还有 N 条」次要行已按用户要求移除，实际=${card.more}`);
    assert.equal(card.late, 0, '「过期了X分钟」文案已退役');
  } finally {
    await pageB.close();
  }
});

test('REM-21 🔴 面板删光未来提醒后自动收起（老项目 toggleRemPanel(还有未来?) 口径）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), `rem21-${Date.now()}`, 'pw');
  try {
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 5000 });
    await page.fill('.ns-rem-input', '开会');
    await page.click('.ns-rem-add');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 1, { timeout: 5000 }),
      6000, '等提醒进真源',
    );
    await page.click('#remBtn');
    await page.waitForSelector('.ns-rembox', { state: 'visible', timeout: 5000 });
    await page.click('.ns-rem-off');
    await withTimeout(
      page.waitForFunction(() => (window.__NOTESYNC_DOC__().reminders || []).length === 0, { timeout: 5000 }),
      6000, '等提醒被取消',
    );
    // 🔴 hidden 挂在 mask（#remMask）上；.ns-rembox 是内容盒，从不带 hidden
    const panelHidden = await page.evaluate(
      () => document.querySelector('#remMask')?.classList.contains('hidden') ?? false,
    );
    assert.ok(panelHidden, '删光未来提醒后面板必须自动收起（老项目口径）');
  } finally {
    await page.close();
  }
});

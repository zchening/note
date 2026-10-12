/**
 * e2e 29：离线草稿全链路（v3.1.1 把 sync/draft.ts 接进主流程的**行为判据**）
 *
 * 🔴🔴 单测 19 条（draft.test.mjs）验的是模块函数形状；WIRE 判据（draft-wiring）
 *   验的是 main.ts 源码结构。本文件验的是**真浏览器里用户看见的结局**：
 *
 *   断网推送（只拦 POST、保 GET）→ 打的字进草稿 → 刷新重开 → 弹
 *   「检测到同步冲突」条 → 「保留本机」内容回灌、推送恢复后草稿自动清；
 *   「使用云端」条收起、草稿丢弃；正常推送成功后重开**不**弹条。
 *
 * 🔴 判据一律查**用户可见终态**：草稿 key 在不在 localStorage、条显不显、
 *   文本回没回灌、云端（换设备重开）拿没拿到 —— 不查任何内部状态。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..');
const WWW = join(ROOT, 'www');

const PASS = '测试口令';

const h = installHarness(test, { dir: WWW });

// 🔴 多设备竞争构造：每次导航前清掉本机离线缓存键 —— 模拟「另一台设备覆盖了云端、
//   本机缓存不可用（清数据/换浏览器），只剩一份未上云的离线草稿」。此后 unlock 走
//   在线拉取，开篇内容=云端版，草稿（含离线段）与开篇不一致 ⇒ 草稿条的本职场景。
//   🔴 没有这一步：缓存与草稿同源同更新（pagehide 的 writeCache 还会把缓存顶回
//     最新版），restore 恒判「一致」静默清 —— conflict 分支在单设备流天然不可达。
h.addInitScript(() => {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('notesync_bj_cache_')) localStorage.removeItem(k);
    }
  } catch { /* 环境不具备就算了 */ }
});

/** 等底栏状态落到某个值（#shell 的 data-sync-state，与 03-sync 同款）。 */
async function waitSyncState(page, want, ms = 15_000) {
  await withTimeout(
    page.waitForFunction((w) => document.querySelector('#shell')?.dataset.syncState === w, want, { timeout: ms }),
    ms + 5_000,
    `等同步状态 ${want}`,
  );
}

/** 草稿记录在不在盘上（localStorage，按笔记名隔离 —— draft.ts draftKeyOf 的形状）。 */
const hasDraftKey = (page, note) =>
  page.evaluate((n) => localStorage.getItem('notesync_bj_draft_' + n) !== null, note);

function waitDraftKey(page, note, want) {
  // 🔴 want 决定等什么：true=等出现，false=等消失。两个方向的条件必须真的分开 ——
  //   挂羊头卖狗肉的话"等消失"实际在等出现（v3.1.1 首版 E1 的"绿"就是假阳性）。
  const cond = want
    ? (n) => localStorage.getItem('notesync_bj_draft_' + n) !== null
    : (n) => localStorage.getItem('notesync_bj_draft_' + n) === null;
  return withTimeout(
    page.waitForFunction(cond, note, { timeout: 8_000 }).then(() => true).catch(() => false),
    10_000,
    `等草稿记录${want ? '出现' : '消失'}（${note}）`,
  );
}

/** 草稿条是否收起（hidden 类在位）。元素不存在也按收起算。 */
const barHidden = (page) =>
  page.evaluate(() => document.getElementById('draftBar')?.classList.contains('hidden') ?? true);

function waitBar(page, want) {
  // 🔴 want=false 等的是「收起」：条件必须跟 want 走，否则"等收起"实际在等弹出，
  //   点掉之后条明明收了判据还超时（v3.1.1 首版就栽在这）。
  const cond = want
    ? () => !(document.getElementById('draftBar')?.classList.contains('hidden') ?? true)
    : () => (document.getElementById('draftBar')?.classList.contains('hidden') ?? true);
  return withTimeout(
    page.waitForFunction(cond, null, { timeout: 10_000 }).then(() => true).catch(() => false),
    12_000,
    `等草稿条${want ? '弹出' : '收起'}`,
  );
}

/** 🔴 等"推送真的落云"：node 侧轮询内存 API（03-sync E2E-S5 同款）。
 *   idle 不可区分"初拉的 idle"（新笔记初拉也回 idle，与推送成功同值）——
 *   v3.1.1 首版用 waitSyncState 抢跑，基线推送被 blockPush 拦掉都没发现。 */
async function waitCloud(note) {
  const until = Date.now() + 15_000;
  for (;;) {
    if (h.api.notes.get(note) !== undefined) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 当前真源拼成的纯文本（生产代码暴露的正式接口）。 */
const docText = (page) =>
  page.evaluate(() => {
    const d = window.__NOTESYNC_DOC__();
    return (d?.blocks ?? []).map((b) => (b.spans ?? []).map((s) => s.t).join('')).join('');
  });

/**
 * 🔴 断 POST 保 GET：只拦**这一篇**笔记的推送（POST /api/note/<id>），
 *   claim/SSE/静态资源全不动 —— 模拟"服务器收得到握手、但内容推不上去"的真断网。
 */
async function blockPush(page, note) {
  await page.route('**/api/note/' + note, (route) => {
    if (route.request().method() === 'POST') route.abort();
    else route.continue();
  });
}
const unblockPush = (page, note) => page.unroute('**/api/note/' + note);

/** reload 后不输口令直接等编辑器回来（同 context 记忆解锁）。 */
async function waitEditorBack(page) {
  await withTimeout(
    page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, null, { timeout: 20_000 }),
    25_000,
    'reload 后等编辑器挂载（记忆解锁）',
  );
}

/* ============ DRAFT-E1 保留本机全链路 ============ */

test('DRAFT-E1 🔴 断推打字→草稿落盘→重开弹条→保留本机回灌→推送恢复后草稿自动清→云端拿到', async () => {
  const NOTE = 'e2e-draft1';
  const OFFLINE = '离线草稿XYZ';
  const page = await openEditor(h.browser(), h.baseUrl(), NOTE, PASS);
  try {
    // ① 基线内容正常推上云（🔴 轮询等真落云：idle 不可区分"初拉的 idle"）
    await page.click('#editor-host');
    await page.keyboard.type('基线内容');
    assert.equal(await waitCloud(NOTE), true, '基线内容应已推上云（内存 API 收到密文）');
    assert.equal(await hasDraftKey(page, NOTE), false, '正常推送后不应有草稿残留');

    // ② 只断推送：再打一段 —— 每键都该记进草稿
    await blockPush(page, NOTE);
    await page.keyboard.type(OFFLINE);
    await withTimeout(
      page.waitForFunction((s) => JSON.stringify(window.__NOTESYNC_DOC__()).includes(s), OFFLINE, { timeout: 10_000 }),
      12_000,
      '等离线内容进本地真源',
    );
    assert.equal(await waitDraftKey(page, NOTE, true), true, '🔴 推不上去的内容必须已经落进离线草稿');

    // ③ 刷新重开（同 context 记忆解锁）—— init script 已清缓存 ⇒ 开篇=云端版，
    //    草稿与开篇不一致 ⇒ 必须弹「检测到同步冲突」
    const preLen = await page.evaluate((n) => (localStorage.getItem('notesync_bj_draft_' + n) ?? '').length, NOTE);
    console.log('[DRAFT-E1 pre-reload] draftLen=' + preLen);
    await page.reload();
    await waitEditorBack(page);
    const barOk = await waitBar(page, true);
    if (!barOk) {
      const diag = await page.evaluate((n) => ({
        draftKey: !!localStorage.getItem('notesync_bj_draft_' + n),
        draftLen: (localStorage.getItem('notesync_bj_draft_' + n) ?? '').length,
        cacheKey: (localStorage.getItem('notesync_bj_cache_' + n) ?? '').slice(0, 40),
        barEl: document.getElementById('draftBar') ? 'in-dom' : 'missing',
        barClass: document.getElementById('draftBar')?.className ?? '',
        docHead: JSON.stringify(window.__NOTESYNC_DOC__()).slice(0, 100),
        syncState: document.querySelector('#shell')?.dataset.syncState ?? '?',
        lslog: (() => {
          try { return sessionStorage.getItem('lslog') ?? '(none)'; } catch { return '(err)'; }
        })(),
        flightDraft: (() => {
          try {
            const d = window.__NOTESYNC_DIAG__ ? String(window.__NOTESYNC_DIAG__() ?? '') : '';
            return d.split('\n').filter((l) => l.includes('draft:')).join(' | ') || '(no draft: lines)';
          } catch (e) { return 'diag-err:' + e; }
        })(),
      }), NOTE);
      console.log('[DRAFT-E1 diag]', JSON.stringify(diag));
    }
    assert.equal(barOk, true, '🔴 重开必须弹出草稿裁决条（「保留本机/使用云端」）');

    // ④ 保留本机：解除拦截 → 草稿内容回灌 → 正常推送 → onArchive 清草稿
    await unblockPush(page, NOTE);
    await page.click('#draftRestore');
    await withTimeout(
      page.waitForFunction((s) => {
        const d = window.__NOTESYNC_DOC__();
        return JSON.stringify((d?.blocks ?? []).map((b) => (b.spans ?? []).map((x) => x.t).join('')).join('')).includes(s);
      }, OFFLINE, { timeout: 10_000 }),
      12_000,
      '等草稿内容回灌进编辑器',
    );
    assert.equal(await waitDraftKey(page, NOTE, false), true, '🔴 推送成功后草稿必须被自动清掉（onArchive 的 clearDraft）');
    await waitSyncState(page, 'idle', 20_000);

    // ⑤ 数真通道：换一台"设备"（全新 context、手输口令）从云端拿回离线内容
    const ctx = await h.browser().newContext();
    const p2 = await ctx.newPage();
    await p2.goto(h.baseUrl() + encodeURIComponent(NOTE));
    await p2.waitForSelector('#pw', { timeout: 20_000 });
    await p2.fill('#pw', PASS);
    await p2.click('#ok');
    await withTimeout(
      p2.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, null, { timeout: 20_000 }),
      25_000,
      '第二台设备等编辑器挂载',
    );
    await withTimeout(
      p2.waitForFunction((s) => JSON.stringify(window.__NOTESYNC_DOC__()).includes(s), OFFLINE, { timeout: 15_000 }),
      20_000,
      '第二台设备等离线内容从云端回来',
    );
    await ctx.close();
  } finally {
    await unblockPush(page, NOTE);
    await page.close();
  }
});

/* ============ DRAFT-E2 使用云端 ============ */

test('DRAFT-E2 🔴 重开弹条后点「使用云端」：条收起、草稿丢弃、编辑器留在云端版', async () => {
  const NOTE = 'e2e-draft2';
  const OFFLINE = '要被丢弃的草稿ABC';
  const page = await openEditor(h.browser(), h.baseUrl(), NOTE, PASS);
  try {
    await page.click('#editor-host');
    await page.keyboard.type('云端基线');
    assert.equal(await waitCloud(NOTE), true, '基线应已推上云（🔴 idle 不可区分初拉，必须轮询落云）');

    await blockPush(page, NOTE);
    await page.keyboard.type(OFFLINE);
    await withTimeout(
      page.waitForFunction((s) => JSON.stringify(window.__NOTESYNC_DOC__()).includes(s), OFFLINE, { timeout: 10_000 }),
      12_000,
      '等离线内容进本地真源',
    );
    assert.equal(await waitDraftKey(page, NOTE, true), true, '草稿应已落盘');

    // init script 已清缓存 ⇒ 重开时开篇=云端版，草稿不一致 ⇒ 弹条（同 E1）
    await page.reload();
    await waitEditorBack(page);
    assert.equal(await waitBar(page, true), true, '重开应弹出草稿条');

    // 使用云端：丢草稿、收条、正文留在云端版（离线段消失）
    await page.click('#draftDiscard');
    const hiddenOk = await waitBar(page, false);
    if (!hiddenOk) {
      const diag = await page.evaluate((n) => ({
        draftKey: !!localStorage.getItem('notesync_bj_draft_' + n),
        barClass: document.getElementById('draftBar')?.className ?? '',
        pending: null,
        flight: (() => {
          try {
            const d = window.__NOTESYNC_DIAG__ ? String(window.__NOTESYNC_DIAG__() ?? '') : '';
            return d.split('\n').filter((l) => l.includes('draft:')).slice(-6).join(' | ');
          } catch (e) { return 'diag-err'; }
        })(),
      }), NOTE);
      console.log('[DRAFT-E2 diag]', JSON.stringify(diag));
    }
    assert.equal(hiddenOk, true, '点「使用云端」后条应收起');
    assert.equal(await waitDraftKey(page, NOTE, false), true, '草稿记录必须被丢弃');
    const text = await docText(page);
    assert.ok(!text.includes(OFFLINE), `使用云端后正文不应含离线段，实得 ${text.slice(0, 40)}`);
    assert.ok(text.includes('云端基线'), '使用云端后正文应保留云端基线');
  } finally {
    await unblockPush(page, NOTE);
    await page.close();
  }
});

/* ============ DRAFT-E3 正常推送后重开不弹条 ============ */

test('DRAFT-E3 🔴 没有离线草稿时重开：条必须保持收起（不误弹）', async () => {
  const NOTE = 'e2e-draft3';
  const page = await openEditor(h.browser(), h.baseUrl(), NOTE, PASS);
  try {
    await page.click('#editor-host');
    await page.keyboard.type('普通内容');
    assert.equal(await waitCloud(NOTE), true, '基线应已推上云（🔴 idle 不可区分初拉，必须轮询落云）');
    // onPushed 的 clearDraft 在收到 200 后同步跑：等盘上 key 真消失再断言
    await page
      .waitForFunction((n) => localStorage.getItem('notesync_bj_draft_' + n) === null, NOTE, { timeout: 8_000 })
      .catch(() => {});
    assert.equal(await hasDraftKey(page, NOTE), false, '推送成功后不该有草稿');

    await page.reload();
    await waitEditorBack(page);
    // 裁决在 startSyncFor 里同步做：没有草稿 ⇒ 不弹。给一段真实时间窗口
    // 让"如果有人误弹"来得及发生，再断它仍在收起态。
    await page.waitForTimeout(1500);
    const stillHidden = await barHidden(page);
    if (!stillHidden) {
      const diag = await page.evaluate((n) => ({
        draftLen: (localStorage.getItem('notesync_bj_draft_' + n) ?? '').length,
        cacheLen: (localStorage.getItem('notesync_bj_cache_' + n) ?? '').length,
        flight: (() => {
          try {
            const d = window.__NOTESYNC_DIAG__ ? String(window.__NOTESYNC_DIAG__() ?? '') : '';
            return d.split('\n').filter((l) => l.includes('draft:')).slice(-6).join(' | ');
          } catch (e) { return 'diag-err'; }
        })(),
      }), NOTE);
      console.log('[DRAFT-E3 diag]', JSON.stringify(diag));
    }
    assert.equal(stillHidden, true, '🔴 没有草稿时重开不许弹「检测到同步冲突」');
    assert.equal(await hasDraftKey(page, NOTE), false, '正常重开也不该凭空多出草稿');
  } finally {
    await page.close();
  }
});

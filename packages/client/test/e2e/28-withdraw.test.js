/**
 * e2e：v3.0.14 组字会话水位线（撤稿吞字守卫）
 *
 * 🔴🔴🔴 为什么必须是 e2e：撤稿恢复走「update 监听判定 → 回写真源 → 重建树」
 *   全链路，任何一环（composing 口径、守卫状态、docToLexical、对账 return）
 *   断了都是静默假绿。桌面无豆包，用钩子模拟真机 v3.0.13 日志钉死的形状：
 *   组字增长帧（comp=1 全量串替换）×N → 撤稿帧（comp=0 整串被啃短）。
 *
 * 钉用户可见结果：撤稿后真源必须回到**会话峰值**（口述内容不丢），
 *   且飞行日志留 gate:withdraw 痕迹。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

const textLen = (page) =>
  page.evaluate(() => {
    const d = window.__NOTESYNC_DOC__();
    let n = 0;
    const walk = (bs) => {
      for (const b of bs ?? []) {
        if (Array.isArray(b.spans)) for (const s of b.spans) n += s.t.length;
        if (Array.isArray(b.title)) for (const s of b.title) n += s.t.length;
        if (typeof b.text === 'string') n += b.text.length;
        if (b.children) walk(b.children);
      }
    };
    walk(d.blocks);
    return n;
  });

test('WD-E2E-01 🔴 撤稿帧啃短真源 ⇒ 守卫回写会话峰值（口述内容不丢）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde01', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 组字会话：增长帧 10→100（每帧 +10）→ 108（补一帧到峰值）
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    const peak = await textLen(page);
    assert.equal(peak, 108, `会话峰值应为 108，实得 ${peak}`);

    // 撤稿帧：comp=0 替换到 13（v3.0.13 真机形状：整段口述被宿主撤掉只剩开头）
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));

    // 守卫必须把真源救回峰值
    await withTimeout(
      page.waitForFunction(
        (want) => {
          const d = window.__NOTESYNC_DOC__();
          let n = 0;
          const walk = (bs) => {
            for (const b of bs ?? []) {
              if (Array.isArray(b.spans)) for (const s of b.spans) n += s.t.length;
              if (Array.isArray(b.title)) for (const s of b.title) n += s.t.length;
              if (typeof b.text === 'string') n += b.text.length;
              if (b.children) walk(b.children);
            }
          };
          walk(d.blocks);
          return n === want;
        },
        108,
        { timeout: 5000 },
      ),
      5000,
      '撤稿后守卫必须把真源回写到会话峰值 108',
    );

    // 飞行痕迹：撤稿判定必须留痕（全程计数不随 ring 滚动）
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('gate:withdraw'), '飞行日志应含 gate:withdraw');
    assert.ok(/wd=1/.test(flight.split('\n')[0]), '表头全程计数应含 wd=1');
  } finally {
    await page.close();
  }
});

test('WD-E2E-02 🔴 容差内收尾不回写（撤稿守卫不得对抗正常收尾）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde02', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      // 收尾掉 1 字（远小于 max(12, 15)）：必须保留，不得回写
      t.withdrawTo(99);
    });
    await page.waitForTimeout(400);
    const len = await textLen(page);
    assert.equal(len, 99, `容差内收尾必须保留当前长度 99（不回写峰值 100），实得 ${len}`);
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(!flight.includes('gate:withdraw'), '容差内不得出现 gate:withdraw');
  } finally {
    await page.close();
  }
});

// 🔴🔴🔴 v3.0.15：「模型先落账、树延迟同步」。
//   v3.0.14 真机日志（第二份）钉死：撤稿判定后浏览器侧组字常常还活着
//   （synthed=0、comp=1 每帧都来），立即 docToLexical 重建杀死组字锚点 ⇒
//   后续组字帧全部模型空转（upd len=9 d=0 冻结、组字串 d=77→93 增长 3.5s+），
//   用户继续口述一个字都进不了文档。
//   ⚠️ 合成环境的边界（记档）：真机上「锚点死后组字帧空转」是 Android 宿主
//   僵尸组字专属——合成钩子每次 growTo 都会经合成 compositionstart 重新建立
//   组字态，复现不了空转本身。所以这里钉的是**机制不变量**：
//   撤稿后 600ms 内必须不重建（defer→cancel），超时才允许重建（defer→sync）。
//   ⚠️🔴 形状纪律（探针实测）：growTo 序列与 withdrawTo **必须分两次 evaluate**——
//   同一次 evaluate 里同步连发会被 Lexical 合并 flush，`upd len=108` 的峰值帧
//   推迟到 comp=0 之后才到，水位线会话在峰值帧上以「无掉幅」收场，
//   撤稿帧到达时已无会话可判（wd=0，判据整体空转）。真机豆包逐帧间隔
//   ~40ms，update 帧实时跟随，不存在这个合并；分两次 evaluate + 中间隔一拍
//   正是模拟真机逐帧节奏（WD-E2E-01 同款形状）。
test('WD-E2E-03 🔴 撤稿后组字恢复 ⇒ 树同步取消（绝不重建杀锚点，文档追上组字串）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde03', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 组字会话增长到峰值 108（与撤稿帧分开 evaluate——见上方形状纪律）
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    await page.waitForFunction(() => window.__NOTESYNC_DOC__() && JSON.stringify(window.__NOTESYNC_DOC__()).includes('x'.repeat(20)), null, { timeout: 5000 });
    // 撤稿帧：comp=0 整串被啃到 13
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));
    // 撤稿必须只落账模型、延迟树同步（wd:defer），绝不立即重建
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:defer'),
      null,
      { timeout: 5000 },
    );
    const flight1 = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight1.includes('gate:withdraw'), '撤稿判定必须留痕');
    assert.ok(!/gate:withdraw[\s\S]*upd len=108/.test(flight1), '撤稿后不得立即重建树（gate:withdraw 之后不得出现 len=108 的 upd 帧）');

    // 组字恢复（comp=1 全量替换到 150）⇒ 解冻＋推迟重建（wd:hold），文档追上组字串
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.growTo(150));
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen() === 150,
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(1600); // 超过 1200ms 窗口：组字态还挂着 ⇒ wd:wait 顺延，重建绝不允许发生
    const flight2 = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight2.includes('wd:hold'), '组字恢复帧必须解冻＋推迟重建（wd:hold）');
    assert.ok(flight2.includes('wd:wait'), '窗口到期时组字态还活着必须顺延（wd:wait），不得重建');
    assert.ok(!flight2.includes('wd:sync'), '恢复后重建绝不允许发生（不得出现 wd:sync）');
    assert.ok(!flight2.includes('wd:cancel'), 'v3.0.17 起组字帧不再走 cancel（旧标记不得出现）');
    const tree2 = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen());
    assert.equal(tree2, 150, `树必须追上组字串 150（不得被重建的 108 覆盖），实得 ${tree2}`);
    const doc2 = await textLen(page);
    assert.equal(doc2, 150, `真源必须跟上组字串 150，实得 ${doc2}`);
  } finally {
    await page.close();
  }
});

test('WD-E2E-04 🔴 撤稿后无恢复 ⇒ 1200ms 观察窗后延迟重建（峰值内容上屏兜底）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde04', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 峰值帧（分两次 evaluate——见 WD-E2E-03 形状纪律）
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    await page.waitForFunction(() => window.__NOTESYNC_DOC__() && JSON.stringify(window.__NOTESYNC_DOC__()).includes('x'.repeat(20)), null, { timeout: 5000 });
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));
    // 不发任何 comp=1 帧（组字态已随撤稿转假）：观察窗 1200ms 到期后必须重建。
    // 🔴 900ms 时点先断言「尚未重建」——v3.0.16 的 600ms 窗口在此时点已重建
    // （先红判据），v3.0.17 的 1200ms 窗口此时尚未到期。
    await page.waitForTimeout(900);
    const flightEarly = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(!flightEarly.includes('wd:sync'), '1200ms 窗口内不得提前重建（900ms 时点 wd:sync 尚不应出现）');
    await page.waitForTimeout(800); // 累计 1700ms > 1200ms 窗口
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('wd:defer'), '撤稿后必须调度延迟树同步（wd:defer）');
    assert.ok(flight.includes('wd:sync'), '超时无恢复必须执行延迟树同步（wd:sync）');
    assert.ok(!flight.includes('wd:cancel'), '无恢复时不得出现 wd:cancel');
    const tree = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen());
    assert.equal(tree, 108, `超时重建必须把峰值内容上屏（树=108），实得 ${tree}`);
    const doc = await textLen(page);
    assert.equal(doc, 108, `真源必须保持峰值 108，实得 ${doc}`);
  } finally {
    await page.close();
  }
});

// ── v3.0.18：锚点死亡自愈 ──────────────────────────────────────────────────
//   真机 v3.0.17 日志钉死的第三阶段病灶：撤稿判定后锚点已被宿主杀死，组字帧
//   持续到达（组字串 d=196→222 增长）但写入全部空转（upd len=8 d=0 冻结）——
//   实时流断裂：用户继续口述 300 字只见 7 字，点「智能识别」才恢复。
//   自愈链：连续 4 帧空转（组字串远长于文档 + 树长不动）⇒ wd:dead 取证 ⇒
//   wd:reboot 强制结束死会话（合成 compositionend）+ 重建 peakDoc ⇒ 下一帧
//   comp=1 由孤儿分支合成新 compositionstart ⇒ 实时流自愈恢复。
//   ⚠️ 形状纪律同上：逐帧 evaluate + 节拍；stallBi 只发 4 帧——reboot 之后
//   任何新 comp=1 帧都会重开合成会话（probeComposing 断言会被污染）。
test('WD-E2E-05 🔴🔴 锚点死亡自愈：4 帧空转 ⇒ wd:reboot 结束死会话 + 重建峰值上屏', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde05', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 组字会话到峰值 108（分两次 evaluate——形状纪律）
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    await page.waitForFunction(() => window.__NOTESYNC_DOC__() && JSON.stringify(window.__NOTESYNC_DOC__()).includes('x'.repeat(20)), null, { timeout: 5000 });
    // 撤稿判定：延迟同步激活（wdFreeze=true、观察窗计时中）
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:defer'),
      null,
      { timeout: 5000 },
    );
    // 锚点死亡模拟：组字帧（组字串 200 远长于文档 13）持续到达但写入全部空转
    //   （stallBi 不动树）。逐帧节拍，第 4 帧应触发 wd:dead 取证 + wd:reboot 自愈。
    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.stallBi(200));
      await page.waitForTimeout(80);
    }
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:reboot'),
      null,
      { timeout: 5000 },
    );
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('wd:dead'), '🔴 连续 4 帧空转必须留 wd:dead 取证（len/d 形状钉死空转现场）');
    assert.ok(flight.includes('wd:reboot'), '🔴 死亡确认必须触发 wd:reboot 自愈动作');
    // 死会话结束断言：reboot 后第 4 帧的孤儿分支可能已重开合成会话（1500ms
    // 静默收口）——等组字态转假再断言（死锁的组字态永远不转假，等不到即红）。
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.probeComposing() === false,
      null,
      { timeout: 5000 },
    );
    const composing = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.probeComposing());
    assert.equal(composing, false, '🔴 死会话必须被 reboot 强制结束（组字态能转假=没有死锁）');
    const tree = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen());
    assert.equal(tree, 108, `reboot 必须把峰值内容重建上屏（树=108），实得 ${tree}`);
    const doc = await textLen(page);
    assert.equal(doc, 108, `真源必须保持峰值 108（ce 残串 commit 被 wdFreeze 挡住），实得 ${doc}`);
  } finally {
    await page.close();
  }
});

// ── v3.0.19：空转检测解耦延迟同步机制（真机 v3.0.18 尾段实锤盲区）──────────
//   v3.0.18 真机：判定帧（gate=30）在 ring 之外更早时段、1200ms 窗口到期
//   wd:sync 重建收尾（timer=null）之后锚点再死——组字帧全程空转（upd len=23
//   d=0 冻结、组字串 d=153→169 增长 8.6s+、整段 400 条无任何 wd: 帧）。
//   v3.0.18 检测挂在 timer!=null 前提下，机制收尾后永远不跑。
//   ⚠️ 静止判定（v3.0.19）：树长必须**纹丝不动**（连续帧同值）才计数——
//   撤稿后锚点活着时全量替换逐帧追（树长帧帧在变）绝不 reboot 杀活锚点。
test('WD-E2E-06 🔴🔴 机制收尾后锚点死亡：空转 4 帧必须仍触发 wd:dead＋wd:reboot（盲区闸）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde06', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 组字会话到峰值 108（分两次 evaluate——形状纪律）
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    await page.waitForFunction(() => window.__NOTESYNC_DOC__() && JSON.stringify(window.__NOTESYNC_DOC__()).includes('x'.repeat(20)), null, { timeout: 5000 });
    // 撤稿判定后**不喂任何组字帧**：1200ms 窗口到期 → wd:sync 重建 → 机制收尾
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:sync'),
      null,
      { timeout: 8000 },
    );
    await page.waitForTimeout(300); // 让 wd:sync 的重建 flush 落定（timer=null、wdFreeze=false）
    // 锚点死亡模拟（机制之外）：组字帧（串 200 远长于树 108）持续到达但树长
    //   纹丝不动。逐帧节拍，第 4 帧应触发 wd:dead + wd:reboot。
    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.stallBi(200));
      await page.waitForTimeout(80);
    }
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:reboot'),
      null,
      { timeout: 5000 },
    );
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('wd:sync'), '前置：机制必须先收尾（wd:sync 重建后 timer=null）');
    assert.ok(flight.includes('wd:dead len=108 d=200'), '🔴 机制收尾后的空转必须仍留 wd:dead 取证（盲区检测）');
    assert.ok(flight.includes('wd:reboot'), '🔴 机制收尾后的死亡确认必须仍触发 wd:reboot 自愈');
    const tree = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen());
    assert.equal(tree, 108, `reboot 必须把落账内容重建上屏（树=108），实得 ${tree}`);
    const doc = await textLen(page);
    assert.equal(doc, 108, `真源必须保持 108 不被残串覆盖，实得 ${doc}`);
  } finally {
    await page.close();
  }
});

// ── v3.1.6：reboot 不再无条作拆会话＋knock-back 懒重连＋冷却期 ──────────────
//   用户真机日志（2026-10-12 v3.1.5）钉死：reboot 里的无条件 blur/focus 会
//   拆掉 Android 输入法连接 ⇒ 豆包识别会话当场死（用户没点停止键也被掐断，
//   之后的话一句都进不来）。blur 本是 v3.0.20 为修「重建后组字帧按宿主旧
//   视图把树打回残串」的震荡加的——代价现在被量化。新语义：
//     ① reboot 只做 ce＋重建，**不 blur**（给会话一次自愈机会）；
//     ② 重建后组字帧真把树打回（knock-back ⇒ 视图确实没对齐）才补 blur/focus；
//     ③ 冷却期语义不变（防震荡风暴）。
test('WD-E2E-07 🔴🔴 reboot 本身不得 blur（拆会话＝掐断用户语音）；knock-back 才懒重连＋冷却期', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde07', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 🔴 blur/focus 计数器挂在 editorHost 上（真机宿主=Android InputConnection，
    //   桌面等价物=contenteditable 焦点变化——DOM 事件真实派发才可断言）
    await page.evaluate(() => {
      window.__nsBlurCount = 0;
      window.__nsFocusCount = 0;
      const host = document.getElementById('editor-host');
      host.addEventListener('blur', () => { window.__nsBlurCount += 1; });
      host.addEventListener('focus', () => { window.__nsFocusCount += 1; });
    });
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    await page.waitForFunction(() => window.__NOTESYNC_DOC__() && JSON.stringify(window.__NOTESYNC_DOC__()).includes('x'.repeat(20)), null, { timeout: 5000 });
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));
    // 等机制收尾（wd:sync、timer=null）——WD-E2E-06 同款前置
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:sync'),
      null,
      { timeout: 8000 },
    );
    await page.waitForTimeout(300);
    // 第一组空转 4 帧 → wd:dead → wd:reboot（v3.1.6：只 ce＋重建，**不 blur**）
    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.stallBi(200));
      await page.waitForTimeout(80);
    }
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:reboot reconn'),
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(200);
    const counts1 = await page.evaluate(() => ({ blur: window.__nsBlurCount, focus: window.__nsFocusCount }));
    assert.equal(counts1.blur, 0,
      '🔴🔴 reboot 本身不得 blur——blur 拆掉输入法连接＝掐断用户语音（真机实锤）');
    assert.equal(counts1.focus, 0, 'reboot 本身不得 focus（与 blur 同一条连接）');
    assert.equal(
      await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen()),
      108,
      'reboot 仍必须把峰值重建上屏（树=108）',
    );

    // knock-back 帧：reboot 重建后组字帧真把树打回（宿主旧视图没对齐的形状）
    //   ⇒ 塌方守卫再拦截 + 必须补懒重连（blur/focus）
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.collapseMismatch(14, 200));
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:reconnect'),
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(200); // blur 同步派发；focus 在 +50ms
    const counts2 = await page.evaluate(() => ({ blur: window.__nsBlurCount, focus: window.__nsFocusCount }));
    assert.ok(counts2.blur >= 1 && counts2.focus >= 1,
      `🔴 knock-back 实锤后必须补 blur/focus 重连，实得 blur=${counts2.blur} focus=${counts2.focus}`);

    // 冷却期：knock-back 之后再 4 帧空转 ⇒ 第二次 reboot 必须被冷却拦下。
    //   （此时树停在 knock-back 的 14、真源仍是峰值 108——重建要等下一次
    //     成功 reboot，故这里只断言真源不丢，不断言树长。）
    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.stallBi(200));
      await page.waitForTimeout(80);
    }
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('skip cooldown'),
      null,
      { timeout: 5000 },
    );
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('wd:reboot reconn'), '首次死亡确认必须 reboot＋重建');
    assert.ok(flight.includes('wd:reboot skip cooldown'), '🔴 冷却期内的死亡确认必须拦下 reboot（防震荡风暴）');
    assert.equal(await textLen(page), 108, 'knock-back 后真源必须保持峰值 108 不被残串覆盖');
  } finally {
    await page.close();
  }
});

// ── v3.1.7：wd:sync skip 判据改为「树长 >= 会话峰值」（手动打字例外）──────────
//   真机 v3.1.6 日志（18:55 那份）钉死旧判据「树长 > 基线就 skip」的坑：
//   knock-back＋懒重连后，blur 取消组字把当前串 commit 进树，残串从 11 涨到
//   13——13 > 11 命中 skip ⇒ 峰值 21 永远上不了屏；更严重的是冻结解除后模型
//   被 13 字残串覆盖并 push 上行＝内容真丢。树没涨过会话峰值＝屏幕上还不是
//   最完整的内容，必须按模型（峰值）重建。唯一例外：窗口内用户手动敲的字
//   （v3.0.17 立的最新中国意图规矩），绝不能重建抹掉。
test('WD-E2E-08 🔴🔴 残串涨过基线但没过峰值必须重建上屏；手动打字是唯一 skip 例外', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde08', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    await page.waitForFunction(() => window.__NOTESYNC_DOC__() && JSON.stringify(window.__NOTESYNC_DOC__()).includes('x'.repeat(20)), null, { timeout: 5000 });

    // ── 第一相：非组字通道把树抬起（超过基线 13、低于峰值 108）⇒ 必须重建 ──
    //   collapse() 探针是纯 ed.update（无 beforeinput）——等价于真机上 blur
    //   取消组字时浏览器把当前串 commit 进树的那条通道（不置手动标志）。
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:defer peak=108'),
      null,
      { timeout: 5000 },
    );
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.end()); // ce ⇒ 组字态转假（不再重摆观察窗）
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.collapse('x'.repeat(20)));
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen() === 20,
      null,
      { timeout: 5000 },
    );
    // 等 1200ms 观察窗到期：旧判据 20 > 13 ⇒ skip（峰值上不了屏，红）；
    // 新判据 20 < 108 且非手动 ⇒ 按模型重建（绿）
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:sync'),
      null,
      { timeout: 5000 },
    );
    const flight1 = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(!flight1.includes('wd:sync skip'),
      '🔴🔴 树长没过会话峰值时不得 skip——残串涨过基线只是部分落地，峰值才是最完整内容');
    assert.equal(
      await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen()),
      108,
      '到期必须把峰值 108 重建上屏（旧判据在此 skip，屏幕停在 20）',
    );
    assert.equal(await textLen(page), 108, '真源保持峰值 108');
  } finally {
    await page.close();
  }
});

test('WD-E2E-09 🔴 窗口内用户手动打字 ⇒ wd:sync 必须 skip（手敲是最新意图，不许重建抹掉）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'wde09', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    await page.evaluate(() => {
      const t = window.__NOTESYNC_COMPOSE_TEST__;
      for (let n = 10; n <= 100; n += 10) t.growTo(n);
      t.growTo(108);
    });
    await page.waitForFunction(() => window.__NOTESYNC_DOC__() && JSON.stringify(window.__NOTESYNC_DOC__()).includes('x'.repeat(20)), null, { timeout: 5000 });
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.withdrawTo(13));
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:defer peak=108'),
      null,
      { timeout: 5000 },
    );
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.end());
    // 用户切键盘手动敲两个字（真实 CDP 管线 ⇒ beforeinput insertText comp=0）
    await page.keyboard.type('甲乙', { delay: 5 });
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen() === 15,
      null,
      { timeout: 5000 },
    );
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:sync'),
      null,
      { timeout: 5000 },
    );
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('wd:sync skip len=15'),
      '🔴 窗口内手动打字是唯一 skip 例外——手敲的字是最新意图，按峰值重建会抹掉它（v3.0.17 规矩）');
    assert.equal(
      await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen()),
      15,
      '手动敲的字必须留在树上（不得被峰值重建覆盖）',
    );
  } finally {
    await page.close();
  }
});

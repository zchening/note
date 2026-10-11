/**
 * e2e：跨段组字串塌方守卫（COMPOSE-E2E 系列，v3.0.10）
 *
 * 🔴🔴🔴 为什么必须是 e2e（判据纪律：至少一条从最外层真实入口进）：
 *   单元判据钉的是 decideCollapseRestore / ComposeGuard 本身；而守卫真正生效的
 *   形状是「编辑器里真实 update 监听 → 检测到塌方 → 把真源回退 + 重建树」。
 *   桌面无法复现 Android InputConnection 的原生塌方，这条用真实 compositionstart
 *   事件 + 真实 ed.update 塌方，戳进**同一个 update 监听**，验证守卫确实把真源
 *   从损坏态救回，且飞行记录器留下 gate:collapse / cmp:start 痕迹。
 *
 *   判据钉用户可见的最终产物：__NOTESYNC_DOC__ 的长度必须恢复回塌方前的字数，
 *   且飞行日志含 gate:collapse。恢复态绿 + 变异态（下面注释掉的对照）红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });

test('COMPOSE-E2E-01 🔴 合成中单帧塌方必须被守卫救回真源', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'cmp01', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 敲两段正文（跨块），每段 72 字、共 144 字 —— 贴近"整篇笔记"场景，且越过守卫阈值
    const base = '笔记内容测试文本';
    const part1 = base.repeat(12);
    const part2 = base.repeat(12);
    await page.keyboard.type(part1, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.keyboard.type(part2, { delay: 5 });

    const typedLen = await page.evaluate(() => {
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
    assert.ok(typedLen >= 110, `塌方前正文应 >=110 字，实得 ${typedLen}`);

    // 全选（让 compositionstart 时选区跨块 ⇒ multiBlock=true，走主判据路径）
    await page.keyboard.press('Control+A');
    // 触发真实 compositionstart（喂守卫 active + 算 multiBlock）
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.start());
    assert.equal(await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.guardActive()), true);

    // 真实 ed.update 塌方：把整篇替换成 19 字短串（模拟 Lexical 原生合成回灌吞字）
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.collapse('被吞后的短文本'));

    // 守卫应在 update 监听里把真源回退到塌方前的字数
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
          return n >= want - 2;
        },
        typedLen,
        { timeout: 5000 },
      ),
      5000,
      '守卫必须把真源从塌方态救回原字数',
    );

    const recoveredLen = await page.evaluate(() => {
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
    assert.ok(recoveredLen >= typedLen - 2, `救回字数应≈塌方前（${typedLen}），实得 ${recoveredLen}`);

    // 飞行记录器必须留下塌方守卫痕迹
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('gate:collapse'), '飞行日志应含 gate:collapse');
    assert.ok(flight.includes('cmp:start'), '飞行日志应含 cmp:start（合成起止已喂守卫）');

    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.end());
  } finally {
    await page.close();
  }
});

test('COMPOSE-E2E-02 🔴🔴 回归：无 compositionstart、仅 insertCompositionText 塌方也必须被守卫救回', async () => {
  // v3.0.10 漏拦真因：豆包智能整理只发 insertCompositionText、不发 compositionstart，
  // 守卫从不激活。这条用 collapseNoStart 钩子模拟该真实入口（含 isComposing=true 的
  // beforeinput，但绝不发 compositionstart），验证守卫即便没收到 compositionstart 也能兜住塌方。
  const page = await openEditor(h.browser(), h.baseUrl(), 'cmp02', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    const base = '笔记内容测试文本';
    const part1 = base.repeat(12);
    const part2 = base.repeat(12);
    await page.keyboard.type(part1, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.keyboard.type(part2, { delay: 5 });

    const typedLen = await page.evaluate(() => {
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
    assert.ok(typedLen >= 110, `塌方前正文应 >=110 字，实得 ${typedLen}`);

    // 全选（让 beforeinput 时选区跨块 ⇒ multiBlock=true），但**绝不发 compositionstart**
    await page.keyboard.press('Control+A');
    assert.equal(
      await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.guardActive()),
      false,
      '未发 compositionstart 时守卫应处于未激活（v3.0.10 正因此漏拦）',
    );

    // 模拟豆包智能整理：仅 insertCompositionText（isComposing=true），不发 compositionstart
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.collapseNoStart('被吞后的短文本'));

    // 守卫应在 update 监听里把真源回退到塌方前的字数（即便从未 compositionstart）
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
          return n >= want - 2;
        },
        typedLen,
        { timeout: 5000 },
      ),
      5000,
      '守卫(无compositionstart)必须把真源从塌方态救回原字数',
    );

    const recoveredLen = await page.evaluate(() => {
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
    assert.ok(recoveredLen >= typedLen - 2, `救回字数应≈塌方前（${typedLen}），实得 ${recoveredLen}`);

    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('gate:collapse'), '飞行日志应含 gate:collapse（v3.0.11 起守卫改由 isComposing 驱动，无真实 compositionstart 也触发）');
    // v3.0.12 起：collapseNoStart 的 isComposing 输入会被①识别并合成 compositionstart（治本路径），
    // 所以本场景现在**应当**含 cmp:synthed —— 这正是①在补豆包"只发 insertCompositionText 不发 compositionstart"的缺口。
    // 断言它出现，证明①与守卫协同：①补 compositionstart、守卫兜底塌方，两者不互斥。
    assert.ok(flight.includes('cmp:synthed'), 'collapseNoStart 的 isComposing 输入应被①识别并合成 compositionstart（cmp:synthed）');
  } finally {
    await page.close();
  }
});

// 🔴🔴🔴 v3.0.16：「模型先落账、树延迟同步」扩展到 collapse 路径。
//   v3.0.15 真机日志（两份）钉死：撤稿/塌方判定后浏览器侧组字常常还活着
//   （synthed=0、comp=1 每帧都到），立即 docToLexical 重建杀死组字锚点 ⇒
//   后续组字帧全部模型空转（upd len=9/5 d=0 冻结、组字串 d=218→279 增长
//   6.4s+）。v3.0.15 只修了 wd 路径——真机 gate=24/25 = collapse 17 + wd 7/8，
//   **collapse 路径的 17 次立即重建仍在杀锚点**（豆包重识别修订的大幅掉幅帧
//   comp=1 走 collapse、此时组字活着）。v3.0.16 把 collapse restore 也改成
//   延迟同步（defer/cancel/sync 同一套机制）。
//   ⚠️ 形状纪律（v3.0.15 记档同样适用）：塌方帧与恢复帧分两次 evaluate——
//   同一次 evaluate 同步连发会被 Lexical 合并 flush，判定/取消时序错乱。
test('COMPOSE-E2E-03 🔴🔴 塌方后组字恢复 ⇒ 树同步取消（绝不重建杀锚点，文档追上组字串）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'cmp03', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    // 两段正文共 144 字（越过守卫阈值），与 E2E-01 同款
    const base = '笔记内容测试文本';
    const part1 = base.repeat(12);
    const part2 = base.repeat(12);
    await page.keyboard.type(part1, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.keyboard.type(part2, { delay: 5 });

    // 全选 + 真实 compositionstart（喂守卫 active）
    await page.keyboard.press('Control+A');
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.start());

    // 塌方帧（分两次 evaluate——形状纪律）：真实 ed.update 塌方
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.collapse('被吞后的短文本'));

    // v3.0.16：塌方必须只落账模型、延迟树同步（wd:defer），绝不立即重建
    await page.waitForFunction(
      () => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n').includes('wd:defer'),
      null,
      { timeout: 5000 },
    );
    const flight1 = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight1.includes('gate:collapse'), '塌方判定必须留痕');
    assert.ok(!/gate:collapse[\s\S]*upd len=144/.test(flight1), '塌方后不得立即重建树（gate:collapse 之后不得出现 len=144 的重建 upd 帧）');

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
    assert.equal(tree2, 150, `树必须追上组字串 150（不得被重建的 144 覆盖），实得 ${tree2}`);
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.end());
  } finally {
    await page.close();
  }
});

test('COMPOSE-E2E-04 🔴🔴 塌方后无恢复 ⇒ 1200ms 观察窗后延迟重建（塌方前内容上屏兜底）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'cmp04', 'pw');
  try {
    await page.evaluate(() => localStorage.removeItem('notesync_bj_flight'));
    await page.click('.ns-editor');
    const base = '笔记内容测试文本';
    const part1 = base.repeat(12);
    const part2 = base.repeat(12);
    await page.keyboard.type(part1, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.keyboard.type(part2, { delay: 5 });

    await page.keyboard.press('Control+A');
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.start());

    // 塌方帧，随后组字死亡（end = compositionend，与真机撤稿 comp=0 同语义）：
    // 不发任何 comp=1 恢复帧，1200ms 窗口到期后必须重建。
    // 🔴 900ms 时点先断言「尚未重建」——v3.0.16 的 600ms 窗口在此时点已重建
    //（先红判据），v3.0.17 的 1200ms 窗口此时尚未到期。
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.collapse('被吞后的短文本'));
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.end());

    await page.waitForTimeout(900);
    const flightEarly = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(!flightEarly.includes('wd:sync'), '1200ms 窗口内不得提前重建（900ms 时点 wd:sync 尚不应出现）');
    await page.waitForTimeout(800); // 累计 1700ms > 1200ms 窗口
    const flight = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.flightLines().join('\n'));
    assert.ok(flight.includes('wd:defer'), '塌方后必须调度延迟树同步（wd:defer）');
    assert.ok(flight.includes('wd:sync'), '超时无恢复必须执行延迟树同步（wd:sync）');
    assert.ok(!flight.includes('wd:hold'), '无恢复时不得出现 wd:hold');
    const tree = await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.treeTextLen());
    assert.ok(tree >= 142, `超时重建必须把塌方前内容上屏（树≈144），实得 ${tree}`);
    await page.evaluate(() => window.__NOTESYNC_COMPOSE_TEST__.end());
  } finally {
    await page.close();
  }
});

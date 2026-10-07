/**
 * Bug3/Bug4 的真浏览器回归闸（2026-10-08 用户报障）
 *
 * 🔴 Bug4：抽卡彩蛋的 JS（egg/draw.ts）移植了、CSS 一条没移植 ⇒ 卡片以裸文本
 *   渲染在 body 末尾（用户看到"UR / 一句话 / NOTE SYNC"三行裸字）。
 *   本文件用真浏览器 getComputedStyle 验证卡片样式真的命中 ——
 *   按 replication-discipline §4：**判 CSS 补丁是否生效必须读 computed style**，
 *   正则匹配 CSS 字符串在 specificity 算错时恒绿。
 *
 * 🔴 Bug3：免口令直出码路径必须对齐老项目 preKey 形态（index.html:9131-9136）——
 *   按钮**整排不可见**、进度写出码区文字行；bj 此前 go/cancel 留在屏上且 go 文案
 *   变成「正在写入备份…」，用户报障「这个界面不应该出现」。
 *
 * 路径纪律：走真实用户路径（落地页 → 口令页 → 编辑器），不直接 goto。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');
const h = installHarness(test, { dir: WWW });
const PASS = 'pw';

test('EGGDRAW-01 🔴 刷新抽卡：卡片必须带完整样式（computedStyle 实读，Bug4）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'eggdraw1', PASS);
  try {
    // 塞一张 R 券（drawRoll 的落袋形态 {t,i}，key 见 egg/draw.ts EGG_DRAW_KEY），
    // 然后走**真实触发器**——点刷新（roll + location.reload）
    await page.evaluate(() => sessionStorage.setItem('notesync_bj_draw', JSON.stringify({ t: 'r', i: 0 })));
    await page.click('#refreshBtn');
    // 🔴 重载后路由按「本机已记住口令 → editor」可能**直接进编辑器**，不经过落地页；
    //   走不到时才补一遍落地页 + 口令流程。
    try {
      await withTimeout(
        page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 8000 }),
        10000, '等重载后编辑器直挂',
      );
    } catch {
      await page.waitForSelector('#li', { timeout: 20_000 });
      await page.fill('#li', 'eggdraw1');
      await page.click('#landingBtn');
      await page.waitForSelector('#pw', { timeout: 20_000 });
      await page.fill('#pw', PASS);
      await page.click('#ok');
      await page.waitForFunction(() => !!window.__NOTESYNC_EDITOR__, { timeout: 20_000 });
    }
    await page.waitForSelector('#eggDraw', { timeout: 5_000 });

    const card = await page.evaluate(() => {
      const el = document.getElementById('eggDraw');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        position: cs.position,
        bottom: cs.bottom,
        borderRadius: cs.borderRadius,
        zIndex: cs.zIndex,
        cls: el.className,
        rar: el.querySelector('.dw-rar')?.textContent ?? null,
        tx: el.querySelector('.dw-tx')?.textContent ?? '',
        ft: el.querySelector('.dw-ft')?.textContent ?? null,
        txColor: getComputedStyle(el.querySelector('.dw-tx')).color,
      };
    });
    assert.ok(card, '#eggDraw 应存在');
    // 🔴 样式命中的铁证：裸文本不可能是 fixed 定位 + 圆角卡片
    assert.equal(card.position, 'fixed', 'position:fixed（老项目 #nsDraw 同款）');
    assert.equal(card.borderRadius, '18px', '卡片圆角 18px');
    assert.equal(card.zIndex, '59', 'z-index 59（底部浮层泳道）');
    // 🔴 档位与内容逐位咬合：点刷新是 roll() 真抽奖（会覆盖预置券），档位随机，
    //   所以只断「角标 = 卡片自身档位大写」，随机性不影响样式判据。
    assert.match(card.cls, /^(r|sr|ssr|ur)$/, `档位类名合法，实际=${card.cls}`);
    assert.equal(card.rar, card.cls.toUpperCase(), '等级角标必须等于档位大写');
    assert.ok(card.tx.length > 0, '文案非空');
    assert.equal(card.ft, 'NOTE SYNC', '页脚品牌 NOTE SYNC');
    // 🔴 点一下收（非 UR 档点收；UR hold=0 也只能点收）
    await page.click('#eggDraw');
    await withTimeout(
      page.waitForFunction(() => document.getElementById('eggDraw') === null, { timeout: 3000 }),
      4000, '等卡片收起移除',
    );
  } finally {
    await page.close();
  }
});

test('MIG-01 🔴🔴 扫码换机免口令直出：按钮整排不可见、进度在出码区文字行（Bug3）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'mig01', PASS);
  try {
    // 🔴 收藏夹为空时 precheck 会拦（「收藏夹里还没有收藏…」——这是正确行为），
    //   所以先走真实路径收藏本篇，再点扫码换机。
    await page.click('#menuBtn');
    await page.waitForSelector('#menuMainView', { timeout: 5000 });
    await page.click('#menuFav');
    // toggle 后菜单会 render()；若菜单被关了就重开
    const menuOpen = await page.evaluate(() => !document.getElementById('menuMask')?.classList.contains('hidden'));
    if (!menuOpen) {
      await page.click('#menuBtn');
      await page.waitForSelector('#menuMainView', { timeout: 5000 });
    }
    await page.click('#menuBackup');
    await page.waitForSelector('#migrateMask', { timeout: 5000 });

    // 🔴 直出期间：按钮整排不可见（老项目 bakShowStage(2) 口径）
    const during = await page.evaluate(() => ({
      go: document.getElementById('migrateGo')?.className ?? null,
      cancel: document.getElementById('migrateCancel')?.className ?? null,
      pass: document.getElementById('migratePassWrap')?.className ?? null,
      tip: document.getElementById('migrateTip')?.textContent ?? null,
    }));
    assert.ok(during.go.includes('hidden'), `go 按钮必须不可见，实际=${during.go}`);
    assert.ok(during.cancel.includes('hidden'), `cancel 必须不可见，实际=${during.cancel}`);
    assert.ok(during.pass.includes('hidden'), `口令框必须不可见（免口令直出），实际=${during.pass}`);
    assert.ok(
      during.tip === '正在写入备份…' || (during.tip ?? '').includes('一键恢复'),
      `进度文案应在出码区文字行，实际=${JSON.stringify(during.tip)}`,
    );
    // 出码完成：QR 画布出现，提示行换成指引（不再是"正在写入"）
    await page.waitForSelector('#migrateQrHolder canvas', { timeout: 30_000 });
    const after = await page.evaluate(() => ({
      tip: document.getElementById('migrateTip')?.textContent ?? '',
      go: document.getElementById('migrateGo')?.className ?? null,
    }));
    assert.ok(after.tip.includes('一键恢复'), `出码后应是恢复指引，实际=${JSON.stringify(after.tip)}`);
    assert.ok(!after.tip.includes('正在写入'), '进度文案必须被覆写');
    assert.ok(after.go.includes('hidden'), 'go 按钮出码后仍不可见');
  } finally {
    await page.close();
  }
});

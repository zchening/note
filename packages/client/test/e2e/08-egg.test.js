/**
 * e2e：彩蛋层全链路（EGG-E 系列）—— 真浏览器
 *
 * 🔴 本文件要验的不是"能打开一个游戏"，而是四件极易静默出错的事：
 *   1. **门牌不进编辑器** —— 老项目口径：彩蛋门牌是保留字，不新建笔记。
 *      判据走 `__NOTESYNC_PAGE__`，不是"看起来打开了"。
 *   2. **落地页要提前告知** —— 输入 snake 时按钮变「打开彩蛋」并给出
 *      「snake 是彩蛋门牌，不会新建笔记」。少了这句，用户以为要点一次新建笔记。
 *   3. **退出要真拆干净** —— `.ns-game` 消失、rAF 停、无 pageerror。
 *      🔴 这条**实测抓到一个真缺陷**：门牌路径进游戏退出后页面一片空白
 *      （落地页从未渲染，`currentPage` 停在 egg没人重画）。修法见 shell.ts的
 *      ShellHooks.onClosed —— 所以这条判据是回归钉，不是凑数。
 *   4. **图鉴只暴露已发现的** —— 未发现显示 ??? 且**不挂 role=button**
 *      （挂了就是个点了没反应的按钮，对读屏用户是明确的坏体验）。
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
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

const PASS = '测试口令';

/** 门牌总数与图鉴行数必须一致（注册表推导值，不是手写常量）。 */
const EGG_TOTAL = 17;

/** 开一个干净页面并挂异常收集。 */
async function freshPage(browser, noteName) {
  const page = await openEditor(browser, h.baseUrl(), noteName, PASS);
  const errs = [];
  const cerrs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') cerrs.push(m.text());
  });
  return { page, errs, cerrs };
}

test('EGG-E 彩蛋层全链路', async (t) => {
  const browser = h.browser();

  await t.test('EGG-E01 落地页输入门牌给的是「打开彩蛋」而不是「打开」', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(h.baseUrl());
      await withTimeout(page.waitForSelector('#li'), 20_000, '等落地页');

      await page.fill('#li', 'snake');
      const btn = (await page.textContent('#landingBtn'))?.trim();
      assert.equal(btn, '打开彩蛋', '门牌时按钮文案应为「打开彩蛋」');
      assert.equal(await page.isDisabled('#landingBtn'), false, '门牌不禁用按钮（点了是去彩蛋）');

      const tip = (await page.textContent('#landingEggTip'))?.trim();
      assert.equal(tip, 'snake 是彩蛋门牌，不会新建笔记');

      // 普通笔记名仍走普通文案
      await page.fill('#li', 'plainNote');
      const btn2 = (await page.textContent('#landingBtn'))?.trim();
      assert.equal(btn2, '打开', '普通笔记名应为「打开」');
      assert.equal((await page.textContent('#landingEggTip'))?.trim(), '', '普通笔记不该有门牌提示');
    } finally {
      await page.close();
    }
  });

  await t.test('EGG-E02 门牌路径不进编辑器', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(h.baseUrl() + 'snake');
      await withTimeout(page.waitForSelector('.ns-game'), 20_000, '等游戏外壳');

      const p = await page.evaluate(() => window.__NOTESYNC_PAGE__());
      assert.equal(p, 'egg', `门牌路径的页面态应为 egg，实得 ${p}`);
      //🔴 编辑器钩子不该存在：门牌不是笔记
      const hasEditor = await page.evaluate(() => !!window.__NOTESYNC_EDITOR__);
      assert.equal(hasEditor, false, '门牌路径不该挂编辑器');
      const doc = await page.evaluate(() => {
        const f = window.__NOTESYNC_DOC__;
        return typeof f === 'function' ? 'HAS_DOC_HOOK' : 'NO_DOC_HOOK';
      });
      assert.equal(doc, 'NO_DOC_HOOK', '门牌路径不该建真源');
    } finally {
      await page.close();
    }
  });

  await t.test('EGG-E03 正式钩子能进游戏且三件套齐全', async () => {
    const { page } = await freshPage(browser, 'eggE03');
    try {
      const ok = await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('snake'));
      assert.equal(ok, true, '__NOTESYNC_EGG_OPEN__ 应返回 true');

      await withTimeout(page.waitForSelector('.ns-game'), 10_000, '等游戏外壳');
      assert.ok(await page.$('.ns-hud'), 'HUD 缺失');
      assert.ok(await page.$('.ns-stage'), '舞台缺失');
      const cv = await page.$('#nsCv');
      assert.ok(cv, 'canvas 缺失');
      // canvas 必须真的有绘制尺寸，否则"游戏打开了但一片空白"
      const box = await cv.boundingBox();
      assert.ok(box && box.width > 50 && box.height > 50, `canvas 尺寸异常：${JSON.stringify(box)}`);
    } finally {
      await page.close();
    }
  });

  await t.test('EGG-E04 HUD 显示门牌名/ 退出键 / 分数 0', async () => {
    const { page } = await freshPage(browser, 'eggE04');
    try {
      await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('snake'));
      await withTimeout(page.waitForSelector('.ns-game'), 10_000, '等游戏外壳');

      const gate = (await page.textContent('.ns-gate'))?.trim();
      assert.equal(gate, '/snake', `HUD 应显示门牌 /snake，实得 ${gate}`);
      const exit = (await page.textContent('.ns-x'))?.trim();
      assert.match(exit ?? '', /退出/, `退出键应有「退出」文案，实得 ${exit}`);
      const score = (await page.textContent('.ns-sc'))?.trim();
      assert.equal(score, '0', '开局分数应为 0');
    } finally {
      await page.close();
    }
  });

  await t.test('EGG-E05 图鉴 17 行、未发现显示 ??? 且不可点', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(h.baseUrl() + '?eggs');
      await withTimeout(page.waitForSelector('#eggMask:not(.hidden)'), 20_000, '等图鉴打开');

      const rows = await page.$$('#eggList .egg-row');
      assert.equal(rows.length, EGG_TOTAL, `图鉴应有 ${EGG_TOTAL} 行，实得 ${rows.length}`);

      const count = (await page.textContent('#eggCount'))?.trim();
      assert.match(count ?? '', new RegExp(`\\d+ / ${EGG_TOTAL} FOUND`), `计数格式不对：${count}`);

      // 未发现的行：名字 ???、提示「还没被发现」、且不挂 role=button
      const locked = await page.$$('#eggList .egg-row.locked');
      assert.ok(locked.length > 0, '初始应至少有几条未发现（badge 之类可能已命中，故只判 >0）');
      const first = locked[0];
      const name = (await first.$eval('.egg-name', (e) => e.textContent))?.trim();
      const hint = (await first.$eval('.egg-hint', (e) => e.textContent))?.trim();
      assert.equal(name, '???');
      assert.equal(hint, '还没被发现');
      const role = await first.getAttribute('role');
      assert.equal(role, null, '未发现的行不该挂 role=button（挂了就是点了没反应的按钮）');
    } finally {
      await page.close();
    }
  });

  await t.test('EGG-E06 进过的游戏在图鉴里可点重玩', async () => {
    const { page } = await freshPage(browser, 'eggE06');
    try {
      await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('snake'));
      await withTimeout(page.waitForSelector('.ns-game'), 10_000, '等游戏');
      // 退出后再开图鉴
      await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('snake')); //幂等，不该报错
      await page.keyboard.press('Escape');
      await withTimeout(page.waitForFunction(() => !document.querySelector('.ns-game'), { timeout: 8000 }), 12_000, '等游戏关闭');

      await page.evaluate(() => {
        window.location.href = '/?eggs';
      });
      await withTimeout(page.waitForSelector('#eggMask:not(.hidden)'), 20_000, '等图鉴');

      const row = await page.$('#eggList .egg-row[data-egg="snake"]');
      assert.ok(row, '图鉴应有 snake 行');
      const cls = await row.getAttribute('class');
      assert.ok(!(cls ?? '').includes('locked'), '玩过一次后 snake 不该仍是 locked');
      const name = (await row.$eval('.egg-name', (e) => e.textContent))?.trim();
      assert.ok(name && name !== '???', `已发现的 snake 应显示真名，实得 ${name}`);
      assert.equal(await row.getAttribute('role'), 'button', '已发现且可复现的行应挂 role=button');

      const count = (await page.textContent('#eggCount'))?.trim();
      assert.match(count ?? '', new RegExp(`^[1-9]\\d* / ${EGG_TOTAL} FOUND`), `玩过一次后分子应 ≥1，实得 ${count}`);
    } finally {
      await page.close();
    }
  });

  await t.test('EGG-E07 退出游戏后外壳彻底拆干净（回归钉）', async () => {
    // 🔴🔴 这条判据抓到过一个真缺陷：门牌路径进游戏退出后整页空白
    //   （落地页从未被渲染，currentPage 停在 egg 没人重画）。
    //   修法：shell.close() 在历史还原后回调 ShellHooks.onClosed，
    //   由 main.ts 重画落地页并把地址栏拉回 '/'。
    const page = await browser.newPage();
    try {
      await page.goto(h.baseUrl() + 'snake');
      await withTimeout(page.waitForSelector('.ns-game'), 20_000, '等游戏');
      await page.click('.ns-x');
      await withTimeout(page.waitForFunction(() => !document.querySelector('.ns-game'), { timeout: 8000 }), 12_000, '等游戏关闭');

      // 🔴 退出后必须看得见落地页，且输入框可聚焦
      await withTimeout(page.waitForSelector('#li'), 10_000, '退出后应回落地页');
      assert.equal(await page.evaluate(() => window.__NOTESYNC_PAGE__()), 'landing');
      // 地址栏不该停在 /snake（留着就是"一刷新又被弹回游戏"的幽灵状态）
      const path = await page.evaluate(() => location.pathname);
      assert.equal(path, '/', `退出后地址栏应回 /，实得 ${path}`);
    } finally {
      await page.close();
    }
  });

  await t.test('EGG-E08 未映射门牌不挂外壳、且可见告警', async () => {
    const { page, cerrs } = await freshPage(browser, 'eggE08');
    const warns = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warns.push(m.text());
    });
    try {
      const ok = await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('nosuchegg'));
      assert.equal(ok, false, '未映射门牌应返回 false');
      // 🔴 绝不能挂一个空外壳：那就是"点了没反应、页面也不会动"
      assert.equal(await page.$('.ns-game'), null, '未映射门牌不该挂游戏外壳');
      assert.equal(await page.$('#nsGame'), null, '未映射门牌不该留空 mount');
      // 必须**可见地**告警（console.warn 带文案），否则是静默失败
      assert.ok(
        warns.some((w) => w.includes('nosuchegg')),
        `应有含 id 的告警，实得 ${JSON.stringify(warns)}`,
      );
      // 从编辑器调用时页面保持在编辑器（不清掉用户的正文）——
      // 这条判据钉住"未知门牌不许把用户踢出正在写的笔记"
      assert.equal(await page.evaluate(() => window.__NOTESYNC_PAGE__()), 'editor');
      assert.ok(await page.$('#editor-host'), '编辑器应仍在');
      assert.deepEqual(cerrs, [], `不该有 console.error：${cerrs.join(' | ')}`);
    } finally {
      await page.close();
    }
  });

  await t.test('EGG-E09 菜单桌宠走彩蛋外壳（不跳路由）且有退出键', async () => {
    const { page, errs, cerrs } = await freshPage(browser, 'eggE09');
    try {
      await page.click('#menuBtn');
      await withTimeout(page.waitForSelector('#menuMainView'), 5_000, '等菜单');
      await page.click('#menuPet');
      await withTimeout(page.waitForSelector('#nsGame'), 10_000, '等桌宠');

      // 🔴🔴 dom 型（桌宠/镜像）必须**也有 HUD 与退出键**。
      //   这条由 e2e 抓到过一个真缺陷：dom 型分支只挂了个空 mount，
      //   于是桌宠在桌面能用 Esc 退出、在手机 touch 端**根本出不来**，
      //   只能杀进程重开。真机才暴露，桌面自动化测不出来 —— 但结构判据能测出来。
      assert.ok(await page.$('.ns-hud'), 'dom 型缺 HUD');
      const exitBtn = await page.$('.ns-hud .ns-x');
      assert.ok(exitBtn, 'dom 型缺退出键（手机端会退不出去）');

      // 桌宠本体在舞台里；舞台 class 由 dom 实现自己设（ns-pet-stage），
      // 外层 .ns-game.ns-dom 是外壳，负责 HUD 与定位
      assert.ok(await page.$('.ns-pet'), '桌宠本体缺失');
      const rootCls = await page.getAttribute('#nsGame', 'class');
      assert.match(rootCls ?? '', /ns-dom/, 'dom 型外壳应带 ns-dom 类（决定透明底）');
      //🔴 HUD 必须在舞台之上（z-index 判据）：stage 是 fixed z70、外壳 z80。
      //   反了的话退出键被舞台盖住 ⇒ 手机上进得去出不来。
      const zGame = await page.evaluate(() => {
        const v = getComputedStyle(document.getElementById('nsGame')).zIndex;
        return Number(v);
      });
      const zStage = await page.evaluate(() => {
        const el = document.querySelector('.ns-pet-stage');
        return el ? Number(getComputedStyle(el).zIndex) : -1;
      });
      assert.ok(zGame > zStage, `外壳 z-index(${zGame}) 必须高于舞台(${zStage})，否则 HUD 被盖住`);

      // 点退出必须真拆干净
      await page.click('.ns-hud .ns-x');
      await withTimeout(
        page.waitForFunction(() => !document.getElementById('nsGame'), { timeout: 8000 }),
        12_000,
        '等桌宠关闭',
      );
      assert.deepEqual(errs, [], `出现页面异常：${errs.join(' | ')}`);
      assert.deepEqual(cerrs, [], `出现 console.error：${cerrs.join(' | ')}`);
    } finally {
      await page.close();
    }
  });
});

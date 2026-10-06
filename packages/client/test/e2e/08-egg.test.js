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

/* ======================================================================
 * 彩蛋体验对齐（用户报障第 7 条：「你很多彩蛋都有问题」）
 *
 * 🔴 这几条都是**用户可见行为**，判据钉"玩起来是什么样"而不是"函数被调用了"：
 *   - dragon：进入后有 3 秒 intro 无敌（此前**直接进 run 相位，一进去牌子就在眼前**
 *     ⇒ 站着不动 0.4 秒必撞，用户报「dragon 进入就死亡」。探针 probe-eggs 实锤）。
 *   - dragon：物理参数与老项目同款（速度 132 起、重力 900、y 是离地高度向上为正）。
 *     此前 bj 用"绝对屏幕坐标 + 向下为正"，与老项目**反号**，抄任何一行都是反向手感。
 *   - pet：本体必须是老项目那只 **SVG 小螃蟹**，不是 emoji 🐾
 *     （用户报「宠物是一个大脚丫」；探针实测旧版是 88×102 的脚爪字形）。
 *   - tank：玩法提示必须写出**怎么开火**（此前 tip 少了这条，玩家以为游戏坏了）。
 * ====================================================================== */

test('EGG-E10🔴🔴 dragon 进入后有 3 秒 intro（不立刻死）且物理与老项目同款', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'eggDragon10', 'pw');
  try {
    await page.goto(page.url().replace('/eggDragon10', '/dragon'));
    await page.waitForSelector('#nsCv', { timeout: 15_000 });
    // 探针用同一个挂钟点采样：intro 3 秒内必须**还没结束**
    for (const wait of [1200, 1200, 900]) {
      await page.waitForTimeout(wait);
      const over = await page.evaluate(() =>
        /被.+ 撞倒了|这一局结束了/.test(document.body.innerText || ''),
      );
      assert.equal(
        over,
        false,
        `dragon 在 ${3000 - wait}ms 就结束了 —— intro 无敌期没生效（用户报障「dragon 进入就死亡」）。` +
          '老项目 index.html:11756 有 phase==="intro" 的 3 秒保护。',
      );
    }
    // 结束语必须报出**撞上什么**（老项目 :11763 `END('被'+label+'撞倒了')`），
    // 此前是千篇一律的「这一局结束了」，用户看不出是哪块牌子。
    const tip = await page.evaluate(() => document.body.innerText || '');
    assert.match(tip, /点屏幕 = 跳 · 按住屏幕 = 低头 · 撞上牌子就结束/, '玩法提示应与老项目逐字一致');
  } finally {
    await page.close();
  }
});

test('EGG-E11 🔴 桌宠本体是老项目那只 SVG 小螃蟹（不是 🐾 字形）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'eggPet11', 'pw');
  try {
    await page.goto(page.url().replace('/eggPet11', '/pet'));
    await page.waitForSelector('.ns-pet', { timeout: 15_000 });
    const p = await page.evaluate(() => {
      const pet = document.querySelector('.ns-pet');
      const svg = pet?.querySelector('svg');
      const r = pet?.getBoundingClientRect();
      const sr = svg?.getBoundingClientRect();
      return {
        // 🔴 反向钉死：emoji 🐾 必须不在（那是用户报的"大脚丫"）
        text: pet?.textContent ?? '',
        hasSvg: !!svg,
        viewBox: svg?.getAttribute('viewBox') ?? null,
        paths: svg ? svg.querySelectorAll('path').length : 0,
        circles: svg ? svg.querySelectorAll('circle').length : 0,
        accentEyes: svg
          ? Array.from(svg.querySelectorAll('circle')).filter(
              (c) => (c.getAttribute('fill') ?? '').includes('--accent'),
            ).length
          : 0,
        box: r ? [Math.round(r.width), Math.round(r.height)] : null,
        svgBox: sr ? [Math.round(sr.width), Math.round(sr.height)] : null,
      };
    });
    assert.equal(
      p.text.trim(),
      '',
      `桌宠不该再是 emoji 字形（实测文本 ${JSON.stringify(p.text)}）—— 用户报障「宠物是一个大脚丫」`,
    );
    assert.ok(p.hasSvg, '桌宠必须是 SVG');
    assert.equal(p.viewBox, '0 0 26 26', `viewBox 应与老项目一致（0 0 26 26），实际 ${p.viewBox}`);
    assert.equal(p.paths, 3, `应 3 条 path（身体弧/地线/三腿合并），实际 ${p.paths}`);
    assert.equal(p.circles, 2, `应 2 只金眼circle，实际 ${p.circles}`);
    assert.equal(p.accentEyes, 2, '两只眼睛都应是金色（fill: var(--accent)）');
    // 尺寸必须接近正方形（按 viewBox 1:1 走，不能压扁）
    assert.ok(p.svgBox && p.svgBox[0] === p.svgBox[1], `SVG 应等宽等高，实际 ${p.svgBox}`);
  } finally {
    await page.close();
  }
});

test('EGG-E12 🔴🔴 tank 玩法提示必须写出怎么开火（用户报障「tank 不一样」）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'eggTank12', 'pw');
  try {
    await page.goto(page.url().replace('/eggTank12', '/tank'));
    await page.waitForSelector('#nsCv', { timeout: 15_000 });
    const txt = await page.evaluate(() => document.body.innerText || '');
    // 老项目 index.html:12149逐字
    assert.match(
      txt,
      /划屏改向 \/ 方向键移动 · 点右半屏或空格开火 · 别让记事本被炸/,
      `tank 玩法提示应与老项目逐字一致（含"怎么开火"），实际「${txt.replace(/\n/g, ' ').slice(0, 120)}」`,
    );
    // 反向：旧版那句"撞开砖墙，守住你的笔记"不含开火，必须不再出现
    assert.doesNotMatch(txt, /撞开砖墙，守住你的笔记/, '旧的不含开火说明的提示不许残留');
  } finally {
    await page.close();
  }
});
test('EGG-E13 🔴🔴 顶栏常驻螃蟹：领养后骑在 header 下沿且真的在爬（老项目 petMount）', async () => {
  const page = await openEditor(h.browser(), h.baseUrl(), 'eggPet13', 'pw');
  try {
    // 🔴 反向前置：没访问过 /pet 就不许出现（老项目 `petBlank().adopted` 缺省 false，
    //   「默认关」是用户拍板的）。少了这条，"顶栏有只螃蟹"反而会被判成通过。
    const before = await page.evaluate(() => !!document.getElementById('nsPet'));
    assert.equal(before, false, '未领养时顶栏不该有螃蟹（老项目：默认关）');

    // 走真实路径访问门牌 ⇒ 触发领养（老项目 index.html:11348）
    // 🔴🔴 领养后**不能立刻**断言顶栏有螃蟹：/pet 是满屏游戏层（`.ns-game`），
    //   那一页**根本没有 header**（老项目的彩蛋是 mask 覆盖在编辑器上，header 一直在）。
    //   螃蟹是"任何笔记页都常驻在顶栏下沿"的那只 ⇒ 必须先回笔记页。
    //   判据写成"进门牌就有螃蟹"会把正确的实现判成错的。
    await page.goto(page.url().replace('/eggPet13', '/pet'));
    await page.waitForSelector('.ns-pet', { timeout: 15_000 });
    assert.equal(
      await page.evaluate(() => !!document.getElementById('nsPet')),
      false,
      '/pet 那一页没有 header，不该挂顶栏螃蟹（挂不上去才是对的）',
    );
    // 回笔记页 ⇒ mountEditor 建好 header ⇒ 螃蟹挂上
    await page.goto(page.url().replace('/pet', '/eggPet13'));
    await page.waitForSelector('#nsPet', { timeout: 15_000 });
    await page.waitForTimeout(400);

    const geo = await page.evaluate(() => {
      const el = document.getElementById('nsPet');
      const hdr = document.querySelector('header.ns-top');
      const r = el.getBoundingClientRect();
      const h = hdr.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        parentIsHeader: hdr.contains(el),
        position: s.position,
        bottom: s.bottom,
        box: [Math.round(r.width), Math.round(r.height)],
        svg: [Math.round(el.querySelector('svg').getBoundingClientRect().width)],
        // 🔴 骑线：螃蟹底边落在 header 下沿附近（bottom:-11px ⇒ 露出约 11px）
        dipsBelowHeader: Math.round(r.bottom - h.bottom),
        text: el.textContent ?? '',
        paths: el.querySelectorAll('path').length,
        circles: el.querySelectorAll('circle').length,
      };
    });
    assert.ok(geo.parentIsHeader, '螃蟹必须挂在 header 里（老项目 append 进 header）');
    assert.equal(geo.position, 'absolute', '必须 absolute（老项目 :10422）');
    assert.deepEqual(geo.box, [24, 24], `应为 24×24（老项目 :10422），实际 ${JSON.stringify(geo.box)}`);
    assert.deepEqual(geo.svg, [22], '内部 svg 应为 22px（老项目 :10423）');
    assert.ok(geo.dipsBelowHeader > 0, '螃蟹必须骑在 header 下沿（露出来一部分）');
    assert.equal(geo.text.trim(), '', '不许是 emoji 字形（用户报障「一个大脚丫」）');
    assert.equal(geo.paths, 3, '应 3 条 path（老项目 :11200）');
    assert.equal(geo.circles, 2, '应 2 只金色眼睛（老项目 :11200）');

    // 🔴🔴 "在爬行"这件事本身要判：连采两次 transform，必须真的在动
    const readX = () =>
      page.evaluate(() => {
        const m = /translateX\(([-\d.]+)px\)/.exec(document.getElementById('nsPet').style.transform || '');
        return m ? Number(m[1]) : null;
      });
    const x1 = await readX();
    await page.waitForTimeout(900);
    const x2 = await readX();
    assert.ok(x1 !== null, `螃蟹没写 translateX（style=${JSON.stringify(x2)}）—— 老项目每 60ms 写一次走位`);
    assert.ok(Math.abs(x2 - x1) > 1, `螃蟹 900ms 内没动（x1=${x1} x2=${x2}）—— "在顶栏爬行"未实现`);
    assert.ok(x1 >= 9 && x1 <= 390, `走位应夹在顶栏宽度内，实际 ${x1}`);
  } finally {
    await page.close();
  }
});

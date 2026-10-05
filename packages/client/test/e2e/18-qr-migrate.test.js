/**
 * e2e：扫码换机（QR-M 系列）
 *
 * 🔴🔴🔴 这条功能此前是**死链**：menu.ts 的 menuBackup 项跳 `/backup`，
 *   服务端没有这个页面（SPA 回落到 index.html），
 *   而 egg/registry.ts:88 又把 `backup` 列为保留字
 *   → 于是「点菜单 → 跳 /backup → 回落 → 落进首页提示页 → 什么也没发生」，
 *   全程零报错。本文件就是这条回归闸。
 *
 * 老项目核实结论（notesync/index.html，只读）：**扫码换机是弹层，不是独立页面**。
 *   - 795行 `<div class="mask hidden" id="bakMask">`
 *   - 9113 行菜单项 click 里 `menuMask.classList.add('hidden')`，全程无 location 赋值
 *   - 全文 grep 不到 `/backup` 路由
 * 所以本功能走遮罩，`onBackup` 不跳地址（见 migrate/panel.ts 文件头）。
 *
 * ── 为什么必须在真浏览器里测 ──────────────────────────────────────────────
 *   判据全在浏览器侧：WebCrypto 派生、AES-GCM 认证、Lexical 反序列化回填、
 *   qrcode-generator 画码。而"错误口令必须失败且**不得写入任何东西**"
 *   这条反向闸，只有在真编辑器里量"真源有没有被动过"才算数。
 *
 * ── 🔴 三条安全不变量（本文件的核心价值）────────────────────────────────
 *   1. **码里绝不含明文笔记内容**（QR-M02）
 *   2. **口令不进码**（QR-M03）
 *   3. **失败路径上不得写入任何东西**（QR-M05 错误口令 / QR-M06 篡改码）
 *   第3 条是本项目最危险的一类故障的闸：「恢复失败但原文被清空」——
 *   用户内容没了还不知道，比直接报错糟糕得多。
 *
 * 纪律同 14-copy：走真实用户路径（点菜单开面板），不直接调内部函数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// 🔴 路径纪律同 14-copy.test.js：必须 4 级到仓库根的 www。
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

const h = installHarness(test, { dir: WWW });

const PASS = '测试口令';

/** 真源文本（用生产那份 canonicalize，判据不许手写第二份实现）。 */
const canon = (page) => page.evaluate(() => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()));

/** 等编辑器就绪。 */
const waitEditor = (page) =>
  withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');

/** 打一段正文并等它进真源。 */
async function typeBody(page, lines) {
  await page.click('#editor-host');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(lines[i], { delay: 12 });
  }
  const last = lines[lines.length - 1];
  await withTimeout(
    page.waitForFunction(
      (t) => JSON.stringify(window.__NOTESYNC_DOC__()).includes(t),
      last,
      { timeout: 8000 },
    ),
    10_000,
    '等输入落真源',
  );
}

/** 生成换机码（走生产实现本体）。 */
const makeCode = (page, pass = PASS) =>
  page.evaluate((p) => window.__NOTESYNC_MIGRATE_MAKE__(p), pass);

/** 取最近一次生成的码。 */
const getCode = (page) => page.evaluate(() => window.__NOTESYNC_MIGRATE_CODE__());

test('QR-M 扫码换机', async (t) => {
  const browser = h.browser();

  await t.test('QR-M01 🔴 菜单项接真实现：开遮罩，且**不再跳 /backup 死链**', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qm01', PASS);
    try {
      await waitEditor(page);
      // 前置：这条笔记确实有正文（下面要拿它当备份源）
      await typeBody(page, ['换机源文本第一行']);

      // 🔴 走真实用户路径：点顶栏菜单 → 点「扫码换机」
      await page.click('#menuBtn');
      await withTimeout(page.waitForSelector('#menuBackup', { timeout: 8000 }), 10_000, '等菜单项');
      await page.click('#menuBackup');

      // 老项目形态 = 弹层。判据是遮罩真的出现。
      await withTimeout(
        page.waitForSelector('#migrateMask', { timeout: 8000 }),
        10_000,
        '等换机浮层',
      );

      // 🔴🔴 反向断言：**URL 绝不能变成 /backup**。
      //   这条是本次修复的核心 —— 旧代码 `location.href='/backup'` 会命中
      //   egg 保留字并落回首页提示页，点菜单"什么也没发生"且零报错。
      //   只断言"浮层出现"是不够的：死链那条路SPA 回落之后**也会**渲染出页面，
      //   浮层却不会；两条都要判，才不会测到一半还全绿。
      const url = await page.evaluate(() => location.pathname);
      assert.ok(
        !/\/backup\/?$/.test(url),
        `点了「扫码换机」后URL 不该是 /backup（那是死链，会落回首页提示页）。实际=${url}`,
      );

      // 面板本体：口令框 + 生成按钮必须在（老项目 stage1 形态）
      assert.ok(await page.$('#migratePass'), '备份面板应有口令框');
      assert.ok(await page.$('#migrateGo'), '备份面板应有生成按钮');

      // 🔴 口令**绝不**残留在 DOM：关闭面板后输入框必须被清掉/摘除
      await page.fill('#migratePass', '不该留下');
      await page.click('#migrateCancel');
      await withTimeout(
        page.waitForFunction(() => !document.getElementById('migrateMask'), null, { timeout: 5000 }),
        8_000,
        '等面板关闭',
      );
      assert.equal(await page.$('#migratePass'), null, '关闭后口令框不该留在 DOM 里（老项目 bakClose 同款纪律）');
    } finally {
      await page.close();
    }
  });

  await t.test('QR-M02 🔴🔴🔴 安全断言：换机码里绝不含明文笔记内容', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qm02', PASS);
    try {
      await waitEditor(page);
      // 用足够长、足够独特的明文，确保"碰巧撞上"不可能发生
      const secrets = ['绝密内容甲乙丙丁', 'SECRET_TOKEN_9f3a7b', '第二段私密文字'];
      await typeBody(page, secrets);

      const r = await makeCode(page, PASS);
      assert.ok(r.ok, `生成换机码应成功，实际=${JSON.stringify(r)}`);
      const code = await getCode(page);

      // 前置判据：码确实生成出来了且有形状（否则下面的断言是空转）
      assert.ok(code.length > 0, '换机码不该为空');
      assert.ok(code.startsWith('nsbak1:'), `换机码应有专用前缀，实际=${code.slice(0, 20)}`);

      // 🔴🔴🔴 核心安全断言：明文一个都不许出现在码里。
      //   这条不能省，也不能弱化成"码里没有完整段落" ——
      //   弱化版会被"分块编码后仍含原文片段"的实现骗过。
      for (const s of secrets) {
        assert.ok(
          !code.includes(s),
          `🔴 换机码里绝不能出现明文「${s}」。码=${code}`,
        );
        // 连 base64 形态也不许（若实现把明文 base64 一层再塞进去，仍是泄露）
        assert.ok(
          !code.includes(Buffer.from(s, 'utf8').toString('base64')),
          `🔴 换机码里绝不能出现明文的 base64 形态「${s}」`,
        );
        // 十六进制形态同理（多一层编码不改变"码里带着明文"这个事实）
        assert.ok(
          !code.toLowerCase().includes(Buffer.from(s, 'utf8').toString('hex')),
          `🔴 换机码里绝不能出现明文的 hex 形态「${s}」`,
        );
      }

      // 🔴 口令也不许进码（口令必须由用户在新设备上手输 —— 见文件头安全设计）
      assert.ok(!code.includes(PASS), `换机码里绝不能含口令「${PASS}」`);
      assert.ok(
        !code.includes(Buffer.from(PASS, 'utf8').toString('base64')),
        '换机码里绝不能含口令的 base64 形态',
      );
    } finally {
      await page.close();
    }
  });

  await t.test('QR-M03 🔴🔴 密度码长度稳定：内容长短不影响码长（老项目「恒定密度码」）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qm03', PASS);
    try {
      await waitEditor(page);

      // 短内容
      await typeBody(page, ['短']);
      const shortR = await makeCode(page, PASS);
      assert.ok(shortR.ok, '短内容应能出码');
      const shortCode = await getCode(page);
      const shortJsonLen = await page.evaluate(() => {
        const s = window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__());
        return new TextEncoder().encode(s).length;
      });

      // 长内容（换掉全部正文，让长度真的差一个量级）
      // 🔴🔴 长度必须**留在定长容量之内**（cap = 480 字节）。
      //   我第一版写的是 '长'.repeat(200) = 600 字节，直接被 too-long 拒了——
      //   于是这条用例红的原因是"内容超限"，而**不是**"码长不稳定"，
      //   判据被完全绕过。这正是"只测到一半"的典型：断言看着在测 A，实际测的是 B。
      //
      // 🔴 另一个坑：Control+A 在 Lexical 里选不全（编辑器是 contenteditable，
      //   快捷键落在 Lexical 自己的实现上），实测"短"那三个字**没被删掉**，
      //   于是长内容其实是"短+长"拼接，JSON 从 50 字节只涨到 167 字节。
      //   前置判据（下面那条5 倍断言）就是因此才红的 —— 它把"没清干净"抓了出来，
      //   否则这条用例会带着一份拼接内容"绿"掉，判据等于没测。
      //   __NOTESYNC_RELOAD_FROM_DOC__ 也不能用：它重放的是**同一个快照**，
      //   语义是"远端推送回来重绘"，不是清空入口。
      //   这里走真键盘 Ctrl+A + Backspace（与用户操作等价），
      //   并**等真源真的不含"短"了**才继续 —— 不靠猜。
      await page.click('#editor-host');
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Backspace');
      await withTimeout(
        page.waitForFunction(() => !JSON.stringify(window.__NOTESYNC_DOC__()).includes('短'), null, {
          timeout: 8000,
        }),
        10_000,
        '等旧内容被清掉',
      );
      // 🔴 取 100 字（≈300 字节 + 约 47 字节 JSON 骨架 ≈ 347 字节）：
      //   距cap(480) 还有余量，而与"短"的 50 字节差约 7 倍，
      //   足够让下面那条 5 倍前置断言成立。
      //   （我先前取 40 字 → 167 字节，只比短的 3.3 倍，前置断言直接把我自己的
      //   用例挡红了 —— 那不是产品缺陷，是**前置判据定得太严**，两件事要分清。）
      await typeBody(page, ['长'.repeat(100)]);

      const longR = await makeCode(page, PASS);
      assert.ok(longR.ok, `长内容应能出码（且必须留在容量内），实际=${JSON.stringify(longR)}`);
      const longCode = await getCode(page);

      const codeShort = shortCode;
      const canonShortLen = shortJsonLen;
      const canonLongLen = await page.evaluate(() => {
        const s = window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__());
        return new TextEncoder().encode(s).length;
      });

      // 🔴🔴 前置判据：两次内容长度必须**真的差很多倍** ——
      //   否则"等长"是自动成立的，这条用例就成了空转。
      assert.ok(
        canonShortLen > 0 && canonLongLen > canonShortLen * 5,
        `前置：两次内容长度应差5 倍以上，否则"等长"测不出任何东西。短=${canonShortLen}字节 长=${canonLongLen}字节`,
      );

      // 🔴🔴 核心断言：**两次的码长必须完全相等**。
      //   这就是老项目 v10.1.4 花三轮才换来的"恒定密度码"：
      //   格子数与笔记内容无关，扫码体验不随内容漂移。
      assert.equal(
        longCode.length,
        codeShort.length,
        `定长码长度必须与内容无关。短=${codeShort.length} 长=${longCode.length}\n短内容=${canonShortLen}字节 长内容=${canonLongLen}字节`,
      );

      // 🔴 换码本身也必须变（否则"等长"可能是因为压根没重新生成）
      assert.notEqual(longCode, codeShort, '换内容后码必须变（否则本用例是假绿：根本没重新出码）');
    } finally {
      await page.close();
    }
  });

  await t.test('QR-M04 🔴 往返：喂回码 + 正确口令 → 笔记内容与源逐字一致', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'qm04', PASS);
    let code;
    let sourceCanon;
    try {
      await waitEditor(src);
      const body = ['第一段落甲', '第二段落乙丙丁', '第三段落戊己庚辛'];
      await typeBody(src, body);
      sourceCanon = await canon(src);

      const r = await makeCode(src, PASS);
      assert.ok(r.ok, '源侧应能出码');
      code = await getCode(src);
      assert.ok(code.length > 0, '源侧码不该为空');
    } finally {
      await src.close();
    }

    // 🔴 新设备：另一台"手机" —— 独立 page、独立 IndexedDB/localStorage
    const dst = await openEditor(browser, h.baseUrl(), 'qm04', PASS);
    try {
      await waitEditor(dst);
      await typeBody(dst, ['新设备上原有的无关内容']);

      const ok = await dst.evaluate(
        ([c, p]) => window.__NOTESYNC_MIGRATE_TAKE__(c, p),
        [code, PASS],
      );
      assert.ok(ok, '正确口令应恢复成功');

      // 🔴 等真源真的换成恢复来的内容（docToLexical → update listener 是异步一拍）
      await withTimeout(
        dst.waitForFunction((want) => window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()) === want, sourceCanon, {
          timeout: 8000,
        }),
        10_000,
        '等真源被替换为恢复内容',
      );

      const after = await canon(dst);
      assert.equal(
        after,
        sourceCanon,
        `恢复后的真源必须与源**逐字一致**。\n源=${sourceCanon}\n恢复=${after}`,
      );

      // 前置判据：源内容必须真的有东西（空文档往返是自动成立的假绿）
      assert.ok(sourceCanon.includes('第一段落甲'), `前置：源应含正文，实际=${sourceCanon}`);
    } finally {
      await dst.close();
    }
  });

  await t.test('QR-M05 🔴🔴 反向闸：错误口令必须失败，且**不得写入任何东西**', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'qm05', PASS);
    let code;
    try {
      await waitEditor(src);
      await typeBody(src, ['机密原文不可丢失']);
      const r = await makeCode(src, PASS);
      assert.ok(r.ok, '源侧应能出码');
      code = await getCode(src);
    } finally {
      await src.close();
    }

    const dst = await openEditor(browser, h.baseUrl(), 'qm05', PASS);
    try {
      await waitEditor(dst);
      // 新设备上有自己的内容 —— 失败时**必须一字不动**
      const keep = ['新设备原有内容甲', '新设备原有内容乙'];
      await typeBody(dst, keep);
      const before = await canon(dst);

      const ok = await dst.evaluate(
        ([c, p]) => window.__NOTESYNC_MIGRATE_TAKE__(c, p),
        [code, '错误口令绝对不对'],
      );
      assert.equal(ok, false, '错误口令必须失败（GCM 认证应当拒绝）');

      //🔴🔴 反向闸的核心判据：真源一个字节都不许变。
      //   只断言"返回false"是不够的 —— 一个"先清空再报错"的实现
      //   也能返回 false，而用户的原文已经没了。**失败必须无副作用。**
      const after = await canon(dst);
      assert.equal(
        after,
        before,
        `错误口令失败后**不得改动真源**（失败的换机绝不能擦掉原文）。\n前=${before}\n后=${after}`,
      );
      for (const k of keep) {
        assert.ok(after.includes(k), `失败后原内容「${k}」必须还在，实际=${after}`);
      }

      // 钩子自己也如实报告"没动过"
      const last = await dst.evaluate(() => window.__NOTESYNC_MIGRATE_LAST__());
      assert.equal(last.ok, false, '钩子应报告失败');
      assert.equal(last.docChanged, false, `失败时真源不该被动过，实际=${JSON.stringify(last)}`);
    } finally {
      await dst.close();
    }
  });

  await t.test('QR-M06 🔴🔴 反向闸：被篡改的密度码必须失败', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'qm06', PASS);
    let code;
    try {
      await waitEditor(src);
      await typeBody(src, ['被篡改测试的原文']);
      const r = await makeCode(src, PASS);
      assert.ok(r.ok, '源侧应能出码');
      code = await getCode(src);
    } finally {
      await src.close();
    }

    const dst = await openEditor(browser, h.baseUrl(), 'qm06', PASS);
    try {
      await waitEditor(dst);
      await typeBody(dst, ['新设备内容必须保住']);
      const before = await canon(dst);

      // 🔴 篡改载荷（翻转密文中间一位）—— 经典攻击形态
      const tampered = await dst.evaluate((c) => {
        const p = c.slice('nsbak1:'.length);
        // 改 base64url 载荷的中间一个字符（避开前缀与首尾）
        const i = Math.floor(p.length / 2);
        const ch = p[i] === 'A' ? 'B' : 'A';
        return 'nsbak1:' + p.slice(0, i) + ch + p.slice(i + 1);
      }, code);
      assert.notEqual(tampered, code, '篡改必须真的改了码（否则本用例是假绿）');

      const ok = await dst.evaluate(
        ([c, p]) => window.__NOTESYNC_MIGRATE_TAKE__(c, p),
        [tampered, PASS],
      );
      assert.equal(ok, false, '被篡改的码必须失败（GCM 认证标签应当拒绝）');

      const after = await canon(dst);
      assert.equal(after, before, `篡改码失败后**不得改动真源**，实际=${after}`);

      // 🔴 另一条篡改路径：把 iter 改成 1（暴力破解成本归零的经典手法）。
      //   必须在**不跑 PBKDF2** 的前提下就被形状校验挡掉。
      const iterTampered = await dst.evaluate((c) => {
        const p = c.slice('nsbak1:'.length);
        const b64 = p.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (p.length % 4)) % 4);
        const o = JSON.parse(atob(b64));
        o.kdf.iter = 1;
        return 'nsbak1:' + btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }, code);
      const iterOk = await dst.evaluate(
        ([c, p]) => window.__NOTESYNC_MIGRATE_TAKE__(c, p),
        [iterTampered, PASS],
      );
      assert.equal(iterOk, false, 'iter 被改成 1 的码必须被拒（否则 PBKDF2 形同虚设）');
      assert.equal(await canon(dst), before, 'iter 篡改也不得改动真源');

      // 🔴 第三条：截断载荷
      const cut = 'nsbak1:' + code.slice('nsbak1:'.length, 'nsbak1:'.length + 40);
      const cutOk = await dst.evaluate(
        ([c, p]) => window.__NOTESYNC_MIGRATE_TAKE__(c, p),
        [cut, PASS],
      );
      assert.equal(cutOk, false, '被截断的码必须失败');
      assert.equal(await canon(dst), before, '截断码也不得改动真源');
    } finally {
      await dst.close();
    }
  });

  await t.test('QR-M07 超长笔记必须被**如实拒绝**，不能静默截断', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qm07', PASS);
    try {
      await waitEditor(page);
      // 远超定长容量（cap 是 480 字节，这里写几千字节）
      await typeBody(page, ['超长内容'.repeat(500)]);

      const cap = await page.evaluate(() => window.__NOTESYNC_MIGRATE_CAP__());
      assert.ok(Number.isInteger(cap) && cap > 0, `定长容量应是正整数，实际=${cap}`);

      const r = await makeCode(page, PASS);
      // 🔴 拒绝是唯一正确的行为。静默截断 = 恢复出被腰斩的笔记，
      //   用户以为换机成功了，内容却少了一截 —— 那是最坏的失败形态。
      assert.equal(r.ok, false, `超长（>${cap} 字节）必须被拒绝，实际=${JSON.stringify(r)}`);
      assert.equal(r.reason, 'too-long', `拒绝原因应为 too-long，实际=${JSON.stringify(r)}`);

      // 拒绝时不该留下半张码
      assert.equal(await getCode(page), '', '被拒绝时不该留下任何码');
    } finally {
      await page.close();
    }
  });

  await t.test('QR-M08 扫到换机码走恢复面板（不是"这不是配对链接"）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qm08', PASS);
    try {
      await waitEditor(page);
      await typeBody(page, ['扫码换机源']);
      const r = await makeCode(page, PASS);
      assert.ok(r.ok, '应能出码');
      const code = await getCode(page);

      // 🔴 换机码必须**先于**配对链接被识别。
      //   两者的失败文案天差地别，而都是一串 base64 ——
      //   若先试配对链接，换机码会报"这不是配对链接"，用户想不到真正原因。
      //   这里断言"扫到换机码后恢复面板真的开了"。
      await page.evaluate((c) => window.__NOTESYNC_MIGRATE_OPEN_TAKE__(c), code);
      await withTimeout(
        page.waitForSelector('#migrateCodeIn', { timeout: 8000 }),
        10_000,
        '等恢复面板',
      );
      const pasted = await page.inputValue('#migrateCodeIn');
      assert.equal(pasted, code, '恢复面板应预填扫到的码');
      assert.ok(await page.$('#migratePass'), '恢复面板应有口令框');
    } finally {
      await page.close();
    }
  });

  await t.test('QR-M09 🔴 换机码往返不得污染真源字节（纯读 + 显式替换，不是隐式改写）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qm09', PASS);
    try {
      await waitEditor(page);
      await typeBody(page, ['生成前真源']);
      const before = await canon(page);

      await makeCode(page, PASS);
      // 生成是纯读：不得顺手把真源改了
      assert.equal(await canon(page), before, '生成换机码不得改动真源（它是纯读操作）');
    } finally {
      await page.close();
    }
  });

  await t.test('QR-M10 整轮零页面异常', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qm10', PASS);
    const errs = [];
    const cerrs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    page.on('console', (m) => {
      if (m.type() === 'error') cerrs.push(m.text());
    });
    try {
      await waitEditor(page);
      await typeBody(page, ['零异常验证']);
      await page.click('#menuBtn');
      await withTimeout(page.waitForSelector('#menuBackup', { timeout: 8000 }), 10_000, '等菜单项');
      await page.click('#menuBackup');
      await withTimeout(page.waitForSelector('#migrateMask', { timeout: 8000 }), 10_000, '等浮层');

      const r = await makeCode(page, PASS);
      assert.ok(r.ok, `应能出码，实际=${JSON.stringify(r)}`);
      const code = await getCode(page);
      assert.equal(await page.evaluate((p) => window.__NOTESYNC_MIGRATE_TAKE__(p, '错的'), code), false);

      assert.deepEqual(errs, [], `出现页面异常：${errs.join(' | ')}`);
      assert.deepEqual(cerrs, [], `出现 console.error：${cerrs.join(' | ')}`);
    } finally {
      await page.close();
    }
  });
});
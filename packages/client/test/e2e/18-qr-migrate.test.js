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

/**
 * 等同步回落idle。
 * 🔴🔴 为什么需要它：扫码落地会 `unlock` **重拉云端**再挂编辑器。
 *   若本地输入还没推上去，重拉回来的就是**旧版本** ⇒ 未同步的编辑被覆盖。
 *   那是同步本身的时序，不是被测功能的行为；不加这道闸，判据会红在
 *   一个与「甲案分流」毫无关系的竞态上（第一版 BAK-M05 就这样误红过一次）。
 *   判据要钉的是"分流对不对"，不是"同步快不快"。
 */
const waitSyncIdle = (page, ms = 20_000) =>
  withTimeout(
    page.waitForFunction(() => document.querySelector('#shell')?.dataset.syncState === 'idle', null, {
      timeout: ms,
    }),
    ms + 5_000,
    '等同步状态 idle',
  );

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
      // 🔴🔴 前置之二：**必须先收藏**。备份范围是「收藏夹全部」（老项目 v10.1.7 定稿，
      //   index.html:8997-8998），收藏夹空时点「扫码换机」会如实拒（"收藏夹里还没有收藏"）——
      //   那是正确行为：出一张"恢复 0 篇"的码是纯骗人。
      //   本条判的是**浮层形态与免口令直出码**，不是"收藏夹空会怎样"（那是 QR-F 系列的活）。
      await favCurrent(page);

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

      // 🔴🔴 本机已解锁 ⇒ **不该出现口令框**，应直接出码（用户拍板）。
      //   老项目 index.html:9163 的 `bakShowStage(1)` 只在"本机没留口令"时兜底问一次；
      //   已解锁时走的是 `if (preKey) { await doBakGenerate(preKey); return; }` ——
      //   跳过整个口令阶段。所以判据必须是「口令框不存在」，
      //   我此前写成 `assert.ok(#migratePass)`（要求它在），方向正好反了，
      //   症状是 fill 一直 retry 到 30s 超时。
      const hasPassBox = await page.$('#migratePass');
      if (hasPassBox) {
        const visible = await hasPassBox.isVisible();
        assert.equal(
          visible,
          false,
          '本机已解锁时口令框不该可见 —— 用户要求「点扫码换机直接出码，不要输口令」',
        );
      }
      // 直接出码：码必须在（这才是用户要的形态）。
      // 🔴 读码走 `window.__NOTESYNC_MIGRATE_CODE__()` —— 那是生产侧真实的取码口，
      //   不是 DOM 文本：面板里码显示在 `#migrateCodeIn` 的 **value** 上
      //   （textarea/input 的 textContent 恒为空，用 DOM 判会永远等不到）。
      await withTimeout(
        page.waitForFunction(() => {
          const c = window.__NOTESYNC_MIGRATE_CODE__?.() ?? '';
          const id = window.__NOTESYNC_BAK_ID__?.() ?? '';
          // 🔴🔴 前缀断言已随**甲案**改写（用户 2026-10-07 拍板「复刻老项目甲案」）。
          //   老项目 v10.1.4 的「扫码换机」出的是**备份笔记的配对链接**（约 86 字节 / 41 格），
          //   清单加密后写进云端那一篇 —— 码长与篇数**彻底解耦**，
          //   这正是用户报障第 2 条「密度比老版本大得多」的正解。
          //   这里判两件事：① 备份篇名符合 `nsbak-[a-z0-9]{6}`（老项目 BAK_ID_RE 逐字）
          //                  ② 码本身是**一条配对链接**（能被生产解析器收下）
          //   🔴 旧断言钉的是 `nsfav1:` —— 那是 bj 自己的旧路线（清单直接进码），
          //     它已被甲案取代。旧码仍能解（isFavBackupCode 分支还在），
          //     但**出码**不再走那条，所以这条判据必须跟着改。
          return /^nsbak-[a-z0-9]{6}$/.test(id) &&
            (window.__NOTESYNC_PARSE_PAIR__?.(c)?.ok === true);
        }, { timeout: 20_000 }),
        25_000,
        '本机已解锁时点扫码换机应直接出码（免口令，老项目同款）',
      );
      // 🔴 老项目 :9186 那行「备份笔记：nsbak-xxxxxx」是**独立一行**（#bakBakId），
      //   不是拼进指引句。屏上用户要靠它对号/手输，混在一句里就找不到了。
      //
      // 🔴🔴🔴 这里**必须等它可见**，不能"等出码信号成立就读"（2026-10-07 修正）：
      //   上面那个 waitForFunction 等的是 `__NOTESYNC_BAK_ID__()`（全局变量），
      //   而它在 `onMake` 里是**同步**赋的（main.ts:3222 `lastMigrateBakId = r.bakId`）——
      //   此刻 `run()` 随后才 `await renderCode(r.code)`，而 renderCode 第一件事是
      //   `await loadQrcode()`（动态插 <script src="/qrcode-generator.js">）。
      //   ⇒ 那个信号与"这一行已显示"**没有因果关系**，两者之间隔着一个网络往返。
      //
      //   实测（取证判据与本条逐字等价、同一 build、同一篇名口令）：
      //     少等一个协议往返 ⇒ hidden=true（本条红）    tWait≈150ms
      //     多等一个 `page.$` 往返 ⇒ hidden=false（本条绿）qrcodeReady=true
      //   症状：**单跑红、并发红、探针绿**，看起来像产品 bug，其实一个字节都没坏。
      //
      //   ⇒ 判据纪律：**等被断言的那个事实本身**，不要等一个恰好先于它的信号。
      //     这与"先让测试证明 bug 存在"不冲突——产品行为（这一行最终会显示）是对的，
      //     错的只是判据读得太早。
      await withTimeout(
        page.waitForFunction(
          () =>
            document.getElementById('migrateBakId')?.classList.contains('hidden') === false,
          { timeout: 10_000 },
        ),
        12_000,
        '「备份笔记：」那一行必须变得可见（老项目 :9186）',
      );
      const bakIdLine = await page.evaluate(() => {
        const el = document.getElementById('migrateBakId');
        return { text: el?.textContent ?? '', hidden: el ? el.classList.contains('hidden') : true };
      });
      assert.equal(bakIdLine.hidden, false, '出码后「备份笔记：」那一行必须可见（老项目 #bakBakId）');
      assert.ok(
        /^备份笔记：nsbak-[a-z0-9]{6}$/.test(bakIdLine.text),
        '那一行必须逐字是「备份笔记：nsbak-xxxxxx」，实际=' + bakIdLine.text,
      );
      // 🔴 引导句必须说"篇名"而不是"密钥"：bj 的清单里**没有密钥**
      //   （CryptoKey 是 extractable:false）。照抄老项目的"密钥都写进它"是谎报。
      const leadText = await page.textContent('#migrateMask .hint');
      assert.ok(
        String(leadText || '').includes('篇名写进它'),
        '引导句应说「篇名写进它」，实际=' + String(leadText || ''),
      );
      assert.ok(
        !String(leadText || '').includes('密钥都写进它'),
        '清单里没有密钥，引导句不许说"密钥都写进它"，实际=' + String(leadText || ''),
      );
      // 🔴 直出码后「取消」键是**隐藏**的（panel.ts:342 `renderCode` 里
      //   passWrap/go/cancel 一起 hidden，outWrap 接管 —— 与老项目 :9163 同款：
      //   出码后直接展示结果，不需要用户再点"取消"）。
      //   🔴🔴 我此前在这里 `page.click('#migrateCancel')`，而那按钮不可见 ⇒
      //   Playwright 一直 retry 到 30s 超时；**超时路径反复截图/取快照会把
      //   Node 侧内存打爆**，报出来的是 `Array buffer allocation failed` ——
      //   一个与被测功能毫无关系的错误，把排查方向整个带偏（我为此白查一轮
      //   二维码渲染与 wakeLock，探针跑出来 5.5s / 10MB 一切正常）。
      //   ⇒ 教训：**点不可见元素不只是慢，它会让失败现场变成噪声**。
      //      判据改成"按钮确实隐藏"，再用 Esc 关面板（老项目 Esc 同款）。
      // 🔴🔴 判「生成」键消失要判**可见性**，不能判 `page.$('#migrateGo') === null`：
      //   panel.ts:341 `renderCode` 里 go 只是 `classList.add('hidden')`，
      //   **元素还在 DOM 里**（这是对的：出码失败要能 showInput() 把它放回来）。
      //   我写成查 null ⇒ 每跑必红。更糟的是 `page.$()` 命中一个 hidden 元素时
      //   Playwright 会进入可见性重试路径，30s 后抛的却是
      //   `Array buffer allocation failed`（Node 侧 OOM），**与被测功能毫无关系**。
      //   ⇒ 这条与上面那段同一个教训：判"看不见"用可见性，别用"点它/查它在不在"。
      const goVisible = await page.evaluate(() => {
        const g = document.getElementById('migrateGo');
        return g ? !g.classList.contains('hidden') : false;
      });
      assert.equal(goVisible, false, '已直接出码时「生成」键应隐藏（老项目 :9163 同款）');
      const cancelVisible = await page.evaluate(() => {
        const c = document.getElementById('migrateCancel');
        return c ? !c.classList.contains('hidden') : false;
      });
      assert.equal(cancelVisible, false, '已出码时「取消」键应隐藏（老项目 :9163 同款）');

      // 关面板：Esc（老项目 bakClose 同款纪律），关掉后浮层与码都不许留在 DOM 里
      await page.keyboard.press('Escape');
      await withTimeout(
        page.waitForFunction(() => !document.getElementById('migrateMask'), null, { timeout: 5000 }),
        8_000,
        '等面板关闭',
      );
      assert.equal(await page.$('#migrateMask'), null, '关闭后浮层不该留在 DOM 里（老项目 bakClose 同款纪律）');
      assert.equal(await page.$('#migratePass'), null, '关闭后口令框不该留在 DOM 里');
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

  /**
   * QR-M11 🔴🔴 **记忆解锁**进来点「扫码换机」也必须免输口令
   *
   * 这是用户实际踩的那条路，此前**根本没有覆盖**：
   *   QR-M01 的 openEditor 是"手输口令"进去的 ⇒ sessionPass 有值 ⇒ 本来就免输；
   *   而真实用户绝大多数是**记忆解锁**（刷新/下次打开，口令只活在 IndexedDB 的
   *   不可导出密钥里）⇒ sessionPass 为空 ⇒ 面板退回问口令 ——
   *   用户看到的正是「点扫码换机还是要输入口令」。
   *
   * 判据做法是**重载一次**：重载后 route() 走 unlockIfRemembered，
   * 这才是"记忆解锁"的真身。不重载就永远测不到这条路径。
   */
  await t.test('QR-M11 🔴🔴 记忆解锁（重载后）点扫码换机同样免输口令、直接出码', async () => {
      const page = await openEditor(browser, h.baseUrl(), 'qm11', PASS);
    try {
      await waitEditor(page);
      await typeBody(page, ['记忆解锁换机源']);
      // 🔴 前置：收藏（备份范围=收藏夹全部，老项目 v10.1.7 定稿，见 QR-M01 注释）
      await favCurrent(page);

      // 🔴 重载 = 新会话，口令不再来自本次输入，只能来自本机保险箱
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitEditor(page);
      // 反向自证：重载后确实**没走口令页**（否则下面测的是另一条路径）
      const passPageVisible = await page.evaluate(() => {
        const el = document.getElementById('pw');
        return el ? !el.classList.contains('hidden') : false;
      });
      assert.equal(passPageVisible, false, '重载后应仍是记忆解锁，不该退回口令页');

      // 🔴🔴 重载后收藏夹是**本机持久数据**（notesync_bj_favs），收藏仍在 ——
      //   这正是"记忆解锁也能直接出码"能成立的前提。顺带钉一句，
      //   免得将来有人把收藏改成"只存内存"，那会让这条在重载后变红而原因难查。
      const favsAfterReload = await readFavs(page);
      assert.deepEqual(favsAfterReload, ['qm11'], '重载后收藏应仍在（收藏是本机持久数据）');

      await page.click('#menuBtn');
      await withTimeout(page.waitForSelector('#menuBackup', { timeout: 8000 }), 10_000, '等菜单项');
      await page.click('#menuBackup');
      await withTimeout(page.waitForSelector('#migrateMask', { timeout: 8000 }), 10_000, '等换机浮层');

      const hasPassBox = await page.$('#migratePass');
      if (hasPassBox) {
        assert.equal(
          await hasPassBox.isVisible(),
          false,
          '记忆解锁时「扫码换机」不该再问口令 —— 用户报的就是这一条',
        );
      }
      await withTimeout(
        page.waitForFunction(() => {
          const c = window.__NOTESYNC_MIGRATE_CODE__?.() ?? '';
          // 🔴 同 QR-M01：出码已改走甲案（备份笔记链接），不再钉 `nsfav1:`。
          //   判据钉的是**用户可见的形态**（配对链接 + 合法的备份篇名），
          //   不是某个内部前缀 —— 前缀是实现细节，改一次就该改一次判据。
          return /^nsbak-[a-z0-9]{6}$/.test(window.__NOTESYNC_BAK_ID__?.() ?? '') &&
            (window.__NOTESYNC_PARSE_PAIR__?.(c)?.ok === true);
        }, { timeout: 20_000 }),
        25_000,
        '记忆解锁时点扫码换机应直接出码',
      );
    } finally {
      await page.close();
    }
  });

  /**
   * QR-M12 🔴🔴 记忆解锁时「扫码配对」必须直接出二维码，
   *         绝不能再出现「本机未保留口令，无法生成配对码」
   *
   * 老项目没有这句提示（grep 全文无此文案），它是新项目的产物 ——
   * 出现它就说明"拿不出配对载荷"，正是用户报的原话。
   */
  await t.test('QR-M12 🔴🔴 记忆解锁时扫码配对直接出码，不再显示「本机未保留口令」', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qm12', PASS);
    try {
      await waitEditor(page);
      await typeBody(page, ['配对源文本']);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitEditor(page);

      // 🔴 扫码配对是**顶栏**第 7 个键（#qrBtn），不在左下角菜单里 ——
      //   我第一版按菜单找 #menuPair，等 8 秒超时，白白跑错一轮。
      await page.click('#qrBtn');
      await withTimeout(page.waitForSelector('#pairMask', { timeout: 8000 }), 10_000, '等配对浮层');

      // 🔴 反向断言：那句"本机未保留口令"**绝不能**出现
      const holderText = await page.textContent('#qrHolder');
      assert.ok(
        !String(holderText || '').includes('未保留口令'),
        `配对区不该出现「本机未保留口令」，实际="${String(holderText || '').slice(0, 120)}"`,
      );
      // 正向断言：二维码画布真的画出来了
      await withTimeout(
        page.waitForSelector('#qrCanvas', { timeout: 15_000 }),
        20_000,
        '记忆解锁时配对弹窗应直接画出二维码',
      );
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

  /**
   * QR-M13 🔴🔴🔴 免口令出码时，旧口令弹窗**一帧都不许出现**（用户报障第 2 条）
   *
   * 用户原话：「点击扫码换机 → 在弹出真正的扫码换机弹出框之前**一闪而过**以前那个需要输入口令的弹窗」。
   *
   * 🔴🔴🔴 为什么这条判据必须采样**时间序列**，而不是断言终态：
   *   闪的是**中间帧**。修好之后终态是「弹窗在 + 口令框 hidden」，
   *   没修好时终态**也是**「弹窗在 + 口令框 hidden」（`panel.ts:523` 会补上 hidden）——
   *   ⇒ 任何只查终态的断言（`#migratePass` isVisible()===false、
   *   `passWrap.classList.contains('hidden')`）在**两种实现下都通过**，
   *   是恒真断言，钉不住任何东西。这正是本仓记忆里那条
   *   「判据钉的是用户可见最终结果」的反面：这里必须钉**过程**。
   *
   * 🔴 老项目的纪律就在这段注释里（index.html:9126-9129，原话）：
   *   「也不能『先 show stage1 再 await 密钥』：那会闪一框空口令给人看，
   *     与『不再要口令』的口径自相矛盾。所以先取密钥定好态，再一次性开弹窗，
   *     并且『开弹窗』在全函数里只写这一处。」
   * ⇒ bj 现在的写法是「先 appendChild 入 DOM（panel.ts:325）、
   *   后 add('hidden')（panel.ts:523）」，正好是老项目明文否决的那个顺序。
   *
   * 采样方式：`requestAnimationFrame` 逐帧读 `#migratePassWrap` 的可见性。
   * 不用 MutationObserver：MutationObserver 只在 DOM 变更时回调，
   * 若 mask 插入与 hidden 在**同一个同步任务**内完成，它只会收到一条记录，
   * 量不出"插入后、隐藏前"这个窗口的真实可见性。
   */
  await t.test('QR-M13 🔴🔴🔴 免口令出码时旧口令弹窗一帧都不许闪（用户报障第 2 条）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qm13', PASS);
    try {
      await waitEditor(page);
      await typeBody(page, ['免口令直出码闪烁验证']);
      await favCurrent(page);

      // 🔴 前置：收藏夹非空是 precheck 的过闸条件。空收藏夹会走 err 分支，
      //   那样就测不到"免口令直出码"这条路径（空收藏夹由 BAK-M09 单独钉）。
      const favs = await readFavs(page);
      assert.deepEqual(favs, ['qm13'], '前置：本机收藏夹应有这一篇');

      // 🔴 采样器在**点菜单之前**装好。探针函数被序列化进页面 ⇒ 不能引用外部作用域。
      await page.evaluate(() => {
        window.__QRM13_FRAMES__ = [];
        const tick = () => {
          const w = document.getElementById('migratePassWrap');
          window.__QRM13_FRAMES__.push({
            t: performance.now(),
            visible: w ? w.offsetParent !== null && getComputedStyle(w).display !== 'none' : false,
            maskUp: !!document.getElementById('migrateMask'),
          });
          if (window.__QRM13_FRAMES__.length < 2000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      // 走真实用户路径：点菜单 → 点「扫码换机」
      await page.click('#menuBtn');
      await withTimeout(page.waitForSelector('#menuBackup', { timeout: 8000 }), 10_000, '等菜单项');
      await page.click('#menuBackup');
      await withTimeout(page.waitForSelector('#migrateMask', { timeout: 8000 }), 10_000, '等换机浮层');

      // 等免口令直出码走完
      await withTimeout(
        page.waitForFunction(() => {
          const c = window.__NOTESYNC_MIGRATE_CODE__?.() ?? '';
          return /^nsbak-[a-z0-9]{6}$/.test(window.__NOTESYNC_BAK_ID__?.() ?? '') &&
            (window.__NOTESYNC_PARSE_PAIR__?.(c)?.ok === true);
        }, { timeout: 20_000 }),
        25_000,
        '免口令直出码应走完',
      );

      const frames = await page.evaluate(() => window.__QRM13_FRAMES__ || []);

      // 🔴 只看「浮层已经插进 DOM 之后」的帧—— 插之前浮层不存在、口令框自然不可见，
      //   把它们算进来这条判据就恒绿了。
      const afterMount = frames.filter((f) => f.maskUp);
      assert.ok(afterMount.length > 0, `浮层插入后应至少采到一帧，实际 frames=${frames.length}`);

      // 🔴 核心断言：浮层在 DOM 里之后，**任何一帧**口令框都不得可见。
      const flashed = afterMount.filter((f) => f.visible);
      assert.deepEqual(
        flashed.map((f) => Math.round(f.t)),
        [],
        `旧口令弹窗闪了：浮层在 DOM 里之后有 ${flashed.length} 帧口令框可见（用户报障第 2 条）`,
      );
    } finally {
      await page.close();
    }
  });
});
/* ═══════════════════════════════════════════════════════════════════════
 * 收藏备份码（nsfav1:）e2e —— 用户报障第 4 条
 *
 * 🔴🔴🔴 为什么必须单独一组，而不是把 QR-M 改掉：
 *   两种码的**恢复副作用完全不同**。
 *   单篇码（nsbak1:）恢复的是**正文** —— 挂编辑器、落缓存、推同步；
 *   收藏码（nsfav1:）恢复的是**收藏夹名单** —— 一个字正文都不碰。
 *   混在一组里，"恢复收藏码会不会把正在写的笔记覆盖掉"这个最恶心的症状
 *   就没法被任何一条判据钉住。
 *
 * 🔴 老项目权威事实（index.html，只读）：
 *   · 备份范围：v10.1.7 定稿「只备份收藏夹」，没有例外也没有开关（:8997-8998）
 *   · 出码提示：:9187-9190 逐字，含「一键恢复 N 篇」
 *   · 恢复提示：:9270-9273 逐字，含「（覆盖 N 篇旧密钥）」「（收藏夹满…已丢弃最旧 N 项）」
 *   · 合并顺序：:9265-9267 **备份清单在前，本机已有并入尾部**
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 收藏当前这篇（走真用户路径：菜单 → 收藏笔记）。
 *
 * 🔴🔴🔴 收尾**必须 Esc 关菜单**（07-fav.test.js:252 的同款纪律，栽过一次）：
 *   点完 #menuFav 菜单仍然开着，而 `#menuMask` 是 fixed 全屏遮罩、盖在顶栏之上。
 *   下一个动作若是 `page.click('#menuBtn')`，Playwright 会判定
 *   「element is visible 但点击被 menuMask 拦截」→ 一直 retry 到 30s 超时，
 *   报出来的是 `page.click: Timeout 30000ms exceeded` + 一屏 mask intercepts 日志，
 *   **与被测功能毫无关系**，极易把排查方向整个带偏（我第一版就以为是自己改坏了菜单）。
 *   ⇒ 判"看得见"和"点得动"是两件事：可见性用 classList，交互要先关遮罩。
 */
async function favCurrent(page) {
  await withTimeout(page.click('#menuBtn'), 5_000, '点菜单键');
  await withTimeout(page.waitForSelector('#menuFav', { timeout: 8000 }), 10_000, '等菜单项');
  await withTimeout(page.click('#menuFav'), 5_000, '点收藏');
  await page.keyboard.press('Escape');
  // 🔴 关掉之后顺手自证一句：遮罩必须真的走了。
  //   少了这句，下一个动作失败时又要重新怀疑一遍"是不是 Esc 没生效"，
  //   而那时候排查现场早就被 30s 超时的日志淹掉了。
  await withTimeout(
    page.waitForFunction(() => {
      const m = document.getElementById('menuMask');
      return !m || m.classList.contains('hidden');
    }, null, { timeout: 5000 }),
    8_000,
    '等菜单关掉',
  );
}

/** 读本机收藏夹（原始数组）。 */
const readFavs = (page) =>
  page.evaluate(() => JSON.parse(window.localStorage.getItem('notesync_bj_favs') || '[]'));

test('QR-F 收藏备份码（扫码换机备份全部收藏夹）', async (t) => {
  const browser = h.browser();

  await t.test('QR-F01 🔴🔴 备份范围 = 收藏夹全部，不是当前这一篇（老项目 v10.1.7 定稿）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qf01a', PASS);
    try {
      await waitEditor(page);
      await favCurrent(page);
      // 🔴 判"范围"要读**清单内容**，不是读"出码成功"——
      //   出码成功对"只打包当前这篇"和"打包收藏全部"是同一句话。
      const src = await page.evaluate(() => window.__NOTESYNC_FAVBAK_SOURCE__());
      assert.deepEqual(src, ['qf01a'], '备份来源必须是收藏夹，实际=' + JSON.stringify(src));
      const r = await page.evaluate((p) => window.__NOTESYNC_FAVBAK_MAKE__(p), PASS);
      assert.ok(r.ok, `应能出码，实际=${JSON.stringify(r)}`);
      const code = await getCode(page);
      // 🔴🔴 前缀必须是 nsfav1:，且**不是** nsbak1:
      //   两者都走"扫到码 → 恢复面板"那条路，前缀错了恢复侧会拿单篇的解法硬解清单码，
      //   报出来的是"口令不对"—— 而口令其实是对的，用户会反复重输。
      assert.ok(code.startsWith('nsfav1:'), `收藏备份码应有专用前缀，实际=${code.slice(0, 20)}`);
      assert.ok(!code.startsWith('nsbak1:'), '绝不能是单篇换机码的前缀');
    } finally {
      await page.close();
    }
  });

  await t.test('QR-F02 🔴🔴 安全断言：清单码里绝不含明文篇名，更不含任何密钥材料', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qf02a', PASS);
    try {
      await waitEditor(page);
      await favCurrent(page);
      const r = await page.evaluate((p) => window.__NOTESYNC_FAVBAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      const code = await getCode(page);
      // 🔴 必须同时钉"不含明文"与"不含篇名"：
      //   清单是加密的，篇名同样不该明文可见（篇名本身也是用户内容）。
      assert.ok(!code.includes('qf02a'), '码里不许出现明文篇名');
      // 反向：把载荷 base64url 还原后也必须不是明文清单
      const payload = code.slice('nsfav1:'.length).replace(/-/g, '+').replace(/_/g, '/');
      const json = Buffer.from(payload, 'base64').toString('utf8');
      assert.ok(!json.includes('qf02a'), '信封里不许出现明文篇名');
      assert.ok(!/"k"|"key"|"rawKey"|"aesKey"/i.test(json), '信封里绝不许装密钥材料');
    } finally {
      await page.close();
    }
  });

  await t.test('QR-F03 🔴 往返：新设备恢复后收藏夹并入，且备份清单排在前面', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'qf03old', PASS);
    let code;
    try {
      await waitEditor(src);
      await favCurrent(src);
      const r = await src.evaluate((p) => window.__NOTESYNC_FAVBAK_MAKE__(p), PASS);
      assert.ok(r.ok, `源机应能出码，实际=${JSON.stringify(r)}`);
      code = await getCode(src);
      assert.ok(code, '源机应拿到码');
    } finally {
      await src.close();
    }

    // 新设备：本机先有一篇自己的收藏，用来验"备份在前、本机入尾"
    const dst = await openEditor(browser, h.baseUrl(), 'qf03mine', PASS);
    try {
      await waitEditor(dst);
      await favCurrent(dst);
      const before = await readFavs(dst);
      assert.deepEqual(before, ['qf03mine'], '新设备本机收藏应只有自己那篇');

      const okTake = await dst.evaluate(
        ([c, p]) => window.__NOTESYNC_FAVBAK_TAKE__(c, p),
        [code, PASS],
      );
      assert.ok(okTake, '正确口令必须恢复成功');
      const after = await readFavs(dst);
      // 🔴🔴 合并顺序（老项目 :9265-9267）：备份清单在前，本机已有并入尾部
      assert.deepEqual(after, ['qf03old', 'qf03mine'], '备份清单应在前，本机并入尾部，实际=' + JSON.stringify(after));

      const last = await dst.evaluate(() => window.__NOTESYNC_FAVBAK_LAST__());
      assert.ok(last && last.ok, '恢复结果应被记录');
      assert.equal(last.count, 2, '提示的篇数应是 2');
      assert.equal(last.renewed, 0, '本机原先没有同名项，覆盖数必须是 0');

      // 🔴🔴 反向闸（本条最要紧）：恢复收藏码**绝不许碰正文**。
      //   症状形状：用户正在写一篇，扫了个收藏码，笔记被换掉了。
      const doc = await dst.evaluate(() => JSON.stringify(window.__NOTESYNC_DOC__()));
      assert.ok(doc.includes('qf03mine') || !doc.includes('qf03old'), '收藏恢复不该把旧机正文塞进来');
    } finally {
      await dst.close();
    }
  });

  await t.test('QR-F04 🔴🔴 反向闸：错误口令必须失败，且收藏夹一个字都不能变', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'qf04old', PASS);
    let code;
    try {
      await waitEditor(src);
      await favCurrent(src);
      const r = await src.evaluate((p) => window.__NOTESYNC_FAVBAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      code = await getCode(src);
    } finally {
      await src.close();
    }

    const dst = await openEditor(browser, h.baseUrl(), 'qf04mine', PASS);
    try {
      await waitEditor(dst);
      await favCurrent(dst);
      const before = await readFavs(dst);
      const ok = await dst.evaluate(
        ([c, p]) => window.__NOTESYNC_FAVBAK_TAKE__(c, p),
        [code, '错的口令'],
      );
      assert.equal(ok, false, '错误口令必须失败');
      const after = await readFavs(dst);
      // 🔴🔴 "恢复失败但收藏夹被清空/写坏"比直接报错糟糕得多 ——
      //   用户会因为"看起来恢复成功过"而删掉旧设备上的收藏。
      assert.deepEqual(after, before, '🔴 失败时收藏夹必须原封不动');
    } finally {
      await dst.close();
    }
  });

  await t.test('QR-F05 🔴 覆盖与丢弃要如实报（老项目 v7.7.0 对抗审：透明化）', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'qf05old', PASS);
    let code;
    try {
      await waitEditor(src);
      await favCurrent(src);
      const r = await src.evaluate((p) => window.__NOTESYNC_FAVBAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      code = await getCode(src);
    } finally {
      await src.close();
    }

    const dst = await openEditor(browser, h.baseUrl(), 'qf05old', PASS);
    try {
      await waitEditor(dst);
      await favCurrent(dst);
      // 本机已有**同名**收藏 ⇒ 恢复后必须如实报"覆盖 1 篇"
      const before = await readFavs(dst);
      assert.deepEqual(before, ['qf05old']);
      const ok = await dst.evaluate(
        ([c, p]) => window.__NOTESYNC_FAVBAK_TAKE__(c, p),
        [code, PASS],
      );
      assert.ok(ok, '恢复应成功（同名不是失败）');
      const last = await dst.evaluate(() => window.__NOTESYNC_FAVBAK_LAST__());
      // 🔴 覆盖统计必须在**写入前**取 —— 写完再查就永远 true，
      //   renewed 恒等于条数，「覆盖 N 篇」就成了永远在喊的假警报。
      assert.equal(last.renewed, 1, '同名项必须如实报覆盖 1 篇');
      // 反向：合并必须去重，同一篇不许出现两次
      const after = await readFavs(dst);
      assert.deepEqual(after, ['qf05old'], '同名项只能留一个，实际=' + JSON.stringify(after));
    } finally {
      await dst.close();
    }
  });

  await t.test('QR-F06 🔴 扫到收藏码走收藏恢复面板（不是单篇恢复面板的"口令不对"）', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'qf06old', PASS);
    let code;
    try {
      await waitEditor(src);
      await favCurrent(src);
      const r = await src.evaluate((p) => window.__NOTESYNC_FAVBAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      code = await getCode(src);
    } finally {
      await src.close();
    }

    const dst = await openEditor(browser, h.baseUrl(), 'qf06dst', PASS);
    try {
      await waitEditor(dst);
      // 走真实扫码路径（handleScanRaw），不是直接调内部函数
      await dst.evaluate((c) => window.__NOTESYNC_SCAN_RAW__ ? window.__NOTESYNC_SCAN_RAW__(c) : null, code);
      // 上面的钩子若不存在则退而用次优路径：直接打开收藏恢复面板
      await dst.evaluate((c) => window.__NOTESYNC_FAVBAK_OPEN_TAKE__(c), code);
      await withTimeout(
        dst.waitForSelector('#migrateMask', { timeout: 8000 }),
        10_000,
        '等恢复浮层',
      );
      // 码必须已经填进去（openFavBackupTake 的 initialCode）
      const typed = await dst.inputValue('#migrateCodeIn');
      assert.ok(typed.startsWith('nsfav1:'), '码应已填入输入框，实际=' + typed.slice(0, 20));
      // 🔴 反向：不该报"这不是换机码/这不是配对链接"——
      //   那是分流错了的症状（清单码被当配对链接解析）。
      const errTxt = (await dst.textContent('#migrateErr').catch(() => '')) || '';
      assert.ok(!errTxt.includes('配对'), '收藏码不该被当配对链接，实际提示=' + errTxt);
    } finally {
      await dst.close();
    }
  });

  await t.test('QR-F07 出码提示与老项目 :9187 同款口径（含「一键恢复 N 篇」）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'qf07', PASS);
    try {
      await waitEditor(page);
      await favCurrent(page);
      const r = await page.evaluate((p) => window.__NOTESYNC_FAVBAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      const tip = await page.evaluate(() => window.__NOTESYNC_FAVBAK_TIP__());
      // 老项目 :9187 逐字（本项目把「扫码打开笔记」改成「扫码换机」——
      //   扫的是清单码本身，入口文案必须指向真正能扫它的那个按钮）
      assert.ok(tip.includes('一键恢复 1 篇'), '提示必须报"一键恢复 N 篇"，实际=' + tip);
      assert.ok(tip.includes('扫码换机'), '入口文案应为「扫码换机」，实际=' + tip);
      assert.ok(tip.includes('看不清就点一下码'), '末尾那半句必须有，实际=' + tip);
      // 🔴 反向：无 skipped 时不许凭空冒出空括号（老项目是三元，不是无条件拼）
      assert.ok(!tip.includes('（'), '无 skipped 时不许出现空括号，实际=' + tip);
    } finally {
      await page.close();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 甲案：清单写进云端一篇「备份笔记」，二维码只装它的链接（BAK-M 系列）
 *
 * 用户报障第2 条原文：「新版生成的二维码密度要比老版本密度大得多，
 * 我担心太密不容易识别出来」。
 * 用户 2026-10-07 拍板：「复刻老项目甲案（推荐）」。
 *
 * 🔴 老项目权威事实（notesync/index.html，只读，逐行标注）：
 *   - :801引导句「换机备份要用口令为专用的<b>备份笔记</b>派生密钥：<br>…」
 *   - :805 出码区是**两个独立**的 `p.qr-warn`：`#bakBakId`（备份笔记名）+ `#bakTip`（指引）
 *   - :817-827 `#bakRestMask` 只读恢复卡（清单绝不进 contenteditable，甲案闸①）
 *   - :8966-8968 字码表 'abcdefghijkmnpqrstuvwxyz23456789'（去 l/o/1/0）
 *   - :9043-9062 写云端三步顺序：①盐取自服务端 ②建档先写"空正文+带盐" ③解不开就作废本机钥
 *   - :9186-9190 出码后那两行文案
 *   - :9220-9234 enterBackupMode：只读卡、刻意不补焦点
 *   - :9262 hadBefore 必须在**写入前**取（否则「覆盖 N 篇」成永远在喊的假警报）
 *   - :9265-9267 合并顺序：**备份清单在前，本机已有并入尾部**
 *
 * 🔴🔴 为什么这组必须与 QR-F 分开（和 QR-F 自己那条注释同款理由）：
 *   QR-F 恢复的是「清单码 → 收藏夹」，恢复面是**收藏夹**；
 *   甲案恢复的是「备份笔记 → 只读卡 → 收藏夹」，中间多一层**只读卡**。
 *   那层只读卡正是误编辑三闸的第①闸，它一旦漏掉，症状是
 *   "备份清单变成一篇可编辑的普通笔记，用户改掉它，下次备份的就是改过的清单" ——
 *   没有任何一条 QR-F 判据能钉住它。
 * ═══════════════════════════════════════════════════════════════════════ */

test('BAK-M 甲案换机备份（清单进云端备份笔记，码只装链接）', async (t) => {
  const browser = h.browser();

  await t.test('BAK-M01 🔴🔴🔴 码长与篇数解耦：备份 1 篇与备份多篇，二维码载荷**完全一致**', async () => {
    // 🔴🔴 这是用户报障本身的直接判据。旧路线（清单进码）码长随篇数单调增长，
    //   量化结果：1篇 299B/13版/69格 → 100篇 2043B/41版/169格。
    //   老项目甲案恒定约 86B / 41 格。
    // 判据做法：**同一台页面**先把收藏从 1 篇加到 3 篇，各出一次码，
    //   断言两次码**逐字相等**（载荷恒定），且都不含清单内容。
    const page = await openEditor(browser, h.baseUrl(), 'bakm01a', PASS);
    let code1;
    let id1;
    try {
      await waitEditor(page);
      await favCurrent(page);
      const r1 = await page.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r1.ok, '收藏 1 篇时应能出码，实际=' + JSON.stringify(r1));
      assert.equal(r1.count, 1, '当次清单应是 1 篇，实际=' + r1.count);
      code1 = await getCode(page);
      id1 = r1.bakId;

      // 加到 3 篇（同一台页面、同一个备份槽 ⇒ 篇数是唯一变量）
      for (const n of ['bakm01b', 'bakm01c']) {
        const p2 = await openEditor(browser, h.baseUrl(), n, PASS);
        try {
          await waitEditor(p2);
          await favCurrent(p2);
        } finally {
          await p2.close();
        }
      }
      // 🔴 收藏是**本机**数据：上面两台是别的 context，收藏不在这一台的 localStorage。
      //   所以直接写本机收藏键（生产同一个键，见 07-fav 的 readFavs）。
      await page.evaluate(() => {
        const cur = JSON.parse(window.localStorage.getItem('notesync_bj_favs') || '[]');
        window.localStorage.setItem(
          'notesync_bj_favs',
          JSON.stringify([...cur, 'bakm01b', 'bakm01c']),
        );
      });
      const r3 = await page.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r3.ok, '收藏 3 篇时应能出码，实际=' + JSON.stringify(r3));
      assert.equal(r3.count, 3, '当次清单应是 3 篇，实际=' + r3.count);
      const code3 = await getCode(page);
      const id3 = r3.bakId;

      // 🔴 备份槽是复用的（老项目 :9091-9094同款）⇒ 篇名应当**相同**。
      //   不同的话，说明我们每次都新建了一篇备份笔记，云端会堆一堆孤儿。
      assert.equal(id3, id1, '同一台机器重复备份应复用同一个备份笔记篇名（老项目备份槽）');
      // 🔴🔴 核心承诺：载荷逐字恒定。篇数翻三倍，码一个字都不许变。
      assert.equal(code3, code1, '二维码载荷必须与篇数无关（这正是用户报障第2 条的正解）');
      // 反向：码里绝不许出现明文篇名（清单是加密的，篇名本身也是用户内容）
      assert.ok(!code1.includes('bakm01a'), '码里不许出现明文篇名');
      // 反向：也不许是旧路线的清单码前缀
      assert.ok(!code1.startsWith('nsfav1:'), '出码不该再走旧路线的清单码');
      assert.ok(!code1.startsWith('nsbak1:'), '出码不该是单篇换机码');
    } finally {
      await page.close();
    }
  });

  await t.test('BAK-M02 🔴🔴 云端确实有那篇备份笔记，且清单在里面（不是只在本地）', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'bakm02src', PASS);
    let bakId;
    try {
      await waitEditor(src);
      await favCurrent(src);
      const r = await src.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r.ok, '应能出码');
      bakId = r.bakId;
      assert.match(String(bakId), /^nsbak-[a-z0-9]{6}$/, '备份篇名形状不对（老项目 BAK_ID_RE 逐字）：' + bakId);
    } finally {
      await src.close();
    }

    // 🔴 从**另一台页面**直读服务端：那篇笔记必须真实存在、且是**信封**（密文）。
    //   这一步不可省：前面所有判据都在同一台机器上，"写云端"这件事本身
    //   可以完全没发生（写本地内存也能让判据全绿）。
    const dst = await openEditor(browser, h.baseUrl(), 'bakm02dst', PASS);
    try {
      await waitEditor(dst);
      const env = await dst.evaluate(async (id) => {
        const res = await fetch('/api/note/' + encodeURIComponent(id), {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        return { status: res.status, body: await res.text() };
      }, bakId);
      assert.equal(env.status, 200, '云端应能取到那篇备份笔记，实际=' + env.status);
      // 零知识红线：服务端只见密文
      const o = JSON.parse(env.body);
      assert.equal(typeof o.ct, 'string', '服务端存的应是密文 ct');
      assert.equal(typeof o.iv, 'string', '服务端存的应是 iv');
      assert.equal(typeof o.kdf?.salt, 'string', '信封必须带盐（老项目 :9048 建档先落盐）');
      // 🔴 反向：云端那份绝不许是明文清单
      assert.ok(!env.body.includes('bakm02src'), '云端那篇绝不许出现明文篇名');
      assert.ok(!/"k"|"key"|"rawKey"|"aesKey"/i.test(env.body), '云端那篇绝不许装密钥材料');
    } finally {
      await dst.close();
    }
  });

  await t.test('BAK-M03 🔴🔴🔴 扫到备份笔记链接 → 只读恢复卡，清单**绝不进 contenteditable**（甲案闸①）', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'bakm03src', PASS);
    let code;
    let bakId;
    try {
      await waitEditor(src);
      await favCurrent(src);
      const r = await src.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      code = await getCode(src);
      bakId = r.bakId;
    } finally {
      await src.close();
    }

    const dst = await openEditor(browser, h.baseUrl(), 'bakm03dst', PASS);
    try {
      await waitEditor(dst);
      // 🔴 走**生产扫码落地链路**（不是直接调内部函数）。
      //   headless 没有摄像头，__NOTESYNC_SCAN_RAW__ 是那条链路的正式入口。
      assert.equal(
        await dst.evaluate(() => typeof window.__NOTESYNC_SCAN_RAW__),
        'function',
        '扫码落地钩子必须存在（否则下面测的是另一条路）',
      );
      await dst.evaluate((c) => window.__NOTESYNC_SCAN_RAW__(c), code);
      await withTimeout(
        dst.waitForSelector('#bakRestMask', { timeout: 15_000 }),
        20_000,
        '等只读恢复卡',
      );

      // 🔴🔴 闸①的核心断言：**编辑器根本没挂**。
      //   老项目 enterBackupMode 至少还要先 contentEditable=false，
      //   bj 直接不挂 —— 那比"挂了再锁"少一整条漏锁的路径。
      //
      //   🔴🔴 判据自身踩过的坑（写下来防止有人"简化"回去）：
      //   我第一版写成 `document.getElementById('editor-host') === null`，
      //   而这条恒红 —— 因为 `openEditor` 打开的是一个**已经挂着编辑器**的页面
      //   （它打开的是 `bakm03dst` 这篇自己的笔记，编辑器早就在了）。
      //   扫到备份链接后编辑器**仍然在**（那篇笔记没被卸载，也没被替换）。
      //   ⇒ "编辑器不存在"根本不是这条功能的判据；
      //     真正的判据是**编辑器里没有清单**，且真源没被换成备份清单。
      //   下面三条按这个口径钉：恢复卡在 / 清单不在可编辑区 / 真源仍是本机那篇。
      const ed = await dst.evaluate(() => ({
        exists: document.getElementById('editor-host') !== null,
        text: document.getElementById('editor-host')?.textContent ?? '',
        doc: JSON.stringify(window.__NOTESYNC_DOC__?.() ?? null),
      }));
      assert.ok(
        !ed.text.includes('bakm03src'),
        '清单里的篇名绝不许出现在可编辑区（甲案闸①），实际可编辑区文本=' + ed.text.slice(0, 120),
      );
      // 🔴 真源必须是**本机那篇自己的**（bakm03dst），绝不能被换成备份清单
      const docObj = ed.doc ? JSON.parse(ed.doc) : null;
      const blocks = docObj?.blocks ?? [];
      const allText = blocks.map((b) => b.text || '').join('');
      assert.ok(
        !allText.includes('bakm03src') && !allText.includes('notesync-bak:1:'),
        '真源绝不许被换成备份清单（甲案闸①），实际=' + allText.slice(0, 120),
      );

      // 卡里的内容逐项对老项目 :817-827
      const card = await dst.evaluate(() => ({
        title: document.querySelector('#bakRestMask h1.qr-title')?.textContent ?? '',
        summary: document.getElementById('bakRestSummary')?.textContent ?? '',
        list: document.getElementById('bakRestList')?.textContent ?? '',
        warn: document.querySelector('#bakRestMask .ns-qr-warn')?.textContent ?? '',
        go: document.getElementById('bakRestGo')?.textContent ?? '',
        cancel: document.getElementById('bakRestCancel')?.textContent ?? '',
        listStyle: document.getElementById('bakRestList')?.style.cssText ?? '',
      }));
      assert.equal(card.title, '换机备份', '标题应是「换机备份」（老项目 :819 逐字）');
      assert.ok(card.summary.includes('含 1 篇笔记'), '摘要应报"含 N 篇笔记"，实际=' + card.summary);
      assert.ok(card.summary.includes('生成于'), '摘要应含生成时间（老项目 :9227），实际=' + card.summary);
      assert.equal(card.list, 'bakm03src', '清单应逐篇列出（老项目 #bakRestList）');
      // 🔴 老项目那行内联样式逐字（少任何一条的症状是"清单挤成一片/撑破弹窗"）
      for (const frag of [
        'max-height: 28vh',
        'overflow: auto',
        'text-align: left',
        'font-size: 12.5px',
        'line-height: 1.9',
        'white-space: pre-wrap',
        'word-break: break-all',
      ]) {
        assert.ok(
          card.listStyle.includes(frag),
          `清单那行内联样式缺「${frag}」（老项目逐字），实际=${card.listStyle}`,
        );
      }
      // 警示必须含那个 <br> 断句（老项目 :823 逐字）
      assert.ok(card.warn.includes('这里只能读取，不能编辑'), '警示首句不对，实际=' + card.warn);
      assert.ok(card.warn.includes('回到旧设备上点「扫码换机」'), '警示次句不对，实际=' + card.warn);
      // 🔴🔴 2026-10-09（用户报障第 8 条）：老项目那半句**逐字保留**，其后追加
      //   「旧设备不在手边时可在下方本机重建」—— 因为本卡下方新加了重建按钮。
      //   这条判据钉的就是"提示与本卡实际能力对得上"（说只能回旧设备 = 自相矛盾）。
      assert.ok(
        card.warn.includes('旧设备不在手边时可在下方本机重建'),
        '警示必须追加本机重建的去路（用户报障第 8 条），实际=' + card.warn,
      );
      assert.equal(card.go, '恢复这 1 篇', '恢复键文案应为「恢复这 N 篇」，实际=' + card.go);
      assert.equal(card.cancel, '先看看', '次键文案应为「先看看」（老项目 :825 逐字）');
      // 恢复键是主键（不是 ghost-btn），次键才是 ghost-btn（老项目同款）
      const btnCls = await dst.evaluate(() => ({
        go: document.getElementById('bakRestGo')?.className ?? '',
        cancel: document.getElementById('bakRestCancel')?.className ?? '',
      }));
      assert.ok(!btnCls.go.includes('ghost-btn'), '恢复键是主键，不该是 ghost-btn（老项目同款）');
      assert.ok(btnCls.cancel.includes('ghost-btn'), '「先看看」是次键，该带 ghost-btn（老项目同款）');
    } finally {
      await dst.close();
    }
  });

  await t.test('BAK-M04 🔴 恢复卡点「恢复这 N 篇」→ 收藏夹并入，备份清单在前（老项目 :9265-9267）', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'bakm04old', PASS);
    let code;
    try {
      await waitEditor(src);
      await favCurrent(src);
      const r = await src.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      code = await getCode(src);
    } finally {
      await src.close();
    }

    const dst = await openEditor(browser, h.baseUrl(), 'bakm04mine', PASS);
    try {
      await waitEditor(dst);
      await favCurrent(dst);
      assert.deepEqual(await readFavs(dst), ['bakm04mine'], '新设备本机收藏应只有自己那篇');

      // 🔴 走真实用户路径：扫 → 点「恢复这 N 篇」（不是直接调内部合并函数）
      await dst.evaluate((c) => window.__NOTESYNC_SCAN_RAW__(c), code);
      await withTimeout(dst.waitForSelector('#bakRestGo', { timeout: 15_000 }), 20_000, '等恢复卡');
      await withTimeout(dst.click('#bakRestGo'), 8_000, '点恢复');

      // 老项目 :9274-9278：恢复完**整页跳第一篇**
      await withTimeout(
        dst.waitForFunction(() => location.pathname === '/bakm04old', null, { timeout: 15_000 }),
        20_000,
        '恢复后应整页跳第一篇（老项目 :9274-9278）',
      );
      const favs = await readFavs(dst);
      // 🔴 合并顺序：备份清单在前，本机已有并入尾部
      assert.deepEqual(
        favs,
        ['bakm04old', 'bakm04mine'],
        '备份清单应在前、本机并入尾部（老项目 :9265-9267），实际=' + JSON.stringify(favs),
      );
    } finally {
      await dst.close();
    }
  });

  await t.test('BAK-M05 🔴🔴 反向闸 A：普通笔记链接绝不许进只读恢复卡', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'bakm05plain', PASS);
    try {
      await waitEditor(page);
      await typeBody(page, ['普通笔记正文']);
      // 🔴 走**生产出码口**拿这条笔记的配对链接：点顶栏「扫码配对」（#qrBtn）。
      //   我第一版写的是 `__NOTESYNC_MIGRATE_CODE__()` —— 那是**换机码**（nsbak1:），
      //   不是配对链接，于是 `__NOTESYNC_PARSE_PAIR__` 判 not-pair，
      //   判据自己先崩了（前置断言失败），测的根本不是这条功能。
      await page.click('#qrBtn');
      await withTimeout(page.waitForSelector('#pairMask', { timeout: 8000 }), 10_000, '等配对浮层');
      await withTimeout(page.waitForSelector('#qrCanvas', { timeout: 15_000 }), 20_000, '等配对码');
      // 🔴🔴 取码只能走 `__NOTESYNC_PAIR_CODE__`（本轮补的正式取码口）。
      //   配对链接是**画在 canvas 上的**（`scan/panel.ts:227`），DOM 里读不到；
      //   点码进的 `#qrLarge` 里那张 canvas 同样**不带 data-code**
      //   （`showLarge` 只调 drawQr）—— 我第一版去那里摸data-code，
      //   摸了 0 次才被迫回落，白写 20 行。
      //   判据绝不许手写第二份 buildPairLink去"算出"那条链接。
      const plainLink = await page.evaluate(() => window.__NOTESYNC_PAIR_CODE__?.() ?? '');
      assert.ok(plainLink, '必须能从生产链路取到这条笔记的配对链接（否则这条判据是空转）');
      const parsed = await page.evaluate((c) => window.__NOTESYNC_PARSE_PAIR__(c), plainLink);
      assert.ok(parsed.ok, '生产链接应能被生产解析器收下，实际=' + JSON.stringify(parsed));
      assert.equal(parsed.noteId, 'bakm05plain', '链接就该指向这篇普通笔记');
      // 🔴 前置自证：这条链接的篇名**不符合**备份篇名形状（否则这条判据就是空转）
      assert.ok(
        !/^nsbak-[a-z0-9]{6}$/.test(parsed.noteId),
        '前置：本条用的篇名不该是备份篇名形状',
      );
      await page.keyboard.press('Escape'); // 关配对浮层

      // 🔴🔴 等同步落定再扫：扫码落地会重拉云端，本地没推上去的编辑会被旧版本覆盖。
      //   那道闸加在这里，才让下面的正文断言钉的是"分流没吞正文"。
      await waitSyncIdle(page);

      await page.evaluate((c) => window.__NOTESYNC_SCAN_RAW__(c), plainLink);
      await withTimeout(page.waitForSelector('#editor-host', { state: 'attached' }), 10_000, '等编辑器');
      // 反向：恢复卡绝不许出现
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(
        await page.evaluate(() => document.getElementById('bakRestMask') !== null),
        false,
        '普通笔记链接绝不许进只读恢复卡（那是备份笔记专属）',
      );
      // 正文必须还在（没被恢复卡吃掉）
      const doc = await page.evaluate(() => JSON.stringify(window.__NOTESYNC_DOC__()));
      assert.ok(doc.includes('普通笔记正文'), '普通笔记正文必须还在');
    } finally {
      await page.close();
    }
  });

  await t.test('BAK-M06 🔴🔴 反向闸 B：错误口令既不进恢复卡，也**不许写任何东西**', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'bakm06src', PASS);
    let code;
    try {
      await waitEditor(src);
      await favCurrent(src);
      const r = await src.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      code = await getCode(src);
    } finally {
      await src.close();
    }

    const dst = await openEditor(browser, h.baseUrl(), 'bakm06dst', PASS);
    try {
      await waitEditor(dst);
      await favCurrent(dst);
      await typeBody(dst, ['口令错不许动我的正文']);
      const before = await readFavs(dst);
      const docBefore = await canon(dst);
      // 把链接里的口令改错（老项目那条安全不变量：失败文案不区分原因）
      const bad = code.replace(/#p=.*$/, '#p=' + encodeURIComponent('错的口令'));
      assert.notEqual(bad, code, '前置：口令替换必须真的改动了链接');

      await dst.evaluate((c) => window.__NOTESYNC_SCAN_RAW__(c), bad);
      await new Promise((r) => setTimeout(r, 5000));

      const st = await dst.evaluate(() => ({
        card: document.getElementById('bakRestMask') !== null,
        doc: window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()),
      }));
      // 🔴 失败路径上不得有任何写入：收藏夹一个字节都不能变
      assert.deepEqual(await readFavs(dst), before, '🔴 口令错时收藏夹必须原封不动');
      // 🔴🔴 正文真源必须**逐字不变**（本项目最危险的故障形态：恢复失败但原文被清空）。
      //   🔴 我第一版写的是 `st.doc.includes('bakm06dst')` —— 篇名根本不在真源 JSON 里
      //   （真源只有 blocks），那条断言恒红，纯属判据自己写错前提。
      //   正确口径是**与扫描前逐字比对**（canon 是生产那份 canonicalize）。
      assert.equal(st.doc, docBefore, '🔴 口令错时正文真源必须逐字不变');
      // 恢复卡绝不许开（清单根本没解开）
      assert.equal(st.card, false, '口令错时绝不许开只读恢复卡');
    } finally {
      await dst.close();
    }
  });

  await t.test('BAK-M07 🔴🔴 反向闸 C：备份槽自身绝不出现在清单里（否则换机后凭空多一篇）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'bakm07', PASS);
    try {
      await waitEditor(page);
      await favCurrent(page);
      const r = await page.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      const bakId = r.bakId;
      const slot = await page.evaluate(() => window.__NOTESYNC_BAK_SLOT__());
      // 备份槽必须真被记下来了（否则下面那条断言是空转）
      assert.ok(slot, '出码后本机必须记住备份槽（老项目 :9091-9094）');
      assert.equal(slot.id, bakId, '备份槽记的篇名必须就是这次的备份篇名');

      // 🔴 人为把备份槽塞进收藏夹，模拟"上一轮留下的收藏里混进了备份笔记"
      await page.evaluate((id) => {
        const cur = JSON.parse(window.localStorage.getItem('notesync_bj_favs') || '[]');
        window.localStorage.setItem('notesync_bj_favs', JSON.stringify([...cur, id]));
      }, bakId);
      const src = await page.evaluate(() => window.__NOTESYNC_FAVBAK_SOURCE__());
      assert.ok(src.includes(bakId), '前置：备份篇名此刻确实在收藏夹里');

      // 再出一次码，清单里不该有它
      const r2 = await page.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r2.ok);
      // 清单里仍只有那一篇真笔记（备份槽被剔掉）
      assert.equal(r2.count, 1, '备份槽自身必须被剔出清单（否则换机后凭空多一篇），实际篇数=' + r2.count);
    } finally {
      await page.close();
    }
  });

  await t.test('BAK-M08 🔴🔴 清单容量必须**吃得下整个收藏夹**（收藏夹上限 100 = 清单上限 100）', async () => {
    const cap = await (async () => {
      const page = await openEditor(browser, h.baseUrl(), 'bakm08cap', PASS);
      try {
        await waitEditor(page);
        return await page.evaluate(() => window.__NOTESYNC_BAK_CAP__());
      } finally {
        await page.close();
      }
    })();
    // 老项目 BAK_MAX = 100（逐字，见 :9189 的「超 N 篇未含 M 篇」）
    assert.equal(cap, 100, '甲案清单上限应为 100（老项目 BAK_MAX 逐字），实际=' + cap);

    const page = await openEditor(browser, h.baseUrl(), 'bakm08', PASS);
    try {
      await waitEditor(page);
      await favCurrent(page);
      // 🔴🔴 造 150 篇收藏 —— **超过**清单上限。
      //   🔴 我第一版在这里断言"必须被拒（too-long）"，恒红。查清原因是：
      //   收藏夹自己就有 FAVS_MAX=100 的上限（fav/favs.ts:65 normalizeFavs 里 break），
      //   于是无论塞多少篇，`collectBakEntries` 拿到的**永远 ≤ 100**，
      //   而清单上限也正好是 100 ⇒ **超限分支在 bj 里根本不可达**。
      //   ⇒ 这不是"实现漏了拒绝"，而是"两个上限相等，超限不可能发生"。
      //   真正该钉的是这个**不变式**：清单装得下整个收藏夹，一个字节都不截。
      //   （`encodeBakText` 那个超限返回 null 的分支由 bak-note.test.mjs BAK-NOTE-16/17 钉，
      //   那里能直接喂超限数组，不必绕这一圈。）
      await page.evaluate(() => {
        const many = Array.from({ length: 150 }, (_, i) => 'bakm08n' + String(i).padStart(3, '0'));
        window.localStorage.setItem('notesync_bj_favs', JSON.stringify(many));
      });
      const srcCount = await page.evaluate(() => window.__NOTESYNC_FAVBAK_SOURCE__().length);
      assert.equal(srcCount, 100, '收藏夹应按FAVS_MAX=100 收口（收藏侧先截断）');

      const r = await page.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r.ok, '满收藏夹必须能出码（清单容量吃得下收藏夹）');
      // 🔴 关键：装进去的篇数必须与收藏夹**相等**，不许少一篇。
      //   少一篇的症状极其隐蔽 —— 用户以为 100 篇全备份了，
      //   换机后少了那几篇他自己永远不会知道（收藏夹里看不出区别）。
      assert.equal(r.count, 100, '清单必须装下全部 100 篇，一个都不许截');
    } finally {
      await page.close();
    }
  });

  await t.test('BAK-M09 🔴 备份槽缺失时能重建（老项目 :9048 建档先落盐再写真身）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'bakm09', PASS);
    try {
      await waitEditor(page);
      await favCurrent(page);
      // 人为清掉备份槽：模拟"换机后第一次生成"或"清过站点数据"
      await page.evaluate(() => window.localStorage.removeItem('notesync_bak_slot'));
      assert.equal(await page.evaluate(() => window.__NOTESYNC_BAK_SLOT__()), null, '前置：备份槽应已被清掉');

      const r = await page.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r.ok, '没有备份槽也必须能出码（老项目允许首次建档），实际=' + JSON.stringify(r));
      assert.match(String(r.bakId), /^nsbak-[a-z0-9]{6}$/, '新篇名形状不对');
      // 🔴 建档那一枪必须**先落盐**（老项目 :9048）。
      //   漏掉②的症状不是报错，而是"另一台设备打开这篇备份笔记时解不开" ——
      //   它拿到的信封里没有 kdf.salt，无从派生。
      const env = await page.evaluate(async (id) => {
        const res = await fetch('/api/note/' + encodeURIComponent(id), { cache: 'no-store' });
        return res.text();
      }, r.bakId);
      const o = JSON.parse(env);
      assert.equal(typeof o.kdf?.salt, 'string', '新建的那篇必须带盐（老项目 :9048 建档先落盐）');
      assert.ok(o.kdf.iter >= 600000, '迭代次数应不少于 600000，实际=' + o.kdf.iter);
    } finally {
      await page.close();
    }
  });

  await t.test('BAK-M10 🔴🔴 第二次备份必须复用盐（换盐 = 另一把钥匙，必然解不开）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'bakm10', PASS);
    try {
      await waitEditor(page);
      await favCurrent(page);
      const r1 = await page.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r1.ok);
      const env1 = JSON.parse(
        await page.evaluate(async (id) => {
          const res = await fetch('/api/note/' + encodeURIComponent(id), { cache: 'no-store' });
          return res.text();
        }, r1.bakId),
      );
      const salt1 = env1.kdf.salt;

      // 同一篇、同一个口令，再出一次码
      const r2 = await page.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r2.ok);
      const env2 = JSON.parse(
        await page.evaluate(async (id) => {
          const res = await fetch('/api/note/' + encodeURIComponent(id), { cache: 'no-store' });
          return res.text();
        }, r2.bakId),
      );
      // 🔴 盐取自服务端（有则必用，绝不用本机新盐冲掉服务端盐）——老项目 :9043。
      //   换盐的症状：旧设备能扫（它有本机那把钥），新设备解不开（它只有口令）。
      assert.equal(env2.kdf.salt, salt1, '第二次备份必须沿用服务端那把盐（老项目 :9043）');
      // 反向：正文确实被换了（不能因为"盐没变"就整篇没写）
      assert.notEqual(env2.ct, env1.ct, '第二次备份必须真的重写了正文（不能只更新版本号）');
    } finally {
      await page.close();
    }
  });

  await t.test('BAK-M11 🔴 恢复卡上「先看看」→ 关卡，**刻意不还编辑器焦点**（老项目 :9238）', async () => {
    const src = await openEditor(browser, h.baseUrl(), 'bakm11src', PASS);
    let code;
    try {
      await waitEditor(src);
      await favCurrent(src);
      const r = await src.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      code = await getCode(src);
    } finally {
      await src.close();
    }

    const dst = await openEditor(browser, h.baseUrl(), 'bakm11dst', PASS);
    try {
      await waitEditor(dst);
      await dst.evaluate((c) => window.__NOTESYNC_SCAN_RAW__(c), code);
      await withTimeout(dst.waitForSelector('#bakRestCancel', { timeout: 15_000 }), 20_000, '等恢复卡');
      await withTimeout(dst.click('#bakRestCancel'), 8_000, '点先看看');
      await withTimeout(
        dst.waitForFunction(() => document.getElementById('bakRestMask') === null, null, { timeout: 5000 }),
        8_000,
        '等恢复卡关闭',
      );
      // 🔴 点遮罩空白**不关**（老项目 #bakRestMask 没有那条路径）。
      //   误触关掉等于让用户以为自己扫了个空笔记，得重扫一次。
      assert.equal(
        await dst.evaluate(() => document.getElementById('bakRestMask') === null),
        true,
        '点「先看看」后恢复卡应关闭',
      );
      // 收藏夹一个字节都不能变（"先看看"就是先看看）
      assert.deepEqual(await readFavs(dst), [], '「先看看」绝不许恢复任何东西');
      // 🔴🔴 恢复卡关掉后绝不许把清单漏进编辑器/真源。
      //   🔴 我第一版写的是 `editor-host === null`，恒红 —— 因为这一页
      //   本来就打开着 `bakm11dst` 那篇自己的笔记（openEditor 已经挂了编辑器），
      //   "编辑器不存在"根本不是这条功能的判据。
      //   真正的判据是**清单一个字都没进可编辑区与真源**。
      const after = await dst.evaluate(() => ({
        text: document.getElementById('editor-host')?.textContent ?? '',
        doc: window.__NOTESYNC_CANON__(window.__NOTESYNC_DOC__()),
      }));
      assert.ok(
        !after.text.includes('bakm11src'),
        '恢复卡关掉后清单绝不许漏进可编辑区，实际=' + after.text.slice(0, 120),
      );
      assert.ok(
        !after.doc.includes('notesync-bak:1:') && !after.doc.includes('bakm11src'),
        '恢复卡关掉后真源绝不许是备份清单，实际=' + after.doc.slice(0, 120),
      );
    } finally {
      await dst.close();
    }
  });

  await t.test('BAK-M13 🔴🔴 甲案不许抢走**旧码**的分流：nsfav1: / nsbak1: 仍能解（历史码不能作废）', async () => {
    // 🔴🔴 为什么必须钉这条：甲案把 `tryEnterBakMode` 插进了 `handleScanRaw`，
    //   而旧收藏码（nsfav1:）与旧单篇码（nsbak1:）也走同一个入口。
    //   判"前缀互不为前缀所以不会撞"是**读码推断**，不是判据 ——
    //   一旦有人调整分流顺序，用户手里的历史码会静默变成一句"口令不对"，
    //   症状与"口令输错"一模一样，用户会反复重输而永远查不出原因。
    //   所以钉**用户可见的最终结果**：扫旧码必须打开旧恢复面板。
    const src = await openEditor(browser, h.baseUrl(), 'bakm13src', PASS);
    let favCode;
    let oneCode;
    try {
      await waitEditor(src);
      // 🔴 必须先有正文：旧单篇码走 `buildMigrateCode`，它对 `canonicalize(doc)===''`
      //   直接返回 'empty'（migrate/code.ts:168）。空笔记造不出单篇码——
      //   我第一版没打字就断言造码成功，判据自己先崩了。
      await typeBody(src, ['旧单篇码的正文']);
      await favCurrent(src);
      // 旧收藏清单码（走生产实现本体）
      const f = await src.evaluate((p) => window.__NOTESYNC_FAVBAK_MAKE__(p), PASS);
      assert.ok(f.ok, '前置：旧收藏码应生成成功');
      favCode = await src.evaluate(() => window.__NOTESYNC_MIGRATE_CODE__());
      assert.ok(favCode.startsWith('nsfav1:'), '前置：应是旧收藏码，实际前缀=' + favCode.slice(0, 8));
      // 旧单篇换机码
      const m = await src.evaluate((p) => window.__NOTESYNC_MIGRATE_MAKE__(p), PASS);
      assert.ok(m.ok, '前置：旧单篇码应生成成功，实际=' + JSON.stringify(m));
      oneCode = await src.evaluate(() => window.__NOTESYNC_MIGRATE_CODE__());
      assert.ok(oneCode.startsWith('nsbak1:'), '前置：应是旧单篇码，实际前缀=' + oneCode.slice(0, 8));
    } finally {
      await src.close();
    }

    for (const [label, code, capId] of [
      ['旧收藏码 nsfav1:', favCode, 'fav'],
      ['旧单篇码 nsbak1:', oneCode, 'one'],
    ]) {
      const dst = await openEditor(browser, h.baseUrl(), 'bakm13' + capId, PASS);
      try {
        await waitEditor(dst);
        await dst.evaluate((c) => window.__NOTESYNC_SCAN_RAW__(c), code);
        // 旧码必须打开**旧恢复面板**（#migrateMask），不是只读恢复卡
        await withTimeout(
          dst.waitForSelector('#migrateMask', { timeout: 15_000 }),
          20_000,
          `${label} 必须打开旧恢复面板`,
        );
        const got = await dst.evaluate(() => ({
          mask: !!document.getElementById('migrateMask'),
          code: document.getElementById('migrateCodeIn')?.value ?? '',
          bakCard: !!document.getElementById('bakRestMask'),
        }));
        assert.equal(got.mask, true, `${label} 应打开旧恢复面板`);
        // 扫到的码必须**原样**填进输入框（用户只需输口令）
        assert.equal(got.code, code, `${label} 必须被填进恢复面板的码框`);
        // 🔴 反向：旧码绝不许被甲案分流劫持进只读恢复卡
        assert.equal(got.bakCard, false, `${label} 绝不许被甲案分流进只读恢复卡`);
      } finally {
        await dst.close();
      }
    }
  });

  await t.test('BAK-M12 🔴 整轮零页面异常', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'bakm12', PASS);
    const errs = [];
    const cerrs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    page.on('console', (m) => {
      if (m.type() === 'error') cerrs.push(m.text());
    });
    try {
      await waitEditor(page);
      await favCurrent(page);
      const r = await page.evaluate((p) => window.__NOTESYNC_BAK_MAKE__(p), PASS);
      assert.ok(r.ok);
      const code = await getCode(page);
      await page.evaluate((c) => window.__NOTESYNC_SCAN_RAW__(c), code);
      await withTimeout(page.waitForSelector('#bakRestMask', { timeout: 15_000 }), 20_000, '等恢复卡');
      assert.deepEqual(errs, [], `出现页面异常：${errs.join(' | ')}`);
      assert.deepEqual(cerrs, [], `出现 console.error：${cerrs.join(' | ')}`);
    } finally {
      await page.close();
    }
  });
});

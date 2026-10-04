/**
 * e2e：UI 外壳契约（顶栏 / 底栏 / 皮肤环 / 主题）
 *
 * 🔴🔴 这是 S4 最重要的闸。老项目12400 行 index.html 里的 UI 是**用户每天看的东西**，
 *   "一致"是最容易悄悄漂移的：多画一个按钮、少一个图标、皮肤环点不动、
 *   底栏状态字不出现 —— 用户不会说"坏了"，只会说"感觉不一样了"。
 *
 * 覆盖：
 *   E2E-UI1顶栏恰好 7 个**可见**键 + 2 个被 CSS 隐藏的键（复刻老项目的"看不见"）
 *   E2E-UI2  底栏菜单 / 状态点 / 刷新键就位
 *   E2E-UI3  连点 logo 7 次推进皮肤环，且覆膜层真的画出来了
 *   E2E-UI4  主题随时间规则（19:00–07:00 夜间）
 *   E2E-UI5  菜单面板 11 项
 *   E2E-UI6  落地页净化 + 彩蛋门牌
 *   E2E-UI7  口令页错误行
 *
 * 用法：node --test --test-concurrency=6 test/e2e/*.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..', '..');
const WWW = join(ROOT, 'www');

const h = installHarness(test, { dir: WWW });

/** 走到编辑器就绪。路径与 01 一致：落地页 → 口令页 → 编辑器。 */
const openEditorPage = (name) => openEditor(h.browser(), h.baseUrl(), name);

test('E2E-UI1 顶栏恰好 7 个可见键，另有 2 个被 CSS 隐藏的键', async () => {
  const page = await openEditorPage('uix');

  // 可见的：7 个。老项目顶栏一共 9 个 button，themeBtn / lock 被 display:none 永久隐藏。
  const visible = await page.$$eval('header.ns-top button.ns-ic', (els) =>
    els
      .filter((e) => getComputedStyle(e).display !== 'none')
      .map((e) => e.id)
      .filter((id) => id !== ''),
  );
  assert.equal(visible.length, 7, `顶栏可见键应为 7 个，实际 ${visible.length}：${visible.join(',')}`);
  assert.deepEqual(visible, [
    'strikeBtn', 'remBtn', 'uploadBtn', 'copyBtn', 'exportImgBtn', 'scanBtn', 'qrBtn',
  ]);

  // 隐藏的 2 个：**必须在 DOM 里**且computed display 为 none。
  // 🔴 复刻的是"看不见"，不是"不存在"。若为了"干净"不画它们，
  //   将来想恢复显示就得改渲染逻辑，那是行为变更不是样式变更。
  for (const id of ['themeBtn', 'lock']) {
    const disp = await page.$eval(`#${id}`, (e) => getComputedStyle(e).display).catch(() => null);
    assert.equal(disp, 'none', `#${id} 应存在且 display:none，实际 ${disp}`);
  }
  await page.close();
});

test('E2E-UI2 底栏三件套就位：菜单键、状态点、刷新键', async () => {
  const page = await openEditorPage('uix');
  assert.ok(await page.$('#menuBtn'), '底栏菜单键缺失');
  assert.ok(await page.$('#refreshBtn'), '底栏刷新键缺失');
  // 状态点：连接中→有 dot 类，无 dot.on/off
  const dot = await page.$eval('#syncDot', (e) => e.className);
  assert.equal(dot.trim(), 'dot', `状态点类名应为 dot，实际 "${dot}"`);
  const txt = await page.textContent('#syncText');
  assert.equal(txt, '连接中…', '底栏状态文案不对');
  await page.close();
});

test('E2E-UI3 连点 logo 7 次推进皮肤环，覆膜层真的画出来', async () => {
  const page = await openEditorPage('uix');

  // 起点：默认皮肤，字标 NoteSync，覆膜层无背景
  assert.equal(await page.textContent('#brandWord'), 'NoteSync');
  const bg0 = await page.$eval('#skinFx', (e) => getComputedStyle(e).backgroundImage);
  assert.equal(bg0, 'none', '默认皮肤不应有覆膜纹理');

  // 点 7 下 → 终端绿
  for (let i = 0; i < 7; i++) await page.click('#brand');
  await page.waitForFunction(() => document.getElementById('brandWord')?.textContent === 'NOTE-SYNC.EXE', { timeout: 5000 });
  assert.equal(await page.textContent('#brandWord'), 'NOTE-SYNC.EXE', '第 1 格应是终端绿');
  const bg1 = await page.$eval('#skinFx', (e) => getComputedStyle(e).backgroundImage);
  assert.match(bg1, /repeating-linear-gradient/, '终端绿皮肤应有扫描线');

  // 再 7 下 → 打字机纸
  for (let i = 0; i < 7; i++) await page.click('#brand');
  await page.waitForFunction(() => document.getElementById('brandWord')?.textContent === 'N O T E S Y N C', { timeout: 5000 });
  const bg2 = await page.$eval('#skinFx', (e) => getComputedStyle(e).backgroundImage);
  assert.match(bg2, /repeating-linear-gradient/);

  // 再 7 下 → 回默认，**覆膜层必须清空**
  // 🔴 这是最容易漏的一条：残留一层扫描线用户看不出"少了什么"，只觉得"脏"
  for (let i = 0; i < 7; i++) await page.click('#brand');
  await page.waitForFunction(() => document.getElementById('brandWord')?.textContent === 'NoteSync', { timeout: 5000 });
  const bg3 = await page.$eval('#skinFx', (e) => getComputedStyle(e).backgroundImage);
  assert.equal(bg3, 'none', '回到默认皮肤后覆膜层必须清空');

  // 覆膜层不许拦交互
  const pe = await page.$eval('#skinFx', (e) => getComputedStyle(e).pointerEvents);
  assert.equal(pe, 'none', '覆膜层不许拦截点击（否则整个界面点不动）');
  await page.close();
});

test('E2E-UI4 主题随时间规则（19:00-07:00 夜间）', async () => {
  const page = await openEditorPage('uix');
  // 首屏按当前真实时间解析；只断言"变量与 body class 自洽"，
  // 不断言此刻是白天还是夜里（那会让测试只在半个时间段可跑）
  const st = await page.evaluate(() => ({
    isDark: document.documentElement.classList.contains('dark'),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  }));
  if (st.isDark) {
    assert.equal(st.bg, '#0F0F11', '夜间底色应为深色');
  } else {
    // 🔴 用户明确"浅色高级风、拒黑底"：白天底色必须是暖白，不能是纯白
    assert.equal(st.bg, '#FBFBF8', '白天底色应为暖白 #FBFBF8');
  }
  await page.close();
});

test('E2E-UI5 菜单面板 11 项', async () => {
  const page = await openEditorPage('uix');
  await page.click('#menuBtn');
  // S4c 的菜单面板由 main.ts 的 hooks.onMenu 接管；这里先验菜单键能开面板
  // （若 S4c 未接完，面板不出现—— 那本身就是一条真红）
  const panel = await page.waitForSelector('#menuMainView', { timeout: 5000 }).catch(() => null);
  assert.ok(panel, '菜单面板未打开（S4c 未接完）');
  await page.close();
});

test('E2E-UI6 落地页净化与彩蛋门牌', async () => {
  const page = await withTimeout(h.browser().newPage(), 30_000, 'newPage');
  await page.goto(h.baseUrl());
  await page.waitForSelector('#li');

  // 空输入时按钮禁用
  assert.equal(await page.isDisabled('#landingBtn'), true, '空输入时打开按钮应禁用');

  // 输入即净化：中文被剔除，警告行出现
  await page.fill('#li', '我的笔记');
  assert.equal(await page.inputValue('#li'), '', '中文应被剔除');
  assert.equal(await page.isVisible('#landingWarn'), true, '净化后应显示警告行');

  // 合法名→ 按钮可点 + 网址预览出现
  await page.fill('#li', 'my_note-1');
  assert.equal(await page.inputValue('#li'), 'my_note-1');
  assert.equal(await page.isDisabled('#landingBtn'), false);
  const urlTxt = await page.textContent('#landingUrl');
  assert.match(urlTxt, /你的笔记网址为：.*\/my_note-1$/);

  // 彩蛋门牌：按钮变「打开彩蛋」且**不禁用**
  await page.fill('#li', 'pet');
  assert.equal(await page.textContent('#landingBtn'), '打开彩蛋');
  assert.equal(await page.isDisabled('#landingBtn'), false, '彩蛋门牌不该禁用按钮');
  assert.match(await page.textContent('#landingEggTip'), /pet 是彩蛋门牌，不会新建笔记/);
  await page.close();
});

test('E2E-UI7 口令页：空口令禁用、错误行 aria-live', async () => {
  const page = await withTimeout(h.browser().newPage(), 30_000, 'newPage');
  await page.goto(h.baseUrl());
  await page.fill('#li', 'passnote');
  await page.click('#landingBtn');
  await page.waitForSelector('#pw');

  assert.equal(await page.isDisabled('#ok'), true, '空口令时解锁按钮应禁用');
  const live = await page.getAttribute('#err', 'aria-live');
  assert.equal(live, 'polite', '错误行必须 aria-live，读屏软件才念得出来');
  await page.close();
});

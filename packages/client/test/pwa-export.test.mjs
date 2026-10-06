/**
 * PWA + 导出到微信 —— 判据（PWA- / EXP-W 系列）
 *
 * 用户报障：
 *   第 12 条「网页端不支持生成 PWA」
 *   第 13 条「导出为图片并复制，移动端没法复制到微信里」
 *
 * 🔴 这两条的性质与纯视觉项不同：
 *   第 12 条是**功能完全缺失**（manifest link / manifest.json / 图标 / 安装引导条四件全缺），
 *   症状是"能装的却装不上"，且**零报错**。
 *   第 13 条的根因是**移动端几乎必然落在全屏预览档**，而预览层只有一句泛用提示，
 *   用户不知道要长按才能进微信。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPY } from '../src/ui/copy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const STATIC = resolve(HERE, '..', 'static');

const readSrc = (rel) => readFileSync(resolve(SRC, rel), 'utf8');
const CSS_BODY = readFileSync(resolve(SRC, 'ui/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function rule(selector) {
  const m = CSS_BODY.match(
    new RegExp('(^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'),
  );
  return m ? m[2].trim() : '';
}

/* ---------------- 第 12 条：PWA ---------------- */

test('PWA-01 manifest 必须齐：文件 + link + 图标（老项目 index.html:20 + 6522-6531 同款结构）', () => {
  const mf = resolve(STATIC, 'manifest.json');
  assert.ok(existsSync(mf), 'manifest.json 不存在 ⇒ 浏览器不认为这是可安装应用（用户报障第 12 条）');
  const j = JSON.parse(readFileSync(mf, 'utf8'));
  assert.equal(j.display, 'standalone', '必须是 standalone（装完才有"像 App 一样"的窗口形态）');
  assert.equal(j.name, 'NoteSync');
  assert.equal(j.theme_color, '#FBFBF8', '主题色是老项目的浅色底，不是随手挑的');
  assert.equal(j.background_color, '#FBFBF8');
  assert.ok(Array.isArray(j.icons) && j.icons.length >= 2, '至少两枚图标（192 + 512）');
  const sizes = j.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), '缺 192 图标');
  assert.ok(sizes.includes('512x512'), '缺 512 图标');
  assert.ok(
    j.icons.some((i) => String(i.purpose || '').includes('maskable')),
    '至少一枚 maskable（安卓自适应图标裁切时不能留白）',
  );
  // 🔴 反向：icon 的 src 必须**真实存在**，否则装完是空白方块
  for (const i of j.icons) {
    const p = resolve(STATIC, i.src.replace(/^\//, ''));
    assert.ok(existsSync(p), `manifest 引用的图标不存在：${i.src}（症状：装完是浏览器默认图标）`);
  }
});

test('PWA-02 构建产物必须有 manifest link 与三枚 apple meta（老项目 :16-20）', () => {
  const build = readSrc('../../../tools/build.mjs');
  assert.match(build, /rel="manifest"/, '缺 manifest link ⇒ 页面不被识别为可安装应用');
  assert.match(build, /apple-mobile-web-app-capable/);
  assert.match(build, /apple-mobile-web-app-status-bar-style/);
  assert.match(build, /apple-mobile-web-app-title/);
  assert.match(build, /apple-touch-icon/);
  // 🔴 反向：manifest.json 与三枚图标必须在"必需清单"里。
  //   不在清单里 = 物化阶段漏了也照样"构建成功"，问题一路飘到线上。
  for (const must of ['manifest.json', 'icons/icon-192.png', 'icons/icon-512.png']) {
    assert.ok(
      build.includes(`'${must}'`),
      `构建必需清单缺 ${must}：物化漏掉时构建不会报错（老项目 static 同款清单纪律）`,
    );
  }
});

test('PWA-03 🔴 构建必须递归物化子目录（icons/），否则图标 404 且构建日志一切正常', () => {
  const build = readSrc('../../../tools/build.mjs');
  // 🔴 这条是本批实际踩到的坑：物化用 readdir 只列一层，`icons/` 里的图标不会进 www/。
  //   症状极隐蔽 —— manifest 在、link 在、图标 404，构建日志一片正常。
  assert.match(
    build,
    /readdir\(full\)|readdir\(join\(STATIC_SRC/,
    '物化必须处理子目录（icons/ 里的 PWA 图标）',
  );
  assert.match(build, /isDirectory\(\)/, '要判断条目是不是目录才能递归');
  assert.match(build, /mkdir\(join\(WWW, dir\)/, '递归前必须先建目标目录');
});

test('PWA-04 SW 缓存名必须由注册 URL 的 ?v= 驱动，不能写死（老项目 sw.js:4-5）', () => {
  const sw = readFileSync(resolve(STATIC, 'sw.js'), 'utf8');
  // 🔴🔴🔴 必须**去注释后**再判。
  //   sw.js 的文件头注释里就写着 `const VER = (new URL(...).searchParams.get('v'))`
  //   —— 那是"解释为什么这么写"的说明，不是代码。第一版判据直接读原文，
  //   于是把注释当成了实现：`doesNotMatch(/const VERSION = 'v1'/)` 恒绿，
  //   真正把 `const VER` 换成写死的注入反而测不出来（反向验证当场抓到了）。
  //   同款纪律见 memory：断言"某段代码不存在/存在"时，输入必须是去注释的代码。
  const swCode = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(
    swCode,
    /searchParams\.get\(['"]v['"]\)/,
    'sw.js 必须从自身 URL 读 ?v= 决定缓存名',
  );
  assert.doesNotMatch(swCode, /const VER\s*=\s*['"]/, '禁止写死缓存版本号');
  // 外壳清单必须含 manifest 与图标，否则离线时安装横幅拿不到
  for (const a of ['./manifest.json', './icons/icon-192.png', './icons/icon-512.png']) {
    assert.ok(swCode.includes(a), `SW 外壳清单缺 ${a}（离线时该资源取不到）`);
  }
  // 注册侧必须真的传了 ?v=（同样去注释）
  const mainCode = readSrc('main.ts').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(mainCode, /sw\.js\?v=/, '注册 SW 必须带 ?v=<APP_VERSION>');
});

test('PWA-05 安装引导条：解锁后才弹、iOS 如实说明、两个按钮语义不同', () => {
  const bar = readSrc('pwa/install-bar.ts');
  // 🔴 iOS 给一个点不动的「安装」按钮比不给更糟 —— beforeinstallprompt 在 iOS 永不触发
  assert.ok(bar.includes('isIOS'), '必须有 iOS 分支');
  assert.match(bar, /installMsgIOS/, 'iOS 必须换文案（走 Safari 分享菜单）');
  assert.ok(
    COPY.installMsgIOS.includes('添加到主屏幕'),
    `iOS 文案必须点名「添加到主屏幕」，实际「${COPY.installMsgIOS}」`,
  );
  // 「以后再说」只收本会话；「×」才写持久 —— 写反了就是"用户点一下以后再说却再也不出现"
  // 🔴 判据必须锚在**事件处理器**那一行，不能用 `indexOf('#installLater')`：
  //   那个字符串在 innerHTML 模板里先出现（第 65 行），从那里切 200 字会跨到
  //   下一个处理器去（`localStorage` 就在隔壁），判据就会红在假的地方。
  const laterHandler = /querySelector\('#installLater'\)\?\.addEventListener\('click',([\s\S]{0,120}?)\);/.exec(bar);
  assert.ok(laterHandler, '找不到「以后再说」的处理器');
  assert.doesNotMatch(
    laterHandler[1],
    /localStorage/,
    '「以后再说」不许写 localStorage（那是「×」的语义，老项目 v9.5.8）',
  );
  const dismissHandler = /querySelector\('#installDismiss'\)\?\.addEventListener\('click',([\s\S]{0,300}?)\n {2}\}/.exec(
    bar,
  );
  assert.ok(dismissHandler, '找不到「×」的处理器');
  assert.match(
    dismissHandler[1],
    /localStorage/,
    '「×」必须写 localStorage（用户明确说了"别再提"）',
  );
  // 已安装 / 本会话已弹 / 用户点过 × —— 四种情况都不许弹
  assert.match(bar, /isStandalone\(\)/, '已装成桌面应用不许再弹');
  assert.match(bar, /shownThisSession/);
  assert.match(bar, /dismissed\(\)/);
  // 调用点必须在解锁之后（落地页就弹 = 一进门先推安装广告）
  const main = readSrc('main.ts');
  const unlocks = (main.match(/tryShowInstallBar\(\);/g) || []).length;
  assert.ok(unlocks >= 1, '解锁成功后必须调用 tryShowInstallBar');
  assert.ok(
    !/showLanding\(\);[\s\S]{0,120}tryShowInstallBar/.test(main),
    '安装引导不许在落地页阶段弹（老项目在解锁回调里，index.html:3476）',
  );
  // 样式必须齐（老项目 :171-183）
  assert.match(rule('#installBar'), /bottom:\s*16px/);
  assert.match(rule('.instcard'), /border-radius:\s*18px/);
  assert.match(rule('.inst-btns button'), /min-height:\s*44px/, '按钮触控区必须 44px');
  assert.match(rule('#installGo'), /var\(--upload-bg\)/, '主按钮要吃 --upload-bg（= 老项目 --fg 底）');
});

/* ---------------- 第 13 条：移动端导出到微信 ---------------- */

test('EXP-W01 剪贴板档提示必须按平台分：手机没有 Ctrl+V 这个动作', () => {
  assert.equal(COPY.exportOkMsg('clipboard'), '图片已复制，可直接 Ctrl+V 粘贴');
  assert.equal(COPY.exportOkMsgTouch('clipboard'), '图片已复制，长按下方图片可发给微信');
  // 🔴 反向：触屏文案里**不许**出现 Ctrl+V —— 给一句做不到的指引等于没说
  assert.doesNotMatch(COPY.exportOkMsgTouch('clipboard'), /Ctrl\+V/);
  // 另外两档两边一致
  assert.equal(COPY.exportOkMsgTouch('native'), COPY.exportOkMsg('native'));
  assert.equal(COPY.exportOkMsgTouch('share'), COPY.exportOkMsg('share'));
  // 触屏判据必须是媒体查询（不用 UA sniff —— 国产内核 UA 常年不准）
  const idx = readSrc('export/index.ts');
  assert.match(idx, /\(hover: none\) and \(pointer: coarse\)/, '触屏判据要用同一套媒体查询');
});

test('EXP-W02 全屏预览层必须给触屏一条"怎么进微信"的指引', () => {
  assert.equal(COPY.exportPreviewTip, '长按图片可保存或发送；点「下载」也可直接保存');
  assert.ok(
    COPY.exportPreviewTipTouch.includes('微信'),
    `触屏指引必须点名微信，用户报障原文是「没法复制到微信」，实际「${COPY.exportPreviewTipTouch}」`,
  );
  // 🔴 反向：触屏指引不许只说"发送"却不点名去哪儿 —— "长按可发送"用户不知道发给谁
  assert.match(COPY.exportPreviewTipTouch, /长按/);
  const idx = readSrc('export/index.ts');
  // 只在触屏加这一行（桌面端有分享面板与 Ctrl+V，加了是噪音）
  assert.match(idx, /if \(touch\) box\.appendChild\(wechatTip\)/, '触屏才追加这行');
  assert.ok(
    !/box\.appendChild\(wechatTip\);\s*\n\s*}/.test(idx.replace(/if \(touch\)[^\n]*/, '')),
    'wechatTip 追加必须受 touch 门控',
  );
});

test('EXP-W03 交付阶梯四档齐全且分享失败必落预览档（移动端的唯一可达出口）', () => {
  const render = readSrc('export/render.ts');
  // 四档：剪贴板(Promise) → 剪贴板(Blob) → 原生桥 → 系统分享 → 全屏预览
  assert.match(render, /ClipboardItem/, '缺剪贴板档');
  assert.match(render, /canShare/, '缺系统分享档');
  assert.match(render, /showPreview\(blob\)/, '缺全屏预览兜底 —— 移动端几乎必然落这一档');
  // 🔴 AbortError（用户主动取消）静默收场；**其它**异常必须继续往下落到预览档，
  //   不能吞掉后什么都不做（症状：点了导出什么都没发生）。
  assert.match(render, /AbortError/, '取消分享要静默');
  assert.match(
    render,
    /catch \(e\)[\s\S]{0,200}AbortError[\s\S]{0,200}\}/,
    '分享异常分支必须只吞 AbortError',
  );
  // 反向：不能把非 AbortError 也当取消（那等于"分享失败 = 什么都不做"）
  const catchBlock = render.slice(render.indexOf('navigator.share'), render.indexOf('showPreview(blob)'));
  assert.ok(
    !/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/.test(catchBlock),
    '分享异常不许空 catch（失败必须落到预览档）',
  );
});
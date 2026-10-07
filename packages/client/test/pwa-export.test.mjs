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
/**
 * 去块注释与整行行注释。
 *
 * 🔴 判"某段代码不存在"时**必须**先去注释（判据纪律，已栽过两次）。
 *   否则解释性注释里提一句被删的符号名，就把判据顶成恒红 ——
 *   而"为什么删"恰恰必须写在注释里，否则下一个人会写回来。
 *   （同款实现见 fav-backup.test.mjs:280 的同名函数。判据刻意各自自带，
 *   不跨文件共享：共享工具一旦被改，两个文件的判据会同时漂。）
 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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
  // 🔴 v1.13.0：原断言写死 'NoteSync'（抄老项目 manifest.json 的字面值），
  //   但 v1.12.0 用户拍板把应用名统一改成 **NoteSyncX**（桌面图标与通知栏同名才分得开，
  //   两版 App 同机共存）。产品口径以拍板为准 ⇒ 判据跟着改，不改实现。
  //   ⚠️ 别把它改回 'NoteSync' —— 那会让"改回旧名"这条回归永远测不出来。
  assert.equal(j.name, 'NoteSyncX', 'v1.12.0 起 manifest name 必须是 NoteSyncX（与 strings.xml / capacitor.config.json 同名）');
  assert.equal(j.short_name, 'NoteSyncX', 'short_name 同样必须是 NoteSyncX（加桌面后图标下的名字）');
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
  //   🔴 v1.13.0：必须先剥查询串。manifest 里 src 形如 `/favicon.svg?v=7.9.0`
  //   （v1.12.0 起照老项目口径给 svg 带缓存版本号，SW 预缓存要用同一串），
  //   而 `resolve(STATIC, '/favicon.svg?v=7.9.0')` 拼出来是**带问号的文件名**，
  //   existsSync 恒 false ⇒ 这条判据会假红（错报成"图标缺失"，而构建产物里它好端端的）。
  //   真源是 src 的 path 部分，query 只影响 HTTP 缓存命中，判文件存在时必须丢掉。
  for (const i of j.icons) {
    const rel = i.src.replace(/^\//, '').split('?')[0];
    const p = resolve(STATIC, rel);
    assert.ok(existsSync(p), `manifest 引用的图标不存在：${i.src} → 解析成 ${rel}（症状：装完是浏览器默认图标）`);
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

test('EXP-W01 🔴🔴 剪贴板档提示不许谎报「下方图片」（A1：剪贴板成功后不开预览层）', () => {
  assert.equal(COPY.exportOkMsg('clipboard'), '图片已复制，可直接 Ctrl+V 粘贴');
  // 🔴🔴 用户报障第 4 条：「导出图片并复制我希望体验还是和老版本一样，不要现在这样下载什么的」。
  //   老项目 index.html:2896-2963 的 exportImage() **零平台分支** —— 剪贴板成功后只
  //   showUploadStatus + setTimeout(hideUploadStatus, 3000) + return，没有任何后续动作。
  //   ⇒ 触屏剪贴板成功时屏上**没有预览层、没有图**，「长按下方图片」就是谎报。
  //   （谎报比给一句泛用指引更糟：用户真去长按，发现根本没有图。）
  assert.ok(
    !/下方图片|长按下方/.test(COPY.exportOkMsgTouch('clipboard')),
    '触屏剪贴板档不许说「长按下方图片」—— A1 下剪贴板成功后不开预览层，屏上没有图可长按，' +
      `实际「${COPY.exportOkMsgTouch('clipboard')}」`,
  );
  // 🔴 反向：触屏文案里也不许出现 Ctrl+V —— 给一句做不到的指引等于没说
  assert.doesNotMatch(COPY.exportOkMsgTouch('clipboard'), /Ctrl\+V/);
  // 🔴 触屏剪贴板档必须给一句**做得到**的指引：复用原生桥档的「可直接粘贴」口径
  //   （老项目 index.html:2943 同一句）。
  assert.equal(COPY.exportOkMsgTouch('clipboard'), '图片已复制，可直接粘贴');
  // 另外两档两边一致
  assert.equal(COPY.exportOkMsgTouch('native'), COPY.exportOkMsg('native'));
  assert.equal(COPY.exportOkMsgTouch('share'), COPY.exportOkMsg('share'));
  // 🔴 触屏判据必须是媒体查询（不用 UA sniff —— 国产内核 UA 常年不准）。
  // 🔴🔴 判据跟着 2026-10-07 那次重构改了指向：媒体查询字面量原先在
  //   `export/index.ts` 里自己写了两遍（文案分档一处、预览层一处），
  //   现在收敂到全项目唯一出处 `platform/touch.ts` 的 `isTouchDevice()`。
  //   ⇒ 判据必须查**唯一出处**，否则这次重构会被判红，而它其实没削弱任何东西。
  //   反向闸同时钉住"export/index.ts 不许自己再写一份"：
  //   同一判据两处写法，matchMedia 缺失时行为会漂（`isTouchDevice` 吞异常、
  //   字面量版会抛），迟早出现"文案说触屏、指引没加"这类症状。
  const touch = readSrc('platform/touch.ts');
  assert.match(touch, /\(hover: none\) and \(pointer: coarse\)/, '触屏判据要用同一套媒体查询');
  const idx = readSrc('export/index.ts');
  assert.ok(
    !/\(hover: none\) and \(pointer: coarse\)/.test(idx),
    'export/index.ts 不许自己再写一份触屏媒体查询（口径会漂）',
  );
  assert.match(idx, /isTouchDevice\(\)/, 'export/index.ts 必须走唯一出处 isTouchDevice()');
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
  // 只在触屏加这一行（桌面端有分享面板与 Ctrl+V，加了是噪音）。
  // 🔴🔴🔴 这条判据翻过两次车，两次都是**恒绿**，记录在此免得再犯：
  //   ① 用 `lastIndexOf('isTouchDevice()')` + 找 `}` ⇒ 命中的是文件里**另一处**
  //      isTouchDevice()（文案分档那行），位置关系是假的，把追加挪出 if 块也不红。
  //   ② 改成从追加处**往前数花括号配平** ⇒ 同样恒绿。
  //      真因：`const btnRow = document.createElement('div')` 这类**同一行**自带
  //      一对花括号，逐字符回溯在 `{` 分支里先撞上它们，配平数错一位。
  //   ⇒ 手写括号解析器在这个缩进风格下不可靠。改成**只取函数体**再判：
  //      先切到 `showPreview` 的函数体（去掉此前一切代码），
  //      块内出现 `}` 之前必须已出现 wechatTip 的追加 —— 这是纯字符串事实，
  //      不需要解析嵌套。
  const fnStart = idx.indexOf('export function showPreview');
  assert.ok(fnStart > 0, '找不到 showPreview（判据自身失效，不许静默通过）');
  const body = idx.slice(fnStart);
  const appendAt = body.indexOf('box.appendChild(wechatTip)');
  assert.ok(appendAt > 0, 'wechatTip 必须被追加进预览层');
  const blockEnd = body.indexOf('\n}', appendAt);
  assert.ok(blockEnd > 0, '找不到 showPreview 的收尾');
  // 从函数体开头到块结束之间，追加语句必须与门控 if 处在**同一层**
  //（同层 = 中间没有别的 `if (...) {` 把深度带下去）。
  const head = body.slice(0, appendAt);
  const gates = head.match(/if\s*\(/g) || [];
  assert.equal(
    gates.length,
    1,
    'wechatTip 追加必须只受一个 if 门控（当前读到 ' + gates.length + ' 个）',
  );
  assert.match(
    head.slice(head.lastIndexOf('if (')),
    /^if\s*\(\s*isTouchDevice\(\)\s*\)\s*\{/,
    '唯一的那个门控必须是 isTouchDevice()',
  );
  // 🔴 门控行之后到追加语句之间，只允许"构造 wechatTip"的代码 ——
  //   绝不许再出现别的 if（那说明追加已落到别的分支里，或门控早已闭合）。
  //   判据不许钉"门控行紧邻追加"：中间隔着三行构造是正常的。
  const afterGate = head.slice(head.lastIndexOf('if ('));
  assert.equal(
    (afterGate.slice(1).match(/\bif\s*\(/g) || []).length,
    0,
    '门控之后不许再出现新的 if（追加可能已落在门控之外）',
  );
  // 🔴🔴 最终判据：比门控**深一层**。
  //   前三版都恒绿过（lastIndexOf / 括号配平 / if 计数），共同原因是
  //   它们都在判"结构关系"，而"追加在不在 if 块内"这件事在缩进风格统一的
  //   仓库里由**缩进层级**直接给出，且不会因为中间隔着几行构造代码而失真：
  //   块内 4 空格，门控 2 空格，块外（函数体层）也是 2 空格。
  //   把追加挪到 btnRow 那行（块外）时，这一行缩进从 4 变 2 ⇒ 判据转红（已实测）。
  const lines = body.split('\n');
  const gateLine = lines.findIndex((l) => /if\s*\(\s*isTouchDevice\(\)\s*\)/.test(l));
  const appendLine = lines.findIndex((l) => l.includes('box.appendChild(wechatTip)'));
  assert.ok(gateLine >= 0 && appendLine > gateLine, '门控必须在追加之前');
  const indentOf = (s) => (s.match(/^ */) || [''])[0].length;
  const gateIndent = indentOf(lines[gateLine]);
  const appendIndent = indentOf(lines[appendLine]);
  assert.ok(
    appendIndent > gateIndent,
    `wechatTip 追加必须缩进在 isTouchDevice() 块内（门控缩进 ${gateIndent}，追加缩进 ${appendIndent}）`,
  );
});

test('EXP-W02b 🔴🔴 A1：剪贴板档成功后**零后续动作**（老项目 exportImage 内零平台分支）', () => {
  const render = readSrc('export/render.ts');
  // 🔴🔴 判"代码不存在"必须**先去注释**（判据纪律，已栽过）。
  //   否则解释性注释里提一句那个被删的函数名，就会把判据顶成恒红 ——
  //   而这里恰恰**必须**在注释里写清"此前有过、为什么删"，否则下一个人会写回来。
  const renderCode = stripComments(render);
  // 🔴🔴 这是本批的**核心不变量**：用户报障第 4 条「不要现在这样下载什么的」。
  //   老项目 index.html:2896-2963 的 exportImage() 里剪贴板成功后是
  //   showUploadStatus(...) + setTimeout(hideUploadStatus, 3000) + return，**零后续动作**。
  //   bj 此前在第①档与第②档剪贴板成功之后各调了一次 openTouchPreviewOnClipboard(...)
  //   ⇒ 屏上多出一层遮罩，用户看到的是「像下载的流程」。
  //   ⇒ 现在那个函数必须**整个不存在**。
  assert.doesNotMatch(
    renderCode,
    /openTouchPreviewOnClipboard/,
    '🔴 剪贴板成功后不许再开预览层（openTouchPreviewOnClipboard 必须整个删掉）',
  );
  // 🔴 两个剪贴板档的 return 之前都只剩 `return 'clipboard'`，中间不许夹任何调用。
  //   用"剪贴板成功分支里最后一次 return 'clipboard' 之前不许出现 showPreview"来钉，
  //   比逐个函数体切片更抗改写（判据纪律：钉行为，不钉命名）。
  const retIdx = [...renderCode.matchAll(/return 'clipboard';/g)].map((m) => m.index);
  assert.equal(retIdx.length, 2, '应有两处剪贴板成功收场（Promise 形态 + Blob 重试），实际 ' + retIdx.length);
  for (const i of retIdx) {
    const win = renderCode.slice(Math.max(0, i - 400), i);
    assert.doesNotMatch(
      win,
      /showPreview/,
      '🔴 剪贴板成功到 return 之间不许出现 showPreview（那就是要多开预览层），上下文：\n' + win.slice(-260),
    );
  }
  // 🔴 反向闸 A：第⑤档全屏预览兜底必须**仍然存在**（剪贴板全拒时它是唯一出口，
  //   删掉它等于把"导不出图"变成"什么都拿不到"）。
  assert.match(renderCode, /deps\.showPreview\(blob\);/, '第⑤档全屏预览兜底必须保留');
  assert.match(renderCode, /return 'preview';/, '第⑤档必须仍返回 preview');
  // 🔴 反向闸 B：DeliverDeps 的 isTouch 注入口必须一并删掉。
  //   那个字段是"触屏补开预览层"的唯一入口；逻辑删了字段留着就是死字段，
  //   而死字段会骗下一个人以为"触屏还有地方需要平台分支"，从而把行为原样写回来。
  assert.doesNotMatch(
    renderCode,
    /isTouch/,
    'DeliverDeps.isTouch 必须一并删掉（逻辑已删，字段留着是死字段）',
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
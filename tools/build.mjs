/**
 * 构建：esbuild 单文件产物 + 版本注入
 *
 * 产出：
 *   www/app.js      —— JS+依赖 全打成一个文件（inline，不留import）
 *   www/index.html  —— 引用上面那一个文件，无其他外部依赖
 *
 * 🔴 三个必须守住的设计（ARCH.md §4.6）：
 *  1. **单文件**。单文件是 OTA 原子性与离线兜底的根基：APK 里的页面是壳，
 *     真正的 JS 随 OTA 从服务器来。拆成多个文件意味着"发了一半"的中间态存在，
 *     老项目为"缓存了旧 app.js 但没有新 index.html"付过代价。
 *  2. **版本只从 package.json 来**。`define` 在构建期把__APP_VERSION__ 替换成
 *     字面量，不读任何别处。ARCH 明令：测试只许断言"产物版本 == package.json 版本"，
 *     出现版本字面量断言 = 评审打回。
 *  3. **不引Workbox**。SW 策略就两条（缓存名版本驱动 + 10s 超时），手写足够。
 *
 * 用法：
 *   node tools/build.mjs             正常构建
 *   node tools/build.mjs --watch     监听重建（开发用）
 */

import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'www');
const ENTRY = join(ROOT, 'packages', 'client', 'src', 'main.ts');
const CSS = join(ROOT, 'packages', 'client', 'src', 'ui', 'styles.css');
/**
 * 🔴🔴 静态资源源目录 —— **必须入库**。
 *
 *   曾经把 sw.js 与 html2canvas.min.js 直接放在 www/，而 www/ 整个在
 *   .gitignore 里（它是构建产物）。后果：本机一切正常，但 CI 拉下来的仓库里
 *   没有这两个文件，构建出的 www/ 是残缺的 ——
 *     - sw.js 404⇒ APK 壳里注册 SW 静默失败，离线能力消失
 *     - html2canvas 404 ⇒ **导出长图整体不可用**，而失败文案是
 *       「图片导出组件未加载」，用户只会觉得功能坏了
 *   这类"只在本机成立"的缺口是最难查的一类，所以静态资源必须住在源码树里，
 *   由本脚本物化到 www/。
 */
const STATIC_SRC = join(ROOT, 'packages', 'client', 'static');
const HTML = join(WWW, 'index.html');

/** 唯一的版本来源（ARCH.md §4.6） */
async function readVersion() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  return { version: pkg.version, date: new Date().toISOString().slice(0, 10) };
}

async function ensureDirs() {
  await mkdir(WWW, { recursive: true });
}

/**
 * 静态资源**必需清单** —— 与 copyFile 的"物化全部"是两条独立的职责。
 *
 * 🔴🔴 为什么要这份清单：物化用 readdir（新增文件自动跟上），
 *   但**漏掉**某个必需文件时 readdir 不会报错 —— 缺 jsQR.js 的话
 *   扫码在所有桌面浏览器上直接不可用，而构建日志一切正常，
 *   失败文案只有一句「扫码组件加载失败」，用户完全无从判断是网络还是缺文件。
 *   所以必需的那几个逐个点名，缺了就 exitCode=1。
 *
 * 每项都写清「缺了会怎样」，避免有人后来"觉得这个不重要"就删掉。
 */
const STATIC_REQUIRED = [
  // ServiceWorker。缺 ⇒ APK 壳里注册静默失败，离线能力消失。
  'sw.js',
  // 导出长图渲染器。缺 ⇒ 导出整体不可用。
  'html2canvas.min.js',
  // 二维码解码。缺 ⇒ 桌面 Chrome/Edge 与 iOS Safari 全部扫不了码
  //（BarcodeDetector 形状检测 API 只有安卓/macOS Chrome 有，老项目 v6.0 实锤）。
  'jsQR.js',
  // 二维码生成。缺 ⇒「二维码配对」弹窗一片空白。
  'qrcode-generator.js',
];

/**
 * 把 packages/client/static/ 下的文件物化到 www/。
 *
 * 🔴🔴 **必须在 build 里做，且必须报出每个文件**：
 *   - 不做 ⇒ CI 产物缺 sw.js / html2canvas.min.js（见 STATIC_SRC 的注释）
 *   - 不报出 ⇒ 缺文件时构建照样"成功"，问题一路飘到用户手机上
 *
 * 🔴 用 copyFile 而不是硬编码文件名清单：新增静态资源时忘了改清单，
 *   症状就是"本地好好的、线上那个文件 404"，而清单里根本看不到它。
 */
async function materializeStatic() {
  let names;
  try {
    names = await readdir(STATIC_SRC);
  } catch {
    //🔴 目录不存在是**硬错误**：它意味着静态资源没入库（见 STATIC_SRC 注释）。
    //   静默跳过等于把缺口直接推到线上，必须在这里就炸。
    throw new Error(
      `静态资源目录不存在：${STATIC_SRC}（${STATIC_REQUIRED.join(' / ')} 不会进 CI 产物）`,
    );
  }
  const files = names.filter((n) => !n.startsWith('.'));
  for (const n of files) {
    await copyFile(join(STATIC_SRC, n), join(WWW, n));
  }
  return files;
}

/**
 * 生成 index.html。
 *
 * 🔴 CSS **inline 进 HTML 而不是引app.css** —— 单文件原子性是 OTA 的根基（文件头），
 *   多一个外链就多一个"发了一半"的中间态。
 *
 * 🔴 `<meta name="color-scheme" content="light dark">` 而不是写死 light：
 *   夜间模式下浏览器 UI（滚动条、表单控件）不配套会很难看。
 *   注意这**不等于**"跟随系统" —— 那是 CSS 变量层面的事，见 ui/theme.ts 的 resolveTheme。
 *
 * 🔴 主题色取浅色底`#FBFBF8`（老项目色板的值，不是随手写的 #FAFAF8），
 *   它决定移动端地址栏/启动屏的颜色，是"用户一眼看到的第一个颜色"。
 */
function indexHtml(version, date, sha, css) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1,user-scalable=no">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#FBFBF8">
<meta name="referrer" content="no-referrer">
<title>NoteSync</title>
<style>
${css}
</style>
</head>
<body>
<div id="boot">载入中…</div>
<div id="app"></div>
<script src="app.js"></script>
<script>
/* 产物指纹：用于"服务器上的壳与本地产物是否同一份"的快速肉眼比对。
   真源版本号仍由 app.js 里的 APP_VERSION 提供（见 packages/client/src/version.ts）。
   这段是模板字面量（不是 define 注入），所以 version/sha 在构建时已知。 */
window.__NOTESYNC_BUILD__ = ${JSON.stringify({ version, date, sha })};
</script>
</body>
</html>
`;
}

async function run() {
  const watch = process.argv.includes('--watch');
  const { version, date } = await readVersion();
  await ensureDirs();

  const opts = {
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    platform: 'browser',
    outfile: join(WWW, 'app.js'),
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    legalComments: 'none',
    // 🔴 版本注入：唯一来源 package.json，不读 env、不读别处
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __BUILD_DATE__: JSON.stringify(date),
      __SCHEMA_VERSION__: '1',
    },
    logLevel: 'info',
  };

  if (watch) {
    const ctx = await context(opts);
    await ctx.watch();
    console.log('[build] 监听中…（开发模式，不压缩、带 sourcemap）');
    return;
  }

  const result = await build(opts);
  if (result.errors.length > 0) {
    process.exitCode = 1;
    return;
  }

  const js = await readFile(join(WWW, 'app.js'));
  const sha = createHash('sha256').update(js).digest('hex');
  const css = await readFile(CSS, 'utf8');
  await writeFile(HTML, indexHtml(version, date, sha, css), 'utf8');

  const statics = await materializeStatic();

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(`[build] app.js ${kb(js.length)}  sha256:${sha.slice(0, 16)}`);
  console.log(`[build] index.html 就绪（CSS inline ${kb(css.length)}）  版本 v${version}  ${date}`);
  console.log(`[build] 静态资源已物化：${statics.join(', ') || '(空)'}`);
  // 🔴 逐个点名：缺文件时这里要能一眼看出来，而不是"构建成功"然后线上 404
  for (const must of STATIC_REQUIRED) {
    if (!statics.includes(must)) {
      console.error(`[build] 缺必需静态资源：${must}（对应功能在线上直接不可用）`);
      process.exitCode = 1;
    }
  }
}

run().catch((e) => {
  console.error('[build] 失败:', e.message);
  process.exitCode = 1;
});

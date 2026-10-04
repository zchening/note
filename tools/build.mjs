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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'www');
const ENTRY = join(ROOT, 'packages', 'client', 'src', 'main.ts');
const CSS = join(ROOT, 'packages', 'client', 'src', 'ui', 'styles.css');
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

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(`[build] app.js ${kb(js.length)}  sha256:${sha.slice(0, 16)}`);
  console.log(`[build] index.html 就绪（CSS inline ${kb(css.length)}）  版本 v${version}  ${date}`);
}

run().catch((e) => {
  console.error('[build] 失败:', e.message);
  process.exitCode = 1;
});

/**
 * 三端版本号一致性闸
 *
 * 🔴🔴 为什么要有这个脚本：ARCH.md 曾经声称「三端 sha256 校验」，实测**根本不存在**。
 *   真实的缺口有三层，任何一层都能让"版本号"这个最基础的身份信息对不上：
 *     ① www/ 产物与 android/app/src/main/assets/public/ 之间没有**任何**比对环节。
 *        `npx cap sync android` 拷贝完就走，落盘后没人回头看一眼。
 *        实测（2026-10-11）：www/app.js 是 v3.0.20、assets/public/app.js 是 v1.0.0，
 *        两者大小都不同，而 `cap sync` 与 build 全程零报错。
 *     ② android/app/build.gradle 的 versionName 在仓库里是 "1.0"，
 *        与 package.json 的 3.0.20 毫无关系 —— 它由 CI 在出包前 sed 注入，
 *        仓库里那份永远是旧的，人读看不出来、也不该靠人读。
 *     ③ www/app.js 里的版本是 esbuild `define` 注入的字面量，压进一行 700KB 的
 *        产物里，肉眼与 grep 都不可靠。
 *   ⇒ 三者必须**机械**对齐：package.json（真源）→ www 产物 → android 壳/产物。
 *
 * 🔴🔴 为什么版本串用「正则扫数字串」而不是查某个变量名：
 *   产物是压缩过的，中文被写成 \uXXXX、变量名被改名，唯一稳定的形态是
 *   `"3.0.20"` 这个被引号包住的数字串（实测 www/app.js 里**恰好一个**）。
 *   所以判据是：**产物里的 semver 串集合 == {package.json 版本}**。
 *   多了（另一个版本的残留）与少了（没注入）都是红 —— 这就是本闸的
 *   「应该有 / 不应该有」两条边。
 *
 * 用法：
 *   node tools/check-versions.mjs                 三端全查（含 android）
 *   node tools/check-versions.mjs --skip-android  只查 package.json ↔ www（不需要 android 端）
 *
 * 🔴 退出码：不一致一律 exit 1，且把三端的实际值逐行打印出来（不写"可能/大概"）。
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_ANDROID = process.argv.includes('--skip-android');

/** 形如 "3.0.20"（带引号），产物压缩后仍稳定 */
const SEMVER_RE = /"(\d+\.\d+\.\d+)"/g;
/** build.gradle: versionName "3.0.20" */
const VERSION_NAME_RE = /versionName\s+"([^"]*)"/;
/** build.gradle: versionCode 30020 */
const VERSION_CODE_RE = /versionCode\s+(\d+)/;

/**
 * 🔴 versionCode 必须是**加权单调值** major*10000+minor*100+patch。
 *   "去点拼接"（tr -d '.'）在位数变化时倒退：1.13.1→1131、2.0.0→**200**，
 *   Android 覆盖安装只认 versionCode ⇒ 升级被系统拒绝（2026-10-08 线上实锤，
 *   v2.0.0 APK 的 AXML 里 versionCode=200）。这条是那条事故的第二道锁：
 *   即使有人把 CI 的 sed 改回拼接，本闸也会在这里红。
 */
function weightedCode(ver) {
  const [a, b, c] = ver.split('.').map(Number);
  return a * 10000 + b * 100 + c;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 取出文件里所有带引号的 semver 串（去重、保序） */
function semversIn(text) {
  const out = [];
  for (const m of text.matchAll(SEMVER_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const problems = [];
const fail = (msg) => problems.push(msg);

/* ---------- ① 真源：package.json ---------- */
const pkgPath = join(ROOT, 'package.json');
if (!existsSync(pkgPath)) {
  console.error('❌ 找不到根 package.json（版本真源）');
  process.exit(1);
}
const PKG_VER = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(PKG_VER)) {
  console.error(`❌ package.json 的 version 不是三段式：${PKG_VER}`);
  process.exit(1);
}

/* ---------- ② www 产物 ---------- */
const wwwHtml = join(ROOT, 'www', 'index.html');
const wwwJs = join(ROOT, 'www', 'app.js');
for (const f of [wwwHtml, wwwJs]) {
  if (!existsSync(f)) {
    console.error(`❌ 缺构建产物 ${f} —— 本闸必须先跑 npm run build`);
    process.exit(1);
  }
}

// 「应该有」：index.html 里的 __NOTESYNC_BUILD__.version == package.json
const htmlText = readFileSync(wwwHtml, 'utf8');
const metaMatch = /window\.__NOTESYNC_BUILD__\s*=\s*(\{[^}]*\})/.exec(htmlText);
if (!metaMatch) {
  fail('www/index.html 里找不到 window.__NOTESYNC_BUILD__（构建元信息没写进去）');
} else {
  let meta = null;
  try {
    meta = JSON.parse(metaMatch[1]);
  } catch {
    fail(`www/index.html 的 __NOTESYNC_BUILD__ 不是合法 JSON：${metaMatch[1]}`);
  }
  if (meta) {
    if (meta.version !== PKG_VER) {
      fail(`www/index.html 注入版本 ${meta.version} ≠ package.json ${PKG_VER}`);
    }
    // 「不应该有」：index.html 里不该出现第二个 semver 串
    const others = semversIn(htmlText).filter((v) => v !== PKG_VER);
    if (others.length) {
      fail(`www/index.html 里存在非 package.json 的版本串：${others.join(', ')}（版本只许一个真源）`);
    }
  }
}

// 「应该有」：app.js 里含 package.json 版本；「不应该有」：不含别的版本
const jsText = readFileSync(wwwJs, 'utf8');
const jsVers = semversIn(jsText);
if (!jsVers.includes(PKG_VER)) {
  fail(`www/app.js 里找不到版本 ${PKG_VER}（define 注入失效？实际扫到：${jsVers.join(', ') || '(无)'}）`);
}
const jsOthers = jsVers.filter((v) => v !== PKG_VER);
if (jsOthers.length) {
  fail(`www/app.js 里存在非 package.json 的版本串：${jsOthers.join(', ')}（产物里混进了另一个版本）`);
}

/* ---------- ③ android 端 ---------- */
const ASSETS = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');
/** assets 里必须与 www 逐字节一致的文件（OTA 与离线都靠它们） */
const SYNCED = ['index.html', 'app.js'];

if (SKIP_ANDROID) {
  console.log('[check-versions] --skip-android：跳过 android 端（build.gradle / assets）');
} else {
  const gradle = join(ROOT, 'android', 'app', 'build.gradle');
  if (!existsSync(gradle)) {
    fail('缺 android/app/build.gradle（壳工程没入库？）');
  } else {
    const g = readFileSync(gradle, 'utf8');
    const nameM = VERSION_NAME_RE.exec(g);
    const codeM = VERSION_CODE_RE.exec(g);
    if (!nameM) {
      fail('android/app/build.gradle 里解析不出 versionName');
    } else if (nameM[1] !== PKG_VER) {
      fail(`android versionName "${nameM[1]}" ≠ package.json ${PKG_VER}`
        + '（APK 会自报旧版本；CI 由「从 tag 注入安卓版本号」这一步 sed，本闸必须排在它之后）');
    }
    if (!codeM) {
      fail('android/app/build.gradle 里解析不出 versionCode');
    } else {
      const want = weightedCode(PKG_VER);
      const got = Number(codeM[1]);
      if (got !== want) {
        fail(`android versionCode ${got} ≠ 加权值 ${want}（= ${PKG_VER} 的 major*10000+minor*100+patch；`
          + '去点拼接会在位数变化时倒退，2.0.0→200 < 1.13.1→1131，覆盖安装被系统拒绝）');
      }
    }
  }

  // 🔴🔴 assets 漂移：这就是 ARCH 声称存在、实测不存在的那条校验。
  //   cap sync 拷完不比对，于是"壳里的页面"与"刚 build 出来的产物"可以是两个版本，
  //   而全程零报错 —— 用户装到的就是那份旧的。
  if (!existsSync(ASSETS)) {
    fail(`缺 ${ASSETS} —— 未跑 npx cap sync android，壳里没有产物可比`);
  } else {
    for (const name of SYNCED) {
      const src = join(ROOT, 'www', name);
      const dst = join(ASSETS, name);
      if (!existsSync(dst)) {
        fail(`android assets 缺 ${name}（APK 里对应功能直接不可用）`);
        continue;
      }
      const hs = sha256(src);
      const hd = sha256(dst);
      if (hs !== hd) {
        fail(`android assets/${name} 与 www/${name} 不一致\n`
          + `        www    sha256=${hs}  ${readFileSync(src).length} 字节\n`
          + `        assets sha256=${hd}  ${readFileSync(dst).length} 字节\n`
          + `        （cap sync 拷完没比对 —— 本闸存在的理由）`);
      }
    }
    // 「不应该有」：assets 里的版本串不能是别的版本
    const assetsHtml = join(ASSETS, 'index.html');
    if (existsSync(assetsHtml)) {
      const t = readFileSync(assetsHtml, 'utf8');
      const others = semversIn(t).filter((v) => v !== PKG_VER);
      if (others.length) {
        fail(`android assets/index.html 里存在非 package.json 的版本串：${others.join(', ')}`);
      }
    }
    const assetsJs = join(ASSETS, 'app.js');
    if (existsSync(assetsJs)) {
      const others = semversIn(readFileSync(assetsJs, 'utf8')).filter((v) => v !== PKG_VER);
      if (others.length) {
        fail(`android assets/app.js 里存在非 package.json 的版本串：${others.join(', ')}`);
      }
    }
  }
}

/* ---------- 汇总 ---------- */
console.log(`[check-versions] package.json = ${PKG_VER}`);
console.log(`[check-versions] www/app.js 扫到版本串：${jsVers.join(', ') || '(无)'}`);
if (!SKIP_ANDROID && existsSync(ASSETS)) {
  for (const name of SYNCED) {
    const dst = join(ASSETS, name);
    console.log(`[check-versions] assets/${name} sha256=${existsSync(dst) ? sha256(dst).slice(0, 16) : '(缺)'}`);
  }
}

if (problems.length) {
  console.error(`\n❌ 版本一致性未通过（${problems.length} 项）：`);
  for (const p of problems) console.error('   - ' + p);
  process.exit(1);
}
console.log(SKIP_ANDROID
  ? '✅ 版本一致：package.json ↔ www 产物'
  : '✅ 版本一致：package.json ↔ www 产物 ↔ android（build.gradle + assets 逐字节）');

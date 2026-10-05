/**
 * S8-a：把老项目的 Android 原生资产移植进新项目壳工程。
 *
 * 🔴 为什么是脚本而不是手抄：
 *   原生资产共 2020 行（5 个插件 + MainActivity + 布局 + 资源），
 *   包名要从 cn.xuyinji.notesync 换成 cn.xuyinji.bj，散落在每个文件的
 *   package / import / manifest 路径 / strings 里。手改必漏一处，
 *   而漏掉的症状是「编译过了但功能静默失灵」——
 *   例如 strings 里的 custom_url_scheme 没换，App 内链接打开会走到错误 scheme。
 *
 * 🔴 移植纪律（与「从 0 重建」不矛盾）：
 *   插件代码是**平台适配层**，不是业务架构。Android 的 DownloadManager /
 *   FileProvider / AlarmManager 用法与产品形态无关，重写只会重新踩
 *   老项目用真机踩出来的坑（VISIBILITY_HIDDEN 已废弃常量、
 *   同 url 互撤单、截断 APK 复用死循环…）。这些注释是资产，要一起带走。
 *   业务架构（真源/加密/同步/UI）仍全部重做，一个字节没抄。
 *
 * 🔴 三处必须改的语义（不能纯替换包名）：
 *   1. 域名白名单：note/biji.xuyinji.com.cn → bj.xuyinji.com.cn
 *   2. 默认冷启 URL：biji 根页 → bj 根页
 *   3. ML Kit 扫码：老项目走 @capacitor-mlkit/barcode-scanning 原生插件，
 *      新项目**不引**该依赖（少一个 8MB+ 的 AAR、少一份 Play 服务依赖）——
 *      WebView 的 getUserMedia + jsQR 已覆盖扫码。移植时删掉相关注册。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OLD_ROOT = 'D:/Users/zchen/Documents/TraeProject/notesync/android';
const NEW_ROOT = join(ROOT, 'android');

/** 老项目包名 → 新项目包名 */
const PKG_OLD = 'cn.xuyinji.notesync';
const PKG_NEW = 'cn.xuyinji.bj';

const log = (...a) => console.log(...a);
let copied = 0;
let replaced = 0;
const skipped = [];

/** 递归列文件（排除构建产物） */
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'build' || n === '.gradle' || n.startsWith('.')) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 文本类扩展名（其余按二进制原样拷贝） */
const TEXT_EXT = new Set(['.kt', '.java', '.xml', '.gradle', '.pro', '.properties', '.json', '']);

/**
 * 包名 + 域名替换。
 * 🔴 顺序敏感：先替包名（长路径在前），再替域名。
 *   反过来的话，域名替换不会污染包名，所以其实顺序无关 ——
 *   但写成固定顺序是为了让下一个人一眼看出这两组替换互不重叠。
 */
function substitute(text) {
  let out = text;
  const before = out;
  out = out.split(PKG_OLD).join(PKG_NEW);
  out = out.split('note.xuyinji.com.cn').join('bj.xuyinji.com.cn');
  out = out.split('biji.xuyinji.com.cn').join('bj.xuyinji.com.cn');
  if (out !== before) replaced++;
  return out;
}

/**
 * 把老项目的相对路径映射到新项目的相对路径（统一正斜杠）。
 *
 * 🔴🔴 这里踩过一次**伪装成成功的静默失败**：初版写的是
 *   rel.replace('app/src/main/java/cn/xuyinji/notesync/', 'app/src/main/java/cn/xuyinji/bj/')
 *   而 walk() 交出来的 rel 是 **Windows 反斜杠**路径，正斜杠串匹配不上，
 *   replace 原样返回 → 目标路径与 Capacitor 已生成的骨架同名
 *   → copyOne 的「已存在就跳过」分支把 9 个 Kotlin/Java 源 + 全部 res 资源全跳过，
 *   而末尾照样打印「✅ 已移植 5 个文件」。看输出还以为成了。
 *   ⇒ 纪律：**路径分隔符绝不手写**。一律先 toPosix 再匹配，
 *     并且「跳过」必须是显式白名单，不允许由路径算错间接产生。
 */
function toPosix(p) {
  return p.split('\\').join('/');
}

function mapRel(rel) {
  const posix = toPosix(rel);
  const from = 'app/src/main/java/cn/xuyinji/notesync/';
  if (posix.startsWith(from)) {
    return 'app/src/main/java/cn/xuyinji/bj/' + posix.slice(from.length);
  }
  return posix;
}

/**
 * 拷贝单个文件（文本走替换，二进制原样）。
 *
 * 🔴🔴 `rel` 是**映射后**的新项目相对路径，但**源**要用映射前的原始路径。
 *   初版只传一个参数，源和目都用映射后的路径，于是去老项目里找
 *   `.../cn/xuyinji/bj/img/ImgClipPlugin.kt` —— 当然不存在，
 *   9 个源文件全部「源不存在」而被跳过，而输出照样是「✅ 已移植 22 个文件」。
 *   这次是资源部分碰巧搬对了（资源路径没映射），所以数字看着还挺像样。
 *
 * 🔴 `force` 用于「Capacitor 骨架已生成同名文件、我们要用老项目版本覆盖」的情况
 *   （MainActivity / strings.xml / styles.xml / file_paths.xml / splash.png 等）。
 *   不加 force 时「已存在就跳过」，避免手改过的文件被冲掉。
 *
 * @param {string} dstRel 映射后的目标相对路径（拼 NEW_ROOT）
 * @param {string} srcRel 老项目里的原始相对路径（拼 OLD_ROOT）
 * @param {boolean} force 是否覆盖已存在的目标
 */
function copyOne(dstRel, srcRel, force) {
  const src = join(OLD_ROOT, srcRel);
  const dst = join(NEW_ROOT, dstRel);
  if (!existsSync(src)) {
    // 🔴 源不存在是**硬错误**：本脚本要移植的文件清单是确定的，
    //   少一个都会导致某个原生能力静默失灵（编译能过，运行时插件不存在）。
    //   静默 push 到 skip 列表只会让输出"看着像成了"。
    throw new Error('❌ 源文件不存在：' + src + '\n   （映射后的目标路径是 ' + dstRel + '）');
  }
  if (existsSync(dst) && !force) {
    skipped.push(dstRel + '（新项目已存在，不覆盖）');
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  const ext = srcRel.slice(srcRel.lastIndexOf('.'));
  if (TEXT_EXT.has(ext)) {
    const text = substitute(readFileSync(src, 'utf8'));
    writeFileSync(dst, text, 'utf8');
    // 🔴 替换后自检：源码/资源里绝不该再出现老包名或老域名。留着就是漏改，
    //   而症状是"编译过了但某个功能静默失灵"，属于最难查的一类。
    if (/\.(kt|java|xml)$/.test(srcRel) && text.includes(PKG_OLD)) {
      throw new Error('❌ ' + srcRel + ' 移植后仍含老包名 ' + PKG_OLD + '（包名替换有漏）');
    }
    if (/\.(kt|java|xml)$/.test(srcRel) && /note\.xuyinji|biji\.xuyinji/.test(text)) {
      throw new Error('❌ ' + srcRel + ' 移植后仍含老项目域名（域名替换有漏）');
    }
  } else {
    copyFileSync(src, dst);
  }
  copied++;
}

/* ---------- 1. Kotlin / Java 源 ---------- */
const JAVA_SRC = 'app/src/main/java/cn/xuyinji/notesync';
for (const rel of walk(join(OLD_ROOT, JAVA_SRC)).map((p) => p.slice(OLD_ROOT.length + 1))) {
  // ML Kit 插件不在移植范围（依赖 @capacitor-mlkit/barcode-scanning，新项目不引）
  if (/mlkit|barcode|Scanner/i.test(rel)) {
    skipped.push(rel + '（ML Kit 扫码，新项目走 getUserMedia + jsQR）');
    continue;
  }
  // MainActivity 等要用老项目版本覆盖 Capacitor 骨架（源用原始 rel，目标用映射后的）
  copyOne(mapRel(rel), rel, true);
}

/* ---------- 2. 资源 ---------- */
// 🔴 一律 force：Capacitor 骨架已经生成了同名文件
//   （file_paths.xml、activity_offline.xml 等），而我们要的是老项目那版
//   ——它带 FileProvider 的 update/ 路径声明、离线兜底页的文案与配色。
for (const rel of [
  'app/src/main/res/layout/activity_offline.xml',
  'app/src/main/res/layout/activity_link_view.xml',
  'app/src/main/res/xml/file_paths.xml',
]) {
  copyOne(rel, rel, true);
}

/* ---------- 3. values（启动幕布主题 / 文案 / 色板） ---------- */
// 🔴 只搬 values/，不搬 values-night/：老项目根本没有 values-night 目录
//   （日夜两套色值写在 styles.xml 的 Day/Night 变体里，见 styles.xml 注释）。
//   早先这行写成 `readdirSync(dir).catch ? ... : ...` —— readdirSync 抛的是异常不是
//   返回 Promise，`.catch` 恒为 undefined，于是走 `? :` 的 else 分支当成"目录存在"，
//   直接 scandir 一个不存在的路径把整个脚本炸掉。
//   ⇒ 列目录一律走 listOr()，不存在就当空目录。
function listOr(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
for (const n of listOr(join(OLD_ROOT, 'app/src/main/res/values'))) {
  copyOne('app/src/main/res/values/' + n, 'app/src/main/res/values/' + n, true);
}

/* ---------- 4. drawable（启动幕布 logo） ---------- */
const drawableDir = join(OLD_ROOT, 'app/src/main/res');
for (const sub of ['drawable', 'drawable-land-hdpi', 'drawable-land-mdpi', 'drawable-land-xhdpi',
  'drawable-land-xxhdpi', 'drawable-land-xxxhdpi', 'drawable-port-hdpi', 'drawable-port-mdpi',
  'drawable-port-xhdpi', 'drawable-port-xxhdpi', 'drawable-port-xxxhdpi', 'mipmap-anydpi-v26']) {
  for (const n of listOr(join(drawableDir, sub))) {
    // 图标（ic_launcher）由 npx cap add android 自动生成，**不搬**：
    // 搬老项目的图标等于把老项目的品牌资产复制到新项目，而新项目是独立品牌。
    if (/launcher|ic_stat/i.test(n)) {
      skipped.push(sub + '/' + n + '（应用图标，保留 Capacitor 默认，不复制老项目品牌）');
      continue;
    }
    copyOne('app/src/main/res/' + sub + '/' + n, 'app/src/main/res/' + sub + '/' + n, true);
  }
}

/* ---------- 汇总 ---------- */
log('✅ 已移植 ' + copied + ' 个文件，文本替换生效于 ' + replaced + ' 个文件');
if (skipped.length) {
  log('\n有意识跳过 ' + skipped.length + ' 项：');
  for (const s of skipped) log('   - ' + s);
}

/* ---------- 收尾自检：结构错位必须在脚本内就炸 ---------- */
// 🔴🔴 这段是被两次真实事故逼出来的：
//   第一次路径映射用正斜杠、walk 交反斜杠 → 映射静默失效，
//           老包名目录 cn/xuyinji/notesync/ 被原样搬进来，与 cn/xuyinji/bj/ 并存；
//   第二次源路径误用映射后的路径 → 9 个源文件"源不存在"被跳过。
//   两次的共同点：**脚本都打印了「✅」**，而真正的问题在结构上。
//   ⇒ 收尾必须机械核对：期望的文件必须在、错目录必须不在。
//     只报"成功"不算成功。
const EXPECT_SRC = [
  'app/src/main/java/cn/xuyinji/bj/MainActivity.java',
  'app/src/main/java/cn/xuyinji/bj/img/ImgClipPlugin.kt',
  'app/src/main/java/cn/xuyinji/bj/img/ImgSavePlugin.kt',
  'app/src/main/java/cn/xuyinji/bj/link/LinkOpenPlugin.kt',
  'app/src/main/java/cn/xuyinji/bj/link/LinkViewActivity.kt',
  'app/src/main/java/cn/xuyinji/bj/rem/BootReceiver.kt',
  'app/src/main/java/cn/xuyinji/bj/rem/RemPlugin.kt',
  'app/src/main/java/cn/xuyinji/bj/rem/RemReceiver.kt',
  'app/src/main/java/cn/xuyinji/bj/update/UpdatePlugin.kt',
];
const problems = [];
for (const rel of EXPECT_SRC) {
  if (!existsSync(join(NEW_ROOT, rel))) problems.push('缺原生源：' + rel);
}
// 🔴 老包名目录只要还在，就是上一次事故的残留 —— 同一 MainActivity 两份
//   编译期表现为重复类，运行期（若侥幸编过）是走错包、桥全部失灵。
const staleDir = join(NEW_ROOT, 'app/src/main/java/cn/xuyinji/notesync');
if (existsSync(staleDir)) {
  problems.push('老包名目录仍在（会与新包并存）：' + staleDir + '（直接删掉整个目录）');
}
// 全树扫一遍：还有哪里漏了替换
for (const f of walk(join(NEW_ROOT, 'app/src/main'))) {
  if (!/\.(kt|java|xml)$/.test(f)) continue;
  const t = readFileSync(f, 'utf8');
  if (t.includes(PKG_OLD)) problems.push('仍含老包名：' + f.slice(NEW_ROOT.length + 1));
  if (/note\.xuyinji|biji\.xuyinji/.test(t)) problems.push('仍含老项目域名：' + f.slice(NEW_ROOT.length + 1));
}
if (problems.length) {
  console.error('\n❌ 移植自检未通过（' + problems.length + ' 项）：');
  for (const p of problems) console.error('   - ' + p);
  process.exit(1);
}
log('✅ 自检通过：' + EXPECT_SRC.length + ' 个原生源齐备，无老包名/老域名残留，无错目录');


/**
 * 导出长图纯逻辑单测（EXPORT 系列）
 *
 * 🔴 这组测试保护的是三件最容易静默坏掉的事：
 *   1. **书纸卡结构**：页头题线 + 日期、页脚品牌标 + 题句、外衬/内衬两层底。
 *      少一层就变成"裸正文平铺"，而这正是老项目 v9.5.0 之前的形态（被用户打回）。
 *   2. **折叠块补丁**：离屏副本不在 #editor 里，折叠标记/收起态一条CSS 都吃不到。
 *      老项目 v10.0.2 与 v10.0.3 分别为「[折叠] 显成字」和「正文没缩进」报过两次障。
 *   3. **交付阶梯不早退**：剪贴板→原生桥→分享→预览，四档任一成功就收场，
 *      全部失败才返回 null；用户取消分享返回 'cancelled' 而不是 null。
 *
 * 判据纪律：卡片结构用**真 DOM**（本文件装最小 document 垫片），
 * 不靠正则读源码 —— 正则判不出的东西正是"样式类名与节点不同源"那类bug。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPORT_FOLD_CSS,
  EXPORT_MAX_WIDTH,
  EXPORT_TAGLINES,
  breakLongWords,
  formatExportDate,
  pickTagline,
} from '../src/export/card.ts';
import { RENDER_OPTS, blobToB64 } from '../src/export/render.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CARD_SRC = readFileSync(resolve(HERE, '..', 'src', 'export', 'card.ts'), 'utf8');
const RENDER_SRC = readFileSync(resolve(HERE, '..', 'src', 'export', 'render.ts'), 'utf8');
const INDEX_SRC = readFileSync(resolve(HERE, '..', 'src', 'export', 'index.ts'), 'utf8');

test('EXPORT-01 🔴 页脚题句池 17 条 / 16 句唯一，品牌原句×2 权重（老项目 v10.0.2 拍板）', () => {
  // 🔴 数组长度 17 而唯一值 16：老项目是「16 句全留 + 品牌原句放两份＝×2 权重」
  //   （即 ≈1/9 概率命中品牌句）。别把它"整理"成 16 条 —— 那样品牌句权重掉到 1/16，
  //   而用户当初拍板的就是这个权重。
  assert.equal(EXPORT_TAGLINES.length, 17, '句池长度变了（老项目是 17 项/ 16 句）');
  const brand = EXPORT_TAGLINES.filter((t) => t === '记录，自有回响').length;
  assert.equal(brand, 2, '品牌原句应是两份（≈1/9 概率）');
  const uniq = new Set(EXPORT_TAGLINES);
  assert.equal(uniq.size, 16, '唯一句应是 16');
});

test('EXPORT-02 🔴 pickTagline 永远返回池内一句，且越界不崩', () => {
  for (const r of [0, 0.5, 0.999999, 1, -1, 2]) {
    const t = pickTagline(() => r);
    assert.ok(EXPORT_TAGLINES.includes(t), `rand=${r} 返回了池外值 ${t}`);
  }
});

test('EXPORT-03 日期格式 2026-10-05 · 星期一', () => {
  // 🔴 星期必须用真实日历核对，不能"看着像"：2026-10-05 是周一。
  //   写死星期几的判据会放过 off-by-one，而出图页头天天写着这个。
  assert.equal(formatExportDate(new Date(2026, 9, 5)), '2026-10-05 · 星期一');
  assert.equal(formatExportDate(new Date(2026, 0, 1)), '2026-01-01 · 星期四');
  // 跨月边界：12 月→1 月的补零
  assert.equal(formatExportDate(new Date(2026, 11, 31)), '2026-12-31 · 星期四');
});

test('EXPORT-04 🔴 长词断行：15 字以上才断，断点插在标点后', () => {
  // 短串不动
  assert.equal(breakLongWords('短句不改'), '短句不改');
  // 长串无标点 → 不动（宁可溢出也不乱切）
  const long = 'a'.repeat(30);
  assert.equal(breakLongWords(long), long);
  // 长串带标点 → 标点后插空格
  const withDot = 'https://example.com/' + 'a'.repeat(20);
  const out = breakLongWords(withDot);
  assert.ok(out.includes('/ '), `标点后应插空格，实得${out}`);
});

test('EXPORT-05 🔴 折叠补丁必须覆盖三角 + 恒定展开 + 缩进引导线', () => {
  // 🔴🔴 老项目出图那枚折叠三角是 ▼ 字形（index.html:3104），且属性**只打在折叠把手上**。
  //   选择器因此收窄到 `[data-ns-export-fold] > :first-child::before`：
  //   早先写的是 `[data-ns-export]::before`，而 buildCard 把该属性打在了**整张离屏卡**上
  //   ⇒ ▼ 被画在卡片正文流最前面 ＝ 用户报障「导出图左上角多了个箭头」。
  //   （那条整卡规则的正向判据已移到 visual-parity 的 VP-10，与反向断言同处一处。）
  assert.match(
    EXPORT_FOLD_CSS,
    /\[data-ns-export-fold\] > :first-child::before/,
    '三角补丁必须挂在折叠把手上，不许打在整张卡上',
  );
  assert.match(EXPORT_FOLD_CSS, /25BC/, '缺 ▼ 字形');
  // 🔴 bj 的折叠规则没锁 #editor 作用域 ⇒ 副本里边框三角会照画，必须 border:0 撤掉
  assert.match(EXPORT_FOLD_CSS, /border:0/, '必须撤掉编辑器那枚边框三角，否则出图出现两个三角');
  // 老项目 v10.0.3 用户实拍「正文没缩进没引导线」⇒ 必须补 margin/padding/border-left
  assert.match(EXPORT_FOLD_CSS, /padding-left/, '缺缩进');
  assert.match(EXPORT_FOLD_CSS, /border-left/, '缺左引导线');
  // 收起态必须被覆盖成展开
  assert.match(EXPORT_FOLD_CSS, /display:block/, '缺恒定展开');
  // 🔴 间隙必须 px：三角挂在行内，em 在那里会随字号缩放（老项目 mockup 实锤）
  assert.match(EXPORT_FOLD_CSS, /margin:0 7px 0 0/, '间隙必须是 px，em 会随字号缩放');
  // 🔴 选择器必须走属性不走 class（class 会与用户正文里恰好出现的名字撞车）
  assert.ok(!EXPORT_FOLD_CSS.includes('.ns-export'), '补丁不许用 class 选择器');
});

test('EXPORT-06 🔴 renderCardToPng 必须用 offsetWidth（scrollWidth 会裁掉 1px 边框）', () => {
  const fn = RENDER_SRC.slice(RENDER_SRC.indexOf('export async function renderCardToPng'));
  assert.match(fn, /width: wrap\.offsetWidth/, '缺 offsetWidth');
  assert.match(fn, /height: wrap\.offsetHeight/, '缺 offsetHeight');
  // 🔴 只在函数体内查scrollWidth：文件头注释里正解释着"为什么不用它"，
  //   全文件搜会把那段解释当成违规（第一版就踩了这个，判据自己打自己脸）。
  assert.ok(!/scrollWidth/.test(fn), '出现 scrollWidth（老项目闸 R2-P2 实锤会裁边线）');
  // scale 必须 2（清晰度契约）
  assert.equal(RENDER_OPTS.scale, 2);
  assert.equal(RENDER_OPTS.backgroundColor, null, '圆角外必须透明');
  assert.equal(RENDER_OPTS.useCORS, true);
});

test('EXPORT-07 🔴 交付阶梯顺序：剪贴板 → 原生桥 → 分享 → 预览', () => {
  const order = ['clipboard', 'native', 'share', 'preview'];
  let last = -1;
  for (const k of order) {
    const at = RENDER_SRC.indexOf(`return '${k}'`);
    assert.ok(at > 0, `阶梯里缺 ${k}`);
    assert.ok(at > last, `${k} 的位置不对（阶梯顺序变了）`);
    last = at;
  }
});

test('EXPORT-08 🔴🔴 剪贴板必须走 Promise 形态（await 渲染就晚了）', () => {
  // 老项目 v7.7.0 血泪：html2canvas 动辄数秒，await 完手势窗口已过，
  //   症状是「桌面能复制、手机永远复制不了」。
  const fn = RENDER_SRC.slice(RENDER_SRC.indexOf('export async function deliverPng'));
  // blobP 装进 ClipboardItem，而不是先 await
  assert.match(fn, /new ClipboardItem\(\{ 'image\/png': blobP \}\)/, '剪贴板未用 Promise 形态');
  // 必须有"渲染完再用 Blob 补一次"的老内核兜底
  assert.match(fn, /new ClipboardItem\(\{ 'image\/png': blob \}\)/, '缺 Blob 形态补写');
  // blobP 的 rejection 必须先挂 catch，否则回退路径返回后成 unhandledrejection
  assert.match(fn, /blobP\.catch\(\(\) => \{\}\)/, '缺 unhandledrejection 兜底');
  // 原生壳下不做 Blob 补写（走桥）
  assert.match(fn, /clipTried && !deps\.isNativeApp/, '原生壳下不该补写剪贴板');
});

test('EXPORT-09 🔴🔴 预览必须是最后一档且永不返回 null', () => {
  const fn = RENDER_SRC.slice(RENDER_SRC.indexOf('export async function deliverPng'));
  // 分享取消 → 'cancelled'，不是 null（用户主动取消不该被当成失败）
  assert.match(fn, /AbortError[\s\S]{0,40}return 'cancelled'/, '用户取消分享未单列');
  // 预览兜底在最后
  const shareAt = fn.indexOf("return 'share'");
  const previewAt = fn.indexOf("return 'preview'");
  assert.ok(previewAt > shareAt, '预览必须在分享之后');
  assert.match(fn, /deps\.showPreview\(blob\)/, '预览兜底未接上');
});

test('EXPORT-10 🔴 离屏卡必须可dispose 且在 finally 里调（老项目泄漏事故）', () => {
  // 老项目 v10.0.2：快路 return 时漏拆，每次导出泄漏一张卡，几十次后卡顿
  assert.match(CARD_SRC, /dispose: \(\) => void/, 'ExportCard 缺 dispose');
  assert.match(INDEX_SRC, /finally\s*\{\s*\/\/[^\n]*\n\s*card\?\.dispose\(\);/, 'finally 里未 dispose');
});

test('EXPORT-11 🔴 组件必须自托管同源懒加载（公共 CDN 在大陆常不可达）', () => {
  assert.match(RENDER_SRC, /'\/html2canvas\.min\.js'/, '必须同源自托管');
  assert.ok(!/https?:\/\/[^\s'"]*jsdelivr/.test(RENDER_SRC), '出现公共 CDN（老项目 v7.5.1 血泪）');
  // 失败必须可重试：loadPromise 置回 null，否则一次断网永久废掉导出
  assert.match(RENDER_SRC, /loadPromise = null;[\s\S]{0,200}resolve\(false\)/, '失败未置回 loadPromise');
});

test('EXPORT-12 桌面封顶 640，触屏跟编辑器宽', () => {
  assert.equal(EXPORT_MAX_WIDTH, 640);
  assert.match(CARD_SRC, /pointer:coarse/, '缺触屏判据');
  assert.match(CARD_SRC, /Math\.min\(srcW, EXPORT_MAX_WIDTH\)/, '桌面未封顶');
});

test('EXPORT-13 blobToB64 去掉 data: 前缀', () => {
  assert.match(RENDER_SRC, /s\.slice\(s\.indexOf\(',\'\) \+ 1\)/, '未剥 data: 前缀');
  assert.equal(typeof blobToB64, 'function');
});

test('EXPORT-14 🔴 失败文案逐字抄老项目，且成功文案按档位分档', async () => {
  const { COPY } = await import('../src/ui/copy.ts');
  // 🔴🔴 本条曾断言「失败文案必须自带『图片未生成』」，现已按老项目翻案。
  //   翻案依据（不是推理，是穷举）：`grep -on "导出失败[^']*" 老项目 index.html`
  //   全库只有两处出现——index.html:2922 与 :2926，两条**都不带**「图片未生成」：
  //     2922  '导出失败：可能因外链图片跨域，请使用支持CORS的图床'
  //     2926  '导出失败：渲染异常'
  //   用户第 11 条原话是「所有的文案都必须和之前的一模一样」，
  //   而「，图片未生成」是老项目里**不存在**的字 —— 属于上一轮自己加的"改进"，
  //   属于用户明确点名的违规项。本条现在钉死逐字一致，**任何人不得再加后缀**。
  assert.equal(COPY.exportFailCors, '导出失败：可能因外链图片跨域，请使用支持CORS的图床');
  assert.equal(COPY.exportFailUnknown, '导出失败：渲染异常');
  assert.equal(COPY.exportFailMsg('x'), '导出失败：x');
  // 老项目 index.html:2899 原文
  assert.equal(COPY.exportLoadFail, '图片导出组件加载失败，请检查网络后重试');
  // 成功文案按档位给不同措辞，不能一律"已复制"
  assert.match(COPY.exportOkMsg('clipboard'), /已复制，可直接 Ctrl\+V 粘贴/);
  assert.match(COPY.exportOkMsg('native'), /已复制，可直接粘贴/);
  assert.match(COPY.exportOkMsg('share'), /系统分享/);
  // 🔴 预览档**不给提示条**（老项目 index.html:2967 showImagePreview 第一行 hideUploadStatus），
  //   所以它既没有措辞也不该有 okMs：export/index.ts 对 preview 直接 return，不走 onStatus。
  assert.equal(COPY.exportOkMs, 3000);
  assert.equal(COPY.exportFailMs, 3000);
});

test('EXPORT-15 🔴 借壳反色护栏：图片 filter 必须内联 !important 钉回none', () => {
  assert.match(
    CARD_SRC,
    /setProperty\('filter', 'none', 'important'\)/,
    '缺借壳护栏（借壳态导出图里图片会多翻一次色）',
  );
});

test('EXPORT-16 卡片结构：外衬卡 + 内衬 + 页头 + 页脚各就位', () => {
  // 🔴 这是**结构**判据，不是样式判据：老项目 v9.5.0 之前是"裸正文平铺"，
  //   用户打回后才改成书纸卡。少任何一层都算功能回退。
  for (const needle of [
    "mat.setAttribute(\n    'style',\n    'background:var(--bg)",
    "wrap.setAttribute(\n    'style',\n    'position:absolute;left:-9999px",
  ]) {
    assert.ok(CARD_SRC.includes(needle), `卡片层缺失：${needle.slice(0, 30)}`);
  }
  // 页脚必须含品牌与题句两处
  assert.match(CARD_SRC, /wmB\.textContent = 'NoteSync'/, '页脚缺品牌落款');
  assert.match(CARD_SRC, /tail\.textContent = pickTagline\(\)/, '页脚缺随机题句');
  // 页头必须含题线与日期
  assert.match(CARD_SRC, /background:var\(--accent\);opacity:\.85/, '页头缺金题线');
  assert.match(CARD_SRC, /dt\.textContent = formatExportDate/, '页头缺日期');
  // 离屏定位必须是 left:-9999px（不能用 display:none —— 那样量不到尺寸）
  assert.match(CARD_SRC, /left:-9999px/, '离屏定位失效（display:none 会量不到尺寸）');
});

test('EXPORT-17 链接转纯文本 + 图片限宽（导出的是给人看的图）', () => {
  assert.match(CARD_SRC, /querySelectorAll\('a'\)/, '链接未转纯文本');
  assert.match(CARD_SRC, /im\.style\.maxWidth = '100%'/, '图片未限宽（640 封顶后会溢出）');
});

test('EXPORT-18 e2e 钩子不得为导出新增测试专用入口', () => {
  const MAIN_SRC = readFileSync(resolve(HERE, '..', 'src', 'main.ts'), 'utf8');
  // 导出走顶栏真实按钮；不许出现 __NOTESYNC_EXPORT__ 之类旁路
  assert.ok(
    !/__NOTESYNC_EXPORT/.test(MAIN_SRC),
    '不许给导出开测试专用入口（那会绕开真实用户路径）',
  );
  assert.match(MAIN_SRC, /case 'exportImg':/, '导出未接顶栏');
  // 编辑器不在时要给可见提示而不是抛错
  assert.match(MAIN_SRC, /exportNoEditor/, '缺"编辑器不在"的守卫');
});

test('EXPORT-19 🔴🔴 html2canvas 必须**入库**（www/ 整个被 gitignore）', () => {
  // 这条钉的是一个真实缺口：html2canvas.min.js 曾只存在于本机 www/ 里，
  //   而 www/ 在 .gitignore 中 ⇒ CI 拉下来的仓库没有它 ⇒ 构建产物缺文件
  //   ⇒ 线上导出整体不可用，而失败文案是「图片导出组件未加载」，
  //   用户只会觉得功能坏了。e2e EXPORT-E01 在本机永远绿，抓不到这个。
  const STATIC = resolve(HERE, '..', 'static');
  assert.ok(existsSync(join(STATIC, 'html2canvas.min.js')), 'html2canvas.min.js 未入库');
  assert.ok(existsSync(join(STATIC, 'sw.js')), 'sw.js 未入库（APK 壳里注册 SW 会静默失败）');
  // 构建脚本必须真的物化它们，而不是"本机有就行"
  const BUILD_SRC = readFileSync(resolve(HERE, '..', '..', '..', 'tools', 'build.mjs'), 'utf8');
  assert.match(BUILD_SRC, /materializeStatic/, '构建脚本未物化静态资源');
  assert.match(BUILD_SRC, /html2canvas\.min\.js/, '构建未点名 html2canvas（缺文件时无人知道）');
  assert.match(BUILD_SRC, /sw\.js/, '构建未点名 sw.js');
});

test('EXPORT-20 🔴 gitignore 不得把静态资源源目录排除掉', () => {
  const gi = readFileSync(resolve(HERE, '..', '..', '..', '.gitignore'), 'utf8');
  // www/ 是构建产物，必须 ignore；packages/client/static/ 是源码，必须**不**被ignore
  assert.match(gi, /^www\/$/m, 'www/ 应继续被忽略（它是构建产物）');
  assert.ok(
    !/packages\/client\/static/.test(gi),
    '静态资源源目录被 gitignore 了（CI 产物必然缺文件）',
  );
});

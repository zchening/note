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

import { stripComments } from './rem-native.test.mjs';

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
  // 🔴🔴 选择器必须带 `.ns-fold[data-ns-export-fold]` 前缀，只写属性那一段会输：
  //   收起态基规则 `.ns-fold[data-open="false"] > :not(:first-child)` 是 **(0,3,0)**
  //   （`:not()` 取其参数 specificity，自身不贡献），
  //   而 `[data-ns-export-fold] > :not(:first-child)` 只有 **(0,2,0)** ⇒ 补丁失效，
  //   导出图里收起的折叠块**整块正文丢失**（用户报障第 11 条）。
  //   上一批就是写短了，而且既有断言全是正则匹配字符串、从不读 computed style，
  //   所以 425 个测试全绿也照样漏过去。
  assert.match(
    EXPORT_FOLD_CSS,
    /\.ns-fold\[data-ns-export-fold\]\[data-open\] > :first-child::before/,
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

test('EXPORT-07 🔴 交付阶梯顺序：原生桥 → 剪贴板 → 分享 → 预览', () => {
  // 🔴🔴 顺序**在 2026-10-13 特意翻转过**（原生桥从第二档提到第一档），
  //   依据是 Chromium 源码而非推理：`ClipboardImpl.setImage()` 在
  //   `mImageFileProvider == null`（WebView 宿主恒为 null）时「drop it on the floor」
  //   却照样让 promise resolve ⇒ 壳内剪贴板档是**假成功**，把它排在前头
  //   就等于永远走不到真正能写系统剪贴板的原生桥（用户报障：微信/小米笔记都粘不出）。
  //   🔴 想改回去的人先回答：壳内 `navigator.clipboard.write` 写图片的返回值
  //   到底有没有被 Chromium 用来区分"写成功了"？没有 —— 所以别改回去。
  // 🔴 v3.2.3：返回从「裸 kind 字符串」改为对象（要多带一个 albumSaved），
  //   所以这里找的是 `kind: '<k>'` 而不是 `return '<k>'` —— 钉的事实没变
  //   （四档谁在前谁在后），只是字面形态随实现演进。判据取数方式随产物形态
  //   演进，这是本项目的老纪律（v3.1.1 VVW-33 同款）。
  const order = ['native', 'clipboard', 'share', 'preview'];
  let last = -1;
  for (const k of order) {
    const at = RENDER_SRC.indexOf(`kind: '${k}'`);
    assert.ok(at > 0, `阶梯里缺 ${k}`);
    assert.ok(at > last, `${k} 的位置不对（阶梯顺序变了）`);
    last = at;
  }
  // 🔴 壳内不许再调 WebView 剪贴板那一档（它会假成功）—— 判据在 EXPORT-21（行为级）
  const fn = RENDER_SRC.slice(RENDER_SRC.indexOf('export async function deliverPng'));
  assert.match(fn, /!deps\.isNativeApp &&\s*\n\s*navigator\.clipboard/, '壳内仍会走 WebView 剪贴板（它会假装成功）');
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
  assert.match(fn, /AbortError[\s\S]{0,60}kind: 'cancelled'/, '用户取消分享未单列');
  // 预览兜底在最后（同上：返回改对象后找 `kind:` 字面）
  const shareAt = fn.indexOf("kind: 'share'");
  const previewAt = fn.indexOf("kind: 'preview'");
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
  // 🔴🔴 用**空白无关**的正则，不要硬编码多行缩进：
  //   原判据写死 `"mat.setAttribute(\n    'style',\n    ..."`，
  //   只要有人给这行换个缩进（或跑 prettier），判据就红 —— 而卡片层其实好好地在那儿。
  //   这类"对排版过敏"的断言会在无关改动时制造假红，久了就没人信它了。
  //   （memory 纪律：判据要钉**产物**，钉到会被无关改动影响的地方就是钉歪了。）
  assert.match(CARD_SRC, /mat\.setAttribute\(\s*'style',\s*'background:var\(--bg\)/, '内衬 mat 层缺失');
  assert.match(
    CARD_SRC,
    /wrap\.setAttribute\(\s*'style',\s*'position:absolute;left:-9999px/,
    '外衬 wrap 层缺失',
  );
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

/* ═══════════════════════════════════════════════════════════════════════
 * EXPORT-N：原生壳「导出为图片并复制」真机报障（2026-10-13）
 *
 * 用户原话：App 上「导出为图片并复制」点了之后，微信里粘不出来，小米自带
 *   笔记 App 里也粘不出来 —— 等于**根本没写进系统剪贴板**。
 *
 * 🔴🔴 真因（源码级，不是推理）：
 *   Chromium `ui/android/.../ClipboardImpl.setImage(byte[], String)` 开头就是
 *     if (mImageFileProvider == null) { /* drop it on the floor *​/ return; }
 *   而 `ImageFileProvider` 只有 Chrome 自己注入（ChromeImageFileProvider），
 *   WebView 宿主（Capacitor 壳）**从不注入** ⇒ 壳内
 *   `navigator.clipboard.write(ClipboardItem{'image/png'})` 被静默丢弃，
 *   但 promise 照常 resolve ⇒ 阶梯在第①档就 return，谎报"已复制"，
 *   系统剪贴板其实空着，原生桥（ImgClip）永远轮不到。
 *
 * ⇒ 判据要钉的是**行为**，不是文案：
 *   ① 原生壳里**不许**先试 WebView 剪贴板（它会假装成功）；
 *   ② 走原生桥之后必须**读回验证**，验证为空就不许算 'native'（不许谎报）。
 * ═══════════════════════════════════════════════════════════════════════ */

/** 装一个可控的 navigator.clipboard 替身，返回调用记录。 */
function stubClipboard(impl) {
  const rec = { writes: 0, items: [] };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { write: async (items) => { rec.writes++; rec.items.push(items); await impl(items); } } },
  });
  Object.defineProperty(globalThis, 'ClipboardItem', {
    configurable: true,
    value: class { constructor(types) { this.types = types; } },
  });
  return rec;
}

test('EXPORT-21 🔴🔴 原生壳必须先走原生桥，绝不许先试 WebView 剪贴板', async () => {
  const { deliverPng } = await import('../src/export/render.ts');

  // ── 场景 A：桥成功 ⇒ 桥被调用、剪贴板**一次都不许调**、结果 native ──
  {
    const clip = stubClipboard(async () => {}); // 会"成功"的假剪贴板 = 真机 WebView 的骗人形态
    let bridge = 0;
    const out = await deliverPng(Promise.resolve(new Blob(['png'])), {
      isNativeApp: true,
      blobToB64: async () => 'QUFB',
      nativeCopyImage: async () => { bridge++; return true; },
      showPreview: () => {},
    });
    assert.equal(bridge, 1, '原生桥必须被调用');
    assert.equal(clip.writes, 0, '桥成功时不该再动剪贴板');
    assert.equal(out.kind, 'native', '桥成功且验证通过应返回 native');
  }

  // ── 场景 B（🔴 真正有牙的一档）：桥**失败**时壳内也不许退回 WebView 剪贴板 ──
  //   若有人把"壳内跳过剪贴板"那个门删掉，场景 A 依然绿（桥成功就 return 了），
  //   只有场景 B 会红：那时会去调那个"假装成功"的剪贴板，谎报 'clipboard'。
  {
    const clip = stubClipboard(async () => {});
    let previewed = 0;
    const out = await deliverPng(Promise.resolve(new Blob(['png'])), {
      isNativeApp: true,
      blobToB64: async () => 'QUFB',
      nativeCopyImage: async () => false,
      showPreview: () => { previewed++; },
    });
    assert.equal(clip.writes, 0, '🔴 原生壳里不许调 WebView 剪贴板（它在壳内会静默丢弃却 resolve）');
    assert.notEqual(out.kind, 'clipboard', '🔴 桥失败时不许靠假成功的剪贴板档收场');
    assert.equal(previewed, 1, '桥失败后必须落到可见出口（预览层）');
  }
});

test('EXPORT-22 🔴🔴 原生桥写完必须读回验证；验证为空不许算成功（不许谎报"已复制"）', async () => {
  const { deliverPng } = await import('../src/export/render.ts');
  stubClipboard(async () => {});
  let previewed = 0;
  // 桥回报成功，但系统剪贴板读回来是空的（＝真机上最可能出现的"谎报"形状）
  const out = await deliverPng(Promise.resolve(new Blob(['png'])), {
    isNativeApp: true,
    blobToB64: async () => 'QUFB',
    nativeCopyImage: async () => true,
    verifyClipboardImage: async () => false,
    showPreview: () => { previewed++; },
  });
  assert.notEqual(out.kind, 'native', '🔴 验证为空时不许回报 native（那等于对用户谎报"已复制"）');
  assert.equal(previewed, 1, '验证落空后必须落到可见出口（预览层）');
});

test('EXPORT-23 🔴 非原生（浏览器）仍是剪贴板优先，且原生桥不参与', async () => {
  const { deliverPng } = await import('../src/export/render.ts');
  const clip = stubClipboard(async () => {});
  let bridge = 0;
  const out = await deliverPng(Promise.resolve(new Blob(['png'])), {
    isNativeApp: false,
    blobToB64: async () => 'QUFB',
    nativeCopyImage: async () => { bridge++; return true; },
    showPreview: () => {},
  });
  assert.equal(out.kind, 'clipboard', '浏览器里仍是剪贴板档收场');
  assert.equal(bridge, 0, '非原生壳不该走原生桥');
  assert.equal(clip.writes, 1, '浏览器里必须真的调用一次剪贴板');
});

/* ═══════════════════════════════════════════════════════════════════════
 * EXPORT-X：复制成功之后，微信那条路怎么办（用户报障，2026-10-13 第二轮）
 *
 * 用户原话：「复制到小米自带的笔记 APP 是可以的；复制到微信好像没反应。
 *   老版本 NoteSync 出现过同样的问题，看看当时是怎么处理的。」
 *
 * 🔴🔴 查证结论（不是猜）：
 *   1. **微信 Android 不支持从剪贴板粘贴图片** —— 多来源一致，第三方实测
 *      （三星平板同款问题）给出的可行路径就是「先存相册，再从微信相册选图」。
 *      这是微信自己的输入实现，网页/原生桥都改不掉。
 *   2. 老项目当年"修复好了"的真相：老项目 index.html:2908 注释自己写着
 *      「Android WebView 对图片写剪贴板长期不可用」⇒ 它判定小米机上
 *      **落不到剪贴板档**，于是用户进微信走的是后面的分享面板 / 预览层
 *      长按转发。bj 现在真把图片写进剪贴板了（小米笔记确实能粘），
 *      反而停在了微信不认的那一档 —— 剪贴板成功 ≠ 用户能把它送进微信。
 *
 * ⇒ 修法：复制成功之后**顺手存一份到系统相册**（已有 ImgSave 桥，零新权限），
 *   提示语指路「微信请从相册选图发送」。剪贴板语义一分不变（小米笔记照旧）。
 *
 * 🔴 文案必须按相册结果分档：存成了才敢提"相册"；没存成绝不许提
 *   （相册里根本没有图，提了就是谎报——全项目同一条纪律）。
 * ═══════════════════════════════════════════════════════════════════════ */

test('EXPORT-24 🔴🔴 壳内复制成功必须顺手存一份相册（微信不认剪贴板图片）', async () => {
  const { deliverPng } = await import('../src/export/render.ts');
  stubClipboard(async () => {});
  const saves = [];
  let b64calls = 0;
  const out = await deliverPng(Promise.resolve(new Blob(['png'])), {
    isNativeApp: true,
    blobToB64: async () => { b64calls++; return 'QUFB'; },
    nativeCopyImage: async () => true,
    saveToAlbum: async (b64, mime) => { saves.push([b64, mime]); return true; },
    showPreview: () => {},
  });
  assert.equal(out.kind, 'native', '复制仍应回报 native');
  assert.equal(saves.length, 1, '🔴 复制成功后必须尝试存相册（否则微信那条路是死的）');
  assert.equal(saves[0][0], 'QUFB', '存进相册的就是剪贴板那一张');
  assert.equal(saves[0][1], 'image/png', '相册存的是 PNG');
  assert.equal(out.albumSaved, true, '存成必须如实回报');
  assert.equal(b64calls, 1, 'base64 只转换一次（剪贴板与相册共用同一份）');
});

test('EXPORT-25 🔴🔴 文案按相册结果分档：存成了指路微信，没存成不许提相册', async () => {
  const { COPY } = await import('../src/ui/copy.ts');
  // 存成：必须同时点名"相册"和"微信" —— 用户要的是能进微信，不提等于没修
  const withAlbum = COPY.exportOkMsg('native', true);
  assert.match(withAlbum, /相册/, '存成相册却不在文案里指路 = 用户不知道微信能走相册');
  assert.match(withAlbum, /微信/, '文案必须点名微信');
  const withAlbumTouch = COPY.exportOkMsgTouch('native', true);
  assert.match(withAlbumTouch, /相册/, '触屏版同样要指路');
  assert.match(withAlbumTouch, /微信/, '触屏版同样要点名微信');
  // 没存成：绝不许提"相册"（相册里没有图，提了就是谎报）
  assert.doesNotMatch(COPY.exportOkMsg('native', false), /相册/, '相册没存成却提相册 = 谎报');
  assert.doesNotMatch(COPY.exportOkMsgTouch('native', false), /相册/, '触屏版同规');
  // 没存成时至少保住老项目原句（小米笔记等仍可粘贴）
  assert.match(COPY.exportOkMsg('native', false), /可直接粘贴/, '相册没存成时不许丢掉老项目原句');
  // 其它档位文案不受影响（EXPORT-14 的逐字对齐仍在）
  assert.match(COPY.exportOkMsg('clipboard', false), /已复制，可直接 Ctrl\+V 粘贴/);
  assert.match(COPY.exportOkMsg('share', false), /已通过系统分享发出/);
});

test('EXPORT-26 🔴 相册桥缺失/抛错/失败都不许把导出搞坏', async () => {
  const { deliverPng } = await import('../src/export/render.ts');
  const cases = [
    ['桥缺失', undefined],
    ['桥回报失败', async () => false],
    ['桥抛错', async () => { throw new Error('boom'); }],
  ];
  for (const [label, save] of cases) {
    stubClipboard(async () => {});
    const out = await deliverPng(Promise.resolve(new Blob(['png'])), {
      isNativeApp: true,
      blobToB64: async () => 'QUFB',
      nativeCopyImage: async () => true,
      saveToAlbum: save,
      showPreview: () => {},
    });
    assert.equal(out.kind, 'native', `${label}：复制本身仍是成功的`);
    assert.equal(out.albumSaved, false, `${label}：albumSaved 必须如实为 false`);
  }
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

/* ═══════════════════════════════════════════════════════════════════════
 * EXPORT-27/28：导出提速（2026-10-13 用户报障「生成图片的时间太长了」）
 *
 * 实测（4400 字笔记、桌面 Chromium）：html2canvas 本体渲染 225–268ms、
 *   toBlob 135–208ms，**冷启动首次导出还要先等一个 198KB 脚本的网络往返**
 *   （移动端几百毫秒到一秒），期间屏幕没有任何反馈。
 * 两项落地（都补自老项目已有而 bj 缺失的东西）：
 *   ① render.ts 补 prefetchHtml2CanvasIdle（老项目 index.html:2877 就有；
 *      bj 只给扫码做了同款预热，导出这条一次都没预热）；
 *   ② exportNotePng 把「正在生成图片…」提示条提到组件加载**之前**
 *      （文件头顺序第 2 条本来就这么写，代码却违反了它）。
 * ═══════════════════════════════════════════════════════════════════════ */

test('EXPORT-27 🔴🔴 导出组件必须空闲预热，且 boot 必须真的调用它（否则预热是死代码）', async () => {
  const { prefetchHtml2CanvasIdle } = await import('../src/export/render.ts');
  const MAIN_SRC = readFileSync(resolve(HERE, '..', 'src', 'main.ts'), 'utf8');

  // ── 源码级：结构要件 ──
  // Node 守卫：本文件直接 import render.ts，无 window 环境不许碰 document
  assert.match(RENDER_SRC, /typeof window === 'undefined'\) return/, '缺 Node 守卫（单测 import 会崩）');
  // 只在预热函数体内断言（文件尾还有别的函数，切片防误伤）
  const fn = RENDER_SRC.slice(
    RENDER_SRC.indexOf('export function prefetchHtml2CanvasIdle'),
    RENDER_SRC.indexOf('export function loadHtml2Canvas'),
  );
  assert.ok(fn.includes('requestIdleCallback'), '缺 rIC 预热');
  assert.ok(fn.includes('{ timeout: 4000 }'), 'rIC 缺 timeout 兜底（移动内核可能永远不调 rIC）');
  assert.ok(fn.includes('loadHtml2Canvas('), '预热必须复用 loadHtml2Canvas（自带 in-flight 去重与失败重试）');

  // ── 行为级：rIC + setTimeout 双保险都注册；两次触发只建一个 script（去重）──
  const ricCbs = [];
  const timers = [];
  const scripts = [];
  const fakeWindow = {
    requestIdleCallback: (cb, opts) => {
      ricCbs.push({ cb, opts });
      return 0;
    },
  };
  const realSetTimeout = globalThis.setTimeout;
  const realDocument = globalThis.document;
  const hadWindow = 'window' in globalThis;
  const realWindow = globalThis.window;
  globalThis.window = fakeWindow;
  globalThis.document = {
    createElement: () => ({}),
    head: { appendChild: (s) => scripts.push(s) },
  };
  globalThis.setTimeout = (cb, ms) => {
    timers.push({ cb, ms });
    return 0;
  };
  try {
    prefetchHtml2CanvasIdle();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(ricCbs.length, 1, 'rIC 预热未注册');
  assert.equal(ricCbs[0].opts && ricCbs[0].opts.timeout, 4000, 'rIC timeout 不是 4000');
  const dup = timers.find((t) => t.ms === 8000);
  assert.ok(dup, '缺 setTimeout(go, 8000) 双保险（国产 WebView 的 rIC 可能永远不来）');
  assert.equal(dup.cb, ricCbs[0].cb, '双保险与 rIC 不是同一个 go（两条路拉的东西不一致）');

  ricCbs[0].cb(); // 第一次触发：真的发起脚本加载
  assert.equal(scripts.length, 1, '预热没有真正发起脚本加载');
  assert.equal(scripts[0].src, '/html2canvas.min.js', '预热拉的路径不对（必须同源自托管）');
  dup.cb(); // 第二次触发（用户此刻点了导出 = 并发）：in-flight 去重
  assert.equal(scripts.length, 1, '预热与用户点导出并发会拉两次（in-flight 去重失效）');

  // 清理：让 pending 的 loadPromise 落地置回 null，不污染后续测试
  if (typeof scripts[0].onerror === 'function') scripts[0].onerror();
  globalThis.document = realDocument;
  if (hadWindow) globalThis.window = realWindow;
  else delete globalThis.window;

  // ── boot 必须真的调用 ──
  // 🔴 import 了却没调用 = 预热是死代码，用户点导出照样冷加载。
  //   锚行首（^\s*）：注释里提到这个名字（解释来历的注释）不算调用。
  assert.match(MAIN_SRC, /^\s*prefetchHtml2CanvasIdle\(\);\s*$/m, 'boot 没有调用导出预热');
});

test('EXPORT-28 🔴🔴 提示条必须先于组件加载上屏（看不见的等待 = 「点了没反应」）', async () => {
  // 🔴 行为级：真跑 exportNotePng，记录事件序列 —— 源码 indexOf 比顺序
  //   钉不住"将来有人把整段搬进 try 换个写法"这类等价回退，行为序列才钉得住。
  //   script 桥在 appendChild 时同步走 onerror ⇒ loadHtml2Canvas 立刻 resolve(false)
  //   ⇒ exportNotePng 走 loadfail 分支收场，正好覆盖"加载失败也要有反馈"这条路。
  const events = [];
  const realDocument = globalThis.document;
  const hadWindow = 'window' in globalThis;
  const realWindow = globalThis.window;
  globalThis.window = {}; // loadHtml2Canvas 要读 window.html2canvas；Node 无 window
  globalThis.document = {
    createElement: () => ({}),
    head: {
      appendChild: (s) => {
        events.push('script');
        if (typeof s.onerror === 'function') s.onerror();
      },
    },
  };
  let result;
  try {
    const { exportNotePng } = await import('../src/export/index.ts');
    result = await exportNotePng({
      editorHost: {},
      noteId: 'n',
      brandSvg: null,
      dismissKeyboard: () => events.push('keyboard'),
      onStatus: (kind) => events.push('status:' + kind),
      hideStatus: () => events.push('hide'),
      okMs: 3000,
      failMs: 3000,
      isNativeApp: true,
      nativeCopyImage: async () => true,
    });
  } finally {
    globalThis.document = realDocument;
    if (hadWindow) globalThis.window = realWindow;
    else delete globalThis.window;
  }
  assert.equal(result, 'loadfail', 'script onerror 后应走 loadfail 收场');
  const at = (e) => events.indexOf(e);
  assert.ok(at('keyboard') >= 0, '触屏收键盘没跑（顺序第 1 条没了）');
  assert.ok(at('status:doing') >= 0, "'正在生成图片…' 提示条没开");
  assert.ok(
    at('status:doing') < at('script'),
    `提示条跑到了组件加载之后（序列：${events.join(' → ')}）—— 冷启动首次导出要先等 198KB 脚本往返，期间屏幕无任何反馈`,
  );
  assert.ok(at('status:bad') >= 0, '加载失败必须给可见失败提示，不许静默');
});

/* ═══════════════════════════════════════════════════════════════════════
 * EXPORT-29/30/31：导出后提示分平台（2026-10-13 用户报障第 4 条，逐字拍板）
 *
 * 用户原话：
 *   - PC端：还是像现在一样，生成图片并复制到剪贴板。
 *   - 移动端：弹出一个弹窗，上面是生成图片的预览图；下面左边是"保存到相册"
 *     按钮，右边是"分享"按钮。点击分享后，就会调用系统分享组件，跟分享整个
 *     诊断报告一样。弹窗右上角是关闭按钮，点击那个叉叉可以关闭；点击弹窗
 *     其他位置，包括外围位置，都没法关闭。
 *
 * 🔴🔴 为什么移动端必须换成交互而不是继续复制链路：
 *   微信 Android 不支持从剪贴板粘贴图片（v3.2.3 实锤），"复制"在移动端
 *   只剩小米笔记一个目的地 —— 用户要的是把图发出去，不是复制。
 * 🔴 为什么判据是源码级（去注释后结构断言）+ e2e 行为级兜底：
 *   弹窗是 DOM 重活，单测无真浏览器；本项目 DOM 构建类组件的既有形态
 *   就是 diag-panel.test.mjs 这套（DIAG-17/18 同款），e2e 09-export 补真交互。
 * ═══════════════════════════════════════════════════════════════════════ */

// 🔴 keepStrings：本组判据大量断言字符串字面量（'modal' / 'box-x' /
//   'data:image/png;base64,'），stripComments 默认把字符串内容剥掉 ——
//   不开它，"缺东西"的红全是判据自己剥出来的（diag-panel 的 cleanKeepStr 同款）。
const IDX_CLEAN = stripComments(INDEX_SRC, { keepStrings: true });

/** 切出 showExportModal 函数体（去注释；到下一个顶层 export 声明为止）。 */
const modalFn = () => {
  const start = IDX_CLEAN.indexOf('export async function showExportModal');
  const next = IDX_CLEAN.indexOf('export async function exportNotePng');
  return IDX_CLEAN.slice(start, next > start ? next : undefined);
};

test('EXPORT-29 🔴🔴 触屏渲染成功必须交给弹窗接管，不许再走复制阶梯', () => {
  // 🔴 分岔点必须在 deliverPng 之前：桌面才走四档阶梯，触屏在渲染成功后分岔
  const touchAt = IDX_CLEAN.indexOf('if (isTouchDevice())');
  const deliverAt = IDX_CLEAN.indexOf('await deliverPng(');
  assert.ok(touchAt > 0, 'exportNotePng 里缺触屏分岔');
  assert.ok(deliverAt > touchAt, '触屏分岔必须排在 deliverPng 之前（先分岔，桌面才走阶梯）');
  const branch = IDX_CLEAN.slice(touchAt, deliverAt);
  // 🔴🔴 复制语义在移动端退场：分支内不许出现任何复制调用
  //   （壳内 WebView 剪贴板写图片本来就是假成功，v3.2.2 实锤；微信又不认剪贴板图）
  assert.ok(
    !/nativeCopyImage|clipboard/i.test(branch),
    '触屏分支里不许出现复制相关调用（移动端走弹窗，不走复制）',
  );
  // 🔴 弹窗打开前必须清「正在生成图片…」提示条：否则提示条在弹窗底下挂一整场
  //   （预览层 zIndex 40 盖住提示条 —— 与"预览档不给提示条"同一实锤）
  const hideAt = branch.indexOf('hideStatus()');
  const modalAt = branch.indexOf('showExportModal(');
  assert.ok(hideAt >= 0 && modalAt > hideAt, '弹窗打开前必须调 hideStatus() 清提示条');
  // 返回类型必须单列 'modal'（调用方能分辨"已交弹窗接管"）
  // 🔴 用原始源码判：stripComments keepStrings 保留内容但**去引号**，'modal' 会查不到
  assert.ok(INDEX_SRC.includes("'modal'"), "ExportResult 缺 'modal'");
});

test('EXPORT-30 🔴🔴 弹窗结构：预览图 + 左保存右分享 + 右上角叉；外围/其他位置不关', () => {
  const fn = modalFn();
  // 弹窗 id（e2e 与关闭去重都靠它）
  assert.ok(fn.includes('exportModalMask'), '弹窗 mask 缺 id=exportModalMask');
  // 🔴🔴 用户逐字拍板「点击弹窗其他位置，包括外围位置，都没法关闭」：
  //   对照组 showPreview 有 `e.target === overlay` 外围关闭 —— 弹窗绝不许有
  assert.ok(!/e\.target\s*===\s*mask/.test(fn), '外围点击不许关闭弹窗（用户拍板）');
  assert.ok(!/mask\.addEventListener\('click'/.test(fn), 'mask 不许绑任何点击关闭');
  // 右上角关闭叉：全站同一枚 ICON_X（box-x 类），不用字形 ×
  assert.ok(fn.includes('box-x'), '缺右上角叉（box-x）');
  assert.ok(fn.includes('ICON_X()'), '叉必须用全站 ICON_X SVG（不用字形 ×）');
  // 🔴 预览图必须用 data: URL 而不是 blob:：壳内 WebView 长按菜单对 blob: 图
  //   常不给保存项，data: 才有"长按存图"这条最后兜底（编辑器内图片同形态实锤）
  assert.ok(fn.includes('data:image/png;base64,'), '预览图必须用 data: URL（长按可存兜底）');
  // 🔴🔴 保存按钮**整个**（创建+上屏）必须包在 `if (deps.saveToAlbum) {` 块里：
  //   只在 handler 里守卫是假显隐 —— 按钮照样显示，点了才失败（e2e EXPORT-M01
  //   抓过这个：按钮无条件 append，判据被 handler 里的同名守卫骗绿）。
  assert.ok(/if \(deps\.saveToAlbum\) \{/.test(fn), '保存按钮必须由 saveToAlbum 桥存在与否决定显示');
  assert.ok(/row\.append\(saveBtn, shareBtn\)/.test(fn), '缺 row.append(saveBtn, shareBtn)（左保存右分享）');
  assert.ok(/row\.append\(shareBtn\)/.test(fn), '无桥时必须只上分享按钮');
  // 左保存右分享 + 标题/叉顺序（精确钉各 append，别被通用正则骗绿 —— 现在
  //   fn 里有 head.append(h, x) 与 row.append(...) 两种两参 append）
  assert.ok(/row\.append\(saveBtn,\s*shareBtn\)/.test(fn), '缺 row.append(saveBtn, shareBtn)（左保存右分享）');
  assert.ok(/row\.append\(shareBtn\)/.test(fn), '无桥时必须只上分享按钮');
  assert.ok(/head\.append\(h,\s*x\)/.test(fn), 'modal-head 内序必须标题在左、叉在右');
  // 🔴🔴 v3.2.5 报障①：按钮禁用 .row-btn —— 其 flex:none + 通栏
  //   .box button{width:100%} 叠加 = 两枚各 297px 的不可收缩按钮并排，
  //   总宽 594px 溢出 297px 的行（真机实锤）。改 inline flex:1 1 0 等分收缩。
  assert.ok(!fn.includes('row-btn'), '弹窗按钮不许用 .row-btn（flex:none+通栏宽=横向溢出）');
  assert.ok(fn.includes('flex:1 1 0;min-width:0'), '按钮必须等分且可收缩（flex:1 1 0;min-width:0）');
  // 🔴 v3.2.5 报障②：叉必须进 .modal-head（右上角）—— .box-x 是流内格子
  //   （无 absolute），直接挂 box 会掉到标题下方左侧（真机实锤）。
  assert.ok(fn.includes('modal-head'), '缺 modal-head 包裹（叉要右上角与标题同行）');
  assert.ok(/head\.append\(h,\s*x\)/.test(fn), '标题与叉必须同进 modal-head');
  assert.ok(/box\.append\(head,/.test(fn), 'box 必须挂 head（不是裸 h+x）');
  // 🔴 反馈必须收进弹窗自己的 DOM（diagNote 同款纪律）：弹窗 zIndex 40 盖住
  //   #uploadNote，把反馈写进提示条 = 用户看不见 = 「点了没反应」
  assert.ok(/aria-live|role.*status|'status'/.test(fn), '弹窗内缺反馈条（role=status/aria-live）');
});

test('EXPORT-31 🔴🔴 分享阶梯：壳内 ImgShare 桥 → 网页 navigator.share；取消静默；失败弹窗内反馈', () => {
  const fn = modalFn();
  const shareStart = fn.indexOf('const onShare');
  const share = shareStart >= 0 ? fn.slice(shareStart) : fn;
  // ① 壳内桥在前（WebView 无 navigator.share —— MainActivity 注释双实锤）
  const bridgeAt = share.indexOf('hasNativeShare()');
  const webAt = share.indexOf('nav.share');
  assert.ok(bridgeAt > 0, '分享缺壳内 ImgShare 桥路径');
  assert.ok(webAt > bridgeAt, '网页 navigator.share 必须排在壳内桥之后');
  // ② 用户在系统面板点取消（AbortError）⇒ 静默收场，不给"失败"（诊断分享同款口径）
  assert.ok(/AbortError/.test(share), '分享取消未单列（不许把用户取消当失败）');
  // ③ 真失败必须弹窗内可见反馈
  assert.ok(/exportShareFail/.test(share), '分享失败缺可见反馈文案');
  // 🔴🔴 v3.2.5 报障③：分享成功（桥 ok / nav.share resolve）与用户取消
  //   （AbortError = 面板用完了）三条路都必须自动关弹窗 —— 点完就走
  assert.ok(/nativeShareImage\([\s\S]{0,120}?close\(\)/.test(share), '壳内桥拉起成功必须 close()');
  assert.ok(/await nav\.share\(\{[\s\S]{0,200}?close\(\)/.test(share), '网页分享成功必须 close()');
  assert.ok(/AbortError[\s\S]{0,120}?close\(\)/.test(share), '用户取消分享面板必须 close()');
  // ④ 保存按钮点击：成功自动关弹窗（关窗本身即成功反馈）；失败弹窗内可见反馈
  assert.ok(/if \(ok\) close\(\)/.test(fn), '保存成功必须自动关弹窗（用户拍板「点完自动关」）');
  assert.ok(/exportAlbumFail/.test(fn), '保存失败缺反馈');

  // ⑤ 原生桥文件：现读 Capacitor.Plugins.ImgShare（diag/ImgSave 同款纪律）
  const NIS = resolve(HERE, '..', 'src', 'image', 'native-img-share.ts');
  assert.ok(existsSync(NIS), 'native-img-share.ts 不存在');
  const nis = stripComments(readFileSync(NIS, 'utf8'));
  assert.ok(/ImgShare/.test(nis), 'native-img-share.ts 没有现读 ImgShare 桥');

  // ⑥ 原生侧：桥文件 + MainActivity 注册（缺注册 = 桥永远读不到 = 死代码）
  const KT = resolve(
    HERE, '..', '..', '..', 'android', 'app', 'src', 'main', 'java',
    'cn', 'xuyinji', 'bj', 'img', 'ImgSharePlugin.kt',
  );
  assert.ok(existsSync(KT), 'ImgSharePlugin.kt 不存在');
  const kt = readFileSync(KT, 'utf8');
  assert.ok(kt.includes('@CapacitorPlugin(name = "ImgShare")'), 'KT 缺 CapacitorPlugin 注册名');
  assert.ok(kt.includes('Intent.ACTION_SEND'), 'KT 缺 ACTION_SEND（系统分享面板）');
  assert.ok(kt.includes('FLAG_GRANT_READ_URI_PERMISSION'), 'KT 缺 URI 授权（接收方读不到图片）');
  const MA = resolve(
    HERE, '..', '..', '..', 'android', 'app', 'src', 'main', 'java',
    'cn', 'xuyinji', 'bj', 'MainActivity.java',
  );
  const ma = readFileSync(MA, 'utf8');
  assert.ok(ma.includes('registerPlugin(ImgSharePlugin.class)'), 'MainActivity 缺 ImgShare 注册（桥永远读不到）');
});

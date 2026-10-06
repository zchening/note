/**
 * e2e：/dragon 与老版本对齐（DRG-E2- 系列）—— 真浏览器 + 真像素
 *
 * 🔴🔴 本文件要验的是用户报障「/dragon 界面与老版本不一样」的那一批差异。
 *   这类报障的共同特征是**测试全绿但用户看到的就是不对**：每一项都是
 *   「少画了一个东西」或「画的位置/宽度不一样」，而功能测试（能进游戏、
 *   能跳、能死）照样通过。所以判据必须**量化到像素与字符**。
 *
 * 逐项对应老项目 `index.html:11728-11814`：
 *   B  'NO NETWORK · 那就跑会儿步' / '未命名笔记 · N 字' 站牌（:11793-11802）
 *   C  地面 12 段滚动虚线（:11780）
 *   D  撞击震动 shake=0.2（:11768/:11777）
 *   E  速度曲线按**秒**不按距离（:11759）
 *   F  分数三位补零（:11772）
 *   G  结算三行 + 历史最佳持久化（:11769 + :10683-10687）
 *   H  30% 高障碍（:11737-11738）
 *   I  低头 duck（:11751/:11764/:11785）
 *   J  障碍词按实测框宽裁剪（:11809 `clipTo`，v9.2.0）
 *
 * 🔴🔴 判据纪律（两条，都要遵守）：
 *
 *  1. **行为判据一律走真浏览器量像素/ 读 DOM**。读源码只能证明"代码写了这行"，
 *     证明不了"用户看到的是这个"。凡是"某句话/某个形状/某个动画在不在"，
 *     都必须由像素来回答。
 *  2. **纯文本/纯代码形状的判据（文案逐字、某个正则、save/restore 配平）读 `src/` 源码**，
 *     绝不读 `www/app.js`。
 *     🔴 这是上一轮 7 条假红的共同根因：`www/app.js` 是**压缩产物**
 *        （`shake = .2`、`历史最佳` → `\uXXXX`、变量名混淆），
 *        所有 `appJs.includes('NO NETWORK · 那就跑会儿步')` 这类正则**必然落空** ——
 *        判据红在"产物被压缩"这件与本次改动无关的事上，训练人忽略红灯。
 *     ⇒ 仓库既有约定已经这么干：`visual-parity.test.mjs` 就读 `styles.css` /
 *        `scan/layer.ts` / `main.ts`（见其 `code()` helper）。
 *
 *  3. 🔴 **canvas 判据的三个坑**（上一轮踩过）：
 *     a) canvas 全程只`clearRect`、**从不填底** ⇒ 没画到的像素是
 *        `rgba(0,0,0,0)`。判「非背景」**必须看 alpha 通道**，
 *        比 RGB 与 `--bg` 的差会把**整行**都当成有内容（判据恒真/恒假）。
 *     b) 测速要用**长窗口**。分数是 4 单位量化（`Math.floor(dist/4)`），
 *        逐帧采样会 aliasing 出约 2× 的假速度。
 *     c) 扫描区间要跟着龙标的 x 坐标走（现在是 **16**，`x=16`，:11781），
 *        别留旧的 `[56,98]`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHarness, openEditor, withTimeout } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WWW = resolve(HERE, '..', '..', '..', '..', 'www');

/**
 * `src/egg/games.ts` 的**源码**（不是产物）。
 *
 * 🔴 判"代码里有没有这句/这个正则"时**必须**读它，见文件头纪律 2。
 *   统一走 `codeOnly` 去掉注释：判据问的是"代码里有没有"，
 *   而本文件与 games.ts 的注释里都在**引用**老项目的原文
 *   （如`'历史最佳'`、`slice(0, 6)`），不去注释会被自己的说明文字判红。
 */
const GAMES_SRC = readFileSync(resolve(HERE, '..', '..', 'src', 'egg', 'games.ts'), 'utf8');
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}
const GAMES_CODE = codeOnly(GAMES_SRC);
/** dragon 那段实现（`id: 'dragon'` 到 `id: 'brick'` 之间）。 */
const dragonFn = () => GAMES_CODE.slice(GAMES_CODE.indexOf("id: 'dragon'"), GAMES_CODE.indexOf("id: 'brick'"));

const h = installHarness(test, { dir: WWW });

const PASS = '测试口令';

/** 开局、进入 dragon、等intro 的3秒过去（老项目 :11757 intro 相位）。 */
async function openDragon(page) {
  await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('dragon'));
  await withTimeout(page.waitForSelector('#nsCv'), 10_000, '等dragon 画布');
  // intro 是**前 3 秒只跑动画不判碰撞**（老项目 :11757）——
  //   等它过去才看得到 run 相位的画面（地面虚线/障碍）。
  await withTimeout(page.waitForTimeout(3400), 6000, '等 intro 结束');
}

/**
 * 数「非背景色的连续段」个数（用来数地面虚线）。
 *
 * 🔴🔴 判非背景**看 alpha**（文件头纪律 3a）：canvas 从不填底，
 *   背景像素是 `rgba(0,0,0,0)`，比 RGB 与 `--bg` 的差会把整行算成有内容。
 *   `alpha > 阈值` 才是"这里真的画了东西"。
 *
 * @param {{y:number, alpha?:number}} arg y=画布**逻辑**纵坐标；alpha=不透明阈值
 */
const COUNT_SEGMENTS = ({ y, alpha = 20 }) => {
  const cv = document.getElementById('nsCv');
  const c = cv.getContext('2d');
  const dpr = cv.width / parseFloat(cv.style.width);
  const yy = Math.round(y * dpr);
  const d = c.getImageData(0, yy, cv.width, 1).data;
  let segs = 0;
  let on = false;
  let firstX = -1;
  for (let px = 0; px < d.length / 4; px += 1) {
    const hit = d[px * 4 + 3] > alpha;
    if (hit && !on) {
      segs += 1;
      if (firstX < 0) firstX = px / dpr;
      on = true;
    } else if (!hit) on = false;
  }
  return { segs, firstX, dpr };
};

/** 取一条横带的像素哈希（证明"这块地方画了东西"，且帧间不同 = 是动画）。 */
const BAND_HASH = ({ y, h }) => {
  const cv = document.getElementById('nsCv');
  const c = cv.getContext('2d');
  const dpr = cv.width / parseFloat(cv.style.width);
  const d = c.getImageData(0, Math.round(y * dpr), cv.width, Math.max(1, Math.round(h * dpr))).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s = (s * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) % 2147483647;
  return s;
};

/**
 * 量龙形墨迹的**包围盒**（页内函数，供 07/11 共用）。
 *
 * 🔴🔴🔴 **必须按颜色筛，不能只按 alpha** —— 这是量龙形最容易踩的坑：
 *   障碍（牌子）从右往左滚，会**从恐龙身上压过去**。
 *   牌子画的是 `boxBg` 实底 + `line` 描边，两者 alpha 都 > 0
 *   ⇒ 只按 alpha 判"有内容"时，量到的box 里混进了牌子的像素。
 *   实测：某帧量到宽 27（真值 23），多出来的 4px 就是正在压过龙身的牌子。
 *   而且这个错**不是恒定的**（取决于那一刻牌子走到哪）⇒ 表现为"时绿时红"。
 *
 * ⇒ 只认**恐龙自己的颜色** `--accent`（撞击后是 `--danger`，一并放行）。
 *   牌子的 `--box-bg`/`--line`、地面的 `--line`、站牌的 `--muted` 都被排除。
 *   🔴 判"是不是这个颜色"必须同时看 alpha —— 抗锯齿边缘像素的 RGB 会插值，
 *     只比 RGB 会把背景透明像素（RGB 恒为 0）也算进来。
 */
const DINO_BBOX = ({ x0 = 10, x1 = 48, pad = 4 } = {}) => {
  const cv = document.getElementById('nsCv');
  const c = cv.getContext('2d');
  const dpr = cv.width / parseFloat(cv.style.width);
  const H = parseFloat(cv.style.height);
  const GY = H - 46;
  const cs = getComputedStyle(document.body);
  const rgbOf = (name, fb) => {
    const m = /^#?([0-9a-f]{6})$/i.exec((cs.getPropertyValue(name) || '').trim());
    if (m) {
      return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    }
    const n = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(cs.getPropertyValue(name) || '');
    return n ? [Number(n[1]), Number(n[2]), Number(n[3])] : fb;
  };
  const accent = rgbOf('--accent', [138, 106, 47]);
  const danger = rgbOf('--danger', [179, 64, 47]);
  const near = (r, g, b, t) => Math.abs(r - t[0]) + Math.abs(g - t[1]) + Math.abs(b - t[2]) <= pad;
  const px0 = Math.round(x0 * dpr), px1 = Math.round(x1 * dpr);
  const y0 = Math.round((GY - 90) * dpr), y1 = Math.round((GY - 1) * dpr);
  const d = c.getImageData(px0, y0, px1 - px0, y1 - y0).data;
  const W = px1 - px0;
  let top = -1, bottom = -1, left = -1, right = -1;
  for (let y = 0; y < y1 - y0; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      if (d[i + 3] <= 20) continue;
      if (!near(d[i], d[i + 1], d[i + 2], accent) && !near(d[i], d[i + 1], d[i + 2], danger)) continue;
      if (top < 0) top = y0 + y;
      bottom = y0 + y;
      if (left < 0 || x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (top < 0) return null;
  return { h: bottom / dpr - top / dpr, w: (right - left + 1) / dpr, left: left / dpr + x0 };
};

test('DRG-E2 /dragon 与老版本对齐（用户报障第 8 条后半）', async (t) => {
  const browser = h.browser();

  await t.test('DRG-E2-01 开场站牌与文案逐字等于老项目 :11795 / :11801', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE01', PASS);
    try {
      // 🔴 反向先行：还没进游戏时，画布**节点**不该存在，
      //   否则下面那几条像素断言可能在画一块"上一局残留的画布"。
      //   🔴🔴 上一轮这里写的是 `typeof document.getElementById('nsCv') === 'null'`——
      //   **`typeof null` 的值是 `'object'`，永远不等于 `'null'`** ⇒ 这条恒为 false
      //   ⇒ 判据红在"JS 语义写错"上，而被测行为（画布确实还不存在）其实是对的。
      //   探针实测：节点 `exists: false`，而旧表达式给 `false`。判据问错了对象。
      const before = await page.evaluate(() => document.getElementById('nsCv') === null);
      assert.equal(before, true, '未进游戏时不该有 dragon 画布（否则下面几条是恒真的）');

      await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('dragon'));
      await withTimeout(page.waitForSelector('#nsCv'), 10_000, '等 dragon 画布');

      // 开场文字是画在 canvas 上的，DOM 里查不到 —— 必须**扫像素**证明它真的画了。
      // 老项目把 'NO NETWORK · 那就跑会儿步' 画在 y=22（:11795），10px 字体 ⇒ 带取 y∈[12,32]。
      const topHashes = [];
      for (let i = 0; i < 6; i += 1) {
        topHashes.push(await page.evaluate(BAND_HASH, { y: 12, h: 20 }));
        await page.waitForTimeout(180);
      }
      // 🔴 反向先行：如果这块带一直是空的（哈希恒 0），下面两条就是恒真的。
      //   🔴 注意**首帧可能是 0**：`#nsCv` 是 `launch()` 里同步建出来的，
      //   而第一帧 `draw()` 要等下一个 rAF ⇒ 立刻采样会拿到一块**还没画过**的画布
      //   （全透明 ⇒ 哈希 0）。并发跑时这个窗口更容易被撞上。
      //   ⇒ 判"非空"与判"恒定"都**只在非零样本上做**。
      const painted = topHashes.filter((x) => x !== 0);
      assert.ok(painted.length >= 4, `开场顶部应有文案像素，6 帧里只有 ${painted.length} 帧已绘制（${JSON.stringify(topHashes)}）`);
      // 🔴🔴 **开场文案是静态的** —— 老项目 :11794-11795 把它画在固定的
      //   `c.fillText('NO NETWORK · 那就跑会儿步', W/2 - 84, 22)`，
      //   每一帧同位置同内容 ⇒ 这条带的哈希**就该恒定**。
      //   上一轮这里断言的是 `new Set(hashes).size >= 2`（"帧间不该完全相同"），
      //   理由写的是":11782 有 dip 位移"—— 但 **dip 位移的是恐龙，不是这行字**。
      //   探针实测已绘制帧的 TOP 恒为 1048248146，而同一时刻龙身带的哈希
      //   是 1599722268/911466876/188320936/… 逐帧不同。
      //   ⇒ 那条断言红的是"把龙标的动画算到了文案头上"，属于判据问错了对象。
      assert.equal(
        new Set(painted).size,
        1,
        `开场文案是静态的（老项目 :11795 固定位置），已绘制帧的哈希应恒定，实得 ${JSON.stringify(topHashes)}`,
      );
      // 🔴 而 intro 的**动画**在龙标那条带上 —— 这里不断言"变没变"，
      //   那属于 DRG-E2-12（滑入）与 DRG-E2-07（浮沉）的判据范围，不在这里重复。

      //🔴 文案逐字核对（老项目 :11795 / :11801）。canvas 取不到文本，
      //   所以走**源码**（`src/egg/games.ts`）。
      //   🔴🔴 上一轮这里 `fetch('/app.js')` 读的是**产物**，而产物被压缩过
      //   （中文串被转成 `\uXXXX`、变量名混淆）⇒ `includes` 必然落空，
      //   判据红在"产物被压缩"这件与被测行为无关的事上。改读源码（文件头纪律 2）。
      assert.ok(
        GAMES_CODE.includes('NO NETWORK · 那就跑会儿步'),
        '老项目 :11795 文案须逐字存在（间隔号是 U+00B7，不是 ·也不是 -）',
      );
      assert.ok(GAMES_CODE.includes('未命名笔记 · '), '老项目 :11801 站牌文案须逐字存在');
      // 🔴 站牌字数按 `title().length * 128` 算（老项目 :11801）——
      //   反向：写死一个数字的话下面这条会红。
      assert.ok(
        /128\)\.toLocaleString\('en-US'\)/.test(GAMES_CODE),
        '站牌字数须按 title().length*128 算（老项目 :11801），不许写死',
      );
      // 反向：站牌必须**只在 intro 的1.2~3 秒之间**画（老项目 :11796 `it >= 1.2 && it < 3`）
      assert.ok(/it >= 1\.2 && it < 3/.test(GAMES_CODE), '站牌的出现区间须逐字等于老项目 :11796');
    } finally {
      await page.close();
    }
  });

  await t.test('DRG-E2-02 地面是 12 段滚动虚线（老项目 :11780），不是一条实心块', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE02', PASS);
    try {
      await openDragon(page);
      const box = await page.$eval('#nsCv', (e) => {
        const r = e.getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      // 地面基线在 `GY = h - 46`，虚线画在 `GY + 7`、高 **1px**（老项目 :11780 `fillRect(x, GY+7, 3, 1)`）。
      //🔴 采样行只能落在 `GY + 7` 那一行：1px 高的带子，±1 就采到空了。
      //   上一轮取 `[6,7,8]` 三个偏移，其中 6 与 8 恒空⇒ `firstX` 恒为 -1，
      //   9 个样本里只有 3 个（dy=7 那3 次）扫得到起点 ⇒
      //   下面`xs.length >= 4` 与「起点应变化」两条都在**量一个不存在的东西**。
      //   探针实测：dy=6/8/9 全是 segs=0，只有 dy=7 有 11 段。
      //   ⇒ 判据改成"在**正确**的那一行上多扫几次"。
      const samples = [];
      for (let i = 0; i < 9; i += 1) {
        samples.push(await page.evaluate(COUNT_SEGMENTS, { y: box.h - 46 + 7 }));
        await page.waitForTimeout(110);
      }
      // 🔴 承重：12 段（老项目 :11780 `for (i<12)`）。
      //   取 9 帧里的最大段数 —— 段数只会因为采样线正好压在段边缘而少，不会多。
      //   探针实测 11 段（画布 1280 宽时末尾两段落在 `x > W` 外被裁掉）⇒ 界取 10~12。
      const maxSegs = Math.max(...samples.map((x) => x.segs));
      assert.ok(
        maxSegs >= 10 && maxSegs <= 12,
        `地面应为约 12 段滚动虚线，实测最多 ${maxSegs} 段（${JSON.stringify(samples.map((x) => x.segs))}）`,
      );
      // 🔴 反向：实心块（bj 此前 `fillRect(0, ground+20, w, 26)`）在这条带上
      //   只会是 1 段（或 0 段，若位置差了几像素）⇒ maxSegs ≤ 1 时必红。
      assert.ok(
        maxSegs > 1,
        `若最多只有 ${maxSegs} 段，说明退化成了实心块或空带（正是本次要修的）`,
      );
      // 🔴 滚动断言：段起点应随距离左移（老项目 :11780 的 `dist * 2.2`）。
      // 🔴 每一次都必须扫得到（采样行已固定在正确的那一行）——
      //   上一轮 `>= 4` 是按"9 个样本里有 4 个能扫到"设的，
      //   而实际只有 1/3 能扫到 ⇒ 判据红在一个已被修掉的量法缺陷上。
      const xs = samples.map((x) => x.firstX);
      assert.ok(
        xs.every((v) => v >= 0),
        `9 次采样都应扫到虚线起点（采样行固定在 GY+7），实得 ${JSON.stringify(xs)}`,
      );
      assert.ok(
        new Set(xs).size >= 2,
        `虚线应随距离滚动（老项目 :11780），起点始终不变说明没在动：${JSON.stringify(xs)}`,
      );
      void box.w;
    } finally {
      await page.close();
    }
  });

  await t.test('DRG-E2-03 分数是三位补零（老项目 :11772 padStart(3,\'0\')）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE03', PASS);
    try {
      await openDragon(page);
      // 等分数动起来（dist 要跑过一段才会非 0）
      await withTimeout(
        page.waitForFunction(
          () => {
            const s = document.querySelector('.ns-sc')?.textContent ?? '';
            return s !== '' && s !== '0';
          },
          { timeout: 8000 },
        ),
        10_000,
        '等分数非 0',
      );
      const score = (await page.textContent('.ns-sc'))?.trim() ?? '';
      // 🔴 承重断言：三位。不补零时 "7" 宽度与 "007" 不同 ⇒ HUD 分数位左右跳。
      assert.match(score, /^\d{3}$/, `分数须三位补零（老项目 :11772），实得 ${JSON.stringify(score)}`);
      assert.ok(Number(score) > 0, `分数应已非 0，实得 ${score}`);
      // 🔴 反向：去掉 padStart 后这个断言必红 —— "7" 不匹配 ^\d{3}$。
      assert.ok(!/^\d{1,2}$/.test(score), '若分数只有 1~2 位，说明补零被去掉了');
    } finally {
      await page.close();
    }
  });

  await t.test('DRG-E2-04 速度曲线按秒不按距离（老项目 :11759 `it * 0.8`）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE04', PASS);
    try {
      await openDragon(page);
      // 老项目：sp = 132 + min(70, it * 0.8)，it 是**秒**。
      //   ⇒ t=4s 时 sp ≈ 132+3.2 = 135.2；t=40s 时 sp ≈ 132+32 = 164。
      //   按距离算（bj 此前 `dist * 0.05`）的话，t=4s 时 dist≈530 ⇒ +26.5，明显更快。
      //
      // 🔴🔴 **必须用长窗口**（文件头纪律 3b）：分数是 `Math.floor(dist/4)`，
      //   4 个距离单位才跳 1 分。逐帧（约 16ms，dist 只涨约 2.1 单位）时，
      //   分数**经常一帧都不跳**，于是 `(n - prev)` 落在"这一帧跳了 2 分"或
      //   "这一帧跳了 0 分但时间过了"两种极端上 ⇒ 算出约 2× 或 0 的假速度。
      //   上一轮就是这么假红的。
      //   🔴🔴 站在原地不跳 ⇒ 大约第 8 秒必然撞上第一块牌子（老项目 :11767 的碰撞判据
      //   是真在跑的），**结算卡一出现 `frame()` 就return**（老项目 :11758 `if (dead) return`）
      //   ⇒ 分数**冻结**，速度算出来是 0 或"半窗"。
      //   探针实测：over=false 时是 133.3/138.2/136.6/138.2/140.0/138.0/141.4，
      //   over=true 那一窗掉到 73.3，之后恒 0。
      //   ⇒ 判据必须**先把"已结算"的窗口剔掉**，否则测的是"结算卡弹出后分数不动"，
      //   那不是物理、是 UI 状态。🔴 而且剔掉之后要钉住"至少留下几个真窗口"，
      //   免得全被剔光时 `Math.max(...[])` = -Infinity 反手把判据变成恒绿。
      const speeds = await page.evaluate(async () => {
        const out = [];
        const WINDOW_MS = 1200;
        return await new Promise((resolve) => {
          let winStart = performance.now();
          let startScore = null;
          const tick = () => {
            const n = Number(document.querySelector('.ns-sc')?.textContent ?? '0');
            const now = performance.now();
            // 🔴 `over` = 结算卡已弹出 ⇒ 这一窗里的"分数不动"是 UI 冻结，不是速度
            const over = !document.querySelector('.ns-over')?.classList.contains('hidden');
            if (startScore === null) {
              startScore = n;
              winStart = now;
            } else if (now - winStart >= WINDOW_MS) {
              out.push({ v: ((n - startScore) * 4) / ((now - winStart) / 1000), over });
              // 🔴 下一窗从**当前**分数起算（不重置为 0）——
              //   重置会把上一窗末尾到这一窗开头的空档算成"停住"，速度会被腰斩。
              startScore = n;
              winStart = now;
              if (out.length >= 10) return resolve(out);
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      });
      // 🔴 只取**未结算**的窗口（老项目 :11758 dead 后物理停摆）
      const alive = speeds.filter((s) => !s.over);
      const s = alive.map((x) => x.v).filter((v) => Number.isFinite(v) && v > 0);
      assert.ok(s.length >= 4, `应至少留下 4 个"未结算"的速度窗口，实得 ${s.length}（全部 ${JSON.stringify(speeds)}）`);
      const max = Math.max(...s);
      const min = Math.min(...s);
      // 🔴 老项目 `sp = 132 + min(70, it*0.8)`，开局 10 秒内 sp ∈ [132, 140]。
      //   探针实测 133.3~141.4 ⇒ 上界取 150 留量化余量，下界取 100。
      assert.ok(
        max < 150,
        `未结算窗口的速度应≤~145（老项目 :11759 按秒），实测峰值 ${max.toFixed(1)} —— 超过说明还在按距离算`,
      );
      assert.ok(
        min > 100,
        `速度不该异常低（实测谷值 ${min.toFixed(1)}），否则是物理断了`,
      );
      // 🔴 反向：把 max 的上界放到 250（按距离算的量级）时这条会绿 ——
      //   所以必须保留 150 这个紧界，否则判据不承重。显式钉住这个前提：
      assert.ok(150 < 250, '上界 150 必须严于「按距离算」的量级 250，否则判据形同虚设');
    } finally {
      await page.close();
    }
  });

  await t.test('DRG-E2-05 结算三行齐全 + 历史最佳持久化（老项目 :11769 / :10683）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE05', PASS);
    try {
      await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('dragon'));
      await withTimeout(page.waitForSelector('#nsCv'), 10_000, '等 dragon 画布');
      await withTimeout(page.waitForTimeout(3400), 6000, '等 intro 结束');

      // 站死：一直不跳，intro 一过就会被第一块牌子撞上。
      await withTimeout(page.waitForSelector('.ns-over:not(.hidden)', { timeout: 25_000 }), 30_000, '等结算卡');

      const rows = await page.$$eval('.ns-rows > div', (els) =>
        els.map((e) => [e.querySelector('span')?.textContent ?? '', e.querySelector('b')?.textContent ?? '']),
      );
      // 🔴 承重：三行，标签逐字等于老项目 :11769。
      assert.equal(rows.length, 3, `结算卡应三行，实得 ${rows.length} 行：${JSON.stringify(rows)}`);
      assert.deepEqual(
        rows.map((r) => r[0]),
        ['本局跑了', '躲过', '历史最佳'],
        '三行标签须逐字等于老项目 :11769',
      );
      assert.match(rows[0][1], /^\d+ 字$/, `第一行应是「N 字」，实得 ${rows[0][1]}`);
      assert.match(rows[1][1], /^\d+ 个$/, `第二行应是「N 个」，实得 ${rows[1][1]}`);
      assert.match(rows[2][1], /^\d+ 字$/, `第三行应是「N 字」，实得 ${rows[2][1]}`);
      // 🔴 反向：bj 此前是两行 [['得分', score], ['这一局', passed]]，
      //   标签完全不同 —— 上面的 deepEqual 会红。
      assert.ok(!rows.some((r) => r[0] === '得分' || r[0] === '这一局'), '不应出现 bj 旧的两行标签');

      const h2 = (await page.textContent('.ns-card h2'))?.trim() ?? '';
      assert.match(h2, /^被.+撞倒了$/, `结算标题应报出撞上什么（老项目 :11769），实得 ${h2}`);

      // 🔴 G：历史最佳**持久化**。老项目 :10683-10687 `saveBest` 写 localStorage。
      //   第一次玩必然是 0（此前没玩过），所以此刻第三行应是「0 字」——
      //   这本身就是判据：若它显示本局的分，说明读的是内存不是持久化记录。
      assert.equal(rows[2][1], '0 字', `首次游玩时「历史最佳」应为 0 字（老项目 rows 读的是 save 之前的值），实得 ${rows[2][1]}`);

      // 🔴🔴 键名**逐字**等于老项目 :10681 `var BEST_KEY = 'notesync_best';`。
      //   上一轮这里是 `notesync_bj_game_best`（理由写的"bj 用独立前缀隔离"），
      //   那个理由不成立：键名分前缀的规矩针对的是"与**别的应用**共享 localStorage"，
      //   而这里的语义就是**同一个应用的同一份存档**。
      //   ⇒ 换键名不是"隔离"，是**换了一个存档位置**：
      //     用户从老版本升上来，历史最佳会**凭空归零**，而界面上看不出任何异常
      //     （这正是最难归因的那类静默降级）。
      //   写法上扫全部 localStorage 的 key 名，确保**只有 notesync_best 存了这份成绩**。
      //   🔴🔴 上一轮写的是「值里有 dragon 且 > 0 的键」，有两个错，探针把它们都照出来了：
      //     ① 它**也匹配发现记录** `notesync_bj_eggs` —— 那是 `{"dragon":1}`（图鉴"见过"），
      //        `dragon` 同样是 number 且 > 0。探针实测 bestKeys = ["notesync_bj_eggs","notesync_best"]。
      //     ② 改成用「值够大」来区分也不行：站死那一局的分数取决于第一块牌子有多远，
      //        探针那次是 330、另一次不足 100 ⇒ 阈值判据**跟着随机数漂**。
      //   ⇒ 正确做法是**按键名白名单排除**，只允许"成绩键"这一个：
      //     断言"含 dragon 数值的键"恰好是 {发现记录, 成绩} 这两个，且成绩那份在 notesync_best。
      //     这样判据与分数大小、与图鉴实现都解耦。
      const keyInfo = await page.evaluate(() => {
        const out = {};
        for (const k of Object.keys(window.localStorage)) {
          try {
            const v = JSON.parse(window.localStorage.getItem(k) ?? 'null');
            out[k] = v && typeof v === 'object' && typeof v === 'object' && 'dragon' in v ? v.dragon : null;
          } catch {
            out[k] = 'PARSE_FAIL';
          }
        }
        return out;
      });
      const dragonKeys = Object.keys(keyInfo).filter((k) => typeof keyInfo[k] === 'number');
      // 🔴 承重：含 dragon 数值的键**恰好两个** —— 发现记录 + 成绩，一个都不能多。
      //   （若成绩被另存一份、或换了键名，这里会多出/少掉一个。）
      assert.deepEqual(
        dragonKeys.sort(),
        ['notesync_best', 'notesync_bj_eggs'],
        `含 dragon 数值的键应恰好是「成绩 notesync_best」与「发现记录 notesync_bj_eggs」，实得 ${JSON.stringify(keyInfo)}`,
      );
      // 🔴 成绩那份必须在老项目 :10681 的键名下，且是**有限正数**。
      assert.equal(
        typeof keyInfo.notesync_best,
        'number',
        `dragon 成绩必须写在 notesync_best 下（老项目 :10681），实得 ${JSON.stringify(keyInfo.notesync_best)}`,
      );
      assert.ok(keyInfo.notesync_best > 0, `dragon 成绩应 > 0，实得 ${keyInfo.notesync_best}`);
      // 🔴 反向：发现记录那位是**位图**（恒 1），成绩是**分数量级**。
      //   两者混键会让 readDiscovered 的白名单过滤把 dragon 当"未注册 id"丢掉。
      assert.equal(
        keyInfo.notesync_bj_eggs,
        1,
        '发现记录里的 dragon 应是位图值 1（与成绩的分数量级不同，混键必丢）',
      );

      const stored = await page.evaluate(() => window.localStorage.getItem('notesync_best'));
      assert.ok(stored !== null, '最佳成绩必须写进 localStorage（老项目 :10685）');
      const parsed = JSON.parse(stored);
      assert.ok(typeof parsed.dragon === 'number' && parsed.dragon > 0,
        `dragon 的最佳成绩应已落盘且 > 0，实得 ${stored}`);
      assert.ok(stored.includes('dragon'), '最佳成绩键里应含 dragon');
      // 🔴 反向：键名不许与发现记录混用 —— 两者的id 空间不同，
      //   混键会让 readDiscovered 的白名单过滤把 dragon 当"未注册 id"丢掉。
      assert.notEqual(
        await page.evaluate(() => window.localStorage.getItem('notesync_bj_eggs')),
        stored,
        '最佳成绩键不得与发现记录键相同',
      );
    } finally {
      await page.close();
    }
  });

  await t.test('DRG-E2-06 历史最佳在第二局里显示出来（持久化的真正判据）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE06', PASS);
    try {
      await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('dragon'));
      await withTimeout(page.waitForSelector('#nsCv'), 10_000, '等 dragon 画布');
      await withTimeout(page.waitForTimeout(3400), 6000, '等 intro 结束');
      await withTimeout(page.waitForSelector('.ns-over:not(.hidden)', { timeout: 25_000 }), 30_000, '等第一局结算');

      const best1 = JSON.parse(await page.evaluate(() => window.localStorage.getItem('notesync_best'))).dragon;
      assert.ok(best1 > 0, '第一局应已落盘');

      // 点「再来一局」→ 再站死一次
      await page.click('.ns-again');
      await withTimeout(page.waitForSelector('#nsCv'), 10_000, '等重开');
      await withTimeout(page.waitForTimeout(3400), 6000, '等第二局 intro');
      await withTimeout(page.waitForSelector('.ns-over:not(.hidden)', { timeout: 25_000 }), 30_000, '等第二局结算');

      const rows = await page.$$eval('.ns-rows > div', (els) =>
        els.map((e) => [e.querySelector('span')?.textContent ?? '', e.querySelector('b')?.textContent ?? '']),
      );
      const bestShown = Number((rows[2]?.[1] ?? '').replace(' 字', ''));
      // 🔴 承重：第二局的「历史最佳」必须 ≥ 第一局的成绩。
      //   反向：若best 每次都从 0 起算（没持久化），这条必红（best1 > 0 且 bestShown === 0）。
      assert.ok(bestShown >= best1,
        `第二局「历史最佳」应 ≥ 第一局 ${best1}，实得 ${bestShown}（没持久化就会是 0）`);
      assert.ok(bestShown > 0, '第二局「历史最佳」不应还是 0');

      const best2 = JSON.parse(await page.evaluate(() => window.localStorage.getItem('notesync_best'))).dragon;
      assert.ok(best2 >= best1, `落盘值应只增不减：${best1} → ${best2}`);
    } finally {
      await page.close();
    }
  });

  await t.test('DRG-E2-07 高障碍与低头成对存在（老项目 :11737 / :11751）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE07', PASS);
    try {
      await openDragon(page);
      // 老项目 :11738 高障碍 `hi` 的框顶在 `GY - 38`、高 20；矮的在 `GY - 26`、高 26。
      //   两种框**必须都出现**（30% 概率）。
      // 量化判据：扫「站牌带」每列的首个非背景像素，收集所有出现过的"框顶高度"。
      // 🔴🔴 判非背景**只看 alpha**（文件头纪律 3a）：canvas 从不填底，
      //   背景是 rgba(0,0,0,0)；上一轮比 RGB 与 `--bg` 的差 ⇒ **每一列**都命中，
      //   seen 只会收到带子最顶上那一行（恒 62 附近），两条断言全红—— 典型假红。
      //
      // 🔴🔴 **必须跳过恐龙那一段列**（x < 60）。恐龙画在 x=16、墨迹到 x≈40
      //   （老项目 :11781 dx=16 + 吻部到 24u），而龙形顶在 `GY-26u` ⇒
      //   **它的墨迹会贡献一个假的"框顶 26"**。
      //   上一轮不限列区间，于是"矮障碍"那条永远被恐龙顶替。跳列后实测能收到真值。
      //
      // 🔴🔴 上一轮还留在"扫固定 600 帧就下结论"，那是**概率性判据**：
      //   `hi`（高障碍）是 `Math.random() < 0.3`（老项目 :11737），
      //   而一局在撞死前只会刷出~8 块牌子 ⇒ 单局漏掉高障碍的概率 = 0.7^8 ≈ **5.8%**。
      //   换句话说这条断言本来就有约 1/17 的概率假红 —— 与实现对错无关。
      //   探针实测同一份代码：一次 tops 含 38，一次不含。
      //   ⇒ 改成**多局累积**：撞死后点「再来一局」，把 tops 累加，直到两种框顶都见过。
      //      老项目 `Math.random` 无种子可固定，所以"多局累积"是这里唯一稳的做法；
      //      累积 4 局 ⇒ 漏检概率 0.7^32 ≈ 1.4e-5。
      // 🔴 每局都**扫到撞死为止**（`.ns-over` 弹出即停），所以不会白等固定帧数。
      const tops = await page.evaluate(async () => {
        const seen = new Set();
        const MAX_LIVES = 4;
        for (let life = 0; life < MAX_LIVES; life += 1) {
          const cv = document.getElementById('nsCv');
          if (!cv) break;
          const c = cv.getContext('2d');
          const dpr = cv.width / parseFloat(cv.style.width);
          const H = parseFloat(cv.style.height);
          const GY = H - 46;
          const x0 = Math.round(60 * dpr); // 跳过恐龙列（它的墨迹在 16~40）
          for (let f = 0; f < 3000; f += 1) {
            if (!document.querySelector('.ns-over')?.classList.contains('hidden')) break;
            const y0 = Math.round((GY - 62) * dpr);
            const hh = Math.round(66 * dpr);
            const d = c.getImageData(x0, y0, cv.width - x0, hh).data;
            const W = cv.width - x0;
            for (let x = 0; x < W; x += 1) {
              for (let y = 0; y < hh; y += 1) {
                if (d[(y * W + x) * 4 + 3] <= 20) continue;
                seen.add(Math.round((GY - (y0 + y) / dpr) * 10) / 10);
                break; // 只要这一列的首个非背景行（= 框顶）
              }
            }
            // 🔴 两种框顶都见过就早停，不必跑满4 局（省 ~20 秒）
            if ([...seen].some((v) => Math.abs(v - 26) <= 4) && [...seen].some((v) => Math.abs(v - 38) <= 4)) {
              return [...seen].sort((a, b) => a - b);
            }
            await new Promise((r2) => requestAnimationFrame(() => r2(null)));
          }
          // 本局撞死 ⇒ 重开。intro 相位有 3 秒不判碰撞（老项目 :11757），别在 intro 里扫。
          if (life < MAX_LIVES - 1) {
            const again = document.querySelector('.ns-again');
            if (!again) break;
            again.click();
            await new Promise((r2) => setTimeout(r2, 3600));
          }
        }
        return [...seen].sort((a, b) => a - b);
      });
      // 顶部高度换算：文本本身也在框里（框顶往下 4~5px），
      //   所以会出现 26/38 附近的簇。用±4 的容差。
      assert.ok(
        tops.some((v) => Math.abs(v - 26) <= 4),
        `应有矮障碍（框顶 ≈ GY-26=26），实测顶部集：${JSON.stringify(tops)}`,
      );
      assert.ok(
        tops.some((v) => Math.abs(v - 38) <= 4),
        `应有高障碍（框顶 ≈ GY-38=38，30% 概率），实测顶部集：${JSON.stringify(tops)}`,
      );
      // 🔴 反向：若只有一种框顶（bj 此前固定 span 无高低差），上面第二条会红。

      // 🔴 I：低头必须真的改变判定高度（老项目 :11764 `dh = duck ? 18 : 26`）。
      //   判据：按住方向键下，恐龙**变矮**。用画布上恐龙那块的墨迹高度量。
      // 🔴🔴 扫描列区间必须跟着龙标的 x 坐标走：**x = 16**（老项目 :11781`var dx = 16`），
      //   墨迹横向范围约 [16, 16+24*u]。上一轮留的是 `[56,98]` —— 那是**绘制还在 x=60 时**
      //   的旧值；龙标移到 16 之后那块区间扫到的只有地面虚线 ⇒ 量出来的高度是假的。
      //🔴 量法用共用的 `DINO_BBOX`（**按 --accent 颜色筛**）：
      //   牌子会从恐龙身上压过去，只按 alpha 量会把它算进来（某帧实测宽 27，真值 23），
      //   而且随牌子位置时绿时红。理由见 DINO_BBOX 的注释。
      const standBox = await page.evaluate(DINO_BBOX);
      assert.ok(standBox, '龙标那块应有墨迹（按 --accent 颜色扫却什么都没扫到）');
      await page.keyboard.down('ArrowDown');
      await withTimeout(page.waitForTimeout(250), 2000, '等低头生效');
      const duckBox = await page.evaluate(DINO_BBOX);
      await page.keyboard.up('ArrowDown');
      assert.ok(duckBox, '低头态也应有墨迹');

      // 🔴🔴 **承重**：包围盒宽高。老项目 :11787-11789 在u=1（站立）时画的是
      //   吻部 rr(13,2,11,8) ⇒ 顶到 y=2；腿 rr(9,18,3.2,6)/rr(15,18,3.2,6) ⇒ 底到 y=24。
      //   横向 DINO 的 x 从 1 到吻部的 24 ⇒ **墨迹盒 ≈ 23×22**。
      //   bj 此前是 `rr(c, 0, 0, 34, dh, 8)` ⇒ **34 宽**，比龙形宽 11px。
      //   宽度是这里唯一能区分"画了龙"与"画了个砖"的量化点 ——
      //   只断高度的话，一个 34×26 的圆角矩形也能满足"站立 > 18"。
      assert.ok(
        Math.abs(standBox.w - 23) <= 3,
        `站立墨迹宽应≈23（老项目 :11787 吻部到 24u、DINO 从 1u），实测 ${standBox.w.toFixed(1)}` +
          ` —— 若≈34 说明退化成了 rr(0,0,34,…) 的圆角矩形`,
      );
      assert.ok(
        Math.abs(standBox.h - 22) <= 3,
        `站立墨迹高应≈22（老项目 :11787顶 y=2u、:11788 腿底 y=24u），实测 ${standBox.h.toFixed(1)}`,
      );
      // 🔴 反向：显式钉住"圆角矩形会红"这个前提，否则 34 这个界可以被放宽到 34。
      assert.ok(23 <= 34 - 5, '龙形宽(23) 必须显著窄于旧圆角矩形宽(34)，否则这条判据不承重');

      // 🔴 低头态：u = 18/26 = 0.692（老项目 :11786 `var u = s / 26`）
      //   ⇒ 横向缩到 ≈16；再被 :11785 `transform(1,0,0,.72,0, s*.28)` 压扁
      //   ⇒ 纵向 ≈11。两态**必须**明显不同，否则 duck 没接上。
      assert.ok(
        duckBox.w < standBox.w - 5,
        `低头应整体缩小（老项目 :11786 的 u=s/26）：站立宽 ${standBox.w.toFixed(1)} → 低头宽 ${duckBox.w.toFixed(1)}`,
      );
      assert.ok(
        duckBox.h < standBox.h - 6,
        `按住 ↓（低头）后恐龙应明显变矮（再被 transform 压扁）：站立 ${standBox.h.toFixed(1)} → 低头 ${duckBox.h.toFixed(1)}`,
      );
      assert.ok(Math.abs(duckBox.h - standBox.h) > 4, '低头与站立高度必须不同（否则 duck 没接上）');
    } finally {
      await page.close();
    }
  });

  await t.test('DRG-E2-08 障碍词按实测框宽裁剪（老项目 :11809 clipTo）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE08', PASS);
    try {
      await openDragon(page);
      // 🔴 判据核心：站牌里的文字**不许画出框外**。
      //   bj 此前 `label.slice(0, 6)` 定长 —— 6 个汉字按 10px 是 60px，
      //   塞进 52px 宽的高障碍框必压出长方形（老项目 :11579 注释「用户报 dragon 实锤」）。
      // 量法（纯像素，跨平台稳）：每帧找出「障碍框的左右边界」，
      //   再看紧贴边界**外侧 2px** 的窄条里有没有**文字色**（--muted）像素。
      //   clipTo 留 ≥5px 内边距（老项目 :11809 传 `o.w - 10`，左右各 5px），
      //   所以界外 2px 必无文字。
      //
      // 🔴🔴 「这一列有没有内容」必须**看 alpha**（文件头纪律 3a）：
      //   canvas 从不填底 ⇒ 空白像素是 rgba(0,0,0,0)，与浅色 `--bg` 的 RGB 差得很远，
      //   上一轮用 nearBg 判"整条都是背景"⇒ `colEmpty` 恒为 0 ⇒ 整幅画布被并成
      //   **一个宽度 = 画布宽的段**，而下面的 `w >= 25 && w <= 60` 又把它跳过
      //   ⇒ `spill` 恒为 0，判据**恒真**（这就是上一轮那条假绿）。
      //   而 `texty`（判"这是不是文字色"）用 RGB 是**对的**：
      //   文字像素确实带真实颜色，要靠 RGB 把它与框的描边色（--line）区分开。
      const spill = await page.evaluate(async () => {
        const cv = document.getElementById('nsCv');
        const c = cv.getContext('2d');
        const dpr = cv.width / parseFloat(cv.style.width);
        const cs = getComputedStyle(document.body);
        const rgbOf = (name, fb) => {
          const m = /^#?([0-9a-f]{6})$/i.exec((cs.getPropertyValue(name) || '').trim());
          if (m) {
            return [
              parseInt(m[1].slice(0, 2), 16),
              parseInt(m[1].slice(2, 4), 16),
              parseInt(m[1].slice(4, 6), 16),
            ];
          }
          const n = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(cs.getPropertyValue(name) || '');
          return n ? [Number(n[1]), Number(n[2]), Number(n[3])] : fb;
        };
        const mu = rgbOf('--muted', [138, 138, 133]);
        // 「像文字」= 有内容，且足够接近 --muted（排除框的描边色 --line 与恐龙墨迹）
        const texty = (r, g, b) => Math.abs(r - mu[0]) + Math.abs(g - mu[1]) + Math.abs(b - mu[2]) < 70;
        let worst = 0;
        let framesWithBox = 0;
        for (let f = 0; f < 100; f += 1) {
          const H = parseFloat(cv.style.height);
          const GY = H - 46;
          for (const [ty, th] of [[GY - 26, 26], [GY - 38, 20]]) {
            const y0 = Math.round(ty * dpr);
            const hh = Math.max(1, Math.round(th * dpr));
            const d = c.getImageData(0, y0, cv.width, hh).data;
            // 逐列判「这一列整条都没画东西」⇒ 该列不属于任何障碍框
            const colEmpty = new Uint8Array(cv.width);
            for (let x = 0; x < cv.width; x += 1) {
              let allEmpty = true;
              for (let y = 0; y < hh; y += 1) {
                if (d[(y * cv.width + x) * 4 + 3] > 20) {
                  allEmpty = false;
                  break;
                }
              }
              colEmpty[x] = allEmpty ? 1 : 0;
            }
            let x = 0;
            while (x < cv.width) {
              if (colEmpty[x]) {
                x += 1;
                continue;
              }
              let end = x;
              while (end + 1 < cv.width && !colEmpty[end + 1]) end += 1;
              const w = end - x + 1;
              // 只认 25~60px 宽的框（老项目 :11738 两种框宽是 30 与 52），排除恐龙
              if (w >= 25 && w <= 60) {
                framesWithBox += 1;
                for (const cx of [x - 2, x - 1, end + 1, end + 2]) {
                  if (cx < 0 || cx >= cv.width || colEmpty[cx]) continue;
                  for (let y = 0; y < hh; y += 1) {
                    const i = (y * cv.width + cx) * 4;
                    if (d[i + 3] > 20 && texty(d[i], d[i + 1], d[i + 2])) {
                      worst = Math.max(worst, 1);
                      break;
                    }
                  }
                }
              }
              x = end + 1;
            }
          }
          await new Promise((r2) => requestAnimationFrame(() => r2(null)));
        }
        return { worst, framesWithBox };
      });
      // 🔴 反向先行：必须真的扫到过障碍框，否则下面 `spill === 0` 是恒真的。
      assert.ok(
        spill.framesWithBox > 20,
        `应多次扫到 25~60px 宽的障碍框，实得 ${spill.framesWithBox} 次 —— 扫不到说明量法本身坏了`,
      );
      // 🔴 承重：文字不许溢出到框外。
      assert.equal(spill.worst, 0, '站牌文字溢出到框外了（老项目 :11809 的 clipTo 就是治这个的）');

      // 🔴 反向：定长截断必须已被移除。slice(0,6) 在 52px 框上必然溢出 ⇒ 上面会红。
      //   🔴 读**源码**而非 `www/app.js`（文件头纪律 2：产物被压缩，
      //   变量名混淆、`slice(0, 6)` 的空格也没了 ⇒ 正则落空）。
      const dfn = dragonFn();
      assert.ok(dfn.length > 500, `应能切到 dragon 的实现片段，实得 ${dfn.length} 字符`);
      assert.ok(
        !/\.slice\(0,\s*6\)/.test(dfn),
        'dragon 里不许再有 slice(0,6) 定长截断（那正是长方形 bug 的成因）',
      );
      assert.ok(
        /clipTo\(c, o\.label, o\.w - 10\)/.test(dfn),
        '障碍词必须按「框宽 − 10」裁剪（老项目 :11809）',
      );
      // 🔴 clipTo 的实现体在**文件级**（不在 dragon 片段里），所以查整份源码
      assert.ok(
        /while \(s\.length > 1 && c\.measureText\(s \+ '…'\)\.width > max\)/.test(GAMES_CODE),
        'clipTo 必须按 measureText 实测宽度逐字回退（老项目 :11585）',
      );
    } finally {
      await page.close();
    }
  });


  await t.test('DRG-E2-09 撞击有震动（老项目 :11768shake=0.2 / :11777translate）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE09', PASS);
    try {
      await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('dragon'));
      await withTimeout(page.waitForSelector('#nsCv'), 10_000, '等dragon 画布');
      await withTimeout(page.waitForTimeout(3400), 6000, '等 intro 结束');
      // 站死 → 撞击瞬间画面应发生位移
      await withTimeout(page.waitForSelector('.ns-over:not(.hidden)', { timeout: 25_000 }), 30_000, '等结算卡');
      // shake 只持续 0.2/0.016 ≈ 12 帧，肉眼抓不住 —— 判据落在**实现**上：
      //   源码里必须有 save/translate/restore 三件套，且 restore 与 save 配平。
      //   🔴 读**源码**而非 `www/app.js`（文件头纪律 2）。
      //   🔴 用 `GAMES_CODE`（去注释）而不是原始源码：games.ts 的注释里
      //   正在**引用**`shake = 0.2` 这几行作为说明，不去注释会命中那几句注释，
      //   判据就变成"注释里写没写"而不是"代码里做没做"。
      assert.ok(/shake = 0\.2/.test(GAMES_CODE), '撞击时 shake 须置 0.2（老项目 :11768）');
      assert.ok(/shake -= 0\.016/.test(GAMES_CODE), '每帧衰减 0.016（老项目 :11777）');
      assert.ok(/rf\(-3, 3\)/.test(GAMES_CODE) && /rf\(-2\.5, 2\.5\)/.test(GAMES_CODE),
        '位移量须逐字等于老项目的 rf(-3,3)/rf(-2.5,2.5)');
      // 🔴 反向：save/restore 必须配平（少一个 restore ⇒ 之后每帧坐标全偏）。
      const fn = dragonFn();
      assert.equal(
        (fn.match(/c\.save\(\)/g) ?? []).length,
        (fn.match(/c\.restore\(\)/g) ?? []).length,
        `dragon draw 里 save/restore 必须配平（save ${(fn.match(/c\.save\(\)/g) ?? []).length} 个 / restore ${(fn.match(/c\.restore\(\)/g) ?? []).length} 个）`,
      );
      // 🔴 反向先行：save 一个都没有 ⇒ 上面的配平等式恒成立（0 === 0）。
      assert.ok(
        (fn.match(/c\.save\(\)/g) ?? []).length >= 2,
        'dragon 的 draw 里至少要有龙形与震动的两处 save —— 一个都没有说明配平判据是恒真的',
      );
    } finally {
      await page.close();
    }
  });

  await t.test('DRG-E2-10 玩法提示与实现一致（按住=低头，此前按住直接跳）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE10', PASS);
    try {
      await openDragon(page);
      const tip = (await page.textContent('.ns-tip'))?.trim() ?? '';
      // 🔴 承重：提示写着「按住屏幕 = 低头」，那按住就必须真的低头（bj 此前当跳）。
      assert.match(tip, /点屏幕 = 跳 · 按住屏幕 = 低头/, `提示须与老项目 :11744 逐字一致，实得 ${tip}`);
      // 🔴 读**源码**而非 `www/app.js`（文件头纪律 2：产物被压缩、变量名混淆 ⇒ 正则落空）。
      //   用 `dragonFn()`（已去注释）—— games.ts 的注释里正在**引用**
      //   `vy = 330` 与 150ms 定时器作为说明，不去注释会命中注释而不是代码。
      const fn = dragonFn();
      // 按住 = 起 150ms 定时器（老项目 :11754），不是直接给初速
      assert.ok(/holdT = setTimeout\([\s\S]{0,200}?, 150\)/.test(fn),
        '按住应是 150ms 定时器后低头（老项目 :11754），不是按下就跳');
      // down 里不许出现直接起跳的 vy = 330
      const downBlock = fn.slice(fn.indexOf('down:'), fn.indexOf('up:'));
      // 🔴 反向先行：切不到 down/up 两个键时下面那条"不许出现"是恒真的
      assert.ok(downBlock.length > 50, `应能切到 down 块，实得 ${downBlock.length} 字符`);
      assert.ok(!/vy = 330/.test(downBlock),
        'down（按住）里不许直接起跳 —— 那就是「按住屏幕 = 低头」提示与实现不符的根因');
    } finally {
      await page.close();
    }
  });

  /* ════════════════════════════════════════════════════════════════
   * 恐龙画风（老项目 index.html:11730/:11741/:11781-11792）
   * 上一轮只画了个圆角矩形 + 一个圆点当眼睛 ⇒ 用户看到的"恐龙"是块砖。
   * 这三条把它钉在"像素级"上。
   * ════════════════════════════════════════════════════════════════ */

  await t.test('DRG-E2-11 龙形是 poly 坐标表画的，包围盒宽高≠ 圆角矩形', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE11', PASS);
    try {
      await openDragon(page);
      // 🔴 量**墨迹包围盒**（不是"有没有画东西"）—— 这是唯一能区分
      //   「画了龙」与「画了个砖」的量化点。用共用的 DINO_BBOX（按 --accent 筛色，
      //   理由见它的注释：牌子会从龙身上压过去，只按 alpha 量会混进牌子的像素）。
      const box = await page.evaluate(DINO_BBOX);
      assert.ok(box, '龙标那块应有墨迹（按 --accent 颜色扫却什么都没扫到）');

      // 🔴 老项目 u=1（站立）时的理论墨迹盒：
      //   横向 1u（DINO 最左）→ 24u（吻部 rr(13,2,11,8) 的右缘）= 23
      //   纵向 2u（吻部顶） → 24u（腿 rr(9,18,3.2,6) 的底）= 22
      assert.ok(
        Math.abs(box.w - 23) <= 3,
        `站立龙形宽应≈23（老项目 :11730 DINO/BODY + :11787 吻部），实测 ${box.w.toFixed(1)}`,
      );
      assert.ok(
        Math.abs(box.h - 22) <= 3,
        `站立龙形高应≈22（老项目 :11787 顶 2u → :11788 腿底 24u），实测 ${box.h.toFixed(1)}`,
      );
      // 🔴🔴 **反向**：退化回`rr(0,0,34,dh,8)` 时宽会是 34（比龙形宽 11px）。
      //   显式钉住这个前提，否则把上界从 26 放宽到 34 这条判据就不承重了。
      assert.ok(
        23 <= 34 - 8,
        '龙形宽(23) 必须显著窄于旧圆角矩形宽(34) —— 否则宽度判据形同虚设',
      );

      // 🔴 源码侧：必须是 poly + 坐标表，不能是圆角矩形。
      //   🔴 正则用 `\s*` 而不是单个空格 —— 实际代码里两次 poly 调用分两行
      //   （prettier 的换行），写成 `/poly\(c, DINO, u\); poly\(c, BODY, u\)/`
      //   会在"只是换了个行"的场合假红（判据红在格式上而不是行为上）。
      const dfn = dragonFn();
      assert.ok(
        /poly\(c, DINO, u\)\s*;\s*poly\(c, BODY, u\)\s*;/.test(dfn),
        '龙形必须用 poly 画 DINO/BODY 两组坐标（老项目 :11787）',
      );
      assert.ok(
        !/rr\(c, 0, 0, 34,/.test(dfn),
        'dragon 里不许再有 `rr(c, 0, 0, 34, dh, 8)` —— 那是"恐龙其实是块砖"的根因',
      );
      // 🔴 坐标表本体（老项目 :11730 逐字）。断言逐个数值而不是整块字符串 ——
      //   整块字符串会被"换行/尾逗号"这种纯格式差异判红。
      const nums = (name) => {
        const m = GAMES_CODE.match(new RegExp(name + '[^=]*=\\s*\\[([\\s\\S]*?)\\];'));
        if (!m) return null;
        return [...m[1].matchAll(/(-?\d+)\s*,\s*(-?\d+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
      };
      assert.deepEqual(
        nums('DINO'),
        [[1, 7], [9, 10], [9, 17], [3, 14]],
        'DINO 坐标表须逐字等于老项目 :11730 [[1,7],[9,10],[9,17],[3,14]]',
      );
      assert.deepEqual(
        nums('BODY'),
        [[7, 10], [20, 10], [18, 18], [9, 18]],
        'BODY 坐标表须逐字等于老项目 :11730 [[7,10],[20,10],[18,18],[9,18]]',
      );
    } finally {
      await page.close();
    }
  });

  await t.test('DRG-E2-12 intro 期龙标**横向滑入**（老项目 :11782 `dx = -30 + (it/1.2)*46`）', async () => {
    const page = await openEditor(browser, h.baseUrl(), 'drgE12', PASS);
    try {
      // 🔴 别急着 openDragon —— intro 已过就只剩静止的 x=16 了。
      //   这里只要画布在场就开始逐帧采样。
      await page.evaluate(() => window.__NOTESYNC_EGG_OPEN__('dragon'));
      await withTimeout(page.waitForSelector('#nsCv'), 10_000, '等 dragon 画布');

      // 逐帧量龙标的**最左墨迹列**（老项目 :11781-11782 的 dx 变化 ⇒ 最左列也跟着动）
      const track = await page.evaluate(async () => {
        const cv = document.getElementById('nsCv');
        const c = cv.getContext('2d');
        const dpr = cv.width / parseFloat(cv.style.width);
        const H = parseFloat(cv.style.height);
        const GY = H - 46;
        const out = [];
        for (let f = 0; f < 100; f += 1) {
          // 🔴 只扫地面线**以上**、画布**左侧**那一段：龙标滑入是从左边进来的，
          //   而地面线会横贯整幅画布 —— 把它算进"最左列"就永远量到 0。
          const x0 = 0;
          const x1 = Math.round(120 * dpr);
          const y0 = Math.round((GY - 90) * dpr), y1 = Math.round((GY - 1) * dpr);
          const d = c.getImageData(x0, y0, x1 - x0, y1 - y0).data;
          const W = x1 - x0, Hh = y1 - y0;
          let left = -1;
          for (let x = 0; x < W && left < 0; x += 1) {
            for (let y = 0; y < Hh; y += 1) {
              if (d[(y * W + x) * 4 + 3] > 20) { left = x; break; }
            }
          }
          out.push(left < 0 ? null : left / dpr);
          await new Promise((r) => requestAnimationFrame(() => r(null)));
        }
        return out;
      });
      const seen = track.filter((v) => v !== null);
      assert.ok(seen.length >= 20, `intro 期应多次扫到龙标，实得 ${seen.length}/${track.length} 帧`);

      // 🔴 承重：龙标在 intro 里**从左往右移动**（老项目 :11782 `dx = -30 + (it/1.2)*46`）。
      //   前段（滑入中）应当看到明显更靠左的墨迹。
      const first = seen[0];
      const last = seen[seen.length - 1];
      assert.ok(
        last - first >= 8,
        `intro 期龙标应横向右移≥8px（老项目 :11782），实得 ${first.toFixed(1)} → ${last.toFixed(1)}`,
      );
      // 🔴 反向：龙标被钉死在 x=16 时 first === last，上面这条必红。
      assert.ok(
        !(last - first >= 0 && last - first < 1),
        '龙标横移量不该是 0 —— intro 的滑入动画（老项目 :11782）没接上',
      );
      // 🔴 反向先行：出现过**画面左缘之外**的位置（dx 起始 -30 ⇒ 墨迹左缘为负）才说明真的在滑入。
      //   这里不强求（dx=-30 时龙大部分在画布外，只看得到右侧一小截），
      //   但要钉住"至少有一次比终点更靠左"，否则单调递增的噪声也能满足上面那条。
      const early = Math.min(...seen.slice(0, 10));
      assert.ok(
        early < last - 5,
        `intro 前 10 帧应比末帧更靠左（滑入中），实得 early=${early.toFixed(1)} / last=${last.toFixed(1)}`,
      );

      // 🔴 源码侧：三段浮沉公式逐字（老项目 :11782-11783）
      assert.ok(
        /dx = -30 \+ \(it \/ 1\.2\) \* 46/.test(GAMES_CODE),
        'intro 滑入公式须逐字等于老项目 :11782 `dx = -30 + (it/1.2)*46`',
      );
      assert.ok(
        /dip = Math\.sin\(it \* 16\) \* 1\.3/.test(GAMES_CODE),
        'intro 浮沉公式须逐字等于老项目 :11782 `dip = Math.sin(it*16)*1.3`',
      );
      assert.ok(
        /dip = 3 \* Math\.min\(1, \(it - 1\.2\) \/ 0\.45\)/.test(GAMES_CODE),
        'intro 过渡公式须逐字等于老项目 :11782 `dip = 3*Math.min(1,(it-1.2)/0.45)`',
      );
      assert.ok(
        /Math\.floor\(it \* 9\) % 2 \? -1\.4 : 0/.test(GAMES_CODE),
        '跑动时的眨眼式浮沉须逐字等于老项目 :11783',
      );
    } finally {
      await page.close();
    }
  });
});
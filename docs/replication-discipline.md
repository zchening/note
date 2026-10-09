# bj 复刻纪律 —— 与老项目对齐时反复踩的坑

> 这份文档沉淀的是**「怎么判断才算对齐」的方法与具体陷阱**，不是功能清单。
> 功能清单在 `../ARCH.md` §4.2.1（UI 契约），版本历程在 `../README.md`。
> 配套：`replication-checklist.md`（逐项核对清单）、`gotchas.md`（量化值速查）。
>
> 维护：每次"与老项目对齐"的批次结束后，回头看有没有新踩的坑，补进来。

## 0. 唯一权威参照物

`D:\Users\zchen\Documents\TraeProject\notesync\index.html`（12400 行单文件，**明文中文**）。

🔴 **别用 `grep` 汉字去判"老项目有没有这个功能"** —— 老项目是明文中文，grep 能命中；
但 bj 是 esbuild 产物，非ASCII 全被转成 `\uXXXX`，grep 恒 0 命中。
**同一套 grep 在两个项目上行为相反**，判 bj 侧必须 `import` 源码或解码 `www/app.js`。

## 1. 视觉差异必须并排量化，不许凭截图猜

流程：同 Playwright、同视口、同主题状态，两边各开真浏览器，逐项读
`getComputedStyle` + `getBoundingClientRect`。

**主题状态必须先验后量。** 踩过：只点一次"切日间"就开量，结果颜色值全是夜间的
（`applyTheme` 可能延后），一度以为"两边都错"——其实是主题没切过来。
`forceDay` 要写成"点 → 读 `body.classList.contains('dark')` → 不符再点"。

**`::-webkit-scrollbar` 读不到 computed**，改读样式表声明文本（`sheet.cssRules`）。

### 1.1 🔴 探针自身的三类假数据

| 坑 | 症状 | 修法 |
|---|---|---|
| `querySelector('#cpMask h1, .mask h1')` | 返回**文档顺序**第一个命中任一分支的元素。`#remMask` 排在前面就量到"提醒" | 探针里**一个逗号都不写**。同类：`{a,b}` 选择器列表、`:is()` |
| canvas 判"非背景"用「RGB 与 `--bg` 的差」 | canvas 走 `clearRect` 从不填底，背景是 `rgba(0,0,0,0)` ⇒ 整行都被当成"有内容" | 判 **alpha 通道** |
| 逐帧采样测速 | 分数是 4 单位量化 ⇒ aliasing 出约 **2×**（实测 266.7 vs 理论 133） | 用 ≥1200ms **长窗口** |
| 判某物包围盒只按 alpha 量 | 牌子会从恐龙身上滚过去 ⇒ 某帧宽 27（真值 23），时绿时红 | 按 `--accent`/`--danger` **颜色筛** |
| 探针忘了撤 `#landing`/`#mask` 遮罩 | 鼠标命中全被遮罩吃掉，得出"hover 底可见"的**假结论** | 加一组"有遮罩"的对照组 |

### 1.2 🔴 `scrollbar` 与"不该出现的滚动条"

`.box` 上写 `max-height` + `overflow-y:auto` ⇒ **每个**弹窗与菜单盒都成了滚动容器。
老项目 `.box` 原文**没有这两条**，所以除扫一扫那张（行内样式单独开）之外，
老项目任何弹窗都不可能长出滚动条。

新增可滚动容器时**必须同时问**：老项目这个位置有滚动条吗？没有就别加。

## 2. 🔴🔴 老项目源码里"写了但被更具体规则吃掉的声明"必须照实测抄

**照抄声明 = 把 bug 一起抄进来，还会被当成"对齐完成"。**

已确认三处死规则：

| 源码位置 | 声明 | 实测真相 |
|---|---|---|
| `index.html:518` | `.box button.ghost-btn{background:none;color:var(--muted);border:1px solid var(--line)}` | 被 `:1063` 的 `.box button:not(:disabled):not(.box-x)`（**(0,3,1)** + `!important`）吃回。真实渲染 `--fg` 底 / `--bg` 字，只有 `margin-top:10px` 与 `border` 活下来 |
| `index.html:537` | `.qr-warn{font-size:12px;color:#C0453E}` | 被 `.box p`（0,1,1）压掉。实测 **13px / muted** |
| `index.html:156` | — | 老项目**全文零 `clamp(`**。bj 的 `.ns-logo-sm{width:clamp(17px,4.4vw,27px)}` 是**自创**（注释还伪造了出处）⇒ 视口 ≥386px 时 logo 就变大 |

### 2.1 🔴 `!important` 运行时覆盖层 —— 最隐蔽的一层

老项目 `applyTheme`（`index.html:1269`）**无条件**往 `documentElement` 挂一份
`<style id="theme-override">`（模板 `themeCssCore()` `:1045-1067`），全篇 `!important`：

```css
.box{background:${p.box}!important;color:${p.fg}!important;border-color:${p.line}!important}
.box h1{color:${p.fg}!important;…}
.box p,.box .qr-lock-warn{color:${p.muted}!important;…}
.box button:not(:disabled):not(.box-x){background:${p.fg}!important;color:${p.bg}!important}
```

🔴 **只读基础 CSS 会得出完全错误的颜色。** 上一批就是这么错的：读到基础规则的
`--fg` 底就以为对了，另加一条 `--hover` 去"模拟 ghost-btn"，结果把深底顶成浅灰。

**判定方法**：真浏览器 `getComputedStyle` 读最终值，别读源码字面。

## 3. 🔴🔴 `:not()` 的 specificity：自身不贡献，取其参数

写"补丁选择器压得住基规则"时必须精确数，**少数一位就结构性输**：

| 选择器 | specificity |
|---|---|
| `.ns-fold[data-open="false"] > :not(:first-child)` | **(0,3,0)** ← `.ns-fold` + `[data-open]` + `:not` 的参数 |
| `[data-ns-export-fold] > :not(:first-child)` | **(0,2,0)** ⇒ **输** |
| `.ns-fold[data-ns-export-fold][data-open] > :not(:first-child)` | **(0,4,0)** ⇒ 结构性压过 ✅ |

同分靠源码顺序赢是**脆弱的**（顺序一改就失效），必须堆类名/属性做到结构性压过。
**不要用 `!important` 糊**（那是绕过问题不是解决问题，也让导出样式没法被主题覆盖）。

🔴 **同一元素有多个状态规则时，"去样式"必须两态都写**：bj 折叠三角的**展开态**是另一条
`.ns-fold[data-open="true"] > :first-child::before`（**(0,2,1)**），收起态是另一条 ——
打印补丁只写 `.ns-fold > :first-child::before`（(0,1,1)）会被展开态压回去，
**打印时"展开的折叠块"仍画出三角**（老项目 `index.html:423` 为此同时挂两条选择器）。
且**三角是 `border` 画的**："去三角"必须连 `border` 一起清零 —— 只清 `content` 会留下一枚
画出来的三角（判据 PRINT-01 用真浏览器 `computedStyle` 钉死，不吃正则恒绿）。

## 4. 🔴 判"CSS 补丁生效"必须用真浏览器读 computed style

**正则匹配 CSS 字符串的断言，在 specificity 算错时会恒绿。**
v1.8.0 的导出折叠补丁就是这样漏过一整批：425 个测试全绿，导出图照样丢正文。

补真实浏览器回归测试时，判据必须读 `getComputedStyle(el).display`。

## 5. 🔴 断言"某段代码存在/不存在"，输入必须是**去注释后**的代码

- `sw.js` 文件头注释里就写着 `const VER = (new URL(...).searchParams.get('v'))`
  ⇒ 判据读原文时，把真实现换写成写死的 `'v1'` 也测不出来（**反向验证当场抓到**）
- 注释里写着"绝不在这里写 `x.dataset.y`" ⇒ `doesNotMatch` 命中的是那句警告

**做法**：`.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')`。

## 6. 🔴 判据不许对排版过敏

`assert.ok(SRC.includes("mat.setAttribute(\n    'style',\n    …"))` ——
换个缩进（或跑 prettier）就红，而被测物好好地在那儿。改成空白无关的正则：
`/mat\.setAttribute\(\s*'style',\s*'background:var\(--bg\)/`。

## 7. 🔴 改一处要复跑依赖它的判据

实例：dragon 从 `x=60` 改到 `x=16`（对齐老项目 `index.html:11781`），
判据还在扫 `[56,98]` ⇒ 扫空了 ⇒ 假红。

实例：新增 `.box h1`（0,1,1）压掉了 `.about-title`（0,1,0）的 `letter-spacing:1px`
⇒ 改完必须复跑**全部视觉 e2e**，不能只跑自己新加的那几条。

## 8. 判"老项目长什么样"的唯一依据

**真浏览器读 computed / rect**，不是读它的 CSS，不是看截图。

## 9. "老项目没有的就去掉"

用户对 bj 的定性（2026-07、2026-10-07 两次确认）：**bj 要做到和老项目一样，
老项目没有的功能一律去掉。**

已因此删除的自创功能：
- 四时夜间问候池（老项目只有顶栏胶囊一枚 emoji + 顶部"每日一句话"气泡）
- 深夜判定写成 `h < 5`（老项目是 `h < 6`）

⚠️ 但**路线差异不等于要改**：`[折叠]` 字面量老项目留在正文里靠 `font-size:0` 藏起来，
bj 是导入时删掉、只存折叠节点 —— 这是 bj 的架构优势，**视觉能对齐就不换路线**
（用户 2026-10-07 明确拍板）。

## 10. 🔴🔴 动效层（canvas）的三条静默失效

老项目 `nsBurst`（`index.html:5394`）/`nsFirework`（`:5463`）都是裸 canvas 2d。
bj 复刻时踩的三坑**全都不报错**，只能靠真浏览器取证：

| 坑 | 症状 | 修法 |
|---|---|---|
| `ctx.fillStyle` / `ctx.font` 里写 `var(--accent)` / `var(--mono,…)` | **canvas 2d 不解析 CSS 变量**，赋值被静默丢弃 ⇒ 颜色退回默认黑、字号恒 10px，`p.size` 完全失效 | 颜色用 `getComputedStyle` 取一次缓存；`font` 写**字面量**字体栈，emoji 字体放最后：`ui-monospace, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif` |
| 按 UTF-16 码元取 emoji（`ch[i % ch.length]`） | 🎆🔥💕😂 都是**代理对**，取到半截 ⇒ 画成方框/豆腐块 | `Array.from(ch)` 按**字素**取 |
| 金点沿用 burst 的重力（`vy += 0.12`） | 老项目 `nsFirework` 的点是"匀速飞到终点"，bj 一加重力就下坠约 300px | 点走独立 `dot` 分支：豁免重力，且 `life === max`（alpha 由 `life/max` 算，否则点天生半透明） |

补充：**esbuild 把 astral emoji 转成 `\u{1F386}`**，grep 字面 emoji 验产物恒 0 命中
（同 §0 的反向陷阱），要按 `\u{1F386}` 或解码后比对。

### 10.1 🔴 "功能挂错对象"的静默死接线

彩蛋条件触发曾**一次都没跑过**而零报错：`buildEggLayer(host, store, h)` 把 `scan`
挂到**第三个参数 `h`**（外部 hooks 字面量，调用方不持有），而调用方拿到的是
**返回对象** ⇒ `scanEggTriggers` 取到 `undefined`，被 `catch` 全吞。

**教训**：能力要通过**返回对象的正式方法**暴露并写进接口类型；"它在源码里写着"
不等于"运行时会走到" —— 判据必须数**真通道的调用次数**，别只看接线形状。
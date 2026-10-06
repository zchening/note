# 与老项目对齐的量化金标

> 这些数字是**真浏览器实测值**，不是源码字面，也不是"约"。
> 用途：改动后拿真浏览器量一遍，对不上就是回归。
> 配套：`replication-discipline.md`（为什么必须是实测值）。
>
> 环境：Chromium，390×844，日间模式。夜间值另注。

## 菜单栏

| 项 | 值 | 备注 |
|---|---|---|
| 视图容器 `display` | `block` | 🔴 不许用 `flex` 列 + `gap`（见下） |
| 行高 `.menu-item` | **46** | 内容撑出来：26(图标) + 9+9(padding) + 1+1(border) |
| 行顶间隔 | **51** | = 46 + `margin-bottom:5` |
| 标签字号 `.mi-l` | **15px** | 14px 时整行只有 42 |
| 菜单盒 | `300×590` | `width:min(86vw,300px)` |

🔴 **flex 列容器会把行压扁**：容器有 `max-height:min(72vh,560px)`，11 行 ×46 撑破
上限 ⇒ flex 项按 `flex-shrink:1` 收缩到 `min-height:42px`。老项目是块级，不压。
**别去改 min-height**，那是拿错误的东西凑数字。

## 弹窗（`.box`）

| 项 | 日间实测 |
|---|---|
| 盒宽 | `351`（`min(90vw,380px)`） |
| `h1` | `18px` / `600` / `letter-spacing .02em` / `margin 0 0 8px` |
| `p` | `13px` / `--muted` / `line-height 1.7` / `margin 0 0 20px` |
| `input` | `46` 高 / `15px` / `radius 10` / `padding 0 14px` |
| `.err` | `13px` / `#C0453E` / `min-height 20px` / `margin 10px 0 6px` |
| 按钮（非禁用） | **`rgb(28,28,26)` 底 + `rgb(251,251,248)` 字** |
| 按钮（`:disabled`） | `--line` 底 + `--muted` 字 + `opacity:1` |
| `input`/`p`/`h1` 的选择器 | **元素选择器**（`.box input` / `.box p` / `.box h1`），不带属性限定 |

🔴 弹窗**不该有滚动条**（老项目 `.box` 无 `max-height`/`overflow`）。
扫一扫层是唯一例外（行内样式单独开 `max-height:calc(100vh - 48px);overflow:auto`）。

## 历史版本页

| 项 | 值 |
|---|---|
| 返回行文案 | `返回`（三个二级页都是，不是页名） |
| 历史行 | `padding 9px 12px` / `font-size 13px` / `radius 10` / `margin-bottom 6` |
| 收藏行（**不同族**） | `padding 10px 12px` / `font-size 14px` |
| 时钟列 | `16×16` |
| meta（时间戳） | `12.5px` / `--mono` / `--muted` / `letter-spacing .02em` |
| `[预览][恢复]` 按钮 | **`51×32`** / `min-height 32` / `padding 4px 12px` / `12.5px` |
| 空态 | 图标 `22px` + `opacity .55`，文字 `12.5px`，`padding 22px 0 16px` |
| 计数行 | `10.5px` 等宽 / `letter-spacing .14em` / `padding 6px 4px 10px` / 金点 `5px` |
| 历史行**无右箭头** | 老项目 `.hist-item` 整行不可点，箭头会暗示不存在的交互 |

## 折叠块

| 项 | 值 |
|---|---|
| 三角边框盒 | `8×8`（`border-left 8px` + `border-top/bottom 4px transparent`） |
| 到标题间距 | `margin 0 5px 0 3px`（等效老项目 `padding 0 3px` + `margin-right 2`） |
| 标题文字 `cursor` | **不是 `pointer`** |
| 三角 `cursor` | `pointer` |
| hover 底 | 挂 `::after`（老项目同款 18×20 感应区），**不用 `box-shadow` spread** |
| 窄屏感应区 | `44×44` |
| 导出图三角 | `▼` 字形（`\25BC`），换掉编辑器的边框三角 |
| 收起态基规则 | `.ns-fold[data-open="false"] > :not(:first-child)` = **(0,3,0)** |

🔴 `::before:hover` **恒不命中**（0×0 盒拿不到 hover，网格扫 13×24 = 312 点全灭）。
🔴 `box-shadow` spread 是**等距**的，压不到"只横向"—— 老项目 hover 底只有 14×0 高。

## 顶栏

| 项 | 值 |
|---|---|
| Logo | **17×17 恒定**（老项目全文零 clamp） |
| `.ns-mark svg` | 也要钉 17px —— 只给外层 span 定尺寸**约束不住** SVG（无 width/height 属性时默认 300×150，把顶栏撑爆） |
| 笔记名 | 移动端显示（判据 `(hover:hover) and (pointer:fine)` 为假时），桌面显示 `NoteSync` 字标，二者互斥 |
| 工具键 | `17px` 见方 |

## 日夜间与节日

| 项 | 值 |
|---|---|
| 深夜判定 | `h >= 22 \|\| h < 6` |
| 深夜**优先于**节日 | 顶栏徽章换 🌙，但**雨仍走节日 meta**（老项目 `nsFestWelcome` 注释原文） |
| 每日一句话 | 顶部居中气泡 `top:54px` / `z-index 54`（**低于**冲突条 55）/ 4.2s 自动消失 |
| 同日同篇 | 不重复（`greet_day` / `greet_last_note` 两个 localStorage 键） |

## 底栏

🔴 文案是 **30 句固定白名单**（老项目 `grep -o "setStatus(\(true\|false\), *'[^']*'" | sort -u`
可拿到全集）。**内部异常消息一个字都不在里面** —— 状态机的编程错误绝不能进底栏。

## 图标

| 项 | 值 |
|---|---|
| 太阳 `ICON_SUN` | 日面 `r=4.2` + 圈外八根短芒 + 金心 `r=1.4`，`stroke-width 1.7` |
| 月亮 `ICON_MOON` | 月牙 + 金色四角星，`stroke-width 1.7` |
| 菜单 11 枚 | `stroke-width 1.9`（老项目另有 1.8/1.7/2/2.2 五档，**别顺手统一**） |

## 图标 SVG 几何对账

菜单 11 枚的几何已逐字对齐（并排实测确认）。最快的核对方式是真浏览器量
`document.querySelectorAll('.menu-item svg')` 的 `path/@d` 与 `circle@cx,cy,r`，
两边应当**逐字相同**。
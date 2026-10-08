# 新老可见差异清单 + 整改方案（v3.0.1 候选）

> 本文档**只出方案，不改代码**。老项目 `D:\...\notesync\index.html` 是唯一权威参照物。
> 判定口径：源码里找到对应值且与金标一致 ⇒ `一致`；金标是"内容撑出/真浏览器量出"的量值 ⇒ `需实测`；源码确与老项目不同 ⇒ `不一致`。
> 纪律：先让测试证明 bug 存在再改；每条"应该有"配一条"不应该有"；恒真断言等于没有断言。

---

## 第一部分 · 本轮 5 条

### 1. 开奖卡（刷新抽卡）出现频率

**老项目机制**（index.html，只读）
- `nsDrawRoll()` **只在底栏刷新按钮 click 时**调用（:5756-5768），且 roll 在 `location.reload()` **之前**；reload 后由解锁路径 `nsDrawConsume()`（:3479 `applyUnlocked` / :3511 离线解锁）兑现。
- 前置守卫：`if (busy || inflightWrites > 0) { showUploadStatus('正在保存中，稍候自动同步'); return; }`（:5760）——**同步中既不抽卡也不 reload**。
- 让位判据 `nsDrawBusy()`（:5692-5709）：彩蛋局内、问候气泡 `.show`、节日雨非 `.hidden`、`draftBar/remoteBar/nsDraw/nsAsk` 非 `.hidden` ⇒ 一律不弹；让位时**不删袋**，最多等 8s（:5710-5730）。

**新项目现状**（main.ts / egg/draw.ts）
- `onRefresh: () => { eggDraw.roll(); location.reload(); }`（main.ts:1390-1393）；`consume()` 在两条解锁路径（:3764 / :3984）。结构与老项目**一致**。
- 🔴 差异点：
  - **(a) 缺前置守卫**：新 `onRefresh` 无 `busy / inflightWrites` 判断 ⇒ 保存中按刷新也会抽卡 + reload（老项目会拦）。
  - **(b) 让位形同虚设**：`drawBusy()` 里的 `#nsGreet` / `#nsRain` 两个常驻空壳在本项目**不存在**（draw.ts:615-618 自述）⇒ 永不对问候气泡/节日雨让位 ⇒ 出卡**概率高于老项目**。

**需用户确认**：你说的"每次刷新都抽卡"是指**每次点底栏刷新图标**，还是**浏览器/App 重载（没点刷新）也出卡**？
- 若是前者：与老项目同为设计，只是新项目缺 (a)(b) 两道"减频"机制。
- 若是后者：属 bug，需按"重载不应抽卡"定位。

**方案**
1. 复刻老项目前置守卫：`onRefresh` 先判 `busy || inflightWrites>0` ⇒ 同步中不抽卡、不 reload（与老项目逐字）。
2. 补 `#nsGreet` / `#nsRain` 常驻空壳，或让 `drawBusy()` 改读 `fx.ts` 的真实在场状态，使让位语义与老项目一致（问候/节日雨在场时不弹）。
3. 若仍嫌频繁，再加"冷却/每会话上限"——但那是**主动偏离老项目**，需你拍板，不默认做。

**判据**：`onRefresh` 内含 `busy/inflightWrites` 守卫（源码断言）；`drawBusy()` 在注入 `#nsGreet.show` 与 `#nsRain:not(.hidden)` 时返回 true（已有 DR-04，需覆盖真实壳）。

---

### 2. 移动端图片显示成一条横线

**老项目**：图片以裸 `<img src>` 插入，**无 `loading`/`decoding` 属性**（index.html:2386-2397）；CSS `#editor img{max-width:100%;border-radius:10px;margin:6px 0;display:block;border:1px solid var(--line);cursor:zoom-in}`（:343）。

**新项目**：`buildImg()` 设 `img.loading='lazy'` + `img.decoding='async'`，**无 width/height/aspect-ratio**（nodes.ts:400-410）；CSS `.ns-img img{max-width:100%;border-radius:10px;border:1px solid var(--line);cursor:zoom-in}`（styles.css:974-979）。

**根因**：`loading="lazy"` 使图片进入视口才加载；未加载时无内在尺寸 ⇒ 高度塌成 0 ⇒ 只剩 `border:1px` = 一条横线。桌面视口大、图片常在首屏内，所以只在移动端明显。

**方案**：删掉 `loading='lazy'`（与老项目一致；笔记内图片数量有限，无性能必要）。`decoding='async'` 可留可删。若坚持 lazy，必须补 `aspect-ratio`/显式尺寸占位（更复杂，不推荐）。

**判据**：e2e 断言 `.ns-img img` **无** `loading` 属性（或 `!== 'lazy'`）；真机确认图片正常渲染（PC 与手机上传的都要测）。

---

### 3. 批量导入老版本收藏（同一口令，只输一次）

**现状机制**：恢复走 `applyBakRestore` → `proveBakMaterials(ids, mats, sessionPass, onPutKey)`（main.ts:3326）：对每篇用 `口令 + 该篇信封 salt` 派生并**自证**，自证通过才写钥匙（= 免输），否则进 `needPass`。
- 关键：口令取自 `sessionPass`。**`sessionPass` 为空**（如从**备份笔记**恢复、而非配对链接 `#p=` 落地）⇒ **全部 needPass** ⇒ 每篇都弹口令框。

**用户诉求**：只需导入这几篇收藏，且**口令都相同**，希望**只输一次**。

**方案**：在恢复流程（备份笔记恢复卡 / 收藏恢复面板）增加一个**"口令（本批共用）"输入**，把它传给 `proveBakMaterials`——自证通过即整批免输。口令仍**不进码、不落盘**，仅内存消费，与既有"先验后写"安全边界一致，无新攻击面。

**另**：`nsbak-xxxxxx` 备份笔记"无法在旧设备重新生成"——需确认是否应提供**在新设备重建备份笔记**的入口（甲案载体）。

**判据**：同一口令的 N 篇，恢复后 `exempt.length === N`、`needPass.length === 0`；口令错误时**不写任何钥匙**（BAK-MAT-04 已钉，需扩到"共用口令"路径）。

---

### 4. 「扫码换机」口令框一闪而逝（已用 rAF 逐帧抓取，两次运行均无闪帧）

**代码路径**：`buildMigratePanel`（panel.ts）在 `making` 时先 `box.append(..., passWrap, ...)`（:320）再 `document.body.appendChild(mask)`（:325）；`preKey` 分支在**同一同步任务内**（:527-539）`passWrap/go/cancel.classList.add('hidden')`。从 `appendChild(mask)` 到 `add('hidden')` 之间**没有任何 `await`**（中间只有函数定义与 `addEventListener` 注册）⇒ 浏览器不可能在两者之间绘制 ⇒ 结构上**不存在可绘制的"口令框可见"中间帧**。

**逐帧抓取实测**（真浏览器 `http://localhost:8091`，`requestAnimationFrame` 每帧读 `#migrateMask/#migratePassWrap/#migrateGo/#migrateCancel/#migrateOutWrap/#migrateErr` 的 `computedStyle` 可见性，**只记录状态变化点**）：

| 运行 | 场景 | 帧序列（状态变化点） | 结论 |
|---|---|---|---|
| ① | 本会话刚用口令解锁（`sessionPass` 非空 ⇒ `preKey` 有值） | `t=0 "------"` → `t=148 "vxxxvv"` | 从"面板不存在"**一步**到"口令框隐藏 / 出码区可见"，**无中间帧** |
| ② | 刷新页面后经「记忆解锁」进入（`sessionPass` 仍非空 ⇒ `preKey` 有值） | `t=0 "------"` → `t=226 "vxxxvv"` | 同上，**无中间帧** |

> 状态串位序 = `mask / passWrap / go / cancel / outWrap / err`；`v`=可见、`x`=`display:none`|`visibility:hidden`、`-`=元素不存在。
> 两次采样各覆盖 23 / 27 帧，**都没有出现 `passWrap=v` 的帧**。
> 附：记忆解锁路径也把口令交给了 `sessionPass`（main.ts:3968）⇒ 刷新后 `preKey` 仍非空，同样走"免口令直出码"，不会出现口令框。

**结论**：**当前代码不存在"口令框一闪而逝"**。`preKey` 有值时口令框与面板挂载在同一同步任务内隐藏，浏览器一帧都不会绘制它。你看到的"一闪"极可能来自 **Bug3 修复前**的版本（当时只藏口令框、把 `go` 文案换成「正在写入备份…」留在屏上，见 panel.ts:522-526 注释），该问题已修。

**仍建议的防御性加固（可选，低风险）**：把"初始可见性"决策**提前到 `appendChild(mask)` 之前**（构造时就按 `preKey` 给 `passWrap` 定初态），使"可见中间态"在结构上不可能存在。收益：把"依赖同一同步任务"的隐式保证变成显式保证——后人若在 `appendChild` 与 `add('hidden')` 之间插入一个 `await`，也不会退化成闪帧。

**判据**：e2e 用 rAF 逐帧采样，断言从"面板不存在"到"面板稳态"之间**没有 `#migratePassWrap` 可见的帧**。

---

### 5. 系统清单：按 `docs/gotchas.md` 逐项比对

> 结论：金标覆盖的绝大多数项**在源码中可逐值定位且与老项目一致**。唯一**确证的可见差异**是历史行时间戳的 `nowrap/ellipsis`（有意偏离）。其余为"需真浏览器实测"的量值。

| 区域 | 金标值 | 新项目现状(源码) | 判定 | 依据 |
|---|---|---|---|---|
| 菜单 视图容器 | `display:block` | `display:block` | 一致 | styles.css:1051 |
| 菜单 行高 `.menu-item` | 46 | 配方齐全（min-h42+图标26+pad9/9+border1/1+15px） | 需实测 | styles.css:1062-1071 |
| 菜单 行顶间隔 | 51 | `margin-bottom:5px` | 需实测 | styles.css:1070 |
| 菜单 标签字号 `.mi-l` | 15px | `font-size:15px` | 一致 | styles.css:1091-1098 |
| 菜单盒 | 300×590 | `width:min(86vw,300px)`（高无设定） | 宽一致/高需实测 | styles.css:1054-1057 |
| 弹窗 盒宽 | 351 | `max-width:min(90vw,380px)` | 一致 | styles.css:124 |
| 弹窗 h1/p/input | 18·13·46 | 逐值相同 | 一致 | styles.css:483/484/391-396 |
| 弹窗 `.err` | 13/#C0453E | 同值（`--danger`） | 一致 | styles.css:401; theme.ts:103 |
| 弹窗按钮(非禁用) | 1C1C1A底+FBFBF8字 | 同值 | 一致 | styles.css:412-414 |
| 弹窗按钮(:disabled) | --line底+--muted字+op1 | 同值 | 一致 | styles.css:445-448 |
| 弹窗无滚动条 | 无 max-h/overflow | 无 | 一致 | styles.css:123-135 |
| 历史 返回行文案 | 「返回」 | 「返回」 | 一致 | menu.ts:383,396 |
| 历史行/收藏行 | 9/12·13 · 10/12·14 | 同值 | 一致 | styles.css:1167-1181 |
| 时钟列 | 16×16 | 同值 | 一致 | styles.css:1188 |
| meta 时间戳 | 12.5/--mono/--muted/.02em | 同值，**但已去掉 nowrap/ellipsis** | 🔴 **不一致(有意)** | styles.css:1195-1199 |
| `[预览][恢复]` | 51×32 | 同值 | 一致 | styles.css:1207,1231-1236 |
| 空态/计数行 | 22+op.55/10.5·.14em | 逐值相同 | 一致 | styles.css:1143-1149/1115-1124 |
| 历史行无右箭头 | 无 | 行内无 `.fav-go` | 一致 | menu.ts:495-505 |
| 折叠 三角盒/间距/cursor | 8×8 / 0 5 0 3 / 非pointer·三角pointer | 逐值相同 | 一致 | styles.css:792-811 |
| 折叠 hover 底 | 挂 `::after` | `::after:hover` | 一致 | styles.css:855-857 |
| 折叠 窄屏感应区 | 44×44 | 44×44 | 一致 | styles.css:900 |
| 折叠 收起态基规则 | (0,3,0) | `.ns-fold[data-open="false"]>:not(:first-child)` | 一致 | styles.css:880 |
| 导出图三角 | `▼`(\25BC) | `content:"\25BC";border:0` | 一致 | export/card.ts:140 |
| 顶栏 Logo / 工具键 | 17×17 恒定 | `.ns-mark`/`.ns-mark svg`/工具 svg 均 17px | 一致 | styles.css:551,558,582 |
| 顶栏 笔记名/字标 | 互斥 | `shouldShowBrandNote` + 藏 `#brandWord` | 一致 | shell.ts:150-152,235-240 |
| 深夜判定 | `h>=22||h<6` | 同 | 一致 | egg/fx.ts:147 |
| 深夜优先节日 / 雨走节日 meta | — | `badgeAt` 深夜优先；雨只看 `festKeyAt` | 一致 | egg/fx.ts:164-171,306-319 |
| 每日一句话 | top54/z54/4.2s | `top:54px;z-index:54` + `greetMs:4200` | 一致 | styles.css:2122-2124; copy.ts:792 |
| 同日同篇不重复 | greet_day/greet_last_note | 键 `notesync_greet_*`（前缀不同） | 一致 | copy.ts:788-789; fx.ts:448-500 |
| 底栏 30 句白名单 | 30 句固定 | 无枚举清单，靠分散 `COPY.status*` + 测试反向断言 | **需核对** | copy.ts:103-124; shell.ts:122-125 |
| 图标 太阳/月亮/菜单11枚 | 逐字几何 · sw1.9 | 逐字相同（与老项目 :1025-1026 交叉核对通过） | 一致 | icons.ts:36-38,179-198 |
| 图标 SVG 几何并排对账 | 逐字相同 | 源码几何齐备，未并排实测 | 需实测 | icons.ts 全篇 |

**确证的可见差异（按用户可见度）**
1. 🔴 **历史行时间戳去掉 `nowrap/ellipsis`**（styles.css:1195-1199，2026-10-08 主动删；老项目 :469 有截断）。窄屏长标签会换行、行高变化。**属有意偏离，非回归**——需你确认是"保留现状"还是"改回截断"。
2. **底栏"30 句白名单"源码无枚举清单**：靠 `COPY.status*` 拼接 + 一条测试反向断言。无法从源码直接核对"恰好 30 句"。建议补一份显式白名单常量 + 判据（防内部异常串进底栏）。
3. **需真浏览器实测的量值**：菜单行高 46 / 行顶间隔 51 / 菜单盒高 590、弹窗盒宽 351（390 视口）、折叠几何、菜单 11 枚 SVG 并排逐字。
4. 陈旧注释：`icons.ts:26` 写"菜单 20px"，实际 CSS 26px（不影响渲染）。

---

## 第二部分 · 上轮遗留 9 条（初判，实现前需逐条复核）

| # | 问题 | 初判根因 | 方案方向 |
|---|---|---|---|
| 1 | `/pet` 界面按钮/布局乱 | `.ns-pet-stage-panel` 缺 `flex-direction:column`；`.ns-ghost-btn` 样式不全 | 补列向布局 + 对齐老项目 `.ghost-btn` 视觉 |
| 2 | 宠物未在其他彩蛋客串 | 缺 `nsPetGame.on()` 桥接与 `petFig` 集成 | 复刻老项目"彩蛋内按需渲染宠物"桥 |
| 3 | `/bitcoin` 与新项目不一致 | 缺 gold/rock/tnt/genesis 等道具类型 | 按老项目补齐道具与数值 |
| 4 | `/satoshi` 没有"聪" | 显式去掉"聪"单位、用"币"代替 ₿ | 按老项目 :11992 补"聪"与 ₿ |
| 5 | 关于 NoteSyncX 未列举彩蛋 | About 缺彩蛋列表区 | 补彩蛋清单（与 registry 同源） |
| 6 | 关于页左右未对齐 | "检查更新"按钮缺 `.about-v` 类 | 统一 `.about-v` 宽度/对齐规则 |
| 7 | 首页"别动，抓拍识别"按钮样式变 | `ns-ghost-btn` 缺主题 CSS 覆盖 | 让 `ns-ghost-btn` 继承 `.box button` 主题样式 |
| 8 | 备份笔记 `nsbak` 换机后每篇要口令 | 见本轮第 3 条（`sessionPass` 为空 ⇒ 全 needPass） | 同本轮第 3 条方案 |
| 9 | 复古终端绿 / 复古打印机纸皮肤不一致 | `theme.ts` 缺两档皮肤调色板与叠加纹路 | 按老项目 hex 值 + 叠加图案补回 |

> ⚠️ 上表为**初判**，其中 1/3/4/5/6/7/9 的"根因"来自上一轮静态阅读，尚未逐条真机复现。**动工前需先按判据纪律各写一条"证明 bug 存在"的判据**，再改。

---

## 第三部分 · 建议整改批次与优先级

**批次 A（本轮硬 bug，优先）**
1. 移动端图片横线（删 `loading='lazy'`）——影响最大、改动最小。
2. 批量导入共用口令（恢复流程加"本批共用口令"输入）。
3. 开奖卡频率：复刻前置守卫 + 让位空壳/真实状态（**需先确认触发场景**）。
4. 扫码换机口令框：**已抓帧确认无闪帧**（见本轮第 4 条）⇒ 仅保留"可选防御性加固"，非必须。

**批次 B（上轮遗留 UI 一致性）**
5. `/pet` 布局、`/satoshi` 聪、`/bitcoin` 道具、关于页对齐 + 彩蛋列表、首页按钮样式、复古皮肤、宠物客串。

**批次 C（金标补强，低风险）**
6. 底栏 30 句显式白名单 + 判据。
7. 历史行时间戳 `nowrap/ellipsis`：**待你拍板**保留 or 改回。
8. 陈旧注释订正（`icons.ts:26`）。

---

## 第四部分 · 需你拍板 / 待确认

1. **开奖卡**："每次刷新都出卡"是指**点底栏刷新图标**，还是**重载也出卡**？（决定是"对齐老项目减频"还是"修 bug"）
2. **加冷却**：是否允许**主动偏离老项目**加"每会话/时间冷却"？（老项目没有）
3. **历史行时间戳**：保留"去截断"现状，还是改回老项目 `nowrap/ellipsis`？
4. **扫码换机口令框**：已抓帧确认无闪帧（见本轮第 4 条）⇒ 是否需要那道"可选防御性加固"？（不做也安全）
5. **`nsbak` 备份笔记**：是否需要"在新设备重建备份笔记"入口？
6. **实施顺序**：是否按 A→B→C 分批，每批先出判据再改？

---

*本文档为方案，未改动任何代码。*

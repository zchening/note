# ARCHITECTURE — NoteSync bj (v1.0 定稿)

> 本文件是**冻结的架构决定**。任何与本文件冲突的改动，先改本文件再改代码，并写明理由。
> 冻结日期：2026-10-05　·　仓库：`zchening/note`　·　域名：`bj.xuyinji.com.cn`

---

## 0. 一句话架构

**模型 JSON 是唯一真源（canonical 由 schema 保证）· Lexical 作编辑器内核 · 加密与合并全在客户端 · 服务端只见密文 · 单文件产物 · 运行时零依赖。**

---

## 1. 背景：为什么推倒重来

老项目（`TraeProject/notesync`，v10.1.7）128 条 bug 中 **56 条（44%）与"文本表示"有关**（A8/E6/F15/I7/L12/B8 类）。
根因链只有一条：

```
contenteditable 的 DOM 就是真源
  → 真源是非规范的 HTML（同一视觉有 N 种字符串表示）
  → 被迫写 5 个"等价性"补丁函数（blocksEqual / normDecorHtml / normPlaceholderHtml ...）
  → 每次浏览器升级或粘贴行为变化就爆一条 → 128 条 bug 持续增长
```

**这一条与 TypeScript、构建流程、编辑器内核无关**，所以换框架治不了它；只有换真源能铲掉。

## 2. 与老项目彻底隔离（用户明确要求）

| 维度 | 老项目 | 新项目 |
|---|---|---|
| 域名 | `biji` / `note` / `ns.xuyinji.com.cn` | `bj.xuyinji.com.cn` |
| 端口 | 8080 | **8090** |
| 数据目录 | `C:/Services/NoteSync` | `C:/Services/NoteSyncBj` |
| App 包名 | `cn.xuyinji.notesync` | `cn.xuyinji.bj` |
| 仓库 | `zchening/NoteSync` | `zchening/note` |
| localStorage | `notesync_*` | `bj_*`（按新域天然隔离） |
| MCP | 指向 biji、写 `html` 字段 | 指向 bj、读写模型 JSON |

**不迁移老笔记数据**（用户决定：可完全不兼容）。老笔记保持归档可读。
**不迁移任何本地状态**（彩蛋进度、游戏存档、收藏夹、密钥缓存全部从 0 开始）。
**但**：密钥派生参数**沿用**老项目（见 §4.3），这样将来若要迁回原域名，用户本机缓存的密钥仍可用。

## 3. 分层（五层，依赖单向向下）

```
┌─────────────────────────────────────────────────┐
│ L5 表现层  顶栏/工具栏/落地页/主题/彩蛋层          │  只吃主题变量
│    ↑ 绝不触碰正文 DOM 与笔记数据（老项目铁律）      │
├─────────────────────────────────────────────────┤
│ L4 交互层  Lexical 编辑器 + 折叠/提醒标记 + 冲突FSM │
├─────────────────────────────────────────────────┤
│ L3 同步层  SSE 订阅 + 版本协商 + 两层合并          │
├─────────────────────────────────────────────────┤
│ L2 存储层  模型 JSON + canonical 序列化 + 加密信封  │
├─────────────────────────────────────────────────┤
│ L1 密钥层  PBKDF2 / AES-GCM / IndexedDB 不可导出密钥│
└─────────────────────────────────────────────────┘
```

**为什么是五层而不是六层**：V5 曾把"同步"漏掉，把加密信封+版本协议+合并决策全塞进存储层，
导致该层职责过载。V6 修正为五层。**层数不是目标，职责单一才是。**

## 4. 冻结的技术决定（终审判定）

### 4.1 真源层
- **模型 JSON + canonical 序列化**。canonical 四条规则**由代码保证**，不靠人守纪律：
  1. 键顺序按 schema 定义顺序（不是字典序）
  2. 值为默认值的字段**一律省略**（`bold:false` 不许写）
  3. 无空格无缩进，UTF-8，数组顺序即文档顺序
  4. 序列化结果进密文
- **手写 validator**（~200 行），**不用 zod / valibot**。理由：运行时零依赖是本项目的投毒防线
  （E2EE 密钥在浏览器里，恶意依赖 = 直接偷密钥）；canonical 形态简单到不配引库。
- **块类型清单**以老项目 sanitizer 实际允许能力为基准，不多做也不少做。

### 4.2 编辑器层
- **Lexical**（Meta，TypeScript 原生）。不用自研块级 contenteditable：老项目 44 条 contenteditable
  怪癖 bug（块间退格合并 / 跨块选区 / composition 中块边界手术）在任何实现里都会重踩，
  坑来自平台而非架构。IME 是 Lexical 一等公民。
- **折叠块** = ElementNode + NodeTransform 识别 `[折叠]` / `[/折叠]` 标记行。
- **提醒** = inline element（`ReminderMarkNode`），对应老项目 `<u class="rem-mark">`。
- 🔴 **都不用 decorator 节点**：decorator 适合图片这类真嵌入 UI；折叠/提醒标记要参与文本流、
  复制、导出，必须走 element 路径。
- 🔴 **折叠开合状态是 ephemeral UI 状态，不进 canonical JSON**。否则"我手机上展开一个折叠块"
  会和电脑端产生一次纯噪音同步冲突。真源里只存"这是折叠块、标题是什么、children 是什么"。

#### 4.2.1 UI 契约（用户要求"体验与老项目完全一致"，此处为唯一依据）

只读提取自 `TraeProject/notesync/index.html`（12400 行）。**照实复刻，不许按"通用笔记应用"的直觉加东西**。

**顶栏 7 个可见键 + 2 个被 CSS 永久隐藏**（`#themeBtn,#lock{display:none}`，功能已迁入菜单，
1:1 复刻要保留这个"看不见"的事实，**别多画两个按钮**）：

| 键 | title 文案 | 动作 |
|---|---|---|
| `strikeBtn` | 删除线 | `applyStrike()`（纯 Range API，老项目已完全弃用 execCommand） |
| `remBtn` | 提醒（到点通知或下次打开提示） | 打开提醒面板 |
| `uploadBtn` | 上传图片 | 选图/上传（另有拖拽与粘贴两条路径） |
| `copyBtn` | 复制到剪贴板 | 复制全量（临时展开所有折叠块） |
| `exportImgBtn` | 导出为图片并复制 | 导出长图 |
| `scanBtn` | 扫一扫 | 扫码打开 |
| `qrBtn` | 二维码配对 | 打开配对弹层 |

另有：底栏左侧 `☰` 菜单键、右侧刷新键、连接状态点 + 文字 + 离线条（`· 最后同步：…`）。

**菜单面板**（`.mask#menuMask` → `.box#menuBox`，`id`+`.menu-item`+`role="button" tabindex="0"`，
**不用 data-act**）主视图 11 项，文案原文照抄不可改：
返回首页 / 收藏笔记（动态"收藏笔记|取消收藏"）/ 收藏夹 / 历史版本 / 打开链接 / 扫码换机 / 桌宠 /
夜间模式（动态"夜间模式|日间模式"，文案与图标都动态）/ 修改口令 / 退出锁定 / 关于 NoteSync。
三个二级视图：收藏夹列表（空态"暂无收藏"）、历史版本（空态"暂无历史版本" + "新增历史版本"）、
打开链接（"链接打开方式" kicker + 应用内/系统浏览器 + 提示"笔记里的网址默认打开方式，仅对本机生效。"）。
布局：`.menu-item` flex gap 12px / min-height 42px / 1px 边框 / 圆角 10px；**标签列定宽 112px**；
`#menuMainView` 高度 `min(72vh,560px)` 可滚。

**落地页**：logo + `NoteSync` +副标 **`落笔即心安`**；输入框 placeholder **`笔记名（英文/数字）`** maxlength 64；
按钮初始 disabled，文案 `打开`（命中彩蛋保留字时变 `打开彩蛋`）；
警告行 `仅支持英文、数字、下划线和短横线`；网址预览行 `你的笔记网址为：{host}/{name}`；
`扫码打开笔记`；底部信任行三段 `服务器只见密文` / `无需账号` / `扫码跨设备`（聚焦时淡出避让软键盘）。
输入即净化 `replace(/[^A-Za-z0-9_-]/g,'')`，非法字符触发警告行。

**口令页**：`输入口令` + 说明`此口令用于在本机派生加密密钥，不会发送到服务器。每台新设备首次打开需输入一次，之后自动记住。`
+ 密码框 + 错误行 + `解 锁`（初始 disabled）。另有首页提示页：
`请在 URL 后加笔记名访问，例如：{domain}/biji`。

**🔴🔴 编辑器没有富文本块工具栏** —— 这是最容易复刻错的地方。
老项目**不存在** `formatBlock` / 标题 / 有序无序列表 / 引用 / 代码块 / 分割线 / slash 命令。
全部 `execCommand` 只用于粘贴与 `defaultParagraphSeparator`。
真实能力只有四类，**触发方式必须是下面这些**：

| 能力 | 触发方式 | 标记原文 |
|---|---|---|
| 折叠块 | **行首**键入标记，NodeTransform 自动识别 | `[折叠]` … `[/折叠]` |
| 删除线 | 顶栏 `strikeBtn` | — |
| 图片 | 顶栏 / 拖拽 / 粘贴 | — |
| 链接 | **纯文本自动识别**（裸域名、手机号） | 无标记 |
| 提醒标记 | **正文写时间，自动识别** | `2027年5月1日 07:00`、`5-1 07:00`、`5月1日 07:00` |
| 已提醒 | 到点后自动变删除线 | `<s class="rem-done">` |

折叠规则原文：某一行**开头**写 `[折叠]` 才生效；其下正文一路折到 ①下一个 `[折叠]` 把手行
②`[/折叠]` 闭合锚 ③笔记末尾 为止 —— **空行不再切断组**。`[折叠]` 与 `[/折叠]` 文本始终留在正文
（同步/导出/打印不丢字），它是**纯显示层**。

**主题**：仅浅/深两态，**无"跟随系统"选项**。默认走**时间规则**：19:00–07:00 夜间
（`分钟<420 || >=1140`）。🔴 手动切换**只改内存态，刻意不写 localStorage** —— 刷新或重新解锁
一律回时间规则（用户明确要求）。另有 `prefers-color-scheme` 跟随 + 60s 定时 + 借壳检测
（应对国产浏览器强制反色）。

**皮肤**：独立于主题的**隐藏三态环** —— **连点左上角 logo 7 次**沿
`默认 → 终端绿(skin-a) → 打字机纸(skin-b) → 默认`前进，字标随之变为
`NoteSync` / `NOTE-SYNC.EXE` / `N O T E S Y N C`，切换瞬间在版本气泡位弹 1.5s 标签
（`已恢复默认` / `复古 · 终端绿` / `复古 · 打字机纸`）。会话级纯内存，刷新回默认。
覆膜层`#skinFx` 四档 `.scan` / `.scan.light` / `.paper` / `.paper.night`，
**非色彩、低透明、不拦截交互**；皮肤环内**禁用借壳反色**。
另：彩蛋抽奖卡的金属覆膜 `--foil-*` 令牌与皮肤**无关**，别混。

**色板（唯一来源，逐字节照抄）**
浅色：`--bg:#FBFBF8 --fg:#1C1C1A --muted:#98958A --line:#ECEAE2 --accent:#8F7126
--accent-soft:rgba(143,113,38,.07) --ring:rgba(143,113,38,.16) --box-bg:#FFFFFF
--upload-bg:#1C1C1A --hover:rgba(28,28,26,.05) --danger:#C0453E`
深色：`--bg:#0F0F11 --fg:#E9E8E3 --muted:#7A786F --line:#242428 --accent:#D4B068
--accent-soft:rgba(212,176,104,.08) --ring:rgba(212,176,104,.22) --box-bg:#17171A
--upload-bg:#E9E8E3 --hover:rgba(233,232,227,.07) --danger:#C0453E`
字体：`--serif:Georgia,"Times New Roman","Songti SC","STSong",serif`
`--mono:ui-monospace,SFMono-Regular,"SF Mono",Consolas,Menlo,monospace`
（`--g-*` 网格线、`--zoom-*` 缩放层、`--foil-*` 抽奖卡覆膜另有其值，见 S6/S8）

### 4.3 加密层
- **PBKDF2-HMAC-SHA256 · 600,000 次**（OWASP 现行线；老项目是 200,000，本次上调 3 倍）。
  用 WebCrypto 原生实现，不引 libsodium 的 wasm（App 冷启已 15-20s，边际收益不抵体积代价）。
- **AES-256-GCM**，整文加密，每次保存新随机 96 位 IV。
- **信封自描述**：`{v, alg, kdf:{name,iter,salt}, iv, ct}`。这是 KDF 提参的前置保险，
  也是将来所有算法演进的通道。
- **密钥存 IndexedDB，`extractable:false` 的 CryptoKey**。raw key 永不出 WebCrypto。
  老项目把派生密钥 base64 存 localStorage（6 处明文落盘），XSS 一念即永久脱机失守 —— 零包袱下必须改。
- 🔴 **不加主密钥 wrap 层**。现状本就"每篇笔记独立盐独立密钥"，加 wrap 层只服务"未来共享笔记"
  这种臆测需求，单人维护不做。

### 4.4 同步层
- **SSE 单向推送 + POST 写入**（保持老项目协议语义）。提醒是纯客户端算的，
  服务端不需要定时推送；WebSocket 在零依赖 Node 上要手摇帧解析，纯负资产。
- **两层合并**（客户端）：块级 LCS 对齐 + 块内字符级 diff3，合并器是**纯函数模块**。
- **冲突状态机显式**：locked / syncing / dirty / pushing / conflict / offline / idle，
  转移表写成数据、可单测。🔴 **不用事件总线**（字符串考古现场）。
- **空闲静默轮询 + 全链路超时**（v3.0.2，逐字承接老项目 `withTimeout`，index.html:9934/:3488）：
  idle 态每 2s 先比内容（`eq` = canonicalize(normalize(·)) + 剥提醒标记），无变化**不进状态机**
  ⇒ 底栏不在「已同步/保存中」间抖动；有变化才 `remote-arrived`。
  `/api/note` 的 GET/POST 全走 `fetchTextWithTimeout`（轮询 12s / 一次性 GET 8s，
  **读体也在超时窗口内**，返回已读好的 `TimedResponse{ok,status,text}`）——
  🔴 半死 socket 下裸 fetch 永不 resolve ⇒ `pulling` 永久锁死 ⇒ 同步静默死
  （底栏仍显示已同步）。静默轮询所有失败分支（网络/5xx/解析/解密）统一降级 offline
  并报用户可见错误，绝不静默谎报已同步；FSM 补 `offline --pulled--> idle` 恢复边
  （200+空体/无变化在 offline 态也要能回 idle，否则底栏永久停「离线中」）。

### 4.5 服务端
- **零依赖 Node + JSDoc `// @ts-check`**。897 行的服务端每行可审；E2EE 项目的依赖投毒风险
  大于 TS 收益，类型依赖也是供应链面。TS 化不划算。
- **限流 failMap 持久化**：5 分钟定时把 Map 落 JSON 快照、启动读回（~20 行，不引 sqlite）。
- 服务端**只见密文**，不解析、不校验、不重排。

### 4.6 构建与测试
- **TS strict 全开**，`tsc --noEmit` 进闸（esbuild 不查类型）。
- **esbuild 单文件产物**（JS+CSS inline）。单文件是 OTA 原子性与离线兜底的根基。
- **版本注入**：唯一来源 `package.json`，esbuild `define` 注入 `__APP_VERSION__` / `__BUILD_DATE__`。
  🔴 测试**只许断言"产物版本 == package.json 版本"**，出现字面版本断言 = 评审打回。
- **三端壳一致性**：根 / `www/` / `android assets` 三份产物由构建脚本 **sha256 校验**保证，
  替代老项目的人工纪律。
- **测试**：属性测试（fast-check，进 devDep 不进产物）+ 核心闸 + Playwright e2e。
  🔴 **jsdom 全面退役**（它的 Selection/beforeinput 残缺是老项目整套 mock 纪律税的根源）；
  DOM 与编辑器测试**全部走 Playwright**。
- **不引 Workbox**：SW 策略就两条且已踩坑固化（缓存名版本驱动、10s AbortController 超时），
  75 行手写足够。🔴 **APK 内不注册 SW**（与热更新打架，老项目踩过）。
- 🔴🔴 **节点清单与行为清单必须同批次评审**（Lexical 0.52 实锤，见 `packages/client/src/behaviors.ts`）：
  `createEditor({nodes})` 只解决"节点能被创建"，**打字/格式化/缩进/剪贴板/撤销全部由
  `@lexical/*` 插件包提供，不在 `lexical` 核心里**。
  漏注册 `registerRichText` 的症状是教科书级**静默降级**：渲染正常、聚焦正常、
  `beforeinput` 照常触发、`updateEditor` 照常执行、**console 一个错都没有**，
  但敲键盘一个字都进不去（`CONTROLLED_TEXT_INSERTION_COMMAND` 被 dispatch 到
  没有监听者的黑洞）。纯逻辑单测对此完全无感，**只有 e2e 能抓**——
  这也是"E2E-02 真浏览器打字"被列为全项目最重要回归闸的原因。
- 🔴 **Lexical 0.52 的 Extension 体系（`defineExtension` / `RichTextExtension`）在本项目不可用**：
  实测 `extension-core/` 只有 `.d.ts` 无 `.js`，`CreateEditorArgs` 与 `EditorConfig`
  **都没有 extensions 字段**，Activation 入口在 `@lexical/react` 那一侧。
  纯 DOM 宿主照抄 React 侧写法会得到"看起来注册了、实际 `register` 回调从未被调用"的
  **第二层静默故障**。故统一走 `register*` 函数式（`registerRichText` / `registerList` /
  `registerAutoLink`），并手工保证"兜底行为最后注册"。升级 Lexical 版本时**必须复核这条**。

### 4.7 收藏备份（扫码换机，BakManifest v4 自包含 + 免输口令）

- **清单格式**：`{v, ts, f, m, e:(Envelope|null)[]}` —— `f[i]`/`m[i]`/`e[i]` 同下标。
  版本按内容自动选：`anyPass ? 4 : anyEnv ? 3 : anyMat ? 2 : 1`（`encodeBakText`）。
  v3 = 材料 + **每篇正文的密文信封**（自包含收藏备份）；**v4 = 材料 `p` 再带该篇自己的口令**
  （口令来自本机口令保险箱 `sync/pass-vault.ts`，用该篇密钥加密存着）⇒ 恢复**零输入**
  逐篇派生自证。服务器与扫码方全程只见密文，零知识不变（拿到清单明文 = 拿到各篇口令，
  与老项目"清单装 raw key"对用户同等级）。旧格式 v1/v2/v3 仍可读，出码只产新版。
- **`p` 的编码**：口令原样（可能中文/emoji），JSON 里非 ASCII 必须 `\uXXXX` 转义
  （`asciiJson`）—— `btoa` 只吃 Latin-1，直接编码必抛 InvalidCharacterError，
  症状是"出码整个失败"，与口令内容毫无关联，极难自查。
- **二维码载荷恒为配对链接**（`buildBakLink`），清单本体写在云端专用备份笔记（v1.11.0 起）。
- **恢复主流程（`applyBakRestore`）**：有信封的篇先探服务器 —— 服务器有正文 → 缓存
  **镜像服务器版**（防旧缓存倒灌）；服务器没有 → `putBakNote` 补推 + 写缓存；
  离线 → 备份信封兜底写缓存。无信封的篇只装名单，探后**如实报数**（`noContent`；
  离线探不了不计入——宁可不报，也不谎报"会是空的"）。
- **出码（`makeBakBackup`）**：材料 `collectBakMaterials` 只做**签名**不重派生
  （600k×100 篇重新派生 = 白等 6 秒）；信封**服务器优先、缓存兜底**（`collectBakEnvelopes`，
  防备份携带过期缓存）；装不进正文的篇数如实计入 `skipped` 并在出码区警示。
  备份笔记**自己的口令**也存保险箱（`savePassVault`）——"收藏变更自动刷新"在
  刷新页面、记忆解锁之后仍拿得出口令，不依赖 sessionPass（那是当前篇的口令）。
- **恢复（`proveBakMaterials`）**：逐篇自证，**自证通过才写钥匙**。自证块 = 该篇真钥匙
  加密定长常量（PROOF_AAD 域分离）；任何不通过 ⇒ `null`，绝不猜、绝不拿别篇口令顶上。
  该篇实际口令由 `materialPass` 统一（出码/恢复**共用同一函数**，防"自证用 p、写凭据用
  pass"错配）：材料 `p` 优先，缺省回落备份码口令；回落重试成功后必须回传
  **实际成功**的那个口令（`effPass`，判据 BAK-MAT-15）。
- **第二道自证（BAK-MAT-16）**：材料自证通过、但这把钥匙打不开该篇正文信封 ⇒
  **同样不写钥匙**（"多设备 keystore 不同步"的形状：材料自洽，却指向一把打不开正文的钥匙）。
- **恢复卡 v4**：**没有**每篇口令框、**没有**「重建备份笔记」按钮（v3.0.1 的过渡方案退役）；
  少数没材料/自证不过的篇仍会弹口令框，完成页**如实报数**——谎报"全部免输"会让撞到
  口令框的用户以为数据丢了。
- **收藏变更自动刷新（`refreshBakNote`）**：本机有备份槽 = 出过码的设备，收藏夹一变就把
  清单重写一遍。三条前置**缺一不刷**：① 有备份槽；② 槽那篇密钥在 key-store；
  ③ 它的口令在保险箱（没口令硬刷会换盐 ⇒ 旧二维码失效）。失败一律静默
  （fire-and-forget，不该让用户的收藏动作弹错）；防重入用 **coalescing**（丢弃式会让
  飞行中到达的最后一次变更永远进不了备份）。
- **字节预算**：服务端请求体上限 **8MB**（`server.js` `MAX_BODY`；"1MB"是老项目口径）。
  清单按 100 篇 × 16KB ct < 4MB 设计，留有余量（判据 BAK-NOTE-34）。
- **安全不变量**：信封 `kdf.iter ≥ 100_000`、alg/kdf.name 白名单（`parseEnvelope`）；
  材料 `m` 多于篇数**整份拒收**、信封 `e` 多于篇数**忽略**——取向必须相反（BAK-NOTE-32）；
  篇名闸不因版本升级松动（BAK-NOTE-33）。判据族：BAK-NOTE-24~34 + FSM-16
  （采纳远端必须刷离线缓存）+ BAK-MAT-15/16。

### 4.8 笔记写入凭据闸（v2.1.0，`packages/server/src/guards.js`）

- **语义一句话：能解密 ⇔ 能写入**。不知道口令的人派生不出凭据，服务端只存 `sha256(writeKey)`，
  零知识不变。移植依据是老项目 server.js v10.0.0（`:85-176` 闸 / `:178-202` 扫描守卫 /
  `:248` 保留名 / `:430-456` claim 端点），**逐条比对，不靠推理定案**。
- **凭据头 `x-note-key`**（16–128 字符）。客户端凭据来源与本项目红线 #4 适配：密钥
  `extractable:false` 导不出，故改用**口令域分离 PBKDF2**（迭代与主派生同级 600k，
  见 `packages/client/src/sync/write-key.ts`）——`x-note-key` 在局域网纯 HTTP 链路可被嗅探，
  低迭代等于送口令给离线秒爆。服务端只认 `sha256(凭据)`，两种派生法对它完全同形。
- **三态**（`NS_BJ_WK_MODE` env，或 `DATA_DIR/wk-mode.txt` 文件优先、5s 缓存热切，不必重启）：
  `off`（全放行，灰度起步档）／`new-only`（只挡"真新建且无凭据"）／`full`（已认领笔记无凭据一律 403）。
- **认领端点 `POST /api/note/:id/claim`**：纯登记、幂等、错凭据硬 403、不建档、404 同形。
  未认领笔记接受第一次凭据登记（=认领）；一旦认领，凭据不符**绝不自动降级**
  （自动降级 = 攻击者先用错凭据撞一下就能卸掉防护再覆盖）。改口令走 `wkOld` 自证**原子换绑**
  （改口令与写入同批，无自锁窗口）。
- 🔴 **四条写路径全部带闸**：`POST`/`PUT /api/note/:id`、历史快照追加、`DELETE`、备份笔记恢复侧
  逐篇 re-push。**正门锁了侧门不锁等于白装。**
- **凭据失败独立计数桶**（60 次/10 分钟，只挡写入，**绝不牵连 GET**）：若与口令爆破共用 failMap，
  不升级的旧客户端每次自动保存都记一次失败，攒够就把"老版本不能写"升级成"老版本连自己笔记都看不到"
  （不可接受的误伤）。
- **门牌保留名**（`snake` 等 10 个，**只挡新建**不毁存量）＋ **扫描守卫**（GET miss 80 次/10 分钟按 IP）。
- 部署节奏：`off` 上线 → 用户逐篇解锁自动认领 → 写 `wk-mode.txt` 热切 `new-only`/`full`。
  线上档位现为 `full`。

### 4.9 街机档案鉴权（v3.0.0，`/api/arcade`）

- **大写档案 id**（`^[A-Z0-9]{4,16}$`，老护照 `ns1:id=39CLCAR9` 形状）走鉴权路：必带
  `x-arcade-key`、服务端只存 `keyHash`、**钥匙错与"档案不存在"同形 404**（防枚举）、
  回包**剥掉 `keyHash` 与 `id`**（连哈希都不出门）。
- **`POST /api/arcade {id,key}` 建档幂等**（id 在**体**里、不看路径段——客户端认领老护照正是
  POST 到无 id 段的 `/api/arcade`）；**`PUT` 合并回档**（counters 逐键取最大、shelf 并集排序上限 512）
  —— 整篇覆盖会跨设备互抹成绩。
- 🔴 **小写 id 是 bj 早期形状**，保持无鉴权裸读（旧数据必须还能读回）。**绝不能先 `toUpperCase`
  再判**——那样 `arc1` 这类早期小写形状会被误判成大写档案 ⇒ 无钥匙一律 404、旧数据凭空消失。

### 4.10 配对落地两条入口，一个收口（v3.0.0）

- **两条入口**：① 扫码（`handleScanRaw`）；② 把配对链接贴进地址栏 / 收藏书签 / 别的 App 里点开
  （`#p=` fragment，老项目 `#k=` 的等价物）。此前**没有任何人读 `location.hash`**，于是
  "链接发给自己点开"照样弹口令框。
- 🔴 **解析口径只写一遍**：两条入口都必须走 `resolveScan` 这个唯一收口，**不许各自调
  `parsePairLink`**（分叉的根源从来不是"忘了改"，而是"改了一处"）。
- **顺序与扫码分支逐条对齐**（两条入口不许分叉）：① 先 `history.replaceState` 清掉地址栏里的口令
  （fragment 虽不上行服务器，但会留在地址栏 / 历史 / 截图 / 复制出的链接里，**口令用完即弃**）；
  ② 备份笔记（`nsbak-`）先进只读恢复卡，绝不挂编辑器；③ 口令错 / 数据坏给**与手输同一句**文案
  （安全不变量：不给暴力破解 oracle），再退回口令框。
- 🔴 **直链入口不兑现开奖**：全项目恰两处 `eggDraw.consume`（手输口令 + 记忆解锁）。老版 `#k=`
  走"存密钥 → 整页重载 → 自动解锁分支"，那条分支没有 `nsDrawConsume`；`#p=` 与 `handleScanRaw`
  同族，多写一条等于让直链入口凭空吞掉刷新开奖（判据 DR-07b）。

## 5. 五条红线（写进 code review checklist）

1. **运行时零依赖** —— 产物里不许出现未经审读的第三方代码；服务端零 npm 依赖。
2. **每闸归因一条不变量** —— 每条核心闸必须写明它守住哪条不变量，防止闸膨胀成下一个 128 条人工核对。
3. **折叠开合状态不进真源** —— 它是 ephemeral UI 状态。
4. **raw key 永不出 WebCrypto** —— 密钥只以不可导出 CryptoKey 存 IndexedDB。
5. **字面版本断言 = 评审打回** —— 版本只能来自 `package.json`。

## 6. 服务端安全不变量（从老项目继承，不许退化）

- DROP 标签黑名单：`script style iframe frame frameset object embed applet link meta base
  form input button textarea select option optgroup fieldset svg math noscript template portal
  xmp marquee noembed noframes plaintext listing`
- 所有 `on*` 事件属性一律移除
- URL 属性（`href src xlink:href action data formaction poster`）判危险协议：
  `javascript: vbscript: livescript: file: view-source:` 一律拒；
  **`href` 的 `data:` 一律拒**（`data:image/svg+xml` 可携带脚本，且顶层导航到 data: URL 继承来源）；
  `src` 的 `data:` 仅允许位图，拒 svg/html/xhtml/text/xml。
  判前先剥掉 `\u0000-\u0020` 与 `\u007f`（`java\tscript:` 是经典绕过）。

## 7. 明确不做（附理由）

| 不做 | 理由 |
|---|---|
| 迁移老笔记数据 | 用户决定：可完全不兼容 |
| 迁移 localStorage 状态 | 换域即全新开始 |
| 主密钥 wrap 层 | 只服务臆测的共享需求，省 3-5 人日 |
| zod / valibot | 运行时零依赖是投毒防线 |
| CRDT | 服务端需中继明文操作序列，与整文 E2EE 冲突；两层合并够用 |
| WebSocket | 单向 SSE 已够，WS 在零依赖 Node 上纯负资产 |
| Workbox | 两条策略手写足够 |
| jsdom | 残缺 API 是老项目 mock 纪律税的根源 |
| 服务端 TypeScript 化 | 依赖投毒风险 > 类型收益 |
| 导出/导入本地状态 | 换域即新开始；将来迁回原域名会自动恢复 |

## 8. 机械止损判据

**硬截止**：第 60 个有效人日，或日历 T+4 个月（先到者为准），不设"再给两周"。

**冻结探针**（开工前写死，判定人只有用户 + 那份文件）：

1. 拼音连续输入 200 字：无丢字、无重影、候选窗不漂移
2. 块首/块尾/空块/折叠块内，光标定位误差为 0
3. 跨块退格 100 次：无残留空块
4. 5000 字笔记：输入延迟 P95 < 50ms
5. 撤销重做 50 轮：状态一致
6. 模型 → 序列化 → 解析：往返无损
7. 随机 1000 组并发编辑：合并后两侧内容零丢失

**判定规则**：≥2 条失败 → 立即停止并回退到可用状态；≤1 条失败 → 必须给出 5 人日内可验证的修复路径。

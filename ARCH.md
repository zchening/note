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

## 4. 冻结的技术决定（19 项终审判定）

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
- **冲突状态机显式**：locked / syncing / dirty / conflict / offline，转移表写成数据、可单测。
  🔴 **不用事件总线**（字符串考古现场）。

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

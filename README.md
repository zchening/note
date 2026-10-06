# NoteSync bj

端到端加密笔记 PWA。与老项目 `TraeProject/notesync` **完全独立**：域名、端口、数据目录、包名、仓库、localStorage 键族全部隔离。

线上：`https://bj.xuyinji.com.cn` ｜ App 包名 `cn.xuyinji.bj` ｜ 仓库 `zchening/note`

## 为什么重建

老项目 128 条 bug 里 56 条（44%）与"文本表示"有关，根因链只有一条：

```
contenteditable DOM 即真源
  → 同一份内容有 N 种 HTML 字符串表示
  → 被迫写 5 个等价性补丁函数逐个兜
  → 补丁之间互相打架 → bug 持续增殖
```

本项目把"模型 JSON"作为唯一真源，HTML 只是渲染产物。同一份内容在磁盘上**只有一种表示**，由代码保证而非纪律保证（`canonicalize` 四条规则）。这把 N 压回 1，44% 的 bug 类别从根上消失。

## 架构

五层，依赖单向向下：

| 层 | 位置 | 职责 | 运行时依赖 |
|---|---|---|---|
| 真源层 | `packages/shared-schema` | 模型 / canonical / validator / 两层合并 / 加密信封 | **零** |
| 编辑器 | `packages/client` | Lexical 接入 + 模型双向绑定 + 同步状态机 | Lexical |
| 服务端 | `packages/server` | 静态托管 + 密文中继 + SSE + 限流 | **零**（仅 node: 内置） |
| MCP | `packages/mcp` | 读写密文，全程不解密 | **零** |
| 构建 | `tools/build.mjs` | esbuild 单文件 + 版本注入 | esbuild（仅构建时） |

**零运行时依赖是安全属性，不是洁癖**：密钥在浏览器里，多一个运行时依赖就多一个能在 import 期读到 `CryptoKey` 的第三方代码。所以校验器手写（约 200 行）而不用 zod，服务端不用 express。

## 核心不变量

真源层有 40 条测试钉死六条不变量，每条对应一类历史 bug：

1. **canonical 幂等** —— 反复序列化逐字节不变（修"保存后再打开样式变了"）
2. **往返无损** —— `parseDoc(canonicalize(d))` 等于 `normalize(d)`
3. **拒绝确定** —— 非法输入永远被拒且错误码稳定，不因时序变化
4. **归一幂等** —— `normalize(normalize(d)) === normalize(d)`
5. **合并吸收** —— `merge(a,a,b) === b` 且 `merge(a,b,a) === b`（修"同步后自己改的又回来了"）
6. **合并确定** —— 纯函数，不修改入参，同输入同输出

加密层另有 12 条安全不变量（往返、salt/iv 每次不同、错口令与篡改同一话术、AAD 不可换、envelope 自描述、哨兵串校验）。

## 相对老项目的实质改进

| 项 | 老项目 | 本项目 |
|---|---|---|
| 真源 | contenteditable DOM（HTML 非规范表示） | 模型 JSON + canonical 唯一表示 |
| 编辑器 | 自研块级 contenteditable（44 条怪癖 bug） | Lexical（Meta，TS 原生） |
| 密钥存储 | localStorage 明文 base64（6 处） | IndexedDB `extractable:false` CryptoKey |
| KDF | PBKDF2 200,000 | PBKDF2 600,000（OWASP 现行线） |
| IV | 复用（同密钥下密文可对比） | 每次随机 |
| 用途隔离 | 无 AAD | AAD 域分离（note/meta/rem/egg） |
| 失败锁定 | 内存 Map，重启清零 | 5 分钟 JSON 快照，启动读回 |
| 冲突 | 静默覆盖 | 显式 Conflict 列表交 UI 选择 |
| 依赖注入面 | 大量 CDN | esbuild 打包进单文件 |

## 开发

```bash
npm install
npm run typecheck     # tsc strict + 5 项额外严格选项
npm test              # 真源层 40 条 + 服务端 26 条
npm run test:e2e      # Playwright（需先 npm run build）
npm run build         # esbuild 单文件 → www/
npm run verify        # typecheck + test + build
```

端口 8090（老项目 8080），数据目录 `C:/Services/NoteSyncBj`（老项目 `notesync`）。

### 线上真域名验收

```bash
npm run test:e2e:live
```

打的是生产实例 `https://bj.xuyinji.com.cn`，覆盖 Caddy 反代 / CSP 响应头 / SSE 是否被缓冲 / 真实 Node 路由 / 端到端加密落库——这些**本地 e2e 一行都测不到**（本地跑的是内存版 API，`/api/stream/*` 直接 204）。

套件末尾的 `tools/check-live-e2e.mjs` 是**机械自查闸**：校验步骤数、条目总数、耗时下限三项，任一不符即判"结果不可信"并返回非 0。

🔴 为什么要机器校验而不是人眼看输出：这套文件上栽过三次「汇总全绿但结论不可信」——顶层裸 `process.exit`（一条没跑报 1 条绿）、清理用例从未执行（生产目录每次留一篇密文笔记）、收进父测试后仍 `exit`（5 条全跑完，汇总被掐成 4 条）。三次的输出都很好读，只有"数条目 + 看时长"能发现，而人眼在长输出里数条目并不可靠，于是同一个坑踩了三次。

## 发版

版本号唯一来源是根 `package.json` 的 `version`，构建时由 esbuild `define` 注入。改版本必须同步改本文件的版本历史表。

```bash
# 1. 改 package.json version → 2. npm run verify → 3. 提交打 tag
git tag -a v0.1.0 -m "v0.1.0"
git push origin main --tags
```

推送 tag 会触发 GitHub Actions 云构建 APK（`ANDROID_KEYSTORE_BASE64` / `_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD` 四个 secret 已在仓库配置）。本机零 Android 依赖。

CI 里有两道闸，顺序不能颠倒：**单测不绿 → build 作业不执行 → 不出包**。除了全量单测，还会在 UTC / America/New_York / Pacific/Auckland 三个时区下各跑一遍客户端单测——写死时区的断言在开发者本机（GMT+8）永远绿，只有 CI 才抓得到（真踩过：`fmtRemTime` 的 ISO 断言）。

### 🔴 出包之后还有一步：上传 App 升级元数据

App 查新版的唯一入口是 `GET /api/latest`，它读的是**服务器磁盘上** `APP_DIR/deploy/latest_app.json` 那份文件。

这跟"部署网页 index.html"是**两件完全无关的事**——同一台机器、同一次部署动作，两者之间没有任何因果关系。网页侧验收全绿**不能**代表 App 查得到新版：老项目 v10.1.8 就是网页全绿、App 永远收不到更新，因为那份 json 压根没人上传。

```bash
# 用 gh 读该 tag 的 Release 生成（体积等字段绝手填），
# 再传到 C:\Services\NoteSyncBj\deploy\latest_app.json
python tools/make_latest_app.py --tag v1.0.0
```

`make_latest_app.py` 会在三种情况下**拒绝生成**：Release 还是 draft（对外不可见，用户点更新跳 404）、没有 `.apk` 资产（传半份元数据比不传更坏，App 会显示"已是最新"）、`size` 为 0 或缺失（原生侧用 `expectedBytes` 判"下载完没"，填 0 会让截断的 APK 被当已下完，直接拉起安装器报 `packageInfo is null`）。

真域名 e2e 的 LIVE-06 是这条链路的唯一独立判据：它分别判「有文件 → 200 + 真模块能解析 + 挑得出 .apk + `no-store`」与「无文件 → 404 + `no release metadata`」，两种状态都是合法部署态但必须各自判对。

OTA 即部署：APK 是壳，页面从服务器加载，`capacitor.config.json` 的 `server.url` 指向线上域名，改完前端发版即生效。

## 版本历史

| 版本 | 日期 | 摘要 |
|---|---|---|
| v1.4.0 | 2026-10-06 | 修复收起态折叠标题按回车后文字跑进折叠块内部（内容会看不见）：改成把标题切开、光标后的文字搬到折叠块外面；选区测试接口支持指定偏移 |
| v1.3.5 | 2026-10-06 | 链接打开方式页：补上系统浏览器一行的图标、选中标记从五角星改成对勾、补选中态样式；修折叠三角 hover 时底色错位 |
| v1.3.4 | 2026-10-06 | 补上扫码配对/换机弹窗警示文字的样式（此前用了类名但样式表里没有对应规则，那几处警示全是浏览器默认字号） |
| v1.3.3 | 2026-10-06 | 修弹窗层：提醒/口令弹窗的关闭按钮**补上图标**（此前容器是空的，右上角什么都不显示）、弹窗遮罩去掉多余内边距、说明文字与错误行字号行高归回老项目、弹窗整体高度对齐 |
| v1.3.2 | 2026-10-06 | 编辑器层按老项目对齐：顶栏与底栏补上底色（原先透明，滚动会透出下层）、菜单项去掉自造的白色底（老项目菜单行本身透明，底色来自弹层）、菜单标签字号改回 15px（原先 14px 导致整行矮 4px，菜单间距看着不对） |
| v1.3.1 | 2026-10-06 | 落地页按老项目逐值对齐：输入框与「打开」按钮统一 46px 高、字色/禁用态配色改回老项目（原先禁用态是深底白字，看着像可点）、扫码行字号与配色归位 |
| v1.3.0 | 2026-10-06 | 修复折叠标题改不了：标题文字实时同步回标题字段（此前只有反序列化时写过，改标题的编辑被丢弃）；新增选区定位测试接口；修掉一条因换行符不同而恒红的扫码安全判据 |
| v1.2.0 | 2026-10-06 | 修四个真 bug：底栏同步后补回「已同步」（三态都有兜底文案）、收藏后五角星真的变实心（`class="gf"` 而非 SVG 的 `fill="currentColor"`）、上传图片 401（图床签名串改按字典序）、取消扫码不再残留「识别中…」；补上 Ctrl+Z 撤回（`@lexical/history` 此前压根没装）与历史版本「预览」按钮；修正 e2e 桩把历史版本响应多包一层 JSON 的契约漂移 |
| v1.1.0 | 2026-10-05 | 修完 21 条用户报障：扫一扫浮层补挂载、记忆解锁后可出配对码、折叠行首判定放宽、正文链接与斜杠彩蛋入口接通、编辑器撑满高度菜单栏置底、状态点改绿并居中、提醒滚轮定位与空态文案按老项目逐字对齐、图片上传补齐图床配置 |
| v1.0.0 | 2026-10-05 | 首个可用版本：编辑器、提醒、扫码配对、图片上传、导出长图、收藏夹与彩蛋层、Android 壳与云构建签名、App 在线升级全部就绪；已部署 bj.xuyinji.com.cn 并通过线上真域名验收 |
| v0.1.0 | 2026-10-05 | 架构定稿 + 真源层 + 加密层 + 服务端，76 条测试全绿 |

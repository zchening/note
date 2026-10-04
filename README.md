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

## 发版

版本号唯一来源是根 `package.json` 的 `version`，构建时由 esbuild `define` 注入。改版本必须同步改本文件的版本历史表。

```bash
# 1. 改 package.json version → 2. npm run verify → 3. 提交打 tag
git tag -a v0.1.0 -m "v0.1.0"
git push origin main --tags
```

推送 tag 会触发 GitHub Actions 云构建 APK（`ANDROID_KEYSTORE_BASE64` / `_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD` 四个 secret 已在仓库配置）。本机零 Android 依赖。

OTA 即部署：APK 是壳，页面从服务器加载，`capacitor.config.json` 的 `server.url` 指向线上域名，改完前端发版即生效。

## 版本历史

| 版本 | 日期 | 摘要 |
|---|---|---|
| v0.1.0 | 2026-10-05 | 架构定稿 + 真源层 + 加密层 + 服务端，76 条测试全绿 |

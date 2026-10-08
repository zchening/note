# CLAUDE.md —— bj（notesync-bj）工作约定

> 本文件是**规则手册**：只写"下次写代码前必须看到"的东西。
> 机制细节在 `ARCH.md`，量化金标与纪律在 `docs/`。**不要在本文档写变更叙事。**

## 这个项目是什么

端到端加密的 PWA 笔记应用（`bj.xuyinji.com.cn`），从零重写，目标是与老项目
`D:\Users\zchen\Documents\TraeProject\notesync\index.html`（12400 行单文件，**明文中文**）
像素级 + 行为级一致。**老项目是唯一权威参照物。**

🔴 **bj 与老项目是隔离的两个项目**（用户明确要求）：独立前缀 `notesync_bj_`、独立数据目录、
独立部署目录。**"与老项目的差异"默认按"重写进度未完成"分类，不是回归。**

## 动手之前

- [ ] 涉及视觉/交互 ⇒ 读 `docs/replication-discipline.md`
      （**老项目源码字面 ≠ 实际渲染**，有 `!important` 运行时覆盖层与三处死规则）
- [ ] 要断言某个数值 ⇒ 查 `docs/gotchas.md`（那里是真浏览器实测值，不是约数）
- [ ] 改完 UI ⇒ 走 `docs/replication-checklist.md` 的清单
- [ ] 涉及架构/不变量 ⇒ 读 `ARCH.md` 对应章节（§4 冻结决定、§5 五条红线、§6 安全不变量）

## 环境

```bash
# 🔴 必须用受管 node 的绝对路径，不要裸 node（版本与模块解析都依赖它）
NODE="C:/Users/zchen/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"

cd D:/Users/zchen/Documents/TraeProject/notesync-bj
"$NODE" node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   # typecheck
"$NODE" tools/build.mjs                                              # 产物 → www/
cd packages/client && "$NODE" --test test/*.test.mjs                 # 单测
"$NODE" --test --test-concurrency=6 test/e2e/*.test.js               # e2e（约 3 分钟）
```

⚠️ **e2e 必须 `--test-concurrency=6`**：27+ 文件串行会超时。
⚠️ **e2e 跑的是 `www/` 产物**，改了源码不先 `tools/build.mjs` 就测不到（反过来：
读 `www/app.js` 断言会被压缩打脸 —— 变量名混淆、中文变 `\uXXXX`，**e2e 里要读源码**）。

## 部署

🔴 **发版 = 两次动作**：① 推 tag（CI 出 APK + OTA + Release）② 跑下方脚本部署网页（`www/` 独立部署，**CI 不碰网页**）。只做 ① ⇒ App 新版、网页停旧版（v2.0.1 实锤）。

```bash
cd D:/Users/zchen/Documents/WorkBuddyProject/NoteSync
"C:/Users/zchen/.workbuddy/binaries/python/versions/3.13.12/python.exe" _bj_deploy_web.py
```

- 🔴🔴 **部署网页只跑 `_bj_deploy_web.py`，绝不再跑 `_bj_deploy3.py`**：deploy3 是 S7-b **初次搭建**的第三步，其第 2/6 步是 `rmdir /s /q C:\Services\NoteSyncBj\data` —— **它会删掉生产数据**（笔记密文、街机档案、`wk-mode.txt` 写入凭据闸档位）。`wk-mode.txt` 一没，凭据闸静默从 `full` 退回 `off`（安全回归，且不报错）。`_bj_deploy_web.py` 只替换 `www/` 与服务端源码，`data/` 一字节不动（2026-10-08 v3.0.0 实跑并自证 `data/notes` 非空）。
- 服务在 **8090**（不是老项目的 8080），数据目录 `C:\Services\NoteSyncBj\data`
- 部署后必查：`/healthz` 的 `version` 等于刚 bump 的值；`/api/upsign` **POST** 返 200（它是 POST-only，GET 本就 404，别误判成故障）
- 🔴 **新增服务端文件必须同步加进上传清单**（`_bj_deploy_web.py` 里 `("server.js","failmap.js","guards.js","upsign.js")`），漏了就是 ESM 找不到模块、服务起不来
- 🔴 **新增静态资源子目录**（如 `.well-known/`、`icons/`）要确认两处都放行：`_bj_deploy_web.py` 用 `os.walk` 递归上传；`build.mjs` 的"跳过点文件"过滤器要放行 `.well-known`（否则文件在仓库里、产物里没有、线上 404 而构建日志正常）
- 凭据：SSH 走 `~/.ssh/notesync_deploy`（ed25519），脚本里不出现密码

## APK 发版（GitHub 云构建 + 自动 OTA，勿手打）

APK 不在本机出，全部由 `.github/workflows/build-apk.yml` 完成。手打 `gradlew assembleRelease` 只在本地调试时用，**发版一律走 CI**，否则本地签名/版本号/OTA 元数据三者容易不一致。

- **触发**：`git tag vX.Y.Z && git push origin <tag>`（tag 推送）；或 `gh workflow run build-apk.yml -R zchening/note`（手动，版本号取 `package.json`）。
- **三作业**：`test`（单测闸，不绿不出包） → `build`（JDK21 + 签名出 `app-release.apk`） → `deploy`（腾讯云 OTA + GitHub Releases）。
- **两发布目标同进同退**：`deploy` 作业先上传腾讯云并线上校验通过，最后才发 GitHub Release —— 两处不会一处新一处旧。
- 🔴 **版本号唯一真源 = `package.json`**：tag 名 / APK `versionName` / OTA `tag_name` / Release 名全部从它派生；`build.mjs` 删静态资源必须同步删 `STATIC_REQUIRED` 清单，否则 CI 的 build 直接 `exit 1`（v1.13.1 曾因此红过一次）。
- 🔴 **覆盖安装只判 `versionCode`（不判 versionName）**：加权公式 `major*10000+minor*100+patch` 在 `build-apk.yml`，**禁改回去点拼接**——位数变化时倒退（1.13.1→1131、2.0.0→**200**）被 Android 拒装（v2.0.0 实锤）。
- 产物落点（线上已校验）：腾讯云 `https://bj.xuyinji.com.cn/dl/vX.Y.Z.apk` + `/api/latest` 指向它；GitHub Releases 同版本附 `NoteSyncX-vX.Y.Z.apk`。手机点「检查更新」走 `/api/latest`。
- 上传顺序的硬纪律（倒装：两个 APK 先就位、`latest_app.json` 最后落）只在 `tools/push_bj_apk.py` 里有权威，CI 只调它，不另写。
- 密钥：签名四件套 + SSH 私钥 `BJ_SSH_KEY` 都是 repo secret；改密钥/换部署机要同步改这两处与 `push_bj_apk.py` 的 `HOST`。

## git

```bash
# 开发机（zchen，D:/Users/zchen）：禁代理直连
git -c http.proxy= -c https.proxy= push origin main
# 腾讯云部署服务器（本机 C:/Users/Administrator）：必须走环境代理，不要加 -c http.proxy= 清空它
git push origin main
```

- 🔴 **git 代理按机器分**：开发机禁代理直连；**本部署服务器必须走 `HTTPS_PROXY` 环境代理**（直连 GitHub 会挂死，2026-10-08 已实证）——在此机上推送**不要**加 `-c http.proxy=` 去清空代理。`gh` CLI 两处都走 `HTTPS_PROXY`。
- 🔴 **提交前先 `git status`**：临时探针（`_probe*` / `_diag*`）会被 `git add -A` 一起带上
- 版本号唯一源是 `package.json` 的 `version`，改它必须同步改 `README.md` 版本历史表

## 五条红线（详见 ARCH.md §5）

1. **正文永远不进服务器**（密文中继，改动要重新论证安全不变量）
2. **`/api/*` 一律 network-only**，SW 连回落缓存都不给
3. **色彩字面量只允许出现在 `ui/theme.ts`**（有纪律闸 `S4-T7`）
4. **编辑器没有富文本块工具栏** —— 老项目没有，加工具栏就是复刻失败
5. **ephemeral UI 态不进真源**（折叠开合、皮肤档位、主题手动态）

## 判据纪律（最容易翻车的地方）

- 🔴 **先让测试证明 bug 存在，再改代码**；改完把实现撤掉验一次判据会红。
- 🔴 **恒真断言等于没有断言**：判据必须 `import` 生产代码，不许把实现抄进测试。
- 🔴 **每条"应该有"配一条"不应该有"**。
- 🔴 **断言"某段代码不存在/存在"，输入必须去注释后的代码** —— 注释里写着
  "绝不在这里写 `x`" 会让 `doesNotMatch` 命中警告本身。
- 🔴 **判 CSS 补丁是否生效必须读真浏览器 `computedStyle`**；正则匹配 CSS 字符串
  的断言在 specificity 算错时**恒绿**（真发生过：425 测试全绿、导出图照样丢正文）。
- 🔴 **`:not()` 的 specificity 取其参数**（自身不贡献），写补丁选择器必须精确数。
- 🔴 **`--test-name-pattern` 用子测试名会整轮空跑**：e2e 是 `test('父', t => t.test('子'))` 两层结构，用**子**级名过滤会让 node 当文件级过滤、子测试全跳过，输出 `# tests 1 / # pass 1` 假绿。pattern 必须给**父级**名，并核对子测试 `ok N` 真的列出（不只看 `# pass`）。
- 🔴 **桌面 e2e 的 Backspace/逐字符删除走 contenteditable 原生路径**，焦点稍偏就 DOM/树分叉（DOM 删了、editorState 没动，判死不触发）——与真机 beforeinput 不同构。删字符类判据用 `Control+a + 重打` 的树替换形状（REM-05/REM-19），细节见 `docs/replication-checklist.md` 判据纪律的 e2e 三坑。

## 深入文档

| 文档 | 内容 |
|---|---|
| `ARCH.md` | 架构、五层依赖、19 项冻结决定、五条红线、安全不变量、机械止损判据 |
| `docs/replication-discipline.md` | 与老项目对齐时的判读方法与陷阱（**动手改 UI 前必读**） |
| `docs/gotchas.md` | 量化金标速查（菜单/弹窗/折叠/顶栏/底栏/图标的实测值） |
| `docs/replication-checklist.md` | 改完 UI 逐项过的核对清单 + 探针写法 |
| `README.md` | 为什么重建、架构概览、开发与发版流程、版本历史 |
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

```bash
cd D:/Users/zchen/Documents/WorkBuddyProject/NoteSync
"C:/Users/zchen/.workbuddy/binaries/python/versions/3.13.12/python.exe" _bj_deploy3.py
```

- 服务在 **8090**（不是老项目的 8080），数据目录 `C:\Services\NoteSyncBj\data`
- 部署后必查：`/healthz` 的 `version` 等于刚 bump 的值；`/api/upsign` 返 200
- 🔴 **新增服务端文件必须同步加进上传清单**，漏了就是 ESM 找不到模块、服务起不来
- 🔴 **新增静态资源子目录**（如 `icons/`）要确认部署脚本会递归传 —— 它原本只传顶层文件

## git

```bash
git -c http.proxy= -c https.proxy= push origin main
```

- 🔴 **git 必须禁代理直连**（`-c http.proxy= -c https.proxy=`）；`gh` CLI 才走 `HTTPS_PROXY`
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

## 深入文档

| 文档 | 内容 |
|---|---|
| `ARCH.md` | 架构、五层依赖、19 项冻结决定、五条红线、安全不变量、机械止损判据 |
| `docs/replication-discipline.md` | 与老项目对齐时的判读方法与陷阱（**动手改 UI 前必读**） |
| `docs/gotchas.md` | 量化金标速查（菜单/弹窗/折叠/顶栏/底栏/图标的实测值） |
| `docs/replication-checklist.md` | 改完 UI 逐项过的核对清单 + 探针写法 |
| `README.md` | 为什么重建、架构概览、开发与发版流程、版本历史 |
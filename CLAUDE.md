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
- [ ] 涉及动效 / canvas ⇒ 读 `docs/replication-discipline.md` §10（canvas 不解析
      `var()`、emoji 按码元取会断代理对、金点不能带重力 —— 三条都静默失效）
- [ ] 涉及架构/不变量 ⇒ 读 `ARCH.md` 对应章节（§4 冻结决定、§5 五条红线、§6 安全不变量）
- [ ] 动 `merge.ts` 的 LCS ⇒ 预算是**两档**且语义不同：TOP 64M 格管顶层全量对齐（调小会把
      大而合法的合并误杀成冲突，不变量-3 是哨兵），CHUNK 16M 格管两侧相异的簇（这才是 OOM 真凶）

## 环境

```bash
# 🔴 必须用受管 node 的绝对路径，不要裸 node（版本与模块解析都依赖它）
NODE="C:/Users/zchen/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"

cd D:/Users/zchen/Documents/TraeProject/notesync-bj
"$NODE" node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   # typecheck（根配置；mcp/server 另有 tsconfig.mcp/server.json，一键 `npm run typecheck` 三个全跑）
"$NODE" tools/build.mjs                                              # 产物 → www/
cd packages/client && "$NODE" --test test/*.test.mjs                 # 单测
"$NODE" --test --test-concurrency=6 test/e2e/*.test.js               # e2e（约 3 分钟）
```

⚠️ **e2e 必须 `--test-concurrency=6`**：24 个文件串行会超时。
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
- 🔴 **新增服务端文件必须同步加进上传清单**（`_bj_deploy_web.py` 里 `("server.js","failmap.js","guards.js","upsign.js","net-ip.js")`），漏了就是 ESM 找不到模块、服务起不来
- 🔴 **新增静态资源子目录**（如 `.well-known/`、`icons/`）要确认两处都放行：`_bj_deploy_web.py` 用 `os.walk` 递归上传；`build.mjs` 的"跳过点文件"过滤器要放行 `.well-known`（否则文件在仓库里、产物里没有、线上 404 而构建日志正常）
- 凭据：SSH 走 `~/.ssh/notesync_deploy`（ed25519），脚本里不出现密码
- 🔴🔴🔴 **CSP 唯一权威 = `packages/server/src/server.js` 的 P1-12（随 HTML 文档下发），Caddy 层严禁再设 CSP**（v3.1.5 事故）：Caddy bj 块的 CSP 是 S7-b 时代值（`style-src 'unsafe-inline'` 无 `'self'`，那会儿 CSS 还内联），v3.1.x 起 CSS 外链成 `app.css` 后**多个 CSP 头按交集生效** ⇒ 过期头把外链样式整页挡死（首页/笔记页全无样式，还顺带挡了 PBKDF2 Blob Worker），而构建与部署日志一切正常。2026-10-12 已从 Caddyfile 删除该行（脚本 `_bj_caddy_fix_csp.py`，老项目 9 域名零回归）。**将来改 CSP 只改 server.js 一处**；判据：线上响应头有且仅有一份 CSP 且含 `style-src 'self'`＋`worker-src 'self' blob:`

## APK 发版（GitHub 云构建 + 自动 OTA，勿手打）

APK 不在本机出，全部由 `.github/workflows/build-apk.yml` 完成。手打 `gradlew assembleRelease` 只在本地调试时用，**发版一律走 CI**，否则本地签名/版本号/OTA 元数据三者容易不一致。

- **触发**：`git tag vX.Y.Z && git push origin <tag>`（tag 推送）；或 `gh workflow run build-apk.yml -R zchening/note`（手动，版本号取 `package.json`）。
- **三作业**：`test`（单测 + e2e 子集〔01 往返/03 同步〕+ 首屏闸 + 三端版本一致性，不绿不出包） → `build`（JDK21 + 签名出 `app-release.apk`） → `deploy`（腾讯云 OTA + GitHub Releases）。
- **两发布目标同进同退**：`deploy` 作业先上传腾讯云并线上校验通过，最后才发 GitHub Release —— 两处不会一处新一处旧。
- 🔴 **版本号唯一真源 = `package.json`**：tag 名 / APK `versionName` / OTA `tag_name` / Release 名全部从它派生；`build.mjs` 删静态资源必须同步删 `STATIC_REQUIRED` 清单，否则 CI 的 build 直接 `exit 1`（v1.13.1 曾因此红过一次）。
- 🔴 **发版前必须写 `releases/<tag>.md`**（第三个同步点，漏了 CI 直接红）：App「检查更新」弹窗里那几行更新要点**只**来自这份文件（经 `latest_app.json` 的 `summary`），它同时是 GitHub Release 页正文。上限 **4 条 / 每条 24 字**、项目符号只能 `-`、不许出现链接或 `compare/` 行。规则权威在 `tools/release-notes.mjs`，CI `test` 作业跑 `tools/check-release-notes.mjs`，`push_bj_apk.py` 里还有一道硬失败（它可能被单独手动调用）。格式见 `releases/README.md`。
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
- 版本号唯一源是 `package.json` 的 `version`，改它必须同步改 `README.md` 版本历史表**与 `releases/<tag>.md`**（三处同步点）

- 🔴🔴🔴 **Lexical 组字零宽后缀补丁（v3.2.7 实验，tools/patch-lexical.mjs）**：Lexical `$setTextContent` 组字期每次 DOM 写 `nextText + COMPOSITION_SUFFIX`（Android=U+200B）⇒ DOM 恒比模型多 1 字 ⇒ 疑似浏览器组字应用随机塌方的诱因。补丁把该写入点的后缀去掉（DOM 恒等于模型）。三条纪律：① 补丁在 **esbuild 打包前**由 build.mjs 自动应用（CI 的 npm run build 同样覆盖）；② **补丁点漂移 ⇒ exit 1 构建失败**——Lexical 升级后绝不静默发未打补丁的包；③ 只改 prod 文件的写入点，不动读取点（endsWith 剥离等自然不命中）。若真机验证塌方消失 ⇒ 长期方案＝patch-package 固化＋报上游；若无效 ⇒ 撤补丁走「最小复现实验＋换引擎」路线。
- 🔴🔴🔴 **组字接管（v3.2.9 实验）＝页侧最后一搏**：长组字帧（≥TAKEOVER_MIN_LEN=12 的 insertCompositionText）在 beforeinput **capture 相位**（早于 Lexical 的 bubble 监听）preventDefault + stopPropagation + ed.update 应用输入法完整串 ⇒ 浏览器永远不做组字应用（随机塌方的故障点被拆掉）。三条纪律：① 短组字不接管（拼音 caret 语义归浏览器）；② 探针 setTakeover 开关（e2e 隔离：WD-E2E-05/06/07/10 关掉钉各自形状，WD-E2E-13 专门钉接管）；③ applyCompositionTakeover 选区兜底（选区不在 TextNode 上时退到根下第一个 TextNode）。**真机裁决标准**：日志出现 wd:takeover 且无 gate:collapse ⇒ 接管成功，固化；口述全停（浏览器结束组字）⇒ 一键回滚（setTakeover 默认关）。若接管失败 ⇒ 页侧穷尽，走「最小复现实验（ProseMirror 骨架）→ 换引擎」。
- 🔴🔴🔴 **组字接管 v3.3.0（v3.2.9 的真机修正）**：Chromium **无视**输入法组字的 beforeinput preventDefault（v3.2.9 真机实证：应用照做、还应用坏）⇒ beforeinput 拦截路线已废。现行方案：onFlightI（**input 事件**，浏览器应用完的同一任务）对 ≥TAKEOVER_MIN_LEN=12 的 insertCompositionText 用输入法完整串覆盖 DOM（applyCompositionTakeover）⇒ 浏览器来不及绘制，用户只见正确文本；Lexical 随后读 DOM 即正确串 ⇒ 模型恒等于输入法串 ⇒ 守卫不命中。v3.2.9 真机已实证该机制让口述连续 14 秒不断。纪律：① 合成 input 事件会被 Lexical 自处理再应用一次（真实浏览器不会）⇒ e2e 断言用包含性（WD-E2E-13）；② 探针 setTakeover/composeFrame/botchFrame 隔离；③ 真机裁决看日志 wd:takeover 与文字是否稳定增长。
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
- 🔴 **桌面 e2e 的 Backspace/逐字符删除走 contenteditable 原生路径**，焦点稍偏就 DOM/树分叉（DOM 删了、editorState 没动，判死不触发）——与真机 beforeinput 不同构。删字符类判据用 `Control+a + 重打` 的树替换形状（REM-05/REM-19），细节见 `docs/replication-checklist.md` 判据纪律的 e2e 四坑。
- 🔴🔴 **撤稿守卫两个机制按形状分工，不许互相踩踏**（v3.1.5 实锤）：composing-mismatch 只拦「**树真在掉**（currentLen<prevLen）＋组字串远长于文档」的帧（拦+冻结保模型）；「树**纹丝不动**＋串远长于树」是锚点死亡空转形状，归空转检测（4 帧 ⇒ wd:dead＋wd:reboot 救屏幕）。mismatch 若也拦空转帧，每个空转帧都会走 collapse restore ⇒ `scheduleDeferredTreeSync` 把 stall 计数清零 ⇒ reboot 永远数不到 4（WD-E2E-05/06/07 红过）。改判定顺序/条件后必须同轮跑 26+28 两个文件。
- 🔴🔴🔴 **撤稿守卫的 ending 宽限窗口必须按"时间"收口，不能只按帧计数**（v3.3.2 实锤）：原窗口只数 evalsLeft=2 帧，无法区分「cmp:end 同帧 flush 延迟掉字（<33ms，IME 同步塌方）」与「数秒后用户点豆包的刻意整段替换（润色）」。豆包润色是 comp=0 的 insertText 整段替换（121→44），会落进 ending 窗口被误判「撤稿」回滚、润色被吃掉（v3.3.1 决策实验日志 `gate:withdraw withdraw 121->44` 钉死；v3.3.1 归因于零宽字符是误报）。修法：新增 `endingEnteredAt` + `endingWindowMs=1500`，窗口内仍照常回滚（IME 真因不误伤），超时 comp=0 掉字判刻意编辑不回滚（reason=`ending-window-expired`，飞行日志记 `wd:defer`）。判据 WD-11（超时 comp=0 替换不回滚）/WD-12（窗口内真撤稿仍回滚）先红后改；合成环境 end()+同步更新复现不出数秒延迟，故用**直接驱动状态机**的单元判据而非 e2e（WD-E2E-14 曾假绿被删）。
- 🔴🔴🔴 **`editorHost.blur()` 会拆掉 Android 输入法连接＝当场掐断用户语音**（v3.1.6 真机实锤）：reboot 自愈里曾无条件 blur/focus（v3.0.20 为对齐宿主视图加的），用户没点键盘停止键也被掐断——reboot 之后再无一条 composition 帧、说完的话一句不进。现在 reboot 只做 ce＋重建；**懒重连**：重建后组字帧真把树打回（knock-back）才补 blur/focus（WD_RECONNECT_WINDOW_MS=2000 窗口，解冻/过期双清除）。**任何"为对齐宿主而动焦点"的方案落地前必须掂量这条**——拆焦点的代价是用户的录音会话，不是界面副作用。
- 🔴🔴 **wd:sync 到期 skip 判据看「会话峰值」不看「基线」**（v3.1.7 真机实锤）：旧判据「树长 > deferTreeLen 就 skip」在 knock-back＋懒重连形状下误判——blur 取消组字把当前串 commit 进树，残串涨过基线几个字就 skip ⇒ 峰值永远上不了屏，且冻结解除后模型被残串覆盖 push 上行＝内容真丢。现判据：`nowLen >= deferPeakLen` 才 skip；唯一例外＝窗口内用户手动打字（`wdWindowManual`，非组字 beforeinput 置位）且树长 > 基线——手敲字是最新意图（v3.0.17 规矩），绝不能按峰值重建抹掉。
- 🔴🔴🔴 **reboot 连续救不活必须升级重连**（v3.1.8 真机实锤）：第三种形状——锚点死亡但**无掉幅**（每帧 `upd d=0` 空转、无塌方可拦、reboot 的按峰值重建是空操作）⇒ ce+重建+新 cs 空转 26s，用户的话全在输入法串里。现机制：`wdRebootFails` 计数（树长纹丝不动才累计、帧一落地就归零），连续失败 2 次起把懒重连升级为无条件 blur/focus（10s 冷却防焦点风暴）——此时会话已事实死亡，拆焦点代价早已付清，赌的是宿主重新 extract 后视图对齐。
- 🔴🔴 **组字心跳（v3.2.0）＝塌方预防的最后防线，触发条件与依据必须钉死**：豆包重识别只在**长组字（真机 7 次塌方全部 >~100 字，100 字内从不出事）**上打塌树，且 tree:frag 实证塌方前后都是单 TextNode（不是 Lexical 碎片，是浏览器/输入法替换几何自身）。心跳＝组字串过 80 字自动合成 ce＋按模型重建（等价于用户点完成重开口述），长组字永远被切成短组字。**合成 ce 不杀 ASR 会话**（三份真机实证）——这是心跳可行的前提。心跳只在组字健康时触发（wdFreeze/恢复窗口内不插手）；e2e 用 setHeartbeatAt 隔离（其他判据关心跳钉形状、WD-E2E-11 专门钉心跳）。若真机证伪（心跳后仍塌方/会话仍断）⇒ 下一步方向＝DOM 层取证（same 标志）定位 Lexical 组字期 DOM 元素替换，或联系豆包侧。
- 🔴 **调用点传锚要传会话峰值，不传模型长**：update 监听里的 `prevLen` 是 `docTextLen(before)`（**模型相对**），渐进放血形状下模型已被残串覆盖、远低于水位线会话峰值——塌方路径锚取 `max(prevLen, withdrawGuard.peak)`，`scheduleDeferredTreeSync` 里再来一道 max 闸（延迟同步已激活时只涨不跌）。
- 🔴🔴 **原生桥异步值的行，绝不显占位符「…」，要「先隐后就地填空」＋冷启动预热**（v3.3.4 实锤，用户否决了 v3.3.3 的「…」占位）：关于页 App 版本号走 `getVersion()` 桥（真机约 1-2s）。v3.3.3 先显 `…` 再换真值——用户看到"点点点→版本号"跳变仍难看。正确做法（仿老项目 v10.2.2）：① **冷启动预热** `warmUpNativeVersion()`（`ota-native.ts`，壳内无条件预热一次，结果缓存）；② 关于页打开时**优先用缓存同步显形**；③ 缓存未回则**先 `hidden` 藏行**，桥回后**就地填空显形**（`textContent` 填真值再 `remove('hidden')`）——绝不先显占位符。取不到（桥失败）保持隐藏，不显占位符。**任何「值要等桥/接口」的 UI 元素，要么冷启动预热让它同步到手，要么先隐后填空，绝不用「…」这类占位符先显**（占位符跳变比"晚一拍出现"更扎眼）。判据 VVW-08b 先红后改（壳内 mock `window.Capacitor` + 慢 `getVersion` 1.5s：断言 App 版本行任何时刻都不出现 `…`、桥回后就地显形填真值）。

## 深入文档

| 文档 | 内容 |
|---|---|
| `ARCH.md` | 架构、五层依赖、19 项冻结决定、五条红线、安全不变量、机械止损判据 |
| `docs/replication-discipline.md` | 与老项目对齐时的判读方法与陷阱（**动手改 UI 前必读**） |
| `docs/gotchas.md` | 量化金标速查（菜单/弹窗/折叠/顶栏/底栏/图标的实测值） |
| `docs/replication-checklist.md` | 改完 UI 逐项过的核对清单 + 探针写法 |
| `README.md` | 为什么重建、架构概览、开发与发版流程、版本历史 |
# 并排核对清单 —— 改 UI 之后逐项过

> 目的：让"这次改动有没有破坏与老项目的一致性"变成**可执行的动作**，不是靠印象。
> 配套：`replication-discipline.md`（怎么量）、`gotchas.md`（期望值是多少）。
>
> 权威参照物：`D:\Users\zchen\Documents\TraeProject\notesync\index.html`

## 怎么跑一次并排量化

探针脚本（放在 scratchpad，不要提交）：

```js
// 关键点，逐条都对应 replication-discipline.md §1.1 的坑
const oldSrv = await serveStatic('D:/Users/zchen/Documents/TraeProject/notesync', makeApiStore());
const bjSrv  = await serveStatic('D:/Users/zchen/Documents/TraeProject/notesync-bj/www', makeApiStore());
const browser = await launchBrowser();          // 从 harness.mjs 借，playwright 只在 bj 的 node_modules 里
// 两边各开 newContext({ viewport:{width:390,height:844}, hasTouch:true })
// forceDay 必须**验结果**：点 → 读 body.classList.contains('dark') → 不符再点
```

⚠️ **选器一个逗号都不写**：`querySelector('#a h1, .b h1')` 返回文档顺序第一个命中**任一分支**
的元素，前面的分支会劫持后面的。
⚠️ 老项目的编辑器是 `#editor`，bj 是 `#editor-host` —— 别硬套一套。
⚠️ 关遮罩用 `classList.add('hidden')`，**老项目扫码面板不吃 Esc**。

## 清单

### 每次改 UI 必过

- [ ] **typecheck**：`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
- [ ] **全量单测**：`cd packages/client && node --test test/*.test.mjs`
- [ ] **全链路 e2e**：`node --test --test-concurrency=6 test/e2e/*.test.js`（约 3 分钟）
- [ ] 改的是 `.box` / `.menu-*` / 折叠 / 顶栏**任一处** ⇒ 并排量一遍受影响的项，
      逐条对照 `gotchas.md`

### 改弹窗（`.box`）后

- [ ] 按钮底色/字色仍等于 `gotchas.md` 的日间实测值（深底浅字）
- [ ] `.box h1` / `.box p` / `.box input` 仍是**元素选择器**（不是类名/属性限定）
- [ ] **没有新增滚动条**：真浏览器查 `scrollHeight > clientHeight` 的元素清单，
      与老项目同位置的清单逐一对应
- [ ] 若新增了 `.box button` 覆写规则 ⇒ 用真浏览器读 `getComputedStyle`，
      **不要只断言 CSS 字符串存在**（specificity 算错时字符串断言恒绿）

### 改折叠后

- [ ] 三角边框盒仍 `8×8`，`margin 0 5px 0 3px`
- [ ] 标题文字 `cursor` 不是 `pointer`；三角与 `::after` 是 `pointer`
- [ ] hover 底**不依赖** `box-shadow` spread
- [ ] **导出图实测**：收起态导出后读副本里折叠体的 `computedStyle.display`，
      必须是可显示状态（这是 2026-10-07 修过的 bug，见 `replication-discipline.md` §3）
- [ ] 收起态标题中间回车，新段落落在折叠体**之后**
      （判 `compareDocumentPosition`，别看文本顺序）

### 改顶栏后

- [ ] Logo 仍 `17×17`（无 `clamp`、无 `vw`）
- [ ] `.ns-mark svg` 自身有 17px 规则（不能只给 span 定尺寸）
- [ ] 移动端显示笔记名、桌面显示字标，二者**互斥**
- [ ] 窄屏媒体查询只隐藏字标，**不碰笔记名 span**

### 改历史版本/收藏页后

- [ ] 历史行 `9px 12px`/`13px`，收藏行 `10px 12px`/`14px`（**不同族**）
- [ ] 历史行**没有**右箭头
- [ ] `[预览][恢复]` 按钮 `min-height 32`（不是弹窗通栏 46）
- [ ] 三个二级页的返回行文案都是 `返回`

### 动到 ServiceWorker / 静态资源时

- [ ] `sw.js` 缓存名由注册 URL 的 `?v=APP_VERSION` 驱动，**没有写死版本号**
- [ ] `tools/build.mjs` 的 `STATIC_REQUIRED` 含新增资源
- [ ] 若新增**子目录**：`materializeStatic` 是否递归？`readdir` **只列一层**
- [ ] 部署脚本 `_bj_deploy3.py` 是否传子目录？（它原本只传顶层文件）
- [ ] 构建结尾**没有 EPERM**（`for...of` 里往被迭代的数组 `push` 会让下一轮把目录当文件 copy）

### 发版前

- [ ] `package.json` 的 `version` 已 bump（唯一版本源，构建时注入）
- [ ] `README.md` 版本历史表已加行（摘要 ≤80 汉字、表格单元格内无裸竖线）
- [ ] 推 tag 前 **e2e 本地全绿**（CI 只跑单测闸不跑 e2e；先 build 再测，同轮跑过 build 该轮 e2e 作废）
- [ ] 🔴 **APK + 网页两次动作都做了**：推 tag（CI 出 APK+OTA+Release）**且**跑了 `_bj_deploy3.py`（**CI 不碰网页**）。只推 tag ⇒ App 新版、网页停旧版（v2.0.1 实锤：App 2.0.1 / 网页 2.0.0）
- [ ] 🔴 **versionCode 闸**：CI 用加权公式 `major*10000+minor*100+patch`（`build-apk.yml`），**禁改回去点拼接**——1.13.1→1131、2.0.0→**200** 倒退被 Android 拒覆盖安装（覆盖安装只判 versionCode，不判 versionName）
- [ ] 部署后 `/healthz` 的 `version` 等于刚 bump 的值
- [ ] 新增的静态资源在服务器上真的能取到（部署日志有逐个 `OK 上传`）

## 判据纪律

- 🔴 **先让测试证明 bug 存在，再改代码**；改完把实现撤掉验一次判据会红。
- 🔴 **恒真断言等于没有断言**：判据必须 `import` 生产代码，不许把实现抄进测试。
- 🔴 **每条"应该有"配一条"不应该有"**。只写金标时，"把金标和实现一起改"会让判据重新变绿。
- 🔴 新增用例前先 `grep` 同文件编号防撞号。
- 🔴 断言"某段代码不存在/存在"，输入必须是**去注释后**的代码。
- 🔴 判据不许对排版过敏（硬编码多行缩进 = 换个缩进就假红）。

### e2e 时钟与键盘的三个坑（2026-10-08 REM-18/19 三连红换来的）

- 🔴🔴 **Playwright 假钟 install 后 rAF 全停**：install 放在测试开头会让打开/打字阶段
  的渲染间歇性停摆（三红两绿的根因）。install 必须推迟到"被测 timer 排上之后、
  fastForward 之前"的窗口（如 chip 加提醒之后、clock.fastForward 之前）。
- 🔴🔴 **测试里的提醒时刻要留足容差余量**：`Date.now()+60s` 经分钟取整后，
  剩余秒数均匀落在 0–60s，其中一半会撞进 chip 的 30 秒过期容差
  （`at <= now+30s` 视为 expired 不弹卡）→ 用 **+120s** 起步。
- 🔴🔴 **桌面 e2e 的 Backspace 走 contenteditable 原生路径**：焦点不严格落在
  Lexical root 时，DOM 被原生删掉而**树完全不动**（DOM/树分叉，判死不触发）——
  与真机 beforeinput 不同构。需要精确删字符的判据用
  `Control+a + 重新输入` 的树替换形状（REM-05/REM-19 已证），别赌逐字符 Backspace；
  "部分编辑+标记残留"的真机形状在桌面 e2e 无法隔离复现，判据降级为行为最终一致。
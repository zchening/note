# tools —— 构建与维护脚本

本目录的脚本**不参与运行时**，不进 `www/` 产物，也不出现在 APK 里。
只服务于开发期的构建与验证。

## 构建（npm run build 走这条）

| 文件 | 作用 |
| --- | --- |
| `build.mjs` | esbuild 打成单文件 + `define` 注入 `__APP_VERSION__` / `__BUILD_DATE__`（唯一来源是根 `package.json`），产出 `www/app.js` 与 `www/index.html` |
| `sha.mjs` | 三端壳一致性校验：根 / `www/` / `android assets` 三份产物的 sha256 必须相同 |

## 发版

| 文件 | 作用 |
| --- | --- |
| `release-notes.mjs` | 每版更新要点（`releases/<tag>.md`）的**解析与校验唯一权威**：条数（4）/ 字数（24）/ 链接三类规则都在这里 |
| `check-release-notes.mjs` | 发版闸：缺 `releases/<tag>.md` 或不合规即非零退出。CI `test` 作业与本地自查都跑它 |
| `push_bj_apk.py` | 上传 APK + 落 `latest_app.json` + 线上校验。弹窗要点由它从 `releases/<tag>.md` 读入 `summary`（规则不在它这儿，见上两行） |
| `make_latest_app.py` | 手动补传 `latest_app.json` 的等价物（从 gh 读 Release 体积，要点同源） |

要点文件的写法与硬约束见 `releases/README.md`。

## 纪律

- 🔴 **版本号只从 `package.json` 来**，任何地方都不许写版本字面量。
  测试只许断言「产物版本 == package.json 版本」，出现字面量断言 = 评审打回。
- 🔴 **调试探针（`_probe*.mjs`）用完即删**。它们是为了单点取证临时写的，
  留在仓库里会腐烂（Lexical 一升级行为就变，写着"实测"其实已失效的注释比没有更糟）。
  探针里得到的关键结论要搬进正式代码的注释或测试用例，那两处才受测试保护。
- 构建脚本只允许标准库 + 已在 devDependencies 里声明的包。**不许 `npm i` 新包**。

## 加新脚本的判据

先问：这个脚本是"每次构建都要跑"（→ `build.mjs`）、"只在发版前跑"（→ 独立命令），
还是"只为了查一个 bug"（→ 探针，用完删）？第三类不进仓库。

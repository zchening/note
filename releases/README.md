# releases —— 每版更新要点（发版必填）

一个版本一个文件：`releases/vX.Y.Z.md`，**文件名必须与 git tag 逐字一致（含 `v`）**。

这份文件是**唯一真源**，同一份内容喂两条链路：

| 去向 | 取文件的哪部分 |
| --- | --- |
| App 的「检查更新」弹窗 | 前若干条 `- ` 行（最多 4 条） |
| `deploy/latest_app.json` 的 `body` | 整份文件 |
| GitHub Release 页正文 | 整份文件 |

## 格式

```markdown
### 更新内容

- 修复提醒偶发不响
- 同步底栏不再抖动
- 换机备份免输口令
- 图片不再显示成横线

更长的说明写在这里。这一段只出现在 GitHub Release 页和 App 弹窗的**回退路径**里，
不会挤进弹窗要点 —— 弹窗只取上面那几条 `- ` 行。
```

## 硬约束（CI 闸会拦，不合规直接红）

- 最多 **4** 条 `- ` 行（第 5 条起在手机上要滚动才看得到）
- 每条最多 **24** 个字符（360px 宽的手机上基本一行内）
- 项目符号只能是 `-`：客户端拿到的 summary 是**纯文本**，不剥 Markdown 前缀，用 `*` / `+` 一条都取不到
- 要点里不许出现链接（`http(s)://`、`compare/`、`[文字](链接)`）—— 那是给开发者看的行

## 什么时候写

**发版前**。CI 的 `test` 作业会跑 `node tools/check-release-notes.mjs <tag>`，缺文件或不合规 ⇒ 红 ⇒ 不出包。
`tools/push_bj_apk.py` 里还有一道硬失败（它可能被单独手动调用）。

本地自查：

```bash
"C:/Users/zchen/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" tools/check-release-notes.mjs v3.0.3
```
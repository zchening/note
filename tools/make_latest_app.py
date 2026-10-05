"""
生成 NoteSync BJ 的 App 升级元数据（latest_app.json）。

🔴🔴 为什么必须单独一个脚本、而不是"顺手 scp 一下"：
   App 查新版的唯一入口是 `GET /api/latest`，它读的是**服务器磁盘上**的那份
   APP_DIR/deploy/latest_app.json。而"部署网页 index.html"是另一件事、另一条链路。
   两者在**同一台机器、同一次部署动作**里也没有任何因果关系 ——
   老项目 v10.1.8 就是网页侧全绿、App 永远查不到新版，因为那份 json 压根没人传。
   （这就是 live e2e 里 LIVE-06 存在的原因。）
   ⇒ 这份文件的生成必须可重跑、可核对、且内容与 GitHub Release 严格一致。

用法：
    python _bj_latest_app.py --tag v1.0.0
    python _bj_latest_app.py --tag v1.0.0 --out ./latest_app.json
    python _bj_latest_app.py --print-only          # 只打印不上传

内容来源：用 gh API 读该 tag 的 Release（真实产物，绝不手填体积）。
手填 size 是最危险的：原生侧用 expectedBytes 判"下载完没"，size 填 0 或偏小，
截断的 APK 会被当已下完直接拉起安装器，报 packageInfo is null。
"""
import argparse
import json
import subprocess
import sys

REPO = "zchening/note"


def gh(args: list[str]) -> str:
    p = subprocess.run(
        ["gh"] + args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if p.returncode != 0:
        sys.exit("❌ gh 失败：" + (p.stderr or p.stdout).strip()[:400])
    return p.stdout


def build(tag: str) -> dict:
    ver = tag[1:] if tag.startswith("v") else tag
    # gh release view --json 的字段在 gh 各版本间会漂，缺的字段直接报出来而不是静默给空
    raw = gh(["release", "view", tag, "--repo", REPO, "--json",
              "tagName,name,body,isDraft,isPrerelease,assets,publishedAt"])
    rel = json.loads(raw)

    if rel.get("isDraft"):
        # 🔴 draft 的 Release 对外不可见，但文件一旦传上去 App 就会看到它 ——
        #   症状是用户点更新跳到一个 404 的下载链接。所以这里硬拦。
        sys.exit("❌ 这个 Release 还是 draft：对外不可见，传上去等于给用户一条死链。")

    apks = [a for a in rel.get("assets", []) if a.get("name", "").lower().endswith(".apk")]
    if not apks:
        # 🔴 没有 APK 时仍然生成 404 语义之外的内容会让 App 显示"已是最新"，
        #   而用户永远收不到更新。宁可不传（服务端回 404，App 显示"还没有可安装的新版本"）。
        sys.exit("❌ 这个 Release 没有 .apk 资产。不生成文件 —— "
                 "传一份内容不全的元数据比不传更坏（App 会显示已是最新）。")
    if len(apks) > 1:
        # 多个 APK 时客户端 pickApk 取第一个 —— 必须让"哪个是第一个"是确定的，
        #   而不是在客户端里靠数组顺序赌。
        sys.exit("❌ 有多个 .apk 资产，客户端只取第一个："
                 + ", ".join(a["name"] for a in apks))

    a = apks[0]
    size = int(a.get("size") or 0)
    if size <= 0:
        # 见文件头：size 不对会直接演变成"截断包被当已下完"
        sys.exit("❌ APK 资产的 size 为 0 或缺失，拒绝生成。")

    # body 字段名与老项目一致（body），客户端只读 body，不读 name
    return {
        "tag_name": rel.get("tagName") or tag,
        "name": rel.get("name") or ver,
        "body": rel.get("body") or "",
        "published_at": rel.get("publishedAt") or "",
        "prerelease": bool(rel.get("isPrerelease")),
        "assets": [
            {
                "name": a["name"],
                "browser_download_url": a["url"],
                "size": size,
                "content_type": a.get("contentType") or "application/vnd.android.package-archive",
                "download_count": a.get("downloadCount") or 0,
            }
        ],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True, help="形如 v1.0.0")
    ap.add_argument("--out", default="latest_app.json")
    ap.add_argument("--print-only", action="store_true", help="只打印，不落盘")
    args = ap.parse_args()

    doc = build(args.tag)
    text = json.dumps(doc, ensure_ascii=False, indent=2)

    if args.print_only:
        print(text)
        return

    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")
    a = doc["assets"][0]
    print("✅ 已生成 " + args.out)
    print("   tag= %s" % doc["tag_name"])
    print("   apk    %s" % a["name"])
    print("   size   %d 字节 (%.1f MB)" % (a["size"], a["size"] / 1048576))
    print("   url    %s" % a["browser_download_url"])


if __name__ == "__main__":
    main()

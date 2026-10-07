#!/usr/bin/env python3
# push_bj_apk.py — 把 bj 的 release APK 推上服务器并落latest_app.json（闭环 OTA）
#
# 用法（在**装有 Android SDK/JDK 的构建机**上，构建出 APK 之后跑）：
#     gradlew assembleRelease            # 产物： android/app/build/outputs/apk/release/app-release.apk
#     python tools/push_bj_apk.py v1.11.0            # 上传 + 落元数据 + 线上校验
#     python tools/push_bj_apk.py v1.11.0 --dry-run  # 只本地生成/校验，不碰服务器
#
# 🔴🔴 协议层照搬老项目 tools/push_latest_apk.py（biji 域那条已跑了十几版的链路），
#   但**换成 bj 的坐标**。以下是"照搬时必须知道的三处差异"：
#   ① 下载 URL 域：bj.xuyinji.com.cn/dl/vX.Y.Z.apk（不是 biji）
#   ② 服务器布局：老项目 APK 落APP_DIR/apk/，bj 的 /dl 路由读 **APP_DIR/deploy/apk/**
#      （bj 的 /api/latest 本来就指向 deploy/latest_app.json，OTA 元数据与 APK 同放 deploy/ 下）
#   ③ 不走 GitHub releases：老脚本从 gh api拉元数据；bj 直接本地组 JSON——
#      因为 bj 没在 GitHub 发过 Android release，也不需要（用户拍板"国内域名直下"）。
#
# 🔴🔴🔴 上传顺序必须**倒装**（老项目踩过并写进注释的坑，照抄）：
#   先 APK 文件（latest.apk 覆盖式 + vX.Y.Z.apk 不可变副本）全部就位，**最后**才落
#   latest_app.json。反序（先 json 后 apk）会在两次 put 之间让 /api/latest 指向一个
#   还不存在的 /dl/vX.Y.Z.apk ⇒ 全网手机点"更新"必404，且窗口期随上传耗时线性拉长。
#
# 🔴 版本固定名 /dl/vX.Y.Z.apk 永不覆盖：DownloadManager 会Range 分段续传，若下载
#   途中被新发版覆盖 latest.apk，手机会读到"新旧混装字节"⇒ packageInfo is null 死循环
#   （老项目 v9.5.4 的血泪）。所以 json 的 URL 永远指不可变的版本副本。
#
# 🔴 签名：与老项目一致**不额外准备keystore** —— Android 默认用 debug keystore 签
#   release，可装可OTA。唯一硬要求：同一台构建机（同一debug key）出包，签名一致才能
#   覆盖安装。换机器构建 ⇒ 签名不同 ⇒ 装不上（不是本脚本的锅，是 Android 规则）。

import os, sys, json, re, time, hashlib, subprocess

HOST = "124.221.92.225"
USER = "Administrator"
KEY = os.path.expanduser("~/.ssh/notesync_deploy")
BASE = "https://bj.xuyinji.com.cn"
# 🔴 APP_DIR 是 bj server 从__dirname 上溯三层算出的仓库根布局位置；/dl 路由与
#   /api/latest 都相对它取。REMOTE_DEPLOY 必须与服务端 deploy/ 目录一致。
REMOTE_DEPLOY = r"C:\Services\NoteSyncBj\deploy"
LOCAL_APK = os.path.join("android", "app", "build", "outputs", "apk", "release", "app-release.apk")

SSH_OPTS = ["-i", KEY, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
            "-o", "ConnectTimeout=20", "-o", "StrictHostKeyChecking=accept-new"]


def _run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace", **kw)


def ssh_run(cmd, tries=3):
    last = ""
    for i in range(tries):
        r = _run(["ssh"] + SSH_OPTS + ["%s@%s" % (USER, HOST), cmd])
        if r.returncode == 0:
            return (r.stdout or "").strip()
        last = (r.stderr or r.stdout or "").strip()
        time.sleep(3 * (i + 1))
    sys.exit("[ssh] 远端命令失败（%s…）：%s" % (cmd[:60], last))


def scp_put(local, remote, tries=3):
    last = ""
    for i in range(tries):
        r = _run(["scp", "-q"] + SSH_OPTS + [local, "%s@%s:%s" % (USER, HOST, remote)])
        if r.returncode == 0:
            return
        last = (r.stderr or "").strip()
        time.sleep(3 * (i + 1))
    sys.exit("[scp] 上传失败 %s → %s：%s" % (local, remote, last))


def remote_size(path):
    return int(ssh_run("powershell -NoProfile -Command \"(Get-Item '%s').Length\"" % path.replace("/", "\\")))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def versioned_dl_url(tag):
    return "%s/dl/%s.apk" % (BASE, tag)


def build_latest_json(tag, apk_size):
    #字段与 GitHub API 同形（客户端 ota.ts 只认 assets[].name/.browser_download_url/.size）
    return {
        "assets": [{
            "browser_download_url": versioned_dl_url(tag),
            "name": "app-release.apk",
            "size": apk_size,
        }],
        "summary": [],
        "body": "## %s\n\n（bj release，由 push_bj_apk.py 落地）" % tag,
        "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tag_name": tag,
    }


def main():
    dry = "--dry-run" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    tag = args[0]
    if not tag.startswith("v"):
        tag = "v" + tag

    if not os.path.isfile(LOCAL_APK):
        sys.exit("找不到构建产物 %s\n"
                 "请先在**装有 Android SDK + JDK** 的机器上执行：\n"
                 "  cd android && gradlew assembleRelease\n"
                 "（本仓库构建机无 Java/SDK，无法在此产出 APK）" % LOCAL_APK)

    size = os.path.getsize(LOCAL_APK)
    local_sha = sha256(LOCAL_APK)
    meta = build_latest_json(tag, size)
    meta_local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "latest_app.json")
    with open(meta_local, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print("[pre] tag=%s apk=%d bytes sha256=%s" % (tag, size, local_sha[:16]))
    print("[pre] 下载 URL = %s" % meta["assets"][0]["browser_download_url"])
    print("[pre] 已生成 %s" % meta_local)

    if dry:
        print("[dry-run] 未碰服务器。去掉 --dry-run 即上传。")
        return

    # 远端目录（deploy/ 与 deploy/apk/）
    ssh_run('if not exist "%s" mkdir "%s"' % (REMOTE_DEPLOY, REMOTE_DEPLOY))
    ssh_run('if not exist "%s\\apk" mkdir "%s\\apk"' % (REMOTE_DEPLOY, REMOTE_DEPLOY))

    # 🔴🔴 倒装顺序：两个 APK 先就位，latest_app.json 最后落。
    #   latest.apk 覆盖式（旧壳/手输链接兼容）
    remote_latest = REMOTE_DEPLOY + r"\apk\latest.apk"
    print("[srv] 上传 apk/latest.apk …")
    scp_put(LOCAL_APK, remote_latest)
    rs = remote_size(remote_latest)
    print("[srv] apk/latest.apk local=%d remote=%d %s" % (size, rs, "OK" if rs == size else "MISMATCH!!"))
    if rs != size:
        sys.exit("latest.apk 大小对不上，中止（不落 json，避免 404 窗口）")

    # 不可变版本副本 —— json 的 URL 指它
    remote_ver = REMOTE_DEPLOY + "\\apk\\%s.apk" % tag
    print("[srv] 上传 apk/%s.apk（不可变副本）…" % tag)
    scp_put(LOCAL_APK, remote_ver)
    rv = remote_size(remote_ver)
    print("[srv] apk/%s.apk remote=%d %s" % (tag, rv, "OK" if rv == size else "MISMATCH!!"))
    if rv != size:
        sys.exit("版本副本大小对不上，中止")

    # 最后落 latest_app.json（备份旧版）
    remote_json = REMOTE_DEPLOY + r"\latest_app.json"
    ssh_run('if exist "%s" copy /y "%s" "%s.bak_%s" >nul' % (remote_json, remote_json, remote_json, str(int(time.time()))))
    print("[srv] 落 deploy/latest_app.json …")
    scp_put(meta_local, remote_json)

    # ===== 线上校验（不查就等于没发布）=====
    # 🔴🔴 校验必须**断言**，不能只 print 状态码 —— 只打印的话，"校验"这一步
    #   在脚本眼里永远是绿的，失败要等人肉看日志才发现。
    #   也不用 curl -w "%{http_code}"：实测在远端 cmd 下它会报 "no URL specified"
    #   （%{} 被吃掉）。改读 HEAD 响应头里的状态行，稳定且不依赖格式化占位符。
    print("[verify] /api/latest …")
    api = ssh_run('curl -s %s/api/latest' % BASE)
    try:
        j = json.loads(api)
        url = j["assets"][0]["browser_download_url"]
        print("[verify] /api/latest -> %s（tag=%s）" % (url, j.get("tag_name")))
        if tag not in url:
            sys.exit("线上 json的 URL 未指向本版 %s，中止" % tag)
        # 🔴 客户端 pickApk 只认 name 以 .apk 结尾 + browser_download_url + size。
        #   name 写错一个字符，App 侧就是"no-apk"，而服务端这边看着一切正常。
        if not j["assets"][0]["name"].lower().endswith(".apk"):
            sys.exit("assets[0].name 不是 .apk 结尾 ⇒ 客户端 pickApk 会判 no-apk：%r"
                     % j["assets"][0]["name"])
        if int(j["assets"][0]["size"]) != size:
            sys.exit("assets[0].size=%s 与实际上传 %d 不一致 ⇒ 下载进度条会算错"
                     % (j["assets"][0]["size"], size))
    except Exception as e:
        # 🔴 sys.exit 抛的是 SystemExit（BaseException），不会被这里的 except Exception
        #   吞掉，所以上面那几条 sys.exit 不需要额外保护。别加except SystemExit: raise，
        #   那是死代码（写它的时候误以为 SystemExit 是 Exception）。
        sys.exit("线上 /api/latest 解析失败：%s（原文：%s…）" % (e, api[:120]))

    for u in (versioned_dl_url(tag), BASE + "/dl/latest.apk"):
        head = ssh_run('curl -s -I %s' % u)
        m = re.search(r'HTTP/\d(?:\.\d)?\s+(\d{3})', head)
        code = m.group(1) if m else '???'
        print("[verify] HEAD %s -> %s" % (u, code))
        if code != '200':
            sys.exit("🔴 %s 返回 %s，不是 200 —— json 已指向不可下载的 APK，全网用户会点更新失败。"
                     "（json 是最后落的，此时APK 应已就位，故此处的 404/5xx 意味着上传没真正到位）" % (u, code))

    print("\n完成。下次 App 点「检查更新」将从 %s 直下该 APK。" % BASE)


if __name__ == "__main__":
    main()

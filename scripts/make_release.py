# -*- coding: utf-8 -*-
"""为已推送的 tag 创建 GitHub Release 并上传安装包。

为什么不放在 gh CLI：本机没有 gh，凭据在 git-credential-manager 里（classic PAT，
40 字符）。直接走 REST API，token 从凭据助手取、不落盘、不打印。

幂等：已存在的 release 不会重复创建；资产若已存在同名则跳过（GitHub 会对同名资产
返回 422，直接重跑会失败，故先查再传）。

用法：python scripts/make_release.py v0.1.2 "标题" "正文.md"
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = "alfred-yu/codedocbench"
API = "https://api.github.com/repos/" + REPO
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_token():
    """从 git 凭据助手取 token（不经环境变量、不打印、不落盘）。"""
    p = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True,
        text=True,
    )
    for line in p.stdout.splitlines():
        if line.startswith("password="):
            return line[9:]
    raise SystemExit("凭据助手未返回 token")


TOKEN = get_token()


def api(method, url, data=None, raw=None, content_type=None):
    headers = {
        "Authorization": "Bearer " + TOKEN,
        "User-Agent": "codedocbench-release",
    }
    # uploads.github.com 对 Accept 的要求与 api.github.com 不同：
    # 二进制上传只能发 */*，带 vnd 头会被拒（故按主机区分）。
    if "uploads.github.com" not in url:
        headers["Accept"] = "application/vnd.github+json"
    body = None
    if raw is not None:
        body = raw
        headers["Content-Type"] = content_type or "application/octet-stream"
    elif data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())


def existing_assets(rel_url):
    """列已有资产。资产端点挂在 release 自身的 url 上（/releases/{id}/assets），
    不能用仓库级固定路径 —— 那个路径不存在，会404。"""
    return {a["name"] for a in api("GET", rel_url + "/assets")}


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    tag, name = sys.argv[1], sys.argv[2]
    body = open(sys.argv[3], encoding="utf-8").read() if len(sys.argv) > 3 else ""

    # 资产清单：优先取构建产物目录，回退到 docs/releases
    # 文件名不带 "v" 前缀（CodeDocBench_0.1.2_...），tag 带（v0.1.2），故匹配时去掉 v
    ver = tag[1:] if tag.startswith("v") else tag
    cands = []
    b = os.path.join(ROOT, "src-tauri/target/release/bundle")
    for sub in ("msi", "nsis"):
        d = os.path.join(b, sub)
        if os.path.isdir(d):
            for f in sorted(os.listdir(d)):
                if ver in f and f.endswith((".msi", "-setup.exe")):
                    cands.append(os.path.join(d, f))
    rel_dir = os.path.join(ROOT, "docs/releases")
    if os.path.isdir(rel_dir):
        for f in sorted(os.listdir(rel_dir)):
            if ver in f and f.endswith((".msi", "-setup.exe")):
                cands.append(os.path.join(rel_dir, f))
    if not cands:
        raise SystemExit("未找到与 " + tag + " 匹配的安装包")

    # 1) release 元数据（已存在则复用，不重复创建）
    url = API + "/releases/tags/" + tag
    try:
        rel = api("GET", url)
        print("[skip] release 已存在:", rel["html_url"])
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        rel = api(
            "POST",
            API + "/releases",
            {
                "tag_name": tag,
                "name": name,
                "body": body,
                "draft": False,
                "prerelease": False,
            },
        )
        print("[ok] release 已创建:", rel["html_url"])

    # 2) 资产上传（先查后传，避免同名 422）
    #    关键：列表在 api.github.com，上传在 uploads.github.com —— release 自带的
    #    upload_url 是 "…/assets{?name,label}" 模板，两个主机不同。往 api.github.com
    #    POST 会404（实测踩过）。故取 upload_url 去掉尾部 "{?name,label}" 再拼查询串。
    rel_url = rel["url"]
    have = existing_assets(rel_url)
    upload = rel["upload_url"].split("{")[0] + "?name="
    ok = 0
    for path in cands:
        fn = os.path.basename(path)
        if fn in have:
            print("[skip] 资产已存在:", fn)
            ok += 1
            continue
        data = open(path, "rb").read()
        print("[upload]", fn, "%.1f MB" % (len(data) / 1048576))
        try:
            api("POST", upload + urllib.parse.quote(fn), raw=data,
                content_type="application/octet-stream")
            print("   ok")
            ok += 1
        except urllib.error.HTTPError as e:
            # 单个资产失败不吞掉已成功的部分：报出来，退出码非 0，重跑幂等补齐
            body = e.read().decode(errors="replace")[:200]
            print("   失败:", e.code, body)

    print("[done] %d/%d 资产就绪 → %s" % (ok, len(cands), rel["html_url"]))
    return 0 if ok == len(cands) else 1


if __name__ == "__main__":
    sys.exit(main())
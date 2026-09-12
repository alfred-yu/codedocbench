# 生成浏览器演示模式的模拟数据（demo/mock.js）
# 数据来自真实 PDTManager 项目的扫描与解析结果，仅用于文档截图与演示。
import json
import base64
import subprocess
import sys
import os

ROOT = r"C:\Users\Administrator\Desktop\PDTManager"
BACKEND = os.path.join("python", "backend.py")


def call(mode, path):
    out = subprocess.run(
        [sys.executable, BACKEND, mode, path], capture_output=True, text=True, encoding="utf-8"
    )
    return json.loads(out.stdout)


def main():
    tree = call("scan_dir", ROOT)
    parses = {}

    def walk(n):
        if n.get("type") == "file":
            parses[n["path"]] = call("parse_file", n["path"])
        for c in n.get("children", []):
            walk(c)

    walk(tree)

    llr_b64 = base64.b64encode(
        open(os.path.join(ROOT, "PDT_LLR_Requirements.xlsx"), "rb").read()
    ).decode()

    js = (
        "// 浏览器演示模式：为无 Tauri 环境提供模拟后端（用于用户手册截图与功能演示）。\n"
        "// 真实桌面运行时 Tauri 会先注入 __TAURI_INTERNALS__，本文件自动失效。\n"
        "(function () {\n"
        "  if ('__TAURI_INTERNALS__' in window) return;\n"
        "  const DEMO_DIR = 'C:\\\\Users\\\\Administrator\\\\Desktop\\\\PDTManager';\n"
        "  const TREE = " + json.dumps(tree, ensure_ascii=False) + ";\n"
        "  const PARSES = " + json.dumps(parses, ensure_ascii=False) + ";\n"
        "  const LLR_B64 = " + json.dumps(llr_b64) + ";\n"
        "  const MT = 1735689600000;\n"
        "  window.__TAURI_INTERNALS__ = {\n"
        "    invoke: async (cmd, args) => {\n"
        "      switch (cmd) {\n"
        "        case 'scan_dir':\n"
        "          return JSON.parse(JSON.stringify(TREE));\n"
        "        case 'parse_file':\n"
        "          return PARSES[args.path] || { type: 'error', message: '文件不存在: ' + args.path };\n"
        "        case 'file_mtime':\n"
        "          return MT;\n"
        "        case 'read_file': {\n"
        "          const bin = atob(LLR_B64);\n"
        "          return Uint8Array.from(bin, (c) => c.charCodeAt(0));\n"
        "        }\n"
        "        case 'save_file':\n"
        "          return null;\n"
        "        case 'plugin:dialog|open':\n"
        "          return args && args.options && args.options.directory\n"
        "            ? DEMO_DIR\n"
        "            : DEMO_DIR + '\\\\PDT_LLR_Requirements.xlsx';\n"
        "        case 'plugin:dialog|save':\n"
        "          return DEMO_DIR + '\\\\代码文档_演示.xlsx';\n"
        "        default:\n"
        "          return null;\n"
        "      }\n"
        "    },\n"
        "  };\n"
        "})();\n"
    )
    os.makedirs("demo", exist_ok=True)
    with open(os.path.join("demo", "mock.js"), "w", encoding="utf-8") as f:
        f.write(js)
    print("mock.js written:", os.path.getsize(os.path.join("demo", "mock.js")), "bytes; parsed files:", len(parses))


if __name__ == "__main__":
    main()

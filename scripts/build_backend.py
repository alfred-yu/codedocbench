#!/usr/bin/env python3
"""Freeze python/backend.py into a directory-style executable via PyInstaller.

The frozen binary is self-contained (embeds the Python runtime + stdlib), so
end-user machines do NOT need Python installed. This runs automatically via the
`freeze:backend` npm script, which `tauri build` invokes before bundling.

backend.py only uses the Python standard library (json/os/re/sys), so the
resulting binary has no third-party dependencies.

实现要点（避免触发开发机的安全删除拦截）：
  - PyInstaller 全程只向「每次全新的临时目录」写，绝不删除任何已存在目录；
  - 产物再用 copytree(dirs_exist_ok=True) 覆盖写入最终位置 python/dist/backend，
    覆盖写不会触发批量删除确认。
"""
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "python", "backend.py")
FINAL_DIR = os.path.join(ROOT, "python", "dist", "backend")  # 最终落点

# 全新临时目录：distpath 与 workpath 都每次新建，避免 PyInstaller 删除「已存在目录」
tmp_dist = tempfile.mkdtemp(prefix="codedoc_freeze_dist_")
tmp_work = tempfile.mkdtemp(prefix="codedoc_build_")

name = "backend"  # 目录名固定为 backend，Rust 端 resolve_backend 据此查找

cmd = [
    sys.executable,
    "-m",
    "PyInstaller",
    "--onedir",
    "--name",
    name,
    "--distpath",
    tmp_dist,
    "--workpath",
    tmp_work,
    "--specpath",
    tmp_work,
    SRC,
]

print(f"[build_backend] {' '.join(cmd)}")
subprocess.check_call(cmd)

src_dir = os.path.join(tmp_dist, name)
print(f"[build_backend] copying {src_dir} -> {FINAL_DIR}")
shutil.copytree(src_dir, FINAL_DIR, dirs_exist_ok=True)

out_name = name + (".exe" if os.name == "nt" else "")
print(f"[build_backend] frozen binary -> {os.path.join(FINAL_DIR, out_name)}")

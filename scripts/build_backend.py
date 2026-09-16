#!/usr/bin/env python3
"""Freeze python/backend.py into a single-file executable via PyInstaller.

The frozen binary is self-contained (embeds the Python runtime + stdlib), so
end-user machines do NOT need Python installed. This runs automatically via the
`freeze:backend` npm script, which `tauri build` invokes before bundling.

backend.py only uses the Python standard library (json/os/re/sys), so the
resulting binary has no third-party dependencies and is ~8 MB on Windows.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "python", "backend.py")
DIST = os.path.join(ROOT, "python", "dist")
WORK = os.path.join(ROOT, ".pyinstaller_build")

# Windows -> backend.exe, others -> backend
name = "backend"

cmd = [
    sys.executable,
    "-m",
    "PyInstaller",
    "--onedir",
    "--name",
    name,
    "--distpath",
    DIST,
    "--workpath",
    WORK,
    "--specpath",
    WORK,
    "--clean",
    SRC,
]

print(f"[build_backend] {' '.join(cmd)}")
subprocess.check_call(cmd)

out_name = name + (".exe" if os.name == "nt" else "")
print(f"[build_backend] frozen binary -> {os.path.join(DIST, out_name)}")

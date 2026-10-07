# 协作偏好(ZCode 指令)

> 仓库已于 2026-10-07 迁移至 GitHub：`https://github.com/alfred-yu/codedocbench.git`，
> 默认分支为 **`main`**（不是 `master`）。推送一律用 `origin/main`。

- 每完成一批功能或修复改动并验证通过后,默认**直接提交并推送到远端 `origin/main`**,无需等待用户逐次指示。
- 提交信息使用中文,首行概括改动要点,正文分条说明关键变化。
- 提交前确保验证通过。**纯 UI 改动不能只跑 `npm run build`**——它不报未声明标识符，
  必须补 `npm run smoke`（构建 + 界面冒烟 + 分片/一致性校验回归）。
  Python 解析器改动必须跑 `python -m pytest tests/`。
- 提交前用 `git status` 确认 `dist/`、`src-tauri/target/`、`python/dist/` 等构建产物未被暂存（已在 `.gitignore`）。
- 推送后复核：`git rev-list --count origin/main..HEAD` 必须为 0（远端偶发误报，不能只看 push 输出）。

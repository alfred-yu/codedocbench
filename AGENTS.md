# 协作偏好(ZCode 指令)

> 仓库已于 2026-10-07 迁移至 GitHub：`https://github.com/alfred-yu/codedocbench.git`，
> 默认分支为 **`main`**（不是 `master`）。推送一律用 `origin/main`。

- 每完成一批功能或修复改动并验证通过后,默认**直接提交并推送到远端 `origin/main`**,无需等待用户逐次指示。
- 提交信息使用中文,首行概括改动要点,正文分条说明关键变化。
- 提交前确保验证通过。**纯 UI 改动不能只跑 `npm run build`**——它不报未声明标识符，
  必须补 `npm run smoke`（构建 + 界面冒烟 + 分片/一致性校验回归）。
  **改动样式类时还必须补 CDP 真实浏览器验证**：DOM stub 只证明代码写进了 `innerHTML`，
  证明不了用户看得见（样式类写错、被更高优先级规则覆盖、容器裁切，stub 全都测不出来）。
  脚本：`scripts/cdp_verify_{gen,p2,invalid}.mjs`。
  Python 解析器改动必须跑 `python -m pytest tests/`。
- 提交前用 `git status` 确认 `dist/`、`src-tauri/target/`、`python/dist/` 等构建产物未被暂存（已在 `.gitignore`）。
- 推送后复核：`git rev-list --count origin/main..HEAD` 必须为 0（远端偶发误报，不能只看 push 输出）；
  推 tag 后用 `git ls-remote --tags origin` 复核。
- **安装包不入库**，统一由 GitHub Release 承载：`python scripts/make_release.py vX.Y.Z "标题" docs/release-notes-vX.Y.Z.md`（幂等，可重跑补齐）。
- 网络代理偶发掐断 git 的 TLS（`schannel: server closed abruptly` / `CONNECT tunnel failed 502`），重试即可；
  判断是否真不通用 `curl -o /dev/null -w "%{http_code}" https://api.github.com/repos/alfred-yu/codedocbench`。

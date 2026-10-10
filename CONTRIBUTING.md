# 贡献指南

感谢关注 MAW（moys-asr-workflow）！

## 提交 PR 前

1. **签署 CLA**：本项目采用 [CLA Assistant](https://cla-assistant.io/) 管理。首次提 PR 时机器人会自动请求你确认，在 PR 中回复：

   ```
   I have read the CLA Agreement and agree to it
   ```

   即完成签署（一次签署，后续 PR 自动识别）。协议全文见 [`CLA.md`](CLA.md)。

   为什么需要：项目采用 AGPL-3.0 + 商业许可双许可模式，需要贡献者授权项目所有者以任意许可分发其贡献，详见 CLA.md 说明。

2. Fork → 分支开发 → 提交 PR，commit 信息用简短中文或英文说明改动实质。

## 代码风格

- Python：遵循现有代码风格；安装环境后使用 `uv run --no-sync python -m unittest discover -s tests -p "test_*.py"`。
- 前端（web/）：LF 换行，保持既有缩进风格

所有文本使用 UTF-8 与 LF。前端装配检查、类型检查与浏览器回归见 [开发概览](docs/DEVELOPMENT.md)。

## 编辑器前端构建

编辑器 JS 由 esbuild 打包；Server 和便携 HTML 读取仓库已提交的 bundle，不再运行时拼接 JS 源文件。只运行现有编辑器不需要 Node，也不必每次启动都构建；开发构建与 Node 测试要求 Node 22.13+。

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile # 首次准备或开发依赖变化后
pnpm run build:editor          # 编辑器 JS、清单或构建配置变化后
pnpm run check:editor          # 提交及发布打包前检查产物新鲜度
```

Windows 频繁开发可用一个命令完成首次构建、启动 JS watcher 和 Python Server（环境先由 `uv sync`、`pnpm install --frozen-lockfile` 准备）：

```sh
pnpm run dev
# 用 -- 把工程路径和 Server 参数传给开发脚本
pnpm run dev -- "project.mosp" --port 8251
```

`pnpm run dev` 复用 `scripts/dev-editor.ps1`，当前是 Windows / PowerShell 开发入口；其他系统仍可分别运行 `pnpm run watch:editor` 和 Python Server。

不带参数时默认空白启动；修改 JS 后自动重建，刷新浏览器查看结果，Ctrl+C 结束开发会话并清理 watcher。脚本不生成 `blank-editor.html`、不自动同步依赖；修改 Python 后仍需停止并重新运行脚本。生命周期检查可运行 `powershell -NoProfile -File tests/test_dev_editor.ps1`。

- 修改编辑器 JS 后必须重建，刷新或重启 Server 不会自动打包；持续调试也可另开 `pnpm run watch:editor`。
- 源码与 `web/editor/boot/editor-bundle.js`、`web/editor/boot/editor-bundle.meta.json` 一起提交；不要手改生成产物。
- `pnpm run check:editor` 只读检查，不会自动修复；产物过期时 CI 会失败。
- CSS / HTML 模板修改在 Server 模式下刷新即可生效，不需要重新打包 JS。
- `blank-editor.html` 是另一份便携 HTML 产物，日常不要重生成。PR 注明「内联副本待发布前统一重生成」；仅在发布检查或维护者明确要求时，先确认 bundle 最新，再运行 `uv run --no-sync python edit.py --blank`。

## 许可

- 提交即表示你的贡献同意按 [`CLA.md`](CLA.md) 授权
- 项目本体许可证：AGPL-3.0-only（见 [`LICENSE`](LICENSE)）

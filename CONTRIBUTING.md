# 贡献指南

版本边界：下文独立 HTML / 在线编辑器的生成步骤仅适用于 1.x。2.0（含预发布版）起停止生成、打包和部署；历史文件保留。本地 Server 与共享 Web 前端继续维护，推荐下载本地应用。Pages 使用 `scripts/prepare_editor_pages.py` 执行版本策略，不直接调用旧生成命令。

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

文档分类、稳定入口、临时输出与退役遵循[文档约定](docs/README.md#doc-policy)。文档变更在根目录运行 `python scripts/check_docs.py`；新增检查的回归使用 `python scripts/run_tests.py tests/test_docs_check.py`。Agent 执行时按根规则用 `scripts/run_check.py` 包装命令。

- Python：遵循现有代码风格；安装环境后使用 `uv run --no-sync python scripts/run_tests.py`。
- 前端（web/）：LF 换行，保持既有缩进风格
- 并行测试：`python scripts/run_tests.py --parallel N` 按文件多进程执行。bundle 产物缺失时跨进程锁会保证多个 worker 只自动构建一次，但首个触发构建的 worker 会被同步拖慢；建议首次在新建 worktree / clone 上使用前先完成一次 `pnpm install --frozen-lockfile && pnpm run build`。

所有文本使用 UTF-8 与 LF。前端装配检查、类型检查与浏览器回归见 [开发概览](docs/INDEX.md#engineering-development)。

## 编辑器前端构建

编辑器 JS 由 esbuild 打包；Server 和便携 HTML 读取本地生成的 bundle，不再运行时拼接 JS 源文件。从源码运行需要 Node 22.13+ 与 pnpm，首次安装依赖时自动构建；后续启动检查新鲜度，仅在产物缺失或过期时重建。发布包内置 bundle，用户无需 Node。

在仓库根目录执行：

```sh
pnpm install --frozen-lockfile # 首次准备或开发依赖变化后
pnpm run build:editor          # 编辑器 JS、清单或构建配置变化后
pnpm run check:editor          # 提交及发布打包前检查产物新鲜度
```

频繁开发可用一个命令完成首次构建、启动 JS watcher 和 Python 入口（环境先由 `uv sync`、`pnpm install --frozen-lockfile` 准备）。入口跨平台（Windows / macOS / Linux），由 `scripts/dev-session.mjs` 驱动：

```sh
pnpm run dev            # 编辑器开发会话（dev:editor 的默认别名）
pnpm run dev:launcher   # Launcher 开发会话
pnpm run devl           # dev:launcher 的短别名
```

用 `--` 把工程路径和 Server 参数传给 Python 入口，例如 `pnpm run dev -- "project.mosp" --port 8251`。

会话先完整构建一次 bundle，再挂 watcher，最后运行 `uv run --no-sync python server-editor/serve.py`（编辑器，不带参数时默认空白启动；透传任意参数如 `-- -p 8258` 可改为固定端口并恢复上次工程）或 `uv run --no-sync python maw_gui.py`（Launcher，默认带 `--debug` 开启 pywebview 调试；`-- --devtools` 可在启动后自动打开 DevTools）。修改 JS 后自动重建，刷新浏览器查看结果；Ctrl+C 结束开发会话并清理 watcher。脚本不生成 `blank-editor.html`、不自动同步依赖；修改 Python 后仍需停止并重新运行。生命周期由 `node --test tests/test_dev_session.mjs` 守护。

只想用最新代码跑一次、不挂 watcher 时：

```sh
pnpm run launcher       # 构建 Launcher bundle 后打开 maw_gui.py
pnpm run editor         # 构建编辑器 bundle 后启动 server-editor/serve.py
```

两者同样支持 `--` 透传参数，如 `pnpm run editor -- "project.mosp" --port 8251`。

- 修改编辑器 JS 后需要重建：持续调试用 `pnpm run watch:editor` 或 `pnpm run dev`；直接刷新 Server 页面也会触发自动重建（serve.py 渲染前校验产物新鲜度）。
- bundle 与 `.meta.json` 是构建产物，不进 Git（.gitignore 已忽略）；不要手改生成产物。
- `pnpm run check:editor` 只读检查，不会自动修复；产物过期时 CI 会失败。
- CSS / HTML 模板修改在 Server 模式下刷新即可生效，不需要重新打包 JS。
- `blank-editor.html` 是另一份便携 HTML 产物，日常不要重生成。PR 注明「内联副本待发布前统一重生成」；仅在发布检查或维护者明确要求时，先确认 bundle 最新，再运行 `uv run --no-sync python edit.py --blank`。

## 许可

- 提交即表示你的贡献同意按 [`CLA.md`](CLA.md) 授权
- 项目本体许可证：AGPL-3.0-only（见 [`LICENSE`](LICENSE)）

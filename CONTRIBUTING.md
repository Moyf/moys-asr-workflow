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
3. 提交 PR 前，确认 PR 的目标分支（base branch），fetch 后将最新目标分支合并到当前分支并解决冲突。目标为 `main` 时同步 `origin/main`，目标为 `2.0dev` 时同步 `origin/2.0dev`，不要固定合并 main 或擅自更改目标分支。

## 代码风格

文档分类、稳定入口、临时输出与退役遵循[文档约定](docs/README.md#doc-policy)。文档变更在根目录运行 `python scripts/check_docs.py`；新增检查的回归使用 `python scripts/run_tests.py tests/test_docs_check.py`。Agent 执行时按根规则用 `scripts/run_check.py` 包装命令。

- Python：遵循现有代码风格；安装环境后使用 `uv run --no-sync python scripts/run_tests.py`。
- 前端（web/）：LF 换行，保持既有缩进风格
- 并行测试：`python scripts/run_tests.py --parallel N` 按文件多进程执行。bundle 产物缺失时跨进程锁会保证多个 worker 只自动构建一次，但首个触发构建的 worker 会被同步拖慢；建议首次在新建 worktree / clone 上使用前先完成一次 `pnpm install --frozen-lockfile && pnpm run build`。

所有文本使用 UTF-8 与 LF。前端装配检查、类型检查与浏览器回归见 [开发概览](docs/INDEX.md#engineering-development)。

## 编辑器前端构建

编辑器与 Launcher 的 JS 由 esbuild 打包，bundle 与 `.meta.json` 不进 Git；Server 与便携 HTML 读取本地生成的产物，不再运行时拼接源文件。从源码运行需要 Node（版本以 `package.json` 的 `engines` 为准）与 pnpm，首次 `pnpm install --frozen-lockfile` 会自动构建；发布包内置产物，用户无需 Node。

- 改了编辑器 JS、清单或构建配置：`pnpm run build:editor`；改 Launcher：`pnpm run build:launcher`。提交与打包前用 `pnpm run check:editor` / `check:launcher` 校验新鲜度（只读，不会修复）。
- 持续开发：`pnpm run dev`（编辑器）或 `pnpm run dev:launcher`（Launcher），会先构建、再挂 watcher 并启动 Python 入口；用 `--` 透传参数，如 `pnpm run dev -- "project.mosp" --port 8251`。监听、退出与「只用最新代码跑一次」的方式见[分层调试的开发入口](docs/engineering/DEBUG_WORKFLOW.md#开发入口与-bundle)。
- CSS / HTML 模板按请求读取，修改后刷新即可，不需要重新打包 JS。
- `blank-editor.html` 是便携产物，日常不要重生成；PR 注明「内联副本待发布前统一重生成」，仅在发布检查或维护者明确要求时运行 `uv run --no-sync python edit.py --blank`。
- 源码结构与构建契约见[开发概览](docs/engineering/DEVELOPMENT.md#编辑器源码地图)。

## 许可

- 提交即表示你的贡献同意按 [`CLA.md`](CLA.md) 授权
- 项目本体许可证：AGPL-3.0-only（见 [`LICENSE`](LICENSE)）

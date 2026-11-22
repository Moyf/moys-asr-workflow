# 2.0dev 版本准备

在仓库根目录操作。先确认本次目标版本、目标分支与授权范围。

1. 修改 `pyproject.toml` 的 `[project].version`。运行 `uv lock` 更新 `uv.lock` 中的 `moys-asr-workflow` 项，再用 `uv lock --check` 核对。锁文件按 PEP 440 规范化版本，例如 `2.0.0-beta.2` 写为 `2.0.0b2`。检查锁文件 diff，依赖升级按另行确认的范围处理。
2. 运行版本同步脚本。它更新 Launcher HTML、mock API、`maw/diagnostics.py` 与 `edit.py` 的打包回退版本。

   ```powershell
   uv run --no-sync python scripts/sync_launcher_version.py --write
   uv run --no-sync python scripts/sync_launcher_version.py --check
   ```

3. 打包回归会读取 Editor 和 Launcher 的 bundle。在已备齐依赖的环境运行 `pnpm run build` 和 `pnpm run check:launcher`，再按[有界执行入口](../../engineering/DEBUG_WORKFLOW.md#有界执行入口)运行版本和入口回归。

   ```powershell
   uv run --no-sync python scripts/run_check.py --timeout 180 -- uv run --no-sync python scripts/run_tests.py tests/test_editor_entry_retirement.py tests/test_editor_entry_review.py
   ```

   保留入口回归中固定的 1.x 和 beta 样例。`tests/test_editor_entry_review.py` 的打包负例 `test_packaging_refuses_unsynchronized_metadata_before_analysis` 从工作树复制回退值，版本变更时核对它能否找到标记并构造版本不一致。2.0（含预发布版）只维护本地应用编辑入口，打包和 Pages 按[版本边界](../../engineering/DEVELOPMENT.md#独立编辑入口的版本边界)检查。

仅改软件版本可在本地检查完成后交付。进入正文准备时，从 CHANGELOG 中定位目标标题，再读 [beta / rc 正文](../README.md#预发布正文)或[正式版归档](../README.md#正式版归档)。正式补丁继续核对[系列基础版本](../README.md#小版本保留系列大更新)。

软件版本和预览只说明准备状态。提交、推送、打 tag、发布分别按维护者授权执行。上线时按[发布验收](../README.md#发布顺序与恢复)核对公开结果，实际发布成功后再更新[日志基线](../../logs/INDEX.md)。

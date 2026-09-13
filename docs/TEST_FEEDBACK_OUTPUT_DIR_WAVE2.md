# Launcher 文件输出设置 + RTF 重命名 波 2 实施记录

任务：打通 Launcher「通用 → 文件输出」4 选项的 UI→.env→生效链路；
`default_srt_path` 支持子文件夹与「附加模型名称」；转写后按 MAW_STAT 重命名
srt/mosp/edit.html；批量清单与 GUI 侧 edit.html 进 `_maw`；前端镜像同步。
基线：波 1（`maw/output_naming.py` 只读）已完成。不运行 `edit.py --blank`。

## 事实基线（代码为准，2026-09 探明）

- `EffectiveConfig` 无 4 个文件输出字段；`output_naming.subfolder_prefs()` 已
  按 `config.output_subfolder` / `config.per_video_subfolder` 读取（缺字段抛
  AttributeError 前会回退 False，但 GUI 不配置时行为等同默认）。
- `default_srt_path` 始终附加模型段、输出在媒体旁；`build_output_paths` 的
  edit.html 与 srt 同目录；`run_transcription` 用 `request.srt_path` 推导全部
  产物路径，不改名。
- 批量 manifest 默认目录 = `first_request.srt_path.parent`（媒体旁）；
  gui_web / launcher_batch 各有重复的 `_artifact_paths` / `_batch_unique_output_path`。

## 决策

| 项 | 处理 |
|---|---|
| 4 个 GUI 开关 | `MAW_GUI_OUTPUT_SUBFOLDER` / `MAW_GUI_PER_VIDEO_SUBFOLDER` / `MAW_GUI_ATTACH_MODEL_NAME`(默认 true) / `MAW_GUI_ATTACH_RTF_RATE` 全部 bool；env 空值按默认。 |
| GUI edit.html | 只要提供 `media_path`，一律落 `output_naming.maw_root(media)`（含 output_subfolder 关闭时）；不给 media_path 的调用保持旧行为（HTML 在 srt 旁），兼容测试与波形工程。 |
| RTF 重命名 | 仅 `run_transcription` 内部：`_require_output` 通过后、html 生成前，若 `effective_config().attach_rtf_rate` 且子进程 stdout 有有效 `MAW_STAT rtf=`，用 `unique_output_path` 把 srt/mosp 重命名为 `<stem>.<0.12x>`；html 随后渲染到重命名后的 _maw 路径。raw `.asr-response.json` 保持转写前 stem 命名（debug 开关独立控制）。 |
| 批量 manifest | 默认目录改为 `output_naming.maw_root(first_request.media_path)`（mkdir parents）；显式 `manifestPath` 不变。 |
| 前端 | 「通用」新增「文件输出」分组 4 checkbox（data-i18n / data-i18n-title）；change→`save_prefs`；openSettings 回填（attachModelName 按 `!== false`）；demo 镜像 default_output 同步 tag/subfolder 规则。 |

## 清单

- [x] gui_config：4 字段 + `_env_bool` 读取（默认 output_subfolder/per_video/rtf=false，attach=true）
- [x] gui_web：save_prefs 写 4 键、get_config 下发 4 字段、批量 manifest 默认落 maw_root、unique/_artifact/_batch_unique 带 media
- [x] gui_workflow：default_srt_path 四象限 + per-video；build_output_paths/unique_output_path 可选 media；run_transcription RTF 重命名 + html mkdir
- [x] launcher_batch：run_batch 唯一化带 media，重命名路径流入 outcome
- [x] 前端 index.html / launcher.js（含 demo 镜像、回填、change 链路）
- [x] 测试：gui_config(+3) gui_web(+4) gui_workflow(+10) launcher_batch(+1)
- [x] 验证：node --check；模块测试；全量 1236 OK（skipped=6 既有）；ruff 通过；git diff --check 干净
- [x] CHANGELOG [Unreleased] 🔄 变更 + .env.example 注释 4 键

## 验证结果

- `node --check web/launcher/launcher.js`：OK
- `uv run python -m unittest tests.test_gui_config tests.test_gui_web tests.test_gui_workflow tests.test_launcher_batch tests.test_output_naming`：Ran 411, OK (skipped=1)
- `uv run python -m unittest discover -s tests -p "test_*.py"`：**Ran 1236 tests, OK (skipped=6)**
- `uv run ruff check`（4 个 maw 模块）：All checks passed
- `git diff --check`：干净；改动文件无 CRLF（Edit 保持仓库 LF）

## 未验证边界 / 说明

- 浏览器 / 演示模式未实际运行：demo default_output 镜像仅 `node --check`，无 JS
  测试框架，需人工在浏览器预览镜像路径与后端一致。
- RTF 重命名仅经 mock Popen stdout 验证；真机 CLI 的 `MAW_STAT` 行格式由波 1
  测试锁定，未跑真实转写。
- 波 3 会统一重建 `blank-editor.html`（本波不跑 `edit.py --blank`）。
- 波形生成工程（gui_web:1972）仍用无 media 的 unique_output_path，保持旧行为；
  该路径不产出 edit.html，不影响转写链路。
- `.env.example` 新增 4 键为文档用途；`save_env` 只在用户改动时写入 .env。

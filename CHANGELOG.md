# Changelog

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 的记录方式。

## [Unreleased]

### Added

- 新增 Soniox STT 供应商（`generate_subtitle_soniox_api.py`）：异步文件转写、token 级毫秒时间戳、自动语言识别；转写完成后自动清理云端文件与转写记录。
- Soniox 可选说话人分离：`--speaker` 把供应商 opaque speaker 标签写入工程 JSON（`segments[*].speaker` / `items[*].speaker`）；`--speaker-colors` 进一步把说话人一次性映射为 5 种字幕颜色快照（超过 5 人循环复用并警告），之后仍可在编辑器自由修改。
- 工程 JSON 新增可选 `speaker` 字段（segments/items 两级）；带 speaker 的工程在说话人变化时必须切分字幕段。

### Changed

- `generate_subtitle_qwen_api.py` 的 `_parse_duration` 更名为 `parse_duration`（保留旧名别名，行为不变）。

## [1.1.0] - 2026-07-28

### Added

- 新增 Windows `tkinter + ttk` 图形界面，可选择媒体和输出路径、填写 Qwen Key、查看进度、取消任务并打开输出。
- 图形界面升级为 GUI v2：加入 `sv-ttk` 暗色主题、模型/地域/语言下拉框、按模型保存 API Key、中文/英文切换、本地编辑器服务器启动器与 EXE 图标。
- 新增 PyInstaller `onedir` Windows 构建脚本与 `v*` 标签触发的 GitHub Release 工作流；FFmpeg/ffprobe 继续保持外部依赖。
- 字幕画面预览支持鼠标拖动、八方向缩放、键盘调整、撤销/重做，以及 localhost 保存和便携 JSON 导出的持久化。

### Changed

- 工程 JSON 新增可选 `preview.subtitle` 归一化几何；旧工程缺少该字段时保持原有字幕位置。
- Qwen API CLI 新增 `--model` 参数；默认仍使用 `qwen3-asr-flash-filetrans`。

## [1.0.1] - 2026-07-26

### Added

- 从 ASR 字幕工作流中导出的独立、可公开分发的 API-first 最小版本。
- Qwen ASR API 转写、JSON/SRT 输出、波形字幕编辑器、便携 HTML 和 localhost 编辑器。
- 新用户工作流、维护说明、隐私说明与第三方组件说明。

### Changed

- 去除本地模型、多 ASR 引擎、模型对比、达芬奇脚本与个人资产，只保留一条完整可用链路。
- 音频输入的临时复制改用 Python 标准库，避免依赖 Unix `cp` 命令，保证 Windows PowerShell 环境可用。

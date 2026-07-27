# Changelog

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 的记录方式。

## [Unreleased]

## [1.1.0] - 2026-07-28

### Added

- 新增 Windows `tkinter + ttk` 图形界面，可选择媒体和输出路径、填写 Qwen Key、查看进度、取消任务并打开输出。
- 新增 PyInstaller `onedir` Windows 构建脚本与 `v*` 标签触发的 GitHub Release 工作流；FFmpeg/ffprobe 继续保持外部依赖。
- 字幕画面预览支持鼠标拖动、八方向缩放、键盘调整、撤销/重做，以及 localhost 保存和便携 JSON 导出的持久化。

### Changed

- 工程 JSON 新增可选 `preview.subtitle` 归一化几何；旧工程缺少该字段时保持原有字幕位置。

## [1.0.1] - 2026-07-26

### Added

- 从 ASR 字幕工作流中导出的独立、可公开分发的 API-first 最小版本。
- Qwen ASR API 转写、JSON/SRT 输出、波形字幕编辑器、便携 HTML 和 localhost 编辑器。
- 新用户工作流、维护说明、隐私说明与第三方组件说明。

### Changed

- 去除本地模型、多 ASR 引擎、模型对比、达芬奇脚本与个人资产，只保留一条完整可用链路。
- 音频输入的临时复制改用 Python 标准库，避免依赖 Unix `cp` 命令，保证 Windows PowerShell 环境可用。

# Changelog

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 的记录方式。

## [Unreleased]

### Added

- 本地 Qwen3-ASR 推理支持（可选依赖 `local`，0.6B / 1.7B）
- Web 控制台 `web-console/server.py`（一站式模型管理 + 文件处理 + 转写 + 编辑器启动）
- faster-whisper-large-v3 引擎支持（CPU/GPU，英文识别更佳）
- 热词功能（仅本地 Qwen3-ASR 模型，通过 context 软提示注入）
- `/assets/` 路径限制到 `web-console/assets/` 子目录，新增路径遍历防护
- Qwen 模型切换锁定：加载后自动禁用另一个 Qwen 选项

### Changed

- 从 `generate_subtitle_qwen_api.py` 抽取公共工具函数到 `maw.utils`
- Web 控制台转写任务创建逻辑统一到 `_create_task` 方法，消除 `_start_transcribe` 与 `_start_transcribe_with_body` 的代码重复
- Whisper 输出跳过 `split_words_to_segments` 二次切分，直接使用原生句子级边界
- `_unload_model` 支持单独卸载 Qwen 或 Whisper
- 热词文件写入改为原子模式（`.tmp` + `replace()`）

### Fixed

- `length_limit` 上限校验（最大 4 小时）
- 模型卸载时先移至 CPU 再释放，确保显存清理
- `_load_model` 拒绝加载与当前已加载不同的 Qwen 模型
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

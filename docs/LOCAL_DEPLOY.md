# 本地部署说明

MAW 支持通过可选依赖 `local` 使用本地模型进行 ASR 转写。

> 本地模型模块（`maw/` 下 `local_transcriber.py`、`model_downloader.py`、`maw_local_gui.py`）是独立于上游 MAW 的附加组件。上游 MAW 只做云端 API，不包含本地模型。

## 安装

```powershell
# 安装本地模型依赖
uv sync --extra local

# 如有 NVIDIA GPU，替换 CPU torch 为 CUDA 版：
uv pip install torch --index-url https://download.pytorch.org/whl/cu124
```

## 使用方式

### 图形界面（推荐）

```powershell
uv run python maw_local_gui.py
```

或双击 `maw_local.bat`。

图形界面功能：

1. **模型管理** — 先下载模型权重（约 1～3GB），再加载到内存。支持 Qwen3-ASR-0.6B、Qwen3-ASR-1.7B、faster-whisper-large-v3
2. **选择媒体** — 点击选择音频/视频文件
3. **选项** — 语言选择、保留句末标点、热词管理
4. **开始转写** — 后台线程运行，日志区实时显示进度
5. **输出** — 自动生成 SRT、JSON 和便携 HTML 编辑器文件

### 命令行调用

```python
from maw.local_transcriber import QwenModelHandle, transcribe_qwen, write_output_files

handle = QwenModelHandle()
handle.load("0.6B")
result = transcribe_qwen("audio.mp4", handle, language="zh")
write_output_files(result, "audio.mp4")
```

## FFmpeg 依赖

转写视频文件需要 `ffmpeg.exe` 和 `ffprobe.exe`。检测顺序：

1. 系统 PATH
2. `FFMPEG_PATH` 环境变量（可在 `.env` 中设置）
3. 内置 bundle（`ffmpeg/bin/` 与可执行文件同目录）

GUI 启动转写前会自动检测，缺失时弹出安装提示。

## 热词

本地 Qwen3-ASR 模型支持热词（GUI 中通过热词编辑器管理，也可编辑 `hotwords.txt`）：

- 每行一个热词，`#` 开头为注释
- 属于 best-effort 软提示（非强制约束），效果取决于模型版本与音频质量
- 建议数量 ≤ 20 个、单个长度 ≤ 10 字符
- faster-whisper 不支持热词

## 模型说明

| 模型 | 大小 | 推荐设备 | 说明 |
|------|------|----------|------|
| Qwen3-ASR-0.6B | ~1.2GB | CPU | 字级时间戳，支持热词 |
| Qwen3-ASR-1.7B | ~3.5GB | GPU | 字级时间戳，精度更高 |
| faster-whisper-large-v3 | ~3.1GB | CPU/GPU | 适合英文，句子级时间戳（免二次切分） |

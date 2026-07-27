# 从零完成一次字幕工程

这份指南按 Windows PowerShell 写；路径带空格时始终加双引号。MAW 是 Moy's ASR Workflow 的简称。

## 0. 安装依赖

如果使用 GitHub Releases 提供的 Windows 图形版，Python 与 uv 已由应用打包，不需要单独安装；但 `ffmpeg` 和 `ffprobe` 仍是外部依赖。解压后双击 `MAW.exe`，在窗口中选择媒体、输出位置并填写 API Key 即可。

源码方式继续按下列步骤安装：

确认下列命令都有输出：

```powershell
python --version
ffmpeg -version
ffprobe -version
uv --version
```

需要 Python 3.11+。推荐安装 uv 后在仓库根目录执行：

```powershell
uv sync
```

不使用 uv 时，改用普通虚拟环境：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install "requests>=2.28" "jieba>=0.42"
```

后文的 `uv run python` 可替换为 `.\.venv\Scripts\python`。

## 1. 配置 Qwen API

图形版可在遮罩输入框中填写 API Key；它只进入本次子进程环境，不会写回 `.env` 或 JSON。源码命令行方式使用下面的 `.env`：

```powershell
Copy-Item .env.example .env
notepad .env
```

最少填入：

```ini
DASHSCOPE_API_KEY=sk-你的密钥
```

北京地域默认使用 `DASHSCOPE_REGION=beijing`；新加坡地域改为 `singapore` 并填写 `DASHSCOPE_WORKSPACE_ID`。环境变量优先于 `.env`。密钥申请和地域说明以[官方文档](https://help.aliyun.com/zh/model-studio/get-api-key)为准。

## 2. 先跑小样本

图形版的“Length limit”可填写 `2m`，效果等同于命令行 `-ll 2m`。

先用 `-ll 2m` 限制在两分钟，既减少费用也便于排错：

```powershell
uv run python generate_subtitle_qwen_api.py "D:\Videos\example.mp4" -ll 2m --json
```

常用可选项：

```text
--language zh        已知纯中文时指定；中英日韩混说时不要指定
--gap-split 1000     相邻字间隔超过 N 毫秒时强制切句
--keep-punct         保留每条字幕末尾的逗号和句号
--no-html            只要 SRT 和 JSON，不生成便携 HTML
--debug              输出部分 API 原始结果，便于反馈问题
```

输入视频会先由 FFmpeg 提取单声道 16kHz WAV；音频输入也会通过 FFprobe 获取时长。没有 FFmpeg/FFprobe 时，这一步无法完成。

## 3. 理解三个输出文件

| File | Use it for | Keep it? |
|---|---|---|
| `.srt` | 导入播放器、剪辑软件 | 可随时重新导出 |
| `.json` | 字幕工程和字级时间戳 | **必须保留，建议备份** |
| `.edit.html` | 带着工程走、离线检查 | 可从 JSON 再生成 |

如果只剩 JSON，仍可重新生成 HTML：

```powershell
uv run python edit.py "D:\Videos\example.qwen3-asr-api.json" -m "D:\Videos\example.mp4"
```

如需跳过预计算波形（超大媒体首次启动较慢），加 `--no-waveform`；浏览器仍可在加载媒体后尝试计算波形。

## 4. 用推荐方式编辑

```powershell
uv run python server-editor\serve.py "D:\Videos\example.qwen3-asr-api.json"
```

服务器只监听本机 `127.0.0.1`。它会尝试按 JSON 的 `media` 字段加载原媒体；媒体搬家后，显式指定：

```powershell
uv run python server-editor\serve.py "D:\Projects\subtitle.json" -m "E:\Media\moved-video.mp4"
```

首次启动空白编辑器：

```powershell
uv run python server-editor\serve.py --blank
```

不带参数会默认恢复最近一次**明确打开**的工程。若不想恢复，用 `--blank`。编辑器的“保存工程”会原子写回 JSON，并在覆盖前创建同目录 `.json.bak`。

## 5. 编辑和导出

- 双击文本改字；右键可以按文字或波形位置拆分、合并与批量替换。
- 可拖动波形中的字幕块或边缘微调时间；相邻字幕共享边界时会保持连续。
- 播放器内的字幕预览可直接拖动；悬停或聚焦后拖动八个手柄可缩放。方向键移动，`Shift` 加速移动，`Alt + 方向键` 调整尺寸。几何保存在工程 `preview.subtitle`，不会改变字幕时间。
- “移除静音空隙”只建立可逆的压缩时间线，不修改原媒体和原字幕时间。
- 常规 SRT 通过工具栏导出；若启用了空隙移除，可选择去空隙 SRT、OTIO、FFconcat 或保留区域 JSON。

完整 JSON 约束在 [JSON_SCHEMA.md](../JSON_SCHEMA.md)。若你打算用其他 ASR 或 LLM 生成工程，至少保证顶层有 `segments`，时间全部是整数毫秒。

## 常见问题

### 找不到 `ffmpeg` 或 `ffprobe`

安装 FFmpeg 后关闭并重开 PowerShell，再运行 `ffmpeg -version`。不要只把 `ffmpeg.exe` 放在仓库里；更稳妥的是把其 `bin` 目录加入系统 PATH。

### 提示未配置 API Key

确认 `.env` 与脚本同级；Key 行没有引号、没有额外空格，且没有把 `.env.example` 当成 `.env` 使用。环境变量若存在会覆盖 `.env`。

### API 任务超时或上传失败

先确认网络与 API Key 地域；可在 `.env` 提高 `DASHSCOPE_POLL_TIMEOUT`。文件大小、时长、临时文件策略和计费以[官方 Qwen ASR 说明](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)为准。

### HTML 打开了但不能稳定拖动视频进度

优先用 `server-editor\\serve.py`。不要用 `python -m http.server` 替代它；该服务器专门实现了媒体 Range 响应。

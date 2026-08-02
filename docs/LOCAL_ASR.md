# 实验性本地 ASR

MAW 当前的正式入口仍然是云端 ASR。这个页面记录本地模型流程的第一版：

```text
本地媒体 -> Qwen3-ASR / FunASR -> MAW 统一时间戳 -> SRT + .mosp -> MAWE
```

它只提供源码模式的命令行入口，不新增独立桌面界面。以后如果把本地模型接入图形流程，入口应当复用 Launcher，而不是另做一套 UI。

## 安装可选依赖

默认 `uv sync` 不会安装本地模型依赖。需要尝试本地模型时：

```powershell
uv sync --extra local
```

这会安装 `qwen-asr` 和 `funasr`，以及它们需要的推理运行时。模型权重由上游运行时按模型 ID 下载到其缓存目录，不会写入仓库，也不会由 MAW 自动管理。

## 命令行用法

Qwen3-ASR 默认使用 `Qwen/Qwen3-ASR-0.6B`：

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --engine qwen-asr --device cpu --length-limit 30s --json
```

FunASR 默认使用 `paraformer-zh`：

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --engine funasr --device cpu --length-limit 30s --json
```

`--model` 可以指定上游模型 ID，`--model-path` 可以指定已经下载好的本地模型目录。第一次验证建议显式使用 `--device cpu`，并加 `--length-limit 30s`。没有 NVIDIA GPU 时可以验证文件准备、模型加载和输出流程，但不能据此判断 CUDA 性能或大文件处理能力。

`--json` 会同时生成 `.mosp` 工程；默认还会生成便携 `.edit.html`，如不需要可加 `--no-html`。`--with-waveform` 只能与 `--json` 一起使用。

## 当前边界

- 当前不改 Launcher，不自动下载或管理模型，也不把本地模型依赖放入 Windows 冻结包。
- 指定 Qwen3-ASR 的 `--forced-aligner` 后，时间戳按秒读取并归一化为 MAW 要求的整数毫秒；未指定时先保留文本并生成有效的整段字幕时间。FunASR 的常见句级/字词级时间戳也会归一化为同一格式。
- 当模型没有可可靠映射的词级时间戳时，仍保留句级字幕，不人为伪造字词边界。
- FunASR 的 VAD、标点、说话人模型可以通过对应参数传入，但不同模型组合的兼容性仍需要真实环境验证。
- 本地 CPU 推理、模型下载、实际显存/内存、长媒体速度和不同模型版本尚未在本项目中做完整验收。

## 模型与缓存大小

大小会随上游版本、权重格式和附加模型变化。粗略预留：Qwen3-ASR-0.6B 主模型约 1.5–2.5 GB，Forced Aligner 另需约 1–2 GB；FunASR `paraformer-zh` 及常用 VAD/标点/说话人组件合计建议预留约 2–4 GB。这里指下载缓存，不等同于推理时的内存峰值。

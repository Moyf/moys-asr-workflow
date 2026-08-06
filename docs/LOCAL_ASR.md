# 实验性本地 ASR

MAW 当前的正式入口仍然是云端 ASR。这个页面记录本地模型流程的第一版：

```text
本地媒体 -> Qwen3-ASR / FunASR -> MAW 统一时间戳 -> SRT + .mosp -> MAWE
```

Launcher 已提供实验性的「本地模型」识别方式，入口仍复用同一套媒体、输出和 MAWE 流程，而不是另做一套 UI。Windows 打包版可以直接在 Launcher 中安装本地运行环境；详细范围见 [MAW 1.2 本地模型 Launcher 开发记录](dev/MAW%201.2%20本地模型%20Launcher%20开发记录.md)。

## 安装可选依赖

源码开发环境默认 `uv sync` 不会安装本地模型依赖。开发者可以手动安装：

```powershell
uv sync --extra local
```

这会安装 `qwen-asr`、`funasr`、`torchaudio` 和它们需要的推理运行时。在 Windows 上，MAW 会从 PyTorch 官方 CUDA 13.0 索引安装 GPU 版 Torch / TorchAudio；默认设备选择会优先使用 CUDA，不可用时才回退 CPU。模型权重由上游运行时按模型 ID 下载到其缓存目录，不会写入仓库，也不会由 MAW 自动管理。

普通用户不需要执行这个命令。Windows 打包版选择「本地模型」后，点击「安装本地模型支持」即可由 GUI 在 `%LOCALAPPDATA%\\MAW\\local-runtime` 创建独立 Python 环境并安装同一组依赖；安装完成后再点击「下载模型」。运行环境和模型缓存分别位于 `local-runtime` 与 `model-cache`，安装失败可以重试或修复，模型下载可以重新扫描。

## 命令行用法

Qwen3-ASR 默认使用 `Qwen/Qwen3-ASR-0.6B`：

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --engine qwen-asr --length-limit 30s --json
```

FunASR 默认使用 `paraformer-zh`：

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --engine funasr --length-limit 30s --json
```

`--model` 可以指定上游模型 ID，`--model-path` 可以指定已经下载好的本地模型目录。Qwen3-ASR 默认同时加载 `Qwen/Qwen3-ForcedAligner-0.6B`，以输出可编辑字幕所需的词级时间戳；它不是可选增强。默认 `--device auto` 会优先使用 CUDA；如需排查兼容性或没有 NVIDIA GPU，可显式传入 `--device cpu`。第一次验证建议加 `--length-limit 30s`。

`--json` 会同时生成 `.mosp` 工程；默认还会生成便携 `.edit.html`，如不需要可加 `--no-html`。`--with-waveform` 只能与 `--json` 一起使用。

## 热词

Qwen3-ASR 将热词作为上游的 `context` 提示传入，能帮助识别专有名词，但不是保证命中的硬约束。直接传入热词时可重复使用 `--hotword`：

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --hotword "MOSE" --hotword "Qwen3-ASR"
```

也可以用 UTF-8 文本文件管理热词，一行一个词；空行与 `#` 开头的注释会忽略。`--hotword-file` 可重复传入，命令行热词与文件内容会合并并去重：

```text
# terms.txt
MOSE
Qwen3-ASR
Lei Hu
```

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --hotword-file ".\terms.txt"
```

## 当前边界

- Launcher 的「下载模型」按钮调用 QwenASR / FunASR 上游加载器准备缓存；本地运行环境由 GUI 独立安装，不放入 Windows 冻结包，Torch / TorchAudio 和模型权重仍按需下载。
- Qwen3-ASR 始终使用 Forced Aligner；时间戳按秒读取并归一化为 MAW 要求的整数毫秒。FunASR 的常见句级/字词级时间戳也会归一化为同一格式。
- 当模型没有可可靠映射的词级时间戳时，仍保留句级字幕，不人为伪造字词边界。
- FunASR 的 VAD、标点、说话人模型可以通过对应参数传入，但不同模型组合的兼容性仍需要真实环境验证。
- 本地 CPU 推理、模型下载、实际显存/内存、长媒体速度和不同模型版本尚未在本项目中做完整验收。

## 模型与缓存大小

大小会随上游版本、权重格式和附加模型变化。粗略预留：Qwen3-ASR-0.6B 主模型约 1.5–2.5 GB，Forced Aligner 另需约 1–2 GB；FunASR `paraformer-zh` 及常用 VAD/标点/说话人组件合计建议预留约 2–4 GB。这里指下载缓存，不等同于推理时的内存峰值。

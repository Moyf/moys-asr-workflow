# 实验性本地 ASR

> 注意：当前为 beta 版本，未经过充分测试，不保证后续的维护和更新，请谨慎使用。

MAW 当前的正式入口仍然是云端 ASR。这个页面记录本地模型流程的第一版：

```text
本地媒体 -> SenseVoice / Fun-ASR-Nano / Qwen3-ASR / Paraformer -> MAW 统一时间戳 -> SRT + .mosp -> MAWE
```

Launcher 已提供实验性的「本地模型」识别方式，入口仍复用同一套媒体、输出和 MAWE 流程，而不是另做一套 UI。Windows 打包版可以直接在 Launcher 中安装本地运行环境；详细范围见 [MAW 1.2 本地模型 Launcher 开发记录](dev/MAW%201.2%20本地模型%20Launcher%20开发记录.md)。

## 安装可选依赖

源码开发环境默认 `uv sync` 不会安装本地模型依赖。开发者可以手动安装：

```powershell
uv sync --extra local
```

这会安装 `qwen-asr`、FunASR 1.3.29+、`torchaudio` 和它们需要的推理运行时。在 Windows 上，MAW 会从 PyTorch 官方 CUDA 13.0 索引安装 GPU 版 Torch / TorchAudio；默认设备选择会优先使用 CUDA，不可用时才回退 CPU。模型权重由上游运行时按模型 ID 下载到其缓存目录，不会写入仓库，也不会由 MAW 自动管理。

普通用户不需要执行这个命令。Windows 打包版选择「本地模型」后，点击「安装本地模型支持」即可由 GUI 在 `%LOCALAPPDATA%\\MAW\\local-runtime` 创建独立 Python 环境并安装同一组依赖；安装完成后再点击「下载模型」。运行环境和模型缓存分别位于 `local-runtime` 与 `model-cache`，安装失败可以重试或修复，模型下载可以重新扫描。Launcher 的「模型保存目录」可以改到其他磁盘，设置会保存到 `.env`，并同时作用于 Hugging Face 与 ModelScope 缓存。

## 命令行用法

Qwen3-ASR 默认使用 `Qwen/Qwen3-ASR-0.6B`；需要更高识别质量时可以切换到 1.7B：

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --engine qwen-asr --length-limit 30s --json
```

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --engine qwen-asr --model Qwen/Qwen3-ASR-1.7B --length-limit 30s --json
```

FunASR 在 Launcher 中优先提供 SenseVoice Small；它适合多语种和 CPU/GPU 场景：

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --engine funasr --model iic/SenseVoiceSmall --language en --length-limit 30s --json
```

有 NVIDIA GPU 时也可以试用 Fun-ASR-Nano：

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --engine funasr --model FunAudioLLM/Fun-ASR-Nano-2512 --language en --device cuda --length-limit 30s --json
```

Paraformer 仍保留为兼容选项：

```powershell
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" `
  --engine funasr --length-limit 30s --json
```

`--model` 可以指定上游模型 ID，`--model-path` 可以指定已经下载好的本地模型目录。Qwen3-ASR 0.6B 和 1.7B 都默认加载 `Qwen/Qwen3-ForcedAligner-0.6B`，以输出可编辑字幕所需的词级时间戳；它不是可选增强。SenseVoice 默认配合 FSMN-VAD 并保留句级时间戳，Fun-ASR-Nano 默认配合 FSMN-VAD 请求句级时间戳；如果上游返回字符级时间戳，MAW 会再按标点和静音切分，否则至少按 VAD 语音区间生成字幕。默认 `--device auto` 会优先使用 CUDA；如需排查兼容性或没有 NVIDIA GPU，可显式传入 `--device cpu`。第一次验证建议加 `--length-limit 30s`。

不使用 Launcher 时，也可以通过环境变量指定统一的模型缓存根目录：

```powershell
$env:MAW_MODEL_CACHE_ROOT = "D:\Models\MAW"
uv run python generate_subtitle_local.py "D:\Videos\example.mp4" --engine funasr --model iic/SenseVoiceSmall --json
```

长音频会按 `--batch-size-s` 指定的秒数分块识别，再把每块的时间戳平移回原音频。Qwen3-ASR 默认每 30 秒一块，FunASR 默认仍为 300 秒；如果显存或内存不足，可以把 Qwen 的分块调小，例如 `--batch-size-s 20`。

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

- Launcher 的「下载模型」按钮调用 QwenASR / FunASR 上游加载器准备缓存；当前正式列出 SenseVoice Small、Fun-ASR-Nano、Qwen3-ASR 0.6B、Qwen3-ASR 1.7B 和 Paraformer 兼容选项。本地运行环境由 GUI 独立安装，不放入 Windows 冻结包，Torch / TorchAudio 和模型权重仍按需下载。
- Launcher 可以把模型缓存切换到自定义目录；它参考了 [Voicebox 的模型目录配置方式](https://github.com/jamiepine/voicebox/blob/main/backend/config.py)，把运行环境和 Hugging Face / ModelScope 模型缓存分开管理。
- Qwen3-ASR 0.6B 和 1.7B 都使用同一个 Forced Aligner；时间戳按秒读取并归一化为 MAW 要求的整数毫秒。FunASR 的常见句级/字词级时间戳也会归一化为同一格式。
- Qwen3-ASR 长音频采用独立的 FFmpeg 分块识别，默认每块 30 秒，并在合并前恢复原始时间偏移，避免单次生成长度限制导致后半段字幕缺失。
- 当模型没有可可靠映射的词级时间戳时，仍保留句级字幕，不人为伪造字词边界。
- SenseVoice 默认启用 FSMN-VAD 和富文本后处理；Fun-ASR-Nano 默认启用 FSMN-VAD、远程模型代码和句级时间戳请求，适合 CUDA 环境；其他 FunASR 的 VAD、标点、说话人模型可以通过对应参数传入，但不同模型组合的兼容性仍需要真实环境验证。
- 本地 CPU 推理、模型下载、实际显存/内存、长媒体速度和不同模型版本尚未在本项目中做完整验收。

## 模型与缓存大小

大小会随上游版本、权重格式和附加模型变化。粗略预留：Qwen3-ASR-0.6B 主模型约 1.5–2.5 GB，1.7B 主模型通常更大，两个 Qwen 选项共用的 Forced Aligner 另需约 1–2 GB；SenseVoice Small 及 FSMN-VAD 建议预留约 1–2 GB，Fun-ASR-Nano 建议预留更多空间并优先使用 CUDA，FunASR `paraformer-zh` 及常用 VAD/标点/说话人组件合计建议预留约 2–4 GB。这里指下载缓存，不等同于推理时的内存峰值。

## 模型准备的中断与继续

Launcher 会复用 Hugging Face / ModelScope 已经写入的缓存文件，因此重新准备同一个模型时通常会从已有缓存继续；上游加载器是否能对单个仍在下载的临时文件做到字节级续传，不由 MAW 保证。准备界面会显示已写入的文件数和字节数，并给出按模型类型计算的粗略总量区间，百分比仅用于判断大致进度。

准备时间过长时可以点击「取消准备」。MAW 会终止当前模型加载子进程并保留缓存，取消完成后即可切换到其他模型；切换模型不会复用不相关模型的权重，但 Qwen3-ASR 的两个选项会共用 Forced Aligner 缓存。

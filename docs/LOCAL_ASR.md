# 实验性本地 ASR 与时间码对齐

本地模型已接入 Launcher，也可从独立 CLI 调用。它们与云端转写共用 SRT / `.mosp` / MAWE 流程，但运行环境、硬件性能和模型组合仍属实验范围，先用自己的短音频验收。

## 模型与时间码

| 模型 / 引擎 | 当前入口 | 时间码与主要边界 |
| --- | --- | --- |
| Qwen3-ASR 0.6B / 1.7B | `--engine qwen-asr` | 默认 0.6B，配合共享 Forced Aligner 输出字词时间码，默认 30 秒分块。 |
| SenseVoice Small | `--engine funasr --model iic/SenseVoiceSmall` | Launcher 的 FunASR 路线；FSMN-VAD 与富文本后处理，至少保留句级范围。 |
| Fun-ASR-Nano | `--engine funasr --model FunAudioLLM/Fun-ASR-Nano-2512` | 使用远程模型代码，默认 VAD 与句级时间码请求；先验证设备和模型兼容。 |
| Paraformer | `--engine funasr` | CLI 默认 `paraformer-zh`，Launcher 保留兼容选项。 |
| MOSS Transcribe-Diarize 0.9B | `--engine moss` | 段级说话人转写，独立运行环境；可再调用共享对齐器补字词时间码。 |
| FireRedASR2-CTC | `--engine firered` | CPU int8 CTC 字词时间码，默认 ct-punc 增强断句；未接入 AED。 |
| Faster-Whisper | `--engine whisper` | 默认 `large-v3`，CTranslate2；词级时间码、VAD 与长音频处理由上游执行，无说话人分离。 |

所有有效时间码都归一化为整数毫秒。模型只返回段级时间时，不伪造精确字词 `items`。段内按文字比例拆分只是近似时间；工程用 `timestamp_granularity` 等字段标明能力。

超长句级段二次拆分时，插值切点会尝试吸附到 ±400ms 内明显的低能量处；原始句界、间隙和已有字词时间码不变。能量平坦、音频不可读或缺少 numpy / soundfile 时保留原切点。低能量只是参考，仍需在编辑器试听确认。

## 在 Launcher 准备

1. 选择「本地模型」及目标模型。
2. 安装或修复对应运行环境。
3. 在「AI 模型」下载模型或重新扫描已有缓存。
4. 选择设备，先转写约 30 秒，检查结果和速度后再处理长媒体。

Windows 打包版提供独立运行环境安装入口；不将 Torch 和权重放进基础冻结包。普通模型共用 `local-runtime`，MOSS 使用 `local-runtime-moss`，OCR 使用自己的环境。当前普通 runtime 版本为 7，MOSS 为 2；旧环境出现需要修复时应补齐依赖。

运行环境与权重分开保存，默认位于 MAW 用户数据目录；可在设置修改目录，模型根目录对应 `MAW_MODEL_CACHE_ROOT`。路径和配置读取见 [PROVIDERS](PROVIDERS.md)。

### 下载、扫描与中断

Qwen3-ASR、MOSS、Faster-Whisper 和 Qwen 对齐器先尝试 Hugging Face，连接失败回退 ModelScope；FunASR 路线本身使用 ModelScope，FireRed CTC 从固定官方地址下载。

缓存按来源保存到 `model-cache/huggingface/hub`、`model-cache/modelscope`，FireRed 对齐目录在 `aligners`。扫描识别已完成缓存，也允许显式指定本地模型目录。进度中的大小区间是估计值，不代表推理内存占用。

「取消准备」终止准备子进程并保留缓存；重新准备优先复用已有文件，单个临时文件是否支持字节级续传取决于下载器。完全离线使用前，需先准备权重、附加 VAD/标点/对齐器及运行环境。

## 从源码调用

普通本地引擎可由开发者手动安装可选组：

```sh
uv sync --group local
uv run --no-sync python generate_subtitle_local.py "clip.mp4" --engine qwen-asr --length-limit 30s --json --no-html
```

`uv sync --group local` 不包含 MOSS；MOSS 的 Transformers 5.x 依赖与 QwenASR 的 Transformers 4.x 不兼容，必须使用独立环境，依赖真源为 `moss-requirements.in`。在 Launcher 完成 MOSS 环境安装后，通过它运行，不把 MOSS 依赖混装到普通 `.venv`。

以下是独立脚本示例，模型选择也可在 Launcher 完成：

```sh
# 更大的 Qwen 模型
uv run --no-sync python generate_subtitle_local.py "clip.mp4" --engine qwen-asr --model Qwen/Qwen3-ASR-1.7B --json --no-html

# SenseVoice
uv run --no-sync python generate_subtitle_local.py "clip.mp4" --engine funasr --model iic/SenseVoiceSmall --json --no-html

# FireRed，禁用可选标点模型
uv run --no-sync python generate_subtitle_local.py "clip.mp4" --engine firered --firered-punc none --json --no-html

# Faster-Whisper
uv run --no-sync python generate_subtitle_local.py "clip.mp4" --engine whisper --model large-v3 --json --no-html
```

### 参数速查

| 参数 | 作用 |
| --- | --- |
| `--engine` / `--model` | 引擎和模型 ID。 |
| `--model-path PATH` | 已下载好的模型目录。 |
| `--device auto\|cpu\|cuda\|mps` | 设备；MPS 仅用于 macOS Qwen 路线。 |
| `--language CODE` | 语言提示。 |
| `--batch-size-s N` | 分块秒数；Qwen 默认 30、FunASR 默认 300，FireRed 块不超过 75；Whisper 不使用此选项。 |
| `--hotword WORD` / `--hotword-file PATH` | 可重复，合并去重；能力取决于引擎。 |
| `--firered-punc none\|ct-punc` | FireRed 标点，默认 ct-punc，选择后加载失败会报错。 |
| `--vad-model` / `--punc-model` / `--speaker-model` | FunASR 附加组件，组合兼容性需验证。 |
| `--speaker-colors` | 对已有说话人标签生成颜色快照。 |
| `--alignment-model ID` / `--alignment-model-path PATH` | 为缺少字词时间码的转写选择共享对齐器。 |
| `--alignment-mode fill\|generate` | 补缺失或重新生成。 |
| `--forced-aligner ID` | QwenASR 自身配套对齐模型。 |
| `--audio-track N` | 音频流序号，从 0 开始。 |
| `-ll` / `--length-limit` | 截取短样本。 |
| `-o` / `--output PATH` | SRT 输出，工程同名。 |
| `--json` / `--no-html` | 生成 `.mosp` / 关闭默认便携 HTML。 |
| `--with-waveform` / `--with-spectral` | 预生成外置缓存；前者要求 `--json`，后者还要求波形开关。 |
| `--debug-raw` | 保存原始/中间产物与 `.local-debug.json` 清单。 |
| `--no-model-tag` | 省略默认文件名的模型段；实时率仍在日志中显示。 |

断句长度与停顿参数沿用统一字符型/单词型规则，详见 [CLI](CLI.md)。本页参数属于 `generate_subtitle_local.py`，不能直接传给公开 `MAW.exe` CLI。

## 设备与长音频

`auto` 优先 CUDA，不可用时 CPU；macOS 不自动选择 MPS。Qwen3-ASR 或 Qwen 对齐器可显式选 MPS，失败会报错，速度需与同一音频的 CPU 结果比较。FireRed 始终走 CPU。

Faster-Whisper 的 CUDA 运行库与 Torch 不共用，需要适配 CTranslate2 的 CUDA / cuDNN 库；自动设备可在缺库时回退 CPU，显式 CUDA 保留错误。CPU 使用 int8。

Qwen/FunASR/FireRed 分块后恢复原时间偏移。MOSS 不分块，避免不同块的说话人编号失去一致性；单次输入按约 90 分钟限制处理。Whisper 自行滑窗，不使用 MAW 分块参数。

## MOSS 与 FireRed 的额外说明

MOSS 使用 `trust_remote_code`。默认 Hugging Face 模型固定提交 `e8681d68e7042738ffca8ac8212bc8fcb1131ab8`，推理包固定 `e607537b1b870475e7898969d40b864de8b691b6`；ModelScope 回退不对齐 HF 提交，自定义模型也不套用默认 revision。首次加载前确认模型代码来源。

MOSS 日志显示准备阶段和真实生成 token 数，无法预知最终长度，不给伪百分比。MOSS runtime 不含 quapeaks，缺少内核时跳过该容器生成；工程照常保存，波形可使用 `.mopeaks` 回退或由编辑器重建，不写进落盘工程。

FireRed 识别的 ct-punc 是可选组件：生成标点并改善断句，不为标点伪造时间码。关闭后保留 CTC 结果；对齐模式只使用 CTC，不需要 ct-punc。

## 共享时间码对齐

AI 模型页的「对齐模型」独立管理 Qwen3-ForcedAligner-0.6B 和 FireRedASR2-CTC。QwenASR、MOSS 与工具箱复用缓存，不重复保存权重。

工具箱「生成时间码」处理 SRT / MOSP / JSON：默认仅补缺失，或重新生成所有字词时间码。输入不覆盖，失败段保留原范围并报告。工程无有效媒体引用时必须指定原始媒体。用法见 [工具箱](TOOLBOX.md)。

[`tools/timestamp-compare.html`](../tools/timestamp-compare.html) 可在浏览器检查或按段序号比较工程时间码；SRT 只参加段级比较。它是检查工具，不是对齐器或自动验收结论。

## 安装失败与验证边界

Launcher 自动选择 PyPI 镜像；需要 GPU Torch 时另用 PyTorch 索引。`MAW_PIP_INDEX` 可覆盖候选源，`MAW_PYTORCH_INDEX` 可替换 PyTorch 源；镜像必须实际提供对应 wheel，替换 URL 不能解决版本/硬件不兼容。

模型下载量与推理内存不同，具体空间以准备界面和实际缓存为准。CPU、显存、长媒体速度、附加组件与多语种尚无完整跨硬件基准；不承诺统一实时率。先确认短样本可用，再扩大任务。

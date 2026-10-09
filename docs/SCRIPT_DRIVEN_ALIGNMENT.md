# 文稿驱动对齐（实验性）

已有准确文稿和对应录音时，可直接用本地 Qwen3-ForcedAligner 生成 SRT 与带字词级 `items` 时间码的 `.mosp`，无需先转写。音视频不会上传到 ASR 服务；首次准备模型可能需要联网下载。适合从头到尾顺序念稿的录音。

每个非空文稿行生成一条字幕，保留行内文字、空格与标点；不按标点再次切句，不应用 ASR 的断句 / 剥尾设置。空行忽略，行首与行尾空白去除。文稿必须为 UTF-8 `.txt` / `.md` / `.markdown`，可以有 BOM；Markdown 按原文处理，不自动去除格式符号，建议先导出纯文本。

模型输入做 NFC 规范化，输出仍保留原文（包括组合字符）；工程写入 `preserve_punctuation: true`，在当前 MAWE 打开、保存与重开后仍保留标点。和补码、文稿匹配、口播对齐及 AI 整理的选择区别见 [能力对比与演进建议](ALIGNMENT_FEATURES.md)。

## Launcher

1. 在「设置 → AI 模型」安装本地运行环境、下载 Qwen3-ForcedAligner。
2. 打开「工具箱 → 生成时间码」，将「处理方式」切为「仅使用文稿对齐」。
3. 选择原始媒体和文稿，指定语言。可先点击「检查输入与分块（无需模型）」检查文件、音轨与锚点；通过仅表示输入和分块可用，不证明读稿正确。生成时会重新检查。
4. 点击「生成时间码」。不需要已有 SRT / 工程；结果显示策略、行数、块数、时长和音轨，并提醒听审。

此模式仅使用 Qwen ForcedAligner，默认读取容器默认声音轨道；Launcher / CLI 可以指定从 0 开始的声音轨道序号。会同时输出新的 MOSP 与 SRT，忽略其他工具的共享输出选项；默认位于文稿旁，也可指定输出目录。名称为 `文稿.script-aligned.mosp` / `.srt`，遇到重名追加编号，保留输入。输出工程可直接在 MAWE Server 打开并重新生成波形。

## CLI

```powershell
.\MAW.exe --align-script "script.txt" -i "recording.mp4" --language zh
```

源码方式（已安装本地模型依赖）或已安装 Launcher 管理的本地运行环境：

```powershell
uv run --no-sync python maw_gui.py --align-script "script.txt" -i "recording.wav" --language zh
```

CLI 优先使用已就绪的 MAW 本地模型运行环境，否则使用当前 Python 环境。当前环境缺依赖时会明确提示；模型未下载时沿用既有 Hugging Face → ModelScope 准备流程。无需 API Key。

| 参数 | 默认与说明 |
| --- | --- |
| `--align-script SCRIPT` | UTF-8 文稿路径，启用此模式 |
| `--alignment-check` | 只检查输入 / 分块，向 stdout 输出 JSON（策略、时长、行数、块数、音轨、锚点）；不检查模型就绪、不加载模型、不写字幕 |
| `-i MEDIA` | 必填，音频 / 视频路径 |
| `--language` | `zh`；可用 `zh/yue/en/ja/ko/fr/de/es` |
| `--alignment-device` | `auto`；可选 `cpu/cuda/mps`，沿用既有 Qwen 设备策略 |
| `--alignment-model-path` | 已有 ForcedAligner 模型目录；未指定时复用缓存 |
| `--alignment-output-directory` | 输出目录；默认文稿所在目录 |
| `--alignment-audio-track` | 零基声音轨道索引；默认容器默认轨 |
| `--alignment-silence-db` | `-35` dB；可用 -100 至 -1 |
| `--alignment-silence-ms` | `500` ms；可用 80 至 10000 |
| `--alignment-anchors` | 可选人工锚点 JSON，详见下文 |

本模式不接受普通转写 / Server 选项，不支持 `-o`、截取时长、波形和便携 HTML 生成。成功返回 0，失败返回 1，参数错误返回 2。

例如在准备模型前检查长录音；返回的 `anchors` 可作为人工锚点文件的参考，须试听确认，不能据此断言文稿与声音吻合：

```powershell
.\MAW.exe --align-script "script.txt" -i "recording.wav" --alignment-check
```

## 短录音与长录音

- **≤300 秒** ： 整段音频与全部文稿单次对齐，随后按文稿换行还原字幕。独立使用 300 秒上限，不改变已有“补充 / 重生时间码”工具的 75 秒策略。Qwen 上游的模型能力与用法见 [官方仓库](https://github.com/QwenLM/Qwen3-ASR)。
- **>300 秒** ： FFmpeg `silencedetect` 找到真实语音区间。自动映射要求每个非空文稿行对应一个停顿分隔的语音区间；数量不等时拒绝生成，提示区间数和行数。连续行可合并成不超过 300 秒的模型输入，块间切点落在实际静音处；结果使用该块的绝对起点恢复时间，不按字数比例切音频。
- 自动模式逐行检查结果是否跨越对应语音区间（容许 160ms 的检测 / 模型边界误差）。超长连续语音、块内错位、零时长、时间倒序、超界或文稿文字不完整时明确失败，不写部分工程。

暂停可能发生在行内，几行也可能连读；仅有静音不能确定是哪行文字。可调整静音阈值和停顿时长，使真实停顿与文稿换行对应，或使用人工锚点。首次对齐需听审；不承诺固定加速倍数，模型加载、设备、音频时长和文本长度都会影响耗时。

静音检测只用于 **>300 秒且没有人工锚点** 的自动映射。短录音与人工策略不使用静音阈值拒绝低音量音频；空 / 全零波形仍会报错。非零波形不等于有效语音，噪声和低于 PCM 量化精度的音频仍需检查。

## 人工锚点

当自动区间与文稿行数不对应时，提供一组经人工确认的行范围和时间范围。`first_line` / `last_line` 是**非空行**序号，从 1 开始、包含两端；`start` / `end` 是源媒体绝对整数毫秒。各组必须按顺序覆盖每行一次，时间不可重叠或超出媒体，每组时长不超过 300 秒；可以跳过无关音频。

```json
[
  {"first_line": 1, "last_line": 12, "start": 800, "end": 125000},
  {"first_line": 13, "last_line": 24, "start": 126000, "end": 255000}
]
```

```powershell
.\MAW.exe --align-script "script.txt" -i "recording.wav" --alignment-anchors "anchors.json"
```

Launcher 同一面板可以选择此 JSON。人工锚点优先于自动策略，短录音也可使用；不需要一行一个停顿，但提供者必须确认每组录音与其文稿对应。

## 录音不干净时

字幕文字始终来自文稿。口误、语气词、跳行、重复或额外语句可能被 ForcedAligner 忽略；模型返回文字是输入文稿，不能用 difflib 对它做匹配来证明录音确实念对。静音区间数量检查和时间合理性检查能识别部分异常，不能识别所有脏录音。每次输出均提醒听审。

需要选择 take 或确认真实说话内容时，先用 ASR，再用现有「口播对齐」/「文稿匹配」，或者先整理录音并人工指定锚点。SRT 仅包含句级范围，字词时间码保存在 MOSP，继续使用现有 `moy.asr.project.v1` 契约。

# Parakeet TDT 日文模型接入调研

> 调研日期：2026-09-07
>
> 调研对象：`nvidia/parakeet-tdt_ctc-0.6b-ja`
>
> 当前状态：仅完成静态调研，尚未进行真实环境 spike，不代表 MAW 已支持该模型

## 结论

- `nvidia/parakeet-tdt_ctc-0.6b-ja` 不能直接作为现有 QwenASR、FunASR 或
  faster-whisper 引擎的另一个模型 ID 使用。它是 NVIDIA NeMo 的 `.nemo`
  checkpoint，需要新增 NeMo 引擎适配器。
- 模型要求的 16 kHz 单声道 WAV 输入与 MAW 当前本地音频预处理兼容；NeMo
  可提供的文本和时间戳也原则上能够映射到 `LocalTranscription` 及 MAW 的整数毫秒
  `segments` / `items` 契约。
- 不建议把 NeMo 直接加入当前 `local-runtime`。当前 QwenASR/FunASR 环境使用
  Transformers 4.57.6，而 NeMo 2.4 的 `asr` extra 要求 Transformers
  4.51–4.52；直接混装存在明确的依赖冲突风险。
- 若继续接入，推荐像 MOSS 一样建立独立的 `local-runtime-nemo`，复用现有
  `ManagedRuntime` 生命周期，但单独冻结依赖、安装、验证和运行 worker。
- 第一项工作应是限时半天至一天的技术 spike，先验证 Windows 安装、模型加载和
  日文时间戳。只有 spike 通过后，才值得投入完整功能开发。
- 完整的 Windows Launcher 可发布支持预计为 8–15 个工程日；如果还要承诺
  macOS 和 Linux，整体可能达到 10–20 个工程日。该估算不是排期承诺，最大变量是
  NeMo 的原生 Windows 依赖和真实时间戳行为。

## 名称与模型基本信息

本次调研对象的官方名称是：

```text
nvidia/parakeet-tdt_ctc-0.6b-ja
```

名称中包含 `_ctc`。它不是英文、多语种 Parakeet V2/V3 的日语配置，而是独立的
日语模型。

根据 NVIDIA 模型卡和 Hugging Face 仓库元数据：

| 项目 | 信息 |
|---|---|
| 语言 | 日语 `ja` |
| 参数量 | 约 0.6B |
| 架构 | Hybrid FastConformer TDT-CTC |
| 模型格式 | NeMo checkpoint，文件名 `parakeet-tdt_ctc-0.6b-ja.nemo` |
| 模型文件大小 | 约 2.49 GB |
| 输入 | 16 kHz、单声道 WAV |
| 输出 | 转写文本；现代 NeMo 的离线 `transcribe(..., timestamps=True)` 原则上可返回时间戳 |
| 默认 decoder | TDT，可切换到 CTC |
| 许可 | CC-BY-4.0 |
| 模型卡报告版本 | NeMo 1.23.0 |

模型卡报告的 CER 包括 JSUT basic5000 6.4%、Common Voice 8.0 7.1%、
TEDxJP-10K 9.0%。这些结果来自上游指定评测和归一化规则，不能直接等同于 MAW
用户素材上的字幕准确率。

## 与 MAW 当前本地流程的兼容性

### 已兼容的部分

1. **音频输入**：MAW 的本地流程会通过 FFmpeg 准备音频；Qwen 分块路径也已经使用
   16 kHz 单声道 PCM WAV，满足 Parakeet 的输入要求。
2. **统一结果模型**：`maw/local_asr.py` 已定义 provider-neutral 的
   `LocalTranscription`，能够容纳全文、语言、字词时间戳、句段时间戳和模型名。
3. **时间单位**：NeMo 的公开时间戳示例使用秒级浮点数，MAW 已有将秒转换为整数毫秒的
   处理模式。
4. **日文切句**：MAW 现有脚本检测和 CJK 字符型切分能够处理日文文本；如果能获得可靠的
   字符时间戳，可复用现有统一字幕切分逻辑。
5. **长音频偏移**：Qwen 路径已有“分块识别后恢复原始时间偏移”的实现，可作为
   Parakeet 分块方案的参考，但不能未经测试直接共用所有参数。

### 当前不兼容的部分

1. **没有 NeMo 引擎**：`create_local_engine()` 当前只支持 `qwen-asr`、`funasr`、
   `moss` 和 `whisper`。
2. **没有 NeMo 依赖**：当前 `local` dependency group 不包含 `nemo_toolkit[asr]`。
3. **没有 NeMo runtime 路由**：当前托管 runtime 只注册 `local`、`moss` 和 `ocr`，
   尚无 `local-runtime-nemo`。
4. **没有 NeMo 模型缓存识别**：Launcher 的模型检查、准备 worker 和下载体积估算中没有
   `.nemo` checkpoint 的专用规则。
5. **时间戳输出尚未实测**：日文模型卡只演示普通文本转写，没有明确展示该 checkpoint
   在目标 NeMo 版本中的日文字符、词和句段时间戳形状。

## 为什么不直接加入当前 local-runtime

MAW 当前公共本地运行环境定义在 `maw/runtimes/local_spec.py`：

- runtime 版本为 6；
- Python 版本为 3.11；
- 安装 QwenASR、FunASR、faster-whisper、Torch 和 TorchAudio；
- 自检要求这些引擎能够同时导入。

当前 `uv` 解析的 local dependency group 中，QwenASR 和 FunASR 使用
Transformers 4.57.6。NeMo 版本选择存在以下约束：

- 模型卡使用 NeMo 1.23.0 评测，但该旧版本早于现代统一时间戳 API，且其依赖栈更旧；
- NeMo 2.4 提供现代 `transcribe(..., timestamps=True)`，但其 `asr` extra 限制
  Transformers 为 4.51–4.52；
- 当前最新 NeMo 3.0 放宽了部分依赖，但该旧日文 checkpoint、Windows、Torch 2.13
  和时间戳组合尚未验证。

因此，直接把 NeMo 加入 `pyproject.toml` 的 `local` group 可能迫使 QwenASR 降级
Transformers，或迫使 NeMo 运行在未验证的依赖组合上。与 MOSS 因 Transformers
主版本冲突而独立运行的情况类似，隔离是更安全的默认方案。

## 独立 local-runtime-nemo 草案

### Runtime 声明

新增类似 `maw/runtimes/moss_spec.py` 的 NeMo spec，至少包含：

- 独立目录 `local-runtime-nemo`；
- 独立 runtime 版本和 Python 版本；
- 独立 frozen requirements；
- `import nemo.collections.asr` 自检；
- 关键包目录检查；
- 独立 worker module；
- 安装、取消、损坏、修复和就绪状态文案。

公共安装、manifest、CPU/CUDA 清单选择、进程取消和缓存环境可以继续复用
`maw/runtimes/base.py` 的 `ManagedRuntime`。

### 依赖清单

建议新增 `nemo-requirements.in`，不要将 NeMo 写入当前 `local` dependency group。
在 spike 完成前不预先决定最终版本，但清单至少需要固定：

- `nemo_toolkit[asr]`；
- PyTorch / TorchAudio；
- Transformers；
- Lightning / Hydra / TorchMetrics；
- SentencePiece、SoundFile、Librosa 及 NeMo ASR 传递依赖。

需要像其他 runtime 一样生成 CUDA 与 CPU 两份 frozen requirements，并确认 Windows
所需依赖都有可用 wheel，不会在普通用户机器上临时编译 C/C++ 扩展。

### 引擎适配

新增 `ParakeetEngine`，负责：

1. 使用 `ASRModel.from_pretrained()` 加载模型 ID 或本地 `.nemo` 文件。
2. 根据 `auto` / `cpu` / `cuda` 选择设备和可验证的推理精度。
3. 调用离线 `transcribe(..., timestamps=True)`。
4. 把 NeMo 的 `char`、`word`、`segment` 时间戳归一化为 MAW 整数毫秒。
5. 对没有可靠字词映射的结果降级为句段时间戳，不伪造字符边界。
6. 为长音频选择经过实测的分块或 local-attention 策略，并恢复全局时间偏移。

Parakeet 日文模型不应宣称支持热词、说话人分离或自动语言检测。Launcher 可以固定语言
为日语，并对不适用的控件隐藏或禁用。

### Launcher 与模型准备

在 `maw/gui_config.py` 增加一个实验性本地模型条目，并让 runtime 路由从当前的
“普通 local 或 MOSS”扩展为 engine-to-runtime 映射。模型准备流程需要支持：

- Hugging Face `.nemo` 文件下载和统一缓存根目录；
- 约 2.49 GB 模型体积的进度估算；
- 下载取消、继续和缓存重新扫描；
- 指定本地模型路径时验证文件而非目录内的通用权重格式；
- runtime 修复后复用已经下载的模型。

## Spike 方案

这里的 spike 指限时技术探路：只验证最高风险的假设，不实现正式产品功能，也不以
“代码写了多少”衡量结果。

### 时间盒

半天至一天，超过一天仍无法建立最小可运行环境时停止，并记录阻塞点。

### 验证步骤

1. 在不修改 MAW 正式 runtime 的前提下创建临时、独立的 Python 环境。
2. 选择一个候选 NeMo 版本，记录完整的 Python、Torch、CUDA 和 Transformers 版本。
3. 下载 `nvidia/parakeet-tdt_ctc-0.6b-ja`，用 30 秒日语 WAV 验证 CPU 或 CUDA 加载。
4. 分别测试 TDT 和 CTC decoder 的文本、字符/词/句段时间戳输出。
5. 用极短音频、含静音音频和 5 分钟音频检查异常、显存、内存、速度与边界连续性。

### 必须记录的结果

- Windows 原生环境是否可以无编译安装；
- 最小可工作的依赖版本组合；
- 模型加载时间、峰值显存/内存和实时率；
- 实际时间戳字段、单位、文本拼接关系和标点行为；
- TDT 与 CTC decoder 的质量和稳定性差异；
- 短音频和长音频失败方式；
- 是否值得进入正式开发。

### 停止条件

满足任一条件时，先停止正式接入：

- Windows 原生安装依赖需要用户自行配置编译工具链，无法做到 Launcher 一键安装；
- 目标模型在可维护的 NeMo 版本中无法稳定加载；
- TDT 和 CTC 都不能给出可映射到原文的可靠时间戳；
- CPU/CUDA 的资源需求或速度明显不适合 MAW 目标用户；
- 为运行单个模型需要破坏现有 QwenASR/FunASR runtime 的稳定性。

## 待验证的技术问题

### 时间戳

- 该日文 checkpoint 在候选 NeMo 版本中是否支持 `timestamps=True`。
- TDT 返回值是否为单层 `Hypothesis`，还是不同版本中存在嵌套结构差异。
- 日文 `timestamp["char"]`、`timestamp["word"]` 和
  `timestamp["segment"]` 的文本字段名及实际粒度。
- SentencePiece token、日文字符、标点和完整转写文本能否无损重建。
- 极短语音是否触发空 char offsets 等上游已知异常。
- 分块边界是否丢字、重复文本或产生重叠时间戳。

### 平台与资源

- NeMo ASR 的当前依赖是否全部提供 Windows x64 wheel。
- Python 3.11 是否足够稳定，还是应使用独立 Python 3.12 bootstrap。
- Torch 2.13 + CUDA 13.0 是否可用，或是否需要 NeMo 官方测试组合。
- CPU 推理是否有实际使用价值。
- macOS Apple Silicon 是否能安装及使用 MPS，或只能作为未支持平台。
- 安装环境总体积、模型缓存体积和首次安装时间。

### 产品行为

- 第一版是否仅面向 Windows CUDA，还是同时开放 CPU。
- 是否只支持固定模型 ID，避免把 NeMo runtime 扩展成通用模型平台。
- 无字词时间戳时是否允许输出句段级字幕，还是应视为 spike 失败。
- Launcher 中应如何明确展示“日语专用、无热词、无说话人分离”。

## 工作量估算

| 范围 | 预计工作量 | 说明 |
|---|---:|---|
| 技术 spike | 0.5–1 天 | 不进入正式代码，只验证安装、加载和时间戳 |
| 独立 NeMo runtime | 3–8 天 | spec、依赖冻结、worker、安装修复、缓存和自动化测试 |
| Parakeet 引擎与时间戳适配 | 2–4 天 | 模型加载、结果归一化、降级行为和长音频 |
| Launcher、文档与真实环境验收 | 3–5 天 | 模型入口、状态、下载、打包版和 Windows 实机 |
| 完整 Windows 可发布支持 | 合计约 8–15 天 | 取决于 spike 结果，不应在 spike 前承诺固定日期 |
| 再承诺 macOS/Linux | 合计约 10–20 天 | 需要额外安装、设备和打包验收 |

“独立 runtime”本身通常是一周级工作；“用户可稳定使用的完整 Parakeet 支持”才是
半个月左右的工作。若 Windows 依赖需要额外补丁或替代 wheel，周期可能进一步增加。

## 与当前代码的关联位置

| 位置 | 后续可能涉及的职责 |
|---|---|
| `maw/local_asr.py` | `ParakeetEngine`、结果归一化、引擎工厂、分块 |
| `generate_subtitle_local.py` | CLI engine 选项和默认参数 |
| `maw/runtimes/base.py` | 复用公共 runtime 生命周期，原则上不应增加模型特例 |
| `maw/runtimes/local_spec.py` | 当前公共 local runtime，不应直接加入 NeMo |
| `maw/runtimes/moss_spec.py` | 独立 runtime 的参考实现 |
| `maw/runtimes/__init__.py` | 注册 `NEMO` runtime |
| `maw/local_runtime.py` | engine-to-runtime 路由 |
| `maw/local_runtime_worker.py` | 模型准备；也可能拆出 NeMo 专用 worker |
| `maw/local_models.py` | 模型缓存扫描、准备和下载体积估算 |
| `maw/gui_config.py` | Launcher 模型定义和能力声明 |
| `tests/test_local_asr.py` | 时间戳和引擎适配契约测试 |
| `tests/test_local_runtime.py` / `tests/test_runtimes.py` | runtime 生命周期和路由测试 |
| `docs/LOCAL_ASR.md` | 只有正式接入后才更新用户文档 |
| `THIRD_PARTY_NOTICES.md` | 只有正式引入 NeMo runtime 后才补充许可说明 |

## 当前决策

- 本文只沉淀调研，不启动 spike，不新增依赖、模型入口或 runtime。
- `docs/LOCAL_ASR.md`、README 和 Changelog 暂不写入 Parakeet 支持，避免形成已支持的误解。
- 若未来恢复此项工作，先执行本文件中的 spike；根据实测结果重新评估版本选择、平台范围
  和工作量，不直接按当前静态调研进入完整实现。

## 参考资料

- [NVIDIA Parakeet TDT-CTC 0.6B 日文模型卡](https://huggingface.co/nvidia/parakeet-tdt_ctc-0.6b-ja)
- [模型仓库 API 元数据](https://huggingface.co/api/models/nvidia/parakeet-tdt_ctc-0.6b-ja)
- [NeMo Speech 安装文档](https://docs.nvidia.com/nemo/speech/nightly/starthere/install.html)
- [NeMo ASR 推理与时间戳文档](https://github.com/NVIDIA-NeMo/Speech/blob/main/docs/source/asr/inference.rst)
- [NeMo 为 `transcribe()` 增加时间戳支持的 PR #10950](https://github.com/NVIDIA-NeMo/NeMo/pull/10950)
- [Parakeet TDT 长音频时间戳讨论 #13990](https://github.com/NVIDIA-NeMo/NeMo/issues/13990)
- [Parakeet TDT 流式时间戳问题 #14714](https://github.com/NVIDIA-NeMo/NeMo/issues/14714)

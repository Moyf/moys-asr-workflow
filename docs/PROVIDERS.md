# ASR 服务与配置

MAW 本身不托管转写服务。你选择的服务商会直接接收待转写媒体；MAW 只负责本地流程、工程生成和编辑。

## 选择转写方式

| 方式 | 适合场景 | 备注 |
| --- | --- | --- |
| Qwen-Audio / Qwen3-ASR / Fun-ASR | 默认云端路径、中文和说话人分离 | 使用阿里云百炼 API Key；Launcher 默认优先 Qwen-Audio。 |
| Soniox | 多语言、小语种和说话人分离 | 使用 Soniox Console API Key。 |
| 腾讯云录音文件识别 | 中文/英文长音频的异步文件识别 | 使用 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`；大于 5MB 的媒体需使用 COS/公网 URL。 |
| OpenAI（及兼容接口） | 使用 OpenAI 官方服务、OpenRouter 或自己的兼容服务 | Launcher 可选择 OpenAI 官方的 `whisper-1`、`gpt-transcribe`、`gpt-4o-transcribe`、`gpt-4o-mini-transcribe`、`gpt-4o-transcribe-diarize`，OpenRouter 的 `whisper-large-v3-turbo`、`whisper-large-v3`，或“自定义（Custom）”；接口必须返回 `segments` 或 `words` 时间戳。 |
| 必剪 ASR | 不想申请 Key 的中文快速体验 | 实验性、非官方接口，可能限流或失效。 |
| 本地 Qwen3-ASR / FunASR | 希望离线转写且有合适硬件 | 实验性，需要单独安装运行环境和模型。 |

## API Key 配置

- 图形版：在 Launcher 中填写并保存到本机环境。
- Release 包：优先读取应用程序同目录的 `.env`；不存在时使用 MAW 用户数据目录中的 `.env`，Windows 路径为 `%LOCALAPPDATA%\MAW\.env`。
- 源码或 CLI：继续使用仓库根目录的 `.env`；可从 `.env.example` 复制后填写 `DASHSCOPE_API_KEY`、`SONIOX_API_KEY`、腾讯云的 `TENCENT_SECRET_ID` 与 `TENCENT_SECRET_KEY`，或 OpenAI（及兼容接口）的 `MAW_OPENAI_ASR_API_KEY`。
- OpenAI（及兼容接口）：在 Launcher 选择“OpenAI（及兼容接口）”，从“模型”下拉列表选择模型；选择“自定义（Custom）”后再填写自定义模型名。Base URL 为 OpenRouter 时，内置模型会自动发送完整的 `openai/...` 模型 ID；其他中转站不会自动猜测模型名，请选择“自定义（Custom）”并填写服务商提供的完整模型名。兼容服务需要填写 `MAW_OPENAI_ASR_BASE_URL`，模型与 API Key 分别保存到 `MAW_OPENAI_ASR_MODEL` 和 `MAW_OPENAI_ASR_API_KEY`；程序调用 `POST {Base URL}/audio/transcriptions`。
- API Key 只应保存在环境变量或本机 `.env` 中，不要放进命令行、工程、日志、截图或 AI 对话。
- Qwen Key 申请见[阿里云百炼官方文档](https://help.aliyun.com/zh/model-studio/get-api-key)；Soniox Key 见 [Soniox Console](https://console.soniox.com)。
- OpenAI 官方或 OpenRouter API Key 见 [OpenAI Platform](https://platform.openai.com/api-keys) 或 [OpenRouter](https://openrouter.ai/keys)。
- OpenAI 官方当前用于文件转写的模型包括 `gpt-transcribe`、`gpt-4o-transcribe`、`gpt-4o-mini-transcribe`、`gpt-4o-transcribe-diarize` 和 `whisper-1`；`GPT-Live-Transcribe`、`GPT-Realtime-Whisper` 属于实时转写产品线，当前 Launcher 尚未预置。`whisper-large-v3` 与 `whisper-large-v3-turbo` 不是 OpenAI 官方 `/v1/audio/transcriptions` 模型 ID，而是作为 OpenRouter 模型提供；详见 [OpenAI 模型目录](https://developers.openai.com/api/docs/models/all)。
- OpenAI 官方支持的高级参数按模型区分：Launcher 会为支持的模型显示 `Prompt`；`gpt-transcribe` 还显示逐行 `Keywords`；选择 `gpt-4o-transcribe-diarize` 后自动使用 `diarized_json` 和 `chunking_strategy=auto`，并可把返回的 `speaker` 标签写入工程。OpenRouter 不支持 diarize；其他兼容服务也不一定转发这些参数。
- 腾讯云密钥见[API 密钥管理](https://console.cloud.tencent.com/tokenhub/apikey)；录音文件识别使用 `CreateRecTask` / `DescribeTaskStatus`，默认引擎为 `16k_zh_en_2.0`。
- 腾讯云的 `Words` 结果包含字词级毫秒时间码；传入 `--speaker` 会启用说话人分离并保留匿名 speaker 标签。完整示例见[完整工作流](WORKFLOW.md)。
- 默认 Base URL 为 `https://api.openai.com/v1`，模型为支持词级时间戳的 `whisper-1`；使用 OpenRouter 时可直接选择内置模型，使用其他兼容服务时请用“自定义（Custom）”填写服务商文档中的模型 ID。若服务只返回 `{ "text": "..." }` 而没有时间戳，MAW 会拒绝生成字幕，因为无法可靠对轨。

区域、模型、热词、上下文和完整参数见[完整工作流](WORKFLOW.md)与[CLI 文档](CLI.md)。

## 费用

- Launcher 会在模型说明中显示云端 API 的参考价格；价格、免费额度、区域和套餐会变化，请以服务商页面为准。
- 阿里云百炼的 `qwen-audio-3.0-asr-flash-filetrans`、`qwen3-asr-flash-filetrans` 和 `fun-asr`：北京为 ¥0.00022 / 秒（约 ¥0.792 / 小时），新加坡为 ¥0.00026 / 秒（约 ¥0.936 / 小时），音频输出免费；详见[阿里云模型定价](https://help.aliyun.com/zh/model-studio/model-pricing)。
- Soniox `stt-async-v5`：异步文件转写约 $0.10 / 小时，实际按 token 计费；详见 [Soniox Pricing](https://soniox.com/pricing)。
- 腾讯云 `16k_zh_en_2.0`：录音文件识别大模型 2.0 后付费 ¥0.8 / 小时，60 小时预付包 ¥48；详见[腾讯云语音识别计费概述](https://cloud.tencent.com/document/product/1093/35686)。
- OpenAI 官方 `whisper-1` 为 $0.006 / 分钟，`gpt-transcribe` 为 $0.0045 / 分钟，`gpt-4o-transcribe` 为输入 $2.50 / 1M audio tokens、输出 $10 / 1M audio tokens，`gpt-4o-mini-transcribe` 为输入 $1.25 / 1M audio tokens、输出 $5 / 1M audio tokens；`gpt-4o-transcribe-diarize` 使用 GPT-4o Transcribe 的 token 价格；详见 [OpenAI 模型目录](https://developers.openai.com/api/docs/models/all)。
- OpenRouter 模型页当前显示的参考价格如下；价格、路由和模型能力会变化，实际请求以 [OpenRouter 模型目录](https://openrouter.ai/models?fmt=cards&input=audio) 为准。

  | 模型 | OpenRouter 参考价 |
  | --- | --- |
  | [`openai/whisper-1`](https://openrouter.ai/openai/whisper-1) | $0.006 / 分钟 |
  | [`openai/gpt-transcribe`](https://openrouter.ai/openai/gpt-transcribe) | $0.0045 / 分钟 |
  | [`openai/gpt-4o-transcribe`](https://openrouter.ai/openai/gpt-4o-transcribe) | 输入 $2.50 / 1M tokens，输出 $10 / 1M tokens |
  | [`openai/gpt-4o-mini-transcribe`](https://openrouter.ai/openai/gpt-4o-mini-transcribe) | 输入 $1.25 / 1M tokens，输出 $5 / 1M tokens |
  | [`openai/whisper-large-v3-turbo`](https://openrouter.ai/openai/whisper-large-v3-turbo) | $0.04 / 小时 |
  | [`openai/whisper-large-v3`](https://openrouter.ai/openai/whisper-large-v3) | $0.0015 / 分钟 |

- 必剪 ASR 没有稳定的配额或服务承诺，请只把它当作应急体验入口。
- 本地模型不产生云端转写费用，但会消耗本机的存储、显存/内存和计算资源。

## 数据与隐私边界

- MAW 没有自己的云端服务器；云端转写时，媒体直接发送给你选择的服务商。
- 编辑器、工程保存和导出默认在本机完成。`.mosp` 是字幕工程真源，SRT 只保留交付所需的基本字幕信息。
- Launcher 的 LLM 后处理只发送带临时 ID 的字幕文字，不发送媒体路径、时间码或工程元数据；详见 [LLM 字幕后处理协议](LLM_POSTPROCESS_PROTOCOL.md)。
- 使用任何第三方服务前，请自行确认其数据保留、训练使用和账户政策。

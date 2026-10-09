---
layout: "../../layouts/DocLayout.astro"
title: "ASR 服务与配置"
description: "服务商选择、API Key、费用和隐私边界。"
source: "docs/PROVIDERS.md"
---

<!-- Generated from docs/PROVIDERS.md. Run pnpm run sync:docs to refresh. -->

MAW 不托管转写服务。云端方式把音频直接交给所选服务商，本地方式在本机推理。以下描述 MAW 当前适配范围；服务可用性、额度和限制以账户控制台为准。

## 配置速查

| 方式 | 本机配置字段 | MAW 中的入口与边界 |
| --- | --- | --- |
| 阿里云 Qwen / Fun-ASR | `DASHSCOPE_API_KEY` | 默认 Qwen-Audio 3.0；可选 3.1、Qwen3-ASR、Fun-ASR。模型间的热词、上下文与说话人能力不同。 |
| Soniox | `SONIOX_API_KEY` | 多语言、说话人和结构化 context。 |
| 豆包（火山引擎） | `VOLC_API_KEY` | 单 Key；支持热词、说话人，使用压缩音频 Base64 提交。 |
| 腾讯云录音文件识别 | `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY` | 默认 `16k_zh_en_2.0`；大文件使用公网 / COS URL。 |
| OpenAI 兼容 ASR | `MAW_OPENAI_ASR_API_KEY`、`MAW_OPENAI_ASR_BASE_URL`、`MAW_OPENAI_ASR_MODEL` | multipart 转写接口，必须返回字幕时间戳；默认地址 `https://api.openai.com/v1`，默认模型 `whisper-1`。 |
| 必剪 | 无需 Key | 实验性非公开接口，仅用于中文体验，可能限流或失效。 |
| 本地模型 | 无需云端 Key | 实验入口，需独立运行环境与权重，见 [LOCAL_ASR](../local-asr/)。 |

## 保存与读取配置

在 Launcher 选择服务并保存配置，或从 `.env.example` 创建自己的 `.env`。Key 只存本机，不写工程，不应出现在命令行、日志、截图或对话中。

- 源码运行：读取仓库根目录 `.env`。
- 打包应用：优先使用应用程序同目录 `.env`，不存在时回退到 MAW 用户数据目录。
- 用户数据目录：Windows `%LOCALAPPDATA%/MAW`；macOS `~/Library/Application Support/MAW`；Linux `$XDG_DATA_HOME/MAW`（未设置时 `~/.local/share/MAW`）。
- 环境变量优先于 `.env`。修改文件却不生效时，检查是否有同名环境变量覆盖。

获取密钥：[阿里云百炼](https://platform.qianwenai.com/home/)、[Soniox Console](https://console.soniox.com)、[火山引擎 API Key](https://console.volcengine.com/speech/new/setting/apikeys)、[腾讯云密钥管理](https://console.cloud.tencent.com/tokenhub/apikey)、[OpenAI Platform](https://platform.openai.com/api-keys)、[OpenRouter](https://openrouter.ai/keys)。

## 阿里云：地域、模型与提示

Qwen 与 Fun-ASR 共用 Key。北京默认 `DASHSCOPE_REGION=beijing`，Workspace ID 可选；新加坡设为 `singapore` 并填写 `DASHSCOPE_WORKSPACE_ID`。Key、地域和业务空间必须匹配。Launcher 的 AI 模型配置提供对应设置。

| 模型 | 当前 MAW 适配 |
| --- | --- |
| `qwen-audio-3.0-asr-flash-filetrans` | 默认；即时热词、上下文和说话人分离。 |
| `qwen-audio-3.1-asr-flash-filetrans` | 同类增强设置，另支持保留方言表达。 |
| `qwen3-asr-flash-filetrans` | 字词时间码；不支持通用说话人开关。 |
| `fun-asr` | 字词时间码和说话人分离；词表配置独立于 Qwen-Audio。 |

上下文提供背景或前文，即时热词提供短术语，二者可以同时使用。Qwen-Audio context 最多发送 400 字符；热词文件支持每行一个词或 `词: 权重`。CLI 权重支持 1–5 或 50，单词条可以覆盖全局权重；不符合限制的词条会提示并忽略。预编译词表必须为目标模型创建，Launcher 不提供词表 ID 输入，底层 CLI / `.env` 仍支持。

参数和示例集中在 [CLI](../cli/)，权限或地域报错看 [FAQ](../faq/)。

## 其他云端服务

### Soniox

语言提示可用 `zh,en` 等逗号分隔值。context 分为 `general`、`text`、`terms`、`translation_terms`，Launcher 提供文本输入，公开 CLI 用 `--soniox-context-json`。转写结束后程序尝试删除云端文件与转写记录；删除动作不能代替服务商的数据政策。

### 豆包

模型通过 `VOLC_ASR_RESOURCE_ID` 或 CLI `--model` 指定，默认 `volc.seedasr.auc`。MAW 提取 Ogg / Opus 单声道压缩音频后提交；当前通道按 25 MB / 120 分钟限制处理，未接入 Files API 大文件通道。使用 `--hotword` 添加术语；该入口不接受 Qwen 的地域、词表 ID 或 file-url 参数。

### 腾讯云

本地直传通道按 5 MB 限制处理，较大输入需先提供公网 / COS URL，并使用 `--file-url`。字词时间码映射为工程 `items`；支持的引擎可以通过 `--speaker` 请求匿名说话人标签。

### OpenAI 兼容接口

Base URL 可填写根地址、`/v1` 地址或完整 `/audio/transcriptions` 地址。服务必须接受 multipart 请求，普通模式返回 `segments` 或 `words` 的 `start/end`；仅返回 `text` 的接口会被拒绝。

Launcher 为 OpenRouter 的内置模型自动补完整 `openai/...` ID，公开 CLI 不猜测前缀。其他兼容服务请选自定义模型并填写其实际 ID。Launcher 的模型列表表示程序已有适配，不保证每个账户或中转站都提供对应服务。

Prompt、Keywords 和 diarized JSON 按模型能力使用。Launcher 与底层 `generate_subtitle_openai_api.py` 提供这些增强入口，公开 `MAW.exe` CLI 当前仅提供基础兼容转写参数；不要把底层脚本参数直接传给它。说话人模式不能与 Prompt / Keywords 混用。

## 费用与数据政策

价格、免费额度、计费单位和数据保留会变化。Launcher 的参考价与日志估算用于初步判断，不代表实际账单；本文不重复保存固定价格表。

请查当前官方说明：[阿里云定价](https://help.aliyun.com/zh/model-studio/model-pricing)、[Soniox 定价](https://soniox.com/pricing)、[火山引擎控制台](https://console.volcengine.com/speech/new/experience/asr)、[腾讯云计费](https://cloud.tencent.com/document/product/1093/35686)、[OpenAI 定价](https://openai.com/api/pricing/)、[OpenRouter 模型目录](https://openrouter.ai/models)。本地推理不产生云端转写费，但需要下载、存储与计算资源。

编辑和保存默认在本机。LLM 后处理发送临时 cue ID 与字幕文字，AI 整理另发送文稿文字，不发送媒体、时间码或路径；协议见 [LLM_POSTPROCESS_PROTOCOL](../llm-postprocess/)。使用云端服务前应确认该服务的数据保留和训练使用政策。

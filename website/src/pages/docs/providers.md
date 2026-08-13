---
layout: "../../layouts/DocLayout.astro"
title: "ASR 服务与配置"
description: "服务商选择、API Key、费用和隐私边界。"
source: "docs/PROVIDERS.md"
---

<!-- Generated from docs/PROVIDERS.md. Run npm run sync:docs to refresh. -->

# ASR 服务与配置

MAW 本身不托管转写服务。你选择的服务商会直接接收待转写媒体；MAW 只负责本地流程、工程生成和编辑。

## 选择转写方式

| 方式 | 适合场景 | 备注 |
| --- | --- | --- |
| Qwen-Audio / Qwen3-ASR / Fun-ASR | 默认云端路径、中文和说话人分离 | 使用阿里云百炼 API Key；Launcher 默认优先 Qwen-Audio。 |
| Soniox | 多语言、小语种和说话人分离 | 使用 Soniox Console API Key。 |
| 必剪 ASR | 不想申请 Key 的中文快速体验 | 实验性、非官方接口，可能限流或失效。 |
| 本地 Qwen3-ASR / FunASR | 希望离线转写且有合适硬件 | 实验性，需要单独安装运行环境和模型。 |

## API Key 配置

- 图形版：在 Launcher 中填写并保存到本机环境。
- 源码或 CLI：复制 `.env.example` 为 `.env`，填写 `DASHSCOPE_API_KEY` 或 `SONIOX_API_KEY`。
- API Key 只应保存在环境变量或本机 `.env` 中，不要放进命令行、工程、日志、截图或 AI 对话。
- Qwen Key 申请见[阿里云百炼官方文档](https://help.aliyun.com/zh/model-studio/get-api-key)；Soniox Key 见 [Soniox Console](https://console.soniox.com)。

区域、模型、热词、上下文和完整参数见[完整工作流](../workflow/)与[CLI 文档](../cli/)。

## 费用

- Qwen 和 Soniox 的免费额度、计费方式与价格会变化，请以[阿里云模型定价](https://help.aliyun.com/zh/model-studio/model-pricing)和 [Soniox Pricing](https://soniox.com/pricing) 为准。
- 必剪 ASR 没有稳定的配额或服务承诺，请只把它当作应急体验入口。
- 本地模型不产生云端转写费用，但会消耗本机的存储、显存/内存和计算资源。

## 数据与隐私边界

- MAW 没有自己的云端服务器；云端转写时，媒体直接发送给你选择的服务商。
- 编辑器、工程保存和导出默认在本机完成。`.mosp` 是字幕工程真源，SRT 只保留交付所需的基本字幕信息。
- Launcher 的 LLM 后处理只发送带临时 ID 的字幕文字，不发送媒体路径、时间码或工程元数据；详见 [LLM 字幕后处理协议](../llm-postprocess/)。
- 使用任何第三方服务前，请自行确认其数据保留、训练使用和账户政策。

---
layout: "../../layouts/DocLayout.astro"
title: "ASR 供应商调研"
description: "Fun-ASR、Qwen 和豆包录音文件识别能力的接口对照与接入记录。"
source: "docs/ASR_PROVIDER_RESEARCH.md"
---

<!-- Generated from docs/ASR_PROVIDER_RESEARCH.md. Run npm run sync:docs to refresh. -->

# ASR 供应商调研：Fun-ASR 与豆包大模型录音文件识别

> 调研日期：2026-07-28
> 接入状态：百炼云端 `qwen-audio-3.0-asr-flash-filetrans` 与 `fun-asr` 已在当前 Unreleased 版本接入；豆包仍是候选方案。本文不代替真实素材上的准确率、时间戳和说话人分离测试。

## 结论

- **阿里云百炼云端 `fun-asr`** 基本覆盖 MAW 当前从
  `qwen3-asr-flash-filetrans` 使用的能力：长音频异步转写、自动分句、标点、
  词级毫秒时间戳、自动语种识别和 ITN。它还支持说话人分离、热词和敏感词处理。
- 对 MAW 而言，`fun-asr` 的返回结构可以直接映射到现有 JSON：
  `sentences[]` 对应 `segments[]`，`words[]` 对应 `items[]`，
  `speaker_id` 转成字符串后对应 `speaker`。
- 这不表示 Fun-ASR 与 Qwen-ASR 的**识别准确率相同**。接口能力基本等价，
  但中文口语、多人重叠、音乐背景、方言、专有名词和字级时间戳质量仍需用同一批素材实测。
- **豆包大模型录音文件识别极速版并非只能接收 URL**。官方接口允许
  `audio.url` 与 `audio.data` 二选一，其中 `audio.data` 是 Base64 编码的本地音频。
- 豆包标准版、闲时版等异步长音频接口仍主要采用 URL。最稳妥的处理方式是把文件上传到
  私有对象存储，再生成短时有效的预签名 HTTPS GET URL；不需要把整个 bucket 设为公开。

## 名称需要先区分

“FunASR”可能指两件不同的东西：

1. **阿里云百炼云端模型 `fun-asr`**：用 DashScope API 调用，符合 MAW
   当前的 API-first 产品边界，已作为百炼 Provider 的第二模型接入。
2. **开源 FunASR 工具箱**：在本机或自有服务器加载 Paraformer、CAM++、VAD、
   标点等模型组成流水线。它也能做时间戳和说话人分离，但会引入本地模型、PyTorch、
   模型下载和设备适配，不应作为 MAW 的默认接入。

开源工具箱的“支持说话人分离”是由 VAD、ASR、CAM++ 等组件组合得到的，
不能理解为任意一个 FunASR 模型天然同时拥有所有能力。官方仓库也明确列出了
`vad_model`、`punc_model` 和 `spk_model` 组成的流水线。

## 与 MAW 当前 Qwen 路径的能力对照

| 能力 | Qwen3-ASR-Flash-Filetrans | Qwen-Audio-3.0-ASR-Flash-Filetrans | 百炼云端 Fun-ASR | 豆包大模型录音文件识别 |
|---|---|---|---|---|
| 长音频异步转写 | 支持，最大 12 小时 / 2 GB | 支持，最大 12 小时 / 2 GB | 支持，最大 12 小时 / 2 GB | 标准版支持长音频；官方产品说明为小于 5 小时、512 MB |
| 句级时间戳 | 支持 | 支持，固定开启 | 支持，固定开启 | 支持 |
| 字/词级时间戳 | `enable_words=true`；部分语种精度有保证 | 支持，固定开启 | 支持，固定开启 | 支持 |
| 自动分句与标点 | 支持 | 支持 | 支持 | 支持 |
| ITN 数字规整 | 支持 | 支持 | 支持 | 支持 |
| 自动语种识别 | 支持 | 支持 | 支持 | 支持 |
| 说话人分离 | 不支持 | 支持，返回句级 `speaker_id` | 支持，返回句级 `speaker_id` | 支持，返回句级 speaker 信息 |
| 热词 | 当前 Qwen Filetrans 不支持 | 支持即时 `vocabulary` 与预编译 `vocabulary_id` | 支持预建词表 | 支持平台级、请求级热词 |
| 上下文增强 | 当前入口未发送 | 支持 `input.messages` | 当前入口未发送 | 需按具体接口核对 |
| 情感识别 | 支持，但 MAW 当前没有写入工程 | 不支持 | 不支持 | 产品能力支持；极速版移除了部分客服能力字段，需按具体接口核对 |
| 本地文件直传 | MAW 先上传到 DashScope 临时 OSS | MAW 先上传到 DashScope 临时 OSS | API 本身收 URL；可复用同类临时 OSS 流程 | 极速版支持 Base64；标准/闲时版主要收 URL |

### Qwen-Audio 的关键限制

- Qwen-Audio 的 REST 请求使用 `input.file_urls` 数组，单次仍只支持一个 URL；成功轮询结果位于 `output.results[]`。
- 即时热词权重取 1–5 或 50；权重 50 是超级热词，数量最多 50 个。预编译词表必须按 Qwen-Audio 目标模型创建。
- `input.messages` 用于专有词汇和领域上下文增强，每轮总长度最多 400 字符；MAW 的 `--context` / `--context-file` 发送一个 `user/input_text` 消息。
- 说话人分离只适用于单声道，官方建议启用时音频不超过 2 小时。

### Fun-ASR 的关键限制

- 说话人分离通过 `diarization_enabled: true` 开启，只支持单声道。
- 开启说话人分离时，官方建议音频控制在 2 小时以内，否则可能失败或超时。
- `speaker_count` 可提供 2–100 的人数提示，但只是提示，不保证返回完全相同的人数。
- 说话人标签是匿名聚类 ID，不是现实姓名；这正好符合 MAW 将供应商 ID
  作为 opaque string 保存的 JSON 契约。
- 多人同时说话、极短插话、相似声线和强背景音乐仍是 diarization 的常见难点，
  需要单独测试，不能只凭“支持”判断效果。

## Fun-ASR 在 MAW 中的实现

现有 Qwen Filetrans 已经实现：

```text
本地媒体
  -> FFmpeg 提取音频
  -> 获取 DashScope 临时 OSS 上传凭证
  -> 上传并得到 oss:// URL
  -> 提交异步任务
  -> 轮询
  -> 下载结果 JSON
  -> 转成 MAW segments/items
```

云端 Fun-ASR 可以复用其中大部分基础设施，但接口字段并非只改模型名：

| 环节 | Qwen Filetrans | Fun-ASR |
|---|---|---|
| 输入字段 | `input.file_url` | `input.file_urls`，数组但单次只允许一个 URL |
| 语种提示 | `parameters.language` | `parameters.language_hints`，当前只读取第一个值 |
| 词级时间戳 | `enable_words=true` | 固定开启 |
| 说话人 | 不支持 | `diarization_enabled=true`，可选 `speaker_count` |
| 完成结果 URL | `output.result.transcription_url` | `output.results[0].transcription_url` |
| 句说话人字段 | 无 | `sentences[].speaker_id` |

当前实现保留 `generate_subtitle_qwen_api.py` 作为百炼文件转写统一入口，但在脚本内部
按模型选择独立的提交 payload、轮询结果路径和解析器，并复用 DashScope 上传、
SRT/JSON 生成及已有 speaker 颜色逻辑：

- CLI 使用 `--model fun-asr` 或 `--model qwen-audio-3.0-asr-flash-filetrans` 选择模型，
  `--speaker` / `--speaker-colors` 控制说话人分离和颜色快照。
- Web Launcher 把 Qwen-Audio 和 Fun-ASR 放在同一个百炼 Provider 下，并按模型切换支持语言、
  说话人开关和默认 `.qwen-audio.srt` / `.fun-asr.srt` 输出名。
- Qwen-Audio 的即时热词、预编译 `vocabulary_id` 和 `input.messages` 已接入；
  `hotwords.txt` 只对 Qwen-Audio 作为即时热词发送。
- Fun-ASR 的句级 `speaker_id` 会复制到对应 `items[]`，切句前先按 speaker
  变化硬切，确保一个 MAW segment 不跨说话人。
- 提交、成功/失败轮询、结果解析、说话人边界和零时长修复均有离线契约测试。
- DashScope HTTP 错误会保留业务 `code`、`message` 和 `request_id`；北京地域配置
  Workspace ID 后使用官方推荐的业务空间专属域名，未配置时保留兼容域名。
- 实测 `AccessDenied: Access denied by API-Key restrictions.` 属于 API Key 自定义权限：
  需要把权限设为“全部”，或把 `fun-asr` 加入可访问模型并核对 IP 白名单；子业务
  空间还需具备 Fun-ASR 模型调用授权。

仍未实现的部分：

1. 使用固定真实素材比较 Qwen、Fun-ASR、Soniox 的识别质量与时间戳偏差。
2. 百炼词表的创建/管理界面；当前需要在百炼控制台创建目标模型匹配的词表，
   再通过 `.env` 或 `--vocabulary-id` 使用。
3. `speaker_count` 人数提示；当前让服务自动判断人数。

## 豆包 `audio_url` 的解决办法

### 方案 A：极速版使用 Base64，适合先做本地文件接入

极速版请求体支持：

```json
{
  "audio": {
    "data": "<Base64 编码的音频>"
  },
  "request": {
    "model_name": "bigmodel",
    "enable_itn": true,
    "enable_punc": true,
    "enable_speaker_info": true
  }
}
```

官方限制是：

- 音频不超过 2 小时；
- 文件不超过 100 MB；
- 支持 WAV、MP3、OGG/Opus；
- 二进制内容建议尽量控制在 20 MB 以内，实际还受用户上行带宽影响；
- Base64 会令请求体约增大三分之一，并要求客户端把完整音频和编码结果放进内存。

MAW 当前为 Qwen 提取的 16 kHz、16-bit、单声道 WAV 每小时约 115 MB，
不能直接沿用到豆包 Base64 路径。豆包 adapter 应改为提取单声道 MP3 或 Opus，
并在编码前检查**压缩后文件**的体积。不要为了卡进 20 MB 而过度压缩，
否则节省上传时间可能换来识别和说话人分离质量下降。

### 方案 B：对象存储预签名 URL，适合标准版和长文件

推荐流程：

```text
本地媒体
  -> 提取/压缩音频
  -> 上传到私有 TOS、OSS、S3 或兼容对象存储
  -> 生成短时有效的预签名 HTTPS GET URL
  -> 提交豆包异步任务
  -> 等待任务完成
  -> 删除对象
```

注意事项：

- URL 必须能从火山引擎服务端访问，`127.0.0.1`、局域网地址和本机文件路径都不行。
- 预签名 URL 的有效期必须覆盖排队与识别时间，并留出余量。
- bucket 可以保持私有；只让单个对象在签名有效期内可下载。
- 客户端应在成功和失败路径都尝试删除临时对象，并明确提示残留清理方式。
- 不应把现有只监听 `127.0.0.1` 的 MAWE 编辑器服务器改成公网文件服务器。
- 临时隧道虽然技术上可行，但会扩大攻击面、依赖本机持续在线且容易中断，
  不适合作为公开分发的 MAW 默认方案。

### 方案 C：切片后逐段 Base64，不建议作为说话人模式的首选

切片可以绕开单请求体积或时长限制，但会增加这些问题：

- 每片时间戳需要加回全局 offset；
- 切点附近需要重叠、去重和重新分句；
- 每片返回的 speaker ID 是独立聚类结果，`speaker 1` 不保证跨片仍是同一个人；
- 若要稳定合并说话人，需要额外的全局声纹聚类，已经超出简单 API adapter 的范围。

因此，普通字幕可以考虑切片兜底；需要说话人分离时，应尽量让整段音频在一次任务内完成，
或使用对象存储 URL 调用标准版。

## 豆包到 MAW JSON 的映射

豆包结果中的 `utterances[]` 已包含句级 `start_time`、`end_time`、`text`
和 `words[]`；开启说话人后，句级 speaker 信息可映射到 MAW：

```text
utterance.start_time       -> segment.start
utterance.end_time         -> segment.end
utterance.text             -> segment.text
utterance.words[]          -> segment.items[]
utterance speaker          -> segment.speaker（转成 string）
```

若豆包只在句级返回 speaker，MAW 可给该句的所有 `items[]` 复制同一 speaker。
遇到同一句内实际换人时，应按供应商 utterance 边界拆段，不能把两个 speaker 合进同一
MAW segment。

## 推荐决策

从接入成本、现有凭证和 MAW 边界看：

1. **百炼云端 Fun-ASR 已接入**。它与 Qwen 共用 DashScope 账户和大部分传输链路，
   返回结构也正好满足现有 speaker JSON 契约。
2. **豆包先做极速版 Base64 的实验 adapter**，限定短文件，并自动转成合适的
   MP3/Opus；这可以在不要求用户配置对象存储的情况下验证识别质量。
3. 豆包质量验证通过后，再增加 `--file-url` 和可选 TOS 上传。标准/闲时版的自动上传、
   对象清理、URL 有效期和错误恢复应作为一组完整功能实现。
4. 最终是否成为正式供应商，应基于固定测试集比较文本错误、时间戳偏差、
   说话人错误、耗时、价格和失败恢复，而不是只比较官网能力表。

## 最小验证集

每个已接入或候选供应商至少用下列素材验证：

- 单人普通话，安静环境，2–5 分钟；
- 两人访谈，包含短插话和连续轮换；
- 三人以上会议，包含重叠说话；
- 中英混说、方言、专有名词；
- 带背景音乐或环境噪声的视频；
- 30–120 分钟长音频。

除全文错误率外，还应记录：

- `items[]` 的文本能否无损拼回 `segment.text`；
- 字/词时间戳是否单调、是否存在明显漂移；
- speaker 是否在相邻句无故抖动；
- 说话人变化处是否正确切段；
- 上传、轮询、结果下载和临时文件清理是否都能从失败中恢复。

## 官方资料

- [阿里云百炼：语音识别模型选型与规格](https://help.aliyun.com/zh/model-studio/asr-model/)
- [阿里云百炼：非实时语音识别](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide)
- [阿里云百炼：Fun-ASR HTTP API](https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api)
- [FunASR 开源工具箱](https://github.com/modelscope/FunASR)
- [火山引擎：豆包语音大模型产品说明](https://www.volcengine.com/docs/6561/1354871?lang=zh)
- [火山引擎：大模型录音文件极速版识别 API](https://www.volcengine.com/docs/6561/1631584?lang=zh)
- [火山引擎：录音文件识别标准版 API](https://www.volcengine.com/docs/6561/80820?lang=zh)
- [火山引擎：录音文件识别闲时版 HTTP API](https://www.volcengine.com/docs/6561/1840838?lang=zh)

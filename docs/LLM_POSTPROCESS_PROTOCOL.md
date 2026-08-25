# LLM 字幕后处理协议

这份协议定义 MAW Launcher 如何让 OpenAI-compatible LLM 修改字幕文字，同时保证模型不能写入字幕时间。它是工具箱实现契约，不是工程 schema 的替代品；工程结构仍以 [JSON_SCHEMA.md](../JSON_SCHEMA.md) 为准。

## 1. 信任边界

本地工程的 `segments[*].start/end` 是唯一时间真源，单位始终为整数毫秒。普通校对、改写和翻译请求不包含时间码、媒体路径、逐词时间或其他工程元数据。重新断句在所有输入字幕都有完整 `items` 时使用单独的 atom 协议：请求可以包含不透明 atom ID 和文字，但仍不包含时间、媒体路径或其他工程元数据。

发送给模型的用户消息是一个按原字幕顺序排列的数组：

```json
[
  { "id": "c0001", "text": "第一条字幕" },
  { "id": "c0002", "text": "第二条字幕" }
]
```

`id` 是本次请求临时生成的不透明标识，只表达原字幕顺序。它不是时间、工程主键，也不会写入输出工程。

重新断句的 item-aware 请求会在 cue 中附带只读 atom：

```json
{
  "id": "c0001",
  "text": "第一条字幕",
  "items": [
    { "id": "c0001a0001", "text": "第一" },
    { "id": "c0001a0002", "text": "条字幕" }
  ]
}
```

## 2. 模型返回格式

普通校对、改写和非翻译任务返回一个 JSON 对象，顶层只有 `groups` 协议字段有意义：

```json
{
  "groups": [
    { "source_ids": ["c0001"], "text": "校对后的第一条字幕" },
    { "source_ids": ["c0002"], "text": "校对后的第二条字幕" }
  ]
}
```

为兼容只改文字的简单响应，单个 `id` 字段等同于只含一个元素的 `source_ids`。返回中的 `start`、`end` 或其他额外字段不会成为输出时间来源。

翻译任务使用严格的一对一格式，每条输入 cue 对应一个同 ID 的 group：

```json
{
  "groups": [
    { "id": "c0001", "text": "First subtitle" },
    { "id": "c0002", "text": "Second subtitle" }
  ]
}
```

翻译解析器为兼容旧模型，也接收只含一个元素的 `source_ids`，并允许它和规范 `id` 格式混合出现；含多个元素的 `source_ids` 在翻译任务中始终无效。

重新断句的 item-aware 响应只返回 atom 分组，不返回文字或时间：

```json
{
  "groups": [
    { "atom_ids": ["c0001a0001"] },
    { "atom_ids": ["c0001a0002", "c0002a0001"] }
  ]
}
```

`atom_ids` 必须连续、按输入顺序完整覆盖且每个只出现一次。模型不能借此改写文字；本地会从原工程 item 重建每组文字、时间和逐词 `items`。

## 3. ID 覆盖规则

本地解析器在写文件前强制检查以下规则：

1. 所有输入 ID 必须完整覆盖，不能遗漏或添加未知 ID。
2. ID 必须保持原顺序，不能重排。
3. 合并只能合并连续字幕，例如 `source_ids: ["c0001", "c0002"]`。
4. 拆分只能让相邻多个 group 重复同一个 ID，例如两个连续 group 都使用 `c0001`。
5. 每个 group 的 `text` 必须是非空字符串。

翻译任务额外要求每个输入 ID 恰好出现一次，禁止合并、拆分、重排、遗漏、重复或添加未知 ID。

本地会先对每个 group 做独立校验。普通任务中，结构化 JSON 缺少 `source_ids`、`text` 为空、ID 未知或顺序错误时，只跳过该 group 及其无法安全归属的源字幕；只要仍有合规字幕，其他字幕可以生成输出产物。翻译任务不会写出部分结果：解析器只对无效或遗漏的 cue 做拆分补救，每批最多追加 32 次请求；达到上限仍未补齐时终止、不创建产物，并报告全部未完成 cue ID。JSON 语法损坏无法安全定位 group，客户端会自动重试一次；重试后仍不是合法 JSON 时终止本次处理，不写出结果。

单次请求最多发送 40 条字幕，且输入字幕文字总长度约不超过 4,000 个字符；任意一项达到上限就会在本地按原顺序切分批次。更大的工程会保留全局 cue ID 后再统一校验和写出；为保持批次隔离，模型不能跨批次合并或拆分字幕。超过单批字符上限的单条字幕会单独成批，不会被本地强行拆分。

普通任务若有 group 不合规，Launcher 会在处理完成提示中列出每条被跳过字幕的全局序号、cue ID、批次、模型组号、跳过原因和原文摘要；只要仍有合规字幕就可写出其余产物。翻译任务的错误报告同样包含未完成 ID 和原因，但不会写出缺行的部分译文。

## 4. 本地时间映射

- 一对一修改：复制原段 `start/end`。
- 合并连续字幕：使用首个源段的 `start` 和最后源段的 `end`。
- 拆分单个字幕：按照拆分数量在原段时间槽内本地等分；如果原时长不足以让每段保持正时长，则拒绝结果。
- 模型返回的任何时间字段都不参与计算。

固定替换会在等长改字时按原 item 边界更新文字；长度变化时只合并受影响 item，并继承首尾时间范围。普通 LLM 校对、改写和文稿匹配会复用未改写或有明确局部 diff 的 item；整段大幅改写、无法映射的合并/拆分会移除受影响 item。发生合并或拆分时，位置相关的贴纸和颜色引用也不会复制到新段；一致的安全标量（例如说话人标签）可在连续来源一致时保留。翻译结果不保留逐词 `items`，自动管线会将它作为无 items 的副字幕，同时保留翻译前主轨。

## 5. 文件与链式处理

处理结果使用原输入目录和操作后缀生成，例如 `clip.proofread.mosp`、`clip.proofread.srt`。同名文件已存在时会追加递增编号。写入采用同目录临时文件加原子替换，且永不覆盖源工程或源 SRT。

成功后 Launcher 会把生成路径设为下一次工具运行的输入，因此可以按“固定处理 → LLM 校对 → 翻译”等顺序链式处理。固定处理可先批量替换，再做简繁转换；只有 SRT 输入时，如选择工程输出，会创建 `.mosp` 工程。

翻译入口会按 `.translate-en` / `.translate-zh` 文件名约定阻止明显的重复翻译输入；这只是命名约定保护，不是对文件内容或语言的可靠识别。

## 6. OpenAI-compatible HTTP 契约

客户端向配置 URL 的 `/chat/completions` 发送 Bearer 认证请求；如果 URL 已以 `/chat/completions` 结尾则直接使用。出于凭据安全，HTTPS 可使用远端地址，明文 HTTP 只允许 `localhost`、`127.0.0.1` 或 IPv6 环回地址。请求包含：

- `model`：当前供应商或自定义模型名；
- `messages`：系统协议和 cue 文本数组；
- `response_format: {"type": "json_object"}`；
- `temperature: 0.1`。

预设供应商为 DeepSeek、智谱 Coding Plan 和阿里云 Qwen；Custom 可填写 HTTPS 或环回 HTTP 的 OpenAI-compatible URL。API Key、URL、模型和最近供应商只保存在本机配置中，完整 Key 不进入工程、SRT、前端配置响应或任务结果。字幕文字会发送给用户选择的供应商，用户应自行确认其隐私和数据保留政策。

## 7. 思考强度与流式显示

Launcher 使用统一的 `reasoningMode` 设置：`auto`、`off`、`low`、`medium`、`high`。默认值是 `off`，即主动关闭可用的思考模式；只有用户选择 `auto` 时，才省略 reasoning 参数并跟随当前模型的服务商默认行为。不同供应商和模型的参数并不完全相同，客户端会按供应商/模型映射为原生的 `thinking`、`enable_thinking`、`thinking_budget` 或 `reasoning_effort`；Custom 接口无法可靠探测能力，显式设置时只做 OpenAI-compatible 的最佳努力映射。

当前适配器的主要映射如下：

| 供应商 / 模型家族 | `off` | `low` / `medium` / `high` |
| --- | --- | --- |
| DeepSeek | `thinking.type=disabled` | `thinking.type=enabled`；V4 额外使用 `reasoning_effort=high` |
| 智谱 | `thinking.type=disabled` | `thinking.type=enabled`；GLM-5.2 额外传递统一级别 |
| Qwen3 / QwQ / QvQ | `enable_thinking=false` | `enable_thinking=true`；低 / 中使用 4096 / 16384 thinking budget，高跟随模型上限 |
| Qwen3.8 | `enable_thinking=false` | `enable_thinking=true` + `reasoning_effort`，高映射为 `xhigh` |
| 其他 Qwen | `enable_thinking=false` | `enable_thinking=true`，跟随模型自己的思考上限 |
| Custom | 不发送推理参数，以保持兼容 | 显式尝试传递同名 `reasoning_effort`，由接口自行决定是否接受 |

LLM 工具在有前端回调时使用 SSE 流式请求。流式响应中的 reasoning 增量和正文增量分开传给 Launcher：前者只显示在临时的「思考」区域，后者显示为正在生成的 JSON。思考内容和未完成的 JSON 不写入工程、SRT 或日志。

流式传输不改变最终文件协议。客户端必须先拼接完整正文、解析 `groups`、检查 ID 覆盖和顺序，再一次性原子写出处理产物；任何中途断流、JSON 无效或协议校验失败都不会写出部分结果。不返回独立 reasoning 字段的模型只显示可用的正文；不支持 SSE 的接口会报告请求错误，不会把未完成内容写入文件。

# 用户自己的 Agent 接入 MAW

MAW 提供 `python -m maw.agent` JSON CLI 和 MAWE 中的快照/提案审阅入口。支持读取工程、查询范围与上下文、文字修改、分段/合并提案，以及指定范围的 Qwen 重听写。任何能执行命令、读写 JSON 的 Agent 都可以使用，不需要更换用户自己的模型。

这是源码版入口。Python 3.11+；读取、查询、生成提案只需标准库和仓库代码。重听写需要现有 Qwen 运行依赖、FFmpeg 和用户本机 Qwen 配置。先按 [安装工作流](WORKFLOW.md) 配好源码环境，后续使用 `uv run --no-sync python -m maw.agent ...`；下文 `python` 指该环境的解释器。当前打包的 `MAW.exe` 尚不转发这个子命令。

## 为什么采用 CLI + 提案

| 入口 | 已有能力 / 代价 | 本次选择 |
| --- | --- | --- |
| JSON CLI | 可复用 Python 工程校验、Qwen 转写与切句；易被不同 Agent 调用 | 实现正式调用入口 |
| localhost HTTP API | 现有接口管理媒体和磁盘保存，拿不到浏览器未保存选区与撤销；新增写 API 还需认证、会话及并发管理 | 不新增网络服务，不绕过浏览器编辑状态 |
| MCP | 适合工具发现，但需要 SDK/进程生命周期及客户端配置，仍须解决编辑器事务 | 本次不实现；后续可把这些命令直接包装成 tools，不另造字幕 schema |

MAWE 持有实时编辑状态，所以由用户导出快照，Agent 返回提案，用户在编辑器内审阅。既适用于 localhost，也适用于**以本分支源码生成**的便携 HTML。仓库 `blank-editor.html` 按发布约定未重生成，旧便携文件没有新入口。

## 完整使用流程

1. 用本分支启动 MAWE，例如 `python server-editor/serve.py --blank`，打开自己的工程。
2. 选择需要协作的主字幕。在「打开工程 ▾」点击「导出 Agent 快照」。这会提交正在输入的文字并使用正常工程序列化逻辑导出；该过程与保存一样可能规范化异常时间码。快照包含当前工程和主字幕选区，不读取媒体内容。
3. 把快照路径交给自己的 Agent，按下面的命令读取并生成新提案文件。
4. 在同一个编辑器的「打开工程 ▾ → 审阅 Agent 提案」选择提案。核对修改前后、绝对毫秒范围、说话人与字词数量，再点击「应用提案」。
5. 应用成为一次正常编辑：支持撤销/重做，并沿用当前手动/自动保存设置。Server 保存仍走已有备份机制。取消审阅不会应用提案。

提案创建时和应用时使用的字幕、主副轨、时间基准、媒体、标记等基线必须一致。审阅期间的新编辑也会再次检查。发生冲突时重新导出快照和生成提案；没有 force 参数。外观设置变化不阻止提案应用。CLI 从不覆盖源工程，也不提供绕过审阅的写入命令。

### 可执行的文字修改示例（PowerShell）

将编辑器下载的快照放在当前目录，下面读取真实 ID，不依赖样例工程的固定 ID。输出文件须尚不存在。

```powershell
python -m maw.agent capabilities
python -m maw.agent read ./project.agent-snapshot.json
python -m maw.agent query ./project.agent-snapshot.json --start 1000 --end 8000 --context-ms 1500

$snapshot = Get-Content -Raw -Encoding UTF8 ./project.agent-snapshot.json | ConvertFrom-Json
$id = $snapshot.project.segments[0].id
$text = $snapshot.project.segments[0].text + '。'
$edits = ConvertTo-Json -InputObject @(@{ id = $id; text = $text }) -Depth 8
[IO.File]::WriteAllText((Join-Path $PWD 'edits.json'), $edits, [Text.UTF8Encoding]::new($false))
python -m maw.agent propose-text ./project.agent-snapshot.json --edits ./edits.json --reason '为首句补充句末标点，请试听核对' --output ./punctuation.proposal.json
```

示例演示追加标点，不代表所有语种或现有标点都适合追加句号。Agent 应依据用户要求生成自己的 edits。所有用户内容通过 JSON 文件传递，避免拼接到 shell 命令。

### 分段、合并与删除

创建一个 UTF-8 替换工程，例如 `replacement.mosp`：

```json
{"schema":"moy.asr.project.v1","segments":[
  {"start":1000,"end":2500,"text":"第一部分","speaker":"Alice"},
  {"start":2600,"end":4000,"text":"第二部分","speaker":"Alice"}
]}
```

```powershell
python -m maw.agent propose-range ./project.agent-snapshot.json --start 1000 --end 4000 --replacement ./replacement.mosp --reason '按完整语义分成两句，请核对切点' --output ./split.proposal.json
```

`start/end` 是原媒体绝对毫秒，不能填写片段局部时间。目标范围必须完整包含与之相交的字幕；若原字幕从 800 ms 开始，以上调用会拒绝，不会默默截掉开头。合并可提供一条覆盖目标范围的字幕，删除使用 `{"segments":[]}`。没有真实词级时间时不要捏造 items；分段时间需要人工试听。CLI 为新字幕分配新 ID，校验整个候选工程，范围外字幕与工程元数据保留。

### 指定范围重听写

以下命令**会调用可能收费的 Qwen API**，仅在用户授权这些具体媒体、范围和配置后运行。开发测试无需运行它。

```powershell
python -m maw.agent retranscribe ./project.agent-snapshot.json --media ./recording.mp4 --start 1000 --end 8000 --model qwen-audio-3.0-asr-flash-filetrans --context '本段术语：MAW、字幕时间码' --allow-cloud --job ./listen-001.job.json --output ./listen-001.proposal.json
```

在另一个命令窗口或 Agent 调用中查询：

```powershell
python -m maw.agent job ./listen-001.job.json
```

命令在前台执行，不启动后台服务。用 Agent 客户端的受管理进程运行，并给它足够的等待时间；Qwen 轮询上限沿用本机配置，默认 1800 秒。job 原子更新为 `running`、`succeeded` 或 `failed`，含 PID、范围、模型、提案路径及结果/错误。命令完成后临时音频清理。强制终止进程或断电可能留下 running 或临时文件；确认该进程已结束，并检查服务商任务状态后再决定是否重试，避免重复计费。

媒体必须由 `--media` 显式指定；程序不会跟随工程里的任意路径自动上传。FFmpeg 解码后截取严格的 `[start,end)`，采用工程 `media_metadata.selected_audio_track`（旧工程缺省轨 0），转成 16 kHz 单声道 WAV。只上传这个片段，不上传工程或整段媒体。查询上下文不自动发送；仅 `--context` 明确指定的最多 400 字发送给支持它的 Qwen-Audio 模型。`qwen3-asr-flash-filetrans` 沿用原适配器行为，忽略不支持的 context。`--language` 不指定时沿用工程语言。凭据由现有 Qwen 配置读取，不应写到命令、提案、日志或 Skill。

转写复用现有 Qwen 适配器和切句函数，默认中文长度 24 / 最短 5、停顿 800 ms，词数阈值沿用原函数默认值。局部时间只加一次范围起点；少量句级越界裁到范围内，若字词跨越边界导致无法安全重建文本则拒绝。没有有效语音返回错误，不自动删除字幕。片段只有一个已知说话人时继承该名称；多说话人片段拒绝自动回填，避免将片段局部的 speaker ID 误认成工程中的真实人物。

## 命令与文件契约

成功 stdout：`{"ok":true,"result":...}`，退出码 0。业务/文件/校验失败 stdout：`{"ok":false,"error":{"code":"...","message":"..."}}`，退出码 1。命令行参数语法错误遵循 argparse（stderr 帮助，退出码 2）。Provider 的可能含签名 URL 的日志不进入协议输出；运行期失败返回不含凭据的简要错误。

| 命令 | 必需参数 | 结果 |
| --- | --- | --- |
| `capabilities` | 无 | 接口版本、命令、单位和应用边界 |
| `read` | `project` | project、快照 context、内容 revision（查询参考，审阅以 base 检查） |
| `query` | `project --start N --end M` | index、原 segment、in_range；可加非负 `--context-ms` |
| `propose-text` | `project --edits file --reason text --output new-file` | 新提案路径和 ID；edits 为唯一 `{id,text}` 数组 |
| `propose-range` | `project --start N --end M --replacement file --reason text --output new-file` | 新提案路径和 ID |
| `retranscribe` | `project --media file --start N --end M --allow-cloud --job new-file --output new-file` | 新提案；可选 model、language、context |
| `job` | `path` | 已有 job 状态；不发起新转写 |

输入可以是 `.mosp`、兼容 `.json`，或 `moy.asr.agent.snapshot.v1` 包装 `{project,context}`。工程使用现有 [JSON_SCHEMA](../JSON_SCHEMA.md)，不另造字幕结构。旧工程没有 stable ID 时可以 read/query，文字提案应先在编辑器导出快照获取真实 ID。文件上限 64 MiB。源工程和已有输出不覆盖；每次使用新的提案/job 文件名。

快照 `context` 包含 `selected_ids`、`selected_indices`、`selected_range`、`selection_kind`。当前只包含主字幕选区；`selected_range` 是最早 start 到最晚 end 的包络，非连续选区中间未选中的字幕仍在这个范围内。无选区为 null。它不是实时会话 API，也不是播放头/波形自由区域的读取接口。

提案格式 `moy.asr.agent.proposal.v1` 包含 `id`、`reason`、完整 `base` 工程与一个 `operation`：

- `{"type":"text","edits":[{"id":"...","text":"..."}]}`：保留时间、说话人及元数据，使用编辑器现有字词协调算法。无可靠映射时移除过期 items。
- `{"type":"replace_range","start":1000,"end":4000,"segments":[...]}`：替换完整相交字幕，也可在空白范围新增。新段仅支持 id、start/end、text、items、speaker；CLI 生成 ID。

`base` 不是用户可修改的“冲突开关”。不要删字段或改 base 规避冲突。审阅以当前编辑器序列化结果为准，直接读磁盘工程生成的提案可能因打开时的兼容规范化而冲突，推荐快照流程。

## 限制与错误处理

| code | 意义 / 应对 |
| --- | --- |
| `invalid_range` | 非整数、负值、空范围或替换时间越界；按毫秒修正 |
| `boundary_conflict` | 切穿已有字幕；只在用户授权后显式调整目标范围 |
| `unsupported_structure` | 范围结构操作遇到副字幕轨绑定、帧模式、分组颜色/表情引用，或范围内装饰/禁用/未知元数据；不要删元数据绕过 |
| `unknown_segment` / `invalid_request` | 缺失/重复 ID、参数/格式/工程校验问题；重读快照并修正请求 |
| `conflict`（编辑器） | 基线变化；重新导出和生成提案 |
| `output_exists` | 输出已存在；使用新文件名 |
| `cloud_not_authorized` | 未显式开启云端上传；确认授权后才运行 |
| `missing_credentials` / `missing_ffmpeg` | 本机 Qwen 配置或媒体工具未就绪 |
| `empty_asr_result` / `invalid_asr_result` | 无有效语音或边界字词不可靠；不生成破坏性回填 |
| `transcription_failed` | 转写、媒体处理或中断失败；检查本机配置/媒体/服务商任务状态，不包含凭据和签名 URL |
| `invalid_job` | 不是本入口生成的 job 文件 |
| `too_large` | 输入超过 64 MiB |

第一版仅修改主轨；文字编辑兼容已有装饰与绑定，结构编辑采取明确拒绝的边界。重听写仅接 Qwen 3.0 / 3.1 / Qwen3 filetrans，不自动启用其他服务、本地模型或整片上传。CLI 尚不支持直接读取正在运行的浏览器会话、批量自动应用或启动后脱离客户端的后台任务。可以通过现有文件契约扩展 MCP 或本机桥，继续保留审阅和版本检查。

## 安装 / 分发 Skill

仓库可分发 Skill 位于 [`.opencode/skill/maw-agent/SKILL.md`](../.opencode/skill/maw-agent/SKILL.md)。遵循当前仓库的 Skill 目录惯例；其他 Agent 可以直接读取该文件，或由用户按自己客户端的 Skill 机制复制该目录。没有自动修改用户全局配置，也没有自动安装 MCP。

## 验证边界

- Python 契约测试覆盖查询、错误输入、范围边界、元数据保护、任务状态、输出防覆盖、偏移和说话人回填。
- 使用合成 WAV 和真实 FFmpeg 截取 800 ms，连接 fixture provider，实际验证裁剪长度和现有切句回填；不需要凭据、不会联网。
- JS 测试使用真实字词协调函数；浏览器测试通过真实 CLI 导出的提案验证审阅/取消/应用/撤销/重做/保存及前后两次冲突检测，并测量控件间距。
- **未发起真实 Qwen 付费请求**；真实账号、上传、计费、网络异常与转写质量留给用户授权的小范围验收。测试不能代替这些证据。

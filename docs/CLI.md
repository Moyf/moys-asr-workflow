# MAW 命令行 CLI

MAW 的 Release 包除了图形 Launcher，也支持直接用命令行完成转写和本机编辑器 Server 管理。本文以 Windows PowerShell 和 Release 包中的 `MAW.exe` 为例；源码运行时，把示例中的 `MAW.exe` 替换为 `uv run python maw_gui.py` 即可。

> 本文介绍公开 CLI。`--transcribe`、`--transcribe-soniox`、`--transcribe-bcut` 和 `--serve` 是保留给旧 Launcher/内部调用的兼容入口，新脚本应使用本文的参数。

## 1. 能做什么

公开 CLI 有三种模式：

| 模式 | 入口 | 行为 |
| --- | --- | --- |
| Launcher | 不带参数 | 启动图形 Launcher，保持原来的双击行为 |
| 转写 | `-i` / `--input` | 调用 Qwen/Fun-ASR、Soniox 或必剪（实验性），生成 SRT 和 `.mosp` |
| Server 管理 | `--server` / `--stop-server` | 启动或停止只监听 `127.0.0.1` 的 MAW 编辑器 Server |

先查看当前版本的帮助：

```powershell
.\MAW.exe --help
```

`-h` 是 `--help` 的短写法。帮助和参数错误不会调用 ASR API；自动化工具可以先执行它确认实际参数。

## 2. 准备工作

### Release 包

请保留 Release 解压后的整个 `MAW` 目录，不要只复制 `MAW.exe`。`MAWxFF` 包已经把 `ffmpeg.exe` 和 `ffprobe.exe` 放在包内；普通包需要系统 PATH 中已有这两个命令。MAW 运行 CLI 时会自动把随包的 FFmpeg 加入当前进程环境。

### API Key

CLI 不接受 API Key 参数，也不应把 Key 写在命令行、脚本参数、日志或 AI 对话中。使用环境变量，或在 MAW 配置目录的 `.env` 中配置：

```ini
# Qwen-Audio、Qwen3-ASR、Fun-ASR
DASHSCOPE_API_KEY=你的百炼密钥

# Soniox；只使用 Soniox 时填写这一项即可
SONIOX_API_KEY=你的 Soniox 密钥
```

Windows Release 包的 `.env` 通常放在 `MAW.exe` 同目录；源码方式放在仓库根目录。环境变量优先于 `.env`。API Key 的申请方式见 [README 的 API 说明](../README.md) 和[阿里云官方文档](https://help.aliyun.com/zh/model-studio/get-api-key)。

### PowerShell 路径

媒体、输出、工程、热词和上下文文件的路径只要包含空格，就必须加双引号。自动化脚本建议始终使用绝对路径，并提前选择不会与已有结果冲突的输出路径。

## 3. 转写语法和输出

最常用的语法是：

```text
MAW.exe -i INPUT -o SRT [MOSP] [转写选项]
```

### 最小示例

```powershell
.\MAW.exe -i "D:\Videos\meeting.mp4" -o "D:\Output\meeting.srt" "D:\Output\meeting.mosp"
```

这个命令会：

1. 读取本地音频或视频；
2. 使用默认的 Qwen-Audio 模型转写；
3. 输出指定的 SRT 和 `.mosp` 工程；
4. 在成功结束时打印 `SRT: ...`、`MOSP: ...`，并返回退出码 `0`。

### 输出路径规则

- `-o` / `--output` 最多接受两个路径。第一个是 SRT，第二个是 `.mosp`。
- 只给一个输出路径时，它被视为 SRT；`.mosp` 会使用相同目录和文件名自动生成。
- 不写 `-o` 时，SRT 会按输入媒体名、供应商和模型自动命名。需要脚本稳定定位结果时，建议显式写 `-o`。
- `--mosp PATH` 可以单独指定工程输出路径；它不能和 `-o` 的第二个路径同时使用。
- 输出目录不存在时，CLI 会创建 SRT 和 `.mosp` 所需的父目录。
- CLI 默认生成 SRT 和 `.mosp`，不生成便携 `.edit.html`。需要 HTML 时加 `--html`。
- `--json` 只是旧 CLI 的兼容参数。它表示“同时生成工程文件”，当前工程扩展名仍是 `.mosp`，不是要求生成 `.json`。

例如，只固定 SRT 路径，让工程自动使用同名路径：

```powershell
.\MAW.exe -i "D:\Videos\meeting.mp4" -o "D:\Output\meeting.srt"
```

或者使用 `--mosp` 把工程放到另一个目录：

```powershell
.\MAW.exe -i "D:\Videos\meeting.mp4" `
    -o "D:\Output\meeting.srt" `
    --mosp "D:\Projects\meeting.mosp"
```

### 先跑小样本

第一次调用或调试 API 时，建议先限制时长，避免误传整部视频：

```powershell
.\MAW.exe -i "D:\Videos\long-video.mp4" `
    -o "D:\Output\long-video-test.srt" `
    --mosp "D:\Output\long-video-test.mosp" `
    -ll 2m
```

`-ll` / `--length-limit` 支持数字秒数以及 `s`、`m`、`h` 后缀，例如 `90`、`20s`、`2m`、`1h`。它会在 FFmpeg 提取阶段限制输入范围；不需要测试截取时不要长期保留这个参数。

## 4. 完整参数

### 4.1 帮助、输入和输出

| 参数 | 说明 |
| --- | --- |
| `-h`, `--help` | 显示 CLI 帮助并退出。 |
| `-i PATH`, `--input PATH` | 转写模式下必填；音频或视频路径。Server 模式不能使用。 |
| `-o PATH [PATH]`, `--output PATH [PATH]` | 第一个路径为 SRT，第二个可选路径为 `.mosp`；最多两个路径。 |
| `--mosp PATH` | 单独指定 `.mosp` 输出路径；不能和 `-o` 的第二个路径同时使用。 |
| `--provider qwen\|soniox\|bcut` | 选择供应商，默认 `qwen`。`qwen` 覆盖 Qwen-Audio、Qwen3-ASR 和 Fun-ASR；`bcut` 为免 Key 的实验性非官方接口，仅中文，详见 [WORKFLOW](WORKFLOW.md) 的风险说明。 |
| `--model MODEL` | 覆盖供应商的模型。Qwen 常用值为 `qwen-audio-3.0-asr-flash-filetrans`、`qwen3-asr-flash-filetrans`、`fun-asr`；Soniox 默认读取 `.env`，否则使用其内置默认模型。 |

### 4.2 字幕切分、说话人和工程内容

| 参数 | 说明 |
| --- | --- |
| `--max-len N` | 每条字幕最大字数；未指定时使用生成器默认值 `21`。对空格分词语言按供应商规则处理。 |
| `--min-len N` | 句号之间的最短字数；未指定时使用默认值 `5`，主要影响 CJK 文本的合并。 |
| `--language VALUE` | 语言提示。Qwen 可写 `zh`、`en` 等；Soniox 可写逗号分隔的 `zh,en`。不确定语言时可以省略，让供应商自动识别。 |
| `--keep-punct` | 保留每条字幕末尾的逗号和句号；默认会去掉。 |
| `--gap-split MS` | 相邻文字停顿超过指定毫秒数时强制切句；默认 `1500`。 |
| `--speaker` | 启用说话人分离，并把匿名 speaker 标签写入 `.mosp`。需要选择支持该功能的模型。 |
| `--speaker-colors` | 启用说话人分离，并按首次出现顺序写入一次性的字幕颜色快照；之后仍可在编辑器中修改。 |
| `-ll VALUE`, `--length-limit VALUE` | 只处理媒体前指定时长，例如 `2m`、`20s`、`1h`、`90`。 |
| `--json` | 旧 CLI 兼容参数；MAW 公开 CLI 默认已经生成 `.mosp`，通常不需要写。 |
| `--with-waveform` | 将波形峰值嵌入 `.mosp`。会额外使用 FFmpeg 扫描媒体；不指定时波形由编辑器按需建立 sidecar 缓存。 |
| `--html` | 在 SRT 和 `.mosp` 之外，再生成便携 `.edit.html`。 |
| `--no-html` | 明确关闭便携 HTML；这是默认行为，也保留用于兼容旧脚本。不能和 `--html` 同时使用。 |
| `--debug` | 输出更多 API 调试信息。调试日志仍不会输出 API Key。 |
| `-s PATH`, `--stickers PATH` | 指定表情包目录。它会传递给转写后生成的编辑器工程，也可用于 Server。 |

`--speaker-colors` 已经包含说话人分离，不必同时重复写 `--speaker`。Qwen3-ASR 不支持说话人开关；Qwen-Audio、Fun-ASR 和 Soniox 支持情况以当前供应商及账户能力为准。

### 4.3 Qwen / 百炼专用参数

以下参数只用于 `--provider qwen`。和 `--provider soniox` 或 `--provider bcut` 混用时，CLI 会直接报参数错误（`bcut` 额外还不支持 `--language`、`--model`、`--speaker` / `--speaker-colors`）：

| 参数 | 说明 |
| --- | --- |
| `--region REGION` | 覆盖百炼地域，例如 `beijing` 或 `singapore`。默认读取 `DASHSCOPE_REGION`，未配置时为北京。 |
| `--workspace-id ID` | 覆盖 `DASHSCOPE_WORKSPACE_ID`。新加坡地域必须配置；北京地域可选。 |
| `--file-url URL` | 使用已经上传到公网/OSS 的文件 URL，交给 Qwen 的 file-trans 模式处理；仍建议保留 `-i` 作为本地输入/输出流程的媒体参数。 |
| `--vocabulary-id ID` | 指定百炼预编译词表 ID。词表必须为当前模型创建。 |
| `--hotword WORD` | 追加一个即时热词；可以重复写多个。 |
| `--hotword-file PATH` | 从 UTF-8 文本文件读取即时热词，每行一个，空行和 `#` 注释行会忽略。未指定时会尝试读取仓库/包内的 `hotwords.txt`。 |
| `--hotword-weight VALUE` | 设置即时热词权重，可用 `1` 到 `5` 或 `50`。 |
| `--context TEXT` | 提供 Qwen-Audio 的领域背景或前文，最多发送 400 字符。 |
| `--context-file PATH` | 从 UTF-8 文件读取 context；和 `--context` 二选一。 |

热词文件也支持 `热词: 权重` 或 `热词：权重`，可以对单条热词覆盖全局权重。即时热词和 context 主要由 `qwen-audio-3.0-asr-flash-filetrans` 使用；切换到 Qwen3-ASR 或 Fun-ASR 时，具体能力由模型决定，CLI 不会把它们伪装成通用能力。

### 4.4 Server 参数

| 参数 | 说明 |
| --- | --- |
| `--server [PORT]` | 启动本机 MAW Server；省略端口时使用 `8250`。Server 在前台运行，按 `Ctrl+C` 停止。 |
| `--stop-server [PORT]` | 停止指定端口的 MAW Server；省略端口时使用 `8250`。 |
| `--port PORT` | 用另一种写法指定 `--server` 或 `--stop-server` 的端口，范围为 `1` 到 `65535`。 |
| `PROJECT` | Server 启动时打开的 `.mosp` 或旧 `.json` 工程；只能和 `--server` 一起使用。 |
| `--media PATH` | 覆盖工程中记录的媒体路径；必须和 `PROJECT` 一起使用。 |
| `--no-open` | 启动 Server 后不自动打开浏览器，适合脚本或 AI 管理。 |
| `--no-waveform` | 启动 Server 时跳过波形预计算。 |
| `--waveform-peaks-per-second N` | 指定 Server 生成波形时的峰值密度。 |
| `-s PATH`, `--stickers PATH` | 指定 Server 使用的表情包目录。 |

`--server` 后的可选值如果是整数，会被解释为端口；如果不是整数，会被解释为工程路径。为了让脚本更清晰，带工程时推荐使用显式的 `--port`：

```powershell
.\MAW.exe --server --port 8250 `
    "D:\Projects\meeting.mosp" `
    --media "D:\Videos\meeting.mp4" `
    --no-open
```

Server 永远只监听 `127.0.0.1`，不会把本地媒体和编辑器暴露到局域网。启动命令是前台进程；需要让当前终端继续工作时，在 PowerShell 中放到后台：

```powershell
$server = Start-Process `
    -FilePath ".\MAW.exe" `
    -ArgumentList @("--server", "--port", "8250", "--no-open") `
    -WorkingDirectory (Get-Location) `
    -PassThru
```

使用完后通过 CLI 停止，而不是按 PID 猜测进程：

```powershell
.\MAW.exe --stop-server --port 8250
```

停止命令优先请求 MAW Server 的 loopback 控制接口；对旧版 Windows Server，才会回退到经过命令行校验的 MAW 进程。停止前请先保存浏览器中的未保存工程修改。没有找到可安全停止的 Server 时会返回非零退出码。

## 5. 常用范例

### Qwen-Audio：中文、说话人颜色和内嵌波形

```powershell
.\MAW.exe `
    --provider qwen `
    --model qwen-audio-3.0-asr-flash-filetrans `
    -i "D:\Videos\interview.mp4" `
    -o "D:\Output\interview.srt" "D:\Output\interview.mosp" `
    --language zh `
    --speaker-colors `
    --with-waveform
```

### Qwen-Audio：热词和上下文

```powershell
.\MAW.exe `
    -i "D:\Videos\product-demo.mp4" `
    -o "D:\Output\product-demo.srt" `
    --hotword-file "D:\Config\hotwords.txt" `
    --hotword-weight 5 `
    --context-file "D:\Config\product-context.txt"
```

### Soniox：多语言和说话人

```powershell
.\MAW.exe `
    --provider soniox `
    -i "D:\Videos\panel.mp4" `
    -o "D:\Output\panel.srt" "D:\Output\panel.mosp" `
    --language zh,en `
    --speaker-colors
```

### 必剪：免 Key 快速体验（实验性，仅中文）

```powershell
.\MAW.exe `
    --provider bcut `
    -i "D:\Videos\clip.mp4" `
    -o "D:\Output\clip.srt" `
    -ll 2m
```

必剪是非官方免费接口，无需配置任何 Key；不支持语言、模型和说话人参数，单文件默认上限 2 小时，请勿高频调用。

### 只生成便携 HTML

CLI 总是先生成 SRT 和 `.mosp`；如果还需要带工程数据的便携 HTML：

```powershell
.\MAW.exe `
    -i "D:\Videos\clip.mp3" `
    -o "D:\Output\clip.srt" `
    --html
```

## 6. 给 AI 和自动化工具的调用指引

如果让 AI、脚本或 CI 调用 MAW，可以把本节和本文路径 `docs/CLI.md` 作为工具说明。推荐遵守下面的规则：

1. 先确认 `MAW.exe` 的绝对路径，并在执行前调用 `MAW.exe --help`；不要假设当前目录就是 Release 包目录。
2. 使用 PowerShell 时给每个含空格的路径加双引号；自动化任务优先使用绝对输入、SRT 和 `.mosp` 路径。
3. 不要把 `DASHSCOPE_API_KEY` 或 `SONIOX_API_KEY` 放进命令行。要求用户在环境变量或 `.env` 中配置，日志和对话也不要回显它们。
4. 第一次处理大文件时先用 `-ll 2m` 做小样本；只有用户明确需要完整媒体时，才移除时长限制。不要默默截断用户要求的完整转写。
5. 转写完成后同时检查进程退出码和输出文件。退出码为 `0` 且 SRT、`.mosp` 都存在，才报告成功；不要只根据终端出现了“开始”或“任务完成”字样判断成功。
6. 如果用户要求启动 Server，使用 `--server --port PORT --no-open`；这是前台服务进程，自动化工具需要自行后台启动并等待端口可用。
7. 用户要求关闭 Server 时使用 `--stop-server PORT`，不要自行结束不相关的 Python 或 MAW 进程。关闭前提醒用户保存浏览器中的修改。
8. 不要在新脚本中使用旧的 `--transcribe`、`--transcribe-soniox` 或 `--serve` 内部入口；它们不是面向用户的稳定 CLI。

一个最小的 PowerShell 自动化模板：

```powershell
$maw = "D:\Apps\MAW\MAW.exe"
$inputPath = "D:\Videos\clip.mp4"
$srtPath = "D:\Output\clip.srt"
$mospPath = "D:\Output\clip.mosp"

& $maw -i $inputPath -o $srtPath $mospPath -ll 2m
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "MAW 转写失败，退出码: $exitCode"
}
if (-not (Test-Path -LiteralPath $srtPath)) {
    throw "MAW 未生成 SRT: $srtPath"
}
if (-not (Test-Path -LiteralPath $mospPath)) {
    throw "MAW 未生成 MOSP: $mospPath"
}
```

## 7. 退出码和排错

公开 CLI 遵循“成功为 `0`，失败为非零”的约定：

| 情况 | 常见退出码 | 处理方式 |
| --- | --- | --- |
| `--help` 成功显示 | `0` | 读取帮助或继续执行。 |
| 转写成功，SRT 和 `.mosp` 已生成 | `0` | 可以继续下游编辑、打包或导入。 |
| 参数组合错误、缺少 `-i`、端口非法 | `2` | 修正命令；不要重试相同参数。 |
| API Key、媒体、FFmpeg、网络或供应商任务失败 | 非 `0` | 查看 stderr 和进度日志，确认配置后再重试。 |
| 转写返回但预期文件缺失 | `1` | 检查输出目录权限、磁盘空间和生成器日志。 |
| `--stop-server` 没找到可安全停止的 Server | `1` | 确认端口和 Server 是否仍在运行。 |

常见问题：

- `ffmpeg` 或 `ffprobe` 找不到：改用 `MAWxFF` 包，或把 FFmpeg 安装目录加入 PATH。
- 报未配置 API Key：检查对应供应商的环境变量名，或检查 `.env` 是否位于 Release 的 `MAW.exe` 同目录。
- 输出路径包含空格但文件没有生成：检查 PowerShell 命令是否给路径加了双引号。
- Server 打不开工程媒体：工程里的媒体路径可能已失效，使用 `PROJECT --media PATH` 指定当前媒体。
- Server 端口被占用：选择其他 `--port`，或先对正确的端口执行 `--stop-server`。

完整工作流和 API 配置仍可参考 [WORKFLOW.md](WORKFLOW.md)；编辑 `.mosp`、波形和导出格式请看 [EDITOR_GUIDE.md](EDITOR_GUIDE.md)。

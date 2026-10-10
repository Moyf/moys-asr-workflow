# MAW 命令行与自动化

公开 CLI 通过 Release 包的 `MAW.exe` 调用；源码中把它替换为 `uv run --no-sync python maw_gui.py`。下面的 Windows 示例使用 PowerShell，其他系统请使用实际的可执行文件路径。

先运行 `--help` 确认所用版本支持的参数。帮助不会调用 ASR。配置字段与 `.env` 位置统一见 [服务商配置](PROVIDERS.md)。

## 入口与输出

| 入口 | 行为 |
| --- | --- |
| 无参数 | 启动 Launcher。 |
| `-dbg` / `--debug`，且无转写参数 | 启动 Launcher 调试。 |
| `-dt` / `--devtools` | 启动 Launcher 并打开 DevTools。 |
| `-i INPUT` | 转写，默认生成 SRT 与 `.mosp`。 |
| `--align-script SCRIPT -i MEDIA` | 文稿与录音直接生成 SRT 与字词时间码工程，跳过 ASR；详见[使用指南](SCRIPT_DRIVEN_ALIGNMENT.md)。 |
| `--align-script SCRIPT -i MEDIA --alignment-check` | 无需模型，先检查输入 / 音轨与分块；输出 JSON，不生成字幕。 |
| `--server` / `--stop-server` | 启动或停止本机编辑器。 |

公开 CLI 只选择云端供应商和实验性必剪；本地 ASR 使用独立脚本，见 [LOCAL_ASR](LOCAL_ASR.md)。`--transcribe*`、`--serve` 是内部兼容入口，不用于新脚本。

```powershell
.\MAW.exe --help
.\MAW.exe -i "D:\Videos\clip.mp4" -o "D:\Output\clip.srt" -ll 2m
```

- `-o SRT [MOSP]` 最多接受两个路径；只给 SRT 时生成同名 `.mosp`。
- `--mosp PATH` 可单独指定工程位置，与 `-o` 的第二个路径互斥。
- 未给 `-o` 时按媒体、供应商与模型命名；自动化应显式指定路径。
- 输出父目录会创建。不要假设所有入口都有 Launcher 的防覆盖规则，应使用新的输出路径。
- 默认不生成 HTML，`--html` 额外生成 `.edit.html`；`--json` 是历史兼容参数，公开 CLI 已默认生成工程。

`-ll 2m` 只处理前两分钟；完整转写时移除该参数。不要默默截断用户要求的完整媒体。

## 公开转写参数

### 输入与通用处理

| 参数 | 含义 |
| --- | --- |
| `-h` / `--help` | 显示帮助。 |
| `-i` / `--input PATH` | 输入音频或视频，转写必填。 |
| `-o` / `--output SRT [MOSP]` | 输出路径。 |
| `--mosp PATH` | 单独指定工程输出。 |
| `--provider VALUE` | `qwen`（默认）、`soniox`、`doubao`、`tencent`、`openai`、`bcut`。 |
| `--model MODEL` | 覆盖模型；各供应商默认值见 [PROVIDERS](PROVIDERS.md)。 |
| `--language VALUE` | 语言提示；Soniox 可用 `zh,en`；必剪不支持。 |
| `--max-len N` / `--min-len N` | 字符型最大长度/短句合并阈值，生成器默认 18 / 5。 |
| `--max-words N` / `--min-words N` | 单词型最大长度/短句阈值，默认 13 / 3。 |
| `--gap-split MS` | 停顿切句阈值，默认 500 毫秒。 |
| `--keep-punct` | 保留句尾标点；默认剥除 `，。；,.`，问叹号保留。 |
| `--strip-tail-punct CHARS` | 指定剥除的句尾标点；公开入口不转发空字符串，需禁用剥除时使用底层脚本。 |
| `--extra-strong-punct CHARS` | 额外强断句符号，仅向 Qwen 下发。 |
| `--speaker` / `--speaker-colors` | 请求说话人分离；后者同时写颜色快照，无需重复前者。能力取决于模型。 |
| `-ll` / `--length-limit VALUE` | 限制处理时长，支持 `90`、`20s`、`2m`、`1h`。 |
| `--json` | 兼容旧调用；输出仍为 `.mosp`。 |
| `--with-waveform` | 提前生成外置波形缓存，工程落盘不内嵌缓存。 |
| `--with-spectral` | 额外生成频谱层，要求 `--with-waveform`。 |
| `--html` / `--no-html` | 生成/关闭便携 HTML，二者互斥，默认关闭。 |
| `--debug` | 输出 API 调试信息。 |
| `-s` / `--stickers PATH` | 表情包目录，也可用于 Server。 |

Qwen3-ASR 不支持说话人开关；必剪不支持模型、语言或说话人参数。OpenAI 兼容接口的说话人模式需要 Launcher 或底层脚本专用入口，不通过公开 CLI 的 `--speaker` 请求。

### 服务商专用参数

| 参数 | 供应商 | 含义 |
| --- | --- | --- |
| `--region REGION` | Qwen | 百炼地域，默认读取配置，缺省北京。 |
| `--workspace-id ID` | Qwen | Workspace ID；新加坡必填。 |
| `--file-url URL` | Qwen、腾讯云 | 已上传的 OSS / 公网文件；仍需 `-i` 参与本地输出流程。 |
| `--vocabulary-id ID` | Qwen | 为目标模型创建的预编译词表。 |
| `--hotword WORD` | Qwen、豆包 | 即时热词，可重复。 |
| `--hotword-file PATH` | Qwen | UTF-8 热词文件；空行与 `#` 注释忽略，支持 `词: 权重`。 |
| `--hotword-weight VALUE` | Qwen | 1–5 或 50，单项权重可覆盖。 |
| `--context TEXT` / `--context-file PATH` | Qwen | 二选一，Qwen-Audio 最多发送 400 字符。 |
| `--keep-dialect` | Qwen-Audio 3.1 | 保留方言表达，其他模型会拒绝该组合。 |
| `--soniox-context-json JSON` | Soniox | context 对象：general / text / terms / translation_terms。 |
| `--base-url URL` | OpenAI 兼容 | 接口根地址、`/v1` 或完整转写地址。 |

不同供应商的参数不能随意混用，不支持的组合会报错。完整配置与限制见 [PROVIDERS](PROVIDERS.md)。

## 常用命令

Qwen-Audio 热词、上下文和说话人颜色：

```powershell
.\MAW.exe -i "D:\Videos\interview.mp4" -o "D:\Output\interview.srt" --speaker-colors --hotword "专有名词" --context-file "D:\Config\context.txt"
```

Fun-ASR、Soniox、豆包和腾讯云：

```powershell
.\MAW.exe --model fun-asr -i "clip.mp4" -o "clip-funasr.srt" --speaker
.\MAW.exe --provider soniox -i "clip.mp4" -o "clip-soniox.srt" --language zh,en --speaker
.\MAW.exe --provider doubao -i "clip.mp4" -o "clip-doubao.srt" --hotword "专有名词"
.\MAW.exe --provider tencent -i "clip.mp4" -o "clip-tencent.srt" --file-url "https://example.com/clip.wav"
```

OpenAI 兼容服务与实验必剪：

```powershell
.\MAW.exe --provider openai --model whisper-1 -i "clip.mp4" -o "clip-openai.srt"
.\MAW.exe --provider openai --base-url "https://openrouter.ai/api/v1" --model "openai/whisper-1" -i "clip.mp4" -o "clip-router.srt"
.\MAW.exe --provider bcut -i "clip.mp4" -o "clip-bcut.srt" -ll 2m
```

CLI 不为 OpenRouter 模型自动补前缀，必须填服务商实际模型 ID。兼容接口只返回纯文本时不能生成字幕。以上 URL 示例需替换为真实、可访问且允许提交的地址。

## 底层转写脚本与公开 CLI 的区别

源码提供七个 `generate_subtitle_*.py` 脚本：Qwen、Soniox、豆包、腾讯云、OpenAI、必剪与本地。它们使用位置参数输入媒体，通常通过 `--json` 请求工程；HTML 默认值与公开 CLI 不完全相同，需要时明确加 `--no-html`。各脚本参数以自己的 `--help` 为准。

```sh
uv run --no-sync python generate_subtitle_qwen_api.py "clip.mp4" -o "clip.srt" --json --no-html
```

| 参数 | 仅在对应底层脚本使用 |
| --- | --- |
| `--prompt`、`--keyword`、`--diarize` | `generate_subtitle_openai_api.py`；公开 CLI 未提供。说话人模式与 prompt/keyword 互斥。 |
| `--engine`、`--device`、`--firered-punc` 等 | `generate_subtitle_local.py`，见 [本地 ASR](LOCAL_ASR.md)。 |
| `--audio-track` | 支持该参数的底层生成器；公开 CLI 未提供。 |
| `--debug-raw`、`--no-model-tag` | 底层生成器调试与命名参数；公开 CLI 未提供。 |

底层脚本默认命名按供应商不同，不能统一假设带时间戳或模型名。在线 `--debug-raw` 保存原始响应，本地保存阶段文件与 `.local-debug.json` 清单，可能包含原始字幕，应按素材隐私要求处理。

成功日志包含耗时与实时率，`MAW_STAT rtf=0.123` 可供脚本解析。RTF 是耗时/媒体时长，越小越快；费用估算使用程序参考配置，不代替服务商账单。

## Server 管理

```powershell
.\MAW.exe --server --port 8250 "D:\Projects\clip.mosp" --media "D:\Videos\clip.mp4" --no-open
.\MAW.exe --stop-server --port 8250
```

| 参数 | 含义 |
| --- | --- |
| `--server [PORT]` | 前台启动，默认端口 8250。也可把工程路径放在该参数后。 |
| `--stop-server [PORT]` | 停止指定端口的 MAW Server，默认 8250。 |
| `--port PORT` | 显式端口，公开 CLI 接受 1–65535。 |
| `PROJECT` | 启动时打开 `.mosp` / `.json`，只能与 `--server` 同用。 |
| `--media PATH` | 覆盖媒体引用，需指定工程。 |
| `--no-open` | 不自动打开浏览器。 |
| `--no-waveform` | 跳过启动波形预计算。 |
| `--waveform-peaks-per-second N` | 波形峰值密度。 |
| `-s` / `--stickers PATH` | 表情包目录。 |

Server 只监听 `127.0.0.1`，转写参数不能与 Server 模式混用。`--server` 是持续运行的前台进程；自动化需自行后台启动并等待服务可用。源码 `server-editor/serve.py` 另支持 `--blank`、自动顺延端口和 `--port 0`，这些不是公开 CLI 参数，见 [Server README](../server-editor/README.md)。

停止前保存浏览器中的修改。停止命令优先调用 loopback 控制接口，旧 Windows 服务才回退到经命令行校验的进程；不会按名称随意结束其他 Python 进程。

## 自动化验收与退出码

1. 确认程序路径与版本，先读取 `--help`。
2. 为含空格路径加引号；指定新的输入/输出绝对路径，避免覆盖已有结果。
3. Key 由环境变量或本机 `.env` 提供，不放命令行。
4. 同时检查退出码与 SRT / MOSP 文件；仅出现进度信息不算成功。

```powershell
$maw = "D:\Apps\MAW\MAW.exe"
$srtPath = "D:\Output\clip.srt"
$mospPath = "D:\Output\clip.mosp"
& $maw -i "D:\Videos\clip.mp4" -o $srtPath $mospPath
if ($LASTEXITCODE -ne 0) { throw "MAW 转写失败" }
if (-not (Test-Path -LiteralPath $srtPath) -or -not (Test-Path -LiteralPath $mospPath)) {
    throw "MAW 未生成预期产物"
}
```

| 结果 | 退出码与处理 |
| --- | --- |
| 帮助或转写成功 | `0`；转写还需检查产物。 |
| 公开 CLI 参数错误 | 通常 `2`，修正命令再运行。 |
| 媒体、配置、网络或模型失败 | 非零，保留具体 stderr；底层脚本可能用 `2` 表示空识别。 |
| 生成器返回成功但缺少文件 | `1`。 |
| 没有可安全停止的 Server | `1`，确认端口与状态。 |

启动或配置排错见 [FAQ](FAQ.md)；编辑和保存见 [EDITOR_GUIDE](EDITOR_GUIDE.md)。

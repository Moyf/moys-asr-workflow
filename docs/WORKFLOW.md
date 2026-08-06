# 从零完成一次字幕工程

这份指南按 Windows PowerShell 写；路径带空格时始终加双引号。MAW 是 Moy's ASR Workflow 的简称。工程文件的主扩展名是 `.mosp`；它是 UTF-8 JSON 内容，`.json` 作为旧工程和兼容导入/导出的扩展名继续支持。

## 0. 安装依赖

如果使用 GitHub Releases 提供的 Windows 或 macOS 图形版，Python 与 uv 已由应用打包，不需要单独安装；普通版的 `ffmpeg` 和 `ffprobe` 仍是外部依赖，`MAWxFF` 版已经随包提供。Windows 解压后双击 `MAW.exe`；macOS 解压后打开 `MAW.app`。Launcher 默认启动 Server 版编辑器；需要桌面版时，从右侧菜单选择「在 MOSE 中打开」。

源码方式继续按下列步骤安装：

确认下列命令都有输出：

```powershell
python --version
ffmpeg -version
ffprobe -version
uv --version
```

需要 Python 3.11+。推荐安装 uv 后在仓库根目录执行：

```powershell
uv sync
```

不使用 uv 时，改用普通虚拟环境：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install "requests>=2.28" "jieba>=0.42"
```

后文的 `uv run python` 可替换为 `.\.venv\Scripts\python`。

## 1. 配置阿里云百炼 API

Qwen 与 Fun-ASR 共用同一个百炼 API Key。图形版可在遮罩输入框中填写 API Key；它只进入本次子进程环境，不会写回 `.env` 或工程文件。源码命令行方式使用下面的 `.env`：

```powershell
Copy-Item .env.example .env
notepad .env
```

最少填入：

```ini
DASHSCOPE_API_KEY=sk-你的密钥
```

北京地域默认使用 `DASHSCOPE_REGION=beijing`；`DASHSCOPE_WORKSPACE_ID` 在北京选填，填写后会使用官方推荐的业务空间专属域名。新加坡地域改为 `singapore` 并必须填写 Workspace ID。Launcher 目前面向国内用户隐藏地域和 Workspace 控件；如需海外地域或专属域名，请通过 CLI / `.env` 配置。环境变量优先于 `.env`。密钥申请和地域说明以[官方文档](https://help.aliyun.com/zh/model-studio/get-api-key)为准。

## 2. 先跑小样本

图形版的“Length limit”可填写 `2m`，效果等同于命令行 `-ll 2m`。

先用 `-ll 2m` 限制在两分钟，既减少费用也便于排错：

```powershell
uv run python generate_subtitle_qwen_api.py "D:\Videos\example.mp4" -ll 2m --json
```

CLI 未指定 `--model` 时默认使用 `qwen-audio-3.0-asr-flash-filetrans`；需要使用旧 Qwen3 或 Fun-ASR 时再显式指定模型。

常用可选项：

```text
--language zh        已知纯中文时指定；中英日韩混说时不要指定
--gap-split 1000     相邻字间隔超过 N 毫秒时强制切句
--keep-punct         保留每条字幕末尾的逗号和句号
--no-html            只要 SRT 和工程文件，不生成便携 HTML
--with-waveform      把波形写进工程文件，免去编辑器首次打开的 sidecar 缓存文件
--debug              输出部分 API 原始结果，便于反馈问题
```

CLI 默认不内嵌波形；需要交给编辑器直接打开且不想生成 `<媒体名>.waveform.json` sidecar 时，加 `--with-waveform`。波形提取会额外用 FFmpeg 完整扫一遍媒体，失败时只给警告，不影响字幕与工程文件输出。输入视频会先由 FFmpeg 提取单声道 16kHz WAV；音频输入也会通过 FFprobe 获取时长。没有 FFmpeg/FFprobe 时，这一步无法完成。

## 用 Qwen-Audio 3.0 ASR 转写（热词与上下文）

Launcher 和 CLI 默认都使用 `qwen-audio-3.0-asr-flash-filetrans`；需要切换其他模型时再显式指定：

```powershell
uv run python generate_subtitle_qwen_api.py "D:\Videos\example.mp4" --model qwen-audio-3.0-asr-flash-filetrans -ll 2m --json
```

Qwen-Audio 的 filetrans API 使用 `input.file_urls` 和 `output.results[]`，由 MAW 自动适配；字/词时间戳不使用旧 Qwen3 的 `--enable-words` 开关。可选增强配置：

选择 Qwen-Audio 后，Launcher 的高级选项会显示 `Prompt / 上下文`、`即时热词` 和权重。
预编译 `vocabulary_id` 暂不在 Launcher 开放，底层 CLI / `.env` 能力保留；Launcher 字段只随本次转写提交，
不会写入 `.env` 或工程 JSON。

```text
--vocabulary-id ID       覆盖百炼预编译词表 ID
--hotword "词"           追加一个即时热词，可重复传入
--hotword-file path.txt  使用指定 UTF-8 文本文件作为即时热词来源
--hotword-weight 5       hotwords.txt 即时热词权重，可用 1-5 或 50
--context "领域词表"     发送最多 400 字符上下文
--context-file path.txt  从 UTF-8 文件读取上下文
--speaker                 开启说话人分离
--speaker-colors          开启说话人分离并写入颜色快照
```

热词文本支持 `热词: 权重` 或 `热词：权重`，单项权重可覆盖全局权重；未指定时使用 `--hotword-weight`。按百炼规则，含非 ASCII 字符的单项最多 15 个字符，纯 ASCII 单项最多 7 个空格分隔的单词，每次最多 2000 项，权重 50 最多 50 项。不合规项会提示警告并在发送时忽略。

也可以在 `.env` 中设置 `DASHSCOPE_QWEN_AUDIO_VOCABULARY_ID`、
`DASHSCOPE_QWEN_AUDIO_HOTWORD_WEIGHT` 和 `DASHSCOPE_QWEN_AUDIO_CONTEXT_FILE`。
预编译词表必须按 Qwen-Audio 目标模型创建；Fun-ASR 使用独立的
`DASHSCOPE_FUNASR_VOCABULARY_ID`。上下文参数形状和限制以[官方 HTTP API](https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api)为准。

Prompt / 上下文用于提供领域背景、前文或会话信息；即时热词用于提高明确专有名词、人名、产品名的命中概率。需要随每次音频变化的背景优先用 Prompt，稳定且必须准确识别的短词优先用即时热词，二者可以同时配置。

### CLI 退出码语义

转写脚本在成功时以退出码 `0` 退出；出错时以非零退出码退出，便于脚本与 CI 判断成败：

```text
退出码 0   成功，SRT/JSON 已产出
退出码 1   调用方错误，如输入文件不存在、未配置 API Key、时长超限
退出码 2   转写完成但未识别到任何内容（静音/无有效语音），不会产出 SRT
```

错误消息写在 stderr（图形版会合并读取并透传具体原因），脚本自身不把业务错误打成静默成功。

## 用 Fun-ASR 转写（百炼第二模型，支持说话人）

在 Launcher 中选择阿里云百炼 Provider，再把模型切换为 `fun-asr（支持说话人）`。它复用 `DASHSCOPE_API_KEY`、地域和 Workspace 配置，默认输出名标签为 `.fun-asr.`。

命令行示例：

```powershell
uv run python generate_subtitle_qwen_api.py "D:\Videos\example.mp4" --model fun-asr -ll 2m --speaker-colors --json
```

常用可选项：

```text
--speaker            开启说话人分离，speaker 标签写入工程文件（不改变字幕颜色）
--speaker-colors     在 --speaker 基础上，把不同说话人一次性映射成 5 种字幕颜色
--language zh        只提供一个语种提示；默认自动识别
--with-waveform      把波形写进工程文件，CLI 默认不内嵌
```

Fun-ASR 普通文件限制为 12 小时 / 2 GB；说话人分离只适用于单声道，官方建议启用时音频不超过 2 小时。MAW 提交前会提取单声道音频，且超过建议时长时给出警告。说话人标签是匿名 ID，不是现实姓名；颜色只是普通工程字段，之后可以在 MAWE 中修改。

Fun-ASR 的 API 输入字段、轮询结果路径和 JSON 映射与 Qwen 不同，虽然二者共用一个入口脚本。实现细节和豆包 URL / Base64 调研记录在 [ASR_PROVIDER_RESEARCH.md](ASR_PROVIDER_RESEARCH.md)。

## 用 Soniox 转写（可选，支持说话人）

在 `.env` 填入 `SONIOX_API_KEY`（[console.soniox.com](https://console.soniox.com) 申请）后：

```powershell
uv run python generate_subtitle_soniox_api.py "D:\Videos\example.mp4" -ll 2m --json
```

常用可选项：

```text
--speaker            开启说话人分离，speaker 标签写入工程文件（不改变字幕颜色）
--speaker-colors     在 --speaker 基础上，把不同说话人一次性映射成 5 种字幕颜色
--language zh,en     语言提示，逗号分隔；默认自动识别
--with-waveform      把波形写进工程文件，CLI 默认不内嵌
```

颜色写入的是普通 `color` 字段，之后可在编辑器里自由修改；说话人超过 5 个时颜色循环复用并给出警告。

输出文件与 Qwen 流程相同（SRT / `.mosp` / edit.html），文件命名标签为 `.soniox.`。注意：Soniox 单文件最长 5 小时；token 粒度是 word/sub-word，中文不保证逐字；转写完成后脚本会自动删除云端文件与转写记录。

## 用必剪转写（实验性，免 Key，仅中文）

> [!warning]
> 必剪 ASR 是 B 站必剪产品的**非公开内部接口**，未授权第三方使用：可能随时变更、失效或触发限流甚至 IP 封禁。仅适合中文为主的轻量转写；重要或批量任务请改用上方正式供应商。

无需任何 API Key，直接运行：

```powershell
uv run python generate_subtitle_bcut_api.py "D:\Videos\example.mp4" -ll 2m --json
```

输出文件与其他供应商相同，文件命名标签为 `.bcut.`。逐字毫秒时间戳会写入工程 `items`，编辑器内拆分/合并仍保持准确。

上限管理（非官方接口的自我保护，不建议调整）：

```text
单文件时长上限    默认 2 小时（BCUT_MAX_AUDIO_SECONDS）
轮询间隔          默认 3 秒，硬下限 2 秒（BCUT_POLL_INTERVAL，配低了会被抬回）
轮询超时          默认 1800 秒（BCUT_POLL_TIMEOUT）
上传/建任务重试   最多 3 次，指数退避；分片顺序上传不并发
```

接口只直接接收 `flac / aac / m4a / mp3 / wav`；视频和其他音频格式会先经 ffmpeg 转成 16k 单声道 wav 再上传。不支持语言指定（面向中文）、说话人分离与热词。

## 3. 理解三个输出文件

| File | Use it for | Keep it? |
|---|---|---|
| `.srt` | 导入播放器、剪辑软件 | 可随时重新导出 |
| `.mosp` | 默认字幕工程文件和字级时间戳；内容是 UTF-8 JSON | **必须保留，建议备份** |
| `.json` | 旧版字幕工程文件；编辑器可继续打开、保存和另存为 | 已有旧工程请保留；新工程优先使用 `.mosp` |
| `.edit.html` | 带着工程走、离线检查 | 可从 `.mosp` / `.json` 再生成 |

命令行参数 `--json` 是历史兼容名称，表示“同时生成工程文件”；当前生成器默认写出 `.mosp`。保存工程时会保留当前扩展名，并在覆盖前创建同扩展名的 `.mosp.bak` 或 `.json.bak`。

如果只剩 `.mosp` 或 `.json` 工程文件，仍可重新生成 HTML：

```powershell
uv run python edit.py "D:\Videos\example.qwen3-asr-api.mosp" -m "D:\Videos\example.mp4"
```

如需跳过预计算波形（超大媒体首次启动较慢），加 `--no-waveform`；浏览器仍可在加载媒体后尝试计算波形。

## 4. 用推荐方式编辑

```powershell
uv run python server-editor\serve.py "D:\Videos\example.qwen3-asr-api.mosp"
```

服务器只监听本机 `127.0.0.1`。它会尝试按工程文件的 `media` 字段加载原媒体；媒体搬家后，显式指定：

```powershell
uv run python server-editor\serve.py "D:\Projects\subtitle.mosp" -m "E:\Media\moved-video.mp4"
```

如果关联媒体是 FLV，服务器会先复用媒体旁边的同名 MP4（例如 `clip.flv` 对应 `clip.mp4`）；不存在时再调用用户配置的 `FFMPEG_PATH`，或 PATH 中的 `ffmpeg`，把转换结果原子写回媒体旁边。Desktop 版使用随应用提供的 FFmpeg sidecar。工程仍保存可继续使用的媒体路径。

首次启动空白编辑器：

```powershell
uv run python server-editor\serve.py --blank
```

不带参数会默认恢复最近一次**明确打开**的工程。这个行为可在编辑器「最近工程」菜单第一项「自动打开上次工程」中开关；若只想本次空白启动，用 `--blank`。编辑器的“保存工程”（`Ctrl+S`，macOS 为 `Cmd+S`）会原子写回当前 `.mosp` 或 `.json` 文件，并在覆盖前创建同目录、保持原扩展名的 `.mosp.bak` 或 `.json.bak`；`Ctrl+Shift+S`（macOS 为 `Cmd+Shift+S`）为另存为。

服务器版的「保存工作区」会存到本机服务器设置中，并在之后打开其他工程时继续使用；一个工作区包含窗口布局与显示状态（字幕列表显示项、波形单/多行等）。四个内置工作区在“编辑布局”后可保存为本机覆盖版、重置为默认或另存为，但不可删除；自定义工作区则可保存、另存为或删除。它不会改写工程文件，也不会上传到网络。

## 5. 编辑和导出

- 双击文本改字；右键可以按文字或波形位置拆分、合并与批量替换。
- 可拖动波形中的字幕块或边缘微调时间；相邻字幕共享边界时会保持连续。
- 播放器内的字幕预览可直接拖动；悬停或聚焦后拖动八个手柄可缩放。方向键移动，`Shift` 加速移动，`Alt + 方向键` 调整尺寸。几何保存在工程 `preview.subtitle`，不会改变字幕时间。
- “移除静音空隙”只建立可逆的压缩时间线，不修改原媒体和原字幕时间。
- 常规 SRT 通过工具栏导出；若启用了空隙移除，可选择去空隙 SRT、OTIO、FFconcat 或保留区域 JSON。

完整 JSON 约束在 [JSON_SCHEMA.md](../JSON_SCHEMA.md)。若你打算用其他 ASR 或 LLM 生成工程，至少保证顶层有 `segments`，时间全部是整数毫秒。

## 常见问题

### 找不到 `ffmpeg` 或 `ffprobe`

安装 FFmpeg 后关闭并重开 PowerShell，再运行 `ffmpeg -version`。不要只把 `ffmpeg.exe` 放在仓库里；更稳妥的是把其 `bin` 目录加入系统 PATH。

macOS 从 Finder 启动 `.app` 时不一定会继承终端里的 PATH。Apple Silicon Homebrew 通常使用 `/opt/homebrew/bin`，Intel Homebrew 通常使用 `/usr/local/bin`；如果 Launcher 仍提示缺少 FFmpeg，可把对应目录填入「配置」中的 FFmpeg 路径，并确认其中同时存在 `ffmpeg` 和 `ffprobe`。macOS GUI 的配置会保存到 `~/Library/Application Support/Moy/MAW/.env`，不写入只读或被 App Translocation 隔离的 `.app` 包。

### 提示未配置 API Key

确认 `.env` 与脚本同级；Key 行没有引号、没有额外空格，且没有把 `.env.example` 当成 `.env` 使用。环境变量若存在会覆盖 `.env`。

### API 任务超时或上传失败

先确认网络与 API Key 地域；可在 `.env` 提高 `DASHSCOPE_POLL_TIMEOUT`。文件大小、时长、临时文件策略和计费以[官方百炼语音识别说明](https://help.aliyun.com/zh/model-studio/asr-model/)为准。

### Fun-ASR 提交返回 HTTP 403

MAW 会在 HTTP 状态后继续显示百炼返回的业务 `code`、`message` 和 `request_id`：

- `AllocationQuota.FreeTierOnly`：免费额度已用完且账户启用了“仅使用免费额度”，需要在百炼控制台关闭该开关或开通按量付费。
- `AccessDenied` + `Access denied by API-Key restrictions.`：当前 API Key 使用了自定义权限，但可访问模型范围不包含 Fun-ASR，或者 IP 白名单不允许当前网络。在百炼 API Key 页面编辑该 Key，把权限改为“全部”，或在“自定义”中加入 `fun-asr` 并核对 IP 白名单。若 Key 属于子业务空间，还要由超级管理员为该空间开放 Fun-ASR 模型调用。
- `Workspace.AccessDenied` / `WorkSpaceNotFound`：检查 API Key、地域和 Workspace ID 是否属于同一业务空间。
- 只有通用 `AccessDenied`：检查当前地域是否提供 Fun-ASR、账户是否有模型权限，以及 API Key 是否已失效。

北京地域不填写 Workspace ID 时仍使用兼容域名 `dashscope.aliyuncs.com`；填写后使用官方推荐的 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` 专属域名。新加坡地域必须填写 Workspace ID。通过 HTTP 提交临时 `oss://` URL 时，MAW 已自动附加官方要求的 `X-DashScope-OssResourceResolve: enable`，无需用户手动处理。

### HTML 打开了但不能稳定拖动视频进度

优先用 `server-editor\\serve.py`。不要用 `python -m http.server` 替代它；该服务器专门实现了媒体 Range 响应。

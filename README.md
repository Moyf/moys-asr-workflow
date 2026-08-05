# Moy's ASR Workflow（MAW）

QQ 交流群：[1079160201](https://qm.qq.com/q/4YtxZIpzxC)

> Up 精力有限，如有新需求请提 Issues，Q群仅供交流不接CPU。

## 这是什么

这是个 2026 年新时代的**字幕生成+编辑**工作流：  
把一个视频或音频交给 AI 转写，得到可编辑的字幕工程和SRT文件。  

全过程快到你反应不过来！  
<img src="assets/show.webp" width="300" alt="sticker">

## MAW 组成
Moy 的 ASR 工作流由两部分组成：  

- **MAW Launcher**：负责媒体处理和发送 AI 转写请求，生成工程并启动编辑器。  

![launcher](assets/launcher.jpg)  

> 当前支持模型：阿里云百炼 Qwen / Fun-ASR 或 Soniox 云端 ASR API  

- **MOSE / MAWE**：搭配使用的字幕编辑器，功能有九分甚至十分的强劲：

![MAWE 字幕编辑器预览](assets/screenshot-v1.2.0.jpg)  

*Windows 和 macOS Release 默认使用 MOSE 桌面编辑器；Server 版和单文件版 MAWE 仍作为备用入口。*

## 如何使用

[点我下载最新版](https://github.com/Moyf/moys-asr-workflow/releases/latest)，根据电脑情况选一个：

- `MAWxFF-Windows-x64-v*.zip`：已经捆绑 MAW 与 MOSE 会用到的 `ffmpeg.exe` 和 `ffprobe.exe`；没有 FFmpeg、或者不知道它是什么，下载这个。
- `MAW-Windows-x64-v*.zip`：体积更小；适合已经安装 FFmpeg，并且终端能直接运行 `ffmpeg` / `ffprobe` 的用户。
- `MAWxFF-macOS-arm64-v*.zip`：Apple Silicon Mac（M1/M2/M3/M4）版，已经捆绑 `MAW.app`、`MOSE.app`、`ffmpeg` 和 `ffprobe`；不需要另外安装 FFmpeg。
- `MAW-macOS-arm64-v*.zip`：Apple Silicon Mac 版，体积更小；同样包含 `MAW.app` 和 `MOSE.app`，但需要系统能找到 `ffmpeg` 和 `ffprobe`。目前 macOS 图形 Release 只提供 arm64 包。

Windows 下载解压之后点击 `MAW.exe` 并运行；macOS 下载后解压并打开 `MAW.app`，`MOSE.app` 会放在同一目录供 Launcher 调用。

### 申请 API Key

> [!tip]
> [如何获取阿里云百炼的 Qwen-Audio/Fun-ASR API](https://help.aliyun.com/zh/model-studio/get-api-key)
> （不含广告，默认使用最新的 Qwen-Audio 3.0 ASR 模型，支持长音频、热词、说话人分离和提示词）

如果你更在意小语种多语言，可以使用 [Soniox Console](https://console.soniox.com) 申请 Key。

**两个 Key 不需要同时配置，用到哪个配哪个即可。**

配完之后点击「保存到本地环境」，下次就不用重复配置了。

<details>
<summary>🔐 为了方便你快速体验，你可以先用这个 key 尝试 </summary>
  
**解密网站：** [魔曰](https://abracadabra-demo.pages.dev/)

**话语：** `此夜有早鹤远璃，智水清路。遥书为鹏兮，惠琴为路。局以莹聪，恭登益莺，此鸳有长天美星，盈涧青声。是家也，声悦冰高，裳寒光雅。或探冰动鸳，行叶于空，事瑞竹，学莹语。此鹂有临树瀚琴，青铃秋语。鹤鹤见雪，莹于雪叶，余恋静飞，恋文湛换。或关城探鹏，见木于韵，飞瑞鸳，驿聪楼良，乃后关。此心有瀚火速棋，聪鸳盈光。不必问也，或学铃留鸢，致月于雨。流早霞，恋明楼善，乃速探。莹风定棋，书莺致福。虽返说极悠，明少不同。此礼有彩光青天，纯火旧鲤。此铃有慧声新木，绮恋冷棋，或振水选家，流驿于镜。`  
  
**密钥：** `moimoi`
  
> 目前应该还剩6小时的额度，**请勿滥用**，如果发现异常情况我会直接禁用这个key ヽ(\` 3 ´)ﾉ  
> 用不了了就说明额度被薅光了，为了方便大家体验，还请尽量只做2分钟内的测试，觉得 OK 再申请 API 来用w

</details>


## 流程说明

1. 在 Launcher 中打开媒体，填写 API Key 后，点击 **生成字幕和工程**——MAW 会调用对应的模型把本地视频或音频转为字幕，同时生成工程文件。
2. 如果你不需要精校字幕，直接用生成的 srt 字幕文件即可 🎉
3. 如果你需要对字幕进行更复杂的编辑，点击「打开编辑器」后使用 MOSE；也可以从右侧菜单启动 Server 版或 HTML 编辑器。
4. 操作完成后，点击右上角按钮导出你所需的 SRT 字幕或是其他附加格式。

所有编辑都在本机完成。  
转写时，脚本会把待识别媒体直接上传到你选择的阿里云百炼或 Soniox 账户；本项目没有自己的服务器、不会代管你的 API Key 或媒体。

## 你需要准备

- 至少一个云端 ASR API Key：可以用[阿里云百炼](https://help.aliyun.com/zh/model-studio/get-api-key)调用 Qwen 或 Fun-ASR，也可以用支持说话人分离的 [Soniox](https://console.soniox.com)。
- [Windows 图形版](https://github.com/Moyf/moys-asr-workflow/releases/latest)：Windows 10/11；下载 `MAWxFF` 不需要另外安装 FFmpeg，下载普通版则需要系统里已经有 `ffmpeg` 和 `ffprobe`。
- [macOS 图形版](https://github.com/Moyf/moys-asr-workflow/releases/latest)：目前提供 Apple Silicon arm64；下载 `MAWxFF` 不需要另外安装 FFmpeg，下载普通版则需要系统里已经有 `ffmpeg` 和 `ffprobe`。
- 从源码或命令行运行：Python 3.11 或更新版本、[uv](https://docs.astral.sh/uv/getting-started/installation/)（推荐），以及 [FFmpeg](https://ffmpeg.org/download.html)。macOS/Linux 也可尝试。

> [!note]
> 本地模型版本正在开发中…… 

<details>
<summary>废话压缩</summary>
同一平台的两个版本 MAW 功能完全一样，区别只有是否捆绑 FFmpeg。Windows 解压后双击 `MAW.exe`；macOS 打开 `.app`，Launcher 会带你完成这条流程：

```text
选择供应商和媒体 -> 生成 SRT + .mosp 工程 -> 打开 MOSE 校对 -> 保存或导出
```

在 Launcher 里选择阿里云百炼或 Soniox、媒体与 SRT 输出位置，确认模型、语言和可选时长上限，填写对应的 API Key，即可生成 SRT、`.mosp` 工程和便携编辑器 HTML。阿里云百炼 Provider 默认使用最新发布的 `qwen-audio-3.0-asr（热词 / 上下文）`，也可以选择 `fun-asr（支持说话人）` 或 `qwen3-asr（准确率更高）`。需要复用 Key 时，可点“存入本地环境”；密钥只保存在本机 `.env`，不会写入工程文件或日志。

Launcher 的「打开编辑器」默认启动 MOSE 并传入工程路径。Windows 会优先读取当前用户注册表 `HKCU\Software\Moy\MOSE` 下仍有效的 `ExecutablePath`，macOS 则查找 `MOSE.app` 并启动其中的编辑器；找不到桌面版时，Server 版字幕编辑器和 HTML 空工程仍可从按钮右侧的拓展菜单打开。首次启动 Windows MAW 时还会为当前用户登记 `.mosp` 关联。GUI 还可以直接选择 `.mosp` / `.json` 工程并启动 `http://127.0.0.1` 本地编辑器服务器；中英文界面可在右上角切换。
启动器支持从资源管理器拖入音视频文件来自动填充媒体路径，并按供应商组织模型、地域、语言和 API Key 获取入口；选择 Fun-ASR 或 Soniox 时可在「高级选项」中开启「给不同说话人分配字幕颜色」。

Windows Release 的 Launcher 会优先打开同目录 MOSE；macOS 会查找同目录、包内或常见安装位置的 `MOSE.app`。如果找不到桌面版，可以从右侧菜单启动 Server 版或 HTML 编辑器。普通版仍要求系统能找到 `ffmpeg` 和 `ffprobe`；如果 Launcher 提示未检测到 FFmpeg，可以换用同平台的 `MAWxFF` 版，也可以自行安装 FFmpeg，把它的 `bin` 目录加入 PATH 后重新打开 MAW。

### 本地构建 Windows 图形包

需要在 Windows 上构建；PyInstaller 不能在其他系统上交叉编译 Windows 包。先安装 Python 3.11+、[uv](https://docs.astral.sh/uv/getting-started/installation/)、Node.js 和 Rust 工具链，然后在仓库根目录的 PowerShell 中执行：

```powershell
uv sync --group build --frozen
.\scripts\build-windows.ps1
```

构建脚本会安装锁定的构建依赖、运行打包契约测试，使用 `MAW.spec` 生成 PyInstaller `onedir` 包，并构建 `MOSE.exe` 放入同一目录。输出目录为 `dist\MAW\`，启动程序是 `dist\MAW\MAW.exe`；分发时要保留整个目录，不能只复制 exe 文件。

需要跳过打包契约测试时可以使用：

```powershell
.\scripts\build-windows.ps1 -SkipTests
```

本地脚本生成的是不捆绑 FFmpeg 的普通版。要生成带 `ffmpeg.exe` 和 `ffprobe.exe` 的 `MAWxFF` 版，还需要按 `.github/workflows/release-windows.yml` 中的 Release 流程准备并校验 FFmpeg；日常本地构建通常直接使用 `dist\MAW\` 即可。

### 本地构建 macOS 图形包

需要在 Apple Silicon macOS runner 或 Mac 上构建；PyInstaller 和 Tauri 都不会为 macOS 交叉编译。进入仓库根目录执行：

```bash
uv sync --group build --frozen
uv run --group build pyinstaller --noconfirm --clean MAW.spec
cd desktop
npm ci
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --config src-tauri/tauri.macos.conf.json --bundles app --no-sign
```

MAW 的 App 在 `dist/MAW.app`，MOSE 的 App 在 `desktop/src-tauri/target/release/bundle/macos/MOSE.app`。正式 Release 会把两个 App 放进普通版和 `MAWxFF` 版 ZIP 的同一目录；未签名的本地构建可能需要在 macOS「隐私与安全性」中手动允许启动。

### MOSE / MAWE 编辑器入口

Windows 和 macOS Release 中，Launcher 主按钮会打开同目录的 MOSE 桌面编辑器并传入当前 `.mosp` / `.json` 工程。需要 localhost 工作流时，从按钮右侧菜单选择「启动 Server 版字幕编辑器」；需要最便携的浏览器方式时，选择 HTML 编辑器。

### 传统命令行方案

也可以从源码启动同一界面：

```powershell
uv run python maw_gui.py
```

下面的命令行方式仍完整保留，适合自动化和精细参数调整。

在 PowerShell 中执行：

```powershell
git clone https://github.com/Moyf/moys-asr-workflow moys-asr-workflow
cd moys-asr-workflow
uv sync
Copy-Item .env.example .env
```

打开新建的 `.env`，按你准备使用的供应商至少填一个 Key：

```ini
DASHSCOPE_API_KEY=sk-替换成你的真实密钥
SONIOX_API_KEY=替换成你的 Soniox Key
```


然后转写一个文件：

```powershell
uv run python generate_subtitle_qwen_api.py "D:\Videos\example.mp4" --json
```

首次成功会在媒体同目录生成：

- `…qwen-audio….srt`：可导入播放器或剪辑软件的字幕；
- 同名 `.mosp`：**工程真源**，以后继续编辑请保留它。`.mosp` 文件内容仍是 UTF-8 JSON；编辑器和服务器也兼容打开、保存旧的 `.json` 工程。

命令行里的 `--json` 参数名称为兼容旧版本而保留；它表示“同时生成工程文件”，当前默认扩展名是 `.mosp`，不是要求输出一个名为 `.json` 的文件。

建议先只处理两分钟，确认 API、FFmpeg 与输出目录都正确：

```powershell
uv run python generate_subtitle_qwen_api.py "D:\Videos\example.mp4" -ll 2m --json
```

如果不使用 uv，请看 [docs/WORKFLOW.md](docs/WORKFLOW.md) 的普通 Python 安装方式。


## 百炼 qwen-audio-3.0-asr-flash-filetrans（热词与上下文）

Qwen-Audio 使用同一个 `DASHSCOPE_API_KEY`、地域和临时 OSS 上传链路。Launcher 和 CLI 默认都使用 `qwen-audio-3.0-asr-flash-filetrans`；需要切换其他模型时再通过 `--model` 或 Launcher 的模型选择器指定。

```powershell
uv run python generate_subtitle_qwen_api.py "D:\Videos\example.mp4" --json
```

它支持 Qwen-Audio 专用的即时热词、预编译词表和 context：

- Launcher 的高级选项会在选择 Qwen-Audio 后显示「附加上下文（Prompt）」、「即时热词」和默认热词权重；即时热词支持直接输入或从 UTF-8 `.txt` 文件读取。每项也可写成 `热词: 权重` 或 `热词：权重` 单独覆盖默认权重，权重只能是 1–5 或 50。预编译 `vocabulary_id` 暂不在 Launcher 开放，底层 CLI / `.env` 能力保留。这些 Launcher 值只随本次转写发送，不会保存到 `.env`。
- `hotwords.txt`：默认热词文件，每行一个即时热词；也可用 `--hotword-file path.txt` 指定其他 UTF-8 文本文件。可用 `--hotword-weight 1` 到 `5` 或 `50` 调整权重。
- 命令行可重复使用 `--hotword "词"` 追加本次即时热词；它会和 `hotwords.txt` 合并。
- `DASHSCOPE_QWEN_AUDIO_VOCABULARY_ID` 或 `--vocabulary-id`：使用百炼预先创建的词表；词表的目标模型必须是 Qwen-Audio。
- `--context "领域词表或前文"`：通过 `input.messages` 发送最多 400 字符的上下文；较长内容建议用 `--context-file` 或 `.env` 中的 `DASHSCOPE_QWEN_AUDIO_CONTEXT_FILE`。
- `--speaker` / `--speaker-colors`：开启说话人分离和可选颜色快照。

即时热词按百炼规则校验：含非 ASCII 字符的单项最多 15 个字符，纯 ASCII 单项最多 7 个空格分隔的单词，每次最多 2000 项，权重 50 最多 50 项。不符合规则的输入会在 Launcher 下方警告，并在发送时忽略。

Qwen-Audio 的输出默认使用 `.qwen-audio.` 文件名标签。即时热词与预编译词表同时配置时，以百炼服务端规则为准；Fun-ASR 需要单独创建并配置 `DASHSCOPE_FUNASR_VOCABULARY_ID`。

Prompt / 上下文与即时热词的选择：Prompt 适合描述本次音频的领域、前文或会话背景，例如“这是某产品发布会，涉及 XXX、YYY”；即时热词适合明确的专有名词、人名、产品名，需要模型重点命中。变化频繁、需要解释上下文时优先 Prompt；稳定、短小、必须准确识别的词优先即时热词。两者也可以同时使用。


## 百炼 fun-asr（同一供应商，支持说话人）

Fun-ASR 与 Qwen 共用 `DASHSCOPE_API_KEY`、地域配置和临时 OSS 上传链路。在 Launcher 的阿里云百炼 Provider 下把模型切换为 `fun-asr（支持说话人）` 即可；开启「给不同说话人分配字幕颜色」后，Launcher 会同时启用说话人分离。

命令行也可以直接选择第二个模型：

```powershell
uv run python generate_subtitle_qwen_api.py "D:\Videos\example.mp4" --model fun-asr --speaker-colors --json
```

- `--speaker`：只把匿名 speaker 标签写入工程文件，不改变字幕颜色。
- `--speaker-colors`：启用说话人分离，并把不同说话人映射为 5 种可继续编辑的字幕颜色。
- 默认输出名使用 `.fun-asr.` 标签；支持词级毫秒时间戳和自动语种识别。
- 普通文件最长 12 小时 / 2 GB；开启说话人分离时仅支持单声道，官方建议控制在 2 小时以内。MAW 上传的是单声道音频。
- `hotwords.txt` 暂不会自动注入 Fun-ASR；百炼需要先创建热词表并传 vocabulary ID。

## Soniox STT（第二供应商，支持说话人）

也可以用 [Soniox](https://soniox.com) 的异步 STT API 转写：

- token 级毫秒时间戳（粒度是 word/sub-word，中文不保证逐字）
- 可选说话人分离（token 级 speaker 标签，单次任务最多 15 人）
- 60+ 语言与自动语言识别，适合多语言/小语种素材
- 约 $0.10/小时按量计费；2025-10 起新注册 API 不再赠送免费额度
- 单文件最长 5 小时；转写完成后脚本自动清理云端文件与转写记录

在 `.env` 填入 `SONIOX_API_KEY`（[console.soniox.com](https://console.soniox.com) 申请），然后：

```powershell
uv run python generate_subtitle_soniox_api.py "D:\Videos\example.mp4" --json
```

开启说话人分离，speaker 标签写入工程文件（不改变字幕颜色）：

```powershell
uv run python generate_subtitle_soniox_api.py "D:\Videos\example.mp4" --speaker --json
```

在说话人基础上，把不同说话人一次性映射成 5 种字幕颜色：

```powershell
uv run python generate_subtitle_soniox_api.py "D:\Videos\example.mp4" --speaker-colors --json
```

颜色写入的是普通 `color` 字段，之后可在编辑器里自由修改；说话人超过 5 个时颜色循环复用并给出警告。`--language zh,en` 可提供语言提示。

</details>


## MOSE — Moy's Open Subtitle Editor

MOSE/MAWE 是 MAW 自带的字幕编辑器。  
推荐使用它的本地服务器模式：可稳定拖动大型媒体、保留最近工程记录、支持直接保存工程以及自动加载表情包路径。

MAWE 是 MAW Editor，原始版本，纯网页实现，可以用 HTML 单文件或者启动 Server；

需要手动启动 Server 版编辑器时，点击 Launcher 右侧菜单的「启动 Server 版字幕编辑器」，或者运行：
```powershell
uv run python server-editor\serve.py "D:\Videos\example.qwen3-asr-api.mosp"
```

浏览器会自动打开 `http://127.0.0.1:8250`。

MOSE 是 Tauri 打包的独立可执行文件，看起来比较专业（？）

编辑器右上角可切换中文 / English；编辑完成后点“保存工程”或按 `Ctrl+S`，覆盖前会留下同目录、保持原扩展名的备份（`.mosp.bak` 或 `.json.bak`）；`Ctrl+Shift+S` 为另存为。

服务器版还可以把「工作区」保存在本机服务器设置中，因此可跨工程复用：一个工作区包含窗口布局与显示状态（字幕列表显示项、波形单/多行等）。四个内置工作区在“编辑布局”后可保存为本机覆盖版、重置为默认或另存为，但不可删除；选中自己保存的工作区后，可以继续保存、另存或删除。工作区只保存在本机，不写入工程文件。

> [!important]
> 除了服务器版本，也支持同时生成更为便携的 HTML 单文件编辑器。
> 功能相对缺少一些，但是90%的编辑体验是相同的——生成的时候勾选「同时生成单文件编辑器」后，直接双击转写生成的 `.edit.html` （或者用 Launcher 中的“打开该项目的单文件编辑器”打开工程。  
> 单 HTML 文件模式适合你嫌起服务器麻烦（或者搞不来）；本地服务器模式更适合日常编辑。现在有了 exe/app 版本的话，就都用 MOSE 好啦。

### 目前支持的特性

- 基础部分
  - 字幕：字幕列表与播放器播放时间绑定；点击字幕或波形可跳转到对应位置，播放器下方提供独立播放控制栏。
  - 拆分或合并字幕 ⭐：工程文件含字/词级时间码时，**拆分后会按这些时间码分配两侧的时间，仍能保持准确**。
  - 可显示当前单句的时长、字数和阅读速度，并过滤过长文本。
  - 可预览并批量替换关键词。
  - 视频画面内的字幕预览可直接拖动和缩放；位置与大小保存在工程文件中，撤销/重做、localhost 保存及便携 HTML 导出后仍会保留。
  - 可检测并移除静音空隙；这不会改写原始媒体或原始字幕时间，而是建立可撤销的压缩时间线供播放和导出使用。
  - 可用「拼合字幕」整理细碎字幕：把间隔小于阈值（默认 200ms）的相邻字幕拓展贴合，并吸收过短的字幕（默认中文少于 3 字 / 英文少于 3 词）；拓展与吸收方向均可配置。
  - 可保存 `.mosp` / `.json` 工程，或导出标准 SRT 字幕。
- 操作部分
  - WASD 快速跳转前后字幕
  - Enter 进入字幕编辑模式
  - 更多操作详见右上角 **【🤔 帮助】** 按钮。
- 拓展部分
  - 可给字幕附加**表情包**或**颜色**，并在多句字幕之间保持关联。
  - 可导出 Resolve JSON；配合兼容的达芬奇执行脚本，可在达芬奇内批量导入字幕颜色与表情包配置。执行脚本不随这个最小版 MAW 发布。

> [!note]  
> 多行波形相关特性参考了 [gap-gone](https://github.com/LiRenTech/gap-gone) 项目 ❤️

详细的使用方法、数据要求、快捷键和导出说明见 [编辑器指南](docs/EDITOR_GUIDE.md)。完整步骤、常用参数与排错见 [docs/WORKFLOW.md](docs/WORKFLOW.md)，工程文件的数据结构见 [JSON_SCHEMA.md](JSON_SCHEMA.md)。

## 关于 API

- 这是 **API-first** 工具，不含模型下载和本地推理引擎。
- API Key 仅读取自环境变量或本机 `.env`；`.env` 已被 Git 忽略，绝不要提交、截图或发给别人。
- 每次转写会使用你的 Key 调用所选供应商；文件大小、数据保留与账户政策请分别查看[百炼语音识别文档](https://help.aliyun.com/zh/model-studio/asr-model/)或 [Soniox 文档](https://soniox.com/docs)。
- 百炼 Provider 提供 `qwen3-asr-flash-filetrans`、`qwen-audio-3.0-asr-flash-filetrans` 和 `fun-asr`，支持北京与新加坡地域；北京可选填 Workspace ID 使用推荐的专属域名，新加坡必须填写。Qwen-Audio、Fun-ASR 与 Soniox 均可选说话人分离。配置项说明都在 `.env.example`。

### 费用

- 本项目本身是开源项目，可免费使用；默认模型为阿里云百炼最新发布的 Qwen-Audio 3.0，也可以在 GUI 或命令行里改用同 Provider 的 Qwen3-ASR、Fun-ASR 或 Soniox。
- 阿里云 Qwen ASR 注册后免费赠送 10 小时转录时间，超出额度后按 `0.792 元/小时` 计费，详见 [价格文档](https://help.aliyun.com/zh/model-studio/model-pricing#dbf1305ef4a69)。
- Soniox 异步文件转写约 `$0.10/小时`，适合需要说话人分离、多语言或小语种的素材，详见 [Soniox Pricing](https://soniox.com/pricing)。
- 如果你有不错的配置，也可以自己本地部署开源的 [QwenASR](https://github.com/QwenLM/Qwen3-ASR) 本地转录，不产生云端费用，只需要一点电费。

😭*我说我只有一台 AMD 显卡的台式机和一台 Mac Mini 所以跑不了本地模型有懂的吗*  

## 致谢

❤️ 感谢 @Hanekit 老师的宝贵意见和建议  
❤️ 感谢 @大狗 老师的超绝可爱表情包支持  
❤️ 感谢 @LiRenTech 的 [gap-gone](https://github.com/LiRenTech/gap-gone) 项目  
<sup>本项目的多行波形和空隙去除灵感皆来源于此</sup>  
🤖 感谢 ChatGPT 和 OpenCode 的代码助力（咦）  
<sup>主要由 gpt-5.6、KimiK3 和 glm-5.2 协作生产</sup>

## 许可证

本项目采用 [AGPL-3.0-only](LICENSE)。若你修改后把它作为网络服务提供给用户，AGPL 通常要求向这些用户提供对应的修改后源码；发布前请自行确认你的合规义务。

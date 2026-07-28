# Moy's ASR Workflow（MAW）

把一个视频或音频交给 Qwen 或 Soniox 云端 ASR API，得到可编辑的字幕工程、SRT 和浏览器字幕编辑器。

![MAWE 字幕编辑器预览](assets/screenshot-v1.1.0.jpg)

**MAW** 是 Moy's ASR Workflow 的简称。  
现在的使用流程已经收束到 **Launcher**：选择本地媒体和 Qwen / Soniox 云端 ASR，生成 SRT + JSON 工程，再进入 MAWE 浏览器编辑器校对和导出。Windows 用户不需要先学命令行，也不需要 GPU；本项目仍然保持轻量，不包含本地模型、其他 ASR 引擎或自动下载模型。

> [!tip]
> **Windows 用户：[点我下载最新版](https://github.com/Moyf/moys-asr-workflow/releases/latest)**
>
> 电脑里已经装好 FFmpeg，就下载体积更小的 `MAW-Windows-x64-v*.zip`；没有安装、或者不知道 FFmpeg 是什么，就下载 `MAWxFF-Windows-x64-v*.zip`。解压后双击 `MAW.exe`，从 Launcher 开始就行。

> 之后会有更完整的 **Moy's Open Subtitle Editor（MOSE）**：不需要懂编程也能直接用的整合工作站！  
> 这个仓库会保持小而可用，并为将来导入 MOSE 留出工程 JSON 的兼容路径；详见 [docs/MOSE.md](docs/MOSE.md)。

## 这套工具能做什么

1. 用 Qwen 或 Soniox API 把本地视频或音频转为字幕。
2. 一次生成 `.srt`、含字级时间戳的 `.json` 工程和单文件 `.edit.html`。
3. 在浏览器中校正文本、时间、波形、静音空隙和字幕布局。
4. 导出 SRT、工程 JSON，以及编辑器支持的额外格式。

所有编辑都在本机浏览器完成。  
转写时，脚本会把待识别媒体直接上传到你选择的阿里云百炼或 Soniox 账户；本项目没有自己的服务器、不会代管你的 API Key 或媒体。

## 你需要准备

- 至少一个云端 ASR API Key：可以用[阿里云百炼 Qwen](https://help.aliyun.com/zh/model-studio/get-api-key)，也可以用支持说话人分离的 [Soniox](https://console.soniox.com)。
- Windows 图形版：Windows 10/11；下载 `MAWxFF` 不需要另外安装 FFmpeg，下载普通版则需要系统里已经有 `ffmpeg` 和 `ffprobe`。
- 从源码或命令行运行：Python 3.11 或更新版本、[uv](https://docs.astral.sh/uv/getting-started/installation/)（推荐），以及 [FFmpeg](https://ffmpeg.org/download.html)。macOS/Linux 也可尝试。

## 最快上手：从 Launcher 开始

### Windows 图形界面

[点我下载最新版](https://github.com/Moyf/moys-asr-workflow/releases/latest)，根据电脑情况选一个：

- `MAWxFF-Windows-x64-v*.zip`：已经捆绑 MAW 会用到的 `ffmpeg.exe` 和 `ffprobe.exe`；没有 FFmpeg、或者不知道它是什么，下载这个。
- `MAW-Windows-x64-v*.zip`：体积更小；适合已经安装 FFmpeg，并且终端能直接运行 `ffmpeg` / `ffprobe` 的用户。

两个版本的 MAW 功能完全一样。解压后双击 `MAW.exe`，Launcher 会带你完成这条流程：

```text
选择供应商和媒体 -> 生成 SRT + JSON 工程 -> 打开 MAWE 校对 -> 保存或导出
```

在 Launcher 里选择 Qwen 或 Soniox、媒体与 SRT 输出位置，确认模型、语言和可选时长上限，填写对应的 API Key，即可生成 SRT、JSON 工程和便携编辑器 HTML。需要复用 Key 时，可点“存入本地环境”；密钥只保存在本机 `.env`，不会写入工程文件或日志。

GUI 还可以直接选择工程 JSON 并启动 `http://127.0.0.1` 本地编辑器服务器；中英文界面可在右上角切换。
启动器支持从资源管理器拖入音视频文件来自动填充媒体路径，并按供应商（Qwen / Soniox）组织模型、地域、语言和 API Key 获取入口；选择 Soniox 时可在「高级选项」中开启「给不同说话人分配字幕颜色」。

普通版仍要求系统能找到 `ffmpeg` 和 `ffprobe`。如果 Launcher 提示未检测到 FFmpeg，可以换用 `MAWxFF` 版；也可以自行安装 FFmpeg，把它的 `bin` 目录加入 PATH 后重新打开 MAW。

也可以从源码启动同一界面：

```powershell
uv run python maw_gui.py
```

如果本机 WebView 运行环境异常，可临时使用旧版 tkinter 界面：

```powershell
uv run python maw_gui.py --tk
```

下面的命令行方式仍完整保留，适合自动化和精细参数调整。

> [!tip]
> **给人类**：把这个项目地址发给你的 AI Agent 然后让它参考文档操作即可！  
> <img src="assets/show.webp" width="300" alt="sticker">

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

> [!tip]
> [如何获取 QwenASR 的 API](https://help.aliyun.com/zh/model-studio/get-api-key)  
> （不含广告，用 QwenASR 只是因为我测试下来它中文转录表现最好）

如果你更在意多语言或说话人分离，可以直接用 [Soniox Console](https://console.soniox.com) 申请 Key；两个 Key 不需要同时配置。


<details>
<summary>🔐 为了方便你快速体验，你可以先用这个 key 尝试 </summary>
  
**解密网站：** [魔曰](https://abracadabra-demo.pages.dev/)

**话语：** `此夜有早鹤远璃，智水清路。遥书为鹏兮，惠琴为路。局以莹聪，恭登益莺，此鸳有长天美星，盈涧青声。是家也，声悦冰高，裳寒光雅。或探冰动鸳，行叶于空，事瑞竹，学莹语。此鹂有临树瀚琴，青铃秋语。鹤鹤见雪，莹于雪叶，余恋静飞，恋文湛换。或关城探鹏，见木于韵，飞瑞鸳，驿聪楼良，乃后关。此心有瀚火速棋，聪鸳盈光。不必问也，或学铃留鸢，致月于雨。流早霞，恋明楼善，乃速探。莹风定棋，书莺致福。虽返说极悠，明少不同。此礼有彩光青天，纯火旧鲤。此铃有慧声新木，绮恋冷棋，或振水选家，流驿于镜。`  
  
**密钥：** `moimoi`
  
> 目前应该还剩6小时的额度，**请勿滥用**，如果发现异常情况我会直接禁用这个key ヽ(\` 3 ´)ﾉ  
> 用不了了就说明额度被薅光了，为了方便大家体验，还请尽量只做2分钟内的测试，觉得 OK 再申请 API 来用w

</details>


然后转写一个文件：

```powershell
uv run python generate_subtitle_qwen_api.py "D:\Videos\example.mp4" --json
```

首次成功会在媒体同目录生成：

- `…qwen3-asr-api….srt`：可导入播放器或剪辑软件的字幕；
- 同名 `.json`：**工程真源**，以后继续编辑请保留它；
- 同名 `.edit.html`：可双击离线打开的自包含编辑器。

建议先只处理两分钟，确认 API、FFmpeg 与输出目录都正确：

```powershell
uv run python generate_subtitle_qwen_api.py "D:\Videos\example.mp4" -ll 2m --json
```

如果不使用 uv，请看 [docs/WORKFLOW.md](docs/WORKFLOW.md) 的普通 Python 安装方式。

## Soniox STT（第二供应商，支持说话人）

除 Qwen 外，也可以用 [Soniox](https://soniox.com) 的异步 STT API 转写：

- token 级毫秒时间戳（粒度是 word/sub-word，中文不保证逐字）
- 可选说话人分离（token 级 speaker 标签，单次任务最多 15 人）
- 60+ 语言与自动语言识别，适合多语言/小语种素材
- 约 $0.10/小时按量计费；2025-10 起新注册 API 不再赠送免费额度
- 单文件最长 5 小时；转写完成后脚本自动清理云端文件与转写记录

在 `.env` 填入 `SONIOX_API_KEY`（[console.soniox.com](https://console.soniox.com) 申请），然后：

```powershell
uv run python generate_subtitle_soniox_api.py "D:\Videos\example.mp4" --json
```

开启说话人分离，speaker 标签写入工程 JSON（不改变字幕颜色）：

```powershell
uv run python generate_subtitle_soniox_api.py "D:\Videos\example.mp4" --speaker --json
```

在说话人基础上，把不同说话人一次性映射成 5 种字幕颜色：

```powershell
uv run python generate_subtitle_soniox_api.py "D:\Videos\example.mp4" --speaker-colors --json
```

颜色写入的是普通 `color` 字段，之后可在编辑器里自由修改；说话人超过 5 个时颜色循环复用并给出警告。`--language zh,en` 可提供语言提示。

## MAWE — Moy's ASR Workflow Editor

MAWE 是 MAW 自带的字幕编辑器。  
推荐使用它的本地服务器模式：可稳定拖动大型媒体、自动载入 JSON 中记录的媒体路径，并支持安全保存工程：

```powershell
uv run python server-editor\serve.py "D:\Videos\example.qwen3-asr-api.json"
```

浏览器会自动打开 `http://127.0.0.1:8250`。MAWE 右上角可切换中文 / English；编辑完成后点“保存工程”或按 `Ctrl+S`，覆盖前会留下同目录 `.json.bak` 备份；`Ctrl+Shift+S` 为另存为。按 `Ctrl+C` 停止服务。

> [!important]
> 也可以直接双击转写生成的 `.edit.html`，或双击仓库里的 `blank-editor.html` 后用“打开工程”同时选择 JSON 和媒体。  
> 单 HTML 文件模式适合你嫌起服务器麻烦（或者搞不来）；本地服务器模式更适合日常编辑，因为更容易和本机文件做交互。

### 目前支持的特性

- 基础部分
  - 字幕：字幕列表与播放器播放时间绑定；点击字幕或波形可跳转到对应位置。
  - 拆分或合并字幕 ⭐：工程 JSON 含字/词级时间码时，拆分后会按这些时间码分配两侧的时间，仍能保持准确。
  - 可显示当前单句的时长、字数和阅读速度，并过滤过长文本。
  - 可预览并批量替换关键词。
  - 视频画面内的字幕预览可直接拖动和缩放；位置与大小保存在 JSON 工程中，撤销/重做、localhost 保存及便携 HTML 导出后仍会保留。
  - 可检测并移除静音空隙；这不会改写原始媒体或原始字幕时间，而是建立可撤销的压缩时间线供播放和导出使用。
  - 可保存 JSON 工程，或导出标准 SRT 字幕。
- 拓展部分
  - 可给字幕附加**表情包**或**颜色**，并在多句字幕之间保持关联。
  - 可导出 Resolve JSON；配合兼容的达芬奇执行脚本，可在达芬奇内批量导入字幕颜色与表情包配置。执行脚本不随这个最小版 MAW 发布。

> [!note]  
> 多行波形相关特性参考了 [gap-gone](https://github.com/LiRenTech/gap-gone) 项目 ❤️

详细的使用方法、数据要求、快捷键和导出说明见 [编辑器指南](docs/EDITOR_GUIDE.md)。完整步骤、常用参数与排错见 [docs/WORKFLOW.md](docs/WORKFLOW.md)，工程 JSON 结构见 [JSON_SCHEMA.md](JSON_SCHEMA.md)。

## 关于 API

- 这是 **API-first** 工具，不含模型下载和本地推理引擎。
- API Key 仅读取自环境变量或本机 `.env`；`.env` 已被 Git 忽略，绝不要提交、截图或发给别人。
- 每次转写会使用你的 Key 调用所选供应商；文件大小、数据保留与账户政策请分别查看 [Qwen ASR 文档](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference) 或 [Soniox 文档](https://soniox.com/docs)。
- Qwen 使用 `qwen3-asr-flash-filetrans`，支持北京与新加坡地域；Soniox 使用异步文件转写 API，并可选说话人分离。配置项说明都在 `.env.example`。

### 费用

- 本项目本身是开源项目，可免费使用；默认供应商仍是阿里云 Qwen，也可以在 GUI 或命令行里改用 Soniox。
- 阿里云 Qwen ASR 注册后免费赠送 10 小时转录时间，超出额度后按 `0.792 元/小时` 计费，详见 [价格文档](https://help.aliyun.com/zh/model-studio/model-pricing#dbf1305ef4a69)。
- Soniox 异步文件转写约 `$0.10/小时`，适合需要说话人分离、多语言或小语种的素材，详见 [Soniox Pricing](https://soniox.com/pricing)。
- 如果你有不错的配置，也可以自己本地部署开源的 [QwenASR](https://github.com/QwenLM/Qwen3-ASR) 本地转录，不产生云端费用，只需要一点电费。

😭*我说我只有一台 AMD 显卡的台式机和一台 Mac Mini 所以跑不了本地模型有懂的吗*  

## 项目边界

本仓库刻意不包含：本地模型与 GPU 依赖、除 Qwen 与 Soniox 之外的 ASR 引擎、模型对比工具、剪辑软件脚本、样例媒体、缓存、个人表情包和任何密钥。

如果你准备修改或维护它，请先读 [AGENTS.md](AGENTS.md)。第三方组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

❤️ 感谢 @Hanekit 老师的宝贵意见和建议  
❤️ 感谢 @大狗 老师的超绝可爱表情包支持  
❤️ 感谢 @LiRenTech 的 [gap-gone](https://github.com/LiRenTech/gap-gone) 项目  
<sup>本项目的多行波形和空隙去除灵感皆来源于此</sup>  
🤖 感谢 ChatGPT 和 OpenCode 的代码助力（咦）  
<sup>主要由 gpt-5.6、KimiK3 和 glm-5.2 协作生产</sup>

## 许可证

本项目采用 [AGPL-3.0-only](LICENSE)。若你修改后把它作为网络服务提供给用户，AGPL 通常要求向这些用户提供对应的修改后源码；发布前请自行确认你的合规义务。

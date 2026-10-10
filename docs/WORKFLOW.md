# 从零完成一次字幕工程

这份指南只讲一次完整操作：安装 → 配置 → 转写 → 编辑 → 交付。高级设置见 [Launcher 指南](LAUNCHER_GUIDE.md)，完整参数见 [CLI](CLI.md)。

![从选择媒体、ASR 转写到保存 MOSP 工程和导出字幕的五步流程](assets/guides/workflow.svg)

*流程示意：校对后先保存工程，再导出字幕；后续修改继续从工程开始。*

如果使用 GitHub Releases 提供的 Windows 或 macOS 图形版，Python、uv、FFmpeg 与 ffprobe 已由默认 `MAW` 包打包，不需要单独安装；体积更小的 `MAW-lite` 包不包含 FFmpeg，需要系统已安装并可在 PATH 中找到 `ffmpeg` 和 `ffprobe`。Windows 解压后双击 `MAW.exe`；macOS 解压后打开 `MAW.app` 或 `MAW-lite.app`。Windows x64 的官方 MOSE 套件与 Installer 随 GitHub Release 公开发布；源码和打包脚本也公开，具备条件的用户可以自行构建。

MOSE 与 MAW 共用 `server-editor/serve.py` 和 `.mosp` 工程契约。套件目录必须保持
`MAW\MAW.exe` 与 `MAW\MOSE\MOSE.exe` 的相对关系，MOSE 不能从套件中单独拷出运行；
`.mosp` 关联会先调用 `MAW.exe --open-project`，让 Launcher 完成更新检查后再打开
MOSE；只在当前用户范围注册，不会关联旧的 `.json` 或覆盖 Windows 的 `UserChoice`。

官方 Windows Installer 按当前用户安装到 `%LOCALAPPDATA%\Programs\MAW`，不需要管理员权限。安装版 Launcher 默认开启软件更新检查，每 24 小时最多请求一次；「配置 → 软件更新」中的手动检查会立即请求并继续使用 ETag 缓存。更新说明会在设置页安全渲染常见 Markdown；更新器会从公开 GitHub Release 下载并校验新版 Installer，若当前构建没有匹配资产（例如本地或预览构建）则打开发布页供手动更新。更新状态、下载包和失败记录保存在 `%LOCALAPPDATA%\MAW\updates`，`.env`、日志和模型缓存不会因升级或卸载删除。

## 1. 安装并启动

### 使用图形包

从 [Releases](https://github.com/Moyf/moys-asr-workflow/releases/latest) 下载对应系统和架构的附件，解压完整目录后启动 `MAW.exe`（Windows）或 `MAW.app`（macOS）。具体可用平台以该版本附件为准。

- 完整版 `MAW` 包含 Python 运行时及 FFmpeg / FFprobe，无需另外安装。
- `MAW-lite` 不含 FFmpeg / FFprobe，需要系统提供这两个工具。
- 不要只复制可执行文件；保留随包文件和运行时目录。

Launcher 是转写与工具箱入口；MAWE 是编辑器。本分支 Launcher 优先打开 MOSE，缺失时回退到浏览器 Server。Windows MAW + MOSE 套件共用后端；macOS/Linux 配置独立 MOSE 包。安装方式、平台验收与更新范围见 [MOSE](MOSE.md)。

Windows Installer 按当前用户安装到 `%LOCALAPPDATA%/Programs/MAW`，通过 Launcher 检查、下载并校验新 Installer。便携版及 macOS/Linux 独立 MOSE 当前手动下载更新；具体可用包仍以 Release 附件为准。

### 从源码运行

需要 Python 3.11+、[uv](https://docs.astral.sh/uv/) 和 FFmpeg / FFprobe。在仓库根目录执行：

```sh
python --version
uv --version
ffmpeg -version
ffprobe -version
uv sync
uv run --no-sync python maw_gui.py
```

环境安装完成后，后续命令使用 `--no-sync`，避免每次启动重新同步依赖。普通源码安装不包含本地 ASR 与 OCR 的可选依赖。开发检查见 [DEVELOPMENT](DEVELOPMENT.md)。

## 2. 配置转写方式

在 Launcher 选择供应商与模型，填入自己的 API Key。默认云端模型为 `qwen-audio-3.0-asr-flash-filetrans`；Fun-ASR 与 Qwen 模型共用百炼 Key。其他云端服务以及实验本地模型分别见 [服务商配置](PROVIDERS.md) 和 [本地 ASR](LOCAL_ASR.md)。

点击保存配置会写入本机 `.env`。源码 CLI 可在仓库根目录复制 `.env.example` 为 `.env`，只填写需要的服务；环境变量优先于文件。不要把密钥放入命令行或工程。

Qwen 北京地域默认可直接使用；新加坡需要同时配置地域和 Workspace ID。Key、地域与业务空间须匹配。

## 3. 转写并检查产物

选择音频或视频，确认输出目录。多音轨视频还需确认「声音轨道」。首次配置可将快速测试时长设为 `2m`，点击生成后检查日志和实际字幕；处理完整素材前清除时长限制。

也可以使用公开 CLI。以下路径以 Windows PowerShell 为例，含空格时必须加引号：

```powershell
.\MAW.exe -i "D:\Videos\example.mp4" -o "D:\Output\example.srt" -ll 2m
```

源码中相同入口为：

```sh
uv run --no-sync python maw_gui.py -i "example.mp4" -o "example.srt" -ll 2m
```

公开 CLI 默认同时生成 SRT 与同名 `.mosp`，不生成 HTML。Launcher 默认把产物放入媒体旁的 `_maw`；目录和命名规则见 [Launcher 指南](LAUNCHER_GUIDE.md)。

| 文件 | 用途 |
| --- | --- |
| `.mosp` | 继续编辑的工程，包含字幕、可用的字词时间码与工程设置；必须保留。 |
| `.srt` | 通用字幕交付，可从工程重新导出。 |
| `.json` | 兼容旧工程；内容格式与 `.mosp` 相同，已有文件无需迁移。 |
| `.mopeaks` / `.quapeaks` | 可重建波形缓存，不能代替工程。 |
| `.edit.html` | 可选便携编辑页面，可从工程重新生成。 |

进程退出码为 `0` 且预期文件存在才表示成功。识别为空、上传失败或配置错误时查看具体日志；排错见 [FAQ](FAQ.md)。

## 4. 打开工程并编辑

MOSE 可原生选择或拖入 `.mosp` / `.json`，自动绑定磁盘文件并记录最近工程；媒体已移动时仍可打开字幕，通过“加载媒体”重新定位。Windows `.mosp` 关联经过 Launcher 更新检查；macOS/Linux 打开方式配置见 [MOSE](MOSE.md)。

在 Launcher 点击打开编辑器。源码可以直接启动：

```sh
uv run --no-sync python server-editor/serve.py "example.mosp"
```

Server 只监听 `127.0.0.1`，会根据工程的 `media` 引用加载媒体，并显示工程、媒体和波形准备进度。媒体已移动时，用 `-m` 指定新位置：

```sh
uv run --no-sync python server-editor/serve.py "example.mosp" -m "moved-video.mp4"
```

没有现成工程，也可先打开空白编辑器，再新建工程或拖入媒体、SRT：

```sh
uv run --no-sync python server-editor/serve.py --blank
```

检查文字、起止时间和较长字幕。双击文本修改，拖动波形块或边缘调整时间；拆分、合并、多重字幕与空隙操作见 [编辑器指南](EDITOR_GUIDE.md)。保存时用 `Ctrl+S`，macOS 用 `Cmd+S`。

「工程设置」集中时间单位 / FPS、语言、双语与重叠、ASS 模式与字幕样式、说话人和工程表情包目录；这些属性随工程保存。「全局设置」管理本机操作偏好，功能区页可打开局部面板并保留全局窗口。跳过静音空隙位于「播放预览 → 播放与定位」，默认表情包目录可在全局表情包页直接配置，工程覆盖目录优先。

需要核对细粒度时间时，在波形区 ⚙️ 设置中开启「字词时间码」：查看并在句内调整已有字词块。一个块可包含多个共享范围的字词，新增文字不代表重新对齐音频；没有时间码的位置不会自动补建。

需要便携 HTML 时可从已有工程生成（媒体仍需单独携带）：

```sh
uv run --no-sync python edit.py "example.mosp" -m "example.mp4"
```

## 5. 保存与交付

先保存工程，再导出交付文件：普通字幕用 SRT，需要样式用 ASS。ASS 的样式和预览见 [ASS 样式](ASS_STYLES.md)；去空隙素材、OTIO 与 FFconcat 的配套导出见 [编辑器指南](EDITOR_GUIDE.md)。

保留原媒体和工程，波形缓存可按需重建。浏览器新建、Server 接管和下载式保存的区别，以及版本备份恢复步骤，也在编辑器指南中说明。

MOSE 新建与另存为使用原生对话框，可保存到其他目录；保存后继续绑定新目标。取消对话框不会丢失编辑，跨目录另存为也会保留媒体原来的位置。

## 下一步

- 多文件处理、识别预设和输出设置：[Launcher 指南](LAUNCHER_GUIDE.md)。
- 文稿匹配、翻译、烧录字幕或提取音频：[工具箱](TOOLBOX.md)。
- 转写后自动执行处理链：[转写后自动处理](POSTPROCESS_PIPELINE.md)。
- 写批处理或让自动化工具调用：[CLI](CLI.md)。
- 启动、API、媒体和保存问题：[FAQ](FAQ.md)。

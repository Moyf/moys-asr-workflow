# 常见问题

## Windows 安装版如何更新？

Windows x64 推荐使用 `MAW-Setup-Windows-x64-v*.exe`。安装版在 Launcher 的「配置 → 软件更新」中每天自动检查一次，也可以手动检查；下载完成后会校验官方 Release 的更新清单和 SHA-256，并在确认后关闭、覆盖安装并重启。更新不会删除 `%LOCALAPPDATA%\MAW` 下的 `.env`、日志、模型缓存或更新状态。

首个带更新器的版本只能负责后续版本；更旧、尚未包含更新器的 MAW 不会自动升级，仍需先手动安装这个 Installer。

便携 ZIP、macOS 和 Linux 只能打开精确版本的 GitHub Release 页面手动下载。若希望以后使用一键更新，可安装同一 Release 的 Windows Installer；便携版已有的用户数据仍保留在 `%LOCALAPPDATA%\MAW`。

## 更新失败或没有自动更新按钮

网络离线、GitHub 限流、Release 缺少 `update-manifest.json`、当前平台没有对应资产，都会保留当前版本并提供发布页入口。安装版还需要安装目录可写、剩余磁盘空间至少为更新包大小的三倍；转写、批处理、模型/OCR Runtime 安装和自动后处理运行时必须先完成。更新下载取消后，残留的 `.part` 文件会自动清理，可重新检查并下载。

Launcher 中的更新说明会把常见 Markdown（标题、列表、粗体、代码和链接）渲染成安全的富文本；Release 原始 HTML 不会直接注入窗口，完整说明可通过「打开发布页」查看。

Installer 当前未配置 Windows 代码签名证书，首次运行可能出现 SmartScreen 警告。请核对文件来自本项目 GitHub Release；不要从第三方镜像运行未知安装包。

## Windows 下载后启动时报 `Python.Runtime.Loader.Initialize` 错误

如果从 GitHub 下载 `MAW` 压缩包、解压后启动失败，并在错误信息中看到 `Python.Runtime.dll` 或 `Python.Runtime.Loader.Initialize`，通常是 Windows 给“来自 Internet 的文件”添加的安全标记，导致运行时 DLL 被阻止加载。这个问题的实际案例见 [Issue #40](https://github.com/Moyf/moys-asr-workflow/issues/40)。

请按下面步骤处理：

1. 找到最初下载的 `MAW-*.zip`，右键打开“属性”。
2. 在“常规”页勾选“解除锁定”（英文 Windows 为 `Unblock`），点击“应用”。
3. 删除或移走旧的解压目录，再从已经解除锁定的 ZIP 重新解压到新目录。
4. 不要只复制 `MAW.exe`；必须保留完整的 `MAW` 目录及其中的运行时文件，然后从这个完整目录启动程序。

如果属性窗口中没有“解除锁定”，可以尝试重新下载压缩包，或使用 Bandizip 等可靠的解压软件重新解压；仍然建议先对原始 ZIP 执行“解除锁定”。不要只复制 `MAW.exe`，也不要在旧的解压目录上覆盖文件。

如果解除锁定并重新解压后仍然报错，不要先把现代 .NET Runtime 8/9 当作替代品安装。Python.NET 使用的是 Windows .NET Framework；只有当错误明确指向 Framework 版本且系统版本过旧时，才检查是否已安装 .NET Framework 4.8。

## 转写时提示“找不到文件”或 `[WinError 2] 系统找不到指定的文件`

看到“找不到 FFmpeg，请下载完整版 MAW”时，请下载带内置 FFmpeg 的完整版 `MAW` 包；这个提示通常表示使用了不包含 FFmpeg/FFprobe 的 `MAW-lite`。

如果日志停在“正在读取原始视频时长”，并且你下载的是 `MAW-lite`，通常是 Lite 包不包含 FFmpeg 和 FFprobe。请下载带内置 FFmpeg 的完整版 `MAW` 包，不要下载文件名带 `lite` 的版本。

如果必须继续使用 `MAW-lite`，请自行安装 FFmpeg，并确保 `ffmpeg` 与 `ffprobe` 都已加入 PATH，然后重新打开 MAW。完整包与 Lite 包的差异也见 [工作流说明](WORKFLOW.md#找不到-ffmpeg-或-ffprobe)。

## 如何反馈问题

如果常见问题没有解决你的情况，请在 GitHub 提交 [Issue](https://github.com/Moyf/moys-asr-workflow/issues/new)，方便我们继续排查。

反馈时请尽量提供：

- MAW 版本号，以及下载的包名（例如 `MAW-Windows-x64-...zip`）。
- 操作系统和架构，例如 Windows 11 x64。
- 从启动到报错的具体操作步骤。
- 完整的错误信息、终端输出或截图。
- 是否已经尝试解除 ZIP 锁定并重新解压。
- 是否使用过 Bandizip 等其他解压软件重新解压完整 ZIP。

请先删除 API Key、访问令牌、原始媒体和其他隐私内容；本地路径也可以脱敏后再提交。

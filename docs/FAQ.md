# 常见问题

安装与第一次转写见 [工作流](WORKFLOW.md)，配置字段见 [服务商配置](PROVIDERS.md)。

## Windows 安装版如何更新？

Windows Installer 在 Launcher 的“配置 → 软件更新”中每天最多检查一次，也可手动检查。下载后校验 Release 更新清单与 SHA-256，再确认安装；更新保留用户数据中的配置、日志、模型缓存和更新状态。旧版未包含更新器时需先手动安装带更新器的版本。

网络离线、限流或缺少匹配资产时保留当前版本，并提供发布页入口。转写、批处理与运行环境安装等任务需先完成再安装更新。便携版及 macOS/Linux MOSE 独立包当前手动更新，具体见 [MOSE](MOSE.md)。

便携 ZIP、macOS 和 Linux 只能打开精确版本的 GitHub Release 页面手动下载。若希望以后使用一键更新，可通过维护者提供的独立官方 Installer 下载链接安装对应版本；便携版已有的用户数据仍保留在 `%LOCALAPPDATA%\MAW`。

## 更新失败或没有自动更新按钮

网络离线、GitHub 限流、Release 缺少 `update-manifest.json`、当前平台没有对应资产，都会保留当前版本并提供发布页入口。安装版还需要安装目录可写、剩余磁盘空间至少为更新包大小的三倍；转写、批处理、模型/OCR Runtime 安装和自动后处理运行时必须先完成。更新下载取消后，残留的 `.part` 文件会自动清理，可重新检查并下载。

Launcher 中的更新说明会把常见 Markdown（标题、列表、粗体、代码和链接）渲染成安全的富文本；Release 原始 HTML 不会直接注入窗口，完整说明可通过「打开发布页」查看。

Installer 当前未配置 Windows 代码签名证书，首次运行可能出现 SmartScreen 警告。请核对文件来自维护者提供的官方 Installer 下载链接，并比对发布者给出的 SHA-256；不要从第三方镜像运行未知安装包。

## Windows 启动时报 Python.Runtime 错误

`Python.Runtime.dll` 或 `Python.Runtime.Loader.Initialize` 可能由下载文件的安全标记阻止 DLL 加载，实例见 [Issue #40](https://github.com/Moyf/moys-asr-workflow/issues/40)。

1. 在原始 ZIP 的属性中选择「解除锁定 / Unblock」。
2. 将旧解压目录移走，再把已解除锁定的 ZIP 解压到新目录。
3. 保留完整目录，从其中启动 `MAW.exe`，不要只复制可执行文件。

没有解除锁定选项时，可重新下载或换可靠解压软件。只有错误明确指向旧系统的 .NET Framework 时才检查 Framework 4.8，现代 .NET Runtime 不能直接替代它。

## 找不到 FFmpeg / FFprobe，或报 WinError 2

完整版 MAW 包含二者；Lite 包需要系统安装。确认两个命令都有版本输出，重新打开应用或终端，让 PATH 更新生效。

macOS 从 Finder 启动不一定继承终端 PATH。程序会尝试 Homebrew 路径；仍失败时，在 Launcher 配置 FFmpeg 路径，并确认对应 FFprobe 也存在。烧录 ASS 需要支持 libass 的构建，程序会优先尝试 Homebrew `ffmpeg-full`；显式 `FFMPEG_PATH` 优先。

## Key 已填写但提示未配置

确认保存到了当前入口读取的 `.env`：源码在仓库根目录，打包版优先应用程序同目录，再回退用户数据目录。不是 `.env.example`，也没有被同名环境变量覆盖。不要为排错打印完整 Key。

## Qwen / Fun-ASR 返回 403，或任务上传失败

核对 Key、地域、Workspace ID 与模型权限；新加坡需要 Workspace ID。日志会显示业务 code、message 和 request_id：

| 错误 | 核对项 |
| --- | --- |
| `AllocationQuota.FreeTierOnly` | 账户是否限制仅使用免费额度，额度是否已用完。 |
| `AccessDenied` / API-Key restrictions | Key 的模型权限、IP 白名单及业务空间授权。 |
| `Workspace.AccessDenied` / `WorkSpaceNotFound` | Key、地域和 Workspace ID 是否属于同一空间。 |

超时先检查网络与服务状态；百炼可调整 `DASHSCOPE_POLL_TIMEOUT`，不要无限重试同一个权限错误。数据保留、额度和文件限制以服务控制台为准。

## OpenAI 兼容服务只返回文字或报 400

MAW 需要 `segments` / `words` 时间戳，纯 `{ "text": "..." }` 不足以生成可靠字幕。检查接口支持的 response_format、模型 ID 与增强参数。OpenRouter 的公开 CLI 模型名必须填完整前缀；其他服务使用其实际模型 ID。

`MAW.exe` 不接受底层 OpenAI 脚本的 `--prompt`、`--keyword`、`--diarize`。参数边界见 [CLI](CLI.md)。

## 工程打开了，媒体却没有加载

工程的媒体引用可能失效。通过 Launcher 重新选择，或源码启动时用 `-m` 覆盖。直接拖入工程不一定能让 Server 接管；没有写入绑定时需导出工程保存。条件见 [Server README](../server-editor/README.md)。

MOSE 原生打开或拖入工程可以取得真实路径，媒体失效仍保留工程绑定与最近记录；点击“加载媒体”重新定位。损坏媒体加载失败会保留原工程。

便携 HTML 的 file:// 媒体权限与 Seek 兼容性有限，日常优先使用 Server。不要用普通 `python -m http.server` 替代专用媒体 Range 服务。

## 字幕不在媒体旁，或缓存重新生成

Launcher 默认输出到 `_maw`；每视频子文件夹和模型名开关另行设置。波形缓存不是工程真源，可以重建；旧 `*.waveform.json` 已不再读取。规则见 [Launcher 指南](LAUNCHER_GUIDE.md)。

## 如何保存或恢复修改

先确认当前工程是 Server 绑定、浏览器文件句柄还是下载式导入。Server 另存为只允许当前目录内文件名；服务退出时仍可从页面导出工程。备份副本需复制到原目录并恢复工程扩展名，见 [编辑器指南](EDITOR_GUIDE.md#5-保存另存为与备份)。

MOSE 原生另存为可跨目录，后续保存绑定新文件。未命名工程首次保存会选择文件位置；取消时保留当前编辑。关闭/退出时也可取消返回继续保存。

## 如何反馈问题

提交 [GitHub Issue](https://github.com/Moyf/moys-asr-workflow/issues/new)，提供版本、包名、系统与架构、具体步骤、完整错误及已尝试的方法。先移除 API Key、令牌、私人媒体与识别内容，本地路径可脱敏。

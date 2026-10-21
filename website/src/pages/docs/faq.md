---
layout: "../../layouts/DocLayout.astro"
title: "常见问题"
description: "启动、FFmpeg、API、媒体加载与保存排错。"
source: "docs/user/FAQ.md"
---

<!-- Generated from docs/user/FAQ.md. Run pnpm run sync:docs to refresh. -->

安装与第一次转写见 [工作流](../workflow/)，配置字段见 [服务商配置](../providers/)。

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

`MAW.exe` 不接受底层 OpenAI 脚本的 `--prompt`、`--keyword`、`--diarize`。参数边界见 [CLI](../cli/)。

## 转写没有结果，或录屏选错音轨

先播放实际选择的音轨，确认处理范围内能听到人声。OBS 等录屏文件可能把麦克风与游戏/系统声音录在不同音轨中；在 Launcher「音轨」中逐条选择并复听，选到含人声的那条后再试。开启快速测试时，也要确认开头的测试范围内有人说话。

Launcher 在 ASR 明确返回空结果，或输出工程没有任何有效字幕文本时，提示「未能转写出任何有效文本」。若已有文件信息表明包含多条音轨，会额外提醒「请检查选中的音轨是否有效」，并提供「检查音轨」入口。音轨信息不可用时保留通用提示。

如果已有探测成功确认视频不带音轨，Launcher 会明确提示「此媒体没有检测到音轨」，阻止开始转写。探测失败、结果损坏或尚未完成时仍视为未知，不当作无音轨，也不额外发起检查。批量任务复用默认选轨时的探测，已确认无音轨的条目不会启动转写，其他有效条目可继续。

单文件通过文件选择器或拖放选定视频后立即发起音轨探测，手动输入路径时延迟约 280 毫秒启动；点击开始只读取已有结果，不等待探测。提前开始且随后 FFmpeg 提取所选音轨失败时，会提示视频可能没有音轨、选中的轨道不存在或媒体无法解码，引导检查文件与音轨；不把未知状态断言成无音轨。该提示只读取最终错误，不新增探测或等待。

空结果后不再额外解码音频或执行静音检查。提示依据识别结果与已有音轨信息，不判断整轨是否无声、是否选错轨，也不能区分游戏声、音乐或噪音。请复听本次处理范围，并检查语言和模型设置；程序不会自动换轨或额外发起一次转写。批量任务各自使用音轨信息，空结果条目记为失败并继续其他条目。

## 工程打开了，媒体却没有加载

工程的媒体引用可能失效。通过 Launcher 重新选择，或源码启动时用 `-m` 覆盖。直接拖入工程不一定能让 Server 接管；没有写入绑定时需导出工程保存。条件见 [Server README](https://github.com/Moyf/moys-asr-workflow/blob/main/server-editor/README.md)。

1.x 历史便携 HTML 的 file:// 媒体权限与 Seek 兼容性有限。2.0 起停止生成与维护独立 HTML / 在线编辑器，日常使用本地应用或 Server；旧 HTML 不承诺兼容新版工程。不要用普通 `python -m http.server` 替代专用媒体 Range 服务。

## 字幕不在媒体旁，或缓存重新生成

Launcher 默认输出到 `_maw`；每视频子文件夹和模型名开关另行设置。波形缓存不是工程真源，可以重建；旧 `*.waveform.json` 已不再读取。规则见 [Launcher 指南](../launcher/)。

## 如何保存或恢复修改

先确认当前工程是 Server 绑定、浏览器文件句柄还是下载式导入。Server 另存为只允许当前目录内文件名；服务退出时仍可从页面导出工程。备份副本需复制到原目录并恢复工程扩展名，见 [编辑器指南](../editor-guide/#5-保存另存为与备份)。

## 如何反馈问题

提交 [GitHub Issue](https://github.com/Moyf/moys-asr-workflow/issues/new)，提供版本、包名、系统与架构、具体步骤、完整错误及已尝试的方法。先移除 API Key、令牌、私人媒体与识别内容，本地路径可脱敏。

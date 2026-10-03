---
layout: "../../layouts/DocLayout.astro"
title: "常见问题"
description: "启动、FFmpeg、API、媒体加载与保存排错。"
source: "docs/FAQ.md"
---

<!-- Generated from docs/FAQ.md. Run npm run sync:docs to refresh. -->

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

## 工程打开了，媒体却没有加载

工程的媒体引用可能失效。通过 Launcher 重新选择，或源码启动时用 `-m` 覆盖。直接拖入工程不一定能让 Server 接管；没有写入绑定时需导出工程保存。条件见 [Server README](https://github.com/Moyf/moys-asr-workflow/blob/main/server-editor/README.md)。

便携 HTML 的 file:// 媒体权限与 Seek 兼容性有限，日常优先使用 Server。不要用普通 `python -m http.server` 替代专用媒体 Range 服务。

## 字幕不在媒体旁，或缓存重新生成

Launcher 默认输出到 `_maw`；每视频子文件夹和模型名开关另行设置。波形缓存不是工程真源，可以重建；旧 `*.waveform.json` 已不再读取。规则见 [Launcher 指南](../launcher/)。

## 如何保存或恢复修改

先确认当前工程是 Server 绑定、浏览器文件句柄还是下载式导入。Server 另存为只允许当前目录内文件名；服务退出时仍可从页面导出工程。备份副本需复制到原目录并恢复工程扩展名，见 [编辑器指南](../editor-guide/#5-保存另存为与备份)。

## 如何反馈问题

提交 [GitHub Issue](https://github.com/Moyf/moys-asr-workflow/issues/new)，提供版本、包名、系统与架构、具体步骤、完整错误及已尝试的方法。先移除 API Key、令牌、私人媒体与识别内容，本地路径可脱敏。

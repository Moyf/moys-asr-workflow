# 烧录失败提示提交前审查

目标分支为 `main`，基线为 `37c11d1c`。用户反馈中的整片烧录先在 NVENC 写 MP4 时耗尽临时盘空间，随后尝试 AMF、QSV，最后由 CPU 从头完成。回归夹具只保留必要的 FFmpeg 错误摘要。

## 独立审查与处置

1. **可恢复的解码警告（P2，已修复）**。审查者用 FFmpeg 解码夹有损坏帧的 MJPEG，观察到 `Invalid data found when processing input` 与退出码 0 同时出现。收紧 [FFmpeg 分类](../../../../maw/burn_diagnostics.py) 后，只将明确的输入打开失败或容器解析错误转成媒体提示，普通解码警告仍可与硬件回退共存。Editor 回退测试包含坏帧告警与 NVENC 启动失败。
2. **清理异常覆盖烧录首因（P2，已修复）**。审查者在半成品存在时让 `Path.unlink` 抛出 `PermissionError`，复现首次磁盘满被覆盖。运行中的 Editor 烧录任务由任务管理器负责清理，烧录失败和清理失败独立记录。回归测试拒绝直接删除半成品，并断言首因仍是 `disk-full`、仅尝试 NVENC、任务目录已清理。
3. **Launcher 准备字幕时的空间不足（P3，已修复）**。审查者让 `mkstemp` 抛出 `ENOSPC`，观察到包装后的 `MediaToolError` 仍带原始路径。Launcher 烧录现在检查异常原因链的操作系统错误，测试确认用户提示会指出空间不足并省略输入路径。

## 验证边界

- 对照旧逻辑，Editor 的回归记录了两轮编码，Launcher 的三种文件错误仍走自动回退，编辑器的 Node 用例也未观察到新提示。
- 实际 Chromium 经本地任务接口操作烧录入口，验证临时盘满和保存盘满的提示。错误由测试接口与写入夹具注入。
- 一轮 Chromium 复测发现浏览器的 `DOMException.code` 数字盖过了 `QuotaExceededError` 的识别。调整错误码优先级后，Node 写入回归也改用真实的 `DOMException`。
- Windows 打包环境、真实硬件编码器与真实磁盘耗尽未复现。

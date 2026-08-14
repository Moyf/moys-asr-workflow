# 常见问题

## Windows 下载后启动时报 `Python.Runtime.Loader.Initialize` 错误

如果从 GitHub 下载 `MAWxFF` 压缩包、解压后启动失败，并在错误信息中看到 `Python.Runtime.dll` 或 `Python.Runtime.Loader.Initialize`，通常是 Windows 给“来自 Internet 的文件”添加的安全标记，导致运行时 DLL 被阻止加载。这个问题的实际案例见 [Issue #40](https://github.com/Moyf/moys-asr-workflow/issues/40)。

请按下面步骤处理：

1. 找到最初下载的 `MAWxFF-*.zip`，右键打开“属性”。
2. 在“常规”页勾选“解除锁定”（英文 Windows 为 `Unblock`），点击“应用”。
3. 删除或移走旧的解压目录，再从已经解除锁定的 ZIP 重新解压到新目录。
4. 不要只复制 `MAW.exe`；必须保留完整的 `MAWxFF` 目录及其中的运行时文件，然后从这个完整目录启动程序。

如果属性窗口中没有“解除锁定”，可以尝试重新下载压缩包，或把文件移到本机磁盘后再解压。仍然无法启动时，请按下面的方式反馈，并附上完整错误信息。

## 如何反馈问题

如果常见问题没有解决你的情况，请在 GitHub 提交 [Issue](https://github.com/Moyf/moys-asr-workflow/issues/new)，方便我们继续排查。

反馈时请尽量提供：

- MAW 版本号，以及下载的包名（例如 `MAWxFF-Windows-x64-...zip`）。
- 操作系统和架构，例如 Windows 11 x64。
- 从启动到报错的具体操作步骤。
- 完整的错误信息、终端输出或截图。
- 是否已经尝试解除 ZIP 锁定并重新解压。

请先删除 API Key、访问令牌、原始媒体和其他隐私内容；本地路径也可以脱敏后再提交。

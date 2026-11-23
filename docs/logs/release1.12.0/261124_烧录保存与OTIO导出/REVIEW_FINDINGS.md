# 烧录保存与 OTIO 导出独立审查

目标基线为 `origin/main` 的 `37c11d1c`。由未参与实现的子代理通读产品代码和测试差异，核对 macOS 面板线程、Launcher 子进程验证与退出、Windows 端口保护、浏览器下载、提示降级和回归覆盖。

## 发现与处置

| 级别 | 发现 | 证据与处置 |
| --- | --- | --- |
| Major | 在等待时间线写入时更改当前工程，配套 SRT 会读取更新内容并使用原导出名。 | `web/editor/io/editor-wiring-export-actions.js` 的 `downloadTimelineWithSrt` 在首个异步保存前取得配套字幕。审查用 Node `vm` 挂起保存并切换工程，先得到 `A.otio` 与含 B 字幕的 `A.srt`。Chromium 用例暂停 OTIO 写入并修改字幕，修复前因输出含修改后文本而失败，修复后断言仍为导出时的 `Alpha`。 |
| Major | WebKit 无原生保存选择器时，同步发起 OTIOZ 和配套 SRT 只收到 SRT。 | 独立审查使用真实 Server Editor、WebKit 和普通 OTIOZ 菜单，下载事件只有 `project.srt`，页面已报告完成打包。普通与去空隙的 OTIO 及 OTIOZ 现共用独立下载帧的配套 SRT 路径。`tests/e2e/otio-export.spec.mjs` 验证两份文件，以及 OTIO 内容和 OTIOZ 内的 `content.otio` 条目。 |

## 核验结果

- 最终独立复核重跑了 A 切换到 B 的时序探针及取消路径，SRT 保留工程 A 的内容。无未处置 blocker 或 major。
- 审查者独立运行 9 项 Python 用例，覆盖原生烧录宿主、Launcher 状态识别和端口选择，全部通过。Cocoa 面板与父窗操作均在主线程，编辑器在开始服务前配置身份校验，Windows 排他绑定探测继续保留。
- 旧版验证中，WebKit 未开启配套字幕时能下载 OTIO，开启后只收到 SRT。旧版取消 OTIO 保存仍发起 SRT。修复后 WebKit 14 项复测通过。
- Debian ARM64 上复现了服务误报断线和 `TIME_WAIT` 被误判为端口占用。修复后运行 32 项定向测试，并另行使用真实 Launcher 子进程验证了同端口重启。macOS 维护者实测已选址并完成烧录。
- macOS 覆盖确认已跑自动化，原生覆盖确认面板未单独实测。Linux Qt 原生保存面板因容器依赖未装完未实测。Windows 实机、发布包和 Safari 应用未测，下载回归使用 Playwright WebKit。

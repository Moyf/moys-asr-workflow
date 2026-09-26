# MAWE 状态与命令重构进度

2026-09-26，基线 main `d20529c`，分支 `codex/editor-state-commands`。
维护者要求完成剩余编辑器重构并提交一个整体 PR；Electron 暂缓，由另一条分支负责。
工作区原有未跟踪 `.DS_Store` 保留；不更新根 `blank-editor.html`。

| 项目 | 状态 | 处理与验证 |
| --- | --- | --- |
| starlit-main 现状核对 | 已修复 | 实际远端为 merge/starlit-main，11b7ed2；已有 Electron main / preload、同套件后端管理、Windows 打包与测试。与当前 main 分叉：本线独有 92 提交、该线独有 22；尚未包含 #136 / #154 / #155 的前端目录和模块拆分。只读核对，不修改该分支 |
| 浏览器基线与稳定性 | 已修复 | main 实测 399 项：380 通过 / 19 失败；固定 Control 的测试改用 Playwright ControlOrMeta，文案断言兼容 Cmd；修复 macOS 帮助标签先应用 Cmd 后漏翻译。旧失败所在六份 spec 专项 187 / 187 通过；完整最终回归留到收尾 |
| 状态所有者与选择入口 | 进行中 | 区分工程 / 选择 / 偏好 / 运行态；segments 保持唯一字幕真源 |
| 命令 / dirty / 历史事务 | 待处理 | 迁移编辑、拆分、合并、删除和时间修改；文本原生撤销与工程历史分开，拖动预览不重复入栈 |
| 视图通知与依赖收敛 | 待处理 | 命令明确刷新范围，迁移业务间裸引用；保留尚有消费者的兼容 API |
| 验证 / 文档 / PR | 待处理 | Node、Python、类型、浏览器、临时便携产物和 CI 分层记录，提交整体 PR |
| Electron / Tauri | 仅说明 | 用户明确暂缓 Electron，另一分支处理；不实现或编译桌面壳 |

## 当前事实与边界

starlit 分支实现通过 localhost Server 复用同一前端，preload 暴露 MOSEDesktop 的工程选择 / 状态能力；窗口启用 contextIsolation / sandbox 并关闭 nodeIntegration。未在本机编译或运行其桌面产物，不以源码审查冒充运行验证。未来集成需要先同步最新 main 的清单与目录，再接其工程打开消息和 Server 契约；本轮保持现有前端 / Server 契约。

本轮按表格顺序推进，一次处理一个当前问题，验收后及时更新本记录。

## 阶段一：基线治理

未改实现时完整 Chromium 399 项，380 通过 / 19 失败。基线还出现副字幕 B 拆分和最短时长拆分两个偶发用例，旧光标 / 列表定位偶发差分本次通过。专项修正后，multi-subtitle、onboarding、overlay-track、waveform-deletion、waveform-history、editor-i18n-save 共 187 项全部通过，无 skip / retry。

平台键修正由已安装 Playwright 的 ControlOrMeta 实现确认，测试没有强制伪装 Windows navigator；保留真实 macOS 路径。英文帮助为实际产品修复，追加 Cmd 标签翻译的单元覆盖；没有关闭失败用例或放宽核心编辑结果断言。

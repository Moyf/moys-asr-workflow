# MAWE 状态与命令重构进度

2026-09-26，基线 main `d20529c`，分支 `codex/editor-state-commands`。
维护者要求完成剩余编辑器重构并提交一个整体 PR；Electron 暂缓，由另一条分支负责。
工作区原有未跟踪 `.DS_Store` 保留；不更新根 `blank-editor.html`。

| 项目 | 状态 | 处理与验证 |
| --- | --- | --- |
| starlit-main 现状核对 | 已修复 | 实际远端为 merge/starlit-main，11b7ed2；已有 Electron main / preload、同套件后端管理、Windows 打包与测试。与当前 main 分叉：本线独有 92 提交、该线独有 22；尚未包含 #136 / #154 / #155 的前端目录和模块拆分。只读核对，不修改该分支 |
| 浏览器基线与稳定性 | 已修复 | main 实测 399 项：380 通过 / 19 失败；固定 Control 的测试改用 Playwright ControlOrMeta，文案断言兼容 Cmd；修复 macOS 帮助标签先应用 Cmd 后漏翻译。旧失败所在六份 spec 专项 187 / 187 通过；完整最终回归留到收尾 |
| 状态所有者与选择入口 | 已修复 | MaweState 持有原工程对象、只读选择视图 / 唯一写入入口、偏好、播放 / 面板 / 行内编辑运行态和 dirty 标记；旧门面转发同一状态。5 项状态单测、类型和装配检查通过 |
| 命令 / dirty / 历史事务 | 进行中 | 迁移编辑、拆分、合并、删除和时间修改；文本原生撤销与工程历史分开，拖动预览不重复入栈 |
| 视图通知与依赖收敛 | 待处理 | 命令明确刷新范围，迁移业务间裸引用；保留尚有消费者的兼容 API |
| 验证 / 文档 / PR | 待处理 | Node、Python、类型、浏览器、临时便携产物和 CI 分层记录，提交整体 PR |
| Electron / Tauri | 仅说明 | 用户明确暂缓 Electron，另一分支处理；不实现或编译桌面壳 |

## 当前事实与边界

starlit 分支实现通过 localhost Server 复用同一前端，preload 暴露 MOSEDesktop 的工程选择 / 状态能力；窗口启用 contextIsolation / sandbox 并关闭 nodeIntegration。未在本机编译或运行其桌面产物，不以源码审查冒充运行验证。未来集成需要先同步最新 main 的清单与目录，再接其工程打开消息和 Server 契约；本轮保持现有前端 / Server 契约。

本轮按表格顺序推进，一次处理一个当前问题，验收后及时更新本记录。

## 阶段一：基线治理

未改实现时完整 Chromium 399 项，380 通过 / 19 失败。基线还出现副字幕 B 拆分和最短时长拆分两个偶发用例，旧光标 / 列表定位偶发差分本次通过。专项修正后，multi-subtitle、onboarding、overlay-track、waveform-deletion、waveform-history、editor-i18n-save 共 187 项全部通过，无 skip / retry。

平台键修正由已安装 Playwright 的 ControlOrMeta 实现确认，测试没有强制伪装 Windows navigator；保留真实 macOS 路径。英文帮助为实际产品修复，追加 Cmd 标签翻译的单元覆盖；没有关闭失败用例或放宽核心编辑结果断言。

## 阶段二：状态所有权

MaweState 不复制工程对象，选择集合为只读实时视图；48 处选择写入转为 owner 方法，叠加轨的裸选择 / 锚点引用已移除。旧 MaweSelection / MaweCoreState / MaweCuePanelState / MaweInlineEdit 和 dirty 属性仅转发同一状态，保留现有消费者。设置读取填充同一偏好对象，不序列化播放器、DOM 或选择集到工程。

Node 379 项成功；新增状态单测随后扩至 5 项并全部通过；Python 页面 / 清单 30 项、类型、Ruff、语法和装配顺序检查通过。Python 首次指出清单固定契约遗漏新模块，已同步断言。

完整 Chromium 399 项首次 397 通过 / 2 失败：一个测试仍直接使用已移除的裸选择集；另一个换轨入口把只读集传给原地修改的旧 helper，未同步选中结果。前者迁移测试设置入口，后者迁移为 owner.removeAndShift，并补充非顺序选择的重映射覆盖。两项修正后叠加轨专项 24 项全部通过，完整回归在命令迁移后重跑。

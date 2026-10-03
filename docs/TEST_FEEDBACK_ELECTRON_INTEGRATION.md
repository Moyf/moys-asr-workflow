# Electron 桌面集成检查记录

日期：2026-10-04。范围来自维护者本轮请求：同步 main、检查 Windows/macOS/Linux 打包与工程关联，并完善真实路径、工程打开、最近工程、保存和相邻资源流程。参考笔记中的历史状态仅作线索；商业计划不属于本轮范围。

## 事实基线

- 初始工作区干净，HEAD 为 main 的 `d9f2e9be`，没有本地 `starlit-main`。
- 远端不存在同名 `starlit-main`；现有 Electron 集成分支是 `origin/merge/starlit-main`（`11b7ed21`），另有较早的 `origin/starlit`。
- 本地 `starlit-main` 跟踪 `origin/merge/starlit-main`。已 fetch 最新 main，合并前 main 独有 107 个提交，集成分支独有 22 个。
- 现有 `desktop/package.json` 仅配置 Windows x64；不能据此宣称三端可用。
- 旧反馈 `docs/TEST_FEEDBACK_STARLIT.md` 留有实际 Windows 启动、任务栏图标及 Python 依赖未验证项，本轮重新核对。

## 清单

| 编号 | 范围 | 处理项 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 分支集成 | 合入最新 main，解决旧单体前端与模块拆分、Launcher、Server 冲突 | 修改 | 已修复 |
| 2 | 工程打开 | 原生选择、文件关联、命令行、拖拽统一真实路径并更新最近工程 | 修改 | 进行中 |
| 3 | 工程保存 | 原生新建/另存为，持续保存绑定、相对媒体路径和取消恢复 | 修改 | 待处理 |
| 4 | 媒体与相邻资源 | 媒体/字幕拖拽、路径识别、重定位、sidecar、目录选择 | 修改 | 待处理 |
| 5 | 三端打包 | Windows/macOS/Linux 后端布局、Electron 产物、关联与工程图标 | 修改 | 待处理 |
| 6 | 桌面生命周期 | 安全 IPC、单实例、未保存确认、窗口标题、后端清理与平台菜单 | 修改 | 待处理 |
| 7 | 文档与变更说明 | 实际使用方式、平台矩阵、已知验证边界和 CHANGELOG | 修改 | 待处理 |
| 8 | 验证 | 单元/服务器/交互/本地打包检查，分别记录实测与未验证项 | 修改 | 待处理 |
| 9 | 浏览器本质限制 | Chromium 解码内存、新增 ASR/导出格式不由 Electron 自动解决 | 说明 | 仅说明 |

## 处理记录

### 1. 分支集成

- 解决 README、Launcher、Server、测试、新手引导与旧单体脚本冲突；弃用脚本移入回收站，打开工程逻辑迁移到 `editor-server-save.js` 与接线模块。
- 保留 main 的 ASS 样式接口、工程比较语义、模型与预设能力，保留集成分支的更新器与桌面工程切换保护；恢复 main 的断线重启不重复开页行为。
- Electron、Launcher、GUI 与 lockfile 版本统一为 `1.8.0-beta.1`。
- `blank-editor.html` 使用 main 已有产物，没有重新生成；内联副本待发布前统一重生成。
- 初次 Python 定向检查 463 项出现两处旧契约问题（已删除 `web/editor.js` 路径和硬编码旧版本）；修复后这两项重测通过。前端语法/工具/波形检查 368 通过、1 跳过；安装 acorn 后顺序检查另行通过，无跳过。桌面辅助测试 17/17。

### 2. 工程打开

- 现有原生对话框只覆盖按钮；拖拽和网页 input 仍走 Blob 流程，macOS 缺 `open-file` 事件、Linux 没有关联入口，继续完善。

## 验证账本

| 层级 | 命令或方法 | 实际结果 | 未验证边界 |
| --- | --- | --- | --- |
| Git | fetch、status、分支与提交对比，diff check | 初始无 WIP，冲突已解决，diff check 通过 | 后续实现尚未提交 |
| 语法/单元 | 四组 Node editor 检查、desktop tests、script order 补测 | 369 项全部覆盖（初次 1 跳过后补测通过）；desktop 17/17 | 不等同于桌面交互 |
| Server/契约 | local_editor_server、gui_web、editor_assets、packaging_contract | 初次 463 项中 2 失败已修复并重测通过，1 既有跳过 | 收尾执行完整复测；不等同于打包产物 |
| 桌面/浏览器交互 | 待执行 | 未执行 | macOS/Linux 本机实测需对应系统 |
| 打包/系统关联 | 待执行 | 未执行 | 不能用静态配置冒充安装双击实测 |
| CI/外部服务 | 无发布或 push 授权 | 未触发远端 CI | 不创建 tag、Release 或远端推送 |

# 命令面板 Phase 1 独立审查

基线 `4fd058e0`。只读独立审查未发现 blocker，报告 2 项 major、4 项 minor；以下均已处理，实机验收边界见[人工核验](命令面板.checklist.md)。

| 严重度 | 发现与证据 | 处理与复验 |
| --- | --- | --- |
| major | 普通保存未检查保存目标，空白工程的建议出现了不能执行的命令 | 复用 `projectSaveTargetEnabled()`，保留迁移另存为，并过滤加载与保存期间；Chromium 验证空白页隐藏，单测覆盖保存目标和迁移分支 |
| major | 面板隔离了编辑器的保存监听器，但没有取消浏览器的「保存网页」默认行为 | 只拦截保存及另存为组合键的默认行为；Chromium 验证这两个组合键已取消、粘贴未取消 |
| minor | 编辑器全局点击守卫先让按钮失焦，面板不能从 `activeElement` 取得真实点击入口 | 工具栏通过点击打开时明确指定回焦目标；Chromium 覆盖 |
| minor | `Home/End` 在原编辑器随导航上下文变化，不能等同于媒体首尾跳转 | 两个媒体跳转命令保留，不显示误导性徽章 |
| minor | 动态注销后，面板缓存的条目仍能运行 | 执行前按稳定 ID 重新查询注册表；Chromium 覆盖注销后按 Enter 不执行 |
| minor | 数量测试不足以确认既有动作接线 | 增加保存、媒体首尾定位的代表性注册表单测；Chromium 验证「打开工程」触发文件选择器事件 |

验证：构建及新鲜度、Node 8 项、Python 编辑器资源契约 26 项、空白 Server Chromium 1 项均通过。将模板替换为 `HEAD` 版本后，新模板契约用例按预期失败（缺少命令面板入口）。本地虚拟环境缺 `send2trash`，Chromium 复验使用 `.artifacts/` 中离线安装的锁定版本，不修改常规环境或依赖锁。浏览器报告与截图位于 `.artifacts/command-palette/browser-report/`，不入库。

## PR #410 CI 跟进（2026-11-20）

| 状态 | 检查 | 结论 |
| --- | --- | --- |
| 已修复 | [官网文档新鲜度](https://github.com/Moyf/moys-asr-workflow/actions/runs/44654917418/job/136018853102) | 两个官网镜像未随文档源更新；已用 `node website/scripts/sync-maw-docs.mjs` 重新生成，并通过与 CI 相同的 `git diff --exit-code` 比对。旧提交的远端 `Change acceptance` 因此失败；以修复提交的新 CI 结果为准。 |
| 仅说明 | [浏览器辅助检查](https://github.com/Moyf/moys-asr-workflow/actions/runs/44654917418/job/136018853015) | 227 通过、27 失败；新增命令面板用例通过。用 `2.0dev` 基线 `4fd058e0` 的干净源码重建，在本机 Chromium 仅复跑同一批 27 个用例，全部以相同的报错或断言类型失败；其中 4 项也在[基线远端辅助检查](https://github.com/Moyf/moys-asr-workflow/actions/runs/44172058094/job/134353699736)直接匹配。未发现本 PR 引入的辅助回归；不改旧用例，也不修改 CI 准入。 |

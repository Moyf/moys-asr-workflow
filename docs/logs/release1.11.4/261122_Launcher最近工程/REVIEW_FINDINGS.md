# Launcher 最近工程展开与收起：提交前自审

基线：`61000a2d7`。本次只调整 Launcher 列表展示，不改历史记录上限、排序或工程打开流程。

## 独立审查

- 无 blocker / major。
- 一项文档 nit，已修正。`git grep -n -E '^### .*变更|^### .*提升|启动器最近工程' -- CHANGELOG.md` 显示新条目原在「✨ 提升」；因默认展示从全部改为 3 条，移到「🔄 变更」。

## 验证

- 双向验证：`pnpm test launcher-recent-projects.spec.mjs` 对应的 Chromium 定向用例在基线源码上因默认显示 10 条而失败；重建 Launcher 后整个 spec 5 项通过。覆盖 0、2、3、10 条记录、键盘展开、刷新后的展开状态、点选第 10 条、中英文切换和收起。
- 查看收起与展开两张浏览器截图；几何断言确认标题行与列表间距至少 8 CSS px。
- Launcher bundle 新鲜度检查、相关 Node 测试 11 项、Python Launcher 契约 1 项、文档回归 22 项均通过。官网发布数据预览、检查及生成 46 个页面通过。
- 验证边界：浏览器用例模拟原生桥接；未覆盖原生 Launcher、macOS / Linux、窄窗和深色主题，也未跑全量 E2E。

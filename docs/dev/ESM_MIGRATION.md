# 编辑器 ESM 与构建入口

当前编辑器由 `web/editor-scripts.txt` 确定装配顺序，`web/editor-modules.json` 声明 ESM 工厂与外部桥；esbuild 生成同一 classic bundle，供 Server 与便携 HTML 使用。目录结构不能替代装配顺序，运行编辑器无需 Node。

- 开发命令、依赖准备和构建产物规则统一见 [贡献指南](../../CONTRIBUTING.md#编辑器前端构建)。
- 当前模块职责、宿主接口、状态/命令边界统一见 [开发概览](../DEVELOPMENT.md#编辑器源码地图)。
- 修改源码后提交 bundle 及 meta，并运行新鲜度检查；`blank-editor.html` 仅按发布规则生成，不手改内联代码。
- 尚需核验的旧门禁与集成边界见 [未完成事项](../OPEN_ITEMS.md)。

迁移阶段、固定 SHA 的上游冲突预演和测试计数保存在 [历史台账](../_archied/dev/ESM_MIGRATION.md)；研究工具使用说明见 [esm-mechanical](../../scripts/esm-mechanical/README.md)。历史候选的绿灯、失败或桌面实验结论不代表当前主线状态。

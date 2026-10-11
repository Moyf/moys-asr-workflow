# 当前相关参考

整理与提交前复核基线：main `8fdf3a7a`（2026-10-11）；首次落地试验使用 `09af19f1` 上的迁移快照。以下是可追溯的主题关联；迁移与结构检查不等于重新验收历史功能或全文人工回看。按实际变更更新相关条目。

| 主题 | 适用版本或代码范围 | 现行说明 / 计划 | 历史参考 | 差异或待办 |
| --- | --- | --- | --- | --- |
| 用户操作与打包入口 | 1.8.0-beta.1 元数据；main 8fdf3a7a | [用户入口](../INDEX.md#user-workflow)、[开发概览](../INDEX.md#engineering-development) | [发布核查](1.8.0-beta.1/2026-10-09/first-verification/README.md) | 人工核查与当时 main 对应；真实媒体、平台发行包与全文用法仍按发布范围验收。 |
| ASS 避碰与画面内排布 | main 09af19f1，PR #207 | [ASS 指南](../INDEX.md#user-ass)、[设置范围](../INDEX.md#engineering-editor-settings) | [PR #207 记录](unversioned/2026-10-11/PR205_ANCHOR_REVIEW_20261011.md) | 参考该记录的实测范围；不将单次截图或迁移结果视作所有模板通过。 |
| 编辑器设置拆分 | 当前设置源码及工程 / 本机存储范围 | [编辑器指南](../INDEX.md#user-editor)、[设置计划](../INDEX.md#plan-editor-settings) | [实施记录](unversioned/undated/EDITOR_SETTINGS_IMPLEMENTATION.md) | 已有实施结论；后续行为变化同步指南和设置范围，人工回看由维护者确认。 |
| 前端构建与 ESM 历史 | 当前 scripts/build-editor.mjs、web/editor/boot/ | [开发概览](../INDEX.md#engineering-development) | [ESM 迁移台账](unversioned/undated/ESM_MIGRATION.md)、[生产交接](unversioned/2026-10-08/ESM_UPSTREAM_PRODUCTION.md) | 180 文件隔离实验、59 工厂生产批次与当前构建分开阅读；旧目录说明不能替代本分支源码地图。 |
| 长命令与服务生命周期 | 当前 run_check.py、tests/e2e/server-process.mjs | [调试方法](../INDEX.md#engineering-debug)、[生命周期](../INDEX.md#engineering-e2e-lifecycle) | [长命令经验](../engineering/AGENT_LONG_COMMAND_GUIDE.md) | 新运行输出进入 .artifacts；旧记录中的旧路径保持历史语境。系统平台与真实浏览器检查分别报告。 |
| 2026-10 再次反馈 | 该反馈包及处理记录的明确基线 | [现行用户指南](../INDEX.md#user-editor) | [反馈原文](unversioned/2026-10-11/feedback/MAW%202.0%20%E6%96%B0%E7%89%88%E6%9C%AC%E6%A0%B8%E5%AF%B9.md)、[处理账本](unversioned/2026-10-11/feedback/%E5%A4%84%E7%90%86%E8%AE%B0%E5%BD%95.md) | 按账本区分已修复、仅说明和阻塞；未决项沿原议题处理。本次分类不改变其验收状态。 |

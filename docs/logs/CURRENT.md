# 当前相关参考

整理与提交前复核基线：main `8fdf3a7a`（2026-10-11）；首次落地试验使用 `09af19f1` 上的迁移快照。以下是可追溯的主题关联；迁移与结构检查不等于重新验收历史功能或全文人工回看。按实际变更更新相关条目。

| 主题 | 适用版本或代码范围 | 现行说明 / 计划 | 历史参考 | 差异或待办 |
| --- | --- | --- | --- | --- |
| AI 文稿处理与断句 | 原功能整合 main c2687a6；#227 本地修复整合 head 2e7028c | [工具箱](../INDEX.md#user-toolbox)、[核对与备注方案](../INDEX.md#plan-ai-processing-review) | [编辑稿记录](unversioned/2026-10-11/AI_CLEANUP_RC.md)、[断句记录](unversioned/2026-10-11/AI_RESEGMENT.md)、[备注与译文核对实现](unversioned/2026-10-12/AI_REVIEW_IMPLEMENTATION.md) | 交互式翻译核对和通用备注已实现；#227 四项修复及 main 兼容已通过本地分层验证，未推送上游。真实模型质量、素材回听及发行包待人工核验。 |
| 用户操作与打包入口 | 1.8.0-beta.1 元数据；main 8fdf3a7a | [用户入口](../INDEX.md#user-workflow)、[开发概览](../INDEX.md#engineering-development) | [发布核查](1.8.0-beta.1/2026-10-09/first-verification/README.md) | 人工核查与当时 main 对应；真实媒体、平台发行包与全文用法仍按发布范围验收。 |
| ASS 避碰与画面内排布 | main 09af19f1，PR #207 | [ASS 指南](../INDEX.md#user-ass)、[设置范围](../INDEX.md#engineering-editor-settings) | [PR #207 记录](unversioned/2026-10-11/PR205_ANCHOR_REVIEW_20261011.md) | 参考该记录的实测范围；不将单次截图或迁移结果视作所有模板通过。 |
| 编辑器设置拆分 | 当前设置源码及工程 / 本机存储范围 | [编辑器指南](../INDEX.md#user-editor)、[设置计划](../INDEX.md#plan-editor-settings) | [实施记录](unversioned/undated/EDITOR_SETTINGS_IMPLEMENTATION.md) | 已有实施结论；后续行为变化同步指南和设置范围，人工回看由维护者确认。 |
| 前端构建与 ESM 历史 | 当前 scripts/build-editor.mjs、web/editor/boot/ | [开发概览](../INDEX.md#engineering-development) | [ESM 迁移台账](unversioned/undated/ESM_MIGRATION.md)、[生产交接](unversioned/2026-10-08/ESM_UPSTREAM_PRODUCTION.md) | 180 文件隔离实验、59 工厂生产批次与当前构建分开阅读；旧目录说明不能替代本分支源码地图。 |
| 长命令与服务生命周期 | 当前 run_check.py、tests/e2e/server-process.mjs | [调试方法](../INDEX.md#engineering-debug)、[生命周期](../INDEX.md#engineering-e2e-lifecycle) | [长命令经验](../engineering/AGENT_LONG_COMMAND_GUIDE.md) | 新运行输出进入 .artifacts；旧记录中的旧路径保持历史语境。系统平台与真实浏览器检查分别报告。 |
| 2026-10 再次反馈 | 该反馈包及处理记录的明确基线 | [现行用户指南](../INDEX.md#user-editor) | [反馈原文](unversioned/2026-10-11/feedback/MAW%202.0%20%E6%96%B0%E7%89%88%E6%9C%AC%E6%A0%B8%E5%AF%B9.md)、[处理账本](unversioned/2026-10-11/feedback/%E5%A4%84%E7%90%86%E8%AE%B0%E5%BD%95.md) | 按账本区分已修复、仅说明和阻塞；未决项沿原议题处理。本次分类不改变其验收状态。 |
| 空结果与音轨提示 | PR #208 报告所记各轮实现与验证基线 | [常见问题](../INDEX.md#user-faq) | [PR #208 记录](unversioned/2026-10-11/PR208_AUDIO_DIAGNOSTICS_20261011.md)、[波形预研](unversioned/undated/PR208_WAVEFORM_PREFLIGHT_RESEARCH_20261011.md) | 当前指南描述空结果和已知音轨信息的提示边界；报告保留已撤销静音检测方案与各轮统计，不能将旧方案视作现行行为。 |
| 去空隙媒体导出 | PR #211 报告所记导出修复范围 | [编辑器指南](../INDEX.md#user-editor)、[工具箱](../INDEX.md#user-toolbox) | [PR #211 记录](unversioned/2026-10-11/PR211_MEDIA_EXPORT_FIXES.md) | 现行指南区分视频流复制的切点限制与音频按采样点输出 WAV；本次归档不重跑报告中的媒体验证矩阵。 |
| 编辑器设置与字词显示 | PR #218 反馈记录所记设置和显示行为 | [编辑器指南](../INDEX.md#user-editor)、[设置范围](../INDEX.md#engineering-editor-settings) | [PR #218 记录](unversioned/2026-10-11/TEST_FEEDBACK_WORD_TIMING_LAYOUT.md) | 指南与设置清单已补上双语设置页和字词码预设；反馈记录声明没有剩余开发项，Windows 临时目录问题保留为历史说明。 |
| MAW20 Gap 实现与局部 AI 移除 | PR-A 至 PR-D / 独立审查任务基线 | [Gap 来源与可重建规范](../INDEX.md#engineering-gap)、[编辑器指南](../INDEX.md#user-editor) | [PR-A](unversioned/2026-10-11/maw20-gap/MAW20_GAP_A.md)、[PR-B](unversioned/2026-10-11/maw20-gap/MAW20_GAP_B.md)、[PR-C](unversioned/2026-10-11/maw20-gap/MAW20_GAP_C.md)、[PR-D](unversioned/2026-10-11/maw20-gap/MAW20_GAP_D.md)、[独立审查](unversioned/2026-10-11/maw20-gap/MAW20_GAP_Q.md) | 这些日志记录各自基线和测试边界，不代替当前代码核验；PR-D 的真实模型样片未提供，合成协议验证不构成真实供应商验收。 |

PR #231 定位与震动返工的当前证据见[反馈账本](release1.9.0-beta.1/ASS_POSITION_REWORK.md)；逐句只保存 X/Y，使用全局样式锚点，人工素材确认与自动化检查分别记录。

- [媒体分层与可信报告](release1.10.0-beta.1/261023_媒体分层与可信报告/验证记录.md)：Q1 抽取和媒体真实边界；分组暂串行，新增 CI required 调用待远端运行。

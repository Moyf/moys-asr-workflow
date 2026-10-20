# 日志索引

<!-- log-release-baseline: 1.10.0-beta.1 -->

新共享日志放在 `docs/logs/release1.10.0-beta.1/<YYMMDD_<主题>/`，表示 **1.10.0-beta.1 之后的开发**。按根规则使用六位日期与可读主题组织同批记录；提交时间与演进通过 Git 历史追溯。目录不是声明这些记录已随该版本发布。

此表是可选的查阅入口，漏登记只提示；关键指南、方案和工程文档仍必须登记[主索引](../INDEX.md)。当前仍有参考价值或未决事项的记录可精选进 [CURRENT](CURRENT.md)。

确认发布成功后，将顶部基线和当前目录提示更新为新版本；后续日志归入新版本之后的开发。旧日志继续保留在原版本目录。完整步骤见[发布指南](../releases/README.md)。

以下旧目录保留原路径与当时语境，不要求批量迁移。跨版本记录只保留一份，范围见正文。

现行说明见[主题索引](../INDEX.md)，当前参考价值与未决事项见 [CURRENT](CURRENT.md)。截图、冻结 JSON、HTML 与源分段随所属记录保留；新生成的原始输出和预览进入根 `.artifacts/<task-id>/`。

| 版本 / 范围 | 任务日期 | 主题与原文 | 说明 |
| --- | --- | --- | --- |
| 1.10.0-beta.1 之后 | 2026-10-21 | [口播整理与字幕动画整合核验](release1.10.0-beta.1/261021_四PR整合/四PR整合.checklist.md) | PR274/266 中英文删除保护、PR275/277 叠加字幕定位与 pop 组合审查及人工边界 |
| 1.9.0-beta.3 之后 | 2026-10-20 | [单句放大出现](release1.9.0-beta.3/261020_每句放大出现/SENTENCE_POP_IN.md) | 句级 `{{文字}}` 放大出现动画：标记解析、两段式 `\t` 导出、预览插值与 fad/pop 参数解耦 |
| 1.10.0-beta.1 之后 | 2026-10-21 | [Launcher 最近工程审阅](release1.10.0-beta.1/261021_Launcher最近工程/审阅记录.md) / [人工核验](release1.10.0-beta.1/261021_Launcher最近工程/最近工程.checklist.md) | PR278 修复、Greptile 与 Windows 检查；PR235 双历史和桥遮蔽接入要求 |
| 1.9.0 之后 | 2026-10-20 | [口播整理协议修复](release1.9.0/261020_口播整理协议修复/修复记录.md) / [人工核验](release1.9.0/261020_口播整理协议修复/口播整理.checklist.md) | 英文词项空格、只读上下文与真实模型验证 |
| 1.9.0 之后 | 2026-10-20 | [1.10.0-beta.1 发布人工核验](release1.9.0/261020_1.10.0-beta.1发布核验/1.10.0-beta.1发布核验.checklist.md) | 等待维护者安装 beta 并验证烧录、Launcher 与字幕工作流；正式版须等核验完成 |
| 1.9.0 之后 | 2026-10-20 | [根目录整理](release1.9.0/261020_根目录整理/根目录整理.md)、[第二阶段](release1.9.0/261020_根目录整理/第二阶段.md) | 文档、打包与测试配置归位；转写入口模块化与独立 Runtime 适配 |
| 1.9.0 之后 | 2026-10-20 | [后处理供应商验证门槛修复](release1.9.0/261020_后处理供应商验证门槛/修复记录.md) / [人工核验](release1.9.0/261020_后处理供应商验证门槛/后处理供应商验证.checklist.md) | 供应商绑定、取消生命周期、异步乱序与演示状态回归 |
| 1.9.0 之后 | 2026-10-20 | [文稿对齐 FFmpeg 与设置入口](release1.9.0/261020_AlignFFmpeg/TEST_FEEDBACK.md) / [人工核验](release1.9.0/261020_AlignFFmpeg/AlignFFmpeg.checklist.md) | Windows 同名模块误选修复；快捷设置与真实模型推理边界 |
| 1.9.0 之后 | 2026-10-19 | [PR267 工程烧录颜色引用](release1.9.0/261019_PR267颜色引用/修复记录.md) | 空字幕过滤后的原始颜色索引、导出与烧录目标回归 |
| 1.9.0-beta.3 之后 | 2026-10-18 | [编辑器帮助与 SRT 烧录核验](release1.9.0-beta.3/261018_编辑器帮助与SRT烧录/编辑器帮助与SRT烧录.checklist.md) | 精简帮助、名称统一、SRT 样式烧录与包裹边界；自动化与人工验收分开记录 |
| 1.9.0-beta.3 之后 | 2026-10-18 | [正式版本更新管线实施](release1.9.0-beta.3/261018_正式版更新管线/IMPLEMENTATION.md) / [核对清单](release1.9.0-beta.3/261018_正式版更新管线/RELEASE_PIPELINE.checklist.md) | 正式版归档、官网、资源共用、JSON 与发布联动；真实 CI / 部署待验收 |
| 1.9.0-beta.3 之后 | 2026-10-18 | [PR246 主线整合](release1.9.0-beta.3/261018_PR246主线整合/整合记录.md) | 五处冲突的组合策略、独立复查与组合回归 |
| 1.9.0-beta.2 之后 | 2026-10-18 | [PR246 同页切换失效](release1.9.0-beta.2/261018_PR246切换失效/修复记录.md) | 最小协议、模块范围与分层回归证据 |
| 1.9.0-beta.3 之后 | 2026-10-18 | [PR 265 样式库与去空隙导出核验](release1.9.0-beta.3/261018_样式库与去空隙导出/样式库与去空隙导出.checklist.md) | 历史 ASS 字节基线、颜色去空隙过滤、英文重置确认与分层验证 |
| 1.9.0-beta.3 之后 | 2026-10-17 | [表情包烧录基础管线](release1.9.0-beta.3/261017_表情包烧录/TASK.md) · [两种显示方案研究](release1.9.0-beta.3/261017_表情包烧录/STICKER_DISPLAY_MODES.md) | overlay 与 ass 同滤镜图一次性编码；固定位置与字幕首字左侧两方案均已实现（预览层跟随字幕留后续） |
| 1.9.0-beta.3 之后 | 2026-10-17 | [绿幕视频导出核验](release1.9.0-beta.3/261017_绿幕视频导出/绿幕视频导出.checklist.md) | 编辑器音视频绿幕入口、全局偏好与 Launcher 可选音轨 |
| 1.9.0-beta.3 之后 | 2026-10-17 | [MASS 拆分/合并符号修复](release1.9.0-beta.3/261017_MASS拆分合并符号/修复记录.md) / [人工核验](release1.9.0-beta.3/261017_MASS拆分合并符号/MASS拆分合并.checklist.md) | 单词型合并折叠符号对、渐进拆分左半句补全、整句壳与行内标记区分；含预览与提交一致性补验 |
| 1.9.0-beta.3 之后 | 2026-10-17 | [翻译工程双轨修复](release1.9.0-beta.3/261017_翻译工程双轨/修复记录.md) / [人工清单](release1.9.0-beta.3/261017_翻译工程双轨/翻译工程双轨.checklist.md) | 中间与最终 MOSP 保留可编辑双轨，SRT 独立合并，核对下载兼容与完整套件异常边界 |
| 1.9.0-beta.2 之后 | 2026-10-17 | [翻译语言判定与开关](release1.9.0-beta.2/261017_翻译语言判定/修复记录.md) / [人工核验](release1.9.0-beta.2/261017_翻译语言判定/翻译语言判定.checklist.md) | PR 260 已合并，beta.3 Windows 发布完成；Greptile 非阻塞测试建议与平台构建边界 |
| 1.9.0-beta.2 之后 | 2026-10-16 | [PR 241 正确性复审与修复](release1.9.0-beta.2/261016_PR241正确性复审/修复与验证.md) / [人工清单](release1.9.0-beta.2/261016_PR241正确性复审/PR241正确性.checklist.md) | 三项阻塞、open PR 避让、真实媒体与绑定/诊断修复、主线组合边界 |
| 1.9.0-beta.1 之后 | 2026-10-15 | [编辑器「烧录视频」功能实现](release1.9.0-beta.1/261015_编辑器烧录视频/EDITOR_BURN_VIDEO.md) / [人工核验](release1.9.0-beta.1/261015_编辑器烧录视频/EDITOR_BURN_VIDEO.checklist.md) | 完整源视频与去空隙两个烧录入口、服务端任务契约与验证 |
| 1.9.0-beta.2 之后 | 2026-10-16 | [PR #243 合入顺序与兼容交接](release1.9.0-beta.2/261015_测试反馈修复/协调记录.md) | PR 243先合入；PR 239承接2.0保存模型适配，保留人工未确认边界 |
| 1.9.0-beta.2 之后 | 2026-10-15 | [Issue #237 主修复人工核验](release1.9.0-beta.2/261015_测试反馈修复/ISSUE237_MAIN.checklist.md) | PR 243的29项人工核验源清单，自动化与人工验收分开记录 |
| 1.9.0-beta.2 之后 | 2026-10-16 | [PR #242 视频预览复审](release1.9.0-beta.2/261016_PR242复审/PR242_视频预览复审.checklist.md) | 旧问题核验、暂停重试边界修复、独立环境与人工体验核对 |
| 1.9.0-beta.2 之后 | 2026-10-16 | [主字幕单句缩放](release1.9.0-beta.2/ASS_CUE_SCALE.md) · [核对清单](release1.9.0-beta.2/ASS_CUE_SCALE.checklist.md) | 单句缩放设计、实现、分层验证与 PR 跟进 |
| 1.9.0-beta.2 之后 | 2026-10-15 | [去空隙视频安全边界与诊断成本](release1.9.0-beta.2/261015_去空隙视频/验证记录.md) · [人工核验](release1.9.0-beta.2/261015_去空隙视频/ISSUE237_MEDIA.checklist.md) | IDR 入口、实际删减结果、资源测量与未覆盖媒体边界 |
| 1.9.0-beta.2 之后 | 2026-10-16 | [本地自然断句记录](release1.9.0-beta.2/261016_本地自然断句/任务记录.md) · [核查清单](release1.9.0-beta.2/261016_本地自然断句/本地自然断句.checklist.md) | 单句上限的数字单位保护、短尾重平衡与同批模拟语料对比 |
| 1.9.0-beta.1 之后 | 2026-10-15 | [PR #231 定位与震动返工](release1.9.0-beta.1/ASS_POSITION_REWORK.md) | 反馈账本、分层验证及重写历史后的内容重放 |
| 1.9.0-beta.1 之后 | 2026-10-15 | [工程媒体关联修复](release1.9.0-beta.1/261015_工程媒体关联/修复记录.md) | 路径设计、Greptile/打包修复、验证与黑屏调查边界 |
| 1.9.0-beta.1 之后 | 2026-10-15 | [导出菜单、关闭焦点与测试增补](release1.9.0-beta.1/261015_导出菜单与关闭焦点/增补记录.md) | OTIO 留白、Esc/空格、测试隔离与 Tauri 退役 |
| 1.9.0-beta.1 之后 | 2026-10-15 | [v1.9.0-beta.1 测试反馈与处理记录](release1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1.md) | 30 项实测反馈账本，含 9 份调查报告；已汇总为 Issue #237 |
| 1.9.0-beta.2 之后 | 2026-10-15 | [视频缩略图相关反馈与处理记录](release1.9.0-beta.2/261015_视频缩略图相关/TEST_FEEDBACK_视频缩略图.md) | 画面带主题独立分账：显示性能问答、实时补间开关、生成速度优化与 Launcher 开关 |
| 1.9.0-beta.2 之后 | 2026-10-16 | [PR #233 脏录音审查回归修复](release1.9.0-beta.2/261016_脏录音审查回归修复/修复记录.md) | 补码选轨、媒体路径、原始 ASR 预检与人工核查页 |
| unversioned | 2026-10-14 | [Launcher 现代化改版实施记录](unversioned/2026-10-14/LAUNCHER_REDESIGN_IMPLEMENTATION.md) | 分阶段实施账本、测试约束与验证记录 |
| unversioned | 2026-10-11 | [AI 口播整理编辑稿改造](unversioned/2026-10-11/AI_CLEANUP_RC.md) | 模型编辑稿、固定转换与删除恢复的实现和验证 |
| unversioned | 2026-10-11 | [AI 重新断句改进记录](unversioned/2026-10-11/AI_RESEGMENT.md) | 字数上限、复杂用例复测及主分支整合证据 |
| unversioned | 2026-10-11 | [Agent 长周期修复的踩坑记录：e2e 像素验证体系与语义撤回](unversioned/2026-10-11/agent-e2e-pitfalls.md) | PR #225 撤回 #205 语义后，e2e 像素断言体系的适配坑与规避方法 |
| unversioned | undated | [符号级合并重放工作流](unversioned/undated/%E7%AC%A6%E5%8F%B7%E7%BA%A7%E5%90%88%E5%B9%B6%E9%87%8D%E6%94%BE%E5%B7%A5%E4%BD%9C%E6%B5%81.md) | 保留原始结论与验证范围 |
| unversioned | undated | [入口与层次](unversioned/undated/editor-settings-report/editor-settings.md) | 保留原始结论与验证范围 |
| unversioned | undated | [翻译段本地化（波 1 增补）实施记录](unversioned/undated/TEST_FEEDBACK_TRANSLATE_LOCALIZE.md) | 保留原始结论与验证范围 |
| unversioned | undated | [RTF 文件名撤销 + 组合标记本地化 波 5 实施记录](unversioned/undated/TEST_FEEDBACK_RTF_UNDO_MARKERS.md) | 保留原始结论与验证范围 |
| unversioned | undated | [输出文件名开关 + RTF 标签 实施记录](unversioned/undated/TEST_FEEDBACK_RTF_TAG.md) | 保留原始结论与验证范围 |
| unversioned | undated | [TEST_FEEDBACK — PR #180 Review（Canvas 预览）](unversioned/undated/TEST_FEEDBACK_PR180.md) | 保留原始结论与验证范围 |
| unversioned | undated | [PR #150 审查修复记录](unversioned/undated/TEST_FEEDBACK_PR150.md) | 保留原始结论与验证范围 |
| unversioned | undated | [Launcher 文件输出设置 + RTF 重命名 波 2 实施记录](unversioned/undated/TEST_FEEDBACK_OUTPUT_DIR_WAVE2.md) | 保留原始结论与验证范围 |
| unversioned | undated | [新建工程与空白编辑器导入处理记录](unversioned/undated/TEST_FEEDBACK_NEW_PROJECT.md) | 保留原始结论与验证范围 |
| unversioned | undated | [TEST_FEEDBACK_MARKERS_UX](unversioned/undated/TEST_FEEDBACK_MARKERS_UX.md) | 保留原始结论与验证范围 |
| unversioned | undated | [macOS 单元测试环境失败修复记录](unversioned/undated/TEST_FEEDBACK_MACOS_UNIT_TESTS.md) | 保留原始结论与验证范围 |
| unversioned | undated | [Launcher 与 Editor 布局反馈记录](unversioned/undated/TEST_FEEDBACK_LAYOUT.md) | 保留原始结论与验证范围 |
| unversioned | undated | [静音空隙 Gap 功能反馈与处理记录](unversioned/undated/TEST_FEEDBACK_GAP.md) | 保留原始结论与验证范围 |
| unversioned | undated | [干净 HEAD 复现的 e2e 失败清单（triage 与修复）](unversioned/undated/TEST_FEEDBACK_E2E_DRIFT.md) | 保留原始结论与验证范围 |
| unversioned | undated | [音轨选择反馈](unversioned/undated/TEST_FEEDBACK_AUDIO_TRACKS.md) | 保留原始结论与验证范围 |
| unversioned | undated | [ASR 识别预设管理：UI 反馈与整理记录](unversioned/undated/TEST_FEEDBACK_ASR_PRESET_MANAGER.md) | 保留原始结论与验证范围 |
| unversioned | undated | [文稿录制对齐 MVP 反馈记录](unversioned/undated/TEST_FEEDBACK_ALIGN_MVP.md) | 保留原始结论与验证范围 |
| unversioned | undated | [TEST_FEEDBACK_AI_CLEANUP_MARKERS](unversioned/undated/TEST_FEEDBACK_AI_CLEANUP_MARKERS.md) | 保留原始结论与验证范围 |
| unversioned | undated | [时间码对比页面计划（tools/timestamp-compare.html）](unversioned/undated/PLAN_TIMESTAMP_COMPARE.md) | 保留原始结论与验证范围 |
| unversioned | undated | [编辑器 ESM 迁移：实施台账与上游交接](unversioned/undated/ESM_MIGRATION.md) | 保留原始结论与验证范围 |
| unversioned | undated | [编辑器设置整理实施记录](unversioned/undated/EDITOR_SETTINGS_IMPLEMENTATION.md) | 保留原始结论与验证范围 |
| unversioned | undated | [PR #208 波形与响度预研](unversioned/undated/PR208_WAVEFORM_PREFLIGHT_RESEARCH_20261011.md) | 正文未明确任务日期；保留研究结论与原文件名 |
| 1.8.0-beta.1 | undated | [v1.8.0-beta.1 发布审查](1.8.0-beta.1/undated/RELEASE_REVIEW_1.8.0-beta.1.md) | 保留原始结论与验证范围 |
| 1.4.0-beta.7 | undated | [v1.4.0-beta.7 测试反馈与处理记录](1.4.0-beta.7/undated/TEST_FEEDBACK_BETA7.md) | 保留原始结论与验证范围 |
| 1.3.2 → 1.4.0（跨版本） | undated | [MAW 1.3.2 → 1.4.0-beta.4 变更回顾](1.3.2/undated/RELEASE_REVIEW_1.3.2_TO_1.4.0.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-11 | [261011 再次反馈处理记录](unversioned/2026-10-11/feedback/%E5%A4%84%E7%90%86%E8%AE%B0%E5%BD%95.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-11 | [MAW 2.0 新版本核对](unversioned/2026-10-11/feedback/MAW%202.0%20%E6%96%B0%E7%89%88%E6%9C%AC%E6%A0%B8%E5%AF%B9.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-11 | [PR #207: visibility-first ASS subtitle stacking](unversioned/2026-10-11/PR205_ANCHOR_REVIEW_20261011.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-11 | [PR #218 编辑器与 Launcher 反馈收尾](unversioned/2026-10-11/TEST_FEEDBACK_WORD_TIMING_LAYOUT.md) | 保留原始结论、统计和验证范围 |
| unversioned | 2026-10-11 | [PR #211 媒体重组修复与音频导出](unversioned/2026-10-11/PR211_MEDIA_EXPORT_FIXES.md) | 保留原始结论、统计和验证范围 |
| unversioned | 2026-10-11 | [PR #208 Launcher 空结果与音轨诊断](unversioned/2026-10-11/PR208_AUDIO_DIAGNOSTICS_20261011.md) | 保留当前方案、历史方案和各轮验证范围 |
| unversioned | 2026-10-11 | [MAW20 PR-D 可靠字词局部 AI 移除](unversioned/2026-10-11/maw20-gap/MAW20_GAP_D.md) | 保留协议范围、合成验证与真实模型验收边界 |
| unversioned | 2026-10-11 | [PR #223 编辑器反馈实施记录](unversioned/2026-10-11/PR223_EDITOR_FEEDBACK.md) | 保留 PR 原始开发与当时验证边界；后续审阅见开放 PR 计划 |
| unversioned | 2026-10-11 | [MAW20 PR-C 去空隙视频后台任务](unversioned/2026-10-11/maw20-gap/MAW20_GAP_C.md) | 保留原始结论、统计和验证范围 |
| unversioned | 2026-10-11 | [MAW20 PR-B 普通文稿匹配取消](unversioned/2026-10-11/maw20-gap/MAW20_GAP_B.md) | 保留原始结论、统计和验证范围 |
| unversioned | 2026-10-11 | [MAW20 PR-A 视频导出绑定时序](unversioned/2026-10-11/maw20-gap/MAW20_GAP_A.md) | 保留原始结论、统计和验证范围 |
| unversioned | 2026-10-11 | [MAW20 缺口机动独立审查](unversioned/2026-10-11/maw20-gap/MAW20_GAP_Q.md) | 保留原始审查范围与独立验证边界 |
| unversioned | 2026-10-10 | [Launcher.js 拆分重构（第一阶段）](unversioned/2026-10-10/REFACTOR_LAUNCHER_SPLIT.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-09 | [Verification 核对工具调整（2026-10-09）](unversioned/2026-10-09/TEST_FEEDBACK_VERIFICATION_TOOL.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-09 | [设置页改进记录（2026-10-09）](unversioned/2026-10-09/TEST_FEEDBACK_SETTINGS_20261009.md) | 保留原始结论与验证范围 |
| 1.8.0-beta.1 → 当时 main | 2026-10-09 | [185 后续补充内容核查（2026-10-09）](1.8.0-beta.1/2026-10-09/first-verification/data/issue185-followup.md) | 附件源数据 |
| 1.8.0-beta.1 → 当时 main | 2026-10-09 | [提交清单与分组方案（v1.8.0-beta.1..HEAD，共 28 提交 + 1 merge）](1.8.0-beta.1/2026-10-09/first-verification/data/commits.md) | 附件源数据 |
| 1.8.0-beta.1 → 当时 main | 2026-10-09 | [当前 HEAD（9b7e62b8）自动化基线 — 2026-10-09 实测](1.8.0-beta.1/2026-10-09/first-verification/data/baseline.md) | 附件源数据 |
| 1.8.0-beta.1 → 当时 main | 2026-10-09 | [MAW 发布核查清单生成任务（2026-10-09）](1.8.0-beta.1/2026-10-09/first-verification/README.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-08 | [ESM 迁移后的上游 PR 合并预演](unversioned/2026-10-08/esm-research/ESM_UPSTREAM_MERGE_REHEARSAL.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-08 | [上游 PR → ESM fork：复现与处理手册](unversioned/2026-10-08/esm-research/ESM_UPSTREAM_MERGE_PLAYBOOK.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-08 | [ESM 机械迁移调研结果](unversioned/2026-10-08/esm-research/ESM_MECHANICAL_RESEARCH_REPORT.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-08 | [ESM 契约迁移与红绿实验](unversioned/2026-10-08/esm-research/ESM_CONTRACT_MIGRATION.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-08 | [174 文稿驱动对齐开发记录](unversioned/2026-10-08/FEATURE_SCRIPT_ALIGNMENT_174.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-08 | [部分 ESM 迁移的上游交接与冲突处理](unversioned/2026-10-08/ESM_UPSTREAM_PRODUCTION.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-07 | [字幕拖动性能量化研究（5000 条工程）](unversioned/2026-10-07/PERF_CUE_DRAG_RESEARCH.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-04 | [PR #170 评论修复（2026-10-04）](unversioned/2026-10-04/TEST_FEEDBACK_PR170_COMMENTS.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-04 | [AI 整理复查与标记批量管理（2026-10-04）](unversioned/2026-10-04/TEST_FEEDBACK_AI_CLEANUP_REVIEW.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-04 | [近期更新整体审查（2026-10-04）](unversioned/2026-10-04/REVIEW_RECENT_WORKFLOW.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-02 | [PR #166 审查报告（2026-10-02）](unversioned/2026-10-02/PR_REVIEW_166.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-02 | [PR #165 审查报告（2026-10-02）](unversioned/2026-10-02/PR_REVIEW_165.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-01 | [文档重构记录（2026-10-01）](unversioned/2026-10-01/%E6%96%87%E6%A1%A3%E9%87%8D%E6%9E%84%E8%AE%B0%E5%BD%95.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-01 | [双语 SRT 导出反馈（2026-10-01）](unversioned/2026-10-01/TEST_FEEDBACK_BILINGUAL_EXPORT.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-01 | [ASS 界面反馈（2026-10-01）](unversioned/2026-10-01/TEST_FEEDBACK_ASS_UI.md) | 保留原始结论与验证范围 |
| unversioned | 2026-10-01 | [ASS 预览一致性反馈（2026-10-01）](unversioned/2026-10-01/TEST_FEEDBACK_ASS_PREVIEW_FIDELITY.md) | 保留原始结论与验证范围 |
| unversioned | 2026-09-30 | [ASS 样式库与字幕模式反馈记录](unversioned/2026-09-30/TEST_FEEDBACK_ASS_STYLE.md) | 保留原始结论与验证范围 |
| unversioned | 2026-09-28 | [调研简报：MAWE 编辑器前端 ESM 化能否机械化完成](unversioned/2026-09-28/esm-research/ESM_MECHANICAL_RESEARCH_BRIEF.md) | 保留原始结论与验证范围 |
| unversioned | 2026-09-26 | [MAWE 职责拆分与宿主边界进度](unversioned/2026-09-26/MAWE%20%E8%81%8C%E8%B4%A3%E6%8B%86%E5%88%86%E4%B8%8E%E5%AE%BF%E4%B8%BB%E8%BE%B9%E7%95%8C%E8%BF%9B%E5%BA%A6.md) | 保留原始结论与验证范围 |
| unversioned | 2026-09-26 | [MAWE 状态与命令重构进度](unversioned/2026-09-26/MAWE%20%E7%8A%B6%E6%80%81%E4%B8%8E%E5%91%BD%E4%BB%A4%E9%87%8D%E6%9E%84%E8%BF%9B%E5%BA%A6.md) | 保留原始结论与验证范围 |
| unversioned | 2026-09-16 | [全量 E2E 基线失败排查记录](unversioned/2026-09-16/TEST_FEEDBACK_E2E_MAIN.md) | 保留原始结论与验证范围 |
| unversioned | 2026-09-10 | [MAWE 编辑器模块化拆分台账](unversioned/2026-09-10/MAWE%20%E7%BC%96%E8%BE%91%E5%99%A8%E6%A8%A1%E5%9D%97%E5%8C%96%E6%8B%86%E5%88%86%E5%8F%B0%E8%B4%A6.md) | 保留原始结论与验证范围 |
| unversioned | 2026-09-07 | [Parakeet TDT 日文模型接入调研](unversioned/2026-09-07/Parakeet%20TDT%20%E6%97%A5%E6%96%87%E6%A8%A1%E5%9E%8B%E6%8E%A5%E5%85%A5%E8%B0%83%E7%A0%94.md) | 保留原始结论与验证范围 |
| unversioned | 2026-09-04 | [时间基准、帧吸附与时间码显示](unversioned/2026-09-04/TEST_FEEDBACK_TIMEBASE.md) | 保留原始结论与验证范围 |
| unversioned | 2026-08-27 | [断句/标点符号配置统一化（工具箱 → ⚙️ 设置共享配置）](unversioned/2026-08-27/TEST_FEEDBACK_PUNCT_SETTINGS.md) | 保留原始结论与验证范围 |
| unversioned | 2026-08-27 | [本地引擎分段整理失效反馈记录（MOSS / 共享层）](unversioned/2026-08-27/TEST_FEEDBACK_MOSS.md) | 保留原始结论与验证范围 |
| unversioned | 2026-08-20 | [PR #56 审核报告](unversioned/2026-08-20/PR56_REVIEW.md) | 保留原始结论与验证范围 |
| unversioned | 2026-08-13 | [MAWE 前端重构基线](unversioned/2026-08-13/MAWE%20%E5%89%8D%E7%AB%AF%E9%87%8D%E6%9E%84%E5%9F%BA%E7%BA%BF.md) | 保留原始结论与验证范围 |
| unversioned | 2026-08-03 | [Qwen-Audio Filetrans 开发计划](unversioned/2026-08-03/Qwen-Audio-Filetrans%20%E5%BC%80%E5%8F%91%E8%AE%A1%E5%88%92.md) | 保留原始结论与验证范围 |
| unversioned | 2026-08-03 | [MAW 1.2 本地模型 Launcher 开发记录](unversioned/2026-08-03/MAW%201.2%20%E6%9C%AC%E5%9C%B0%E6%A8%A1%E5%9E%8B%20Launcher%20%E5%BC%80%E5%8F%91%E8%AE%B0%E5%BD%95.md) | 保留原始结论与验证范围 |
| unversioned | 2026-07-28 | [ASR 供应商调研：Fun-ASR 与豆包大模型录音文件识别](unversioned/2026-07-28/ASR_PROVIDER_RESEARCH.md) | 保留原始结论与验证范围 |
| 1.1.0 | 2026-07-27 | [MAW 1.1 开发追踪](1.1.0/2026-07-27/MAW%201.1%20%E5%BC%80%E5%8F%91%E8%BF%BD%E8%B8%AA.md) | 正文明确版本目标为 1.1.0；保留原始结论与验证范围 |
| unversioned | undated | [editor-settings.html](unversioned/undated/editor-settings-report/editor-settings.html) | 共享报告；源材料在同目录 |
| 1.8.0-beta.1 | 2026-10-09 | [maw-verification-v1.8.0b1-to-main.html](1.8.0-beta.1/2026-10-09/first-verification/maw-verification-v1.8.0b1-to-main.html) | 共享报告；源材料在同目录 |

- [AI 备注与译文核对实现](unversioned/2026-10-12/AI_REVIEW_IMPLEMENTATION.md)：通用工程备注和离线译文编辑的进度、证据与边界。
- [AI 整理诊断与可选复查](release1.9.0-beta.2/261016_AI整理诊断与复查/任务记录.md)：行数差异复现、阶段记录、原始输入与人工核验清单。
- [AI 整理人工核验清单](release1.9.0-beta.2/261016_AI整理诊断与复查/AI整理.checklist.md)：复查、留档、处理输入和真实听审。
- [AI 处理核验矩阵](release1.9.0-beta.2/261016_AI整理诊断与复查/AI处理核验矩阵.md)：截图条目 06 / 07 的自动化与本地 Gemma 实测证据。
- [重新断句诊断](release1.9.0-beta.2/261016_重新断句诊断/任务记录.md)、[流程初审](release1.9.0-beta.2/261016_重新断句诊断/AI处理流程审查.md)、[核查清单](release1.9.0-beta.2/261016_重新断句诊断/重新断句诊断.checklist.md)：断点定位、逐请求留档与重试批次。
- [Agent e2e 像素验证体系与语义撤回踩坑记录](release1.8.0-beta.1/Agent-e2e验证踩坑.md)：日志留档，详见原文。
- [TEST_FEEDBACK_BETA1-investigation-ass-fullscreen](release1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1-investigation-ass-fullscreen.md)：日志留档，详见原文。
- [TEST_FEEDBACK_BETA1-investigation-comparison-deletion](release1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1-investigation-comparison-deletion.md)：日志留档，详见原文。
- [TEST_FEEDBACK_BETA1-investigation-gap-export](release1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1-investigation-gap-export.md)：日志留档，详见原文。
- [TEST_FEEDBACK_BETA1-investigation-launcher-editor](release1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1-investigation-launcher-editor.md)：日志留档，详见原文。
- [TEST_FEEDBACK_BETA1-investigation-overlay-jitter](release1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1-investigation-overlay-jitter.md)：日志留档，详见原文。
- [TEST_FEEDBACK_BETA1-investigation-split-markers](release1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1-investigation-split-markers.md)：日志留档，详见原文。
- [TEST_FEEDBACK_BETA1-investigation-timedtext](release1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1-investigation-timedtext.md)：日志留档，详见原文。
- [TEST_FEEDBACK_BETA1-investigation-view-state](release1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1-investigation-view-state.md)：日志留档，详见原文。
- [TEST_FEEDBACK_BETA1-investigation-yellow-defaults](release1.9.0-beta.1/261015_测试反馈/TEST_FEEDBACK_BETA1-investigation-yellow-defaults.md)：日志留档，详见原文。
- [1016 大核验人工核对清单](release1.9.0-beta.2/261016_大核验/1016大核验.checklist.md)：日志留档，详见原文。
- [1016 大核验用户反馈与测试记录](release1.9.0-beta.2/261016_大核验/TEST_FEEDBACK_大核验.md)：日志留档，详见原文。
- [PR 253 人工核验清单（渐进与复制拆分）](release1.9.0-beta.2/261017_PR复审/PR253.checklist.md)：日志留档，详见原文。
- [PR 254 人工核验清单（后续批复审核验）](release1.9.0-beta.2/261017_PR复审/PR254.checklist.md)：日志留档，详见原文。

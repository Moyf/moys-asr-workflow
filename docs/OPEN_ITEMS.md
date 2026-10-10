# 未完成事项与待核验记录

整理基线：2026-10-10，功能代码 `3a10baf1`。这里只提取需要后续行动的事项；**历史“待处理”不等于当前缺陷**。本次检查文档与相关代码，没有重跑产品测试、调用服务、下载模型或完成实机验收。各项按需跟进，不构成新增功能授权。

## 测试与运行环境

| 事项 | 当前判断 / 下一步 | 来源 |
| --- | --- | --- |
| cue-scroll Server 生命周期 | 待核验：记录称中断及正常退出均有残留。检查当前 teardown，并分别验证正常完成、中断后的本次进程与端口回收。 | [事故记录](_archied/incidents/E2E_SERVER_HANG.md) |
| OCR hint 测试移交与毫秒派生字段措辞 | 待核验：先确认 Launcher 后续修复与当前 JSON_SCHEMA，勿直接重放旧失败；Gap 的 audio_gate 收缩语义按契约判断。 | [E2E 移交](_archied/feedback/TEST_FEEDBACK_E2E_DRIFT.md)、[Gap 记录](_archied/feedback/TEST_FEEDBACK_GAP.md) |
| 搜索框 Home 键偶发失败 | 待核验：发布审查保留了光标偶发不移到首部的边界，需在当前搜索输入框定向复现。 | [发布审查](_archied/reviews/RELEASE_REVIEW_1.8.0-beta.1.md) |
| 旧 ESM PR 预演的四项交互失败与 #157 架构冲突 | 历史候选状态，待有对应集成任务时对照当前源码与测试；不要将旧候选 SHA 的失败直接当作 main 回归。 | [预演记录](_archied/dev/ESM_UPSTREAM_PRODUCTION.md) |

## 明确待人工或真实环境验收

| 事项 | 验收范围 / 下一步 | 来源 |
| --- | --- | --- |
| 多音轨 pywebview Launcher | 历史阻塞：多轨显示、默认轨、切换后的转写 payload 与波形一致性；Chromium 页面通过不能代替原生宿主。 | [音轨记录](_archied/feedback/TEST_FEEDBACK_AUDIO_TRACKS.md) |
| Premiere 交接与 Final Cut 导入 | Premiere 检查 4K/1080p 字号比例、位置与导入结果；旧 PR #56 帧范围、贴图导出等未勾项先核对后续实现。Final Cut 的旧验收承诺也需按当前支持范围重审。 | [BETA7](_archied/feedback/TEST_FEEDBACK_BETA7.md)、[PR #56](_archied/reviews/PR56_REVIEW.md)、[1.1 计划](_archied/dev/MAW%201.1%20开发追踪.md) |
| 核对清单的下载、离线刷新与忽略分组 | 历史阻塞：打开实际下载 JSON 核对内容，刷新原离线页，确认悬停、灰色折叠、计数和恢复；合成页测试不能代替。 | [核查工具记录](_archied/feedback/TEST_FEEDBACK_VERIFICATION_TOOL.md) |
| 文稿驱动对齐的真实模型质量 | 无真实 ForcedAligner 权重 / 推理证据；有环境后验证短稿、超过 10 分钟的长稿与脏录音听感。替身时间码测试不算声学验收。 | [功能记录](_archied/features/FEATURE_SCRIPT_ALIGNMENT_174.md) |
| MOSS GPU 推理与进度 | 用同一真实媒体复验分段、token 更新频率及首 token 等待体验；记录中有后续英文重切实现，不能照早期段落判为未实现。 | [MOSS 记录](_archied/feedback/TEST_FEEDBACK_MOSS.md) |
| Qwen-Audio 与 Soniox 真实接口 | Qwen-Audio：短音频、模型权限、地域、词表与 Launcher 模型/文件名/speaker；Soniox：中文 token 粒度与 speaker 返回形态。需要实际凭据，离线测试不替代。 | [Filetrans](_archied/dev/Qwen-Audio-Filetrans%20开发计划.md)、[1.1 记录](_archied/dev/MAW%201.1%20开发追踪.md) |
| 标点设置与识别预设原生宿主 | 检查设置入口、编辑与持久化回读；预设失焦保存与列表切换/删除并发缺专项交互证据。孤儿 CSS 仅是清理候选，先查当前引用。 | [标点设置](_archied/feedback/TEST_FEEDBACK_PUNCT_SETTINGS.md)、[预设管理](_archied/feedback/TEST_FEEDBACK_ASR_PRESET_MANAGER.md) |
| Gap / 对齐 / 时间基准的真实媒体交互 | 检查旧工程恢复范围、跨行拖动、短行高、不同指针设备、播放/Seek、拆分与保存；性能 profile 及长工程多轨压测按具体问题补证据。 | [对齐](_archied/feedback/TEST_FEEDBACK_ALIGN_MVP.md)、[Gap](_archied/feedback/TEST_FEEDBACK_GAP.md)、[时间基准](_archied/feedback/TEST_FEEDBACK_TIMEBASE.md)、[性能研究](_archied/research/PERF_CUE_DRAG_RESEARCH.md) |
| AI 标记跨行指针拖动、模型质量 | 原任务未模拟跨行真实指针拖动，部分视觉检查仅有 DOM 数据；真实口播删留质量、费用与耗时需真实服务评估。 | [标记记录](_archied/feedback/TEST_FEEDBACK_AI_CLEANUP_MARKERS.md)、[复查记录](_archied/feedback/TEST_FEEDBACK_AI_CLEANUP_REVIEW.md) |
| ASS 与字体实机 | 检查 local-fonts 授权、窄屏、特殊文本入口跳转/滚动；真实缺字烧录、原媒体、Windows/Linux 字体回退、HDR/非方形像素及高分辨率性能仍有边界。不承诺预览等于最终 libass。 | [样式](_archied/feedback/TEST_FEEDBACK_ASS_STYLE.md)、[实际帧](_archied/feedback/TEST_FEEDBACK_ASS_PREVIEW_FIDELITY.md)、[Canvas](_archied/feedback/TEST_FEEDBACK_PR180.md) |
| 输出命名 / 翻译管线 | demo 输出目录镜像、RTF 真转写，以及中英文真实 GUI 管线与旧产物目录对照，缺对应实机证据；旧 Rust 构建要求不沿用到已移除的 Tauri 实验。 | [输出目录](_archied/feedback/TEST_FEEDBACK_OUTPUT_DIR_WAVE2.md)、[RTF](_archied/feedback/TEST_FEEDBACK_RTF_TAG.md)、[命名](_archied/feedback/TEST_FEEDBACK_RTF_UNDO_MARKERS.md)、[翻译](_archied/feedback/TEST_FEEDBACK_TRANSLATE_LOCALIZE.md) |
| 新建工程原生保存窗口 | 真实 showSaveFilePicker 系统窗口没有自动化 smoke 证据，需在支持的宿主验证；与原有另存为共用路径。 | [新建工程](_archied/feedback/TEST_FEEDBACK_NEW_PROJECT.md) |
| 2026-10-09 设置 / 标记批次与发布核查 | 相关浏览器项已记录通过，完整 localhost 集成、全量 E2E / CI 并非全部执行；按当前发布范围使用清单，不直接复制其旧 main 状态。 | [设置记录](_archied/feedback/TEST_FEEDBACK_SETTINGS_20261009.md)、[发布清单](_archied/verifications/261009_first-verification/README.md) |

## 未实施方案与需另行决策的范围

- [时间码比较](plans/PLAN_TIMESTAMP_COMPARE.md)：方案保留，未据文档推定已实现。
- [Parakeet 接入调研](plans/Parakeet%20TDT%20日文模型接入调研.md)：尚未完成真实 spike，不代表已经支持。
- [长期重构企划](plans/MAWE%20前端渐进式重构企划案.md)：阶段架构已变化，后续控制器、性能与框架建议需重新按当前 DEVELOPMENT 评估，不按原 Phase 顺序自动开工。
- Qwen 词表管理、MOSS 对齐增强、全仓 strict 类型检查等，均需先核对现有入口和实际需求；历史建议不自动升级为缺陷。

## 已有新证据，避免重复开工

| 旧记录 | 本次代码核对 / 保留边界 |
| --- | --- |
| #185 补丁与 Linux 同族遗漏“未修” | `MAW.spec` 已包含 moss_runtime 与 runtimes/freezer 源文件；测试 ImportFrom 已继续收集别名；`serve.py` 的 open/xdg-open 与 `maw/notify.py` 已调用 restore_host_library_path。无需按 [旧核查](_archied/verifications/261009_first-verification/data/issue185-followup.md) 再写同一补丁；Linux 包内真实下载 / 桌面工具未在本次验证。 |
| 文稿对齐记录的 cueListPatch TS2339 | `web/editor/boot/editor-globals.d.ts` 已声明 cueListPatch；这是源码层的替代证据，不宣称本次运行过 typecheck。 |
| ESM 台账的 MaweSpeakerLabels 缺失 | `tests/test_editor_markers.mjs` 已注入该依赖；不能据旧 450/451 数字认定当前仍失败，本次未跑该测试。 |
| MOSS“英文长句不再细分” | `maw/local_asr.py` 已调用 split_coarse_segments，记录也有后续重切补充；真实 GPU 验收仍见上表。 |
| 性能研究中的 2.5–3 秒巨帧 | 该报告后文已记录优化后约 350ms 一次开销并明确不单独跟进；不把早期“遗留问题”重新列为现存故障。 |
| 旧日志的“待推送 / 待合并 / 重建 HTML” | 只描述当时提交阶段；远端状态须针对对应任务另查，便携产物统一遵循当前发布规则。 |

接手一项时先核对当前代码、对应测试与最新反馈，再设为待处理/进行中；完成后写最短的证据和结论，详细过程放历史分类目录。本清单不覆盖每一种可选平台组合，其他原始验证边界仍保留在来源日志中。

# TEST_FEEDBACK_AI_CLEANUP_MARKERS

任务：AI 口播整理与通用 Marker / Region（见需求描述）。本文件是持久化进度账本，边做边更新。

状态约定：`待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`。

## 事实基线

- `git status --short`：干净（任务开始时无未提交改动）。
- 相关架构事实（探索结论）：
  - 文稿匹配后端：`maw/postprocess_match.py`（`ScriptMatchRequest`、`run_script_match`、`MatchCoverageError` 低重叠拦截）。
  - LLM 供应商：`maw/postprocess_llm.py`（`LlmSettings`、`complete_subtitle_groups`、预设 deepseek/zhipu/qwen/custom）。
  - 工具箱桥接：`maw/gui_web.py` `run_script_match`；前端 `web/launcher/postprocess.js`；工具箱面板 `web/launcher/index.html` `toolboxMatchPanel`。
  - 自动后处理管线：`maw/postprocess_pipeline.py`（`STEP_ORDER` match 首位、`validate_plan`、`_run_step`）；批量模式强制禁用 match。
  - 编辑器波形行 DOM：`web/editor/media/waveform/cue-blocks.js` `createRow`；手势 `input.js`/`cue-drag.js`/`gap-drag.js`。
  - 状态/事务/撤销：`web/editor/state/editor-state.js`、`editor-commands.js`（`MaweCommands.begin/run`）、`editor-history.js`（kind: segments/layout/gap_remove/preview）。
  - 保存/加载：`web/editor/io/editor-json-repair.js` `buildJson`（`CANONICAL_PROJECT_FIELDS`）、`editor-project-load.js` `applyCanonicalProject`。
  - Python 工程规范化：`maw/project.py` `normalize_project`（需确认 markers 字段透传）。
  - 管理窗参考：`web/editor/ui/editor-floating-panel.js` `createFloatingPanel`、`editor-gap-remove-ui.js`。
  - OTIO marker 导出：`web/editor/io/editor-export-timeline.js`（保持独立，不改动语义）。

## 任务清单

### A. 通用 Marker / Region（编辑器 + MOSP）

| # | 事项 | 状态 | 备注 |
|---|---|---|---|
| A1 | `markers` 数据规范化：稳定 ID、整数毫秒 start、可选 end（end>start 为 Region）、name、color、note、可选 review 状态；`maw/project.py` 与编辑器加载规范化 | 已修复 | `web/shared/utils/markers.js`（normalizeMarkers：排序后按时间序补齐/去重 ID）；`web/editor/io/editor-project-load.js` `applyCanonicalProject` 载入规范化；`maw/project.py` 透传待 Phase B 复核 |
| A2 | 编辑器保存 `markers`（`buildJson` / `CANONICAL_PROJECT_FIELDS`）+ 回读 | 已修复 | `buildJson` 经 `markersToProjectField` 输出（空列表不写字段）；`CANONICAL_PROJECT_FIELDS` 已加 `markers`；保存指纹含 `DATA.markers`；回读经 normalizeMarkers |
| A3 | JSON_SCHEMA.md 新增 markers 章节（含 AI 复核字段、gap_remove provenance 新来源层 `ai_cleanup`） | 已修复 | 顶层表格与速查加 `markers`；新增 1.7 节（schema/id/start/end/name/color/note/review）；gap_remove provenance 增补 `ai_cleanup` 层说明 |
| A4 | 每个可见波形行顶部独立标记轨道：Marker 彩色旗标、Region 彩条、跨行连续；基础模式同轨 | 已修复 | `web/editor/media/waveform/markers.js` + `cue-blocks.js createRow` 挂载；`web/waveform.css` 轨道/旗标/彩条/复核脉冲样式；无标记不渲染；待浏览器确认 |
| A5 | 轨道手势：点击定位、添加标记、拖出 Region、移动、拖边界；与字幕/空隙手势分离；跨行拖动按当前行换算、视口边缘滚动、预览裁剪到可见行 | 已修复 | 手势在 `waveform-markers`（阈值 4px、Region 最小 150ms、边缘 36px 自动滚动、rAF 预览）；提交经 options 回调进 `MaweMarkerEditing`；待浏览器确认 |
| A6 | 「标记与区段」管理窗：搜索、过滤（类型/颜色/待复核）、定位试听、重命名、改色（预设+HEX）、备注、时间、删除、确认复核 | 已修复 | `web/editor/markers/editor-markers-panel.js` + 模板面板 DOM + `editor.css` 样式；`createFloatingPanel` 复用（拖动/位置持久化/Esc）；待浏览器确认 |
| A7 | 标记改动进入撤销/重做与保存状态（新增 markers 历史 kind） | 已修复 | history kind `markers` + `pushMarkersUndo`（新状态快照）+ `MaweState.changes.markersDirty` 入 `hasProjectChanges`；自动保存/指纹覆盖 |
| A8 | 复核项定位与确认（管理窗 + 待复核计数显示） | 已修复 | 摘要行含「待复核 N」；徽标 + 轨道脉冲；`confirmReview` / `locateMarker`；波形点击标记即定位 |
| A9 | Node 测试：markers 核心（规范化/过滤/几何换算/跨行时间换算）、语法与装配顺序测试 | 已修复 | `tests/test_editor_markers.mjs` 10 项全过；syntax/order/utils/waveform 共 347 项全过 |

### B. AI 口播整理（Launcher + 后端）

| # | 事项 | 状态 | 备注 |
|---|---|---|---|
| B1 | `maw/postprocess_ai_cleanup.py`：按有效字词构造短片段+临时 ID、文稿行/上下文/字面匹配候选、协议校验、证据检查、信息覆盖检查、写入 disabled+gap_remove、生成复核 markers、统计 | 已修复 | 模块完成：temp ID c001…、仅文本（asrText/scriptLine/前后行/scriptMatch）上行；单调文稿行分配（窗口 4、exact≥0.85/rephrased≥0.5）；本地校验只降级（altTake 相似度≥0.6、evidence 命中原文、流程用语/机械重复模式、数字守卫、唯一文稿行覆盖）；移除写 segments.disabled + gap_remove 新 `ai_cleanup` provenance 层；复核写 markers（#f5a623、review.pending）；LLM 失败/协议无效不写任何产物 |
| B2 | LLM 失败或协议无效：不写出部分成品，报错可重试（原始输入不变） | 已修复 | 协议错误重试 1 次后抛 LlmClientError；测试断言无新文件产出、输入不变 |
| B3 | 输出命名注册 `AI整理` 后缀 + 工具箱/管线集成（新 MOSP，原工程不变） | 已修复 | OPERATION_NAMES.ai_cleanup（zh AI整理/en ai-cleanup）；管线 match 步骤 `aiCleanup` 模式分支（validate/snapshot/_run_step/_pipeline_step_operation）；gui_web `run_ai_cleanup` 桥接；`_subtitle_artifact_result` 透出 stats；launcher_batch 强制 match 禁用自动覆盖 AI 模式 |
| B4 | 工具箱「文稿匹配」面板增加默认关闭「使用 AI 整理」开关；开启时改录音优先策略，不再走文字替换与低重叠拦截 | 已修复 | `postprocessAiCleanup` 复选框（默认关）；开启时隐藏换行来源/断句入口，直接走 run_ai_cleanup；无 MatchCoverageError、无文字替换；待 C2/C3 浏览器验收 |
| B5 | Launcher 单文件转写后自动运行（autoPlan 携带 ai_cleanup）；批量保持禁用 | 已修复 | autoPlanFromControls/applyAutoPostprocessPlan/defaultAutoPlan 携带 `match.aiCleanup`+providerId；autoStepReady 要求供应商就绪；批量由后端禁用 match 时一并禁用 |
| B6 | 统计展示：文稿已对应行/改说/额外保留/自动移除/待复核；有待复核时不得称已人工校对完成 | 已修复 | 工具箱运行后在 `postprocessMatchStats` 显示五项计数+待复核提示（只陈述事实，不宣称人工校对）；自动链运行结果不逐步展示统计（产物 warnings 中含移除/复核计数） |
| B7 | Python 测试：口播样本覆盖重录/局部口误/改说/额外信息/独有数字/缺失文稿行/无有效 items/无效 LLM 响应 | 已修复 | `tests/test_postprocess_ai_cleanup.py` 16 项全过（含 altTake 相似度降级、无 evidence 降级、已有 gap_remove 保留、markers 规范化回读、payload 无时间/路径、协议重试后成功） |

### C. 验收与收尾

| # | 事项 | 状态 | 备注 |
|---|---|---|---|
| C1 | 全量测试：node --test（语法/顺序/utils/domains）+ python unittest + `git diff --check` | 已修复 | 2026-09-30：node 5 文件 347 项全过；python 全量 1733 项通过（8 跳过，与基线一致）；`git diff --check` 干净。过程中发现并修复 1 处契约过期：`test_gui_web` 断言的 `defaultAutoPlan` match 步骤缺 `aiCleanup: false`，已同步更新断言 |
| C2 | 布局验收：管理窗与工具栏新元素实测间距（getComputedStyle ≥ 8px）+ 截图自查 | 已修复 | 实测（getComputedStyle + getBoundingClientRect）：编辑器管理窗 摘要→操作→过滤→列表 均 8px；Launcher 工具箱文稿匹配面板 文稿文件→AI 整理 10px、AI 整理→换行来源 10px、换行来源→Markdown 清理 10px、Markdown 清理→断句提示 8px（顺手修复了断句提示行 0px 间距的存量问题，`#postprocessPunctHint { margin-top: 8px }`）；AI 开启隐藏换行来源/断句提示后与下一元素间距仍 10px。截图：浏览器 webview 宿主不渲染画面（「tab has not painted yet」，已用等待/滚动/缩放/点击/双宿主重试，Code Mode 桌面浏览器未连接），本机环境限制未能截图；全部验收以 DOM snapshot + 实测像素数据完成 |
| C3 | 浏览器手动验证：标记创建/重叠/跨行拖动/边界调整/撤销重做/保存回读/复核确认 | 已修复 | 2026-09-30 收尾：用假 `complete` 无头跑 `run_ai_cleanup` 生成真实产物（重录+试麦移除 2 段、数字守卫降级/疑似误识/缺字词时间 3 条待复核），server-editor 加载验证：3 行轨道 + 3 旗标（pending 样式、按行内位置 10%/30%/60% 正确）、「AI 整理自动移除」空隙块（跨行拆 3 块）、禁用字幕块置灰、管理窗摘要「共 3 项：标记 3 · 区段 0；待复核 3」；确认复核 → 服务器保存回写磁盘 → 刷新页面回读 confirmed 状态全链通过。此过程中发现并修复 1 个真实集成 bug：服务器注入工程 `markers` 保持 MOSP 包装对象，轨道不渲染且首次 `markerList()` 会整体清空——`editor-startup.js` 启动时 `normalizeMarkers` 兜底修复。跨行真实指针拖动仍未模拟（几何换算已有单测覆盖，见 Phase A 记录） |
| C4 | CHANGELOG 条目 + docs/WORKFLOW.md 补充 | 已修复 | CHANGELOG [未发布] 两条 🚀 全新特性（AI 整理 / Marker & Region）；WORKFLOW.md 新增 AI 整理小节、2.5 自动链提及、批量禁用说明 |
| C5 | 不重生成 blank-editor.html（按仓库约定） | 仅说明 | 发布前统一重生成 |

## 阶段汇总

- （开始）基线确认：仓库干净，架构探索完成。
- （Phase A 完成 2026-09-30）markers 数据核 / 波形轨道 / 管理窗 / 撤销与保存接线全部落地：
  - 新文件：`web/shared/utils/markers.js`、`web/editor/media/waveform/markers.js`、`web/editor/markers/editor-marker-editing.js`、`web/editor/markers/editor-markers-panel.js`、`web/editor/markers/editor-wiring-markers.js`、`tests/test_editor_markers.mjs`。
  - 修改：editor-scripts.txt（5 个新模块注册）、editor-template.html（工具栏按钮 + 面板 DOM）、editor-dom.js（元素注册）、waveform.js / cue-blocks.js / editor-waveform-init.js（轨道挂载与回调）、editor-state.js（`markersDirty`）、editor-project-save.js（保存指纹）、editor-json-repair.js（buildJson 输出）、editor-project-load.js（载入规范化）、editor-history.js + shared/utils/history.js（markers 历史 kind）、editor-wiring-export-context.js（canonical 字段）、editor.css / waveform.css（样式）。
  - 验证：`node --test`（syntax/order/utils/waveform/markers）347 项全过；`git diff --check` 干净。
  - 修复过的实现 bug：`shared/utils/markers.js` ID 预收集导致自身 ID 被拒（改为排序后按时间序补齐/去重）；review reason 未去控制字符（统一走 normalizeMarkerText）；`shared/utils/markers.js` 此前未注册进 editor-scripts.txt。
  - 未验证边界：浏览器交互（C2/C3）与 Python 侧文档（A3）待后续阶段；blank-editor.html 按约定不重生成（C5）。
- （Phase B 后端+前端完成 2026-09-30）AI 口播整理落地：
  - 新文件：`maw/postprocess_ai_cleanup.py`、`tests/test_postprocess_ai_cleanup.py`。
  - 后端修改：`maw/postprocess_io.py`（SubtitleArtifact/write_artifacts 可选 stats）、`maw/output_naming.py`（ai_cleanup 命名）、`maw/script_alignment.py`（gap provenance 新来源层 `ai_cleanup`：SOURCES/normalize/from-provenance/decorate/replace 五处）、`maw/postprocess_pipeline.py`（match 步骤 `aiCleanup` 字段：默认计划/normalize/validate 复用 `_llm_provider_error`/snapshot/_run_step 分支 `_run_ai_cleanup_step`/`_pipeline_step_operation` 产物命名）、`maw/gui_web.py`（`run_ai_cleanup` 桥接 + stats 透出）、`tests/test_editor_assets.py`（脚本清单契约补 Phase A 的 6 个新条目）。
  - 前端修改：`web/shared/gap-remove-core.js`（`ai_cleanup` 来源层 4 处构建点 + 展示分类 ai_cleanup/ai_cleanup_manual）、`web/editor/media/waveform/labels.js`（zh/en 显示名）、`web/launcher/index.html`（`postprocessAiCleanup` 复选框 + 字段 id）、`web/launcher/postprocess.js`（runAiCleanup 分支、autoPlan/applyPlan/ready、统计文本、模式显隐）、`web/launcher/launcher.js`（9 个 zh/en 词条）。
  - 验证：新增 16 项 Python 测试全过；Python 全量 1733 项通过；node 347 项通过；`git diff --check` 干净。
  - 关键设计决定：AI 整理实现为 match 步骤的模式开关（非独立管线步骤），批量禁用 match 时自动排除；本地产物命名操作为 `ai_cleanup`；LLM 决策只降级不升级（协议违规→报错重试，语义不安全→转待复核）。
  - 未验证边界：浏览器端工具箱开关交互与统计显示（C2/C3 收尾时验收）；文档（A3/C4）待写。
- （收尾完成 2026-09-30）C1–C5 全部关闭：
  - 无头产物验证：`run_ai_cleanup` + 假 `complete` 生成 `demo AI整理.mosp/.srt`（临时目录，不入库）；统计 matchedLines=3 / rephrased=1 / extrasKept=1 / removed=2 / pendingReview=3 与场景设计一致；SRT 正确排除 2 个已移除段。
  - 修复浏览器验收发现的集成 bug：服务器注入工程的 `markers` 是 MOSP 包装对象（{schema, items}），编辑器内部需要数组——`web/editor/boot/editor-startup.js` 启动序列加入 `normalizeMarkers` 兜底；否则标记轨道不渲染，且首次 `markerList()` 会把包装对象整个清成空数组（数据丢失）。
  - 修复间距存量问题：`#postprocessPunctHint`（紧跟 .field 的 .hint 行）0px 间距 → `margin-top: 8px`（web/launcher/launcher.css）。
  - 契约测试同步：`tests/test_gui_web.py` 的 `defaultAutoPlan` match 步骤断言加 `aiCleanup: false`。
  - 全量验证：node 347 全过；python 1733 全过（8 跳过）；`git diff --check` 干净；触碰文件均 LF。
  - 编辑器端到端：加载 AI 整理产物 → 轨道/旗标/AI 空隙块/禁用块全部正确渲染 → 确认复核 → 服务器保存写盘 → 刷新回读 confirmed。
  - 未验证边界（诚实记录）：① 截图未能完成——Paseo webview 宿主持续「tab has not painted yet」（等待/滚动/缩放/点击/换 tab/Code Mode 桌面浏览器均不可用），本任务所有视觉验收改为 DOM snapshot + getComputedStyle/getBoundingClientRect 实测像素；② 跨行真实指针拖动（cross-row pointer drag）未在浏览器模拟，几何换算由 `tests/test_editor_markers.mjs` 单测覆盖；③ blank-editor.html 按约定未重生成（C5），发布前统一重生成。

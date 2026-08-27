# 断句/标点符号配置统一化（工具箱 → ⚙️ 设置共享配置）

来源：用户 2026-08-27 提议。当前工具箱有「额外断句符号」「保留符号」两个独立 textarea 配置（截图为证）；本地引擎剥尾标点刚实现固定剥 `，。`（见 docs/TEST_FEEDBACK_MOSS.md）。

## 需求（用户原话归纳）

1. 工具箱的「额外断句符号 / 保留符号」统一迁入 ⚙️ 设置，作为**共享配置**：编辑器文稿处理与模型转写后处理同时生效。
2. 工具箱原位置替换为"打开设置并滚动到对应位置"的提示文本（既有先例："在 ⚙️ 设置中下载安装 OCR 支持"）。
3. 默认符号集扩充并明确保留策略：
   - 逗号（，）、句号（。）：断句生效，**不保留**（剥除）
   - 问号（？）、感叹号（！）：断句生效，**保留**在字幕末尾
4. 该共享配置同时约束：Python 转写后处理（local/cloud 剥尾与断句符号集）与编辑器文稿侧断句/保留逻辑。

## 处理清单

| 编号 | 范围 | 需求摘要 | 类型 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 调研 | 前端/后端链路已探明（见事实基线补充） | 调研 | 已修复 |
| 2 | 前端 | 工具箱两个 textarea → ⚙️ 设置新 section（`punctuationSettingsSection`），工具箱原位替换为 `openSettings` 内联链接（复用 OCR 先例）；i18n 中英同步；hint 文案更新 | 修改 | 已修复 |
| 3 | 后端 | `DEFAULT_SPLIT_PUNCTUATION` 扩为 `，。？！, . ? !` + 换行；`prepare_script_text` 校验放行"保留 ∈ 基础断句集"；默认计划 `preservePunctuation=["？","！"]` | 修改 | 已修复 |
| 4 | 后端 | 转写剥尾接入共享配置：`TranscriptionRequest.strip_tail_punct`（gui_web 从已存计划推导 = `，。` − 保留符号），经 `--strip-tail-punct` 下发至 local/qwen/soniox/bcut 四个脚本；空串禁用；`--keep-punct` 优先级不变 | 修改 | 已修复 |
| 5 | 验证 | Python 单测 + node 检查 + 记录回写；Launcher 桌面端交互留待维护者实机确认 | 验证 | 已修复（实机项见未验证边界） |

## 处理结论

- **前端**（web/launcher 三文件，由 visual-engineering 子代理实施、已逐项验收）：
  - 工具箱原 `postprocessMatchSegmentationOptions` 区块替换为 `<p class="hint"><button id="openPunctSettings" class="inline-link" …>`（镜像 OCR 先例，含 `<p class="hint">` 包裹）；
  - 新增 `punctuationSettingsSection`（LLM 与 OCR section 之间）：section 标题「断句与标点」+ 共享说明 hint + 两个 textarea（**ID 与 data-i18n key 原样保留**，`postprocessPreservePunctuationError` 一并随迁），工具箱网格专用 class `match-segmentation-field` 弃用、改用设置页统一的 `.field`；
  - `postprocess.js` 新增 `openPunctSettings` → `window.MAWLauncher.openSettings("punctuationSettingsSection")`；同时移除随 wrapper 消亡的死代码 `renderMatchMode()`（定义 + 两处调用），满足"零孤儿引用"；
  - `launcher.js` 中英 i18n：两条 hint 按共享语义改写，新增 `toolbox_punct_open_settings`、`settings_punctuation_title`、`settings_punctuation_hint` 三组键。
- **后端**：
  - `postprocess_match.py`：基础断句集扩为 `{"，","。","？","！",",",".","?","!","\n"}`；`prepare_script_text` 校验改为"保留 ∈ 额外断句 ∪ 基础集"——默认保留 `？！` 无需用户配置即可通过；
  - `postprocess_pipeline.py`：默认计划 `preservePunctuation=["？","！"]`（仅影响新计划；旧计划显式 `[]` 保持原语义，无强制迁移）；
  - 转写剥尾链路：`gui_web._transcribe_strip_tail_punct(env_path)` 读取已存计划 → `strip = "，。" − 保留符号` → `TranscriptionRequest.strip_tail_punct` → `build_transcribe_command` **恒显式下发** `--strip-tail-punct`（空串=禁用，与 `_append_option` 的跳过语义区分）→ 四个转写脚本（local/qwen/soniox/bcut）新增同名参数（默认 `，。`），剥尾循环改为 `not keep_punct and strip_tail_punct` 双条件，`rstrip` 参数化；`build_local_segments(strip_tail_punct=…)` 贯穿本地引擎。
- **行为变化（预期内）**：新装用户的文稿匹配与转写输出默认保留 `？！` 句尾（此前文稿匹配默认不保留）；`，。` 默认剥除与现状一致。

## 验证记录

1. **Python 单元测试**：`tests.test_postprocess_match / test_postprocess_pipeline / test_gui_workflow / test_gui_web / test_local_asr` 303 项通过；全量 `discover` 791 项，其中本任务新增 5 项（基础集放行、命令恒下发含空串、空串禁用剥尾、默认计划 ？！、派生集随保存计划变化）全部通过；旧契约用例 `test_preserved_punctuation_must_be_declared_as_a_split_symbol` 按新语义改写（改用基础集外符号 `～`）。
2. **前端检查**：`node --check web\launcher\launcher.js`、`web\launcher\postprocess.js` 通过；`node --test tests\test_editor_utils.mjs tests\test_waveform_js.mjs` 215 项通过。
3. **结构与引用核验**（验收复核）：两个 textarea 在 index.html 各仅出现一次（875/880 行）；`renderMatchMode` 与 `postprocessMatchSegmentationOptions` 在 web/ HTML+JS 中零残留；`openPunctSettings` HTML/JS 双端就位；新 i18n 键中英成对（launcher.js 415-416/449-450/479/489）。
4. **`git diff --check`**：通过。
5. **blank-editor.html**：无需再生成（Launcher 文件不经 edit.py 内联）。

## 未验证边界 / 待办

- **Launcher 桌面端实机交互**（打开设置→滚动到新 section→编辑符号→持久化回读）需要 pywebview 宿主，本机未实机点击；接线与已验证的 `openOcrSettings` 路径完全同构，持久化/消费代码路径零改动，风险低。
- `web/launcher/launcher.css` 中 `.match-segmentation-options` / `.match-segmentation-field` 样式规则成为孤儿（该文件在本次任务范围外，未清理；无行为影响，可后续顺手删）。
- 全量测试中出现 1 项**与本任务无关**的失败：`test_packaging_contract.test_moss_cpu_requirements_variant_pins_match_gpu_variant`——属于并行任务的打包 WIP（`tests/test_packaging_contract.py` 修改 + `moss-cpu-requirements.in` 新增均非本任务产物，该测试在本任务上一轮全量 790 绿时尚不存在），不由本任务修复。

## 边界说明（方案取舍）

- **额外断句符号不接入 ASR 切句管线**：转写切句仍由模型分段 + 既有 STRONG/WEAK 标点逻辑决定；共享到转写后处理的是"保留符号 → 剥尾候选集（固定 `，。`）减法"推导出的剥除集。这样默认行为（逗号句号剥、问号感叹号留）与现网一致，且不会为个别符号去改动 jieba/词性切分深层逻辑。
- **已保存的旧计划不强制迁移**：normalize 仅在键缺失时用新默认 `["？","！"]`；旧计划显式 `[]` 保持原语义（文稿匹配不保留、转写剥 `，。`），与今日行为一致。
- **工具箱配置本就在 Launcher 后端持久化**（`maw-postprocess.json`，经 `save_postprocess_plan` 桥），迁移仅动 UI 位置与 ID 不变，持久化/消费代码零改动。
- MAWE 编辑器（`web/editor.js`，localStorage `moy.asr.editor.settings.v1`）与此配置无关，不涉及 server-editor。

## 事实基线

- 开始时工作区含本会话此前任务的未提交改动（maw/local_asr.py 等 5 文件）与其他任务的 WIP；本任务新增改动不得回滚他人内容。
- `_strip_trailing_punct` 当前固定 `，。`，与云端 `rstrip("，。")` 一致；`！？` 保留。
- 工具箱截图显示：保留符号 textarea 预填 `？ ！ ～`；断句符号 hint 写明"默认逗号、句号和换行仍然生效"。
- 待探索结果补充：前端持久化键、消费函数、设置页架构、OCR 提示模式、后端配置存储候选。

## 探索结论（补充事实基线）

- 工具箱两个 textarea 位于 **Launcher**（`web/launcher/index.html:575-583` 原位），持久化走 `save_postprocess_plan` 桥 → `maw-postprocess.json`（`.env` 同目录）计划 `match` 步骤的 `extraSplitPunctuation` / `preservePunctuation` 数组；前端消费点在 `postprocess.js`（`punctuationLines` / 校验 / 预览 / 运行 / 回填，全部按 ID 取值）。
- ⚙️ 设置模态为 `#settingsModal` + `.settings-scroll` 内若干 `.settings-section`；"打开设置并滚动"先例为 `openOcrSettings` → `window.MAWLauncher.openSettings("ocrSettingsSection")`。
- Python 侧符号集原本四处独立定义：`generate_subtitle_qwen_api.py:615-616`（STRONG/WEAK，函数内局部）、`maw/local_asr.py` `_LOCAL_TAIL_PUNCT`、`scripts/mosp_match_text.py:22-24`、`maw/postprocess_match.py:29`；本次仅统一"保留符号 → 转写剥尾集"推导，切句内部逻辑不动。
- server-editor 的设置存储为固定 schema（工作区/最近工程），无通用任意配置端点；本配置不经过它。

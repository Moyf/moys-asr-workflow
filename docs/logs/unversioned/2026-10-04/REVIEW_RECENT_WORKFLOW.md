# 近期更新整体审查（2026-10-04）

范围：2026-09-25 编辑器分域拆分以来至 main `d9f2e9be`。用户确认此范围，并授权改善实际缺漏和相关架构设计、创建新 PR。开始时工作区干净，HEAD 与 origin/main 一致；现有未合并 PR 不纳入本轮实现。

审查以当前源码、历史差异和实际验证为准；已有发布/PR 审查报告仅用于定位已处理问题与验证边界。本轮重点检查功能组合使用后的编辑、撤销、保存重开和导出一致性。不会为风格偏好扩大修改。

| 状态 | 项目 | 决定与证据 |
| --- | --- | --- |
| 已修复 | AI 整理与已绑定双语轨 | 原实现新增回归在双语显示开启/关闭两种情况均失败：被移除主字幕的绑定译文未禁用。`maw/postprocess_ai_cleanup.py` 仅同步本轮 discard 对应的绑定译文；保留独立副轨、既有禁用状态、复核字幕、绑定及源文件。AI 与自动后处理单测 65 项通过；实际整理产物在 localhost 浏览器显示与双语 SRT 验证一致。 |
| 已修复 | 叠加轨禁用与主副绑定 | Chromium 原实现回归复现：禁用 overlay[0] 误禁用 main[0] 的绑定译文。绑定同步现在明确仅由主轨触发。新增三轨组合验证禁用、启用、撤销、重做和双语 SRT；叠加轨两项专项通过，主字幕驱动副字幕的契约保留。 |
| 已修复 | 拆分/保存的说话人元数据 | Chromium 原实现三路径回归均失败：timed 在拆分时丢失 speaker，untimed/linked 在保存时丢失。两类拆分共用 createSplitSegments，保留源段元数据和右段颜色/贴纸引用；保存主/副/叠加字幕时保留已有 speaker 字段。三个专项通过，包含渐进拆分、撤销/重做、Server 保存数据与便携编辑器实际拖入重开。未变更现有 schema。 |
| 仅说明 | 脚本装配与状态重构 | 领域模块、classic script 装配及事务入口职责合理；继续用现有装配/事务回归验证，不启动 ESM 或大规模改名。 |
| 已修复 | 浏览器回归的导入等待 | 联合回归首次 274/275 通过；手工字幕复制拆分用例在异步导入完成前调用 openMainWaveformSplitModal，失败发生在段构造前。用源字幕实际呈现作为等待条件，保留原全部行为断言；连续 5/5 通过。没有为此改变产品行为。 |
| 仅说明 | ASS / 双语 / 特殊格式 / LRC | 即时预览与实际帧、样式与导出沿用共享规则，实际帧请求有串行/快照失效和本机令牌边界；双语 SRT 按两轨时间边界合成，不强制改写原轨。LRC 的近似段级时间不冒充精确 items，新拆分复制的前缀也清理不可靠 items。相关浏览器和 Node 回归通过，无证据支持本轮重做设计。 |
| 仅说明 | 标记、区段与去空隙 | 标记是源媒体时间坐标下的独立注释，可保存、复核和随 OTIO 导出；去空隙保留来源层与可逆性。手动验证已有人工区段与新增 AI 复核标记共存，点击复核项定位到 6 秒，双语 SRT 保留独立叠加内容并过滤移除段的主/副字幕。合成音频无真实口播听感验收。 |
| 仅说明 | 转写与后处理配置 | 核对 Launcher/CLI 的断句与保留符号接线，以及普通处理、严格翻译和 atoms/cues 重分句失败批恢复；既有测试覆盖全失败不写出、协议/鉴权错误中止和失败批元数据保留。本轮没有发现另一个配置源或需要改变的失败策略。 |
| 仅说明 | 本地模型与平台边界 | 准备、已安装检测与加载复用缓存发现逻辑，ModelScope 无法保持 HF commit pin 的限制已有明示；取消仍由准备子进程处理。macOS Qwen MPS 显式选择策略合理。源码与 mock/契约测试已检查，不将它们当作真实下载或推理验收。 |

## 验证账本

- 修复前：Node 443/443；Python 1793 项，1766 通过 / 27 跳过。首轮 Node 缺少 acorn / magic-string，属于借用依赖目录不完整；随后在临时目录按当前 package-lock 安装依赖，不修改共享依赖或锁文件。
- 修复后：`node --test tests/test_*.mjs` 443/443；`python -m unittest discover -s tests -p 'test_*.py'` 1794 项，1767 通过 / 27 跳过。跳过项包括本机未安装的可选依赖和平台能力，不记为通过。
- AI 专项：`python -m unittest tests.test_postprocess_ai_cleanup tests.test_postprocess_pipeline` 65 项通过。
- `tsc -p tsconfig.typecheck.json`、`python -m ruff check .`、`git diff --check`、`python scripts/sync_launcher_version.py --check` 通过。
- 真实 libass 像素专项：`python -m unittest tests.test_local_editor_server.LocalEditorServerTests.test_ass_frame_render_uses_real_libass_when_available` 1/1 通过。
- Chromium 联合覆盖 275 个不同用例：首轮 274/275，补齐异步导入等待后唯一失败用例连续 5/5 通过。覆盖 editor-text-tools、multi-subtitle、overlay-track、editor-transactions、editor-i18n-save、ass-export、ass-frame-preview、otio-export、split-word-gap、split-desynced-items、keyboard-timing、waveform-history；不是宣称全仓库浏览器用例同次全绿。
- 手动 `python server-editor/serve.py --blank --no-open --no-waveform --port 0`，仅监听 127.0.0.1；使用 agent-browser 打开合成 AI 整理产物及音频，检查三轨状态、双语 SRT、标记/区段共存、点击定位并截图自查。截图与媒体在临时目录，未入库；检查后关闭浏览器和服务器。

浏览器命令采用 `MAW_E2E_PYTHON` 指定已有开发环境，`playwright test <以上 spec> --project=chromium --workers=2 --reporter=line`；异步导入用例用 `-g 'can split a hand-created subtitle' --repeat-each=5` 复验。新增四个浏览器回归和一个 Python 回归均先在原实现复现实际缺漏。

结论：整体分域、状态/事务和宿主隔离的方向合理；本轮只收敛导致元数据丢失的两套段构造逻辑，补齐三个功能衔接问题与一个验证时序缺口。没有待处理、进行中或阻塞的实现项；未验证边界如下。远端 PR 与 CI 状态以创建后的实时结果为准。

边界：不调用真实 ASR/LLM、不下载模型，不替代 macOS/Linux 字体、真实录音听感和性能验收。内联副本待发布前统一重生成，本轮不更新 blank-editor.html。

用户随后授权将粗剪技能中的信息覆盖保护、跨批上下文、第二道通读以及 `[AI]` 注释/筛选批量删除补充到同一 PR；此增量的实施、成本估算与最新验证以 [AI 整理复查任务记录](TEST_FEEDBACK_AI_CLEANUP_REVIEW.md) 为准，上述计数属于最初整体审查阶段。

PR 审阅评论指出主副轨交换元数据与副轨拆分颜色引用的既有遗漏；两项均已复现并补齐，后续验证与远端状态见 [PR 评论修复记录](TEST_FEEDBACK_PR170_COMMENTS.md)。

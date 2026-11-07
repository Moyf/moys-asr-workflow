# Greptile #347 修复台账（编辑器 AI 辅助第一期）

来源：Greptile 对 PR #347 打了 9 条 findings（8×P1 + 1×P2），Hermes 逐条评估全部成立。
推进方式：按组修复，每组一个 commit；先写失败测试再修（回归语义）。

状态只允许：待处理 / 进行中 / 已修复 / 仅说明 / 阻塞。

## A 组·前端契约与状态机（commit 1）

| # | 位置 | 问题 | 状态 | 修法 |
| --- | --- | --- | --- | --- |
| 1 | serve.py:3945 | /api/ai/task 成功返回裸快照，前端 begin() 期望 `{ok,task}` 包络，提交必报「提交 AI 任务失败（HTTP 200）」 | 已修复 | 服务端包 `{ok:true, task}` 包络；handler 契约测试改为断言包络（旧实现下必红）+ 新增前端 mock 契约测试 |
| 2 | text-tasks.js:251 | 未开双语时 track 为 null 直接跳过全部译文，ensureMultiSubtitleReady 永不执行 | 已修复 | create 行不再依赖 track；命令内建轨并启用。顺带修正 v2 幽灵字段 `multi.enabled`（v2 双语开关 = 活动副轨 track.enabled，bilingual.enabled 是 v1.5 遗留且被校验拒绝） |
| 3 | text-tasks.js:222 | 1→N 分组绑定被判 null → 新建译文 + addSubtitleBinding 拆掉原整组绑定 | 已修复 | 按真实 v2 绑定形状判定（同源多条绑定 = 分组，`extension_segment_ids` 是 v1.5 迁移前字段恒为空）；分组跳过并计入提示 |
| 4 | text-tasks.js:168 | 回写按旧下标+文本，删行后同文字幕错位收结果；切工程可能写错工程 | 已修复 | 主字幕按稳定 id 定位（无 id 段按下标+指纹兜底）；提交时快照 bindingGeneration/sourceMediaId，完成时不一致即丢弃并提示 |
| 5 | text-tasks.js:280 | 只快照主字幕，人工译过的副字幕被直接覆盖 | 已修复 | 提交时快照单绑定副字幕 id+文本（cue.extension）；回写前重新判定绑定并核对快照，不一致按「副字幕被修改」跳过并计入提示 |
| 6 | ai-tasks.js:167 | tick() await 后不核对 active===current，迟到旧响应会结束新任务 | 已修复 | 成功/异常分支处理响应前核对 `active === current && !settled`；cancelCurrent 迟到响应同样加守卫 |

## B 组·Python 架构（commit 2）

| # | 位置 | 问题 | 状态 | 修法 |
| --- | --- | --- | --- | --- |
| 7 | editor_ai.py:497 | 发布包编辑器进程直接 import align_project（torch 依赖不在编辑器环境），导入即失败 | 已修复 | run_timecode_alignment 改走 run_timestamp_alignment_in_runtime：临时工程经 import_project 迁 v2 落盘（cue id 保留、语言写主轨），serve 进程只做转发/进度转发/结果抽取；LocalRuntimeError/Cancelled 映射为 AiTaskError；409 绑定守卫（_inject_timecode_media）与进度事件格式不变 |

## C 组·安全与杂项（commit 3）

| # | 位置 | 问题 | 状态 | 修法 |
| --- | --- | --- | --- | --- |
| 8 | settings.js:113 | 切换供应商不清空密钥输入，A 的密钥可被保存进 B | 已修复 | applyProviderSelection 开头 clearApiKeyInput()（fillSettingsPanel 与保存后刷新同路径，保存流程先读后清不受影响）|
| 9 | CHANGELOG | 2.0dev 未发布区缺「编辑器 AI 辅助（第一期）」条目 | 已修复 | ✨ 提升 小节补条目（设置区/右键菜单任务/后台进度浮条/回写可撤销/时间码走独立运行环境），含总开关默认关闭说明 |

## 验证记录

### A 组（commit 前，全部实跑）

- `node --test tests/test_editor_ai_tasks.mjs`：7/7 通过。修复前红相：#2/#3/#4×2/#5/#6 六条红（先红后绿），#1 契约钉为绿（前端本就解析包络；#1 的红由 Python 契约测试承担——旧 serve 行为下 `payload["ok"]` 不存在必红）
- `node --test tests/test_editor_utils.mjs`：353/353（i18n 单测含 AI 分段规则）
- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs`：2/2
- `python3 scripts/run_check.py --timeout 180 -- .venv/bin/python -m unittest tests.test_editor_ai`：30/30（含改后的提交包络契约测试）
- `node scripts/build-editor.mjs --write` 重建 bundle；`pnpm run check:editor` / `pnpm run typecheck` / `pnpm run build` 全过
- e2e `editor-i18n-save.spec.mjs`（chromium）：17/17（新增动态文案均有 EN 规则；退役「当前没有副字幕轨，需重试」规则同步删除，无引用残留）

（B/C 组 commit 前回填）

### B 组（commit 前，全部实跑）

- 先红后绿：改写后的 `test_timecode_alignment_forwards_to_local_runtime`（旧实现下命中「不得在编辑器进程内调用 align_project」断言）与 `test_timecode_alignment_surfaces_runtime_errors_and_cancel`（旧实现抛 TimestampAlignmentError 非 AiTaskError）修复前均红，修复后绿
- `python3 scripts/run_check.py --timeout 180 -- .venv/bin/python -m unittest tests.test_editor_ai`：31/31
- `python3 scripts/run_check.py --timeout 300 -- .venv/bin/python -m unittest tests.test_timestamp_alignment tests.test_server_align`：23/23（对齐模块本体与 server 对齐端点回归）
- `uv run --no-sync ruff check maw/editor_ai.py tests/test_editor_ai.py server-editor/serve.py`：通过
- 未验证边界：真实发布包运行环境子进程链路（torch/qwen_asr 安装环境）只能维护者实机验收；本地已验证到转发契约与错误映射层

### C 组（commit 前，全部实跑）

- 先红后绿：`切换供应商时清空未提交的密钥输入（#8）` 修复前红（keyInput 残留 A 的密钥、readFormValues.apiKey 非 null），修复后绿；夹具为 settings 模块补装元素桩（elements 注入 document.getElementById）
- `node --test tests/test_editor_ai_tasks.mjs`：8/8
- `node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs`：2/2
- `node scripts/build-editor.mjs --write` 重建 bundle；`pnpm run check:editor` / `pnpm run typecheck` 全过
- e2e `editor-i18n-save.spec.mjs`（chromium）：17/17

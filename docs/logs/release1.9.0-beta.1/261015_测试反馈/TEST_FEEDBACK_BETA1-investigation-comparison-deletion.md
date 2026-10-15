# 子代理调查报告：多步骤自动后处理后对比页丢失（#1）

只读子代理调查（2026-10-15），主会话抽查核对（三个翻译包装 `SubtitleArtifact(...)` 均未透传
`comparison_path`——与全仓 grep 结果一致；`_copy_atomic` 为 `shutil.copyfile` + `os.replace`
真复制、run 目录源文件留到 rmtree）后并入账本。file:line 以核对时 HEAD `1d961b90` 为准。

## 1. 各 AI 步骤对比页的 `output_directory` 实际是「后处理运行目录」（先写在 run 目录内）

每个步骤都由 `_run_step(..., output_directory=run_directory, ...)` 驱动
（`maw/postprocess_pipeline.py:754-766`），`run_directory` 来自 `:677` 的 `_create_run_directory`。各步骤链路：

- **cleanup**：`pipeline:999-1010` → `_run_ai_cleanup_step`（`:1144-1187`）→
  `run_ai_cleanup(AiCleanupRequest(output_directory=output_directory,
  generate_comparison=bool(step.get("generateComparison"))))`（`:1177-1187`）→
  `write_artifacts(..., output_directory=request.output_directory, comparison_source=original_project ...)`
  （`maw/postprocess_ai_cleanup.py:383-396`，`comparison_source` 在 `:394`）。
- **proofread**：`pipeline:1109-1141` → `run_llm_postprocess(..., output_directory=output_directory,
  generate_comparison=...)`（`:1130-1141`）→ 非 resegment 分支
  `_write(..., comparison_source=project if request.generate_comparison else None)`
  （`maw/postprocess.py:472-484`，`:481`）。
- **resegment**：`run_llm_postprocess` 在 `maw/postprocess.py:273-275` 提前委托 `run_resegment`，
  其 `_write(..., comparison_source=project if request.generate_comparison else None)`
  （`maw/postprocess_resegment.py:623-633`，`:632`），返回值就是 `_write(...)` 的结果，
  `comparison_path` 会回流。

三者最终都经 `write_artifacts` →
`comparison_path = _available_output(base, f"{operation}-comparison", ".html", output_directory=output_directory)`
（`maw/postprocess_io.py:147`）并以 `_atomic_write` 落盘（`:156-157`）。
`base` = 该步骤的输入工程路径（`postprocess_io.py:141`；`_load_input` 返回 resolve 后的输入路径，
`maw/postprocess_match.py:893-900`）。

**结论：对比页先写入后处理运行目录内**（`<媒体目录>/_maw/后处理/<stem>-<时间戳>/`，见第 2 节），
文件名形如 `<输入stem>.ai-cleanup-comparison.html`（第 1 步）或
`<stem>.后处理.<n>.<本地化label>.<op>-comparison.html`（后续步骤）。**不在工程目录**——
工程目录里的副本是随后搬运出去的（第 2、3 节）。

## 2. `project_path` 的取值与「对比页曾在后处理文件夹」的解释

- GUI 自动链唯一首次调用：`run_postprocess_pipeline(..., project_path=result.json_path, ...)`
  （`maw/gui_web.py:3232-3243`）。重试链传原始工程：`gui_web.py:3399-3413`
  （`sourceProjectPath` 记录于 `:3265`，仍是 `result.json_path`）。
- `result.json_path = build_output_paths(srt, media).json = srt.with_suffix(".mosp")`
  （`maw/gui_workflow.py:170-181`），即**转写输出 SRT 同目录的工程文件**。默认输出位置由
  `default_srt_path` 决定（`gui_workflow.py:258-285`）：默认媒体旁；勾选「将所有输出放入子文件夹」
  时落入 `maw_root(media)` = `<媒体>/_maw`（或每视频 `<stem>_maw`，`maw/output_naming.py:138-145, 281-284`）。
- run 目录：`_create_run_directory`（`pipeline:1474-1488`）→ `postprocess_workspace(media)` =
  `maw_root(media)/后处理`（`output_naming.py:266-271`）→ `<媒体目录>/_maw/后处理/<stem>-<时间戳>`。

**`project_path.parent` 何时会等于 run 目录 / 后处理根目录：正常流程下不可能。**
转写工程永远在转写输出目录，run 目录是运行时带时间戳新建的；重试链传的也是原始工程。
唯一途径是用户手动把输出 SRT 指进 `_maw/后处理/…`——即便如此对比页会落在**后处理根目录**，
且 `:955` 的 `run_directory.parent.rmdir()` 只删**空**目录（OSError 被吞，`:954-957`），副本仍会幸存。

**维护者观察的解释**：对比页的「出生地 + 可见地」就是后处理文件夹内的 run 目录（第 1 节）；
Launcher 的「打开后处理文件夹」按钮打开的正是 run 目录（`gui_web.py:3053-3061`
`open_postprocess_folder` → `postprocess_workspace_directory`，赋值点 `:3316/:3464/:3504`）。
处理过程中每步完成时对比页先出现在那里 → 「处理过程中对比页都出现了（在后处理文件夹）」✓。
retain 关闭时 `:951` `shutil.rmtree(run_directory)` 把**整个 run 目录连同全部初始副本**删掉 →
「在后处理文件夹整个被删」✓。幸存副本在**另一个目录**（转写输出目录；开输出子文件夹时是
`_maw/`——更难被注意到），文件名为 `<原工程stem>.<op>-comparison.html`，唯一的指路信息是
每步的 warning「处理前后对比：{destination}」（`pipeline:880`）。

## 3. 多步骤时的覆盖 / 删除可能性

**a. 各步骤最终文件名不会同名。** `_pipeline_step_operation`（`pipeline:529-545`）：
cleanup → `"ai_cleanup"`、proofread → `"proofread"`、resegment → `"resegment"`、
translate → `"translate-{target}"`、match(+aiCleanup) → `"ai_cleanup"`。zh 本地名
（`output_naming.py:44-57`）：AI整理 / 校对文本 / 重新断句——但目标文件名 token 由
`_operation_file_token` 决定（`postprocess_io.py:244-268`）：`ai_cleanup-comparison` /
`proofread-comparison` / `resegment-comparison` 都不在 `OPERATION_NAMES` → 走 legacy ASCII
清洗（`:268`，`_`→`-`）→ `ai-cleanup-comparison` / `proofread-comparison` / `resegment-comparison`，
**互不相同**（zh 本地名只出现在 run 目录内编号产物名，`pipeline:502-514`）。
即便 match+aiCleanup 与 cleanup 同时启用（两步 op 同为 `ai_cleanup`），第二步
`_available_output` 的存在性循环会给出 `-2` 后缀（`postprocess_io.py:237-240`），是新增不是覆盖。

**b. 覆盖窗口。** `_relocate_pipeline_artifact`（`pipeline:572-582`）：`source==target` 早退
（仅当工程就在 run 目录，正常不发生）；同目录 `source.replace(target)`；跨目录 `_copy_atomic`
（`pipeline:1533-1545`，`os.replace` 会覆盖已存在目标）。两处的目标都来自 `_available_output`
的「当时不存在」保证（`postprocess_io.py:233-241`；`pipeline:878` 不传 `output_directory` →
目录 = `project_path.parent`），单线程流水线内无 TOCTOU。
**关键细节：跨目录分支是 COPY 不是 MOVE——run 目录里的原始副本会留到 rmtree 才被删**
（设计如此：副本在工程目录）。

**c. 后续步骤不会把已搬运的对比页当输入/中间产物。** 步骤输入只有 `current_project/current_srt`
（`pipeline:867-868`）；`comparison_source` 是内存中的 project dict（`postprocess.py:481`、
`postprocess_ai_cleanup.py:394`、`postprocess_resegment.py:632`）；`_number_pipeline_artifact`
只搬 project/srt 两个路径（`pipeline:594, 606-607`），`comparison_path` 不进编号链。

**d. `_publish_final` 不删不覆盖**（`pipeline:1491-1529`）：只 `_copy_atomic` 到 while 循环
保证不存在的新路径（`:1511-1523`）。

**e. rmtree 的实际删除范围 vs 对比页落点。** `shutil.rmtree(run_directory)`（`:951`，
仅成功路径；失败/取消走 `:959-980` 不删）会删掉仍在 run 目录里的一切：
- 每步的 run 目录**原始副本**（因 b 的 COPY 语义）——设计内，副本已在工程目录；
- **translate 步骤的对比页：整体丢失（确证的代码缺陷）**。translate 分支在 `pipeline:787-843`
  用 `_merge_bilingual_subtitles` / `_embed_translated_subtitles` / `_attach_translation_track`
  的返回值**替换** artifact，而这三者返回的新 `SubtitleArtifact` **都没有传 `comparison_path`**
  （`pipeline:1373-1380、1420-1426、1464-1470`）→ `:876` `getattr` 得 None → 不搬运 →
  该页只存在于 run 目录（由 `postprocess.py:481-482` 写出，translate 的 plan 字段含
  `generateComparison`，`pipeline:104`）→ 被 rmtree 删除，且 manifest 也不记 `comparisonPath`
  （`:881` 只在搬运分支执行）。
- cleanup/proofread/resegment 的对比页在成功 run 中**必然**有工程目录副本：搬运若抛 OSError
  会被 `@intermediate_file_operation` 包成 `IntermediateFileError` → `PostprocessPipelineError`
  （`pipeline:853-865`），**不会走到 rmtree**。「中间 AI 步骤（cleanup/proofread/resegment）
  的对比页只留在 run 目录」的路径**未找到**。

## 4. Launcher JS / 后端没有独立的清理逻辑

- 全仓 `.py` 的 `rmtree/unlink/os.remove/send2trash` 盘点：流水线路径上只有 `pipeline:951`
  （rmtree run 目录）；`maw/launcher_batch.py:142-148` 的 srt_only 只删最终 json/html；
  `gui_web.py:1818/1826/1884` 的 `send2trash` 全部是 ASR 预设管理；其余是临时文件 `.tmp`
  清理（各写入函数内部）。
- `web/launcher/**`：`comparison/对比/删除/清理` 的命中只有 i18n 文案、`classList.remove`、
  预设删除按钮（`web/launcher/postprocess.js:1517/1570/1593/1630` 只展示/打开 `comparisonPath`；
  `web/launcher/presets/launcher-presets.js:307`、`launcher-strings.js:92/107/109` 是预设删除）。
- 结论：**不存在会把工程目录下 `*-comparison.html` 一起清掉的第二套清理逻辑**。
  删除只能来自 `pipeline:951`。

## 5. 最可能的根因与修复方向

**行为层（同时解释三个观察）**：对比页「出生 + 被看到」在后处理 run 目录（Q1），「幸存」在
转写输出目录且换了一套 ASCII 名字（Q2）；retain 关闭后成功收尾 rmtree 整个 run 目录
（`pipeline:950-957`），维护者盯着的后处理文件夹里所有对比页随之消失。开启「输出子文件夹」时
幸存地是 `_maw/`（`gui_workflow.py:281-282`），极易被当成「被删了」。「多步骤才暴露」是因为
单步測試 `tests/test_postprocess_pipeline.py:74-93` 恰好把「副本在工程目录、run 目录删掉」
定为预期并守护（`:88-91`），而多步骤时副本数量多、错位感强，且没有等价的多步骤用例。

**代码层真缺陷（多 AI 步骤链确实会永久丢一张对比页）**：若勾选的 AI 步骤包含**翻译**，
translate 的 `comparison_path` 在双语合一/回填/副轨包装时被丢弃
（`pipeline:1373-1380/1420-1426/1464-1470` 未透传），其对比页只存在于 run 目录并被 rmtree
删除——这是代码可证的「对比页真的没了」，且 manifest 无记录。

**修复方向**：
1. 三个翻译包装函数透传 `translated_artifact.comparison_path`（或返回带 `comparison_path`
   的 artifact），让 translate 对比页走 `pipeline:876-881` 既有搬运机制；
2. 体验层：retain 关闭时将对比页**移动**（而非复制后留 run 目录副本等删），或在 `done` 事件/
   日志中集中列出全部对比页最终路径；`open_postprocess_folder` 在 run 目录已删除时回退打开
   幸存副本目录（`gui_web.py:3053-3061`）；
3. 补多步骤（cleanup+proofread+resegment+translate）+ retain=False 的对比页存活性单测，
   专锁 translate 丢弃缺陷。

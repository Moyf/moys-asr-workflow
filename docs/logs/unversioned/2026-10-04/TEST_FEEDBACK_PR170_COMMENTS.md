# PR #170 评论修复（2026-10-04）

用户授权：检查 PR 评论并修复，继续推送到现有 PR；不合并、不发布。

基线：`aa2e7a83`，`fix/recent-workflow-consistency`；工作区与暂存区干净。读取全部 issue comments、reviews 和 reviewThreads，只有维护者审阅评论提出两项代码问题；无 inline review 线程。构建通知与 Greptile 试用到期属于仅说明，不需要代码变更。

反馈来源：https://github.com/Moyf/moys-asr-workflow/pull/170#issuecomment-5976796626

| 编号 | 事项 | 状态 | 决定、证据及边界 |
| --- | --- | --- | --- |
| A | 主副轨交换保留 speaker / disabled | 已修复 | 段转换保留 speaker 和布尔 disabled（含 false）；新增 Node 1/1、Chromium 1/1，原实现均先失败，修复后交换一次/两次、实际 Server 保存重开及两轨 SRT 通过。 |
| B | 副轨独立/联动拆分维护颜色组引用 | 已修复 | 删除默认 headIndex=0，各入口传入实际轨道下标；统一拆分插入与颜色/表情包引用重映射。独立/联动 × head/member 4 项均在原实现失败，修复后新增 spec 5/5，Server 保存重开、撤销重做通过；类型检查通过。 |
| C | 构建通知与 Greptile 试用提示 | 仅说明 | 不影响代码，不进行订阅或配置操作。 |

## 阶段记录

- 开始：核对本地与 PR head 一致，保留上一轮实现与验收记录；本轮不生成 `blank-editor.html`。
- A 完成：修改 `web/shared/utils/multi-subtitle.js`，新增 `tests/test_multi_subtitle_metadata.mjs` 与 `tests/e2e/multi-subtitle-metadata.spec.mjs`。`node --test tests/test_multi_subtitle_metadata.mjs` 1/1；Chromium 同名 spec 1/1，实际 `/api/project` 写盘与 reload 成功。
- B 完成：`web/editor/cues/editor-split-core.js` 提供共用 `replaceSegmentWithSplit`，主轨列表/弹窗、副轨独立/联动与叠加轨入口统一维护所属数组引用，后者由 `editor-wiring-overlay-split-merge.js` 调用；联动测试刻意使用主轨 index 0 / 副轨 index 1 或 3。新增 spec 5/5，`npm run typecheck`、`git diff --check` 通过。
- A/B 阶段汇总：两项反馈均复现并修复，准备全量单元测试、受影响浏览器联合回归与手动验收；本轮没有增加工程字段或调整布局。
- 联合验证：Node 全量 `node --test tests/test_*.mjs` 444/444；Python 全量 `python -m unittest discover -s tests -p 'test_*.py'` 1807 项（1780 通过、27 跳过）；Chromium `multi-subtitle-metadata`、`multi-subtitle`、`editor-text-tools`、`overlay-track` 4 个 spec 联合 141/141。`npm run typecheck`、全仓 Ruff、`scripts/sync_launcher_version.py --check` 和 `git diff --check` 通过。首次误调用不存在的版本脚本，没有改动产物，已改用仓库实际提供的版本检查命令。
- 手动验收：隔离设置启动 `server-editor/serve.py --blank --no-open --no-waveform --port 0`，仅监听 localhost；agent-browser 打开合成工程与 WAV，实际点击交换一次/两次、拆分确认、撤销与重做。主/副 speaker 与 disabled 保留，SRT 排除禁用段；红色右段指向 head 1，蓝色后续引用指向 head 3，紫色引用指向 head 5。截图已查看，浏览器与服务器已关闭；媒体和截图仅位于临时目录。

## 未验证边界

两项代码问题均已修复，没有待处理、进行中或阻塞的实现项；其余评论仅说明。未调用真实 ASR/LLM，不替代真实录音切口听感或跨平台字体验收。Python 27 个可选/平台测试跳过，没有算作通过。内联副本待发布前统一重生成；提交推送后的最新 CI 以 PR 实时状态为准。

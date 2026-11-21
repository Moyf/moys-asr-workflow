# 清理撤销／重做后的字幕预览

基线：`test/2dev-playwright-discovery@bb239968`（工作树干净）；反馈复现基线为 `58b408e4`。状态：待处理／进行中／已修复／仅说明／阻塞。

| # | 问题 | 状态 | 核实结论／方案 |
| --- | --- | --- | --- |
| 1 | 暂停时恢复清理范围，撤销或重做后字幕未更新；迟到的媒体事件可能掩盖问题。 | 已修复 | `editor-history.js` 的 `gap_remove` 分支恢复数据、更新空隙界面后，主动刷新当前播放头的字幕预览。 |

## 历史核对

- PR #404 的 `e641c371` 把预览刷新与多份 v2 浏览器测试改动放在同一提交中；被回滚的原实施记录明确记载 `S3-T05` 修复前失败、加刷新后通过。
- `8b0d74ce` 整体回滚九个文件，提交正文及公开审查未指出预览刷新存在缺陷。紧随其后的 `f7a5a67d` 收窄 G12 机械迁移的辅助选测；这是范围调整的上下文，不是回滚动机的确证。本次不恢复其他被回滚的改动。

## 当前远端证据

- #412 `bb239968` 的 [辅助分片 1/2](https://github.com/Moyf/moys-asr-workflow/actions/runs/44877951799/job/136766811247) 仍在 `S3-T05` 的撤销后字幕文本断言失败；[分片 2/2](https://github.com/Moyf/moys-asr-workflow/actions/runs/44877951799/job/136766811287) 另有 `timed-text-edit` 搜索焦点断言失败，不在本次修复范围。

## 验证

- `S3-T05` 保留原文本断言，并在撤销／重做的同一任务读取暂停状态、播放头位置与字幕，避免媒体事件掩盖回归。仅加断言、未加修复时，`pnpm test ai-cleanup-scope-integration.spec.mjs -g S3-T05` 确认撤销后仍显示 `deleted words kept` 而非 `kept`（检查记录 `20261121T081841Z-4a25122f`）。
- 修复并重建后，`pnpm test ai-cleanup-scope-integration.spec.mjs` 通过 6/6（`20261121T081917Z-767f0237`）；`pnpm run check:editor` 和 `pnpm run typecheck` 通过。未执行全量 Chromium 或重新运行远端 CI。

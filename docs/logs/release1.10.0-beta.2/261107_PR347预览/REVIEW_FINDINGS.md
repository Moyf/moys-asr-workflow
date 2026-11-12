# PR347 AI 建议预览独立复审

2026-11-07。范围为 [PR347](https://github.com/Moyf/moys-asr-workflow/pull/347) 的 AI 建议预览与本轮修复；最终验证包含 `2.0dev` 的 `e358512e`。人工核验仍待执行。

## 已确认并修复的问题

| 问题 | 触发与影响 | 本轮处理 |
| --- | --- | --- |
| 新译文 ID 未避开其他轨道 | 只检查目标副轨时，新字幕可能与主轨或叠加轨重名，影响保存、定位及绑定。 | 创建译文时以所有轨道的字幕 ID 为占用集。 |
| 共享译文与时间重叠 | 多条主字幕共享同一译文时，单句替换会影响其他主句；新译文也可能占用已有副字幕的时间范围。 | 拒绝自动替换共享目标；新建前检查既有副字幕及本批已安排的区间，冲突建议保留供查看、复制。 |
| 本地替换媒体后仍使用旧源 | 浏览器已换成本地媒体，但服务器源标识仍存在，旧对齐结果可能回写，新任务也可能继续提交旧源。 | 任务上下文包含本地媒体身份；切换后拒绝旧结果，本地媒体替换期间禁用服务器源对齐入口。 |
| 联动拆分确认缺少二次校验 | AI 建议打开联动拆分窗口后，源字幕或绑定再次变化，旧断点仍可能提交。 | 最终确认时重新检查上下文、原文、时间、字词及绑定；变化时关闭窗口、提示重新查看并保留建议。 |
| 待处理建议身份混淆 | 联动窗口或异步应用的迟到回调，可能误消费后来产生的同 ID 建议。 | 每批待处理建议持有独立身份；确认回调校验该身份，仅在实际提交后消费对应建议，旧应用回调不更新新批次。 |
| 编辑翻译草稿后状态未重验 | 将建议清空、改回已有译文或修改冲突行时，勾选及可应用状态可能仍沿用旧值。 | 输入时重新校验冲突和选择状态，保留正在编辑的文本框与草稿；应用时再次校验并使用编辑后的译文。 |
| 联动窗口中数字键误改说话人 | 合入说话人快捷键后，在联动拆分窗口按数字键可能修改背后的字幕。 | 联动窗口打开时不触发数字键分配；浏览器用例检查字幕未变化。 |

相关实现位于 `web/editor/ai/editor-ai-text-tasks.js`、`editor-ai-structure-tasks.js`、`editor-ai-preview.js`、`editor-ai-tasks.js` 及 `web/editor/cues/editor-split-core.js`。定向回归由 `tests/test_editor_ai_tasks.mjs` 与 `tests/e2e/editor-ai-assist.spec.mjs` 承接；此处不将测试用例存在等同于执行通过。

## Windows CI 失败仍待归因

[Windows run 42361439118](https://github.com/Moyf/moys-asr-workflow/actions/runs/42361439118) 检出 `a36afa0d`，即 `adb4873d` 合入 `27019095` 的组合。显示回归组 63/64 通过；唯一失败为 `ass-stacking-boundaries.spec.mjs` 的 `largest emphasis and comment runs`。异常是 `configure()` 中的 `page.evaluate: Resulting promise was garbage collected.`，发生在像素断言之前。

[保留的 trace 与报告](https://github.com/Moyf/moys-asr-workflow/actions/runs/42361439118/artifacts/13569747895) 显示：该 evaluate 约 54 ms 后失败；请求均正常返回，没有额外导航、崩溃或运行时异常记录。失败后快照已有 ASS Canvas、三个字幕目标及 `data-ass-stack-status=ready`。这证明页面已执行夹具写入并渲染预览，不能将该错误直接解释为字幕布局失败或字体加载失败。

原 configure 的异步依赖包括样式库请求、`document.fonts.load()` 与 `document.fonts.ready`；Playwright 还包装返回 Promise。当前 trace 无法区分哪一层失去引用。以 CI 保存的页面、bundle 与响应独立重放，在强制 GC 下完成 20 次 configure；已知悬空 Promise 对照可复现同一报错。这仍未复现原始失败，不能宣称具体根因已查明或修复。本轮未为此修改测试或加入重试。

## 验证与交付边界

合入最新基线后的定向验证包括 JavaScript 56 项、Python 60 项和 Chromium 编辑器 9 项，均通过；新增数字键保护也通过单独浏览器用例。编辑器构建新鲜度、类型和文档检查通过。局部通过不代表整组 CI 或 Windows 打包通过；上述 Windows 失败之后的打包及后续步骤未执行。

模型返回模拟数据的测试不能证明真实供应商、真实媒体和字词对齐质量。按 [人工核验清单](PR347预览.checklist.md) 记录实际入口、素材、结果与差异。合并、推送及发布状态以维护者后续操作为准。

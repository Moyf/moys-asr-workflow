# G08-b 提交前独立自审

审查范围：上游 `main` 的 `df00f73a` 至 G08-b 重放提交 `eb1839fd`，以及本轮补齐的预设消费边、记录和核验清单。审查者未参与实现。结论：未发现未处置的 blocker 或 major。

| 编号 | 级别与处置 | 证据 | 结论 |
|---|---|---|---|
| R1 | 已修复 | `web/editor/cues/editor-text-process.js` 原先导入五个预设函数，却仍有九处 `MaweProcessing.*` 函数调用；修后 `rg` 显示函数调用使用导入名，`library`/`portable` 显式走 `window`。 | 实际消费边已接通；构建、单测和相关浏览器用例通过。 |
| R2 | 接受的非阻断风险 | `editor-cue-list-anchor.js:367` 的对象、`editor-selection.js:484` 的 Set、`editor-split-core.js:2449` 的数值常量、`editor-text-process.js:1002-1004` 的 DOM 句柄被包装成可调用导出；`rg` 检查当前源码未找到这些导出的静态 import 消费者。 | 当前生产路径不调用它们；未来添加消费者前按值语义改导出。 |
| R3 | nit，接受 | `editor-cue-elements.js:9-19` 等文件有重复且不完整的机械转换头注释。 | 不影响构建或运行；后续整理注释时统一清理，避免本批扩大 diff。 |

验证：`pnpm run test:unit` 1043/1043、相关 Python 契约 83/83、Chromium 三组 16/16 + 34/34 + 27/27；`pnpm run check:editor`、typecheck、`git diff --check`、个人路径检查和核验清单检查通过。浏览器人工核验仍在清单中待维护者确认。

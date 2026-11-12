# 自定义快捷键二轮盲审修复复核

复核范围：Hermes 对 `87901225` 的 request_changes，以及本次 8 个源码/测试文件 diff。复核者未参与实现，按代码、测试输出和 Git 基线核对。

## Finding 处理

| Finding | 结论 | 证据 |
| --- | --- | --- |
| 改键后 Alt+A/D 不再维持原反转联动拖拽语义；Alt+旧键仍可能抢占 | 已修复 | `effectiveBindings` 为 nav/extend A/D/W/S 建立 Alt 派生；`defaultPhysicalBindings` 与 `suppressesOldChord` 屏蔽旧完整组合；`validate` 遍历派生组合。四向单测与 Chromium 实际 `handleHeldCueKey` 分发通过。 |
| 拆分弹窗提示显示当前改键，但实际只响应 B/Enter | 已修复 | 弹窗展示状态决定提示键为 B；译文模板先翻译再插值。真实浏览器用例确认提示且按 B 完成重试。 |
| 失效存储项导致其他键丢失 | 已修复 | `split=q` 逐项判无效，提示 Ctrl/Cmd+Shift+Q 冲突；`play=p` 保留并在后续保存/重载继续存在。单测与真实浏览器验证通过。 |
| 扩展选择 Alt 派生仅有 mapping 单测 | 已补验证 | 新增真实浏览器拖拽事件，Alt+P/M 经自定义追加选择绑定投影到 Alt+Shift+A/D，并断言真实拖拽处理器收到方向与修饰键。旧快照 red、修复分支 green。 |

## 边界

- `origin/2.0dev` 的本地源码及本地 Git branches/tags 未包含该 localStorage 键；无法从这些 refs 证明它是否曾经通过其他发行渠道发布。实现选择保留所有仍有效项目并对无效项目给出可读提示，不清空整个设置对象。
- 完整键盘时序 E2E 未完成：109 项整文件运行被中断，`result.json` 记为 `interrupted` / exit 130；只认可独立焦点用例的退出码。
- 全量 Node 测试的日志缺 `result.json`；全量 Python 与 8 个多字幕 E2E 的事实和限制见同目录 `TEST_FEEDBACK_自定义快捷键.md`。

自审没有发现未处置的 blocker / major。此记录不替代 Hermes 的独立复审，提交后等待该复审。

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

## 第三轮盲审（0b9dd000）

- 已修复：已存配置逐命令隔离校验，`split=q` 与冲突的 `merge=b` 分别被拒，同时保留 `play=p`；提示给出各自原因。
- 已修复：固定快捷键冲突登记为 M、Q、C、Shift+C、F；真实浏览器确认非法 `split=m` 不会与标记编辑双触发。
- Minor（接受）：固定键冲突的 Q、C、Shift+C、F 覆盖单测；本轮新增真实浏览器功能分发回归直接覆盖 M，未逐一新增其余四键的浏览器分发用例。只读独立自审未发现 blocker/major，也未发现现有记录夸大浏览器覆盖范围。
- 全量 Node 同环境快照对照在 Node 22.23.1 上，基线为 1434 项 / 1417 通过 / 17 失败 / 0 取消，修复分支为 1436 项 / 1419 通过 / 17 失败 / 0 取消；17 个失败名称相同。该 Node 版本不在项目 engines 范围内。
- 全量 Python 基线未验证：没有日志或 `result.json`，只读进程检查无存活测试进程。分支全量 Python 既有结果为 3039 项、19 skipped、exit 0；不据此推断基线。
- pnpm 意外行为及 `.pnpm-store/` 保留情况详见任务账本；该未跟踪目录未纳入变更或提交。

## 第四轮盲审（12ed4856）

- 已修复：存储迁移先收集并逐项做 intrinsic 校验，再全量验证候选配置，因此 `play=j, reverse=p` 这种合法交换不再与尚未迁移的默认 reverse J 冲突。实际冲突时只丢弃冲突覆盖值；警告标出失效快捷键与对方命令。新增单测覆盖合法互换、单项回退与提示；既有 `split=q, merge=b, play=p` 混合无效配置仍保留 play。
- 已修复：字词选择捕获先保留物理 C/Shift+C/F 与 Ctrl+C 的上下文操作，再以有效投影键识别需要阻断的父级 Delete/Split/Merge/颜色等命令；新增父级 Merge 与 color-9 的真实事件保护回归。
- 浏览器真实键盘回归 6/6 通过（J/P reload、E→Delete、E→Split、旧 B 不阻止、改绑 Merge/颜色键不触发父操作、物理 C/Shift+C/F 与 Ctrl+C 仍生效）。Node 定向单测 20/20 通过。
- 捕获层复核限定于主字幕操作相关的可配置快捷键接线；Enter/Escape、拆分弹窗键盘流和媒体控件本地按键保留独立语义。报告范围与证据见任务账本。

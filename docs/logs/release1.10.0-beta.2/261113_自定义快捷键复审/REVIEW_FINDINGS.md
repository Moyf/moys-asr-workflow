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

## 第五轮盲审（0db4526）

- 已修复：字词捕获层对父字幕操作统一使用 `resolveEvent(event)` 的有效键与修饰符；Ctrl+E 改绑 trim-start 与 E 改绑 merge-prev 的真实键盘事件不会修改相邻字幕时间或合并父字幕。
- 已修复：字词拖拽中的播放键依有效映射判断，P→Space 不再被物理白名单截断；Mod+C 改绑 Merge 时，字词选择上下文中的物理 Ctrl/Cmd+C 保留浏览器默认行为并阻止父级快捷键处理。
- 验证：当前修复分支定向浏览器 6/6、Node 20/20、bundle fresh 与 `git diff --check` 通过，具体命令、exit code 与本地日志路径见任务账本。旧逻辑 Ctrl+E 与 Ctrl/Cmd+C 的浏览器红测有实际状态变化证据；merge-prev 首次旧逻辑对照因夹具缺少稳定 cue id、未到按键断言，因此不宣称有效红测。P 播放旧逻辑红测因测试放错 spec、引用无效 helper 而无效。
- 平台限制：测试机为 Linux Chromium。Ctrl+C 触发原生 `copy` 事件；Meta+C keydown 未被阻止，但此平台没有观察到其原生复制事件，不能据此声称已验证 macOS 的原生复制。
- 独立自审：只读审查未发现 blocker / major；没有新增产品语义取舍。

## 第六轮盲审（6d3f7ac1）

- 已修复：`Mod+C` 从可录入组合中排除，避免旧值迁移后接管 Ctrl/Cmd+C；提示保留静态、可翻译原因与动态平台显示键。单测覆盖 Win32/MacIntel 设置拒绝和旧存储迁移保留其他配置；真实浏览器确认 Ctrl+C / Meta+C 均未被阻止，当前浏览器平台对应的原生复制组合派发一次 `copy` 事件，字幕数量不变。自动化只验证当前浏览器平台，不替代另一操作系统的原生系统级验证。
- 已修复：ASS 定位拖拽窗口捕获改用有效映射事件。真实浏览器拖动期间确认旧物理 Ctrl+Z / Meta+Y 不再中断拖动，改绑 Ctrl+U / Meta+Shift+U 映射为原撤销/重做并取消活动拖动。
- 已修复：模态打开时只抑制已失效的旧保存快捷键，调用 `preventDefault` 并保留传播，避免项目 POST 同时保留模态按键处理。测试观察到 Ctrl/Meta+S 无保存请求、事件到达模态。另有真实 POST 断言确认默认编辑态 Ctrl+S 仍提交 inline text 且不退出编辑态；F2 编辑态语义未扩展。
- 未复现：英文迁移告警当前实现已分离 label/chord/reason，再将译文模板翻译后插值；`split=q` 的真实 UI 告警完整显示英文。最初新增测试因硬编码复数标签与 Ctrl 平台显示不符而失败，已改为按实际单数与 `displayChord` 验证；无产品代码改动。
- 独立只读审查未发现 blocker / major；审查指出复制测试需断言浏览器实际派发 `copy`。已补平台对应原生修饰键触发 `copy` 的断言，单例与最终两份 spec 整文件重跑均通过。
- 验证：快捷键单测 21/21；两份受影响 E2E spec 整文件 20/20；bundle 在本轮源码后重建。日志路径与红测细节见同目录 `TEST_FEEDBACK_自定义快捷键.md` 第六轮。
- 未覆盖：没有 macOS/Windows 原生浏览器进行剪贴板和系统快捷键端到端验证；沿用既有全量 Node/Python 基线限制，本轮未运行全量套件。`.pnpm-store/` 始终保留且排除提交。

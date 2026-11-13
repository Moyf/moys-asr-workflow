# 提交前自审记录：报错反馈同步输出到开发者工具控制台

- 日期：2026-11-12
- 分支：`feat/报错输出到控制台`（基于 origin/main `12daf4d2`）
- 审查者：前台独立 subagent（未参与实现），通读全部未提交 diff（22 个修改文件 + 2 个新增文件），抽查 flashHint 全部调用点类型分布、transition 装配机制与两份 bundle 产物
- 结论：初轮 1 major + 4 nit；major 与 nit-3 已修复复验，其余 nit 接受或维持现状，处置后放行

## Findings 与处置

| # | 级别 | 内容（证据见审查原文） | 处置 |
|---|---|---|---|
| M1 | major | `{ error }` 透传的机械改动漏 6 处 catch 站点：`editor-wiring-export-actions.js` 4 处（保存位置选择器失败 537、导出停止确认失败 580、字幕保存失败 697、重组后视频导出失败 995）+ `editor-project-save.js` 2 处（保存失败 187、256）。同文件已改站点（307、386）与孪生流程 `editor-wiring-burn-video.js` 均已传，属枚举遗漏而非有意排除；这些真实用户失败流镜像缺原始 error 与堆栈，与 CHANGELOG 宣称不符 | **已修复**：6 处全部补 `{ error }`（995 行 `warnCleanup` 链路上的 `cleanupError` 场景由 580 行透传覆盖）；重建 editor bundle，`test_console_mirror` + 脚本顺序/语法 9/9 绿 |
| N1 | nit | 去重键空间达 200 时 `clear()` 全量清空（`console-mirror.js:35`），长会话理论上可让刚抑制的文案重复输出一次 | **接受**：每条至多多一行、对诊断通道无危害，注释已声明上界语义 |
| N2 | nit | 去重时间戳在控制台槽位可用性检查之前记录（`console-mirror.js:47-50`），环境缺 `console.warn` 时后续同文案被抑制却从未输出 | **接受**：真实浏览器 `console.warn` 恒存在，不可达路径 |
| N3 | nit | FAQ 反馈节把两侧能力合并表述（「含错误码、诊断信息和原始错误对象」），但编辑器镜像无错误码/诊断、Launcher 镜像无原始 Error | **已修复**：拆为「编辑器副本附带原始错误对象（含堆栈），Launcher 副本附带错误码与诊断信息」 |
| N4 | nit | `editor-multi-import.js:314-317` 该 catch 已有既存 `console.error(error)`，补 `{ error }` 会双份输出同一错误对象 | **接受**：补 M1 时有意跳过此站点，避免重复 |

## 接受的风险

- **warning/invalid → `console.warn` 而非 `console.error`**：editor 的 'warning' 同时涵盖「真失败」与「产品性拒绝」（如「不能删除全部字幕」），两个 e2e spec 的「控制台零 error」契约编码了 error=意外缺陷 的团队语义；warn 不破坏契约（`waveform-deletion.spec.mjs` 的 attachErrorCollector 只收 error 与 pageerror，实测 4/4 通过）。代价是真失败也走黄色 warn，由 `[MAWE][hint]` / `[MAW Launcher]` 前缀与 FAQ 指引缓解。
- **1s 滚动去重窗口**：拖拽/rAF 连发场景必要；间隔 >1s 的重复失败（如自动保存）每次仍输出，不丢诊断。
- **Launcher 走 modules.json transition 绑定而非 ESM import**：装配机制、清单顺序（console-mirror 在 launcher-errors 之前）、`validateTransitionModule` 单导出约束均已核验，且有单测守卫；`redactSensitive` 为同文件函数声明、镜像调用在运行期，无 TDZ。
- **`blank-editor.html` 未重生成**：符合仓库约定，PR 描述注明「内联副本待发布前统一重生成」。
- **完整 Node 套件 1 个环境性失败**：中文 worktree 路径被子进程 URL 编码，主仓库 ASCII 路径同测试通过，与本 diff 无关。

## 审查者独立复核的证据

- `node --test tests/test_console_mirror.mjs` 7/7、`test_editor_script_syntax/order` 2/2（本 worktree 实测）
- 两份 bundle `--check` 新鲜，产物中可检索 `[MAW Launcher]` / `[MAWE][hint]` 镜像代码
- `git diff --check` 干净；改动文件 `git ls-files --eol` 全部 `i/lf`；新增文件无 CRLF、无 BOM
- flashHint 第二参数全量扫描：仅 `warning/invalid/info/success/default` 五类字面量及三元组合，级别映射无遗漏类型
- `--devtools` 参数真实存在（`maw_gui.py:43,112`），FAQ 表述有据
- 无 flashHint 调用方在 options 里已有 `detail` 键，无语义冲突

## 处置后复验（M1/N3 修复后）

- `node scripts/build-editor.mjs --write` → `--check` 新鲜；`build-launcher.mjs --check` 新鲜
- `node --test tests/test_console_mirror.mjs tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs` 9/9 通过
- `git ls-files --eol`（3 个新触碰文件）`i/lf`；`git diff --check` 干净
- 实现者另复扫全部 warning/invalid flashHint 站点：剩余未传 error 的均为条件判断/校验拒绝类（无 error 对象）或 N4 有意跳过项

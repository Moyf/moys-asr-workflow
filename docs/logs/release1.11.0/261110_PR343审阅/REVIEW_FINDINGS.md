# PR 343 合并审阅

## 基线与当前状态

- 请求：审阅实现与设计，小问题直接修复；无未处置重大问题时 Squash & Merge；复杂问题在 PR 反馈。
- PR 原 HEAD：`52c087a0`（`esm/g08-cues-b`）；共同基线 `ce55c207`；本轮 main 对照 `cedb5bfd`。
- 当前验证对象：PR HEAD 与 main 的合并组合；仅 CHANGELOG 与日志索引冲突，产品代码自动合并。修复已推送为 `3b36e6bc`；PR 尚未合并，本次 CI 浏览器 1 项失败待处理。
- 两位独立审查者分别核对字幕核心装配与转换/预设/测试，并复审本轮小修复；无未处置 blocker / major，已有失败通过三基线对照解除本 PR 归因门槛。

## 发现与处置

| 条目 | 级别 / 状态 | 证据与决定 |
| --- | --- | --- |
| R1 | minor / 已修复 | CHANGELOG 冲突保留 main 已发布的 1.11.0 正文，不恢复重复版本段落。移除本 PR 中「字词转换选区修复」独立条目：该问题由本次迁移引入并在本 PR 内修正，不是对已发布产品的独立修复；ESM 迁移本身没有新增用户功能或实测性能提升，不编造用户更新条目。 |
| R2 | 既有问题 / 仅说明 | 3 项字词拖动失败在干净 main `cedb5bfd`、共同基线 `ce55c207`、原 PR HEAD `52c087a0` 与合并组合均复现：Alt 独立拖动 end=3000；窄词右手柄 end=1123；拖动中 redo 保持原 1000–2500 而非 1072–2572。证明不是本 PR 新增失败，但根因未定位，不能宣称功能已修复或环境误报。 |
| R3 | 既有开发工具问题 / 仅说明 | Node 全量 1072 通过、1 失败；`test_refactor_layout_tools.mjs` 的历史 CLI 在含非 ASCII 的工作树路径中把 file URL 编码路径当作文件路径，ENOENT。干净 main 同一测试失败；Node 22.23.4 复验一致。未修改无关历史工具，不报告全量绿灯。 |
| R4 | minor / 已修复 | 删除本 PR 新增的 10 个无消费者错误函数导出：cue-list-anchor 的状态对象/按钮、split-core 的容差常量、text-process 的三个 DOM 节点、timeline 的四个数值常量。既有门面属性与初始化体逐字保留，不改值语义或新增状态快照。实际 ESM import 回归旧逻辑失败、修后通过。 |
| R5 | minor / 已修复 | VM helper 将 `clearSelection as clearCueSelection` 当成变量名，生成非法 JS。分别处理原名/本地别名：原名查门面成员，本地名声明 shim，保留延迟解析。3 项新测试旧逻辑全失败，修后通过，覆盖全部 cue init 编译、两个门面位置与动态替换。 |
| R6 | nit / 已修复 | 更新开发概览为 151 个清单条目、其中 92 ESM / 59 classic；补充浏览器单例过渡和函数/值导出边界。构建摘要的 151 sources 是清单条目数，不是额外 151 个 classic。 |
| R7 | nit / 接受 | 机械迁移的重复头注释保留，不扩大无行为收益 diff。静态 import 仍转发浏览器单例，不宣称已完成无门面/可多实例架构，也没有性能基准证明用户操作提速。 |
| R8 | minor / 已修复（远端待验） | 远端浏览器 `warma-presets.spec.mjs` 的整句删除用例预计修改 1 条，实际为无有效步骤/未改预填提示，不足以证明步骤数组为空。该用例丢弃异步 `openTextProcessModal()` 返回值，在加载可重建初始输入框期间开始填框；本地原 spec 连跑两轮为 24 通过 / 2 skip，不能据此将 CI 失败忽略。用例目的为删除/导出而非加载竞态，改为返回并等待打开 Promise，断言用户配置同步成功后再输入；保留既有删除、SRT 与加载竞态测试，不改产品代码。同 CI 组合本地 88 通过 / 5 skip，独立复核认可范围。await 缺失为确定的测试准备遗漏，但日志不能证明是 CI 失败唯一原因，仍待远端复验；加载中输入的焦点连续性未单独验证，不宣称已排除潜在产品竞态。 |

## 验证事实

所有测试通过 `python scripts/run_check.py --timeout <秒> -- <命令>` 执行，原始结果留在忽略目录。共享 Python 环境只读复用且锁文件一致；未读取或打印本机 Key 文件。

| 层 | 命令 / 范围 | 实际结果与 result.json |
| --- | --- | --- |
| 构建 | `node scripts/build-editor.mjs --write` / `--check` | 92 ESM 模块 / 151 清单条目；构建、新鲜度通过。最终构建 `.artifacts/checks/20261110T035926Z-b5d1e7f6/result.json`；独立新鲜度 `20261110T040014Z-a4b2d4fb/result.json` |
| 类型 | `node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json` | 通过；`.artifacts/checks/20261110T034901Z-c0a6d778/result.json` |
| Node 全量 | `node --test tests/*.mjs`，Node 22.23.4 | 1072 通过、1 失败、0 skip；R3。`.artifacts/checks/20261110T035159Z-d5a02319/result.json` |
| Python 装配 | `scripts/run_tests.py tests/test_editor_assets.py tests/test_editor_manifest.py tests/test_web_build.py` | 55/55；`.artifacts/checks/20261110T034901Z-b7e54666/result.json` |
| 浏览器功能 | `waveform-click-seek.spec.mjs split-style-markers.spec.mjs overlay-track.spec.mjs` | 49/49；`.artifacts/checks/20261110T035015Z-fe64de25/result.json` |
| 浏览器转换与拖动 | `word-timing.spec.mjs -g 'classic linked edges\|narrow word centers\|redo during an active word drag\|conversion reviews skips'` | 转换 1/1，三项拖动失败；`.artifacts/checks/20261110T034901Z-269a65a1/result.json`。转换弹窗间距测得 marginTop / 实际距离均 16px。 |
| main 对照 | 相同三项拖动；`test_refactor_layout_tools.mjs` | 三项拖动与工具失败一致；对照工作树的 `.artifacts/checks/20261110T035159Z-996aebf6/result.json`、`20261110T035159Z-444edd8a/result.json` |
| 文档 | `python scripts/check_docs.py` | 通过，6 个既有日志索引警告；`.artifacts/checks/20261110T035159Z-ef772316/result.json` |
| 三基线归因 | `ce55c207` / `52c087a0`，相同三项拖动 | 对照工作树 `.artifacts/checks/20261110T035654Z-5a9b87b9/result.json`、`20261110T035808Z-38e899f1/result.json`，均与 main 同失败/数值。 |
| helper 红绿 | `node --test tests/test_init_module_source.mjs` | 红 0/3；修后与消费测试 64/64。`.artifacts/checks/20261110T035637Z-13dc68ff/result.json`、`20261110T035654Z-e47e0dc3/result.json` |
| 值导出红绿 | `node --test tests/test_editor_cues_imports.mjs` | 新增真实 ESM 导出断言红；修后两个守卫与 helper 合计 5/5。`.artifacts/checks/20261110T035902Z-fc98cf5a/result.json`、`20261110T035926Z-85a069f6/result.json` |
| 最终 Node | `node --test tests/*.mjs`，Node 22.23.4 | 1076 通过、1 失败（同 R3）、0 skip；`.artifacts/checks/20261110T035948Z-91453d12/result.json` |
| 最终浏览器 | 上述七份 spec + `word-timing.spec.mjs`，名称过滤排除已对照的三项失败 | 165 通过、3 既有 file-only 用例 skip，三项已知拖动失败是过滤排除而非修复；`.artifacts/checks/20261110T035948Z-008cdebd/result.json`。不宣称完整八份 suite 全绿。 |
| 最终类型 | `tsc -p web/tsconfig.typecheck.json` | 通过；`.artifacts/checks/20261110T035948Z-2718cc1f/result.json` |
| 独立复审 | 两位审查者；核心与本轮清理 84/84，helper 3/3 | `.artifacts/checks/20261110T035942Z-9deb757a/result.json`、`20261110T035811Z-3609522f/result.json`；无未处置 blocker / major。 |
| 个人路径 | `python scripts/check_personal_paths.py --diff-ref origin/main` | 通过；`.artifacts/checks/20261110T035407Z-2523df0a/result.json` |
| 首次 PR CI | HEAD `3b36e6bc`，[编辑器](https://github.com/Moyf/moys-asr-workflow/actions/runs/42753538578) / [Windows preview](https://github.com/Moyf/moys-asr-workflow/actions/runs/42753538527) / [lint](https://github.com/Moyf/moys-asr-workflow/actions/runs/42753538648) | 编辑器 Node 全量、构建、类型、Python 装配、媒体兼容通过；浏览器 87 通过 / 5 skip / 1 失败（R8）。Windows 预览构建和双端调试、lint 通过，不将整体编辑器 CI 计为通过。 |
| R8 初次复现 | 未修复的 `warma-presets.spec.mjs --repeat-each=2` | 本地 24 通过 / 2 skip；`.artifacts/checks/20261110T041344Z-f7336634/result.json`，未复现 CI 失败。 |
| R8 修后组合 | 与 CI 相同的七份 spec、默认 2 workers | 88 通过 / 5 既有便携 skip；`.artifacts/checks/20261110T041516Z-b6b87caa/result.json`。独立复核确认 Promise 等待与同步成功断言恰当，未弱化删除/导出断言。 |
| HTTP 补验 | `editor-bundle.spec.mjs -g HTTP` | 1/1；`.artifacts/checks/20261110T040622Z-5baa9ccd/result.json`。此前两个带行首锚点的过滤未选中用例，退出 1；修正过滤后才取得通过证据。 |

## 未验证边界与下一步

- 当前暂停合并：R8 本地组合与独立复核已通过，推送后等待远端验证；不绕过失败门禁。
- 全量 Python、全量浏览器、正式打包和三端真机未运行；人工核验沿用 PR 内已有两份清单，不代勾。
- 未重生成 `blank-editor.html`；内联副本待发布前统一重生成。合并组合中该文件的变化仅来自 main。

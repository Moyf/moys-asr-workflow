# PR 343 合并审阅

## 基线与当前状态

- 请求：审阅实现与设计，小问题直接修复；无未处置重大问题时 Squash & Merge；复杂问题在 PR 反馈。
- PR 原 HEAD：`52c087a0`（`esm/g08-cues-b`）；共同基线 `ce55c207`；本轮 main 对照 `cedb5bfd`。
- 当前验证对象：PR HEAD 与 main 的本地合并组合；仅 CHANGELOG 与日志索引冲突，产品代码自动合并。尚未推送或合并 PR。
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

## 未验证边界与下一步

- 本地合并门槛通过；下一步提交并快进更新 PR 分支，在远端 HEAD 与检查核对后 Squash & Merge。
- 全量 Python、全量浏览器、正式打包和三端真机未运行；人工核验沿用 PR 内已有两份清单，不代勾。
- 未重生成 `blank-editor.html`；内联副本待发布前统一重生成。合并组合中该文件的变化仅来自 main。

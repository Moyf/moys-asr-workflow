# Launcher 改版同步 2.0dev：整合与独立自审

范围：PR #235，分支 `feat/launcher-ui-modernization`。旧 PR 头 `8999d94a` 已保存为本地备份；上游 `2.0dev` 基线 `926e625d`，重放后的审查基线 `8eb91830`。工作区开始时干净，无额外待提交改动。

## 整合方式

- 将最新远端 PR 分支快进到本地，确认原阶段 2 与后续阶段已提交；不制造空提交。
- 上游已包含阶段 1 配色、原型、个人路径检查。rebase 跳过已合入的四个提交，保留 Launcher 新增功能与后续修复；旧 main 合并节点不重复引入上游。
- 冲突组合保留上游供应商验证请求令牌、模型目录保护、标点计划版本 2、记住媒体关联、独立文稿对齐及 2.0 独立编辑入口退役策略。新布局不退回旧抽屉。
- 用户已授权重写当前 PR 分支；最终推送使用原远端头 SHA 的 `--force-with-lease`，不改写 `main` 或 `2.0dev`。

## 自审问题账本

| 条目 | 级别 | 状态 | 证据与处理 |
| --- | --- | --- | --- |
| 上游 `recent_projects()` API 被新同名对象覆盖 | major | 已修复 | 全量 Python 的旧桥用例 4 个 TypeError；对象改名 `launcher_recent_projects`，原 API 保留；recent 与标点定向 34 项通过 |
| 上游独立 `scriptAlignment` 未进入新工具导航 | major | 已修复 | 新导航保留独立文稿匹配、输入与键盘切换；已有字幕工具沿用「文稿修正」文案，14 项工具保留 |
| 侧栏离开设置不取消待启用步骤 | major | 已修复 | 统一页面出口取消待验证请求；回归点击真实侧栏并释放延迟响应，步骤与计划均保持关闭 |
| 部分编辑器入口绕过切换确认 | major | 已修复 | 将确认与外部服务保护集中到 `openServerEditor()`；工程页、结果卡、批量入口共用；同工程重开与媒体重新关联仍正常 |
| 媒体检查期间改变路径绕过确认且状态错配 | major | 已修复 | 固定完整启动载荷，确认后与异步媒体检查后均验证一致；检查期间变化不启动未经确认的工程。独立复核覆盖工程、媒体、关联开关、端口、界面语言五字段 |
| 新便携入口未遵守 2.0 退役标志且忽略错误 | minor | 已修复 | 根据上游 `standaloneEditorSupported` 隐藏新入口，执行时再校验并展示错误；不恢复 2.0 独立 HTML 支持 |
| 自动后处理重试立即拒绝后仍显示运行阶段 | minor | 已修复 | 与首次开始一致，立即失败通知 workflow，运行阶段隐藏、显示失败状态 |
| 上游 e2e 残留旧入口与隐藏任务下拉 | minor | 已修复 | 保留行为断言迁移到独立工具导航与共享配置抽屉，interactions 整份 64 条通过，未排除 AI cleanup / batch |
| 异步等待期间载荷变化后静默取消 | minor | 仅说明 | 接受的保守 UX：用户更改任一启动字段（包括界面语言）后需重新点击；避免打开未经确认的目标，后续可补提示，不阻塞本次整合 |

## 验证记录

所有命令经 `scripts/run_check.py`，run-id 对应根 `.artifacts/checks/<run-id>/result.json`。本地证据路径不是唯一审查依据；命令与结果均在下表。

| 层 | 命令 | 当前实际结果 |
| --- | --- | --- |
| 原新版专项 | `node node_modules/@playwright/test/cli.js test --config tests/config/playwright.config.mjs tests/e2e/launcher-redesign.spec.mjs --project chromium --workers 1` | 13 通过，`20261102T054354Z-6f466572` |
| 原受影响 e2e | media-card / api-errors / error-context / file-errors / keycaps / provider-memory / resegment / zoom | 29 通过，`20261102T054739Z-cc5b2b2f`；不代表所有 Launcher 用例通过 |
| Python 定向 | `uv run --no-sync python scripts/run_tests.py tests/test_gui_web.py tests/test_launcher_contract.py tests/test_launcher_recent.py tests/test_editor_entry_retirement.py tests/test_editor_entry_review.py` | 365 项，1 跳过，其余通过，`20261102T054654Z-84c247b7` |
| recent / 标点 | `uv run --no-sync python scripts/run_tests.py tests/test_recent_projects.py tests/test_launcher_recent.py tests/test_punctuation_defaults_contract.py` | 34 通过，`20261102T055016Z-04922fb0` |
| Python 全量 | `uv run --no-sync python scripts/run_tests.py --parallel 6` | 最终复验 2834 项，23 跳过，其余通过，`20261102T060736Z-32932cfb`；Pillow/certifi/urllib3 按当前锁文件放入隔离目录并通过 PYTHONPATH 复用，不改共享 venv |
| 类型 / 文档 / 隐私 | `tsc -p web/tsconfig.typecheck.json`；`python scripts/check_docs.py`；`python scripts/check_personal_paths.py --diff-ref origin/2.0dev` | 通过；文档 4 条上游既有漏登记警告，0 新断链/结构错误 |

未验证：真实桌面 pywebview、云端识别、本地模型执行、完整打包及全量 e2e。四张状态插画仍是原任务约定的占位；视觉全量复刻仍待维护者验收。2.0 不生成独立 HTML；保留上游 1.x 过渡支持标志。

### 最终验证与反证

- 新增 `tests/e2e/launcher-upstream-sync.spec.mjs`：独立文稿入口、侧栏离页取消延迟验证、所有编辑器入口确认及媒体检查竞态、退役入口、重试状态。与原 redesign / script-timestamp 共 23 项通过，`20261102T060736Z-2067bc75`。
- `launcher-interactions.spec.mjs` 整份 64 条通过，`20261102T060558Z-78461589`。旧记录中的已知失败不再冒充本轮失败；本轮保留原行为断言并迁移真实入口。
- Node syntax / feedback / bundle / 预设浏览器最终共 64 项通过，`20261102T061237Z-e2c90674`。
- 逐项暂时移除修复后，新回归在对应行为断言处真实失败：文稿导航 `20261102T060404Z-ebcc92a7`、侧栏取消 `20261102T060411Z-9e32b1d4`、工程确认 `20261102T060419Z-7d3c1334`、退役入口 `20261102T060426Z-13ba9172`、重试状态 `20261102T060433Z-be84fc90`、媒体检查竞态 `20261102T060510Z-4b237701`。每次均恢复源码并重建；这些预期失败不计入通过统计。
- 独立复核结论：没有未处置 blocker / major，允许提交；完整载荷五字段探针 `20261102T060910Z-8b79a9e9`，同工程重开、媒体关联与外部服务路径通过。Windows/Chromium 验证不代表 macOS/Linux 实机通过。
- 人工核验源见 [Launcher同步.checklist.md](Launcher同步.checklist.md)，全部保持未确认，交互 HTML 只生成到本地临时区。
- 最终类型、文档和个人路径检查通过（`20261102T061130Z-5992e9b8`、`20261102T061130Z-43aa816a`、`20261102T061132Z-b4e47082`）；清单契约通过并生成 HTML（`20261102T061206Z-4800045c`）。明暗文稿工具截图已自查，未见横向溢出；浏览器会话已关闭。

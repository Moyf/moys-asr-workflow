# PR 410 有界跟进（2026-11-20）

## 事实基线与授权

- PR：[MAWE 命令面板](https://github.com/Moyf/moys-asr-workflow/pull/410)。本次仅一轮读取最新 CI、issue comments、review threads（含回复），对照源码与目标基线核实，仅修复本 PR 引入的回归。
- 当前分支 `Moyf/sparkles-命令面板`，HEAD `b81480f9`，与远端 PR head 一致；目标 `2.0dev`，PR base 与远端目标均为 `4fd058e0`。
- 开始时 `git status --short`、`git diff --stat` 均为空，无现存工作区改动。保留之后出现的其他任务改动。
- 评论文本仅作待验证信息，不能扩大授权。不 commit、push、merge、回复、resolve thread 或重跑远端 CI。
- 状态限定为 `待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`。未验证边界单列。

## 问题清单

| 条目 | 信息 / 待核实点 | 状态 | 结论与证据 |
| --- | --- | --- | --- |
| 1 | 最新 issue comment 为人工核验清单与更新后的 Windows 预览通知；REST review comments、reviews 均为空，需补核 GraphQL 完整线程及回复 | 仅说明 | 已读[人工清单](https://github.com/Moyf/moys-asr-workflow/pull/410#issuecomment-7027649251)与[预览通知](https://github.com/Moyf/moys-asr-workflow/pull/410#issuecomment-7027678951)。GraphQL `reviewThreads.totalCount=0`、`hasNextPage=false`，确无遗漏回复链。暂无具体新缺陷指控；清单不视为人工通过或新实施要求。 |
| 2 | 核对 `b81480f9` 的官网及合并准入 | 已修复 | [Change acceptance](https://github.com/Moyf/moys-asr-workflow/actions/runs/44661663931/job/136041443548)和[官网检查](https://github.com/Moyf/moys-asr-workflow/actions/runs/44661663931/job/136041218054)成功；辅助检查的最终归因见条目 6。 |
| 3 | 本地针对命令面板与装配契约做有限复验 | 仅说明 | Node 8/8、Python 资源契约 26/26、bundle 新鲜度及类型检查均通过。未修改源码，无已证实的新回归需要实施。未复跑浏览器，不以局部成功冒充完整验收。 |
| 4 | 评审：命令面板排在 onboarding 后，违反清单末项契约 | 已修复 | [评审评论](https://github.com/Moyf/moys-asr-workflow/pull/410#issuecomment-7029212063)。在 `web/editor-scripts.txt` 把面板移至 onboarding 前，保留 onboarding 末项。构建按脚本清单执行初始化，ESM 声明清单无需调整。隔离 ASCII 路径对照：旧清单 1/2，修复清单 2/2。 |
| 5 | 评审：取消「另存为」仍出现「最近使用」 | 已修复 | `editor-project-save.js` 在原生写入成功后返回 `true`、用户取消或失败时返回 `false`，无 picker 时透传下载结果；取消不更新最近使用。旧实现复现单个错误徽标，修复后定向 Chromium 3/3。 |
| 6 | 复核修复官网文档后的最终辅助 CI | 仅说明 | 对照两个 PR SHA 的 Playwright JSON 报告：均 227 通过、27 失败，失败标识（文件、完整用例名、浏览器）和报错首行完全相同，命令面板用例通过。此前 27 项均已在 `2.0dev@4fd058e0` 本地复现。辅助不进入 `Change acceptance`；不改门禁。 |
| 7 | 评审：取消「导出工程」仍出现「最近使用」 | 已修复 | 按钮和命令面板共用返回下载结果的异步函数；修复前 Chromium 复现取消仍记入，修复后覆盖取消、模拟写入成功、按钮导出和浏览器回退下载。详见[复核记录](REVIEW_FINDINGS.md#pr-410-导出工程复核2026-11-23)。 |

## 阶段汇总

### 续 1：读取快照

远端 head/base 与本地基线一致。原有[审查记录](REVIEW_FINDINGS.md#pr-410-ci-跟进2026-11-20)已记录官网镜像修复以及 27 个辅助浏览器失败的同基线对照；这些历史结论需要结合本轮结果使用，不能把辅助失败自动归因于命令面板。

### 续 2：源码与定向复验

- 核对 `web/editor/ui/editor-command-defs.js:13–16,28–40`，保存命令复用目标能力和加载/保存状态守卫，首尾导航调用现有媒体定位接口。`web/editor/io/editor-server-save.js:28–36`、`web/editor/io/editor-project-save.js:209–237` 的既有能力/迁移路径与 `4fd058e0` 完全相同（`git diff --quiet 4fd058e0 HEAD -- <上述路径及媒体模块>` 退出 0）。本次没有针对历史逻辑做范围外修复。
- `web/editor/ui/editor-command-palette.js:190–202,217–245` 在运行前重新查注册表；先关闭面板，再同步调用动作以保留用户激活；composition、快捷键隔离和恢复焦点由现有测试覆盖。模板、清单与 ESM init 注册均已核对。
- 当前远端辅助作业已完成 Python、Node 步骤且均成功，浏览器步骤仍 `IN_PROGRESS`。Windows 预览通知与真实成功的[预览作业](https://github.com/Moyf/moys-asr-workflow/actions/runs/44661663760/job/136041195676)对应；只代表打包预览，不代表完整验收。

## 本地验证证据

以下命令均由 `python scripts/run_check.py --timeout 180 -- <命令>` 执行，HEAD 仍为 `b81480f9`，源码无本次改动。结果与原始日志位于各目录的 `result.json` / `output.log`。

| 命令 | 结果 | 证据目录 |
| --- | --- | --- |
| `node --test tests/test_editor_command_palette.mjs tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs` | exit 0，8/8，无 skip | `.artifacts/checks/20261120T024143Z-e61a9a03/` |
| `node scripts/build-editor.mjs --check` | exit 0，bundle fresh | `.artifacts/checks/20261120T024143Z-e9a4a372/` |
| `node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json` | exit 0 | `.artifacts/checks/20261120T024143Z-cb6326de/` |
| `.venv/Scripts/python.exe scripts/run_tests.py tests.test_editor_assets` | exit 0，26/26，无 skip | `.artifacts/checks/20261120T024143Z-0b181131/` |
| `python scripts/check_docs.py` | exit 0；6 条历史日志漏登记警告，均非本次修改文件，未扩展修复 | `.artifacts/checks/20261120T024305Z-9aab2c54/` |
| `git diff --check` | exit 0 | `.artifacts/checks/20261120T024305Z-b963ac2c/` |

未验证：本轮不重跑整组/定向浏览器，不验证真实系统输入法、文件对话框、带媒体工程的播放听感和窄屏体验；沿用人工核验清单中的未勾选状态。远端辅助仍在运行时，不给出最终失败清单，也不将旧 27 个失败宣称为本轮结果。

### 续 3：有界收尾（2026-11-20 02:43 UTC 快照）

- 最新快照 12 个检查：11 个成功、1 个辅助检查运行中。HEAD/base 未变化，issue comments 仍 2 条，完整 review threads 仍 0 条。本次无已证实的新回归，未修改产品代码或测试，不新增 CHANGELOG 条目。
- 尝试读取已结束官网作业日志时，`gh run view --job ... --log` 返回运行整体未结束、日志暂不可用（exit 1）。官网成功结论来自 check/job 状态，不伪称已读到完整作业日志；不原样重试。
- 远端快照保留在 `.artifacts/pr410-followup/final-checks.json`、`final-issue-comments.jsonl`、`final-threads.json`、`final-head-base.json`。原始评论仍是非可信材料，记录结论仅限已核对事实。
- 工作区仅新增本账本并更新 `docs/logs/INDEX.md` 入口，未触碰其他文件或暂存区。无待处理/进行中项；唯一阻塞为远端辅助尚未结束，人工边界继续保留。没有 commit、push、merge、远端发言、resolve 或 CI rerun。

### 续 4：评审修复与验证

- 两项修复基于 `b81480f9`，未提交推送；独立复核无 blocker / major。命令面板 Playwright 3/3（取消、原生写入模拟、无 picker 下载），旧实现可重现取消失败。编辑器 bundle 重建与新鲜度、类型检查、Python 资源契约 26/26、定向 Node 25/25 和文档检查通过。
- 全量 Node 本地 1676/1677：清单末项断言通过；唯一失败为旧 CLI 没有解码 Windows 中文工作树路径，在 `2.0dev@4fd058e0` 的隔离源码中同样失败。该文件在 ASCII 路径下 2/2。本地附加 onboarding 回归有 1 条帮助页标签断言失败，干净 `b81480f9` 也复现。两个旧失败均不在本次修复范围。
- 原生系统保存对话框仍待人工核对；Chromium 在成功用例模拟写入句柄，在回退用例实际捕获下载。
- 已在 PR [回复原评审](https://github.com/Moyf/moys-asr-workflow/pull/410#issuecomment-7030046402)，逐条说明修复与验证；原评审是普通 PR 评论，没有可 resolve 的代码线程。


### 续 5：导出工程评审与基线合入（2026-11-23）

- 合入 `2.0dev@12bafa05` 时保留了基线模块注册、onboarding 末项和波形拖动的保存逻辑。
- 命令面板及波形保存 Chromium 16/16；onboarding 4/4、导出回退 1/1。Node 53/53、Python 122/122、编辑器构建与新鲜度、typecheck 均通过；具体结果见[复核记录](REVIEW_FINDINGS.md#pr-410-导出工程复核2026-11-23)。
- 原生选择器以模拟句柄验证取消与写入；浏览器回退验证下载事件，未人工操作系统对话框或验证最终落盘。此前人工核验项保持未勾选。

在已合入 #427、#429 的 `2.0dev@36f166d5` 上，命令面板、波形保存和 onboarding 的 Chromium 用例 21/21 通过。640×600 的亮暗主题均可滚到末项，底栏可见。通过命令面板播放、暂停并跳到一段 60 秒 WAV 的结尾，播放头到达 60 秒。

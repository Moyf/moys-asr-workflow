# MAW 2.0 集成执行手册

> 配套[总计划](MAW_2_0_INTEGRATION_PLAN.md)。先读总计划中的授权、D1–D5、G 验收编号和当前进度。本页的命令是未来执行参考，不是本次已经运行或已经授权的操作。

## 1. 开始前：避免照着旧命令做错事

### 1.1 每次新会话先核对

在要操作的工作树根目录执行下列只读命令，不先拉分支、清 WIP 或装依赖：

```powershell
$PSVersionTable.PSVersion.ToString()
git status --short --branch
git log -1 --format='%H %ci %s'
git diff --stat
git diff --name-status
```

如已有暂存内容，再单独看 `git diff --cached --stat` / `--name-status`。仅在明确源码路径查看内容 diff，不默认打印整个仓库的大 diff。

读取总计划与当前阶段日志；用 `git worktree list --porcelain` 找到现有工作树，不把已 checkout 的共享分支强行再 checkout。查看 `git rev-parse --git-path MERGE_HEAD` 对应文件是否存在，只读识别合并状态。

**文档携带问题**：若总计划尚未提交，直接从 `origin/2.0dev` 新建工作树不会自动得到本计划。开始迁移前，先经维护者授权保存计划提交并带到新基线，或用 patch 仅携带本任务的计划 / 索引变更；保留来源工作树作为阅读入口。不擅自 commit 全部 WIP，也不能因为新分支缺文档就跳过它。

### 1.2 对照来源，冻结完整 SHA

```powershell
git remote -v
git ls-remote --heads origin main 2.0dev feat/launcher-ui-modernization merge/starlit-main starlit
git rev-parse origin/main origin/2.0dev origin/feat/launcher-ui-modernization origin/merge/starlit-main
git merge-base origin/main origin/2.0dev
git rev-list --left-right --count origin/main...origin/2.0dev
```

`ls-remote` 是服务端事实，`origin/*` 是本地缓存；二者不一致时记录差异，再在授权范围内 `git fetch origin`，重新冻结 SHA。不得在每个小批次自动换来源；来源变化要重新计算差异及证据覆盖。

涉及 GitHub PR 用以下字段复核；历史 PR 描述只说明当时状态，不是当下所有组合已通过：

```powershell
gh pr view 235 --repo Moyf/moys-asr-workflow --json number,state,isDraft,baseRefName,headRefOid,mergeable,statusCheckRollup,url
gh pr view 344 --repo Moyf/moys-asr-workflow --json number,state,mergedAt,body,url
gh pr view 199 --repo Moyf/moys-asr-workflow --json number,state,baseRefName,mergedAt,body,url
gh pr view 92 --repo Moyf/moys-asr-workflow --json number,state,mergedAt,body,url
```

自动同步 PR 293 写计划时仍开放；不要把启用它视为解决当前业务冲突的替代方法，也不要擅自改目标分支或直接合入它。

### 1.3 建工作树 / 分支的正确方向

涉及 Orca 时先加载 `orca-cli`，按会话环境解析真实 CLI 路径，并读取当前版本指南。创建整合工作树时明确 base 为已确认的 `origin/2.0dev`，明确 parent；不要省略 base 后默认落到 main。创建本身不会授权启动另一个 agent 或执行提交。

若维护者选择在当前**干净且独占**的 2.0 工作树执行，可用下面的分支命令。必须先解决计划文档未保存、用户 WIP 和共享占用问题；有不明变更则停下。

```powershell
# 仅在维护者授权 P1 实际整合、确认来源之后执行
git fetch origin
git switch -c integration/main-to-2dev-20261112 origin/2.0dev
git merge --no-ff --no-commit origin/main
```

示例分支名已经存在则调查归属，不加 `-C` / `-B` 覆盖。实际应把 main / 2.0dev 冻结 SHA 写进台账，merge 前核对 refs 未变化，必要时以冻结 SHA 作为参数。`--no-ff --no-commit` 是为了在可审查状态停下，不是为了留下永久未解决的 merge。

**同步记录祖先的要求**：P1 是一次正常 merge，完成后整合提交应同时包含选定的 main 和 2.0dev 祖先。授权完成后可用 `git merge-base --is-ancestor <冻结mainSHA> HEAD` 及另一侧验证。不要 squash 成一份“看起来一样”的快照，否则下次同步又会重复引入已处理差异。

PR 合入方式同样要保留这段祖先关系，不选 Squash / Rebase。若仓库设置只允许 squash，先请求维护者决定允许的整合方式，不自行改仓库设置或直接推共享目标分支。

## 2. P1 冲突分类与实现参考

### 2.1 无损预演

```powershell
git merge-tree --write-tree --name-only --no-messages origin/2.0dev origin/main
```

第一行是临时合并树 hash，后面是冲突路径；退出 1 可表示存在冲突。它不会启动实际 merge。真正开始后用 `git diff --name-only --diff-filter=U` 看未解决项；不能仅靠搜索冲突标记判断索引已解决。

每个文件按以下顺序处理，最多五个动作：

1. 用 `git show :1:<路径>` / `:2:<路径>` / `:3:<路径>` 分清共同祖先、目标 2.0 与传入 main；这些索引写法仅在该文件仍有冲突时可用。
2. 用 patch 合出目标语义，阅读相关调用者与对应测试；不使用整份 ours / theirs 跳过判断。
3. 检查该文件 diff / 冲突标记，并只对确认属于本任务的明确文件执行 `git add -- <路径>`；不使用 `git add -A` 打包未知改动。
4. 更新未解决清单与台账。源码 / 清单还存在解析冲突时，不把构建失败误判为另一项回归；先完成相关文件的语法整合。
5. 全部解决后检查暂存 / 未暂存 diff、生成物范围与实际可构建内容，再跑完整阶段门槛。未提交 merge 的审查不能只看旧 HEAD。

2026-11-12 快照为 main `149f9fe7` 与 2.0dev `e358512e`，共 38 个冲突。下面列的是当时的明确路径；实际新冲突必须追加进阶段台账，不能只处理这张表。

### 2.2 24 个前端冲突

| 类别 | 路径 | 合并要点 |
| --- | --- | --- |
| 装配 | `web/editor-modules.json` | 保留两侧新增工厂 / bridges 的真实需要，结合 scripts 清单与静态 import 去重，不能只求 JSON 合法 |
| 绑定 / 列表 | `web/editor/cues/editor-binding-align.js`、`editor-cue-events.js`、`editor-cue-panel.js` | CueRef、当前轨选择、身份与组；合入新的事件 / 气泡逻辑，防止选错主轨 |
| 行内编辑 / 导航 | `web/editor/cues/editor-inline-edit.js`、`editor-nav-preview.js`、`editor-segment-ops.js` | 字词真实切点、焦点、dirty、历史事务、三轨目标，不恢复旧顶层数组写入 |
| 拆分 | `web/editor/cues/editor-split-context.js`、`editor-split-core.js` | 拆分后的 ID / 绑定 / 组 / speaker 和零时长 item；未知扩展不丢失 |
| 贴纸 / 时间码 | `web/editor/cues/editor-sticker-picker.js`、`editor-timed-text-edit.js`、`editor-word-timing.js` | 稳定组关系、items 与正文映射、源毫秒及禁用字幕边界 |

表中同组省略的目录只表示与该行第一个文件相同，不是仓库根路径。

| 类别 | 路径 | 合并要点 |
| --- | --- | --- |
| 导出入口 | `web/editor/io/editor-dynamic-exports.js`、`editor-export-srt.js`、`editor-wiring-export-actions.js` | v2 清理投影 / 轨道选择与新图片格式共存，导出不是工程保存过滤器 |
| 工程保存 | `web/editor/io/editor-project-save.js` | 显式另存升级、保存指纹 / 迟到确认 / 并发编辑，不能由新快捷入口绕过 |
| 姓名 / ASS | `web/editor/styles/editor-speaker-labels.js`、`editor-wiring-ass-cue-position.js`、`editor-wiring-ass-manager.js`、`editor-wiring-ass-preview.js` | 稳定身份、多轨单句位置、预览与实际 ASS 输出；按新版 ESM 依赖注入 |
| UI / 设置 | `web/editor/ui/editor-display-settings.js`、`editor-wiring-settings-init.js` | 当前轨独立开关、偏好范围、装配与主线新设置不能丢失 |
| 共享 | `web/shared/editor-i18n.js`、`web/shared/utils/ass-export.js` | 两侧文案合并；主 / 副 / 叠加和身份名导出必须走真实 v2 数据 |

### 2.3 6 个测试冲突

| 路径 | 必须保留的断言目的 |
| --- | --- |
| `tests/e2e/editor-text-tools.spec.mjs` | 新文本 / 快捷编辑行为与 v2 工程、选择、保存的组合 |
| `tests/e2e/warma-presets.spec.mjs`、`tests/e2e/word-timing.spec.mjs` | 主线预设、字词编辑及规范 tracks 的真实保存结果 |
| `tests/test_ass_cue_position.mjs` | 主 / 副 / 叠加的定位、缩放、撤销与实际导出 |
| `tests/test_mass_markers.mjs`、`tests/test_split_style_markers.mjs` | MASS 标记拆合与旧用户语义；适配 ESM 测试装载，不随意改 golden |

合并测试前先写一句它在守什么回归。可改 fixture 的容器 / 装载方式，不可为了通过而删除行为断言、缩小轨道覆盖或把预期等于实际自动重生成。

### 2.4 8 个文档冲突

| 路径 | 处理方式 |
| --- | --- |
| `AGENTS.md` | 合并两侧仍适用的规则，保留 2.0 入口退役、日志 / 测试 / 安全要求 |
| `CHANGELOG.md` | 保留 main 已发布事实与 2.0 未发布能力，去重整理，不能把未交付写成已发布 |
| `docs/INDEX.md`、`docs/logs/INDEX.md` | 保留入口、本文及已有日志；日志当前基线按选定主线事实，不凭分支版本推断已发布 |
| `docs/user/LAUNCHER_GUIDE.md`、`docs/user/WORKFLOW.md` | 区分当前实际行为与后续 P2 / P3 目标，2.0 不继续推荐便携 HTML |
| `website/src/pages/docs/cli.md`、`website/src/pages/docs/documentation-index.md` | 解决源文档后运行同步器重建，不手工揉生成副本 |

main 的 `.gitattributes` 已增加 CHANGELOG / 日志索引 `merge=union`，旧 2.0dev 和共同祖先没有。首次合入仍可能冲突；union 只保留行，不负责顺序、去重、语义和链接正确。不能为减少数字而丢弃一侧文档。

### 2.5 即使没有文本冲突，也要核查

1. `web/editor-scripts.txt`、静态 import、工厂注册与 globals 类型保持一致。目录位置不代表装配顺序；不重复 init，也不重复监听器。
2. 新 main 的波形快捷编辑气泡必须按当前轨定位，不能仅在主轨显示成功；新文本逻辑进入已有命令事务，避免一次输入多次历史。
3. 图片 / 时间线 / 基础 ASS / 烧录分别核对轨道选择、组区间与身份；不能把前端导出通过当作 Python 烧录通过。
4. 新主线 Runtime 换源 / 路径、Launcher 标点偏好、OCR 回归测试必须留下；自动合并的老容器读取只允许在明确 legacy 边界。
5. 跨功能保护不能只靠搜索：创建真实三轨 fixture，实际执行编辑 → 保存 → 重开 → 导出并比较关键数据 / 源文件 hash。

## 3. 测试环境、命令与结果解释

### 3.1 环境检查，不自动重装

```powershell
python --version
node --version
pnpm --version
Test-Path .venv/Scripts/python.exe
Test-Path node_modules
git diff --name-only <参考环境SHA> HEAD -- uv.lock pnpm-lock.yaml
```

`<参考环境SHA>` 先替换为真实提交，不把占位符直接执行。若引用另一工作树 venv，比较对应 `uv.lock` 的内容或 hash，而不仅是文件名。Node 版本必须满足目标 `package.json`，写计划时要求 `^22.23.4 || ^24.22.1 || >=26.12.1`；本机调查显示过 `22.23.2`，不能忽略补丁版本门槛。

下面示例用 `$Python` 代表已选择、已准备依赖的解释器绝对路径；设置后先确认文件存在。标准库文档检查可用系统 Python，不表示同一解释器已安装产品测试依赖。

```powershell
# 用实际已准备解释器替换；不要原样执行占位符
$Python = '<已核对的Python解释器绝对路径>'
Test-Path -LiteralPath $Python
$env:MAW_TEST_PYTHON = $Python
$env:MAW_E2E_PYTHON = $Python
```

依赖缺失时只记录一次并修复对应层。不能在共享 venv 上执行另一个分支的 `uv sync`。本任务使用 `uv run --no-sync`；需要同步的构建脚本另用维护者批准的专用构建环境。

### 3.2 所有自动检查使用有界运行器

当前根目录下运行，外层工具 timeout 应比 run_check 的 deadline 大 30–60 秒。每条独立执行，保留真实 exit；不把下列多条命令贴成无退出码判断的长链。

```powershell
& $Python scripts/run_check.py --timeout 180 -- node scripts/build-editor.mjs --write
& $Python scripts/run_check.py --timeout 180 -- node scripts/build-launcher.mjs --write
& $Python scripts/run_check.py --timeout 180 -- node scripts/build-editor.mjs --check
& $Python scripts/run_check.py --timeout 180 -- node scripts/build-launcher.mjs --check
& $Python scripts/run_check.py --timeout 180 -- node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json
```

run_check 后的参数是可执行程序和 argv，不是 shell 表达式。优先直接用 node 脚本，避免 Windows `.cmd` 启动差异、PowerShell 引号和吞退出码。复杂脚本先写 `.artifacts/` UTF-8 文件，使用 pwsh / Python 短路径 loader 调用。

每条结果在 `.artifacts/checks/<run-id>/result.json` 与 `output.log`；日志仅定向读取失败点。记录层次、源码基线、命令、耗时、exit、skip 与 cleanup 状态。`exit=124` 是超时，不是通过。

### 3.3 P1 定向 Node / Python / Server 起点

先确认文件仍存在，按当前改动增减目标并记录理由；下面不是覆盖全部功能的永久固定白名单：

```powershell
& $Python scripts/run_check.py --timeout 180 -- node --test tests/test_project_tracks.mjs tests/test_project_track_operations.mjs tests/test_project_boundary.mjs tests/test_v2_migration_save.mjs
& $Python scripts/run_check.py --timeout 180 -- node --test tests/test_v2_track_commands.mjs tests/test_speaker_identity.mjs tests/test_speaker_merge_guards.mjs tests/test_speaker_experience.mjs
& $Python scripts/run_check.py --timeout 180 -- node --test tests/test_editor_script_syntax.mjs tests/test_editor_script_order.mjs tests/test_ass_cue_position.mjs tests/test_split_style_markers.mjs
& $Python scripts/run_check.py --timeout 180 -- $Python scripts/run_tests.py tests/test_project_tracks.py tests/test_project_boundary.py tests/test_v2_migration_save.py tests/test_speaker_identity.py
& $Python scripts/run_check.py --timeout 300 -- $Python scripts/run_tests.py tests/test_local_editor_server.py tests/test_project_io.py tests/test_packaging_contract.py tests/test_gui_web.py
```

新增 main 行为还要选择 `tests/test_waveform_cue_quick_edit.mjs`、`tests/test_launcher_segmentation_prefs.mjs`、`tests/test_runtime_mirror_retry.py`、`tests/test_term_extract_fixture_paths.py` 等，按真实差异扩展。它们写计划时在 main，而不是全部已经在 2.0dev 中。

### 3.4 真实浏览器与服务清理

只跑受影响的单 spec，默认同一时间一个；配置文件显式给出。下面每个命令最长 600 秒，外层命令限时需更大：

```powershell
& $Python scripts/run_check.py --timeout 600 -- node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium --workers=1 tests/e2e/unified-tracks.spec.mjs
& $Python scripts/run_check.py --timeout 600 -- node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium --workers=1 tests/e2e/v2-migration-save.spec.mjs
& $Python scripts/run_check.py --timeout 600 -- node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium --workers=1 tests/e2e/waveform-cue-quick-edit.spec.mjs
```

其他必需场景按总计划选择 `editor-transactions`、`editor-text-tools`、`word-timing`、`warma-presets`、`ass-cue-position`、说话人、烧录和贴纸相关 spec，不能只跑上述三个就宣布 G1 全通过。

先读[服务挂起排查](../engineering/E2E_SERVER_HANG.md)。失败或中断后只清理 CommandLine / PID 能确认属于本工作树的服务；不能杀其他 agent 的实例。连续两次同类失败停下来分类，不循环重跑。

人工服务用独立终端启动，用完退出并查进程真实消失。需要操作浏览器时加载相应技能；不要用 shell 后台 `&` 挂服务。浏览器不可用时记录本层阻塞，不能以静态检查冒充交互通过。

### 3.5 阶段验收的扩展检查

```powershell
& $Python scripts/run_check.py --timeout 900 -- $Python scripts/run_tests.py
& $Python scripts/run_check.py --timeout 180 -- $Python scripts/check_docs.py
& $Python scripts/run_check.py --timeout 180 -- $Python scripts/run_tests.py tests/test_docs_check.py
& $Python scripts/run_check.py --timeout 180 -- $Python scripts/check_personal_paths.py
& $Python scripts/run_check.py --timeout 180 -- git diff --check
```

全量 Node 可从 `tests/` 显式枚举根 `.mjs` 文件传给 `node --test`，或通过文件化的 pwsh 启动器执行 `pnpm run test:unit` 并原样返回 exit；不要把根全量与 desktop 子目录单测混淆。全量 Chromium 默认留给 CI / 专项验收，受影响 spec 先完成。

失败在基线也存在时，需要相同环境、相同命令和输出证据才可标为既有；即使既有，必要门槛未满足仍需维护者处置，不能自己宣布“不相关”并通过。

个人路径检查默认只扫描暂存新增行，`--diff-ref` 只扫描提交差异，`--all` 只看已跟踪文件。**未跟踪的新文档 / 测试必须另外检查**；不能在没有暂存文件时运行默认模式后宣称“全部新文件已扫描”。换行检查也要覆盖新文件的原始字节，而不只是 `git diff --check`。

## 4. P2 Launcher 迁移具体参考

### 4.1 冻结来源与差异

```powershell
git log --no-merges --oneline origin/2.0dev..origin/feat/launcher-ui-modernization
git diff --stat origin/2.0dev origin/feat/launcher-ui-modernization -- web/launcher web/launcher-scripts.txt maw/gui_web.py tests
git show cba3ec701539b677dc282b90406f41c1d753d58d:web/launcher/boot/launcher-navigation.js
git show cba3ec701539b677dc282b90406f41c1d753d58d:web/launcher/boot/launcher-postprocess-ui.js
```

两点比较的 stat 展示全部树差异，不等于“全部要取”；已经被新基线包含的功能不要重复搬。冻结来源后逐个查看产品模块，保存来源 / 目标映射与取舍。

### 4.2 文件与行为地图

| 来源（PR 235） | 功能 | 目标适配重点 |
| --- | --- | --- |
| `web/launcher/boot/launcher-navigation.js`、`launcher-workflow-ui.js` | 页面导航和转写状态 | 与真实 task 状态同步，不只是样式切换 |
| `web/launcher/boot/launcher-postprocess-ui.js` | 工具拆分、共享表单与配置抽屉 | 异步取消与 provider 配置检查不得回退 |
| `web/launcher/boot/launcher-projects-ui.js` | 最近工程、搜索、重新定位 | 与 Server 记录统一；所有工程打开共用保护 |
| `web/launcher/index.html`、`launcher.css`、i18n 与清单 | 页面结构、布局、文本与初始化 | 保留 main 新字段和版本标记，2.0 不显示退役入口 |
| `maw/gui_web.py`、`batch.js`、`postprocess.js` | 原生桥、任务载荷和 bundle 外脚本 | 继续 window.MAWLauncher 桥，不在独立脚本中假设 bundle 词法可见 |

当前[设计方案](LAUNCHER_REDESIGN.md)部分早期文字仍提浏览器 / 便携入口；本次总计划和版本政策优先，不能把旧设计逐字复刻成退役入口。

### 4.3 测试起点

PR 235 来源中已有 `tests/e2e/launcher-redesign.spec.mjs`、`launcher-upstream-sync.spec.mjs`，先用 `git ls-tree` 核对。新版基线已有 `launcher-interactions`、`launcher-provider-gate`、`launcher-recent-projects`、媒体绑定、缩略图和偏好单测，全部按实际涉及行为选择。

真实 pywebview 必须覆盖准备 → 运行 → 取消 / 失败 → 完成 → 打开工程，不使用真实 Key 的场景可用测试服务器；真实云端 / 本地模型若未跑，单列为未验收，不因 mock 成功声称模型通过。

## 5. P3 Electron 迁移具体参考

### 5.1 不在旧冲突现场取“最终文件”

安全查看历史提交：

```powershell
git ls-tree -r --name-only cac704487ce451457568d02b1c59a3a1f7c4253b desktop
git show cac704487ce451457568d02b1c59a3a1f7c4253b:desktop/README.md
git show cac704487ce451457568d02b1c59a3a1f7c4253b:desktop/src/backend_runtime.cjs
git show cac704487ce451457568d02b1c59a3a1f7c4253b:desktop/src/file_registry.cjs
```

大文件先按符号定向读，不整份打印旧 `server-editor/serve.py`。不要从 277 冲突现场直接复制文件；它可能含未解决标记、暂存一半的内容或用户 WIP。

当前主线 / 2.0 的 `desktop/` 仅保留 README，README 提到“实现已完成”说的是旧分支。先确认实际 `desktop/package.json` 是否存在，避免在当前目录直接运行并不存在的桌面构建命令。

### 5.2 要迁入的能力，不是文件数量

| 历史实现 | 新版接入方式 | 关键断言 |
| --- | --- | --- |
| Electron main / preload、后端 runtime helper | 原生能力的受限适配；共用新版 Server 与 web | Renderer 不暴露 fs / spawn；错误 IPC 来源被拒绝 |
| `MAW_DESKTOP_READY` 协议 | 有界解析、来源只取本实例 child stdout、校验 loopback / 端口，页面在 ready 后加载 | 假日志 / 未就绪 / 超时不能当成功，失败只清本实例 |
| `MAW_DESKTOP_TOKEN` 与 `MAW_DESKTOP_COMMAND_KEY` | 通过受控子进程环境传递，命令密钥不下发 Renderer | 页面 token 不能调用 `/api/desktop/command` 特权写操作 |
| 原生路径登记 / open / save | 在新版已有工程边界之上接命令，保持媒体 binding 与 generation / revision 保护 | 路径替换、外部改写、迟到保存确认不得误覆盖 |
| 偏好持久化 | Electron userData 服务替换 browser origin 存储，保留当前键域和 D2 隔离 | 随机端口与重启可恢复；稳定 / 体验用户数据不串 |

当前 `web/editor/boot/editor-host.js` 有工厂覆盖入口，也会创建默认 `window.MaweHost`。需要明确初始化时机，让实际业务消费者使用选定 host，而不是仅注入一个未使用的 bridge。测试应验证产品动作确实调用该 host，并保留 Server 默认实现。

### 5.3 原生 IO 状态机建议

这是一组实现约束，不要求机械照抄函数名：

```text
选择文件 / 已登记引用
  → 主进程校验来源与操作类型
  → Server 以当前工程代次准备候选
  → 准备格式 / 迁移 / 媒体解码；失败保留当前工程
  → 一次提交新状态，更新绑定 / revision
  → 仅在当前内容仍等于已保存内容时清除 dirty
```

关闭 / 切工程在“保存后继续”期间再次发生编辑，必须停留或再次要求处理，不能只看旧 save Promise resolve。备份 / 最近工程更新失败与主文件保存失败需区分，不得因附属记录失败丢掉已成功的主文件绑定。

媒体重绑定不能只有 FFprobe 探测：先拿候选 ticket，由实际播放器证明可解码，再让 Server 校验 generation 并提交。取消 / 失败清理候选，不改变旧媒体与字幕。

### 5.4 旧测试的迁移顺序

历史来源包括 `desktop/tests/{backend_runtime,file_registry,linux_integration,packaging,preferences,runtime_helpers}.mjs` 和 `desktop/e2e/{project-flow,media-transaction,lifecycle,preferences}.mjs`，以及 `tests/test_desktop_editor.py`、`tests/e2e/launcher-mose.spec.mjs`、`desktop-path-menus.spec.mjs`。

先将 fixture / 断言改为真实 v2 工程再运行；不可把旧 v1 保存结果当新版规范输出。Node 单测与 Electron 原生 e2e 分层。真实打包壳可通过旧测试约定 `MOSE_TEST_EXECUTABLE` 指向新候选，先核对迁入后脚本实际读取该变量。

迁入 desktop 子项目后，先审查 lockfile 与版本；旧来源用 npm package-lock，不得为了工具统一顺手清空锁文件或升级 Electron。可暂保持独立锁定子项目；迁移到 pnpm 如有必要，另设小批次与明确验收。

## 6. P4 Installer、构建和发布接线参考

### 6.1 当前与历史路径对照

| 内容 | 当前 2.0 基线 | 历史桌面来源 |
| --- | --- | --- |
| MAW 打包定义 | `scripts/packaging/MAW.spec` | 根 `MAW.spec`，不得覆盖当前结构 |
| Windows 主构建 | `scripts/build-windows.ps1` | 同名旧脚本有桌面接线，需逐块移植 |
| Electron 构建 | 尚未迁入 | `desktop/scripts/build.mjs`、`electron-builder.config.cjs`、package 配置 |
| staging / Installer | 尚未迁入 | `scripts/stage-mose-bundle.ps1`、`build-installer.ps1`、`installer/maw.iss` |
| 发布上传 | `scripts/publish_release.py` | 旧 release workflow / update manifest 不能整体覆盖新版发布治理 |

### 6.2 构建前先审阅脚本副作用

当前 `scripts/build-windows.ps1` 包含 `uv sync --group build --frozen`、裸 `uv run`、PyInstaller `--clean`，还需要准备 bootstrap 资源。它是开发者构建入口，**不是 Agent 可直接在共享环境无脑执行的测试命令**。

P4 应使用专用构建环境：先由维护者 / 授权环境准备依赖，再把自动化调用调整成可控的 no-sync 路径或已选解释器；保持原脚本默认行为兼容，新增模式须有测试。不要仅把 `uv sync` 删掉导致新用户无法构建。

所有 staging / dist 使用本次专属输出目录，记录路径归属。旧 staging 只 Copy-Item 覆盖，不保证删除残留，必须从干净专属目录生成并校验；需要清理时遵守回收站规则。

建议构建顺序为下面五个检查点，单独记录结果，不合成长命令：

1. 确认依赖和版本，构建 Editor / Launcher，检查 fresh / type。
2. 构建 PyInstaller MAW 后端，检查资源、CLI、Server 和 v2 契约。
3. 构建 Electron 壳，验证指向同套件后端，不下载 / 内置另一份 Python。
4. staging 后统计 MAW / FFmpeg / FFprobe / Python 运行时，按白名单扫描危险资源。
5. 编译 Inno Installer，计算大小 / SHA-256，转入隔离机器安装验收。

不能为了打包通过加入本机模型、媒体、临时截图、`.env` 或绕过 missing asset 检查。

### 6.3 Installer / 渠道身份

先核对 D2 决定。旧 `installer/maw.iss` 固定 AppId / 通用目录，`scripts/test-installer.ps1` 固定用户安装 / 配置根，因此**隔离渠道后两者必须一起适配**。不能只改一个默认目录就声称可并存。

| 需要的回归 | 验证点 |
| --- | --- |
| 同渠道 A → B 升级 | 固定 AppId；版本检测正确；文件更新；用户配置保留；不能用重装同版代替 |
| stable 与 Starlight 并存 | 安装 / registry / userData / 配置根 / 单实例都隔离；从任一 Launcher 开到正确版本 |
| `.mosp` 关联 | HKCU 范围、不要求管理员；不碰 `.json`；尊重 UserChoice；命令正确引用含空格路径 |
| 卸载所有权 | 只卸自己的目录和注册项；不删除用户工程、配置或另一渠道的关联 |
| 安装失败 / 取消 | 不强制关闭含未保存编辑的窗口；明确可恢复状态，不宣布“升级成功” |

旧 smoke 有 `-AllowDestructive` 或 `CI=true` 的门；这些不是日常机器安全性证明。不要运行旧 smoke，也不要为其设置 CI=true。准备干净 VM / 测试账户 / 专用 runner 后，经维护者批准使用改好的 smoke。

### 6.4 发布脚本不能漏 Installer

`scripts/publish_release.py` 当前 mandatory 资产为 Windows full / lite ZIP，并可追加 macOS / Linux。需要为新交付模式显式设计 Installer 的 required / optional 规则：保持已有稳定发布约定，不把“只发 Installer 的受限 Starlight”误套进公开 stable 发布。

| 接入点 | 必须测试 |
| --- | --- |
| `scripts/publish_release.py` | Installer 存在且非空、精确命名、上传状态 / 大小校验；缺必需包时不公开草稿 |
| `.github/workflows/release.yml`、预览工作流 | 装配 / 产物传递 / 平台结果；不运行未授权公开发布；可取回确切 SHA 测试包 |
| `scripts/prepare_release_notes.py` 与 `scripts/build_release_site.py` | 只列实际附件，稳定索引不推荐体验版；Installer 文案与平台支持一致 |
| 更新 manifest（仅 D5 纳入时） | 对应 exact tag / 平台 / 附件大小和 hash；旧文件 / 重复文件 / 损坏资产失败 |
| License / notices / 安全扫描 | Electron、安装器、FFmpeg 和 Python 依赖的说明保留；秘密不进附件与日志 |

首批如不做自动更新，Launcher 明确显示手动更新说明。D4 若选择受限下载，旧 updater 的 GitHub 域白名单和来源认证需另行设计，不偷删安全限制。

## 7. P5 版本、文档和渠道验收参考

### 7.1 版本同步清单

| 入口 | 要检查的真实版本 |
| --- | --- |
| 项目 | `pyproject.toml`，及需要刷新时的锁文件元数据 |
| 现有同步器覆盖 | `web/launcher/index.html`、mock API、`maw/diagnostics.py`、`edit.py` fallback |
| 迁入桌面 | `desktop/package.json`、package lock、electron-builder metadata、实际 exe 版本 |
| Installer / 更新 | Inno AppVersion、DisplayVersion、产物文件名、manifest（若启用） |
| 发布 / 渠道 | tag、Release notes、源码 SHA、stable / Starlight 标识与附件事实 |

版本确认后可运行现有同步命令；这不涵盖桌面和安装器，必须补齐统一检查：

```powershell
& $Python scripts/run_check.py --timeout 180 -- $Python scripts/sync_launcher_version.py --write
& $Python scripts/run_check.py --timeout 180 -- $Python scripts/sync_launcher_version.py --check
```

不要手工只改页头 v2。必须实际测 `maw/editor_entry_policy.py` 的 2.x prerelease 规则，以及打包 / CLI / Pages 的退役入口，不能运行 `edit.py --blank` 重生成历史 HTML。

### 7.2 文档与官网同步

```powershell
& $Python scripts/run_check.py --timeout 180 -- node website/scripts/sync-maw-docs.mjs
& $Python scripts/run_check.py --timeout 180 -- $Python scripts/check_docs.py
& $Python scripts/run_check.py --timeout 180 -- $Python scripts/run_tests.py tests/test_docs_check.py
```

用户指南 / 索引改变后，用同步器更新生成副本，不手改 `website/src/pages/docs/`。需要网站 check / build 时在匹配版本的 Node 和准备好的 website 环境中执行，通过文件化启动器保留 pnpm 的 exit。缺依赖或版本不符记录为该层阻塞，不为了写文档自动安装整套依赖。

beta / rc 只维护 CHANGELOG 并生成临时 Release notes；`--write-doc` 仅用于正式版，具体见[发布正文规则](../releases/README.md)。签名缺失、平台未测和付费分发策略不能藏在长日志里，必须进入候选说明。

### 7.3 必需的人工核验源文件

阶段完成时按 `verification-checklist` 技能创建 `.checklist.md`，参照[工具契约](../../tools/verification-checklist/README.md)，不要把本执行手册改名当可生成清单。示例必须填实际日期 / task / 基线，初始 status 为 pending。

````markdown
---
task: maw20-integration
date: YYYY-MM-DD
status: pending
---

# MAW 2.0 · 本阶段人工核验

> 本阶段、实际源码 SHA、自动化范围及人工未测边界

## 人工核验
<!-- id: manual-project -->

- [ ] **确认旧工程升级取消时不改写源文件**
  （操作）使用测试副本打开 v1 工程，编辑后触发首次保存，在另存对话框取消。
  （预期）源文件字节和哈希不变，编辑窗口保留未保存状态；原件仍可在旧版打开。
  <!-- id: legacy-save-cancel -->
````

示例只是源格式片段，阶段完整清单还需实现 / 审查、记录、自动化、人工与后续步骤分区。必须用真实产品操作而不是“检查代码里有某字符串”作为人工验收。

## 8. 源码与证据导航

### 8.1 当前分支优先阅读

| 主题 | 参考 |
| --- | --- |
| 工程与迁移 | [格式契约](../engineering/JSON_SCHEMA.md)、[轨道实施](UNIFIED_TRACKS_PLAN.md)、[说话人核心](SPEAKER_IDENTITY_CORE_PLAN.md) |
| Launcher | [设计方案](LAUNCHER_REDESIGN.md)、[原型说明](launcher-redesign/README.md)、PR 235 |
| 构建 / 测试 | [开发概览](../engineering/DEVELOPMENT.md)、[有界调试](../engineering/DEBUG_WORKFLOW.md)、[e2e 挂起](../engineering/E2E_SERVER_HANG.md) |
| 发布 / 安装入口 | [发布规则](../releases/README.md)、[现有桌面说明](../../desktop/README.md)、当前 `scripts/packaging/MAW.spec` |
| 历史 main 整合 | [PR44 同步复核](../logs/release1.10.0-beta.2/261106_PR44同步main/REVIEW_FINDINGS.md)、[另一轮同步复核](../logs/release1.10.0-beta.2/261106_main合入2dev/REVIEW_FINDINGS.md) |

### 8.2 固定的旧分支源码入口

以下链接固定到已核查提交，不能把它们当当前工作树路径。GitHub 不可用时用 `git show <SHA>:<路径>` 读取本地对象；对象缺失才申请从正确来源 fetch，不猜内容。

| 来源 | 固定入口 |
| --- | --- |
| Launcher 源 | [cba3ec70 的 Launcher](https://github.com/Moyf/moys-asr-workflow/tree/cba3ec701539b677dc282b90406f41c1d753d58d/web/launcher) |
| Launcher 最新整合记录 | [同步 2dev 自审](https://github.com/Moyf/moys-asr-workflow/blob/cba3ec701539b677dc282b90406f41c1d753d58d/docs/logs/release1.10.0-beta.2/261102_Launcher同步2dev/REVIEW_FINDINGS.md) |
| Electron 说明与源码 | [cac70448 desktop](https://github.com/Moyf/moys-asr-workflow/tree/cac704487ce451457568d02b1c59a3a1f7c4253b/desktop) |
| Installer 定义 | [maw.iss](https://github.com/Moyf/moys-asr-workflow/blob/cac704487ce451457568d02b1c59a3a1f7c4253b/installer/maw.iss) |
| 原生工程操作 PR | [PR 199](https://github.com/Moyf/moys-asr-workflow/pull/199)；合入目标是旧 `merge/starlit-main`，不是当前 main |

旧 Electron 依赖版本（44.1.0）只代表历史来源，不保证当前安全和兼容性；迁入时检查安全维护状态、锁文件和 API，若需升级另建小批次，不能边升级边归因迁移故障。

**本页不能改变总计划的授权边界。遇到未确认决定、旧 WIP、数据风险或测试阻塞，停止并写账，不靠猜测继续。**

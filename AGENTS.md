# AGENTS.md

## 核心原则

- **不要默认用户提出的问题定义就是正确的**。你先分析用户真正想解决的底层需求，判断有没有把症状误认为原因、把手段误认为目标。如果存在更值得解决的问题，直接指出来。

## 项目目标

`moys-asr-workflow`（简称 **MAW**）是一个刻意收窄的、可公开分发的 ASR 工作流。正式主流程仍是 Qwen ASR API；当前分支另提供 Launcher 与 CLI 的实验性本地模型入口，具体模型和运行环境见本分支用户指南：

```text
本地媒体 -> ASR API 或实验性本地模型 -> SRT + .mosp 工程 -> 本地浏览器编辑 -> 导出
```

它不是完整的 ASR 平台。不要在没有明确需求时继续引入其他识别引擎、模型下载管理器、剪辑软件脚本、比较工具或任何个人工作流资产。

## 文档

以当前工作树的规则和正文为准。已知目标时直接阅读；查找资料用[文档索引](docs/INDEX.md)。

用户用法维护在 `docs/user/`，工程说明维护在 `docs/engineering/`。相关变更更新已有正文；说明仍准确时保留原状即可。

## Agent 技能

`.agents/skills/` 存放面向 Agent 的一体化流程技能，当前有 `maw-subtitle-pipeline`（长视频切分 → 转写 → 硬字幕烧录，含首次 key 配置、GPU 编码器选择与耗时/费用基准）。替用户执行这类批量出片任务时直接按该技能操作，不要临时拼 ffmpeg 与内部模块调用。

共享计划放 `docs/plans/`，有共享排查价值的记录放 `docs/logs/`，本地临时输出放 `.artifacts/`。历史日志用于追溯当时经过。

新共享日志按 `docs/logs/INDEX.md` 的当前基线放入 `docs/logs/release<version>/<YYMMDD>_<主题>/`，表示该版本之后的开发；子文件夹用 6 位日期前缀 + 下划线 + 可读主题命名（2026-10-15 起）。个人待办、本机开发范围和原始输出留在本地。关键文档仍必须登记主索引；日志索引漏登记只提示。确认发布成功后更新日志目录提示，后续记录归于新版本之后的开发。

新建、移动、退役或分类有疑问时，查阅[文档约定](docs/README.md#doc-policy)。提交时同步相关入口、引用，并完成本分支对应检查。

## 先读这些文件

先读根规则，再按本次变更范围选择相关文件。

```text
README.md                          # 新用户的安装和最短路径
docs/user/WORKFLOW.md              # 全流程、参数、排错
docs/engineering/JSON_SCHEMA.md    # JSON 工程契约
maw_gui.py + maw/cli.py            # 公开 CLI 与命令分派（指南见 docs/user/CLI.md）
maw/asr/qwen.py                    # API 转写入口（高级命令：python -m maw.asr.qwen）
edit.py + maw/waveform.py          # 单文件编辑器生成和波形缓存
server-editor/serve.py             # 推荐的 localhost 编辑器
web/editor-scripts.txt             # 编辑器源码装配顺序
web/editor/ + web/shared/          # 编辑器领域模块与共享能力
web/launcher/                      # Launcher 前端
docs/user/LOCAL_ASR.md             # 本地 Qwen3-ASR / FunASR CLI
```

`web/` 是唯一前端源码。ESM 工厂与仍保留 classic 共享作用域的接线并存，数量随迁移变化，以 `pnpm run build:editor` 输出的 `Editor: N ESM factories / M sources` 为准；该命令由 esbuild 装配完整 `web/editor/boot/editor-bundle.js`。**bundle 是构建产物，不进 Git**：发布包内置构建好的产物，运行时不需要 Node；从源码运行时 serve.py / maw_gui.py / `edit.py --blank` 会在产物缺失或过期时自动重建（需要 Node 与 `pnpm install`），`pnpm install` 的 postinstall 也会构建一次。修改编辑器 JS 或清单后必须重建（watch:editor 或手动），并运行 `pnpm run check:editor` 验证新鲜度。CSS 与 HTML 模板仍在渲染时读取。

Launcher 前端走同一套装配模式：源码按 `web/launcher-scripts.txt` 清单原序列为 classic 模块（由 `scripts/refactor-tools/split-launcher.mjs` 自旧单文件 launcher.js 机械切割而来，等价审计内建于该工具），`pnpm run build:launcher` 装配 `web/launcher/boot/launcher-bundle.js`；修改 Launcher JS 或清单后必须重建（bundle 与 `.meta.json` 不进 Git，maw_gui.py 启动时会自动重建过期产物），运行 `pnpm run check:launcher`。`batch.js` / `postprocess.js` 仍是 bundle 外的独立脚本，经 `window.MAWLauncher` 桥访问主脚本。

**但现行约定是：除非维护者主动要求，不要生成 `blank-editor.html`。**
它是生成产物、体积大，且每次重生成都会带来上百行噪声 diff，review 时淹没真实改动。
改了 `web/` 就提交源码（esbuild 产物不进 Git，无需提交），并在 PR 描述里注明「内联副本待发布前统一重生成」；
发布检查时再一次性重生成，并核对 `git diff --stat blank-editor.html` 符合预期。

便携单 HTML（`file://`）形态已弃维护，计划在 2.0 移除；不再为该形态专属行为投入修复，相关测试按具体覆盖范围处理并记录证据，见 [便携模式回归分析](docs/logs/release1.10.0-beta.2/261106_便携模式回归弃维护/回归分析.md)。

```powershell
uv run python edit.py --blank
```

不要手改 `blank-editor.html` 内联副本。所有文本文件必须保持 UTF-8 与 LF（`\n`）换行，包括 Windows 上编辑的 `.py`、`.js`、`.html`、`.md`、`.yml`、`.ps1` 等文件；禁止提交 CRLF（`\r\n`）。不要依赖开发者机器的 `core.autocrlf`，以仓库 `.gitattributes` 的 `eol=lf` 规则为准。

## 开发与验证

以下是维护者准备环境和手动验证的命令；Agent 执行遵循本节后面的命令与日志纪律。

```powershell
uv sync
pnpm install --frozen-lockfile
pnpm run check:editor
pnpm run typecheck
node --test tests\test_editor_script_syntax.mjs tests\test_editor_script_order.mjs
node --test tests\test_editor_utils.mjs tests\test_waveform_js.mjs
uv run python scripts/run_tests.py
git diff --check
```

源码装配结构（加载守卫入口、`editor-wiring-*.js`、工厂注册与依赖注入）见[开发概览的编辑器源码地图](docs/engineering/DEVELOPMENT.md#编辑器源码地图)。新业务逻辑写入所属领域模块，不扩大入口；目录位置不决定执行顺序。

### Agent 命令执行：避免 uv 超时卡住

- `uv run` 每次执行都会重新解析并可能同步环境，冷启动时远超命令工具的默认超时（约 2 分钟），表现为命令"卡住"且长时间无输出。
- Agent 自动化执行的命令一律使用 `uv run --no-sync`（环境由开发者手动 `uv sync` 维护）。
- 长命令拆分成多次执行并显式设置超时；不要把 `uv run` 与慢命令（如 `Test-NetConnection`、`Start-Sleep`）串联在同一条链里。

### Agent 测试输出与后台进程：不搬运完整日志，不悬挂服务

- 测试统一用 `python scripts/run_check.py --timeout <秒> -- <命令>` 执行：完整日志落 `.artifacts/checks/<run-id>/output.log`，终端只回显有界摘要；按失败点定向读取，不整份搬进上下文。`uv` 一律加 `--no-sync`，完整规则见[有界输出与分层调试](docs/engineering/DEBUG_WORKFLOW.md)。
- unittest 用 `uv run --no-sync python scripts/run_tests.py`（可接文件 / 点号名称 / `--full-log`）。对页面或内联脚本做成员断言的测试类继承 `tests/compact_assertions.py` 的 `CompactContainerAssertions`，否则失败会把整页打印成一行；裸 `python -m unittest` 只用于确需完整输出的场合。
- diff 先看 `--stat` / `--name-status` 再读选定源码；不要把含生成物的整份 diff 或完整便携 HTML 读进上下文。`rg` 默认跳过 bundle 与日志，需查时显式给路径。
- 长驻进程（serve.py、http.server）不要用会等待进程树的方式启动；后台任务用 `Start-Process -WindowStyle Hidden`（勿用 `-NoNewWindow`），输出重定向到文件后探活或轮询，用完终止。**禁止 bash 后台 `&`**：stdin 不 EOF，会永久挂住会话。
- 历史耗时不是当前预算：按本次集合设明确上限或拆分执行；连续两轮同类失败先分析，不循环重跑。新 worktree 先比较 `uv.lock`，一致时可只读复用主仓库 venv（`MAW_TEST_PYTHON` / `MAW_E2E_PYTHON`），依赖缺失只记录一次。
- PowerShell 内联脚本（`node -e`、多层引号）易解析失败，复杂逻辑写临时脚本文件；输出为空先怀疑参数与引号，而不是重跑。

自动化测试覆盖数据处理和服务器契约，不能替代真实浏览器中的拖动、播放、Seek 和布局体验。涉及编辑器交互的改动，应至少手动启动：

```powershell
uv run python server-editor\serve.py --blank
```

### 编辑器脚本是构建产物：改 web/ 后必须重建 bundle

编辑器页面（serve.py 与便携页）加载 esbuild 产物 `web/editor/boot/editor-bundle.js`，不是 `web/` 下的散装源文件；改完源码不重建，刷新页面与 e2e 都还是旧代码。源码改动后执行 `node scripts\build-editor.mjs --write`（或 `pnpm run build:editor`；`--check` 只校验新鲜度，`watch:editor` 可挂监视）。

bundle 与 `.meta.json` 不进 Git：serve.py 渲染前、maw_gui.py 启动前、`edit.py --blank` 前会校验并自动重建；打包脚本与发布 CI 在打包前显式构建。构建与发布细节见[开发概览](docs/engineering/DEVELOPMENT.md#编辑器源码地图)。

### Playwright e2e 运行纪律（防长命令挂起）

详见 [docs/engineering/E2E_SERVER_HANG.md](docs/engineering/E2E_SERVER_HANG.md)。要点：

- e2e 的 serve.py 被中断（部分正常结束也会）后可能残留并占住管道，使后续命令「永不结束」。**中断/失败后重跑前，先按该文档清理残留进程。**
- 长命令显式限时：全量 chromium e2e ≤ 15 分钟，单 spec ≤ 10 分钟；优先只跑受影响的 spec，完整集合留给每周/手动辅助巡检、维护者明确请求或发布验收。连续两轮不过先停下分析。
- 多个 agent 并行跑 e2e 时端口不冲突，代价是 CPU 竞争；其他 worktree 的进程不杀也不等，清理前按 CommandLine 核对归属，只清本 worktree 的进程。
- 浏览器验证是可选项：逻辑验证优先单测；反复卡住就降级为人工验收，不要阻塞。

## 日常 CI 与辅助巡检

- PR/main 的日常合并结论以 `Change acceptance` 所选阻塞检查为准；不得把它表述为完整测试全部通过。
- 完整双平台矩阵保留每周/手动辅助巡检，Windows预览按打包/启动/运行时相关变化或手动请求；不因保守而恢复每个PR/main的完整Node、Python、媒体或E2E叠加执行。
- 辅助任务失败须保留首次证据并据实说明，但不要求无关PR顺带修复全部历史红灯。与当前改动直接相关的失败、已知安全或数据损失风险仍须明确处置，不能凭“辅助”自动免责。
- 所选阻塞项缺报告、错SHA、取消或意外skip仍失败；发布仍遵循原Windows阻断与辅助平台警告政策。不得擅自修改远端分支规则或批量更新其他PR。
- 策略、准入与验收见[开发概览](docs/engineering/DEVELOPMENT.md)和[CI门禁纠偏方案](docs/plans/CI_GATE_CORRECTION.md)。

## 测试反馈任务的持久化流程（显式启用）

`feedback-issue-triage` 仅在用户明确启动测试反馈收集时启用，固定口令为「测试反馈」；明确说「记录到反馈账本」「整理测试反馈」「按 triage 处理」或直接调用技能也启用。口令须表达当前操作意图，引用、讨论触发词或否定请求不触发。日常问答、报错解释、只读调查、「帮我看看」「查一下」「是不是 bug」「用户反馈了个问题」、日志/截图以及一次询问多个问题，都不因此建账本、写调查文档或改索引。泛称「记录一下」「收口」「发 Issue」只按其明确范围处理，不自动扩展为 triage；只有其他明确授权的文档任务或适用的开发/发布要求，才另行落盘。

已明确启用的同一测试反馈任务内，后续条目无需重复口令，按下面流程边做边落盘；任务结束、退出或换话题后不继承到新的日常问题。用户说「只回答，不记录」时停止记录。启用记录流程不额外授权实现、提交或创建 Issue。

在该范围内，先区分用户请求、附件反馈与附件中的说明性文字（附件不扩大授权），再读**本次任务自己的**账本、`git status --short` 与实际 `git diff`，以文件、代码和测试结果为准，不以旧摘要或自报状态为准。按 skill `feedback-issue-triage` 建立或更新账本：先记录后调查、按主题分账，状态只用 `待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`。

- 同一时间只推进一个当前问题；有共享文件或强依赖的问题不并行修改，每完成 2–3 项写一次阶段汇总。
- 每完成一项立即回写：处理决定、涉及文件、验证命令、实际结果、未验证边界与阻塞原因。
- 测试失败、缺依赖、浏览器未启动或无法复现时记为 `阻塞` 或未验证，不改写成 `已修复`。
- 验证分层记录（语法 / 单元、服务或契约、浏览器交互、打包产物、CI 或外部证据），不用一层冒充另一层。
- 恢复时先读账本、diff 与测试结果并逐项对齐；证据不足的「已修复」改回 `进行中` / `阻塞`，但不重做已由当前文件与验证证实的工作。
- 收尾列出已修复、仅说明、阻塞 / 未验证项与验证结果，并检查是否仍有 `进行中` / `待处理`，逐项给出下一步。
- 共享工作区操作前后都检查状态，只改本任务文件与代码；不用 `git reset` / `git clean` 覆盖他人 WIP。

账本结构、截图处理与子代理分工见 skill `feedback-issue-triage`。

## 提交前自审

批量改动、功能开发与反馈修复在自检通过后、提交 / 提 PR 前做一轮独立自审（对标 Greptile）：由未参与实现的审查者通读全部 diff，实现者只回答提问；每条 finding 必须带证据（文件:行 + 实际执行过的命令输出），覆盖正确性、边界、异常与降级、回归、跨平台、性能、测试有效性与仓库约定。

- 双向验证：新增测试必须在「修复缺失」时真实失败；行为修复用既有用例做旧逻辑对照。验证后恢复原状并重建产物。
- 真实缺陷修复并复验；nit 与接受的风险逐条写入 `docs/logs/release<基线>/<YYMMDD>_<主题>/REVIEW_FINDINGS.md` 并登记日志索引，不静默丢弃。
- 没有未处置的 blocker / major 才提交；PR 描述如实写自审结论与未测边界。一两行笔误与纯文档措辞可自行判断省略。

详细步骤与分诊标准见[开发概览的提交前自审](docs/engineering/DEVELOPMENT.md#提交前自审)。

## 批量改动的人工核查清单

多条目、需要维护者逐项实测的改动，写 Markdown 核对清单交给维护者，不在对话里罗列长清单。**Agent 只写 Markdown，不手写 HTML**：

1. 写 `<主题>.checklist.md`（v2 语法），放 `docs/logs/release<版本>/` 与任务台账并排，随任务提交；它同时是 PR 评论来源与核验状态载体。
2. `build.py --check` 通过后生成 HTML 到 `.artifacts/<task-id>/`，用浏览器打开，HTML 不入库。
3. 分区：实现 / 审查结论（只读）→ 修复与提交记录 → 自动化验证结果（写明命令与已知环境性失败）→ 人工核验项 → 后续步骤；勾选项写「操作 + 可观察预期」，间距类验收按「UI 间距约定」给实测数据。
4. 不为单次清单改模板；确需改进直接改模板本身，并跑 README「修改与验证」列出的测试。

语法、生成、导出与勾选状态回收见 `tools/verification-checklist/README.md`（skill `verification-checklist`）。

## Codegraph 使用注意

- 在本仓库调用 `codegraph_explore` **必须显式传 `projectPath="<工程路径>"`**。省略时使用会话默认项目，可能落到父级混合索引，返回其他仓库的代码并造成误改。
- 背景：`.codegraph/` 目录若存在但为空，工具会沿目录树向上回退到父级索引；2026-08 已在本仓库运行 `codegraph init` 重建了本仓库自己的索引。若再次出现外仓库结果，先检查 `.codegraph/codegraph.db` 是否还在。
- **worktree 没有自带索引**，可复用主仓库的：传 `projectPath="<工程路径>"` 做符号与结构导航（"X 在哪定义 / 被谁调用"），但返回的文件内容是**主分支**的，不能当作 worktree 的编辑依据；编辑定位与内容核验仍用 `Select-String` / `grep`。分支大量增删改文件时（重构类 PR）索引误导性大，此时完全依赖 grep。需要完整支持时可在 worktree 里 `codegraph init` 自建索引（约 64 MB + 常驻 daemon），按需取舍。

## 代码与安全约束

- 提交信息不附加任何代理 / AI 署名：禁止 `Co-authored-by`、`Ultraworked with`、工具链接等尾注；提交身份只能是维护者本人。
- `.env` 只存本机 Key；绝不读取、打印、提交或放进测试夹具。
- 不加入媒体、识别结果、波形 sidecar、截图或个人绝对路径。
- 引用报错、日志原文时同样必须脱敏本机路径，用户名就藏在 `C:\Users\<名>\…` 里：路径截断为 `…\npm-cache\…`、`<用户目录>\AppData\…` 这类形式。
- 记录验证 / 复现位置（worktree、复现环境）用分支名 + 短哈希或泛称（如「另一干净 HEAD 工作树」），不写本机绝对路径。
- 提交前跑个人路径检查：开发机一次性 `git config core.hooksPath .githooks` 启用 pre-commit；也可手动 `python scripts/check_personal_paths.py`（`--all` 全仓、`--diff-ref main` 查分支新增）。命中先脱敏再提交；测试夹具假路径（test / demo / runner 等）默认放行，新的假名用 `--allow` 或扩充脚本白名单。
- 本地服务器必须只监听 `127.0.0.1`；不可改成任意本地文件浏览或任意路径写入接口。
- JSON 的 `segments[*].start/end/items[*].start/end` 都是整数毫秒。修改 schema 必须同步更新 `docs/engineering/JSON_SCHEMA.md`、测试与 changelog。
- `waveform` 是可重建缓存，不能变成工程唯一真源；`segments` 才是字幕真源。
- 删除文件时移入回收站，绝不使用 `rm -rf`。

## UI 间距约定

- 新增按钮、输入框、提示行等 UI 元素时，必须与上下相邻元素保持垂直间隔（用 `margin` 或父容器 `gap`），不得紧贴；移动、新增一行按钮或区块后，要检查它与上方元素的间距。
- 注意本项目 `.field` 只有 `margin-top`（没有下边距）、`.hint` 是 `margin: 0`：紧跟在 `.field` 后面的提示行 / 按钮行 / 独立区块必须自带 `margin-top`，不能指望对方留白。
- 间距验收必须用实测数据（如 `getComputedStyle` 的 `marginTop`、相邻元素的实际像素距离 ≥ 8px），不能凭截图目测「看起来有间距」——这条规则反复被违反过，目测判断不可靠。
- 凡是改动 Launcher / 编辑器布局的任务，收尾前把涉及区域截图自查一遍。
- 编写或修改 `tools/` 下的浏览器工具页（含脚本生成的 HTML 页）前，必须先读 [tools/TOOL_PAGE_GUIDE.md](tools/TOOL_PAGE_GUIDE.md) 并遵循，交付前按文末清单自查；工具 Markdown 展示复用 `tools/shared/` 的 Marked + DOMPurify 封装，原 README 是真源，离线副本须生成并检查新鲜度。
- 工具页文字严禁小于 **11px**（含徽章、时间码、刻度、伪元素与精简/窄屏模式）；OCR 确认页是控件样式基准，精简只裁辅助信息、不缩字号；新增或调整工具须同步 `tools/catalog.js` 与工具 README，让[工具功能介绍页](tools/index.html)保持准确。

## PR 描述：先让 reviewer 看懂

正文写整体改动，不复述 commit 流水账。

提交前先确认当前 PR 的目标分支（base branch），fetch 后将最新目标分支合并到当前分支并解决冲突。目标为 `2.0dev` 时同步 `origin/2.0dev`，目标为 `main` 时同步 `origin/main`；不得固定合并 main，也不得擅自更改 PR 目标。合并、提交和推送仍需明确授权。

1. **先说问题和结果**：标题写用户可感知的修复；开头两句交代触发场景、旧行为与期望行为。路径、布局或数据问题优先用一个最小前后对照，不铺背景。
2. **正文默认四段**：「为什么改」→「改了什么」→「验证」→「边界 / 待确认」。目标是首屏能判断目的与风险；每段 2–4 条，每组最多 5 条。简单 PR 可合并小节，不为凑模板加内容。
3. **只留审查必要信息**：改动按行为归纳；复杂链路最多列 3 个关键入口与审查点，不逐文件解释。原始日志、调试经过、完整命令矩阵放关联记录或折叠详情，不塞主文；关键命令应可复制，远端 reviewer 无法访问的本地路径不能作为唯一证据。
4. **验证说实话且不刷屏**：通过项按层合并为简短结果；失败、超时、跳过和未测项单列，写明影响及下一步。局部重跑通过不等于整组通过，本地通过不等于 CI 或人工通过；影响判断没有证据时不要写「无关」。
5. **收尾给明确边界**：只写本次重要限制、不包含的工作及必要验收步骤（通常 1–3 步）；无待确认就省略。涉及前端源码时注明「内联副本待发布前统一重生成」。长正文用 UTF-8 文件提交并回读核对，沿用提交署名与个人路径约束。
6. **GitHub 文本不用 `#数字` 作条目序号**：Issue/PR 正文与评论里 `#数字` 会被自动链接成同仓库引用，条目序号用「条目 N」等文字形式；真实的 issue/PR 引用才用 `#`。

## 发布检查

有明显用户感知的改动必须写进 CHANGELOG，按 PR 或 branch 的整体结果汇总。小节归属：行为与体验改进进【✨ 提升】，问题修复进【🐛 修复】，行为与默认值变化进【🔄 变更】；只有完整的新能力才进【🚀 全新特性】，不确定时放提升，由维护者上调。开发期间为完成某特性产生的内部修复并入该特性，不单列；已发布版本不回改。

条目面向用户，默认一句话「**简短标题** ： 结果」。不写实现细节、根因、重试过程、测试与边缘情况；操作步骤和限制放用户指南，技术细节放工程文档或日志。

发布前确认：版本号、`CHANGELOG.md`、README 命令与 `blank-editor.html` 相互一致；含 `web/` 或模板变更时此时才运行 `uv run python edit.py --blank`；跑完上述测试；扫描 `.env`、媒体与个人路径；确认 `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 仍正确。不要创建远端、推送、打 tag 或 GitHub Release，除非维护者明确要求。

Release 正文只从 CL 生成：正式版用 `scripts/prepare_release_notes.py --tag VERSION --write-doc` 生成并提交 `docs/releases/<版本>.md`，发布前再跑 `--check-doc` 与 `--output` 检查；beta / rc 不新增归档；补丁版本在 CL 写 `<!-- release-base: X.Y.0 -->`。正式版收尾必须分别核对 **GitHub Release** 与 **官网** 两层，门槛见[发布管线](docs/releases/README.md)：官网用 `scripts/verify_release_site.py --base-url https://moyf.github.io/moys-asr-workflow --expected-tag vVERSION` 校验，允许有界等待；超时报告「安装包已发布，官网待同步」，只重试 Pages workflow，不重打包、不撤回 Release、不移动 tag。

Release Markdown 中，粗体闭合标记 `**` 与后续标点或正文之间必须留一个空格，标点后继续正文时也要留一个空格；禁止写成 `- **这个文字**：说明`，应写成 `- **这个文字** ： 说明`。

## 上游关系

MAW 从一开始就是独立项目。需要引入外部代码时，逐项审查、补测试并更新文档；不要整目录覆盖或带入开发者机器上的配置、缓存与辅助工具。

## 代码协作

有时候多个 Agents 会同时开工，遇到文件变动的情况不用慌张。

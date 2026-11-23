# AGENTS.md

## 核心原则

- **不要默认用户提出的问题定义就是正确的**。你先分析用户真正想解决的底层需求，判断有没有把症状误认为原因、把手段误认为目标。如果存在更值得解决的问题，直接指出来。
- **先读再改**：以当前工作树为准，读相关实现、直接调用方与现有测试，找最小正确改动。
- **优先复用**：沿用现有模块与约定；够用就不加依赖、不为假设需求新增抽象、不顺手重构。最小改动不能削弱安全、防数据丢失、可访问性或用户明确要求。
- **验证变化**：有实质逻辑变化时，补或扩展最小回归用例。交付时分开说明已验证、失败、跳过和未验证项；对缺口给出原因和下一步。

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

`web/` 是编辑器和 Launcher 的前端源码目录。页面从 bundle 加载主脚本；改了 JS、装配清单或构建配置，先重建受影响的 bundle，再检查新鲜度：

- 编辑器：`pnpm run build:editor`，再 `pnpm run check:editor`。装配与领域分工见[编辑器源码地图](docs/engineering/DEVELOPMENT.md#编辑器源码地图)；新业务写进所属领域，不扩大入口。
- Launcher：`pnpm run build:launcher`，再 `pnpm run check:launcher`。装配顺序见 `web/launcher-scripts.txt`；`batch.js` / `postprocess.js` 独立加载，经 `window.MAWLauncher` 接入。

bundle 与 `.meta.json` 不入 Git。源码入口会校验并自动重建过期产物（需要 Node 与 `pnpm install`）；发布包预先构建，运行不需要 Node。CSS 与 HTML 模板仍在渲染时读取；开发时可用 [dev / watcher 命令](docs/engineering/DEBUG_WORKFLOW.md#开发入口与-bundle)。

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

环境准备、检查命令和发布前要跑的开发测试见[开发检查](docs/engineering/DEVELOPMENT.md#开发检查)；Agent 按[有界输出与分层调试](docs/engineering/DEBUG_WORKFLOW.md)执行：

- 自动化用 `uv run --no-sync`；测试通过 `python scripts/run_check.py --timeout <秒> -- <命令>`，保留完整日志，只读有界摘要和必要失败片段。按本次范围设预算，连续两轮同类失败先分析，不循环重跑。
- diff 先看范围再读选定源码，不整份读取生成物。长驻服务必须独立启动、用完终止；禁止用 Bash 后台 `&` 启动服务。

### 浏览器验证

- 交互变化要在真实浏览器里操作受影响的入口并核对结果（手动或相关 Playwright 用例）。只启动服务、跑单测或检查 DOM 存在不算交互验证。
- Launcher / 编辑器布局变化要截图自查并实测受影响的间距或尺寸，见 [UI 间距约定](#ui-间距约定)；截图不替代交互验证。
- 若环境受限或浏览器检查反复卡住，保留其他验证结果，将未完成的浏览器检查标为「未验证」，给出原因及人工复核的操作和预期；不反复重跑，不报通过。

### Playwright e2e 运行纪律（防长命令挂起）

优先跑受影响的 spec；全量 Chromium e2e ≤ 15 分钟，单 spec ≤ 10 分钟。中断或失败后重跑前按 [E2E 排查与清理](docs/engineering/E2E_SERVER_HANG.md#清理)核对并清理残留，只清本 worktree 的进程。

## 日常 CI 与辅助巡检

- PR/main 的日常合并结论以 `Change acceptance` 所选阻塞检查为准；不得把它表述为完整测试全部通过。
- 完整双平台矩阵保留每周/手动辅助巡检，Windows预览按打包/启动/运行时相关变化或手动请求；不因保守而恢复每个PR/main的完整Node、Python、媒体或E2E叠加执行。
- 辅助任务失败须保留首次证据并据实说明，但不要求无关PR顺带修复全部历史红灯。与当前改动直接相关的失败、已知安全或数据损失风险仍须明确处置，不能凭“辅助”自动免责。
- 所选阻塞项缺报告、错SHA、取消或意外skip仍失败；发布仍遵循原Windows阻断与辅助平台警告政策。不得擅自修改远端分支规则或批量更新其他PR。
- 策略、准入与验收见[开发概览](docs/engineering/DEVELOPMENT.md)和[CI门禁纠偏方案](docs/plans/CI_GATE_CORRECTION.md)。

## 测试反馈任务的持久化流程（显式启用）

`feedback-issue-triage` 仅在用户明确启动测试反馈收集时启用，固定口令为「测试反馈」；明确说「记录到反馈账本」「整理测试反馈」「按 triage 处理」或直接调用技能也启用。口令须表达当前操作意图，引用、讨论触发词或否定请求不触发。日常问答、报错解释、只读调查、「帮我看看」「查一下」「是不是 bug」「用户反馈了个问题」、日志/截图以及一次询问多个问题，都不因此建账本、写调查文档或改索引。泛称「记录一下」「收口」「发 Issue」只按其明确范围处理，不自动扩展为 triage；只有其他明确授权的文档任务或适用的开发/发布要求，才另行落盘。

同一已启用任务的后续条目无需重复口令；结束、退出或换话题后不继承。用户说「只回答，不记录」时停止记录。附件说明和启用流程都不授予实现、提交或创建 Issue 的权限。启用后按 [feedback-issue-triage](.opencode/skills/feedback-issue-triage/SKILL.md) 先记账后调查、按主题分账，验证按层记录；证据不足不报已修复。

## 提交前自审

批量改动、功能开发与反馈修复在自检通过后、提交 / 提 PR 前做一轮独立自审（对标 Greptile）：由未参与实现的审查者通读全部 diff，实现者只回答提问；每条 finding 必须带证据（文件:行 + 实际执行过的命令输出），覆盖正确性、边界、异常与降级、回归、跨平台、性能、测试有效性与仓库约定。

- 改动官网源文档、映射或配图时，提交前须通过[官网文档一致性检查](docs/README.md#提交与验证)；检查和构建在隔离目录从当前工作树生成，无需提交生成副本。
- 双向验证：新增测试必须在「修复缺失」时真实失败；行为修复用既有用例做旧逻辑对照。验证后恢复原状并重建产物。
- 真实缺陷修复并复验；nit 与接受的风险逐条写入 `docs/logs/release<基线>/<YYMMDD>_<主题>/REVIEW_FINDINGS.md` 并登记日志索引，不静默丢弃。
- 没有未处置的 blocker / major 才提交；PR 描述如实写自审结论与未测边界。一两行笔误与纯文档措辞可自行判断省略。

详细步骤与分诊标准见[开发概览的提交前自审](docs/engineering/DEVELOPMENT.md#提交前自审)。

## 批量改动的人工核查清单

多条目、需维护者逐项实测时，按 [verification-checklist](.opencode/skill/verification-checklist/SKILL.md) 写 Markdown 清单，不在对话罗列。Agent 只写 Markdown，不手写 HTML；源清单须校验，生成页须用浏览器打开且不入库；不为单次清单改模板。

## Codegraph 使用注意

- 在本仓库调用 `codegraph_explore` **必须显式传 `projectPath="<工程路径>"`**。省略时使用会话默认项目，可能落到父级混合索引，返回其他仓库的代码并造成误改。
- 主仓库索引不能代替当前 worktree 源码；索引核对与复用见 [Codegraph 排查](docs/engineering/DEBUG_WORKFLOW.md#codegraph-排查)。

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
- 共享工作区操作前后检查状态，只改本任务文件；不用 `git reset` / `git clean` 覆盖他人 WIP。

## UI 间距约定

- 新增按钮、输入框、提示行等 UI 元素时，必须与上下相邻元素保持垂直间隔（用 `margin` 或父容器 `gap`），不得紧贴；移动、新增一行按钮或区块后，要检查它与上方元素的间距。
- 注意本项目 `.field` 只有 `margin-top`（没有下边距）、`.hint` 是 `margin: 0`：紧跟在 `.field` 后面的提示行 / 按钮行 / 独立区块必须自带 `margin-top`，不能指望对方留白。
- 间距验收必须记录实测数据（如 `getComputedStyle` 的 `marginTop`、相邻元素的实际像素距离 ≥ 8px），不能只看截图。
- 改 `tools/` 浏览器工具页（含脚本生成页）前，必须先读并遵循 [工具页规范](tools/TOOL_PAGE_GUIDE.md)，按文末清单自查。工具页文字不得小于 **11px**；Markdown 展示复用 `tools/shared/` 的 Marked + DOMPurify 封装；新增或调整工具后同步相关 README 与 `tools/catalog.js`，用生成脚本更新并检查离线说明副本。

## PR 描述：先让 reviewer 看懂

正文写整体改动，不复述 commit 流水账。

提交前先确认当前 PR 的目标分支（base branch），fetch 后将最新目标分支合并到当前分支并解决冲突。目标为 `2.0dev` 时同步 `origin/2.0dev`，目标为 `main` 时同步 `origin/main`；不得固定合并 main，也不得擅自更改 PR 目标。

修复现有 PR 的 CI 回归或审查指出的问题时，完成相关验证后可直接同步目标分支、提交修复并普通推送至该 PR 的现有分支，不必逐次确认。


1. **先说问题和结果**：标题写用户可感知的修复；开头两句交代触发场景、旧行为与期望行为。路径、布局或数据问题优先用一个最小前后对照，不铺背景。
2. **正文默认四段**：「为什么改」→「改了什么」→「验证」→「边界 / 待确认」。目标是首屏能判断目的与风险；每段 2–4 条，每组最多 5 条。简单 PR 可合并小节，不为凑模板加内容。
3. **只留审查必要信息**：改动按行为归纳；复杂链路最多列 3 个关键入口与审查点，不逐文件解释。原始日志、调试经过、完整命令矩阵放关联记录或折叠详情，不塞主文；关键命令应可复制，远端 reviewer 无法访问的本地路径不能作为唯一证据。
4. **验证说实话且不刷屏**：通过项按层合并为简短结果；失败、超时、跳过和未测项单列，写明影响及下一步。局部重跑通过不等于整组通过，本地通过不等于 CI 或人工通过；影响判断没有证据时不要写「无关」。
5. **收尾给明确边界**：只写本次重要限制、不包含的工作及必要验收步骤（通常 1–3 步）；无待确认就省略。涉及前端源码时注明「内联副本待发布前统一重生成」。长正文用 UTF-8 文件提交并回读核对，沿用提交署名与个人路径约束。
6. **GitHub 文本不用 `#数字` 作条目序号**：Issue/PR 正文与评论里 `#数字` 会被自动链接成同仓库引用，条目序号用「条目 N」等文字形式；真实的 issue/PR 引用才用 `#`。

## 发布检查

有明显用户感知的改动必须写进 CHANGELOG，按 PR 或 branch 的整体结果汇总。小节归属：行为与体验改进进【✨ 提升】，问题修复进【🐛 修复】，行为与默认值变化进【🔄 变更】；只有完整的新能力才进【🚀 全新特性】，不确定时放提升，由维护者上调。开发期间为完成某特性产生的内部修复并入该特性，不单列；已发布版本不回改。

条目面向用户，默认一句话「**简短标题** ： 结果」。不写实现细节、根因、重试过程、测试与边缘情况；操作步骤和限制放用户指南，技术细节放工程文档或日志。

发布前确认：版本号、`CHANGELOG.md`、README 命令与 `blank-editor.html` 相互一致；含 `web/` 或模板变更时此时才运行 `uv run python edit.py --blank`；跑完上述测试；扫描 `.env`、媒体与个人路径；确认 `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 仍正确。新增远端、发布相关的推送、打 tag 或创建 GitHub Release 均需维护者明确授权；日常更新已开启的 PR 按上节执行。

Release 正文只从 CL 生成；[正式版归档与校验](docs/releases/README.md#正式版归档)是发布门槛，beta / rc 不新增归档，补丁版本须声明系列基础版本。正式版分别核验 [GitHub Release 和官网](docs/releases/README.md#正式版收尾门槛)；仅官网失败则报告「安装包已发布，官网待同步」，只重试 Pages，不重打包、不撤回 Release、不移动 tag。

## 上游关系

MAW 从一开始就是独立项目。需要引入外部代码时，逐项审查、补测试并更新文档；不要整目录覆盖或带入开发者机器上的配置、缓存与辅助工具。

## 代码协作

有时候多个 Agents 会同时开工，遇到文件变动的情况不用慌张。

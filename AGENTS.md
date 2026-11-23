# AGENTS.md

本文件和子目录的 `AGENTS.md` 仅用于开发与维护 MAW。

## 项目与任务入口

- 先核对目标、触发条件和现有行为，读当前工作树的实现及相关调用方，区分症状与原因。遵循所涉目录的 `AGENTS.md`；稀疏检出时可用 `git show <目标引用>:<路径>`。
- 做能解决实际问题的最小改动：优先复用现有机制，不顺带重构，不为假设需求加抽象或依赖。保留任务范围外的用户行为，不削弱安全、数据保护、兼容性或无障碍。
- MAW 是可公开分发的 ASR 工作流。主流程以 Qwen ASR API 转写本地媒体，生成 SRT 和 `.mosp`，再在本地编辑与导出。Launcher 和 CLI 也提供[实验性本地识别](docs/user/LOCAL_ASR.md)。新增引擎、模型下载管理器、剪辑脚本或比较工具须有明确需求。完整产品方向见 [MOSE](docs/engineering/MOSE.md)。

| 任务 | 入口 |
| --- | --- |
| 改软件版本、准备候选版本 | [2.0dev 版本准备](docs/releases/preparation/README.md) |
| 写发布正文、上线或恢复 | [预发布正文](docs/releases/README.md#预发布正文)、[正式版归档](docs/releases/README.md#正式版归档)及[发布验收与恢复](docs/releases/README.md#发布顺序与恢复)，按本次操作选读。 |
| 找功能源码与首批测试 | [代码入口](docs/engineering/DEVELOPMENT.md#代码入口)中与操作对应的行。 |
| 修改指南或官网文档 | [文档约定与提交验证](docs/README.md#提交与验证) |
| 检查待提交改动 | [提交前自审](docs/engineering/DEVELOPMENT.md#提交前自审)，先选工作区候选或 PR 已提交范围。 |

- 从本次任务对应的章节开始。涉及新的数据、构建或发布边界时补读对应约定。其他专题查[文档索引](docs/INDEX.md)，接续已有任务按需查 [CURRENT](docs/logs/CURRENT.md) 和相关日志。
- 优先更新已有正文，按[文档约定](docs/README.md#doc-policy)放置文档和共享日志，原始输出、临时产物和个人待办留在 `.artifacts/`。官网源文档、映射或配图变化时，按[提交与验证](docs/README.md#提交与验证)同步、检查并提交生成副本。

## 协作、数据与安全

- 在共享工作树操作前后检查 `git status --short`，只改本任务范围。核对暂存区，共享工作树提交时用 `git commit -- <本次路径>` 限定范围，保留他人的在途和暂存改动。禁止以 `git reset`、`git clean` 或覆盖无关 diff 清理工作树。删除文件时移入回收站，禁用 `rm -rf`。
- 所有文本使用 UTF-8 与 LF，换行遵循 `.gitattributes`。`.env` 中的 Key 仅供本机使用，禁止读取、打印、提交或放入测试夹具。禁止提交媒体、识别结果、波形 sidecar、原始截图及个人工作流资产。
- 报错、日志和复现记录须隐去本机绝对路径与用户名。用分支名和短 SHA 标识复现环境。提交前用 `.githooks` 或 `python scripts/check_personal_paths.py` 检查个人路径。提交只用维护者身份，提交信息禁加代理或 AI 署名、`Co-authored-by` 及工具链接。
- 本地服务器只监听 `127.0.0.1`，禁止开放任意文件浏览和任意路径写入。
- v2 落盘字幕以 `tracks[*].segments` 为准，顶层 `segments` 用于旧格式兼容。字幕和字词的 `start` / `end` 为源媒体整数毫秒。`waveform` 只作为可重建缓存。旧工程首次保存为 v2 时显式另存，取消或失败须保留原件。涉及工程读写先核对 [JSON 契约](docs/engineering/JSON_SCHEMA.md)的相关章节。改格式时同步更新契约、相关测试与 CHANGELOG。
- 引入外部代码时逐项审核、补测试、更新文档。排除整目录覆盖与外部机器的配置、缓存和辅助工具。
- 使用 Codegraph 时显式传入所用索引的 `projectPath`，避开父目录混合索引。借用主仓库索引只用于导航，编辑前用当前工作树源码核对。重构或索引与分支差异较大时直接查当前源码。

## 前端构建与编辑入口

- 修改 `web/` 的 JS、装配清单或构建配置后，先构建并检查受影响的 Editor / Launcher，再预览或测试。bundle 和 `.meta.json` 属于生成物，禁止提交。新增模块按清单初始化，依赖沿既有门面注入。见[源码地图与构建命令](docs/engineering/DEVELOPMENT.md#编辑器源码地图)。
- 2.0 及以后（含预发布版）维护本地应用编辑入口，不生成、维护或分发独立编辑 HTML，也不发布 Pages `/editor/`。保留历史附件和用户副本；涉及旧文件或 1.x 发布时查[独立入口的版本边界](docs/engineering/DEVELOPMENT.md#独立编辑入口的版本边界)。

## 开发与验证

- Agent 的 `uv run` 一律加 `--no-sync`。新工作树先[核对环境与依赖](docs/engineering/DEBUG_WORKFLOW.md#开始前只做一次环境确认)，只修缺失层。用[有界执行入口](docs/engineering/DEBUG_WORKFLOW.md#有界执行入口)运行测试，保留原始输出、摘要和退出状态。
- [按影响选测](docs/engineering/DEBUG_WORKFLOW.md#本地按影响选测)，先跑最小相关集合；行为修复用最小回归用例验证旧行为失败、修复后通过，已有合适用例就复用。连续两轮同类失败先分诊，自动化反复挂起时标记未测并转人工验收。结束时运行 `git diff --check`。
- 长命令分开执行并限时。[后台服务](docs/engineering/DEBUG_WORKFLOW.md#长命令与后台服务)独立启动、探活、用后停止。E2E 中断或失败后只清理[已确认属于本次的残留进程](docs/engineering/E2E_SERVER_HANG.md#残留进程清理)，再重跑。
- 2.0dev 日常准入看 `Change acceptance`；缺报告、错 SHA、取消或意外跳过均失败。按[分支 CI 约定](docs/engineering/DEVELOPMENT.md#日常变更准入与手动辅助检查20dev)分诊辅助失败。分别报告实际验证层及失败、超时、跳过和未测项的原因、影响与下一步；不能以其他层通过代替。

## 测试反馈与交付

- 仅当用户以「测试反馈」明确启动、要求记入反馈账本、整理测试反馈、按 triage 处理或直接调用[反馈技能](.opencode/skills/feedback-issue-triage/SKILL.md)时启用。普通问答、只读调查、引用、附件或否定请求不因此建账、写调查文档或改索引；泛称「记录一下」「收口」「发 Issue」只按本次请求处理。
- 同一已启用任务先入账再核对，续记无需重复口令；收尾、退出、换话题或要求只回答时停止记录。实施、提交及 GitHub 写操作另按授权；登记、回写与恢复按技能办理。

### 提交前自审

批量改动、功能开发或反馈修复在自检通过后、提交前按[自审步骤](docs/engineering/DEVELOPMENT.md#提交前自审)独立审查，Agent 用后台子代理。按步骤记录发现与处置，解决 blocker / major 后才提交。小笔误与纯措辞可省略。

## 批量改动的人工核查清单

需要维护者逐项实测时，用[核对清单技能](.opencode/skill/verification-checklist/SKILL.md)编写 Markdown v2。清单写明测试目的、操作和可观察预期。源文件随台账入库，校验后生成预览 HTML，HTML 留在本地临时或指定目录。

## UI 验证与间距

- 改交互时在受影响的本地应用实测，Playwright 优先跑相关 spec；Launcher / 编辑器布局改动须截图自查。新增或移动控件、提示行或区块时用 `margin` 或 `gap` 留间隔（`.field` 仅有上边距，`.hint` 无边距），并测实际像素（如相邻间距 ≥ 8px）。所需实测、截图和测量做不到时分别标为未验证；纯文档不要求应用实测。
- 修改浏览器工具页（含脚本生成页）前读[工具页规范](tools/TOOL_PAGE_GUIDE.md)，按适用清单验收浏览器行为、截图、测量及离线说明副本；工具能力、入口或维护状态改变时同步 `tools/catalog.js` 与相关 README。

## PR 与发布

- 合并、提交、推送、开 PR、建远端、打 tag 和发布须经维护者明确授权。开 PR 或向已有 PR 推送改动前，核对实际目标仓库与 base，从对应远端 fetch 最新目标分支并合入当前分支，处理冲突。勿默认用 fork 的 `origin` 或同步 `main`，勿擅自改 base。仅本地提交不要求为 PR 同步。
- PR 写清为什么改、改了什么、验证和待确认边界。简单改动可合并小节，无待确认可省略。给出 reviewer 能访问的证据及必要验收。长正文用 UTF-8 文件提交并回读。Issue / PR 的条目序号用「条目 N」，`#数字` 留作真实引用。
- 用户可感知的改动按 PR 或分支整体记入 CHANGELOG。[正文写法](docs/releases/README.md#更新日志写法)与各渠道发布步骤由发布指南维护。
- 核对发布范围、支持与许可、敏感资产、正文及产物。正式版须分别验证公开 Release 和官网，按[验收与恢复](docs/releases/README.md#发布顺序与恢复)记录完成或失败。确认实际发布后更新日志基线。

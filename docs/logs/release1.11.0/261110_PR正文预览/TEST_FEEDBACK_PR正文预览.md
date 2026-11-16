# PR 正文预览与刷新反馈账本

基线：`main` / `cedb5bfd`。2026-11-10 收到实测反馈；初始工作树保留上一轮未提交的正文预览实现、测试、CHANGELOG 与审查记录，已核对 `git status --short`、diff 清单及取数 / 预览相关实际 diff，不覆盖已有工作。

本账本先记录再调查，每项完成后立即回填。状态仅用：`待处理` / `进行中` / `已修复` / `仅说明` / `阻塞`。相同截图的重复发送记作同一反馈，不重复编号；不创建 Issue、commit 或 push。

## 问题清单

| 条目 | 问题 | 状态 | 核实结论 / 方案 |
| --- | --- | --- | --- |
| 1 | 「看不到正文（实际上是有的）」；截图中 PR 318 的 hover 浮层显示「此 PR 暂无正文。」 | 已修复 | 原因是 2026-11-09 启动的旧后端未返回 body，而静态前端已更新；此前 9 项均缺字段。代码已区分未获取 / 真空并提供重启提示。维护者明确授权独立窗口重启后，已定点替换该看板进程；真实 `/api/prs` 9 项均有 body，PR 318 为 300 字符，真实浏览器 hover 预览可见且显示 300 字符、无缺字段告警。状态与忽略列表前后 SHA-256 未变化。截图反馈仅存文字。 |
| 2 | 「读取/刷新的时候希望显示一个进度条」 | 已修复 | 已加首次 / 手动 / 自动刷新原生不定进度条、busy 防重入和四路 allSettled 原子提交；失败保留旧卡片，成功 / 失败均清理浮层及待执行任务。37/37（浏览器 15 + 服务端 22）通过；独立发现的收尾 minor 已补 3 项旧红新绿回归，并经原审查者实测复验闭环。 |
| 3 | 「正文预览的 md 需要渲染成 html」；提供的 PR 正文包含标题、有序列表、粗体和内联 XML 代码。 | 已修复 | 已引入固定版本本地 Marked 词法分析 + 白名单 DOM 渲染，42 项服务端 / Chromium 回归通过；Markdown 资源、PR 318 真实预览已在按维护者要求重启的服务验证。独立安全复核发现的实体链接问题已修并复验，FCP 7 文本仅作样例，未改导出器。 |

## 阶段汇总

### 初始记录

- 两条反馈已入账，均待核实 / 实施；用户明确要求修正正文展示并增加刷新进度反馈。
- 上一轮自动化和审查不等于维护者正在使用的服务已更新，需对运行实例取证。

### 续 1：运行实例对照

- 条目 1 根因已确认，转为进行中；条目 2 已定位，待同一实现代理按顺序处理，避免同文件并改。
- 证据：`.artifacts/checks/20261110T044931Z-3ed208bc/result.json`。命令通过 `run_check.py --timeout 85 -- node .artifacts/dev-dashboard-preview/diagnose-running.mjs`，只输出 PR 数量、字段存在性和长度，不落盘正文。
- 定位：`tools/dev-dashboard/app.js` 的 `showPrPreview` 将缺失 / null / 空字符串合并为「暂无正文」；`loadAll` 为并发四路读取，`refresh` 只设置按钮 disabled。服务端源码已包含 `body`，不需再加一次 hover 请求，也不增加按 PR 单独取数。
- 采用更省方案：原生 `<progress>` 不定模式 + 一份共享加载状态，不引入轮询、动画库或虚假百分比。

### 续 2：实施与主会话抽查

- 实现代理按条目顺序完成缺字段提示、加载进度。主会话已核对 `hasPrBody` / `showPrPreview`、`loadAll` / `refresh` 四处代码，以及缺字段 / 真空 / 恢复和 pending / 早失败 / 自动重入测试。
- 条目 1 的误导显示已修复；取数后实际正文恢复需旧服务重启，所以整项保留为「阻塞」，不以夹具通过冒充运行实例已恢复。
- 新测试反向证据：条目 1 原逻辑 2 项真实失败（`.artifacts/checks/20261110T045323Z-8e57096a/result.json`）；进度条原逻辑 4 项失败（`.artifacts/checks/20261110T045605Z-66ee19b9/result.json`）；临时回退 Promise.all 导致忙状态测试真实失败，随后已恢复 allSettled（`.artifacts/checks/20261110T045933Z-55ba345e/result.json`）。
- 最终实现层测试：`node --test tools/dev-dashboard/app.test.mjs tools/dev-dashboard/serve.test.mjs`，34/34（浏览器 12 + 服务端 22），证据 `.artifacts/checks/20261110T050000Z-33e121fe/result.json`。
- 主会话已自查首次加载宽 / 窄屏、刷新中及缺正文告警截图；实测进度行上 / 下均 10px，与标题宽屏 25.5px / 窄屏 66px，不撑宽页面。

### 续 3：独立复核

- 无 blocker / major，发现 1 minor：360×640 刷新期间重新打开旧标题预览，刷新失败后的告警 / 进度布局调整使卡片上移 44px，浮层仍留旧位置，原标题被遮挡、实际点击 0 个新标签。独立证据 `.artifacts/checks/20261110T050650Z-240babc0/output.log` 第 3–6 行；条目 2 暂保留「进行中」，委派补失败路径回归并在收尾清理浮层与待弹出任务。
- 另发现刷新快照可能覆盖期间已保存的状态，但 HEAD 旧逻辑也复现，属于既有风险；本次不扩大修复范围，记录到独立审查说明，不静默忽略。证据为同日志第 7–10 行。

### 续 4：失败收尾修正与验证

- `refresh` 的 finally 在移除进度条 / 改布局前统一 `hidePrPreview()`；已打开浮层和 hover / focus 待执行任务都会清理。主会话核对实现行及 3 项回归原文，并自查窄屏失败后的清理截图。
- 新增 3 项在旧逻辑上全部真实失败：`.artifacts/checks/20261110T051011Z-8db6f418/result.json`；最终完整 37/37 通过：`.artifacts/checks/20261110T051046Z-0a6a6ff0/result.json`。自动化均通过 run_check.py 包裹；原审查者针对失败收尾原场景复验中。
- 文档检查通过（6 条既有漏登记警告，`.artifacts/checks/20261110T051055Z-b0901937/result.json`），文档回归 22/22（`.artifacts/checks/20261110T051123Z-5742b96a/result.json`），发布归档 18 份通过（`.artifacts/checks/20261110T051123Z-20c9861d/result.json`）。
- 12 个本任务文件（含账本、审查与人工清单）的 UTF-8/LF 和个人路径检查通过（`.artifacts/checks/20261110T051055Z-d6333710/result.json`）。人工清单 Markdown 校验通过（`.artifacts/checks/20261110T051055Z-1bdf5771/result.json`），生成页与最终状态待收尾。
- 当前状态：条目 2 已修复；条目 1 误导提示代码已修复，但实际旧实例恢复正文仍是「阻塞」，下一步是维护者在原服务终端停止后重启，再刷新查看 PR 318。没有仅说明反馈项；另行记录的快照竞态为既有接受风险。

### 续 5：收尾

- 原审查者针对原失败场景复验通过：1000×700 与 360×640 失败后浮层关闭、无卡片遮挡；窄屏原标题命中 `card-title`，实际点击产生 1 个新标签，无运行时错误。证据 `.artifacts/checks/20261110T051325Z-6f396f7c/output.log` 第 2–5 行；无新增需处置问题。
- 人工源清单位于同目录 `PR-preview-progress.checklist.md`，保持 pending，不将自动化冒充人工完成；生成页为 `.artifacts/dev-dashboard-preview/verification.html`，已在独立浏览器会话打开检查。源格式校验与 HTML 生成分别有 `.artifacts/checks/20261110T051327Z-7ddd4147/result.json`、`.artifacts/checks/20261110T051334Z-b75c70fb/result.json`；内容更新后按同一命令重生成。
- `git diff --check` 通过，证据 `.artifacts/checks/20261110T051327Z-7110ea46/result.json`。未提交、未发布 Issue、未重启用户服务；仅剩条目 1 的真实运行实例重启确认，未擅自关闭维护者进程。

### 续 6：维护者授权重启与真实页面复验

- 维护者找不到原终端，明确选择“独立窗口重启”。核对 8262 监听者命令为本工具，且响应 HTML 与当前工作树完全一致后，只停止这个 Node 进程，不操作其他 Node / agent。受管终端服务未运行，经维护者明确同意改用独立可见 PowerShell 窗口，标题为 `MAW PR Dashboard :8262`；此窗口按 Ctrl+C 可停止看板，服务按用户意图保持运行。
- 重启与状态哈希核对完成，`.artifacts/checks/20261110T063315Z-964559d7/result.json`。首次 PowerShell 汇总误把 REST JSON 数组包成单元素，不能据该摘要认定正文缺失；已修正本地诊断脚本，并以 Node 独立 JSON 解析复核实际接口：9 个 PR 全部返回字符串正文、PR 318 正文 300 字符，证据 `.artifacts/checks/20261110T063436Z-623161dc/result.json`。不记录正文内容。
- 独立命名浏览器会话打开真实 `http://127.0.0.1:8262/`，悬停 PR 318，实测浮层可见、正文 300 字符、不是未获取 / 暂无正文，告警与加载进度均已结束。指标留在 `.artifacts/dev-dashboard-runtime/preview-verification.json`；验证浏览器已关闭，用户的新看板窗口保留。
- 条目 1 从阻塞转为已修复，两条反馈均已修复，无待处理 / 进行中 / 阻塞反馈。人工清单继续 pending，真实页面的自动化操作不冒充维护者已经打勾；既有快照竞态仍为另记的接受风险。

### 续 7：Markdown 渲染需求

- 用户明确要求正文预览渲染 Markdown，新增条目 3，先记为待处理再调查可复用实现。
- 原纯文本安全边界调整为“结构化 Markdown 渲染 + 严格安全策略”；是否复用现有解析器、如何保留 CSP 与不加载外部图片，待核对。本文提供的 XML 缺陷描述仅是展示样例，不扩展为 FCP 7 导出改动。
- 用户另请求核查 CL 编辑器的 Markdown 渲染；已按项目要求转至独立主题账本，不与 PR 正文预览混账。
- 项目无已声明 Markdown 解析器。PR 看板目前零 npm 运行时依赖，继续保持严格 CSP、默认不加载远端图片；实现应采用经许可审查的成熟解析器而非临时正则，锁定版本并明确运行依赖 / 离线分发方式。CL 编辑器先只读核查，不并行改共享文件。

### 续 8：Markdown 实施与授权重启

- 实现代理使用本地 `marked@15.0.12`（MIT，许可证与来源已附、登记 THIRD_PARTY_NOTICES）；只调用 lexer，按白名单创建 DOM，不执行外部原始 HTML，不加载远程图片，仅允许绝对 HTTP(S) 链接。兼容缺正文和缺解析器时提示重启，保持严格 CSP 与无 npm 运行依赖。
- 旧纯文本实现的新增结构断言真实失败（`.artifacts/checks/20261110T064348Z-bda0a17d/result.json`），URL 防护负向对照失败后已恢复（`.artifacts/checks/20261110T065014Z-52636da0/result.json`）；最终 41/41 服务端 / Chromium 回归通过，最新复跑 `.artifacts/checks/20261110T101416Z-9c6fbf5e/result.json`。
- 维护者再次明确要求重启；核对 8262 监听者为本工具后，只停止该服务并在独立 PowerShell 窗口启动新服务。状态与忽略文件哈希未变，9 项均有正文、PR 318 为 300 字符：`.artifacts/checks/20261110T101452Z-d4596e2c/result.json`。实际 `/marked-15.0.12.min.js` 返回 200 且 CSP 严格；真实浏览器悬停 PR 318 证实 lexer 已加载、浮层可见、DOM 中 3 个元素、不落入原文回退、无错误横幅，浏览器测试会话已关闭，看板服务保留。
- Markdown 安全与可靠性独立复核仍在进行；暂不把条目 3 标为已修复。CL 编辑器核查为独立主题 `../261110_CL编辑器Markdown/TEST_FEEDBACK_CL编辑器Markdown.md`，用户要求的是检查，未改其代码。

### 续 9：Markdown 独立审查

- 无可复现 blocker / major，发现 1 minor：Markdown 链接目标里的 `&amp;` / `&#x61;` 未解码就直接传到 URL，点击将访问错误地址。独立 Chromium 证据 `.artifacts/checks/20261110T101807Z-74d43dbc/output.log` 第 14–22 / 62 行；不需访问外网即可复现。
- 需先按 Markdown 正确解码目标，再严格做 HTTP(S) 协议校验，避免用修复引入 `javascript:` 等编码绕过；补旧红新绿和完整回归。条目 3 继续「进行中」。
- 已实际读取 agent 生成的宽 / 窄 / 矮窗口截图，标题、列表、内联 XML 代码与滚动区域可见。真实服务已按用户要求启动当前版本；本地将修改的前端 JS 每次请求实时读取，无需擅自再重启用户的服务。

### 续 10：实体链接修正

- 已按先解码再执行 HTTP(S) 严格校验修复；新增 query / path 实体及编码危险协议的真实 Chromium 测试在旧逻辑失败（`.artifacts/checks/20261110T102011Z-9448baf7/result.json`），最终 42/42 通过（`.artifacts/checks/20261110T102036Z-ec087a5f/result.json`）。主会话已抽查 `safeUrl` 及新增测试。
- 已确认正在运行的看板对 `/app.js` 返回当前源码、含实体修正；用户只需刷新页面，不需第二次重启。原独立审查者复验在途，条目 3 暂保持「进行中」。

### 续 11：独立复验闭环

- 原审查者在隔离 Chromium 探针复验查询 / 路径实体正确解码，实体编码的 `javascript:` / `data:` / 相对协议 / 反斜杠变体均不生成链接；未访问真实外网。证据 `.artifacts/checks/20261110T102151Z-41911bf2/output.log` 第 14–27 行。未发现新的安全协议问题；Markdown 条目转为「已修复」。
- 本账本三条均已修复，无待处理 / 进行中 / 阻塞项。用户此前提到的 Project / Milestone 同步是另一个主题：授权与字段核对已完成，**功能尚未实施**，见 `../261110_PR看板GitHub同步/TEST_FEEDBACK_PR看板GitHub同步.md`。CL 编辑器仅核查、建议单独完善，未修改其代码。

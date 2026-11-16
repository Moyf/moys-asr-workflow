# main 测试稳定性与成本分析账本

- 请求：核对当前 main 失败测试，分析完整执行耗时和低收益 / 冗余覆盖，给出报告；后续获准修复 CHANGELOG 工具页相关测试夹具，不改产品代码或真实 CHANGELOG。
- 基线：`main`，`ee2fe595`；开始时工作区干净，已 fetch `origin/main`。
- 状态：待处理、进行中、已修复、仅说明、阻塞。

| # | 问题 | 状态 | 核实结论 / 方案 |
| --- | --- | --- | --- |
| 1 | main 目前还会有哪些测试失败？ | 仅说明 | 当前CI工具页失败，本地复现；扩大浏览器扫描发现另外5项，单worker复核仍全部失败。至少6项红灯，928项未运行，不声称完整枚举。Python3142项普通全量通过26skip；Node重建产物后全量通过。 |
| 2 | 完整测试一遍耗时、主要成本？ | 仅说明 | Python272.63s、Node71.47s；浏览器1140项在230.08s触及5失败上限而停止，不能当完整耗时。仅给热环境25–35分钟粗预算与明确外推限制；CI分门禁/平台列实测。 |
| 3 | 是否有低收益或冗余测试可 prune？ | 仅说明 | 报告列8项有文件行证据的优化/裁剪候选，优先按需编译和移除无消费者setup；明确保留真实媒体、跨平台与独有行为。不删除测试。 |
| 4 | 线上 run 43381500026 / job 131740133145 / step 21 报错，怎么看，需要修复吗？ | 仅说明 | 已用 GitHub API 和 `gh run view --job 131740133145 --log-failed` 核对：同一 `ee2fe595` 的 Independent browser tool pages，61通过、1失败，仍为 `tool-pages.spec.mjs:176` 的 `inputValue()` 超时。与报告1.1为同一故障，不是新增问题；建议修复测试夹具，另覆盖空未发布区，不调整真实CHANGELOG或全局重试。本条只给判断，尚未实施修复。 |
| 5 | 修复相关夹具 | 已修复 | 已仅修改 `tests/e2e/tool-pages.spec.mjs`：原编辑/预览测试改用固定非空 CHANGELOG 输入，另覆盖空未发布区的初始状态与新增首条目的流程；原断言保留，并增强预览同步检查。旧逻辑负对照失败；修改后与CI相同7个spec共63项全部通过（零跳过/重试）。独立审查无blocker/major，见[复核记录](REVIEW_FINDINGS_工具页夹具.md)；未提交/推送或触发远端CI。 |

## 阶段记录

- 首轮Python探针缺Windows spawn入口保护，子进程重入导致异常，已作废；修正探针后原runner集合3142项0failure/error、26skip，结果 `.artifacts/checks/20261113T072135Z-1e37a814/result.json`。
- Node初轮artifact过期，重建忽略的Launcher产物后83文件、1170叶子用例通过，结果 `.artifacts/checks/20261113T072845Z-acc51084/result.json`。没有修改测试或产品源码。
- 当前CI [43381500026](https://github.com/Moyf/moys-asr-workflow/actions/runs/43381500026) 工具页超时，本地最小复现 `.artifacts/checks/20261113T073027Z-75b86d80/result.json`。
- 浏览器有界扫描结果206pass、5fail、1interrupted、928未运行，`.artifacts/checks/20261113T073108Z-94b089ca/result.json`；单worker定向5项仍全部失败，`.artifacts/checks/20261113T073754Z-f705879a/result.json`。未将JSON的929 skipped误算为929个主动跳过；其中包括未运行与中断。
- 报告见[分析报告](分析报告.md)，CI原始JSON/log与计时输出均在 `.artifacts/test-audit-261113/`。下一步由维护者选择修复红灯和按优先级优化；本次不实施、不提交或推送。
- 续1（2026-11-13）：接手续查维护者提供的step 21链接；当前仍为 `main@ee2fe595`，原工作区只有日志索引与未跟踪报告目录。远端失败日志与既有本地复现一致。源码 `tests/e2e/tool-pages.spec.mjs:173-176` 读取真实CHANGELOG后直接寻找首个卡片；`tools/changelog-editor/index.html:492-495` 优先选择未发布区，而当前CHANGELOG该区为空。结论为应修复测试输入耦合，保留有价值的交互覆盖；未修改测试或产品代码，未重跑测试或远端CI。
- 续2（2026-11-13，实施中）：维护者授权修复相关夹具。本轮改动前用原用例复现10秒超时，结果 `.artifacts/checks/20261113T080050Z-280967fa/result.json`。改成固定非空输入后原用例通过；新增空态用例首轮因 `#cards .hint` 也匹配卡片内图片说明而失败（不是产品故障），结果 `.artifacts/checks/20261113T080325Z-a3743958/result.json`。已收紧为空态直属提示 `#cards > .hint`，保留新增后空态消失断言，待复验。
- 续3（2026-11-13）：完整复验线上 Independent browser tool pages 的7个spec：63通过、0失败/跳过/重试，墙钟34.06秒，结果 `.artifacts/checks/20261113T080459Z-66193617/result.json`。基线仍为 `ee2fe595`，待提交测试文件仅 `tests/e2e/tool-pages.spec.mjs`，另有原报告/索引与本轮记录。使用本工作树已准备的Python解释器与Chromium，无需启动常驻服务。原用例生成的主题/窄屏截图保留于忽略目录 `test-results/`。本轮不重跑全量Python/Node/1140项浏览器集合，不触发远端CI，不把本地7文件通过冒充远端或全项目全绿。未修改 `web/`，不需重建bundle或便携HTML。

本轮复验命令（先将 `MAW_E2E_PYTHON` 设为已准备的本工作树Python解释器）：

```powershell
uv run --no-sync python scripts/run_check.py --timeout 300 -- node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium --retries=0 tests/e2e/tool-pages.spec.mjs tests/e2e/tool-compact.spec.mjs tests/e2e/tool-markdown.spec.mjs tests/e2e/timestamp-compare.spec.mjs tests/e2e/verification-checklist.spec.mjs tests/e2e/term-report.spec.mjs tests/e2e/changelog-write-lock.spec.mjs
```

- 续4（2026-11-13，收口）：独立只读复核无blocker/major，原有交互断言完整保留；边界为未验证保存落盘与重载恢复，不将本轮夹具修复当产品功能修复。文档检查通过（`.artifacts/checks/20261113T080649Z-278b56dd/result.json`，仅日志导航警告），`git diff --check`通过。本任务全部条目闭环；同工作树出现另一任务的 `BROWSER_FIXES.md`，未改动该文件或其任务范围。

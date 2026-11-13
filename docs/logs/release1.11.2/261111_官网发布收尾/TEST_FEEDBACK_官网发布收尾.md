# 官网发布收尾与旧索引防护

日期：2026-11-11。起始分支：`main`，HEAD：`67fd9033`。起始工作区仅有本会话上一轮的 ASS 发布账本核对补充，保留并随本任务提交；不覆盖其他会话工作。

维护者请求：「以后怎么避免这种情况，你做一下，然后提交」。范围：官网部署后有界等待与缓存防护、真实失败诊断、根发布规则与指南的收尾门槛、回归测试及独立复核。只提交，不推送、不创建 tag、不重发 1.11.2。

状态仅使用：`待处理`、`进行中`、`已修复`、`仅说明`、`阻塞`。

| 条目 | 请求 / 问题 | 状态 | 结论 / 方案 |
| --- | --- | --- | --- |
| 1 | 避免官网刚部署后读取旧索引就提前失败 | 已修复 | 300s/10s 等待、缓存 probe+canonical、HTTP 截断/状态行重试、最终 deadline 与正式 tag 参数检查完成；65 项回归和独立闭环探针通过。不能保证消除所有 Pages 故障，超时仍真实失败。 |
| 2 | 发包规范明确官网验证与失败恢复 | 已修复 | 根 AGENTS 与发布指南已直接列出附件和官网两层收尾门槛；官网失败只单独重试，不重打包、不移动 tag，分别报告状态。规范与实际 CLI 和回归一致，文档检查通过。 |
| 3 | 验证、自审并提交 | 已修复 | 65 项回归、独立 R1–R3 闭环、真实官网和文档检查通过；无剩余 blocker/major，本记录随限定路径提交保存，不推送。提交身份/哈希以 Git 历史为准；真实 CI 与人工核验保留 pending。 |

## 事实与边界

- 1.11.2 三端构建和 Release 发布成功；首次官网 artifact 含正确 1.11.2 内容，但对外索引仍旧。单独官网重试成功，索引/notes/详情均已通过。首次未生效的精确原因没有确证，不能把缓存假设当作根因。
- 本次是提高部署传播阶段的容错及诊断，不保证消除所有 GitHub Pages 故障；超过等待上限仍失败并保留日志，不静默放行。
- 本次只调整维护者发包流程与校验工具，无应用端用户行为变更，因此不改 CHANGELOG 或版本号；新增 CI 行为在提交后仍需明确推送授权才会进入远端。

## 阶段记录

### 起始

- 先登记请求和当前状态，尚未修改实现。实现代码与测试交由一个子代理；主会话维护规范和账本，避免共享文件竞态。

### 续 1：规范收尾门槛

- 根 AGENTS 与发布指南增加 Release 附件/正文、官网索引/notes/详情两层门槛，以及失败时的单独 Pages 恢复入口和实际公开地址复验命令。
- 文档明确等待和缓存防护不是已确证根因修复，也不保证所有部署故障消失；永久失败仍真实报错，旧 run 红灯不变。实现与测试在途，未提交或推送。

### 续 2：人工核验载体

- 已编写 `官网发布收尾.checklist.md`，仅 3 个下一次正式发包的人工核验项（分层报告、失败诊断/单独恢复、实际公开入口），状态 pending。模板未修改；不为验收故意制造生产故障。
- 清单校验和生成通过：`.artifacts/checks/20261111T080920Z-9d1524ae/result.json`、`20261111T080920Z-8f35017c/result.json`；本地 HTML `.artifacts/website-release-verification/verification.html` 不入库。
- 浏览器实测桌面 1280px 浅色与 375px 深色：无根横向溢出、3 个核验项、可见文字计算字号最小 12px；深色 label 计算色为 rgb(243,241,238)。截图自查通过，证据 `20261111T081132Z-f212141c/result.json`。首次全页截图遇到屏外 content-visibility 与主题切换时机导致的视觉失真，改用独立主题上下文及先滚动到核验区的实际可见截图核对；未据此修改工具模板。
- agent-browser 的 stdin eval 曾空返回，未作为测量证据；实际测量改用临时 Playwright 脚本，浏览器均已关闭。文档检查通过 `20261111T080839Z-24b7d1f4/result.json`，只有 6 条既有日志入口 warning。

### 续 3：实现与回归

- 实施修改 `scripts/verify_release_site.py`、`.github/workflows/deploy-editor-pages.yml`、`tests/test_release_publication.py`，新增 `tests/test_verify_release_site.py`；主会话抽查请求防护、canonical 验证、deadline、失败分类与 workflow wiring 原文。没有重打包、部署或提交。
- 默认预算 300 秒、间隔 10 秒、请求最多 15 秒且不大于剩余预算；单轮 `verify()` import 兼容。每轮唯一查询参数，两项 no-cache header，probe 和 canonical 两种入口必须均通过；不能只用查询探针放行。
- 旧红：`20261111T080924Z-8bf6604a/result.json`（原实现缺等待/缓存/wiring）；隔离加载基线原脚本的空白正文回归真实失败 `20261111T081239Z-d32a06ae/result.json`。新绿：发布/官网/Release notes/新验证器/CompactAssertions 共 59 项通过 `20261111T081239Z-d80b999a/result.json`。网络/404恢复、永久陈旧、有界睡眠/请求、最终读取越界、坏正文、唯一排序和参数均覆盖，不跑真实长等待。
- workflow 校验外层 360 秒；失败 summary 明确官网待同步，仅已成功 Publish 的 Release 调用才称安装包已发布；校验运行后上传日志与 result.json。真实 CI artifact/summary 路径仍需推送后核验。

### 续 4：主会话实测与独立复核在途

- 新脚本真实只读官网验证：`verify_release_site.py --base-url https://moyf.github.io/moys-asr-workflow --expected-tag v1.11.2 --timeout 40 --retry-interval 5`，1 次/1.7s 通过，source=canonical、latest_stable=1.11.2；`.artifacts/checks/20261111T081452Z-c0b79cfd/result.json`。没有新增部署，不将外网正常路径冒充 CI 失败恢复验收。
- 10 个任务文件 UTF-8 无 BOM/LF/个人路径及选定 diff 检查通过 `20261111T081452Z-ef2aa1cf/result.json`。原始测试日志不入库。
- 已交未参与实施的独立审查者只读复核代码、测试、workflow 和规范；未提交，等待真实 findings 后分诊记录。
- 真实只读失败探针：请求不存在的 `v999.0.0`、预算 2 秒/间隔 1 秒，在 2 次尝试后如期 exit=1，输出实际 latest=1.11.2、generated_at 与最后 StaleCatalogError；没有改动生产站点。`20261111T081606Z-80393a5a/result.json` 是预期的拒绝证据，不是遗留功能失败。
- 全部 20 份正式归档检查通过 `20261111T081546Z-b29546df/result.json`；文档检查通过 `20261111T081546Z-bf832ee3/result.json`，仅 6 条既有日志入口 warning。actionlint 本机未安装，未声称真实 GitHub workflow 语法/执行层已通过；静态接线由回归测试覆盖。
- 新核对页内容更新后重新生成 `20261111T081546Z-7cf2c2e3/result.json`，浏览器相同桌面/窄屏测量再次通过 `20261111T081633Z-b744eccc/result.json`；未修改模板结构。当前全部 11 个任务文件格式与个人路径检查通过 `20261111T081747Z-53f61939/result.json`，日志/核验/复核入口登记后文档复验通过 `20261111T081809Z-e434f90b/result.json`，仍只剩 6 条旧 warning。

### 续 5：独立复核发现与修复在途

- 独立复核重跑 59 项通过，但专用探针抓出 HTTP IncompleteRead/BadStatusLine 未进入重试、最终放行前缺 deadline 复核；另建议无效/非稳定 expected-tag 参数即时拒绝。主会话抽查真实 HTTPResponse 探针及结果，不直接信任摘要。
- Findings 已写 `REVIEW_FINDINGS.md`，交实施者修复 R1–R3、补回归红绿，之后再只读复验；无明确 workflow 缺陷，真实 CI summary/artifact 为接受的未测边界。尚未放行或提交。

### 续 6：复核问题修复与等待放行

- R1 明确捕获 HTTPException（IncompleteRead/BadStatusLine），恢复/持续截断回归使用真实 HTTPResponse；R2 最终成功决策前再次检查 deadline；R3 空 tag 允许 latest，非空 stable vX.Y.Z 在任何网络/等待前验证。
- 新增回归在缺少 R1–R3 修复的首轮代码上真实失败：`20261111T082127Z-21183abf/result.json`，27 个测试/17 failures/11 errors（含参数化子项）；修复后受影响 suites 共 65 项全通过 `20261111T082153Z-73f721f9/result.json`。主会话抽查代码和实际 result/log；独立审查者二次复验在途，未提交。
- 修复后主会话真实官网成功路径再次通过 `20261111T082326Z-12e1dc5d/result.json`（canonical latest=1.11.2，0.8s）；清单重新生成 `20261111T082326Z-ac0fbe28/result.json`，格式/个人路径/选定 diff 通过 `20261111T082326Z-3b86474d/result.json`，文档复验通过 `20261111T082326Z-50ab66e8/result.json`（6 条旧 warning）。源码未改层不重复全量应用测试，本任务无前端 bundle 或安装包变更。

### 续 7：独立放行与提交准备

- 独立二次重跑 65 项通过 `20261111T082349Z-d9d189b7/result.json`；带断言闭环探针 `20261111T082349Z-0203d78b/result.json` 证明真实 HTTP 截断/坏状态行恢复、持续截断超时拒绝、最终 deadline 拒绝与 6 种非法 tag 无网络等待。R1–R3 全部闭环，无剩余 blocker/major。
- 审查探针为适配非法 tag 即时失败的空 stdout，另用 stderr 取诊断；没有改实现或把探针错误当应用错误。核验页更新后浏览器布局实测通过 `20261111T082408Z-1da8d650/result.json`；下一次 CI 的失败 summary/artifact 和人工清单仍 pending。
- 仅暂存/提交本任务明确路径，含上一轮 ASS 反馈核对补充；不推送、不移动版本/tag，不修改用户或其他会话 WIP。
- 最终清单生成通过 `20261111T082504Z-bb459e83/result.json`，文档通过 `20261111T082504Z-315973b9/result.json`，仅 6 条旧日志 warning。全部开发条目已闭环；待人工/远端部分只有下一次 CI summary/artifact 与核对清单 3 项，不能把它们当自动化通过。

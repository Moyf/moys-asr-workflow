# 有界输出与分层调试

目标：失败时保留足够证据，同时避免生成文件、单行巨型断言和重复日志吞掉上下文。运行器只负责执行与记录，不安装环境、不判断产品正确性、不把 skip 当作功能已验证。

## 开始前只做一次环境确认

1. 确认当前 worktree、分支、`git status --short`、`git log -1 --oneline`，记录任务基线。
2. 检查已安装的 Python / Node 与依赖。Python 测试优先直接指定现有解释器；若复用另一 worktree 的 venv，先比较 `uv.lock`，不得同步修改共享环境。给 Node 设置 `MAW_TEST_PYTHON`，给 e2e 设置 `MAW_E2E_PYTHON`。两者用途不同。
3. 需要 Node 依赖时在当前 worktree 执行一次 `pnpm install --frozen-lockfile`。只有浏览器层需要 Chromium；不要为纯日志、Python 标准库或 Node 标准库测试安装整套环境。
4. 普通 `uv run` 可能在冷环境中解析和同步依赖而超时；Agent 用 `uv run --no-sync`，缺包只记录一次，再选择现有环境或由开发者同步。不要通过换临时目录、缓存目录、重装环境来反复试同一功能失败。

Windows 沙箱的系统临时目录若不可写，可为**当前测试进程**设置 `TEMP` / `TMP` 为本 worktree 的 `.artifacts/checks/tmp`；不要修改全局环境。进程树清理若被沙箱拒绝，运行器会记录 `cleanup_error`，不能把它报告为完整清理成功。

## 开发入口与 bundle

- `pnpm run dev` / `pnpm run dev:editor`：先构建编辑器 bundle，再启动编辑器并监听源码变化。
- `pnpm run dev:launcher` / `pnpm run devl`：先依次构建编辑器与 Launcher 两套 bundle，全部成功后启动 Launcher，并同时运行两个 watcher；在 Launcher 中打开编辑器时无需补做首次构建。
- `pnpm run launcher`：同样预构建两套 bundle 后启动 Launcher，但不挂 watcher。任一构建失败都不会启动 Python 入口；开发模式下 watcher 异常退出会结束会话，避免继续使用未更新的产物。
- 关闭 Python 入口或按 Ctrl+C 会回收会话的所有 watcher。两个 watcher 都忽略双方的 bundle、构建信息、原子发布临时文件和现存目录的变更事件，避免互相触发重建；源码文件修改与删除仍会触发构建。修改构建脚本后仍需重启开发会话。

## 默认查源码，生成物按需验证

- `.rgignore` 排除普通搜索中的 bundle、便携 HTML、历史扫描 JSON、锁文件与日志；不会取消这些文件的 Git 跟踪，也不影响编译和测试。
- 先 `rg -l '符号' web/editor web/shared`，再在选定文件用 `rg -n --max-columns 240 --max-columns-preview '符号' <文件>`。
- 依赖问题需要显式查锁文件；bundle 问题先查清单、源码和 `.meta.json`，运行 `check:editor` 验证。必要时显式指定生成文件路径进行窄范围搜索。
- Git 不使用 `.rgignore`。先看 `git diff --stat` / `git diff --name-status`，随后 `git diff -- <选定源码文件>`；暂存改动同理加 `--cached`。不要默认输出整份 diff，也不要读取完整便携 HTML。
- bundle 冲突通过源码与清单解决后重建；不要手动合并生成 JS。`blank-editor.html` 仍只在发布或维护者要求时重建。
- `debug.log` 已从版本索引移除并忽略，本 worktree 的原文件保留；不会清理其他工作区的日志。

### Codegraph 排查

- 调用要显式传 `projectPath`。`.codegraph/` 为空时可能回退到父级索引；若出现外仓库文件，先查仓库的 `.codegraph/codegraph.db`。
- worktree 默认没有独立索引，可用主仓库索引做符号／调用关系导航，内容以当前 worktree 的 `rg` / `Select-String` 和原文件为准。大量增删改时直接搜索当前源码；确需独立索引才在该 worktree 运行 `codegraph init`。

## 有界执行入口

在待验证的 worktree 根目录执行，示例中的 `python` 必须指向选定的已安装解释器：

```powershell
python scripts/run_check.py --timeout 60 -- python -m unittest tests.test_run_check tests.test_compact_assertions
python scripts/run_check.py --timeout 60 -- node --test tests/test_e2e_output_tail.mjs tests/test_e2e_server_lifecycle.mjs
python scripts/run_check.py --timeout 180 -- node scripts/build-editor.mjs --check
python scripts/run_check.py --timeout 180 -- node node_modules/typescript/bin/tsc -p web/tsconfig.typecheck.json
python scripts/run_check.py --timeout 600 -- node node_modules/@playwright/test/cli.js test --config=tests/config/playwright.config.mjs --project=chromium tests/e2e/editor-bundle.spec.mjs
```

`--` 后是可执行文件与参数，不是 shell 表达式；管道、重定向和环境变量赋值在外层处理。运行器关闭 stdin，stdout / stderr 合并直接写文件，避免等待继承管道的 EOF。

仓库 unittest 用 `uv run --no-sync python scripts/run_tests.py`，可接文件、点号名称或 `--full-log`；裸 `python -m unittest` 只用于确需完整输出的诊断或上面的标准库探针。对页面或内联脚本做成员断言的测试类继承 `tests/compact_assertions.py` 的 `CompactContainerAssertions`，避免失败时把整页打印成一行。

`scripts/run_tests.py --parallel N` 仅在不指定 targets 的平铺测试发现中按文件并行。发现测试子包（子目录含 `__init__.py`）时会提示并回退标准串行发现，保留包初始化和 `load_tests` 的执行、筛选与错误；文件自身的 `load_tests` 仍接收原始 `--pattern`，返回的自定义用例和导入的测试类都会执行。指定 targets 时同样回退串行；默认不加 `--parallel` 的行为不变。

每次创建 `.artifacts/checks/<UTC时间-随机ID>/`：

| 文件/结果 | 意义 |
| --- | --- |
| `output.log` | 原始完整输出，本地排障证据，不默认读回上下文 |
| `result.json` | 命令、cwd、PID、耗时、退出码、日志大小、短诊断与清理结果 |
| 终端摘要 | 最多 20 条诊断 + 6 条尾部，每条最多 240 字符，重复行去重 |
| `exit=124` / `status=timeout` | 超过显式时限，尝试清理本次进程树 |
| `exit=127` / `status=launch-error` | 可执行文件未启动，不是测试断言失败 |
| `exit=130` / `status=interrupted` | Ctrl+C 中断并尝试清理；其他非零值保留原命令失败状态 |

摘要按常见 unittest、Node、Playwright 输出启发式提取，不承诺列出全部失败。超大日志只扫描前 16 MiB 和末尾 8 KiB，明确标记 `scan_limited`；前部诊断保留行首，尾部保留有界行末片段，使超长单行末尾的最终 ERROR 仍可见。缺失细节需围绕具体失败点定向读取。完整日志不限制磁盘大小，长时限任务仍需关注磁盘空间；本工具不会自动删除证据。

Windows 超时使用本次 PID 的 `taskkill /T`，POSIX 使用新进程组；不会按 python/node/chrome 名称全局杀进程。被强杀的运行器、已逃离进程组的服务、Windows 根进程先退出后的孤儿进程不在可靠清理承诺内。正常服务结束仍必须由 fixture 的 `stop()` 负责，详情见 [e2e 排查](E2E_SERVER_HANG.md)。

e2e helper 仅保留最近 4096 字符的服务输出，stdout/stderr 分别解码 UTF-8；退出与启动超时错误含短尾部。进程管理继续使用 `server-process.mjs`：Windows Job supervisor 的 stdin 必须保持管道，以便 owner 消失时回收后代；不得以本通用运行器的 stdin=ignore 配置覆盖它。浏览器 trace、截图与 HTML 报告依然按需读取，不应整份加入对话。

## 长命令、后台进程与孤儿清理

超过一两次工具超时的命令（全量 Python、Playwright、codemod、打包）不要在前台等，也不要把工具超时当成兜底：

- **后台启动**：`Start-Process -WindowStyle Hidden`（不要 `-NoNewWindow`，它会占住当前控制台），stdout / stderr 重定向到文件后再按端口或日志探活。e2e 日常入口是 `scripts/run-e2e.ps1`；`scripts/refactor-tools/run-e2e-bg.ps1` + `poll-e2e.ps1` 是更早的后台封装，仍可用。
- **轮询而不是等**：查 PID 是否存活、日志尾部是否仍在增长；每条命令给显式时限（短命令 60 秒，测试类按本次集合 5–15 分钟）。不要把 `uv run` 与 `Test-NetConnection`、`Start-Sleep` 等慢命令串联。
- **真卡还是在跑**：日志中的进度计数仍在增加、进程存活，就继续等；两者都不满足时才按中断处理。
- **超时 / 中断后先回收本次进程树**：`scripts/run_check.py` 按本次 PID 处理（Windows `taskkill /T`，POSIX 新进程组）；e2e 服务由 fixture 的 `stop()` 负责。**禁止按 node / chrome / python 进程名批量清理**，会误杀其他 worktree 与用户进程；归属核对与清理命令见 [E2E 残留服务进程与长命令挂起](E2E_SERVER_HANG.md)。
- **大段参数与字节保真**：Windows 命令行上限约 32K，长文本、JSON、报告不要塞进 `node -e`、`git commit -m` 之类的 argv；写临时 UTF-8 无 BOM 文件，用 `--body-file` / `-F` / 文件加载器传入。超过三行或引号复杂的内联逻辑写成 `.mjs` / `.ps1` 再执行；输出意外为空时先核对参数与引号。`git show ref:path` 等落盘用 node 或 `cmd /c "... > file"`，避免编码与缓冲差异。仓库源码保持 LF 与无 BOM，PowerShell 产物先用 node / python 规范化再入库。
- **不要用 bash 后台 `&`**：stdin 仍挂在会话管道上，命令工具会等进程树而永久阻塞；长驻服务用独立终端或上面两种方式启动，用完必须终止。

## 按变化选择测试层

| 变化 | 首轮验证 | 扩大验证的条件 |
| --- | --- | --- |
| 调试运行器 / 日志工具 | 上面两条标准库回归，无需前端安装 | 进程生命周期变更需在 Windows / Linux 跑 CI |
| Python 业务逻辑 | 对应 unittest 模块 | 公共契约/导出变化时扩大相关验证；完整巡检按明确请求或发布需要运行，不要求每笔改动都全量 |
| 编辑器 JS / 装配清单 | 相关 Node 用例 + build/check + typecheck | 宿主、选择范围、交互变化时增加相关浏览器 spec |
| CSS / HTML / 交互 | 构建契约 + 对应 spec + 人工操作 | 多入口共享行为变化时扩大浏览器范围 |
| 发布 | 统一重建便携 HTML，完整契约与回归矩阵 | 真实媒体、推理和听感仍单独验收 |

`pnpm test` 是 Chromium e2e；`pnpm run test:unit` 执行根目录全部 `.mjs` 测试，其中已有跨 Python 与浏览器测试，不能假定它们都零依赖。不要每改一个断言就跑全量。先复现一次，改代码后跑最小回归，必要时扩大；连续两次同类失败先分类原因，不循环重跑。

日常 `Change acceptance` 只汇总计划所选的稳定基础、相关验证及文档消费者，不串联完整巡检或 Windows 预览。完整矩阵保留每周/手动运行，预览包按打包/启动/运行时相关变化或手动运行，不再与每次普通PR/main叠跑。具体角色见[改动检查](DEVELOPMENT.md#pr--main-的改动检查)及[完整巡检](DEVELOPMENT.md#完整巡检预览包与发布)。UI 的拖动、听感和布局仍需人工核验。

## 中断恢复与结果记录

任务记录只维护：问题、状态、修改文件、验证命令、对应 HEAD/工作区变化、结果路径、未验证边界。恢复先读这个表与 diff 文件清单，再读所需源码和某一次 result.json。不要重新调入完整历史会话或整个测试日志；引用旧会话时先取少量回合与所需字段。

已有结果在对应源码未变且环境一致时复用；代码变化只使相关层证据失效。失败次数、跳过原因、环境阻塞和人工未验收必须单列，不能用总体退出码 0 代替覆盖范围说明。


### unittest 分组与可信报告

`python scripts/run_tests.py --pack media --required --report .artifacts/media.json`
在 unittest 标准发现之后按测试 ID 分组（common / media / long-media / tools / manual）；
未知测试默认 common。发现仍执行包初始化、导入及 `load_tests`，加载错误不会被分组隐藏。
分组暂用串行，`--parallel N` 保留无参数全量的文件并行入口；显式 targets 不拆分，
也不能与 `--pack` 混用。无参数仍跑原来的完整集合。

`test_fcp7_png.RenderTests` 整类和 `test_fcp7_png_api.PngJobHttpTests.test_render_publish_and_repeated_export_preserve_prior_package` 的真实 FFmpeg 渲染属于 media；同文件的规划、假渲染和其余 HTTP 逻辑仍属于 common。不改变标准发现 / hooks，也不把同名但不同模块的类自动归组。

`--report` 在串行和并行模式记录所选 ID、实际运行数、失败/错误、skip 原因、
expected failure、unexpected success、退出码及完整日志位置；并行另有文件、PID 和耗时。
完整日志包含成功与失败测试、加载阶段以及子进程输出；终端仅打印有界摘要。
`--full-log` 可指定日志位置，未指定时报告旁生成同名 `.log`。
`--required` 将缺工具、缺依赖、缺夹具或 expected failure 视为失败；仅准确匹配的
异平台测试 ID 和 skip 原因可豁免。空集合返回失败。分组是显式执行入口，不自动缩减 CI。

### CI 计划与浏览器证据

日常计划与完整巡检分开消费：PR验证整个PR差异，main验证before/after，普通文档可轻量；未知代码/不可信差异扩大至稳定检查而不是自动启动完整矩阵。计划校验失败不能伪装成文档通过；阻塞和辅助回执分开，辅助成功不能抵扣阻塞缺报告。策略版本、准确所选集合及消费者以当次计划与脚本输出为准，不把历史v1的“非PR必须full”当作当前规则。

Windows 测试环境、发布测试和 PR 预览共用固定的 Gyan FFmpeg 8.1.2 Essentials x64，
与完整 Windows 发行包的版本和 SHA-256 一致。Actions 缓存只保存归档，按系统、架构、
版本及安装脚本（含校验值）隔离；每次使用前重新校验 SHA-256，再解压并运行两个真实
程序。校验失败时丢弃本地副本，从 Gyan 或 GitHub 固定地址有界重试；不回退系统版本。
GitHub 缓存遵循分支及 fork 的访问范围，并可能被回收；冷启动仍需网络。已有损坏缓存
键不可覆盖，当前运行会重新下载，后续运行可能再次下载，直到该缓存被删除或回收。
并发任务可能各自下载，只有一个保存同一键。缓存不减少 Windows Media Foundation 安装时间。

完整巡检继续用 `scripts/ci_matrix.py expand`、`run --cell <cell>` 与 `gate` 校验完整矩阵自身结果；它失败仍失败，但不传播至无关PR的日常合并结论。Python 单元在回执前回读 `python.json` 与 `media-required.json`，校验非空唯一 ID、计数和退出码，保留 unittest fixture / subtest skip 语义；required 不信任序列化的 `platform_not_applicable`，而重新调用精确平台策略。两份报告的归组集合必须一致，回执附校验计数和报告 SHA-256。缺 / 坏报告、伪造成功退出或不支持的 required skip 都不产生成功回执；输出目录拒绝复用旧报告，重试请使用新的 `--root` 以保留旧证据。

浏览器分片的整组执行预算为 900 秒；发现列表及 Python / Node 命令仍为 600 秒。单项测试 60 秒、操作 10 秒、零重试不变。浏览器 job 的 25 分钟上限另容纳环境准备与上传，不表示放宽单测。`line,json` 双 reporter 在 `output.log` 留下逐项开始进度，同时保留最终 JSON 覆盖校验；整组超时仍失败，未写完 JSON 时不会产生成功回执。

浏览器层在同 job 保存 `browser-list.json`、`browser-results.json`、`browser-validated.json` 和成功凭据 `receipt.json`。`scripts/browser_results.py <list.json> <results.json> --current 1 --total 4` 可独立复核：比较文件 + 完整 describe / test 标题 + project 集合、分片坐标和逐案结果，不以 `stats.expected > 0` 代替覆盖检查。失败执行即使没生成成功凭据仍上传已有 JSON / traces / checks；缺报告不能通过聚合门禁。只有五个精确弃维护 portable case 的原始 skip 原因获准，libass / 编码器等能力缺失仍失败。计划未选中的层属于 intentional skip，与实际用例 skip 分开。

完整 Python 不加 blanket `--required`：完整标准发现允许人工私有夹具、平台 guard 等 skip，并将每个原因和 expected failure 留在报告；完整巡检的真实 media pack 单独 `--required`，`allowed_platform_skip` 不扩大。这里的required是所执行集合的严格结果语义，不等于GitHub必需合并状态。Release 三平台报告、Windows 阻断与辅助平台警告政策不变，不追加tag全量矩阵。本地或当前PR未跑完整浏览器集合时必须标明，不能以Change acceptance绿宣称全仓测试全绿。

### 中文 CI 检查摘要

完整矩阵等任务可在 Actions **Summary** 附加中文说明。摘要是辅助阅读层，不改变退出码、断言、所执行集合的required语义或原始日志。
汇总明确区分日常合并检查和完整辅助巡检，后者失败不自动阻止无关PR合并；连带失败不重复算作产品故障。
缺报告、取消、执行前失败不能当作“零失败”；仍须查看失败步骤和对应 artifact。

`scripts/ci_summary.py` 从 unittest / Playwright JSON 提取失败名称、位置与有界错误摘录。
仅 `DESCRIPTIONS` 中精确匹配的用例有人工维护的中文场景和预期；其余保留原标题，
明确说明尚未提供中文描述。原因不从异常名猜测，始终需要排查。
新增描述时同时核对测试契约，不能把预期写成已经发生的结果。
第一版不解析 Node TAP、构建器或安装日志，不自动评论 PR，不改变历史失败通知。
Python JSON 的 `failure_details` 是附加字段，串行和并行路径均保留；完整 traceback
仍在原 `.log` 中。摘要限制报告大小、展示条数和文本长度，转义 HTML 并脱敏用户目录。
摘要步骤即使失败，也不会掩盖原测试失败或替代矩阵校验。

写用例、分析首次失败与判断测试价值，见[测试可靠性指南](../INDEX.md#engineering-test-reliability)。

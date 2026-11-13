# 有界输出与分层调试

目标：失败时保留足够证据，同时避免生成文件、单行巨型断言和重复日志吞掉上下文。运行器只负责执行与记录，不安装环境、不判断产品正确性、不把 skip 当作功能已验证。

## 开始前只做一次环境确认

1. 确认当前 worktree、分支、`git status --short`、`git log -1 --oneline`，记录任务基线。
2. 检查已安装的 Python / Node 与依赖。Python 测试优先直接指定现有解释器；若复用另一 worktree 的 venv，先比较 `uv.lock`，不得同步修改共享环境。给 Node 设置 `MAW_TEST_PYTHON`，给 e2e 设置 `MAW_E2E_PYTHON`。两者用途不同。
3. 需要 Node 依赖时在当前 worktree 执行一次 `pnpm install --frozen-lockfile`。只有浏览器层需要 Chromium；不要为纯日志、Python 标准库或 Node 标准库测试安装整套环境。
4. `uv run --no-sync` 不负责准备依赖；冷环境缺包时先记录缺什么，再选择现有环境或一次性同步。不要通过换临时目录、缓存目录、重装环境来反复试同一功能失败。

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

## 按变化选择测试层

| 变化 | 首轮验证 | 扩大验证的条件 |
| --- | --- | --- |
| 调试运行器 / 日志工具 | 上面两条标准库回归，无需前端安装 | 进程生命周期变更需在 Windows / Linux 跑 CI |
| Python 业务逻辑 | 对应 unittest 模块 | 公共契约/导出变化时扩大到相关模块，最后一次全量 |
| 编辑器 JS / 装配清单 | 相关 Node 用例 + build/check + typecheck | 宿主、选择范围、交互变化时增加相关浏览器 spec |
| CSS / HTML / 交互 | 构建契约 + 对应 spec + 人工操作 | 多入口共享行为变化时扩大浏览器范围 |
| 发布 | 统一重建便携 HTML，完整契约与回归矩阵 | 真实媒体、推理和听感仍单独验收 |

`pnpm test` 是 Chromium e2e；`pnpm run test:unit` 执行根目录全部 `.mjs` 测试，其中已有跨 Python 与浏览器测试，不能假定它们都零依赖。不要每改一个断言就跑全量。先复现一次，改代码后跑最小回归，必要时扩大；连续两次同类失败先分类原因，不循环重跑。

既有 Editor job 运行完整 Node、Python 装配及专项契约、选定浏览器子集，不是完整 Python/e2e；Windows preview 仍运行完整 Python、同次 cache 校验、64 / 4 浏览器专项及打包 smoke。Debug tooling 在 Windows / Linux 验证标准库调试工具，不能冒充产品全量验证。新增 `test-matrix.yml` 以追加 runner 成本补完整覆盖，具体范围见[完整补充矩阵](DEVELOPMENT.md#完整补充矩阵与-required-语义)；UI 的拖动、听感和布局仍需人工核验。

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

### 新 CI 计划与浏览器证据

`scripts/ci_impact.py --plan .artifacts/ci-plan.json` 输出版本、模式、有限 profile、原因与 base/head；非 PR 或差异不可信时 full。`scripts/ci_matrix.py expand` 校验计划并生成有限矩阵，`run --cell <cell>` 在 `run_check` 内执行完整层或明确的领域浏览器集合，`gate` 校验所有应执行单元。旧工作流仍只消费兼容的 `light` 字段，不受 domain 缩减。

`ci_matrix.py` 的 CLI consumer 同时检查实际 `GITHUB_EVENT_NAME`：明确非 PR 事件拒绝非 full 计划；本地未设置事件时仍可执行纯函数 / 夹具验证。Python 单元在回执前回读 `python.json` 与 `media-required.json`，校验非空唯一 ID、计数和退出码，保留 unittest fixture / subtest skip 语义；required 不信任序列化的 `platform_not_applicable`，而重新调用精确平台策略。两份报告的归组集合必须一致，回执附校验计数和报告 SHA-256。缺 / 坏报告、伪造成功退出或不支持的 required skip 都不产生成功回执；输出目录拒绝复用旧报告，重试请使用新的 `--root` 以保留旧证据。

浏览器层在同 job 保存 `browser-list.json`、`browser-results.json`、`browser-validated.json` 和成功凭据 `receipt.json`。`scripts/browser_results.py <list.json> <results.json> --current 1 --total 4` 可独立复核：比较文件 + 完整 describe / test 标题 + project 集合、分片坐标和逐案结果，不以 `stats.expected > 0` 代替覆盖检查。失败执行即使没生成成功凭据仍上传已有 JSON / traces / checks；缺报告不能通过聚合门禁。只有五个精确弃维护 portable case 的原始 skip 原因获准，libass / 编码器等能力缺失仍失败。计划未选中的层属于 intentional skip，与实际用例 skip 分开。

完整 Python 不加 blanket `--required`：完整标准发现允许人工私有夹具、平台 guard 等 skip，并将每个原因和 expected failure 留在报告；真实 media pack 单独 `--required`，既有 required subset 保留，`allowed_platform_skip` 不扩大。Release 三平台也使用报告入口，Windows 阻断与辅助平台警告政策不变；tag 触发的新矩阵独立于 publish。完整新矩阵增加而非削减总 runner 成本，远端尚未运行；本地未跑完整浏览器集合时务必标明。

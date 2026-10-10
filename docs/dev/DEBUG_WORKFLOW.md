# 有界输出与分层调试

目标：失败时保留足够证据，同时避免生成文件、单行巨型断言和重复日志吞掉上下文。运行器只负责执行与记录，不安装环境、不判断产品正确性、不把 skip 当作功能已验证。

## 开始前只做一次环境确认

1. 确认当前 worktree、分支、`git status --short`、`git log -1 --oneline`，记录任务基线。
2. 检查已安装的 Python / Node 与依赖。Python 测试优先直接指定现有解释器；若复用另一 worktree 的 venv，先比较 `uv.lock`，不得同步修改共享环境。给 Node 设置 `MAW_TEST_PYTHON`，给 e2e 设置 `MAW_E2E_PYTHON`。两者用途不同。
3. 需要 Node 依赖时在当前 worktree 执行一次 `pnpm install --frozen-lockfile`。只有浏览器层需要 Chromium；不要为纯日志、Python 标准库或 Node 标准库测试安装整套环境。
4. `uv run --no-sync` 不负责准备依赖；冷环境缺包时先记录缺什么，再选择现有环境或一次性同步。不要通过换临时目录、缓存目录、重装环境来反复试同一功能失败。

Windows 沙箱的系统临时目录若不可写，可为**当前测试进程**设置 `TEMP` / `TMP` 为本 worktree 的 `.debug-runs/tmp`；不要修改全局环境。进程树清理若被沙箱拒绝，运行器会记录 `cleanup_error`，不能把它报告为完整清理成功。

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
python scripts/run_check.py --timeout 180 -- node node_modules/typescript/bin/tsc -p tsconfig.typecheck.json
python scripts/run_check.py --timeout 600 -- node node_modules/@playwright/test/cli.js test --project=chromium tests/e2e/editor-bundle.spec.mjs
```

`--` 后是可执行文件与参数，不是 shell 表达式；管道、重定向和环境变量赋值在外层处理。运行器关闭 stdin，stdout / stderr 合并直接写文件，避免等待继承管道的 EOF。

每次创建 `.debug-runs/<UTC时间-随机ID>/`：

| 文件/结果 | 意义 |
| --- | --- |
| `output.log` | 原始完整输出，本地排障证据，不默认读回上下文 |
| `result.json` | 命令、cwd、PID、耗时、退出码、日志大小、短诊断与清理结果 |
| 终端摘要 | 最多 20 条诊断 + 6 条尾部，每条最多 240 字符，重复行去重 |
| `exit=124` / `status=timeout` | 超过显式时限，尝试清理本次进程树 |
| `exit=127` / `status=launch-error` | 可执行文件未启动，不是测试断言失败 |
| `exit=130` / `status=interrupted` | Ctrl+C 中断并尝试清理；其他非零值保留原命令失败状态 |

摘要按常见 unittest、Node、Playwright 输出启发式提取，不承诺列出全部失败。超大日志只扫描前 16 MiB 和末尾 8 KiB，明确标记 `scan_limited`；超长单行截断，缺失细节需围绕具体失败点定向读取。完整日志不限制磁盘大小，长时限任务仍需关注磁盘空间；本工具不会自动删除证据。

Windows 超时使用本次 PID 的 `taskkill /T`，POSIX 使用新进程组；不会按 python/node/chrome 名称全局杀进程。被强杀的运行器、已逃离进程组的服务、Windows 根进程先退出后的孤儿进程不在可靠清理承诺内。正常服务结束仍必须由 fixture 的 `stop()` 负责，详情见 [e2e 排查](../E2E_SERVER_HANG.md)。

e2e helper 仅保留最近 4096 字符的服务输出，stdout/stderr 分别解码 UTF-8；退出与启动超时错误含短尾部。浏览器 trace、截图与 HTML 报告依然按需读取，不应整份加入对话。

## 按变化选择测试层

| 变化 | 首轮验证 | 扩大验证的条件 |
| --- | --- | --- |
| 调试运行器 / 日志工具 | 上面两条标准库回归，无需前端安装 | 进程生命周期变更需在 Windows / Linux 跑 CI |
| Python 业务逻辑 | 对应 unittest 模块 | 公共契约/导出变化时扩大到相关模块，最后一次全量 |
| 编辑器 JS / 装配清单 | 相关 Node 用例 + build/check + typecheck | 宿主、选择范围、交互变化时增加相关浏览器 spec |
| CSS / HTML / 交互 | 构建契约 + 对应 spec + 人工操作 | 多入口共享行为变化时扩大浏览器范围 |
| 发布 | 统一重建便携 HTML，完整契约与回归矩阵 | 真实媒体、推理和听感仍单独验收 |

`pnpm test` 是 Chromium e2e；`pnpm run test:unit` 执行根目录全部 `.mjs` 测试，其中已有跨 Python 与浏览器测试，不能假定它们都零依赖。不要每改一个断言就跑全量。先复现一次，改代码后跑最小回归，必要时扩大；连续两次同类失败先分类原因，不循环重跑。

CI 的 Editor job 目前只运行两类 Python 装配契约与两份 browser spec，并非完整 Python/e2e 套件。新 Debug tooling job 在 Windows / Linux 验证标准库调试工具；同样不能冒充产品全量验证。UI 的拖动、听感和布局仍需人工核验。

## 中断恢复与结果记录

任务记录只维护：问题、状态、修改文件、验证命令、对应 HEAD/工作区变化、结果路径、未验证边界。恢复先读这个表与 diff 文件清单，再读所需源码和某一次 result.json。不要重新调入完整历史会话或整个测试日志；引用旧会话时先取少量回合与所需字段。

已有结果在对应源码未变且环境一致时复用；代码变化只使相关层证据失效。失败次数、跳过原因、环境阻塞和人工未验收必须单列，不能用总体退出码 0 代替覆盖范围说明。

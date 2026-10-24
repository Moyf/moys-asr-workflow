# 媒体分层与可信报告整合复核

2026-10-23，原 PR #299 `a5f1316b` 接入 #295、#292、#298 的已验证组合 `189ae21d`，并接入实际 post-298 main `acefaa57`。两者文件树一致；实际 main 合并后 `f4c8a002` 的树也与已验证组合完全一致。仅修改测试、运行器、CI 与说明，无产品行为变更。

## 发现与处理

| 发现 | 证据与结论 | 处理 |
| --- | --- | --- |
| 普通模式类级 skip 的串并行退出码不一致 | 临时测试类在 `setUpClass` 抛 `SkipTest`，已选 1 项但实际运行 0 项、skip 1 项。串行返回 0，原并行误将 `testsRun == 0` 当成空选择返回 1。撤去修复的真实负例为 `.artifacts/checks/20261023T050812Z-5233ee8e/result.json`。 | 并行空集合判断改用 `selected_ids`；新增普通/required × 串行/双 worker 回归。普通模式均成功，required 模式仍失败；失败、错误和 unexpected success 门槛保留。 |
| 媒体执行集合或原 CI 被缩减的风险 | 比较三个工作流，媒体 required 步骤及始终上传报告均为增量；原全量 Python、装配、Node、真实浏览器和打包命令保留，也保留 #292 新增的三项浏览器回归。 | 无需额外修复。 |
| 动态发现、完整日志及真实媒体边界 | 独立审查覆盖 imported/load_tests、加载失败、模块 skip、required 平台例外与完整输出。实际媒体保留坏文件经过 FFprobe、HTTP 保存和备份，以及有效 WAV 正对照。 | 无 blocker / major；不扩大 skip 豁免，不降低断言。 |

## 本轮本地验证

Windows / Python 3.11.15 / Node 22.23.4，依赖同锁只读复用。以下命令由 `scripts/run_check.py` 限时包裹；收据均在忽略目录，未提交日志、媒体或个人路径。

| 层 | 命令或方式 | 结果与收据 |
| --- | --- | --- |
| 运行器 | `python scripts/run_tests.py tests/test_run_tests_runner.py --required --report .artifacts/merge-four/pr299-runner.json` | 19 项，零 skip；`20261023T050933Z-70d2a4eb/result.json` |
| 实际媒体串行 | `python scripts/run_tests.py tests/test_media.py tests/test_ffmpeg.py tests/test_ffprobe_failure_integration.py --required --report .artifacts/merge-four/pr299-media-serial.json` | 42 项，零 skip；`20261023T050933Z-41f7f585/result.json` |
| 实际媒体双 worker | 临时 discovery wrapper 的 `load_tests` 委托上述三个真实模块，不复制测试类、不改变 ID；标准发现后由文件并行引擎执行 | 42 项，零 skip；`20261023T050937Z-b0674bc4/result.json`，两个不同 worker PID，唯一 ID 集与串行完全一致 |
| 服务器、绑定及批处理 | `python scripts/run_tests.py tests/test_launcher_batch.py tests/test_gap_removed_binding.py tests/test_project_binding_lifecycle.py tests/test_local_editor_server.py --required --report .artifacts/merge-four/pr299-server-binding.json` | 141 项，零 skip；`20261023T050933Z-27ab8ac6/result.json` |
| 静态检查 | Ruff、编辑器 bundle 新鲜度、`git diff --check` | 通过；Ruff `20261023T050933Z-ce2eabf4`，新鲜度 `20261023T050934Z-efc24989` |

逐项读取 JSON，确认 `run == selected_ids 数量 == 唯一 ID 数量`，failures/errors/skips/expected_failures/unexpected_successes 全空、exit 0、完整日志存在；并行分文件 run 之和为 42，两个真实坏文件场景均在执行集合中。独立审查者只读复核上述报告、负例、wrapper 和最终 diff，无新增阻塞。

## 放行与边界

- 接入实际 main 后再次通过 required 运行器 19 项（`20261023T051734Z-fe206a22`）、真实媒体 42 项（`20261023T051730Z-395876ce`），均零 skip；文档、隐私和 bundle 新鲜度也通过（`051733Z-188e3ebe`、`051736Z-bc0e9609`、`051737Z-12cfbf80`）。远端放行只采用最终准确 head 的新 CI。
- Linux 与 Windows 的 required 媒体步骤和上传产物以本 PR 最新 CI 为准；本地通过不代替远端执行。
- 本轮不触发 release 工作流或人工部署；`release.yml` 的同类增量仅完成静态审查，真实发布另行验收。
- 原始抽取阶段的 18 项运行器、88 项媒体/绑定等结果保留在《验证记录》，属于历史快照，不替代上述整合结果。

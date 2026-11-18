# PR405 测试夹具独立审查

- 基线：`Moyf/fix-aligner-ffmpeg-path`，HEAD `33315392` 加未提交夹具修复。
- 范围：`tests/test_alignment_ffmpeg_worker.py` 全部 diff 与相关运行时/测试运行器实现。
- 审查方式：未参与实现的独立 agent 只读审查；主会话抽查 diff、运行结果与关键调用位置。
- 结论：无 blocker / major，无 nit；不扩大为业务 FFmpeg 修复或完整发布验收结论。

## 核对结果

1. `worker_environment()` 不继承用户配置，四处 clear 环境仍保持 PATH 隔离；真实 `run_timestamp_alignment_in_runtime`、路径解析、FFmpeg 选择与子进程调用未被新增 mock 替代，原有结果断言保留。
2. 新增守护测试检查真实数据/runtime 路径及显式覆盖。修复前同集合复现 2 failures、17 errors；临时去掉 app-data override 时新增守护测试真实失败，恢复后通过。
3. HTTP mock 针对当前模块 globals，仅限既有内存测试上下文，不修改真实 HTTP 集成测试。discovery 与包限定导入各 41 tests、0 failures/errors、27 skips。

## 接受的验证边界

- 27 skips 未增加；26 个 POSIX 媒体场景与 1 个 macOS Homebrew 场景没有本地运行证据。
- 没有非 ASCII Windows 临时目录 / 8.3 别名场景的运行证据；新增 runtime 路径归属断言受路径规范化影响。
- 未运行全量 Python、Windows 打包或完整版真实 FFmpeg 对齐，未重跑远端。
- 相关命令与 result.json 路径见 [反馈账本](TEST_FEEDBACK_PR405预览异常.md#夹具修复与验证)，原始证据不入库。

## 2026-11-18 合并前完整实现审阅

- 授权：维护者要求审查 PR405，小范围问题直接修复、复验后 Squash & Merge；复杂问题留 PR 反馈。
- 基线：PR head `5dc3cace`，目标 main `68075eaf`，目标已包含在 PR 分支；开始时工作树干净。
- 独立实现审查发现一项 major，修复范围较小，按授权直接处理；其余工具解析、四种 worker 分派、配置刷新与符号链接设计未发现确证的缺陷。

### R1：GUI 非托管回退接口未同步（已修复）

- `maw/gui_web.py:1225、3481` 给真实 `process_timestamp_alignment` 传入 `ffmpeg_path`，但它是 `maw/timestamp_alignment.py:536` 的 `run_timestamp_alignment` 别名，签名仍只接受 request，两个入口立即 TypeError。
- 原新测试用接受该关键字的替身覆盖上层函数，且 POSIX 工具条件在 Windows 跳过，未能守住真实签名契约。
- 独立探针保留真实被调用函数，只 mock 更下层；HEAD 两入口均 TypeError，main 的两个对应 GUI 方法均成功进入对齐。证据：`.artifacts/pr405-review/checks/20261118T042231Z-4972371d/result.json`。
- 处置：增加 keyword-only 可选 FFmpeg 参数并传到 align_project；新增两个 Windows 可执行、保留真实 GUI/domain/产物接线的测试，只替换模型与音频提取；先在未修复实现上验证失败，再修复复验。
- 新两项在未修复代码上实际 2 errors，均命中该 TypeError；修复后相关集合 402 tests、0 failures/errors、28 skips。证据：`.artifacts/checks/20261118T042440Z-29c3b9cc/result.json`、`20261118T042503Z-b2e37955/result.json`。已有 POSIX 媒体测试的上层替身增加 autospec 签名约束。
- 未参与修复的审查者复审参数兼容性和真实转发，并独立运行新两项：2 tests、0 failures/errors、0 skips；无未处置 blocker/major/minor/nit。证据：`.artifacts/pr405-review/checks/20261118T042548Z-264fa70e/result.json`。

### 本轮已核实的验证

- head `5dc3cace` 本地定向两组：108 tests / 27 skips、443 tests / 1 skip，零 failures/errors，不能替代 R1 的接口证据；相关 result.json 为 `.artifacts/checks/20261118T041800Z-6de54e14/` 与 `20261118T041831Z-ec184fce/` 下的文件。
- 工具 handoff 反向对照：一次性进程加载 main 原 local_runtime，同两项用例出现 5 failures（四模式为 subtests）；当前实现同两项通过。未修改工作区业务文件。证据：`.artifacts/checks/20261118T041930Z-913fca51/result.json`、`20261118T041953Z-30e7f81c/result.json`。
- Windows 真实 FFmpeg/FFprobe、空 PATH、模拟完整版布局、独立 worker：默认第 2 音轨探测与 0.5s 音频解码通过，不加载模型。证据：`.artifacts/checks/20261118T041930Z-5be9cc5b/result.json`。
- 远端 head `5dc3cace` 的 Change acceptance 和 Windows lite 预览通过；下载实际 Python 报告核实 3310 tests、0 failures/errors、38 skips，其中本新文件 41 tests / 27 skips。预览 run 44232985938，lite 包明确不包含 FFmpeg，不能证明完整版模型端到端。
- CHANGELOG 当前只有一条用户可感知的对齐修复说明，不添加内部提交、测试与调查流水账。
- Windows 上未重新运行 26 个 POSIX 与 1 个 macOS 场景；正式完整版、真实模型、用户机器仍未验证。
- 同一真实工具探针在含中文和空格的 Windows 临时父目录下也通过：`.artifacts/checks/20261118T042440Z-0b7cd606/result.json`。不推定模型依赖的中文路径问题已验证。

### 测试设计独立审查的接受风险

- 第二独立审查同样确认 R1；新增两项在 discovery 下真实失败，证明真实接口守护有效，不用原来的绿报告抵消缺陷。
- 新文件体量偏大，部分测试专门守护夹具；实际子进程、HTTP 与音轨行为仍有断言，不仅凭行数重构。preserve 模式默认关闭，显式开启会保留文件，并依赖 tempfile 私有 finalizer，接受此调试维护风险。
- 新文件默认进入完整发现，不属于阻塞准入；ci_observation 未登记只是 advisory，媒体场景尚未进入严格 media pack。此限制公开记录，不为本次 PR 扩大门禁或修改 skip 策略。

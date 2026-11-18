# PR405 Windows 预览异常核对

- 日期：2026-11-18。
- 请求范围：初始核对 Actions 失败原因；维护者随后授权修复两处测试夹具，再授权提交、推送与跟踪新提交的 CI。未授权合并 PR 或扩展业务修复。
- 事实基线：分支 `Moyf/fix-aligner-ffmpeg-path`，HEAD `33315392`；开始时工作树干净。
- 状态：待处理 / 进行中 / 已修复 / 仅说明 / 阻塞。

| 编号 | 问题 | 状态 | 核实结论 / 方案 |
| --- | --- | --- | --- |
| 1 | PR405、提交 `33315392537cb23952230e89548fafb85625cd85` 的 Windows PR 预览在 UTC 2026-11-18 03:10:26 提示「未确认 Windows MAW-lite 测试包已完成归档和上传，请查看 Actions 日志」。 | 仅说明 | 已确认打包前 Python 全量测试失败（2 failures、17 errors），后续构建、归档和上传均 skipped，并非上传动作失败。对应夹具修复见条目 2；远端原 run 未重跑。 |
| 2 | 修复 Windows 对齐测试的用户目录环境隔离与 HTTP mock 模块定位。 | 已修复 | 仅修改 `tests/test_alignment_ffmpeg_worker.py`；统一临时 app-data 环境、动态定位当前模块 HTTP mock，新增隔离守护测试。两种导入方式各 41 tests、0 failures/errors、27 skips，独立审查无阻断项。 |

## 核实结论

### Actions 事实

- 对应 [run 44227677558](https://github.com/Moyf/moys-asr-workflow/actions/runs/44227677558)，SHA 与维护者提供的一致。
- `Run Python tests` 退出码 1，耗时 186.97 秒；3309 tests，2 failures、17 errors、38 skipped。不是超时。
- 打包契约测试、编辑器显示回归及其完整结果检查成功；`Build MAW bundle`、归档与上传均 skipped。artifact 列表没有 MAW-lite ZIP，只有检查证据。
- 同 SHA 的 `Change acceptance` 成功，仅表示所选阻塞检查通过；不能表述为完整测试通过。
- `.github/workflows/pr-release-comment.yml:63–76` 根据归档与上传状态生成通用警告，不显示最先失败的测试原因。

### 原因 A：Windows 测试清空了主目录环境

- `tests/test_alignment_ffmpeg_worker.py:371、390、498、797` 使用 `mock.patch.dict(os.environ, ..., clear=True)`，只保留 SYSTEMROOT 等少量变量，丢掉 LOCALAPPDATA、USERPROFILE、HOMEDRIVE/HOMEPATH，也没有提供独立的应用数据根目录。
- 实际失败链：`maw/local_runtime.py:551` → `default_runtime_root()` → `maw/runtimes/base.py:272` → `maw/app_paths.py:33` → `Path.home()` → `RuntimeError: Could not determine home directory.`。发生在启动子进程与 FFmpeg 路径解析之前。
- 此原因对应 13 个 error 与 GUI/CLI 两个 failure。CLI 日志也打印「文稿对齐失败：Could not determine home directory.」。
- 建议修复测试环境：在继续隔离 PATH 的同时，为夹具提供临时 MAW_APP_DATA_ROOT / runtime root 或必要的 Windows 用户目录环境。不要为使测试变绿而取消真实子进程验证或放宽断言。

### 原因 B：内存 HTTP 测试 mock 目标模块不一致

- `scripts/run_tests.py:126` 的 discovery 把此文件加载为 `test_alignment_ffmpeg_worker`，CI 的测试 ID 与栈确认该模块名。
- `tests/test_alignment_ffmpeg_worker.py:204` 却 patch `tests.test_alignment_ffmpeg_worker.urlopen`。这是另一个包限定模块对象，未替换当前被执行模块的全局 `urlopen`。
- 该测试同时 mock server/thread，不启动真实服务；`run_recording_http_entry()` 在 `:1060` 因 mock 未命中而真实访问 `127.0.0.1:1`，报 WinError 10061。
- 此原因对应内存 HTTP 测试的四个子场景 error。建议 patch 实际执行模块的全局符号，例如由 `__name__` 定位模块或 `mock.patch.object(sys.modules[__name__], 'urlopen', ...)`，并覆盖 discovery 的导入方式。

## 证据与验证边界

- 已执行：`gh pr view 405 --repo Moyf/moys-asr-workflow --json headRefOid,statusCheckRollup,url`；`gh run view 44227677558 --repo Moyf/moys-asr-workflow --json jobs,conclusion,url,headSha`；失败日志查询、artifact 列表查询与 `windows-preview-python-report` 下载。
- 本地原始证据：`.artifacts/pr405-preview/failed.log` 与 `.artifacts/pr405-preview/python-report/windows-python.log`、`windows-python.json`；原始输出不入库。
- 初始调查仅核对 CI 栈与当前 HEAD 源码；随后授权的夹具修复与验证见下文。未运行本地全量测试，也未验证完整版实际 FFmpeg 对齐行为。
- 本次修改测试与调查记录，未修改业务代码或 workflow，未提交、推送或重跑 Actions。

## 夹具修复与验证

### 引入时间追溯

- `git log`、`git show --stat` 与 `git blame HEAD` 确认：整个 `tests/test_alignment_ffmpeg_worker.py`（1085 行）由提交 `085ad97e363359d8b67a92b5e412333f9994997a` 首次新增，时间为 2026-11-18 10:39:16 +08:00（UTC 02:39:16），提交标题 `fix: pass bundled ffmpeg tools to alignment worker`。
- 两处缺陷（原 :204 固定包名 mock、原 :371 等清空用户目录环境）均在该首次新增提交中，不是后续主线合并把旧夹具改坏。
- 本次提供的 CI 证据对应合并提交 `33315392`，UTC 03:07:08 开始 Python 测试、03:10:15 失败。此证据证明该次预览暴露问题，不宣称它是远端历史中的第一次失败。

- 增加 `worker_environment()`：空 PATH、禁止字节码写入、临时 `MAW_APP_DATA_ROOT` 与已有 SYSTEMROOT，显式覆盖仍可传入，不继承用户配置。用于实际 worker、四种模式、GUI 与 CLI 的环境隔离。
- 内存 HTTP mock 使用 `mock.patch.object(sys.modules[__name__], 'urlopen', ...)`，不依赖固定的包限定模块名。
- 增加守护测试：验证真实 app-data/runtime 路径在临时目录中、无主目录变量时仍可解析、不继承用户配置，以及显式工具覆盖有效。真实 worker 边界和既有断言未减少。
- 主仓库现有 Python 3.11 venv 只读复用，锁文件一致；未同步依赖。以下 `$python` 表示该解释器，命令均从当前分支工作树执行。

```powershell
& $python scripts/run_check.py --timeout 180 -- $python scripts/run_tests.py --pattern test_alignment_ffmpeg_worker.py --report .artifacts/pr405-preview/fixture-after.json
& $python scripts/run_check.py --timeout 180 -- $python scripts/run_tests.py tests.test_alignment_ffmpeg_worker --report .artifacts/pr405-preview/fixture-package.json
```

| 验证 | 结果 | 本地 result.json（位于 `.artifacts/checks/`） |
| --- | --- | --- |
| 修改前同一 discovery 集合，report 为 fixture-before.json | 40 tests，2 failures、17 errors、27 skips，与 CI 两类失败一致 | `20261118T033823Z-3d0e9143/result.json` |
| 修改后 discovery | 41 tests，0 failures/errors、27 skips | `20261118T033952Z-4c873e6a/result.json` |
| 修改后包限定导入 | 41 tests，0 failures/errors、27 skips | `20261118T034001Z-39ac9f10/result.json` |
| 临时移除 app-data override，单跑新增守护测试 | 1 test，真实失败；反向验证有效 | `20261118T034020Z-46fdea0e/result.json` |
| 恢复 override，单跑新增守护测试 | 1 test，通过 | `20261118T034032Z-7bbf8c78/result.json` |

守护测试选择 `tests.test_alignment_ffmpeg_worker.TemporaryDirectoryPolicyTests.test_worker_environment_isolates_user_data_without_home_variables`，沿用上述外层运行器；临时修改已恢复。

27 skips 与修改前一致：26 个要求 POSIX FFmpeg/FFprobe，1 个要求 macOS Homebrew ffprobe。未验证这些场景、非 ASCII Windows 临时目录/8.3 别名、全量 Python、打包或完整版实际对齐行为。`git diff --check` 通过。独立审查详见 [REVIEW_FINDINGS.md](REVIEW_FINDINGS.md)。

## 阶段汇总

- 初始记录：已保存维护者原始反馈，尚未开始远端调查。
- 续 1：调查闭环，条目 1 改为「仅说明」。确定两类测试夹具问题，建议先修复新增测试后再生成预览包；不存在本次已修复项。完整版 FFmpeg 行为验收仍未进行。
- 续 2：维护者授权夹具修复，条目 2 开始实施；可只读复用主仓库现有 Python venv，先检查锁文件一致性，不同步共享依赖。
- 续 3：条目 2 已修复，已核对代码 diff 与两种导入的实际 result.json；修复前失败与新增守护反向验证均有证据。独立审查无 blocker/major/nit，无进行中项；远端预览与完整版行为仍未验收，未提交。
- 续 4：维护者授权提交并推送本次夹具修复和记录，随后跟踪新 SHA 的 CI。提交前分支与 PR head 均确认是 `Moyf/fix-aligner-ffmpeg-path`；只提交本任务文件，不合并 PR。

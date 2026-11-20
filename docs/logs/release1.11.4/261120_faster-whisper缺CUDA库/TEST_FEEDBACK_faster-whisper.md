# faster-whisper 缺 CUDA 库反馈核对

日期：2026-11-20；调查基线：`main@fb8cdb4d`，起始工作区干净。用户版本、运行环境版本及显卡/驱动尚未提供。

初始请求：判断 `Library cublas64_12.dll is not found or cannot be loaded` 是否因为用户未安装 CUDA，以及 MAW 本身是否需要修复。初始阶段仅调查；后续授权范围见「实施交接」。

状态：`待处理`、`进行中`、`已修复`、`仅说明`、`阻塞`。

| 条目 | 反馈 / 问题 | 状态 | 核实结论 |
| --- | --- | --- | --- |
| 1 | faster-whisper large-v3：音频提取成功，cuda/float16 模型加载成功，transcribing 后报 cublas64_12.dll 找不到或加载失败；判断用户环境与 MAW 责任 | 仅说明 | 日志只能确定 CUDA12 cuBLAS DLL 装载失败，不能确定未装整个 CUDA；当前 main 的 auto 回退仅构造期，调用/生成器推理期缺口已用 5 场景 mock 复现。建议明确选 CPU 临时使用，MAW 后续补推理期 auto 单次回退及缺库提示。此次无实现授权，不改代码。 |

## 原始反馈摘要

- 12:55:04 音频提取完成，开始本地模型准备。
- 12:55:10 加载缓存中的 Systran/faster-whisper-large-v3，设备 cuda、compute_type=float16。
- 12:55:16 faster-whisper loaded，开始 audio.wav 转写。
- 12:55:18 缺少或无法加载 cublas64_12.dll；12:55:20 转写子进程退出 1。
- 媒体/模型本机绝对路径不收入共享日志。

## 阶段汇总

反馈已记录；不能凭 DLL 报错直接确定是否缺少整个 CUDA Toolkit。后续按当前代码与上游依赖契约判断，用户机器实际环境另列未验证项。

### 续 1：代码与上游要求

- `maw/local_asr.py:173–196` 自动设备仅按 `torch.cuda.is_available()` 选择 CUDA；`WhisperEngine._load:1820–1844` 的回退仅覆盖构造期 RuntimeError，显式 cuda 不回退。
- `maw/local_asr.py:1880,1894–1895` 转写调用及生成器迭代在上述 try 外；faster-whisper 上游 README 明确生成器迭代才开始转写，因此模型 loaded 不证明真实 GPU 推理依赖可用。
- `maw/runtimes/local_spec.py:18–23` verify 只导入 WhisperModel 与 Torch 等包，不做模型推理或 CUDA12 DLL 装载验证；`maw/runtimes/base.py:899–911` 未专门注册 CTranslate2 CUDA DLL 目录。
- `pyproject.toml:90–93` 本地依赖为 Torch cu130；当前 uv.lock 为 faster-whisper 1.2.1 / CTranslate2 4.8.1。CTranslate2 依赖元数据只要求 setuptools/numpy/pyyaml，不拉 CUDA12 cuBLAS/cuDNN。上游 [faster-whisper README](https://github.com/SYSTRAN/faster-whisper#gpu) 要求 cuBLAS CUDA12 + cuDNN9 CUDA12；Windows 库需位于可搜索目录。不是简单装最新 CUDA13 即可。
- 现有构造期回退与显式 cuda 保留错误测试 2 项通过：`.artifacts/checks/20261120T051104Z-8841d313/result.json`，不冒充用户机器实测。首次误用不存在的 WhisperEngineTests 类导致测试加载错误 `20261120T051046Z-674d9ffe`，改实际 LocalAsrFlowTests 方法后通过。
- 立即可用绕行：Launcher 本地模型设备明确选 CPU（不要仍选 auto）；GPU 修复需确认目标用户实际 CUDA12/cuDNN9 库、搜索路径与驱动。用户版本、是否 auto/显式 cuda 和硬件未提供，不把当前代码缺口等同于特定用户版本已确认 bug。
- CTranslate2 4.8.1 上游 `src/cuda/cublas_stub.cc` 的 Windows 路径明确使用 `LoadLibraryA(cublas64_<major>.dll)`，若 CUDA_PATH 存在还会调用 SetDllDirectoryA(CUDA_PATH/bin)，失败统一报「not found or cannot be loaded」。因此这条报错无法区分不存在、目录不对或依赖 DLL 无法加载；也不能据此判定显卡驱动不存在。不要手工将 CUDA13 DLL 改名为 CUDA12。
- 建议最低修改范围：auto 的恢复路径覆盖 `runtime.transcribe()` 与生成器迭代期的可识别 CUDA12/cuBLAS/cuDNN 错误，清理失败模型并用 CPU/int8 从头重试一次，避免保留半段输出；显式 CUDA 保留失败并给出所需版本/路径指引。环境就绪不应只以 Python import 或 Torch GPU 检测等同于 Whisper GPU 可用。是否进一步分发 CUDA12 运行库属于额外安装/体积/许可决策，本次不默认实施。

## 给维护者的分诊建议

1. 先让用户在 Launcher 设备下拉中明确选 CPU，拿短样本确认转写可运行；不用重下模型或盲目重新安装全部运行环境。
2. 补充用户 MAW 版本、运行环境版本、此前设备选的是 auto 还是 CUDA、显卡和驱动。只取得 GPU/驱动信息不足以确认 CUDA12 DLL 是否可装载；nvidia-smi 的 CUDA Version 表示驱动支持上限，不证明已安装对应 CUDA Toolkit。
3. 如确实需要 GPU，按实际 CTranslate2 版本匹配 CUDA12 cuBLAS + cuDNN9 CUDA12，并确认 DLL 及其依赖在进程搜索路径；不建议从不可信 DLL 网站下载单个文件，不将 13 版文件改名伪装为 12 版。
4. MAW 最低限度修复为推理期 auto 回退及缺库提示；显式 CUDA 保持报错而不是静默回退。完整随包分发额外 GPU 运行库另行评估，不是唯一解法。

## 未验证边界

没有目标用户机器访问、MAW/运行环境版本或真实 CUDA12 库清单，没有重跑其真实音频/模型；当前结论区分日志本身能证明的 DLL 装载失败与当前 main 的代码缺口。mock 复现只证明异常处理边界，不冒充 GPU 实测。

### 续 2：独立调查抽查与持久化复现

- 只读调查代理报告与主会话的 `resolve_device`、`WhisperEngine` 异常边界、RuntimeSpec import 验证和 CUDA13/12 依赖核对一致；抽查 `maw/local_asr.py:173–196,1818–1846,1880,1894–1895`、`tests/test_local_asr.py:893–928` 与 `maw/runtimes/local_spec.py:18–23`。
- 调查代理用内存 AST/mock 探针验证 5 场景，但未通过 run_check 且无 result.json（代理误将只读限制理解为不能创建本地验证日志）；该输出仅作辅助，不作为唯一持久化验证。
- 主会话以实际导入当前 `WhisperEngine` 的 mock 探针重新验证同五场景，已按规定落盘：`.artifacts/checks/20261120T051542Z-5d4de96f/result.json`，exit 0；脚本 `.artifacts/whisper-cuda-20261120/probe_fallback.py`。auto 构造缺库 CUDA→CPU；auto/cuda 的调用或生成器迭代缺库均已 loaded 后原错外抛，仅构造一次 CUDA，无 CPU 重试。
- 该缺口不只在 generator：未提示语言时上游语言检测可能在 `transcribe()` 调用期间触发 CUDA，也需同一恢复边界覆盖。中途迭代失败还必须丢弃已累积结果后重新转写，避免重复/残缺输出。
- 所有条目终态为仅说明；待实施建议与用户机器未验证边界已写明。无业务实现、依赖/环境修改、commit/push；只新增本主题调查账本与索引。

## 实施交接（2026-11-20）

维护者明确要求将两项必要改进交给独立 Orca 会话：推理阶段缺 CUDA 库时的 auto 单次 CPU 回退，以及显式 CUDA 的可操作报错。此文档从主工作树移至 `Moyf/whisper-cuda-fallback`，起点 `main@89db5921`；技能触发规则已另在 main 提交推送，不属于本分支实施范围。

只实施必要两项及对应回归，不引入 CUDA Toolkit 下载管理、不整体切换 Torch、不更新软件版本或发布；用户未授权该分支 commit/push/PR。沿用本文件记录实施决定与验证证据，避免另铺调查报告。先验证加载后调用、首段/中途生成器错误、CPU 重试失败、显式 CUDA和非缺库错误等边界。完成后给维护者结果与未验证范围。

## 续 3：独立实施（2026-11-20，本工作树）

状态：两项必要改进已实现并通过回归；未提交、未 push。

**改动文件**：`maw/local_asr.py`（WhisperEngine 及缺库分类）、`tests/test_local_asr.py`（回归）、`docs/user/LOCAL_ASR.md`（回退边界与解法）、`CHANGELOG.md`（未发布区一条 🐛 修复）。无前端改动，未生成 blank-editor.html，未构建 bundle。

**实现决定**：

- 新增 `_is_missing_cuda_runtime_error` 分类：只匹配 CTranslate2 的「Library X is not found or cannot be loaded」（X 含 cublas/cudnn/cuda）与「cuBLAS/cuDNN is not loaded」两类上游原文；构造期旧关键词（任意含 cuda/cublas/cudnn 即回退）收窄为同一分类，显存不足、模型损坏等不再触发回退。
- `WhisperEngine` 记录 `_runtime_device`（实际构造设备，非请求设备）与 `_model_source`；恢复决策以实际设备为准，Torch CUDA 可用不视为 CTranslate2 运行库可用。
- 推理期恢复：`transcribe()` 与生成器迭代包在同一尝试内（`_run_transcription` 承载全部累积状态）；缺库且实际在 CUDA 上时，`auto` 丢弃失败 GPU runtime 与半段结果，用 CPU/int8 从头重试一次（重试沿用相同语言/热词参数），事件流含回退提示与「速度可能变慢」；重试失败时合并保留 GPU 与 CPU 两个错误，结构上只重试一次。回退成功后 CPU runtime 进入实例缓存，重复调用不再构造。
- 显式 CUDA 构造期与推理期均不降级：保留原始错误，附「改选 CPU / 安装与 CTranslate2 匹配的 CUDA 12 cuBLAS 与 cuDNN 9 并确保 DLL 及传递依赖在进程搜索路径」指引；不断定缺整个 Toolkit，不建议改名单个 DLL 或重装环境。

**验证证据**（本工作树 `.artifacts/checks/`，复用主仓库 venv，`uv.lock` 与 main 一致）：

- 旧逻辑真实红：13 项回归中 9 项失败（4 项守卫用例通过）——`20261120T093546Z-740d12f9/result.json`。
- 修复后同 13 项全绿：`20261120T093739Z-1e049f19`；全文件 `tests/test_local_asr.py` 88 项通过 `20261120T093744Z-f9517f40`；含 `test_cli_cache_contract.py`、`test_energy_valley.py` 共 104 项通过（11 项 skip 均为 energy_valley 缺 soundfile 的环境性跳过）`20261120T093932Z-9df3d071`。
- 覆盖矩阵：构造/调用/首段迭代/中途迭代缺库、显式 CUDA（构造+转写）、显式 CPU、非缺库（OOM/模型损坏/普通错误，转写+构造）、CPU 重试失败双错误保留、重复调用缓存状态、参数/语言/热词保持、中途失败无重复/残缺段、分类器正反例。
- 基线探针反转：`.artifacts/whisper-cuda-20261120/probe_fallback.py` 旧行为断言（loaded 后原错外抛、无 CPU 重试）现已失败，失败原因正是 auto 场景进入 CPU 恢复路径——`20261120T094047Z-20b7c026`（exit 1 为预期反转，非缺陷）。
- `ruff check maw/local_asr.py` 通过；`scripts/check_docs.py` 0 断链；`git diff --check` 干净；`scripts/check_personal_paths.py --diff-ref main` 无命中。

**未验证边界**：无真实 GPU/CUDA12 DLL 环境与真实音频/模型实测（禁止项）；mock 只证明异常处理边界。CTranslate2 报错文案以用户日志与上游源码结构为证据，Linux 文案（libcublas.so.12 等）按同构格式匹配但未实测。Launcher/CLI 界面仅透传日志文本，未做 UI 验证。

### 续 3 补：独立自审与修复（2026-11-20）

按仓库提交前自审要求，由未参与实现的审查者通读全部 diff（[REVIEW_FINDINGS.md](REVIEW_FINDINGS.md)）：无 blocker / major；minor M1（CPU 重试失败合并错误只覆盖四个异常族，极端异常会丢原 GPU 错误）与 nit N1（构造回退缺 cpu loading 事件）、N2（缺构造回退后转写失败的端到端测试）、N4（CL 未提 OOM 不再静默回退的行为变化）已修复：三处 except 放宽为 `Exception` 并沿用 `# noqa: BLE001` 惯例、构造回退补 `_loading_event("cpu")`、新增 `test_whisper_after_constructor_fallback_transcribe_error_stays_raw`、CL 未发布区补一条 🔄 变更。N3（分类器第二模式无法离线验证）与 N5（彻底失败后逐调用重试周期）作为接受风险记录。修复后复验 105 项通过（`.artifacts/checks/20261120T095506Z-b6cc851c/`），ruff / diff --check / 个人路径 / 文档检查再次通过。

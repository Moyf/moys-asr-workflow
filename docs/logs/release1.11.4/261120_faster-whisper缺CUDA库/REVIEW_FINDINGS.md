# 提交前自审：faster-whisper 缺 CUDA 库回退（2026-11-20）

独立审查者（未参与实现）通读本分支全部 diff；实现者只回答提问。审查对象为 `Moyf/whisper-cuda-fallback`（基线 `main@89db5921`）的未提交改动：`maw/local_asr.py`、`tests/test_local_asr.py`、`docs/user/LOCAL_ASR.md`、`CHANGELOG.md`、账本与日志索引。审查者实跑了全量相关测试、`ruff check`、`git diff --check`、`check_personal_paths.py --diff-ref main`、`check_docs.py`，并抽查红绿证据链（`.artifacts/checks/20261120T093546Z-740d12f9/` 红证 traceback 指向旧 `maw/local_asr.py:1880` 的 `runtime.transcribe` 调用行，证明红证确跑在旧实现上）、以临时探针在旧源码复现中途迭代场景、对 `git show HEAD` 与新文件逐行比对转写主体代码（173 行逐字搬移，仅外层包装变化）。

## 结论

无 blocker、无 major。以下 minor / nit 逐条处置。

## Findings 与处置

| 级别 | 问题 | 处置 |
| --- | --- | --- |
| minor M1 | CPU 重试失败的双错误合并只覆盖 ImportError/TypeError/ValueError/RuntimeError；CPU 构造或转写抛其他异常族（如 OSError）会裸抛并丢失原 GPU 缺库错误，与「CPU 再失败保留两个错误」需求有偏差。现实暴露面小（ctranslate2 错误映射为 RuntimeError），且与旧代码一致非回归。 | **已修复**：`_load` 构造回退与 `_recover` 两处 except 放宽为 `Exception`（BaseException 不受影响，无控制流风险），任何 CPU 侧失败都合并保留 GPU 与 CPU 两个错误；与 `maw/asr/local.py` CLI 边界的既有 `# noqa: BLE001` 用法一致。复验 105 项通过。 |
| nit N1 | 构造期回退不发 `(cpu, compute_type=int8)` 的 loading 事件，与推理期回退不对称；用户原始问题正是靠这几行日志诊断的。 | **已修复**：构造回退分支在 CPU 构造前同样发 `_loading_event("cpu")`，两路径事件序列对称。 |
| nit N2 | 缺「auto 构造期缺库 → CPU 构造成功 → 转写再失败」端到端测试；代码读证正确（`_construct_runtime` 是 `_runtime_device` 唯一设置点，构造回退记 `"cpu"`，`transcribe` 门禁只认 `"cuda"`，该路径必然裸抛不二次恢复）。 | **已补测**：`test_whisper_after_constructor_fallback_transcribe_error_stays_raw` 验证转写错误裸抛且构造序列保持 `[cuda, cpu]`（无第二次 CPU 重试）。 |
| nit N3 | 分类器第二模式「cuBLAS/cuDNN is not loaded」无法在本环境比对上游源码原文（ctranslate2 未装、禁网）。主模式已由用户真实日志原文证实；第二模式为防御性补充，即使文案有出入只是少一层兜底。 | **接受风险**：账本「未验证边界」已记录；测试矩阵含该模式的正反例。 |
| nit N4 | CHANGELOG 未提及「auto 构造期非缺库 CUDA 错误（如 OOM）不再静默回退 CPU」这一用户可见行为变化；旧代码任意含 cuda/cublas/cudnn 子串即回退（红证中 OOM 用例在旧代码确实静默回退）。 | **已修复**：按仓库「行为与默认值变化进【🔄 变更】」规则在未发布区补一条一句话条目；不回改已发布版本。 |
| nit N5（备忘） | 回退彻底失败后的再次调用会重跑完整 CUDA→CPU 周期（每次调用恰好一次重试，无跨调用死循环）；与旧 `_load` 逐次重试语义一致。CLI/GUI 每次运行新建 engine，实际影响仅限同进程复用。 | **接受**：保持逐次尝试语义（进程内环境可能变化），结构上无重试放大；记录在案。 |

## 审查者验证摘录（独立复跑）

- `run_tests.py tests/test_local_asr.py` → `Ran 88 tests ... OK`；含 cache contract / energy valley 共 `Ran 104 tests ... OK (skipped=11)`（11 项均为 energy_valley 缺 soundfile 的环境性跳过）。
- `ruff check maw/local_asr.py tests/test_local_asr.py` → `All checks passed!`；`git diff --check` exit 0；`check_personal_paths.py --diff-ref main` exit 0；`check_docs.py` → `0 new broken links; 0 structure errors`。
- 红绿证据链：红证 `20261120T093546Z-740d12f9`（`FAILED (failures=2, errors=7)`，traceback 指旧实现 `runtime.transcribe` 调用行）；绿证 `20261120T093739Z-1e049f19`（同 13 项 OK）。
- 调用图核对：`_run_transcription`/`_recover` 无回边到 `transcribe`；`_run_transcription` 调用图内无 `raise LocalAsrError`，`transcribe` 的 except 不会误吞非目标异常；非目标 RuntimeError 裸 `raise` 保留原栈（测试断言 `assertNotIsInstance(..., LocalAsrError)`）。

审查后修复复验：`run_tests.py tests/test_local_asr.py tests/test_cli_cache_contract.py tests/test_energy_valley.py` → `Ran 105 tests ... OK (skipped=11)`（`.artifacts/checks/20261120T095506Z-b6cc851c/`）；`ruff check`、`git diff --check`、个人路径、文档检查再次通过（`20261120T095514Z-404259ba`）。

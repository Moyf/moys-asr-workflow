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

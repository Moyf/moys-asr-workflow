# 测试隔离独立审查

基线：`main`，`961e5949`；审查范围为 `tests/test_launcher_batch.py` 和 `tests/test_moss_runtime.py` 的未提交 diff。审查者只读核对，未运行测试。

## Finding 1：默认路径测试依赖 Windows 非 ASCII 路径回退

- 级别：中；审查时发现。
- 证据：`maw/runtimes/base.py` 的默认路径经 `pathwin.ensure_ascii_root`，Windows 非 ASCII 临时路径在没有短路径别名时可能回退公共目录；原默认路径用例直接比较临时目录，新隔离回归又复用该用例。
- 处置：已修复；默认目录选择测试使用非 ASCII 合成路径并 mock 路径转换，同时断言调用参数；实际平台路径行为由 `tests/test_runtime_pathwin.py` 覆盖。独立审查者复核认为原 finding 已解决，无新增明显问题。

## 其余结论

- 临时 Launcher 配置与进程环境恢复的审查未发现其他问题；本机真实配置未读取。
- 负对照与测试结果以反馈账本及 `.artifacts/checks/` 为准，不以静态审查代替执行。

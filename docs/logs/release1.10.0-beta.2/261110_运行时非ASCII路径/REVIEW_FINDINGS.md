# 本地运行时非 ASCII 路径修复 · 提交前独立自审

- 日期：2026-11-10
- 分支：fix/local-runtime-nonascii-path（基于 origin/main）
- 审查者：独立 subagent（未参与实现），通读全部 diff
- 背景：1.11.0 用户反馈（Windows 11，中文用户名「卓什么越」）安装 local-runtime 在 verify 阶段失败——nagisa/DyNet 用窄字符 `std::ifstream` 打开 wheel 自带模型文件，含中文用户名的路径按 ANSI 代码页解释失败。修复：运行时根目录 ASCII 化（8.3 短路径别名 → 公共目录 fallback）+ verify 错误增强。

## 结论

无 blocker。2 major、1 minor、5 nit；major 与 minor 已修复并复验，nit 逐条记录处置。

## Major

### M1 新增测试在真实 Windows 上会失败（Windows CI 必红）——已修复

- 证据：`.github/workflows/pr-release-windows.yml` 在 Windows runner 跑全量 Python 套件；审查者以 `sys.platform="win32"` 模拟复现 3 个失败 + 1 个高概率失败（chmod 在 Windows 不阻止目录内建文件）。
- 修复：`NonWindowsPassthroughTests` 类级 `skipIf(win32)`；`test_permission_error_becomes_actionable_failure` 方法级 skip；`tests/test_runtimes.py::test_resolve_root_is_passthrough_on_unix` 加 skip。同时补 `skipUnless(win32)` 的真实 `GetShortPathNameW` 冒烟（原实现零真实覆盖，nit 2 一并处理）。
- 复验：macOS 全绿；Windows 侧靠平台守卫 + 真实冒烟，无法本机执行，遗留人工/CI 验证项（见文末）。

### M2 `MAW_RUNTIME_ASCII_ROOT` 覆盖多 Runtime 时目录冲突——已修复

- 证据：override 原语义「直接作为运行时根目录、不拼 `dir_name`」，是全局单变量；LOCAL/OCR/MOSS 默认目录分支都会消费（`base.py resolve_root`）。8.3 被禁用的机器设一次值，三个 runtime 解析到同一根：site-packages 互相覆盖、`runtime.json` 互写、`package_dirs_ok` 交叉污染。
- 修复：override 与 PROGRAMDATA 分支同构——都是「公共运行时根」，各 Runtime 占 `<dir_name>` 子目录（`pathwin.fallback_root`）；docstring、`tests/test_runtime_pathwin.py` 决策表与 `FallbackRootTests`、`docs/user/LOCAL_ASR.md`、CHANGELOG 文案同步。

## Minor

### m1 verify 提示对「显式配置」场景无效——已修复

- 证据：显式配置（`MAW_*_RUNTIME_ROOT` / GUI 路径）走 `resolve_root` override 分支（`allow_relocate=False`），从不读 `fallback_root`，设 `MAW_RUNTIME_ASCII_ROOT` 不生效；而提示最常出现的恰是显式配置 + 8.3 禁用场景。
- 修复：文案主出路改为「把运行时目录改为纯英文路径（Launcher「设置运行环境路径」或对应 MAW_*_RUNTIME_ROOT 变量）」，`MAW_RUNTIME_ASCII_ROOT` 注明只对默认路径场景有效。

## Nit（处置记录）

1. 测试 helper 用 `mock.patch.stopall()` 与仓库既有教训相悖（会误停装饰器 patch）——已改为 with 句柄/显式 start-stop。
2. 真实 `GetShortPathNameW` 零真实覆盖——已补 `skipUnless(win32)` 冒烟（真实 temp 目录转换后 resolve 同一目录）。
3. 「显式配置 + 别名成功」组合无用例钉住——已补 `test_explicit_config_accepts_alias_but_not_relocation`。
4. ready 早退前仍会探测/建公共目录（对已就绪 runtime 点安装白建空目录）——已把 `prepare_install_root` 移到 ready 早退与「目录不完整」中止之后。
5. 类型标注引用私有名 `mock._patch` —— 改为非私有标注；无类型检查门禁，接受。

## 审查确认无问题的关键面

resolve_root 异常安全（status 轮询不抛）、cancelled 不被吞（except 顺序 + 专项用例）、PureWindowsPath 在 POSIX 上的解析行为收敛到 fallback、安装/运行链一致（--target / verify 解释器 / PYTHONPATH 同源）、显式配置不迁移、模型缓存留默认根（DyNet 只撞 wheel 内数据文件）、MAW.spec 双处登记有契约测试守门、UTF-8/LF、无 AI 署名。

## 未验证边界

- 真实 Windows 上的 8.3 短路径转换与 PROGRAMDATA fallback 只有单元级模拟 + `skipUnless` 冒烟，未经真实中文用户名机器端到端验证（需维护者实机或 CI 确认）。
- 多用户共享 ProgramData 的第二用户「修复/重装」权限路径只有单元级探测测试。

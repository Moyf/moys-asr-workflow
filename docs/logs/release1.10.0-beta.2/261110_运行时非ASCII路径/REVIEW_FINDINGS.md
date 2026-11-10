# 本地运行时非 ASCII 路径修复 · 提交前独立自审

- 日期：2026-11-10
- 分支：fix/local-runtime-nonascii-path（基于 origin/main）
- 审查者：独立 subagent（未参与实现），通读全部 diff
- 背景：1.11.0 用户反馈（Windows 11，中文用户名「測試用戶」）安装 local-runtime 在 verify 阶段失败——nagisa/DyNet 用窄字符 `std::ifstream` 打开 wheel 自带模型文件，含中文用户名的路径按 ANSI 代码页解释失败。修复：运行时根目录 ASCII 化（8.3 短路径别名 → 公共目录 fallback）+ verify 错误增强。

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

---

## 第二轮：Greptile 对 PR #356 的评审（5 条 findings）——全部成立，已修复

- 日期：2026-11-10（同日追加 commit，同分支推送）
- 审查者：Greptile（对已推送的 `f2bd4be4`）

### G1（P1+security）公共 fallback 目录可被其他用户替换运行文件——已修复

- 证据：ProgramData 多用户可写；共享同一 `<dir_name>` 子树时，先创建的用户可替换 python.exe / 依赖、伪造 runtime.json，第二个用户以自己身份执行——本地提权向量。
- 修复：`fallback_root` 两个分支同构加「用户隔离子目录」——公共根 → `<user-hash>`（`pathwin.user_hash`：用户名 SHA-256 前 16 个 hex，不用明文、保持纯 ASCII）→ `<dir_name>`。`MAW_RUNTIME_ASCII_ROOT` 覆盖路径同样加该层。语义变化：同机多用户不再共享运行时，每个 Windows 用户独立安装一份（文档与代码注释均已写明）。附带收益：每用户拥有自己的子树后，「第二用户修复/重装无写权限」问题一并消失。
- 残余风险（接受并记录）：`<user-hash>` 本身仍由先创建者拥有（默认 ACL 下先到者可在他人哈希子目录预置文件）；`probe_writable` 拦截只读陷阱，「目录已存在但不完整」检查拦截无解释器的预置垃圾；带完整 python.exe 的恶意预置需要攻击者刻意猜测哈希并抢先创建，超出本项目的本地威胁模型（个人单用户机器），不在本次修复范围。

### G2（P1）`MAW_RUNTIME_ASCII_ROOT` 相对路径指向错误位置——已修复

- 证据：override 原样 `Path(override).expanduser()` 未转绝对；install 时相对 cwd 写文件，run/verify 把子进程 cwd 切到 `bundle_root()`，相对路径指向别处。
- 修复：返回前 `Path(override).expanduser().resolve(strict=False)`（`tests/test_runtime_pathwin.py::test_relative_override_is_resolved_to_absolute` 钉住）。

### G3（P2）install 入口父目录权限错误缺指引——已修复

- 证据：`root.parent.mkdir()` 抛 `PermissionError` 时发生在 `probe_writable` 之前，用户看到裸 PermissionError。
- 修复：mkdir 纳入 try/except 转 `_error`，文案含位置、原因与 `MAW_RUNTIME_ASCII_ROOT` 自救指引（`tests/test_runtimes.py::test_install_parent_dir_permission_error_gets_self_rescue_hint` 钉住，platform-neutral——纯 ASCII 路径三平台同语义）。

### G4（P2）反馈者真实用户名公开——已修复

- 证据：测试路径常量、模块 docstring、CHANGELOG 条目含反馈者真实用户名（仓库规范要求脱敏）。
- 修复：全仓统一替换为虚构示例名「測試用戶」（`tests/test_runtime_pathwin.py`、`tests/test_runtimes.py`、`maw/runtimes/pathwin.py` docstring、CHANGELOG、本文件），`grep -r "卓什么越"` 零命中。

### G5（P2）CHANGELOG Windows 路径写成双反斜杠——一并修复

- 证据：`C:\\ProgramData\\...` 在渲染后显示双反斜杠（`od` 确认文件字节）。
- 修复：改单反斜杠，同步更新为按用户隔离的新层级 `C:\ProgramData\MAW\runtimes\<用户哈希>\<runtime>`；`docs/user/LOCAL_ASR.md` 同步。

### 第二轮验证

- `tests/test_runtime_pathwin.py` + `tests/test_runtimes.py`：72 项全绿（新增 user_hash 稳定性 / 非 ASCII 用户名 / 用户隔离子目录 / 相对路径绝对化 / 权限失败指引；既有 fallback 期望补用户哈希层；macOS `/var/folders` 符号链接用 `resolve()` 对齐期望）。
- ruff 全过；全量套件与提交前检查见最终提交记录。

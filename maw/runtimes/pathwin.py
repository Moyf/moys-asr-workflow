"""Windows 非 ASCII 运行时根目录的 ASCII 化：8.3 短路径别名 + 公共目录回退。

背景（1.11.0 用户反馈，Windows 11 中文用户名「卓什么越」）：qwen-asr → funasr
的 import 链会实例化 ``nagisa.Tagger``，其底层 DyNet 用 C++ ``std::ifstream``
窄字符 API 打开随 wheel 分发的模型文件；Windows 上窄字符路径按 ANSI 代码页
解释，用户名含中文时默认运行时根目录
``C:\\Users\\<中文名>\\AppData\\Local\\MAW\\local-runtime`` 下实际存在的
``nagisa/data/nagisa_v001.model`` 打不开，安装后的 verify 当场报
``RuntimeError: Could not read model``。这是 DyNet 的知名 Windows 缺陷，
MAW 用户以中文用户名为主，因此必须在 MAW 侧把交给子进程的运行时路径
ASCII 化，而不是改第三方包（nagisa/qwen-asr 均不可控）。

策略（:func:`ensure_ascii_root`，三平台决策表）：

1. 非 Windows 或路径纯 ASCII：原样直通（macOS / Linux 零副作用）。
2. Windows：把「已存在前缀」经 ``GetShortPathNameW`` 转成 8.3 短路径，
   保留 ASCII 尾段（``MAW\\<dir_name>`` 等组件本身不含非 ASCII）。短路径
   与原路径是**同一物理目录**的别名，对 pathlib / manifest / pip 完全等价，
   但整条交给子进程的链路（embedded ``._pth`` 的相对解析、PYTHONPATH、
   DyNet 的 ``ifstream``）全部变成 ASCII。注意 ``GetShortPathNameW`` 只对
   已存在的路径有定义：安装目录首次不存在时，向上取最近已存在祖先做整段
   转换，尾段原样拼回。
3. 短路径不可用（8.3 名称生成被 ``NtfsDisable8dot3NameCreation`` 注册表
   关闭或卷不支持，``GetShortPathNameW`` 对已存在路径原样返回输入）：
   - ``allow_relocate=False``（用户显式配置了运行时路径）：尊重用户选择，
     原样返回；verify 失败时的错误增强（:func:`ascii_path_failure_hint`）
     给出改用英文路径的自救指引。
   - 默认目录（``allow_relocate=True``）：迁移到无中文的公共目录
     :func:`fallback_root`，顺序为：
     a. ``MAW_RUNTIME_ASCII_ROOT`` 环境变量（新增配置，指定公共运行时根；
        各 Runtime 在其下各占 ``<dir_name>`` 子目录，供 8.3 被禁用的机器
        指定任意可写位置）；
     b. ``%PROGRAMDATA%\\MAW\\runtimes\\<dir_name>``。ProgramData 默认 ACL
        允许 Authenticated Users 创建子目录；首个安装的用户拥有其后代目录，
        其他用户可能只读——因此 install 阶段动工前会经
        :func:`prepare_install_root` → :func:`probe_writable` 探测可写性，
        失败立即给可操作错误，而不是下载数 GB 依赖后才失败。多用户共享
        同一 fallback 目录时：读操作（推理）没问题；第二个用户「修复/重装」
        无写权限时会得到明确指引而不是半途失败。

consistency 说明：转换放在 ``ManagedRuntime.resolve_root``（状态查询 /
安装 / worker 启动的唯一根目录汇点），保证 status、manifest、pip ``--target``、
PYTHONPATH 与 verify/worker 的解释器路径始终指向同一形态；GUI 里展示的
运行时路径是同一物理目录的短路径别名（如 ``C:\\Users\\7A6C~1\\...``），
属预期表现。
"""

from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path, PureWindowsPath
from typing import Final

#: 新增配置：8.3 短路径不可用时，显式指定无 ASCII 问题的「公共运行时根」。
#: 各 Runtime 在其下各占 ``<dir_name>`` 子目录（与 PROGRAMDATA 分支同构），
#: 避免三个运行时共用同一 site-packages / runtime.json 互相覆盖。
FALLBACK_ROOT_ENV: Final = "MAW_RUNTIME_ASCII_ROOT"

#: 公共目录 fallback 的固定层级：``%PROGRAMDATA%\\MAW\\runtimes\\<dir_name>``。
COMMON_RUNTIMES_SUBPATH: Final = ("MAW", "runtimes")

#: 反馈入口（verify 错误增强文案里引用）。
ISSUE_FEEDBACK_URL: Final = "https://github.com/Moyf/moys-asr-workflow/issues"


class AsciiRootUnavailable(Exception):
    """ASCII 化失败且公共目录 fallback 也不可用（权限缺失 / 无 PROGRAMDATA）。"""


def contains_non_ascii(text: str) -> bool:
    """路径里是否含有非 ASCII 字符（中文用户名等）。"""
    return any(ord(char) > 0x7F for char in text)


def win32_get_short_path(path: str) -> str:
    """``GetShortPathNameW`` 封装（测试 mock 此函数模拟 Windows 行为三分支）。

    成功返回短路径；路径存在但没有 8.3 短名（8.3 被禁用）时原样返回输入；
    API 失败（路径不存在 / 权限等）抛 :class:`OSError`。非 Windows 直接
    原样返回，绝不触碰 ``ctypes.windll``。
    """
    if sys.platform != "win32":
        return path
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    length = kernel32.GetShortPathNameW(path, None, 0)
    if length == 0:
        raise OSError(ctypes.get_last_error() or 3, f"GetShortPathNameW 失败：{path}")
    buffer = ctypes.create_unicode_buffer(length)
    if kernel32.GetShortPathNameW(path, buffer, length) == 0:
        raise OSError(ctypes.get_last_error() or 3, f"GetShortPathNameW 失败：{path}")
    return buffer.value


def _path_exists(path: PureWindowsPath) -> bool:
    """已存在判定（独立 seam，便于在非 Windows 平台单测 Windows 行为）。"""
    return os.path.exists(str(path))


def ascii_alias(path: Path | str) -> Path | PureWindowsPath:
    """返回同一物理目录的 ASCII 别名；转换不可能时原样返回。

    自完整路径向上找最近已存在的前缀做 ``GetShortPathNameW`` 整段转换，
    尾段（尚未创建的 ``MAW\\<dir_name>`` 等 ASCII 组件）原样拼回——混用
    短/长组件是合法的 Windows 路径。任一已存在前缀没有 8.3 短名即视为
    整卷不支持（8.3 被禁用），继续向上只会拉长无短名的尾段，直接放弃；
    尾段自身含非 ASCII 时别名同样救不了。
    """
    if sys.platform != "win32":
        return path
    pure = PureWindowsPath(path)
    if not contains_non_ascii(str(pure)):
        return path
    parts = pure.parts
    for count in range(len(parts), 1, -1):
        prefix = PureWindowsPath(*parts[:count])
        if not _path_exists(prefix):
            continue  # 前缀尚不存在：GetShortPathNameW 对不存在的路径没有定义
        try:
            converted = win32_get_short_path(str(prefix))
        except OSError:
            continue  # API 失败：尝试更高层级的已存在前缀
        if converted == str(prefix):
            break  # 前缀存在但没有 8.3 短名（8.3 被注册表禁用 / 卷不支持）
        candidate = PureWindowsPath(converted).joinpath(*parts[count:])
        if contains_non_ascii(str(candidate)):
            break  # 尾段自身含非 ASCII：别名救不了
        return candidate
    return path


def fallback_root(dir_name: str) -> Path:
    """无 ASCII 问题的公共运行时根目录（顺序见模块 docstring 策略 3）。

    两个分支同构：override 与 PROGRAMDATA 都是「公共运行时根」，各 Runtime
    在其下各占 ``<dir_name>`` 子目录——全局单变量若被三个 Runtime 直接当
    根目录消费，site-packages 与 runtime.json 会互相覆盖。
    """
    override = os.environ.get(FALLBACK_ROOT_ENV, "").strip()
    if override:
        return Path(override).expanduser() / dir_name
    program_data = os.environ.get("PROGRAMDATA", "").strip()
    if not program_data:
        raise AsciiRootUnavailable(
            "未找到 PROGRAMDATA 环境变量，无法确定公共运行时目录。"
            f"可设置环境变量 {FALLBACK_ROOT_ENV} 指定一个无中文且当前用户可写的目录。"
        )
    return Path(program_data).joinpath(*COMMON_RUNTIMES_SUBPATH) / dir_name


def probe_writable(root: Path, *, label: str = "公共运行时目录") -> None:
    """fallback 目录动工前的可写性探测（含权限检查）。

    ProgramData 下首个安装的用户拥有后代目录，其他用户可能只读；这里用
    建目录 + 建删探针文件的方式提前暴露权限问题，避免装到一半才失败。
    """
    probe = root / ".maw-write-probe"
    try:
        root.mkdir(parents=True, exist_ok=True)
        probe.write_bytes(b"")
        probe.unlink()
    except OSError as error:
        raise AsciiRootUnavailable(
            f"{label}不可写：{root}（{error}）。"
            f"可设置环境变量 {FALLBACK_ROOT_ENV} 指向一个无中文且当前用户可写的"
            "目录后重试；或以有权限的用户先完成一次安装。"
        ) from error


def ensure_ascii_root(path: Path, *, dir_name: str, allow_relocate: bool = True) -> Path:
    """返回 ``path`` 的 ASCII 安全形态（三平台决策表见模块 docstring）。

    ``allow_relocate=False``（用户显式配置的路径）只做 8.3 别名转换，
    不迁移公共目录；fallback 目录本身不可确定（无 PROGRAMDATA）时同样
    原样返回，把失败推迟到 install/verify 的可操作错误。
    """
    if sys.platform != "win32" or not contains_non_ascii(str(path)):
        return path
    alias = ascii_alias(path)
    if not contains_non_ascii(str(alias)):
        return Path(str(alias))
    if not allow_relocate:
        return path
    try:
        return fallback_root(dir_name)
    except AsciiRootUnavailable:
        return path


def prepare_install_root(root: Path, *, dir_name: str) -> Path:
    """install 动工前的最后一步：公共目录 fallback 形态先探测可写性。

    ``resolve_root`` 的结果可能是：原样（ASCII / 非 Windows / 显式配置且
    无法别名化）、8.3 短路径别名（与原路径同一物理目录，无需探测）、公共
    目录 fallback（真正迁移，需要权限检查）。判定方式即与
    ``fallback_root(dir_name)`` 的确定性结果比对。
    """
    if sys.platform != "win32":
        return root
    try:
        candidate = fallback_root(dir_name)
    except AsciiRootUnavailable:
        return root
    if Path(root) != candidate:
        return root
    probe_writable(candidate)
    return root


def ascii_path_failure_hint(path: Path) -> str:
    """verify 失败且路径链仍含非 ASCII 时的定位提示（无问题时空串）。

    只有在 Windows 上、且交给 verify 的运行时路径仍是非 ASCII（短路径与
    公共目录回退都未生效）时才追加提示，避免对无关失败凑热闹。

    出路按场景写全：显式配置路径（allow_relocate=False）不会消费
    ``MAW_RUNTIME_ASCII_ROOT``，主出路是改用英文路径；默认路径场景才可
    用该变量指定公共运行时根。
    """
    if sys.platform != "win32" or not contains_non_ascii(str(path)):
        return ""
    return (
        " 定位提示：运行时路径含非 ASCII 字符（如中文用户名），部分依赖"
        "（DyNet/nagisa 等）在 Windows 上无法用系统默认代码页打开该路径下的"
        "数据文件；短路径转换与公共目录回退均未生效。请把运行时目录改为纯"
        "英文路径后重试（在 Launcher「设置运行环境路径」或对应"
        f" MAW_*_RUNTIME_ROOT 变量中修改；使用默认路径的场景也可设置环境变量 "
        f"{FALLBACK_ROOT_ENV} 指定公共运行时根）；若问题仍未解决，"
        f"欢迎到 {ISSUE_FEEDBACK_URL} 反馈。"
    )

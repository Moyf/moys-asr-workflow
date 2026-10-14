#!/usr/bin/env python3
r"""扫描 Git 变更中的个人绝对路径，防止把本机用户名推进公开仓库。

检查模式：Windows 用户目录绝对路径（C:\Users\<名>、C:/Users/<名>）。
测试夹具与文档中常见的假用户名（test / demo / runner / USER 等）默认放行，
真实用户名一律拦截；输出中的用户名自动打码，避免检查结果本身泄露。

用法：
  python scripts/check_personal_paths.py                  # 检查暂存区新增行（pre-commit 默认）
  python scripts/check_personal_paths.py --diff-ref main  # 检查当前分支相对 main 的新增行
  python scripts/check_personal_paths.py --all            # 扫描全部受 Git 跟踪的文件
  python scripts/check_personal_paths.py --allow 某名字    # 额外放行的用户名，可重复

命中即退出码 1，并在提交前给出脱敏提示。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys

# C:\Users\<名> / C:/Users/<名>，名字以至少一个「词字符」结尾。
PATH_PATTERN = re.compile(r"(?i)\bc:[/\\]+users[/\\]+([\w.\- ]*\w)")

# 测试夹具、文档示例与占位符里常见、确认无泄露风险的名字。
FAKE_NAMES = {
    "user",
    "username",
    "yourname",
    "your-name",
    "your_name",
    "test",
    "testuser",
    "test-user",
    "demo",
    "runner",
    "runner~1",
    "administrator",
    "public",
    "default",
    "owner",
    "dev",
    "名",
    "用户名",
    "用户目录",
}


def run_git(*args: str, ok_codes: tuple[int, ...] = (0,)) -> str:
    proc = subprocess.run(["git", *args], capture_output=True)
    if proc.returncode not in ok_codes:
        message = proc.stderr.decode("utf-8", "replace").strip()
        raise SystemExit(f"git {' '.join(args)} 失败（退出码 {proc.returncode}）：{message}")
    return proc.stdout.decode("utf-8", "replace")


def mask_name(name: str) -> str:
    if len(name) <= 2:
        return "*" * len(name)
    return name[0] + "*" * (len(name) - 2) + name[-1]


def find_violations(
    rows: list[tuple[str, int, str]], allowed: set[str]
) -> list[str]:
    findings: list[str] = []
    for file, lineno, text in rows:
        for match in PATH_PATTERN.finditer(text):
            name = match.group(1)
            if name.lower() in allowed:
                continue
            findings.append(
                f"{file}:{lineno}: C:\\Users\\{mask_name(name)}\\…（疑似个人路径）"
            )
    return findings


def added_lines_from_diff(diff: str) -> list[tuple[str, int, str]]:
    rows: list[tuple[str, int, str]] = []
    current_file = ""
    new_lineno = 0
    for raw in diff.splitlines():
        if raw.startswith("+++ b/"):
            current_file = raw[len("+++ b/") :]
        elif raw.startswith("@@"):
            hunk = re.search(r"\+(\d+)", raw)
            new_lineno = int(hunk.group(1)) if hunk else 0
        elif raw.startswith("+") and not raw.startswith("+++"):
            rows.append((current_file, new_lineno, raw[1:]))
            new_lineno += 1
    return rows


def tracked_file_lines() -> list[tuple[str, int, str]]:
    raw = run_git("grep", "-nIi", "-E", r"c:[/\\]+users[/\\]+", ok_codes=(0, 1))
    rows: list[tuple[str, int, str]] = []
    for line in raw.splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3:
            continue
        try:
            rows.append((parts[0], int(parts[1]), parts[2]))
        except ValueError:
            continue
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(
        description="扫描 Git 变更中的个人绝对路径（pre-commit / CI 复用）",
    )
    parser.add_argument(
        "--all", action="store_true", help="扫描全部受 Git 跟踪的文件"
    )
    parser.add_argument(
        "--diff-ref",
        metavar="REF",
        help="扫描当前分支相对 REF 的新增行（如 --diff-ref main）",
    )
    parser.add_argument(
        "--allow",
        action="append",
        default=[],
        metavar="NAME",
        help="额外放行的用户名，可重复传入",
    )
    args = parser.parse_args()

    allowed = {name.lower() for name in FAKE_NAMES}
    allowed.update(name.lower() for name in args.allow)

    if args.all:
        rows = tracked_file_lines()
    elif args.diff_ref:
        diff = run_git("diff", "--unified=0", f"{args.diff_ref}...HEAD")
        rows = added_lines_from_diff(diff)
    else:
        diff = run_git("diff", "--cached", "--unified=0")
        rows = added_lines_from_diff(diff)

    findings = find_violations(rows, allowed)
    if not findings:
        return 0

    print(f"发现 {len(findings)} 处疑似个人绝对路径：", file=sys.stderr)
    for item in findings:
        print(f"  {item}", file=sys.stderr)
    print(
        "请先把路径脱敏（如 …\\npm-cache\\…、<用户目录>\\AppData\\…），"
        "或改用「另一干净 HEAD 工作树」等泛称；",
        file=sys.stderr,
    )
    print(
        "确属测试假路径时用 --allow 名字 放行，或扩充脚本内的 FAKE_NAMES。",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

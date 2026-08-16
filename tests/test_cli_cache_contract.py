# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownArgumentType=false, reportUnusedCallResult=false
"""CLI 媒体缓存生成位置的静态契约。

回归背景（v1.4.0 后）：三个 API provider CLI 曾把 ``embed_media_caches``
挪到 ``TemporaryDirectory`` 清理之后调用，传入的是已删除的临时音频路径，
导致 ``.mosp`` 内置波形、spectral 频谱与 ``.ReaPeaks`` 文件全部静默丢失。
本测试用 AST 锁定「缓存生成必须发生在临时目录存活期内」的结构约束，
单测无法覆盖真实转写流程，只能在源码层面防回归。
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

API_PROVIDER_CLIS = (
    "generate_subtitle_qwen_api.py",
    "generate_subtitle_bcut_api.py",
    "generate_subtitle_soniox_api.py",
)


def _calls_named(node: ast.AST, name: str) -> set[tuple[int, int]]:
    """Module/子树内对 ``name`` 的直接函数调用位置集合。"""
    return {
        (sub.lineno, sub.col_offset)
        for sub in ast.walk(node)
        if isinstance(sub, ast.Call)
        and isinstance(sub.func, ast.Name)
        and sub.func.id == name
    }


def _tempdir_with_nodes(tree: ast.AST) -> list[ast.With]:
    """所有 ``with tempfile.TemporaryDirectory() ...`` 语句节点。"""
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.With, ast.AsyncWith))
        and any(
            isinstance(item.context_expr, ast.Call)
            and isinstance(item.context_expr.func, ast.Attribute)
            and item.context_expr.func.attr == "TemporaryDirectory"
            for item in node.items
        )
    ]


class CliCacheContractTests(unittest.TestCase):
    def test_api_clis_generate_caches_inside_temporary_directory(self) -> None:
        for name in API_PROVIDER_CLIS:
            with self.subTest(cli=name):
                tree = ast.parse(
                    (REPO_ROOT / name).read_text(encoding="utf-8"), filename=name
                )
                calls = _calls_named(tree, "embed_media_caches")
                self.assertTrue(calls, f"{name} 必须调用 embed_media_caches")
                inside: set[tuple[int, int]] = set()
                for with_node in _tempdir_with_nodes(tree):
                    inside |= _calls_named(with_node, "embed_media_caches")
                outside = calls - inside
                self.assertFalse(
                    outside,
                    f"{name} 的 embed_media_caches 调用位于 TemporaryDirectory "
                    f"块外（临时媒体已删除）: {sorted(outside)}",
                )

    def test_local_cli_writes_outputs_inside_prepared_audio(self) -> None:
        name = "generate_subtitle_local.py"
        tree = ast.parse((REPO_ROOT / name).read_text(encoding="utf-8"), filename=name)
        with_nodes = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.With)
            and any(
                isinstance(item.context_expr, ast.Call)
                and isinstance(item.context_expr.func, ast.Name)
                and item.context_expr.func.id == "prepared_audio"
                for item in node.items
            )
        ]
        self.assertTrue(with_nodes, f"{name} 应使用 prepared_audio 上下文")
        found = any(
            _calls_named(with_node, "write_local_outputs")
            for with_node in with_nodes
        )
        self.assertTrue(
            found,
            "write_local_outputs 必须在 prepared_audio 上下文内调用，"
            "否则缓存媒体在生成前就被临时目录清理",
        )


if __name__ == "__main__":
    unittest.main()

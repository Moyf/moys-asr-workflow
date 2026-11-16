"""Runtime 安装「换源重试」的决策表与回路测试（全部 mock，不真联网）。

覆盖点：
- 镜像测速排序候选（ranked_mirrors）：排序、剔除失败源、全失败兜底、pick 兼容。
- install 重试循环：首源网络失败换下家、全源用尽列明细+指引、确定性错误不重试、
  extra index 归因不换主源、轮数上限、重试轮间取消传播。
"""

from __future__ import annotations

import contextlib
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest import mock

from maw.runtime_mirror_picker import FALLBACK_SOURCE, pick_fastest_mirror, ranked_mirrors
from maw.runtimes import LOCAL
from maw.runtimes.base import (
    MIRROR_RETRY_ATTEMPTS,
    _failure_blames_extra_index,
    _looks_like_network_failure,
    _mirror_retry_exhausted_message,
    _network_failure_summary,
)
from maw.runtimes.local_spec import LocalRuntimeCancelled, LocalRuntimeError

MIRROR_A = "https://mirrors-a.example.com/simple"
MIRROR_B = "https://mirrors-b.example.com/simple"
MIRROR_C = "https://mirrors-c.example.com/simple"
PYTORCH_HOST = "download.pytorch.org"

_LOCAL_PACKAGE_DIRS = (
    "certifi",
    "faster_whisper",
    "funasr",
    "qwen_asr",
    "jieba",
    "torch",
    "torchaudio",
    "quapeaks",
    "sherpa_onnx",
    "soundfile",
)


def _fake_extract(_zip_path: Path, target_dir: Path) -> None:
    """假解压：制造 Windows embedded 布局的 python 占位（内嵌流测试固定 win32）。"""
    python = target_dir / "python.exe"
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_bytes(b"python")


def _index_of(install_command: list[str]) -> str:
    return install_command[install_command.index("--index-url") + 1]


def _mirror_403_error(index_url: str) -> LocalRuntimeError:
    """模仿 pip 对镜像限频/拒绝的真实输出形态（stdout/stderr 合流后的尾部）。"""
    return LocalRuntimeError(
        "本地运行环境命令失败（退出码 1）。"
        "ERROR: Could not install packages due to an OSError: "
        f"HTTP Error 403: Forbidden for url {index_url}/antlr4-python3-runtime/"
    )


def _deterministic_error() -> LocalRuntimeError:
    return LocalRuntimeError(
        "本地运行环境命令失败（退出码 1）。"
        "ERROR: No matching distribution found for antlr4-python3-runtime==4.9.3"
    )


class MirrorRankingTests(unittest.TestCase):
    def _with_measure(self, results: list[dict]) -> list[str]:
        with mock.patch("maw.runtime_mirror_picker.measure_sources", return_value=results):
            return ranked_mirrors()

    def test_ranked_mirrors_orders_by_latency_and_drops_failed_sources(self) -> None:
        results = [
            {"url": MIRROR_B, "ok": True, "latency_ms": 300.0, "bytes_per_sec": 1000.0, "error": None},
            {"url": MIRROR_A, "ok": True, "latency_ms": 100.0, "bytes_per_sec": 1000.0, "error": None},
            {"url": MIRROR_C, "ok": True, "latency_ms": 200.0, "bytes_per_sec": 1000.0, "error": None},
            {"url": "https://dead.example.com/simple", "ok": False, "latency_ms": None, "bytes_per_sec": None, "error": "HTTP 503"},
        ]
        self.assertEqual(self._with_measure(results), [MIRROR_A, MIRROR_C, MIRROR_B])

    def test_ranked_mirrors_falls_back_to_official_when_all_fail(self) -> None:
        results = [
            {"url": MIRROR_A, "ok": False, "latency_ms": None, "bytes_per_sec": None, "error": "timeout"},
            {"url": MIRROR_B, "ok": False, "latency_ms": None, "bytes_per_sec": None, "error": "HTTP 503"},
        ]
        self.assertEqual(self._with_measure(results), [FALLBACK_SOURCE])

    def test_pick_fastest_mirror_matches_ranked_first(self) -> None:
        results = [
            {"url": MIRROR_B, "ok": True, "latency_ms": 300.0, "bytes_per_sec": 1000.0, "error": None},
            {"url": MIRROR_A, "ok": True, "latency_ms": 100.0, "bytes_per_sec": 1000.0, "error": None},
        ]
        with mock.patch("maw.runtime_mirror_picker.measure_sources", return_value=results):
            self.assertEqual(pick_fastest_mirror(), MIRROR_A)
            self.assertEqual(ranked_mirrors(), [MIRROR_A, MIRROR_B])

    def test_retry_failure_summary_and_classifier(self) -> None:
        hit = _network_failure_summary(_mirror_403_error(MIRROR_A))
        self.assertIn("403", hit)
        self.assertTrue(_looks_like_network_failure(_mirror_403_error(MIRROR_A)))
        self.assertTrue(_looks_like_network_failure(LocalRuntimeError("ReadTimeoutError: Read timed out.")))
        self.assertTrue(_looks_like_network_failure(LocalRuntimeError("urllib3.exceptions.NewConnectionError: ...")))
        self.assertTrue(_looks_like_network_failure(LocalRuntimeError("HTTP Error 502: Bad Gateway")))
        # uv 措辞（源码模式走 _uv_install_command）：HTTP 与状态码之间隔着
        # 「status client error」，超时/断连/取回失败是 uv 自己的说法。
        self.assertTrue(_looks_like_network_failure(LocalRuntimeError(
            "uv installer 命令失败（退出码 2）。error: Failed to fetch "
            "https://mirrors-a.example.com/simple/funasr/: "
            "HTTP status client error (403 Forbidden) for url"
        )))
        self.assertTrue(_looks_like_network_failure(LocalRuntimeError(
            "uv installer 命令失败（退出码 2）。error: HTTP status 429"
        )))
        self.assertTrue(_looks_like_network_failure(LocalRuntimeError(
            "uv installer 命令失败（退出码 2）。error: operation timed out"
        )))
        self.assertTrue(_looks_like_network_failure(LocalRuntimeError(
            "uv installer 命令失败（退出码 2）。error: connection refused (os error 61)"
        )))
        # 确定性错误（含伴随 HTTP 404 的「无候选版本」）不按网络失败处理。
        self.assertFalse(_looks_like_network_failure(_deterministic_error()))
        # uv 的 404 形态同样不命中换源（与 pip 一致，404 有意排除）。
        self.assertFalse(_looks_like_network_failure(LocalRuntimeError(
            "uv installer 命令失败（退出码 2）。Caused by: "
            "HTTP status client error (404 Not Found) for url"
        )))

    def test_extra_index_attribution_and_exhausted_message(self) -> None:
        extra = f"https://{PYTORCH_HOST}/whl/cu130"
        extra_failure = LocalRuntimeError(
            f"本地运行环境命令失败（退出码 1）。HTTP Error 403 for url https://{PYTORCH_HOST}/whl/cu130/torch/"
        )
        self.assertTrue(_failure_blames_extra_index(extra_failure, extra))
        self.assertFalse(_failure_blames_extra_index(_mirror_403_error(MIRROR_A), extra))
        self.assertFalse(_failure_blames_extra_index(_mirror_403_error(MIRROR_A), None))
        message = _mirror_retry_exhausted_message([
            (MIRROR_A, "HTTP Error 403: Forbidden"),
            (MIRROR_B, "ReadTimeoutError"),
        ])
        self.assertIn(MIRROR_A, message)
        self.assertIn(MIRROR_B, message)
        self.assertIn("MAW_PIP_INDEX", message)

    def test_extra_index_attribution_requires_matching_url_prefix(self) -> None:
        # MAW_PIP_INDEX 与 MAW_PYTORCH_INDEX 指到同一镜像主机时，主源失败的
        # URL 路径不同，不得被裸主机名匹配误判成 extra 失败而跳过换源。
        extra = "https://mirror.example.com/whl/cu130"
        extra_failure = LocalRuntimeError(
            "uv installer 命令失败（退出码 2）。error: Failed to fetch "
            "https://mirror.example.com/whl/cu130/torch/: "
            "HTTP status client error (403 Forbidden)"
        )
        primary_failure = LocalRuntimeError(
            "uv installer 命令失败（退出码 2）。error: Failed to fetch "
            "https://mirror.example.com/simple/antlr4-python3-runtime/: "
            "HTTP status client error (403 Forbidden)"
        )
        self.assertTrue(_failure_blames_extra_index(extra_failure, extra))
        self.assertFalse(_failure_blames_extra_index(primary_failure, extra))
        # 容许错误文本里的 URL 带尾随包路径与尾斜杠差异。
        self.assertTrue(_failure_blames_extra_index(
            _mirror_403_error("https://download.pytorch.org/whl/cu130"),
            "https://download.pytorch.org/whl/cu130/",
        ))


@mock.patch("maw.runtimes.base.ranked_mirrors", new=mock.MagicMock(return_value=[MIRROR_A, MIRROR_B, MIRROR_C]))
@mock.patch("maw.runtimes.base.probe_index_reachable", new=mock.MagicMock(return_value=True))
@mock.patch("maw.runtimes.pathwin.winsecurity.current_user_sid", new=mock.MagicMock(return_value="S-1-5-21-1-2-3-1001"))
@mock.patch("maw.runtimes.base.sys.frozen", True, create=True)
@mock.patch("maw.runtimes.base.sys.platform", "win32")
class RuntimeMirrorRetryTests(unittest.TestCase):
    """LOCAL runtime 安装的重试回路（OCR/MOSS 共用同一条 install 管线）。"""

    def _setup(self, temp_dir: str) -> tuple[Path, Path]:
        root = Path(temp_dir) / "local-runtime"
        requirements_txt = Path(temp_dir) / "requirements-local.txt"
        requirements_txt.write_text("funasr==1.4.2\nqwen-asr==0.0.6\njieba==0.42.1\n", encoding="utf-8")
        return root, requirements_txt

    def _install(
        self,
        root: Path,
        requirements_txt: Path,
        *,
        fake_run,
        mirrors: list[str] | None = None,
        cancel_event: Event | None = None,
        on_event=None,
    ):
        patches = [
            mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=[Path("embed.zip"), Path("get-pip.py")]),
            mock.patch("maw.runtimes.base._extract_embed_python", side_effect=_fake_extract),
            mock.patch.object(LOCAL, "requirements_path", return_value=requirements_txt),
            mock.patch("maw.runtimes.base._has_cuda", return_value=True),
            mock.patch("maw.runtimes.base._run_process", side_effect=fake_run),
        ]
        if mirrors is not None:
            patches.append(mock.patch("maw.runtimes.base.ranked_mirrors", return_value=list(mirrors)))
        with contextlib.ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            return LOCAL.install(runtime_root=root, cancel_event=cancel_event, on_event=on_event)

    @staticmethod
    def _fake_success(calls: list[list[str]], install_calls: list[list[str]], root: Path):
        def fake_run(command: list[str], **_kwargs: object) -> int:
            calls.append(command)
            if "install" in command:
                install_calls.append(command)
                site = root / "site-packages"
                for name in _LOCAL_PACKAGE_DIRS:
                    (site / name).mkdir(parents=True, exist_ok=True)
            return 0

        return fake_run

    def test_first_mirror_403_retries_next_and_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            install_calls: list[list[str]] = []
            events: list[tuple[str, int, str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if "install" in command:
                    install_calls.append(command)
                    if len(install_calls) == 1:
                        raise _mirror_403_error(MIRROR_A)
                    site = root / "site-packages"
                    for name in _LOCAL_PACKAGE_DIRS:
                        (site / name).mkdir(parents=True, exist_ok=True)
                return 0

            status = self._install(
                root,
                requirements_txt,
                fake_run=fake_run,
                on_event=lambda text, percent, phase: events.append((text, percent, phase)),
            )

            self.assertTrue(status.ready)
            self.assertEqual(len(install_calls), 2)
            self.assertEqual(_index_of(install_calls[0]), MIRROR_A)
            self.assertEqual(_index_of(install_calls[1]), MIRROR_B)
            retry_messages = [text for text, _percent, _phase in events if "切换到" in text]
            self.assertTrue(any("第 2/3 次尝试" in text for text in retry_messages), events)
            self.assertTrue(any("mirrors-b.example.com" in text for text in retry_messages), events)

    def test_all_mirrors_exhausted_lists_sources_and_hint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            install_calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if "install" in command:
                    install_calls.append(command)
                    raise _mirror_403_error(_index_of(command))
                return 0

            with self.assertRaises(LocalRuntimeError) as context:
                self._install(root, requirements_txt, fake_run=fake_run)

            message = str(context.exception)
            self.assertEqual(len(install_calls), 3)
            for mirror in (MIRROR_A, MIRROR_B, MIRROR_C):
                self.assertIn(mirror, message)
            self.assertIn("403", message)
            self.assertIn("MAW_PIP_INDEX", message)

    def test_deterministic_failure_does_not_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            install_calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if "install" in command:
                    install_calls.append(command)
                    raise _deterministic_error()
                return 0

            with self.assertRaises(LocalRuntimeError) as context:
                self._install(root, requirements_txt, fake_run=fake_run)

            self.assertEqual(len(install_calls), 1)
            message = str(context.exception)
            self.assertIn("No matching distribution", message)
            self.assertNotIn("已尝试", message)
            self.assertNotIn("MAW_PIP_INDEX", message)

    def test_cancel_propagates_between_retry_rounds(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            install_calls: list[list[str]] = []
            cancel = Event()

            def fake_run(command: list[str], **kwargs: object) -> int:
                if "install" in command:
                    install_calls.append(command)
                    kwargs["cancel"].set()
                    raise _mirror_403_error(MIRROR_A)
                return 0

            with self.assertRaises(LocalRuntimeCancelled):
                self._install(root, requirements_txt, fake_run=fake_run, cancel_event=cancel)

            self.assertEqual(len(install_calls), 1)

    def test_retry_round_cap_at_three_attempts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            install_calls: list[list[str]] = []
            five_mirrors = [
                MIRROR_A,
                MIRROR_B,
                MIRROR_C,
                "https://mirrors-d.example.com/simple",
                "https://mirrors-e.example.com/simple",
            ]

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if "install" in command:
                    install_calls.append(command)
                    raise _mirror_403_error(_index_of(command))
                return 0

            with self.assertRaises(LocalRuntimeError) as context:
                self._install(root, requirements_txt, fake_run=fake_run, mirrors=five_mirrors)

            self.assertEqual(len(install_calls), MIRROR_RETRY_ATTEMPTS)
            self.assertNotIn("mirrors-d.example.com", str(context.exception))
            self.assertNotIn("mirrors-e.example.com", str(context.exception))

    def test_extra_index_failure_does_not_switch_primary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            install_calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if "install" in command:
                    install_calls.append(command)
                    raise LocalRuntimeError(
                        "本地运行环境命令失败（退出码 1）。"
                        f"ERROR: Could not install packages due to an OSError: "
                        f"HTTP Error 403: Forbidden for url https://{PYTORCH_HOST}/whl/cu130/torch/"
                    )
                return 0

            with self.assertRaises(LocalRuntimeError) as context:
                self._install(root, requirements_txt, fake_run=fake_run)

            self.assertEqual(len(install_calls), 1)
            message = str(context.exception)
            self.assertIn(PYTORCH_HOST, message)
            self.assertNotIn("已尝试", message)

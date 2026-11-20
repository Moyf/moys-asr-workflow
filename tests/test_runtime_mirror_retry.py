"""Runtime 安装「换源重试」的决策表与回路测试（全部 mock，不真联网）。

覆盖点：
- 镜像测速排序候选（ranked_mirrors）：排序、剔除失败源、全失败兜底、pick 兼容。
- install 重试循环：网络轮换、缺候选/哈希不匹配切官方、未知错误直接上报、
  extra index 归因、显式源隔离、日志脱敏、轮数上限、取消传播。
"""

from __future__ import annotations

import contextlib
import io
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from unittest import mock

from maw.runtime_mirror_picker import FALLBACK_SOURCE, pick_fastest_mirror, ranked_mirrors
from maw.runtimes import LOCAL
from maw.runtimes.base import (
    MIRROR_RETRY_ATTEMPTS,
    _dependency_content_failure,
    _failure_blames_extra_index,
    _looks_like_network_failure,
    _mirror_retry_exhausted_message,
    _network_failure_summary,
    _run_process,
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


def _run_with_failed_output(command: list[str], output: str, **kwargs: object) -> int:
    process = mock.Mock(stdout=io.StringIO(output))
    process.wait.return_value = 1
    with mock.patch("maw.runtimes.base.popen_process_tree", return_value=process):
        with mock.patch("maw.runtimes.base.release_process_tree"):
            return _run_process(command, **kwargs)


def _pip_missing_tail(index: str, *, lookup: str = "timeout") -> str:
    # pip 26.2.1 -vv，采样自 loopback；最后一轮 warning 中只有相对路径。
    project = "other-package" if lookup == "other-package" else "funasr"
    warning = (
        "WARNING: Retrying (Retry(total=0, connect=None, read=None, redirect=None, status=None)) "
        "after connection broken by 'ReadTimeoutError(\"Read timed out. (read timeout=0.2)\")': "
        f"/simple/{project}/\n"
    )
    page = f"{index}/{project}/"
    if lookup == "recovered":
        result = f"Fetched page {page} as text/html\n"
    elif lookup == "warning-only":
        result = ""
    elif lookup in {"403", "429", "404"}:
        reason = {"403": "Forbidden", "429": "Too Many Requests", "404": "Not Found"}[lookup]
        result = f"Could not fetch URL {page}: {lookup} Client Error: {reason} for url: {page} - skipping\n"
    else:
        result = f"Could not fetch URL {page}: index didn't respond within 0.2 seconds - skipping\n"
    return (
        warning + result + f"Skipping link: not a file: {page}\n"
        "ERROR: Could not find a version that satisfies the requirement funasr==1.4.2 (from versions: none)\n"
        "ERROR: No matching distribution found for funasr==1.4.2\n"
    )


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
        with mock.patch.dict("os.environ", {"MAW_PIP_INDEX": ""}):
            self.assertEqual(self._with_measure(results), [FALLBACK_SOURCE])
        with mock.patch.dict("os.environ", {"MAW_PIP_INDEX": f"{MIRROR_A},{MIRROR_B}"}):
            self.assertEqual(self._with_measure(results), [MIRROR_A])

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

    def test_pip_and_uv_content_failure_diagnostics(self) -> None:
        for output in (
            "ERROR: Could not find a version that satisfies the requirement funasr==1.4.2 (from versions: none)",
            "ERROR: No matching distribution found for funasr==1.4.2",
            "╰─▶ Because there is no version of funasr==1.4.2 and you require funasr==1.4.2,",
            "╰─▶ Because funasr was not found in the package registry and you require funasr==1.4.2,",
        ):
            with self.subTest(output=output):
                self.assertIn("候选包", _dependency_content_failure(output))
        for output in (
            "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE.",
            "╰─▶ Hash mismatch for `funasr==1.4.2`",
        ):
            self.assertIn("哈希不匹配", _dependency_content_failure(output))
        for output in (
            "No solution found when resolving dependencies: incompatible requirements",
            "ERROR: Hashes are required in --require-hashes mode, but they are missing from some requirements.",
            "ERROR: 404 Client Error: Not Found",
        ):
            self.assertIsNone(_dependency_content_failure(output))

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
        self.assertFalse(_failure_blames_extra_index(f"Looking in indexes: {MIRROR_A}, {extra}", extra))
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
@mock.patch.dict("os.environ", {"MAW_PIP_INDEX": "", "MAW_PYTORCH_INDEX": ""})
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
        cpu_requirements: Path | None = None,
    ):
        patches = [
            mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=[Path("embed.zip"), Path("get-pip.py")]),
            mock.patch("maw.runtimes.base._extract_embed_python", side_effect=_fake_extract),
            mock.patch.object(LOCAL, "requirements_path", side_effect=lambda *, cpu=False: (
                cpu_requirements if cpu else requirements_txt
            )),
            mock.patch("maw.runtimes.base._has_cuda", return_value=cpu_requirements is None),
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

    def test_unrecognized_resolver_failure_does_not_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            install_calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if "install" in command:
                    install_calls.append(command)
                    raise LocalRuntimeError("error: ResolutionImpossible: conflicting dependencies")
                return 0

            with self.assertRaises(LocalRuntimeError) as context:
                self._install(root, requirements_txt, fake_run=fake_run)

            self.assertEqual(len(install_calls), 1)
            message = str(context.exception)
            self.assertIn("ResolutionImpossible", message)
            self.assertNotIn("已尝试", message)
            self.assertNotIn("MAW_PIP_INDEX", message)

    def test_missing_candidate_goes_directly_to_official_outside_top_three(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            install_calls: list[list[str]] = []
            events: list[str] = []
            succeed = self._fake_success([], install_calls, root)

            def fake_run(command: list[str], **kwargs: object) -> int:
                if "install" in command and _index_of(command) == MIRROR_A:
                    install_calls.append(command)
                    raise _deterministic_error()
                return succeed(command, **kwargs)

            result = self._install(
                root, requirements_txt, fake_run=fake_run,
                mirrors=[MIRROR_A, MIRROR_B, MIRROR_C, FALLBACK_SOURCE],
                on_event=lambda text, _percent, _phase: events.append(text),
            )

            self.assertTrue(result.ready)
            self.assertEqual([_index_of(command) for command in install_calls], [MIRROR_A, FALLBACK_SOURCE])
            for command in install_calls:
                self.assertEqual(command[command.index("-r") + 1], str(requirements_txt))
            diagnostics = [line for line in events if "mtime=" in line]
            self.assertEqual(len(diagnostics), 2)
            mtime = datetime.fromtimestamp(requirements_txt.stat().st_mtime, tz=timezone.utc).isoformat()
            for line, source in zip(diagnostics, [MIRROR_A, FALLBACK_SOURCE], strict=True):
                self.assertIn(str(requirements_txt), line)
                self.assertIn(source, line)
                self.assertIn(mtime, line)

    def test_official_network_failure_resumes_original_shortlist(self) -> None:
        ranked_official = FALLBACK_SOURCE + "/"
        cases = (
            ([MIRROR_A, MIRROR_B, ranked_official, MIRROR_C], [MIRROR_A, ranked_official, MIRROR_B], True),
            ([MIRROR_A, MIRROR_B, MIRROR_C, FALLBACK_SOURCE], [MIRROR_A, FALLBACK_SOURCE, MIRROR_B, MIRROR_C], True),
            ([MIRROR_A, MIRROR_B, MIRROR_C, "https://fourth.example/simple"],
             [MIRROR_A, FALLBACK_SOURCE, MIRROR_B, MIRROR_C], False),
        )
        for mirrors, expected, recovers in cases:
            with self.subTest(mirrors=mirrors), tempfile.TemporaryDirectory() as temp_dir:
                root, requirements_txt = self._setup(temp_dir)
                tried: list[str] = []
                succeed = self._fake_success([], [], root)

                def fake_run(command: list[str], **kwargs: object) -> int:
                    if "install" in command:
                        source = _index_of(command)
                        tried.append(source)
                        self.assertEqual(command[command.index("-r") + 1], str(requirements_txt))
                        if source == MIRROR_A or (source == MIRROR_B and expected[-1] == MIRROR_C):
                            raise _deterministic_error()
                        if not recovers or source != expected[-1]:
                            raise _mirror_403_error(source)
                    return succeed(command, **kwargs)

                if recovers:
                    result = self._install(root, requirements_txt, fake_run=fake_run, mirrors=mirrors)
                    self.assertTrue(result.ready)
                else:
                    with self.assertRaisesRegex(LocalRuntimeError, "所有候选镜像源均不可用"):
                        self._install(root, requirements_txt, fake_run=fake_run, mirrors=mirrors)

                self.assertEqual(tried, expected)

    def test_pip_official_lookup_timeout_resumes_original_shortlist(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            tried: list[list[str]] = []
            succeed = self._fake_success([], [], root)

            def fake_run(command: list[str], **kwargs: object) -> int:
                if "install" in command:
                    tried.append(command)
                    source = _index_of(command)
                    if source == MIRROR_A:
                        return _run_with_failed_output(command, _deterministic_error().args[0], **kwargs)
                    if source == FALLBACK_SOURCE:
                        # Real pip 26.2.1 ordering: main times out, extra provides
                        # another version, then pip reports the combined candidates.
                        output = _pip_missing_tail(source).replace(
                            "ERROR: Could not find a version",
                            f"Fetched page https://{PYTORCH_HOST}/whl/cu130/funasr/ as text/html\n"
                            "ERROR: Could not find a version",
                        ).replace("from versions: none", "from versions: 1.0")
                        return _run_with_failed_output(command, output, **kwargs)
                return succeed(command, **kwargs)

            status = self._install(root, requirements_txt, fake_run=fake_run, mirrors=[MIRROR_A, MIRROR_B])

            self.assertTrue(status.ready)
            self.assertEqual([_index_of(command) for command in tried], [MIRROR_A, FALLBACK_SOURCE, MIRROR_B])
            for command in tried:
                self.assertEqual(command[command.index("-r") + 1], str(requirements_txt))
                self.assertIn("-vv", command)

    def test_pip_main_index_403_and_429_resume_original_shortlist(self) -> None:
        for http_status in ("403", "429"):
            with self.subTest(status=http_status), tempfile.TemporaryDirectory() as temp_dir:
                root, requirements_txt = self._setup(temp_dir)
                tried: list[list[str]] = []
                succeed = self._fake_success([], tried, root)

                def fake_run(command: list[str], **kwargs: object) -> int:
                    if "install" in command and _index_of(command) == FALLBACK_SOURCE:
                        tried.append(command)
                        return _run_with_failed_output(
                            command, _pip_missing_tail(FALLBACK_SOURCE, lookup=http_status), **kwargs,
                        )
                    return succeed(command, **kwargs)

                status = self._install(root, requirements_txt, fake_run=fake_run, mirrors=[FALLBACK_SOURCE, MIRROR_B])

                self.assertTrue(status.ready)
                self.assertEqual([_index_of(command) for command in tried], [FALLBACK_SOURCE, MIRROR_B])

    def test_pip_only_reclassifies_network_exhaustion_for_missing_main_project(self) -> None:
        extra = f"https://{PYTORCH_HOST}/whl/cu130"
        failed_page = f"{FALLBACK_SOURCE}/funasr/"
        cases = (
            _pip_missing_tail(FALLBACK_SOURCE, lookup="recovered"),
            _pip_missing_tail(FALLBACK_SOURCE, lookup="warning-only"),
            _pip_missing_tail(FALLBACK_SOURCE, lookup="other-package"),
            _pip_missing_tail(FALLBACK_SOURCE, lookup="404"),
            _pip_missing_tail(extra),
            f"Fetched page {failed_page} as text/html\n" + _pip_missing_tail(FALLBACK_SOURCE),
            _pip_missing_tail(extra, lookup="403"),
            _pip_missing_tail(extra, lookup="429"),
        )
        for output in cases:
            with self.subTest(output=output), tempfile.TemporaryDirectory() as temp_dir:
                root, requirements_txt = self._setup(temp_dir)
                tried: list[str] = []

                def fake_run(command: list[str], **kwargs: object) -> int:
                    if "install" in command:
                        source = _index_of(command)
                        tried.append(source)
                        if source == FALLBACK_SOURCE:
                            return _run_with_failed_output(command, output, **kwargs)
                        self.fail(f"unexpected network retry to {source}")
                    return 0

                with self.assertRaisesRegex(LocalRuntimeError, "当前源未提供.*官方 PyPI 已尝试"):
                    self._install(root, requirements_txt, fake_run=fake_run, mirrors=[FALLBACK_SOURCE, MIRROR_B])

                self.assertEqual(tried, [FALLBACK_SOURCE])

    def test_official_non_network_or_cancellation_does_not_resume_shortlist(self) -> None:
        for official_failure, expected in (
            (_deterministic_error(), LocalRuntimeError),
            (LocalRuntimeError("error: ResolutionImpossible: conflicting dependencies"), LocalRuntimeError),
            (_mirror_403_error(f"https://{PYTORCH_HOST}/whl/cu130"), LocalRuntimeError),
            (LocalRuntimeCancelled("cancelled"), LocalRuntimeCancelled),
        ):
            with self.subTest(official_failure=official_failure), tempfile.TemporaryDirectory() as temp_dir:
                root, requirements_txt = self._setup(temp_dir)
                tried: list[str] = []

                def fake_run(command: list[str], **_kwargs: object) -> int:
                    if "install" in command:
                        source = _index_of(command)
                        tried.append(source)
                        if source == MIRROR_A:
                            raise _deterministic_error()
                        if source == FALLBACK_SOURCE:
                            raise official_failure
                    return 0

                with self.assertRaises(expected):
                    self._install(root, requirements_txt, fake_run=fake_run, mirrors=[MIRROR_A, MIRROR_B])

                self.assertEqual(tried, [MIRROR_A, FALLBACK_SOURCE])

    def test_real_runner_keeps_hash_failure_outside_tail_and_reuses_cpu_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            cpu_requirements = requirements_txt.with_name("requirements-local-cpu.txt")
            cpu_requirements.write_text("funasr==1.4.2 --hash=sha256:deadbeef\n", encoding="utf-8")
            install_calls: list[list[str]] = []
            events: list[str] = []
            succeed = self._fake_success([], install_calls, root)

            def fake_run(command: list[str], **kwargs: object) -> int:
                if "install" in command and _index_of(command) == MIRROR_A:
                    install_calls.append(command)
                    output = (
                        "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE.\n"
                        + "    Expected sha256 abc\n    Got def\n" * 5
                        + f"    funasr==1.4.2 from {MIRROR_A}/funasr.whl:\n    Expected sha256 abc\n    Got def\n"
                    )
                    try:
                        return _run_with_failed_output(command, output, **kwargs)
                    except LocalRuntimeError as error:
                        self.assertNotIn("DO NOT MATCH", str(error))
                        raise
                return succeed(command, **kwargs)

            result = self._install(
                root, requirements_txt, fake_run=fake_run, cpu_requirements=cpu_requirements,
                on_event=lambda text, _percent, _phase: events.append(text),
            )

            self.assertTrue(result.ready)
            self.assertEqual([_index_of(command) for command in install_calls], [MIRROR_A, FALLBACK_SOURCE])
            for command in install_calls:
                self.assertEqual(command[command.index("-r") + 1], str(cpu_requirements))
                self.assertNotIn("--extra-index-url", command)
            diagnostics = [line for line in events if "mtime=" in line]
            self.assertEqual(len(diagnostics), 2)
            self.assertTrue(all(str(cpu_requirements) in line for line in diagnostics))

    def test_explicit_index_never_retries_unconfigured_official_and_redacts_credentials(self) -> None:
        private = "https://demo-user:demo-pass@mirror.example/simple?access_token=demo-query"
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.dict("os.environ", {"MAW_PIP_INDEX": private}):
            root, requirements_txt = self._setup(temp_dir)
            tried: list[str] = []
            events: list[str] = []

            def fake_run(command: list[str], **kwargs: object) -> int:
                if "install" in command:
                    tried.append(_index_of(command))
                    kwargs["on_line"](f"Looking in indexes: {private}")
                    raise LocalRuntimeError(f"ERROR: No matching distribution found for funasr==1.4.2 at {private}")
                return 0

            with self.assertRaises(LocalRuntimeError) as caught:
                self._install(
                    root, requirements_txt, fake_run=fake_run, mirrors=[private],
                    on_event=lambda text, _percent, _phase: events.append(text),
                )

            self.assertEqual(tried, [private])
            self.assertIn(f"MAW_PIP_INDEX={FALLBACK_SOURCE}", str(caught.exception))
            output = "\n".join([str(caught.exception), *events])
            self.assertIn("https://mirror.example/simple", output)
            for secret in ("demo-user", "demo-pass", "demo-query"):
                self.assertNotIn(secret, output)

    def test_explicitly_configured_official_can_be_tried_even_if_probe_failed(self) -> None:
        official = FALLBACK_SOURCE + "/"
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.dict(
            "os.environ", {"MAW_PIP_INDEX": f"{MIRROR_A},{official}"},
        ):
            root, requirements_txt = self._setup(temp_dir)
            tried: list[str] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if "install" in command:
                    tried.append(_index_of(command))
                    raise LocalRuntimeError("╰─▶ Hash mismatch for `funasr==1.4.2`")
                return 0

            with self.assertRaisesRegex(LocalRuntimeError, "哈希不匹配。官方 PyPI 已尝试"):
                self._install(root, requirements_txt, fake_run=fake_run, mirrors=[MIRROR_A])

            self.assertEqual(tried, [MIRROR_A, official])

    def test_official_is_not_tried_again_after_network_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            tried: list[str] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if "install" in command:
                    index = _index_of(command)
                    tried.append(index)
                    if index.startswith(FALLBACK_SOURCE):
                        raise _mirror_403_error(index)
                    if index == MIRROR_B:
                        raise LocalRuntimeError("ERROR: No matching distribution found for funasr==1.4.2")
                    raise _deterministic_error()
                return 0

            with self.assertRaisesRegex(LocalRuntimeError, "官方 PyPI 遇到网络错误") as caught:
                self._install(root, requirements_txt, fake_run=fake_run,
                              mirrors=[FALLBACK_SOURCE + "/", FALLBACK_SOURCE, MIRROR_A, MIRROR_B])

            self.assertIn("No matching distribution found for funasr==1.4.2", str(caught.exception))
            self.assertNotIn("所有候选镜像源均不可用", str(caught.exception))
            self.assertEqual(tried, [FALLBACK_SOURCE + "/", MIRROR_A, MIRROR_B])

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

    def test_extra_index_failure_does_not_switch_primary_even_when_candidates_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            install_calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if "install" in command:
                    install_calls.append(command)
                    raise LocalRuntimeError(
                        f"ERROR: HTTP Error 403 for url https://{PYTORCH_HOST}/whl/cu130/torch/\n"
                        f"{_deterministic_error()}"
                    )
                return 0

            with self.assertRaises(LocalRuntimeError) as context:
                self._install(root, requirements_txt, fake_run=fake_run)

            self.assertEqual(len(install_calls), 1)
            message = str(context.exception)
            self.assertIn("MAW_PYTORCH_INDEX", message)
            self.assertNotIn("已尝试", message)

    def test_recovered_extra_index_warning_does_not_mask_final_primary_403(self) -> None:
        warning = f"WARNING: Retrying after ConnectionError for https://{PYTORCH_HOST}/whl/cu130/torch/"
        for warning_in_tail in (False, True):
            with self.subTest(warning_in_tail=warning_in_tail), tempfile.TemporaryDirectory() as temp_dir:
                root, requirements_txt = self._setup(temp_dir)
                install_calls: list[list[str]] = []
                succeed = self._fake_success([], install_calls, root)

                def fake_run(command: list[str], **kwargs: object) -> int:
                    if "install" in command and _index_of(command) == MIRROR_A:
                        install_calls.append(command)
                        kwargs["on_line"](warning)
                        kwargs["on_line"]("Collecting torch==2.9.1")
                        error = _mirror_403_error(MIRROR_A)
                        if warning_in_tail:
                            raise LocalRuntimeError(f"{warning}\nCollecting torch==2.9.1\n{error}")
                        raise error
                    return succeed(command, **kwargs)

                status = self._install(root, requirements_txt, fake_run=fake_run)

                self.assertTrue(status.ready)
                self.assertEqual([_index_of(command) for command in install_calls], [MIRROR_A, MIRROR_B])

    def test_truncated_uv_error_chain_still_attributes_to_extra_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root, requirements_txt = self._setup(temp_dir)
            tried: list[str] = []

            def fake_run(command: list[str], **kwargs: object) -> int:
                if "install" in command:
                    tried.append(_index_of(command))
                    output = (
                        "  × Failed to download `torch==2.9.1`\n"
                        f"  ├─▶ Failed to fetch: https://{PYTORCH_HOST}/whl/cu130/torch.whl\n"
                        "  ╰─▶ Hash mismatch for `torch==2.9.1`\n"
                        + "      Expected sha256: abc\n      Computed sha256: def\n" * 5
                    )
                    return _run_with_failed_output(command, output, **kwargs)
                return 0

            with self.assertRaisesRegex(LocalRuntimeError, "MAW_PYTORCH_INDEX") as caught:
                self._install(root, requirements_txt, fake_run=fake_run)

            self.assertEqual(tried, [MIRROR_A])
            self.assertNotIn(PYTORCH_HOST, str(caught.exception))  # 归因 URL 已被 runner 截断。

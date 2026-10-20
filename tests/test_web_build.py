"""web_build 预检：新鲜度判定、自动重建与不可重建时的可操作报错。"""

from __future__ import annotations

import hashlib
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw import web_build


ROOT = Path(__file__).resolve().parents[1]


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _run_worker_catching(worker, errors: list) -> None:
    """线程 worker 的异常收集器：threading 不会向测试传播异常。"""
    try:
        worker()
    except BaseException as error:  # noqa: BLE001 - 测试需要把异常带回主线程
        errors.append(error)


class _FakeRepo:
    """合成一个最小仓库树：清单 + 源码 + 模块配置 + 构建器脚本。

    ``materialize()`` 模拟 esbuild 构建器的落盘行为：按当前源码写出
    bundle（内容任意）与逐字段正确的 .meta.json。
    """

    def __init__(self, root: Path, kind: str) -> None:
        self.root = root
        self.kind = kind
        spec = web_build._SPECS[kind]
        self.manifest = root / spec.manifest
        self.config = root / spec.config
        self.bundle = root / spec.bundle
        self.meta = root / spec.meta
        self.sources = [f"src/{name}.js" for name in ("a", "b")]
        for relative in self.sources:
            path = root / "web" / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"// {relative}\n", encoding="utf-8", newline="\n")
        self.manifest.parent.mkdir(parents=True, exist_ok=True)
        self.manifest.write_text("\n".join(self.sources) + "\n", encoding="utf-8", newline="\n")
        self.config.write_text('{\n  "modules": []\n}\n', encoding="utf-8", newline="\n")
        self.builders = [root / builder for builder in spec.builders]
        for builder in self.builders:
            builder.parent.mkdir(parents=True, exist_ok=True)
            builder.write_text(f"// builder {builder.name}\n", encoding="utf-8", newline="\n")
        (root / "node_modules" / "esbuild").mkdir(parents=True, exist_ok=True)
        (root / "package.json").write_text('{"devDependencies": {}}\n', encoding="utf-8", newline="\n")
        (root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8", newline="\n")

    def source_text(self, relative: str) -> str:
        return (self.root / "web" / relative).read_text(encoding="utf-8")

    def dependency_hash(self) -> str:
        """与构建器一致：package.json 与 pnpm-lock.yaml 以换行拼接后哈希。"""
        return _sha("\n".join(
            (self.root / name).read_text(encoding="utf-8")
            for name in ("package.json", "pnpm-lock.yaml")
        ))

    def materialize(self) -> None:
        inputs = {relative: _sha(self.source_text(relative)) for relative in self.sources}
        builder_hash = _sha("\n".join(
            builder.read_text(encoding="utf-8") for builder in self.builders
        ))
        metadata = {
            "format": 1,
            "sourceFiles": list(self.sources),
            "inputs": inputs,
            "configHash": _sha(self.config.read_text(encoding="utf-8")),
            "builderHash": builder_hash,
            "dependencyHash": self.dependency_hash(),
            "bundleHash": _sha("/* fake artifact */\n"),
        }
        self.bundle.parent.mkdir(parents=True, exist_ok=True)
        self.bundle.write_text("/* fake artifact */\n", encoding="utf-8", newline="\n")
        self.meta.write_text(json.dumps(metadata) + "\n", encoding="utf-8", newline="\n")


class BundleStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = _FakeRepo(self.root, "editor")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_missing_bundle(self) -> None:
        """Given 未构建的仓库, When 预检, Then 状态 missing。"""
        status, reason = web_build.bundle_status(self.root, "editor")

        self.assertEqual(status, "missing")
        self.assertIn("editor-bundle.js", reason)

    def test_fresh_after_build(self) -> None:
        """Given 构建产物与源码一致, When 预检, Then fresh 且不触发重建。"""
        self.repo.materialize()

        with mock.patch.object(web_build.subprocess, "run") as run:
            status, _ = web_build.bundle_status(self.root, "editor")
            self.assertEqual(web_build.ensure_bundle(self.root, "editor"), "fresh")

        self.assertEqual(status, "fresh")
        run.assert_not_called()

    def test_stale_when_source_changes(self) -> None:
        """Given 源文件被修改, When 预检, Then stale 且说明指向该文件。"""
        self.repo.materialize()
        (self.root / "web" / "src" / "a.js").write_text("// changed\n", encoding="utf-8")

        status, reason = web_build.bundle_status(self.root, "editor")

        self.assertEqual(status, "stale")
        self.assertIn("src/a.js", reason)

    def test_stale_when_manifest_gains_file(self) -> None:
        """Given 清单新增源文件, When 预检, Then stale（清单与构建时不一致）。"""
        self.repo.materialize()
        (self.root / "web" / "src" / "c.js").write_text("// new\n", encoding="utf-8")
        self.repo.manifest.write_text(
            "\n".join([*self.repo.sources, "src/c.js"]) + "\n", encoding="utf-8"
        )

        status, _ = web_build.bundle_status(self.root, "editor")

        self.assertEqual(status, "stale")

    def test_stale_when_meta_missing_or_corrupt(self) -> None:
        """Given meta 缺失或不是 JSON, When 预检, Then stale。"""
        self.repo.materialize()
        self.repo.meta.unlink()
        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")

        self.repo.meta.write_text("not json\n", encoding="utf-8")
        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")

    def test_stale_when_config_or_builder_changes(self) -> None:
        """Given 模块配置或构建器脚本变更, When 预检, Then stale。"""
        self.repo.materialize()
        self.repo.config.write_text('{\n  "modules": [],\n  "x": 1\n}\n', encoding="utf-8")
        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")

        self.repo.materialize()
        self.repo.builders[0].write_text("// builder v2\n", encoding="utf-8")
        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")

    def test_launcher_builder_hash_covers_both_builders(self) -> None:
        """Given launcher 的 builderHash 覆盖两个构建脚本, When 共享的
        build-editor.mjs 变更, Then launcher 产物同样判定过期。"""
        launcher = _FakeRepo(self.root, "launcher")
        launcher.materialize()
        self.assertEqual(web_build.bundle_status(self.root, "launcher")[0], "fresh")

        # editor 构建器被 launcher 复用（compileSources 所在文件），任一变更都应失效
        editor_builder = self.root / "scripts" / "build-editor.mjs"
        editor_builder.write_text("// builder v2\n", encoding="utf-8")

        self.assertEqual(web_build.bundle_status(self.root, "launcher")[0], "stale")

    def test_incomplete_input_ledger_cannot_hide_changed_source(self) -> None:
        self.repo.materialize()
        metadata = json.loads(self.repo.meta.read_text(encoding="utf-8"))
        del metadata["inputs"][self.repo.sources[0]]
        self.repo.meta.write_text(json.dumps(metadata), encoding="utf-8")
        (self.root / "web" / self.repo.sources[0]).write_text("changed", encoding="utf-8")
        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")

    def test_corrupt_metadata_is_stale_without_uncaught_errors(self) -> None:
        self.repo.materialize()
        for value in ([], None, 1, {"format": True}, {"format": 1, "inputs": {}, "sourceFiles": []}):
            with self.subTest(value=value):
                self.repo.meta.write_text(json.dumps(value), encoding="utf-8")
                self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")
        self.repo.meta.write_bytes(b"\xff")
        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")

    def test_corrupt_or_truncated_bundle_is_stale(self) -> None:
        self.repo.materialize()
        for contents in (b"", b"/* truncated", b"\xff"):
            with self.subTest(contents=contents):
                self.repo.bundle.write_bytes(contents)
                self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")

    def test_dependency_declarations_invalidate_bundle(self) -> None:
        self.repo.materialize()
        (self.root / "pnpm-lock.yaml").write_text("lockfileVersion: '10.0'\n", encoding="utf-8")
        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")

    def test_invalid_manifest_cannot_read_outside_web(self) -> None:
        self.repo.materialize()
        metadata = json.loads(self.repo.meta.read_text(encoding="utf-8"))
        metadata["sourceFiles"] = ["../outside.js"]
        metadata["inputs"] = {"../outside.js": _sha("outside")}
        self.repo.manifest.write_text("../outside.js\n", encoding="utf-8")
        self.repo.meta.write_text(json.dumps(metadata), encoding="utf-8")
        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")

    def test_transitive_dependency_in_inputs_is_verified(self) -> None:
        """Given 构建器在 inputs 中额外记录了一个清单外的传递依赖
        （静态 import 图引入）, When 该依赖源码变更, Then 预检判定
        stale 且说明指向该文件。"""
        self.repo.materialize()
        dependency = "src/seam-dep.js"
        (self.root / "web" / dependency).write_text(
            "// dep v1\n", encoding="utf-8", newline="\n")
        metadata = json.loads(self.repo.meta.read_text(encoding="utf-8"))
        metadata["inputs"][dependency] = _sha("// dep v1\n")
        self.repo.meta.write_text(json.dumps(metadata) + "\n", encoding="utf-8")

        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "fresh")

        (self.root / "web" / dependency).write_text(
            "// dep v2\n", encoding="utf-8", newline="\n")
        status, reason = web_build.bundle_status(self.root, "editor")

        self.assertEqual(status, "stale")
        self.assertIn(dependency, reason)

    def test_new_dependency_missing_from_ledger_is_stale(self) -> None:
        """Given 构建器声称引入了新依赖但没有写入 inputs, When 预检,
        Then 判定 stale——依赖账本不完整不能掩盖新增源码。"""
        self.repo.materialize()
        dependency = "src/seam-dep.js"
        (self.root / "web" / dependency).write_text(
            "// dep\n", encoding="utf-8", newline="\n")
        metadata = json.loads(self.repo.meta.read_text(encoding="utf-8"))
        metadata["inputs"].pop(self.repo.sources[0])
        self.repo.meta.write_text(json.dumps(metadata) + "\n", encoding="utf-8")

        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "stale")


class EnsureBundleRebuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = _FakeRepo(self.root, "editor")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _patch_node(self, node_path: str | None) -> None:
        patcher = mock.patch.object(web_build, "shutil", SimpleNamespace(which=lambda name: node_path))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_rebuilds_via_node_and_recovers(self) -> None:
        """Given 产物缺失但 Node 可用, When ensure, Then 调用构建器并恢复 fresh。"""
        self._patch_node("C:/node/node.exe")
        calls: list[list[str]] = []

        def fake_run(command, **_kwargs):
            calls.append(command)
            self.repo.materialize()
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with mock.patch.object(web_build.subprocess, "run", side_effect=fake_run):
            self.assertEqual(web_build.ensure_bundle(self.root, "editor"), "fresh")

        self.assertEqual(len(calls), 1)
        self.assertIn("scripts/build-editor.mjs", calls[0][1])
        self.assertIn("--write", calls[0])

    def test_build_failure_surfaces_command_and_exit_code(self) -> None:
        """Given 构建命令失败, When ensure, Then 报错包含 pnpm 脚本名与退出码。"""
        self._patch_node("C:/node/node.exe")

        with mock.patch.object(
            web_build.subprocess, "run",
            return_value=SimpleNamespace(returncode=1, stdout="", stderr="esbuild failed"),
        ):
            with self.assertRaises(web_build.BundlePreflightError) as caught:
                web_build.ensure_bundle(self.root, "editor")

        message = str(caught.exception)
        self.assertIn("build:editor", message)
        self.assertIn("exit 1", message)
        self.assertIn("esbuild failed", message)

    def test_without_node_lists_manual_commands(self) -> None:
        """Given 没有 Node.js, When ensure, Then 报错给出完整的手动修复命令。"""
        self._patch_node(None)

        with self.assertRaises(web_build.BundlePreflightError) as caught:
            web_build.ensure_bundle(self.root, "editor")

        message = str(caught.exception)
        self.assertIn("Node.js", message)
        self.assertIn("pnpm install --frozen-lockfile", message)
        self.assertIn("pnpm run build:editor", message)

    def test_without_node_modules_points_at_install(self) -> None:
        """Given 有 Node 但依赖未安装, When ensure, Then 提示先 pnpm install。"""
        self._patch_node("C:/node/node.exe")
        (self.root / "node_modules" / "esbuild").rmdir()
        with self.assertRaises(web_build.BundlePreflightError) as caught:
            web_build.ensure_bundle(self.root, "editor")

        self.assertIn("pnpm install", str(caught.exception))

    def test_frozen_missing_is_reported_as_packaging_defect(self) -> None:
        """Given frozen 环境且产物缺失, When ensure(allow_build=False), Then 报打包缺陷。"""
        with self.assertRaises(web_build.BundlePreflightError) as caught:
            web_build.ensure_bundle(self.root, "editor", allow_build=False)

        message = str(caught.exception)
        self.assertIn("打包缺陷", message)
        self.assertIn("editor-bundle.js", message)
        self.assertNotIn("pnpm run build:editor", message)

    def test_frozen_skips_source_consistency_check(self) -> None:
        """Given frozen 包内只有 bundle 本身（无 meta/构建器脚本）, When ensure,
        Then 只做存在性检查即通过。

        打包包内不含 scripts/ 构建器脚本，逐字节一致性校验没有比较对象；
        「先构建、后打包」由打包管线保证（AppImage smoke 曾抓到这里的回归）。
        """
        self.repo.bundle.parent.mkdir(parents=True, exist_ok=True)
        self.repo.bundle.write_text("/* fake artifact */\n", encoding="utf-8")

        self.assertEqual(web_build.ensure_bundle(self.root, "editor", allow_build=False), "fresh")

    def test_concurrent_builds_execute_builder_once(self) -> None:
        """Given 多线程同时触发冷构建, When 并发 ensure, Then 构建器只执行一次。"""
        self._patch_node("C:/node/node.exe")
        build_calls: list[list[str]] = []
        build_lock = threading.Lock()

        def fake_run(command, **_kwargs):
            with build_lock:
                build_calls.append(list(command))
            self.repo.materialize()
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        barrier = threading.Barrier(4)

        def worker():
            barrier.wait(timeout=10)
            self.assertEqual(web_build.ensure_bundle(self.root, "editor"), "fresh")

        with mock.patch.object(web_build.subprocess, "run", side_effect=fake_run):
            threads = [threading.Thread(target=worker) for _ in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=30)
        for thread in threads:
            self.assertFalse(thread.is_alive())

        # 进程内锁 + 拿锁后新鲜度复检共同保证：4 个并发调用只触发 1 次构建
        self.assertEqual(len(build_calls), 1)
        self.assertEqual(web_build.bundle_status(self.root, "editor")[0], "fresh")
        # 锁文件落在仓库根且被 gitignore，不出现在 web/ 资产扫描范围
        self.assertTrue((self.root / ".bundle-build.lock").exists())
        self.assertFalse((self.root / "web" / ".bundle-build.lock").exists())

    def test_cross_process_lock_serializes_critical_sections(self) -> None:
        """Given 两个线程直接竞争文件锁, When 先后进入, Then 临界区不重叠。"""
        state = {"active": 0, "overlap": False, "entered": 0}
        guard = threading.Lock()

        def worker():
            with web_build._cross_process_build_lock(self.root, "editor"):
                with guard:
                    if state["active"] > 0:
                        state["overlap"] = True
                    state["active"] += 1
                    state["entered"] += 1
                time.sleep(0.05)
                with guard:
                    state["active"] -= 1

        errors: list[BaseException] = []
        threads = [
            threading.Thread(target=lambda: _run_worker_catching(worker, errors))
            for _ in range(3)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        for thread in threads:
            self.assertFalse(thread.is_alive())
        # 线程异常必须显式上抛：threading 不会让测试自动失败，
        # 全体 worker 提前崩溃时锁的串行化断言会假绿
        if errors:
            raise errors[0]
        self.assertEqual(state["entered"], 3)
        self.assertFalse(state["overlap"])

    def test_cross_process_lock_times_out_with_actionable_error(self) -> None:
        """Given 锁被外部长期持有, When 等待超时, Then 报错含 pnpm 脚本指引。"""
        with (
            mock.patch.object(web_build, "_try_lock", return_value=False),
            mock.patch.object(web_build, "_CROSS_PROCESS_LOCK_WAIT_SECONDS", 0.5),
            mock.patch.object(web_build.time, "sleep", lambda _s: None),
        ):
            with self.assertRaises(web_build.BundlePreflightError) as caught:
                with web_build._cross_process_build_lock(self.root, "editor"):
                    pass
        message = str(caught.exception)
        self.assertIn("构建超时", message)
        self.assertIn("pnpm run build:editor", message)


class BundlePackagingTests(unittest.TestCase):
    def test_packaging_rejects_present_but_corrupt_bundle(self) -> None:
        guard = (ROOT / "scripts" / "packaging" / "MAW.spec").read_text(encoding="utf-8").split("binaries = []", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repos = [_FakeRepo(root, kind) for kind in ("editor", "launcher")]
            for repo in repos:
                repo.materialize()
            with mock.patch.object(web_build, "bundle_status", wraps=web_build.bundle_status) as status:
                exec(compile(guard, "MAW.spec", "exec"), {"SPECPATH": str(root / "scripts" / "packaging")})
            self.assertEqual(status.call_count, 2)
            repos[0].bundle.write_bytes(b"truncated")
            with self.assertRaisesRegex(SystemExit, "bundle stale"):
                exec(compile(guard, "MAW.spec", "exec"), {"SPECPATH": str(root / "scripts" / "packaging")})


if __name__ == "__main__":
    unittest.main()

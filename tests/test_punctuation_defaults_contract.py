"""断句与标点默认值的跨文件契约。

「断句与标点」的唯一真源常量落位 maw/postprocess_match.py；转写 CLI
脚本与本地引擎按设计保留独立字面量（转写入口不反向依赖后处理包）。
本测试把所有 Python 副本钉在同一默认值上，并执行 Launcher JS 计划导出
与后端保存读取，防止版本漂移让用户配置被旧计划迁移覆盖。
"""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from maw.postprocess_match import (
    DEFAULT_EXTRA_SPLIT_PUNCTUATION,
    DEFAULT_PRESERVE_PUNCTUATION,
    DEFAULT_STRONG_PUNCT,
    DEFAULT_STRIP_TAIL_PUNCT,
)

ROOT = Path(__file__).resolve().parents[1]

EXPECTED_BREAK = "".join(DEFAULT_EXTRA_SPLIT_PUNCTUATION)
EXPECTED_KEEP = "".join(DEFAULT_PRESERVE_PUNCTUATION)
EXPECTED_STRIP = "".join(
    symbol
    for symbol in DEFAULT_EXTRA_SPLIT_PUNCTUATION
    if len(symbol) == 1 and symbol not in DEFAULT_PRESERVE_PUNCTUATION
)

# 各转写 CLI 的共享剥尾默认值；openai 脚本的参数名与 default 分行书写，
# 其余同行，因此用允许空白的正则统一断言。
STRIP_DEFAULT_PATTERN = '--strip-tail-punct",\\s*default="'


def source_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


class PunctuationDefaultsContractTests(unittest.TestCase):
    def launcher_plans(self, split: list[str], preserve: list[str]) -> dict:
        result = subprocess.run(
            ["node", str(ROOT / "tests/helpers/launcher-plan-export.mjs")],
            input=json.dumps({"split": split, "preserve": preserve}),
            capture_output=True, text=True, encoding="utf-8", cwd=ROOT, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        return json.loads(result.stdout)

    def test_launcher_export_versions_follow_backend_contract(self) -> None:
        from maw.postprocess_pipeline import POSTPROCESS_PLAN_VERSION
        plans = self.launcher_plans(["、"], [])
        self.assertEqual(plans["defaults"]["version"], POSTPROCESS_PLAN_VERSION)
        self.assertEqual(plans["controls"]["version"], POSTPROCESS_PLAN_VERSION)

    def test_launcher_custom_symbols_survive_save_load_and_transcribe(self) -> None:
        from maw.gui_web import _transcribe_extra_strong_punct, _transcribe_strip_tail_punct
        from maw.postprocess_pipeline import load_postprocess_plan, save_postprocess_plan
        for split, preserve in ((["、", "？"], ["？"]), ([], [])):
            with self.subTest(split=split), tempfile.TemporaryDirectory() as directory:
                env_path = Path(directory) / "settings.env"
                raw = self.launcher_plans(split, preserve)["controls"]
                saved = save_postprocess_plan(env_path, raw)
                loaded = load_postprocess_plan(env_path)
                for plan in (saved, loaded):
                    match = next(step for step in plan["steps"] if step["id"] == "match")
                    self.assertEqual(match["extraSplitPunctuation"], split)
                    self.assertEqual(match["preservePunctuation"], preserve)
                self.assertEqual(_transcribe_extra_strong_punct(env_path), "".join(split))
                self.assertEqual(_transcribe_strip_tail_punct(env_path), "".join(s for s in split if s not in preserve))

    def test_legacy_v1_symbols_migrate_once_then_allow_removing_defaults(self) -> None:
        from maw.postprocess_pipeline import POSTPROCESS_PLAN_VERSION, load_postprocess_plan, save_postprocess_plan
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / "settings.env"
            migrated = save_postprocess_plan(env_path, {"version": 1, "steps": [{
                "id": "match", "extraSplitPunctuation": ["、"], "preservePunctuation": [],
            }]})
            self.assertEqual(migrated["version"], POSTPROCESS_PLAN_VERSION)
            match = next(step for step in migrated["steps"] if step["id"] == "match")
            self.assertEqual(match["extraSplitPunctuation"], ["、", *DEFAULT_EXTRA_SPLIT_PUNCTUATION])
            match["extraSplitPunctuation"] = ["、"]
            save_postprocess_plan(env_path, migrated)
            loaded = load_postprocess_plan(env_path)
            self.assertEqual(loaded["steps"][0]["extraSplitPunctuation"], ["、"])

    def test_canonical_defaults_keep_expected_semantics(self) -> None:
        # 切句与删除解耦：完整断句清单保持，默认全部保留。
        self.assertEqual(EXPECTED_BREAK, "，。？！；,.;")
        self.assertEqual(EXPECTED_KEEP, EXPECTED_BREAK)
        self.assertEqual(EXPECTED_STRIP, "")
        # CLI 默认值的规范声明常量与派生值一致。
        self.assertEqual(DEFAULT_STRONG_PUNCT, EXPECTED_BREAK)
        self.assertEqual(DEFAULT_STRIP_TAIL_PUNCT, EXPECTED_STRIP)

    def test_asr_segmentation_defaults_follow_shared_constants(self) -> None:
        text = source_text("maw/asr/segmentation.py")
        self.assertIn(f'_DEFAULT_EXTRA_STRONG_PUNCT = "{EXPECTED_BREAK}"', text)
        self.assertIn(f'_DEFAULT_STRIP_TAIL_PUNCT = "{EXPECTED_STRIP}"', text)

    def test_saved_v2_symbols_are_not_overwritten_by_new_defaults(self) -> None:
        from maw.postprocess_pipeline import normalize_plan
        plan = normalize_plan({"version": 2, "steps": [{
            "id": "match", "extraSplitPunctuation": ["、"], "preservePunctuation": [],
        }]})
        match = next(step for step in plan["steps"] if step["id"] == "match")
        self.assertEqual(match["extraSplitPunctuation"], ["、"])
        self.assertEqual(match["preservePunctuation"], [])

    def test_local_engine_tail_punct_follows_shared_constants(self) -> None:
        text = source_text("maw/local_asr.py")
        self.assertIn(f'_LOCAL_TAIL_PUNCT = "{EXPECTED_STRIP}"', text)

    def test_transcribe_cli_strip_defaults_follow_shared_constants(self) -> None:
        scripts = (
            "maw/asr/bcut.py",
            "maw/asr/doubao.py",
            "maw/asr/local.py",
            "maw/asr/openai.py",
            "maw/asr/soniox.py",
            "maw/asr/tencent.py",
        )
        for name in scripts:
            with self.subTest(script=name):
                self.assertRegex(
                    source_text(name), rf'{STRIP_DEFAULT_PATTERN}{EXPECTED_STRIP}"'
                )


if __name__ == "__main__":
    unittest.main()

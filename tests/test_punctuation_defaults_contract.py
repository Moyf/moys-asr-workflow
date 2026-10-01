"""断句与标点默认值的跨文件契约。

「断句与标点」的唯一真源常量落位 maw/postprocess_match.py；转写 CLI
脚本与本地引擎按设计保留独立字面量（转写入口不反向依赖后处理包）。
本测试把所有 Python 副本钉在同一默认值上，防止日后只改一处造成静默
漂移；Launcher JS 默认计划由 test_gui_web.LauncherAssetContractTests
另行守护。
"""

from pathlib import Path
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
    def test_canonical_defaults_keep_expected_semantics(self) -> None:
        # 断句清单 = 完整默认；保留 = ？！；剥尾 = 断句 − 保留（单字符）。
        self.assertEqual(EXPECTED_BREAK, "，。？！；,.")
        self.assertEqual(EXPECTED_KEEP, "？！")
        self.assertEqual(EXPECTED_STRIP, "，。；,.")
        # CLI 默认值的规范声明常量与派生值一致。
        self.assertEqual(DEFAULT_STRONG_PUNCT, EXPECTED_BREAK)
        self.assertEqual(DEFAULT_STRIP_TAIL_PUNCT, EXPECTED_STRIP)

    def test_qwen_script_defaults_follow_shared_constants(self) -> None:
        text = source_text("generate_subtitle_qwen_api.py")
        self.assertIn(f'_DEFAULT_EXTRA_STRONG_PUNCT = "{EXPECTED_BREAK}"', text)
        self.assertIn(f'_DEFAULT_STRIP_TAIL_PUNCT = "{EXPECTED_STRIP}"', text)

    def test_local_engine_tail_punct_follows_shared_constants(self) -> None:
        text = source_text("maw/local_asr.py")
        self.assertIn(f'_LOCAL_TAIL_PUNCT = "{EXPECTED_STRIP}"', text)

    def test_transcribe_cli_strip_defaults_follow_shared_constants(self) -> None:
        scripts = (
            "generate_subtitle_bcut_api.py",
            "generate_subtitle_doubao_api.py",
            "generate_subtitle_local.py",
            "generate_subtitle_openai_api.py",
            "generate_subtitle_soniox_api.py",
            "generate_subtitle_tencent_api.py",
        )
        for name in scripts:
            with self.subTest(script=name):
                self.assertRegex(
                    source_text(name), rf'{STRIP_DEFAULT_PATTERN}{EXPECTED_STRIP}"'
                )


if __name__ == "__main__":
    unittest.main()

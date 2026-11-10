"""term_extract.report 与 CLI 管线（假 provider/prober 走通端到端，无 OCR/LLM）。"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "term-extract"))

from tests.compact_assertions import CompactContainerAssertions  # noqa: E402
from term_extract import report as report_module  # noqa: E402
from term_extract.__main__ import build_parser, parse_region, run_pipeline  # noqa: E402


def scored_candidate(word: str, **overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "word": word,
        "typeGuess": "地点",
        "variants": [],
        "events": [{"text": word, "startMs": 61_800, "endMs": 62_000, "hits": 3, "avgConf": 0.93, "frames": ["frame-000000618000.jpg"], "evidence": [{"frame": "frame-000000618000.jpg", "box": [10, 20, 110, 45]}]}],
        "eventCount": 4,
        "hitCount": 21,
        "avgConf": 0.93,
        "contexts": [f"前往{word}"],
        "templates": [{"name": "goto", "type": "地点", "term": word, "source": f"前往{word}"}],
        "score": 59,
        "reasons": [{"key": "template_hit", "delta": 20, "detail": "命中专名上下文模板（goto）"}],
        "recommended": True,
        "ai": {"verdict": "keep", "type": "地名", "reason": "地点名"},
        "export": {"ok": True, "reason": None},
    }
    base.update(overrides)
    return base


def sample_report() -> dict[str, object]:
    return report_module.build_report(
        video_name="game.mp4",
        fps=1.0,
        model="tiny",
        duration_ms=120_000,
        min_score=60,
        scan_summary={"framesTotal": 120, "framesScanned": 90, "framesSkippedDuplicate": 30, "framesFailed": 0, "blocksTotal": 40},
        candidates=[scored_candidate("星核"), scored_candidate("想要保存更改吗", score=15, recommended=False, ai={"verdict": "reject", "type": "非术语", "reason": "界面词"}, export={"ok": False, "reason": "含非 ASCII 字符时最多 15 个字符"})],
        ai_enabled=True,
        ai_model="test-model",
    )


class ReportTests(CompactContainerAssertions, unittest.TestCase):
    def test_generated_script_has_valid_javascript_syntax(self) -> None:
        html = report_module.render_report_html(sample_report())
        script = html.split('<script>\n', 1)[1].split('</script>', 1)[0]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'report.js'
            path.write_text(script, encoding='utf-8')
            result = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_html_embeds_data_and_controls(self) -> None:
        html = report_module.render_report_html(sample_report())
        self.assertIn("<title>术语提取确认页</title>", html)
        self.assertIn("candidate-data", html)
        self.assertIn("export-btn", html)
        self.assertNotIn("__DATA_JSON__", html)
        self.assertIn("星核", html)

    def test_html_has_length_and_occurrence_filters(self) -> None:
        html = report_module.render_report_html(sample_report())
        self.assertIn('id="max-len"', html)
        self.assertIn('id="min-events"', html)
        self.assertIn("最多字数", html)
        self.assertIn("最少出现次数", html)
        self.assertIn('"max-len","min-events"', html)
        # 最低分数默认不设下限：≤0 分的候选进「排除」组（默认折叠）而非被过滤。
        self.assertIn('id="min-score" value=""', html)
        self.assertIn("-Infinity", html)
        # 数字输入支持滚轮步进（悬停即可调，空值先落默认值）。
        self.assertIn('addEventListener("wheel"', html)
        self.assertIn("wheelDefaults", html)
        self.assertIn("cursor:ns-resize", html)

    def test_html_has_export_preview_panel(self) -> None:
        html = report_module.render_report_html(sample_report())
        self.assertIn("导出预览", html)
        self.assertIn('id="preview-body"', html)
        self.assertIn('id="preview-count"', html)
        self.assertIn("updatePreview", html)

    def test_html_has_scroll_perf_guards(self) -> None:
        html = report_module.render_report_html(sample_report())
        self.assertIn("content-visibility:auto", html)
        self.assertIn("content-visibility:visible", html)  # 打印覆盖
        self.assertIn('decoding="async"', html)
        self.assertIn("checkedState", html)  # 筛选重建后保留勾选

    def test_html_has_overlay_navigation_and_big_hitarea(self) -> None:
        html = report_module.render_report_html(sample_report())
        self.assertIn('id="overlay-prev"', html)
        self.assertIn('id="overlay-next"', html)
        self.assertIn('id="overlay-count"', html)
        self.assertIn('"ArrowLeft"', html)
        self.assertIn('"Escape"', html)
        self.assertIn('class="pick"', html)  # 勾选热区：label 占满左列
        self.assertIn("width:24px;height:24px", html)

    def test_html_has_review_workflow_controls(self) -> None:
        html = report_module.render_report_html(sample_report())
        # 右侧导出栏：词条 chip 可单独移除、组内一键全选、重置筛选与操作提示。
        self.assertIn('class="dock"', html)
        self.assertIn("word-chip", html)
        self.assertIn('id="reset-filters"', html)
        self.assertIn("tier-pick", html)
        self.assertIn('id="toast"', html)
        # 键盘审阅：J/K 移动、X 勾选、O 看证据、/ 聚焦搜索；弹层内可直接勾选。
        self.assertIn('key==="j"', html)
        self.assertIn('key==="x"', html)
        self.assertIn('key==="/"', html)
        self.assertIn('id="overlay-pick"', html)
        self.assertNotIn("alert(", html)

    def test_html_row_click_theme_and_compact_dock(self) -> None:
        html = report_module.render_report_html(sample_report())
        # 横向整行点击切换勾选（避开缩略图/展开明细/按钮），并防止选中文字时误触。
        self.assertIn('t.closest(".pick,button,a,summary,.more-body,input")', html)
        self.assertIn("window.getSelection", html)
        # 深浅双主题（沿用 Launcher 令牌）与窄屏紧凑底栏。
        self.assertIn("[data-theme=light]", html)
        self.assertIn('id="theme-btn"', html)
        self.assertIn('id="dock-toggle"', html)
        self.assertIn("--dock-h", html)
        # 分组头整条可点折叠（全选本组按钮除外）；精简显示开关 + V 快捷键 + 记忆。
        self.assertIn('head.addEventListener("click"', html)
        self.assertIn('id="compact-toggle"', html)
        self.assertIn(".compact .card", html)
        self.assertIn("maw-term-report-compact", html)
        self.assertIn('key==="v"', html)
        # 强调色与 Launcher 一致（深色橙 / 浅色红）。
        self.assertIn("--accent:#f09a50", html)
        self.assertIn("--accent:#c84545", html)

    def test_html_has_evidence_rect_markup(self) -> None:
        html = report_module.render_report_html(sample_report())
        self.assertIn("frame-wrap", html)
        self.assertIn("frame-rect", html)
        self.assertIn("overlay-rects", html)
        self.assertIn("rectStyle", html)

    def test_html_has_score_tier_groups(self) -> None:
        html = report_module.render_report_html(sample_report())
        # 四个分组及代表色样式、折叠默认态与空态提示。
        self.assertIn("tier-head", html)
        self.assertIn("tier-rec", html)
        self.assertIn("tier-maybe", html)
        self.assertIn("tier-weak", html)
        self.assertIn("tier-noise", html)
        self.assertIn("var collapsed={weak:true,noise:true}", html)
        self.assertIn("当前筛选条件下没有候选", html)

    def test_build_report_annotates_normalized_rects(self) -> None:
        from PIL import Image

        with tempfile.TemporaryDirectory() as temp:
            frames_dir = Path(temp) / "frames"
            frames_dir.mkdir()
            # 文件名对齐 scored_candidate 基线数据里引用的证据帧。
            Image.new("RGB", (100, 50), color=(30, 30, 30)).save(frames_dir / "frame-000000618000.jpg")
            payload = report_module.build_report(
                video_name="game.mp4",
                fps=1.0,
                model="tiny",
                duration_ms=120_000,
                min_score=60,
                scan_summary={},
                candidates=[scored_candidate("星核")],
                ai_enabled=False,
                frames_dir=frames_dir,
            )
        evidence = payload["candidates"][0]["events"][0]["evidence"][0]  # type: ignore[index]
        self.assertEqual(evidence["rect"], [0.1, 0.4, 1.0, 0.5])
        self.assertEqual(evidence["frameSize"], [100, 50])

    def test_build_report_without_frames_dir_skips_rects(self) -> None:
        payload = report_module.build_report(
            video_name="game.mp4",
            fps=1.0,
            model="tiny",
            duration_ms=120_000,
            min_score=60,
            scan_summary={},
            candidates=[scored_candidate("星核")],
            ai_enabled=False,
        )
        evidence = payload["candidates"][0]["events"][0]["evidence"][0]  # type: ignore[index]
        self.assertNotIn("rect", evidence)

    def test_candidates_json_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "candidates.json"
            payload = sample_report()
            report_module.write_candidates_json(path, payload)
            loaded = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(loaded["video"], "game.mp4")
            self.assertEqual(len(loaded["candidates"]), 2)
            self.assertEqual(loaded["candidates"][0]["events"][0]["startMs"], 61_800)

    def test_csv_has_bom_and_columns(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "report.csv"
            report_module.write_report_csv(path, sample_report()["candidates"])  # type: ignore[arg-type]
            raw = path.read_bytes()
            self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
            text = raw.decode("utf-8-sig")
            self.assertIn("word,score,recommended", text)
            self.assertIn("星核", text)


class RegionTests(unittest.TestCase):
    def test_full_and_bottom30(self) -> None:
        self.assertEqual(parse_region(["full"]).mode, "full")
        self.assertEqual(parse_region(["bottom30"]).mode, "bottom30")

    def test_custom_requires_four_coords(self) -> None:
        region = parse_region(["custom", "0.1", "0.7", "0.9", "1.0"])
        self.assertEqual(region.mode, "custom")
        with self.assertRaises(ValueError):
            parse_region(["custom", "0.1"])

    def test_unknown_mode_rejected(self) -> None:
        with self.assertRaises(ValueError):
            parse_region(["diagonal"])


class _FakeProvider:
    def __init__(self, blocks: list[dict[str, object]]) -> None:
        self.blocks = blocks

    def scan(self, video: Path, *, duration_ms: int, fps: float, region: object, model: str, frames_dir: Path, on_status: object = None) -> dict[str, object]:
        return {
            "framesTotal": 6,
            "framesScanned": 6,
            "framesSkippedDuplicate": 0,
            "framesFailed": 0,
            "blocksTotal": len(self.blocks),
            "blocks": self.blocks,
        }


class PipelineTests(CompactContainerAssertions, unittest.TestCase):
    def test_pipeline_produces_all_artifacts(self) -> None:
        blocks: list[dict[str, object]] = []
        # 三簇密集命中：让「星核/真希」拿到 独立事件 3 次 + 累计命中 18 次 的证据。
        for cluster_start in (0, 100_000, 200_000):
            for second in range(9):
                t_ms = cluster_start + second * 1000
                blocks.append({"text": "前往星核", "score": 0.93, "box": [10, 10, 200, 40], "tMs": t_ms, "frame": None})
                blocks.append({"text": "与真希交谈", "score": 0.9, "box": [10, 60, 220, 90], "tMs": t_ms, "frame": None})
        blocks.append({"text": "想要保存更改吗", "score": 0.98, "box": [10, 120, 400, 150], "tMs": 1_000, "frame": None})

        with tempfile.TemporaryDirectory() as temp:
            video = Path(temp) / "game.mp4"
            video.write_bytes(b"video")
            args = build_parser().parse_args([str(video), "--no-ai"])
            code = run_pipeline(
                args,
                scan_provider=_FakeProvider(blocks),  # type: ignore[arg-type]
                duration_prober=lambda _video: 6_000,
            )
            self.assertEqual(code, 0)
            out_dir = Path(temp) / "game.termextract"
            for name in ("ocr.json", "candidates.json", "report.csv", "report.html", "hotwords.txt"):
                self.assertTrue((out_dir / name).is_file(), name)
            payload = json.loads((out_dir / "candidates.json").read_text(encoding="utf-8"))
            self.assertFalse(payload["aiEnabled"])
            words = [item["word"] for item in payload["candidates"]]
            self.assertIn("星核", words)
            self.assertIn("真希", words)
            hotwords = (out_dir / "hotwords.txt").read_text(encoding="utf-8").splitlines()
            self.assertIn("星核", hotwords)
            self.assertNotIn("想要保存更改吗", hotwords)
            html = (out_dir / "report.html").read_text(encoding="utf-8")
            self.assertIn("候选", html)

    def test_missing_video_fails_fast(self) -> None:
        args = build_parser().parse_args([r"Z:\definitely\missing.mp4"])
        self.assertEqual(run_pipeline(args, duration_prober=lambda _v: 1000), 1)


if __name__ == "__main__":
    _ = unittest.main()

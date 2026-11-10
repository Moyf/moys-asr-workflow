"""term-extract CLI：视频 → OCR → 聚合评分 → AI 筛选 → HTML 确认页。

用法见 README；规格见 SPEC。测试可通过 provider / duration_prober 注入假件。
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path

from maw.asr.common import get_duration_sec
from maw.ffmpeg import resolve_ffmpeg_tool
from maw.postprocess_ocr import OcrRegion

if __package__ in (None, ""):  # 直接执行 python term_extract/__main__.py 时补路径
    _tool_dir = str(Path(__file__).resolve().parents[1])
    _repo_root = str(Path(__file__).resolve().parents[3])
    for _path in (_repo_root, _tool_dir):
        if _path not in sys.path:
            sys.path.insert(0, _path)
    from term_extract import aggregate, ai_filter, export, provider, report, score
else:
    from . import aggregate, ai_filter, export, provider, report, score

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MIN_SCORE = 60
OCR_JSON = "ocr.json"
FRAMES_DIRNAME = "frames"

DurationProber = Callable[[Path], int]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="term-extract",
        description="从视频画面提取游戏术语候选，生成热词确认页（独立工具，规格见 SPEC.md）",
    )
    parser.add_argument("video", help="输入视频路径")
    parser.add_argument("--fps", type=float, default=1.0, help="采样密度（0.2–2.0），长视频建议 0.5")
    parser.add_argument("--model", choices=("tiny", "small"), default="tiny", help="PP-OCRv6 模型档位")
    parser.add_argument(
        "--region",
        nargs="+",
        metavar=("MODE", "X1"),
        default=["full"],
        help="画面区域：full | bottom30 | custom x1 y1 x2 y2（0–1 归一化）",
    )
    parser.add_argument("--min-score", type=int, default=DEFAULT_MIN_SCORE, help="推荐分数线（默认 60）")
    parser.add_argument("--ocr", choices=("runtime", "local"), default="runtime", help="OCR 执行模式")
    parser.add_argument(
        "--no-ai",
        action="store_true",
        help="跳过 AI 筛选（仅开发调试；推荐项将只依赖规则评分，未经语义判断）",
    )
    parser.add_argument("--out", default="", help="产物目录（默认视频旁 <视频名>.termextract/）")
    parser.add_argument("--resume", action="store_true", help="复用已有 ocr.json，跳过扫描")
    parser.add_argument(
        "--weight-by-score",
        action="store_true",
        help="导出时按分数带映射权重（≥80→5、70–79→4、60–69→3）",
    )
    parser.add_argument("--max-frames", type=int, default=20000, help="采样帧数安全上限")
    parser.add_argument("--llm-preset", default="", help=f"LLM 预设：{'/'.join(ai_filter.available_presets())}")
    parser.add_argument("--llm-base-url", default="", help="自定义 LLM base_url（覆盖预设）")
    parser.add_argument("--llm-model", default="", help="自定义 LLM 模型（覆盖预设）")
    parser.add_argument("--llm-api-key", default="", help="API Key（默认读环境变量 MAW_TERMS_LLM_API_KEY）")
    return parser


def parse_region(values: list[str]) -> OcrRegion:
    mode = values[0]
    if mode == "custom":
        if len(values) != 5:
            raise ValueError("--region custom 需要 x1 y1 x2 y2 四个 0–1 数值")
        try:
            x1, y1, x2, y2 = (float(value) for value in values[1:])
        except ValueError as error:
            raise ValueError("--region custom 的坐标必须是数字") from error
        return OcrRegion(mode="custom", x1=x1, y1=y1, x2=x2, y2=y2)
    if len(values) != 1 or mode not in {"full", "bottom30"}:
        raise ValueError("--region 只支持 full、bottom30 或 custom x1 y1 x2 y2")
    return OcrRegion(mode=mode)


def default_output_dir(video: Path) -> Path:
    return video.parent / f"{video.stem}.termextract"


def probe_duration_ms(video: Path) -> int:
    ffprobe = resolve_ffmpeg_tool("ffprobe", configured_path=None)
    return int(get_duration_sec(str(video), ffprobe_path=ffprobe) * 1000)


def run_pipeline(
    args: argparse.Namespace,
    *,
    scan_provider: provider.RuntimeScanProvider | provider.LocalScanProvider | None = None,
    duration_prober: DurationProber | None = None,
) -> int:
    video = Path(args.video).expanduser().resolve()
    if not video.is_file():
        print(f"[错误] 找不到视频：{video}", file=sys.stderr)
        return 1
    try:
        region = parse_region(list(args.region))
    except ValueError as error:
        print(f"[错误] {error}", file=sys.stderr)
        return 1

    out_dir = Path(args.out).expanduser().resolve() if args.out else default_output_dir(video)
    out_dir.mkdir(parents=True, exist_ok=True)
    frames_dir = out_dir / FRAMES_DIRNAME

    ocr_json_path = out_dir / OCR_JSON
    if args.resume and ocr_json_path.is_file():
        print(f"[resume] 复用已有扫描结果：{ocr_json_path}")
        ocr_payload = json.loads(ocr_json_path.read_text(encoding="utf-8"))
        duration_ms = int(ocr_payload["durationMs"])
        scan_summary = dict(ocr_payload.get("scan") or {})
        blocks = list(ocr_payload.get("blocks") or [])
    else:
        duration_ms = (duration_prober or probe_duration_ms)(video)
        print(f"[scan] {video.name} 时长 {duration_ms / 1000:.1f}s，fps={args.fps}，模式 {args.ocr}/{args.model}")
        active_provider = scan_provider or provider.make_provider(args.ocr)

        def on_scan_status(key: str, details: Mapping[str, int]) -> None:
            current = details.get("current")
            total = details.get("total")
            if current is not None and total and (current % 30 == 0 or current == total):
                print(f"[scan] {current}/{total} 帧")

        try:
            payload = active_provider.scan(
                video,
                duration_ms=duration_ms,
                fps=args.fps,
                region=region,
                model=args.model,
                frames_dir=frames_dir,
                on_status=on_scan_status,
            )
        except KeyboardInterrupt:
            print("\n[中断] 扫描已取消；可加 --resume 复用已完成部分以外重跑。", file=sys.stderr)
            return 130
        blocks = list(payload.get("blocks") or [])
        scan_summary = {
            key: value for key, value in payload.items() if key != "blocks"
        }
        _write_json(
            ocr_json_path,
            {
                "video": video.name,
                "durationMs": duration_ms,
                "fps": args.fps,
                "model": args.model,
                "scan": scan_summary,
                "blocks": blocks,
            },
        )
    print(
        f"[scan] 完成：识别块 {len(blocks)} 个"
        + (f"，跳过静止帧 {scan_summary.get('framesSkippedDuplicate', '?')} 个" if scan_summary else "")
    )

    print("[aggregate] 聚合显示事件与候选…")
    candidates = aggregate.extract_candidates(blocks, args.fps)
    ignore_words = score.load_ignore_words(out_dir / score.IGNORE_EXTRA_FILENAME)
    scored = score.apply_scoring(candidates, min_score=args.min_score, ignore_words=ignore_words)
    for candidate in scored:
        issue = export.hotword_issue(str(candidate["word"]))
        candidate["export"] = {"ok": issue is None, "reason": issue}
    print(f"[aggregate] 候选 {len(scored)} 个，推荐 {sum(1 for c in scored if c['recommended'])} 个")

    ai_enabled = not args.no_ai
    ai_model: str | None = None
    if ai_enabled:
        try:
            settings = ai_filter.build_settings(
                preset_id=args.llm_preset or None,
                base_url=args.llm_base_url or None,
                model=args.llm_model or None,
                api_key=args.llm_api_key or None,
            )
        except ValueError as error:
            print(f"[错误] {error}", file=sys.stderr)
            return 2
        ai_model = settings.model
        print(f"[ai] 语义筛选（{settings.provider_id}/{settings.model}）…")
        try:
            verdicts = ai_filter.filter_candidates(scored, settings)
        except KeyboardInterrupt:
            print("\n[中断] AI 筛选已取消。", file=sys.stderr)
            return 130
        except Exception as error:  # noqa: BLE001 - 失败必须落盘并显式退出
            record = out_dir / "ai-failure-record.md"
            record.write_text(
                f"# AI 筛选失败记录\n\n- 时间：{datetime.now().isoformat(timespec='seconds')}\n"
                f"- 候选数：{len(scored)}\n- 错误：{error}\n\n"
                f"已完成的 candidates.json 仅含规则评分，推荐项未经语义筛选，请勿直接全量导出。\n",
                encoding="utf-8",
                newline="\n",
            )
            print(f"[错误] AI 筛选失败，详见 {record}", file=sys.stderr)
            return 2
        for candidate in scored:
            verdict = verdicts.get(str(candidate["word"]))
            candidate["ai"] = verdict
        kept = sum(1 for c in scored if (c.get("ai") or {}).get("verdict") == "keep")
        print(f"[ai] 完成：保留 {kept}，排除 {len(scored) - kept}")
    else:
        for candidate in scored:
            candidate["ai"] = None
        print("[ai] 已按 --no-ai 跳过：推荐项仅来自规则评分，未经语义筛选！")

    report_payload = report.build_report(
        video_name=video.name,
        fps=args.fps,
        model=args.model,
        duration_ms=duration_ms,
        min_score=args.min_score,
        scan_summary=scan_summary,
        candidates=scored,
        ai_enabled=ai_enabled,
        ai_model=ai_model,
        frames_dir=frames_dir,
    )
    report.write_candidates_json(out_dir / report.CANDIDATES_FILENAME, report_payload)
    report.write_report_csv(out_dir / report.REPORT_CSV_FILENAME, scored)
    report.write_report_html(out_dir / report.REPORT_HTML_FILENAME, report_payload)

    hotwords_text, rejected = export.build_hotwords(
        [c for c in scored if c["recommended"]], weight_by_score=args.weight_by_score
    )
    if hotwords_text:
        (out_dir / export.HOTWORDS_FILENAME).write_text(hotwords_text, encoding="utf-8", newline="\n")
    print(f"[done] 产物目录：{out_dir}")
    print(f"[done] 确认页：{out_dir / report.REPORT_HTML_FILENAME}（浏览器打开，勾选后右上角导出）")
    if rejected:
        print(f"[done] {len(rejected)} 个推荐词不满足热词硬限制，已标灰：{', '.join(item['word'] for item in rejected[:5])}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return run_pipeline(args)


def _write_json(path: Path, payload: Mapping[str, object]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    raise SystemExit(main())

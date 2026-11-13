"""Killable worker for the optional OCR runtime."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


_BUNDLE_ROOT = Path(__file__).resolve().parents[1]
if str(_BUNDLE_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUNDLE_ROOT))

from maw.console import configure_utf8_stdio  # noqa: E402
from maw.ocr_scan import OcrScanRequest, clamp_fps, run_ocr_scan  # noqa: E402
from maw.postprocess import OutputMode  # noqa: E402
from maw.postprocess_ocr import OcrDedupRequest, OcrRegion, run_ocr_dedup  # noqa: E402


OCR_MODEL_TYPES = {
    "pp-ocrv6-tiny": "tiny",
    "pp-ocrv6-small": "small",
}


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "scan":
            summary = run_ocr_scan(
                OcrScanRequest(
                    video_path=Path(args.video_path),
                    ffmpeg_path=Path(args.ffmpeg_path),
                    duration_ms=args.duration_ms,
                    fps=clamp_fps(args.fps),
                    region=OcrRegion(
                        mode=args.region_mode,
                        x1=args.region_x1,
                        y1=args.region_y1,
                        x2=args.region_x2,
                        y2=args.region_y2,
                    ),
                    model_type=OCR_MODEL_TYPES[args.model_id],
                    frames_dir=Path(args.frames_dir) if args.frames_dir else None,
                    max_frames=args.max_frames,
                ),
                on_status=_status,
                on_blocks=_blocks,
            )
            print(json.dumps({"type": "result", **summary}, ensure_ascii=False), flush=True)
            return 0
        if args.model_id not in OCR_MODEL_TYPES:
            raise ValueError(f"不支持的 OCR 模型：{args.model_id}")
        request = OcrDedupRequest(
            project_path=_path(args.project_path),
            srt_path=_path(args.srt_path),
            video_path=_path(args.video_path),
            fallback_video_path=_path(args.fallback_video_path),
            media_path=_path(args.media_path),
            output_directory=_path(args.output_directory),
            output_mode=OutputMode(args.output_mode),
            region=OcrRegion(
                mode=args.region_mode,
                x1=args.region_x1,
                y1=args.region_y1,
                x2=args.region_x2,
                y2=args.region_y2,
            ),
            threshold=args.threshold,
            report=args.report,
        )
        artifact = run_ocr_dedup(
            request,
            ffmpeg_path=Path(args.ffmpeg_path),
            model_type=OCR_MODEL_TYPES[args.model_id],
            on_status=_status,
        )
        print(
            json.dumps(
                {
                    "type": "result",
                    "sourceProjectPath": str(artifact.source_project_path) if artifact.source_project_path else "",
                    "sourceSrtPath": str(artifact.source_srt_path) if artifact.source_srt_path else "",
                    "projectPath": str(artifact.project_path) if artifact.project_path else "",
                    "srtPath": str(artifact.srt_path) if artifact.srt_path else "",
                    "reportPath": str(artifact.report_path) if artifact.report_path else "",
                    "warnings": list(artifact.warnings),
                    "newlyDisabledCount": artifact.newly_disabled_count,
                    "existingDisabledCount": artifact.existing_disabled_count,
                    "processedCount": artifact.processed_count,
                    "skippedCount": artifact.skipped_count,
                    "failedCount": artifact.failed_count,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0
    except Exception as error:  # noqa: BLE001 - return a structured worker error.
        print(json.dumps({"type": "error", "detail": str(error)}, ensure_ascii=False), flush=True)
        return 1


def _status(key: str, details: dict[str, int]) -> None:
    print(json.dumps({"type": "status", "key": key, "details": details}, ensure_ascii=False), flush=True)


def _blocks(t_ms: int, frame: str | None, hits: list[tuple[str, float, tuple[int, int, int, int]]]) -> None:
    payload = [
        {"text": text, "score": round(score, 4), "box": list(box)}
        for text, score, box in hits
    ]
    print(
        json.dumps({"type": "blocks", "tMs": t_ms, "frame": frame, "blocks": payload}, ensure_ascii=False),
        flush=True,
    )


def _path(value: str) -> Path | None:
    return Path(value) if value else None


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MAW optional OCR worker")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run")
    run.add_argument("--model-id", required=True)
    run.add_argument("--project-path", default="")
    run.add_argument("--srt-path", default="")
    run.add_argument("--video-path", default="")
    run.add_argument("--fallback-video-path", default="")
    run.add_argument("--media-path", default="")
    run.add_argument("--output-directory", default="")
    run.add_argument("--output-mode", choices=[mode.value for mode in OutputMode], required=True)
    run.add_argument("--ffmpeg-path", required=True)
    run.add_argument("--region-mode", choices=("full", "bottom30", "custom"), default="full")
    run.add_argument("--region-x1", type=float, default=0.0)
    run.add_argument("--region-y1", type=float, default=0.0)
    run.add_argument("--region-x2", type=float, default=1.0)
    run.add_argument("--region-y2", type=float, default=1.0)
    run.add_argument("--threshold", type=float, default=0.5)
    run.add_argument("--report", action="store_true")
    scan = subparsers.add_parser("scan", help="整段视频 OCR 扫描（raw-blocks 模式）")
    scan.add_argument("--model-id", required=True)
    scan.add_argument("--video-path", required=True)
    scan.add_argument("--ffmpeg-path", required=True)
    scan.add_argument("--duration-ms", type=int, required=True)
    scan.add_argument("--fps", type=float, default=1.0)
    scan.add_argument("--frames-dir", default="")
    scan.add_argument("--max-frames", type=_positive_int, default=20000)
    scan.add_argument("--region-mode", choices=("full", "bottom30", "custom"), default="full")
    scan.add_argument("--region-x1", type=float, default=0.0)
    scan.add_argument("--region-y1", type=float, default=0.0)
    scan.add_argument("--region-x2", type=float, default=1.0)
    scan.add_argument("--region-y2", type=float, default=1.0)
    return parser


if __name__ == "__main__":
    raise SystemExit(main())

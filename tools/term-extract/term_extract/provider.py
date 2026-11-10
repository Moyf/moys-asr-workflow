"""OCR 执行器：runtime 托管环境（默认）与本地直连（开发/冒烟）两种模式。"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
from threading import Event

from maw.ffmpeg import resolve_ffmpeg_tool
from maw.ocr_runtime import (
    OCR_MODEL_ID,
    OCR_SMALL_MODEL_ID,
    run_ocr_scan_in_runtime,
)
from maw.postprocess_ocr import OcrRegion

ScanStatus = Callable[[str, Mapping[str, int]], None]


class RuntimeScanProvider:
    """经用户管理的 OCR runtime worker 执行扫描（合并进 MAW 后的正式路径）。"""

    def scan(
        self,
        video_path: Path,
        *,
        duration_ms: int,
        fps: float,
        region: OcrRegion,
        model: str,
        frames_dir: Path,
        max_frames: int = 20000,
        on_status: ScanStatus | None = None,
        cancel_event: Event | None = None,
    ) -> dict[str, object]:
        ffmpeg = resolve_ffmpeg_tool("ffmpeg", configured_path=None)
        return run_ocr_scan_in_runtime(
            video_path,
            ffmpeg_path=ffmpeg,
            duration_ms=duration_ms,
            fps=fps,
            region=region,
            model_id=OCR_MODEL_ID if model == "tiny" else OCR_SMALL_MODEL_ID,
            frames_dir=frames_dir,
            max_frames=max_frames,
            on_status=on_status,
            cancel_event=cancel_event,
        )


class LocalScanProvider:
    """开发环境直连 rapidocr（uv sync --group ocr），不经托管 runtime。"""

    def scan(
        self,
        video_path: Path,
        *,
        duration_ms: int,
        fps: float,
        region: OcrRegion,
        model: str,
        frames_dir: Path,
        max_frames: int = 20000,
        on_status: ScanStatus | None = None,
        cancel_event: Event | None = None,
    ) -> dict[str, object]:
        # 延迟导入：聚合/评分单测不依赖 OCR 运行时。
        from maw.ocr_scan import OcrScanRequest, run_ocr_scan
        from maw.postprocess_ocr import _RapidOcrRecognizer

        ffmpeg = resolve_ffmpeg_tool("ffmpeg", configured_path=None)
        recognizer = _RapidOcrRecognizer("tiny" if model == "tiny" else "small")
        blocks: list[dict[str, object]] = []

        def collect(t_ms: int, frame: str | None, hits: list[tuple[str, float, tuple[int, int, int, int]]]) -> None:
            for text, score, box in hits:
                blocks.append({"text": text, "score": score, "box": list(box), "tMs": t_ms, "frame": frame})

        def scan_status(key: str, details: Mapping[str, int]) -> None:
            # 本地 scanner 在帧边界通知进度；无需更改其公共协议即可取消。
            if cancel_event is not None and cancel_event.is_set():
                raise KeyboardInterrupt
            if on_status is not None:
                on_status(key, details)

        summary = run_ocr_scan(
            OcrScanRequest(
                video_path=video_path,
                ffmpeg_path=Path(ffmpeg),
                duration_ms=duration_ms,
                fps=fps,
                region=region,
                model_type="tiny" if model == "tiny" else "small",
                frames_dir=frames_dir,
                max_frames=max_frames,
            ),
            on_status=scan_status,
            on_blocks=collect,
            recognizer=recognizer.recognize_blocks,
        )
        return {**summary, "blocks": blocks}


def make_provider(mode: str) -> RuntimeScanProvider | LocalScanProvider:
    if mode == "local":
        return LocalScanProvider()
    if mode == "runtime":
        return RuntimeScanProvider()
    raise ValueError(f"未知的 OCR 执行模式：{mode}（可选 runtime / local）")

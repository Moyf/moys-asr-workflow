"""Video-wide OCR scan pipeline shared by the OCR runtime worker and local runs.

与 ``postprocess_ocr`` 的字幕去重不同，本模块面向整段视频：按固定 fps 采样
时间点、ffmpeg 逐点抽帧、平均哈希跳过静止画面、OCR 后逐帧输出识别块
（文本 / 置信度 / 文字框 / 时间点），供术语提取等「看整个画面」的功能复用。
"""

from __future__ import annotations

import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from maw.postprocess_ocr import (
    OcrRegion,
    _RapidOcrRecognizer,
    _extract_frame,
    _open_image,
    _prepare_image,
)

OCR_SCAN_DEFAULT_FPS = 1.0
OCR_SCAN_MIN_FPS = 0.2
OCR_SCAN_MAX_FPS = 2.0
OCR_SCAN_DEFAULT_MAX_FRAMES = 20_000
HASH_GRID = 16

OcrStatus = Callable[[str, dict[str, int]], None]
OcrBlocksObserver = Callable[[int, str | None, list[tuple[str, float, tuple[int, int, int, int]]]], None]
Recognizer = Callable[[Any], list[tuple[str, float, tuple[int, int, int, int]]]]
FrameExtractor = Callable[[Path, Path, float, Path], bool]
ImageLoader = Callable[[Path], Any]


@dataclass(frozen=True, slots=True)
class OcrScanRequest:
    """一次整段视频 OCR 扫描的输入。"""

    video_path: Path
    ffmpeg_path: Path
    duration_ms: int
    fps: float = OCR_SCAN_DEFAULT_FPS
    region: OcrRegion = OcrRegion()
    model_type: str = "tiny"
    frames_dir: Path | None = None
    max_frames: int = OCR_SCAN_DEFAULT_MAX_FRAMES


def clamp_fps(value: float) -> float:
    """把采样密度限制在工具承诺的范围内（过密没有意义且耗时失控）。"""

    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("OCR 扫描 fps 必须是数字") from error
    if not OCR_SCAN_MIN_FPS <= parsed <= OCR_SCAN_MAX_FPS:
        raise ValueError(f"OCR 扫描 fps 必须在 {OCR_SCAN_MIN_FPS} 到 {OCR_SCAN_MAX_FPS} 之间")
    return parsed


def sampling_timestamps(
    duration_ms: int,
    fps: float,
    max_frames: int = OCR_SCAN_DEFAULT_MAX_FRAMES,
) -> list[int]:
    """均匀采样时间点（整数毫秒，严格递增，不含结尾端点）。

    fps=1 时即每秒一帧；fps=0.5 为每两秒一帧。受 ``max_frames`` 安全上限约束。
    """

    if duration_ms <= 0:
        return []
    step_ms = 1000.0 / clamp_fps(fps)
    timestamps: list[int] = []
    index = 0
    while len(timestamps) < max_frames:
        candidate = int(round(index * step_ms))
        if candidate >= duration_ms:
            break
        if not timestamps or candidate > timestamps[-1]:
            timestamps.append(candidate)
        index += 1
    return timestamps


def average_hash(image: Any) -> str:
    """16x16 平均哈希；相邻画面相同则认为静止，可跳过重复 OCR。"""

    gray = image.convert("L").resize((HASH_GRID, HASH_GRID))
    pixels = gray.tobytes()
    if not pixels:
        return ""
    average = sum(pixels) / len(pixels)
    bits = "".join("1" if pixel > average else "0" for pixel in pixels)
    return f"{int(bits, 2):032x}"


def run_ocr_scan(
    request: OcrScanRequest,
    *,
    on_status: OcrStatus | None = None,
    on_blocks: OcrBlocksObserver | None = None,
    recognizer: Recognizer | None = None,
    frame_extractor: FrameExtractor | None = None,
    image_loader: ImageLoader | None = None,
) -> dict[str, object]:
    """执行扫描并返回汇总；识别块经 ``on_blocks`` 逐帧流式回调。"""

    fps = clamp_fps(request.fps)
    recognize = recognizer or _RapidOcrRecognizer(request.model_type).recognize_blocks
    extract = frame_extractor or _extract_frame
    load_image = image_loader or _open_image

    timestamps = sampling_timestamps(request.duration_ms, fps, request.max_frames)
    if not timestamps:
        raise ValueError("视频时长不足或采样参数异常，没有可扫描的时间点")
    if request.frames_dir is not None:
        request.frames_dir.mkdir(parents=True, exist_ok=True)

    total = len(timestamps)
    scanned = 0
    skipped_duplicate = 0
    failed = 0
    blocks_total = 0
    last_hash = ""

    with tempfile.TemporaryDirectory(prefix="maw_ocr_scan_") as temporary_directory:
        frame_directory = Path(temporary_directory)
        for index, t_ms in enumerate(timestamps):
            if on_status is not None:
                on_status("ocr_scan_frame", {"current": index + 1, "total": total})
            frame_path = frame_directory / f"frame-{index:06d}.jpg"
            if not extract(request.ffmpeg_path, request.video_path, t_ms / 1000.0, frame_path):
                failed += 1
                continue
            try:
                with load_image(frame_path) as image:
                    prepared = _prepare_image(request.region.crop(image))
                    digest = average_hash(prepared)
                    if digest and digest == last_hash:
                        skipped_duplicate += 1
                        continue
                    last_hash = digest
                    hits = [
                        (str(text), float(score), (int(b1), int(b2), int(b3), int(b4)))
                        for text, score, (b1, b2, b3, b4) in recognize(prepared)
                        if str(text).strip()
                    ]
            except Exception:  # noqa: BLE001 - 单帧失败不能中断整段扫描
                failed += 1
                continue
            scanned += 1
            if not hits:
                continue
            frame_name = _save_evidence_frame(prepared, request.frames_dir, t_ms)
            if on_blocks is not None:
                on_blocks(t_ms, frame_name, hits)
            blocks_total += len(hits)

    return {
        "framesTotal": total,
        "framesScanned": scanned,
        "framesSkippedDuplicate": skipped_duplicate,
        "framesFailed": failed,
        "blocksTotal": blocks_total,
    }


def _save_evidence_frame(prepared_image: Any, frames_dir: Path | None, t_ms: int) -> str | None:
    """把有文字命中的画面存为证据帧；失败时仅放弃该帧证据，不影响识别块。"""

    if frames_dir is None:
        return None
    name = f"frame-{t_ms:012d}.jpg"
    try:
        prepared_image.save(frames_dir / name, quality=85)
    except Exception:  # noqa: BLE001 - 证据帧缺失可接受
        return None
    return name

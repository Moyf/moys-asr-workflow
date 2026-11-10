"""Video-wide OCR scan pipeline shared by the OCR runtime worker and local runs.

与 ``postprocess_ocr`` 的字幕去重不同，本模块面向整段视频：按固定 fps 采样
时间点、ffmpeg 逐点抽帧、精确像素指纹复用静止画面的成功 OCR 结果、逐帧输出识别块
（文本 / 置信度 / 文字框 / 时间点），供术语提取等「看整个画面」的功能复用。
"""

from __future__ import annotations

import hashlib
import math
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

    if isinstance(max_frames, bool) or not isinstance(max_frames, int) or max_frames <= 0:
        raise ValueError("OCR 扫描 max_frames 必须是正整数")
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
    """兼容旧调用的 16x16 平均哈希；有损指纹不能作为跳过 OCR 的依据。"""

    gray = image.convert("L").resize((HASH_GRID, HASH_GRID))
    pixels = gray.tobytes()
    if not pixels:
        return ""
    average = sum(pixels) / len(pixels)
    bits = "".join("1" if pixel > average else "0" for pixel in pixels)
    return f"{int(bits, 2):032x}"


def _pixel_fingerprint(image: Any) -> bytes:
    """对 OCR 实际输入的尺寸、模式和全部像素做无损指纹。"""

    digest = hashlib.sha256()
    digest.update(f"{image.width}:{image.height}:{image.mode}\0".encode("ascii"))
    digest.update(image.tobytes())
    return digest.digest()


def _planned_frame_count(duration_ms: int, fps: float) -> int:
    """计算未截断采样计划的长度，端点舍入与 sampling_timestamps 一致。"""

    step_ms = 1000.0 / fps
    count = max(0, math.ceil(duration_ms / step_ms))
    while count and int(round((count - 1) * step_ms)) >= duration_ms:
        count -= 1
    while int(round(count * step_ms)) < duration_ms:
        count += 1
    return count


def run_ocr_scan(
    request: OcrScanRequest,
    *,
    on_status: OcrStatus | None = None,
    on_blocks: OcrBlocksObserver | None = None,
    recognizer: Recognizer | None = None,
    frame_extractor: FrameExtractor | None = None,
    image_loader: ImageLoader | None = None,
) -> dict[str, object]:
    """执行扫描；所有成功采样（包括空结果与复用）都回调 ``on_blocks``。

    framesScanned / blocksRecognized 只计成功 OCR 调用；blocksTotal 计逐帧
    输出的识别块（含复用），不因静止画面丢失显示事件的时间连续性。
    """

    fps = clamp_fps(request.fps)
    timestamps = sampling_timestamps(request.duration_ms, fps, request.max_frames)
    if not timestamps:
        raise ValueError("视频时长不足或采样参数异常，没有可扫描的时间点")
    recognize = recognizer or _RapidOcrRecognizer(request.model_type).recognize_blocks
    extract = frame_extractor or _extract_frame
    load_image = image_loader or _open_image
    if request.frames_dir is not None:
        request.frames_dir.mkdir(parents=True, exist_ok=True)

    total = len(timestamps)
    scanned = 0
    skipped_duplicate = 0
    failed = 0
    blocks_total = 0
    blocks_recognized = 0
    sampled_through_ms: int | None = None
    last_digest: bytes | None = None
    cached_hits: list[tuple[str, float, tuple[int, int, int, int]]] = []
    cached_frame_name: str | None = None

    with tempfile.TemporaryDirectory(prefix="maw_ocr_scan_") as temporary_directory:
        # Only one task-owned extraction file exists at a time, regardless of
        # video length. Evidence is separately saved only for successful hits.
        frame_path = Path(temporary_directory) / "frame.jpg"
        for index, t_ms in enumerate(timestamps):
            sampled_through_ms = t_ms
            if on_status is not None:
                on_status("ocr_scan_frame", {"current": index + 1, "total": total})
            try:
                if not extract(request.ffmpeg_path, request.video_path, t_ms / 1000.0, frame_path):
                    failed += 1
                    last_digest = None
                    continue
                with load_image(frame_path) as image:
                    prepared = _prepare_image(request.region.crop(image))
                    digest = _pixel_fingerprint(prepared)
                    reused = digest == last_digest
                    if reused:
                        hits = cached_hits
                        frame_name = cached_frame_name
                    else:
                        hits = [
                            (str(text), float(score), (int(b1), int(b2), int(b3), int(b4)))
                            for text, score, (b1, b2, b3, b4) in recognize(prepared)
                            if str(text).strip()
                        ]
                        frame_name = _save_evidence_frame(prepared, request.frames_dir, t_ms) if hits else None
            except Exception:  # noqa: BLE001 - 单帧失败不能中断整段扫描
                failed += 1
                # Unknown frames must never seed or preserve the reuse cache.
                last_digest = None
                continue
            finally:
                frame_path.unlink(missing_ok=True)
            if reused:
                skipped_duplicate += 1
            else:
                scanned += 1
                blocks_recognized += len(hits)
                last_digest = digest
                cached_hits = hits
                cached_frame_name = frame_name
            if on_blocks is not None:
                on_blocks(t_ms, frame_name, list(hits))
            blocks_total += len(hits)

    if scanned == 0:
        raise ValueError(f"OCR 扫描失败：{total} 个采样帧均未成功识别（失败 {failed} 帧）")
    planned = _planned_frame_count(request.duration_ms, fps)
    return {
        "framesTotal": total,
        "framesScanned": scanned,
        "framesSkippedDuplicate": skipped_duplicate,
        "framesFailed": failed,
        "blocksTotal": blocks_total,
        "blocksRecognized": blocks_recognized,
        "truncated": planned > total,
        "framesPlanned": planned,
        "sampledThroughMs": sampled_through_ms,
        "durationMs": request.duration_ms,
        "fps": fps,
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

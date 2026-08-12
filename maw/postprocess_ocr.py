"""Local CPU OCR subtitle deduplication for the Launcher post-processing toolbox."""

from __future__ import annotations

import csv
import io
import re
import subprocess
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, TYPE_CHECKING

from maw.media import VIDEO_EXTENSIONS
from maw.postprocess import OutputMode
from maw.postprocess_io import (
    _atomic_write,
    read_project,
    read_srt,
    write_artifacts,
)
from maw.project_preview import JsonDict

if TYPE_CHECKING:
    from PIL import Image


OCR_OPERATION: Final = "ocr-dedup"
DEFAULT_THRESHOLD: Final = 0.5
DEFAULT_PHASH_THRESHOLD: Final = 5
MIN_OCR_DURATION_MS: Final = 300
OCR_TARGET_WIDTH: Final = 960

_NON_WORD_RE = re.compile(r"[^\u4e00-\u9fffA-Za-z0-9]")


@dataclass(frozen=True, slots=True)
class OcrRegion:
    """A normalized video region used for OCR."""

    mode: str = "full"
    x1: float = 0.0
    y1: float = 0.0
    x2: float = 1.0
    y2: float = 1.0

    def __post_init__(self) -> None:
        if self.mode not in {"full", "bottom30", "custom"}:
            raise ValueError("OCR 画面区域必须是 full、bottom30 或 custom")
        if self.mode == "bottom30":
            object.__setattr__(self, "x1", 0.0)
            object.__setattr__(self, "y1", 0.7)
            object.__setattr__(self, "x2", 1.0)
            object.__setattr__(self, "y2", 1.0)
        for value in (self.x1, self.y1, self.x2, self.y2):
            if not 0.0 <= value <= 1.0:
                raise ValueError("OCR 自定义画面区域必须在 0% 到 100% 之间")
        if self.x2 <= self.x1 or self.y2 <= self.y1:
            raise ValueError("OCR 自定义画面区域必须满足右下角大于左上角")

    def crop(self, image: "Image.Image") -> "Image.Image":
        left = max(0, min(image.width - 1, int(round(self.x1 * image.width))))
        top = max(0, min(image.height - 1, int(round(self.y1 * image.height))))
        right = max(left + 1, min(image.width, int(round(self.x2 * image.width))))
        bottom = max(top + 1, min(image.height, int(round(self.y2 * image.height))))
        return image.crop((left, top, right, bottom))


@dataclass(frozen=True, slots=True)
class OcrDedupRequest:
    project_path: Path | None
    srt_path: Path | None
    video_path: Path | None
    output_mode: OutputMode
    region: OcrRegion = OcrRegion()
    threshold: float = DEFAULT_THRESHOLD
    report: bool = False
    phash_threshold: int = DEFAULT_PHASH_THRESHOLD

    def __post_init__(self) -> None:
        if not 0.0 <= self.threshold <= 1.0:
            raise ValueError("OCR 相似度阈值必须在 0 到 1 之间")
        if self.phash_threshold < -1:
            raise ValueError("OCR pHash 阈值不能小于 -1")


@dataclass(frozen=True, slots=True)
class OcrDedupArtifact:
    source_project_path: Path | None
    source_srt_path: Path | None
    project_path: Path | None
    srt_path: Path | None
    report_path: Path | None
    warnings: tuple[str, ...] = ()
    newly_disabled_count: int = 0
    existing_disabled_count: int = 0
    processed_count: int = 0
    skipped_count: int = 0
    failed_count: int = 0


@dataclass(frozen=True, slots=True)
class MatchResult:
    jaccard: float
    containment: float
    levenshtein: float

    @property
    def maximum(self) -> float:
        return max(self.jaccard, self.containment, self.levenshtein)


OcrStatus = Callable[[str, Mapping[str, int]], None]
Recognizer = Callable[[Any], Sequence[tuple[str, float]]]
FrameExtractor = Callable[[Path, float, Path], bool]
ImageLoader = Callable[[Path], Any]


def run_ocr_dedup(
    request: OcrDedupRequest,
    *,
    ffmpeg_path: Path,
    on_status: OcrStatus | None = None,
    recognizer: Recognizer | None = None,
    frame_extractor: FrameExtractor | None = None,
    image_loader: ImageLoader | None = None,
) -> OcrDedupArtifact:
    """Detect on-screen duplicates and write the selected subtitle artifacts."""

    project, source_project, source_srt = _load_input(request.project_path, request.srt_path)
    video_path = _resolve_video_path(request.video_path, project, source_project)
    if not ffmpeg_path.is_file():
        raise ValueError(f"找不到 FFmpeg：{ffmpeg_path}")

    segments = _segments(project)
    if not segments:
        raise ValueError("工程没有可处理的字幕段")

    _notify(on_status, "toolbox_status_ocr_initializing")
    recognize = recognizer or _RapidOcrRecognizer().recognize
    extract = frame_extractor or _extract_frame
    load_image = image_loader or _open_image

    rows: list[dict[str, object]] = []
    newly_disabled = 0
    existing_disabled = sum(1 for segment in segments if segment.get("disabled") is True)
    processed = 0
    skipped = 0
    failed = 0
    cache_hits = 0
    last_phash: Any = None
    last_blocks: list[tuple[str, float]] | None = None

    with tempfile.TemporaryDirectory(prefix="maw_ocr_frames_") as temporary_directory:
        frame_directory = Path(temporary_directory)
        total = len(segments)
        for index, segment in enumerate(segments):
            _notify(on_status, "toolbox_status_ocr_frame", current=index + 1, total=total)
            if not isinstance(segment, dict):
                skipped += 1
                rows.append({"idx": index, "status": "invalid_segment"})
                continue

            text = str(segment.get("text") or "").strip()
            start = _integer_value(segment.get("start"))
            end = _integer_value(segment.get("end"))
            duration = end - start
            if segment.get("disabled") is True:
                skipped += 1
                rows.append(_report_row(index, start, end, text, status="existing_disabled"))
                continue
            if not text or duration < MIN_OCR_DURATION_MS:
                skipped += 1
                rows.append(_report_row(index, start, end, text, status="skipped"))
                continue

            frame_path = frame_directory / f"frame-{index:06d}.jpg"
            if not extract(ffmpeg_path, video_path, (start + end) / 2000.0, frame_path):
                failed += 1
                rows.append(_report_row(index, start, end, text, status="frame_failed"))
                continue

            try:
                with load_image(frame_path) as image:
                    crop = request.region.crop(image)
                    blocks, ocr_source = _recognize_with_cache(
                        crop,
                        recognize,
                        request.phash_threshold,
                        last_phash,
                        last_blocks,
                    )
                    if request.phash_threshold >= 0:
                        current_phash = _phash(crop)
                        if ocr_source == "cached":
                            cache_hits += 1
                        else:
                            last_phash = current_phash
                            last_blocks = blocks
                    ocr_text = " ".join(text_block for text_block, _ in blocks)
            except Exception as error:  # noqa: BLE001 - one bad frame must not disable a cue.
                failed += 1
                rows.append(_report_row(index, start, end, text, status="ocr_failed", error=str(error)))
                continue

            processed += 1
            match_result = match(text, ocr_text)
            similarity = match_result.maximum
            hit = similarity >= request.threshold
            if hit:
                segment["disabled"] = True
                newly_disabled += 1
            rows.append(
                _report_row(
                    index,
                    start,
                    end,
                    text,
                    status="disabled" if hit else "kept",
                    ocr_text=ocr_text,
                    match_result=match_result,
                    ocr_source=ocr_source,
                )
            )

    _notify(on_status, "toolbox_status_writing")
    artifact = write_artifacts(
        project,
        source_project_path=source_project,
        source_srt_path=source_srt,
        operation=OCR_OPERATION,
        write_project=request.output_mode in {OutputMode.JSON, OutputMode.BOTH},
        write_srt=request.output_mode in {OutputMode.SRT, OutputMode.BOTH},
    )

    report_path = _write_report(rows, source_project or source_srt) if request.report else None
    warnings = (
        f"OCR 字幕去重完成：新增禁用 {newly_disabled} 条，已有禁用 {existing_disabled} 条，"
        f"实际 OCR {processed} 条，跳过 {skipped} 条。",
    )
    if failed:
        warnings += (f"有 {failed} 条字幕抽帧或 OCR 失败，已安全保留。",)
    if cache_hits:
        warnings += (f"pHash 缓存命中 {cache_hits} 次。",)
    return OcrDedupArtifact(
        source_project_path=artifact.source_project_path,
        source_srt_path=artifact.source_srt_path,
        project_path=artifact.project_path,
        srt_path=artifact.srt_path,
        report_path=report_path,
        warnings=warnings,
        newly_disabled_count=newly_disabled,
        existing_disabled_count=existing_disabled,
        processed_count=processed,
        skipped_count=skipped,
        failed_count=failed,
    )


def normalize(text: str) -> str:
    return _NON_WORD_RE.sub("", text).lower()


def match(subtitle_text: str, ocr_text: str) -> MatchResult:
    """Use the reference project's three character-level similarity measures."""

    subtitle = normalize(subtitle_text)
    ocr = normalize(ocr_text)
    subtitle_set = set(subtitle)
    ocr_set = set(ocr)
    if not subtitle_set or not ocr_set:
        jaccard = 0.0
        containment = 0.0
    else:
        jaccard = len(subtitle_set & ocr_set) / len(subtitle_set | ocr_set)
        containment = len(subtitle_set & ocr_set) / len(subtitle_set)
    return MatchResult(
        jaccard=jaccard,
        containment=containment,
        levenshtein=_levenshtein_similarity(subtitle, ocr),
    )


def _levenshtein_similarity(left: str, right: str) -> float:
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, 1):
        old_diagonal = previous[0]
        previous[0] = left_index
        for right_index, right_char in enumerate(right, 1):
            old_value = previous[right_index]
            previous[right_index] = min(
                previous[right_index] + 1,
                previous[right_index - 1] + 1,
                old_diagonal + (0 if left_char == right_char else 1),
            )
            old_diagonal = old_value
    return 1.0 - previous[-1] / max(len(left), len(right))


def _load_input(
    project_path: Path | None,
    srt_path: Path | None,
) -> tuple[JsonDict, Path | None, Path | None]:
    if project_path is not None:
        resolved = project_path.expanduser().resolve()
        return read_project(resolved), resolved, None
    if srt_path is not None:
        resolved = srt_path.expanduser().resolve()
        return read_srt(resolved), None, resolved
    raise ValueError("需要一个工程或 SRT 输入")


def _segments(project: JsonDict) -> list[dict[str, object]]:
    raw_segments = project.get("segments")
    if not isinstance(raw_segments, list):
        raise ValueError("工程 segments 必须是数组")
    segments: list[dict[str, object]] = []
    for segment in raw_segments:
        if not isinstance(segment, dict):
            raise ValueError("工程字幕段必须是对象")
        segments.append(segment)
    return segments


def _integer_value(value: object) -> int:
    if type(value) is not int:
        raise ValueError("字幕时间必须是整数毫秒")
    return value


def _resolve_video_path(
    explicit_path: Path | None,
    project: JsonDict,
    source_project: Path | None,
) -> Path:
    if explicit_path is not None and str(explicit_path).strip():
        return _validate_video_path(explicit_path, "选择的视频")
    if source_project is not None:
        raw_media = project.get("media")
        if isinstance(raw_media, str) and raw_media.strip():
            candidate = Path(raw_media.strip()).expanduser()
            if not candidate.is_absolute():
                candidate = source_project.parent / candidate
            return _validate_video_path(candidate, "工程关联媒体")
    raise ValueError("OCR 字幕去重需要一个视频画面；请在工具中选择视频文件")


def _validate_video_path(path: Path, label: str) -> Path:
    resolved = path.expanduser().resolve()
    if resolved.suffix.lower() not in VIDEO_EXTENSIONS:
        raise ValueError(f"{label}必须是视频文件，不能使用音频文件")
    if not resolved.is_file():
        raise ValueError(f"找不到{label}：{resolved}")
    return resolved


def _notify(on_status: OcrStatus | None, key: str, **details: int) -> None:
    if on_status is not None:
        on_status(key, details)


def _recognize_with_cache(
    crop: Any,
    recognizer: Recognizer,
    phash_threshold: int,
    last_phash: Any,
    last_blocks: list[tuple[str, float]] | None,
) -> tuple[list[tuple[str, float]], str]:
    if phash_threshold >= 0 and last_phash is not None and last_blocks is not None:
        current_phash = _phash(crop)
        if current_phash - last_phash <= phash_threshold:
            return last_blocks, "cached"
    blocks = [(str(text), float(score)) for text, score in recognizer(_prepare_image(crop)) if str(text).strip()]
    return blocks, "fresh"


def _prepare_image(image: Any) -> Any:
    """Resize by width without distorting a full-frame crop."""

    image = image.convert("RGB")
    if image.width == OCR_TARGET_WIDTH:
        return image
    target_height = max(1, round(image.height * OCR_TARGET_WIDTH / image.width))
    return image.resize((OCR_TARGET_WIDTH, target_height))


def _phash(image: Any) -> Any:
    import imagehash

    return imagehash.phash(image)


def _open_image(path: Path) -> Any:
    from PIL import Image

    return Image.open(path)


def _extract_frame(ffmpeg_path: Path, video_path: Path, timestamp: float, output_path: Path) -> bool:
    try:
        result = subprocess.run(
            [
                str(ffmpeg_path),
                "-y",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{timestamp:.3f}",
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                str(output_path),
            ],
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and output_path.is_file()


class _RapidOcrRecognizer:
    def __init__(self) -> None:
        try:
            from rapidocr import ModelType, OCRVersion, RapidOCR
        except ImportError as error:
            raise RuntimeError("OCR 依赖未安装，请先运行 uv sync") from error

        self._ocr = RapidOCR(
            params={
                "Det.ocr_version": OCRVersion.PPOCRV6,
                "Det.model_type": ModelType.TINY,
                "Det.limit_side_len": OCR_TARGET_WIDTH,
                "Det.limit_type": "max",
                "Rec.ocr_version": OCRVersion.PPOCRV6,
                "Rec.model_type": ModelType.TINY,
            }
        )

    def recognize(self, image: Any) -> list[tuple[str, float]]:
        import numpy as np

        result = self._ocr(np.asarray(image), use_cls=False)
        texts = getattr(result, "txts", None) or ()
        scores = getattr(result, "scores", None) or ()
        return [(str(text), float(score)) for text, score in zip(texts, scores)]


def _report_row(
    index: int,
    start: int,
    end: int,
    text: str,
    *,
    status: str,
    ocr_text: str = "",
    match_result: MatchResult | None = None,
    ocr_source: str = "",
    error: str = "",
) -> dict[str, object]:
    return {
        "idx": index,
        "start_ms": start,
        "end_ms": end,
        "duration_ms": end - start,
        "status": status,
        "sim_jac": round(match_result.jaccard, 4) if match_result else "",
        "sim_cont": round(match_result.containment, 4) if match_result else "",
        "sim_lev": round(match_result.levenshtein, 4) if match_result else "",
        "sim_max": round(match_result.maximum, 4) if match_result else "",
        "ocr_source": ocr_source,
        "subtitle": text,
        "ocr_text": ocr_text,
        "error": error,
    }


def _write_report(rows: Sequence[Mapping[str, object]], source: Path | None) -> Path:
    if source is None:
        raise ValueError("生成 OCR 报告需要一个输入文件")
    report_path = _available_report_path(source)
    output = io.StringIO(newline="")
    fieldnames = (
        "idx",
        "start_ms",
        "end_ms",
        "duration_ms",
        "status",
        "sim_jac",
        "sim_cont",
        "sim_lev",
        "sim_max",
        "ocr_source",
        "subtitle",
        "ocr_text",
        "error",
    )
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    # UTF-8 BOM lets Excel recognize the encoding when the CSV is opened directly.
    _atomic_write(report_path, "\ufeff" + output.getvalue())
    return report_path


def _available_report_path(source: Path) -> Path:
    candidate = source.with_name(f"{source.stem}.{OCR_OPERATION}.csv")
    counter = 2
    while candidate.exists():
        candidate = source.with_name(f"{source.stem}.{OCR_OPERATION}-{counter}.csv")
        counter += 1
    return candidate.resolve()

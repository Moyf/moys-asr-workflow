"""term-extract CLI：视频 → OCR → 聚合评分 → AI 筛选 → HTML 确认页。

用法见 README；规格见 SPEC。测试可通过 provider / duration_prober 注入假件。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
import tempfile
from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path
from threading import Event
from uuid import uuid4

from maw.asr.common import get_duration_sec
from maw.ffmpeg import resolve_ffmpeg_tool
from maw.postprocess_ocr import OcrRegion
from maw.postprocess_llm import LlmSettings, _sanitize_error_text
from maw.ocr_runtime import OcrRuntimeCancelled

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
CACHE_VERSION = 3
PUBLICATION_MARKER = ".term-publication.json"

DurationProber = Callable[[Path], int]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="term-extract",
        description="从视频画面提取游戏术语候选，生成热词确认页（独立工具，规格见 SPEC.md）",
    )
    parser.add_argument("video", help="输入视频路径")
    parser.add_argument("--fps", type=float, default=None, help="采样密度（0.2–2.0，默认 1），resume 沿用缓存")
    parser.add_argument("--model", choices=("tiny", "small"), default=None, help="PP-OCRv6 模型档位（默认 tiny），resume 沿用缓存")
    parser.add_argument(
        "--region",
        nargs="+",
        metavar=("MODE", "X1"),
        default=None,
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
    parser.add_argument("--max-frames", type=int, default=None, help="采样帧数安全上限（正整数，默认 20000）")
    parser.add_argument("--llm-preset", default="", help=f"LLM 预设：{'/'.join(ai_filter.available_presets())}")
    parser.add_argument("--llm-base-url", default="", help="自定义 LLM base_url（覆盖预设）")
    parser.add_argument("--llm-model", default="", help="自定义 LLM 模型（覆盖预设）")
    parser.add_argument("--llm-api-key", default="", help="API Key（默认读环境变量 MAW_TERMS_LLM_API_KEY）")
    return parser


def parse_region(values: list[str]) -> OcrRegion:
    if not values:
        raise ValueError("--region 需要区域模式")
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
    cancel_event: Event | None = None,
) -> int:
    try:
        return _run_pipeline(args, scan_provider=scan_provider, duration_prober=duration_prober, cancel_event=cancel_event)
    except (KeyboardInterrupt, OcrRuntimeCancelled):
        print("\n[中断] 操作已取消；未完成的扫描不支持 resume，请重新扫描。", file=sys.stderr)
        return 130
    except Exception as error:  # noqa: BLE001 - CLI 失败以友好诊断返回非零码
        print(f"[错误] {_safe_error(error)}", file=sys.stderr)
        return 1


def _run_pipeline(
    args: argparse.Namespace,
    *,
    scan_provider: provider.RuntimeScanProvider | provider.LocalScanProvider | None,
    duration_prober: DurationProber | None,
    cancel_event: Event | None,
) -> int:
    video = Path(args.video).expanduser().resolve()
    if not video.is_file():
        print(f"[错误] 找不到视频：{video.name}", file=sys.stderr)
        return 1
    out_dir = Path(args.out).expanduser().resolve() if args.out else default_output_dir(video)
    out_dir.mkdir(parents=True, exist_ok=True)
    _recover_publication(out_dir)
    stage = tempfile.TemporaryDirectory(prefix=".term-staging-", dir=out_dir)
    try:
        return _run_staged_pipeline(
            args, video=video, out_dir=out_dir, stage_dir=Path(stage.name),
            scan_provider=scan_provider, duration_prober=duration_prober, cancel_event=cancel_event,
        )
    finally:
        if (out_dir / PUBLICATION_MARKER).exists():
            # 恢复本身失败时保留恢复所需备份；不可被临时目录析构吞掉。
            stage._finalizer.detach()
        else:
            stage.cleanup()


def _run_staged_pipeline(
    args: argparse.Namespace, *, video: Path, out_dir: Path, stage_dir: Path,
    scan_provider: provider.RuntimeScanProvider | provider.LocalScanProvider | None,
    duration_prober: DurationProber | None, cancel_event: Event | None,
) -> int:
    fps = _valid_fps(args.fps if args.fps is not None else 1.0)
    model = args.model or "tiny"
    region = parse_region(list(args.region or ["full"]))
    max_frames = _positive_int(args.max_frames if args.max_frames is not None else 20000, "max_frames")
    source = _source_identity(video)

    frames_base = f"{FRAMES_DIRNAME}/run-{uuid4().hex}"
    frames_dir = stage_dir / FRAMES_DIRNAME
    frames_dir.mkdir()
    fresh_scan = not (args.resume and (out_dir / OCR_JSON).is_file())

    ocr_json_path = out_dir / OCR_JSON
    if args.resume and ocr_json_path.is_file():
        ocr_payload = _load_json(ocr_json_path)
        duration_ms, fps, model, region, max_frames, scan_summary, blocks = _validated_cache(ocr_payload, source, args)
        frames_base = _valid_frames_directory(ocr_payload.get("framesDirectory"))
        frames_dir = out_dir / frames_base
        print(f"[resume] 复用已验证缓存：fps={fps}，模型 {model}，区域 {region.mode}，max_frames={max_frames}")
        (out_dir / export.HOTWORDS_FILENAME).write_text("", encoding="utf-8", newline="\n")
    else:
        if args.resume:
            print("[resume] 没有 ocr.json，改为完整扫描。")
        duration_ms = _positive_int((duration_prober or probe_duration_ms)(video), "durationMs")
        (out_dir / export.HOTWORDS_FILENAME).write_text("", encoding="utf-8", newline="\n")
        print(f"[scan] {video.name} 时长 {duration_ms / 1000:.1f}s，fps={fps}，模式 {args.ocr}/{model}")
        active_provider = scan_provider or provider.make_provider(args.ocr)

        def on_scan_status(key: str, details: Mapping[str, int]) -> None:
            current = details.get("current")
            total = details.get("total")
            if current is not None and total and (current % 30 == 0 or current == total):
                print(f"[scan] {current}/{total} 帧")

        payload = active_provider.scan(
            video,
            duration_ms=duration_ms,
            fps=fps,
            region=region,
            model=model,
            frames_dir=frames_dir,
            max_frames=max_frames,
            on_status=on_scan_status,
            cancel_event=cancel_event,
        )
        blocks = _validated_blocks(payload.get("blocks"), duration_ms)
        scan_summary = {
            key: value for key, value in payload.items() if key != "blocks"
        }
        _validate_scan_summary(scan_summary, blocks, duration_ms=duration_ms, fps=fps, max_frames=max_frames)
        if _source_identity(video) != source:
            raise ValueError("扫描期间源视频已变更，请重新扫描")
        _write_json(
            stage_dir / OCR_JSON,
            {
                "video": video.name,
                "cacheVersion": CACHE_VERSION,
                "source": source,
                "durationMs": duration_ms,
                "fps": fps,
                "model": model,
                "region": _region_payload(region),
                "maxFrames": max_frames,
                "framesDirectory": frames_base,
                "scan": scan_summary,
                "blocks": blocks,
            },
        )
    print(
        f"[scan] 完成：识别块 {len(blocks)} 个"
        + (f"，跳过静止帧 {scan_summary.get('framesSkippedDuplicate', '?')} 个" if scan_summary else "")
    )
    if scan_summary.get("framesFailed"):
        print(f"[警告] {scan_summary['framesFailed']} 帧扫描失败，候选仅覆盖成功采样部分。", file=sys.stderr)
    if scan_summary.get("truncated"):
        print(f"[警告] 帧数上限截断扫描：{scan_summary.get('framesTotal', '?')} / {scan_summary.get('framesPlanned', '?')} 帧，采样至 {scan_summary.get('sampledThroughMs', '?')}ms。", file=sys.stderr)

    print("[aggregate] 聚合显示事件与候选…")
    candidates = aggregate.extract_candidates(blocks, fps)
    ignore_words = score.load_ignore_words(out_dir / score.IGNORE_EXTRA_FILENAME)
    scored = score.apply_scoring(candidates, min_score=args.min_score, ignore_words=ignore_words)
    for candidate in scored:
        issue = export.hotword_issue(str(candidate["word"]))
        candidate["export"] = {"ok": issue is None, "reason": issue}
    print(f"[aggregate] 候选 {len(scored)} 个，推荐 {sum(1 for c in scored if c['recommended'])} 个")

    ai_enabled = not args.no_ai
    ai_model: str | None = None
    for candidate in scored:
        candidate["ai"] = None
        candidate["ruleRecommended"] = bool(candidate["recommended"])

    def save_report(ai_status: str, enabled: bool, *, hotwords_text: str = "") -> Path:
        report_payload = report.build_report(
            video_name=video.name, fps=fps, model=model, duration_ms=duration_ms,
            min_score=args.min_score, scan_summary=scan_summary, candidates=scored,
            ai_enabled=enabled, ai_model=ai_model, ai_status=ai_status,
            weight_by_score=args.weight_by_score, region=_region_payload(region), frames_dir=frames_dir,
            frames_base_dir=frames_base,
        )
        report.write_candidates_json(stage_dir / report.CANDIDATES_FILENAME, report_payload)
        report.write_report_csv(stage_dir / report.REPORT_CSV_FILENAME, scored)
        report.write_report_html(stage_dir / report.REPORT_HTML_FILENAME, report_payload)
        (stage_dir / export.HOTWORDS_FILENAME).write_text(hotwords_text, encoding="utf-8", newline="\n")
        if _source_identity(video) != source:
            raise ValueError("生成产物期间源视频已变更，请重新扫描")
        if fresh_scan and (stage_dir / OCR_JSON).is_file():
            # 不覆盖任何已有证据；旧报告与新报告各自引用不可变的帧目录。
            destination = out_dir / frames_base
            destination.parent.mkdir(exist_ok=True)
            os.replace(frames_dir, destination)
            frames_dir_for_publish = destination
        else:
            frames_dir_for_publish = frames_dir
        names = [report.CANDIDATES_FILENAME, report.REPORT_CSV_FILENAME, report.REPORT_HTML_FILENAME, export.HOTWORDS_FILENAME]
        if (stage_dir / OCR_JSON).is_file():
            names.append(OCR_JSON)
        _publish_artifacts(out_dir, stage_dir, names)
        return frames_dir_for_publish

    # AI 请求前持久化本轮规则证据，不让旧推荐/热词伪装成本轮成功结果。
    frames_dir = save_report("pending" if ai_enabled else "disabled", False)
    if ai_enabled:
        settings = None
        try:
            settings = ai_filter.build_settings(
                preset_id=args.llm_preset or None,
                base_url=args.llm_base_url or None,
                model=args.llm_model or None,
                api_key=args.llm_api_key or None,
            )
            ai_model = settings.model
            print(f"[ai] 语义筛选（{settings.provider_id}/{settings.model}）…")
            verdicts = ai_filter.filter_candidates(scored, settings)
            if set(verdicts) != {str(c["word"]) for c in scored} or any(
                not isinstance(v, Mapping) or v.get("verdict") not in {"keep", "reject"} for v in verdicts.values()
            ):
                raise ai_filter.TermAiFilterError("AI 判定缺失或无效")
        except KeyboardInterrupt:
            save_report("cancelled", False)
            print("\n[中断] AI 筛选已取消。", file=sys.stderr)
            return 130
        except Exception as error:  # noqa: BLE001 - 失败必须落盘并显式退出
            save_report("failed", False)
            record = out_dir / "ai-failure-record.md"
            record.write_text(
                f"# AI 筛选失败记录\n\n- 时间：{datetime.now().isoformat(timespec='seconds')}\n"
                f"- 候选数：{len(scored)}\n- 错误：{_safe_error(error, settings=settings)}\n\n"
                f"已完成的 candidates.json 仅含规则评分，推荐项未经语义筛选，请勿直接全量导出。\n",
                encoding="utf-8",
                newline="\n",
            )
            print(f"[错误] AI 筛选失败，详见产物目录中的 {record.name}", file=sys.stderr)
            return 2
        for candidate in scored:
            verdict = verdicts.get(str(candidate["word"]))
            candidate["ai"] = verdict
            candidate["recommended"] = bool(candidate["ruleRecommended"] and verdict and verdict["verdict"] == "keep")
        kept = sum(1 for c in scored if (c.get("ai") or {}).get("verdict") == "keep")
        print(f"[ai] 完成：保留 {kept}，排除 {len(scored) - kept}")
    else:
        for candidate in scored:
            candidate["ai"] = None
        print("[ai] 已按 --no-ai 跳过：推荐项仅来自规则评分，未经语义筛选！")

    hotwords_text, rejected = export.build_hotwords(
        [c for c in scored if c["recommended"]], weight_by_score=args.weight_by_score
    )
    save_report("complete" if ai_enabled else "disabled", ai_enabled, hotwords_text=hotwords_text)
    print(f"[done] 产物目录：{out_dir}")
    print(f"[done] 确认页：{out_dir / report.REPORT_HTML_FILENAME}（浏览器打开，勾选后在右侧导出栏导出）")
    if rejected:
        print(f"[警告] {len(rejected)} 个推荐词未导出（词项或 2000 个数量上限）：{', '.join(item['word'] for item in rejected[:5])}", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return run_pipeline(args)


def _write_json(path: Path, payload: Mapping[str, object]) -> None:
    text = json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n"
    temporary = path.with_name(f".{path.name}-{uuid4().hex}.tmp")
    try:
        temporary.write_text(text, encoding="utf-8", newline="\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _load_json(path: Path) -> object:
    def invalid_constant(value: str) -> None:
        raise ValueError(f"JSON 不允许非有限数值 {value}")

    payload = json.loads(path.read_text(encoding="utf-8"), parse_constant=invalid_constant)
    # 1e999 也会被 Python 解为 inf；拒绝任意深度的非有限数字。
    json.dumps(payload, allow_nan=False)
    return payload


def _publish_artifacts(out_dir: Path, stage_dir: Path, names: list[str]) -> None:
    """逐文件原子替换 + 持久恢复记录；证据目录永不覆盖。

    中断/写入失败回滚原有文件；进程硬退出留下 marker，下一次 CLI 在读 cache
    前恢复。普通文件系统没有跨多个文件的原子替换，因此不宣称全套瞬时原子。
    """

    backups = stage_dir / "backups"
    backups.mkdir(exist_ok=True)
    existed: dict[str, bool] = {}
    for name in names:
        target = out_dir / name
        existed[name] = target.is_file()
        if target.exists() and not target.is_file():
            raise ValueError(f"产物 {name} 不是普通文件，拒绝覆盖")
        if existed[name]:
            shutil.copyfile(target, backups / name)
    marker = out_dir / PUBLICATION_MARKER
    journal = {"stage": stage_dir.name, "files": existed, "committed": False}
    _write_json(marker, journal)
    try:
        for name in names:
            os.replace(stage_dir / name, out_dir / name)
        _write_json(marker, {**journal, "committed": True})
    except BaseException:
        _recover_publication(out_dir)
        raise
    marker.unlink()


def _recover_publication(out_dir: Path) -> None:
    marker = out_dir / PUBLICATION_MARKER
    if not marker.is_file():
        return
    journal = _load_json(marker)
    allowed = {OCR_JSON, report.CANDIDATES_FILENAME, report.REPORT_CSV_FILENAME, report.REPORT_HTML_FILENAME, export.HOTWORDS_FILENAME}
    if not isinstance(journal, dict) or not isinstance(journal.get("stage"), str) or not re.fullmatch(r"\.term-staging-[\w-]+", journal["stage"]):
        raise ValueError("产物发布恢复记录无效，拒绝自动恢复")
    files = journal.get("files")
    if not isinstance(files, dict) or not files or not set(files) <= allowed or any(not isinstance(v, bool) for v in files.values()) or not isinstance(journal.get("committed"), bool):
        raise ValueError("产物发布恢复记录字段无效，拒绝自动恢复")
    if not journal["committed"]:
        backups = out_dir / journal["stage"] / "backups"
        if any(existed and not (backups / name).is_file() for name, existed in files.items()):
            raise ValueError("产物发布备份不完整，拒绝复用混合缓存，请重新扫描")
        for name, existed in files.items():
            if existed:
                # copy 后原子替换，恢复本身即使再次中断也可重复执行。
                restored = backups / f"restore-{name}"
                shutil.copyfile(backups / name, restored)
                os.replace(restored, out_dir / name)
            else:
                (out_dir / name).unlink(missing_ok=True)
    marker.unlink()


def _positive_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field} 必须是正整数")
    return value


def _valid_fps(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0.2 <= value <= 2.0:
        raise ValueError("fps 必须在 0.2 到 2.0 之间")
    return float(value)


def _source_identity(video: Path) -> dict[str, object]:
    stat = video.stat()
    return {"name": video.name, "size": stat.st_size, "mtimeNs": stat.st_mtime_ns}


def _region_payload(region: OcrRegion) -> dict[str, object]:
    return {"mode": region.mode, "x1": region.x1, "y1": region.y1, "x2": region.x2, "y2": region.y2}


def _validated_blocks(value: object, duration_ms: int) -> list[dict[str, object]]:
    if not isinstance(value, list):
        raise ValueError("扫描缓存 blocks 必须是数组，请重新扫描")
    for block in value:
        if not isinstance(block, dict) or not isinstance(block.get("text"), str):
            raise ValueError("扫描缓存中存在无效文字块，请重新扫描")
        t_ms = block.get("tMs")
        if isinstance(t_ms, bool) or not isinstance(t_ms, int) or not 0 <= t_ms < duration_ms:
            raise ValueError("扫描缓存 tMs 必须为视频时长内的整数毫秒，请重新扫描")
        confidence = block.get("score")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise ValueError("扫描缓存 score 必须在 0 到 1 之间，请重新扫描")
        box = block.get("box")
        if not isinstance(box, list) or len(box) != 4 or any(
            isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in box
        ):
            raise ValueError("扫描缓存 box 必须是四个有限数值，请重新扫描")
        frame = block.get("frame")
        if frame is not None and (not isinstance(frame, str) or not re.fullmatch(r"frame-\d+\.jpg", frame)):
            raise ValueError("扫描缓存 frame 必须是本地证据帧文件名，请重新扫描")
    return value


def _validate_scan_summary(
    summary: Mapping[str, object], blocks: list[dict[str, object]], *, duration_ms: int, fps: float, max_frames: int,
) -> None:
    json.dumps(summary, allow_nan=False)
    for field in ("framesTotal", "framesScanned", "framesFailed", "framesSkippedDuplicate", "framesPlanned", "blocksTotal", "blocksRecognized", "sampledThroughMs", "durationMs"):
        value = summary.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"扫描缓存 {field} 必须为非负整数且不可缺失")
    if summary["framesScanned"] <= 0:
        raise ValueError("OCR 扫描没有成功识别任何帧，请检查扫描错误后重新扫描")
    if not isinstance(summary.get("truncated"), bool):
        raise ValueError("扫描缓存 truncated 必须为布尔值")
    if _valid_fps(summary.get("fps")) != fps or summary["durationMs"] != duration_ms:
        raise ValueError("OCR 扫描汇总与外层 fps/durationMs 不一致")
    total = summary["framesTotal"]
    planned = summary["framesPlanned"]
    step_ms = 1000.0 / fps
    expected_planned = max(0, math.ceil(duration_ms / step_ms))
    while expected_planned and int(round((expected_planned - 1) * step_ms)) >= duration_ms:
        expected_planned -= 1
    while int(round(expected_planned * step_ms)) < duration_ms:
        expected_planned += 1
    if total != summary["framesScanned"] + summary["framesSkippedDuplicate"] + summary["framesFailed"]:
        raise ValueError("OCR 帧计数不一致：total 必须等于 scanned + reused + failed")
    if planned != expected_planned or total != min(planned, max_frames) or summary["truncated"] != (planned > total):
        raise ValueError("OCR 采样计划或截断标记与时长/fps/maxFrames 不一致")
    sampled = summary["sampledThroughMs"]
    if not 0 <= sampled < duration_ms or sampled != int(round((total - 1) * step_ms)):
        raise ValueError("OCR sampledThroughMs 不是本轮最后采样时间点")
    if any(block["tMs"] > sampled for block in blocks):
        raise ValueError("OCR 识别块晚于最后采样时间点")
    if summary["blocksTotal"] != len(blocks) or summary["blocksRecognized"] > len(blocks):
        raise ValueError("OCR 文字块计数与实际输出不一致")
    if summary["framesSkippedDuplicate"] == 0 and summary["blocksRecognized"] != len(blocks):
        raise ValueError("OCR 无复用帧时 recognized 必须等于 emitted blocks")


def _valid_frames_directory(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"frames/run-[0-9a-f]{32}", value):
        raise ValueError("OCR 缓存缺少安全的独立证据目录，请重新扫描")
    return value


def _validated_cache(
    payload: object, source: Mapping[str, object], args: argparse.Namespace,
) -> tuple[int, float, str, OcrRegion, int, dict[str, object], list[dict[str, object]]]:
    if not isinstance(payload, dict):
        raise ValueError("ocr.json 必须是对象，请重新扫描")
    json.dumps(payload, allow_nan=False)
    if payload.get("cacheVersion") != CACHE_VERSION or not isinstance(payload.get("source"), dict) or not isinstance(payload.get("region"), dict):
        raise ValueError("旧版 OCR 缓存缺少当前 source/region/独立证据目录契约；请去掉 --resume 重新扫描")
    stored_source = payload["source"]
    if set(stored_source) != {"name", "size", "mtimeNs"} or not isinstance(stored_source["name"], str) or any(
        isinstance(stored_source[k], bool) or not isinstance(stored_source[k], int) or stored_source[k] < 0 for k in ("size", "mtimeNs")
    ):
        raise ValueError("OCR 缓存 source 元数据无效，请重新扫描")
    if payload["source"] != source or payload.get("video") != source["name"]:
        raise ValueError("OCR 缓存与源视频身份不匹配（文件名、大小或修改时间不同）；请重新扫描")
    duration_ms = _positive_int(payload.get("durationMs"), "缓存 durationMs")
    fps = _valid_fps(payload.get("fps"))
    model = payload.get("model")
    if model not in {"tiny", "small"}:
        raise ValueError("OCR 缓存 model 无效，请重新扫描")
    stored_region = payload["region"]
    if set(stored_region) != {"mode", "x1", "y1", "x2", "y2"} or any(
        isinstance(stored_region[k], bool) or not isinstance(stored_region[k], (int, float)) for k in ("x1", "y1", "x2", "y2")
    ):
        raise ValueError("OCR 缓存 region 元数据不完整，请重新扫描")
    region = OcrRegion(**stored_region)
    if _region_payload(region) != stored_region or (region.mode == "full" and region != OcrRegion()):
        raise ValueError("OCR 缓存 region 不是规范坐标，请重新扫描")
    max_frames = _positive_int(payload.get("maxFrames"), "缓存 maxFrames")
    explicit = {
        "fps": (args.fps, fps), "model": (args.model, model),
        "region": (_region_payload(parse_region(args.region)) if args.region is not None else None, stored_region),
        "max-frames": (args.max_frames, max_frames),
    }
    for field, (requested, stored) in explicit.items():
        if requested is not None and requested != stored:
            raise ValueError(f"--resume 的 --{field} 与缓存冲突；复用不会重新扫描，请去掉 --resume 重跑")
    summary = payload.get("scan")
    if not isinstance(summary, dict):
        raise ValueError("OCR 缓存 scan 必须是对象，请重新扫描")
    blocks = _validated_blocks(payload.get("blocks"), duration_ms)
    _validate_scan_summary(summary, blocks, duration_ms=duration_ms, fps=fps, max_frames=max_frames)
    _valid_frames_directory(payload.get("framesDirectory"))
    return duration_ms, fps, model, region, max_frames, summary, blocks


def _safe_error(error: object, *, settings: LlmSettings | None = None) -> str:
    text = _sanitize_error_text(error, settings=settings)
    # LLM 隐私过滤之后额外隐藏本机路径；失败记录不保存原始异常/凭据。
    text = re.sub(r"[A-Za-z]:[\\/][^\r\n'\"<>]*", "[本机路径]", text)
    text = re.sub(r"(?<![\w:])/(?:[^\s/]+/)+[^\s'\"<>]*", "[本机路径]", text)
    return text[:1000]


if __name__ == "__main__":
    raise SystemExit(main())

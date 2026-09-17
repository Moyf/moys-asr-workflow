"""Small helper executed by the user-managed local ASR Python environment."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

# When Python executes a file by path, sys.path starts with the file's
# directory (the bundled ``maw`` package), not the directory containing it.
# Add that package root so this helper works in both source and packaged
# ``local-runtime`` layouts.
_BUNDLE_ROOT = Path(__file__).resolve().parents[1]
if str(_BUNDLE_ROOT) not in sys.path:
    sys.path.insert(0, str(_BUNDLE_ROOT))

from maw.console import configure_utf8_stdio  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MAW local runtime helper")
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--engine", required=True)
    prepare.add_argument("--model", required=True)
    prepare.add_argument("--model-path", default="")
    prepare.add_argument("--device", default="auto")
    prepare.add_argument("--forced-aligner", default="")
    prepare.add_argument("--vad-model", default="")
    prepare.add_argument("--punc-model", default="")
    prepare.add_argument("--speaker-model", default="")
    prepare.add_argument("--trust-remote-code", action="store_true")
    prepare_aligner = subparsers.add_parser("prepare-aligner")
    prepare_aligner.add_argument("--model-id", required=True)
    prepare_aligner.add_argument("--model-path", default="")
    prepare_punc = subparsers.add_parser("prepare-punc")
    prepare_punc.add_argument("--model-path", default="")
    punctuate = subparsers.add_parser("punctuate")
    punctuate.add_argument("--model-path", default="")
    punctuate.add_argument("--input", required=True)
    punctuate.add_argument("--device", default="auto")
    timestamp_align = subparsers.add_parser("timestamp-align")
    timestamp_align.add_argument("--project-path", default="")
    timestamp_align.add_argument("--srt-path", default="")
    timestamp_align.add_argument("--media-path", default="")
    timestamp_align.add_argument("--model-id", required=True)
    timestamp_align.add_argument("--output-mode", default="both")
    timestamp_align.add_argument("--alignment-mode", default="fill")
    timestamp_align.add_argument("--model-path", default="")
    timestamp_align.add_argument("--output-directory", default="")
    timestamp_align.add_argument("--device", default="auto")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    configure_utf8_stdio()
    args = build_parser().parse_args(argv)
    if args.command == "prepare-aligner":
        from maw.alignment_models import prepare_alignment_model

        prepare_alignment_model(
            args.model_id,
            model_path=args.model_path,
            on_event=print,
        )
        print("[local] 对齐模型组件准备完成。")
        return 0
    if args.command == "prepare-punc":
        try:
            import torch  # type: ignore[import-not-found]
            from funasr import AutoModel  # type: ignore[import-not-found]

            device = "cuda" if torch.cuda.is_available() else "cpu"
            model_source = args.model_path or "ct-punc"
            AutoModel(model=model_source, device=device, disable_update=True)
            print("[local] FunASR ct-punc 模型组件准备完成。")
            return 0
        except Exception as error:  # noqa: BLE001 - worker boundary
            print(json.dumps({
                "type": "error",
                "detail": f"FunASR ct-punc 模型准备失败：{error}",
            }, ensure_ascii=False))
            return 1
    if args.command == "punctuate":
        try:
            import torch  # type: ignore[import-not-found]
            from funasr import AutoModel  # type: ignore[import-not-found]

            device = str(args.device or "auto").strip().casefold()
            if device not in {"", "auto", "cpu", "cuda"}:
                raise RuntimeError("ct-punc 设备必须是 auto、cpu 或 cuda。")
            use_gpu = device == "cuda" or (device in {"", "auto"} and bool(torch.cuda.is_available()))
            if use_gpu and not torch.cuda.is_available():
                if device == "cuda":
                    raise RuntimeError("当前 Torch 没有可用的 CUDA，ct-punc 请改用 CPU。")
                use_gpu = False
            payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
            text = payload.get("text") if isinstance(payload, dict) else payload
            text = str(text or "")
            if not text.strip():
                print(json.dumps({"type": "result", "text": ""}, ensure_ascii=False))
                return 0
            model_source = args.model_path or "ct-punc"
            punc = AutoModel(
                model=model_source,
                device="cuda" if use_gpu else "cpu",
                disable_update=True,
            )
            result = punc.generate(input=text)
            first = result[0] if isinstance(result, list) and result else result
            punctuated = first.get("text") if isinstance(first, dict) else None
            if not isinstance(punctuated, str):
                raise RuntimeError("ct-punc 没有返回 text 字段。")
            print(json.dumps({"type": "result", "text": punctuated}, ensure_ascii=False))
            return 0
        except Exception as error:  # noqa: BLE001 - worker boundary must return a readable error
            print(json.dumps({"type": "error", "detail": f"FunASR ct-punc 加载或推理失败：{error}"}, ensure_ascii=False))
            return 1
    if args.command == "timestamp-align":
        from maw.alignment_models import resolve_model_cache_root
        from maw.timestamp_alignment import TimestampAlignmentRequest, run_timestamp_alignment

        artifact, report = run_timestamp_alignment(
            TimestampAlignmentRequest(
                project_path=Path(args.project_path) if args.project_path else None,
                srt_path=Path(args.srt_path) if args.srt_path else None,
                media_path=Path(args.media_path) if args.media_path else None,
                model_id=args.model_id,
                output_mode=args.output_mode,
                mode=args.alignment_mode,
                model_path=Path(args.model_path) if args.model_path else None,
                model_cache_root=resolve_model_cache_root(),
                device=args.device,
                output_directory=Path(args.output_directory) if args.output_directory else None,
            )
        )
        print(json.dumps({
            "type": "result",
            "artifact": {
                "sourceProjectPath": str(artifact.source_project_path or ""),
                "sourceSrtPath": str(artifact.source_srt_path or ""),
                "projectPath": str(artifact.project_path or ""),
                "srtPath": str(artifact.srt_path or ""),
                "translatedSrtPath": str(artifact.translated_srt_path or ""),
                "warnings": list(artifact.warnings),
            },
            "report": report.to_payload(),
        }, ensure_ascii=False))
        return 0
    if args.command != "prepare":
        return 2
    from maw.local_asr import create_local_engine

    engine = create_local_engine(
        args.engine,
        model=args.model,
        model_path=args.model_path or None,
        device=args.device,
        forced_aligner=args.forced_aligner or None,
        vad_model=args.vad_model or None,
        punc_model=args.punc_model or None,
        speaker_model=args.speaker_model or None,
        trust_remote_code=args.trust_remote_code,
    )
    loader = getattr(engine, "_load", None)
    if not callable(loader):
        raise RuntimeError("本地模型运行时不支持预加载")
    loader(print)
    print("[local] 模型组件准备完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

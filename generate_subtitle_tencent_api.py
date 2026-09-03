"""使用腾讯云录音文件识别 API 生成 SRT 与 MAW 工程。"""

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

from maw.stickers import get_default_sticker_dir
from generate_subtitle_qwen_api import (
    configure_console_output,
    extract_audio,
    generate_srt,
    get_duration_sec,
    parse_duration,
)
from maw.media_cache import embed_media_caches, merge_media_caches
from maw.ffmpeg import resolve_ffmpeg_tools
from maw.project import repair_segment_durations, validate_project
from maw.speaker import apply_speaker_colors
from maw.tencent import DEFAULT_ENGINE, load_config, transcribe


def main() -> int:
    parser = argparse.ArgumentParser(description="使用腾讯云录音文件识别 API 生成视频字幕")
    parser.add_argument("input", help="输入视频或音频文件路径")
    parser.add_argument("-o", "--output", help="输出 SRT 路径")
    parser.add_argument("-l", "--max-len", type=int, default=18, help="每条字幕最大字数（默认 18）")
    parser.add_argument("--min-len", type=int, default=5, help="句号间最短字数")
    parser.add_argument("--language", help="保留参数；腾讯云录音文件识别由引擎自动识别")
    parser.add_argument("--keep-punct", action="store_true", help="保留字幕末尾标点")
    parser.add_argument("--gap-split", type=int, default=800, help="静音切句阈值（毫秒，默认 800）")
    parser.add_argument("--speaker", action="store_true", help="请求腾讯云说话人分离并保留 speaker 标签")
    parser.add_argument("--speaker-colors", action="store_true", help="请求说话人分离并写入一次性的字幕颜色快照")
    parser.add_argument("--json", dest="json_out", action="store_true", help="同时输出 .mosp 工程")
    parser.add_argument("--with-waveform", action="store_true", help="将波形嵌入工程")
    parser.add_argument("--with-spectral", action="store_true", help="生成频谱波形")
    parser.add_argument("-s", "--stickers", default=get_default_sticker_dir(), help="表情包文件夹路径")
    parser.add_argument("--no-html", action="store_true", help="禁用 HTML 生成")
    parser.add_argument("-ll", "--length-limit", type=parse_duration, help="只处理媒体前 N 秒")
    parser.add_argument("--file-url", help="公网或 COS 音频 URL；大于 5MB 时必须使用")
    parser.add_argument("--model", default=None, help=f"腾讯云引擎（默认 {DEFAULT_ENGINE}）")
    parser.add_argument("--strip-tail-punct", default="，。", help="句尾剥除的标点集合；传空串禁用剥除")
    parser.add_argument("--debug", action="store_true", help="输出 API 调试摘要")
    parser.add_argument("--debug-raw", action="store_true", help="保存完整 API 原始 JSON")
    args = parser.parse_args()
    configure_console_output()
    if args.with_spectral and not args.with_waveform:
        parser.error("--with-spectral 需要同时指定 --with-waveform")

    input_path = Path(args.input)
    if not input_path.exists() and not args.file_url:
        print(f"错误: 文件不存在 - {input_path}", file=sys.stderr)
        return 1
    output_path = Path(args.output) if args.output else input_path.with_suffix(".srt")
    config = load_config()
    ffmpeg_tools = resolve_ffmpeg_tools(configured_path=config.get("ffmpeg_path"))
    ffmpeg_path = ffmpeg_tools.ffmpeg
    ffprobe_path = ffmpeg_tools.ffprobe
    if not config["secret_id"] or not config["secret_key"]:
        parser.error("未配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY；请在 .env 或系统环境变量中填写")
    if args.model:
        config["engine"] = args.model
    print(f"[准备] 已载入腾讯云录音文件识别配置（引擎: {config['engine']}）")

    video_exts = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"}
    is_video = input_path.suffix.lower() in video_exts
    duration = 0.0
    cache_result = None
    raw_response = None
    with tempfile.TemporaryDirectory() as tmpdir:
        if args.file_url:
            audio_path = ""
        elif is_video:
            audio_path = str(Path(tmpdir) / "audio.wav")
            source_duration = get_duration_sec(
                str(input_path),
                ffprobe_path=ffprobe_path,
            )
            limit = args.length_limit if args.length_limit and args.length_limit < source_duration else None
            extract_audio(
                str(input_path),
                audio_path,
                duration_limit=limit,
                ffmpeg_path=ffmpeg_path,
            )
            duration = get_duration_sec(audio_path, ffprobe_path=ffprobe_path)
        else:
            audio_path = str(Path(tmpdir) / input_path.name)
            shutil.copy2(input_path, audio_path)
            duration = get_duration_sec(audio_path, ffprobe_path=ffprobe_path)
        if args.length_limit and audio_path and args.length_limit < duration:
            limited_path = str(Path(tmpdir) / "audio_limited.wav")
            extract_audio(
                audio_path,
                limited_path,
                duration_limit=args.length_limit,
                ffmpeg_path=ffmpeg_path,
            )
            audio_path = limited_path
            duration = args.length_limit

        result = transcribe(
            audio_path,
            config,
            args.file_url,
            speaker_diarization=args.speaker or args.speaker_colors,
        )
        raw_response = result.pop("_raw_response", None)
        if not result.get("text"):
            print("错误: 未识别到任何内容", file=sys.stderr)
            return 2
        sentences = result.get("sentences", [])
        if sentences:
            segments = [dict(sentence) for sentence in sentences]
        else:
            segments = [{"start": 0, "end": int(duration * 1000), "text": result["text"], "items": []}]
        repair_segment_durations(segments)
        if args.json_out and args.with_waveform and audio_path:
            cache_result = embed_media_caches(
                {"media": str(input_path)}, Path(audio_path), source_media_path=input_path,
                generate_spectral=args.with_spectral,
                ffmpeg_bin=str(ffmpeg_path) if ffmpeg_path is not None else None,
            )

    if not args.keep_punct:
        for segment in segments:
            segment["text"] = str(segment["text"]).rstrip(args.strip_tail_punct)
            for item in segment.get("items", []):
                item["text"] = str(item["text"]).rstrip(args.strip_tail_punct)
    if args.speaker_colors:
        apply_speaker_colors(segments)
    output_path.write_text(generate_srt(segments), encoding="utf-8", newline="\n")
    print(f"字幕已保存到: {output_path}")
    if args.debug_raw:
        raw_path = output_path.with_suffix(".asr-response.json")
        raw_path.write_text(json.dumps(raw_response, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
        print(f"[调试] 原始返回已保存到: {raw_path}")
    if args.debug:
        print(f"[调试] 返回 {len(result.get('items', []))} 个字词时间码项")
    if args.json_out:
        json_path = output_path.with_suffix(".mosp")
        project = {
            "media": str(input_path),
            "language": result.get("language", args.language or ""),
            "model": f"tencent-{config['engine']}",
            "segments": segments,
        }
        if cache_result is not None:
            project = merge_media_caches(project, cache_result)
        check = validate_project(project)
        if not check.ok:
            raise RuntimeError("腾讯云结果未通过 MAW 工程校验: " + "; ".join(error.message for error in check.errors[:3]))
        json_path.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
        print(f"工程文件已保存到: {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

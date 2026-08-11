# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""使用必剪 ASR API 生成视频字幕（云端版，实验性，免 API Key）。

特点：
- 无需 GPU、模型权重，也无需 API Key（B 站必剪的非公开免费接口）
- 分片上传 + 异步轮询，逐字毫秒时间戳（words → MAW items）
- 单文件时长默认上限 2 小时（.env 的 BCUT_MAX_AUDIO_SECONDS 可调）
- 轮询间隔有硬下限，申请上传/分片只对临时错误限次重试——非官方接口，请勿高频调用

风险：该接口未公开、未授权第三方使用，可能随时变更、失效或触发限流/封禁。
仅支持中文为主的音频；无语言参数、无说话人分离、无热词。
重要或批量任务请改用 generate_subtitle_qwen_api.py / generate_subtitle_soniox_api.py。

输出为通用的 UTF-8 JSON 工程格式（默认保存为 `.mosp`，包含 items/text/language），
可直接交给 edit.py 编辑。配置读取 .env 文件（BCUT_POLL_INTERVAL 等，无需 Key）。
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

from edit import get_default_sticker_dir
from generate_subtitle_qwen_api import (
    extract_audio,
    generate_srt,
    get_duration_sec,
    parse_duration,
)
from maw.bcut import (
    SUPPORTED_AUDIO_EXTS,
    build_segments,
    load_config,
    transcribe,
)
from maw.project import repair_segment_durations, validate_project
from waveform import embed_waveform


def main():
    parser = argparse.ArgumentParser(
        description="使用必剪 ASR API 生成视频字幕（云端版，实验性，免 API Key）",
    )
    parser.add_argument("input", help="输入视频或音频文件路径")
    parser.add_argument("-o", "--output", help="输出 SRT 路径（默认与输入同目录）")
    parser.add_argument(
        "-l", "--max-len", type=int, default=21,
        help="每条字幕最大字数（默认 21；仅 CJK 内容生效，空格语言按词数自动处理）",
    )
    parser.add_argument(
        "--min-len", type=int, default=5,
        help="句号间最短字数，不足则合并（默认 5；仅 CJK 内容生效）",
    )
    parser.add_argument(
        "--keep-punct", action="store_true",
        help="保留每条字幕末尾的逗号和句号（默认去除）",
    )
    parser.add_argument(
        "--gap-split", type=int, default=1500,
        help="静音切句阈值（毫秒），相邻字停顿超过此值则切句（默认 1500）",
    )
    parser.add_argument(
        "--json", dest="json_out", action="store_true",
        help="同时输出含字级时间戳的工程文件（默认 .mosp，供 edit.py 加载）",
    )
    parser.add_argument(
        "--with-waveform", action="store_true",
        help="将波形峰值数据嵌入工程文件（GUI 转写默认开启）",
    )
    parser.add_argument(
        "-s", "--stickers", default=get_default_sticker_dir(),
        help="表情包文件夹路径，传给 edit.py（默认读 .env 的 STICKER_DIR）",
    )
    parser.add_argument(
        "--no-html", action="store_true",
        help="禁用自动生成 edit HTML（默认 --json 时会一并生成）",
    )
    parser.add_argument(
        "-ll", "--length-limit", type=parse_duration, default=None,
        help="只处理音频前 N 时长，用于测试（示例: 10m, 20s, 1h, 90）",
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="输出 API 解析结果用于调试",
    )
    parser.add_argument(
        "--debug-raw", action="store_true",
        help="保存必剪服务端返回的完整原始 JSON，用于排查断句、标点和时间码",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"错误: 文件不存在 - {input_path}", file=sys.stderr)
        raise SystemExit(1)

    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_path.with_suffix(".srt")

    config = load_config()

    video_exts = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"}
    is_video = input_path.suffix.lower() in video_exts
    # 必剪只直接收 flac/aac/m4a/mp3/wav；其他音频（ogg/opus 等）先转 wav
    needs_transcode = is_video or input_path.suffix.lower() not in SUPPORTED_AUDIO_EXTS

    with tempfile.TemporaryDirectory() as tmpdir:
        if needs_transcode:
            audio_path = str(Path(tmpdir) / "audio.wav")
            source_duration = get_duration_sec(str(input_path))
            media_limit = (
                args.length_limit
                if args.length_limit is not None and args.length_limit < source_duration
                else None
            )
            extract_audio(str(input_path), audio_path, duration_limit=media_limit)
            duration = get_duration_sec(audio_path)
            if media_limit is not None:
                lm, ls = divmod(int(media_limit), 60)
                print(f"[info] 测试模式：从源文件直接提取前 {lm}分{ls}秒，跳过其余内容")
        elif args.length_limit is not None:
            # 已支持的音频格式在 -ll 下也直接转为限长 wav，避免先复制完整文件并
            # 按完整时长触发必剪上限，再进行第二次 ffmpeg 裁剪。
            audio_path = str(Path(tmpdir) / "audio.wav")
            extract_audio(str(input_path), audio_path, duration_limit=args.length_limit)
            duration = get_duration_sec(audio_path)
            lm, ls = divmod(int(min(args.length_limit, duration)), 60)
            print(f"[info] 测试模式：从源文件直接提取前 {lm}分{ls}秒，跳过其余内容")
        else:
            # 无裁剪需求时复制到 tmpdir 统一处理（避免改动原文件）
            audio_path = str(Path(tmpdir) / input_path.name)
            shutil.copy2(input_path, audio_path)
            duration = get_duration_sec(audio_path)

        m, s = divmod(int(duration), 60)
        print(f"[info] 音频总时长: {m}分{s}秒")

        max_seconds = int(config["max_audio_seconds"])
        if duration > max_seconds:
            raise SystemExit(
                f"[错误] 音频时长 {int(duration // 60)} 分钟超过必剪单文件上限"
                f"（{max_seconds // 60} 分钟，可用 BCUT_MAX_AUDIO_SECONDS 调整）。\n"
                f"       请用 -ll 截取部分时长，或先把音频分割成多个文件。"
            )

        t0 = time.perf_counter()
        result = transcribe(audio_path, config, capture_raw=args.debug_raw)
        elapsed = time.perf_counter() - t0

        if not result or not result.get("text"):
            print("错误: 未识别到任何内容", file=sys.stderr)
            raise SystemExit(2)

        print(f"[info] 检测语言: {result.get('language') or 'unknown'}")

        items = result["items"]
        if args.debug:
            print("\n--- debug ---")
            print(f"text: {result['text'][:200]}...")
            print(f"items count: {len(items)}")
            print(f"first 5 items: {items[:5]}")
            print("--- end debug ---\n")

        if not items:
            print("[警告] 未获得时间戳，输出整段为单条字幕")
            segments = [{"start": 0, "end": int(duration * 1000), "text": result["text"]}]
        else:
            segments = build_segments(
                items, max_len=args.max_len, min_len=args.min_len,
                gap_split_ms=args.gap_split,
            )

        # 兜底：缺时间戳/倒挂会形成 0 长 item，
        # 拉齐到至少 100ms，避免拆分后看不见字幕块、工程无法保存。
        repaired_count = repair_segment_durations(segments)
        if repaired_count:
            print(f"[info] 已兜底修复 {repaired_count} 处 0 长/倒挂时间码（保底 100ms）")

    # 剥句末标点（与 Qwen 版一致）
    if not args.keep_punct:
        for seg in segments:
            seg["text"] = seg["text"].rstrip("，。")
            seg_items = seg.get("items")
            if seg_items:
                k = len(seg_items) - 1
                while k >= 0:
                    seg_items[k]["text"] = seg_items[k]["text"].rstrip("，。")
                    if seg_items[k]["text"]:
                        break
                    k -= 1

    srt_content = generate_srt(segments)

    em, es = divmod(int(elapsed), 60)
    if duration > 0:
        rtf = elapsed / duration
        speed = (1 / rtf) if rtf > 0 else 0
    else:
        rtf = 0
        speed = 0
    if not args.output:
        speed_tag = f"{speed:.1f}x" if speed else "na"
        ts_prefix = f"[{datetime.now().strftime('%y%m%d%H%M')}]"
        output_path = output_path.with_name(
            f"{ts_prefix}{output_path.stem}.bcut.{speed_tag}.srt"
        )

    output_path.write_text(srt_content, encoding="utf-8")
    print(f"\n字幕已保存到: {output_path}")
    print(f"共 {len(segments)} 条字幕")
    if args.debug_raw:
        raw_response = result.pop("raw_response", None)
        if raw_response is None:
            raise RuntimeError("调试模式未获得 ASR 原始返回数据")
        raw_path = output_path.with_suffix(".asr-response.json")
        with raw_path.open("w", encoding="utf-8", newline="\n") as raw_file:
            json.dump(raw_response, raw_file, ensure_ascii=False, indent=2)
            raw_file.write("\n")
        print(f"[调试] ASR 原始返回已保存到: {raw_path}")
    if duration > 0:
        print(f"处理用时: {em}分{es}秒 | 实际 RTF: {rtf:.3f} ({speed:.1f}x 实时)")
    else:
        print(f"处理用时: {em}分{es}秒")

    if args.json_out:
        json_path = output_path.with_suffix(".mosp")
        json_data = {
            "media": str(input_path),
            "language": result.get("language", ""),
            "model": "bcut-asr",
            "segments": [
                {
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": seg["text"],
                    "items": seg.get("items", []),
                }
                for seg in segments
            ],
        }
        if args.with_waveform:
            waveform_result = embed_waveform(json_data, input_path)
            json_data = waveform_result.project
            if waveform_result.error is None:
                waveform_payload = json_data["waveform"]
                print(
                    f"[waveform] 已嵌入 {waveform_payload['peak_count']} peaks "
                    f"({waveform_payload['peaks_per_second']}/秒)"
                )
            else:
                print(f"[waveform] 警告: {waveform_result.error}；已跳过内嵌波形")
        check = validate_project(json_data)
        if not check.ok:
            print("[警告] 工程文件未通过契约校验，请把以下内容反馈给开发者：")
            for err in check.errors[:10]:
                print(f"  {err.path}: {err.message}")
        json_path.write_text(
            json.dumps(json_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"工程文件已保存到: {json_path}")

        if not args.no_html:
            edit_script = Path(__file__).parent / "edit.py"
            if not edit_script.exists():
                print("[警告] 找不到 edit.py，跳过 HTML 生成")
            else:
                cmd = [sys.executable, str(edit_script), str(json_path)]
                if args.stickers:
                    sticker_dir = Path(args.stickers)
                    if sticker_dir.exists():
                        cmd += ["-s", str(sticker_dir)]
                    else:
                        print(f"[提示] 表情包目录不存在，跳过：{sticker_dir}")
                print(f"[edit] 生成 HTML: {' '.join(cmd[1:])}")
                try:
                    subprocess.run(cmd, check=True)
                except subprocess.CalledProcessError as e:
                    print(f"[警告] edit.py 失败 (exit {e.returncode})")


if __name__ == "__main__":
    main()

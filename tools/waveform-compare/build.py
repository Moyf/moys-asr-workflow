"""Generate audio fixtures and a standalone old/new mopeaks comparison page.

Run from the repository root:
    uv run --no-sync python tools/waveform-compare/build.py

Media, cache files and HTML are written only to a new temporary directory.
"""

from __future__ import annotations

import array
import json
import math
import statistics
import struct
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from maw import mopeaks, quapeaks, waveform  # noqa: E402


SAMPLE_RATE = 48_000
PEAKS_PER_SECOND = 100
DURATION = 8
SCENES = [
    {"start": 0, "end": 1, "name": "普通语音频段", "detail": "双声道同相 220 Hz，作为基线。"},
    {"start": 1, "end": 2, "name": "高频短音", "detail": "4 kHz 短音；两种低采样率波形都难完整保留。"},
    {"start": 2, "end": 3, "name": "单采样脉冲", "detail": "极短脉冲；观察先降采样后的损失。"},
    {"start": 3, "end": 4, "name": "左右反相", "detail": "两声道等幅反相；旧版混单声道会抵消。"},
    {"start": 4, "end": 5, "name": "仅右声道", "detail": "左声道静音，右声道 330 Hz。"},
    {"start": 5, "end": 6, "name": "高低频混合", "detail": "低频底音叠加较强高频成分。"},
    {"start": 6, "end": 7, "name": "弱音与强瞬态", "detail": "低振幅底音中穿插短脉冲。"},
    {"start": 7, "end": 8, "name": "静音", "detail": "检查零线和尾部。"},
]


def sample_pair(index: int) -> tuple[int, int]:
    second = index // SAMPLE_RATE
    local = (index % SAMPLE_RATE) / SAMPLE_RATE
    if second == 0:
        left = right = 0.48 * math.sin(2 * math.pi * 220 * local)
    elif second == 1:
        burst = 0.78 if (local % 0.125) < 0.022 else 0.0
        left = right = burst * math.sin(2 * math.pi * 4000 * local)
    elif second == 2:
        left = right = 0.92 if index % (SAMPLE_RATE // 10) == 1 else 0.0
    elif second == 3:
        left = 0.67 * math.sin(2 * math.pi * 330 * local)
        right = -left
    elif second == 4:
        left = 0.0
        right = 0.7 * math.sin(2 * math.pi * 330 * local)
    elif second == 5:
        left = right = 0.22 * math.sin(2 * math.pi * 185 * local) + 0.43 * math.sin(2 * math.pi * 3600 * local)
    elif second == 6:
        pulse = 0.85 if index % (SAMPLE_RATE // 4) < 12 else 0.0
        left = right = 0.045 * math.sin(2 * math.pi * 180 * local) + pulse
    else:
        left = right = 0.0
    return round(left * 32767), round(right * 32767)


def write_wav(path: Path, *, channels: int, sample_rate: int, frames: bytes) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(frames)


def make_stereo_audio(path: Path) -> None:
    samples = array.array("h")
    for index in range(SAMPLE_RATE * DURATION):
        samples.extend(sample_pair(index))
    if sys.byteorder != "little":
        samples.byteswap()
    write_wav(path, channels=2, sample_rate=SAMPLE_RATE, frames=samples.tobytes())


def make_mono_audio(path: Path) -> None:
    frames = bytearray()
    rate = 16_000
    for index in range(rate * DURATION):
        second = index // rate
        voice = math.sin(2 * math.pi * 180 * index / rate) + 0.3 * math.sin(2 * math.pi * 540 * index / rate)
        gate = 0.55 if second % 2 == 0 else 0.12
        frames.extend(struct.pack("<h", round(voice * gate * 20_000 / 1.3)))
    write_wav(path, channels=1, sample_rate=rate, frames=frames)


def make_three_channel_audio(path: Path) -> None:
    frames = bytearray()
    for index in range(SAMPLE_RATE * DURATION):
        left, right = sample_pair(index)
        third = round(math.sin(2 * math.pi * 260 * index / SAMPLE_RATE) * 25_000) if 3 <= index / SAMPLE_RATE < 5 else 0
        frames.extend(struct.pack("<hhh", left, right, third))
    write_wav(path, channels=3, sample_rate=SAMPLE_RATE, frames=frames)


def repeat_wav(source: Path, target: Path, count: int = 40) -> None:
    with wave.open(str(source), "rb") as original:
        params = original.getparams()
        frames = original.readframes(original.getnframes())
    with wave.open(str(target), "wb") as output:
        output.setparams(params)
        for _ in range(count):
            output.writeframesraw(frames)


def transcode(source: Path, target: Path, *options: str) -> None:
    ffmpeg = waveform.resolve_ffmpeg_tool("ffmpeg", None)
    if not ffmpeg:
        raise RuntimeError("缺少 FFmpeg，无法生成测试素材")
    result = subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-vn", *options, str(target)],
        capture_output=True, text=True, encoding="utf-8",
    )
    if result.returncode:
        raise RuntimeError(f"无法生成 {target.name}: {result.stderr.strip()}")


def make_cases(root: Path) -> list[dict]:
    base = root / "stereo-48k.wav"
    mono = root / "mono-16k.wav"
    three = root / "three-channel-48k.wav"
    make_stereo_audio(base)
    make_mono_audio(mono)
    make_three_channel_audio(three)
    cases = [
        {"key": "stereo-wav", "label": "48 kHz 立体声 WAV", "detail": "无损双声道：检查反相和单侧声道。", "preview": base, "channels": 2, "rate": 48_000},
        {"key": "mono-wav", "label": "16 kHz 单声道 WAV", "detail": "语音式单声道：新旧结果应一致。", "preview": mono, "channels": 1, "rate": 16_000},
        {"key": "three-channel", "label": "48 kHz 三声道 WAV", "detail": "第三声道在 3–5 秒有声音：检查任意声道是否被遗漏。", "preview": three, "channels": 3, "rate": 48_000},
    ]
    stereo_44k = root / "stereo-44k.wav"
    transcode(base, stereo_44k, "-ar", "44100", "-c:a", "pcm_s16le")
    cases.append({"key": "stereo-44k", "label": "44.1 kHz 立体声 WAV", "detail": "另一常见采样率，检查时间轴和波形。", "preview": stereo_44k, "channels": 2, "rate": 44_100})
    aac = root / "stereo-aac.m4a"
    transcode(base, aac, "-c:a", "aac", "-b:a", "192k")
    cases.append({"key": "aac", "label": "48 kHz 立体声 AAC", "detail": "压缩音频：查看解码后的峰值差异。", "preview": aac, "channels": 2, "rate": 48_000})
    mp3 = root / "stereo-mp3.mp3"
    try:
        transcode(stereo_44k, mp3, "-c:a", "libmp3lame", "-b:a", "192k")
    except RuntimeError as exc:
        print(f"跳过 MP3 样本: {exc}")
    else:
        cases.append({"key": "mp3", "label": "44.1 kHz 立体声 MP3", "detail": "另一压缩格式，检查常见媒体的生成成本。", "preview": mp3, "channels": 2, "rate": 44_100})
    sources = {"stereo-wav": base, "mono-wav": mono, "three-channel": three, "stereo-44k": stereo_44k, "aac": base, "mp3": stereo_44k}
    for case in cases:
        long_wav = root / f"{case['key']}-320s.wav"
        repeat_wav(sources[case["key"]], long_wav)
        if case["key"] == "aac":
            long_media = root / "aac-320s.m4a"
            transcode(long_wav, long_media, "-c:a", "aac", "-b:a", "192k")
        elif case["key"] == "mp3":
            long_media = root / "mp3-320s.mp3"
            transcode(long_wav, long_media, "-c:a", "libmp3lame", "-b:a", "192k")
        else:
            long_media = long_wav
        case["benchmark"] = long_media
    return cases


def benchmark_case(case: dict, *, native_available: bool = True) -> dict:
    media = case["benchmark"]
    actions = {
        "oldMs": lambda: waveform.extract_waveform(media, preserve_channels=False),
        "newMs": lambda: waveform.extract_waveform(media),
    }
    if native_available:
        actions["quapeaksMs"] = lambda: quapeaks.generate_reapeaks_stream_bytes(media, include_spectral=False)
    for action in actions.values():
        action()  # warm process launch and filesystem cache
    times: dict[str, list[float]] = {key: [] for key in actions}
    names = list(actions)
    for round_index in range(5):
        for name in names[round_index % len(names):] + names[:round_index % len(names)]:
            start = time.perf_counter()
            actions[name]()
            times[name].append((time.perf_counter() - start) * 1000)
    return {"oldMs": round(statistics.median(times["oldMs"]), 1),
            "newMs": round(statistics.median(times["newMs"]), 1),
            "quapeaksMs": round(statistics.median(times["quapeaksMs"]), 1) if native_available else None}


def build_case(case: dict) -> dict:
    media = case["preview"]
    old = waveform.extract_waveform(media, preserve_channels=False)
    new = waveform.extract_waveform(media)
    old_blob = mopeaks.encode_mopeaks(old, media)
    new_blob = mopeaks.encode_mopeaks(new, media)
    (media.parent / f"{case['key']}.old.mopeaks").write_bytes(old_blob)
    (media.parent / f"{case['key']}.new.mopeaks").write_bytes(new_blob)
    qpk_file = quapeaks.generate_for_media(media, include_spectral=False)
    native = quapeaks.extract_waveform_payload(qpk_file, media) if qpk_file else None
    variants = [
        {"id": "mopeaks-old", "label": "旧版 mopeaks", "color": "#e8844b", "source": "1 kHz 单声道 → 100 峰/秒", "payload": old},
        {"id": "mopeaks-new", "label": "新版 mopeaks", "color": "#32a279", "source": "1 kHz 保留原声道并合并极值 → 100 峰/秒", "payload": new},
    ]
    if native is not None:
        variants.insert(0, {"id": "quapeaks", "label": "quapeaks", "color": "#4b78d8", "source": "实际 QPK1 wave 最细层；未启用频谱", "payload": native})
    return {
        "key": case["key"], "label": case["label"], "detail": case["detail"],
        "audio": media.name, "rate": case["rate"], "channels": case["channels"],
        "duration": DURATION, "variants": variants,
        "sizes": {"old": len(old_blob), "new": len(new_blob), "quapeaks": qpk_file.stat().st_size if native is not None else None},
        "benchmark": benchmark_case(case, native_available=native is not None),
    }


def main() -> None:
    out = Path(tempfile.mkdtemp(prefix="maw-waveform-compare-"))
    cases = make_cases(out)
    data = {"duration": DURATION, "scenes": SCENES, "cases": [build_case(case) for case in cases]}
    template = (Path(__file__).with_name("page.html")).read_text(encoding="utf-8")
    injection = "window.__WAVEFORM_COMPARISON__ = " + json.dumps(data, ensure_ascii=False).replace("</", "<\\/") + ";"
    page = out / "comparison.html"
    page.write_text(template.replace("/* COMPARISON_DATA */", injection), encoding="utf-8", newline="\n")
    print(f"对比页: {page}")
    print("320 秒素材计时：预热后 5 次中位数，均含 FFmpeg 解码，不含缓存写入")
    for case in data["cases"]:
        bench = case["benchmark"]
        print(f"{case['label']}: 旧 {bench['oldMs']} ms / 新 {bench['newMs']} ms / quapeaks {bench['quapeaksMs']} ms；MPK {case['sizes']['old']} / {case['sizes']['new']} B")


if __name__ == "__main__":
    main()

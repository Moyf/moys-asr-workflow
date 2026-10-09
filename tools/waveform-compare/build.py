"""Generate a deterministic audio fixture and a standalone three-way waveform viewer.

Run from the repository root:
    uv run --no-sync python tools/waveform-compare/build.py

All generated media and cache files go to a new system temporary directory.
"""

from __future__ import annotations

import array
import base64
import json
import math
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
    {"start": 0, "end": 1, "name": "普通语音频段", "detail": "双声道同相 220 Hz 正弦波；作为基线。"},
    {"start": 1, "end": 2, "name": "高频短音", "detail": "4 kHz 短促音；观察降到 1 kHz PCM 后的高频损失。"},
    {"start": 2, "end": 3, "name": "单采样脉冲", "detail": "每 100 ms 一个极短脉冲；观察瞬态是否保留。"},
    {"start": 3, "end": 4, "name": "左右反相", "detail": "两声道等幅反相；单声道混合会相互抵消。"},
    {"start": 4, "end": 5, "name": "仅右声道", "detail": "左声道静音，右声道 330 Hz。"},
    {"start": 5, "end": 6, "name": "高低频混合", "detail": "低频底音叠加较强高频成分。"},
    {"start": 6, "end": 7, "name": "弱音与强瞬态", "detail": "低振幅底音中穿插短脉冲。"},
    {"start": 7, "end": 8, "name": "静音", "detail": "检查零线、尾部和时间轴。"},
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
        pulse = 0.92 if index % (SAMPLE_RATE // 10) == 1 else 0.0
        left = right = pulse
    elif second == 3:
        left = 0.67 * math.sin(2 * math.pi * 330 * local)
        right = -left
    elif second == 4:
        left = 0.0
        right = 0.7 * math.sin(2 * math.pi * 330 * local)
    elif second == 5:
        left = right = (0.22 * math.sin(2 * math.pi * 185 * local)
                        + 0.43 * math.sin(2 * math.pi * 3600 * local))
    elif second == 6:
        pulse = 0.85 if (index % (SAMPLE_RATE // 4)) < 12 else 0.0
        left = right = 0.045 * math.sin(2 * math.pi * 180 * local) + pulse
    else:
        left = right = 0.0
    return round(left * 32767), round(right * 32767)


def make_audio(path: Path) -> array.array[int]:
    samples = array.array("h")
    for index in range(SAMPLE_RATE * DURATION):
        samples.extend(sample_pair(index))
    if sys.byteorder != "little":
        samples.byteswap()
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(samples.tobytes())
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def full_rate_payload(samples: array.array[int], media: Path, rate: int) -> dict:
    """Experimental envelope: original-rate extrema across both channels."""
    frames_per_bin = SAMPLE_RATE // rate
    encoded = bytearray()
    for start in range(0, SAMPLE_RATE * DURATION, frames_per_bin):
        frame = samples[start * 2 : min(start + frames_per_bin, SAMPLE_RATE * DURATION) * 2]
        encoded.append(waveform._quantize_sample(min(frame)) & 0xFF)
        encoded.append(waveform._quantize_sample(max(frame)) & 0xFF)
    return {
        "schema": waveform.WAVEFORM_SCHEMA,
        "encoding": waveform.WAVEFORM_ENCODING,
        "peaks_per_second": rate,
        "sample_rate": SAMPLE_RATE,
        "division": frames_per_bin,
        "peak_count": len(encoded) // 2,
        "duration_ms": DURATION * 1000,
        "audio_track": 0,
        "source": waveform.media_signature(media),
        "data": base64.b64encode(encoded).decode("ascii"),
    }


def main() -> None:
    out = Path(tempfile.mkdtemp(prefix="maw-waveform-compare-"))
    media = out / "waveform-test.wav"
    samples = make_audio(media)

    start = time.perf_counter()
    current = waveform.extract_waveform(
        media, peaks_per_second=PEAKS_PER_SECOND, pcm_sample_rate=PEAKS_PER_SECOND * 10
    )
    current_ms = (time.perf_counter() - start) * 1000
    current_file = out / "waveform-test.wav.mopeaks"
    current_file.write_bytes(mopeaks.encode_mopeaks(current, media))

    start = time.perf_counter()
    improved = waveform.extract_waveform(media, peaks_per_second=PEAKS_PER_SECOND)
    improved_ms = (time.perf_counter() - start) * 1000
    improved_file = out / "waveform-test.improved.mopeaks"
    improved_file.write_bytes(mopeaks.encode_mopeaks(improved, media))

    native_file = quapeaks.generate_for_media(media, include_spectral=False)
    native = None
    if native_file is not None:
        try:
            native = quapeaks.extract_waveform_payload(native_file, media)
        except (OSError, ValueError, IndexError) as exc:
            print(f"quapeaks 波形层读取失败: {exc}")
    native_actual = native is not None
    if native is None:
        # Keep the visual comparison useful without inventing a QPK file.
        native = full_rate_payload(samples, media, 300)

    data = {
        "duration": DURATION,
        "audio": media.name,
        "scenes": SCENES,
        "nativeActual": native_actual,
        "benchmarks": {"currentMs": round(current_ms, 1), "improvedMs": round(improved_ms, 1)},
        "sizes": {"current": current_file.stat().st_size, "improved": improved_file.stat().st_size},
        "variants": [
            {"id": "quapeaks", "label": "quapeaks" if native_actual else "原始 PCM 参考（非 quapeaks）", "color": "#4b78d8",
             "source": "实际 QPK1 wave 最细层" if native_actual else "原始 PCM 300 峰/秒参考曲线（未生成 QPK）",
             "payload": native},
            {"id": "mopeaks", "label": "旧版 mopeaks", "color": "#e8844b",
             "source": "旧版 FFmpeg 单声道 1 kHz → 100 峰/秒",
             "payload": current},
            {"id": "optimized", "label": "改进版 mopeaks", "color": "#32a279",
             "source": "MAW 源采样率与全部声道取峰 → 100 峰/秒",
             "payload": improved},
        ],
    }
    template = (Path(__file__).with_name("page.html")).read_text(encoding="utf-8")
    injection = "window.__WAVEFORM_COMPARISON__ = " + json.dumps(data, ensure_ascii=False).replace("</", "<\\/") + ";"
    if "/* COMPARISON_DATA */" not in template:
        raise RuntimeError("page.html 缺少数据插入标记")
    page = out / "comparison.html"
    page.write_text(template.replace("/* COMPARISON_DATA */", injection), encoding="utf-8", newline="\n")

    print(f"对比页: {page}")
    print(f"测试音频: {media}")
    print(f"旧版 mopeaks: {current_file}")
    print(f"改进版 mopeaks: {improved_file}")
    print(f"两份 MPK1 体积: {current_file.stat().st_size} B / {improved_file.stat().st_size} B")
    print(f"单次生成耗时: 旧版 {current_ms:.1f} ms / 改进版 {improved_ms:.1f} ms（均含 FFmpeg 解码）")
    print(f"quapeaks: {native_file if native_actual else '未生成；页面明确显示参考曲线'}")


if __name__ == "__main__":
    main()

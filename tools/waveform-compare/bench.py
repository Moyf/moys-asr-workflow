"""Measure the two MPK1 generation paths on the same decoded WAV input."""

from __future__ import annotations

import statistics
import tempfile
import time
import wave
from pathlib import Path

from build import PEAKS_PER_SECOND, make_audio, waveform


def repeated_wav(source: Path, target: Path, repeats: int) -> None:
    with wave.open(str(source), "rb") as original:
        params = original.getparams()
        frames = original.readframes(original.getnframes())
    with wave.open(str(target), "wb") as output:
        output.setparams(params)
        for _ in range(repeats):
            output.writeframesraw(frames)


def median_ms(action) -> float:
    action()  # warm process start and filesystem cache
    elapsed = []
    for _ in range(5):
        start = time.perf_counter()
        action()
        elapsed.append((time.perf_counter() - start) * 1000)
    return statistics.median(elapsed)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="maw-waveform-bench-") as directory:
        root = Path(directory)
        source = root / "8s.wav"
        make_audio(source)
        longer = root / "64s.wav"
        repeated_wav(source, longer, 8)
        for media in (source, longer):
            current = lambda: waveform.extract_waveform(
                media, peaks_per_second=PEAKS_PER_SECOND,
                pcm_sample_rate=PEAKS_PER_SECOND * 10,
            )
            improved = lambda: waveform.extract_waveform(media, peaks_per_second=PEAKS_PER_SECOND)
            # Alternate order across fixture lengths to reduce a warmup bias.
            if media == source:
                first = median_ms(current)
                second = median_ms(improved)
            else:
                second = median_ms(improved)
                first = median_ms(current)
            print(f"{media.stem}: 旧版 {first:.1f} ms / 改进版 {second:.1f} ms（各 5 次中位数，均含 FFmpeg 解码）")


if __name__ == "__main__":
    main()

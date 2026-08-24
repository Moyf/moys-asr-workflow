"""生成 .ReaPeaks fixture 的源 wav（供 REAPER 生成 .ReaPeaks 用）。

只生成 wav；`*.wav` 被 gitignore，不入库。`.ReaPeaks` 由用户在 REAPER 中打开
对应 wav 后生成，复制回 `tests/test_data/`（.ReaPeaks 可提交）。内容设计见
`FIXTURES.md`。生成 wav 需要 numpy（现为 `ocr` 可选依赖）；numpy 缺失时
`test_reapeaks_fixture.py` 的相关用例自动 skip。
"""
from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent
SR_44K = 44100
SR_48K = 48000


def _write_wav(path: Path, sr: int, samples: np.ndarray) -> None:
    """Write float samples in [-1, 1] as 16-bit PCM WAV.

    ``samples`` is (n,) for mono or (n, channels) interleaved.
    """
    s16 = np.clip(np.round(samples * 32767), -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1 if samples.ndim == 1 else samples.shape[1])
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(s16.tobytes())


def _tone(freq: float, sr: int, n: int, amp: float = 0.8) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / sr
    return amp * np.sin(2 * np.pi * freq * t)


def _pink_noise(n: int, rng: np.random.Generator) -> np.ndarray:
    """Pink noise via frequency-domain 1/sqrt(f) weighting (deterministic)."""
    fft = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n)
    freqs[0] = 1.0  # 避免除零（DC 保持原值）
    signal = np.fft.irfft(fft / np.sqrt(freqs), n)
    peak = np.max(np.abs(signal))
    return signal / peak if peak > 0 else signal


def gen_tone30() -> None:
    """30 分钟主 fixture：静音/200Hz/粉噪声/1kHz/3kHz/静音 + 白噪声尾。

    白噪声叠加只在前 5 个 5 分钟段执行，保留最后一段的纯音与末尾静音。
    """
    sr = SR_44K
    n = sr * 1800
    rng = np.random.default_rng(42)
    samples = np.zeros(n, dtype=np.float64)
    samples[10 * sr:600 * sr] = _tone(200.0, sr, (600 - 10) * sr)
    samples[600 * sr:900 * sr] = _pink_noise(300 * sr, rng) * 0.8
    samples[900 * sr:1350 * sr] = _tone(1000.0, sr, 450 * sr)
    samples[1350 * sr:1790 * sr] = _tone(3000.0, sr, 440 * sr)
    for start in range(0, 1500, 300):
        seg = slice((start + 270) * sr, (start + 300) * sr)
        samples[seg] += rng.uniform(-0.15, 0.15, size=seg.stop - seg.start)
    _write_wav(OUT / "tone30.wav", sr, samples)
    print("wrote", OUT / "tone30.wav")


def gen_tone_dual() -> None:
    """双声道 fixture：左 1kHz 纯音，右 500Hz 纯音 + 白噪声叠加。"""
    sr = SR_44K
    n = sr * 20
    rng = np.random.default_rng(7)
    left = _tone(1000.0, sr, n)
    right = _tone(500.0, sr, n) * 0.6 + rng.uniform(-0.15, 0.15, size=n)
    _write_wav(OUT / "tone_dual.wav", sr, np.stack([left, right], axis=1))
    print("wrote", OUT / "tone_dual.wav")


def gen_tone_48k() -> None:
    """48kHz fixture：前 5s 440Hz 纯音，后 5s 白噪声。"""
    sr = SR_48K
    n = sr * 10
    rng = np.random.default_rng(99)
    samples = np.zeros(n, dtype=np.float64)
    samples[:5 * sr] = _tone(440.0, sr, 5 * sr)
    samples[5 * sr:] = rng.uniform(-0.5, 0.5, size=5 * sr)
    _write_wav(OUT / "tone_48k.wav", sr, samples)
    print("wrote", OUT / "tone_48k.wav")


def main() -> None:
    gen_tone30()
    gen_tone_dual()
    gen_tone_48k()


if __name__ == "__main__":
    main()
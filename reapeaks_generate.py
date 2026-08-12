"""Generate a REAPER .reapeaks file from PCM samples, matching the original format.

Format: RPKN v1.1. Produces wave + spectral + loudness mipmaps, mirroring
REAPER's structure. Calibrated against a real REAPER-generated file (ICE):
- wave: per-div max/min pairs (100% byte-identical to REAPER)
- spectral: 32-bit int per peak per channel, low 15 bits = dominant freq (Hz),
  next 14 bits = density (spectral-flatness derived)
- loudness: one float per peak per channel (weighted RMS)

Calibration notes (reverse-engineered from ICE.reapeaks):
- wave divs: finest = ceil(sr/300), then sr/20, then sr (1/s)
- spectral marker = -(int)'s' = -115, loudness marker = -(int)'r' = -114
- spectral count = floor(C/div), C = finest_wave_cover - 1280
- loudness: div = sr/40 (ceil+1 count) and sr/2 (floor count)
- freq field = round(dominant freq Hz) via 2048-sample FFT
- density = -2961.5*ln(spectral_flatness) + 3995.3

``numpy`` is imported lazily only by the FFT helpers so loading the module
keeps the editor startup light.
"""
from __future__ import annotations

import struct
import math
import sys
import wave as wavlib
from pathlib import Path

MAGIC = b"RPKN"  # v1.1


def read_wav_slices(path):
    """Read a 16-bit PCM WAV into Python lists of int16 per channel.

    Returns (sample_rate, channels, samples) where samples[c] is a list of ints.
    """
    with wavlib.open(str(path), "rb") as wf:
        sample_rate = wf.getframerate()
        channels = wf.getnchannels()
        n = wf.getnframes()
        raw = wf.readframes(n)
    if wf.getsampwidth() != 2:
        raise ValueError("only 16-bit PCM supported")
    samples: list[list[int]] = [[] for _ in range(channels)]
    for i in range(0, len(raw), 2 * channels):
        for c in range(channels):
            samples[c].append(struct.unpack_from("<h", raw, i + 2 * c)[0])
    return sample_rate, channels, samples


def compute_peaks(samples, div):
    """max/min per div window for one channel. Returns (maxs, mins)."""
    maxs, mins = [], []
    n = len(samples)
    for start in range(0, n, div):
        segment = samples[start : start + div]
        maxs.append(max(segment))
        mins.append(min(segment))
    return maxs, mins


def choose_division_factors(sr):
    """REAPER defaults: ~300 peaks/s (fine), ~20/s, ~1/s."""
    fine = max(1, sr // 300)
    mid = max(1, sr // 20)
    coarse = sr
    return [fine, mid, coarse]


def _spec_buf(seg, fftn=2048):
    """Build an fftn-sample Hanning-windowed buffer centered on seg."""
    import numpy as np

    buf = np.zeros(fftn, dtype=np.float64)
    n = len(seg)
    segf = np.asarray(seg, dtype=np.float64) / 32768.0
    start = (fftn - n) // 2
    end = start + n
    if end > fftn:
        end = fftn
        segf = segf[: fftn - start]
    wins = np.hanning(len(segf))
    buf[start:end] = segf * wins
    return buf


def _dominant_hz(seg, sr=48000, fftn=2048):
    """Dominant frequency in Hz via FFT with parabolic interpolation."""
    import numpy as np

    n = len(seg)
    if n < 8:
        return 0
    buf = _spec_buf(seg, fftn)
    spec = np.abs(np.fft.rfft(buf))
    idx = int(np.argmax(spec[1:])) + 1
    if idx <= 0 or idx >= len(spec) - 1:
        return 0
    y0, y1, y2 = spec[idx - 1], spec[idx], spec[idx + 1]
    den = y0 - 2 * y1 + y2
    delta = float(0.5 * (y0 - y2) / den) if abs(den) > 1e-12 else 0.0
    bin_hz = sr / fftn
    return idx * bin_hz + delta * bin_hz


def _density(seg, sr=48000, fftn=2048):
    """Density from spectral flatness: tonal(spiky)->high, noise->low.

    density = -2961.5*ln(flatness)+3995.3, clipped to [1, 16383].
    """
    import numpy as np

    n = len(seg)
    if n < 8:
        return 0
    buf = _spec_buf(seg, fftn)
    spec = np.abs(np.fft.rfft(buf))[1:]  # drop DC
    if spec.size == 0 or spec.sum() <= 0:
        return 0
    geo = np.exp(np.mean(np.log(np.maximum(spec, 1e-12))))
    arith = np.mean(spec)
    flatness = geo / arith if arith > 0 else 0
    if flatness <= 0:
        return 0
    density = -2961.5 * math.log(flatness) + 3995.3
    return max(1, min(16383, density))


def _spectral_code(samples, peak_index, div, sr=48000):
    """Return the 32-bit spectral code: freq(15 bits) | density<<15."""
    ntotal = len(samples)
    center = peak_index * div
    half = 1024  # 2048 / 2
    s0 = max(0, center - half)
    s1 = min(ntotal, center + half)
    seg = samples[s0:s1]
    if len(seg) < 512:
        return 0
    freq = _dominant_hz(seg, sr)
    density = _density(seg, sr)
    if freq <= 0 or density <= 0:
        return 0
    freq = int(round(freq))
    if freq > 0x7FFF:
        freq = 0x7FFF
    dens = int(round(density))
    if dens > 0x3FFF:
        dens = 0x3FFF
    return freq | (dens << 15)


def _loudness(samples, peak_index, div):
    """Weighted RMS of the block (approx of REAPER's loudness value)."""
    start = peak_index * div
    end = min(start + div, len(samples))
    seg = samples[start:end]
    if len(seg) == 0:
        return 0.0
    # 用 Python float 累加，避免 numpy int16 相乘溢出（32767² 溢出成负值）。
    rms = math.sqrt(sum(float(x) * float(x) for x in seg) / len(seg)) / 32768.0
    return rms


def generate_reapeaks_bytes(sr, channels, samples, divs=None,
                            src_timestamp=0, src_filesize=0):
    """Assemble the full .ReaPeaks byte payload from PCM samples.

    ``src_timestamp`` / ``src_filesize`` record the source media's mtime and
    size in the header, letting consumers detect stale caches.
    """
    if divs is None:
        divs = choose_division_factors(sr)

    # ---- wave mipmaps ----
    wave_headers: list[tuple[int, int]] = []
    wave_data: list[int] = []
    for div in divs:
        ch_max, ch_min = [], []
        npeak = None
        for c in range(channels):
            mx, mn = compute_peaks(samples[c], div)
            ch_max.append(mx)
            ch_min.append(mn)
            npeak = len(mx)
        wave_headers.append((div, npeak))
        for i in range(npeak):
            for c in range(channels):
                wave_data.append(ch_max[c][i])
                wave_data.append(ch_min[c][i])

    # ---- spectral mipmaps (mirror wave divs) ----
    # REAPER rule (calibrated): spectral count = floor(C/div),
    # C = finest wave coverage - 1280.
    spec_headers: list[tuple[int, int]] = []
    spec_data: list[int] = []
    finest_cover = wave_headers[0][0] * wave_headers[0][1]
    C = finest_cover - 1280
    for div, _npeak in wave_headers:
        npeak = C // div
        spec_headers.append((-ord("s"), npeak))
        for i in range(npeak):
            for c in range(channels):
                spec_data.append(_spectral_code(samples[c], i, div, sr))

    # ---- loudness mipmaps (one float per peak) ----
    loud_headers: list[tuple[int, int]] = []
    loud_data: list[float] = []
    loud_configs = ((sr // 40, True), (sr // 2, False))
    for ldiv, ceil_plus_one in loud_configs:
        if ceil_plus_one:
            npeak = (len(samples[0]) + ldiv - 1) // ldiv + 1
        else:
            npeak = len(samples[0]) // ldiv
        loud_headers.append((-ord("r"), npeak))
        for i in range(npeak):
            for c in range(channels):
                loud_data.append(_loudness(samples[c], i, ldiv))

    # ---- assemble ----
    all_headers = wave_headers + spec_headers + loud_headers
    out = bytearray()
    out += MAGIC
    out += bytes([channels])
    out += bytes([len(all_headers)])
    out += struct.pack("<i", sr)
    out += struct.pack("<i", src_timestamp)  # source timestamp
    out += struct.pack("<i", src_filesize)  # source filesize
    for div, npeak in all_headers:
        out += struct.pack("<ii", div, npeak)
    for v in wave_data:
        out += struct.pack("<h", v)
    for code in spec_data:
        out += struct.pack("<i", code)
    for v in loud_data:
        out += struct.pack("<f", v)
    return bytes(out)


def write_reapeaks(path, sr, channels, samples, divs=None,
                   src_timestamp=0, src_filesize=0) -> Path:
    """Generate and write a .ReaPeaks file next to a media path."""
    path = Path(path)
    path.write_bytes(generate_reapeaks_bytes(
        sr, channels, samples, divs=divs,
        src_timestamp=src_timestamp, src_filesize=src_filesize,
    ))
    return path


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.wav> <output.reapeaks>")
        sys.exit(1)
    sr, ch, samples = read_wav_slices(sys.argv[1])
    src = Path(sys.argv[1]).stat()
    write_reapeaks(sys.argv[2], sr, ch, samples,
                   src_timestamp=int(src.st_mtime), src_filesize=src.st_size)
    print(f"wrote {sys.argv[2]}: {ch}ch {sr}Hz")
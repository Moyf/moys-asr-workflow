"""REAPER .ReaPeaks 生成器（RPKN v1.1）：wave + spectral + loudness 三层 mipmap。

流式实现：`_ReaPeaksStreamer` 逐块消费交错 int16 PCM，内存只保留
当前 bucket 累加器与 2048 样本的频谱滑动窗口，不再驻留完整 PCM 或
逐点 Python list。内存输入路径（`generate_reapeaks_bytes`）与 ffmpeg
pipe 路径共用同一流式内核，输出字节一致。

``numpy`` 仅在 FFT 与分块向量化处 lazy import，模块加载保持轻量。
"""
from __future__ import annotations

import math
import struct
import sys
import wave as wavlib
from pathlib import Path

MAGIC = b"RPKN"  # v1.1

HALF_FFT = 1024  # 2048 / 2，频谱窗口半宽


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


def _freq_density(seg, sr=48000, fftn=2048):
    """Dominant freq (Hz) and density from ONE FFT of the Hanning-windowed seg.

    Mathematically identical to the previous two-FFT version: freq from
    argmax + parabolic interpolation on non-DC bins, density from the spectral
    flatness of those same bins.
    """
    import numpy as np

    n = len(seg)
    if n < 8:
        return 0, 0
    buf = _spec_buf(seg, fftn)
    spec = np.abs(np.fft.rfft(buf))
    ac = spec[1:]  # drop DC

    if ac.size == 0:
        freq = 0.0
    else:
        idx = int(np.argmax(ac)) + 1
        if idx <= 0 or idx >= len(spec) - 1:
            freq = 0.0
        else:
            y0, y1, y2 = spec[idx - 1], spec[idx], spec[idx + 1]
            den = y0 - 2 * y1 + y2
            delta = float(0.5 * (y0 - y2) / den) if abs(den) > 1e-12 else 0.0
            freq = idx * (sr / fftn) + delta * (sr / fftn)

    if ac.size == 0 or ac.sum() <= 0:
        density = 0
    else:
        geo = np.exp(np.mean(np.log(np.maximum(ac, 1e-12))))
        arith = np.mean(ac)
        flatness = geo / arith if arith > 0 else 0
        if flatness <= 0:
            density = 0
        else:
            density = -2961.5 * math.log(flatness) + 3995.3
            density = max(1, min(16383, density))
    return freq, density


def _spectral_code(win, sr):
    """32-bit spectral code: freq(15 bits) | density<<15, from one window."""
    freq, density = _freq_density(win, sr)
    if freq <= 0 or density <= 0:
        return 0
    freq = int(round(freq))
    if freq > 0x7FFF:
        freq = 0x7FFF
    dens = int(round(density))
    if dens > 0x3FFF:
        dens = 0x3FFF
    return freq | (dens << 15)


class _ReaPeaksStreamer:
    """Incrementally build .ReaPeaks bytes from interleaved int16 PCM.

    Feed little-endian int16 chunks (channel-interleaved) with ``feed()`` and
    call ``finish()`` for the assembled bytes. Memory stays bounded: only the
    current per-layer bucket accumulators, a 2048-sample spectral history and
    the accumulated output bytearrays are retained.
    """

    def __init__(self, sample_rate: int, channels: int, divs=None) -> None:
        if channels < 1:
            raise ValueError("channels must be >= 1")
        self.sr = sample_rate
        self.channels = channels
        self.divs = list(divs or choose_division_factors(sample_rate))
        # wave: 每层每声道部分 bucket 累积 (maxs, mins, count)
        self._w_acc: list[tuple | None] = [None] * len(self.divs)
        self._w_out = [bytearray() for _ in self.divs]
        # spectral: 上一块尾部 2048 样本（窗口切片用）+ 每层下一个中心
        self._hist: "object | None" = None
        self._spec_next = [0] * len(self.divs)
        self._spec_out = [bytearray() for _ in self.divs]
        # loudness: 每层每声道平方和 + 计数
        self._loud_sq = [None, None]
        self._loud_cnt = [0, 0]
        self._loud_out = [bytearray(), bytearray()]
        self._total = 0  # 已消费帧数（每声道）
        self._carry: "object | None" = None  # 跨块不足一帧的 int16

    # ---------------- wave ----------------

    def _flush_wave(self, li: int, maxs, mins) -> None:
        out = self._w_out[li]
        for c in range(self.channels):
            out += struct.pack("<hh", int(maxs[c]), int(mins[c]))

    def _feed_wave(self, block) -> None:
        n = len(block)
        for li, div in enumerate(self.divs):
            acc = self._w_acc[li]
            start = 0
            if acc is not None:
                maxs, mins, count = acc
                take = min(div - count, n)
                part = block[:take]
                maxs = np_maximum(maxs, part.max(axis=0))
                mins = np_minimum(mins, part.min(axis=0))
                count += take
                start = take
                if count >= div:
                    self._flush_wave(li, maxs, mins)
                    self._w_acc[li] = None
                else:
                    self._w_acc[li] = (maxs, mins, count)
                    continue
            rest = block[start:]
            full = len(rest) // div * div
            if full:
                buckets = rest[:full].reshape(-1, div, self.channels)
                per_ch = [
                    (buckets[:, :, c].max(axis=1), buckets[:, :, c].min(axis=1))
                    for c in range(self.channels)
                ]
                for i in range(len(per_ch[0][0])):
                    for c in range(self.channels):
                        self._w_out[li] += struct.pack(
                            "<hh", int(per_ch[c][0][i]), int(per_ch[c][1][i])
                        )
            tail = rest[full:]
            if len(tail):
                self._w_acc[li] = (tail.max(axis=0), tail.min(axis=0), len(tail))

    # ---------------- spectral ----------------

    def _feed_spec(self, block) -> None:
        import numpy as np

        n = len(block)
        total_after = self._total + n
        hist = self._hist
        stream = np.concatenate([hist, block]) if hist is not None else block
        base = self._total - (len(hist) if hist is not None else 0)
        for li, div in enumerate(self.divs):
            center = self._spec_next[li]
            out = self._spec_out[li]
            while center + HALF_FFT <= total_after:
                s0 = max(0, center - HALF_FFT)
                win = stream[s0 - base : center + HALF_FFT - base]
                for c in range(self.channels):
                    out += struct.pack("<i", _spectral_code(win[:, c], self.sr))
                center += div
            self._spec_next[li] = center
        self._hist = block[-2048:].copy()

    # ---------------- loudness ----------------

    def _flush_loud(self, li: int, sq, count: int) -> None:
        out = self._loud_out[li]
        for c in range(self.channels):
            rms = math.sqrt(sq[c] / count) / 32768.0
            out += struct.pack("<f", rms)

    def _feed_loud(self, block) -> None:
        import numpy as np

        n = len(block)
        divs = (max(1, self.sr // 40), max(1, self.sr // 2))
        for li, div in enumerate(divs):
            sq = self._loud_sq[li]
            if sq is None:
                sq = np.zeros(self.channels, dtype=np.float64)
                self._loud_sq[li] = sq
            cnt = self._loud_cnt[li]
            start = 0
            if cnt > 0:
                take = min(div - cnt, n)
                sq += np.square(block[:take].astype(np.float64)).sum(axis=0)
                cnt += take
                start = take
                if cnt >= div:
                    self._flush_loud(li, sq, cnt)
                    self._loud_sq[li] = np.zeros(self.channels, dtype=np.float64)
                    sq = self._loud_sq[li]
                    cnt = 0
            rest = block[start:]
            full = len(rest) // div * div
            if full:
                buckets = rest[:full].reshape(-1, div, self.channels)
                sqsum = np.square(buckets.astype(np.float64)).sum(axis=1)
                for i in range(len(sqsum)):
                    for c in range(self.channels):
                        rms = math.sqrt(sqsum[i, c] / div) / 32768.0
                        self._loud_out[li] += struct.pack("<f", rms)
            tail = rest[full:]
            if len(tail):
                sq += np.square(tail.astype(np.float64)).sum(axis=0)
                cnt = len(tail)
            self._loud_sq[li] = sq
            self._loud_cnt[li] = cnt

    # ---------------- public ----------------

    def feed(self, interleaved: bytes | bytearray | memoryview) -> None:
        import numpy as np

        data = np.frombuffer(interleaved, dtype="<i2")
        if self._carry is not None:
            data = np.concatenate([self._carry, data])
            self._carry = None
        n = len(data) // self.channels
        if n == 0:
            self._carry = data
            return
        block = data[: n * self.channels].reshape(n, self.channels)
        self._feed_wave(block)
        self._feed_spec(block)
        self._feed_loud(block)
        self._total += n
        rem = len(data) - n * self.channels
        if rem:
            self._carry = data[n * self.channels :]

    def finish(self, src_timestamp: int = 0, src_filesize: int = 0) -> bytes:
        # wave 残留（不足一个 bucket 的尾部仍取 max/min）
        for li in range(len(self.divs)):
            acc = self._w_acc[li]
            if acc is not None:
                self._flush_wave(li, acc[0], acc[1])
                self._w_acc[li] = None
        # loudness：层1 残留入尾并 pad 到 npeak；层2 残留丢弃
        self._finish_loudness()
        # spectral 截断到 C//div（header 与旧实现一致，可为负）
        self._trim_spectral()
        return self._assemble(src_timestamp, src_filesize)

    def _finish_loudness(self) -> None:
        divs = (max(1, self.sr // 40), max(1, self.sr // 2))
        # 层1：ceil_plus_one，残留 flush + pad 到 npeak
        li = 0
        if self._loud_cnt[li] > 0:
            self._flush_loud(li, self._loud_sq[li], self._loud_cnt[li])
        npeak1 = (self._total + divs[0] - 1) // divs[0] + 1
        limit1 = npeak1 * self.channels * 4
        out1 = self._loud_out[li]
        if len(out1) < limit1:
            out1 += struct.pack("<f", 0.0) * ((limit1 - len(out1)) // 4)
        # 层2：floor，残留丢弃，无需 pad
        li = 1
        self._loud_out[li] = self._loud_out[li][: self._total // divs[1] * self.channels * 4]

    def _trim_spectral(self) -> None:
        finest_div = self.divs[0]
        finest_npeak = len(self._w_out[0]) // (self.channels * 4)
        c_total = finest_div * finest_npeak - 1280
        for li, div in enumerate(self.divs):
            npeak = c_total // div
            out = self._spec_out[li]
            limit = max(0, npeak) * self.channels * 4
            del out[limit:]

    def _assemble(self, src_timestamp: int, src_filesize: int) -> bytes:
        wave_headers = [
            (div, len(self._w_out[li]) // (self.channels * 4))
            for li, div in enumerate(self.divs)
        ]
        finest_div, finest_npeak = wave_headers[0]
        c_total = finest_div * finest_npeak - 1280
        spec_headers = [(-ord("s"), c_total // div) for div in self.divs]
        loud_divs = (max(1, self.sr // 40), max(1, self.sr // 2))
        loud_headers = [
            (-ord("r"), (self._total + loud_divs[0] - 1) // loud_divs[0] + 1),
            (-ord("r"), self._total // loud_divs[1]),
        ]
        all_headers = wave_headers + spec_headers + loud_headers
        out = bytearray()
        out += MAGIC
        out += bytes([self.channels])
        out += bytes([len(all_headers)])
        out += struct.pack("<i", self.sr)
        out += struct.pack("<i", src_timestamp)
        out += struct.pack("<i", src_filesize)
        for div, npeak in all_headers:
            out += struct.pack("<ii", div, npeak)
        for buf in self._w_out:
            out += buf
        for buf in self._spec_out:
            out += buf
        for buf in self._loud_out:
            out += buf
        return bytes(out)


def np_maximum(a, b):
    import numpy as np

    return np.maximum(a, b)


def np_minimum(a, b):
    import numpy as np

    return np.minimum(a, b)


def generate_reapeaks_bytes(sr, channels, samples, divs=None,
                            src_timestamp=0, src_filesize=0):
    """Assemble the full .ReaPeaks byte payload from PCM samples.

    ``samples`` is a list of per-channel int16 sequences (as before).  The
    payload is produced by the streaming core, so its bytes are identical to
    the pipe-fed path.
    """
    import numpy as np

    streamer = _ReaPeaksStreamer(sr, channels, divs=divs)
    if channels == 1:
        interleaved = np.asarray(samples[0], dtype="<i2").tobytes()
    else:
        interleaved = np.stack(samples, axis=1).astype("<i2").tobytes()
    streamer.feed(interleaved)
    return streamer.finish(src_timestamp=src_timestamp, src_filesize=src_filesize)


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
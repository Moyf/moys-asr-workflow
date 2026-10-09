"""Benchmark all generated audio types without creating the comparison HTML."""

from __future__ import annotations

import tempfile
from pathlib import Path

from build import benchmark_case, make_cases
from maw import quapeaks


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="maw-waveform-bench-") as directory:
        native_available = quapeaks._load_rust_kernel() is not None
        for case in make_cases(Path(directory)):
            result = benchmark_case(case, native_available=native_available)
            print(f"{case['label']}: 旧版 {result['oldMs']} ms / 新版 {result['newMs']} ms / quapeaks {result['quapeaksMs']} ms")
    print("320 秒素材；预热后各测 5 次中位数，均含 FFmpeg 解码，不含写缓存")


if __name__ == "__main__":
    main()

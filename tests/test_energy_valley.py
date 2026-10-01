# pyright: reportAny=false, reportImplicitOverride=false, reportPrivateUsage=false

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    import numpy as np
    import soundfile as sf
except ImportError:  # pragma: no cover - 取决于安装的依赖组
    np = None
    sf = None

from maw.energy_valley import FRAME_MS, rms_envelope, snap_boundaries_to_valleys, snap_cue_boundaries

SAMPLE_RATE = 16_000

requires_numpy = unittest.skipUnless(np is not None, "numpy is required for energy valley snapping")


def _write_wav(path: Path, samples: "np.ndarray") -> Path:
    assert sf is not None
    sf.write(str(path), samples, SAMPLE_RATE, subtype="PCM_16")
    return path


def _loud(seconds: float, amplitude: float = 0.4) -> "np.ndarray":
    assert np is not None
    t = np.linspace(0.0, seconds, int(SAMPLE_RATE * seconds), endpoint=False)
    return (amplitude * np.sin(2.0 * np.pi * 220.0 * t)).astype(np.float32)


def _silence(seconds: float) -> "np.ndarray":
    assert np is not None
    return np.zeros(int(SAMPLE_RATE * seconds), dtype=np.float32)


@requires_numpy
class RmsEnvelopeTests(unittest.TestCase):
    def test_envelope_marks_silence_as_minimum(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = _write_wav(Path(root) / "audio.wav", np.concatenate([_loud(1.0), _silence(1.0), _loud(1.0)]))

            envelope, frame_seconds = rms_envelope(path)

            self.assertEqual(frame_seconds, FRAME_MS / 1000)
            self.assertGreaterEqual(envelope.size, 28)
            quiet_index = int(envelope.argmin())
            quiet_center = (quiet_index + 0.5) * frame_seconds
            self.assertGreaterEqual(quiet_center, 0.95)
            self.assertLessEqual(quiet_center, 2.05)
            self.assertLess(float(envelope.min()), 0.1 * float(envelope.max()))

    def test_envelope_of_missing_file_raises(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(RuntimeError):
                rms_envelope(Path(root) / "missing.wav")


@requires_numpy
class SnapBoundaryTests(unittest.TestCase):
    def test_boundary_snaps_into_nearby_silence(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = _write_wav(Path(root) / "audio.wav", np.concatenate([_loud(1.5), _silence(0.3), _loud(1.2)]))
            envelope, frame_seconds = rms_envelope(path)
            segments = [
                {"start": 0, "end": 1400},
                {"start": 1400, "end": 3000},
            ]

            moved = snap_boundaries_to_valleys(segments, envelope, frame_seconds)

            self.assertEqual(moved, 1)
            self.assertGreaterEqual(segments[0]["end"], 1450)
            self.assertLessEqual(segments[0]["end"], 1800)
            self.assertEqual(segments[1]["start"], segments[0]["end"])
            self.assertLess(segments[0]["end"], segments[1]["end"])

    def test_flat_loud_window_keeps_the_interpolated_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = _write_wav(Path(root) / "audio.wav", _loud(3.0))
            envelope, frame_seconds = rms_envelope(path)
            segments = [
                {"start": 0, "end": 1200},
                {"start": 1200, "end": 3000},
            ]

            moved = snap_boundaries_to_valleys(segments, envelope, frame_seconds)

            self.assertEqual(moved, 0)
            self.assertEqual([segment["end"] for segment in segments], [1200, 3000])

    def test_word_timed_cues_are_never_moved(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = _write_wav(Path(root) / "audio.wav", np.concatenate([_loud(1.5), _silence(0.3), _loud(1.2)]))
            envelope, frame_seconds = rms_envelope(path)
            segments = [
                {"start": 0, "end": 1400, "items": [{"start": 0, "end": 1400, "text": "真时码"}]},
                {"start": 1400, "end": 3000},
            ]

            moved = snap_boundaries_to_valleys(segments, envelope, frame_seconds)

            self.assertEqual(moved, 0)
            self.assertEqual(segments[0]["end"], 1400)

    def test_multiple_boundaries_stay_monotonic(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = _write_wav(Path(root) / "audio.wav", np.concatenate([_loud(1.5), _silence(0.3), _loud(1.5)]))
            envelope, frame_seconds = rms_envelope(path)
            segments = [
                {"start": 0, "end": 800},
                {"start": 800, "end": 1600},
                {"start": 1600, "end": 3000},
            ]

            moved = snap_boundaries_to_valleys(segments, envelope, frame_seconds)

            ends = [segment["end"] for segment in segments]
            starts = [segment["start"] for segment in segments]
            self.assertEqual(ends, starts[1:] + [3000])
            self.assertLessEqual(moved, 2)

    def test_snap_cue_boundaries_degrades_to_noop_for_unreadable_audio(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            segments = [{"start": 0, "end": 1200}, {"start": 1200, "end": 2400}]

            moved = snap_cue_boundaries(segments, Path(root) / "missing.wav")

            self.assertEqual(moved, 0)
            self.assertEqual([segment["end"] for segment in segments], [1200, 2400])


class AudioDependencyDegradationTests(unittest.TestCase):
    """numpy / soundfile 不在默认依赖组：缺失时必须整体静默降级。

    云端转写 CLI（默认依赖组）也顶层导入本模块——导入失败会直接崩掉
    转写入口；这条守卫对应「缺依赖时 snap 静默跳过」的契约，且不依赖
    任何音频库即可运行。
    """

    def test_import_succeeds_and_snap_noops_without_audio_libraries(self) -> None:
        with mock.patch("maw.energy_valley.np", None), mock.patch("maw.energy_valley.sf", None):
            segments = [{"start": 0, "end": 1200}, {"start": 1200, "end": 2400}]

            moved = snap_cue_boundaries(segments, "irrelevant.wav")

        self.assertEqual(moved, 0)
        self.assertEqual([segment["end"] for segment in segments], [1200, 2400])


if __name__ == "__main__":
    unittest.main()

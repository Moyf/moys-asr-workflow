"""Whole-file LUFS is measured separately from quapeaks RMS, with fixed gain."""
from __future__ import annotations

import json
import math
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from maw.audio_loudness import LoudnessAnalyzer, _AnalysisCancelled, parse_loudnorm_report, validate_gain_db


class LoudnessTests(unittest.TestCase):
    def test_gain_and_report_reject_nonfinite_and_preserve_silence(self):
        for bad in (True, None, '6', math.nan, math.inf, -61, 25, 10**400):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_gain_db(bad)
        self.assertEqual(validate_gain_db(6), 6)
        for integrated, peak in [('-inf', '-inf'), ('-inf', '-82.0')]:
            result = parse_loudnorm_report(json.dumps({'input_i': integrated, 'input_tp': peak}))
            self.assertEqual(result['status'], 'silence')
            self.assertIsNone(result['integratedLufs'])
        for report in ('missing', '{"input_i":"nan","input_tp":"-3"}', '{}'):
            with self.subTest(report=report), self.assertRaises(ValueError):
                parse_loudnorm_report(report)

    def test_cache_reuses_worker_selects_default_track_and_invalidates_media(self):
        with tempfile.TemporaryDirectory() as temporary:
            media = Path(temporary).resolve() / 'a.mp4'
            media.write_bytes(b'original')
            analyzer = LoudnessAnalyzer()
            self.addCleanup(analyzer.close)
            entered, release = threading.Event(), threading.Event()
            calls = []

            def run(command, cancelled):
                calls.append(command)
                if command[0] == 'probe':
                    return subprocess.CompletedProcess(command, 0, json.dumps({'streams': [
                        {'disposition': {'default': 0}}, {'disposition': {'default': 1}}]}), '')
                entered.set()
                self.assertTrue(release.wait(3))
                return subprocess.CompletedProcess(command, 0, '', '{"input_i":"-28","input_tp":"-7"}')

            with mock.patch.object(analyzer, '_run', side_effect=run):
                first = analyzer.request(media, (1, 'a'), Path('meter'), Path('probe'))
                self.assertTrue(entered.wait(3))
                again = analyzer.request(media, (1, 'a'), Path('meter'), Path('probe'), force=True)
                self.assertEqual(first, again)
                self.assertEqual(len(calls), 2)
                release.set()
                analyzer.thread.join(3)
                result = analyzer.request(media, (1, 'a'), Path('meter'), Path('probe'))
                self.assertEqual(result['status'], 'measured')
                self.assertEqual(result['audioTrack'], 1)
                self.assertEqual(calls[1][calls[1].index('-map') + 1], '0:a:1')
                self.assertEqual(len(calls), 2)
                media.write_bytes(b'changed source size')
                changed = analyzer.request(media, (1, 'a'), Path('meter'), Path('probe'))
                self.assertNotEqual(result['sourceFingerprint'], changed['sourceFingerprint'])
                analyzer.thread.join(3)

    def test_cancelled_late_result_and_errors_never_replace_current_binding(self):
        with tempfile.TemporaryDirectory() as temporary:
            media = Path(temporary).resolve() / 'a.wav'
            media.write_bytes(b'media')
            analyzer = LoudnessAnalyzer()
            self.addCleanup(analyzer.close)
            entered, release = threading.Event(), threading.Event()

            def delayed(command, cancelled):
                entered.set()
                release.wait(3)
                return subprocess.CompletedProcess(command, 0, '{"streams":[]}', '')

            with mock.patch.object(analyzer, '_run', side_effect=delayed):
                analyzer.request(media, (1, 'old'), Path('meter'), Path('probe'))
                self.assertTrue(entered.wait(3))
                worker = analyzer.thread
                analyzer.invalidate()
                release.set()
                worker.join(3)
                self.assertEqual(analyzer.result, {})
            with mock.patch.object(analyzer, '_run', side_effect=OSError('private path')) as run:
                analyzer.request(media, (2, 'new'), Path('meter'), Path('probe'))
                analyzer.thread.join(3)
                result = analyzer.request(media, (2, 'new'), Path('meter'), Path('probe'))
                self.assertEqual(result['status'], 'error')
                self.assertEqual(run.call_count, 1)
                self.assertNotIn('private path', str(result))

    def test_run_cancellation_reaps_a_live_owned_process(self):
        cancelled = threading.Event()
        process = mock.Mock()
        process.poll.return_value = None
        def wait(**kwargs):
            cancelled.set()
            raise subprocess.TimeoutExpired('meter', .25)
        process.communicate.side_effect = lambda **kwargs: wait(**kwargs) if not cancelled.is_set() else ('', '')
        with mock.patch('maw.audio_loudness.popen_process_tree', return_value=process), \
             mock.patch('maw.audio_loudness.terminate_process_tree') as terminate, \
             mock.patch('maw.audio_loudness.release_process_tree') as release:
            with self.assertRaises(_AnalysisCancelled):
                LoudnessAnalyzer._run(['meter'], cancelled)
            terminate.assert_called_once_with(process)
            release.assert_called_once_with(process)


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg/FFprobe required')
class RealLoudnessTests(unittest.TestCase):
    def test_real_tone_gain_silence_and_no_audio(self):
        ffmpeg, ffprobe = Path(shutil.which('ffmpeg')), Path(shutil.which('ffprobe'))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            analyzer = LoudnessAnalyzer()
            self.addCleanup(analyzer.close)
            def encode(name, source, gain=None):
                path = root / name
                command = [str(ffmpeg), '-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-t', '2']
                if gain is not None:
                    command += ['-af', f'volume={gain}dB']
                subprocess.run([*command, str(path)], check=True, capture_output=True, timeout=30)
                return path
            def measure(path):
                analyzer.request(path, (1, 'source'), ffmpeg, ffprobe)
                analyzer.thread.join(30)
                self.assertFalse(analyzer.thread.is_alive())
                return analyzer.request(path, (1, 'source'), ffmpeg, ffprobe)
            original = measure(encode('tone.wav', 'sine=frequency=1000:sample_rate=48000'))
            gained = measure(encode('gain.wav', 'sine=frequency=1000:sample_rate=48000', 6))
            self.assertEqual(original['status'], 'measured')
            self.assertAlmostEqual(gained['integratedLufs'] - original['integratedLufs'], 6, delta=.15)
            self.assertAlmostEqual(gained['truePeakDbtp'] - original['truePeakDbtp'], 6, delta=.15)
            silence = measure(encode('silence.wav', 'anullsrc=r=48000:cl=mono'))
            self.assertEqual(silence['status'], 'silence')
            self.assertIsNone(silence['integratedLufs'])
            video = measure(encode('silent.mp4', 'color=c=black:s=32x32:r=10'))
            self.assertEqual(video['status'], 'no_audio')


if __name__ == '__main__':
    unittest.main()

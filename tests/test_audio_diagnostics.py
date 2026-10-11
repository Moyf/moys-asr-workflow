from __future__ import annotations

import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from maw.audio_diagnostics import (
    _analysis_seconds,
    _measure_peak,
    diagnose_empty_audio,
    is_audio_mapping_error,
    is_empty_transcription_error,
)
from maw.ffmpeg import FfmpegTools, resolve_ffmpeg_tools


class AudioDiagnosticsTests(unittest.TestCase):
    def diagnose(self, tracks, peaks=(), **kwargs):
        with mock.patch('maw.audio_diagnostics.resolve_ffmpeg_tools', return_value=FfmpegTools(Path('ffmpeg'), Path('ffprobe'))), \
                mock.patch('maw.audio_diagnostics.probe_audio_tracks', return_value=tracks), \
                mock.patch('maw.audio_diagnostics._measure_peak', side_effect=peaks) as measure:
            error = diagnose_empty_audio(Path('clip.mkv'), kwargs.pop('audio_track', 0), **kwargs)
        return error, measure

    def test_no_streams_is_distinct_from_probe_failure(self):
        for tracks, expected in (([], 'audio_tracks_missing'), (None, 'asr_empty_result')):
            error, measure = self.diagnose(tracks)
            self.assertEqual(error.code, expected)
            measure.assert_not_called()

    def test_invalid_selection_does_not_silently_use_the_default_track(self):
        error, measure = self.diagnose([{'audio_index': 0}], audio_track=1)
        self.assertEqual(error.code, 'audio_track_invalid')
        measure.assert_not_called()

    def test_quiet_selected_track_and_stronger_alternative_are_only_a_suggestion(self):
        error, measure = self.diagnose([{'audio_index': i} for i in range(3)], [-90, -20], audio_track=2, length_limit='5s')
        self.assertEqual(error.code, 'asr_audio_track_mismatch')
        self.assertIn('selected audio_index=2', str(error))
        self.assertIn('audio_index=0 peak_dBFS=-20', str(error))
        self.assertEqual([call.args[1] for call in measure.call_args_list], [2, 0])
        self.assertTrue(all(call.args[3] == 5 for call in measure.call_args_list))

    def test_signal_does_not_prove_speech_or_noise(self):
        for peak in (-20, -59.9, None):
            error, measure = self.diagnose([{'audio_index': 0}, {'audio_index': 1}], [peak])
            self.assertEqual(error.code, 'asr_empty_result')
            self.assertEqual(measure.call_count, 1)
            self.assertIn('speech/noise not determined', str(error))

    def test_all_quiet_and_unchecked_tracks_do_not_claim_whole_recording_silence(self):
        error, measure = self.diagnose([{'audio_index': i} for i in range(7)], [-float('inf'), -70, None, -80])
        self.assertEqual(error.code, 'asr_audio_quiet')
        self.assertEqual(measure.call_count, 4)
        self.assertIn('checked first up to 60s', str(error))

    def test_analysis_respects_short_test_run_and_caps_long_recordings(self):
        for value, expected in (('2m', 60), ('0.5m', 30), ('5s', 5), ('1h', 60), ('', 60), ('..s', 60)):
            self.assertEqual(_analysis_seconds(value), expected)

    def test_cancelled_check_does_not_launch_tools(self):
        cancel = threading.Event()
        cancel.set()
        with mock.patch('maw.audio_diagnostics.resolve_ffmpeg_tools') as resolve:
            self.assertEqual(diagnose_empty_audio(Path('clip.mkv'), 0, cancel_event=cancel).code, 'asr_empty_result')
        resolve.assert_not_called()

    def test_only_explicit_final_asr_empty_or_mapping_failures_trigger_diagnosis(self):
        self.assertTrue(is_empty_transcription_error(['RuntimeError: ASR 返回内容为空，未生成字幕段。']))
        self.assertTrue(is_empty_transcription_error(['错误: 本地模型没有返回可用的转写文本']))
        self.assertTrue(is_empty_transcription_error(['错误: 未识别到任何内容']))
        self.assertFalse(is_empty_transcription_error(['RuntimeError: 上传凭证响应为空: {}']))
        self.assertFalse(is_empty_transcription_error(['[warning] empty ASR response', 'RuntimeError: HTTP 401']))
        self.assertFalse(is_empty_transcription_error(['RuntimeError: ASR 返回内容为空，未生成字幕段。', 'RuntimeError: HTTP 401']))
        self.assertTrue(is_audio_mapping_error(["Stream map '0:a:0' matches no streams."]))
        self.assertTrue(is_audio_mapping_error(["subprocess.CalledProcessError: Command ['ffmpeg', '-map', '0:a:0'] returned non-zero exit status 1."]))
        self.assertFalse(is_audio_mapping_error(['HTTP 401']))

    def test_signal_timeout_or_cancel_terminates_owned_process(self):
        process = mock.Mock()
        process.poll.return_value = None
        cancel = threading.Event()

        def communicate(**kwargs):
            cancel.set()
            raise subprocess.TimeoutExpired('ffmpeg', 0.1)

        process.communicate.side_effect = communicate
        with mock.patch('maw.audio_diagnostics.popen_process_tree', return_value=process), \
                mock.patch('maw.audio_diagnostics.terminate_process_tree') as terminate, \
                mock.patch('maw.audio_diagnostics.release_process_tree') as release:
            import time
            self.assertIsNone(_measure_peak(Path('clip.mkv'), 1, Path('ffmpeg'), 60, time.monotonic() + 20, cancel))
        terminate.assert_called_once_with(process, timeout=1)
        release.assert_called_once_with(process)

    def test_no_decoded_samples_or_corrupt_statistics_are_inconclusive(self):
        for stderr in (b'Peak level dB: -inf\nNumber of samples: 0',
                       b'Peak level dB: nan\nNumber of samples: 20', b''):
            process = mock.Mock(returncode=0)
            process.communicate.return_value = (None, stderr)
            process.poll.return_value = 0
            with mock.patch('maw.audio_diagnostics.popen_process_tree', return_value=process), \
                    mock.patch('maw.audio_diagnostics.release_process_tree'):
                import time
                self.assertIsNone(_measure_peak(Path('clip.mkv'), 0, Path('ffmpeg'), 60, time.monotonic() + 20, None))


@unittest.skipUnless(os.environ.get('MAW_TEST_AUDIO_FFMPEG') == '1', 'Set MAW_TEST_AUDIO_FFMPEG=1 for real FFmpeg fixtures')
class AudioDiagnosticsFfmpegTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tools = resolve_ffmpeg_tools()
        if not cls.tools.complete:
            raise unittest.SkipTest('FFmpeg/FFprobe are unavailable')
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def generate(self, name, *args):
        output = self.root / name
        subprocess.run([str(self.tools.ffmpeg), '-nostdin', '-v', 'error', '-y', *args, str(output)],
                       check=True, capture_output=True, timeout=20)
        return output

    def test_silent_selected_track_with_audible_alternative_and_reverse_selection(self):
        source = self.generate('multitrack.mkv', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
                               '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
                               '-map', '0:a', '-map', '1:a', '-t', '1', '-c:a', 'pcm_s16le')
        error = diagnose_empty_audio(source, 0)
        self.assertEqual(error.code, 'asr_audio_track_mismatch')
        self.assertIn('audio_index=1', str(error))
        self.assertEqual(diagnose_empty_audio(source, 1).code, 'asr_empty_result')

    def test_video_without_audio_and_silent_audio_are_distinct(self):
        video = self.generate('no-audio.mkv', '-f', 'lavfi', '-i', 'color=size=16x16:rate=5', '-t', '1', '-an', '-c:v', 'ffv1')
        silent = self.generate('silent.wav', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=stereo', '-t', '1', '-c:a', 'pcm_s16le')
        self.assertEqual(diagnose_empty_audio(video, 0).code, 'audio_tracks_missing')
        self.assertEqual(diagnose_empty_audio(silent, 0).code, 'asr_audio_quiet')

    def test_opposite_phase_stereo_is_not_misclassified_by_downmix(self):
        source = self.generate('antiphase.wav', '-f', 'lavfi', '-i', 'aevalsrc=sin(440*2*PI*t)|-sin(440*2*PI*t):s=16000',
                               '-t', '1', '-c:a', 'pcm_s16le')
        self.assertEqual(diagnose_empty_audio(source, 0).code, 'asr_empty_result')

    def test_short_test_range_does_not_use_later_sound_as_evidence(self):
        source = self.generate('intro.wav', '-f', 'lavfi', '-i', r'aevalsrc=if(lt(t\,0.5)\,0\,sin(440*2*PI*t)):s=16000',
                               '-t', '1', '-c:a', 'pcm_s16le')
        self.assertEqual(diagnose_empty_audio(source, 0, length_limit='0.2s').code, 'asr_audio_quiet')
        self.assertEqual(diagnose_empty_audio(source, 0).code, 'asr_empty_result')

from __future__ import annotations

import unittest
from unittest import mock

from maw.audio_diagnostics import empty_transcription_error, is_empty_transcription_error, is_audio_extraction_failure


class EmptyAsrResultTests(unittest.TestCase):
    def test_only_final_audio_extraction_failures_add_possible_causes_without_processes(self):
        import subprocess
        valid = ['ffmpeg', '-map', '0:a:4', '-vn', 'audio.wav']
        invalid = [
            ['ffprobe', '-map', '0:a:0', '-vn'],
            ['ffmpeg', '-map', '0:v:0', '-vn'],
            ['ffmpeg', '-i', 'clip.mp4', 'clip.wav'],
            ['ffmpeg', '-map', '0:a:0', 'clip.mp4'],
        ]
        def line(command):
            return 'subprocess.CalledProcessError: ' + str(subprocess.CalledProcessError(1, command))
        with mock.patch('subprocess.Popen', side_effect=AssertionError('No decode')), \
                mock.patch('subprocess.run', side_effect=AssertionError('No probe')):
            self.assertTrue(is_audio_extraction_failure([line(valid)]))
            for command in invalid:
                self.assertFalse(is_audio_extraction_failure([line(command)]))
            self.assertFalse(is_audio_extraction_failure([line(valid), 'RuntimeError: HTTP 401']))
            self.assertFalse(is_audio_extraction_failure(['RuntimeError: quoted ' + line(valid)]))
            self.assertFalse(is_audio_extraction_failure(['[warning] Stream map \'0:a:0\' matches no streams.']))
            self.assertFalse(is_audio_extraction_failure(["Stream map '0:a:0' matches no streams.", 'HTTP 401']))
            self.assertFalse(is_audio_extraction_failure([]))
    def test_only_known_multiple_tracks_add_the_selection_hint(self):
        for count in (None, 0, 1, True, '2', 2.0):
            self.assertEqual(empty_transcription_error(count).code, 'asr_empty_result')
        for count in (2, 5):
            error = empty_transcription_error(count, audio_track=1, detail='original ASR output')
            self.assertEqual(error.code, 'asr_empty_result_multitrack')
            self.assertIn('original ASR output', str(error))
            self.assertIn('selected audio_index=1', str(error))

    def test_empty_result_never_decodes_or_probes_audio(self):
        with mock.patch('subprocess.Popen', side_effect=AssertionError('No decode')), \
                mock.patch('subprocess.run', side_effect=AssertionError('No probe')), \
                mock.patch('maw.media.probe_audio_tracks', side_effect=AssertionError('No reinspection')):
            self.assertEqual(empty_transcription_error(3).code, 'asr_empty_result_multitrack')

    def test_explicit_cloud_and_local_empty_failures_are_recognized(self):
        for line in ('RuntimeError: ASR 返回内容为空，未生成字幕段。',
                     '错误: 本地模型没有返回可用的转写文本', '错误: 未识别到任何内容'):
            self.assertTrue(is_empty_transcription_error(['progress', line]))

    def test_earlier_or_quoted_empty_errors_do_not_override_the_final_cause(self):
        for lines in (['RuntimeError: 上传凭证响应为空: {}'],
                      ['RuntimeError: ASR 返回内容为空，未生成字幕段。', 'RuntimeError: HTTP 401'],
                      ["Stream map '0:a:0' matches no streams.", 'RuntimeError: HTTP 401'],
                      ['RuntimeError: unrelated error quoting RuntimeError: ASR 返回内容为空，未生成字幕段。']):
            self.assertFalse(is_empty_transcription_error(lines))

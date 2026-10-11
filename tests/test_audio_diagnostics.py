from __future__ import annotations

import unittest
from unittest import mock

from maw.audio_diagnostics import empty_transcription_error, is_empty_transcription_error


class EmptyAsrResultTests(unittest.TestCase):
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

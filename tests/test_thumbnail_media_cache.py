from __future__ import annotations

import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw import media_cache, thumbnail_jobs


class ThumbnailMediaCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.source=self.root/'original.mp4'
        self.source.write_bytes(b'video')
        self.wav=self.root/'derived.wav'
        self.wav.write_bytes(b'audio')
        self.project={'segments':[{'start':0,'end':1000,'text':'Keep'}]}
        wave=mock.patch.object(media_cache,'embed_waveform',side_effect=lambda project,*args,**kwargs:SimpleNamespace(project=project,error=ValueError('no audio')))
        rea=mock.patch.object(media_cache.quapeaks,'generate_for_media',return_value=None)
        wave.start()
        rea.start()
        self.addCleanup(wave.stop)
        self.addCleanup(rea.stop)
        from maw import thumbnail_cache
        self.clean = mock.patch.object(thumbnail_cache, "cleanup_registered", return_value={"removed_count":0})
        self.cleaner = self.clean.start()
        self.addCleanup(self.clean.stop)

    def test_original_video_not_temporary_wav_and_result_stays_outside_project(self):
        manifest={'state':'ready','cache_hit':False,'samples':[{'asset':'opaque'}]}
        with mock.patch.object(thumbnail_jobs,'build_base',return_value=manifest) as build:
            result=media_cache.embed_media_caches(self.project,self.wav,source_media_path=self.source,audio_track=2)
        self.assertEqual(build.call_args.args[0],self.source)
        # waveform candidates normalize Windows short-path aliases.
        excluded = [path.resolve() for path in self.cleaner.call_args.kwargs["exclude_paths"]]
        self.assertIn(self.source.with_name(self.source.name+".mothumbs").resolve(), excluded)
        self.assertEqual(self.cleaner.call_args.kwargs["limit"],8)
        self.assertIs(result.thumbnail_cache,manifest)
        self.assertNotIn('thumbnail_cache',result.project)
        merged=media_cache.merge_media_caches({'segments':self.project['segments']},result)
        self.assertNotIn('thumbnail_cache',merged)
        self.assertEqual(merged['media_metadata']['selected_audio_track'],2)

    def test_default_thumbnail_progress_reaches_launcher_output(self):
        output = io.StringIO()
        def build_with_progress(path, *, progress, **kwargs):
            progress("[thumbnails] 1/2")
            progress("[thumbnails] 2/2")
            return {"state": "ready", "persisted": True}
        with mock.patch.object(thumbnail_jobs, "build_base", side_effect=build_with_progress), contextlib.redirect_stdout(output):
            media_cache.embed_media_caches(self.project, self.source)
        self.assertIn("[thumbnails] 1/2", output.getvalue())
        self.assertIn("[thumbnails] 2/2", output.getvalue())

    def test_video_source_missing_never_uses_derived_audio_for_thumbnails(self):
        self.source.rename(self.root/'moved.mp4')
        with mock.patch.object(thumbnail_jobs,'build_base',side_effect=FileNotFoundError('source missing')) as build:
            result=media_cache.embed_media_caches(self.project,self.wav,source_media_path=self.source)
        self.assertEqual(build.call_args.args[0],self.source)
        self.assertIsInstance(result.thumbnail_error,FileNotFoundError)
        self.assertEqual(result.project['segments'],self.project['segments'])

    def test_thumbnail_failure_is_best_effort_and_cancellation_is_forwarded(self):
        cancel=mock.Mock()
        progress=mock.Mock()
        with mock.patch.object(thumbnail_jobs,'build_base',side_effect=RuntimeError('optional decoder failed')) as build:
            result=media_cache.embed_media_caches(self.project,self.source,cancel=cancel,
                thumbnail_progress=progress,ffmpeg_bin='chosen-ffmpeg')
        self.assertIs(build.call_args.kwargs['cancel'],cancel)
        self.assertIs(build.call_args.kwargs['progress'],progress)
        self.assertEqual(build.call_args.kwargs['ffmpeg_path'],'chosen-ffmpeg')
        self.assertEqual(result.project['segments'],self.project['segments'])
        self.assertIsInstance(result.thumbnail_error,RuntimeError)

    def test_audio_unavailable_is_optional_and_no_inline_image_keys(self):
        with mock.patch.object(thumbnail_jobs,'build_base',return_value={'state':'unavailable','samples':[]}) as build:
            result=media_cache.embed_media_caches(self.project,self.wav)
        self.assertEqual(build.call_args.args[0],self.wav)
        self.assertIsNone(result.thumbnail_error)
        self.assertEqual(result.thumbnail_cache['state'],'unavailable')
        self.assertEqual(set(result.project),{'segments','media_metadata'})

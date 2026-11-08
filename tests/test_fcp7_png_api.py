import os
import shutil
import tempfile
import threading
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock
from xml.sax.saxutils import escape
from urllib.parse import unquote

from tests import test_burn_video_export as burn_fixture
from tests.test_fcp7_png import HEADER, event
from maw import fcp7_png_api


class PngJobHttpTests(unittest.TestCase):
    request = burn_fixture.BurnVideoJobHttpTests.request
    payload = burn_fixture.BurnVideoJobHttpTests.payload
    wait = burn_fixture.BurnVideoJobHttpTests.wait
    tearDown = burn_fixture.BurnVideoJobHttpTests.tearDown

    def setUp(self):
        burn_fixture.BurnVideoJobHttpTests.setUp(self)
        self.base = '/api/exports/fcp7-png/jobs'

    def png_request(self, **overrides):
        return self.payload(ass=HEADER + event(), fps='25', width=320, height=180,
                            durationMs=3000, layers=[0], **overrides)

    def fake_render(self, job, plan, ffmpeg, package):
        images = job.directory / 'images'
        images.mkdir()
        (images / 'one.png').write_bytes(b'fixture image')
        return {'tracks': [{'clips': [{'path': str(package / 'images' / 'one.png')}]}],
                'packagePath': str(package), 'imageCount': 1}

    def start_fake(self, render=None):
        with mock.patch.object(self.server_editor, 'editor_ffmpeg_tools', return_value=mock.Mock(ffmpeg=Path('ffmpeg'))), \
             mock.patch.object(self.server, 'ensure_libass_supported', return_value=True), \
             mock.patch.object(fcp7_png_api, 'render_png_assets', side_effect=render or self.fake_render):
            status, result = self.request(self.base, self.png_request())
            self.assertEqual(status, 202, result)
            ready = self.wait(result['jobId'], 'ready')
        return result['jobId'], ready['manifest']

    def xml(self, manifest):
        uri = Path(manifest['tracks'][0]['clips'][0]['path']).as_uri()
        return '<!DOCTYPE xmeml><xmeml version="5"><file><pathurl>' + escape(uri) + '</pathurl></file></xmeml>'

    def test_token_binding_and_bad_plan_rejected_before_render(self):
        self.assertEqual(self.request(self.base, {}, token=False)[0], 403)
        self.assertEqual(self.request(self.base, self.png_request(bindingGeneration=-1))[0], 409)
        bad = self.png_request()
        bad['width'] = 0
        self.assertEqual(self.request(self.base, bad)[0], 400)
        for value in (None, 'jpeg', [], {}):
            self.assertEqual(self.request(self.base, self.png_request(imageFormat=value))[0], 400)
        self.assertIsNone(self.server.media_jobs.active)

    def test_image_package_is_published_next_to_project(self):
        with mock.patch.object(self.server_editor, 'editor_ffmpeg_tools', return_value=mock.Mock(ffmpeg=Path('ffmpeg'))), \
             mock.patch.object(self.server, 'ensure_libass_supported', return_value=True), \
             mock.patch.object(fcp7_png_api, 'render_png_assets', side_effect=self.fake_render):
            status, result = self.request(self.base, self.png_request(outputDirectory=str(self.root / 'other')))
            self.assertEqual(status, 202, result)
            manifest = self.wait(result['jobId'], 'ready')['manifest']
        package = Path(manifest['packagePath'])
        self.assertEqual(package.parent, self.server.project.json_path.parent)
        status, result = self.request(self.base + '/' + result['jobId'] + '/publish', self.payload(xml=self.xml(manifest)))
        self.assertEqual(status, 200, result)
        self.assertTrue((package / 'images' / 'one.png').is_file())
        self.assertTrue((package / 'subtitles.xml').is_file())
        self.assertIn(Path(manifest['tracks'][0]['clips'][0]['path']).as_uri(), (package / 'subtitles.xml').read_text('utf-8'))
    @unittest.skipUnless(shutil.which('ffmpeg'), 'real FFmpeg unavailable')
    def test_render_publish_and_repeated_export_preserve_prior_package(self):
        with mock.patch.object(self.server_editor, 'editor_ffmpeg_tools', return_value=mock.Mock(
                ffmpeg=Path(shutil.which('ffmpeg')), ffprobe=None)):
            paths = []
            for image_format in (None, 'webp', 'png'):
                status, result = self.request(self.base, self.png_request(
                    **({} if image_format is None else {'imageFormat': image_format})))
                self.assertEqual(status, 202, result)
                ready = self.wait(result['jobId'], 'ready')
                manifest = ready['manifest']
                expected_format = image_format or 'png'
                self.assertEqual(manifest['imageFormat'], expected_format)
                package = Path(manifest['packagePath'])
                self.assertFalse(package.exists())
                urls = ''.join('<file><pathurl>' + escape(Path(c['path']).as_uri()) + '</pathurl></file>'
                               for t in manifest['tracks'] for c in t['clips'])
                xml = '<!DOCTYPE xmeml><xmeml version="5"><sequence>' + urls + '</sequence></xmeml>'
                status, published = self.request(self.base + '/' + result['jobId'] + '/publish', self.payload(xml=xml))
                self.assertEqual(status, 200, published)
                self.assertTrue(Path(published['xmlPath']).is_file())
                vegas_xml = Path(published['vegasXmlPath'])
                self.assertEqual(vegas_xml.parent, package)
                self.assertEqual(vegas_xml.name, 'subtitles-vegas.xml')
                vegas_tree = ET.fromstring(vegas_xml.read_text('utf-8').replace('<!DOCTYPE xmeml>', ''))
                self.assertEqual({Path(unquote(e.text)).resolve() for e in vegas_tree.iter('pathurl')},
                                 {Path(c['path']).resolve() for t in manifest['tracks'] for c in t['clips']})
                self.assertEqual(Path(published['xmlPath']).read_text('utf-8'), xml)
                self.assertEqual(len(list((package / 'images').glob('*.' + expected_format))), manifest['imageCount'])
                self.assertIsNone(self.server.media_jobs.active)
                paths.append(package)
            self.assertNotEqual(paths[0], paths[1])
            self.assertTrue(all((p / 'subtitles.xml').is_file() for p in paths))
            self.assertTrue(all((p / 'subtitles-vegas.xml').is_file() for p in paths))

    def test_cancel_before_admission_prevents_job_creation(self):
        token = 'a' * 48
        self.assertEqual(self.request(self.base + '/cancel-admission', self.payload(admissionToken=token))[0], 200)
        with mock.patch.object(self.server_editor, 'editor_ffmpeg_tools', return_value=mock.Mock(ffmpeg=Path('ffmpeg'))), \
             mock.patch.object(self.server, 'ensure_libass_supported', return_value=True):
            self.assertEqual(self.request(self.base, self.png_request(admissionToken=token))[0], 409)
        self.assertIsNone(self.server.media_jobs.active)

    def test_invalid_xml_can_retry_without_publishing_or_losing_assets(self):
        job_id, manifest = self.start_fake()
        url = self.base + '/' + job_id + '/publish'
        for xml in ('<xmeml version="4"/>', '<xmeml version="5"/>',
                    '<!DOCTYPE xmeml [<!ENTITY test "value">]><xmeml version="5"/>',
                    self.xml(manifest).replace('one.png', 'outside.png')):
            with self.subTest(xml=xml):
                self.assertEqual(self.request(url, self.payload(xml=xml))[0], 400)
                self.assertFalse(Path(manifest['packagePath']).exists())
                self.assertEqual(self.server.media_jobs.get(job_id).state, 'ready')
        self.assertEqual(self.request(url, self.payload(xml=self.xml(manifest)))[0], 200)

    def test_only_published_job_can_open_its_own_folder(self):
        job_id, manifest = self.start_fake()
        url = self.base + '/' + job_id + '/open-folder'
        with mock.patch.object(fcp7_png_api, '_open_export_folder') as open_folder:
            self.assertEqual(self.request(url, self.payload())[0], 409)
            open_folder.assert_not_called()
            self.assertEqual(self.request(self.base + '/' + job_id + '/publish',
                                          self.payload(xml=self.xml(manifest)))[0], 200)
            self.assertEqual(self.request(url, self.payload(path='arbitrary-untrusted-path'))[0], 200)
            open_folder.assert_called_once_with(Path(manifest['packagePath']))
            self.assertEqual(self.request(url, {}, token=False)[0], 403)

    def test_publish_copy_failure_leaves_no_partial_package_and_frees_slot(self):
        job_id, manifest = self.start_fake()
        with mock.patch.object(fcp7_png_api.shutil, 'copy2', side_effect=OSError('simulated disk failure')):
            self.assertEqual(self.request(self.base + '/' + job_id + '/publish',
                                         self.payload(xml=self.xml(manifest)))[0], 500)
        self.assertFalse(Path(manifest['packagePath']).exists())
        self.assertFalse(list(self.root.glob('.maw-png-*')))
        self.assertTrue(self.server.media_jobs.get(job_id).disposed)
        self.assertIsNone(self.server.media_jobs.active)

    def test_binding_switch_during_publish_rejects_stale_package(self):
        job_id, manifest = self.start_fake()
        copy = fcp7_png_api.shutil.copy2
        def switch(source, destination):
            result = copy(source, destination)
            with self.server.settings_lock:
                self.server.binding_generation += 1
            return result
        with mock.patch.object(fcp7_png_api.shutil, 'copy2', side_effect=switch):
            self.assertEqual(self.request(self.base + '/' + job_id + '/publish',
                                         self.payload(xml=self.xml(manifest)))[0], 409)
        self.assertFalse(Path(manifest['packagePath']).exists())
        self.assertTrue(self.server.media_jobs.get(job_id).disposed)

    def test_cancel_running_render_cleans_before_next_job(self):
        started = threading.Event()
        def render(job, *args):
            started.set()
            job.cancelled.wait(3)
            job.check_cancelled()
        with mock.patch.object(self.server_editor, 'editor_ffmpeg_tools', return_value=mock.Mock(ffmpeg=Path('ffmpeg'))), \
             mock.patch.object(self.server, 'ensure_libass_supported', return_value=True), \
             mock.patch.object(fcp7_png_api, 'render_png_assets', side_effect=render):
            status, result = self.request(self.base, self.png_request())
            self.assertEqual(status, 202)
            self.assertTrue(started.wait(2))
            job = self.server.media_jobs.get(result['jobId'])
            self.assertEqual(self.request(self.base + '/' + job.id + '/cancel', self.payload())[0], 200)
            self.assertTrue(job.disposed_event.wait(3))
            self.assertFalse(job.directory.exists())
            self.assertIsNone(self.server.media_jobs.active)

    def test_missing_libass_does_not_admit_job(self):
        with mock.patch.object(self.server_editor, 'editor_ffmpeg_tools', return_value=mock.Mock(ffmpeg=Path('ffmpeg'))), \
             mock.patch.object(self.server, 'ensure_libass_supported', return_value=False):
            self.assertEqual(self.request(self.base, self.png_request())[0], 400)
        self.assertIsNone(self.server.media_jobs.active)


class VegasPathCompatibilityTests(unittest.TestCase):
    def test_vegas_paths_decode_once_and_keep_the_standard_timeline(self):
        with tempfile.TemporaryDirectory(prefix='maw-vegas-paths-') as directory:
            image = Path(directory) / '字幕 & 50%20 #1.png'
            source = Path(directory) / 'video & 50%20 #1.mp4'
            xml = '<!DOCTYPE xmeml><xmeml version="5"><sequence><duration>75</duration>' \
                '<media><video><track><clipitem id="png-0-0"><start>5</start><end>50</end>' \
                '<alphatype>straight</alphatype><file id="one"><pathurl>' + escape(image.as_uri()) + \
                '</pathurl></file></clipitem></track></video></media><file id="source"><pathurl>' + \
                escape(source.as_uri()) + '</pathurl></file></sequence></xmeml>'
            manifest = {'sourcePath': str(source), 'tracks': [{'clips': [{'path': str(image)}]}]}
            fcp7_png_api.validate_package_xml(xml, manifest)
            converted = fcp7_png_api.vegas_package_xml(xml)
            before = ET.fromstring(xml.replace('<!DOCTYPE xmeml>', ''))
            after = ET.fromstring(converted.replace('<!DOCTYPE xmeml>', ''))
            for original, compatible in zip(before.iter('pathurl'), after.iter('pathurl')):
                self.assertFalse(compatible.text.startswith('file:'))
                self.assertIn('%2520', compatible.text)
                expected = fcp7_png_api._file_path(original.text)
                self.assertEqual(os.path.normcase(str(Path(unquote(compatible.text)).resolve())), expected)
                compatible.text = original.text
            self.assertEqual(ET.tostring(after), ET.tostring(before))


if __name__ == '__main__':
    unittest.main()

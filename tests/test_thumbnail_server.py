from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('thumbnail_editor_server', ROOT/'server-editor/serve.py')
server_editor = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = server_editor
SPEC.loader.exec_module(server_editor)


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class ThumbnailServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        cls.video = Path(cls.fixture.name)/'fixture.mp4'
        subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=2:duration=12',
                        '-c:v','libx264','-threads','2','-g','12','-y',str(cls.video)],check=True,capture_output=True,timeout=15)

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {'MAW_APP_DATA_ROOT':str(self.root/'app')})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.media = self.root/'video.mp4'
        shutil.copyfile(self.video,self.media)
        project = server_editor.ServerProject(data={'media':self.media.name,'segments':[]},json_path=None,
            media_path=self.media,source_media_path=self.media,sticker_root=None,stickers=[])
        self.server = server_editor.EditorServer(('127.0.0.1',0),project,no_waveform=True)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        self.binding = self.server.project_binding_payload()['thumbnailBinding']

    def stop(self):
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()
        self.assertFalse(self.thread.is_alive())
        worker = self.server.thumbnail_jobs.worker
        self.assertTrue(worker is None or not worker.is_alive())

    def request(self,path,body=None,*,headers=None,method=None):
        req = urllib.request.Request(self.url+path, data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type':'application/json',**(headers or {})},method=method)
        try:
            response = urllib.request.urlopen(req,timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status,dict(response.headers),response.read()

    def status(self, **extra):
        query = urlencode({'binding':self.binding,'client_id':'test',**extra})
        status,_,body = self.request('/api/thumbnails?'+query)
        self.assertEqual(status,200)
        return json.loads(body)

    def demand(self, **extra):
        request = {'binding':self.binding,'client_id':'test','view':1,'playing':False,'visible':True,
            'ranges':[{'start_ms':1000,'end_ms':3000}],'interval_ms':500,'representative_ms':[1250],
            'requestToken':self.server.request_token,**extra}
        status,_,body = self.request('/api/thumbnails/demand',request)
        self.assertEqual(status,200,body[:300])
        return json.loads(body)

    def ready(self):
        self.demand()
        started = time.monotonic()
        deadline = started+30
        while time.monotonic()<deadline:
            status = self.status()
            if status['state'] in ('ready','partial') and any(s['status']=='target' for s in status['samples']):
                return status
            self.assertNotEqual(status['state'],'error',status.get('error'))
            time.sleep(.05)
        manager = self.server.thumbnail_jobs
        with manager.lock:
            diagnostic = {"elapsed_s": round(time.monotonic()-started, 3),
                "state": status.get("state"), "error": status.get("error"),
                "decoding": status.get("decoding"),
                "target_sample_count": sum(sample["status"] == "target" for sample in status.get("samples", [])),
                "pending": [item["pending"] for item in manager.leases.values()],
                "active_targets": sorted(manager.active_targets),
                "failures": dict(list(manager.failures.items())[:16])}
        self.fail("visible thumbnail demand did not finish: " + json.dumps(diagnostic))

    def asset_url(self,status,asset=None,revision=None):
        asset = asset or status['assets'][0]['id']
        return '/api/thumbnails/asset/'+asset+'?'+urlencode({'binding':self.binding,'revision':revision or status['cache_revision']})

    def test_lazy_start_visible_only_assets_and_warm_hit(self):
        self.assertIsNone(self.server.thumbnail_jobs.worker)
        result = self.ready()
        self.assertFalse(Path(str(self.media)+'.mothumbs').exists())
        self.assertLess(len(result['samples']),24)
        self.assertTrue(all(sample['requested_ms']<4000 for sample in result['samples']))
        status,headers,jpeg = self.request(self.asset_url(result))
        self.assertEqual(status,200)
        self.assertEqual(headers['Content-Type'],'image/jpeg')
        self.assertTrue(jpeg.startswith(b'\xff\xd8'))
        from maw import thumbnails
        with mock.patch.object(thumbnails,'extract_frames',side_effect=AssertionError('warm hit decoded source')) as decode:
            self.demand(view=2)
            time.sleep(.25)
            self.assertEqual(self.status()['state'],'ready')
            decode.assert_not_called()

    def test_token_host_origin_paths_and_bounds(self):
        body={'binding':self.binding,'client_id':'test','requestToken':self.server.request_token}
        for change,headers,expected in (({'requestToken':'bad'},None,403),
            ({},{'Host':'evil.example'},403),({},{'Origin':'https://evil.example'},403),
            ({'path':str(self.media)},None,400),({'lease':{}},None,400),
            ({'playing':'false'},None,400),({'view':True},None,400),
            ({'interval_ms':250,'ranges':[{'start_ms':0,'end_ms':7200000}]},None,400)):
            status,_,_ = self.request('/api/thumbnails/demand',{**body,**change},headers=headers)
            self.assertEqual(status,expected)
        status,_,_ = self.request('/api/thumbnails/demand',{'requestToken':self.server.request_token,'binding':'old'})
        self.assertEqual(status,409)
        status,_,_ = self.request('/api/thumbnails/demand',body,headers={'Content-Length':'65537'})
        self.assertEqual(status,400)

    def test_head_revision_and_rebinding_are_isolated(self):
        result = self.ready()
        status,headers,body = self.request(self.asset_url(result),method='HEAD')
        self.assertEqual(status,200)
        self.assertEqual(body,b'')
        self.assertGreater(int(headers['Content-Length']),0)
        status,_,_ = self.request(self.asset_url(result,revision='expired'))
        self.assertEqual(status,409)
        status,_,body = self.request('/api/thumbnails?'+urlencode({'binding':self.binding,'client_id':'test'}),method='HEAD')
        self.assertEqual(status,200)
        self.assertEqual(body,b'')
        with self.server.settings_lock:
            self.server._bind_project_locked(self.server.project)
        status,_,_ = self.request(self.asset_url(result))
        self.assertEqual(status,409)
        self.assertEqual(self.server.thumbnail_jobs.leases,{})

    def test_playback_stale_view_and_explicit_release(self):
        result=self.ready()
        lease=result['lease']
        self.demand(lease=lease,view=5,playing=True)
        stale=self.demand(lease=lease,view=4,playing=False)
        self.assertEqual(stale['view'],5)
        self.assertEqual(stale['state'],'paused')
        self.assertFalse(stale['decoding'])
        self.assertEqual(self.request(self.asset_url(result))[0],200)
        self.demand(lease=lease,view=6,playing=False)
        status,_,_=self.request('/api/thumbnails/release',{'binding':self.binding,'lease':lease,'client_id':'test',
            'requestToken':self.server.request_token})
        self.assertEqual(status,200)
        self.assertEqual(self.server.thumbnail_jobs.leases,{})

    def test_source_replacement_rejects_old_assets(self):
        result=self.ready()
        self.media.write_bytes(b'replaced source')
        status,_,_ = self.request(self.asset_url(result))
        self.assertEqual(status,409)

from __future__ import annotations

import multiprocessing
import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from maw import thumbnails
from maw.thumbnail_jobs import ThumbnailCoordinator, ThumbnailJobManager, build_base, coordinated_extract, source_key


def _background_builder(media, app, database, events):
    os.environ['MAW_APP_DATA_ROOT'] = app
    coord = ThumbnailCoordinator(Path(database))
    original_extract = thumbnails.extract_frames
    original_popen = subprocess.Popen
    first = True

    def observe(command, **kwargs):
        process = original_popen(command, **kwargs)
        if '-re' in command:
            events.put(('started', process.pid))
        return process

    def slow_first(path, points, **kwargs):
        nonlocal first
        if first:
            first=False
            try:
                thumbnails._run(['ffmpeg','-nostdin','-v','error','-re','-threads','2','-i',str(path),
                    '-map','0:v:0','-an','-f','null','-'], timeout_s=10, cancel=kwargs['cancel'])
            except thumbnails.ThumbnailCancelled:
                events.put(('stopped',time.monotonic()))
                raise
        return original_extract(path,points,**kwargs)

    try:
        with mock.patch.object(thumbnails,'extract_frames',side_effect=slow_first), mock.patch.object(subprocess,'Popen',side_effect=observe):
            result=build_base(Path(media),coordinator=coord,timeout_s=15)
        events.put(('done',result['base_complete']))
    except Exception as error:
        events.put(('error',repr(error)))


def _foreground_decode(media, app, database, events, delay=False):
    os.environ['MAW_APP_DATA_ROOT']=app
    coord=ThumbnailCoordinator(Path(database))
    original=thumbnails.extract_frames
    def decode(*args,**kwargs):
        events.put(('decode',os.getpid()))
        if delay:
            time.sleep(.4)
        return original(*args,**kwargs)
    try:
        with mock.patch.object(thumbnails,'extract_frames',side_effect=decode):
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                frames=coordinated_extract(Path(media),[0],coordinator=coord)
                if frames:
                    events.put(('done',len(frames)))
                    return
                time.sleep(.05)
        events.put(('error','timed out'))
    except Exception as error:
        events.put(('error',repr(error)))


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg required')
class ThumbnailJobsIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.media=self.root/'video.mp4'
        self.app=self.root/'app'
        self.database=self.root/'jobs.sqlite3'
        subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=2:duration=6',
                        '-c:v','libx264','-threads','2','-y',str(self.media)],check=True,capture_output=True,timeout=10)
        self.coord=ThumbnailCoordinator(self.database)
        self.patch=mock.patch.dict(os.environ,{'MAW_APP_DATA_ROOT':str(self.app)})
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def process(self,target,*args):
        process=multiprocessing.Process(target=target,args=args)
        process.start()
        def reap():
            process.join(2)
            if process.is_alive():
                process.terminate()
                process.join(3)
        self.addCleanup(reap)
        return process

    def test_real_ffmpeg_cross_process_playback_stop_and_launcher_resume(self):
        events=multiprocessing.Queue()
        process=self.process(_background_builder,str(self.media),str(self.app),str(self.database),events)
        name,pid=events.get(timeout=8)
        self.assertEqual(name,'started',pid)
        begin=time.monotonic()
        self.coord.lease('player',source_key(self.media),playing=True)
        name,stopped=events.get(timeout=3)
        self.assertEqual(name,'stopped',stopped)
        self.assertLess(stopped-begin,1)
        time.sleep(.25)
        self.assertTrue(process.is_alive(),'Launcher task must wait rather than end on playback')
        self.coord.release('player')
        name,complete=events.get(timeout=10)
        self.assertEqual(name,'done',complete)
        self.assertTrue(complete)
        process.join(3)
        self.assertEqual(process.exitcode,0)
        from maw import thumbnail_cache
        self.assertTrue(thumbnail_cache.load_base(self.media)['base_complete'])

    def test_launcher_editor_flight_dedup_with_two_real_processes(self):
        events=multiprocessing.Queue()
        first=self.process(_foreground_decode,str(self.media),str(self.app),str(self.database),events,True)
        self.assertEqual(events.get(timeout=8)[0],'decode')
        second=self.process(_foreground_decode,str(self.media),str(self.app),str(self.database),events,False)
        results=[events.get(timeout=10),events.get(timeout=10)]
        self.assertEqual([row[0] for row in results],['done','done'],results)
        first.join(3)
        second.join(3)
        self.assertEqual((first.exitcode,second.exitcode),(0,0))
        self.assertTrue(events.empty())

    def test_playback_cancellation_keeps_worker_alive_and_resumes_current_view(self):
        manager=ThumbnailJobManager(coordinator=self.coord)
        self.addCleanup(manager.close)
        manager.bind(self.media,'binding')
        original=thumbnails.extract_frames
        started=threading.Event()
        first=True
        def slow(path,targets,**kwargs):
            nonlocal first
            if first:
                first=False
                started.set()
                while not kwargs['cancel'].wait(.01):
                    pass
                raise thumbnails.ThumbnailCancelled('playback')
            return original(path,targets,**kwargs)
        body={'binding':'binding','client_id':'tab','view':1,'ranges':[{'start_ms':0,'end_ms':2000}],
              'interval_ms':500,'playing':False,'visible':True}
        with mock.patch.object(thumbnails,'extract_frames',side_effect=slow):
            try:
                manager.demand(body)
                self.assertTrue(started.wait(5))
                manager.demand(dict(body,view=2,playing=True))
                deadline=time.monotonic()+2
                while manager.decode_active and time.monotonic()<deadline:
                    time.sleep(.01)
                self.assertFalse(manager.decode_active)
                self.assertTrue(manager.worker.is_alive())
                self.assertNotEqual(manager.state,'error')
                manager.demand(dict(body,view=3,playing=False))
                deadline=time.monotonic()+8
                while manager.state!='ready' and time.monotonic()<deadline:
                    time.sleep(.05)
                self.assertEqual(manager.state,'ready',manager.error)
                manager.release('binding',next(iter(manager.leases)),client='tab')
                self.assertFalse(self.coord.paused(source_key(self.media),background=True))
            finally:
                # A failed readiness assertion must stop the worker before the
                # process-global extractor patch is restored for another test.
                manager.close()
                self.assertFalse(manager.worker and manager.worker.is_alive())

import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from tests.test_server_align import SERVER
from tests.test_script_recording_workflow import cue, project
from maw.gui_workflow import TranscriptionRequest
from maw.recording_preparation import RecordingPreparation
from maw.script_recording_workflow import input_signature


class RecordingServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.media = self.root / "audio.wav"
        self.media.write_bytes(b"fixture-media")
        self.source, self.script = self.root/"raw.mosp", self.root/"script.txt"
        self.source.write_text(json.dumps({**project([cue("你好世界", 0, 1000)]), "media": str(self.media)}),
                               encoding="utf-8")
        self.script.write_text("你好，世界。", encoding="utf-8")
        self.server = SERVER.AlignmentServer(("127.0.0.1",0), SERVER.load_state(self.source,self.script,None))
        self.thread = threading.Thread(target=self.server.serve_forever,kwargs={"poll_interval":0.01},daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.state = self.get("/api/state")
        self.body = {"requestToken": self.state["requestToken"],
                     "inputSignature": self.state["recordingInputSignature"], "sourceConfirmed": True,
                     "selectedByLine": self.state["alignment"]["defaultSelection"]}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.directory.cleanup()

    def get(self,path):
        with urlopen(self.url+path,timeout=3) as response:
            return json.loads(response.read())

    def post(self,path,body):
        request = Request(self.url+path,json.dumps(body).encode(),{"Content-Type":"application/json"})
        with urlopen(request,timeout=3) as response:
            return json.loads(response.read())

    def test_review_is_token_protected_and_no_model_required(self):
        result = self.post("/api/recording/review",self.body)
        self.assertTrue(result["review"]["ready"])
        with self.assertRaises(HTTPError) as error:
            self.post("/api/recording/review",{**self.body,"requestToken":"wrong"})
        self.assertEqual(error.exception.code,403)

    def test_stale_file_or_signature_rejected(self):
        with self.assertRaises(HTTPError):
            self.post("/api/recording/review",{**self.body,"inputSignature":"old"})
        self.script.write_text("其他文稿",encoding="utf-8")
        with self.assertRaises(HTTPError):
            self.post("/api/recording/start",self.body)

    def test_worker_outputs_are_reported_without_ui_supplied_paths(self):
        fake={"artifact":{"projectPath":"reviewed.mosp","srtPath":"reviewed.srt"}}
        with mock.patch("maw.local_runtime.run_timestamp_alignment_in_runtime",return_value=fake) as worker:
            self.post("/api/recording/start",{**self.body,"outputDirectory":"ignored-client-path"})
            self.server.recording_job.thread.join(timeout=3)
            result=self.get("/api/recording/status")
            self.assertEqual(result["status"],"complete")
            self.assertTrue(worker.called)
            self.assertNotIn("output_directory",worker.call_args.kwargs)
            self.assertEqual(worker.call_args.kwargs["project_path"],self.source.resolve())

    def test_cancellation_passes_owned_event_to_runtime(self):
        started=threading.Event()
        def wait(**kwargs):
            started.set()
            kwargs["cancel_event"].wait(timeout=3)
            raise RuntimeError("cancelled")
        with mock.patch("maw.local_runtime.run_timestamp_alignment_in_runtime",side_effect=wait):
            self.post("/api/recording/start",self.body)
            self.assertTrue(started.wait(timeout=2))
            self.post("/api/recording/cancel",{"requestToken":self.state["requestToken"]})
            self.server.recording_job.thread.join(timeout=3)
            self.assertEqual(self.get("/api/recording/status")["status"],"cancelled")

    def test_changed_selection_cancels_in_flight_old_result(self):
        started=threading.Event()
        def wait(**kwargs):
            started.set();kwargs["cancel_event"].wait(timeout=3)
            return {"artifact":{"projectPath":"old.mosp"}}
        with mock.patch("maw.local_runtime.run_timestamp_alignment_in_runtime",side_effect=wait):
            self.post("/api/recording/start",self.body)
            self.assertTrue(started.wait(timeout=2))
            self.post("/api/recording/review",{**self.body,"selectedByLine":{}})
            self.server.recording_job.thread.join(timeout=3)
            self.assertEqual(self.get("/api/recording/status")["status"],"cancelled")

    def test_runtime_command_uses_recording_worker_and_current_python_fallback(self):
        from maw.local_runtime import run_timestamp_alignment_in_runtime
        def process(command,**kwargs):
            self.assertIn("recording-align",command)
            self.assertIn("--recording-request-path",command)
            kwargs["on_line"](json.dumps({"type":"result","artifact":{"projectPath":"out.mosp"}}))
            return 0
        with mock.patch("maw.local_runtime.managed_runtime_status",return_value=SimpleNamespace(ready=False)), mock.patch("maw.local_runtime._run_process",side_effect=process):
            result=run_timestamp_alignment_in_runtime(model_id="qwen",project_path=self.source,
                        script_path=self.script,recording_request_path=self.root/"request.json")
        self.assertEqual(result["artifact"]["projectPath"],"out.mosp")

    def test_source_fill_dispatch_uses_checked_recording_worker_and_reports_failure(self):
        with mock.patch("maw.local_runtime.run_timestamp_alignment_in_runtime",return_value={"artifact":{"projectPath":"filled.mosp"}}) as worker:
            self.post("/api/recording/fill",self.body)
            self.server.recording_job.thread.join(timeout=3)
            self.assertEqual(worker.call_args.kwargs["recording_operation"],"fill")
            self.assertEqual(worker.call_args.kwargs["script_path"],self.script.resolve())
            self.assertTrue(worker.call_args.kwargs["recording_request_path"])
            self.assertEqual(self.get("/api/recording/status")["operation"],"fill")
        with mock.patch("maw.local_runtime.run_timestamp_alignment_in_runtime",return_value={"artifact":{},"report":{"failedSegments":1}}):
            self.post("/api/recording/fill",self.body)
            self.server.recording_job.thread.join(timeout=3)
            self.assertEqual(self.get("/api/recording/status")["status"],"error")

    def test_source_fill_current_python_dispatch_and_progress(self):
        from maw.local_runtime import run_timestamp_alignment_in_runtime
        messages=[]
        def process(command,**kwargs):
            self.assertIn("recording-fill",command)
            kwargs["on_line"](json.dumps({"type":"progress","message":"正在补码"}))
            kwargs["on_line"](json.dumps({"type":"result","artifact":{"projectPath":"filled.mosp"}}))
            return 0
        with mock.patch("maw.local_runtime.managed_runtime_status",return_value=SimpleNamespace(ready=False)), mock.patch("maw.local_runtime._run_process",side_effect=process):
            run_timestamp_alignment_in_runtime(model_id="qwen",project_path=self.source,
                    script_path=self.script,recording_request_path=self.root/"request.json",
                    recording_operation="fill",on_event=messages.append)
        self.assertEqual(messages,["正在补码"])

    def test_worker_entry_dispatches_both_recording_operations(self):
        import io
        from contextlib import redirect_stdout
        from maw.local_runtime_worker import main
        request_path=self.root/"request.json"
        request_path.write_text(json.dumps({"sourceConfirmed":True}),encoding="utf-8")
        for command,target in (("recording-align","run_recording_job"),("recording-fill","run_source_items_job")):
            with self.subTest(command=command), mock.patch("maw.script_recording_workflow."+target,return_value={"projectPath":"out.mosp"}) as operation:
                output=io.StringIO()
                with redirect_stdout(output):
                    self.assertEqual(main([command,"--model-id","qwen","--project-path",str(self.source),
                        "--script-path",str(self.script),"--recording-request-path",str(request_path)]),0)
                self.assertEqual(operation.call_args.args[:2],(self.source,self.script))
                self.assertEqual(json.loads(output.getvalue().splitlines()[-1])["type"],"result")


class RecordingPreparationTests(unittest.TestCase):
    def test_existing_asr_runner_keeps_raw_evidence_and_ignores_postprocessing(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            request=TranscriptionRequest(root/"a.wav",root/"a.srt",api_key="test-key-not-secret",
                  length_limit="2m",generate_html=True,postprocess_plan={"match":"must not run"})
            job=RecordingPreparation(request,root/"script.txt")
            def transcribe(request,**kwargs):
                self.assertEqual(request.length_limit,"")
                self.assertIsNone(request.postprocess_plan)
                self.assertFalse(request.generate_html)
                self.assertFalse(request.srt_only)
                kwargs["on_event"]("test-key-not-secret")
                return SimpleNamespace(json_path=root/"raw.mosp",srt_path=root/"raw.srt")
            with mock.patch("maw.recording_preparation.run_transcription",side_effect=transcribe):
                job.thread.start();job.thread.join(timeout=3)
            snapshot=job.snapshot()
            self.assertEqual(snapshot["status"],"ready")
            self.assertEqual(snapshot["projectPath"],str(root/"raw.mosp"))
            self.assertNotIn("test-key-not-secret",str(snapshot))

    def test_failed_or_cancelled_asr_does_not_start_alignment(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            job=RecordingPreparation(TranscriptionRequest(root/"a.wav",root/"a.srt"),root/"script.txt")
            with mock.patch("maw.recording_preparation.run_transcription",side_effect=RuntimeError("ASR failed")):
                job.thread.start();job.thread.join(timeout=3)
            self.assertEqual(job.snapshot()["status"],"error")
            self.assertNotIn("projectPath",job.snapshot())

    def test_cancelled_asr_and_launcher_bridge_lifecycle(self):
        from maw.gui_web import LauncherApi, LauncherPaths
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);script=root/"script.txt";script.write_text("你好",encoding="utf-8")
            request=TranscriptionRequest(root/"a.wav",root/"a.srt")
            job=RecordingPreparation(request,script)
            job.cancel.set()
            with mock.patch("maw.recording_preparation.run_transcription",return_value=SimpleNamespace(json_path=root/"raw.mosp",srt_path=root/"raw.srt")):
                job.thread.start();job.thread.join(timeout=3)
            self.assertEqual(job.snapshot()["status"],"cancelled")
            api=LauncherApi(paths=LauncherPaths(root=root,env_path=root/"unused-config",launcher_html=root/"launcher.html"),window_getter=lambda:None)
            with mock.patch("maw.gui_web._request_from_payload",return_value=request) as convert, mock.patch("maw.gui_web._frozen_ffmpeg_preflight",return_value=None), mock.patch("maw.recording_preparation.run_transcription",return_value=SimpleNamespace(json_path=root/"raw.mosp",srt_path=root/"raw.srt")):
                result=api.start_recording_review({"scriptPath":str(script),"transcription":{"providerId":"selected","testRun":True}})
                self.assertTrue(result["ok"])
                api.worker.join(timeout=3)
                self.assertEqual(convert.call_args.args[0],{"providerId":"selected","testRun":False,"autoPostprocess":None})
                self.assertEqual(api.recording_review_status()["status"],"ready")
                api.cancel_recording_review()
                self.assertTrue(api._recording_preparation.cancel.is_set())

    def test_recording_preflight_ignores_unused_invalid_auto_postprocessing(self):
        from maw.gui_web import LauncherApi, LauncherPaths
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);script=root/"script.txt";media=root/"audio.wav"
            script.write_text("你好",encoding="utf-8");media.write_bytes(b"fixture")
            api=LauncherApi(paths=LauncherPaths(root=root,env_path=root/"unused-config",launcher_html=root/"launcher.html"),window_getter=lambda:None)
            transcription={"mediaPath":str(media),"srtPath":str(root/"raw.srt"),"apiKey":"sk-test",
                "audioTrack":0,"autoPostprocess":{"enabled":True,"steps":[
                    {"id":"match","enabled":True,"scriptPath":str(root/"missing-old-script.txt")}]}}
            with mock.patch("maw.gui_web._frozen_ffmpeg_preflight",return_value=None), mock.patch(
                    "maw.recording_preparation.run_transcription",
                    return_value=SimpleNamespace(json_path=root/"raw.mosp",srt_path=root/"raw.srt")) as transcribe:
                result=api.start_recording_review({"scriptPath":str(script),"transcription":transcription})
                self.assertTrue(result["ok"],result)
                api.worker.join(timeout=3)
            self.assertEqual(api.recording_review_status()["status"],"ready")
            self.assertIsNone(transcribe.call_args.args[0].postprocess_plan)

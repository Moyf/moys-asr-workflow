import copy
import json
import math
import tempfile
import unittest
import wave
from array import array
from pathlib import Path
from unittest import mock

from maw.script_alignment import align_project_to_script
from maw.script_recording_workflow import (
    RecordingWorkflowError, evidence_errors, finalize_recording, input_signature, load_recording_inputs,
    map_joined_items, recommend_recording, review_recording, run_recording_job, run_source_items_job,
)
from maw.timestamp_alignment import TimedToken, TimestampAlignmentCancelled


def cue(text, start, end):
    return {"text": text, "start": start, "end": end}


def project(segments):
    return {"schema": "moy.asr.project.v1", "model": "qwen3-asr",
            "language": "zh", "segments": segments}


def request_for(alignment):
    return {"selectedByLine": alignment["defaultSelection"], "sourceConfirmed": True,
            "confirmedByLine": dict(alignment["defaultSelection"])}


class RecordingReviewTests(unittest.TestCase):
    def test_unique_exact_recommendation_does_not_mutate_evidence(self):
        raw = project([cue("你好，世界", 0, 1000)])
        original = copy.deepcopy(raw)
        result = recommend_recording(raw, "你好，世界。", source_confirmed=True)
        self.assertEqual(result["recommendedSelection"], {"line-001": "candidate-001-01"})
        self.assertEqual(raw, original)

    def test_numbers_negation_and_units_need_actual_confirmation(self):
        for script, spoken in (("今天介绍三种方法", "今天介绍两种方法"),
                               ("这个功能不能使用", "这个功能可以使用"),
                               ("重量为五十公斤", "重量为五十公克")):
            with self.subTest(script=script):
                raw = project([cue(spoken, 0, 1500)])
                alignment = align_project_to_script(raw, script)
                request = {"selectedByLine": alignment["defaultSelection"], "sourceConfirmed": True}
                review, _, _ = review_recording(raw, alignment, request)
                self.assertFalse(review["ready"])
                self.assertTrue(review["blockers"])

    def test_confirmed_asr_difference_is_bound_to_specific_candidate(self):
        raw = project([cue("今天介绍两种方法", 0, 1500)])
        alignment = align_project_to_script(raw, "今天介绍三种方法")
        request = request_for(alignment)
        self.assertTrue(review_recording(raw, alignment, request)[0]["ready"])
        request["confirmedByLine"] = {"line-001": "old-candidate"}
        self.assertFalse(review_recording(raw, alignment, request)[0]["ready"])

    def test_two_takes_need_confirmation_and_latest_is_opt_in(self):
        raw = project([cue("你好世界", 0, 1000), cue("你好世界", 2000, 3000)])
        alignment = align_project_to_script(raw, "你好世界")
        self.assertFalse(recommend_recording(raw, "你好世界", source_confirmed=True)["recommendedSelection"])
        latest = recommend_recording(raw, "你好世界", source_confirmed=True, prefer_latest=True)
        self.assertEqual(latest["recommendedSelection"], alignment["defaultSelection"])
        request = {"selectedByLine": alignment["defaultSelection"], "sourceConfirmed": True}
        self.assertFalse(review_recording(raw, alignment, request)[0]["ready"])
        request["preferLatest"] = True
        self.assertTrue(review_recording(raw, alignment, request)[0]["ready"])

    def test_missing_and_manual_incomplete_cannot_become_final(self):
        raw = project([cue("今天介绍", 0, 1000)])
        alignment = align_project_to_script(raw, "今天介绍三种方法")
        request = request_for(alignment)
        candidate = alignment["candidatesByLine"][0][0]
        request["selectedByLine"] = {"line-001": candidate["id"]}
        request["candidateActions"] = {candidate["id"]: "keep"}
        self.assertFalse(review_recording(raw, alignment, request)[0]["ready"])
        request["selectedByLine"] = {}
        request["candidateActions"] = {}
        self.assertFalse(review_recording(raw, alignment, request)[0]["ready"])

    def test_source_evidence_is_explicit_and_aligner_project_rejected(self):
        raw = project([cue("你好", 0, 1000)])
        self.assertTrue(evidence_errors(raw, False))
        raw["model"] = "qwen3-forced-aligner-0.6b"
        self.assertTrue(evidence_errors(raw, True))

    def test_extra_stays_enabled_and_input_is_unchanged(self):
        raw = project([cue("你好世界", 0, 1000), cue("额外补充内容", 2000, 3000)])
        original = copy.deepcopy(raw)
        alignment = align_project_to_script(raw, "你好世界")
        review, selection, result = review_recording(raw, alignment, request_for(alignment))
        self.assertTrue(review["ready"])
        self.assertTrue(selection["keptExtras"])
        self.assertTrue(any(c["text"] == "额外补充内容" and not c.get("disabled") for c in result["segments"]))
        self.assertEqual(raw, original)

    def test_mapping_restores_absolute_source_times(self):
        items = [{"text": "你", "start": 100, "end": 300},
                 {"text": "好", "start": 600, "end": 800}]
        result = map_joined_items(items, [(1000, 1500), (5000, 5500)])
        self.assertEqual([(c["start"], c["end"]) for c in result], [(1100, 1300), (5100, 5300)])

    def test_item_crossing_join_is_refused_not_interpolated(self):
        with self.assertRaisesRegex(RecordingWorkflowError, "拼接点"):
            map_joined_items([{"text": "你好", "start": 400, "end": 600}], [(1000, 1500), (5000, 5500)])

    def test_full_pipeline_preserves_extra_gap_and_original_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "audio.wav"
            with wave.open(str(media), "wb") as audio:
                audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                audio.writeframes(array("h", (round(6000*math.sin(i*.1)) for i in range(96000))).tobytes())
            raw = project([cue("你好世界", 1000, 3000), cue("补充说明", 4000, 5000)])
            raw["media"] = media.name
            raw["segments"][0]["speaker"] = "speaker-1"
            path, script = root / "raw.mosp", root / "script.txt"
            path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
            script.write_text("你好，世界。", encoding="utf-8")
            alignment = align_project_to_script(raw, script.read_text())
            request = request_for(alignment)
            request["inputSignature"] = input_signature(path, script, media)
            request.update(requestToken="transport-only", outputDirectory="untrusted-output", unknown="ignored")
            backend = mock.Mock()
            backend.align.return_value = [TimedToken("你", 100, 400), TimedToken("好", 400, 800),
                                         TimedToken("世", 900, 1200), TimedToken("界", 1200, 1800)]
            with mock.patch("maw.local_asr.create_local_engine", side_effect=AssertionError("no ASR rerun")):
                result = run_recording_job(path, script, request, backend=backend)
            final = json.loads(Path(result["projectPath"]).read_text(encoding="utf-8"))
            self.assertEqual(final["media"], "../audio.wav")
            self.assertEqual(load_recording_inputs(Path(result["projectPath"]), script)[2], media.resolve())
            generated = [c for c in final["segments"] if c["id"].startswith("script-recording-")]
            self.assertEqual(generated[0]["text"], "你好，世界。")
            self.assertEqual(generated[0]["items"][0]["start"], 1100)
            self.assertEqual(generated[0]["speaker"], "speaker-1")
            self.assertTrue(all(i["speaker"]=="speaker-1" for i in generated[0]["items"]))
            self.assertEqual(final["timestamp_granularity"], "segment")  # Extra still lacks full items.
            self.assertEqual("".join(i["text"] for i in generated[0]["items"]), generated[0]["text"])
            self.assertTrue(any(c["text"] == "补充说明" and not c.get("disabled") for c in final["segments"]))
            self.assertTrue(final["gap_remove"])
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), raw)
            report = json.loads(Path(result["reportPath"]).read_text())
            self.assertEqual(report["status"], "complete")
            self.assertNotIn("transport-only", json.dumps(report))
            self.assertNotIn("outputDirectory", report["request"])
            self.assertNotIn("unknown", report["request"])

    def test_stale_inputs_and_write_failure_publish_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media, path, script = root/"a.wav", root/"raw.mosp", root/"script.txt"
            media.touch()
            path.write_text(json.dumps({**project([cue("你好",0,1000)]), "media": str(media)}))
            script.write_text("你好", encoding="utf-8")
            with self.assertRaisesRegex(RecordingWorkflowError, "输入已变化"):
                run_recording_job(path, script, {"inputSignature": "stale"})
            request = {"inputSignature": input_signature(path, script, media)}
            with mock.patch("maw.script_recording_workflow.finalize_recording",
                            return_value=(project([cue("你好",0,1000)]), {})):
                with mock.patch("maw.script_recording_workflow.write_artifacts", side_effect=OSError("disk full")):
                    with self.assertRaises(OSError):
                        run_recording_job(path, script, request)
            self.assertFalse(list(root.glob("*.script-reviewed-*")))


    def test_internal_repetition_joins_only_kept_audio_and_rejects_cross_join_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); media=root/"audio.wav"
            with wave.open(str(media),"wb") as wav:
                wav.setparams((1,2,16000,0,"NONE","not compressed"))
                wav.writeframes(array("h",(round(5000*math.sin(i*.1)) for i in range(96000))).tobytes())
            texts=["本地模型、AI校准和翻译、","双语字幕、","双语字幕、","免费ASR、","这些功能全都加上了"]
            bounds=[(0,1000),(1100,2000),(2200,3100),(3300,4300),(4500,5500)]
            raw=project([{**cue(text,a,b),"id":f"s{i}"} for i,(text,(a,b)) in enumerate(zip(texts,bounds))])
            script="本地模型、AI校准和翻译、双语字幕、免费ASR、这些功能全都加上了"
            alignment=align_project_to_script(raw,script); request=request_for(alignment)
            review,_,_=review_recording(raw,alignment,request)
            self.assertTrue(review["ready"])
            slices=review["lines"][0]["sourceSlices"]
            self.assertFalse(any(p["start"]==1100 for p in slices))
            tokens=[];offset=0
            for part in slices:
                duration=part["end"]-part["start"]
                tokens.append(TimedToken(part["sourceText"],offset+100,offset+duration-100));offset+=duration
            backend=mock.Mock();backend.align.return_value=tokens
            output,_=finalize_recording(raw,alignment,request,media,backend=backend)
            generated=next(c for c in output["segments"] if c["id"].startswith("script-recording"))
            self.assertEqual([c["start"] for c in generated["items"]],[p["start"]+100 for p in slices])
            self.assertFalse(any(i["start"]<2000 and i["end"]>1100 for i in generated["items"]))
            backend.align.return_value=[TimedToken(script,100,offset-100)]
            with self.assertRaisesRegex(RecordingWorkflowError,"拼接点"):
                finalize_recording(raw,alignment,request,media,backend=backend)

    def test_manual_gap_removal_and_restoration_change_kept_ranges(self):
        # Manual gap decisions change the audio runs submitted to the aligner.
        from maw.script_recording_workflow import _ranges_without_gaps
        ranges=_ranges_without_gaps([{"start":1000,"end":2000}], [{"start":1300,"end":1500,"removed":True}])
        self.assertEqual(ranges,[(1000,1300),(1500,2000)])
        restored=_ranges_without_gaps([{"start":1000,"end":2000}], [{"start":1300,"end":1500,"removed":False}])
        self.assertEqual(restored,[(1000,2000)])

    def test_transport_fields_do_not_change_selection_digest(self):
        raw = project([cue("你好世界", 0, 1000)])
        alignment = align_project_to_script(raw, "你好世界")
        request = request_for(alignment)
        first = review_recording(raw, alignment, request)[0]
        second = review_recording(raw, alignment, {**request, "requestToken": "rotated", "unknown": 123})[0]
        self.assertEqual(first["selectionDigest"], second["selectionDigest"])
        changed = review_recording(raw, alignment, {**request, "sourceConfirmed": False})[0]
        self.assertNotEqual(first["selectionDigest"], changed["selectionDigest"])

    def test_malformed_metadata_and_gap_are_readable_errors(self):
        raw = project([cue("你好世界", 0, 1000)])
        raw["script_alignment"] = ["invalid"]
        self.assertTrue(evidence_errors(raw, True))
        alignment = align_project_to_script(project(raw["segments"]), "你好世界")
        with self.assertRaisesRegex(RecordingWorkflowError, "静音切除"):
            review_recording(project(raw["segments"]), alignment, request_for(alignment), gap_remove=[])

    def test_wrong_existing_media_binding_is_rejected(self):
        from maw.script_recording_workflow import validate_media_binding
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected, wrong = root / "expected.wav", root / "wrong.wav"
            expected.touch(); wrong.touch()
            with self.assertRaisesRegex(RecordingWorkflowError, "绑定"):
                validate_media_binding({"media": expected.name}, root / "raw.mosp", wrong)
            validate_media_binding({"media": expected.name}, root / "raw.mosp", expected)

    def test_generated_recording_project_cannot_be_reused_as_asr(self):
        raw = project([cue("你好世界", 0, 1000)])
        raw["script_alignment"] = {"recording": {"version": 1}}
        self.assertTrue(evidence_errors(raw, True))

    def test_source_items_fill_keeps_asr_text_and_publishes_only_complete_output(self):
        from threading import Event
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);media=root/"audio.wav";source=root/"raw.mosp";script=root/"script.txt"
            with wave.open(str(media),"wb") as audio:
                audio.setparams((1,2,16000,0,"NONE","not compressed"))
                audio.writeframes(array("h",(round(5000*math.sin(i*.1)) for i in range(48000))).tobytes())
            raw={**project([cue("你好世界",500,2000)]),"media":media.name}
            source.write_text(json.dumps(raw,ensure_ascii=False),encoding="utf-8")
            script.write_text("你好，世界。",encoding="utf-8")
            request={"sourceConfirmed":True,"inputSignature":input_signature(source,script,media)}
            backend=mock.Mock()
            backend.align.return_value=[TimedToken("你",100,300),TimedToken("好",300,500),TimedToken("世",500,700),TimedToken("界",700,900)]
            with mock.patch("maw.timestamp_alignment.create_alignment_backend",return_value=backend):
                result=run_source_items_job(source,script,request,media=media)
            output=json.loads(Path(result["projectPath"]).read_text(encoding="utf-8"))
            self.assertEqual(output["segments"][0]["text"],"你好世界")
            self.assertEqual(output["segments"][0]["start"],500)
            self.assertTrue(output["segments"][0]["items"])
            self.assertEqual(output["media"], "../audio.wav")
            self.assertEqual(load_recording_inputs(Path(result["projectPath"]),script)[2],media.resolve())
            self.assertEqual(json.loads(Path(result["reportPath"]).read_text())["operation"],"source-items")
            published=list(root.glob("*.asr-items-reviewed-*"))
            backend.align.side_effect=RuntimeError("model failed")
            with mock.patch("maw.timestamp_alignment.create_alignment_backend",return_value=backend):
                with self.assertRaisesRegex(RecordingWorkflowError,"部分 ASR"):
                    run_source_items_job(source,script,request,media=media)
            self.assertEqual(list(root.glob("*.asr-items-reviewed-*")),published)
            cancel=Event();cancel.set()
            with self.assertRaises(TimestampAlignmentCancelled):
                run_source_items_job(source,script,request,media=media,cancel_event=cancel)
            self.assertEqual(list(root.glob("*.asr-items-reviewed-*")),published)
            self.assertEqual(json.loads(source.read_text(encoding="utf-8")),raw)
            self.assertFalse(list(root.glob(".maw-recording-stage-*")))

    def test_speaker_change_requires_script_split(self):
        raw=project([{**cue("你好",0,1000),"speaker":"a"},{**cue("世界",1100,2000),"speaker":"b"}])
        alignment=align_project_to_script(raw,"你好世界")
        review=review_recording(raw,alignment,request_for(alignment))[0]
        self.assertFalse(review["ready"])
        self.assertTrue(any("说话人" in b["reason"] for b in review["blockers"]))

    def test_retained_extra_inside_joined_script_envelope_refuses_finalization(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);media=root/"audio.wav"
            with wave.open(str(media),"wb") as audio:
                audio.setparams((1,2,16000,0,"NONE","not compressed"))
                audio.writeframes(array("h",(round(5000*math.sin(i*.1)) for i in range(64000))).tobytes())
            raw=project([cue("你好",0,1000),cue("保留补充",1200,1800),cue("世界",2000,3000)])
            raw["script_alignment"]={}
            review={"ready":True,"selectionDigest":"fixture","lines":[{"text":"你好世界","speaker":"",
                "sourceSlices":[{"start":0,"end":1000},{"start":2000,"end":3000}]}]}
            backend=mock.Mock();backend.align.return_value=[TimedToken("你好",100,900),TimedToken("世界",1100,1900)]
            with mock.patch("maw.script_recording_workflow.review_recording",return_value=(review,{},raw)):
                with self.assertRaisesRegex(RecordingWorkflowError,"保留的额外字幕"):
                    finalize_recording(raw,{}, {},media,backend=backend)
            self.assertEqual(raw["segments"][1]["text"],"保留补充")

    def test_long_source_offsets_nfd_and_later_line_failure_are_transactional(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);media=root/"long.wav";source=root/"raw.mosp";script=root/"script.txt"
            with wave.open(str(media),"wb") as audio:
                audio.setparams((1,2,16000,0,"NONE","not compressed"))
                audio.writeframes(array("h",(1000 if i%2 else -1000 for i in range(16000))).tobytes()*654)
            lines=["Cafe\u0301 today.","第二行。"]
            raw={**project([cue("Cafe\u0301 today",650000,651000),cue("第二行",652000,653000)]),"media":str(media)}
            source.write_text(json.dumps(raw,ensure_ascii=False),encoding="utf-8")
            script.write_text("\n".join(lines),encoding="utf-8")
            request=request_for(align_project_to_script(raw,"\n".join(lines)))
            request["inputSignature"]=input_signature(source,script,media)
            tokens=[[TimedToken("Café",100,300),TimedToken("today",500,800)],
                    [TimedToken("第",100,300),TimedToken("二",300,500),TimedToken("行",500,800)]]
            backend=mock.Mock();backend.align.side_effect=tokens
            result=run_recording_job(source,script,request,backend=backend)
            output=json.loads(Path(result["projectPath"]).read_text(encoding="utf-8"))
            generated=[c for c in output["segments"] if c["id"].startswith("script-recording")]
            self.assertEqual([c["text"] for c in generated],lines)
            self.assertEqual([c["items"][0]["start"] for c in generated],[650100,652100])
            self.assertEqual(backend.align.call_args_list[0].args[1],"Café today.")
            before=list(root.glob("*.script-reviewed-*"))
            backend.align.side_effect=[tokens[0],RuntimeError("second line failed")]
            with self.assertRaisesRegex(RuntimeError,"second line"):
                run_recording_job(source,script,request,backend=backend)
            self.assertEqual(list(root.glob("*.script-reviewed-*")),before)
            self.assertEqual(json.loads(source.read_text(encoding="utf-8")),raw)

    def test_legitimate_repeated_script_lines_keep_distinct_source_ranges(self):
        raw=project([cue("你好世界",0,1000),cue("你好世界",2000,3000)])
        alignment=align_project_to_script(raw,"你好世界\n你好世界")
        review=review_recording(raw,alignment,request_for(alignment))[0]
        self.assertTrue(review["ready"])
        ranges=[line["sourceSlices"] for line in review["lines"]]
        self.assertLessEqual(ranges[0][-1]["end"],ranges[1][0]["start"])

    def test_final_generation_uses_selected_audio_track(self):
        import subprocess
        from maw.ffmpeg import resolve_ffmpeg_tool
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for index,amplitude in enumerate((1000,5000)):
                with wave.open(str(root/f"track{index}.wav"),"wb") as audio:
                    audio.setparams((1,2,16000,0,"NONE","not compressed"))
                    audio.writeframes(array("h",[amplitude]*32000).tobytes())
            media=root/"two.mka"
            subprocess.run([str(resolve_ffmpeg_tool("ffmpeg")),"-v","error","-i",str(root/"track0.wav"),
                "-i",str(root/"track1.wav"),"-map","0:a","-map","1:a","-c:a","pcm_s16le",str(media)],check=True)
            raw={**project([cue("你好世界",0,1000)]),"media_metadata":{"selected_audio_track":1}}
            alignment=align_project_to_script(raw,"你好世界");backend=mock.Mock()
            def align(path,text,**kwargs):
                with wave.open(str(path),"rb") as audio:
                    self.assertEqual(array("h",audio.readframes(1))[0],5000)
                return [TimedToken("你好世界",100,900)]
            backend.align.side_effect=align
            output,_=finalize_recording(raw,alignment,request_for(alignment),media,backend=backend)
            self.assertEqual(output["media_metadata"]["selected_audio_track"],1)

    def test_source_items_fill_uses_selected_audio_track_and_original_offsets(self):
        import subprocess
        from maw.ffmpeg import resolve_ffmpeg_tool
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for index,amplitude in enumerate((1000,5000)):
                with wave.open(str(root/f"track{index}.wav"),"wb") as audio:
                    audio.setparams((1,2,16000,0,"NONE","not compressed"))
                    audio.writeframes(array("h",[amplitude]*48000).tobytes())
            media=root/"two.mka"
            subprocess.run([str(resolve_ffmpeg_tool("ffmpeg")),"-v","error","-i",str(root/"track0.wav"),
                "-i",str(root/"track1.wav"),"-map","0:a","-map","1:a","-c:a","pcm_s16le",str(media)],check=True)
            raw={**project([cue("你好世界",1000,2000)]),"media":str(media),
                 "media_metadata":{"selected_audio_track":1}}
            source,script=root/"raw.mosp",root/"script.txt"
            source.write_text(json.dumps(raw,ensure_ascii=False),encoding="utf-8")
            script.write_text("你好世界",encoding="utf-8")
            backend=mock.Mock()
            def align(path,text,**kwargs):
                with wave.open(str(path),"rb") as audio:
                    self.assertEqual(array("h",audio.readframes(1))[0],5000)
                return [TimedToken("你好世界",100,900)]
            backend.align.side_effect=align
            request={"sourceConfirmed":True,"inputSignature":input_signature(source,script,media)}
            with mock.patch("maw.timestamp_alignment.create_alignment_backend",return_value=backend):
                result=run_source_items_job(source,script,request)
            output=json.loads(Path(result["projectPath"]).read_text(encoding="utf-8"))
            self.assertEqual(output["media_metadata"]["selected_audio_track"],1)
            self.assertEqual(output["segments"][0]["start"],1000)
            self.assertEqual(output["segments"][0]["items"][0]["start"],1100)
            self.assertEqual(output["segments"][0]["items"][0]["end"],1900)
            self.assertEqual(json.loads(source.read_text(encoding="utf-8")),raw)

    def test_source_fill_cancel_during_decode_publishes_nothing(self):
        from threading import Event
        from maw.local_runtime import LocalRuntimeCancelled
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);media=root/"audio.wav";source=root/"raw.mosp";script=root/"script.txt"
            media.write_bytes(b"fixture");script.write_text("你好",encoding="utf-8")
            raw={**project([cue("你好",0,1000)]),"media":str(media),
                 "media_metadata":{"selected_audio_track":0}}
            source.write_text(json.dumps(raw,ensure_ascii=False),encoding="utf-8")
            request={"sourceConfirmed":True,"inputSignature":input_signature(source,script,media)}
            cancel=Event()
            def stop_decode(command,**kwargs):
                self.assertIs(kwargs["cancel"],cancel)
                cancel.set()
                raise LocalRuntimeCancelled("cancelled")
            with mock.patch("maw.local_runtime._run_process",side_effect=stop_decode), mock.patch(
                    "maw.timestamp_alignment.align_project") as align:
                with self.assertRaises(LocalRuntimeCancelled):
                    run_source_items_job(source,script,request,cancel_event=cancel)
            align.assert_not_called()
            self.assertFalse(list(root.glob("*.asr-items-reviewed-*")))
            self.assertFalse(list(root.glob(".maw-recording-stage-*")))
            self.assertEqual(json.loads(source.read_text(encoding="utf-8")),raw)

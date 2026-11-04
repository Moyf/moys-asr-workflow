"""English ASR word spaces must keep their original timing and scope."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from maw.postprocess import OutputMode
from maw.postprocess_ai_cleanup import AiCleanupRequest, build_clips, run_ai_cleanup
from maw.postprocess_ai_cleanup_items import item_text_spans, remaining_text, verified_scope_indices
from maw.postprocess_ai_cleanup_timeline import parse_timeline


def word_cue(words):
    return {"id": "source-1", "start": 0, "end": 200 * len(words), "text": "".join(words),
            "items": [{"text": text, "start": 200 * i, "end": 200 * (i + 1)} for i, text in enumerate(words)]}


class WordSpacingCleanupTest(unittest.TestCase):
    def test_trimmed_english_cue_keeps_source_word_spaces_and_timings(self):
        cue = word_cue([" Hello", " world "])
        rows = build_clips([cue], [])
        self.assertEqual(rows[0]["asrText"], "Hello world")
        self.assertEqual(json.loads(rows[0]["itemTexts"]), [" Hello", " world "])
        decision = parse_timeline(rows[0]["sourceLine"], rows, {"c001": cue["items"]})
        self.assertEqual(decision["decisions"][0]["decision"], "keep")
        self.assertEqual(item_text_spans(rows[0]["asrText"], cue["items"]), [(0, 5), (5, 11)])
        self.assertEqual(cue["items"][0]["text"], " Hello")

    def test_only_edge_whitespace_may_be_absent(self):
        for text, words in [("Hello world", [" Hello", " world "]), ("Hello", [" Hello "])]:
            with self.subTest(text=text):
                self.assertIsNotNone(item_text_spans(text, [{"text": word} for word in words]))
        for text, words in [("Helloworld", [" Hello", " world"]), ("Hello World", [" Hello", " world"]),
                            ("Hell world", [" Hello", " world"]), ("we already know", [" we we", " already", " know"])]:
            with self.subTest(text=text):
                self.assertIsNone(item_text_spans(text, [{"text": word} for word in words]))
        self.assertIsNone(item_text_spans("", [{"text": " "}]))

    def test_internal_line_breaks_and_tabs_are_escaped_without_rewriting_items(self):
        cue = word_cue(["Hello\n", "world\t", "again"])
        rows = build_clips([cue], [])
        self.assertEqual(rows[0]["asrText"], cue["text"])
        self.assertIn(r"Hello\nworld", rows[0]["sourceLine"])
        parsed = parse_timeline(rows[0]["sourceLine"], rows, {"c001": cue["items"]})
        self.assertEqual(parsed["decisions"][0]["decision"], "keep")

    def test_repeated_cleanup_preserves_original_word_scopes_and_recovery(self):
        cue = word_cue([" Hello", " Hello", " world "])
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            source = directory / "input.mosp"
            source.write_text(json.dumps({"segments": [cue]}), encoding="utf-8")
            original = source.read_bytes()
            request = AiCleanupRequest(source, None, None, OutputMode.BOTH, output_directory=directory)
            first = run_ai_cleanup(request, complete=lambda p, r: {"timeline": "[c001] ~~Hello~~ Hello world"})
            project = json.loads(first.project_path.read_text(encoding="utf-8"))
            self.assertEqual(first.stats["removedItems"], 1)
            scope = project["gap_remove"]["provenance"]["sources"]["ai_cleanup"][0]
            self.assertEqual(list(verified_scope_indices(scope, project["segments"][0])), [0])
            self.assertEqual(scope["cleanup_scope"]["text"], " Hello")
            self.assertEqual((scope["start"], scope["end"]), (0, 200))
            self.assertEqual(project["segments"][0]["items"], cue["items"])
            self.assertEqual(remaining_text(cue["text"], cue["items"], [0]), "Hello world")
            second = run_ai_cleanup(AiCleanupRequest(first.project_path, None, None, OutputMode.BOTH, output_directory=directory), complete=lambda p, r: {"timeline": r[0]["sourceLine"]})
            self.assertEqual(second.stats["pendingReview"], 0)
            self.assertIn("Hello world", second.srt_path.read_text(encoding="utf-8-sig"))
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(remaining_text(cue["text"], cue["items"], []), cue["text"])

    def test_known_readonly_rows_are_ignored_even_if_model_marks_them(self):
        rows = [{"id": "c001", "asrText": "context", "contextOnly": "true"},
                {"id": "c002", "asrText": "Hello"},
                {"id": "c003", "asrText": "context", "contextOnly": "true"}]
        parsed = parse_timeline("[c001] ~~context~~\n[c002] Hello\n[c003] rewritten context", rows, {"c002": [{"text": " Hello"}]})
        self.assertEqual(parsed["decisions"], [{"id": "c002", "decision": "keep", "scriptLine": "", "reason": ""}])
        for text in ("[c001] context", "[c002] Hello\n[c002] Hello", "[c002] Hello\n[c999] context", "[c002] Changed", "[c002] Hello\nextra prose"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_timeline(text, rows, {"c002": [{"text": " Hello"}]})

    def test_repetition_inside_one_timed_item_cannot_be_cut(self):
        cue = word_cue([" we we", " already", " know"])
        rows = build_clips([cue], [])
        unsafe = parse_timeline("[c001] ~~we~~ we already know", rows, {"c001": cue["items"]})["decisions"][0]
        self.assertEqual(unsafe["decision"], "review")
        self.assertIn("we we", unsafe["reason"])
        self.assertIn("没有词项内部时间码", unsafe["reason"])
        self.assertNotIn("deleteItems", unsafe)
        parsed = parse_timeline(rows[0]["sourceLine"] + " %待确认：重复在同一词项，需回听%", rows, {"c001": cue["items"]})
        self.assertEqual(parsed["decisions"][0]["decision"], "review")

    def test_complete_word_cut_does_not_require_marking_its_separator(self):
        rows = [{"id": "c001", "asrText": "Hello Hello world"}]
        for words, draft in [([" Hello", " Hello", " world"], "[c001] Hello ~~Hello~~ world"),
                             (["Hello", "Hello", "world"], "[c001] ~~Hello ~~Hello world")]:
            items = [{"text": word} for word in words]
            with self.subTest(draft=draft):
                parsed = parse_timeline(draft, rows, {"c001": items})
                deleted = [1] if draft.startswith("[c001] Hello") else [0]
                self.assertEqual(parsed["decisions"][0]["deleteItems"], deleted)
                self.assertEqual(remaining_text(rows[0]["asrText"], items, deleted), "Hello world")
        unsafe = parse_timeline("[c001] Hello ~~Hell~~o world", rows, {"c001": [{"text": " Hello"}, {"text": " Hello"}, {"text": " world"}]})["decisions"][0]
        self.assertEqual(unsafe["decision"], "review")
        self.assertNotIn("deleteItems", unsafe)

    def test_one_unsafe_cut_preserves_whole_row_and_other_rows_still_cleanup(self):
        first = word_cue([" we we", " already", " know"])
        second = {"id": "source-2", "start": 1000, "end": 1500, "text": " Uh", "items": [{"text": " Uh", "start": 1000, "end": 1500}]}
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.mosp"
            source.write_text(json.dumps({"segments": [first, second]}), encoding="utf-8")
            original = source.read_bytes()
            calls = []
            def complete(prompt, rows):
                calls.append(rows)
                return {"timeline": "[c001] ~~we~~ we already ~~know~~\n[c002] ~~Uh~~"}
            artifact = run_ai_cleanup(AiCleanupRequest(source, None, None, OutputMode.BOTH), complete=complete)
            project = json.loads(artifact.project_path.read_text(encoding="utf-8"))
            self.assertEqual(len(calls), 1)
            self.assertEqual(artifact.stats["removed"], 1)
            self.assertEqual(artifact.stats["pendingReview"], 1)
            self.assertEqual(artifact.stats["removedItems"], 0)
            self.assertEqual(project["segments"][0], first)
            self.assertTrue(project["segments"][1]["disabled"])
            self.assertIn("we we already know", artifact.srt_path.read_text(encoding="utf-8-sig"))
            self.assertEqual(source.read_bytes(), original)

    def test_english_hesitations_are_removable_but_content_and_negation_survive(self):
        for words, draft, removed in [([" Hmm"], "~~Hmm~~", 1), ([" Uh..."], "~~Uh...~~", 1),
                                     ([" Um,", " hello"], "~~Um,~~ hello", 1),
                                     ([" No"], "~~No~~", 0), ([" yeah"], "~~yeah~~", 0),
                                     ([" Uh", " not", " yet"], "~~Uh not yet~~", 0)]:
            with self.subTest(words=words), tempfile.TemporaryDirectory() as folder:
                directory = Path(folder)
                source = directory / "input.mosp"
                source.write_text(json.dumps({"segments": [word_cue(words)]}), encoding="utf-8")
                artifact = run_ai_cleanup(AiCleanupRequest(source, None, None, OutputMode.BOTH), complete=lambda p, r: {"timeline": "[c001] " + draft})
                actual = artifact.stats["removed"] + artifact.stats["removedItems"]
                self.assertEqual(actual, removed)
                self.assertEqual(artifact.stats["pendingReview"], int(not removed))

    def test_hesitation_cuts_must_be_contiguous_source_words(self):
        cases = [
            (["u", " equals ", "h"], "~~u~~ equals ~~h~~", 0),
            (["u", "h", " hello"], "~~uh~~ hello", 2),
            ([" Uh", " hello", " Um"], "~~Uh~~ hello~~ Um~~", 2),
            (["u", "h", "um"], "~~uh~~um", 0),
            ([" uh", " hello"], "~~uh~~ hello", 1),
            (["uh,", "hello"], "~~uh,~~hello", 1),
        ]
        for words, draft, count in cases:
            with self.subTest(words=words), tempfile.TemporaryDirectory() as folder:
                source = Path(folder) / "input.mosp"
                source.write_text(json.dumps({"segments": [word_cue(words)]}), encoding="utf-8")
                artifact = run_ai_cleanup(AiCleanupRequest(source, None, None, OutputMode.BOTH), complete=lambda p, r: {"timeline": "[c001] " + draft})
                self.assertEqual(artifact.stats["removedItems"], count)
                self.assertEqual(artifact.stats["pendingReview"], int(not count))

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from html.parser import HTMLParser
from urllib.parse import quote, unquote, urljoin, urlsplit

from maw.media import MediaStatus, project_media_reference, resolve_project_media
from maw.project_io import rebase_project_media, write_mosp
from tests.test_local_editor_server import server_editor
from tests.compact_assertions import CompactContainerAssertions


class MediaSourceParser(HTMLParser):
    def handle_starttag(self, tag, attrs):
        if tag == "source":
            self.src = dict(attrs)["src"]


class ProjectMediaReferenceTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.media = self.root / "片 段.mp4"
        self.media.write_bytes(b"video")
        self.output = self.root / "_maw" / "captions.mosp"
        self.output.parent.mkdir()
        self.raw = {"media": "missing.mp4", "segments": [], "extra": {"keep": True}}
        self.output.write_text(json.dumps(self.raw), encoding="utf-8")
        self.enterContext(mock.patch.object(server_editor, "editor_ffmpeg_binary", return_value=None))
        self.enterContext(mock.patch.object(server_editor, "enrich_project_media_metadata", side_effect=lambda data, **_: data))

    def load(self, *, remember: bool = False):
        return server_editor.load_project(
            self.output, str(self.media), None, no_waveform=True,
            peaks_per_second=100, remember_media=remember,
        )

    def test_generation_same_directory_subfolder_and_moved_bundle(self) -> None:
        for directory in (self.root, self.root / "_maw", self.root / "clip_maw"):
            with self.subTest(directory=directory.name):
                target = directory / "generated.mosp"
                write_mosp(target, {"media": self.media.name, "segments": []}, media_path=self.media)
                data = json.loads(target.read_text(encoding="utf-8"))
                self.assertEqual(data["media"], self.media.name if directory == self.root else "../" + self.media.name)
                self.assertEqual(resolve_project_media(target, data).resolved_path, self.media)
        moved = self.root.with_name(self.root.name + "-moved")
        self.root.rename(moved)
        self.addCleanup(lambda: moved.rename(self.root))
        target = moved / "_maw" / "generated.mosp"
        data = json.loads(target.read_text(encoding="utf-8"))
        self.assertEqual(resolve_project_media(target, data).resolved_path, moved / self.media.name)

    def test_cross_drive_reference_falls_back_to_absolute(self) -> None:
        with mock.patch("maw.media.os.path.relpath", side_effect=ValueError("different drives")):
            self.assertEqual(project_media_reference(self.output, self.media), self.media.as_posix())

    def test_explicit_relative_media_uses_cwd_but_project_reference_uses_project_directory(self) -> None:
        with mock.patch("maw.media.Path.cwd", return_value=self.root):
            explicit = resolve_project_media(self.output, {}, self.media.name)
            project = resolve_project_media(self.output, {"media": "../" + self.media.name})
        self.assertEqual(explicit.resolved_path, self.media)
        self.assertEqual(project.resolved_path, self.media)

    def test_metadata_probe_uses_native_media_not_rebased_output_reference(self) -> None:
        with mock.patch("maw.project_io.probe_video_fps", return_value={"video_fps": 30}) as probe, \
                mock.patch("maw.project_io.probe_audio_tracks", return_value=[]):
            write_mosp(self.output, {"media": str(self.media), "segments": []})
        probe.assert_called_once_with(self.media, ffprobe_path=None)
        saved = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(saved["media"], "../" + self.media.name)
        self.assertEqual(saved["media_metadata"]["video_fps"], 30)

    def test_relative_reference_is_rebased_from_source_not_cwd(self) -> None:
        target = self.root / "exports" / "deep" / "copy.mosp"
        project = {"media": "../" + self.media.name, "extra": 42}
        result = rebase_project_media(project, target, source_project_path=self.output)
        self.assertEqual(result["media"], "../../" + self.media.name)
        self.assertEqual(project["media"], "../" + self.media.name)

    def test_legacy_fallback_only_uses_exact_filename_in_maw_parent(self) -> None:
        for folder in ("_maw", "clip_maw"):
            path = self.root / folder / "anything.mosp"
            result = resolve_project_media(path, {"media": self.media.name})
            self.assertEqual(result.resolved_path, self.media)
        for folder in ("ordinary", "_maw/deeper"):
            result = resolve_project_media(self.root / folder / "anything.mosp", {"media": self.media.name})
            self.assertEqual(result.status, MediaStatus.MISSING)
        result = resolve_project_media(self.output, {"media": self.media.with_suffix(".mov").name})
        self.assertEqual(result.status, MediaStatus.MISSING)

    def test_existing_local_candidate_wins_over_parent_fallback(self) -> None:
        local = self.output.parent / self.media.name
        local.write_bytes(b"local")
        self.assertEqual(resolve_project_media(self.output, {"media": self.media.name}).resolved_path, local)

    def test_loading_is_temporary_unless_explicitly_remembered(self) -> None:
        original = self.output.read_bytes()
        project = self.load()
        self.assertEqual(project.data["media"], "../" + self.media.name)
        self.assertEqual(self.output.read_bytes(), original)
        self.assertFalse(self.output.with_suffix(".mosp.bak").exists())

    def test_remember_only_updates_media_and_preserves_backup_and_caches(self) -> None:
        self.raw["waveform"] = {"legacy": "must stay during relink"}
        self.output.write_text(json.dumps(self.raw), encoding="utf-8")
        original = self.output.read_bytes()
        self.load(remember=True)
        saved = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(saved, {**self.raw, "media": "../" + self.media.name})
        self.assertEqual(self.output.with_suffix(".mosp.bak").read_bytes(), original)
        self.assertNotIn(b"\r\n", self.output.read_bytes())
        self.assertEqual(resolve_project_media(self.output, saved).resolved_path, self.media)
        self.load(remember=True)
        self.assertEqual(self.output.with_suffix(".mosp.bak").read_bytes(), original)

    def test_missing_media_never_updates_original_even_if_remember_is_set(self) -> None:
        original = self.output.read_bytes()
        with self.assertRaises(server_editor.MediaResolutionError):
            server_editor.load_project(
                self.output, str(self.root / "missing.mov"), None,
                no_waveform=True, peaks_per_second=100, remember_media=True,
            )
        self.assertEqual(self.output.read_bytes(), original)

    def test_failed_persistence_is_reported_and_original_is_unchanged(self) -> None:
        original = self.output.read_bytes()
        with mock.patch.object(server_editor, "write_project_json", side_effect=PermissionError("read only")):
            with self.assertRaisesRegex(ValueError, "无法记住关联"):
                self.load(remember=True)
        self.assertEqual(self.output.read_bytes(), original)

    def test_server_save_as_rebases_absolute_media_to_actual_target(self) -> None:
        target = self.root / "exports" / "copy.mosp"
        server_editor.write_project_json(target, {"media": str(self.media), "segments": []})
        saved = json.loads(target.read_text(encoding="utf-8"))
        self.assertEqual(saved["media"], "../" + self.media.name)
        self.assertEqual(resolve_project_media(target, saved).resolved_path, self.media)

    def test_pipeline_snapshots_relocation_and_publishing_preserve_media(self) -> None:
        from maw.postprocess_pipeline import _copy_atomic, _relocate_pipeline_artifact

        self.output.write_text(json.dumps({"media": "../" + self.media.name, "segments": []}), encoding="utf-8")
        intermediate = self.root / "_maw" / "postprocess" / "run" / "snapshot.mosp"
        _copy_atomic(self.output, intermediate, project_file=True)
        relocated = self.root / "_maw" / "postprocess" / "other" / "step.mosp"
        _relocate_pipeline_artifact(intermediate, relocated)
        published = self.root / "_maw" / "final.mosp"
        _copy_atomic(relocated, published, project_file=True)
        for target in (intermediate, relocated, published):
            saved = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(resolve_project_media(target, saved).resolved_path, self.media)
        self.assertEqual(json.loads(published.read_text(encoding="utf-8"))["media"], "../" + self.media.name)

    def test_html_generation_resolves_media_from_project_not_cwd(self) -> None:
        import edit

        self.output.write_text(json.dumps({"media": "../" + self.media.name, "segments": []}), encoding="utf-8")
        target = self.output.with_suffix(".edit.html")
        with mock.patch("sys.argv", ["edit.py", str(self.output), "--no-waveform"]), \
                mock.patch.object(edit, "ensure_bundle"), \
                mock.patch.object(edit, "get_default_sticker_dir", return_value=""), \
                mock.patch.object(edit, "enrich_project_media_metadata", side_effect=lambda data, **_: data), \
                mock.patch.object(edit, "render_editor_page", return_value="<!doctype html>") as render:
            self.assertEqual(edit.main(), 0)
        self.assertTrue(target.is_file())
        self.assertIn(quote("../" + self.media.name, safe="/"), render.call_args.kwargs["media_html"])

    def render_media_source(self, media: Path, *, cross_drive: bool = False) -> str:
        import edit

        media.parent.mkdir(parents=True, exist_ok=True)
        media.write_bytes(b"fixture")
        reference = project_media_reference(self.output, media)
        self.output.write_text(json.dumps({"media": reference, "segments": []}), encoding="utf-8")
        with mock.patch("sys.argv", ["edit.py", str(self.output), "--no-waveform"]), \
                mock.patch.object(edit, "ensure_bundle"), \
                mock.patch.object(edit, "get_default_sticker_dir", return_value=""), \
                mock.patch.object(edit, "enrich_project_media_metadata", side_effect=lambda data, **_: data), \
                mock.patch.object(edit, "render_editor_page", return_value="fixture") as render:
            if cross_drive:
                with mock.patch.object(edit.os.path, "relpath", side_effect=ValueError("different drives")):
                    self.assertEqual(edit.main(), 0)
            else:
                self.assertEqual(edit.main(), 0)
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8"))["media"], reference)
        parser = MediaSourceParser()
        parser.feed(render.call_args.kwargs["media_html"])
        return parser.src

    def test_relative_media_urls_encode_reserved_characters_without_changing_project_paths(self) -> None:
        for filename in ("clip#1.mp4", "clip%20name.mp4", "片 段 #20%.mp4", "clip&name.mp4"):
            with self.subTest(filename=filename):
                media = self.root / "folder #20%" / filename
                src = self.render_media_source(media)
                relative = "../folder #20%/" + filename
                self.assertEqual(src, quote(relative, safe="/"))
                resolved = urlsplit(urljoin(self.output.with_suffix(".edit.html").as_uri(), src))
                self.assertEqual(resolved.fragment, "")
                self.assertEqual(resolved.query, "")
                self.assertEqual(Path(unquote(resolved.path)).parts[-2:], (media.parent.name, filename))

    def test_cross_drive_html_media_url_is_not_double_encoded(self) -> None:
        media = self.root / "clip #20%.mp4"
        self.assertEqual(self.render_media_source(media, cross_drive=True), media.as_uri())


if __name__ == "__main__":
    unittest.main()

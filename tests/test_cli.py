from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from maw import cli


class CliTests(unittest.TestCase):
    def test_compare_opens_one_window_with_preloaded_files_in_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = root / "first.mosp", root / "second.srt"
            first.write_text('{"segments":[{"start":0,"end":1000,"text":"sample"}]}', encoding="utf-8")
            second.write_text("1\n00:00:00,000 --> 00:00:01,000\nsample\n", encoding="utf-8")
            webview = mock.Mock()
            with mock.patch.dict(sys.modules, {"webview": webview}):
                result = cli.main(["--compare", str(first), str(second), str(first)])
        self.assertEqual(result, 0)
        webview.create_window.assert_called_once()
        _, kwargs = webview.create_window.call_args
        self.assertTrue(kwargs["url"].endswith("/tools/compare.html"))
        self.assertEqual([file["name"] for file in kwargs["js_api"].compare_preload()["files"]],
                         ["first.mosp", "second.srt"])
        webview.start.assert_called_once_with()

    def test_compare_rejects_an_empty_load_and_other_modes_without_starting_ui(self) -> None:
        webview = mock.Mock()
        with mock.patch.dict(sys.modules, {"webview": webview}), redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(cli.main(["--compare", "nonexistent-compare-test.srt"]), 1)
            self.assertIn("nonexistent-compare-test.srt", errors.getvalue())
            with self.assertRaises(SystemExit) as raised:
                cli.main(["--compare", "a.srt", "--align-script", "manuscript.txt"])
            self.assertEqual(raised.exception.code, 2)
        webview.create_window.assert_not_called()

    def test_compare_reports_native_startup_errors(self) -> None:
        class BrowserError(Exception):
            pass

        with tempfile.TemporaryDirectory() as directory:
            sample = Path(directory) / "clip.srt"
            sample.touch()
            webview = mock.Mock(WebViewException=BrowserError)
            webview.start.side_effect = BrowserError("renderer unavailable")
            with mock.patch.dict(sys.modules, {"webview": webview}), redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(cli.main(["--compare", str(sample)]), 1)
            self.assertIn("renderer unavailable", errors.getvalue())

    def test_parser_accepts_srt_and_optional_mosp_outputs(self) -> None:
        args = cli.build_parser("MAW.exe").parse_args(
            ["-i", "clip.mp3", "-o", "clip.srt", "clip.mosp"]
        )

        self.assertEqual(args.input, "clip.mp3")
        self.assertEqual(args.outputs, ["clip.srt", "clip.mosp"])
        self.assertIsNone(args.server)
        self.assertIsNone(args.stop_server)

    def test_burn_parses_subtitle_media_and_encoder(self) -> None:
        args = cli.build_parser("MAW.exe").parse_args(
            ["--burn", "clip.srt", "-i", "clip.mp4", "--encoder", "amf"]
        )

        self.assertEqual(args.burn, "clip.srt")
        self.assertEqual(args.input, "clip.mp4")
        self.assertEqual(args.encoder, "amf")
        self.assertIsNone(args.server)

    def test_burn_defaults_encoder_to_none(self) -> None:
        args = cli.build_parser("MAW.exe").parse_args(["--burn", "clip.srt", "-i", "clip.mp4"])

        self.assertIsNone(args.encoder)

    def test_burn_conflicts_with_server_mode(self) -> None:
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                cli.build_parser("MAW.exe").parse_args(["--burn", "clip.srt", "--server", "8250"])

        self.assertEqual(raised.exception.code, 2)

    def test_burn_requires_input_media(self) -> None:
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                cli.main(["--burn", "clip.srt"])

        self.assertEqual(raised.exception.code, 2)

    def test_burn_rejects_transcription_options(self) -> None:
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                cli.main(["--burn", "clip.srt", "-i", "clip.mp4", "--provider", "soniox"])

        self.assertEqual(raised.exception.code, 2)

    def test_transcription_rejects_encoder_without_burn(self) -> None:
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                cli.main(["-i", "clip.mp4", "-o", "clip.srt", "--encoder", "amf"])

        self.assertEqual(raised.exception.code, 2)

    def test_burn_invokes_run_burn_subtitles_and_reports_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            subtitle = root / "clip.srt"
            subtitle.write_text("1\n00:00:00,000 --> 00:00:01,000\nhi\n", encoding="utf-8")
            media = root / "clip.mp4"
            output = root / "clip.压字幕.mp4"
            fake_result = mock.Mock(media_path=output, video_encoder="amf", warnings=())

            with (
                mock.patch("maw.ffmpeg.resolve_ffmpeg_tool") as resolve_tool,
                mock.patch(
                    "maw.postprocess_ffmpeg.run_burn_subtitles", return_value=fake_result
                ) as run_burn,
            ):
                resolve_tool.side_effect = lambda tool, configured_path=None: Path(f"{tool}.exe")
                result = cli.main(["--burn", str(subtitle), "-i", str(media), "--encoder", "amf"])

            self.assertEqual(result, 0)
            run_burn.assert_called_once()
            request = run_burn.call_args.args[0]
            self.assertEqual(request.media_path, media)
            self.assertEqual(request.subtitle_path, subtitle)
            self.assertEqual(request.video_encoder, "amf")
            resolve_tool.assert_any_call("ffmpeg")

    def test_openai_provider_forwards_base_url_to_generator(self) -> None:
        args = cli.build_parser("MAW.exe").parse_args(
            [
                "--provider",
                "openai",
                "--base-url",
                "https://relay.test/v1",
                "--model",
                "whisper-1",
                "-i",
                "clip.wav",
            ]
        )

        generated = cli._generator_args(args, Path("clip.wav"), Path("out.srt"))

        self.assertEqual(generated[generated.index("--base-url") + 1], "https://relay.test/v1")
        self.assertEqual(generated[generated.index("--model") + 1], "whisper-1")

    def test_openai_provider_rejects_unrelated_provider_options(self) -> None:
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                cli.main(
                    [
                        "--provider",
                        "openai",
                        "--region",
                        "beijing",
                        "-i",
                        "clip.wav",
                    ]
                )

        self.assertEqual(raised.exception.code, 2)

    def test_openai_provider_dispatches_to_openai_generator(self) -> None:
        with mock.patch("maw.asr.openai.main", return_value=0) as generator_main:
            result = cli._invoke_generator("openai", ["clip.wav"])

        self.assertEqual(result, 0)
        generator_main.assert_called_once_with()

    def test_transcription_moves_generated_mosp_to_explicit_second_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            media = root / "clip.mp3"
            srt = root / "result.srt"
            mosp = root / "工程.mosp"
            media.write_bytes(b"media")

            def fake_generator(_provider: str, argv: list[str]) -> int:
                generated_srt = Path(argv[argv.index("--output") + 1])
                generated_srt.write_text("1\n00:00:00,000 --> 00:00:00,100\nHi\n", encoding="utf-8")
                generated_srt.with_suffix(".mosp").write_text("{}\n", encoding="utf-8")
                return 0

            with mock.patch("maw.cli._invoke_generator", side_effect=fake_generator) as invoke:
                result = cli.main(["-i", str(media), "-o", str(srt), str(mosp)])

            self.assertEqual(result, 0)
            self.assertTrue(srt.is_file())
            self.assertTrue(mosp.is_file())
            self.assertFalse(srt.with_suffix(".mosp").exists())
            generator_args = invoke.call_args.args[1]
            self.assertIn("--json", generator_args)
            self.assertIn("--no-html", generator_args)
            self.assertEqual(generator_args[generator_args.index("--output") + 1], str(srt.resolve()))

    def test_html_option_renders_portable_editor_after_generator(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            media = root / "clip.mp3"
            srt = root / "result.srt"
            media.write_bytes(b"media")

            def fake_generator(_provider: str, argv: list[str]) -> int:
                generated_srt = Path(argv[argv.index("--output") + 1])
                generated_srt.write_text("1\n00:00:00,000 --> 00:00:00,100\nHi\n", encoding="utf-8")
                generated_srt.with_suffix(".mosp").write_text("{}\n", encoding="utf-8")
                return 0

            def fake_render(_json_path: Path, _media_path: Path, html_path: Path, _ui_language: str = "zh") -> Path:
                html_path.write_text("<!doctype html>", encoding="utf-8")
                return html_path

            with mock.patch("maw.cli._invoke_generator", side_effect=fake_generator) as invoke:
                with mock.patch("maw.cli.render_editor_html", side_effect=fake_render) as render:
                    result = cli.main(["-i", str(media), "-o", str(srt), "--html"])

            self.assertEqual(result, 0)
            html_path = srt.with_suffix(".edit.html")
            self.assertTrue(html_path.is_file())
            render.assert_called_once_with(srt.with_suffix(".mosp"), media, html_path)
            self.assertIn("--no-html", invoke.call_args.args[1])

    def test_provider_options_are_forwarded_without_exposing_secrets(self) -> None:
        args = cli.build_parser("MAW.exe").parse_args(
            [
                "--provider",
                "qwen",
                "-i",
                "clip.mp4",
                "-o",
                "out.srt",
                "--workspace-id",
                "workspace-1",
                "--hotword",
                "Moy",
                "--hotword",
                "MAW",
                "--speaker-colors",
                "--with-waveform",
                "--with-spectral",
            ]
        )

        generated = cli._generator_args(args, Path("clip.mp4"), Path("out.srt"))

        self.assertIn("--speaker-colors", generated)
        self.assertIn("--with-waveform", generated)
        self.assertIn("--with-spectral", generated)
        self.assertEqual(
            [generated[index + 1] for index, value in enumerate(generated) if value == "--hotword"],
            ["Moy", "MAW"],
        )
        self.assertNotIn("workspace-1", generated)

    def test_server_start_forwards_port_project_and_media(self) -> None:
        with mock.patch("maw.cli._invoke_server", return_value=0) as invoke:
            result = cli.main(
                [
                    "--server",
                    "8765",
                    "project.mosp",
                    "--media",
                    "clip.mp4",
                    "--no-open",
                    "--no-waveform",
                ]
            )

        self.assertEqual(result, 0)
        command = invoke.call_args.args[0]
        self.assertEqual(command[:3], ["project.mosp", "--media", "clip.mp4"])
        self.assertEqual(command[command.index("--port") + 1], "8765")
        self.assertIn("--no-open", command)
        self.assertIn("--no-waveform", command)

    def test_stop_server_prefers_loopback_shutdown_endpoint(self) -> None:
        with mock.patch("maw.cli._request_server_shutdown", return_value=True) as request_shutdown:
            with mock.patch("maw.gui_web._stop_external_maw_server") as kill_external:
                result = cli.main(["--stop-server", "--port", "8765"])

        self.assertEqual(result, 0)
        request_shutdown.assert_called_once_with(8765)
        kill_external.assert_not_called()

    def test_qwen_only_options_are_rejected_for_soniox(self) -> None:
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                cli.main(["--provider", "soniox", "-i", "clip.mp3", "--region", "beijing"])

        self.assertEqual(raised.exception.code, 2)

    def test_soniox_context_json_is_forwarded_to_soniox_generator(self) -> None:
        args = cli.build_parser("MAW.exe").parse_args(
            [
                "--provider",
                "soniox",
                "-i",
                "clip.mp3",
                "--soniox-context-json",
                '{"terms":["MRI"]}',
            ]
        )

        generated = cli._generator_args(args, Path("clip.mp3"), Path("out.srt"))

        self.assertEqual(generated[generated.index("--context-json") + 1], '{"terms":["MRI"]}')

    def test_tencent_forwards_debug_and_speaker_flags(self) -> None:
        args = cli.build_parser("MAW.exe").parse_args(
            [
                "--provider", "tencent", "-i", "clip.mp3", "--debug", "--speaker",
                "--strip-tail-punct", "，。！？",
            ]
        )

        generated = cli._generator_args(args, Path("clip.mp3"), Path("out.srt"))

        self.assertIn("--debug", generated)
        self.assertIn("--speaker", generated)
        self.assertEqual(generated[generated.index("--strip-tail-punct") + 1], "，。！？")

    def test_transcription_providers_forward_explicit_empty_or_custom_split_punctuation(self) -> None:
        parser = cli.build_parser("MAW.exe")
        for provider in ("qwen", "soniox", "doubao", "tencent", "openai", "bcut", "moss"):
            for symbols in (None, "", "~", "-~"):
                with self.subTest(provider=provider, symbols=symbols):
                    command = ["--provider", provider, "-i", "clip.mp3"]
                    if symbols is not None:
                        command.append(f"--extra-strong-punct={symbols}")
                    args = parser.parse_args(command)
                    generated = cli._generator_args(args, Path("clip.mp3"), Path("out.srt"))
                    if symbols is None:
                        self.assertFalse(any(value.startswith("--extra-strong-punct") for value in generated))
                    else:
                        self.assertIn(f"--extra-strong-punct={symbols}", generated)

    def test_moss_forwards_hotwords_as_keyterms(self) -> None:
        args = cli.build_parser("MAW.exe").parse_args(
            [
                "--provider", "moss", "-i", "clip.mp3",
                "--hotword", "MOSS", "--hotword", "模思智能",
            ]
        )

        generated = cli._generator_args(args, Path("clip.mp3"), Path("out.srt"))

        self.assertEqual(generated.count("--hotword"), 2)
        self.assertEqual(generated[generated.index("--hotword") + 1], "MOSS")

    def test_moss_rejects_language_and_qwen_only_options(self) -> None:
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                cli.main(["--provider", "moss", "-i", "clip.mp3", "--language", "zh"])

        self.assertEqual(raised.exception.code, 2)

    def test_moss_dispatches_to_moss_generator(self) -> None:
        with mock.patch("maw.asr.moss.main", return_value=0) as generator_main:
            result = cli._invoke_generator("moss", ["clip.mp3"])

        self.assertEqual(result, 0)
        generator_main.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()

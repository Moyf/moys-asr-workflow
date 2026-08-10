from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw import cli


class CliTests(unittest.TestCase):
    def test_parser_accepts_srt_and_optional_mosp_outputs(self) -> None:
        args = cli.build_parser("MAW.exe").parse_args(
            ["-i", "clip.mp3", "-o", "clip.srt", "clip.mosp"]
        )

        self.assertEqual(args.input, "clip.mp3")
        self.assertEqual(args.outputs, ["clip.srt", "clip.mosp"])
        self.assertIsNone(args.server)
        self.assertIsNone(args.stop_server)

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
            ]
        )

        generated = cli._generator_args(args, Path("clip.mp4"), Path("out.srt"))

        self.assertIn("--speaker-colors", generated)
        self.assertIn("--with-waveform", generated)
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
        with self.assertRaises(SystemExit) as raised:
            cli.main(["--provider", "soniox", "-i", "clip.mp3", "--region", "beijing"])

        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()

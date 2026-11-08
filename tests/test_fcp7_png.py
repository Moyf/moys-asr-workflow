"""Frame planning and real libass coverage for transparent FCP 7 assets."""
import json
import io
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from fractions import Fraction

from PIL import Image, ImageChops

from maw.fcp7_png import prepare_render_plan, recover_straight_rgba, render_png_assets


HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H0000CCFF,&H0000CCFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def event(start="0:00:00.00", end="0:00:02.00", text="STATIC", name="maw:main:0", layer=0):
    return f"Dialogue: {layer},{start},{end},Default,{name},0,0,0,,{text}\n"


def plan(ass, **kwargs):
    return prepare_render_plan(ass, fps=kwargs.pop("fps", "25"), width=320, height=180,
                               duration_ms=kwargs.pop("duration_ms", 3000), selected_layers=[0, 1, 2], **kwargs)


class FramePlanTests(unittest.TestCase):
    def test_static_hold_is_one_sample_and_does_not_cover_gap(self):
        result = plan(HEADER + event() + event("0:00:02.40", "0:00:02.80", "NEXT", "maw:main:1"))
        self.assertEqual(result["tracks"][0]["spans"], [(0, 50), (60, 70)])

    def test_only_fade_windows_expand_to_individual_frames(self):
        result = plan(HEADER + event(text=r"{\fad(200,120)}FADE"))
        spans = result["tracks"][0]["spans"]
        self.assertEqual(spans[:5], [(i, i + 1) for i in range(5)])
        self.assertEqual(spans[5], (5, 47))
        self.assertEqual(spans[6:], [(47, 48), (48, 49), (49, 50)])

    def test_transform_and_move_preserve_static_tail(self):
        for tag in (r"\t(0,240,1,\fscx100\fscy100)", r"\move(10,10,20,20,0,240)"):
            with self.subTest(tag=tag):
                spans = plan(HEADER + event(text="{" + tag + "}A"))["tracks"][0]["spans"]
                self.assertEqual(spans[-1], (6, 50))
                self.assertEqual(len(spans), 7)

    def test_instantaneous_changes_and_zero_move_window_are_not_frozen(self):
        for tag in (r'\move(30,70,250,150,0,0)', r'\fade(255,0,255,500,500,1500,1500)',
                    r'\t(1000,1000,\fscx200)'):
            with self.subTest(tag=tag):
                spans = plan(HEADER + event(text='{' + tag + '}A'))['tracks'][0]['spans']
                self.assertEqual(spans, [(n,n+1) for n in range(50)])

    def test_fractional_fps_samples_only_active_ass_times(self):
        spans = plan(HEADER + event("0:00:00.01", "0:00:01.01"), fps="30000/1001")["tracks"][0]["spans"]
        self.assertEqual(spans, [(1, 31)])

    def test_overlap_lanes_keep_cue_slices_together_and_layers_ordered(self):
        result = plan(HEADER + event(end="0:00:01.00")
                      + event("0:00:01.00", "0:00:02.00")
                      + event("0:00:00.50", "0:00:01.50", name="maw:main:1")
                      + event(name="maw:extension:0", layer=1))
        self.assertEqual([(t["layer"], t["lane"]) for t in result["tracks"]], [(0, 0), (0, 1), (1, 0)])
        self.assertEqual(result["tracks"][0]["ass"].count("Dialogue:"), 2)

    def test_invalid_rate_dimensions_and_empty_tracks_rejected(self):
        with self.assertRaises(ValueError):
            plan(HEADER + event(), fps="29.97")
        with self.assertRaises(ValueError):
            plan(HEADER)


class MatteTests(unittest.TestCase):
    def test_missing_glyph_stops_render_before_publishing_boxes(self):
        class Job:
            def check_cancelled(self): pass
            def run_command(self, *args, **kwargs):
                return subprocess.CompletedProcess(args, 0, '',
                    '[Parsed_ass_0] fontselect: failed to find any fallback with glyph 0x4E2D for font: (Example, 400, 0)')
        with tempfile.TemporaryDirectory() as temporary:
            job = Job(); job.directory = Path(temporary); job.output = job.directory / 'manifest.json'
            with self.assertRaisesRegex(ValueError, '缺少字形'):
                render_png_assets(job, plan(HEADER + event()), Path('ffmpeg'), job.directory / 'package')
            self.assertFalse(job.output.exists())

    def test_known_source_over_roundtrip(self):
        source = Image.new("RGBA", (8, 8), (210, 100, 30, 127))
        black = Image.alpha_composite(Image.new("RGBA", source.size, (0, 0, 0, 255)), source).convert("RGB")
        white = Image.alpha_composite(Image.new("RGBA", source.size, (255, 255, 255, 255)), source).convert("RGB")
        recovered = recover_straight_rgba(black, white)
        self.assertEqual(recovered.getchannel("A").getextrema(), (127, 127))
        diff = ImageChops.difference(source, recovered)
        self.assertLessEqual(max(high for _, high in diff.getextrema()), 2)

    def test_empty_frame_is_transparent(self):
        image = recover_straight_rgba(Image.new("RGB", (8, 8)), Image.new("RGB", (8, 8), "white"))
        self.assertEqual(image.getchannel("A").getextrema(), (0, 0))


@unittest.skipUnless(shutil.which("ffmpeg"), "real FFmpeg unavailable")
class RenderTests(unittest.TestCase):
    def test_instantaneous_animation_changes_match_libass(self):
        class Job:
            def check_cancelled(self): pass
            def update(self, *args): pass
            def run_command(self, args, timeout, cwd):
                return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        for tag in (r'\move(30,70,250,150,0,0)', r'\fade(255,0,255,500,500,1500,1500)',
                    r'\t(1000,1000,\fscx200)'):
            with self.subTest(tag=tag), tempfile.TemporaryDirectory() as temporary:
                job = Job(); job.directory = Path(temporary); job.output = job.directory / 'manifest.json'
                ass = HEADER + event(text='{' + tag + '}CHANGE')
                (job.directory / 'reference.ass').write_text(ass, encoding='utf8')
                result = render_png_assets(job, plan(ass), Path(shutil.which('ffmpeg')), job.directory / 'package')
                for frame in (0, 15, 30, 40):
                    composed = Image.new('RGBA', (320,180), (0,0,0,255))
                    for track in result['tracks']:
                        for clip in track['clips']:
                            if clip['startFrame'] <= frame < clip['endFrame']:
                                with Image.open(job.directory / 'images' / clip['filename']) as png:
                                    composed = Image.alpha_composite(composed, png)
                    reference = subprocess.run([shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error',
                        '-f', 'lavfi', '-i', 'color=black:s=320x180:r=25,format=rgb24', '-vf',
                        f'settb=1/25,setpts={frame},ass=reference.ass', '-frames:v', '1', '-threads', '1',
                        '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], cwd=job.directory, capture_output=True, check=True, timeout=30)
                    with Image.open(io.BytesIO(reference.stdout)) as expected:
                        diff = ImageChops.difference(expected.convert('RGB'), composed.convert('RGB'))
                        self.assertLessEqual(max(high for _, high in diff.getextrema()), 3, (tag,frame))

    def test_all_transparent_subtitles_do_not_publish_an_empty_timeline(self):
        class Job:
            def check_cancelled(self): pass
            def update(self, *args): pass
            def run_command(self, args, timeout, cwd):
                return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        with tempfile.TemporaryDirectory() as temporary:
            job = Job(); job.directory = Path(temporary); job.output = job.directory / 'manifest.json'
            with self.assertRaisesRegex(ValueError, '均为透明'):
                render_png_assets(job, plan(HEADER + event(text=r'{\alpha&HFF&}EMPTY')),
                                  Path(shutil.which('ffmpeg')), job.directory / 'package')
            self.assertFalse(job.output.exists())

    def test_multitrack_recomposition_matches_direct_ass_at_frame_boundaries(self):
        class Job:
            def check_cancelled(self): pass
            def update(self, *args): pass
            def run_command(self, args, timeout, cwd):
                return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        ass = HEADER + event('0:00:00.12', '0:00:01.60', r'{\pos(160,140)\fad(200,120)}LOWER') + event(
            '0:00:00.48', '0:00:01.20', r'{\pos(170,140)\1c&H55DDFF&\fad(120,120)}UPPER', 'maw:overlay:0', 2)
        for fps in ('25', '30000/1001'):
            with self.subTest(fps=fps), tempfile.TemporaryDirectory() as temporary:
                job = Job(); job.directory = Path(temporary); job.output = job.directory / 'manifest.json'
                (job.directory / 'reference.ass').write_text(ass, encoding='utf8')
                result = render_png_assets(job, plan(ass, fps=fps, duration_ms=2000),
                                           Path(shutil.which('ffmpeg')), job.directory / 'published')
                rate = Fraction(fps)
                for frame in (0, 2, 3, 4, 7, 12, 13, 20, 29, 30, 36, 39, 40, 49):
                    for label, rgb in [('black', (0, 0, 0)), ('white', (255, 255, 255)), ('0x2266aa', (34, 102, 170))]:
                        composite = Image.new('RGBA', (320, 180), (*rgb, 255))
                        for track in result['tracks']:
                            for clip in track['clips']:
                                if clip['startFrame'] <= frame < clip['endFrame']:
                                    with Image.open(job.directory / 'images' / clip['filename']) as png:
                                        composite = Image.alpha_composite(composite, png.convert('RGBA'))
                        command = [shutil.which('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                            f'color={label}:s=320x180:r={fps},format=rgb24', '-vf',
                            f'settb=1/{rate.numerator},setpts={frame * rate.denominator},ass=reference.ass',
                            '-frames:v', '1', '-threads', '1', '-c:v', 'png', '-pix_fmt', 'rgb24', '-f', 'image2pipe', 'pipe:1']
                        reference = subprocess.run(command, cwd=job.directory, capture_output=True, timeout=30, check=True)
                        with Image.open(io.BytesIO(reference.stdout)) as expected:
                            difference = ImageChops.difference(expected.convert('RGB'), composite.convert('RGB'))
                            self.assertLessEqual(max(high for _, high in difference.getextrema()), 6,
                                                 f'fps={fps}, frame={frame}, background={label}')

    def test_real_fade_and_static_hold_generate_valid_manifest(self):
        class Job:
            def check_cancelled(self): pass
            def update(self, stage, progress): self.progress = progress
            def run_command(self, args, timeout, cwd):
                return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        with tempfile.TemporaryDirectory() as temporary:
            job = Job()
            job.directory = Path(temporary)
            job.output = job.directory / "manifest.json"
            result = render_png_assets(job, plan(HEADER + event(text=r"{\fad(200,120)}FADE")),
                                       Path(shutil.which("ffmpeg")), job.directory / "published")
            self.assertEqual(result["sampleCount"], 9)
            clips = result["tracks"][0]["clips"]
            # The first fade-out sample equals the hold; consecutive pixels merge.
            self.assertTrue(any(c["startFrame"] == 5 and c["endFrame"] == 48 for c in clips))
            self.assertFalse(any(c["startFrame"] == 0 for c in clips))
            self.assertEqual(clips[-1]["endFrame"], 50)
            for clip in clips:
                with Image.open(job.directory / "images" / clip["filename"]) as image:
                    self.assertEqual(image.mode, "RGBA")
                    self.assertEqual(image.size, (320, 180))
            self.assertEqual(json.loads(job.output.read_text())["imageCount"], result["imageCount"])


if __name__ == "__main__":
    unittest.main()

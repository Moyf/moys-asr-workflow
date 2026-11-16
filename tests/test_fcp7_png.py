"""Frame planning and real libass coverage for transparent FCP 7 assets."""
import json
import io
import shutil
import subprocess
import tempfile
import unittest
import sys
from pathlib import Path
from fractions import Fraction
from itertools import product

from PIL import Image, ImageChops

from maw.fcp7_png import prepare_render_plan, render_png_assets
from tests.compact_assertions import CompactContainerAssertions


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
    def test_image_format_is_explicit_and_legacy_default_is_png(self):
        self.assertEqual(plan(HEADER + event())["imageFormat"], "png")
        self.assertEqual(plan(HEADER + event(), image_format="webp")["imageFormat"], "webp")
        for value in (None, [], {}, "jpg", "WEBP"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                plan(HEADER + event(), image_format=value)

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

@unittest.skipUnless(shutil.which("ffmpeg"), "real FFmpeg unavailable")
class RenderTests(CompactContainerAssertions, unittest.TestCase):
    def test_runtime_exports_both_formats_when_pil_import_is_forbidden(self):
        code = '''
import builtins, json, shutil, subprocess, sys
from pathlib import Path
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name == 'PIL' or name.startswith('PIL.'):
        raise ImportError('Pillow must not be used by subtitle export')
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
from maw.fcp7_png import prepare_render_plan, render_png_assets
class Job:
    def check_cancelled(self): pass
    def update(self, *args): pass
    def run_command(self, args, timeout, cwd):
        return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
for fmt in ('png', 'webp'):
    root = Path(sys.argv[1]) / fmt
    root.mkdir()
    job = Job(); job.directory = root; job.output = root / 'manifest.json'
    plan = prepare_render_plan(sys.argv[2], fps='25', width=320, height=180,
                               duration_ms=3000, selected_layers=[0], image_format=fmt)
    result = render_png_assets(job, plan, Path(shutil.which('ffmpeg')), root / 'published')
    assert result['imageFormat'] == fmt and result['imageCount'] == 1
    print(fmt + ': passed without PIL')
'''
        with tempfile.TemporaryDirectory() as temporary:
            completed = subprocess.run([sys.executable, '-c', code, temporary, HEADER + event()],
                                       capture_output=True, text=True, timeout=45)
            self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])

    def test_alpha_one_black_pixels_survive_and_repeated_cues_reuse_images_across_batches(self):
        class Job:
            def check_cancelled(self): pass
            def update(self, *args): pass
            def run_command(self, args, timeout, cwd):
                # Exact black/254-white mattes yield A=1 independently of
                # libass versions' rounding of an ASS alpha override.
                args = [arg.replace("ass=filename='sub.ass'", 'null').replace('color=white:', 'color=0xfefefe:')
                        for arg in args]
                return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        # 26 distinct cues cross the 24-sample batch boundary. A=1 must survive;
        # black RGB does not imply an empty frame. Cue identity must not merge.
        ass = HEADER + ''.join(event(f'0:00:{n:02d}.00', f'0:00:{n+1:02d}.00',
            r'{\1c&H000000&\alpha&HFE&\bord0\shad0}FAINT', f'maw:main:{n}') for n in range(26))
        for fmt in ('png', 'webp'):
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as temporary:
                job = Job(); job.directory = Path(temporary); job.output = job.directory / 'manifest.json'
                result = render_png_assets(job, plan(ass, duration_ms=26000, image_format=fmt),
                                           Path(shutil.which('ffmpeg')), job.directory / 'package')
                self.assertEqual(result['imageCount'], 1)
                self.assertEqual(len(result['tracks'][0]['clips']), 26)
                with Image.open(next((job.directory / 'images').iterdir())) as image:
                    self.assertEqual(image.convert('RGBA').getchannel('A').getextrema()[1], 1)

    def test_missing_or_misaligned_metadata_never_publishes_a_manifest(self):
        class Job:
            def check_cancelled(self): pass
            def update(self, *args): pass
            def run_command(self, args, timeout, cwd):
                result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
                path = cwd / self.target
                content = path.read_text('utf-8')
                path.write_text(self.damage(content), encoding='utf-8')
                return result
        for target, damage in (
                ('alpha.txt', lambda text: ''),
                ('alpha.txt', lambda text: text.replace('pts:0', 'pts:1')),
                ('alpha.txt', lambda text: text.replace('maw.sample=1', '')),
                ('frames.sha256', lambda text: '\n'.join(line for line in text.splitlines() if line.startswith('#')))):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                job = Job(); job.directory = Path(temporary); job.output = job.directory / 'manifest.json'
                job.target = target; job.damage = damage
                with self.assertRaisesRegex(ValueError, '帧校验失败'):
                    render_png_assets(job, plan(HEADER + event()), Path(shutil.which('ffmpeg')), job.directory / 'package')
                self.assertFalse(job.output.exists())

    def test_instantaneous_animation_changes_match_libass(self):
        class Job:
            def check_cancelled(self): pass
            def update(self, *args): pass
            def run_command(self, args, timeout, cwd):
                return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        for tag, fmt in product((r'\move(30,70,250,150,0,0)', r'\fade(255,0,255,500,500,1500,1500)',
                               r'\t(1000,1000,\fscx200)'), ('png', 'webp')):
            with self.subTest(tag=tag, fmt=fmt), tempfile.TemporaryDirectory() as temporary:
                job = Job(); job.directory = Path(temporary); job.output = job.directory / 'manifest.json'
                ass = HEADER + event(text='{' + tag + '}CHANGE')
                (job.directory / 'reference.ass').write_text(ass, encoding='utf8')
                result = render_png_assets(job, plan(ass), Path(shutil.which('ffmpeg')), job.directory / 'package', fmt)
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
        for fmt in ('png', 'webp'):
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as temporary:
                job = Job(); job.directory = Path(temporary); job.output = job.directory / 'manifest.json'
                with self.assertRaisesRegex(ValueError, '均为透明'):
                    render_png_assets(job, plan(HEADER + event(text=r'{\alpha&HFF&}EMPTY')),
                                      Path(shutil.which('ffmpeg')), job.directory / 'package', fmt)
                self.assertFalse(job.output.exists())

    def test_multitrack_recomposition_matches_direct_ass_at_frame_boundaries(self):
        class Job:
            def check_cancelled(self): pass
            def update(self, *args): pass
            def run_command(self, args, timeout, cwd):
                return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        ass = HEADER + event('0:00:00.12', '0:00:01.60', r'{\pos(160,140)\fad(200,120)}LOWER') + event(
            '0:00:00.48', '0:00:01.20', r'{\pos(170,140)\1c&H55DDFF&\fad(120,120)}UPPER', 'maw:overlay:0', 2)
        for fps, fmt in product(('25', '30000/1001'), ('png', 'webp')):
            with self.subTest(fps=fps, fmt=fmt), tempfile.TemporaryDirectory() as temporary:
                job = Job(); job.directory = Path(temporary); job.output = job.directory / 'manifest.json'
                (job.directory / 'reference.ass').write_text(ass, encoding='utf8')
                result = render_png_assets(job, plan(ass, fps=fps, duration_ms=2000, image_format=fmt),
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
        self.check_fade_manifest('png')

    def test_explicit_webp_preserves_lossless_encoding_fades_and_static_holds(self):
        self.check_fade_manifest('webp')

    def check_fade_manifest(self, fmt):
        class Job:
            def check_cancelled(self): pass
            def update(self, stage, progress): self.progress = progress
            def run_command(self, args, timeout, cwd):
                return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        with tempfile.TemporaryDirectory() as temporary:
            job = Job()
            job.directory = Path(temporary)
            job.output = job.directory / "manifest.json"
            result = render_png_assets(job, plan(HEADER + event(text=r"{\fad(200,120)}FADE"), image_format=fmt),
                                       Path(shutil.which("ffmpeg")), job.directory / "published")
            self.assertEqual(result["sampleCount"], 9)
            clips = result["tracks"][0]["clips"]
            # The first fade-out sample equals the hold; consecutive pixels merge.
            self.assertTrue(any(c["startFrame"] == 5 and c["endFrame"] == 48 for c in clips))
            self.assertFalse(any(c["startFrame"] == 0 for c in clips))
            self.assertEqual(clips[-1]["endFrame"], 50)
            for clip in clips:
                with Image.open(job.directory / "images" / clip["filename"]) as image:
                    self.assertEqual(image.format, fmt.upper())
                    self.assertEqual(image.mode, "RGBA")
                    self.assertEqual(image.size, (320, 180))
                path = job.directory / "images" / clip["filename"]
                self.assertTrue(clip["filename"].endswith('.' + fmt))
                if fmt == 'webp':
                    data = path.read_bytes()
                    self.assertIn(b'VP8L', data)
                    self.assertNotIn(b'VP8 ', data)
            self.assertEqual(result["imageFormat"], fmt)
            self.assertEqual(json.loads(job.output.read_text())["imageCount"], result["imageCount"])


if __name__ == "__main__":
    unittest.main()

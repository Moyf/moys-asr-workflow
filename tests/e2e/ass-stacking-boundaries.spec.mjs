// Independent visual properties: real Canvas paint + FFmpeg/libass pixels.
// No production positioning helper or predicted anchor formula is an oracle.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTempDir, disableOnboarding, findFreePort, generateWav,
  generateWaveformPayload, makeTempDir, startServer } from './helpers.mjs';

let tempDir;
let server;
test.beforeAll(async () => {
  tempDir = makeTempDir('ass-stacking-boundaries');
  const media = join(tempDir, 'synthetic.wav');
  generateWav(media, 5);
  const project = join(tempDir, 'stacking.json');
  writeFileSync(project, JSON.stringify({ media: 'synthetic.wav',
    segments: [{ id: 'main', start: 0, end: 4000, text: 'Main' }],
    waveform: generateWaveformPayload(5000) }));
  server = await startServer(project, media, await findFreePort());
});
test.afterAll(async () => { await server?.stop(); cleanupTempDir(tempDir); });

const cue = (id, text, start = 0, end = 4000) => ({ id, text, start, end });
const cases = [
  { name: 'static single-line control', times: [1000] },
  { name: 'main explicit multiline', main: 'Main one\nMain two\nMain three', times: [1000] },
  { name: 'secondary explicit multiline', extension: 'Secondary one\nSecondary two\nSecondary three', times: [1000] },
  { name: 'largest emphasis and comment runs', main: 'Main **BIG**\n//COMMENT//',
    emphasisScale: 2.4, commentScale: 2.2, times: [1000] },
  { name: 'top edge moves the complete group into view', alignment: 8, marginV: 0, times: [1000] },
  { name: 'rotated left-aligned paint', alignment: 7, extensionAlignment: 1,
    marginV: 180, marginL: 0, angle: 30, times: [1000] },
  { name: 'scaled right-aligned paint', alignment: 9, extensionAlignment: 3,
    marginV: 240, marginR: 0, scaleX: 160, scaleY: 160, times: [1000] },
  { name: 'nonuniform scale and 90 degree rotation', marginV: 240,
    scaleX: 50, scaleY: 300, angle: 90, times: [1000] },
  { name: 'nonuniform scale and 30 degree rotation', marginV: 240,
    scaleX: 50, scaleY: 200, angle: 30, times: [1000] },
  { name: 'simultaneous bold italic and font-size targets', marginV: 240,
    animations: { t: { enabled: true, startMs: 0, endMs: 1500, accel: 2, tags: '\\b1\\i1\\fs120' } },
    times: [250, 750, 1250] },
  { name: 'speaker prefix glyphs participate in group bounds', speaker: true,
    fontSize: 144, alignment: 7, extensionAlignment: 3, marginV: 100, times: [1000] },
  { name: 'oversized multiline group uniformly fits the viewport',
    main: Array(11).fill('M').join('\n'), extension: 'W\nW\nW',
    overlaySegments: [cue('overlay-tall', 'O\nO\nO')], times: [1000], verifyFit: true },
  { name: 'nonlinear font-size and rotation animation frames', marginV: 220,
    animations: { t: { enabled: true, startMs: 0, endMs: 1500, accel: 2, tags: '\\fs120\\frz25' } },
    times: [250, 750, 1250] },
  { name: 'main move is shared despite different cue clocks',
    mainSegments: [cue('main-clock', 'Main', 0)],
    extensionSegments: [cue('extension-clock', 'Secondary', 500)],
    overlaySegments: [cue('overlay-clock', 'Overlay', 750)],
    animations: { move: { enabled: true, x1: 300, y1: 560, x2: 750, y2: 420, t1: 0, t2: 2000 } },
    times: [1000, 1250, 1750], verifyMove: true },
  { name: 'cue changes recalculate multiline bounds without restarting another cue',
    mainSegments: [cue('main-short', 'Main', 0, 1800), cue('main-tall', 'Main one\nMain two\nMain three', 1800)],
    extensionSegments: [cue('extension-long', 'Secondary', 500, 2500), cue('extension-next', 'Next secondary', 2500)],
    times: [750, 1500, 2250, 3000] },
];

async function configure(page, fixture) {
  await disableOnboarding(page);
  await page.goto(server.url);
  await page.waitForFunction(() => window.MaweAssCanvas?.render);
  await page.evaluate(async f => {
    await loadAssStyleLibrary({ force: true });
    ASS_STYLE_LIBRARY = window.AsrEditorUtils.defaultAssStyleLibrary();
    const main = ASS_STYLE_LIBRARY.styles.find(s => s.id === 'ass');
    const extension = ASS_STYLE_LIBRARY.styles.find(s => s.id === 'ass-extension');
    const common = { fontName: 'Arial', fontSize: f.fontSize ?? 96, bold: false, italic: false,
      alignment: f.alignment ?? 2, marginV: f.marginV ?? 180,
      marginL: f.marginL ?? 30, marginR: f.marginR ?? 30,
      outline: 0, shadow: 0, angle: f.angle ?? 0, scaleX: f.scaleX ?? 100,
      scaleY: f.scaleY ?? 100, emphasisScale: f.emphasisScale ?? 1.1,
      commentScale: f.commentScale ?? 0.8, emphasisStyle: 'text', commentStyle: 'text' };
    Object.assign(main, common, { primaryColor: '#ff0000', emphasisColor: '#ff0000', commentColor: '#ff0000' });
    Object.assign(extension, common, { fontSize: 72, alignment: f.extensionAlignment ?? 2,
      primaryColor: '#00ff00', emphasisColor: '#00ff00', commentColor: '#00ff00' });
    ASS_STYLE_LIBRARY.assProfiles[0].animations = {
      fad: { enabled: false }, fade: { enabled: false }, move: { enabled: false },
      t: { enabled: false }, ...(f.animations || {}),
    };
    // Preserve unique track fill colours for the independent libass masks.
    for (const [name, value] of [['red', '#ff0000'], ['green', '#00ff00'], ['blue', '#0000ff']]) {
      MaweColors.COLOR_BY_NAME[name].value = value;
    }
    MaweBoot.DATA.media_metadata = { video_width: 1280, video_height: 720 };
    MaweBoot.DATA.segments = f.mainSegments || [{ id: 'main', start: 0, end: 4000, text: f.main || 'Main' }];
    MaweBoot.DATA.multi_subtitle = { enabled: true, tracks: [{ id: 'extension', segments:
      f.extensionSegments || [{ id: 'extension', start: 0, end: 4000, text: f.extension || 'Secondary' }] }] };
    MaweBoot.DATA.overlay_track = { enabled: true, segments:
      (f.overlaySegments || [{ id: 'overlay', start: 0, end: 4000, text: 'Overlay' }])
        .map(s => ({ ...s, color: { name: 'blue' } })) };
    MaweBoot.DATA.preview = { subtitle: { ass_color_style: 'text' } };
    if (f.speaker) {
      MaweBoot.DATA.segments.forEach(s => { s.color = { name: 'red' }; });
      MaweBoot.DATA.multi_subtitle.tracks[0].segments.forEach(s => { s.color = { name: 'green' }; });
      MaweBoot.DATA.preview.subtitle.speaker_labels = { mapping_enabled: true, enabled: true,
        separator: ': ', names: { red: 'MainSpeakerWithLongPrefix', green: 'SecondarySpeaker', blue: 'OverlaySpeaker' } };
    }
    Object.assign(MaweSettings.EDITOR_SETTINGS, { assMode: true, assEmphasisSyntax: 'both',
      assSpecialSymbolRule: 'both', assCommentEnabled: true, assLargeTextEnabled: true,
      exportSpeakerLabels: Boolean(f.speaker) });
    MaweDom.overlayToggle.checked = true;
    MaweDom.extensionOverlayToggle.checked = true;
    await document.fonts.load('64px Arial');
    await document.fonts.ready;
    MawePlaybackLoop.refreshSubtitlePreview(1000, 0);
  }, fixture);
}

async function capture(page, timeMs) {
  return page.evaluate(tMs => {
    const native = document.querySelector('.ass-preview-canvas');
    const draws = [];
    const texts = [];
    const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
    const originalText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      if (this.canvas === native) {
        const bitmap = document.createElement('canvas');
        bitmap.width = source.width; bitmap.height = source.height;
        originalDraw.call(bitmap.getContext('2d'), source, 0, 0);
        const m = this.getTransform();
        draws.push({ bitmap, args, matrix: [m.a, m.b, m.c, m.d, m.e, m.f], alpha: this.globalAlpha });
      }
      return originalDraw.call(this, source, ...args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      texts.push(String(text));
      return originalText.call(this, text, ...args);
    };
    try {
      window.MaweAssCanvas.clearCaches();
      const index = MaweBoot.DATA.segments.findIndex(s => s.start <= tMs && tMs < s.end);
      MaweCoreState.player.currentTime = tMs / 1000;
      MawePlaybackLoop.refreshSubtitlePreview(tMs, index);
    } finally {
      CanvasRenderingContext2D.prototype.drawImage = originalDraw;
      CanvasRenderingContext2D.prototype.fillText = originalText;
    }
    const padding = 256;
    const width = native.width; const height = native.height;
    const combined = document.createElement('canvas');
    combined.width = width + 2 * padding; combined.height = height + 2 * padding;
    const records = window.MaweAssCanvas.lastRender.tracks;
    let cursor = 0;
    const tracks = records.map(record => {
      const canvas = document.createElement('canvas');
      canvas.width = combined.width; canvas.height = combined.height;
      const context = canvas.getContext('2d');
      const count = record.skipped ? 0 : record.lines.filter(line => line.width > 0 && line.ascent + line.descent > 0).length;
      for (const d of draws.slice(cursor, cursor + count)) {
        const matrix = [...d.matrix]; matrix[4] += padding; matrix[5] += padding;
        for (const target of [context, combined.getContext('2d')]) {
          target.setTransform(...matrix); target.globalAlpha = d.alpha;
          originalDraw.call(target, d.bitmap, ...d.args);
        }
      }
      cursor += count;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      let painted = 0, outside = 0, guardEdge = 0;
      const bands = [];
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if (pixels[(y * canvas.width + x) * 4 + 3] < 16) continue;
        painted++;
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
        if (x < padding || y < padding || x >= padding + width || y >= padding + height) outside++;
        if (!x || !y || x === canvas.width - 1 || y === canvas.height - 1) guardEdge++;
        if (!bands.length || bands[bands.length - 1][1] < y - padding) bands.push([y - padding, y + 1 - padding]);
        else bands[bands.length - 1][1] = Math.max(bands[bands.length - 1][1], y + 1 - padding);
      }
      return { painted, outside, guardEdge, bands,
        box: painted ? [left - padding, top - padding, right - padding, bottom - padding] : null };
    });
    const nativeTracks = Object.fromEntries(['main', 'extension', 'overlay'].map(key => [key,
      { painted: 0, box: null, bands: [] }]));
    const nativePixels = native.getContext('2d').getImageData(0, 0, width, height).data;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (nativePixels[offset + 3] < 16) continue;
      for (const [index, key] of ['main', 'extension', 'overlay'].entries()) {
        const value = nativePixels[offset + index];
        if (value <= 60 || value <= Math.max(nativePixels[offset + (index + 1) % 3], nativePixels[offset + (index + 2) % 3]) + 30) continue;
        const result = nativeTracks[key]; result.painted++;
        if (!result.box) result.box = [x, y, x + 1, y + 1];
        else {
          result.box[0] = Math.min(result.box[0], x); result.box[1] = Math.min(result.box[1], y);
          result.box[2] = Math.max(result.box[2], x + 1); result.box[3] = Math.max(result.box[3], y + 1);
        }
        if (!result.bands.length || result.bands[result.bands.length - 1][1] < y) result.bands.push([y, y + 1]);
        else result.bands[result.bands.length - 1][1] = Math.max(result.bands[result.bands.length - 1][1], y + 1);
      }
    }
    return { width, height, tracks, nativeTracks, texts, captured: draws.length, assigned: cursor,
      nativePng: native.toDataURL('image/png'), replayPng: combined.toDataURL('image/png'),
      ass: MaweExportSrt.buildAss(),
    };
  }, timeMs);
}

function libass(ass, timeMs, testInfo, label) {
  const path = testInfo.outputPath(`${label}.ass`);
  writeFileSync(path, ass);
  return JSON.parse(execFileSync(process.env.MAW_E2E_PYTHON || 'python', [
    resolve('tests/helpers/ass-stacking-pixel-oracle.py'), path, String(timeMs),
    testInfo.outputPath(`${label}-libass`),
  ], { encoding: 'utf8', timeout: 40_000, windowsHide: true }));
}

async function evidence(frame, testInfo, label) {
  for (const key of ['nativePng', 'replayPng']) {
    writeFileSync(testInfo.outputPath(`${label}-${key}.png`), Buffer.from(frame[key].split(',')[1], 'base64'));
  }
  const { nativePng, replayPng, ass, ...metrics } = frame;
  writeFileSync(testInfo.outputPath(`${label}-canvas.json`), JSON.stringify(metrics, null, 2));
  return metrics;
}

function visibleStack(tracks, width, height, label) {
  expect.soft(tracks, label).toHaveLength(3);
  for (const [index, track] of tracks.entries()) {
    expect.soft(track.painted, `${label} track ${index} exists`).toBeGreaterThan(30);
    if (!track.box) continue;
    expect.soft(track.box[0], `${label} track ${index} left`).toBeGreaterThanOrEqual(0);
    expect.soft(track.box[1], `${label} track ${index} top`).toBeGreaterThanOrEqual(0);
    expect.soft(track.box[2], `${label} track ${index} right`).toBeLessThanOrEqual(width);
    expect.soft(track.box[3], `${label} track ${index} bottom`).toBeLessThanOrEqual(height);
  }
  if (tracks[1]?.box && tracks[0]?.box) expect.soft(tracks[1].box[3], `${label} secondary above main`).toBeLessThanOrEqual(tracks[0].box[1]);
  if (tracks[2]?.box && tracks[1]?.box) expect.soft(tracks[2].box[3], `${label} overlay above secondary`).toBeLessThanOrEqual(tracks[1].box[1]);
}

for (const fixture of cases) test(fixture.name, async ({ page }, testInfo) => {
  await configure(page, fixture);
  const frames = [];
  for (const time of fixture.times) {
    const frame = await capture(page, time);
    const metrics = await evidence(frame, testInfo, `t${time}`);
    const pixels = libass(frame.ass, time, testInfo, `t${time}`);
    writeFileSync(testInfo.outputPath(`t${time}-libass.json`), JSON.stringify(pixels, null, 2));
    expect.soft(frame.captured, 'all actual root paint assigned to track records').toBe(frame.assigned);
    for (const [index, track] of frame.tracks.entries()) {
      expect.soft(track.guardEdge, `Canvas track ${index} fits oracle guard band`).toBe(0);
      expect.soft(track.outside, `Canvas track ${index} loses no painted pixels`).toBe(0);
    }
    expect.soft(pixels.outside, 'libass loses no painted pixels').toBe(0);
    expect.soft(pixels.sha256, 'guard-band translation preserves native libass pixels').toBe(pixels.guardCropSha256);
    expect.soft(pixels.fontSelections.length, 'libass records an actual selected font').toBeGreaterThan(0);
    const guard = pixels.guardBox;
    if (guard) {
      expect.soft(guard[0], 'libass full paint fits guard left').toBeGreaterThan(0);
      expect.soft(guard[1], 'libass full paint fits guard top').toBeGreaterThan(0);
      expect.soft(guard[2], 'libass full paint fits guard right').toBeLessThan(pixels.guardSize[0]);
      expect.soft(guard[3], 'libass full paint fits guard bottom').toBeLessThan(pixels.guardSize[1]);
    }
    visibleStack(frame.tracks, frame.width, frame.height, `Canvas t=${time}`);
    visibleStack(['main', 'extension', 'overlay'].map(key => pixels.tracks[key]),
      pixels.width, pixels.height, `libass t=${time}`);
    for (const [index, key] of ['main', 'extension', 'overlay'].entries()) {
      if (!frame.tracks[index]?.box || !pixels.tracks[key]?.box) continue;
      for (const coordinate of [0, 1, 2, 3]) expect.soft(Math.abs(
        frame.tracks[index].box[coordinate] - pixels.tracks[key].box[coordinate]),
      `${key} Canvas/libass edge ${coordinate} agrees within 3 native pixels`).toBeLessThanOrEqual(3);
    }
    frames.push({ canvas: metrics, libass: pixels });
  }
  if (fixture.verifyFit) {
    const tall = frames[0];
    await configure(page, { main: 'M', extension: 'W', overlaySegments: [cue('overlay-control', 'O')] });
    const small = await capture(page, 1000);
    const reference = libass(small.ass, 1000, testInfo, 'fit-single-line-control');
    for (const engine of ['canvas', 'libass']) {
      const full = engine === 'canvas' ? tall.canvas.tracks : ['main', 'extension', 'overlay'].map(k => tall.libass.tracks[k]);
      const base = engine === 'canvas' ? small.tracks : ['main', 'extension', 'overlay'].map(k => reference.tracks[k]);
      const ratios = full.map((track, i) => (track.bands[0][1] - track.bands[0][0]) / (base[i].bands[0][1] - base[i].bands[0][0]));
      expect.soft(full.map(t => t.bands.length), `${engine} preserves every multiline glyph band`).toEqual([11, 3, 3]);
      for (const ratio of ratios) expect.soft(ratio, `${engine} actually shrinks oversized group`).toBeLessThan(0.95);
      for (const ratio of ratios.slice(1)) expect.soft(Math.abs(ratio - ratios[0]), `${engine} fit uses one group factor`).toBeLessThan(0.06);
    }
  }
  if (fixture.verifyMove) for (const engine of ['canvas', 'libass']) {
    const get = frame => engine === 'canvas' ? frame.canvas.tracks : ['main', 'extension', 'overlay'].map(k => frame.libass.tracks[k]);
    const first = get(frames[0]);
    for (const frame of frames.slice(1)) {
      const last = get(frame);
      for (const coordinate of [0, 1]) {
        const mainDelta = last[0].box[coordinate] - first[0].box[coordinate];
        expect.soft(Math.abs(mainDelta), `${engine} move changes actual paint`).toBeGreaterThan(5);
        for (const index of [1, 2]) expect.soft(last[index].box[coordinate] - first[index].box[coordinate],
          `${engine} secondary follows main clock`).toBeCloseTo(mainDelta, 0);
      }
    }
  }
});

test('all simultaneously active main, secondary and overlay cues are actually painted', async ({ page }, testInfo) => {
  const fixture = {
    mainSegments: [cue('main-a', 'MainAlpha'), cue('main-b', 'MainBeta', 500)],
    extensionSegments: [cue('ext-a', 'SecondaryAlpha'), cue('ext-b', 'SecondaryBeta', 500)],
    overlaySegments: [cue('overlay-a', 'OverlayAlpha'), cue('overlay-b', 'OverlayBeta', 500)],
  };
  await configure(page, fixture);
  const frame = await capture(page, 1000);
  await evidence(frame, testInfo, 'overlap');
  const pixels = libass(frame.ass, 1000, testInfo, 'overlap');
  writeFileSync(testInfo.outputPath('overlap-libass.json'), JSON.stringify(pixels, null, 2));
  expect.soft(frame.captured, 'all active root paint is represented by the guard replay').toBe(frame.assigned);
  for (const [index, track] of frame.tracks.entries()) {
    expect.soft(track.outside, `all-active Canvas draw ${index} loses no painted pixels`).toBe(0);
    expect.soft(track.guardEdge, `all-active Canvas draw ${index} fits oracle guard`).toBe(0);
  }
  expect.soft(pixels.outside, 'all-active libass loses no painted pixels').toBe(0);
  expect.soft(pixels.sha256, 'all-active libass guard replay preserves native pixels').toBe(pixels.guardCropSha256);
  expect.soft(pixels.fontSelections.length, 'all-active libass selects a real font').toBeGreaterThan(0);
  if (pixels.guardBox) {
    expect.soft(pixels.guardBox[0], 'all-active libass paint fits guard left').toBeGreaterThan(0);
    expect.soft(pixels.guardBox[1], 'all-active libass paint fits guard top').toBeGreaterThan(0);
    expect.soft(pixels.guardBox[2], 'all-active libass paint fits guard right').toBeLessThan(pixels.guardSize[0]);
    expect.soft(pixels.guardBox[3], 'all-active libass paint fits guard bottom').toBeLessThan(pixels.guardSize[1]);
  }
  for (const [engine, roleTracks] of [['Canvas', frame.nativeTracks], ['libass', pixels.tracks]]) {
    for (const role of ['main', 'extension', 'overlay']) {
      expect.soft(roleTracks[role].painted, `${engine} all-active ${role} is visible`).toBeGreaterThan(30);
      const bands = roleTracks[role].bands;
      expect.soft(bands, `${engine} both active ${role} cues have separate pixel bands`).toHaveLength(2);
      for (const [index, band] of bands.entries()) {
        expect.soft(band[0], `${engine} ${role} band ${index} top`).toBeGreaterThanOrEqual(0);
        expect.soft(band[1], `${engine} ${role} band ${index} bottom`).toBeLessThanOrEqual(frame.height);
        if (index) expect.soft(band[0], `${engine} ${role} active cue bands do not overlap`).toBeGreaterThan(bands[index - 1][1]);
      }
    }
    visibleStack(['main', 'extension', 'overlay'].map(role => roleTracks[role]),
      frame.width, frame.height, `${engine} all-active group`);
  }
  for (const segments of [fixture.mainSegments, fixture.extensionSegments, fixture.overlaySegments]) {
    for (const segment of segments) expect.soft(frame.texts.join(' '),
      `active ${segment.id} must reach actual fillText`).toContain(segment.text);
  }
});

test('overlapping secondary M and W cues occupy separate actual pixel bands', async ({ page }, testInfo) => {
  await configure(page, { extensionSegments: [cue('ext-M', 'M', 0, 2000), cue('ext-W', 'W', 500, 1500)] });
  const frame = await capture(page, 1000);
  await evidence(frame, testInfo, 'secondary-collision');
  const pixels = libass(frame.ass, 1000, testInfo, 'secondary-collision');
  writeFileSync(testInfo.outputPath('secondary-collision-libass.json'), JSON.stringify(pixels, null, 2));
  expect.soft(frame.texts, 'both active cues reach real Canvas paint').toEqual(expect.arrayContaining(['M', 'W']));
  expect.soft(frame.nativeTracks.extension.bands, 'Canvas separates same-track simultaneous cues').toHaveLength(2);
  expect(pixels.tracks.extension.bands, 'libass separates same-track simultaneous cues').toHaveLength(2);
});

test('libass keeps nonlinear transform and fade clocks when a cue is sliced', async ({}, testInfo) => {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,72,&H000000FF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,30,30,180,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const reference = header + 'Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\t(0,1000,2,\\fs144)\\fade(255,0,255,0,1000,1500,2000)}Clock\n';
  const shifted = header + 'Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,{\\t(-500,500,2,\\fs144)\\fade(255,0,255,-500,500,1000,1500)}Clock\n';
  const reset = header + 'Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,{\\t(0,1000,2,\\fs144)\\fade(255,0,255,0,1000,1500,2000)}Clock\n';
  const results = [];
  for (const time of [750, 1750]) {
    const original = libass(reference, time, testInfo, `clock-reference-${time}`);
    const preserved = libass(shifted, time, testInfo, `clock-shifted-${time}`);
    const restarted = libass(reset, time, testInfo, `clock-reset-${time}`);
    results.push({ time, original: original.sha256, preserved: preserved.sha256, restarted: restarted.sha256 });
    expect(preserved.sha256, `sliced nonlinear/fade clock at ${time}ms`).toBe(original.sha256);
    expect(restarted.sha256, `reset clock is observably different at ${time}ms`).not.toBe(original.sha256);
  }
  writeFileSync(testInfo.outputPath('clock-preservation.json'), JSON.stringify(results, null, 2));
});

test('exported layout slices preserve the original main cue nonlinear and fade clocks', async ({ page }, testInfo) => {
  await configure(page, { alignment: 8, marginV: 0,
    mainSegments: [cue('clock-main', 'Clock', 0, 2000)],
    extensionSegments: [cue('clock-secondary', 'W', 500, 1500)],
    animations: {
      t: { enabled: true, startMs: 0, endMs: 1000, accel: 2, tags: '\\fs120' },
      fade: { enabled: true, alpha1: 255, alpha2: 0, alpha3: 255, t1: 0, t2: 1000, t3: 1500, t4: 2000 },
    },
  });
  const sources = await page.evaluate(() => {
    const grouped = MaweExportSrt.buildAss();
    MaweBoot.DATA.multi_subtitle.enabled = false;
    MaweBoot.DATA.overlay_track.enabled = false;
    return { grouped, standalone: MaweExportSrt.buildAss() };
  });
  const rows = [];
  for (const time of [750, 1750]) {
    const grouped = libass(sources.grouped, time, testInfo, `candidate-clock-grouped-${time}`);
    const original = libass(sources.standalone, time, testInfo, `candidate-clock-standalone-${time}`);
    rows.push({ time, grouped: grouped.tracks.main, original: original.tracks.main });
    expect(grouped.tracks.main.painted, `main remains visible at ${time}ms`).toBeGreaterThan(30);
    expect(grouped.tracks.main.glyphSha256,
      `layout may move main, but must not restart its nonlinear transform/fade at ${time}ms`)
      .toBe(original.tracks.main.glyphSha256);
  }
  writeFileSync(testInfo.outputPath('candidate-clock-comparison.json'), JSON.stringify(rows, null, 2));
  // This fixture changes the visible top-edge group at 500/1500ms. Merely
  // emitting the untouched original cue would make the hash check vacuous.
  const mainEvents = sources.grouped.split('\n').filter(line => line.startsWith('Dialogue: 0,'));
  expect(mainEvents.length, 'actual grouped export slices main at active-layout boundaries').toBeGreaterThan(1);
  for (const boundary of ['0:00:00.50', '0:00:01.50']) expect(mainEvents.some(line => line.split(',')[1] === boundary),
    `actual main slice begins at ${boundary}`).toBe(true);
});

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
  { name: '1440p preview and burn share the native frame coordinate system',
    width: 2560, height: 1440, times: [1000] },
  { name: 'main explicit multiline', main: 'Main one\nMain two\nMain three', times: [1000] },
  { name: 'secondary explicit multiline', extension: 'Secondary one\nSecondary two\nSecondary three', times: [1000] },
  { name: 'largest emphasis and comment runs', main: 'Main **BIG**\n%%COMMENT%%',
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
  { name: 'emphasis and comment font-size clocks survive fractional group fit', marginV: 220,
    main: 'Plain **BIG**\n%%COMMENT%%\nPlain **BIG**\n%%COMMENT%%',
    extension: 'Secondary **BIG**\n%%COMMENT%%',
    emphasisScale: 2.4, commentScale: 2.2,
    animations: { t: { enabled: true, startMs: 0, endMs: 1500, accel: 2, tags: '\\fs120\\frz10' } },
    times: [250, 750, 1250] },
  { name: 'inline italic markers agree between canvas and libass', marginV: 220,
    main: '//Italic words// and %%MUTED%% text',
    extension: 'Secondary //slanted//', times: [1000] },
  { name: 'zero move times interpolate over the complete cue',
    animations: { move: { enabled: true, x1: 300, y1: 560, x2: 750, y2: 420, t1: 0, t2: 0 } },
    times: [250, 1000, 1750], verifyMove: true, verifyOriginalMove: true },
  { name: 'equal nonzero move times switch at their actual clock boundary',
    animations: { move: { enabled: true, x1: 300, y1: 560, x2: 750, y2: 420, t1: 500, t2: 500 } },
    times: [490, 500, 510], verifyOriginalMove: true },
  { name: 'zero transform times retain the original nonlinear whole-cue font-size clock',
    animations: { t: { enabled: true, startMs: 0, endMs: 0, accel: 2, tags: '\\fs120' } },
    times: [500, 2000, 3000], verifyOriginalTransform: true, verifyGrowth: true },
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
      outline: f.outline ?? 0, shadow: f.shadow ?? 0, spacing: f.spacing ?? 0,
      outlineColor: f.outlineColor ?? '#000000', backColor: f.backColor ?? '#000000',
      outlineOpacity: 100, backOpacity: 100,
      angle: f.angle ?? 0, scaleX: f.scaleX ?? 100,
      scaleY: f.scaleY ?? 100, emphasisScale: f.emphasisScale ?? 1.1,
      commentScale: f.commentScale ?? 0.8, emphasisStyle: 'text', commentStyle: 'text' };
    Object.assign(main, common, { primaryColor: '#ff0000', emphasisColor: '#ff0000', commentColor: '#ff0000' });
    // 副字幕跟随其样式预设：默认 marginV 60 让它落在主字幕（180）下方。
    Object.assign(extension, common, { fontSize: f.extensionFontSize ?? 72, alignment: f.extensionAlignment ?? 2,
      marginV: f.extensionMarginV ?? 60,
      primaryColor: '#00ff00', emphasisColor: '#00ff00', commentColor: '#00ff00' });
    ASS_STYLE_LIBRARY.assProfiles[0].animations = {
      fad: { enabled: false }, fade: { enabled: false }, move: { enabled: false },
      t: { enabled: false }, ...(f.animations || {}),
    };
    // Preserve unique track fill colours for the independent libass masks.
    for (const [name, value] of [['red', '#ff0000'], ['green', '#00ff00'], ['blue', '#0000ff']]) {
      MaweColors.COLOR_BY_NAME[name].value = value;
    }
    MaweBoot.DATA.media_metadata = { video_width: f.width ?? 1280, video_height: f.height ?? 720 };
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
    const fontPaints = [];
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
      fontPaints.push({ text: String(text), font: this.font });
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
      const observed = draws.slice(cursor, cursor + count);
      for (const d of observed) {
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
      return { painted, outside, guardEdge, bands, paintTransforms: observed.map(d => d.matrix),
        box: painted ? [left - padding, top - padding, right - padding, bottom - padding] : null };
    });
    const nativeTracks = Object.fromEntries(['main', 'extension', 'overlay'].map(key => [key,
      { painted: 0, box: null, bands: [], peak: 0 }]));
    const nativePixels = native.getContext('2d').getImageData(0, 0, width, height).data;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (nativePixels[offset + 3] < 16) continue;
      for (const [index, key] of ['main', 'extension', 'overlay'].entries()) {
        const value = nativePixels[offset + index];
        if (value > Math.max(nativePixels[offset + (index + 1) % 3], nativePixels[offset + (index + 2) % 3]) + 30) {
          // Canvas stores unpremultiplied RGB; composite onto black to match libass's RGB output.
          nativeTracks[key].peak = Math.max(nativeTracks[key].peak, value * nativePixels[offset + 3] / 255);
        }
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
    return { width, height, tracks, nativeTracks, texts, fontPaints, captured: draws.length, assigned: cursor,
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

function visibleStack(tracks, width, height, label, { skipStackOrder = false } = {}) {
  expect.soft(tracks, label).toHaveLength(3);
  for (const [index, track] of tracks.entries()) {
    expect.soft(track.painted, `${label} track ${index} exists`).toBeGreaterThan(30);
    if (!track.box) continue;
    expect.soft(track.box[0], `${label} track ${index} left`).toBeGreaterThanOrEqual(0);
    expect.soft(track.box[1], `${label} track ${index} top`).toBeGreaterThanOrEqual(0);
    expect.soft(track.box[2], `${label} track ${index} right`).toBeLessThanOrEqual(width);
    expect.soft(track.box[3], `${label} track ${index} bottom`).toBeLessThanOrEqual(height);
  }
  // 副字幕跟随其样式预设：与主字幕不重叠即可（默认预设下位于主字幕下方）；
  // 叠加字幕固定锚定在主字幕上方。
  if (!skipStackOrder) {
    if (tracks[1]?.box && tracks[0]?.box) expect.soft(
      tracks[1].box[1] >= tracks[0].box[3]
        || tracks[1].box[3] <= tracks[0].box[1]
        || tracks[1].box[1] >= tracks[0].box[1],
      `${label} secondary sits below or clear of main`,
    ).toBe(true);
    if (tracks[2]?.box && tracks[0]?.box) expect.soft(tracks[2].box[3], `${label} overlay above main`).toBeLessThanOrEqual(tracks[0].box[1]);
  }
}

for (const fixture of cases) test(fixture.name, async ({ page }, testInfo) => {
  await configure(page, fixture);
  const originalClock = fixture.verifyOriginalMove || fixture.verifyOriginalTransform ? await page.evaluate(() => {
    MaweBoot.DATA.multi_subtitle.enabled = false;
    MaweBoot.DATA.overlay_track.enabled = false;
    const source = MaweExportSrt.buildAss();
    MaweBoot.DATA.multi_subtitle.enabled = true;
    MaweBoot.DATA.overlay_track.enabled = true;
    return source;
  }) : null;
  const frames = [];
  for (const time of fixture.times) {
    const frame = await capture(page, time);
    const metrics = await evidence(frame, testInfo, `t${time}`);
    const pixels = libass(frame.ass, time, testInfo, `t${time}`);
    if (originalClock) {
      // The legacy single-cue raw libass animation is the independent timing oracle.
      // Matching two consumers of the group planner would be circular.
      const original = libass(originalClock, time, testInfo, `original-clock-${time}`);
      writeFileSync(testInfo.outputPath(`original-clock-${time}.json`), JSON.stringify(original, null, 2));
      for (const engine of ['canvas', 'libass']) {
        const box = engine === 'canvas' ? frame.tracks[0].box : pixels.tracks.main.box;
        for (const coordinate of [0, 1, 2, 3]) expect.soft(Math.abs(
          box[coordinate] - original.tracks.main.box[coordinate]),
        `${engine} main preserves the original libass animation clock edge ${coordinate} at ${time}ms`).toBeLessThanOrEqual(3);
      }
    }
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
    visibleStack(frame.tracks, frame.width, frame.height, `Canvas t=${time}`, fixture);
    visibleStack(['main', 'extension', 'overlay'].map(key => pixels.tracks[key]),
      pixels.width, pixels.height, `libass t=${time}`, fixture);
    for (const [index, key] of ['main', 'extension', 'overlay'].entries()) {
      if (!frame.tracks[index]?.box || !pixels.tracks[key]?.box) continue;
      for (const coordinate of [0, 1, 2, 3]) expect.soft(Math.abs(
        frame.tracks[index].box[coordinate] - pixels.tracks[key].box[coordinate]),
      `${key} Canvas/libass edge ${coordinate} agrees within 3 native pixels`).toBeLessThanOrEqual(3);
    }
    frames.push({ canvas: metrics, libass: pixels });
  }
  if (fixture.verifyGrowth) for (const engine of ['canvas', 'libass']) {
    const box = frame => engine === 'canvas' ? frame.canvas.tracks[0].box : frame.libass.tracks.main.box;
    const initial = box(frames[0]);
    for (const frame of frames.slice(1)) {
      const grown = box(frame);
      expect.soft(grown[3] - grown[1] - (initial[3] - initial[1]),
        `${engine} actual whole-cue font-size animation visibly grows instead of stepping`).toBeGreaterThan(5);
    }
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
      // 组缩放只作用于主/叠加；副字幕跟随其样式预设，字号不被整组缩小。
      expect.soft(ratios[0], `${engine} actually shrinks oversized group`).toBeLessThan(0.95);
      expect.soft(ratios[1], `${engine} secondary keeps its preset size`).toBeGreaterThan(0.95);
      expect.soft(ratios[2], `${engine} overlay follows the group factor`).toBeLessThan(0.95);
      expect.soft(Math.abs(ratios[2] - ratios[0]), `${engine} fit uses one group factor`).toBeLessThan(0.06);
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
        // Equal continuous displacement can produce integer bbox deltas differing
        // by one pixel: floor(p + d) - floor(p) is floor(d) or ceil(d), depending
        // on each glyph's raster phase. This changes no 3px cross-renderer bound.
        // 副字幕固定在样式预设位置：不随主字幕的移动动画平移；
        // 叠加字幕仍跟随主字幕移动（组移动语义只覆盖主/叠加）。
        expect.soft(Math.abs(
          last[1].box[coordinate] - first[1].box[coordinate]),
        `${engine} secondary keeps its preset position while main moves`).toBeLessThanOrEqual(1);
        for (const index of [2]) expect.soft(Math.abs(
          last[index].box[coordinate] - first[index].box[coordinate] - mainDelta),
        `${engine} overlay follows main clock after pixel quantization`).toBeLessThanOrEqual(1);
        if (engine === 'canvas') {
          const translation = coordinate + 4;
          const rootDelta = last[0].paintTransforms[0][translation] - first[0].paintTransforms[0][translation];
          for (const index of [2]) expect.soft(
            last[index].paintTransforms[0][translation] - first[index].paintTransforms[0][translation],
            'observed root drawImage matrices prove an identical continuous group displacement')
            .toBeCloseTo(rootDelta, 6);
        }
      }
    }
  }
});

test('solo inline italic and immediate targets agree before during and after the original transform clock', async ({ page }, testInfo) => {
  test.setTimeout(180_000); // Six frames from exported ASS and an explicit per-run reference.
  for (const target of [0, 1]) {
    await configure(page, { main: 'MAIN //MMMM// TAIL', extensionSegments: [], overlaySegments: [],
      animations: { t: { enabled: true, startMs: 100, endMs: 1100, tags: `\\i${target}` } } });
    await page.evaluate(value => { ASS_STYLE_LIBRARY.styles.find(style => style.id === 'ass').italic = !value; }, target);
    for (const time of [50, 500, 1500]) {
      const frame = await capture(page, time);
      const label = `solo-italic-${target}-${time}`;
      await evidence(frame, testInfo, label);
      expect(await page.evaluate(() => window.MaweAssPreview.stackPlan.slices.every(slice => slice.legacy))).toBe(true);
      for (const [text, italic] of [['MAIN ', Boolean(target)], ['MMMM', true], [' TAIL', Boolean(target)]]) {
        const painted = frame.fontPaints.filter(item => item.text === text);
        expect(painted.length, `real Canvas paints ${text}`).toBeGreaterThan(0);
        for (const item of painted) expect(/^italic /u.test(item.font), `${text} italic at ${time}ms`).toBe(italic);
      }
      const event = frame.ass.split('\n').find(line => line.startsWith('Dialogue:'));
      expect(event).toContain(`\\t(100,1100,1,\\i${target})`);
      const expectedBody = target ? 'MAIN MMMM TAIL' : String.raw`MAIN {\i1}MMMM{\i0} TAIL`;
      const expected = frame.ass.replace(event, event.slice(0, event.indexOf('MAIN ')) + expectedBody);
      const actualPixels = libass(frame.ass, time, testInfo, label);
      const expectedPixels = libass(expected, time, testInfo, `${label}-expected`);
      expect(actualPixels.sha256, 'real libass matches the explicit per-run italic reference').toBe(expectedPixels.sha256);
    }
  }
});

test('all simultaneously active main, secondary and overlay cues are actually painted', async ({ page }, testInfo) => {
  const fixture = {
    // 双条同轨副字幕的碰撞堆叠可能穿越主字幕（fs144 主字幕下方空间不足）：
    // 该用例只验证三条轨都真实绘制与轨内分离，跳过跨轨层叠顺序断言。
    skipStackOrder: true,
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
      frame.width, frame.height, `${engine} all-active group`, fixture);
  }
  for (const segments of [fixture.mainSegments, fixture.extensionSegments, fixture.overlaySegments]) {
    for (const segment of segments) expect.soft(frame.texts.join(' '),
      `active ${segment.id} must reach actual fillText`).toContain(segment.text);
  }
});

test('three overlapping secondary cues occupy separate actual pixel bands', async ({ page }, testInfo) => {
  await configure(page, { extensionSegments: [cue('ext-M', 'M', 0, 2000),
    cue('ext-W', 'W', 500, 1500), cue('ext-H', 'H', 500, 1500)] });
  const frame = await capture(page, 1000);
  await evidence(frame, testInfo, 'secondary-collision');
  const pixels = libass(frame.ass, 1000, testInfo, 'secondary-collision');
  writeFileSync(testInfo.outputPath('secondary-collision-libass.json'), JSON.stringify(pixels, null, 2));
  expect.soft(frame.texts, 'all active cues reach real Canvas paint').toEqual(expect.arrayContaining(['M', 'W', 'H']));
  expect.soft(frame.nativeTracks.extension.bands, 'Canvas separates same-track simultaneous cues').toHaveLength(3);
  expect(pixels.tracks.extension.bands, 'libass separates same-track simultaneous cues').toHaveLength(3);
});

test('secondary preset paint remains fixed before during and after the main cue', async ({ page }, testInfo) => {
  await configure(page, { mainSegments: [cue('short-main', 'Main', 500, 1500)],
    extensionSegments: [cue('long-secondary', 'Secondary', 0, 2000)], overlaySegments: [] });
  let previous;
  for (const time of [250, 1000, 1750]) {
    const frame = await capture(page, time);
    await evidence(frame, testInfo, `secondary-alone-${time}`);
    const pixels = libass(frame.ass, time, testInfo, `secondary-alone-${time}`);
    writeFileSync(testInfo.outputPath(`secondary-alone-${time}-libass.json`), JSON.stringify(pixels, null, 2));
    const actual = frame.nativeTracks.extension.box;
    expect(actual, 'Canvas paints the fixed extension').not.toBeNull();
    expect(pixels.tracks.extension.box, 'libass paints the fixed extension').not.toBeNull();
    for (const coordinate of [0, 1, 2, 3]) expect(Math.abs(actual[coordinate]
      - pixels.tracks.extension.box[coordinate]), `fixed extension edge ${coordinate} at ${time}ms`).toBeLessThanOrEqual(3);
    if (previous) expect(actual, 'main entering/leaving cannot move the extension').toEqual(previous);
    previous = actual;
  }
});

test('cumulative fixed secondary overflow refuses export instead of silently overlapping', async ({ page }) => {
  await configure(page, { height: 240, extensionFontSize: 168, extensionMarginV: 20,
    extensionSegments: [cue('ext-a', 'A\nA'), cue('ext-b', 'B\nB'), cue('ext-c', 'C\nC')] });
  await expect(page.locator('#overlay')).toHaveAttribute('data-ass-stack-status', 'unavailable');
  const result = await page.evaluate(() => {
    let plan;
    MaweExportSrt.buildAss({ preview: true, allowAssPlanDiagnostics: true, onAssPlan: value => { plan = value; } });
    return { diagnostics: plan.diagnostics, painted: window.MaweAssCanvas.lastRender.tracks.length };
  });
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0].message).toMatch(/固定副字幕.*同时容纳/);
  expect(result.painted).toBe(0);
  await expect(page.evaluate(() => MaweExportSrt.buildAss())).rejects.toThrow(/固定副字幕.*同时容纳/);
});

test('positive spacing and coloured outline shadow keep complete multiline edge paint visible', async ({ page }, testInfo) => {
  await configure(page, { alignment: 7, extensionAlignment: 1, marginL: 0, marginV: 0,
    spacing: 8, outline: 6, shadow: 5, outlineColor: '#ff9900', backColor: '#cc00cc',
    main: 'Main edge\nMain second', extension: 'Secondary edge\nSecondary second',
    overlaySegments: [cue('coloured-overlay', 'Overlay edge\nOverlay second')] });
  const frame = await capture(page, 1000);
  await evidence(frame, testInfo, 'coloured-edge');
  const combined = libass(frame.ass, 1000, testInfo, 'coloured-edge');
  const canvasColours = await page.evaluate(() => {
    const canvas = document.querySelector('.ass-preview-canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return Object.fromEntries([['outline', [255, 153, 0]], ['shadow', [204, 0, 204]]].map(([key, rgb]) => {
      let painted = 0;
      for (let offset = 0; offset < data.length; offset += 4) if (data[offset + 3] > 220
        && rgb.every((channel, index) => Math.abs(data[offset + index] - channel) <= 12)) painted++;
      return [key, painted];
    }));
  });
  for (const colour of ['outline', 'shadow']) {
    expect.soft(canvasColours[colour], `actual Canvas ${colour} colour is painted`).toBeGreaterThan(30);
    expect.soft(combined.paintColours[colour], `actual libass ${colour} colour is painted`).toBeGreaterThan(30);
  }
  expect.soft(combined.sha256, 'coloured full group guard preserves native pixels').toBe(combined.guardCropSha256);
  expect.soft(combined.outside, 'coloured full group loses no outline or shadow pixels').toBe(0);
  const isolated = [];
  for (const [index, role] of ['main', 'extension', 'overlay'].entries()) {
    // Keep the actual generated positions/styles/animations; isolate only the
    // role's Dialogue rows to measure its coloured outline/shadow without masks.
    const source = frame.ass.split('\n').filter(line => !line.startsWith('Dialogue: ')
      || Number(line.slice(10).split(',')[0]) === index).join('\n');
    const pixels = libass(source, 1000, testInfo, `coloured-${role}-isolated`);
    const padding = (pixels.guardSize[0] - pixels.width) / 2;
    const box = pixels.guardBox.map(coordinate => coordinate - padding);
    isolated.push({ painted: pixels.fullPainted, box });
    expect.soft(pixels.sha256, `${role} full-colour guard preserves native pixels`).toBe(pixels.guardCropSha256);
    expect.soft(pixels.outside, `${role} loses no outline or shadow pixels`).toBe(0);
    expect.soft(frame.tracks[index].outside, `Canvas ${role} loses no outline or shadow pixels`).toBe(0);
    expect.soft(frame.tracks[index].guardEdge, `Canvas ${role} full paint fits guard`).toBe(0);
    for (const coordinate of [0, 1, 2, 3]) expect.soft(Math.abs(frame.tracks[index].box[coordinate] - box[coordinate]),
      `${role} full-colour Canvas/libass edge ${coordinate} agrees within 3 pixels`).toBeLessThanOrEqual(3);
  }
  visibleStack(frame.tracks, frame.width, frame.height, 'Canvas coloured multiline edge');
  visibleStack(isolated, frame.width, frame.height, 'isolated libass coloured multiline edge');
  writeFileSync(testInfo.outputPath('coloured-edge-pixels.json'), JSON.stringify({ canvasColours, combined, isolated }, null, 2));
});

for (const [name, marker, tag] of [['underline', '_', 'u'], ['strikeout', '~', 's']]) {
  test(`global ${name} survives the end of a locally marked run in actual pixels`, async ({ page }, testInfo) => {
    await configure(page, { main: `MMMM ${marker}MMMM${marker} MMMM`,
      animations: { t: { enabled: true, startMs: 0, endMs: 1000, accel: 1, tags: `\\${tag}1` } } });
    const frame = await capture(page, 750);
    await evidence(frame, testInfo, `global-${name}`);
    // Build an independent three-run control after the actual geometry/clock
    // prefix. A correct exporter may omit every redundant local decoration
    // override, so mutating its existing restore tags would be a vacuous oracle.
    const restore = value => frame.ass.split('\n').map(line => {
      if (!line.startsWith('Dialogue: 0,')) return line;
      const textStart = line.indexOf('MMMM');
      expect(textStart, 'control locates the known main cue after actual override tags').toBeGreaterThan(0);
      return line.slice(0, textStart) + `MMMM {\\${tag}1}MMMM{\\${tag}${value}} MMMM`;
    }).join('\n');
    const control = libass(restore(1), 750, testInfo, `${name}-restore-global-control`);
    const broken = libass(restore(0), 750, testInfo, `${name}-reset-false-control`);
    const actual = libass(frame.ass, 750, testInfo, `${name}-actual`);
    expect(control.tracks.main.glyphSha256, 'restoring the wrong decoration is visibly distinguishable')
      .not.toBe(broken.tracks.main.glyphSha256);
    expect.soft(actual.tracks.main.glyphSha256, 'actual exported glyphs preserve the active global decoration')
      .toBe(control.tracks.main.glyphSha256);
    const canvasCoverage = await page.evaluate(() => {
      const canvas = document.querySelector('.ass-preview-canvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let widest = 0;
      for (let y = 0; y < canvas.height; y++) {
        let painted = 0;
        for (let x = 0; x < canvas.width; x++) {
          const offset = (y * canvas.width + x) * 4;
          if (data[offset + 3] >= 16 && data[offset] > 60 && data[offset] > Math.max(data[offset + 1], data[offset + 2]) + 30) painted++;
        }
        widest = Math.max(widest, painted);
      }
      return widest;
    });
    expect.soft(canvasCoverage / (frame.nativeTracks.main.box[2] - frame.nativeTracks.main.box[0]),
      'actual Canvas decoration covers all three runs').toBeGreaterThan(0.9);
    expect.soft(actual.tracks.main.maxRowPainted / (actual.tracks.main.box[2] - actual.tracks.main.box[0]),
      'actual libass decoration covers all three runs').toBeGreaterThan(0.9);
    writeFileSync(testInfo.outputPath(`${name}-comparison.json`), JSON.stringify({ actual, control, broken, canvasCoverage }, null, 2));
  });
}

for (const [name, t1, t2] of [['instant', 500, 500], ['linear', 0, 1000]]) {
  test(`${name} main move retains its original clock through shared and solo layout slices`, async ({ page }, testInfo) => {
    await configure(page, { mainSegments: [cue('move-main', 'Main', 0, 2000)],
      extensionSegments: [cue('move-secondary', 'W', 500, 1500)],
      animations: { move: { enabled: true, x1: 400, y1: 560, x2: 1000, y2: 560, t1, t2 } } });
    const original = await page.evaluate(() => {
      MaweBoot.DATA.overlay_track.enabled = false;
      MaweBoot.DATA.multi_subtitle.enabled = false;
      const source = MaweExportSrt.buildAss();
      MaweBoot.DATA.multi_subtitle.enabled = true;
      return source;
    });
    const results = [];
    for (const time of [490, 500, 501, 1490, 1500, 1501, 1750]) {
      const frame = await capture(page, time);
      await evidence(frame, testInfo, `slice-move-${time}`);
      const pixels = libass(frame.ass, time, testInfo, `slice-move-${time}`);
      const reference = libass(original, time, testInfo, `unsplit-move-${time}`);
      results.push({ time, canvas: frame.nativeTracks.main, grouped: pixels.tracks.main, original: reference.tracks.main });
      expect.soft(frame.captured, 'slice move records all actual paint').toBe(frame.assigned);
      expect.soft(pixels.sha256, `slice move guard preserves native pixels at ${time}`).toBe(pixels.guardCropSha256);
      expect.soft(pixels.outside, `slice move clips no libass pixels at ${time}`).toBe(0);
      for (const track of frame.tracks) expect.soft(track.outside, `slice move clips no Canvas pixels at ${time}`).toBe(0);
      for (const [engine, box] of [['Canvas', frame.nativeTracks.main.box], ['libass', pixels.tracks.main.box]]) {
        for (const coordinate of [0, 1, 2, 3]) expect.soft(Math.abs(box[coordinate] - reference.tracks.main.box[coordinate]),
          `${engine} preserves unsplit move clock edge ${coordinate} at shared/solo boundary ${time}ms`).toBeLessThanOrEqual(3);
      }
      if (results.length > 1) {
        const previous = results[results.length - 2];
        for (const engine of ['canvas', 'grouped']) expect.soft(results[results.length - 1][engine].box[0],
          `${engine} cannot jump back when the secondary cue ends`).toBeGreaterThanOrEqual(previous[engine].box[0] - 1);
      }
    }
    writeFileSync(testInfo.outputPath('slice-move-clock-comparison.json'), JSON.stringify(results, null, 2));
  });
}

test('overlapping fad intervals retain libass fade-in priority in actual pixels', async ({ page }, testInfo) => {
  await configure(page, {
    mainSegments: [cue('fade-main', 'Main', 0, 1000)],
    extensionSegments: [cue('fade-extension', 'Secondary', 0, 1000)],
    overlaySegments: [cue('fade-overlay', 'Overlay', 0, 1000)],
    animations: { fad: { enabled: true, inMs: 800, outMs: 800 } },
  });
  const standalone = await page.evaluate(() => {
    MaweBoot.DATA.multi_subtitle.enabled = false;
    MaweBoot.DATA.overlay_track.enabled = false;
    const source = MaweExportSrt.buildAss();
    MaweBoot.DATA.multi_subtitle.enabled = true;
    MaweBoot.DATA.overlay_track.enabled = true;
    return source;
  });
  const results = [];
  for (const time of [250, 500, 750]) {
    const frame = await capture(page, time);
    await evidence(frame, testInfo, `overlap-fad-${time}`);
    const pixels = libass(frame.ass, time, testInfo, `overlap-fad-${time}`);
    const original = libass(standalone, time, testInfo, `original-fad-${time}`);
    results.push({ time, canvas: frame.nativeTracks, grouped: pixels, original });
    expect.soft(pixels.sha256, 'fad guard render preserves native pixels').toBe(pixels.guardCropSha256);
    expect.soft(pixels.outside, 'fad group loses no actual pixels').toBe(0);
    for (const role of ['main', 'extension', 'overlay']) {
      expect.soft(frame.nativeTracks[role].painted, `Canvas ${role} actually paints at ${time}ms`).toBeGreaterThan(30);
      expect.soft(pixels.tracks[role].painted, `libass ${role} actually paints at ${time}ms`).toBeGreaterThan(30);
      expect.soft(Math.abs(frame.nativeTracks[role].peak - pixels.nativeTracks[role].peak),
        `${role} actual composited peak opacity matches libass at ${time}ms`).toBeLessThanOrEqual(2);
    }
    expect.soft(Math.abs(pixels.nativeTracks.main.peak - original.nativeTracks.main.peak),
      `sliced grouped fade matches the original libass fad priority at ${time}ms`).toBeLessThanOrEqual(2);
  }
  writeFileSync(testInfo.outputPath('overlap-fad-pixels.json'), JSON.stringify(results, null, 2));
});

for (const diagnostic of ['raw 3D perspective', 'negative base spacing', 'negative transform spacing', 'unreadable group fit']) {
  test(`actual ASS export UI reports ${diagnostic} without saving or rejecting`, async ({ page }, testInfo) => {
    const pageErrors = [];
    const downloads = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('download', download => downloads.push(download.suggestedFilename()));
    await page.addInitScript(() => {
      window.__stackSaveRequests = [];
      window.__stackUnhandledRejections = [];
      window.addEventListener('unhandledrejection', event => {
        window.__stackUnhandledRejections.push(String(event.reason?.message || event.reason));
      });
      window.showSaveFilePicker = async options => {
        window.__stackSaveRequests.push(options.suggestedName);
        return { name: options.suggestedName, async createWritable() {
          return { async write() {}, async close() {} };
        } };
      };
    });
    await configure(page, {});
    const expectedDiagnostic = await page.evaluate(kind => {
      const main = ASS_STYLE_LIBRARY.styles.find(style => style.id === 'ass');
      const animations = ASS_STYLE_LIBRARY.assProfiles[0].animations;
      if (kind === 'raw 3D perspective') animations.t = { enabled: true, startMs: 0, endMs: 1000, accel: 1, tags: '\\frx30' };
      if (kind === 'negative base spacing') main.spacing = -100;
      if (kind === 'negative transform spacing') animations.t = { enabled: true, startMs: 0, endMs: 1000, accel: 1, tags: '\\fsp-100' };
      if (kind === 'unreadable group fit') MaweBoot.DATA.segments[0].text = Array(200).fill('M').join('\n');
      MaweBoot.DATA.gap_remove = { schema: 'moy.asr.gap_remove.v1', detector: 'audio_gate',
        minimum_ms: 500, threshold_db: -24, hysteresis_db: 2, lead_in_ms: 40, lead_out_ms: 80,
        skip_playback: true, operation_mode: 'boundary_drag', manual_corrections: false,
        gaps: [{ start: 3900, end: 4000, removed: true }] };
      MaweGapRemoveUi.updateGapRemoveUi();
      MaweCuePanel.renderAll();
      try { MaweExportSrt.buildAss(); return ''; } catch (error) { return String(error.message); }
    }, diagnostic);
    expect.soft(expectedDiagnostic, 'real project invokes the production planner diagnostic').not.toBe('');
    for (const [menu, button] of [['#subtitle-export-btn', '#download-full-ass'],
      ['#gap-removed-export-btn', '#download-gap-removed-ass']]) {
      await page.evaluate(() => document.querySelector('#hint-stack')?.replaceChildren());
      await page.locator(menu).click();
      await page.locator(button).click();
      // Observe the real handler, DOM hint, browser picker and rejection event;
      // none of the production export or diagnostic functions are substituted.
      const hint = page.locator('#hint-stack .hint-card').last();
      await expect.soft(hint, `${button} surfaces the failed export`).toBeVisible();
      if (expectedDiagnostic) await expect.soft(hint, `${button} displays the actual planner reason`).toContainText(expectedDiagnostic);
      expect.soft(await page.evaluate(() => window.__stackSaveRequests), `${button} never opens a save picker`).toEqual([]);
      expect.soft(await page.evaluate(() => window.__stackUnhandledRejections), `${button} handles its async rejection`).toEqual([]);
      expect.soft(downloads, `${button} never creates a browser download`).toEqual([]);
      expect.soft(pageErrors, `${button} produces no uncaught page error`).toEqual([]);
    }
    await page.screenshot({ path: testInfo.outputPath('actual-export-diagnostic.png') });
    writeFileSync(testInfo.outputPath('actual-export-diagnostic.json'), JSON.stringify({ diagnostic, expectedDiagnostic,
      pageErrors, downloads, ...await page.evaluate(() => ({ saves: window.__stackSaveRequests,
        rejections: window.__stackUnhandledRejections })) }, null, 2));
  });
}

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

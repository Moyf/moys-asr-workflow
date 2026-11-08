import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;
const plan = h.buildProjectExportPlan({ media: 'C:/demo/source.mp4', segments: [
  { start: 0, end: 2000, text: 'TEST' },
] }, { timelineMode: 'source', fps: '25', durationMs: 3000 });
const manifest = { fps: '25', durationFrames: 75, width: 1920, height: 1080, imageFormat: 'webp',
  sourcePath: 'C:/demo/source.mp4', tracks: [
    { layer: 0, lane: 0, clips: [{ startFrame: 0, endFrame: 5, path: 'C:/demo/a & b.webp' },
      { startFrame: 5, endFrame: 50, path: 'C:/demo/hold.webp' }] },
    { layer: 2, lane: 0, clips: [{ startFrame: 10, endFrame: 40, path: 'C:/demo/hold.webp' }] },
  ] };

test('WebP handoff keeps two tracks, static holds, alpha and URL escaping', () => {
  const xml = h.serializeFcp7PngXml(plan, manifest);
  assert.equal((xml.match(/<track>/g) || []).length, 2);
  assert.equal((xml.match(/<clipitem /g) || []).length, 3);
  assert.ok(xml.includes('<start>5</start><end>50</end>'));
  assert.ok(xml.includes('<alphatype>straight</alphatype>'));
  assert.ok(xml.includes('a%20%26%20b.webp'));
  assert.equal((xml.match(/<pathurl>/g) || []).length, 2);
  assert.ok(!xml.includes('GraphicAndType'));
  assert.ok(!xml.includes('source.mp4'));
  assert.ok(xml.includes('MAW WebP subtitles'));
});

test('legacy PNG manifest paths remain usable without a format field', () => {
  const legacy = JSON.parse(JSON.stringify(manifest).replaceAll('.webp', '.png'));
  delete legacy.imageFormat;
  const xml = h.serializeFcp7PngXml(plan, legacy);
  assert.ok(xml.includes('MAW PNG subtitles'));
  assert.ok(xml.includes('a%20%26%20b.png'));
  assert.ok(!xml.includes('.webp'));
  assert.equal((xml.match(/<clipitem /g) || []).length, 3);
});

test('media scope adds the source timeline without replacing subtitle tracks', () => {
  const xml = h.serializeFcp7PngXml(plan, manifest, { includeMedia: true });
  assert.ok(xml.includes('source.mp4'));
  assert.ok(xml.includes('<clipitem id="png-1-0">'));
  assert.ok(xml.includes('<audio>'));
});

test('manifest with wrong clock or overlapping clips is rejected', () => {
  assert.throws(() => h.serializeFcp7PngXml(plan, { ...manifest, fps: '30' }), /match/);
  const bad = JSON.parse(JSON.stringify(manifest));
  bad.tracks[0].clips[1].startFrame = 4;
  assert.throws(() => h.serializeFcp7PngXml(plan, bad), /range/);
});

test('long static image has sufficient source duration in minutes and frame-based placement', () => {
  const longPlan = h.buildProjectExportPlan({ media: 'C:/demo/source.mp4', segments: [
    { start: 0, end: 180000, text: 'HOLD' },
  ] }, { timelineMode: 'source', fps: '25', durationMs: 180000 });
  const longManifest = { ...manifest, durationFrames: 4500, tracks: [
    { clips: [{ startFrame: 0, endFrame: 4500, path: 'C:/demo/hold.webp' }] },
  ] };
  const xml = h.serializeFcp7PngXml(longPlan, longManifest);
  assert.ok(xml.includes('<duration>3</duration>'));
  assert.ok(xml.includes('<start>0</start><end>4500</end><in>0</in><out>4500</out>'));
});

test('PNG metadata names preserve cue identity across full-context ASS layout slices', () => {
  const ass = h.buildAssPayload([{ start: 0, end: 2000, text: 'MAIN' }], {
    pngEventNames: true, assProfile: { animations: {} },
    assExtensionStyle: { fontSize: 36, alignment: 8 },
    extensionSegments: [{ start: 500, end: 1000, text: 'EXT' }],
  });
  const events = ass.split('\n').filter(line => line.startsWith('Dialogue:'));
  assert.ok(events.filter(line => line.includes(',maw:main:0,')).length >= 2);
  assert.ok(events.some(line => line.includes(',maw:extension:0,')));
});

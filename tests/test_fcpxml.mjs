import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadEditorModule, prepareEditorModule } from './helpers/editor-module-loader.mjs';

await prepareEditorModule('shared/editor-utils.js');
const { AsrEditorUtils: { buildFcpxmlTitlePlan } } = loadEditorModule({ window: {} }, 'shared/editor-utils.js');
const sample = () => JSON.parse(fs.readFileSync(new URL('./fixtures/fcpxml_titles_project.json', import.meta.url), 'utf8'));
const plain = (value) => JSON.parse(JSON.stringify(value));
const frameRows = ({ ir }) => ir.titles.map(({ startFrame, endFrame, lane, text }) => [startFrame, endFrame, lane, text]);

test('12-second bilingual project plans original and compressed titles without media', () => {
  const project = sample();
  const before = plain(project);
  const original = buildFcpxmlTitlePlan(project, { fps: 30 });
  assert.equal(original.ir.durationFrames, 360);
  assert.deepEqual(plain(frameRows(original)), [
    [30, 62, 1, '你好 & <世界>\nHello, world!'],
    [33, 66, 3, 'Welcome'],
    [39, 69, 4, '地点 / Location'],
    [61, 65, 2, '再见'], // Adjacent milliseconds overlap after frame quantization.
    [87, 88, 1, '一'],
    [117, 153, 1, '跨过剪口'],
    [123, 144, 2, '这句在剪口内'],
    [359, 360, 1, '结束'],
  ]);
  assert.deepEqual(plain(original.warnings), [{ code: 'clamped_cue_to_duration', track: 'main', index: 7 }]);
  assert.equal(Object.isFrozen(original.ir.titles[0]), true);
  const compressed = buildFcpxmlTitlePlan(project, { timelineMode: 'gap_removed' });
  assert.equal(compressed.outputDurationMs, 11000);
  assert.equal(compressed.ir.durationFrames, 330);
  assert.deepEqual(plain(frameRows(compressed).slice(-2)), [[117, 123, 1, '跨过剪口'], [329, 330, 1, '结束']]);
  assert.ok(!compressed.ir.titles.some(({ text }) => text === '这句在剪口内'));
  assert.ok(compressed.warnings.some(({ code }) => code === 'fully_removed_cue'));
  assert.deepEqual(project, before);
});

test('selected active translation and overlay can export separately; disabled tracks do not leak', () => {
  const project = sample();
  const plan = buildFcpxmlTitlePlan(project, { tracks: ['extension'], extensionTrackId: 'alt', fps: 25 });
  assert.deepEqual(plain(frameRows(plan)), [[25, 55, 1, 'Alternate translation']]);
  project.multi_subtitle.enabled = false;
  assert.throws(() => buildFcpxmlTitlePlan(project, { tracks: ['extension'] }), /no exportable/);
  assert.deepEqual(plain(frameRows(buildFcpxmlTitlePlan(project, { tracks: ['overlay'] }))), [[39, 69, 1, '地点 / Location']]);
  project.overlay_track.enabled = false;
  assert.throws(() => buildFcpxmlTitlePlan(project, { tracks: ['overlay'] }), /no exportable/);
});

test('unknown duration uses all effective title and gap endpoints; fractional FPS stays on frame grid at four hours', () => {
  const project = {
    segments: [{ start: 14_400_000, end: 14_400_001, text: 'late' }],
    gaps: [{ start: 14_400_100, end: 14_400_200 }],
  };
  const plan = buildFcpxmlTitlePlan(project, { fps: '30000/1001' });
  assert.equal(plan.sourceDurationMs, 14_400_200);
  assert.equal(plan.ir.durationFrames, 431_575);
  assert.deepEqual(plain(frameRows(plan)), [[431_568, 431_569, 1, 'late']]);
  assert.ok(plan.warnings.some(({ code }) => code === 'inferred_source_duration'));
  const collapsed = { segments: [{ start: 2, end: 3, text: 'gone' }], gaps: [{ start: 1, end: 10 }], duration_ms: 11 };
  assert.throws(() => buildFcpxmlTitlePlan(collapsed, { timelineMode: 'gap_removed' }), /no exportable/);
  assert.throws(() => buildFcpxmlTitlePlan(project, { fps: '24000/1001' }), /unsupported FCPXML FPS/);
});

test('AI-scoped edits and restoration affect effective source text and compressed timing', () => {
  const project = {
    segments: [{ id: 'opening', start: 0, end: 3000, text: '嗯正文', items: [
      { start: 0, end: 500, text: '嗯' }, { start: 600, end: 3000, text: '正文' },
    ] }],
    gap_remove: { provenance: { sources: { ai_cleanup: [
      { start: 0, end: 500, cleanup_scope: { segment_id: 'opening', item_start: 0, item_end: 1, text: '嗯' } },
    ] } } },
  };
  assert.deepEqual(plain(frameRows(buildFcpxmlTitlePlan(project))), [[18, 90, 1, '正文']]);
  assert.deepEqual(plain(frameRows(buildFcpxmlTitlePlan(project, { timelineMode: 'gap_removed' }))), [[3, 75, 1, '正文']]);
  project.gap_remove.provenance.manual_overrides = [{ start: 0, end: 500, removed: false }];
  assert.deepEqual(plain(frameRows(buildFcpxmlTitlePlan(project, { timelineMode: 'gap_removed' }))), [[0, 90, 1, '嗯正文']]);
});

test('titles-only honors known media duration without a path and ignores restored gaps for fallback', () => {
  const project = {
    segments: [{ start: 0, end: 1000, text: 'title' }],
    gaps: [{ start: 5000, end: 6000, removed: false }],
  };
  const known = buildFcpxmlTitlePlan({ ...project, media: { durationMs: 2000 } });
  assert.equal(known.ir.durationFrames, 60);
  assert.equal(known.warnings.length, 0);
  assert.equal(buildFcpxmlTitlePlan(project).ir.durationFrames, 30);
  const invalidName = {};
  assert.throws(() => buildFcpxmlTitlePlan(project, { baseName: invalidName }), /invalid FCPXML project name/);
  assert.equal(Object.isFrozen(invalidName), false);
});

test('compressed clock maps leading, overlapping, restored and trailing gaps', () => {
  const project = {
    duration_ms: 12000,
    segments: [
      { start: 500, end: 2000, text: 'first' },
      { start: 2999, end: 5500, text: 'middle' },
      { start: 7000, end: 9000, text: 'last' },
      { start: 8500, end: 11000, text: 'removed' },
    ],
    gaps: [
      { start: 3900, end: 5000 }, { start: 0, end: 1000 }, { start: 3000, end: 4000 },
      { start: 6000, end: 7000, removed: false }, { start: 8000, end: 13000 },
    ],
  };
  const result = buildFcpxmlTitlePlan(project, { timelineMode: 'gap_removed', fps: 25 });
  assert.equal(result.ir.durationFrames, 125);
  assert.deepEqual(plain(frameRows(result)), [[0, 25, 1, 'first'], [49, 63, 1, 'middle'], [100, 125, 1, 'last']]);
});

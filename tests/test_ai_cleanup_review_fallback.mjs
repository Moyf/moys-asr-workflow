import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { runtimeProject } from './helpers/runtime-project.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(markerShape) {
  const context = { window: {}, document: { querySelectorAll: () => [], getElementById: () => null } };
  loadEditorModule(context, 'shared/editor-utils.js');
  const core = context.window.AsrGapRemoveCore;
  const rows = [['我', 0, 110], ['我这个', 130, 400], ['，', 410, 430], ['功能', 500, 800],
    ['嗯', 810, 930], ['很好', 1000, 1200], ['呢', 1300, 2000]];
  const segment = (id, offset) => ({ id, start: offset, end: offset + 2000,
    text: rows.map(([text]) => text).join(''),
    items: rows.map(([text, start, end]) => ({ text, start: start + offset, end: end + offset })) });
  const ranges = (id, offset) => [
    { start: offset, end: offset + 110, cleanup_scope: { segment_id: id, item_start: 0, item_end: 1, text: '我' } },
    { start: offset + 810, end: offset + 930, cleanup_scope: { segment_id: id, item_start: 4, item_end: 5, text: '嗯' } },
  ];
  const markers = [
    { id: 'ordinary', start: 810, end: 930, name: '用户标记', note: '用户备注', color: '#ffffff' },
    { id: 'ai-first', start: 0, end: 110, name: 'AI', note: '[AI] 删除：口吃', color: '#8e4ec6' },
    { id: 'ai-second', start: 1810, end: 1930, name: 'AI', note: '[AI] 删除：填充词', color: '#8e4ec6' },
  ];
  const project = runtimeProject([{ id: 'lead', start: 0, end: 2000, text: '前文', items: [{ text: '前文', start: 0, end: 2000 }] },
      segment('first', 0), segment('second', 1000)], {
    markers: markerShape === 'array' ? markers : { schema: 'moy.asr.markers.v1', items: markers },
    gap_remove: { provenance: { sources: {
      ai_cleanup: [...ranges('first', 0), ...ranges('second', 1000)],
      audio_gate: [{ start: 810, end: 930 }],
      script_alignment: [{ start: 3000, end: 3050 }],
    }, manual_overrides: [{ id: 'manual-late', start: 1500, end: 1600, removed: true }] } },
  });
  context.MaweBoot = { DATA: project };
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/io/editor-json-repair.js', import.meta.url), 'utf8'), context);
  return { context, core, project };
}

for (const shape of ['array', 'project-field']) {
  test(`two consecutive unsafe timing repairs revoke both cues once and retain unrelated state (${shape})`, () => {
    const { context, core, project } = fixture(shape);
    const ranges = project.gap_remove.provenance.sources.ai_cleanup;
    for (const range of ranges) {
      const cue = context.window.AsrEditorUtils.getMainTrack(project).segments.find((segment) => segment.id === range.cleanup_scope.segment_id);
      assert.ok(core.getCleanupScopeItems(cue, range).length, 'every incoming local scope is individually exact');
    }
    // Both cues overlap the preceding cue; the real normalizer must repair
    // their timings, which cannot preserve the already authorized endpoints.
    assert.ok(context.window.MaweJsonRepair.normalizeProjectTimings(project) > 0);
    const normalized = core.normalizeGapRemoveData(project.gap_remove);
    assert.equal(normalized.provenance.sources.ai_cleanup.length, 0);
    assert.deepEqual(plain(normalized.provenance.sources.audio_gate).map(({ start, end }) => [start, end]), [[810, 930]]);
    assert.deepEqual(plain(normalized.provenance.sources.script_alignment).map(({ start, end }) => [start, end]), [[3000, 3050]]);
    assert.equal(normalized.provenance.manual_overrides.find((item) => item.id === 'manual-late').removed, true);
    assert.ok(normalized.gaps.some((gap) => gap.start <= 810 && gap.end >= 930 && gap.removed));
    assert.ok(normalized.gaps.some((gap) => gap.start <= 1500 && gap.end >= 1600 && gap.removed));
    const markers = Array.isArray(project.markers) ? project.markers : project.markers.items;
    assert.equal(Array.isArray(project.markers), shape === 'array');
    const pending = markers.filter((marker) => marker.review?.status === 'pending');
    assert.equal(pending.length, 4);
    assert.deepEqual(plain(pending).map(({ start, end }) => [start, end]).sort((a, b) => a[0] - b[0]),
      [[0, 110], [810, 930], [1000, 1110], [1810, 1930]]);
    assert.equal(markers.find((marker) => marker.id === 'ordinary').note, '用户备注');
    assert.equal(markers.find((marker) => marker.id === 'ordinary').review, undefined);
    assert.equal(markers.find((marker) => marker.id === 'ai-first').review.status, 'pending');
    assert.equal(markers.find((marker) => marker.id === 'ai-second').review.status, 'pending');
    for (const cue of core.projectCleanupRetainedSegments(context.window.AsrEditorUtils.getMainTrack(project).segments, project.gap_remove).slice(1)) {
      assert.equal(cue.text, '我我这个，功能嗯很好呢');
      assert.equal(cue.disabled, undefined);
    }
    const reopened = plain(project);
    context.window.MaweJsonRepair.normalizeProjectTimings(reopened);
    const reopenedMarkers = Array.isArray(reopened.markers) ? reopened.markers : reopened.markers.items;
    assert.deepEqual(plain(reopenedMarkers), plain(markers), 'reopening does not duplicate reviews or reauthorize a scope');
    assert.equal(reopened.gap_remove.provenance.sources.ai_cleanup.length, 0);
    assert.equal(Array.isArray(reopened.markers), shape === 'array');
  });
}

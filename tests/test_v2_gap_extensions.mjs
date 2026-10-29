import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectHarness } from './helpers/track-golden.mjs';

const vendor = { zero: 0, flag: false, empty: [], nested: { object: {}, list: [false, 0] } };
const plain = value => JSON.parse(JSON.stringify(value));
function project() {
  return {
    schema: 'moy.asr.project.v2',
    tracks: [{ id: 'main', role: 'main', name: 'Main', enabled: true,
      segments: [{ id: 'cue', start: 100, end: 300, text: 'Hi', items: [{ text: 'Hi', start: 100, end: 300 }] }] }],
    bilingual: { display_mode: 'both' }, bindings: [],
    subtitle_groups: { next_id: 1, color: [], sticker: [] },
    gap_remove: {
      schema: 'moy.asr.gap_remove.v1', detector: 'audio_gate', vendor,
      gaps: [{ start: 100, end: 300, removed: true, vendor }],
      provenance: { schema: 'moy.asr.gap_provenance.v1', vendor,
        sources: { vendor, script_alignment: [], audio_gate: [], ai_cleanup_review: [],
          ai_cleanup: [{ id: 'ai', source: 'ai_cleanup', start: 100, end: 300, removed: true, vendor,
            cleanup_scope: { segment_id: 'cue', item_start: 0, item_end: 1, text: 'Hi', vendor } }] },
        manual_overrides: [], legacy: [] },
    },
  };
}
function normalizeAndSave(source) {
  const { data, h, context, save } = createProjectHarness(source);
  context.MaweGapRemoveData = { normalizedGapRemoveData: h.normalizeGapRemoveData };
  return { data, saved: save() };
}

test('v2 gap extension fields survive editor save and reopen without changing source', () => {
  const source = project();
  const before = structuredClone(source);
  const { saved } = normalizeAndSave(source);
  assert.deepEqual(source, before);
  const gap = saved.gap_remove;
  assert.deepEqual(gap.vendor, vendor);
  assert.deepEqual(gap.gaps[0].vendor, vendor);
  assert.deepEqual(gap.provenance.vendor, vendor);
  assert.deepEqual(gap.provenance.sources.vendor, vendor);
  assert.deepEqual(gap.provenance.sources.ai_cleanup[0].vendor, vendor);
  assert.deepEqual(gap.provenance.sources.ai_cleanup[0].cleanup_scope.vendor, vendor);
  assert.deepEqual(normalizeAndSave(saved).saved.gap_remove, gap);
});

test('managed values still normalize and invalid cleanup scopes do not reappear', () => {
  const source = project();
  source.gap_remove.detector = 'invalid';
  source.gap_remove.minimum_ms = 1;
  source.gap_remove.operation_mode = 'invalid';
  source.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope = { segment_id: 'cue', item_start: 0, item_end: 0, text: 'Hi', vendor };
  const { saved } = normalizeAndSave(source);
  assert.equal(saved.gap_remove.detector, 'audio_gate');
  assert.equal(saved.gap_remove.minimum_ms, 100);
  assert.equal(saved.gap_remove.operation_mode, 'boundary_drag');
  assert.equal(saved.gap_remove.provenance.sources.ai_cleanup[0].cleanup_scope, undefined);
  assert.deepEqual(saved.gap_remove.provenance.sources.ai_cleanup[0].vendor, vendor);
  assert.equal(saved.gap_remove.gaps[0].removed, true);
});

test('unwrapped legacy gap extensions survive normalization', () => {
  const source = project();
  source.gap_remove = { vendor, gaps: [{ start: 100, end: 300, removed: true, vendor }] };
  const saved = normalizeAndSave(source).saved.gap_remove;
  assert.deepEqual(saved.vendor, vendor);
  assert.deepEqual(saved.gaps[0].vendor, vendor);
  assert.equal(saved.provenance.sources.audio_gate[0].removed, true);
});

test('adjacent gap metadata survives a coalesced provenance projection', () => {
  const source = project();
  source.gap_remove.gaps = [
    { start: 100, end: 200, removed: true, vendor: { part: 'first' } },
    { start: 200, end: 300, removed: true, vendor: { part: 'second' } },
  ];
  const saved = normalizeAndSave(source).saved.gap_remove;
  assert.deepEqual(saved.gaps.map(({ start, end, vendor: extra }) => ({ start, end, vendor: extra })), [
    { start: 100, end: 200, vendor: { part: 'first' } },
    { start: 200, end: 300, vendor: { part: 'second' } },
  ]);
  assert.deepEqual(normalizeAndSave({ ...source, gap_remove: saved }).saved.gap_remove, saved);
});

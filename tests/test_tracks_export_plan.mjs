import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const utils = context.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));

function project() {
  const result = utils.makeProject([
    { id: 'hidden-main', start: 0, end: 4900, text: 'hidden', disabled: true, sticker_group_id: 'sticker-1' },
    { id: 'main-1', start: 5000, end: 6000, text: 'source', color_group_id: 'color-1', sticker_group_id: 'sticker-1' },
  ], { projectFields: { media: '/sample.wav', duration_ms: 8000, gaps: [{ start: 1000, end: 2000, removed: true }],
    subtitle_groups: { next_id: 2, color: [{ id: 'color-1', value: { name: 'yellow' } }],
      sticker: [{ id: 'sticker-1', value: { name: 'cat', path: 'cat.png', width: 720, height: 480 } }] } } });
  result.tracks.push(
    { id: 'inactive', role: 'extension', name: 'inactive', enabled: true,
      segments: [{ id: 'inactive-1', start: 0, end: 8000, text: 'unused', sticker_group_id: 'sticker-1' }] },
    { id: 'active', role: 'extension', name: 'active', enabled: true,
      segments: [{ id: 'active-1', start: 6000, end: 6500, text: 'translation', color_group_id: 'color-1', sticker_group_id: 'sticker-1' }] },
    { id: 'overlay', role: 'overlay', name: 'overlay', enabled: true, segments: [
      { id: 'hidden-overlay', start: 0, end: 4000, text: 'hidden overlay', disabled: true, sticker_group_id: 'sticker-1' },
      { id: 'overlay-1', start: 6500, end: 6700, text: 'overlap', sticker_group_id: 'sticker-1' },
    ] },
  );
  result.bilingual = { display_mode: 'both', active_track_id: 'active' };
  return result;
}

test('canonical export selects the active language and emits a cross-track sticker group once', () => {
  const input = project(); const before = plain(input);
  const plan = utils.buildProjectExportPlan(input, { timelineMode: 'source' });
  assert.deepEqual(Array.from(plan.cues.main, cue => cue.text), ['source']);
  assert.deepEqual(Array.from(plan.cues.extension, cue => cue.text), ['translation']);
  assert.deepEqual(Array.from(plan.cues.overlay, cue => cue.text), ['overlap']);
  assert.equal(plan.stickers.length, 1);
  assert.equal(plan.overlayStickers.length, 0);
  assert.deepEqual([plan.stickers[0].sourceStartMs, plan.stickers[0].sourceEndMs], [5000, 6700]);
  assert.equal(plan.cues.main[0].startMs, 5000);
  assert.deepEqual(plain(input), before);
});

test('canonical export maps gaps without changing source tracks or including disabled language members', () => {
  const input = project(); input.tracks.find(track => track.id === 'active').enabled = false;
  const before = plain(input);
  const plan = utils.buildProjectExportPlan(input, { timelineMode: 'gap_removed' });
  assert.equal(plan.cues.extension.length, 0);
  assert.equal(plan.cues.main[0].startMs, 4000);
  assert.deepEqual([plan.stickers[0].startMs, plan.stickers[0].endMs], [4000, 5700]);
  assert.equal(input.tracks[0].segments[1].start, 5000);
  assert.deepEqual(plain(input), before);
});

test('explicit future and mixed-schema export documents are rejected without mutation', () => {
  for (const input of [Object.assign(project(), { schema: 'moy.asr.project.v99' }),
    Object.assign(project(), { segments: [] })]) {
    const before = plain(input);
    assert.throws(() => utils.buildProjectExportPlan(input, { timelineMode: 'source' }));
    assert.deepEqual(plain(input), before);
  }
});

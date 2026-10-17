import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const utils = context.window.AsrEditorUtils;

test('active secondary track survives normalization with legacy and stale fallback', () => {
  const tracks = ['old', 'new'].map(id => ({ id, segments: [] }));
  for (const [selected, expected] of [['new', 'new'], ['missing', 'old']]) {
    const normalized = utils.normalizeMultiSubtitle({ tracks, active_track_id: selected });
    assert.equal(normalized.active_track_id, expected);
    assert.deepEqual(Array.from(normalized.tracks, track => track.id), ['old', 'new']);
  }
  assert.equal(utils.normalizeMultiSubtitle({ active_track_id: 'deleted' }).active_track_id, '');
});

test('editor resolves active tracks and never exposes bindings from an inactive track', () => {
  const data = { segments: [{ id: 'source', start: 0, end: 1000, text: 'Source' }],
    multi_subtitle: { enabled: true, active_track_id: 'new', tracks: ['old', 'new'].map(id => ({ id,
      segments: [{ id: `${id}-cue`, start: 0, end: 1000, text: id }] })),
    bindings: [{ id: 'old-binding', track_id: 'old', main_segment_ids: ['source'], extension_segment_ids: ['old-cue'] }] } };
  const sandbox = { window: { AsrEditorUtils: utils }, MaweBoot: { DATA: data } };
  vm.runInNewContext(readFileSync(new URL('../web/editor/state/editor-multi-subtitle-core.js', import.meta.url), 'utf8'), sandbox);
  const core = sandbox.window.MaweMultiSubtitleCore;
  assert.equal(core.getActiveExtensionTrack().id, 'new');
  assert.equal(core.bindingForMainIndex(0), null);
  assert.equal(core.syncBoundExtensionForMain(data.segments[0]), false);
  const newKey = core.multiSubtitleWaveformStructureKey();
  data.multi_subtitle.active_track_id = 'old';
  assert.equal(core.getActiveExtensionTrack().id, 'old');
  assert.equal(core.bindingForMainIndex(0).id, 'old-binding');
  assert.notEqual(core.multiSubtitleWaveformStructureKey(), newKey);
  delete data.multi_subtitle.active_track_id;
  assert.equal(core.getActiveExtensionTrack().id, 'old');
});

test('track swaps retain speaker and disabled metadata and keep discarded cues out of SRT', () => {
  const makeSegments = (prefix) => [
    { id: `${prefix}-discarded`, start: 0, end: 1000, text: `${prefix} discarded`, speaker: `${prefix}-speaker`, disabled: true },
    { id: `${prefix}-enabled`, start: 1200, end: 2200, text: `${prefix} enabled`, speaker: `${prefix}-other`, disabled: false },
    { id: `${prefix}-legacy`, start: 2400, end: 3400, text: `${prefix} legacy` },
  ];
  const project = {
    segments: makeSegments('main'),
    multi_subtitle: { enabled: true, tracks: [{ id: 'translation', segments: makeSegments('ext') }] },
  };
  const originalMetadata = new Map([...project.segments, ...project.multi_subtitle.tracks[0].segments]
    .map(({ id, speaker, disabled }) => [id, { speaker, disabled }]));
  for (let round = 0; round < 2; round++) {
    assert.equal(utils.swapMainAndExtensionSubtitle(project).swapped, true);
    for (const segments of [project.segments, project.multi_subtitle.tracks[0].segments]) {
      for (const { id, speaker, disabled } of segments) {
        assert.deepEqual({ speaker, disabled }, originalMetadata.get(id));
      }
      assert.doesNotMatch(utils.buildSrtPayload(segments), /discarded/);
      assert.match(utils.buildSrtPayload(segments), /enabled/);
    }
  }
});

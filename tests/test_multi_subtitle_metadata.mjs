import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const utils = context.window.AsrEditorUtils;

test('two swaps preserve all cue properties without mapping or nested aliases', () => {
  const cue = (id, name) => ({ id, start: 1000, end: 3000, text: 'one',
    start_frame: 30, end_frame: 90,
    items: [{ text: 'one', start: 1000, end: 3000, start_frame: 30, end_frame: 90, vendor: { score: 1 } }],
    color: { name, value: '#123456', start: 1000, end: 3000 },
    sticker: { name: id, filename: `${id}.png`, start: 1000, end: 3000 },
    assOverride: { pos: { x: 123, y: 456 } }, speaker: id, disabled: false,
    vendor: { nested: ['keep'] },
  });
  const original = [cue('a', 'blue'), cue('b', 'yellow')];
  const project = utils.importProject({ segments: [original[0]], multi_subtitle: {
    enabled: true, tracks: [{ id: 'ext', segments: [original[1]] }],
    bindings: [{ track_id: 'ext', main_segment_ids: ['a'], extension_segment_ids: ['b'] }],
  } }).project;
  const before = JSON.parse(JSON.stringify(project));
  for (let round = 0; round < 2; round++) {
    assert.equal(utils.swapMainAndExtensionSubtitle(project).mappedColorCount, 0);
    const cues = [...utils.getMainTrack(project).segments, ...utils.getExtensionTrack(project).segments];
    for (const segment of cues) {
      const source = before.tracks.flatMap(track => track.segments).find(s => s.id === segment.id);
      assert.deepEqual(JSON.parse(JSON.stringify(segment)), source);
      const input = original.find(s => s.id === segment.id);
      assert.notEqual(segment.vendor, input.vendor);
      assert.notEqual(segment.items[0].vendor, input.items[0].vendor);
      assert.notEqual(segment.assOverride.pos, input.assOverride.pos);
    }
  }
});

test('track normalization deep clones third party and nested item fields', () => {
  const segment = { id: 'a', start: 0, end: 1000, text: 'a',
    vendor: { values: [1] }, items: [{ text: 'a', start: 0, end: 1000, vendor: { v: 1 } }] };
  const overlay = utils.importProject({ segments: [], overlay_track: { segments: [segment] } }).project;
  const secondary = utils.importProject({ segments: [], multi_subtitle: { tracks: [{ segments: [segment] }] } }).project;
  for (const copy of [utils.getOverlayTrack(overlay).segments[0], utils.getExtensionTrack(secondary).segments[0]]) {
    copy.vendor.values.push(2);
    copy.items[0].vendor.v = 2;
    assert.deepEqual(segment.vendor.values, [1]);
    assert.equal(segment.items[0].vendor.v, 1);
  }
});

test('track swaps retain speaker and disabled metadata and keep discarded cues out of SRT', () => {
  const makeSegments = (prefix) => [
    { id: `${prefix}-discarded`, start: 0, end: 1000, text: `${prefix} discarded`, speaker: `${prefix}-speaker`, disabled: true },
    { id: `${prefix}-enabled`, start: 1200, end: 2200, text: `${prefix} enabled`, speaker: `${prefix}-other`, disabled: false },
    { id: `${prefix}-legacy`, start: 2400, end: 3400, text: `${prefix} legacy` },
  ];
  const project = utils.importProject({
    segments: makeSegments('main'),
    multi_subtitle: { enabled: true, tracks: [{ id: 'translation', segments: makeSegments('ext') }] },
  }).project;
  const originalMetadata = new Map([...utils.iterSegments(project)]
    .map(({ id, speaker, disabled }) => [id, { speaker, disabled }]));
  for (let round = 0; round < 2; round++) {
    assert.equal(utils.swapMainAndExtensionSubtitle(project).swapped, true);
    for (const { segments } of project.tracks) {
      for (const { id, speaker, disabled } of segments) {
        assert.deepEqual({ speaker, disabled }, originalMetadata.get(id));
      }
      assert.doesNotMatch(utils.buildSrtPayload(segments), /discarded/);
      assert.match(utils.buildSrtPayload(segments), /enabled/);
    }
  }
});

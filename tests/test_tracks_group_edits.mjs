import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { plainModuleSource } from './helpers/init-module-source.mjs';

const fixtureUtils = { window: {}, TextDecoder };
loadEditorModule(fixtureUtils, 'shared/editor-utils.js');
const utils = fixtureUtils.window.AsrEditorUtils;
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(count = 5) {
  const data = utils.makeProject(Array.from({ length: count }, (_, index) => ({
    id: `cue-${index}`, start: index * 1000, end: (index + 1) * 1000, text: String(index),
  })));
  const main = utils.getMainTrack(data);
  const overlay = utils.ensureOverlayTrack(data, { enabled: true,
    segments: [{ id: 'overlay-cue', start: 10000, end: 11000, text: 'Overlay' }] });
  const context = { AsrEditorUtils: utils, MaweBoot: { DATA: data } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../web/editor/cues/editor-segment-ops.js', import.meta.url), 'utf8'), context);
  return { data, main, overlay, context, api: context.MaweSegmentOps };
}
function grouped(f, kind) {
  const id = utils.assignSubtitleGroup(f.data, f.main.segments, f.main.segments.map((_, index) => index), kind,
    { name: kind === 'color' ? 'red' : 'reaction', vendor: { empty: [], flag: false } });
  const group = f.data.subtitle_groups[kind].find(group => group.id === id);
  group.vendor = { extension: 0 };
  f.overlay.segments[0][`${kind}_group_id`] = id;
  f.main.segments[2][`${kind}_group_metadata`] = { member: false };
  return id;
}

for (const kind of ['color', 'sticker']) {
  test(`explicit ${kind} clearing preserves retained members, other tracks, attributes and undo`, () => {
    const f = fixture(), id = grouped(f, kind), before = plain(f.data);
    const history = utils.buildSegmentsHistorySnapshot(f.data);
    f.api.splitGroupsAtCutPoints(new Set([1, 3]), kind, `${kind}_ref`);
    const memberships = [0, 2, 4].map(index => f.main.segments[index][`${kind}_group_id`]);
    assert.deepEqual(memberships, [id, id, id]);
    assert.equal(f.main.segments[1][`${kind}_group_id`], undefined);
    assert.equal(f.main.segments[3][`${kind}_group_id`], undefined);
    assert.equal(f.overlay.segments[0][`${kind}_group_id`], id);
    assert.deepEqual(f.main.segments[2][`${kind}_group_metadata`], { member: false });
    for (const memberId of memberships) {
      const group = f.data.subtitle_groups[kind].find(group => group.id === memberId);
      assert.deepEqual(plain(group.value), before.subtitle_groups[kind][0].value);
      assert.deepEqual(plain(group.vendor), { extension: 0 });
    }
    assert.deepEqual(plain(utils.subtitleGroupRanges(f.data, kind, { trackIds: [f.main.id] })
      .map(range => [range.start, range.end])), [[0, 5000]]);
    assert.deepEqual(plain(utils.validateTracksProject(f.data).errors), []);
    utils.restoreSegmentsHistorySnapshot(f.data, history);
    assert.deepEqual(plain(f.data), before);
  });
}

test('deleting a middle cue uses stable groups and restores the complete project through history', () => {
  const f = fixture(3), id = grouped(f, 'color'), before = plain(f.data);
  let history;
  Object.assign(f.context, {
    MaweCuePanel: { commitCuePanelEdit() {} }, MaweCuePanelState: { resetCuePanelEditState() {} },
    MaweMultiSubtitleCore: { getMultiSubtitleState: () => f.data, multiSubtitleVisible: () => false,
      removeBindingsForSegmentIds() {}, markMultiSubtitleDirty() {} },
    MaweCommands: { run(_label, mutate) { history = utils.buildSegmentsHistorySnapshot(f.data); return mutate({ commit() {} }); } },
    MaweSelection: { clearSelection() {} }, MawePlaybackLoop: {}, MaweHint: { flashHint() {} },
  });
  f.api.deleteSegments([1]);
  assert.deepEqual(plain(f.main.segments.map(cue => cue.id)), ['cue-0', 'cue-2']);
  assert.equal(f.main.segments[0].color_group_id, id);
  assert.equal(f.main.segments[1].color_group_id, id);
  assert.deepEqual(plain(f.overlay), before.tracks.find(track => track.role === 'overlay'));
  assert.deepEqual(plain(utils.validateTracksProject(f.data).errors), []);
  for (const cue of utils.iterSegments(f.data)) for (const key of ['color', 'color_ref', 'sticker', 'sticker_ref']) {
    assert.equal(Object.hasOwn(cue, key), false);
  }
  utils.restoreSegmentsHistorySnapshot(f.data, history);
  assert.deepEqual(plain(f.data), before);
});

test('preparing a main-to-overlay move removes only the moved cue bindings and keeps groups intact', () => {
  const f = fixture(3); grouped(f, 'color');
  const before = plain(f.data), calls = [];
  f.context.MaweMultiSubtitleCore = {
    removeBindingsForSegmentIds: (...args) => calls.push(plain(args)),
    markMultiSubtitleDirty() {}, normalizeMultiSubtitleState() {},
  };
  vm.runInContext(plainModuleSource('editor/cues/overlay-track.js'), f.context);
  f.context.shiftMainGroupRefsAfterMove([1]);
  assert.deepEqual(calls, [[['cue-1'], []]]);
  assert.deepEqual(plain(f.data), before);
});

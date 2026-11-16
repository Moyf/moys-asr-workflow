import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture() {
  const segments = [
    { start: 5100, end: 10100, text: 'First' },
    { start: 10100, end: 18000, text: 'Second' },
    { start: 25000, end: 30000, text: 'Third' },
  ];
  const posted = [];
  const noop = () => {};
  const context = vm.createContext({
    document: { activeElement: null, addEventListener: noop, getElementById: () => null },
    MaweBoot: { DATA: { segments }, SERVER_CONFIG: { saveUrl: '/api/project' } },
    MaweCoreState: { waveformEditor: { durationMs: 30000, drag: null }, container: { querySelectorAll: () => [] } },
    MaweDom: { cuePanelText: { value: 'Second' }, cuePanelStart: { value: '10.100' }, cuePanelDuration: { value: '7.900' } },
    MaweCuePanelState: { currentCuePanelIdx: 1, currentCuePanelKind: 'main', resetCuePanelEditState: noop },
    projectTimebase: () => ({ unit: 'milliseconds' }),
    timelineMinimumDurationMs: () => 100,
    timelineTimingAdapter: () => ({ fromMs: Number, getStart: s => s.start, getEnd: s => s.end }),
    syncTextChange: noop,
    MaweMultiSubtitleCore: { syncBoundExtensionForMain: noop, syncBindingOffsets: noop, markMultiSubtitleDirty: noop },
    MaweCommands: { begin: () => ({ commit: noop }) },
    MaweViewUpdates: { invalidate: noop },
    MaweState: { markProjectDirty: noop, segmentsFingerprint: () => JSON.stringify(segments), noteSavedSegments: noop, markSaved: noop },
    MaweInlineEdit: {}, MaweHistory: {}, MaweAppearance: {},
    MaweSettings: { EDITOR_SETTINGS: { projectBackupEnabled: false } },
    MaweProjectLoad: { projectBindingEpoch: 0 },
    MaweServerSave: { serverProjectSavingEnabled: () => true, showProjectSaveError: error => { throw error; } },
    MaweJsonRepair: { buildJson: () => JSON.stringify({ segments }) },
    MaweHost: { server: { fetch: async (_url, request) => {
      posted.push(JSON.parse(request.body).project);
      return { ok: true, json: async () => ({ ok: true, filename: 'test.mosp' }) };
    } } },
    MaweHint: { flashHint: noop },
  });
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-cue-panel.js', 'initMaweCuePanel'), context);
  vm.runInContext(invokedInitModuleSource('editor/io/editor-project-save.js', 'initMaweProjectSave'), context);
  return { context, segments, posted };
}

for (const silent of [true, false]) {
  test(`save (silent=${silent}) during held boundary edit does not replay stale panel timing`, async () => {
    const { context, segments, posted } = fixture();
    // A/D updates the model while the held gesture has not yet committed and
    // refreshed the current-cue panel. Its old duration must not become an edit.
    context.MaweCoreState.waveformEditor.drag = { kind: 'resize-boundary', started: true };
    segments[0].end = segments[1].start = 10200;
    assert.equal(await context.MaweProjectSave.saveProjectToServer({ silent }), true);
    assert.equal(segments[1].end, 18000);
    assert.deepEqual(posted[0].segments.map(({ start, end }) => ({ start, end })), [
      { start: 5100, end: 10200 }, { start: 10200, end: 18000 }, { start: 25000, end: 30000 },
    ]);
    // Once the gesture ends, ordinary panel edits must still be committed.
    context.MaweCoreState.waveformEditor.drag = null;
    context.MaweDom.cuePanelStart.value = '10.200';
    context.MaweDom.cuePanelDuration.value = '8.000';
    assert.equal(await context.MaweProjectSave.saveProjectToServer({ silent }), true);
    assert.equal(segments[1].end, 18200);
    assert.equal(posted[1].segments[1].end, 18200);
  });
}

test('saving after a cancelled boundary gesture preserves the restored range', async () => {
  const { context, segments, posted } = fixture();
  context.MaweCoreState.waveformEditor.drag = { kind: 'resize-boundary', started: true };
  segments[0].end = segments[1].start = 10200;
  await context.MaweProjectSave.saveProjectToServer({ silent: true });
  assert.equal(segments[1].end, 18000);
  // Model the cancel path: clear drag, restore the original snapshot and panel.
  context.MaweCoreState.waveformEditor.drag = null;
  segments[0].end = segments[1].start = 10100;
  context.MaweDom.cuePanelStart.value = '10.100';
  context.MaweDom.cuePanelDuration.value = '7.900';
  assert.equal(await context.MaweProjectSave.saveProjectToServer({ silent: true }), true);
  assert.equal(posted[1].segments[0].end, 10100);
  assert.equal(posted[1].segments[1].start, 10100);
  assert.equal(posted[1].segments[1].end, 18000);
});

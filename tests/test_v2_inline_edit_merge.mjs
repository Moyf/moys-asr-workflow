import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture() {
  const main = { role: 'main', segments: [{ id: 'main-1', text: 'original' }] };
  const secondary = { role: 'secondary', id: 'en', segments: [{ id: 'en-1', text: 'translation' }] };
  const project = { schema: 'moy.asr.project.v2', tracks: [main, secondary] };
  const calls = { html: [], counts: [], sync: [], commits: 0 };
  const textEl = { innerText: 'edited', removeAttribute() {} };
  const countEl = {};
  const el = { classList: { add() {}, remove() {} }, querySelector: () => countEl };
  const context = {
    MaweBoot: { DATA: project },
    AsrEditorUtils: { getMainTrack: data => data.tracks.find(track => track.role === 'main') },
    MaweState: { editing: { editingState: null, extensionEditingState: null } },
    MaweCommands: { run(_label, mutate) { calls.commits++; mutate(); } },
    MaweMultiSubtitleCore: {
      getMainSubtitleSplitMode: () => 'continuous', getExtensionSubtitleSplitMode: () => 'word',
      getExtensionTrack: id => project.tracks.find(track => track.id === id), markMultiSubtitleDirty() {},
    },
    MaweDom: { searchEl: { value: 'find' } },
    MaweCoreState: {}, MaweViewUpdates: { invalidate() {} },
    getCurrentCuePanelTarget: () => null,
    setTextHtml: (_element, text, search) => calls.html.push({ text, search }),
    applyCharCount: (_element, text, mode) => calls.counts.push({ text, mode }),
    syncTextChange: (segment, previous) => calls.sync.push({ segment, previous }),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-inline-edit.js', 'initMaweInlineEdit'), context);
  return { context, main, secondary, calls, textEl, el };
}

test('finishing a main inline edit updates the v2 main track and text facade', () => {
  const { context, main, secondary, calls, textEl, el } = fixture();
  context.MaweState.editing.editingState = { el, idx: 0, textEl, original: 'original' };
  context.MaweInlineEdit.finishEdit(true);
  assert.equal(main.segments[0].text, 'edited');
  assert.equal(secondary.segments[0].text, 'translation');
  assert.equal(calls.commits, 1);
  assert.equal(calls.sync[0].previous, 'original');
  assert.equal(calls.html[0].text, 'edited');
  assert.equal(calls.html[0].search, 'find');
  assert.equal(calls.counts[0].mode, 'continuous');
  assert.equal(context.MaweState.editing.editingState, null);
});

test('finishing a secondary inline edit keeps the main cue unchanged', () => {
  const { context, main, secondary, calls, textEl, el } = fixture();
  context.MaweState.editing.extensionEditingState = { el, index: 0, trackId: 'en', textEl, original: 'translation' };
  context.MaweInlineEdit.finishExtensionEdit(true);
  assert.equal(main.segments[0].text, 'original');
  assert.equal(secondary.segments[0].text, 'edited');
  assert.equal(calls.commits, 1);
  assert.equal(calls.html[0].text, 'edited');
  assert.equal(calls.counts[0].mode, 'word');
  assert.equal(context.MaweState.editing.extensionEditingState, null);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const source = fs.readFileSync(new URL('../web/editor/media/editor-waveform-init.js', import.meta.url), 'utf8');
const callbacks = new Map();
walk.simple(acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), {
  Property(node) {
    if (['onCueQuickEditSplit', 'onCueQuickEditText', 'onWordQuickEditText'].includes(node.key.name)) {
      callbacks.set(node.key.name, source.slice(node.value.start, node.value.end));
    }
  },
});

function fixture() {
  const main = { role: 'main', segments: [{ id: 'main', text: 'hello world', items: [{ text: 'hello' }] }] };
  const secondary = { id: 'en', role: 'secondary', segments: [{ id: 'en-cue', text: 'secondary' }] };
  const overlay = { role: 'overlay', segments: [{ id: 'overlay', text: 'overlay' }] };
  const calls = { sync: [], split: [], commands: [], hints: [] };
  const c = {
    MaweBoot: { DATA: { schema: 'moy.asr.project.v2', tracks: [main, secondary, overlay] } },
    AsrEditorUtils: { getMainTrack: data => data.tracks.find(track => track.role === 'main'),
      wordCharRanges: () => [{ start: 0, end: 5 }], isTimedTextNeutralToken: () => false },
    MaweCoreState: {}, MaweSelection: { clearSelection() {} },
    MaweSettings: { EDITOR_SETTINGS: { quickEditSplitFocusNext: false } },
    MaweSplitCore: { splitAtCursor(_point, options) { calls.split.push(options); return true; } },
    MaweMultiSubtitleCore: { getActiveExtensionTrack: () => secondary, syncBindingOffsets() {}, markMultiSubtitleDirty() {} },
    MaweWordTiming: { syncTextChange: (segment, previous) => calls.sync.push({ segment, previous }) },
    MaweCommands: { run(label, callback) { calls.commands.push(label); callback(); } },
    MaweHint: { flashHint: (...args) => calls.hints.push(args) },
    getOverlayTrack: () => overlay,
  };
  c.window = c;
  vm.createContext(c);
  const get = name => vm.runInContext(`(${callbacks.get(name)})`, c);
  return { main, secondary, overlay, calls, get };
}

test('main cue quick edit uses v2 main track without changing other tracks', () => {
  const { main, secondary, overlay, calls, get } = fixture();
  get('onCueQuickEditText')('main', 0, 'changed');
  assert.equal(main.segments[0].text, 'changed');
  assert.equal(secondary.segments[0].text, 'secondary');
  assert.equal(overlay.segments[0].text, 'overlay');
  assert.equal(calls.sync[0].previous, 'hello world');
  assert.equal(calls.commands.length, 1);
});

test('main cue quick split resolves a v2 main cue', () => {
  const { calls, get } = fixture();
  assert.equal(get('onCueQuickEditSplit')('main', 0, 3, {}), true);
  assert.equal(calls.split[0].explicit.idx, 0);
  assert.equal(calls.split[0].explicit.cursorOffset, 3);
});

test('word quick edit updates the canonical main cue', () => {
  const { main, calls, get } = fixture();
  get('onWordQuickEditText')(0, 0, 'hi');
  assert.equal(main.segments[0].text, 'hi world');
  assert.equal(calls.sync[0].previous, 'hello world');
  assert.equal(calls.commands.length, 1);
});

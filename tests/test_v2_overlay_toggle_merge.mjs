import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { exposeWindowGlobals } from './helpers/vm-window-globals.mjs';
import { plainModuleSource } from './helpers/init-module-source.mjs';

const source = plainModuleSource('editor/ui/editor-wiring-settings-init.js');
let callback;
walk.simple(acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), {
  CallExpression(node) {
    if (node.arguments[0]?.value === 'change'
        && source.slice(node.callee.start, node.callee.end).includes('overlayTrackToggle')) callback = node.arguments[1];
  },
});
assert.ok(callback, 'overlay change listener must exist');

test('overlay toggle creates or updates the canonical track inside an undoable command', () => {
  const project = { schema: 'moy.asr.project.v2', tracks: [{ id: 'main', role: 'main', enabled: true, segments: [] }] };
  const toggle = { checked: true }, history = [], commits = [];
  const context = {
    MaweBoot: { DATA: project }, getMaweDomPanels: () => ({ overlayTrackToggle: toggle }),
    getOverlayTrack: () => project.tracks.find(track => track.role === 'overlay'),
    AsrEditorUtils: { ensureOverlayTrack(data) {
      let track = data.tracks.find(item => item.role === 'overlay');
      if (!track) { track = { id: 'overlay', role: 'overlay', enabled: false, segments: [] }; data.tracks.push(track); }
      return track;
    } },
    MaweCommands: { run(_label, mutate) {
      history.push(structuredClone(project));
      mutate({ commit: options => commits.push(options) });
    } },
    MaweHint: { flashHint() {} },
  };
  context.window = context;
  vm.createContext(exposeWindowGlobals(context));
  const change = vm.runInContext(`(${source.slice(callback.start, callback.end)})`, context);
  change();
  const overlay = project.tracks.find(track => track.role === 'overlay');
  assert.equal(overlay.enabled, true);
  assert.equal(history[0].tracks.length, 1);
  assert.equal(commits[0].waveform, 'full');
  toggle.checked = false;
  change();
  assert.equal(overlay.enabled, false);
  assert.equal(project.tracks.includes(overlay), true);
  assert.equal(history[1].tracks[1].enabled, true);
});

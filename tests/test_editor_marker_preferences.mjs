import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

const utilsContext = { window: {}, TextDecoder, TextEncoder, Uint8Array };
loadEditorModule(utilsContext, 'shared/editor-utils.js');
const key = 'moy.asr.editor.settings.v1';

function fixture(storage = new Map([[key, JSON.stringify({ markerEditingEnabled: false })]])) {
  const elements = {};
  for (const id of ['markers-quick-toggle', 'project-marker-track-toggle']) {
    elements[id] = { listeners: {}, attributes: {}, checked: false,
      classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
    };
  }
  const context = { window: { AsrEditorUtils: utilsContext.window.AsrEditorUtils,
    AsrGapRemoveCore: utilsContext.window.AsrGapRemoveCore },
  MaweHost: { storage: { getItem: name => storage.get(name), setItem: (name, value) => storage.set(name, value) } },
  MaweState: { preferences: { editor: {} }, changes: {} },
  MaweCoreState: { waveformEditor: { refreshMarkerOverlay() {} } },
  MaweDom: { markersManageButton: { hidden: true } },
  document: { getElementById: id => elements[id], addEventListener() {} },
  };
  const evaluate = file => vm.runInNewContext(readFileSync(new URL('../web/' + file, import.meta.url), 'utf8'), context);
  vm.runInNewContext(invokedInitModuleSource('editor/state/editor-settings.js', 'initMaweSettings'), context);
  context.MaweSettings = context.window.MaweSettings;
  evaluate('editor/markers/editor-marker-editing.js');
  context.MaweMarkerEditing = context.window.MaweMarkerEditing;
  evaluate('editor/markers/editor-wiring-markers.js');
  return { storage, settings: context.MaweSettings, markers: context.MaweMarkerEditing, elements,
    saved: () => JSON.parse(storage.get(key)),
  };
}

test('automatic project markers survive unrelated saves without becoming a personal preference', () => {
  const f = fixture();
  f.markers.enableForProjectMarkers([{ id: 'review', start: 100 }]);
  assert.equal(f.markers.isEditingEnabled(), true);
  assert.equal(f.elements['markers-quick-toggle'].attributes['aria-pressed'], 'true');
  assert.equal(f.elements['project-marker-track-toggle'].checked, true);
  assert.equal(f.settings.EDITOR_SETTINGS.markerEditingEnabled, false);
  f.settings.updateEditorSettings({ toastPosition: 'bottom-right', wordTimingRowHeight: 192 });
  assert.equal(f.saved().markerEditingEnabled, false);
  const reloaded = fixture(f.storage);
  assert.equal(reloaded.markers.isEditingEnabled(), false);
  assert.equal(reloaded.settings.EDITOR_SETTINGS.toastPosition, 'bottom-right');
});

test('the toolbar toggles the effective state and reopening a marked project reenables only its session', () => {
  const f = fixture();
  const markers = [{ id: 'review', start: 100 }];
  f.markers.enableForProjectMarkers(markers);
  f.elements['markers-quick-toggle'].listeners.click();
  assert.equal(f.markers.isEditingEnabled(), false);
  assert.equal(f.saved().markerEditingEnabled, false);
  f.markers.enableForProjectMarkers(markers);
  assert.equal(f.markers.isEditingEnabled(), true);
  assert.equal(f.saved().markerEditingEnabled, false);
  f.markers.enableForProjectMarkers([]);
  assert.equal(f.markers.isEditingEnabled(), false);
  assert.equal(f.elements['project-marker-track-toggle'].checked, false);
});

test('an explicit enabled preference survives the automatic session and an empty project', () => {
  const f = fixture();
  f.markers.enableForProjectMarkers([{ id: 'review', start: 100 }]);
  f.elements['project-marker-track-toggle'].listeners.change({ target: { checked: true } });
  assert.equal(f.saved().markerEditingEnabled, true);
  f.markers.enableForProjectMarkers([]);
  assert.equal(f.markers.isEditingEnabled(), true);
  const reloaded = fixture(f.storage);
  assert.equal(reloaded.markers.isEditingEnabled(), true);
  reloaded.markers.setEditingEnabled(false);
  assert.equal(reloaded.saved().markerEditingEnabled, false);
});

test('loading unmarked or invalid marker data clears the automatic override without writing preferences', () => {
  for (const markers of [[], null, undefined, {}]) {
    const f = fixture();
    f.markers.enableForProjectMarkers([{ id: 'review', start: 100 }]);
    const saved = f.storage.get(key);
    f.markers.enableForProjectMarkers(markers);
    assert.equal(f.markers.isEditingEnabled(), false);
    assert.equal(f.storage.get(key), saved);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

test('ASS positioning init shows secondary and overlay controls without exposing the main controls', () => {
  const elements = new Map();
  const element = () => ({ hidden: false, value: '', disabled: false, attributes: {},
    addEventListener() {}, setAttribute(name, value) { this.attributes[name] = value; } });
  const document = { activeElement: null, addEventListener() {}, getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  } };
  let current = { kind: 'extension', segment: { id: 'e', assOverride: { pos: { x: 100, y: 200 }, scale: 1.25 } } };
  const context = {
    document, addEventListener() {}, MaweCuePanel: { getCurrentCuePanelTarget: () => current },
    MaweSettings: { EDITOR_SETTINGS: { assMode: true } },
    MaweAssCanvas: { lastRender: null }, MaweCommands: { onBeforeBegin() {} },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/styles/editor-wiring-ass-cue-position.js', 'initWiringAssCuePositionModule'), context);
  assert.equal(elements.get('ass-cue-position').hidden, false);
  assert.equal(elements.get('ass-cue-x').value, '100');
  assert.equal(elements.get('ass-cue-y').value, '200');
  assert.equal(elements.get('ass-cue-scale').value, '1.25');
  current = { kind: 'main', segment: { id: 'm' } };
  context.MaweAssCuePosition.sync();
  assert.equal(elements.get('ass-cue-position').hidden, true);
  current = { kind: 'overlay', segment: { id: 'o', assOverride: { pos: { x: 20, y: 30 } } } };
  context.MaweAssCuePosition.sync();
  assert.equal(elements.get('ass-cue-position').hidden, false);
  assert.equal(elements.get('ass-cue-x').value, '20');
});

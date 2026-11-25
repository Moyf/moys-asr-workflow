import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { exposeWindowGlobals } from './helpers/vm-window-globals.mjs';
import { publishFixtureBindings } from './helpers/editor-fixture-bindings.mjs';

test('secondary color follows both library editability and the active karaoke profile', () => {
  let editable = true;
  const library = {
    assignments: { assExportProfileId: 'ass' },
    assProfiles: [{ id: 'ass', animations: { karaoke: { enabled: false } } }],
  };
  const secondary = { type: 'color', dataset: { assStyleField: 'secondaryColor' } };
  const ordinary = { type: 'text', dataset: { assStyleField: 'fontName' } };
  const classes = new Set();
  const row = { classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } } };
  const form = {
    addEventListener() {},
    querySelectorAll(selector) { return selector === '[data-ass-style-field]' ? [secondary, ordinary] : []; },
  };
  const document = {
    getElementById(id) { return id === 'ass-style-secondary-color' ? secondary : id === 'ass-style-karaoke-row' ? row : null; },
    querySelectorAll() { return []; },
  };
  const window = {
    AsrEditorUtils: { normalizeAssStyle: style => style },
    MAWE_I18N: { translateText: text => text },
    MaweAssManagerWiring: {},
    MaweFloatingPanel: { createFloatingPanel: () => ({ isOpen: () => false }) },
  };
  const context = vm.createContext(exposeWindowGlobals({
    window, document,
    getMaweDomPanels: () => ({ assStyleForm: form, assInlineTextToggles: [] }),
    getAssStyleLibrary: () => library,
    canEditAssStyleLibrary: () => editable,
    MaweState: { onProjectDirtyChange() {} },
    MaweSettings: { EDITOR_SETTINGS: {} },
    managerService: {},
  }));
  const source = readFileSync(new URL('../web/editor/styles/editor-wiring-ass-manager.js', import.meta.url), 'utf8');
  const initializer = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'initAssManagerWiring').declaration;
  vm.runInContext(publishFixtureBindings(source).slice(initializer.body.start + 1, initializer.body.end - 1), context);
  const sync = () => window.syncAssStyleForm({ id: 'ass', fontName: 'Arial', secondaryColor: '#ffffff' });
  for (const [canEdit, karaoke, disabled] of [
    [true, false, true], [true, true, false], [false, true, true],
    [false, false, true], [true, false, true], [true, true, false],
  ]) {
    editable = canEdit;
    library.assProfiles[0].animations.karaoke.enabled = karaoke;
    sync();
    assert.equal(secondary.disabled, disabled, `editable=${canEdit}, karaoke=${karaoke}`);
    assert.equal(classes.has('is-disabled'), disabled);
    assert.equal(ordinary.disabled, !canEdit);
  }
});

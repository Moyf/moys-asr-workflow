import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

// Execute the production async opening function with controlled UI and I/O.
// The browser regression below covers real focus and typing; this test makes
// completion of the pending read deterministic without timers or a server.
const source = readFileSync(new URL('../web/editor/cues/editor-text-process.js', import.meta.url), 'utf8');
let opening;
simple(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), {
  FunctionDeclaration(node) {
    if (node.id.name === 'openTextProcessModal' && node.async) opening = source.slice(node.start, node.end);
  },
});
assert.ok(opening);

function fixture() {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let loads = 0;
  const field = {};
  const noop = () => {};
  const document = { activeElement: null };
  const context = vm.createContext({
    MaweBoot: { DATA: { segments: [{}] } }, MaweInlineEdit: {},
    commitCuePanelEdit: noop, captureTargets: () => [], openRows: new Map(),
    session: 0, selection: [], expanded: false, showUnchanged: false, reading: false, writing: false,
    modal: { classList: { add: noop } }, showStorageStatus: noop, showStorageReady: noop,
    steps: [], selectedPreset: '', selectedOnly: { checked: false },
    stepList: { contains: node => node === field }, document,
    $: () => ({ focus: () => { document.activeElement = null; } }),
    loadDefault: () => { loads++; document.activeElement = null; context.steps = [{ type: 'replace', find: '' }]; },
    refresh: () => pending, renderPresets: noop, schedulePreview: noop,
  });
  vm.runInContext(opening + '\nthis.open = openTextProcessModal;', context);
  return { context, field, release, loads: () => loads };
}

test('late defaults refresh preserves the focused rule before its first input', async () => {
  const f = fixture();
  const opened = f.context.open();
  f.context.document.activeElement = f.field;
  f.release(true);
  await opened;
  assert.equal(f.loads(), 1, 'do not rebuild a focused rule');
  assert.equal(f.context.document.activeElement, f.field);
});

test('untouched and unfocused steps still adopt refreshed defaults', async () => {
  const f = fixture(); const opened = f.context.open();
  f.release(true); await opened;
  assert.equal(f.loads(), 2);
});

test('typed steps still survive a late read even after focus leaves the rule', async () => {
  const f = fixture(); const opened = f.context.open();
  f.context.steps[0].find = '甲';
  f.release(true); await opened;
  assert.equal(f.loads(), 1);
  assert.equal(f.context.steps[0].find, '甲');
});

test('completion from an old modal session cannot reset the new session', async () => {
  const f = fixture(); const opened = f.context.open();
  f.context.session++;
  f.release(true); await opened;
  assert.equal(f.loads(), 1);
});

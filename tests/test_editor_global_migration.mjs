import assert from 'node:assert/strict';
import test from 'node:test';
import { collectOwners, migrateEditorFile } from '../scripts/refactor-tools/editor-global-migration.mjs';

const owner = 'web/editor/state/core.js';
const consumer = 'web/editor/ui/feature.js';
const owners = collectOwners(new Map([[owner, 'export let MaweCore;']]));

test('migration preserves receiver, accessors and optional member calls', () => {
  const source = 'export function run() { MaweCore.count++; return window.MaweCore?.read?.(); }';
  const result = migrateEditorFile(source, consumer, owners);
  assert.equal(result.replaced, 2);
  assert.deepEqual(result.issues, []);
  assert.match(result.source, /import \{ MaweCore \} from '\.\.\/state\/core\.js';/);
  assert.match(result.source, /MaweCore.count\+\+; return MaweCore\?\.read\?\.\(\);/);
  const rerun = migrateEditorFile(result.source, consumer, owners);
  assert.equal(rerun.source, result.source);
  assert.equal(rerun.replaced, 0);
});

test('qualified references receive an unshadowed import binding', () => {
  const source = 'export function run(MaweCore, window) { return window.MaweCore; }\n'
    + 'export function start(MaweCore) { return globalThis["MaweCore"].run(); }\n'
    + 'export function stop() { return { MaweCore }; }';
  const result = migrateEditorFile(source, consumer, owners);
  assert.match(result.source, /import \{ MaweCore as editorMaweCore \}/);
  assert.match(result.source, /return window\.MaweCore/);
  assert.match(result.source, /return editorMaweCore\.run\(\)/);
  assert.match(result.source, /return \{ MaweCore: editorMaweCore \}/);
});

test('only standalone same-owner alias assignments can be removed mechanically', () => {
  const source = 'export let MaweCore;\n(function (global) {\n'
    + 'MaweCore = Object.freeze({});\nglobal.MaweCore = MaweCore;\n'
    + 'window[key] = 1;\nwindow.MaweCore = {};\n})(window);';
  const result = migrateEditorFile(source, owner, owners, { removeAliases: true });
  assert.equal(result.aliases.length, 1);
  assert.deepEqual(result.issues.map(issue => issue.reason), ['dynamic global key', 'global write']);
  assert.match(result.source, /MaweCore = Object.freeze/);
  assert.doesNotMatch(result.source, /global\.MaweCore/);
  assert.match(result.source, /window\.MaweCore =/);
});

test('ambiguous exports and unsafe namespace calls require explicit resolution', () => {
  assert.throws(() => collectOwners(new Map([
    [owner, 'export let MaweCore;'], [consumer, 'export const MaweCore = {};'],
  ])), /Ambiguous export MaweCore/);
  const result = migrateEditorFile('window.MaweCore(); window.MaweUnknown.x;', consumer, owners);
  assert.equal(result.replaced, 0);
  assert.deepEqual(result.issues.map(issue => issue.reason), [
    'call uses global receiver', 'missing module export',
  ]);
});

test('only immutable aliases of the browser realm are recognized', () => {
  const source = 'const browser = window; let maybe = window;\n'
    + 'browser.MaweCore.run(); maybe.MaweCore.run();';
  const result = migrateEditorFile(source, consumer, owners);
  assert.equal(result.replaced, 1);
  assert.match(result.source, /\nMaweCore\.run\(\); maybe\.MaweCore\.run\(\);/);
});

test('pattern and iteration writes are left for manual migration', () => {
  const source = 'for (window.MaweCore of values) {}\n'
    + 'for (window.MaweCore in values) {}\n'
    + '[window.MaweCore] = values;\n'
    + '({item: [window.MaweCore = defaultValue]} = values);\n'
    + '({[window.MaweCore.key]: target.value} = values);';
  const result = migrateEditorFile(source, consumer, owners);
  assert.equal(result.replaced, 1);
  assert.deepEqual(result.issues.map(issue => issue.reason), Array(4).fill('global write'));
  assert.match(result.source, /\{\[MaweCore\.key\]: target\.value\}/);
});

test('tagged templates retain the global receiver for manual migration', () => {
  const source = 'window.MaweCore`value`;';
  const result = migrateEditorFile(source, consumer, owners);
  assert.equal(result.source, source);
  assert.deepEqual(result.issues.map(issue => issue.reason), ['tagged template uses global receiver']);
});

test('a reassigned IIFE parameter is not a browser realm alias', () => {
  const source = '(function (root) { root = unrelated; return root.MaweCore.read(); })(window);';
  assert.equal(migrateEditorFile(source, consumer, owners).source, source);
});

test('owners reference the local binding behind an aliased export', () => {
  const source = 'const implementation = {}; export { implementation as MaweCore };'
    + ' window.MaweCore = implementation; window.MaweCore.run();';
  const aliasedOwners = collectOwners(new Map([[owner, source]]));
  const result = migrateEditorFile(source, owner, aliasedOwners, { removeAliases: true });
  assert.equal(result.replaced, 1);
  assert.equal(result.aliases.length, 1);
  assert.deepEqual(result.issues, []);
  assert.match(result.source, /implementation\.run\(\)/);
  assert.doesNotMatch(result.source, /window\.MaweCore/);
});

test('a conditional alias assignment cannot be removed as a standalone statement', () => {
  const source = 'export let MaweCore; if (enabled) window.MaweCore = MaweCore;';
  const result = migrateEditorFile(source, owner, owners, { removeAliases: true });
  assert.equal(result.source, source);
  assert.deepEqual(result.issues.map(issue => issue.reason), ['global write']);
});

test('same-realm member chains and aliases are recognized', () => {
  const source = 'const browser = globalThis.window;'
    + ' browser["MaweCore"]?.run(); globalThis.window?.MaweCore?.read?.();';
  const result = migrateEditorFile(source, consumer, owners);
  assert.equal(result.replaced, 2);
  assert.match(result.source, /MaweCore\?\.run\(\); MaweCore\?\.read\?\.\(\);/);
});

test('audit finds globals beyond legacy facade names', () => {
  const source = 'window.__newEditorJob = {}; Object.defineProperty(globalThis, "state", { value: 1 });\n'
    + 'window.location.hash = "#demo";';
  const result = migrateEditorFile(source, consumer, owners);
  assert.deepEqual(result.issues.map(issue => issue.reason), ['global write', 'global mutation helper']);
});

test('browser audit recognizes destructuring, an undeclared write and a classic script declaration', () => {
  const source = 'const browser = globalThis.window;'
    + ' const { MAWLauncher } = browser;'
    + ' taskState = {};'
    + ' function openTool() {}';
  const { issues } = migrateEditorFile(source, consumer, new Map(), { auditOnly: true, classic: true });
  assert.ok(issues.some(issue => issue.name === 'MAWLauncher' && issue.reason === 'destructured browser global'));
  assert.ok(issues.some(issue => issue.name === 'taskState' && issue.reason === 'assignment to undeclared binding'));
  assert.ok(issues.some(issue => issue.name === 'openTool' && issue.reason === 'classic script global declaration'));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCommandRegistry } from '../web/editor/ui/editor-command-palette.js';
import { registerBuiltinCommands } from '../web/editor/ui/editor-command-defs.js';

const def = (id, extra = {}) => ({ id, title: id, category: '设置', run() {}, ...extra });
const ids = rows => rows.map(row => row.command.id);

test('validates and deduplicates definitions; a disposer only removes its own registration', () => {
  const palette = createCommandRegistry();
  const keywords = ['preferences'];
  const dispose = palette.register(def('settings.general', { keywords }));
  keywords.push('oops');
  assert.deepEqual(palette.list('oops'), []);
  assert.throws(() => palette.register(def('settings.general')), /Duplicate/);
  assert.throws(() => palette.register(def('invalid')), /Invalid/);
  assert.equal(palette.unregister('settings.general'), true);
  palette.register(def('settings.general'));
  assert.equal(dispose(), false);
  assert.deepEqual(ids(palette.list()), ['settings.general']);
});

test('ranks exact title ahead of fuzzy results and matches both languages, aliases and shortcuts', () => {
  const translate = text => ({ '保存工程': 'Save project', '另存为': 'Save as', '设置': 'Settings' })[text] ?? text;
  const palette = createCommandRegistry({ translate });
  palette.register(def('file.save-as', { title: '另存为', shortcut: 'Ctrl+Shift+S' }));
  palette.register(def('file.save', { title: '保存工程', shortcut: 'Ctrl+S', keywords: ['MOSP'] }));
  assert.equal(ids(palette.list('save project'))[0], 'file.save');
  for (const query of ['保工', 'ｓａｖｅｐｒｊ', 'settings MOSP', 'Cmd+S', '保存 ctrl+s']) {
    assert.equal(ids(palette.list(query))[0], 'file.save', query);
  }
  assert.deepEqual(palette.list('save something-impossible'), []);
});

test('filters availability, keeps provider ids unique and isolates provider errors', () => {
  const errors = [];
  const palette = createCommandRegistry({ reportError: error => errors.push(error.message) });
  let enabled = false;
  let providerRuns = 0;
  palette.register(def('file.open', { when: () => enabled }));
  palette.registerProvider(() => { throw new Error('unavailable'); });
  const dispose = palette.registerProvider(() => {
    providerRuns++;
    return [def('file.open'), def('project.dynamic')];
  });
  assert.equal(providerRuns, 0);
  assert.deepEqual(ids(palette.list()), ['project.dynamic']);
  enabled = true;
  assert.deepEqual(ids(palette.list()), ['file.open', 'project.dynamic']);
  dispose();
  assert.deepEqual(ids(palette.list()), ['file.open']);
  assert.deepEqual(errors, ['unavailable', 'unavailable', 'unavailable']);
});

test('recents persist bounded command ids without affecting nonempty search ranking', () => {
  let value = '{';
  const storage = { getItem: () => value, setItem: (_key, next) => { value = next; } };
  let palette = createCommandRegistry({ storage });
  for (let i = 0; i < 10; i++) palette.markUsed(`file.test-${i}`);
  palette.markUsed('file.test-8');
  assert.deepEqual(JSON.parse(value), [8, 9, 7, 6, 5, 4, 3, 2].map(i => `file.test-${i}`));
  palette = createCommandRegistry({ storage });
  palette.register(def('file.open', { title: 'Open' }));
  palette.register(def('file.test-8', { title: 'Reopen' }));
  assert.deepEqual(ids(palette.list()), ['file.test-8', 'file.open']);
  assert.deepEqual(ids(palette.list('open')), ['file.open', 'file.test-8']);
});

test('Phase 1 registers 40 unique built-ins', () => {
  const ids = new Set();
  registerBuiltinCommands({ register(command) { ids.add(command.id); } });
  assert.equal(ids.size, 40);
});

test('built-in save and seek commands follow the editor capability and reuse its actions', async () => {
  const calls = [];
  let target = false;
  const win = {
    MaweCoreState: { player: { duration: NaN } },
    MaweState: { projectLoadPending: false },
    MaweServerSave: { projectSaveTargetEnabled: () => target },
    MaweProjectSave: { saveCurrentProject: () => calls.push('save') },
    MaweMediaPlayback: { seekMediaTo: time => calls.push(time) },
  };
  const registry = createCommandRegistry();
  registerBuiltinCommands(registry, win, { getElementById: () => null, querySelector: () => null });
  const get = id => registry.list().find(row => row.command.id === id)?.command;
  assert.equal(get('file.save'), undefined);
  assert.equal(get('playback.end'), undefined);
  win.MaweServerSave.requiresMigrationSaveAs = true;
  assert.ok(get('file.save'));
  win.MaweServerSave.requiresMigrationSaveAs = false;
  target = true;
  win.MaweCoreState.player.duration = 15;
  await get('file.save').run();
  get('playback.start').run();
  get('playback.end').run();
  assert.deepEqual(calls, ['save', 0, 15]);
  win.MaweServerSave.projectSaveInFlight = true;
  assert.equal(get('file.save'), undefined);
  assert.equal(get('file.save-as'), undefined);
});

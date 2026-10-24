import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// 命令与视图更新已转 ESM 模块（register/resolve 注册表退役）：
// 源码在 vm 里还原为可执行文本后直调工厂。
const COMMANDS_SRC = readFileSync(new URL('../web/editor/state/editor-commands.js', import.meta.url), 'utf8');
const VIEWS_SRC = readFileSync(new URL('../web/editor/state/editor-view-updates.js', import.meta.url), 'utf8');

function moduleExports(source, names) {
  const context = { window: {}, module_exports: objs => objs };
  const stripped = source
    .replace(/^import .*$/gm, '')
    .replace(/^export function/gm, 'function');
  return vm.runInNewContext(`(function () { ${stripped}\nreturn { ${names} }; })()`, context);
}

const { createEditorCommands } = moduleExports(COMMANDS_SRC, 'createEditorCommands');
const { createViewUpdates } = moduleExports(VIEWS_SRC, 'createViewUpdates');

function commandFixture() {
  const data = { value: 0, dirty: false };
  const history = [], redo = ['existing redo'], updates = [];
  const commands = createEditorCommands({
    capture: label => ({ label, ...data }),
    hasChanges: before => data.value !== before.value,
    publish(before) { history.push(before); redo.length = 0; data.dirty = true; },
    restore(before, { dirtyOnly }) {
      if (!dirtyOnly) data.value = before.value;
      data.dirty = before.dirty;
    },
    refresh: options => updates.push(options),
  });
  return { commands, data, history, redo, updates };
}

test('drag preview stages one record and publishes once at commit', () => {
  const { commands, data, history, redo, updates } = commandFixture();
  const drag = commands.begin('move');
  data.value = 1;
  data.value = 2;
  assert.equal(history.length, 0);
  assert.deepEqual(redo, ['existing redo']);
  assert.equal(drag.commit({ cueList: true }), true);
  assert.equal(drag.commit({ cueList: true }), false);
  assert.equal(history.length, 1);
  assert.equal(history[0].value, 0);
  assert.equal(data.dirty, true);
  assert.equal(updates.length, 1);
  assert.deepEqual(redo, []);
});

test('a drag returning to its origin preserves redo and restores dirty flags', () => {
  const { commands, data, history, redo, updates } = commandFixture();
  const drag = commands.begin('move');
  data.value = 1;
  data.dirty = true;
  data.value = 0;
  assert.equal(drag.commit(), false);
  assert.equal(data.dirty, false);
  assert.equal(history.length, 0);
  assert.equal(updates.length, 0);
  assert.deepEqual(redo, ['existing redo']);
});

test('cancelled preview restores its snapshot without publishing history or clearing redo', () => {
  const { commands, data, history, redo } = commandFixture();
  const drag = commands.begin('move');
  data.value = 3;
  assert.equal(drag.cancel(), true);
  assert.equal(drag.cancel(), false);
  assert.equal(data.value, 0);
  assert.equal(history.length, 0);
  assert.deepEqual(redo, ['existing redo']);
});

test('failed mutations restore state and preserve existing history and redo', () => {
  const { commands, data, history, redo } = commandFixture();
  const failure = new Error('invalid mutation');
  assert.throws(() => commands.run('split', () => { data.value = 7; throw failure; }), error => error === failure);
  assert.equal(data.value, 0);
  assert.equal(history.length, 0);
  assert.deepEqual(redo, ['existing redo']);
});

test('before-begin listeners finish a merged gesture before capturing the next command', () => {
  const { commands, data, history } = commandFixture();
  const wheel = commands.begin('wheel');
  data.value = 1;
  let calls = 0;
  const unsubscribe = commands.onBeforeBegin(() => {
    calls += 1;
    wheel.commit();
  });
  const color = commands.begin('color');
  assert.equal(calls, 1);
  assert.deepEqual(history.map(record => record.value), [0]);
  data.value = 2;
  color.cancel();
  assert.equal(data.value, 1, 'cancelling the second command preserves the committed wheel result');
  assert.equal(unsubscribe(), true);
  assert.equal(unsubscribe(), false);
  commands.begin('unsubscribed').cancel();
  assert.equal(calls, 1);
});

test('a command may commit before reselecting its newly rendered result without publishing twice', () => {
  const { commands, data, history, updates } = commandFixture();
  const value = commands.run('split', command => {
    data.value = 2;
    command.commit({ cueList: true });
    assert.equal(updates.length, 1);
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(history.length, 1);
});

test('view updates use explicit scopes and preserve render, preview, save order', () => {
  const calls = [];
  const views = createViewUpdates({
    renderCues: options => calls.push(['cues', { ...options }]),
    updatePreview: () => calls.push(['update']),
    refreshPreview: () => calls.push(['refresh']),
    scheduleSave: () => calls.push(['save']),
  });
  const anchor = { id: 'cue' };
  views.invalidate({ cueList: true, waveform: 'full', preserveCueListScroll: false, cueListAnchor: anchor, preview: 'update', save: true });
  assert.deepEqual(calls, [['cues', { waveform: 'full', preserveCueListScroll: false, cueListAnchor: anchor }], ['update'], ['save']]);
  calls.length = 0;
  views.invalidate({ preview: 'refresh' });
  assert.deepEqual(calls, [['refresh']]);
});

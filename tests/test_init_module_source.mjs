import { editorInitializers } from './helpers/editor-entry.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { initModuleSource } from './helpers/init-module-source.mjs';

test('VM helper compiles every cue initializer, including aliased imports', () => {

  for (const item of editorInitializers.filter(item => item.file.startsWith('editor/cues/'))) {
    assert.doesNotThrow(() => new vm.Script(initModuleSource(item.file)), item.file);
  }
});

for (const owner of ['globalThis', 'window']) {
  test(`aliased imports resolve the imported facade member on ${owner} at call time`, () => {
    const source = initModuleSource('editor/cues/editor-word-timing.js');
    const shims = source.slice(0, source.indexOf('(function initWordTiming'));
    const calls = [];
    const facade = { clearSelection: options => { calls.push(options); return 'cleared'; } };
    const context = { window: {} };
    if (owner === 'window') context.window.MaweSelection = facade;
    else context.MaweSelection = facade;
    vm.createContext(context);
    vm.runInContext(shims, context);
    const options = { commitCuePanel: false };
    assert.equal(context.clearCueSelection(options), 'cleared');
    assert.deepEqual(calls, [options]);
    facade.clearSelection = () => 'replacement';
    assert.equal(context.clearCueSelection(options), 'replacement');
  });
}

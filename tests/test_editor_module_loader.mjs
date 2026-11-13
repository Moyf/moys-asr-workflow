import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSources } from '../scripts/build-editor.mjs';
import { createEditorModuleLoader } from './helpers/editor-module-loader.mjs';

const entries = ['shared/editor-utils.js', 'editor/media/waveform.js'];

for (const entry of entries) {
  test(`fixture preparation compiles only ${entry} and shares its in-flight work`, async () => {
    const calls = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const loader = createEditorModuleLoader(async (...args) => {
      calls.push(args);
      await gate;
      return compileSources(...args);
    });
    assert.equal(calls.length, 0, 'constructing a loader must not compile either fixture');
    assert.throws(() => loader.loadEditorModule({window:{}}, entry), /Await prepareEditorModule/);
    const pending = loader.prepareEditorModule(entry);
    assert.equal(loader.prepareEditorModule(entry), pending, 'concurrent prepares share one promise');
    assert.equal(calls.length, 1);
    assert.ok(calls[0][1].includes(entry));
    assert.ok(!calls[0][1].includes(entries.find(other => other !== entry)), 'no unrelated fixture');
    assert.equal(calls[0][4].beforeEntry, entry);
    assert.throws(() => loader.loadEditorModule({window:{}}, entry), /Await prepareEditorModule/);
    release();
    await pending;
    assert.equal(loader.prepareEditorModule(entry), pending, 'completed prepares reuse compiled text');
    assert.equal(calls.length, 1);

    const first = {window:{}}, second = {window:{}};
    let hooks = 0;
    const loaded = loader.loadEditorModule(first, entry, browser => {
      hooks++;
      assert.equal(browser, first.window);
      browser.fixtureHook = true;
    });
    assert.equal(loaded, first.window, 'load remains synchronous');
    assert.equal(hooks, 1);
    assert.equal(first.window.fixtureHook, true);
    assert.ok(!Object.hasOwn(first, '__mawBeforeFixture'));
    loader.loadEditorModule(second, entry);
    assert.equal(second.window.fixtureHook, undefined);
    assert.notEqual(first.window.MAWE, second.window.MAWE);
    if (entry === entries[0]) {
      first.window.AsrEditorUtils.setSplitTrimSymbols(['#']);
      second.window.AsrEditorUtils.setSplitTrimSymbols(['@']);
      assert.equal(first.window.AsrEditorUtils.applySplitEdgeTrim('#hello#'), '#hello');
      assert.equal(second.window.AsrEditorUtils.applySplitEdgeTrim('#hello#'), '#hello#');
    } else {
      const firstColors = first.window.MAWE.resolve('waveform-colors');
      const secondColors = second.window.MAWE.resolve('waveform-colors');
      firstColors.setColorPalette([{name:'yellow',value:'#123456'}]);
      secondColors.setColorPalette([{name:'yellow',value:'#abcdef'}]);
      const segment = {color:{name:'yellow'}};
      assert.equal(firstColors.colorForSegment(segment), '#123456');
      assert.equal(secondColors.colorForSegment(segment), '#abcdef');
    }
    const failing = {window:{}};
    assert.throws(() => loader.loadEditorModule(failing, entry, () => { throw new Error('hook failed'); }), /hook failed/);
    assert.ok(!Object.hasOwn(failing, '__mawBeforeFixture'), 'failed execution removes the temporary hook');
  });
}

test('independent preparations cache both requested entries without duplicate compilation', async () => {
  const calls = [];
  const loader = createEditorModuleLoader(async (...args) => {
    calls.push(args[4].beforeEntry);
    return {code:'window.loaded = true;'};
  });
  await Promise.all([...entries, ...entries].map(loader.prepareEditorModule));
  assert.deepEqual(calls, entries);
  for (const entry of entries) assert.equal(loader.loadEditorModule({window:{}}, entry).loaded, true);
});

test('invalid entries fail before compiling and failed preparations can be retried', async () => {
  let calls = 0;
  const loader = createEditorModuleLoader(async () => {
    if (++calls === 1) throw new Error('compiler unavailable');
    return {code:'window.loaded = true;'};
  });
  assert.throws(() => loader.prepareEditorModule('unknown.js'), /Unknown editor fixture/);
  assert.throws(() => loader.loadEditorModule({window:{}}, 'unknown.js'), /Unknown editor fixture/);
  assert.equal(calls, 0);
  await assert.rejects(loader.prepareEditorModule(entries[0]), /compiler unavailable/);
  assert.throws(() => loader.loadEditorModule({window:{}}, entries[0]), /Await prepareEditorModule/);
  await loader.prepareEditorModule(entries[0]);
  assert.equal(calls, 2);
  assert.equal(loader.loadEditorModule({window:{}}, entries[0]).loaded, true);
});

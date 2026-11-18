import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
const source = fs.readFileSync(new URL('../web/editor/io/editor-wiring-export-actions.js', import.meta.url), 'utf8');
const fn = parse(source, { ecmaVersion: 'latest' }).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'downloadPreparedAss');
const code = source.slice(fn.start, fn.end);
function fixture({ pickerError, writeError } = {}) {
  const calls = [];
  let release, reject;
  const ready = new Promise((resolve, fail) => { release = resolve; reject = fail; });
  const context = { Blob, window: { MaweAssFontAliases: {
    ensureCoverage: () => ready, pending: () => true, whenReady: () => ready,
  } }, MaweHost: { files: { hasSavePicker: () => true,
    pickSaveFile: async () => { calls.push('picker'); if (pickerError) throw pickerError; return { name: 'captions.ass' }; },
    writeBlob: async (_handle, blob) => { calls.push('write'); if (writeError) throw writeError; assert.equal(await blob().text(), 'original ASS'); },
  } }, MaweExportTimeline: { downloadFile: async (_data, _name, _mime, _accept, options) => { calls.push(['fallback', options.usePicker]); } },
  buildAssWithFontAliasCapture: build => build(), announceAssFontAliasReplacements() {} };
  vm.runInNewContext(code, context);
  return { calls, release, reject, context, run: () => context.downloadPreparedAss(() => { calls.push('build'); return 'original ASS'; }, 'captions.ass', 'ASS') };
}

test('cold ASS download acquires handle synchronously and writes only after coverage readiness', async () => {
  const h = fixture(); const pending = h.run();
  assert.deepEqual(h.calls, ['picker']);
  await Promise.resolve(); assert.deepEqual(h.calls, ['picker']);
  h.release(); await pending;
  assert.deepEqual(h.calls, ['picker', 'build', 'write']);
});
test('cancelled ASS picker never builds, writes or falls back while coverage is pending', async () => {
  const h = fixture({ pickerError: { name: 'AbortError' } });
  await h.run(); assert.deepEqual(h.calls, ['picker']); h.release();
});
test('unavailable picker retains existing anchor fallback after coverage, not a second picker', async () => {
  const h = fixture({ pickerError: { name: 'SecurityError' } });
  const pending = h.run(); h.release(); await pending;
  assert.deepEqual(h.calls, ['picker', 'build', ['fallback', false]]);
});
test('font/write failure propagates without silently exporting a second copy', async () => {
  const h = fixture(); const pending = h.run();
  h.reject(new Error('font failure')); await assert.rejects(pending, /font failure/);
  assert.deepEqual(h.calls, ['picker']);
  const w = fixture({ writeError: new Error('write failure') }); const writing = w.run();
  w.release(); await assert.rejects(writing, /write failure/);
  assert.deepEqual(w.calls, ['picker', 'build', 'write']);
});

 test('project switch during cold ASS download never writes new project into the old filename', async () => {
  const h = fixture(); h.context.window.MaweProjectLoad = { projectBindingEpoch: 1 };
  const pending = h.run(); h.context.window.MaweProjectLoad.projectBindingEpoch = 2;
  h.release(); await assert.rejects(pending, /工程已切换/);
  assert.deepEqual(h.calls, ['picker']);
});

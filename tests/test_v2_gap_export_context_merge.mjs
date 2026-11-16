import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/editor/io/editor-wiring-export-actions.js', import.meta.url), 'utf8');
const start = source.indexOf('  const intervals = context.intervals.map(');
const end = source.indexOf('  let videoTimeline = null;', start);
assert.ok(start >= 0 && end > start, 'gap export setup must remain discoverable');
const script = new vm.Script(`(() => { ${source.slice(start, end)}; return { intervals, audioSelection, buildVideoSrt }; })()`);

function run(isAudio, capture) {
  const warnings = [];
  const context = vm.createContext({ isAudio, selectedAudioTrack: 2,
    context: { durationMs: 1502, intervals: [{ start: 0, end: 1502 }] },
    MaweExportSrt: { captureVideoSrt: capture }, MaweHint: { flashHint: (...args) => warnings.push(args) } });
  return { result: script.runInContext(context), warnings };
}

test('audio export preserves selected track, duration and source-end flag', () => {
  const { result } = run(true, () => { throw new Error('audio must not capture SRT'); });
  assert.equal(result.audioSelection.selectedAudioTrack, 2);
  assert.equal(result.audioSelection.keepToSourceEnd, true);
  assert.equal(result.audioSelection.editorDurationMs, 1502);
  assert.equal(result.buildVideoSrt, null);
});

test('a v2 subtitle-policy failure is reported without blocking video export', () => {
  const error = new Error('unsupported overlay');
  const { result, warnings } = run(false, () => { throw error; });
  assert.equal(result.buildVideoSrt, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /unsupported overlay/);
  assert.equal(warnings[0][2].error, error);
});

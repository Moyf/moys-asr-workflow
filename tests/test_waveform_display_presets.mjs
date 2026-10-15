import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createWaveformModule } from '../web/editor/media/waveform/workspace.js';

test('row length updates controls, invalidates rows and persists only valid changes', () => {
  const saved = [];
  const methods = createWaveformModule({ saveSettings: value => saved.push({ ...value }) });
  let renders = 0;
  const editor = { settings: { secondsPerRow: 20 }, secondsPerRowSelect: { value: '20' },
    multiRange: [0, 1], render() { renders += 1; } };
  const set = value => methods.setSecondsPerRow.value.call(editor, value);
  assert.equal(set('5'), true);
  assert.equal(editor.settings.secondsPerRow, 5);
  assert.equal(editor.secondsPerRowSelect.value, '5');
  assert.deepEqual(editor.multiRange, [-1, -1]);
  assert.equal(set(5), true);
  for (const invalid of [0, -5, 7, NaN, null]) assert.equal(set(invalid), false);
  assert.equal(renders, 1);
  assert.deepEqual(saved, [{ secondsPerRow: 5 }]);
});

function fixture(mode = 'basic') {
  const editor = { settings: { rowHeight: 192, secondsPerRow: 20 },
    renders: 0,
    render() { this.renders += 1; },
    isMultiMode() { return mode === 'multi'; },
    getRowHeight() { return this.settings.rowHeight; },
    setRowHeight(value, { render = true } = {}) { this.settings.rowHeight = value; if (render) this.render(); },
    setSecondsPerRow(value, { render = true } = {}) { this.settings.secondsPerRow = value; if (render) this.render(); },
  };
  const settings = { multiSubtitleRowHeight: 168, wordTimingRowHeight: 144, wordTimingSecondsPerRow: 5 };
  const context = { window: {}, MaweCoreState: { waveformEditor: editor }, MaweSettings: { EDITOR_SETTINGS: settings } };
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/ui/editor-display-settings.js', import.meta.url), 'utf8'), context);
  const display = context.window.MaweDisplaySettings;
  return { editor, settings, display,
    toggle(mode, enabled) { display[mode === 'word' ? 'syncWordTimingWaveformSettings' : 'syncMultiSubtitleWaveformRowHeight'](enabled); },
  };
}

for (const first of ['multi', 'word']) {
  for (const closeFirst of ['multi', 'word']) {
    test(`presets restore their shared baseline: enable ${first}, close ${closeFirst} first`, () => {
      const f = fixture();
      const second = first === 'multi' ? 'word' : 'multi';
      f.toggle(first, true);
      f.toggle(second, true);
      assert.equal(f.editor.settings.rowHeight, second === 'word' ? 144 : 168);
      f.toggle(closeFirst, false);
      const remaining = closeFirst === 'word' ? 'multi' : 'word';
      assert.equal(f.editor.settings.rowHeight, remaining === 'word' ? 144 : 168);
      assert.equal(f.editor.settings.secondsPerRow, remaining === 'word' ? 5 : 20);
      f.toggle(remaining, false);
      assert.deepEqual(f.editor.settings, { rowHeight: 192, secondsPerRow: 20 });
    });
  }
}

test('editing an inactive mode preset preserves the active mode and takes effect on return', () => {
  const f = fixture();
  f.toggle('multi', true);
  f.toggle('word', true);
  f.settings.multiSubtitleRowHeight = 120;
  f.display.applyWaveformModeRowHeight();
  assert.equal(f.editor.settings.rowHeight, 144);
  f.settings.wordTimingRowHeight = 96;
  f.display.applyWaveformModeRowHeight();
  assert.equal(f.editor.settings.rowHeight, 96);
  f.toggle('word', false);
  assert.equal(f.editor.settings.rowHeight, 120);
  f.toggle('multi', false);
  assert.equal(f.editor.settings.rowHeight, 192);
});

test('repeated UI sync and project mode changes do not replace the baseline', () => {
  const f = fixture();
  f.toggle('multi', true);
  f.toggle('multi', true);
  f.toggle('word', true);
  f.toggle('multi', false);
  f.toggle('multi', false);
  f.toggle('multi', true);
  f.toggle('word', false);
  f.toggle('multi', false);
  assert.deepEqual(f.editor.settings, { rowHeight: 192, secondsPerRow: 20 });
});

test('word presets redraw multi-row geometry once and preserve its baseline on return', () => {
  const f = fixture('multi');
  assert.equal(f.display.syncWordTimingWaveformSettings(true), true);
  assert.equal(f.editor.renders, 1);
  assert.equal(f.editor.settings.rowHeight, 144);
  assert.equal(f.editor.settings.secondsPerRow, 5);
  assert.equal(f.display.syncWordTimingWaveformSettings(false), true);
  assert.equal(f.editor.renders, 2);
  assert.deepEqual(f.editor.settings, { rowHeight: 192, secondsPerRow: 20 });
});

test('word presets in basic mode leave the Canvas and horizontal view for an overlay-only refresh', () => {
  const f = fixture();
  assert.equal(f.display.syncWordTimingWaveformSettings(true), false);
  assert.equal(f.display.syncWordTimingWaveformSettings(false), false);
  assert.equal(f.editor.renders, 0);
  assert.deepEqual(f.editor.settings, { rowHeight: 192, secondsPerRow: 20 });
});

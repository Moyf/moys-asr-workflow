import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { invokedInitModuleSource } from './helpers/init-module-source.mjs';

function fixture(clickBehavior) {
  const handlers = {};
  const calls = { select: [], reveal: [], seek: [], play: 0, guard: 0 };
  const element = { addEventListener: (event, handler) => { handlers[event] = handler; } };
  const main = { role: 'main', segments: [{ id: 'cue', start: 1250, end: 2000 }] };
  const context = {
    MaweBoot: { DATA: { schema: 'moy.asr.project.v2', tracks: [main] } },
    AsrEditorUtils: { getMainTrack: project => project.tracks.find(track => track.role === 'main') },
    MaweInlineEdit: {},
    MaweSelection: { lastClickedIdx: -1 },
    MaweSettings: { EDITOR_SETTINGS: { cueListAutoScrollOnClick: false, clickBehavior } },
    MaweCoreState: { waveformEditor: { revealTime: (...args) => calls.reveal.push(args) }, player: { paused: true } },
    MawePlaybackLoop: { suppressCueListAutoScroll: false },
    MaweKeyboardGuards: { isPlaybackActive() { calls.guard++; return false; } },
    MaweMediaPlayback: { togglePlayback() { calls.play++; } },
    selectCueByClick: index => calls.select.push(index),
    seekFromWaveform: (time, options) => calls.seek.push({ time, mouseClick: options.mouseClick }),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(invokedInitModuleSource('editor/cues/editor-cue-events.js', 'initMaweCueEvents'), context);
  context.MaweCueEvents.bindCueEvents(element, 0);
  return { context, handlers, calls };
}

test('click reads the v2 main track and uses the keyboard playback guard', () => {
  const { context, handlers, calls } = fixture('select-and-play');
  handlers.click({ detail: 1 });
  assert.deepEqual(calls.select, [0]);
  assert.deepEqual(calls.reveal[0], [1250, true]);
  assert.equal(calls.seek[0].time, 1.25);
  assert.equal(calls.seek[0].mouseClick, true);
  assert.equal(calls.guard, 1);
  assert.equal(calls.play, 1);
  assert.equal(context.MawePlaybackLoop.suppressCueListAutoScroll, false);
});

test('select-only still reveals the v2 cue but does not seek or start playback', () => {
  const { handlers, calls } = fixture('select-only');
  handlers.click({ detail: 1 });
  assert.equal(calls.reveal[0][0], 1250);
  assert.equal(calls.seek.length, 0);
  assert.equal(calls.play, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { plainModuleSource } from './helpers/init-module-source.mjs';
import { exposeWindowGlobals } from './helpers/vm-window-globals.mjs';

function fixture(clickBehavior, { pauseOnSeek = false } = {}) {
  const handlers = {};
  const calls = { select: [], reveal: [], seek: [], play: 0 };
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
    MaweJklPlayback: { jklReversePlaying: false },
    selectCueByClick: index => calls.select.push(index),
    seekFromWaveform(time, options) {
      calls.seek.push({ time, mouseClick: options.mouseClick });
      if (pauseOnSeek && options.mouseClick) context.MaweCoreState.player.paused = true;
    },
  };
  context.window = context;
  vm.createContext(exposeWindowGlobals(context));
  vm.runInContext(plainModuleSource('editor/media/editor-media-playback.js'), context);
  context.MaweMediaPlayback = { togglePlayback() { calls.play++; } };
  vm.runInContext(plainModuleSource('editor/cues/editor-cue-events.js'), context);
  context.MaweCueEvents.bindCueEvents(element, 0);
  return { context, handlers, calls };
}

test('click reads the v2 main track and starts playback when paused', () => {
  const { context, handlers, calls } = fixture('select-and-play');
  handlers.click({ detail: 1 });
  assert.deepEqual(calls.select, [0]);
  assert.deepEqual(calls.reveal[0], [1250, true]);
  assert.equal(calls.seek[0].time, 1.25);
  assert.equal(calls.seek[0].mouseClick, true);
  assert.equal(calls.play, 1);
  assert.equal(context.MawePlaybackLoop.suppressCueListAutoScroll, false);
});

test('click reads playback from the replacement player and respects simulated reverse playback', () => {
  const { context, handlers, calls } = fixture('select-and-play', { pauseOnSeek: true });
  context.MaweCoreState.player = { paused: false };
  handlers.click({ detail: 1 });
  assert.equal(context.MaweCoreState.player.paused, true);
  assert.equal(calls.play, 0);

  context.MaweCoreState.player = { paused: true };
  context.MaweJklPlayback.jklReversePlaying = true;
  handlers.click({ detail: 1 });
  assert.equal(calls.play, 0);
});

test('select-only still reveals the v2 cue but does not seek or start playback', () => {
  const { handlers, calls } = fixture('select-only');
  handlers.click({ detail: 1 });
  assert.equal(calls.reveal[0][0], 1250);
  assert.equal(calls.seek.length, 0);
  assert.equal(calls.play, 0);
});

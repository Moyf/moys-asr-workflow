import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { initModuleSource } from './helpers/init-module-source.mjs';

function fixture({ mediaControls = false } = {}) {
  const timers = new Map(), gates = [], schedules = [], seeks = [];
  let nextTimer = 0, position = .9, playCalls = 0;
  const listeners = new Map();
  const player = { currentSrc: 'test.wav', duration: 5, paused: false, seeking: false, ended: false,
    playbackRate: 1, volume: .6, muted: false,
    get currentTime() { return position; },
    set currentTime(value) { seeks.push(value); position = value; this.seeking = true; },
    pause() { this.paused = true; for (const fn of listeners.get('pause') || []) fn(); },
    play() { playCalls++; this.paused = false; return Promise.resolve(); },
    addEventListener(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); } };
  let gaps = [{ start: 1000, end: 2000 }], enabled = true;
  const context = { MaweCoreState: { player }, MaweCuePanelState: {},
    MaweMediaPlayback: { isAuditioning: false },
    MaweGapRemoveData: { getGapRemoveData: () => ({ skip_playback: enabled }), getRemovedGapRanges: () => gaps },
    MaweAudioProcessing: { render() {}, setGapPlaybackMuted: value => gates.push(value),
      scheduleGapPlaybackMute: delay => { schedules.push(delay); return true; } },
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); } };
  context.window = context;
  for (const path of ['web/shared/gap-remove-core.js', 'web/editor/media/editor-gap-playback.js']) {
    vm.runInNewContext(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), context);
  }
  const api = context.MaweGapPlayback;
  if (mediaControls) {
    Object.assign(context, {
      MaweDom: {}, document: {}, MaweTimeline: { timelineIsFrameMode: () => false, timelineMediaSeekStepValue: () => 100 },
      MaweJklPlayback: { stopJklReversePlayback() {} }, MaweCueListAnchor: { resumeCueListFollowing() {} },
      MawePlaybackLoop: { update: () => api.refresh() },
    });
    vm.runInNewContext(initModuleSource('editor/media/editor-media-playback.js'), context);
  }
  api.bindPlayer(player);
  gates.length = 0;
  return { context, api, player, timers, gates, schedules, seeks,
    get playCalls() { return playCalls; },
    time(value) { position = value; },
    gaps(value) { gaps = value; }, enable(value) { enabled = value; },
    emit(name) { for (const fn of listeners.get(name) || []) fn(); },
    tick() { const [id, entry] = timers.entries().next().value; timers.delete(id); entry.fn(); } };
}

test('schedules an audio-clock gate before entry and seeks only at the actual gap boundary', () => {
  const f = fixture();
  assert.equal(f.api.refresh(), false);
  assert.ok(Math.abs(f.schedules[0] - .1) < 1e-8);
  assert.deepEqual(f.seeks, []);
  f.time(.99); f.tick();
  assert.deepEqual(f.seeks, [], 'an early timer must not trim retained audio');
  f.time(1); f.tick();
  assert.deepEqual(f.seeks, [2]);
  assert.equal(f.gates.at(-1), true);
  f.api.refresh();
  assert.equal(f.gates.at(-1), true, 'the target timestamp alone cannot reopen an in-progress seek');
  f.player.seeking = false; f.emit('seeked');
  assert.equal(f.gates.at(-1), false);
  assert.equal(f.player.volume, .6);
  assert.equal(f.player.muted, false);
});

test('quantized landing stays silent without repeated seeks, then reopens after leaving the gap', () => {
  const f = fixture();
  f.time(1.1); f.api.refresh();
  f.player.seeking = false; f.time(1.995); f.emit('seeked');
  f.api.refresh();
  assert.deepEqual(f.seeks, [2]);
  assert.equal(f.gates.at(-1), true);
  f.time(2.01); f.tick();
  assert.equal(f.gates.at(-1), false);
});

test('starting in a gap seeks before play; audition and an explicit preview preserve the original sound', () => {
  const f = fixture();
  f.player.paused = true; f.time(1.2);
  f.api.beforePlay(f.player);
  assert.deepEqual(f.seeks, [2]);
  f.player.seeking = false; f.time(1.2);
  f.context.MaweMediaPlayback.isAuditioning = true;
  f.api.beforePlay(f.player);
  assert.deepEqual(f.seeks, [2]);
  f.player.paused = false; f.api.refresh();
  assert.equal(f.gates.at(-1), false);
  f.context.MaweMediaPlayback.isAuditioning = false;
  f.context.MaweCuePanelState.gapPreviewRange = { start: 1000, end: 2000 };
  f.api.refresh();
  assert.deepEqual(f.seeks, [2]);
  assert.equal(f.gates.at(-1), false);
});

test('pause, disabling skip and a manual seek cancel scheduled audio gates', () => {
  for (const action of ['pause', 'disable', 'seek']) {
    const f = fixture();
    f.api.refresh();
    if (action === 'pause') { f.player.paused = true; f.emit('pause'); }
    if (action === 'disable') { f.enable(false); f.api.refresh(); }
    if (action === 'seek') { f.time(3); f.player.seeking = true; f.emit('seeking'); }
    assert.equal(f.timers.size, 0, action);
    assert.equal(f.gates.at(-1), false, action);
  }
});

test('rate and range changes reschedule the boundary; adjacent gaps remain under the gate', () => {
  const f = fixture();
  f.api.refresh();
  f.player.playbackRate = 2; f.emit('ratechange');
  assert.ok(Math.abs(f.schedules.at(-1) - .05) < 1e-8);
  f.gaps([{ start: 1100, end: 2000 }, { start: 2000, end: 2500 }]);
  f.api.refresh();
  assert.ok(Math.abs(f.schedules.at(-1) - .1) < 1e-8);
  f.time(1.1); f.tick();
  f.player.seeking = false; f.emit('seeked');
  assert.deepEqual(f.seeks, [2, 2.5]);
  assert.equal(f.gates.at(-1), true);
});

test('replacing the bound player cancels the previous player boundary callback', () => {
  const f = fixture();
  f.api.refresh();
  const replacement = { ...f.player, currentTime: .5, addEventListener() {} };
  f.context.MaweCoreState.player = replacement;
  f.api.bindPlayer(replacement);
  assert.equal(f.timers.size, 0);
  assert.equal(f.gates.at(-1), false);
});

test('buffering cancels a wall-clock deadline and reschedules only when media advances again', () => {
  const f = fixture();
  f.api.refresh();
  f.emit('waiting');
  f.api.refresh();
  assert.equal(f.timers.size, 0);
  assert.equal(f.gates.at(-1), false);
  f.time(.95); f.emit('playing');
  assert.ok(Math.abs(f.schedules.at(-1) - .05) < 1e-8);
  assert.equal(f.timers.size, 1);
});

test('late playing events from a replaced player cannot release the current buffering guard', () => {
  const f = fixture();
  const handlers = new Map();
  const replacement = { ...f.player, currentTime: .5,
    addEventListener(name, fn) { handlers.set(name, fn); } };
  f.context.MaweCoreState.player = replacement;
  f.api.bindPlayer(replacement);
  handlers.get('waiting')();
  f.emit('playing');
  f.api.refresh(replacement);
  assert.equal(f.timers.size, 0);
});

test('seek pauses the source until its old PCM drains; a user pause cancels resuming', async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    let drain;
    f.context.MaweAudioProcessing.waitForGapPlaybackSilence = () => new Promise(resolve => { drain = resolve; });
    f.time(1.1); f.api.refresh();
    assert.equal(f.player.paused, true);
    f.player.seeking = false; f.emit('seeked');
    assert.equal(f.player.paused, true);
    assert.equal(f.gates.at(-1), true);
    if (cancel) assert.equal(f.api.cancelPendingPlayback(), true);
    drain(); await Promise.resolve();
    assert.equal(f.player.paused, cancel);
    if (!cancel) assert.equal(f.gates.at(-1), false);
  }
});

test('a media replacement cancels an unfinished audio handoff', async () => {
  const f = fixture();
  let drain;
  f.context.MaweAudioProcessing.waitForGapPlaybackSilence = () => new Promise(resolve => { drain = resolve; });
  f.time(1.1); f.api.refresh();
  f.player.seeking = false; f.emit('seeked');
  f.context.MaweCoreState.player = { ...f.player, addEventListener() {} };
  f.api.bindPlayer(f.context.MaweCoreState.player);
  drain(); await Promise.resolve();
  assert.equal(f.player.paused, true);
  assert.equal(f.api.pendingPlayback, false);
});

test('manual seek during the gap seek checks the latest target before resuming', async () => {
  const f = fixture({ mediaControls: true });
  let drain;
  f.context.MaweAudioProcessing.waitForGapPlaybackSilence = () => new Promise(resolve => { drain = resolve; });
  f.time(1.1); f.api.refresh();
  f.context.MaweMediaPlayback.seekMediaBy(-.5);
  assert.deepEqual(f.seeks, [2, 1.5]);
  f.emit('seeked'); // An event for the superseded seek arrives while still seeking.
  assert.equal(drain, undefined);
  f.player.seeking = false; f.emit('seeked');
  drain(); await Promise.resolve();
  assert.deepEqual(f.seeks, [2, 1.5, 2]);
  assert.equal(f.playCalls, 0);
  assert.equal(f.gates.at(-1), true);
  f.player.seeking = false; f.emit('seeked');
  drain(); await Promise.resolve();
  assert.equal(f.playCalls, 1);
  assert.equal(f.gates.at(-1), false);
});

test('rapid manual seeks during PCM drain resume only the last target unless the user pauses', async () => {
  for (const pause of [false, true]) {
    const f = fixture({ mediaControls: true });
    const drains = [];
    f.context.MaweAudioProcessing.waitForGapPlaybackSilence = () => new Promise(resolve => drains.push(resolve));
    f.time(1.1); f.api.refresh();
    f.player.seeking = false; f.emit('seeked');
    f.context.MaweMediaPlayback.seekMediaTo(1.25);
    drains[0](); await Promise.resolve();
    assert.equal(f.playCalls, 0);
    assert.equal(f.gates.at(-1), true);
    f.player.seeking = false; f.emit('seeked');
    f.context.MaweMediaPlayback.seekMediaTo(3);
    f.player.seeking = false; f.emit('seeked');
    drains[1](); await Promise.resolve();
    assert.deepEqual(f.seeks, [2, 1.25, 3]);
    assert.equal(f.playCalls, 0);
    if (pause) f.context.MaweMediaPlayback.togglePlayback();
    drains[2](); await Promise.resolve();
    assert.equal(f.playCalls, pause ? 0 : 1);
    assert.equal(f.player.paused, pause);
    assert.equal(f.gates.at(-1), false);
  }
});

test('a manual seek to the end during a handoff stays at the end', () => {
  const f = fixture({ mediaControls: true });
  f.time(1.1); f.api.refresh();
  f.context.MaweMediaPlayback.seekMediaTo(f.player.duration);
  f.player.seeking = false; f.player.ended = true; f.emit('seeked');
  assert.equal(f.playCalls, 0, 'playing from the end would restart at zero');
  assert.equal(f.player.paused, true);
  assert.equal(f.api.pendingPlayback, false);
  assert.equal(f.gates.at(-1), false);
});

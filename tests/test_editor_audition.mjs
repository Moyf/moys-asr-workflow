import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function playbackHarness() {
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const player = {
    currentSrc: 'test.wav', currentTime: 0, duration: 10, paused: false,
    playbackRate: 1, readyState: 0,
    addEventListener(name, fn) {
      listeners.set(name, [...(listeners.get(name) || []), fn]);
    },
    pause() { this.paused = true; emit('pause'); },
    play() { this.paused = false; return Promise.resolve(); },
  };
  function emit(name) { for (const fn of listeners.get(name) || []) fn(); }
  const updates = [];
  const context = {
    window: {}, document: {},
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }, cancelAnimationFrame() {},
    MaweCoreState: { player }, MaweDom: {},
    MaweTimeline: { timelineMediaSeekStepValue: () => 100, timelineIsFrameMode: () => false },
    MaweJklPlayback: { stopJklReversePlayback() {}, isJklDirectionMode: () => false },
    MaweCueListAnchor: { resumeCueListFollowing() {}, cueListScroll: {} },
    MaweHint: { flashHint() {} },
    MawePlaybackLoop: { update() {
      updates.push({ time: player.currentTime, audition: context.window.MaweMediaPlayback.isAuditioning });
      if (!context.window.MaweMediaPlayback.isAuditioning && !player.paused
          && player.currentTime >= 2 && player.currentTime < 4) player.currentTime = 4;
    } },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/media/editor-media-playback.js', import.meta.url), 'utf8'), context);
  const api = context.window.MaweMediaPlayback;
  api.bindPlayerEvents(player);
  return { api, player, emit, updates, timers };
}

for (const start of [2.5, 1.5]) test(`audition from ${start}s ignores gaps through its end, then restores skipping`, () => {
  const { api, player, emit, updates } = playbackHarness();
  assert.equal(api.auditionRange(start * 1000, 3500), true);
  assert.equal(player.currentTime, start);
  assert.deepEqual(updates[0], { time: start, audition: true });
  emit('seeking'); emit('seeked');
  player.currentTime = 3;
  emit('timeupdate');
  assert.equal(player.currentTime, 3);
  assert.equal(player.paused, false);
  player.currentTime = 3.49;
  emit('timeupdate');
  assert.equal(player.paused, false);
  player.currentTime = 3.5;
  emit('timeupdate');
  assert.equal(player.paused, true);
  assert.equal(player.currentTime, 3.5);
  assert.equal(api.isAuditioning, false);
  player.paused = false;
  emit('timeupdate');
  assert.equal(player.currentTime, 4);
});

test('manual seek and pause cancel audition; unsuccessful seek releases its state', () => {
  const { api, player, emit, timers } = playbackHarness();
  api.auditionRange(1000, 3500);
  emit('seeking'); emit('seeked');
  player.currentTime = 5; emit('seeking');
  assert.equal(api.isAuditioning, false);
  assert.equal(timers.size, 0);
  api.auditionRange(1000, 3500); player.pause();
  assert.equal(api.isAuditioning, false);
  assert.equal(timers.size, 0);
  player.duration = NaN;
  assert.equal(api.auditionRange(1000, 3500), false);
  assert.equal(api.isAuditioning, false);
});

test('both playback refresh paths suspend gap skipping only while auditioning', () => {
  let auditioning = true;
  let captured;
  const sentinel = new Error('skip captured');
  const context = {
    window: { AsrGapRemoveCore: { getGapPlaybackSkip(_ranges, _time, options) {
      captured = options; throw sentinel;
    } } },
    MaweCoreState: { player: { currentTime: 3, paused: false } },
    MaweCuePanelState: {},
    MaweGapRemoveData: { getGapRemoveData: () => ({ skip_playback: true }), getRemovedGapRanges: () => [] },
    MaweMediaPlayback: { get isAuditioning() { return auditioning; } },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/editor/media/editor-playback-loop.js', import.meta.url), 'utf8'), context);
  for (const name of ['update', 'updatePlaybackFrame']) {
    for (const active of [true, false]) {
      auditioning = active;
      assert.throws(() => context.window.MawePlaybackLoop[name](), error => error === sentinel);
      assert.equal(captured.skipPlayback, !active);
    }
  }
});

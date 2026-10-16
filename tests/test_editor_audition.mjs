import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { compileIsolatedEsmFixture, makeDocumentStub } from './helpers/editor-module-loader.mjs';
import { makeFacadeStub, makeDeepStub } from './helpers/editor-module-loader.mjs';

function playbackHarness() {
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const player = {
    currentSrc: 'test.wav', currentTime: 0, duration: 10, paused: false,
    playbackRate: 1, readyState: 0,
    getAttribute(name) { return this.getAttributeStore?.[name] ?? null; },
    getAttributeStore: { src: 'test.wav' },
    querySelector() { return null; },
    addEventListener(name, fn) {
      listeners.set(name, [...(listeners.get(name) || []), fn]);
    },
    pause() { this.paused = true; emit('pause'); },
    play() { this.paused = false; return Promise.resolve(); },
  };
  function emit(name) { for (const fn of listeners.get(name) || []) fn(); }
  const updates = [];
  const context = {
    URLSearchParams: URLSearchParams,
    ASR_EDITOR_PALETTE: [['yellow', '#c4a019'], ['green', '#66bb6a'], ['red', '#f07f6f'], ['purple', '#bf89e6'], ['blue', '#61a7fa']],
    location: { search: '' },
    window: { addEventListener() {}, removeEventListener() {} },
    document: makeDocumentStub({
      // media-playback 顶层接线读 MaweDom.mediaPlaybackRate.options
      getElementById: (function () {
        const base = makeDocumentStub();
        const rate = { options: [], value: '', addEventListener() {}, classList: { contains: () => false }, append() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [], remove() {} };
        const container = { classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, appendChild() {}, scrollTo() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) };
        return (id) => id === 'media-playback-rate' ? rate
          : id === 'player' ? player
          : id === 'cues-container' ? container : base.getElementById(id);
      })(),
    }),
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }, cancelAnimationFrame() {},
    MaweCoreState: { player }, MaweDom: { mediaPlaybackRate: { options: [] }, mediaSeek: { value: '', max: '' }, mediaVolume: { value: '' } },
    MaweHost: { runtime: { getNavigator: () => ({ platform: 'Win32' }) } },
    scheduleAssSubtitlePreviewRefresh() {}, MaweSettings: makeDeepStub(),
    MaweTextCleanup: { cleanPunctuation() {} },
    Option: class {}, MawePreviewGeometry: makeDeepStub(), MaweTimeline: makeDeepStub(),
    MaweColors: makeDeepStub(), MaweDisplaySettings: makeDeepStub(),
    MaweStickerOverlay: makeDeepStub(), MaweStickerPicker: makeDeepStub(),
    MaweCueElements: makeDeepStub(), MaweShortcuts: makeDeepStub(),
    MaweTimeline: { timelineMediaSeekStepValue: () => 100, timelineIsFrameMode: () => false },
    MaweJklPlayback: { stopJklReversePlayback() {}, isJklDirectionMode: () => false },
    MaweCueListAnchor: { resumeCueListFollowing() {}, cueListScroll: {} },
    MaweHint: { flashHint() {} },
    MawePlaybackLoop: { update() {
      updates.push({ time: player.currentTime, audition: context.MaweMediaPlayback.isAuditioning });
      if (!context.MaweMediaPlayback.isAuditioning && !player.paused
          && player.currentTime >= 2 && player.currentTime < 4) player.currentTime = 4;
    } },
  };
  vm.runInNewContext(compileIsolatedEsmFixture('editor/media/editor-media-playback.js', context), context);
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
    MaweBoot: { DATA: {}, maweDomContractCheck: () => [], maweDebug() {} },
    MaweDom: makeFacadeStub(),
    MaweMultiSubtitleCore: { MULTI: 'main', getActiveExtensionTrack: () => ({ segments: [] }),
      getExtensionSubtitleSplitMode: () => 'word', getMainSubtitleSplitMode: () => 'word',
      getMultiSubtitleState: () => ({ enabled: false, tracks: [] }),
      normalizeMultiSubtitleState: (state) => state ?? { enabled: false, tracks: [] } },
    window: { addEventListener() {}, removeEventListener() {}, ASR_EDITOR_PALETTE: [{ name: 'yellow', value: '#123456' }],
      AsrEditorUtils: { defaultAssStyleLibrary: () => ({ styles: [], assProfiles: [] }) },
      AsrGapRemoveCore: { getGapPlaybackSkip(_ranges, _time, options) {
      captured = options; throw sentinel;
    } } },
    URLSearchParams: URLSearchParams,
    location: { search: '' },
    ASR_EDITOR_PALETTE: [{ name: 'yellow', value: '#123456' }],
    document: makeDocumentStub(),
    MaweCoreState: { player: { currentTime: 3, paused: false } },
    MaweHint: { flashHint() {} }, MaweDom: makeDeepStub(),
    MaweMultiSubtitleCore: makeDeepStub(), MaweSettings: makeDeepStub(),
    MaweCuePanelState: {},
    MaweGapRemoveData: { getGapRemoveData: () => ({ skip_playback: true }), getRemovedGapRanges: () => [] },
    MaweMediaPlayback: { get isAuditioning() { return auditioning; } },
    MaweHost: { runtime: { getNavigator: () => ({ platform: 'Win32' }) } },
    overlayTrackVisible: () => false, getOverlayTrack: () => null,
    overlayTrackTextEl: null, overlayTrackSpeakerLabelEl: null, overlayTrackTextNode: null,
    MULTI_SUBTITLE_UTILS: makeDeepStub(),
    restoreCssSubtitlePreview() {}, applyAssSubtitlePreview() {}, DEFAULT_ASS_COLOR_STYLE: {},
    MaweBoot: makeDeepStub(), MaweMultiSubtitleCore: makeDeepStub(), MaweSettings: makeDeepStub(),
    MaweInlineEdit: makeDeepStub(), MaweAppearance: makeDeepStub(),
    Option: class {}, MawePreviewGeometry: makeDeepStub(), MaweTimeline: makeDeepStub(),
    MaweColors: makeDeepStub(), MaweDisplaySettings: makeDeepStub(),
    MaweStickerOverlay: makeDeepStub(), MaweStickerPicker: makeDeepStub(),
    MaweCueElements: makeDeepStub(), MaweShortcuts: makeDeepStub(),
    MaweSpeakerLabels: makeDeepStub(), MaweCueListAnchor: makeDeepStub(),
    MaweCuePanel: makeDeepStub(), MaweHistory: makeDeepStub(),
  };
  vm.runInNewContext(compileIsolatedEsmFixture('editor/media/editor-playback-loop.js', context), context);
  context.window.AsrGapRemoveCore = { getGapPlaybackSkip(_ranges, _time, options) {
    captured = options; throw sentinel;
  } };
  context.AsrGapRemoveCore = context.window.AsrGapRemoveCore;
  for (const name of ['update', 'updatePlaybackFrame']) {
    for (const active of [true, false]) {
      auditioning = active;
      assert.throws(() => context.MawePlaybackLoop[name](), error => error === sentinel);
      assert.equal(captured.skipPlayback, !active);
    }
  }
});

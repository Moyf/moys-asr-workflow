import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createUtilsModule } from '../web/shared/utils/history.js';

const source = readFileSync(new URL('../web/editor/media/editor-audio-processing.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const clone = value => JSON.parse(JSON.stringify(value));
const result = (extra = {}) => ({ ok: true, status: 'measured', integratedLufs: -30, truePeakDbtp: -3,
  audioTrack: 0, measurementSource: 'preview', bindingGeneration: 1, sourceMediaId: 'source-a', ...extra });
const response = data => ({ ok: true, json: async () => data });
function fixture(transport = async () => response(result())) {
  const calls = [], routes = [], contexts = [], nodes = new Map(), observers = new Set();
  function node() {
    const listeners = new Map();
    return { textContent: '', hidden: false, value: '',
      addEventListener(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); },
      emit(name, options = {}) { for (const fn of listeners.get(name) || []) fn({ target: this, ...options }); } };
  }
  const player = Object.assign(node(), { currentSrc: 'http://localhost/media', volume: .6, muted: false });
  class AudioContext {
    state = 'suspended'; destination = {}; resumes = 0;
    constructor() { contexts.push(this); }
    async resume() { this.resumes++; this.state = 'running'; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createMediaElementSource(media) {
      const route = { player: media, connected: false, connect(gain) { this.connected = true; this.gain = gain; },
        disconnect() { this.connected = false; } };
      routes.push(route); return route;
    }
  }
  const context = vm.createContext({ URL, AbortController, DOMException, setTimeout, clearTimeout, AudioContext,
    location: { href: 'http://localhost/', origin: 'http://localhost' },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, addEventListener() {} },
    MaweBoot: { DATA: { segments: [] }, SERVER_CONFIG: { requestToken: 'token', bindingGeneration: 1, sourceMediaId: 'source-a' } },
    MaweCoreState: { player }, MaweProjectLoad: { projectBindingEpoch: 0 },
    MaweServerSave: { configureServerSaveControls() {}, scheduleAutoSave() {} },
    MaweHost: { server: { fetch(url, options) { const body = JSON.parse(options.body); calls.push({ url, body, signal: options.signal }); return transport(body); } } },
  });
  context.window = context;
  for (const path of ['boot/editor-runtime.js', 'state/editor-state.js']) {
    vm.runInContext(readFileSync(new URL('../web/editor/' + path, import.meta.url), 'utf8'), context);
  }
  context.AsrEditorUtils = createUtilsModule({ cloneJsonValue: clone });
  context.MaweWordTiming = { clearSelection() {} };
  context.MaweHint = { flashHint() {} };
  context.MaweInlineEdit = {};
  vm.runInContext(readFileSync(new URL('../web/editor/state/editor-history.js', import.meta.url), 'utf8'), context);
  vm.runInContext(source, context);
  context.MaweAudioProcessing.init();
  return { context, api: context.MaweAudioProcessing, state: context.MaweState, calls, routes, contexts, nodes, player, node };
}

test('fixed gain preserves listening volume, captures each player only once, and disconnects old routes', async () => {
  const f = fixture();
  await f.api.applyPreview();
  assert.equal(f.contexts.length, 0, 'unity gain does not take over native playback');
  f.api.change({ gain_db: 6 });
  assert.equal(f.routes.length, 0, 'a suspended context must not capture the element');
  await f.api.applyPreview({ gesture: true });
  assert.equal(f.routes.length, 1);
  assert.ok(Math.abs(f.routes[0].gain.gain.value - 10 ** .3) < 1e-10);
  assert.equal(f.player.volume, .6);
  f.api.change({ gain_db: -6 }, { gesture: true });
  await f.api.applyPreview({ gesture: true });
  assert.equal(f.routes.length, 1);
  const replacement = Object.assign(f.node(), { currentSrc: 'blob:http://localhost/new' });
  f.context.MaweCoreState.player = replacement;
  f.api.bindPlayer(replacement);
  assert.equal(f.routes[0].connected, false);
  await f.api.applyPreview({ gesture: true });
  assert.equal(f.routes.length, 2);
  assert.equal(f.contexts.length, 1);
  assert.ok(Math.abs(f.routes[1].gain.gain.value - 10 ** -.3) < 1e-10);
});

test('unsupported sources never create an irreversible silent media source', async () => {
  const f = fixture();
  for (const url of ['file:///C:/source.wav', 'https://other.example/source.mp3']) {
    f.player.currentSrc = url;
    f.api.change({ gain_db: 6 }, { gesture: true });
    await f.api.applyPreview({ gesture: true });
    assert.equal(f.routes.length, 0);
    assert.match(f.nodes.get('audio-gain-warning').textContent, /不支持增益预览/);
  }
});

test('normalization applies fixed peak-limited gain; manual gain remains unclamped by peaks', async () => {
  const f = fixture();
  await f.api.measure();
  assert.equal(f.api.normalizationGain(f.api.measurement), 2, 'peak headroom limits a requested +7 dB');
  f.api.normalizeToTarget();
  assert.equal(f.api.settings().gain_db, 2);
  assert.equal(f.nodes.get('audio-adjusted-lufs').textContent, '-28.0 LUFS');
  assert.match(f.nodes.get('audio-gain-warning').textContent, /无法达到参考响度/);
  f.api.change({ gain_db: 7 });
  assert.equal(f.api.settings().gain_db, 7);
  assert.match(f.nodes.get('audio-gain-warning').textContent, /可能削波/);
  assert.equal(f.api.normalizationGain(result({ integratedLufs: -5, truePeakDbtp: -2 }), -23), -18);
  assert.equal(f.api.normalizationGain(result({ integratedLufs: -100, truePeakDbtp: -90 }), -23), 24);
});

test('unmeasurable and malformed loudness never appear as zero LUFS or enable normalization', async () => {
  for (const data of [result({ status: 'silence', integratedLufs: null, truePeakDbtp: null }),
    result({ status: 'no_audio', integratedLufs: null, truePeakDbtp: null }), result({ integratedLufs: null }),
    result({ status: 'error', error: 'C:/private/path.wav' })]) {
    const f = fixture(async () => response(data));
    await f.api.measure();
    assert.equal(f.api.normalizationGain(f.api.measurement), null);
    assert.equal(f.nodes.get('audio-normalize').disabled, true);
    assert.equal(f.nodes.get('audio-original-lufs').textContent, '—');
    assert.doesNotMatch(f.nodes.get('audio-measurement-status').textContent, /private/);
  }
});

test('project switches abort analysis and ignore late responses, even if the transport ignores abort', async () => {
  const wait = deferred(), f = fixture(async () => { await wait.promise; return response(result()); });
  const pending = f.api.measure();
  f.state.beginProjectLoad();
  assert.equal(f.calls[0].signal.aborted, true);
  f.api.loadProject({ gain_db: -9 });
  wait.resolve(); await pending;
  assert.equal(f.api.measurement, null);
  assert.equal(f.api.settings().gain_db, -9);
  assert.equal(f.nodes.get('audio-original-lufs').textContent, '—');
});

test('force is sent once; a server binding mismatch and local replacement cannot reuse an old measurement', async () => {
  let count = 0;
  const f = fixture(async () => response(result({ status: ++count === 1 ? 'measuring' : 'measured' })));
  await f.api.measure({ force: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.force, true);
  assert.equal(f.calls[1].body.force, undefined);
  f.context.MaweBoot.SERVER_CONFIG.bindingGeneration++;
  f.api.render();
  assert.equal(f.api.measurement, null);
  f.player.currentSrc = 'blob:http://localhost/local';
  await f.api.measure();
  assert.equal(f.calls.length, 2);
  f.api.change({ gain_db: 3 });
  assert.equal(f.api.settings().gain_db, 3, 'portable gain remains available');
});

test('a binding change during measurement re-enables measurement and a late result cannot replace the new result', async () => {
  const wait = deferred();
  const f = fixture(async body => {
    if (body.bindingGeneration === 1) { await wait.promise; return response(result()); }
    return response(result({ bindingGeneration: 2, sourceMediaId: 'source-b', integratedLufs: -18 }));
  });
  const old = f.api.measure();
  f.context.MaweBoot.SERVER_CONFIG.bindingGeneration = 2;
  f.context.MaweBoot.SERVER_CONFIG.sourceMediaId = 'source-b';
  f.api.render();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.api.measurementState, 'idle');
  assert.equal(f.nodes.get('audio-measure').disabled, false);
  await f.api.measure();
  assert.equal(f.api.measurement.integratedLufs, -18);
  wait.resolve(); await old;
  assert.equal(f.api.measurement.integratedLufs, -18);
});

test('audio edits keep their own dirty flag, share undo history, and load/reset normalized project settings', () => {
  const f = fixture();
  f.api.change({ gain_db: -4 });
  assert.equal(f.state.hasProjectChanges(), true);
  f.state.noteSavedSegments(); f.state.reconcileSegmentsDirty();
  assert.equal(f.state.hasProjectChanges(), true, 'subtitle reconciliation must not discard audio dirtiness');
  f.state.markSaved();
  assert.equal(f.state.hasProjectChanges(), false);
  f.context.MaweHistory.performUndo();
  assert.equal(f.api.settings().gain_db, 0);
  assert.equal(f.state.hasProjectChanges(), true, 'undo after save changes persisted audio');
  f.context.MaweHistory.performRedo();
  assert.equal(f.api.settings().gain_db, -4);
  const saved = JSON.parse(JSON.stringify({ audio_processing: f.api.settings() }));
  f.api.loadProject(saved.audio_processing);
  assert.equal(f.api.settings().gain_db, -4);
  assert.equal(f.state.changes.audioProcessingDirty, false);
  f.api.loadProject(undefined);
  assert.deepEqual(clone(f.api.settings()), { gain_db: 0, target_lufs: -23, peak_ceiling_dbtp: -1 });
  assert.deepEqual(clone(f.api.normalize({ gain_db: 100, target_lufs: Infinity, peak_ceiling_dbtp: 10 })),
    { gain_db: 24, target_lufs: -23, peak_ceiling_dbtp: -1 });
});

test('one slider gesture creates one history entry', () => {
  const f = fixture(), slider = f.nodes.get('audio-gain');
  for (const gain of [-2, -4, -7]) { slider.value = String(gain); slider.emit('input'); }
  slider.emit('change'); slider.emit('blur');
  assert.equal(f.context.MaweHistory.editorHistory.undoLength(), 1);
  f.context.MaweHistory.performUndo();
  assert.equal(f.api.settings().gain_db, 0);
});

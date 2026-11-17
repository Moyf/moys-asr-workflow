import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { initModuleSource } from './helpers/init-module-source.mjs';

function fixture() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: true, dataset: {}, style: {}, textContent: '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, removeAttribute() {}, getAttribute() {},
      closest() { return this; }, querySelector() { return null; },
    });
    return elements.get(id);
  }
  const playerEvents = new Map();
  let frameCallback;
  const requestTimes = [];
  const player = { tagName: 'VIDEO', videoWidth: 640, currentTime: 0.5,
    currentSrc: 'http://localhost/media', paused: true, seeking: false,
    addEventListener(name, callback) { playerEvents.set(name, callback); },
    removeEventListener(name) { playerEvents.delete(name); },
    requestVideoFrameCallback(callback) { frameCallback = callback; } };
  let release, ready = false, panelOptions, open = false, requests = 0, builds = 0;
  const fonts = new Promise(resolve => { release = () => { ready = true; resolve(); }; });
  const settings = { assMode: true, assFrameAutoRender: false };
  const context = {
    URL, AbortController, console,
    document: { getElementById: element, addEventListener() {} },
    location: { href: 'http://localhost/', origin: 'http://localhost' },
    MaweCoreState: { player }, MaweDom: {},
    MaweBoot: { DATA: {}, SERVER_CONFIG: { assFrameUrl: '/api/ass-frame' } },
    MaweSettings: { EDITOR_SETTINGS: settings },
    MaweProjectLoad: { projectBindingEpoch: 1 },
    MaweExportSrt: { buildAss() { builds++; return '[Script Info]'; } },
    MaweAssFontAliases: { ensureCoverage: () => fonts, whenReady: () => fonts, pending: () => !ready },
    MaweFloatingPanel: { createFloatingPanel(options) {
      panelOptions = options;
      return { isOpen: () => open, open() { open = true; options.onOpen(); },
        close() { options.onClose?.(); open = false; }, toggle() {} };
    } },
    setTimeout() { return 1; }, clearTimeout() {},
    fetch: async (_url, options) => { requests++; requestTimes.push(JSON.parse(options.body).timeMs); return { ok: true, json: async () => ({ ok: true, image: 'image' }) }; },
    Image: class { naturalWidth = 640; naturalHeight = 360; async decode() {} },
  };
  context.window = context;
  vm.runInNewContext(initModuleSource('editor/styles/editor-wiring-ass-frame.js'), context);
  return { context, player, settings, release,
    open() { open = true; panelOptions.onOpen(); },
    close() { panelOptions.onClose?.(); open = false; },
    run: () => context.MaweAssFrame.renderAssFrame(),
    requests: () => requests, builds: () => builds, requestTimes,
    emit: name => playerEvents.get(name)?.(),
    present: seconds => frameCallback(0, { mediaTime: seconds }) };
}

test('manual ASS frame waits for fonts then captures when the original window remains open', async () => {
  const h = fixture(); h.open();
  const waiting = h.run();
  assert.equal(h.requests(), 0); assert.equal(h.builds(), 0);
  h.release(); await waiting;
  assert.equal(h.requests(), 1);
});

test('closing the window during font loading cancels the pending manual capture', async () => {
  const h = fixture(); h.open(); const waiting = h.run();
  h.close(); h.release(); await waiting;
  assert.equal(h.requests(), 0); assert.equal(h.builds(), 0);
});

test('closing then reopening does not revive the previous manual click', async () => {
  const h = fixture(); h.open(); const waiting = h.run();
  h.close(); h.open(); h.release(); await waiting;
  assert.equal(h.requests(), 0); assert.equal(h.builds(), 0);
  await h.run(); assert.equal(h.requests(), 1);
});

test('project switch during font loading does not capture the new project for an old click', async () => {
  const h = fixture(); h.open(); const waiting = h.run();
  h.context.MaweProjectLoad.projectBindingEpoch++;
  h.release(); await waiting;
  assert.equal(h.requests(), 0); assert.equal(h.builds(), 0);
});

test('player replacement during font loading invalidates the original frame request', async () => {
  const h = fixture(); h.open(); const waiting = h.run();
  const next = { ...h.player, currentSrc: 'http://localhost/media?new=1' };
  h.context.MaweCoreState.player = next;
  h.context.MaweAssFrame.bindPlayer(next);
  h.release(); await waiting;
  assert.equal(h.requests(), 0); assert.equal(h.builds(), 0);
});

test('repeated manual clicks while fonts load coalesce to the newest request', async () => {
  const h = fixture(); h.open(); const first = h.run(), second = h.run();
  h.release(); await Promise.all([first, second]);
  assert.equal(h.requests(), 1);
});

test('closing the panel cancels its old click even while stage overlay remains enabled', async () => {
  const h = fixture(); h.open(); const waiting = h.run();
  h.settings.assFrameAutoRender = true;
  h.settings.assFrameStagePreview = true;
  h.close(); h.release(); await waiting;
  assert.equal(h.requests(), 0); assert.equal(h.builds(), 0);
});

test('automatic reopening after close can start a fresh frame when fonts become ready', async () => {
  const h = fixture(); h.settings.assFrameAutoRender = true;
  h.open(); h.close(); h.open();
  h.release();
  // Flush promises from onOpen's fire-and-forget render and image decoding.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests(), 1);
});

// Drive event order directly: a browser timer cannot guarantee which video
// frame callbacks have run by the time pause is delivered.
test('pause retains the presented PTS when the playback cursor advances between callbacks', async () => {
  const h = fixture(); h.release(); h.open();
  h.player.paused = false; h.player.currentTime = 1.2; h.present(1.2);
  h.player.currentTime = 1.208905; h.player.paused = true; h.emit('pause');
  await h.run();
  assert.deepEqual(h.requestTimes, [1200]);
});

test('a frame callback queued after pause replaces the earlier presented PTS', async () => {
  const h = fixture(); h.release(); h.open();
  h.player.paused = false; h.player.currentTime = 1.2; h.present(1.2);
  h.player.currentTime = 1.208905; h.player.paused = true; h.emit('pause');
  await h.run();
  h.present(1.233333);
  await h.run();
  assert.deepEqual(h.requestTimes, [1200, 1233]);
});

test('a new seek position cannot reuse the previous frame PTS before its callback arrives', async () => {
  const h = fixture(); h.release(); h.open();
  h.player.currentTime = 1.2; h.present(1.2);
  h.player.currentTime = 2.01;
  await h.run();
  assert.deepEqual(h.requestTimes, [2010]);
});

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
  const player = { tagName: 'VIDEO', videoWidth: 640, currentTime: 0.5,
    currentSrc: 'http://localhost/media', paused: true, seeking: false,
    addEventListener() {}, removeEventListener() {} };
  let release, ready = false, panelOptions, open = false, requests = 0;
  const fonts = new Promise(resolve => { release = () => { ready = true; resolve(); }; });
  const context = {
    URL, AbortController, console,
    document: { getElementById: element, addEventListener() {} },
    location: { href: 'http://localhost/', origin: 'http://localhost' },
    MaweCoreState: { player }, MaweDom: {},
    MaweBoot: { DATA: {}, SERVER_CONFIG: { assFrameUrl: '/api/ass-frame' } },
    MaweSettings: { EDITOR_SETTINGS: { assMode: true, assFrameAutoRender: false } },
    MaweProjectLoad: { projectBindingEpoch: 1 },
    MaweExportSrt: { buildAss: () => '[Script Info]' },
    MaweAssFontAliases: { ensureCoverage: () => fonts, whenReady: () => fonts, pending: () => !ready },
    MaweFloatingPanel: { createFloatingPanel(options) {
      panelOptions = options;
      return { isOpen: () => open };
    } },
    setTimeout() { return 1; }, clearTimeout() {},
    fetch: async () => { requests++; return { ok: true, json: async () => ({ ok: true, image: 'image' }) }; },
    Image: class { naturalWidth = 640; naturalHeight = 360; async decode() {} },
  };
  context.window = context;
  vm.runInNewContext(initModuleSource('editor/styles/editor-wiring-ass-frame.js'), context);
  return { release, requests: () => requests,
    open() { open = true; panelOptions.onOpen(); },
    close() { panelOptions.onClose?.(); open = false; },
    switchProject() { context.MaweProjectLoad.projectBindingEpoch++; },
    render: () => context.MaweAssFrame.renderAssFrame() };
}

test('manual ASS frame waits for fonts then captures the current project', async () => {
  const h = fixture();
  h.open();
  const waiting = h.render();
  assert.equal(h.requests(), 0);
  h.release();
  await waiting;
  assert.equal(h.requests(), 1);
});

test('reopening the ASS frame panel does not revive an earlier capture', async () => {
  const h = fixture();
  h.open();
  const waiting = h.render();
  h.close();
  h.open();
  h.release();
  await waiting;
  assert.equal(h.requests(), 0);
  await h.render();
  assert.equal(h.requests(), 1);
});

test('switching projects during font loading cancels the old capture', async () => {
  const h = fixture();
  h.open();
  const waiting = h.render();
  h.switchProject();
  h.release();
  await waiting;
  assert.equal(h.requests(), 0);
});

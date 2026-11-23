import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  let now = 0, next = 0;
  const timers = new Map();
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.parentElement = null; this.className = ''; this.attributes = {}; this.textContent = ''; this.classList = { add: name => { this.className += ` ${name}`; } }; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    dispatch(name, event = {}) { return Promise.all((this.listeners[name] || []).map(fn => fn({ currentTarget: this, ...event }))); }
    querySelectorAll(selector) { return selector === '.hint-card' ? this.children.filter(c => c.className.includes('hint-card')) : []; }
    get firstElementChild() { return this.children[0]; }
  }
  const body = new Element('body');
  const allElements = element => [element, ...element.children.flatMap(allElements)];
  const document = { body, documentElement: {dataset: {}}, createElement: tag => new Element(tag), getElementById: id => body.children.find(c => c.id === id) || null,
    querySelectorAll: selector => selector === '.hint-burn-open'
      ? allElements(body).filter(element => element.className === 'hint-burn-open') : [] };
  const window = { document, performance: { now: () => now }, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window, document, performance: window.performance, console, Number, String,
    createConsoleMirrorModule: () => ({mirrorFeedback() {}}),
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const source = fs.readFileSync(process.env.MAW_TEST_HINT_SOURCE || 'web/editor/ui/editor-hint.js', 'utf8')
    .replace(/^import .*;\n/m, '').replace('export function initMaweHint()', 'function initMaweHint()');
  vm.runInContext(`${source}\ninitMaweHint();`, context);
  function advance(ms) { const target = now + ms; while (true) { const due = [...timers].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = due[1].at; timers.delete(due[0]); due[1].fn(); } now = target; }
  return { hint: window.MaweHint, advance, body, window, context, document };
}

test('hover and keyboard focus pause the remaining lifetime independently', () => {
  const { hint, advance } = fixture();
  const card = hint.flashHint('timed', 'success', {durationMs: 1000});
  advance(400); card.dispatch('mouseenter'); advance(3000);
  assert.equal(card.dataset.dismissed, undefined);
  card.dispatch('focusin'); card.dispatch('mouseleave'); advance(3000);
  assert.equal(card.dataset.dismissed, undefined);
  card.dispatch('focusout', {relatedTarget: null}); advance(599);
  assert.equal(card.dataset.dismissed, undefined);
  advance(1); assert.equal(card.dataset.dismissed, '1');
});

test('persistent cards survive unrelated messages and close independently', () => {
  const { hint, advance } = fixture();
  const error = hint.flashHint('failure', 'warning', {durationMs: 0, dismissible: true});
  const success = hint.flashHint('success', 'success', {durationMs: 0, dismissible: true, position: 'bottom-right'});
  for (let i = 0; i < 6; i++) hint.flashHint(`ordinary ${i}`, 'info');
  advance(5000);
  assert.ok(error.parentElement); assert.ok(success.parentElement);
  const close = error.children.find(c => c.tagName === 'button');
  assert.ok(close); close.dispatch('click'); advance(200);
  assert.equal(error.parentElement, null); assert.ok(success.parentElement);
});

test('burn failure exposes attempts including an empty stderr, and copies only the shareable report', async () => {
  const f = fixture();
  let copied;
  Object.assign(f.context, {MaweHint: f.hint, MaweBoot: {SERVER_CONFIG: {burnVideoAppVersion: '1.11.4'}},
    navigator: {clipboard: {writeText: async text => { copied = text; }}}});
  vm.runInContext(fs.readFileSync(process.env.MAW_TEST_BURN_SOURCE || 'web/editor/io/editor-wiring-burn-video.js', 'utf8'), f.context);
  const attempts = [
    {encoder: 'nvenc', exitCode: 7, elapsedMs: 20, stderrPresent: true, reasons: ['cannot load nvcuda.dll']},
    {encoder: 'cpu', exitCode: 1, elapsedMs: 45, stderrPresent: false},
  ];
  const diagnostic = {mode: 'full', ffmpegVersion: '8.0', encoder: 'cpu', attempts,
    failure: {stage: 'burning', type: 'BurnVideoExportError'}};
  assert.match(f.context.burnProgressText({stage: 'burning', burnDiagnostic: diagnostic}), /换编码器.*CPU/);
  const card = f.context.showBurnVideoFailure(new Error('token=not-for-copy'), {stage: 'status', jobId: 'job123', diagnostic});
  assert.match(card.children[0].textContent, /烧录编码/);
  assert.equal(card.children[2].children[0].textContent, '查看诊断详情');
  await card.children[1].children[0].dispatch('click');
  assert.match(copied, /job123/);
  assert.match(copied, /nvenc.*退出码: 7/);
  assert.match(copied, /cpu.*退出码: 1\nFFmpeg 未输出错误详情/);
  assert.doesNotMatch(copied, /not-for-copy/);
});

test('burn admission and native save distinguish lost connections from file failures', async () => {
  const f = fixture();
  Object.assign(f.context, {MaweHint: f.hint, MaweBoot: {SERVER_CONFIG: {}},
    MaweHost: {server: {fetch: async () => { throw new TypeError('Failed to fetch'); }}}});
  vm.runInContext(fs.readFileSync('web/editor/io/editor-wiring-burn-video.js', 'utf8'), f.context);
  for (const [stage, request, code, message] of [
    ['admission', () => f.context.burnFetch('/jobs', {}), 'local-connection', /连接中断/],
    ['write', () => f.context.nativeBurnPost('/jobs/job/native-save', 'token', {}), 'native-write-unconfirmed', /无法确认保存结果/],
  ]) {
    await assert.rejects(request, error => {
      assert.equal(error.code, code);
      const card = f.context.showBurnVideoFailure(error, {stage, mode: 'full'});
      assert.match(card.children[0].textContent, message);
      assert.ok(card.children[2].children[1].textContent.includes(code));
      return true;
    });
  }
});

test('burn diagnostics preserve known subtitle and session guidance without copying raw exceptions', () => {
  const f = fixture();
  Object.assign(f.context, {MaweHint: f.hint, MaweBoot: {SERVER_CONFIG: {}}});
  vm.runInContext(fs.readFileSync(process.env.MAW_TEST_BURN_SOURCE || 'web/editor/io/editor-wiring-burn-video.js', 'utf8'), f.context);
  const layoutError = Object.assign(new Error('请将字距改为非负值后导出'), {code: 'ass-negative-spacing'});
  const layout = f.context.showBurnVideoFailure(layoutError, {stage: 'subtitles', mode: 'full'});
  assert.match(layout.children[0].textContent, /字距改为非负值/);
  assert.match(layout.children[2].children[1].textContent, /ass-negative-spacing/);
  const unknown = f.context.showBurnVideoFailure(new Error('arbitrary subtitle data'), {stage: 'subtitles', mode: 'full'});
  assert.doesNotMatch(unknown.children[0].textContent + unknown.children[2].children[1].textContent, /arbitrary subtitle data/);
  const sessionError = f.context.burnResponseError('启动器编辑器会话无效，请从启动器重新打开', 403, 'burn-authorization');
  const session = f.context.showBurnVideoFailure(sessionError, {stage: 'admission', mode: 'full'});
  assert.match(session.children[0].textContent, /请从启动器重新打开/);
  assert.match(session.children[2].children[1].textContent, /burn-authorization/);
});

for (const phase of ['download', 'write']) {
  test(`burn pipeline labels ${phase} errors after successful encoding`, async () => {
    const f = fixture();
    const config = {canBurnVideoExport: true, burnVideoJobsUrl: '/jobs', requestToken: 'fixture',
      bindingGeneration: 1, sourceMediaId: 'source', burnVideoSourceName: 'source.mp4'};
    const state = {state: 'ready', jobId: 'job123', bindingGeneration: 1, sourceMediaId: 'source'};
    Object.assign(f.window, {MaweProjectLoad: {projectBindingEpoch: 1}, MaweCoreState: {player: {currentSrc: 'http://localhost/media'}}});
    Object.assign(f.context, {MaweHint: f.hint, MaweBoot: {SERVER_CONFIG: config}, MaweInlineEdit: {},
      MaweSettings: {EDITOR_SETTINGS: {assMode: false}}, location: {href: 'http://localhost/', origin: 'http://localhost'},
      URL, Uint8Array, AbortController, crypto: {getRandomValues: value => value},
      MaweHost: {
        files: {hasSavePicker: () => true, pickSaveFile: async () => ({
          name: 'result.mp4', createWritable: async () => ({write: async () => {},
            close: async () => { throw Object.assign(new Error('private-save-location'), {name: 'QuotaExceededError'}); },
            abort: async () => {}}),
        })},
        server: {fetch: async (url) => {
          if (url === '/jobs') return {ok: true, json: async () => state};
          if (url.endsWith('/cancel')) return {ok: true, json: async () => ({state: 'cancelled', cleanupComplete: true})};
          let read = false;
          return {ok: true, headers: {get: name => name === 'Content-Type' ? 'video/mp4' : '1'},
            body: {getReader: () => ({read: async () => {
              if (phase === 'download') throw new TypeError('network error');
              return read ? {done: true} : (read = true, {done: false, value: new Uint8Array([1])});
            }, releaseLock() {}, cancel: async () => {}})}};
        }},
      },
    });
    vm.runInContext(fs.readFileSync(process.env.MAW_TEST_BURN_SOURCE || 'web/editor/io/editor-wiring-burn-video.js', 'utf8'), f.context);
    await f.context.runBurnVideoJob({button: f.document.createElement('button'), label: 'burn',
      suggestedName: 'result.mp4', startHint: 'start', successText: 'saved', buildRequest: () => ({srt: 'test'})});
    const card = f.body.children.find(c => c.id === 'hint-stack').children.find(c => c.className.includes('hint-warning'));
    assert.match(card.children[0].textContent, phase === 'download' ? /下载视频.*传输中断/ : /写入文件.*磁盘空间/);
    assert.doesNotMatch(card.children[2].children[1].textContent, /private-save-location/);
  });
}

test('real burn flow retains independent errors and successes across consecutive jobs', async () => {
  const f = fixture();
  let failing = true;
  let saved = 0;
  const config = { canBurnVideoExport: true, burnVideoJobsUrl: '/jobs', requestToken: 'fixture',
    bindingGeneration: 1, sourceMediaId: 'source', burnVideoSourceName: 'source.mp4' };
  const host = { files: { hasSavePicker: () => true, pickSaveFile: async () => ({name: 'result.mp4',
    createWritable: async () => ({write: async () => {}, close: async () => { saved++; }, abort: async () => {}})}) },
    server: {fetch: async (url, opts = {}) => {
      const reply = (data, ok = true) => ({ok, status: ok ? 200 : 500, json: async () => data});
      if (url.endsWith('/cancel')) return reply({state: 'cancelled', cleanupComplete: true});
      if (opts.method === 'POST') return failing ? reply({error: 'failed'}, false)
        : reply({jobId: '1', state: 'ready', bindingGeneration: 1, sourceMediaId: 'source'});
      if (url.endsWith('/download')) return {ok: true, headers: {get: name => name === 'Content-Type' ? 'video/mp4' : '1'},
        body: {getReader: () => { let read = false; return {read: async () => read ? {done: true} : (read = true, {done: false, value: new Uint8Array([1])}), releaseLock() {}}; }}};
      return reply({state: 'completed', cleanupComplete: true});
    }} };
  Object.assign(f.window, {MaweProjectLoad: {projectBindingEpoch: 1}, MaweCoreState: {player: {currentSrc: 'http://localhost/media'}}});
  Object.assign(f.context, { MaweHint: f.hint, MaweBoot: {SERVER_CONFIG: config}, MaweInlineEdit: {},
    MaweHost: host, MaweSettings: {EDITOR_SETTINGS: {assMode: false}}, location: {href: 'http://localhost/', origin: 'http://localhost'},
    URL, Uint8Array, AbortController, crypto: {getRandomValues: value => value},
  });
  const source = fs.readFileSync(process.env.MAW_TEST_BURN_SOURCE || 'web/editor/io/editor-wiring-burn-video.js', 'utf8');
  vm.runInContext(source, f.context);
  const button = f.document.createElement('button');
  const options = {button, label: 'burn', suggestedName: 'result.mp4', startHint: 'start', successText: 'saved', buildRequest: () => ({srt: 'test'})};
  await f.context.runBurnVideoJob(options);
  const normal = f.body.children.find(c => c.id === 'hint-stack');
  const error = normal.children.find(c => c.className.includes('hint-warning'));
  assert.ok(error); assert.equal(error.dataset.persistent, '1');
  failing = false;
  await f.context.runBurnVideoJob(options);
  await f.context.runBurnVideoJob(options);
  assert.equal(saved, 2);
  const successes = f.body.children.find(c => c.id === 'hint-stack-bottom-right');
  assert.equal(successes.children.length, 2);
  for (let i = 0; i < 5; i++) f.hint.flashHint(`message ${i}`);
  f.advance(3000);
  assert.ok(error.parentElement); assert.equal(successes.children.length, 2);
  const actions = successes.children[0].children.find(c => c.className === 'hint-burn-actions');
  assert.equal(actions.children.length, 1);
  assert.match(successes.children[0].children[1].textContent, /无法直接打开/);
  assert.equal(actions.children[0].textContent, '关闭');
  actions.children[0].dispatch('click'); f.advance(200);
  assert.equal(successes.children.length, 1); assert.ok(error.parentElement);
  error.children.find(c => c.tagName === 'button').dispatch('click'); f.advance(200);
  assert.equal(error.parentElement, null); assert.equal(successes.children.length, 1);
});

test('Launcher burn uses a task-scoped native destination and opens only a saved result', async () => {
  const f = fixture();
  const config = {canBurnVideoExport: true, nativeBurnAvailable: true, burnVideoJobsUrl: '/jobs',
    requestToken: 'editor', bindingGeneration: 1, sourceMediaId: 'media', burnVideoSourceName: 'source.mp4'};
  const calls = [];
  const reply = data => ({ok: true, json: async () => data});
  let openError = null;
  let grantRemoved = false;
  let cancelPicker = false;
  const pickerHint = '请稍等片刻，在 Launcher 的文件选择器中选择保存路径。';
  const normalHints = () => f.body.children.find(c => c.id === 'hint-stack')?.children || [];
  Object.assign(f.window, {
    location: {hash: '#maw-burn-host=grant', pathname: '/', search: '?lang=en'},
    MAWE_I18N: {language: 'en', translateText: text => text},
    history: {state: null, replaceState: () => { grantRemoved = true; }},
    sessionStorage: {getItem: () => null, setItem() {}},
    MaweProjectLoad: {projectBindingEpoch: 1}, MaweCoreState: {player: {currentSrc: 'http://localhost/media'}},
  });
  Object.assign(f.context, {MaweHint: f.hint, MaweBoot: {SERVER_CONFIG: config}, MaweInlineEdit: {},
    MaweSettings: {EDITOR_SETTINGS: {assMode: false}}, location: {href: 'http://localhost/', origin: 'http://localhost'},
    URL, Uint8Array, AbortController, crypto: {getRandomValues: value => value},
    MaweHost: {
      files: {hasSavePicker: () => false, pickSaveFile: () => assert.fail('browser picker called')},
      server: {fetch: async (url, options) => {
        calls.push([url, options.body ? JSON.parse(options.body) : null]);
        if (url.endsWith('/native-session')) return reply({nativeSession: 'session'});
        if (url.endsWith('/native-target')) {
          assert.ok(normalHints().some(card => card.textContent === pickerHint && card.dataset.persistent === '1'));
          assert.ok(!normalHints().some(card => card.textContent === 'start'));
          return reply(cancelPicker ? {cancelled: true} : {nativeTarget: 'opaque', name: 'source.mp4'});
        }
        if (url === '/jobs') return reply({jobId: 'job', state: 'ready', bindingGeneration: 1, sourceMediaId: 'media'});
        if (url.endsWith('/native-save')) return reply({name: 'source.mp4', syncWarning: true});
        if (url.endsWith('/native-open')) return openError || reply({openRequested: true});
        assert.equal(url, '/jobs/job');
        return reply({state: 'completed', cleanupComplete: true});
      }},
    },
  });
  vm.runInContext(fs.readFileSync('web/editor/io/editor-wiring-burn-video.js', 'utf8'), f.context);
  const button = f.document.createElement('button');
  const options = {button, label: 'burn', suggestedName: 'result.mp4',
    startHint: 'start', successText: 'saved', buildRequest: () => ({srt: 'test'})};
  cancelPicker = true;
  await f.context.runBurnVideoJob(options);
  f.advance(200);
  assert.ok(!normalHints().some(card => card.textContent === pickerHint || card.textContent === 'start'));
  assert.deepEqual(calls.map(([url]) => url), ['/jobs/native-session', '/jobs/native-target']);
  calls.splice(1);
  cancelPicker = false;
  await f.context.runBurnVideoJob(options);
  f.advance(200);
  assert.ok(!normalHints().some(card => card.textContent === pickerHint));
  assert.ok(normalHints().some(card => card.textContent === 'start'));
  assert.equal(grantRemoved, true);
  assert.deepEqual(calls.map(([url]) => url), ['/jobs/native-session', '/jobs/native-target', '/jobs', '/jobs/job/native-save', '/jobs/job']);
  const [_, choose, admission] = calls;
  assert.equal(choose[1].nativeSession, 'session');
  assert.equal(choose[1].language, 'en');
  assert.equal(admission[1].nativeTarget, 'opaque');
  assert.equal(admission[1].admissionToken, choose[1].admissionToken);
  const card = f.body.children.find(c => c.id === 'hint-stack-bottom-right').children[0];
  assert.match(card.children.find(c => c.className === 'hint-burn-detail').textContent, /无法确认.*同步到磁盘/);
  const actions = card.children.find(c => c.className === 'hint-burn-actions');
  assert.deepEqual(actions.children.map(c => c.textContent), ['打开文件', '打开文件夹', '关闭']);
  f.window.MaweBurnVideoExport.invalidateBinding();
  assert.ok(actions.children.slice(0, 2).every(button => !button.disabled));
  await actions.children[0].dispatch('click');
  await actions.children[1].dispatch('click');
  assert.deepEqual(calls.slice(-2), [
    ['/jobs/job/native-open', {requestToken: 'editor', nativeSession: 'session', folder: false}],
    ['/jobs/job/native-open', {requestToken: 'editor', nativeSession: 'session', folder: true}],
  ]);
  const hints = f.body.children.find(c => c.id === 'hint-stack');
  assert.match(hints.children.at(-1).textContent,
    /已向系统发出打开请求/);
  openError = {ok: false, status: 503, json: async () => ({error: '无法向系统发出打开请求'})};
  await actions.children[0].dispatch('click');
  assert.equal(actions.children[0].disabled, false);
  assert.match(hints.children.at(-1).textContent, /无法向系统发出打开请求/);
  f.context.showBurnVideoSuccess('saved', 'another.mp4', async () => ({openRequested: true}));
  openError = {ok: false, status: 410, json: async () => ({code: 'burn_open_expired', error: 'expired'})};
  await actions.children[0].dispatch('click');
  assert.deepEqual(actions.children.map(c => c.disabled), [true, true, undefined]);
  assert.match(actions.parentElement.children[0].textContent, /打开操作已过期.*保存位置/);
  const otherActions = actions.parentElement.parentElement.children[1].children[1];
  assert.deepEqual(otherActions.children.map(c => c.disabled), [undefined, undefined, undefined]);
});

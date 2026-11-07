import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { TextDecoder, TextEncoder } from 'node:util';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';

// Greptile #347 A 组回归测试：AI 文本任务的前端契约与状态机。
// 夹具在无 DOM 的 vm 里装配真实 AsrEditorUtils + 忠实转接的
// MaweMultiSubtitleCore 适配层（绑定语义与 web/editor/state 源码一致），
// 断言对象是修复后的行为；每条测试注明对应的 finding 编号。

const aiTasksSource = fs.readFileSync(new URL('../web/editor/ai/editor-ai-tasks.js', import.meta.url), 'utf8');
const aiTextTasksSource = fs.readFileSync(new URL('../web/editor/ai/editor-ai-text-tasks.js', import.meta.url), 'utf8');
const aiSettingsSource = fs.readFileSync(new URL('../web/editor/ai/editor-ai-settings.js', import.meta.url), 'utf8');

function flush() {
  // 两次 setImmediate：让 vm 内的 async fetch/poll 链走完
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

function makeSegment(id, text, start, end) {
  return { id, text, start, end };
}

function makeProject(segments) {
  const project = {
    schema: 2,
    tracks: [{ id: 'track-main', role: 'main', name: '主字幕', enabled: true, language: 'zh', segments }],
    bilingual: { enabled: false, active_track_id: null },
    bindings: [],
  };
  // 编辑器把 DATA.segments 当主轨工作数组，与 tracks 里的主轨是同一引用
  project.segments = segments;
  return project;
}

// MaweMultiSubtitleCore 适配层：逐行转接 editor-multi-subtitle-core.js 的
// 对应实现，绑定语义全部落在真实 AsrEditorUtils 上。
function createCoreAdapters(win) {
  const utils = win.AsrEditorUtils;
  const core = {
    getMultiSubtitleState: () => win.MaweBoot.DATA,
    ensureEmptyExtensionTrack: (project = win.MaweBoot.DATA) => utils.ensureExtensionTrack(project),
    getActiveExtensionTrack: () => utils.getExtensionTrack(win.MaweBoot.DATA, win.MaweBoot.DATA.bilingual?.active_track_id),
    addSubtitleBinding(mainSegment, extensionSegment, track = core.getActiveExtensionTrack()) {
      if (!mainSegment || !extensionSegment || !track) return null;
      const multi = core.getMultiSubtitleState();
      utils.removeSubtitleBindings(multi, (binding) =>
        (binding.target?.track_id === track.id && binding.source?.segment_id === mainSegment.id)
        || binding.target?.segment_id === extensionSegment.id);
      const binding = utils.buildSubtitleBinding(mainSegment, extensionSegment, track.id, null, utils.getMainTrack(win.MaweBoot.DATA).id, multi.bindings);
      multi.bindings.push(binding);
      track.enabled = true;
      utils.rebuildBindingOffsets(multi, utils.getMainTrack(win.MaweBoot.DATA).segments);
      return binding;
    },
    markMainSegmentsDirty(segments = utils.getMainTrack(win.MaweBoot.DATA).segments) {
      let marked = false;
      (Array.isArray(segments) ? segments : []).forEach((segment) => {
        if (segment) {
          segment._dirty = true;
          marked = true;
        }
      });
      if (marked) win.MaweState.markProjectDirty();
    },
    markMultiSubtitleDirty() {
      const multi = core.getMultiSubtitleState();
      utils.getTracksByRole(multi, 'secondary').forEach((track) => track.segments.forEach((segment) => { segment._dirty = true; }));
    },
  };
  return core;
}

function createContext({ elements = {} } = {}) {
  const context = { TextDecoder, TextEncoder, Uint8Array };
  context.window = context; // 与浏览器一致：window 即全局对象
  const state = { hints: [], timers: [], responses: [], fetches: [], beginCalls: [] };
  context.document = { getElementById: (id) => elements[id] || null };
  context.MaweState = { markProjectDirty() {} };
  context.MaweSettings = { EDITOR_SETTINGS: {} };
  context.MaweHistory = { updateUndoRedoButtons() {} };
  context.MaweCommands = { run(label, fn) { fn({ commit() {} }); } };
  context.MaweHint = {
    flashHint(message, tone) { state.hints.push({ message, tone }); },
  };
  context.setInterval = (fn) => { state.timers.push(fn); return state.timers.length; };
  context.clearInterval = () => {};
  context.setTimeout = () => 0;
  context.clearTimeout = () => {};
  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  context.MaweAiSettings = { ensureServerAvailable() {}, serverAvailable: () => true };
  loadEditorModule(context, 'shared/editor-utils.js');
  const win = context.window;
  win.MaweBoot = {
    DATA: makeProject([]),
    SERVER_CONFIG: { requestToken: 'test-token', sourceMediaId: 'media-1', bindingGeneration: 3 },
  };
  // host 夹具会注入真实网络层的 MaweHost：模块加载完成后用桩覆盖
  context.MaweHost = {
    storage: { getItem: () => null, setItem() {} },
    server: {
      fetch: async (url, options = {}) => {
        state.fetches.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
        const entry = state.responses.shift();
        if (!entry) throw new Error(`未预期的请求：${options.method || 'GET'} ${url}`);
        if (entry.deferred) return entry.promise;
        return respond(entry.status ?? 200, entry.body);
      },
    },
  };
  win.MaweMultiSubtitleCore = createCoreAdapters(win);
  vm.runInNewContext(aiTasksSource, context, { filename: 'editor-ai-tasks.js' });
  vm.runInNewContext(aiTextTasksSource, context, { filename: 'editor-ai-text-tasks.js' });
  vm.runInNewContext(aiSettingsSource, context, { filename: 'editor-ai-settings.js' });
  return { win, state };
}

function enableBilingual(win) {
  const project = win.MaweBoot.DATA;
  const track = win.MaweMultiSubtitleCore.ensureEmptyExtensionTrack(project);
  project.bilingual.active_track_id = track.id;
  track.enabled = true;
  return track;
}

// 让 begin 挂起，测试在任务期间改动工程状态后手动放行结果
function stubDeferredBegin(win, state) {
  let resolveBegin;
  const gate = new Promise((resolve) => { resolveBegin = resolve; });
  win.MaweAiTasks = {
    begin: async (...args) => {
      state.beginCalls.push(args);
      return gate;
    },
  };
  return resolveBegin;
}

test('begin 接受服务端 {ok, task} 包络并轮询到结果（#1 契约）', async () => {
  const { win, state } = createContext();
  state.responses.push(
    { body: { ok: true, task: { id: 'task-1', kind: 'ai-bold', status: 'queued', stage: 'queued', percent: 0 } } },
    { body: { ok: true, tasks: [{ id: 'task-1', status: 'running', stage: 'waiting_provider', percent: 12 }] } },
    { body: { ok: true, tasks: [{ id: 'task-1', status: 'done', stage: 'done', percent: 100, result: { texts: { a: 'b' } } }] } },
  );
  const promise = win.MaweAiTasks.begin('ai-bold', { cues: [] }, 'AI 加粗关键词');
  await flush();
  state.timers.at(-1)();
  await flush();
  state.timers.at(-1)();
  await flush();
  assert.deepEqual(await promise, { texts: { a: 'b' } });
});

test('未开启双语时翻译任务在命令内自动建副轨写入（#2）', async () => {
  const { win, state } = createContext();
  win.MaweBoot.DATA = makeProject([makeSegment('seg-1', '你好世界', 0, 1200)]);
  win.MaweAiTasks = { begin: async () => ({ texts: { 'seg-1': 'Hello world' } }) };
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  await flush();
  const project = win.MaweBoot.DATA;
  const secondary = win.AsrEditorUtils.getTracksByRole(project, 'secondary');
  assert.equal(secondary.length, 1);
  const track = secondary[0];
  assert.equal(project.bilingual.active_track_id, track.id);
  assert.equal(track.enabled, true);
  assert.equal(track.segments.length, 1);
  assert.equal(track.segments[0].text, 'Hello world');
  assert.equal(track.segments[0].start, 0);
  assert.equal(track.segments[0].end, 1200);
  assert.ok(track.segments[0].id);
  assert.equal(project.bindings.length, 1);
  assert.equal(project.bindings[0].source.segment_id, 'seg-1');
  assert.equal(project.bindings[0].target.segment_id, track.segments[0].id);
  assert.ok(state.hints.some(({ message }) => message.includes('已自动开启双语字幕')));
});

test('已绑定多条副字幕的主字幕跳过且不拆散原组（#3）', async () => {
  const { win, state } = createContext();
  const segments = [makeSegment('seg-1', '你好世界', 0, 1200)];
  win.MaweBoot.DATA = makeProject(segments);
  const track = enableBilingual(win);
  const extA = { id: 'ext-a', start: 0, end: 1200, text: '旧译文A' };
  const extB = { id: 'ext-b', start: 1200, end: 2400, text: '旧译文B' };
  track.segments.push(extA, extB);
  // 1→N 分组在 v2 里是同源多条绑定
  win.MaweMultiSubtitleCore.addSubtitleBinding(segments[0], extA, track);
  win.MaweBoot.DATA.bindings.push(win.AsrEditorUtils.buildSubtitleBinding(
    segments[0], extB, track.id, null, 'track-main', win.MaweBoot.DATA.bindings,
  ));
  assert.equal(win.MaweBoot.DATA.bindings.length, 2);
  win.MaweAiTasks = { begin: async () => ({ texts: { 'seg-1': 'Hello' } }) };
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  await flush();
  assert.equal(track.segments.length, 2);
  assert.equal(extA.text, '旧译文A');
  assert.equal(extB.text, '旧译文B');
  assert.equal(win.MaweBoot.DATA.bindings.length, 2);
  assert.ok(state.hints.some(({ message }) => message.includes('1 条绑定多条副字幕')));
});

test('文本回写按稳定 id 定位，任务期间删行不错位（#4）', async () => {
  const { win, state } = createContext();
  const segments = [makeSegment('seg-a', 'same text', 0, 1000), makeSegment('seg-b', 'same text', 1000, 2000)];
  win.MaweBoot.DATA = makeProject(segments);
  const resolveBegin = stubDeferredBegin(win, state);
  win.MaweAiTextTasks.runTextTask('ai-bold', [1]);
  await flush();
  segments.shift(); // 任务期间删除了第一行：seg-b 从下标 1 变成 0
  resolveBegin({ texts: { 'seg-b': '**same text**' } });
  await flush();
  assert.equal(segments.length, 1);
  assert.equal(segments[0].id, 'seg-b');
  assert.equal(segments[0].text, '**same text**');
});

test('工程或媒体切换后丢弃 AI 文本结果并提示（#4）', async () => {
  const { win, state } = createContext();
  const segments = [makeSegment('seg-a', '你好世界', 0, 1000)];
  win.MaweBoot.DATA = makeProject(segments);
  const resolveBegin = stubDeferredBegin(win, state);
  win.MaweAiTextTasks.runTextTask('ai-bold', [0]);
  await flush();
  win.MaweBoot.SERVER_CONFIG.sourceMediaId = 'media-2'; // 任务期间切换了工程/媒体
  resolveBegin({ texts: { 'seg-a': '**你好世界**' } });
  await flush();
  assert.equal(segments[0].text, '你好世界');
  assert.ok(state.hints.some(({ message }) => message.includes('已丢弃本次 AI 结果')));
});

test('副字幕在任务期间被人工修改时跳过不覆盖（#5）', async () => {
  const { win, state } = createContext();
  const segments = [makeSegment('seg-1', '你好世界', 0, 1200)];
  win.MaweBoot.DATA = makeProject(segments);
  const track = enableBilingual(win);
  const extA = { id: 'ext-a', start: 0, end: 1200, text: '初版译文' };
  track.segments.push(extA);
  win.MaweMultiSubtitleCore.addSubtitleBinding(segments[0], extA, track);
  const resolveBegin = stubDeferredBegin(win, state);
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  await flush();
  extA.text = '人工翻译'; // 任务期间人工改了副字幕
  resolveBegin({ texts: { 'seg-1': 'AI 译文' } });
  await flush();
  assert.equal(extA.text, '人工翻译');
  assert.equal(track.segments.length, 1);
  assert.equal(win.MaweBoot.DATA.bindings.length, 1);
  assert.ok(state.hints.some(({ message }) => message.includes('1 条副字幕在任务期间被修改')));
});

test('双语关闭但副轨仍在时更新译文并重新启用副轨（#2 边界）', async () => {
  const { win, state } = createContext();
  const segments = [makeSegment('seg-1', '你好世界', 0, 1200)];
  win.MaweBoot.DATA = makeProject(segments);
  const track = enableBilingual(win);
  const extA = { id: 'ext-a', start: 0, end: 1200, text: '旧译文' };
  track.segments.push(extA);
  win.MaweMultiSubtitleCore.addSubtitleBinding(segments[0], extA, track);
  track.enabled = false; // 用户关闭双语：隐藏副轨但保留内容与绑定
  win.MaweAiTasks = { begin: async () => ({ texts: { 'seg-1': 'AI 译文' } }) };
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  await flush();
  assert.equal(track.enabled, true); // 提示声称自动开启，必须真的开启
  assert.equal(extA.text, 'AI 译文');
  assert.equal(track.segments.length, 1);
  assert.equal(win.MaweBoot.DATA.bindings.length, 1);
  assert.ok(state.hints.some(({ message }) => message.includes('已自动开启双语字幕')));
});

test('轮询迟到响应不会终结或污染新任务（#6）', async () => {
  const { win, state } = createContext();
  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  let releaseHeld;
  const held = {
    deferred: true,
    promise: new Promise((resolve) => {
      releaseHeld = () => resolve(respond(200, {
        ok: true,
        tasks: [{ id: 'task-a', status: 'done', stage: 'done', percent: 100, result: { marker: 'A' } }],
      }));
    }),
  };
  state.responses.push(
    { body: { ok: true, task: { id: 'task-a', kind: 'ai-bold', status: 'queued', stage: 'queued', percent: 0 } } },
    held,
    // 第二轮 tick 看到 cancelled：A 在迟到响应之前就已终结
    { body: { ok: true, tasks: [{ id: 'task-a', status: 'cancelled', stage: 'cancelled', percent: 0 }] } },
    { body: { ok: true, task: { id: 'task-b', kind: 'ai-bold', status: 'queued', stage: 'queued', percent: 0 } } },
    { body: { ok: true, tasks: [{ id: 'task-b', status: 'done', stage: 'done', percent: 100, result: { marker: 'B' } }] } },
  );
  const promiseA = win.MaweAiTasks.begin('ai-bold', {}, '任务A');
  promiseA.catch(() => {}); // 取消路径的 rejection 已预期
  await flush();
  state.timers.at(-1)(); // 第一轮 tick：GET 挂起
  await flush();
  state.timers.at(-1)(); // 第二轮 tick：读到 cancelled，A 终结
  await flush();
  const promiseB = win.MaweAiTasks.begin('ai-bold', {}, '任务B');
  await flush();
  releaseHeld(); // 释放 A 的迟到 done 响应
  await flush();
  assert.equal(win.MaweAiTasks.active?.id ?? null, 'task-b');
  state.timers.at(-1)(); // B 自己的下一轮 tick
  await flush();
  assert.deepEqual(await promiseB, { marker: 'B' });
});

test('切换供应商时清空未提交的密钥输入（#8）', async () => {
  const keyInput = { value: '' };
  const providerSelect = { value: 'provider-b' };
  const { win, state } = createContext({
    elements: { 'ai-api-key-input': keyInput, 'ai-provider-select': providerSelect },
  });
  state.responses.push({ body: { ok: true, providerId: 'provider-a', providers: [
    { id: 'provider-a', label: 'A', hasApiKey: false, apiKeyRequired: true },
    { id: 'provider-b', label: 'B', hasApiKey: false, apiKeyRequired: true },
  ] } });
  await win.MaweAiSettings.fetchSettings();
  win.MaweAiSettings.applyProviderSelection('provider-a');
  keyInput.value = 'sk-provider-a-key'; // 用户为 A 输入了密钥
  win.MaweAiSettings.applyProviderSelection('provider-b'); // 切到 B
  assert.equal(keyInput.value, '');
  const form = win.MaweAiSettings.readFormValues();
  assert.equal(form.apiKey, null); // A 的密钥不得进入 B 的保存负载
  assert.equal(form.providerId, 'provider-b');
});

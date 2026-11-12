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
const aiStructureTasksSource = fs.readFileSync(new URL('../web/editor/ai/editor-ai-structure-tasks.js', import.meta.url), 'utf8');
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

function createContext({ elements = {}, storedPrompts = null } = {}) {
  const context = { TextDecoder, TextEncoder, Uint8Array, AbortController };
  context.window = context; // 与浏览器一致：window 即全局对象
  const state = { hints: [], timers: [], responses: [], fetches: [], beginCalls: [], listeners: {} };
  context.document = { getElementById: (id) => elements[id] || null,
    addEventListener(type, callback) { state.listeners[type] = callback; } };
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
  // 旧的写回守卫测试直接确认所有建议；预览选择本身由浏览器场景验证。
  context.MaweAiPreview = {
    hasPending: () => false,
    present(preview) { state.preview = preview; void preview.apply(preview.rows); return true; },
    close() {}, consume() {},
  };
  loadEditorModule(context, 'shared/editor-utils.js');
  const win = context.window;
  win.MaweBoot = {
    DATA: makeProject([]),
    SERVER_CONFIG: { requestToken: 'test-token', sourceMediaId: 'media-1', bindingGeneration: 3 },
  };
  // host 夹具会注入真实网络层的 MaweHost：模块加载完成后用桩覆盖
  context.MaweHost = {
    storage: { getItem: () => storedPrompts ? JSON.stringify(storedPrompts) : null, setItem() {} },
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
  vm.runInNewContext(aiStructureTasksSource, context, { filename: 'editor-ai-structure-tasks.js' });
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

test('翻译建议分批应用时复用首次创建的副轨', async () => {
  const { win, state } = createContext();
  win.MaweBoot.DATA = makeProject([makeSegment('a', '你好', 0, 1000), makeSegment('b', '世界', 1000, 2000)]);
  win.MaweAiPreview = { hasPending: () => false, present(preview) { state.preview = preview; return true; } };
  win.MaweAiTasks = { begin: async () => ({ texts: { a: 'Hello', b: 'world' } }) };
  win.MaweAiTextTasks.runTextTask('ai-translate', [0, 1], { targetLanguage: 'en' });
  await flush();
  assert.equal(win.MaweMultiSubtitleCore.getActiveExtensionTrack(), null);
  const first = state.preview.refresh(state.preview.rows).find(row => row.id === 'a');
  assert.deepEqual([...await state.preview.apply([first])], ['a']);
  const track = win.MaweMultiSubtitleCore.getActiveExtensionTrack();
  const second = state.preview.refresh(state.preview.rows).find(row => row.id === 'b');
  assert.equal(second.conflict, false);
  assert.deepEqual([...await state.preview.apply([second])], ['b']);
  assert.deepEqual(Array.from(track.segments, segment => segment.text), ['Hello', 'world']);
  assert.equal(win.MaweBoot.DATA.bindings.length, 2);
});

test('翻译预览默认保留已有译文，之后人工修改会成为冲突', async () => {
  const { win, state } = createContext();
  const main = makeSegment('a', '你好', 0, 1000);
  win.MaweBoot.DATA = makeProject([main]);
  const track = enableBilingual(win);
  const extension = makeSegment('ext', 'Hello', 0, 1000);
  track.segments.push(extension);
  win.MaweMultiSubtitleCore.addSubtitleBinding(main, extension, track);
  win.MaweAiPreview = { hasPending: () => false, present(preview) { state.preview = preview; return true; } };
  win.MaweAiTasks = { begin: async () => ({ texts: { a: 'Hi' } }) };
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  await flush();
  assert.equal(state.preview.rows[0].checked, false);
  extension.text = '人工译文';
  const row = state.preview.refresh(state.preview.rows)[0];
  assert.match(row.reason, /副字幕或绑定已修改/);
  assert.deepEqual([...await state.preview.apply([row])], []);
  assert.equal(extension.text, '人工译文');
});

test('多条主字幕共享一个副字幕时，不将 AI 译文覆盖到共享目标', async () => {
  const { win, state } = createContext();
  const cues = [makeSegment('a', '你好', 0, 1000), makeSegment('b', '世界', 1000, 2000)];
  win.MaweBoot.DATA = makeProject(cues);
  const track = enableBilingual(win);
  const extension = makeSegment('ext', '原译文', 0, 2000);
  track.segments.push(extension);
  for (const cue of cues) win.MaweBoot.DATA.bindings.push(win.AsrEditorUtils.buildSubtitleBinding(cue, extension, track.id, null, 'track-main', win.MaweBoot.DATA.bindings));
  win.MaweAiPreview = { hasPending: () => false, present(preview) { state.preview = preview; return true; } };
  win.MaweAiTasks = { begin: async () => ({ texts: { a: 'Hello', b: 'world' } }) };
  win.MaweAiTextTasks.runTextTask('ai-translate', [0, 1]);
  await flush();
  const rows = state.preview.refresh(state.preview.rows);
  assert.ok(rows.every(row => row.conflict));
  assert.deepEqual([...await state.preview.apply(rows)], []);
  assert.equal(extension.text, '原译文');
});

test('独立副字幕占用同一时间范围时保留 AI 译文建议', async () => {
  const { win, state } = createContext();
  win.MaweBoot.DATA = makeProject([makeSegment('a', '你好', 0, 1000)]);
  const track = enableBilingual(win);
  track.segments.push(makeSegment('ext', '已有独立字幕', 500, 1500));
  win.MaweAiPreview = { hasPending: () => false, present(preview) { state.preview = preview; return true; } };
  win.MaweAiTasks = { begin: async () => ({ texts: { a: 'Hello' } }) };
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  await flush();
  const row = state.preview.refresh(state.preview.rows)[0];
  assert.match(row.reason, /时间范围已占用/);
  assert.deepEqual([...await state.preview.apply([row])], []);
  assert.equal(track.segments.length, 1);
  assert.equal(track.segments[0].text, '已有独立字幕');
});

test('新译文的 ID 避开其他字幕轨的已有字幕', async () => {
  const { win, state } = createContext();
  const main = makeSegment('ext-segment-1', '你好', 0, 1000);
  win.MaweBoot.DATA = makeProject([main]);
  const track = win.AsrEditorUtils.ensureExtensionTrack(win.MaweBoot.DATA, { id: 'ext', enabled: true, segments: [] });
  win.MaweBoot.DATA.bilingual.active_track_id = track.id;
  win.MaweAiPreview = { hasPending: () => false, present(preview) { state.preview = preview; return true; } };
  win.MaweAiTasks = { begin: async () => ({ texts: { 'ext-segment-1': 'Hello' } }) };
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  await flush();
  await state.preview.apply(state.preview.rows);
  assert.equal(track.segments.length, 1);
  assert.notEqual(track.segments[0].id, main.id);
  assert.equal(track.segments[0].text, 'Hello');
});

test('本地替换媒体后不接受旧媒体的 AI 对齐结果或重新提交旧源', async () => {
  const { win, state } = createContext();
  const segment = makeSegment('a', 'hello', 0, 1000);
  win.MaweBoot.DATA = makeProject([segment]);
  win.MaweProjectMediaInputs = { currentMediaBlobUrl: null };
  win.MaweAiPreview = { hasPending: () => false, present(preview) { state.preview = preview; return true; } };
  const resolveBegin = stubDeferredBegin(win, state);
  win.MaweAiStructureTasks.runTimecodeItems([0]);
  win.MaweProjectMediaInputs.currentMediaBlobUrl = 'blob:replacement';
  resolveBegin({ items: { a: [{ text: 'hello', start: 0, end: 1000 }] } });
  await flush();
  assert.equal(segment.items, undefined);
  assert.equal(state.preview, undefined);
  win.MaweAiStructureTasks.runTimecodeItems([0]);
  assert.equal(state.beginCalls.length, 1);
});

test('字词对齐提交主轨语言，未设置时保留空语言回退', () => {
  for (const language of ['ja', 'ko', 'fr', '']) {
    const { win, state } = createContext();
    win.MaweBoot.DATA = makeProject([makeSegment('a', '字幕文字', 0, 1000)]);
    win.MaweBoot.DATA.tracks[0].language = language;
    stubDeferredBegin(win, state);
    win.MaweAiStructureTasks.runTimecodeItems([0]);
    assert.equal(state.beginCalls[0][1].lang, language);
  }
});

test('智能合并保留首条 ID 时仍提交 AI 润色', async () => {
  const { win, state } = createContext();
  win.MaweBoot.DATA = makeProject([makeSegment('a', 'Hello', 0, 1000), makeSegment('b', 'world', 1000, 2000)]);
  win.MaweSegmentOps = { mergeSegments() { win.AsrEditorUtils.getMainTrack(win.MaweBoot.DATA).segments.splice(0, 2, makeSegment('a', 'Helloworld', 0, 2000)); } };
  win.MaweViewUpdates = { invalidate() {} };
  win.AsrEditorUtils.planWordTimingTextSync = () => ({});
  win.MaweAiTasks = { begin: async (...args) => { state.beginCalls.push(args); return { texts: { a: 'Hello world' } }; } };
  win.MaweAiStructureTasks.runSmartMerge([0, 1]);
  await flush();
  assert.equal(state.beginCalls.length, 1);
  assert.equal(win.AsrEditorUtils.getMainTrack(win.MaweBoot.DATA).segments[0].text, 'Hello world');
});

test('已有 AI 任务时智能合并在写工程前退出', async () => {
  for (const phase of ['running', 'waiting_edit']) {
    const { win, state } = createContext();
    const segments = [makeSegment('a', 'Hello', 0, 1000), makeSegment('b', 'world', 1000, 2000)];
    win.MaweBoot.DATA = makeProject(segments);
    let merged = false;
    win.MaweSegmentOps = { mergeSegments() { merged = true; segments.splice(1, 1); } };
    const active = { id: 'existing', phase };
    win.MaweAiTasks = { active, begin: async (...args) => { state.beginCalls.push(args); return {}; } };
    win.MaweAiStructureTasks.runSmartMerge([0, 1]);
    await flush();
    assert.equal(merged, false);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments.map(segment => segment.text), ['Hello', 'world']);
    assert.equal(state.beginCalls.length, 0);
    assert.equal(win.MaweAiTasks.active, active);
    assert.ok(state.hints.some(({ message }) => message.includes('已有 AI 任务进行中')));
  }
});

test('AI 单条联动拆分保留正在使用的拆分弹窗', async () => {
  for (const occupied of ['pending', 'visible', 'idle']) {
    const { win, state } = createContext();
    const segment = makeSegment('a', 'first line', 0, 1000);
    win.MaweBoot.DATA = makeProject([segment]);
    const track = enableBilingual(win);
    const translation = makeSegment('translated', '已有译文', 0, 1000);
    track.segments.push(translation);
    const binding = win.MaweMultiSubtitleCore.addSubtitleBinding(segment, translation, track);
    win.MaweMultiSubtitleCore.multiSubtitleVisible = () => true;
    win.MaweMultiSubtitleCore.bindingForMainIndex = () => binding;
    const resolveBegin = stubDeferredBegin(win, state);
    let visible = false;
    let built = 0;
    let rendered = 0;
    const existing = { mainOffset: 2, userSelection: 'keep this selection' };
    const suggested = { mainOffset: 6 };
    win.MaweDom = { multiSubtitleSplitModal: { classList: {
      contains: () => visible,
      add: () => { visible = true; },
    } } };
    win.MaweSplitCore = {
      pendingLinkedSplit: null,
      linkedSplitState: () => { built += 1; return suggested; },
      renderLinkedSplitText: () => { rendered += 1; },
    };
    win.MaweAiStructureTasks.runSuggestSplit([0]);
    // The user starts another split while the provider is still running.
    if (occupied === 'pending') win.MaweSplitCore.pendingLinkedSplit = existing;
    if (occupied === 'visible') visible = true;
    resolveBegin({ texts: { a: 'first⎪ line' } });
    await flush();
    assert.equal(segment.text, 'first line');
    assert.equal(track.segments[0], translation);
    assert.equal(win.MaweBoot.DATA.bindings[0], binding);
    if (occupied === 'idle') {
      assert.equal(win.MaweSplitCore.pendingLinkedSplit, suggested);
      assert.equal(visible, true);
      assert.equal(built, 1);
      assert.equal(rendered, 1);
    } else {
      assert.equal(win.MaweSplitCore.pendingLinkedSplit, occupied === 'pending' ? existing : null);
      assert.equal(visible, occupied === 'visible');
      assert.equal(built, 0);
      assert.equal(rendered, 0);
      assert.ok(state.hints.some(({ message }) => message.includes('关闭当前拆分窗口')));
    }
  }
});

test('拆句按 ID 跟随原字幕而非旧下标', async () => {
  const { win, state } = createContext();
  const segments = [makeSegment('a', 'other', 0, 1000), makeSegment('b', 'same text', 1000, 2000), makeSegment('c', 'same text', 2000, 3000)];
  win.MaweBoot.DATA = makeProject(segments);
  const resolveBegin = stubDeferredBegin(win, state);
  win.MaweSelection = { clearSelection() {}, selectOnly() {} };
  win.MaweViewUpdates = { invalidate() {} };
  win.MaweMultiSubtitleCore.removeBindingsForSegmentIds = () => {};
  win.MaweSplitCore = {
    splitTimeForTextOffset: () => 1500,
    buildSplitPair: (segment) => ({ left: { ...segment, text: 'same' }, right: { ...segment, id: 'new', text: ' text' } }),
    replaceSegmentWithSplit: (list, index, pair) => list.splice(index, 1, pair.left, pair.right),
  };
  win.MaweAiStructureTasks.runSuggestSplit([1]);
  segments.shift();
  resolveBegin({ texts: { b: 'same⎪ text' } });
  await flush();
  assert.deepEqual(segments.map((segment) => segment.id), ['b', 'new', 'c']);
  assert.equal(segments[2].text, 'same text');
});

test('批量拆句保留已绑定字幕，仍处理未绑定字幕', async () => {
  const { win, state } = createContext();
  const segments = [makeSegment('a', 'first line', 0, 1000), makeSegment('b', 'second line', 1000, 2000)];
  win.MaweBoot.DATA = makeProject(segments);
  const track = enableBilingual(win);
  const translation = makeSegment('translated', '已有译文', 0, 1000);
  track.segments.push(translation);
  win.MaweMultiSubtitleCore.addSubtitleBinding(segments[0], translation, track);
  win.MaweSelection = { clearSelection() {}, selectOnly() {} };
  win.MaweViewUpdates = { invalidate() {} };
  win.MaweMultiSubtitleCore.removeBindingsForSegmentIds = () => { throw new Error('不应解除已绑定字幕'); };
  win.MaweSplitCore = {
    splitTimeForTextOffset: () => 1500,
    buildSplitPair: (segment) => ({ left: { ...segment, text: 'second' }, right: { ...segment, id: 'new', text: 'line' } }),
    replaceSegmentWithSplit: (list, index, pair) => list.splice(index, 1, pair.left, pair.right),
  };
  win.MaweAiTasks = { begin: async () => ({ texts: { a: 'first⎪ line', b: 'second⎪ line' } }) };
  win.MaweAiStructureTasks.runSuggestSplit([0, 1]);
  await flush();
  assert.deepEqual(segments.map(segment => segment.id), ['a', 'b', 'new']);
  assert.equal(win.MaweBoot.DATA.bindings.length, 1);
  assert.equal(track.segments[0].text, '已有译文');
  assert.match(state.preview.refresh(state.preview.rows).find(row => row.id === 'a').reason, /不能联动拆分/);
});

test('字词对齐期间人工修改时间码时跳过写回', async () => {
  const { win, state } = createContext();
  const segment = { ...makeSegment('a', 'hello', 0, 1000), items: [{ text: 'hello', start: 0, end: 900 }] };
  win.MaweBoot.DATA = makeProject([segment]);
  const resolveBegin = stubDeferredBegin(win, state);
  win.MaweAiStructureTasks.runTimecodeItems([0]);
  segment.items[0].end = 800;
  resolveBegin({ items: { a: [{ text: 'hello', start: 0, end: 950 }] } });
  await flush();
  assert.equal(segment.items[0].end, 800);
  assert.match(state.preview.refresh(state.preview.rows)[0].reason, /时间或字词已修改/);
});

test('字词对齐按 ID 写回移动后的原字幕', async () => {
  const { win, state } = createContext();
  const original = makeSegment('b', 'hello', 0, 1000);
  const other = makeSegment('c', 'hello', 0, 1000);
  const segments = [makeSegment('a', 'previous', 0, 1000), original, other];
  win.MaweBoot.DATA = makeProject(segments);
  const resolveBegin = stubDeferredBegin(win, state);
  win.MaweAiStructureTasks.runTimecodeItems([1]);
  segments.shift();
  resolveBegin({ items: { b: [{ text: 'hello', start: 0, end: 950 }] } });
  await flush();
  assert.equal(original.items[0].end, 950);
  assert.equal(other.items, undefined);
});

test('重新生成字词时间码需确认，取消时保留原时间码', async () => {
  const { win } = createContext();
  const segment = { ...makeSegment('a', 'hello', 0, 1000), items: [{ text: 'hello', start: 0, end: 800 }] };
  win.MaweBoot.DATA = makeProject([segment]);
  win.MaweAiTasks = { begin: async () => ({ items: { a: [{ text: 'hello', start: 0, end: 950 }] } }) };
  win.confirm = () => false;
  win.MaweAiStructureTasks.runTimecodeItems([0]);
  await flush();
  assert.equal(segment.items[0].end, 800);
  win.confirm = () => true;
  win.MaweAiStructureTasks.runTimecodeItems([0]);
  await flush();
  assert.equal(segment.items[0].end, 950);
});

test('结构任务在工程切换后不修改相同 ID 的新字幕', async () => {
  const { win, state } = createContext();
  win.MaweState.projectLoadGeneration = 1;
  win.MaweBoot.DATA = makeProject([makeSegment('a', 'hello', 0, 1000)]);
  const resolveBegin = stubDeferredBegin(win, state);
  win.MaweAiStructureTasks.runTimecodeItems([0]);
  win.MaweState.projectLoadGeneration = 2;
  const next = makeSegment('a', 'hello', 0, 1000);
  win.MaweBoot.DATA = makeProject([next]);
  resolveBegin({ items: { a: [{ text: 'hello', start: 0, end: 950 }] } });
  await flush();
  assert.equal(next.items, undefined);
  assert.ok(state.hints.some(({ message }) => message.includes('已丢弃')));
});

test('打开另一个工程时即使媒体绑定未改变也丢弃 AI 结果', async () => {
  const { win, state } = createContext();
  win.MaweState.projectLoadGeneration = 1;
  win.MaweBoot.DATA = makeProject([makeSegment('a', 'hello', 0, 1000)]);
  const resolveBegin = stubDeferredBegin(win, state);
  win.MaweAiTextTasks.runTextTask('ai-bold', [0]);
  win.MaweState.projectLoadGeneration = 2;
  const next = makeSegment('a', 'hello', 0, 1000);
  win.MaweBoot.DATA = makeProject([next]);
  resolveBegin({ texts: { a: '**hello**' } });
  await flush();
  assert.equal(next.text, 'hello');
  assert.ok(state.hints.some(({ message }) => message.includes('已丢弃')));
});

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

test('结果等待编辑结束时可丢弃，迟到的等待结果不影响新任务', async () => {
  const { win, state } = createContext();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  state.responses.push(
    { body: { ok: true, task: { id: 'old', status: 'queued' } } },
    { body: { ok: true, tasks: [{ id: 'old', status: 'done', result: { texts: { a: 'old' } } }] } },
  );
  const previous = win.MaweAiTasks.begin('ai-bold', {}, 'AI 加粗关键词', { beforeComplete: async (_current, _result, onWait) => { onWait(); await waiting; return true; } });
  const rejected = assert.rejects(previous, /已取消/);
  await flush();
  state.timers.at(-1)();
  await flush();
  assert.equal(win.MaweAiTasks.active.phase, 'waiting_edit');
  await win.MaweAiTasks.cancelCurrent();
  await rejected;
  state.responses.push(
    { body: { ok: true, task: { id: 'new', status: 'queued' } } },
    { body: { ok: true, tasks: [{ id: 'new', status: 'done', result: { texts: { a: 'new' } } }] } },
  );
  const next = win.MaweAiTasks.begin('ai-bold', {}, 'AI 加粗关键词');
  await flush();
  release();
  await flush();
  assert.equal(win.MaweAiTasks.active.id, 'new');
  state.timers.at(-1)();
  await flush();
  assert.deepEqual(await next, { texts: { a: 'new' } });
});

test('提交阶段取消后，迟到的任务会被取消且不影响新任务', async () => {
  const { win, state } = createContext();
  let release;
  const response = new Promise(resolve => { release = resolve; });
  state.responses.push({ deferred: true, promise: response });
  const previous = win.MaweAiTasks.begin('ai-bold', {}, '旧任务');
  const rejected = assert.rejects(previous, /已取消/);
  await win.MaweAiTasks.cancelCurrent();
  await assert.rejects(win.MaweAiTasks.begin('ai-bold'), /已有 AI 任务/);
  state.responses.push({ body: { ok: true } });
  release({ ok: true, status: 200, json: async () => ({ ok: true, task: { id: 'old', status: 'queued' } }) });
  await flush();
  await rejected;
  assert.equal(state.fetches.at(-1).body.id, 'old');
  state.responses.push({ body: { ok: true, task: { id: 'new', status: 'queued' } } });
  const next = win.MaweAiTasks.begin('ai-bold', {}, '新任务');
  await flush();
  assert.equal(win.MaweAiTasks.active.id, 'new');
  state.responses.push({ body: { ok: true, tasks: [{ id: 'new', status: 'done', result: { texts: { a: 'new' } } }] } });
  state.timers.at(-1)();
  await flush();
  assert.deepEqual(await next, { texts: { a: 'new' } });
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

test('翻译默认使用副轨语言，缺省时中英互译', async () => {
  const { win, state } = createContext();
  const segments = [makeSegment('zh', '你好世界', 0, 1000), makeSegment('en', 'Hello world', 1000, 2000)];
  win.MaweBoot.DATA = makeProject(segments);
  win.MaweAiTasks = { begin: async (...args) => { state.beginCalls.push(args); return { texts: {} }; } };
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  win.MaweAiTextTasks.runTextTask('ai-translate', [1]);
  const track = enableBilingual(win);
  track.language = 'zh-CN';
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  await flush();
  assert.deepEqual(state.beginCalls.map((args) => args[1].lang), ['en', 'zh', 'zh']);
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
  assert.match(state.preview.refresh(state.preview.rows)[0].reason, /绑定不适合/);
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
  assert.match(state.preview.refresh(state.preview.rows)[0].reason, /副字幕或绑定已修改/);
});

test('翻译期间切换副轨不会把结果写入新轨', async () => {
  const { win, state } = createContext();
  win.MaweBoot.DATA = makeProject([makeSegment('a', '你好', 0, 1000)]);
  const first = enableBilingual(win);
  const resolveBegin = stubDeferredBegin(win, state);
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  const second = win.AsrEditorUtils.ensureExtensionTrack(win.MaweBoot.DATA, { id: 'other', name: 'Other', segments: [] });
  win.MaweBoot.DATA.bilingual.active_track_id = second.id;
  resolveBegin({ texts: { a: 'Hello' } });
  await flush();
  assert.equal(first.segments.length, 0);
  assert.equal(second.segments.length, 0);
  assert.match(state.preview.refresh(state.preview.rows)[0].reason, /副字幕轨已切换/);
});

test('翻译替换带字词时间码的副字幕前确认，取消保留原文与时间码', async () => {
  const { win } = createContext();
  const segments = [makeSegment('seg-1', '你好世界', 0, 1200)];
  win.MaweBoot.DATA = makeProject(segments);
  const track = enableBilingual(win);
  const extension = { id: 'ext', start: 0, end: 1200, text: 'old translation', items: [{ text: 'old translation', start: 0, end: 1200 }] };
  track.segments.push(extension);
  win.MaweMultiSubtitleCore.addSubtitleBinding(segments[0], extension, track);
  win.MaweAiTasks = { begin: async () => ({ texts: { 'seg-1': 'New translation' } }) };
  win.confirm = () => false;
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  await flush();
  assert.equal(extension.text, 'old translation');
  assert.equal(extension.items[0].text, 'old translation');
  win.confirm = () => true;
  win.MaweAiTextTasks.runTextTask('ai-translate', [0]);
  await flush();
  assert.equal(extension.text, 'New translation');
  assert.equal(extension.items, undefined);
});

test('源字幕保留首尾空白，AI 结果可正常写回', async () => {
  const { win, state } = createContext();
  const segment = makeSegment('a', ' hello ', 0, 1000);
  win.MaweBoot.DATA = makeProject([segment]);
  win.MaweAiTasks = { begin: async (...args) => { state.beginCalls.push(args); return { texts: { a: ' **hello** ' } }; } };
  win.MaweAiTextTasks.runTextTask('ai-bold', [0]);
  await flush();
  assert.equal(state.beginCalls[0][1].cues[0].text, ' hello ');
  assert.equal(segment.text, ' **hello** ');
});

test('默认加粗仅插入标记，自定义提示词仍可改写', async () => {
  const { win, state } = createContext();
  const segments = [makeSegment('a', 'keep **old** words', 0, 1000), makeSegment('b', 'original words', 1000, 2000)];
  win.MaweBoot.DATA = makeProject(segments);
  win.MaweAiTasks = { begin: async () => ({ texts: { a: 'keep **old** **words**', b: '**rewritten** words' } }) };
  win.MaweAiTextTasks.runTextTask('ai-bold', [0, 1]);
  await flush();
  assert.equal(segments[0].text, 'keep **old** **words**');
  assert.equal(segments[1].text, 'original words');
  assert.match(state.preview.refresh(state.preview.rows).find(row => row.id === 'b').reason, /格式不符/);

  const custom = createContext({ storedPrompts: { 'ai-bold': '改写语句' } });
  const segment = makeSegment('c', 'original words', 0, 1000);
  custom.win.MaweBoot.DATA = makeProject([segment]);
  custom.win.MaweAiTasks = { begin: async () => ({ texts: { c: 'rewritten words' } }) };
  custom.win.MaweAiTextTasks.runTextTask('ai-bold', [0]);
  await flush();
  assert.equal(segment.text, 'rewritten words');
});

test('默认加粗保留已有强调范围，拒绝重复包裹、嵌套与空标记', async () => {
  const { win } = createContext();
  const original = 'a **bold** word';
  const results = ['a ****bold**** word', 'a **b**ol**d** word', 'a **bold** ****word', 'a **bold** **word**'];
  const segments = results.map((_, index) => makeSegment(String(index), original, index * 1000, (index + 1) * 1000));
  win.MaweBoot.DATA = makeProject(segments);
  win.MaweAiTasks = { begin: async () => ({ texts: Object.fromEntries(results.entries()) }) };
  win.MaweAiTextTasks.runTextTask('ai-bold', [0, 1, 2, 3]);
  await flush();
  assert.deepEqual(segments.map(segment => segment.text), [original, original, original, results[3]]);
});

test('默认 Emoji 保留原文并接受组合表情，拒绝普通文字前缀', async () => {
  const { win } = createContext();
  const segments = ['a', 'b', 'c', 'd'].map((id, index) => makeSegment(id, '原文', index * 1000, (index + 1) * 1000));
  win.MaweBoot.DATA = makeProject(segments);
  win.MaweAiTasks = { begin: async () => ({ texts: { a: '🇨🇳 原文', b: '👩🏽‍💻 原文', c: '1️⃣ 原文', d: 'foo 原文' } }) };
  win.MaweAiTextTasks.runTextTask('ai-emoji', [0, 1, 2, 3]);
  await flush();
  assert.deepEqual(segments.map(segment => segment.text), ['🇨🇳 原文', '👩🏽‍💻 原文', '1️⃣ 原文', '原文']);
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
    // 取消 A，然后在迟到响应前启动 B。
    { body: { ok: true } },
    { body: { ok: true, task: { id: 'task-b', kind: 'ai-bold', status: 'queued', stage: 'queued', percent: 0 } } },
    { body: { ok: true, tasks: [{ id: 'task-b', status: 'done', stage: 'done', percent: 100, result: { marker: 'B' } }] } },
  );
  const promiseA = win.MaweAiTasks.begin('ai-bold', {}, '任务A');
  promiseA.catch(() => {}); // 取消路径的 rejection 已预期
  await flush();
  state.timers.at(-1)(); // 第一轮 tick：GET 挂起
  await flush();
  await win.MaweAiTasks.cancelCurrent();
  const promiseB = win.MaweAiTasks.begin('ai-bold', {}, '任务B');
  await flush();
  releaseHeld(); // 释放 A 的迟到 done 响应
  await flush();
  assert.equal(win.MaweAiTasks.active?.id ?? null, 'task-b');
  state.timers.at(-1)(); // B 自己的下一轮 tick
  await flush();
  assert.deepEqual(await promiseB, { marker: 'B' });
});

test('进度查询短暂失败后按 1、2、4 秒重试并恢复原任务', async () => {
  const { win, state } = createContext();
  const timeouts = [];
  win.setTimeout = (fn, delay) => { timeouts.push({ fn, delay }); return timeouts.length; };
  state.responses.push({ body: { ok: true, task: { id: 'task-a', status: 'queued' } } });
  const result = win.MaweAiTasks.begin('ai-bold', {}, '任务A');
  await flush();
  for (const delay of [1000, 2000, 4000]) {
    state.responses.push({ deferred: true, promise: Promise.reject(new Error('offline')) });
    if (delay === 1000) state.timers.at(-1)();
    else timeouts.at(-1).fn();
    await flush();
    assert.equal(timeouts.at(-1).delay, delay);
    assert.equal(win.MaweAiTasks.active.phase, 'retrying');
  }
  state.responses.push({ body: { ok: true, tasks: [{ id: 'task-a', status: 'done', result: { text: 'ok' } }] } });
  timeouts.at(-1).fn();
  await flush();
  assert.equal((await result).text, 'ok');
  assert.equal(state.fetches.filter((entry) => entry.method === 'POST').length, 1);
});

test('重试耗尽后保留任务供手动重新连接和取消', async () => {
  const { win, state } = createContext();
  const timeouts = [];
  win.setTimeout = (fn, delay) => { timeouts.push({ fn, delay }); return timeouts.length; };
  state.responses.push({ body: { ok: true, task: { id: 'task-a', status: 'queued' } } });
  const result = win.MaweAiTasks.begin('ai-bold', {}, '任务A');
  await flush();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    state.responses.push({ deferred: true, promise: Promise.reject(new Error('offline')) });
    if (attempt === 0) state.timers.at(-1)();
    else timeouts.at(-1).fn();
    await flush();
  }
  assert.equal(win.MaweAiTasks.active.phase, 'disconnected');
  assert.equal(win.MaweAiTasks.active.id, 'task-a');
  state.responses.push({ body: { ok: true, tasks: [{ id: 'task-a', status: 'done', result: { text: 'recovered' } }] } });
  win.MaweAiTasks.retryCurrent();
  await flush();
  assert.equal((await result).text, 'recovered');
  assert.equal(state.fetches.filter((entry) => entry.method === 'POST').length, 1);
});

test('断线时取消失败保留任务，连接恢复后可取消', async () => {
  const { win, state } = createContext();
  const timeouts = [];
  win.setTimeout = (fn, delay) => { timeouts.push({ fn, delay }); return timeouts.length; };
  state.responses.push({ body: { ok: true, task: { id: 'task-a', status: 'queued' } } });
  const result = win.MaweAiTasks.begin('ai-bold', {}, '任务A');
  const cancelled = assert.rejects(result, /已取消/);
  await flush();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    state.responses.push({ deferred: true, promise: Promise.reject(new Error('offline')) });
    if (attempt === 0) state.timers.at(-1)();
    else timeouts.at(-1).fn();
    await flush();
  }
  state.responses.push({ deferred: true, promise: Promise.reject(new Error('offline')) });
  await win.MaweAiTasks.cancelCurrent();
  assert.equal(win.MaweAiTasks.active.phase, 'disconnected');
  assert.equal(win.MaweAiTasks.active.id, 'task-a');
  state.responses.push({ body: { ok: true } });
  await win.MaweAiTasks.cancelCurrent();
  await cancelled;
  assert.equal(win.MaweAiTasks.active, null);
  const cancels = state.fetches.filter((entry) => entry.url === '/api/ai/task/cancel');
  assert.equal(cancels.length, 2);
  assert.ok(cancels.every((entry) => entry.body.id === 'task-a'));
});

test('英文界面在断线和手动接管时显示完整英文提示', async () => {
  const classes = { add() {}, remove() {}, toggle() {} };
  const label = { textContent: '' };
  const retry = { hidden: true, textContent: '' };
  const elements = {
    'ai-task-progress': { hidden: true, classList: classes },
    'ai-task-progress-label': label,
    'ai-task-progress-retry': retry,
    'ai-task-progress-bar': { removeAttribute() {}, setAttribute() {} },
    'ai-task-progress-percent': { textContent: '' },
  };
  const { win, state } = createContext({ elements });
  win.MAWE_I18N = { language: 'en', translateText: (value) => win.MAWE_I18N.language === 'en' && value === 'AI 翻译为副字幕' ? 'AI translate to secondary subtitles' : value };
  const timeouts = [];
  win.setTimeout = (fn, delay) => { timeouts.push({ fn, delay }); return timeouts.length; };
  state.responses.push({ body: { ok: true, task: { id: 'task-a', status: 'queued' } } });
  const result = win.MaweAiTasks.begin('ai-translate', {}, 'AI 翻译为副字幕');
  result.catch(() => {});
  await flush();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    state.responses.push({ deferred: true, promise: Promise.reject(new Error('offline')) });
    if (attempt === 0) state.timers.at(-1)();
    else timeouts.at(-1).fn();
    await flush();
    if (attempt === 0) assert.equal(label.textContent, 'AI translate to secondary subtitles · Connection lost; retrying (1/3)…');
  }
  assert.equal(label.textContent, 'AI translate to secondary subtitles · Connection not restored; please take over');
  assert.equal(retry.hidden, false);
  assert.equal(retry.textContent, 'Reconnect');
  win.MAWE_I18N.language = 'zh';
  state.listeners['mawe:languagechange']();
  assert.equal(label.textContent, 'AI 翻译为副字幕 · 连接未恢复，请手动接管');
  assert.equal(retry.textContent, '重新连接');
});

test('进度请求无响应时超时并重试，不重复发起并行查询', async () => {
  const { win, state } = createContext();
  const timeouts = [];
  win.setTimeout = (fn, delay) => { timeouts.push({ fn, delay }); return timeouts.length; };
  state.responses.push({ body: { ok: true, task: { id: 'task-a', status: 'queued' } } });
  const result = win.MaweAiTasks.begin('ai-bold', {}, '任务A');
  await flush();
  let release;
  state.responses.push({ deferred: true, promise: new Promise((resolve) => { release = resolve; }) });
  state.timers.at(-1)();
  await flush();
  state.timers.at(-1)();
  assert.equal(state.fetches.filter((entry) => entry.method === 'GET').length, 1);
  assert.equal(timeouts.at(-1).delay, 10000);
  timeouts.at(-1).fn();
  await flush();
  assert.equal(win.MaweAiTasks.active.phase, 'retrying');
  assert.equal(timeouts.at(-1).delay, 1000);
  state.responses.push({ body: { ok: true, tasks: [{ id: 'task-a', status: 'done', result: { text: 'recovered' } }] } });
  timeouts.at(-1).fn();
  await flush();
  assert.equal((await result).text, 'recovered');
  release({ ok: true, json: async () => ({ ok: true, tasks: [] }) });
});

test('取消请求无响应时返回手动接管并保留原任务', async () => {
  const { win, state } = createContext();
  const timeouts = [];
  win.setTimeout = (fn, delay) => { timeouts.push({ fn, delay }); return timeouts.length; };
  state.responses.push({ body: { ok: true, task: { id: 'task-a', status: 'queued' } } });
  const result = win.MaweAiTasks.begin('ai-bold', {}, '任务A');
  result.catch(() => {});
  await flush();
  state.responses.push({ deferred: true, promise: new Promise(() => {}) });
  const cancel = win.MaweAiTasks.cancelCurrent();
  assert.equal(win.MaweAiTasks.active.phase, 'cancelling');
  assert.equal(timeouts.at(-1).delay, 10000);
  timeouts.at(-1).fn();
  await cancel;
  assert.equal(win.MaweAiTasks.active.phase, 'disconnected');
  assert.equal(win.MaweAiTasks.active.id, 'task-a');
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

for (const failure of ['network', 'timeout']) {
  test(`submission cancellation retains late task ID after ${failure} failure`, async () => {
    const label = { textContent: '' };
    const retry = { hidden: true };
    const { win, state } = createContext({ elements: {
      'ai-task-progress': { hidden: true, classList: { add() {}, remove() {}, toggle() {} } },
      'ai-task-progress-label': label,
      'ai-task-progress-retry': retry,
    } });
    const timeouts = [];
    win.setTimeout = (fn, delay) => { timeouts.push({ fn, delay }); return timeouts.length; };
    let submit;
    let failCancel;
    state.responses.push({ deferred: true, promise: new Promise(resolve => { submit = resolve; }) });
    const result = win.MaweAiTasks.begin('ai-bold');
    let settled = false;
    result.then(() => { settled = true; }, () => { settled = true; });
    await win.MaweAiTasks.cancelCurrent();
    await win.MaweAiTasks.cancelCurrent();
    assert.ok(win.MaweAiTasks.active, 'submission remains owned until cancellation is confirmed');
    assert.equal(settled, false);
    assert.match(label.textContent, /等待提交确认/);
    await assert.rejects(win.MaweAiTasks.begin('ai-bold'), /已有 AI 任务/);
    state.responses.push({ deferred: true, promise: new Promise((_, reject) => { failCancel = reject; }) });
    submit({ ok: true, json: async () => ({ ok: true, task: { id: 'late-task', status: 'queued' } }) });
    await flush();
    assert.equal(win.MaweAiTasks.active.id, 'late-task');
    assert.equal(win.MaweAiTasks.active.phase, 'cancelling');
    await win.MaweAiTasks.cancelCurrent();
    assert.equal(state.fetches.filter(entry => entry.url === '/api/ai/task/cancel').length, 1);
    if (failure === 'network') failCancel(new Error('offline'));
    else {
      assert.equal(timeouts.at(-1).delay, 10000);
      timeouts.at(-1).fn();
    }
    await flush();
    assert.equal(win.MaweAiTasks.active.id, 'late-task');
    assert.equal(win.MaweAiTasks.active.phase, 'disconnected');
    assert.equal(settled, false);
    assert.match(label.textContent, /取消失败/);
    assert.equal(retry.hidden, false);
    state.responses.push({ body: { ok: true, tasks: [{ id: 'late-task', status: 'running' }] } });
    win.MaweAiTasks.retryCurrent();
    await flush();
    assert.equal(win.MaweAiTasks.active.phase, 'running');
    state.responses.push({ body: { ok: true } });
    const cancelled = assert.rejects(result, /已取消/);
    await win.MaweAiTasks.cancelCurrent();
    await cancelled;
    assert.equal(win.MaweAiTasks.active, null);
    assert.equal(state.fetches.filter(entry => entry.url === '/api/ai/task').length, 1);
    assert.ok(state.fetches.filter(entry => entry.url === '/api/ai/task/cancel').every(entry => entry.body.id === 'late-task'));
  });
}

test('submission cancellation settles only after late task cancellation succeeds', async () => {
  const { win, state } = createContext();
  let submit;
  state.responses.push({ deferred: true, promise: new Promise(resolve => { submit = resolve; }) });
  const result = win.MaweAiTasks.begin('ai-bold');
  const cancelled = assert.rejects(result, /已取消/);
  await win.MaweAiTasks.cancelCurrent();
  assert.ok(win.MaweAiTasks.active);
  state.responses.push({ body: { ok: true } });
  submit({ ok: true, json: async () => ({ ok: true, task: { id: 'late-task', status: 'queued' } }) });
  await flush();
  await cancelled;
  assert.equal(win.MaweAiTasks.active, null);
  assert.equal(state.timers.length, 0);
});

test('submission failure after cancel intent reports the submission error', async () => {
  const { win, state } = createContext();
  let rejectSubmit;
  state.responses.push({ deferred: true, promise: new Promise((_, reject) => { rejectSubmit = reject; }) });
  const result = win.MaweAiTasks.begin('ai-bold');
  const failed = assert.rejects(result, /submission failed/);
  await win.MaweAiTasks.cancelCurrent();
  rejectSubmit(new Error('submission failed'));
  await failed;
  assert.equal(win.MaweAiTasks.active, null);
  assert.equal(state.fetches.length, 1);
});

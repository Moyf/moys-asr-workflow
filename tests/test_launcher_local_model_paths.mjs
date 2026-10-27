import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

// 回归：切换本地模型时不得回写输入框值。输入框可能被程序性填充
// （扫描回显、状态回填），切换时写回会把自动发现的路径持久化成
// 上一个模型的自定义目录，撤销用户「删空回到自动发现」的选择；
// 输入与目录选择事件已经实时更新条目，切换时写回本无必要。

const MODELS = [
  {id: 'qwen3-asr-local', engine: 'qwen-asr'},
  {id: 'sensevoice-small-local', engine: 'funasr'},
];

function fixture() {
  const controls = new Map();
  const $ = id => {
    if (!controls.has(id)) controls.set(id, {
      value: '', checked: false,
      classList: {add() {}, remove() {}, toggle() {}},
    });
    return controls.get(id);
  };
  const state = {localModelId: '', localModelPaths: {}};
  const context = vm.createContext({
    $,
    state,
    provider: () => ({kind: 'local', models: MODELS}),
    selectedModel: () => MODELS.find(model => model.id === $('model').value) || MODELS[0],
    setError: () => {},
  });
  vm.runInContext(readFileSync(new URL('../web/launcher/local/launcher-local-models.js', import.meta.url), 'utf8'), context);
  return {context, $, state};
}

function switchTo($, context, id) {
  // 与真实 UI 一致：先改 <select id="model"> 的值，再走 applySelectedModel 的同步。
  $('model').value = id;
  return vm.runInContext('syncLocalModelPath(selectedModel())', context);
}

test('a programmatically filled path is not written into the previous model entry', () => {
  const {context, $, state} = fixture();
  vm.runInContext('syncLocalModelPath(selectedModel())', context);
  assert.equal(state.localModelId, 'qwen3-asr-local');
  // renderLocalModelStatus 会把扫描到的缓存路径程序性填进输入框；用户没有输入。
  $('localModelPath').value = '/media/data/local-runtime';
  switchTo($, context, 'sensevoice-small-local');
  assert.equal(state.localModelPaths['qwen3-asr-local'], undefined);
  assert.equal($('localModelPath').value, '');
});

test('clearing an entry then a refresh backfill survives a model switch', () => {
  // 用户删空输入框（input 已把条目存成 ""，想回到自动发现）→ 刷新把
  // 自动发现路径程序性回填进输入框 → 切换不得把显示值写回条目。
  const {context, $, state} = fixture();
  vm.runInContext('syncLocalModelPath(selectedModel())', context);
  state.localModelPaths['qwen3-asr-local'] = '/cache/discovered';
  vm.runInContext('syncLocalModelPath(selectedModel())', context);
  // 用户删空：input 事件处理同步条目为空并保存。
  $('localModelPath').value = '';
  state.localModelPaths['qwen3-asr-local'] = '';
  // 刷新把自动发现的路径回填进输入框（切换写回已移除，无任何标记参与）。
  $('localModelPath').value = '/cache/discovered';
  switchTo($, context, 'sensevoice-small-local');
  assert.equal(state.localModelPaths['qwen3-asr-local'], '', '切换不得把回填的显示值写回条目');
  // 切回时按保存的空条目还原输入框，显示回填交给随后的刷新。
  switchTo($, context, 'qwen3-asr-local');
  assert.equal($('localModelPath').value, '');
});

test('switching back and forth does not leak entries between models', () => {
  const {context, $, state} = fixture();
  vm.runInContext('syncLocalModelPath(selectedModel())', context);
  $('localModelPath').value = '/stale/residual-path';
  switchTo($, context, 'sensevoice-small-local');
  // 已存条目在切回时正确加载；B 从未被编辑，切换不得给它写入任何值。
  state.localModelPaths['qwen3-asr-local'] = '/models/qwen3-asr';
  switchTo($, context, 'qwen3-asr-local');
  assert.equal($('localModelPath').value, '/models/qwen3-asr');
  assert.equal(state.localModelPaths['sensevoice-small-local'], undefined);
  // 残留输入框值在切换时同样不回写：条目只由 input / 选择目录事件更新。
  $('localModelPath').value = '/should-not-persist';
  switchTo($, context, 'sensevoice-small-local');
  assert.equal(state.localModelPaths['qwen3-asr-local'], '/models/qwen3-asr');
  assert.equal(state.localModelPaths['sensevoice-small-local'], undefined);
});

function clearPathFixture() {
  const source = readFileSync(new URL('../web/launcher/boot/launcher-notify-backend.js', import.meta.url), 'utf8');
  const start = source.indexOf('$("clearLocalModelPath").addEventListener');
  const end = source.indexOf('$("refreshLocalRuntime").addEventListener', start);
  assert.ok(start >= 0 && end > start, 'clear path event handler must exist');
  let handler;
  let finishSave;
  let selected = MODELS[0];
  const path = {value: '/models/qwen'};
  const state = {localModelPaths: {
    'qwen3-asr-local': '/models/qwen',
    'sensevoice-small-local': '/models/sensevoice',
  }};
  const context = vm.createContext({
    state,
    $: id => id === 'clearLocalModelPath' ? {addEventListener: (_event, fn) => { handler = fn; }} : path,
    selectedModel: () => selected,
    isLocalProvider: () => true,
    setError() {}, setStatus() {}, t: key => key,
    savePrefsNow: () => new Promise(resolve => { finishSave = resolve; }),
    refreshLocalModels: async () => {},
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    path, state,
    clear: () => handler(),
    failSave: () => finishSave({ok: false}),
    switchTo(model) { selected = model; path.value = state.localModelPaths[model.id]; },
  };
}

test('a failed clear restores the selected model path', async () => {
  const ui = clearPathFixture();
  const pending = ui.clear();
  ui.failSave();
  await pending;
  assert.equal(ui.state.localModelPaths['qwen3-asr-local'], '/models/qwen');
  assert.equal(ui.path.value, '/models/qwen');
});

test('a failed clear does not overwrite the path of a model selected during saving', async () => {
  const ui = clearPathFixture();
  const pending = ui.clear();
  ui.switchTo(MODELS[1]);
  ui.failSave();
  await pending;
  assert.equal(ui.state.localModelPaths['qwen3-asr-local'], '/models/qwen');
  assert.equal(ui.path.value, '/models/sensevoice');
});

test('a failed clear does not overwrite a newer edit to the same model', async () => {
  const ui = clearPathFixture();
  const pending = ui.clear();
  ui.state.localModelPaths['qwen3-asr-local'] = '/models/new-qwen';
  ui.path.value = '/models/new-qwen';
  ui.failSave();
  await pending;
  assert.equal(ui.state.localModelPaths['qwen3-asr-local'], '/models/new-qwen');
  assert.equal(ui.path.value, '/models/new-qwen');
});

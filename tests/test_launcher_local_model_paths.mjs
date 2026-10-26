import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

// 回归：切换本地模型时，输入框里程序性填充的路径（扫描回显、状态回填）
// 不得写进上一个模型的 localModelPaths 条目；只有用户本会话实际改过的
// 值才回写（per-model dirty 标记，见 web/launcher/boot/launcher-state.js）。

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
  const state = {localModelId: '', localModelPaths: {}, localModelPathDirty: {}};
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

test('a user-edited path is written back to its own model on switch', () => {
  const {context, $, state} = fixture();
  vm.runInContext('syncLocalModelPath(selectedModel())', context);
  // 模拟 input 事件处理：用户真的改过输入框（会同步落 dirty 标记）。
  $('localModelPath').value = '/models/qwen3-asr';
  state.localModelPaths['qwen3-asr-local'] = '/models/qwen3-asr';
  state.localModelPathDirty['qwen3-asr-local'] = true;
  switchTo($, context, 'sensevoice-small-local');
  assert.equal(state.localModelPaths['qwen3-asr-local'], '/models/qwen3-asr');
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
  // 清除动作把 dirty 一并复位后，残留输入框值也不再回写。
  $('localModelPath').value = '/should-not-persist';
  switchTo($, context, 'sensevoice-small-local');
  assert.equal(state.localModelPaths['qwen3-asr-local'], '/models/qwen3-asr');
  assert.equal(state.localModelPaths['sensevoice-small-local'], undefined);
});

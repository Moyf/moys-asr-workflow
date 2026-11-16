// 断句与标点偏好持久化（issue #355）：装载真实 launcher 源码（launcher-state /
// form-base / form-sync / media-form / prefs-zoom），验证 segmentationPrefsPayload
// 快照组装与 savePrefsDebounced 的合并防抖、bridge("save_prefs") 提交。接线
// （notify-backend.js 事件监听）、启动回填（settings-startup.js）与预设应用
// （launcher-presets.js）依赖完整页面环境，由 tests/test_gui_web.py 源码断言覆盖。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

function fixture() {
  const controls = new Map();
  const control = (id) => {
    if (!controls.has(id)) {
      controls.set(id, {
        value: '', checked: false, disabled: false, innerHTML: '',
        add() {}, remove() {},
        classList: {toggle() {}, add() {}, remove() {}},
        addEventListener() {},
      });
    }
    return controls.get(id);
  };
  // 模拟真实定时器语义：setTimeout 记录待触发回调，clearTimeout 取消它。
  const timers = {pending: null};
  const context = vm.createContext({
    document: {getElementById: control},
    window: {},
    localStorage: {getItem: () => null, setItem: () => {}},
    setTimeout: (fn) => { timers.pending = fn; return 1; },
    clearTimeout: () => { timers.pending = null; },
    Option: class {
      constructor(label, value) { this.label = label; this.value = value; }
    },
  });
  return {control, timers, context};
}

test('segmentation fields persist through savePrefsDebounced', async () => {
  const {timers, context} = fixture();
  vm.runInContext(
    'var bridgeCalls = []; var bridge = async (name, payload) => { bridgeCalls.push([name, payload]); return {ok: true}; };',
    context,
  );
  for (const file of [
    'i18n/launcher-strings.js',
    'boot/launcher-state.js',
    'forms/launcher-form-base.js',
    'forms/launcher-form-sync.js',
    'forms/launcher-media-form.js',
    'forms/launcher-prefs-zoom.js',
  ]) {
    vm.runInContext(readFileSync(new URL(`../web/launcher/${file}`, import.meta.url), 'utf8'), context);
  }

  vm.runInContext(`
    $("gapSplit").value = "500";
    $("maxLen").value = "18";
    savePrefsDebounced(segmentationPrefsPayload());
    // 第二次输入合并进同一防抖窗口，只发出一次最新快照。
    $("maxLen").value = "20";
    savePrefsDebounced(segmentationPrefsPayload());
  `, context);

  assert.ok(timers.pending, '两次防抖调用应合并为同一个待触发定时器');
  timers.pending();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(vm.runInContext('bridgeCalls.length', context), 1);
  const [name, payload] = JSON.parse(JSON.stringify(vm.runInContext('bridgeCalls[0]', context)));
  assert.equal(name, 'save_prefs');
  assert.deepEqual(payload, {gapSplit: '500', minLen: '', maxLen: '20', minWords: '', maxWords: ''});
});

test('segmentationPrefsPayload reflects blank fields as empty strings', () => {
  const {context} = fixture();
  for (const file of [
    'i18n/launcher-strings.js',
    'boot/launcher-state.js',
    'forms/launcher-form-base.js',
    'forms/launcher-form-sync.js',
    'forms/launcher-media-form.js',
  ]) {
    vm.runInContext(readFileSync(new URL(`../web/launcher/${file}`, import.meta.url), 'utf8'), context);
  }

  const payload = JSON.parse(JSON.stringify(vm.runInContext('segmentationPrefsPayload()', context)));
  assert.deepEqual(payload, {gapSplit: '', minLen: '', maxLen: '', minWords: '', maxWords: ''});
});

// F1（foreman 盲审）：applyAsrPreset 必须在 ASR_PRESET_TEXT_FIELDS 五字段赋值之后读取
// segmentationPrefsPayload()——快照若取自赋值前，持久化的就是旧值。本用例装载真实
// launcher-presets.js，应用预设后断言快照等于赋值后的字段值；把快照读取移到赋值之前即红。
test('applyAsrPreset persists segmentation snapshot taken after field assignment', async () => {
  const {timers, context} = fixture();
  vm.runInContext(
    'var bridgeCalls = []; var bridge = async (name, payload) => { bridgeCalls.push([name, payload]); return {ok: true}; };',
    context,
  );
  for (const file of [
    'i18n/launcher-strings.js',
    'i18n/launcher-labels.js',
    'boot/launcher-state.js',
    'forms/launcher-form-base.js',
    'forms/launcher-form-sync.js',
    'forms/launcher-media-form.js',
    'forms/launcher-prefs-zoom.js',
    'presets/launcher-presets.js',
  ]) {
    vm.runInContext(readFileSync(new URL(`../web/launcher/${file}`, import.meta.url), 'utf8'), context);
  }
  // 未装载模块的桩：只拦截副作用，不参与字段赋值与快照读取；applyProviderLanguages 的
  // 实参 provider()/selectedModel() 仍会真实求值，故 state.config 需带 providers。
  vm.runInContext(`
    state.config = {providers: [{id: 'qwen', models: [{id: 'qwen3-asr-flash-filetrans'}]}]};
    state.lang = 'zh';
    syncLocalDeviceOptions = () => {};
    renderLocalAlignmentModel = () => {};
    applyProviderLanguages = () => {};
    syncTestRun = () => {};
  `, context);

  vm.runInContext(`
    applyAsrPreset({
      localDevice: '', fireRedPunc: '', recognitionAlignmentModel: '', language: 'zh',
      promptContext: '', qwenAudioHotwordsMode: '', qwenAudioHotwords: '', qwenAudioHotwordsFile: '',
      qwenAudioHotwordWeight: '', sonioxContextGeneral: '', sonioxContextTerms: '',
      sonioxContextTranslationTerms: '', openaiKeywords: '',
      gapSplit: '750', minLen: '3', maxLen: '42', minWords: '2', maxWords: '60',
      speakerColors: false, generateSpectral: false, generateKeyframes: false, generateThumbnails: false,
      debugRaw: false, testRun: false, qwenAudioKeepDialect: false,
    });
  `, context);

  // 预设覆盖后的字段值（快照读取顺序正确的直接证据）。
  assert.equal(vm.runInContext('$("gapSplit").value', context), '750');
  assert.equal(vm.runInContext('$("maxLen").value', context), '42');
  assert.ok(timers.pending, 'applyAsrPreset 应触发一次防抖保存');
  timers.pending();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(vm.runInContext('bridgeCalls.length', context), 1);
  const [name, payload] = JSON.parse(JSON.stringify(vm.runInContext('bridgeCalls[0]', context)));
  assert.equal(name, 'save_prefs');
  assert.deepEqual(payload, {gapSplit: '750', minLen: '3', maxLen: '42', minWords: '2', maxWords: '60'});
  // state.config 同步供 openSettings 回填，不得残留旧值。
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('({gapSplit: state.config.gapSplit, maxLen: state.config.maxLen})', context))), {gapSplit: '750', maxLen: '42'});
});

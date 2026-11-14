// 「生成缩略图」开关的音频禁用联动：装载真实 launcher 源码（launcher-state /
// form-base / form-sync / media-form），验证音频输入禁用、切回视频恢复并保留
// 勾选、以及表单 payload 在禁用态的取值语义。接线契约（mediaPath input 监听）
// 由 tests/test_gui_web.py 的源码断言覆盖。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

function fixture() {
  const controls = new Map();
  const toggles = new Map();
  const control = id => {
    if (!controls.has(id)) {
      controls.set(id, {
        value: '', checked: false, disabled: false, innerHTML: '',
        add() {},
        classList: {
          toggle(name, force) { toggles.get(id).push([name, force]); },
          add() {}, remove() {},
        },
        addEventListener() {},
      });
      toggles.set(id, []);
    }
    return controls.get(id);
  };
  const context = vm.createContext({
    document: {getElementById: control},
    window: {},
    clearTimeout() {}, setTimeout() {},
    Option: class {
      constructor(label, value) { this.label = label; this.value = value; }
    },
    state: null, // launcher-state.js 以 const state 声明，这里仅占位校验冲突。
  });
  delete context.state;
  for (const file of [
    'i18n/launcher-strings.js',
    'boot/launcher-state.js',
    'forms/launcher-form-base.js',
    'forms/launcher-form-sync.js',
    'forms/launcher-media-form.js',
  ]) {
    vm.runInContext(readFileSync(new URL(`../web/launcher/${file}`, import.meta.url), 'utf8'), context);
  }
  // 未装载模块里的协作函数：按调用路径给最小桩。
  vm.runInContext(`
    state.config = {providers: [{id: 'qwen', models: [{id: 'qwen-asr'}]}], region: 'beijing'};
    renderMessage = () => {};
    syncFlvHints = () => {};
    syncDefaultOutput = async () => ({});
    syncTestRun = () => {};
    isLocalProvider = () => false;
    isFireRedModel = () => false;
    languageValue = () => 'zh';
    t = key => key;
    bridge = async () => new Promise(() => {});
  `, context);
  return {context, control, toggles};
}

const checkbox = ({control}) => control('generateKeyframes');
const fieldToggles = ({toggles}, id) => toggles.get(id);

test('picking an audio file disables the switch and keeps the saved check', () => {
  const fx = fixture();
  checkbox(fx).checked = true; // 用户在视频素材上勾选过
  vm.runInContext(`setMedia('D:\\\\Demo\\\\song.mp3')`, fx.context);
  assert.equal(checkbox(fx).disabled, true, '音频输入禁用开关');
  assert.deepEqual(fieldToggles(fx, 'generateKeyframesField').at(-1), ['unavailable', true], '字段进入置灰态');
  assert.equal(checkbox(fx).checked, true, '禁用不清空勾选');
  assert.deepEqual(fieldToggles(fx, 'generateThumbnailsField').at(-1), ['hidden', false], '级联仍按勾选状态显示');
});

test('switching back to video re-enables the switch and restores the preserved check', () => {
  const fx = fixture();
  checkbox(fx).checked = true;
  vm.runInContext(`setMedia('D:\\\\Demo\\\\song.mp3')`, fx.context);
  vm.runInContext(`setMedia('D:\\\\Demo\\\\clip.mp4')`, fx.context);
  assert.equal(checkbox(fx).disabled, false, '视频输入恢复可用');
  assert.deepEqual(fieldToggles(fx, 'generateKeyframesField').at(-1), ['unavailable', false], '退出置灰态');
  assert.equal(checkbox(fx).checked, true, '恢复时保留用户勾选');
});

test('an unchecked switch stays unchecked and enabled across audio and video', () => {
  const fx = fixture();
  vm.runInContext(`setMedia('D:\\\\Demo\\\\voice.flac')`, fx.context);
  assert.equal(checkbox(fx).disabled, true);
  assert.equal(checkbox(fx).checked, false);
  vm.runInContext(`setMedia('D:\\\\Demo\\\\clip.mkv')`, fx.context);
  assert.equal(checkbox(fx).disabled, false);
  assert.equal(checkbox(fx).checked, false, '不偷偷替用户勾选');
});

test('typing an audio path disables the switch the same way as picking it', () => {
  const fx = fixture();
  vm.runInContext(`$('mediaPath').value = 'D:\\\\Demo\\\\take.wav'; syncThumbnailFields()`, fx.context);
  assert.equal(checkbox(fx).disabled, true);
  assert.deepEqual(fieldToggles(fx, 'generateKeyframesField').at(-1), ['unavailable', true]);
});

test('an empty media path leaves the default enabled state untouched', () => {
  const fx = fixture();
  vm.runInContext('syncThumbnailFields()', fx.context);
  assert.equal(checkbox(fx).disabled, false, '空路径保持默认可用');
  assert.deepEqual(fieldToggles(fx, 'generateKeyframesField').at(-1), ['unavailable', false]);
});

test('payload keeps reporting the preserved check while the switch is disabled', async () => {
  // 语义说明：disabled 复选框的 .checked 属性保留用户原选择，payload 不改写；
  // 音频转写时后端画面探测（load_or_build_base 早退）保证不生成任何画面缓存。
  const fx = fixture();
  checkbox(fx).checked = true;
  vm.runInContext(`setMedia('D:\\\\Demo\\\\song.mp3')`, fx.context);
  const payloadAudio = await vm.runInContext('formPayload()', fx.context);
  assert.equal(payloadAudio.generateKeyframes, true, '音频 + 禁用 + 原勾选：payload 保持 true');
  checkbox(fx).checked = false;
  const payloadUnchecked = await vm.runInContext('formPayload()', fx.context);
  assert.equal(payloadUnchecked.generateKeyframes, false, '音频 + 禁用 + 未勾选：payload 为 false');
  vm.runInContext(`setMedia('D:\\\\Demo\\\\clip.mp4')`, fx.context);
  checkbox(fx).checked = true;
  const payloadVideo = await vm.runInContext('formPayload()', fx.context);
  assert.equal(payloadVideo.generateKeyframes, true, '视频 + 可用 + 勾选：payload 为 true');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import { runtimeProject } from './helpers/runtime-project.mjs';

function waveformContext() {
  const utilities = { window: {} };
  loadEditorModule(utilities, 'shared/editor-utils.js');
  const context = { window: { ASR_EDITOR_PALETTE: [{ name: 'yellow', value: '#123456' }] } };
  context.window.AsrEditorUtils = utilities.window.AsrEditorUtils;
  context.window.MaweBoot = { DATA: runtimeProject([{ color_group_id: 'palette-yellow' }], {
    subtitle_groups: { next_id: 1, color: [{ id: 'palette-yellow', value: { name: 'yellow' } }], sticker: [] },
  }) };
  loadEditorModule(context, 'editor/media/waveform.js');
  return context;
}

test('split helpers share live trim state while separately created factories remain independent', () => {
  const context = { window: {} };
  loadEditorModule(context, 'shared/editor-utils.js');
  const utils = context.window.AsrEditorUtils;
  utils.setSplitTrimSymbols(['#']);
  assert.deepEqual({ ...utils.splitSubtitleText('hello#world', 6, 'continuous') }, { left: 'hello', right: 'world', offset: 6 });
  const isolatedContext = { window: {} };
  loadEditorModule(isolatedContext, 'shared/editor-utils.js');
  const isolated = isolatedContext.window.AsrEditorUtils;
  isolated.setSplitTrimSymbols(['@']);
  assert.equal(isolated.applySplitEdgeTrim('@hello@'), '@hello');
  assert.equal(utils.applySplitEdgeTrim('@hello@'), '@hello@');
  assert.equal(utils.applySplitEdgeTrim('#hello#'), '#hello');
});

test('utility consumers preserve a custom runtime method receiver and observe its current navigator', () => {
  const context = { window: {} };
  const runtime = {
    navigator: { platform: 'Win32' },
    getNavigator() { return this.navigator; },
  };
  loadEditorModule(context, 'shared/editor-utils.js', browser => {
    browser.MaweHost = { runtime };
  });
  const utils = context.window.AsrEditorUtils;
  assert.equal(utils.ASS_DEFAULT_ASS_STYLE.fontName, 'Microsoft YaHei');
  assert.equal(utils.isMacPlatform(), false);
  runtime.navigator = { platform: 'MacIntel' };
  assert.equal(utils.isMacPlatform(), true);
});

test('waveform composition preserves getter and non-enumerable class method descriptors', () => {
  const context = waveformContext();
  const media = context.window.MAWE.resolve('waveform-media', {});
  const playback = context.window.MAWE.resolve('waveform-playback', {});
  assert.equal(media.durationMs.enumerable, false);
  assert.equal(media.durationMs.configurable, true);
  assert.equal(typeof media.durationMs.get, 'function');
  assert.equal(media.durationMs.value, undefined);
  assert.equal(playback.updatePlayback.enumerable, false);
  assert.equal(playback.updatePlayback.writable, true);
  assert.equal(playback.updatePlayback.value.name, 'updatePlayback');
  const stub = Object.defineProperties({ payload: { duration_ms: 1234 } }, media);
  assert.equal(stub.durationMs, 1234);
  assert.deepEqual(Object.keys(stub), ['payload']);
});

test('palette consumers observe replacements through the same private module state', () => {
  const context = waveformContext();
  const colors = context.window.MAWE.resolve('waveform-colors', {
    getSubtitleGroupValue: (segment, kind) => context.window.AsrEditorUtils.getSubtitleGroupValue(context.window.MaweBoot.DATA, segment, kind),
  });
  const segment = context.window.AsrEditorUtils.getMainTrack(context.window.MaweBoot.DATA).segments[0];
  assert.equal(colors.colorForSegment(segment), '#123456');
  colors.setColorPalette([{ name: 'yellow', value: '#abcdef' }]);
  assert.equal(colors.colorForSegment(segment), '#abcdef');
});

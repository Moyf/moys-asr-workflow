// 媒体步进：seek 步长输入的钳制与刷新。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweMediaStep 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweMediaStep(global) {
  'use strict';



  function refreshMediaSeekInputStep(value = timelineMediaSeekStepValue()) {
    if (!MaweDom.mediaSeekStepInput) return;
    if (timelineIsFrameMode()) {
      MaweDom.mediaSeekStepInput.min = '1';
      MaweDom.mediaSeekStepInput.max = '240';
      MaweDom.mediaSeekStepInput.step = '1';
    } else {
      MaweDom.mediaSeekStepInput.min = String(MaweSettings.MEDIA_SEEK_STEP_MIN_MS);
      MaweDom.mediaSeekStepInput.max = String(MaweSettings.MEDIA_SEEK_STEP_MAX_MS);
      MaweDom.mediaSeekStepInput.step = String(MaweSettings.mediaSeekStepForValue(value));
    }
  }



  function commitMediaSeekStepInput(value, { rewriteInput = true } = {}) {
    const frameMode = timelineIsFrameMode();
    const normalized = frameMode
      ? window.AsrEditorUtils.clampTimelineFrameStep(value, 1)
      : MaweSettings.clampMediaSeekStepMs(value);
    if (rewriteInput && MaweDom.mediaSeekStepInput) MaweDom.mediaSeekStepInput.value = String(normalized);
    MaweDom.mediaSeekInputLastValue = normalized;
    MaweSettings.updateEditorSettings(frameMode
      ? { mediaSeekStepFrames: normalized }
      : { mediaSeekStepMs: normalized });
    refreshMediaSeekInputStep(normalized);
    MaweMediaPlayback.refreshMediaSeekStepHelp();
    MaweMediaPlayback.refreshMediaSeekControlLabels();
  }



  function adjustMediaSeekStepInput(direction) {
    if (!MaweDom.mediaSeekStepInput) return;
    if (timelineIsFrameMode()) {
      const current = window.AsrEditorUtils.clampTimelineFrameStep(MaweDom.mediaSeekStepInput.value, 1);
      commitMediaSeekStepInput(Math.min(240, Math.max(1, current + (direction < 0 ? -1 : 1))));
      return;
    }
    const current = MaweSettings.clampMediaSeekStepMs(MaweDom.mediaSeekStepInput.value);
    commitMediaSeekStepInput(MaweSettings.nextMediaSeekStepValue(current, direction));
  }

  global.MaweMediaStep = Object.freeze({
    refreshMediaSeekInputStep,
    commitMediaSeekStepInput,
    adjustMediaSeekStepInput
  });
})(typeof window !== 'undefined' ? window : globalThis);

// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';



import { MaweTimeline } from "../cues/editor-timeline.js";function refreshMediaSeekInputStep(value = MaweTimeline.timelineMediaSeekStepValue()) {
  if (!MaweDom.mediaSeekStepInput) return;
  if (MaweTimeline.timelineIsFrameMode()) {
    MaweDom.mediaSeekStepInput.min = '1';
    MaweDom.mediaSeekStepInput.max = '240';
    MaweDom.mediaSeekStepInput.step = '1';
  } else {
    MaweDom.mediaSeekStepInput.min = String(MaweSettings.MEDIA_SEEK_STEP_MIN_MS);
    MaweDom.mediaSeekStepInput.max = String(MaweSettings.MEDIA_SEEK_STEP_MAX_MS);
    MaweDom.mediaSeekStepInput.step = String(MaweSettings.mediaSeekStepForValue(value));
  }
}


import { MaweDom } from "../ui/editor-dom.js";
import { MaweMediaPlayback } from "./editor-media-playback.js";
import { MaweSettings } from "../state/editor-settings.js";function commitMediaSeekStepInput(value, { rewriteInput = true } = {}) {
  const frameMode = MaweTimeline.timelineIsFrameMode();
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
  if (MaweTimeline.timelineIsFrameMode()) {
    const current = window.AsrEditorUtils.clampTimelineFrameStep(MaweDom.mediaSeekStepInput.value, 1);
    commitMediaSeekStepInput(Math.min(240, Math.max(1, current + (direction < 0 ? -1 : 1))));
    return;
  }
  const current = MaweSettings.clampMediaSeekStepMs(MaweDom.mediaSeekStepInput.value);
  commitMediaSeekStepInput(MaweSettings.nextMediaSeekStepValue(current, direction));
}

window.MaweMediaStep = Object.freeze({
  refreshMediaSeekInputStep,
  commitMediaSeekStepInput,
  adjustMediaSeekStepInput
});

export const MaweMediaStep = Object.freeze({
    refreshMediaSeekInputStep,
    commitMediaSeekStepInput,
    adjustMediaSeekStepInput
  });
window.MaweMediaStep = MaweMediaStep;

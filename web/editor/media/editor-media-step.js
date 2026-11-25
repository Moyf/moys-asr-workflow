import { MaweTimeline } from '../cues/editor-timeline.js';
import { MaweSettings } from '../state/editor-settings.js';
import { MaweDom } from '../ui/editor-dom.js';
import { MaweMediaPlayback } from './editor-media-playback.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';
export let MaweMediaStep;
export function initMediaStepModule() {
// 媒体步进：seek 步长输入的钳制与刷新。
// 由 split-cluster codemod 自 editor.js 拆出。
(function initMaweMediaStep(global) {
  'use strict';



  function refreshMediaSeekInputStep(value = MaweTimeline.timelineMediaSeekStepValue()) {
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



  function commitMediaSeekStepInput(value, { rewriteInput = true } = {}) {
    const frameMode = MaweTimeline.timelineIsFrameMode();
    const normalized = frameMode
      ? AsrEditorUtils.clampTimelineFrameStep(value, 1)
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
      const current = AsrEditorUtils.clampTimelineFrameStep(MaweDom.mediaSeekStepInput.value, 1);
      commitMediaSeekStepInput(Math.min(240, Math.max(1, current + (direction < 0 ? -1 : 1))));
      return;
    }
    const current = MaweSettings.clampMediaSeekStepMs(MaweDom.mediaSeekStepInput.value);
    commitMediaSeekStepInput(MaweSettings.nextMediaSeekStepValue(current, direction));
  }

  MaweMediaStep = Object.freeze({
    refreshMediaSeekInputStep,
    commitMediaSeekStepInput,
    adjustMediaSeekStepInput
  });

})(typeof window !== 'undefined' ? window : globalThis);
}

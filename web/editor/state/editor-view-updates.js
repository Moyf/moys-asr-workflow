// 显式工程视图副作用：命令与历史适配器共享的统一失效入口。
import { MaweCuePanel } from '../cues/editor-cue-panel.js';
import { MaweServerSave } from '../io/editor-server-save.js';
import { MawePlaybackLoop } from '../media/editor-playback-loop.js';
import { MaweSpeakerManager } from '../styles/editor-speaker-manager.js';
import { MaweAssFrame } from '../styles/editor-wiring-ass-frame.js';
export let MaweViewUpdates;
export function createViewUpdates(dependencies) {
  'use strict';
  const { renderCues, updatePreview, refreshPreview, scheduleSave, patchCueRows, notifyProjectChanged, syncSpeakers } = dependencies;
  /** @param {ViewInvalidation} [options] */
  function invalidate({ cueList = false, waveform = 'overlay', preserveCueListScroll = true,
    cueListAnchor, cueListPatch = null, preview = false, save = false } = {}) {
    if (cueListPatch) patchCueRows(cueListPatch);
    else if (cueList) renderCues({ waveform, preserveCueListScroll, cueListAnchor });
    if (preview === 'update') updatePreview();
    else if (preview === 'refresh') refreshPreview();
    if (save) scheduleSave();
    // 字幕数据可能已变化：通知 ASS 实际画面重查预览（模块内部防抖，窗口与
    // 舞台叠加都关闭时自身直接返回）；可选链容错该模块晚于本文件加载。
    notifyProjectChanged?.();
    syncSpeakers?.();
  }
  return Object.freeze({ invalidate });
}

export function initMaweViewUpdates() {
  'use strict';
  MaweViewUpdates = createViewUpdates({
    renderCues: options => MaweCuePanel.renderAll(options),
    updatePreview: () => MawePlaybackLoop.updateWithoutCueListAutoScroll(),
    refreshPreview: () => MawePlaybackLoop.refreshSubtitlePreview(),
    scheduleSave: () => MaweServerSave.scheduleAutoSaveFlush(),
    patchCueRows: patch => MaweCuePanel.patchCueRows(patch),
    notifyProjectChanged: () => MaweAssFrame?.notifyProjectChanged?.(),
    syncSpeakers: () => MaweSpeakerManager?.sync?.(),
  });


}

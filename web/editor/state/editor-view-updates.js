// Explicit project view effects, shared by commands and history adapters.
window.MAWE.register('editor-view-updates', function createViewUpdates(dependencies) {
  'use strict';
  const { renderCues, updatePreview, refreshPreview, scheduleSave } = dependencies;
  /** @param {ViewInvalidation} [options] */
  function invalidate({ cueList = false, waveform = 'overlay', preserveCueListScroll = true,
    cueListAnchor, cueListPatch = null, preview = false, save = false } = {}) {
    if (cueListPatch) MaweCuePanel.patchCueRows(cueListPatch);
    else if (cueList) renderCues({ waveform, preserveCueListScroll, cueListAnchor });
    if (preview === 'update') updatePreview();
    else if (preview === 'refresh') refreshPreview();
    if (save) scheduleSave();
    // 字幕数据可能已变化：通知 ASS 实际画面重查预览（模块内部防抖，窗口与
    // 舞台叠加都关闭时自身直接返回）；可选链容错该模块晚于本文件加载。
    window.MaweAssFrame?.notifyProjectChanged?.();
  }
  return Object.freeze({ invalidate });
});
window.MaweViewUpdates = window.MAWE.resolve('editor-view-updates', {
  renderCues: options => MaweCuePanel.renderAll(options),
  updatePreview: () => MawePlaybackLoop.updateWithoutCueListAutoScroll(),
  refreshPreview: () => MawePlaybackLoop.refreshSubtitlePreview(),
  scheduleSave: () => MaweServerSave.scheduleAutoSaveFlush(),
});

// Explicit project view effects, shared by commands and history adapters.
window.MAWE.register('editor-view-updates', function createViewUpdates(dependencies) {
  'use strict';
  const { renderCues, updatePreview, refreshPreview, scheduleSave } = dependencies;
  /** @param {ViewInvalidation} [options] */
  function invalidate({ cueList = false, waveform = 'overlay', preserveCueListScroll = true,
    cueListAnchor, preview = false, save = false } = {}) {
    if (cueList) renderCues({ waveform, preserveCueListScroll, cueListAnchor });
    if (preview === 'update') updatePreview();
    else if (preview === 'refresh') refreshPreview();
    if (save) scheduleSave();
  }
  return Object.freeze({ invalidate });
});
window.MaweViewUpdates = window.MAWE.resolve('editor-view-updates', {
  renderCues: options => MaweCuePanel.renderAll(options),
  updatePreview: () => MawePlaybackLoop.updateWithoutCueListAutoScroll(),
  refreshPreview: () => MawePlaybackLoop.refreshSubtitlePreview(),
  scheduleSave: () => MaweServerSave.scheduleAutoSaveFlush(),
});

// 显式工程视图副作用：命令与历史适配器共享的统一失效入口。
// ESM 模块：createViewUpdates 为纯工厂具名导出（测试直调），
// initMaweViewUpdates 在原清单位次组装领域依赖并挂
// window.MaweViewUpdates（register/resolve 注册表随之退役）。
export function createViewUpdates(dependencies) {
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
    window.MaweSpeakerManager?.sync?.();
  }
  return Object.freeze({ invalidate });
}

export function initMaweViewUpdates() {
  'use strict';
  window.MaweViewUpdates = createViewUpdates({
    renderCues: options => MaweCuePanel.renderAll(options),
    updatePreview: () => MawePlaybackLoop.updateWithoutCueListAutoScroll(),
    refreshPreview: () => MawePlaybackLoop.refreshSubtitlePreview(),
    scheduleSave: () => MaweServerSave.scheduleAutoSaveFlush(),
  });
}

// Pure invalidation coordinator. The editor adapter lives in editor-view-updates.js.
/**
 * @param {{ renderCues: (options?: any) => void, patchCueRows?: (patch: any) => void,
 *   updatePreview: () => void, refreshPreview: () => void, scheduleSave: () => void }} dependencies
 */
export function createViewUpdates(dependencies) {
  const { renderCues, updatePreview, refreshPreview, scheduleSave } = dependencies;

  /** @type {(options?: any) => void} */
  const invalidate = (options = {}) => {
    const { cueList = false, waveform = 'overlay', preserveCueListScroll = true,
      cueListAnchor, cueListPatch = null, preview = false, save = false } = options;
    if (cueListPatch) dependencies.patchCueRows?.(cueListPatch);
    else if (cueList) renderCues({ waveform, preserveCueListScroll, cueListAnchor });
    if (preview === 'update') updatePreview();
    else if (preview === 'refresh') refreshPreview();
    if (save) scheduleSave();
  };

  return Object.freeze({ invalidate });
}

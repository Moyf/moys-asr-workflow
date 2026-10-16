


// 真 ESM：register+resolve 对 → 具名工厂导出（原注册名 editor-view-updates）。
import { MawePlaybackLoop } from "../media/editor-playback-loop.js";
import { MaweCuePanel } from "../cues/editor-cue-panel.js";

import { MaweServerSave } from "../io/editor-server-save.js";
import { createViewUpdates } from './editor-view-updates-factory.js';
export { createViewUpdates };
/**
 * @param {{ renderCues: (options?: any) => void, updatePreview: () => void,
 *   refreshPreview: () => void, scheduleSave: () => void }} dependencies
 */

/** @type {{ invalidate(options?: any): void }} */
export const MaweViewUpdates = /** @type {{ invalidate(options?: any): void }} */ (createViewUpdates({
  renderCues: options => MaweCuePanel.renderAll(options),
  patchCueRows: patch => MaweCuePanel.patchCueRows(patch),
  updatePreview: () => MawePlaybackLoop.updateWithoutCueListAutoScroll(),
  refreshPreview: () => MawePlaybackLoop.refreshSubtitlePreview(),
  scheduleSave: () => MaweServerSave.scheduleAutoSaveFlush(),
}));
if (typeof window !== 'undefined') window.MaweViewUpdates = MaweViewUpdates;

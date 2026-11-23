import { openOverlaySplitModal } from './editor-split-core.js';
import { mergeOverlaySegments } from './overlay-track.js';

export function initOverlaySplitMergeWiring() {
  // 浏览器回归仍通过门面打开叠加轨拆分。
  window.MaweOverlaySplitMerge = Object.freeze({ openOverlaySplitModal, mergeOverlaySegments });
}

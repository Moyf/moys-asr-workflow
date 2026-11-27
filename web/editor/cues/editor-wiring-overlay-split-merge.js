import { openOverlaySplitModal } from './editor-split-core.js';
import { mergeOverlaySegments } from './overlay-track.js';

export let MaweOverlaySplitMerge;

export function initOverlaySplitMergeWiring() {
  MaweOverlaySplitMerge = Object.freeze({ openOverlaySplitModal, mergeOverlaySegments });
}

// Normalize multi-subtitle state once after Editor services are ready.
import { MaweMultiSubtitleCore } from '../state/editor-multi-subtitle-core.js';
export function initOverlayTransferWiring() {
  MaweMultiSubtitleCore.normalizeMultiSubtitleState();
}

import { MaweBoot } from '../boot/editor-boot.js';
import { MaweCoreState } from '../state/editor-core-state.js';
import { MaweMultiSubtitleCore } from '../state/editor-multi-subtitle-core.js';
import { MaweSettings } from '../state/editor-settings.js';
import { MaweDom } from '../ui/editor-dom.js';
import { MaweColorFilter } from './editor-color-filter.js';
import { buildSearchRegex, calcCharWidth, cueElementHasTemporarySplitVisibility, getCharCountThreshold, setTextHtml } from './editor-cue-elements.js';
import { captureCueListRenderAnchor, restoreCueListRenderAnchor } from './editor-cue-list-anchor.js';
import { colorFilterSuspended, effectiveCueColorKey, speakerMatches } from './editor-color-filter.js';
import { getOverlayTrack } from './overlay-track.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';

// 搜索：过滤应用与防抖。
  // === 搜索 ===
export function applySearch(query, { refreshText = true, preserveCueListScroll = true } = {}) {
  const cueListAnchor = preserveCueListScroll ? captureCueListRenderAnchor() : null;
  try {
    const trimmed = query.trim();
    let visible = 0;
    const re = buildSearchRegex(trimmed, false);
    const filterOver = document.getElementById('filter-over').classList.contains('active');
    const threshold = getCharCountThreshold();
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    // 容器内还有布局拖拽栏和“加载工程后显示字幕列表”占位层；过滤只作用于真实字幕行。
    const cueElements = MaweCoreState.container.querySelectorAll(':scope > .cue');
    cueElements.forEach(el => {
      const mainIdx = el.dataset.mainIdx != null
        ? Number(el.dataset.mainIdx)
        : (el.dataset.idx != null ? Number(el.dataset.idx) : -1);
      const extIdx = el.dataset.extIdx != null ? Number(el.dataset.extIdx) : -1;
      const overlayIdx = el.dataset.overlayIdx != null ? Number(el.dataset.overlayIdx) : -1;
      const mainSeg = Number.isInteger(mainIdx) && mainIdx >= 0 ? AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[mainIdx] : null;
      const extensionSeg = Number.isInteger(extIdx) && extIdx >= 0 && extensionTrack
        ? extensionTrack.segments[extIdx] : null;
      const overlaySeg = Number.isInteger(overlayIdx) && overlayIdx >= 0
        ? getOverlayTrack()?.segments?.[overlayIdx] : null;
      const searchableText = [mainSeg?.text, extensionSeg?.text, overlaySeg?.text]
        .filter(Boolean).join('\n');
      if (!searchableText) {
        el.classList.add('hidden');
        return;
      }
      let matched = !re || re.test(searchableText);
      if (re) re.lastIndex = 0;
      if (matched && MaweColorFilter.colorFilterSelection && !colorFilterSuspended()) {
        matched = MaweColorFilter.colorFilterSelection.has(effectiveCueColorKey(mainSeg || extensionSeg || overlaySeg));
      }
      if (matched && MaweColorFilter.speakerFilterSelection) {
        matched = [mainSeg, extensionSeg, overlaySeg].some(segment => speakerMatches(segment));
      }
      const keepTemporaryVisible = filterOver
        && MaweSettings.EDITOR_SETTINGS.cueListKeepSplitVisible
        && cueElementHasTemporarySplitVisibility(el);
      if (matched && filterOver && !keepTemporaryVisible) {
        const count = (mainSeg ? calcCharWidth(mainSeg.text, MaweMultiSubtitleCore.getMainSubtitleSplitMode(mainSeg)) : 0)
          + (extensionSeg
            ? calcCharWidth(extensionSeg.text, MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(extensionTrack, extensionSeg))
            : 0)
          + (overlaySeg ? calcCharWidth(overlaySeg.text, MaweMultiSubtitleCore.getMainSubtitleSplitMode(overlaySeg)) : 0);
        matched = count > threshold;
      }
      el.classList.toggle('hidden', !matched);
      if (matched) visible++;
      if (refreshText && !el.classList.contains('editing')) {
        const mainTextEl = el.querySelector('.multi-cue-column.main .text');
        const extensionTextEl = el.querySelector('.multi-cue-column.extension .text');
        if (mainTextEl && mainSeg) setTextHtml(mainTextEl, mainSeg.text, trimmed);
        if (extensionTextEl && extensionSeg) setTextHtml(extensionTextEl, extensionSeg.text, trimmed);
        if (!mainTextEl && !extensionTextEl) {
          const textEl = el.querySelector('.text');
          if (textEl) setTextHtml(textEl, searchableText, trimmed);
        }
      }
    });
    MaweDom.visibleCountEl.textContent = visible;
  } finally {
    restoreCueListRenderAnchor(cueListAnchor);
  }
}


let searchDebounce = null;


export const MaweSearch = {
  applySearch,
  get searchDebounce() { return searchDebounce; },
  set searchDebounce(v) { searchDebounce = v; },
};
Object.freeze(MaweSearch);

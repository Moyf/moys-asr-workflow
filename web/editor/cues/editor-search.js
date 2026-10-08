// 搜索：过滤应用、防抖与清空按钮。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSearch 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweSearch(global) {
  'use strict';



  // === 搜索 ===
  function applySearch(query, { refreshText = true, preserveCueListScroll = true } = {}) {
  const cueListAnchor = preserveCueListScroll ? MaweCueListAnchor.captureCueListRenderAnchor() : null;
  try {
    const trimmed = query.trim();
    let visible = 0;
    const re = MaweCueElements.buildSearchRegex(trimmed, false);
    const filterOver = document.getElementById('filter-over').classList.contains('active');
    const threshold = MaweCueElements.getCharCountThreshold();
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    // 容器内还有布局拖拽栏和“加载工程后显示字幕列表”占位层；过滤只作用于真实字幕行。
    const cueElements = MaweCoreState.container.querySelectorAll(':scope > .cue');
    cueElements.forEach(el => {
      const mainIdx = el.dataset.mainIdx != null
        ? Number(el.dataset.mainIdx)
        : (el.dataset.idx != null ? Number(el.dataset.idx) : -1);
      const extIdx = el.dataset.extIdx != null ? Number(el.dataset.extIdx) : -1;
      const overlayIdx = el.dataset.overlayIdx != null ? Number(el.dataset.overlayIdx) : -1;
      const mainSeg = Number.isInteger(mainIdx) && mainIdx >= 0 ? MaweBoot.DATA.segments[mainIdx] : null;
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
      if (matched && MaweColorFilter.colorFilterSelection && !MaweColorFilter.colorFilterSuspended()) {
        matched = MaweColorFilter.colorFilterSelection.has(MaweColorFilter.effectiveCueColorKey(mainSeg || extensionSeg || overlaySeg));
      }
      const keepTemporaryVisible = filterOver
        && MaweSettings.EDITOR_SETTINGS.cueListKeepSplitVisible
        && MaweCueElements.cueElementHasTemporarySplitVisibility(el);
      if (matched && filterOver && !keepTemporaryVisible) {
        const count = (mainSeg ? MaweCueElements.calcCharWidth(mainSeg.text, MaweMultiSubtitleCore.getMainSubtitleSplitMode(mainSeg)) : 0)
          + (extensionSeg
            ? MaweCueElements.calcCharWidth(extensionSeg.text, MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(extensionTrack, extensionSeg))
            : 0)
          + (overlaySeg ? MaweCueElements.calcCharWidth(overlaySeg.text, MaweMultiSubtitleCore.getMainSubtitleSplitMode(overlaySeg)) : 0);
        matched = count > threshold;
      }
      el.classList.toggle('hidden', !matched);
      if (matched) visible++;
      if (refreshText && !el.classList.contains('editing')) {
        const mainTextEl = el.querySelector('.multi-cue-column.main .text');
        const extensionTextEl = el.querySelector('.multi-cue-column.extension .text');
        if (mainTextEl && mainSeg) MaweCueElements.setTextHtml(mainTextEl, mainSeg.text, trimmed);
        if (extensionTextEl && extensionSeg) MaweCueElements.setTextHtml(extensionTextEl, extensionSeg.text, trimmed);
        if (!mainTextEl && !extensionTextEl) {
          const textEl = el.querySelector('.text');
          if (textEl) MaweCueElements.setTextHtml(textEl, searchableText, trimmed);
        }
      }
    });
    MaweDom.visibleCountEl.textContent = visible;
  } finally {
    MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
  }
}


  let searchDebounce = null;


  const searchWrap = document.getElementById('search-wrap');


  function refreshSearchClearVisibility() {
    searchWrap.classList.toggle('has-value', MaweDom.searchEl.value.length > 0);
  }

  global.MaweSearch = Object.freeze({
    applySearch,
    get searchDebounce() { return searchDebounce; },
    set searchDebounce(v) { searchDebounce = v; },
    searchWrap,
    refreshSearchClearVisibility
  });
})(typeof window !== 'undefined' ? window : globalThis);

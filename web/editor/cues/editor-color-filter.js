import { speakerName, updateCueColorPresentation, updateCueStickerPresentation } from './editor-cue-elements.js';
import { commitCuePanelEdit, renderCurrentCuePanel } from './editor-cue-panel.js';
import { applySearch } from './editor-search.js';
import { clearSelection, isHiddenDisabled, updateMultiSelectionClasses } from './editor-selection.js';
import { getOverlayTrack } from './overlay-track.js';

export function initMaweColorFilter() {
'use strict';

// 颜色筛选：配色下拉、用量缓存与行色刷新。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweColorFilter 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweColorFilter(global) {
  'use strict';



  // === 颜色过滤 ===
  // 工程中存在彩色字幕时，在过滤输入框右侧显示 🎨 按钮：
  // 点击行（非 checkbox）= 只显示该颜色；勾选 checkbox = 多选；清除 = 全部显示。
  const COLOR_FILTER_DEFAULT_KEY = '__default__';
  const ui = text => window.MAWE_I18N?.translateText?.(text) || text;


  const colorFilterDropdown = document.getElementById('color-filter-dropdown');


  const colorFilterButton = document.getElementById('color-filter-btn');


  const colorFilterMenu = document.getElementById('color-filter-menu');


  let colorFilterSelection = null;
  // null = no identity filter; null inside the set means unassigned.
  let speakerFilterSelection = null;
  let speakerFilterProjectEpoch = MaweState.projectEpoch;

  function syncSpeakerFilterProject() {
    if (speakerFilterProjectEpoch !== MaweState.projectEpoch) {
      speakerFilterProjectEpoch = MaweState.projectEpoch;
      speakerFilterSelection = null;
    }
  }

  function speakerMatches(segment) {
    return Boolean(segment) && (!speakerFilterSelection || speakerFilterSelection.has(segment.speaker ?? null));
  }

  function setSpeakerFilterSelection(next) {
    syncSpeakerFilterProject();
    speakerFilterSelection = next && next.size ? new Set(next) : null;
    colorFilterButton?.classList.toggle('filter-active', Boolean((colorFilterSelection && !colorFilterSuspended()) || speakerFilterSelection));
    renderColorFilterMenu();
    applySearch(MaweDom.searchEl.value);
  }

   // null = 不过滤；Set<string> = 仅显示这些颜色键
  let colorFilterUsageCache = new Map();



  function effectiveCueColorKey(mainSeg) {
    if (!mainSeg) return COLOR_FILTER_DEFAULT_KEY;
    return window.AsrEditorUtils.effectiveColorName(mainSeg, window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments) || COLOR_FILTER_DEFAULT_KEY;
  }



  // 历史分类颜色仅在普通颜色用途、单列主轨显示时参与过滤。
  // 说话人筛选独立于此限制，始终按身份 ID 匹配。
  function colorFilterSuspended() {
    if (MaweBoot.DATA.annotation_mode === 'speaker') return true;
    if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return false;
    return MaweBoot.DATA.bilingual.display_mode !== 'main';
  }



  function collectProjectColorUsage() {
    const counts = new Map();
    window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.forEach((seg) => {
      const key = effectiveCueColorKey(seg);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }



  function colorFilterLabelFor(key) {
    if (key === COLOR_FILTER_DEFAULT_KEY) return '默认';
    return MaweColors.COLOR_BY_NAME[key]?.label || key;
  }



  function colorFilterValueFor(key) {
    return MaweColors.COLOR_BY_NAME[key]?.value || null;
  }



  function syncColorFilterControls() {
    renderColorFilterMenu();
    const hasColors = (!colorFilterSuspended()
      && [...colorFilterUsageCache.keys()].some((key) => key !== COLOR_FILTER_DEFAULT_KEY))
      || (MaweBoot.DATA.speakers || []).length > 0 || Boolean(speakerFilterSelection);
    colorFilterButton?.toggleAttribute('hidden', !hasColors);
    colorFilterButton?.classList.toggle('filter-active', Boolean((colorFilterSelection && !colorFilterSuspended()) || speakerFilterSelection));
  }



  function renderColorFilterMenu() {
    syncSpeakerFilterProject();
    if (!colorFilterMenu) return;
    const usage = colorFilterUsageCache;
    // 过滤掉工程里已不存在的选择项，避免按钮显示“过滤中”但列表为空。
    if (colorFilterSelection) {
      const kept = new Set([...colorFilterSelection].filter((key) => usage.has(key)));
      colorFilterSelection = kept.size ? kept : null;
    }
    const keys = [COLOR_FILTER_DEFAULT_KEY];
    MaweColors.COLOR_PALETTE.forEach((palette) => { if (usage.has(palette.name)) keys.push(palette.name); });
    usage.forEach((_count, key) => { if (!keys.includes(key)) keys.push(key); });
    colorFilterMenu.replaceChildren();
    const speakerHeading = document.createElement('div');
    speakerHeading.className = 'dropdown-item';
    speakerHeading.textContent = ui('按说话人筛选');
    colorFilterMenu.appendChild(speakerHeading);
    const tracks = [window.AsrEditorUtils.getMainTrack(MaweBoot.DATA), MaweMultiSubtitleCore.getActiveExtensionTrack(), getOverlayTrack()].filter(Boolean);
    const segments = [...new Set(tracks)].flatMap(track => track.segments || []);
    const speakerCounts = new Map();
    segments.forEach(segment => {
      const id = segment.speaker ?? null;
      speakerCounts.set(id, (speakerCounts.get(id) || 0) + 1);
    });
    const identities = [{ id: null }, ...(MaweBoot.DATA.speakers || [])];
    if (speakerFilterSelection) {
      const available = new Set(identities.map(speaker => speaker.id));
      const kept = new Set([...speakerFilterSelection].filter(id => available.has(id)));
      speakerFilterSelection = kept.size ? kept : null;
      colorFilterButton?.classList.toggle('filter-active', Boolean((colorFilterSelection && !colorFilterSuspended()) || speakerFilterSelection));
    }
    identities.forEach(speaker => {
      const count = speakerCounts.get(speaker.id) || 0;
      const label = document.createElement('label');
      label.className = 'speaker-filter-item';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(speakerFilterSelection?.has(speaker.id));
      input.addEventListener('change', () => {
        const next = new Set(speakerFilterSelection || []);
        if (input.checked) next.add(speaker.id); else next.delete(speaker.id);
        setSpeakerFilterSelection(next);
      });
      const dot = document.createElement('span');
      dot.className = `color-dot${speaker.id === null ? ' is-default' : ''}`;
      if (speaker.color) dot.style.background = speaker.color;
      const name = document.createElement('span');
      name.className = 'color-name';
      name.dataset.speakerProjectContent = '';
      name.textContent = speaker.id === null ? speakerName(null) : `${speakerName(speaker)}（${speaker.id}）`;
      label.dataset.speakerProjectContent = '';
      label.title = window.MAWE_I18N?.language === 'en'
        ? `${name.textContent}: ${count} subtitles` : `${name.textContent}：${count} 条字幕`;
      const total = document.createElement('span');
      total.className = 'color-count';
      total.textContent = String(count);
      label.append(input, dot, name, total);
      label.addEventListener('click', event => {
        if (event.target === input) return;
        event.preventDefault(); event.stopPropagation();
        setSpeakerFilterSelection(new Set([speaker.id]));
      });
      colorFilterMenu.appendChild(label);
    });
    const clearSpeakers = document.createElement('button');
    clearSpeakers.type = 'button';
    clearSpeakers.className = 'dropdown-item';
    clearSpeakers.textContent = ui('清除说话人过滤');
    clearSpeakers.hidden = !speakerFilterSelection;
    clearSpeakers.addEventListener('click', () => setSpeakerFilterSelection(null));
    colorFilterMenu.appendChild(clearSpeakers);
    if (colorFilterSuspended()) return;
    const colorHeading = document.createElement('div');
    colorHeading.className = 'dropdown-item';
    colorHeading.textContent = ui('按颜色筛选');
    colorFilterMenu.appendChild(colorHeading);
    keys.forEach((key) => {
      colorFilterMenu.appendChild(buildColorFilterItem(key, usage.get(key) || 0));
    });
    const selectFilteredBtn = document.createElement('button');
    selectFilteredBtn.type = 'button';
    selectFilteredBtn.className = 'dropdown-item color-filter-select-all';
    selectFilteredBtn.textContent = ui('全选过滤结果');
    selectFilteredBtn.hidden = !colorFilterSelection;
    selectFilteredBtn.addEventListener('click', () => selectAllFilteredCues());
    colorFilterMenu.appendChild(selectFilteredBtn);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'dropdown-item color-filter-clear';
    clearBtn.textContent = ui('清除颜色过滤');
    clearBtn.hidden = !colorFilterSelection;
    clearBtn.addEventListener('click', () => setColorFilterSelection(null));
    colorFilterMenu.appendChild(clearBtn);
  }



  function setColorFilterSelection(next) {
    colorFilterSelection = next && next.size ? new Set(next) : null;
    colorFilterButton?.classList.toggle('filter-active', Boolean((colorFilterSelection && !colorFilterSuspended()) || speakerFilterSelection));
    renderColorFilterMenu();
    applySearch(MaweDom.searchEl.value);
  }



  function selectAllFilteredCues() {
  // 颜色过滤只作用于主轨字幕列表，这里同样只选中主轨里过滤命中的字幕，
  // 便于配合「批量替换（仅选中）」等按选区工作的工具，例如给不同说话人加前缀。
  if (!colorFilterSelection || colorFilterSuspended()) {
    MaweHint.flashHint('当前没有生效的颜色过滤', 'invalid');
    return;
  }
  commitCuePanelEdit();
  clearSelection({ silent: true });
  window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.forEach((seg, idx) => {
    if (isHiddenDisabled(idx)) return;
    if (!colorFilterSelection.has(effectiveCueColorKey(seg))) return;
    MaweState.selection.add('main', idx);
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
    if (el) el.classList.add('selected');
  });
  updateMultiSelectionClasses();
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  window.MaweCuePanelWiring.updateSelectionCountText();
  MaweHint.flashHint(`已选中 ${MaweSelection.selectedIdxs.size} 条过滤字幕`, MaweSelection.selectedIdxs.size ? 'success' : 'invalid');
}



  function buildColorFilterItem(key, count) {
    const label = document.createElement('label');
    label.className = 'color-filter-item';
    label.dataset.colorKey = key;
    label.title = `该颜色的字幕共 ${count} 条；点击条目只显示此颜色，勾选可多选`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(colorFilterSelection?.has(key));
    input.addEventListener('change', () => {
      const next = new Set(colorFilterSelection || []);
      if (input.checked) next.add(key); else next.delete(key);
      setColorFilterSelection(next);
    });
    const dot = document.createElement('span');
    dot.className = `color-dot${key === COLOR_FILTER_DEFAULT_KEY ? ' is-default' : ''}`;
    const value = colorFilterValueFor(key);
    if (value) dot.style.background = value;
    const nameEl = document.createElement('span');
    nameEl.className = 'color-name';
    nameEl.textContent = ui(colorFilterLabelFor(key));
    const countEl = document.createElement('span');
    countEl.className = 'color-count';
    countEl.textContent = String(count);
    label.addEventListener('click', (event) => {
      // checkbox 自身的多选行为走 change 事件；点击行内其余区域 = 仅显示该颜色。
      // 行内点击会同步重建菜单，必须阻止冒泡，否则点击目标脱离下拉容器后
      // 会命中 document 的“点击外部关闭”逻辑，把刚选中的菜单关掉。
      if (event.target === input) return;
      event.preventDefault();
      event.stopPropagation();
      setColorFilterSelection(new Set([key]));
    });
    label.append(input, dot, nameEl, countEl);
    return label;
  }



  function refreshColorFilterUi() {
    colorFilterUsageCache = collectProjectColorUsage();
    syncColorFilterControls();
  }

  document.addEventListener('mawe:languagechange', () => {
    if (window.MaweBoot?.DATA && window.MaweMultiSubtitleCore) renderColorFilterMenu();
  });



  function refreshCueColorRows() {
    MaweMultiSubtitleCore.invalidateSegmentPresentation?.();
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  MaweCoreState.container.querySelectorAll(':scope > .cue').forEach((el) => {
    const colorBar = el.querySelector(':scope > .color-bar');
    if (!colorBar) return;
    if (el.dataset.overlayIdx != null) {
      const overlayIndex = Number(el.dataset.overlayIdx);
      const segment = Number.isInteger(overlayIndex)
        ? getOverlayTrack()?.segments?.[overlayIndex]
        : null;
      if (segment) updateCueColorPresentation(el, colorBar, segment);
      return;
    }
    if (el.dataset.extIdx != null && el.dataset.idx == null) {
      const extensionIndex = Number(el.dataset.extIdx);
      const segment = Number.isInteger(extensionIndex)
        ? extensionTrack?.segments?.[extensionIndex]
        : null;
      if (segment) updateCueColorPresentation(el, colorBar, segment);
      return;
    }
    const mainIndex = el.dataset.idx != null
      ? Number(el.dataset.idx)
      : (el.dataset.mainIdx != null ? Number(el.dataset.mainIdx) : -1);
    const segment = Number.isInteger(mainIndex) && mainIndex >= 0
      ? window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[mainIndex]
      : null;
    if (segment) updateCueColorPresentation(el, colorBar, segment);
  });
}



  function refreshCueStickerRows() {
    MaweMultiSubtitleCore.invalidateSegmentPresentation?.();
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  MaweCoreState.container.querySelectorAll(':scope > .cue').forEach((el) => {
    const slotEl = el.querySelector(':scope > .sticker-slot');
    if (!slotEl) return;
    if (el.dataset.overlayIdx != null) {
      const overlayIndex = Number(el.dataset.overlayIdx);
      const segment = Number.isInteger(overlayIndex)
        ? getOverlayTrack()?.segments?.[overlayIndex]
        : null;
      if (segment) updateCueStickerPresentation(el, slotEl, segment, overlayIndex, { overlayTrack: true });
      return;
    }
    const isExtension = el.dataset.extIdx != null && el.dataset.idx == null;
    const index = Number(isExtension ? el.dataset.extIdx : (el.dataset.idx ?? el.dataset.mainIdx));
    const segment = isExtension
      ? (Number.isInteger(index) ? extensionTrack?.segments?.[index] : null)
      : (Number.isInteger(index) && index >= 0 ? window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index] : null);
    if (segment) {
      updateCueStickerPresentation(el, slotEl, segment, index, {
        extensionTrack: isExtension ? extensionTrack : null,
      });
    }
  });
}



  function refreshStickerAssignmentUi() {
  // 表情包分配只改变行内槽位和预览素材，不改变字幕行的数量、顺序或时间；
  // 原地更新可以避免 renderAll() 替换列表节点后产生滚动闪烁。
  refreshCueStickerRows();
  const overlaySegments = getOverlayTrack()?.segments || [];
  const projectHasStickers = window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.some((segment) => segment.sticker_group_id)
    || overlaySegments.some((segment) => segment.sticker_group_id);
  MaweCoreState.container.classList.toggle('hide-cue-sticker',
    !MaweSettings.EDITOR_SETTINGS.cueListShowSticker || !projectHasStickers,
  );
  MaweStickerOverlay.stickerOverlayDataVersion += 1;
  // 表情包变化影响波形块上的 🦊 徽章分组；颜色走 updateCueColorPresentation
  // 自行刷新，徽章需要整层重建才会重新计数。
  MaweCoreState.waveformEditor?.refreshCueOverlay?.();
  renderCurrentCuePanel();
  MawePlaybackLoop.refreshSubtitlePreview();
}



  function refreshColorAssignmentUi() {
    // 颜色是字幕属性，不改变行的数量、顺序或高度；直接更新现有节点，
    // 避免 renderAll() 替换列表后触发浏览器布局回填和活动字幕自动跟随。
    refreshCueColorRows();
    refreshColorFilterUi();
    // 颜色过滤开启时，颜色变化可能改变当前行的显隐；只重新计算 class，
    // 不保存/恢复滚动位置，也不主动滚动。
    if (MaweDom.searchEl.value || colorFilterSelection
        || document.getElementById('filter-over')?.classList.contains('active')) {
      applySearch(MaweDom.searchEl.value, { refreshText: false, preserveCueListScroll: false });
    }
    MaweCoreState.waveformEditor?.refreshCueOverlay?.();
    MawePlaybackLoop.refreshSubtitlePreview();
    MaweExportSrt.updateSubtitleExportUi();
  }


  function positionColorFilterMenu() {
    if (!colorFilterDropdown?.classList.contains('open') || !colorFilterButton || !colorFilterMenu) return;
    const buttonRect = colorFilterButton.getBoundingClientRect();
    const menuWidth = colorFilterMenu.offsetWidth;
    const menuHeight = colorFilterMenu.offsetHeight;
    const margin = 8;
    const left = Math.min(
      Math.max(margin, buttonRect.left),
      Math.max(margin, window.innerWidth - menuWidth - margin),
    );
    const belowTop = buttonRect.bottom + 6;
    const aboveTop = buttonRect.top - menuHeight - 6;
    let top = belowTop;
    if (belowTop + menuHeight > window.innerHeight - margin && aboveTop >= margin) {
      top = aboveTop;
    } else if (belowTop + menuHeight > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - menuHeight - margin);
    }
    colorFilterMenu.style.left = `${left}px`;
    colorFilterMenu.style.top = `${top}px`;
  }

  global.MaweColorFilter = Object.freeze({
    COLOR_FILTER_DEFAULT_KEY,
    colorFilterDropdown,
    colorFilterButton,
    colorFilterMenu,
    get colorFilterSelection() { return colorFilterSelection; },
    get speakerFilterSelection() { syncSpeakerFilterProject(); return speakerFilterSelection; },
    speakerMatches,
    setSpeakerFilterSelection,
    set colorFilterSelection(v) { colorFilterSelection = v; },
    get colorFilterUsageCache() { return colorFilterUsageCache; },
    set colorFilterUsageCache(v) { colorFilterUsageCache = v; },
    effectiveCueColorKey,
    colorFilterSuspended,
    collectProjectColorUsage,
    colorFilterLabelFor,
    colorFilterValueFor,
    syncColorFilterControls,
    renderColorFilterMenu,
    setColorFilterSelection,
    selectAllFilteredCues,
    buildColorFilterItem,
    refreshColorFilterUi,
    refreshCueColorRows,
    refreshCueStickerRows,
    refreshStickerAssignmentUi,
    refreshColorAssignmentUi,
    positionColorFilterMenu
  });
})(typeof window !== 'undefined' ? window : globalThis);
}

export function COLOR_FILTER_DEFAULT_KEY(...args) { return window.MaweColorFilter.COLOR_FILTER_DEFAULT_KEY(...args); }
export function speakerMatches(...args) { return window.MaweColorFilter.speakerMatches(...args); }
export function colorFilterDropdown(...args) { return window.MaweColorFilter.colorFilterDropdown(...args); }
export function colorFilterButton(...args) { return window.MaweColorFilter.colorFilterButton(...args); }
export function colorFilterMenu(...args) { return window.MaweColorFilter.colorFilterMenu(...args); }
export function effectiveCueColorKey(...args) { return window.MaweColorFilter.effectiveCueColorKey(...args); }
export function colorFilterSuspended(...args) { return window.MaweColorFilter.colorFilterSuspended(...args); }
export function collectProjectColorUsage(...args) { return window.MaweColorFilter.collectProjectColorUsage(...args); }
export function colorFilterLabelFor(...args) { return window.MaweColorFilter.colorFilterLabelFor(...args); }
export function colorFilterValueFor(...args) { return window.MaweColorFilter.colorFilterValueFor(...args); }
export function syncColorFilterControls(...args) { return window.MaweColorFilter.syncColorFilterControls(...args); }
export function renderColorFilterMenu(...args) { return window.MaweColorFilter.renderColorFilterMenu(...args); }
export function setColorFilterSelection(...args) { return window.MaweColorFilter.setColorFilterSelection(...args); }
export function selectAllFilteredCues(...args) { return window.MaweColorFilter.selectAllFilteredCues(...args); }
export function buildColorFilterItem(...args) { return window.MaweColorFilter.buildColorFilterItem(...args); }
export function refreshColorFilterUi(...args) { return window.MaweColorFilter.refreshColorFilterUi(...args); }
export function refreshCueColorRows(...args) { return window.MaweColorFilter.refreshCueColorRows(...args); }
export function refreshCueStickerRows(...args) { return window.MaweColorFilter.refreshCueStickerRows(...args); }
export function refreshStickerAssignmentUi(...args) { return window.MaweColorFilter.refreshStickerAssignmentUi(...args); }
export function refreshColorAssignmentUi(...args) { return window.MaweColorFilter.refreshColorAssignmentUi(...args); }
export function positionColorFilterMenu(...args) { return window.MaweColorFilter.positionColorFilterMenu(...args); }

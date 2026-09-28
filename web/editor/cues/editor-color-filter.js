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


  const colorFilterDropdown = document.getElementById('color-filter-dropdown');


  const colorFilterButton = document.getElementById('color-filter-btn');


  const colorFilterMenu = document.getElementById('color-filter-menu');


  let colorFilterSelection = null;

   // null = 不过滤；Set<string> = 仅显示这些颜色键
  let colorFilterUsageCache = new Map();



  function effectiveCueColorKey(mainSeg) {
    if (!mainSeg) return COLOR_FILTER_DEFAULT_KEY;
    return window.AsrEditorUtils.effectiveColorName(mainSeg, MaweBoot.DATA.segments) || COLOR_FILTER_DEFAULT_KEY;
  }



  // 双列 / 仅副轨显示模式下，列表行不携带颜色条：按钮隐藏且过滤暂停生效，
  // 避免出现“看不到过滤开关但列表被过滤”的死角。只有单列主轨列表参与过滤。
  function colorFilterSuspended() {
    if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return false;
    return MaweMultiSubtitleCore.getMultiSubtitleState().display_mode !== 'main';
  }



  function collectProjectColorUsage() {
    const counts = new Map();
    MaweBoot.DATA.segments.forEach((seg) => {
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
    const hasColors = !colorFilterSuspended()
      && [...colorFilterUsageCache.keys()].some((key) => key !== COLOR_FILTER_DEFAULT_KEY);
    colorFilterButton?.toggleAttribute('hidden', !hasColors);
    colorFilterButton?.classList.toggle('filter-active', Boolean(colorFilterSelection));
    renderColorFilterMenu();
  }



  function renderColorFilterMenu() {
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
    keys.forEach((key) => {
      colorFilterMenu.appendChild(buildColorFilterItem(key, usage.get(key) || 0));
    });
    const selectFilteredBtn = document.createElement('button');
    selectFilteredBtn.type = 'button';
    selectFilteredBtn.className = 'dropdown-item color-filter-select-all';
    selectFilteredBtn.textContent = '全选过滤结果';
    selectFilteredBtn.hidden = !colorFilterSelection;
    selectFilteredBtn.addEventListener('click', () => selectAllFilteredCues());
    colorFilterMenu.appendChild(selectFilteredBtn);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'dropdown-item color-filter-clear';
    clearBtn.textContent = '清除颜色过滤';
    clearBtn.hidden = !colorFilterSelection;
    clearBtn.addEventListener('click', () => setColorFilterSelection(null));
    colorFilterMenu.appendChild(clearBtn);
  }



  function setColorFilterSelection(next) {
    colorFilterSelection = next && next.size ? new Set(next) : null;
    renderColorFilterMenu();
    MaweSearch.applySearch(MaweDom.searchEl.value);
  }



  function selectAllFilteredCues() {
  // 颜色过滤只作用于主轨字幕列表，这里同样只选中主轨里过滤命中的字幕，
  // 便于配合「批量替换（仅选中）」等按选区工作的工具，例如给不同说话人加前缀。
  if (!colorFilterSelection || colorFilterSuspended()) {
    MaweHint.flashHint('当前没有生效的颜色过滤', 'invalid');
    return;
  }
  MaweCuePanel.commitCuePanelEdit();
  MaweSelection.clearSelection({ silent: true });
  MaweBoot.DATA.segments.forEach((seg, idx) => {
    if (MaweSelection.isHiddenDisabled(idx)) return;
    if (!colorFilterSelection.has(effectiveCueColorKey(seg))) return;
    MaweState.selection.add('main', idx);
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
    if (el) el.classList.add('selected');
  });
  MaweSelection.updateMultiSelectionClasses();
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  updateSelectionCountText();
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
    nameEl.textContent = colorFilterLabelFor(key);
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



  function refreshCueColorRows() {
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  MaweCoreState.container.querySelectorAll(':scope > .cue').forEach((el) => {
    const colorBar = el.querySelector(':scope > .color-bar');
    if (!colorBar) return;
    if (el.dataset.overlayIdx != null) {
      const overlayIndex = Number(el.dataset.overlayIdx);
      const segment = Number.isInteger(overlayIndex)
        ? getOverlayTrack()?.segments?.[overlayIndex]
        : null;
      if (segment) MaweCueElements.updateCueColorPresentation(el, colorBar, segment);
      return;
    }
    if (el.dataset.extIdx != null && el.dataset.idx == null) {
      const extensionIndex = Number(el.dataset.extIdx);
      const segment = Number.isInteger(extensionIndex)
        ? extensionTrack?.segments?.[extensionIndex]
        : null;
      if (segment) MaweCueElements.updateCueColorPresentation(el, colorBar, segment);
      return;
    }
    const mainIndex = el.dataset.idx != null
      ? Number(el.dataset.idx)
      : (el.dataset.mainIdx != null ? Number(el.dataset.mainIdx) : -1);
    const segment = Number.isInteger(mainIndex) && mainIndex >= 0
      ? MaweBoot.DATA.segments[mainIndex]
      : null;
    if (segment) MaweCueElements.updateCueColorPresentation(el, colorBar, segment);
  });
}



  function refreshCueStickerRows() {
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  MaweCoreState.container.querySelectorAll(':scope > .cue').forEach((el) => {
    const slotEl = el.querySelector(':scope > .sticker-slot');
    if (!slotEl) return;
    if (el.dataset.overlayIdx != null) {
      const overlayIndex = Number(el.dataset.overlayIdx);
      const segment = Number.isInteger(overlayIndex)
        ? getOverlayTrack()?.segments?.[overlayIndex]
        : null;
      if (segment) MaweCueElements.updateCueStickerPresentation(el, slotEl, segment, overlayIndex, { overlayTrack: true });
      return;
    }
    const isExtension = el.dataset.extIdx != null && el.dataset.idx == null;
    const index = Number(isExtension ? el.dataset.extIdx : (el.dataset.idx ?? el.dataset.mainIdx));
    const segment = isExtension
      ? (Number.isInteger(index) ? extensionTrack?.segments?.[index] : null)
      : (Number.isInteger(index) && index >= 0 ? MaweBoot.DATA.segments[index] : null);
    if (segment) {
      MaweCueElements.updateCueStickerPresentation(el, slotEl, segment, index, {
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
  const projectHasStickers = MaweBoot.DATA.segments.some((segment) => segment.sticker || segment.sticker_ref)
    || overlaySegments.some((segment) => segment.sticker || segment.sticker_ref);
  MaweCoreState.container.classList.toggle('hide-cue-sticker',
    !MaweSettings.EDITOR_SETTINGS.cueListShowSticker || !projectHasStickers,
  );
  MaweStickerOverlay.stickerOverlayDataVersion += 1;
  // 表情包变化影响波形块上的 🦊 徽章分组；颜色走 updateCueColorPresentation
  // 自行刷新，徽章需要整层重建才会重新计数。
  MaweCoreState.waveformEditor?.refreshCueOverlay?.();
  MaweCuePanel.renderCurrentCuePanel();
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
      MaweSearch.applySearch(MaweDom.searchEl.value, { refreshText: false, preserveCueListScroll: false });
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

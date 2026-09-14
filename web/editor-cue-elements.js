// 字幕行元素构建：单列/双列 DOM、颜色与表情包呈现。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweCueElements 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweCueElements(global) {
  'use strict';



  function updateCueColorPresentation(el, colorBar, seg) {
    if (!el || !colorBar || !seg) return;

    // 颜色组可能在不重建字幕行的情况下从 head 变成 ref（或反过来）。
    // 绑定一次委托式处理器，之后只更新 class / style / data，不替换节点。
    if (!colorBar.dataset.colorRefHandlerBound) {
      colorBar.addEventListener('click', (event) => {
        if (!colorBar.classList.contains('is-ref')) return;
        event.stopPropagation();
        const row = colorBar.closest('.cue');
        const headIndex = Number(colorBar.dataset.colorRefHeadIdx);
        if (!Number.isInteger(headIndex) || headIndex < 0) return;
        const isExtension = row?.dataset.extIdx != null && row?.dataset.idx == null;
        const head = MaweCoreState.container.querySelector(
          isExtension ? `.cue[data-ext-idx="${headIndex}"]` : `.cue[data-idx="${headIndex}"]`,
        );
        if (!head) return;
        MaweCueListAnchor.scrollCueToCenter(head);
        if (isExtension) MaweSelection.selectOnlyExtension(headIndex);
        else MaweSelection.selectOnly(headIndex);
      });
      colorBar.dataset.colorRefHandlerBound = 'true';
    }

    colorBar.classList.remove('has-color', 'is-ref');
    colorBar.style.removeProperty('--color-bar');
    colorBar.style.removeProperty('cursor');
    colorBar.removeAttribute('title');
    delete colorBar.dataset.colorRefHeadIdx;
    el.classList.remove('has-color');
    el.style.removeProperty('--color-bar');

    if (seg.color) {
      const value = seg.color.value || MaweColors.colorValue(seg.color.name);
      colorBar.classList.add('has-color');
      colorBar.style.setProperty('--color-bar', value);
      el.classList.add('has-color');
      el.style.setProperty('--color-bar', value);
      colorBar.title = `颜色：${seg.color.name}`;
    } else if (seg.color_ref) {
      const value = MaweColors.colorValue(seg.color_ref.name);
      const headIndex = Number(seg.color_ref.headIdx);
      colorBar.classList.add('is-ref');
      colorBar.style.setProperty('--color-bar', value);
      colorBar.dataset.colorRefHeadIdx = String(headIndex);
      el.classList.add('has-color');
      el.style.setProperty('--color-bar', value);
      colorBar.title = `↑ 属于第 ${headIndex + 1} 条的颜色（${seg.color_ref.name}）`;
      colorBar.style.cursor = 'pointer';
    }
  }



  function updateCueStickerPresentation(el, slotEl, seg, idx, { extensionTrack = null } = {}) {
    if (!el || !slotEl || !seg) return;
    const isExtension = Boolean(extensionTrack);
    slotEl.classList.remove('ref');
    slotEl.replaceChildren();
    if (seg.sticker) {
      const img = document.createElement('img');
      img.src = MaweSelection.stickerUrl(seg.sticker);
      img.alt = seg.sticker.name || '表情包';
      img.title = seg.sticker.name || '表情包';
      img.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!isExtension) MaweStickerPicker.openStickerPreview(idx);
      });
      const nameEl = document.createElement('div');
      nameEl.className = 'sname';
      nameEl.textContent = seg.sticker.name || '表情包';
      slotEl.append(img, nameEl);
    } else if (seg.sticker_ref) {
      // 跨多句的引用，只显示名称（带↑标识属于上方）
      slotEl.classList.add('ref');
      const refEl = document.createElement('div');
      const headIndex = Number(seg.sticker_ref.headIdx);
      const name = seg.sticker_ref.name || '表情包';
      refEl.className = 'sref';
      refEl.textContent = `↑ ${name}`;
      refEl.title = `属于上方第 ${Number.isInteger(headIndex) ? headIndex + 1 : '?'} 条的表情包`;
      refEl.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!Number.isInteger(headIndex) || headIndex < 0) return;
        const head = MaweCoreState.container.querySelector(
          isExtension ? `.cue[data-ext-idx="${headIndex}"]` : `.cue[data-idx="${headIndex}"]`,
        );
        if (!head) return;
        MaweCueListAnchor.scrollCueToCenter(head);
        if (isExtension) MaweSelection.selectOnlyExtension(headIndex, extensionTrack);
        else MaweSelection.selectOnly(headIndex);
      });
      slotEl.appendChild(refEl);
    }
  }



  function buildCueEl(seg, idx, { extensionTrack = null } = {}) {
    const isExtension = Boolean(extensionTrack);
    const el = document.createElement('div');
    el.className = MaweMultiSubtitleCore.multiSubtitleVisible() ? 'cue multi-cue' : 'cue';
    setCueListIdentity(el, seg, extensionTrack);
    if (isExtension) {
      el.classList.add('multi-extension-cue');
      el.dataset.extIdx = String(idx);
    } else {
      el.dataset.idx = idx;
      if (MaweMultiSubtitleCore.multiSubtitleVisible()) el.dataset.mainIdx = String(idx);
    }
    if (seg._dirty) el.classList.add('dirty');
    if (seg.disabled) el.classList.add('disabled');

    // 颜色条（最左）
    const colorBar = document.createElement('span');
    colorBar.className = 'color-bar';
    updateCueColorPresentation(el, colorBar, seg);

    const indexEl = document.createElement('span');
    indexEl.className = 'index';
    indexEl.textContent = String(idx + 1);

    const timeEl = document.createElement('span');
    timeEl.className = 'time';
    const timeStartEl = document.createElement('span');
    timeStartEl.className = 'time-start';
    timeStartEl.textContent = fmtShort(seg.start);
    const timeArrowEl = document.createElement('span');
    timeArrowEl.className = 'time-arrow';
    timeArrowEl.textContent = '→';
    const timeEndEl = document.createElement('span');
    timeEndEl.className = 'time-end';
    timeEndEl.textContent = fmtShort(seg.end);
    timeEl.append(timeStartEl, timeArrowEl, timeEndEl);

    // 表情包槽位
    const slotEl = document.createElement('span');
    slotEl.className = 'sticker-slot';
    updateCueStickerPresentation(el, slotEl, seg, idx, { extensionTrack });

    const textEl = document.createElement('span');
    textEl.className = 'text';
    setTextHtml(textEl, seg.text, MaweDom.searchEl.value);

    const cntEl = document.createElement('span');
    cntEl.className = 'charcount';
    applyCharCount(
      cntEl,
      seg.text,
      isExtension ? MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(extensionTrack, seg) : MaweMultiSubtitleCore.getMainSubtitleSplitMode(seg),
    );

    el.appendChild(colorBar);
    el.appendChild(indexEl);
    el.appendChild(timeEl);
    el.appendChild(slotEl);
    el.appendChild(textEl);
    el.appendChild(cntEl);

    if (isExtension) MaweInlineEdit.bindExtensionCueEvents(el, idx, extensionTrack);
    else MaweCueEvents.bindCueEvents(el, idx);
    return el;
  }



  function buildMultiTimeEl(segment) {
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = `${fmtShort(segment.start)} → ${fmtShort(segment.end)}`;
    return time;
  }



  function buildMultiCueColumn(segment, index, track, kind) {
    const column = document.createElement('div');
    column.className = `multi-cue-column ${kind}`;
    if (!segment) {
      column.classList.add('multi-cue-empty');
      column.textContent = '—';
      return column;
    }
    if (segment._dirty) column.classList.add('dirty');
    if (segment.disabled) column.classList.add('disabled');
    const header = document.createElement('div');
    header.className = 'multi-cue-column-header';
    const indexEl = document.createElement('span');
    indexEl.className = 'index';
    indexEl.textContent = `${kind === 'main' ? '主字幕' : '副字幕'} ${index + 1}`;
    header.append(indexEl, buildMultiTimeEl(segment));
    const text = document.createElement('span');
    text.className = 'text';
    setTextHtml(text, segment.text || '', MaweDom.searchEl.value);
    column.append(header, text);
    if (kind === 'extension') {
      const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(index, track);
      if (!binding) column.classList.add('unbound');
      column.dataset.extIdx = String(index);
    } else {
      column.dataset.mainIdx = String(index);
    }
    column.dataset.start = String(segment.start);
    column.dataset.end = String(segment.end);
    return column;
  }



  function buildExtensionCueEl(seg, idx, track) {
    return buildCueEl(seg, idx, { extensionTrack: track });
  }



  function buildDualCueEl(mainIndex, extensionIndex, track) {
    const main = mainIndex == null ? null : MaweBoot.DATA.segments[mainIndex];
    const extension = extensionIndex == null ? null : track.segments[extensionIndex];
    const el = document.createElement('div');
    el.className = 'cue multi-cue multi-dual-cue';
    if (main) setCueListIdentity(el, main);
    if (extension) setCueListIdentity(el, extension, track);
    if (mainIndex != null) {
      el.dataset.mainIdx = String(mainIndex);
      el.dataset.idx = String(mainIndex);
    }
    if (extensionIndex != null) el.dataset.extIdx = String(extensionIndex);
    el.append(
      buildMultiCueColumn(main, mainIndex ?? -1, track, 'main'),
      buildMultiCueColumn(extension, extensionIndex ?? -1, track, 'extension'),
    );
    if (main) MaweCueEvents.bindCueEvents(el, mainIndex);
    if (extension) {
      const extensionColumn = el.querySelector('.multi-cue-column.extension');
      MaweInlineEdit.bindExtensionCueEvents(extensionColumn, extensionIndex, track, el);
    }
    return el;
  }



  function fmtShort(ms) {
    if (timelineIsFrameMode()) {
      return formatTimelineTimecode(
        ms,
        projectTimebase().fps,
        MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
      );
    }
    const s = ms / 1000;
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2,'0')}:${(s - m * 60).toFixed(3).padStart(6,'0')}`;
  }



  function fmtSrtTime(ms) {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)},${pad(ms,3)}`;
  }



  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }



  function setTextHtml(el, text, query) {
    if (!query) {
      el.innerHTML = '';
      text.split('\n').forEach((line, i) => {
        if (i > 0) el.appendChild(document.createElement('br'));
        el.appendChild(document.createTextNode(line));
      });
      return;
    }
    const re = buildSearchRegex(query, false);
    let html = '';
    for (const line of text.split('\n').map(escapeHtml)) {
      if (html) html += '<br>';
      if (!re) { html += line; continue; }
      html += line.replace(re, m => `<mark>${m}</mark>`);
    }
    el.innerHTML = html;
  }



  function buildSearchRegex(query, caseSensitive) {
    if (!query) return null;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, caseSensitive ? 'g' : 'gi');
  }



  // === 字数 ===
  function calcCharWidth(text, mode = null) {
    return mode
      ? window.AsrEditorUtils.countSubtitleUnits(text, mode)
      : window.AsrEditorUtils.countTextUnits(text);
  }


  function getCharCountThreshold() {
    const v = Number(MaweSettings.EDITOR_SETTINGS.cueListCharcountThreshold);
    return Number.isFinite(v) && v > 0
      ? MaweSettings.clampCharcountThreshold(v)
      : MaweSettings.DEFAULT_EDITOR_SETTINGS.cueListCharcountThreshold;
  }


  function syncCharCountThresholdInputs(value = getCharCountThreshold()) {
    const threshold = MaweSettings.clampCharcountThreshold(value);
    const text = String(threshold);
    if (MaweDom.cueListCharcountThresholdInput) MaweDom.cueListCharcountThresholdInput.value = text;
    if (MaweDom.timedTextEditCharcountThresholdInput) MaweDom.timedTextEditCharcountThresholdInput.value = text;
    return threshold;
  }


  function handleCharCountThresholdInput(input) {
    const value = Number(input?.value);
    if (Number.isFinite(value) && value >= 1 && value <= 200) {
      const threshold = syncCharCountThresholdInputs(value);
      MaweSettings.updateEditorSettings({ cueListCharcountThreshold: threshold });
    }
    updateTimedTextEditSingleGuide();
    refreshAllCharCounts();
    if (document.getElementById('filter-over').classList.contains('active')) {
      MaweSearch.applySearch(MaweDom.searchEl.value);
    }
  }


  function updateTimedTextEditSingleGuide() {
    if (!MaweDom.timedTextEditSingleEditor) return;
    MaweDom.timedTextEditSingleEditor.style.setProperty(
      '--timed-text-edit-line-width',
      `${getCharCountThreshold()}em`,
    );
  }


  function applyCharCount(cntEl, text, mode = null) {
    if (!cntEl) return;
    const w = calcCharWidth(text, mode);
    cntEl.textContent = Number.isInteger(w) ? String(w) : w.toFixed(1);
    cntEl.classList.toggle('over', w > getCharCountThreshold());
  }



  function splitCueVisibilityKey(kind, segment, trackId = null) {
    const id = segment?.id;
    if (!id) return null;
    return kind === 'extension'
      ? `extension:${trackId || ''}:${id}`
      : `main:${id}`;
  }



  function temporaryVisibleSplitCueKeysForElement(element) {
    if (!element) return [];
    const keys = [];
    const mainIndex = element.dataset.mainIdx != null
      ? Number(element.dataset.mainIdx)
      : (element.dataset.idx != null ? Number(element.dataset.idx) : -1);
    const extensionIndex = element.dataset.extIdx != null ? Number(element.dataset.extIdx) : -1;
    if (Number.isInteger(mainIndex) && mainIndex >= 0) {
      const key = splitCueVisibilityKey('main', MaweBoot.DATA.segments[mainIndex]);
      if (key) keys.push(key);
    }
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    if (Number.isInteger(extensionIndex) && extensionIndex >= 0 && extensionTrack) {
      const key = splitCueVisibilityKey(
        'extension', extensionTrack.segments[extensionIndex], extensionTrack.id,
      );
      if (key) keys.push(key);
    }
    return keys;
  }



  function cueElementHasTemporarySplitVisibility(element) {
    return temporaryVisibleSplitCueKeysForElement(element)
      .some((key) => MaweSelection.temporaryVisibleSplitCueKeys.has(key));
  }



  function clearTemporaryVisibleSplitCues() {
    MaweSelection.temporaryVisibleSplitCueKeys.clear();
  }



  function rememberTemporaryVisibleSplitCues({
    mainSegments = [],
    extensionSegments = [],
    extensionTrackId = null,
  } = {}) {
    if (!MaweSettings.EDITOR_SETTINGS.cueListKeepSplitVisible) return;
    if (!document.getElementById('filter-over')?.classList.contains('active')) return;
    mainSegments.forEach((segment) => {
      const key = splitCueVisibilityKey('main', segment);
      if (key) MaweSelection.temporaryVisibleSplitCueKeys.add(key);
    });
    extensionSegments.forEach((segment) => {
      const key = splitCueVisibilityKey('extension', segment, extensionTrackId);
      if (key) MaweSelection.temporaryVisibleSplitCueKeys.add(key);
    });
  }



  function releaseTemporaryVisibleSplitCuesUnless(kind, index, track = null) {
    if (!MaweSelection.temporaryVisibleSplitCueKeys.size) return;
    const segments = kind === 'extension'
      ? (track?.segments || MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || [])
      : MaweBoot.DATA.segments;
    const segment = segments[index];
    const key = splitCueVisibilityKey(kind, segment, kind === 'extension' ? track?.id : null);
    if (key && MaweSelection.temporaryVisibleSplitCueKeys.has(key)) return;
    clearTemporaryVisibleSplitCues();
    MaweSearch.applySearch(MaweDom.searchEl.value);
  }



  function refreshAllCharCounts() {
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    MaweCoreState.container.querySelectorAll(':scope > .cue').forEach(el => {
      const idx = Number.parseInt(el.dataset.idx, 10);
      const extensionIdx = Number.parseInt(el.dataset.extIdx, 10);
      const cntEl = el.querySelector('.charcount');
      const segment = Number.isInteger(extensionIdx) && extensionTrack
        ? extensionTrack.segments[extensionIdx]
        : (Number.isInteger(idx) ? MaweBoot.DATA.segments[idx] : null);
      const mode = Number.isInteger(extensionIdx) && extensionTrack
        ? MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(extensionTrack, segment)
        : MaweMultiSubtitleCore.getMainSubtitleSplitMode(segment);
      if (cntEl && segment) applyCharCount(cntEl, segment.text, mode);
    });
  }

  global.MaweCueElements = Object.freeze({
    updateCueColorPresentation,
    updateCueStickerPresentation,
    buildCueEl,
    buildMultiTimeEl,
    buildMultiCueColumn,
    buildExtensionCueEl,
    buildDualCueEl,
    fmtShort,
    fmtSrtTime,
    escapeHtml,
    setTextHtml,
    buildSearchRegex,
    calcCharWidth,
    getCharCountThreshold,
    syncCharCountThresholdInputs,
    handleCharCountThresholdInput,
    updateTimedTextEditSingleGuide,
    applyCharCount,
    splitCueVisibilityKey,
    temporaryVisibleSplitCueKeysForElement,
    cueElementHasTemporarySplitVisibility,
    clearTemporaryVisibleSplitCues,
    rememberTemporaryVisibleSplitCues,
    releaseTemporaryVisibleSplitCuesUnless,
    refreshAllCharCounts
  });
})(typeof window !== 'undefined' ? window : globalThis);

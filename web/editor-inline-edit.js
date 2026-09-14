// 行内编辑：主/副字幕就地编辑状态机与光标定位。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweInlineEdit 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweInlineEdit(global) {
  'use strict';



  // === 编辑 ===
  let editingState = null;


  let extensionEditingState = null;



  function startExtensionEdit(
    el,
    index,
    track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
    clickX,
    clickY,
    { deferCaret = false } = {},
  ) {
    if (!el || !track?.segments?.[index]) return;
    MaweNavPreview.hideCueSplitPreview();
    if (editingState) finishEdit(true);
    if (extensionEditingState) finishExtensionEdit(true);
    MaweCuePanel.setCurrentCuePanelExtensionIndex(index, track);
    const textEl = el.querySelector('.text') || el;
    const segment = track.segments[index];
    let caretCharOffset = null;
    if (typeof clickX === 'number' && typeof clickY === 'number') {
      caretCharOffset = caretCharFromPoint(textEl, clickX, clickY);
    }
    extensionEditingState = {
      el, index, trackId: track.id, textEl, original: segment.text || '', caretCharOffset,
    };
    el.classList.add('editing');
    textEl.setAttribute('contenteditable', 'plaintext-only');
    textEl.innerText = segment.text || '';
    textEl.focus();
    const applyCaret = () => {
      if (!extensionEditingState || extensionEditingState.el !== el) return;
      const selection = window.getSelection();
      selection.removeAllRanges();
      if (caretCharOffset !== null && textEl.firstChild) {
        const range = document.createRange();
        const node = textEl.firstChild;
        const pos = Math.max(0, Math.min(caretCharOffset, node.textContent.length));
        range.setStart(node, pos);
        range.setEnd(node, pos);
        selection.addRange(range);
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(textEl);
      selection.addRange(range);
    };
    applyCaret();
    if (deferCaret) setTimeout(applyCaret, 0);
  }



  function syncCuePanelAfterInlineEdit(kind, index, trackId = null) {
    const target = MaweCuePanel.getCurrentCuePanelTarget();
    if (!target || target.kind !== kind || target.index !== index) return;
    if (kind === 'extension' && target.trackId !== trackId) return;
    if (MaweDom.cuePanelText && document.activeElement !== MaweDom.cuePanelText) {
      MaweDom.cuePanelText.value = target.segment?.text || '';
    }
  }



  function finishExtensionEdit(save) {
    if (!extensionEditingState) return;
    const { el, index, trackId, textEl, original } = extensionEditingState;
    const track = MaweMultiSubtitleCore.getExtensionTrack(trackId);
    const segment = track?.segments?.[index];
    textEl.removeAttribute('contenteditable');
    el.classList.remove('editing');
    if (segment && save) {
      const nextText = textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
      if (nextText !== original) {
        MaweHistory.pushUndo('编辑副字幕');
        segment.text = nextText;
        segment._dirty = true;
        MaweMultiSubtitleCore.markMultiSubtitleDirty();
        MaweServerSave.scheduleAutoSaveFlush();
      }
    }
    if (segment) {
      MaweCueElements.setTextHtml(textEl, segment.text || '', MaweDom.searchEl.value);
      MaweCueElements.applyCharCount(
        el.querySelector('.charcount'),
        segment.text || '',
        MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, segment),
      );
    }
    MaweCoreState.waveformEditor?.refreshExtensionCueLabel(index, trackId);
    syncCuePanelAfterInlineEdit('extension', index, trackId);
    extensionEditingState = null;
    MawePlaybackLoop.refreshSubtitlePreview();
  }



  function bindExtensionCueEvents(el, index, track = MaweMultiSubtitleCore.getActiveExtensionTrack(), dualRow = null) {
    if (!el || !track?.segments?.[index]) return;
    let pointerDown = null;
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (extensionEditingState?.el === el)) return;
      event.stopPropagation();
      if (event.altKey) {
        event.preventDefault();
        MaweStickerPicker.toggleDisabled([index], track);
        pointerDown = null;
        return;
      }
      pointerDown = { x: event.clientX, y: event.clientY };
      if (event.shiftKey && MaweSelection.lastClickedExtensionIdx >= 0) MaweSelection.selectExtensionRange(MaweSelection.lastClickedExtensionIdx, index);
      else if (event.ctrlKey || event.metaKey) MaweSelection.toggleExtensionSelection(index);
      else MaweSelection.selectOnlyExtension(index);
      MaweSelection.lastClickedExtensionIdx = index;
    });
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!pointerDown) return;
      pointerDown = null;
      const segment = track.segments[index];
      const previousSuppress = MawePlaybackLoop.suppressCueListAutoScroll;
      // 副字幕点击后 seek 会同步刷新主字幕 active 状态；这次刷新不能把
      // 列表从刚点击的副字幕行再次滚到对应的主字幕行。
      MawePlaybackLoop.suppressCueListAutoScroll = true;
      try {
        MaweCoreState.waveformEditor?.revealTime(segment.start, true);
        if (MaweSettings.EDITOR_SETTINGS.clickBehavior !== 'select-only') MaweTextCleanup.seekFromWaveform(segment.start / 1000);
      } finally {
        MawePlaybackLoop.suppressCueListAutoScroll = previousSuppress;
      }
      if (MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick) {
        const currentRow = MaweCoreState.container.querySelector(
          `.multi-dual-cue[data-ext-idx="${index}"], .multi-extension-cue[data-ext-idx="${index}"]`,
        );
        MaweCueListAnchor.scrollCueToCenter(currentRow || dualRow || el);
      }
    });
    el.addEventListener('pointermove', (event) => {
      event.stopPropagation();
      if (extensionEditingState?.el === el) {
        MaweNavPreview.hideCueSplitPreview();
        return;
      }
      MaweNavPreview.cueListPointer = {
        kind: 'extension',
        idx: index,
        trackId: track.id,
        x: event.clientX,
        y: event.clientY,
      };
      MaweNavPreview.scheduleCueSplitPreview(index, event.clientX, event.clientY, 'extension', track.id);
    });
    el.addEventListener('pointerleave', () => {
      if (MaweNavPreview.cueListPointer?.kind === 'extension'
          && MaweNavPreview.cueListPointer.idx === index
          && MaweNavPreview.cueListPointer.trackId === track.id) {
        MaweNavPreview.cueListPointer = null;
        MaweNavPreview.hideCueSplitPreview();
      }
    });
    el.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      startExtensionEdit(el, index, track, event.clientX, event.clientY, { deferCaret: true });
    });
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      MaweContextMenus.showExtensionContextMenu(event.clientX, event.clientY, index, null, track);
    });
  }



  function startEdit(el, idx, clickX, clickY, { deferCaret = false } = {}) {
    if (editingState) finishEdit(true);
    MaweNavPreview.hideCueSplitPreview();
    const textEl = el.querySelector('.text');
    if (!textEl) return;
    const seg = MaweBoot.DATA.segments[idx];
    let caretCharOffset = null;
    if (typeof clickX === 'number' && typeof clickY === 'number') {
      caretCharOffset = caretCharFromPoint(textEl, clickX, clickY);
    }
    editingState = { el, idx, textEl, original: seg.text };
    el.classList.add('editing');
    textEl.setAttribute('contenteditable', 'plaintext-only');
    textEl.innerText = seg.text;
    textEl.focus();
    const applyCaret = () => {
      if (!editingState || editingState.el !== el) return;
      const sel = window.getSelection();
      sel.removeAllRanges();
      if (caretCharOffset !== null && textEl.firstChild) {
        const range = document.createRange();
        const node = textEl.firstChild;
        const pos = Math.max(0, Math.min(caretCharOffset, node.textContent.length));
        range.setStart(node, pos);
        range.setEnd(node, pos);
        sel.addRange(range);
      } else {
        const range = document.createRange();
        range.selectNodeContents(textEl);
        sel.addRange(range);
      }
    };
    // 浏览器可能在 dblclick 处理器返回后执行原生的“双击选词”，覆盖刚设置的光标。
    // 延后一轮事件循环，确保双击编辑最终落在鼠标对应的字符位置。
    // 先同步放置一次光标，让编辑状态立即可见；双击原生选词可能在事件返回后
    // 覆盖它，再用下一轮事件循环恢复到鼠标位置。
    applyCaret();
    if (deferCaret) setTimeout(applyCaret, 0);
  }



  function setEditingCaretOffset(offset) {
    const textEl = editingState?.textEl;
    const node = textEl?.firstChild;
    if (!node || !Number.isFinite(offset)) return false;
    const pos = Math.max(0, Math.min(Math.round(offset), node.textContent.length));
    const range = document.createRange();
    range.setStart(node, pos);
    range.setEnd(node, pos);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }



  function caretOffsetInText(textEl) {
    if (!textEl) return null;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!textEl.contains(range.startContainer) && range.startContainer !== textEl) return null;
    const preRange = range.cloneRange();
    preRange.selectNodeContents(textEl);
    preRange.setEnd(range.startContainer, range.startOffset);
    return preRange.toString().length;
  }



  function caretInfoFromPoint(root, x, y) {
    if (!root) return null;
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
    }
    if (!range || (!root.contains(range.startContainer) && range.startContainer !== root)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(root);
    pre.setEnd(range.startContainer, range.startOffset);
    return { offset: pre.toString().length, rect: range.getBoundingClientRect() };
  }



  function caretCharFromPoint(root, x, y) {
    return caretInfoFromPoint(root, x, y)?.offset ?? null;
  }



  function finishEdit(save) {
    if (!editingState) return;
    const { el, idx, textEl, original } = editingState;
    textEl.removeAttribute('contenteditable');
    el.classList.remove('editing');
    if (save) {
      const newText = textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
      if (newText !== original) {
        MaweHistory.pushUndo('编辑文本');
        MaweBoot.DATA.segments[idx].text = newText;
        MaweBoot.DATA.segments[idx]._dirty = true;
        el.classList.add('dirty');
        MaweServerSave.scheduleAutoSaveFlush();
      }
    }
    MaweCueElements.setTextHtml(textEl, MaweBoot.DATA.segments[idx].text, MaweDom.searchEl.value);
    const cntEl = el.querySelector('.charcount');
    if (cntEl) MaweCueElements.applyCharCount(
      cntEl, MaweBoot.DATA.segments[idx].text, MaweMultiSubtitleCore.getMainSubtitleSplitMode(MaweBoot.DATA.segments[idx]),
    );
    MaweCoreState.waveformEditor?.refreshCueLabel(idx);
    syncCuePanelAfterInlineEdit('main', idx);
    editingState = null;
    MawePlaybackLoop.refreshSubtitlePreview();
  }

  global.MaweInlineEdit = Object.freeze({
    get editingState() { return editingState; },
    set editingState(v) { editingState = v; },
    get extensionEditingState() { return extensionEditingState; },
    set extensionEditingState(v) { extensionEditingState = v; },
    startExtensionEdit,
    syncCuePanelAfterInlineEdit,
    finishExtensionEdit,
    bindExtensionCueEvents,
    startEdit,
    setEditingCaretOffset,
    caretOffsetInText,
    caretInfoFromPoint,
    caretCharFromPoint,
    finishEdit
  });
})(typeof window !== 'undefined' ? window : globalThis);

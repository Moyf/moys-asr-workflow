// 字幕行事件：行级监听绑定与拆分键配置。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweCueEvents 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweCueEvents(global) {
  'use strict';



  // === 单击/双击/Shift/Ctrl ===
  function bindCueEvents(el, idx) {
  let pointerDownState = null;
  let lastPrimaryPointerDownAt = 0;

  function selectFromCuePointer(event) {
    // Alt+点击 = 快速切换禁用状态
    if (event.altKey) {
      event.preventDefault();
      MaweStickerPicker.toggleDisabled([idx]);
      return 'alt';
    }

    // Shift / Ctrl 多选
    if (event.shiftKey) {
      event.preventDefault();
      if (MaweSelection.lastClickedIdx >= 0) MaweSelection.selectRange(MaweSelection.lastClickedIdx, idx);
      else MaweSelection.selectOnly(idx);
      MaweSelection.lastClickedIdx = idx;
      return 'shift';
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      MaweSelection.toggleSel(idx);
      MaweSelection.lastClickedIdx = idx;
      return 'toggle';
    }

    // 普通单击的选中阶段放在 pointerdown，点击时只做跳转。
    MaweBindingAlign.selectCueByClick(idx);
    MaweSelection.lastClickedIdx = idx;
    return 'select';
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (MaweInlineEdit.editingState && MaweInlineEdit.editingState.el === el)) return;
    MaweNavPreview.cueListPointer = { kind: 'main', idx, x: e.clientX, y: e.clientY };

    // 这些子控件有自己的 click 行为；不要在父 cue 的 pointerdown 阶段抢先选中。
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.color-bar.is-ref, .sticker-slot img, .sticker-slot .sref')) {
      // 避免这次不会冒泡到父 cue 的 click 参与下一次普通双击判定。
      lastPrimaryPointerDownAt = 0;
      pointerDownState = { handled: false, time: performance.now() };
      return;
    }

    const now = performance.now();
    const listScrollBeforeClick = MaweCoreState.container.scrollTop;
    const listCenterScroll = Math.max(
      0,
      el.offsetTop - MaweCoreState.container.clientHeight / 2 + el.offsetHeight / 2,
    );
    const isSecondDoubleClick = e.detail > 1
      || (lastPrimaryPointerDownAt > 0 && now - lastPrimaryPointerDownAt < 500);
    lastPrimaryPointerDownAt = now;
    if (isSecondDoubleClick) {
      // 第一次 pointerdown 已经完成选中；双击的第二次按下不要再次刷新波形布局。
      // 但仍要更新当前编辑焦点：主副字幕可以同时保持选中，且前一次主轨点击
      // 可能与副轨点击被隔开，此时不能因为本次字幕仍处于 selected 就停留在副字幕面板。
      MaweCuePanel.setCurrentCuePanelIndex(idx);
      pointerDownState = { handled: true, suppressClick: true, time: now };
      return;
    }

    const action = selectFromCuePointer(e);
    pointerDownState = {
      handled: true,
      suppressClick: action !== 'select',
      time: now,
      preserveListScroll: listScrollBeforeClick > 0 && el.offsetTop < listScrollBeforeClick,
      listScrollBeforeClick,
    };
  });
  el.addEventListener('pointermove', (e) => {
    if (MaweInlineEdit.editingState?.el === el) {
      MaweNavPreview.hideCueSplitPreview();
      return;
    }
    MaweNavPreview.cueListPointer = { kind: 'main', idx, x: e.clientX, y: e.clientY };
    MaweNavPreview.scheduleCueSplitPreview(idx, e.clientX, e.clientY, 'main');
  });
  el.addEventListener('pointerleave', () => {
    if (MaweNavPreview.cueListPointer?.idx === idx) {
      MaweNavPreview.cueListPointer = null;
      MaweNavPreview.hideCueSplitPreview();
    }
  });

  el.addEventListener('click', (e) => {
    if (MaweInlineEdit.editingState && MaweInlineEdit.editingState.el === el) return;
    const state = pointerDownState;
    pointerDownState = null;
    // 第一次 pointerdown 已经立即完成选择；双击产生的第二次 click
    // 不重复执行同一套操作，随后仍由 dblclick 进入编辑。
    if (e.detail > 1 || state?.suppressClick) return;

    // 键盘触发 click，或特殊子控件的 click 冒泡到父 cue 时，保留 click 作为后备选择路径。
    if (!state?.handled) selectFromCuePointer(e);

    // 选择已经在 pointerdown 完成；这里仅处理列表滚动、波形定位和媒体 Seek。
    if (MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick && !state?.preserveListScroll) {
      MaweCueListAnchor.scrollCueToCenter(el);
    }
    MaweCoreState.waveformEditor?.revealTime(MaweBoot.DATA.segments[idx].start, true);
    const wasPlaying = isPlaybackActive();
    if (MaweSettings.EDITOR_SETTINGS.clickBehavior !== 'select-only') {
      // 默认只跳转不改动播放状态；“选中并跳转（自动播放）”会在暂停时启动播放。
      const previousSuppress = MawePlaybackLoop.suppressCueListAutoScroll;
      MawePlaybackLoop.suppressCueListAutoScroll = state?.preserveListScroll
        ? true : !MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick;
      try {
        MaweTextCleanup.seekFromWaveform(MaweBoot.DATA.segments[idx].start / 1000, { mouseClick: true });
      } finally {
        MawePlaybackLoop.suppressCueListAutoScroll = state?.preserveListScroll
          ? true : previousSuppress;
      }
      if (state?.preserveListScroll) {
        MaweCueListAnchor.restoreCueListVisualAnchor(null, { scrollTop: state.listScrollBeforeClick }, 'navigate');
      }
      if (MaweSettings.EDITOR_SETTINGS.clickBehavior === 'select-and-play' && MaweCoreState.player.paused && !wasPlaying) MaweMediaPlayback.togglePlayback();
    }
  });
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    // 普通双击的第一次 pointerdown 已选中该 cue；只有从特殊子控件触发、且尚未选中时
    // 才补一次选择，避免双击再次提交当前面板并重绘波形布局。
    if (!MaweSelection.selectedIdxs.has(idx)) MaweSelection.selectOnly(idx);
    window.MAWE_ONBOARDING?.beginRealSplit(idx);
    MaweInlineEdit.startEdit(el, idx, e.clientX, e.clientY, { deferCaret: true });
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    MaweContextMenus.showContextMenu(e.clientX, e.clientY, idx);
  });
}



  // === 全局键盘 ===
  function getSplitKey() { return MaweDom.splitKeySel.value; }

    // 'enter' or 'ctrl-enter'

  function getConfiguredEnterAction(event) {
    return window.AsrEditorUtils.configuredEnterAction(event, getSplitKey());
  }

  global.MaweCueEvents = Object.freeze({
    bindCueEvents,
    getSplitKey,
    getConfiguredEnterAction
  });
})(typeof window !== 'undefined' ? window : globalThis);

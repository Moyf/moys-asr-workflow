// 导航与预览：导航归属、拆分预览与 seek 状态。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweNavPreview 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweNavPreview(global) {
  'use strict';



  // === seek ===
  let seekWarned = false;


  let pendingMediaSeekTimeSec = null;


  let autoLoadedMediaReadyNotified = false;


  let cueListPointer = null;


  // 最后一次指针按下所在的编辑区域：cue-list / waveform。
  // Enter（原地编辑 vs 聚焦字幕编辑区）据此分发；指针坐标由 cueListPointer /
  // lastPointerPos 提供，两者独立更新、互不替代。
  let lastEditRegion = null;


  let navigationOwner = null;


  let lastPointerPos = null;


  let cueSplitPreviewEl = null;


  let cueSplitPreviewFrame = 0;


  let cueSplitPreviewRequest = null;


  function navigationOwnerForTarget(target) {
    if (!(target instanceof Element)) return null;
    if (target.closest('.cue')) return 'cue-list';
    if (target.closest('.player-stage, #media-controls, .waveform-row, #waveform-scroll')) {
      return 'waveform/player';
    }
    return null;
  }


  function updateNavigationOwner(event) {
    const owner = navigationOwnerForTarget(event.target);
    if (owner) navigationOwner = owner;
  }



  function hideCueSplitPreview() {
    if (cueSplitPreviewFrame) {
      cancelAnimationFrame(cueSplitPreviewFrame);
      cueSplitPreviewFrame = 0;
    }
    cueSplitPreviewRequest = null;
    cueSplitPreviewEl?.remove();
    cueSplitPreviewEl = null;
  }



  function scheduleCueSplitPreview(idx, clientX, clientY, kind = 'main', trackId = null) {
    cueSplitPreviewRequest = { idx, clientX, clientY, kind, trackId };
    if (cueSplitPreviewFrame) return;
    cueSplitPreviewFrame = requestAnimationFrame(() => {
      cueSplitPreviewFrame = 0;
      const request = cueSplitPreviewRequest;
      cueSplitPreviewRequest = null;
      const isExtension = request?.kind === 'extension';
      const selected = isExtension ? MaweSelection.selectedExtensionIdxs : MaweSelection.selectedIdxs;
      if (!request || selected.size !== 1 || !selected.has(request.idx)) {
        hideCueSplitPreview();
        return;
      }
      const track = isExtension ? MaweMultiSubtitleCore.getExtensionTrack(request.trackId) : null;
      const cue = isExtension
        ? MaweCoreState.container.querySelector(
          `.multi-cue-column.extension[data-ext-idx="${request.idx}"], `
            + `.multi-extension-cue[data-ext-idx="${request.idx}"]`,
        )
        : MaweCoreState.container.querySelector(`.cue[data-idx="${request.idx}"]`);
      const segment = isExtension ? track?.segments?.[request.idx] : MaweBoot.DATA.segments[request.idx];
      const textEl = cue?.querySelector('.text');
      const text = String(segment?.text || '');
      if (!cue || !segment || !textEl || text.length < 2 || segment.end - segment.start < 200) {
        hideCueSplitPreview();
        return;
      }
      const info = MaweInlineEdit.caretInfoFromPoint(textEl, request.clientX, request.clientY);
      if (!info || info.offset <= 0 || info.offset >= text.length) {
        hideCueSplitPreview();
        return;
      }
      const cueRect = cue.getBoundingClientRect();
      // 光条挂在 .cue 上，而 caret 的坐标是 viewport 坐标；扣除 .cue 的左边框，
      // 才能把 marker 的中心放回真正的字符边界。
      const left = Math.max(0, Math.min(cueRect.width, info.rect.left - cueRect.left - cue.clientLeft));
      if (!cueSplitPreviewEl || cueSplitPreviewEl.parentElement !== cue) {
        cueSplitPreviewEl?.remove();
        cueSplitPreviewEl = document.createElement('span');
        cueSplitPreviewEl.className = 'cue-split-preview';
        cueSplitPreviewEl.setAttribute('aria-hidden', 'true');
        cue.appendChild(cueSplitPreviewEl);
      }
      cueSplitPreviewEl.style.left = `${left}px`;
    });
  }



  function waveformPointerContext() {
    if (!lastPointerPos) return null;
    const timeMs = MaweCoreState.waveformEditor?.timeMsAtPoint?.(lastPointerPos.x, lastPointerPos.y);
    if (!Number.isFinite(timeMs)) return null;
    const track = MaweCoreState.waveformEditor?.trackAtPoint?.(lastPointerPos.x, lastPointerPos.y) || 'main';
    return {
      ...lastPointerPos,
      timeMs,
      track,
      trackId: track === 'extension' ? MaweMultiSubtitleCore.getActiveExtensionTrack()?.id || null : null,
    };
  }



  function keyboardOperationReference() {
    const pointer = waveformPointerContext();
    const target = MaweCuePanel.getCurrentCuePanelTarget();
    return MaweAppearance.GEO_UTILS.resolveKeyboardOperationReference(
      MaweSettings.EDITOR_SETTINGS.keyboardOperationReference,
      {
        pointer,
        playheadTarget: {
          ...(target || { kind: 'main', trackId: null }),
          timeMs: Math.round(Number(MaweCoreState.player.currentTime) * 1000),
        },
      },
    );
  }



  // Z/X 只接受一个“逻辑字幕”作为目标：点击主字幕时，绑定副字幕是它的
  // 联动对象；点击副字幕时，即使界面同时选中了主字幕，也仍只改副字幕。
  // 其它多选或来自不同绑定组的混合选择直接不处理。
  function getPointerBoundaryEditTarget(context) {
    if (!context) return null;
    const mainIndices = [...MaweSelection.selectedIdxs];
    const extensionIndices = [...MaweSelection.selectedExtensionIdxs];

    if (!mainIndices.length && !extensionIndices.length) {
      const extension = context.track === 'extension' && MaweMultiSubtitleCore.multiSubtitleVisible();
      const track = extension ? MaweMultiSubtitleCore.getExtensionTrack(context.trackId) : null;
      const segments = extension ? track?.segments : MaweBoot.DATA.segments;
      const index = MaweContextMenus.findWaveformCueAtTime(context.timeMs, segments);
      if (index < 0 || !segments?.[index]) return null;
      return {
        kind: extension ? 'extension' : 'main',
        index,
        trackId: track?.id || null,
        track,
        segment: segments[index],
      };
    }

    const panelTarget = MaweCuePanel.getCurrentCuePanelTarget();
    if (!panelTarget) return null;
    if (panelTarget.kind === 'main') {
      if (mainIndices.length !== 1 || mainIndices[0] !== panelTarget.index) return null;
      const binding = MaweMultiSubtitleCore.bindingForMainIndex(panelTarget.index);
      const bindingTrack = binding ? MaweMultiSubtitleCore.getExtensionTrack(binding.track_id) : null;
      const boundExtensionIndices = (binding?.extension_segment_ids || [])
        .map((id) => bindingTrack?.segments?.findIndex((segment) => segment?.id === id) ?? -1)
        .filter((index) => index >= 0);
      const extensionMatchesBinding = extensionIndices.length === 0
        || (boundExtensionIndices.length === 1
          && extensionIndices.length === 1
          && extensionIndices[0] === boundExtensionIndices[0]);
      if (!extensionMatchesBinding) return null;
      return panelTarget;
    }

    if (extensionIndices.length !== 1 || extensionIndices[0] !== panelTarget.index) return null;
    const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(panelTarget.index, panelTarget.track);
    const boundMainIndices = (binding?.main_segment_ids || [])
      .map((id) => MaweBoot.DATA.segments.findIndex((segment) => segment?.id === id))
      .filter((index) => index >= 0);
    const mainMatchesBinding = mainIndices.length === 0
      || (boundMainIndices.length === 1
        && mainIndices.length === 1
        && mainIndices[0] === boundMainIndices[0]);
    return mainMatchesBinding ? panelTarget : null;
  }



  // Z：起点定位；X：终点定位。无选中时使用波形指针命中的字幕；有选中时
  // 只允许一个逻辑字幕，避免把多选误当成批量边界调整。
  function handlePointerBoundaryShortcut(event, edge) {
    if (event.key !== (edge === 'start' ? 'z' : 'x')
        && event.key !== (edge === 'start' ? 'Z' : 'X')) return;
    if (event.repeat || MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState || MaweKeyboardTargets.isTextEditingTarget(event)) return;
    const active = document.activeElement;
    if (active && (
      active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
        || active.tagName === 'SELECT' || active.isContentEditable
    )) return;
    if (MaweDom.replaceModal.classList.contains('show') || MaweDom.stickerModal.classList.contains('show')
        || MaweDom.stickerPreviewModal.classList.contains('show') || MaweDom.projectMediaModal.classList.contains('show')
        || MaweDom.multiSubtitleSplitModal?.classList.contains('show')
        || MaweDom.multiSubtitleImportModal?.classList.contains('show')
        || document.getElementById('sticker-root-modal').classList.contains('show')
        || MaweDom.ctxmenu.classList.contains('show')) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

    const reference = keyboardOperationReference();
    const context = reference ? { ...reference } : null;
    const target = getPointerBoundaryEditTarget(context);
    if (!reference || !target || !MaweCoreState.waveformEditor?.setCueBoundaryToTime) {
      if (!reference) MaweHint.flashHint('无有效的快捷键时间基准', 'invalid');
      return;
    }
    const track = target.kind === 'extension' ? 'extension' : 'main';
    if (!MaweCoreState.waveformEditor.setCueBoundaryToTime(context.timeMs, edge, track, target.index)) return;
    event.preventDefault();
    event.stopPropagation();
  }



  function hoveredSelectedCueContext() {
    if (!cueListPointer) return null;
    const isExtension = cueListPointer.kind === 'extension';
    const selected = isExtension ? MaweSelection.selectedExtensionIdxs : MaweSelection.selectedIdxs;
    if (!selected.has(cueListPointer.idx)) return null;
    const track = isExtension ? MaweMultiSubtitleCore.getExtensionTrack(cueListPointer.trackId) : null;
    const el = isExtension
      ? MaweCoreState.container.querySelector(
        `.multi-cue-column.extension[data-ext-idx="${cueListPointer.idx}"], `
          + `.multi-extension-cue[data-ext-idx="${cueListPointer.idx}"]`,
      )
      : MaweCoreState.container.querySelector(`.cue[data-idx="${cueListPointer.idx}"]`);
    if (!el || !el.matches(':hover')) return null;
    const caret = MaweInlineEdit.caretInfoFromPoint(el.querySelector('.text'), cueListPointer.x, cueListPointer.y);
    return { ...cueListPointer, el, track, offset: caret?.offset ?? null, caretRect: caret?.rect ?? null };
  }



  function seekCurrentCueBoundary(boundary) {
    const target = MaweCuePanel.getCurrentCuePanelTarget();
    const timeMs = Number(target?.segment?.[boundary]);
    const duration = Number(MaweCoreState.player?.duration);
    if (!target || !Number.isFinite(timeMs) || !MaweMediaPlayback.hasLoadedMedia()
        || !Number.isFinite(duration) || duration <= 0) return false;
    MaweJklPlayback.stopJklReversePlayback({ render: false });
    MaweCoreState.player.pause();
    return MaweMediaPlayback.seekMediaTo(timeMs / 1000);
  }

  global.MaweNavPreview = Object.freeze({
    seekCurrentCueBoundary,
    get seekWarned() { return seekWarned; },
    set seekWarned(v) { seekWarned = v; },
    get pendingMediaSeekTimeSec() { return pendingMediaSeekTimeSec; },
    set pendingMediaSeekTimeSec(v) { pendingMediaSeekTimeSec = v; },
    get autoLoadedMediaReadyNotified() { return autoLoadedMediaReadyNotified; },
    set autoLoadedMediaReadyNotified(v) { autoLoadedMediaReadyNotified = v; },
    get cueListPointer() { return cueListPointer; },
    set cueListPointer(v) { cueListPointer = v; },
    get lastEditRegion() { return lastEditRegion; },
    set lastEditRegion(v) { lastEditRegion = v; },
    get navigationOwner() { return navigationOwner; },
    set navigationOwner(v) { navigationOwner = v; },
    get lastPointerPos() { return lastPointerPos; },
    set lastPointerPos(v) { lastPointerPos = v; },
    get cueSplitPreviewEl() { return cueSplitPreviewEl; },
    set cueSplitPreviewEl(v) { cueSplitPreviewEl = v; },
    get cueSplitPreviewFrame() { return cueSplitPreviewFrame; },
    set cueSplitPreviewFrame(v) { cueSplitPreviewFrame = v; },
    get cueSplitPreviewRequest() { return cueSplitPreviewRequest; },
    set cueSplitPreviewRequest(v) { cueSplitPreviewRequest = v; },
    navigationOwnerForTarget,
    updateNavigationOwner,
    hideCueSplitPreview,
    scheduleCueSplitPreview,
    waveformPointerContext,
    keyboardOperationReference,
    getPointerBoundaryEditTarget,
    handlePointerBoundaryShortcut,
    hoveredSelectedCueContext
  });
})(typeof window !== 'undefined' ? window : globalThis);

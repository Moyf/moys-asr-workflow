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
      const segment = isExtension ? track?.segments?.[request.idx] : window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[request.idx];
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



  // Z/X 使用最后主动选择的轨道；空选区始终命中主轨。
  function getPointerBoundaryEditTarget(context) {
    if (!context) return null;
    const selection = MaweState.selection;
    const refs = selection.getSelectedCueRefs();
    const track = selection.getCurrentTrack();
    if (!track) return null;
    const kind = track.role === 'secondary' ? 'extension' : track.role;
    if (!['main', 'extension', 'overlay'].includes(kind)) return null;
    const selected = refs.filter((ref) => ref.track_id === track.id);
    if (!refs.length) {
      const index = MaweContextMenus.findWaveformCueAtTime(context.timeMs, track.segments);
      return index >= 0 && track.segments[index]
        ? { kind, index, trackId: track.id, track, segment: track.segments[index] } : null;
    }
    if (selected.length !== 1) return null;
    const current = selection.getCurrentCueRef();
    if (!current || current.track_id !== track.id || current.segment_id !== selected[0].segment_id) return null;
    const index = track.segments.findIndex((segment) => segment.id === current.segment_id);
    if (index < 0) return null;
    // 主副轨绑定会联动选中；只有同一绑定组才算一条逻辑字幕。
    const otherRefs = refs.filter((ref) => ref.track_id !== track.id);
    if (otherRefs.length) {
      const binding = kind === 'main'
        ? MaweMultiSubtitleCore.bindingForMainIndex(index)
        : kind === 'extension' ? MaweMultiSubtitleCore.bindingForExtensionIndex(index, track) : null;
      const partner = kind === 'main' ? binding?.target : binding?.source;
      if (otherRefs.length !== 1 || otherRefs[0].track_id !== partner?.track_id
          || otherRefs[0].segment_id !== partner?.segment_id) return null;
    }
    return { kind, index, trackId: track.id, track, segment: track.segments[index] };
  }



  // Z：起点定位；X：终点定位。多选时只接受一组绑定字幕。
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
        || MaweDom.ctxmenu.classList.contains('show')) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

    const reference = keyboardOperationReference();
    const context = reference ? { ...reference } : null;
    const target = getPointerBoundaryEditTarget(context);
    if (!reference || !target || !MaweCoreState.waveformEditor?.setCueBoundaryToTime) {
      if (!reference) MaweHint.flashHint('无有效的快捷键时间基准', 'invalid');
      return;
    }
    if (!MaweCoreState.waveformEditor.setCueBoundaryToTime(context.timeMs, edge, target.kind, target.index)) return;
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

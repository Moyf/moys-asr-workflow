// 波形初始化：WaveformEditor 装配与 reapeaks 懒加载。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweWaveformInit 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweWaveformInit(global) {
  'use strict';



  function initWaveformEditor() {
    if (!window.AsrWaveform) {
      MaweHint.flashHint('波形模块加载失败，字幕编辑仍可使用', 'warning');
      return;
    }
    MaweCoreState.waveformEditor = window.AsrWaveform.create({
      getSegments: (track = 'main') => track === 'extension'
        ? (MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || []) : MaweBoot.DATA.segments,
      getExtensionSegments: (trackId = null) => MaweMultiSubtitleCore.getExtensionTrack(trackId)?.segments || [],
      getCrossTrackSnapTargets: (track = 'main') => {
        if (!MaweMultiSubtitleCore.multiSubtitleVisible() || !MaweSettings.EDITOR_SETTINGS.crossTrackSnap) return [];
        const otherSegments = track === 'extension'
          ? MaweBoot.DATA.segments : (MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || []);
        return otherSegments.flatMap((segment) => [segment?.start, segment?.end])
          .filter((timeMs) => Number.isFinite(Number(timeMs)))
          .map((timeMs) => Number(timeMs));
      },
      getSelection: (track = 'main') => track === 'extension' ? selectedExtensionIdxs : selectedIdxs,
      getExtensionSelection: () => selectedExtensionIdxs,
      getBindingMarkerTargets: MaweMultiSubtitleCore.getBindingMarkerTargets,
      multiSubtitleVisible: () => MaweMultiSubtitleCore.multiSubtitleVisible(),
      // 波形上已经选中的块不会再次调用 selectCue；单独提供激活回调，
      // 避免联动选中主副字幕后点击另一条字幕时编辑区不切换。
      activateCue: (idx) => setCurrentCuePanelIndex(idx),
      enterCueEditor: (idx) => {
        setCurrentCuePanelIndex(idx);
        focusCuePanelText(idx, 'main');
      },
      activateExtensionCue: (idx) => {
        setCurrentCuePanelExtensionIndex(idx, MaweMultiSubtitleCore.getActiveExtensionTrack());
      },
      enterExtensionCueEditor: (idx) => {
        setCurrentCuePanelExtensionIndex(idx, MaweMultiSubtitleCore.getActiveExtensionTrack());
        focusCuePanelText(idx, 'extension');
      },
      selectCue: (idx) => {
        selectCueByClick(idx);
        lastClickedIdx = idx;
        const cue = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
        if (cue) scrollCueIntoViewIfNeeded(cue);
      },
      clearSelection: () => clearSelection(),
      toggleCueSelection: (idx) => {
        toggleSel(idx);
        lastClickedIdx = idx;
      },
      selectExtensionCue: (idx) => {
        selectOnlyExtension(idx);
        lastClickedExtensionIdx = idx;
      },
      toggleExtensionSelection: (idx) => {
        toggleExtensionSelection(idx, MaweMultiSubtitleCore.getActiveExtensionTrack());
        lastClickedExtensionIdx = idx;
      },
      selectExtensionRange: (idx) => {
        if (lastClickedExtensionIdx >= 0) selectExtensionRange(lastClickedExtensionIdx, idx);
        else selectOnlyExtension(idx);
        lastClickedExtensionIdx = idx;
      },
      selectCueRange: (idx) => {
        if (lastClickedIdx >= 0) selectRange(lastClickedIdx, idx);
        else selectOnly(idx);
        lastClickedIdx = idx;
      },
      // 波形 Shift+框选：把命中的一批下标追加进当前多选（追加语义，不改 Shift 锚点）
      addCueSelection: (idxs) => {
        idxs.forEach((idx) => addToSelection(idx));
      },
      addExtensionSelection: (idxs) => {
        const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
        idxs.forEach((idx) => addExtensionToSelection(idx, track));
      },
      seek: MaweTextCleanup.seekFromWaveform,
      onPlayheadDragStateChange: (active) => {
        MawePlaybackLoop.waveformPlayheadDragging = active === true;
      },
      togglePlayback: MaweMediaPlayback.togglePlayback,
      toggleDisabled: (idxs, track = 'main') => MaweStickerPicker.toggleDisabled(idxs, track),
      getHideDisabled: () => MaweDom.hideDisabled,
      getGapRemoveGaps: MaweGapRemoveData.getGapRemoveGaps,
      getGapOperationMode: getGapRemoveOperationMode,
      toggleGapRemoved,
      applyGapRange: applyManualGapRange,
      resizeGapBoundary: resizeManualGapBoundary,
      moveGap: (index, deltaMs) => translateManualGap(index, deltaMs, 'move'),
      copyGap: (index, deltaMs) => translateManualGap(index, deltaMs, 'copy'),
      previewGapAt: MawePlaybackLoop.previewGapAt,
      showGapContextMenu: (x, y, index) => MaweContextMenus.showGapContextMenu(x, y, index),
      showContextMenu: (x, y, idx, timeMs) => MaweContextMenus.showContextMenu(x, y, idx, timeMs),
      showExtensionContextMenu: (x, y, idx, timeMs) => MaweContextMenus.showExtensionContextMenu(x, y, idx, timeMs),
      showBlankWaveformMenu: (timeMs, x, y, track) => MaweContextMenus.showWaveformBlankMenu(timeMs, x, y, track),
      addCueRange: (startMs, endMs, x, y, track = 'main') => (
        MaweAddCue.addCueRangeFromWaveform(startMs, endMs, x, y, track)
      ),
      onCueCreateRejected: (reason) => {
        if (reason === 'too-short') MaweHint.flashHint('该空白区域不足 100ms，无法新增字幕', 'warning');
        if (reason === 'occupied') MaweHint.flashHint('该位置已有字幕，无法新增字幕', 'warning');
      },
      // 剃刀工具：在波形指针位置安全拆分字幕。复用右键菜单的波形时间拆分路径；
      // 有可靠主轨字词时间码时沿用字词锚点，否则在弹窗中保留指针的绝对切点。
      splitCueAtTime: (idx, timeMs) => splitFromContextMenu(idx, 0, 0, timeMs),
      getClickBehavior: () => MaweSettings.EDITOR_SETTINGS.clickBehavior,
      getClickTarget: () => MaweSettings.EDITOR_SETTINGS.clickTarget,
      getAutoSnapAdjacentCues: () => MaweSettings.EDITOR_SETTINGS.autoSnapAdjacentCues,
      getCueTiming: () => timelineTimingAdapter(),
      getSnapToFrame: () => timelineIsFrameMode() && MaweSettings.EDITOR_SETTINGS.timelineSnapToFrame,
      getWaveShapeSource: () => MaweSettings.EDITOR_SETTINGS.waveShapeSource,
      // JKL 倒放靠逐帧回退实现，媒体元素本身处于暂停态；倒放期间同样视为播放中。
      getHoverSeekPreview: () => MaweSettings.EDITOR_SETTINGS.hoverSeekPreview && !MaweJklPlayback.jklReversePlaying,
      showTrackBadges: () => MaweSettings.EDITOR_SETTINGS.multiSubtitleShowTrackBadges,
      onBeginEdit: (label) => MaweHistory.pushUndo(label),
      syncBoundCueDrag: MaweBoundDrag.syncBoundCueDrag,
      onLayoutUndo: (label, snapshot) => MaweHistory.pushLayoutUndo(label, snapshot),
      onCommitEdit: (idxs, kind, track = 'main', independent = false, details = null) => {
        let linkedChanged = false;
        if (kind === 'resize-boundary-pointer' && track === 'main' && !independent) {
          const targetIndex = Number.isInteger(details?.targetIndex) ? details.targetIndex : idxs[0];
          const main = MaweBoot.DATA.segments[targetIndex];
          const original = details?.original;
          if (main && original) {
            linkedChanged = MaweMultiSubtitleCore.syncBoundExtensionForMain(main, {
              oldStart: original.start,
              oldEnd: original.end,
              edge: details.edge,
              mode: 'range',
            });
          }
        }
        MaweTextCleanup.syncTimelineGroupRanges();
        // 拖动预览期间保持下标稳定；提交时再整理副轨数组，避免冲突裁剪后
        // 原本位于目标前面的字幕保留右侧区间而落到目标之后，保存时违反顺序契约。
        if (MaweMultiSubtitleCore.multiSubtitleVisible()) MaweMultiSubtitleCore.sortExtensionTrackSegments(MaweMultiSubtitleCore.getActiveExtensionTrack());
        MaweMultiSubtitleCore.syncBindingOffsets();
        MaweMultiSubtitleCore.markMainSegmentsDirty(track === 'main' ? idxs.map((idx) => MaweBoot.DATA.segments[idx]).filter(Boolean) : []);
        if (linkedChanged || MaweMultiSubtitleCore.multiSubtitleVisible() || track === 'extension') MaweMultiSubtitleCore.markMultiSubtitleDirty();
        renderAll();
        MawePlaybackLoop.updateWithoutCueListAutoScroll();
        MaweHint.flashHint(kind === 'move'
          ? track === 'extension'
            ? `已移动 ${idxs.length} 条副字幕`
            : `已${independent ? '独立' : '联动'}移动 ${idxs.length} 条字幕`
          : kind === 'resize-boundary-pointer'
            ? `已将${track === 'extension' ? '副字幕' : '字幕'}${details?.edge === 'start' ? '起点' : '终点'}定位到鼠标位置`
          : kind === 'resize-boundary'
            ? `已${independent ? '独立' : '联动'}调整第 ${idxs[0] + 1} / ${idxs[1] + 1} 条边界`
            : kind === 'resize-boundary-independent'
              ? `已独立调整第 ${idxs[0] + 1} 条字幕边界`
              : `已调整第 ${idxs[0] + 1} 条字幕时间`);
      },
      onPayload: (payload) => {
        MaweBoot.DATA.waveform = payload;
        MaweCoreState.waveformLoadedFromProject = false;
      },
    });
    MaweCoreState.waveformEditor.attachPlayer(MaweCoreState.player);
    MaweCoreState.waveformEditor.setLayoutData(MaweBoot.DATA.workspace || null, { render: false });
    MaweDisplaySettings.applyEditorDisplaySettings(MaweBoot.DATA.workspace?.editorDisplay);
    MaweCoreState.waveformEditor.setSpectralPayload(MaweBoot.DATA.spectral || null, { render: false });
    MaweCoreState.waveformEditor.setReapeaksWaveform(MaweBoot.DATA.waveform_reapeaks || null, { render: false });
    MaweCoreState.waveformLoadedFromProject = MaweCoreState.waveformEditor.setPayload(MaweBoot.DATA.waveform || null, { render: false });
  }



  async function loadDeferredReapeaks() {
    const url = MaweBoot.SERVER_CONFIG?.waveformUrl;
    if (!url || !MaweCoreState.waveformEditor) return;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error(result.error || `服务器返回 ${response.status}`);
      if (result.status === 'loading' || result.status === 'pending') {
        window.setTimeout(() => { void loadDeferredReapeaks(); }, 500);
        return;
      }
      if (result.status !== 'ready') return;
      const hasPayload = Boolean(result.spectral || result.waveform_reapeaks);
      if (!hasPayload) return;
      MaweBoot.DATA.spectral = result.spectral || null;
      MaweBoot.DATA.waveform_reapeaks = result.waveform_reapeaks || null;
      MaweCoreState.waveformEditor.setSpectralPayload(MaweBoot.DATA.spectral, { render: false });
      MaweCoreState.waveformEditor.setReapeaksWaveform(MaweBoot.DATA.waveform_reapeaks, { render: false });
      renderAll({ waveform: 'full' });
    } catch (_error) {
      window.setTimeout(() => { void loadDeferredReapeaks(); }, 1000);
    }
  }

  global.MaweWaveformInit = Object.freeze({
    initWaveformEditor,
    loadDeferredReapeaks
  });
})(typeof window !== 'undefined' ? window : globalThis);

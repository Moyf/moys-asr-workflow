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
      getSelection: (track = 'main') => track === 'extension' ? MaweSelection.selectedExtensionIdxs : MaweSelection.selectedIdxs,
      getExtensionSelection: () => MaweSelection.selectedExtensionIdxs,
      getBindingMarkerTargets: MaweMultiSubtitleCore.getBindingMarkerTargets,
      multiSubtitleVisible: () => MaweMultiSubtitleCore.multiSubtitleVisible(),
      // 波形上已经选中的块不会再次调用 selectCue；单独提供激活回调，
      // 避免联动选中主副字幕后点击另一条字幕时编辑区不切换。
      activateCue: (idx) => MaweCuePanel.setCurrentCuePanelIndex(idx),
      enterCueEditor: (idx) => {
        MaweCuePanel.setCurrentCuePanelIndex(idx);
        MaweCuePanel.focusCuePanelText(idx, 'main');
      },
      activateExtensionCue: (idx) => {
        MaweCuePanel.setCurrentCuePanelExtensionIndex(idx, MaweMultiSubtitleCore.getActiveExtensionTrack());
      },
      enterExtensionCueEditor: (idx) => {
        MaweCuePanel.setCurrentCuePanelExtensionIndex(idx, MaweMultiSubtitleCore.getActiveExtensionTrack());
        MaweCuePanel.focusCuePanelText(idx, 'extension');
      },
      selectCue: (idx) => {
        MaweBindingAlign.selectCueByClick(idx);
        MaweSelection.lastClickedIdx = idx;
        const cue = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
        if (cue) MaweCueListAnchor.scrollCueIntoViewIfNeeded(cue);
      },
      clearSelection: () => MaweSelection.clearSelection(),
      toggleCueSelection: (idx) => {
        MaweSelection.toggleSel(idx);
        MaweSelection.lastClickedIdx = idx;
      },
      selectExtensionCue: (idx) => {
        MaweSelection.selectOnlyExtension(idx);
        MaweSelection.lastClickedExtensionIdx = idx;
      },
      toggleExtensionSelection: (idx) => {
        MaweSelection.toggleExtensionSelection(idx, MaweMultiSubtitleCore.getActiveExtensionTrack());
        MaweSelection.lastClickedExtensionIdx = idx;
      },
      selectExtensionRange: (idx) => {
        if (MaweSelection.lastClickedExtensionIdx >= 0) MaweSelection.selectExtensionRange(MaweSelection.lastClickedExtensionIdx, idx);
        else MaweSelection.selectOnlyExtension(idx);
        MaweSelection.lastClickedExtensionIdx = idx;
      },
      selectCueRange: (idx) => {
        if (MaweSelection.lastClickedIdx >= 0) MaweSelection.selectRange(MaweSelection.lastClickedIdx, idx);
        else MaweSelection.selectOnly(idx);
        MaweSelection.lastClickedIdx = idx;
      },
      // 波形 Shift+框选：把命中的一批下标追加进当前多选（追加语义，不改 Shift 锚点）
      addCueSelection: (idxs) => {
        idxs.forEach((idx) => MaweSelection.addToSelection(idx));
      },
      addExtensionSelection: (idxs) => {
        const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
        idxs.forEach((idx) => MaweSelection.addExtensionToSelection(idx, track));
      },
      seek: (timeSec, options = {}) => {
        MaweTextCleanup.seekFromWaveform(timeSec, options);
        if (!options.dragPreview) resumeCueListFollowing();
      },
      onPlayheadDragStateChange: (active) => {
        MawePlaybackLoop.waveformPlayheadDragging = active === true;
        if (!active) resumeCueListFollowing();
      },
      togglePlayback: MaweMediaPlayback.togglePlayback,
      toggleDisabled: (idxs, track = 'main') => MaweStickerPicker.toggleDisabled(idxs, track),
      getHideDisabled: () => MaweDom.hideDisabled,
      getGapRemoveGaps: MaweGapRemoveData.getGapRemoveGaps,
      getGapOperationMode: MaweGapRemoveUi.getGapRemoveOperationMode,
      toggleGapRemoved: MaweGapRemoveUi.toggleGapRemoved,
      applyGapRange: MaweGapRemoveUi.applyManualGapRange,
      resizeGapBoundary: MaweGapRemoveUi.resizeManualGapBoundary,
      moveGap: (index, deltaMs) => MaweGapRemoveUi.translateManualGap(index, deltaMs, 'move'),
      copyGap: (index, deltaMs) => MaweGapRemoveUi.translateManualGap(index, deltaMs, 'copy'),
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
      splitCueAtTime: (idx, timeMs) => MaweSplitContext.splitFromContextMenu(idx, 0, 0, timeMs),
      getClickBehavior: () => MaweSettings.EDITOR_SETTINGS.clickBehavior,
      getClickTarget: () => MaweSettings.EDITOR_SETTINGS.clickTarget,
      getAutoSnapAdjacentCues: () => MaweSettings.EDITOR_SETTINGS.autoSnapAdjacentCues,
      getAdjacentBoundaryMode: () => MaweSettings.EDITOR_SETTINGS.adjacentBoundaryMode,
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
        MaweCuePanel.renderAll();
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
    // 振幅拟合要在 setLayoutData 之后：得先知道本工程是否已有手调决定。
    MaweCoreState.waveformEditor.setLoudnessStats(MaweBoot.DATA.loudness || null, { render: false });
  }



  // 原地切换工程（打开本地 .mosp / 新建空白 / 导入）会让 DATA 换成一个新工程，
  // 但服务器的 /api/waveform 仍描述它自己绑定的旧工程。每次 applyCanonicalProject
  // 递增该纪元；在途的延迟加载响应据此作废并终止轮询，旧工程的
  // spectral / 波形 / 响度载荷绝不会套到新工程的波形上。
  let deferredReapeaksEpoch = 0;

  // 重试必须绑定发起时的工程纪元：排期期间原地切换了工程，这次重试就该取消。
  // 否则新纪元的调用会原样接受旧工程的服务器载荷。
  function scheduleDeferredReapeaksRetry(delayMs, epoch) {
    window.setTimeout(() => {
      if (epoch === deferredReapeaksEpoch) void loadDeferredReapeaks();
    }, delayMs);
  }

  async function loadDeferredReapeaks() {
    const url = MaweBoot.SERVER_CONFIG?.waveformUrl;
    if (!url || !MaweCoreState.waveformEditor) return;
    const epoch = deferredReapeaksEpoch;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error(result.error || `服务器返回 ${response.status}`);
      if (result.status === 'loading' || result.status === 'pending') {
        scheduleDeferredReapeaksRetry(500, epoch);
        return;
      }
      if (epoch !== deferredReapeaksEpoch) return;
      if (result.status !== 'ready') return;
      const hasPayload = Boolean(result.spectral || result.waveform_reapeaks || result.loudness);
      if (!hasPayload) return;
      MaweBoot.DATA.spectral = result.spectral || null;
      MaweBoot.DATA.waveform_reapeaks = result.waveform_reapeaks || null;
      MaweBoot.DATA.loudness = result.loudness || null;
      MaweCoreState.waveformEditor.setSpectralPayload(MaweBoot.DATA.spectral, { render: false });
      MaweCoreState.waveformEditor.setReapeaksWaveform(MaweBoot.DATA.waveform_reapeaks, { render: false });
      // 响度标量可能先于/后于波形到达，setLoudnessStats 自己会决定要不要重绘。
      MaweCoreState.waveformEditor.setLoudnessStats(MaweBoot.DATA.loudness);
      MaweCoreState.waveformEditor.renderSegments();
    } catch (_error) {
      scheduleDeferredReapeaksRetry(1000, epoch);
    }
  }

  global.MaweWaveformInit = Object.freeze({
    initWaveformEditor,
    loadDeferredReapeaks,
    get deferredReapeaksEpoch() { return deferredReapeaksEpoch; },
    set deferredReapeaksEpoch(v) { deferredReapeaksEpoch = v; }
  });
})(typeof window !== 'undefined' ? window : globalThis);

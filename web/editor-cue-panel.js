// 当前字幕面板：renderAll 协调、目标切换与时间/items 重映射。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweCuePanel 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweCuePanel(global) {
  'use strict';



  // === 渲染 ===
  function renderAll({ waveform = 'overlay', preserveCueListScroll = true, cueListAnchor } = {}) {
    // 旧工程或新增字幕也必须在生成 DOM 前拥有唯一身份；复用工程既有规范化规则。
    window.AsrEditorUtils.ensureStableSegmentIds(MaweBoot.DATA.segments, 'main');
    (MaweMultiSubtitleCore.getMultiSubtitleState().tracks || []).forEach(track => {
      window.AsrEditorUtils.ensureStableSegmentIds(track.segments, `${track.id}-segment`);
    });
    // 其它编辑入口仍以毫秒修改工程对象；在重绘前把它们投影回当前时间基准，
    // 保证帧模式下保存的数据和下一次帧操作保持一致。
    MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
    cueListAnchor = preserveCueListScroll
      ? cueListAnchor || MaweCueListAnchor.cueListScroll.mutationAnchor || MaweCueListAnchor.captureCueListRenderAnchor() : null;
    MaweCueListAnchor.invalidateCueListVisualAnchorRestore();
    MaweStickerOverlay.stickerOverlayDataVersion += 1;
    // cues-container 同时是字幕列表和停靠模块；重绘列表时不要把布局编辑模式
    // 下的顶部拖拽栏一起清掉。
    const dockHandle = MaweCoreState.container.querySelector(':scope > .dock-handle');
    const cueListToolbar = MaweCoreState.container.querySelector(':scope > .cue-list-toolbar');
    const emptyState = MaweDom.cuesEmpty;
    MaweCoreState.container.replaceChildren();
    if (dockHandle) MaweCoreState.container.appendChild(dockHandle);
    if (cueListToolbar) MaweCoreState.container.appendChild(cueListToolbar);
    if (emptyState) {
      emptyState.classList.toggle('hidden', MaweBoot.DATA.segments.length > 0);
      MaweCoreState.container.appendChild(emptyState);
    }
    const cueFragment = document.createDocumentFragment();
    const multiVisible = MaweMultiSubtitleCore.multiSubtitleVisible();
    const displayMode = MaweMultiSubtitleCore.getMultiSubtitleState().display_mode || 'both';
    if (!multiVisible || displayMode === 'main') {
      MaweBoot.DATA.segments.forEach((seg, i) => cueFragment.appendChild(MaweCueElements.buildCueEl(seg, i)));
    } else if (displayMode === 'extension') {
      const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
      track.segments.forEach((seg, i) => cueFragment.appendChild(MaweCueElements.buildExtensionCueEl(seg, i, track)));
    } else {
      const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
      const rows = window.AsrEditorUtils.buildMultiDisplayRows(MaweBoot.DATA.segments, track.segments, MaweMultiSubtitleCore.getMultiSubtitleState().bindings);
      rows.forEach((row) => cueFragment.appendChild(MaweCueElements.buildDualCueEl(row.mainIndex, row.extensionIndex, track)));
    }
    MaweCoreState.container.appendChild(cueFragment);
    MaweDisplaySettings.applyCueListDisplaySettings({ preserveCueListScroll: false });
    MaweColorFilter.refreshColorFilterUi();
    MaweDom.totalCountEl.textContent = multiVisible && displayMode === 'extension'
      ? MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments.length || 0
      : MaweBoot.DATA.segments.length;
    // buildCueEl/buildMultiCueColumn 已经按当前搜索词生成了文本；这里仅
    // 计算隐藏状态和数量，避免长工程 renderAll() 再逐行重建一遍文本节点。
    MaweSearch.applySearch(MaweDom.searchEl.value, { refreshText: false, preserveCueListScroll: false });
    // 重新应用选中样式（idx 不变时还有效；如果有 splice 改了顺序就先 clearSelection）
    MaweSelection.selectedIdxs.forEach(i => {
      const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
      if (el) el.classList.add('selected');
    });
    // 字幕结构变化只需更新波形上的字幕块覆盖层；媒体峰值和行 Canvas
    // 没有变化，避免 B/C/删除等操作重新绘制整组波形。
    MaweSelection.updateMultiSelectionClasses();
    if (MaweCoreState.waveformEditor) {
      if (waveform === 'full') MaweCoreState.waveformEditor.renderSegments();
      else if (waveform !== 'none') {
        // 字幕块变化不需要重新创建行和 Canvas；兼容旧版波形对象时才回退到
        // 原来的完整刷新路径。
        if (typeof MaweCoreState.waveformEditor.refreshCueOverlay === 'function') MaweCoreState.waveformEditor.refreshCueOverlay();
        else MaweCoreState.waveformEditor.renderSegments();
      }
    }
    renderCurrentCuePanel();
    MaweMediaPlayback.syncPlayerPlaceholder();
    MaweDisplaySettings.updateMultiSubtitleUi();
    MaweExportSrt.updateSubtitleExportUi();
    MaweTimedTextEdit.refreshTimedTextEditButton();
    MaweGapRemoveUi.updateGapRemoveDisableHint();
    window.MAWE_ONBOARDING?.afterRender();
    MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
  }



  function parsePanelTime(value, fallback) {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    const timebase = MaweTimeline.projectTimebase();
    if (timebase.unit === 'frames') {
      const timecodeFrames = MaweTimeline.parseFrameTimecode(
        raw,
        timebase.fps,
        MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
      );
      if (timecodeFrames !== null) return MaweTimeline.millisecondsFromFrameNumber(timecodeFrames, timebase.fps);
      if (/^\d+(?:\.\d+)?\s*F?$/iu.test(raw)) {
        return MaweTimeline.millisecondsFromFrameNumber(Number.parseFloat(raw), timebase.fps);
      }
      return fallback;
    }
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
    const parts = raw.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return fallback;
    if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
    if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
    return fallback;
  }



  function remapPanelItems(items, oldStart, oldEnd, newStart, newEnd) {
    if (!Array.isArray(items) || !items.length) return items;
    const oldDuration = Math.max(1, oldEnd - oldStart);
    const newDuration = Math.max(1, newEnd - newStart);
    return items.map((item) => {
      // 等比缩放后钳回段内，并保证 end > start（防止取整后出现 0 长词块）。
      const mappedStart = Math.round(newStart + ((item.start - oldStart) / oldDuration) * newDuration);
      const mappedEnd = Math.round(newStart + ((item.end - oldStart) / oldDuration) * newDuration);
      let start = Math.min(Math.max(mappedStart, newStart), newEnd);
      const end = Math.min(Math.max(mappedEnd, start + 1), newEnd);
      if (end <= start) start = Math.max(newStart, end - 1);
      return { ...item, start, end };
    });
  }



  function getCurrentCuePanelTarget() {
    const index = MaweCuePanelState.currentCuePanelIdx;
    if (!Number.isInteger(index) || index < 0) return null;
    if (MaweCuePanelState.currentCuePanelKind === 'extension') {
      const track = MaweMultiSubtitleCore.getExtensionTrack(MaweCuePanelState.currentCuePanelTrackId);
      const segment = track?.segments?.[index];
      return segment
        ? { kind: 'extension', index, trackId: track.id, track, segment }
        : null;
    }
    const segment = MaweBoot.DATA.segments[index];
    return segment ? { kind: 'main', index, trackId: null, track: null, segment } : null;
  }



  function getCuePanelTextElement(target) {
    if (!target) return null;
    if (target.kind === 'extension') {
      return MaweCoreState.container.querySelector(
        `.multi-dual-cue[data-ext-idx="${target.index}"] .multi-cue-column.extension .text, `
          + `.multi-extension-cue[data-ext-idx="${target.index}"] > .text`,
      );
    }
    return MaweCoreState.container.querySelector(
      `.multi-dual-cue[data-main-idx="${target.index}"] .multi-cue-column.main .text, `
        + `.cue[data-idx="${target.index}"] > .text`,
    );
  }



  function setCuePanelTarget(kind, index, trackId = null) {
    const nextKind = kind === 'extension' ? 'extension' : 'main';
    let nextIndex = Number.isInteger(index) ? index : -1;
    let nextTrackId = nextKind === 'extension' ? trackId : null;
    if (nextKind === 'extension') {
      const track = MaweMultiSubtitleCore.getExtensionTrack(nextTrackId);
      if (!track?.segments?.[nextIndex]) {
        nextIndex = -1;
        nextTrackId = null;
      } else {
        nextTrackId = track.id;
      }
    } else if (!MaweBoot.DATA.segments[nextIndex]) {
      nextIndex = -1;
    }
    if (
      MaweCuePanelState.currentCuePanelKind === nextKind
      && MaweCuePanelState.currentCuePanelIdx === nextIndex
      && MaweCuePanelState.currentCuePanelTrackId === nextTrackId
    ) {
      renderCurrentCuePanel();
      return;
    }
    commitCuePanelEdit();
    MaweCuePanelState.currentCuePanelKind = nextKind;
    MaweCuePanelState.currentCuePanelIdx = nextIndex;
    MaweCuePanelState.currentCuePanelTrackId = nextTrackId;
    MaweCuePanelState.resetCuePanelEditState();
    renderCurrentCuePanel();
  }



  function setCurrentCuePanelIndex(index) {
    setCuePanelTarget('main', index);
  }



  function setCurrentCuePanelExtensionIndex(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    setCuePanelTarget('extension', index, track?.id || null);
  }



  function ensureCuePanelUndo(label = null) {
    if (!MaweCuePanelState.cuePanelUndoPushed) {
      const target = getCurrentCuePanelTarget();
      MaweCuePanelState.cuePanelUndoRecord = MaweHistory.pushUndo(
        label || (target?.kind === 'extension' ? '编辑副字幕' : '编辑当前字幕'),
      );
      MaweCuePanelState.cuePanelUndoPushed = true;
    }
  }



  function commitCuePanelEdit() {
    const target = getCurrentCuePanelTarget();
    const seg = target?.segment;
    if (!target || !seg) { MaweCuePanelState.resetCuePanelEditState(); return false; }
    const segments = target.kind === 'extension' ? target.track.segments : MaweBoot.DATA.segments;
    const idx = target.index;
    const nextText = MaweDom.cuePanelText.value.replace(/\r\n?/g, '\n');
    const oldStart = seg.start;
    const oldEnd = seg.end;
    const minimumDurationMs = MaweTimeline.timelineMinimumDurationMs();
    const requestedStart = parsePanelTime(MaweDom.cuePanelStart.value, oldStart);
    const requestedDuration = Math.max(
      minimumDurationMs,
      parsePanelTime(MaweDom.cuePanelDuration.value, oldEnd - oldStart),
    );
    const previousEnd = idx > 0 ? segments[idx - 1].end : 0;
    const nextStart = idx + 1 < segments.length ? segments[idx + 1].start : (MaweCoreState.waveformEditor?.durationMs || oldEnd);
    if (nextStart - previousEnd < minimumDurationMs) {
      MaweHint.flashHint('相邻字幕之间不足 100ms，无法调整当前字幕', 'warning');
      renderCurrentCuePanel();
      MaweCuePanelState.resetCuePanelEditState();
      return false;
    }
    const newStart = Math.max(previousEnd, Math.min(requestedStart, nextStart - minimumDurationMs));
    const newEnd = Math.min(nextStart, newStart + requestedDuration);
    if (newEnd - newStart < minimumDurationMs) {
      MaweHint.flashHint('字幕时长不能小于 100ms', 'warning');
      renderCurrentCuePanel();
      MaweCuePanelState.resetCuePanelEditState();
      return false;
    }
    const changed = nextText !== seg.text || newStart !== oldStart || newEnd !== oldEnd;
    if (!changed) {
      MaweCuePanelState.resetCuePanelEditState();
      return false;
    }
    ensureCuePanelUndo();
    seg.text = nextText;
    seg.start = newStart;
    seg.end = Math.max(newStart + minimumDurationMs, newEnd);
    if (seg.end > nextStart) {
      seg.end = nextStart;
      seg.start = Math.max(previousEnd, seg.end - minimumDurationMs);
    }
    if (target.kind === 'main') {
      seg.items = remapPanelItems(seg.items, oldStart, oldEnd, seg.start, seg.end);
    }
    seg._dirty = true;
    const timingChanged = seg.start !== oldStart || seg.end !== oldEnd;
    if (target.kind === 'main') {
      if (timingChanged) {
        const syncPatch = { oldStart, oldEnd, mode: 'range' };
        MaweMultiSubtitleCore.syncBoundExtensionForMain(seg, syncPatch);
        if (syncPatch.syncConflict) {
          const details = [];
          if (syncPatch.syncSqueezedCount) details.push(`挤压 ${syncPatch.syncSqueezedCount} 条副字幕`);
          if (syncPatch.syncRemovedCount) {
            details.push(`删除 ${syncPatch.syncRemovedCount} 条副字幕`);
          }
          MaweHint.flashHint(
            details.length
              ? `副字幕已联动调整，${details.join('，')}${syncPatch.syncUnboundCount ? '并解除绑定' : ''}`
              : '副字幕已随主字幕联动调整',
            details.length ? 'warning' : 'success',
          );
        }
      }
    } else {
      if (timingChanged) {
        const blocked = MaweMultiSubtitleCore.constrainBoundExtensionPanelEdit(seg, target.track, oldStart, oldEnd);
        if (blocked) MaweHint.flashHint('主字幕轨道已无可用空间，已限制副字幕时间', 'warning');
      }
    }
    MaweMultiSubtitleCore.syncBindingOffsets();
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweServerSave.scheduleAutoSaveFlush();
    MaweCuePanelState.resetCuePanelEditState();
    renderAll();
    MawePlaybackLoop.updateWithoutCueListAutoScroll();
    return true;
  }



  function renderCurrentCuePanel() {
    if (!MaweDom.cuePanel) return;
    const target = getCurrentCuePanelTarget();
    const idx = target?.index ?? -1;
    const seg = target?.segment || null;
    const empty = !target;
    MaweDom.cuePanel.classList.toggle('empty', empty);
    MaweDom.cuePanel.classList.toggle('extension-target', !empty && target.kind === 'extension');
    if (MaweDom.cuePanelTarget) {
      const label = empty ? '未选择' : target.kind === 'extension' ? '副字幕' : '主字幕';
      MaweDom.cuePanelTarget.textContent = window.MAWE_I18N?.translateText?.(label) || label;
      MaweDom.cuePanelTarget.classList.toggle('extension', !empty && target.kind === 'extension');
    }
    [MaweDom.cuePanelPrev, MaweDom.cuePanelNext, MaweDom.cuePanelStart, MaweDom.cuePanelDuration, MaweDom.cuePanelText, MaweDom.cuePanelAddSticker, MaweDom.cuePanelSplit]
      .forEach((element) => { if (element) element.disabled = empty; });
    const stickersEnabled = !empty && target.kind === 'main';
    if (MaweDom.cuePanelAddSticker) MaweDom.cuePanelAddSticker.disabled = !stickersEnabled;
    if (MaweDom.cuePanelSticker) {
      MaweDom.cuePanelSticker.classList.toggle('disabled', !stickersEnabled);
      MaweDom.cuePanelSticker.setAttribute('aria-disabled', stickersEnabled ? 'false' : 'true');
    }
    if (empty) {
      MaweDom.cuePanelText.value = '';
      MaweDom.cuePanelStart.value = '';
      MaweDom.cuePanelDuration.value = '';
      MaweDom.cuePanelTotalLength.textContent = '0';
      MaweDom.cuePanelCharsPerSecond.textContent = '0.00';
      MaweDom.cuePanelSticker.replaceChildren();
      MaweDom.cuePanelSticker.textContent = window.MAWE_I18N?.translateText?.('未选择') || '未选择';
      return;
    }
    if (document.activeElement !== MaweDom.cuePanelText || !MaweCuePanelState.cuePanelUndoPushed) MaweDom.cuePanelText.value = seg.text || '';
    MaweDom.cuePanelStart.value = MaweCueElements.fmtShort(seg.start);
    MaweDom.cuePanelDuration.value = MaweTimeline.timelineIsFrameMode()
      ? MaweTimeline.formatTimelineTimecode(
        seg.end - seg.start,
        MaweTimeline.projectTimebase().fps,
        MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
      )
      : ((seg.end - seg.start) / 1000).toFixed(3);
    const splitMode = target.kind === 'extension'
      ? MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(target.track, seg)
      : MaweMultiSubtitleCore.getMainSubtitleSplitMode(seg);
    const metrics = window.AsrEditorUtils.cueMetrics(
      seg.text || '', seg.start, seg.end, splitMode,
    );
    MaweDom.cuePanelTotalLength.textContent = String(metrics.totalLength);
    MaweDom.cuePanelCharsPerSecond.textContent = metrics.charsPerSecond.toFixed(2);
    MaweDom.cuePanelSticker.replaceChildren();
    if (seg.sticker) {
      const image = document.createElement('img');
      image.src = MaweSelection.stickerUrl(seg.sticker);
      image.alt = seg.sticker.name || '表情包';
      MaweDom.cuePanelSticker.title = '点击替换；右键删除';
      MaweDom.cuePanelSticker.appendChild(image);
    } else if (seg.sticker_ref) {
      const ref = document.createElement('span');
      ref.className = 'ref';
      ref.textContent = `↑ ${seg.sticker_ref.name || '表情包'}`;
      MaweDom.cuePanelSticker.title = '点击选择表情包；右键删除引用';
      MaweDom.cuePanelSticker.appendChild(ref);
    } else {
      MaweDom.cuePanelSticker.textContent = window.MAWE_I18N?.translateText?.('暂无表情包') || '暂无表情包';
      MaweDom.cuePanelSticker.title = window.MAWE_I18N?.translateText?.('点击添加表情包') || '点击添加表情包';
    }
    const segments = target.kind === 'extension' ? target.track.segments : MaweBoot.DATA.segments;
    const previous = window.AsrEditorUtils.findAdjacentCueIndex(segments, idx, -1, MaweDom.hideDisabled);
    const next = window.AsrEditorUtils.findAdjacentCueIndex(segments, idx, 1, MaweDom.hideDisabled);
    MaweDom.cuePanelPrev.disabled = previous < 0;
    MaweDom.cuePanelNext.disabled = next < 0;
  }



  function focusCuePanelText(idx = MaweCuePanelState.currentCuePanelIdx, kind = MaweCuePanelState.currentCuePanelKind) {
    const target = getCurrentCuePanelTarget();
    if (!MaweDom.cuePanelText || !target || target.index !== idx || target.kind !== kind) return false;
    MaweDom.cuePanelText.focus();
    const end = MaweDom.cuePanelText.value.length;
    MaweDom.cuePanelText.setSelectionRange(end, end);
    return true;
  }



  function dirtyFlagSnapshot(value) {
    return value && Object.prototype.hasOwnProperty.call(value, '_dirty') ? value._dirty : null;
  }



  function restoreDirtyFlag(target, value) {
    if (!target) return;
    if (value === null) delete target._dirty;
    else target._dirty = value;
  }



  function captureCuePanelTextEditSnapshot() {
    const target = getCurrentCuePanelTarget();
    if (!target || !MaweDom.cuePanelText) {
      MaweCuePanelState.cuePanelTextEditSnapshot = null;
      return;
    }
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    MaweCuePanelState.cuePanelTextEditSnapshot = {
      kind: target.kind,
      index: target.index,
      trackId: target.trackId,
      text: target.segment.text || '',
      dirty: dirtyFlagSnapshot(target.segment),
      multiDirty: target.kind === 'extension' ? {
        state: dirtyFlagSnapshot(multi),
        tracks: (multi.tracks || []).map((track) => ({
          state: dirtyFlagSnapshot(track),
          segments: (track.segments || []).map((segment) => dirtyFlagSnapshot(segment)),
        })),
      } : null,
    };
  }



  function restoreCuePanelTextEditSnapshot() {
    const snapshot = MaweCuePanelState.cuePanelTextEditSnapshot;
    const target = getCurrentCuePanelTarget();
    if (!snapshot || !target
        || snapshot.kind !== target.kind
        || snapshot.index !== target.index
        || snapshot.trackId !== target.trackId) return false;
    target.segment.text = snapshot.text;
    restoreDirtyFlag(target.segment, snapshot.dirty);
    if (snapshot.multiDirty) {
      const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
      restoreDirtyFlag(multi, snapshot.multiDirty.state);
      snapshot.multiDirty.tracks.forEach((trackSnapshot, trackIndex) => {
        const track = multi.tracks?.[trackIndex];
        if (!track) return;
        restoreDirtyFlag(track, trackSnapshot.state);
        trackSnapshot.segments.forEach((dirty, segmentIndex) => {
          restoreDirtyFlag(track.segments?.[segmentIndex], dirty);
        });
      });
    }
    return true;
  }



  function discardPendingCuePanelUndo() {
    const record = MaweCuePanelState.cuePanelUndoRecord;
    if (MaweCuePanelState.cuePanelUndoPushed && record && MaweHistory.editorHistory.peekUndo() === record) {
      MaweHistory.editorHistory.popUndo({
        kind: 'segments',
        label: record.label,
        segs: MaweHistory.snapshotSegments(),
      });
      // 这条记录本来就清空了 redo；popUndo 临时生成的镜像也不能留下。
      MaweHistory.editorHistory.clearRedo();
      MaweHistory.updateUndoRedoButtons();
    }
    MaweCuePanelState.resetCuePanelEditState();
  }



  function cancelCuePanelTextEdit() {
    const restored = restoreCuePanelTextEditSnapshot();
    discardPendingCuePanelUndo();
    if (restored) {
      renderAll();
      MawePlaybackLoop.updateWithoutCueListAutoScroll();
    }
    if (document.activeElement === MaweDom.cuePanelText) {
      MaweCuePanelState.cuePanelCanceling = true;
      MaweDom.cuePanelText.blur();
      MaweCuePanelState.cuePanelCanceling = false;
    }
    return restored;
  }



  function exitCuePanelEdit() {
    if (!MaweDom.cuePanelText) return false;
    if (document.activeElement === MaweDom.cuePanelText) {
      // blur 事件负责提交，和 Esc 的行为保持一致。
      MaweDom.cuePanelText.blur();
      return true;
    }
    return commitCuePanelEdit();
  }


  function navigateCuePanel(direction) {
    const target = getCurrentCuePanelTarget();
    if (!target) return;
    commitCuePanelEdit();
    const next = window.AsrEditorUtils.findAdjacentCueIndex(
      target.kind === 'extension' ? target.track.segments : MaweBoot.DATA.segments,
      target.index,
      direction,
      MaweDom.hideDisabled,
    );
    if (next < 0) return;
    const segments = target.kind === 'extension' ? target.track.segments : MaweBoot.DATA.segments;
    if (target.kind === 'extension') {
      MaweSelection.selectOnlyExtension(next);
      MaweSelection.lastClickedExtensionIdx = next;
    } else {
      MaweSelection.selectOnly(next);
      MaweSelection.lastClickedIdx = next;
    }
    const cue = MaweCoreState.container.querySelector(
      target.kind === 'extension' ? `.cue[data-ext-idx="${next}"]` : `.cue[data-idx="${next}"]`,
    );
    if (cue) MaweCueListAnchor.scrollCueToCenter(cue);
    MaweCoreState.waveformEditor?.revealTime(segments[next].start, true);
  }



  function splitCuePanelAtCursor() {
    const target = getCurrentCuePanelTarget();
    if (!target) return;
    const cursorOffset = MaweDom.cuePanelText.selectionStart;
    if (target.kind === 'extension') {
      const splitTime = MaweSplitCore.splitTimeForTextOffset(target.segment, cursorOffset);
      commitCuePanelEdit();
      const refreshed = getCurrentCuePanelTarget();
      if (!refreshed) return;
      MaweSplitCore.openExtensionSplitModal(
        refreshed.index,
        MaweSplitCore.splitTimeForTextOffset(refreshed.segment, cursorOffset) || splitTime,
        refreshed.track,
      );
      return;
    }
    const idx = target.index;
    commitCuePanelEdit();
    MaweSelection.selectOnly(idx);
    const cue = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
    if (!cue) return;
    MaweInlineEdit.startEdit(cue, idx);
    const textEl = MaweInlineEdit.editingState?.textEl;
    if (!textEl || !textEl.firstChild) return;
    const range = document.createRange();
    const offset = Math.max(0, Math.min(cursorOffset, textEl.firstChild.textContent.length));
    range.setStart(textEl.firstChild, offset);
    range.setEnd(textEl.firstChild, offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    MaweSplitCore.splitAtCursor(null, { listFeedback: false });
  }

  global.MaweCuePanel = Object.freeze({
    renderAll,
    parsePanelTime,
    remapPanelItems,
    getCurrentCuePanelTarget,
    getCuePanelTextElement,
    setCuePanelTarget,
    setCurrentCuePanelIndex,
    setCurrentCuePanelExtensionIndex,
    ensureCuePanelUndo,
    commitCuePanelEdit,
    renderCurrentCuePanel,
    focusCuePanelText,
    dirtyFlagSnapshot,
    restoreDirtyFlag,
    captureCuePanelTextEditSnapshot,
    restoreCuePanelTextEditSnapshot,
    discardPendingCuePanelUndo,
    cancelCuePanelTextEdit,
    exitCuePanelEdit,
    navigateCuePanel,
    splitCuePanelAtCursor
  });
})(typeof window !== 'undefined' ? window : globalThis);

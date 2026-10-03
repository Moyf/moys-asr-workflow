// 空隙移除 UI：列表渲染、总时长统计、扫描移除与面板状态。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweGapRemoveUi 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweGapRemoveUi(global) {
  'use strict';



  function setGapRemoveData(
    next,
    { dirty = true, provenance = null, manualOverrides = null, clearProvenance = false } = {},
  ) {
    const payload = next && typeof next === 'object' ? { ...next } : {};
    if (clearProvenance) {
      payload.provenance = window.AsrGapRemoveCore.normalizeGapRemoveProvenance(null, []);
    } else if (provenance) {
      payload.provenance = provenance;
    } else if (manualOverrides) {
      payload.provenance = window.AsrGapRemoveCore.appendGapRemoveManualOverrides(
        payload.provenance,
        manualOverrides,
        payload.gaps,
      );
    }
    MaweBoot.DATA.gap_remove = MaweGapRemoveData.normalizedGapRemoveData(payload);
    MaweCuePanelState.gapPreviewRange = null;
    if (dirty) MaweHistory.gapRemoveDirty = true;
    updateGapRemoveUi();
  }



  function commitManualGapRemoveChange(state, overrides) {
    const core = window.AsrGapRemoveCore;
    const currentGaps = core.normalizeGapRemoveGaps(state?.gaps);
    const provenance = core.appendGapRemoveManualOverrides(
      state?.provenance,
      overrides,
      currentGaps,
    );
    const projectedGaps = core.gapRangesFromProvenance(provenance);
    state.gaps = projectedGaps;
    state.provenance = provenance;
    state.manual_corrections = true;
    setGapRemoveData(state, { provenance });
    return projectedGaps;
  }



  function gapRemoveTotalMs(gaps) {
    return getRemovedGapRangesFrom(gaps).reduce((total, gap) => total + gap.end - gap.start, 0);
  }



  function gapRemoveMediaDurationMs() {
    const candidates = [
      MaweCoreState.waveformEditor?.durationMs,
      MaweBoot.DATA.waveform?.duration_ms,
      Number(MaweCoreState.player?.duration) * 1000,
    ];
    const duration = candidates.find((value) => Number.isFinite(Number(value)) && Number(value) > 0);
    return duration ? Math.round(Number(duration)) : 0;
  }



  function formatGapRemoveTotal(totalMs) {
    return window.AsrEditorUtils.formatGapRemoveDuration(totalMs, gapRemoveMediaDurationMs());
  }



  function getRemovedGapRangesFrom(gaps) {
    return window.AsrEditorUtils.getRemovedGapRanges(gaps);
  }



  function getGapRemoveOperationMode() {
    return MaweGapRemoveData.getGapRemoveData(false)?.operation_mode || MaweGapRemoveData.DEFAULT_GAP_REMOVE_OPERATION_MODE;
  }



  function renderGapRemoveList() {
    if (!MaweDom.gapRemoveList) return;
    const state = MaweGapRemoveData.getGapRemoveData(false);
    const gaps = MaweGapRemoveData.getGapRemoveGaps();
    MaweDom.gapRemoveList.replaceChildren();
    if (state?.detector === 'legacy_subtitle_gap') {
      MaweDom.gapRemoveList.textContent = '此工程含有旧版按字幕间隔识别的结果。为避免误删，旧结果已停用；请按当前波形重新扫描。';
      return;
    }
    if (!gaps.length) {
      const message = document.createElement('div');
      message.className = 'gap-remove-total';
      message.textContent = '未能找到符合门限的静音空隙；尝试提高「音量阈值」来检测更多静音。';
      MaweDom.gapRemoveList.appendChild(message);
      return;
    }
    const removedCount = gaps.filter((gap) => gap.removed).length;
    const total = gapRemoveTotalMs(gaps);
    const summary = document.createElement('div');
    summary.className = 'gap-remove-total';
    summary.textContent = `已移除 ${removedCount}/${gaps.length} 段，共 ${formatGapRemoveTotal(total)}；左键定位，Alt+点击切换，空白处 Alt+左键拖动增加，空隙块左键拖动偏移，Ctrl/Cmd+拖动复制。`;
    MaweDom.gapRemoveList.appendChild(summary);
  }



  function updateGapRemoveDisableHint() {
    if (!MaweDom.gapRemoveDisableHint) return;
    const matches = window.AsrEditorUtils.findGapRemoveDisableMatches(
      MaweBoot.DATA.segments,
      MaweGapRemoveData.getGapRemoveGaps(),
      {
        coveragePercent: MaweGapRemoveData.clampGapRemoveDisableCoverage(MaweDom.gapRemoveDisableCoverage?.value),
        remainingMs: MaweGapRemoveData.clampGapRemoveDisableRemaining(MaweDom.gapRemoveDisableRemaining?.value),
      },
    );
    const count = matches.filter(({ index }) => !MaweBoot.DATA.segments[index]?.disabled).length;
    MaweDom.gapRemoveDisableHint.textContent = `禁用位于空隙范围内的字幕（当前有 ${count} 条未禁用）`;
  }



  function updateGapRemoveUi() {
    const state = MaweGapRemoveData.getGapRemoveData(false);
    const gaps = MaweGapRemoveData.getGapRemoveGaps();
    if (MaweDom.gapRemoveThreshold && state) MaweDom.gapRemoveThreshold.value = String(state.minimum_ms);
    if (MaweDom.gapRemoveVolumeThreshold && state) MaweDom.gapRemoveVolumeThreshold.value = String(state.threshold_db);
    if (MaweDom.gapRemoveHysteresis && state) MaweDom.gapRemoveHysteresis.value = String(state.hysteresis_db);
    updateGapRemoveHysteresisHint();
    if (MaweDom.gapRemoveLeadIn && state) MaweDom.gapRemoveLeadIn.value = String(state.lead_in_ms);
    if (MaweDom.gapRemoveLeadOut && state) MaweDom.gapRemoveLeadOut.value = String(state.lead_out_ms);
    if (MaweDom.gapRemoveDisableCoverage && state) {
      MaweDom.gapRemoveDisableCoverage.value = String(
        state.disable_coverage_percent ?? MaweGapRemoveData.DEFAULT_GAP_REMOVE_DISABLE_COVERAGE_PERCENT,
      );
    }
    if (MaweDom.gapRemoveDisableRemaining && state) {
      MaweDom.gapRemoveDisableRemaining.value = String(
        state.disable_remaining_ms ?? MaweGapRemoveData.DEFAULT_GAP_REMOVE_DISABLE_REMAINING_MS,
      );
    }
    if (MaweDom.gapRemoveOperationMode) {
      MaweDom.gapRemoveOperationMode.value = state?.operation_mode || MaweGapRemoveData.DEFAULT_GAP_REMOVE_OPERATION_MODE;
    }
    if (MaweDom.gapRemoveSkipPlayback) MaweDom.gapRemoveSkipPlayback.checked = state?.skip_playback !== false;
    if (MaweDom.gapRemoveClearAllButton) MaweDom.gapRemoveClearAllButton.disabled = !gaps.length;
    if (MaweDom.gapRemoveDisableButton) MaweDom.gapRemoveDisableButton.disabled = !gaps.some((gap) => gap.removed);
    updateGapRemoveDisableHint();
    if (MaweDom.gapRemovedExportDropdown) {
      MaweDom.gapRemovedExportDropdown.hidden = !gaps.some((gap) => gap.removed);
      if (MaweDom.gapRemovedExportDropdown.hidden) MaweDom.gapRemovedExportDropdown.classList.remove('open');
    }
    renderGapRemoveList();
    MaweCoreState.waveformEditor?.refreshGapOverlay();
  }



  function scanAndRemoveGaps() {
    const minimumMs = MaweSettings.clampGapRemoveMinimum(MaweDom.gapRemoveThreshold?.value);
    const thresholdDb = MaweSettings.clampGapRemoveThreshold(MaweDom.gapRemoveVolumeThreshold?.value);
    const hysteresisDb = MaweSettings.clampGapRemoveHysteresis(MaweDom.gapRemoveHysteresis?.value);
    const leadInMs = MaweSettings.clampGapRemoveLeadMs(MaweDom.gapRemoveLeadIn?.value, MaweGapRemoveData.DEFAULT_GAP_REMOVE_LEAD_IN_MS);
    const leadOutMs = MaweSettings.clampGapRemoveLeadMs(MaweDom.gapRemoveLeadOut?.value, MaweGapRemoveData.DEFAULT_GAP_REMOVE_LEAD_OUT_MS);
    const waveform = MaweCoreState.waveformEditor?.getGapRemoveDetectionData?.();
    if (!waveform) {
      MaweHint.flashHint('波形数据尚不可用，无法按音量判断空隙；请先加载媒体。', 'invalid');
      return;
    }
    const previousState = MaweGapRemoveData.getGapRemoveData(false);
    const gaps = window.AsrEditorUtils.detectAudioGapRemoveGaps(waveform, {
      minimumMs,
      thresholdDb,
      hysteresisDb,
      leadInMs,
      leadOutMs,
    });
    const provenance = window.AsrGapRemoveCore.replaceGapRemoveProvenanceSource(
      previousState?.provenance,
      'audio_gate',
      gaps,
      previousState?.gaps,
    );
    MaweHistory.pushGapRemoveUndo('扫描并移除静音空隙');
    setGapRemoveData({
      detector: 'audio_gate',
      minimum_ms: minimumMs,
      threshold_db: thresholdDb,
      hysteresis_db: hysteresisDb,
      lead_in_ms: leadInMs,
      lead_out_ms: leadOutMs,
      skip_playback: previousState?.skip_playback,
      operation_mode: previousState?.operation_mode,
      disable_coverage_percent: previousState?.disable_coverage_percent,
      disable_remaining_ms: previousState?.disable_remaining_ms,
      gaps: window.AsrGapRemoveCore.gapRangesFromProvenance(provenance),
    }, { provenance });
    MaweHint.flashHint(
      gaps.length
        ? `已移除 ${gaps.length} 段音量空隙，共 ${formatGapRemoveTotal(gapRemoveTotalMs(gaps))}`
        : '没有达到门限的音量空隙',
      gaps.length ? 'success' : 'invalid',
    );
  }



  function readGapRemoveLeadPadding() {
    const read = (input, fallback) => {
      const raw = input?.value;
      const numeric = typeof raw === 'string' && !raw.trim() ? NaN : Number(raw);
      return Math.min(2000, Math.max(0, Number.isFinite(numeric) ? Math.round(numeric) : fallback));
    };
    return {
      leadInMs: read(MaweDom.gapRemoveLeadIn, MaweGapRemoveData.DEFAULT_GAP_REMOVE_LEAD_IN_MS),
      leadOutMs: read(MaweDom.gapRemoveLeadOut, MaweGapRemoveData.DEFAULT_GAP_REMOVE_LEAD_OUT_MS),
    };
  }



  function shrinkExistingGaps() {
    const state = MaweGapRemoveData.getGapRemoveData(false);
    const core = window.AsrGapRemoveCore;
    const audioGaps = core.normalizeGapRemoveGaps(
      state?.provenance?.sources?.audio_gate,
    );
    if (!state || !audioGaps.length) {
      MaweHint.flashHint('当前没有可收缩的静音空隙', 'invalid');
      return;
    }
    const { leadInMs, leadOutMs } = readGapRemoveLeadPadding();
    const nextAudioGaps = window.AsrEditorUtils.shrinkGapRemoveGaps(audioGaps, leadInMs, leadOutMs);
    if (JSON.stringify(nextAudioGaps) === JSON.stringify(audioGaps)) {
      MaweHint.flashHint('当前空隙无法按预留量继续收缩', 'invalid');
      return;
    }
    MaweHistory.pushGapRemoveUndo('按预留量收缩空隙');
    // 批量收缩属于 audio_gate 的重建，不是用户逐段做出的 manual 覆盖。
    // 因此只替换静音来源，保留已有的人工恢复/移动等 overrides。
    const provenance = core.replaceGapRemoveProvenanceSource(
      state.provenance,
      'audio_gate',
      nextAudioGaps,
      state.gaps,
    );
    const nextGaps = core.gapRangesFromProvenance(provenance);
    state.lead_in_ms = leadInMs;
    state.lead_out_ms = leadOutMs;
    state.gaps = nextGaps;
    state.provenance = provenance;
    state.manual_corrections = provenance.manual_overrides.length > 0;
    setGapRemoveData(state, { provenance });
    MaweHint.flashHint(
      `已按前端 ${leadInMs}ms、后端 ${leadOutMs}ms 收缩 ${audioGaps.length} 段空隙`,
      'success',
    );
  }



  function readGapRemoveDisableSettings() {
    const coveragePercent = MaweGapRemoveData.clampGapRemoveDisableCoverage(MaweDom.gapRemoveDisableCoverage?.value);
    const remainingMs = MaweGapRemoveData.clampGapRemoveDisableRemaining(MaweDom.gapRemoveDisableRemaining?.value);
    if (MaweDom.gapRemoveDisableCoverage) MaweDom.gapRemoveDisableCoverage.value = String(coveragePercent);
    if (MaweDom.gapRemoveDisableRemaining) MaweDom.gapRemoveDisableRemaining.value = String(remainingMs);
    return { coveragePercent, remainingMs };
  }



  function commitGapRemoveDisableSettings() {
    const settings = readGapRemoveDisableSettings();
    const state = MaweGapRemoveData.getGapRemoveData(false);
    if (!state) {
      updateGapRemoveDisableHint();
      return settings;
    }
    if (state.disable_coverage_percent === settings.coveragePercent
        && state.disable_remaining_ms === settings.remainingMs) {
      updateGapRemoveDisableHint();
      return settings;
    }
    state.disable_coverage_percent = settings.coveragePercent;
    state.disable_remaining_ms = settings.remainingMs;
    setGapRemoveData(state);
    return settings;
  }



  function disableSubtitlesInRemovedGaps() {
    const settings = commitGapRemoveDisableSettings();
    const matches = window.AsrEditorUtils.findGapRemoveDisableMatches(
      MaweBoot.DATA.segments,
      MaweGapRemoveData.getGapRemoveGaps(),
      settings,
    );
    const targetIndexes = matches
      .map((match) => match.index)
      .filter((index) => !MaweBoot.DATA.segments[index]?.disabled);
    if (!targetIndexes.length) {
      const message = matches.length ? '符合条件的字幕已全部禁用' : '没有符合条件的字幕';
      MaweHint.flashHint(
        window.MAWE_I18N?.translateText?.(message) || message,
        matches.length ? 'success' : 'invalid',
      );
      return;
    }
    MaweStickerPicker.toggleDisabled(targetIndexes, 'main', { successDetail: '静音空隙内的字幕' });
  }



  function toggleGapRemoved(index) {
    const state = MaweGapRemoveData.getGapRemoveData(false);
    const gaps = MaweGapRemoveData.getGapRemoveGaps();
    const gap = gaps[index];
    if (!gap) return;
    MaweHistory.pushGapRemoveUndo(gap.removed === false ? '再次移除静音空隙' : '恢复静音空隙');
    const removed = gap.removed === false;
    commitManualGapRemoveChange(
      state,
      [{ start: gap.start, end: gap.end, removed }],
    );
    MaweHint.flashHint(removed ? '已人工移除静音空隙' : '已人工恢复静音空隙', 'success');
  }



  function clearGap(index) {
    const state = MaweGapRemoveData.getGapRemoveData(false);
    const gaps = MaweGapRemoveData.getGapRemoveGaps();
    const gap = gaps[index];
    if (!gap) return;
    const core = window.AsrGapRemoveCore;
    const provenance = core.removeGapRemoveProvenanceRange(
      state?.provenance,
      gap.start,
      gap.end,
      state?.gaps,
    );
    const nextGaps = core.gapRangesFromProvenance(provenance);
    MaweHistory.pushGapRemoveUndo('清理空隙区段');
    state.gaps = nextGaps;
    state.provenance = provenance;
    state.manual_corrections = provenance.manual_overrides.length > 0;
    setGapRemoveData(state, { provenance });
    MaweHint.flashHint('已清理空隙区段', 'success');
  }



  function applyManualGapRange(startMs, endMs, removed) {
    const state = MaweGapRemoveData.getGapRemoveData(true);
    const sourceGaps = window.AsrGapRemoveCore.normalizeGapRemoveGaps(state.gaps);
    const nextGaps = window.AsrEditorUtils.applyGapRemoveRange(sourceGaps, startMs, endMs, removed);
    if (JSON.stringify(nextGaps) === JSON.stringify(sourceGaps)) {
      MaweHint.flashHint(removed ? '所选范围已经处于移除状态' : '所选范围内没有已移除的静音空隙', 'invalid');
      return;
    }
    MaweHistory.pushGapRemoveUndo(removed ? '人工移除范围' : '人工恢复范围');
    state.detector = 'audio_gate';
    commitManualGapRemoveChange(
      state,
      [{ start: Math.min(Number(startMs), Number(endMs)), end: Math.max(Number(startMs), Number(endMs)), removed }],
    );
    MaweHint.flashHint(removed ? '已人工移除所选范围' : '已人工恢复所选范围', 'success');
  }



  function addGapAtWaveformTime(timeMs) {
    const duration = gapRemoveMediaDurationMs();
    if (!duration) {
      MaweHint.flashHint('媒体时长尚不可用；请先加载媒体后再添加空隙', 'invalid');
      return false;
    }
    const point = Number(timeMs);
    if (!Number.isFinite(point)) return false;
    const state = MaweGapRemoveData.getGapRemoveData(true);
    const sourceGaps = window.AsrGapRemoveCore.normalizeGapRemoveGaps(state.gaps);
    const requestedLength = MaweSettings.clampGapRemoveMinimum(state.minimum_ms);
    const length = Math.min(duration, requestedLength);
    const snappedPoint = Math.max(0, Math.min(duration, Math.round(point / 10) * 10));
    const start = Math.min(snappedPoint, Math.max(0, duration - length));
    const end = Math.min(duration, start + length);
    if (end - start < 10) {
      MaweHint.flashHint('媒体时长不足，无法添加空隙', 'warning');
      return false;
    }
    const nextGaps = window.AsrEditorUtils.applyGapRemoveRange(sourceGaps, start, end, true);
    if (JSON.stringify(nextGaps) === JSON.stringify(sourceGaps)) {
      MaweHint.flashHint('该位置已经是已移除的空隙', 'invalid');
      return false;
    }
    MaweHistory.pushGapRemoveUndo('右键添加空隙');
    state.detector = 'audio_gate';
    commitManualGapRemoveChange(
      state,
      [{ start, end, removed: true }],
    );
    MaweCoreState.waveformEditor?.revealTime(start, true);
    MaweHint.flashHint(`已添加 ${formatGapRemoveTotal(end - start)} 静音空隙`, 'success');
    return true;
  }



  function translateManualGap(index, deltaMs, mode = 'move') {
    const state = MaweGapRemoveData.getGapRemoveData(false);
    if (!state) return false;
    const core = window.AsrGapRemoveCore;
    const gaps = MaweGapRemoveData.getGapRemoveGaps();
    const original = gaps[index];
    if (!original) return false;
    const duration = gapRemoveMediaDurationMs();
    if (mode === 'move') {
      const result = core.moveGapRemoveProvenance(
        state.provenance,
        gaps,
        index,
        deltaMs,
        duration,
        state.gaps,
      );
      if (!result?.changed) return false;
      MaweHistory.pushGapRemoveUndo('整体偏移空隙');
      state.gaps = result.gaps;
      state.provenance = result.provenance;
      state.manual_corrections = result.provenance.manual_overrides.length > 0;
      setGapRemoveData(state, { provenance: result.provenance });
      MaweHint.flashHint('已整体偏移空隙', 'success');
      return true;
    }
    if (mode !== 'copy') return false;
    const nextGaps = mode === 'copy'
      ? window.AsrEditorUtils.copyGapRemoveRange(gaps, index, deltaMs, duration)
      : window.AsrEditorUtils.moveGapRemoveRange(gaps, index, deltaMs, duration);
    if (JSON.stringify(nextGaps) === JSON.stringify(gaps)) return false;
    const length = original.end - original.start;
    const maxStart = Number.isFinite(duration) && duration > 0
      ? Math.max(0, duration - length) : Infinity;
    const targetStart = Math.min(maxStart, Math.max(0, original.start + Math.round(Number(deltaMs) || 0)));
    const targetEnd = targetStart + length;
    MaweHistory.pushGapRemoveUndo(mode === 'copy' ? '复制并偏移空隙' : '整体偏移空隙');
    const overrides = [];
    overrides.push({ start: targetStart, end: targetEnd, removed: original.removed !== false });
    commitManualGapRemoveChange(state, overrides);
    MaweHint.flashHint(mode === 'copy' ? '已复制并偏移空隙' : '已整体偏移空隙', 'success');
    return true;
  }



  function resizeManualGapBoundary(index, edge, valueMs) {
    const state = MaweGapRemoveData.getGapRemoveData(false);
    if (!state) return;
    const core = window.AsrGapRemoveCore;
    const gaps = MaweGapRemoveData.getGapRemoveGaps();
    const result = core.resizeGapRemoveProvenanceBoundary(
      state.provenance,
      gaps,
      index,
      edge,
      valueMs,
      state.gaps,
    );
    if (!result?.changed) return;
    MaweHistory.pushGapRemoveUndo('人工调整空隙边界');
    state.gaps = result.gaps;
    state.provenance = result.provenance;
    state.manual_corrections = result.provenance.manual_overrides.length > 0;
    setGapRemoveData(state, { provenance: result.provenance });
    MaweHint.flashHint('已人工调整空隙边界', 'success');
  }



  function clearAllGaps() {
    const state = MaweGapRemoveData.getGapRemoveData(false);
    if (!state?.gaps?.length) return;
    if (!confirm(
      `确定要清理全部 ${state.gaps.length} 个空隙区段吗？\n\n这会删除当前所有已移除和已恢复的区段记录。`
    )) return;
    MaweHistory.pushGapRemoveUndo('清理全部空隙区段');
    state.gaps = [];
    setGapRemoveData(state, { clearProvenance: true });
    MaweHint.flashHint('已清理全部空隙区段', 'success');
  }



  function gapRemovePanelIsOpen() {
    return MaweDom.gapRemovePanel?.classList.contains('show') === true;
  }



  function gapRemoveAdvancedIsOpen() {
    return MaweDom.gapRemoveAdvancedBody ? !MaweDom.gapRemoveAdvancedBody.hidden : false;
  }



  function setGapRemoveAdvancedOpen(open, { persist = true } = {}) {
    if (!MaweDom.gapRemoveAdvancedBody || !MaweDom.gapRemoveAdvancedToggle) return;
    MaweDom.gapRemoveAdvancedBody.hidden = !open;
    MaweDom.gapRemoveAdvancedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (persist) {
      try {
        localStorage.setItem(MaweGapRemoveData.GAP_REMOVE_ADVANCED_OPEN_KEY, open ? '1' : '0');
      } catch (_) {
        // file:// 隐私模式下 localStorage 可能被拒；折叠状态仅本次会话生效。
      }
    }
  }



  function restoreGapRemoveAdvancedOpen() {
    let saved = null;
    try {
      saved = localStorage.getItem(MaweGapRemoveData.GAP_REMOVE_ADVANCED_OPEN_KEY);
    } catch (_) {
      saved = null;
    }
    setGapRemoveAdvancedOpen(saved === '1', { persist: false });
  }



  function gapRemoveDisableIsOpen() {
    return MaweDom.gapRemoveDisableBody ? !MaweDom.gapRemoveDisableBody.hidden : false;
  }



  function setGapRemoveDisableOpen(open, { persist = true } = {}) {
    if (!MaweDom.gapRemoveDisableBody || !MaweDom.gapRemoveDisableToggle) return;
    MaweDom.gapRemoveDisableBody.hidden = !open;
    MaweDom.gapRemoveDisableToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (persist) {
      try {
        localStorage.setItem(MaweGapRemoveData.GAP_REMOVE_DISABLE_OPEN_KEY, open ? '1' : '0');
      } catch (_) {
        // file:// 隐私模式下 localStorage 可能被拒；折叠状态仅本次会话生效。
      }
    }
  }



  function restoreGapRemoveDisableOpen() {
    let saved = null;
    try {
      saved = localStorage.getItem(MaweGapRemoveData.GAP_REMOVE_DISABLE_OPEN_KEY);
    } catch (_) {
      saved = null;
    }
    setGapRemoveDisableOpen(saved === '1', { persist: false });
  }



  function updateGapRemoveHysteresisHint() {
    if (!MaweDom.gapRemoveHysteresisHint || !MaweDom.gapRemoveHysteresis) return;
    const value = MaweDom.gapRemoveHysteresis.value;
    MaweDom.gapRemoveHysteresisHint.textContent = `当音频判定为有声时，需要降低到比阈值更低 ${value} dB 的时候才视作恢复静音。建议 1–3 dB，过高会延迟回到静音`;
  }



  function setGapRemovePanelPosition(left, top, { persist = false } = {}) {
    if (!MaweDom.gapRemovePanel) return;
    const rect = MaweDom.gapRemovePanel.getBoundingClientRect();
    const margin = 6;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const nextLeft = Math.min(maxLeft, Math.max(margin, Math.round(left)));
    const nextTop = Math.min(maxTop, Math.max(margin, Math.round(top)));
    MaweDom.gapRemovePanel.style.left = `${nextLeft}px`;
    MaweDom.gapRemovePanel.style.top = `${nextTop}px`;
    MaweDom.gapRemovePanel.style.right = 'auto';
    if (persist) {
      try {
        localStorage.setItem(MaweDom.GAP_REMOVE_PANEL_POSITION_KEY, JSON.stringify({ left: nextLeft, top: nextTop }));
      } catch (_) {
        // file:// 隐私模式可能拒绝 localStorage；拖动本身仍保持可用。
      }
    }
  }



  function restoreGapRemovePanelPosition() {
    if (!MaweDom.gapRemovePanel) return;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(MaweDom.GAP_REMOVE_PANEL_POSITION_KEY) || 'null');
    } catch (_) {
      saved = null;
    }
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
      setGapRemovePanelPosition(saved.left, saved.top);
      return;
    }
    const rect = MaweDom.gapRemovePanel.getBoundingClientRect();
    setGapRemovePanelPosition(rect.left, rect.top);
  }



  function closeGapRemovePanel() {
    if (!MaweDom.gapRemovePanel) return;
    MaweDom.gapRemovePanel.classList.remove('show', 'dragging');
    MaweDom.gapRemovePanel.setAttribute('aria-hidden', 'true');
    MaweCuePanelState.gapRemovePanelDrag = null;
    MaweDom.gapRemoveManageButton?.classList.remove('active');
    MaweDom.gapRemoveManageButton?.setAttribute('aria-expanded', 'false');
    MaweFloatingPanel.syncFloatingSurfaceLayers();
  }



  function openGapRemovePanel() {
    if (!MaweDom.gapRemovePanel) return;
    const state = MaweGapRemoveData.getGapRemoveData(false);
    MaweDom.gapRemoveThreshold.value = String(state?.minimum_ms || MaweGapRemoveData.DEFAULT_GAP_REMOVE_MIN_MS);
    MaweDom.gapRemoveVolumeThreshold.value = String(state?.threshold_db ?? MaweGapRemoveData.DEFAULT_GAP_REMOVE_THRESHOLD_DB);
    MaweDom.gapRemoveHysteresis.value = String(state?.hysteresis_db ?? MaweGapRemoveData.DEFAULT_GAP_REMOVE_HYSTERESIS_DB);
    updateGapRemoveHysteresisHint();
    MaweDom.gapRemoveLeadIn.value = String(state?.lead_in_ms ?? MaweGapRemoveData.DEFAULT_GAP_REMOVE_LEAD_IN_MS);
    MaweDom.gapRemoveLeadOut.value = String(state?.lead_out_ms ?? MaweGapRemoveData.DEFAULT_GAP_REMOVE_LEAD_OUT_MS);
    MaweDom.gapRemoveDisableCoverage.value = String(
      state?.disable_coverage_percent ?? MaweGapRemoveData.DEFAULT_GAP_REMOVE_DISABLE_COVERAGE_PERCENT,
    );
    MaweDom.gapRemoveDisableRemaining.value = String(
      state?.disable_remaining_ms ?? MaweGapRemoveData.DEFAULT_GAP_REMOVE_DISABLE_REMAINING_MS,
    );
    MaweDom.gapRemoveOperationMode.value = state?.operation_mode || MaweGapRemoveData.DEFAULT_GAP_REMOVE_OPERATION_MODE;
    restoreGapRemoveAdvancedOpen();
    restoreGapRemoveDisableOpen();
    updateGapRemoveDisableHint();
    renderGapRemoveList();
    MaweDom.gapRemovePanel.classList.add('show');
    MaweDom.gapRemovePanel.setAttribute('aria-hidden', 'false');
    MaweFloatingPanel.bringFloatingSurfaceToFront(MaweDom.gapRemovePanel);
    MaweDom.gapRemoveManageButton?.classList.add('active');
    MaweDom.gapRemoveManageButton?.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(restoreGapRemovePanelPosition);
  }



  function toggleGapRemovePanel() {
    if (gapRemovePanelIsOpen()) closeGapRemovePanel();
    else openGapRemovePanel();
  }



  function finishGapRemovePanelDrag(event) {
    if (!MaweCuePanelState.gapRemovePanelDrag || event.pointerId !== MaweCuePanelState.gapRemovePanelDrag.pointerId) return;
    try {
      MaweDom.gapRemoveDragHandle?.releasePointerCapture?.(event.pointerId);
    } catch (_) {
      // 指针在浏览器窗口外释放时，capture 可能已由浏览器自动清理。
    }
    MaweCuePanelState.gapRemovePanelDrag = null;
    MaweDom.gapRemovePanel?.classList.remove('dragging');
    const rect = MaweDom.gapRemovePanel?.getBoundingClientRect();
    if (rect) setGapRemovePanelPosition(rect.left, rect.top, { persist: true });
  }



  function fillGapRangeAtWaveformTime(timeMs) {
    const gaps = MaweGapRemoveData.getGapRemoveGaps();
    if (!gaps.some((gap) => gap.removed !== false)) {
      MaweHint.flashHint('当前没有已激活的空隙，无法填充区间空隙', 'invalid');
      return false;
    }
    const range = window.AsrEditorUtils.resolveGapFillRange(gaps, timeMs, MaweGapRemoveUi.gapRemoveMediaDurationMs());
    if (!range) {
      MaweHint.flashHint('媒体时长尚不可用；请先加载媒体后再填充区间空隙', 'invalid');
      return false;
    }
    const state = MaweGapRemoveData.getGapRemoveData(true);
    const sourceGaps = window.AsrGapRemoveCore.normalizeGapRemoveGaps(state.gaps);
    const nextGaps = window.AsrEditorUtils.applyGapRemoveRange(sourceGaps, range.start, range.end, true);
    if (JSON.stringify(nextGaps) === JSON.stringify(sourceGaps)) {
      MaweHint.flashHint('该位置已经是已移除的空隙', 'invalid');
      return false;
    }
    MaweHistory.pushGapRemoveUndo('填充区间空隙');
    state.detector = 'audio_gate';
    MaweGapRemoveUi.commitManualGapRemoveChange(
      state,
      [{ start: range.start, end: range.end, removed: true }],
    );
    MaweHint.flashHint(`已填充并合并为 ${MaweGapRemoveUi.formatGapRemoveTotal(range.end - range.start)} 静音空隙`, 'success');
    return true;
  }

  global.MaweGapRemoveUi = Object.freeze({
    fillGapRangeAtWaveformTime,
    setGapRemoveData,
    commitManualGapRemoveChange,
    gapRemoveTotalMs,
    gapRemoveMediaDurationMs,
    formatGapRemoveTotal,
    getRemovedGapRangesFrom,
    getGapRemoveOperationMode,
    renderGapRemoveList,
    updateGapRemoveDisableHint,
    updateGapRemoveUi,
    scanAndRemoveGaps,
    readGapRemoveLeadPadding,
    shrinkExistingGaps,
    readGapRemoveDisableSettings,
    commitGapRemoveDisableSettings,
    disableSubtitlesInRemovedGaps,
    toggleGapRemoved,
    clearGap,
    applyManualGapRange,
    addGapAtWaveformTime,
    translateManualGap,
    resizeManualGapBoundary,
    clearAllGaps,
    gapRemovePanelIsOpen,
    gapRemoveAdvancedIsOpen,
    setGapRemoveAdvancedOpen,
    restoreGapRemoveAdvancedOpen,
    gapRemoveDisableIsOpen,
    setGapRemoveDisableOpen,
    restoreGapRemoveDisableOpen,
    updateGapRemoveHysteresisHint,
    setGapRemovePanelPosition,
    restoreGapRemovePanelPosition,
    closeGapRemovePanel,
    openGapRemovePanel,
    toggleGapRemovePanel,
    finishGapRemovePanelDrag
  });
})(typeof window !== 'undefined' ? window : globalThis);

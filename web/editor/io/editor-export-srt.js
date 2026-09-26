// SRT 导出：主/副/去空隙 SRT、配色分拆与动态字幕数据。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweExportSrt 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
  /** @param {Window & typeof globalThis} global */
(function initMaweExportSrt(global) {
  'use strict';

  // === 下载 ===
  // 程序内开关（不暴露 GUI）：导出 SRT 时保留禁用项的时间轴序号但内容替换为空白
  let EXPORT_KEEP_DISABLED_PLACEHOLDER = false;

  function buildSrt() {
  const { segments, overlaySet, overlaySegments } = mergedExportSegments();
  const firstEnabledIndex = window.AsrEditorUtils.getSrtExportFirstIndex(
    segments,
    MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
  );
  return window.AsrEditorUtils.buildSrtPayload(segments, {
    alignFirstStart: MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
    firstEnabledIndex,
    keepDisabledPlaceholder: EXPORT_KEEP_DISABLED_PLACEHOLDER,
    colorContextResolver: exportColorContextResolver(overlaySet, overlaySegments),
    ...MaweSpeakerLabels.speakerLabelExportOptions(),
    formatTime: MaweCueElements.fmtSrtTime,
  });
}









  async function downloadColorSrts(gapRemoved = false) {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const colors = usedSubtitleColors();
  const removed = gapRemoved ? MaweGapRemoveData.getRemovedGapRanges() : [];
  if (!colors.length) {
    MaweHint.flashHint('没有可导出的彩色字幕', 'invalid');
    return;
  }
  if (gapRemoved && !removed.length) {
    MaweHint.flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
    return;
  }
  const { segments, overlaySet, overlaySegments } = mergedExportSegments();
  const firstEnabledIndex = window.AsrEditorUtils.getSrtExportFirstIndex(
    segments,
    MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
  );
  const gapSuffix = gapRemoved ? `_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}` : '';
  const speakerSettings = MaweSpeakerLabels.getSpeakerLabelSettings();
  const buildPayload = (color) => window.AsrEditorUtils.buildSrtPayload(segments, {
    colorName: color.name,
    timeOffset: 0,
    alignFirstStart: MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
    firstEnabledIndex,
    colorContextResolver: exportColorContextResolver(overlaySet, overlaySegments),
    mapTime: gapRemoved
      ? (timeMs) => window.AsrEditorUtils.mapGapRemovedTime(timeMs, removed)
      : undefined,
    ensurePositiveDuration: gapRemoved,
    ...MaweSpeakerLabels.speakerLabelExportOptions(),
    formatTime: MaweCueElements.fmtSrtTime,
  });
  let filenameBase = `${MaweBoot.FILENAME_BASE}${gapSuffix}`;
  // 浏览器不允许从一个文件句柄取得其父目录，因此不再请求文件夹权限。
  // 先让用户选择一个 SRT 文件名，并把该名称（不含 .srt）作为所有颜色文件的前缀。
  if (MaweSettings.EDITOR_SETTINGS.exportColorUnified && MaweHost.files.hasSavePicker()) {
    try {
      const handle = await MaweHost.files.pickSaveFile({
        id: 'maw-color-srt-export-prefix',
        suggestedName: `${filenameBase}.srt`,
        types: [{ description: 'SRT 字幕文件（作为导出前缀）', accept: { 'text/plain': ['.srt'] } }],
      });
      filenameBase = handle.name.replace(/\.srt$/i, '') || filenameBase;
    } catch (e) {
      // 用户取消文件名选择 — 静默退出，不回退
      if (e && e.name === 'AbortError') return;
      // 其他错误（如安全限制）：回退到默认文件名前缀。
    }
  }
  for (const color of colors) {
    const filename = `${filenameBase}_${colorExportFilenameSuffix(color, speakerSettings)}.srt`;
    if (MaweSettings.EDITOR_SETTINGS.exportColorUnified) {
      const blob = new Blob([buildPayload(color)], { type: 'text/plain;charset=utf-8' });
      MaweHost.files.downloadBlob(blob, filename);
    } else {
      const saved = await MaweExportTimeline.downloadFile(
        buildPayload(color), filename, 'text/plain',
        { desc: `${color.label}色字幕 SRT`, types: { 'text/plain': ['.srt'] } },
      );
      if (!saved) return;
    }
  }
  MaweHint.flashHint(`已按颜色导出 ${colors.length} 份字幕`, 'success');
}

  function gapRemovedExportContext() {
    const removed = MaweGapRemoveData.getRemovedGapRanges();
    if (!removed.length) {
      MaweHint.flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
      return null;
    }
    const durationMs = MaweCoreState.waveformEditor?.durationMs || Math.round(Number(MaweCoreState.player?.duration) * 1000) || 0;
    if (!durationMs) {
      MaweHint.flashHint('媒体时长尚不可用；请先加载媒体后再导出', 'invalid');
      return null;
    }
    const intervals = window.AsrEditorUtils.buildGapRemovedIntervals(durationMs, removed);
    if (!intervals.length) {
      MaweHint.flashHint('移除静音空隙后没有剩余媒体，无法导出', 'warning');
      return null;
    }
    return { durationMs, intervals, removed };
  }

  function buildDynamicCaptionExportData(segments, gapRemoved) {
    const source = Array.isArray(segments) ? segments : [];
    const sourceDurationMs = MaweCoreState.waveformEditor?.durationMs
      || Math.round(Number(MaweCoreState.player?.duration) * 1000)
      || MaweBoot.DATA.waveform?.duration_ms
      || 0;
    if (!gapRemoved) {
      return { segments: source, durationMs: sourceDurationMs };
    }
    const context = gapRemovedExportContext();
    if (!context) return null;
    const durationMs = context.intervals.reduce(
      (total, interval) => total + Math.max(0, interval.end - interval.start),
      0,
    );
    return {
      segments: window.AsrEditorUtils.buildGapRemovedDynamicSegments(source, context.removed),
      durationMs,
    };
  }

  function gapRemovedMediaReference() {
    return String(MaweBoot.DATA.media || '').trim();
  }

  function buildGapRemovedFfconcat() {
    const context = gapRemovedExportContext();
    if (!context) return null;
    const media = gapRemovedMediaReference();
    if (!media) {
      MaweHint.flashHint('无法获得媒体文件名；请先加载媒体后再导出 FFconcat', 'invalid');
      return null;
    }
    return window.AsrEditorUtils.buildFfconcat(media, context.intervals);
  }

  function buildGapRemovedRegionsJson() {
    const context = gapRemovedExportContext();
    if (!context) return null;
    const keptRegions = context.intervals.map((interval, index) => ({
      index,
      start_ms: interval.start,
      end_ms: interval.end,
      duration_ms: interval.end - interval.start,
    }));
    const keptDurationMs = keptRegions.reduce((sum, region) => sum + region.duration_ms, 0);
    return JSON.stringify({
      schema: 'moy.asr.gap_removed_keep_regions.v1',
      source: 'moys-asr-workflow',
      media: gapRemovedMediaReference(),
      time_unit: 'milliseconds',
      source_duration_ms: context.durationMs,
      kept_duration_ms: keptDurationMs,
      removed_duration_ms: context.durationMs - keptDurationMs,
      kept_regions: keptRegions,
    }, null, 2);
  }



  function currentAssVideoResolution() {
    const metadata = window.AsrEditorUtils.normalizeMediaMetadata(MaweBoot.DATA.media_metadata);
    if (metadata?.video_width && metadata?.video_height) {
      return { width: metadata.video_width, height: metadata.video_height };
    }
    const width = Number(MaweCoreState.player?.videoWidth);
    const height = Number(MaweCoreState.player?.videoHeight);
    if (MaweCoreState.player?.tagName === 'VIDEO'
      && Number.isInteger(width) && width > 0
      && Number.isInteger(height) && height > 0) {
      return { width, height };
    }
    return null;
  }



  function assExportOptions(appearance = MaweAppearance.getSubtitleAppearance()) {
  const resolution = currentAssVideoResolution();
  const library = window.AsrEditorUtils.normalizeAssStyleLibrary(ASS_STYLE_LIBRARY);
  const profileId = library.assignments?.assExportProfileId || 'ass';
  const assProfile = window.AsrEditorUtils.assProfileForId(library, profileId);
  const assStyle = window.AsrEditorUtils.assStyleForId(library, assProfile.styleId);
  const assExtensionStyle = window.AsrEditorUtils.assStyleForId(
    library, library.assignments?.assExtensionStyleId || 'ass-extension',
  );
  return {
    title: MaweBoot.PROJECT_NAME || MaweBoot.FILENAME_BASE || 'MAW',
    mediaMetadata: MaweTimeline.normalizeMediaMetadata(MaweBoot.DATA.media_metadata),
    playResX: resolution?.width,
    playResY: resolution?.height,
    colorStyles: MaweColors.COLOR_PALETTE,
    appearance,
    assProfile,
    assStyle,
    assExtensionStyle,
  };
}



  function buildAss() {
  const { overlaySegments } = mergedExportSegments();
  // 副字幕轨随 ASS 导出（多重字幕开启时才存在）；叠加轨与副字幕分层输出。
  const extensionSegments = activeExtensionSegments();
  const firstEnabledIndex = window.AsrEditorUtils.getSrtExportFirstIndex(
    MaweBoot.DATA.segments,
    MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
  );
  return window.AsrEditorUtils.buildAssPayload(MaweBoot.DATA.segments, {
    ...assExportOptions(),
    alignFirstStart: MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
    firstEnabledIndex,
    appearance: MaweAppearance.getSubtitleAppearance(),
    overlaySegments,
    extensionSegments,
    ...MaweSpeakerLabels.speakerLabelExportOptions(),
  });
}



  function buildExtensionSrt(track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    return window.AsrEditorUtils.buildSrtPayload(track?.segments || [], {
      ...MaweSpeakerLabels.speakerLabelExportOptions(),
      formatTime: MaweCueElements.fmtSrtTime,
    });
  }



  function buildGapRemovedSrt() {
  const removed = MaweGapRemoveData.getRemovedGapRanges();
  if (!removed.length) {
    MaweHint.flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
    return null;
  }
  const { segments, overlaySet, overlaySegments } = mergedExportSegments();
  const firstEnabledIndex = window.AsrEditorUtils.getSrtExportFirstIndex(
    segments,
    MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
  );
  return window.AsrEditorUtils.buildSrtPayload(segments, {
    alignFirstStart: MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
    firstEnabledIndex,
    mapTime: (timeMs) => window.AsrEditorUtils.mapGapRemovedTime(timeMs, removed),
    ensurePositiveDuration: true,
    colorContextResolver: exportColorContextResolver(overlaySet, overlaySegments),
    ...MaweSpeakerLabels.speakerLabelExportOptions(),
    formatTime: MaweCueElements.fmtSrtTime,
  });
}



  function buildGapRemovedAss() {
  const removed = MaweGapRemoveData.getRemovedGapRanges();
  if (!removed.length) {
    MaweHint.flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
    return null;
  }
  const firstEnabledIndex = window.AsrEditorUtils.getSrtExportFirstIndex(
    MaweBoot.DATA.segments,
    MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
  );
  // 去空隙 ASS 与常规 ASS 同一三轨契约：叠加轨与副字幕也随导出，
  // 时间统一经 mapGapRemovedTime 压缩。
  const { overlaySegments } = mergedExportSegments();
  const extensionSegments = activeExtensionSegments();
  return window.AsrEditorUtils.buildAssPayload(MaweBoot.DATA.segments, {
    ...assExportOptions(),
    alignFirstStart: MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
    firstEnabledIndex,
    overlaySegments,
    extensionSegments,
    mapTime: (timeMs) => window.AsrEditorUtils.mapGapRemovedTime(timeMs, removed),
    ...MaweSpeakerLabels.speakerLabelExportOptions(),
  });
}



  function usedSubtitleColors() {
  const { segments, overlaySet, overlaySegments } = mergedExportSegments();
  const resolveColor = exportColorContextResolver(overlaySet, overlaySegments);
  const names = new Set(segments.filter((segment) => !segment.disabled).map((segment) => (
    window.AsrEditorUtils.effectiveColorName(segment, resolveColor(segment)) || 'default'
  )).filter((name) => name === 'default' || MaweColors.COLOR_BY_NAME[name]));
  return [
    ...MaweColors.COLOR_PALETTE.filter((color) => names.has(color.name)),
    ...(names.has('default') ? [{ name: 'default', label: '默认' }] : []),
  ];
}



  function updateSubtitleExportUi() {
    const hasColors = usedSubtitleColors().some((color) => color.name !== 'default');
    if (MaweDom.downloadColorSrtItem) MaweDom.downloadColorSrtItem.hidden = !hasColors;
    if (MaweDom.subtitleExportSeparator) MaweDom.subtitleExportSeparator.hidden = !hasColors;
    if (MaweDom.downloadGapRemovedColorSrtItem) MaweDom.downloadGapRemovedColorSrtItem.hidden = !hasColors;
    if (MaweDom.gapRemovedSubtitleExportSeparator) MaweDom.gapRemovedSubtitleExportSeparator.hidden = !hasColors;
    if (MaweDom.subtitleExportDropdown) MaweDom.subtitleExportDropdown.hidden = false;
    if (MaweDom.downloadMultiSrtButton) {
      MaweDom.downloadMultiSrtButton.hidden = !(MaweMultiSubtitleCore.multiSubtitleVisible() && MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments?.length);
    }
  }



  function safeColorExportFilenameSuffix(value, fallback) {
    const normalized = String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '_')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim();
    return normalized || fallback;
  }



  function colorExportFilenameSuffix(color, speakerSettings = MaweSpeakerLabels.getSpeakerLabelSettings()) {
    const colorSuffix = window.MAWE_I18N?.exportTag?.(color.name) || color.name;
    if (!MaweSettings.EDITOR_SETTINGS.exportSpeakerNamesAsSuffix
        || speakerSettings.mapping_enabled !== true
        || color.name === 'default') {
      return colorSuffix;
    }
    return safeColorExportFilenameSuffix(speakerSettings.names?.[color.name], colorSuffix);
  }

  global.MaweExportSrt = Object.freeze({
    currentAssVideoResolution,
    assExportOptions,
    buildAss,
    buildExtensionSrt,
    buildGapRemovedSrt,
    buildGapRemovedAss,
    usedSubtitleColors,
    updateSubtitleExportUi,
    safeColorExportFilenameSuffix,
    colorExportFilenameSuffix,
    get EXPORT_KEEP_DISABLED_PLACEHOLDER() { return EXPORT_KEEP_DISABLED_PLACEHOLDER; },
    set EXPORT_KEEP_DISABLED_PLACEHOLDER(v) { EXPORT_KEEP_DISABLED_PLACEHOLDER = v; },
    buildSrt,
    downloadColorSrts,
    gapRemovedExportContext,
    buildDynamicCaptionExportData,
    gapRemovedMediaReference,
    buildGapRemovedFfconcat,
    buildGapRemovedRegionsJson
  });
})(typeof window !== 'undefined' ? window : globalThis);

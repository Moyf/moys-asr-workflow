// settings: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-settings', function createUtilsModule(dependencies) {
  'use strict';
  const { DEFAULT_SPLIT_TRIM_SYMBOLS, DEFAULT_TIMELINE_TIMECODE_SEPARATOR, clampInteger, clampTimelineFrameStep, normalizeSplitTrimSymbols, normalizeTimelineTimecodeSeparator } = dependencies;


  const EDITOR_SETTING_ROW_HEIGHTS = [64, 80, 96, 120, 144, 168, 192];


  const EDITOR_ACCENT_COLOR_VALUES = Object.freeze(['blue', 'red', 'orange', 'custom']);

  const DEFAULT_EDITOR_ACCENT_CUSTOM_COLOR = '#6ca5e8';


  const EDITOR_SUBTITLE_COLOR_NAMES = Object.freeze([
    'yellow', 'green', 'red', 'purple', 'blue',
  ]);

  const DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE = Object.freeze({
    yellow: '#c4a019',
    green: '#66bb6a',
    red: '#f07f6f',
    purple: '#bf89e6',
    blue: '#61a7fa',
  });


  function normalizeSubtitleColorPalette(value, fallback = DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE) {
    const source = Array.isArray(value)
      ? Object.fromEntries(value
        .filter((entry) => entry && typeof entry.name === 'string')
        .map((entry) => [entry.name, entry.value]))
      : value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const defaults = fallback && typeof fallback === 'object' && !Array.isArray(fallback)
      ? fallback : DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE;
    return Object.fromEntries(EDITOR_SUBTITLE_COLOR_NAMES.map((name) => {
      const candidate = String(source[name] ?? '').trim().toLowerCase();
      const defaultValue = String(defaults[name] || DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE[name]);
      const normalizedDefault = /^#[0-9a-f]{6}$/iu.test(defaultValue)
        ? defaultValue.toLowerCase() : DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE[name];
      return [name, /^#[0-9a-f]{6}$/iu.test(candidate) ? candidate : normalizedDefault];
    }));
  }


  function normalizeEditorAccentColor(value) {
    return EDITOR_ACCENT_COLOR_VALUES.includes(value) ? value : 'blue';
  }


  function normalizeEditorAccentCustomColor(value) {
    const color = String(value ?? '').trim();
    return /^#[0-9a-f]{6}$/i.test(color)
      ? color.toLowerCase() : DEFAULT_EDITOR_ACCENT_CUSTOM_COLOR;
  }


  const DEFAULT_EDITOR_SETTINGS = Object.freeze({
    splitKey: 'enter', splitUseWordTimestamps: true, splitAutoSubmit: true,
    mainSplitModeOverride: null,
    splitTrimSymbols: [...DEFAULT_SPLIT_TRIM_SYMBOLS],
    overlayEnabled: true, extensionOverlayEnabled: true, assMode: false, multiSubtitleRowHeight: 168,
    subtitleColorPaletteEnabled: false,
    exportStartAtZero: false, cueListShowIndex: true, cueListShowTime: true,
    cueListShowSticker: true, cueListShowCharcount: true, cueListAutoScrollOnClick: true,
    cueListKeepSplitVisible: true, cueListHideDisabled: false, cueListCharcountThreshold: 16,
    cueEditorShowNavigation: false, cueEditorShowTimeActions: false, cueEditorShowSticker: false,
    cueEditorCancelOnEscape: false, selectGroupMembers: false,
    mergeJoinTextContinuous: '', mergeJoinTextWord: ' ',
    autoMergeGapMs: 200, autoMergeSnapDirection: 'backward', autoMergeShortCount: 3,
    autoMergeAbsorbShort: true, autoMergeAbsorbDirection: 'previous', exportColorUnified: true,
    exportSpeakerLabels: false, exportSpeakerNamesAsSuffix: false,
    autoSaveProject: true, autoSaveIntervalSeconds: 30, projectBackupEnabled: true,
    stickerOverlayEnabled: false,
    stickerOtioExportMode: 'original', clickBehavior: 'select-and-seek', clickTarget: 'pointer',
    pauseOnMouseClick: false,
    otioExportIncludeSrt: true, otioExportIncludeStickers: true, otioExportIncludeMarkers: true,
    keyboardOperationReference: 'pointer', jklPlaybackMode: 'direction', mediaSeekStepMs: 1000,
    mediaSeekStepFrames: 1, cueMoveStepMs: 50, cueMoveStepFrames: 1,
    timelineSnapToFrame: true, timelineTimecodeSeparator: DEFAULT_TIMELINE_TIMECODE_SEPARATOR,
    hoverSeekPreview: false, autoSnapAdjacentCues: true, adjacentBoundaryMode: 'dual', ninjaMode: false,
    ninjaSound: true, ninjaSlashEffect: true, ninjaSlashLengthPercent: 80,
    ninjaSlashRotateAmplitude: 6, crossTrackSnap: true, selectBoundSubtitlePair: true,
    multiSubtitleAutoSyncDuration: true, multiSubtitleShowTrackBadges: false, theme: 'dark',
    accentColor: 'blue', accentColorCustom: DEFAULT_EDITOR_ACCENT_CUSTOM_COLOR,
    subtitleColorPalette: { ...DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE },
    waveShapeSource: 'reapeaks',
  });


  function normalizeEditorSettings(saved = {}) {
    const savedSettings = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const legacySeekStepSeconds = Number(savedSettings.mediaSeekStepSeconds);
    const mediaSeekStepMs = savedSettings.mediaSeekStepMs !== undefined
      ? savedSettings.mediaSeekStepMs
      : Number.isFinite(legacySeekStepSeconds) ? legacySeekStepSeconds * 1000 : undefined;
    return {
      ...DEFAULT_EDITOR_SETTINGS,
      splitKey: savedSettings.splitKey === 'ctrl-enter' ? 'ctrl-enter' : 'enter',
      splitUseWordTimestamps: savedSettings.splitUseWordTimestamps !== false,
      splitAutoSubmit: savedSettings.splitAutoSubmit !== false,
      // 主字幕拆分类型手动指定偏好：word / continuous / null（跟随工程与检测）。
      mainSplitModeOverride: ['word', 'continuous'].includes(savedSettings.mainSplitModeOverride)
        ? savedSettings.mainSplitModeOverride : null,
      // undefined → 默认集合；显式空数组表示用户关闭了全部符号（仅修剪空白）。
      splitTrimSymbols: Array.isArray(savedSettings.splitTrimSymbols)
        ? normalizeSplitTrimSymbols(savedSettings.splitTrimSymbols)
        : [...DEFAULT_SPLIT_TRIM_SYMBOLS],
      overlayEnabled: savedSettings.overlayEnabled !== false,
      extensionOverlayEnabled: savedSettings.extensionOverlayEnabled !== false,
      // ASS 字幕模式是预览偏好，默认关闭以保持旧版 CSS 预览行为。
      assMode: savedSettings.assMode === true,
      // 自定义五色开关：关闭时一律使用内置色值（自定义值保留以便再次开启）。
      subtitleColorPaletteEnabled: savedSettings.subtitleColorPaletteEnabled === true,
      multiSubtitleRowHeight: EDITOR_SETTING_ROW_HEIGHTS.includes(Number(savedSettings.multiSubtitleRowHeight))
        ? Number(savedSettings.multiSubtitleRowHeight) : 168,
      exportStartAtZero: savedSettings.exportStartAtZero === true,
      cueListShowIndex: savedSettings.cueListShowIndex !== false,
      cueListShowTime: savedSettings.cueListShowTime !== false,
      cueListShowSticker: savedSettings.cueListShowSticker !== false,
      cueListShowCharcount: savedSettings.cueListShowCharcount !== false,
      cueListAutoScrollOnClick: savedSettings.cueListAutoScrollOnClick !== false,
      cueListKeepSplitVisible: savedSettings.cueListKeepSplitVisible !== false,
      cueListHideDisabled: savedSettings.cueListHideDisabled === true,
      cueListCharcountThreshold: clampInteger(savedSettings.cueListCharcountThreshold, 16, 1, 200),
      cueEditorShowNavigation: savedSettings.cueEditorShowNavigation === true,
      cueEditorShowTimeActions: savedSettings.cueEditorShowTimeActions === true,
      cueEditorShowSticker: savedSettings.cueEditorShowSticker === true,
      cueEditorCancelOnEscape: savedSettings.cueEditorCancelOnEscape === true,
      selectGroupMembers: savedSettings.selectGroupMembers === true,
      // 合并连接符按字幕拆分类型区分：连续型默认直接拼接，单词型默认空格。
      // 旧版只有 mergeJoinText 一个值；用户自定义过则两个类型都沿用旧值。
      mergeJoinTextContinuous: typeof savedSettings.mergeJoinTextContinuous === 'string'
        ? savedSettings.mergeJoinTextContinuous
        : typeof savedSettings.mergeJoinText === 'string' ? savedSettings.mergeJoinText : '',
      mergeJoinTextWord: typeof savedSettings.mergeJoinTextWord === 'string'
        ? savedSettings.mergeJoinTextWord
        : typeof savedSettings.mergeJoinText === 'string' ? savedSettings.mergeJoinText : ' ',
      autoMergeGapMs: clampInteger(savedSettings.autoMergeGapMs, 200, 0, 10000),
      autoMergeSnapDirection: savedSettings.autoMergeSnapDirection === 'forward' ? 'forward' : 'backward',
      autoMergeShortCount: clampInteger(savedSettings.autoMergeShortCount, 3, 1, 20),
      autoMergeAbsorbShort: savedSettings.autoMergeAbsorbShort !== false,
      autoMergeAbsorbDirection: savedSettings.autoMergeAbsorbDirection === 'next' ? 'next' : 'previous',
      exportColorUnified: savedSettings.exportColorUnified !== false,
      exportSpeakerLabels: savedSettings.exportSpeakerLabels === true,
      exportSpeakerNamesAsSuffix: savedSettings.exportSpeakerNamesAsSuffix === true,
      autoSaveProject: savedSettings.autoSaveProject !== false,
      autoSaveIntervalSeconds: clampInteger(savedSettings.autoSaveIntervalSeconds, 30, 5, 3600),
      projectBackupEnabled: savedSettings.projectBackupEnabled !== false,
      projectBackupMinutes: clampInteger(savedSettings.projectBackupMinutes, 5, 1, 1440),
      projectBackupLimit: clampInteger(savedSettings.projectBackupLimit, 20, 1, 1000),
      stickerOverlayEnabled: savedSettings.stickerOverlayEnabled === true,
      stickerOtioExportMode: savedSettings.stickerOtioExportMode === 'portable' ? 'portable' : 'original',
      // 时间线 OTIO 导出选项：默认同时导出 SRT、合并表情包轨、写入字幕标记。
      otioExportIncludeSrt: savedSettings.otioExportIncludeSrt !== false,
      otioExportIncludeStickers: savedSettings.otioExportIncludeStickers !== false,
      otioExportIncludeMarkers: savedSettings.otioExportIncludeMarkers !== false,
      clickBehavior: ['select-only', 'select-and-seek', 'select-and-play'].includes(savedSettings.clickBehavior)
        ? savedSettings.clickBehavior : 'select-and-seek',
      clickTarget: ['cue-start', 'pointer'].includes(savedSettings.clickTarget) ? savedSettings.clickTarget : 'pointer',
      pauseOnMouseClick: savedSettings.pauseOnMouseClick === true,
      keyboardOperationReference: savedSettings.keyboardOperationReference === 'playhead' ? 'playhead' : 'pointer',
      jklPlaybackMode: ['speed', 'direction'].includes(savedSettings.jklPlaybackMode)
        ? savedSettings.jklPlaybackMode : 'direction',
      mediaSeekStepMs: clampInteger(mediaSeekStepMs, 1000, 10, 60000),
      mediaSeekStepFrames: clampTimelineFrameStep(savedSettings.mediaSeekStepFrames, 1),
      cueMoveStepMs: clampInteger(savedSettings.cueMoveStepMs, 50, 10, 2000),
      cueMoveStepFrames: clampTimelineFrameStep(savedSettings.cueMoveStepFrames, 1),
      timelineSnapToFrame: savedSettings.timelineSnapToFrame !== false,
      timelineTimecodeSeparator: normalizeTimelineTimecodeSeparator(savedSettings.timelineTimecodeSeparator),
      hoverSeekPreview: savedSettings.hoverSeekPreview === true,
      autoSnapAdjacentCues: savedSettings.autoSnapAdjacentCues !== false,
      // 相接字幕边界拖动方式：dual（中缝联动，达芬奇式，默认）/ classic（自动吸附开关 + Alt 反转）。
      adjacentBoundaryMode: savedSettings.adjacentBoundaryMode === 'classic' ? 'classic' : 'dual',
      ninjaMode: savedSettings.ninjaMode === true,
      ninjaSound: savedSettings.ninjaSound !== false,
      ninjaSlashEffect: savedSettings.ninjaSlashEffect !== false,
      ninjaSlashLengthPercent: clampInteger(savedSettings.ninjaSlashLengthPercent, 80, 20, 400),
      ninjaSlashRotateAmplitude: clampInteger(savedSettings.ninjaSlashRotateAmplitude, 6, 0, 60),
      crossTrackSnap: savedSettings.crossTrackSnap !== false,
      selectBoundSubtitlePair: savedSettings.selectBoundSubtitlePair !== false,
      multiSubtitleAutoSyncDuration: savedSettings.multiSubtitleAutoSyncDuration !== false,
      multiSubtitleShowTrackBadges: savedSettings.multiSubtitleShowTrackBadges === true,
      theme: ['light', 'dark', 'system'].includes(savedSettings.theme)
        ? savedSettings.theme : 'dark',
      accentColor: normalizeEditorAccentColor(savedSettings.accentColor),
      accentColorCustom: normalizeEditorAccentCustomColor(savedSettings.accentColorCustom),
      subtitleColorPalette: normalizeSubtitleColorPalette(savedSettings.subtitleColorPalette),
      waveShapeSource: savedSettings.waveShapeSource === 'self' ? 'self' : 'reapeaks',
    };
  }


  function normalizeMultiSubtitleRowHeight(value) {
    return EDITOR_SETTING_ROW_HEIGHTS.includes(Number(value)) ? Number(value) : 168;
  }

  function normalizeClickBehavior(value) {
    return ['select-only', 'select-and-seek', 'select-and-play'].includes(value)
      ? value : 'select-and-seek';
  }

  function normalizeClickTarget(value) {
    return ['cue-start', 'pointer'].includes(value) ? value : 'pointer';
  }

  function normalizeJklPlaybackMode(value) {
    return ['speed', 'direction'].includes(value) ? value : 'direction';
  }

  function clampMediaSeekStepMs(value) { return clampInteger(value, 1000, 10, 60000); }

  function clampCueMoveStepMs(value) { return clampInteger(value, 50, 10, 2000); }

  function clampAutoSaveInterval(value) { return clampInteger(value, 30, 5, 3600); }

  function clampCharcountThreshold(value) { return clampInteger(value, 16, 1, 200); }

  function clampNinjaSlashLength(value) { return clampInteger(value, 80, 20, 400); }

  function clampNinjaSlashRotateAmplitude(value) { return clampInteger(value, 6, 0, 60); }

  function clampAutoMergeGapMs(value) { return clampInteger(value, 200, 0, 10000); }

  function clampAutoMergeShortCount(value) { return clampInteger(value, 3, 1, 20); }

  return Object.freeze({ DEFAULT_EDITOR_ACCENT_CUSTOM_COLOR, DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE, EDITOR_ACCENT_COLOR_VALUES, EDITOR_SUBTITLE_COLOR_NAMES, clampAutoMergeGapMs, clampAutoMergeShortCount, clampAutoSaveInterval, clampCharcountThreshold, clampCueMoveStepMs, clampMediaSeekStepMs, clampNinjaSlashLength, clampNinjaSlashRotateAmplitude, normalizeClickBehavior, normalizeClickTarget, normalizeEditorAccentColor, normalizeEditorAccentCustomColor, normalizeEditorSettings, normalizeJklPlaybackMode, normalizeMultiSubtitleRowHeight, normalizeSubtitleColorPalette });
});

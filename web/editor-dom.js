// DOM 元素登记表：全部 getElementById 缓存与浮层/存储键常量（纯引用表，无业务状态）。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweDom 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweDom(global) {
  'use strict';


  const nowEl = document.getElementById('now');


  const searchEl = document.getElementById('search');


  const visibleCountEl = document.getElementById('visible-count');


  const totalCountEl = document.getElementById('total-count');


  const selCountEl = document.getElementById('sel-count');


  const overlayEl = document.getElementById('overlay');


  const overlayTextEl = document.getElementById('overlay-main-text');


  const overlayMainSpeakerLabelEl = document.getElementById('overlay-main-speaker-label');


  const overlayMainTextNode = document.createTextNode('');


  const overlayExtensionTextEl = document.getElementById('overlay-extension-text');


  const overlayToggle = document.getElementById('overlay-toggle');


  const extensionOverlayToggleWrap = document.getElementById('extension-overlay-toggle-wrap');


  const extensionOverlayToggle = document.getElementById('extension-overlay-toggle');


  const stickerOverlayToggle = document.getElementById('sticker-overlay-toggle');


  const subtitleFontSizeSelect = document.getElementById('subtitle-font-size');


  const subtitleFontFamilySelect = document.getElementById('subtitle-font-family');


  const subtitleFontFamilyScanButton = document.getElementById('subtitle-font-family-scan');


  const subtitleFontFamilyStatus = document.getElementById('subtitle-font-family-status');


  const subtitleBackgroundColorInput = document.getElementById('subtitle-background-color');


  const subtitleBackgroundAlphaInput = document.getElementById('subtitle-background-alpha');


  const subtitleBackgroundAlphaValue = document.getElementById('subtitle-background-alpha-value');


  const subtitleColorInput = document.getElementById('subtitle-color');


  const subtitleColorUnderlineInput = document.getElementById('subtitle-color-underline');


  const subtitleColorStyleControl = document.getElementById('subtitle-color-style-control');


  const subtitleColorStyleSelect = document.getElementById('subtitle-color-style');


  const subtitleSpeakerMappingEnabledInput = document.getElementById('subtitle-speaker-mapping-enabled');


  const subtitleSpeakerLabelsToggle = document.getElementById('subtitle-speaker-labels-enabled-wrap');


  const subtitleSpeakerLabelsEnabledInput = document.getElementById('subtitle-speaker-labels-enabled');


  const subtitleSpeakerLabelsSettings = document.getElementById('subtitle-speaker-labels-settings');


  const subtitleSpeakerLabelSeparatorInput = document.getElementById('subtitle-speaker-label-separator');


  const subtitleSpeakerLabelInputs = Object.fromEntries(
    (window.AsrEditorUtils.SPEAKER_LABEL_COLORS || []).map((color) => [
      color,
      document.getElementById(`subtitle-speaker-label-${color}`),
    ]),
  );


  const extensionSubtitlePreviewSettings = document.getElementById('extension-subtitle-preview-settings');


  const extensionSubtitlePreviewTitle = document.getElementById('extension-subtitle-preview-title');


  const extensionSubtitleFontSizeSelect = document.getElementById('extension-subtitle-font-size');


  const extensionSubtitleFontFamilySelect = document.getElementById('extension-subtitle-font-family');


  const extensionSubtitleColorInput = document.getElementById('extension-subtitle-color');


  const extensionSubtitleBackgroundColorInput = document.getElementById('extension-subtitle-background-color');


  const extensionSubtitleBackgroundAlphaInput = document.getElementById('extension-subtitle-background-alpha');


  const extensionSubtitleBackgroundAlphaValue = document.getElementById('extension-subtitle-background-alpha-value');


  const playerEmpty = document.getElementById('player-empty');


  const playerWrap = document.querySelector('.player-wrap');


  const mediaPlayToggle = document.getElementById('media-play-toggle');


  const mediaStepBack = document.getElementById('media-step-back');


  const mediaStepForward = document.getElementById('media-step-forward');


  const mediaSeekStepInput = document.getElementById('media-seek-step');


  const mediaSeekStepUnit = document.getElementById('media-seek-step-unit');


  const mediaSeekStepHint = document.getElementById('media-seek-step-hint');


  let mediaSeekInputLastValue = MaweSettings.EDITOR_SETTINGS.mediaSeekStepMs;


  const mediaCurrentTime = document.getElementById('media-current-time');


  const mediaDuration = document.getElementById('media-duration');


  const mediaSeek = document.getElementById('media-seek');


  const mediaVolume = document.getElementById('media-volume');


  const mediaPlaybackRate = document.getElementById('media-playback-rate');


  const mediaFullscreen = document.getElementById('media-fullscreen');


  // 预览层（字幕/表情包）的定位与几何测量都以 stage 为基准，不含顶部媒体工具栏。
  const playerStage = playerWrap?.querySelector('.player-stage') || playerWrap;


  const splitKeySel = document.getElementById('split-key');


  const splitUseWordTimestampsToggle = document.getElementById('split-use-word-timestamps');


  const mergeJoinTextContinuousInput = document.getElementById('merge-join-text-continuous');


  const mergeJoinTextWordInput = document.getElementById('merge-join-text-word');


  const cueListShowIndexToggle = document.getElementById('cue-list-show-index');


  const cueListShowTimeToggle = document.getElementById('cue-list-show-time');


  const cueListShowStickerToggle = document.getElementById('cue-list-show-sticker');


  const cueListShowCharcountToggle = document.getElementById('cue-list-show-charcount');


  const cueListAutoScrollOnClickToggle = document.getElementById('cue-list-auto-scroll-on-click');


  const cueListKeepSplitVisibleToggle = document.getElementById('cue-list-keep-split-visible');


  const cueListCharcountThresholdInput = document.getElementById('charcount-threshold');


  const cueListSettings = document.getElementById('cue-list-settings');


  const cueListSettingsToggle = document.getElementById('cue-list-settings-toggle');


  const cueListSettingsPanel = document.getElementById('cue-list-settings-panel');


  const hideDisabledToggle = document.getElementById('hide-disabled-toggle');


  let hideDisabled = false;

    // 「隐藏禁用项」开关状态
  const cueEditorShowNavigationToggle = document.getElementById('cue-editor-show-navigation');


  const cueEditorShowTimeActionsToggle = document.getElementById('cue-editor-show-time-actions');


  const cueEditorShowStickerToggle = document.getElementById('cue-editor-show-sticker');


  const cueEditorCancelOnEscapeToggle = document.getElementById('cue-editor-cancel-on-escape');


  const selectGroupMembersToggle = document.getElementById('select-group-members');


  const ninjaModeToggle = document.getElementById('ninja-mode');


  const ninjaSoundToggle = document.getElementById('ninja-sound');


  const ninjaSoundField = document.getElementById('ninja-sound-field');


  const ninjaSlashEffectToggle = document.getElementById('ninja-slash-effect');


  const ninjaSlashEffectField = document.getElementById('ninja-slash-effect-field');


  const ninjaSlashParamsField = document.getElementById('ninja-slash-params-field');


  const ninjaSlashLengthInput = document.getElementById('ninja-slash-length');


  const ninjaSlashRotateInput = document.getElementById('ninja-slash-rotate');


  const razorToolButton = document.querySelector('[data-waveform-tool="razor"]');


  const razorToolSvg = razorToolButton?.querySelector('svg');


  const ninjaRazorIcon = razorToolButton?.querySelector('.ninja-razor-icon');


  const ninjaSlashFlash = document.getElementById('ninja-slash-flash');


  const exportColorUnifiedToggle = document.getElementById('export-color-unified');


  const exportSpeakerLabelsToggle = document.getElementById('export-speaker-labels');


  const exportSpeakerNamesAsSuffixToggle = document.getElementById('export-speaker-names-as-suffix');


  const exportOpenSubtitleColorSettingsButton = document.getElementById('export-open-subtitle-color-settings');


  const helpToggle = document.getElementById('help-toggle');


  const editorThemeOptions = Array.from(document.querySelectorAll('[data-editor-theme]'));


  const editorAccentOptions = Array.from(document.querySelectorAll('[data-editor-accent]'));


  const editorAccentCustomField = document.getElementById('editor-accent-custom-field');


  const editorAccentCustomInput = document.getElementById('editor-accent-custom');


  const editorAccentCustomValue = document.getElementById('editor-accent-custom-value');


  const helpPanel = document.getElementById('help-panel');


  const helpDragHandle = document.getElementById('help-drag-handle');


  const helpCloseButton = document.getElementById('help-close');


  const helpSplitKey = document.getElementById('help-split-key');


  const cueEditorSplitKey = document.getElementById('cue-editor-split-key');


  const cueEditorConfirmKey = document.getElementById('cue-editor-confirm-key');


  const helpTabButtons = Array.from(document.querySelectorAll('[data-help-tab]'));


  const helpTabPanels = Array.from(document.querySelectorAll('[data-help-tab-panel]'));


  const helpOpenWaveformSettingsButtons = Array.from(document.querySelectorAll('[data-help-open-waveform-settings]'));


  const helpOpenMediaSettingsButtons = Array.from(document.querySelectorAll('[data-help-open-media-settings]'));


  const helpOpenGapRemovePanelButton = document.getElementById('help-open-gap-remove-panel');


  const contextualHelpButtons = Array.from(document.querySelectorAll('[data-help-tab-target]'));


  const helpMediaSeekStep = document.getElementById('help-media-seek-step');



  const clickBehaviorSelect = document.getElementById('click-behavior');


  const clickTargetField = document.getElementById('click-target-field');


  const clickTargetSelect = document.getElementById('click-target');


  const keyboardOperationReferenceSelect = document.getElementById('keyboard-operation-reference');


  const keyboardOperationReferenceHint = document.getElementById('keyboard-operation-reference-hint');


  const hoverSeekPreviewToggle = document.getElementById('hover-seek-preview');


  const cueMoveStepInput = document.getElementById('cue-move-step');


  const cueMoveStepUnit = document.getElementById('cue-move-step-unit');


  const cueMoveStepHint = document.getElementById('cue-move-step-hint');


  const timelineTimebaseSelect = document.getElementById('timeline-timebase');


  const timelineFpsInput = document.getElementById('timeline-fps');


  const timelineTimebaseHint = document.getElementById('timeline-timebase-hint');


  const timelineSnapToFrameToggle = document.getElementById('timeline-snap-to-frame');


  const timelineSnapToFrameHint = document.getElementById('timeline-snap-to-frame-hint');


  const timelineTimecodeSeparatorInput = document.getElementById('timeline-timecode-separator');


  const timelineTimecodeSeparatorHint = document.getElementById('timeline-timecode-separator-hint');


  const autoSnapAdjacentCuesToggle = document.getElementById('auto-snap-adjacent-cues');


  const replaceModal = document.getElementById('replace-modal');


  const textProcessModal = document.getElementById('text-process-modal');


  const timedTextEditButton = document.getElementById('timed-text-edit-btn');


  const timedTextEditModal = document.getElementById('timed-text-edit-modal');


  const timedTextEditClose = document.getElementById('timed-text-edit-close');


  const timedTextEditCancel = document.getElementById('timed-text-edit-cancel');


  const timedTextEditApply = document.getElementById('timed-text-edit-apply');


  const timedTextEditTrackControl = document.getElementById('timed-text-edit-track-control');


  const timedTextEditTrack = document.getElementById('timed-text-edit-track');


  const timedTextEditView = document.getElementById('timed-text-edit-view');


  const timedTextEditSourceInfo = document.getElementById('timed-text-edit-source-info');


  const timedTextEditCharcountThresholdControl = document.getElementById('timed-text-edit-charcount-control');


  const timedTextEditCharcountThresholdInput = document.getElementById('timed-text-edit-charcount-threshold');


  const timedTextEditShowDisabledToggle = document.getElementById('timed-text-edit-show-disabled');


  const timedTextEditRows = document.getElementById('timed-text-edit-rows');


  const timedTextEditSingleEditor = document.getElementById('timed-text-edit-single-editor');


  const timedTextEditSingleTextarea = document.getElementById('timed-text-edit-single-textarea');


  const timedTextEditSingleHint = document.getElementById('timed-text-edit-single-hint');


  const timedTextEditReportSummary = document.getElementById('timed-text-edit-report-summary');


  const timedTextEditReportMapping = document.getElementById('timed-text-edit-report-mapping');


  const timedTextEditShowAll = document.getElementById('timed-text-edit-show-all');


  const timedTextEditReportHint = document.getElementById('timed-text-edit-report-hint');


  const timedTextEditChangeDetails = document.getElementById('timed-text-edit-change-details');


  const timedTextEditChangeList = document.getElementById('timed-text-edit-change-list');


  const TIMED_TEXT_EDIT_REPORT_DEBOUNCE_MS = 160;


  let timedTextEditDraft = null;


  let timedTextEditReturnFocus = null;


  let timedTextEditReportTimer = null;


  const stickerModal = document.getElementById('sticker-modal');


  const stickerPreviewModal = document.getElementById('sticker-preview-modal');


  const projectMediaModal = document.getElementById('project-media-modal');


  const projectMediaSelectButton = document.getElementById('project-media-select');


  const projectMediaLaterButton = document.getElementById('project-media-later');


  const fcp7ExportModal = document.getElementById('fcp7-export-modal');


  const fcp7ExportTimelineMode = document.getElementById('fcp7-export-timeline-mode');


  const fcp7ExportFps = document.getElementById('fcp7-export-fps');


  const fcp7ExportSubtitleTracks = document.getElementById('fcp7-export-subtitle-tracks');


  const fcp7ExportNativeText = document.getElementById('fcp7-export-native-text');


  const fcp7ExportCancel = document.getElementById('fcp7-export-cancel');


  const fcp7ExportConfirm = document.getElementById('fcp7-export-confirm');


  const lottieExportModal = document.getElementById('lottie-export-modal');


  const lottieExportTrack = document.getElementById('lottie-export-track');


  const lottieExportGapRemoved = document.getElementById('lottie-export-gap-removed');


  const lottieExportResolution = document.getElementById('lottie-export-resolution');


  const lottieExportFps = document.getElementById('lottie-export-fps');


  const lottieExportRenderMode = document.getElementById('lottie-export-render-mode');


  const lottieExportCancel = document.getElementById('lottie-export-cancel');


  const lottieExportConfirm = document.getElementById('lottie-export-confirm');


  const ografExportModal = document.getElementById('ograf-export-modal');


  const ografExportTrack = document.getElementById('ograf-export-track');


  const ografExportGapRemoved = document.getElementById('ograf-export-gap-removed');


  const ografExportResolution = document.getElementById('ograf-export-resolution');


  const ografExportFps = document.getElementById('ograf-export-fps');


  const ografExportCancel = document.getElementById('ograf-export-cancel');


  const ografExportConfirm = document.getElementById('ograf-export-confirm');


  const ctxmenu = document.getElementById('ctxmenu');


  const cuePanel = document.getElementById('current-cue-panel');


  const cuePanelPrev = document.getElementById('cue-panel-prev');


  const cuePanelNext = document.getElementById('cue-panel-next');


  const cuePanelStart = document.getElementById('cue-panel-start');


  const cuePanelDuration = document.getElementById('cue-panel-duration');


  const cuePanelText = document.getElementById('cue-panel-text');


  const cuePanelTarget = document.getElementById('cue-panel-target');


  const cuePanelTotalLength = document.getElementById('cue-panel-total-length');


  const cuePanelCharsPerSecond = document.getElementById('cue-panel-chars-per-second');


  const cuePanelSticker = document.getElementById('cue-panel-sticker');


  const cuePanelAddSticker = document.getElementById('cue-panel-add-sticker');


  const cuePanelSplit = document.getElementById('cue-panel-split');


  const cuePanelSplitKey = document.getElementById('cue-panel-split-key');


  const cuesEmpty = document.getElementById('cues-empty');


  const saveProjectButton = document.getElementById('save-project');


  const saveProjectAsButton = document.getElementById('save-project-as');


  const saveProjectDropdown = document.getElementById('save-project-dropdown');


  const gapRemovedExportDropdown = document.getElementById('gap-removed-export-dropdown');


  const downloadMultiSrtButton = document.getElementById('download-multi-srt');


  const subtitleExportDropdown = document.getElementById('subtitle-export-dropdown');


  const downloadColorSrtItem = document.getElementById('download-color-srt');


  const downloadGapRemovedColorSrtItem = document.getElementById('download-gap-removed-color-srt');


  const multiSubtitleControls = document.getElementById('multi-subtitle-controls');


  const multiSubtitleToggleLabel = document.getElementById('multi-subtitle-toggle-label');


  const multiSubtitleSettingsDropdown = document.getElementById('multi-subtitle-settings-dropdown');


  const multiSubtitleSettingsToggle = document.getElementById('multi-subtitle-settings-toggle');


  const splitMultiSubtitleSettingsEnabledHint = document.getElementById('split-multi-subtitle-settings-enabled');


  const splitMultiSubtitleSettingsDisabledHint = document.getElementById('split-multi-subtitle-settings-disabled');


  const splitMultiSubtitleSettingsLink = document.getElementById('split-multi-subtitle-settings-link');


  // 已开启多重字幕但尚未加载第二条字幕时的开关右侧提示。
  const multiSubtitleEmptyHint = document.getElementById('multi-subtitle-empty-hint');


  const multiSubtitleSwapButton = document.getElementById('multi-subtitle-swap');


  const multiSubtitleCrossTrackSnapToggle = document.getElementById('multi-subtitle-cross-track-snap');


  const multiSubtitleSelectBoundPairToggle = document.getElementById('multi-subtitle-select-bound-pair');


  const multiSubtitleAutoSyncDurationToggle = document.getElementById('multi-subtitle-auto-sync-duration');


  const multiSubtitleShowTrackBadgesToggle = document.getElementById('multi-subtitle-show-track-badges');


  const multiSubtitleWaveformControls = document.getElementById('multi-subtitle-waveform-controls');


  const multiSubtitleToggle = document.getElementById('multi-subtitle-toggle');


  const multiSubtitleDisplayMode = document.getElementById('multi-subtitle-display-mode');


  const multiSubtitleMainLanguageMode = document.getElementById('multi-subtitle-main-language-mode');


  const multiSubtitleExtensionLanguageMode = document.getElementById('multi-subtitle-extension-language-mode');


  const multiSubtitleExtensionRowHeightSetting = document.getElementById('multi-subtitle-extension-row-height-setting');


  const multiSubtitleExtensionRowHeight = document.getElementById('multi-subtitle-extension-row-height');


  const multiSubtitleAlignButton = document.getElementById('multi-subtitle-align');


  const multiSubtitleImportModal = document.getElementById('multi-subtitle-import-modal');


  const multiSubtitleImportDescription = document.getElementById('multi-subtitle-import-description');


  const multiSubtitleImportPreview = document.getElementById('multi-subtitle-import-preview');


  const multiSubtitleImportChoiceActions = document.getElementById('multi-subtitle-import-choice-actions');


  const multiSubtitleImportResultActions = document.getElementById('multi-subtitle-import-result-actions');


  const multiSubtitleImportReplace = document.getElementById('multi-subtitle-import-replace');


  const multiSubtitleImportExtension = document.getElementById('multi-subtitle-import-extension');


  const multiSubtitleImportResultCancel = document.getElementById('multi-subtitle-import-result-cancel');


  const multiSubtitleImportResultConfirm = document.getElementById('multi-subtitle-import-result-confirm');


  const multiSubtitleSplitModal = document.getElementById('multi-subtitle-split-modal');


  const multiSubtitleSplitTitle = document.getElementById('multi-subtitle-split-title');


  const multiSubtitleSplitMeta = document.getElementById('multi-subtitle-split-meta');


  const multiSubtitleSplitMainLane = document.getElementById('multi-subtitle-split-main-lane');


  const multiSubtitleSplitMainText = document.getElementById('multi-subtitle-split-main-text');


  const multiSubtitleSplitExtensionLane = document.getElementById('multi-subtitle-split-extension-lane');


  const multiSubtitleSplitText = document.getElementById('multi-subtitle-split-text');


  const multiSubtitleSplitTimestampHint = document.getElementById('multi-subtitle-split-timestamp-hint');


  const multiSubtitleSplitPreview = document.getElementById('multi-subtitle-split-preview');


  const multiSubtitleSplitError = document.getElementById('multi-subtitle-split-error');


  const multiSubtitleSplitCancel = document.getElementById('multi-subtitle-split-cancel');


  const multiSubtitleSplitConfirm = document.getElementById('multi-subtitle-split-confirm');


  const multiSubtitleSplitAutoSubmit = document.getElementById('multi-subtitle-split-auto-submit');


  const editorSettingsToggle = document.getElementById('editor-settings-toggle');


  const editorSettingsPanel = document.getElementById('editor-settings-panel');


  const mergeJoinSettings = document.getElementById('merge-join-settings');


  const mergeJoinSettingsToggle = document.getElementById('merge-join-settings-toggle');


  const mergeJoinSettingsPanel = document.getElementById('merge-join-settings-panel');


  const splitTrimSettings = document.getElementById('split-trim-settings');


  const splitTrimSettingsToggle = document.getElementById('split-trim-settings-toggle');


  const splitTrimSettingsPanel = document.getElementById('split-trim-settings-panel');


  const cueEditorSettings = document.getElementById('cue-editor-settings');


  const cueEditorSettingsToggle = document.getElementById('cue-editor-settings-toggle');


  const cueEditorSettingsPanel = document.getElementById('cue-editor-settings-panel');


  const waveformSettings = document.getElementById('waveform-settings');


  const waveformSettingsToggle = document.getElementById('waveform-settings-toggle');


  const waveformSettingsPanel = document.getElementById('waveform-settings-panel');


  const exportStartAtZeroToggle = document.getElementById('export-start-at-zero');


  const serverAutoSaveSettings = document.getElementById('server-auto-save-settings');


  const autoSaveProjectToggle = document.getElementById('auto-save-project');


  const autoSaveIntervalField = document.getElementById('auto-save-interval-field');


  const autoSaveIntervalInput = document.getElementById('auto-save-interval');


  const recentProjectsEl = document.getElementById('recent-projects');


  const recentProjectsToggle = document.getElementById('recent-projects-toggle');


  const recentProjectsMenu = document.getElementById('recent-projects-menu');


  const recentProjectsList = document.getElementById('recent-projects-list');


  const recentProjectsSeparator = document.getElementById('recent-projects-separator');


  const serverProjectSettingsEl = document.getElementById('server-project-settings');


  const autoOpenLastProjectToggle = document.getElementById('auto-open-last-project');


  const GAP_REMOVE_PANEL_POSITION_KEY = 'moy.asr.gap_remove.panel.v1';


  const gapRemovePanel = document.getElementById('gap-remove-panel');


  const gapRemoveDragHandle = document.getElementById('gap-remove-drag-handle');


  const gapRemoveCloseButton = document.getElementById('gap-remove-close');


  const gapRemoveManageButton = document.getElementById('gap-remove-manage');


  const gapRemoveThreshold = document.getElementById('gap-remove-threshold');


  const gapRemoveVolumeThreshold = document.getElementById('gap-remove-volume-threshold');


  const gapRemoveHysteresis = document.getElementById('gap-remove-hysteresis');


  const gapRemoveHysteresisHint = document.getElementById('gap-remove-hysteresis-hint');


  const gapRemoveLeadIn = document.getElementById('gap-remove-lead-in');


  const gapRemoveLeadOut = document.getElementById('gap-remove-lead-out');


  const gapRemoveShrinkButton = document.getElementById('gap-remove-shrink');


  const gapRemoveAdvancedToggle = document.getElementById('gap-remove-advanced-toggle');


  const gapRemoveAdvancedBody = document.getElementById('gap-remove-advanced-body');


  const gapRemoveDisableToggle = document.getElementById('gap-remove-disable-toggle');


  const gapRemoveDisableBody = document.getElementById('gap-remove-disable-body');


  const gapRemoveDisableCoverage = document.getElementById('gap-remove-disable-coverage');


  const gapRemoveDisableRemaining = document.getElementById('gap-remove-disable-remaining');


  const gapRemoveDisableButton = document.getElementById('gap-remove-disable-button');


  const gapRemoveDisableHint = document.getElementById('gap-remove-disable-hint');


  const gapRemoveOperationMode = document.getElementById('gap-remove-operation-mode');


  const gapRemoveScanButton = document.getElementById('gap-remove-scan');


  const gapRemoveSkipPlayback = document.getElementById('gap-skip-playback');


  const gapRemoveList = document.getElementById('gap-remove-list');


  const gapRemoveClearAllButton = document.getElementById('gap-remove-clear-all');


  const HELP_PANEL_POSITION_KEY = 'moy.asr.help.panel.v1';


  const HELP_PANEL_SIZE_KEY = 'moy.asr.help.panel.size.v1';


  const EDITOR_SETTINGS_WINDOW_POSITION_KEY = 'moy.asr.editor.settings.window.v1';


  const EDITOR_SETTINGS_WINDOW_SIZE_KEY = 'moy.asr.editor.settings.window_size.v1';


  const EDITOR_SETTINGS_WINDOW_TAB_KEY = 'moy.asr.editor.settings.window_tab.v1';


  const editorSettingsClose = document.getElementById('editor-settings-close');


  const editorSettingsDragHandle = document.getElementById('editor-settings-drag-handle');



  const AUTO_MERGE_PANEL_POSITION_KEY = 'moy.asr.auto_merge.panel.v2';


  const autoMergePanel = document.getElementById('auto-merge-panel');


  const autoMergeDragHandle = document.getElementById('auto-merge-drag-handle');


  const autoMergeCloseButton = document.getElementById('auto-merge-close');


  const autoMergeManageButton = document.getElementById('auto-merge-manage');


  const autoMergeRunButton = document.getElementById('auto-merge-run');


  const autoMergeGapMsInput = document.getElementById('auto-merge-gap-ms');


  const autoMergeSnapDirectionSelect = document.getElementById('auto-merge-snap-direction');


  const autoMergeAbsorbShortToggle = document.getElementById('auto-merge-absorb-short');


  const autoMergeShortCountInput = document.getElementById('auto-merge-short-count');


  const autoMergeAbsorbDirectionSelect = document.getElementById('auto-merge-absorb-direction');


  const SUBTITLE_EXTEND_PANEL_POSITION_KEY = 'moy.asr.subtitle_extend.panel.v1';


  const subtitleExtendPanel = document.getElementById('subtitle-extend-panel');


  const subtitleExtendDragHandle = document.getElementById('subtitle-extend-drag-handle');


  const subtitleExtendCloseButton = document.getElementById('subtitle-extend-close');


  const subtitleExtendManageButton = document.getElementById('subtitle-extend-manage');


  const subtitleExtendRunButton = document.getElementById('subtitle-extend-run');


  const subtitleExtendForwardInput = document.getElementById('subtitle-extend-forward-ms');


  const subtitleExtendBackwardInput = document.getElementById('subtitle-extend-backward-ms');


  const waveformShapeSourceSelect = document.getElementById('waveform-shape-source');

  global.MaweDom = Object.freeze({
    nowEl,
    searchEl,
    visibleCountEl,
    totalCountEl,
    selCountEl,
    overlayEl,
    overlayTextEl,
    overlayMainSpeakerLabelEl,
    overlayMainTextNode,
    overlayExtensionTextEl,
    overlayToggle,
    extensionOverlayToggleWrap,
    extensionOverlayToggle,
    stickerOverlayToggle,
    subtitleFontSizeSelect,
    subtitleFontFamilySelect,
    subtitleFontFamilyScanButton,
    subtitleFontFamilyStatus,
    subtitleBackgroundColorInput,
    subtitleBackgroundAlphaInput,
    subtitleBackgroundAlphaValue,
    subtitleColorInput,
    subtitleColorUnderlineInput,
    subtitleColorStyleControl,
    subtitleColorStyleSelect,
    subtitleSpeakerMappingEnabledInput,
    subtitleSpeakerLabelsToggle,
    subtitleSpeakerLabelsEnabledInput,
    subtitleSpeakerLabelsSettings,
    subtitleSpeakerLabelSeparatorInput,
    subtitleSpeakerLabelInputs,
    extensionSubtitlePreviewSettings,
    extensionSubtitlePreviewTitle,
    extensionSubtitleFontSizeSelect,
    extensionSubtitleFontFamilySelect,
    extensionSubtitleColorInput,
    extensionSubtitleBackgroundColorInput,
    extensionSubtitleBackgroundAlphaInput,
    extensionSubtitleBackgroundAlphaValue,
    playerEmpty,
    playerWrap,
    mediaPlayToggle,
    mediaStepBack,
    mediaStepForward,
    mediaSeekStepInput,
    mediaSeekStepUnit,
    mediaSeekStepHint,
    get mediaSeekInputLastValue() { return mediaSeekInputLastValue; },
    set mediaSeekInputLastValue(v) { mediaSeekInputLastValue = v; },
    mediaCurrentTime,
    mediaDuration,
    mediaSeek,
    mediaVolume,
    mediaPlaybackRate,
    mediaFullscreen,
    playerStage,
    splitKeySel,
    splitUseWordTimestampsToggle,
    mergeJoinTextContinuousInput,
    mergeJoinTextWordInput,
    cueListShowIndexToggle,
    cueListShowTimeToggle,
    cueListShowStickerToggle,
    cueListShowCharcountToggle,
    cueListAutoScrollOnClickToggle,
    cueListKeepSplitVisibleToggle,
    cueListCharcountThresholdInput,
    cueListSettings,
    cueListSettingsToggle,
    cueListSettingsPanel,
    hideDisabledToggle,
    get hideDisabled() { return hideDisabled; },
    set hideDisabled(v) { hideDisabled = v; },
    cueEditorShowNavigationToggle,
    cueEditorShowTimeActionsToggle,
    cueEditorShowStickerToggle,
    cueEditorCancelOnEscapeToggle,
    selectGroupMembersToggle,
    ninjaModeToggle,
    ninjaSoundToggle,
    ninjaSoundField,
    ninjaSlashEffectToggle,
    ninjaSlashEffectField,
    ninjaSlashParamsField,
    ninjaSlashLengthInput,
    ninjaSlashRotateInput,
    razorToolButton,
    razorToolSvg,
    ninjaRazorIcon,
    ninjaSlashFlash,
    exportColorUnifiedToggle,
    exportSpeakerLabelsToggle,
    exportSpeakerNamesAsSuffixToggle,
    exportOpenSubtitleColorSettingsButton,
    helpToggle,
    editorThemeOptions,
    editorAccentOptions,
    editorAccentCustomField,
    editorAccentCustomInput,
    editorAccentCustomValue,
    helpPanel,
    helpDragHandle,
    helpCloseButton,
    helpSplitKey,
    cueEditorSplitKey,
    cueEditorConfirmKey,
    helpTabButtons,
    helpTabPanels,
    helpOpenWaveformSettingsButtons,
    helpOpenMediaSettingsButtons,
    helpOpenGapRemovePanelButton,
    contextualHelpButtons,
    helpMediaSeekStep,
    clickBehaviorSelect,
    clickTargetField,
    clickTargetSelect,
    keyboardOperationReferenceSelect,
    keyboardOperationReferenceHint,
    hoverSeekPreviewToggle,
    cueMoveStepInput,
    cueMoveStepUnit,
    cueMoveStepHint,
    timelineTimebaseSelect,
    timelineFpsInput,
    timelineTimebaseHint,
    timelineSnapToFrameToggle,
    timelineSnapToFrameHint,
    timelineTimecodeSeparatorInput,
    timelineTimecodeSeparatorHint,
    autoSnapAdjacentCuesToggle,
    replaceModal,
    textProcessModal,
    timedTextEditButton,
    timedTextEditModal,
    timedTextEditClose,
    timedTextEditCancel,
    timedTextEditApply,
    timedTextEditTrackControl,
    timedTextEditTrack,
    timedTextEditView,
    timedTextEditSourceInfo,
    timedTextEditCharcountThresholdControl,
    timedTextEditCharcountThresholdInput,
    timedTextEditShowDisabledToggle,
    timedTextEditRows,
    timedTextEditSingleEditor,
    timedTextEditSingleTextarea,
    timedTextEditSingleHint,
    timedTextEditReportSummary,
    timedTextEditReportMapping,
    timedTextEditShowAll,
    timedTextEditReportHint,
    timedTextEditChangeDetails,
    timedTextEditChangeList,
    TIMED_TEXT_EDIT_REPORT_DEBOUNCE_MS,
    get timedTextEditDraft() { return timedTextEditDraft; },
    set timedTextEditDraft(v) { timedTextEditDraft = v; },
    get timedTextEditReturnFocus() { return timedTextEditReturnFocus; },
    set timedTextEditReturnFocus(v) { timedTextEditReturnFocus = v; },
    get timedTextEditReportTimer() { return timedTextEditReportTimer; },
    set timedTextEditReportTimer(v) { timedTextEditReportTimer = v; },
    stickerModal,
    stickerPreviewModal,
    projectMediaModal,
    projectMediaSelectButton,
    projectMediaLaterButton,
    fcp7ExportModal,
    fcp7ExportTimelineMode,
    fcp7ExportFps,
    fcp7ExportSubtitleTracks,
    fcp7ExportNativeText,
    fcp7ExportCancel,
    fcp7ExportConfirm,
    lottieExportModal,
    lottieExportTrack,
    lottieExportGapRemoved,
    lottieExportResolution,
    lottieExportFps,
    lottieExportRenderMode,
    lottieExportCancel,
    lottieExportConfirm,
    ografExportModal,
    ografExportTrack,
    ografExportGapRemoved,
    ografExportResolution,
    ografExportFps,
    ografExportCancel,
    ografExportConfirm,
    ctxmenu,
    cuePanel,
    cuePanelPrev,
    cuePanelNext,
    cuePanelStart,
    cuePanelDuration,
    cuePanelText,
    cuePanelTarget,
    cuePanelTotalLength,
    cuePanelCharsPerSecond,
    cuePanelSticker,
    cuePanelAddSticker,
    cuePanelSplit,
    cuePanelSplitKey,
    cuesEmpty,
    saveProjectButton,
    saveProjectAsButton,
    saveProjectDropdown,
    gapRemovedExportDropdown,
    downloadMultiSrtButton,
    subtitleExportDropdown,
    downloadColorSrtItem,
    downloadGapRemovedColorSrtItem,
    multiSubtitleControls,
    multiSubtitleToggleLabel,
    multiSubtitleSettingsDropdown,
    multiSubtitleSettingsToggle,
    splitMultiSubtitleSettingsEnabledHint,
    splitMultiSubtitleSettingsDisabledHint,
    splitMultiSubtitleSettingsLink,
    multiSubtitleEmptyHint,
    multiSubtitleSwapButton,
    multiSubtitleCrossTrackSnapToggle,
    multiSubtitleSelectBoundPairToggle,
    multiSubtitleAutoSyncDurationToggle,
    multiSubtitleShowTrackBadgesToggle,
    multiSubtitleWaveformControls,
    multiSubtitleToggle,
    multiSubtitleDisplayMode,
    multiSubtitleMainLanguageMode,
    multiSubtitleExtensionLanguageMode,
    multiSubtitleExtensionRowHeightSetting,
    multiSubtitleExtensionRowHeight,
    multiSubtitleAlignButton,
    multiSubtitleImportModal,
    multiSubtitleImportDescription,
    multiSubtitleImportPreview,
    multiSubtitleImportChoiceActions,
    multiSubtitleImportResultActions,
    multiSubtitleImportReplace,
    multiSubtitleImportExtension,
    multiSubtitleImportResultCancel,
    multiSubtitleImportResultConfirm,
    multiSubtitleSplitModal,
    multiSubtitleSplitTitle,
    multiSubtitleSplitMeta,
    multiSubtitleSplitMainLane,
    multiSubtitleSplitMainText,
    multiSubtitleSplitExtensionLane,
    multiSubtitleSplitText,
    multiSubtitleSplitTimestampHint,
    multiSubtitleSplitPreview,
    multiSubtitleSplitError,
    multiSubtitleSplitCancel,
    multiSubtitleSplitConfirm,
    multiSubtitleSplitAutoSubmit,
    editorSettingsToggle,
    editorSettingsPanel,
    mergeJoinSettings,
    mergeJoinSettingsToggle,
    mergeJoinSettingsPanel,
    splitTrimSettings,
    splitTrimSettingsToggle,
    splitTrimSettingsPanel,
    cueEditorSettings,
    cueEditorSettingsToggle,
    cueEditorSettingsPanel,
    waveformSettings,
    waveformSettingsToggle,
    waveformSettingsPanel,
    exportStartAtZeroToggle,
    serverAutoSaveSettings,
    autoSaveProjectToggle,
    autoSaveIntervalField,
    autoSaveIntervalInput,
    recentProjectsEl,
    recentProjectsToggle,
    recentProjectsMenu,
    recentProjectsList,
    recentProjectsSeparator,
    serverProjectSettingsEl,
    autoOpenLastProjectToggle,
    GAP_REMOVE_PANEL_POSITION_KEY,
    gapRemovePanel,
    gapRemoveDragHandle,
    gapRemoveCloseButton,
    gapRemoveManageButton,
    gapRemoveThreshold,
    gapRemoveVolumeThreshold,
    gapRemoveHysteresis,
    gapRemoveHysteresisHint,
    gapRemoveLeadIn,
    gapRemoveLeadOut,
    gapRemoveShrinkButton,
    gapRemoveAdvancedToggle,
    gapRemoveAdvancedBody,
    gapRemoveDisableToggle,
    gapRemoveDisableBody,
    gapRemoveDisableCoverage,
    gapRemoveDisableRemaining,
    gapRemoveDisableButton,
    gapRemoveDisableHint,
    gapRemoveOperationMode,
    gapRemoveScanButton,
    gapRemoveSkipPlayback,
    gapRemoveList,
    gapRemoveClearAllButton,
    HELP_PANEL_POSITION_KEY,
    HELP_PANEL_SIZE_KEY,
    EDITOR_SETTINGS_WINDOW_POSITION_KEY,
    EDITOR_SETTINGS_WINDOW_SIZE_KEY,
    EDITOR_SETTINGS_WINDOW_TAB_KEY,
    editorSettingsClose,
    editorSettingsDragHandle,
    AUTO_MERGE_PANEL_POSITION_KEY,
    autoMergePanel,
    autoMergeDragHandle,
    autoMergeCloseButton,
    autoMergeManageButton,
    autoMergeRunButton,
    autoMergeGapMsInput,
    autoMergeSnapDirectionSelect,
    autoMergeAbsorbShortToggle,
    autoMergeShortCountInput,
    autoMergeAbsorbDirectionSelect,
    SUBTITLE_EXTEND_PANEL_POSITION_KEY,
    subtitleExtendPanel,
    subtitleExtendDragHandle,
    subtitleExtendCloseButton,
    subtitleExtendManageButton,
    subtitleExtendRunButton,
    subtitleExtendForwardInput,
    subtitleExtendBackwardInput,
    waveformShapeSourceSelect
  });
})(typeof window !== 'undefined' ? window : globalThis);

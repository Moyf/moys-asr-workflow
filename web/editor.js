
window.addEventListener('error', (event) => {
  const details = {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack || null,
  };
  window.MAWE_DEBUG_ERRORS = [...(window.MAWE_DEBUG_ERRORS || []), details];
  console.error('[MAWE][runtime] uncaught error', details);
});
window.addEventListener('unhandledrejection', (event) => {
  window.MAWE_DEBUG_ERRORS = [...(window.MAWE_DEBUG_ERRORS || []), {
    message: String(event.reason), stack: event.reason?.stack || null,
  }];
  console.error('[MAWE][runtime] unhandled rejection', event.reason);
});
if (!window.AsrEditorUtils) {
  console.error('[MAWE][boot] AsrEditorUtils is unavailable; editor scripts are incomplete or out of order');
}

const MULTI_SUBTITLE_UTILS = window.AsrEditorUtils;
const EDITOR_SETTINGS_UTILS = window.AsrEditorUtils;
MaweBoot.maweDomContractCheck();

MaweMultiSubtitleCore.normalizeMultiSubtitleState();
const normalizeTimelineTimebase = EDITOR_SETTINGS_UTILS.normalizeTimelineTimebase;
const normalizeTimelineFps = EDITOR_SETTINGS_UTILS.normalizeTimelineFps;
const normalizeTimelineTimecodeSeparator = EDITOR_SETTINGS_UTILS.normalizeTimelineTimecodeSeparator;
const normalizeMediaMetadata = EDITOR_SETTINGS_UTILS.normalizeMediaMetadata;
const DEFAULT_TIMELINE_FPS = EDITOR_SETTINGS_UTILS.DEFAULT_TIMELINE_FPS;
const frameNumberFromMilliseconds = EDITOR_SETTINGS_UTILS.frameNumberFromMilliseconds;
const millisecondsFromFrameNumber = EDITOR_SETTINGS_UTILS.millisecondsFromFrameNumber;
const formatFrameTimecode = EDITOR_SETTINGS_UTILS.formatFrameTimecode;
const formatTimelineTimecode = EDITOR_SETTINGS_UTILS.formatTimelineTimecode;
const parseFrameTimecode = EDITOR_SETTINGS_UTILS.parseFrameTimecode;
const MIN_TIMELINE_FPS = EDITOR_SETTINGS_UTILS.MIN_TIMELINE_FPS;
const MAX_TIMELINE_FPS = EDITOR_SETTINGS_UTILS.MAX_TIMELINE_FPS;
// 把用户配置的拆分移除符号同步给共享工具层；设置面板修改时也会同步。
MULTI_SUBTITLE_UTILS.setSplitTrimSymbols(MaweSettings.EDITOR_SETTINGS.splitTrimSymbols);

const TIMELINE_ROUND_MS = 10;

function roundTimelineMilliseconds(value) {
  return Math.round(Number(value) / TIMELINE_ROUND_MS) * TIMELINE_ROUND_MS;
}

function hasValidFramePair(value) {
  return !!value
    && Number.isInteger(value.start_frame)
    && Number.isInteger(value.end_frame)
    && value.start_frame >= 0
    && value.end_frame > value.start_frame;
}

function syncTimeRangeObjectTimebase(value, timebase, { preferFrames = false, frameBounds = null } = {}) {
  if (!value || typeof value !== 'object') return null;
  const frameMode = timebase.unit === 'frames';
  const hasFrames = hasValidFramePair(value);
  const rawStartMs = Number(value.start);
  const rawEndMs = Number(value.end);
  let startFrame = hasFrames && preferFrames
    ? value.start_frame : frameNumberFromMilliseconds(rawStartMs, timebase.fps);
  let endFrame = hasFrames && preferFrames
    ? value.end_frame : frameNumberFromMilliseconds(rawEndMs, timebase.fps);
  if (!Number.isInteger(startFrame) || startFrame < 0) startFrame = 0;
  if (!Number.isInteger(endFrame) || endFrame <= startFrame) endFrame = startFrame + 1;

  if (frameMode) {
    if (frameBounds && Number.isInteger(frameBounds.start) && Number.isInteger(frameBounds.end)) {
      const lower = Math.max(0, frameBounds.start);
      const upper = Math.max(lower + 1, frameBounds.end);
      startFrame = Math.min(Math.max(startFrame, lower), upper - 1);
      endFrame = Math.min(Math.max(endFrame, startFrame + 1), upper);
      if (endFrame <= startFrame) {
        startFrame = Math.max(lower, upper - 1);
        endFrame = upper;
      }
    }
    value.start_frame = startFrame;
    value.end_frame = endFrame;
    value.start = millisecondsFromFrameNumber(startFrame, timebase.fps);
    value.end = millisecondsFromFrameNumber(endFrame, timebase.fps);
  } else {
    const startMs = Number.isFinite(rawStartMs)
      ? Math.max(0, Math.round(rawStartMs)) : millisecondsFromFrameNumber(startFrame, timebase.fps);
    const endMs = Number.isFinite(rawEndMs)
      ? Math.max(startMs + 1, Math.round(rawEndMs)) : millisecondsFromFrameNumber(endFrame, timebase.fps);
    value.start = startMs;
    value.end = Math.max(startMs + 1, endMs);
    value.start_frame = frameNumberFromMilliseconds(value.start, timebase.fps);
    value.end_frame = Math.max(
      value.start_frame + 1,
      frameNumberFromMilliseconds(value.end, timebase.fps),
    );
  }
  return { startFrame: value.start_frame, endFrame: value.end_frame };
}

function syncSegmentTimebase(segment, timebase, { preferFrames = false, minimumStartFrame = 0 } = {}) {
  if (!segment || typeof segment !== 'object') return;
  const range = syncTimeRangeObjectTimebase(segment, timebase, { preferFrames });
  if (timebase.unit === 'frames') {
    const startFrame = Math.max(minimumStartFrame, segment.start_frame);
    const endFrame = Math.max(startFrame + 1, segment.end_frame);
    segment.start_frame = startFrame;
    segment.end_frame = endFrame;
    segment.start = millisecondsFromFrameNumber(startFrame, timebase.fps);
    segment.end = millisecondsFromFrameNumber(endFrame, timebase.fps);
  }
  if (!Array.isArray(segment.items)) return range;
  const frameBounds = timebase.unit === 'frames'
    ? { start: segment.start_frame, end: segment.end_frame } : null;
  segment.items.forEach((item) => {
    syncTimeRangeObjectTimebase(item, timebase, { preferFrames, frameBounds });
  });
  if (timebase.unit === 'frames') {
    window.AsrEditorUtils.normalizeFrameItemTimingRanges(segment);
  }
  return range;
}

function syncTrackTimebase(segments, timebase, { preferFrames = false } = {}) {
  if (!Array.isArray(segments)) return;
  let previousEndFrame = 0;
  segments.forEach((segment) => {
    syncSegmentTimebase(segment, timebase, {
      preferFrames,
      minimumStartFrame: timebase.unit === 'frames' ? previousEndFrame : 0,
    });
    if (timebase.unit === 'frames' && Number.isInteger(segment?.end_frame)) {
      previousEndFrame = segment.end_frame;
    }
  });
}

function projectTimebase(project = MaweBoot.DATA) {
  return normalizeTimelineTimebase(project?.timebase);
}

function hasExplicitTimelineFps(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fps = Number(value.fps);
  if (!Number.isFinite(fps) || fps < MIN_TIMELINE_FPS || fps > MAX_TIMELINE_FPS) return false;
  // A non-default FPS or an already-frame-based project represents an
  // explicit choice.  A saved millisecond project with the historical 30 FPS
  // default can still adopt the source media FPS on its first frame switch.
  return value.unit === 'frames' || fps !== DEFAULT_TIMELINE_FPS;
}

function projectMediaVideoFps(project = MaweBoot.DATA) {
  return normalizeMediaMetadata(project?.media_metadata)?.video_fps ?? null;
}

let timelineFpsManuallySet = hasExplicitTimelineFps(MaweBoot.DATA.timebase);

function syncProjectTimebase(project = MaweBoot.DATA, { preferFrames = false } = {}) {
  if (!project || typeof project !== 'object') return normalizeTimelineTimebase();
  const timebase = projectTimebase(project);
  project.timebase = { ...timebase };
  syncTrackTimebase(project.segments, timebase, { preferFrames });
  const tracks = project.multi_subtitle?.tracks;
  if (Array.isArray(tracks)) {
    tracks.forEach((track) => syncTrackTimebase(track?.segments, timebase, { preferFrames }));
  }
  return timebase;
}

function syncProjectTimebaseAndBindingOffsets(project = MaweBoot.DATA, options = {}) {
  const timebase = syncProjectTimebase(project, options);
  if (project && typeof project === 'object') {
    MULTI_SUBTITLE_UTILS.rebuildBindingOffsets(project.multi_subtitle, project.segments);
  }
  return timebase;
}

function timelineIsFrameMode() {
  return projectTimebase().unit === 'frames';
}

function timelineMinimumDurationMs() {
  const timebase = projectTimebase();
  if (timebase.unit !== 'frames') return MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS;
  const minimumFrames = Math.max(1, Math.ceil(MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * timebase.fps / 1000));
  return millisecondsFromFrameNumber(minimumFrames, timebase.fps);
}

function timelineMinimumDurationValue() {
  const timebase = projectTimebase();
  return timebase.unit === 'frames'
    ? Math.max(1, Math.ceil(MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * timebase.fps / 1000))
    : MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS;
}

function timelineTimingAdapter() {
  const timebase = projectTimebase();
  const frameMode = timebase.unit === 'frames';
  const minimumDuration = timelineMinimumDurationValue();
  const snapThreshold = frameMode
    ? Math.max(1, Math.round(80 * timebase.fps / 1000)) : 80;
  if (!frameMode) {
    return {
      unit: 'milliseconds',
      fps: timebase.fps,
      minDuration: minimumDuration,
      snapThreshold,
      round: roundTimelineMilliseconds,
      getStart: (segment) => Number(segment?.start),
      getEnd: (segment) => Number(segment?.end),
      setStart: (segment, value) => { segment.start = roundTimelineMilliseconds(value); },
      setEnd: (segment, value) => { segment.end = roundTimelineMilliseconds(value); },
      getItemStart: (item) => Number(item?.start),
      getItemEnd: (item) => Number(item?.end),
      setItemStart: (item, value) => { item.start = roundTimelineMilliseconds(value); },
      setItemEnd: (item, value) => { item.end = roundTimelineMilliseconds(value); },
      fromMs: (value) => Number(value),
      toMs: (value) => Number(value),
      format: formatTimelineMilliseconds,
    };
  }
  const readFrame = (value, frameField, msField) => Number.isInteger(value?.[frameField])
    ? value[frameField] : frameNumberFromMilliseconds(value?.[msField], timebase.fps);
  const writeFrame = (value, frameField, msField, frame) => {
    const next = Math.max(0, Math.round(Number(frame)));
    value[frameField] = next;
    value[msField] = millisecondsFromFrameNumber(next, timebase.fps);
  };
  return {
    unit: 'frames',
    fps: timebase.fps,
    minDuration: minimumDuration,
    snapThreshold,
    round: (value) => Math.round(Number(value)),
    getStart: (segment) => readFrame(segment, 'start_frame', 'start'),
    getEnd: (segment) => readFrame(segment, 'end_frame', 'end'),
    setStart: (segment, value) => writeFrame(segment, 'start_frame', 'start', value),
    setEnd: (segment, value) => writeFrame(segment, 'end_frame', 'end', value),
    getItemStart: (item) => readFrame(item, 'start_frame', 'start'),
    getItemEnd: (item) => readFrame(item, 'end_frame', 'end'),
    setItemStart: (item, value) => writeFrame(item, 'start_frame', 'start', value),
    setItemEnd: (item, value) => writeFrame(item, 'end_frame', 'end', value),
    fromMs: (value) => frameNumberFromMilliseconds(value, timebase.fps),
    toMs: (value) => millisecondsFromFrameNumber(value, timebase.fps),
    format: (value) => formatFrameTimecode(
      value,
      timebase.fps,
      MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
    ),
  };
}

function formatTimelineMilliseconds(ms) {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  const s = safe / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
}

syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: MaweBoot.DATA.timebase?.unit === 'frames' });
if (MaweHistory.undoBtn) MaweHistory.undoBtn.addEventListener('click', () => MaweHistory.performUndo());
if (MaweHistory.redoBtn) MaweHistory.redoBtn.addEventListener('click', () => MaweHistory.performRedo());
MaweHistory.updateUndoRedoButtons();
MaweDom.overlayTextEl.append(MaweDom.overlayMainTextNode);

// 先登记所有可独立激活的非模态浮层。嵌套在全局设置窗口里的齿轮弹窗会
// 自动归到全局设置窗口这一层，点击它们时也会把外层窗口带到最前面。
// 表情包根目录弹窗从全局设置窗口打开，同样入栈，打开时动态置顶盖住窗口
//（CSS 的 335 只是 JS 初始化前的静态兜底）。
[
  MaweDom.editorSettingsPanel,
  MaweDom.helpPanel,
  MaweDom.gapRemovePanel,
  MaweDom.autoMergePanel,
  MaweDom.subtitleExtendPanel,
  MaweDom.mergeJoinSettingsPanel,
  MaweDom.splitTrimSettingsPanel,
  MaweDom.cueListSettingsPanel,
  MaweDom.cueEditorSettingsPanel,
  MaweDom.waveformSettingsPanel,
  MaweDom.multiSubtitleSettingsDropdown,
  document.getElementById('sticker-root-modal'),
  ...document.querySelectorAll('.toolbar .dropdown'),
].forEach(MaweFloatingPanel.bindFloatingSurfaceActivation);
if (MaweDom.editorSettingsPanel) {
  new ResizeObserver(() => {
    if (!MaweDom.editorSettingsPanel.classList.contains('show')) return;
    if (!MaweDom.editorSettingsPanel.style.width && !MaweDom.editorSettingsPanel.style.height) return;
    clearTimeout(MaweSettingsPanels.editorSettingsPanelSizeSaveTimer);
    MaweSettingsPanels.editorSettingsPanelSizeSaveTimer = setTimeout(() => {
      const rect = MaweDom.editorSettingsPanel.getBoundingClientRect();
      try {
        localStorage.setItem(MaweDom.EDITOR_SETTINGS_WINDOW_SIZE_KEY, JSON.stringify({
          width: Math.round(rect.width), height: Math.round(rect.height),
        }));
      } catch (_) {
        // file:// 隐私模式下 localStorage 可能被拒；缩放本身仍可用。
      }
    }, 250);
  }).observe(MaweDom.editorSettingsPanel);
}

// 切换语言时 i18n 会重置动态文本节点，需重新套用当前拆分按键提示和目标轨道标签。
document.addEventListener('mawe:languagechange', () => {
  MaweSplitMode.refreshSplitKeyHelp();
  renderCurrentCuePanel();
  refreshTimelineSettingsUi();
  MaweMediaPlayback.refreshMediaSeekStepHelp();
  MaweMediaPlayback.refreshMediaSeekControlLabels();
});

MaweDom.splitKeySel.value = MaweSettings.EDITOR_SETTINGS.splitKey;
if (MaweDom.splitUseWordTimestampsToggle) MaweDom.splitUseWordTimestampsToggle.checked = MaweSettings.EDITOR_SETTINGS.splitUseWordTimestamps;
if (MaweDom.multiSubtitleSplitAutoSubmit) MaweDom.multiSubtitleSplitAutoSubmit.checked = MaweSettings.EDITOR_SETTINGS.splitAutoSubmit;
MaweDisplaySettings.applyPlatformKeyLabels();
MaweSplitMode.refreshSplitKeyHelp();
if (MaweDom.mergeJoinTextContinuousInput) MaweDom.mergeJoinTextContinuousInput.value = MaweSettings.EDITOR_SETTINGS.mergeJoinTextContinuous;
if (MaweDom.mergeJoinTextWordInput) MaweDom.mergeJoinTextWordInput.value = MaweSettings.EDITOR_SETTINGS.mergeJoinTextWord;
MaweSplitMode.mergeJoinModeSwitch?.addEventListener('click', () => {
  MaweSplitMode.setMainSubtitleSplitModeBinding(MaweSplitMode.mergeJoinModeSwitch.dataset.targetMode);
});
syncAutoMergePanelInputs();
MaweDom.overlayToggle.checked = MaweSettings.EDITOR_SETTINGS.overlayEnabled;
if (MaweDom.extensionOverlayToggle) MaweDom.extensionOverlayToggle.checked = false;
MaweDom.exportStartAtZeroToggle.checked = MaweSettings.EDITOR_SETTINGS.exportStartAtZero;
if (MaweDom.selectGroupMembersToggle) MaweDom.selectGroupMembersToggle.checked = MaweSettings.EDITOR_SETTINGS.selectGroupMembers;
if (MaweDom.exportColorUnifiedToggle) MaweDom.exportColorUnifiedToggle.checked = MaweSettings.EDITOR_SETTINGS.exportColorUnified;
if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels;
if (MaweDom.exportSpeakerNamesAsSuffixToggle) {
  MaweDom.exportSpeakerNamesAsSuffixToggle.checked = MaweSettings.EDITOR_SETTINGS.exportSpeakerNamesAsSuffix;
}
if (MaweDom.autoSaveProjectToggle) MaweDom.autoSaveProjectToggle.checked = MaweSettings.EDITOR_SETTINGS.autoSaveProject;
if (MaweDom.autoSaveIntervalInput) MaweDom.autoSaveIntervalInput.value = String(MaweSettings.EDITOR_SETTINGS.autoSaveIntervalSeconds);
if (MaweDom.stickerOverlayToggle) MaweDom.stickerOverlayToggle.checked = MaweSettings.EDITOR_SETTINGS.stickerOverlayEnabled;
if (MaweDom.clickBehaviorSelect) MaweDom.clickBehaviorSelect.value = MaweSettings.EDITOR_SETTINGS.clickBehavior;
if (MaweDom.clickTargetSelect) MaweDom.clickTargetSelect.value = MaweSettings.EDITOR_SETTINGS.clickTarget;
if (MaweDom.keyboardOperationReferenceSelect) {
  MaweDom.keyboardOperationReferenceSelect.value = MaweSettings.EDITOR_SETTINGS.keyboardOperationReference;
}
if (MaweJklPlayback.jklPlaybackModeSelect) MaweJklPlayback.jklPlaybackModeSelect.value = MaweSettings.EDITOR_SETTINGS.jklPlaybackMode;
if (MaweDom.hoverSeekPreviewToggle) MaweDom.hoverSeekPreviewToggle.checked = MaweSettings.EDITOR_SETTINGS.hoverSeekPreview;
if (MaweDom.mediaSeekStepInput) MaweDom.mediaSeekStepInput.value = String(MaweSettings.EDITOR_SETTINGS.mediaSeekStepMs);
if (MaweDom.cueMoveStepInput) MaweDom.cueMoveStepInput.value = String(MaweSettings.EDITOR_SETTINGS.cueMoveStepMs);
if (MaweDom.timelineTimebaseSelect) MaweDom.timelineTimebaseSelect.value = projectTimebase().unit;
if (MaweDom.timelineFpsInput) MaweDom.timelineFpsInput.value = String(projectTimebase().fps);
if (MaweDom.timelineSnapToFrameToggle) MaweDom.timelineSnapToFrameToggle.checked = MaweSettings.EDITOR_SETTINGS.timelineSnapToFrame;
if (MaweDom.timelineTimecodeSeparatorInput) {
  MaweDom.timelineTimecodeSeparatorInput.value = normalizeTimelineTimecodeSeparator(
    MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
  );
}
if (MaweDom.autoSnapAdjacentCuesToggle) {
  MaweDom.autoSnapAdjacentCuesToggle.checked = MaweSettings.EDITOR_SETTINGS.autoSnapAdjacentCues;
}
if (MaweDom.cueEditorCancelOnEscapeToggle) {
  MaweDom.cueEditorCancelOnEscapeToggle.checked = MaweSettings.EDITOR_SETTINGS.cueEditorCancelOnEscape;
}
refreshTimelineSettingsUi();
MaweMediaPlayback.refreshMediaSeekStepHelp();
refreshMediaSeekInputStep();
MaweMediaPlayback.refreshMediaSeekControlLabels();
MaweNinja.applyNinjaSettings();
if (MaweDom.waveformShapeSourceSelect) {
  MaweDom.waveformShapeSourceSelect.value = MaweSettings.EDITOR_SETTINGS.waveShapeSource;
  MaweDom.waveformShapeSourceSelect.addEventListener('change', () => {
    MaweSettings.EDITOR_SETTINGS.waveShapeSource = MaweDom.waveformShapeSourceSelect.value === 'reapeaks' ? 'reapeaks' : 'self';
    MaweSettings.saveEditorSettings(MaweSettings.EDITOR_SETTINGS);
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.render();
  });
}
MaweDisplaySettings.applyCueListDisplaySettings({ preserveCueListScroll: false });
MaweDisplaySettings.applyCueEditorDisplaySettings();
MaweDom.multiSubtitleToggle?.addEventListener('change', () => {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const next = MaweDom.multiSubtitleToggle.checked;
  const promptImportSecondSrt = next && !MaweMultiSubtitleCore.getActiveExtensionTrack();
  multi.enabled = !next;
  MaweHistory.pushUndo(next ? '开启多重字幕' : '关闭多重字幕');
  multi.enabled = next;
  multi._dirty = true;
  // 开关会改变波形是否需要副字幕 lane，因此这里才执行完整波形重建。
  renderAll({ waveform: 'full' });
  if (!promptImportSecondSrt) return;
  // 多重字幕模式已开启；提示只决定是否现在导入第二条字幕，
  // 用户取消导入也保持开启，之后仍可拖入 SRT 或重新走导入流程。
  if (!confirm(MaweMultiSubtitleCore.MULTI_SUBTITLE_IMPORT_PROMPT)) return;
  MaweMultiSubtitleCore.pendingSrtImportAsExtension = true;
  MaweProjectMediaInputs.loadSrtFileInput.value = '';
  MaweProjectMediaInputs.loadSrtFileInput.click();
});
MaweDom.multiSubtitleDisplayMode?.addEventListener('change', () => {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const next = MaweDom.multiSubtitleDisplayMode.value;
  const previous = multi.display_mode;
  multi.display_mode = previous;
  MaweHistory.pushUndo('切换多重字幕列表');
  multi.display_mode = MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_DISPLAY_MODES.has(next) ? next : 'both';
  multi._dirty = true;
  renderAll({ waveform: 'none' });
});
MaweDom.multiSubtitleMainLanguageMode?.addEventListener('change', () => {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const next = MaweMultiSubtitleCore.isConfiguredSubtitleSplitMode(MaweDom.multiSubtitleMainLanguageMode.value)
    ? MaweDom.multiSubtitleMainLanguageMode.value : 'word';
  if (multi.main_split_mode === next
      && MaweSettings.EDITOR_SETTINGS.mainSplitModeOverride === next) return;
  MaweHistory.pushUndo('切换主字幕语言类型');
  multi.main_split_mode = next;
  // 与设置面板的类型提示共用同一个手动指定偏好，两个入口互为镜像。
  MaweSettings.updateEditorSettings({ mainSplitModeOverride: next });
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  renderAll({ waveform: 'none' });
});
MaweDom.multiSubtitleExtensionLanguageMode?.addEventListener('change', () => {
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  if (!track) return;
  const next = MaweMultiSubtitleCore.isConfiguredSubtitleSplitMode(MaweDom.multiSubtitleExtensionLanguageMode.value)
    ? MaweDom.multiSubtitleExtensionLanguageMode.value : 'word';
  if (track.split_mode === next) return;
  MaweHistory.pushUndo('切换副字幕语言类型');
  track.split_mode = next;
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  renderAll({ waveform: 'none' });
});
MaweDom.multiSubtitleExtensionRowHeight?.addEventListener('change', () => {
  const next = MaweSettings.normalizeMultiSubtitleRowHeight(MaweDom.multiSubtitleExtensionRowHeight.value);
  MaweSettings.updateEditorSettings({ multiSubtitleRowHeight: next });
  if (MaweMultiSubtitleCore.multiSubtitleVisible()) MaweCoreState.waveformEditor?.setRowHeight(next);
});
MaweDom.multiSubtitleCrossTrackSnapToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ crossTrackSnap: MaweDom.multiSubtitleCrossTrackSnapToggle.checked });
});
MaweDom.multiSubtitleSelectBoundPairToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ selectBoundSubtitlePair: MaweDom.multiSubtitleSelectBoundPairToggle.checked });
});
MaweDom.multiSubtitleAutoSyncDurationToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ multiSubtitleAutoSyncDuration: MaweDom.multiSubtitleAutoSyncDurationToggle.checked });
});
MaweDom.multiSubtitleShowTrackBadgesToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ multiSubtitleShowTrackBadges: MaweDom.multiSubtitleShowTrackBadgesToggle.checked });
  MaweCoreState.waveformEditor?.render?.();
});
MaweDom.multiSubtitleSwapButton?.addEventListener('click', () => {
  MaweMultiImport.swapMainAndExtensionSubtitles();
});
MaweDom.multiSubtitleAlignButton?.addEventListener('click', () => {
  alignSelectedExtensionSubtitleRanges();
});
MaweAppearance.applySubtitleAppearance();
MaweAppearance.applyExtensionSubtitleAppearance();
// 开/关由 createFloatingPanel 的 manageButton 点击切换接管，这里只负责标签页与关闭按钮。
MaweSettingsPanels.editorSettingsTabs.forEach((tab) => {
  tab.addEventListener('click', () => MaweSettingsPanels.setEditorSettingsActiveTab(tab));
  tab.addEventListener('keydown', (event) => {
    // 方向键只在可见分区之间循环；隐藏分区（如不可用的「保存」）不参与导航。
    const visibleTabs = MaweSettingsPanels.editorSettingsTabs.filter((item) => !item.hidden);
    const index = visibleTabs.indexOf(tab);
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      next = (index + 1) % visibleTabs.length;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = (index - 1 + visibleTabs.length) % visibleTabs.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = visibleTabs.length - 1;
    }
    if (next < 0) return;
    event.preventDefault();
    MaweSettingsPanels.setEditorSettingsActiveTab(visibleTabs[next], { focus: true });
  });
});
MaweDom.editorSettingsClose?.addEventListener('click', () => MaweSettingsPanels.setEditorSettingsPanelOpen(false));
MaweDom.mergeJoinSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setMergeJoinSettingsPanelOpen(MaweDom.mergeJoinSettingsPanel?.hidden);
});
MaweDom.splitTrimSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setSplitTrimSettingsPanelOpen(MaweDom.splitTrimSettingsPanel?.hidden);
});
MaweDom.cueListSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setCueListSettingsPanelOpen(MaweDom.cueListSettingsPanel?.hidden);
});
MaweDom.waveformSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setWaveformSettingsPanelOpen(MaweDom.waveformSettingsPanel?.hidden);
});
MaweDom.cueEditorSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setCueEditorSettingsPanelOpen(MaweDom.cueEditorSettingsPanel?.hidden);
});
document.addEventListener('pointerdown', (event) => {
  if (temporaryVisibleSplitCueKeys.size) {
    const targetCue = event.target instanceof Element ? event.target.closest('.cue') : null;
    if (!cueElementHasTemporarySplitVisibility(targetCue)) {
      clearTemporaryVisibleSplitCues();
      applySearch(MaweDom.searchEl.value);
    }
  }
  if (!MaweDom.cueListSettingsPanel?.hidden && !MaweDom.cueListSettings?.contains(event.target)) {
    MaweSettingsPanels.setCueListSettingsPanelOpen(false);
  }
  if (!MaweDom.waveformSettingsPanel?.hidden && !MaweDom.waveformSettings?.contains(event.target)) {
    MaweSettingsPanels.setWaveformSettingsPanelOpen(false);
  }
  if (!MaweDom.cueEditorSettingsPanel?.hidden && !MaweDom.cueEditorSettings?.contains(event.target)) {
    MaweSettingsPanels.setCueEditorSettingsPanelOpen(false);
  }
  if (!MaweDom.mergeJoinSettingsPanel?.hidden && !MaweDom.mergeJoinSettings?.contains(event.target)) {
    MaweSettingsPanels.setMergeJoinSettingsPanelOpen(false);
  }
  if (!MaweDom.splitTrimSettingsPanel?.hidden && !MaweDom.splitTrimSettings?.contains(event.target)) {
    MaweSettingsPanels.setSplitTrimSettingsPanelOpen(false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!MaweDom.cueListSettingsPanel?.hidden) {
    MaweSettingsPanels.setCueListSettingsPanelOpen(false);
    MaweDom.cueListSettingsToggle?.focus();
  }
  if (!MaweDom.waveformSettingsPanel?.hidden) {
    MaweSettingsPanels.setWaveformSettingsPanelOpen(false);
    MaweDom.waveformSettingsToggle?.focus();
  }
  if (!MaweDom.cueEditorSettingsPanel?.hidden) {
    MaweSettingsPanels.setCueEditorSettingsPanelOpen(false);
    MaweDom.cueEditorSettingsToggle?.focus();
  }
  if (!MaweDom.mergeJoinSettingsPanel?.hidden) {
    MaweSettingsPanels.setMergeJoinSettingsPanelOpen(false);
    MaweDom.mergeJoinSettingsToggle?.focus();
  }
  if (!MaweDom.splitTrimSettingsPanel?.hidden) {
    MaweSettingsPanels.setSplitTrimSettingsPanelOpen(false);
    MaweDom.splitTrimSettingsToggle?.focus();
  }
});
window.addEventListener('resize', MaweSettingsPanels.positionMergeJoinSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionMergeJoinSettingsPanel, true);
window.addEventListener('resize', MaweSettingsPanels.positionSplitTrimSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionSplitTrimSettingsPanel, true);
window.addEventListener('resize', MaweSettingsPanels.positionCueListSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionCueListSettingsPanel, true);
window.addEventListener('resize', MaweSettingsPanels.positionWaveformSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionWaveformSettingsPanel, true);
window.addEventListener('resize', MaweSettingsPanels.positionCueEditorSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionCueEditorSettingsPanel, true);
MaweDom.cueListSettings?.closest('.cue-list-toolbar')?.addEventListener(
  'scroll', MaweSettingsPanels.positionCueListSettingsPanel,
);
MaweDom.waveformSettings?.closest('.waveform-toolbar')?.addEventListener(
  'scroll', MaweSettingsPanels.positionWaveformSettingsPanel,
);
MaweDom.cueEditorSettings?.closest('.cue-editor-toolbar')?.addEventListener(
  'scroll', MaweSettingsPanels.positionCueEditorSettingsPanel,
);
// 帮助浮窗：与拼合字幕共用 createFloatingPanel（拖动、位置持久化、Esc 关闭）
const helpFloatingPanel = MaweFloatingPanel.createFloatingPanel({
  panel: MaweDom.helpPanel,
  dragHandle: MaweDom.helpDragHandle,
  manageButton: MaweDom.helpToggle,
  anchorButton: MaweDom.helpToggle,
  positionKey: MaweDom.HELP_PANEL_POSITION_KEY,
  onOpen: restoreHelpPanelSize,
});
// 帮助是非模态浮窗；鼠标点击后的按钮焦点由统一的快捷键焦点处理释放。
MaweDom.helpCloseButton?.addEventListener('click', () => helpFloatingPanel.close());
MaweDom.helpOpenWaveformSettingsButtons.forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    MaweSettingsPanels.setWaveformSettingsPanelOpen(true);
    MaweDom.waveformSettingsToggle?.focus();
  });
});
// 帮助中的「全局设置」入口：打开设置窗口并定位到「视频预览」分区。
function openEditorSettingsAtTab(tabId) {
  MaweSettingsPanels.setEditorSettingsPanelOpen(true);
  MaweSettingsPanels.setEditorSettingsActiveTab(document.getElementById(tabId), { focus: true });
}
MaweDom.exportOpenSubtitleColorSettingsButton?.addEventListener('click', (event) => {
  event.preventDefault();
  openEditorSettingsAtTab('editor-settings-tab-subtitle-color');
});
MaweDom.splitMultiSubtitleSettingsLink?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  MaweDom.multiSubtitleSettingsToggle?.click();
  MaweDom.multiSubtitleSettingsToggle?.focus();
});
MaweDom.helpOpenMediaSettingsButtons.forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    openEditorSettingsAtTab('editor-settings-tab-subtitle-preview');
  });
});
MaweDom.helpOpenGapRemovePanelButton?.addEventListener('click', (event) => {
  event.preventDefault();
  openGapRemovePanel();
  MaweDom.gapRemoveManageButton?.focus();
});
function visibleHelpTabButtons() {
  return MaweDom.helpTabButtons.filter((button) => !button.closest('[hidden]'));
}

function selectHelpTab(tabName, { focus = false } = {}) {
  const activeButton = MaweDom.helpTabButtons.find((button) => button.dataset.helpTab === tabName);
  if (!activeButton) return;
  MaweDom.helpTabButtons.forEach((button) => {
    const active = button === activeButton;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  MaweDom.helpTabPanels.forEach((panel) => {
    const active = panel.dataset.helpTabPanel === tabName;
    panel.hidden = !active;
    panel.setAttribute('aria-hidden', String(!active));
  });
  if (focus) activeButton.focus();
}

MaweDom.helpTabButtons.forEach((button) => {
  button.addEventListener('click', () => selectHelpTab(button.dataset.helpTab));
  button.addEventListener('keydown', (event) => {
    const availableButtons = visibleHelpTabButtons();
    const index = availableButtons.indexOf(button);
    if (index < 0) return;
    let nextIndex = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % availableButtons.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + availableButtons.length) % availableButtons.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = availableButtons.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    selectHelpTab(availableButtons[nextIndex].dataset.helpTab, { focus: true });
  });
});
if (MaweDom.helpTabButtons.length && MaweDom.helpTabPanels.length) {
  selectHelpTab(MaweDom.helpTabButtons.find((button) => button.getAttribute('aria-selected') === 'true')?.dataset.helpTab || MaweDom.helpTabButtons[0].dataset.helpTab);
}
function openHelpAtTab(tabName) {
  if (!MaweDom.helpTabButtons.some((button) => button.dataset.helpTab === tabName)) return;
  selectHelpTab(tabName);
  helpFloatingPanel.open();
}
MaweDom.contextualHelpButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.closest('#gap-remove-panel')) closeGapRemovePanel();
    if (button.closest('#waveform-settings-panel')) MaweSettingsPanels.setWaveformSettingsPanelOpen(false);
    openHelpAtTab(button.dataset.helpTabTarget);
  });
});
// 浮窗尺寸：仅在用户拖过右下角缩放手柄后持久化；未缩放时保持 CSS 默认宽度/自动高度
function restoreHelpPanelSize() {
  if (!MaweDom.helpPanel) return;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(MaweDom.HELP_PANEL_SIZE_KEY) || 'null');
  } catch (_) {
    saved = null;
  }
  if (!Number.isFinite(saved?.width) || !Number.isFinite(saved?.height)) return;
  MaweDom.helpPanel.style.width = `${Math.min(Math.max(400, saved.width), window.innerWidth - 12)}px`;
  MaweDom.helpPanel.style.height = `${Math.min(Math.max(240, saved.height), window.innerHeight - 12)}px`;
}
let helpPanelSizeSaveTimer = 0;
if (MaweDom.helpPanel) {
  new ResizeObserver(() => {
    if (!MaweDom.helpPanel.classList.contains('show')) return;
    if (!MaweDom.helpPanel.style.width && !MaweDom.helpPanel.style.height) return;
    clearTimeout(helpPanelSizeSaveTimer);
    helpPanelSizeSaveTimer = setTimeout(() => {
      const rect = MaweDom.helpPanel.getBoundingClientRect();
      try {
        localStorage.setItem(MaweDom.HELP_PANEL_SIZE_KEY, JSON.stringify({
          width: Math.round(rect.width), height: Math.round(rect.height),
        }));
      } catch (_) {
        // file:// 隐私模式下 localStorage 可能被拒；缩放本身仍可用。
      }
    }, 250);
  }).observe(MaweDom.helpPanel);
}

// 明暗主题与界面强调色：令牌全部定义在 CSS，
// 这里只负责解析偏好、写 <html> 数据属性、持久化，以及通知波形重绘画布。
const EDITOR_THEME_VALUES = Object.freeze(['light', 'dark', 'system']);
const EDITOR_ACCENT_COLOR_DEBOUNCE_MS = 160;
function normalizeEditorTheme(theme) {
  return EDITOR_THEME_VALUES.includes(theme) ? theme : 'dark';
}
function resolveEditorTheme(theme) {
  const preference = normalizeEditorTheme(theme);
  if (preference !== 'system') return preference;
  const media = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  return media ? (media.matches ? 'dark' : 'light') : 'dark';
}
function refreshEditorThemeOptions(theme) {
  const preference = normalizeEditorTheme(theme);
  MaweDom.editorThemeOptions.forEach((option) => {
    const active = option.dataset.editorTheme === preference;
    option.classList.toggle('active', active);
    option.setAttribute('aria-pressed', String(active));
  });
}
function refreshEditorAccentOptions(accentColor) {
  const preference = MaweSettings.normalizeEditorAccentColor(accentColor);
  MaweDom.editorAccentOptions.forEach((option) => {
    const active = option.dataset.editorAccent === preference;
    option.classList.toggle('active', active);
    option.setAttribute('aria-pressed', String(active));
  });
}
function applyEditorAccentColor(accentColor, { rerenderWaveform = true } = {}) {
  const preference = MaweSettings.normalizeEditorAccentColor(accentColor);
  const customColor = MaweSettings.normalizeEditorAccentCustomColor(MaweSettings.EDITOR_SETTINGS.accentColorCustom);
  const root = document.documentElement;
  root.dataset.accent = preference;
  if (preference === 'custom') root.style.setProperty('--accent-custom', customColor);
  else root.style.removeProperty('--accent-custom');
  refreshEditorAccentOptions(preference);
  if (MaweDom.editorAccentCustomField) MaweDom.editorAccentCustomField.hidden = preference !== 'custom';
  if (MaweDom.editorAccentCustomInput) MaweDom.editorAccentCustomInput.value = customColor;
  if (MaweDom.editorAccentCustomValue) MaweDom.editorAccentCustomValue.textContent = customColor;
  // 波形画布颜色是 JS 读取的令牌快照，强调色切换后同样需要重绘。
  if (rerenderWaveform && MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.render();
}
let editorAccentCustomColorTimer = 0;
let pendingEditorAccentCustomColor = null;
function flushEditorAccentCustomColor(value = MaweDom.editorAccentCustomInput?.value) {
  if (editorAccentCustomColorTimer) {
    window.clearTimeout(editorAccentCustomColorTimer);
    editorAccentCustomColorTimer = 0;
  }
  const customColor = MaweSettings.normalizeEditorAccentCustomColor(value);
  pendingEditorAccentCustomColor = null;
  MaweSettings.updateEditorSettings({ accentColor: 'custom', accentColorCustom: customColor });
  applyEditorAccentColor('custom');
}
function scheduleEditorAccentCustomColor(value) {
  pendingEditorAccentCustomColor = MaweSettings.normalizeEditorAccentCustomColor(value);
  if (editorAccentCustomColorTimer) window.clearTimeout(editorAccentCustomColorTimer);
  editorAccentCustomColorTimer = window.setTimeout(() => {
    editorAccentCustomColorTimer = 0;
    const customColor = pendingEditorAccentCustomColor;
    pendingEditorAccentCustomColor = null;
    if (customColor) flushEditorAccentCustomColor(customColor);
  }, EDITOR_ACCENT_COLOR_DEBOUNCE_MS);
}
function applyTheme(theme, { rerenderWaveform = true } = {}) {
  const preference = normalizeEditorTheme(theme);
  const resolved = resolveEditorTheme(preference);
  if (resolved === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  refreshEditorThemeOptions(preference);
  // 画布颜色是 JS 读取的令牌快照，必须全量重绘才能跟随主题
  if (rerenderWaveform && MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.render();
}
applyEditorAccentColor(MaweSettings.EDITOR_SETTINGS.accentColor, { rerenderWaveform: false });
applyTheme(MaweSettings.EDITOR_SETTINGS.theme, { rerenderWaveform: false });
MaweDom.editorThemeOptions.forEach((option) => {
  option.addEventListener('click', () => {
    const next = normalizeEditorTheme(option.dataset.editorTheme);
    MaweSettings.updateEditorSettings({ theme: next });
    applyTheme(next);
  });
});
MaweDom.editorAccentOptions.forEach((option) => {
  option.addEventListener('click', () => {
    if (pendingEditorAccentCustomColor !== null) flushEditorAccentCustomColor();
    const next = MaweSettings.normalizeEditorAccentColor(option.dataset.editorAccent);
    MaweSettings.updateEditorSettings({ accentColor: next });
    applyEditorAccentColor(next);
  });
});
MaweDom.editorAccentCustomInput?.addEventListener('input', () => {
  const customColor = MaweSettings.normalizeEditorAccentCustomColor(MaweDom.editorAccentCustomInput.value);
  if (MaweDom.editorAccentCustomValue) MaweDom.editorAccentCustomValue.textContent = customColor;
  scheduleEditorAccentCustomColor(customColor);
});
MaweDom.editorAccentCustomInput?.addEventListener('change', () => {
  flushEditorAccentCustomColor(MaweDom.editorAccentCustomInput.value);
});
const editorSystemThemeMedia = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const refreshEditorSystemTheme = () => {
  if (MaweSettings.EDITOR_SETTINGS.theme === 'system') applyTheme('system');
};
if (editorSystemThemeMedia?.addEventListener) {
  editorSystemThemeMedia.addEventListener('change', refreshEditorSystemTheme);
} else {
  editorSystemThemeMedia?.addListener?.(refreshEditorSystemTheme);
}
MaweDom.splitKeySel.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ splitKey: MaweDom.splitKeySel.value });
  MaweSplitMode.refreshSplitKeyHelp();
});
MaweDom.splitUseWordTimestampsToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ splitUseWordTimestamps: MaweDom.splitUseWordTimestampsToggle.checked });
});
MaweDom.multiSubtitleSplitAutoSubmit?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ splitAutoSubmit: MaweDom.multiSubtitleSplitAutoSubmit.checked });
});
if (MaweDom.mergeJoinTextContinuousInput) MaweDom.mergeJoinTextContinuousInput.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ mergeJoinTextContinuous: MaweDom.mergeJoinTextContinuousInput.value });
});
if (MaweDom.mergeJoinTextWordInput) MaweDom.mergeJoinTextWordInput.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ mergeJoinTextWord: MaweDom.mergeJoinTextWordInput.value });
});
MaweSplitTrim.renderSplitTrimSymbolGrid();
MaweSplitTrim.refreshSplitTrimExtraInput();
MaweSplitTrim.splitTrimExtraInput?.addEventListener('change', () => {
  const extras = MULTI_SUBTITLE_UTILS.parseSplitTrimSymbolInput(MaweSplitTrim.splitTrimExtraInput.value);
  MaweSplitTrim.persistSplitTrimSymbols([...MaweSplitTrim.splitTrimPrimaryCheckedSet(), ...extras]);
  MaweSplitTrim.refreshSplitTrimExtraInput();
});
MaweSplitTrim.splitTrimSymbolsReset?.addEventListener('click', () => {
  const defaults = MULTI_SUBTITLE_UTILS.setSplitTrimSymbols(
    [...MULTI_SUBTITLE_UTILS.DEFAULT_SPLIT_TRIM_SYMBOLS],
  );
  MaweSettings.updateEditorSettings({ splitTrimSymbols: defaults });
  MaweSplitTrim.renderSplitTrimSymbolGrid();
  MaweSplitTrim.refreshSplitTrimExtraInput();
});
// 拼合字幕工具窗：参数即时持久化；number 输入 change 时把显示值回钳到合法区间。
const autoMergeFloatingPanel = MaweFloatingPanel.createFloatingPanel({
  panel: MaweDom.autoMergePanel,
  dragHandle: MaweDom.autoMergeDragHandle,
  manageButton: MaweDom.autoMergeManageButton,
  anchorButton: MaweDom.autoMergeManageButton,
  positionKey: MaweDom.AUTO_MERGE_PANEL_POSITION_KEY,
  onOpen: syncAutoMergePanelInputs,
});
MaweDom.autoMergeCloseButton?.addEventListener('click', () => autoMergeFloatingPanel.close());
MaweDom.autoMergeRunButton?.addEventListener('click', autoMergeSegments);
MaweDom.autoMergeGapMsInput?.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ autoMergeGapMs: MaweSettings.clampAutoMergeGapMs(MaweDom.autoMergeGapMsInput.value) });
});
MaweDom.autoMergeGapMsInput?.addEventListener('change', () => {
  MaweDom.autoMergeGapMsInput.value = String(MaweSettings.EDITOR_SETTINGS.autoMergeGapMs);
});
MaweDom.autoMergeSnapDirectionSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({
    autoMergeSnapDirection: MaweDom.autoMergeSnapDirectionSelect.value === 'forward' ? 'forward' : 'backward',
  });
});
MaweDom.autoMergeAbsorbShortToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ autoMergeAbsorbShort: MaweDom.autoMergeAbsorbShortToggle.checked });
  syncAutoMergeAbsorbFields();
});
MaweDom.autoMergeShortCountInput?.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ autoMergeShortCount: MaweSettings.clampAutoMergeShortCount(MaweDom.autoMergeShortCountInput.value) });
});
MaweDom.autoMergeShortCountInput?.addEventListener('change', () => {
  MaweDom.autoMergeShortCountInput.value = String(MaweSettings.EDITOR_SETTINGS.autoMergeShortCount);
});
MaweDom.autoMergeAbsorbDirectionSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({
    autoMergeAbsorbDirection: MaweDom.autoMergeAbsorbDirectionSelect.value === 'next' ? 'next' : 'previous',
  });
});
MaweDom.autoMergePanel?.querySelectorAll('input[type="number"]').forEach((input) => {
  input.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    try {
      if (event.deltaY < 0) input.stepUp();
      else input.stepDown();
    } catch (_) {
      return;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });
});
const subtitleExtendFloatingPanel = MaweFloatingPanel.createFloatingPanel({
  panel: MaweDom.subtitleExtendPanel,
  dragHandle: MaweDom.subtitleExtendDragHandle,
  manageButton: MaweDom.subtitleExtendManageButton,
  anchorButton: MaweDom.subtitleExtendManageButton,
  positionKey: MaweDom.SUBTITLE_EXTEND_PANEL_POSITION_KEY,
});
MaweDom.subtitleExtendCloseButton?.addEventListener('click', () => subtitleExtendFloatingPanel.close());
MaweDom.subtitleExtendRunButton?.addEventListener('click', extendSubtitleRanges);
MaweDom.subtitleExtendPanel?.querySelectorAll('input[type="number"]').forEach((input) => {
  input.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    try {
      if (event.deltaY < 0) input.stepUp();
      else input.stepDown();
    } catch (_) {
      return;
    }
  }, { passive: false });
});
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowIndexToggle, 'cueListShowIndex');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowTimeToggle, 'cueListShowTime');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowStickerToggle, 'cueListShowSticker');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowCharcountToggle, 'cueListShowCharcount');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListAutoScrollOnClickToggle, 'cueListAutoScrollOnClick');
MaweDom.cueListKeepSplitVisibleToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ cueListKeepSplitVisible: MaweDom.cueListKeepSplitVisibleToggle.checked });
  if (!MaweDom.cueListKeepSplitVisibleToggle.checked) clearTemporaryVisibleSplitCues();
  applySearch(MaweDom.searchEl.value);
});
MaweDom.cueListCharcountThresholdInput?.addEventListener('input', () => {
  handleCharCountThresholdInput(MaweDom.cueListCharcountThresholdInput);
});
MaweDom.cueListCharcountThresholdInput?.addEventListener('change', () => {
  syncCharCountThresholdInputs();
  updateTimedTextEditSingleGuide();
});
MaweDom.timedTextEditCharcountThresholdInput?.addEventListener('input', () => {
  handleCharCountThresholdInput(MaweDom.timedTextEditCharcountThresholdInput);
});
MaweDom.timedTextEditCharcountThresholdInput?.addEventListener('change', () => {
  syncCharCountThresholdInputs();
  updateTimedTextEditSingleGuide();
});
MaweDisplaySettings.bindCueEditorDisplayToggle(MaweDom.cueEditorShowNavigationToggle, 'cueEditorShowNavigation');
MaweDisplaySettings.bindCueEditorDisplayToggle(MaweDom.cueEditorShowTimeActionsToggle, 'cueEditorShowTimeActions');
MaweDisplaySettings.bindCueEditorDisplayToggle(MaweDom.cueEditorShowStickerToggle, 'cueEditorShowSticker');
MaweDom.exportStartAtZeroToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportStartAtZero: MaweDom.exportStartAtZeroToggle.checked });
});
MaweDom.selectGroupMembersToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ selectGroupMembers: MaweDom.selectGroupMembersToggle.checked });
});
MaweDom.exportColorUnifiedToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportColorUnified: MaweDom.exportColorUnifiedToggle.checked });
});
MaweDom.exportSpeakerLabelsToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportSpeakerLabels: MaweDom.exportSpeakerLabelsToggle.checked });
});
MaweDom.exportSpeakerNamesAsSuffixToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportSpeakerNamesAsSuffix: MaweDom.exportSpeakerNamesAsSuffixToggle.checked });
});
MaweDom.clickBehaviorSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ clickBehavior: MaweSettings.normalizeClickBehavior(MaweDom.clickBehaviorSelect.value) });
  refreshClickBehaviorHint();
});
MaweDom.clickTargetSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ clickTarget: MaweSettings.normalizeClickTarget(MaweDom.clickTargetSelect.value) });
});
MaweDom.keyboardOperationReferenceSelect?.addEventListener('change', () => {
  const mode = MaweSettings.normalizeKeyboardOperationReferenceMode(MaweDom.keyboardOperationReferenceSelect.value);
  MaweSettings.updateEditorSettings({ keyboardOperationReference: mode });
  refreshKeyboardOperationReferenceHint();
});
MaweJklPlayback.jklPlaybackModeSelect?.addEventListener('change', () => {
  const wasReversePlaying = MaweJklPlayback.jklReversePlaying;
  MaweSettings.updateEditorSettings({ jklPlaybackMode: MaweSettings.normalizeJklPlaybackMode(MaweJklPlayback.jklPlaybackModeSelect.value) });
  MaweJklPlayback.stopJklReversePlayback({ render: false });
  MaweJklPlayback.jklPlaybackRate = 1;
  MaweCoreState.player.playbackRate = 1;
  if (wasReversePlaying) MawePlaybackLoop.update();
  MaweMediaPlayback.syncMediaControls();
  MaweJklPlayback.refreshJklPlaybackModeUi();
});
MaweDom.hoverSeekPreviewToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ hoverSeekPreview: MaweDom.hoverSeekPreviewToggle.checked });
});
function timelineMediaSeekStepValue() {
  return timelineIsFrameMode()
    ? MaweSettings.EDITOR_SETTINGS.mediaSeekStepFrames : MaweSettings.EDITOR_SETTINGS.mediaSeekStepMs;
}

function timelineCueMoveStepValue() {
  return timelineIsFrameMode()
    ? MaweSettings.EDITOR_SETTINGS.cueMoveStepFrames : MaweSettings.EDITOR_SETTINGS.cueMoveStepMs;
}

function timelineValueToMilliseconds(value) {
  const timebase = projectTimebase();
  return timebase.unit === 'frames'
    ? millisecondsFromFrameNumber(value, timebase.fps) : Number(value);
}

function timelineFrameAlignedMilliseconds(valueMs) {
  const numeric = Number(valueMs);
  if (!Number.isFinite(numeric) || !timelineIsFrameMode()) return numeric;
  const timebase = projectTimebase();
  return millisecondsFromFrameNumber(
    frameNumberFromMilliseconds(numeric, timebase.fps),
    timebase.fps,
  );
}

function timelineUiText(zh, en) {
  return window.MAWE_I18N?.language === 'en' ? en : zh;
}

function timelineMediaSeekStepMilliseconds() {
  return timelineValueToMilliseconds(timelineMediaSeekStepValue());
}

function timelineHasSubtitleData() {
  return (Array.isArray(MaweBoot.DATA?.segments) && MaweBoot.DATA.segments.length > 0)
    || (Array.isArray(MaweBoot.DATA?.multi_subtitle?.tracks)
      && MaweBoot.DATA.multi_subtitle.tracks.some((track) => Array.isArray(track?.segments)
        && track.segments.length > 0));
}

function confirmTimelineFrameRemap(current, nextUnit, nextFps) {
  const enteringFrames = current.unit !== 'frames' && nextUnit === 'frames';
  const changingFrameRate = current.unit === 'frames' && current.fps !== nextFps;
  if ((!enteringFrames && !changingFrameRate) || !timelineHasSubtitleData()) return true;
  const message = enteringFrames
    ? timelineUiText(
      `切换到帧时间基准（${nextFps} FPS）会批量将当前工程的所有字幕段、字词和副字幕时间映射到最近帧，并重写毫秒兼容值。原始的非帧对齐毫秒值无法在切回毫秒时恢复。是否继续？`,
      `Switching to the frame timebase (${nextFps} FPS) will remap all subtitle segments, word timings, and secondary subtitle timings to frame boundaries and rewrite the compatible millisecond values. Original non-frame-aligned millisecond values cannot be restored when switching back. Continue?`,
    )
    : timelineUiText(
      `将 FPS 从 ${current.fps} 改为 ${nextFps} 会批量重新映射当前工程的所有字幕段、字词和副字幕时间，并重写毫秒兼容值。原始的非帧对齐毫秒值无法恢复。是否继续？`,
      `Changing FPS from ${current.fps} to ${nextFps} will remap all subtitle segments, word timings, and secondary subtitle timings and rewrite the compatible millisecond values. Original non-frame-aligned millisecond values cannot be restored. Continue?`,
    );
  return window.confirm(message);
}

function refreshTimelineSettingsUi() {
  const timebase = projectTimebase();
  const frameMode = timebase.unit === 'frames';
  const separator = normalizeTimelineTimecodeSeparator(MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator);
  if (MaweDom.timelineTimebaseSelect) MaweDom.timelineTimebaseSelect.value = timebase.unit;
  if (MaweDom.timelineFpsInput) MaweDom.timelineFpsInput.value = String(timebase.fps);
  if (MaweDom.timelineSnapToFrameToggle) {
    MaweDom.timelineSnapToFrameToggle.checked = frameMode && MaweSettings.EDITOR_SETTINGS.timelineSnapToFrame;
    MaweDom.timelineSnapToFrameToggle.disabled = !frameMode;
  }
  if (MaweDom.timelineTimecodeSeparatorInput) MaweDom.timelineTimecodeSeparatorInput.value = separator;
  if (MaweDom.mediaSeekStepInput) {
    MaweDom.mediaSeekStepInput.min = frameMode ? '1' : String(MaweSettings.MEDIA_SEEK_STEP_MIN_MS);
    MaweDom.mediaSeekStepInput.max = frameMode ? '240' : String(MaweSettings.MEDIA_SEEK_STEP_MAX_MS);
    MaweDom.mediaSeekStepInput.step = frameMode ? '1' : String(MaweSettings.mediaSeekStepForValue(MaweSettings.EDITOR_SETTINGS.mediaSeekStepMs));
    MaweDom.mediaSeekStepInput.value = String(timelineMediaSeekStepValue());
  }
  if (MaweDom.cueMoveStepInput) {
    MaweDom.cueMoveStepInput.min = frameMode ? '1' : String(MaweSettings.CUE_MOVE_STEP_MIN_MS);
    MaweDom.cueMoveStepInput.max = frameMode ? '240' : String(MaweSettings.CUE_MOVE_STEP_MAX_MS);
    MaweDom.cueMoveStepInput.step = frameMode ? '1' : '10';
    MaweDom.cueMoveStepInput.value = String(timelineCueMoveStepValue());
  }
  if (MaweDom.mediaSeekStepUnit) MaweDom.mediaSeekStepUnit.textContent = frameMode ? 'F' : 'ms';
  if (MaweDom.cueMoveStepUnit) MaweDom.cueMoveStepUnit.textContent = frameMode ? 'F' : 'ms';
  if (MaweDom.mediaSeekStepHint) {
    MaweDom.mediaSeekStepHint.textContent = frameMode
      ? timelineUiText(
        `控制按钮和左右方向键的每次跳转帧数（当前 FPS：${timebase.fps}）。`,
        `Number of frames jumped by the controls and left/right arrow keys (current FPS: ${timebase.fps}).`,
      )
      : timelineUiText(
        '控制按钮和左右方向键的每次跳转时长（单位：ms）。',
        'Duration for each jump from the controls and left/right arrow keys (unit: ms).',
      );
  }
  if (MaweDom.cueMoveStepHint) {
    MaweDom.cueMoveStepHint.textContent = frameMode
      ? timelineUiText(
        '方向键和按住字幕块/边界时按帧微调；具体用法详见帮助的「微调字幕」区。',
        'Arrow keys and A/D fine-tune frame by frame while holding a cue/block or boundary; see the “Subtitle fine-tuning” section in Help for details.',
      )
      : timelineUiText(
        '具体用法详见帮助的「微调字幕」区。',
        'See the “Subtitle fine-tuning” section in Help for details.',
      );
  }
  if (MaweDom.timelineTimebaseHint) {
    MaweDom.timelineTimebaseHint.textContent = frameMode
      ? timelineUiText(
        `帧模式使用 HH:MM:SS${separator}FF 显示，FF 为当前秒内的帧号；当前 FPS：${timebase.fps}。`,
        `Frame mode uses HH:MM:SS${separator}FF, where FF is the frame number within the current second; current FPS: ${timebase.fps}.`,
      )
      : timelineUiText(
        '毫秒模式保持原有时间编辑方式。切换为帧模式后，拖动、方向键和 A/D 微调都会按帧执行。',
        'Millisecond mode keeps the existing timing behavior. Switching to frame mode makes dragging, arrow keys, and A/D fine-tuning operate frame by frame.',
      );
  }
  if (MaweDom.timelineSnapToFrameHint) {
    MaweDom.timelineSnapToFrameHint.textContent = frameMode
      ? timelineUiText(
        '启用后，波形鼠标指针会吸附到最近的帧位置。',
        'When enabled, the waveform pointer snaps to the nearest frame.',
      )
      : timelineUiText(
        '仅帧模式生效；切换到帧模式后可启用。',
        'Only active in frame mode; switch to frame mode to enable it.',
      );
  }
  if (MaweDom.timelineTimecodeSeparatorHint) {
    MaweDom.timelineTimecodeSeparatorHint.textContent = timelineUiText(
      `帧时间码示例：HH:MM:SS${separator}FF；只替换秒与帧之间的分隔符。`,
      `Frame timecode example: HH:MM:SS${separator}FF; only the separator between seconds and frames changes.`,
    );
  }
  MaweDom.mediaSeekInputLastValue = timelineMediaSeekStepValue();
  MaweMediaPlayback.refreshMediaSeekStepHelp();
  MaweMediaPlayback.refreshMediaSeekControlLabels();
}

function setTimelineTimebase(patch = {}) {
  const current = projectTimebase();
  const nextUnit = patch.unit === 'frames' || patch.unit === 'milliseconds'
    ? patch.unit : current.unit;
  const hasFpsPatch = Object.prototype.hasOwnProperty.call(patch, 'fps');
  const mediaDefaultFps = !timelineFpsManuallySet
    && !hasFpsPatch
    && current.unit !== 'frames'
    && nextUnit === 'frames'
    ? projectMediaVideoFps()
    : null;
  const nextFps = mediaDefaultFps ?? normalizeTimelineFps(patch.fps, current.fps);
  if (current.unit === nextUnit && current.fps === nextFps) {
    if (hasFpsPatch) timelineFpsManuallySet = true;
    refreshTimelineSettingsUi();
    return;
  }
  if (!confirmTimelineFrameRemap(current, nextUnit, nextFps)) {
    refreshTimelineSettingsUi();
    return;
  }
  if (hasFpsPatch) timelineFpsManuallySet = true;
  // 先按旧时间基准把当前工程的双份时间值同步，再决定新 FPS 下是否保留帧号。
  syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: current.unit === 'frames' });
  MaweBoot.DATA.timebase = { unit: nextUnit, fps: nextFps };
  // 变更 FPS 时保持媒体中的实际时间位置，再按新 FPS 重算独立帧字段；
  // 否则同一个帧号会因 FPS 改变而把字幕整体提前或推后。
  syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
  MaweServerSave.projectImportDirty = true;
  refreshTimelineSettingsUi();
  renderAll({ waveform: 'full' });
  MaweServerSave.scheduleAutoSaveFlush();
  const description = nextUnit === 'frames'
    ? timelineUiText(`已切换到帧时间基准（${nextFps} FPS）`, `Switched to frame timebase (${nextFps} FPS)`)
    : timelineUiText('已切换到毫秒时间基准', 'Switched to millisecond timebase');
  MaweHint.flashHint(description, 'success');
}

function refreshMediaSeekInputStep(value = timelineMediaSeekStepValue()) {
  if (!MaweDom.mediaSeekStepInput) return;
  if (timelineIsFrameMode()) {
    MaweDom.mediaSeekStepInput.min = '1';
    MaweDom.mediaSeekStepInput.max = '240';
    MaweDom.mediaSeekStepInput.step = '1';
  } else {
    MaweDom.mediaSeekStepInput.min = String(MaweSettings.MEDIA_SEEK_STEP_MIN_MS);
    MaweDom.mediaSeekStepInput.max = String(MaweSettings.MEDIA_SEEK_STEP_MAX_MS);
    MaweDom.mediaSeekStepInput.step = String(MaweSettings.mediaSeekStepForValue(value));
  }
}

function commitMediaSeekStepInput(value, { rewriteInput = true } = {}) {
  const frameMode = timelineIsFrameMode();
  const normalized = frameMode
    ? EDITOR_SETTINGS_UTILS.clampTimelineFrameStep(value, 1)
    : MaweSettings.clampMediaSeekStepMs(value);
  if (rewriteInput && MaweDom.mediaSeekStepInput) MaweDom.mediaSeekStepInput.value = String(normalized);
  MaweDom.mediaSeekInputLastValue = normalized;
  MaweSettings.updateEditorSettings(frameMode
    ? { mediaSeekStepFrames: normalized }
    : { mediaSeekStepMs: normalized });
  refreshMediaSeekInputStep(normalized);
  MaweMediaPlayback.refreshMediaSeekStepHelp();
  MaweMediaPlayback.refreshMediaSeekControlLabels();
}

function adjustMediaSeekStepInput(direction) {
  if (!MaweDom.mediaSeekStepInput) return;
  if (timelineIsFrameMode()) {
    const current = EDITOR_SETTINGS_UTILS.clampTimelineFrameStep(MaweDom.mediaSeekStepInput.value, 1);
    commitMediaSeekStepInput(Math.min(240, Math.max(1, current + (direction < 0 ? -1 : 1))));
    return;
  }
  const current = MaweSettings.clampMediaSeekStepMs(MaweDom.mediaSeekStepInput.value);
  commitMediaSeekStepInput(MaweSettings.nextMediaSeekStepValue(current, direction));
}

MaweDom.mediaSeekStepInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  event.stopPropagation();
  adjustMediaSeekStepInput(event.key === 'ArrowUp' ? 1 : -1);
});
MaweDom.mediaSeekStepInput?.addEventListener('wheel', (event) => {
  if (!event.deltaY) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDom.mediaSeekStepInput.focus({ preventScroll: true });
  adjustMediaSeekStepInput(event.deltaY < 0 ? 1 : -1);
}, { passive: false });
MaweDom.mediaSeekStepInput?.addEventListener('input', () => {
  const raw = MaweDom.mediaSeekStepInput.value.trim();
  if (!raw) return;
  if (timelineIsFrameMode()) {
    commitMediaSeekStepInput(raw, { rewriteInput: false });
    return;
  }
  const value = MaweSettings.normalizeNativeMediaSeekStepValue(raw, MaweDom.mediaSeekInputLastValue);
  if (value === null) return;
  commitMediaSeekStepInput(value, { rewriteInput: value !== Number(raw) });
});
MaweDom.mediaSeekStepInput?.addEventListener('change', () => {
  commitMediaSeekStepInput(MaweDom.mediaSeekStepInput.value);
});
MaweDom.cueMoveStepInput?.addEventListener('change', () => {
  const frameMode = timelineIsFrameMode();
  const value = frameMode
    ? EDITOR_SETTINGS_UTILS.clampTimelineFrameStep(MaweDom.cueMoveStepInput.value, 1)
    : MaweSettings.clampCueMoveStepMs(MaweDom.cueMoveStepInput.value);
  MaweDom.cueMoveStepInput.value = String(value);
  MaweSettings.updateEditorSettings(frameMode ? { cueMoveStepFrames: value } : { cueMoveStepMs: value });
});
MaweDom.timelineTimebaseSelect?.addEventListener('change', () => {
  setTimelineTimebase({ unit: MaweDom.timelineTimebaseSelect.value });
});
MaweDom.timelineFpsInput?.addEventListener('change', () => {
  setTimelineTimebase({ fps: MaweDom.timelineFpsInput.value });
});
MaweDom.timelineSnapToFrameToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ timelineSnapToFrame: MaweDom.timelineSnapToFrameToggle.checked });
  MaweCoreState.waveformEditor?.refreshPointerLine?.();
});
MaweDom.timelineTimecodeSeparatorInput?.addEventListener('change', () => {
  const separator = normalizeTimelineTimecodeSeparator(MaweDom.timelineTimecodeSeparatorInput.value);
  MaweDom.timelineTimecodeSeparatorInput.value = separator;
  MaweSettings.updateEditorSettings({ timelineTimecodeSeparator: separator });
  refreshTimelineSettingsUi();
  MaweCoreState.waveformEditor?.refreshPointerLine?.();
  // 时间码分隔符会影响字幕列表里的时间范围文本；设置变更后立即重建列表，
  // 不必等到下一次字幕编辑操作才看到新格式。
  renderAll({ waveform: 'none' });
});
MaweDom.autoSnapAdjacentCuesToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ autoSnapAdjacentCues: MaweDom.autoSnapAdjacentCuesToggle.checked });
});
MaweDom.cueEditorCancelOnEscapeToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ cueEditorCancelOnEscape: MaweDom.cueEditorCancelOnEscapeToggle.checked });
});
MaweDom.ninjaModeToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaMode: MaweDom.ninjaModeToggle.checked });
  MaweNinja.applyNinjaSettings();
});
MaweDom.ninjaSoundToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSound: MaweDom.ninjaSoundToggle.checked });
});
MaweDom.ninjaSlashEffectToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSlashEffect: MaweDom.ninjaSlashEffectToggle.checked });
  MaweNinja.applyNinjaSettings();
});
MaweDom.ninjaSlashLengthInput?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSlashLengthPercent: MaweSettings.clampNinjaSlashLength(MaweDom.ninjaSlashLengthInput.value) });
  MaweDom.ninjaSlashLengthInput.value = String(MaweSettings.EDITOR_SETTINGS.ninjaSlashLengthPercent);
});
MaweDom.ninjaSlashRotateInput?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSlashRotateAmplitude: MaweSettings.clampNinjaSlashRotateAmplitude(MaweDom.ninjaSlashRotateInput.value) });
  MaweDom.ninjaSlashRotateInput.value = String(MaweSettings.EDITOR_SETTINGS.ninjaSlashRotateAmplitude);
});
MaweDom.subtitleFontSizeSelect?.addEventListener('change', () => {
  const value = MaweDom.subtitleFontSizeSelect.value;
  MaweHistory.pushPreviewUndo('调整字幕字号', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ font_size: value === 'auto' ? null : Number(value) });
});
MaweDom.subtitleFontFamilySelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整字幕字体', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ font_family: MaweDom.subtitleFontFamilySelect.value });
});
let subtitleBackgroundColorUndoPushed = false;
function applySubtitleBackgroundColorInput({ finalize = false } = {}) {
  if (!MaweDom.subtitleBackgroundColorInput) return;
  if (!subtitleBackgroundColorUndoPushed) {
    MaweHistory.pushPreviewUndo('调整字幕背景色', MaweHistory.snapshotPreviewState());
    subtitleBackgroundColorUndoPushed = true;
  }
  MaweAppearance.setSubtitleAppearance({ background_color: MaweDom.subtitleBackgroundColorInput.value });
  if (finalize) subtitleBackgroundColorUndoPushed = false;
}
MaweDom.subtitleBackgroundColorInput?.addEventListener('input', () => applySubtitleBackgroundColorInput());
MaweDom.subtitleBackgroundColorInput?.addEventListener('change', () => applySubtitleBackgroundColorInput({ finalize: true }));
let subtitleBackgroundAlphaUndoPushed = false;
function applySubtitleBackgroundAlphaInput({ finalize = false } = {}) {
  if (!MaweDom.subtitleBackgroundAlphaInput) return;
  if (!subtitleBackgroundAlphaUndoPushed) {
    MaweHistory.pushPreviewUndo('调整字幕背景不透明度', MaweHistory.snapshotPreviewState());
    subtitleBackgroundAlphaUndoPushed = true;
  }
  const alpha = Number(MaweDom.subtitleBackgroundAlphaInput.value);
  if (MaweDom.subtitleBackgroundAlphaValue && Number.isFinite(alpha)) {
    MaweDom.subtitleBackgroundAlphaValue.textContent = `${Math.round(alpha * 100)}%`;
  }
  MaweAppearance.setSubtitleAppearance({ background_alpha: alpha });
  if (finalize) subtitleBackgroundAlphaUndoPushed = false;
}
MaweDom.subtitleBackgroundAlphaInput?.addEventListener('input', () => applySubtitleBackgroundAlphaInput());
MaweDom.subtitleBackgroundAlphaInput?.addEventListener('change', () => applySubtitleBackgroundAlphaInput({ finalize: true }));
MaweDom.subtitleFontFamilyScanButton?.addEventListener('click', () => {
  void MaweAppearance.scanSubtitleLocalFonts();
});
document.addEventListener('mawe:languagechange', () => {
  MaweAppearance.renderSubtitleFontFamilyStatus();
  MaweAppearance.relabelSubtitleFontFamilyOptions();
});
MaweDom.subtitleColorInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整主字幕颜色', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ color: MaweDom.subtitleColorInput.value });
  MawePlaybackLoop.update();
});
MaweDom.subtitleColorUnderlineInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('切换预览字幕颜色下划线', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ color_underline: MaweDom.subtitleColorUnderlineInput.checked });
  MawePlaybackLoop.update();
});
MaweDom.subtitleColorStyleSelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整预览字幕颜色样式', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ color_style: MaweDom.subtitleColorStyleSelect.value });
  MawePlaybackLoop.update();
});
const speakerLabelUndoColors = new Set();
let speakerLabelSeparatorUndo = false;
function applySpeakerLabelInput(color, { finalize = false } = {}) {
  const input = MaweDom.subtitleSpeakerLabelInputs[color];
  if (!input) return;
  if (!speakerLabelUndoColors.has(color)) {
    MaweHistory.pushPreviewUndo('重命名说话人', MaweHistory.snapshotPreviewState());
    speakerLabelUndoColors.add(color);
  }
  const current = getSpeakerLabelSettings();
  setSpeakerLabelSettings({
    ...current,
    names: { ...current.names, [color]: input.value },
  });
  if (finalize) {
    speakerLabelUndoColors.delete(color);
    input.value = getSpeakerLabelSettings().names[color] || '';
  }
  MawePlaybackLoop.update();
}
Object.entries(MaweDom.subtitleSpeakerLabelInputs).forEach(([color, input]) => {
  input?.addEventListener('input', () => applySpeakerLabelInput(color));
  input?.addEventListener('change', () => applySpeakerLabelInput(color, { finalize: true }));
});
function applySpeakerLabelSeparatorInput({ finalize = false } = {}) {
  const input = MaweDom.subtitleSpeakerLabelSeparatorInput;
  if (!input) return;
  if (!speakerLabelSeparatorUndo) {
    MaweHistory.pushPreviewUndo('调整说话人分隔符', MaweHistory.snapshotPreviewState());
    speakerLabelSeparatorUndo = true;
  }
  const current = getSpeakerLabelSettings();
  setSpeakerLabelSettings({ ...current, separator: input.value });
  if (finalize) {
    speakerLabelSeparatorUndo = false;
    input.value = getSpeakerLabelSettings().separator;
  }
  MawePlaybackLoop.update();
}
MaweDom.subtitleSpeakerLabelSeparatorInput?.addEventListener('input', () => applySpeakerLabelSeparatorInput());
MaweDom.subtitleSpeakerLabelSeparatorInput?.addEventListener(
  'change',
  () => applySpeakerLabelSeparatorInput({ finalize: true }),
);
MaweDom.subtitleSpeakerMappingEnabledInput?.addEventListener('change', () => {
  const previous = MaweHistory.snapshotPreviewState();
  previous.speakerLabels.mapping_enabled = !MaweDom.subtitleSpeakerMappingEnabledInput.checked;
  MaweHistory.pushPreviewUndo('切换颜色说话人映射', previous);
  setSpeakerLabelSettings({
    ...getSpeakerLabelSettings(),
    mapping_enabled: MaweDom.subtitleSpeakerMappingEnabledInput.checked,
  });
  MawePlaybackLoop.update();
});
MaweDom.subtitleSpeakerLabelsEnabledInput?.addEventListener('change', () => {
  const previous = MaweHistory.snapshotPreviewState();
  previous.speakerLabels.enabled = !MaweDom.subtitleSpeakerLabelsEnabledInput.checked;
  MaweHistory.pushPreviewUndo('切换说话人名称预览', previous);
  setSpeakerLabelSettings({
    ...getSpeakerLabelSettings(),
    enabled: MaweDom.subtitleSpeakerLabelsEnabledInput.checked,
  });
  // 显示开关改变时同步 SRT 附加选项；导出开关仍可在全局设置中独立调整。
  const speakerLabelsEnabled = MaweDom.subtitleSpeakerLabelsEnabledInput.checked;
  MaweSettings.updateEditorSettings({ exportSpeakerLabels: speakerLabelsEnabled });
  if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = speakerLabelsEnabled;
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleFontSizeSelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕字号', MaweHistory.snapshotPreviewState());
  const value = MaweDom.extensionSubtitleFontSizeSelect.value;
  MaweAppearance.setExtensionSubtitleAppearance({ font_size: value === 'auto' ? null : Number(value) });
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleFontFamilySelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕字体', MaweHistory.snapshotPreviewState());
  MaweAppearance.setExtensionSubtitleAppearance({ font_family: MaweDom.extensionSubtitleFontFamilySelect.value });
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleColorInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕颜色', MaweHistory.snapshotPreviewState());
  MaweAppearance.setExtensionSubtitleAppearance({ color: MaweDom.extensionSubtitleColorInput.value });
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleBackgroundColorInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕背景色', MaweHistory.snapshotPreviewState());
  MaweAppearance.setExtensionSubtitleAppearance({ background_color: MaweDom.extensionSubtitleBackgroundColorInput.value });
  MawePlaybackLoop.update();
});
let extensionSubtitleBackgroundAlphaUndoPushed = false;
function applyExtensionSubtitleBackgroundAlphaInput({ finalize = false } = {}) {
  if (!MaweDom.extensionSubtitleBackgroundAlphaInput) return;
  if (!extensionSubtitleBackgroundAlphaUndoPushed) {
    MaweHistory.pushPreviewUndo('调整副字幕背景不透明度', MaweHistory.snapshotPreviewState());
    extensionSubtitleBackgroundAlphaUndoPushed = true;
  }
  const alpha = Number(MaweDom.extensionSubtitleBackgroundAlphaInput.value);
  if (MaweDom.extensionSubtitleBackgroundAlphaValue && Number.isFinite(alpha)) {
    MaweDom.extensionSubtitleBackgroundAlphaValue.textContent = `${Math.round(alpha * 100)}%`;
  }
  MaweAppearance.setExtensionSubtitleAppearance({ background_alpha: alpha });
  if (finalize) extensionSubtitleBackgroundAlphaUndoPushed = false;
}
MaweDom.extensionSubtitleBackgroundAlphaInput?.addEventListener('input', () => applyExtensionSubtitleBackgroundAlphaInput());
MaweDom.extensionSubtitleBackgroundAlphaInput?.addEventListener('change', () => applyExtensionSubtitleBackgroundAlphaInput({ finalize: true }));
MaweDom.extensionOverlayToggle?.addEventListener('change', () => {
  const previous = MaweHistory.snapshotPreviewState();
  previous.extensionOverlay = !MaweDom.extensionOverlayToggle.checked;
  MaweHistory.pushPreviewUndo('切换副字幕预览', previous);
  MaweSettings.updateEditorSettings({ extensionOverlayEnabled: MaweDom.extensionOverlayToggle.checked });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  MawePlaybackLoop.update();
});
const CLICK_BEHAVIOR_HINTS = {
  zh: {
    'select-and-seek': '暂停时只跳转，不自动播放；播放中跳转后继续播放。',
    'select-only': '只选中，不改变播放位置；可用 F 或右键菜单跳转并播放。',
    'select-and-play': '跳转到字幕起点，并在暂停时自动开始播放。',
  },
  en: {
    'select-and-seek': 'When paused, seek without starting playback; while playing, keep playing after seeking.',
    'select-only': 'Select only without changing the playhead; use F or the context menu to seek and play.',
    'select-and-play': 'Seek to the subtitle start and start playback when paused.',
  },
};
function refreshClickBehaviorHint() {
  const hint = document.getElementById('click-behavior-hint');
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  if (hint) {
    hint.textContent = CLICK_BEHAVIOR_HINTS[language][MaweSettings.EDITOR_SETTINGS.clickBehavior];
    hint.hidden = false;
  }
  if (MaweDom.clickTargetField) {
    MaweDom.clickTargetField.hidden = MaweSettings.EDITOR_SETTINGS.clickBehavior === 'select-only';
  }
}
refreshClickBehaviorHint();
document.addEventListener('mawe:languagechange', refreshClickBehaviorHint);

const KEYBOARD_OPERATION_REFERENCE_HINTS = {
  zh: {
    pointer: 'B/Z/X/N 使用鼠标所在波形位置；波形外不执行时间操作。',
    playhead: 'B/Z/X/N 使用当前播放头位置；无当前字幕目标时使用主轨。',
  },
  en: {
    pointer: 'B/Z/X/N use the mouse position in the waveform; outside it, timing actions do nothing.',
    playhead: 'B/Z/X/N use the current playhead; when no cue target is active, they use the main track.',
  },
};
function refreshKeyboardOperationReferenceHint() {
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  const mode = MaweSettings.normalizeKeyboardOperationReferenceMode(MaweSettings.EDITOR_SETTINGS.keyboardOperationReference);
  if (MaweDom.keyboardOperationReferenceSelect) MaweDom.keyboardOperationReferenceSelect.value = mode;
  if (MaweDom.keyboardOperationReferenceHint) {
    MaweDom.keyboardOperationReferenceHint.textContent = KEYBOARD_OPERATION_REFERENCE_HINTS[language][mode];
  }
}
refreshKeyboardOperationReferenceHint();
document.addEventListener('mawe:languagechange', refreshKeyboardOperationReferenceHint);
MaweJklPlayback.refreshJklPlaybackModeUi();
document.addEventListener('mawe:languagechange', MaweJklPlayback.refreshJklPlaybackModeUi);

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

function fillGapRangeAtWaveformTime(timeMs) {
  const gaps = MaweGapRemoveData.getGapRemoveGaps();
  if (!gaps.some((gap) => gap.removed !== false)) {
    MaweHint.flashHint('当前没有已激活的空隙，无法填充区间空隙', 'invalid');
    return false;
  }
  const range = window.AsrEditorUtils.resolveGapFillRange(gaps, timeMs, gapRemoveMediaDurationMs());
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
  commitManualGapRemoveChange(
    state,
    [{ start: range.start, end: range.end, removed: true }],
  );
  MaweHint.flashHint(`已填充并合并为 ${formatGapRemoveTotal(range.end - range.start)} 静音空隙`, 'success');
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

MaweDom.gapRemoveDragHandle?.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  const rect = MaweDom.gapRemovePanel.getBoundingClientRect();
  MaweCuePanelState.gapRemovePanelDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  MaweDom.gapRemovePanel.classList.add('dragging');
  MaweDom.gapRemoveDragHandle.setPointerCapture?.(event.pointerId);
  event.preventDefault();
});
MaweDom.gapRemoveDragHandle?.addEventListener('pointermove', (event) => {
  if (!MaweCuePanelState.gapRemovePanelDrag || event.pointerId !== MaweCuePanelState.gapRemovePanelDrag.pointerId) return;
  event.preventDefault();
  setGapRemovePanelPosition(
    event.clientX - MaweCuePanelState.gapRemovePanelDrag.offsetX,
    event.clientY - MaweCuePanelState.gapRemovePanelDrag.offsetY,
  );
});
MaweDom.gapRemoveDragHandle?.addEventListener('pointerup', finishGapRemovePanelDrag);
MaweDom.gapRemoveDragHandle?.addEventListener('pointercancel', finishGapRemovePanelDrag);

MaweDom.gapRemovePanel?.querySelectorAll('input[type="number"]').forEach((input) => {
  input.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    try {
      if (event.deltaY < 0) input.stepUp();
      else input.stepDown();
    } catch (_) {
      return;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });
});

MaweDom.gapRemoveManageButton?.addEventListener('click', toggleGapRemovePanel);
MaweDom.gapRemoveScanButton?.addEventListener('click', scanAndRemoveGaps);
MaweDom.gapRemoveShrinkButton?.addEventListener('click', shrinkExistingGaps);
MaweDom.gapRemoveClearAllButton?.addEventListener('click', clearAllGaps);
MaweDom.gapRemoveCloseButton?.addEventListener('click', closeGapRemovePanel);
MaweDom.gapRemoveOperationMode?.addEventListener('change', () => {
  const state = MaweGapRemoveData.getGapRemoveData(true);
  const nextMode = window.AsrGapRemoveCore.normalizeGapOperationMode(MaweDom.gapRemoveOperationMode.value);
  if (state.operation_mode === nextMode) return;
  MaweHistory.pushGapRemoveUndo('切换空隙操作方式');
  state.operation_mode = nextMode;
  setGapRemoveData(state);
});
MaweDom.gapRemoveAdvancedToggle?.addEventListener('click', () => {
  setGapRemoveAdvancedOpen(!gapRemoveAdvancedIsOpen());
});
MaweDom.gapRemoveDisableToggle?.addEventListener('click', () => {
  setGapRemoveDisableOpen(!gapRemoveDisableIsOpen());
});
MaweDom.gapRemoveDisableCoverage?.addEventListener('change', commitGapRemoveDisableSettings);
MaweDom.gapRemoveDisableRemaining?.addEventListener('change', commitGapRemoveDisableSettings);
MaweDom.gapRemoveDisableButton?.addEventListener('click', disableSubtitlesInRemovedGaps);
MaweDom.gapRemoveHysteresis?.addEventListener('input', updateGapRemoveHysteresisHint);
window.addEventListener('resize', () => {
  if (!gapRemovePanelIsOpen()) return;
  const rect = MaweDom.gapRemovePanel.getBoundingClientRect();
  setGapRemovePanelPosition(rect.left, rect.top, { persist: true });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !gapRemovePanelIsOpen() || editingState) return;
  event.preventDefault();
  closeGapRemovePanel();
});
MaweDom.gapRemoveSkipPlayback?.addEventListener('change', () => {
  const state = MaweGapRemoveData.getGapRemoveData(true) || { gaps: [] };
  if (state.skip_playback === MaweDom.gapRemoveSkipPlayback.checked) return;
  MaweHistory.pushGapRemoveUndo('切换空隙跳过播放');
  state.skip_playback = MaweDom.gapRemoveSkipPlayback.checked;
  setGapRemoveData(state);
  if (!state.skip_playback) MaweCuePanelState.gapPreviewRange = null;
});

//   1) sticker.rel + STICKER_ROOT  - 拼出服务器或 file:// URL
//   2) sticker.path  - 兼容老版工程
function stickerUrl(sticker) {
  if (!sticker) return '';
  if (sticker.rel) {
    if (MaweBoot.STICKER_URL_PREFIX) {
      const url = `${MaweBoot.STICKER_URL_PREFIX.replace(/\/$/, '')}/${sticker.rel.split('/').map(encodeURIComponent).join('/')}`;
      return MaweStickerOverlay.stickerAssetRevision ? `${url}?root=${MaweStickerOverlay.stickerAssetRevision}` : url;
    }
    if (!MaweBoot.STICKER_ROOT) return sticker.rel;
    let root = MaweBoot.STICKER_ROOT;
    if (root.startsWith('file://')) return root.replace(/\/+$/, '') + '/' + sticker.rel;
    let prefix = root.startsWith('/') ? 'file://' : 'file:///';
    return prefix + root.replace(/\/+$/, '') + '/' + sticker.rel;
  }
  if (sticker.path) return sticker.path;
  return '';
}

// 合成表情包文件的操作系统绝对路径（用于导出表情包 OTIO）。
function stickerAbsPath(sticker) {
  if (!sticker) return '';
  if (sticker.rel && MaweBoot.STICKER_ROOT) {
    // 去掉可能的 file:// 前缀，保留纯 OS 路径
    let root = MaweBoot.STICKER_ROOT.replace(/^file:\/+/, '');
    // POSIX: 重新加上前导 /
    if (MaweBoot.STICKER_ROOT.startsWith('file:///') && !root.startsWith('/') && !/^[A-Za-z]:/.test(root)) {
      root = '/' + root;
    }
    return root.replace(/\/+$/, '') + '/' + sticker.rel;
  }
  return sticker.path || '';
}
const selectedIdxs = new Set();
const selectedExtensionIdxs = new Set();
let lastClickedIdx = -1;  // 用于 Shift+click 范围选
let lastClickedExtensionIdx = -1;
// “仅看超长”开启时，刚拆出的字幕临时绕过字数过滤；使用稳定 ID，避免 splice 后下标错位。
const temporaryVisibleSplitCueKeys = new Set();
// 右键选择「绑定到主字幕」后的等待状态。使用稳定 ID 而不是数组下标，
// 这样等待期间即使列表重绘，也不会把另一条副字幕误绑定过去。
let pendingExtensionBinding = null;
// 隐藏开关开启时，禁用项视为"不可选"（Shift 范围选 / Ctrl 切换都跳过）
function isHiddenDisabled(idx, track = 'main') {
  const segments = track === 'extension'
    ? (MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || [])
    : (track?.segments || MaweBoot.DATA.segments);
  return MaweDom.hideDisabled && !!(segments[idx] && segments[idx].disabled);
}

function cancelPendingExtensionBinding(message = '已取消绑定副字幕') {
  if (!pendingExtensionBinding) return false;
  pendingExtensionBinding = null;
  MaweHint.flashHint(message);
  return true;
}

function clearSelection({ silent = false, commitCuePanel = true } = {}) {
  hideCueSplitPreview();
  cancelPendingExtensionBinding();
  selectedIdxs.forEach(i => {
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
    if (el) el.classList.remove('selected');
  });
  selectedIdxs.clear();
  selectedExtensionIdxs.forEach((index) => {
    MaweCoreState.container.querySelectorAll(`.multi-cue[data-ext-idx="${index}"], .multi-dual-cue[data-ext-idx="${index}"]`)
      .forEach((el) => el.classList.remove('selected'));
  });
  selectedExtensionIdxs.clear();
  MaweDom.selCountEl.textContent = '0';
  if (silent) {
    // 结构编辑会马上 renderAll() 并重新选中目标；此时不必先刷新旧波形
    // 覆盖层和空面板，避免同一次操作产生两轮视觉更新。
    MaweCuePanelState.currentCuePanelIdx = -1;
    MaweCuePanelState.resetCuePanelEditState();
    return;
  }
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  if (commitCuePanel) {
    setCurrentCuePanelIndex(-1);
  } else {
    MaweCuePanelState.currentCuePanelKind = 'main';
    MaweCuePanelState.currentCuePanelIdx = -1;
    MaweCuePanelState.currentCuePanelTrackId = null;
    MaweCuePanelState.resetCuePanelEditState();
    renderCurrentCuePanel();
  }
}

function updateMultiSelectionClasses() {
  MaweCoreState.container.querySelectorAll('.multi-cue').forEach((element) => {
    const mainIndex = element.dataset.mainIdx == null ? -1 : Number(element.dataset.mainIdx);
    const extensionIndex = element.dataset.extIdx == null ? -1 : Number(element.dataset.extIdx);
    const selected = (Number.isInteger(mainIndex) && selectedIdxs.has(mainIndex))
      || (Number.isInteger(extensionIndex) && selectedExtensionIdxs.has(extensionIndex));
    element.classList.toggle('selected', selected);
  });
}

function addMainIndexToSelection(index) {
  if (!Number.isInteger(index) || !MaweBoot.DATA.segments[index] || isHiddenDisabled(index)) return;
  selectedIdxs.add(index);
  const el = MaweCoreState.container.querySelector(`.cue[data-idx="${index}"]`);
  if (el) el.classList.add('selected');
}

function addExtensionIndexToSelection(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
  if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
  selectedExtensionIdxs.add(index);
}

// 联动选中只补充另一轨的选中集合，不切换当前字幕编辑区；编辑区焦点仍由用户最后点击的字幕决定。
function syncBoundSelection(kind, index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
  if (!MaweSettings.EDITOR_SETTINGS.selectBoundSubtitlePair || !MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  if (kind === 'main') {
    const binding = MaweMultiSubtitleCore.bindingForMainIndex(index);
    const activeTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const bindingTrack = binding ? (MaweMultiSubtitleCore.getExtensionTrack(binding.track_id) || activeTrack) : null;
    if (!binding || !activeTrack || bindingTrack?.id !== activeTrack.id) return;
    (binding.extension_segment_ids || []).forEach((id) => {
      const extensionIndex = activeTrack.segments.findIndex((segment) => segment?.id === id);
      if (extensionIndex >= 0) addExtensionIndexToSelection(extensionIndex, activeTrack);
    });
    return;
  }
  const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(index, track);
  if (!binding) return;
  (binding.main_segment_ids || []).forEach((id) => {
    const mainIndex = MaweBoot.DATA.segments.findIndex((segment) => segment?.id === id);
    if (mainIndex >= 0) addMainIndexToSelection(mainIndex);
  });
}

function selectOnlyExtension(
  index,
  track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
  syncPair = true,
  preserveMainSelection = false,
) {
  if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
  releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
  if (
    pendingExtensionBinding
    && track?.id === pendingExtensionBinding.trackId
    && track.segments?.[index]?.id !== pendingExtensionBinding.extensionId
  ) {
    cancelPendingExtensionBinding();
  }
  if (!preserveMainSelection) {
    // 普通点击副字幕后，最后点击的轨道成为当前绑定/编辑对象；
    // 不保留旧主字幕选区，避免 G 被误解为“替换旧主字幕的绑定”。
    commitCuePanelEdit();
    selectedIdxs.clear();
    lastClickedIdx = -1;
  }
  selectedExtensionIdxs.clear();
  selectedExtensionIdxs.add(index);
  if (syncPair) syncBoundSelection('extension', index, track);
  updateMultiSelectionClasses();
  MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  lastClickedExtensionIdx = index;
  MaweCoreState.waveformEditor?.updateSelection();
  setCurrentCuePanelExtensionIndex(index, track);
}

function toggleExtensionSelection(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
  if (!track?.segments?.[index] || isHiddenDisabled(index, track)) return;
  releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
  if (selectedExtensionIdxs.has(index)) selectedExtensionIdxs.delete(index);
  else {
    selectedExtensionIdxs.add(index);
    syncBoundSelection('extension', index, track);
  }
  updateMultiSelectionClasses();
  MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  lastClickedExtensionIdx = index;
  MaweCoreState.waveformEditor?.updateSelection();
  setCurrentCuePanelExtensionIndex(index, track);
}

function selectExtensionRange(a, b) {
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  if (!track) return;
  releaseTemporaryVisibleSplitCuesUnless('extension', b, track);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  selectedExtensionIdxs.clear();
  let lastSelected = -1;
  for (let index = lo; index <= hi; index++) {
    if (!track.segments[index] || isHiddenDisabled(index, track)) continue;
    selectedExtensionIdxs.add(index);
    syncBoundSelection('extension', index, track);
    lastSelected = index;
  }
  updateMultiSelectionClasses();
  MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (lastSelected < 0) return;
  lastClickedExtensionIdx = lastSelected;
  MaweCoreState.waveformEditor?.updateSelection();
  setCurrentCuePanelExtensionIndex(lastSelected, track);
}
function toggleSel(idx) {
  if (isHiddenDisabled(idx)) return;  // 隐藏禁用项不参与选择
  releaseTemporaryVisibleSplitCuesUnless('main', idx);
  hideCueSplitPreview();
  const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
  if (selectedIdxs.has(idx)) {
    selectedIdxs.delete(idx);
    if (el) el.classList.remove('selected');
  } else {
    selectedIdxs.add(idx);
    if (el) el.classList.add('selected');
    syncBoundSelection('main', idx);
  }
  MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  updateMultiSelectionClasses();
  setCurrentCuePanelIndex(selectedIdxs.has(idx) ? idx : (selectedIdxs.values().next().value ?? -1));
}
function selectRange(a, b) {
  hideCueSplitPreview();
  releaseTemporaryVisibleSplitCuesUnless('main', b);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  for (let i = lo; i <= hi; i++) {
    if (isHiddenDisabled(i)) continue;  // 跳过隐藏禁用项
    if (!selectedIdxs.has(i)) {
      selectedIdxs.add(i);
      const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
      if (el) el.classList.add('selected');
    }
    syncBoundSelection('main', i);
  }
  MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  updateMultiSelectionClasses();
  setCurrentCuePanelIndex(selectedIdxs.has(b) ? b : (selectedIdxs.values().next().value ?? -1));
}
function selectOnly(idx, syncPair = true) {
  hideCueSplitPreview();
  releaseTemporaryVisibleSplitCuesUnless('main', idx);
  // 这是键盘导航的热路径：clearSelection() 会先把面板切到空状态，
  // 再由下面的 setCurrentCuePanelIndex() 切回目标，导致一次按键触发
  // 两次面板刷新和两次波形选区刷新。先提交一次待编辑内容，再批量
  // 更新选区与面板，保持行为不变但只做一次视觉刷新。
  commitCuePanelEdit();
  clearSelection({ silent: true });
  lastClickedExtensionIdx = -1;
  selectedIdxs.add(idx);
  if (syncPair) syncBoundSelection('main', idx);
  const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
  if (el) el.classList.add('selected');
  MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  updateMultiSelectionClasses();
  setCurrentCuePanelIndex(idx);
}
function addToSelection(idx) {
  if (isHiddenDisabled(idx) || selectedIdxs.has(idx)) return;
  releaseTemporaryVisibleSplitCuesUnless('main', idx);
  hideCueSplitPreview();
  selectedIdxs.add(idx);
  syncBoundSelection('main', idx);
  const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
  if (el) el.classList.add('selected');
  MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  setCurrentCuePanelIndex(idx);
}
function addExtensionToSelection(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
  if (!track?.segments?.[index] || isHiddenDisabled(index, track) || selectedExtensionIdxs.has(index)) return;
  releaseTemporaryVisibleSplitCuesUnless('extension', index, track);
  selectedExtensionIdxs.add(index);
  syncBoundSelection('extension', index, track);
  updateMultiSelectionClasses();
  MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  MaweCoreState.waveformEditor?.updateSelection();
  setCurrentCuePanelExtensionIndex(index, track);
}
// 选中全部字幕（跳过「隐藏禁用项」开启时的禁用条目，与其它选择逻辑一致）。
function selectAll() {
  commitCuePanelEdit();
  clearSelection({ silent: true });
  MaweBoot.DATA.segments.forEach((_, idx) => {
    if (isHiddenDisabled(idx)) return;
    selectedIdxs.add(idx);
    syncBoundSelection('main', idx);
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
    if (el) el.classList.add('selected');
  });
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  extensionTrack?.segments.forEach((_, idx) => {
    if (isHiddenDisabled(idx, extensionTrack)) return;
    selectedExtensionIdxs.add(idx);
    syncBoundSelection('extension', idx, extensionTrack);
  });
  updateMultiSelectionClasses();
  MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  const last = MaweBoot.DATA.segments.length - 1;
  if (last >= 0 && selectedIdxs.has(last)) {
    setCurrentCuePanelIndex(last);
    return;
  }
  const firstMain = selectedIdxs.values().next().value;
  if (firstMain !== undefined) {
    setCurrentCuePanelIndex(firstMain);
    return;
  }
  if (!extensionTrack) {
    setCurrentCuePanelIndex(-1);
    return;
  }
  const lastExtension = extensionTrack.segments.length - 1;
  if (lastExtension >= 0 && selectedExtensionIdxs.has(lastExtension)) {
    setCurrentCuePanelExtensionIndex(lastExtension, extensionTrack);
    return;
  }
  const firstExtension = selectedExtensionIdxs.values().next().value;
  setCurrentCuePanelExtensionIndex(firstExtension ?? -1, extensionTrack);
}
// 返回与 idx 同属一个表情包/颜色分组的全部字幕下标（含 idx 自身）。
// head 持有 sticker/color，成员持 sticker_ref/color_ref 指向 head。
function groupMemberIdxs(idx) {
  const seg = MaweBoot.DATA.segments[idx];
  if (!seg) return [idx];
  const heads = new Set();
  if (seg.sticker) heads.add(idx);
  else if (seg.sticker_ref) heads.add(seg.sticker_ref.headIdx);
  if (seg.color) heads.add(idx);
  else if (seg.color_ref) heads.add(seg.color_ref.headIdx);
  if (!heads.size) return [idx];
  const members = [];
  MaweBoot.DATA.segments.forEach((s, i) => {
    const sHead = s.sticker ? i : (s.sticker_ref ? s.sticker_ref.headIdx : null);
    const cHead = s.color ? i : (s.color_ref ? s.color_ref.headIdx : null);
    if ((sHead !== null && heads.has(sHead)) || (cHead !== null && heads.has(cHead))) {
      members.push(i);
    }
  });
  return members.length ? members : [idx];
}
// 普通单击字幕时的选择逻辑：开启「同时选中分组内项目」且属于分组时选整组，否则只选本行。
function selectCueByClick(idx) {
  releaseTemporaryVisibleSplitCuesUnless('main', idx);
  if (pendingExtensionBinding) {
    const pending = pendingExtensionBinding;
    pendingExtensionBinding = null;
    const track = MaweMultiSubtitleCore.getExtensionTrack(pending.trackId);
    const extensionIndex = track?.segments?.findIndex(
      (segment) => segment.id === pending.extensionId,
    ) ?? -1;
    if (extensionIndex < 0) {
      MaweHint.flashHint('副字幕已不存在，绑定已取消', 'warning');
      return;
    }
    // selectOnly 会清空副轨选择，因此先完成主轨选择，再恢复待绑定的副轨选择。
    selectOnly(idx, false);
    selectOnlyExtension(extensionIndex, track, false, true);
    bindSelectedSubtitlePair();
    return;
  }
  if (MaweSettings.EDITOR_SETTINGS.selectGroupMembers) {
    const members = groupMemberIdxs(idx);
    if (members.length > 1) {
      commitCuePanelEdit();
      clearSelection({ silent: true });
      members.forEach((i) => {
        selectedIdxs.add(i);
        syncBoundSelection('main', i);
        const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
        if (el) el.classList.add('selected');
      });
      MaweDom.selCountEl.textContent = String(selectedIdxs.size);
      if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
      setCurrentCuePanelIndex(idx);
      return;
    }
  }
  selectOnly(idx);
}

function overlappingMainIndexesForExtension(extension) {
  const start = Number(extension?.start);
  const end = Number(extension?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return MaweBoot.DATA.segments.map((main, mainIndex) => ({ main, mainIndex }))
    .filter(({ main }) => Number(main?.start) < end && Number(main?.end) > start)
    .map(({ mainIndex }) => mainIndex);
}

function beginPendingExtensionBinding(index, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
  const extension = track?.segments?.[index];
  if (!extension || !track) return;
  const overlapping = overlappingMainIndexesForExtension(extension);
  const unbound = overlapping.filter((mainIndex) => !MaweMultiSubtitleCore.bindingForMainIndex(mainIndex));
  if (unbound.length) {
    // 有多个候选时仍优先选择时间最早且尚未绑定的主字幕，避免每次绑定都要手动点选。
    const mainIndex = unbound.slice().sort((left, right) => (
      Number(MaweBoot.DATA.segments[left]?.start) - Number(MaweBoot.DATA.segments[right]?.start) || left - right
    ))[0];
    selectOnly(mainIndex);
    selectOnlyExtension(index, track, true, true);
    bindSelectedSubtitlePair({
      successMessage: overlapping.length > 1
        ? `有多条主字幕与当前副字幕重叠，已自动绑定时间最早的未绑定主字幕（第 ${mainIndex + 1} 条）`
        : null,
    });
    return;
  }
  pendingExtensionBinding = { trackId: track.id, extensionId: extension.id };
  selectOnlyExtension(index, track);
  if (overlapping.length) {
    MaweHint.flashHint('重叠的主字幕已有绑定，请点击主字幕后替换绑定；按 Esc 取消', 'warning');
  } else {
    MaweHint.flashHint('请点击一条主字幕完成绑定；按 Esc 或点击空白处取消');
  }
}

function bindSelectedSubtitlePair({ successMessage = null } = {}) {
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  if (selectedIdxs.size !== 1 || selectedExtensionIdxs.size !== 1) {
    MaweHint.flashHint('请分别选中一条主字幕和一条副字幕后再绑定', 'invalid');
    return;
  }
  const mainIndex = [...selectedIdxs][0];
  const extensionIndex = [...selectedExtensionIdxs][0];
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const main = MaweBoot.DATA.segments[mainIndex];
  const extension = track?.segments?.[extensionIndex];
  if (!main || !extension) return;
  const replacedBinding = MaweMultiSubtitleCore.bindingForMainIndex(mainIndex);
  MaweHistory.pushUndo('绑定多重字幕');
  MaweMultiSubtitleCore.addSubtitleBinding(main, extension, track);
  const autoSynced = MaweSettings.EDITOR_SETTINGS.multiSubtitleAutoSyncDuration
    && alignExtensionToMainTimeRange(extensionIndex, track, { pushHistory: false, showHint: false });
  MaweMultiSubtitleCore.markMainSegmentsDirty([main]);
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  // 绑定会更新波形上的绑定标记；自动同步时也会改变副字幕范围，
  // 因此列表与波形都需要同步刷新。
  renderAll({ waveform: 'overlay' });
  MaweCoreState.waveformEditor?.updateSelection();
  const bindingMessage = successMessage
    || (replacedBinding
      ? `已替换主字幕 ${mainIndex + 1} 的绑定，改为副字幕 ${extensionIndex + 1}`
      : `已绑定主字幕 ${mainIndex + 1} 与副字幕 ${extensionIndex + 1}`);
  MaweHint.flashHint(`${bindingMessage}${autoSynced ? '，并同步时长' : ''}`, 'success');
}

function unbindSelectedSubtitlePair() {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const ids = new Set();
  selectedIdxs.forEach((index) => { if (MaweBoot.DATA.segments[index]?.id) ids.add(MaweBoot.DATA.segments[index].id); });
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  selectedExtensionIdxs.forEach((index) => { if (track?.segments[index]?.id) ids.add(track.segments[index].id); });
  if (!ids.size) return;
  const removed = MULTI_SUBTITLE_UTILS.removeSubtitleBindings(multi, (binding) => (
    binding.main_segment_ids?.some((id) => ids.has(id))
      || binding.extension_segment_ids?.some((id) => ids.has(id))
  ));
  if (!removed.length) {
    MaweHint.flashHint('当前选中字幕没有绑定关系', 'invalid');
    return;
  }
  // removeSubtitleBindings 已经返回具体关系；快照必须在真正修改前建立。
  // 这里把预览关系恢复后再记录，避免解绑动作无法撤销。
  multi.bindings.push(...removed);
  MaweHistory.pushUndo('解绑多重字幕');
  MULTI_SUBTITLE_UTILS.removeSubtitleBindings(multi, (binding) => removed.includes(binding));
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweMultiSubtitleCore.syncBindingOffsets();
  // 解绑会移除波形上的绑定标记，也需要刷新字幕块覆盖层。
  renderAll({ waveform: 'overlay' });
  MaweCoreState.waveformEditor?.updateSelection();
  MaweHint.flashHint(`已解绑 ${removed.length} 对字幕`, 'success');
}

function alignExtensionToMainTimeRanges(
  indices,
  track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
  { pushHistory = true, showHint = true, batch = false } = {},
) {
  const uniqueIndices = [...new Set((Array.isArray(indices) ? indices : [indices])
    .map((index) => Number(index)).filter(Number.isInteger))];
  const targets = [];
  let skippedUnbound = 0;
  let skippedInvalid = 0;
  uniqueIndices.forEach((index) => {
    const extension = track?.segments?.[index];
    const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(index, track);
    const main = binding ? MaweMultiSubtitleCore.mainSegmentById(binding.main_segment_ids?.[0]) : null;
    if (!extension || !binding || !main) {
      skippedUnbound += 1;
      return;
    }
    const start = Math.round(Number(main.start));
    const end = Math.round(Number(main.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      skippedInvalid += 1;
      return;
    }
    const alreadyAligned = Number(extension.start) === start && Number(extension.end) === end;
    const hasOverlap = MaweMultiSubtitleCore.extensionRangeOverlapsNeighbors(extension, start, end, track);
    if (!alreadyAligned || hasOverlap) targets.push({ extension, start, end });
  });

  if (!targets.length) {
    if (showHint) {
      if (skippedInvalid && !skippedUnbound) MaweHint.flashHint('主字幕时间范围无效，无法对齐', 'warning');
      else if (batch || uniqueIndices.length > 1) {
        MaweHint.flashHint(skippedUnbound
          ? '选中的副字幕中没有可对齐的绑定关系'
          : '选中的副字幕已经与各自主字幕时间范围一致');
      } else if (skippedUnbound) {
        MaweHint.flashHint('请先绑定副字幕，才能对齐主字幕时间范围', 'invalid');
      } else {
        MaweHint.flashHint('副字幕已经与主字幕时间范围一致');
      }
    }
    return false;
  }

  if (pushHistory) MaweHistory.pushUndo(batch || targets.length > 1 ? '批量对齐副字幕' : '对齐副字幕时间范围');
  // 先写入全部目标范围，再统一处理其它副字幕的冲突；主字幕范围不会被改写。
  targets.forEach(({ extension, start, end }) => MaweMultiSubtitleCore.setExtensionSegmentRange(extension, start, end));
  const resolved = MaweMultiSubtitleCore.reconcileExtensionTrack(track, targets.map(({ extension }) => extension));
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweMultiSubtitleCore.syncBindingOffsets();
  renderAll();
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  const details = [];
  if (resolved.squeezedCount) details.push(`挤压 ${resolved.squeezedCount} 条副字幕`);
  if (resolved.removedCount) details.push(`删除 ${resolved.removedCount} 条副字幕`);
  if (showHint) {
    const prefix = batch || targets.length > 1
      ? `已批量对齐 ${targets.length} 条副字幕`
      : '已将副字幕对齐到主字幕时间范围';
    const suffix = details.length
      ? `，${details.join('，')}${resolved.unboundCount ? '并解除绑定' : ''}`
      : skippedUnbound ? `，跳过 ${skippedUnbound} 条未绑定副字幕` : '';
    MaweHint.flashHint(`${prefix}${suffix}`, details.length ? 'warning' : 'success');
  }
  return true;
}

function alignExtensionToMainTimeRange(
  index,
  track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
  { pushHistory = true, showHint = true } = {},
) {
  return alignExtensionToMainTimeRanges([index], track, { pushHistory, showHint });
}

function alignSelectedExtensionSubtitleRanges() {
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return false;
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const indices = [...selectedExtensionIdxs];
  if (!indices.length) {
    MaweHint.flashHint('请先选中至少一条副字幕', 'invalid');
    return false;
  }
  return alignExtensionToMainTimeRanges(indices, track, {
    batch: indices.length > 1,
  });
}

// === 渲染 ===
function renderAll({ waveform = 'overlay', preserveCueListScroll = true, cueListAnchor } = {}) {
  // 旧工程或新增字幕也必须在生成 DOM 前拥有唯一身份；复用工程既有规范化规则。
  MULTI_SUBTITLE_UTILS.ensureStableSegmentIds(MaweBoot.DATA.segments, 'main');
  (MaweMultiSubtitleCore.getMultiSubtitleState().tracks || []).forEach(track => {
    MULTI_SUBTITLE_UTILS.ensureStableSegmentIds(track.segments, `${track.id}-segment`);
  });
  // 其它编辑入口仍以毫秒修改工程对象；在重绘前把它们投影回当前时间基准，
  // 保证帧模式下保存的数据和下一次帧操作保持一致。
  syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
  cueListAnchor = preserveCueListScroll
    ? cueListAnchor || cueListScroll.mutationAnchor || captureCueListRenderAnchor() : null;
  invalidateCueListVisualAnchorRestore();
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
    MaweBoot.DATA.segments.forEach((seg, i) => cueFragment.appendChild(buildCueEl(seg, i)));
  } else if (displayMode === 'extension') {
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    track.segments.forEach((seg, i) => cueFragment.appendChild(buildExtensionCueEl(seg, i, track)));
  } else {
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const rows = MULTI_SUBTITLE_UTILS.buildMultiDisplayRows(MaweBoot.DATA.segments, track.segments, MaweMultiSubtitleCore.getMultiSubtitleState().bindings);
    rows.forEach((row) => cueFragment.appendChild(buildDualCueEl(row.mainIndex, row.extensionIndex, track)));
  }
  MaweCoreState.container.appendChild(cueFragment);
  MaweDisplaySettings.applyCueListDisplaySettings({ preserveCueListScroll: false });
  refreshColorFilterUi();
  MaweDom.totalCountEl.textContent = multiVisible && displayMode === 'extension'
    ? MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments.length || 0
    : MaweBoot.DATA.segments.length;
  // buildCueEl/buildMultiCueColumn 已经按当前搜索词生成了文本；这里仅
  // 计算隐藏状态和数量，避免长工程 renderAll() 再逐行重建一遍文本节点。
  applySearch(MaweDom.searchEl.value, { refreshText: false, preserveCueListScroll: false });
  // 重新应用选中样式（idx 不变时还有效；如果有 splice 改了顺序就先 clearSelection）
  selectedIdxs.forEach(i => {
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
    if (el) el.classList.add('selected');
  });
  // 字幕结构变化只需更新波形上的字幕块覆盖层；媒体峰值和行 Canvas
  // 没有变化，避免 B/C/删除等操作重新绘制整组波形。
  updateMultiSelectionClasses();
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
  updateGapRemoveDisableHint();
  window.MAWE_ONBOARDING?.afterRender();
  restoreCueListRenderAnchor(cueListAnchor);
}

function parsePanelTime(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const timebase = projectTimebase();
  if (timebase.unit === 'frames') {
    const timecodeFrames = parseFrameTimecode(
      raw,
      timebase.fps,
      MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
    );
    if (timecodeFrames !== null) return millisecondsFromFrameNumber(timecodeFrames, timebase.fps);
    if (/^\d+(?:\.\d+)?\s*F?$/iu.test(raw)) {
      return millisecondsFromFrameNumber(Number.parseFloat(raw), timebase.fps);
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
  const minimumDurationMs = timelineMinimumDurationMs();
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
  MaweDom.cuePanelStart.value = fmtShort(seg.start);
  MaweDom.cuePanelDuration.value = timelineIsFrameMode()
    ? formatTimelineTimecode(
      seg.end - seg.start,
      projectTimebase().fps,
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
    image.src = stickerUrl(seg.sticker);
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
    selectOnlyExtension(next);
    lastClickedExtensionIdx = next;
  } else {
    selectOnly(next);
    lastClickedIdx = next;
  }
  const cue = MaweCoreState.container.querySelector(
    target.kind === 'extension' ? `.cue[data-ext-idx="${next}"]` : `.cue[data-idx="${next}"]`,
  );
  if (cue) scrollCueToCenter(cue);
  MaweCoreState.waveformEditor?.revealTime(segments[next].start, true);
}

function splitCuePanelAtCursor() {
  const target = getCurrentCuePanelTarget();
  if (!target) return;
  const cursorOffset = MaweDom.cuePanelText.selectionStart;
  if (target.kind === 'extension') {
    const splitTime = splitTimeForTextOffset(target.segment, cursorOffset);
    commitCuePanelEdit();
    const refreshed = getCurrentCuePanelTarget();
    if (!refreshed) return;
    openExtensionSplitModal(
      refreshed.index,
      splitTimeForTextOffset(refreshed.segment, cursorOffset) || splitTime,
      refreshed.track,
    );
    return;
  }
  const idx = target.index;
  commitCuePanelEdit();
  selectOnly(idx);
  const cue = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
  if (!cue) return;
  startEdit(cue, idx);
  const textEl = editingState?.textEl;
  if (!textEl || !textEl.firstChild) return;
  const range = document.createRange();
  const offset = Math.max(0, Math.min(cursorOffset, textEl.firstChild.textContent.length));
  range.setStart(textEl.firstChild, offset);
  range.setEnd(textEl.firstChild, offset);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  splitAtCursor(null, { listFeedback: false });
}

MaweDom.cuePanelPrev?.addEventListener('click', () => navigateCuePanel(-1));
MaweDom.cuePanelNext?.addEventListener('click', () => navigateCuePanel(1));
MaweDom.cuePanelText?.addEventListener('focus', captureCuePanelTextEditSnapshot);
MaweDom.cuePanelText?.addEventListener('keydown', (event) => {
  // Esc：按当前字幕编辑区设置决定取消还是提交文本编辑。
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (MaweSettings.EDITOR_SETTINGS.cueEditorCancelOnEscape) cancelCuePanelTextEdit();
    else exitCuePanelEdit();
    return;
  }
  const action = getConfiguredEnterAction(event);
  if (!action || action === 'newline') return;
  event.preventDefault();
  event.stopPropagation();
  if (action === 'split') splitCuePanelAtCursor();
  else exitCuePanelEdit();
});
MaweDom.cuePanelText?.addEventListener('input', () => {
  const target = getCurrentCuePanelTarget();
  if (!target) return;
  const cueListAnchor = captureCueListRenderAnchor();
  ensureCuePanelUndo(target.kind === 'extension' ? '编辑副字幕' : '编辑当前字幕');
  const seg = target.segment;
  seg.text = MaweDom.cuePanelText.value.replace(/\r\n?/g, '\n');
  seg._dirty = true;
  if (target.kind === 'extension') MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweServerSave.scheduleAutoSaveFlush();
  const splitMode = target.kind === 'extension'
    ? MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(target.track, seg)
    : MaweMultiSubtitleCore.getMainSubtitleSplitMode(seg);
  const metrics = window.AsrEditorUtils.cueMetrics(
    seg.text, seg.start, seg.end, splitMode,
  );
  MaweDom.cuePanelTotalLength.textContent = String(metrics.totalLength);
  MaweDom.cuePanelCharsPerSecond.textContent = metrics.charsPerSecond.toFixed(2);
  const textEl = getCuePanelTextElement(target);
  if (textEl) {
    setTextHtml(textEl, seg.text, MaweDom.searchEl.value);
    applyCharCount(textEl.closest('.cue')?.querySelector('.charcount'), seg.text, splitMode);
  }
  if (target.kind === 'extension') MaweCoreState.waveformEditor?.refreshExtensionCueLabel(target.index, target.trackId);
  else MaweCoreState.waveformEditor?.refreshCueLabel(target.index);
  MawePlaybackLoop.refreshSubtitlePreview();
  restoreCueListRenderAnchor(cueListAnchor);
});
MaweDom.cuePanelText?.addEventListener('blur', () => {
  if (MaweCuePanelState.cuePanelCanceling) return;
  commitCuePanelEdit();
});
MaweDom.cuePanelStart?.addEventListener('change', () => commitCuePanelEdit());
MaweDom.cuePanelDuration?.addEventListener('change', () => commitCuePanelEdit());
MaweDom.cuePanelAddSticker?.addEventListener('click', () => {
  const target = getCurrentCuePanelTarget();
  if (target?.kind === 'main') MaweStickerPicker.openStickerPicker([target.index], false);
});
MaweDom.cuePanelSticker?.addEventListener('click', () => {
  const target = getCurrentCuePanelTarget();
  if (target?.kind === 'main') MaweStickerPicker.openStickerPicker([target.index], false);
});
MaweDom.cuePanelSticker?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const target = getCurrentCuePanelTarget();
  if (target?.kind !== 'main') return;
  MaweStickerPicker.removeStickerCascade(target.index);
  renderAll();
  MaweHint.flashHint('已删除当前表情包', 'success');
});
MaweDom.cuePanelSplit?.addEventListener('click', splitCuePanelAtCursor);

function updateCueColorPresentation(el, colorBar, seg) {
  if (!el || !colorBar || !seg) return;

  // 颜色组可能在不重建字幕行的情况下从 head 变成 ref（或反过来）。
  // 绑定一次委托式处理器，之后只更新 class / style / data，不替换节点。
  if (!colorBar.dataset.colorRefHandlerBound) {
    colorBar.addEventListener('click', (event) => {
      if (!colorBar.classList.contains('is-ref')) return;
      event.stopPropagation();
      const row = colorBar.closest('.cue');
      const headIndex = Number(colorBar.dataset.colorRefHeadIdx);
      if (!Number.isInteger(headIndex) || headIndex < 0) return;
      const isExtension = row?.dataset.extIdx != null && row?.dataset.idx == null;
      const head = MaweCoreState.container.querySelector(
        isExtension ? `.cue[data-ext-idx="${headIndex}"]` : `.cue[data-idx="${headIndex}"]`,
      );
      if (!head) return;
      scrollCueToCenter(head);
      if (isExtension) selectOnlyExtension(headIndex);
      else selectOnly(headIndex);
    });
    colorBar.dataset.colorRefHandlerBound = 'true';
  }

  colorBar.classList.remove('has-color', 'is-ref');
  colorBar.style.removeProperty('--color-bar');
  colorBar.style.removeProperty('cursor');
  colorBar.removeAttribute('title');
  delete colorBar.dataset.colorRefHeadIdx;
  el.classList.remove('has-color');
  el.style.removeProperty('--color-bar');

  if (seg.color) {
    const value = seg.color.value || MaweColors.colorValue(seg.color.name);
    colorBar.classList.add('has-color');
    colorBar.style.setProperty('--color-bar', value);
    el.classList.add('has-color');
    el.style.setProperty('--color-bar', value);
    colorBar.title = `颜色：${seg.color.name}`;
  } else if (seg.color_ref) {
    const value = MaweColors.colorValue(seg.color_ref.name);
    const headIndex = Number(seg.color_ref.headIdx);
    colorBar.classList.add('is-ref');
    colorBar.style.setProperty('--color-bar', value);
    colorBar.dataset.colorRefHeadIdx = String(headIndex);
    el.classList.add('has-color');
    el.style.setProperty('--color-bar', value);
    colorBar.title = `↑ 属于第 ${headIndex + 1} 条的颜色（${seg.color_ref.name}）`;
    colorBar.style.cursor = 'pointer';
  }
}

function updateCueStickerPresentation(el, slotEl, seg, idx, { extensionTrack = null } = {}) {
  if (!el || !slotEl || !seg) return;
  const isExtension = Boolean(extensionTrack);
  slotEl.classList.remove('ref');
  slotEl.replaceChildren();
  if (seg.sticker) {
    const img = document.createElement('img');
    img.src = stickerUrl(seg.sticker);
    img.alt = seg.sticker.name || '表情包';
    img.title = seg.sticker.name || '表情包';
    img.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!isExtension) MaweStickerPicker.openStickerPreview(idx);
    });
    const nameEl = document.createElement('div');
    nameEl.className = 'sname';
    nameEl.textContent = seg.sticker.name || '表情包';
    slotEl.append(img, nameEl);
  } else if (seg.sticker_ref) {
    // 跨多句的引用，只显示名称（带↑标识属于上方）
    slotEl.classList.add('ref');
    const refEl = document.createElement('div');
    const headIndex = Number(seg.sticker_ref.headIdx);
    const name = seg.sticker_ref.name || '表情包';
    refEl.className = 'sref';
    refEl.textContent = `↑ ${name}`;
    refEl.title = `属于上方第 ${Number.isInteger(headIndex) ? headIndex + 1 : '?'} 条的表情包`;
    refEl.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!Number.isInteger(headIndex) || headIndex < 0) return;
      const head = MaweCoreState.container.querySelector(
        isExtension ? `.cue[data-ext-idx="${headIndex}"]` : `.cue[data-idx="${headIndex}"]`,
      );
      if (!head) return;
      scrollCueToCenter(head);
      if (isExtension) selectOnlyExtension(headIndex, extensionTrack);
      else selectOnly(headIndex);
    });
    slotEl.appendChild(refEl);
  }
}

function buildCueEl(seg, idx, { extensionTrack = null } = {}) {
  const isExtension = Boolean(extensionTrack);
  const el = document.createElement('div');
  el.className = MaweMultiSubtitleCore.multiSubtitleVisible() ? 'cue multi-cue' : 'cue';
  setCueListIdentity(el, seg, extensionTrack);
  if (isExtension) {
    el.classList.add('multi-extension-cue');
    el.dataset.extIdx = String(idx);
  } else {
    el.dataset.idx = idx;
    if (MaweMultiSubtitleCore.multiSubtitleVisible()) el.dataset.mainIdx = String(idx);
  }
  if (seg._dirty) el.classList.add('dirty');
  if (seg.disabled) el.classList.add('disabled');

  // 颜色条（最左）
  const colorBar = document.createElement('span');
  colorBar.className = 'color-bar';
  updateCueColorPresentation(el, colorBar, seg);

  const indexEl = document.createElement('span');
  indexEl.className = 'index';
  indexEl.textContent = String(idx + 1);

  const timeEl = document.createElement('span');
  timeEl.className = 'time';
  const timeStartEl = document.createElement('span');
  timeStartEl.className = 'time-start';
  timeStartEl.textContent = fmtShort(seg.start);
  const timeArrowEl = document.createElement('span');
  timeArrowEl.className = 'time-arrow';
  timeArrowEl.textContent = '→';
  const timeEndEl = document.createElement('span');
  timeEndEl.className = 'time-end';
  timeEndEl.textContent = fmtShort(seg.end);
  timeEl.append(timeStartEl, timeArrowEl, timeEndEl);

  // 表情包槽位
  const slotEl = document.createElement('span');
  slotEl.className = 'sticker-slot';
  updateCueStickerPresentation(el, slotEl, seg, idx, { extensionTrack });

  const textEl = document.createElement('span');
  textEl.className = 'text';
  setTextHtml(textEl, seg.text, MaweDom.searchEl.value);

  const cntEl = document.createElement('span');
  cntEl.className = 'charcount';
  applyCharCount(
    cntEl,
    seg.text,
    isExtension ? MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(extensionTrack, seg) : MaweMultiSubtitleCore.getMainSubtitleSplitMode(seg),
  );

  el.appendChild(colorBar);
  el.appendChild(indexEl);
  el.appendChild(timeEl);
  el.appendChild(slotEl);
  el.appendChild(textEl);
  el.appendChild(cntEl);

  if (isExtension) bindExtensionCueEvents(el, idx, extensionTrack);
  else bindCueEvents(el, idx);
  return el;
}

function buildMultiTimeEl(segment) {
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = `${fmtShort(segment.start)} → ${fmtShort(segment.end)}`;
  return time;
}

function buildMultiCueColumn(segment, index, track, kind) {
  const column = document.createElement('div');
  column.className = `multi-cue-column ${kind}`;
  if (!segment) {
    column.classList.add('multi-cue-empty');
    column.textContent = '—';
    return column;
  }
  if (segment._dirty) column.classList.add('dirty');
  if (segment.disabled) column.classList.add('disabled');
  const header = document.createElement('div');
  header.className = 'multi-cue-column-header';
  const indexEl = document.createElement('span');
  indexEl.className = 'index';
  indexEl.textContent = `${kind === 'main' ? '主字幕' : '副字幕'} ${index + 1}`;
  header.append(indexEl, buildMultiTimeEl(segment));
  const text = document.createElement('span');
  text.className = 'text';
  setTextHtml(text, segment.text || '', MaweDom.searchEl.value);
  column.append(header, text);
  if (kind === 'extension') {
    const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(index, track);
    if (!binding) column.classList.add('unbound');
    column.dataset.extIdx = String(index);
  } else {
    column.dataset.mainIdx = String(index);
  }
  column.dataset.start = String(segment.start);
  column.dataset.end = String(segment.end);
  return column;
}

function buildExtensionCueEl(seg, idx, track) {
  return buildCueEl(seg, idx, { extensionTrack: track });
}

function buildDualCueEl(mainIndex, extensionIndex, track) {
  const main = mainIndex == null ? null : MaweBoot.DATA.segments[mainIndex];
  const extension = extensionIndex == null ? null : track.segments[extensionIndex];
  const el = document.createElement('div');
  el.className = 'cue multi-cue multi-dual-cue';
  if (main) setCueListIdentity(el, main);
  if (extension) setCueListIdentity(el, extension, track);
  if (mainIndex != null) {
    el.dataset.mainIdx = String(mainIndex);
    el.dataset.idx = String(mainIndex);
  }
  if (extensionIndex != null) el.dataset.extIdx = String(extensionIndex);
  el.append(
    buildMultiCueColumn(main, mainIndex ?? -1, track, 'main'),
    buildMultiCueColumn(extension, extensionIndex ?? -1, track, 'extension'),
  );
  if (main) bindCueEvents(el, mainIndex);
  if (extension) {
    const extensionColumn = el.querySelector('.multi-cue-column.extension');
    bindExtensionCueEvents(extensionColumn, extensionIndex, track, el);
  }
  return el;
}

function fmtShort(ms) {
  if (timelineIsFrameMode()) {
    return formatTimelineTimecode(
      ms,
      projectTimebase().fps,
      MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
    );
  }
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2,'0')}:${(s - m * 60).toFixed(3).padStart(6,'0')}`;
}

function fmtSrtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)},${pad(ms,3)}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function setTextHtml(el, text, query) {
  if (!query) {
    el.innerHTML = '';
    text.split('\n').forEach((line, i) => {
      if (i > 0) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(line));
    });
    return;
  }
  const re = buildSearchRegex(query, false);
  let html = '';
  for (const line of text.split('\n').map(escapeHtml)) {
    if (html) html += '<br>';
    if (!re) { html += line; continue; }
    html += line.replace(re, m => `<mark>${m}</mark>`);
  }
  el.innerHTML = html;
}

function buildSearchRegex(query, caseSensitive) {
  if (!query) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, caseSensitive ? 'g' : 'gi');
}

// === 字数 ===
function calcCharWidth(text, mode = null) {
  return mode
    ? window.AsrEditorUtils.countSubtitleUnits(text, mode)
    : window.AsrEditorUtils.countTextUnits(text);
}
function getCharCountThreshold() {
  const v = Number(MaweSettings.EDITOR_SETTINGS.cueListCharcountThreshold);
  return Number.isFinite(v) && v > 0
    ? MaweSettings.clampCharcountThreshold(v)
    : MaweSettings.DEFAULT_EDITOR_SETTINGS.cueListCharcountThreshold;
}
function syncCharCountThresholdInputs(value = getCharCountThreshold()) {
  const threshold = MaweSettings.clampCharcountThreshold(value);
  const text = String(threshold);
  if (MaweDom.cueListCharcountThresholdInput) MaweDom.cueListCharcountThresholdInput.value = text;
  if (MaweDom.timedTextEditCharcountThresholdInput) MaweDom.timedTextEditCharcountThresholdInput.value = text;
  return threshold;
}
function handleCharCountThresholdInput(input) {
  const value = Number(input?.value);
  if (Number.isFinite(value) && value >= 1 && value <= 200) {
    const threshold = syncCharCountThresholdInputs(value);
    MaweSettings.updateEditorSettings({ cueListCharcountThreshold: threshold });
  }
  updateTimedTextEditSingleGuide();
  refreshAllCharCounts();
  if (document.getElementById('filter-over').classList.contains('active')) {
    applySearch(MaweDom.searchEl.value);
  }
}
function updateTimedTextEditSingleGuide() {
  if (!MaweDom.timedTextEditSingleEditor) return;
  MaweDom.timedTextEditSingleEditor.style.setProperty(
    '--timed-text-edit-line-width',
    `${getCharCountThreshold()}em`,
  );
}
function applyCharCount(cntEl, text, mode = null) {
  if (!cntEl) return;
  const w = calcCharWidth(text, mode);
  cntEl.textContent = Number.isInteger(w) ? String(w) : w.toFixed(1);
  cntEl.classList.toggle('over', w > getCharCountThreshold());
}

function splitCueVisibilityKey(kind, segment, trackId = null) {
  const id = segment?.id;
  if (!id) return null;
  return kind === 'extension'
    ? `extension:${trackId || ''}:${id}`
    : `main:${id}`;
}

function temporaryVisibleSplitCueKeysForElement(element) {
  if (!element) return [];
  const keys = [];
  const mainIndex = element.dataset.mainIdx != null
    ? Number(element.dataset.mainIdx)
    : (element.dataset.idx != null ? Number(element.dataset.idx) : -1);
  const extensionIndex = element.dataset.extIdx != null ? Number(element.dataset.extIdx) : -1;
  if (Number.isInteger(mainIndex) && mainIndex >= 0) {
    const key = splitCueVisibilityKey('main', MaweBoot.DATA.segments[mainIndex]);
    if (key) keys.push(key);
  }
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  if (Number.isInteger(extensionIndex) && extensionIndex >= 0 && extensionTrack) {
    const key = splitCueVisibilityKey(
      'extension', extensionTrack.segments[extensionIndex], extensionTrack.id,
    );
    if (key) keys.push(key);
  }
  return keys;
}

function cueElementHasTemporarySplitVisibility(element) {
  return temporaryVisibleSplitCueKeysForElement(element)
    .some((key) => temporaryVisibleSplitCueKeys.has(key));
}

function clearTemporaryVisibleSplitCues() {
  temporaryVisibleSplitCueKeys.clear();
}

function rememberTemporaryVisibleSplitCues({
  mainSegments = [],
  extensionSegments = [],
  extensionTrackId = null,
} = {}) {
  if (!MaweSettings.EDITOR_SETTINGS.cueListKeepSplitVisible) return;
  if (!document.getElementById('filter-over')?.classList.contains('active')) return;
  mainSegments.forEach((segment) => {
    const key = splitCueVisibilityKey('main', segment);
    if (key) temporaryVisibleSplitCueKeys.add(key);
  });
  extensionSegments.forEach((segment) => {
    const key = splitCueVisibilityKey('extension', segment, extensionTrackId);
    if (key) temporaryVisibleSplitCueKeys.add(key);
  });
}

function releaseTemporaryVisibleSplitCuesUnless(kind, index, track = null) {
  if (!temporaryVisibleSplitCueKeys.size) return;
  const segments = kind === 'extension'
    ? (track?.segments || MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || [])
    : MaweBoot.DATA.segments;
  const segment = segments[index];
  const key = splitCueVisibilityKey(kind, segment, kind === 'extension' ? track?.id : null);
  if (key && temporaryVisibleSplitCueKeys.has(key)) return;
  clearTemporaryVisibleSplitCues();
  applySearch(MaweDom.searchEl.value);
}

function refreshAllCharCounts() {
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  MaweCoreState.container.querySelectorAll(':scope > .cue').forEach(el => {
    const idx = Number.parseInt(el.dataset.idx, 10);
    const extensionIdx = Number.parseInt(el.dataset.extIdx, 10);
    const cntEl = el.querySelector('.charcount');
    const segment = Number.isInteger(extensionIdx) && extensionTrack
      ? extensionTrack.segments[extensionIdx]
      : (Number.isInteger(idx) ? MaweBoot.DATA.segments[idx] : null);
    const mode = Number.isInteger(extensionIdx) && extensionTrack
      ? MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(extensionTrack, segment)
      : MaweMultiSubtitleCore.getMainSubtitleSplitMode(segment);
    if (cntEl && segment) applyCharCount(cntEl, segment.text, mode);
  });
}

// === 颜色过滤 ===
// 工程中存在彩色字幕时，在过滤输入框右侧显示 🎨 按钮：
// 点击行（非 checkbox）= 只显示该颜色；勾选 checkbox = 多选；清除 = 全部显示。
const COLOR_FILTER_DEFAULT_KEY = '__default__';
const colorFilterDropdown = document.getElementById('color-filter-dropdown');
const colorFilterButton = document.getElementById('color-filter-btn');
const colorFilterMenu = document.getElementById('color-filter-menu');
let colorFilterSelection = null; // null = 不过滤；Set<string> = 仅显示这些颜色键
let colorFilterUsageCache = new Map();

function effectiveCueColorKey(mainSeg) {
  if (!mainSeg) return COLOR_FILTER_DEFAULT_KEY;
  return MULTI_SUBTITLE_UTILS.effectiveColorName(mainSeg, MaweBoot.DATA.segments) || COLOR_FILTER_DEFAULT_KEY;
}

// 双列 / 仅副轨显示模式下，列表行不携带颜色条：按钮隐藏且过滤暂停生效，
// 避免出现“看不到过滤开关但列表被过滤”的死角。只有单列主轨列表参与过滤。
function colorFilterSuspended() {
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return false;
  return MaweMultiSubtitleCore.getMultiSubtitleState().display_mode !== 'main';
}

function collectProjectColorUsage() {
  const counts = new Map();
  MaweBoot.DATA.segments.forEach((seg) => {
    const key = effectiveCueColorKey(seg);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

function colorFilterLabelFor(key) {
  if (key === COLOR_FILTER_DEFAULT_KEY) return '默认';
  return MaweColors.COLOR_BY_NAME[key]?.label || key;
}

function colorFilterValueFor(key) {
  return MaweColors.COLOR_BY_NAME[key]?.value || null;
}

function syncColorFilterControls() {
  const hasColors = !colorFilterSuspended()
    && [...colorFilterUsageCache.keys()].some((key) => key !== COLOR_FILTER_DEFAULT_KEY);
  colorFilterButton?.toggleAttribute('hidden', !hasColors);
  colorFilterButton?.classList.toggle('filter-active', Boolean(colorFilterSelection));
  renderColorFilterMenu();
}

function renderColorFilterMenu() {
  if (!colorFilterMenu) return;
  const usage = colorFilterUsageCache;
  // 过滤掉工程里已不存在的选择项，避免按钮显示“过滤中”但列表为空。
  if (colorFilterSelection) {
    const kept = new Set([...colorFilterSelection].filter((key) => usage.has(key)));
    colorFilterSelection = kept.size ? kept : null;
  }
  const keys = [COLOR_FILTER_DEFAULT_KEY];
  MaweColors.COLOR_PALETTE.forEach((palette) => { if (usage.has(palette.name)) keys.push(palette.name); });
  usage.forEach((_count, key) => { if (!keys.includes(key)) keys.push(key); });
  colorFilterMenu.replaceChildren();
  keys.forEach((key) => {
    colorFilterMenu.appendChild(buildColorFilterItem(key, usage.get(key) || 0));
  });
  const selectFilteredBtn = document.createElement('button');
  selectFilteredBtn.type = 'button';
  selectFilteredBtn.className = 'dropdown-item color-filter-select-all';
  selectFilteredBtn.textContent = '全选过滤结果';
  selectFilteredBtn.hidden = !colorFilterSelection;
  selectFilteredBtn.addEventListener('click', () => selectAllFilteredCues());
  colorFilterMenu.appendChild(selectFilteredBtn);
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'dropdown-item color-filter-clear';
  clearBtn.textContent = '清除颜色过滤';
  clearBtn.hidden = !colorFilterSelection;
  clearBtn.addEventListener('click', () => setColorFilterSelection(null));
  colorFilterMenu.appendChild(clearBtn);
}

function setColorFilterSelection(next) {
  colorFilterSelection = next && next.size ? new Set(next) : null;
  renderColorFilterMenu();
  applySearch(MaweDom.searchEl.value);
}

function selectAllFilteredCues() {
  // 颜色过滤只作用于主轨字幕列表，这里同样只选中主轨里过滤命中的字幕，
  // 便于配合「批量替换（仅选中）」等按选区工作的工具，例如给不同说话人加前缀。
  if (!colorFilterSelection || colorFilterSuspended()) {
    MaweHint.flashHint('当前没有生效的颜色过滤', 'invalid');
    return;
  }
  commitCuePanelEdit();
  clearSelection({ silent: true });
  MaweBoot.DATA.segments.forEach((seg, idx) => {
    if (isHiddenDisabled(idx)) return;
    if (!colorFilterSelection.has(effectiveCueColorKey(seg))) return;
    selectedIdxs.add(idx);
    const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
    if (el) el.classList.add('selected');
  });
  updateMultiSelectionClasses();
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
  MaweHint.flashHint(`已选中 ${selectedIdxs.size} 条过滤字幕`, selectedIdxs.size ? 'success' : 'invalid');
}

function buildColorFilterItem(key, count) {
  const label = document.createElement('label');
  label.className = 'color-filter-item';
  label.dataset.colorKey = key;
  label.title = `该颜色的字幕共 ${count} 条；点击条目只显示此颜色，勾选可多选`;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(colorFilterSelection?.has(key));
  input.addEventListener('change', () => {
    const next = new Set(colorFilterSelection || []);
    if (input.checked) next.add(key); else next.delete(key);
    setColorFilterSelection(next);
  });
  const dot = document.createElement('span');
  dot.className = `color-dot${key === COLOR_FILTER_DEFAULT_KEY ? ' is-default' : ''}`;
  const value = colorFilterValueFor(key);
  if (value) dot.style.background = value;
  const nameEl = document.createElement('span');
  nameEl.className = 'color-name';
  nameEl.textContent = colorFilterLabelFor(key);
  const countEl = document.createElement('span');
  countEl.className = 'color-count';
  countEl.textContent = String(count);
  label.addEventListener('click', (event) => {
    // checkbox 自身的多选行为走 change 事件；点击行内其余区域 = 仅显示该颜色。
    // 行内点击会同步重建菜单，必须阻止冒泡，否则点击目标脱离下拉容器后
    // 会命中 document 的“点击外部关闭”逻辑，把刚选中的菜单关掉。
    if (event.target === input) return;
    event.preventDefault();
    event.stopPropagation();
    setColorFilterSelection(new Set([key]));
  });
  label.append(input, dot, nameEl, countEl);
  return label;
}

function refreshColorFilterUi() {
  colorFilterUsageCache = collectProjectColorUsage();
  syncColorFilterControls();
}

function refreshCueColorRows() {
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  MaweCoreState.container.querySelectorAll(':scope > .cue').forEach((el) => {
    const colorBar = el.querySelector(':scope > .color-bar');
    if (!colorBar) return;
    if (el.dataset.extIdx != null && el.dataset.idx == null) {
      const extensionIndex = Number(el.dataset.extIdx);
      const segment = Number.isInteger(extensionIndex)
        ? extensionTrack?.segments?.[extensionIndex]
        : null;
      if (segment) updateCueColorPresentation(el, colorBar, segment);
      return;
    }
    const mainIndex = el.dataset.idx != null
      ? Number(el.dataset.idx)
      : (el.dataset.mainIdx != null ? Number(el.dataset.mainIdx) : -1);
    const segment = Number.isInteger(mainIndex) && mainIndex >= 0
      ? MaweBoot.DATA.segments[mainIndex]
      : null;
    if (segment) updateCueColorPresentation(el, colorBar, segment);
  });
}

function refreshCueStickerRows() {
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  MaweCoreState.container.querySelectorAll(':scope > .cue').forEach((el) => {
    const slotEl = el.querySelector(':scope > .sticker-slot');
    if (!slotEl) return;
    const isExtension = el.dataset.extIdx != null && el.dataset.idx == null;
    const index = Number(isExtension ? el.dataset.extIdx : (el.dataset.idx ?? el.dataset.mainIdx));
    const segment = isExtension
      ? (Number.isInteger(index) ? extensionTrack?.segments?.[index] : null)
      : (Number.isInteger(index) && index >= 0 ? MaweBoot.DATA.segments[index] : null);
    if (segment) {
      updateCueStickerPresentation(el, slotEl, segment, index, {
        extensionTrack: isExtension ? extensionTrack : null,
      });
    }
  });
}

function refreshStickerAssignmentUi() {
  // 表情包分配只改变行内槽位和预览素材，不改变字幕行的数量、顺序或时间；
  // 原地更新可以避免 renderAll() 替换列表节点后产生滚动闪烁。
  refreshCueStickerRows();
  const projectHasStickers = MaweBoot.DATA.segments.some((segment) => segment.sticker || segment.sticker_ref);
  MaweCoreState.container.classList.toggle('hide-cue-sticker',
    !MaweSettings.EDITOR_SETTINGS.cueListShowSticker || !projectHasStickers,
  );
  MaweStickerOverlay.stickerOverlayDataVersion += 1;
  renderCurrentCuePanel();
  MawePlaybackLoop.refreshSubtitlePreview();
}

function refreshColorAssignmentUi() {
  // 颜色是字幕属性，不改变行的数量、顺序或高度；直接更新现有节点，
  // 避免 renderAll() 替换列表后触发浏览器布局回填和活动字幕自动跟随。
  refreshCueColorRows();
  refreshColorFilterUi();
  // 颜色过滤开启时，颜色变化可能改变当前行的显隐；只重新计算 class，
  // 不保存/恢复滚动位置，也不主动滚动。
  if (MaweDom.searchEl.value || colorFilterSelection
      || document.getElementById('filter-over')?.classList.contains('active')) {
    applySearch(MaweDom.searchEl.value, { refreshText: false, preserveCueListScroll: false });
  }
  MaweCoreState.waveformEditor?.refreshCueOverlay?.();
  MawePlaybackLoop.refreshSubtitlePreview();
  MaweExportSrt.updateSubtitleExportUi();
}

renderColorFilterMenu();
function positionColorFilterMenu() {
  if (!colorFilterDropdown?.classList.contains('open') || !colorFilterButton || !colorFilterMenu) return;
  const buttonRect = colorFilterButton.getBoundingClientRect();
  const menuWidth = colorFilterMenu.offsetWidth;
  const menuHeight = colorFilterMenu.offsetHeight;
  const margin = 8;
  const left = Math.min(
    Math.max(margin, buttonRect.left),
    Math.max(margin, window.innerWidth - menuWidth - margin),
  );
  const belowTop = buttonRect.bottom + 6;
  const aboveTop = buttonRect.top - menuHeight - 6;
  let top = belowTop;
  if (belowTop + menuHeight > window.innerHeight - margin && aboveTop >= margin) {
    top = aboveTop;
  } else if (belowTop + menuHeight > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - menuHeight - margin);
  }
  colorFilterMenu.style.left = `${left}px`;
  colorFilterMenu.style.top = `${top}px`;
}
MaweExportMenus.bindToolbarExportDropdown(
  'color-filter-dropdown', 'color-filter-btn', 'color-filter-menu',
  positionColorFilterMenu,
);

// === 搜索 ===
function applySearch(query, { refreshText = true, preserveCueListScroll = true } = {}) {
  const cueListAnchor = preserveCueListScroll ? captureCueListRenderAnchor() : null;
  try {
    const trimmed = query.trim();
    let visible = 0;
    const re = buildSearchRegex(trimmed, false);
    const filterOver = document.getElementById('filter-over').classList.contains('active');
    const threshold = getCharCountThreshold();
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    // 容器内还有布局拖拽栏和“加载工程后显示字幕列表”占位层；过滤只作用于真实字幕行。
    const cueElements = MaweCoreState.container.querySelectorAll(':scope > .cue');
    cueElements.forEach(el => {
      const mainIdx = el.dataset.mainIdx != null
        ? Number(el.dataset.mainIdx)
        : (el.dataset.idx != null ? Number(el.dataset.idx) : -1);
      const extIdx = el.dataset.extIdx != null ? Number(el.dataset.extIdx) : -1;
      const mainSeg = Number.isInteger(mainIdx) && mainIdx >= 0 ? MaweBoot.DATA.segments[mainIdx] : null;
      const extensionSeg = Number.isInteger(extIdx) && extIdx >= 0 && extensionTrack
        ? extensionTrack.segments[extIdx] : null;
      const searchableText = [mainSeg?.text, extensionSeg?.text].filter(Boolean).join('\n');
      if (!searchableText) {
        el.classList.add('hidden');
        return;
      }
      let matched = !re || re.test(searchableText);
      if (re) re.lastIndex = 0;
      if (matched && colorFilterSelection && !colorFilterSuspended()) {
        matched = colorFilterSelection.has(effectiveCueColorKey(mainSeg));
      }
      const keepTemporaryVisible = filterOver
        && MaweSettings.EDITOR_SETTINGS.cueListKeepSplitVisible
        && cueElementHasTemporarySplitVisibility(el);
      if (matched && filterOver && !keepTemporaryVisible) {
        const count = (mainSeg ? calcCharWidth(mainSeg.text, MaweMultiSubtitleCore.getMainSubtitleSplitMode(mainSeg)) : 0)
          + (extensionSeg
            ? calcCharWidth(extensionSeg.text, MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(extensionTrack, extensionSeg))
            : 0);
        matched = count > threshold;
      }
      el.classList.toggle('hidden', !matched);
      if (matched) visible++;
      if (refreshText && !el.classList.contains('editing')) {
        const mainTextEl = el.querySelector('.multi-cue-column.main .text');
        const extensionTextEl = el.querySelector('.multi-cue-column.extension .text');
        if (mainTextEl && mainSeg) setTextHtml(mainTextEl, mainSeg.text, trimmed);
        if (extensionTextEl && extensionSeg) setTextHtml(extensionTextEl, extensionSeg.text, trimmed);
        if (!mainTextEl && !extensionTextEl) {
          const textEl = el.querySelector('.text');
          if (textEl) setTextHtml(textEl, searchableText, trimmed);
        }
      }
    });
    MaweDom.visibleCountEl.textContent = visible;
  } finally {
    restoreCueListRenderAnchor(cueListAnchor);
  }
}
let searchDebounce = null;
const searchWrap = document.getElementById('search-wrap');
function refreshSearchClearVisibility() {
  searchWrap.classList.toggle('has-value', MaweDom.searchEl.value.length > 0);
}
MaweDom.searchEl.addEventListener('input', () => {
  refreshSearchClearVisibility();
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => applySearch(MaweDom.searchEl.value), 100);
});
document.getElementById('search-clear')?.addEventListener('click', () => {
  MaweDom.searchEl.value = '';
  refreshSearchClearVisibility();
  applySearch('');
  MaweDom.searchEl.focus({ preventScroll: true });
});

// === 编辑 ===
let editingState = null;
let extensionEditingState = null;

function startExtensionEdit(
  el,
  index,
  track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
  clickX,
  clickY,
  { deferCaret = false } = {},
) {
  if (!el || !track?.segments?.[index]) return;
  hideCueSplitPreview();
  if (editingState) finishEdit(true);
  if (extensionEditingState) finishExtensionEdit(true);
  setCurrentCuePanelExtensionIndex(index, track);
  const textEl = el.querySelector('.text') || el;
  const segment = track.segments[index];
  let caretCharOffset = null;
  if (typeof clickX === 'number' && typeof clickY === 'number') {
    caretCharOffset = caretCharFromPoint(textEl, clickX, clickY);
  }
  extensionEditingState = {
    el, index, trackId: track.id, textEl, original: segment.text || '', caretCharOffset,
  };
  el.classList.add('editing');
  textEl.setAttribute('contenteditable', 'plaintext-only');
  textEl.innerText = segment.text || '';
  textEl.focus();
  const applyCaret = () => {
    if (!extensionEditingState || extensionEditingState.el !== el) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (caretCharOffset !== null && textEl.firstChild) {
      const range = document.createRange();
      const node = textEl.firstChild;
      const pos = Math.max(0, Math.min(caretCharOffset, node.textContent.length));
      range.setStart(node, pos);
      range.setEnd(node, pos);
      selection.addRange(range);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(textEl);
    selection.addRange(range);
  };
  applyCaret();
  if (deferCaret) setTimeout(applyCaret, 0);
}

function syncCuePanelAfterInlineEdit(kind, index, trackId = null) {
  const target = getCurrentCuePanelTarget();
  if (!target || target.kind !== kind || target.index !== index) return;
  if (kind === 'extension' && target.trackId !== trackId) return;
  if (MaweDom.cuePanelText && document.activeElement !== MaweDom.cuePanelText) {
    MaweDom.cuePanelText.value = target.segment?.text || '';
  }
}

function finishExtensionEdit(save) {
  if (!extensionEditingState) return;
  const { el, index, trackId, textEl, original } = extensionEditingState;
  const track = MaweMultiSubtitleCore.getExtensionTrack(trackId);
  const segment = track?.segments?.[index];
  textEl.removeAttribute('contenteditable');
  el.classList.remove('editing');
  if (segment && save) {
    const nextText = textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
    if (nextText !== original) {
      MaweHistory.pushUndo('编辑副字幕');
      segment.text = nextText;
      segment._dirty = true;
      MaweMultiSubtitleCore.markMultiSubtitleDirty();
      MaweServerSave.scheduleAutoSaveFlush();
    }
  }
  if (segment) {
    setTextHtml(textEl, segment.text || '', MaweDom.searchEl.value);
    applyCharCount(
      el.querySelector('.charcount'),
      segment.text || '',
      MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, segment),
    );
  }
  MaweCoreState.waveformEditor?.refreshExtensionCueLabel(index, trackId);
  syncCuePanelAfterInlineEdit('extension', index, trackId);
  extensionEditingState = null;
  MawePlaybackLoop.refreshSubtitlePreview();
}

function bindExtensionCueEvents(el, index, track = MaweMultiSubtitleCore.getActiveExtensionTrack(), dualRow = null) {
  if (!el || !track?.segments?.[index]) return;
  let pointerDown = null;
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (extensionEditingState?.el === el)) return;
    event.stopPropagation();
    if (event.altKey) {
      event.preventDefault();
      MaweStickerPicker.toggleDisabled([index], track);
      pointerDown = null;
      return;
    }
    pointerDown = { x: event.clientX, y: event.clientY };
    if (event.shiftKey && lastClickedExtensionIdx >= 0) selectExtensionRange(lastClickedExtensionIdx, index);
    else if (event.ctrlKey || event.metaKey) toggleExtensionSelection(index);
    else selectOnlyExtension(index);
    lastClickedExtensionIdx = index;
  });
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!pointerDown) return;
    pointerDown = null;
    const segment = track.segments[index];
    const previousSuppress = MawePlaybackLoop.suppressCueListAutoScroll;
    // 副字幕点击后 seek 会同步刷新主字幕 active 状态；这次刷新不能把
    // 列表从刚点击的副字幕行再次滚到对应的主字幕行。
    MawePlaybackLoop.suppressCueListAutoScroll = true;
    try {
      MaweCoreState.waveformEditor?.revealTime(segment.start, true);
      if (MaweSettings.EDITOR_SETTINGS.clickBehavior !== 'select-only') MaweTextCleanup.seekFromWaveform(segment.start / 1000);
    } finally {
      MawePlaybackLoop.suppressCueListAutoScroll = previousSuppress;
    }
    if (MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick) {
      const currentRow = MaweCoreState.container.querySelector(
        `.multi-dual-cue[data-ext-idx="${index}"], .multi-extension-cue[data-ext-idx="${index}"]`,
      );
      scrollCueToCenter(currentRow || dualRow || el);
    }
  });
  el.addEventListener('pointermove', (event) => {
    event.stopPropagation();
    if (extensionEditingState?.el === el) {
      hideCueSplitPreview();
      return;
    }
    cueListPointer = {
      kind: 'extension',
      idx: index,
      trackId: track.id,
      x: event.clientX,
      y: event.clientY,
    };
    scheduleCueSplitPreview(index, event.clientX, event.clientY, 'extension', track.id);
  });
  el.addEventListener('pointerleave', () => {
    if (cueListPointer?.kind === 'extension'
        && cueListPointer.idx === index
        && cueListPointer.trackId === track.id) {
      cueListPointer = null;
      hideCueSplitPreview();
    }
  });
  el.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    startExtensionEdit(el, index, track, event.clientX, event.clientY, { deferCaret: true });
  });
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    MaweContextMenus.showExtensionContextMenu(event.clientX, event.clientY, index, null, track);
  });
}

function startEdit(el, idx, clickX, clickY, { deferCaret = false } = {}) {
  if (editingState) finishEdit(true);
  hideCueSplitPreview();
  const textEl = el.querySelector('.text');
  if (!textEl) return;
  const seg = MaweBoot.DATA.segments[idx];
  let caretCharOffset = null;
  if (typeof clickX === 'number' && typeof clickY === 'number') {
    caretCharOffset = caretCharFromPoint(textEl, clickX, clickY);
  }
  editingState = { el, idx, textEl, original: seg.text };
  el.classList.add('editing');
  textEl.setAttribute('contenteditable', 'plaintext-only');
  textEl.innerText = seg.text;
  textEl.focus();
  const applyCaret = () => {
    if (!editingState || editingState.el !== el) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (caretCharOffset !== null && textEl.firstChild) {
      const range = document.createRange();
      const node = textEl.firstChild;
      const pos = Math.max(0, Math.min(caretCharOffset, node.textContent.length));
      range.setStart(node, pos);
      range.setEnd(node, pos);
      sel.addRange(range);
    } else {
      const range = document.createRange();
      range.selectNodeContents(textEl);
      sel.addRange(range);
    }
  };
  // 浏览器可能在 dblclick 处理器返回后执行原生的“双击选词”，覆盖刚设置的光标。
  // 延后一轮事件循环，确保双击编辑最终落在鼠标对应的字符位置。
  // 先同步放置一次光标，让编辑状态立即可见；双击原生选词可能在事件返回后
  // 覆盖它，再用下一轮事件循环恢复到鼠标位置。
  applyCaret();
  if (deferCaret) setTimeout(applyCaret, 0);
}

function setEditingCaretOffset(offset) {
  const textEl = editingState?.textEl;
  const node = textEl?.firstChild;
  if (!node || !Number.isFinite(offset)) return false;
  const pos = Math.max(0, Math.min(Math.round(offset), node.textContent.length));
  const range = document.createRange();
  range.setStart(node, pos);
  range.setEnd(node, pos);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function caretOffsetInText(textEl) {
  if (!textEl) return null;
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!textEl.contains(range.startContainer) && range.startContainer !== textEl) return null;
  const preRange = range.cloneRange();
  preRange.selectNodeContents(textEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

function caretInfoFromPoint(root, x, y) {
  if (!root) return null;
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
  else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  }
  if (!range || (!root.contains(range.startContainer) && range.startContainer !== root)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return { offset: pre.toString().length, rect: range.getBoundingClientRect() };
}

function caretCharFromPoint(root, x, y) {
  return caretInfoFromPoint(root, x, y)?.offset ?? null;
}

function finishEdit(save) {
  if (!editingState) return;
  const { el, idx, textEl, original } = editingState;
  textEl.removeAttribute('contenteditable');
  el.classList.remove('editing');
  if (save) {
    const newText = textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
    if (newText !== original) {
      MaweHistory.pushUndo('编辑文本');
      MaweBoot.DATA.segments[idx].text = newText;
      MaweBoot.DATA.segments[idx]._dirty = true;
      el.classList.add('dirty');
      MaweServerSave.scheduleAutoSaveFlush();
    }
  }
  setTextHtml(textEl, MaweBoot.DATA.segments[idx].text, MaweDom.searchEl.value);
  const cntEl = el.querySelector('.charcount');
  if (cntEl) applyCharCount(
    cntEl, MaweBoot.DATA.segments[idx].text, MaweMultiSubtitleCore.getMainSubtitleSplitMode(MaweBoot.DATA.segments[idx]),
  );
  MaweCoreState.waveformEditor?.refreshCueLabel(idx);
  syncCuePanelAfterInlineEdit('main', idx);
  editingState = null;
  MawePlaybackLoop.refreshSubtitlePreview();
}

// === 拆分 ===
let pendingLinkedSplit = null;

function splitTimeForTextOffset(segment, offset) {
  const timing = splitItemsAtChar(segment, offset);
  if (Number.isFinite(timing.splitMs)) return timing.splitMs;
  const text = String(segment?.text || '');
  const safeOffset = Math.max(0, Math.min(text.length, Number(offset) || 0));
  return Number(segment?.start)
    + ((Number(segment?.end) - Number(segment?.start)) * safeOffset) / Math.max(1, text.length);
}

function shouldUseMainSplitTimestamps(segment) {
  return MaweSettings.EDITOR_SETTINGS.splitUseWordTimestamps
    && MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(segment);
}

function notifyMainSplitTimestampFallback(segment) {
  if (!MaweSettings.EDITOR_SETTINGS.splitUseWordTimestamps
      || MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(segment)) return;
  const message = '已勾选“主字幕自动使用时间码拆分”，但当前主字幕没有可用的字词时间码，本次设置不生效，已改用拆分面板。';
  MaweHint.flashHint(window.MAWE_I18N?.translateText?.(message) || message, 'warning');
}

function splitOffsetNearTime(segment, timeMs, splitMode) {
  const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(segment?.text || '', splitMode);
  if (!legalOffsets.length) return null;
  const timestampOffset = MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(segment)
    ? window.AsrEditorUtils.splitCharOffsetAtTime(segment, timeMs)
    : null;
  if (Number.isInteger(timestampOffset)) {
    return legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - timestampOffset) < Math.abs(best - timestampOffset) ? candidate : best
    ), legalOffsets[0]);
  }
  return MULTI_SUBTITLE_UTILS.nearestSubtitleSplitOffset(
    segment.text, timeMs, segment.start, segment.end, splitMode,
  );
}

function splitOffsetNearTextPosition(text, offset, splitMode) {
  const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(text || '', splitMode);
  if (!legalOffsets.length) return null;
  const requested = Math.max(0, Math.min(String(text || '').length, Math.round(Number(offset) || 0)));
  return legalOffsets.reduce((best, candidate) => (
    Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best
  ), legalOffsets[0]);
}

function cleanSplitItems(items, side) {
  const source = Array.isArray(items) ? items : [];
  return source
    .map((item) => ({ ...item, text: String(item?.text || '') }))
    .map((item, index, list) => ({
      ...item,
      text: side === 'left' && index === list.length - 1
        ? MULTI_SUBTITLE_UTILS.applySplitEdgeTrim(item.text, 'end')
        : side === 'right' && index === 0
          ? MULTI_SUBTITLE_UTILS.applySplitEdgeTrim(item.text, 'start')
          : item.text,
    }))
    .filter((item) => item.text && Number.isFinite(item.start)
      && Number.isFinite(item.end) && item.end > item.start);
}

function forceSplitCutForSegments(segments, requestedCutMs) {
  const ranges = (Array.isArray(segments) ? segments : [segments])
    .map((segment) => ({
      start: Number(segment?.start),
      end: Number(segment?.end),
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end));
  if (!ranges.length || ranges.some((range) => range.end - range.start < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2)) {
    return null;
  }
  const lower = Math.max(...ranges.map((range) => range.start + MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS));
  const upper = Math.min(...ranges.map((range) => range.end - MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS));
  if (lower > upper) return null;
  const requested = Number(requestedCutMs);
  const cut = Number.isFinite(requested) ? Math.round(requested) : lower;
  return Math.min(upper, Math.max(lower, cut));
}

function forcedSplitRetryHint() {
  return '当前切点会产生不足 100ms 的一侧；请再次按 B 或 Enter 强制拆分，切点将调整为两侧各至少 100ms';
}

function armForcedSplit(state) {
  if (!state) return false;
  if (!Number.isFinite(state.forceCutMs)) {
    MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
    return false;
  }
  if (state.forceSplitArmed) return true;
  state.forceSplitArmed = true;
  MaweHint.flashHint(forcedSplitRetryHint(), 'warning');
  return false;
}

function splitItemsAtChar(
  segment,
  cursorChar,
  requestedCutMs = null,
  { preserveCutMs = false, forceCut = false } = {},
) {
  const text = String(segment?.text || '');
  const safeOffset = Math.max(0, Math.min(text.length, Math.round(Number(cursorChar) || 0)));
  const segmentStart = Number(segment?.start);
  const segmentEnd = Number(segment?.end);
  const safeSegmentStart = Number.isFinite(segmentStart) ? segmentStart : 0;
  const safeSegmentEnd = Number.isFinite(segmentEnd) && segmentEnd >= safeSegmentStart
    ? segmentEnd : safeSegmentStart;
  const items = Array.isArray(segment?.items) ? segment.items : [];
  const hasItems = items.some((item) => String(item?.text || ''));

  // 用原文查找 item 文本，处理 item 不包含词间空格的常见工程格式。
  // 如果上游 item 文本无法和字幕原文对齐，则退回旧的顺序长度映射，
  // 但后面的时间钳制和副本分组仍然保持一致。
  let searchFrom = 0;
  let aligned = true;
  const records = [];
  for (const item of items) {
    const itemText = String(item?.text || '');
    if (!itemText) continue;
    const textStart = text.indexOf(itemText, searchFrom);
    if (textStart < 0) {
      aligned = false;
      break;
    }
    records.push({ item, textStart, textEnd: textStart + itemText.length, itemText });
    searchFrom = textStart + itemText.length;
  }
  if (!aligned) {
    records.length = 0;
    let textStart = 0;
    for (const item of items) {
      const itemText = String(item?.text || '');
      if (!itemText) continue;
      records.push({ item, textStart, textEnd: textStart + itemText.length, itemText });
      textStart += itemText.length;
    }
  }

  const timeRangeFor = (item) => {
    const rawStart = Number(item?.start);
    const rawEnd = Number(item?.end);
    const start = Math.max(
      safeSegmentStart,
      Number.isFinite(rawStart) ? rawStart : safeSegmentStart,
    );
    const end = Math.min(
      safeSegmentEnd,
      Number.isFinite(rawEnd) ? rawEnd : safeSegmentEnd,
    );
    if (end > start) return { start, end };
    // item 时间完全落在段范围之外（上游工程的病态时间码）：钳制后区间
    // 倒置。丢弃会让词文本从 items 里消失，这里压到越界最近一侧的
    // 最小可表达区间，保留词数据；分配循环仍按文本对齐决定归属侧。
    return Number.isFinite(rawStart) && rawStart >= safeSegmentEnd
      ? { start: Math.max(safeSegmentStart, safeSegmentEnd - 1), end: safeSegmentEnd }
      : { start: safeSegmentStart, end: Math.min(safeSegmentEnd, safeSegmentStart + 1) };
  };
  const previous = [...records].reverse().find((record) => record.textEnd <= safeOffset);
  const next = records.find((record) => record.textStart >= safeOffset);
  const inside = records.find((record) => (
    safeOffset > record.textStart && safeOffset < record.textEnd
  ));
  const requested = Number(requestedCutMs);
  let splitMs = Number.isFinite(requested) ? Math.round(requested) : null;
  // 切点两侧相邻 item 的实际时间区间；else 分支填充，供下方非对称边界使用。
  let previousRange = null;
  let nextRange = null;

  if (inside) {
    const range = timeRangeFor(inside.item);
    const fraction = (safeOffset - inside.textStart) / Math.max(1, inside.textEnd - inside.textStart);
    const interpolated = Math.round(range.start + (range.end - range.start) * fraction);
    if (!preserveCutMs || !Number.isFinite(splitMs)
        || (!forceCut && (splitMs < range.start || splitMs > range.end))) {
      splitMs = interpolated;
    }
  } else {
    if (!records.length && Number.isFinite(splitMs)) {
      splitMs = Math.round(splitMs);
    }
    // 文字切点在 item 边界或词间空白时，吸附到相邻 item 的真实边界：
    // 优先跟随左侧词尾，这会把“模型”后的手工切点从 26526 吸附到
    // “模型”的 end 26680，避免左字幕范围先于完整 item 结束。
    // （连续 item 上两侧相等；有静音空隙时由下方非对称边界接管。）
    previousRange = previous ? timeRangeFor(previous.item) : null;
    nextRange = next ? timeRangeFor(next.item) : null;
    if (records.length && (!preserveCutMs || !Number.isFinite(splitMs))) {
      splitMs = previousRange?.end ?? nextRange?.start ?? null;
    }
  }

  if (!Number.isFinite(splitMs)) {
    const ratio = safeOffset / Math.max(1, text.length);
    splitMs = Math.round(safeSegmentStart + (safeSegmentEnd - safeSegmentStart) * ratio);
  }
  splitMs = Math.max(safeSegmentStart, Math.min(safeSegmentEnd, Math.round(splitMs)));

  // 非对称拆分边界：切点两词之间存在真实静音空隙（如本地 ASR 的
  // “型、”6160-6480 与下一词 6720 起）时，左段停在自家最后一个词的
  // end，右段从自家第一个词的 start 开始，保留真实空隙，而不是把一侧
  // 硬拉过静音。仅在两侧候选都有效且严格正序（timeRangeFor 对病态时间
  // 的钳制可能倒挂）时启用；缺词或缺时间码时落回单一共享切点。
  let leftEndMs = splitMs;
  let rightStartMs = splitMs;
  const prevEdgeMs = previousRange?.end ?? null;
  const nextEdgeMs = nextRange?.start ?? null;
  if (Number.isFinite(prevEdgeMs) && Number.isFinite(nextEdgeMs)
      && nextEdgeMs - prevEdgeMs > 0) {
    leftEndMs = prevEdgeMs;
    rightStartMs = nextEdgeMs;
  }

  const leftItems = [];
  const rightItems = [];
  for (const record of records) {
    const range = timeRangeFor(record.item);
    if (range.end <= range.start) continue;
    const { itemText, textStart, textEnd } = record;
    if (inside === record) {
      const localOffset = Math.max(0, Math.min(itemText.length, safeOffset - textStart));
      const leftText = itemText.slice(0, localOffset);
      const rightText = itemText.slice(localOffset);
      const itemSplitMs = preserveCutMs
        && (forceCut || (splitMs >= range.start && splitMs <= range.end))
        ? splitMs
        : Math.round(range.start + (range.end - range.start)
          * localOffset / Math.max(1, itemText.length));
      if (leftText && rightText && itemSplitMs > range.start && itemSplitMs < range.end) {
        leftItems.push({ ...record.item, text: leftText, start: range.start, end: itemSplitMs });
        rightItems.push({ ...record.item, text: rightText, start: itemSplitMs, end: range.end });
      } else if (leftText && rightText) {
        // 取整后不足以给两侧各留出一个毫秒时，保留完整 item 到更接近
        // 光标的一侧，避免为了制造 0 长 item 而丢失词文本。
        const keepLeft = splitMs >= range.end || localOffset >= itemText.length / 2;
        if (keepLeft) {
          leftItems.push({ ...record.item, text: itemText, start: range.start, end: range.end });
        } else {
          rightItems.push({ ...record.item, text: itemText, start: range.start, end: range.end });
        }
      } else if (leftText && itemSplitMs > range.start) {
        leftItems.push({ ...record.item, text: leftText, start: range.start, end: itemSplitMs });
      } else if (rightText && range.end > itemSplitMs) {
        rightItems.push({ ...record.item, text: rightText, start: itemSplitMs, end: range.end });
      }
      continue;
    }
    if (textEnd <= safeOffset) {
      const end = Math.min(range.end, leftEndMs);
      if (end > range.start) leftItems.push({ ...record.item, start: range.start, end });
    } else if (textStart >= safeOffset) {
      const start = Math.max(range.start, rightStartMs);
      if (range.end > start) rightItems.push({ ...record.item, start, end: range.end });
    } else if (splitMs >= range.start && splitMs <= range.end) {
      // 退回顺序映射或异常 item 文本对齐时，仍不得让 item 穿过字幕边界。
      const end = Math.min(range.end, leftEndMs);
      if (end > range.start) leftItems.push({ ...record.item, start: range.start, end });
    }
  }
  // 病态时间码被钳制到段尾/段头时，可能与相邻 item 挤占同一毫秒槽。
  // 从后往前把前一项的 end 压到后一项的 start，保证 items 递增不重叠；
  // 压到 0 长度的极端病态保留原样，交由保存前的校验暴露问题。
  for (const items of [leftItems, rightItems]) {
    for (let i = items.length - 1; i > 0; i--) {
      if (items[i - 1].end > items[i].start && items[i - 1].start < items[i].start) {
        items[i - 1].end = items[i].start;
      }
    }
  }
  return { leftItems, rightItems, splitMs, leftEndMs, rightStartMs, hasItems };
}

function buildSplitPair(
  segment,
  offset,
  cutMs,
  idBase,
  includeItems = true,
  splitMode = null,
  { preserveCutMs = false, forceCut = false } = {},
) {
  const text = String(segment?.text || '');
  const mode = MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_SPLIT_MODES.has(splitMode)
    ? splitMode : MULTI_SUBTITLE_UTILS.detectSubtitleSplitMode(text);
  const parts = MULTI_SUBTITLE_UTILS.splitSubtitleText(text, offset, mode);
  if (!parts) return null;
  const itemParts = splitItemsAtChar(
    includeItems ? segment : { ...segment, items: [] },
    parts.offset,
    cutMs,
    { preserveCutMs, forceCut },
  );
  const leftItems = cleanSplitItems(itemParts.leftItems, 'left');
  const rightItems = cleanSplitItems(itemParts.rightItems, 'right');
  const splitMs = Number.isFinite(itemParts.splitMs) ? itemParts.splitMs : Math.round(cutMs);
  // 左右两段可各自贴合自家词边界（词间有静音空隙时非对称）。
  const leftEnd = Number.isFinite(itemParts.leftEndMs) ? itemParts.leftEndMs : splitMs;
  const rightStart = Number.isFinite(itemParts.rightStartMs) ? itemParts.rightStartMs : splitMs;
  const segmentStart = Number(segment?.start);
  const segmentEnd = Number(segment?.end);
  if (!Number.isFinite(splitMs)
      || !Number.isFinite(segmentStart)
      || !Number.isFinite(segmentEnd)
      || segmentEnd - segmentStart < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2
      || leftEnd - segmentStart < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
      || segmentEnd - rightStart < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
      || rightStart < leftEnd) return null;
  const left = {
    ...segment,
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId([segment], `${idBase}-a`, 'segment'),
    start: segment.start,
    end: leftEnd,
    text: parts.left,
    items: leftItems.length ? leftItems : null,
    _dirty: true,
  };
  const right = {
    ...segment,
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId([segment, left], `${idBase}-b`, 'segment'),
    start: rightStart,
    end: segment.end,
    text: parts.right,
    items: rightItems.length ? rightItems : null,
    _dirty: true,
  };
  if (segment.sticker) {
    right.sticker = null;
    right.sticker_ref = { name: segment.sticker.name, headIdx: 0 };
  }
  if (segment.color) {
    right.color = null;
    right.color_ref = { name: segment.color.name, headIdx: 0 };
  }
  return { left, right, parts, splitMs };
}

 function linkedSplitState(mainIndex, initial = {}) {
  const main = MaweBoot.DATA.segments[mainIndex];
  const binding = MaweMultiSubtitleCore.bindingForMainIndex(mainIndex);
  const track = binding ? MaweMultiSubtitleCore.getExtensionTrack(binding.track_id) : null;
  const extension = binding ? MaweMultiSubtitleCore.extensionSegmentById(binding.extension_segment_ids?.[0], track) : null;
  if (!main || !binding || !track || !extension) return null;
  // 联动拆分要求主副两侧在共同切点的两边各保留最小时长。副字幕总时长不足、
  // 或两段重叠区间放不下合法切点时，不再直接拒绝：弹窗内会走「只拆主字幕并
  // 解除绑定」的降级路径（仅在主字幕自身可拆时启用）；只有主字幕总时长不足
  // （降级也无从谈起）才提前给出原因。
  const linkedMinSpanMs = MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2;
  if (main.end - main.start < linkedMinSpanMs) {
    MaweHint.flashHint('主字幕总时长不足 200ms，无法联动拆分', 'warning');
    return null;
  }
  const mainMode = MaweMultiSubtitleCore.getMainSubtitleSplitMode(main);
  const extensionMode = MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, extension);
  const hasMainWordTimestamps = MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(main);
  const initialTime = Number.isFinite(initial.timeMs)
    ? initial.timeMs
    : splitTimeForTextOffset(main, initial.mainOffset ?? Math.floor(String(main.text || '').length / 2));
  const useMainWordTimestamps = shouldUseMainSplitTimestamps(main);
  // 关闭自动时间码拆分后，波形入口传入的时间仍是绝对切点；没有波形指针时，
  // 有可用时间码就把初始断点定位到最近的字词边界，但之后仍允许用户自由调整。
  const fixedCutMs = !useMainWordTimestamps && Number.isFinite(initial.timeMs)
    ? Math.round(initial.timeMs) : null;
  // 字幕列表传入的是用户实际指向的文字位置；即使工程有字词时间码，
  // 也不能再用时间反推一次文字位置，否则「就是｜这颗」可能漂移成「就是这｜颗」。
  // 没有列表文字位置时（例如波形/播放头入口）才按时间寻找最近合法断点。
  const hasInitialTextPosition = Number.isFinite(initial.mainOffset);
  const initialMainOffset = hasInitialTextPosition
    ? splitOffsetNearTextPosition(main.text, initial.mainOffset, mainMode)
    : splitOffsetNearTime(main, initialTime, mainMode);
  const initialMainCutMs = fixedCutMs ?? (hasMainWordTimestamps
    ? splitTimeForTextOffset(main, initialMainOffset)
    : splitCutTime(main, initialMainOffset, false));
  const initialOffset = MULTI_SUBTITLE_UTILS.nearestSubtitleSplitOffset(
    extension.text, initialMainCutMs, extension.start, extension.end, extensionMode,
  );
  return {
    kind: 'linked',
    mainIndex,
    mainId: main.id,
    extensionId: extension.id,
    trackId: track.id,
    mainMode,
    mainInteractive: !useMainWordTimestamps,
    mainTimestampLocked: useMainWordTimestamps,
    mainOffset: initialMainOffset,
    mainCutMs: initialMainCutMs,
    offset: initialOffset,
    // 联动拆分只有一个绝对切点；副轨的 offset 只负责选择文字边界。
    cutMs: initialMainCutMs,
    extensionCutMs: initialMainCutMs,
    extensionMode,
    fixedCutMs,
    feedbackPoint: initial.feedbackPoint || null,
    // 列表/编辑区唤起的弹窗提交后，刀光保留在列表原位置而不是波形切点。
    ninjaFromList: initial.ninjaFromList === true,
    cutSource: fixedCutMs != null
      ? 'pointer'
      : useMainWordTimestamps
        ? 'word-timestamps'
        : hasMainWordTimestamps ? 'word-timestamps-default' : 'text-estimate',
    initialLane: hasInitialTextPosition ? 'main' : null,
    locked: false,
  };
}

function mainWaveformSplitState(mainIndex, initial = {}) {
  const main = MaweBoot.DATA.segments[mainIndex];
  if (!main) return null;
  const mainMode = MaweMultiSubtitleCore.getMainSubtitleSplitMode(main);
  const hasMainWordTimestamps = MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(main);
  const initialTime = Number.isFinite(initial.timeMs)
    ? initial.timeMs
    : splitTimeForTextOffset(main, initial.mainOffset ?? Math.floor(String(main.text || '').length / 2));
  const fixedCutMs = Number.isFinite(initial.timeMs) ? Math.round(initial.timeMs) : null;
  const initialOffset = splitOffsetNearTime(main, initialTime, mainMode);
  if (initialOffset == null) return null;
  return {
    kind: 'main',
    mainIndex,
    mainId: main.id,
    offset: initialOffset,
    mainOffset: initialOffset,
    mainCutMs: fixedCutMs ?? (hasMainWordTimestamps
      ? splitTimeForTextOffset(main, initialOffset)
      : splitCutTime(main, initialOffset, false)),
    feedbackPoint: initial.feedbackPoint || null,
    mainMode,
    fixedCutMs,
    cutSource: fixedCutMs != null
      ? 'pointer'
      : hasMainWordTimestamps ? 'word-timestamps-default' : 'text-estimate',
    locked: false,
  };
}

function extensionOnlySplitState(extensionIndex, track, initial = {}) {
  const extension = track?.segments?.[extensionIndex];
  if (!extension || !track) return null;
  // 副字幕独立拆分同样要求总时长能容纳两侧各 100ms；不足时提交必然失败，
  // 直接提示原因，不再打开只会静默失败的弹窗。
  if (extension.end - extension.start < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2) {
    MaweHint.flashHint('副字幕总时长不足 200ms，无法拆分', 'warning');
    return null;
  }
  const extensionMode = MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, extension);
  const hasInitialTextPosition = Number.isFinite(initial.extensionOffset);
  const initialTime = Number.isFinite(initial.timeMs)
    ? initial.timeMs
    : splitTimeForTextOffset(extension, initial.extensionOffset ?? Math.floor(String(extension.text || '').length / 2));
  const fixedCutMs = Number.isFinite(initial.timeMs) ? Math.round(initial.timeMs) : null;
  const initialOffset = hasInitialTextPosition
    ? splitOffsetNearTextPosition(extension.text, initial.extensionOffset, extensionMode)
    : MULTI_SUBTITLE_UTILS.nearestSubtitleSplitOffset(
      extension.text, initialTime, extension.start, extension.end, extensionMode,
    );
  if (!Number.isInteger(initialOffset)) return null;
  return {
    kind: 'extension',
    mainIndex: -1,
    extensionIndex,
    extensionId: extension.id,
    trackId: track.id,
    offset: initialOffset,
    extensionCutMs: fixedCutMs ?? splitTimeForTextOffset(extension, initialOffset),
    feedbackPoint: initial.feedbackPoint || null,
    // 列表/编辑区唤起的弹窗提交后，刀光保留在列表原位置而不是波形切点。
    ninjaFromList: initial.ninjaFromList === true,
    extensionMode,
    fixedCutMs,
    cutSource: fixedCutMs != null ? 'pointer' : 'text-estimate',
    locked: false,
  };
}

function splitLaneElements(lane) {
  return lane === 'main'
    ? { laneEl: MaweDom.multiSubtitleSplitMainLane, textEl: MaweDom.multiSubtitleSplitMainText }
    : { laneEl: MaweDom.multiSubtitleSplitExtensionLane, textEl: MaweDom.multiSubtitleSplitText };
}

function splitLaneLocked(state, lane) {
  return state?.lockedLanes?.[lane] === true;
}

function splitLaneUsesMainTimestamp(state, lane) {
  return lane === 'main' && state?.kind === 'linked' && state.mainTimestampLocked === true;
}

// 键盘可交互：⌚️ 时间码锚定的主轨和已用 Space/点击锁定的 lane 不响应移动键。
function splitLaneKeyboardInteractive(state, lane) {
  return !splitLaneUsesMainTimestamp(state, lane) && !splitLaneLocked(state, lane);
}

function splitLaneSegment(state, lane) {
  if (lane === 'main') return state?.mainIndex >= 0 ? MaweBoot.DATA.segments[state.mainIndex] : null;
  return MaweMultiSubtitleCore.extensionSegmentById(state?.extensionId, MaweMultiSubtitleCore.getExtensionTrack(state?.trackId));
}

// 左右移动：在当前 lane 的合法断点序列中前进/后退一步。
function stepSplitLaneOffset(state, lane, direction) {
  const segment = splitLaneSegment(state, lane);
  const mode = lane === 'main' ? state?.mainMode : state?.extensionMode;
  const current = lane === 'main' ? state?.mainOffset : state?.offset;
  const offsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(segment?.text || '', mode);
  if (!offsets.length) return null;
  if (direction < 0) {
    for (let index = offsets.length - 1; index >= 0; index -= 1) {
      if (offsets[index] < current) return offsets[index];
    }
    return null;
  }
  return offsets.find((offset) => offset > current) ?? null;
}

// 上下移动：按渲染后的视觉行定位。gap 元素样式一致，同一行的 top 相同；
// 行距约等于 line-height（36px），用远小于行距的容差聚类即可。
const SPLIT_LANE_LINE_TOLERANCE_PX = 10;

function splitLaneGapLines(textEl) {
  return Array.from(textEl.querySelectorAll('.multi-subtitle-split-gap'))
    .map((gap) => {
      const rect = gap.getBoundingClientRect();
      return { gap, midX: rect.left + rect.width / 2, midY: rect.top + rect.height / 2 };
    })
    .sort((left, right) => left.midY - right.midY || left.midX - right.midX)
    .reduce((lines, entry) => {
      const current = lines[lines.length - 1];
      if (current && Math.abs(entry.midY - current.midY) <= SPLIT_LANE_LINE_TOLERANCE_PX) {
        current.entries.push(entry);
        return lines;
      }
      lines.push({ midY: entry.midY, entries: [entry] });
      return lines;
    }, []);
}

// 上下移动：目标行上取与当前断点水平距离最近的 gap；单行或越界时返回 null。
function verticalSplitLaneOffset(state, lane, direction) {
  const { textEl } = splitLaneElements(lane);
  if (!textEl) return null;
  const lines = splitLaneGapLines(textEl);
  if (lines.length < 2) return null;
  const currentOffset = lane === 'main' ? state?.mainOffset : state?.offset;
  let anchor = lines.flatMap((line) => line.entries)
    .find((entry) => Number(entry.gap.dataset.offset) === currentOffset);
  if (!anchor) {
    // 当前断点没有 gap 元素（如文字开头）时退回字符锚点，用行中点估算所在行。
    const charRect = Array.from(textEl.querySelectorAll('.multi-subtitle-split-char'))
      .find((char) => Number(char.dataset.offset) === currentOffset)
      ?.getBoundingClientRect();
    if (!charRect) return null;
    const anchorMidY = charRect.top + charRect.height / 2;
    const nearestLine = lines.reduce((best, line) => (
      Math.abs(line.midY - anchorMidY) < Math.abs(best.midY - anchorMidY) ? line : best
    ), lines[0]);
    const target = lines[lines.indexOf(nearestLine) + direction];
    if (!target) return null;
    const anchorMidX = charRect.left + charRect.width / 2;
    const picked = target.entries.reduce((best, entry) => (
      Math.abs(entry.midX - anchorMidX) < Math.abs(best.midX - anchorMidX) ? entry : best
    ), target.entries[0]);
    return picked ? Number(picked.gap.dataset.offset) : null;
  }
  const target = lines[lines.findIndex(
    (line) => line.entries.includes(anchor),
  ) + direction];
  if (!target) return null;
  const picked = target.entries.reduce((best, entry) => (
    Math.abs(entry.midX - anchor.midX) < Math.abs(best.midX - anchor.midX) ? entry : best
  ), target.entries[0]);
  return picked ? Number(picked.gap.dataset.offset) : null;
}

// 键盘操作的 lane：优先看真实焦点，失焦（如点到复选框）时回退到上次记录。
function splitKeyboardActiveLane(state) {
  if (document.activeElement === MaweDom.multiSubtitleSplitMainText) return 'main';
  if (document.activeElement === MaweDom.multiSubtitleSplitText) return 'extension';
  return state?.keyboardLane || null;
}

function splitLaneVisible(lane) {
  const { laneEl } = splitLaneElements(lane);
  return Boolean(laneEl && !laneEl.hidden);
}

function focusSplitLane(state, lane) {
  const { textEl } = splitLaneElements(lane);
  if (!textEl || !splitLaneVisible(lane)) return false;
  textEl.focus({ preventScroll: true });
  if (state) state.keyboardLane = lane;
  return true;
}

// Tab 在主/副 lane 间切换：仅在联动模式且主轨可交互时可用。
function splitKeyboardSwitchLane(state, current) {
  if (state?.kind !== 'linked') return null;
  if (splitLaneUsesMainTimestamp(state, 'main')) return null;
  if (current === 'main') return 'extension';
  if (current === 'extension') return 'main';
  return 'main';
}

// Space 与鼠标点击同语义：锁定当前断点；再按一次解锁以便继续移动。
function toggleSplitLaneKeyboardLock(state, lane) {
  if (state !== pendingLinkedSplit || !state.lockedLanes) return;
  if (splitLaneUsesMainTimestamp(state, lane)) return;
  state.lockedLanes[lane] = !splitLaneLocked(state, lane);
  updateLinkedSplitLockVisual();
  if (!splitLaneLocked(state, lane)) return;
  const submitted = maybeAutoSubmitLinkedSplit(state);
  // 键盘锁定后自动聚焦下一条未锁定的 lane（若有），WASD/空格 可连续操作；
  // 自动提交已接管或弹窗已关闭（提交成功）时不再移动焦点。
  if (submitted || state !== pendingLinkedSplit) return;
  const nextLane = splitKeyboardSwitchLane(state, lane);
  if (nextLane && !splitLaneLocked(state, nextLane)) focusSplitLane(state, nextLane);
}

// 已锁定的 lane 上按移动键：闪烁边缘并提示先解锁再移动。
function flashSplitLaneBlockedFeedback(lane) {
  const { textEl } = splitLaneElements(lane);
  if (textEl) {
    textEl.classList.remove('lane-move-blocked');
    void textEl.offsetWidth; // 强制重排，让动画可以重新触发
    textEl.classList.add('lane-move-blocked');
    textEl.addEventListener('animationend', () => {
      textEl.classList.remove('lane-move-blocked');
    }, { once: true });
  }
  MaweHint.flashHint('请先按空格解除锁定，然后再进行移动', 'invalid');
}

function syncLinkedSplitTime(state, activeLane, main, extension) {
  if (state?.kind !== 'linked' || !main || !extension) return;

  // 默认的主轨字词时间码是固定锚点；关闭该设置后，未锁定的当前 lane
  // 才能推动共享切点。另一条 lane 的文字 offset 随共享时间吸附到最近合法边界。
  const absoluteFixed = Number.isFinite(state.fixedCutMs);
  const mainFixed = !state.mainInteractive || splitLaneLocked(state, 'main');
  const extensionFixed = splitLaneLocked(state, 'extension');
  let cutMs = state.cutMs;
  if (absoluteFixed) {
    cutMs = state.fixedCutMs;
  } else if (mainFixed) {
    cutMs = state.mainCutMs;
  } else if (extensionFixed) {
    cutMs = state.extensionCutMs;
  } else {
    const source = activeLane === 'main' ? main : extension;
    const sourceOffset = activeLane === 'main' ? state.mainOffset : state.offset;
    cutMs = activeLane === 'main'
      && MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(main)
      ? splitTimeForTextOffset(main, sourceOffset)
      : splitCutTime(source, sourceOffset, false);
  }
  if (!Number.isFinite(cutMs)) return;

  const sharedCutMs = Math.round(cutMs);
  state.cutMs = sharedCutMs;
  state.mainCutMs = sharedCutMs;
  state.extensionCutMs = sharedCutMs;

  if (!absoluteFixed && activeLane === 'main' && !extensionFixed) {
    const extensionOffset = MULTI_SUBTITLE_UTILS.nearestSubtitleSplitOffset(
      extension.text, sharedCutMs, extension.start, extension.end, state.extensionMode,
    );
    if (Number.isInteger(extensionOffset)) state.offset = extensionOffset;
  } else if (!absoluteFixed && activeLane === 'extension' && !mainFixed) {
    const mainOffset = MULTI_SUBTITLE_UTILS.nearestSubtitleSplitOffset(
      main.text, sharedCutMs, main.start, main.end, state.mainMode,
    );
    if (Number.isInteger(mainOffset)) state.mainOffset = mainOffset;
  }
}

function splitCutTime(segment, offset, useWordTimestamps = false) {
  if (useWordTimestamps) return Math.round(splitTimeForTextOffset(segment, offset));
  const textLength = Math.max(1, String(segment?.text || '').length);
  return Math.round(Number(segment?.start || 0)
    + ((Number(segment?.end || 0) - Number(segment?.start || 0)) * Number(offset || 0)) / textLength);
}

function setSplitPreviewLine(label, parts) {
  const row = document.createElement('div');
  row.className = 'multi-subtitle-split-preview-line';
  const labelEl = document.createElement('span');
  labelEl.className = 'multi-subtitle-split-preview-label';
  labelEl.textContent = `${label}：`;
  const left = document.createElement('span');
  left.className = 'multi-subtitle-split-preview-left';
  left.textContent = parts.left;
  const separator = document.createElement('span');
  separator.className = 'multi-subtitle-split-preview-separator';
  separator.textContent = ' / ';
  const right = document.createElement('span');
  right.className = 'multi-subtitle-split-preview-right';
  right.textContent = parts.right;
  row.append(labelEl, left, separator, right);
  MaweDom.multiSubtitleSplitPreview.appendChild(row);
}

function updateSplitLaneVisual(state, lane) {
  const { textEl } = splitLaneElements(lane);
  if (!textEl) return;
  const offset = lane === 'main' ? state?.mainOffset : state?.offset;
  const timestampLocked = splitLaneUsesMainTimestamp(state, lane);
  textEl.classList.toggle('timestamp-locked', timestampLocked);
  textEl.querySelectorAll('.multi-subtitle-split-char').forEach((character) => {
    const charOffset = Number(character.dataset.offset || 0);
    character.classList.toggle('split-left', charOffset <= offset);
    character.classList.toggle('split-right', charOffset > offset);
  });
  textEl.querySelectorAll('.multi-subtitle-split-gap').forEach((gap) => {
    gap.classList.toggle('active', Number(gap.dataset.offset) === offset);
    gap.classList.toggle('timestamp-locked', timestampLocked);
  });
}

function renderSplitLane(state, lane) {
  const { laneEl, textEl } = splitLaneElements(lane);
  if (!laneEl || !textEl) return;
  const main = MaweBoot.DATA.segments[state?.mainIndex];
  const track = MaweMultiSubtitleCore.getExtensionTrack(state?.trackId);
  const extension = MaweMultiSubtitleCore.extensionSegmentById(state?.extensionId, track);
  const isMain = lane === 'main';
  const displaySegment = isMain ? main : extension;
  const displayMode = isMain ? state?.mainMode : state?.extensionMode;
  const timestampLocked = splitLaneUsesMainTimestamp(state, lane);
  const heading = laneEl.querySelector('h4');
  if (heading) {
    const headingText = timestampLocked
      ? '⌚️ 主字幕按时间码会拆在这里'
      : isMain ? '主字幕拆分' : '副字幕拆分';
    heading.textContent = window.MAWE_I18N?.translateText?.(headingText) || headingText;
  }
  laneEl.classList.toggle('timestamp-locked-lane', timestampLocked);
  const visible = Boolean(displaySegment) && (isMain
    ? state?.kind === 'main' || state?.mainInteractive || timestampLocked
    : state?.kind !== 'main');
  laneEl.hidden = !visible;
  if (!visible) return;
  textEl.replaceChildren();
  textEl.classList.toggle('timestamp-locked', timestampLocked);
  const legalOffsets = new Set(MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(displaySegment.text, displayMode));
  const characters = Array.from(displaySegment.text || '');
  let offset = 0;
  const appendCharacter = (character, characterOffset) => {
    const characterSpan = document.createElement('span');
    characterSpan.className = 'multi-subtitle-split-char';
    characterSpan.dataset.offset = String(characterOffset);
    characterSpan.textContent = character;
    textEl.appendChild(characterSpan);
  };
  const appendGap = (splitOffset, whitespace = '', extraClass = '') => {
    const gap = document.createElement('span');
    gap.className = 'multi-subtitle-split-gap';
    if (extraClass) gap.classList.add(extraClass);
    gap.dataset.offset = String(splitOffset);
    if (timestampLocked) {
      gap.setAttribute('aria-disabled', 'true');
    } else {
      gap.setAttribute('role', 'button');
      gap.setAttribute('aria-label', `在第 ${splitOffset} 个字符后拆分`);
    }
    // 保留原始空白；只有当前选中的断点通过 CSS 将这个空白替换成剪刀。
    gap.textContent = whitespace;
    textEl.appendChild(gap);
  };
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (/\s/u.test(character)) {
      let runEnd = index;
      let runOffset = offset + character.length;
      while (runEnd + 1 < characters.length && /\s/u.test(characters[runEnd + 1])) {
        runEnd += 1;
        runOffset += characters[runEnd].length;
      }
      if (legalOffsets.has(runOffset)) {
        appendGap(runOffset, characters.slice(index, runEnd + 1).join(''));
      }
      else {
        for (let whitespaceIndex = index; whitespaceIndex <= runEnd; whitespaceIndex += 1) {
          offset += characters[whitespaceIndex].length;
          appendCharacter(characters[whitespaceIndex], offset);
        }
      }
      if (legalOffsets.has(runOffset)) offset = runOffset;
      else offset = runOffset;
      index = runEnd;
      continue;
    }
    if (displayMode === 'word' && MULTI_SUBTITLE_UTILS.isWordSplitConnector(character)) {
      let runEnd = index;
      let runOffset = offset + character.length;
      while (
        runEnd + 1 < characters.length
        && MULTI_SUBTITLE_UTILS.isWordSplitConnector(characters[runEnd + 1])
      ) {
        runEnd += 1;
          runOffset += characters[runEnd].length;
      }
      if (!legalOffsets.has(offset) && !legalOffsets.has(runOffset)) {
        for (let connectorIndex = index; connectorIndex <= runEnd; connectorIndex += 1) {
          offset += characters[connectorIndex].length;
          appendCharacter(characters[connectorIndex], offset);
        }
      } else {
        // 符号本身是独立 token；前一个普通字符后的 gap 已由上方逻辑插入，
        // 这里保留符号，并在符号之后插入另一个零宽断点。
        for (let connectorIndex = index; connectorIndex <= runEnd; connectorIndex += 1) {
          offset += characters[connectorIndex].length;
          appendCharacter(characters[connectorIndex], offset);
        }
        if (legalOffsets.has(runOffset)) appendGap(runOffset, '', 'connector-gap');
      }
      offset = runOffset;
      index = runEnd;
      continue;
    }
    offset += character.length;
    appendCharacter(character, offset);
    if (legalOffsets.has(offset)) {
      const nextCharacter = characters[index + 1];
      const connectorGap = displayMode === 'word'
        && MULTI_SUBTITLE_UTILS.isWordSplitConnector(nextCharacter);
      appendGap(offset, '', connectorGap ? 'connector-gap' : '');
    }
  }
  if (timestampLocked) {
    textEl.setAttribute('aria-label', '主字幕按时间码拆分位置，不可交互');
    textEl.setAttribute('aria-readonly', 'true');
    textEl.setAttribute('aria-disabled', 'true');
    textEl.setAttribute('tabindex', '-1');
    textEl.title = '主字幕按时间码拆分于此处，不可交互';
    textEl.onmousemove = null;
    textEl.onclick = null;
  } else {
    textEl.removeAttribute('aria-readonly');
    textEl.removeAttribute('aria-disabled');
    textEl.setAttribute('tabindex', '0');
    textEl.setAttribute('aria-label', isMain ? '选择主字幕拆分点' : '选择副字幕断点');
    textEl.title = '鼠标移动选择拆分点，左键点击锁定；也可用 WASD/方向键移动，空格确认或取消';
    textEl.onmousemove = (event) => {
      if (splitLaneLocked(pendingLinkedSplit, lane)) return;
      const target = event.target;
      const gap = target?.closest?.('.multi-subtitle-split-gap');
      if (gap && textEl.contains(gap)) {
        updateLinkedSplitPreview(Number(gap.dataset.offset), lane);
        return;
      }
      const rawOffset = caretCharFromPoint(textEl, event.clientX, event.clientY);
      if (rawOffset != null) updateLinkedSplitPreview(rawOffset, lane);
    };
    textEl.onclick = (event) => {
      const current = pendingLinkedSplit;
      if (!current) return;
      if (splitLaneLocked(current, lane)) {
        current.lockedLanes[lane] = false;
        updateLinkedSplitLockVisual();
        return;
      }
      const target = event.target;
      const gap = target?.closest?.('.multi-subtitle-split-gap');
      const rawOffset = gap && textEl.contains(gap)
        ? Number(gap.dataset.offset)
        : caretCharFromPoint(textEl, event.clientX, event.clientY);
      if (rawOffset != null) updateLinkedSplitPreview(rawOffset, lane);
      current.lockedLanes[lane] = true;
      updateLinkedSplitLockVisual();
      maybeAutoSubmitLinkedSplit(current);
    };
  }
  updateSplitLaneVisual(state, lane);
}

function renderLinkedSplitText(state) {
  if (!state) return;
  state.lockedLanes = { main: false, extension: false };
  if (MaweDom.multiSubtitleSplitTimestampHint) {
    MaweDom.multiSubtitleSplitTimestampHint.hidden = state.mainTimestampLocked !== true;
  }
  if (MaweDom.multiSubtitleSplitTitle) {
    MaweDom.multiSubtitleSplitTitle.textContent = state.kind === 'main'
      ? '选择主字幕拆分点'
      : state.kind === 'extension'
        ? '选择副字幕拆分点'
        : state.mainInteractive
          ? '分别选择主字幕和副字幕拆分点'
          : '主字幕按时间码定位，选择副字幕拆分点';
  }
  renderSplitLane(state, 'main');
  renderSplitLane(state, 'extension');
  const initialLane = state.initialLane || (state.kind === 'main'
    ? 'main'
    : state.kind === 'extension'
      ? 'extension'
      : state.mainInteractive ? 'main' : 'extension');
  updateLinkedSplitPreview(
    state.kind === 'main' ? state.mainOffset
      : state.kind === 'extension' ? state.offset : state.mainOffset,
    initialLane,
  );
  // 弹窗打开即聚焦初始 lane，让 WASD/方向键/Space 直接可用；
  // ⌚️ 时间码锚定的主轨不可交互，回落到副轨。
  state.keyboardLane = splitLaneUsesMainTimestamp(state, initialLane) ? 'extension' : initialLane;
  focusSplitLane(state, state.keyboardLane);
}

function updateLinkedSplitLockVisual() {
  const state = pendingLinkedSplit;
  const mainLocked = splitLaneLocked(state, 'main');
  const extensionLocked = splitLaneLocked(state, 'extension');
  MaweDom.multiSubtitleSplitMainText?.classList.toggle('locked', mainLocked);
  MaweDom.multiSubtitleSplitText?.classList.toggle('locked', extensionLocked);
  [
    ['main', MaweDom.multiSubtitleSplitMainText],
    ['extension', MaweDom.multiSubtitleSplitText],
  ].forEach(([lane, textEl]) => {
    if (!textEl) return;
    const timestampLocked = splitLaneUsesMainTimestamp(state, lane);
    textEl.classList.toggle('locked', !timestampLocked && splitLaneLocked(state, lane));
    textEl.title = timestampLocked
      ? '主字幕按时间码拆分于此处，不可交互'
      : splitLaneLocked(state, lane)
        ? '拆分点已锁定，点击或按空格解锁'
        : '鼠标移动选择拆分点，左键点击锁定；也可用 WASD/方向键移动，空格确认或取消';
    textEl.querySelectorAll('.multi-subtitle-split-gap').forEach((gap) => {
      gap.classList.toggle(
        'locked',
        !timestampLocked && splitLaneLocked(state, lane) && gap.classList.contains('active'),
      );
    });
  });
  MaweDom.multiSubtitleSplitPreview?.classList.toggle('locked', mainLocked || extensionLocked);
}

function isSplitAutoSubmitEnabled() {
  return MaweDom.multiSubtitleSplitAutoSubmit
    ? MaweDom.multiSubtitleSplitAutoSubmit.checked
    : MaweSettings.EDITOR_SETTINGS.splitAutoSubmit;
}

function splitAutoSubmitReady(state) {
  if (!state?.valid) return false;
  if (state.kind === 'main') return splitLaneLocked(state, 'main');
  if (state.kind === 'extension') return splitLaneLocked(state, 'extension');
  // 字词时间码已固定主轨切点时，主轨没有可交互的确认步骤。
  const mainReady = !state.mainInteractive || splitLaneLocked(state, 'main');
  return mainReady && splitLaneLocked(state, 'extension');
}

function maybeAutoSubmitLinkedSplit(state) {
  if (state !== pendingLinkedSplit || !isSplitAutoSubmitEnabled() || !splitAutoSubmitReady(state)) {
    return false;
  }
  confirmLinkedSplit();
  return true;
}

function splitCutSourceHint(state) {
  if (state?.cutSource === 'pointer') return '当前切分位置固定为波形指针位置';
  if (state?.cutSource === 'word-timestamps') return '当前切分位置由字词时间码推定';
  if (state?.cutSource === 'word-timestamps-default') return '默认位置参考主字幕字词时间码，可继续调整';
  return '';
}

function renderSplitMeta(text, state) {
  if (!MaweDom.multiSubtitleSplitMeta) return;
  MaweDom.multiSubtitleSplitMeta.replaceChildren();
  MaweDom.multiSubtitleSplitMeta.appendChild(document.createTextNode(text));
  const hint = splitCutSourceHint(state);
  if (!hint) return;
  const hintEl = document.createElement('span');
  hintEl.className = 'multi-subtitle-split-cut-hint';
  const translatedHint = window.MAWE_I18N?.translateText?.(hint) || hint;
  hintEl.textContent = `（${translatedHint}）`;
  MaweDom.multiSubtitleSplitMeta.appendChild(hintEl);
}

function updateLinkedSplitPreview(offset, lane = 'extension') {
  const state = pendingLinkedSplit;
  if (!state) return false;
  const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
  const main = state.mainIndex >= 0 ? MaweBoot.DATA.segments[state.mainIndex] : null;
  const extension = MaweMultiSubtitleCore.extensionSegmentById(state.extensionId, track);
  const mainOnly = state.kind === 'main';
  const extensionOnly = state.kind === 'extension';
  if ((!mainOnly && !extensionOnly && !main) || (!mainOnly && !extension)) return false;

  if (lane === 'main' && main) {
    const requestedOffset = Math.max(0, Math.min(String(main.text || '').length, Math.round(Number(offset) || 0)));
    const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(main.text, state.mainMode);
    if (!legalOffsets.length) return false;
    state.mainOffset = legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - requestedOffset) < Math.abs(best - requestedOffset) ? candidate : best
    ), legalOffsets[0]);
    const mainHasWordTimestamps = MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(main);
    state.mainCutMs = Number.isFinite(state.fixedCutMs)
      ? state.fixedCutMs
      : mainHasWordTimestamps
        ? splitTimeForTextOffset(main, state.mainOffset)
        : splitCutTime(main, state.mainOffset, false);
  } else if (extension) {
    const requestedOffset = Math.max(
      0,
      Math.min(String(extension.text || '').length, Math.round(Number(offset) || 0)),
    );
    const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(extension.text, state.extensionMode);
    if (!legalOffsets.length) return false;
    state.offset = legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - requestedOffset) < Math.abs(best - requestedOffset) ? candidate : best
    ), legalOffsets[0]);
    state.extensionCutMs = Number.isFinite(state.fixedCutMs)
      ? state.fixedCutMs : splitCutTime(extension, state.offset, false);
  }

  if (state.kind === 'linked') syncLinkedSplitTime(state, lane, main, extension);

  const mainMode = state.mainMode || (main && MaweMultiSubtitleCore.getMainSubtitleSplitMode(main));
  const mainParts = main
    ? MULTI_SUBTITLE_UTILS.splitSubtitleText(main.text, state.mainOffset, mainMode)
    : null;
  const extensionParts = extension
    ? MULTI_SUBTITLE_UTILS.splitSubtitleText(extension.text, state.offset, state.extensionMode)
    : null;
  const mainTextValid = !main || Boolean(mainParts);
  const extensionTextValid = !extension || Boolean(extensionParts);
  const mainTimingValid = !main || Boolean(mainParts
    && state.mainCutMs - main.start >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
    && main.end - state.mainCutMs >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS);
  const extensionTimingValid = !extension || Boolean(extensionParts
    && state.extensionCutMs - extension.start >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
    && extension.end - state.extensionCutMs >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS);
  const mainValid = mainTextValid && mainTimingValid;
  const extensionValid = extensionTextValid && extensionTimingValid;
  const valid = mainValid && extensionValid;
  const textValid = mainTextValid && extensionTextValid;
  const forceSegments = [main, extension].filter(Boolean);
  state.cutMs = extensionOnly ? state.extensionCutMs : state.mainCutMs;
  state.textValid = textValid;
  state.timingValid = mainTimingValid && extensionTimingValid;
  state.mainTimingValid = Boolean(mainTimingValid);
  state.forceCutMs = textValid
    ? forceSplitCutForSegments(forceSegments, state.cutMs)
    : null;
  state.forceEligible = textValid && !state.timingValid && Number.isFinite(state.forceCutMs);
  // 联动模式下，副轨无法形成合法拆分（文本断点非法，或最短 100ms 钳制也救不回来）、
  // 而主轨自身仍可拆时，允许降级为「只拆主轨并解除绑定」，避免主轨被副轨阻塞。
  state.mainOnlyFallbackEligible = false;
  if (state.kind === 'linked' && main && extension && mainTextValid && !valid && !state.forceEligible) {
    const mainRescuable = mainTimingValid
      || Number.isFinite(forceSplitCutForSegments([main], state.mainCutMs));
    const extensionRescuable = extensionTextValid && (extensionTimingValid
      || Number.isFinite(forceSplitCutForSegments([extension], state.extensionCutMs)));
    state.mainOnlyFallbackEligible = mainRescuable && !extensionRescuable;
  }
  if (valid) state.forceSplitArmed = false;
  state.valid = valid;
  updateSplitLaneVisual(state, 'main');
  updateSplitLaneVisual(state, 'extension');
  if (MaweDom.multiSubtitleSplitMeta) {
    if (mainOnly) {
      renderSplitMeta(`主轨：${MaweMultiSubtitleCore.splitModeLabel(state.mainMode)} · 切点 ${fmtShort(state.mainCutMs)} · 字符位置 ${state.mainOffset ?? '—'}`, state);
    } else if (extensionOnly) {
      renderSplitMeta(`副轨：${MaweMultiSubtitleCore.splitModeLabel(state.extensionMode)} · 切点 ${fmtShort(state.extensionCutMs)}`, state);
    } else {
      const mainLabel = state.mainTimestampLocked
        ? `⌚️主轨时间码锚点 ${fmtShort(state.mainCutMs)}`
        : state.mainInteractive
          ? `主轨文字断点 ${state.mainOffset ?? '—'}`
          : `主轨字词锚点 ${fmtShort(state.mainCutMs)}`;
      renderSplitMeta(`${mainLabel} · 副轨文字断点 ${state.offset ?? '—'} · 共用绝对切点 ${fmtShort(state.cutMs)}`, state);
    }
  }
  if (MaweDom.multiSubtitleSplitPreview) {
    MaweDom.multiSubtitleSplitPreview.replaceChildren();
    if (mainParts && !extensionOnly) setSplitPreviewLine('主', mainParts);
    if (extensionParts && !mainOnly) setSplitPreviewLine('副', extensionParts);
    if (!mainValid || !extensionValid) {
      const error = document.createElement('div');
      error.textContent = '当前断点无法形成两段合法文本';
      MaweDom.multiSubtitleSplitPreview.appendChild(error);
    }
  }
  if (MaweDom.multiSubtitleSplitError) {
    MaweDom.multiSubtitleSplitError.textContent = valid ? '' : (state.mainOnlyFallbackEligible
      ? '副字幕无法在当前切点形成合法拆分；确认后只拆分主字幕，并解除与副字幕的绑定。'
      : extensionOnly
        ? '副字幕切点必须为两侧各留至少 100ms。'
        : '主字幕和副字幕切点都必须为两侧各留至少 100ms。');
  }
  if (MaweDom.multiSubtitleSplitConfirm) {
    MaweDom.multiSubtitleSplitConfirm.disabled = !valid && !state.mainOnlyFallbackEligible;
  }
  updateLinkedSplitLockVisual();
  return valid;
}

function closeLinkedSplitModal() {
  MaweDom.multiSubtitleSplitModal?.classList.remove('show');
  [MaweDom.multiSubtitleSplitMainText, MaweDom.multiSubtitleSplitText].forEach((textEl) => {
    textEl?.classList.remove('locked');
    textEl?.removeAttribute('title');
  });
  MaweDom.multiSubtitleSplitPreview?.classList.remove('locked');
  pendingLinkedSplit = null;
}

function openMainWaveformSplitModal(mainIndex, timeMs) {
  const state = mainWaveformSplitState(mainIndex, { timeMs });
  if (!state) {
    MaweHint.flashHint('这条字幕没有可用的文字边界', 'invalid');
    return false;
  }
  state.feedbackPoint = MaweCoreState.waveformEditor?.getSplitPointAtTime?.(timeMs, 'main') || null;
  pendingLinkedSplit = state;
  MaweDom.multiSubtitleSplitModal?.classList.add('show');
  renderLinkedSplitText(state);
  return true;
}

function openExtensionSplitModal(
  extensionIndex,
  timeMs,
  track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
  initial = {},
) {
  const state = extensionOnlySplitState(extensionIndex, track, { timeMs, ...initial });
  if (!state) {
    MaweHint.flashHint('这条副字幕没有可用的文字边界', 'invalid');
    return false;
  }
  state.feedbackPoint = state.feedbackPoint
    || MaweCoreState.waveformEditor?.getSplitPointAtTime?.(timeMs, 'extension') || null;
  pendingLinkedSplit = state;
  MaweDom.multiSubtitleSplitModal?.classList.add('show');
  renderLinkedSplitText(state);
  return true;
}

function commitMainWaveformSplit(state, { force = false, successMessage = '已按选择的断点拆分主字幕' } = {}) {
  // 波形入口可能是在当前字幕面板仍有未提交编辑时触发；先完成面板编辑，
  // 再为“拆分”建立快照，确保一次撤销能回到拆分前的完整字幕状态。
  commitCuePanelEdit();
  const mainIndex = state.mainIndex;
  const main = MaweBoot.DATA.segments[mainIndex];
  if (!main) return false;
  const splitMs = force
    ? forceSplitCutForSegments([main], state.cutMs)
    : state.cutMs;
  if (!Number.isFinite(splitMs)) {
    MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
    return false;
  }
  const pair = buildSplitPair(
    main,
    state.mainOffset,
    splitMs,
    main.id || `main-${mainIndex}`,
    true,
    state.mainMode,
    {
      preserveCutMs: force || Number.isFinite(state.fixedCutMs),
      forceCut: force,
    },
  );
  if (!pair) return false;
  const oldMainId = main.id;
  MaweHistory.pushUndo('拆分字幕', { captureView: true });
  clearSelection({ commitCuePanel: false });
  MaweMultiSubtitleCore.removeBindingsForSegmentIds([oldMainId], []);
  MaweBoot.DATA.segments.splice(mainIndex, 1, pair.left, pair.right);
  for (let index = mainIndex + 2; index < MaweBoot.DATA.segments.length; index++) {
    const segment = MaweBoot.DATA.segments[index];
    if (segment.sticker_ref?.headIdx > mainIndex) segment.sticker_ref.headIdx += 1;
    if (segment.color_ref?.headIdx > mainIndex) segment.color_ref.headIdx += 1;
  }
  if (pair.left.sticker) pair.right.sticker_ref = { name: pair.left.sticker.name, headIdx: mainIndex };
  if (pair.left.color) pair.right.color_ref = { name: pair.left.color.name, headIdx: mainIndex };
  MaweMultiSubtitleCore.markMainSegmentsDirty([pair.left, pair.right]);
  rememberTemporaryVisibleSplitCues({ mainSegments: [pair.left, pair.right] });
  closeLinkedSplitModal();
  renderAll();
  selectOnly(mainIndex + 1);
  lastClickedIdx = mainIndex + 1;
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  flashSplitFeedback({
    index: mainIndex,
    track: 'main',
    splitMs,
    feedbackPoint: null,
    listFeedback: false,
  });

  // 弹窗提交的刀光位置由唤起来源决定：列表唤起留在列表，其余落在波形最终切点。
  MaweNinja.triggerNinjaSplitFeedback(MaweNinja.ninjaModalSplitPoint(state, splitMs, 'main'));
  if (successMessage) MaweHint.flashHint(successMessage, 'success');
  return true;
}

// 降级路径：副轨无法形成合法拆分时，只拆主轨并解除与副字幕的绑定。
function commitLinkedSplitMainOnly(state) {
  const main = MaweBoot.DATA.segments[state.mainIndex];
  if (!main) return false;
  let force = false;
  if (!state.mainTimingValid) {
    const mainForceCutMs = forceSplitCutForSegments([main], state.mainCutMs);
    if (!Number.isFinite(mainForceCutMs)) {
      MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
      return false;
    }
    if (!state.forceSplitArmed) {
      state.forceSplitArmed = true;
      MaweHint.flashHint(forcedSplitRetryHint(), 'warning');
      return false;
    }
    force = true;
    state.cutMs = mainForceCutMs;
    state.mainCutMs = mainForceCutMs;
  }
  const committed = commitMainWaveformSplit(state, { force, successMessage: null });
  if (!committed) return false;
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweHint.flashHint('由于副字幕无法在当前切点形成合法拆分，为了拆分主字幕，已解除绑定', 'warning');
  return true;
}

function commitExtensionSplit(state, { force = false } = {}) {
  const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
  const extensionIndex = track?.segments?.findIndex((segment) => segment.id === state.extensionId) ?? -1;
  const extension = track?.segments?.[extensionIndex];
  if (!track || extensionIndex < 0 || !extension) return false;
  const splitMs = force
    ? forceSplitCutForSegments([extension], state.extensionCutMs)
    : state.extensionCutMs;
  if (!Number.isFinite(splitMs)) {
    MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
    return false;
  }
  const pair = buildSplitPair(
    extension,
    state.offset,
    splitMs,
    extension.id || `${track.id}-segment-${extensionIndex}`,
    true,
    state.extensionMode,
    {
      preserveCutMs: force || Number.isFinite(state.fixedCutMs),
      forceCut: force,
    },
  );
  if (!pair) return false;

  const oldExtensionId = extension.id;
  const wasBound = Boolean(MaweMultiSubtitleCore.bindingForExtensionIndex(extensionIndex, track));
  MaweHistory.pushUndo('拆分副字幕', { captureView: true });
  // 一对一绑定无法让一个主段同时指向拆出的两条副轨段；独立拆分后
  // 保留两条副字幕，但解除旧关系，等待用户按需要重新绑定。
  MaweMultiSubtitleCore.removeBindingsForSegmentIds([], [oldExtensionId]);
  track.segments.splice(extensionIndex, 1, pair.left, pair.right);
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  rememberTemporaryVisibleSplitCues({
    extensionSegments: [pair.left, pair.right],
    extensionTrackId: track.id,
  });
  closeLinkedSplitModal();
  clearSelection({ commitCuePanel: false });
  renderAll();
  selectOnlyExtension(extensionIndex + 1);
  lastClickedExtensionIdx = extensionIndex + 1;
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  flashSplitFeedback({
    index: extensionIndex,
    track: 'extension',
    splitMs,
    feedbackPoint: null,
    listFeedback: false,
  });
  // 弹窗提交的刀光位置由唤起来源决定：列表唤起留在列表，其余落在波形最终切点。
  MaweNinja.triggerNinjaSplitFeedback(MaweNinja.ninjaModalSplitPoint(state, splitMs, 'extension'));
  MaweHint.flashHint(
    wasBound
      ? '已独立拆分副字幕并解除原绑定'
      : '已按选择的断点拆分副字幕',
    'success',
  );
  return true;
}

function confirmLinkedSplit() {
  const state = pendingLinkedSplit;
  if (!state) return;
  const previewLane = state.kind === 'main' ? 'main' : 'extension';
  const previewOffset = state.kind === 'main' ? state.mainOffset : state.offset;
  const previewValid = updateLinkedSplitPreview(previewOffset, previewLane);
  let force = false;
  if (!previewValid) {
    // 副轨救不回来而主轨可拆：降级为只拆主轨并解除绑定，主轨不被副轨阻塞。
    if (state.kind === 'linked' && state.mainOnlyFallbackEligible) {
      commitLinkedSplitMainOnly(state);
      return;
    }
    if (!state.textValid) {
      MaweHint.flashHint('当前断点无法把主副字幕文本各拆成两段', 'warning');
      return;
    }
    if (!state.forceEligible) {
      MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
      return;
    }
    if (!state.forceSplitArmed) {
      armForcedSplit(state);
      return;
    }
    force = true;
    state.cutMs = state.forceCutMs;
    state.mainCutMs = state.forceCutMs;
    state.extensionCutMs = state.forceCutMs;
  }
  if (state.kind === 'main') {
    commitMainWaveformSplit(state, { force });
    return;
  }
  if (state.kind === 'extension') {
    commitExtensionSplit(state, { force });
    return;
  }
  const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
  const mainIndex = state.mainIndex;
  const extensionIndex = track?.segments?.findIndex((segment) => segment.id === state.extensionId) ?? -1;
  const main = MaweBoot.DATA.segments[mainIndex];
  const extension = track?.segments?.[extensionIndex];
  const sharedCutMs = Number(state.cutMs);
  if (!Number.isFinite(sharedCutMs)
      || sharedCutMs !== Number(state.mainCutMs)
      || sharedCutMs !== Number(state.extensionCutMs)) {
    MaweHint.flashHint('主字幕和副字幕必须使用同一个绝对切点', 'warning');
    return;
  }
  const mainPair = buildSplitPair(
    main,
    state.mainOffset,
    sharedCutMs,
    main.id || `main-${mainIndex}`,
    true,
    state.mainMode,
    { preserveCutMs: true, forceCut: force },
  );
  const extensionPair = buildSplitPair(
    extension,
    state.offset,
    sharedCutMs,
    extension.id || `extension-${extensionIndex}`,
    true,
    state.extensionMode,
    { preserveCutMs: true, forceCut: force },
  );
  if (!mainPair || !extensionPair || extensionIndex < 0) {
    // 前置时长检查已拦截常见不可拆场景；这里兜底提示，避免弹窗内按键完全无反应。
    MaweHint.flashHint('当前切点无法同时拆分主副字幕，请调整断点位置', 'warning');
    return;
  }
  const oldMainId = main.id;
  const oldExtensionId = extension.id;
  MaweHistory.pushUndo('联动拆分字幕', { captureView: true });
  MaweMultiSubtitleCore.removeBindingsForSegmentIds([oldMainId], [oldExtensionId]);
  MaweBoot.DATA.segments.splice(mainIndex, 1, mainPair.left, mainPair.right);
  if (track) track.segments.splice(extensionIndex, 1, extensionPair.left, extensionPair.right);
  // 主轨数组增加了一项，沿用原有表情包/颜色 headIdx 维护规则。
  for (let index = mainIndex + 2; index < MaweBoot.DATA.segments.length; index++) {
    const segment = MaweBoot.DATA.segments[index];
    if (segment.sticker_ref?.headIdx > mainIndex) segment.sticker_ref.headIdx += 1;
    if (segment.color_ref?.headIdx > mainIndex) segment.color_ref.headIdx += 1;
  }
  if (mainPair.left.sticker) mainPair.right.sticker_ref.headIdx = mainIndex;
  if (mainPair.left.color) mainPair.right.color_ref.headIdx = mainIndex;
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  multi.bindings.push(
    MULTI_SUBTITLE_UTILS.buildSubtitleBinding(mainPair.left, extensionPair.left, track.id),
    MULTI_SUBTITLE_UTILS.buildSubtitleBinding(mainPair.right, extensionPair.right, track.id),
  );
  multi.enabled = true;
  MaweMultiSubtitleCore.markMainSegmentsDirty([mainPair.left, mainPair.right]);
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  rememberTemporaryVisibleSplitCues({
    mainSegments: [mainPair.left, mainPair.right],
    extensionSegments: [extensionPair.left, extensionPair.right],
    extensionTrackId: track.id,
  });
  closeLinkedSplitModal();
  clearSelection({ commitCuePanel: false });
  renderAll();
  selectOnly(mainIndex);
  lastClickedIdx = mainIndex;
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  flashSplitFeedback({
    index: mainIndex,
    track: 'main',
    splitMs: sharedCutMs,
    feedbackPoint: null,
    listFeedback: false,
  });
  flashSplitFeedback({
    index: extensionIndex,
    track: 'extension',
    splitMs: sharedCutMs,
    feedbackPoint: null,
    listFeedback: false,
  });
  // 联动拆分刀光位置由唤起来源决定：列表唤起留在列表，其余落在主轨波形切点。
  MaweNinja.triggerNinjaSplitFeedback(MaweNinja.ninjaModalSplitPoint(state, sharedCutMs, 'main'));
  MaweHint.flashHint('已按同一绝对时间切点联动拆分', 'success');
}

function splitAtCursor(
  feedbackPoint = null,
  { listFeedback = true, cueListAnchor: suppliedCueListAnchor = null } = {},
) {
  if (!editingState) return false;
  const force = editingState.forceSplitArmed === true;
  const { el, idx, textEl } = editingState;
  const sel = window.getSelection();
  if (!sel.rangeCount) {
    finishEdit(false);
    return false;
  }
  const range = sel.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(textEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const cursorOffset = preRange.toString().length;
  const fullText = textEl.innerText.replace(/\r\n?/g, '\n');
  const ninjaFeedbackPoint = feedbackPoint || MaweNinja.ninjaSplitPointFromRange(
    range, textEl, cursorOffset, fullText.length,
  );
  const seg = MaweBoot.DATA.segments[idx];

  if (MaweMultiSubtitleCore.multiSubtitleVisible() && MaweMultiSubtitleCore.bindingForMainIndex(idx)) {
    finishEdit(false);
    pendingLinkedSplit = linkedSplitState(idx, {
      mainOffset: cursorOffset,
      feedbackPoint: ninjaFeedbackPoint,
      ninjaFromList: true,
    });
    if (!pendingLinkedSplit) return;
    MaweDom.multiSubtitleSplitModal?.classList.add('show');
    renderLinkedSplitText(pendingLinkedSplit);
    return;
  }

  if (cursorOffset <= 0 || cursorOffset >= fullText.length) {
    finishEdit(false);
    MaweHint.flashHint('光标必须在词与词之间才能拆分', 'invalid');
    return false;
  }

  let leftText = MULTI_SUBTITLE_UTILS.applySplitEdgeTrim(fullText.slice(0, cursorOffset), 'end');
  let rightText = MULTI_SUBTITLE_UTILS.applySplitEdgeTrim(fullText.slice(cursorOffset), 'start');
  if (!leftText || !rightText) {
    finishEdit(false);
    MaweHint.flashHint('拆分后任一段为空，已取消', 'warning');
    return false;
  }

  // 原字幕总时长不足 200ms 时，无法在原时间范围内让两侧都达到 100ms；
  // 这和“切点靠边、可通过再次按键强制钳制”的情况不同。
  if (seg.end - seg.start < 200) {
    finishEdit(false);
    MaweHint.flashHint('字幕时长不足 200ms，无法拆分', 'warning');
    return false;
  }

  let itemSplit = splitItemsAtChar(seg, cursorOffset);
  let splitMs = itemSplit.splitMs;
  if (!itemSplit.hasItems || !Number.isFinite(splitMs)) {
    const ratio = cursorOffset / fullText.length;
    const t = seg.start + (seg.end - seg.start) * ratio;
    // 无词级时间码时按光标位置拆分；第一次按键仍保留原始切点，
    // 只有第二次强制拆分才把它钳制到两侧各 100ms 的安全范围。
    splitMs = Math.round(t);
  }
  // 左右两段的结算边界：默认跟随共享切点；词级 items 提供非对称切分
  // （左段停在自家最后一词的 end，右段起自首词的 start）时分别取用。
  // 缺词或缺时间码时两者都保持 splitMs，与旧行为一致。
  let leftEnd = splitMs;
  let rightStart = splitMs;
  const resolveSplitBounds = () => {
    let leftEndMs = Number.isFinite(splitMs) ? splitMs : null;
    let rightStartMs = leftEndMs;
    if (itemSplit && itemSplit.hasItems && Number.isFinite(splitMs)
        && Number.isFinite(itemSplit.leftEndMs)) {
      leftEndMs = itemSplit.leftEndMs;
      rightStartMs = Number.isFinite(itemSplit.rightStartMs)
        ? itemSplit.rightStartMs : leftEndMs;
    }
    leftEnd = leftEndMs ?? NaN;
    rightStart = rightStartMs ?? NaN;
  };
  resolveSplitBounds();
  const timingValid = Number.isFinite(leftEnd) && Number.isFinite(rightStart)
    && leftEnd - seg.start >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
    && seg.end - rightStart >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS;
  if (!timingValid && !force) {
    editingState.forceSplitArmed = true;
    MaweHint.flashHint(forcedSplitRetryHint(), 'warning');
    return false;
  }
  if (force) {
    const forcedCut = forceSplitCutForSegments([seg], splitMs);
    if (!Number.isFinite(forcedCut)) {
      finishEdit(false);
      MaweHint.flashHint('字幕时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
      return false;
    }
    splitMs = forcedCut;
    itemSplit = splitItemsAtChar(
      seg,
      cursorOffset,
      splitMs,
      { preserveCutMs: true, forceCut: true },
    );
    resolveSplitBounds();
    if (Number.isFinite(forcedCut)) {
      // 强制拆分承诺两侧各 >= 100ms：当自然词边界使某一侧过短
      // （如最后一个词紧贴字幕末尾）时，该侧退回用户确认的强制切点，
      // 另一侧保留非对称自然边界。
      if (!Number.isFinite(leftEnd) || leftEnd - seg.start < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS) {
        leftEnd = forcedCut;
      }
      if (!Number.isFinite(rightStart) || seg.end - rightStart < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS) {
        rightStart = forcedCut;
      }
      if (rightStart < leftEnd) rightStart = leftEnd;
    }
  }
  // 字幕列表手工拆分允许用户指定任意字符位置，但时间码必须落在实际 item
  // 的安全范围内；当切点在 item 内时，splitItemsAtChar 已为两侧生成 item 副本。
  // 左右边界已在上文（含强制重试的降级调和）结算完毕，这里直接消费。
  const leftItemsClean = cleanSplitItems(itemSplit.leftItems, 'left');
  const rightItemsClean = cleanSplitItems(itemSplit.rightItems, 'right');

  const leftSeg = {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId([seg], `${seg.id || `main-${idx}`}-a`, 'main'),
    start: seg.start, end: leftEnd, text: leftText,
    items: leftItemsClean.length ? leftItemsClean : null,
    sticker: seg.sticker || null,
    sticker_ref: seg.sticker_ref || null,
    color: seg.color || null,
    color_ref: seg.color_ref || null,
    disabled: !!seg.disabled,  // 拆分后两段都继承原禁用状态
    _dirty: true,
  };
  const rightSeg = {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId([seg], `${seg.id || `main-${idx}`}-b`, 'main'),
    start: rightStart, end: seg.end, text: rightText,
    items: rightItemsClean.length ? rightItemsClean : null,
    sticker: null,
    // 如果原 seg 是被引用的 head，右段也成为同一表情包的延续 → 给 ref
    // 如果原 seg 自己是 ref，右段也保持 ref
    sticker_ref: seg.sticker
      ? { name: seg.sticker.name, headIdx: idx }  /* 暂用 idx，下面会修正 */
      : (seg.sticker_ref ? { ...seg.sticker_ref } : null),
    // color 同理：原 seg 是 head → 右段降级为 ref；原 seg 是 ref → 复制 ref
    color: null,
    color_ref: seg.color
      ? { name: seg.color.name, headIdx: idx }
      : (seg.color_ref ? { ...seg.color_ref } : null),
    disabled: !!seg.disabled,  // 拆分后两段都继承原禁用状态
    _dirty: true,
  };

  // renderAll() 会重建整张字幕列表。content-visibility 会在重建后先用估算
  // 行高占位，再为视口附近的行回填真实高度；只保存 scrollTop 无法阻止
  // 当前字幕被累计行高误差顶走。列表来源的拆分因此保存原行的屏幕位置，
  // 重绘后再用左半段恢复这个视觉锚点。
  const cueListAnchor = listFeedback
    ? suppliedCueListAnchor || captureCueListVisualAnchor(el)
    : null;

  textEl.removeAttribute('contenteditable');
  el.classList.remove('editing');
  editingState = null;

  // 拆分会改变 idx；先在任何写入前保存完整快照，再静默清选中，等列表
  // 和波形块覆盖层一次性更新后再选中后半段。这样撤销会恢复原 item 时间。
  MaweHistory.pushUndo('拆分字幕', { captureView: true });
  clearSelection({ silent: true });
  // 关闭多字幕模式时，绑定关系仍保存在工程中；拆分主轨后旧 ID 不再存在，
  // 只移除这条关系，保留隐藏的副字幕供用户重新绑定。
  MaweMultiSubtitleCore.removeBindingsForSegmentIds([seg.id], []);
  MaweBoot.DATA.segments.splice(idx, 1, leftSeg, rightSeg);

  // 修正所有 *_ref.headIdx：在 idx 之后的引用都右移 1
  // 但 leftSeg 在 idx 位置仍是 head（如果它有 sticker/color），rightSeg 的 ref.headIdx=idx 正好对应 leftSeg
  for (let i = idx + 2; i < MaweBoot.DATA.segments.length; i++) {
    const sref = MaweBoot.DATA.segments[i].sticker_ref;
    if (sref && sref.headIdx > idx) sref.headIdx += 1;
    const cref = MaweBoot.DATA.segments[i].color_ref;
    if (cref && cref.headIdx > idx) cref.headIdx += 1;
  }

  rememberTemporaryVisibleSplitCues({ mainSegments: [leftSeg, rightSeg] });
  renderAll({ cueListAnchor });
  selectOnly(idx + 1);
  // 拆分后后半段是新的视觉选中项，也必须成为 Shift+点击的范围锚点。
  lastClickedIdx = idx + 1;
  // 列表来源（B 键悬停等）沿用列表光标坐标；编辑区 Ctrl+Enter 等其余来源
  // 统一回退到波形区实际切点位置，波形上找不到时才用编辑区文字坐标。
  MaweNinja.triggerNinjaSplitFeedback(
    (listFeedback ? (feedbackPoint || ninjaFeedbackPoint) : null)
      || MaweCoreState.waveformEditor?.getSplitPointAtTime?.(splitMs, 'main')
      || ninjaFeedbackPoint,
  );
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  flashSplitFeedback({
    index: idx,
    track: 'main',
    splitMs,
    feedbackPoint: listFeedback ? (feedbackPoint || ninjaFeedbackPoint) : null,
    listFeedback,
  });
  return true;
}

function flashCueSplitAt(idx, clientX, track = 'main') {
  if (!Number.isFinite(clientX)) return false;
  const cue = track === 'extension'
    ? MaweCoreState.container.querySelector(
      `.multi-cue-column.extension[data-ext-idx="${idx}"], .cue[data-ext-idx="${idx}"]`,
    )
    : MaweCoreState.container.querySelector(
      `.multi-cue-column.main[data-main-idx="${idx}"], .cue[data-idx="${idx}"]`,
    );
  if (!cue) return false;
  const rect = cue.getBoundingClientRect();
  const marker = document.createElement('span');
  marker.className = 'cue-split-flash';
  // .cue 的绝对定位子元素以 padding box 为坐标原点；rect.left 是 border box，
  // 还要扣掉左边的 3px 状态边框，否则光条会向右压进字形。
  marker.style.left = `${Math.max(0, Math.min(rect.width, clientX - rect.left - cue.clientLeft))}px`;
  cue.appendChild(marker);
  // 先触发布局，再加动画类，确保连续拆分时每个光条都能独立播放。
  void marker.offsetWidth;
  marker.classList.add('is-active');
  let removed = false;
  let timer = 0;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    if (timer) window.clearTimeout(timer);
    marker.remove();
  };
  marker.addEventListener('animationend', cleanup, { once: true });
  timer = window.setTimeout(cleanup, 800);
  return true;
}

// 拆分来源可能是字幕列表、当前编辑区或弹窗；只有列表来源有可靠的列表坐标，
// 其它来源统一回退到波形时间位置。波形反馈只创建一个短暂标记，不参与播放帧刷新。
function flashSplitFeedback({ index, track = 'main', splitMs, feedbackPoint = null, listFeedback = false } = {}) {
  const timeMs = Number(splitMs);
  const hasListMarker = listFeedback
    && Number.isFinite(feedbackPoint?.clientX)
    && flashCueSplitAt(index, feedbackPoint.clientX, track);
  if (!hasListMarker && Number.isFinite(timeMs)) {
    MaweCoreState.waveformEditor?.flashSplitAtTime?.(timeMs, track);
  }
}

function splitFromContextMenu(idx, x, y, waveformTimeMs = null) {
  const el = MaweCoreState.container.querySelector(`.cue[data-idx="${idx}"]`);
  if (!el) return false;
  if (Number.isFinite(waveformTimeMs)) {
    waveformTimeMs = timelineFrameAlignedMilliseconds(waveformTimeMs);
  }
  // 从非编辑态按 B / 右键拆分时，startEdit() 可能让当前行先发生一次布局
  // 变化；锚点必须取自用户按键前看到的位置，而不是临时编辑态的位置。
  const cueListAnchor = Number.isFinite(waveformTimeMs)
    ? null
    : captureCueListVisualAnchor(el);
  const waveformFeedbackPoint = Number.isFinite(waveformTimeMs)
    ? MaweCoreState.waveformEditor?.getSplitPointAtTime?.(waveformTimeMs, 'main') || null
    : null;
  const listCaretInfo = Number.isFinite(waveformTimeMs)
    ? null : caretInfoFromPoint(el.querySelector('.text'), x, y);
  if (MaweMultiSubtitleCore.multiSubtitleVisible() && MaweMultiSubtitleCore.bindingForMainIndex(idx)) {
    notifyMainSplitTimestampFallback(MaweBoot.DATA.segments[idx]);
    const initial = Number.isFinite(waveformTimeMs)
      ? { timeMs: waveformTimeMs }
      : Number.isFinite(listCaretInfo?.offset)
        ? {
          mainOffset: listCaretInfo.offset,
          feedbackPoint: MaweNinja.ninjaSplitPointFromRect(listCaretInfo.rect),
          ninjaFromList: true,
        }
        : {};
    if (waveformFeedbackPoint) initial.feedbackPoint = waveformFeedbackPoint;
    pendingLinkedSplit = linkedSplitState(idx, initial);
    if (!pendingLinkedSplit) return false;
    MaweDom.multiSubtitleSplitModal?.classList.add('show');
    renderLinkedSplitText(pendingLinkedSplit);
    return false;
  }
  if (Number.isFinite(waveformTimeMs)) {
    if (!shouldUseMainSplitTimestamps(MaweBoot.DATA.segments[idx])) {
      notifyMainSplitTimestampFallback(MaweBoot.DATA.segments[idx]);
      openMainWaveformSplitModal(idx, waveformTimeMs);
      return false;
    }
    const segment = MaweBoot.DATA.segments[idx];
    const cursorOffset = splitOffsetNearTime(
      segment,
      waveformTimeMs,
      MaweMultiSubtitleCore.getMainSubtitleSplitMode(segment),
    );
    if (!Number.isInteger(cursorOffset)) {
      MaweHint.flashHint('这条字幕没有可拆分的文字边界', 'invalid');
      return false;
    }
    startEdit(el, idx);
    if (!setEditingCaretOffset(cursorOffset)) {
      finishEdit(false);
      MaweHint.flashHint('无法定位波形中的拆分位置', 'warning');
      return false;
    }
    const didSplit = splitAtCursor(waveformFeedbackPoint, { listFeedback: false });
    return didSplit;
  }
  // 字幕列表：在指定位置进入编辑，光标定位到 (x,y) 后立即拆分
  const caretInfo = listCaretInfo || caretInfoFromPoint(el.querySelector('.text'), x, y);
  const markerX = Number.isFinite(caretInfo?.rect?.left) ? caretInfo.rect.left : x;
  // 先在非编辑态记录文字偏移；进入 contenteditable 后字体/边界可能变化，
  // 再次用同一坐标命中会把「就是｜这颗」漂移到下一个字符。
  startEdit(el, idx);
  if (Number.isFinite(caretInfo?.offset)) setEditingCaretOffset(caretInfo.offset);
  return splitAtCursor(
    { clientX: markerX, clientY: caretInfo?.rect?.top ?? y },
    { listFeedback: true, cueListAnchor },
  );
}

// === 合并 ===
// 把 DATA.segments 中连续下标 sorted 合并为一条，并维护 group 引用与组时间范围。
// 不做参数校验、撤销与渲染，由调用方负责（mergeSegments / autoMergeSegments 共用）。
function mergeContiguousIndices(sorted) {
  const segs = sorted.map(i => MaweBoot.DATA.segments[i]);
  const mergeStart = segs[0]?.start;
  const mergeEnd = segs[segs.length - 1]?.end;
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const extensionTrack = MaweMultiSubtitleCore.multiSubtitleVisible() ? MaweMultiSubtitleCore.getActiveExtensionTrack() : null;
  const oldMainIds = segs.map((segment) => segment.id).filter(Boolean);
  const boundExtensionIds = new Set();
  if (extensionTrack) {
    oldMainIds.forEach((mainId) => {
      const binding = MULTI_SUBTITLE_UTILS.bindingForSegment(multi, mainId, 'main');
      (binding?.extension_segment_ids || []).forEach((extensionId) => boundExtensionIds.add(extensionId));
    });
  }
  const hasMeaningfulExtensionOverlap = (segment) => {
    const overlapStart = Math.max(Number(segment.start), Number(mergeStart));
    const overlapEnd = Math.min(Number(segment.end), Number(mergeEnd));
    return Number.isFinite(overlapStart) && Number.isFinite(overlapEnd)
      && overlapEnd - overlapStart >= MaweMultiSubtitleCore.MULTI_SUBTITLE_MERGE_OVERLAP_TOLERANCE_MS;
  };
  const extensionMergeIndices = extensionTrack
    ? extensionTrack.segments.map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => boundExtensionIds.has(segment.id)
        || hasMeaningfulExtensionOverlap(segment))
      .map(({ index }) => index)
    : [];
  const extensionMergeSegments = extensionMergeIndices.map((index) => extensionTrack.segments[index]);
  const oldExtensionIds = extensionMergeSegments.map((segment) => segment.id).filter(Boolean);
  const stickerGroup = window.AsrEditorUtils.resolveMergedGroupInheritance(
    MaweBoot.DATA.segments, sorted, 'sticker', 'sticker_ref',
  );
  const colorGroup = window.AsrEditorUtils.resolveMergedGroupInheritance(
    MaweBoot.DATA.segments, sorted, 'color', 'color_ref',
  );
  const commonSpeaker = segs[0].speaker != null
    && segs.every((segment) => segment.speaker === segs[0].speaker)
    ? segs[0].speaker
    : null;
  const merged = {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
      MaweBoot.DATA.segments, `${segs[0].id || 'main'}-merged`, 'main',
    ),
    start: segs[0].start,
    end: segs[segs.length - 1].end,
    text: window.AsrEditorUtils.joinSegmentTexts(
      segs,
      MaweMultiSubtitleCore.mergeJoinSeparatorForMode(MaweMultiSubtitleCore.getMainSubtitleSplitMode({ text: segs.map((s) => s.text || '').join('\n') })),
    ),
    items: segs.flatMap(s => s.items || []),
    sticker: stickerGroup.head,
    sticker_ref: stickerGroup.ref,
    color: colorGroup.head,
    color_ref: colorGroup.ref,
    ...(commonSpeaker !== null ? { speaker: commonSpeaker } : {}),
    disabled: !!segs[0].disabled,  // 合并后取 index=0 的禁用状态
    _dirty: true,
  };
  if (merged.items.length === 0) merged.items = null;

  let mergedExtension = null;
  if (extensionTrack && extensionMergeSegments.length) {
    mergedExtension = {
      id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
        extensionTrack.segments, `${extensionMergeSegments[0].id || extensionTrack.id}-merged`, `${extensionTrack.id}-segment`,
      ),
      start: Math.min(...extensionMergeSegments.map((segment) => segment.start)),
      end: Math.max(...extensionMergeSegments.map((segment) => segment.end)),
      text: window.AsrEditorUtils.joinSegmentTexts(
        extensionMergeSegments,
        MaweMultiSubtitleCore.mergeJoinSeparatorForMode(MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(extensionTrack, {
          text: extensionMergeSegments.map((s) => s.text || '').join('\n'),
        })),
      ),
      _dirty: true,
    };
    if (extensionMergeSegments.some((segment) => Array.isArray(segment.items))) {
      mergedExtension.items = extensionMergeSegments.flatMap((segment) => segment.items || []);
    }
  }

  MaweMultiSubtitleCore.removeBindingsForSegmentIds(oldMainIds, oldExtensionIds);

  // 选区并非全部同组时，不继承该组；先按删除切点规则重组外部存活成员，
  // 避免合并掉某个 head 后留下悬空引用。
  const mergeSet = new Set(sorted);
  if (stickerGroup.headIdx === null) {
    splitGroupsAtCutPoints(mergeSet, 'sticker', 'sticker_ref');
  }
  if (colorGroup.headIdx === null) {
    splitGroupsAtCutPoints(mergeSet, 'color', 'color_ref');
  }

  MaweBoot.DATA.segments.splice(sorted[0], sorted.length, merged);
  if (extensionTrack && extensionMergeIndices.length) {
    for (let i = extensionMergeIndices.length - 1; i >= 0; i--) {
      extensionTrack.segments.splice(extensionMergeIndices[i], 1);
    }
    if (mergedExtension) extensionTrack.segments.splice(extensionMergeIndices[0], 0, mergedExtension);
    if (mergedExtension) {
      multi.bindings.push(MULTI_SUBTITLE_UTILS.buildSubtitleBinding(merged, mergedExtension, extensionTrack.id));
      if (MaweSettings.EDITOR_SETTINGS.multiSubtitleAutoSyncDuration) {
        // C 合并会重新创建一对绑定字幕；与手动绑定保持一致，按开关
        // 将新副字幕的时间范围同步到合并后的主字幕，并整理副轨冲突。
        MaweMultiSubtitleCore.setExtensionSegmentRange(mergedExtension, merged.start, merged.end);
        MaweMultiSubtitleCore.reconcileExtensionTrack(extensionTrack, [mergedExtension]);
        MaweMultiSubtitleCore.syncBindingOffsets();
      }
    }
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
  }
  // splice 后统一重映射 group head：选区内继承的 head 移到首项，
  // 选区之后的 head 则按减少的字幕数量左移。
  const removedCount = sorted.length - 1;  // 合并把 sorted.length 条变成 1 条
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  function remapRef(ref) {
    if (!ref || !Number.isInteger(ref.headIdx)) return;
    if (ref.headIdx >= first && ref.headIdx <= last) {
      ref.headIdx = first;
    } else if (ref.headIdx > last) {
      ref.headIdx -= removedCount;
    }
  }
  MaweBoot.DATA.segments.forEach((segment) => {
    remapRef(segment.sticker_ref);
    remapRef(segment.color_ref);
  });
  MaweTextCleanup.syncTimelineGroupRanges();
  return merged;
}

function mergeSegments(idxs) {
  if (idxs.length < 2) { MaweHint.flashHint('请选择至少两个字幕块！', 'invalid'); return; }
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  if (sorted.length < 2) { MaweHint.flashHint('请选择至少两个字幕块！', 'invalid'); return; }
  // 确保连续
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      MaweHint.flashHint('选中的字幕必须连续', 'invalid');
      return;
    }
  }
  const sourceEl = MaweCoreState.container.querySelector(`.cue[data-idx="${sorted[0]}"]`);
  const cueListAnchor = captureVisibleCueListVisualAnchor(sourceEl);
  commitCuePanelEdit();
  MaweHistory.pushUndo('合并字幕', { captureView: true });
  clearSelection({ silent: true });
  mergeContiguousIndices(sorted);
  renderAll({ cueListAnchor });
  // 合并完成后选中合并结果，方便继续对这句新字幕操作
  selectOnly(sorted[0]);
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweHint.flashHint(`已合并 ${sorted.length} 条`, 'success');
}

// 只合并副轨连续字幕。副字幕没有主轨的 group 引用和 items，
// 因此这里保留独立轨的文本/时间合并语义；如果被合并段存在一对一绑定，
// 合并后无法同时指向多个主字幕，旧绑定会被移除并提示用户重新绑定。
function mergeExtensionSegments(idxs, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
  if (!track || !idxs?.length) return false;
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  if (sorted.length < 2) {
    MaweHint.flashHint('请选择至少两个副字幕块！', 'invalid');
    return false;
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      MaweHint.flashHint('选中的副字幕必须连续', 'invalid');
      return false;
    }
  }
  const segments = sorted.map((index) => track.segments[index]).filter(Boolean);
  if (segments.length !== sorted.length) return false;
  const sourceEl = MaweCoreState.container.querySelector(`.cue[data-ext-idx="${sorted[0]}"]`);
  const cueListAnchor = captureVisibleCueListVisualAnchor(sourceEl);

  const oldIds = segments.map((segment) => segment.id).filter(Boolean);
  const merged = {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
      track.segments,
      `${segments[0].id || track.id}-merged`,
      `${track.id}-segment`,
    ),
    start: segments[0].start,
    end: segments[segments.length - 1].end,
    text: window.AsrEditorUtils.joinSegmentTexts(
      segments,
      MaweMultiSubtitleCore.mergeJoinSeparatorForMode(MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, {
        text: segments.map((s) => s.text || '').join('\n'),
      })),
    ),
    _dirty: true,
  };
  const hadBindings = oldIds.some((id) => MULTI_SUBTITLE_UTILS.bindingForSegment(
    MaweMultiSubtitleCore.getMultiSubtitleState(), id, 'extension', track.id,
  ));

  MaweHistory.pushUndo('合并副字幕', { captureView: true });
  clearSelection();
  MaweMultiSubtitleCore.removeBindingsForSegmentIds([], oldIds);
  track.segments.splice(sorted[0], sorted.length, merged);
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  renderAll({ cueListAnchor });
  selectOnlyExtension(sorted[0]);
  lastClickedExtensionIdx = sorted[0];
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweHint.flashHint(
    hadBindings
      ? `已合并 ${sorted.length} 条副字幕，原绑定已解除`
      : `已合并 ${sorted.length} 条副字幕`,
    'success',
  );
  return true;
}

function parseSubtitleExtendMs(input) {
  const raw = String(input?.value ?? '').trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function extendSubtitleRanges() {
  const forwardMs = parseSubtitleExtendMs(MaweDom.subtitleExtendForwardInput);
  if (forwardMs === null) {
    MaweHint.flashHint('向前延长时长必须是大于等于 0 的数字', 'invalid');
    return;
  }
  const backwardMs = parseSubtitleExtendMs(MaweDom.subtitleExtendBackwardInput);
  if (backwardMs === null) {
    MaweHint.flashHint('向后延长时长必须是大于等于 0 的数字', 'invalid');
    return;
  }

  const hasSelection = selectedIdxs.size > 0;
  const indices = hasSelection ? [...selectedIdxs] : [];
  if (editingState) finishEdit(false);
  commitCuePanelEdit();
  const plan = window.AsrEditorUtils.planSubtitleExtension(MaweBoot.DATA.segments, indices, {
    forwardMs,
    backwardMs,
    durationMs: MaweMultiSubtitleCore.getSubtitleTimelineDuration(),
  });
  if (plan.changedIndices.length) {
    MaweHistory.pushUndo('延长字幕');
    let linkedChanged = false;
    const changedSegments = [];
    plan.changes.forEach((change) => {
      const segment = MaweBoot.DATA.segments[change.index];
      if (!segment || !change.changed) return;
      const syncPatch = { oldStart: segment.start, oldEnd: segment.end, mode: 'range' };
      // 这里的 items 绝对时间码保持原样，延长只改变字幕段的外壳范围。
      segment.start = change.start;
      segment.end = change.end;
      segment._dirty = true;
      changedSegments.push(segment);
      linkedChanged = MaweMultiSubtitleCore.syncBoundExtensionForMain(segment, syncPatch) || linkedChanged;
    });
    MaweMultiSubtitleCore.markMainSegmentsDirty(changedSegments);
    MaweTextCleanup.syncTimelineGroupRanges();
    if (linkedChanged || MaweMultiSubtitleCore.multiSubtitleVisible()) MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweMultiSubtitleCore.syncBindingOffsets();
    MaweServerSave.scheduleAutoSaveFlush();
    renderAll();
    MawePlaybackLoop.updateWithoutCueListAutoScroll();
  }
  const scope = hasSelection ? `已处理 ${plan.indices.length} 个选中字幕` : `已处理 ${plan.indices.length} 个字幕`;
  MaweHint.flashHint(
    `${scope}：完整延长 ${plan.fullCount} 条，部分延长 ${plan.partialCount} 条，未延长 ${plan.unchangedCount} 条`,
    plan.changedIndices.length ? 'success' : 'warning',
  );
}

// === 拼合字幕 ===
// 把工具窗参数同步到控件；「吸收过短字幕」关闭时禁用短句相关参数。
function syncAutoMergePanelInputs() {
  if (MaweDom.autoMergeGapMsInput) MaweDom.autoMergeGapMsInput.value = String(MaweSettings.EDITOR_SETTINGS.autoMergeGapMs);
  if (MaweDom.autoMergeSnapDirectionSelect) MaweDom.autoMergeSnapDirectionSelect.value = MaweSettings.EDITOR_SETTINGS.autoMergeSnapDirection;
  if (MaweDom.autoMergeAbsorbShortToggle) MaweDom.autoMergeAbsorbShortToggle.checked = MaweSettings.EDITOR_SETTINGS.autoMergeAbsorbShort;
  if (MaweDom.autoMergeShortCountInput) MaweDom.autoMergeShortCountInput.value = String(MaweSettings.EDITOR_SETTINGS.autoMergeShortCount);
  if (MaweDom.autoMergeAbsorbDirectionSelect) MaweDom.autoMergeAbsorbDirectionSelect.value = MaweSettings.EDITOR_SETTINGS.autoMergeAbsorbDirection;
  syncAutoMergeAbsorbFields();
}

function syncAutoMergeAbsorbFields() {
  const enabled = MaweSettings.EDITOR_SETTINGS.autoMergeAbsorbShort;
  if (MaweDom.autoMergeShortCountInput) MaweDom.autoMergeShortCountInput.disabled = !enabled;
  if (MaweDom.autoMergeAbsorbDirectionSelect) MaweDom.autoMergeAbsorbDirectionSelect.disabled = !enabled;
  MaweDom.autoMergePanel?.classList.toggle('absorb-disabled', !enabled);
}

// 一键处理整段工程：相邻间隔不超过 autoMergeGapMs 时按吸附方向拼接；
// 过短的字幕（中文 < N 字 / 英文 < N 词）按吸收方向并入相邻字幕。
function autoMergeSegments() {
  const plan = window.AsrEditorUtils.planAutoMerge(MaweBoot.DATA.segments, {
    gapMs: MaweSettings.EDITOR_SETTINGS.autoMergeGapMs,
    snapDirection: MaweSettings.EDITOR_SETTINGS.autoMergeSnapDirection,
    absorbShort: MaweSettings.EDITOR_SETTINGS.autoMergeAbsorbShort,
    shortCount: MaweSettings.EDITOR_SETTINGS.autoMergeShortCount,
    absorbDirection: MaweSettings.EDITOR_SETTINGS.autoMergeAbsorbDirection,
  });
  if (!plan.snaps.length && !plan.groups.length) {
    MaweHint.flashHint('没有需要拼接/合并的间隔或过短字幕', 'invalid');
    return;
  }
  if (editingState) finishEdit(false);
  commitCuePanelEdit();
  clearSelection({ silent: true });
  MaweHistory.pushUndo('拼接/合并字幕');
  const snappedCount = applyAutoMergeSnapsWithBindings(plan.snaps);
  // 合并从后往前进行，保持靠前组的下标仍然有效
  for (let i = plan.groups.length - 1; i >= 0; i--) {
    mergeContiguousIndices(plan.groups[i]);
  }
  renderAll();
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  const mergedCount = plan.groups.reduce((sum, group) => sum + group.length - 1, 0);
  const parts = [];
  if (snappedCount) parts.push(`吸附 ${snappedCount} 处间隔`);
  if (mergedCount) parts.push(`吸收 ${mergedCount} 条短字幕`);
  MaweHint.flashHint(`已拼接/合并字幕：${parts.join('，')}`, 'success');
}

// 「拼合字幕」的自动延展直接修改主轨边界，不能绕过普通时间编辑使用的
// 绑定同步路径。每个 snap 单独记录旧边界，确保连续间隔同时调整时，副字幕
// 仍按对应的 start/end offset 跟随；Alt 独立拖动不会进入这里。
function applyAutoMergeSnapsWithBindings(snaps) {
  let changed = 0;
  let linkedChanged = false;
  (Array.isArray(snaps) ? snaps : []).forEach((snap) => {
    const segment = MaweBoot.DATA.segments[snap?.index];
    if (!segment || !Number.isFinite(snap?.time)) return;
    const oldStart = segment.start;
    const oldEnd = segment.end;
    const snapChanged = window.AsrEditorUtils.applyAutoMergeSnaps(MaweBoot.DATA.segments, [snap]);
    if (!snapChanged) return;
    changed += snapChanged;
    linkedChanged = MaweMultiSubtitleCore.syncBoundExtensionForMain(segment, {
      oldStart,
      oldEnd,
      edge: snap.edge === 'end' ? 'end' : 'start',
    }) || linkedChanged;
  });
  if (linkedChanged) {
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweMultiSubtitleCore.syncBindingOffsets();
  }
  return changed;
}

// === 组拆分 helper（删除 / 清除颜色 / 清除表情包 通用）===
// cutSet: Set<number> 包含被"切开"的 idx；这些 idx 的 head/ref 字段都会被清空，
//         同时把它们所在 group 的成员从切点处拆开，切点之后的部分重新组队，
//         首条升级为新 head，后续 ref 指向它。
//   - 删除场景：cutSet = 被物理删除的 idx；切完后由调用方负责 splice
//   - 清除场景：cutSet = 被清除 group 字段的 idx；调用方不删除字幕本身
function splitGroupsAtCutPoints(cutSet, headField, refField) {
  function groupHeadOf(seg, idx) {
    if (seg[headField]) return idx;
    if (seg[refField]) return seg[refField].headIdx;
    return -1;
  }
  // 1) 收集所有原始 group：headIdx → [members 升序]
  const groups = new Map();
  MaweBoot.DATA.segments.forEach((s, i) => {
    const g = groupHeadOf(s, i);
    if (g < 0) return;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });

  for (const [oldHeadIdx, members] of groups.entries()) {
    // 把成员按"切点"切成多个连续段
    const sub = [];
    let cur = [];
    for (const m of members) {
      if (cutSet.has(m)) {
        if (cur.length) { sub.push(cur); cur = []; }
      } else {
        cur.push(m);
      }
    }
    if (cur.length) sub.push(cur);

    // 拿原 head 数据作为新 head 的模板（深拷贝）
    const oldHead = MaweBoot.DATA.segments[oldHeadIdx];
    const template = oldHead ? oldHead[headField] : null;
    if (!template) continue;

    sub.forEach((segIdxs, segNo) => {
      if (!segIdxs.length) return;
      const segHeadIdx = segIdxs[0];
      const segLastIdx = segIdxs[segIdxs.length - 1];
      const newStart = MaweBoot.DATA.segments[segHeadIdx].start;
      const newEnd = MaweBoot.DATA.segments[segLastIdx].end;

      if (segNo === 0 && segHeadIdx === oldHeadIdx) {
        // 原 head 还活着且未被切除 → 仅修正其时间范围
        if (oldHead[headField].end !== newEnd || oldHead[headField].start !== newStart) {
          oldHead[headField].end = newEnd;
          oldHead[headField].start = newStart;
        }
      } else {
        // 新段段首升级为 head
        const promoted = JSON.parse(JSON.stringify(template));
        promoted.start = newStart;
        promoted.end = newEnd;
        MaweBoot.DATA.segments[segHeadIdx][headField] = promoted;
        MaweBoot.DATA.segments[segHeadIdx][refField] = null;
        // 段内其余 ref 改指向新 head
        for (let k = 1; k < segIdxs.length; k++) {
          const refSeg = MaweBoot.DATA.segments[segIdxs[k]];
          if (refSeg[refField]) {
            refSeg[refField].headIdx = segHeadIdx;
          }
        }
      }
    });
  }

  // 把切点位置的 head/ref 字段全部清空（调用方期望的副作用）
  cutSet.forEach(i => {
    const s = MaweBoot.DATA.segments[i];
    if (!s) return;
    if (s[headField]) s[headField] = null;
    if (s[refField])  s[refField]  = null;
  });
}

// === 删除 ===
// 删除一组 idx，并智能维持 head/ref 链（"组拆分"语义）：
//   核心规则：被删的任一 idx 都会把它所属的 group 拆成"前段"和"后段"
//     - 前段（idx < 被删 idx 且原本同组）：保留原 head；head 的 .end 收缩到
//       前段最后一个存活的 ref/head 的 .end
//     - 后段（idx > 被删 idx 且原本同组）：第一个存活 ref 晋升为新 head，
//       后续同组 ref 改指向它
//   当被删的是 head：前段为空，整段后段重组（与之前的"head 晋升"语义吻合）
//   当被删的是 ref：head 仍是 head，但 group 被切成两块——这是用户原话
//     "删除中间的 3 → 4 变 head，5 改 ref→4"
function deleteSegments(idxs) {
  if (!idxs.length) return;
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  if (sorted.length === MaweBoot.DATA.segments.length) {
    MaweHint.flashHint('不能删除全部字幕', 'warning');
    return;
  }
  // Commit any pending cue-panel edit and reset panel state BEFORE splicing.
  // Without this, clearSelection() → setCurrentCuePanelIndex(-1) → commitCuePanelEdit()
  // would write the stale panel text to whatever segment now occupies the old index
  // after splice shifts the array — causing wrong-adjacent text overwrites.
  commitCuePanelEdit();
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState();
  MaweHistory.pushUndo(`删除 ${sorted.length} 条字幕`);
  const pairedExtensionIndices = new Set();
  const pairedMainIds = sorted.map((index) => MaweBoot.DATA.segments[index]?.id).filter(Boolean);
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const extensionTrack = MaweMultiSubtitleCore.multiSubtitleVisible() ? MaweMultiSubtitleCore.getActiveExtensionTrack() : null;
  (multi.bindings || []).forEach((binding) => {
    if (!binding.main_segment_ids?.some((id) => pairedMainIds.includes(id))) return;
    const extensionId = binding.extension_segment_ids?.[0];
    const extensionIndex = extensionTrack?.segments?.findIndex((segment) => segment.id === extensionId);
    if (extensionIndex >= 0) pairedExtensionIndices.add(extensionIndex);
  });
  // 关闭多字幕时仍清理已失效的主轨绑定，但不删除隐藏的副字幕。
  MaweMultiSubtitleCore.removeBindingsForSegmentIds(
    pairedMainIds,
    MaweMultiSubtitleCore.multiSubtitleVisible()
      ? [...pairedExtensionIndices].map((index) => extensionTrack?.segments[index]?.id)
      : [],
  );
  const removeSet = new Set(sorted);

  // ---- 用通用 helper 做组拆分（同时清掉被删 idx 的 head/ref 字段）----
  splitGroupsAtCutPoints(removeSet, 'sticker', 'sticker_ref');
  splitGroupsAtCutPoints(removeSet, 'color',   'color_ref');

  // ---- 兜底：清"指向被删 idx 但没被规划"的残余 ref（理论上 splitGroups 已处理）----
  MaweBoot.DATA.segments.forEach((s, i) => {
    if (removeSet.has(i)) return;
    if (s.sticker_ref && removeSet.has(s.sticker_ref.headIdx)) {
      s.sticker_ref = null;
    }
    if (s.color_ref && removeSet.has(s.color_ref.headIdx)) {
      s.color_ref = null;
    }
  });

  // ---- 倒序 splice 实际删除 ----
  for (let i = sorted.length - 1; i >= 0; i--) {
    MaweBoot.DATA.segments.splice(sorted[i], 1);
  }

  // ---- 修正剩余 *_ref.headIdx：减去"前面被删的数量"----
  function shiftHeadIdx(ref) {
    let shift = 0;
    for (const r of sorted) { if (r < ref.headIdx) shift++; else break; }
    if (shift) ref.headIdx -= shift;
  }
  MaweBoot.DATA.segments.forEach(s => {
    if (s.sticker_ref) shiftHeadIdx(s.sticker_ref);
    if (s.color_ref)   shiftHeadIdx(s.color_ref);
  });
  if (extensionTrack && pairedExtensionIndices.size) {
    [...pairedExtensionIndices].sort((a, b) => b - a).forEach((index) => extensionTrack.segments.splice(index, 1));
  }
  if (pairedExtensionIndices.size) MaweMultiSubtitleCore.markMultiSubtitleDirty();
  // 同样修正"刚被晋升为新 head 的段中"指向它的 ref：
  // splitGroups 写入的 refField.headIdx 是删除前的 idx，需要同样位移
  // 上面 shiftHeadIdx 已经覆盖（它扫所有 segments 的所有 ref）
  clearSelection({ silent: true });
  MawePlaybackLoop.lastActive = -1;
  renderAll();
  MaweHint.flashHint(`已删除 ${sorted.length} 条`, 'success');
}

function deleteExtensionSegments(indices, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
  if (!track || !indices?.length) return;
  const sorted = [...new Set(indices)].filter((index) => Number.isInteger(index)
    && index >= 0 && index < track.segments.length).sort((a, b) => a - b);
  if (!sorted.length) return;
  // 先提交并解除编辑区对旧副字幕下标的引用，避免删除前面的段后，
  // 编辑区下标漂移到另一条副字幕。
  commitCuePanelEdit();
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState();
  const ids = sorted.map((index) => track.segments[index]?.id).filter(Boolean);

  // 删除绑定副字幕时沿用主轨删除语义：绑定关系和另一侧字幕一起删除，
  // 这样从任意 lane 删除都能用同一条撤销记录完整恢复。未绑定的副轨段
  // 仍允许单独删除；混合选择时两类操作会分别使用各自的历史记录。
  const pairedMainIndices = new Set();
  const unboundIds = new Set(ids);
  ids.forEach((id) => {
    const binding = MULTI_SUBTITLE_UTILS.bindingForSegment(
      MaweMultiSubtitleCore.getMultiSubtitleState(), id, 'extension', track.id,
    );
    if (!binding) return;
    const mainId = binding.main_segment_ids?.[0];
    const mainIndex = MaweBoot.DATA.segments.findIndex((segment) => segment.id === mainId);
    if (mainIndex >= 0) pairedMainIndices.add(mainIndex);
    unboundIds.delete(id);
  });
  if (pairedMainIndices.size) {
    deleteSegments([...pairedMainIndices]);
  }

  const remainingIndices = track.segments
    .map((segment, index) => unboundIds.has(segment.id) ? index : -1)
    .filter((index) => index >= 0);
  if (!remainingIndices.length) return;

  MaweHistory.pushUndo(`删除 ${sorted.length} 条副字幕`);
  MaweMultiSubtitleCore.removeBindingsForSegmentIds([], [...unboundIds]);
  remainingIndices.reverse().forEach((index) => track.segments.splice(index, 1));
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  selectedExtensionIdxs.clear();
  renderAll();
  MaweHint.flashHint(`已删除 ${remainingIndices.length} 条副字幕`, 'success');
}

// === 滚动 ===
function cueListVisibleBounds() {
  const containerRect = MaweCoreState.container.getBoundingClientRect();
  const toolbar = MaweCoreState.container.querySelector(':scope > .cue-list-toolbar');
  const toolbarRect = toolbar?.getBoundingClientRect();
  const top = toolbarRect
    ? Math.min(containerRect.bottom, Math.max(containerRect.top, toolbarRect.bottom))
    : containerRect.top;
  return { containerRect, top, bottom: containerRect.bottom };
}

// 三种滚动共用一个可取消的操作：布局恢复、主动导航、播放跟随。
// scroll 事件本身不表示用户输入，懒布局和浏览器边界限制也会触发它。
const cueListScroll = { generation: 0, frame: 0, owner: null, following: true, playbackKey: null, mutationAnchor: null, layoutAnchor: null };
const cueListFollowButton = document.getElementById('cue-list-follow');

function invalidateCueListVisualAnchorRestore({ preserveLayoutAnchor = false } = {}) {
  const previousAnchor = cueListScroll.layoutAnchor;
  cueListScroll.generation += 1;
  cancelAnimationFrame(cueListScroll.frame);
  cueListScroll.frame = 0;
  cueListScroll.owner = null;
  cueListScroll.mutationAnchor = null;
  if (!preserveLayoutAnchor) cueListScroll.layoutAnchor = null;
  else queueMicrotask(() => {
    // 同一个输入事件里的新编辑可以承接尚未稳定的阅读位置；单纯点击、
    // 输入等没有启动新布局操作时，不留下可在以后重新夺权的旧锚点。
    if (!cueListScroll.owner && cueListScroll.layoutAnchor === previousAnchor) cueListScroll.layoutAnchor = null;
  });
  // 同时停止浏览器尚未完成的原生滚动动画。
  MaweCoreState.container.scrollTo({ top: MaweCoreState.container.scrollTop, behavior: 'instant' });
}

function setCueListFollowing(enabled) {
  cueListScroll.following = enabled;
  cueListFollowButton?.setAttribute('aria-pressed', String(enabled));
}

function interruptCueListFollowing() {
  invalidateCueListVisualAnchorRestore();
  setCueListFollowing(false);
}

document.addEventListener('pointerdown', (event) => {
  invalidateCueListVisualAnchorRestore({ preserveLayoutAnchor: true });
  // 直接按在容器空白/滚动条上可能开始拖动；普通行点击仍沿用点击设置。
  const rect = MaweCoreState.container.getBoundingClientRect();
  if (event.target === MaweCoreState.container || (MaweCoreState.container.contains(event.target)
      && event.clientX >= rect.right - 14)) {
    cueListScroll.layoutAnchor = null;
    setCueListFollowing(false);
  }
}, true);
MaweCoreState.container.addEventListener('wheel', interruptCueListFollowing, { passive: true });
MaweCoreState.container.addEventListener('touchstart', interruptCueListFollowing, { passive: true });
document.addEventListener('keydown', (event) => {
  invalidateCueListVisualAnchorRestore({ preserveLayoutAnchor: true });
}, true);
// 等播放、弹窗及目标控件先处理输入；被消费的空格不再误归为列表滚动。
// 应用自己消费的列表导航在其导航入口交出跟随，其余原生滚动在冒泡时处理。
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || editingState || extensionEditingState
      || MaweKeyboardTargets.isTextEditingTarget(event) || MaweKeyboardTargets.isNativeKeyboardControl(event) || MaweKeyboardTargets.isPlayerKeyboardTarget(event)) return;
  if (document.querySelector('.modal-mask.show, #ctxmenu.show')
      || event.target?.closest?.('[role="dialog"], [role="menu"]')) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (!(MaweCoreState.container.contains(event.target) || navigationOwner === 'cue-list')) return;
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
    interruptCueListFollowing();
  }
});

function setCueListIdentity(element, segment, track = null) {
  // 身份写在渲染时的 DOM 上；splice / history 后不能再拿旧下标读新数据。
  const prefix = track ? 'ext' : 'main';
  element.dataset[`${prefix}Id`] = segment.id;
  element.dataset[`${prefix}Start`] = String(segment.start);
  if (track) element.dataset.trackId = track.id;
}

function cueListIdentity(element, kind = MaweCuePanelState.currentCuePanelKind) {
  const extension = (kind === 'extension' && element.dataset.extId) || !element.dataset.mainId;
  return {
    kind: extension ? 'extension' : 'main',
    segmentId: extension ? element.dataset.extId : element.dataset.mainId,
    trackId: extension ? element.dataset.trackId : null,
    start: Number(extension ? element.dataset.extStart : element.dataset.mainStart),
  };
}

function captureCueListVisualAnchor(cueEl) {
  if (!cueEl?.isConnected || cueEl.classList.contains('hidden')) return null;
  const { containerRect, top, bottom } = cueListVisibleBounds();
  const rect = cueEl.getBoundingClientRect();
  if (!Number.isFinite(rect.top)) return null;
  const pending = cueListScroll.layoutAnchor;
  const pendingRow = pending && (findCueListRenderAnchor(pending)
    || findCueListRenderAnchor(pending, { replacement: true }));
  // 快速连续编辑时，下一次事务承接上一轮的目标视口，而不是把懒布局
  // 尚未补偿的中间位置当作新的基准。用户导航/滚动已在输入入口清除此值。
  const correction = pendingRow
    ? pending.top - (pendingRow.getBoundingClientRect().top - containerRect.top) : 0;
  const anchor = {
    ...cueListIdentity(cueEl), top: rect.top - containerRect.top + correction,
    scrollTop: MaweCoreState.container.scrollTop,
  };
  // 锚点被删除时，优先保持附近存活字幕自己的屏幕位置。
  anchor.neighbors = [...MaweCoreState.container.querySelectorAll(':scope > .cue:not(.hidden)')]
    .filter(element => element !== cueEl)
    .map(element => ({ element, rect: element.getBoundingClientRect() }))
    .filter(entry => entry.rect.height > 0 && entry.rect.bottom > top && entry.rect.top < bottom)
    .sort((a, b) => Math.abs(a.rect.top - rect.top) - Math.abs(b.rect.top - rect.top))
    .map(entry => ({ ...cueListIdentity(entry.element), top: entry.rect.top - containerRect.top + correction }));
  return anchor;
}

function captureVisibleCueListVisualAnchor(cueEl) {
  if (!cueEl?.isConnected || cueEl.classList.contains('hidden')) return null;
  const rect = cueEl.getBoundingClientRect();
  const { top, bottom } = cueListVisibleBounds();
  if (rect.bottom <= top || rect.top >= bottom) return null;
  return captureCueListVisualAnchor(cueEl);
}

function captureCueListRenderAnchor() {
  if (!MaweCoreState.container?.isConnected) return null;
  const pending = cueListScroll.layoutAnchor;
  const pendingRow = pending && (findCueListRenderAnchor(pending)
    || findCueListRenderAnchor(pending, { replacement: true }));
  if (pendingRow) return captureCueListVisualAnchor(pendingRow);
  const { top, bottom } = cueListVisibleBounds();
  const candidates = [...MaweCoreState.container.querySelectorAll(':scope > .cue:not(.hidden)')];
  const visible = candidates.filter(element => {
    const rect = element.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > top && rect.top < bottom;
  });
  // 使用旧 DOM 的选区而不是可能已改变身份的面板下标。
  const cue = visible.find(element => element.matches('.selected, .selected-extension')
    || element.querySelector('.selected')) || visible.find(element => element.getBoundingClientRect().top >= top)
    || visible[0];
  return captureCueListVisualAnchor(cue) || { scrollTop: MaweCoreState.container.scrollTop };
}

function rememberCueListMutation() {
  const anchor = captureCueListRenderAnchor();
  cueListScroll.mutationAnchor = anchor;
  // 只交给同一个同步编辑事务，未重绘的原地改字不会留下过时视口。
  queueMicrotask(() => {
    if (cueListScroll.mutationAnchor === anchor) cueListScroll.mutationAnchor = null;
  });
}

function findCueListRenderAnchor(anchor, { replacement = false } = {}) {
  if (!anchor?.segmentId) return null;
  return [...MaweCoreState.container.querySelectorAll(':scope > .cue:not(.hidden)')].find(element => {
    const identity = cueListIdentity(element, anchor.kind);
    return identity.kind === anchor.kind && identity.trackId === anchor.trackId
      && (identity.segmentId === anchor.segmentId
        || (replacement && identity.start === anchor.start));
  }) || null;
}

function restoreCueListRenderAnchor(anchor) {
  if (!anchor) return;
  // B 的左段和 C 的首段承接原起点；撤销时同样按这一语义回到源句。
  let cue = findCueListRenderAnchor(anchor) || findCueListRenderAnchor(anchor, { replacement: true });
  let target = anchor;
  if (!cue) {
    for (const neighbor of anchor.neighbors || []) {
      cue = findCueListRenderAnchor(neighbor)
        || findCueListRenderAnchor(neighbor, { replacement: true });
      if (cue) { target = { ...anchor, ...neighbor }; break; }
    }
  }
  restoreCueListVisualAnchor(cue, target);
}

function restoreCueListVisualAnchor(cueEl, anchor, owner = 'restore') {
  invalidateCueListVisualAnchorRestore();
  cueListScroll.playbackKey = playbackCueListKey();
  const generation = cueListScroll.generation;
  cueListScroll.owner = owner;
  cueListScroll.layoutAnchor = owner === 'restore' ? anchor : null;
  const maxFrames = 12;
  let frameCount = 0;
  const restore = () => {
    if (generation !== cueListScroll.generation) return;
    if (cueEl?.isConnected && !cueEl.classList.contains('hidden') && Number.isFinite(anchor?.top)) {
      const { containerRect, top, bottom } = cueListVisibleBounds();
      const rect = cueEl.getBoundingClientRect();
      // 文字不得被 sticky 工具栏盖住；行顶部留白可以在工具栏下，避免
      // 把本来可读的边缘行无谓推移几个像素。内容不足时交给浏览器最小限幅。
      const paddingTop = Math.max(0, Number.parseFloat(getComputedStyle(cueEl).paddingTop) || 0);
      const targetTop = Math.max(top - containerRect.top - paddingTop,
        Math.min(anchor.top, bottom - containerRect.top - 1));
      const delta = rect.top - containerRect.top - targetTop;
      if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
        MaweCoreState.container.scrollTo({ top: MaweCoreState.container.scrollTop + delta, behavior: 'instant' });
      }
    } else if (Number.isFinite(anchor?.scrollTop)) {
      MaweCoreState.container.scrollTo({ top: anchor.scrollTop, behavior: 'instant' });
    }
    // 即使当前帧被边界限幅，也继续这个有界布局窗口。后续行高回填后
    // 滚动范围可能恢复；用户输入通过 generation 取消，而非猜测 scrollTop。
    if (cueEl?.isConnected && ++frameCount < maxFrames) cueListScroll.frame = requestAnimationFrame(restore);
    else { cueListScroll.frame = 0; cueListScroll.owner = null; cueListScroll.layoutAnchor = null; }
  };
  restore();
}

function scrollCueToCenter(cueEl, { owner = 'navigate' } = {}) {
  if (!cueEl || cueEl.classList.contains('hidden')) return;
  invalidateCueListVisualAnchorRestore();
  const { containerRect, top, bottom } = cueListVisibleBounds();
  const rect = cueEl.getBoundingClientRect();
  const inset = Math.min(120, Math.max(48, (bottom - top) * 0.2));
  if (rect.top >= top + inset && rect.bottom <= bottom - inset) return;
  restoreCueListVisualAnchor(cueEl, {
    top: top - containerRect.top + Math.max(0, (bottom - top - rect.height) / 2),
  }, owner);
}
function scrollCueIntoViewIfNeeded(cueEl, options) {
  if (!cueEl || cueEl.classList.contains('hidden')) return;
  const { top, bottom } = cueListVisibleBounds();
  const rect = cueEl.getBoundingClientRect();
  if (rect.top < top || rect.bottom > bottom) scrollCueToCenter(cueEl, options);
}

function playbackCueListElement() {
  if (MaweMultiSubtitleCore.multiSubtitleVisible() && MaweMultiSubtitleCore.getMultiSubtitleState().display_mode === 'extension') {
    const segment = MawePlaybackLoop.extensionSegmentAtTime(MaweCoreState.player.currentTime * 1000);
    return segment ? findCueListRenderAnchor({ kind: 'extension', segmentId: segment.id,
      trackId: MaweMultiSubtitleCore.getActiveExtensionTrack()?.id }) : null;
  }
  const index = MawePlaybackLoop.findActive(MaweCoreState.player.currentTime * 1000);
  return index >= 0 ? MaweCoreState.container.querySelector(`.cue[data-idx="${index}"]`) : null;
}

function playbackCueListKey() {
  const element = playbackCueListElement();
  if (!element) return null;
  const identity = cueListIdentity(element,
    MaweMultiSubtitleCore.getMultiSubtitleState().display_mode === 'extension' ? 'extension' : 'main');
  return `${identity.kind}:${identity.trackId || ''}:${identity.segmentId}`;
}

function resumeCueListFollowing() {
  invalidateCueListVisualAnchorRestore();
  setCueListFollowing(true);
  scrollCueIntoViewIfNeeded(playbackCueListElement(), { owner: 'navigate' });
}
cueListFollowButton?.addEventListener('click', resumeCueListFollowing);

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

// 等待绑定时，点击主/副字幕本身交给各自的选择事件处理；其它空白或
// 非字幕区域视为取消，避免用户进入等待状态后无从退出。
document.addEventListener('pointerdown', (event) => {
  if (!pendingExtensionBinding) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.cue, .waveform-cue-block, #ctxmenu')) return;
  cancelPendingExtensionBinding();
}, true);

document.addEventListener('pointerdown', (e) => {
  if (e.target instanceof Element && e.target.closest('.cue')) lastEditRegion = 'cue-list';
  else if (e.target instanceof Element && e.target.closest('#waveform-pane')) lastEditRegion = 'waveform';
}, true);
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
document.addEventListener('pointerdown', updateNavigationOwner, true);
document.addEventListener('focusin', updateNavigationOwner, true);
document.addEventListener('pointermove', (e) => {
  lastPointerPos = { x: e.clientX, y: e.clientY };
}, true);

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
    const selected = isExtension ? selectedExtensionIdxs : selectedIdxs;
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
    const info = caretInfoFromPoint(textEl, request.clientX, request.clientY);
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
  const target = getCurrentCuePanelTarget();
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
  const mainIndices = [...selectedIdxs];
  const extensionIndices = [...selectedExtensionIdxs];

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

  const panelTarget = getCurrentCuePanelTarget();
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
  if (event.repeat || editingState || extensionEditingState || MaweKeyboardTargets.isTextEditingTarget(event)) return;
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

document.addEventListener('keydown', (event) => handlePointerBoundaryShortcut(event, 'start'));
document.addEventListener('keydown', (event) => handlePointerBoundaryShortcut(event, 'end'));

function hoveredSelectedCueContext() {
  if (!cueListPointer) return null;
  const isExtension = cueListPointer.kind === 'extension';
  const selected = isExtension ? selectedExtensionIdxs : selectedIdxs;
  if (!selected.has(cueListPointer.idx)) return null;
  const track = isExtension ? MaweMultiSubtitleCore.getExtensionTrack(cueListPointer.trackId) : null;
  const el = isExtension
    ? MaweCoreState.container.querySelector(
      `.multi-cue-column.extension[data-ext-idx="${cueListPointer.idx}"], `
        + `.multi-extension-cue[data-ext-idx="${cueListPointer.idx}"]`,
    )
    : MaweCoreState.container.querySelector(`.cue[data-idx="${cueListPointer.idx}"]`);
  if (!el || !el.matches(':hover')) return null;
  const caret = caretInfoFromPoint(el.querySelector('.text'), cueListPointer.x, cueListPointer.y);
  return { ...cueListPointer, el, track, offset: caret?.offset ?? null, caretRect: caret?.rect ?? null };
}

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
      if (lastClickedIdx >= 0) selectRange(lastClickedIdx, idx);
      else selectOnly(idx);
      lastClickedIdx = idx;
      return 'shift';
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      toggleSel(idx);
      lastClickedIdx = idx;
      return 'toggle';
    }

    // 普通单击的选中阶段放在 pointerdown，点击时只做跳转。
    selectCueByClick(idx);
    lastClickedIdx = idx;
    return 'select';
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (editingState && editingState.el === el)) return;
    cueListPointer = { kind: 'main', idx, x: e.clientX, y: e.clientY };

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
      setCurrentCuePanelIndex(idx);
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
    if (editingState?.el === el) {
      hideCueSplitPreview();
      return;
    }
    cueListPointer = { kind: 'main', idx, x: e.clientX, y: e.clientY };
    scheduleCueSplitPreview(idx, e.clientX, e.clientY, 'main');
  });
  el.addEventListener('pointerleave', () => {
    if (cueListPointer?.idx === idx) {
      cueListPointer = null;
      hideCueSplitPreview();
    }
  });

  el.addEventListener('click', (e) => {
    if (editingState && editingState.el === el) return;
    const state = pointerDownState;
    pointerDownState = null;
    // 第一次 pointerdown 已经立即完成选择；双击产生的第二次 click
    // 不重复执行同一套操作，随后仍由 dblclick 进入编辑。
    if (e.detail > 1 || state?.suppressClick) return;

    // 键盘触发 click，或特殊子控件的 click 冒泡到父 cue 时，保留 click 作为后备选择路径。
    if (!state?.handled) selectFromCuePointer(e);

    // 选择已经在 pointerdown 完成；这里仅处理列表滚动、波形定位和媒体 Seek。
    if (MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick && !state?.preserveListScroll) {
      scrollCueToCenter(el);
    }
    MaweCoreState.waveformEditor?.revealTime(MaweBoot.DATA.segments[idx].start, true);
    if (MaweSettings.EDITOR_SETTINGS.clickBehavior !== 'select-only') {
      // 默认只跳转不改动播放状态；“选中并跳转（自动播放）”会在暂停时启动播放。
      const previousSuppress = MawePlaybackLoop.suppressCueListAutoScroll;
      MawePlaybackLoop.suppressCueListAutoScroll = state?.preserveListScroll
        ? true : !MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick;
      try {
        MaweTextCleanup.seekFromWaveform(MaweBoot.DATA.segments[idx].start / 1000);
      } finally {
        MawePlaybackLoop.suppressCueListAutoScroll = state?.preserveListScroll
          ? true : previousSuppress;
      }
      if (state?.preserveListScroll) {
        restoreCueListVisualAnchor(null, { scrollTop: state.listScrollBeforeClick }, 'navigate');
      }
      if (MaweSettings.EDITOR_SETTINGS.clickBehavior === 'select-and-play' && MaweCoreState.player.paused) MaweMediaPlayback.togglePlayback();
    }
  });
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    // 普通双击的第一次 pointerdown 已选中该 cue；只有从特殊子控件触发、且尚未选中时
    // 才补一次选择，避免双击再次提交当前面板并重绘波形布局。
    if (!selectedIdxs.has(idx)) selectOnly(idx);
    window.MAWE_ONBOARDING?.beginRealSplit(idx);
    startEdit(el, idx, e.clientX, e.clientY, { deferCaret: true });
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    MaweContextMenus.showContextMenu(e.clientX, e.clientY, idx);
  });
}

// === 全局键盘 ===
function getSplitKey() { return MaweDom.splitKeySel.value; }  // 'enter' or 'ctrl-enter'

function getConfiguredEnterAction(event) {
  return window.AsrEditorUtils.configuredEnterAction(event, getSplitKey());
}

document.addEventListener('keydown', (e) => {
  if (e.target === MaweDom.cuePanelText) return;
  if (!editingState) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishEdit(false); return; }
  const action = getConfiguredEnterAction(e);
  if (!action || action === 'newline') return;
  e.preventDefault();
  // 拆分会在当前 keydown 事件内打开弹窗；阻止同一 document 上后注册的
  // 弹窗快捷键监听器继续处理这次 Enter，否则它会立刻把新弹窗再次提交。
  e.stopImmediatePropagation();
  if (action === 'split') splitAtCursor();
  else finishEdit(true);
}, true);

document.addEventListener('keydown', (event) => {
  if (!extensionEditingState) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    finishExtensionEdit(false);
    return;
  }
  const action = getConfiguredEnterAction(event);
  if (!action || action === 'newline') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (action === 'save') {
    finishExtensionEdit(true);
    return;
  }
  const state = extensionEditingState;
  const offset = caretOffsetInText(state.textEl);
  const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
  if (!Number.isFinite(offset) || !track?.segments?.[state.index]) {
    MaweHint.flashHint('无法定位副字幕的文字光标', 'warning');
    return;
  }
  finishExtensionEdit(true);
  openExtensionSplitModal(state.index, null, track, { extensionOffset: offset });
}, true);

// Esc：非字幕文本编辑状态下清除当前字幕选择；输入框和内联编辑继续保留原生/编辑行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (MaweDom.timedTextEditModal.classList.contains('show')) {
    e.preventDefault();
    e.stopPropagation();
    MaweTimedTextEdit.requestCloseTimedTextEdit();
    return;
  }
  if (pendingExtensionBinding) {
    e.preventDefault();
    e.stopPropagation();
    cancelPendingExtensionBinding();
    return;
  }
  if (editingState || (selectedIdxs.size === 0 && selectedExtensionIdxs.size === 0)) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (MaweCoreState.waveformEditor?.hasCueDrag?.()) {
    // 拖动中的 Esc 不取消拖动，也不清空选区；拖动仍由 pointerup 正常完成。
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  clearSelection();
});

MaweDom.mediaPlayToggle?.addEventListener('click', MaweMediaPlayback.togglePlayback);
MaweDom.mediaStepBack?.addEventListener('click', () => MaweMediaPlayback.seekMediaBy(-timelineMediaSeekStepMilliseconds() / 1000));
MaweDom.mediaStepForward?.addEventListener('click', () => MaweMediaPlayback.seekMediaBy(timelineMediaSeekStepMilliseconds() / 1000));
MaweDom.mediaSeek?.addEventListener('input', () => {
if (!MaweMediaPlayback.hasLoadedMedia()) return;
MaweCoreState.player.currentTime = Number(MaweDom.mediaSeek.value) || 0;
MawePlaybackLoop.update();
resumeCueListFollowing();
MaweMediaPlayback.syncMediaControls();
});
MaweDom.mediaVolume?.addEventListener('input', () => {
  MaweCoreState.player.volume = Math.min(1, Math.max(0, Number(MaweDom.mediaVolume.value) || 0));
  MaweMediaPlayback.syncMediaControls();
});
MaweDom.mediaPlaybackRate?.addEventListener('change', () => {
  const selectedRate = Number(MaweDom.mediaPlaybackRate.value) || 1;
  const rate = Math.max(0.0625, Math.abs(selectedRate));
  MaweCoreState.player.playbackRate = rate;
  if (MaweJklPlayback.isJklDirectionMode()) {
    const direction = selectedRate < 0 || MaweJklPlayback.jklPlaybackRate < 0 ? -1 : 1;
    MaweJklPlayback.jklPlaybackRate = direction * rate;
  }
  MaweMediaPlayback.syncMediaControls();
});
MaweDom.mediaFullscreen?.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await MaweDom.playerWrap?.requestFullscreen?.();
  } catch (error) {
    MaweHint.flashHint(`无法切换全屏：${error.message || error}`, 'warning');
  }
  MaweMediaPlayback.syncMediaControls();
});
document.addEventListener('fullscreenchange', MaweMediaPlayback.syncMediaControls);

// ←/→：无选中字幕时复用媒体控制条的跳转时长；选中字幕时改为按设置的
// 微调幅度调整时间。Shift+方向键贴合前后边界；Ctrl(Cmd)+方向键调整左边界，
// Ctrl(Cmd)+Shift+方向键调整右边界。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (editingState || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  // 拆分弹窗内方向键用于移动 ✂️ 断点，不再 seek 媒体或微调字幕时间。
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  const target = e.target instanceof Element ? e.target : document.activeElement;
  if (target?.closest?.('.geo-box, input, select, textarea')) return;
  if (target?.closest?.('[role="menu"]')) return;
  if (!MaweKeyboardTargets.isPlaybackKeyboardTarget(e) && MaweKeyboardTargets.isNativeKeyboardControl(e)) return;
  if (MaweKeyboardTargets.isPlayerKeyboardTarget(e)) return;
  const commandKey = e.ctrlKey || e.metaKey;
  const direction = e.key === 'ArrowLeft' ? -1 : 1;
  const panelTarget = getCurrentCuePanelTarget();
  const extensionTarget = panelTarget?.kind === 'extension';
  const activeTrack = extensionTarget ? 'extension' : 'main';
  const selected = extensionTarget ? selectedExtensionIdxs : selectedIdxs;
  if (e.shiftKey && !commandKey) {
    // Shift 是显式的边界贴合命令，不受自动吸附默认值影响；Alt 只反转
    // 普通移动/边界微调的自动联动模式。
    if (selected.size > 0
        && MaweCoreState.waveformEditor?.snapSelectedCueBoundaryByKeyboard?.(direction, activeTrack)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (selected.size > 0 && MaweCoreState.waveformEditor) {
    const deltaTime = direction * timelineCueMoveStepValue();
    if (commandKey) {
      if (e.shiftKey) {
        MaweCoreState.waveformEditor.adjustSelectedBoundaryByKeyboard(deltaTime, 'end', e.altKey, activeTrack);
      } else {
        MaweCoreState.waveformEditor.adjustSelectedBoundaryByKeyboard(deltaTime, 'start', e.altKey, activeTrack);
      }
    } else {
      MaweCoreState.waveformEditor.adjustSelectedByKeyboard(deltaTime, e.altKey, activeTrack);
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (commandKey || e.altKey) return;
  if (!MaweMediaPlayback.hasLoadedMedia()) return;
  e.preventDefault();
  e.stopPropagation();
  MaweMediaPlayback.seekMediaBy(direction * timelineMediaSeekStepMilliseconds() / 1000);
}, true);

function renderedCueBoundaryTarget(target, boundary) {
  const selector = target?.kind === 'extension'
    ? '.multi-dual-cue[data-ext-idx], .multi-extension-cue[data-ext-idx]'
    : '.cue[data-idx], .multi-dual-cue[data-main-idx]';
  const track = target?.kind === 'extension' ? target.track : 'main';
  const indexes = [...MaweCoreState.container.querySelectorAll(selector)]
    .filter((cue) => !cue.classList.contains('hidden'))
    .map((cue) => Number(target?.kind === 'extension'
      ? cue.dataset.extIdx
      : cue.dataset.idx ?? cue.dataset.mainIdx))
    .filter((index, position, values) => (
      Number.isInteger(index)
      && !isHiddenDisabled(index, track)
      && values.indexOf(index) === position
    ));
  const index = boundary === 'first' ? indexes[0] : indexes[indexes.length - 1];
  if (!Number.isInteger(index)) return null;
  const cue = MaweCoreState.container.querySelector(
    target?.kind === 'extension'
      ? `.multi-dual-cue[data-ext-idx="${index}"], .multi-extension-cue[data-ext-idx="${index}"]`
      : `.cue[data-idx="${index}"], .multi-dual-cue[data-main-idx="${index}"]`,
  );
  return cue ? { cue, index } : null;
}

function navigateCueListBoundary(key) {
  const target = getCurrentCuePanelTarget();
  if (!target) return false;
  const boundary = renderedCueBoundaryTarget(target, key === 'Home' ? 'first' : 'last');
  if (!boundary) return false;
  interruptCueListFollowing();
  if (target.kind === 'extension') {
    selectOnlyExtension(boundary.index, target.track);
    lastClickedExtensionIdx = boundary.index;
  } else {
    selectOnly(boundary.index);
    lastClickedIdx = boundary.index;
  }
  scrollCueToCenter(boundary.cue);
  return true;
}

// Home/End：字幕列表最近拥有导航时选择当前轨道首尾；波形、播放器或尚未
// 确定区域时跳转媒体首尾。文本输入、普通按钮和模态窗口保留原生行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Home' && e.key !== 'End') return;
  if (editingState || extensionEditingState || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  if (!MaweKeyboardTargets.isPlaybackKeyboardTarget(e) && MaweKeyboardTargets.isNativeKeyboardControl(e)) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (MaweDom.replaceModal.classList.contains('show') || MaweDom.stickerModal.classList.contains('show')
      || MaweDom.stickerPreviewModal.classList.contains('show') || MaweDom.projectMediaModal.classList.contains('show')
      || MaweDom.multiSubtitleSplitModal?.classList.contains('show')
      || MaweDom.multiSubtitleImportModal?.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || MaweDom.ctxmenu.classList.contains('show')) return;
  if (navigationOwner === 'cue-list' && MaweKeyboardTargets.navigateCueListBoundary(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const duration = Number(MaweCoreState.player?.duration);
  if (!MaweMediaPlayback.hasLoadedMedia() || !Number.isFinite(duration) || duration <= 0) return;
  e.preventDefault();
  e.stopPropagation();
  MaweMediaPlayback.seekMediaTo(e.key === 'Home' ? 0 : duration);
}, true);

// 多重字幕下，上/下只切换当前操作轨道；优先使用绑定关系，没有绑定时
// 选择时间范围重叠最多、否则距离最近的另一轨字幕，不改变播放头位置。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (editingState || extensionEditingState || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (MaweKeyboardTargets.isNativeKeyboardControl(e) || MaweKeyboardTargets.isPlayerKeyboardTarget(e)) return;
  if (MaweDom.replaceModal.classList.contains('show') || MaweDom.stickerModal.classList.contains('show')
      || MaweDom.stickerPreviewModal.classList.contains('show') || MaweDom.projectMediaModal.classList.contains('show')
      || MaweDom.multiSubtitleSplitModal?.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || MaweDom.ctxmenu.classList.contains('show')) return;
  if (!MaweKeyboardTargets.switchMultiSubtitleTrack(e.key === 'ArrowUp' ? -1 : 1)) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// 鼠标点击按钮后不保留按钮焦点，否则下一次空格会触发按钮自身的 click。
// 键盘触发的 click detail 为 0，保留焦点以维持原生键盘可访问性。
document.addEventListener('click', (event) => {
  if (event.detail === 0) return;
  const target = event.target instanceof Element ? event.target : null;
  target?.closest('button')?.blur();
}, true);
document.addEventListener('keydown', (e) => {
  if (!MaweKeyboardTargets.isSpaceKey(e)) return;
  if (editingState || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  // 拆分弹窗内空格用于确认/取消断点，交给弹窗自己的键盘处理。
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (!MaweKeyboardTargets.isPlaybackKeyboardTarget(e) && MaweKeyboardTargets.isNativeKeyboardControl(e)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  MaweShortcuts.interceptedSpace = true;
  if (e.repeat) return;
  MaweMediaPlayback.togglePlayback();
}, true);

document.addEventListener('keyup', (e) => {
  if (!MaweKeyboardTargets.isSpaceKey(e) || !MaweShortcuts.interceptedSpace) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  MaweShortcuts.interceptedSpace = false;
}, true);
window.addEventListener('blur', () => { MaweShortcuts.interceptedSpace = false; });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'j' && e.key !== 'J' && e.key !== 'k' && e.key !== 'K' && e.key !== 'l' && e.key !== 'L') return;
  if (editingState) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  // Ctrl/Alt/Meta 别误触发（让浏览器自己处理 Ctrl+L 等）
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  const k = e.key.toLowerCase();
  if (MaweJklPlayback.isJklDirectionMode()) {
    if (k === 'k') {
      const wasPlaying = MaweJklPlayback.jklReversePlaying || !MaweCoreState.player.paused;
      if (!wasPlaying) {
        MaweJklPlayback.jklPlaybackRate = 1;
        MaweCoreState.player.playbackRate = 1;
        if (MaweJklPlayback.playJklForward()) MaweHint.flashHint('正放: 1×');
        return;
      }
      MaweJklPlayback.stopJklReversePlayback({ render: false });
      MaweJklPlayback.jklPlaybackRate = 1;
      MaweCoreState.player.playbackRate = 1;
      MaweCoreState.player.pause();
      MawePlaybackLoop.update();
      MaweCoreState.waveformEditor?.updatePlayback();
      MaweMediaPlayback.syncMediaControls();
      MaweHint.flashHint('已停止');
      return;
    }
    if (!MaweMediaPlayback.hasLoadedMedia()) {
      MaweHint.flashHint('请先加载媒体，然后才能预览', 'invalid');
      return;
    }
    MaweJklPlayback.jklPlaybackRate = MaweJklPlayback.nextJklDirectionRate(MaweJklPlayback.jklPlaybackRate, k === 'j' ? -1 : 1);
    if (MaweJklPlayback.jklPlaybackRate < 0) MaweJklPlayback.startJklReversePlayback();
    else MaweJklPlayback.playJklForward();
    MaweHint.flashHint(`${MaweJklPlayback.jklPlaybackRate < 0 ? '倒放' : '正放'}: ${MaweShortcuts.fmtRate(MaweJklPlayback.jklPlaybackRate)}`);
    return;
  }
  let r = MaweCoreState.player.playbackRate;
  if (k === 'k') r = 1;
  else if (k === 'j') r = Math.max(MaweShortcuts.PLAYBACK_RATE_MIN, r * 0.5);
  else if (k === 'l') r = Math.min(MaweShortcuts.PLAYBACK_RATE_MAX, r * 2);
  MaweCoreState.player.playbackRate = r;
  MaweMediaPlayback.syncMediaControls();
  MaweHint.flashHint(`倍速: ${MaweShortcuts.fmtRate(r)}`);
});

// A/D（或 W/S）：跳转到上一条/下一条字幕的句首并单选。W/S 与 A/D 等价，对应上下方向。
// Shift+A/D（或 Shift+W/S）：保留当前选择，并向前/后追加选择一条字幕。
// 播放中以播放头所在字幕为基准；播放头处于空隙时，按方向选择其前方/后方字幕。
// 暂停时仍以当前选中字幕为基准。跳转本身不改变播放状态。
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key !== 'a' && key !== 'd' && key !== 'w' && key !== 's') return;
  if (editingState) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.metaKey) return;
  const direction = (key === 'a' || key === 'w') ? -1 : 1;
  const panelTarget = getCurrentCuePanelTarget();
  const extensionTarget = panelTarget?.kind === 'extension';
  const extensionTrack = extensionTarget ? panelTarget.track : null;
  const segments = extensionTarget ? extensionTrack.segments : MaweBoot.DATA.segments;
  const wasPlaying = !MaweCoreState.player.paused;
  const heldCueKey = (!e.shiftKey || key === 'a' || key === 'd')
    && MaweCoreState.waveformEditor?.handleHeldCueKey?.(
      direction,
      direction * timelineCueMoveStepValue(),
      { shiftKey: e.shiftKey, altKey: e.altKey, snap: key === 'a' || key === 'd' },
    );
  if (heldCueKey) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.altKey) return;
  const navigationIndex = wasPlaying
    ? -1
    : (extensionTarget ? panelTarget?.index ?? -1 : MaweCuePanelState.currentCuePanelIdx);
  let next = e.shiftKey
    ? window.AsrEditorUtils.findCueSelectionExtensionTarget(
      segments,
      extensionTarget ? selectedExtensionIdxs : selectedIdxs,
      navigationIndex,
      Math.round(MaweCoreState.player.currentTime * 1000),
      direction,
      MaweDom.hideDisabled,
    )
    : window.AsrEditorUtils.findCueNavigationTarget(
      segments,
      navigationIndex,
      Math.round(MaweCoreState.player.currentTime * 1000),
      direction,
      MaweDom.hideDisabled,
    );
  if (next < 0) {
    const eligible = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => segment && (!MaweDom.hideDisabled || !segment.disabled));
    next = direction < 0
      ? (eligible[0]?.index ?? -1)
      : (eligible[eligible.length - 1]?.index ?? -1);
  }
  if (next < 0) return;

  e.preventDefault();
  e.stopPropagation();
  if (extensionTarget) {
    if (e.shiftKey) addExtensionToSelection(next, extensionTrack);
    else selectOnlyExtension(next);
    lastClickedExtensionIdx = next;
  } else {
    if (e.shiftKey) addToSelection(next);
    else selectOnly(next);
    lastClickedIdx = next;
  }
  const cue = MaweCoreState.container.querySelector(
    extensionTarget
      ? `.multi-dual-cue[data-ext-idx="${next}"], .multi-extension-cue[data-ext-idx="${next}"]`
      : `.cue[data-idx="${next}"], .multi-dual-cue[data-main-idx="${next}"]`,
  );
  if (cue) scrollCueToCenter(cue);
  MaweCoreState.waveformEditor?.revealTime(segments[next].start, true);
  MaweTextCleanup.seekFromWaveform(segments[next].start / 1000);
  if (wasPlaying && MaweCoreState.player.paused) {
    const promise = MaweCoreState.player.play();
    if (promise && promise.catch) promise.catch(() => {});
  }
});

// Ctrl(Cmd)+Shift+A/D：把当前主/副字幕与前一条/后一条直接粘合。
// 不改变 Ctrl(Cmd)+A/D 的全选与清除选择语义。
document.addEventListener('keydown', (e) => {
  if (!['a', 'A', 'd', 'D'].includes(e.key)) return;
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.repeat) return;
  if (editingState || e.target === MaweDom.cuePanelText) return;
  const active = document.activeElement;
  if (active && (
    active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
      || active.tagName === 'SELECT' || active.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show') || MaweDom.stickerModal.classList.contains('show')
      || MaweDom.stickerPreviewModal.classList.contains('show') || MaweDom.projectMediaModal.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || MaweDom.ctxmenu.classList.contains('show')) return;
  e.preventDefault();
  e.stopPropagation();
  MaweMergeAdjacent.mergeAdjacentSubtitle(e.key.toLowerCase() === 'a' ? -1 : 1);
});

// Ctrl(Cmd)+A：选中所有字幕。仅在「非编辑字幕」状态下生效；
// 焦点在输入框/文本域/可编辑元素或内联编辑态时，保留浏览器原生的「全选文本」行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'a' && e.key !== 'A') return;
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey || e.shiftKey) return;
  if (editingState) return;
  if (e.target === MaweDom.cuePanelText) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  e.preventDefault();
  selectAll();
});

// Ctrl(Cmd)+D：取消选中（清空当前字幕选择）。浏览器默认是「添加书签」，这里接管；
// 与 Ctrl(Cmd)+A 同样仅在非编辑字幕状态下生效。ESC 清除选中的行为保持不变。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'd' && e.key !== 'D') return;
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey || e.shiftKey) return;
  if (editingState) return;
  if (e.target === MaweDom.cuePanelText) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (selectedIdxs.size === 0 && selectedExtensionIdxs.size === 0) return;
  e.preventDefault();
  clearSelection();
});

// T：给选中字幕分配表情包。单选直接分配本条，多选统一分配（与右键菜单一致）。
document.addEventListener('keydown', (e) => {
  if (e.key !== 't' && e.key !== 'T') return;
  if (editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (selectedIdxs.size === 0) return;
  e.preventDefault();
  const idxs = [...selectedIdxs].sort((x, y) => x - y);
  MaweStickerPicker.openStickerPicker(idxs, idxs.length > 1);
});

// 数字键 1~5：给选中字幕标记对应颜色（红黄蓝绿紫）；0：清除颜色。
document.addEventListener('keydown', (e) => {
  if (!/^[0-5]$/.test(e.key)) return;
  if (editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (selectedIdxs.size === 0) return;
  e.preventDefault();
  const idxs = [...selectedIdxs].sort((x, y) => x - y);
  if (e.key === '0') {
    MaweStickerPicker.clearColorOnTargets(idxs);
    return;
  }
  const color = MaweColors.COLOR_PALETTE[Number(e.key) - 1];
  if (color) MaweStickerPicker.assignColor(idxs, color.name);
});

// Enter：聚焦最后点击的主/副字幕对应的字幕编辑区，并把光标置于末尾。
// 绑定字幕同时选中时仍以最后点击的一侧为准；内联编辑态、已聚焦编辑区或模态打开时不触发。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (editingState || extensionEditingState) return;  // 内联编辑态的 Enter 交给 split/commit 处理
  if (e.target === MaweDom.cuePanelText) return;  // 已在字幕编辑区
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;  // 仅响应裸 Enter
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.tagName === 'BUTTON'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (!getCurrentCuePanelTarget()) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('请先选中字幕');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  focusCuePanelText();
});

// C：合并连续选中的字幕块。少于两条时只提示，不改动工程。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'c' && e.key !== 'C') return;
  if (editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  const currentTarget = getCurrentCuePanelTarget();
  if (
    selectedExtensionIdxs.size > 0
    && (currentTarget?.kind === 'extension' || selectedIdxs.size === 0)
  ) {
    mergeExtensionSegments(
      [...selectedExtensionIdxs],
      currentTarget?.kind === 'extension' ? currentTarget.track : MaweMultiSubtitleCore.getActiveExtensionTrack(),
    );
    return;
  }
  mergeSegments([...selectedIdxs]);
});

// Ctrl(Cmd)+Z 撤销；Ctrl(Cmd)+Shift+Z 或 Ctrl(Cmd)+Y 重做
document.addEventListener('keydown', (e) => {
  const isZ = e.key === 'z' || e.key === 'Z';
  const isY = e.key === 'y' || e.key === 'Y';
  if (!isZ && !isY) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const isRedo = isY || e.shiftKey;
  // 编辑文本时让浏览器自己处理 input 内的撤销/重做
  if (MaweHistory.historyGuarded()) return;
  e.preventDefault();
  if (isRedo) MaweHistory.performRedo();
  else MaweHistory.performUndo();
});

// Delete 键删除选中的字幕（最小命令面，供回归测试与键盘操作）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  // 编辑文本时让浏览器自己处理
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  // modal 打开时不触发
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (selectedIdxs.size === 0 && selectedExtensionIdxs.size > 0) {
    e.preventDefault();
    e.stopPropagation();
    deleteExtensionSegments([...selectedExtensionIdxs]);
    return;
  }
  if (selectedIdxs.size === 0) return;
  e.preventDefault();
  e.stopPropagation();
  deleteSegments([...selectedIdxs]);
});

// 波形工具切换：V=选择（默认），R=剃刀，Esc=切回选择。与 J/K/L 一样只在
// 非输入/非模态/非编辑态下触发，避免抢占文本编辑与弹窗按键。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'v' && e.key !== 'V' && e.key !== 'r' && e.key !== 'R' && e.key !== 'Escape') return;
  if (!MaweCoreState.waveformEditor) return;
  // Escape：上下文菜单/弹窗/编辑态各自先处理；只有波形工具在 razor 时才切回。
  if (e.key === 'Escape') {
    if (editingState) return;
    if (MaweDom.ctxmenu.classList.contains('show')) return;
    if (MaweDom.replaceModal.classList.contains('show')) return;
    if (MaweDom.stickerModal.classList.contains('show')) return;
    if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
    if (MaweDom.projectMediaModal.classList.contains('show')) return;
    if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
    if (MaweCoreState.waveformEditor.getTool() !== 'razor') return;
    e.preventDefault();
    MaweCoreState.waveformEditor.setTool('select');
    return;
  }
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (editingState) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const tool = (e.key === 'v' || e.key === 'V') ? 'select' : 'razor';
  if (MaweCoreState.waveformEditor.getTool() === tool) return;
  e.preventDefault();
  MaweCoreState.waveformEditor.setTool(tool);
});

// F：跳转并播放选中字幕（多选跳到第一条）。任意单击行为下都生效；
// 文本编辑、弹窗和修饰键状态下不抢占输入。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'f' && e.key !== 'F') return;
  if (editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const target = getCurrentCuePanelTarget();
  const extensionTarget = target?.kind === 'extension';
  const selected = extensionTarget ? selectedExtensionIdxs : selectedIdxs;
  const segments = extensionTarget ? target.track.segments : MaweBoot.DATA.segments;
  if (!selected.size) return;
  const first = Math.min(...selected);
  const segment = segments[first];
  if (!segment) return;
  MaweTextCleanup.seekFromWaveform(segment.start / 1000);
  if (MaweCoreState.player.paused) MaweMediaPlayback.togglePlayback();
});

function seekCurrentCueBoundary(boundary) {
  const target = getCurrentCuePanelTarget();
  const timeMs = Number(target?.segment?.[boundary]);
  const duration = Number(MaweCoreState.player?.duration);
  if (!target || !Number.isFinite(timeMs) || !MaweMediaPlayback.hasLoadedMedia()
      || !Number.isFinite(duration) || duration <= 0) return false;
  MaweJklPlayback.stopJklReversePlayback({ render: false });
  MaweCoreState.player.pause();
  return MaweMediaPlayback.seekMediaTo(timeMs / 1000);
}

// I/O：跳到当前字幕的开头/结尾并保持暂停。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'i' && e.key !== 'I' && e.key !== 'o' && e.key !== 'O') return;
  if (editingState || extensionEditingState || e.repeat || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (MaweDom.multiSubtitleImportModal?.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const boundary = e.key.toLowerCase() === 'i' ? 'start' : 'end';
  if (!seekCurrentCueBoundary(boundary)) return;
  e.preventDefault();
  e.stopPropagation();
});

// N：仅在鼠标位于波形行时，从指针音频位置创建字幕；创建后单选新字幕，
// 切换当前字幕面板并聚焦面板文本框。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'n' && e.key !== 'N') return;
  if (editingState || e.repeat || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const reference = keyboardOperationReference();
  if (!reference) {
    MaweHint.flashHint('无有效的快捷键时间基准', 'invalid');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  lastEditRegion = 'waveform';
  if (reference.track === 'extension' && MaweMultiSubtitleCore.multiSubtitleVisible()) {
    MaweAddCue.addExtensionAtWaveformTime(reference.timeMs, lastPointerPos?.x || 0, lastPointerPos?.y || 0, MaweMultiSubtitleCore.getExtensionTrack(reference.trackId));
  } else {
    MaweAddCue.addCueAtWaveformTime(reference.timeMs, lastPointerPos?.x || 0, lastPointerPos?.y || 0);
  }
});

// G：绑定当前单选的副字幕。若同时选中一条主字幕则直接绑定，否则沿用
// 右键「绑定到主字幕」的自动匹配/等待选择流程。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'g' && e.key !== 'G') return;
  if (editingState || extensionEditingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (selectedExtensionIdxs.size !== 1) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('请先选中一条副字幕');
    return;
  }
  if (selectedIdxs.size > 1) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('绑定最多需要一条主字幕');
    return;
  }
  const extensionIndex = [...selectedExtensionIdxs][0];
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const extension = track?.segments?.[extensionIndex];
  const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(extensionIndex, track);
  if (!extension) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('当前副字幕不存在');
    return;
  }
  if (e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    if (!binding) {
      MaweHint.flashHint('当前副字幕没有绑定关系', 'invalid');
      return;
    }
    unbindSelectedSubtitlePair();
    return;
  }
  if (e.shiftKey) return;
  if (binding) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('当前副字幕已绑定，请先解绑后再绑定');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (selectedIdxs.size === 1) {
    bindSelectedSubtitlePair();
  } else {
    beginPendingExtensionBinding(extensionIndex, track);
  }
});

// H：把当前选中的副字幕批量对齐到各自绑定的主字幕时间轴。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'h' && e.key !== 'H') return;
  if (editingState || extensionEditingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  if (!selectedExtensionIdxs.size) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('请先选中至少一条副字幕');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  alignSelectedExtensionSubtitleRanges();
});

// B：按当前键盘时间基准与指针所在区域分发——
// 1) 鼠标悬停在已单选的字幕列表行上：按指针对应的文字位置拆分；
// 2) 鼠标位于波形上：按指针的音频位置拆分（与波形右键「按音频位置拆分」一致）；
// 3) 其它位置：按当前键盘时间基准拆分。
// 文本编辑、弹窗和修饰键状态下不抢占输入。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'b' && e.key !== 'B') return;
  if (e.repeat) return;
  const forceMainEdit = editingState?.forceSplitArmed === true;
  if (extensionEditingState && !forceMainEdit) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const state = extensionEditingState;
    const offset = caretOffsetInText(state.textEl);
    const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
    if (!Number.isFinite(offset) || !track?.segments?.[state.index]) {
      MaweHint.flashHint('无法定位副字幕的文字光标', 'warning');
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    // 先在编辑 DOM 消失前记录列表内光标位置，弹窗提交后的刀光留在原位。
    const editFeedbackPoint = MaweNinja.ninjaSplitPointFromRange(
      null, state.textEl, offset, String(state.textEl.innerText || '').length,
    );
    finishExtensionEdit(true);
    openExtensionSplitModal(state.index, null, track, {
      extensionOffset: offset,
      feedbackPoint: editFeedbackPoint,
      ninjaFromList: true,
    });
    return;
  }
  if (editingState && !forceMainEdit) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'
    || (a.isContentEditable && !forceMainEdit))) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (forceMainEdit) {
    e.preventDefault();
    e.stopImmediatePropagation();
    splitAtCursor();
    return;
  }
  const splitAt = (idx, x, y, timeMs) => {
    e.preventDefault();
    // B 打开弹窗后，事件仍会继续传播到后面注册的弹窗快捷键监听器；
    // 立即停止同一事件，避免“按 B 打开”被误当成“按 B 确认”。
    e.stopImmediatePropagation();
    splitFromContextMenu(idx, x, y, timeMs);
  };
  // 多重字幕下，只有副字幕是当前编辑焦点时，B 才直接打开副字幕拆分流程。
  // 绑定关系会让点击主字幕时同时选中副字幕；不能仅凭 selectedExtensionIdxs
  // 判断当前轨道，否则主字幕 active 时会被误判成副字幕单独拆分。
  const activeCuePanel = getCurrentCuePanelTarget();
  const operationReference = keyboardOperationReference();
  const pointerMainIndex = operationReference
    ? MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweBoot.DATA.segments) : -1;
  const activeExtensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const pointerExtensionIndex = operationReference?.track === 'extension'
    ? MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweMultiSubtitleCore.getExtensionTrack(operationReference.trackId)?.segments) : -1;
  if (selectedExtensionIdxs.size === 1) {
    const context = hoveredSelectedCueContext();
    if (context?.kind === 'extension' && context.track?.segments?.[context.idx]) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const initial = Number.isFinite(context.offset)
        ? {
          extensionOffset: context.offset,
          feedbackPoint: context.caretRect ? MaweNinja.ninjaSplitPointFromRect(context.caretRect) : null,
          ninjaFromList: true,
        } : {};
      openExtensionSplitModal(context.idx, null, context.track, initial);
      return;
    }
  }
  // 波形区点击副字幕后，绑定关系可能同时选中主字幕；但只要当前面板和
  // 波形指针都明确落在这条单选副字幕上，B 就应拆分副字幕，而不是被重叠
  // 的主字幕时间范围抢走目标。主字幕面板仍不会进入这个例外分支。
  const waveformExtensionIsActive = MaweMultiSubtitleCore.multiSubtitleVisible()
    && activeCuePanel?.kind === 'extension'
    && selectedExtensionIdxs.size === 1
    && selectedExtensionIdxs.has(activeCuePanel.index)
    && operationReference?.track === 'extension'
    && pointerExtensionIndex === activeCuePanel.index;
  const extensionIsActive = MaweMultiSubtitleCore.multiSubtitleVisible()
    && activeCuePanel?.kind === 'extension'
    && selectedExtensionIdxs.size === 1
    && selectedExtensionIdxs.has(activeCuePanel.index)
    && (!operationReference || pointerMainIndex < 0 || waveformExtensionIsActive);
  if (extensionIsActive) {
    const extensionIndex = [...selectedExtensionIdxs][0];
    const track = activeExtensionTrack;
    const extension = track?.segments?.[extensionIndex];
    if (!extension) return;
    let timeMs = null;
    const pointerElement = lastPointerPos
      ? document.elementFromPoint(lastPointerPos.x, lastPointerPos.y)
      : null;
    if (MaweSettings.EDITOR_SETTINGS.keyboardOperationReference === 'pointer'
        && lastPointerPos && (pointerElement?.closest('#waveform-pane') || lastEditRegion === 'waveform')) {
      const pointerTimeMs = MaweCoreState.waveformEditor?.timeMsAtPoint?.(lastPointerPos.x, lastPointerPos.y);
      if (Number.isFinite(pointerTimeMs) && pointerTimeMs > extension.start && pointerTimeMs < extension.end) {
        timeMs = pointerTimeMs;
      }
    }
    e.preventDefault();
    // 同上：首次 B 只负责打开副字幕拆分弹窗。
    e.stopImmediatePropagation();
    openExtensionSplitModal(
      extensionIndex,
      MaweSettings.EDITOR_SETTINGS.keyboardOperationReference === 'playhead'
        ? operationReference?.timeMs ?? null : timeMs,
      track,
    );
    return;
  }
  // 1) 字幕列表：需要单选 + 悬停提供文字位置
  if (selectedIdxs.size === 1) {
    const context = hoveredSelectedCueContext();
    if (context && MaweBoot.DATA.segments[context.idx]) {
      splitAt(context.idx, context.x, context.y, null);
      return;
    }
  }
  // 2) 波形：指针音频位置
  if (operationReference?.source === 'pointer' || operationReference?.track === 'extension') {
    const idx = MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweBoot.DATA.segments);
    if (idx >= 0) {
      splitAt(idx, 0, 0, operationReference.timeMs);
      return;
    }
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const extensionIndex = MaweMultiSubtitleCore.multiSubtitleVisible() && operationReference.track === 'extension'
      ? MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweMultiSubtitleCore.getExtensionTrack(operationReference.trackId)?.segments) : -1;
    if (extensionIndex >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openExtensionSplitModal(extensionIndex, operationReference.timeMs, MaweMultiSubtitleCore.getExtensionTrack(operationReference.trackId));
      return;
    }
    MaweHint.flashHint('指针位置没有可拆分字幕', 'invalid');
    return;
  }
  // 3) 播放头位置
  const timeMs = operationReference?.timeMs ?? Math.round(MaweCoreState.player.currentTime * 1000);
  const idx = MaweBoot.DATA.segments.findIndex((segment) => timeMs > segment.start && timeMs < segment.end);
  if (idx >= 0) {
    splitAt(idx, 0, 0, timeMs);
    return;
  }
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const extensionIndex = MaweMultiSubtitleCore.multiSubtitleVisible()
    ? MaweContextMenus.findWaveformCueAtTime(timeMs, extensionTrack?.segments) : -1;
  if (extensionIndex >= 0) {
    e.preventDefault();
    e.stopImmediatePropagation();
    openExtensionSplitModal(extensionIndex, timeMs, extensionTrack);
    return;
  }
  MaweHint.flashHint('播放头位置没有可拆分字幕', 'invalid');
});

// 点击输入框外 -> 完成内联编辑。使用 pointerdown 捕获阶段，确保字幕行、
// 波形或其它控件的 pointerdown 处理/重绘发生前，当前文字已经写回 DATA。
// 双列时编辑行的容器同时包含主/副两列，因此只判断当前 contenteditable。
document.addEventListener('pointerdown', (e) => {
  const target = e.target instanceof Node ? e.target : null;
  if (editingState && (!target || !editingState.textEl.contains(target))) finishEdit(true);
  if (extensionEditingState && (
    !target || !extensionEditingState.textEl.contains(target)
  )) finishExtensionEdit(true);
}, true);
// 启动早期生成的自定义字体选项先用原始名称占位；共享工具层就绪后立即统一本地化。
MaweAppearance.relabelSubtitleFontFamilyOptions();
function normalizeSubtitleColorStyle(value) {
  return typeof value === 'string' && MaweSettings.SUBTITLE_COLOR_STYLE_VALUES.includes(value)
    ? value : null;
}
function getSpeakerLabelSettings(value = MaweBoot.DATA.preview?.subtitle?.speaker_labels) {
  // applySubtitleAppearance() runs during the early boot sequence, before the
  // preview-geometry section initializes its later GEO_UTILS alias.
  return EDITOR_SETTINGS_UTILS.normalizeSpeakerLabelSettings(value);
}
function syncSpeakerLabelControls(settings = getSpeakerLabelSettings()) {
  const mappingEnabled = settings.mapping_enabled === true;
  if (MaweDom.subtitleSpeakerMappingEnabledInput) {
    MaweDom.subtitleSpeakerMappingEnabledInput.checked = mappingEnabled;
  }
  if (MaweDom.subtitleSpeakerLabelsToggle) {
    MaweDom.subtitleSpeakerLabelsToggle.hidden = !mappingEnabled;
  }
  if (MaweDom.subtitleSpeakerLabelsEnabledInput) {
    MaweDom.subtitleSpeakerLabelsEnabledInput.checked = settings.enabled;
  }
  if (MaweDom.subtitleSpeakerLabelsSettings) {
    MaweDom.subtitleSpeakerLabelsSettings.dataset.mappingEnabled = mappingEnabled ? 'true' : 'false';
    MaweDom.subtitleSpeakerLabelsSettings.dataset.enabled = settings.enabled ? 'true' : 'false';
    MaweDom.subtitleSpeakerLabelsSettings.hidden = !mappingEnabled;
  }
  Object.entries(MaweDom.subtitleSpeakerLabelInputs).forEach(([color, input]) => {
    if (input && document.activeElement !== input) input.value = settings.names[color] || '';
  });
  if (MaweDom.subtitleSpeakerLabelSeparatorInput && document.activeElement !== MaweDom.subtitleSpeakerLabelSeparatorInput) {
    MaweDom.subtitleSpeakerLabelSeparatorInput.value = settings.separator;
  }
  document.querySelectorAll('[data-speaker-label-swatch]').forEach((swatch) => {
    const color = swatch.dataset.speakerLabelSwatch;
    const value = MaweColors.COLOR_BY_NAME[color]?.value;
    if (value) swatch.style.backgroundColor = value;
  });
}

function setSpeakerLabelSettings(value, { markDirty = true } = {}) {
  const settings = getSpeakerLabelSettings(value);
  if (!MaweBoot.DATA.preview || typeof MaweBoot.DATA.preview !== 'object') MaweBoot.DATA.preview = {};
  MaweBoot.DATA.preview.subtitle = {
    ...MaweAppearance.getPreviewGeometry(),
    ...MaweAppearance.getSubtitleAppearance(),
    speaker_labels: settings,
  };
  if (markDirty) MaweAppearance.previewGeometryDirty = true;
  MaweAppearance.applySubtitleAppearance(MaweBoot.DATA.preview.subtitle);
  return settings;
}
MaweAppearance.initializeSubtitleFontFamilyScanner();
MawePreviewGeometry.bindPreviewBoxPointerEvents(MaweDom.overlayEl, 'subtitle');
MaweDom.overlayEl.addEventListener('keydown', (event) => MawePreviewGeometry.handlePreviewBoxKeydown(event, 'subtitle'));

// 点击预览框（字幕/表情包）以外的地方：失焦并退出控制点编辑态，调整框随之隐藏。
// 捕获阶段监听，避免其他组件 pointerdown 的 stopPropagation 跳过失焦。
document.addEventListener('pointerdown', (event) => {
  if (MawePreviewGeometry.previewGesture) return;
  [MaweDom.overlayEl, MaweStickerOverlay.stickerOverlayLayer].forEach((el) => {
    if (el.contains(event.target)) return;
    el.classList.remove('editable');
    if (document.activeElement === el) el.blur();
  });
}, true);

// 播放器缩放时几何以百分比表达，天然自适应；ResizeObserver 仅在盒子越界后回钳。
if (typeof ResizeObserver === 'function') {
  const previewResizeObserver = new ResizeObserver(() => {
    MawePreviewGeometry.applyPreviewGeometryToDom(MaweAppearance.getPreviewGeometry());
  });
  previewResizeObserver.observe(MaweDom.playerStage);
}
MaweStickerOverlay.stickerOverlayLayer.id = 'sticker-overlay-layer';
MaweStickerOverlay.stickerOverlayLayer.className = 'geo-box';
MaweStickerOverlay.stickerOverlayLayer.tabIndex = 0;
MaweStickerOverlay.stickerOverlayLayer.setAttribute('role', 'group');
MaweStickerOverlay.stickerOverlayLayer.setAttribute('aria-label', '表情包预览位置。可拖动调整；方向键移动，按住 Shift 加速，按住 Alt 配合方向键调整大小，Enter 显示控制点，Esc 退出。');
MaweStickerOverlay.stickerOverlayContent.className = 'sticker-overlay-content';
MaweStickerOverlay.stickerOverlayLayer.appendChild(MaweStickerOverlay.stickerOverlayContent);
['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((h) => {
  const handle = document.createElement('span');
  handle.className = 'overlay-handle';
  handle.dataset.handle = h;
  MaweStickerOverlay.stickerOverlayLayer.appendChild(handle);
});
MaweDom.playerStage.appendChild(MaweStickerOverlay.stickerOverlayLayer);
MawePreviewGeometry.bindPreviewBoxPointerEvents(MaweStickerOverlay.stickerOverlayLayer, 'sticker');
MaweStickerOverlay.stickerOverlayLayer.addEventListener('keydown', (event) => MawePreviewGeometry.handlePreviewBoxKeydown(event, 'sticker'));

MaweDom.stickerOverlayToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ stickerOverlayEnabled: MaweDom.stickerOverlayToggle.checked });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  MawePlaybackLoop.update();
});

// 初次应用（不弄脏工程）：字幕与表情包预览几何。必须在 stickerOverlayLayer 创建之后执行（TDZ）。
MawePreviewGeometry.setPreviewGeometry(MaweAppearance.getPreviewGeometry(), { markDirty: false });
MawePreviewGeometry.setStickerGeometry(MawePreviewGeometry.getStickerGeometry(), { markDirty: false });
MawePreviewGeometry.refreshPreviewGeometryEditable();

MaweMediaPlayback.bindPlayerEvents(MaweCoreState.player);
MaweDom.overlayToggle.addEventListener('change', () => {
  // change 触发时 checked 已是新值；其它预览样式和副字幕开关仍从当前快照保留。
  const previous = MaweHistory.snapshotPreviewState();
  previous.overlay = !MaweDom.overlayToggle.checked;
  MaweHistory.pushPreviewUndo('切换字幕预览', previous);
  MaweSettings.updateEditorSettings({ overlayEnabled: MaweDom.overlayToggle.checked });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  if (!MaweDom.overlayToggle.checked) MaweDom.overlayEl.classList.add('hidden');
  else MawePlaybackLoop.update();
});

function speakerLabelExportOptions() {
  const settings = getSpeakerLabelSettings();
  return {
    speakerLabelsEnabled: MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels === true
      && settings.mapping_enabled === true,
    speakerLabels: settings.names,
    speakerLabelSeparator: settings.separator,
  };
}

function buildAss() {
  const firstEnabledIndex = window.AsrEditorUtils.getSrtExportFirstIndex(
    MaweBoot.DATA.segments,
    MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
  );
  return window.AsrEditorUtils.buildAssPayload(MaweBoot.DATA.segments, {
    alignFirstStart: MaweSettings.EDITOR_SETTINGS.exportStartAtZero,
    firstEnabledIndex,
    appearance: MaweAppearance.getSubtitleAppearance(),
  });
}

function safeColorExportFilenameSuffix(value, fallback) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return normalized || fallback;
}

function colorExportFilenameSuffix(color, speakerSettings = getSpeakerLabelSettings()) {
  const colorSuffix = window.MAWE_I18N?.exportTag?.(color.name) || color.name;
  if (!MaweSettings.EDITOR_SETTINGS.exportSpeakerNamesAsSuffix
      || speakerSettings.mapping_enabled !== true
      || color.name === 'default') {
    return colorSuffix;
  }
  return safeColorExportFilenameSuffix(speakerSettings.names?.[color.name], colorSuffix);
}

const CANONICAL_PROJECT_FIELDS = new Set([
  'schema', 'media', 'language', 'language_source', 'split_mode', 'timestamp_granularity',
  'model', 'sticker_root', 'timebase', 'segments', 'multi_subtitle', 'waveform',
  'media_metadata', 'media_time_reference', 'spectral', 'waveform_reapeaks', 'loudness',
  'gap_remove', 'script_alignment', 'workspace', 'preview',
]);
let projectExtensionFields = Object.fromEntries(
  Object.entries(MaweBoot.DATA).filter(([key]) => !CANONICAL_PROJECT_FIELDS.has(key)),
);

function buildJson() {
  syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
  const repairedTimingCount = repairCurrentProjectTimings();
  if (repairedTimingCount > 0) {
    MaweHint.flashHint(`已自动修复 ${repairedTimingCount} 处异常时间码（保底 100ms）`, 'warning');
  }
  syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
  const out = {
    schema: window.AsrEditorUtils.PROJECT_SCHEMA,
    ...projectExtensionFields,
    media: MaweBoot.DATA.media || '',
    language: MaweBoot.DATA.language || '',
    model: MaweBoot.DATA.model || '',
    sticker_root: MaweBoot.STICKER_ROOT || '',
    timebase: { ...projectTimebase() },
    segments: MaweBoot.DATA.segments.map(s => {
      const o = {
        id: s.id,
        start: s.start, end: s.end, text: s.text,
        start_frame: s.start_frame, end_frame: s.end_frame,
        items: s.items || [],
        sticker: s.sticker || null,
        sticker_ref: s.sticker_ref || null,
        color: s.color || null,
        color_ref: s.color_ref || null,
      };
      // 持久化"已改动"标记，便于二次打开时仍能识别脏行 / 离开提醒等
      if (s._dirty) o._dirty = true;
      // 持久化"禁用"标记（未禁用的不写字段，加载时默认 undefined=falsy 兼容旧工程）
      if (s.disabled) o.disabled = true;
      return o;
    }),
  };
  if (typeof MaweBoot.DATA.language_source === 'string') out.language_source = MaweBoot.DATA.language_source;
  if (typeof MaweBoot.DATA.split_mode === 'string') out.split_mode = MaweBoot.DATA.split_mode;
  if (typeof MaweBoot.DATA.timestamp_granularity === 'string') {
    out.timestamp_granularity = MaweBoot.DATA.timestamp_granularity;
  }
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  out.multi_subtitle = {
    schema: multi.schema || MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_SCHEMA,
    enabled: multi.enabled === true,
    display_mode: multi.display_mode || 'both',
    main_split_mode: MaweMultiSubtitleCore.isConfiguredSubtitleSplitMode(multi.main_split_mode)
      ? multi.main_split_mode : MaweMultiSubtitleCore.getMainSubtitleSplitMode(MaweBoot.DATA.segments[0]),
    tracks: (multi.tracks || []).map((track) => ({
      id: track.id,
      role: 'extension',
      name: track.name || '副字幕',
      language: track.language || '',
      split_mode: track.split_mode || 'word',
      source_name: track.source_name || '',
      segments: (track.segments || []).map((segment) => {
        const outSegment = {
          id: segment.id,
          start: segment.start,
          end: segment.end,
          start_frame: segment.start_frame,
          end_frame: segment.end_frame,
          text: segment.text || '',
        };
        if (Array.isArray(segment.items)) outSegment.items = segment.items;
        if (segment.color != null) outSegment.color = segment.color;
        if (segment.color_ref != null) outSegment.color_ref = segment.color_ref;
        if (segment._dirty) outSegment._dirty = true;
        if (segment.disabled) outSegment.disabled = true;
        return outSegment;
      }),
    })),
    bindings: (multi.bindings || []).map((binding) => ({
      id: binding.id,
      track_id: binding.track_id,
      main_segment_ids: [...(binding.main_segment_ids || [])],
      extension_segment_ids: [...(binding.extension_segment_ids || [])],
      start_offset_ms: binding.start_offset_ms || 0,
      end_offset_ms: binding.end_offset_ms || 0,
    })),
  };
  // 波形缓存（含响度统计）不再写进工程：运行态 DATA 保留 payload 供本页渲染，落盘
  // 真源在媒体旁的 .quapeaks / .mopeaks（后端落盘边界也会再剥一次兜底）。
  // 旧工程里的内联缓存经 CANONICAL_PROJECT_FIELDS 进 DATA，不会混进扩展字段。
  const mediaMetadata = normalizeMediaMetadata(MaweBoot.DATA.media_metadata);
  if (mediaMetadata) out.media_metadata = mediaMetadata;
  if (MaweBoot.DATA.gap_remove) out.gap_remove = MaweGapRemoveData.normalizedGapRemoveData(MaweBoot.DATA.gap_remove);
  if (MaweBoot.DATA.script_alignment) out.script_alignment = MaweBoot.DATA.script_alignment;
  const workspace = MaweExportTimeline.buildCurrentWorkspaceData();
  if (workspace) out.workspace = workspace;
  // 预览几何：始终写入归一化后的当前几何，便于跨机/重开保持位置。
  const preview = {
    subtitle: {
      ...MaweAppearance.getPreviewGeometry(),
      ...MaweAppearance.getSubtitleAppearance(),
      speaker_labels: getSpeakerLabelSettings(),
    },
  };
  if (MaweMultiSubtitleCore.getActiveExtensionTrack() || MaweBoot.DATA.preview?.extension_subtitle) {
    preview.extension_subtitle = { ...MaweAppearance.getStoredExtensionSubtitleAppearance() };
  }
  out.preview = preview;
  return JSON.stringify(out, null, 2);
}

// 保存/导出前的最后一道时间码兜底。波形拖动会把词时间码按像素取整，
// 极短词可能因此出现 1ms 的前后重叠；打开工程时的修复不足以覆盖这种
// “打开后编辑、随后保存”的路径。主轨和所有副字幕轨统一使用同一规则。
function normalizeProjectTimings(project, { repairSegmentRanges = true } = {}) {
  if (!project || typeof project !== 'object') return 0;
  const normalize = repairSegmentRanges
    ? window.AsrEditorUtils.normalizeSegmentTimings
    : window.AsrEditorUtils.normalizeItemTimingRanges;
  let fixed = normalize(project.segments);
  const tracks = project.multi_subtitle?.tracks;
  if (Array.isArray(tracks)) {
    tracks.forEach((track) => {
      fixed += normalize(track?.segments);
    });
  }
  return fixed;
}

function timingRepairSignature(segment) {
  return JSON.stringify({
    start: segment?.start,
    end: segment?.end,
    items: Array.isArray(segment?.items)
      ? segment.items.map((item) => ({ text: item?.text, start: item?.start, end: item?.end }))
      : null,
  });
}

function repairTimingGroup(segments) {
  const source = Array.isArray(segments) ? segments : [];
  const before = source.map((segment) => timingRepairSignature(segment));
  const fixed = window.AsrEditorUtils.normalizeItemTimingRanges(source);
  const changed = source.filter((segment, index) => (
    timingRepairSignature(segment) !== before[index]
  ));
  return { fixed, changed };
}

function repairCurrentProjectTimings() {
  const main = repairTimingGroup(MaweBoot.DATA.segments);
  const extension = (MaweMultiSubtitleCore.getMultiSubtitleState().tracks || []).reduce((result, track) => {
    const repaired = repairTimingGroup(track?.segments);
    result.fixed += repaired.fixed;
    result.changed.push(...repaired.changed);
    return result;
  }, { fixed: 0, changed: [] });
  const fixed = main.fixed + extension.fixed;
  if (fixed > 0) {
    MaweMultiSubtitleCore.markMainSegmentsDirty(main.changed);
    extension.changed.forEach((segment) => { segment._dirty = true; });
    if (main.changed.length || extension.changed.length) MaweMultiSubtitleCore.markMultiSubtitleStateDirty();
    MaweMultiSubtitleCore.syncBindingOffsets();
  }
  return fixed;
}

function otioAudioTrackMetadata(audioTrack, fallbackIndex = 0) {
  if (!audioTrack || !Number.isInteger(audioTrack.stream_index) || audioTrack.stream_index < 0) {
    return {};
  }
  const audioIndex = otioAudioTrackIndex(audioTrack, fallbackIndex);
  const metadata = {
    audio_track_index: audioIndex,
    audio_stream_index: audioTrack.stream_index,
  };
  for (const field of ['codec', 'language', 'title']) {
    if (audioTrack[field]) metadata[field] = audioTrack[field];
  }
  if (Number.isInteger(audioTrack.channels) && audioTrack.channels > 0) {
    metadata.channels = audioTrack.channels;
  }
  if (Number.isInteger(audioTrack.sample_rate) && audioTrack.sample_rate > 0) {
    metadata.sample_rate = audioTrack.sample_rate;
  }
  if (audioTrack.default === true) metadata.default = true;
  return { moy: metadata };
}

function otioAudioTrackIndex(audioTrack, fallbackIndex = 0) {
  return Number.isInteger(audioTrack?.audio_index) && audioTrack.audio_index >= 0
    ? audioTrack.audio_index : fallbackIndex;
}

function otioAudioTrackName(audioTrack, index, total) {
  if (total <= 1) return '音频';
  const details = [audioTrack?.title, audioTrack?.language]
    .filter((value, detailIndex, values) => value && values.indexOf(value) === detailIndex)
    .join(' · ');
  return `音频 ${index + 1}${details ? ` · ${details}` : ''}`;
}

function otioMediaName(targetUrl) {
  const raw = String(targetUrl || '').split(/[?#]/, 1)[0].replace(/[\\/]+$/, '');
  const candidate = raw.split(/[\\/]/).pop() || '';
  if (!candidate) return '';
  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate;
  }
}

function resolveOtioAudioType(audioTrack) {
  if (audioTrack?.channels === 1) return 'Mono';
  if (audioTrack?.channels === 2) return 'Stereo';
  return null;
}

function resolveOtioTrackMetadata(kind, audioTrack) {
  if (kind === 'Video') {
    return { Resolve_OTIO: { Locked: false } };
  }
  const audioType = resolveOtioAudioType(audioTrack);
  return {
    Resolve_OTIO: {
      ...(audioType ? { 'Audio Type': audioType } : {}),
      Locked: false,
      SoloOn: false,
    },
  };
}

function resolveOtioClipMetadata(kind, audioTrack, audioTrackIndex, linkGroupId = 1) {
  const resolveMetadata = { 'Link Group ID': linkGroupId };
  if (kind === 'Audio') {
    const sourceTrackId = otioAudioTrackIndex(audioTrack, audioTrackIndex);
    const channels = Number.isInteger(audioTrack?.channels) && audioTrack.channels > 0
      ? audioTrack.channels : 0;
    if (channels > 0) {
      resolveMetadata.Channels = Array.from({ length: channels }, (_, sourceChannelId) => ({
        'Source Channel ID': sourceChannelId,
        'Source Track ID': sourceTrackId,
      }));
    }
  }
  return { Resolve_OTIO: resolveMetadata };
}

// 把表情包条目构建为一条可放进任意时间线 Stack 的单层视频轨（Gap 填充 + 图片 Clip）。
// stickers 会被就地排序；时间重叠时返回 { error }，由调用方决定中止还是跳过。
function buildStickerOtioTrack(stickers) {
  stickers.sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs) || (a.idx - b.idx));
  const children = [];
  let cursor = 0;
  for (const sticker of stickers) {
    const startFrame = MaweExportTimeline.msToOtioFrames(sticker.startMs);
    const endFrame = MaweExportTimeline.msToOtioFrames(sticker.endMs);
    const durationFrames = Math.max(1, endFrame - startFrame);
    if (startFrame < cursor) {
      return { error: `表情包时间重叠，无法导出单轨 OTIO：${sticker.name}` };
    }
    if (startFrame > cursor) {
      children.push({
        OTIO_SCHEMA: 'Gap.1',
        metadata: {},
        name: '',
        source_range: MaweExportTimeline.otioTimeRange(0, startFrame - cursor),
        effects: [],
        markers: [],
        enabled: true,
        color: null,
      });
    }
    children.push({
      OTIO_SCHEMA: 'Clip.2',
      metadata: {
        moy: {
          asr_segment_index: sticker.idx,
          start_ms: Math.round(sticker.startMs),
          end_ms: Math.round(sticker.endMs),
          sticker_rel: sticker.sticker_rel,
        },
      },
      name: sticker.name,
      source_range: MaweExportTimeline.otioTimeRange(0, durationFrames),
      effects: [],
      markers: [],
      enabled: true,
      color: null,
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: 'ExternalReference.1',
          metadata: {},
          name: '',
          available_range: null,
          available_image_bounds: null,
          target_url: sticker.targetUrl || MaweExportTimeline.stickerTargetUrl(sticker.absPath),
        },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
    });
    cursor = startFrame + durationFrames;
  }
  return {
    track: {
      OTIO_SCHEMA: 'Track.1',
      metadata: {},
      name: '表情包',
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      color: null,
      children,
      kind: 'Video',
    },
  };
}
let projectBackupTimer = null;
function syncProjectBackupControls() {
  const available = MaweServerSave.serverProjectSavingEnabled() && !MaweServerSave.projectFileHandle;
  const enabled = document.getElementById('project-backup-enabled');
  const minutes = document.getElementById('project-backup-minutes');
  const limit = document.getElementById('project-backup-limit');
  enabled.checked = MaweSettings.EDITOR_SETTINGS.projectBackupEnabled;
  enabled.disabled = !available;
  document.getElementById('project-backup-open').disabled = !available;
  minutes.value = MaweSettings.EDITOR_SETTINGS.projectBackupMinutes;
  limit.value = MaweSettings.EDITOR_SETTINGS.projectBackupLimit;
  minutes.disabled = limit.disabled = !available || !enabled.checked;
  document.getElementById('project-backup-unavailable').hidden = available;
  if (projectBackupTimer !== null) window.clearInterval(projectBackupTimer);
  projectBackupTimer = null;
  if (available && enabled.checked) {
    projectBackupTimer = window.setInterval(() => {
      void MaweProjectSave.saveProjectToServer({ silent: true, backupOnly: true });
    }, MaweSettings.EDITOR_SETTINGS.projectBackupMinutes * 60000);
  }
}
for (const [id, key, fallback, max] of [
  ['project-backup-enabled', 'projectBackupEnabled', true, 0],
  ['project-backup-minutes', 'projectBackupMinutes', 5, 1440],
  ['project-backup-limit', 'projectBackupLimit', 20, 1000],
]) {
  document.getElementById(id)?.addEventListener('change', (event) => {
    const value = max ? Math.min(max, Math.max(1, Math.round(Number(event.target.value) || fallback))) : event.target.checked;
    MaweSettings.updateEditorSettings({ [key]: value });
    syncProjectBackupControls();
  });
}
document.getElementById('project-backup-open')?.addEventListener('click', async () => {
  if (!MaweServerSave.serverProjectSavingEnabled() || MaweServerSave.projectFileHandle) return;
  try {
    const response = await fetch(new URL('/api/project/backups/open', window.location.href), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || response.status);
  } catch (error) {
    MaweHint.flashHint(`打开备份文件夹失败：${error.message || error}`, 'warning');
  }
});
if (MaweProjectSave.mediaNameEl && !MaweProjectSave.mediaNameEl.classList.contains('empty')) {
  MaweProjectSave.mediaNameEl.addEventListener('click', () => {
    const name = MaweProjectSave.mediaNameEl.textContent.trim();
    if (name) MaweExportTimeline.copyText(name, `已复制媒体名：${name}`);
  });
}
if (MaweProjectSave.jsonNameEl && !MaweProjectSave.jsonNameEl.classList.contains('empty')) {
  MaweProjectSave.jsonNameEl.addEventListener('click', () => {
    const name = MaweProjectSave.jsonNameEl.textContent.trim();
    if (name) MaweExportTimeline.copyText(name, `已复制：${name}`);
  });
}

document.getElementById('download-fcp7-export')?.addEventListener('click', MaweDynamicExports.openFcp7ExportModal);
MaweDom.fcp7ExportCancel?.addEventListener('click', MaweDynamicExports.closeFcp7ExportModal);
MaweDom.fcp7ExportConfirm?.addEventListener('click', () => { void MaweDynamicExports.exportFcp7Xml(); });
MaweDom.fcp7ExportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.fcp7ExportModal) MaweDynamicExports.closeFcp7ExportModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.fcp7ExportModal.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDynamicExports.closeFcp7ExportModal();
}, true);

document.getElementById('download-lottie')?.addEventListener('click', MaweDynamicExports.openLottieExportModal);
MaweDom.lottieExportCancel?.addEventListener('click', MaweDynamicExports.closeLottieExportModal);
MaweDom.lottieExportConfirm?.addEventListener('click', () => { void MaweDynamicExports.exportLottieDynamicCaptions(); });
MaweDom.lottieExportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.lottieExportModal) MaweDynamicExports.closeLottieExportModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.lottieExportModal?.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDynamicExports.closeLottieExportModal();
}, true);

document.getElementById('download-ograf')?.addEventListener('click', MaweDynamicExports.openOgrafExportModal);
MaweDom.ografExportCancel?.addEventListener('click', MaweDynamicExports.closeOgrafExportModal);
MaweDom.ografExportConfirm?.addEventListener('click', () => { void MaweDynamicExports.exportOgrafDynamicCaptions(); });
MaweDom.ografExportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.ografExportModal) MaweDynamicExports.closeOgrafExportModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.ografExportModal?.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDynamicExports.closeOgrafExportModal();
}, true);

MaweDom.downloadMultiSrtButton?.addEventListener('click', async () => {
  if (extensionEditingState) finishExtensionEdit(true);
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  if (!track) return;
  await MaweExportTimeline.downloadFile(MaweExportSrt.buildExtensionSrt(track), `${MaweBoot.FILENAME_BASE}_extension.srt`, 'text/plain', {
    desc: '副字幕 SRT 文件', types: { 'text/plain': ['.srt'] },
  });
});
document.getElementById('download-full-srt')?.addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  await MaweExportTimeline.downloadFile(MaweExportSrt.buildSrt(), `${MaweBoot.FILENAME_BASE}.srt`, 'text/plain', {
    desc: '完整 SRT 字幕文件', types: { 'text/plain': ['.srt'] }
  });
});
document.getElementById('download-full-ass')?.addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  await MaweExportTimeline.downloadFile(buildAss(), `${MaweBoot.FILENAME_BASE}.ass`, 'text/plain', {
    desc: '完整 ASS 字幕文件', types: { 'text/plain': ['.ass'] }
  });
});
document.getElementById('download-color-srt')?.addEventListener('click', () => MaweExportSrt.downloadColorSrts(false));
document.getElementById('download-plain-text')?.addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  await MaweExportTimeline.downloadFile(window.AsrEditorUtils.buildPlainTextPayload(MaweBoot.DATA.segments), `${MaweBoot.FILENAME_BASE}.txt`, 'text/plain', {
    desc: '纯文本字幕文件', types: { 'text/plain': ['.txt'] }
  });
});
document.getElementById('download-json')?.addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  await MaweExportTimeline.downloadFile(buildJson(), `${MaweBoot.FILENAME_BASE}.mosp`, 'application/json', {
    desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] }
  });
});
MaweDom.saveProjectButton?.addEventListener('click', () => MaweProjectSave.saveCurrentProject());
MaweDom.saveProjectAsButton?.addEventListener('click', () => MaweProjectSave.saveProjectAsToFile());
// Project-level save shortcuts intentionally override the browser page-save
// command. finishEdit() inside saveProjectToServer commits an active text edit.
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  if (event.shiftKey) {
    void MaweProjectSave.saveProjectAsToFile();
  } else {
    void MaweProjectSave.saveCurrentProject();
  }
});
document.getElementById('download-resolve-json')?.addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = MaweExportTimeline.buildResolveJson();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_resolve.json`, 'application/json', {
      desc: 'Resolve JSON', types: { 'application/json': ['.json'] }
    });
  }
});
const stickerOtioExportMode = document.getElementById('sticker-otio-export-mode');
const portableStickerExportOption = stickerOtioExportMode?.querySelector('option[value="portable"]');

function syncStickerOtioExportMode() {
  const available = Boolean(
    MaweBoot.SERVER_CONFIG?.canPortableStickerExport && MaweBoot.SERVER_CONFIG?.portableStickerExportUrl
  );
  if (portableStickerExportOption) portableStickerExportOption.disabled = !available;
  if (stickerOtioExportMode) {
    stickerOtioExportMode.value = available
      ? MaweSettings.EDITOR_SETTINGS.stickerOtioExportMode
      : 'original';
  }
  return available;
}

stickerOtioExportMode?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ stickerOtioExportMode: stickerOtioExportMode.value });
});

async function exportStickerOtio(kind, buildTimeline, filename, description) {
  if (editingState) finishEdit(true);
  const payload = buildTimeline();
  if (!payload) return;
  if (stickerOtioExportMode?.value !== 'portable') {
    await MaweExportTimeline.downloadFile(payload, filename, 'application/vnd.opentimelineio+json', {
      desc: description, types: { 'application/vnd.opentimelineio+json': ['.otio'] }
    });
    return;
  }
  if (!syncStickerOtioExportMode()) {
    MaweHint.flashHint('当前工程无法导出便携表情包 OTIO 文件夹', 'warning');
    return;
  }
  MaweHint.flashHint('正在生成便携表情包 OTIO 文件夹…');
  try {
    const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.portableStickerExportUrl, window.location.href), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestToken: MaweBoot.SERVER_CONFIG.requestToken,
        kind,
        timeline: JSON.parse(payload),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `服务器返回 ${response.status}`);
    MaweHint.flashHint(`已生成 ${result.folderPath}，复制 ${result.stickerCount} 张表情包`, 'success');
  } catch (error) {
    MaweHint.flashHint(`便携表情包 OTIO 导出失败：${error.message || error}`, 'warning');
  }
}

document.getElementById('download-sticker-otio')?.addEventListener('click', () => {
  if (MaweExportTimeline.stickerExportBlocked('download-sticker-otio')) return;
  exportStickerOtio(
    'stickers', MaweExportTimeline.buildStickerOtio, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otio`, 'OTIO 工程文件'
  );
});
document.getElementById('download-gap-removed-srt')?.addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = MaweExportSrt.buildGapRemovedSrt();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.srt`, 'text/plain', {
      desc: '去空隙字幕 SRT', types: { 'text/plain': ['.srt'] }
    });
  }
});
document.getElementById('download-gap-removed-color-srt')?.addEventListener('click', () => MaweExportSrt.downloadColorSrts(true));
document.getElementById('download-otio')?.addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = MaweExportTimeline.buildSourceOtio();
  if (!payload) return;
  await MaweExportTimeline.downloadFile(payload, MaweBoot.FILENAME_BASE + '.otio', 'application/vnd.opentimelineio+json', {
    desc: 'OTIO 工程', types: { 'application/vnd.opentimelineio+json': ['.otio'] }
  });
  if (MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    await MaweExportTimeline.downloadFile(MaweExportSrt.buildSrt(), `${MaweBoot.FILENAME_BASE}.srt`, 'text/plain', {
      desc: '完整 SRT 字幕文件', types: { 'text/plain': ['.srt'] }
    });
  }
});
document.getElementById('download-otioz')?.addEventListener('click', async () => {
  const saved = await MaweExportTimeline.exportTimelineOtioz(
    'source',
    MaweExportTimeline.buildSourceOtio,
    MaweBoot.FILENAME_BASE + '.otioz',
    'OTIOZ 打包工程',
  );
  if (saved && MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    await MaweExportTimeline.downloadFile(MaweExportSrt.buildSrt(), `${MaweBoot.FILENAME_BASE}.srt`, 'text/plain', {
      desc: '完整 SRT 字幕文件', types: { 'text/plain': ['.srt'] }
    });
  }
});
document.getElementById('download-gap-removed-otio')?.addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = MaweExportTimeline.buildGapRemovedOtio();
  if (!payload) return;
  await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.otio`, 'application/vnd.opentimelineio+json', {
    desc: '去空隙 OTIO 工程', types: { 'application/vnd.opentimelineio+json': ['.otio'] }
  });
  if (MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    const srtPayload = MaweExportSrt.buildGapRemovedSrt();
    if (srtPayload) {
      await MaweExportTimeline.downloadFile(srtPayload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.srt`, 'text/plain', {
        desc: '去空隙字幕 SRT', types: { 'text/plain': ['.srt'] }
      });
    }
  }
});
document.getElementById('download-gap-removed-otioz')?.addEventListener('click', async () => {
  const saved = await MaweExportTimeline.exportTimelineOtioz(
    'gap-removed',
    MaweExportTimeline.buildGapRemovedOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.otioz`,
    '去空隙时间线 OTIOZ 打包工程',
  );
  if (saved && MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    const srtPayload = MaweExportSrt.buildGapRemovedSrt();
    if (srtPayload) {
      await MaweExportTimeline.downloadFile(srtPayload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.srt`, 'text/plain', {
        desc: '去空隙字幕 SRT', types: { 'text/plain': ['.srt'] }
      });
    }
  }
});
document.getElementById('download-gap-removed-ffconcat')?.addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = MaweExportSrt.buildGapRemovedFfconcat();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.ffconcat`, 'text/plain', {
      desc: 'FFconcat 剪辑计划', types: { 'text/plain': ['.ffconcat'] }
    });
  }
});
document.getElementById('download-gap-removed-regions-json')?.addEventListener('click', async () => {
  if (editingState) finishEdit(true);
  const payload = MaweExportSrt.buildGapRemovedRegionsJson();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.keep-regions.json`, 'application/json', {
      desc: '去空隙保留区域 JSON', types: { 'application/json': ['.json'] }
    });
  }
});
document.getElementById('download-gap-removed-sticker-otio')?.addEventListener('click', async () => {
  if (MaweExportTimeline.stickerExportBlocked('download-gap-removed-sticker-otio')) return;
  await exportStickerOtio(
    'gap-removed-stickers', MaweExportTimeline.buildGapRemovedStickerOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}-${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otio`, '去空隙表情包 OTIO 工程'
  );
});
document.getElementById('download-gap-removed-sticker-otioz')?.addEventListener('click', async () => {
  if (MaweExportTimeline.stickerExportBlocked('download-gap-removed-sticker-otioz')) return;
  const removed = MaweGapRemoveData.getRemovedGapRanges();
  if (!removed.length) {
    const msg = '没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除';
    MaweHint.flashHint(window.MAWE_I18N?.translateText?.(msg) || msg);
    return;
  }
  await MaweExportTimeline.exportStickerOtoz(
    'gap-removed-stickers', MaweExportTimeline.buildGapRemovedStickerOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}-${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otioz`, '去空隙表情包 OTIOZ 打包工程'
  );
});
document.getElementById('download-sticker-otioz')?.addEventListener('click', async () => {
  if (MaweExportTimeline.stickerExportBlocked('download-sticker-otioz')) return;
  await MaweExportTimeline.exportStickerOtoz(
    'stickers', MaweExportTimeline.buildStickerOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otioz`, '表情包 OTIOZ 打包工程'
  );
});

// 时间线 OTIO / OTIOZ 导出选项：两个 OTIO 子菜单（原始 / 去空隙）共享同一份设置，
// 任一处勾选立即持久化并同步另一处；导出时由 buildSourceOtio / buildGapRemovedOtio 读取。
const OTIO_EXPORT_OPTION_KEYS = {
  srt: 'otioExportIncludeSrt',
  stickers: 'otioExportIncludeStickers',
  markers: 'otioExportIncludeMarkers',
};
const otioExportOptionInputs = [
  ...document.querySelectorAll('input[data-otio-export-option]'),
];

function syncOtioExportOptionInputs() {
  otioExportOptionInputs.forEach((input) => {
    const key = OTIO_EXPORT_OPTION_KEYS[input.dataset.otioExportOption];
    if (key) input.checked = Boolean(MaweSettings.EDITOR_SETTINGS[key]);
  });
}

otioExportOptionInputs.forEach((input) => {
  input.addEventListener('change', () => {
    const key = OTIO_EXPORT_OPTION_KEYS[input.dataset.otioExportOption];
    if (!key) return;
    MaweSettings.updateEditorSettings({ [key]: input.checked });
    syncOtioExportOptionInputs();
    // 鼠标点击切换后立即交还焦点：焦点留在子菜单内的复选框上会让悬停关闭
    // 逻辑（wrapper.contains(document.activeElement)）一直误判指针仍在菜单内，
    // 导致二级菜单不再自动收起。键盘切换（:focus-visible）保持焦点不受影响。
    if (!input.matches(':focus-visible')) input.blur();
  });
});
syncOtioExportOptionInputs();

// 初始按服务器模式刷新表情包 OTIOZ 导出按钮的可用性
MaweExportTimeline.updateStickerExportButtons();
MaweExportTimeline.updateTimelineOtiozExportButtons();
MaweDynamicExports.updateLottieExportButton();
MaweDynamicExports.updateOgrafExportButton();
MaweExportMenus.bindToolbarExportDropdown('subtitle-export-dropdown', 'subtitle-export-btn', 'subtitle-export-menu');
MaweExportMenus.bindToolbarExportDropdown('gap-removed-export-dropdown', 'gap-removed-export-btn', 'gap-removed-export-menu');
MaweExportMenus.bindToolbarExportDropdown('extra-export-dropdown', 'extra-export-btn', 'extra-export-menu');
MaweExportMenus.bindToolbarExportDropdown('open-project-dropdown', 'open-project-menu-btn', 'open-project-menu');
MaweExportMenus.bindToolbarExportDropdown('save-project-dropdown', 'save-project-menu-btn', 'save-project-menu');
MaweExportMenus.bindToolbarExportDropdown('workspace-transfer-dropdown', 'workspace-transfer-btn', 'workspace-transfer-menu');
MaweExportMenus.bindToolbarExportDropdown('multi-subtitle-settings-dropdown', 'multi-subtitle-settings-toggle', 'multi-subtitle-settings-menu');
MaweExportMenus.bindToolbarExportDropdown(
  'batch-operations-dropdown', 'batch-operations-btn', 'batch-operations-menu',
  MaweExportMenus.positionBatchOperationsMenu,
);

MaweDom.projectMediaSelectButton.addEventListener('click', () => {
  MaweProjectMediaInputs.closeProjectMediaModal(false);
  MaweProjectMediaInputs.loadMediaFileInput.value = '';
  MaweProjectMediaInputs.loadMediaFileInput.click();
});

MaweDom.projectMediaLaterButton.addEventListener('click', () => {
  MaweProjectMediaInputs.closeProjectMediaModal(true);
  MaweHint.flashHint('可稍后点击“加载媒体”选择关联媒体', 'invalid');
});

MaweDom.projectMediaModal.addEventListener('click', (event) => {
  if (event.target === MaweDom.projectMediaModal) MaweDom.projectMediaLaterButton.click();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.projectMediaModal.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDom.projectMediaLaterButton.click();
}, true);

document.getElementById('new-project')?.addEventListener('click', async () => {
  if (MaweServerSave.hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定新建工程？将丢失未保存内容。')) return;
  await MaweProjectLoad.createProjectCheckpoint(MaweProjectLoad.buildBlankProject(), MaweProjectLoad.suggestedProjectName());
});

document.getElementById('open-project')?.addEventListener('click', () => {
  if (MaweServerSave.hasUnsavedProjectChanges()) {
    if (!confirm('当前有未保存的改动，是否确定打开新工程？将丢失未保存内容。')) return;
  }
  MaweProjectMediaInputs.openProjectFileInput.value = '';
  MaweProjectMediaInputs.openProjectFileInput.click();
});

MaweProjectMediaInputs.openProjectFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !isJsonFile(file)) {
    MaweHint.flashHint('请选择一个 .mosp 或 .json 工程文件。', 'invalid');
    return;
  }
  await MaweMultiImport.openProjectFile(file);
});

// === 加载媒体 ===
// 通过浏览器文件选择器选本地媒体（视频/音频），用 blob URL 替换播放器源。
// 如果媒体类型与当前播放器标签不一致（video<->audio），会原地替换整个 <video>/<audio> 元素。
document.getElementById('load-media')?.addEventListener('click', () => {
  MaweProjectMediaInputs.pendingProjectMediaSelection = null;
  MaweProjectMediaInputs.loadMediaFileInput.value = '';
  MaweProjectMediaInputs.loadMediaFileInput.click();
});
document.getElementById('load-srt')?.addEventListener('click', () => {
  MaweMultiSubtitleCore.pendingSrtImportAsExtension = false;
  if (MaweServerSave.hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定加载字幕？将替换当前字幕。')) return;
  MaweProjectMediaInputs.loadSrtFileInput.value = '';
  MaweProjectMediaInputs.loadSrtFileInput.click();
});

MaweProjectMediaInputs.loadSrtFileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  const importAsExtension = MaweMultiSubtitleCore.pendingSrtImportAsExtension;
  MaweMultiSubtitleCore.pendingSrtImportAsExtension = false;
  if (!file) return;
  if (importAsExtension) {
    try {
      const segments = await MaweLoadingProgress.parseSubtitleImportFile(file);
      await MaweMultiImport.showMultiSubtitleImportChoice(file, segments);
    } catch (error) {
      MaweHint.flashHint(`导入字幕失败：${error.message || error}`, 'warning');
    }
    return;
  }
  await MaweMultiImport.openSrtFile(file);
});

MaweDom.multiSubtitleImportResultCancel?.addEventListener('click', MaweMultiImport.closeMultiSubtitleImportModal);
MaweDom.multiSubtitleImportExtension?.addEventListener('click', MaweMultiImport.prepareMultiSubtitleImport);
MaweDom.multiSubtitleImportReplace?.addEventListener('click', () => {
  const pending = MaweMultiImport.pendingMultiImport;
  if (!pending) return;
  if (pending.projectImport) {
    pending.choice = 'open-project';
    pending.match = null;
    MaweDom.multiSubtitleImportReplace?.setAttribute('aria-pressed', 'true');
    MaweDom.multiSubtitleImportExtension?.setAttribute('aria-pressed', 'false');
    MaweMultiImport.renderProjectImportPreview(pending);
    if (MaweDom.multiSubtitleImportResultConfirm) MaweDom.multiSubtitleImportResultConfirm.disabled = false;
    return;
  }
  if (pending.existingTrackId) {
    MaweMultiImport.prepareMultiSubtitleImport();
    return;
  }
  pending.choice = 'replace-main';
  pending.match = null;
  if (MaweDom.multiSubtitleImportReplace) MaweDom.multiSubtitleImportReplace.setAttribute('aria-pressed', 'true');
  if (MaweDom.multiSubtitleImportExtension) MaweDom.multiSubtitleImportExtension.setAttribute('aria-pressed', 'false');
  MaweMultiImport.renderMainImportPreview(pending);
  if (MaweDom.multiSubtitleImportResultConfirm) MaweDom.multiSubtitleImportResultConfirm.disabled = false;
});
MaweDom.multiSubtitleImportResultConfirm?.addEventListener('click', async () => {
  const pending = MaweMultiImport.pendingMultiImport;
  if (!pending?.choice) return;
  if (pending.choice === 'open-project') {
    const { projectFile, projectMediaFile } = pending;
    MaweMultiImport.closeMultiSubtitleImportModal();
    const opened = await MaweMultiImport.openProjectFile(projectFile, { suppressMediaPrompt: Boolean(projectMediaFile) });
    if (opened && projectMediaFile) await MaweMediaLoad.loadMediaFile(projectMediaFile);
    return;
  }
  if (pending.choice === 'replace-main') {
    const { segments, file } = pending;
    MaweMultiImport.closeMultiSubtitleImportModal();
    MaweProjectLoad.replaceMainTrack(segments, file.name);
    return;
  }
  MaweMultiImport.commitMultiSubtitleImport();
});
MaweDom.multiSubtitleImportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.multiSubtitleImportModal) MaweMultiImport.closeMultiSubtitleImportModal();
});
MaweDom.multiSubtitleSplitCancel?.addEventListener('click', closeLinkedSplitModal);
MaweDom.multiSubtitleSplitConfirm?.addEventListener('click', confirmLinkedSplit);
MaweDom.multiSubtitleSplitModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.multiSubtitleSplitModal) closeLinkedSplitModal();
});
// 鼠标点击 lane 会自然聚焦；这里同步 keyboardLane，供失焦后的 WASD 回退使用。
MaweDom.multiSubtitleSplitMainText?.addEventListener('focus', () => {
  if (pendingLinkedSplit) pendingLinkedSplit.keyboardLane = 'main';
});
MaweDom.multiSubtitleSplitText?.addEventListener('focus', () => {
  if (pendingLinkedSplit) pendingLinkedSplit.keyboardLane = 'extension';
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.multiSubtitleImportModal?.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweMultiImport.closeMultiSubtitleImportModal();
}, true);
// 拆分弹窗的键盘流：Tab 切换主/副 lane，WASD 或方向键移动 ✂️，
// Space 确认/取消确认断点；捕获阶段拦截，避免触发全局的选字幕与播放快捷键。
document.addEventListener('keydown', (event) => {
  if (!MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeLinkedSplitModal();
    return;
  }
  const state = pendingLinkedSplit;
  if (!state) return;
  // 焦点在弹窗内原生控件（复选框/按钮）上时保留其自身键盘行为。
  const target = event.target instanceof Element ? event.target : null;
  const onNativeControl = Boolean(
    target?.closest('button, input, select, textarea, a, [contenteditable]'),
  );
  if (event.key === 'Tab' && !onNativeControl) {
    const current = splitKeyboardActiveLane(state);
    const nextLane = splitKeyboardSwitchLane(state, current);
    if (!nextLane || nextLane === current) return;
    event.preventDefault();
    event.stopPropagation();
    focusSplitLane(state, nextLane);
    return;
  }
  if (!event.repeat
      && (event.key === 'Enter' || event.key === 'b' || event.key === 'B')
      && !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) {
    event.preventDefault();
    event.stopPropagation();
    confirmLinkedSplit();
    return;
  }
  if (MaweKeyboardTargets.isSpaceKey(event)) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (onNativeControl || event.repeat) return;
    const lane = splitKeyboardActiveLane(state);
    if (!lane || !splitLaneVisible(lane)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleSplitLaneKeyboardLock(state, lane);
    return;
  }
  const key = event.key.toLowerCase();
  const horizontal = key === 'a' || event.key === 'ArrowLeft' ? -1
    : key === 'd' || event.key === 'ArrowRight' ? 1 : 0;
  const vertical = key === 'w' || event.key === 'ArrowUp' ? -1
    : key === 's' || event.key === 'ArrowDown' ? 1 : 0;
  if (!horizontal && !vertical) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const lane = splitKeyboardActiveLane(state);
  if (!lane) return;
  if (!splitLaneKeyboardInteractive(state, lane)) {
    // ⌚️ 时间码锚定的主轨静默忽略；Space/点击锁定的 lane 闪烁边缘并提示先解锁。
    if (!event.repeat && splitLaneLocked(state, lane)) flashSplitLaneBlockedFeedback(lane);
    return;
  }
  const nextOffset = vertical
    ? verticalSplitLaneOffset(state, lane, vertical)
    : stepSplitLaneOffset(state, lane, horizontal);
  if (!Number.isFinite(nextOffset)) return;
  event.preventDefault();
  event.stopPropagation();
  updateLinkedSplitPreview(nextOffset, lane);
}, true);

MaweProjectMediaInputs.loadMediaFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!MaweProjectMediaInputs.pendingProjectMediaSelection && !await MaweProjectLoad.ensureProjectCheckpointForImport(file)) return;
  MaweProjectMediaInputs.pendingProjectMediaSelection = null;
  const imported = await MaweMediaLoad.loadMediaFile(file);
  if (imported) {
    MaweServerSave.projectImportDirty = true;
    if (MaweServerSave.projectSaveTargetEnabled()) await MaweProjectSave.saveCurrentProject({ silent: true });
  }
});

MaweProjectMediaInputs.loadMediaFileInput.addEventListener('cancel', () => {
  MaweProjectMediaInputs.pendingProjectMediaSelection = null;
});

document.getElementById('sticker-root-confirm')?.addEventListener('click', () => {
  const newRoot = MaweStickerRoot.stickerRootInput.value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  MaweBoot.STICKER_ROOT = newRoot;
  MaweExportTimeline.updateStickerExportButtons();
  MaweStickerRoot.stickerRootModal.classList.remove('show');
  MaweStickerRoot.stickerRootReturnFocus?.focus();
  MaweStickerRoot.stickerRootReturnFocus = null;
  // 重新渲染所有 cue 让 sticker URL 用新根目录拼接
  renderAll();
  MaweHint.flashHint(newRoot ? `根目录已更新` : '已清空根目录', 'success');
});

if (!MaweStickerRoot.stickerRootServerEnabled) {
  MaweStickerRoot.stickerRootInput.disabled = true;
  MaweStickerRoot.stickerRootRead.disabled = true;
}

document.getElementById('sticker-root-btn')?.addEventListener('click', () => {
  MaweStickerRoot.stickerRootInput.value = MaweBoot.STICKER_ROOT || '';
  MaweStickerRoot.setStickerRootStatus(MaweStickerRoot.stickerRootServerEnabled
    ? (MaweBoot.STICKER_ROOT
      ? `当前路径已读取 ${Number(MaweBoot.SERVER_CONFIG.initialStickerCount) || MaweBoot.STICKERS.length} 张图片。可输入 Windows、macOS 或 Linux 绝对路径。`
      : '请输入绝对路径，例如 C:\\Media\\Stickers、/Users/name/Stickers 或 /home/name/Stickers。')
    : '仅 Server 编辑器可以读取和验证表情包绝对路径。');
  MaweStickerRoot.setStickerRootModalOpen(true);
});

document.getElementById('sticker-root-cancel')?.addEventListener('click', () => MaweStickerRoot.setStickerRootModalOpen(false));
MaweStickerRoot.stickerRootModal?.addEventListener('click', (event) => {
  if (event.target === MaweStickerRoot.stickerRootModal) MaweStickerRoot.setStickerRootModalOpen(false);
});
MaweStickerRoot.stickerRootModal?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    MaweStickerRoot.setStickerRootModalOpen(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...MaweStickerRoot.stickerRootModal.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

MaweStickerRoot.stickerRootRead.addEventListener('click', async () => {
  if (!MaweStickerRoot.stickerRootServerEnabled || MaweStickerRoot.stickerRootRead.disabled) return;
  const path = MaweStickerRoot.stickerRootInput.value.trim();
  MaweStickerRoot.stickerRootHintCard?.remove();
  MaweStickerRoot.stickerRootHintCard = null;
  MaweStickerRoot.stickerRootRead.disabled = true;
  MaweStickerRoot.stickerRootInput.disabled = true;
  MaweStickerRoot.setStickerRootStatus('正在读取并验证表情包目录…');
  try {
    const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.stickerRootUrl, window.location.href), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, path }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `服务器返回 ${response.status}`);
    MaweBoot.STICKERS.splice(0, MaweBoot.STICKERS.length, ...result.stickers);
    MaweBoot.STICKER_ROOT = result.root;
    MaweBoot.SERVER_CONFIG.initialStickerCount = result.count;
    MaweStickerRoot.stickerRootInput.value = result.root;
    MaweStickerOverlay.stickerAssetRevision += 1;
    MaweServerSave.projectImportDirty = true;
    renderAll();
    MaweStickerRoot.setStickerRootStatus(`路径有效，已读取 ${result.count} 张图片。`);
    MaweStickerRoot.flashStickerRootHint(`表情包根目录已更新，读取 ${result.count} 张图片`, 'success');
  } catch (error) {
    MaweStickerRoot.setStickerRootStatus(`读取失败：${error.message || error}。当前有效根目录和表情包保持不变。`);
    MaweStickerRoot.flashStickerRootHint(`表情包根目录读取失败：${error.message || error}`, 'warning');
  } finally {
    MaweStickerRoot.stickerRootRead.disabled = false;
    MaweStickerRoot.stickerRootInput.disabled = false;
    MaweStickerRoot.stickerRootInput.focus();
  }
});

[MaweFindReplace.findInput, MaweFindReplace.replaceInput].forEach(el => el.addEventListener('input', MaweFindReplace.updatePreview));
[MaweFindReplace.caseSensitiveCb, MaweFindReplace.useRegexCb].forEach(el => el.addEventListener('change', MaweFindReplace.updatePreview));
MaweFindReplace.replaceSelectedOnlyCb?.addEventListener('change', () => {
  MaweFindReplace.replaceScope = MaweFindReplace.replaceSelectedOnlyCb.checked ? [...MaweFindReplace.replaceSelectionSnapshot] : null;
  MaweFindReplace.refreshScopeInfo();
  MaweFindReplace.updatePreview();
});

document.getElementById('replace-btn')?.addEventListener('click', () => MaweFindReplace.openReplaceModal(null));
document.getElementById('replace-cancel')?.addEventListener('click', () => MaweDom.replaceModal.classList.remove('show'));
MaweDom.replaceModal.addEventListener('click', (e) => { if (e.target === MaweDom.replaceModal) MaweDom.replaceModal.classList.remove('show'); });
document.getElementById('replace-confirm')?.addEventListener('click', () => {
  const re = MaweFindReplace.buildReplaceRegex();
  if (!re || re.error) return;
  const repl = MaweFindReplace.replaceInput.value;
  // 先 dry-run 确认是否真的会改动，避免空操作压栈
  let willChange = 0;
  MaweFindReplace.getReplaceTargets().forEach(s => {
    re.lastIndex = 0;
    if (s.text.replace(re, repl) !== s.text) willChange++;
  });
  if (willChange === 0) {
    MaweDom.replaceModal.classList.remove('show');
    MaweHint.flashHint('没有匹配的内容', 'invalid');
    return;
  }
  MaweHistory.pushUndo('批量替换');
  let changedRows = 0;
  MaweFindReplace.getReplaceTargets().forEach(s => {
    re.lastIndex = 0;
    const newText = s.text.replace(re, repl);
    if (newText !== s.text) { s.text = newText; s._dirty = true; changedRows++; }
  });
  MaweDom.replaceModal.classList.remove('show');
  renderAll();
  MaweHint.flashHint(`已修改 ${changedRows} 行`, 'success');
});

MaweTextProcess.textProcessButton?.addEventListener('click', MaweTextProcess.openTextProcessModal);
MaweTextProcess.textProcessSelectedOnlyCb?.addEventListener('change', () => {
  MaweTextProcess.textProcessScope = MaweTextProcess.textProcessSelectedOnlyCb.checked
    ? [...MaweTextProcess.textProcessSelectionSnapshot] : null;
  MaweTextProcess.refreshTextProcessScopeInfo();
  MaweTextProcess.renderTextProcessPreview();
});
[MaweTextProcess.textProcessTrim, MaweTextProcess.textProcessCapitalize, MaweTextProcess.textProcessPrefix,
  MaweTextProcess.textProcessSuffix, MaweTextProcess.textProcessStripMarkdown].forEach((input) => {
  input?.addEventListener('change', () => {
    MaweTextProcess.refreshTextProcessInputState();
    MaweTextProcess.renderTextProcessPreview();
  });
});
[MaweTextProcess.textProcessPrefixInput, MaweTextProcess.textProcessSuffixInput].forEach((input) => {
  input?.addEventListener('input', MaweTextProcess.renderTextProcessPreview);
});
document.getElementById('text-process-cancel')?.addEventListener('click', MaweTextProcess.closeTextProcessModal);
MaweDom.textProcessModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.textProcessModal) MaweTextProcess.closeTextProcessModal();
});
MaweTextProcess.textProcessConfirm?.addEventListener('click', () => {
  const options = MaweTextProcess.getTextProcessOptions();
  const result = {
    rows: MaweTextProcess.buildTextProcessPreview(MaweTextProcess.textProcessTargets(), options),
  };
  result.changedCount = result.rows.filter((row) => row.changed).length;
  if (!result.changedCount) {
    MaweHint.flashHint('当前文本处理对于选中的字幕没有任何影响，未作改动', 'invalid');
    return;
  }
  let mainDraftTexts = null;
  const extensionDrafts = new Map();
  result.rows.filter((row) => row.changed).forEach((row) => {
    if (row.kind === 'extension') {
      const track = MaweMultiSubtitleCore.getExtensionTrack(row.trackId);
      if (!track) return;
      const draft = extensionDrafts.get(track.id) || {
        track,
        texts: track.segments.map((segment) => String(segment?.text || '')),
      };
      draft.texts[row.index] = row.after;
      extensionDrafts.set(track.id, draft);
      return;
    }
    if (!mainDraftTexts) {
      mainDraftTexts = MaweBoot.DATA.segments.map((segment) => String(segment?.text || ''));
    }
    mainDraftTexts[row.index] = row.after;
  });
  const nextMainSegments = mainDraftTexts
    ? window.AsrEditorUtils.applyTimedTextEdit(MaweBoot.DATA.segments, mainDraftTexts)
    : null;
  const nextExtensionSegments = [];
  for (const draft of extensionDrafts.values()) {
    const nextSegments = window.AsrEditorUtils.applyTimedTextEdit(draft.track.segments, draft.texts);
    if (!nextSegments) {
      MaweHint.flashHint('无法应用文本处理：字幕行结构发生了变化', 'warning');
      return;
    }
    nextExtensionSegments.push({ track: draft.track, segments: nextSegments });
  }
  if (mainDraftTexts && !nextMainSegments) {
    MaweHint.flashHint('无法应用文本处理：字幕行结构发生了变化', 'warning');
    return;
  }
  MaweHistory.pushUndo('文本处理');
  if (nextMainSegments) {
    MaweBoot.DATA.segments.splice(0, MaweBoot.DATA.segments.length, ...nextMainSegments);
    MaweMultiSubtitleCore.markMainSegmentsDirty(MaweBoot.DATA.segments);
  }
  nextExtensionSegments.forEach(({ track, segments }) => {
    track.segments.splice(0, track.segments.length, ...segments);
    track.segments.forEach((segment) => { segment._dirty = true; });
  });
  if (nextExtensionSegments.length) MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweMultiSubtitleCore.syncBindingOffsets();
  MaweServerSave.scheduleAutoSaveFlush();
  MaweTextProcess.closeTextProcessModal();
  renderAll({ waveform: 'overlay' });
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweHistory.updateUndoRedoButtons();
  MaweHint.flashHint(`已应用文本处理：${result.changedCount} 条字幕`, 'success');
});

MaweDom.timedTextEditButton?.addEventListener('click', MaweTimedTextEdit.openTimedTextEdit);
MaweDom.timedTextEditRows?.addEventListener('input', (event) => {
  const textarea = event.target.closest?.('textarea[data-index]');
  if (!textarea || !MaweDom.timedTextEditDraft) return;
  const index = Number(textarea.dataset.index);
  if (!Number.isInteger(index) || index < 0 || index >= MaweDom.timedTextEditDraft.texts.length) return;
  const replacementLines = textarea.value.replace(/\r\n?/g, '\n').split('\n');
  MaweDom.timedTextEditDraft.texts.splice(index, 1, ...replacementLines);
  MaweDom.timedTextEditDraft.texts = MaweTimedTextEdit.normalizeTimedTextEditDraftLines(MaweDom.timedTextEditDraft.texts);
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  MaweDom.timedTextEditDraft.singleLineError = '';
  MaweTimedTextEdit.renderTimedTextEditView();
  MaweTimedTextEdit.scheduleTimedTextEditReport();
});
MaweDom.timedTextEditSingleTextarea?.addEventListener('input', () => {
  if (!MaweDom.timedTextEditDraft) return;
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditSingleTextarea.value.replace(/\r\n?/g, '\n');
  MaweDom.timedTextEditDraft.texts = MaweTimedTextEdit.normalizeTimedTextEditDraftLines(
    MaweDom.timedTextEditDraft.singleText.split('\n'),
  );
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  MaweDom.timedTextEditDraft.singleLineError = '';
  MaweTimedTextEdit.scheduleTimedTextEditReport();
});
MaweDom.timedTextEditView?.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-view]');
  if (!button || button.disabled || !MaweDom.timedTextEditDraft) return;
  // 视图切换可能紧跟在浏览器原生输入事件之前；以 textarea 当前值为准，
  // 避免“整体编辑”切到“逐行编辑”时回填旧草稿，导致修改前/修改后相同。
  MaweTimedTextEdit.syncTimedTextEditDraftFromDom();
  const nextView = button.dataset.view === 'single' ? 'single' : 'rows';
  if (nextView === 'single' && !MaweTimedTextEdit.timedTextEditCanUseSingleView()) {
    MaweHint.flashHint('当前字幕包含换行，暂不能切换到整体编辑视图', 'invalid');
    return;
  }
  MaweDom.timedTextEditDraft.view = nextView;
  if (nextView === 'single') MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  else MaweTimedTextEdit.renderTimedTextEditRows();
  MaweTimedTextEdit.renderTimedTextEditView();
  MaweTimedTextEdit.flushTimedTextEditReport();
  setTimeout(() => (nextView === 'single'
    ? MaweDom.timedTextEditSingleTextarea : MaweDom.timedTextEditRows.querySelector('textarea'))?.focus(), 0);
});
MaweDom.timedTextEditShowAll?.addEventListener('click', () => {
  if (!MaweDom.timedTextEditDraft) return;
  MaweDom.timedTextEditDraft.filter = null;
  MaweTimedTextEdit.flushTimedTextEditReport();
});
MaweDom.timedTextEditShowDisabledToggle?.addEventListener('change', () => {
  if (!MaweDom.timedTextEditDraft) return;
  const nextShowDisabled = MaweDom.timedTextEditShowDisabledToggle.checked;
  if (nextShowDisabled === MaweDom.timedTextEditDraft.showDisabled) return;
  if (MaweTimedTextEdit.timedTextEditHasUnappliedChanges()
      && !window.confirm('切换显示范围会丢弃当前未应用的文本修改，是否继续？')) {
    MaweDom.timedTextEditShowDisabledToggle.checked = MaweDom.timedTextEditDraft.showDisabled;
    return;
  }
  MaweTimedTextEdit.loadTimedTextEditTrack(MaweDom.timedTextEditDraft.kind, { showDisabled: nextShowDisabled });
});
MaweDom.timedTextEditTrack?.addEventListener('change', () => {
  if (!MaweDom.timedTextEditDraft) return;
  if (MaweTimedTextEdit.timedTextEditHasUnappliedChanges()) {
    const confirmed = window.confirm('切换轨道会丢弃当前未应用的文本修改，是否继续？');
    if (!confirmed) {
      MaweDom.timedTextEditTrack.value = MaweDom.timedTextEditDraft.kind;
      return;
    }
  }
  MaweTimedTextEdit.loadTimedTextEditTrack(MaweDom.timedTextEditTrack.value, {
    showDisabled: MaweDom.timedTextEditDraft.showDisabled === true,
  });
});
MaweDom.timedTextEditClose?.addEventListener('click', MaweTimedTextEdit.requestCloseTimedTextEdit);
MaweDom.timedTextEditCancel?.addEventListener('click', MaweTimedTextEdit.requestCloseTimedTextEdit);
MaweDom.timedTextEditModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.timedTextEditModal) MaweTimedTextEdit.requestCloseTimedTextEdit();
});
MaweDom.timedTextEditApply?.addEventListener('click', () => {
  const draft = MaweDom.timedTextEditDraft;
  if (!draft) return;
  MaweTimedTextEdit.syncTimedTextEditDraftFromDom();
  MaweTimedTextEdit.flushTimedTextEditReport();
  if (!draft.report?.valid) return;
  if (!draft.report.stats.changedSegments) {
    MaweHint.flashHint('当前没有文本修改，未作改动', 'invalid');
    return;
  }
  const targetSegments = MaweTimedTextEdit.timedTextEditSegments(draft.kind);
  const snapshotSegments = Array.isArray(draft.allSourceSegments)
    ? draft.allSourceSegments : draft.sourceSegments;
  const currentMatchesSnapshot = targetSegments.length === snapshotSegments.length
    && targetSegments.every((segment, index) => {
      const source = snapshotSegments[index];
      return segment?.id === source?.id
        && Number(segment?.start) === Number(source?.start)
        && Number(segment?.end) === Number(source?.end)
        && String(segment?.text || '') === String(source?.text || '')
        && Boolean(segment?.disabled) === Boolean(source?.disabled);
    });
  if (!currentMatchesSnapshot) {
    MaweHint.flashHint('字幕在编辑窗口打开后发生了变化，请关闭窗口并重新打开', 'warning');
    MaweTimedTextEdit.closeTimedTextEdit();
    return;
  }
  const nextSegments = window.AsrEditorUtils.applyTimedTextEdit(
    draft.sourceSegments,
    draft.texts,
  );
  if (!nextSegments) {
    MaweHint.flashHint('无法应用文本修改：字幕行结构发生了变化', 'warning');
    return;
  }
  MaweHistory.pushUndo('纯文本编辑');
  const dirtyFlags = window.AsrEditorUtils.timedTextEditDirtyFlags(
    draft.sourceSegments,
    nextSegments,
    draft.report,
  );
  nextSegments.forEach((segment, index) => {
    if (dirtyFlags[index]) segment._dirty = true;
    else delete segment._dirty;
  });
  const removedCount = MaweTimedTextEdit.applyTimedTextEditSegments(
    draft.kind,
    draft.sourceSegments,
    targetSegments,
    nextSegments,
    draft.report,
    draft.texts,
    draft.sourceSegmentIndexes,
  );
  if (draft.kind === 'extension') MaweMultiSubtitleCore.markMultiSubtitleStateDirty();
  MaweMultiSubtitleCore.syncBindingOffsets();
  // 纯文本编辑应用后暂不主动触发自动保存，让 dirty 标记短暂保留，
  // 便于用户确认哪些字幕确实发生了变化；已有的自动保存计时器仍照常执行。
  const changedCount = draft.report.stats.changedSegments;
  const lostCount = draft.report.stats.lostMappedCues;
  const estimatedCount = draft.report.stats.estimatedTimingCues || 0;
  MaweTimedTextEdit.closeTimedTextEdit();
  renderAll({ waveform: 'overlay' });
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweHistory.updateUndoRedoButtons();
  MaweHint.flashHint(
    `已应用纯文本编辑：${changedCount} 条字幕${removedCount ? `，移除 ${removedCount} 条空字幕行` : ''}${lostCount ? `，${lostCount} 条字词时间码已清除` : ''}${estimatedCount ? `，${estimatedCount} 条时间范围为自动估算` : ''}`,
    'success',
  );
});

document.getElementById('sticker-filter')?.addEventListener('input', (e) => {
  MaweStickerPicker.renderStickerGrid(e.target.value);
});
document.getElementById('sticker-cancel')?.addEventListener('click', () => MaweDom.stickerModal.classList.remove('show'));
document.getElementById('sticker-clear')?.addEventListener('click', MaweStickerPicker.clearStickerOnTargets);
MaweDom.stickerModal?.addEventListener('click', (e) => { if (e.target === MaweDom.stickerModal) MaweDom.stickerModal.classList.remove('show'); });
document.getElementById('sticker-preview-close')?.addEventListener('click', () => MaweDom.stickerPreviewModal.classList.remove('show'));
MaweDom.stickerPreviewModal?.addEventListener('click', (e) => { if (e.target === MaweDom.stickerPreviewModal) MaweDom.stickerPreviewModal.classList.remove('show'); });
document.getElementById('sticker-preview-delete')?.addEventListener('click', () => {
  if (MaweStickerPicker.previewIdx < 0) return;
  // 如果删除的是 head，要把所有引用它的 sticker_ref 也清掉
  MaweStickerPicker.removeStickerCascade(MaweStickerPicker.previewIdx);
  MaweDom.stickerPreviewModal.classList.remove('show');
  renderAll();
  MaweHint.flashHint('已删除', 'success');
});
document.getElementById('sticker-preview-replace')?.addEventListener('click', () => {
  if (MaweStickerPicker.previewIdx < 0) return;
  MaweDom.stickerPreviewModal.classList.remove('show');
  MaweStickerPicker.openStickerPicker([MaweStickerPicker.previewIdx], false);
});
// 使用捕获阶段的 pointerdown：波形空白区自己的 pointerdown 可能阻止后续
// click 事件，不能再依赖 mouseup 后才触发的 document.click 来关闭菜单。
document.addEventListener('pointerdown', MaweContextMenus.closeContextMenuOnOutsidePointerDown, true);
// 保留键盘触发 click 的关闭路径；真实鼠标/触控操作已经在 pointerdown 阶段关闭。
document.addEventListener('click', (e) => {
  if (e.detail === 0) MaweContextMenus.closeContextMenuOnOutsidePointerDown(e);
});
document.addEventListener('contextmenu', (e) => {
  // 非 cue 上的右键关闭菜单
  if (!e.target.closest('.cue') && !e.target.closest('.waveform-cue-block')) {
    MaweDom.ctxmenu.classList.remove('show');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && MaweDom.ctxmenu.classList.contains('show')) {
    MaweDom.ctxmenu.classList.remove('show');
  }
});
document.addEventListener('asr:waveform-scale-limit', (event) => {
  const { atMin, atMax } = event.detail || {};
  const msg = atMin ? '已经到达最小振幅' : atMax ? '已经达到最大振幅' : '';
  if (!msg) return;
  const now = Date.now();
  if (msg === MaweHint.lastScaleLimitMsg && now - MaweHint.lastScaleLimitAt < 1200) return;
  MaweHint.lastScaleLimitMsg = msg;
  MaweHint.lastScaleLimitAt = now;
  MaweHint.flashHint(msg);
});

document.addEventListener('asr:waveform-loudness-unavailable', () => {
  MaweHint.flashHint('当前媒体没有响度缓存，无法按响度适配', 'warning');
});

// Server-editor 页面可能在本地服务退出后继续留在浏览器中。定期复用
// startup-status 这个轻量 JSON 接口：断联时保留页面里的编辑内容，并显示
// 持久横幅；服务恢复后自动清掉横幅，不刷新页面，避免覆盖未保存的改动。
const SERVER_CONNECTION_CHECK_INTERVAL_MS = 2000;
const SERVER_CONNECTION_REQUEST_TIMEOUT_MS = 1500;
const SERVER_CONNECTION_FAILURE_THRESHOLD = 2;
const serverConnectionBanner = document.getElementById('server-connection-banner');
let serverConnectionCheckTimer = 0;
let serverConnectionCheckInFlight = false;
let serverConnectionFailureCount = 0;

function serverConnectionCheckUrl() {
  return MaweBoot.SERVER_CONFIG?.healthUrl || MaweBoot.SERVER_CONFIG?.startupStatusUrl || '';
}

function renderServerConnectionBanner(disconnected) {
  if (serverConnectionBanner) serverConnectionBanner.hidden = !disconnected;
}

function scheduleServerConnectionCheck(delayMs = SERVER_CONNECTION_CHECK_INTERVAL_MS) {
  if (!serverConnectionCheckUrl()) return;
  if (serverConnectionCheckTimer) window.clearTimeout(serverConnectionCheckTimer);
  serverConnectionCheckTimer = window.setTimeout(() => {
    serverConnectionCheckTimer = 0;
    void checkServerConnection();
  }, Math.max(0, delayMs));
}

async function checkServerConnection() {
  const url = serverConnectionCheckUrl();
  if (!url || serverConnectionCheckInFlight) return;
  serverConnectionCheckInFlight = true;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), SERVER_CONNECTION_REQUEST_TIMEOUT_MS);
  let healthy = false;
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    const result = await response.json().catch(() => null);
    healthy = response.ok && result?.ok === true;
  } catch (_error) {
    // A refused/aborted local request is the expected signal that the server disappeared.
  } finally {
    window.clearTimeout(timeout);
    serverConnectionCheckInFlight = false;
  }

  if (healthy) {
    serverConnectionFailureCount = 0;
    renderServerConnectionBanner(false);
  } else {
    serverConnectionFailureCount += 1;
    if (serverConnectionFailureCount >= SERVER_CONNECTION_FAILURE_THRESHOLD) {
      renderServerConnectionBanner(true);
    }
  }
  scheduleServerConnectionCheck();
}

function startServerConnectionMonitor() {
  if (!serverConnectionBanner || !serverConnectionCheckUrl()) return;
  renderServerConnectionBanner(false);
  void checkServerConnection();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleServerConnectionCheck(0);
});
window.addEventListener('online', () => scheduleServerConnectionCheck(0));

const SERVER_STARTUP_LABELS = {
  zh: {
    starting: '正在启动编辑器…',
    reading_project: '正在读取工程…',
    validating_project: '正在校验工程…',
    preparing_media: '正在准备媒体…',
    loading_waveform_cache: '正在读取波形缓存…',
    generating_waveform: '未找到可用缓存，正在生成波形…',
    waveform_ready: '波形已就绪…',
    waveform_unavailable: '波形缓存不可用，继续加载…',
    loading_spectral_cache: '正在读取频谱缓存…',
    loading_reapeaks_waveform: '正在读取 REAPER 波形缓存…',
    loading_loudness_stats: '正在读取响度统计…',
    waveform_skipped: '已跳过波形处理…',
    finalizing: '正在完成工程加载…',
    ready: '工程加载完成',
    error: '工程加载失败',
    preparing: '正在准备工程…',
  },
  en: {
    starting: 'Starting editor…',
    reading_project: 'Reading project…',
    validating_project: 'Validating project…',
    preparing_media: 'Preparing media…',
    loading_waveform_cache: 'Reading waveform cache…',
    generating_waveform: 'No usable cache found; generating waveform…',
    waveform_ready: 'Waveform ready…',
    waveform_unavailable: 'Waveform cache unavailable; continuing…',
    loading_spectral_cache: 'Reading spectral cache…',
    loading_reapeaks_waveform: 'Reading REAPER waveform cache…',
    loading_loudness_stats: 'Reading loudness stats…',
    waveform_skipped: 'Waveform processing skipped…',
    finalizing: 'Finishing project loading…',
    ready: 'Project loaded',
    error: 'Project loading failed',
    preparing: 'Preparing project…',
  },
};

function serverStartupLabel(stage) {
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  return SERVER_STARTUP_LABELS[language][stage] || SERVER_STARTUP_LABELS[language].preparing;
}

async function loadServerStartup() {
  const url = MaweBoot.SERVER_CONFIG?.startupStatusUrl;
  const status = MaweBoot.SERVER_CONFIG?.startupStatus;
  if (!url || status === 'ready') return;
  if (status === 'error') {
    const detail = MaweBoot.SERVER_CONFIG.startupError || serverStartupLabel('error');
    MaweHint.flashHint(`${serverStartupLabel('error')}：${detail}`, 'warning');
    return;
  }

  const finishLoading = MaweLoadingProgress.beginEditorLoading(
    serverStartupLabel(MaweBoot.SERVER_CONFIG.startupStage),
    MaweBoot.SERVER_CONFIG.startupProgress,
  );
  const poll = async () => {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) {
        throw new Error(result.error || `服务器返回 ${response.status}`);
      }
      if (result.status === 'ready') {
        MaweLoadingProgress.updateEditorLoading(100, serverStartupLabel('ready'));
        finishLoading();
        // 页面中的 DATA、媒体标签和保存能力都由服务端工程一起渲染；
        // 工程准备好后刷新一次即可无竞态地接管完整工程和波形。
        window.location.reload();
        return;
      }
      if (result.status === 'error') {
        finishLoading();
        MaweHint.flashHint(
          `${serverStartupLabel('error')}：${result.error || serverStartupLabel('error')}`,
          'warning',
        );
        return;
      }
      MaweLoadingProgress.updateEditorLoading(result.progress, serverStartupLabel(result.stage));
      window.setTimeout(() => { void poll(); }, 500);
    } catch (_error) {
      window.setTimeout(() => { void poll(); }, 1000);
    }
  };
  await poll();
}

// === Drag & Drop：拖入视频/音频/JSON/SRT 自动加载 ===
const dragOverlay = document.getElementById('drag-overlay');
function isJsonFile(f) {
  const name = f.name.toLowerCase();
  return f.type === 'application/json' || name.endsWith('.json') || name.endsWith('.mosp');
}
function isSrtFile(f) {
  return f.name.toLowerCase().endsWith('.srt');
}
async function handleDroppedFiles(files) {
  if (!files.length) return;
  const finishLoading = MaweLoadingProgress.beginEditorLoading('正在处理拖入文件…', 2);
  try {
  const mediaFile = files.find(MaweCoreState.isMediaFile);
  const reapeaksFile = files.find(MaweCoreState.isReapeaksFile);
  const jsonFile = files.find(isJsonFile);
  const srtFile = files.find(isSrtFile);
  let stagedSrtSegments = null;
  if (!mediaFile && !reapeaksFile && !jsonFile && !srtFile) {
    MaweHint.flashHint('不支持的文件类型（仅支持视频 / 音频 / JSON / SRT / reapeaks）', 'warning');
    return;
  }
  if (jsonFile) {
    if (MaweBoot.DATA.segments.length > 0) {
      if (MaweServerSave.hasUnsavedProjectChanges()
          && !confirm('当前有未保存的改动，是否继续处理此工程文件？选择“打开工程”仍会替换当前工程。')) return;
      try {
        const segments = await MaweLoadingProgress.parseSubtitleImportFile(jsonFile);
        await MaweMultiImport.showMultiSubtitleImportChoice(jsonFile, segments, {
          projectFile: jsonFile,
          projectMediaFile: mediaFile,
        });
      } catch (error) {
        MaweHint.flashHint(`导入工程字幕失败：${error.message || error}`, 'warning');
      }
      return;
    }
    // 工程与媒体一起拖入时，媒体随工程自动加载，不再弹窗要求重选。
    const opened = await MaweMultiImport.openProjectFile(jsonFile, { suppressMediaPrompt: Boolean(mediaFile) });
    if (opened && mediaFile) await MaweMediaLoad.loadMediaFile(mediaFile);
    return;
  }
  if (reapeaksFile && !mediaFile && !srtFile) {
    await MaweMediaLoad.loadReapeaksFile(reapeaksFile);
    return;
  }
  if (srtFile && MaweBoot.DATA.segments.length === 0) {
    try {
      stagedSrtSegments = MaweProjectLoad.parseSrtSegments(await MaweLoadingProgress.readFileTextWithProgress(srtFile));
    } catch (error) {
      MaweHint.flashHint(`导入字幕失败：${error.message || error}`, 'warning');
      return;
    }
  }
  if ((mediaFile || srtFile) && !await MaweProjectLoad.ensureProjectCheckpointForImport(mediaFile || srtFile, { usePicker: false })) return;
  if (mediaFile) {
    const imported = await MaweMediaLoad.loadMediaFile(mediaFile);
    if (imported) MaweServerSave.projectImportDirty = true;
  }
  if (reapeaksFile) await MaweMediaLoad.loadReapeaksFile(reapeaksFile);
  if (srtFile) {
    if (MaweBoot.DATA.segments.length > 0) {
      try {
        const segments = await MaweLoadingProgress.parseSubtitleImportFile(srtFile);
        await MaweMultiImport.showMultiSubtitleImportChoice(srtFile, segments);
      } catch (error) {
        MaweHint.flashHint(`导入字幕失败：${error.message || error}`, 'warning');
      }
    } else {
      MaweProjectLoad.replaceMainTrack(stagedSrtSegments, srtFile.name);
    }
  }
  if ((mediaFile || srtFile) && MaweServerSave.projectSaveTargetEnabled()) await MaweProjectSave.saveCurrentProject({ silent: true });
  MaweLoadingProgress.updateEditorLoading(100, '文件加载完成');
  } finally {
    finishLoading();
  }
}
let dragCounter = 0;  // dragenter/leave 计数，避免子元素进出导致遮罩闪烁
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) dragOverlay.classList.add('show');
});
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer) return;
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dragOverlay.classList.remove('show'); }
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  dragCounter = 0;
  dragOverlay.classList.remove('show');
  void handleDroppedFiles(Array.from(e.dataTransfer.files));
});

// === 启动 ===
// 兜底：工程可能带有上游写入的 0 长/倒挂段、词时间码（旧版工具或异常识别结果），
// 加载时统一拉齐到至少 100ms，避免拆分后看不见字幕块、工程无法保存。
syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: MaweBoot.DATA.timebase?.unit === 'frames' });
const repairedGroupReferenceCount = window.AsrEditorUtils.repairGroupReferenceIndices(MaweBoot.DATA.segments);
const repairedTimingCount = normalizeProjectTimings(MaweBoot.DATA);
syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
MaweBoot.maweDebug('boot:begin', {
  server: Boolean(MaweBoot.SERVER_CONFIG),
  segments: Array.isArray(MaweBoot.DATA.segments) ? MaweBoot.DATA.segments.length : null,
  media: MaweBoot.DATA.media || '',
  recentProjects: MaweBoot.SERVER_CONFIG?.recentProjects?.length || 0,
});
MaweTextCleanup.cleanPunctuation();
MaweServerSave.configureServerSaveControls();
MaweServerSave.configureServerAutoSave();
MaweServerSave.configureRecentProjects();
MaweServerSave.configureServerProjectSettings();
MaweWaveformInit.initWaveformEditor();
MaweWorkspaces.configureServerWorkspaceLibrary();
MaweWorkspaces.configureWorkspaceTransfer();
MaweDom.totalCountEl.textContent = MaweBoot.DATA.segments.length;
// 新手引导通过这个窄桥接访问编辑器核心状态；引导本身在 editor-onboarding.js 中按需初始化。
window.MAWE_EDITOR_BRIDGE = Object.freeze({
  get data() { return MaweBoot.DATA; },
  get selectedIdxs() { return selectedIdxs; },
  get currentCuePanelIdx() { return MaweCuePanelState.currentCuePanelIdx; },
  get container() { return MaweCoreState.container; },
  get projectMediaModal() { return MaweDom.projectMediaModal; },
  selectOnly,
  performUndo: MaweHistory.performUndo,
  flashHint: MaweHint.flashHint,
  scrollCueToCenter,
  setEditorSettingsPanelOpen: MaweSettingsPanels.setEditorSettingsPanelOpen,
  modKeyLabel: MaweDisplaySettings.modKeyLabel,
  splitKeyLabel: MaweDisplaySettings.splitKeyLabel,
  openHelp: () => helpFloatingPanel.open(),
  openHelpAtTab,
  closeHelp: () => helpFloatingPanel.close(),
});
window.MAWE?.register('editor-bridge', () => window.MAWE_EDITOR_BRIDGE);
renderAll({ waveform: 'full' });
MaweBoot.maweDebug('boot:complete', {
  renderedSegments: MaweCoreState.container?.querySelectorAll?.('.cue-row')?.length || 0,
  recentProjectsVisible: MaweDom.recentProjectsEl ? !MaweDom.recentProjectsEl.hidden : false,
  mediaName: MaweProjectSave.mediaNameEl?.textContent || '',
  placeholderVisible: MaweDom.playerEmpty ? !MaweDom.playerEmpty.hidden : null,
});
updateGapRemoveUi();
if (repairedTimingCount > 0) {
  MaweHint.flashHint(`已自动修复 ${repairedTimingCount} 处异常时间码（保底 100ms）`, 'warning');
} else if (repairedGroupReferenceCount > 0) {
  MaweHint.flashHint(`已自动修复 ${repairedGroupReferenceCount} 处分组引用`, 'warning');
}
void loadServerStartup();
startServerConnectionMonitor();
if (MaweBoot.SERVER_CONFIG?.startupStatus !== 'loading') void MaweWaveformInit.loadDeferredReapeaks();

document.getElementById('filter-over')?.addEventListener('click', (e) => {
  e.currentTarget.classList.toggle('active');
  if (!e.currentTarget.classList.contains('active')) {
    clearTemporaryVisibleSplitCues();
  }
  applySearch(MaweDom.searchEl.value);
});

// 「隐藏禁用项」开关：开启后禁用项 display:none，并从选中集移除
MaweDom.hideDisabledToggle?.addEventListener('change', () => {
  const cueListAnchor = captureCueListRenderAnchor();
  MaweDom.hideDisabled = MaweDom.hideDisabledToggle.checked;
  MaweSettings.updateEditorSettings({ cueListHideDisabled: MaweDom.hideDisabled });
  MaweCoreState.container.classList.toggle('hide-disabled', MaweDom.hideDisabled);
  if (MaweDom.hideDisabled) {
    // 清理选中集中的禁用项（隐藏了但还留在选中集会造成状态不一致）
    [...selectedIdxs].forEach(i => {
      if (MaweBoot.DATA.segments[i]?.disabled) {
        selectedIdxs.delete(i);
        const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
        if (el) el.classList.remove('selected');
      }
    });
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    [...selectedExtensionIdxs].forEach((index) => {
      if (extensionTrack?.segments[index]?.disabled) selectedExtensionIdxs.delete(index);
    });
    updateMultiSelectionClasses();
    MaweDom.selCountEl.textContent = String(selectedIdxs.size + selectedExtensionIdxs.size);
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  }
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateDisabledVisibility();
  restoreCueListRenderAnchor(cueListAnchor);
});

// 离开提示
window.addEventListener('beforeunload', (e) => {
  if (MaweServerSave.hasUnsavedProjectChanges()) { e.preventDefault(); e.returnValue = ''; }
});

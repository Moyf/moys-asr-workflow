// 工程加载：规范化应用、检查点、SRT 解析与主轨替换。
// ESM init 模块：initMaweProjectLoad 在原清单位次执行原 IIFE 体（挂
// window.MaweProjectLoad 冻结门面——classic 侧出接口）；底部具名导出经门面
// 在调用时转发，兄弟模块可静态 import。
export function initMaweProjectLoad() {
  // The classic editor.js binding is local to initializeLegacy, not visible to ESM modules.
  const MULTI_SUBTITLE_UTILS = window.AsrEditorUtils;
(function initMaweProjectLoad(global) {
  'use strict';

  // Page-local project changes invalidate export operations waiting on a picker.
  let projectBindingEpoch = 0;



  function updateUnloadedMediaLabel(mediaPath) {
    const mediaName = window.AsrEditorUtils.fileBasename(mediaPath);
    const mediaNameEl = document.getElementById('media-name');
    if (!mediaNameEl) return;
    if (!mediaName) {
      mediaNameEl.textContent = '未导入媒体';
      mediaNameEl.title = '';
      mediaNameEl.classList.add('empty');
      mediaNameEl.onclick = null;
      return;
    }
    mediaNameEl.textContent = `未加载：${mediaName}`;
    mediaNameEl.title = `工程关联媒体：${mediaPath}`;
    mediaNameEl.classList.add('empty');
    mediaNameEl.onclick = () => MaweExportTimeline.copyText(mediaPath, `已复制媒体路径：${mediaPath}`);
  }



  function resetLoadedMedia() {
    if (MaweProjectMediaInputs.currentMediaBlobUrl) URL.revokeObjectURL(MaweProjectMediaInputs.currentMediaBlobUrl);
    MaweProjectMediaInputs.currentMediaBlobUrl = null;
    const oldPlayer = MaweCoreState.player;
    try { oldPlayer?.pause(); } catch (_) {}
    const emptyPlayer = document.createElement('audio');
    emptyPlayer.id = 'player';
    emptyPlayer.preload = 'metadata';
    emptyPlayer.style.cssText = 'width:100%;display:block;';
    oldPlayer?.parentNode?.replaceChild(emptyPlayer, oldPlayer);
    MaweCoreState.player = emptyPlayer;
    MaweMediaPlayback.bindPlayerEvents(MaweCoreState.player);
    MaweNavPreview.seekWarned = false;
    MaweNavPreview.pendingMediaSeekTimeSec = null;
    MaweNavPreview.autoLoadedMediaReadyNotified = false;
    MaweCoreState.waveformEditor?.attachPlayer(MaweCoreState.player);
    MaweMediaPlayback.syncPlayerPlaceholder();
  }



  function buildBlankProject() {
    return {
      schema: window.AsrEditorUtils.PROJECT_TRACKS_SCHEMA,
      media: '', timebase: { unit: 'milliseconds', fps: 30 },
      tracks: [{ id: 'main', role: 'main', name: '主字幕', enabled: true, segments: [] }],
      bilingual: { display_mode: 'both' }, bindings: [],
      subtitle_groups: { next_id: 1, color: [], sticker: [] },
    };
  }


  function suggestedProjectName(file = null) {
    const stem = file?.name?.replace(/\.[^.]+$/i, '').trim();
    return `${stem || 'untitled'}.mosp`;
  }



function applyCanonicalProject(data, filename, { repaired = false, loadGeneration = null,
  requiresMigrationSaveAs = data?.schema !== window.AsrEditorUtils.PROJECT_TRACKS_SCHEMA } = {}) {
  const imported = window.AsrEditorUtils.importProject(data);
  data = imported.project;
  repaired ||= imported.changes.length > 0;
  const timebase = MaweTimeline.normalizeTimelineTimebase(data.timebase);
  if (loadGeneration === null) {
    const generation = MaweState.beginProjectLoad();
    MaweState.finishProjectLoad(generation);
  }
  // Retire the previous file target before installing the new content.
  MaweServerSave.projectFileHandle = null;
  MaweServerSave.requiresMigrationSaveAs = requiresMigrationSaveAs;
  detachServerProjectSaving();
  if (MaweBoot.SERVER_CONFIG) MaweBoot.SERVER_CONFIG.thumbnailBinding = '';
  MaweCoreState.waveformEditor?.setThumbnailBinding('');
  MaweWordTiming.reset();
  // 原地换工程：在途/已排期的延迟波形载荷（含响度标尺）全部作废，见
  // deferredReapeaksEpoch 的说明。
  MaweWaveformInit.deferredReapeaksEpoch += 1;
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState({ discard: true });
  resetLoadedMedia();
  // Retain the project object's identity while replacing its sole track tree.
  for (const key of Object.keys(MaweBoot.DATA)) delete MaweBoot.DATA[key];
  Object.assign(MaweBoot.DATA, data, { timebase });
  window.MaweAudioProcessing?.loadProject(data.audio_processing);
  // A browser-imported project is not the server's native media binding.
  if (MaweBoot.SERVER_CONFIG) MaweBoot.SERVER_CONFIG.autoLoadedMediaPath = null;
  MaweTimeline.timelineFpsManuallySet = MaweTimeline.hasExplicitTimelineFps(data.timebase);
  MaweJsonRepair.setMarkerContainer(data.markers);
  MaweBoot.DATA.markers = window.AsrEditorUtils.normalizeMarkers(data.markers);
  window.MaweMarkerEditing?.enableForProjectMarkers?.(MaweBoot.DATA.markers);
  window.MaweMarkersPanel?.resetSelection?.();
  MaweHistory.gapRemoveDirty = false;
  MaweState.changes.markersDirty = false;
  MaweAppearance.previewGeometryDirty = false;
  MaweServerSave.projectImportDirty = false;
  // 外部载入的工程没有页面持有的文件句柄；新建/另存为会在载入后重新绑定句柄。
  MaweServerSave.projectFileHandle = null;
  MawePreviewGeometry.setPreviewGeometry(MaweAppearance.getPreviewGeometry(), { markDirty: false });
  MaweAppearance.applyExtensionSubtitleAppearance(MaweBoot.DATA.preview?.extension_subtitle);
  MawePreviewGeometry.setStickerGeometry(MawePreviewGeometry.getStickerGeometry(), { markDirty: false });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  MaweBoot.DATA.sticker_root = typeof data.sticker_root === 'string' ? data.sticker_root : '';
  MaweState.beginProjectSession();
  MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: MaweBoot.DATA.timebase.unit === 'frames' });
  // 载入即归一分组区间：旧版本多句绑定曾把 head.sticker 写成首句范围（拖动才
  // 被同步修正），落盘工程重开后预览仍按首句区间显示；打开时就对齐组契约。
  MaweTextCleanup.syncTimelineGroupRanges();
  MaweHistory.editorHistory.clear();
  MaweHistory.updateUndoRedoButtons();
  MaweSelection.clearSelection();
  MawePlaybackLoop.lastActive = -1;
  if (MaweCoreState.waveformEditor) {
    MaweCoreState.waveformEditor.setLayoutData(MaweBoot.DATA.workspace, { render: false });
    MaweDisplaySettings.applyEditorDisplaySettings(MaweBoot.DATA.workspace?.editorDisplay);
    MaweWorkspaces.restoreWorkspaceSelection();
    MaweWorkspaces.syncWorkspaceControls();
    MaweCoreState.waveformLoadedFromProject = MaweCoreState.waveformEditor.setPayload(MaweBoot.DATA.waveform, { render: false });
    MaweCoreState.waveformEditor.setSpectralPayload(MaweBoot.DATA.spectral, { render: false });
    MaweCoreState.waveformEditor.setReapeaksWaveform(MaweBoot.DATA.waveform_reapeaks, { render: false });
    MaweCoreState.waveformEditor.setLoudnessStats(MaweBoot.DATA.loudness, { render: false });
  }
  MaweGapRemoveUi.updateGapRemoveUi();
  MaweCuePanel.renderAll({ waveform: 'full', preserveCueListScroll: false });
  MaweProjectSettings.syncControls();
  MaweStickerRoot.activateProjectRoot();
  MaweState.establishProjectCheckpoint({ repaired });
  MawePlaybackLoop.refreshSubtitlePreview(0, -1);
  updateUnloadedMediaLabel(MaweBoot.DATA.media);
  window.MaweGapRemovedMediaExport?.updateButton();
  MaweBoot.PROJECT_NAME = filename.replace(/\.(json|mosp)$/i, '');
  MaweBoot.FILENAME_BASE = MaweBoot.PROJECT_NAME;
  const jsonEl = document.getElementById('json-name');
  if (jsonEl) {
    jsonEl.textContent = filename;
    jsonEl.title = `点击复制工程文件名：${filename}`;
    jsonEl.classList.remove('empty');
    jsonEl.onclick = () => MaweExportTimeline.copyText(filename, `已复制：${filename}`);
  }
  MaweProjectSave.updateProjectDirtyIndicator();
  MaweServerSave.projectCheckpointed = true;
  MaweServerSave.configureServerSaveControls();
  MaweServerSave.scheduleAutoSave();
}



  // 新建工程：浏览器原生保存对话框选择位置，页面持有句柄持续写回。
  // 不再经过服务器 helper；服务器绑定的旧工程在创建成功后解除保存，避免串写。
  async function createProjectCheckpoint(project, suggestedName) {
    if (MaweServerSave.projectCheckpointInFlight || MaweServerSave.projectSaveInFlight) {
      MaweHint.flashHint('工程正在保存，请稍候再试', 'warning');
      return false;
    }
    const generation = MaweState.beginProjectLoad();
    const current = () => generation === MaweState.projectLoadGeneration;
    MaweServerSave.projectCheckpointInFlight = true;
    try {
      if (!MaweHost.files.hasSavePicker() || !MaweHost.runtime.hasUserActivation()) {
        // 检查点只用于确认后续导入可以继续；无用户手势时不能弹出保存对话框，
        // 直接建立内存工程检查点，后续仍通过显式导出保存。
        applyCanonicalProject(project, suggestedName, { loadGeneration: generation });
        detachServerProjectSaving();
        return true;
      }
      const handle = await MaweHost.files.pickSaveFile({
        suggestedName,
        types: [{ description: 'MOSE 工程文件', accept: { 'application/json': ['.mosp', '.json'] } }],
      });
      if (!current()) return false;
      await MaweHost.files.writeBlob(handle, () => {
        if (!current()) throw new DOMException('工程已切换', 'AbortError');
        return new Blob([JSON.stringify(project, null, 2)], { type: 'application/json;charset=utf-8' });
      });
      if (!current()) return false;
      applyCanonicalProject(project, handle.name, { loadGeneration: generation });
      MaweServerSave.projectFileHandle = handle;
      // detachServerProjectSaving 内部会刷新保存控件并重启自动保存。
      detachServerProjectSaving();
      return true;
    } catch (error) {
      if (!current()) return false;
      if (error && error.name === 'AbortError') return false;  // 用户取消保存对话框
      if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
        try {
          const saved = await MaweExportTimeline.downloadFile(
            JSON.stringify(project, null, 2),
            suggestedName,
            'application/json',
            { desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] } },
            { usePicker: false },
          );
          if (saved && current()) {
            applyCanonicalProject(project, suggestedName, { loadGeneration: generation });
            detachServerProjectSaving();
            return true;
          }
        } catch (fallbackError) {
          MaweHint.flashHint(`创建工程失败：${fallbackError.message || fallbackError}`, 'warning');
          return false;
        }
      }
      MaweHint.flashHint(`创建工程失败：${error.message || error}`, 'warning');
      return false;
    } finally {
      MaweState.finishProjectLoad(generation);
      MaweServerSave.projectCheckpointInFlight = false;
      if (current()) {
        MaweServerSave.configureServerSaveControls();
        MaweServerSave.scheduleAutoSave();
      }
    }
  }



  // 浏览器自行管理的工程（句柄或下载创建）不能再写回服务器绑定的旧工程文件，
  // 便携表情包 OTIO 也随之退回引用原始素材（服务器已不跟踪当前工程）。
  function detachServerProjectSaving() {
    projectBindingEpoch += 1;
    if (MaweBoot.SERVER_CONFIG) MaweBoot.SERVER_CONFIG.thumbnailBinding = '';
    MaweCoreState.waveformEditor?.setThumbnailBinding('');
    if (MaweBoot.SERVER_CONFIG) {
      MaweBoot.SERVER_CONFIG.canSave = false;
      MaweBoot.SERVER_CONFIG.canPortableStickerExport = false;
      MaweBoot.SERVER_CONFIG.canLottieExport = false;
      MaweBoot.SERVER_CONFIG.canOgrafExport = false;
      MaweBoot.SERVER_CONFIG.canGapRemovedMediaExport = false;
      MaweBoot.SERVER_CONFIG.gapRemovedMediaKind = null;
      MaweBoot.SERVER_CONFIG.gapRemovedMediaAudioTrack = null;
      MaweBoot.SERVER_CONFIG.gapRemovedMediaSourceName = null;
      MaweBoot.SERVER_CONFIG.gapRemovedMediaOutputExtension = null;
      MaweBoot.SERVER_CONFIG.gapRemovedMediaOutputMime = null;
      MaweBoot.SERVER_CONFIG.canGapRemovedVideoExport = false;
      MaweBoot.SERVER_CONFIG.gapRemovedVideoSourceName = null;
      MaweBoot.SERVER_CONFIG.sourceMediaId = null;
    }
    window.MaweBurnVideoExport?.invalidateBinding();
    window.MaweGapRemovedMediaExport?.updateButton();
    MaweServerSave.configureServerSaveControls();
    MaweDynamicExports.updateLottieExportButton();
    MaweDynamicExports.updateOgrafExportButton();
    MaweServerSave.scheduleAutoSave();
  }



  async function ensureProjectCheckpointForImport(file, { usePicker = true } = {}) {
    if (MaweServerSave.projectCheckpointed) return true;
    if (usePicker && MaweHost.files.hasSavePicker()) {
      return createProjectCheckpoint(buildBlankProject(), suggestedProjectName(file));
    }
    // Drag/drop imports are asynchronous by the time they reach here; do not
    // open a save picker as part of importing a subtitle.
    applyCanonicalProject(buildBlankProject(), suggestedProjectName(file));
    detachServerProjectSaving();
    return true;
  }



  function isMawProject(data) {
    try { window.AsrEditorUtils.importProject(data); return true; }
    catch { return false; }
  }

  function parseSrtTimestamp(value) {
    const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const milliseconds = Number(match[4].padEnd(3, '0'));
    if (minutes >= 60 || seconds >= 60) return null;
    return (((hours * 60 + minutes) * 60) + seconds) * 1000 + milliseconds;
  }



  function parseSrtSegments(text) {
  // 与后端 maw/postprocess_io.read_srt 同一套分层规则：cue 依次尝试主轨、
  // 叠加轨，两轨都放不下（第三层并发）才报错；返回的主层数组附带
  // overlaySegments（非枚举属性），供导入路径把第二层落到叠加轨。
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  const segments = [];
  const overlaySegments = [];
  let previousStart = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]?.trim() || '')) lines.shift();
    const timing = /^\s*(.+?)\s*-->\s*(.+?)(?:\s+.*)?$/.exec(lines.shift() || '');
    if (!timing) throw new Error('缺少有效时间码');
    const start = parseSrtTimestamp(timing[1]);
    const end = parseSrtTimestamp(timing[2]);
    const cueText = lines.join('\n').trim();
    if (start === null || end === null || end <= start || !cueText) throw new Error('包含无效字幕段');
    if (start < previousStart) throw new Error('字幕时间码未按时间顺序排列');
    previousStart = start;
    const fitsTrack = (list) => list.every((segment) => end <= segment.start || start >= segment.end);
    const cue = { start, end, text: cueText };
    if (fitsTrack(segments)) {
      segments.push(cue);
    } else if (fitsTrack(overlaySegments)) {
      overlaySegments.push(cue);
    } else {
      throw new Error('同一时间已存在主轨与叠加轨字幕，第三层重叠无法导入');
    }
  }
  if (!segments.length) throw new Error('没有可导入的字幕');
  Object.defineProperty(segments, 'overlaySegments', { value: overlaySegments });
  return segments;
}



  function replaceMainTrack(segments, displayName = '字幕', { overlaySegments = null } = {}) {
  // 导入/替换主轨是字幕编辑操作，保留替换前的主轨和多字幕状态，
  // 这样用户可以用 Ctrl(Cmd)+Z 回到替换前，而不影响后续重做。
  // 先提交当前编辑区，再替换 DATA；否则 clearSelection() 在替换后提交旧面板
  // 文本时，会把旧字幕写回新导入的同一下标，表现为“导入后又变回旧值”。
  MaweCuePanel.commitCuePanelEdit();
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState();
  return MaweCommands.run('替换字幕', (command) => {
    window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length = 0;
    (segments || []).forEach((segment) => window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.push({ ...segment }));
    // 替换语义同时接管叠加轨：导入双层 SRT 时第二层落到叠加轨；
    // 导入普通 SRT（未提供 overlaySegments）时清空旧叠加轨，避免残留混入新工程。
    const overlayLayer = Array.isArray(overlaySegments) ? overlaySegments : [];
    const overlay = window.AsrEditorUtils.ensureOverlayTrack(MaweBoot.DATA);
    overlay.segments = overlayLayer.map(segment => ({ ...segment }));
    overlay.enabled = overlayLayer.length > 0;
    overlay._dirty = true;
    MaweBoot.DATA.tracks = MaweBoot.DATA.tracks.filter(track => track.role !== 'secondary');
    MaweBoot.DATA.bindings = [];
    MaweBoot.DATA.bilingual = { display_mode: 'both' };
    MaweBoot.DATA.subtitle_groups = { next_id: 1, color: [], sticker: [] };
    const cues = [...window.AsrEditorUtils.iterSegments(MaweBoot.DATA)];
    const used = new Set();
    for (const track of MaweBoot.DATA.tracks) for (const [index, cue] of track.segments.entries()) {
      if (!cue.id || used.has(cue.id)) cue.id = window.AsrEditorUtils.uniqueStableSegmentId(cues, `${track.id}-${index + 1}`, track.id);
      used.add(cue.id);
    }
    MaweBoot.DATA.gap_remove = null;
    MaweHistory.gapRemoveDirty = false;
    MaweState.changes.markersDirty = false;
    MaweServerSave.projectImportDirty = true;
    MaweHistory.updateUndoRedoButtons();
    MaweSelection.clearSelection({ commitCuePanel: false });
    MawePlaybackLoop.lastActive = -1;
    MaweGapRemoveUi.updateGapRemoveUi();
    command.commit({ cueList: true, preserveCueListScroll: false });
    MaweBoot.FILENAME_BASE = displayName.replace(/\.[^.]+$/i, '');
    const jsonEl = document.getElementById('json-name');
    if (jsonEl) {
      jsonEl.textContent = `导入字幕：${displayName}`;
      jsonEl.title = '导入的字幕只能通过导出下载保存为工程文件';
      jsonEl.classList.add('empty');
    }
    MaweServerSave.configureServerSaveControls();
    MaweServerSave.scheduleAutoSave();
    MaweHint.flashHint(`已导入字幕：${displayName}（${window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length} 条）`, 'success');
    return true;
  });
}

  // 注：boot 修复语句（repairGroupReferenceIndices / normalizeProjectTimings 两条
  // 顶层 const）原本位于 editor.js 两次 syncProjectTimebaseAndBindingOffsets 之间，
  // 必须留在 editor.js 原位执行，不随本模块迁移。

  global.MaweProjectLoad = Object.freeze({
    get projectBindingEpoch() { return projectBindingEpoch; },
    updateUnloadedMediaLabel,
    resetLoadedMedia,
    buildBlankProject,
    suggestedProjectName,
    applyCanonicalProject,
    createProjectCheckpoint,
    detachServerProjectSaving,
    ensureProjectCheckpointForImport,
    isMawProject,
    parseSrtTimestamp,
    parseSrtSegments,
    replaceMainTrack
  });
})(typeof window !== 'undefined' ? window : globalThis);
}

export function replaceMainTrack(...args) { return window.MaweProjectLoad.replaceMainTrack(...args); }
export function parseSrtSegments(...args) { return window.MaweProjectLoad.parseSrtSegments(...args); }
export function ensureProjectCheckpointForImport(...args) { return window.MaweProjectLoad.ensureProjectCheckpointForImport(...args); }
export function detachServerProjectSaving(...args) { return window.MaweProjectLoad.detachServerProjectSaving(...args); }
export function suggestedProjectName(...args) { return window.MaweProjectLoad.suggestedProjectName(...args); }
export function isMawProject(...args) { return window.MaweProjectLoad.isMawProject(...args); }
export function createProjectCheckpoint(...args) { return window.MaweProjectLoad.createProjectCheckpoint(...args); }

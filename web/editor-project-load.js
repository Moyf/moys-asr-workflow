// 工程加载：规范化应用、检查点、SRT 解析与主轨替换。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweProjectLoad 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweProjectLoad(global) {
  'use strict';



  function updateUnloadedMediaLabel(mediaPath) {
    const mediaName = window.AsrEditorUtils.fileBasename(mediaPath);
    const mediaNameEl = document.getElementById('media-name');
    if (!mediaNameEl) return;
    if (!mediaName) {
      mediaNameEl.textContent = '未加载媒体';
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
    seekWarned = false;
    pendingMediaSeekTimeSec = null;
    autoLoadedMediaReadyNotified = false;
    MaweCoreState.waveformEditor?.attachPlayer(MaweCoreState.player);
    MaweMediaPlayback.syncPlayerPlaceholder();
  }



  function buildBlankProject() {
    return {
      schema: window.AsrEditorUtils.PROJECT_SCHEMA,
      media: '', language: '', model: '',
      timebase: { unit: 'milliseconds', fps: 30 },
      segments: [],
    };
  }



  function suggestedProjectName(file = null) {
    const stem = file?.name?.replace(/\.[^.]+$/i, '').trim();
    return `${stem || 'untitled'}.mosp`;
  }



  function applyCanonicalProject(data, filename) {
    MaweCuePanelState.currentCuePanelIdx = -1;
    MaweCuePanelState.currentCuePanelKind = 'main';
    MaweCuePanelState.currentCuePanelTrackId = null;
    MaweCuePanelState.resetCuePanelEditState();
    resetLoadedMedia();
    projectExtensionFields = Object.fromEntries(
      Object.entries(data).filter(([key]) => !CANONICAL_PROJECT_FIELDS.has(key)),
    );
    MaweBoot.DATA.schema = window.AsrEditorUtils.PROJECT_SCHEMA;
    MaweBoot.DATA.media = typeof data.media === 'string' ? data.media : '';
    MaweBoot.DATA.language = data.language || '';
    MaweBoot.DATA.language_source = typeof data.language_source === 'string' ? data.language_source : undefined;
    MaweBoot.DATA.split_mode = typeof data.split_mode === 'string' ? data.split_mode : undefined;
    MaweBoot.DATA.timestamp_granularity = typeof data.timestamp_granularity === 'string'
      ? data.timestamp_granularity : undefined;
    MaweBoot.DATA.model = data.model || '';
    MaweBoot.DATA.timebase = normalizeTimelineTimebase(data.timebase);
    timelineFpsManuallySet = hasExplicitTimelineFps(data.timebase);
    MaweBoot.DATA.media_metadata = normalizeMediaMetadata(data.media_metadata);
    MaweBoot.DATA.media_time_reference = data.media_time_reference || null;
    MaweBoot.DATA.waveform = data.waveform || null;
    MaweBoot.DATA.spectral = data.spectral || null;
    MaweBoot.DATA.waveform_reapeaks = data.waveform_reapeaks || null;
    MaweBoot.DATA.workspace = data.workspace || null;
    MaweBoot.DATA.gap_remove = data.gap_remove || null;
    MaweBoot.DATA.script_alignment = data.script_alignment || null;
    MaweBoot.DATA.preview = (data.preview && typeof data.preview === 'object') ? data.preview : null;
    MaweHistory.gapRemoveDirty = false;
    MaweAppearance.previewGeometryDirty = false;
    MaweServerSave.projectImportDirty = false;
    // 外部载入的工程没有页面持有的文件句柄；新建/另存为会在载入后重新绑定句柄。
    MaweServerSave.projectFileHandle = null;
    MawePreviewGeometry.setPreviewGeometry(MaweAppearance.getPreviewGeometry(), { markDirty: false });
    MaweAppearance.applyExtensionSubtitleAppearance(MaweBoot.DATA.preview?.extension_subtitle);
    MawePreviewGeometry.setStickerGeometry(MawePreviewGeometry.getStickerGeometry(), { markDirty: false });
    MawePreviewGeometry.refreshPreviewGeometryEditable();
    if (data.sticker_root) MaweBoot.STICKER_ROOT = data.sticker_root;
    MaweBoot.DATA.segments.length = 0;
    data.segments.forEach((segment) => MaweBoot.DATA.segments.push(segment));
    MaweBoot.DATA.multi_subtitle = window.AsrEditorUtils.normalizeMultiSubtitle(data.multi_subtitle, MaweBoot.DATA.segments);
    syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: MaweBoot.DATA.timebase.unit === 'frames' });
    MaweHistory.editorHistory.clear();
    MaweHistory.updateUndoRedoButtons();
    clearSelection();
    MawePlaybackLoop.lastActive = -1;
    if (MaweCoreState.waveformEditor) {
      MaweCoreState.waveformEditor.setLayoutData(MaweBoot.DATA.workspace, { render: false });
      MaweDisplaySettings.applyEditorDisplaySettings(MaweBoot.DATA.workspace?.editorDisplay);
      MaweWorkspaces.restoreWorkspaceSelection();
      MaweWorkspaces.syncWorkspaceControls();
      MaweCoreState.waveformLoadedFromProject = MaweCoreState.waveformEditor.setPayload(MaweBoot.DATA.waveform, { render: false });
      MaweCoreState.waveformEditor.setSpectralPayload(MaweBoot.DATA.spectral, { render: false });
      MaweCoreState.waveformEditor.setReapeaksWaveform(MaweBoot.DATA.waveform_reapeaks, { render: false });
    }
    updateGapRemoveUi();
    renderAll({ waveform: 'full', preserveCueListScroll: false });
    MawePlaybackLoop.refreshSubtitlePreview(0, -1);
    updateUnloadedMediaLabel(MaweBoot.DATA.media);
    MaweBoot.FILENAME_BASE = filename.replace(/\.(json|mosp)$/i, '');
    const jsonEl = document.getElementById('json-name');
    if (jsonEl) {
      jsonEl.textContent = filename;
      jsonEl.title = `点击复制工程文件名：${filename}`;
      jsonEl.classList.remove('empty');
      jsonEl.onclick = () => MaweExportTimeline.copyText(filename, `已复制：${filename}`);
    }
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
    MaweServerSave.projectCheckpointInFlight = true;
    try {
      if (!window.showSaveFilePicker || !navigator.userActivation?.isActive) {
        // 检查点只用于确认后续导入可以继续；无用户手势时不能弹出保存对话框，
        // 直接建立内存工程检查点，后续仍通过显式导出保存。
        applyCanonicalProject(project, suggestedName);
        detachServerProjectSaving();
        return true;
      }
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'MOSE 工程文件', accept: { 'application/json': ['.mosp', '.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json;charset=utf-8' }));
      await writable.close();
      applyCanonicalProject(project, handle.name);
      MaweServerSave.projectFileHandle = handle;
      // detachServerProjectSaving 内部会刷新保存控件并重启自动保存。
      detachServerProjectSaving();
      return true;
    } catch (error) {
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
          if (saved) {
            applyCanonicalProject(project, suggestedName);
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
      MaweServerSave.projectCheckpointInFlight = false;
    }
  }



  // 浏览器自行管理的工程（句柄或下载创建）不能再写回服务器绑定的旧工程文件，
  // 便携表情包 OTIO 也随之退回引用原始素材（服务器已不跟踪当前工程）。
  function detachServerProjectSaving() {
    if (MaweBoot.SERVER_CONFIG) {
      MaweBoot.SERVER_CONFIG.canSave = false;
      MaweBoot.SERVER_CONFIG.canPortableStickerExport = false;
      MaweBoot.SERVER_CONFIG.canLottieExport = false;
      MaweBoot.SERVER_CONFIG.canOgrafExport = false;
    }
    MaweServerSave.configureServerSaveControls();
    MaweDynamicExports.updateLottieExportButton();
    MaweDynamicExports.updateOgrafExportButton();
    MaweServerSave.scheduleAutoSave();
  }



  async function ensureProjectCheckpointForImport(file, { usePicker = true } = {}) {
    if (MaweServerSave.projectCheckpointed) return true;
    if (usePicker && window.showSaveFilePicker) {
      return createProjectCheckpoint(buildBlankProject(), suggestedProjectName(file));
    }
    // Drag/drop imports are asynchronous by the time they reach here; do not
    // open a save picker as part of importing a subtitle.
    applyCanonicalProject(buildBlankProject(), suggestedProjectName(file));
    detachServerProjectSaving();
    return true;
  }



  function isMawProject(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.segments)) return false;
    if (data.media_metadata !== undefined && data.media_metadata !== null
        && !normalizeMediaMetadata(data.media_metadata)) return false;
    if (data.timebase !== undefined) {
      const timebase = data.timebase;
      if (!timebase || typeof timebase !== 'object' || Array.isArray(timebase)
          || (timebase.unit !== 'milliseconds' && timebase.unit !== 'frames')
          || typeof timebase.fps !== 'number' || !Number.isFinite(timebase.fps)
          || timebase.fps < MIN_TIMELINE_FPS || timebase.fps > MAX_TIMELINE_FPS) return false;
    }
    const hasOptionalFramePair = (value) => {
      const hasStart = Object.prototype.hasOwnProperty.call(value || {}, 'start_frame');
      const hasEnd = Object.prototype.hasOwnProperty.call(value || {}, 'end_frame');
      return (!hasStart && !hasEnd) || hasValidFramePair(value);
    };
    let previousEnd = 0;
    return data.segments.every((segment) => {
      if (!segment || typeof segment !== 'object'
          || !Number.isInteger(segment.start) || !Number.isInteger(segment.end)
          || segment.start < 0 || segment.end <= segment.start || segment.start < previousEnd
          || typeof segment.text !== 'string' || !hasOptionalFramePair(segment)) return false;
      previousEnd = segment.end;
      if (!Array.isArray(segment.items)) return segment.items === undefined;
      let itemEnd = segment.start;
      return segment.items.every((item) => {
        if (!item || typeof item !== 'object'
            || !Number.isInteger(item.start) || !Number.isInteger(item.end)
            || item.start < segment.start || item.end > segment.end || item.end <= item.start
            || item.start < itemEnd || typeof item.text !== 'string'
            || !hasOptionalFramePair(item)) return false;
        itemEnd = item.end;
        return true;
      });
    });
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
    const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
    const segments = [];
    for (const block of blocks) {
      const lines = block.split('\n');
      if (/^\d+$/.test(lines[0]?.trim() || '')) lines.shift();
      const timing = /^\s*(.+?)\s*-->\s*(.+?)(?:\s+.*)?$/.exec(lines.shift() || '');
      if (!timing) throw new Error('缺少有效时间码');
      const start = parseSrtTimestamp(timing[1]);
      const end = parseSrtTimestamp(timing[2]);
      const cueText = lines.join('\n').trim();
      if (start === null || end === null || end <= start || !cueText) throw new Error('包含无效字幕段');
      const previous = segments[segments.length - 1];
      if (previous && start < previous.end) throw new Error('字幕时间重叠');
      segments.push({ start, end, text: cueText });
    }
    if (!segments.length) throw new Error('没有可导入的字幕');
    return segments;
  }



  function replaceMainTrack(segments, displayName = '字幕') {
    // 导入/替换主轨是字幕编辑操作，保留替换前的主轨和多字幕状态，
    // 这样用户可以用 Ctrl(Cmd)+Z 回到替换前，而不影响后续重做。
    // 先提交当前编辑区，再替换 DATA；否则 clearSelection() 在替换后提交旧面板
    // 文本时，会把旧字幕写回新导入的同一下标，表现为“导入后又变回旧值”。
    commitCuePanelEdit();
    MaweCuePanelState.currentCuePanelIdx = -1;
    MaweCuePanelState.currentCuePanelKind = 'main';
    MaweCuePanelState.currentCuePanelTrackId = null;
    MaweCuePanelState.resetCuePanelEditState();
    MaweHistory.pushUndo('替换字幕');
    MaweBoot.DATA.segments.length = 0;
    (segments || []).forEach((segment) => MaweBoot.DATA.segments.push({ ...segment }));
    MaweBoot.DATA.multi_subtitle = {
      schema: window.AsrEditorUtils.MULTI_SUBTITLE_SCHEMA,
      enabled: false,
      display_mode: 'both',
      tracks: [],
      bindings: [],
    };
    window.AsrEditorUtils.normalizeMultiSubtitleProject(MaweBoot.DATA);
    MaweBoot.DATA.gap_remove = null;
    MaweHistory.gapRemoveDirty = false;
    MaweServerSave.projectImportDirty = true;
    MaweHistory.updateUndoRedoButtons();
    clearSelection({ commitCuePanel: false });
    MawePlaybackLoop.lastActive = -1;
    updateGapRemoveUi();
    renderAll({ preserveCueListScroll: false });
    MaweBoot.FILENAME_BASE = displayName.replace(/\.[^.]+$/i, '');
    const jsonEl = document.getElementById('json-name');
    if (jsonEl) {
      jsonEl.textContent = `导入字幕：${displayName}`;
      jsonEl.title = 'SRT 字幕只能通过导出下载保存为工程文件';
      jsonEl.classList.add('empty');
    }
    MaweServerSave.configureServerSaveControls();
    MaweServerSave.scheduleAutoSave();
    MaweHint.flashHint(`已加载字幕：${displayName}（${MaweBoot.DATA.segments.length} 条）`, 'success');
    return true;
  }

  // 注：boot 修复语句（repairGroupReferenceIndices / normalizeProjectTimings 两条
  // 顶层 const）原本位于 editor.js 两次 syncProjectTimebaseAndBindingOffsets 之间，
  // 必须留在 editor.js 原位执行，不随本模块迁移。

  global.MaweProjectLoad = Object.freeze({
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

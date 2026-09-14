// 多重字幕导入：导入选择弹窗、预览渲染与主副轨交换。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweMultiImport 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweMultiImport(global) {
  'use strict';



  let pendingMultiImport = null;



  function closeMultiSubtitleImportModal() {
    MaweDom.multiSubtitleImportModal?.classList.remove('show');
    pendingMultiImport = null;
    if (MaweDom.multiSubtitleImportChoiceActions) MaweDom.multiSubtitleImportChoiceActions.hidden = false;
    if (MaweDom.multiSubtitleImportResultActions) MaweDom.multiSubtitleImportResultActions.hidden = false;
    if (MaweDom.multiSubtitleImportResultConfirm) MaweDom.multiSubtitleImportResultConfirm.disabled = true;
    [MaweDom.multiSubtitleImportReplace, MaweDom.multiSubtitleImportExtension].forEach((button) => {
      button?.setAttribute('aria-pressed', 'false');
    });
  }



  function renderMultiImportPreview(match = null, segments = []) {
    if (!MaweDom.multiSubtitleImportPreview) return;
    if (!match) {
      MaweDom.multiSubtitleImportPreview.hidden = true;
      MaweDom.multiSubtitleImportPreview.innerHTML = `<div class="summary">共 ${segments.length} 条待导入字幕</div>`;
      return;
    }
    MaweDom.multiSubtitleImportPreview.hidden = false;
    MaweDom.multiSubtitleImportPreview.innerHTML = [
      `<div class="summary">副字幕 ${segments.length} 条 · 自动绑定 ${match.matches.length} 条</div>`,
      `<div>未绑定 ${match.unmatchedExtension.length} 条 · 主轨未绑定 ${match.unmatchedMain.length} 条 · 冲突 ${match.conflicts} 组</div>`,
      `<div class="warning">时间容差：${match.tolerance_ms}ms。未绑定字幕会保留，可稍后手动绑定。</div>`,
    ].join('');
  }



  function renderMainImportPreview(pending) {
    if (!MaweDom.multiSubtitleImportPreview) return;
    MaweDom.multiSubtitleImportPreview.hidden = false;
    MaweDom.multiSubtitleImportPreview.innerHTML = [
      `<div class="summary">将替换当前主字幕</div>`,
      `<div>${MaweCueElements.escapeHtml(pending.file.name)} · ${pending.segments.length} 条字幕</div>`,
      '<div>导入后仍可使用撤销恢复当前字幕。</div>',
    ].join('');
  }



  function renderProjectImportPreview(pending) {
    if (!MaweDom.multiSubtitleImportPreview) return;
    const itemCount = pending.segments.reduce((count, segment) => (
      count + (Array.isArray(segment.items) ? segment.items.length : 0)
    ), 0);
    MaweDom.multiSubtitleImportPreview.hidden = false;
    MaweDom.multiSubtitleImportPreview.innerHTML = [
      `<div class="summary">工程字幕 ${pending.segments.length} 条${itemCount ? ` · 字词时间码 ${itemCount} 项` : ''}</div>`,
      `<div>${MaweCueElements.escapeHtml(pending.file.name)}</div>`,
      '<div>打开工程会替换当前工程；使用工程字幕作为副字幕只导入字幕和可选字词时间码。</div>',
    ].join('');
  }



  async function showMultiSubtitleImportChoice(file, segments, options = {}) {
    const existingTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const projectFile = options.projectFile || null;
    const projectImport = Boolean(projectFile);
    pendingMultiImport = {
      file,
      segments,
      existingTrackId: existingTrack?.id || null,
      match: null,
      choice: null,
      projectFile,
      projectMediaFile: options.projectMediaFile || null,
      projectImport,
    };
    if (MaweDom.multiSubtitleImportDescription) MaweDom.multiSubtitleImportDescription.textContent = '请选择你要执行的行为：';
    if (MaweDom.multiSubtitleImportReplace) {
      MaweDom.multiSubtitleImportReplace.textContent = projectImport
        ? '打开工程' : (existingTrack ? '替换副轨' : '替换当前字幕');
    }
    if (MaweDom.multiSubtitleImportExtension) {
      MaweDom.multiSubtitleImportExtension.hidden = projectImport ? false : Boolean(existingTrack);
      MaweDom.multiSubtitleImportExtension.textContent = projectImport
        ? '使用工程字幕作为副字幕' : '作为多重字幕';
    }
    if (MaweDom.multiSubtitleImportChoiceActions) MaweDom.multiSubtitleImportChoiceActions.hidden = false;
    if (MaweDom.multiSubtitleImportResultActions) MaweDom.multiSubtitleImportResultActions.hidden = false;
    if (MaweDom.multiSubtitleImportResultConfirm) MaweDom.multiSubtitleImportResultConfirm.disabled = true;
    [MaweDom.multiSubtitleImportReplace, MaweDom.multiSubtitleImportExtension].forEach((button) => {
      button?.setAttribute('aria-pressed', 'false');
    });
    if (projectImport) renderProjectImportPreview(pendingMultiImport);
    else renderMultiImportPreview(null, segments);
    MaweDom.multiSubtitleImportModal?.classList.add('show');
    // 工程文件必须明确选择“打开”或“作为副字幕”；SRT 保持原有默认导入路径。
    if (!projectImport) prepareMultiSubtitleImport();
    (projectImport ? MaweDom.multiSubtitleImportReplace
      : (existingTrack ? MaweDom.multiSubtitleImportReplace : MaweDom.multiSubtitleImportExtension))?.focus();
  }



  function prepareMultiSubtitleImport() {
    const pending = pendingMultiImport;
    if (!pending) return;
    pending.choice = pending.existingTrackId ? 'replace-extension' : 'extension';
    const match = window.AsrEditorUtils.matchSubtitleSegments(
      MaweBoot.DATA.segments,
      pending.segments,
      MaweMultiSubtitleCore.MULTI_SUBTITLE_TOLERANCE_MS,
    );
    pending.match = match;
    renderMultiImportPreview(match, pending.segments);
    if (MaweDom.multiSubtitleImportReplace) {
      MaweDom.multiSubtitleImportReplace.setAttribute('aria-pressed', pending.choice === 'replace-extension' ? 'true' : 'false');
    }
    if (MaweDom.multiSubtitleImportExtension) {
      MaweDom.multiSubtitleImportExtension.setAttribute('aria-pressed', pending.choice === 'extension' ? 'true' : 'false');
    }
    if (MaweDom.multiSubtitleImportResultConfirm) MaweDom.multiSubtitleImportResultConfirm.disabled = false;
  }



  function commitMultiSubtitleImport() {
    const pending = pendingMultiImport;
    if (!pending) return false;
    const match = pending.match || window.AsrEditorUtils.matchSubtitleSegments(
      MaweBoot.DATA.segments, pending.segments, MaweMultiSubtitleCore.MULTI_SUBTITLE_TOLERANCE_MS,
    );
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    const replacing = Boolean(pending.existingTrackId);
    const oldTrack = replacing ? MaweMultiSubtitleCore.getExtensionTrack(pending.existingTrackId) : null;
    const trackId = oldTrack?.id || window.AsrEditorUtils.uniqueStableSegmentId(
      multi.tracks || [], 'extension-1', 'extension',
    );
    const extensionSegments = pending.segments.map((segment, index) => ({
      ...segment,
      id: window.AsrEditorUtils.uniqueStableSegmentId(
        pending.segments.slice(0, index), `${trackId}-segment-${String(index + 1).padStart(3, '0')}`, `${trackId}-segment`,
      ),
      _dirty: true,
    }));
    const track = {
      id: trackId,
      role: 'extension',
      name: pending.file.name.replace(/\.[^.]+$/i, '') || '副字幕',
      language: '',
      source_name: pending.file.name,
      split_mode: window.AsrEditorUtils.detectSubtitleSplitMode(
        extensionSegments.map((segment) => segment.text).join('\n'),
      ),
      segments: extensionSegments,
    };
    MaweHistory.pushUndo(replacing ? '替换副字幕' : '导入多重字幕');
    if (replacing) {
      const oldIds = new Set(oldTrack?.segments?.map((segment) => segment.id) || []);
      multi.bindings = (multi.bindings || []).filter((binding) => (
        binding.track_id !== trackId && !binding.extension_segment_ids?.some((id) => oldIds.has(id))
      ));
      const oldIndex = multi.tracks.findIndex((candidate) => candidate.id === trackId);
      if (oldIndex >= 0) multi.tracks.splice(oldIndex, 1, track);
      else multi.tracks.push(track);
    } else {
      multi.tracks = [track, ...(multi.tracks || []).filter((candidate) => candidate.id !== trackId)];
    }
    match.matches.forEach((candidate) => {
      const main = MaweBoot.DATA.segments[candidate.mainIndex];
      const extension = extensionSegments[candidate.extensionIndex];
      if (main && extension) multi.bindings.push(
        window.AsrEditorUtils.buildSubtitleBinding(main, extension, trackId),
      );
    });
    multi.enabled = true;
    multi.display_mode = multi.display_mode || 'both';
    MaweMultiSubtitleCore.markMainSegmentsDirty(MaweBoot.DATA.segments.filter((_, index) => match.matches.some((candidate) => candidate.mainIndex === index)));
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    closeMultiSubtitleImportModal();
    MaweSelection.clearSelection();
    // 导入可能首次创建副字幕 lane，必须重建波形行结构。
    MaweCuePanel.renderAll({ waveform: 'full' });
    MawePlaybackLoop.updateWithoutCueListAutoScroll();
    MaweHint.flashHint(`已导入副字幕：绑定 ${match.matches.length} 条，未绑定 ${match.unmatchedExtension.length} 条`, 'success');
    return true;
  }



  function swapMainAndExtensionSubtitles() {
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    if (!multi.enabled) {
      MaweHint.flashHint('请先开启多重字幕', 'invalid');
      return false;
    }
    if ((multi.tracks || []).length !== 1) {
      MaweHint.flashHint('当前只支持交换唯一的副字幕轨', 'invalid');
      return false;
    }
    if (!track?.segments?.length || !MaweBoot.DATA.segments.length) {
      MaweHint.flashHint('主字幕和副字幕都不能为空', 'invalid');
      return false;
    }
    MaweHistory.pushUndo('交换主副字幕');
    const result = window.AsrEditorUtils.swapMainAndExtensionSubtitle(MaweBoot.DATA, track.id);
    if (!result.swapped) {
      MaweHint.flashHint('交换主副字幕失败', 'warning');
      return false;
    }
    MaweMultiSubtitleCore.markMainSegmentsDirty(MaweBoot.DATA.segments);
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweSelection.clearSelection();
    MaweCuePanel.renderAll({ waveform: 'full' });
    MawePlaybackLoop.updateWithoutCueListAutoScroll();
    MaweHint.flashHint(`已交换主副字幕：主轨 ${result.mainCount} 条，副轨 ${result.extensionCount} 条`, 'success');
    return true;
  }



  async function openSrtFile(file) {
    const finishLoading = MaweLoadingProgress.beginEditorLoading(`正在读取字幕 ${file.name}…`, 5);
    try {
      const segments = MaweProjectLoad.parseSrtSegments(await MaweLoadingProgress.readFileTextWithProgress(file));
      MaweLoadingProgress.updateEditorLoading(75, `正在载入字幕 ${file.name}…`);
      if (!await MaweProjectLoad.ensureProjectCheckpointForImport(file)) return false;
      const imported = MaweProjectLoad.replaceMainTrack(segments, file.name);
      if (imported && MaweServerSave.projectSaveTargetEnabled()) await MaweProjectSave.saveCurrentProject({ silent: true });
      return imported;
    } catch (error) {
      MaweHint.flashHint(`加载字幕失败：${error.message || error}`, 'warning');
      return false;
    } finally {
      finishLoading();
    }
  }



  async function openProjectFile(file, options = {}) {
    const suppressMediaPrompt = options.suppressMediaPrompt === true;
    const finishLoading = MaweLoadingProgress.beginEditorLoading(`正在读取工程 ${file.name}…`, 5);
    try {
      const text = await MaweLoadingProgress.readFileTextWithProgress(file);
      MaweLoadingProgress.updateEditorLoading(60, `正在解析工程 ${file.name}…`);
      const data = JSON.parse(text);
      if (data && typeof data === 'object' && !Array.isArray(data)
          && Object.prototype.hasOwnProperty.call(data, 'schema')
          && !window.AsrEditorUtils.supportsProjectSchema(data)) {
        MaweHint.flashHint('不支持的工程格式版本，请使用新版 MAW 打开。', 'warning');
        return false;
      }
      // 先兜底修复 0 长/倒挂时间码（保底 100ms），再校验结构，让旧工程仍能打开。
      if (data && Array.isArray(data.segments)) {
        data.timebase = MaweTimeline.normalizeTimelineTimebase(data.timebase);
        window.AsrEditorUtils.normalizeMultiSubtitleProject(data);
        MaweTimeline.syncProjectTimebaseAndBindingOffsets(data, { preferFrames: data.timebase.unit === 'frames' });
        window.AsrEditorUtils.normalizeSegmentTimings(data.segments);
        window.AsrEditorUtils.repairGroupReferenceIndices(data.segments);
        MaweJsonRepair.normalizeProjectTimings(data);
        MaweTimeline.syncProjectTimebaseAndBindingOffsets(data, { preferFrames: false });
      }
      if (!MaweProjectLoad.isMawProject(data)) {
        MaweHint.flashHint('打开了错误的文件，请使用 MAW 生成的工程文件。', 'warning');
        return false;
      }
MaweProjectLoad.applyCanonicalProject(data, file.name);
// 工程可能携带新 sticker_root；刷新表情包导出按钮的互斥灰显状态
MaweExportTimeline.updateStickerExportButtons();
const expectedName = window.AsrEditorUtils.fileBasename(MaweBoot.DATA.media);
      // 服务器版：浏览器拿不到工程真实路径，但工程记录的媒体是绝对路径。
      // 先让服务器按它定位同目录同名工程并接管（自动加载媒体、允许 Ctrl(Cmd)+S 保存）；
      // 接管失败（媒体已移动 / 同名工程缺失 / 内容不一致）再回退为手动选择媒体。
      if (expectedName && MaweBoot.SERVER_CONFIG?.attachUrl) {
        MaweLoadingProgress.updateEditorLoading(85, '正在连接本地编辑器服务器…');
        if (await MaweServerSave.attachProjectToServer(file.name, data)) return true;
      }
      // 工程未被服务器接管（无媒体可定位 / 接管失败）：服务器仍绑定旧工程，
      // 当前内容不能再写回它；后续保存退化为「导出工程」，直到重新经服务器打开。
      if (MaweBoot.SERVER_CONFIG?.saveUrl) MaweProjectLoad.detachServerProjectSaving();
      if (expectedName && !suppressMediaPrompt) {
        MaweProjectMediaInputs.pendingProjectMediaSelection = { projectReady: true };
        MaweProjectMediaInputs.showProjectMediaModal();
      }
      MaweHint.flashHint(expectedName
        ? `已加载工程：${file.name}（${suppressMediaPrompt ? '正在加载关联媒体' : `等待选择关联媒体：${expectedName}`}）`
        : `已加载工程：${file.name}（${MaweBoot.DATA.segments.length} 条字幕）`);
      return true;
    } catch (error) {
      MaweProjectMediaInputs.pendingProjectMediaSelection = null;
      MaweHint.flashHint(error instanceof SyntaxError
        ? '打开了错误的文件，请使用 MAW 生成的工程文件。'
        : `加载失败：${error.message}`, 'warning');
      console.error(error);
      return false;
    } finally {
      finishLoading();
    }
  }

  global.MaweMultiImport = Object.freeze({
    get pendingMultiImport() { return pendingMultiImport; },
    set pendingMultiImport(v) { pendingMultiImport = v; },
    closeMultiSubtitleImportModal,
    renderMultiImportPreview,
    renderMainImportPreview,
    renderProjectImportPreview,
    showMultiSubtitleImportChoice,
    prepareMultiSubtitleImport,
    commitMultiSubtitleImport,
    swapMainAndExtensionSubtitles,
    openSrtFile,
    openProjectFile
  });
})(typeof window !== 'undefined' ? window : globalThis);

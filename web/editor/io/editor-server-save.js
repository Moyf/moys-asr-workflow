// 服务器保存：保存目标、校验预览、自动保存调度。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweServerSave 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweServerSave(global) {
  'use strict';






  let projectCheckpointed = Boolean(MaweBoot.SERVER_CONFIG?.canSave)
    || !document.getElementById('json-name')?.classList.contains('empty');


  let projectCheckpointInFlight = false;


  // 浏览器「新建工程 / 另存为」选择的文件由页面持有 FileSystemFileHandle 持续写回；
  // Server 绑定的工程仍由服务器按真实路径原子保存，且优先级高于句柄。
  let projectFileHandle = null;



  function serverProjectSavingEnabled() {
    return !!(MaweBoot.SERVER_CONFIG && MaweBoot.SERVER_CONFIG.saveUrl && MaweBoot.SERVER_CONFIG.canSave);
  }



  function projectSaveTargetEnabled() {
    return serverProjectSavingEnabled() || projectFileHandle !== null;
  }

  function updateDesktopBinding(result, { saved = false } = {}) {
    const config = MaweBoot.SERVER_CONFIG;
    if (!config || !result || typeof result !== 'object') return false;
    config.desktopGeneration = Number.isInteger(result.generation) ? result.generation : config.desktopGeneration;
    config.desktopRevision = typeof result.revision === 'string' ? result.revision : null;
    config.desktopProjectPath = typeof result.projectPath === 'string' ? result.projectPath : null;
    if (Object.prototype.hasOwnProperty.call(result, 'mediaPath')) {
      config.desktopMediaPath = typeof result.mediaPath === 'string' ? result.mediaPath : null;
    }
    if (Object.prototype.hasOwnProperty.call(result, 'mediaError')) {
      config.desktopMediaError = typeof result.mediaError === 'string' ? result.mediaError : null;
    }
    if (Object.prototype.hasOwnProperty.call(result, 'mediaAvailable')) {
      config.desktopMediaAvailable = result.mediaAvailable === true;
    }
    if (Object.prototype.hasOwnProperty.call(result, 'stickerRoot')) {
      MaweBoot.STICKER_ROOT = typeof result.stickerRoot === 'string' ? result.stickerRoot : '';
    }
    config.canSave = Boolean(config.desktopProjectPath);
    config.canPortableStickerExport = config.canSave;
    config.canOtozStickerExport = config.canSave;
    config.canOtozTimelineExport = config.canSave;
    config.canLottieExport = config.canSave;
    config.canOgrafExport = config.canSave;
    if (saved) {
      config.desktopConflict = false;
      config.desktopConflictPrompted = false;
      config.desktopExternalRevision = null;
      config.desktopClosePending = false;
    }
    projectCheckpointed = true;
    configureServerSaveControls();
    MaweDynamicExports.updateLottieExportButton();
    MaweDynamicExports.updateOgrafExportButton();
    MaweExportTimeline.updateStickerExportButtons?.();
    MaweExportTimeline.updateTimelineOtiozExportButtons?.();
    window.MOSEUpdateDesktopPathActions?.();
    scheduleAutoSave();
    return true;
  }

  function sameDesktopPath(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return left === right;
    const normalize = (value) => value.replace(/\\/g, '/');
    const a = normalize(left);
    const b = normalize(right);
    return navigator.platform?.startsWith('Win') ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b;
  }

  async function handleDesktopProjectStatus(status) {
    const config = MaweBoot.SERVER_CONFIG;
    if (!MaweHost.desktop.available() || !config || !status || typeof status !== 'object') return;
    if (typeof status.generation === 'number') config.desktopGeneration = status.generation;
    const mediaWasAvailable = config.desktopMediaAvailable === true;
    config.desktopMediaPath = typeof status.mediaPath === 'string' ? status.mediaPath : null;
    config.desktopMediaAvailable = status.mediaAvailable === true;
    config.desktopMediaError = typeof status.mediaError === 'string' ? status.mediaError : null;
    if (typeof status.stickerRoot === 'string') MaweBoot.STICKER_ROOT = status.stickerRoot;
    window.MOSEUpdateDesktopPathActions?.();
    if (mediaWasAvailable && status.mediaAvailable === false && MaweBoot.DATA.media) {
      MaweProjectLoad.updateUnloadedMediaLabel(MaweBoot.DATA.media);
      MaweHint.flashHint(`媒体文件已不可用：${status.mediaError || status.mediaPath || MaweBoot.DATA.media}。字幕仍可编辑；请重新定位媒体。`, 'warning');
    } else if (!mediaWasAvailable && status.mediaAvailable === true && MaweBoot.DATA.media) {
      MaweHint.flashHint('关联媒体路径现已可用；请使用“加载媒体”重新载入。', 'warning');
    }

    const expectedPath = config.desktopProjectPath;
    if (!expectedPath || !sameDesktopPath(expectedPath, status.projectPath)) {
      if (expectedPath && !sameDesktopPath(expectedPath, status.projectPath)) {
        config.desktopConflict = true;
        config.desktopExternalRevision = status.revision || null;
      }
    } else if (status.revision !== config.desktopRevision) {
      config.desktopConflict = true;
      config.desktopExternalRevision = status.revision || null;
    }
    if (config.desktopConflict && !config.desktopConflictPrompted) {
      await promptForDesktopConflict(status);
    }
  }

  async function promptForDesktopConflict(status) {
    const config = MaweBoot.SERVER_CONFIG;
    if (!config || config.desktopConflictPrompted || !MaweHost.desktop.available()) return;
    config.desktopConflictPrompted = true;
    config.desktopConflict = true;
    if (!await MaweProjectSave.waitForProjectSaveIdle(60000)) {
      MaweHint.flashHint('工程文件已在外部改变，且保存仍在进行。自动保存已暂停，请稍后另存为或重新加载。', 'warning');
      return;
    }
    MaweProjectSave.flushInlineEditsForSave();
    const dirty = hasUnsavedProjectChanges();
    const choice = await MaweHost.desktop.chooseExternalChangeAction(dirty, window.MAWE_I18N?.language);
    if (choice.status !== 'ok' || choice.action === 'keep') {
      MaweHint.flashHint('已保留当前编辑；自动保存已暂停。可通过“另存为”保留当前版本。', 'warning');
      return;
    }
    if (choice.action === 'saveAs') {
      const saved = await MaweProjectSave.saveProjectAsToFile();
      if (!saved) MaweHint.flashHint('未另存为；当前编辑仍保留，自动保存继续暂停。', 'warning');
      return;
    }
    if (choice.action === 'reload') {
      const confirmation = await MaweHost.desktop.confirmExternalReload(dirty, window.MAWE_I18N?.language);
      if (confirmation.status !== 'ok' || confirmation.confirmed !== true) {
        MaweHint.flashHint('已取消重新加载；当前编辑保留，自动保存继续暂停。', 'warning');
        return;
      }
      const result = await MaweHost.desktop.command('reloadProject');
      if (result.status !== 'ok') {
        MaweHint.flashHint(`重新加载失败：${result.error?.message || '无法读取工程'}`, 'warning');
        return;
      }
      window.MOSESuppressBeforeUnload?.();
      window.location.reload();
      return;
    }
    config.desktopConflictPrompted = false;
    void status;
  }

  async function refreshDesktopStatus() {
    if (!MaweHost.desktop.available()) return null;
    const result = await MaweHost.desktop.command('status', { force: true });
    if (result.status !== 'ok') return null;
    await handleDesktopProjectStatus(result.data);
    return result.data;
  }



  function parseProjectValidationTarget(detail) {
    const value = String(detail || '');
    const mainMatch = /^\$\.segments\[(\d+)\](?:\.items\[(\d+)\])?(?:\.[A-Za-z_]\w*)?\s*:/.exec(value);
    const extensionMatch = /^\$\.multi_subtitle\.tracks\[(\d+)\]\.segments\[(\d+)\](?:\.items\[(\d+)\])?(?:\.[A-Za-z_]\w*)?\s*:/.exec(value);
    if (!mainMatch && !extensionMatch) return null;
    const kind = mainMatch ? 'main' : 'extension';
    const trackIndex = extensionMatch ? Number(extensionMatch[1]) : null;
    const segmentIndex = Number(mainMatch ? mainMatch[1] : extensionMatch[2]);
    const itemValue = mainMatch ? mainMatch[2] : extensionMatch[3];
    const itemIndex = itemValue === undefined ? null : Number(itemValue);
    const track = extensionMatch ? MaweMultiSubtitleCore.getMultiSubtitleState().tracks?.[trackIndex] : null;
    const segments = kind === 'main' ? MaweBoot.DATA.segments : (track?.segments || []);
    const segment = segments[segmentIndex];
    if (!segment) return null;
    const item = itemIndex === null
      ? null
      : (Array.isArray(segment.items) ? segment.items[itemIndex] : null);
    return {
      kind,
      trackIndex,
      track,
      segments,
      segmentIndex,
      itemIndex,
      segment,
      item: item && typeof item === 'object' ? item : null,
    };
  }



  function validationPreviewText(target) {
    const value = target.item?.text ?? target.segment.text;
    if (typeof value === 'string') return value || '（空）';
    try {
      return JSON.stringify(target.item || target.segment);
    } catch (_) {
      return '（无法预览）';
    }
  }



  function projectSegmentOverlap(target) {
    const segments = target?.segments;
    const currentIndex = Number(target?.segmentIndex);
    if (!Array.isArray(segments) || !Number.isInteger(currentIndex) || currentIndex <= 0) return null;
    const previous = segments[currentIndex - 1];
    const current = segments[currentIndex];
    const previousEnd = Number(previous?.end);
    const currentStart = Number(current?.start);
    const overlapMs = Math.round(previousEnd - currentStart);
    if (!previous || !current || !Number.isFinite(overlapMs) || overlapMs <= 0) return null;
    return {
      previousIndex: currentIndex - 1,
      currentIndex,
      previous,
      current,
      overlapMs,
    };
  }



  function repairProjectSegmentOverlap(target, mode, card) {
    const segments = target?.segments;
    const currentIndex = Number(target?.segmentIndex);
    if (!Array.isArray(segments)) return false;
    let previewSegments;
    try {
      previewSegments = JSON.parse(JSON.stringify(segments));
    } catch (_) {
      MaweHint.flashHint('无法准备时间范围修复，请先关闭提示后手动调整字幕边界', 'warning');
      return false;
    }
    const preview = window.AsrEditorUtils.repairSegmentOverlap(previewSegments, currentIndex, mode);
    if (!preview?.changed) {
      MaweHint.flashHint('当前字幕边界已经发生变化，请重新保存并查看最新的校验提示', 'warning');
      return false;
    }

    return MaweCommands.run('修复字幕时间重叠', (command) => {
      const result = window.AsrEditorUtils.repairSegmentOverlap(segments, currentIndex, mode);
      if (!result?.changed) {
        MaweHint.flashHint('当前字幕边界已经发生变化，修复未应用', 'warning');
        return false;
      }
      const changedSegments = (result.changedIndices || [])
        .map((index) => segments[index])
        .filter(Boolean);
      if (target.kind === 'main') MaweMultiSubtitleCore.markMainSegmentsDirty(changedSegments);
      else changedSegments.forEach((segment) => { segment._dirty = true; });
      MaweMultiSubtitleCore.syncBindingOffsets();
      if (target.kind === 'extension' || MaweMultiSubtitleCore.getMultiSubtitleState().tracks?.length) {
        MaweMultiSubtitleCore.markMultiSubtitleStateDirty();
      }
      command.commit({ cueList: true, waveform: 'overlay', preview: 'update' });

      MaweHistory.updateUndoRedoButtons();
      MaweHint.dismissHintCard(card);
      const suffix = result.itemsCleared
        ? '，已清除受影响字幕的字词时间码'
        : '';
      MaweHint.flashHint(`已修复字幕时间重叠${suffix}，正在重新保存`, result.itemsCleared ? 'warning' : 'success');
      window.setTimeout(() => { void MaweProjectSave.saveCurrentProject({ silent: false }); }, 0);
      return true;
    }, { captureView: true });
  }



  function focusProjectValidationTarget(target) {
    const { segmentIndex, segment } = target || {};
    const segments = target?.segments || MaweBoot.DATA.segments;
    if (!segment || !segments[segmentIndex]) return;

    // 校验错误不能因为用户当前的筛选状态而再次变得不可见。
    if (MaweDom.hideDisabled && segment.disabled) {
      MaweDom.hideDisabled = false;
      MaweDom.hideDisabledToggle.checked = false;
      MaweCoreState.container.classList.remove('hide-disabled');
    }
    const cueSelector = target.kind === 'extension'
      ? `.cue[data-ext-idx="${segmentIndex}"]`
      : `.cue[data-idx="${segmentIndex}"]`;
    const cueBeforeFilter = MaweCoreState.container.querySelector(cueSelector);
    if (cueBeforeFilter?.classList.contains('hidden')) {
      MaweDom.searchEl.value = '';
      MaweSearch.refreshSearchClearVisibility();
      const filterOver = document.getElementById('filter-over');
      if (filterOver?.classList.contains('active')) filterOver.classList.remove('active');
      MaweSearch.applySearch('');
    }

    if (target.kind === 'extension') {
      MaweSelection.selectOnlyExtension(segmentIndex, target.track || MaweMultiSubtitleCore.getActiveExtensionTrack());
      MaweSelection.lastClickedExtensionIdx = segmentIndex;
    } else {
      MaweSelection.selectOnly(segmentIndex);
      MaweSelection.lastClickedIdx = segmentIndex;
    }
    const cue = MaweCoreState.container.querySelector(cueSelector);
    if (cue) {
      cue.classList.remove('validation-target');
      // 重新触发一次短暂的高亮，即使用户连续点击多个错误提示也能看出目标。
      void cue.offsetWidth;
      cue.classList.add('validation-target');
      MaweCueListAnchor.scrollCueToCenter(cue);
      window.setTimeout(() => cue.classList.remove('validation-target'), 2200);
    }
    MaweCoreState.waveformEditor?.revealTime(segment.start, true);
    if (MaweMediaPlayback.hasLoadedMedia()) MaweTextCleanup.seekFromWaveform(segment.start / 1000);
  }



  function showProjectSaveError(detail) {
    const target = parseProjectValidationTarget(detail);
    if (!target) {
      MaweHint.flashHint(`保存失败：${detail}`, 'warning');
      return;
    }

    MaweHint.flashHint('', 'warning', {
      durationMs: 12000,
      contentBuilder: (card) => {
        card.classList.add('hint-project-error');

        const header = document.createElement('div');
        header.className = 'hint-project-header';
        const title = document.createElement('strong');
        title.textContent = '保存失败';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'hint-close';
        close.setAttribute('aria-label', '关闭提示');
        close.textContent = '×';
        close.addEventListener('click', () => MaweHint.dismissHintCard(card));
        header.append(title, close);

        const detailEl = document.createElement('code');
        detailEl.className = 'hint-project-detail';
        detailEl.textContent = String(detail || '未知校验错误');

        const location = document.createElement('div');
        location.className = 'hint-project-location';
        location.textContent = target.itemIndex === null
          ? `第 ${target.segmentIndex + 1} 条字幕`
          : `第 ${target.segmentIndex + 1} 条字幕 · item ${target.itemIndex + 1}`;

        const previewLabel = document.createElement('div');
        previewLabel.className = 'hint-project-preview-label';
        previewLabel.textContent = target.itemIndex === null ? '字幕内容' : 'item 内容';
        const preview = document.createElement('div');
        preview.className = 'hint-project-preview-value';
        preview.textContent = validationPreviewText(target);

        const overlapElements = [];
        const overlap = projectSegmentOverlap(target);
        if (overlap) {
          const conflict = document.createElement('div');
          conflict.className = 'hint-project-conflict';
          conflict.textContent = `第 ${overlap.previousIndex + 1} 条字幕结束于 ${MaweCueElements.fmtShort(overlap.previous.end)}，第 ${overlap.currentIndex + 1} 条字幕开始于 ${MaweCueElements.fmtShort(overlap.current.start)}，重叠 ${overlap.overlapMs}ms。`;

          const repairDescription = document.createElement('div');
          repairDescription.className = 'hint-project-repair-description';
          repairDescription.textContent = overlap.overlapMs <= MaweMultiSubtitleCore.PROJECT_SEGMENT_OVERLAP_AUTO_FIX_MAX_MS
            ? `这是小于等于 ${MaweMultiSubtitleCore.PROJECT_SEGMENT_OVERLAP_AUTO_FIX_MAX_MS}ms 的边界误差，可以安全把后句起点吸附到前句终点。`
            : `重叠超过 ${MaweMultiSubtitleCore.PROJECT_SEGMENT_OVERLAP_AUTO_FIX_MAX_MS}ms，请确认要保留哪一侧的时间边界；修复后会自动再次保存。`;

          const repairActions = document.createElement('div');
          repairActions.className = 'hint-project-actions';
          const addRepairButton = (className, text, mode) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `hint-project-action ${className}`;
            button.textContent = text;
            button.addEventListener('click', () => {
              button.disabled = true;
              if (!repairProjectSegmentOverlap(target, mode, card)) button.disabled = false;
            });
            repairActions.appendChild(button);
          };
          if (overlap.overlapMs <= MaweMultiSubtitleCore.PROJECT_SEGMENT_OVERLAP_AUTO_FIX_MAX_MS) {
            addRepairButton(
              'hint-project-repair-auto',
              `自动修复：推迟第 ${overlap.currentIndex + 1} 条字幕（${overlap.overlapMs}ms）`,
              'shift-current',
            );
          } else {
            addRepairButton('hint-project-repair-trim', '缩短前一句', 'trim-previous');
            addRepairButton('hint-project-repair-shift', '推迟后一句', 'shift-current');
          }
          overlapElements.push(conflict, repairDescription, repairActions);
        }

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'hint-project-action';
        action.textContent = `定位到第 ${target.segmentIndex + 1} 条字幕`;
        action.addEventListener('click', () => {
          focusProjectValidationTarget(target);
          MaweHint.dismissHintCard(card);
        });

        card.append(header, detailEl, location, previewLabel, preview, ...overlapElements, action);
      },
    });
  }



  function configureServerSaveControls() {
    const hasServer = !!(MaweBoot.SERVER_CONFIG && MaweBoot.SERVER_CONFIG.saveUrl);
    // 浏览器持有工程句柄时同样显示保存控件；服务器绑定优先于句柄。
    if (MaweDom.saveProjectDropdown) MaweDom.saveProjectDropdown.hidden = !(hasServer || projectFileHandle !== null);
    [MaweDom.saveProjectButton, document.getElementById('save-project-menu-btn')].forEach((button) => {
      if (!button) return;
      button.disabled = !projectSaveTargetEnabled();
       if (!projectSaveTargetEnabled()) button.title = '当前服务器未绑定工程；请先导出 .mosp，再重新打开该文件';
    });
    if (MaweDom.saveProjectButton && projectSaveTargetEnabled()) {
      MaweDom.saveProjectButton.title = '保存回当前工程文件（Ctrl(Cmd)+S）';
    }
    // 另存为走系统文件对话框，不依赖服务器绑定，始终可用。
    if (MaweDom.saveProjectAsButton) {
      MaweDom.saveProjectAsButton.title = '另存为工程文件（Ctrl(Cmd)+Shift+S）';
    }
    MaweStickerOtioExport.syncStickerOtioExportMode();
    syncProjectBackupControls();
  }



  let autoSaveTimer = null;


  let autoSaveFlushTimer = null;


  let projectSaveInFlight = false;


  const EDIT_SAVE_DEBOUNCE_MS = 400;



  function scheduleAutoSave() {
    if (autoSaveTimer !== null) {
      window.clearInterval(autoSaveTimer);
      autoSaveTimer = null;
    }
    if (!projectSaveTargetEnabled() || !MaweSettings.EDITOR_SETTINGS.autoSaveProject
        || MaweBoot.SERVER_CONFIG?.desktopClosePending
        || MaweBoot.SERVER_CONFIG?.desktopConflict) return;
    autoSaveTimer = window.setInterval(() => {
      if (hasUnsavedProjectChanges() && !projectSaveInFlight && !projectCheckpointInFlight
          && !MaweBoot.SERVER_CONFIG?.desktopClosePending
          && !MaweBoot.SERVER_CONFIG?.desktopConflict) {
        void MaweProjectSave.saveCurrentProject({ silent: true });
      }
    }, MaweSettings.EDITOR_SETTINGS.autoSaveIntervalSeconds * 1000);
  }



    function configureServerAutoSave() {
      if (!MaweDom.serverAutoSaveSettings || !MaweDom.autoSaveProjectToggle || !MaweDom.autoSaveIntervalField || !MaweDom.autoSaveIntervalInput) return;
      // 服务器绑定工程或浏览器保存对话框（句柄模式）任一可用时都可自动保存。
      const available = Boolean(MaweBoot.SERVER_CONFIG?.saveUrl || MaweHost.files.hasSavePicker());
      MaweDom.serverAutoSaveSettings.hidden = !available;
      // 自动保存不可用时隐藏「保存」标签页，避免设置窗口出现空白分区。
      const saveTab = document.getElementById('editor-settings-tab-save');
      if (saveTab) saveTab.hidden = !available;
      if (!available) return;
    const sync = () => {
      MaweDom.autoSaveProjectToggle.checked = MaweSettings.EDITOR_SETTINGS.autoSaveProject;
      MaweDom.autoSaveIntervalInput.value = String(MaweSettings.EDITOR_SETTINGS.autoSaveIntervalSeconds);
      MaweDom.autoSaveIntervalField.hidden = !MaweSettings.EDITOR_SETTINGS.autoSaveProject;
      MaweDom.autoSaveProjectToggle.disabled = false;
      MaweDom.autoSaveIntervalInput.disabled = !MaweSettings.EDITOR_SETTINGS.autoSaveProject;
    };
    sync();
    MaweDom.autoSaveProjectToggle.addEventListener('change', () => {
      MaweSettings.updateEditorSettings({ autoSaveProject: MaweDom.autoSaveProjectToggle.checked });
      sync();
      scheduleAutoSave();
    });
    MaweDom.autoSaveIntervalInput.addEventListener('change', () => {
      MaweSettings.updateEditorSettings({ autoSaveIntervalSeconds: MaweSettings.clampAutoSaveInterval(MaweDom.autoSaveIntervalInput.value) });
      sync();
      scheduleAutoSave();
    });
    scheduleAutoSave();
  }



  function hasUnsavedProjectChanges() {
    return MaweState.hasProjectChanges(MaweProjectSave.inlineEditHasUncommittedText());
}



  // 文字编辑先写入页面内存，避免每个按键都请求服务器；失焦后短暂防抖保存，
  // 这样点击其它字幕或刷新页面时不会因为 30 秒定时保存尚未到点而丢失刚完成的修改。
  function scheduleAutoSaveFlush() {
    if (autoSaveFlushTimer !== null) {
      window.clearTimeout(autoSaveFlushTimer);
      autoSaveFlushTimer = null;
    }
    if (!projectSaveTargetEnabled() || !MaweSettings.EDITOR_SETTINGS.autoSaveProject
        || MaweBoot.SERVER_CONFIG?.desktopClosePending
        || MaweBoot.SERVER_CONFIG?.desktopConflict) return;
    autoSaveFlushTimer = window.setTimeout(() => {
      autoSaveFlushTimer = null;
      if (hasUnsavedProjectChanges() && !projectSaveInFlight
          && !MaweBoot.SERVER_CONFIG?.desktopClosePending
          && !MaweBoot.SERVER_CONFIG?.desktopConflict) {
        void MaweProjectSave.saveCurrentProject({ silent: true });
      }
    }, EDIT_SAVE_DEBOUNCE_MS);
  }



  async function openRecentProject(project) {
    if (!MaweBoot.SERVER_CONFIG?.recentProjectsUrl) return;
    if (MaweHost.desktop.available()) {
      if (!await window.MOSEConfirmProjectSwitch?.()) return;
    } else if (hasUnsavedProjectChanges()
        && !confirm('当前有未保存的改动，是否确定打开最近工程？将丢失未保存内容。')) return;
    try {
      if (MaweHost.desktop.available()) {
        const result = await MaweHost.desktop.command('openRecentProject', { path: project.path });
        if (result.status !== 'ok') {
          const error = new Error(result.error?.message || '最近工程未能打开');
          error.missing = result.error?.code === 'FILE_NOT_FOUND';
          throw error;
        }
        window.location.reload();
        return;
      }
      const response = await MaweHost.server.fetch(MaweBoot.SERVER_CONFIG.recentProjectsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: project.path }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        const error = new Error(result.error || `服务器返回 ${response.status}`);
        error.missing = result.missing === true;
        throw error;
      }
      window.location.reload();
    } catch (error) {
      if (error?.missing) {
        project.exists = false;
        markRecentProjectMissing(project);
      }
      MaweHint.flashHint(`打开工程失败：${error.message || error}`, 'warning');
    }
  }



  // 浏览器文件选择器拿不到工程的真实路径，但 MAW 工程记录的媒体是绝对路径。
  // 把工程名与内容交给服务器，由它定位同目录同名工程并接管：
  // 成功后整页刷新，由服务器渲染出自动加载媒体且可直接保存的状态。
  // 任何失败都静默回退为「手动选择媒体」的便携流程。
  async function attachProjectToServer(fileName, projectData) {
    try {
      const response = await MaweHost.server.fetch(MaweBoot.SERVER_CONFIG.attachUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, project: projectData }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) return false;
      window.location.reload();
      return true;
    } catch {
      return false;
    }
  }



  function renderMissingRecentProjectItem(item, project) {
    item.className = 'dropdown-item is-missing';
    item.style.cursor = 'not-allowed';
    item.replaceChildren();
    const label = document.createElement('span');
    label.className = 'recent-project-name';
    label.textContent = project.name;
    item.appendChild(label);
    const badge = document.createElement('span');
    badge.className = 'recent-project-badge is-missing';
    badge.textContent = '已失效';
    item.appendChild(badge);
    item.title = `工程路径失效：${project.path}`;
  }



  function markRecentProjectMissing(project) {
    if (!MaweDom.recentProjectsList || !project || typeof project.path !== 'string') return;
    const item = Array.from(MaweDom.recentProjectsList.children)
      .find((candidate) => candidate.dataset.projectPath === project.path);
    if (item) renderMissingRecentProjectItem(item, project);
  }



  function configureRecentProjects() {
    if (!MaweBoot.SERVER_CONFIG?.recentProjectsUrl || !MaweDom.recentProjectsEl || !MaweDom.recentProjectsToggle
        || !MaweDom.recentProjectsMenu || !MaweDom.recentProjectsList) {
      return;
    }
    const projects = Array.isArray(MaweBoot.SERVER_CONFIG.recentProjects) ? MaweBoot.SERVER_CONFIG.recentProjects : [];
    MaweDom.recentProjectsEl.hidden = false;
    MaweDom.recentProjectsList.replaceChildren();
    if (MaweDom.recentProjectsSeparator) MaweDom.recentProjectsSeparator.hidden = !projects.length;
    projects.forEach((project, index) => {
      if (!project || typeof project.path !== 'string' || typeof project.name !== 'string') return;
      const item = document.createElement('div');
      item.dataset.projectPath = project.path;
      if (project.exists === false) {
        renderMissingRecentProjectItem(item, project);
      } else {
        item.className = 'dropdown-item';
        // 工程名与其它项一致占正文；「上次打开」只作为右侧徽标标记，不写进名字
        const label = document.createElement('span');
        label.className = 'recent-project-name';
        label.textContent = project.name;
        item.appendChild(label);
        if (index === 0) {
          const badge = document.createElement('span');
          badge.className = 'recent-project-badge';
          badge.textContent = '上次打开';
          item.appendChild(badge);
        }
        item.title = project.path;
      }
      item.addEventListener('click', () => {
        MaweDom.recentProjectsEl.classList.remove('open');
        if (item.classList.contains('is-missing')) {
          MaweHint.flashHint('工程路径失效，文件可能已被移动或删除', 'warning');
          return;
        }
        openRecentProject(project);
      });
      MaweDom.recentProjectsList.appendChild(item);
    });
    if (MaweDom.recentProjectsEl.dataset.listenersBound !== 'true') {
      MaweDom.recentProjectsToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        MaweDom.recentProjectsEl.classList.toggle('open');
        if (MaweDom.recentProjectsEl.classList.contains('open')) MaweFloatingPanel.bringFloatingSurfaceToFront(MaweDom.recentProjectsEl);
        else MaweFloatingPanel.syncFloatingSurfaceLayers();
      });
      document.addEventListener('click', (event) => {
        if (!MaweDom.recentProjectsEl.contains(event.target)) MaweDom.recentProjectsEl.classList.remove('open');
      });
      MaweDom.recentProjectsEl.dataset.listenersBound = 'true';
    }
  }



  function configureServerProjectSettings() {
    if (!MaweBoot.SERVER_CONFIG?.settingsUrl || !MaweDom.serverProjectSettingsEl || !MaweDom.autoOpenLastProjectToggle) return;
    MaweDom.serverProjectSettingsEl.hidden = false;
    MaweDom.autoOpenLastProjectToggle.checked = MaweBoot.SERVER_CONFIG.autoOpenLastProject !== false;
    if (MaweDom.autoOpenLastProjectToggle.dataset.listenersBound !== 'true') {
      MaweDom.autoOpenLastProjectToggle.addEventListener('change', async () => {
        const enabled = MaweDom.autoOpenLastProjectToggle.checked;
        MaweDom.autoOpenLastProjectToggle.disabled = true;
        try {
          const response = await MaweHost.server.fetch(MaweBoot.SERVER_CONFIG.settingsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autoOpenLastProject: enabled }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.ok) {
            throw new Error(result.error || `服务器返回 ${response.status}`);
          }
          MaweBoot.SERVER_CONFIG.autoOpenLastProject = result.autoOpenLastProject;
        } catch (error) {
          MaweDom.autoOpenLastProjectToggle.checked = MaweBoot.SERVER_CONFIG.autoOpenLastProject !== false;
          MaweHint.flashHint(`保存设置失败：${error.message || error}`, 'warning');
        } finally {
          MaweDom.autoOpenLastProjectToggle.disabled = false;
        }
      });
      MaweDom.autoOpenLastProjectToggle.dataset.listenersBound = 'true';
    }
  }

  global.MaweServerSave = Object.freeze({
    get projectImportDirty() { return MaweState.changes.projectImportDirty; },
    set projectImportDirty(v) { MaweState.changes.projectImportDirty = v; },
    get projectCheckpointed() { return projectCheckpointed; },
    set projectCheckpointed(v) { projectCheckpointed = v; },
    get projectCheckpointInFlight() { return projectCheckpointInFlight; },
    set projectCheckpointInFlight(v) { projectCheckpointInFlight = v; },
    get projectFileHandle() { return projectFileHandle; },
    set projectFileHandle(v) { projectFileHandle = v; },
    serverProjectSavingEnabled,
    projectSaveTargetEnabled,
    updateDesktopBinding,
    handleDesktopProjectStatus,
    refreshDesktopStatus,
    parseProjectValidationTarget,
    validationPreviewText,
    projectSegmentOverlap,
    repairProjectSegmentOverlap,
    focusProjectValidationTarget,
    showProjectSaveError,
    configureServerSaveControls,
    get autoSaveTimer() { return autoSaveTimer; },
    set autoSaveTimer(v) { autoSaveTimer = v; },
    get autoSaveFlushTimer() { return autoSaveFlushTimer; },
    set autoSaveFlushTimer(v) { autoSaveFlushTimer = v; },
    get projectSaveInFlight() { return projectSaveInFlight; },
    set projectSaveInFlight(v) { projectSaveInFlight = v; },
    EDIT_SAVE_DEBOUNCE_MS,
    scheduleAutoSave,
    configureServerAutoSave,
    hasUnsavedProjectChanges,
    scheduleAutoSaveFlush,
    openRecentProject,
    attachProjectToServer,
    renderMissingRecentProjectItem,
    markRecentProjectMissing,
    configureRecentProjects,
    configureServerProjectSettings
  });
})(typeof window !== 'undefined' ? window : globalThis);

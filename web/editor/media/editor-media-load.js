// 媒体加载：媒体与 reapeaks 文件加载、元数据等待。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweMediaLoad 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweMediaLoad(global) {
  'use strict';

  let mediaLoadInFlight = false;

  async function chooseNativeMedia() {
    if (!window.MOSEDesktop?.available) return false;
    try {
      const nativePath = await window.MOSEDesktop.chooseMedia();
      if (!nativePath) return false;
      const file = { name: window.AsrEditorUtils.fileBasename(nativePath), type: '', nativePath };
      if (!MaweProjectMediaInputs.pendingProjectMediaSelection
          && !await MaweProjectLoad.ensureProjectCheckpointForImport(file, { usePicker: false })) return false;
      MaweProjectMediaInputs.pendingProjectMediaSelection = null;
      const imported = await loadMediaFile(file);
      if (imported) {
        MaweServerSave.projectImportDirty = true;
        if (MaweServerSave.projectSaveTargetEnabled()) await MaweProjectSave.saveCurrentProject({ silent: true });
      }
      return imported;
    } catch (error) {
      MaweHint.flashHint(`媒体加载失败：${error.message || error}`, 'warning');
      return false;
    }
  }



  async function loadMediaFile(file) {
    if (!file) return;
    if (mediaLoadInFlight) return false;
    mediaLoadInFlight = true;
    const finishLoading = MaweLoadingProgress.beginEditorLoading(`正在加载媒体 ${file.name}…`, 5);
    try {
    const nativePath = file.nativePath || window.MOSEDesktop?.pathForFile?.(file);
    const native = nativePath ? await window.MOSEDesktop.loadMedia({
      path: nativePath, project: JSON.parse(MaweJsonRepair.buildJson()),
      detached: !MaweServerSave.serverProjectSavingEnabled(),
    }) : null;
    MaweJklPlayback.stopJklReversePlayback({ render: false });
    const preserveProjectWaveform = !native && MaweCoreState.waveformLoadedFromProject
      && Boolean(MaweCoreState.waveformEditor?.getPayload?.());
    const url = native ? new URL(native.mediaUrl, window.location.href).href : URL.createObjectURL(file);
    const isVideo = String(file.type || '').startsWith('video/') ||
      /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v)$/i.test(file.name);
    const oldPlayer = document.getElementById('player');
    const wantTag = isVideo ? 'VIDEO' : 'AUDIO';
    const oldParent = oldPlayer.parentNode;
    const previousSource = oldPlayer.querySelector('source')?.src || oldPlayer.currentSrc || oldPlayer.src || '';
    let candidatePlayer = oldPlayer;

    if (oldPlayer.tagName === wantTag) {
      // 同类型：直接换 src，最简最安全
      const src = oldPlayer.querySelector('source');
      if (src) src.src = url; else oldPlayer.src = url;
      oldPlayer.load();
    } else {
      // 不同类型：替换整个元素
      const newPlayer = document.createElement(isVideo ? 'video' : 'audio');
      newPlayer.id = 'player';
      newPlayer.preload = 'metadata';
      if (isVideo) {
        newPlayer.style.cssText = 'width:100%;background:#000;display:block;';
      } else {
        newPlayer.style.cssText = 'width:100%;display:block;';
      }
      const source = document.createElement('source');
      source.src = url;
      newPlayer.appendChild(source);
      oldPlayer.parentNode.replaceChild(newPlayer, oldPlayer);
      candidatePlayer = newPlayer;
      // 重新绑定全局引用与事件
      MaweCoreState.player = newPlayer;
      MaweMediaPlayback.bindPlayerEvents(MaweCoreState.player);
      MaweNavPreview.seekWarned = false;  // 新媒体重新探测 seek 能力
      MaweNavPreview.pendingMediaSeekTimeSec = null;
      MaweNavPreview.autoLoadedMediaReadyNotified = false;
    }

    try {
      MaweLoadingProgress.updateEditorLoading(45, `正在读取媒体信息 ${file.name}…`);
      await waitForMediaMetadata(candidatePlayer, file);
      if (native) await window.MOSEDesktop.commitMedia(native.ticket);
    } catch (error) {
      if (candidatePlayer !== oldPlayer && oldParent) {
        oldParent.replaceChild(oldPlayer, candidatePlayer);
        MaweCoreState.player = oldPlayer;
        MaweCoreState.waveformEditor?.attachPlayer(MaweCoreState.player);
      } else if (previousSource) {
        const previous = oldPlayer.querySelector('source');
        if (previous) previous.src = previousSource; else oldPlayer.src = previousSource;
        oldPlayer.load();
      } else {
        oldPlayer.removeAttribute('src');
        oldPlayer.querySelector('source')?.removeAttribute('src');
      }
      if (!native) URL.revokeObjectURL(url);
      MaweMediaPlayback.syncPlayerPlaceholder();
      MaweHint.flashHint(error.message || `媒体加载失败：${file.name}`, 'warning');
      return false;
    }

    if (isVideo) MaweTimeline.captureProjectVideoDimensions(candidatePlayer);
    else MaweTimeline.clearProjectVideoDimensions();

    let mediaTimeReference = null;
    try {
      mediaTimeReference = native ? native.project.media_time_reference || null
        : await window.AsrEditorUtils.readBwfTimeReferenceFromFile(file);
    } catch (_) {
      // BWF metadata is optional; an unreadable header must not block playback.
    }

    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.attachPlayer(MaweCoreState.player);
    MaweMediaPlayback.syncPlayerPlaceholder();
    // 部分浏览器会在 load() 完成前暂时不给 currentSrc；文件既已由用户选定，立即恢复彩色波形。
    MaweCoreState.waveformEditor?.setMediaAvailable(true);

    // 释放旧 blob URL（不会影响 file:// 加载的原始媒体——那不是 blob URL）
    if (MaweProjectMediaInputs.currentMediaBlobUrl) URL.revokeObjectURL(MaweProjectMediaInputs.currentMediaBlobUrl);
    MaweProjectMediaInputs.currentMediaBlobUrl = native ? null : url;

    // 更新标题区媒体名 + FILENAME_BASE（用文件名去扩展名作为导出基名）
    const stem = file.name.replace(/\.[^.]+$/, '');
    MaweBoot.FILENAME_BASE = stem;
    MaweBoot.DATA.media = native ? native.project.media : file.name;
    if (native) {
      MaweBoot.DATA.media_metadata = native.project.media_metadata || null;
      MaweBoot.SERVER_CONFIG.mediaPath = nativePath;
      MaweBoot.SERVER_CONFIG.missingMedia = false;
      MaweWaveformInit.deferredReapeaksEpoch += 1;
      MaweBoot.DATA.waveform = native.project.waveform || null;
      MaweBoot.DATA.spectral = native.project.spectral || null;
      MaweBoot.DATA.waveform_reapeaks = native.project.waveform_reapeaks || null;
      MaweBoot.DATA.loudness = native.project.loudness || null;
      MaweCoreState.waveformLoadedFromProject = Boolean(MaweCoreState.waveformEditor?.setPayload(MaweBoot.DATA.waveform));
      MaweCoreState.waveformEditor?.setSpectralPayload(MaweBoot.DATA.spectral);
      MaweCoreState.waveformEditor?.setReapeaksWaveform(MaweBoot.DATA.waveform_reapeaks);
      MaweCoreState.waveformEditor?.setLoudnessStats(MaweBoot.DATA.loudness);
      void MaweWaveformInit.loadDeferredReapeaks();
    }
    MaweBoot.DATA.media_time_reference = mediaTimeReference;
    const mnEl = document.getElementById('media-name');
    if (mnEl) {
      mnEl.textContent = file.name;
      mnEl.title = nativePath || `点击复制媒体名：${file.name}`;
      mnEl.classList.remove('empty');
      mnEl.onclick = () => MaweExportTimeline.copyText(nativePath || file.name, `已复制媒体名：${nativePath || file.name}`);
    }

    MawePlaybackLoop.lastActive = -1;
    MaweHint.flashHint(MaweProjectSave.translatedEditorText(`已加载媒体：${file.name}`), 'success');
    if (MaweCoreState.waveformEditor && !preserveProjectWaveform && !native) {
      try {
        MaweBoot.DATA.spectral = null;
        MaweBoot.DATA.waveform_reapeaks = null;
        MaweCoreState.waveformEditor.setSpectralPayload(null);
        MaweCoreState.waveformEditor.setReapeaksWaveform(null);
        MaweLoadingProgress.updateEditorLoading(75, `正在生成波形 ${file.name}…`);
        await MaweCoreState.waveformEditor.processFile(file);
      } catch (error) {
        MaweHint.flashHint(error.message || String(error), 'warning');
      }
    }
    MaweLoadingProgress.updateEditorLoading(100, `媒体加载完成：${file.name}`);
    MaweGapRemoveUi.updateGapRemoveUi();
    return true;
    } catch (error) {
      MaweHint.flashHint(`媒体加载失败：${error.message || error}`, 'warning');
      return false;
    } finally {
      mediaLoadInFlight = false;
      finishLoading();
    }
  }



  async function loadReapeaksFile(file) {
    if (!file || !MaweCoreState.isReapeaksFile(file) || !MaweCoreState.waveformEditor) return false;
    try {
      const parsed = window.AsrWaveform.testing.decodeReapeaksFile(
        await file.arrayBuffer(),
        { name: file.name, size: file.size, modified_ms: file.lastModified },
      );
      if (!parsed?.waveform) throw new Error('无法解析 .ReaPeaks 文件或文件不包含 wave 层');
      MaweBoot.DATA.waveform_reapeaks = parsed.waveform;
      MaweBoot.DATA.spectral = parsed.spectral;
      MaweCoreState.waveformEditor.setReapeaksWaveform(parsed.waveform);
      MaweCoreState.waveformEditor.setSpectralPayload(parsed.spectral);
      MaweCoreState.waveformEditor.setMediaAvailable(false);
      MaweHint.flashHint(`已加载 reapeaks 缓存：${file.name}`, 'success');
      return true;
    } catch (error) {
      MaweHint.flashHint(`加载 reapeaks 失败：${error.message || error}`, 'warning');
      return false;
    }
  }



  function waitForMediaMetadata(mediaElement, file) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => finish(new Error(mediaLoadErrorMessage(file))), 8000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        mediaElement.removeEventListener('loadedmetadata', onLoaded);
        mediaElement.removeEventListener('error', onError);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const onLoaded = () => finish();
      const onError = () => finish(new Error(mediaLoadErrorMessage(file)));
      mediaElement.addEventListener('loadedmetadata', onLoaded, { once: true });
      mediaElement.addEventListener('error', onError, { once: true });
      if (mediaElement.readyState >= 1) queueMicrotask(onLoaded);
    });
  }



  function mediaLoadErrorMessage(file) {
    const name = String(file?.name || '媒体文件');
    if (/\.flv$/i.test(name)) {
      return `无法播放 ${name}：当前浏览器未能解码 FLV，请先用 FFmpeg 转成 MP4。`;
    }
    return `无法播放 ${name}：浏览器不支持该媒体格式或编码。`;
  }

  global.MaweMediaLoad = Object.freeze({
    chooseNativeMedia,
    loadMediaFile,
    loadReapeaksFile,
    waitForMediaMetadata,
    mediaLoadErrorMessage
  });
})(typeof window !== 'undefined' ? window : globalThis);

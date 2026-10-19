// 媒体加载：媒体与 reapeaks 文件加载、元数据等待。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweMediaLoad 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweMediaLoad(global) {
  'use strict';



  let mediaLoadGeneration = 0;
  let cancelMediaLoad = () => {};
  function beginMediaRequest() {
    cancelMediaLoad();
    const controller = new AbortController();
    cancelMediaLoad = () => controller.abort();
    const unobserve = MaweState.observeProjectLoad(cancelMediaLoad);
    return { signal: controller.signal, finish: unobserve };
  }

  function whileCurrent(promise, signal) {
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new DOMException('媒体加载已取消', 'AbortError'));
      signal.addEventListener('abort', cancel, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      if (signal.aborted) cancel();
    });
  }
  async function loadMediaFile(file) {
    if (!file || MaweState.projectLoadPending) return false;
    const generation = ++mediaLoadGeneration;
    const request = beginMediaRequest();
    const epoch = MaweProjectLoad.projectBindingEpoch;
    const projectLoad = MaweState.projectLoadGeneration;
    const isCurrent = () => !request.signal.aborted && generation === mediaLoadGeneration && epoch === MaweProjectLoad.projectBindingEpoch
      && projectLoad === MaweState.projectLoadGeneration;
    const finishLoading = MaweLoadingProgress.beginEditorLoading(`正在导入媒体 ${file.name}…`, 5);
    const url = URL.createObjectURL(file);
    let committed = false;
    let candidatePlayer;
    try {
    MaweJklPlayback.stopJklReversePlayback({ render: false });
    const preserveProjectWaveform = MaweCoreState.waveformLoadedFromProject
      && Boolean(MaweCoreState.waveformEditor?.getPayload?.());
    const isVideo = file.type.startsWith('video/') ||
      /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v)$/i.test(file.name);
    const oldPlayer = document.getElementById('player');
    // Decode a private candidate. Pending imports must never mutate the player
    // belonging to the current project, or become another import's rollback.
    candidatePlayer = document.createElement(isVideo ? 'video' : 'audio');
    candidatePlayer.id = 'player';
    candidatePlayer.preload = 'metadata';
    candidatePlayer.volume = oldPlayer.volume;
    candidatePlayer.muted = oldPlayer.muted;
      if (isVideo) {
        candidatePlayer.style.cssText = 'width:100%;background:#000;display:block;';
      } else {
        candidatePlayer.style.cssText = 'width:100%;display:block;';
      }
      const source = document.createElement('source');
      source.src = url;
    candidatePlayer.appendChild(source);
    candidatePlayer.load();

    try {
      MaweLoadingProgress.updateEditorLoading(45, `正在读取媒体信息 ${file.name}…`);
      await waitForMediaMetadata(candidatePlayer, file, request.signal);
    } catch (error) {
      if (!isCurrent()) return false;
      MaweHint.flashHint(error.message || `媒体加载失败：${file.name}`, 'warning');
      return false;
    }

    if (!isCurrent()) return false;

    let mediaTimeReference = null;
    try {
      mediaTimeReference = await whileCurrent(window.AsrEditorUtils.readBwfTimeReferenceFromFile(file), request.signal);
    } catch (_) {
      // BWF metadata is optional; an unreadable header must not block playback.
    }

    if (!isCurrent()) return false;
    candidatePlayer.playbackRate = oldPlayer.playbackRate;
    oldPlayer.pause();
    oldPlayer.parentNode.replaceChild(candidatePlayer, oldPlayer);
    MaweCoreState.player = candidatePlayer;
    MaweMediaPlayback.bindPlayerEvents(candidatePlayer);
    MaweNavPreview.seekWarned = false;
    MaweNavPreview.pendingMediaSeekTimeSec = null;
    MaweNavPreview.autoLoadedMediaReadyNotified = false;
    if (isVideo) MaweTimeline.captureProjectVideoDimensions(candidatePlayer);
    else MaweTimeline.clearProjectVideoDimensions();

    if (MaweBoot.SERVER_CONFIG) MaweBoot.SERVER_CONFIG.thumbnailBinding = '';
    MaweCoreState.waveformEditor?.setThumbnailBinding('');

    // A server-bound video export can only use the server's original media.
    // Once the user replaces it with a browser-local file, invalidate that
    // capability so later exports cannot silently use stale source footage.
    if (MaweBoot.SERVER_CONFIG) {
      MaweBoot.SERVER_CONFIG.canGapRemovedMediaExport = false;
      MaweBoot.SERVER_CONFIG.gapRemovedMediaKind = null;
      MaweBoot.SERVER_CONFIG.gapRemovedMediaAudioTrack = null;
      MaweBoot.SERVER_CONFIG.gapRemovedMediaSourceName = null;
      MaweBoot.SERVER_CONFIG.gapRemovedMediaOutputExtension = null;
      MaweBoot.SERVER_CONFIG.gapRemovedMediaOutputMime = null;
      MaweBoot.SERVER_CONFIG.canGapRemovedVideoExport = false;
      MaweBoot.SERVER_CONFIG.gapRemovedVideoSourceName = null;
    }

    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.attachPlayer(MaweCoreState.player);
    MaweMediaPlayback.syncPlayerPlaceholder();
    // 部分浏览器会在 load() 完成前暂时不给 currentSrc；文件既已由用户选定，立即恢复彩色波形。
    MaweCoreState.waveformEditor?.setMediaAvailable(true);

    // 释放旧 blob URL（不会影响 file:// 加载的原始媒体——那不是 blob URL）
    if (MaweProjectMediaInputs.currentMediaBlobUrl) URL.revokeObjectURL(MaweProjectMediaInputs.currentMediaBlobUrl);
    MaweProjectMediaInputs.currentMediaBlobUrl = url;
    committed = true;

    // 更新标题区媒体名 + FILENAME_BASE（用文件名去扩展名作为导出基名）
    const stem = file.name.replace(/\.[^.]+$/, '');
    MaweBoot.FILENAME_BASE = stem;
    MaweBoot.DATA.media = file.name;
    window.MaweBurnVideoExport?.invalidateBinding();
    window.MaweGapRemovedMediaExport?.updateButton();
    MaweBoot.DATA.media_time_reference = mediaTimeReference;
    // The media is now project truth; waveform generation is optional and may
    // be superseded by a separate cache import before this function returns.
    MaweServerSave.projectImportDirty = true;
    MaweServerSave.configureServerSaveControls();
    MaweServerSave.scheduleAutoSave();
    const mnEl = document.getElementById('media-name');
    if (mnEl) {
      mnEl.textContent = file.name;
      mnEl.title = `点击复制媒体名：${file.name}`;
      mnEl.classList.remove('empty');
      mnEl.onclick = () => MaweExportTimeline.copyText(file.name, `已复制媒体名：${file.name}`);
    }

    MawePlaybackLoop.lastActive = -1;
    MaweHint.flashHint(MaweProjectSave.translatedEditorText(`已导入媒体：${file.name}`), 'success');
    if (MaweCoreState.waveformEditor && !preserveProjectWaveform) {
      try {
        MaweBoot.DATA.spectral = null;
        MaweBoot.DATA.waveform_reapeaks = null;
        MaweCoreState.waveformEditor.setSpectralPayload(null);
        MaweCoreState.waveformEditor.setReapeaksWaveform(null);
        MaweLoadingProgress.updateEditorLoading(75, `正在生成波形 ${file.name}…`);
        await whileCurrent(MaweCoreState.waveformEditor.processFile(file, { isCurrent }), request.signal);
      } catch (error) {
        if (isCurrent()) MaweHint.flashHint(error.message || String(error), 'warning');
      }
    }
    if (!isCurrent()) return false;
    MaweLoadingProgress.updateEditorLoading(100, `媒体加载完成：${file.name}`);
    MaweGapRemoveUi.updateGapRemoveUi();
    return true;
    } finally {
      request.finish();
      if (!committed) {
        candidatePlayer?.pause();
        candidatePlayer?.removeAttribute('src');
        candidatePlayer?.querySelector('source')?.removeAttribute('src');
        candidatePlayer?.load();
        URL.revokeObjectURL(url);
      }
      finishLoading();
    }
  }



  async function loadReapeaksFile(file) {
    if (!file || MaweState.projectLoadPending || !MaweCoreState.isReapeaksFile(file) || !MaweCoreState.waveformEditor) return false;
    const generation = ++mediaLoadGeneration;
    const request = beginMediaRequest();
    const epoch = MaweProjectLoad.projectBindingEpoch;
    const projectLoad = MaweState.projectLoadGeneration;
    const current = () => generation === mediaLoadGeneration && epoch === MaweProjectLoad.projectBindingEpoch
      && projectLoad === MaweState.projectLoadGeneration;
    try {
      const bytes = await whileCurrent(file.arrayBuffer(), request.signal);
      if (!current()) return false;
      const parsed = window.AsrWaveform.testing.decodeReapeaksFile(
        bytes,
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
      if (!current()) return false;
      MaweHint.flashHint(`加载 reapeaks 失败：${error.message || error}`, 'warning');
      return false;
    } finally {
      request.finish();
    }
  }



  function waitForMediaMetadata(mediaElement, file, signal = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => finish(new Error(mediaLoadErrorMessage(file))), 8000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        mediaElement.removeEventListener('loadedmetadata', onLoaded);
        mediaElement.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const onLoaded = () => finish();
      const onError = () => finish(new Error(mediaLoadErrorMessage(file)));
      const onAbort = () => finish(new DOMException('媒体加载已取消', 'AbortError'));
      mediaElement.addEventListener('loadedmetadata', onLoaded, { once: true });
      mediaElement.addEventListener('error', onError, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
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
    get mediaLoadGeneration() { return mediaLoadGeneration; },
    loadMediaFile,
    loadReapeaksFile,
    waitForMediaMetadata,
    mediaLoadErrorMessage
  });
})(typeof window !== 'undefined' ? window : globalThis);

// 媒体播放：播放器事件、占位符、速率与 seek 控制。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweMediaPlayback 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweMediaPlayback(global) {
  'use strict';



  function syncPlayerPlaceholder() {
    if (!MaweDom.playerEmpty) return;
    const source = MaweCoreState.player?.currentSrc
      || MaweCoreState.player?.getAttribute('src')
      || MaweCoreState.player?.querySelector('source')?.getAttribute('src')
      || '';
    const hasMedia = Boolean(String(source).trim());
    MaweDom.playerEmpty.classList.toggle('hidden', hasMedia);
    MaweDom.playerWrap?.classList.toggle('empty-state', !hasMedia);
    MaweCoreState.waveformEditor?.setMediaAvailable(hasMedia);
  }



  function togglePlayback() {
    if (!hasLoadedMedia()) {
      MaweHint.flashHint('请先加载媒体，然后才能预览', 'invalid');
      return;
    }
    if (MaweJklPlayback.jklReversePlaying) {
      MaweJklPlayback.stopJklReversePlayback();
      return;
    }
    if (MaweJklPlayback.isJklDirectionMode() && MaweJklPlayback.jklPlaybackRate < 0) {
      MaweJklPlayback.startJklReversePlayback();
      return;
    }
    if (MaweCoreState.player.paused) {
      if (MaweJklPlayback.isJklDirectionMode()) MaweCoreState.player.playbackRate = Math.max(0.0625, Math.abs(MaweJklPlayback.jklPlaybackRate));
      const promise = MaweCoreState.player.play();
      if (promise && promise.catch) promise.catch(() => {});
    } else {
      MaweCoreState.player.pause();
    }
    syncMediaControls();
  }



  function hasLoadedMedia() {
    return Boolean(
      MaweCoreState.player.currentSrc
      || MaweCoreState.player.getAttribute('src')
      || MaweCoreState.player.querySelector('source')?.getAttribute('src'),
    );
  }



  function formatMediaTime(seconds) {
    if (timelineIsFrameMode()) {
      return formatTimelineTimecode(
        (Number(seconds) || 0) * 1000,
        projectTimebase().fps,
        MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
      );
    }
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remaining = total % 60;
    const pad = (value) => String(value).padStart(2, '0');
    return hours ? `${hours}:${pad(minutes)}:${pad(remaining)}` : `${pad(minutes)}:${pad(remaining)}`;
  }



  function mediaSeekStepLabel(value = timelineMediaSeekStepValue()) {
    return timelineIsFrameMode() ? `${value}F` : `${value}ms`;
  }



  function refreshMediaSeekStepHelp() {
    if (MaweDom.helpMediaSeekStep) MaweDom.helpMediaSeekStep.textContent = mediaSeekStepLabel();
  }



  function refreshMediaSeekControlLabels() {
    const value = timelineMediaSeekStepValue();
    const unit = timelineIsFrameMode() ? 'F' : 'ms';
    const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
    const backLabel = language === 'en' ? `Back ${value}${unit}` : `后退 ${value}${unit}`;
    const forwardLabel = language === 'en' ? `Forward ${value}${unit}` : `前进 ${value}${unit}`;
    if (MaweDom.mediaStepBack) {
      MaweDom.mediaStepBack.setAttribute('aria-label', backLabel);
      MaweDom.mediaStepBack.title = backLabel;
    }
    if (MaweDom.mediaStepForward) {
      MaweDom.mediaStepForward.setAttribute('aria-label', forwardLabel);
      MaweDom.mediaStepForward.title = forwardLabel;
    }
  }



  function syncPlaybackRateOption(rate) {
    if (!MaweDom.mediaPlaybackRate || !Number.isFinite(rate)) return;
    MaweDom.mediaPlaybackRate.querySelectorAll('option[data-generated="true"]').forEach((option) => option.remove());
    const value = String(rate);
    let option = Array.from(MaweDom.mediaPlaybackRate.options).find((item) => item.value === value);
    if (!option) {
      option = document.createElement('option');
      option.value = value;
      option.textContent = MaweShortcuts.fmtRate(rate);
      option.dataset.generated = 'true';
      MaweDom.mediaPlaybackRate.append(option);
    }
    MaweDom.mediaPlaybackRate.value = value;
  }



  function syncMediaControls() {
    MaweDom.playerWrap?.classList.toggle('fullscreen-preview', document.fullscreenElement === MaweDom.playerWrap);
    refreshMediaSeekControlLabels();
    if (!MaweDom.mediaPlayToggle || !MaweCoreState.player) return;
    const hasMedia = hasLoadedMedia();
    const duration = Number.isFinite(MaweCoreState.player.duration) && MaweCoreState.player.duration > 0 ? MaweCoreState.player.duration : 0;
    const current = Number.isFinite(MaweCoreState.player.currentTime) ? Math.max(0, MaweCoreState.player.currentTime) : 0;
    const active = hasMedia && (MaweJklPlayback.jklReversePlaying || !MaweCoreState.player.paused);
    MaweDom.mediaPlayToggle.disabled = !hasMedia;
    MaweDom.mediaStepBack.disabled = !hasMedia;
    MaweDom.mediaStepForward.disabled = !hasMedia;
    MaweDom.mediaSeek.disabled = !hasMedia || !duration;
    MaweDom.mediaVolume.disabled = !hasMedia;
    MaweDom.mediaPlaybackRate.disabled = !hasMedia;
    MaweDom.mediaFullscreen.disabled = !hasMedia || typeof MaweDom.playerWrap?.requestFullscreen !== 'function';
    MaweDom.mediaPlayToggle.textContent = active ? '⏸' : '▶';
    const playbackLabel = active ? '暂停' : '播放';
    MaweDom.mediaPlayToggle.setAttribute('aria-label', playbackLabel);
    MaweDom.mediaPlayToggle.title = playbackLabel;
    MaweDom.mediaCurrentTime.textContent = formatMediaTime(current);
    MaweDom.mediaDuration.textContent = formatMediaTime(duration);
    MaweDom.mediaSeek.max = String(duration);
    MaweDom.mediaSeek.value = String(duration ? Math.min(duration, current) : 0);
    if (Number.isFinite(MaweCoreState.player.volume)) MaweDom.mediaVolume.value = String(MaweCoreState.player.volume);
    if (Number.isFinite(MaweCoreState.player.playbackRate)) {
      const displayedRate = MaweJklPlayback.isJklDirectionMode() && MaweJklPlayback.jklPlaybackRate < 0
        ? MaweJklPlayback.jklPlaybackRate
        : MaweCoreState.player.playbackRate;
      syncPlaybackRateOption(displayedRate);
    }
    const fullscreenLabel = document.fullscreenElement ? '退出全屏' : '全屏';
    MaweDom.mediaFullscreen.setAttribute('aria-label', fullscreenLabel);
    MaweDom.mediaFullscreen.title = fullscreenLabel;
  }



  function stopPlaybackRefresh(mediaElement = null) {
    if (mediaElement && MaweCoreState.playbackFramePlayer && MaweCoreState.playbackFramePlayer !== mediaElement) return;
    if (MaweCoreState.playbackFrameId) cancelAnimationFrame(MaweCoreState.playbackFrameId);
    MaweCoreState.playbackFrameId = 0;
    MaweCoreState.playbackFramePlayer = null;
  }



  function startPlaybackRefresh(mediaElement) {
    if (!mediaElement || mediaElement !== MaweCoreState.player || mediaElement.paused || mediaElement.ended) return;
    if (MaweCoreState.playbackFramePlayer !== mediaElement) {
      stopPlaybackRefresh();
      MaweCoreState.playbackFramePlayer = mediaElement;
    }
    if (MaweCoreState.playbackFrameId) return;
    const refresh = () => {
      MaweCoreState.playbackFrameId = 0;
      if (MaweCoreState.playbackFramePlayer !== mediaElement || MaweCoreState.player !== mediaElement
          || mediaElement.paused || mediaElement.ended) {
        if (MaweCoreState.playbackFramePlayer === mediaElement) MaweCoreState.playbackFramePlayer = null;
        if (MaweCoreState.player === mediaElement) {
          MawePlaybackLoop.update();
          MaweCoreState.waveformEditor?.updatePlayback();
        }
        return;
      }
      // 播放中只更新当前字幕/预览和波形播放头；不重绘波形画布、不重建字幕列表。
      MawePlaybackLoop.updatePlaybackFrame();
      MaweCoreState.playbackFrameId = requestAnimationFrame(refresh);
    };
    MaweCoreState.playbackFrameId = requestAnimationFrame(refresh);
  }



  function bindPlayerEvents(mediaElement) {
    if (!mediaElement) return;
    mediaElement.addEventListener('timeupdate', MawePlaybackLoop.update);
    mediaElement.addEventListener('seeked', MawePlaybackLoop.update);
    mediaElement.addEventListener('loadedmetadata', () => {
      MaweTextCleanup.notifyAutoLoadedMediaReady(mediaElement);
      MaweTextCleanup.flushPendingMediaSeek(mediaElement);
    });
    mediaElement.addEventListener('canplay', () => MaweTextCleanup.flushPendingMediaSeek(mediaElement));
    mediaElement.addEventListener('progress', () => MaweTextCleanup.flushPendingMediaSeek(mediaElement));
    mediaElement.addEventListener('play', () => startPlaybackRefresh(mediaElement));
    mediaElement.addEventListener('playing', () => startPlaybackRefresh(mediaElement));
    mediaElement.addEventListener('pause', () => {
      stopPlaybackRefresh(mediaElement);
      if (MaweCoreState.player !== mediaElement) return;
      MawePlaybackLoop.update();
      MaweCoreState.waveformEditor?.updatePlayback();
    });
    mediaElement.addEventListener('ended', () => {
      stopPlaybackRefresh(mediaElement);
      if (MaweCoreState.player !== mediaElement) return;
      MawePlaybackLoop.update();
      MaweCoreState.waveformEditor?.updatePlayback();
    });
    mediaElement.addEventListener('emptied', () => stopPlaybackRefresh(mediaElement));
    if (mediaElement.tagName === 'VIDEO') {
      mediaElement.addEventListener('click', (event) => {
        if (event.defaultPrevented) return;
        togglePlayback();
      });
    }
    ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'playing', 'pause', 'ended', 'volumechange', 'ratechange', 'emptied']
      .forEach((eventName) => mediaElement.addEventListener(eventName, syncMediaControls));
    if (mediaElement.readyState >= 1) {
      queueMicrotask(() => {
        MaweTextCleanup.notifyAutoLoadedMediaReady(mediaElement);
        MaweTextCleanup.flushPendingMediaSeek(mediaElement);
      });
    }
    syncMediaControls();
  }



  function seekMediaBy(deltaSeconds) {
    if (!hasLoadedMedia()) return;
    const duration = Number.isFinite(MaweCoreState.player.duration) ? MaweCoreState.player.duration : Infinity;
    MaweCoreState.player.currentTime = Math.max(0, Math.min(duration, MaweCoreState.player.currentTime + deltaSeconds));
    MawePlaybackLoop.update();
    syncMediaControls();
  }



  function seekMediaTo(timeSeconds) {
    if (!hasLoadedMedia()) return false;
    const duration = Number.isFinite(MaweCoreState.player.duration) && MaweCoreState.player.duration > 0
      ? MaweCoreState.player.duration : null;
    if (!Number.isFinite(duration)) return false;
    MaweJklPlayback.stopJklReversePlayback({ render: false });
    const targetSeconds = Math.max(0, Math.min(duration, Number(timeSeconds) || 0));
    MaweCoreState.player.currentTime = targetSeconds;
    MawePlaybackLoop.update();
    MaweCoreState.waveformEditor?.revealTime(targetSeconds * 1000, true);
    MaweCoreState.waveformEditor?.updatePlayback();
    syncMediaControls();
    return true;
  }

  global.MaweMediaPlayback = Object.freeze({
    syncPlayerPlaceholder,
    togglePlayback,
    hasLoadedMedia,
    formatMediaTime,
    mediaSeekStepLabel,
    refreshMediaSeekStepHelp,
    refreshMediaSeekControlLabels,
    syncPlaybackRateOption,
    syncMediaControls,
    stopPlaybackRefresh,
    startPlaybackRefresh,
    bindPlayerEvents,
    seekMediaBy,
    seekMediaTo
  });
})(typeof window !== 'undefined' ? window : globalThis);

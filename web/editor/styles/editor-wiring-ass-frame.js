// Paused Server video previews use the same native libass frame as the floating
// comparison window. Playback/file:// keep the immediate CSS approximation.
(function initMaweAssFrame(global) {
  'use strict';

  const openButton = document.getElementById('ass-frame-preview-open');
  const windowEl = document.getElementById('ass-frame-window');
  if (!openButton || !windowEl) return;
  const imageEl = document.getElementById('ass-frame-image');
  const stageImage = document.getElementById('ass-stage-frame');
  const stageStatus = document.getElementById('ass-stage-status');
  const stage = global.MaweDom?.playerStage;
  const player = global.MaweCoreState?.player;
  const renderButton = document.getElementById('ass-frame-render');
  const windowStatus = document.getElementById('ass-frame-window-status');
  const staleEl = document.getElementById('ass-frame-stale');
  const stageToggle = document.getElementById('ass-frame-stage-toggle');
  const autoToggle = document.getElementById('ass-frame-auto-toggle');
  let timer = 0;
  let pending = false;
  let desired = null;
  let cached = null;
  let failedKey = '';
  let failureMessage = '';
  let mediaGeneration = 0;
  let seekGeneration = 0;
  let capabilityFailure = '';
  let presentedTime = null;
  let presentedCursor = null;
  const REQUEST_TIMEOUT_MS = 165000;

  const translate = (text) => global.MAWE_I18N?.translateText?.(text) || text;
  const enabled = () => Boolean(global.MaweBoot?.SERVER_CONFIG?.assFrameUrl)
    && global.MaweSettings?.EDITOR_SETTINGS?.assMode === true;
  // 暂停时把实际帧叠加到播放器画面：默认关闭，窗口内开关控制。
  const stageOverlayEnabled = () => global.MaweSettings?.EDITOR_SETTINGS?.assFrameStagePreview === true;
  // 自动渲染：默认开启；关闭后仅在点击「渲染当前帧」时更新。
  const autoRenderEnabled = () => global.MaweSettings?.EDITOR_SETTINGS?.assFrameAutoRender !== false;

  function boundVideo() {
    // A browser-only blob upload can differ from the server's bound project.
    // Never replace it with a frame from an unrelated server media file.
    if (player?.tagName !== 'VIDEO' || !player.videoWidth) return false;
    const url = new URL(player.currentSrc || player.src || global.location.href, global.location.href);
    return url.origin === global.location.origin && url.pathname === '/media';
  }

  function setWindowStatus(text, state = '') {
    if (!windowStatus) return;
    windowStatus.textContent = text ? translate(text) : '';
    windowStatus.dataset.state = state;
  }

  function setStageStatus(text, detail = '') {
    if (!stageStatus) return;
    stageStatus.textContent = translate(text);
    stageStatus.title = detail || translate(text);
    stageStatus.hidden = !text;
  }

  function hideStage() {
    if (stageImage) stageImage.hidden = true;
    stage?.classList.remove('ass-stage-ready');
  }

  function snapshot() {
    if (!enabled() || !boundVideo()) return null;
    // currentTime can sit between two frames. Seek at/before the presented
    // frame's PTS; rounding up can make FFmpeg discard it and choose the next.
    const frameTimeMs = Math.max(0, (presentedTime ?? (Number(player.currentTime) || 0)) * 1000);
    const timeMs = Math.floor(frameTimeMs + 0.000001);
    const ass = global.MaweExportSrt.buildAss({ preview: true });
    return { ass, timeMs, frameTimeMs, generation: mediaGeneration, seek: seekGeneration, source: player.currentSrc,
      key: JSON.stringify([mediaGeneration, player.currentSrc, ass, timeMs]) };
  }

  function frameClock(ms) {
    const safe = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(safe / 3600000);
    const minutes = Math.floor((safe % 3600000) / 60000);
    const seconds = Math.floor((safe % 60000) / 1000);
    const millis = safe % 1000;
    return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  function showWindowFrame(frame) {
    if (imageEl) {
      if (imageEl.getAttribute('src') !== frame.url) imageEl.src = frame.url;
      imageEl.hidden = false;
    }
    const placeholder = document.getElementById('ass-frame-placeholder');
    if (placeholder) placeholder.hidden = true;
    const caption = document.getElementById('ass-frame-caption');
    if (caption) {
      caption.textContent = `${frameClock(frame.timeMs)} · ${frame.width} × ${frame.height} · ${translate('无损 PNG')}`;
      caption.hidden = false;
    }
    const warnings = document.getElementById('ass-frame-warnings');
    if (warnings) {
      warnings.textContent = frame.warnings.join('\n');
      warnings.hidden = !frame.warnings.length;
    }
    setWindowStatus('渲染完成', 'success');
  }

  function showStageFrame(frame) {
    if (!stageOverlayEnabled()) return;
    if (!stageImage || !desired || frame.key !== desired.key || !player.paused || player.seeking) return;
    if (stageImage.getAttribute('src') !== frame.url) stageImage.src = frame.url;
    stageImage.dataset.timeMs = String(frame.timeMs);
    stageImage.hidden = false;
    stage?.classList.add('ass-stage-ready');
    setStageStatus(frame.warnings.length ? 'ASS 实际画面 · 字体警告' : 'ASS 实际画面', frame.warnings.join('\n'));
  }

  function syncStaleOverlay() {
    if (!staleEl) return;
    staleEl.hidden = !cached || !floatingPanel.isOpen() || (player?.paused === true && !player?.seeking
      && cached?.key === desired?.key);
    const label = staleEl.querySelector('span');
    if (label) label.textContent = translate(player?.paused === true ? '画面已过期' : '暂停后重新渲染');
  }

  function syncPreview() {
    if (!enabled() || !boundVideo()) {
      desired = null;
      hideStage();
      setStageStatus('');
      global.clearTimeout(timer);
      timer = 0;
      syncStaleOverlay();
      return;
    }
    if (!player.paused || player.seeking) {
      desired = null;
      hideStage();
      setStageStatus(stageOverlayEnabled() ? 'ASS 即时预览' : '');
      global.clearTimeout(timer);
      timer = 0;
      syncStaleOverlay();
      return;
    }
    // Typing can refresh the preview on every keystroke. Debounce building the
    // complete ASS too, not just the HTTP request, so long projects stay usable.
    desired = null;
    hideStage();
    syncStaleOverlay();
    // 自动渲染关闭：保留最近一次手动帧，等「渲染当前帧」或状态变化再更新。
    if (!autoRenderEnabled()) {
      setStageStatus('');
      return;
    }
    if (stageOverlayEnabled()) {
      setStageStatus(capabilityFailure ? 'ASS 即时预览 · 实际渲染不可用' : 'ASS 实际画面渲染中…', failureMessage);
    }
    global.clearTimeout(timer);
    timer = global.setTimeout(() => { timer = 0; refreshDesired(); }, 200);
  }

  function refreshDesired() {
    if (!enabled() || !boundVideo() || !player.paused || player.seeking) return;
    if (!autoRenderEnabled()) return;
    if (capabilityFailure) {
      hideStage();
      setStageStatus(stageOverlayEnabled() ? 'ASS 即时预览 · 实际渲染不可用' : '', failureMessage);
      return;
    }
    desired = snapshot();
    syncStaleOverlay();
    if (cached?.key === desired?.key) {
      showStageFrame(cached);
      return;
    }
    hideStage();
    if (desired?.key === failedKey) {
      setStageStatus(stageOverlayEnabled() ? 'ASS 即时预览 · 实际渲染不可用' : '', failureMessage);
      return;
    }
    if (stageOverlayEnabled()) setStageStatus('ASS 实际画面渲染中…');
    // One request at a time. Changes during rendering are coalesced and retried
    // in finally; old responses never replace the new playback/style state.
    if (desired && !pending) void capture(desired);
  }

  async function capture(request, manual = false) {
    if (pending) return;
    pending = true;
    if (renderButton) renderButton.disabled = true;
    setWindowStatus('正在渲染当前帧…', 'pending');
    const controller = new AbortController();
    const timeout = global.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(global.MaweBoot.SERVER_CONFIG.assFrameUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ requestToken: global.MaweBoot.SERVER_CONFIG.requestToken || '',
          ass: request.ass, timeMs: request.timeMs }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        if (['ASS_FRAME_LIBASS_UNAVAILABLE', 'ASS_FRAME_FFMPEG_MISSING'].includes(payload?.code)) {
          capabilityFailure = payload.code;
        }
        throw new Error(String(payload?.error || `HTTP ${response.status}`));
      }
      const url = `data:image/png;base64,${payload.image}`;
      const decoded = new Image();
      decoded.src = url;
      // 个别内核的 decode() 可能悬挂，且不受 abort 信号保护；限时竞争，
      // 超时也照常出图（<img> 自身会继续加载），绝不让 pending 卡死。
      await Promise.race([
        decoded.decode().catch(() => {}),
        new Promise((resolve) => global.setTimeout(resolve, 5000)),
      ]);
      const frame = { key: request.key, url, timeMs: request.frameTimeMs,
        width: decoded.naturalWidth, height: decoded.naturalHeight,
        warnings: Array.isArray(payload.warnings) ? payload.warnings.filter(Boolean) : [] };
      // Check live state after await, including edits and seeks during decode.
      const live = snapshot();
      const current = live?.key === request.key;
      // A manual capture freezes the clicked frame in the comparison window
      // even if playback advances, while media/style changes still invalidate it.
      const manualFrame = manual && live?.generation === request.generation
        && live?.seek === request.seek && live?.source === request.source && live?.ass === request.ass;
      if (current || manualFrame) {
        cached = frame;
        failedKey = '';
        failureMessage = '';
        desired = live;
        showWindowFrame(frame);
        showStageFrame(frame);
      }
    } catch (error) {
      failureMessage = controller.signal.aborted ? translate('实际画面请求超时；可点击渲染当前帧重试。')
        : `渲染失败：${error instanceof Error ? error.message : error}`;
      failedKey = request.key;
      setWindowStatus(failureMessage, 'error');
      if (manual) global.MaweHint?.flashHint?.(failureMessage, 'invalid');
    } finally {
      global.clearTimeout(timeout);
      pending = false;
      if (renderButton) renderButton.disabled = false;
      // Don't hide a successfully decoded, current frame again just to queue a
      // redundant refresh. Read latest state once to drain edits made in flight.
      // 手动模式下不自动补渲染，只刷新过期标记。
      if (autoRenderEnabled()) refreshDesired();
      else syncStaleOverlay();
    }
  }

  async function renderAssFrame() {
    const request = snapshot();
    if (!request) {
      setWindowStatus('请先加载 Server 工程的视频并启用 ASS 字幕模式。', 'error');
      return;
    }
    global.clearTimeout(timer);
    timer = 0;
    failedKey = '';
    capabilityFailure = '';
    await capture(request, true);
  }

  const floatingPanel = global.MaweFloatingPanel.createFloatingPanel({
    panel: windowEl,
    dragHandle: document.getElementById('ass-frame-drag-handle'),
    manageButton: openButton,
    anchorButton: openButton,
    positionKey: 'moy.asr.ass_frame.window.v1',
    onOpen: () => {
      syncPreview();
      const request = snapshot();
      if (cached && request && cached.key === request.key) showWindowFrame(cached);
      else if (autoRenderEnabled()) void renderAssFrame();
      else if (cached) showWindowFrame(cached);
      syncStaleOverlay();
    },
  });

  function syncAssFrameControls() {
    openButton.hidden = !enabled();
    if (openButton.hidden && floatingPanel.isOpen()) floatingPanel.close();
    // 自动渲染开启时「渲染当前帧」没有意义，隐藏；关闭后作为手动更新入口显示。
    if (renderButton) renderButton.hidden = autoRenderEnabled();
    if (stageToggle) stageToggle.checked = stageOverlayEnabled();
    if (autoToggle) autoToggle.checked = autoRenderEnabled();
    syncPreview();
  }

  player?.addEventListener('play', syncPreview);
  player?.addEventListener('pause', syncPreview);
  player?.addEventListener('seeking', () => {
    seekGeneration += 1;
    // Some browsers deliver the new frame callback before the queued seeking
    // event. Keep that new PTS rather than clearing it with the old one.
    if (presentedCursor !== player.currentTime) presentedTime = null;
    syncPreview();
  });
  player?.addEventListener('seeked', syncPreview);
  player?.addEventListener('loadedmetadata', syncPreview);
  player?.addEventListener('emptied', () => {
    mediaGeneration += 1;
    presentedTime = null;
    presentedCursor = null;
    cached = null;
    desired = null;
    failedKey = '';
    failureMessage = '';
    if (imageEl) { imageEl.hidden = true; imageEl.removeAttribute('src'); }
    if (stageImage) stageImage.removeAttribute('src');
    for (const id of ['ass-frame-caption', 'ass-frame-warnings']) {
      const element = document.getElementById(id);
      if (element) element.hidden = true;
    }
    const placeholder = document.getElementById('ass-frame-placeholder');
    if (placeholder) placeholder.hidden = false;
    setWindowStatus('');
    syncPreview();
  });
  if (typeof player?.requestVideoFrameCallback === 'function') {
    const onFrame = (now, metadata) => {
      if (Number.isFinite(metadata.mediaTime)) {
        presentedTime = metadata.mediaTime;
        presentedCursor = player.currentTime;
      }
      if (player.paused && !player.seeking) syncPreview();
      player.requestVideoFrameCallback(onFrame);
    };
    player.requestVideoFrameCallback(onFrame);
  }
  renderButton?.addEventListener('click', () => void renderAssFrame());
  for (const id of ['ass-frame-window-close', 'ass-frame-close-footer']) {
    document.getElementById(id)?.addEventListener('click', () => floatingPanel.close());
  }
  document.getElementById('ass-mode-toggle')?.addEventListener('change', syncAssFrameControls);
  stageToggle?.addEventListener('change', () => {
    global.MaweSettings?.updateEditorSettings({ assFrameStagePreview: stageToggle.checked });
    syncAssFrameControls();
  });
  autoToggle?.addEventListener('change', () => {
    global.MaweSettings?.updateEditorSettings({ assFrameAutoRender: autoToggle.checked });
    syncAssFrameControls();
  });
  document.getElementById('ass-frame-size')?.addEventListener('click', (event) => {
    const native = document.querySelector('.ass-frame-image-wrap')?.classList.toggle('ass-frame-native');
    event.currentTarget.setAttribute('aria-pressed', String(Boolean(native)));
  });

  global.MaweAssFrame = Object.freeze({ syncAssFrameControls, renderAssFrame, syncPreview });
  syncAssFrameControls();
})(typeof window !== 'undefined' ? window : globalThis);

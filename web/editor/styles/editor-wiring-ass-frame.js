// Paused Server media previews use the same native libass frame as the floating
// comparison window. Playback/file:// keep the immediate CSS approximation.
(function initMaweAssFrame(global) {
  'use strict';

  const openButton = document.getElementById('ass-frame-preview-open');
  const quickOpenButton = document.getElementById('ass-frame-quick-open');
  const styleOpenButton = document.getElementById('ass-style-frame-preview-open');
  const windowEl = document.getElementById('ass-frame-window');
  if (!openButton || !windowEl) return;
  const imageEl = document.getElementById('ass-frame-image');
  const stageImage = document.getElementById('ass-stage-frame');
  const stageStatus = document.getElementById('ass-stage-status');
  const stage = global.MaweDom?.playerStage;
  // player 元素会被媒体加载整体替换（editor-media-load.js 的 replaceChild），
  // 这里只保留可变引用；事件与帧回调的换绑见下方 bindPlayer()。
  let player = global.MaweCoreState?.player;
  const renderButton = document.getElementById('ass-frame-render');
  const windowStatus = document.getElementById('ass-frame-window-status');
  const staleEl = document.getElementById('ass-frame-stale');
  const stageToggle = document.getElementById('ass-frame-stage-toggle');
  const autoToggle = document.getElementById('ass-frame-auto-toggle');
  // 实际画面窗口的表情包图层（模板默认存在；缺失时整组逻辑静默跳过）。
  const stickerLayer = document.getElementById('ass-frame-sticker-layer');
  const stickerGeometry = document.getElementById('ass-frame-sticker-geometry');
  const stickerContent = stickerLayer ? stickerLayer.querySelector('.sticker-overlay-content') : null;
  let windowStickerSignature = null;
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
  const GREEN_SCREEN_HINT = '当前缺少视频画面，使用绿幕预览，可在「更多导出」中导出绿幕视频';

  const translate = (text) => global.MAWE_I18N?.translateText?.(text) || text;
  const enabled = () => Boolean(global.MaweBoot?.SERVER_CONFIG?.assFrameUrl)
    && global.MaweSettings?.EDITOR_SETTINGS?.assMode === true;
  // 暂停时把实际帧叠加到播放器画面：默认关闭，窗口内开关控制。
  const stageOverlayEnabled = () => autoRenderEnabled()
    && global.MaweSettings?.EDITOR_SETTINGS?.assFrameStagePreview === true;
  // 自动渲染：默认开启；关闭后仅在点击「渲染当前帧」时更新。
  const autoRenderEnabled = () => global.MaweSettings?.EDITOR_SETTINGS?.assFrameAutoRender !== false;
  // Avoid serializing the project or spawning FFmpeg when neither view needs it.
  const previewNeeded = () => floatingPanel.isOpen() || stageOverlayEnabled();

  function serverMediaSource() {
    const url = new URL(player?.currentSrc || player?.src || global.location.href, global.location.href);
    return url.origin === global.location.origin && url.pathname === '/media';
  }

  function boundVideo() {
    // A browser-only blob upload can differ from the server's bound project.
    // Never replace it with a frame from an unrelated server media file.
    if (player?.tagName !== 'VIDEO' || !player.videoWidth) return false;
    return serverMediaSource();
  }

  // 绿幕只服务「未加载媒体」或「服务器绑定媒体本身没有视频轨」（纯音频工程、
  // 空白工程）。浏览器本地加载的媒体（blob: 等）与服务器工程无关，按上方
  // boundVideo 的约定不能为它渲染实际画面，也不能退回绿幕。
  const greenScreenPreview = () => player?.tagName !== 'VIDEO'
    || (!player.videoWidth && (!(player.currentSrc || player.src) || serverMediaSource()));
  const frameAvailable = () => boundVideo() || greenScreenPreview();

  function setWindowStatus(text, state = '') {
    if (!windowStatus) return;
    windowStatus.textContent = text ? translate(text) : '';
    windowStatus.dataset.state = state;
    windowStatus.classList.toggle('ass-frame-green-screen-hint', text === GREEN_SCREEN_HINT);
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
    if (!enabled() || !frameAvailable()) return null;
    const greenScreen = greenScreenPreview();
    // currentTime can sit between two frames. Seek at/before the presented
    // frame's PTS; rounding up can make FFmpeg discard it and choose the next.
    // currentTime 的赋值早于 seeking 事件；尚未收到新帧回调时，
    // 旧 PTS 不能被当成新播放位置的帧时间。
    const frameTime = presentedCursor === player.currentTime ? presentedTime : null;
    const frameTimeMs = Math.max(0, (frameTime ?? (Number(player.currentTime) || 0)) * 1000);
    const timeMs = Math.floor(frameTimeMs + 0.000001);
    const ass = global.MaweExportSrt.buildAss({ preview: true });
    return { ass, timeMs, frameTimeMs, greenScreen, generation: mediaGeneration, seek: seekGeneration, source: player.currentSrc,
      key: JSON.stringify([mediaGeneration, player.currentSrc, greenScreen, ass, timeMs]) };
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
    syncWindowStickers();
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
    setWindowStatus(frame.greenScreen ? GREEN_SCREEN_HINT : '渲染完成', frame.greenScreen ? '' : 'success');
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


  // === 表情包图层（窗口内）===
  // 让实际画面 = 完整成片效果：按帧时间显示表情包，几何与 contain 显示语义
  // 与播放器舞台的 #sticker-overlay-layer 完全一致（同一 activeStickersAt 区间、
  // 同一 preview.sticker 归一化几何），叠在实际帧 PNG 上方——与舞台暂停视图
  // 的叠放次序相同（表情包层本来就是舞台里压在实际帧之上的独立图层；素材与
  // 字幕位置不相交）。显隐跟随「预览表情包」开关（MaweStickerBurnPlan.
  // stickerBurnEnabled，与烧录行为同源），素材 URL 失败时 <img> 自然空显示，
  // 不阻塞出帧。
  function positionWindowStickerLayer() {
    if (!stickerLayer || !stickerGeometry || !imageEl.naturalWidth || !imageEl.naturalHeight) return;
    // PNG 以 object-fit: contain 显示：层的定位框必须是实际绘制矩形，
    // 归一化几何才能与舞台预览逐像素对应。原尺寸查看模式下图片盒就是
    // 自然尺寸，结果不变。
    const wrap = imageEl.parentElement;
    const wrapRect = wrap.getBoundingClientRect();
    const imageRect = imageEl.getBoundingClientRect();
    const scale = Math.min(imageRect.width / imageEl.naturalWidth, imageRect.height / imageEl.naturalHeight);
    const width = imageEl.naturalWidth * scale;
    const height = imageEl.naturalHeight * scale;
    // Absolute coordinates belong to the scrollable padding box, not its viewport.
    stickerLayer.style.left = `${imageRect.left - wrapRect.left - wrap.clientLeft + wrap.scrollLeft + (imageRect.width - width) / 2}px`;
    stickerLayer.style.top = `${imageRect.top - wrapRect.top - wrap.clientTop + wrap.scrollTop + (imageRect.height - height) / 2}px`;
    stickerLayer.style.width = `${width}px`;
    stickerLayer.style.height = `${height}px`;
    // 与舞台层同一几何换算（GEO_UTILS.previewGeometryToCss：钳制 + 百分比）。
    const css = global.MaweAppearance?.GEO_UTILS?.previewGeometryToCss
      ? global.MaweAppearance.GEO_UTILS.previewGeometryToCss(global.MawePreviewGeometry.getStickerGeometry())
      : null;
    if (css) {
      stickerGeometry.style.left = css.left;
      stickerGeometry.style.top = css.top;
      stickerGeometry.style.width = css.width;
      stickerGeometry.style.height = css.height;
    }
  }

  function syncWindowStickers() {
    if (!stickerLayer || !stickerGeometry || !stickerContent) return;
    const enabled = Boolean(global.MaweStickerBurnPlan?.stickerBurnEnabled?.());
    const stickers = enabled && cached && !imageEl.hidden
      ? (global.MaweStickerOverlay?.activeStickersAt(cached.timeMs) || []) : [];
    if (!enabled || !stickers.length) {
      windowStickerSignature = null;
      if (!stickerLayer.hidden || stickerContent.childElementCount) {
        stickerContent.classList.remove('has-overlay-sticker');
        stickerContent.replaceChildren();
        stickerLayer.hidden = true;
      }
      return;
    }
    positionWindowStickerLayer();
    // Include the asset revision carried by stickerUrl when a directory changes.
    const overlayActive = Boolean(global.MaweStickerOverlay?.activeStickerHasOverlay);
    const signature = `${overlayActive ? 'O' : ''}\u0001${
      stickers.map((sticker) => global.MaweSelection.stickerUrl(sticker)).join('\u0001')}`;
    if (windowStickerSignature !== signature) {
      stickerContent.classList.toggle('has-overlay-sticker', overlayActive);
      stickerContent.replaceChildren(...stickers.map((sticker) => {
        const img = document.createElement('img');
        img.src = global.MaweSelection.stickerUrl(sticker);
        img.alt = sticker.name;
        img.title = sticker.name;
        return img;
      }));
      windowStickerSignature = signature;
    }
    stickerLayer.hidden = false;
  }

  // The first PNG can finish loading after showWindowFrame measured its box.
  imageEl?.addEventListener('load', positionWindowStickerLayer);
  // 面板尺寸变化会改变 PNG 的绘制矩形，跟随 wrap 的尺寸变化。
  if (stickerLayer && typeof global.ResizeObserver === 'function') {
    new global.ResizeObserver(() => {
      if (!stickerLayer.hidden) positionWindowStickerLayer();
    }).observe(imageEl.parentElement);
  }

  function syncPreview() {
    if (!enabled() || !previewNeeded() || !frameAvailable()) {
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
    // Keep the last checked manual snapshot until the debounced comparison,
    // so repeated UI refreshes don't flash the stale mask over a current frame.
    if (autoRenderEnabled()) desired = null;
    hideStage();
    syncStaleOverlay();
    // 自动渲染关闭：保留最近一次手动帧，等「渲染当前帧」或状态变化再更新。
    if (!autoRenderEnabled()) {
      setStageStatus('');
    }
    if (stageOverlayEnabled()) {
      setStageStatus(capabilityFailure ? 'ASS 即时预览 · 实际渲染不可用' : 'ASS 实际画面渲染中…', failureMessage);
    }
    // 合并这段时间内的最新状态，但不反复推迟截止时间。连续刷新
    // （例如列表/播放头更新）也必须让自动渲染获得执行机会。
    if (!timer) timer = global.setTimeout(() => { timer = 0; refreshDesired(); }, 200);
  }

  function refreshDesired() {
    if (!enabled() || !previewNeeded() || !frameAvailable() || !player.paused || player.seeking) return;
    if (autoRenderEnabled() && capabilityFailure) {
      hideStage();
      setStageStatus(stageOverlayEnabled() ? 'ASS 即时预览 · 实际渲染不可用' : '', failureMessage);
      return;
    }
    desired = snapshot();
    syncStaleOverlay();
    // Manual frames still need freshness checks after UI-only refreshes. A
    // matching snapshot reuses the frame; actual edits mark it stale without
    // requesting a replacement until the user clicks Render.
    if (!autoRenderEnabled()) return;
    if (cached?.key === desired?.key) {
      showWindowFrame(cached);
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
          ass: request.ass, timeMs: request.timeMs, greenScreen: request.greenScreen }),
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
        greenScreen: payload.greenScreen === true,
        width: decoded.naturalWidth, height: decoded.naturalHeight,
        warnings: Array.isArray(payload.warnings) ? [...new Set(payload.warnings.filter(Boolean))] : [] };
      // Check live state after await, including edits and seeks during decode.
      const live = snapshot();
      const current = live?.key === request.key;
      // A manual capture freezes the clicked frame in the comparison window
      // even if playback advances, while media/style changes still invalidate it.
      const manualFrame = manual && live?.generation === request.generation
        && live?.seek === request.seek && live?.source === request.source && live?.ass === request.ass
        && live?.greenScreen === request.greenScreen;
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
      setWindowStatus('请启用 ASS 字幕模式；浏览器本地视频请通过 Server 工程打开。', 'error');
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
    manageButton: quickOpenButton || openButton,
    anchorButton: quickOpenButton || openButton,
    positionKey: 'moy.asr.ass_frame.window.v1',
    onOpen: () => {
      if (greenScreenPreview()) setWindowStatus(GREEN_SCREEN_HINT);
      syncPreview();
      const request = snapshot();
      if (cached && request && cached.key === request.key) {
        desired = request;
        showWindowFrame(cached);
      }
      else if (autoRenderEnabled()) void renderAssFrame();
      else if (cached) showWindowFrame(cached);
      syncStaleOverlay();
    },
  });

  function syncAssFrameControls() {
    openButton.hidden = !enabled();
    if (quickOpenButton) quickOpenButton.hidden = !enabled();
    if (styleOpenButton) styleOpenButton.hidden = !enabled();
    if (openButton.hidden && floatingPanel.isOpen()) floatingPanel.close();
    // 自动渲染开启时「渲染当前帧」没有意义，隐藏；关闭后作为手动更新入口显示。
    if (renderButton) renderButton.hidden = autoRenderEnabled();
    if (stageToggle) {
      stageToggle.checked = global.MaweSettings?.EDITOR_SETTINGS?.assFrameStagePreview === true;
      stageToggle.closest('label').hidden = !autoRenderEnabled();
    }
    if (autoToggle) autoToggle.checked = autoRenderEnabled();
    syncPreview();
  }

  // 媒体变化（emptied，或 player 元素被整体替换）后，旧渲染结果全部作废。
  function resetRenderedFrames() {
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
    syncWindowStickers();
  }

  function onPlay() { syncPreview(); }

  function onPause() {
    // Playback's clock advances between frame callbacks. Once paused, its
    // final cursor still represents the last presented frame; keep that PTS
    // rather than falling back to the between-frame clock. A seek continues
    // to invalidate it until the browser presents the destination frame.
    if (!player.seeking) presentedCursor = player.currentTime;
    syncPreview();
  }

  function onSeeking() {
    seekGeneration += 1;
    // Some browsers deliver the new frame callback before the queued seeking
    // event. Keep that new PTS rather than clearing it with the old one.
    if (presentedCursor !== player.currentTime) presentedTime = null;
    syncPreview();
  }

  function onSeeked() { syncPreview(); }

  function onLoadedMetadata() { syncPreview(); }

  function onEmptied() {
    mediaGeneration += 1;
    resetRenderedFrames();
    syncPreview();
  }

  function attachPlayerEvents() {
    if (!player) return;
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('seeking', onSeeking);
    player.addEventListener('seeked', onSeeked);
    player.addEventListener('loadedmetadata', onLoadedMetadata);
    player.addEventListener('emptied', onEmptied);
    startFrameClock();
  }

  function detachPlayerEvents() {
    if (!player) return;
    player.removeEventListener('play', onPlay);
    player.removeEventListener('pause', onPause);
    player.removeEventListener('seeking', onSeeking);
    player.removeEventListener('seeked', onSeeked);
    player.removeEventListener('loadedmetadata', onLoadedMetadata);
    player.removeEventListener('emptied', onEmptied);
  }

  function startFrameClock() {
    if (typeof player?.requestVideoFrameCallback !== 'function') return;
    const element = player;
    const onFrame = (now, metadata) => {
      // 元素被替换后旧回调不再触发；循环只跟随注册时的元素。
      if (player !== element) return;
      if (Number.isFinite(metadata.mediaTime)) {
        presentedTime = metadata.mediaTime;
        presentedCursor = player.currentTime;
      }
      if (player.paused && !player.seeking) syncPreview();
      element.requestVideoFrameCallback(onFrame);
    };
    element.requestVideoFrameCallback(onFrame);
  }

  // 媒体加载会 replaceChild 换掉 player 元素并更新 MaweCoreState.player，
  // 再经 MaweMediaPlayback.bindPlayerEvents 通知本模块换绑；判定逻辑必须
  // 跟随新元素，否则浏览器本地媒体会被误判回服务器工程媒体。
  function bindPlayer(element) {
    if (!element || element === player) return;
    detachPlayerEvents();
    player = element;
    mediaGeneration += 1;
    resetRenderedFrames();
    attachPlayerEvents();
    syncAssFrameControls();
  }

  attachPlayerEvents();
  renderButton?.addEventListener('click', () => void renderAssFrame());
  if (quickOpenButton) openButton.addEventListener('click', () => floatingPanel.toggle());
  styleOpenButton?.addEventListener('click', () => floatingPanel.open());
  document.getElementById('ass-frame-window-close')?.addEventListener('click', () => floatingPanel.close());
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
    positionWindowStickerLayer();
  });

  global.MaweAssFrame = Object.freeze({ syncAssFrameControls, renderAssFrame, syncPreview, bindPlayer, syncWindowStickers });
  syncAssFrameControls();
})(typeof window !== 'undefined' ? window : globalThis);

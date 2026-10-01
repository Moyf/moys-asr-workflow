// ASS 单帧实际画面预览：把编辑器当前导出的完整 ASS 文本交给 server-editor，
// 用 FFmpeg (libass) 渲染播放头所在的一帧，作为 CSS 预览与最终烧录效果的对照。
// 仅 localhost Editor 提供（SERVER_CONFIG.assFrameUrl）；便携 file:// 模式没有
// 渲染入口，按钮保持隐藏。CSS 预览永远即时，这里只做按需的“实际画面”快照。
(function initMaweAssFrame(global) {
  'use strict';

  const ASS_FRAME_WINDOW_POSITION_KEY = 'moy.asr.ass_frame.window.v1';

  const openButton = document.getElementById('ass-frame-preview-open');
  const windowEl = document.getElementById('ass-frame-window');
  const dragHandle = document.getElementById('ass-frame-drag-handle');
  const windowClose = document.getElementById('ass-frame-window-close');
  const windowStatus = document.getElementById('ass-frame-window-status');
  const imageEl = document.getElementById('ass-frame-image');
  const placeholderEl = document.getElementById('ass-frame-placeholder');
  const captionEl = document.getElementById('ass-frame-caption');
  const warningsEl = document.getElementById('ass-frame-warnings');
  const staleEl = document.getElementById('ass-frame-stale');
  const renderButton = document.getElementById('ass-frame-render');
  const footerCloseButton = document.getElementById('ass-frame-close-footer');
  const assModeToggle = document.getElementById('ass-mode-toggle');

  if (!openButton || !windowEl) return;

  let renderPending = false;
  let pendingRenderTimer = 0;

  function translate(text) {
    return global.MAWE_I18N?.translateText?.(text) || text;
  }

  function assFrameServerAvailable() {
    return Boolean(global.MaweBoot?.SERVER_CONFIG?.assFrameUrl);
  }

  function setWindowStatus(text, state = '') {
    if (!windowStatus) return;
    windowStatus.textContent = text ? translate(text) : '';
    if (state) windowStatus.dataset.state = state;
    else delete windowStatus.dataset.state;
  }

  function syncAssFrameControls() {
    // 按钮只在「server 模式 + ASS 字幕模式开启」时出现；关闭 ASS 模式时
    // 连同预览窗一起收起，避免留下无法刷新的旧画面。
    openButton.hidden = !assFrameServerAvailable() || global.MaweSettings?.EDITOR_SETTINGS?.assMode !== true;
    if (openButton.hidden && floatingPanel.isOpen()) floatingPanel.close();
  }

  function formatFrameClock(ms) {
    const safe = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(safe / 3600000);
    const minutes = Math.floor((safe % 3600000) / 60000);
    const seconds = Math.floor((safe % 60000) / 1000);
    const millis = safe % 1000;
    const hh = hours ? `${String(hours).padStart(2, '0')}:` : '';
    return `${hh}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  function currentPlaybackMs() {
    const player = global.MaweCoreState?.player;
    return Math.max(0, Math.round((Number(player?.currentTime) || 0) * 1000));
  }

  function showAssFrameError(message) {
    setWindowStatus(message, 'error');
    global.MaweHint?.flashHint?.(message, 'invalid');
  }

  function syncStaleOverlay() {
    // 播放中渲染出来的帧必然在显示前就过时：压灰色斜纹提示，暂停后自动补渲染。
    const player = global.MaweCoreState?.player;
    const stale = Boolean(staleEl) && floatingPanel.isOpen() && Boolean(player) && player.paused !== true;
    if (staleEl) staleEl.hidden = !stale;
  }

  function scheduleRender(delayMs = 250) {
    // seek（方向键步进、波形点击、拖动进度条）会连续触发；合并成最后一次。
    if (!floatingPanel.isOpen()) return;
    global.clearTimeout(pendingRenderTimer);
    pendingRenderTimer = global.setTimeout(() => {
      pendingRenderTimer = 0;
      if (floatingPanel.isOpen() && !renderPending) void renderAssFrame();
    }, delayMs);
  }

  async function renderAssFrame() {
    const requestUrl = global.MaweBoot?.SERVER_CONFIG?.assFrameUrl;
    if (!requestUrl || renderPending) return;
    if (global.MaweSettings?.EDITOR_SETTINGS?.assMode !== true) {
      showAssFrameError('需要启用 ASS 字幕模式后再渲染实际画面。');
      return;
    }
    const timeMs = currentPlaybackMs();
    renderPending = true;
    if (renderButton) renderButton.disabled = true;
    setWindowStatus('正在渲染当前帧…', 'pending');
    try {
      // 与「导出 → 带样式的 ASS 字幕」完全同一份内容，保证预览即导出。
      const assText = global.MaweExportSrt.buildAss();
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestToken: global.MaweBoot?.SERVER_CONFIG?.requestToken || '',
          ass: assText,
          timeMs,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(String(payload?.error || `HTTP ${response.status}`));
      }
      if (imageEl) {
        imageEl.src = `data:image/png;base64,${payload.image}`;
        imageEl.hidden = false;
      }
      if (placeholderEl) placeholderEl.hidden = true;
      if (captionEl) {
        captionEl.textContent = `${formatFrameClock(payload.timeMs ?? timeMs)} · ${translate('libass 实际渲染')}`;
        captionEl.hidden = false;
      }
      if (warningsEl) {
        const warnings = Array.isArray(payload.warnings) ? payload.warnings.filter(Boolean) : [];
        warningsEl.textContent = warnings.join('\n');
        warningsEl.hidden = warnings.length === 0;
      }
      setWindowStatus('渲染完成', 'success');
    } catch (error) {
      showAssFrameError(`渲染失败：${error instanceof Error ? error.message : error}`);
    } finally {
      renderPending = false;
      if (renderButton) renderButton.disabled = false;
      syncStaleOverlay();
    }
  }

  const floatingPanel = global.MaweFloatingPanel.createFloatingPanel({
    panel: windowEl,
    dragHandle,
    manageButton: openButton,
    anchorButton: openButton,
    positionKey: ASS_FRAME_WINDOW_POSITION_KEY,
    // 点击入口按钮的开关由 createFloatingPanel 绑定；打开时自动渲染当前帧。
    onOpen: () => {
      syncStaleOverlay();
      void renderAssFrame();
    },
  });

  // 窗口开着时的联动：播放 → 立即压上「暂停后重新渲染」斜纹；暂停/seek
  // 停止后自动重渲染，无需再点按钮。窗口关闭时事件直接短路。
  const player = global.MaweCoreState?.player;
  player?.addEventListener('play', () => {
    syncStaleOverlay();
    global.clearTimeout(pendingRenderTimer);
  });
  player?.addEventListener('pause', () => {
    syncStaleOverlay();
    scheduleRender();
  });
  player?.addEventListener('seeked', () => {
    syncStaleOverlay();
    if (global.MaweCoreState?.player?.paused === true) scheduleRender();
  });

  renderButton?.addEventListener('click', () => void renderAssFrame());
  windowClose?.addEventListener('click', () => floatingPanel.close());
  footerCloseButton?.addEventListener('click', () => floatingPanel.close());
  // ASS 模式开关在 editor-wiring-ass-manager 中也有监听；这里只负责本按钮显隐。
  assModeToggle?.addEventListener('change', syncAssFrameControls);

  syncAssFrameControls();

  global.MaweAssFrame = Object.freeze({ syncAssFrameControls, renderAssFrame });
})(typeof window !== 'undefined' ? window : globalThis);

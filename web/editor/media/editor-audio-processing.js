// Project gain is separate from the player's listening volume. Loudness results
// belong to a live server/media binding and are deliberately never persisted.
(function initMaweAudioProcessing(global) {
  'use strict';
  const MIN_GAIN = -60, MAX_GAIN = 24, PEAK_CEILING = -1;
  const NORMAL_MIN_GAIN = -6, NORMAL_MAX_GAIN = 12, TARGET_PRESETS = [-14, -16, -23];
  const routes = new WeakMap(), boundPlayers = new WeakSet();
  let context = null, activeRoute = null, activePlayer = null;
  let measurement = null, measurementSnapshot = null, measurementState = 'idle', measurementError = '';
  let controller = null, revision = 0, previewError = '', initialized = false, pendingGainUndo = null;
  let expandedGain = false, customTarget = false;
  const el = id => document.getElementById(id);
  const tr = text => global.MAWE_I18N?.translateText?.(text) || text;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clamp = value => Math.min(MAX_GAIN, Math.max(MIN_GAIN, value));

  function normalize(value) {
    return { gain_db: finite(value?.gain_db) ? clamp(value.gain_db) : 0,
      target_lufs: finite(value?.target_lufs) && value.target_lufs >= -70 && value.target_lufs <= 0 ? value.target_lufs : -14,
      peak_ceiling_dbtp: PEAK_CEILING };
  }
  function settings() { return normalize(MaweBoot.DATA.audio_processing); }
  function sourceOf(player) { return player?.currentSrc || player?.querySelector?.('source')?.src || player?.src || ''; }
  function serverSource() {
    const config = MaweBoot.SERVER_CONFIG;
    if (MaweState.projectLoadPending || !config?.requestToken || !Number.isSafeInteger(config.bindingGeneration)
        || config.bindingGeneration < 1 || !config.sourceMediaId) return false;
    try {
      const url = new URL(sourceOf(MaweCoreState.player), global.location.href);
      return url.origin === global.location.origin && url.pathname === '/media';
    } catch (_) { return false; }
  }
  function snapshot() {
    const config = MaweBoot.SERVER_CONFIG;
    return { config, player: MaweCoreState.player, source: sourceOf(MaweCoreState.player),
      epoch: global.MaweProjectLoad?.projectBindingEpoch, generation: MaweState.projectLoadGeneration,
      bindingGeneration: config?.bindingGeneration, sourceMediaId: config?.sourceMediaId,
      requestToken: config?.requestToken, revision };
  }
  function isCurrent(s) {
    const now = snapshot();
    return !MaweState.projectLoadPending && Object.keys(s).every(key => now[key] === s[key]);
  }
  function invalidateMeasurement() {
    revision++;
    controller?.abort();
    controller = null;
    measurement = null;
    measurementSnapshot = null;
    measurementState = 'idle';
    measurementError = '';
    render();
  }
  function loadProject(value) {
    pendingGainUndo = null;
    invalidateMeasurement();
    MaweBoot.DATA.audio_processing = normalize(value);
    expandedGain = false;
    customTarget = !TARGET_PRESETS.includes(settings().target_lufs);
    MaweState.changes.audioProcessingDirty = false;
    previewError = '';
    if (activeRoute) activeRoute.gain.gain.value = 10 ** (settings().gain_db / 20);
    render();
  }

  async function applyPreview({ gesture = false } = {}) {
    const player = MaweCoreState.player;
    if (!player || (settings().gain_db === 0 && !routes.has(player))) return;
    try {
      const source = new URL(sourceOf(player), global.location.href);
      if (source.protocol !== 'blob:' && !(source.origin === global.location.origin && source.pathname === '/media')) {
        throw new Error(tr('此媒体来源不支持增益预览，请从启动器打开或导入本地媒体'));
      }
      const AudioContextClass = global.AudioContext || global.webkitAudioContext;
      if (!AudioContextClass) throw new Error(tr('当前浏览器不支持音量增益预览'));
      if (!context) context = new AudioContextClass();
      // A suspended graph would take over the media element and silence it.
      // Resume before creating a source; never capture a new element on load.
      if (context.state !== 'running' && gesture) await context.resume();
      if (player !== MaweCoreState.player || MaweState.projectLoadPending) return;
      if (context.state !== 'running') throw new Error(tr('请点击播放或音量滑块以启用增益预览'));
      let route = routes.get(player);
      if (!route) {
        const gain = context.createGain();
        gain.gain.value = 10 ** (settings().gain_db / 20);
        gain.connect(context.destination);
        let source;
        try { source = context.createMediaElementSource(player); }
        catch (error) { gain.disconnect(); throw error; }
        source.connect(gain);
        route = { source, gain, connected: true };
        routes.set(player, route);
      }
      if (activeRoute && activeRoute !== route) { activeRoute.source.disconnect(); activeRoute.connected = false; }
      if (!route.connected) { route.source.connect(route.gain); route.connected = true; }
      activeRoute = route;
      activePlayer = player;
      route.gain.gain.value = 10 ** (settings().gain_db / 20);
      previewError = '';
    } catch (error) {
      previewError = `${tr('增益预览未生效')}：${error?.message || error}`;
    }
    render();
  }
  function bindPlayer(player) {
    if (activePlayer !== player) {
      if (activeRoute) { activeRoute.source.disconnect(); activeRoute.connected = false; }
      activeRoute = null;
      activePlayer = player;
      previewError = '';
      invalidateMeasurement();
    }
    if (!player || boundPlayers.has(player)) return;
    boundPlayers.add(player);
    player.addEventListener('play', () => {
      if (player === MaweCoreState.player) void applyPreview({ gesture: true });
    });
    player.addEventListener('loadstart', () => {
      if (player === MaweCoreState.player) invalidateMeasurement();
    });
    player.addEventListener('volumechange', () => {
      if (player === MaweCoreState.player) render();
    });
    // Existing routes may return to unity without needing another gesture.
    const route = routes.get(player);
    if (route) route.gain.gain.value = 10 ** (settings().gain_db / 20);
  }
  function commitGainGesture() {
    if (pendingGainUndo && JSON.stringify(pendingGainUndo) !== JSON.stringify(settings())) {
      global.MaweHistory?.commitRecord({ kind: 'audio_processing', label: tr('工程音量'), audioProcessing: pendingGainUndo });
    }
    pendingGainUndo = null;
  }
  function change(next, { gesture = false, recordHistory = true } = {}) {
    const previous = settings(), value = normalize({ ...previous, ...next });
    if (JSON.stringify(previous) !== JSON.stringify(value)) {
      if (recordHistory) {
        commitGainGesture();
        global.MaweHistory?.commitRecord({ kind: 'audio_processing', label: tr('工程音量'), audioProcessing: previous });
      }
      MaweBoot.DATA.audio_processing = value;
      MaweState.changes.audioProcessingDirty = true;
      global.MaweServerSave?.configureServerSaveControls();
      global.MaweServerSave?.scheduleAutoSave();
    }
    if (activeRoute && activePlayer === MaweCoreState.player) activeRoute.gain.gain.value = 10 ** (value.gain_db / 20);
    void applyPreview({ gesture });
    render();
  }
  function normalizationGain(result, target = settings().target_lufs) {
    if (result?.status !== 'measured' || !finite(result.integratedLufs) || !finite(result.truePeakDbtp)) return null;
    // Round down: a displayed decimal must not accidentally exceed the ceiling.
    return Math.floor(clamp(Math.min(target - result.integratedLufs, PEAK_CEILING - result.truePeakDbtp)) * 10) / 10;
  }
  function normalizeToTarget() {
    const gain = normalizationGain(measurement);
    if (gain !== null) change({ gain_db: gain }, { gesture: true });
  }
  function delay(signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { global.clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
      const timer = global.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async function measure({ force = false } = {}) {
    if (!serverSource() || controller) { render(); return; }
    const request = new AbortController();
    controller = request;
    const captured = snapshot();
    measurement = null;
    measurementSnapshot = captured;
    measurementError = '';
    measurementState = 'measuring';
    render();
    try {
      let first = true;
      while (isCurrent(captured) && !request.signal.aborted) {
        const response = await MaweHost.server.fetch(captured.config.loudnessUrl || '/api/audio/loudness', {
          method: 'POST', signal: request.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestToken: captured.requestToken, bindingGeneration: captured.bindingGeneration,
            sourceMediaId: captured.sourceMediaId, ...(force && first ? { force: true } : {}) }),
        });
        first = false;
        const result = await response.json();
        if (!isCurrent(captured) || request.signal.aborted) return;
        if (!response.ok || !result.ok) throw new Error(result.error || tr('响度测量失败'));
        if (result.bindingGeneration !== captured.bindingGeneration || result.sourceMediaId !== captured.sourceMediaId) {
          throw new Error(tr('媒体绑定已改变，请重新测量'));
        }
        if (result.status === 'measuring') { await delay(request.signal); continue; }
        if (!['measured', 'silence', 'no_audio', 'error'].includes(result.status)) throw new Error(tr('响度测量返回无效结果'));
        if (result.status === 'measured' && (!finite(result.integratedLufs) || !finite(result.truePeakDbtp))) {
          throw new Error(tr('响度测量返回无效结果'));
        }
        measurement = result;
        measurementSnapshot = captured;
        measurementState = result.status;
        measurementError = result.status === 'error' ? tr('响度测量失败，请重新测量') : '';
        return;
      }
    } catch (error) {
      if (!isCurrent(captured) || request.signal.aborted) return;
      measurementState = 'error';
      // Native FFmpeg errors may include local paths. Keep them off the page.
      measurementError = tr('响度测量失败，请重新测量');
    } finally {
      if (controller === request) {
        controller = null;
        if (!isCurrent(captured)) invalidateMeasurement();
      }
      if (isCurrent(captured)) render();
    }
  }

  function render() {
    if (!initialized) return;
    if (measurementSnapshot && !isCurrent(measurementSnapshot)) { invalidateMeasurement(); return; }
    const current = settings(), measured = measurementState === 'measured';
    const outsideNormalRange = current.gain_db < NORMAL_MIN_GAIN || current.gain_db > NORMAL_MAX_GAIN;
    if (outsideNormalRange) expandedGain = true;
    el('audio-gain').min = String(expandedGain ? MIN_GAIN : NORMAL_MIN_GAIN);
    el('audio-gain').max = String(expandedGain ? MAX_GAIN : NORMAL_MAX_GAIN);
    el('audio-gain').value = String(current.gain_db);
    el('audio-gain-value').textContent = `${current.gain_db > 0 ? '+' : ''}${current.gain_db.toFixed(1)} dB`;
    el('audio-gain-expanded').checked = expandedGain;
    el('audio-gain-expanded').disabled = outsideNormalRange;
    el('audio-gain-range-note').hidden = !outsideNormalRange;
    const useCustomTarget = customTarget || !TARGET_PRESETS.includes(current.target_lufs);
    el('audio-target').value = useCustomTarget ? 'custom' : String(current.target_lufs);
    el('audio-target-custom-control').hidden = !useCustomTarget;
    if (document.activeElement !== el('audio-target-custom')) el('audio-target-custom').value = String(current.target_lufs);
    const volume = MaweCoreState.player?.volume;
    el('audio-listening-volume-value').textContent = `${Math.round((finite(volume) ? volume : 1) * 100)}%`;
    let status = serverSource() ? tr('尚未测量') : tr('响度测量需要从启动器打开关联媒体的工程');
    if (measurementState === 'measuring') status = tr('正在测量整段媒体…');
    if (measurementState === 'silence') status = tr('静音素材：无可用的整体响度');
    if (measurementState === 'no_audio') status = tr('媒体没有音轨');
    if (measurementState === 'error') status = measurementError;
    el('audio-measurement-status').textContent = measured ? tr('测量完成') : status;
    el('audio-measurement-status').classList.toggle('measuring', measurementState === 'measuring');
    el('audio-original-lufs').textContent = measured ? `${measurement.integratedLufs.toFixed(1)} LUFS` : '—';
    el('audio-adjusted-lufs').textContent = measured ? `${(measurement.integratedLufs + current.gain_db).toFixed(1)} LUFS` : '—';
    el('audio-target-difference').textContent = measured ? `${(measurement.integratedLufs + current.gain_db - current.target_lufs).toFixed(1)} LU` : '—';
    el('audio-true-peak').textContent = measured ? `${(measurement.truePeakDbtp + current.gain_db).toFixed(1)} dBTP` : '—';
    el('audio-normalize').disabled = !measured;
    el('audio-measure').disabled = !serverSource() || measurementState === 'measuring';
    let warning = '';
    if (measured && measurement.truePeakDbtp + current.gain_db > PEAK_CEILING + 0.01) {
      warning = tr('预计峰值超过 -1 dBTP，可能削波；请降低增益。');
    }
    const previewStatus = previewError || (current.gain_db !== 0 && !activeRoute
      ? tr('播放或操作增益滑块后启用增益预览。') : '');
    el('audio-gain-warning').textContent = [warning, previewStatus].filter(Boolean).join(' ');
    el('audio-gain-warning').hidden = !warning && !previewStatus;
    el('audio-processing-toggle').title = `${tr('工程音量')} · ${current.gain_db.toFixed(1)} dB`;
  }
  function init() {
    if (initialized || !el('audio-processing-panel')) return;
    initialized = true;
    MaweBoot.DATA.audio_processing = settings();
    customTarget = !TARGET_PRESETS.includes(settings().target_lufs);
    el('audio-gain').addEventListener('input', event => {
      if (!pendingGainUndo) pendingGainUndo = settings();
      change({ gain_db: Number(event.target.value) }, { gesture: true, recordHistory: false });
    });
    el('audio-gain').addEventListener('change', commitGainGesture);
    el('audio-gain').addEventListener('blur', commitGainGesture);
    el('audio-gain-down').addEventListener('click', () => change({ gain_db: Math.max(expandedGain ? MIN_GAIN : NORMAL_MIN_GAIN, settings().gain_db - 1) }, { gesture: true }));
    el('audio-gain-up').addEventListener('click', () => change({ gain_db: Math.min(expandedGain ? MAX_GAIN : NORMAL_MAX_GAIN, settings().gain_db + 1) }, { gesture: true }));
    el('audio-gain-expanded').addEventListener('change', event => { expandedGain = event.target.checked; render(); });
    el('audio-gain').addEventListener('pointerdown', () => { void applyPreview({ gesture: true }); });
    el('audio-target').addEventListener('change', event => {
      customTarget = event.target.value === 'custom';
      if (customTarget) {
        render();
        el('audio-target-custom').focus();
        el('audio-target-custom').select();
      } else change({ target_lufs: Number(event.target.value) });
    });
    el('audio-target-custom').addEventListener('change', event => {
      const value = event.target.valueAsNumber;
      if (finite(value) && value >= -70 && value <= 0) change({ target_lufs: value });
      event.target.value = String(settings().target_lufs);
    });
    el('audio-normalize').addEventListener('click', normalizeToTarget);
    el('audio-gain-reset').addEventListener('click', () => change({ gain_db: 0 }, { gesture: true }));
    el('audio-measure').addEventListener('click', () => { void measure({ force: true }); });
    const floatingPanel = global.MaweFloatingPanel.createFloatingPanel({
      panel: el('audio-processing-panel'), dragHandle: el('audio-processing-drag-handle'),
      manageButton: el('audio-processing-toggle'), anchorButton: el('audio-processing-toggle'),
      positionKey: 'mawe.audioProcessingPanelPosition',
      onOpen: () => { render(); if (measurementState === 'idle') void measure(); },
      onClose: commitGainGesture,
    });
    el('audio-processing-close').addEventListener('click', floatingPanel.close);
    MaweState.observeProjectLoad(invalidateMeasurement);
    document.addEventListener('mawe:languagechange', render);
    bindPlayer(MaweCoreState.player);
    render();
  }
  global.MaweAudioProcessing = Object.freeze({ normalize, settings, loadProject, bindPlayer, change,
    normalizationGain, normalizeToTarget, measure, invalidateMeasurement, applyPreview, render, init,
    get measurement() { return measurement; }, get measurementState() { return measurementState; } });
})(typeof window !== 'undefined' ? window : globalThis);

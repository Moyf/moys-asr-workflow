// === 编辑器「烧录视频」：当前 ASS 或按库样式转换的 SRT，复用同一媒体任务 ===
// 与「去空隙导出 → 重组后视频」同一套媒体任务生命周期（准入令牌 / 轮询 / 流式下载 /
// 取消与临时文件确认），但只支持 jobs API：烧录总是重新编码并输出 MP4。
// 三个入口共享本模块的 runBurnVideoJob：
// - 工具栏「烧录视频」：完整源视频 + 原时间轴 ASS；
// - 「去空隙导出 → 重组后烧录视频」：ffconcat 保留区间 + 收缩时间轴 ASS（帧级精确切点）。
// - 「更多导出 → 生成绿幕视频」：音视频工程的字幕 + 可选源音轨。

const BURN_VIDEO_MIME = 'video/mp4';
// 烧录阶段文本：key 与服务端 MediaJob.stage 对齐。
const BURN_VIDEO_STAGES = {
  preparing: '正在读取源视频信息…',
  burning: '正在烧录字幕…',
};
const BURN_SESSION_KEY = 'maw-native-burn-session';
let nativeBurnPicking = false;

async function nativeBurnPost(url, requestToken, fields) {
  const response = await MaweHost.server.fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestToken, ...fields }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `服务器返回 ${response.status}`), { code: data.code });
  }
  return data;
}

function connectNativeBurn() {
  const config = MaweBoot.SERVER_CONFIG;
  if (config?.nativeBurnAvailable !== true) return null;
  const { hash, pathname, search } = window.location;
  const fragmentPrefix = '#maw-burn-host=';
  let grant = '';
  if (hash.startsWith(fragmentPrefix)) {
    grant = hash.slice(fragmentPrefix.length);
    window.history.replaceState(window.history.state, '', pathname + search);
  }
  let stored = null;
  try { stored = window.sessionStorage.getItem(BURN_SESSION_KEY); }
  catch (_) { /* A new Launcher grant still works without session storage. */ }
  if (!grant && !stored) return null;
  return nativeBurnPost(`${config.burnVideoJobsUrl}/native-session`, config.requestToken,
    grant ? { launchGrant: grant } : { nativeSession: stored })
    .then(({ nativeSession }) => {
      if (typeof nativeSession !== 'string' || !nativeSession) throw new Error('Invalid native session');
      try { window.sessionStorage.setItem(BURN_SESSION_KEY, nativeSession); }
      catch (_) { /* Session storage is only for refreshes. */ }
      return nativeSession;
    }).catch(() => {
      try { window.sessionStorage.removeItem(BURN_SESSION_KEY); }
      catch (_) { /* Storage is unavailable. */ }
      if (grant) MaweHint.flashHint(burnVideoText('启动器编辑器会话无效，请从启动器重新打开'), 'warning');
      return null;
    });
}

function burnVideoText(text) {
  return window.MAWE_I18N?.translateText?.(text) || text;
}

function burnVideoMediaCurrent(config, greenScreen = false) {
  if (config?.[greenScreen ? 'canGreenScreenExport' : 'canBurnVideoExport'] !== true || !config.burnVideoJobsUrl) return false;
  const player = window.MaweCoreState?.player;
  const source = player?.currentSrc || player?.querySelector?.('source')?.src || player?.src;
  if (!source) return false;
  try {
    const url = new URL(source, location.href);
    return url.origin === location.origin && url.pathname === '/media';
  } catch (_) { return false; }
}

function burnVideoBindingCurrent(config, snapshot) {
  return burnVideoMediaCurrent(config, snapshot.greenScreen) && MaweBoot.SERVER_CONFIG === config
    && config.burnVideoJobsUrl === snapshot.jobsUrl
    && config.requestToken === snapshot.requestToken
    && config.bindingGeneration === snapshot.bindingGeneration
    && config.sourceMediaId === snapshot.sourceMediaId
    && config.burnVideoSourceName === snapshot.sourceName
    && window.MaweProjectLoad?.projectBindingEpoch === snapshot.bindingEpoch;
}

function burnVideoSafeError(error, fallback) {
  const message = error?.message || error;
  // 流式写盘慢于服务端 socket 兜底超时（慢盘/杀软/同步目录）会主动断流，
  // 浏览器侧只抛「network error / Failed to fetch」；换成人能看懂的提示。
  if (typeof message === 'string' && (/^network error$/i.test(message) || /^failed to fetch$/i.test(message))) {
    return burnVideoText('与本地服务的连接中断，请重试');
  }
  if (typeof message !== 'string' || !message || message.length > 240
      || /extract_extradata|No start code|Invalid data found|[A-Z]:[\\/]|maw-media-job-/i.test(message)) {
    return burnVideoText(fallback);
  }
  return burnVideoText(message);
}

function showBurnVideoSuccess(message, name, open = null, syncWarning = false) {
  const tr = burnVideoText;
  MaweHint.flashHint(message, 'success', {
    durationMs: 0,
    position: 'bottom-right',
    contentBuilder(card) {
      const title = document.createElement('div');
      title.textContent = `${message}：${name}`;
      card.append(title);
      const actions = document.createElement('div');
      actions.className = 'hint-burn-actions';
      if (open) {
        const openActions = [];
        let expired = false;
        for (const [text, folder] of [['打开文件', false], ['打开文件夹', true]]) {
          const action = document.createElement('button');
          action.type = 'button';
          action.className = 'hint-burn-open';
          action.textContent = tr(text);
          action.addEventListener('click', async () => {
            action.disabled = true;
            try {
              const result = await open(folder);
              if (result.openRequested !== true) throw new Error(tr('无法打开已保存的烧录视频'));
              if (!expired) MaweHint.flashHint(tr('已向系统发出打开请求'), 'info');
            } catch (error) {
              if (error?.code === 'burn_open_expired') {
                if (!expired) {
                  const detail = tr('打开操作已过期，请从保存位置手动打开');
                  title.textContent += ` · ${detail}`;
                  MaweHint.flashHint(detail, 'warning');
                }
                expired = true;
                openActions.forEach(button => { button.disabled = true; });
              } else if (!expired) {
                MaweHint.flashHint(burnVideoSafeError(error, '无法打开已保存的烧录视频'), 'warning', { error });
              }
            } finally {
              action.disabled = expired;
            }
          });
          openActions.push(action);
          actions.append(action);
        }
      }
      if (!open || syncWarning) {
        const detail = document.createElement('div');
        detail.className = 'hint-burn-detail';
        detail.textContent = tr(syncWarning
          ? '无法确认保存位置的更新已同步到磁盘。'
          : '当前环境无法直接打开已保存的文件或文件夹，请在保存位置手动打开。');
        card.append(detail);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = tr('关闭');
      close.addEventListener('click', () => MaweHint.dismissHintCard(card));
      actions.appendChild(close);
      card.append(actions);
    },
  });
}

function openBurnEncodingDialog(options) {
  if (window.__maweBurnVideoTask || nativeBurnPicking || document.getElementById('burn-video-encoding')) return;
  const tr = burnVideoText;
  const config = MaweBoot.SERVER_CONFIG;
  if (!burnVideoMediaCurrent(config)) return;
  const binding = {
    jobsUrl: config.burnVideoJobsUrl, requestToken: config.requestToken,
    bindingGeneration: config.bindingGeneration, sourceMediaId: config.sourceMediaId,
    sourceName: config.burnVideoSourceName, bindingEpoch: window.MaweProjectLoad?.projectBindingEpoch,
  };
  const defaultsKey = 'mawe.burnVideoEncoding';
  const presets = ['veryfast', 'fast', 'medium', 'slow', 'veryslow'];
  const bitrates = ['96k', '128k', '160k', '192k', '224k', '256k', '320k'];
  const storage = MaweHost.storage;
  let defaults;
  try { defaults = JSON.parse(storage.getItem(defaultsKey)); } catch { /* storage unavailable */ }
  const dialog = document.createElement('dialog');
  dialog.id = 'burn-video-encoding';
  dialog.className = 'modal burn-video-encoding';
  dialog.setAttribute('aria-labelledby', 'burn-video-encoding-title');
  dialog.innerHTML = `<h3 id="burn-video-encoding-title"></h3>
    <form>
      <div class="burn-video-encoding-fields">
        <div><label for="burn-video-crf"></label>
          <input id="burn-video-crf" type="number" required min="0" max="51" step="1" aria-describedby="burn-video-crf-help">
          <small id="burn-video-crf-help"></small></div>
        <div><label for="burn-video-preset"></label>
          <select id="burn-video-preset" aria-describedby="burn-video-preset-help"></select>
          <small id="burn-video-preset-help"></small></div>
        <div><label for="burn-video-audio-bitrate"></label>
          <select id="burn-video-audio-bitrate" aria-describedby="burn-video-audio-help"></select>
          <small id="burn-video-audio-help"></small></div>
      </div>
      <p role="status" hidden></p>
      <div class="actions">
        <button type="button" data-save-defaults></button>
        <button type="button" data-cancel></button>
        <button type="submit" class="primary"></button>
      </div>
    </form>`;
  const find = selector => dialog.querySelector(selector);
  const labels = {
    h3: '烧录编码设置',
    '[for="burn-video-crf"]': '画质 CRF',
    '#burn-video-crf-help': '数值越大，画质越低、文件通常越小；不保证与原片同大小。',
    '[for="burn-video-preset"]': '编码预设',
    '#burn-video-preset-help': '仅 CPU 编码使用；较慢的预设通常压缩得更好。',
    '[for="burn-video-audio-bitrate"]': '音频码率',
    '#burn-video-audio-help': '每条音轨的码率；数值越高，音频通常越大。',
    '[data-save-defaults]': '保存为默认参数',
    '[data-cancel]': '取消',
    '[type="submit"]': '选择保存位置…',
  };
  for (const [selector, text] of Object.entries(labels)) find(selector).textContent = tr(text);
  const crf = find('#burn-video-crf');
  crf.value = Number.isInteger(defaults?.crf) && defaults.crf >= 0 && defaults.crf <= 51 ? defaults.crf : 21;
  const preset = find('#burn-video-preset');
  preset.append(...presets.map(value => new Option(value, value)));
  preset.value = presets.includes(defaults?.preset) ? defaults.preset : 'medium';
  const audioBitrate = find('#burn-video-audio-bitrate');
  audioBitrate.append(...bitrates.map(value => new Option(`${parseInt(value, 10)} kbps`, value)));
  audioBitrate.value = bitrates.includes(defaults?.audioBitrate) ? defaults.audioBitrate : '192k';
  const form = find('form');
  const values = () => ({ crf: crf.valueAsNumber, preset: preset.value, audioBitrate: audioBitrate.value });
  const status = find('[role="status"]');
  dialog.addEventListener('keydown', event => event.stopPropagation());
  form.addEventListener('input', () => { status.hidden = true; });
  find('[data-save-defaults]').addEventListener('click', () => {
    if (!form.reportValidity()) return;
    status.hidden = false;
    try {
      storage.setItem(defaultsKey, JSON.stringify(values()));
      status.textContent = tr('已保存为默认参数');
    } catch {
      status.textContent = tr('无法保存默认参数');
    }
  });
  find('[data-cancel]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  form.addEventListener('submit', event => {
    event.preventDefault();
    dialog.close();
    if (!burnVideoBindingCurrent(config, binding)) {
      MaweHint.flashHint(tr('工程或媒体绑定已变更，请重新发起视频烧录'), 'warning');
      return;
    }
    // Call directly from the submit gesture so the browser save picker has activation.
    void runBurnVideoJob({ ...options, encoding: values() });
  });
  document.body.append(dialog);
  dialog.showModal();
}

async function runBurnVideoJob({ button, label, buildRequest, suggestedName, startHint, successText, greenScreen = false, encoding = null }) {
  const tr = burnVideoText;
  const config = MaweBoot.SERVER_CONFIG;
  if (window.__maweBurnVideoTask) return;
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  if (MaweInlineEdit.extensionEditingState) MaweInlineEdit.finishExtensionEdit(true);
  if (!burnVideoMediaCurrent(config, greenScreen) || !Number.isSafeInteger(config.bindingGeneration) || config.bindingGeneration < 1
      || typeof config.sourceMediaId !== 'string' || !config.sourceMediaId
      || typeof config.burnVideoSourceName !== 'string' || !config.burnVideoSourceName) {
    MaweHint.flashHint(tr('请从启动器打开关联源媒体的工程，再烧录视频'), 'warning');
    return;
  }
  const nativeSession = nativeBurnConnection ? await nativeBurnConnection : null;
  if (window.__maweBurnVideoTask || nativeBurnPicking) return;
  if (!nativeSession && !MaweHost.files.hasSavePicker()) {
    MaweHint.flashHint(tr('当前浏览器或环境不支持烧录视频保存'), 'warning');
    return;
  }
  const requestToken = config.requestToken;
  const bindingGeneration = config.bindingGeneration;
  const sourceMediaId = config.sourceMediaId;
  const sourceName = config.burnVideoSourceName;
  const jobsUrl = config.burnVideoJobsUrl;
  const bindingEpoch = window.MaweProjectLoad?.projectBindingEpoch;
  const snapshot = { jobsUrl, requestToken, bindingGeneration, sourceMediaId, sourceName, bindingEpoch, greenScreen };
  const isBindingCurrent = () => burnVideoBindingCurrent(config, snapshot);
  const random = crypto.getRandomValues(new Uint8Array(32));
  const admissionToken = Array.from(random, value => value.toString(16).padStart(2, '0')).join('');
  const sessionFields = nativeSession ? { nativeSession } : {};
  const statusHeaders = {
    'X-MAW-Request-Token': requestToken, ...(nativeSession ? { 'X-MAW-Burn-Session': nativeSession } : {}),
  };

  // Start lazily, but keep the save picker inside the original user gesture.
  // Only defer building ASS when inventory is still pending.
  const needsAssFonts = greenScreen || MaweSettings.EDITOR_SETTINGS.assMode === true;
  const fontsReady = needsAssFonts ? window.MaweAssFontAliases?.ensureCoverage?.() : null;
  const deferRequest = needsAssFonts && window.MaweAssFontAliases?.pending?.();
  const audioGainDb = window.MaweAudioProcessing?.settings().gain_db || 0;
  let request;
  const prepareRequest = () => {
    request = buildRequest();
    if (request) {
      request.audioGainDb = audioGainDb;
      if (encoding) request.encoding = encoding;
    }
  };
  if (!deferRequest) {
    try { prepareRequest(); }
    catch (error) {
      MaweHint.flashHint(`${tr('无法准备字幕内容')}：${burnVideoSafeError(error, '请检查字幕样式后重试')}`, 'warning', { error, durationMs: 0, dismissible: true });
      return;
    }
    if (!request) return;
  }

  if (!nativeSession) MaweHint.flashHint(tr(startHint), 'info');
  let pickerHint;
  let handle;
  try {
    if (nativeSession) {
      nativeBurnPicking = true;
      pickerHint = MaweHint.flashHint(tr('请稍等片刻，在 Launcher 的文件选择器中选择保存路径。'), 'info', { durationMs: 0 });
      const basename = suggestedName.slice(0, -4).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 220);
      handle = await nativeBurnPost(`${jobsUrl}/native-target`, requestToken, {
        nativeSession, admissionToken, bindingGeneration, sourceMediaId, suggestedName: `${basename || 'export'}.mp4`,
        language: window.MAWE_I18N?.language === 'en' ? 'en' : 'zh',
      });
      if (handle.cancelled) return;
      if (typeof handle.nativeTarget !== 'string' || typeof handle.name !== 'string') {
        throw new Error(tr('导出状态异常，请重试'));
      }
    } else {
      handle = await MaweHost.files.pickSaveFile({
        suggestedName,
        types: [{ description: tr(label), accept: { [BURN_VIDEO_MIME]: ['.mp4'] } }],
      });
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    MaweHint.flashHint(`${tr('无法打开视频保存位置选择器')}：${burnVideoSafeError(error, '请检查保存位置权限后重试')}`, 'warning', { error, durationMs: 0, dismissible: true });
    return;
  } finally {
    if (nativeSession) nativeBurnPicking = false;
    if (pickerHint) MaweHint.dismissHintCard(pickerHint);
  }
  if (deferRequest) {
    await fontsReady;
    await window.MaweAssFontAliases?.whenReady?.();
    if (!isBindingCurrent()) {
      MaweHint.flashHint(tr('工程或媒体绑定已变更，请重新发起视频烧录'), 'warning');
      return;
    }
    try { prepareRequest(); }
    catch (error) {
      MaweHint.flashHint(`${tr('无法准备字幕内容')}：${burnVideoSafeError(error, '请检查字幕样式后重试')}`, 'warning', { error, durationMs: 0, dismissible: true });
      return;
    }
    if (!request) return;
  }
  // 选择器等待期间工程或绑定可能已切换；绝不混合旧字幕快照与新绑定。
  if (!isBindingCurrent()) {
    MaweHint.flashHint(tr('工程或媒体绑定已变更，请重新发起视频烧录'), 'warning');
    return;
  }
  if (!nativeSession && handle.name.toLowerCase() === sourceName.toLowerCase()) {
    MaweHint.flashHint(tr('保存目标不能与源视频同名'), 'warning');
    return;
  }
  if (!handle.name.toLowerCase().endsWith('.mp4')) {
    MaweHint.flashHint(tr('烧录视频请使用 .mp4 扩展名'), 'warning');
    return;
  }

  let writable = null;
  let reader = null;
  let response = null;
  let transferComplete = false;
  let task = null;
  let panel = null;
  let stopButton = null;
  let statusLabel = null;
  let progressBar = null;
  let rejectStop;
  let committing = false;
  let cleanupWarningShown = false;
  const warnCleanup = (error) => {
    if (cleanupWarningShown) return;
    cleanupWarningShown = true;
    MaweHint.flashHint(burnVideoSafeError(error, '无法确认导出已停止，请重试'), 'warning', { error });
  };
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  void stopped.catch(() => {});
  const raceStop = (promise) => task ? Promise.race([promise, stopped]) : promise;
  const pause = () => new Promise(resolve => setTimeout(resolve, 250));
  const setProgress = (text, value = null) => {
    if (!panel) return;
    statusLabel.textContent = text;
    if (value === null) progressBar.removeAttribute('value');
    else progressBar.value = Math.max(0, Math.min(1, value));
  };
  const stopBackend = () => {
    if (!task) return Promise.resolve();
    if (task.cancelRequest) return task.cancelRequest;
    task.cancelRequest = (async () => {
      const controller = new AbortController();
      let deadlineTimer;
      const timeout = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => {
          reject(new Error(tr('无法确认导出已停止，请重试')));
          controller.abort();
        }, 30000);
      });
      try {
        await Promise.race([(async () => { while (true) {
          const cancelUrl = task.id ? `${jobsUrl}/${encodeURIComponent(task.id)}/cancel` : `${jobsUrl}/cancel-admission`;
          const reply = await MaweHost.server.fetch(cancelUrl, {
            method: 'POST', keepalive: true, signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestToken, admissionToken, ...sessionFields }),
          });
          const state = await reply.json();
          if (!reply.ok) throw new Error(state.error || tr('无法确认导出已停止，请重试'));
          if (state.cleanupComplete === true) return;
          if (state.cleanupError) throw new Error(tr('导出已结束，但临时文件清理失败，请重试'));
          if (state.state === 'failed') {
            throw new Error(state.cleanupError
              ? tr('导出已结束，但临时文件清理失败，请重试')
              : tr('无法确认导出已停止，请重试'));
          }
          if (['cancelled', 'completed'].includes(state.state) && state.cleanupComplete !== false) return;
          await pause();
        } })(), timeout]);
      } finally {
        clearTimeout(deadlineTimer);
        controller.abort();
      }
    })();
    return task.cancelRequest;
  };
  const confirmBackendCleanup = async () => {
    if (!task?.id) return;
    const controller = new AbortController();
    let deadlineTimer;
    const timeout = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(new Error(tr('文件已保存，但无法确认临时文件已清理，请重试')));
        controller.abort();
      }, 30000);
    });
    try {
      await Promise.race([(async () => {
        while (true) {
          const reply = await MaweHost.server.fetch(`${jobsUrl}/${encodeURIComponent(task.id)}`, {
            headers: statusHeaders, signal: controller.signal,
          });
          const state = await reply.json();
          if (!reply.ok) throw new Error(tr('文件已保存，但无法确认临时文件已清理，请重试'));
          if (state.cleanupError) throw new Error(tr('导出已结束，但临时文件清理失败，请重试'));
          if (state.cleanupComplete === true) return;
          if (state.cleanupComplete === undefined && ['completed', 'cancelled'].includes(state.state)) return;
          if (state.state === 'failed') throw new Error(tr('文件已保存，但无法确认临时文件已清理，请重试'));
          await pause();
        }
      })(), timeout]);
    } finally {
      clearTimeout(deadlineTimer);
      controller.abort();
    }
  };
  const requestStop = () => {
    if (!task || task.stopRequested || committing || transferComplete) return;
    task.stopRequested = true;
    // If publication already won the server's race with cancel, keep its
    // response so the file still gets a success card.
    if (!task.nativeSaving) task.controller.abort();
    const error = new Error(tr('视频烧录已停止'));
    error.name = 'AbortError';
    rejectStop(error);
    setProgress(tr('正在停止烧录…'));
    if (stopButton) stopButton.disabled = true;
    void stopBackend().catch(() => {});
  };
  const ensureCurrent = () => {
    if (!isBindingCurrent() || config.burnVideoJobsUrl !== jobsUrl) {
      requestStop();
      throw new Error(tr('工程或媒体绑定已变更，请重新发起视频烧录'));
    }
    if (task?.stopRequested) {
      const error = new Error(tr('视频烧录已停止'));
      error.name = 'AbortError';
      throw error;
    }
  };
  try {
    // 选择器等待期间另一个入口可能已经开始任务；二次确认避免并发。
    if (window.__maweBurnVideoTask) return;
    if (nativeSession) MaweHint.flashHint(tr(startHint), 'info');
    task = { id: null, controller: new AbortController(), stopRequested: false, cancelRequest: null, requestStop };
    window.__maweBurnVideoTask = task;
    button.disabled = true;
    panel = document.createElement('div');
    panel.className = 'gap-video-job';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    statusLabel = document.createElement('div');
    statusLabel.id = 'burn-video-job-status';
    progressBar = document.createElement('progress');
    progressBar.max = 1;
    progressBar.setAttribute('aria-label', tr(label));
    stopButton = document.createElement('button');
    stopButton.id = 'burn-video-job-stop';
    stopButton.textContent = tr('停止视频烧录');
    stopButton.addEventListener('click', requestStop);
    panel.append(statusLabel, progressBar, stopButton);
    document.body.append(panel);
    window.addEventListener('pagehide', requestStop);
    setProgress(tr('正在准备导出…'));
    // 客户端令牌让取消在服务器返回任务 ID 之前也安全（含页面关闭）。
    const admission = await raceStop(MaweHost.server.fetch(jobsUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MAW-Request-Token': requestToken },
      body: JSON.stringify({
        requestToken, bindingGeneration, sourceMediaId, ...request, ...sessionFields,
        ...(nativeSession ? { nativeTarget: handle.nativeTarget } : {}),
        admissionToken, admissionDeadline: Date.now() + 60000,
      }),
      signal: task.controller.signal,
    }));
    let state = await raceStop(admission.json());
    if (!admission.ok) throw new Error(state.error || `服务器返回 ${admission.status}`);
    if (typeof state.jobId !== 'string' || !state.jobId) throw new Error(tr('导出状态异常，请重试'));
    task.id = state.jobId;
    while (true) {
      ensureCurrent();
      if (state.jobId !== task.id || state.bindingGeneration !== bindingGeneration
          || state.sourceMediaId !== sourceMediaId) {
        throw new Error(tr('导出状态异常，请重试'));
      }
      if (state.state === 'ready') break;
      if (state.state === 'failed' && typeof state.errorDetails === 'string' && state.errorDetails) {
        // ffmpeg stderr 尾部只进控制台诊断，不拼进 toast 文案。
        console.error('[MAW burn] ffmpeg stderr tail:', state.errorDetails.slice(-2000));
      }
      if (['failed', 'cancelled', 'completed'].includes(state.state)) throw new Error(state.error || tr('导出状态异常，请重试'));
      const percent = state.stage === 'burning' && typeof state.progress === 'number' ? state.progress : null;
      setProgress(tr(BURN_VIDEO_STAGES[state.stage] || '正在准备导出…')
        + (percent === null ? '' : ` ${Math.round(percent * 100)}%`), percent);
      await raceStop(pause());
      const poll = await raceStop(MaweHost.server.fetch(`${jobsUrl}/${encodeURIComponent(task.id)}`, {
        headers: statusHeaders, signal: task.controller.signal,
      }));
      state = await raceStop(poll.json());
      if (!poll.ok) throw new Error(state.error || `服务器返回 ${poll.status}`);
    }
    ensureCurrent();
    if (nativeSession) {
      const jobUrl = `${jobsUrl}/${encodeURIComponent(task.id)}`;
      task.nativeSaving = true;
      setProgress(tr('正在写入烧录视频…'));
      let saved;
      try {
        saved = await nativeBurnPost(`${jobUrl}/native-save`, requestToken, sessionFields);
      } catch (error) {
        if (task.stopRequested) throw Object.assign(new Error(tr('视频烧录已停止')), { name: 'AbortError' });
        throw error;
      }
      transferComplete = true;
      if (stopButton) stopButton.disabled = true;
      showBurnVideoSuccess(tr(successText), saved.name,
        folder => nativeBurnPost(`${jobUrl}/native-open`, requestToken, { nativeSession, folder }), saved.syncWarning === true);
      try { await confirmBackendCleanup(); }
      catch (error) { warnCleanup(error); }
      return;
    }
    setProgress(tr('正在下载并写入视频…'), 0);
    response = await raceStop(MaweHost.server.fetch(`${jobsUrl}/${encodeURIComponent(task.id)}/download`, {
      headers: { 'X-MAW-Request-Token': requestToken }, signal: task.controller.signal,
    }));
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `服务器返回 ${response.status}`);
    }
    const contentType = (response.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== BURN_VIDEO_MIME) throw new Error(tr('导出文件格式不符合预期，请重试'));
    if (!response.body?.getReader) throw new Error(tr('当前浏览器不支持流式保存视频'));
    const expectedLength = Number(response.headers.get('Content-Length'));
    if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0) {
      throw new Error(tr('服务器返回的视频大小无效'));
    }
    ensureCurrent();
    const writablePromise = handle.createWritable();
    // 浏览器存储权限操作可能在停止之后才完成；迟到的 writable 也要丢弃。
    if (task) void writablePromise.then(value => {
      if (task.stopRequested) void value.abort().catch(() => {});
    }).catch(() => {});
    writable = await raceStop(writablePromise);
    ensureCurrent();
    reader = response.body.getReader();
    let receivedLength = 0;
    while (true) {
      const { done, value } = await raceStop(reader.read());
      ensureCurrent();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) continue;
      receivedLength += value.byteLength;
      if (receivedLength > expectedLength) throw new Error(tr('服务器返回的视频长度超出预期'));
      await raceStop(writable.write(value));
      ensureCurrent();
      setProgress(`${tr('正在下载并写入视频…')} ${Math.round(receivedLength / expectedLength * 100)}%`,
        receivedLength / expectedLength);
    }
    if (receivedLength !== expectedLength) throw new Error(tr('视频传输不完整，未保存部分文件'));
    ensureCurrent();
    committing = true;
    if (stopButton) stopButton.disabled = true;
    setProgress(tr('正在完成保存…'), 1);
    await writable.close();
    writable = null;
    transferComplete = true;
    showBurnVideoSuccess(tr(successText), handle.name);
    try { await confirmBackendCleanup(); }
    catch (error) { warnCleanup(error); }
  } catch (error) {
    if (task?.stopRequested && error?.name === 'AbortError') {
      try {
        await stopBackend();
        MaweHint.flashHint(tr('视频烧录已停止'));
      } catch (cleanupError) {
        warnCleanup(cleanupError);
      }
    } else {
      MaweHint.flashHint(`${tr('烧录视频导出失败')}：${burnVideoSafeError(error, '媒体处理失败，请确认源文件可以正常播放后重试')}`, 'warning', { error, durationMs: 0, dismissible: true });
    }
  } finally {
    if (!transferComplete && response?.body) {
      // 释放读取锁不会取消网络层；主动 cancel 让服务器尽快结束流并清理。
      try {
        const cancellation = reader ? reader.cancel() : response.body.cancel();
        void cancellation.catch(() => {});
      } catch (_) {}
    }
    if (reader) reader.releaseLock();
    if (writable) await writable.abort().catch(() => {});
    if (task && !transferComplete) {
      try { await stopBackend(); }
      catch (error) { warnCleanup(error); }
    }
    if (task) {
      window.removeEventListener('pagehide', requestStop);
      panel.remove();
      if (window.__maweBurnVideoTask === task) window.__maweBurnVideoTask = null;
      button.disabled = false;
    }
  }
}

// 普通和去空隙烧录分别使用原时间轴和收缩后的字幕。
function buildBurnVideoSubtitles(gapRemoved = false) {
  // Burned captions and sticker plans share the media timeline, independently
  // of the subtitle-file preference that extends the first cue to zero.
  let assPlan = null;
  const options = { alignFirstStart: false, onAssPlan: (plan) => { assPlan = plan; } };
  const subtitles = MaweSettings.EDITOR_SETTINGS.assMode === true
    ? { ass: gapRemoved ? MaweExportSrt.buildGapRemovedAss(options) : MaweExportSrt.buildAss(options) }
    : { srt: gapRemoved ? MaweExportSrt.buildGapRemovedSrt(options) : MaweExportSrt.buildSrt(options) };
  return {
    ...subtitles,
    stickers: MaweStickerBurnPlan.collectStickerPlans({
      gapRemoved: gapRemoved ? MaweGapRemoveData.getRemovedGapRanges() : null,
      resolution: MaweExportSrt.currentAssVideoResolution(),
      mode: MaweSettings.EDITOR_SETTINGS.stickerBurnMode === 'cue-left' ? 'cue-left' : 'fixed',
      // SRT has no browser ASS plan and keeps the existing fixed-box fallback.
      plan: assPlan,
    }),
  };
}

document.getElementById('burn-video-export-btn')?.addEventListener('click', () => {
  openBurnEncodingDialog({
    button: document.getElementById('burn-video-export-btn'),
    label: '烧录视频',
    startHint: 'FFmpeg 将重新编码源视频并烧录当前字幕；长视频可能需要较长时间。',
    successText: '烧录视频已保存',
    suggestedName: `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('subtitled') || 'subtitled'}.mp4`,
    buildRequest: () => buildBurnVideoSubtitles(),
  });
});

// 入口二：「去空隙导出 → 重组后烧录视频」。保留区间 + 收缩时间轴 ASS；重新编码使切点帧级精确。
document.getElementById('download-gap-removed-burn-video')?.addEventListener('click', () => {
  openBurnEncodingDialog({
    button: document.getElementById('download-gap-removed-burn-video'),
    label: '重组后烧录视频',
    startHint: '按保留区域重新编码并烧录当前 ASS 字幕；切点帧级精确。',
    successText: '重组后烧录视频已保存',
    suggestedName: `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}_${window.MAWE_I18N?.exportTag?.('subtitled') || 'subtitled'}.mp4`,
    buildRequest: () => {
      const context = MaweExportSrt.gapRemovedExportContext();
      if (!context) return null;
      const subtitles = buildBurnVideoSubtitles(true);
      if (!(subtitles.ass || subtitles.srt)) return null;
      return { ...subtitles, intervals: context.intervals.map(({ start, end }) => ({ startMs: start, endMs: end })) };
    },
  });
});

const greenScreenAudioToggle = document.getElementById('green-screen-include-audio');
if (greenScreenAudioToggle) {
  greenScreenAudioToggle.checked = MaweSettings.EDITOR_SETTINGS.greenScreenIncludeAudio === true;
  greenScreenAudioToggle.addEventListener('change', () => {
    MaweSettings.updateEditorSettings({ greenScreenIncludeAudio: greenScreenAudioToggle.checked });
  });
}
document.getElementById('download-green-screen-video')?.addEventListener('click', () => {
  void runBurnVideoJob({
    button: document.getElementById('download-green-screen-video'),
    greenScreen: true,
    label: '生成绿幕视频',
    startHint: '正在生成绿幕字幕视频…（绿幕导出不含表情包）',
    successText: '绿幕视频已保存',
    suggestedName: `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('green-screen') || 'green-screen'}.mp4`,
    buildRequest: () => ({ ass: MaweExportSrt.buildAss(), greenScreen: true,
      includeAudio: MaweSettings.EDITOR_SETTINGS.greenScreenIncludeAudio === true }),
  });
});

// 绿幕适用于音视频工程，不要求打开 ASS 预览模式。
// 服务端视频工程可烧录：ASS 使用当前方案，SRT 由服务端应用样式库默认槽位。
// ASS 模式切换由 editor-wiring-ass-manager.js 的 syncAssModeControl 调用 syncButton 同步。
function updateBurnVideoButton() {
  const config = MaweBoot.SERVER_CONFIG;
  const visible = burnVideoMediaCurrent(config);
  const button = document.getElementById('burn-video-export-btn');
  if (button) button.hidden = !visible;
  const gapButton = document.getElementById('download-gap-removed-burn-video');
  if (gapButton) gapButton.hidden = !visible;
  const greenVisible = burnVideoMediaCurrent(config, true);
  const greenButton = document.getElementById('download-green-screen-video');
  if (greenButton) {
    greenButton.hidden = !greenVisible;
    greenButton.setAttribute('aria-disabled', String(!greenVisible));
  }
  document.querySelectorAll('[data-settings-export="download-green-screen-video"]').forEach(button => {
    button.disabled = !greenVisible;
  });
}

function invalidateBurnVideoBinding() {
  const config = MaweBoot.SERVER_CONFIG;
  if (config) {
    config.canBurnVideoExport = false;
    config.canGreenScreenExport = false;
    config.burnVideoSourceName = null;
    config.burnVideoJobsUrl = null;
  }
  updateBurnVideoButton();
  // Admission/body/write operations may be pending without another poll.
  // Cancel through the task's captured URL/token, not the invalidated config.
  window.__maweBurnVideoTask?.requestStop?.();
}
const nativeBurnConnection = connectNativeBurn();
updateBurnVideoButton();
window.MaweBurnVideoExport = Object.freeze({ syncButton: updateBurnVideoButton, invalidateBinding: invalidateBurnVideoBinding });

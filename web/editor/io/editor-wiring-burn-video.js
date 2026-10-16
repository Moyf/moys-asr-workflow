// === 编辑器「烧录视频」：调用服务端 FFmpeg (libass) 把当前工程 ASS 字幕烧录进视频 ===
// 与「去空隙导出 → 重组后视频」同一套媒体任务生命周期（准入令牌 / 轮询 / 流式下载 /
// 取消与临时文件确认），但只支持 jobs API：烧录总是重新编码并输出 MP4。
// 两个入口共享本模块的 runBurnVideoJob：
// - 「更多导出 → 烧录字幕视频」：完整源视频 + 原时间轴 ASS；
// - 「去空隙导出 → 重组后烧录视频」：ffconcat 保留区间 + 收缩时间轴 ASS（帧级精确切点）。

const BURN_VIDEO_MIME = 'video/mp4';
// 烧录阶段文本：key 与服务端 MediaJob.stage 对齐。
const BURN_VIDEO_STAGES = {
  preparing: '正在读取源视频信息…',
  burning: '正在烧录字幕…',
};

function burnVideoText(text) {
  return window.MAWE_I18N?.translateText?.(text) || text;
}

function burnVideoMediaCurrent(config) {
  if (config?.canBurnVideoExport !== true || !config.burnVideoJobsUrl) return false;
  const player = window.MaweCoreState?.player;
  const source = player?.currentSrc || player?.querySelector?.('source')?.src || player?.src;
  if (!source) return false;
  try {
    const url = new URL(source, location.href);
    return url.origin === location.origin && url.pathname === '/media';
  } catch (_) { return false; }
}

function burnVideoBindingCurrent(config, snapshot) {
  return burnVideoMediaCurrent(config) && MaweBoot.SERVER_CONFIG === config
    && config.burnVideoJobsUrl === snapshot.jobsUrl
    && config.requestToken === snapshot.requestToken
    && config.bindingGeneration === snapshot.bindingGeneration
    && config.sourceMediaId === snapshot.sourceMediaId
    && config.burnVideoSourceName === snapshot.sourceName
    && window.MaweProjectLoad?.projectBindingEpoch === snapshot.bindingEpoch;
}

function burnVideoSafeError(error, fallback) {
  const message = error?.message || error;
  if (typeof message !== 'string' || !message || message.length > 240
      || /extract_extradata|No start code|Invalid data found|[A-Z]:[\\/]|maw-media-job-/i.test(message)) {
    return burnVideoText(fallback);
  }
  return burnVideoText(message);
}

async function runBurnVideoJob({ button, label, buildRequest, suggestedName, startHint, successText }) {
  const tr = burnVideoText;
  const config = MaweBoot.SERVER_CONFIG;
  if (window.__maweBurnVideoTask) return;
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  if (!burnVideoMediaCurrent(config) || !Number.isSafeInteger(config.bindingGeneration) || config.bindingGeneration < 1
      || typeof config.sourceMediaId !== 'string' || !config.sourceMediaId
      || typeof config.burnVideoSourceName !== 'string' || !config.burnVideoSourceName) {
    MaweHint.flashHint(tr('请从启动器打开关联源媒体的工程，再烧录视频'), 'warning');
    return;
  }
  if (!MaweHost.files.hasSavePicker()) {
    MaweHint.flashHint(tr('当前浏览器或环境不支持烧录视频保存'), 'warning');
    return;
  }
  const requestToken = config.requestToken;
  const bindingGeneration = config.bindingGeneration;
  const sourceMediaId = config.sourceMediaId;
  const sourceName = config.burnVideoSourceName;
  const jobsUrl = config.burnVideoJobsUrl;
  const bindingEpoch = window.MaweProjectLoad?.projectBindingEpoch;
  const snapshot = { jobsUrl, requestToken, bindingGeneration, sourceMediaId, sourceName, bindingEpoch };
  const isBindingCurrent = () => burnVideoBindingCurrent(config, snapshot);

  let request;
  try {
    request = buildRequest();
  } catch (error) {
    MaweHint.flashHint(`${tr('无法准备 ASS 字幕内容')}：${burnVideoSafeError(error, '请检查字幕样式后重试')}`, 'warning');
    return;
  }
  if (!request) return; // buildRequest 已经提示过原因（如没有可用的去空隙区间）。

  MaweHint.flashHint(tr(startHint), 'warning');
  let handle;
  try {
    handle = await MaweHost.files.pickSaveFile({
      suggestedName,
      types: [{ description: tr(label), accept: { [BURN_VIDEO_MIME]: ['.mp4'] } }],
    });
  } catch (error) {
    if (error?.name === 'AbortError') return;
    MaweHint.flashHint(`${tr('无法打开视频保存位置选择器')}：${burnVideoSafeError(error, '请检查保存位置权限后重试')}`, 'warning');
    return;
  }
  // 选择器等待期间工程或绑定可能已切换；绝不混合旧字幕快照与新绑定。
  if (!isBindingCurrent()) {
    MaweHint.flashHint(tr('工程或媒体绑定已变更，请重新发起视频烧录'), 'warning');
    return;
  }
  if (handle.name.toLowerCase() === sourceName.toLowerCase()) {
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
    MaweHint.flashHint(burnVideoSafeError(error, '无法确认导出已停止，请重试'), 'warning');
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
            body: JSON.stringify({ requestToken, admissionToken: task.admissionToken }),
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
            headers: { 'X-MAW-Request-Token': requestToken }, signal: controller.signal,
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
    if (!task || task.stopRequested || committing) return;
    task.stopRequested = true;
    task.controller.abort();
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
    const random = crypto.getRandomValues(new Uint8Array(32));
    const admissionToken = Array.from(random, value => value.toString(16).padStart(2, '0')).join('');
    task = { id: null, admissionToken, controller: new AbortController(), stopRequested: false, cancelRequest: null, requestStop };
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestToken, bindingGeneration, sourceMediaId, ...request,
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
      if (['failed', 'cancelled', 'completed'].includes(state.state)) throw new Error(state.error || tr('导出状态异常，请重试'));
      const percent = state.stage === 'burning' && typeof state.progress === 'number' ? state.progress : null;
      setProgress(tr(BURN_VIDEO_STAGES[state.stage] || '正在准备导出…')
        + (percent === null ? '' : ` ${Math.round(percent * 100)}%`), percent);
      await raceStop(pause());
      const poll = await raceStop(MaweHost.server.fetch(`${jobsUrl}/${encodeURIComponent(task.id)}`, {
        headers: { 'X-MAW-Request-Token': requestToken }, signal: task.controller.signal,
      }));
      state = await raceStop(poll.json());
      if (!poll.ok) throw new Error(state.error || `服务器返回 ${poll.status}`);
    }
    ensureCurrent();
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
    MaweHint.flashHint(tr(successText), 'success');
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
      MaweHint.flashHint(`${tr('烧录视频导出失败')}：${burnVideoSafeError(error, '媒体处理失败，请确认源文件可以正常播放后重试')}`, 'warning');
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

// 入口一：工具栏「烧录视频」按钮（去空隙导出左侧）。完整源视频 + 原时间轴 ASS。
document.getElementById('burn-video-export-btn')?.addEventListener('click', () => {
  void runBurnVideoJob({
    button: document.getElementById('burn-video-export-btn'),
    label: '烧录视频',
    startHint: 'FFmpeg 将重新编码源视频并烧录当前 ASS 字幕；长视频可能需要较长时间。',
    successText: '烧录视频已保存',
    suggestedName: `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('subtitled') || 'subtitled'}.mp4`,
    buildRequest: () => ({ ass: MaweExportSrt.buildAss() }),
  });
});

// 入口二：「去空隙导出 → 重组后烧录视频」。保留区间 + 收缩时间轴 ASS；重新编码使切点帧级精确。
document.getElementById('download-gap-removed-burn-video')?.addEventListener('click', () => {
  void runBurnVideoJob({
    button: document.getElementById('download-gap-removed-burn-video'),
    label: '重组后烧录视频',
    startHint: '按保留区域重新编码并烧录当前 ASS 字幕；切点帧级精确。',
    successText: '重组后烧录视频已保存',
    suggestedName: `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}_${window.MAWE_I18N?.exportTag?.('subtitled') || 'subtitled'}.mp4`,
    buildRequest: () => {
      const context = MaweExportSrt.gapRemovedExportContext();
      if (!context) return null;
      const ass = MaweExportSrt.buildGapRemovedAss();
      if (!ass) return null;
      return { ass, intervals: context.intervals.map(({ start, end }) => ({ startMs: start, endMs: end })) };
    },
  });
});

// 服务端视频工程 + ASS 字幕模式同时满足时才显示烧录按钮；去空隙入口随所在菜单显隐。
// ASS 模式切换由 editor-wiring-ass-manager.js 的 syncAssModeControl 调用 syncButton 同步。
function updateBurnVideoButton() {
  const config = MaweBoot.SERVER_CONFIG;
  const assMode = window.MaweSettings?.EDITOR_SETTINGS?.assMode === true;
  const visible = burnVideoMediaCurrent(config) && assMode;
  const button = document.getElementById('burn-video-export-btn');
  if (button) button.hidden = !visible;
  const gapButton = document.getElementById('download-gap-removed-burn-video');
  if (gapButton) gapButton.hidden = !visible;
}

function invalidateBurnVideoBinding() {
  const config = MaweBoot.SERVER_CONFIG;
  if (config) {
    config.canBurnVideoExport = false;
    config.burnVideoSourceName = null;
    config.burnVideoJobsUrl = null;
  }
  updateBurnVideoButton();
  // Admission/body/write operations may be pending without another poll.
  // Cancel through the task's captured URL/token, not the invalidated config.
  window.__maweBurnVideoTask?.requestStop?.();
}
updateBurnVideoButton();
window.MaweBurnVideoExport = Object.freeze({ syncButton: updateBurnVideoButton, invalidateBinding: invalidateBurnVideoBinding });

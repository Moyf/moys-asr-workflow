// PNG/WebP rendering uses the local task API. The export plan/ASS are captured before
// the first await; polling and publication never reread mutable project data.
export async function runFcp7PngExport({ plan, ass, layers, imageFormat = 'png', includeMedia, size, config, onProgress, signal }) {
  if (!config?.fcp7PngJobsUrl) throw new Error('请从本地编辑器服务导出图片字幕');
  const jobsUrl = config.fcp7PngJobsUrl;
  const binding = { requestToken: config.requestToken, bindingGeneration: config.bindingGeneration,
    sourceMediaId: config.sourceMediaId };
  const epoch = window.MaweProjectLoad?.projectBindingEpoch;
  const admissionToken = Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('');
  let jobId = null;
  let published = false;
  const current = () => MaweBoot.SERVER_CONFIG === config
    && config.bindingGeneration === binding.bindingGeneration && config.sourceMediaId === binding.sourceMediaId
    && window.MaweProjectLoad?.projectBindingEpoch === epoch;
  const post = async (url, data, keepalive = false) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...binding, ...data }), keepalive });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || '图片字幕请求失败');
    return { ...result, openFolderUrl: `${jobsUrl}/${jobId}/open-folder` };
  };
  const cancel = () => post(jobId ? `${jobsUrl}/${jobId}/cancel` : `${jobsUrl}/cancel-admission`, { admissionToken }, true);
  const aborted = () => {
    if (signal.aborted) throw new DOMException('图片字幕导出已停止', 'AbortError');
    if (!current()) throw new Error('工程或媒体绑定已变更，已停止图片字幕导出');
  };
  const cancelOnAbort = () => { void cancel().catch(() => {}); };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  window.addEventListener('pagehide', cancelOnAbort, { once: true });
  try {
    aborted();
    size ||= MaweExportSrt.currentAssVideoResolution() || { width: 1920, height: 1080 };
    const response = await post(jobsUrl, { ass, layers, fps: plan.frameProfile.name,
      width: size.width, height: size.height, durationMs: plan.outputDurationMs, imageFormat, admissionToken });
    jobId = response.jobId;
    let state = response;
    while (state.state !== 'ready') {
      aborted();
      if (['failed', 'cancelled', 'cancelling'].includes(state.state)) throw new Error(state.error || '图片字幕导出已停止');
      onProgress(state.progress == null ? '正在准备字幕图片…' : `正在生成字幕图片：${Math.round(state.progress * 100)}%`, state.progress);
      await new Promise(resolve => setTimeout(resolve, 300));
      aborted();
      const poll = await fetch(`${jobsUrl}/${jobId}`, { headers: { 'X-MAW-Request-Token': binding.requestToken } });
      state = await poll.json();
      if (!poll.ok || state.ok === false) throw new Error(state.error || '无法查询图片字幕任务');
    }
    aborted();
    const sourcePlan = { ...plan, media: { ...plan.media, type: state.manifest.sourceKind } };
    const xml = window.AsrEditorUtils.serializeFcp7PngXml(sourcePlan, state.manifest, { includeMedia });
    onProgress('正在保存 XML 与图片素材…');
    const result = await post(`${jobsUrl}/${jobId}/publish`, { xml });
    published = true;
    return result;
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    window.removeEventListener('pagehide', cancelOnAbort);
    if (!published) {
      if (jobId) onProgress('正在停止并清理图片字幕任务…');
      try {
        const deadline = Date.now() + 10000;
        let state = await cancel();
        while (!state.cleanupComplete && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 250));
          state = await cancel();
        }
        if (!state.cleanupComplete) throw new Error(state.cleanupError || '清理尚未完成');
      } catch (error) {
        throw new Error(`无法确认图片字幕任务已清理，请稍后重试：${error.message}`);
      }
    }
  }
}

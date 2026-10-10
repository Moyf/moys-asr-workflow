// 完成通知与后端事件分发（handleBackendEvent）。

function completionNotificationsEnabled() { return state.config?.notifyOnComplete === true; }
function baseName(path) { const value = String(path || ""); return value.split(/[\\/]/u).pop() || value; }
function resetBatchNotification(total = 0) {
  state.batchNotification = { total: Number(total) || 0, done: 0, failed: 0, statuses: new Map() };
}
function sendSystemNotification(title, message) {
  if (!completionNotificationsEnabled()) return;
  void bridge("send_notification", { title, message });
}
function notifySingleComplete(result) {
  if (!state.running) return;
  const name = baseName(result?.srtPath || result?.jsonPath || "");
  sendSystemNotification(t("notify_single_title"), t("notify_single_body").replace("{name}", name || "-"));
}
function rememberBatchNotificationEvent(event) {
  const notification = state.batchNotification;
  if (!notification) return;
  const nested = event.item && typeof event.item === "object" ? event.item : {};
  const status = event.status || nested.status || "";
  if (!["done", "failed", "cancelled", "skipped"].includes(status)) return;
  const key = String(event.itemId ?? event.id ?? nested.itemId ?? nested.id ?? (event.index ?? nested.index ?? ""));
  if (!key) return;
  const previous = notification.statuses.get(key);
  if (previous === status) return;
  if (previous === "done") notification.done -= 1;
  if (previous === "failed") notification.failed -= 1;
  notification.statuses.set(key, status);
  if (status === "done") notification.done += 1;
  if (status === "failed") notification.failed += 1;
}
function notifyBatchComplete(event) {
  if (!state.batchNotification) return;
  // 用户主动停止不算「完成」，不打扰。
  if (event.status === "cancelled" || event.cancelled) {
    state.batchNotification = null;
    return;
  }
  const outcomes = Array.isArray(event.outcomes) ? event.outcomes : [];
  let done = 0;
  let failed = 0;
  outcomes.forEach((outcome) => {
    if (!outcome || typeof outcome !== "object") return;
    if (outcome.status === "done") done += 1;
    else if (outcome.status === "failed") failed += 1;
  });
  if (!outcomes.length) {
    // worker 异常可能没有产出 outcomes；沿用已收到的逐条事件，并把
    // 尚未落到终态的当前批次条目按失败计入，不能误报为「全部完成」。
    const total = Number(event.total) || Number(state.batchNotification?.total) || 0;
    done = Number(state.batchNotification?.done) || 0;
    failed = Number(state.batchNotification?.failed) || 0;
    if (event.status === "failed") {
      failed += Math.max(0, total - done - failed);
      if (!failed && !done) failed = 1;
    } else if (!done && !failed) {
      // 静态演示模式没有逐条结果。
      done = total;
    }
  } else if (event.status === "failed") {
    const total = Number(event.total) || Number(state.batchNotification?.total) || 0;
    failed += Math.max(0, total - done - failed);
    if (!failed && !done) failed = 1;
  }
  const body = failed > 0
    ? t("notify_batch_body").replace("{done}", String(done)).replace("{failed}", String(failed))
    : t("notify_batch_body_all").replace("{done}", String(done));
  sendSystemNotification(failed > 0 || event.status === "failed" ? t("notify_batch_failed_title") : t("notify_batch_title"), body);
  state.batchNotification = null;
}

function notifySingleFailure(event) {
  if (!state.running || ["transcription_cancelled", "postprocess_cancelled"].includes(event.code)) return;
  const name = baseName($("mediaPath")?.value || event.originalSrtPath || event.originalProjectPath || "");
  const rawDetail = redactSensitive(compactDetail(event.detail || event.message || ""));
  const friendly = event.code ? errText(event.code, rawDetail, event) : rawDetail || t("failed");
  const error = [friendly, rawDetail && friendly !== rawDetail && !friendly.includes(rawDetail) ? rawDetail : ""]
    .filter(Boolean)
    .join(" ") || t("failed");
  const body = t("notify_single_failed_body")
    .replace("{name}", name || "-")
    .replace("{error}", error);
  sendSystemNotification(t("notify_single_failed_title"), body);
}

function handleBackendEvent(event) {
  if (event.type === "updateCheckCompleted") {
    state.updateManualCheck = Boolean(event.manual);
    setUpdateResult(event.result || {}, Boolean(event.manual));
    if (event.manual && event.result?.ok && !event.result?.available && !event.result?.errorCode) setStatus(t("update_up_to_date"));
    resolveUpdateCheckWaiter();
    return;
  }
  if (event.type === "updateDownloadProgress") {
    state.updateDownloading = true;
    state.updateProgress = Math.max(0, Math.min(100, Number(event.percent || 0)));
    if (event.tag) state.updateReadyTag = String(event.tag);
    renderUpdate();
    return;
  }
  if (event.type === "updateReady") {
    state.updateDownloading = false;
    state.updateReady = true;
    state.updateReadyTag = String(event.tag || state.update?.latestTag || "");
    state.updateProgress = 100;
    state.updateError = "";
    state.updateErrorCode = "";
    state.updateErrorDetail = "";
    state.update = { ...(state.update || {}), downloaded: true, downloadPath: event.path || "", latestTag: state.updateReadyTag, latestVersion: event.version || state.update?.latestVersion || "" };
    renderUpdate();
    setStatus(t("update_download_ready"));
    return;
  }
  if (event.type === "updateFailed") {
    const manual = event.stage !== "check" || event.manual === true;
    handleUpdateFailure(event, manual);
    if (event.stage === "check") resolveUpdateCheckWaiter();
    return;
  }
  if (event.type === "batch_started" || event.type === "batchStarted") {
    resetBatchNotification(event.total);
  }
  if (event.type === "batch_item" || event.type === "batchItem") rememberBatchNotificationEvent(event);
  if (event.type === "done") notifySingleComplete(event.result);
  if (event.type === "batch_done" || event.type === "batchDone") notifyBatchComplete(event);
  if (event.type === "error") notifySingleFailure(event);
  if (["batchStarted", "batchItem", "batchItemLog", "batchDone", "batch_started", "batch_item", "batch_item_log", "batch_done"].includes(event.type)) window.MAWLauncher?.onBatchEvent?.(event);
  if (event.type === "emojiFontReady" && event.path) injectEmojiFont(event.path);
  if (event.type === "log") appendLog(event.message, { quietLatest: Boolean(state.localRuntimeInstalling || state.ocrRuntimeInstalling || state.alignmentPreparing) });
  if (event.type === "postprocess_status") window.MAWLauncher?.onPostprocessStatus?.(event);
  if (event.type === "postprocess_stream") window.MAWLauncher?.onPostprocessStream?.(event);
  if (event.type === "postprocess_pipeline") window.MAWLauncher?.onPostprocessPipeline?.(event);
  if (event.type === "media_tool_log") window.MAWLauncher?.onMediaToolLog?.(event);
  if (event.type === "modelProgress") {
    state.localProgressMessage = event.message || "";
    state.localProgress = event;
    renderLocalModelStatus();
  }
  if (event.type === "modelPrepared") {
    state.localPreparing = false;
    state.localProgressMessage = "";
    state.localProgress = null;
    const model = provider().models.find((item) => item.id === event.modelId);
    if (model && event.status) model.localStatus = event.status;
    renderLocalModelStatus();
    setStatus(t("local_prepare_done"));
    appendLog(t("local_prepare_done"));
  }
  if (event.type === "localPrepareCancelled") {
    state.localPreparing = false;
    state.localProgressMessage = "";
    state.localProgress = null;
    void refreshLocalModels();
    renderLocalModelStatus();
    setStatus(t("local_prepare_cancelled"));
    appendLog(t("local_prepare_cancelled"));
  }
  if (event.type === "alignmentModelProgress") {
    state.alignmentProgressMessage = event.message || "";
    renderLocalAlignmentModel();
  }
  if (event.type === "alignmentModelPrepared") {
    state.alignmentPreparing = "";
    state.alignmentProgressMessage = "";
    const model = (state.config?.alignmentModels || []).find((item) => item.id === event.modelId);
    if (model) {
      model.status = event.status || "installed";
      model.installed = true;
      model.runtimeAvailable = true;
    }
    renderLocalAlignmentModel();
    void refreshAlignmentModels();
    setStatus(t("alignment_model_ready"));
    appendLog(t("alignment_model_ready"));
  }
  if (event.type === "alignmentPrepareCancelled") {
    state.alignmentPreparing = "";
    state.alignmentProgressMessage = "";
    renderLocalAlignmentModel();
    void refreshAlignmentModels();
    setStatus(t("alignment_model_cancelled"));
  }
  if (event.type === "localRuntimeProgress") {
    const runtime = state.config?.localRuntime || {};
    if (state.localRuntimeInstalling || runtime.status === "installing") {
      state.localRuntimeProgress = Number(event.percent || 0);
      state.localRuntimeProgressMessage = event.message || "";
      renderLocalRuntime();
    }
  }
  if (event.type === "localRuntimeReady") {
    const runtime = state.config?.localRuntime || {};
    const wasInstalling = state.localRuntimeInstalling || runtime.status === "installing";
    state.localRuntimeInstalling = false;
    state.localRuntimeProgress = 100;
    state.localRuntimeProgressMessage = "";
    renderLocalRuntime();
    if (wasInstalling) {
      void refreshLocalModels();
      void refreshAlignmentModels();
      void refreshLocalRuntimeInventory();
      setStatus(t("local_runtime_install_done"));
      appendLog(t("local_runtime_install_done"));
    }
  }
  if (event.type === "localRuntimeCancelled") {
    const runtime = state.config?.localRuntime || {};
    const wasInstalling = state.localRuntimeInstalling || runtime.status === "installing";
    state.localRuntimeInstalling = false;
    state.localRuntimeProgressMessage = "";
    renderLocalRuntime();
    if (wasInstalling) {
      void refreshLocalModels();
      void refreshAlignmentModels();
      setStatus(t("local_runtime_cancelled"));
      appendLog(t("local_runtime_cancelled"));
    }
  }
  if (event.type === "ocrRuntimeProgress") {
    const runtime = state.config?.ocrRuntime || {};
    if (state.ocrRuntimeInstalling || runtime.status === "installing") {
      state.ocrRuntimeProgress = Number(event.percent || 0);
      state.ocrRuntimeProgressMessage = event.message || "";
      renderOcrRuntime();
    }
  }
  if (event.type === "ocrRuntimeReady") {
    const runtime = state.config?.ocrRuntime || {};
    const wasInstalling = state.ocrRuntimeInstalling || runtime.status === "installing";
    state.ocrRuntimeInstalling = false;
    state.ocrRuntimeProgress = 100;
    state.ocrRuntimeProgressMessage = "";
    renderOcrRuntime();
    if (wasInstalling) {
      void refreshOcrRuntime();
      setStatus(t("ocr_runtime_install_done"));
      appendLog(t("ocr_runtime_install_done"));
    }
  }
  if (event.type === "ocrRuntimeCancelled") {
    const runtime = state.config?.ocrRuntime || {};
    const wasInstalling = state.ocrRuntimeInstalling || runtime.status === "installing";
    state.ocrRuntimeInstalling = false;
    state.ocrRuntimeProgressMessage = "";
    renderOcrRuntime();
    if (wasInstalling) {
      void refreshOcrRuntime();
      setStatus(t("ocr_runtime_cancelled"));
      appendLog(t("ocr_runtime_cancelled"));
    }
  }
  if (event.type === "error" && event.code === "local_prepare_failed") {
    state.localPreparing = false;
    state.localProgressMessage = "";
    state.localProgress = null;
    // 与本地运行环境安装失败保持一致：失败时自动滚到日志区看 [detail]。
    $("logTitle")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (event.type === "error" && event.code === "alignment_prepare_failed") {
    state.alignmentPreparing = "";
    state.alignmentProgressMessage = "";
    renderLocalAlignmentModel();
    void refreshAlignmentModels();
  }
  if (event.type === "error" && ["local_runtime_install_failed", "local_runtime_cancelled"].includes(event.code)) {
    const runtime = state.config?.localRuntime || {};
    if (state.localRuntimeInstalling || runtime.status === "installing") {
      state.localRuntimeInstalling = false;
      state.localRuntimeProgressMessage = "";
      void refreshLocalModels();
      renderLocalRuntime();
      if (event.code === "local_runtime_install_failed") $("logTitle")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      return;
    }
  }
  if (event.type === "error" && ["ocr_runtime_install_failed", "ocr_runtime_cancelled"].includes(event.code)) {
    const runtime = state.config?.ocrRuntime || {};
    if (state.ocrRuntimeInstalling || runtime.status === "installing") {
      state.ocrRuntimeInstalling = false;
      state.ocrRuntimeProgressMessage = "";
      void refreshOcrRuntime();
      renderOcrRuntime();
      if (event.code === "ocr_runtime_install_failed") $("logTitle")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      return;
    }
  }
  if (event.type === "error") {
    setRunning(false);
    $("retryPostprocess")?.classList.toggle("hidden", !event.canRetry);
    if (event.originalSrtPath) $("srtPath").value = String(event.originalSrtPath);
    if (event.originalProjectPath) $("jsonPath").value = String(event.originalProjectPath);
    if (event.originalSrtPath || event.originalProjectPath) $("openFolder")?.classList.remove("hidden");
    const detail = event.detail || event.message || "";
    const diagnostics = diagnosticText(event.diagnostics);
    const message = event.code ? errText(event.code, detail, event) : detail || t("failed");
    // 友好提示归错误卡片与 status；复制报告同时保留 detail 和诊断信息。
    setStatus(message);
    if (detail) appendLog(`[detail] ${detail}`);
    if (diagnostics) appendLog("[diagnostics] " + diagnostics);
    showErrorNotice(message, event.code || "", detail, diagnostics, event.errorContext);
    renderLocalModelStatus();
  }
  if (event.type === "done") {
    state.result = event.result;
    setRunning(false);
    hideErrorNotice();
    $("retryPostprocess")?.classList.add("hidden");
    if (event.result?.srtPath) $("srtPath").value = event.result.srtPath;
    setJsonPath(event.result?.jsonPath || "");
    $("openMawe").classList.add("attention");
    $("openFolder").classList.remove("hidden");
    syncHtmlMenu();
    appendLog(t("done"));
    if (event.result?.videoPath) appendLog(`${t("toolbox_burn_done")}\n${event.result.videoPath}`);
    void checkExistingServer(t("done"));
  }
  if (event.type === "dropMedia" && !state.dropTarget && window.MAWLauncher?.onBatchDrop?.(event.path || "")) return;
  if (event.type === "dropReject" && !state.dropTarget && window.MAWLauncher?.onBatchDropReject?.(event.path || "")) return;
  if (event.type === "dropMedia" || event.type === "dropJson" || event.type === "dropSubtitle" || event.type === "dropHotwordFile" || event.type === "dropFfconcat" || event.type === "dropReject") handleRoutedDrop(event.path || "");
}
window.MAWLauncher = { backend: "pending", config: null, callBackend: bridge, translate: t, errorText: errText, viewportPixelsToPage, openSettings, closeSettings, setJsonPath, openServerEditor, openPreferredEditor, getAudioTrackForMedia, getTranscriptionPayload: formPayload, appendLog, confirm: confirmAction, confirmResolve: null, onBackendEvent: handleBackendEvent, onBackendEvents(events) { events.forEach(handleBackendEvent); }, onBatchStart() { hideErrorNotice(); resetBatchNotification(); }, onBatchError: (result) => { state.batchNotification = null; applyErrorResult(result, false); }, onLanguageChanged() {}, onProjectPathChanged() {}, onAlignmentModelsChanged() {}, onMediaPathChanged() {} };

$("langZh").addEventListener("click", () => setLanguage("zh"));
$("langEn").addEventListener("click", () => setLanguage("en"));
$("themeLight").addEventListener("click", () => setTheme("light")); $("themeDark").addEventListener("click", () => setTheme("dark")); $("themeSystem").addEventListener("click", () => setTheme("system"));
document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
  tab.addEventListener("click", () => selectSettingsTab(tab.dataset.settingsTab));
  tab.addEventListener("keydown", (event) => {
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) moveSettingsFocus(event);
  });
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (state.theme === "system") applyTheme(); });
$("homeLink").addEventListener("click", () => bridge("open_url", { url: HOME_URL }));
$("appVersion").addEventListener("click", () => { openSettings("updateSettingsSection"); void checkForUpdates(true); });
$("updateNoticeAction").addEventListener("click", () => openSettings("updateSettingsSection"));
$("checkUpdate").addEventListener("click", () => { void checkForUpdates(true); });
$("updateNow").addEventListener("click", () => { void startOrApplyUpdate(); });
$("updateCancel").addEventListener("click", () => { void cancelUpdateDownload(); });
$("updateOpenRelease").addEventListener("click", () => { void openUpdateRelease(); });
$("autoUpdateCheck").addEventListener("change", async () => {
  const enabled = $("autoUpdateCheck").checked;
  const result = await bridge("set_update_preferences", { autoCheck: enabled });
  if (!result.ok) {
    $("autoUpdateCheck").checked = !enabled;
    handleUpdateFailure(result, true);
    return;
  }
  state.update = { ...(state.update || {}), ...(result.update || {}), autoCheck: Boolean(result.autoCheck) };
  renderUpdate();
});
$("tutorialVideoLink").addEventListener("click", () => bridge("open_url", { url: TUTORIAL_VIDEO_URL }));
$("supportLink").addEventListener("click", () => { $("supportModal").classList.remove("hidden"); $("supportClose").focus(); });
$("supportClose").addEventListener("click", () => $("supportModal").classList.add("hidden"));
$("supportBackdrop").addEventListener("click", () => $("supportModal").classList.add("hidden"));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") $("supportModal").classList.add("hidden"); });
$("errorNoticeClose").addEventListener("click", hideErrorNotice);
$("errorNoticeCopy").addEventListener("click", () => { void copyErrorReport(); });
$("errorNoticeFaq").addEventListener("click", () => { void openErrorFaq(); });
$("errorNoticeIssue").addEventListener("click", () => { void openErrorIssue(); });
$("errorNoticeAction").addEventListener("click", () => {
  const action = $("errorNotice").dataset.action;
  if (action === "ffmpeg-settings") openSettings("ffmpegSettingsSection", "ffmpegPath");
});
$("provider").addEventListener("change", () => applyProvider(true)); $("model").addEventListener("change", () => { applySelectedModel(true); if (isLocalProvider()) { void refreshLocalRuntime(); void refreshLocalModels(); } }); $("fireRedPunc").addEventListener("change", () => setError("fireRedPunc", "")); $("language").addEventListener("change", () => savePrefsDebounced({ language: languageValue() })); $("audioTrack").addEventListener("change", () => { const value = Number($("audioTrack").value); if (Number.isInteger(value) && value >= 0) state.audioTrack = value; }); $("advancedToggle").addEventListener("click", () => toggle("advancedCard"));
$("testRun").addEventListener("change", syncTestRun);
$("openaiModel").addEventListener("input", () => { if (isCustomOpenAiModel()) state.config.openaiCustomModel = $("openaiModel").value.trim(); });
$("generateHtml").addEventListener("change", syncHtmlMenu);
$("mediaPath").addEventListener("input", () => { setError("mediaPath", ""); setOutputNotice(""); syncFlvHints(); syncDefaultOutput(); scheduleAudioTrackProbe($("mediaPath").value); }); $("srtPath").addEventListener("input", () => { state.srtAuto = false; state.testSuffixAdded = false; setError("srtPath", ""); setOutputNotice(""); });
$("pickMedia").addEventListener("click", async () => { const result = await bridge("choose_file", { kind: "media" }); if (!result.ok) return; if (!MEDIA_EXTS.has(ext(result.path))) { setError("mediaPath", mediaDropError()); return; } setMedia(result.path); });
$("qwenAudioHotwordsModeText").addEventListener("click", () => { setHotwordsMode("text"); setError("qwenAudioHotwordsFile", ""); }); $("qwenAudioHotwordsModeFile").addEventListener("click", () => { setHotwordsMode("file"); setError("qwenAudioHotwordsFile", ""); }); $("pickQwenAudioHotwordsFile").addEventListener("click", async () => { const result = await bridge("choose_file", { kind: "hotwords" }); if (result.ok) await loadHotwordFile(result.path || "", false); });
$("pickJson").addEventListener("click", async () => { const result = await bridge("choose_file", { kind: "json" }); if (result.ok) setJsonPath(result.path); });
$("jsonPath").addEventListener("input", () => setError("jsonPath", "")); $("jsonPath").addEventListener("change", refreshServerMedia); $("pickServerMedia").addEventListener("click", async () => { const result = await bridge("choose_file", { kind: "media" }); if (result.ok) setServerMedia(result.path || ""); });
["apiKey", "openaiBaseUrl", "openaiModel", "openaiPrompt", "openaiKeywords", "workspaceId", "qwenAudioContext", "qwenAudioHotwords", "qwenAudioHotwordsFile", "qwenAudioHotwordWeight", "sonioxContextGeneral", "sonioxContextText", "sonioxContextTerms", "sonioxContextTranslationTerms", "serverMediaPath", "port", "ffmpegPath", "stickerDir"].forEach((field) => { const el = $(field); el?.addEventListener("input", () => { setError(field, ""); if (field === "openaiBaseUrl") { renderModelNote(); syncOpenAiAdvancedOptions(selectedModel()); } if (field === "qwenAudioContext") renderPromptCharacterCount(); if (field.startsWith("sonioxContext")) renderSonioxContextCharacterCount(); if (field === "qwenAudioHotwords") renderHotwordWarnings(); if (field === "qwenAudioHotwordWeight") renderHotwordWarnings(); if (field === "serverMediaPath") syncFlvHints(); if (field === "port") { stopServerStatusMonitor(); serverRestartProjectPath = null; state.serverRunning = false; state.serverProjectPath = ""; state.detectedServerUrl = ""; renderServerButton(); } }); el?.addEventListener("change", () => { setError(field, ""); if (field === "openaiBaseUrl") { renderModelNote(); syncOpenAiAdvancedOptions(selectedModel()); } if (field.startsWith("sonioxContext")) renderSonioxContextCharacterCount(); if (field === "qwenAudioHotwordWeight") renderHotwordWarnings(); if (field === "serverMediaPath") syncFlvHints(); if (field === "port") void checkExistingServer(); }); });
$("refreshServerStatus").addEventListener("click", async () => { $("refreshServerStatus").disabled = true; try { await checkExistingServer(); } finally { $("refreshServerStatus").disabled = false; } });
$("openKeyUrl").addEventListener("click", () => bridge("open_url", { url: provider().keyUrl }));
$("openRouterKeyUrl").addEventListener("click", () => bridge("open_url", { url: provider().secondaryKeyUrl || "https://openrouter.ai/keys" }));
$("pickLocalModelPath").addEventListener("click", async () => { const result = await bridge("choose_folder", { kind: "model" }); if (result.ok) { $("localModelPath").value = result.path; state.localModelPaths[selectedModel().id] = result.path; setError("localModelPath", ""); await savePrefsNow({ localModelPaths: { ...state.localModelPaths } }); await refreshLocalModels(); } });
$("pickLocalModelCachePath").addEventListener("click", async () => { const result = await bridge("choose_folder", { kind: "model-cache" }); if (result.ok) { $("localModelCachePath").value = result.path; await saveLocalModelCache(result.path); } });
$("localModelCachePath").addEventListener("input", () => setError("localModelCachePath", ""));
$("localModelCachePath").addEventListener("change", async () => { await saveLocalModelCache($("localModelCachePath").value); });
$("pickOcrRuntimePath").addEventListener("click", async () => { const result = await bridge("choose_folder", { kind: "ocr-runtime" }); if (result.ok) { $("ocrRuntimePath").value = result.path; await saveOcrRuntimePath(result.path); } });
$("ocrRuntimePath").addEventListener("input", () => setError("ocrRuntimePath", ""));
$("ocrRuntimePath").addEventListener("change", async () => { await saveOcrRuntimePath($("ocrRuntimePath").value); });
$("pickLocalRuntimePath").addEventListener("click", async () => { const result = await bridge("choose_folder", { kind: "runtime" }); if (result.ok) { $("localRuntimePath").value = result.path; await saveLocalRuntimePath(result.path); } });
$("localRuntimePath").addEventListener("input", () => setError("localRuntimePath", ""));
$("localRuntimePath").addEventListener("change", async () => { await saveLocalRuntimePath($("localRuntimePath").value); });
$("refreshOcrRuntime").addEventListener("click", async () => { $("refreshOcrRuntime").disabled = true; try { await refreshOcrRuntime(); } finally { $("refreshOcrRuntime").disabled = false; } });
$("installOcrRuntime").addEventListener("click", async () => { const runtime = state.config?.ocrRuntime || {}; if (state.ocrRuntimeInstalling || runtime.status === "installing") { await bridge("cancel_ocr_runtime"); return; } state.ocrRuntimeInstalling = true; state.ocrRuntimeProgress = 0; state.ocrRuntimeProgressMessage = t("ocr_runtime_installing"); renderOcrRuntime(); appendLog(t("ocr_runtime_installing")); const result = await bridge("install_ocr_runtime", { repair: state.config.ocrRuntime?.status === "broken" }); if (!result.ok) { state.ocrRuntimeInstalling = false; state.ocrRuntimeProgressMessage = ""; applyErrorResult(result); renderOcrRuntime(); } });
$("localModelPath").addEventListener("input", () => { setError("localModelPath", ""); if (isLocalProvider()) { state.localModelPaths[selectedModel().id] = $("localModelPath").value.trim(); savePrefsDebounced({ localModelPaths: { ...state.localModelPaths } }); void refreshLocalModels(); } });
$("refreshLocalRuntime").addEventListener("click", async () => { $("refreshLocalRuntime").disabled = true; try { await refreshLocalRuntime(); await refreshLocalModels(); } finally { $("refreshLocalRuntime").disabled = false; } });
$("toggleLocalRuntimeInventory").addEventListener("click", () => { void toggleLocalRuntimeInventory(); });
$("openLocalRuntimeSettings").addEventListener("click", () => { openSettings("localRuntimePanel"); void refreshLocalRuntime(); });
$("openLocalModelSettings").addEventListener("click", () => { openSettings("localAsrModelSettingsSection"); void refreshLocalModels(); void refreshAlignmentModels(); });
$("openDashscopeRegionSettings").addEventListener("click", () => openSettings("dashscopeRegionPanel"));
$("openLanguageSettings").addEventListener("click", () => openSettings("settingsLanguageSection"));
$("saveDashscopeRegionSettings").addEventListener("click", async () => { const payload = formPayload(); const result = await bridge("save_settings", payload); if (!result.ok) { applyErrorResult(result); return; } state.config.region = payload.region; state.config.workspaceId = payload.workspaceId; setStatus(t("saved")); });
$("installLocalRuntime").addEventListener("click", async () => { if (!isLocalProvider()) return; const runtime = state.config?.localRuntime || {}; if (state.localRuntimeInstalling || runtime.status === "installing") { await bridge("cancel_local_runtime"); return; } state.localRuntimeInstalling = true; state.localRuntimeProgress = 0; state.localRuntimeProgressMessage = t("local_runtime_installing"); renderLocalRuntime(); appendLog(t("local_runtime_installing")); const runtimeStatus = state.config.localRuntime?.status || ""; const result = await bridge("install_local_runtime", { modelId: $("model").value, repair: Boolean(runtimeStatus && runtimeStatus !== "missing") }); if (!result.ok) { state.localRuntimeInstalling = false; state.localRuntimeProgressMessage = ""; applyErrorResult(result); renderLocalRuntime(); } });
 $("refreshLocalModels").addEventListener("click", async () => { $("refreshLocalModels").disabled = true; try { await refreshLocalModels(); } finally { $("refreshLocalModels").disabled = false; } });
 $("prepareLocalModel").addEventListener("click", async () => { if (!isLocalProvider()) return; if (state.localPreparing) { state.localProgressMessage = t("local_prepare_cancelling"); renderLocalModelStatus(); appendLog(t("local_prepare_cancelling")); const result = await bridge("cancel_local_model"); if (!result.ok) { state.localProgressMessage = t("local_prepare_running"); applyErrorResult(result); renderLocalModelStatus(); } return; } state.localPreparing = true; state.localProgressMessage = t("local_prepare_running"); state.localProgress = null; renderLocalModelStatus(); appendLog(t("local_prepare_running")); const result = await bridge("prepare_local_model", { modelId: $("model").value, modelPath: $("localModelPath").value.trim(), device: $("localDevice").value }); if (!result.ok) { state.localPreparing = false; state.localProgressMessage = ""; state.localProgress = null; applyErrorResult(result); renderLocalModelStatus(); } else if (result.alreadyInstalled) { state.localPreparing = false; state.localProgressMessage = ""; state.localProgress = null; renderLocalModelStatus(); setStatus(t("local_installed")); } });
$("recognitionAlignmentModel").addEventListener("change", () => { state.alignmentModelSelection = $("recognitionAlignmentModel").value; setError("recognitionAlignmentModel", ""); renderLocalAlignmentModel(); });
$("prepareAlignmentModel").addEventListener("click", async () => {
  if (!isLocalProvider()) return;
  const modelId = state.alignmentModelManagementId;
  if (!modelId) return;
  if (state.alignmentPreparing) {
    if (state.alignmentPreparing !== modelId) return;
    state.alignmentProgressMessage = t("alignment_model_downloading");
    renderLocalAlignmentModel();
    const result = await bridge("cancel_alignment_model");
    if (!result.ok) {
      state.alignmentProgressMessage = "";
      applyErrorResult(result);
      renderLocalAlignmentModel();
    }
    return;
  }
  state.alignmentPreparing = modelId;
  state.alignmentProgressMessage = t("alignment_model_downloading");
  renderLocalAlignmentModel();
  appendLog(t("alignment_model_downloading"));
  const result = await bridge("prepare_alignment_model", { modelId });
  if (!result.ok) {
    state.alignmentPreparing = "";
    state.alignmentProgressMessage = "";
    applyErrorResult(result);
    renderLocalAlignmentModel();
  } else if (result.alreadyInstalled) {
    state.alignmentPreparing = "";
    state.alignmentProgressMessage = "";
    await refreshAlignmentModels();
    setStatus(t("alignment_model_ready"));
  }
});
$("ffmpegHelp").addEventListener("click", () => bridge("open_url", { url: "https://ffmpeg.org/download.html" }));
$("settingsButton").addEventListener("click", openSettings); $("settingsClose").addEventListener("click", closeSettings); $("settingsBackdrop").addEventListener("click", closeSettings); document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSettings(); });
$("batchConfirmYes").addEventListener("click", () => finishConfirm(true)); $("batchConfirmNo").addEventListener("click", () => finishConfirm(false));
$("changeFfmpeg").addEventListener("click", () => $("ffmpegPathBox").classList.remove("hidden"));
$("saveFfmpeg").addEventListener("click", async () => { const result = await bridge("save_ffmpeg_path", { path: $("ffmpegPath").value.trim() }); if (!result.ok) { const message = ffmpegSaveError(result); setError("ffmpegPath", message); setStatus(message); return; } setError("ffmpegPath", ""); await refreshFfmpeg(); setStatus(t("saved")); });
$("pickStickerDir").addEventListener("click", async () => { const result = await bridge("choose_folder"); if (result.ok) await saveStickerDirectory(result.path); });
$("stickerDir").addEventListener("change", async () => { const path = $("stickerDir").value.trim(); if (path) await saveStickerDirectory(path); });
$("stickerCurrent").addEventListener("click", async () => { const result = await bridge("open_sticker_folder"); if (!result.ok) setStatus(errText(result.code, result.detail || result.error)); });
$("showRareLangs").addEventListener("change", async () => { state.config.showRareLangs = $("showRareLangs").checked; applyProviderLanguages(provider(), selectedModel()); const result = await bridge("save_prefs", { showRareLangs: state.config.showRareLangs }); if (result.ok) setStatus(t("saved")); else applyErrorResult(result); });

// 启动接线：事件绑定、监听注册与 init() 调用（模块求值期执行）。

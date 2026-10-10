// 启动接线：事件绑定、监听注册与 init() 调用（模块求值期执行）。

const syncDefaultOutputPreview = () => { if (!state.initializing) void syncDefaultOutput(); };
const saveOutputPref = async (key) => { const on = $(key).checked; const previous = Boolean(state.config[key]); const result = await bridge("save_prefs", { [key]: on }); if (result.ok) { state.config[key] = on; setStatus(t("saved")); } else { $(key).checked = previous; state.config[key] = previous; applyErrorResult(result); } return result; };
$("outputSubfolder").addEventListener("change", async () => { await saveOutputPref("outputSubfolder"); syncDefaultOutputPreview(); });
$("perVideoSubfolder").addEventListener("change", async () => { await saveOutputPref("perVideoSubfolder"); syncDefaultOutputPreview(); });
$("attachModelName").addEventListener("change", async () => { await saveOutputPref("attachModelName"); syncDefaultOutputPreview(); });
$("notifyOnComplete").addEventListener("change", async () => { const wasEnabled = completionNotificationsEnabled(); const result = await saveOutputPref("notifyOnComplete"); if (result.ok && !wasEnabled && completionNotificationsEnabled()) sendSystemNotification(t("notify_enabled_title"), t("notify_enabled_body")); });
$("languageReset").addEventListener("click", () => { const el = $("language"); Array.from(el.options).forEach((o) => { o.selected = false; }); savePrefsDebounced({ language: "" }); });
$("saveSettings").addEventListener("click", async () => { const payload = formPayload(); const result = await bridge("save_settings", payload); if (result.ok) { const current = provider(); current.apiKey = $("apiKey").value.trim(); current.maskedApiKey = result.maskedApiKey; state.config.apiKey = current.apiKey; state.config.maskedApiKey = result.maskedApiKey; if (current.id === "openai") { state.config.openaiBaseUrl = payload.openaiBaseUrl; state.config.openaiModel = payload.openaiModel; } renderKeyStatus(); setStatus(t("saved")); } else applyErrorResult(result); });
$("start").addEventListener("click", async () => { if (!validateLocal()) return; hideErrorNotice(); $("retryPostprocess")?.classList.add("hidden"); $("log").textContent = ""; state.lastLogMessage = ""; const latest = $("logLatest"); latest.textContent = ""; latest.classList.add("hidden"); setRunning(true); $("logTitle").scrollIntoView({ behavior: "smooth", block: "start" }); const result = await bridge("start_transcription", formPayload()); if (!result.ok) { setRunning(false); applyErrorResult(result, false); } else if (result.outputPath) { $("srtPath").value = result.outputPath; if (result.outputRenamed) setOutputNotice(t("output_collision")); } });
$("stop").addEventListener("click", async () => { if (!state.running) return; $("stop").disabled = true; setStatus(t("batch_stopping")); const result = await bridge("cancel_transcription"); if (!result.ok) { $("stop").disabled = false; setStatus(result.detail || result.error || t("failed")); } });
$("retryPostprocess").addEventListener("click", async () => { hideErrorNotice(); $("retryPostprocess").classList.add("hidden"); setRunning(true); const result = await bridge("retry_postprocess"); if (!result.ok) { setRunning(false); applyErrorResult(result, false); } });
$("openMawe").addEventListener("click", openPreferredEditor); $("openServerEditor").addEventListener("click", openServerEditor); $("stopServer").addEventListener("click", stopEditorServer); $("openFolder").addEventListener("click", () => bridge("open_output_folder")); $("openLogFolder").addEventListener("click", () => bridge("open_log_folder"));
$("openMenu").addEventListener("click", () => $("htmlMenu").classList.toggle("hidden")); $("openHtml").addEventListener("click", () => { $("htmlMenu").classList.add("hidden"); bridge("open_html"); }); $("openBlankHtml").addEventListener("click", () => { $("htmlMenu").classList.add("hidden"); bridge("open_blank_html"); }); document.addEventListener("click", (event) => { if (!event.target.closest(".split-wrap")) $("htmlMenu").classList.add("hidden"); });
$("mediaCard").addEventListener("dragenter", onDragEnter); $("mediaCard").addEventListener("dragleave", onDragLeave);
bindDropField("mediaPath", "media");
bindDropField("qwenAudioHotwordsTextField", "text", "qwenAudioHotwords");
bindDropField("qwenAudioHotwordsFileField", "file", "qwenAudioHotwordsFile");
bindDropField("jsonPath", "json");
bindDropField("serverMediaPath", "serverMedia");
bindDropField("localModelCachePath", "localModelCache");
bindDropField("localModelPath", "localModel");
bindDropField("localRuntimePath", "localRuntime");
bindDropField("ocrRuntimePath", "ocrRuntime");
bindDropField("ffmpegPath", "ffmpeg");
bindDropField("stickerDir", "stickerDir");
bindDropField("toolboxInputDropZone", "toolboxInput", "toolboxInputDropZone");
bindDropField("toolboxUtilityMediaDropZone", "toolboxUtilityMedia", "toolboxUtilityMediaDropZone");
bindDropField("toolboxTimestampMediaDropZone", "toolboxTimestampMedia", "toolboxTimestampMediaDropZone");
bindDropField("toolboxBurnSubtitleDropZone", "toolboxBurnSubtitle", "toolboxBurnSubtitleDropZone");
bindDropField("toolboxFfconcatDropZone", "toolboxFfconcat", "toolboxFfconcatDropZone");
bindDropField("toolboxAlignmentProjectDropZone", "toolboxAlignmentProject", "toolboxAlignmentProjectDropZone");
bindDropField("toolboxAlignmentScriptDropZone", "toolboxAlignmentScript", "toolboxAlignmentScriptDropZone");
bindDropField("ocrVideoPathField", "ocrVideo", "ocrVideoPathField");
bindDropField("postprocessScriptPath", "script");
document.addEventListener("dragover", (event) => { if (hasFileDrag(event)) event.preventDefault(); });
document.addEventListener("dragend", clearDropState);
document.addEventListener("dragleave", (event) => { if (!event.relatedTarget && event.target === document.documentElement) clearDropState(); });
// 真实后端模式下 drop 由 Python 侧异步回传事件，不能在这里清理 dropTarget，否则 handleRoutedDrop 读不到目标。
document.addEventListener("drop", (event) => {
  event.preventDefault();
  if (window.MAWLauncher.backend === "real") return;
  const files = Array.from(event.dataTransfer?.files || []);
  const file = files[0];
  if (state.dropTarget) {
    handleRoutedDrop(file?.path || file?.name || "");
    return;
  }
  let handled = false;
  if (window.MAWLauncher?.onBatchDrop) files.forEach((item) => { handled = window.MAWLauncher.onBatchDrop(item.path || item.name || "") || handled; });
  if (handled) return;
  handleRoutedDrop(file?.path || file?.name || "");
});
setupScrollbarFlash();
syncFixedFooterClearance();
window.addEventListener("resize", syncFixedFooterClearance);
const footer = document.querySelector(".actions");
if (footer && window.ResizeObserver) new ResizeObserver(syncFixedFooterClearance).observe(footer);
document.addEventListener("DOMContentLoaded", () => {
  void init().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    appendLog(`[init] ${message}`);
    setStatus(message);
    revealLauncher();
  });
});
document.addEventListener("keydown", handleZoomKeydown);
document.addEventListener("wheel", handleZoomWheel, { passive: false });

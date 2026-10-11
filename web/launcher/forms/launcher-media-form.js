// 媒体表单：音轨探测、媒体/工程路径设置与校验提示。

function audioTrackIndex(track) {
  const value = Number(track?.audioIndex ?? track?.index);
  return Number.isInteger(value) && value >= 0 ? value : null;
}
function audioTrackIsDefault(track) {
  return Boolean(track?.default ?? track?.isDefault);
}
function audioTrackOptionLabel(track) {
  const index = audioTrackIndex(track);
  const parts = [`${t("audio_track_number")}${(index ?? 0) + 1}`];
  if (track.title) parts.push(String(track.title));
  if (track.language) parts.push(String(track.language).toUpperCase());
  if (Number.isInteger(track.channels) && track.channels > 0) parts.push(t("audio_track_channels").replace("{count}", String(track.channels)));
  if (Number.isInteger(track.sampleRate) && track.sampleRate > 0) parts.push(t("audio_track_sample_rate").replace("{rate}", String(Math.round(track.sampleRate / 100) / 10)));
  if (track.streamIndex !== undefined && track.streamIndex !== null && String(track.streamIndex) !== "") parts.push(t("audio_track_id").replace("{id}", String(track.streamIndex)));
  if (audioTrackIsDefault(track)) parts.push(t("audio_track_default"));
  return parts.join(" · ");
}
function renderAudioTracks(tracks = state.audioTracks) {
  const field = $("audioTrackField");
  const select = $("audioTrack");
  if (!field || !select) return;
  const validTracks = Array.isArray(tracks) ? tracks.filter((track) => audioTrackIndex(track) !== null) : [];
  const multiple = validTracks.length > 1;
  field.classList.toggle("hidden", !multiple);
  select.disabled = !multiple;
  select.innerHTML = "";
  if (!multiple) return;
  validTracks.forEach((track) => select.add(new Option(audioTrackOptionLabel(track), String(audioTrackIndex(track)))));
  const defaultTrack = validTracks.find(audioTrackIsDefault) || validTracks[0];
  const selected = Number.isInteger(state.audioTrack) && validTracks.some((track) => audioTrackIndex(track) === state.audioTrack)
    ? state.audioTrack
    : (audioTrackIndex(defaultTrack) ?? 0);
  state.audioTrack = Number(selected);
  select.value = String(state.audioTrack);
}
function showAudioTrackLoading() {
  const field = $("audioTrackField");
  const select = $("audioTrack");
  if (!field || !select) return;
  field.classList.remove("hidden");
  select.disabled = true;
  select.innerHTML = "";
  select.add(new Option(t("audio_track_loading"), ""));
  $("audioTrackHint").textContent = t("audio_track_loading");
}
async function refreshAudioTracks(path) {
  const value = String(path || "").trim();
  const key = audioTrackPathKey(value);
  const token = ++state.audioTrackProbeToken;
  state.audioTrackPath = key;
  state.audioTracks = [];
  state.audioTrack = null;
  if (!value || !VIDEO_EXTS.has(ext(value))) {
    renderAudioTracks([]);
    return;
  }
  showAudioTrackLoading();
  const result = await bridge("get_audio_tracks", { mediaPath: value });
  if (token !== state.audioTrackProbeToken || key !== audioTrackPathKey($("mediaPath").value)) return;
  const tracks = result?.ok && Array.isArray(result.tracks) ? result.tracks : [];
  state.audioTracks = tracks;
  renderAudioTracks(tracks);
  if (!result.ok && tracks.length === 0) $("audioTrackHint").textContent = t("audio_track_probe_failed");
  else if (tracks.length > 1) $("audioTrackHint").textContent = t("audio_track_hint");
}
function scheduleAudioTrackProbe(path) {
  clearTimeout(state.audioTrackProbeTimer);
  const value = String(path || "").trim();
  state.audioTrackProbeToken += 1;
  state.audioTrackPath = audioTrackPathKey(value);
  state.audioTracks = [];
  state.audioTrack = null;
  if (VIDEO_EXTS.has(ext(value))) showAudioTrackLoading();
  else renderAudioTracks([]);
  if (!value || !VIDEO_EXTS.has(ext(value))) return;
  state.audioTrackProbeTimer = window.setTimeout(() => { void refreshAudioTracks(value); }, 280);
}
function audioTrackPathKey(path) { return String(path || "").trim().replace(/[\\/]+/gu, "\\").toLocaleLowerCase(); }
function getAudioTrackForMedia(path) {
  const value = String(path || "").trim();
  if (audioTrackPathKey(value) !== state.audioTrackPath || state.audioTracks.length <= 1 || !Number.isInteger(state.audioTrack)) return null;
  return state.audioTrack;
}
function getDefaultAudioTrackForMedia(path) {
  const value = String(path || "").trim();
  if (audioTrackPathKey(value) !== state.audioTrackPath || state.audioTracks.length <= 1) return 0;
  const defaultTrack = state.audioTracks.find(audioTrackIsDefault) || state.audioTracks[0];
  return audioTrackIndex(defaultTrack) ?? 0;
}
function setMedia(path, { refreshOcrVideo = false } = {}) { clearTimeout(state.audioTrackProbeTimer); $("mediaPath").value = path; setError("mediaPath", ""); setOutputNotice(""); syncFlvHints(); syncDefaultOutput(); void refreshAudioTracks(path); window.MAWLauncher?.onMediaPathChanged?.({ refreshOcrVideo }); }
function setDroppedPath(field, path, eventType = "input") {
  const value = String(path || "").trim();
  const input = $(field);
  if (!input || !value) return false;
  input.value = value;
  input.dispatchEvent(new Event(eventType, { bubbles: true }));
  setError(field, "");
  return true;
}
function setServerMedia(path) {
  const value = String(path || "").trim();
  if (!MEDIA_EXTS.has(ext(value))) {
    setError("serverMediaPath", mediaDropError());
    return false;
  }
  return setDroppedPath("serverMediaPath", value);
}
function setJsonPath(path) { $("jsonPath").value = path; setError("jsonPath", ""); if (path !== state.serverProjectPath) $("openMawe").classList.add("attention"); refreshServerMedia(); window.MAWLauncher?.onProjectPathChanged?.(); }
function applyErrorResult(result, logDetail = true) {
  const detail = result.detail || result.error || "";
  const diagnostics = diagnosticText(result.diagnostics);
  const message = errText(result.code, detail, result);
  const fieldMessage = result.code === "server_start_failed" ? t("server_start_failed_hint") : (result.code === "server_no_response" ? t("server_no_response_hint") : message);
  if (result.field) setError(result.field, fieldMessage);
  if (result.field === "port" || result.field === "serverMediaPath" || result.field === "jsonPath") expandServer();
  if (result.postprocessStep) window.MAWLauncher?.openAutoPostprocessStep?.(result.postprocessStep, result.field);
  else if (result.field === "autoPostprocessEnabled") $("autoPostprocessCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
  setStatus(message);
  if (logDetail && detail) appendLog(`[detail] ${detail}`);
  if (logDetail && diagnostics) appendLog("[diagnostics] " + diagnostics);
  showErrorNotice(message, result.code || "", detail, diagnostics, result.errorContext);
}
function validateSegmentation(data) { for (const [field, minimum] of [["maxLen", 1], ["minLen", 1], ["maxWords", 1], ["minWords", 1], ["gapSplit", 0]]) { const value = data[field]; if (!value) continue; if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) return fail(field, errText("segmentation_invalid", "")); } if (data.maxLen && data.minLen && Number(data.maxLen) < Number(data.minLen)) return fail("maxLen", errText("segmentation_invalid", "")); if (data.maxWords && data.minWords && Number(data.maxWords) < Number(data.minWords)) return fail("maxWords", errText("segmentation_invalid", "")); return true; }
function validateLocal() { clearErrors(); const data = formPayload(); if (isDeepSeekProvider()) return fail("provider", errText("deepseek_transcribe_unsupported", "")); if (!data.mediaPath) return fail("mediaPath", errText("media_not_found", "")); if (!data.srtPath) return fail("srtPath", errText("output_missing", "")); if (!validateSegmentation(data)) return false; if (isLocalProvider()) { const runtime = state.config.localRuntime || {}; const status = localStatus(); if (state.localRuntimeInstalling || runtime.status === "installing") return fail("model", t("local_runtime_installing")); if (state.localPreparing) return fail("model", t("local_prepare_running")); if (runtime.status === "checking") return fail("model", t("local_runtime_checking")); if (!runtime.ready && runtime.status !== "ready") return fail("model", errText("local_runtime_missing", "")); if (!status.status || status.status === "checking") return fail("model", t("local_checking")); if (status.status === "runtime_missing") return fail("model", errText("local_runtime_missing", "")); if (status.status === "path_invalid") return fail("localModelPath", errText("local_model_path_invalid", "")); if (status.status === "path_mismatch") return fail("localModelPath", errText("local_model_path_mismatch", "")); if (status.status === "missing") return fail("model", errText("local_model_missing", "")); if (status.status === "partial") return fail("model", errText("local_model_incomplete", "")); if (isFireRedModel() && data.fireredPunc === "ct-punc" && !status.puncReady) return fail("model", errText("firered_punc_missing", "")); if (data.alignmentModel) { const alignment = (state.config.alignmentModels || []).find((item) => item.id === data.alignmentModel); if (!alignment || alignment.status === "checking") return fail("recognitionAlignmentModel", t("alignment_model_checking")); if (alignment.status === "runtime_missing" || alignment.runtimeAvailable === false) return fail("recognitionAlignmentModel", t("alignment_model_runtime_missing")); if (!alignment.installed) return fail("recognitionAlignmentModel", errText("alignment_model_missing", "")); } return true; } if (provider().requiresApiKey !== false && !data.apiKey && !provider().apiKey) return fail("apiKey", errText("api_key_missing", "")); if (provider().id === "openai" && !data.openaiBaseUrl) return fail("openaiBaseUrl", errText("custom_asr_base_url_missing", "")); if (isCustomOpenAiModel() && !data.openaiModel) return fail("openaiModel", errText("custom_asr_model_missing", "")); if (provider().id === "openai" && selectedModel().supportsKeywords && /[<>]/u.test(data.openaiKeywords)) return fail("openaiKeywords", errText("openai_keywords_invalid", "")); if (provider().id === "openai" && selectedModel().supportsDiarization && isOpenRouterBaseUrl(data.openaiBaseUrl)) return fail("model", errText("openai_diarize_openrouter_unsupported", "")); if (provider().regions.length > 0 && data.region === "singapore" && !data.workspaceId) return fail("workspaceId", errText("workspace_missing", "")); if (provider().id === "qwen" && selectedModel().supportsContext && Array.from(data.qwenAudioContext).length > 400) return fail("qwenAudioContext", errText("context_too_long", "")); if (provider().id === "soniox" && selectedModel().supportsContext && Array.from([data.sonioxContextGeneral, data.sonioxContextText, data.sonioxContextTerms, data.sonioxContextTranslationTerms].join("\n")).length > 10000) return fail("sonioxContextText", errText("soniox_context_too_long", "")); if (provider().id === "qwen" && selectedModel().supportsHotwords && data.qwenAudioHotwordsMode === "file" && ext(data.qwenAudioHotwordsFile) !== ".txt") return fail("qwenAudioHotwordsFile", errText("hotwords_file_missing", "")); return true; }
function fail(field, message) {
  setError(field, message);
  setStatus(message);
  const input = $(field);
  const settingsSection = input?.closest?.(".settings-section");
  if (settingsSection?.id) openSettings(settingsSection.id, field);
  if (input && input.scrollIntoView) input.scrollIntoView({ behavior: "smooth", block: "center" });
  return false;
}
function toggle(id) { $(id).classList.toggle("collapsed"); renderChevron(id); }
function setupScrollbarFlash() {
  const VISIBLE_MS = 900;
  const bind = (target, host) => { let timer = 0; target.addEventListener("scroll", () => { host.classList.add("scrolling"); clearTimeout(timer); timer = setTimeout(() => host.classList.remove("scrolling"), VISIBLE_MS); }, { passive: true }); };
  const shellScroll = document.querySelector(".shell-scroll");
  if (shellScroll) bind(shellScroll, shellScroll);
  else bind(window, document.documentElement);
  document.querySelectorAll(".batch-queue, .batch-details pre, .llm-model-options, .script-preview pre, .replace-rule-preview pre, .log, .modal-card, .settings-scroll, .toolbox-content, .toolbox-chain-list, .toolbox-result, .toolbox-stream-text, select[multiple], textarea").forEach((el) => bind(el, el));
}
function expandServer() { $("serverCard").classList.remove("collapsed"); renderChevron("serverCard"); }

// 拖放绑定与服务器媒体/FFmpeg 刷新。

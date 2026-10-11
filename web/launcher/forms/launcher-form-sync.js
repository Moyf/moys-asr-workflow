// 表单同步：下拉填充、provider 高级选项、热词与音轨设备选项。

function fillSelect(id, items, value) { const el = $(id); el.innerHTML = ""; items.forEach((item) => { if (item.dividerBefore) { const divider = new Option("——————", "__divider"); divider.disabled = true; el.add(divider); } el.add(new Option(localizedSelectLabel(id, item), item.id)); }); el.value = value ?? ""; }
function refillSelectLabels() {
  // 语言切换后，后端下发的下拉选项（供应商/模型/地域/语言）与说明行需要按新语言重建。
  if (!state.config) return;
  const current = provider();
  fillSelect("provider", state.config.providers, $("provider").value);
  fillSelect("model", current.models, $("model").value);
  fillSelect("region", current.regions, $("region").value || state.config.region || "beijing");
  const el = $("language");
  const showRare = Boolean(state.config.showRareLangs);
  const commons = current.commonLanguages || [];
  const available = selectedModel().languages?.length ? selectedModel().languages : current.languages;
  const visible = !showRare && commons.length ? available.filter((item) => commons.includes(item.id)) : available;
  const selected = el.multiple ? Array.from(el.selectedOptions).map((option) => option.value) : (el.value ? [el.value] : []);
  fillSelect("language", visible, "");
  if (el.multiple) Array.from(el.options).forEach((option) => { option.selected = selected.includes(option.value); });
  else el.value = selected[0] || "";
  renderProviderNote(current);
  renderModelNote();
}
function setError(field, message) { const input = $(field); const hint = $(`${field}Error`); if (input) input.classList.toggle("invalid", Boolean(message)); if (hint) { renderMessage(hint, message); hint.classList.toggle("visible", Boolean(message)); } }
function setOutputNotice(message) { const notice = $("srtPathNotice"); if (!notice) return; renderMessage(notice, message); notice.classList.toggle("hidden", !message); }
function mediaDropError() { const separator = state.lang === "zh" ? "、" : ", "; return t("drop_reject_media").replace("{extensions}", Array.from(MEDIA_EXTS).join(separator)); }
function clearErrors() { ["mediaPath", "srtPath", "apiKey", "openaiBaseUrl", "openaiModel", "openaiPrompt", "openaiKeywords", "workspaceId", "localModelPath", "localModelCachePath", "recognitionAlignmentModel", "maxLen", "minLen", "maxWords", "minWords", "gapSplit", "qwenAudioContext", "qwenAudioHotwords", "qwenAudioHotwordsFile", "sonioxContextGeneral", "sonioxContextText", "sonioxContextTerms", "sonioxContextTranslationTerms", "jsonPath", "serverMediaPath", "port", "ffmpegPath", "stickerDir", "toolboxUtilityMediaPath", "toolboxBurnSubtitlePath", "toolboxBurnCrf", "toolboxAudioTrack", "toolboxAlignmentProjectPath", "toolboxAlignmentScriptPath"].forEach((field) => setError(field, "")); hideErrorNotice(); }
function formPayload() { const modelId = $("model").value; const openaiModel = isOpenAiProvider() ? (isCustomOpenAiModel() ? $("openaiModel").value.trim() : modelId) : ""; const mediaPath = $("mediaPath").value.trim(); return { providerId: $("provider").value, modelId, mediaPath, audioTrack: getAudioTrackForMedia(mediaPath), defaultAudioTrack: getDefaultAudioTrackForMedia(mediaPath), srtPath: $("srtPath").value.trim(), apiKey: $("apiKey").value.trim(), openaiBaseUrl: $("openaiBaseUrl").value.trim(), openaiModel, openaiPrompt: $("openaiPrompt").value.trim(), openaiKeywords: $("openaiKeywords").value.trim(), region: $("region").value, workspaceId: $("workspaceId").value.trim(), localModelPath: $("localModelPath").value.trim(), alignmentModel: isLocalProvider() ? $("recognitionAlignmentModel").value : "", alignmentModelPath: "", device: $("localDevice").value, fireredPunc: isFireRedModel() ? $("fireRedPunc").value : "ct-punc", language: languageValue(), lengthLimit: $("lengthLimit")?.value.trim() || "", maxLen: $("maxLen").value.trim(), minLen: $("minLen").value.trim(), maxWords: $("maxWords").value.trim(), minWords: $("minWords").value.trim(), gapSplit: $("gapSplit").value.trim(), qwenAudioContext: $("qwenAudioContext").value.trim(), qwenAudioHotwordsMode: $("qwenAudioHotwordsMode").value, qwenAudioHotwords: $("qwenAudioHotwords").value.trim(), qwenAudioHotwordsFile: $("qwenAudioHotwordsFile").value.trim(), qwenAudioHotwordWeight: $("qwenAudioHotwordWeight").value, qwenKeepDialect: $("qwenAudioKeepDialect").checked, sonioxContextGeneral: $("sonioxContextGeneral").value.trim(), sonioxContextText: $("sonioxContextText").value.trim(), sonioxContextTerms: $("sonioxContextTerms").value.trim(), sonioxContextTranslationTerms: $("sonioxContextTranslationTerms").value.trim(), testRun: $("testRun").checked, debugRaw: $("debugRaw").checked, speakerColors: $("speakerColors").checked, generateSpectral: $("generateSpectral").checked, generateHtml: $("generateHtml").checked, autoPostprocess: window.MAWLauncher?.getAutoPostprocessPayload?.() || null, guiLang: state.lang }; }
function serverPayload() { return { jsonPath: $("jsonPath").value.trim(), mediaPath: $("serverMediaPath").value.trim(), port: $("port").value || "8250", guiLang: state.lang }; }
function renderServerButton() {
  const button = $("openMawe");
  if (!button) return;
  button.textContent = state.serverStarting
    ? SERVER_STARTING_TEXT[state.lang]
    : ((state.serverRunning || state.detectedServerUrl) ? t("open_editor") : t("start_server_editor"));
  button.disabled = state.serverStarting;
  $("stopServer").classList.toggle("hidden", !state.serverRunning && !state.detectedServerUrl);
  $("stopServer").disabled = state.serverStarting || state.serverStopping;
}
async function stopEditorServer() { if (state.serverStopping) return; state.serverStopping = true; renderServerButton(); try { const result = await bridge("stop_server", serverPayload()); if (!result.ok) { applyErrorResult(result); return; } stopServerStatusMonitor(); serverRestartProjectPath = null; state.serverRunning = false; state.serverProjectPath = ""; state.detectedServerUrl = ""; setStatus(t("ready")); } finally { state.serverStopping = false; renderServerButton(); } }
async function checkExistingServer(prefix = "") { const requestId = ++serverStatusRequest; const previousUrl = state.detectedServerUrl; state.detectedServerUrl = ""; const result = await bridge("get_server_status", serverPayload()); if (requestId !== serverStatusRequest) return result; if (!result.ok || !result.running || !result.url) { state.serverRunning = false; state.serverProjectPath = ""; if (prefix) setStatus(`${prefix}，${t("server_start_hint")}`); else if (previousUrl) setStatus(t("ready")); renderServerButton(); return result; } const isExternalServer = !state.serverRunning; state.detectedServerUrl = isExternalServer ? result.url : ""; setServerStatus(result.url, isExternalServer, prefix); renderServerButton(); startServerStatusMonitor(); return result; }
function syncHtmlMenu() { const enabled = $("generateHtml").checked; $("openHtml").classList.toggle("hidden", !enabled); $("openHtml").disabled = enabled && !state.result?.htmlPath; }
function renderChevron(id) { const arrow = $(id).querySelector(".chevron"); if (arrow) arrow.textContent = $(id).classList.contains("collapsed") ? "▸" : "▾"; }
function renderStickerCurrent() { const path = String(state.config?.stickerDir || "").trim(); const button = $("stickerCurrent"); button.textContent = path || t("unset"); button.disabled = !path; $("stickerDir").value = path; }
async function saveStickerDirectory(path) { $("stickerDir").value = path; const result = await bridge("save_sticker_dir", { path }); setError("stickerDir", result.ok ? "" : errText(result.code, result.detail || result.error)); if (result.ok) { state.config.stickerDir = result.stickerDir; renderStickerCurrent(); setStatus(t("saved")); } else setStatus(errText(result.code, result.detail || result.error)); return result; }
function renderKeyHint() {
  const current = provider();
  const isOpenai = current?.id === "openai";
  $("openKeyUrl").textContent = isOpenai ? t("openai_official") : (current?.keyButtonLabel || current?.label || "");
  $("openKeyHintOr")?.classList.toggle("hidden", !isOpenai);
  const openRouterLink = $("openRouterKeyUrl");
  if (openRouterLink) {
    openRouterLink.textContent = t("openrouter");
    openRouterLink.classList.toggle("hidden", !isOpenai);
  }
  const suffix = $("keyHintSuffix");
  if (suffix) suffix.textContent = t(isOpenai ? "openai_key_hint_suffix" : "key_hint_suffix");
}
function renderKeyStatus() { const masked = state.config && !isLocalProvider() ? provider().maskedApiKey : ""; $("keyStatus").textContent = masked ? t("key_loaded").replace("{key}", masked) : t("key_empty"); }
function syncQwenAudioOptions(model) { const enabled = provider().id === "qwen" && Boolean(model?.supportsContext || model?.supportsHotwords); $("qwenAudioOptions").classList.toggle("hidden", !enabled); $("qwenAudioContextField").classList.toggle("hidden", !(provider().id === "qwen" && model?.supportsContext)); $("qwenAudioKeepDialectField").classList.toggle("hidden", !(provider().id === "qwen" && model?.supportsKeepDialect)); $("qwenAudioHotwordsSection").classList.toggle("hidden", !(provider().id === "qwen" && model?.supportsHotwords)); syncQwenAudioHotwordsMode(); }
function syncSonioxContextOptions(model) { const enabled = provider().id === "soniox" && Boolean(model?.supportsContext); $("sonioxContextOptions").classList.toggle("hidden", !enabled); }
function syncOpenAiAdvancedOptions(model) {
  const openai = isOpenAiProvider();
  const baseUrl = $("openaiBaseUrl")?.value || state.config?.openaiBaseUrl;
  const diarize = Boolean(openai && model?.supportsDiarization);
  $("openaiAdvancedOptions").classList.toggle("hidden", !(openai && (model?.supportsPrompt || model?.supportsKeywords || diarize)));
  $("openaiPromptField").classList.toggle("hidden", !(openai && model?.supportsPrompt));
  $("openaiKeywordsField").classList.toggle("hidden", !(openai && model?.supportsKeywords));
  $("openaiDiarizationField").classList.toggle("hidden", !diarize);
  $("openaiDiarizationUnsupported").classList.toggle("visible", diarize && isOpenRouterBaseUrl(baseUrl));
}
function syncFireRedPunc(model = selectedModel()) {
  const field = $("fireRedPuncField");
  const select = $("fireRedPunc");
  if (!field || !select) return;
  const visible = isFireRedModel(model);
  field.classList.toggle("hidden", !visible);
  if (visible && !["none", "ct-punc"].includes(select.value)) select.value = "ct-punc";
}
function renderPromptCharacterCount() { const count = Array.from($("qwenAudioContext").value).length; const counter = $("qwenAudioContextCount"); counter.textContent = t("qwen_audio_context_count").replace("{count}", String(count)); counter.classList.toggle("over-limit", count > 400); }
function renderSonioxContextCharacterCount() { const value = [$("sonioxContextGeneral").value, $("sonioxContextText").value, $("sonioxContextTerms").value, $("sonioxContextTranslationTerms").value].join("\n"); const count = Array.from(value).length; const counter = $("sonioxContextCount"); counter.textContent = t("soniox_context_count").replace("{count}", String(count)); counter.classList.toggle("over-limit", count > 10000); }
function splitHotwordEntries(value, ignoreComments = false) { return String(value || "").split(/[\n,，;；]+/u).map((word) => word.trim()).filter((word) => word && (!ignoreComments || !word.startsWith("#"))); }
function parseHotwordEntry(value, defaultWeight) { const match = value.match(/^(.+?)\s*[:：]\s*(\d+)\s*$/u); const text = (match ? match[1] : value).trim(); if (!text) return { code: "empty" }; const weight = match ? Number(match[2]) : defaultWeight; if (!HOTWORD_WEIGHTS.has(weight)) return { code: "invalid_weight" }; const chars = Array.from(text).length; if (Array.from(text).some((char) => char.codePointAt(0) > 127) && chars > 15) return { code: "text_too_long" }; if (!Array.from(text).some((char) => char.codePointAt(0) > 127) && text.split(/\s+/u).filter(Boolean).length > 7) return { code: "too_many_ascii_words" }; return { text, weight }; }
function collectHotwordWarnings(value, weight, ignoreComments = false) { const parsed = new Map(); const issues = []; splitHotwordEntries(value, ignoreComments).forEach((raw, index) => { const entry = parseHotwordEntry(raw, weight); if (entry.code) { issues.push({ index: index + 1, code: entry.code, text: raw }); return; } parsed.set(entry.text, { index: index + 1, entry }); }); let validCount = 0; let superCount = 0; Array.from(parsed.values()).sort((left, right) => left.index - right.index).forEach(({ index, entry }) => { if (validCount >= MAX_HOTWORDS) { issues.push({ index, code: "too_many", text: entry.text }); return; } if (entry.weight === 50 && superCount >= MAX_SUPER_HOTWORDS) { issues.push({ index, code: "too_many_super", text: entry.text }); return; } validCount += 1; if (entry.weight === 50) superCount += 1; }); return issues; }
function hotwordWarningLabel(issue) { const text = String(issue.text || "").trim(); if (!text) return t("qwen_audio_hotword_warning_index").replace("{index}", String(issue.index)); const chars = Array.from(text); const truncated = chars.length > 16 ? `${chars.slice(0, 16).join("")}…` : text; return state.lang === "zh" ? `「${truncated}」` : `“${truncated}”`; }
function renderHotwordWarnings(value = $("qwenAudioHotwords").value, weight = Number($("qwenAudioHotwordWeight").value), ignoreComments = false) { const warning = $("qwenAudioHotwordsWarning"); const issues = collectHotwordWarnings(value, weight, ignoreComments); if (!issues.length) { warning.textContent = ""; warning.classList.remove("visible"); return; } const details = issues.slice(0, 5).map((issue) => t("qwen_audio_hotword_warning_item").replace("{label}", hotwordWarningLabel(issue)).replace("{reason}", t(`qwen_audio_hotword_issue_${issue.code}`))); if (issues.length > details.length) details.push(t("qwen_audio_hotword_warning_more")); warning.textContent = `${t("qwen_audio_hotwords_warning").replace("{count}", String(issues.length))}\n${details.join("\n")}`; warning.classList.add("visible"); }
function syncQwenAudioHotwordsMode() { const fileMode = $("qwenAudioHotwordsMode").value === "file"; $("qwenAudioHotwordsTextField").classList.toggle("hidden", fileMode); $("qwenAudioHotwordsFileField").classList.toggle("hidden", !fileMode); renderHotwordWarnings(fileMode ? "" : $("qwenAudioHotwords").value, Number($("qwenAudioHotwordWeight").value)); }
function setHotwordsMode(mode) { $("qwenAudioHotwordsMode").value = mode; $("qwenAudioHotwordsModeText").classList.toggle("active", mode === "text"); $("qwenAudioHotwordsModeFile").classList.toggle("active", mode === "file"); syncQwenAudioHotwordsMode(); }
function clearDropState() { dragState.depth = 0; state.dropTarget = ""; setDropHighlight(false); ["mediaPath", "qwenAudioHotwords", "qwenAudioHotwordsFile", "jsonPath", "serverMediaPath", "localModelCachePath", "localModelPath", "localRuntimePath", "ocrRuntimePath", "ffmpegPath", "stickerDir", "toolboxInputDropZone", "toolboxUtilityMediaDropZone", "toolboxTimestampMediaDropZone", "toolboxBurnSubtitleDropZone", "toolboxFfconcatDropZone", "toolboxAlignmentProjectDropZone", "toolboxAlignmentScriptDropZone", "ocrVideoPathField", "postprocessScriptPath"].forEach((id) => $(id)?.classList.remove("drag-over")); }
function setQwenAudioHotwordsFile(path) { if (ext(path) !== ".txt") { setError("qwenAudioHotwordsFile", errText("hotwords_file_missing", "")); return false; } $("qwenAudioHotwordsFile").value = path; setHotwordsMode("file"); setError("qwenAudioHotwordsFile", ""); return true; }
async function loadHotwordFile(path, appendToText = false) { if (ext(path) !== ".txt") { setError("qwenAudioHotwordsFile", errText("hotwords_file_missing", "")); clearDropState(); return; } const result = await bridge("read_hotword_file", { path }); if (!result.ok) { applyErrorResult(result, false); clearDropState(); return; } if (appendToText) { const incoming = String(result.text || "").trim(); if (incoming) { const current = $("qwenAudioHotwords").value.trimEnd(); $("qwenAudioHotwords").value = current ? `${current}\n${incoming}` : incoming; } setHotwordsMode("text"); renderHotwordWarnings($("qwenAudioHotwords").value); setStatus(t("qwen_audio_hotwords_loaded")); } else { setQwenAudioHotwordsFile(result.path || path); renderHotwordWarnings(String(result.text || ""), Number($("qwenAudioHotwordWeight").value), true); } clearDropState(); }

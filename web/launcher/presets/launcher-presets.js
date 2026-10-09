// 识别预设管理：字段收集/应用、预设库 CRUD 与管理面板。

const ASR_PRESET_TEXT_FIELDS = [
  "localDevice", "fireRedPunc", "recognitionAlignmentModel", "language", "promptContext",
  "qwenAudioHotwordsMode", "qwenAudioHotwords", "qwenAudioHotwordsFile",
  "qwenAudioHotwordWeight", "sonioxContextGeneral", "sonioxContextTerms",
  "sonioxContextTranslationTerms", "openaiKeywords",
  "maxLen", "minLen", "maxWords", "minWords", "gapSplit",
];
const ASR_PRESET_BOOL_FIELDS = ["speakerColors", "generateSpectral", "debugRaw", "testRun", "qwenAudioKeepDialect"];
const ASR_SHARED_PROMPT_INPUTS = ["openaiPrompt", "qwenAudioContext", "sonioxContextText"];
let presetLanguage = null;
let currentAsrPreset = { name: "", snapshot: null };
const presetManager = { items: [], selectedName: "", previousFocus: null, previewOptions: null, previewRequest: 0 };
function presetMessage(key, values = {}) {
  return Object.entries(values).reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)), t(key));
}
function localizedPresetError(detail) {
  const message = String(detail || "");
  if (state.lang !== "zh") return message;
  if (/unsupported preset format/iu.test(message)) return "预设格式不受支持。";
  if (/invalid preset field/iu.test(message)) return "预设内容字段无效。";
  if (/not a regular file|symbolic links are not supported/iu.test(message)) return "预设不是普通文件，或使用了不支持的符号链接。";
  if (/too large/iu.test(message)) return "预设文件过大。";
  if (/preset name.*(empty|long|characters|valid)/iu.test(message)) return "预设名称为空、过长或包含不支持的文件名字符。";
  if (/preset not found/iu.test(message)) return "找不到所选预设。";
  if (/already exists|name conflicts/iu.test(message)) return "预设名称已存在，请使用其他名称。";
  if (/not a directory|folder does not exist|both preset paths must be directories/iu.test(message)) return "预设库文件夹不存在或不是文件夹。";
  if (/permission|access is denied|read-only/iu.test(message)) return "没有权限访问预设库文件夹。";
  if (/json|decode|expecting value/iu.test(message)) return "JSON 文件损坏或无法读取。";
  return message;
}
function copyPresetOptions(options) { return JSON.parse(JSON.stringify(options)); }
function stablePresetString(options) { return JSON.stringify(options, Object.keys(options).sort()); }
function renderCurrentAsrPreset() {
  const hasPreset = Boolean(currentAsrPreset.name);
  $("currentAsrPresetPrefix").classList.toggle("hidden", !hasPreset);
  $("currentAsrPresetName").textContent = currentAsrPreset.name || t("preset_unselected");
  const modified = Boolean(currentAsrPreset.name && currentAsrPreset.snapshot && stablePresetString(collectAsrPreset()) !== stablePresetString(currentAsrPreset.snapshot));
  $("currentAsrPresetModified").classList.toggle("hidden", !modified);
  $("currentAsrPresetName").classList.toggle("preset-is-modified", modified);
  $("updateCurrentAsrPreset").classList.toggle("hidden", !modified);
}
function setCurrentAsrPreset(name, options) {
  currentAsrPreset = { name: String(name || ""), snapshot: options ? copyPresetOptions(options) : null };
  renderCurrentAsrPreset();
  renderAsrPresetList();
  updatePresetActionAvailability();
}
function clearCurrentAsrPreset() { setCurrentAsrPreset("", null); }
function showAsrPresetStatus(message = "") {
  const status = $("asrPresetStatus");
  status.textContent = message;
  status.classList.toggle("hidden", !message);
}
function collectAsrPreset() {
  const options = Object.fromEntries(ASR_PRESET_TEXT_FIELDS.filter((id) => id !== "promptContext").map((id) => [id, $(id).value]));
  options.promptContext = activePromptContext();
  options.language = presetLanguage ?? languageValue();
  options.recognitionAlignmentModel = state.alignmentModelSelection || "";
  ASR_PRESET_BOOL_FIELDS.forEach((id) => { options[id] = $(id).checked; });
  return options;
}
function applyAsrPreset(options) {
  if (!options || ASR_PRESET_TEXT_FIELDS.some((id) => typeof options[id] !== "string") ||
      ASR_PRESET_BOOL_FIELDS.some((id) => typeof options[id] !== "boolean")) throw new Error(t("preset_failed"));
  ASR_PRESET_TEXT_FIELDS.forEach((id) => { if (id !== "language" && id !== "recognitionAlignmentModel" && id !== "promptContext") $(id).value = options[id]; });
  syncLocalDeviceOptions();
  setSharedPromptContext(options.promptContext);
  ASR_PRESET_BOOL_FIELDS.forEach((id) => { $(id).checked = options[id]; });
  presetLanguage = options.language;
  state.alignmentModelSelection = options.recognitionAlignmentModel;
  applyProviderLanguages(provider(), selectedModel());
  renderLocalAlignmentModel();
  setHotwordsMode(options.qwenAudioHotwordsMode);
  renderPromptCharacterCount(); renderSonioxContextCharacterCount(); syncTestRun();
}
function activePromptContext() {
  return $("openaiPrompt").value;
}
function setSharedPromptContext(value) {
  const prompt = String(value || "");
  ASR_SHARED_PROMPT_INPUTS.forEach((id) => { $(id).value = prompt; });
  renderPromptCharacterCount();
  renderSonioxContextCharacterCount();
}
function syncSharedPromptContext(sourceId) {
  const value = $(sourceId).value;
  ASR_SHARED_PROMPT_INPUTS.forEach((id) => { if (id !== sourceId && $(id).value !== value) $(id).value = value; });
  renderPromptCharacterCount();
  renderSonioxContextCharacterCount();
  renderCurrentAsrPreset();
}
$("language").addEventListener("change", () => { presetLanguage = null; renderCurrentAsrPreset(); });
$("languageReset").addEventListener("click", () => { presetLanguage = null; renderCurrentAsrPreset(); });

function presetDate(seconds) {
  if (!seconds) return "";
  try { return new Intl.DateTimeFormat(state.lang === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(seconds * 1000)); }
  catch { return ""; }
}
const PRESET_PREVIEW_FIELDS = [
  ["qwenAudioHotwordsFile", "preset_field_hotword_file"], ["sonioxContextGeneral", "preset_field_soniox_general"],
  ["sonioxContextTranslationTerms", "preset_field_translation_terms"], ["language", "preset_field_language"],
  ["fireRedPunc", "preset_field_punctuation"],
  ["recognitionAlignmentModel", "preset_field_alignment"], ["qwenAudioHotwordWeight", "preset_field_hotword_weight"],
  ["maxLen", "preset_field_max_len"], ["minLen", "preset_field_min_len"], ["maxWords", "preset_field_max_words"],
  ["minWords", "preset_field_min_words"], ["gapSplit", "preset_field_gap_split"],
];
const PRESET_PREVIEW_FLAGS = [
  ["speakerColors", "preset_field_speaker_colors"], ["generateSpectral", "preset_field_spectral"],
  ["debugRaw", "preset_field_debug"], ["testRun", "preset_field_test_run"], ["qwenAudioKeepDialect", "preset_field_keep_dialect"],
];
function renderPresetOptionsPreview(options) {
  const section = $("asrPresetOptionsPreview");
  const list = $("asrPresetPreviewList");
  list.replaceChildren();
  if (!options || typeof options !== "object") { section.classList.add("hidden"); return; }
  const values = [];
  const prompt = String(options.promptContext || "").trim();
  if (prompt) values.push(["preset_field_prompt_context", prompt]);
  const terms = [options.qwenAudioHotwords, options.openaiKeywords, options.sonioxContextTerms]
    .flatMap((value) => String(value || "").split(/[\n,，;；]+/u).map((part) => part.trim()).filter(Boolean));
  if (terms.length) values.push(["preset_field_hotwords_keywords", [...new Set(terms)].join("、")]);
  PRESET_PREVIEW_FIELDS.forEach(([id, label]) => {
    let raw = String(options[id] || "").trim();
    if (!raw || (id === "qwenAudioHotwordWeight" && !String(options.qwenAudioHotwords || options.qwenAudioHotwordsFile || "").trim())) return;
    values.push([label, raw]);
  });
  PRESET_PREVIEW_FLAGS.forEach(([id, label]) => { if (options[id] === true) values.push([label, t("preset_field_enabled")]); });
  values.forEach(([label, raw]) => {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.className = "asr-preset-preview-label";
    title.textContent = t(label);
    const value = document.createElement("span");
    value.className = "asr-preset-preview-value";
    const compact = String(raw).replace(/\s+/gu, " ").trim();
    value.textContent = compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
    value.title = String(raw);
    item.append(title, value);
    list.append(item);
  });
  section.classList.toggle("hidden", values.length === 0);
}
function clearSelectedAsrPreset() {
  presetManager.selectedName = "";
  presetManager.previewOptions = null;
  presetManager.previewRequest += 1;
  $("asrPresetName").value = "";
  $("asrPresetDescription").value = "";
  $("asrPresetModifiedDate").textContent = "";
  renderPresetOptionsPreview(null);
  updatePresetActionAvailability();
}
async function loadAsrPresetPreview(name) {
  const request = ++presetManager.previewRequest;
  const result = await bridge("recognition_presets", { action: "preview", name });
  if (request !== presetManager.previewRequest || presetManager.selectedName !== name) return;
  if (!result.ok) {
    setPresetManagerStatus(`${t("preset_failed")}: ${localizedPresetError(result.detail)}`);
    return;
  }
  presetManager.previewOptions = result.options;
  renderPresetOptionsPreview(result.options);
}
function selectedAsrPreset() { return presetManager.items.find((item) => item.name === presetManager.selectedName && item.valid); }
function updatePresetActionAvailability() {
  const item = selectedAsrPreset();
  const selected = Boolean(item);
  ["loadAsrPreset", "updateAsrPreset", "copyAsrPreset", "deleteAsrPreset"].forEach((id) => { $(id).disabled = !selected; });
  if (!selected) return;
  const active = item.name === currentAsrPreset.name;
  const updateButton = $("updateAsrPreset");
  updateButton.textContent = t(active ? "preset_update_active" : "preset_update_selected");
  updateButton.title = t(active ? "preset_update_active_title" : "preset_update_title");
}
function focusAsrPresetItem(name) {
  Array.from($("asrPresetList").querySelectorAll("[data-preset-name]")).find((button) => button.dataset.presetName === name)?.focus();
}
function selectAsrPreset(name, { focus = false } = {}) {
  const item = presetManager.items.find((candidate) => candidate.name === name && candidate.valid);
  if (!item) return;
  const modifiedText = item.modified ? presetMessage("preset_modified", { time: presetDate(item.modified) }) : "";
  if (presetManager.selectedName === item.name
    && $("asrPresetDescription").value === (item.description || "")
    && $("asrPresetModifiedDate").textContent === modifiedText) {
    if (focus) focusAsrPresetItem(item.name);
    return;
  }
  presetManager.selectedName = item.name;
  presetManager.previewOptions = null;
  $("asrPresetName").value = item.name;
  $("asrPresetDescription").value = item.description || "";
  $("asrPresetModifiedDate").textContent = modifiedText;
  renderPresetOptionsPreview(null);
  renderAsrPresetList();
  updatePresetActionAvailability();
  void loadAsrPresetPreview(item.name);
  if (focus) focusAsrPresetItem(item.name);
}
function renderAsrPresetList() {
  const list = $("asrPresetList");
  const query = $("asrPresetSearch").value.trim().toLocaleLowerCase();
  list.replaceChildren();
  const matches = presetManager.items.filter((item) => `${item.name}\n${item.description}\n${item.detail}`.toLocaleLowerCase().includes(query));
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "hint asr-preset-empty";
    empty.textContent = t("preset_empty");
    list.append(empty);
    return;
  }
  matches.forEach((item) => {
    if (!item.valid) {
      const unavailable = document.createElement("div");
      unavailable.className = "asr-preset-item unavailable";
      unavailable.setAttribute("role", "option");
      unavailable.setAttribute("aria-disabled", "true");
      unavailable.title = localizedPresetError(item.detail) || t("preset_invalid");
      const title = document.createElement("span");
      title.className = "asr-preset-item-name";
      title.textContent = item.name;
      const reason = document.createElement("span");
      reason.className = "asr-preset-item-description";
      reason.textContent = `${t("preset_invalid")}：${localizedPresetError(item.detail) || ""}`;
      unavailable.append(title, reason);
      list.append(unavailable);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "asr-preset-item";
    const active = item.name === currentAsrPreset.name;
    button.classList.toggle("active", active);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(item.name === presetManager.selectedName));
    if (active) button.setAttribute("aria-current", "true");
    button.dataset.presetName = item.name;
    const title = document.createElement("span");
    title.className = "asr-preset-item-name";
    title.textContent = item.name;
    if (active) {
      const badge = document.createElement("span");
      badge.className = "asr-preset-item-badge";
      badge.textContent = t("preset_active_badge");
      title.append(badge);
    }
    const description = document.createElement("span");
    description.className = "asr-preset-item-description";
    description.textContent = item.description || "";
    const modified = document.createElement("span");
    modified.className = "asr-preset-item-modified";
    modified.textContent = presetDate(item.modified);
    button.append(title, description, modified);
    list.append(button);
  });
}
function setPresetManagerStatus(message = "") { $("asrPresetManagerStatus").textContent = message; }
async function refreshAsrPresetLibrary({ keepSelection = true } = {}) {
  const previousName = keepSelection ? presetManager.selectedName : "";
  const result = await bridge("asr_preset_library");
  if (!result.ok) {
    setPresetManagerStatus(`${t("preset_failed")}: ${localizedPresetError(result.detail || result.error)}`);
    return false;
  }
  presetManager.items = Array.isArray(result.items) ? result.items : [];
  if (previousName && presetManager.items.some((item) => item.name === previousName && item.valid)) selectAsrPreset(previousName);
  else {
    clearSelectedAsrPreset();
  }
  renderAsrPresetList();
  return true;
}
function renderAsrPresetRootCurrent() {
  const root = String(state.config?.asrPresetRoot || "");
  ["asrPresetRootCurrent", "asrPresetRootInModal"].forEach((id) => {
    $(id).textContent = root;
    $(id).title = root ? `${t("open_folder_hint")}: ${root}` : t("preset_folder_open_failed");
  });
  if (document.activeElement !== $("asrPresetRoot")) $("asrPresetRoot").value = root;
}
async function bootstrapAsrPresetLibrary() {
  if (state.config.asrPresetRootConfigured) return;
  const preview = await bridge("asr_preset_migration_preview", { path: "" });
  if (!preview.ok) { setPresetManagerStatus(`${t("preset_migration_failed")}: ${localizedPresetError(preview.detail)}`); return; }
  let migrate = false;
  if (preview.conflicts?.length) {
    const proceed = await confirmAction(presetMessage("preset_root_switch_no_migrate", { names: preview.conflicts.join(", ") }));
    if (!proceed) return;
  } else if (preview.files?.length || preview.invalid?.length) {
    const message = preview.invalid?.length
      ? presetMessage("preset_root_migrate_with_invalid", { count: preview.invalid.length, names: preview.invalid.map((item) => item.name).join(", "), safeCount: preview.files?.length || 0 })
      : presetMessage("preset_root_migrate_confirm", { count: preview.files.length });
    migrate = await confirmAction(message);
  }
  const result = await bridge("set_asr_preset_root", { path: "", migrate });
  if (!result.ok) { setPresetManagerStatus(`${t("preset_root_failed")}: ${localizedPresetError(result.detail)}`); return; }
  state.config.asrPresetRoot = result.root;
  state.config.asrPresetRootConfigured = true;
  renderAsrPresetRootCurrent();
  if (result.sourceRemaining?.length) setPresetManagerStatus(presetMessage("preset_root_source_remaining", { names: result.sourceRemaining.join(", ") }));
  else if (result.migrated?.length) setPresetManagerStatus(presetMessage("preset_root_migrated", { count: result.migrated.length }));
}
async function openAsrPresetManager() {
  presetManager.previousFocus = document.activeElement;
  $("asrPresetModal").classList.remove("hidden");
  $("asrPresetSearch").value = "";
  setPresetManagerStatus("");
  await bootstrapAsrPresetLibrary();
  await refreshAsrPresetLibrary({ keepSelection: false });
  if (currentAsrPreset.name && presetManager.items.some((item) => item.name === currentAsrPreset.name && item.valid)) {
    selectAsrPreset(currentAsrPreset.name, { focus: true });
  } else {
    if (currentAsrPreset.name) clearCurrentAsrPreset();
    $("asrPresetSearch").focus();
  }
}
function closeAsrPresetManager() {
  $("asrPresetModal").classList.add("hidden");
  const previous = presetManager.previousFocus;
  presetManager.previousFocus = null;
  if (previous?.isConnected) previous.focus();
}
function nextDefaultPresetName() {
  const base = t("preset_default_name");
  for (let index = 1; index <= 50; index++) {
    const candidate = index === 1 ? base : `${base} ${index}`;
    if (!presetManager.items.some((item) => item.name.toLocaleLowerCase() === candidate.toLocaleLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}
async function createPresetFromForm() {
  const name = $("asrPresetName").value.trim() || nextDefaultPresetName();
  const options = collectAsrPreset();
  const result = await bridge("recognition_presets", { action: "create", name, description: $("asrPresetDescription").value, options });
  if (!result.ok) { setPresetManagerStatus(`${t("preset_failed")}: ${localizedPresetError(result.detail)}`); return; }
  await refreshAsrPresetLibrary({ keepSelection: false });
  selectAsrPreset(result.name);
  setSharedPromptContext(options.promptContext);
  setCurrentAsrPreset(result.name, options);
  showAsrPresetStatus(`${t("preset_saved")}：${result.name}`);
  setPresetManagerStatus(`${t("preset_saved")}：${result.name}`);
  $("asrPresetName").focus();
  $("asrPresetName").select();
}
async function loadSelectedAsrPreset() {
  const item = selectedAsrPreset();
  if (!item) { setPresetManagerStatus(t("preset_select_required")); return; }
  const result = await bridge("recognition_presets", { action: "load", name: item.name });
  if (!result.ok) { setPresetManagerStatus(`${t("preset_failed")}: ${localizedPresetError(result.detail)}`); return; }
  try { applyAsrPreset(result.options); }
  catch (error) { setPresetManagerStatus(`${t("preset_failed")}: ${error.message}`); return; }
  setCurrentAsrPreset(result.name, result.options);
  showAsrPresetStatus(result.missingHotwords ? t("preset_missing") : "");
  closeAsrPresetManager();
}
let presetInfoSaving = false;
async function saveSelectedPresetInfoOnBlur() {
  if (presetInfoSaving) return;
  const item = selectedAsrPreset();
  if (!item) return;
  const newName = $("asrPresetName").value.trim();
  const description = $("asrPresetDescription").value;
  if (!newName) { $("asrPresetName").value = item.name; return; }
  if (newName === item.name && description === (item.description || "")) return;
  presetInfoSaving = true;
  try {
    const result = await bridge("recognition_presets", { action: "save_info", name: item.name, newName, description });
    if (!result.ok) {
      setPresetManagerStatus(`${t("preset_failed")}: ${localizedPresetError(result.detail)}`);
      await refreshAsrPresetLibrary();
      return;
    }
    await refreshAsrPresetLibrary();
    if (!presetManager.selectedName || presetManager.selectedName === item.name) selectAsrPreset(result.name);
    if (currentAsrPreset.name === item.name) currentAsrPreset.name = result.name;
    renderCurrentAsrPreset();
    setPresetManagerStatus(`${t("preset_info_saved")}：${result.name}`);
  } finally { presetInfoSaving = false; }
}
async function updateSelectedAsrPreset() {
  const item = selectedAsrPreset();
  if (!item) { setPresetManagerStatus(t("preset_select_required")); return; }
  if (item.name !== currentAsrPreset.name && !await confirmAction(presetMessage("preset_confirm_update", { name: item.name }))) return;
  const options = collectAsrPreset();
  const result = await bridge("recognition_presets", { action: "update", name: item.name, options });
  if (!result.ok) { setPresetManagerStatus(`${t("preset_failed")}: ${localizedPresetError(result.detail)}`); return; }
  await refreshAsrPresetLibrary();
  setSharedPromptContext(options.promptContext);
  setCurrentAsrPreset(item.name, options);
  setPresetManagerStatus(`${t("preset_updated")}：${item.name}`);
}
async function updateCurrentAsrPresetFromForm() {
  const name = currentAsrPreset.name;
  if (!name || !currentAsrPreset.snapshot) return;
  const options = collectAsrPreset();
  const result = await bridge("recognition_presets", { action: "update", name, options });
  if (!result.ok) {
    if (/preset not found/iu.test(String(result.detail || ""))) clearCurrentAsrPreset();
    showAsrPresetStatus(`${t("preset_failed")}: ${localizedPresetError(result.detail)}`);
    return;
  }
  setSharedPromptContext(options.promptContext);
  setCurrentAsrPreset(name, options);
  showAsrPresetStatus(`${t("preset_updated")}：${name}`);
}
async function copySelectedAsrPreset() {
  const item = selectedAsrPreset();
  if (!item) { setPresetManagerStatus(t("preset_select_required")); return; }
  const result = await bridge("recognition_presets", { action: "copy", name: item.name, suffix: t("preset_copy_suffix") });
  if (!result.ok) { setPresetManagerStatus(`${t("preset_failed")}: ${localizedPresetError(result.detail)}`); return; }
  await refreshAsrPresetLibrary({ keepSelection: false });
  selectAsrPreset(result.name);
  $("asrPresetName").focus();
  $("asrPresetName").select();
  setPresetManagerStatus(`${t("preset_copied")}：${result.name}`);
}
async function deleteSelectedAsrPreset() {
  const item = selectedAsrPreset();
  if (!item) { setPresetManagerStatus(t("preset_select_required")); return; }
  if (!await confirmAction(presetMessage("preset_confirm_delete", { name: item.name }))) return;
  const result = await bridge("recognition_presets", { action: "delete", name: item.name });
  if (!result.ok) { setPresetManagerStatus(`${t("preset_failed")}: ${localizedPresetError(result.detail)}`); return; }
  if (currentAsrPreset.name === item.name) clearCurrentAsrPreset();
  await refreshAsrPresetLibrary({ keepSelection: false });
  $("asrPresetName").focus();
  setPresetManagerStatus(`${t("preset_deleted")}：${item.name}`);
}
async function changeAsrPresetRoot(path) {
  $("asrPresetRootError").textContent = "";
  $("asrPresetRootStatus").textContent = "";
  const preview = await bridge("asr_preset_migration_preview", { path });
  if (!preview.ok) {
    const message = `${t("preset_root_choose")} ${localizedPresetError(preview.detail)}`;
    $("asrPresetRootError").textContent = message;
    return;
  }
  let migrate = false;
  if (preview.conflicts?.length) {
    const proceed = await confirmAction(presetMessage("preset_root_switch_no_migrate", { names: preview.conflicts.join(", ") }));
    if (!proceed) return;
  } else if (preview.files?.length || preview.invalid?.length) {
    const message = preview.invalid?.length
      ? presetMessage("preset_root_migrate_with_invalid", { count: preview.invalid.length, names: preview.invalid.map((item) => item.name).join(", "), safeCount: preview.files?.length || 0 })
      : presetMessage("preset_root_migrate_confirm", { count: preview.files.length });
    migrate = await confirmAction(message);
  }
  const result = await bridge("set_asr_preset_root", { path, migrate });
  if (!result.ok) {
    $("asrPresetRootError").textContent = `${t("preset_root_failed")}: ${localizedPresetError(result.detail)}`;
    return;
  }
  state.config.asrPresetRoot = result.root;
  state.config.asrPresetRootConfigured = true;
  $("asrPresetRoot").value = result.root;
  renderAsrPresetRootCurrent();
  await refreshAsrPresetLibrary({ keepSelection: false });
  if (currentAsrPreset.name) {
    const current = await bridge("recognition_presets", { action: "load", name: currentAsrPreset.name });
    if (!current.ok || stablePresetString(current.options) !== stablePresetString(currentAsrPreset.snapshot)) clearCurrentAsrPreset();
  }
  if (result.sourceRemaining?.length) {
    $("asrPresetRootStatus").textContent = presetMessage("preset_root_source_remaining", { names: result.sourceRemaining.join(", ") });
  } else if (result.migrated?.length) {
    $("asrPresetRootStatus").textContent = presetMessage("preset_root_migrated", { count: result.migrated.length });
  } else {
    $("asrPresetRootStatus").textContent = t("preset_root_saved");
  }
}
$("manageAsrPresets").addEventListener("click", () => { void openAsrPresetManager(); });
$("updateCurrentAsrPreset").addEventListener("click", () => { void updateCurrentAsrPresetFromForm(); });
$("asrPresetClose").addEventListener("click", closeAsrPresetManager);
$("asrPresetBackdrop").addEventListener("click", closeAsrPresetManager);
$("asrPresetRootInModal").addEventListener("click", async () => {
  const result = await bridge("open_asr_preset_folder");
  if (!result.ok) setPresetManagerStatus(`${t("preset_folder_open_failed")}: ${localizedPresetError(result.error || result.detail)}`);
});
$("asrPresetSettingsLink").addEventListener("click", () => {
  closeAsrPresetManager();
  openSettings("asrPresetRootSection", "asrPresetRoot");
});
$("refreshAsrPresets").addEventListener("click", () => { void refreshAsrPresetLibrary(); });
$("asrPresetSearch").addEventListener("input", renderAsrPresetList);
let lastPresetListClick = { name: "", at: 0 };
$("asrPresetList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-preset-name]");
  if (!button) return;
  const name = button.dataset.presetName;
  const now = Date.now();
  const isDoubleClick = event.detail > 0 && lastPresetListClick.name === name && now - lastPresetListClick.at <= 500;
  lastPresetListClick = isDoubleClick ? { name: "", at: 0 } : { name, at: now };
  if (isDoubleClick) { void loadSelectedAsrPreset(); return; }
  selectAsrPreset(name);
});
$("saveAsrPreset").addEventListener("click", () => { void createPresetFromForm(); });
$("loadAsrPreset").addEventListener("click", () => { void loadSelectedAsrPreset(); });
$("asrPresetName").addEventListener("blur", () => { void saveSelectedPresetInfoOnBlur(); });
$("asrPresetDescription").addEventListener("blur", () => { void saveSelectedPresetInfoOnBlur(); });
$("updateAsrPreset").addEventListener("click", () => { void updateSelectedAsrPreset(); });
$("copyAsrPreset").addEventListener("click", () => { void copySelectedAsrPreset(); });
$("deleteAsrPreset").addEventListener("click", () => { void deleteSelectedAsrPreset(); });
$("asrPresetModal").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closeAsrPresetManager(); return; }
  if (event.key !== "Tab") return;
  const focusable = Array.from($("asrPresetModal").querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")).filter((element) => !element.closest(".hidden"));
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$("asrPresetModal").addEventListener("wheel", (event) => {
  event.stopPropagation();
  if (!event.target.closest(".asr-preset-list, .asr-preset-details, textarea")) event.preventDefault();
}, { passive: false });
["advancedOptionsGrid", "qwenAudioOptions", "sonioxContextOptions", "openaiAdvancedOptions"].forEach((id) => {
  $(id)?.addEventListener("input", renderCurrentAsrPreset);
  $(id)?.addEventListener("change", renderCurrentAsrPreset);
});
ASR_SHARED_PROMPT_INPUTS.forEach((id) => {
  $(id).addEventListener("input", () => syncSharedPromptContext(id));
  $(id).addEventListener("change", () => syncSharedPromptContext(id));
});
$("pickAsrPresetRoot").addEventListener("click", async () => {
  const result = await bridge("choose_folder");
  if (result.ok) await changeAsrPresetRoot(result.path);
});
$("asrPresetRoot").addEventListener("change", () => { void changeAsrPresetRoot($("asrPresetRoot").value.trim()); });
$("resetAsrPresetRoot").addEventListener("click", () => { void changeAsrPresetRoot(""); });
$("asrPresetRootCurrent").addEventListener("click", async () => {
  const result = await bridge("open_asr_preset_folder");
  if (!result.ok) $("asrPresetRootStatus").textContent = `${t("preset_folder_open_failed")}: ${localizedPresetError(result.error || result.detail)}`;
});

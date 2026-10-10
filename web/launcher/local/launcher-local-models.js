// 本地模型/运行时/OCR/对齐模型的渲染与刷新。

function isLocalProvider() { return provider()?.kind === "local" || provider()?.id === "local"; }
function isDeepSeekProvider() { return provider()?.id === "deepseek"; }
function isFireRedModel(model = selectedModel()) { return isLocalProvider() && String(model?.engine || "").toLowerCase() === "firered"; }
function syncLocalDeviceOptions(model = selectedModel()) {
  const select = $("localDevice");
  const mps = $("localDeviceMps") || Object.assign(new Option("MPS", "mps"), { id: "localDeviceMps" });
  const available = state.config?.platform === "darwin" && isLocalProvider() && model?.engine === "qwen-asr";
  if (available) {
    mps.hidden = false;
    mps.disabled = false;
    if (!mps.isConnected) select.add(mps);
  } else {
    if (select.value === "mps" || !select.value) select.value = "auto";
    mps.remove();
  }
}
function localStatus() { return selectedModel()?.localStatus || {}; }
function localModelListStatusKey(model) {
  if (state.localPreparing && model?.id === $("model")?.value) return "local_prepare_running";
  if (!model?.localStatus) return "local_checking";
  const status = model?.localStatus || {};
  if (String(model?.engine || "").toLowerCase() === "firered" && status.ctcReady && !status.puncReady) {
    return "local_firered_punc_optional";
  }
  return ({
    installed: "local_installed",
    partial: "local_partial",
    runtime_missing: "local_runtime_missing",
    path_invalid: "local_model_path_invalid",
    path_mismatch: "local_model_path_mismatch",
    missing: "local_missing",
    checking: "local_checking",
  }[status.status] || "local_missing");
}
function compactModelSize(value) {
  const text = String(value || "").trim().replace(/^[~约]\s*/u, "");
  if (!text) return "";
  const range = text.match(/^([\d.]+)\s*[–-]/u);
  const normalized = range ? `${range[1]} GB` : text;
  const gigabytes = normalized.match(/^(\d+(?:\.\d+)?)\s*G(?:B)?\+?$/iu);
  if (gigabytes) {
    const amount = Number(gigabytes[1]);
    if (!Number.isFinite(amount)) return "";
    if (amount < 1) return `${Math.round(amount * 10) / 10}G`;
    if (amount < 2) return `${Math.floor(amount * 10) / 10}G+`;
    return `${Math.floor(amount)}G+`;
  }
  const megabytes = normalized.match(/^(\d+(?:\.\d+)?)\s*M(?:B)?$/iu);
  if (megabytes) {
    const amount = Number(megabytes[1]) / 1024;
    return Number.isFinite(amount) ? `${Math.round(amount * 10) / 10}G` : "";
  }
  return normalized.replace(/\s+/gu, "");
}
function localModelSize(model) {
  return compactModelSize(model?.localStatus?.installedSize || model?.installedSize || model?.estimatedSize);
}
function localModelBadgeDescriptors(model) {
  const deviceKey = {
    cpu: "local_model_badge_cpu",
    cpu_gpu: "local_model_badge_cpu_gpu",
    gpu_preferred: "local_model_badge_gpu_preferred",
  }[model?.deviceSupport];
  const resourceKey = {
    low: "local_model_badge_resource_low",
    medium: "local_model_badge_resource_medium",
    high: "local_model_badge_resource_high",
  }[model?.resourceLevel];
  const badges = [];
  if (resourceKey) badges.push({ key: resourceKey, kind: "resource", resourceLevel: model?.resourceLevel });
  if (deviceKey) badges.push({ key: deviceKey, kind: "hardware" });
  if (model?.supportsSpeaker || model?.supportsDiarization) {
    badges.push({ key: "local_model_badge_speaker", kind: "feature" });
  }
  if (model?.supportsWordTimestamps) badges.push({
    key: "local_model_badge_word_timestamps",
    kind: "feature",
  });
  return badges;
}
function appendLocalModelBadges(main, model) {
  const meta = document.createElement("span");
  meta.className = "local-model-list-meta";
  const size = localModelSize(model);
  if (size) {
    const sizeElement = document.createElement("span");
    sizeElement.className = "local-model-list-size";
    sizeElement.textContent = size;
    sizeElement.title = size;
    const label = main.querySelector(".local-model-list-label");
    if (label) {
      const title = document.createElement("span");
      title.className = "local-model-list-title";
      label.replaceWith(title);
      title.append(label, sizeElement);
    } else {
      meta.append(sizeElement);
    }
  }
  const container = document.createElement("span");
  container.className = "local-model-list-badges";
  localModelBadgeDescriptors(model).forEach((descriptor) => {
    const badge = document.createElement("span");
    const resourceClass = {
      low: "resource-low",
      medium: "resource-medium",
      high: "resource-high",
    }[descriptor.resourceLevel] || "";
    badge.className = `local-model-badge ${descriptor.kind}${resourceClass ? ` ${resourceClass}` : ""}`;
    badge.textContent = t(descriptor.key).replace("{size}", descriptor.size || "");
    badge.title = badge.textContent;
    container.append(badge);
  });
  if (container.childElementCount) meta.append(container);
  if (meta.childElementCount) main.append(meta);
}
function renderLocalModelList() {
  const container = $("localModelList");
  if (!container) return;
  container.replaceChildren();
  if (!isLocalProvider()) {
    container.classList.add("hidden");
    return;
  }
  const models = (provider()?.models || []).filter((model) => !model.hidden);
  container.classList.toggle("hidden", !models.length);
  const selectedId = $("model")?.value || "";
  models.forEach((model) => {
    const item = document.createElement("div");
    item.setAttribute("role", "listitem");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "local-model-list-item";
    button.classList.toggle("active", model.id === selectedId);
    const ready = Boolean(model?.localStatus?.installed);
    button.classList.toggle("ready", ready);
    button.disabled = Boolean(state.localPreparing);
    button.setAttribute("aria-pressed", String(model.id === selectedId));
    button.dataset.modelId = model.id;

    const main = document.createElement("span");
    main.className = "local-model-list-main";
    const label = document.createElement("span");
    label.className = "local-model-list-label";
    label.textContent = localizedSelectLabel("model", model);
    main.append(label);
    appendLocalModelBadges(main, model);
    const note = modelNoteText(model);
    if (note) {
      button.title = note;
      const noteElement = document.createElement("span");
      noteElement.className = "local-model-list-note";
      noteElement.title = note;
      noteElement.textContent = note;
      main.append(noteElement);
    }
    const status = document.createElement("span");
    const statusKey = localModelListStatusKey(model);
    status.className = `local-model-list-status ${ready ? "ready" : ""}`.trim();
    status.textContent = ready ? "✓" : "";
    status.setAttribute("aria-label", t(statusKey));
    status.title = t(statusKey);
    button.append(main, status);
    item.append(button);
    container.append(item);
    button.addEventListener("click", () => {
      if (button.disabled || $("model").value === model.id) return;
      $("model").value = model.id;
      $("model").dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
}
function renderLocalRuntimePaths(runtime) {
  const container = $("localRuntimePaths");
  container.textContent = "";
  const entries = [
    { label: t("local_runtime_path"), path: runtime.path || "", payload: { kind: "runtime", modelId: $("model").value } },
  ].filter((entry) => entry.path);
  for (const entry of entries) {
    const line = document.createElement("span");
    line.className = "runtime-path-line";
    line.append(document.createTextNode(entry.label));
    const link = document.createElement("a");
    link.href = "#";
    link.className = "inline-link runtime-path-link";
    link.textContent = entry.path;
    link.title = t("open_folder_hint");
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const result = await bridge("open_runtime_folder", entry.payload);
      if (!result.ok) setStatus(result.detail || result.error || t("failed"));
      else setStatus(t("saved"));
    });
    line.append(link);
    container.append(line);
  }
  container.classList.toggle("hidden", !entries.length);
}
function renderLocalRuntimeInventory() {
  const button = $("toggleLocalRuntimeInventory");
  const container = $("localRuntimeInventory");
  const open = Boolean(state.localRuntimeInventoryOpen);
  button.setAttribute("aria-expanded", String(open));
  button.textContent = t(open ? "local_runtime_inventory_hide" : "local_runtime_inventory");
  container.classList.toggle("hidden", !open);
  if (!open) return;
  container.replaceChildren();
  if (state.localRuntimeInventoryError) {
    container.textContent = state.localRuntimeInventoryError;
    return;
  }
  const inventory = state.localRuntimeInventory;
  if (!inventory) {
    container.textContent = t("local_runtime_inventory_loading");
    return;
  }
  const meta = document.createElement("dl");
  meta.className = "runtime-inventory-meta";
  const appendMeta = (labelKey, value) => {
    const row = document.createElement("div");
    row.className = "runtime-inventory-meta-row";
    const label = document.createElement("dt");
    label.textContent = t(labelKey);
    const content = document.createElement("dd");
    content.textContent = value || t("local_runtime_unknown");
    row.append(label, content);
    meta.append(row);
  };
  const runtimeStatus = inventory.status || state.config?.localRuntime?.status || "";
  const statusKey = ({
    ready: "local_runtime_ready",
    broken: "local_runtime_broken",
    missing: "local_runtime_missing",
    checking: "local_runtime_checking",
    installing: "local_runtime_installing",
  })[runtimeStatus] || "local_runtime_unknown";
  const versionValue = `${t("local_runtime_installed")}: ${inventory.runtimeVersionInstalled || t("local_runtime_unknown")} · ${t("local_runtime_expected")}: ${inventory.runtimeVersionExpected || t("local_runtime_unknown")}`;
  const pythonValue = `${t("local_runtime_installed")}: ${inventory.pythonVersionInstalled || t("local_runtime_unknown")} · ${t("local_runtime_expected")}: ${inventory.pythonVersionExpected || t("local_runtime_unknown")}`;
  const installedAt = Number(inventory.installedAt || 0);
  appendMeta("local_runtime_inventory_status", t(statusKey));
  appendMeta("local_runtime_inventory_version", versionValue);
  appendMeta("local_runtime_inventory_python", pythonValue);
  appendMeta("local_runtime_inventory_manifest", inventory.manifestStatus || "");
  appendMeta("local_runtime_inventory_installed_at", Number.isFinite(installedAt) && installedAt > 0 ? new Date(installedAt * 1000).toLocaleString() : "");
  container.append(meta);

  const components = Array.isArray(inventory.components) ? inventory.components : [];
  const componentGroup = document.createElement("section");
  componentGroup.className = "runtime-inventory-components";
  const heading = document.createElement("h4");
  const installedCount = components.filter((item) => item && item.installed).length;
  heading.textContent = `${t("local_runtime_inventory_components")} (${installedCount}/${components.length})`;
  componentGroup.append(heading);
  for (const component of components) {
    const row = document.createElement("div");
    row.className = `runtime-inventory-item ${component.installed ? "ready" : "missing"}`;
    const marker = document.createElement("span");
    marker.className = "runtime-inventory-item-marker";
    marker.textContent = component.installed ? "✓" : "×";
    const name = document.createElement("span");
    name.className = "runtime-inventory-item-name";
    name.textContent = String(component.name || t("local_runtime_unknown"));
    const itemStatus = document.createElement("span");
    itemStatus.className = "runtime-inventory-item-state";
    itemStatus.textContent = t(component.installed ? "local_runtime_component_ready" : "local_runtime_component_missing");
    row.append(marker, name, itemStatus);
    componentGroup.append(row);
  }
  if (!components.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = t("local_runtime_inventory_empty");
    componentGroup.append(empty);
  }
  container.append(componentGroup);
}

async function refreshLocalRuntimeInventory() {
  const button = $("toggleLocalRuntimeInventory");
  state.localRuntimeInventory = null;
  state.localRuntimeInventoryError = "";
  renderLocalRuntimeInventory();
  button.disabled = true;
  const result = await bridge("get_local_runtime_inventory");
  if (state.localRuntimeInventoryOpen) {
    if (!result.ok) state.localRuntimeInventoryError = result.detail || result.error || t("failed");
    else state.localRuntimeInventory = result.inventory || null;
    renderLocalRuntimeInventory();
  }
  button.disabled = false;
  return result;
}

async function toggleLocalRuntimeInventory() {
  state.localRuntimeInventoryOpen = !state.localRuntimeInventoryOpen;
  renderLocalRuntimeInventory();
  if (state.localRuntimeInventoryOpen) await refreshLocalRuntimeInventory();
}

function renderLocalModelCachePathLine(runtime) {
  // 模型缓存链接跟随主页面「模型保存目录」的说明文字，不放在设置运行时区块里。
  const container = $("localModelCachePathLine");
  container.textContent = "";
  const path = runtime.modelCachePath || "";
  container.classList.toggle("hidden", !path);
  if (!path) return;
  container.append(document.createTextNode(t("local_model_cache_path")));
  const link = document.createElement("a");
  link.href = "#";
  link.className = "inline-link runtime-path-link";
  link.textContent = path;
  link.title = t("open_folder_hint");
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    const result = await bridge("open_runtime_folder", { kind: "model-cache" });
    if (!result.ok) setStatus(result.detail || result.error || t("failed"));
    else setStatus(t("saved"));
  });
  container.append(link);
}
function renderOcrRuntimeHint(runtime) {
  const container = $("ocrRuntimeHint");
  container.replaceChildren();
  const detail = runtimeHintText(runtime, "ocr_runtime_ready", "settings_ocr_hint");
  if (detail) appendMessageText(container, detail);
  if (!runtime.path) return;
  if (detail) container.append(document.createElement("br"));
  container.append(document.createTextNode(`${t("ocr_runtime_path")}: `));
  const link = document.createElement("a");
  link.href = "#";
  link.className = "inline-link runtime-path-link";
  link.textContent = runtime.path;
  link.title = t("open_folder_hint");
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    const result = await bridge("open_runtime_folder", { kind: "ocr-runtime" });
    if (!result.ok) setStatus(result.detail || result.error || t("failed"));
    else setStatus(t("saved"));
  });
  container.append(link);
}
function renderLocalRuntimeHint(runtime) {
  const container = $("localRuntimeHint");
  container.replaceChildren();
  if (runtime.ready || runtime.status === "ready") {
    container.append(document.createTextNode(t("local_runtime_ready_prefix")));
    const link = document.createElement("button");
    link.type = "button";
    link.className = "inline-link";
    link.textContent = t("local_runtime_ready_link");
    link.addEventListener("click", () => {
      openSettings("localAsrModelSettingsSection");
      void refreshLocalModels();
      void refreshAlignmentModels();
    });
    container.append(link, document.createTextNode(t("local_runtime_ready_suffix")));
    return;
  }
  const detail = runtimeHintText(runtime, "local_runtime_ready_hint", "local_runtime_hint");
  if (detail) appendMessageText(container, detail);
}
function renderLocalRuntime() {
  if (!isLocalProvider()) return;
  const runtime = state.config.localRuntime || {};
  const installing = state.localRuntimeInstalling || runtime.status === "installing";
  const key = installing ? "local_runtime_installing" : ({ ready: "local_runtime_ready", broken: "local_runtime_broken", missing: "local_runtime_missing", checking: "local_runtime_checking", installing: "local_runtime_installing" }[runtime.status] || "local_runtime_missing");
  renderLocalRuntimePaths(runtime);
  renderLocalModelCachePathLine(runtime);
  const target = $("localRuntimeStatus");
  // 实时流水只保留在进度条下方的 ProgressMessage 行，避免上下双显同一句。
  target.textContent = t(key);
  target.className = `local-status ${installing ? "warn" : (runtime.ready ? "ready" : "warn")}`;
  // 高级选项里的检测结果行与 Runtime 面板状态保持一致。
  const checkStatus = $("localRuntimeCheckStatus");
  checkStatus.textContent = target.textContent;
  checkStatus.className = target.className;
  renderLocalRuntimeHint(runtime);
  $("localRuntimePath").value = runtime.path || $("localRuntimePath").value || "";
  $("localModelCachePath").value = state.config.modelCacheRoot || runtime.modelCachePath || $("localModelCachePath").value || "";
  const button = $("installLocalRuntime");
  button.disabled = false;
  button.classList.toggle("hidden", !installing && runtime.status === "ready");
  button.textContent = installing || runtime.status === "installing" ? t("local_runtime_cancel") : (runtime.status === "missing" ? t("local_runtime_install") : t("local_runtime_repair"));
  $("refreshLocalRuntime").disabled = installing;
  const progress = $("localRuntimeProgress");
  progress.classList.toggle("hidden", !installing);
  $("localRuntimeProgressBar").style.width = `${Math.max(0, Math.min(100, state.localRuntimeProgress))}%`;
  $("localRuntimeProgressMessage").textContent = state.localRuntimeProgressMessage || "";
  renderLocalRuntimeInventory();
}
function renderOcrRuntime() {
  const runtime = state.config?.ocrRuntime || {};
  const installing = state.ocrRuntimeInstalling || runtime.status === "installing";
  const key = installing ? "ocr_runtime_installing" : ({ ready: "ocr_runtime_ready", broken: "ocr_runtime_broken", missing: "ocr_runtime_missing", checking: "ocr_runtime_checking", installing: "ocr_runtime_installing" }[runtime.status] || "ocr_runtime_missing");
  const target = $("ocrRuntimeStatus");
  // 与 localRuntime 一致：状态行固定文案，实时流水只在进度条下方。
  target.textContent = t(key);
  target.className = `local-status ${installing ? "warn" : (runtime.ready ? "ready" : "warn")}`;
  $("ocrRuntimePath").value = runtime.path || $("ocrRuntimePath").value || "";
  renderOcrRuntimeHint(runtime);
  const button = $("installOcrRuntime");
  button.disabled = false;
  button.classList.toggle("hidden", !installing && runtime.status === "ready");
  button.textContent = installing || runtime.status === "installing" ? t("ocr_runtime_cancel") : (runtime.status === "missing" ? t("ocr_runtime_install") : t("ocr_runtime_repair"));
  $("refreshOcrRuntime").disabled = installing;
  const progress = $("ocrRuntimeProgress");
  progress.classList.toggle("hidden", !installing);
  $("ocrRuntimeProgressBar").style.width = `${Math.max(0, Math.min(100, state.ocrRuntimeProgress))}%`;
  $("ocrRuntimeProgressMessage").textContent = state.ocrRuntimeProgressMessage || "";
  window.MAWLauncher?.onOcrRuntimeChanged?.();
}
async function refreshOcrRuntime() {
  const requestId = ++ocrRuntimeRequest;
  const result = await bridge("get_ocr_runtime");
  if (requestId !== ocrRuntimeRequest) return result;
  if (!result.ok) { applyErrorResult(result); return result; }
  state.config.ocrRuntime = result;
  state.config.ocrModels = result.models || state.config.ocrModels || [];
  renderOcrRuntime();
  return result;
}
async function saveOcrRuntimePath(path) {
  const requestId = ++ocrRuntimeRequest;
  const value = String(path || "").trim();
  const result = await bridge("save_ocr_settings", { runtimePath: value });
  if (requestId !== ocrRuntimeRequest) return result;
  if (!result.ok) {
    applyErrorResult(result);
    return result;
  }
  state.config.ocrRuntime = result.runtime || state.config.ocrRuntime || {};
  state.config.ocrRuntime.path = result.runtimePath || value;
  renderOcrRuntime();
  setError("ocrRuntimePath", "");
  setStatus(t("saved"));
  return result;
}
async function saveLocalRuntimePath(path) {
  const requestId = ++localRuntimeRequest;
  const value = String(path || "").trim();
  if (value && /[^\x00-\x7F]/.test(value)) {
    setError("localRuntimePath", errText("local_runtime_path_non_ascii", ""));
    return { ok: false, field: "localRuntimePath", code: "local_runtime_path_non_ascii" };
  }
  const result = await bridge("save_local_settings", { runtimePath: value });
  if (requestId !== localRuntimeRequest) return result;
  if (!result.ok) { applyErrorResult(result); return result; }
  state.config.localRuntime = result.runtime || state.config.localRuntime || {};
  renderLocalRuntime();
  if (isLocalProvider()) { void refreshLocalModels(); void refreshAlignmentModels(); }
  setError("localRuntimePath", "");
  setStatus(t("saved"));
  return result;
}
function renderLocalModelStatus() {
  const entry = $("localModelSettingsEntry");
  const settingsSection = $("localAsrModelSettingsSection");
  if (!isLocalProvider()) {
    $("model").disabled = false;
    entry?.classList.add("hidden");
    settingsSection?.classList.add("hidden");
    renderLocalModelList();
    renderLocalAlignmentModel();
    return;
  }
  entry?.classList.remove("hidden");
  settingsSection?.classList.remove("hidden");
  renderLocalModelList();
  const status = localStatus();
  const preparing = state.localPreparing;
  const target = $("localModelStatus");
  const optionalFireRedPunc = isFireRedModel() && status.ctcReady && !status.puncReady;
  const key = optionalFireRedPunc ? "local_firered_punc_optional" : (status.status === "installed" && status.path ? "local_path_selected" : ({ installed: "local_installed", partial: "local_partial", runtime_missing: "local_runtime_missing", path_mismatch: "local_model_path_mismatch", missing: "local_missing", checking: "local_checking" }[status.status] || "local_missing"));
  // 与 runtime 面板一致：preparing 状态行固定"正在准备"文案，实时流水只在进度条下方。
  target.textContent = "";
  if (!preparing && status.status === "runtime_missing") {
    renderLocalRuntimeMissingHint(target);
  } else {
    target.textContent = t(preparing ? "local_prepare_running" : key);
  }
  target.className = `local-status ${preparing ? "warn" : (status.status === "installed" ? "ready" : "warn")}`;
  $("localModelPath").value = status.path || $("localModelPath").value || "";
  const canPrepare = Boolean(status.canPrepare) && !preparing;
  const button = $("prepareLocalModel");
  button.disabled = preparing ? false : !canPrepare;
  button.classList.toggle("hidden", !preparing && !canPrepare);
  button.textContent = preparing ? t("local_prepare_cancel") : (optionalFireRedPunc ? t("local_prepare_optional") : (status.status === "installed" ? t("local_prepare_again") : t("local_prepare")));
  $("model").disabled = preparing;
  $("localModelProgress").classList.toggle("hidden", !preparing);
  const progress = state.localProgress || {};
  const percent = Number(progress.percent);
  const determinate = Number.isFinite(percent);
  const track = $("localModelProgressTrack");
  const bar = $("localModelProgressBar");
  track.classList.toggle("indeterminate", !determinate);
  bar.style.width = determinate ? `${Math.max(0, Math.min(99, percent))}%` : "";
  $("localModelProgressMessage").textContent = state.localProgressMessage || "";
  renderLocalAlignmentModel();
}

function renderLocalRuntimeMissingHint(target) {
  target.textContent = "";
  target.append(document.createTextNode(t("local_runtime_missing")));
  target.append(document.createTextNode(state.lang === "zh" ? "，" : ", "));
  target.append(document.createTextNode(t("local_runtime_configure_prefix")));
  const configure = document.createElement("button");
  configure.type = "button";
  configure.className = "inline-link";
  configure.textContent = t("local_runtime_configure");
  configure.addEventListener("click", () => {
    openSettings("localRuntimePanel");
    void refreshLocalRuntime();
  });
  target.append(configure);
  target.append(document.createTextNode(t("local_runtime_configure_suffix")));
}

function alignmentModelLabel(model) {
  const id = String(model?.id || model?.modelId || "");
  if (state.lang === "en") {
    if (id === "qwen3-forced-aligner-0.6b") return "Qwen3-ForcedAligner 0.6B";
    if (id === "firered-asr2-ctc") return "FireRedASR2";
  }
  return model?.label || model?.modelRef || id;
}

function modelProvidesWordTimestamps(model = selectedModel()) {
  if (model?.supportsWordTimestamps !== undefined) return Boolean(model.supportsWordTimestamps);
  return ["qwen3-asr-local", "firered-asr2-ctc-local", "whisper-large-v3-local"].includes(model?.id);
}

function renderAlignmentModelOptions(select, models, selected) {
  select.textContent = "";
  select.add(new Option(t("alignment_model_none"), ""));
  models.forEach((model) => {
    const suffix = model.estimatedSize ? ` · ${model.estimatedSize}` : "";
    select.add(new Option(`${alignmentModelLabel(model)}${suffix}`, model.id));
  });
  select.value = selected;
}

function alignmentModelStatus(model) {
  const preparing = state.alignmentPreparing === model.id;
  const runtimeReady = model.runtimeAvailable === undefined
    ? Boolean(state.config.localRuntime?.ready)
    : Boolean(model.runtimeAvailable);
  const statusKey = preparing
    ? "alignment_model_downloading"
    : (model.status === "checking" ? "alignment_model_checking" : (!runtimeReady ? "alignment_model_runtime_missing" : (model.installed ? "alignment_model_ready" : "alignment_model_missing")));
  return { preparing, runtimeReady, statusKey };
}

function renderRecognitionAlignmentModel(models) {
  const field = $("recognitionAlignmentModelField");
  const select = $("recognitionAlignmentModel");
  const statusTarget = $("recognitionAlignmentModelStatus");
  if (!field || !select || !statusTarget) return;
  const needsAlignmentModel = isLocalProvider() && !modelProvidesWordTimestamps();
  field.classList.toggle("hidden", !needsAlignmentModel);
  if (!needsAlignmentModel) {
    renderAlignmentModelOptions(select, models, "");
    select.disabled = true;
    statusTarget.textContent = "";
    statusTarget.className = "hint";
    return;
  }
  const selected = models.some((model) => model.id === state.alignmentModelSelection) ? state.alignmentModelSelection : "";
  renderAlignmentModelOptions(select, models, selected);
  select.disabled = Boolean(state.localPreparing || state.alignmentPreparing);
  const model = models.find((item) => item.id === selected);
  if (!model) {
    statusTarget.textContent = "";
    statusTarget.className = "hint";
    return;
  }
  const { preparing, runtimeReady, statusKey } = alignmentModelStatus(model);
  if (!preparing && !runtimeReady && statusKey === "alignment_model_runtime_missing") {
    renderLocalRuntimeMissingHint(statusTarget);
  } else {
    statusTarget.textContent = preparing && state.alignmentProgressMessage
      ? `${t(statusKey)} ${state.alignmentProgressMessage}`
      : t(statusKey);
  }
  statusTarget.className = `hint ${model.installed && runtimeReady && !preparing ? "success" : ""}`;
}

function renderLocalAlignmentModelList(models) {
  const container = $("localAlignmentModelList");
  if (!container) return;
  container.replaceChildren();
  if (!isLocalProvider()) {
    container.classList.add("hidden");
    return;
  }
  container.classList.toggle("hidden", !models.length);
  const selectedId = state.alignmentModelManagementId;
  models.forEach((model) => {
    const item = document.createElement("div");
    item.setAttribute("role", "listitem");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "local-model-list-item";
    button.classList.toggle("active", model.id === selectedId);
    const { preparing, runtimeReady, statusKey } = alignmentModelStatus(model);
    const ready = Boolean(model.installed && runtimeReady && !preparing);
    button.classList.toggle("ready", ready);
    button.disabled = Boolean(state.alignmentPreparing);
    button.setAttribute("aria-pressed", String(model.id === selectedId));
    button.dataset.modelId = model.id;

    const main = document.createElement("span");
    main.className = "local-model-list-main";
    const label = document.createElement("span");
    label.className = "local-model-list-label";
    label.textContent = alignmentModelLabel(model);
    main.append(label);
    appendLocalModelBadges(main, model);
    const note = model.note || model.modelRef || "";
    if (note) {
      button.title = note;
      const noteElement = document.createElement("span");
      noteElement.className = "local-model-list-note";
      noteElement.title = note;
      noteElement.textContent = note;
      main.append(noteElement);
    }
    const status = document.createElement("span");
    status.className = `local-model-list-status ${ready ? "ready" : ""}`.trim();
    status.textContent = ready ? "✓" : "";
    status.setAttribute("aria-label", t(statusKey));
    status.title = t(statusKey);
    button.append(main, status);
    item.append(button);
    container.append(item);
    button.addEventListener("click", () => {
      if (button.disabled || state.alignmentModelManagementId === model.id) return;
      state.alignmentModelManagementId = model.id;
      renderLocalAlignmentModel();
    });
  });
}

function renderLocalAlignmentModel() {
  const button = $("prepareAlignmentModel");
  const statusTarget = $("localAlignmentModelStatus");
  if (!button || !statusTarget) return;
  const section = $("alignmentModelSettingsSection");
  const local = isLocalProvider();
  const models = Array.isArray(state.config?.alignmentModels) ? state.config.alignmentModels : [];
  section?.classList.toggle("hidden", !local);
  const selected = local && models.some((model) => model.id === state.alignmentModelManagementId)
    ? state.alignmentModelManagementId
    : (local ? models[0]?.id || "" : "");
  state.alignmentModelManagementId = selected;
  renderLocalAlignmentModelList(models);
  if (!local) {
    button.disabled = true;
    button.classList.add("hidden");
    statusTarget.textContent = "";
    statusTarget.className = "local-status";
    renderRecognitionAlignmentModel(models);
    return;
  }
  const model = models.find((item) => item.id === selected);
  if (!model) {
    statusTarget.textContent = "";
    statusTarget.className = "local-status warn";
    button.disabled = true;
    button.classList.add("hidden");
    renderRecognitionAlignmentModel(models);
    return;
  }
  button.classList.remove("hidden");
  const { preparing, runtimeReady, statusKey } = alignmentModelStatus(model);
  if (!preparing && !runtimeReady && statusKey === "alignment_model_runtime_missing") {
    renderLocalRuntimeMissingHint(statusTarget);
  } else {
    statusTarget.textContent = preparing && state.alignmentProgressMessage
      ? `${t(statusKey)} ${state.alignmentProgressMessage}`
      : t(statusKey);
  }
  statusTarget.className = `local-status ${model.installed && runtimeReady && !preparing ? "ready" : "warn"}`;
  button.disabled = preparing ? false : (!runtimeReady || model.status === "checking");
  button.textContent = preparing ? t("alignment_model_cancel") : (model.installed ? t("alignment_model_download_again") : t("alignment_model_download"));
  renderRecognitionAlignmentModel(models);
}
async function refreshLocalRuntime() {
  if (!isLocalProvider()) return;
  const requestId = ++localRuntimeRequest;
  const statusRequestId = ++localStatusRequest;
  const modelId = $("model").value;
  const result = await bridge("get_local_runtime", { modelId: $("model").value });
  if (requestId !== localRuntimeRequest || statusRequestId !== localStatusRequest || !isLocalProvider() || $("model").value !== modelId) return result;
  if (!result.ok) { applyErrorResult(result); return result; }
  state.config.localRuntime = result;
  state.config.modelCacheRoot = result.modelCachePath || state.config.modelCacheRoot || "";
  renderLocalRuntime();
  if (state.localRuntimeInventoryOpen) void refreshLocalRuntimeInventory();
  return result;
}
async function refreshLocalModels() {
  if (!isLocalProvider()) return;
  const requestId = ++localModelsRequest;
  const statusRequestId = ++localStatusRequest;
  const modelId = $("model").value;
  const modelPath = $("localModelPath").value.trim();
  const result = await bridge("get_local_models", { modelId, modelPath, modelPaths: { ...state.localModelPaths } });
  if (requestId !== localModelsRequest || statusRequestId !== localStatusRequest || !isLocalProvider() || $("model").value !== modelId || $("localModelPath").value.trim() !== modelPath) return result;
  if (!result.ok) { applyErrorResult(result); return result; }
  if (result.runtime) {
    state.config.localRuntime = result.runtime;
    state.config.modelCacheRoot = result.runtime.modelCachePath || state.config.modelCacheRoot || "";
  }
  const models = result.models || [];
  models.forEach((item) => { const local = provider().models.find((model) => model.id === item.id); if (local && item.localStatus) local.localStatus = item.localStatus; });
  renderLocalModelStatus();
  renderLocalRuntime();
  return result;
}
async function refreshAlignmentModels() {
  const requestId = ++alignmentModelsRequest;
  const result = await bridge("get_alignment_models");
  if (requestId !== alignmentModelsRequest) return result;
  if (!result.ok) {
    appendLog(`[alignment models] ${result.detail || result.error || "failed to inspect models"}`);
    return result;
  }
  if (Array.isArray(result.models)) state.config.alignmentModels = result.models;
  if (result.modelCacheRoot) state.config.modelCacheRoot = result.modelCacheRoot;
  if (result.runtime && typeof result.runtime === "object") state.config.localRuntime = result.runtime;
  renderLocalAlignmentModel();
  window.MAWLauncher?.onAlignmentModelsChanged?.();
  return result;
}
function syncLocalModelPath(model) {
  if (!isLocalProvider()) return;
  if (state.localModelId && state.localModelId !== model.id) state.localModelPaths[state.localModelId] = $("localModelPath").value.trim();
  $("localModelPath").value = state.localModelPaths[model.id] || "";
  state.localModelId = model.id;
  setError("localModelPath", "");
}
async function saveLocalModelCache(path) {
  const value = String(path || "").trim();
  const result = await bridge("save_settings", { providerId: "local", modelId: $("model").value, apiKey: "", guiLang: state.lang, modelCacheRoot: value });
  if (!result.ok) {
    applyErrorResult(result);
    setStatus(errText(result.code, result.detail || result.error));
    return result;
  }
  state.config.modelCacheRoot = result.modelCacheRoot || value;
  await refreshLocalModels();
  await refreshAlignmentModels();
  setError("localModelCachePath", "");
  setStatus(t("saved"));
  return result;
}

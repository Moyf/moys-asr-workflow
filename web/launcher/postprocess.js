(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const panels = { match: "toolboxMatchPanel", ocr: "toolboxOcrPanel", llm: "toolboxLlmPanel", replace: "toolboxReplacePanel", ffconcat: "toolboxFfconcatPanel" };
  const TASK_PROMPT_KEYS = { proofread: "toolbox_task_proofread", resegment: "toolbox_task_resegment", translate_en: "toolbox_task_translate_en", translate_zh: "toolbox_task_translate_zh" };
  const SUBTITLE_EXTS = new Set([".mosp", ".json", ".srt"]);
  const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"]);
  const SCRIPT_EXTS = new Set([".txt", ".md", ".markdown"]);
  const TOOLBOX_SIZE_KEY = "maw.launcher.toolbox.size";
  const TOOLBOX_MIN_WIDTH = 360;
  const TOOLBOX_MIN_HEIGHT = 320;
  const TOOLBOX_MAX_HEIGHT = 680;
  const CUSTOM_DEFAULT_LABEL = "Custom (OpenAI-compatible)";
  let busy = false;
  let inputManual = false;
  let ocrVideoManual = false;
  let saveStatusTimer = 0;
  let modelChoices = [];
  let modelChoicesOpen = false;

  function t(key) {
    return window.MAWLauncher.translate(key);
  }

  function taskPromptText(operation = $("postprocessOperation").value) {
    const key = TASK_PROMPT_KEYS[operation];
    return key ? t(key) : "";
  }

  function renderTaskPrompt(operation = $("postprocessOperation").value) {
    const prompt = taskPromptText(operation);
    const display = $("postprocessTaskPrompt");
    display.textContent = prompt || t("toolbox_task_none");
    display.classList.toggle("empty", !prompt);
  }

  function bridge(method, payload = {}) {
    return window.MAWLauncher.callBackend(method, payload);
  }

  function extension(path) {
    return (String(path || "").match(/\.[^.\\/]+$/u)?.[0] || "").toLowerCase();
  }

  function provider(providerId = $("postprocessProvider").value) {
    const providers = window.MAWLauncher.config.postprocessProviders;
    return providers.find((item) => item.id === providerId) || providers[0];
  }

  function providerLabel(item) {
    if (item.id === "custom") return item.displayName || item.defaultLabel || item.label || CUSTOM_DEFAULT_LABEL;
    return item.label || item.defaultLabel || item.id;
  }

  function syncProviderOptionLabels() {
    const providers = window.MAWLauncher.config?.postprocessProviders || [];
    [$("postprocessProvider"), $("llmProvider")].forEach((select) => {
      providers.forEach((item) => {
        const option = Array.from(select.options).find((candidate) => candidate.value === item.id);
        if (option) option.textContent = providerLabel(item);
      });
    });
  }

  function renderModelChoiceList(query = "") {
    const list = $("llmModelOptions");
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
    const visibleModels = normalizedQuery
      ? modelChoices.filter((model) => model.toLocaleLowerCase().includes(normalizedQuery))
      : modelChoices;
    list.textContent = "";
    visibleModels.forEach((model) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "llm-model-option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(model === $("llmModel").value.trim()));
      option.textContent = model;
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => {
        $("llmModel").value = model;
        setFieldError("llmModel", "");
        setModelChoicesOpen(false);
        $("llmModel").focus();
      });
      list.append(option);
    });
    list.classList.toggle("hidden", !modelChoicesOpen || visibleModels.length === 0);
  }

  function setModelChoicesOpen(open, query = "") {
    modelChoicesOpen = Boolean(open && modelChoices.length);
    $("llmModelChoicesToggle").setAttribute("aria-expanded", String(modelChoicesOpen));
    $("llmModel").setAttribute("aria-expanded", String(modelChoicesOpen));
    renderModelChoiceList(query);
  }

  function renderModelChoices(models = []) {
    const status = $("llmModelStatus");
    modelChoices = Array.from(new Set(
      (Array.isArray(models) ? models : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ));
    $("llmModelChoicesToggle").classList.toggle("hidden", modelChoices.length === 0);
    setModelChoicesOpen(false);
    status.classList.toggle("hidden", modelChoices.length === 0);
    status.textContent = modelChoices.length
      ? t("llm_models_loaded").replace("{count}", String(modelChoices.length))
      : "";
  }

  function updateCustomDisplayName(value) {
    const item = provider("custom");
    if (!item) return;
    item.displayName = String(value || "").trim();
    item.label = providerLabel(item);
    syncProviderOptionLabels();
    if (provider().id === "custom") {
      const keyStatus = item.maskedApiKey ? t("toolbox_key_loaded").replace("{key}", item.maskedApiKey) : t("toolbox_key_empty");
      $("postprocessProviderStatus").textContent = `${providerLabel(item)} · ${keyStatus}`;
    }
  }

  function autoSourcePath() {
    return $("jsonPath").value.trim() || $("srtPath").value.trim();
  }

  function fileName(path) {
    const value = String(path || "").trim();
    return value.split(/[\\/]/u).pop() || value;
  }

  function clearChainSelection() {
    document.querySelectorAll(".toolbox-chain-file.selected").forEach((button) => button.classList.remove("selected"));
  }

  function syncInputName() {
    const path = $("toolboxInputPath").value.trim() || autoSourcePath();
    const name = $("toolboxInputName");
    const hasPath = Boolean(path);
    name.textContent = hasPath ? fileName(path) : t("toolbox_input_empty");
    name.title = path;
    name.classList.toggle("empty", !hasPath);
  }

  function syncPaths() {
    if (!inputManual) $("toolboxInputPath").value = autoSourcePath();
    $("toolboxMediaPath").textContent = $("mediaPath").value.trim() || t("toolbox_no_media");
    syncOcrVideo();
    syncInputName();
  }

  function autoOcrVideoPath() {
    const mediaPath = $("mediaPath").value.trim();
    return VIDEO_EXTS.has(extension(mediaPath)) ? mediaPath : "";
  }

  function ocrSourcePath() {
    return $("toolboxInputPath").value.trim() || autoSourcePath();
  }

  function ocrSourceIsProject() {
    const source = ocrSourcePath();
    return Boolean(source) && extension(source) !== ".srt";
  }

  function syncOcrVideo() {
    if (!ocrVideoManual) $("ocrVideoPath").value = ocrSourceIsProject() ? "" : autoOcrVideoPath();
  }

  function renderOcrRegion() {
    $("ocrCustomRegion").classList.toggle("hidden", $("ocrRegionMode").value !== "custom_region");
  }

  function renderOcrModel() {
    const config = window.MAWLauncher.config || {};
    const models = Array.isArray(config.ocrModels) && config.ocrModels.length
      ? config.ocrModels
      : [
        { id: "pp-ocrv6-tiny", label: "PP-OCRv6 tiny（CPU）", installed: false, status: "missing" },
        { id: "pp-ocrv6-small", label: "PP-OCRv6 small（CPU）", installed: false, status: "missing" }
      ];
    const select = $("ocrModel");
    const selected = select.value || config.ocrModelId || models[0].id;
    select.textContent = "";
    models.forEach((model) => select.add(new Option(
      model.id === "pp-ocrv6-tiny" ? t("toolbox_ocr_model_tiny") : (model.id === "pp-ocrv6-small" ? t("toolbox_ocr_model_small") : (model.label || model.id)),
      model.id,
    )));
    select.value = models.some((model) => model.id === selected) ? selected : models[0].id;
    const model = models.find((item) => item.id === select.value) || models[0];
    const runtime = config.ocrRuntime || {};
    const ready = Boolean(runtime.ready && model.installed);
    $("ocrModelStatus").textContent = ready ? t("toolbox_ocr_model_ready") : t("toolbox_ocr_model_missing");
    $("ocrModelStatus").classList.toggle("error", !ready);
    $("runOcrDedup").disabled = busy || !ready;
  }

  function renderProvider(providerId = $("postprocessProvider").value) {
    const item = provider(providerId);
    syncProviderOptionLabels();
    $("postprocessProvider").value = item.id;
    $("llmProvider").value = item.id;
    $("llmBaseUrl").value = item.baseUrl || "";
    $("llmModel").value = item.model || "";
    renderModelChoices(item.availableModels || []);
    $("llmReasoningMode").value = item.reasoningMode || "off";
    $("llmApiKey").value = "";
    $("llmApiKey").placeholder = item.maskedApiKey || "";
    $("llmCustomDisplayNameField").classList.toggle("hidden", item.id !== "custom");
    $("llmCustomDisplayName").value = item.id === "custom" ? item.displayName || "" : "";
    setFieldError("llmCustomDisplayName", "");
    setFieldError("llmReasoningMode", "");
    setSettingsSaveStatus("");
    $("llmKeyStatus").textContent = item.maskedApiKey
      ? t("toolbox_key_loaded").replace("{key}", item.maskedApiKey)
      : t("toolbox_key_empty");
    $("postprocessProviderStatus").textContent = `${providerLabel(item)} · ${item.maskedApiKey ? t("toolbox_key_loaded").replace("{key}", item.maskedApiKey) : t("toolbox_key_empty")}`;
  }

  function setOpen(open) {
    $("toolboxDrawer").classList.toggle("hidden", !open);
    $("toolboxFab").setAttribute("aria-expanded", String(open));
    syncPaths();
    if (open) $("toolboxClose").focus();
  }

  function selectTool(tool) {
    document.querySelectorAll(".toolbox-tab").forEach((tab) => {
      const active = tab.dataset.tool === tool;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    Object.entries(panels).forEach(([name, id]) => $(id).classList.toggle("hidden", name !== tool));
    document.querySelectorAll("[data-tool-action]").forEach((action) => {
      action.classList.toggle("hidden", action.dataset.toolAction !== tool);
    });
  }

  function clampToolboxSize(width, height) {
    const maxWidth = Math.max(TOOLBOX_MIN_WIDTH, window.innerWidth - 40);
    const maxHeight = Math.max(TOOLBOX_MIN_HEIGHT, Math.min(TOOLBOX_MAX_HEIGHT, window.innerHeight - 156));
    return {
      width: Math.round(Math.min(Math.max(width, TOOLBOX_MIN_WIDTH), maxWidth)),
      height: Math.round(Math.min(Math.max(height, TOOLBOX_MIN_HEIGHT), maxHeight)),
    };
  }

  function applyToolboxSize(width, height) {
    const size = clampToolboxSize(width, height);
    const drawer = $("toolboxDrawer");
    drawer.style.width = `${size.width}px`;
    drawer.style.blockSize = `${size.height}px`;
    return size;
  }

  function persistToolboxSize(size) {
    try {
      localStorage.setItem(TOOLBOX_SIZE_KEY, JSON.stringify(size));
    } catch (error) { /* localStorage 不可用时仅本次会话生效 */ }
  }

  function restoreToolboxSize() {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(TOOLBOX_SIZE_KEY) || "null");
    } catch (error) {
      stored = null;
    }
    if (!stored || !Number.isFinite(stored.width) || !Number.isFinite(stored.height)) return;
    applyToolboxSize(stored.width, stored.height);
  }

  // 抽屉右下锚定：顶边把手向上拉高、左边把手向左拉宽，拖拽结束写入 localStorage。
  function bindToolboxResize(handle, axis) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const rect = $("toolboxDrawer").getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
      let size = { width: rect.width, height: rect.height };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
      const onMove = (moveEvent) => {
        size = axis === "y"
          ? applyToolboxSize(start.width, start.height + start.y - moveEvent.clientY)
          : applyToolboxSize(start.width + start.x - moveEvent.clientX, start.height);
      };
      const onEnd = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        handle.classList.remove("dragging");
        persistToolboxSize(size);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    });
    handle.addEventListener("keydown", (event) => {
      const keys = axis === "y" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? 96 : 24;
      const grow = event.key === "ArrowUp" || event.key === "ArrowLeft";
      const rect = $("toolboxDrawer").getBoundingClientRect();
      const size = axis === "y"
        ? applyToolboxSize(rect.width, rect.height + (grow ? step : -step))
        : applyToolboxSize(rect.width + (grow ? step : -step), rect.height);
      persistToolboxSize(size);
    });
  }

  function setupToolboxResize() {
    bindToolboxResize($("toolboxResizeY"), "y");
    bindToolboxResize($("toolboxResizeX"), "x");
    restoreToolboxSize();
    window.addEventListener("resize", restoreToolboxSize);
  }

  function setResult(message, kind = "") {
    const result = $("toolboxResult");
    result.textContent = message;
    result.classList.toggle("success", kind === "success");
    result.classList.toggle("error", kind === "error");
  }

  function renderPostprocessStatus(event) {
    if (!busy) return;
    let message = t(event.key || "toolbox_running");
    Object.entries(event).forEach(([key, value]) => {
      message = message.replaceAll(`{${key}}`, String(value));
    });
    setResult(message);
  }

  function resetStreamOutput() {
    $("toolboxStreamOutput").classList.add("hidden");
    $("toolboxThinkingPanel").classList.add("hidden");
    $("toolboxThinkingOutput").textContent = "";
    $("toolboxModelOutput").textContent = "";
    $("toolboxStreamMeta").textContent = "";
    $("toolboxThinkingCount").textContent = "";
    $("toolboxModelCount").textContent = "";
  }

  function beginStreamOutput() {
    resetStreamOutput();
    $("toolboxStreamOutput").classList.remove("hidden");
    $("toolboxModelPanel").open = true;
  }

  function appendStreamText(element, text) {
    element.textContent += String(text || "");
    element.scrollTop = element.scrollHeight;
  }

  function renderPostprocessStream(event) {
    if (event.kind === "reset") {
      beginStreamOutput();
      return;
    }
    if ($("toolboxStreamOutput").classList.contains("hidden")) return;
    const text = String(event.text || "");
    if (!text) return;
    const batch = Number(event.batch || 0);
    if (batch > 0) {
      $("toolboxStreamMeta").textContent = t("toolbox_stream_batch").replace("{batch}", String(batch));
    }
    if (event.kind === "reasoning") {
      $("toolboxThinkingPanel").classList.remove("hidden");
      $("toolboxThinkingPanel").open = true;
      appendStreamText($("toolboxThinkingOutput"), text);
      $("toolboxThinkingCount").textContent = t("toolbox_stream_chars").replace("{count}", String($("toolboxThinkingOutput").textContent.length));
      return;
    }
    appendStreamText($("toolboxModelOutput"), text);
    $("toolboxModelCount").textContent = t("toolbox_stream_chars").replace("{count}", String($("toolboxModelOutput").textContent.length));
  }

  function setSettingsSaveStatus(message, kind = "", timeoutMs = 2400) {
    const status = $("llmSettingsSaveStatus");
    if (!status) return;
    window.clearTimeout(saveStatusTimer);
    status.textContent = message;
    status.classList.toggle("success", kind === "success");
    status.classList.toggle("error", kind === "error");
    if (message && timeoutMs > 0) {
      saveStatusTimer = window.setTimeout(() => setSettingsSaveStatus(""), timeoutMs);
    }
  }

  function setBusy(nextBusy, statusKey = "toolbox_running") {
    busy = nextBusy;
    $("toolboxProgress").classList.toggle("hidden", !busy);
    ["runScriptMatch", "runOcrDedup", "runLlmPostprocess", "runFixedReplacement", "runFfconcatRebuild", "saveLlmSettings", "testLlmConnection", "getLlmModels", "toolboxInputPath", "pickToolboxInput", "postprocessProvider", "llmProvider", "llmApiKey", "llmBaseUrl", "llmModel", "llmModelChoicesToggle", "llmReasoningMode", "llmCustomDisplayName", "ocrModel", "openOcrSettings", "ocrVideoPath", "pickOcrVideo", "ocrRegionMode", "ocrRegionX1", "ocrRegionY1", "ocrRegionX2", "ocrRegionY2", "ocrThreshold", "ocrReport"].forEach((id) => {
      $(id).disabled = busy;
    });
    renderOcrModel();
    if (busy) setModelChoicesOpen(false);
    if (busy) setResult(t(statusKey));
  }

  function resolveInputPaths() {
    const paths = inputPaths();
    if (paths === null) {
      setFieldError("toolboxInputPath", t("toolbox_drop_reject"));
      setResult(t("toolbox_drop_reject"), "error");
      return null;
    }
    setFieldError("toolboxInputPath", "");
    if (!paths.projectPath && !paths.srtPath) {
      setResult(t("toolbox_need_source"), "error");
      return null;
    }
    return paths;
  }

  function inputPaths() {
    const source = $("toolboxInputPath").value.trim() || autoSourcePath();
    if (source && !SUBTITLE_EXTS.has(extension(source))) return null;
    return {
      projectPath: extension(source) === ".srt" ? "" : source,
      srtPath: extension(source) === ".srt" ? source : "",
      outputMode: $("postprocessOutputMode").value,
    };
  }

  function setFieldError(field, message) {
    const input = $(field);
    const hint = $(`${field}Error`);
    input?.classList.toggle("invalid", Boolean(message));
    if (hint) {
      hint.textContent = message;
      hint.classList.toggle("visible", Boolean(message));
    }
  }

  function chainLabel(kind, operation = "") {
    if (kind === "match") return t("toolbox_chain_match");
    if (kind === "ocr") return t("toolbox_chain_ocr");
    if (kind === "replace") return t("toolbox_chain_replace");
    const operationKeys = {
      proofread: "toolbox_chain_llm_proofread",
      resegment: "toolbox_chain_llm_resegment",
      translate_en: "toolbox_chain_llm_translate",
      translate_zh: "toolbox_chain_llm_translate",
    };
    return t(operationKeys[operation] || "toolbox_chain_llm_custom");
  }

  function selectChainPath(path, button) {
    inputManual = true;
    $("toolboxInputPath").value = path;
    $("toolboxInputPath").dispatchEvent(new Event("input", { bubbles: true }));
    setFieldError("toolboxInputPath", "");
    clearChainSelection();
    button.classList.add("selected");
  }

  function addChainResult(chain, result) {
    const paths = [result.projectPath, result.srtPath]
      .filter(Boolean)
      .filter((path, index, all) => all.indexOf(path) === index);
    if (!paths.length) return;
    const container = $("toolboxChain");
    const list = $("toolboxChainList");
    const item = document.createElement("div");
    item.className = "toolbox-chain-item";
    const label = document.createElement("span");
    label.className = "toolbox-chain-label";
    label.textContent = chainLabel(chain.kind, chain.operation);
    const files = document.createElement("div");
    files.className = "toolbox-chain-files";
    paths.forEach((path) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toolbox-chain-file";
      button.textContent = fileName(path);
      button.title = path;
      button.setAttribute("aria-label", `${label.textContent}: ${path}`);
      button.addEventListener("click", () => selectChainPath(path, button));
      button.addEventListener("dblclick", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const result = await bridge("open_file", { path });
        if (!result.ok) setResult(result.error || t("failed"), "error");
      });
      files.append(button);
    });
    item.append(label, files);
    list.append(item);
    container.classList.remove("hidden");
    list.scrollTop = list.scrollHeight;
  }

  function applySubtitleResult(result, chain) {
    if (result.projectPath) {
      $("jsonPath").value = result.projectPath;
      $("jsonPath").dispatchEvent(new Event("change", { bubbles: true }));
    } else if (result.srtPath) {
      $("jsonPath").value = "";
      $("jsonPath").dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (result.srtPath) {
      $("srtPath").value = result.srtPath;
      $("srtPath").dispatchEvent(new Event("input", { bubbles: true }));
    } else if (result.projectPath) {
      $("srtPath").value = "";
      $("srtPath").dispatchEvent(new Event("input", { bubbles: true }));
    }
    inputManual = false;
    syncPaths();
    addChainResult(chain, result);
    const warnings = Array.isArray(result.warnings) ? [...result.warnings] : [];
    if (result.reportPath) warnings.push(`${t("toolbox_ocr_report_path")} ${result.reportPath}`);
    setResult(`${t("toolbox_done")}${warnings.length ? `\n${warnings.join("\n")}` : ""}`, "success");
  }

  function parseReplacements() {
    return $("postprocessReplacements").value.split(/\r?\n/u).map((line) => {
      const separator = line.indexOf("=>");
      return separator < 0 ? null : {
        source: line.slice(0, separator).trim(),
        target: line.slice(separator + 2).trim(),
      };
    }).filter((item) => item?.source);
  }

  async function runScriptMatch() {
    const paths = resolveInputPaths();
    if (!paths) return;
    const scriptPath = $("postprocessScriptPath").value.trim();
    if (!SCRIPT_EXTS.has(extension(scriptPath))) {
      setFieldError("postprocessScriptPath", t("toolbox_script_reject"));
      setResult(t("toolbox_need_script"), "error");
      return;
    }
    setFieldError("postprocessScriptPath", "");
    setBusy(true, "toolbox_status_starting");
    try {
      const result = await bridge("run_script_match", { ...paths, scriptPath });
      if (result.ok) applySubtitleResult(result, { kind: "match" });
      else setResult(result.error || result.detail || t("failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  function ocrRegionPayload() {
    return {
      regionMode: $("ocrRegionMode").value === "custom_region" ? "custom" : $("ocrRegionMode").value,
      regionX1: $("ocrRegionX1").value,
      regionY1: $("ocrRegionY1").value,
      regionX2: $("ocrRegionX2").value,
      regionY2: $("ocrRegionY2").value,
    };
  }

  async function runOcrDedup() {
    const paths = resolveInputPaths();
    if (!paths) return;
    const threshold = Number($("ocrThreshold").value);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      const message = t("toolbox_ocr_threshold_invalid");
      setFieldError("ocrThreshold", message);
      setResult(message, "error");
      return;
    }
    const videoPath = ocrVideoManual ? $("ocrVideoPath").value.trim() : "";
    const fallbackVideoPath = !ocrVideoManual && !ocrSourceIsProject() ? autoOcrVideoPath() : "";
    if (videoPath && !VIDEO_EXTS.has(extension(videoPath))) {
      const message = t("toolbox_ocr_video_reject");
      setFieldError("ocrVideoPath", message);
      setResult(message, "error");
      return;
    }
    setFieldError("ocrVideoPath", "");
    setFieldError("ocrThreshold", "");
    setBusy(true, "toolbox_status_starting");
    try {
      const result = await bridge("run_ocr_dedup", {
        ...paths,
        modelId: $("ocrModel").value,
        videoPath,
        fallbackVideoPath,
        threshold,
        report: $("ocrReport").checked,
        ...ocrRegionPayload(),
      });
      if (result.ok) applySubtitleResult(result, { kind: "ocr" });
      else setResult(result.error || result.detail || t("failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    setSettingsSaveStatus("");
    const item = provider();
    const result = await bridge("save_postprocess_settings", {
      providerId: item.id,
      apiKey: $("llmApiKey").value.trim(),
      baseUrl: $("llmBaseUrl").value.trim(),
      model: $("llmModel").value.trim(),
      reasoningMode: $("llmReasoningMode").value,
      displayName: item.id === "custom" ? $("llmCustomDisplayName").value.trim() : "",
    });
    if (!result.ok) {
      const field = result.field === "postprocessApiKey"
        ? "llmApiKey"
        : (result.field === "postprocessBaseUrl" ? "llmBaseUrl" : (result.field === "postprocessModel" ? "llmModel" : (result.field === "postprocessReasoningMode" ? "llmReasoningMode" : (result.field === "postprocessDisplayName" ? "llmCustomDisplayName" : ""))));
      if (field) setFieldError(field, result.detail || result.error || t("failed"));
      setSettingsSaveStatus(result.error || result.detail || t("failed"), "error");
      setResult(result.error || result.detail || t("failed"), "error");
      return;
    }
    ["llmApiKey", "llmBaseUrl", "llmModel", "llmReasoningMode", "llmCustomDisplayName"].forEach((field) => setFieldError(field, ""));
    item.baseUrl = $("llmBaseUrl").value.trim();
    item.model = $("llmModel").value.trim();
    item.reasoningMode = result.reasoningMode || $("llmReasoningMode").value || "off";
    item.displayName = item.id === "custom" ? $("llmCustomDisplayName").value.trim() : "";
    item.label = result.label || providerLabel(item);
    item.maskedApiKey = result.maskedApiKey || item.maskedApiKey;
    syncProviderOptionLabels();
    renderProvider(item.id);
    setSettingsSaveStatus(t("toolbox_saved"), "success");
  }

  async function testConnection() {
    setSettingsSaveStatus(t("llm_connection_testing"), "", 0);
    $("testLlmConnection").disabled = true;
    $("getLlmModels").disabled = true;
    try {
      const item = provider();
      const result = await bridge("test_postprocess_connection", {
        providerId: item.id,
        apiKey: $("llmApiKey").value.trim(),
        baseUrl: $("llmBaseUrl").value.trim(),
        model: $("llmModel").value.trim(),
        reasoningMode: $("llmReasoningMode").value,
      });
      if (result.ok) setSettingsSaveStatus(t("llm_connection_success"), "success");
      else setSettingsSaveStatus(result.detail || result.error || t("failed"), "error", 0);
    } catch (error) {
      setSettingsSaveStatus(String(error?.message || error || t("failed")), "error", 0);
    } finally {
      $("testLlmConnection").disabled = busy;
      $("getLlmModels").disabled = busy;
    }
  }

  async function getModels() {
    setSettingsSaveStatus(t("llm_models_loading"), "", 0);
    $("testLlmConnection").disabled = true;
    $("getLlmModels").disabled = true;
    try {
      const item = provider();
      const result = await bridge("get_postprocess_models", {
        providerId: item.id,
        apiKey: $("llmApiKey").value.trim(),
        baseUrl: $("llmBaseUrl").value.trim(),
        model: $("llmModel").value.trim(),
      });
      if (!result.ok) {
        const field = result.field === "postprocessApiKey"
          ? "llmApiKey"
          : (result.field === "postprocessBaseUrl" ? "llmBaseUrl" : (result.field === "postprocessModel" ? "llmModel" : ""));
        if (field) setFieldError(field, result.detail || result.error || t("failed"));
        setSettingsSaveStatus(result.detail || result.error || t("failed"), "error", 0);
        return;
      }
      const models = Array.isArray(result.models)
        ? result.models.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
      if (!models.length) {
        item.availableModels = [];
        renderModelChoices([]);
        setSettingsSaveStatus(t("llm_models_empty"), "error", 0);
        return;
      }
      item.availableModels = models;
      renderModelChoices(models);
      setSettingsSaveStatus(t("llm_models_loaded").replace("{count}", String(models.length)), "success", 4200);
    } catch (error) {
      setSettingsSaveStatus(String(error?.message || error || t("failed")), "error", 0);
    } finally {
      $("testLlmConnection").disabled = busy;
      $("getLlmModels").disabled = busy;
    }
  }

  async function runLlm() {
    const paths = resolveInputPaths();
    if (!paths) return;
    const item = provider();
    const operation = $("postprocessOperation").value;
    const customPrompt = $("postprocessPrompt").value.trim();
    setFieldError("postprocessPrompt", "");
    if (operation === "custom" && !customPrompt) {
      const message = t("toolbox_custom_prompt_required");
      setFieldError("postprocessPrompt", message);
      setResult(message, "error");
      return;
    }
    beginStreamOutput();
    setBusy(true, "toolbox_status_starting");
    try {
      const result = await bridge("run_llm_postprocess", {
        ...paths,
        operation,
        taskPrompt: taskPromptText(operation),
        customPrompt,
        providerId: item.id,
        reasoningMode: $("llmReasoningMode").value,
      });
      if (result.ok) applySubtitleResult(result, { kind: "llm", operation });
      else {
        const message = result.code === "custom_prompt_required"
          ? t("toolbox_custom_prompt_required")
          : (result.error || result.detail || t("failed"));
        if (result.field === "postprocessPrompt") setFieldError("postprocessPrompt", message);
        setResult(message, "error");
      }
    } finally {
      setBusy(false);
    }
  }

  async function runReplacement() {
    const paths = resolveInputPaths();
    if (!paths) return;
    const replacements = parseReplacements();
    if (!replacements.length) {
      setFieldError("postprocessReplacements", t("toolbox_need_rules"));
      setResult(t("toolbox_need_rules"), "error");
      return;
    }
    setFieldError("postprocessReplacements", "");
    setBusy(true, "toolbox_status_starting");
    try {
      const result = await bridge("run_fixed_replacement", { ...paths, replacements });
      if (result.ok) applySubtitleResult(result, { kind: "replace" });
      else setResult(result.error || result.detail || t("failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function runFfconcat() {
    const mediaPath = $("mediaPath").value.trim();
    const ffconcatPath = $("postprocessFfconcatPath").value.trim();
    if (!mediaPath) {
      setResult(t("toolbox_need_media"), "error");
      return;
    }
    if (extension(ffconcatPath) !== ".ffconcat") {
      setFieldError("postprocessFfconcat", t("toolbox_need_ffconcat"));
      setResult(t("toolbox_need_ffconcat"), "error");
      return;
    }
    setFieldError("postprocessFfconcat", "");
    setBusy(true, "toolbox_status_starting");
    try {
      const result = await bridge("run_ffconcat_rebuild", { mediaPath, ffconcatPath });
      if (result.ok) {
        $("mediaPath").value = result.mediaPath;
        $("mediaPath").dispatchEvent(new Event("input", { bubbles: true }));
        syncPaths();
        setResult(`${t("toolbox_media_done")}\n${result.mediaPath}`, "success");
      } else setResult(result.error || result.detail || t("failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  function initialize() {
    const config = window.MAWLauncher.config;
    if (!config?.postprocessProviders?.length) return;
    const selectedProvider = config.postprocessProviders.find((item) => item.selected)?.id || config.postprocessProviders[0].id;
    [$("postprocessProvider"), $("llmProvider")].forEach((select) => {
      config.postprocessProviders.forEach((item) => select.add(new Option(providerLabel(item), item.id)));
      select.value = selectedProvider;
    });
    syncProviderOptionLabels();
    renderProvider();
    renderTaskPrompt();
    renderOcrRegion();
    renderOcrModel();
    selectTool("match");
    syncPaths();
  }

  $("toolboxFab").addEventListener("click", () => setOpen($("toolboxDrawer").classList.contains("hidden")));
  $("toolboxClose").addEventListener("click", () => setOpen(false));
  document.querySelectorAll(".toolbox-tab").forEach((tab) => tab.addEventListener("click", () => selectTool(tab.dataset.tool)));
  $("postprocessProvider").addEventListener("change", () => renderProvider());
  $("postprocessOperation").addEventListener("change", () => { renderTaskPrompt(); setFieldError("postprocessPrompt", ""); });
  $("llmProvider").addEventListener("change", () => { $("postprocessProvider").value = $("llmProvider").value; renderProvider(); });
  $("saveLlmSettings").addEventListener("click", saveSettings);
  $("testLlmConnection").addEventListener("click", testConnection);
  $("getLlmModels").addEventListener("click", getModels);
  $("llmModelChoicesToggle").addEventListener("mousedown", (event) => event.preventDefault());
  $("llmModelChoicesToggle").addEventListener("click", () => setModelChoicesOpen(!modelChoicesOpen));
  $("runScriptMatch").addEventListener("click", runScriptMatch);
  $("runOcrDedup").addEventListener("click", runOcrDedup);
  $("ocrModel").addEventListener("change", renderOcrModel);
  $("openOcrSettings").addEventListener("click", () => window.MAWLauncher.openSettings("ocrSettingsSection"));
  $("runLlmPostprocess").addEventListener("click", runLlm);
  $("runFixedReplacement").addEventListener("click", runReplacement);
  $("runFfconcatRebuild").addEventListener("click", runFfconcat);
  $("pickPostprocessFfconcat").addEventListener("click", async () => {
    const result = await bridge("choose_file", { kind: "ffconcat" });
    if (result.ok) $("postprocessFfconcatPath").value = result.path;
  });
  $("pickPostprocessScript").addEventListener("click", async () => {
    const result = await bridge("choose_file", { kind: "script" });
    if (result.ok) {
      $("postprocessScriptPath").value = result.path;
      setFieldError("postprocessScriptPath", "");
    }
  });
  $("pickToolboxInput").addEventListener("click", async () => {
    const result = await bridge("choose_file", { kind: "subtitle" });
    if (result.ok) {
      inputManual = true;
      $("toolboxInputPath").value = result.path;
      setFieldError("toolboxInputPath", "");
      syncOcrVideo();
      syncInputName();
    }
  });
  $("pickOcrVideo").addEventListener("click", async () => {
    const result = await bridge("choose_file", { kind: "video" });
    if (result.ok) {
      if (!VIDEO_EXTS.has(extension(result.path))) {
        setFieldError("ocrVideoPath", t("toolbox_ocr_video_reject"));
        return;
      }
      ocrVideoManual = true;
      $("ocrVideoPath").value = result.path;
      setFieldError("ocrVideoPath", "");
    }
  });
  $("toolboxInputPath").addEventListener("input", () => {
    clearChainSelection();
    inputManual = Boolean($("toolboxInputPath").value.trim());
    setFieldError("toolboxInputPath", "");
    syncOcrVideo();
    syncInputName();
  });
  $("ocrVideoPath").addEventListener("input", () => {
    ocrVideoManual = Boolean($("ocrVideoPath").value.trim());
    setFieldError("ocrVideoPath", "");
  });
  $("ocrRegionMode").addEventListener("change", renderOcrRegion);
  $("ocrThreshold").addEventListener("input", () => setFieldError("ocrThreshold", ""));
  $("toolboxIssuesLink").addEventListener("click", (event) => {
    event.preventDefault();
    bridge("open_url", { url: "https://github.com/Moyf/moys-asr-workflow/issues" });
  });
  $("openLlmSettings").addEventListener("click", () => window.MAWLauncher.openSettings("llmSettingsSection"));
  $("postprocessScriptPath").addEventListener("input", () => setFieldError("postprocessScriptPath", ""));
  $("postprocessPrompt").addEventListener("input", () => setFieldError("postprocessPrompt", ""));
  $("llmCustomDisplayName").addEventListener("input", () => {
    updateCustomDisplayName($("llmCustomDisplayName").value);
    setFieldError("llmCustomDisplayName", "");
  });
  $("llmModel").addEventListener("focus", () => setModelChoicesOpen(true));
  $("llmModel").addEventListener("input", () => {
    setFieldError("llmModel", "");
    if (modelChoices.length) setModelChoicesOpen(true, $("llmModel").value);
  });
  document.addEventListener("click", (event) => {
    if (!event.target?.closest?.(".llm-model-picker")) setModelChoicesOpen(false);
  });
  ["llmApiKey", "llmBaseUrl", "llmModel", "llmReasoningMode"].forEach((id) => {
    $(id).addEventListener("input", () => setFieldError(id, ""));
    $(id).addEventListener("change", () => setFieldError(id, ""));
  });
  $("postprocessReplacements").addEventListener("input", () => setFieldError("postprocessReplacements", ""));
  ["jsonPath", "srtPath", "mediaPath"].forEach((id) => $(id).addEventListener("input", syncPaths));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || busy) return;
    if (modelChoicesOpen) {
      setModelChoicesOpen(false);
      return;
    }
    setOpen(false);
  });
  setupToolboxResize();
  window.addEventListener("mawlauncherready", initialize, { once: true });
  window.MAWLauncher.onPostprocessStatus = renderPostprocessStatus;
  window.MAWLauncher.onPostprocessStream = renderPostprocessStream;
  window.MAWLauncher.onOcrRuntimeChanged = renderOcrModel;
  if (window.MAWLauncher.config) initialize();
})();

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const panels = { waveform: "toolboxWaveformPanel", match: "toolboxMatchPanel", ocr: "toolboxOcrPanel", llm: "toolboxLlmPanel", replace: "toolboxReplacePanel", ffconcat: "toolboxFfconcatPanel" };
  const TASK_PROMPT_KEYS = { proofread: "toolbox_task_proofread", resegment: "toolbox_task_resegment", translate_en: "toolbox_task_translate_en", translate_zh: "toolbox_task_translate_zh" };
  const SUBTITLE_EXTS = new Set([".mosp", ".json", ".srt"]);
  const VIDEO_EXTS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"]);
  const SCRIPT_EXTS = new Set([".txt", ".md", ".markdown"]);
  const TOOLBOX_SIZE_KEY = "maw.launcher.toolbox.size";
  const LLM_PROMPTS_KEY = "maw.launcher.llm.prompts";
  const TOOLBOX_MIN_WIDTH = 360;
  const TOOLBOX_MIN_HEIGHT = 320;
  const TOOLBOX_MAX_HEIGHT = 680;
  const CUSTOM_DEFAULT_LABEL = "Custom (OpenAI-compatible)";
  const AUTO_STEP_ORDER = ["match", "replace", "proofread", "resegment", "ocr", "translate"];
  const AUTO_STEP_CHECKBOXES = {
    match: "autoStepMatch",
    replace: "autoStepReplace",
    proofread: "autoStepProofread",
    resegment: "autoStepResegment",
    ocr: "autoStepOcr",
    translate: "autoStepTranslate",
  };
  const AUTO_STEP_TOOLS = { match: "match", replace: "replace", proofread: "llm", resegment: "llm", ocr: "ocr", translate: "llm" };
  const AUTO_LLM_OPERATIONS = { proofread: "proofread", resegment: "resegment" };
  let autoPlanSaveTimer = 0;
  let pendingAutoStep = "";
  let toolboxOpenMode = "manual";
  let busy = false;
  let inputManual = false;
  let utilityMediaManual = false;
  let activeToolboxSection = "postprocess";
  let ocrVideoManual = false;
  let saveStatusTimer = 0;
  let modelChoices = [];
  let modelChoicesOpen = false;
  let llmPrompts = {};
  let activeLlmOperation = "";
  let artifactMenuTarget = null;
  let batchMode = false;

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

  function loadLlmPrompts() {
    try {
      const raw = window.localStorage?.getItem(LLM_PROMPTS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function saveLlmPrompts() {
    try {
      window.localStorage?.setItem(LLM_PROMPTS_KEY, JSON.stringify(llmPrompts));
    } catch (error) {
      // 某些嵌入式浏览器会禁用 localStorage；内存中的提示词仍可在本次运行中使用。
    }
  }

  function getLlmPrompt(operation = $("postprocessOperation").value) {
    return String(llmPrompts[operation] || "");
  }

  function persistLlmPrompt(operation = activeLlmOperation || $("postprocessOperation").value) {
    const field = $("postprocessPrompt");
    if (!operation || !field) return;
    llmPrompts[operation] = field.value;
    saveLlmPrompts();
  }

  function loadLlmPrompt(operation = $("postprocessOperation").value) {
    $("postprocessPrompt").value = getLlmPrompt(operation);
  }

  function switchLlmOperation(operation = $("postprocessOperation").value) {
    const next = String(operation || "");
    if (!next) return;
    persistLlmPrompt(activeLlmOperation || $("postprocessOperation").value);
    $("postprocessOperation").value = next;
    activeLlmOperation = next;
    loadLlmPrompt(next);
    renderTaskPrompt(next);
    setFieldError("postprocessPrompt", "");
    renderAutoPostprocessState();
    persistAutoPlanSoon();
  }

  function initializeLlmPrompts() {
    llmPrompts = loadLlmPrompts();
    activeLlmOperation = $("postprocessOperation").value;
    loadLlmPrompt(activeLlmOperation);
  }

  function bridge(method, payload = {}) {
    return window.MAWLauncher.callBackend(method, payload);
  }

  function extension(path) {
    return (String(path || "").match(/\.[^.\\/]+$/u)?.[0] || "").toLowerCase();
  }

  function punctuationLines(id) {
    return String($(id)?.value || "").split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  }

  function validateMatchPunctuation() {
    const split = new Set(punctuationLines("postprocessExtraSplitPunctuation"));
    const missing = punctuationLines("postprocessPreservePunctuation").filter((value) => !split.has(value));
    const message = missing.length ? `${t("toolbox_preserve_punctuation_invalid")} ${missing.join("、")}` : "";
    setFieldError("postprocessPreservePunctuation", message);
    return !message;
  }

  async function refreshScriptPreview() {
    const path = $("postprocessScriptPath").value.trim();
    const preview = $("postprocessScriptPreview");
    if (!path || !SCRIPT_EXTS.has(extension(path))) {
      preview.classList.add("hidden");
      $("postprocessScriptPreviewText").textContent = "";
      return;
    }
    const result = await bridge("read_script_preview", { path });
    if (!result.ok) {
      preview.classList.add("hidden");
      return;
    }
    $("postprocessScriptPreviewText").textContent = `${result.preview}${result.truncated ? "\n…" : ""}`;
    preview.classList.remove("hidden");
  }

  function defaultAutoPlan() {
    return {
      version: 1,
      enabled: false,
      retainIntermediate: false,
      steps: [
        { id: "match", enabled: false, scriptPath: "" },
        { id: "replace", enabled: false, replacements: [], conversion: "off" },
        { id: "proofread", enabled: false, providerId: "deepseek", customPrompt: "" },
        { id: "resegment", enabled: false, providerId: "deepseek", customPrompt: "" },
        { id: "ocr", enabled: false, videoPath: "", regionMode: "full", regionX1: 0, regionY1: 0, regionX2: 100, regionY2: 100, threshold: 0.5, report: false },
        { id: "translate", enabled: false, providerId: "deepseek", target: "zh", customPrompt: "" },
      ],
    };
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

  function syncUtilityMediaName() {
    const path = $("toolboxUtilityMediaPath").value.trim();
    const name = $("toolboxUtilityMediaName");
    const hasPath = Boolean(path);
    name.textContent = hasPath ? fileName(path) : t("toolbox_input_empty");
    name.title = path;
    name.classList.toggle("empty", !hasPath);
  }

  function syncPaths() {
    if (!inputManual) $("toolboxInputPath").value = autoSourcePath();
    if (!utilityMediaManual) $("toolboxUtilityMediaPath").value = $("mediaPath").value.trim();
    syncOcrVideo();
    syncInputName();
    syncUtilityMediaName();
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
    const wasOpen = !$("toolboxDrawer").classList.contains("hidden");
    $("toolboxDrawer").classList.toggle("hidden", !open);
    $("toolboxFab").setAttribute("aria-expanded", String(open));
    if (!open) toolboxOpenMode = "manual";
    syncPaths();
    if (open) {
      const activeTab = activeToolboxView().querySelector(".toolbox-tab.active")
        || activeToolboxView().querySelector(".toolbox-tab");
      if (activeTab) selectTool(activeTab.dataset.tool);
    }
    if (open) $("toolboxClose").focus();
    if (!open && wasOpen) $("toolboxFab").focus();
  }

  function setTestConnectionAttention(attention) {
    $("testLlmConnection")?.classList.toggle("attention", Boolean(attention));
  }

  function toolboxSectionForTool(tool) {
    return ["waveform", "ffconcat"].includes(tool) ? "utilities" : "postprocess";
  }

  function activeToolboxView() {
    return activeToolboxSection === "postprocess" ? $("toolboxPostprocessView") : $("toolboxUtilitiesView");
  }

  function selectToolboxSection(section) {
    activeToolboxSection = section;
    document.querySelectorAll("[data-toolbox-section]").forEach((tab) => {
      const active = tab.dataset.toolboxSection === section;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    $("toolboxPostprocessView").classList.toggle("hidden", section !== "postprocess");
    $("toolboxUtilitiesView").classList.toggle("hidden", section !== "utilities");
    const activeTab = activeToolboxView().querySelector(".toolbox-tab.active") || activeToolboxView().querySelector(".toolbox-tab");
    if (activeTab) selectTool(activeTab.dataset.tool);
  }

  function selectTool(tool) {
    const section = toolboxSectionForTool(tool);
    if (section !== activeToolboxSection) selectToolboxSection(section);
    document.querySelectorAll(".toolbox-tab").forEach((tab) => {
      const active = tab.dataset.tool === tool;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    Object.entries(panels).forEach(([name, id]) => $(id).classList.toggle("hidden", name !== tool));
    document.querySelectorAll("[data-tool-action]").forEach((action) => {
      action.classList.toggle("hidden", action.dataset.toolAction !== tool || toolboxOpenMode === "auto-config");
    });
    $("toolboxInputDropZone").classList.toggle("hidden", section !== "postprocess");
    $("toolboxChain").classList.toggle("hidden", section !== "postprocess" || !$("toolboxChainList").children.length);
    const configOnly = toolboxOpenMode === "auto-config";
    $("toolboxOutputField").classList.toggle("hidden", section !== "postprocess" || configOnly);
    $("toolboxConfigOnlyHint")?.classList.toggle("hidden", !configOnly);
  }

  function moveToolFocus(event) {
    const tools = [...event.currentTarget.closest('[role="tablist"]').querySelectorAll(".toolbox-tab:not(.hidden)")];
    const currentIndex = tools.indexOf(event.currentTarget);
    if (currentIndex < 0) return;
    const offset = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const target = event.key === "Home"
      ? tools[0]
      : event.key === "End"
        ? tools.at(-1)
        : tools[(currentIndex + offset + tools.length) % tools.length];
    if (!target) return;
    event.preventDefault();
    selectTool(target.dataset.tool);
    target.focus();
  }

  function clampToolboxSize(width, height) {
    const viewportWidth = window.MAWLauncher.viewportPixelsToPage(window.innerWidth);
    const viewportHeight = window.MAWLauncher.viewportPixelsToPage(window.innerHeight);
    const maxWidth = Math.max(TOOLBOX_MIN_WIDTH, viewportWidth - 40);
    const maxHeight = Math.max(TOOLBOX_MIN_HEIGHT, Math.min(TOOLBOX_MAX_HEIGHT, viewportHeight - 156));
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
      const drawer = $("toolboxDrawer");
      const style = getComputedStyle(drawer);
      const start = {
        x: event.clientX,
        y: event.clientY,
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
      };
      let size = { width: start.width, height: start.height };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
      const onMove = (moveEvent) => {
        size = axis === "y"
          ? applyToolboxSize(start.width, start.height + window.MAWLauncher.viewportPixelsToPage(start.y - moveEvent.clientY))
          : applyToolboxSize(start.width + window.MAWLauncher.viewportPixelsToPage(start.x - moveEvent.clientX), start.height);
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
      const style = getComputedStyle($("toolboxDrawer"));
      const width = Number.parseFloat(style.width);
      const height = Number.parseFloat(style.height);
      const size = axis === "y"
        ? applyToolboxSize(width, height + (grow ? step : -step))
        : applyToolboxSize(width + (grow ? step : -step), height);
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
    result.classList.remove("hidden");
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
    ["generateWaveform", "runWaveform", "toolboxGenerateSpectral", "runScriptMatch", "runOcrDedup", "runLlmPostprocess", "runFixedProcess", "runFfconcatRebuild", "saveLlmSettings", "testLlmConnection", "getLlmModels", "toolboxInputPath", "pickToolboxInput", "toolboxUtilityMediaPath", "pickToolboxUtilityMedia", "postprocessProvider", "llmProvider", "llmApiKey", "llmBaseUrl", "llmModel", "llmModelChoicesToggle", "llmReasoningMode", "llmCustomDisplayName", "ocrModel", "openOcrSettings", "ocrVideoPath", "pickOcrVideo", "ocrRegionMode", "ocrRegionX1", "ocrRegionY1", "ocrRegionX2", "ocrRegionY2", "ocrThreshold", "ocrReport", "postprocessConversion"].forEach((id) => {
      $(id).disabled = busy;
    });
    renderOcrModel();
    applyBatchModeLocks();
    if (busy) setModelChoicesOpen(false);
    if (busy) setResult(t(statusKey));
  }

  async function generateWaveformProject(openEditor) {
    const mediaPath = $("toolboxUtilityMediaPath").value.trim();
    if (!mediaPath) {
      setResult(t("toolbox_need_media"), "error");
      return;
    }
    setBusy(true, "toolbox_status_starting");
    try {
      const result = await bridge("generate_waveform_project", {
        mediaPath,
        generateSpectral: $("toolboxGenerateSpectral").checked,
      });
      if (!result.ok) {
        const errorKeys = new Set(["waveform_unavailable", "waveform_generation_failed"]);
        setResult(errorKeys.has(result.code) ? t(result.code) : (result.error || result.detail || t("failed")), "error");
        return;
      }
      if (openEditor) {
        window.MAWLauncher.setJsonPath(result.projectPath);
        await window.MAWLauncher.openServerEditor();
      }
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      setResult(`${t("toolbox_done")}\n${result.projectPath}${warnings.length ? `\n${warnings.join("\n")}` : ""}`, "success");
    } finally {
      setBusy(false);
    }
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
      mediaPath: $("mediaPath").value.trim(),
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
    if (kind === "fixed" || kind === "replace") return t("toolbox_chain_replace");
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

  function artifactLabel(kind) {
    return t(kind === "project" ? "artifact_type_project" : "artifact_type_srt");
  }

  function renderArtifactButton(button) {
    const label = artifactLabel(button.dataset.artifactKind);
    const name = button.dataset.artifactName;
    const path = button.dataset.artifactPath;
    button.textContent = label;
    button.title = `${name}\n${path}`;
    button.setAttribute("aria-label", `${label}: ${name}; ${path}`);
  }

  function closeArtifactMenu({ restoreFocus = false } = {}) {
    const target = artifactMenuTarget;
    artifactMenuTarget = null;
    $("artifactContextMenu").classList.add("hidden");
    if (restoreFocus) target?.button.focus();
  }

  function openArtifactMenu(event, path, button) {
    event.preventDefault();
    event.stopPropagation();
    closeArtifactMenu();
    artifactMenuTarget = { path, button };
    const menu = $("artifactContextMenu");
    menu.classList.remove("hidden");
    menu.style.left = "0";
    menu.style.top = "0";
    const rect = menu.getBoundingClientRect();
    const inset = 8;
    const left = Math.min(Math.max(event.clientX, inset), window.innerWidth - rect.width - inset);
    const top = Math.min(Math.max(event.clientY, inset), window.innerHeight - rect.height - inset);
    menu.style.left = `${window.MAWLauncher.viewportPixelsToPage(Math.max(inset, left))}px`;
    menu.style.top = `${window.MAWLauncher.viewportPixelsToPage(Math.max(inset, top))}px`;
    menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
  }

  async function runArtifactAction(action) {
    const target = artifactMenuTarget;
    if (!target) return;
    closeArtifactMenu({ restoreFocus: true });
    if (action === "select") {
      selectChainPath(target.path, target.button);
      return;
    }
    const result = await bridge(action, { path: target.path });
    if (!result.ok) setResult(result.error || t("failed"), "error");
  }

  function addChainResult(chain, result) {
    const artifacts = [
      { kind: "project", path: result.projectPath },
      { kind: "srt", path: result.srtPath },
    ].filter((artifact, index, all) => artifact.path && all.findIndex((candidate) => candidate.path === artifact.path) === index);
    if (!artifacts.length) return;
    const container = $("toolboxChain");
    const list = $("toolboxChainList");
    const item = document.createElement("div");
    item.className = "toolbox-chain-item";
    const label = document.createElement("span");
    label.className = "toolbox-chain-label";
    label.textContent = chainLabel(chain.kind, chain.operation);
    const files = document.createElement("div");
    files.className = "toolbox-chain-files";
    const activePath = result.projectPath || result.srtPath || "";
    if (activePath) clearChainSelection();
    artifacts.forEach(({ kind, path }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toolbox-chain-file";
      button.classList.toggle("selected", path === activePath);
      button.dataset.artifactKind = kind;
      button.dataset.artifactName = fileName(path);
      button.dataset.artifactPath = path;
      renderArtifactButton(button);
      button.addEventListener("click", () => selectChainPath(path, button));
      button.addEventListener("contextmenu", (event) => openArtifactMenu(event, path, button));
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

  function replacementSeparator() {
    const mode = $("postprocessReplacementSeparator")?.value || "arrow";
    if (mode === "comma") return /[,，]/u;
    if (mode === "tab") return /\t/u;
    if (mode === "custom") {
      const value = $("postprocessReplacementCustomSeparator")?.value || "";
      return value ? value : null;
    }
    return "=>";
  }

  function syncReplacementSeparator() {
    const custom = $("postprocessReplacementSeparator").value === "custom";
    $("postprocessReplacementCustomSeparatorField").classList.toggle("hidden", !custom);
    $("postprocessReplacementCustomSeparator").disabled = !custom;
    const customSeparator = $("postprocessReplacementCustomSeparator").value || " | ";
    const examples = {
      arrow: "错别字 => 正确文字",
      comma: "错别字,正确文字",
      tab: "错别字\t正确文字",
      custom: `错别字${customSeparator}正确文字`,
    };
    $("postprocessReplacements").placeholder = examples[$("postprocessReplacementSeparator").value] || examples.arrow;
  }

  function parseReplacements() {
    const separator = replacementSeparator();
    const trim = $("postprocessReplacementTrim")?.checked !== false;
    if (!separator) return [];
    return $("postprocessReplacements").value.split(/\r?\n/u).map((line) => {
      const index = typeof separator === "string" ? line.indexOf(separator) : line.search(separator);
      const length = typeof separator === "string" ? separator.length : 1;
      if (index < 0) return null;
      const source = line.slice(0, index);
      const target = line.slice(index + length);
      return { source: trim ? source.trim() : source, target: trim ? target.trim() : target };
    }).filter((item) => item?.source);
  }

  function replacementRuleText(item) {
    const separator = $("postprocessReplacementSeparator")?.value || "arrow";
    const value = separator === "comma" ? "," : separator === "tab" ? "\t" : separator === "custom" ? ($("postprocessReplacementCustomSeparator")?.value || "") : "=>";
    return `${item.source || ""}${value}${item.target || ""}`;
  }

  function renderReplacementPreview() {
    const preview = $("postprocessReplacementPreview");
    if (!preview) return;
    const hasInput = $("postprocessReplacements").value.length > 0;
    const rules = parseReplacements();
    preview.textContent = rules.length
      ? rules.map(replacementRuleText).join("\n")
      : t(hasInput ? "toolbox_replace_preview_empty" : "toolbox_replace_preview_hint");
  }

  function autoLlmOperation(stepId) {
    if (stepId === "translate") return $("autoTranslateTarget").value === "en" ? "translate_en" : "translate_zh";
    return AUTO_LLM_OPERATIONS[stepId] || stepId;
  }

  function selectAutoLlmOperation(stepId) {
    if (!["proofread", "resegment", "translate"].includes(stepId)) return;
    switchLlmOperation(autoLlmOperation(stepId));
  }

  function truncateHint(value, maxLength = 42) {
    const text = String(value || "").replace(/\s+/gu, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  function autoStepHint(stepId) {
    if (stepId === "match") {
      if (batchMode) return t("batch_manuscript_disabled");
      const path = $("postprocessScriptPath").value.trim();
      return path ? fileName(path) : t("auto_step_hint_no_file");
    }
    if (stepId === "replace") {
      const count = parseReplacements().length;
      const rules = count ? t("auto_step_hint_rules").replace("{count}", String(count)) : t("auto_step_hint_no_rules");
      const conversion = $("postprocessConversion").value;
      return conversion === "off" ? rules : `${rules} · ${t(`toolbox_conversion_${conversion}`)}`;
    }
    if (["proofread", "resegment", "translate"].includes(stepId)) {
      const operation = autoLlmOperation(stepId);
      return truncateHint(getLlmPrompt(operation) || taskPromptText(operation)) || t("toolbox_task_none");
    }
    if (stepId === "ocr") {
      const video = $("ocrVideoPath").value.trim() || autoOcrVideoPath();
      return video ? fileName(video) : t("auto_step_hint_no_video");
    }
    return "";
  }

  function autoPlanFromControls() {
    const providerId = $("postprocessProvider").value || "deepseek";
    const ocr = ocrRegionPayload();
    return {
      version: 1,
      enabled: Boolean($("autoPostprocessEnabled")?.checked),
      retainIntermediate: Boolean($("autoPostprocessRetain")?.checked),
      steps: [
        // 始终上报用户的单文件勾选；批量运行由后端统一跳过文稿匹配，前端不改写、不持久化批量态。
        { id: "match", enabled: Boolean($("autoStepMatch")?.checked), scriptPath: $("postprocessScriptPath").value.trim(), extraSplitPunctuation: punctuationLines("postprocessExtraSplitPunctuation"), preservePunctuation: punctuationLines("postprocessPreservePunctuation") },
        { id: "replace", enabled: Boolean($("autoStepReplace")?.checked), replacements: parseReplacements(), replacementSeparator: $("postprocessReplacementSeparator").value, replacementTrim: $("postprocessReplacementTrim").checked, replacementCustomSeparator: $("postprocessReplacementCustomSeparator").value, conversion: $("postprocessConversion").value },
        { id: "proofread", enabled: Boolean($("autoStepProofread")?.checked), providerId, customPrompt: getLlmPrompt("proofread") },
        { id: "resegment", enabled: Boolean($("autoStepResegment")?.checked), providerId, customPrompt: getLlmPrompt("resegment") },
        { id: "ocr", enabled: Boolean($("autoStepOcr")?.checked), videoPath: $("ocrVideoPath").value.trim(), ...ocr, threshold: Number($("ocrThreshold").value), report: Boolean($("ocrReport").checked) },
        { id: "translate", enabled: Boolean($("autoStepTranslate")?.checked), providerId, target: $("autoTranslateTarget").value || "zh", customPrompt: getLlmPrompt(autoLlmOperation("translate")) },
      ],
    };
  }

  function autoLlmReady(providerId) {
    const item = provider(providerId);
    return Boolean(item?.verified && item?.hasApiKey !== false && item?.hasBaseUrl !== false && item?.hasModel !== false);
  }

  function autoStepReady(stepId) {
    if (stepId === "match") {
      const path = $("postprocessScriptPath").value.trim();
      return Boolean(path && SCRIPT_EXTS.has(extension(path)));
    }
    if (stepId === "replace") return parseReplacements().length > 0 || $("postprocessConversion").value !== "off";
    if (["proofread", "resegment", "translate"].includes(stepId)) return autoLlmReady($("postprocessProvider").value);
    if (stepId === "ocr") {
      const config = window.MAWLauncher.config || {};
      const ocrModel = (Array.isArray(config.ocrModels) ? config.ocrModels : [])
        .find((item) => item.id === $("ocrModel").value);
      if (!config.ocrRuntime?.ready || !ocrModel?.installed) return false;
      const threshold = Number($("ocrThreshold").value);
      const video = $("ocrVideoPath").value.trim() || autoOcrVideoPath();
      if (!video || !VIDEO_EXTS.has(extension(video)) || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) return false;
      if ($("ocrRegionMode").value === "custom_region") {
        const x1 = Number($("ocrRegionX1").value); const y1 = Number($("ocrRegionY1").value);
        const x2 = Number($("ocrRegionX2").value); const y2 = Number($("ocrRegionY2").value);
        if (![x1, y1, x2, y2].every((value) => Number.isFinite(value) && value >= 0 && value <= 100) || x2 <= x1 || y2 <= y1) return false;
      }
      return true;
    }
    return false;
  }

  function autoStepLabel(stepId) {
    return t({ match: "auto_step_match", replace: "auto_step_replace", proofread: "auto_step_proofread", resegment: "auto_step_resegment", ocr: "auto_step_ocr", translate: "auto_step_translate" }[stepId] || stepId);
  }

  function renderAutoPostprocessState() {
    const selected = [];
    const invalid = [];
    AUTO_STEP_ORDER.forEach((stepId) => {
      const checkbox = $(AUTO_STEP_CHECKBOXES[stepId]);
      const status = $(`autoStep${stepId[0].toUpperCase()}${stepId.slice(1)}Status`);
      const row = document.querySelector(`[data-auto-step-row="${stepId}"]`);
      const enabled = Boolean(checkbox?.checked);
      const available = stepId !== "match" || !batchMode;
      if (stepId === "match" && batchMode && checkbox) {
        checkbox.disabled = true;
      } else if (stepId === "match" && checkbox) {
        checkbox.disabled = false;
      }
      const ready = autoStepReady(stepId);
      if (enabled && available) selected.push(stepId);
      if (enabled && available && !ready) invalid.push(stepId);
      if (status) {
        status.textContent = available && enabled ? t(ready ? "auto_status_ready" : "auto_status_config") : t("auto_status_disabled");
        status.classList.toggle("ready", available && enabled && ready);
        status.classList.toggle("invalid", available && enabled && !ready);
      }
      const hint = $(`autoStep${stepId[0].toUpperCase()}${stepId.slice(1)}Hint`);
      if (hint) {
        hint.textContent = autoStepHint(stepId);
        hint.title = hint.textContent;
      }
      row?.classList.toggle("needs-config", available && enabled && !ready);
      row?.classList.toggle("batch-unavailable", !available);
    });
    const enabled = Boolean($("autoPostprocessEnabled")?.checked);
    $("autoPostprocessOptions")?.classList.toggle("hidden", !enabled);
    $("autoTranslateTargetField")?.classList.toggle("hidden", !$("autoStepTranslate")?.checked);
    const summary = $("autoPostprocessSummary");
    if (!summary) return;
    if (!enabled) {
      summary.textContent = t("auto_summary_disabled");
    } else if (!selected.length) {
      summary.textContent = t("auto_summary_empty");
    } else if (invalid.length) {
      summary.textContent = t("auto_summary_invalid").replace("{steps}", invalid.map(autoStepLabel).join(stateLangSeparator()));
    } else {
      summary.textContent = t("auto_summary_steps").replace("{count}", String(selected.length)).replace("{steps}", selected.map(autoStepLabel).join(stateLangSeparator()));
    }
  }

  function stateLangSeparator() {
    return window.MAWLauncher?.translate("auto_postprocess_title")?.includes("Post-") ? ", " : "、";
  }

  function persistAutoPlanSoon() {
    window.clearTimeout(autoPlanSaveTimer);
    autoPlanSaveTimer = window.setTimeout(async () => {
      const result = await bridge("save_postprocess_plan", { plan: autoPlanFromControls() });
      if (result.ok && window.MAWLauncher.config) window.MAWLauncher.config.postprocessAutoPlan = result.plan;
    }, 180);
  }

  function focusAutoField(fieldId) {
    requestAnimationFrame(() => {
      const field = $(fieldId);
      field?.scrollIntoView({ behavior: "smooth", block: "center" });
      field?.focus();
    });
  }

  function setAutoStepsExpanded(expanded) {
    const card = $("autoPostprocessStepsCard");
    const toggle = $("autoPostprocessStepsToggle");
    if (!card || !toggle) return;
    card.classList.toggle("collapsed", !expanded);
    toggle.setAttribute("aria-expanded", String(Boolean(expanded)));
    const chevron = toggle.querySelector(".chevron");
    if (chevron) chevron.textContent = expanded ? "▾" : "▸";
  }

  function autoStepFocusField(stepId) {
    if (stepId === "match") return "postprocessScriptPath";
    if (stepId === "replace") return parseReplacements().length ? "postprocessConversion" : "postprocessReplacements";
    if (["proofread", "resegment", "translate"].includes(stepId)) return "postprocessPrompt";
    if (stepId !== "ocr") return "";
    const video = $("ocrVideoPath").value.trim() || autoOcrVideoPath();
    if (!video || !VIDEO_EXTS.has(extension(video))) return "ocrVideoPath";
    if ($("ocrRegionMode").value === "custom_region") {
      const x1 = Number($("ocrRegionX1").value); const y1 = Number($("ocrRegionY1").value);
      const x2 = Number($("ocrRegionX2").value); const y2 = Number($("ocrRegionY2").value);
      if (!Number.isFinite(x1) || x1 < 0 || x1 > 100) return "ocrRegionX1";
      if (!Number.isFinite(y1) || y1 < 0 || y1 > 100) return "ocrRegionY1";
      if (!Number.isFinite(x2) || x2 < 0 || x2 > 100 || x2 <= x1) return "ocrRegionX2";
      if (!Number.isFinite(y2) || y2 < 0 || y2 > 100 || y2 <= y1) return "ocrRegionY2";
    }
    return "ocrThreshold";
  }

  function openAutoStep(stepId, invalidField = "", { highlightConnection = false } = {}) {
    pendingAutoStep = stepId;
    const llmStep = ["proofread", "resegment", "translate"].includes(stepId);
    if (llmStep && !autoLlmReady($("postprocessProvider").value)) {
      const item = provider();
      const focusId = ["llmApiKey", "llmBaseUrl", "llmModel"].includes(invalidField)
        ? invalidField
        : (item?.hasApiKey === false ? "llmApiKey" : (item?.hasBaseUrl === false ? "llmBaseUrl" : "llmModel"));
      if (highlightConnection) setTestConnectionAttention(true);
      window.MAWLauncher.openSettings("llmSettingsSection", focusId);
      return;
    }
    toolboxOpenMode = "auto-config";
    setOpen(true);
    selectTool(AUTO_STEP_TOOLS[stepId] || "match");
    setAutoStepsExpanded(true);
    selectAutoLlmOperation(stepId);
    const fieldId = invalidField || autoStepFocusField(stepId);
    focusAutoField(fieldId);
  }

  function maybeEnablePendingAutoStep() {
    const stepId = pendingAutoStep;
    if (!stepId || !autoStepReady(stepId)) return false;
    const checkbox = $(AUTO_STEP_CHECKBOXES[stepId]);
    if (!checkbox) return false;
    checkbox.checked = true;
    pendingAutoStep = "";
    renderAutoPostprocessState();
    persistAutoPlanSoon();
    return true;
  }

  function applyAutoPostprocessPlan(rawPlan) {
    const plan = rawPlan && typeof rawPlan === "object" ? rawPlan : defaultAutoPlan();
    $("autoPostprocessEnabled").checked = Boolean(plan.enabled);
    $("autoPostprocessRetain").checked = Boolean(plan.retainIntermediate);
    const byId = new Map(Array.isArray(plan.steps) ? plan.steps.map((step) => [step.id, step]) : []);
    AUTO_STEP_ORDER.forEach((stepId) => { $(AUTO_STEP_CHECKBOXES[stepId]).checked = Boolean(byId.get(stepId)?.enabled); });
    const match = byId.get("match") || {};
    $("postprocessScriptPath").value = String(match.scriptPath || "");
    $("postprocessExtraSplitPunctuation").value = Array.isArray(match.extraSplitPunctuation) ? match.extraSplitPunctuation.join("\n") : "";
    $("postprocessPreservePunctuation").value = Array.isArray(match.preservePunctuation) ? match.preservePunctuation.join("\n") : "";
    validateMatchPunctuation();
    void refreshScriptPreview();
    const replace = byId.get("replace") || {};
    $("postprocessReplacementSeparator").value = ["arrow", "comma", "tab", "custom"].includes(replace.replacementSeparator) ? replace.replacementSeparator : "arrow";
    $("postprocessReplacementTrim").checked = replace.replacementTrim !== false;
    $("postprocessReplacementCustomSeparator").value = String(replace.replacementCustomSeparator || "");
    $("postprocessReplacements").value = (Array.isArray(replace.replacements) ? replace.replacements : []).map(replacementRuleText).join("\n");
    syncReplacementSeparator();
    renderReplacementPreview();
    $("postprocessConversion").value = ["to_simplified", "to_traditional", "to_traditional_tw", "to_traditional_twp", "to_traditional_hk"].includes(replace.conversion) ? replace.conversion : "off";
    ["proofread", "resegment"].forEach((stepId) => {
      const prompt = byId.get(stepId)?.customPrompt;
      if (typeof prompt === "string" && prompt) llmPrompts[autoLlmOperation(stepId)] = prompt;
    });
    const ocr = byId.get("ocr") || {};
    $("ocrVideoPath").value = String(ocr.videoPath || "");
    ocrVideoManual = Boolean($("ocrVideoPath").value.trim());
    $("ocrRegionMode").value = ocr.regionMode === "custom" ? "custom_region" : String(ocr.regionMode || "full");
    $("ocrRegionX1").value = String(ocr.regionX1 ?? 0);
    $("ocrRegionY1").value = String(ocr.regionY1 ?? 0);
    $("ocrRegionX2").value = String(ocr.regionX2 ?? 100);
    $("ocrRegionY2").value = String(ocr.regionY2 ?? 100);
    $("ocrThreshold").value = String(ocr.threshold ?? 0.5);
    $("ocrReport").checked = Boolean(ocr.report);
    $("autoTranslateTarget").value = String((byId.get("translate") || {}).target || "zh");
    const translatePrompt = byId.get("translate")?.customPrompt;
    if (typeof translatePrompt === "string" && translatePrompt) llmPrompts[autoLlmOperation("translate")] = translatePrompt;
    saveLlmPrompts();
    loadLlmPrompt(activeLlmOperation || $("postprocessOperation").value);
    renderOcrRegion();
    if (plan.enabled && !AUTO_STEP_ORDER.some((stepId) => $(AUTO_STEP_CHECKBOXES[stepId]).checked)) setAutoStepsExpanded(true);
    renderAutoPostprocessState();
  }

  function initializeAutoPostprocess() {
    const plan = window.MAWLauncher.config?.postprocessAutoPlan || defaultAutoPlan();
    applyAutoPostprocessPlan(plan);
    const providerId = (plan.steps || []).find((step) => step.enabled && step.providerId)?.providerId;
    if (providerId && provider(providerId)) {
      $("postprocessProvider").value = providerId;
      renderProvider(providerId);
    }
    renderAutoPostprocessState();
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
    if (!validateMatchPunctuation()) {
      setResult(t("toolbox_preserve_punctuation_invalid"), "error");
      return;
    }
    setFieldError("postprocessScriptPath", "");
    setBusy(true, "toolbox_status_starting");
    try {
      const result = await bridge("run_script_match", {
        ...paths,
        scriptPath,
        extraSplitPunctuation: punctuationLines("postprocessExtraSplitPunctuation"),
        preservePunctuation: punctuationLines("postprocessPreservePunctuation"),
      });
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

  async function saveSettings({ autoTest = false } = {}) {
    setSettingsSaveStatus("");
    const item = provider();
    const enteredApiKey = $("llmApiKey").value.trim();
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
      return result;
    }
    ["llmApiKey", "llmBaseUrl", "llmModel", "llmReasoningMode", "llmCustomDisplayName"].forEach((field) => setFieldError(field, ""));
    item.baseUrl = $("llmBaseUrl").value.trim();
    item.model = $("llmModel").value.trim();
    item.hasApiKey = Boolean(result.maskedApiKey || item.maskedApiKey || $("llmApiKey").value.trim());
    item.hasBaseUrl = Boolean(item.baseUrl);
    item.hasModel = Boolean(item.model);
    item.reasoningMode = result.reasoningMode || $("llmReasoningMode").value || "off";
    item.displayName = item.id === "custom" ? $("llmCustomDisplayName").value.trim() : "";
    item.label = result.label || providerLabel(item);
    item.maskedApiKey = result.maskedApiKey || item.maskedApiKey;
    item.verified = Boolean(result.verified);
    syncProviderOptionLabels();
    renderProvider(item.id);
    renderAutoPostprocessState();
    if (autoTest && enteredApiKey) {
      await testConnection({ alreadySaved: true });
    } else {
      setSettingsSaveStatus(t("toolbox_saved"), "success");
    }
    return result;
  }

  async function testConnection({ alreadySaved = false } = {}) {
    setSettingsSaveStatus(t("llm_connection_testing"), "", 0);
    $("testLlmConnection").disabled = true;
    $("getLlmModels").disabled = true;
    try {
      if (!alreadySaved) {
        const saved = await saveSettings({ autoTest: false });
        if (!saved?.ok) return saved;
      }
      const item = provider();
      const result = await bridge("test_postprocess_connection", {
        providerId: item.id,
        apiKey: $("llmApiKey").value.trim(),
        baseUrl: $("llmBaseUrl").value.trim(),
        model: $("llmModel").value.trim(),
        reasoningMode: $("llmReasoningMode").value,
      });
      if (result.ok) {
        item.verified = Boolean(result.verified);
        setSettingsSaveStatus(t("llm_connection_success"), "success");
        renderAutoPostprocessState();
        maybeEnablePendingAutoStep();
      }
      else setSettingsSaveStatus(result.detail || result.error || t("failed"), "error", 0);
      return result;
    } catch (error) {
      setSettingsSaveStatus(String(error?.message || error || t("failed")), "error", 0);
    } finally {
      setTestConnectionAttention(false);
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

  async function runFixedProcess() {
    const paths = resolveInputPaths();
    if (!paths) return;
    const replacements = parseReplacements();
    const conversion = $("postprocessConversion").value;
    if (!replacements.length && conversion === "off") {
      setFieldError("postprocessReplacements", t("toolbox_need_rules"));
      setResult(t("toolbox_need_rules"), "error");
      return;
    }
    setFieldError("postprocessReplacements", "");
    setBusy(true, "toolbox_status_starting");
    try {
      const result = await bridge("run_fixed_process", { ...paths, replacements, conversion });
      if (result.ok) applySubtitleResult(result, { kind: "fixed" });
      else setResult(result.error || result.detail || t("failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function runFfconcat() {
    const mediaPath = $("toolboxUtilityMediaPath").value.trim();
    const ffconcatPath = $("postprocessFfconcatPath").value.trim();
    if (!mediaPath) {
      setResult(t("toolbox_need_media"), "error");
      return;
    }
    if (extension(ffconcatPath) !== ".ffconcat") {
      setFieldError("postprocessFfconcatPath", t("toolbox_need_ffconcat"));
      setResult(t("toolbox_need_ffconcat"), "error");
      return;
    }
    setFieldError("postprocessFfconcatPath", "");
    setBusy(true, "toolbox_status_starting");
    try {
      const result = await bridge("run_ffconcat_rebuild", { mediaPath, ffconcatPath });
      if (result.ok) {
        utilityMediaManual = true;
        $("toolboxUtilityMediaPath").value = result.mediaPath;
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
    initializeLlmPrompts();
    renderTaskPrompt();
    renderOcrRegion();
    renderOcrModel();
    selectToolboxSection("postprocess");
    syncPaths();
    initializeAutoPostprocess();
  }

  $("toolboxFab").addEventListener("click", () => {
    toolboxOpenMode = "manual";
    setOpen($("toolboxDrawer").classList.contains("hidden"));
  });
  $("toolboxClose").addEventListener("click", () => setOpen(false));
  $("toolboxDrawer").addEventListener("wheel", (event) => {
    event.stopPropagation();
    if (!event.target?.closest?.(".toolbox-content")) event.preventDefault();
  }, { passive: false });
  document.querySelectorAll("[data-toolbox-section]").forEach((tab) => {
    tab.addEventListener("click", () => selectToolboxSection(tab.dataset.toolboxSection));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      const tabs = [...$("toolboxPrimaryTabList").querySelectorAll("[data-toolbox-section]")];
      const currentIndex = tabs.indexOf(tab);
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const target = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : tabs[(currentIndex + offset + tabs.length) % tabs.length];
      if (!target) return;
      event.preventDefault();
      selectToolboxSection(target.dataset.toolboxSection);
      target.focus();
    });
  });
  document.querySelectorAll(".toolbox-tab").forEach((tab) => {
    tab.addEventListener("click", () => selectTool(tab.dataset.tool));
    tab.addEventListener("keydown", (event) => {
      if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) moveToolFocus(event);
    });
  });
  $("postprocessProvider").addEventListener("change", () => { renderProvider(); renderAutoPostprocessState(); persistAutoPlanSoon(); });
  $("postprocessOperation").addEventListener("change", () => switchLlmOperation($("postprocessOperation").value));
  $("llmProvider").addEventListener("change", () => { $("postprocessProvider").value = $("llmProvider").value; renderProvider(); renderAutoPostprocessState(); persistAutoPlanSoon(); });
  $("saveLlmSettings").addEventListener("click", () => { void saveSettings({ autoTest: true }); });
  $("testLlmConnection").addEventListener("click", testConnection);
  $("getLlmModels").addEventListener("click", getModels);
  $("llmModelChoicesToggle").addEventListener("mousedown", (event) => event.preventDefault());
  $("llmModelChoicesToggle").addEventListener("click", () => setModelChoicesOpen(!modelChoicesOpen));
  $("generateWaveform").addEventListener("click", () => { void generateWaveformProject(false); });
  $("runWaveform").addEventListener("click", () => { void generateWaveformProject(true); });
  $("runScriptMatch").addEventListener("click", runScriptMatch);
  $("postprocessScriptPath").addEventListener("input", () => { void refreshScriptPreview(); });
  $("postprocessExtraSplitPunctuation").addEventListener("input", validateMatchPunctuation);
  $("postprocessPreservePunctuation").addEventListener("input", validateMatchPunctuation);
  $("runOcrDedup").addEventListener("click", runOcrDedup);
  $("ocrModel").addEventListener("change", renderOcrModel);
  $("openOcrSettings").addEventListener("click", () => window.MAWLauncher.openSettings("ocrSettingsSection"));
  $("runLlmPostprocess").addEventListener("click", runLlm);
  $("runFixedProcess").addEventListener("click", runFixedProcess);
  $("runFfconcatRebuild").addEventListener("click", runFfconcat);
  $("pickPostprocessFfconcat").addEventListener("click", async () => {
    const result = await bridge("choose_file", { kind: "ffconcat" });
    if (result.ok) $("postprocessFfconcatPath").value = result.path;
  });
  $("pickPostprocessScript").addEventListener("click", async () => {
    const result = await bridge("choose_file", { kind: "script" });
    if (result.ok) {
      $("postprocessScriptPath").value = result.path;
      $("postprocessScriptPath").dispatchEvent(new Event("input", { bubbles: true }));
      setFieldError("postprocessScriptPath", "");
      void refreshScriptPreview();
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
  $("pickToolboxUtilityMedia").addEventListener("click", async () => {
    const result = await bridge("choose_file", { kind: "media" });
    if (result.ok) {
      utilityMediaManual = true;
      $("toolboxUtilityMediaPath").value = result.path;
      setFieldError("toolboxUtilityMediaPath", "");
      syncUtilityMediaName();
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
      $("ocrVideoPath").dispatchEvent(new Event("input", { bubbles: true }));
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
  $("toolboxUtilityMediaPath").addEventListener("input", () => {
    utilityMediaManual = Boolean($("toolboxUtilityMediaPath").value.trim());
    setFieldError("toolboxUtilityMediaPath", "");
    syncPaths();
  });
  $("ocrVideoPath").addEventListener("input", () => {
    ocrVideoManual = Boolean($("ocrVideoPath").value.trim());
    setFieldError("ocrVideoPath", "");
  });
  $("ocrRegionMode").addEventListener("change", renderOcrRegion);
  $("ocrThreshold").addEventListener("input", () => setFieldError("ocrThreshold", ""));
  $("openLlmSettings").addEventListener("click", () => { window.MAWLauncher.openSettings("llmSettingsSection"); requestAnimationFrame(() => $("llmApiKey")?.focus()); });
  $("postprocessScriptPath").addEventListener("input", () => { setFieldError("postprocessScriptPath", ""); renderAutoPostprocessState(); maybeEnablePendingAutoStep(); persistAutoPlanSoon(); });
  $("postprocessPrompt").addEventListener("input", () => {
    persistLlmPrompt();
    setFieldError("postprocessPrompt", "");
    renderAutoPostprocessState();
    persistAutoPlanSoon();
  });
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
  document.addEventListener("pointerdown", (event) => {
    if (artifactMenuTarget && !event.target?.closest?.("#artifactContextMenu")) closeArtifactMenu();
  });
  $("artifactSetTarget").addEventListener("click", () => { void runArtifactAction("select"); });
  $("artifactOpenFolder").addEventListener("click", () => { void runArtifactAction("open_containing_folder"); });
  $("artifactOpenFile").addEventListener("click", () => { void runArtifactAction("open_file"); });
  ["llmApiKey", "llmBaseUrl", "llmModel", "llmReasoningMode"].forEach((id) => {
    $(id).addEventListener("input", () => setFieldError(id, ""));
    $(id).addEventListener("change", () => setFieldError(id, ""));
  });
  $("postprocessReplacements").addEventListener("input", () => { setFieldError("postprocessReplacements", ""); renderReplacementPreview(); renderAutoPostprocessState(); maybeEnablePendingAutoStep(); persistAutoPlanSoon(); });
  $("postprocessReplacementSeparator").addEventListener("change", () => { syncReplacementSeparator(); renderReplacementPreview(); renderAutoPostprocessState(); persistAutoPlanSoon(); });
  $("postprocessReplacementCustomSeparator").addEventListener("input", () => { syncReplacementSeparator(); renderReplacementPreview(); renderAutoPostprocessState(); persistAutoPlanSoon(); });
  $("postprocessReplacementTrim").addEventListener("change", () => { renderReplacementPreview(); renderAutoPostprocessState(); persistAutoPlanSoon(); });
  $("postprocessConversion").addEventListener("change", () => { setFieldError("postprocessReplacements", ""); renderAutoPostprocessState(); maybeEnablePendingAutoStep(); persistAutoPlanSoon(); });
  $("ocrVideoPath").addEventListener("input", () => { ocrVideoManual = Boolean($("ocrVideoPath").value.trim()); setFieldError("ocrVideoPath", ""); renderAutoPostprocessState(); maybeEnablePendingAutoStep(); persistAutoPlanSoon(); });
  ["ocrRegionMode", "ocrRegionX1", "ocrRegionY1", "ocrRegionX2", "ocrRegionY2", "ocrThreshold", "ocrReport", "autoTranslateTarget"].forEach((id) => {
    $(id).addEventListener("input", () => { renderAutoPostprocessState(); maybeEnablePendingAutoStep(); persistAutoPlanSoon(); });
    $(id).addEventListener("change", () => { renderAutoPostprocessState(); maybeEnablePendingAutoStep(); persistAutoPlanSoon(); });
  });
  $("autoPostprocessEnabled").addEventListener("change", () => {
    if ($("autoPostprocessEnabled").checked) setAutoStepsExpanded(true);
    renderAutoPostprocessState();
    persistAutoPlanSoon();
  });
  $("autoPostprocessRetain").addEventListener("change", () => { renderAutoPostprocessState(); persistAutoPlanSoon(); });
  $("autoPostprocessStepsToggle").addEventListener("click", () => {
    const expanded = $("autoPostprocessStepsCard").classList.contains("collapsed");
    setAutoStepsExpanded(expanded);
  });
  $("autoTranslateTarget").addEventListener("change", () => {
    if (["translate_zh", "translate_en"].includes(activeLlmOperation)) switchLlmOperation(autoLlmOperation("translate"));
  });
  AUTO_STEP_ORDER.forEach((stepId) => {
    const checkbox = $(AUTO_STEP_CHECKBOXES[stepId]);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked && !autoStepReady(stepId)) {
        checkbox.checked = false;
        renderAutoPostprocessState();
        openAutoStep(stepId, "", { highlightConnection: true });
        return;
      }
      renderAutoPostprocessState();
      persistAutoPlanSoon();
    });
    $(`configureAuto${stepId[0].toUpperCase()}${stepId.slice(1)}`).addEventListener("click", () => openAutoStep(stepId));
  });
  ["jsonPath", "srtPath", "mediaPath"].forEach((id) => $(id).addEventListener("input", syncPaths));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (artifactMenuTarget) {
      event.preventDefault();
      closeArtifactMenu({ restoreFocus: true });
      return;
    }
    if (busy) return;
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
  window.MAWLauncher.onPostprocessPipeline = (event) => {
    if (event.stage === "step_start") setResult(`${autoStepLabel(event.step)}：${t("toolbox_running")}`);
    if (event.stage === "step_done") setResult(`${autoStepLabel(event.step)}：${t("toolbox_done")}`, "success");
  };
  window.MAWLauncher.getAutoPostprocessPayload = autoPlanFromControls;
  window.MAWLauncher.onLanguageChanged = () => {
    document.querySelectorAll(".toolbox-chain-file").forEach(renderArtifactButton);
    renderAutoPostprocessState();
  };
  function applyBatchModeLocks() {
    $("toolboxMatchTab").disabled = batchMode;
    $("runScriptMatch").disabled = batchMode || busy;
    $("configureAutoMatch").disabled = batchMode;
  }
  window.MAWLauncher.onBatchModeChanged = (active) => {
    batchMode = Boolean(active);
    applyBatchModeLocks();
    if (batchMode && $("toolboxMatchTab").classList.contains("active")) selectTool("replace");
    renderAutoPostprocessState();
  };
  window.MAWLauncher.openAutoPostprocessStep = openAutoStep;
  window.MAWLauncher.onOcrRuntimeChanged = () => {
    renderOcrModel();
    renderAutoPostprocessState();
    maybeEnablePendingAutoStep();
  };
  if (window.MAWLauncher.config) initialize();
})();

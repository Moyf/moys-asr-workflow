(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const panels = { match: "toolboxMatchPanel", llm: "toolboxLlmPanel", replace: "toolboxReplacePanel", ffconcat: "toolboxFfconcatPanel" };
  const TASK_PROMPT_KEYS = { proofread: "toolbox_task_proofread", resegment: "toolbox_task_resegment", translate_en: "toolbox_task_translate_en", translate_zh: "toolbox_task_translate_zh" };
  const SUBTITLE_EXTS = new Set([".mosp", ".json", ".srt"]);
  const SCRIPT_EXTS = new Set([".txt", ".md", ".markdown"]);
  const CUSTOM_DEFAULT_LABEL = "Custom (OpenAI-compatible)";
  let busy = false;
  let inputManual = false;
  let saveStatusTimer = 0;

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
    syncInputName();
  }

  function renderProvider(providerId = $("postprocessProvider").value) {
    const item = provider(providerId);
    syncProviderOptionLabels();
    $("postprocessProvider").value = item.id;
    $("llmProvider").value = item.id;
    $("llmBaseUrl").value = item.baseUrl || "";
    $("llmModel").value = item.model || "";
    $("llmApiKey").value = "";
    $("llmApiKey").placeholder = item.maskedApiKey || "";
    $("llmCustomDisplayNameField").classList.toggle("hidden", item.id !== "custom");
    $("llmCustomDisplayName").value = item.id === "custom" ? item.displayName || "" : "";
    setFieldError("llmCustomDisplayName", "");
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
  }

  function setResult(message, kind = "") {
    const result = $("toolboxResult");
    result.textContent = message;
    result.classList.toggle("success", kind === "success");
    result.classList.toggle("error", kind === "error");
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

  function setBusy(nextBusy) {
    busy = nextBusy;
    $("toolboxProgress").classList.toggle("hidden", !busy);
    ["runScriptMatch", "runLlmPostprocess", "runFixedReplacement", "runFfconcatRebuild", "saveLlmSettings", "testLlmConnection", "toolboxInputPath", "pickToolboxInput", "postprocessProvider", "llmProvider", "llmApiKey", "llmBaseUrl", "llmModel", "llmCustomDisplayName"].forEach((id) => {
      $(id).disabled = busy;
    });
    if (busy) setResult(t("toolbox_running"));
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
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
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
    setBusy(true);
    try {
      const result = await bridge("run_script_match", { ...paths, scriptPath });
      if (result.ok) applySubtitleResult(result, { kind: "match" });
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
      displayName: item.id === "custom" ? $("llmCustomDisplayName").value.trim() : "",
    });
    if (!result.ok) {
      const field = result.field === "postprocessApiKey"
        ? "llmApiKey"
        : (result.field === "postprocessBaseUrl" ? "llmBaseUrl" : (result.field === "postprocessModel" ? "llmModel" : (result.field === "postprocessDisplayName" ? "llmCustomDisplayName" : "")));
      if (field) setFieldError(field, result.detail || result.error || t("failed"));
      setSettingsSaveStatus(result.error || result.detail || t("failed"), "error");
      setResult(result.error || result.detail || t("failed"), "error");
      return;
    }
    ["llmApiKey", "llmBaseUrl", "llmModel", "llmCustomDisplayName"].forEach((field) => setFieldError(field, ""));
    item.baseUrl = $("llmBaseUrl").value.trim();
    item.model = $("llmModel").value.trim();
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
    try {
      const item = provider();
      const result = await bridge("test_postprocess_connection", {
        providerId: item.id,
        apiKey: $("llmApiKey").value.trim(),
        baseUrl: $("llmBaseUrl").value.trim(),
        model: $("llmModel").value.trim(),
      });
      if (result.ok) setSettingsSaveStatus(t("llm_connection_success"), "success");
      else setSettingsSaveStatus(result.detail || result.error || t("failed"), "error", 0);
    } catch (error) {
      setSettingsSaveStatus(String(error?.message || error || t("failed")), "error", 0);
    } finally {
      $("testLlmConnection").disabled = busy;
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
    setBusy(true);
    try {
      const result = await bridge("run_llm_postprocess", {
        ...paths,
        operation,
        taskPrompt: taskPromptText(operation),
        customPrompt,
        providerId: item.id,
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
    setBusy(true);
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
    setBusy(true);
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
  $("runScriptMatch").addEventListener("click", runScriptMatch);
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
      syncInputName();
    }
  });
  $("toolboxInputPath").addEventListener("input", () => {
    clearChainSelection();
    inputManual = Boolean($("toolboxInputPath").value.trim());
    setFieldError("toolboxInputPath", "");
    syncInputName();
  });
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
  ["llmApiKey", "llmBaseUrl", "llmModel"].forEach((id) => $(id).addEventListener("input", () => setFieldError(id, "")));
  $("postprocessReplacements").addEventListener("input", () => setFieldError("postprocessReplacements", ""));
  ["jsonPath", "srtPath", "mediaPath"].forEach((id) => $(id).addEventListener("input", syncPaths));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !busy) setOpen(false); });
  window.addEventListener("mawlauncherready", initialize, { once: true });
  if (window.MAWLauncher.config) initialize();
})();

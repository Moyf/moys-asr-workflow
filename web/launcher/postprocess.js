(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const panels = { match: "toolboxMatchPanel", llm: "toolboxLlmPanel", replace: "toolboxReplacePanel", ffconcat: "toolboxFfconcatPanel" };
  const SUBTITLE_EXTS = new Set([".mosp", ".json", ".srt"]);
  const SCRIPT_EXTS = new Set([".txt", ".md", ".markdown"]);
  let busy = false;
  let inputManual = false;

  function t(key) {
    return window.MAWLauncher.translate(key);
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

  function autoSourcePath() {
    return $("jsonPath").value.trim() || $("srtPath").value.trim();
  }

  function syncPaths() {
    if (!inputManual) $("toolboxInputPath").value = autoSourcePath();
    $("toolboxMediaPath").textContent = $("mediaPath").value.trim() || t("toolbox_no_media");
  }

  function renderProvider(providerId = $("postprocessProvider").value) {
    const item = provider(providerId);
    $("postprocessProvider").value = item.id;
    $("llmProvider").value = item.id;
    $("llmBaseUrl").value = item.baseUrl || "";
    $("llmModel").value = item.model || "";
    $("llmApiKey").value = "";
    $("llmApiKey").placeholder = item.maskedApiKey || "";
    $("llmKeyStatus").textContent = item.maskedApiKey
      ? t("toolbox_key_loaded").replace("{key}", item.maskedApiKey)
      : t("toolbox_key_empty");
    $("postprocessProviderStatus").textContent = `${item.label} · ${item.maskedApiKey ? t("toolbox_key_loaded").replace("{key}", item.maskedApiKey) : t("toolbox_key_empty")}`;
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

  function setBusy(nextBusy) {
    busy = nextBusy;
    $("toolboxProgress").classList.toggle("hidden", !busy);
    ["runScriptMatch", "runLlmPostprocess", "runFixedReplacement", "runFfconcatRebuild", "saveLlmSettings", "toolboxInputPath", "pickToolboxInput", "postprocessProvider", "llmProvider", "llmApiKey", "llmBaseUrl", "llmModel"].forEach((id) => {
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

  function applySubtitleResult(result) {
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
    const paths = [result.projectPath, result.srtPath].filter(Boolean);
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    setResult(`${t("toolbox_done")}\n${paths.join("\n")}${warnings.length ? `\n${warnings.join("\n")}` : ""}`, "success");
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
      if (result.ok) applySubtitleResult(result);
      else setResult(result.error || result.detail || t("failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    const item = provider();
    const result = await bridge("save_postprocess_settings", {
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
      setResult(result.error || result.detail || t("failed"), "error");
      return;
    }
    ["llmApiKey", "llmBaseUrl", "llmModel"].forEach((field) => setFieldError(field, ""));
    item.baseUrl = $("llmBaseUrl").value.trim();
    item.model = $("llmModel").value.trim();
    item.maskedApiKey = result.maskedApiKey || item.maskedApiKey;
    renderProvider(item.id);
    setResult(t("toolbox_saved"), "success");
  }

  async function runLlm() {
    const paths = resolveInputPaths();
    if (!paths) return;
    const item = provider();
    setBusy(true);
    try {
      const result = await bridge("run_llm_postprocess", {
        ...paths,
        operation: $("postprocessOperation").value,
        customPrompt: $("postprocessPrompt").value.trim(),
        providerId: item.id,
      });
      if (result.ok) applySubtitleResult(result);
      else setResult(result.error || result.detail || t("failed"), "error");
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
      if (result.ok) applySubtitleResult(result);
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
      config.postprocessProviders.forEach((item) => select.add(new Option(item.label, item.id)));
      select.value = selectedProvider;
    });
    renderProvider();
    selectTool("match");
    syncPaths();
  }

  $("toolboxFab").addEventListener("click", () => setOpen($("toolboxDrawer").classList.contains("hidden")));
  $("toolboxClose").addEventListener("click", () => setOpen(false));
  document.querySelectorAll(".toolbox-tab").forEach((tab) => tab.addEventListener("click", () => selectTool(tab.dataset.tool)));
  $("postprocessProvider").addEventListener("change", renderProvider);
  $("llmProvider").addEventListener("change", () => { $("postprocessProvider").value = $("llmProvider").value; renderProvider(); });
  $("saveLlmSettings").addEventListener("click", saveSettings);
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
    }
  });
  $("toolboxInputPath").addEventListener("input", () => {
    inputManual = Boolean($("toolboxInputPath").value.trim());
    setFieldError("toolboxInputPath", "");
  });
  $("toolboxIssuesLink").addEventListener("click", (event) => {
    event.preventDefault();
    bridge("open_url", { url: "https://github.com/Moyf/moys-asr-workflow/issues" });
  });
  $("openLlmSettings").addEventListener("click", () => window.MAWLauncher.openSettings("llmSettingsSection"));
  $("postprocessScriptPath").addEventListener("input", () => setFieldError("postprocessScriptPath", ""));
  ["llmApiKey", "llmBaseUrl", "llmModel"].forEach((id) => $(id).addEventListener("input", () => setFieldError(id, "")));
  $("postprocessReplacements").addEventListener("input", () => setFieldError("postprocessReplacements", ""));
  ["jsonPath", "srtPath", "mediaPath"].forEach((id) => $(id).addEventListener("input", syncPaths));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !busy) setOpen(false); });
  window.addEventListener("mawlauncherready", initialize, { once: true });
  if (window.MAWLauncher.config) initialize();
})();

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const panels = { llm: "toolboxLlmPanel", replace: "toolboxReplacePanel", ffconcat: "toolboxFfconcatPanel" };
  let busy = false;

  function t(key) {
    return window.MAWLauncher.translate(key);
  }

  function bridge(method, payload = {}) {
    return window.MAWLauncher.callBackend(method, payload);
  }

  function extension(path) {
    return (String(path || "").match(/\.[^.\\/]+$/u)?.[0] || "").toLowerCase();
  }

  function provider() {
    const providers = window.MAWLauncher.config.postprocessProviders;
    return providers.find((item) => item.id === $("postprocessProvider").value) || providers[0];
  }

  function syncPaths() {
    const source = $("jsonPath").value.trim() || $("srtPath").value.trim();
    $("toolboxSourcePath").textContent = source || t("toolbox_no_source");
    $("toolboxMediaPath").textContent = $("mediaPath").value.trim() || t("toolbox_no_media");
  }

  function renderProvider() {
    const item = provider();
    $("postprocessBaseUrl").value = item.baseUrl || "";
    $("postprocessModel").value = item.model || "";
    $("postprocessApiKey").value = "";
    $("postprocessApiKey").placeholder = item.maskedApiKey || "";
    $("postprocessKeyStatus").textContent = item.maskedApiKey
      ? t("toolbox_key_loaded").replace("{key}", item.maskedApiKey)
      : t("toolbox_key_empty");
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
    ["runLlmPostprocess", "runFixedReplacement", "runFfconcatRebuild", "savePostprocessSettings"].forEach((id) => {
      $(id).disabled = busy;
    });
    if (busy) setResult(t("toolbox_running"));
  }

  function inputPaths() {
    return {
      projectPath: $("jsonPath").value.trim(),
      srtPath: $("srtPath").value.trim(),
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

  async function saveSettings() {
    const item = provider();
    const result = await bridge("save_postprocess_settings", {
      providerId: item.id,
      apiKey: $("postprocessApiKey").value.trim(),
      baseUrl: $("postprocessBaseUrl").value.trim(),
      model: $("postprocessModel").value.trim(),
    });
    if (!result.ok) {
      setResult(result.error || result.detail || t("failed"), "error");
      return;
    }
    item.baseUrl = $("postprocessBaseUrl").value.trim();
    item.model = $("postprocessModel").value.trim();
    item.maskedApiKey = result.maskedApiKey || item.maskedApiKey;
    renderProvider();
    setResult(t("toolbox_saved"), "success");
  }

  async function runLlm() {
    const paths = inputPaths();
    if (!paths.projectPath && !paths.srtPath) {
      setResult(t("toolbox_need_source"), "error");
      return;
    }
    const item = provider();
    setBusy(true);
    try {
      const result = await bridge("run_llm_postprocess", {
        ...paths,
        operation: $("postprocessOperation").value,
        customPrompt: $("postprocessPrompt").value.trim(),
        providerId: item.id,
        apiKey: $("postprocessApiKey").value.trim(),
        baseUrl: $("postprocessBaseUrl").value.trim(),
        model: $("postprocessModel").value.trim(),
      });
      if (result.ok) applySubtitleResult(result);
      else setResult(result.error || result.detail || t("failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function runReplacement() {
    const paths = inputPaths();
    const replacements = parseReplacements();
    if (!paths.projectPath && !paths.srtPath) {
      setResult(t("toolbox_need_source"), "error");
      return;
    }
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
    const selected = config.postprocessProviders.find((item) => item.selected)?.id || config.postprocessProviders[0].id;
    const select = $("postprocessProvider");
    config.postprocessProviders.forEach((item) => select.add(new Option(item.label, item.id)));
    select.value = selected;
    renderProvider();
    syncPaths();
  }

  $("toolboxFab").addEventListener("click", () => setOpen($("toolboxDrawer").classList.contains("hidden")));
  $("toolboxClose").addEventListener("click", () => setOpen(false));
  document.querySelectorAll(".toolbox-tab").forEach((tab) => tab.addEventListener("click", () => selectTool(tab.dataset.tool)));
  $("postprocessProvider").addEventListener("change", renderProvider);
  $("savePostprocessSettings").addEventListener("click", saveSettings);
  $("runLlmPostprocess").addEventListener("click", runLlm);
  $("runFixedReplacement").addEventListener("click", runReplacement);
  $("runFfconcatRebuild").addEventListener("click", runFfconcat);
  $("pickPostprocessFfconcat").addEventListener("click", async () => {
    const result = await bridge("choose_file", { kind: "ffconcat" });
    if (result.ok) $("postprocessFfconcatPath").value = result.path;
  });
  $("postprocessReplacements").addEventListener("input", () => setFieldError("postprocessReplacements", ""));
  ["jsonPath", "srtPath", "mediaPath"].forEach((id) => $(id).addEventListener("input", syncPaths));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !busy) setOpen(false); });
  window.addEventListener("mawlauncherready", initialize, { once: true });
  if (window.MAWLauncher.config) initialize();
})();

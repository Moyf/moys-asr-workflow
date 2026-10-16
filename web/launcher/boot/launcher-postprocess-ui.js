// 原型 v4 的工具导航、可见步骤和配置抽屉。移动真实面板，绝不克隆表单。
function createLauncherPostprocessUI({ steps, checkboxes, tools, panels, label, ready, selectTool, switchOperation, render, persist, onClose }) {
  const $ = (id) => document.getElementById(id);
  const tr = (key) => window.MAWLauncher.translate(key);
  const storageKey = "maw.launcher.postprocess.visible_steps";
  const defaults = ["replace", "proofread", "resegment", "translate"];
  let pins = new Set(defaults);
  let hasPreference = false;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved)) { pins = new Set(saved.filter((id) => steps.includes(id))); hasPreference = true; }
  } catch (_) { /* 存储不可用时，本次会话仍可配置。 */ }
  let currentStep = "";
  let currentTool = "match";
  let currentOperation = "translate_zh";
  let returnFocus = null;
  let movedPanel = null;
  let panelHome = null;
  const nav = $("toolboxToolNav");
  const icons = { match: "doc", replace: "text", ocr: "eye", timestamps: "clock", ai_cleanup: "spark", proofread: "check", resegment: "cut", translate: "language", custom: "text", burnSubtitle: "play", alignment: "mic", extractAudio: "music", waveform: "wave" };
  const slot = $("toolboxPanelSlot");
  const toolItems = [
    ["match", "toolboxMatchTab", "auto_step_match"],
    ["replace", "toolboxReplaceTab", "auto_step_replace"],
    ["ocr", "toolboxOcrTab", "auto_step_ocr"],
    ["timestamps", "toolboxTimestampsTab", "toolbox_timestamps"],
    ["llm", "toolboxCleanupTab", "auto_step_cleanup", "ai_cleanup"],
    ["llm", "toolboxProofreadTab", "auto_step_proofread", "proofread"],
    ["llm", "toolboxResegmentTab", "auto_step_resegment", "resegment"],
    ["llm", "toolboxLlmTab", "auto_step_translate", "translate"],
    ["llm", "toolboxCustomTab", "toolbox_custom", "custom"],
    ["burnSubtitle", "toolboxBurnSubtitleTab", "auto_step_burn"],
    ["alignment", "toolboxAlignmentTab", "toolbox_alignment"],
    ["extractAudio", "toolboxExtractAudioTab", "toolbox_extract_audio"],
    ["waveform", "toolboxWaveformTab", "toolbox_waveform"],
  ];
  toolItems.forEach(([tool, id, key, operation], index) => {
    if ([0, 4, 9].includes(index)) {
      const heading = document.createElement("h3");
      heading.dataset.i18n = ["toolbox_group_postprocess", "redesign_ai_group", "toolbox_group_utilities"][[0, 4, 9].indexOf(index)];
      nav.append(heading);
    }
    const button = $(id) || document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = "toolbox-tab";
    button.dataset.tool = tool;
    if (operation) button.dataset.operation = operation;
    button.dataset.i18n = key;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", panels[tool]);
    nav.append(button);
  });
  const legend = document.createElement("p");
  legend.className = "toolbox-nav-legend";
  legend.dataset.i18n = "redesign_pin_legend";
  nav.append(legend);
  Object.values(panels).forEach((id) => slot.append($(id)));
  slot.before($("toolboxAudioTrackField"));
  // AI 模型供应商在设置页配置；保留原 select 作为协议与任务记忆桥。
  $("postprocessProvider").closest(".toolbox-grid").classList.add("hidden");
  $("postprocessProvider").closest(".adv-group").querySelector("h3").classList.add("hidden");
  $("postprocessTaskPrompt").closest(".toolbox-preset-prompt").classList.add("preset-collapsible");
  const promptBlock = $("postprocessTaskPrompt").closest(".toolbox-preset-prompt");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.dataset.i18n = "redesign_builtin_prompt";
  details.append(summary);
  promptBlock.before(details);
  details.append(promptBlock);
  const llmPanel = $("toolboxLlmPanel");
  const llmTitle = document.createElement("h3");
  llmTitle.id = "toolboxLlmTitle";
  const titleRow = document.createElement("div"); titleRow.className = "llm-title-row";
  titleRow.append(llmTitle, $("postprocessProviderStatus"));
  llmPanel.prepend(titleRow);
  llmPanel.setAttribute("aria-labelledby", llmTitle.id);
  const commonFooter = document.createElement("div"); commonFooter.className = "llm-common-footer";
  const comparison = document.querySelector('label[for="postprocessGenerateComparison"]');
  const comparisonHint = document.querySelector('[data-i18n="toolbox_generate_comparison_hint"]');
  commonFooter.append(comparison, comparisonHint, llmPanel.querySelector(".toolbox-settings-hint"));
  llmPanel.append(commonFooter);
  $("postprocessPrompt").closest(".adv-group").querySelector("h3").classList.add("hidden");
  // 追加要求在前，内置提示词折叠放在后；两个入口移动同一组控件。
  details.before($("postprocessPrompt").closest(".field"));
  const targetField = document.createElement("div");
  targetField.className = "field";
  targetField.innerHTML = '<label for="toolboxTranslateTarget" data-i18n="auto_translate_target"></label><select id="toolboxTranslateTarget"><option value="zh" data-i18n="auto_translate_zh"></option><option value="en" data-i18n="auto_translate_en"></option></select>';
  $("postprocessTranslationOptions").prepend(targetField);
  $("toolboxTranslateTarget").addEventListener("change", () => {
    $("autoTranslateTarget").value = $("toolboxTranslateTarget").value;
    $("autoTranslateTarget").dispatchEvent(new Event("change", { bubbles: true }));
    switchOperation(`translate_${$("toolboxTranslateTarget").value}`);
  });
  const footer = document.createElement("label");
  footer.className = "toolbox-pin-footer check-field";
  footer.innerHTML = '<input id="toolboxAutoAvailable" type="checkbox"><span data-i18n="redesign_auto_available"></span>';
  slot.append(footer);
  const pinToggle = footer.querySelector("input");
  const stepForTool = () => currentTool === "llm"
    ? ({ ai_cleanup: "cleanup", proofread: "proofread", resegment: "resegment", translate_zh: "translate", translate_en: "translate" }[currentOperation] || "")
    : ({ burnSubtitle: "burn" }[currentTool] || (steps.includes(currentTool) ? currentTool : ""));
  const visibleSteps = () => steps.filter((id) => pins.has(id));

  function savePins() {
    hasPreference = true;
    try { localStorage.setItem(storageKey, JSON.stringify(visibleSteps())); }
    catch (_) { window.MAWLauncher.appendLog(tr("redesign_local_memory_unavailable")); }
  }
  function restorePanel() {
    if (movedPanel && panelHome) panelHome.append(movedPanel);
    movedPanel = panelHome = null;
  }
  function close({ focus = true } = {}) {
    if (!currentStep) return;
    restorePanel();
    currentStep = "";
    // class 切换而不是 display，让滑出动画可播完。
    $("postprocessSheet").classList.remove("open");
    $("postprocessScrim").classList.remove("open");
    document.querySelector("main.shell").inert = false;
    onClose();
    selectTool(currentTool);
    if (focus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function renderSheet() {
    const visible = visibleSteps();
    const rail = $("postprocessSheetSteps");
    rail.replaceChildren();
    visible.forEach((id, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = id === currentStep ? "active" : "";
      button.setAttribute("aria-current", id === currentStep ? "step" : "false");
      const n = document.createElement("span"); n.className = "step-number"; n.textContent = String(index + 1);
      const text = document.createElement("span"); text.textContent = label(id);
      const dot = document.createElement("span"); dot.className = `step-dot${$(checkboxes[id]).checked ? " on" : ""}`;
      button.append(n, text, dot);
      button.addEventListener("click", () => open(id));
      rail.append(button);
    });
    $("postprocessSheetTitle").textContent = label(currentStep);
    $("postprocessSheetIndex").textContent = `${visible.indexOf(currentStep) + 1} / ${visible.length}`;
    $("postprocessSheetEnabled").checked = $(checkboxes[currentStep]).checked;
    $("postprocessSheetEnabled").disabled = $(checkboxes[currentStep]).disabled;
    $("postprocessSheetPrev").disabled = visible.indexOf(currentStep) <= 0;
    $("postprocessSheetNext").disabled = visible.indexOf(currentStep) >= visible.length - 1;
  }
  function open(id) {
    if (!steps.includes(id)) return;
    if (!currentStep) returnFocus = document.activeElement;
    restorePanel();
    if (!pins.has(id)) { pins.add(id); savePins(); }
    currentStep = id;
    selectTool(tools[id]);
    if (["cleanup", "proofread", "resegment", "translate"].includes(id)) {
      switchOperation(id === "cleanup" ? "ai_cleanup" : id === "translate" ? `translate_${$("autoTranslateTarget").value}` : id);
    }
    movedPanel = $(panels[tools[id]]);
    panelHome = movedPanel.parentElement;
    $("postprocessSheetBody").append(movedPanel);
    movedPanel.classList.remove("hidden");
    $("postprocessSheet").classList.add("open");
    $("postprocessScrim").classList.add("open");
    document.querySelector("main.shell").inert = true;
    render();
    renderSheet();
    $("postprocessSheetClose").focus({ preventScroll: true });
    $("postprocessSheetBody").scrollTop = 0;
  }
  pinToggle.addEventListener("change", () => {
    const id = stepForTool();
    if (!id) return;
    if (pinToggle.checked) pins.add(id);
    else { pins.delete(id); $(checkboxes[id]).checked = false; }
    savePins(); render(); persist();
  });
  $("postprocessSheetClose").addEventListener("click", () => close());
  $("postprocessSheetDone").addEventListener("click", () => close());
  $("postprocessScrim").addEventListener("click", () => close());
  $("postprocessSheetEnabled").addEventListener("change", () => {
    const checkbox = $(checkboxes[currentStep]);
    checkbox.checked = $("postprocessSheetEnabled").checked;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    if (currentStep) renderSheet();
  });
  ["Prev", "Next"].forEach((direction) => $("postprocessSheet" + direction).addEventListener("click", () => {
    const visible = visibleSteps();
    const next = visible[visible.indexOf(currentStep) + (direction === "Prev" ? -1 : 1)];
    if (next) open(next);
  }));
  $("postprocessSheetToolbox").addEventListener("click", () => {
    const tool = tools[currentStep]; const operation = currentOperation;
    close({ focus: false }); window.MAWLauncher.openToolbox(); selectTool(tool);
    if (tool === "llm") switchOperation(operation);
    nav.querySelector(".toolbox-tab.active")?.focus();
  });
  $("autoPostprocessManage").addEventListener("click", () => { window.MAWLauncher.openToolbox(); selectTool("match"); });
  document.addEventListener("keydown", (event) => {
    if (!currentStep) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const controls = [...$("postprocessSheet").querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter((node) => node.getClientRects().length);
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  window.addEventListener("mawpagechange", () => close({ focus: false }));

  function refresh() {
    const visible = visibleSteps();
    steps.forEach((id) => {
      const row = document.querySelector(`[data-auto-step-row="${id}"]`);
      row.classList.toggle("hidden", !pins.has(id));
      let number = row.querySelector(".auto-step-num");
      if (!number) { number = document.createElement("span"); number.className = "auto-step-num"; row.prepend(number); }
      number.textContent = String(visible.indexOf(id) + 1);
      const name = row.querySelector(".auto-step-name");
      if (["cleanup", "proofread", "resegment", "translate"].includes(id) && name && !row.querySelector(".auto-step-badge")) {
        const badge = document.createElement("span"); badge.className = "auto-step-badge"; badge.textContent = "LLM";
        name.append(badge);
        if (row.classList.contains("auto-step-caution")) {
          const caution = document.createElement("span"); caution.className = "auto-step-badge caution"; caution.textContent = tr("redesign_caution");
          name.append(caution);
        }
      }
      const configure = row.querySelector("button");
      configure.textContent = tr(ready(id) ? "auto_configure" : "redesign_go_configure");
      configure.classList.toggle("needs-config", !ready(id));
    });
    nav.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = tr(node.dataset.i18n); });
    nav.querySelectorAll(".toolbox-tab").forEach((button) => {
      const operation = button.dataset.operation;
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.classList.add("i"); icon.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", `#i-${icons[operation || button.dataset.tool] || "tool"}`); icon.append(use); button.prepend(icon);
      const active = button.dataset.tool === currentTool && (!operation || (operation === "translate" ? currentOperation.startsWith("translate_") : operation === currentOperation));
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      const id = operation ? ({ ai_cleanup: "cleanup", translate: "translate" }[operation] || operation) : ({ burnSubtitle: "burn" }[button.dataset.tool] || button.dataset.tool);
      if (steps.includes(id)) {
        const dot = document.createElement("span"); dot.className = `step-dot${pins.has(id) ? " on" : ""}`; button.append(dot);
      }
    });
    $("autoPostprocessHiddenCount").textContent = tr("redesign_hidden_steps").replace("{count}", String(steps.length - visible.length));
    const id = stepForTool();
    footer.classList.toggle("hidden", !id || Boolean(currentStep));
    pinToggle.checked = pins.has(id);
    if (!currentStep && panels[currentTool]) $(panels[currentTool]).append(footer);
    $("toolboxLlmTitle").textContent = currentOperation === "custom" ? tr("toolbox_custom") : label(({ ai_cleanup: "cleanup", translate_zh: "translate", translate_en: "translate" }[currentOperation] || currentOperation));
    $("toolboxTranslateTarget").value = $("autoTranslateTarget").value;
    summary.textContent = tr("redesign_builtin_prompt");
    footer.querySelector("span").textContent = tr("redesign_auto_available");
    targetField.querySelector("label").textContent = tr("auto_translate_target");
    targetField.querySelectorAll("option").forEach((node) => { node.textContent = tr(node.dataset.i18n); });
    if (currentStep) renderSheet();
  }
  return {
    open, close, refresh,
    isVisible: (id) => pins.has(id),
    initialize(plan) {
      // 升级时保留旧计划已开启的步骤，不能悄悄停用用户已有流水线。
      if (!hasPreference) (plan.steps || []).filter((step) => step.enabled).forEach((step) => pins.add(step.id));
      steps.forEach((id) => { if (!pins.has(id)) $(checkboxes[id]).checked = false; });
      refresh();
    },
    select(tool, operation) { currentTool = tool; currentOperation = operation; refresh(); },
  };
}

// 设置面板导航与启动状态刷新、init 入口。

function selectSettingsTab(tabName) {
  const tabs = [...document.querySelectorAll("[data-settings-tab]")];
  const tab = tabs.find((item) => item.dataset.settingsTab === tabName);
  if (!tab) return;
  activeSettingsTab = tabName;
  tabs.forEach((item) => {
    const active = item === tab;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    const active = panel.dataset.settingsPanel === tabName;
    panel.classList.toggle("hidden", !active);
    panel.setAttribute("aria-hidden", String(!active));
  });
  const scroll = document.querySelector(".settings-scroll");
  if (scroll) scroll.scrollTop = 0;
}
function settingsTabForSection(sectionId) {
  return $(sectionId)?.closest("[data-settings-panel]")?.dataset.settingsPanel || "";
}
function moveSettingsFocus(event) {
  const tabs = [...event.currentTarget.closest('[role="tablist"]').querySelectorAll("[data-settings-tab]")];
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0) return;
  const offset = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
  const target = event.key === "Home"
    ? tabs[0]
    : event.key === "End"
      ? tabs.at(-1)
      : tabs[(currentIndex + offset + tabs.length) % tabs.length];
  if (!target) return;
  event.preventDefault();
  selectSettingsTab(target.dataset.settingsTab);
  target.focus();
}
function openSettings(sectionId = "", focusId = "") {
  selectSettingsTab(settingsTabForSection(sectionId) || activeSettingsTab);
  $("settingsModal").classList.remove("hidden");
  renderUpdate();
  refreshFfmpeg();
  void refreshOcrRuntime();
  renderStickerCurrent();
  renderAsrPresetRootCurrent();
  $("showRareLangs").checked = Boolean(state.config.showRareLangs);
  $("outputSubfolder").checked = Boolean(state.config.outputSubfolder);
  $("perVideoSubfolder").checked = Boolean(state.config.perVideoSubfolder);
  $("attachModelName").checked = state.config.attachModelName !== false;
  $("notifyOnComplete").checked = state.config.notifyOnComplete === true;
  if (sectionId) {
    requestAnimationFrame(() => {
      // 只滚动 .settings-scroll 容器；scrollIntoView 会连带滚动 overflow:hidden 的
      // .modal-card，把标题和标签页顶出视野，区块位于容器顶部时表现为下坠一小段。
      const section = $(sectionId);
      const scroll = section?.closest(".settings-scroll");
      if (section && scroll) scroll.scrollTo({ top: Math.max(0, section.offsetTop - scroll.offsetTop), behavior: "smooth" });
      if (focusId) requestAnimationFrame(() => $(focusId)?.focus());
    });
  }
}
function closeSettings() { $("settingsModal").classList.add("hidden"); }
async function openPreferredEditor() {
  clearErrors();
  $("htmlMenu").classList.add("hidden");
  if (state.moseStarting || state.serverStarting) return;
  const projectPath = $("jsonPath").value.trim();
  state.moseStarting = true;
  renderServerButton();
  try {
    const result = await bridge("open_preferred_editor", serverPayload());
    if (!result.ok) {
      applyErrorResult(result);
      return;
    }
    if (result.usedMose) {
      $("openMawe").classList.remove("attention");
      setStatus(t("mose_started"));
      appendLog(t("mose_started"));
      return;
    }
    appendLog(t("mose_fallback"));
    await applyServerLaunchResult(result, projectPath, t("mose_fallback"));
  } finally {
    state.moseStarting = false;
    renderServerButton();
  }
}
async function openServerEditor() {
  clearErrors();
  $("htmlMenu").classList.add("hidden");
  if (state.serverStarting || state.serverStopping || state.moseStarting) return;
  const projectPath = $("jsonPath").value.trim();
  const currentUrl = state.detectedServerUrl || `http://127.0.0.1:${$("port").value || "8250"}/?lang=${state.lang}`;
  if ((state.serverRunning && projectPath === state.serverProjectPath) || (state.detectedServerUrl && !projectPath)) { await bridge("open_url", { url: currentUrl }); return; }
  const restartProjectPath = serverRestartProjectPath;
  serverStatusRequest += 1;
  state.serverStarting = true;
  renderServerButton();
  try {
    if (projectPath) {
      const mediaState = await refreshServerMedia();
      if ((!mediaState.hasMedia || !mediaState.mediaExists) && !$("serverMediaPath").value.trim()) {
        expandServer();
        return fail("serverMediaPath", errText("server_media_missing", ""));
      }
    }
    const result = await bridge("start_server", serverPayload());
    await applyServerLaunchResult(result, projectPath, "", restartProjectPath);
  } finally {
    state.serverStarting = false;
    renderServerButton();
  }
}

function refreshStartupState() {
  const tasks = [
    ["default output", syncDefaultOutput()],
    ["FFmpeg", refreshFfmpeg()],
    ["server", checkExistingServer()],
    ["OCR", refreshOcrRuntime()],
    ["alignment models", refreshAlignmentModels()],
  ];
  if (isLocalProvider()) {
    tasks.push(["local models", refreshLocalModels()]);
  }
  void Promise.allSettled(tasks.map(([, task]) => task)).then((results) => {
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        appendLog(`[init:${tasks[index][0]}] ${result.reason?.message || result.reason}`);
      }
    });
  });
}

async function init() {
  state.initializing = true;
  const realApi = await waitForBackend();
  api = realApi || mockApi();
  window.MAWLauncher.backend = realApi ? "real" : "mock";
  const savedTheme = readStoredTheme();
  state.theme = savedTheme;
  applyTheme();
  $("lengthLimitField")?.classList.toggle("hidden", !SHOW_LENGTH_LIMIT_FIELD);
  $("demoBadge").classList.toggle("hidden", window.MAWLauncher.backend !== "mock");
  state.config = await bridge("get_config");
  state.update = state.config?.update || { currentVersion: state.config?.appVersion || "", autoCheck: true };
  const initialProjectPath = String(state.config?.initialProjectPath || "").trim();
  state.localModelPaths = { ...(state.config.localModelPaths || {}) };
  const configuredServerPort = Number(state.config.serverPort);
  if (Number.isInteger(configuredServerPort) && configuredServerPort >= 1 && configuredServerPort <= 65535) {
    $("port").value = String(configuredServerPort);
  }
  if (isThemePreference(state.config.theme)) { state.theme = state.config.theme; storeTheme(state.theme); }
  else if (savedTheme !== "system") { state.config.theme = savedTheme; void bridge("save_prefs", { theme: savedTheme }); }
  applyTheme();
  state.config.zoomPercent = applyZoomPercent(state.config.zoomPercent);
  window.MAWLauncher.config = state.config;
  void bridge("get_emoji_font_path").then((emojiFont) => {
    if (emojiFont && emojiFont.ok && emojiFont.path) injectEmojiFont(emojiFont.path);
  });
  state.lang = state.config.guiLang || systemLanguage();
  if (!state.config.guiLang) {
    const result = await bridge("save_prefs", { guiLang: state.lang });
    if (result.ok) state.config.guiLang = state.lang;
    else appendLog(`[init: language] ${result.error || result.detail || "failed to save system language"}`);
  }
  fillSelect("provider", state.config.providers, state.config.providerId || "qwen");
  applyProvider(false);
  $("workspaceId").value = state.config.workspaceId || "";
  syncTestRun(); renderChevron("advancedCard"); renderChevron("serverCard"); renderLanguage(); renderUpdate();
  appendLog(window.MAWLauncher.backend === "real" ? "MAW launcher ready." : "[mock] Static browser demo mode enabled.");
  setStatus(t("ready"));
  if (initialProjectPath && state.update?.autoCheck !== false) {
    await checkForUpdates(false, true);
  }
  revealLauncher();
  window.dispatchEvent(new CustomEvent("mawlauncherready"));
  refreshStartupState();
  if (!initialProjectPath && state.update?.autoCheck !== false) void checkForUpdates(false);
  if (initialProjectPath) {
    setJsonPath(initialProjectPath);
    await openPreferredEditor();
  }
}

// 完成通知与后端事件分发（handleBackendEvent）。

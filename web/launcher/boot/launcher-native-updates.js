// Electron/MOSE 优先入口与软件更新：保持 Server 编辑器作为稳定回退路径。

Object.assign(ERROR_TEXT.zh, {
  mose_not_found: "未找到 MOSE 编辑器。",
  mose_start_failed: (detail) => `MOSE 启动失败：${detail || "请查看日志后重试。"}`,
  update_http_error: (detail) => `GitHub 请求失败：${detail || "请稍后再试。"}`,
  update_response_invalid: "GitHub 返回的版本信息无效。",
  update_cancelled: "更新下载已取消。",
  update_target_invalid: "更新目标已失效，请重新检查版本。",
  update_not_downloaded: "更新包尚未下载完成。",
  update_manual_only: "当前 MAW 副本需要手动下载更新。",
  update_busy: "请先完成当前任务，再更新 MAW。",
  download_failed: "更新包下载失败。",
  checksum_mismatch: "更新包校验失败，请重新下载。",
});
Object.assign(ERROR_TEXT.en, {
  mose_not_found: "The MOSE editor was not found.",
  mose_start_failed: (detail) => `MOSE could not start: ${detail || "check the log and try again."}`,
  update_http_error: (detail) => `GitHub request failed: ${detail || "try again later."}`,
  update_response_invalid: "GitHub returned invalid release information.",
  update_cancelled: "The update download was cancelled.",
  update_target_invalid: "The update target is no longer valid. Check for updates again.",
  update_not_downloaded: "The update package has not finished downloading.",
  update_manual_only: "This MAW copy needs a manual download from the release page.",
  update_busy: "Finish the current task before updating MAW.",
  download_failed: "The update package could not be downloaded.",
  checksum_mismatch: "The update package checksum failed. Download it again.",
});
Object.assign(STRINGS.zh, {
  open_preferred_editor: "🎬 在 MOSE 中打开",
  open_mose: "🎬 在 MOSE 中打开",
  mose_starting: "正在启动 MOSE……",
  mose_started: "MOSE 编辑器已启动",
  mose_fallback: "MOSE 不可用，已回退到 Server 版编辑器。",
  update_open_settings: "检查更新",
  update_available_badge: "有新版本",
  update_view_details: "查看更新",
  settings_updates: "软件更新",
  update_current_version: "当前版本",
  update_latest_version: "最新版本",
  update_release_notes: "更新说明",
  update_check: "检查更新",
  update_checking: "正在检查更新……",
  update_up_to_date: "已是最新版本",
  update_available: "发现新版本 v{version}",
  update_download: "下载更新",
  update_download_new: "下载新版",
  update_switch_installer: "改用安装版",
  update_cancel: "取消下载",
  update_download_progress: "正在下载更新包 {percent}%",
  update_download_ready: "更新包已校验，可以重启安装。",
  update_restart: "重启并安装",
  update_confirm: "MAW 将关闭当前窗口并安装 v{version}，完成后自动重启。确定继续吗？",
  update_open_release: "打开发布页",
  update_manual_only: "当前是便携版，请打开发布页下载新版；安装版支持一键更新。",
  update_no_asset: "当前平台没有可自动安装的资产，请打开发布页手动下载。",
  update_install_success: "已更新到 v{version}。",
  update_install_failed: "上次更新没有完成，可以重新尝试或打开发布页。",
  update_download_failed: "更新下载失败，请重试或打开发布页。",
  update_check_failed: "暂时无法检查更新。",
  update_last_checked: "上次检查：{time}",
  update_channel_beta: "Beta 频道",
  update_channel_stable: "稳定频道",
  update_auto_check: "启动时自动检查（每天一次）",
});
Object.assign(STRINGS.en, {
  open_preferred_editor: "🎬 Open in MOSE",
  open_mose: "🎬 Open in MOSE",
  mose_starting: "Starting MOSE…",
  mose_started: "MOSE editor started",
  mose_fallback: "MOSE is unavailable; opened the Server editor instead.",
  update_open_settings: "Check for updates",
  update_available_badge: "Update available",
  update_view_details: "View update",
  settings_updates: "Software updates",
  update_current_version: "Current version",
  update_latest_version: "Latest version",
  update_release_notes: "Release notes",
  update_check: "Check for updates",
  update_checking: "Checking for updates…",
  update_up_to_date: "You are up to date",
  update_available: "Version v{version} is available",
  update_download: "Download update",
  update_download_new: "Download newer version",
  update_switch_installer: "Switch to installer",
  update_cancel: "Cancel download",
  update_download_progress: "Downloading update package {percent}%",
  update_download_ready: "The update package is verified and ready to install.",
  update_restart: "Restart and install",
  update_confirm: "MAW will close this window, install v{version}, and restart automatically. Continue?",
  update_open_release: "Open release page",
  update_manual_only: "This is a portable copy. Open the release page to download an update; installed copies support one-click updates.",
  update_no_asset: "No automatically installable asset is available for this platform. Open the release page to download it manually.",
  update_install_success: "Updated to v{version}.",
  update_install_failed: "The previous update did not finish. You can retry or open the release page.",
  update_download_failed: "The update download failed. Retry or open the release page.",
  update_check_failed: "Updates could not be checked right now.",
  update_last_checked: "Last checked: {time}",
  update_channel_beta: "Beta channel",
  update_channel_stable: "Stable channel",
  update_auto_check: "Check at startup (once per day)",
});

let updateCheckWaiter = null;

function moseAvailable() { return Boolean(state.config?.moseAvailable); }

async function applyPreferredServerLaunch(result, projectPath, prefix = "") {
  if (!result.ok) {
    applyErrorResult(result);
    return false;
  }
  state.serverRunning = !result.serverAlreadyRunning;
  state.serverProjectPath = state.serverRunning ? projectPath : "";
  state.detectedServerUrl = result.serverAlreadyRunning ? result.url || "" : "";
  $("openMawe").classList.remove("attention");
  renderServerButton();
  if (!result.url) {
    setStatus(prefix || t("ready"));
    return true;
  }
  setServerStatus(result.url, Boolean(result.serverAlreadyRunning), prefix);
  startServerStatusMonitor();
  await bridge("open_url", { url: result.url });
  return true;
}

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
    await applyPreferredServerLaunch(result, projectPath, t("mose_fallback"));
  } finally {
    state.moseStarting = false;
    renderServerButton();
  }
}

function updateCanApply() {
  const update = state.update || {};
  return Boolean(update.available && update.assetAvailable && update.capability === "installer" && update.installation?.canApply);
}
function updateHasManualAsset() {
  const update = state.update || {};
  return Boolean(update.available && update.assetAvailable && !updateCanApply());
}
function updateReleaseUrl() {
  return String(state.update?.releaseUrl || "https://github.com/Moyf/moys-asr-workflow/releases");
}
function formatUpdateTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  try { return new Intl.DateTimeFormat(state.lang, { dateStyle: "short", timeStyle: "short" }).format(new Date(seconds * 1000)); }
  catch (_error) { return new Date(seconds * 1000).toLocaleString(); }
}
function updateChannelText(value) { return value === "beta" ? t("update_channel_beta") : t("update_channel_stable"); }
function releaseLink(url) {
  try {
    const parsed = new URL(String(url || ""), window.location.href);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch (_error) { return ""; }
}
function appendReleaseLink(container, label, url) {
  const safeUrl = releaseLink(url);
  if (!safeUrl) { container.append(document.createTextNode(String(label || ""))); return; }
  const link = document.createElement("a");
  link.className = "update-release-link";
  link.href = safeUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = String(label || safeUrl);
  link.addEventListener("click", (event) => { event.preventDefault(); void bridge("open_url", { url: safeUrl }); });
  container.append(link);
}
function appendReleaseInline(container, value) {
  let rest = String(value || "");
  while (rest) {
    const matches = [];
    const add = (regex, type, priority = 0) => { const match = regex.exec(rest); if (match) matches.push({ match, type, priority }); };
    add(/`([^`\n]+)`/u, "code");
    add(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/iu, "link");
    add(/(\*\*|__)([^\n]+?)\1/u, "strong");
    add(/(~~)([^\n]+?)\1/u, "strike");
    add(/(\*|_)([^\n]+?)\1/u, "emphasis", 1);
    add(/https?:\/\/[^\s<>"'`]+/iu, "url", 2);
    if (!matches.length) { container.append(document.createTextNode(rest)); break; }
    matches.sort((left, right) => (left.match.index ?? 0) - (right.match.index ?? 0) || left.priority - right.priority);
    const chosen = matches[0];
    const match = chosen.match;
    const index = match.index ?? 0;
    if (index > 0) container.append(document.createTextNode(rest.slice(0, index)));
    if (chosen.type === "code") {
      const code = document.createElement("code"); code.textContent = match[1]; container.append(code);
    } else if (chosen.type === "link") {
      appendReleaseLink(container, match[1], match[2]);
    } else if (chosen.type === "url") {
      const raw = match[0]; const url = raw.replace(/[),.;:!?，。；：！？）】》」』]+$/u, "");
      appendReleaseLink(container, url, url); if (raw.length > url.length) container.append(document.createTextNode(raw.slice(url.length)));
    } else {
      const element = document.createElement(chosen.type === "strong" ? "strong" : chosen.type === "strike" ? "del" : "em");
      appendReleaseInline(element, match[2]); container.append(element);
    }
    rest = rest.slice(index + match[0].length);
  }
}
function renderReleaseNotes(container, markdown) {
  if (!container) return;
  container.replaceChildren();
  const lines = String(markdown || "").replace(/\r\n?/gu, "\n").split("\n");
  let paragraph = [];
  let quote = [];
  let list = null;
  let code = null;
  const flushParagraph = () => { if (paragraph.length) { const node = document.createElement("p"); appendReleaseInline(node, paragraph.join(" ").trim()); container.append(node); } paragraph = []; };
  const flushQuote = () => { if (quote.length) { const node = document.createElement("blockquote"); appendReleaseInline(node, quote.join(" ").trim()); container.append(node); } quote = []; };
  const flushList = () => { if (!list) return; const node = document.createElement(list.ordered ? "ol" : "ul"); list.items.forEach((item) => { const row = document.createElement("li"); appendReleaseInline(row, item); node.append(row); }); container.append(node); list = null; };
  const flushCode = () => { if (!code) return; const pre = document.createElement("pre"); const node = document.createElement("code"); if (code.language) node.className = `language-${code.language}`; node.textContent = code.lines.join("\n"); pre.append(node); container.append(pre); code = null; };
  for (const line of lines) {
    if (code) { if (/^\s*```\s*$/u.test(line)) flushCode(); else code.lines.push(line); continue; }
    const fence = /^\s*```\s*([A-Za-z0-9_-]*)\s*$/u.exec(line);
    if (fence) { flushParagraph(); flushQuote(); flushList(); code = { language: fence[1], lines: [] }; continue; }
    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/u.exec(line);
    if (heading) { flushParagraph(); flushQuote(); flushList(); const node = document.createElement(`h${heading[1].length}`); appendReleaseInline(node, heading[2]); container.append(node); continue; }
    const unordered = /^\s*[-+*]\s+(.+)$/u.exec(line); const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (unordered || ordered) { flushParagraph(); flushQuote(); const orderedList = Boolean(ordered); if (!list || list.ordered !== orderedList) { flushList(); list = { ordered: orderedList, items: [] }; } list.items.push((ordered || unordered)[1]); continue; }
    const quoteLine = /^\s*>\s?(.*)$/u.exec(line);
    if (quoteLine) { flushParagraph(); flushList(); quote.push(quoteLine[1]); continue; }
    if (/^\s*(?:---+|\*\*\*+)\s*$/u.test(line)) { flushParagraph(); flushQuote(); flushList(); container.append(document.createElement("hr")); continue; }
    if (!line.trim()) { flushParagraph(); flushQuote(); flushList(); continue; }
    flushQuote(); flushList(); paragraph.push(line.trim());
  }
  if (code) flushCode(); flushParagraph(); flushQuote(); flushList();
}

function renderUpdate() {
  const update = state.update || {};
  const current = String(update.currentVersion || state.config?.appVersion || "").trim();
  const available = Boolean(update.available);
  const canApply = updateCanApply();
  const manualAsset = updateHasManualAsset();
  const status = $("updateSettingsStatus");
  const actionButton = $("updateNow");
  const cancelButton = $("updateCancel");
  const releaseButton = $("updateOpenRelease");
  if (current && $("appVersion")) $("appVersion").textContent = `v${current.replace(/^v/iu, "")}`;
  if ($('updateCurrentVersion')) $('updateCurrentVersion').textContent = current ? `v${current.replace(/^v/iu, "")}` : "—";
  if ($('updateLatestVersion')) $('updateLatestVersion').textContent = update.latestVersion ? `v${String(update.latestVersion).replace(/^v/iu, "")}` : "—";
  if (!status || !actionButton || !cancelButton || !releaseButton) return;
  let statusText = state.updateErrorCode ? errText(state.updateErrorCode, state.updateErrorDetail) : state.updateError;
  if (!statusText && (state.updateChecking || update.checking)) statusText = t("update_checking");
  else if (!statusText && state.updateApplying) statusText = t("update_restart");
  else if (!statusText && update.startup?.status === "success") statusText = t("update_install_success").replace("{version}", update.startup.targetVersion || current);
  else if (!statusText && update.startup?.status === "failed") statusText = t("update_install_failed");
  else if (!statusText && available) { statusText = t("update_available").replace("{version}", update.latestVersion || ""); statusText += update.channel ? ` · ${updateChannelText(update.channel)}` : ""; statusText += !update.assetAvailable ? ` ${t("update_no_asset")}` : !canApply ? ` ${t("update_manual_only")}` : ""; }
  else if (!statusText) statusText = t("update_up_to_date");
  renderMessage(status, statusText);
  const checked = formatUpdateTime(update.lastCheckedAt);
  if ($("updateLastChecked")) $("updateLastChecked").textContent = checked && !state.updateChecking ? t("update_last_checked").replace("{time}", checked) : "";
  if ($("updateReleaseNotes")) { const notes = String(update.releaseNotes || "").trim(); if (notes && available) { renderReleaseNotes($("updateReleaseNotes"), notes.length > 1200 ? `${notes.slice(0, 1200)}…` : notes); $("updateReleaseNotes").classList.remove("hidden"); } else { $("updateReleaseNotes").replaceChildren(); $("updateReleaseNotes").classList.add("hidden"); } }
  $("updateBadge")?.classList.toggle("hidden", !available);
  $("updateNotice")?.classList.toggle("hidden", !available);
  if (available) { $("updateNoticeTitle").textContent = t("update_available").replace("{version}", update.latestVersion || ""); $("updateNoticeMessage").textContent = canApply ? t("update_download") : t("update_manual_only"); }
  const ready = Boolean(state.updateReady && String(update.latestTag || "") === String(state.updateReadyTag || update.latestTag || ""));
  actionButton.classList.toggle("hidden", !canApply && !manualAsset && !ready);
  actionButton.disabled = state.updateDownloading || state.updateApplying || state.updateChecking;
  actionButton.textContent = ready ? t("update_restart") : manualAsset ? t("update_download_new") : t("update_download");
  cancelButton.classList.toggle("hidden", !state.updateDownloading); cancelButton.disabled = state.updateApplying;
  releaseButton.classList.toggle("hidden", !available || !updateReleaseUrl()); releaseButton.textContent = update.installation?.kind === "portable" ? t("update_switch_installer") : t("update_open_release");
  $("checkUpdate").disabled = state.updateChecking || state.updateDownloading || state.updateApplying; $("checkUpdate").textContent = state.updateChecking ? t("update_checking") : t("update_check");
  if ($("autoUpdateCheck")) $("autoUpdateCheck").checked = update.autoCheck !== false;
  const progress = $("updateProgress"); const progressBar = $("updateProgressBar"); const progressMessage = $("updateProgressMessage");
  const showProgress = state.updateDownloading || state.updateReady;
  progress?.classList.toggle("hidden", !showProgress); if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, Number(state.updateProgress || (state.updateReady ? 100 : 0))))}%`;
  if (progressMessage) progressMessage.textContent = state.updateReady ? t("update_download_ready") : state.updateDownloading ? t("update_download_progress").replace("{percent}", String(state.updateProgress || 0)) : "";
}
function setUpdateResult(result, showError = true) {
  if (!result || typeof result !== "object") return;
  const previousTag = String(state.update?.latestTag || "");
  const next = result.update && typeof result.update === "object" ? result.update : result;
  state.update = { ...(state.update || {}), ...next };
  if (!result.checking) state.updateChecking = false;
  if (result.errorCode && showError) { state.updateErrorCode = String(result.errorCode); state.updateErrorDetail = String(result.errorDetail || ""); state.updateError = errText(state.updateErrorCode, state.updateErrorDetail); }
  else if (!showError || result.ok !== false) { state.updateError = ""; state.updateErrorCode = ""; state.updateErrorDetail = ""; }
  if (!result.checking && ((result.available === false) || (result.latestTag && previousTag && String(result.latestTag) !== previousTag))) { state.updateReady = false; state.updateReadyTag = ""; state.updateProgress = 0; }
  renderUpdate();
}
function handleUpdateFailure(result, manual = true) {
  const code = result?.code || result?.errorCode || "update_http_error"; const detail = result?.detail || result?.errorDetail || result?.error || "";
  state.updateChecking = false; if (result?.stage !== "check") { state.updateDownloading = false; state.updateReady = false; state.updateReadyTag = ""; }
  state.updateErrorCode = code; state.updateErrorDetail = detail; state.updateError = errText(code, detail);
  if (!manual) { state.updateError = ""; state.updateErrorCode = ""; state.updateErrorDetail = ""; renderUpdate(); return; }
  renderUpdate(); setStatus(state.updateError); if (detail) appendLog(`[update] ${detail}`);
}
function resolveUpdateCheckWaiter() { const resolve = updateCheckWaiter; updateCheckWaiter = null; if (resolve) resolve(); }
async function openUpdateRelease() { const result = await window.MAWLauncher.callBackend("open_url", { url: updateReleaseUrl() }); if (!result.ok) handleUpdateFailure(result, true); }
async function checkForUpdates(force = true, waitForCompletion = false) {
  let completion = null; if (waitForCompletion) completion = new Promise((resolve) => { updateCheckWaiter = resolve; });
  if (state.updateChecking && !force) { if (completion) await completion; return; }
  const requestId = ++state.updateCheckGeneration; state.updateManualCheck = force; state.updateChecking = true; state.updateError = ""; state.updateErrorCode = ""; state.updateErrorDetail = ""; renderUpdate();
  const result = await window.MAWLauncher.callBackend("check_update", { force, requestId });
  if (requestId !== state.updateCheckGeneration) { resolveUpdateCheckWaiter(); if (completion) await completion; return; }
  if (!result.ok) { handleUpdateFailure(result, force); resolveUpdateCheckWaiter(); if (completion) await completion; return; }
  if (result.checking) { state.update = { ...(state.update || {}), ...result }; renderUpdate(); }
  else { setUpdateResult(result, force); resolveUpdateCheckWaiter(); }
  if (completion) await completion;
}
async function startOrApplyUpdate() {
  const update = state.update || {}; const tag = String(update.latestTag || ""); if (!tag) return;
  if (!updateCanApply() && !state.updateReady) { await openUpdateRelease(); return; }
  if (state.updateReady && !updateCanApply()) { await openUpdateRelease(); return; }
  if (state.updateReady) { const confirmed = await confirmAction(t("update_confirm").replace("{version}", update.latestVersion || "")); if (!confirmed) return; state.updateApplying = true; renderUpdate(); const result = await window.MAWLauncher.callBackend("apply_update", { tag }); if (!result.ok) { state.updateApplying = false; handleUpdateFailure(result, true); } return; }
  state.updateDownloading = true; state.updateProgress = 0; state.updateError = ""; state.updateErrorCode = ""; state.updateErrorDetail = ""; renderUpdate(); const result = await window.MAWLauncher.callBackend("start_update", { tag }); if (!result.ok) handleUpdateFailure(result, true); else renderUpdate();
}
async function cancelUpdateDownload() {
  if (!state.updateDownloading) return; const result = await window.MAWLauncher.callBackend("cancel_update"); if (!result.ok) { handleUpdateFailure(result, true); return; }
  state.updateDownloading = false; state.updateReady = false; state.updateReadyTag = ""; state.updateProgress = 0; state.updateErrorCode = "update_cancelled"; state.updateErrorDetail = ""; state.updateError = errText(state.updateErrorCode, ""); renderUpdate();
}

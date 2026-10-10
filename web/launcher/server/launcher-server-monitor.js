// 编辑器服务器状态监控与轮询，含 appendLog/confirm 桥。

function setServerStatus(url, alreadyRunning = false, prefix = "") {
  const status = $("status");
  status.replaceChildren();
  if (prefix) { renderMessage(status, prefix); status.append(document.createTextNode(" ")); }
  status.append(document.createTextNode(alreadyRunning ? `${t("server_already_running")} ` : `${t("server_address")} `));
  const link = document.createElement("a");
  link.href = url;
  link.textContent = url;
  link.className = "status-link";
  link.addEventListener("click", (event) => { event.preventDefault(); bridge("open_url", { url }); });
  status.append(link);
}
function currentServerPort() { return $("port").value || "8250"; }
function stopServerStatusMonitor() {
  serverStatusMonitorEnabled = false;
  serverStatusMonitorState = "idle";
  serverStatusMonitorFailureCount = 0;
  if (serverStatusMonitorTimer) {
    window.clearTimeout(serverStatusMonitorTimer);
    serverStatusMonitorTimer = 0;
  }
}
function scheduleServerStatusMonitor(delayMs = SERVER_STATUS_MONITOR_INTERVAL_MS) {
  if (!serverStatusMonitorEnabled || serverStatusMonitorTimer) return;
  serverStatusMonitorTimer = window.setTimeout(() => {
    serverStatusMonitorTimer = 0;
    void monitorServerStatus();
  }, Math.max(0, delayMs));
}
function startServerStatusMonitor() {
  serverStatusMonitorEnabled = true;
  serverStatusMonitorState = "connected";
  serverStatusMonitorFailureCount = 0;
  scheduleServerStatusMonitor();
}
function handleServerStatusMonitorHealthy(result) {
  const wasDisconnected = serverStatusMonitorState === "disconnected";
  serverStatusMonitorFailureCount = 0;
  serverStatusMonitorState = "connected";
  if (!wasDisconnected) return;
  serverRestartProjectPath = null;
  state.serverRunning = false;
  state.serverProjectPath = "";
  state.detectedServerUrl = result.url;
  setServerStatus(result.url, true, t("server_reconnected"));
  renderServerButton();
}
function handleServerStatusMonitorFailure() {
  serverStatusMonitorFailureCount += 1;
  if (serverStatusMonitorFailureCount < SERVER_STATUS_MONITOR_FAILURE_THRESHOLD || serverStatusMonitorState === "disconnected") return;
  serverStatusMonitorState = "disconnected";
  const wasActive = Boolean(state.serverRunning || state.detectedServerUrl);
  state.serverRunning = false;
  state.serverProjectPath = "";
  state.detectedServerUrl = "";
  if (wasActive) {
    serverRestartProjectPath = $("jsonPath").value.trim();
    setStatus(t("server_disconnected"));
  }
  renderServerButton();
}
async function monitorServerStatus() {
  if (!serverStatusMonitorEnabled) return;
  if (serverStatusMonitorInFlight) {
    scheduleServerStatusMonitor();
    return;
  }
  const requestId = ++serverStatusRequest;
  const port = currentServerPort();
  serverStatusMonitorInFlight = true;
  let result;
  try {
    const callBackend = window.MAWLauncher?.callBackend || bridge;
    result = await callBackend("get_server_status", serverPayload());
  } catch (_error) {
    result = { ok: false };
  } finally {
    serverStatusMonitorInFlight = false;
  }
  if (!serverStatusMonitorEnabled || requestId !== serverStatusRequest || port !== currentServerPort()) {
    scheduleServerStatusMonitor();
    return;
  }
  if (result?.ok && result.running && result.url) handleServerStatusMonitorHealthy(result);
  else handleServerStatusMonitorFailure();
  scheduleServerStatusMonitor();
}
// latest（顶部黄字）常驻展示最新日志行；quietLatest 供 runtime 安装过程
// 使用——那段时间逐行 [runtime] 输出已在自动滚动的列表与面板进度区出现，
// 黄字再显示同一行会相邻重复。
const appendLog = (text, { inline = false, quietLatest = false } = {}) => { const log = $("log"); const needsSpace = inline && log.textContent && !log.textContent.endsWith("\n"); log.textContent += `${needsSpace ? " " : ""}${text}${inline ? "" : "\n"}`; log.scrollTop = log.scrollHeight; state.lastLogMessage = text; const latest = $("logLatest"); if (quietLatest) { latest.classList.add("hidden"); latest.dataset.inline = "false"; return; } const inlineLatest = inline && latest.dataset.inline === "true"; latest.textContent = inlineLatest ? `${latest.textContent} ${text}` : text; latest.dataset.inline = String(inline); latest.classList.remove("hidden"); };
function confirmAction(message) { $("batchConfirmMessage").textContent = String(message || ""); $("batchConfirmModal").classList.remove("hidden"); $("batchConfirmYes").focus(); return new Promise((resolve) => { window.MAWLauncher.confirmResolve = resolve; }); }
function finishConfirm(value) { const resolve = window.MAWLauncher.confirmResolve; window.MAWLauncher.confirmResolve = null; $("batchConfirmModal").classList.add("hidden"); resolve?.(value); }

// 主题解析/应用与后端桥接（bridge/waitForBackend）、首屏 reveal。

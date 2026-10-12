// 偏好持久化与界面缩放（Ctrl+滚轮/快捷键）。

async function savePrefsNow(payload = {}) { clearTimeout(prefsTimer); const changes = { ...pendingPrefs, ...payload }; pendingPrefs = {}; const result = await bridge("save_prefs", changes); if (!result.ok) applyErrorResult(result); return result; }
function savePrefsDebounced(payload) { pendingPrefs = { ...pendingPrefs, ...payload }; clearTimeout(prefsTimer); prefsTimer = setTimeout(() => { void savePrefsNow(); }, 300); }
function normalizeZoomPercent(value) { const parsed = Number(value); if (!Number.isFinite(parsed)) return ZOOM_DEFAULT; return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(parsed / ZOOM_STEP) * ZOOM_STEP)); }
function applyZoomPercent(value) { const zoomPercent = normalizeZoomPercent(value); document.documentElement.style.zoom = `${zoomPercent}%`; document.documentElement.style.setProperty("--launcher-shell-height", `${100 / (zoomPercent / 100)}dvh`); state.config.zoomPercent = zoomPercent; return zoomPercent; }
function viewportPixelsToPage(value) { return value / (normalizeZoomPercent(state.config?.zoomPercent) / 100); }
function persistZoomPercent(value) { const zoomPercent = applyZoomPercent(value); savePrefsDebounced({ zoomPercent }); }
function handleZoomWheel(event) { if (!event.ctrlKey) return; const direction = Math.sign(event.deltaY); if (!direction) return; event.preventDefault(); const zoomPercent = applyZoomPercent(state.config.zoomPercent - direction * ZOOM_STEP); savePrefsDebounced({ zoomPercent }); }
function handleZoomKeydown(event) {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.target?.closest?.("input, textarea, select, [contenteditable]")) return;
  const direction = event.key === "=" || event.key === "+" ? 1 : (event.key === "-" ? -1 : 0);
  if (!direction && event.key !== "0") return;
  event.preventDefault();
  persistZoomPercent(event.key === "0" ? ZOOM_DEFAULT : state.config.zoomPercent + direction * ZOOM_STEP);
}
async function syncDefaultOutput() { const requestId = ++defaultOutputRequest; const result = await bridge("default_output", { mediaPath: $("mediaPath").value.trim(), providerId: $("provider").value, modelId: $("model").value, testRun: $("testRun").checked }); if (requestId !== defaultOutputRequest) return result; const path = result.ok ? result.path : ""; $("srtPath").placeholder = path; if (state.srtAuto) { $("srtPath").value = path; if (path) setError("srtPath", ""); setOutputNotice(result.renamed ? t("output_collision") : ""); } else setOutputNotice(""); return result; }
function syncFlvHints() {
  $("mediaPathFlvHint")?.classList.toggle("hidden", ext($("mediaPath").value.trim()) !== ".flv");
  $("serverMediaFlvHint")?.classList.toggle("hidden", ext($("serverMediaPath").value.trim()) !== ".flv");
}

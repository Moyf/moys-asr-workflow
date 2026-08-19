(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MEDIA_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v", ".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg"]);
  const state = { mode: "single", running: false, cancelling: false, items: [], nextId: 1, progress: { total: 0, finished: 0, done: 0, failed: 0 } };

  function t(key) {
    return window.MAWLauncher.translate(key);
  }

  function extension(path) {
    return (String(path || "").match(/\.[^.\\/]+$/u)?.[0] || "").toLowerCase();
  }

  function fileName(path) {
    const value = String(path || "");
    return value.split(/[\\/]/u).pop() || value;
  }

  function findItem(event) {
    const nested = event.item && typeof event.item === "object" ? event.item : {};
    const id = String(event.itemId ?? event.id ?? nested.itemId ?? nested.id ?? "");
    const index = Number(event.index ?? nested.index);
    const mediaPath = String(event.mediaPath || event.path || nested.mediaPath || nested.path || "");
    return state.items.find((item) => id && item.id === id)
      || state.items.find((item) => Number.isInteger(index) && item.index === index)
      || state.items.find((item) => mediaPath && item.mediaPath === mediaPath)
      || null;
  }

  function normalizeEvent(event) {
    const type = {
      batch_started: "batchStarted",
      batch_item: "batchItem",
      batch_item_log: "batchItemLog",
      batch_done: "batchDone",
    }[event.type] || event.type;
    return { ...event, type };
  }

  function setItemStatus(item, status, detail = "") {
    const previousStatus = item.status;
    item.status = status || item.status;
    if (detail) item.detail = detail;
    if ((previousStatus === "running" || previousStatus === "queued") && ["done", "failed", "cancelled", "skipped"].includes(item.status)) {
      state.progress.finished += 1;
      if (item.status === "done") state.progress.done += 1;
      if (item.status === "failed") state.progress.failed += 1;
      const index = item.index + 1;
      const name = fileName(item.mediaPath);
      const key = item.status === "done" ? "batch_item_done" : item.status === "failed" ? "batch_item_failed" : "batch_item_cancelled";
      const message = t(key).replace("{index}", String(index)).replace("{name}", name);
      window.MAWLauncher.appendLog?.(message);
    }
    renderQueue();
  }

  function statusLabel(item) {
    const key = {
      queued: "batch_status_queued",
      running: "batch_status_running",
      done: "batch_status_done",
      failed: "batch_status_failed",
      cancelled: "batch_status_cancelled",
      skipped: "batch_status_skipped",
    }[item.status] || "batch_status_queued";
    return t(key);
  }

  function actionButton(labelKey, action, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inline-link";
    button.textContent = t(labelKey);
    button.disabled = disabled;
    button.addEventListener("click", action);
    return button;
  }

  function renderQueue() {
    const queue = $("batchQueue");
    const expandedDetails = new Set(
      [...queue.querySelectorAll(".batch-details[open]")]
        .map((details) => details.closest(".batch-row")?.dataset.itemId)
        .filter(Boolean),
    );
    queue.replaceChildren();
    state.items.forEach((item, index) => {
      item.index = index;
      const row = document.createElement("article");
      row.className = `batch-row ${item.status}`;
      row.dataset.itemId = item.id;
      row.setAttribute("role", "listitem");

      const number = document.createElement("span");
      number.className = "batch-index";
      number.textContent = String(index + 1);

      const body = document.createElement("div");
      body.className = "batch-row-body";
      const heading = document.createElement("div");
      heading.className = "batch-row-heading";
      const name = document.createElement("strong");
      name.className = "batch-file-name";
      name.textContent = fileName(item.mediaPath);
      name.title = item.mediaPath;
      const status = document.createElement("span");
      status.className = `batch-status ${item.status}`;
      status.textContent = statusLabel(item);
      heading.append(name, status);

      const path = document.createElement("span");
      path.className = "batch-path";
      path.textContent = item.mediaPath;
      path.title = item.mediaPath;
      body.append(heading, path);

      if (item.detail || item.logs.length) {
        const details = document.createElement("details");
        details.className = "batch-details";
        const summary = document.createElement("summary");
        summary.textContent = item.status === "failed" ? t("batch_error_details") : t("batch_log_details");
        const log = document.createElement("pre");
        log.textContent = [item.detail, ...item.logs].filter(Boolean).join("\n");
        details.append(summary, log);
        details.open = expandedDetails.has(item.id);
        body.append(details);
      }

      const actions = document.createElement("div");
      actions.className = "batch-row-actions";
      if (item.result?.jsonPath) actions.append(actionButton("batch_open_project", () => window.MAWLauncher.callBackend("open_file", { path: item.result.jsonPath })));
      if (item.result?.srtPath || item.result?.jsonPath) {
        const resultPath = item.result.jsonPath || item.result.srtPath;
        actions.append(actionButton("batch_open_folder", () => window.MAWLauncher.callBackend("open_containing_folder", { path: resultPath })));
      }
      if (!state.running) {
        actions.append(actionButton("batch_remove", () => {
          state.items = state.items.filter((candidate) => candidate.id !== item.id);
          renderQueue();
        }));
      }
      row.append(number, body, actions);
      queue.append(row);
    });
    $("batchEmpty").classList.toggle("hidden", state.items.length > 0);
    $("batchQueueCount").textContent = String(state.items.length);
    $("batchClear").disabled = state.running || state.items.length === 0;
    $("startBatch").disabled = state.running || state.items.length === 0;
  }

  function addPaths(paths) {
    const existing = new Set(state.items.map((item) => item.mediaPath.toLocaleLowerCase()));
    let rejected = 0;
    let duplicate = 0;
    paths.forEach((rawPath) => {
      const mediaPath = String(rawPath || "").trim();
      const key = mediaPath.toLocaleLowerCase();
      if (!mediaPath || !MEDIA_EXTENSIONS.has(extension(mediaPath))) {
        rejected += 1;
        return;
      }
      if (existing.has(key)) {
        duplicate += 1;
        return;
      }
      existing.add(key);
      state.items.push({ id: `batch-${state.nextId}`, index: state.items.length, mediaPath, status: "queued", detail: "", logs: [], result: null });
      state.nextId += 1;
    });
    renderQueue();
    const notices = [];
    if (rejected) notices.push(t("batch_rejected").replace("{count}", String(rejected)));
    if (duplicate) notices.push(`${t("batch_duplicate")}${duplicate > 1 ? ` ×${duplicate}` : ""}`);
    const notice = $("batchDropNotice");
    notice.textContent = notices.join(" ");
    notice.classList.toggle("hidden", notices.length === 0);
  }

  function showDropNotice(message) {
    const notice = $("batchDropNotice");
    notice.textContent = message;
    notice.classList.remove("hidden");
  }

  function lockControls(locked) {
    ["mediaCard", "recognitionCard", "autoPostprocessCard"].forEach((id) => {
      $(id).querySelectorAll("button, input, select, textarea").forEach((control) => {
        control.disabled = locked;
      });
    });
    $("startBatch").classList.toggle("hidden", state.mode !== "batch" || locked);
    $("stopBatch").classList.toggle("hidden", state.mode !== "batch" || !locked);
    $("stopBatch").disabled = state.cancelling;
    $("progress").classList.toggle("hidden", !locked);
    renderQueue();
    // 解锁后恢复模式相关禁用态（如批量模式下的文稿匹配），上面的批量解锁不能覆盖它们。
    if (!locked) window.MAWLauncher.onBatchModeChanged?.(state.mode === "batch");
  }

  function setMode(mode) {
    if (state.running) return;
    state.mode = mode;
    const batch = mode === "batch";
    $("singleMode").classList.toggle("active", !batch);
    $("singleMode").setAttribute("aria-pressed", String(!batch));
    $("batchMode").classList.toggle("active", batch);
    $("batchMode").setAttribute("aria-pressed", String(batch));
    $("singleMediaFields").classList.toggle("hidden", batch);
    $("batchMediaFields").classList.toggle("hidden", !batch);
    $("start").classList.toggle("hidden", batch);
    $("startBatch").classList.toggle("hidden", !batch);
    $("modeHint").textContent = t(batch ? "mode_batch_hint" : "mode_single_hint");
    $("dropZone").textContent = t(batch ? "batch_drop_zone" : "drop_hint");
    $("batchManuscriptNotice").classList.toggle("hidden", !batch);
    window.MAWLauncher.onBatchModeChanged?.(batch);
    renderQueue();
  }

  async function chooseFiles() {
    const result = await window.MAWLauncher.callBackend("choose_file", { kind: "media", multiple: true });
    if (!result.ok) return;
    addPaths(Array.isArray(result.paths) ? result.paths : [result.path]);
  }

  async function startBatch() {
    if (!state.items.length || state.running) return;
    const completed = state.items.filter((item) => item.status === "done");
    let itemsToRun = state.items;
    if (completed.length && await window.MAWLauncher.confirm(t("batch_skip_completed_confirm"))) {
      itemsToRun = state.items.filter((item) => item.status !== "done");
    }
    if (!itemsToRun.length) {
      $("status").textContent = t("batch_complete");
      return;
    }
    itemsToRun.forEach((item) => { item.status = "queued"; item.detail = ""; item.logs = []; item.result = null; });
    state.progress = { total: itemsToRun.length, finished: 0, done: 0, failed: 0 };
    state.running = true;
    state.cancelling = false;
    lockControls(true);
    $("status").textContent = t("batch_starting");
    // 单文件的媒体/输出路径不进批量载荷：每个条目的输出由后端按媒体权威分配。
    const { mediaPath: _singleMediaPath, srtPath: _singleSrtPath, ...settings } = window.MAWLauncher.getTranscriptionPayload();
    settings.generateHtml = false;
    settings.batchSrtOnly = Boolean($("batchSrtOnly")?.checked);
    const items = itemsToRun.map((item) => ({ id: item.id, mediaPath: item.mediaPath }));
    const payload = { items, settings };
    const result = await window.MAWLauncher.callBackend("start_batch_transcription", payload);
    if (!result.ok) {
      state.running = false;
      lockControls(false);
      const detail = result.detail ? `${result.error || t("failed")} ${result.detail}` : (result.error || t("failed"));
      $("status").textContent = detail;
      appendBatchError(detail);
      window.MAWLauncher.onBatchError?.(result);
    }
  }

  function appendBatchError(message) {
    const log = $("log");
    if (log) log.textContent += `[error] ${message}\n`;
  }

  async function stopBatch() {
    if (!state.running || state.cancelling) return;
    state.cancelling = true;
    lockControls(true);
    $("status").textContent = t("batch_stopping");
    const result = await window.MAWLauncher.callBackend("cancel_batch_transcription");
    if (!result.ok) {
      state.cancelling = false;
      lockControls(true);
      $("status").textContent = result.detail || result.error || t("failed");
    }
  }

  function handleBatchEvent(event) {
    event = normalizeEvent(event);
    if (event.type === "batchStarted") {
      state.running = true;
      state.progress.total = Number(event.total) || state.progress.total || state.items.length;
      lockControls(true);
      $("status").textContent = t("batch_progress").replace("{current}", "1").replace("{total}", String(state.progress.total)).replace("{name}", fileName(state.items[0]?.mediaPath));
      window.MAWLauncher.appendLog?.($("status").textContent);
      return;
    }
    if (event.type === "batchItemLog") {
      if (!state.running) return;
      const item = findItem(event);
      if (!item) return;
      const message = String(event.message || event.log || event.item?.message || "");
      if (message) {
        item.logs.push(message);
        window.MAWLauncher.appendLog?.(`[${message}]`, { inline: true });
      }
      renderQueue();
      return;
    }
    if (event.type === "batchItem") {
      if (!state.running) return;
      const item = findItem(event);
      if (!item) return;
      const nested = event.item && typeof event.item === "object" ? event.item : {};
      item.result = event.result || nested.result || ((event.srtPath || event.jsonPath || event.htmlPath) ? { srtPath: event.srtPath || "", jsonPath: event.jsonPath || "", htmlPath: event.htmlPath || "" } : item.result);
      const detail = event.error || event.detail || nested.error || nested.detail || "";
      const nextStatus = event.status || nested.status || (item.result ? "done" : item.status);
      if (nextStatus === "running") {
        $("status").textContent = t("batch_progress").replace("{current}", String(item.index + 1)).replace("{total}", String(state.progress.total)).replace("{name}", fileName(item.mediaPath));
        window.MAWLauncher.appendLog?.($("status").textContent);
      }
      setItemStatus(item, nextStatus, detail);
      return;
    }
    if (event.type === "batchDone") {
      if (!state.running) return;
      const cancelled = Boolean(event.cancelled) || event.status === "cancelled";
      const outcomes = Array.isArray(event.outcomes) ? event.outcomes : [];
      outcomes.forEach((rawOutcome, index) => {
        const outcome = rawOutcome && typeof rawOutcome === "object" ? rawOutcome : {};
        const item = findItem({ ...outcome, index: outcome.index ?? index });
        if (!item) return;
        const result = outcome.result && typeof outcome.result === "object" ? outcome.result : {};
        const srtPath = outcome.srtPath || outcome.srt_path || result.srtPath || result.srt_path || "";
        const jsonPath = outcome.jsonPath || outcome.json_path || outcome.projectPath || outcome.project_path || result.jsonPath || result.json_path || result.projectPath || result.project_path || "";
        const htmlPath = outcome.htmlPath || outcome.html_path || result.htmlPath || result.html_path || "";
        if (srtPath || jsonPath || htmlPath) item.result = { srtPath, jsonPath, htmlPath };
        item.status = outcome.status || item.status;
        item.detail = outcome.error || outcome.detail || item.detail;
      });
      // batchDone 是终态真源：未被 outcomes 覆盖、仍停在 queued/running 的行必须落到终态。
      state.items.forEach((item) => {
        if (item.status !== "queued" && item.status !== "running") return;
        item.status = cancelled ? "cancelled" : "failed";
        if (!cancelled && !item.detail) item.detail = t("batch_outcome_missing");
      });
      state.running = false;
      state.cancelling = false;
      lockControls(false);
      if (!cancelled) {
        state.progress.done = state.items.filter((item) => item.status === "done").length;
        state.progress.failed = state.items.filter((item) => item.status === "failed").length;
        $("status").textContent = t("batch_progress_done").replace("{done}", String(state.progress.done)).replace("{failed}", String(state.progress.failed));
        window.MAWLauncher.appendLog?.($("status").textContent);
      } else {
        $("status").textContent = t("batch_cancelled");
      }
    }
  }

  function handleDrop(event) {
    if (state.mode !== "batch" || state.running) return;
    // pywebview sends the authoritative absolute paths asynchronously through
    // the Python bridge. Do not enqueue browser-only file.name values first,
    // or the later full-path event will be treated as a duplicate.
    if (window.MAWLauncher.backend === "real") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    addPaths(files.map((file) => file.path || file.name));
  }

  function initialize() {
    $("singleMode").addEventListener("click", () => setMode("single"));
    $("batchMode").addEventListener("click", () => setMode("batch"));
    $("batchAddFiles").addEventListener("click", chooseFiles);
    $("batchClear").addEventListener("click", () => { state.items = []; renderQueue(); });
    $("startBatch").addEventListener("click", startBatch);
    $("stopBatch").addEventListener("click", stopBatch);
    $("mediaCard").addEventListener("drop", handleDrop, true);
    window.MAWLauncher.onBatchEvent = handleBatchEvent;
    window.MAWLauncher.onBatchDrop = (path) => {
      if (state.mode !== "batch" || state.running || !path) return false;
      addPaths([path]);
      return true;
    };
    window.MAWLauncher.onBatchDropReject = (path) => {
      if (state.mode !== "batch" || state.running) return false;
      showDropNotice(t("batch_rejected").replace("{count}", "1"));
      return true;
    };
    const previousLanguageChanged = window.MAWLauncher.onLanguageChanged;
    window.MAWLauncher.onLanguageChanged = () => {
      previousLanguageChanged?.();
      setMode(state.mode);
      renderQueue();
    };
    setMode("single");
  }

  window.addEventListener("mawlauncherready", initialize, { once: true });
}());

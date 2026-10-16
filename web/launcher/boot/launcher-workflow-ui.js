// 转写页状态与摘要。结果只显示真实返回的路径 / 统计；不估算费用和百分比。
let launcherWorkflow = null;
function initializeLauncherWorkflow() {
  const $ = (id) => document.getElementById(id);
  let phase = "empty";
  let startedAt = 0;
  let elapsed = 0;
  let lastResult = null;
  let resultMedia = "";
  let footerPage = "transcribe";
  const pageStatusNodes = { transcribe: [], batch: [] };
  const artifacts = [];
  const footer = document.querySelector("#pageTranscribe > .actions");
  const singleScroll = document.querySelector("#pageTranscribe > .shell-scroll");
  const batchScroll = document.querySelector("#pageBatch > .page-scroll");
  $("batchQueueMount").append($("batchMediaFields"));
  $("status").classList.add("workflow-status-detail");
  footer.querySelector(".workflow-footer-status").prepend($("status"));
  footer.querySelector(".workflow-footer-status").append($("progress"));
  const setExpanded = (expanded) => {
    $("recognitionSettingsBody").classList.toggle("hidden", !expanded);
    $("recognitionExpand").setAttribute("aria-expanded", String(expanded));
    $("recognitionExpand").textContent = t(expanded ? "redesign_collapse_settings" : "redesign_expand_settings");
  };
  $("recognitionExpand").addEventListener("click", () => setExpanded($("recognitionSettingsBody").classList.contains("hidden")));
  $("replaceMedia").addEventListener("click", () => $("pickMedia").click());
  $("mediaOpenBatch").addEventListener("click", () => navigateTo("batch"));
  $("dropZone").setAttribute("role", "button");
  $("dropZone").tabIndex = 0;
  $("dropZone").addEventListener("click", () => $("pickMedia").click());
  $("dropZone").addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); $("pickMedia").click(); } });
  $("reviewTranscription").addEventListener("click", async () => {
    if (!lastResult?.jsonPath) return;
    setJsonPath(lastResult.jsonPath);
    await openServerEditor();
  });
  const toggleLog = () => {
    const open = $("logCard").classList.contains("hidden");
    $("logCard").classList.toggle("hidden", !open);
    $("toggleTaskLog").setAttribute("aria-expanded", String(open));
    if (open) $("logCard").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("toggleTaskLog").addEventListener("click", toggleLog);
  $("batchEditSettings").addEventListener("click", () => {
    navigateTo("transcribe"); setExpanded(true); $("recognitionCard").scrollIntoView({ block: "start" });
  });
  $("batchDropZone").addEventListener("click", () => $("batchAddFiles").click());
  $("batchDropZone").addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key)) { event.preventDefault(); $("batchAddFiles").click(); }
  });
  const optionsText = (id) => [...$(id).selectedOptions].map((option) => option.textContent).join(" / ");
  // 胶囊只显示主名：后端 label 的「（备注）」拆到悬浮提示，避免胶囊过长。
  function chipEntry(value) {
    const label = String(value ?? "");
    const match = label.match(/^(.*?)[（(]([^（()]*)[）)]$/u);
    return match && match[1].trim() ? { text: match[1].trim(), title: label } : { text: label };
  }
  function fillSummary(node, entries) {
    node.replaceChildren();
    entries.filter(Boolean).forEach((entry) => {
      const chip = document.createElement("span");
      chip.className = "summary-chip";
      const text = typeof entry === "string" ? entry : entry.text;
      chip.textContent = text;
      if (typeof entry === "object" && entry.title && entry.title !== text) chip.title = entry.title;
      node.append(chip);
    });
  }
  function refresh() {
    if (!state.config) return;
    const current = provider();
    const media = $("mediaPath").value.trim();
    if (lastResult && media !== resultMedia) { lastResult = null; phase = media ? "ready" : "empty"; }
    if (!["running", "done", "failed"].includes(phase)) phase = media ? "ready" : "empty";
    const keyRequired = current.requiresApiKey !== false && !isLocalProvider();
    const keyReady = !keyRequired || Boolean($("apiKey").value.trim() || current.apiKey || current.maskedApiKey);
    let missing = !media ? t("redesign_need_media") : !keyReady ? t("redesign_need_key") : "";
    // 本地运行时 / 模型的瞬态（检查中、部分安装）不禁用开始：
    // validateLocal 会给出精确原因并定位设置项；这里只挡便宜的硬缺口。
    if (!missing && keyRequired && apiKeyFormatInvalid($("apiKey").value.trim())) missing = t("redesign_need_valid_key");
    if (!missing && !$("srtPath").value.trim()) missing = t("redesign_need_output");
    if (!missing && state.audioTrackCount === 0) missing = errText("audio_tracks_missing", "");
    if (isDeepSeekProvider()) missing = t("redesign_choose_asr_provider");
    $("start").disabled = state.running || Boolean(missing);
    const batchPage = window.MAWLauncher.getActivePage() === "batch";
    $("workflowReadiness").textContent = batchPage ? `${t("batch_queue")} · ${$("batchQueueCount").textContent}` : state.running ? t("running") : lastResult ? t("redesign_result_ready") : missing || t("redesign_ready");
    $("workflowStages").classList.toggle("hidden", batchPage || phase !== "running");
    $("transcriptionArtwork").dataset.state = phase;
    const artworkKey = { empty: "redesign_state_empty", ready: "redesign_state_ready", running: "redesign_state_running", done: "redesign_state_done", failed: "redesign_state_failed" }[phase];
    $("transcriptionArtworkLabel").textContent = t(artworkKey);
    $("transcriptionArtwork").setAttribute("aria-label", t(artworkKey));
    $("transcriptionArtwork").classList.toggle("hidden", phase === "ready" || phase === "empty");
    $("singleMediaFields").classList.toggle("hidden", !media && !$("mediaCard").classList.contains("media-fields-visible"));
    $("selectedMediaSummary").classList.toggle("hidden", !media);
    $("selectedMediaName").textContent = baseName(media);
    $("selectedMediaName").title = media;
    $("dropZone").classList.toggle("hidden", Boolean(media));
    $("mediaCard").classList.toggle("media-selected", Boolean(media));
    const summary = [chipEntry(optionsText("provider")), chipEntry(optionsText("model")), `${t("language")}：${optionsText("language") || t("redesign_auto")}`];
    const hotwordCount = splitHotwordEntries($("qwenAudioHotwords").value).length;
    if (current.id === "qwen" && hotwordCount) summary.push(t("redesign_hotwords_count").replace("{count}", String(hotwordCount)));
    if (keyRequired) summary.push(t(keyReady ? "redesign_key_ready" : "redesign_key_missing"));
    fillSummary($("recognitionSummary"), summary);
    fillSummary($("batchRecognitionSummary"), summary);
    $("batchPostprocessSummary").textContent = $("autoPostprocessSummary").textContent;
    setExpanded(!$("recognitionSettingsBody").classList.contains("hidden"));
    $("transcriptionResult").classList.toggle("hidden", !lastResult);
    $("reviewTranscription").classList.toggle("hidden", !lastResult?.jsonPath);
    $("start").textContent = t(lastResult ? "redesign_generate_again" : "start");
    $("start").classList.toggle("primary", !lastResult);
    $("start").classList.toggle("ghost", Boolean(lastResult));
    if (lastResult) renderResult();
  }
  function renderResult() {
    const stats = [];
    if (Number.isInteger(lastResult.segmentCount) && lastResult.segmentCount >= 0) stats.push(t("redesign_segment_count").replace("{count}", String(lastResult.segmentCount)));
    if (elapsed > 0) stats.push(t("redesign_elapsed").replace("{seconds}", String(Math.round(elapsed / 1000))));
    $("transcriptionResultMeta").textContent = stats.join(" · ");
    const files = $("transcriptionResultFiles"); files.replaceChildren();
    ["jsonPath", "srtPath", "translatedSrtPath", "videoPath"].forEach((key) => {
      const path = lastResult[key]; if (!path) return;
      const button = document.createElement("button"); button.type = "button"; button.className = "inline-link result-file";
      button.textContent = baseName(path); button.title = path;
      button.addEventListener("click", () => bridge("open_containing_folder", { path })); files.append(button);
    });
    const chain = $("transcriptionResultChain"); chain.replaceChildren();
    artifacts.forEach((artifact) => {
      const item = document.createElement("span"); item.textContent = t(`auto_step_${artifact.step}`); chain.append(item);
      item.title = [artifact.projectName, artifact.srtName].filter(Boolean).join(" · ");
    });
    chain.classList.toggle("hidden", !artifacts.length);
  }
  function onEvent(event) {
    if (event.type === "done") {
      lastResult = event.result || null; resultMedia = $("mediaPath").value.trim();
      phase = "done"; elapsed = startedAt ? performance.now() - startedAt : 0;
      refresh();
    } else if (event.type === "error" && phase === "running") {
      phase = "failed"; refresh();
    } else if (event.type === "postprocess_pipeline" && phase === "running") {
      $("workflowStages").textContent = `${t("redesign_stage_recognition_done")} › ${t(`auto_step_${event.step}`)}`;
      if (event.stage === "step_done") artifacts.push({ step: event.step, projectName: event.projectName, srtName: event.srtName });
    }
  }
  const route = () => {
    const page = window.MAWLauncher.getActivePage();
    if (!["batch", "transcribe"].includes(page)) return;
    const batch = page === "batch";
    if (page !== footerPage) {
      // 两个任务页共享控件，但不能把单文件的「已完成」误显示为批量状态。
      pageStatusNodes[footerPage] = [...$("status").childNodes];
      if (pageStatusNodes[page].length) $("status").replaceChildren(...pageStatusNodes[page]);
      else renderMessage($("status"), t(batch ? "mode_batch_hint" : "ready"));
      footerPage = page;
    }
    $(batch ? "pageBatch" : "pageTranscribe").append(footer);
    const host = batch ? $("batchFeedbackMount") : singleScroll;
    host.append($("logCard"), $("errorNotice"));
    document.body.classList.toggle("batch-page-active", batch);
    refresh();
  };
  window.addEventListener("mawpagechange", route);
  document.addEventListener("input", () => requestAnimationFrame(refresh));
  document.addEventListener("change", () => requestAnimationFrame(refresh));
  new MutationObserver(() => refresh()).observe($("autoPostprocessSummary"), { childList: true, characterData: true, subtree: true });
  new MutationObserver(refresh).observe($("batchQueueCount"), { childList: true, characterData: true, subtree: true });
  ["localModelStatus", "localRuntimeCheckStatus"].forEach((id) => {
    if ($(id)) new MutationObserver(refresh).observe($(id), { childList: true, characterData: true, subtree: true });
  });
  const oldLanguageChanged = window.MAWLauncher.onLanguageChanged;
  window.MAWLauncher.onLanguageChanged = () => { oldLanguageChanged?.(); refresh(); };
  launcherWorkflow = {
    refresh, onEvent, expandRecognition: () => setExpanded(true),
    revealMediaFields() { $("mediaCard").classList.add("media-fields-visible"); $("singleMediaFields").classList.remove("hidden"); },
    setRunning(running) {
      if (running) { startedAt = performance.now(); phase = "running"; lastResult = null; artifacts.length = 0; $("workflowStages").textContent = t("redesign_stage_recognition"); }
      refresh();
    },
  };
  route();
  document.body.dataset.workflowReady = "true";
}

// 拖放绑定与服务器媒体/FFmpeg 刷新。

function hasFileDrag(event) { return !event.dataTransfer || Array.from(event.dataTransfer.types || []).includes("Files"); }
function setDropHighlight(active) { $("mediaCard").classList.toggle("drag-over", active); }
function isInsideMediaCard(node) { return node instanceof Node && $("mediaCard").contains(node); }
function onDragEnter(event) { if (!hasFileDrag(event) || !isInsideMediaCard(event.target)) return; event.preventDefault(); if (isInsideMediaCard(event.relatedTarget)) return; dragState.depth += 1; setDropHighlight(true); }
function onDragLeave(event) { if (!isInsideMediaCard(event.target)) return; if (isInsideMediaCard(event.relatedTarget)) return; dragState.depth = Math.max(0, dragState.depth - 1); if (dragState.depth === 0) setDropHighlight(false); }
function bindDropField(id, target, controlId) { const field = $(id); const control = $(controlId || id); field.addEventListener("dragenter", (event) => { if (!hasFileDrag(event) || control.getAttribute("aria-disabled") === "true") return; event.preventDefault(); state.dropTarget = target; control.classList.add("drag-over"); }); field.addEventListener("dragover", (event) => { if (!hasFileDrag(event) || control.getAttribute("aria-disabled") === "true") return; event.preventDefault(); state.dropTarget = target; control.classList.add("drag-over"); }); field.addEventListener("dragleave", (event) => { if (!field.contains(event.relatedTarget)) { control.classList.remove("drag-over"); if (state.dropTarget === target) state.dropTarget = ""; } }); }
function handleRoutedDrop(path) {
  const target = state.dropTarget;
  clearDropState();
  if (target === "toolboxUtilityMedia" && $("toolboxUtilityMediaPath").disabled) return;
  const value = String(path || "").trim();
  const suffix = ext(value);
  if (target === "media") {
    if (MEDIA_EXTS.has(suffix)) {
      setMedia(value, { refreshOcrVideo: true });
      setStatus(t("media"));
    } else setError("mediaPath", mediaDropError());
    return;
  }
  if (target === "serverMedia") {
    if (MEDIA_EXTS.has(suffix)) setServerMedia(value);
    else setError("serverMediaPath", mediaDropError());
    return;
  }
  const pathTargets = {
    localModelCache: ["localModelCachePath", "change"],
    localModel: ["localModelPath", "input"],
    localRuntime: ["localRuntimePath", "change"],
    ocrRuntime: ["ocrRuntimePath", "change"],
    ffmpeg: ["ffmpegPath", "input"],
    stickerDir: ["stickerDir", "change"],
  };
  const pathTarget = pathTargets[target];
  if (pathTarget) {
    setDroppedPath(pathTarget[0], value, pathTarget[1]);
    return;
  }
  if (target === "toolboxInput") {
    if (PROJECT_EXTS.has(suffix) || suffix === ".srt") setDroppedPath("toolboxInputPath", value);
    else setError("toolboxInputPath", t("toolbox_drop_reject"));
    return;
  }
  if (target === "toolboxUtilityMedia") {
    if (MEDIA_EXTS.has(suffix)) setDroppedPath("toolboxUtilityMediaPath", value);
    else setError("toolboxUtilityMediaPath", t("toolbox_utility_media_reject"));
    return;
  }
  if (target === "toolboxTimestampMedia") {
    if (MEDIA_EXTS.has(suffix)) setDroppedPath("toolboxTimestampMediaPath", value);
    else setError("toolboxTimestampMediaPath", t("toolbox_timestamp_media_reject"));
    return;
  }
  if (target === "toolboxBurnSubtitle") {
    if (SUBTITLE_BURN_EXTS.has(suffix)) setDroppedPath("toolboxBurnSubtitlePath", value);
    else setError("toolboxBurnSubtitlePath", t("toolbox_burn_subtitle_invalid"));
    return;
  }
  if (target === "toolboxFfconcat") {
    if (suffix === ".ffconcat") setDroppedPath("postprocessFfconcatPath", value);
    else setError("postprocessFfconcatPath", t("toolbox_ffconcat_reject"));
    return;
  }
  if (target === "toolboxAlignmentProject") {
    if (PROJECT_EXTS.has(suffix)) setDroppedPath("toolboxAlignmentProjectPath", value);
    else setError("toolboxAlignmentProjectPath", t("toolbox_alignment_project_invalid"));
    return;
  }
  if (target === "toolboxAlignmentScript") {
    if (SCRIPT_EXTS.has(suffix)) setDroppedPath("toolboxAlignmentScriptPath", value);
    else setError("toolboxAlignmentScriptPath", t("toolbox_alignment_script_missing"));
    return;
  }
  if (target === "ocrVideo") {
    if (VIDEO_EXTS.has(suffix)) setDroppedPath("ocrVideoPath", value);
    else setError("ocrVideoPath", t("toolbox_ocr_video_reject"));
    return;
  }
  if (target === "script") {
    if (SCRIPT_EXTS.has(suffix)) setDroppedPath("postprocessScriptPath", value);
    else setError("postprocessScriptPath", t("toolbox_script_reject"));
    return;
  }
  if (target === "json") {
    if (PROJECT_EXTS.has(suffix)) {
      setJsonPath(value);
      setStatus(t("json_project"));
    } else setError("jsonPath", t("drop_reject_json"));
    return;
  }
  if (target === "text" || target === "file") {
    if (suffix === ".txt") void loadHotwordFile(value, target === "text");
    else setError(target === "text" ? "qwenAudioHotwords" : "qwenAudioHotwordsFile", t("drop_reject_txt"));
    return;
  }
  if (PROJECT_EXTS.has(suffix)) {
    setJsonPath(value);
    setStatus(t("json_project"));
    return;
  }
  if (suffix === ".txt") {
    void loadHotwordFile(value, false);
    return;
  }
  if (MEDIA_EXTS.has(suffix)) {
    setMedia(value, { refreshOcrVideo: true });
    setStatus(t("media"));
    return;
  }
  setError("mediaPath", mediaDropError());
}
async function refreshServerMedia() { const jsonPath = $("jsonPath").value.trim(); const result = await bridge("check_server_media", { jsonPath }); state.serverMediaOk = Boolean(result.hasMedia && result.mediaExists); $("serverMediaField").classList.toggle("hidden", state.serverMediaOk || !jsonPath); return result; }
async function refreshFfmpeg() { const requestId = ++ffmpegRequest; const result = await bridge("check_ffmpeg"); if (requestId !== ffmpegRequest) return result; $("modalFfmpegFound").classList.toggle("hidden", !result.found); $("modalFfmpegMissing").classList.toggle("hidden", Boolean(result.found)); $("ffmpegPathBox").classList.toggle("hidden", Boolean(result.found)); $("settingsDot").classList.toggle("hidden", Boolean(result.found)); $("modalFfmpegFound").title = result.directory || ""; $("ffmpegDir").textContent = result.directory || ""; return result; }
function ffmpegSaveError(result) { if (result.code) return errText(result.code, result.detail || result.error); if (result.found === false) return t("ffmpeg_missing"); return compactDetail(result.error) || t("failed"); }

// 设置面板导航与启动状态刷新、init 入口。

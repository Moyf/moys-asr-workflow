

// 导出文件名前缀会随媒体切换变化；ASS 的 Title 必须跟随当前工程文件名，
// 因此单独保留工程名，避免加载媒体或导入字幕时把 Title 改成媒体名。


  // 表情包根目录的绝对路径（无尾斜杠）




// 所有非模态浮层共用一个前置栈：最后点击、打开或获得焦点的浮层排在最上面。
// 起始值高于普通设置弹窗（420），但低于右键菜单（480）、hint（490）、
// 拖拽遮罩和加载层（500/510）。


















window.addEventListener('error', (event) => {
  const details = {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    stack: event.error?.stack || null,
  };
  window.MAWE_DEBUG_ERRORS = [...(window.MAWE_DEBUG_ERRORS || []), details];
  console.error('[MAWE][runtime] uncaught error', details);
});
window.addEventListener('unhandledrejection', (event) => {
  window.MAWE_DEBUG_ERRORS = [...(window.MAWE_DEBUG_ERRORS || []), {
    message: String(event.reason), stack: event.reason?.stack || null,
  }];
  console.error('[MAWE][runtime] unhandled rejection', event.reason);
});
if (!window.AsrEditorUtils) {
  console.error('[MAWE][boot] AsrEditorUtils is unavailable; editor scripts are incomplete or out of order');
}

const MULTI_SUBTITLE_UTILS = window.AsrEditorUtils;
const EDITOR_SETTINGS_UTILS = window.AsrEditorUtils;



// 拆分时「下刀时间 vs 实际切分边界」允许的最大偏差：超过说明字幕文本与
// 词时间戳已脱钩、切点落在了错误的词边界附近，此时提示而不是静默出错。
const SPLIT_ALIGNMENT_DRIFT_WARN_MS = 500;



MaweBoot.maweDomContractCheck();







function getOverlayTrack() {
  MaweMultiSubtitleCore.getMultiSubtitleState();
  return MaweBoot.DATA.overlay_track;
}

function overlayTrackVisible() {
  const track = getOverlayTrack();
  return track?.enabled === true && Array.isArray(track.segments) && track.segments.length > 0;
}

// === 主轨 ↔ 叠加轨 段落迁移 ===
// 两条轨道互不绑定；迁移保持目标轨按 start 升序（同 start 插到既有段之后），
// 返回段在目标轨中的新下标，失败返回 -1。数组操作委托给 editor-utils 纯函数。
function moveSegmentToOverlayTrack(index) {
  const segment = MaweBoot.DATA.segments[index];
  const overlay = getOverlayTrack();
  if (!segment || !overlay || !Array.isArray(overlay.segments)) return -1;
  const newIndex = MULTI_SUBTITLE_UTILS.moveSegmentBetweenTracks(MaweBoot.DATA.segments, overlay.segments, index);
  if (newIndex < 0) return -1;
  overlay.enabled = true;
  overlay._dirty = true;
  segment._dirty = true;
  return newIndex;
}

function moveOverlaySegmentToMainTrack(index) {
  const overlay = getOverlayTrack();
  const segment = overlay?.segments?.[index];
  if (!segment || !Array.isArray(MaweBoot.DATA.segments)) return -1;
  const newIndex = MULTI_SUBTITLE_UTILS.moveSegmentBetweenTracks(overlay.segments, MaweBoot.DATA.segments, index);
  if (newIndex < 0) return -1;
  overlay._dirty = true;
  segment._dirty = true;
  return newIndex;
}

function shiftMainGroupRefsAfterMove(movedIndexes) {
  const removeSet = new Set(movedIndexes);
  // 迁移对主轨组关系的影响与删除一致：先按切点拆组（清掉被迁移段的 head/ref），
  // 再把剩余 ref 的 headIdx 前移，最后断开仍指向被迁移下标的残余 ref。
  MaweSegmentOps.splitGroupsAtCutPoints(removeSet, 'sticker', 'sticker_ref');
  MaweSegmentOps.splitGroupsAtCutPoints(removeSet, 'color', 'color_ref');
  // 被迁移段若曾绑定副字幕，绑定一并解除（叠加轨不参与主副绑定）。
  const movedIds = [...removeSet].map((index) => MaweBoot.DATA.segments[index]?.id).filter(Boolean);
  if (movedIds.length) {
    MaweMultiSubtitleCore.removeBindingsForSegmentIds(movedIds, []);
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
  }
  const shiftHeadIdx = (ref) => {
    let shift = 0;
    for (const index of movedIndexes) { if (index < ref.headIdx) shift += 1; else break; }
    if (shift) ref.headIdx -= shift;
  };
  MaweBoot.DATA.segments.forEach((segment) => {
    if (segment.sticker_ref) {
      // 兜底判定必须用迁移前的原始 headIdx：先平移再判定会把「平移后恰好
      // 撞上已迁移下标」的合法引用（如 head@5、迁移 [1,3] → 3）误清掉。
      if (removeSet.has(segment.sticker_ref.headIdx)) segment.sticker_ref = null;
      else shiftHeadIdx(segment.sticker_ref);
    }
    if (segment.color_ref) {
      if (removeSet.has(segment.color_ref.headIdx)) segment.color_ref = null;
      else shiftHeadIdx(segment.color_ref);
    }
  });
}

// 回轨方向：主轨在 insertAt 处插入一段后，其后所有 *_ref.headIdx 需 +1，
// 否则组引用会指到错误的段（保存校验报 "must point to a color head"）。
function shiftMainGroupRefsAfterInsert(insertAt) {
  MaweBoot.DATA.segments.forEach((segment) => {
    if (segment.sticker_ref && segment.sticker_ref.headIdx >= insertAt) segment.sticker_ref.headIdx += 1;
    if (segment.color_ref && segment.color_ref.headIdx >= insertAt) segment.color_ref.headIdx += 1;
  });
}

function resetOverlayGroupRefs(index) {
  // 叠加轨的 ref 只引用叠加轨自身段；一条段离开后断开指向它的 ref 并前移 headIdx。
  const overlay = getOverlayTrack();
  (overlay?.segments || []).forEach((segment) => {
    if (segment.sticker_ref?.headIdx === index) segment.sticker_ref = null;
    if (segment.color_ref?.headIdx === index) segment.color_ref = null;
    if (segment.sticker_ref && segment.sticker_ref.headIdx > index) segment.sticker_ref.headIdx -= 1;
    if (segment.color_ref && segment.color_ref.headIdx > index) segment.color_ref.headIdx -= 1;
  });
}

function detachCuePanelFromTrackEdits() {
  MaweCuePanel.commitCuePanelEdit();
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState();
}

// === 迁移字幕的颜色继承 ===
// 主轨 ↔ 叠加轨互转时颜色标记跟着走：head 保留原色值，ref 物化为自持
// head（start/end 取段自身范围，与 syncTimelineGroupRanges 对无组员 head 的
// 语义一致）。叠加轨的 color_ref 只引用叠加轨自身段，因此迁移后的颜色
// 一律以「单段 head」形式存在，不产生跨轨引用。
function captureCueColorSnapshot(segment) {
  if (!segment) return null;
  if (segment.color?.name) return { name: segment.color.name, value: segment.color.value ?? null };
  if (segment.color_ref?.name) return { name: segment.color_ref.name, value: null };
  return null;
}

function applyCueColorSnapshot(segment, snapshot) {
  if (!segment || !snapshot?.name) return false;
  segment.color_ref = null;
  segment.color = {
    name: snapshot.name,
    value: snapshot.value || MaweColors.colorValue(snapshot.name),
    start: segment.start,
    end: segment.end,
  };
  return true;
}

// 表情包继承：与颜色同理。ref 迁移时需要 head 的完整素材数据（文件名、
// 尺寸等），因此快照按所在轨数组解析并深拷贝；应用时物化为自持 head，
// 时间范围改写为段自身范围，避免跨轨引用。
function captureCueStickerSnapshot(segments, index) {
  const segment = segments?.[index];
  if (!segment) return null;
  if (segment.sticker) return JSON.parse(JSON.stringify(segment.sticker));
  const head = segments[segment.sticker_ref?.headIdx];
  return head?.sticker ? JSON.parse(JSON.stringify(head.sticker)) : null;
}

function applyCueStickerSnapshot(segment, snapshot) {
  if (!segment || !snapshot) return false;
  segment.sticker_ref = null;
  segment.sticker = { ...snapshot, start: segment.start, end: segment.end };
  return true;
}

// 拖动换轨入口专用的面板分离：不走 commitCuePanelEdit——它会把段钳回
// 主轨非重叠区间（previousEnd/nextStart 夹逼），与 Shift+拖动「故意重叠」
// 的换轨意图冲突；文字编辑已在 input 事件实时写入段，这里只清空面板。
function detachCuePanelDuringDrag() {
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState();
  MaweCuePanel.renderCurrentCuePanel();
}

// 菜单入口：把选中的主轨字幕转为叠加字幕。返回成功迁移的数量。
function convertMainCuesToOverlay(idxs, { label = '转为叠加字幕', pushHistory = true, silent = false } = {}) {
  const targets = [...new Set(Array.isArray(idxs) ? idxs : [])]
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < MaweBoot.DATA.segments.length)
    .sort((a, b) => a - b);
  if (!targets.length) return 0;
  detachCuePanelFromTrackEdits();
  if (pushHistory) MaweHistory.pushUndo(label);
  // 迁移前快照颜色与表情包：splitGroupsAtCutPoints 会把切点的
  // color/color_ref/sticker/sticker_ref 清空，迁移后按快照物化回段上。
  const colorSnapshots = new Map(targets.map((index) => [index, {
    segment: MaweBoot.DATA.segments[index],
    color: captureCueColorSnapshot(MaweBoot.DATA.segments[index]),
    sticker: captureCueStickerSnapshot(MaweBoot.DATA.segments, index),
  }]));
  shiftMainGroupRefsAfterMove(targets);
  let converted = 0;
  // 倒序迁移：主轨下标在移除后仍然稳定。
  for (let position = targets.length - 1; position >= 0; position -= 1) {
    const targetIndex = targets[position];
    const newIndex = moveSegmentToOverlayTrack(targetIndex);
    if (newIndex < 0) continue;
    const { segment, color, sticker } = colorSnapshots.get(targetIndex);
    applyCueColorSnapshot(segment, color);
    applyCueStickerSnapshot(segment, sticker);
    converted += 1;
  }
  if (!converted) return 0;
  MaweSelection.clearSelection({ silent: true });
  MawePlaybackLoop.lastActive = -1;
  if (!silent) {
    MaweCuePanel.renderAll({ waveform: 'full' });
    MaweServerSave.scheduleAutoSaveFlush();
    MaweHint.flashHint(`已转为叠加字幕 ${converted} 条`, 'success');
  }
  return converted;
}

// 拖动逃逸入口：单条迁移，不推送历史（拖动开始时已推）、不渲染（拖动中由
// 波形自刷新，列表在 onCommitEdit 的 renderAll 里更新）。返回新叠加轨下标。
// 迁移后主轨下标整体前移：同步主轨选中集与 Shift 锚点，避免选中状态落到
// 后面的字幕上；被迁移字幕保持选中（转入叠加轨选中集与字幕面板）。
function convertMainCueToOverlayForDrag(index) {
  if (!Number.isInteger(index) || index < 0 || index >= MaweBoot.DATA.segments.length) return -1;
  const panelWasHere = MaweCuePanelState.currentCuePanelKind === 'main' && MaweCuePanelState.currentCuePanelIdx === index;
  detachCuePanelDuringDrag();
  const segment = MaweBoot.DATA.segments[index];
  const colorSnapshot = captureCueColorSnapshot(segment);
  const stickerSnapshot = captureCueStickerSnapshot(MaweBoot.DATA.segments, index);
  shiftMainGroupRefsAfterMove([index]);
  const newIndex = moveSegmentToOverlayTrack(index);
  if (newIndex < 0) return -1;
  applyCueColorSnapshot(segment, colorSnapshot);
  applyCueStickerSnapshot(segment, stickerSnapshot);
  const { wasSelected, nextAnchor } = window.AsrEditorUtils.shiftSelectionAfterRemoval(
    MaweSelection.selectedIdxs, MaweSelection.lastClickedIdx, index,
  );
  MaweSelection.lastClickedIdx = nextAnchor;
  updateSelectionCountText();
  if (panelWasHere) MaweCuePanel.setCuePanelTarget('overlay', newIndex);
  if (wasSelected) {
    selectedOverlayIdxs.add(newIndex);
    lastClickedOverlayIdx = newIndex;
  }
  return newIndex;
}

// 拖动往返入口：把叠加轨字幕移回主轨（不推历史、不渲染——拖动的
// 单次撤销在 onBeginEdit 已建立，列表在 onCommitEdit 的 renderAll 更新）。
// 返回段在主轨中的新下标。选择同步逻辑与主转叠加的拖动入口对称。
function convertOverlayCueToMainForDrag(index) {
  const overlay = getOverlayTrack();
  if (!overlay?.segments?.[index]) return -1;
  const panelWasHere = MaweCuePanelState.currentCuePanelKind === 'overlay' && MaweCuePanelState.currentCuePanelIdx === index;
  // 与主转叠加的拖动入口同理：面板提交会把段钳回轨道非重叠区间，
  // 冲突换轨意图；只清空面板目标，不提交任何时间。
  detachCuePanelDuringDrag();
  const segment = overlay.segments[index];
  const colorSnapshot = captureCueColorSnapshot(segment);
  const stickerSnapshot = captureCueStickerSnapshot(overlay.segments, index);
  // 剩下的叠加轨组员按主轨同款「组拆分」语义提升新 head，然后迁移段
  // 物化自持颜色/表情回到主轨（split 依赖迁移前下标，必须在 splice 前调用）。
  MaweSegmentOps.splitGroupsAtCutPoints(new Set([index]), 'color', 'color_ref', overlay.segments);
  MaweSegmentOps.splitGroupsAtCutPoints(new Set([index]), 'sticker', 'sticker_ref', overlay.segments);
  resetOverlayGroupRefs(index);
  const newIndex = moveOverlaySegmentToMainTrack(index);
  if (newIndex < 0) return -1;
  applyCueColorSnapshot(segment, colorSnapshot);
  applyCueStickerSnapshot(segment, stickerSnapshot);
  shiftMainGroupRefsAfterInsert(newIndex);
  const { wasSelected, nextAnchor } = window.AsrEditorUtils.shiftSelectionAfterRemoval(
    selectedOverlayIdxs, lastClickedOverlayIdx, index,
  );
  lastClickedOverlayIdx = nextAnchor;
  updateSelectionCountText();
  if (panelWasHere) MaweCuePanel.setCuePanelTarget('main', newIndex);
  if (wasSelected && !MaweSelection.isHiddenDisabled(newIndex)) {
    MaweSelection.addMainIndexToSelection(newIndex);
    MaweSelection.lastClickedIdx = newIndex;
  }
  return newIndex;
}

function convertOverlayCueToMain(index) {
  const overlay = getOverlayTrack();
  if (!overlay?.segments?.[index]) return false;
  detachCuePanelFromTrackEdits();
  MaweHistory.pushUndo('叠加字幕转为主字幕');
  const segment = overlay.segments[index];
  const colorSnapshot = captureCueColorSnapshot(segment);
  const stickerSnapshot = captureCueStickerSnapshot(overlay.segments, index);
  // 与拖动入口一致：剩余组员先提升新 head，迁移段物化自持颜色/表情。
  MaweSegmentOps.splitGroupsAtCutPoints(new Set([index]), 'color', 'color_ref', overlay.segments);
  MaweSegmentOps.splitGroupsAtCutPoints(new Set([index]), 'sticker', 'sticker_ref', overlay.segments);
  resetOverlayGroupRefs(index);
  const newIndex = moveOverlaySegmentToMainTrack(index);
  if (newIndex < 0) return false;
  applyCueColorSnapshot(segment, colorSnapshot);
  applyCueStickerSnapshot(segment, stickerSnapshot);
  shiftMainGroupRefsAfterInsert(newIndex);
  lastClickedOverlayIdx = window.AsrEditorUtils.shiftSelectionAfterRemoval(
    selectedOverlayIdxs, lastClickedOverlayIdx, index,
  ).nextAnchor;
  MaweCuePanel.renderAll({ waveform: 'full' });
  MaweServerSave.scheduleAutoSaveFlush();
  MaweHint.flashHint('已转为主字幕', 'success');
  return true;
}

function deleteOverlayCues(indices) {
  const overlay = getOverlayTrack();
  const sorted = [...new Set(Array.isArray(indices) ? indices : [])]
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < (overlay?.segments?.length || 0))
    .sort((a, b) => a - b);
  if (!sorted.length) return;
  detachCuePanelFromTrackEdits();
  MaweHistory.pushUndo(`删除 ${sorted.length} 条叠加字幕`);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    resetOverlayGroupRefs(sorted[index]);
    overlay.segments.splice(sorted[index], 1);
  }
  selectedOverlayIdxs.clear();
  lastClickedOverlayIdx = -1;
  overlay._dirty = true;
  MaweCuePanel.renderAll({ waveform: 'full' });
  MaweServerSave.scheduleAutoSaveFlush();
  MaweHint.flashHint(`已删除 ${sorted.length} 条叠加字幕`, 'success');
}







// 多重字幕关闭时轨道数据仍保留在工程里，但副字幕不参与 ASS 预览与导出；
// 与 multiSubtitleVisible() 的开合语义保持一致。
function activeExtensionSegments() {
  if (MaweMultiSubtitleCore.getMultiSubtitleState().enabled !== true) return [];
  return MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || [];
}










// 合并多条字幕时按「字符型/单词型」取对应连接符：中文直接拼接，西文默认空格。


















































// 主字幕驱动副字幕时，目标范围优先；其它副字幕会被裁剪到目标范围之外，
// 完全被覆盖或无法保留最短时长的字幕会被删除。主字幕时间始终不反向改变。










MaweMultiSubtitleCore.normalizeMultiSubtitleState();

















// 原生 number 输入框以 min=10、step=100 计算大于 100 的向下步进时，
// 会把 200 算成 110。把这个浏览器步进结果还原为用户看到的 100ms 档位，
// 同时保留 100ms 向下 90ms、向上 200ms 的边界行为。















// CSS 预览的颜色样式（工程 color_style）；ASS 的颜色映射是独立字段
// ass_color_style（text / speaker / stroke / none），两者语义不同。


const ASS_COLOR_STYLE_VALUES = Object.freeze(['text', 'speaker', 'stroke', 'none']);
const DEFAULT_ASS_COLOR_STYLE = 'text';
// 字体输入框用 combobox 下拉提供筛选（映射逻辑在 editor-utils 的
// subtitleFontFamilyStoredToInput / subtitleFontFamilyInputToStored）；
// 扫描到的本机字体会由下拉列表动态合并，无需预设常量参与启动期渲染。
const ASS_BUILTIN_FONT_SUGGESTIONS = Object.freeze([
  'Arial', 'Microsoft YaHei', 'SimHei', 'SimSun', 'Segoe UI', 'Verdana', 'Times New Roman',
]);



























const ASS_STYLE_LIBRARY_STORAGE_KEY = 'moy.asr.ass.styles.v1';
let ASS_STYLE_LIBRARY = window.AsrEditorUtils.defaultAssStyleLibrary();
let ASS_STYLE_LIBRARY_READY = false;
let assStyleLibrarySaveTimer = 0;
let assStyleLibraryLoadPromise = null;
let assStyleLibraryDirty = false;
let assStyleLibraryRevision = 0;
let assStyleLibrarySaveInFlight = false;
let assStyleLibraryInFlightRevision = 0;

function readLocalAssStyleLibrary() {
  try {
    return window.AsrEditorUtils.normalizeAssStyleLibrary(
      JSON.parse(localStorage.getItem(ASS_STYLE_LIBRARY_STORAGE_KEY) || 'null'),
    );
  } catch (_) {
    return window.AsrEditorUtils.defaultAssStyleLibrary();
  }
}

function writeLocalAssStyleLibrary(library) {
  try {
    localStorage.setItem(
      ASS_STYLE_LIBRARY_STORAGE_KEY,
      JSON.stringify(window.AsrEditorUtils.normalizeAssStyleLibrary(library)),
    );
  } catch (_) {
    // file:// 隐私模式可能拒绝 localStorage；当前页面仍可继续使用样式。
  }
}

function setAssStyleLibrary(value, { persistLocal = false } = {}) {
  ASS_STYLE_LIBRARY = window.AsrEditorUtils.normalizeAssStyleLibrary(value);
  if (persistLocal) writeLocalAssStyleLibrary(ASS_STYLE_LIBRARY);
  return ASS_STYLE_LIBRARY;
}

function assStyleLibrarySummary() {
  return `${ASS_STYLE_LIBRARY.styles.length} 个样式 · ${ASS_STYLE_LIBRARY.assProfiles.length} 个 ASS 方案`;
}

function updateAssStyleLibrarySummary() {
  if (assStyleSummary) {
    const summary = assStyleLibrarySummary();
    assStyleSummary.textContent = window.MAWE_I18N?.translateText?.(summary) || summary;
  }
}

function scheduleAssStyleLibrarySave() {
  assStyleLibraryDirty = true;
  clearTimeout(assStyleLibrarySaveTimer);
  assStyleLibrarySaveTimer = setTimeout(() => {
    void persistAssStyleLibrary();
  }, 220);
}

function assStyleLibraryRequestBody(normalized) {
  // 与其他本机写入接口一致：服务器会校验页面请求令牌，缺失时返回 403。
  return { ...normalized, requestToken: MaweBoot.SERVER_CONFIG?.requestToken || '' };
}

function assStyleLibraryPostOptions(body, { keepalive = false } = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(assStyleLibraryRequestBody(body)),
    ...(keepalive ? { keepalive: true } : {}),
  };
}

// 离开页面（刷新/关闭/跳转、切后台）时 debounce 定时器可能还没触发；
// dirty 的最后改动要用 keepalive 请求立刻发出，否则重新打开时会
// 被服务器上的旧样式覆盖。已有请求在途且携带同一修订时无需重复发送；
// 在途请求携带更旧修订时仍要 flush，但不清除 dirty，页面回来后再补一次
// 常规保存，避免两个在途写入在服务器端乱序覆盖。
function flushAssStyleLibraryOnUnload() {
  clearTimeout(assStyleLibrarySaveTimer);
  assStyleLibrarySaveTimer = 0;
  if (!assStyleLibraryDirty || !assStyleLibraryUsesServerStorage()) return;
  if (assStyleLibrarySaveInFlight && assStyleLibraryInFlightRevision === assStyleLibraryRevision) return;
  const normalized = window.AsrEditorUtils.normalizeAssStyleLibrary(ASS_STYLE_LIBRARY);
  try {
    void fetch(new URL(MaweBoot.SERVER_CONFIG.assStylesUrl, window.location.href),
      assStyleLibraryPostOptions(normalized, { keepalive: true }))
      .catch(() => { /* 页面正在卸载，失败时保留本地副本即可 */ });
    if (!assStyleLibrarySaveInFlight) assStyleLibraryDirty = false;
  } catch (_) {
    // URL 或请求构造失败时保留 dirty 标记；页面已在卸载流程中，无法再重试。
  }
}
window.addEventListener('pagehide', flushAssStyleLibraryOnUnload);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushAssStyleLibraryOnUnload();
  } else if (assStyleLibraryDirty && !assStyleLibrarySaveTimer && assStyleLibraryUsesServerStorage()) {
    // 切后台时的 flush 可能保留了 dirty（存在在途旧修订写入）；回到前台后补一次常规保存。
    scheduleAssStyleLibrarySave();
  }
});

async function persistAssStyleLibrary() {
  clearTimeout(assStyleLibrarySaveTimer);
  assStyleLibrarySaveTimer = 0;
  const revision = assStyleLibraryRevision;
  const normalized = setAssStyleLibrary(ASS_STYLE_LIBRARY, { persistLocal: true });
  if (!assStyleLibraryUsesServerStorage()) {
    if (revision === assStyleLibraryRevision) {
      assStyleLibraryDirty = false;
      ASS_STYLE_LIBRARY_READY = true;
    }
    setAssStyleLibraryStatus('', 'success');
    syncAssStyleManager?.();
    return normalized;
  }
  assStyleLibrarySaveInFlight = true;
  assStyleLibraryInFlightRevision = revision;
  try {
    const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.assStylesUrl, window.location.href),
      assStyleLibraryPostOptions(normalized));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (revision === assStyleLibraryRevision) {
      setAssStyleLibrary(payload, { persistLocal: true });
      assStyleLibraryDirty = false;
      ASS_STYLE_LIBRARY_READY = true;
      setAssStyleLibraryStatus('', 'success');
    } else {
      // A newer edit was made while this request was in flight.  Keep the
      // current local state and let its debounced save publish the newer
      // revision instead of rolling the form back to an older response.
      ASS_STYLE_LIBRARY_READY = false;
      setAssStyleLibraryStatus('本地有更新改动，等待再次同步', 'warning');
    }
    syncAssStyleManager?.();
    return ASS_STYLE_LIBRARY;
  } catch (error) {
    // 本地副本仍然可用；状态会在管理窗中明确显示为未同步。
    ASS_STYLE_LIBRARY_READY = false;
    setAssStyleLibraryStatus(`本地已保存，服务器同步失败：${error?.message || '未知错误'}`, 'warning');
    return normalized;
  } finally {
    assStyleLibrarySaveInFlight = false;
    assStyleLibraryInFlightRevision = 0;
  }
}

async function loadAssStyleLibrary({ force = false } = {}) {
  if (assStyleLibraryLoadPromise) return assStyleLibraryLoadPromise;
  if (force && assStyleLibraryDirty) {
    // The manager may be reopened while a debounced save is pending.  A
    // forced read must never replace those unsaved edits with the old file.
    syncAssStyleManager?.();
    MawePlaybackLoop.refreshSubtitlePreview?.();
    return ASS_STYLE_LIBRARY;
  }
  setAssStyleLibrary(readLocalAssStyleLibrary());
  setAssStyleLibraryStatus('正在加载…', 'pending');
  assStyleLibraryLoadPromise = (async () => {
    // 让出一轮微任务再继续：便携（无服务器）分支没有任何真正的 await，
    // 会同步执行到底；启动早期调用时脚本后部的预览声明（如
    // renderedStickerOverlayEnabled）仍在暂时性死区，同步刷新预览会抛
    // ReferenceError。先等待一轮，保证回调都在脚本求值完成后运行。
    await Promise.resolve();
    if (!assStyleLibraryUsesServerStorage()) {
      ASS_STYLE_LIBRARY_READY = true;
      setAssStyleLibraryStatus('', 'success');
      syncAssStyleManager?.();
      MawePlaybackLoop.refreshSubtitlePreview?.();
      assStyleLibraryLoadPromise = null;
      return ASS_STYLE_LIBRARY;
    }
    try {
      const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.assStylesUrl, window.location.href), {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!assStyleLibraryDirty) {
        setAssStyleLibrary(payload, { persistLocal: true });
        ASS_STYLE_LIBRARY_READY = true;
        setAssStyleLibraryStatus('', 'success');
      } else {
        // A form edit happened while GET was in flight.  The local edit is
        // authoritative until its own POST succeeds.
        ASS_STYLE_LIBRARY_READY = false;
        setAssStyleLibraryStatus('本地有更新改动，等待再次同步', 'warning');
      }
    } catch (_) {
      // localhost 服务暂不可用时沿用本地副本；下次打开编辑器会再次尝试读取。
      ASS_STYLE_LIBRARY_READY = false;
      setAssStyleLibraryStatus('使用本地副本，服务器同步失败', 'warning');
    }
    syncAssStyleManager?.();
    MawePlaybackLoop.refreshSubtitlePreview?.();
    // Do not cache either a successful or failed request: each subsequent
    // manager open can observe changes made by another Editor or Launcher.
    assStyleLibraryLoadPromise = null;
    return ASS_STYLE_LIBRARY;
  })();
  return assStyleLibraryLoadPromise;
}













// 把用户配置的拆分移除符号同步给共享工具层；设置面板修改时也会同步。
MULTI_SUBTITLE_UTILS.setSplitTrimSymbols(MaweSettings.EDITOR_SETTINGS.splitTrimSymbols);







































MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: MaweBoot.DATA.timebase?.unit === 'frames' });

// 标记颜色：5 种基础色，用于给字幕分组着色。
// 数据模型与表情包同构：head 持完整 color {name, value, start, end}，后续 ref 持 color_ref {name, headIdx}
// 调色板数值唯一来源于 maw/colors.py（渲染时注入 window.ASR_EDITOR_PALETTE）；
// 这里只补充编辑器 UI 用的中文标签。

if (!Array.isArray(window.ASR_EDITOR_PALETTE) || !window.ASR_EDITOR_PALETTE.length) {
  throw new Error('调色板未注入：缺少 window.ASR_EDITOR_PALETTE（检查 edit.py / serve.py 渲染管线）');
}





window.AsrWaveform?.setColorPalette?.(MaweColors.COLOR_PALETTE);




const ASS_PREVIEW_REFERENCE_HEIGHT = Number(window.AsrEditorUtils.ASS_REFERENCE_PLAY_RES_Y) || 1080;

































  // 可被「加载媒体」替换为新 <video>/<audio>







// 工程内波形是可直接使用的缓存；加载关联媒体时不要因为媒体签名不同而覆盖它。
// 媒体生成的波形则不属于工程缓存，切换媒体时仍应重新分析。





// === 统一撤销/重做 ===
// 四种记录 kind 共享一个历史栈：
//   segments   —— 字幕增删改、拆分合并、表情包/颜色、批量替换等
//   layout     —— 布局导入/重置/拖动停靠
//   gap_remove —— 静音空隙扫描与人工修正
//   preview    —— 字幕预览（overlay）开关
// 栈深上限 100；新动作清空 redo；Ctrl(Cmd)+Z 撤销、Ctrl(Cmd)+Shift+Z 重做。
// 编辑文本输入框或 modal 打开时让原生行为优先（见 keydown 守卫）。











// 按记录 kind 拍下当前状态，作为对端栈的镜像（label 沿用原记录）





// modal 或文本输入聚焦时不触发全局撤销/重做（让浏览器/输入框自己处理）




if (MaweHistory.undoBtn) MaweHistory.undoBtn.addEventListener('click', () => MaweHistory.performUndo());
if (MaweHistory.redoBtn) MaweHistory.redoBtn.addEventListener('click', () => MaweHistory.performRedo());
MaweHistory.updateUndoRedoButtons();









MaweDom.overlayTextEl.append(MaweDom.overlayMainTextNode);

const overlayTrackTextEl = document.getElementById('overlay-track-text');
// 叠加轨预览的说话人标签：结构与主字幕预览一致（彩色标签 span + 文本节点）。
const overlayTrackSpeakerLabelEl = document.createElement('span');
overlayTrackSpeakerLabelEl.className = 'subtitle-speaker-label hidden';
const overlayTrackTextNode = document.createTextNode('');
overlayTrackTextEl?.append(overlayTrackSpeakerLabelEl, overlayTrackTextNode);





const subtitleFontFamilyInput = document.getElementById('subtitle-font-family');
const subtitleFontFamilyToggle = document.getElementById('subtitle-font-family-toggle');
const subtitleFontFamilyOptions = document.getElementById('subtitle-font-family-options');
// combobox 实例容器必须声明在启动早期的 relabelSubtitleFontFamilyOptions()
// 调用（模块求值 ~12000 行）之前，否则惰性创建赋值会踩暂时性死区。
let subtitleFontFamilyCombobox = null;
let assFontNameCombobox = null;







const subtitleColorAssModeHint = document.getElementById('subtitle-color-ass-mode-hint');
const subtitleColorAssModeHintLink = document.getElementById('ass-mode-hint-link');


const assColorStyleRow = document.getElementById('ass-color-style-row');
const assColorStyleSelect = document.getElementById('ass-color-style');
const assColorSpeakerHint = document.getElementById('ass-color-speaker-hint');
const assColorSpeakerExportLink = document.getElementById('ass-color-speaker-export-link');







const assModeToggle = document.getElementById('ass-mode-toggle');
const assStyleManagerOpenButton = document.getElementById('ass-style-manager-open');
const assStyleSummary = document.getElementById('ass-style-summary');





























// 预览层（字幕/表情包）的定位与几何测量都以 stage 为基准，不含顶部媒体工具栏。
















  // 「隐藏禁用项」开关状态




































const helpOpenEditorSettingsButtons = Array.from(document.querySelectorAll('[data-help-open-editor-settings]'));








const pauseOnMouseClickToggle = document.getElementById('pause-on-mouse-click');

































































const lottieExportCustomSize = document.getElementById('lottie-export-custom-size');
const lottieExportCustomWidth = document.getElementById('lottie-export-custom-width');
const lottieExportCustomHeight = document.getElementById('lottie-export-custom-height');








const ografExportCustomSize = document.getElementById('ograf-export-custom-size');
const ografExportCustomWidth = document.getElementById('ograf-export-custom-width');
const ografExportCustomHeight = document.getElementById('ograf-export-custom-height');





























const overlayTrackToggle = document.getElementById('overlay-track-toggle');
const overlayTrackSeparator = document.getElementById('overlay-track-separator');






// 已开启多重字幕但尚未加载第二条字幕时的开关右侧提示。


































const multiSubtitleSplitDuplicate = document.getElementById('multi-subtitle-split-duplicate');




























































const assStyleWindow = document.getElementById('ass-style-window');
const assStyleDragHandle = document.getElementById('ass-style-drag-handle');
const assStyleWindowClose = document.getElementById('ass-style-window-close');
const assStyleWindowCloseFooter = document.getElementById('ass-style-window-close-footer');
const assStyleLibraryStatus = document.getElementById('ass-style-library-status');
const assStyleLocalFontScanButton = document.getElementById('ass-style-local-font-scan');
const assStyleFontToggle = document.getElementById('ass-style-font-toggle');
const assStyleFontOptions = document.getElementById('ass-font-name-options');
const assStyleCount = document.getElementById('ass-style-count');
const assProfileCount = document.getElementById('ass-profile-count');
const assStyleList = document.getElementById('ass-style-list');
const assProfileList = document.getElementById('ass-profile-list');
const assStyleNewButton = document.getElementById('ass-style-new');
const assStyleDuplicateButton = document.getElementById('ass-style-duplicate');
const assProfileNewButton = document.getElementById('ass-profile-new');
const assSrtDefaultStyleSelect = document.getElementById('ass-srt-default-style');
const assDefaultProfileSelect = document.getElementById('ass-ass-default-profile');
const subtitleStyleAssModeHint = document.getElementById('subtitle-style-ass-mode-hint');
const mainSubtitleCssFields = document.getElementById('main-subtitle-css-fields');
const mainAssStyleFields = document.getElementById('main-ass-style-fields');
const mainAssStyleSelect = document.getElementById('main-ass-style-select');
const mainAssStyleEditButton = document.getElementById('main-ass-style-edit');
const extensionSubtitleCssFields = document.getElementById('extension-subtitle-css-fields');
const extensionAssStyleFields = document.getElementById('extension-ass-style-fields');
const extensionAssStyleSelect = document.getElementById('extension-ass-style-select');
const extensionAssStyleEditButton = document.getElementById('extension-ass-style-edit');
const assStyleForm = document.getElementById('ass-style-form');
const assProfileForm = document.getElementById('ass-profile-form');
const assProfileStyleSelect = document.getElementById('ass-profile-style-id');
const assProfileExtensionStyleField = document.getElementById('ass-profile-extension-style-field');
const assProfileExtensionStyleSelect = document.getElementById('ass-profile-extension-style');
const assStyleEditorEmpty = document.getElementById('ass-style-editor-empty');
const assStyleFormTitle = document.getElementById('ass-style-form-title');
const assProfileFormTitle = document.getElementById('ass-profile-form-title');
const assStyleSrtHint = document.getElementById('ass-style-srt-hint');
const assStylePreviewModeHint = document.getElementById('ass-style-preview-mode-hint');
const assStyleSettingsLink = document.getElementById('ass-style-settings-link');
const assStyleBuiltinBadge = document.getElementById('ass-style-builtin-badge');
const assProfileBuiltinBadge = document.getElementById('ass-profile-builtin-badge');
const assStyleDeleteSlot = document.getElementById('ass-style-delete-slot');
const assProfileDeleteSlot = document.getElementById('ass-profile-delete-slot');
const assStylePreviewSample = document.getElementById('ass-style-preview-sample');
const assProfilePreviewSummary = document.getElementById('ass-profile-preview-summary');
const assStyleSaveButton = document.getElementById('ass-style-save');
const assStyleDeleteButton = document.getElementById('ass-style-delete');
const assStyleLibraryPathHint = document.getElementById('ass-style-library-path-hint');





















// 先登记所有可独立激活的非模态浮层。嵌套在全局设置窗口里的齿轮弹窗会
// 自动归到全局设置窗口这一层，点击它们时也会把外层窗口带到最前面。
// 表情包根目录弹窗从全局设置窗口打开，同样入栈，打开时动态置顶盖住窗口
//（CSS 的 335 只是 JS 初始化前的静态兜底）。
[
  MaweDom.editorSettingsPanel,
  assStyleWindow,
  MaweDom.helpPanel,
  MaweDom.gapRemovePanel,
  MaweDom.autoMergePanel,
  MaweDom.subtitleExtendPanel,
  MaweDom.mergeJoinSettingsPanel,
  MaweDom.splitTrimSettingsPanel,
  MaweDom.cueListSettingsPanel,
  MaweDom.cueEditorSettingsPanel,
  MaweDom.waveformSettingsPanel,
  MaweDom.multiSubtitleSettingsDropdown,
  document.getElementById('sticker-root-modal'),
  ...document.querySelectorAll('.toolbar .dropdown'),
].forEach(MaweFloatingPanel.bindFloatingSurfaceActivation);






































// 全局设置窗口：复用 createFloatingPanel 获得拖动、位置持久化、Esc 关闭与按钮 active 态；
// 窗口内部用左侧垂直标签页切换不同分区，并记忆用户上次停留的分区。



const ASS_STYLE_WINDOW_POSITION_KEY = 'moy.asr.ass_style.window.v1';
let assStyleManagerSelection = { kind: 'style', id: 'ass' };
let assStyleLibraryStatusText = '';
let assStyleLibraryStatusState = 'idle';

function assStyleLibraryUsesServerStorage() {
  return Boolean(MaweBoot.SERVER_CONFIG?.assStylesUrl);
}

function setAssStyleLibraryStatus(text, state = 'idle') {
  assStyleLibraryStatusText = String(text || '');
  assStyleLibraryStatusState = state;
  updateAssStyleLibraryStatus();
}

function updateAssStyleLibraryStatus() {
  if (!assStyleLibraryStatus) return;
  const usesServerStorage = assStyleLibraryUsesServerStorage();
  const fallback = usesServerStorage
    ? (ASS_STYLE_LIBRARY_READY ? '已与用户级配置同步' : '使用本地副本，尚未同步')
    : '仅保存在当前浏览器（便携模式）';
  const status = assStyleLibraryStatusText || fallback;
  assStyleLibraryStatus.textContent = window.MAWE_I18N?.translateText?.(status) || status;
  assStyleLibraryStatus.dataset.state = !usesServerStorage && assStyleLibraryStatusState === 'success'
    ? 'local' : assStyleLibraryStatusState;
  if (assStyleLibraryPathHint) {
    const pathHint = !usesServerStorage
      ? '便携 Editor 仅保存到当前浏览器；请用 server-editor 打开后，才会与 Launcher 共享。'
      : ASS_STYLE_LIBRARY_READY
        ? '已保存到本机用户级配置；Launcher 与 Editor 共享。'
        : '当前使用本地副本；服务器恢复后可再次点击保存同步。';
    assStyleLibraryPathHint.textContent = window.MAWE_I18N?.translateText?.(pathHint) || pathHint;
  }
}

function assStyleManagerClone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
}

function assStyleManagerId(prefix, items) {
  const existing = new Set((Array.isArray(items) ? items : []).map((item) => String(item?.id || '')));
  let id = '';
  do {
    id = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  } while (existing.has(id));
  return id.slice(0, 64);
}

function selectedAssStyle() {
  const id = assStyleManagerSelection.kind === 'style' ? assStyleManagerSelection.id : '';
  return window.AsrEditorUtils.assStyleForId(ASS_STYLE_LIBRARY, id || 'ass');
}

function selectedAssProfile() {
  const id = assStyleManagerSelection.kind === 'profile' ? assStyleManagerSelection.id : '';
  return window.AsrEditorUtils.assProfileForId(ASS_STYLE_LIBRARY, id || 'ass');
}

function assStyleManagerSetSelection(kind, id) {
  const collection = kind === 'profile' ? ASS_STYLE_LIBRARY.assProfiles : ASS_STYLE_LIBRARY.styles;
  const item = (Array.isArray(collection) ? collection : []).find((candidate) => candidate?.id === id);
  if (!item) return;
  assStyleManagerSelection = { kind, id };
  syncAssStyleManager({ force: true });
}

function appendAssStyleOption(select, value, label) {
  if (!select) return;
  select.append(new Option(label, value));
}

function assStylePreviewModeHintText() {
  return `需要启用 ASS 字幕模式来预览效果。${MaweSettings.EDITOR_SETTINGS.assMode === true ? '当前已启用。' : '当前未启用。'}`;
}

function updateAssStylePreviewModeHints() {
  const enabled = MaweSettings.EDITOR_SETTINGS.assMode === true;
  const prefix = '需要启用 ASS 字幕模式来预览效果。';
  const status = enabled ? '当前已启用。' : '当前未启用。';
  const text = assStylePreviewModeHintText();
  const translated = window.MAWE_I18N?.translateText?.(text) || text;
  document.querySelectorAll('[data-ass-style-preview-hint]').forEach((element) => {
    const prefixElement = element.querySelector('.ass-style-preview-mode-hint-prefix');
    const statusElement = element.querySelector('.ass-style-preview-mode-hint-status');
    if (prefixElement && statusElement) {
      prefixElement.textContent = window.MAWE_I18N?.translateText?.(prefix) || prefix;
      statusElement.textContent = window.MAWE_I18N?.translateText?.(status) || status;
      statusElement.dataset.assPreviewMode = enabled ? 'enabled' : 'disabled';
    } else {
      element.textContent = translated;
    }
    element.dataset.assPreviewMode = enabled ? 'enabled' : 'disabled';
    element.title = translated;
    element.setAttribute('aria-label', translated);
  });
}

function renderAssStyleList(list, items, kind, selectedId) {
  if (!list) return;
  list.replaceChildren();
  list.setAttribute('aria-busy', 'false');
  // 主样式 = 当前 ASS 导出方案关联的样式；副样式 = 双语字幕启用时的副字幕槽位。
  const mainStyleId = kind === 'style'
    ? String(ASS_STYLE_LIBRARY.assProfiles?.find((profile) => profile.id === (ASS_STYLE_LIBRARY.assignments?.assExportProfileId || 'ass'))?.styleId || 'ass')
    : '';
  const extensionStyleId = kind === 'style'
    ? String(ASS_STYLE_LIBRARY.assignments?.assExtensionStyleId || 'ass-extension')
    : '';
  const extensionActive = kind === 'style' && MaweMultiSubtitleCore.multiSubtitleVisible();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.dataset.assSelectionKind = kind;
    button.dataset.assSelectionId = String(item.id || '');
    button.setAttribute('aria-selected', String(item.id || '') === selectedId ? 'true' : 'false');
    const label = document.createElement('span');
    label.className = 'ass-style-list-label';
    label.textContent = String(item.name || item.id || '未命名');
    button.append(label);
    const appendBadge = (text, modifier = '') => {
      const badge = document.createElement('span');
      badge.className = `ass-style-list-badge${modifier ? ` ${modifier}` : ''}`;
      badge.textContent = text;
      button.append(badge);
    };
    if (item.id === mainStyleId) appendBadge('主', 'ass-style-list-badge-primary');
    if (extensionActive && item.id === extensionStyleId) appendBadge('副', 'ass-style-list-badge-extension');
    if (item.builtin) appendBadge('内置');
    button.addEventListener('click', () => assStyleManagerSetSelection(kind, item.id));
    list.append(button);
  });
}

function assStyleFormValue(field) {
  if (!field) return null;
  if (field.type === 'checkbox') return field.checked;
  if (field.type === 'radio') return field.checked ? field.value : null;
  if (field.type === 'number') return field.value === '' ? null : Number(field.value);
  return field.value;
}

function updateAssStyleManagerLibrary(mutator, { persist = true } = {}) {
  const next = assStyleManagerClone(ASS_STYLE_LIBRARY);
  if (!next) return;
  mutator(next);
  assStyleLibraryRevision += 1;
  setAssStyleLibrary(next, { persistLocal: true });
  if (persist) scheduleAssStyleLibrarySave();
  syncAssStyleManager();
  MawePlaybackLoop.refreshSubtitlePreview?.();
}

function setNestedAssProfileValue(profile, path, value) {
  const [group, field] = String(path || '').split('.', 2);
  if (!group || !field || !profile.animations?.[group]) return;
  profile.animations[group] = { ...profile.animations[group], [field]: value };
}

function updateAssStyleField(field, value) {
  const styleId = assStyleManagerSelection.kind === 'style' ? assStyleManagerSelection.id : '';
  if (!styleId) return;
  updateAssStyleManagerLibrary((library) => {
    library.styles = library.styles.map((style) => style.id === styleId
      ? { ...style, [field]: value } : style);
  });
}

function updateAssProfileField(path, value) {
  const profileId = assStyleManagerSelection.kind === 'profile' ? assStyleManagerSelection.id : '';
  if (!profileId) return;
  updateAssStyleManagerLibrary((library) => {
    library.assProfiles = library.assProfiles.map((profile) => {
      if (profile.id !== profileId) return profile;
      const next = { ...profile, animations: assStyleManagerClone(profile.animations) };
      if (path === 'name' || path === 'styleId') next[path] = value;
      else setNestedAssProfileValue(next, path, value);
      return next;
    });
  });
}

function syncAssStyleForm(style) {
  if (!assStyleForm) return;
  const safeStyle = window.AsrEditorUtils.normalizeAssStyle(style);
  if (assStyleFormTitle) assStyleFormTitle.textContent = safeStyle.name;
  if (assStyleBuiltinBadge) assStyleBuiltinBadge.hidden = !safeStyle.builtin;
  const isSrtDefault = safeStyle.id === 'default';
  if (assStyleSrtHint) assStyleSrtHint.hidden = !isSrtDefault;
  if (assStylePreviewModeHint) assStylePreviewModeHint.hidden = isSrtDefault;
  assStyleForm.querySelectorAll('[data-ass-style-field]').forEach((field) => {
    if (document.activeElement === field) return;
    const value = safeStyle[field.dataset.assStyleField];
    if (field.type === 'checkbox') field.checked = value === true;
    else if (field.type === 'radio') field.checked = String(value) === field.value;
    else if (value !== undefined && value !== null) field.value = String(value);
  });
  if (assStylePreviewSample) {
    const preview = safeStyle;
    assStylePreviewSample.textContent = 'Aa 字幕预览 / 字幕样例';
    assStylePreviewSample.style.fontFamily = MaweAppearance.subtitleFontFamilyCss(preview.fontName);
    assStylePreviewSample.style.fontSize = `${Math.max(14, Number(preview.fontSize) || 24)}px`;
    assStylePreviewSample.style.fontWeight = preview.bold ? '700' : '400';
    assStylePreviewSample.style.fontStyle = preview.italic ? 'italic' : 'normal';
    assStylePreviewSample.style.textDecorationLine = [preview.underline ? 'underline' : '', preview.strikeOut ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
    assStylePreviewSample.style.color = preview.primaryColor;
    assStylePreviewSample.style.webkitTextStroke = preview.outline > 0 ? `${Math.min(8, preview.outline)}px ${preview.outlineColor}` : '';
    assStylePreviewSample.style.paintOrder = preview.outline > 0 ? 'stroke fill' : '';
    assStylePreviewSample.style.filter = preview.shadow > 0 ? `drop-shadow(${preview.shadow}px ${preview.shadow}px 0 ${preview.backColor})` : '';
    assStylePreviewSample.style.letterSpacing = `${preview.spacing}px`;
    assStylePreviewSample.style.transform = `scale(${Number(preview.scaleX) / 100 || 1}, ${Number(preview.scaleY) / 100 || 1}) rotate(${Number(preview.angle) || 0}deg)`;
    assStylePreviewSample.style.background = Number(preview.borderStyle) === 3 ? preview.backColor : 'transparent';
  }
  updateAssStylePreviewModeHints();
}

function syncAssProfileForm(profile) {
  if (!assProfileForm) return;
  const safeProfile = window.AsrEditorUtils.normalizeAssProfile(profile);
  if (assProfileFormTitle) assProfileFormTitle.textContent = safeProfile.name;
  if (assProfileBuiltinBadge) assProfileBuiltinBadge.hidden = !safeProfile.builtin;
  assProfileForm.querySelectorAll('[data-ass-profile-field]').forEach((field) => {
    if (document.activeElement === field) return;
    const value = safeProfile[field.dataset.assProfileField];
    if (value !== undefined && value !== null) field.value = String(value);
  });
  assProfileForm.querySelectorAll('[data-ass-animation]').forEach((field) => {
    const path = field.dataset.assAnimation;
    const [group, key] = path.split('.', 2);
    const value = safeProfile.animations?.[group]?.[key];
    if (document.activeElement !== field && value !== undefined) {
      if (field.type === 'checkbox') field.checked = value === true;
      else field.value = String(value);
    }
    field.disabled = key !== 'enabled' && safeProfile.animations?.[group]?.enabled !== true;
  });
  if (assProfilePreviewSummary) {
    const tags = window.AsrEditorUtils.assAnimationOverrideTags(safeProfile);
    const style = window.AsrEditorUtils.assStyleForId(ASS_STYLE_LIBRARY, safeProfile.styleId);
    const summary = `${style.name} · ${tags || '无逐句动画'}`;
    assProfilePreviewSummary.textContent = window.MAWE_I18N?.translateText?.(summary) || summary;
  }
}

function syncAssStyleManager({ force = false } = {}) {
  if (!assStyleWindow) return;
  ASS_STYLE_LIBRARY = window.AsrEditorUtils.normalizeAssStyleLibrary(ASS_STYLE_LIBRARY);
  const styles = ASS_STYLE_LIBRARY.styles || [];
  const profiles = ASS_STYLE_LIBRARY.assProfiles || [];
  const selectedCollection = assStyleManagerSelection.kind === 'profile' ? profiles : styles;
  if (!selectedCollection.some((item) => item.id === assStyleManagerSelection.id)) {
    assStyleManagerSelection = assStyleManagerSelection.kind === 'profile'
      ? { kind: 'profile', id: profiles[0]?.id || 'ass' }
      : { kind: 'style', id: styles[0]?.id || 'ass' };
  }
  if (assStyleCount) assStyleCount.textContent = String(styles.length);
  if (assProfileCount) assProfileCount.textContent = String(profiles.length);
  updateAssStyleLibrarySummary();
  renderAssStyleList(assStyleList, styles, 'style', assStyleManagerSelection.kind === 'style' ? assStyleManagerSelection.id : '');
  renderAssStyleList(assProfileList, profiles, 'profile', assStyleManagerSelection.kind === 'profile' ? assStyleManagerSelection.id : '');
  if (assSrtDefaultStyleSelect) {
    const active = ASS_STYLE_LIBRARY.assignments?.srtBurnStyleId || 'default';
    assSrtDefaultStyleSelect.replaceChildren();
    styles.forEach((style) => appendAssStyleOption(assSrtDefaultStyleSelect, style.id, style.name));
    assSrtDefaultStyleSelect.value = active;
  }
  if (assDefaultProfileSelect) {
    const active = ASS_STYLE_LIBRARY.assignments?.assExportProfileId || 'ass';
    assDefaultProfileSelect.replaceChildren();
    profiles.forEach((profile) => appendAssStyleOption(assDefaultProfileSelect, profile.id, profile.name));
    assDefaultProfileSelect.value = active;
  }
  // 副字幕样式入口随多重字幕开合显隐：现在挂在方案表单里，与主字幕样式并排。
  const extensionSlotVisible = MaweMultiSubtitleCore.multiSubtitleVisible();
  if (assProfileExtensionStyleField) assProfileExtensionStyleField.hidden = !extensionSlotVisible;
  if (assProfileExtensionStyleSelect) {
    assProfileExtensionStyleSelect.replaceChildren();
    styles.forEach((style) => appendAssStyleOption(assProfileExtensionStyleSelect, style.id, style.name));
    assProfileExtensionStyleSelect.value = ASS_STYLE_LIBRARY.assignments?.assExtensionStyleId || 'ass-extension';
  }
  if (assProfileStyleSelect) {
    const selectedProfile = selectedAssProfile();
    assProfileStyleSelect.replaceChildren();
    styles.forEach((style) => appendAssStyleOption(assProfileStyleSelect, style.id, style.name));
    assProfileStyleSelect.value = selectedProfile.styleId;
  }
  const isStyle = assStyleManagerSelection.kind === 'style';
  if (assStyleEditorEmpty) assStyleEditorEmpty.hidden = selectedCollection.length > 0;
  if (assStyleForm) assStyleForm.hidden = !isStyle;
  if (assProfileForm) assProfileForm.hidden = isStyle;
  const deleteSlot = isStyle ? assStyleDeleteSlot : assProfileDeleteSlot;
  if (deleteSlot && assStyleDeleteButton && assStyleDeleteButton.parentElement !== deleteSlot) {
    deleteSlot.append(assStyleDeleteButton);
  }
  if (assStyleDeleteButton) {
    const selected = selectedCollection.find((item) => item.id === assStyleManagerSelection.id);
    assStyleDeleteButton.disabled = !selected || selected.builtin === true;
    assStyleDeleteButton.title = selected?.builtin ? '内置条目不能删除' : '删除当前条目';
  }
  if (isStyle) syncAssStyleForm(selectedAssStyle());
  else syncAssProfileForm(selectedAssProfile());
  updateAssStyleLibraryStatus();
  // 样式库变化后，设置页「字幕样式」里的 ASS 样式选择器同步刷新。
  syncSubtitleStyleAssControls();
  if (force) assStyleWindow.querySelector('.ass-style-editor')?.scrollTo({ top: 0 });
}

function createAssStyle() {
  if ((ASS_STYLE_LIBRARY.styles || []).length >= 64) {
    MaweHint.flashHint('样式数量已达到上限（64 个）', 'warning');
    return;
  }
  const id = assStyleManagerId('style', ASS_STYLE_LIBRARY.styles);
  updateAssStyleManagerLibrary((library) => {
    library.styles.push({
      ...assStyleManagerClone(window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE),
      id, name: '新样式', builtin: false,
    });
  }, { persist: false });
  assStyleManagerSelection = { kind: 'style', id };
  scheduleAssStyleLibrarySave();
  syncAssStyleManager({ force: true });
}

function duplicateAssStyle() {
  const source = selectedAssStyle();
  if (!source || (ASS_STYLE_LIBRARY.styles || []).length >= 64) {
    MaweHint.flashHint('无法复制样式：已达到数量上限', 'warning');
    return;
  }
  const id = assStyleManagerId('style', ASS_STYLE_LIBRARY.styles);
  updateAssStyleManagerLibrary((library) => {
    library.styles.push({ ...assStyleManagerClone(source), id, name: `${source.name} 副本`, builtin: false });
  }, { persist: false });
  assStyleManagerSelection = { kind: 'style', id };
  scheduleAssStyleLibrarySave();
  syncAssStyleManager({ force: true });
}

function duplicateAssProfile() {
  const source = selectedAssProfile();
  if (!source || (ASS_STYLE_LIBRARY.assProfiles || []).length >= 64) {
    MaweHint.flashHint('无法复制方案：已达到数量上限', 'warning');
    return;
  }
  const id = assStyleManagerId('profile', ASS_STYLE_LIBRARY.assProfiles);
  updateAssStyleManagerLibrary((library) => {
    library.assProfiles.push({
      ...assStyleManagerClone(source),
      id, name: `${source.name} 副本`, builtin: false,
    });
  }, { persist: false });
  assStyleManagerSelection = { kind: 'profile', id };
  scheduleAssStyleLibrarySave();
  syncAssStyleManager({ force: true });
}

function createAssProfile() {
  if ((ASS_STYLE_LIBRARY.assProfiles || []).length >= 64) {
    MaweHint.flashHint('ASS 方案数量已达到上限（64 个）', 'warning');
    return;
  }
  const id = assStyleManagerId('profile', ASS_STYLE_LIBRARY.assProfiles);
  updateAssStyleManagerLibrary((library) => {
    library.assProfiles.push({
      ...assStyleManagerClone(window.AsrEditorUtils.ASS_DEFAULT_PROFILE),
      id, name: '新 ASS 方案', builtin: false,
      animations: assStyleManagerClone(window.AsrEditorUtils.ASS_DEFAULT_ANIMATIONS),
    });
  }, { persist: false });
  assStyleManagerSelection = { kind: 'profile', id };
  scheduleAssStyleLibrarySave();
  syncAssStyleManager({ force: true });
}

function deleteSelectedAssEntry() {
  const { kind, id } = assStyleManagerSelection;
  const collection = kind === 'profile' ? ASS_STYLE_LIBRARY.assProfiles : ASS_STYLE_LIBRARY.styles;
  const item = collection?.find((candidate) => candidate.id === id);
  if (!item || item.builtin) {
    MaweHint.flashHint('内置条目不能删除；可以直接修改其参数', 'warning');
    return;
  }
  if (!confirm(`确定删除“${item.name}”吗？`)) return;
  updateAssStyleManagerLibrary((library) => {
    if (kind === 'profile') {
      library.assProfiles = library.assProfiles.filter((profile) => profile.id !== id);
      if (library.assignments.assExportProfileId === id) library.assignments.assExportProfileId = 'ass';
    } else {
      library.styles = library.styles.filter((style) => style.id !== id);
      library.assProfiles = library.assProfiles.map((profile) => ({
        ...profile, styleId: profile.styleId === id ? 'ass' : profile.styleId,
      }));
      if (library.assignments.srtBurnStyleId === id) library.assignments.srtBurnStyleId = 'default';
    }
  });
  assStyleManagerSelection = kind === 'profile' ? { kind: 'profile', id: 'ass' } : { kind: 'style', id: 'ass' };
  syncAssStyleManager({ force: true });
}

function updateAssStyleAssignment(slot, value) {
  updateAssStyleManagerLibrary((library) => {
    library.assignments = { ...(library.assignments || {}), [slot]: value };
  });
  MawePlaybackLoop.refreshSubtitlePreview?.();
}

const assStyleFloatingPanel = MaweFloatingPanel.createFloatingPanel({
  panel: assStyleWindow,
  dragHandle: assStyleDragHandle,
  manageButton: assStyleManagerOpenButton,
  anchorButton: assStyleManagerOpenButton,
  positionKey: ASS_STYLE_WINDOW_POSITION_KEY,
  onOpen: () => {
    syncAssStyleManager({ force: true });
    void loadAssStyleLibrary({ force: true });
  },
});
assStyleWindowClose?.addEventListener('click', () => assStyleFloatingPanel.close());
assStyleWindowCloseFooter?.addEventListener('click', () => assStyleFloatingPanel.close());
assStyleNewButton?.addEventListener('click', createAssStyle);
assStyleDuplicateButton?.addEventListener('click', duplicateAssStyle);
assProfileNewButton?.addEventListener('click', createAssProfile);
assStyleDeleteButton?.addEventListener('click', deleteSelectedAssEntry);
assStyleSettingsLink?.addEventListener('click', (event) => {
  event.preventDefault();
  MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-subtitle-style');
});
assStyleSaveButton?.addEventListener('click', () => {
  setAssStyleLibraryStatus(
    assStyleLibraryUsesServerStorage() ? '正在保存用户级样式库…' : '正在保存到当前浏览器…',
    'pending',
  );
  void persistAssStyleLibrary();
});
assSrtDefaultStyleSelect?.addEventListener('change', () => updateAssStyleAssignment('srtBurnStyleId', assSrtDefaultStyleSelect.value));
assDefaultProfileSelect?.addEventListener('change', () => updateAssStyleAssignment('assExportProfileId', assDefaultProfileSelect.value));
assProfileExtensionStyleSelect?.addEventListener('change', () => updateAssStyleAssignment('assExtensionStyleId', assProfileExtensionStyleSelect.value));
// 设置页「字幕样式」的 ASS 选择器：主字幕改的是当前 ASS 输出方案关联的
// 样式（与样式库窗口中方案表单的样式下拉同步）；副字幕改库中的副字幕槽位。
mainAssStyleSelect?.addEventListener('change', () => {
  updateAssStyleManagerLibrary((library) => {
    const profileId = library.assignments?.assExportProfileId || 'ass';
    const profile = (library.assProfiles || []).find((item) => item.id === profileId);
    if (profile) profile.styleId = mainAssStyleSelect.value;
  });
});
extensionAssStyleSelect?.addEventListener('change', () => {
  updateAssStyleAssignment('assExtensionStyleId', extensionAssStyleSelect.value);
});
// 「使用 ASS 样式」旁的「编辑样式」：打开样式库窗口并定位到下拉当前选中的样式。
function openAssStyleManagerForStyle(select) {
  if (!select?.value) return;
  assStyleManagerSetSelection('style', select.value);
  assStyleFloatingPanel.open();
}
mainAssStyleEditButton?.addEventListener('click', () => openAssStyleManagerForStyle(mainAssStyleSelect));
extensionAssStyleEditButton?.addEventListener('click', () => openAssStyleManagerForStyle(extensionAssStyleSelect));
// 「读取本机字体」：与设置页共用同一个本机字体扫描；扫描结果进入共享的
// subtitleLocalFontFamilies，ASS 字体下拉在下次展开时即包含这些字体。
assStyleLocalFontScanButton?.addEventListener('click', async () => {
  if (assStyleLocalFontScanButton.disabled) return;
  assStyleLocalFontScanButton.disabled = true;
  try {
    await MaweAppearance.scanSubtitleLocalFonts();
  } finally {
    assStyleLocalFontScanButton.disabled = false;
  }
  rebuildAssFontNameOptions();
  const hintByState = {
    success: () => MaweHint.flashHint(`已读取 ${MaweAppearance.subtitleFontFamilyScanCount} 种本机字体`, 'success'),
    empty: () => MaweHint.flashHint('未读取到可用的本机字体', 'warning'),
    unsupported: () => MaweHint.flashHint('当前环境不支持自动读取本机字体', 'warning'),
    denied: () => MaweHint.flashHint('未获准读取本机字体', 'warning'),
    failed: () => MaweHint.flashHint('读取本机字体失败，请重试', 'warning'),
  };
  hintByState[MaweAppearance.subtitleFontFamilyScanState]?.();
});
// 样式/方案列表右键菜单：设为主/副字幕样式 / 创建副本 / 重命名 / 删除。
function showAssListContextMenu(event, kind) {
  const button = event.target.closest(`[data-ass-selection-kind="${kind}"]`);
  if (!button) return;
  // 阻止冒泡：document 级 contextmenu 监听会关闭非 cue 上的菜单，
  // 不拦截的话刚显示的菜单会立即被吞掉。
  event.preventDefault();
  event.stopPropagation();
  assStyleManagerSetSelection(kind, button.dataset.assSelectionId);
  const collection = kind === 'profile' ? ASS_STYLE_LIBRARY.assProfiles : ASS_STYLE_LIBRARY.styles;
  const item = collection?.find((candidate) => candidate.id === button.dataset.assSelectionId);
  if (!item) return;
  MaweDom.ctxmenu.innerHTML = '';
  const addItem = (label, fn, { danger = false, disabled = false } = {}) => {
    const element = document.createElement('div');
    element.className = `item${danger ? ' danger' : ''}${disabled ? ' disabled' : ''}`;
    const text = document.createElement('span');
    text.textContent = label;
    element.appendChild(text);
    if (!disabled) element.addEventListener('click', () => {
      MaweDom.ctxmenu.classList.remove('show');
      fn();
    });
    MaweDom.ctxmenu.appendChild(element);
  };
  // 「设为XX」归为第一组；分隔线隔开后的第二组是对条目本身的操作。
  const addSeparator = () => {
    const separator = document.createElement('div');
    separator.className = 'sep';
    MaweDom.ctxmenu.appendChild(separator);
  };
  if (kind === 'style') {
    addItem('设为主字幕样式', () => {
      updateAssStyleManagerLibrary((library) => {
        const profileId = library.assignments?.assExportProfileId || 'ass';
        const profile = (library.assProfiles || []).find((entry) => entry.id === profileId);
        if (profile) profile.styleId = item.id;
      });
    });
    if (MaweMultiSubtitleCore.multiSubtitleVisible()) {
      addItem('设为副字幕样式', () => updateAssStyleAssignment('assExtensionStyleId', item.id));
    }
    addItem('设为 SRT 烧录样式', () => updateAssStyleAssignment('srtBurnStyleId', item.id));
  } else {
    addItem('设为 ASS 导出方案', () => updateAssStyleAssignment('assExportProfileId', item.id));
  }
  addSeparator();
  addItem('创建副本', () => (kind === 'profile' ? duplicateAssProfile() : duplicateAssStyle()));
  addItem('重命名', () => {
    const input = document.getElementById(kind === 'profile' ? 'ass-profile-name' : 'ass-style-name');
    if (!input) return;
    input.focus();
    input.select();
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  addItem('删除', () => deleteSelectedAssEntry(), { danger: true, disabled: item.builtin === true });
  MaweDom.ctxmenu.classList.add('show');
  const rect = MaweDom.ctxmenu.getBoundingClientRect();
  const nx = Math.max(4, Math.min(event.clientX, window.innerWidth - rect.width - 4));
  const ny = Math.max(4, Math.min(event.clientY, window.innerHeight - rect.height - 4));
  MaweDom.ctxmenu.style.left = `${nx}px`;
  MaweDom.ctxmenu.style.top = `${ny}px`;
}
assStyleList?.addEventListener('contextmenu', (event) => showAssListContextMenu(event, 'style'));
assProfileList?.addEventListener('contextmenu', (event) => showAssListContextMenu(event, 'profile'));
assStyleForm?.addEventListener('input', (event) => {
  const field = event.target.closest('[data-ass-style-field]');
  if (!field) return;
  if (field.type === 'radio' && !field.checked) return;
  updateAssStyleField(field.dataset.assStyleField, assStyleFormValue(field));
});
assStyleForm?.addEventListener('change', (event) => {
  const field = event.target.closest('[data-ass-style-field]');
  if (field && (field.type !== 'radio' || field.checked)) {
    updateAssStyleField(field.dataset.assStyleField, assStyleFormValue(field));
  }
});
assProfileForm?.addEventListener('input', (event) => {
  const field = event.target.closest('[data-ass-profile-field], [data-ass-animation]');
  if (!field) return;
  const path = field.dataset.assProfileField || field.dataset.assAnimation;
  updateAssProfileField(path, assStyleFormValue(field));
});
assProfileForm?.addEventListener('change', (event) => {
  const field = event.target.closest('[data-ass-profile-field], [data-ass-animation]');
  if (field) updateAssProfileField(field.dataset.assProfileField || field.dataset.assAnimation, assStyleFormValue(field));
});

function syncSubtitleStyleAssControls() {
  // ASS 字幕模式接管预览样式后，「字幕样式」页的主/副字幕 CSS 控件换成
  // 样式库选择器；主字幕选择即当前 ASS 输出方案关联的样式，与样式库窗口
  // 中的选择同步，副字幕选择对应库中的「副字幕样式」槽位。
  const assMode = MaweSettings.EDITOR_SETTINGS.assMode === true;
  if (subtitleStyleAssModeHint) subtitleStyleAssModeHint.hidden = !assMode;
  if (mainSubtitleCssFields) mainSubtitleCssFields.hidden = assMode;
  if (mainAssStyleFields) mainAssStyleFields.hidden = !assMode;
  if (extensionSubtitleCssFields) extensionSubtitleCssFields.hidden = assMode;
  // 副字幕 ASS 样式只在 ASS 模式 + 双语字幕（多重字幕）启用时才有意义。
  if (extensionAssStyleFields) extensionAssStyleFields.hidden = !assMode || !MaweMultiSubtitleCore.multiSubtitleVisible();
  const library = window.AsrEditorUtils.normalizeAssStyleLibrary(ASS_STYLE_LIBRARY);
  const styles = library.styles || [];
  if (mainAssStyleSelect) {
    mainAssStyleSelect.replaceChildren();
    styles.forEach((style) => appendAssStyleOption(mainAssStyleSelect, style.id, style.name));
    const profile = window.AsrEditorUtils.assProfileForId(
      library, library.assignments?.assExportProfileId || 'ass',
    );
    mainAssStyleSelect.value = profile.styleId;
  }
  if (extensionAssStyleSelect) {
    extensionAssStyleSelect.replaceChildren();
    styles.forEach((style) => appendAssStyleOption(extensionAssStyleSelect, style.id, style.name));
    extensionAssStyleSelect.value = library.assignments?.assExtensionStyleId || 'ass-extension';
  }
}

function syncAssModeDependentControls() {
  // ASS 字幕模式接管预览样式后，「预览字幕颜色」不再参与预览，禁用并提示跳转；
  // 「颜色字幕样式」在「字幕颜色」页替代「预览颜色样式」，只在 ASS 模式下显示。
  const assMode = MaweSettings.EDITOR_SETTINGS.assMode === true;
  if (MaweDom.subtitleColorUnderlineInput) MaweDom.subtitleColorUnderlineInput.disabled = assMode;
  if (subtitleColorAssModeHint) subtitleColorAssModeHint.hidden = !assMode;
  if (assColorStyleRow) assColorStyleRow.hidden = !assMode;
  if (assColorSpeakerHint) {
    assColorSpeakerHint.hidden = !assMode || assColorStyleSelect?.value !== 'speaker';
  }
  if (MaweDom.subtitleColorStyleControl) {
    MaweDom.subtitleColorStyleControl.hidden = assMode
      || !(MaweDom.subtitleColorUnderlineInput?.checked ?? true);
  }
  syncSubtitleStyleAssControls();
}

function syncAssModeControl() {
  syncAssModeDependentControls();
  updateAssStylePreviewModeHints();
  if (!assModeToggle) return;
  assModeToggle.checked = MaweSettings.EDITOR_SETTINGS.assMode === true;
  assModeToggle.setAttribute('aria-checked', String(assModeToggle.checked));
}

assModeToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ assMode: assModeToggle.checked });
  syncAssModeControl();
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  MawePlaybackLoop.refreshSubtitlePreview();
  MaweHint.flashHint(assModeToggle.checked ? '已开启 ASS 字幕模式预览' : '已恢复原有字幕预览', 'success');
});





// 浮窗尺寸：与帮助窗口一致，仅在用户拖过右下角缩放手柄后持久化；
// 未缩放时保持 CSS 默认宽度/自动高度。


if (MaweDom.editorSettingsPanel) {
  new ResizeObserver(() => {
    if (!MaweDom.editorSettingsPanel.classList.contains('show')) return;
    if (!MaweDom.editorSettingsPanel.style.width && !MaweDom.editorSettingsPanel.style.height) return;
    clearTimeout(MaweSettingsPanels.editorSettingsPanelSizeSaveTimer);
    MaweSettingsPanels.editorSettingsPanelSizeSaveTimer = setTimeout(() => {
      const rect = MaweDom.editorSettingsPanel.getBoundingClientRect();
      try {
        localStorage.setItem(MaweDom.EDITOR_SETTINGS_WINDOW_SIZE_KEY, JSON.stringify({
          width: Math.round(rect.width), height: Math.round(rect.height),
        }));
      } catch (_) {
        // file:// 隐私模式下 localStorage 可能被拒；缩放本身仍可用。
      }
    }, 250);
  }).observe(MaweDom.editorSettingsPanel);
}




































overlayTrackToggle?.addEventListener('change', () => {
  const overlay = getOverlayTrack();
  if (!overlay) return;
  overlay.enabled = overlayTrackToggle.checked;
  overlay._dirty = true;
  MaweServerSave.scheduleAutoSaveFlush();
  MaweCuePanel.renderAll({ waveform: 'full' });
  if (overlayTrackToggle.checked) {
    MaweHint.flashHint('已允许字幕重叠；Ctrl+拖拽波形空白或用右键菜单可创建叠加字幕', 'success');
  }
});













// macOS 用 ⌘（Cmd）替代 Ctrl；Win/Linux 仍显示 Ctrl。






// 把帮助面板等静态 <kbd data-mod-key> 与「拆分按键」下拉选项文本按平台替换。




// 切换语言时 i18n 会重置动态文本节点，需重新套用当前拆分按键提示和目标轨道标签。
document.addEventListener('mawe:languagechange', () => {
  MaweSplitMode.refreshSplitKeyHelp();
  MaweCuePanel.renderCurrentCuePanel();
  MaweTimeline.refreshTimelineSettingsUi();
  MaweMediaPlayback.refreshMediaSeekStepHelp();
  MaweMediaPlayback.refreshMediaSeekControlLabels();
  updateAssStyleLibrarySummary();
  updateAssStyleLibraryStatus();
  updateAssStylePreviewModeHints();
});

MaweDom.splitKeySel.value = MaweSettings.EDITOR_SETTINGS.splitKey;
if (MaweDom.splitUseWordTimestampsToggle) MaweDom.splitUseWordTimestampsToggle.checked = MaweSettings.EDITOR_SETTINGS.splitUseWordTimestamps;
if (MaweDom.multiSubtitleSplitAutoSubmit) MaweDom.multiSubtitleSplitAutoSubmit.checked = MaweSettings.EDITOR_SETTINGS.splitAutoSubmit;
MaweDisplaySettings.applyPlatformKeyLabels();
MaweSplitMode.refreshSplitKeyHelp();
if (MaweDom.mergeJoinTextContinuousInput) MaweDom.mergeJoinTextContinuousInput.value = MaweSettings.EDITOR_SETTINGS.mergeJoinTextContinuous;
if (MaweDom.mergeJoinTextWordInput) MaweDom.mergeJoinTextWordInput.value = MaweSettings.EDITOR_SETTINGS.mergeJoinTextWord;
// 「合并字幕时插入字符」旁的提示：显示当前主字幕拆分类型（自动检测或已指定），
// 并提供一键切换。手动指定的类型存入 EDITOR_SETTINGS.mainSplitModeOverride
// （本地偏好，多重字幕开关无关），同时同步 multi_subtitle.main_split_mode，
// 与多重字幕菜单的「主字幕语言类型」互为镜像。






MaweSplitMode.mergeJoinModeSwitch?.addEventListener('click', () => {
  MaweSplitMode.setMainSubtitleSplitModeBinding(MaweSplitMode.mergeJoinModeSwitch.dataset.targetMode);
});
MaweSegmentOps.syncAutoMergePanelInputs();
MaweDom.overlayToggle.checked = MaweSettings.EDITOR_SETTINGS.overlayEnabled;
if (MaweDom.extensionOverlayToggle) MaweDom.extensionOverlayToggle.checked = false;
MaweDom.exportStartAtZeroToggle.checked = MaweSettings.EDITOR_SETTINGS.exportStartAtZero;
if (MaweDom.selectGroupMembersToggle) MaweDom.selectGroupMembersToggle.checked = MaweSettings.EDITOR_SETTINGS.selectGroupMembers;
if (MaweDom.exportColorUnifiedToggle) MaweDom.exportColorUnifiedToggle.checked = MaweSettings.EDITOR_SETTINGS.exportColorUnified;
if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels;
if (MaweDom.exportSpeakerNamesAsSuffixToggle) {
  MaweDom.exportSpeakerNamesAsSuffixToggle.checked = MaweSettings.EDITOR_SETTINGS.exportSpeakerNamesAsSuffix;
}
if (MaweDom.autoSaveProjectToggle) MaweDom.autoSaveProjectToggle.checked = MaweSettings.EDITOR_SETTINGS.autoSaveProject;
if (MaweDom.autoSaveIntervalInput) MaweDom.autoSaveIntervalInput.value = String(MaweSettings.EDITOR_SETTINGS.autoSaveIntervalSeconds);
if (MaweDom.stickerOverlayToggle) MaweDom.stickerOverlayToggle.checked = MaweSettings.EDITOR_SETTINGS.stickerOverlayEnabled;
if (MaweDom.clickBehaviorSelect) MaweDom.clickBehaviorSelect.value = MaweSettings.EDITOR_SETTINGS.clickBehavior;
if (MaweDom.clickTargetSelect) MaweDom.clickTargetSelect.value = MaweSettings.EDITOR_SETTINGS.clickTarget;
if (pauseOnMouseClickToggle) pauseOnMouseClickToggle.checked = MaweSettings.EDITOR_SETTINGS.pauseOnMouseClick;
if (MaweDom.keyboardOperationReferenceSelect) {
  MaweDom.keyboardOperationReferenceSelect.value = MaweSettings.EDITOR_SETTINGS.keyboardOperationReference;
}
if (MaweJklPlayback.jklPlaybackModeSelect) MaweJklPlayback.jklPlaybackModeSelect.value = MaweSettings.EDITOR_SETTINGS.jklPlaybackMode;
if (MaweDom.hoverSeekPreviewToggle) MaweDom.hoverSeekPreviewToggle.checked = MaweSettings.EDITOR_SETTINGS.hoverSeekPreview;
if (MaweDom.mediaSeekStepInput) MaweDom.mediaSeekStepInput.value = String(MaweSettings.EDITOR_SETTINGS.mediaSeekStepMs);
if (MaweDom.cueMoveStepInput) MaweDom.cueMoveStepInput.value = String(MaweSettings.EDITOR_SETTINGS.cueMoveStepMs);
if (MaweDom.timelineTimebaseSelect) MaweDom.timelineTimebaseSelect.value = MaweTimeline.projectTimebase().unit;
if (MaweDom.timelineFpsInput) MaweDom.timelineFpsInput.value = String(MaweTimeline.projectTimebase().fps);
if (MaweDom.timelineSnapToFrameToggle) MaweDom.timelineSnapToFrameToggle.checked = MaweSettings.EDITOR_SETTINGS.timelineSnapToFrame;
if (MaweDom.timelineTimecodeSeparatorInput) {
  MaweDom.timelineTimecodeSeparatorInput.value = MaweTimeline.normalizeTimelineTimecodeSeparator(
    MaweSettings.EDITOR_SETTINGS.timelineTimecodeSeparator,
  );
}
if (MaweDom.autoSnapAdjacentCuesToggle) {
  MaweDom.autoSnapAdjacentCuesToggle.checked = MaweSettings.EDITOR_SETTINGS.autoSnapAdjacentCues;
}
if (MaweDom.adjacentBoundaryModeSelect) MaweDom.adjacentBoundaryModeSelect.value = MaweSettings.EDITOR_SETTINGS.adjacentBoundaryMode;
MaweTimeline.refreshAdjacentBoundaryModeUi();
if (MaweDom.cueEditorCancelOnEscapeToggle) {
  MaweDom.cueEditorCancelOnEscapeToggle.checked = MaweSettings.EDITOR_SETTINGS.cueEditorCancelOnEscape;
}
MaweTimeline.refreshTimelineSettingsUi();
MaweMediaPlayback.refreshMediaSeekStepHelp();
MaweMediaStep.refreshMediaSeekInputStep();
MaweMediaPlayback.refreshMediaSeekControlLabels();
MaweNinja.applyNinjaSettings();

if (MaweDom.waveformShapeSourceSelect) {
  MaweDom.waveformShapeSourceSelect.value = MaweSettings.EDITOR_SETTINGS.waveShapeSource;
  MaweDom.waveformShapeSourceSelect.addEventListener('change', () => {
    MaweSettings.EDITOR_SETTINGS.waveShapeSource = MaweDom.waveformShapeSourceSelect.value === 'reapeaks' ? 'reapeaks' : 'self';
    MaweSettings.saveEditorSettings(MaweSettings.EDITOR_SETTINGS);
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.render();
  });
}
MaweDisplaySettings.applyCueListDisplaySettings({ preserveCueListScroll: false });
MaweDisplaySettings.applyCueEditorDisplaySettings();
MaweDom.multiSubtitleToggle?.addEventListener('change', () => {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const next = MaweDom.multiSubtitleToggle.checked;
  const promptImportSecondSrt = next && !MaweMultiSubtitleCore.getActiveExtensionTrack();
  multi.enabled = !next;
  MaweHistory.pushUndo(next ? '开启双语字幕' : '关闭双语字幕');
  multi.enabled = next;
  multi._dirty = true;
  // 开关会改变波形是否需要副字幕 lane，因此这里才执行完整波形重建。
  MaweCuePanel.renderAll({ waveform: 'full' });
  if (!promptImportSecondSrt) return;
  // 多重字幕模式已开启；提示只决定是否现在导入第二条字幕，
  // 用户取消导入也保持开启，之后仍可拖入 SRT 或重新走导入流程。
  if (!confirm(MaweMultiSubtitleCore.MULTI_SUBTITLE_IMPORT_PROMPT)) return;
  MaweMultiSubtitleCore.pendingSrtImportAsExtension = true;
  MaweProjectMediaInputs.loadSrtFileInput.value = '';
  MaweProjectMediaInputs.loadSrtFileInput.click();
});
MaweDom.multiSubtitleDisplayMode?.addEventListener('change', () => {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const next = MaweDom.multiSubtitleDisplayMode.value;
  const previous = multi.display_mode;
  multi.display_mode = previous;
  MaweHistory.pushUndo('切换双语字幕列表');
  multi.display_mode = MULTI_SUBTITLE_UTILS.MULTI_SUBTITLE_DISPLAY_MODES.has(next) ? next : 'both';
  multi._dirty = true;
  MaweCuePanel.renderAll({ waveform: 'none' });
});
MaweDom.multiSubtitleMainLanguageMode?.addEventListener('change', () => {
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  const next = MaweMultiSubtitleCore.isConfiguredSubtitleSplitMode(MaweDom.multiSubtitleMainLanguageMode.value)
    ? MaweDom.multiSubtitleMainLanguageMode.value : 'word';
  if (multi.main_split_mode === next
      && MaweSettings.EDITOR_SETTINGS.mainSplitModeOverride === next) return;
  MaweHistory.pushUndo('切换主字幕语言类型');
  multi.main_split_mode = next;
  // 与设置面板的类型提示共用同一个手动指定偏好，两个入口互为镜像。
  MaweSettings.updateEditorSettings({ mainSplitModeOverride: next });
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweCuePanel.renderAll({ waveform: 'none' });
});
MaweDom.multiSubtitleExtensionLanguageMode?.addEventListener('change', () => {
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  if (!track) return;
  const next = MaweMultiSubtitleCore.isConfiguredSubtitleSplitMode(MaweDom.multiSubtitleExtensionLanguageMode.value)
    ? MaweDom.multiSubtitleExtensionLanguageMode.value : 'word';
  if (track.split_mode === next) return;
  MaweHistory.pushUndo('切换副字幕语言类型');
  track.split_mode = next;
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweCuePanel.renderAll({ waveform: 'none' });
});
MaweDom.multiSubtitleExtensionRowHeight?.addEventListener('change', () => {
  const next = MaweSettings.normalizeMultiSubtitleRowHeight(MaweDom.multiSubtitleExtensionRowHeight.value);
  MaweSettings.updateEditorSettings({ multiSubtitleRowHeight: next });
  if (MaweMultiSubtitleCore.multiSubtitleVisible()) MaweCoreState.waveformEditor?.setRowHeight(next);
});
MaweDom.multiSubtitleCrossTrackSnapToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ crossTrackSnap: MaweDom.multiSubtitleCrossTrackSnapToggle.checked });
});
MaweDom.multiSubtitleSelectBoundPairToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ selectBoundSubtitlePair: MaweDom.multiSubtitleSelectBoundPairToggle.checked });
});
MaweDom.multiSubtitleAutoSyncDurationToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ multiSubtitleAutoSyncDuration: MaweDom.multiSubtitleAutoSyncDurationToggle.checked });
});
MaweDom.multiSubtitleShowTrackBadgesToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ multiSubtitleShowTrackBadges: MaweDom.multiSubtitleShowTrackBadgesToggle.checked });
  MaweCoreState.waveformEditor?.render?.();
});
MaweDom.multiSubtitleSwapButton?.addEventListener('click', () => {
  MaweMultiImport.swapMainAndExtensionSubtitles();
});
MaweDom.multiSubtitleAlignButton?.addEventListener('click', () => {
  MaweBindingAlign.alignSelectedExtensionSubtitleRanges();
});
MaweAppearance.applySubtitleAppearance();
MaweAppearance.applyExtensionSubtitleAppearance();
syncAssModeControl();
syncAssStyleManager();
void loadAssStyleLibrary();
// 开/关由 createFloatingPanel 的 manageButton 点击切换接管，这里只负责标签页与关闭按钮。
MaweSettingsPanels.editorSettingsTabs.forEach((tab) => {
  tab.addEventListener('click', () => MaweSettingsPanels.setEditorSettingsActiveTab(tab));
  tab.addEventListener('keydown', (event) => {
    // 方向键只在可见分区之间循环；隐藏分区（如不可用的「保存」）不参与导航。
    const visibleTabs = MaweSettingsPanels.editorSettingsTabs.filter((item) => !item.hidden);
    const index = visibleTabs.indexOf(tab);
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      next = (index + 1) % visibleTabs.length;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = (index - 1 + visibleTabs.length) % visibleTabs.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = visibleTabs.length - 1;
    }
    if (next < 0) return;
    event.preventDefault();
    MaweSettingsPanels.setEditorSettingsActiveTab(visibleTabs[next], { focus: true });
  });
});
MaweDom.editorSettingsClose?.addEventListener('click', () => MaweSettingsPanels.setEditorSettingsPanelOpen(false));
MaweDom.mergeJoinSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setMergeJoinSettingsPanelOpen(MaweDom.mergeJoinSettingsPanel?.hidden);
});
MaweDom.splitTrimSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setSplitTrimSettingsPanelOpen(MaweDom.splitTrimSettingsPanel?.hidden);
});
MaweDom.cueListSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setCueListSettingsPanelOpen(MaweDom.cueListSettingsPanel?.hidden);
});
MaweDom.waveformSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setWaveformSettingsPanelOpen(MaweDom.waveformSettingsPanel?.hidden);
});
MaweDom.cueEditorSettingsToggle?.addEventListener('click', (event) => {
  event.stopPropagation();
  MaweSettingsPanels.setCueEditorSettingsPanelOpen(MaweDom.cueEditorSettingsPanel?.hidden);
});
document.addEventListener('pointerdown', (event) => {
  if (MaweSelection.temporaryVisibleSplitCueKeys.size) {
    const targetCue = event.target instanceof Element ? event.target.closest('.cue') : null;
    if (!MaweCueElements.cueElementHasTemporarySplitVisibility(targetCue)) {
      MaweCueElements.clearTemporaryVisibleSplitCues();
      MaweSearch.applySearch(MaweDom.searchEl.value);
    }
  }
  if (!MaweDom.cueListSettingsPanel?.hidden && !MaweDom.cueListSettings?.contains(event.target)) {
    MaweSettingsPanels.setCueListSettingsPanelOpen(false);
  }
  if (!MaweDom.waveformSettingsPanel?.hidden && !MaweDom.waveformSettings?.contains(event.target)) {
    MaweSettingsPanels.setWaveformSettingsPanelOpen(false);
  }
  if (!MaweDom.cueEditorSettingsPanel?.hidden && !MaweDom.cueEditorSettings?.contains(event.target)) {
    MaweSettingsPanels.setCueEditorSettingsPanelOpen(false);
  }
  if (!MaweDom.mergeJoinSettingsPanel?.hidden && !MaweDom.mergeJoinSettings?.contains(event.target)) {
    MaweSettingsPanels.setMergeJoinSettingsPanelOpen(false);
  }
  if (!MaweDom.splitTrimSettingsPanel?.hidden && !MaweDom.splitTrimSettings?.contains(event.target)) {
    MaweSettingsPanels.setSplitTrimSettingsPanelOpen(false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!MaweDom.cueListSettingsPanel?.hidden) {
    MaweSettingsPanels.setCueListSettingsPanelOpen(false);
    MaweDom.cueListSettingsToggle?.focus();
  }
  if (!MaweDom.waveformSettingsPanel?.hidden) {
    MaweSettingsPanels.setWaveformSettingsPanelOpen(false);
    MaweDom.waveformSettingsToggle?.focus();
  }
  if (!MaweDom.cueEditorSettingsPanel?.hidden) {
    MaweSettingsPanels.setCueEditorSettingsPanelOpen(false);
    MaweDom.cueEditorSettingsToggle?.focus();
  }
  if (!MaweDom.mergeJoinSettingsPanel?.hidden) {
    MaweSettingsPanels.setMergeJoinSettingsPanelOpen(false);
    MaweDom.mergeJoinSettingsToggle?.focus();
  }
  if (!MaweDom.splitTrimSettingsPanel?.hidden) {
    MaweSettingsPanels.setSplitTrimSettingsPanelOpen(false);
    MaweDom.splitTrimSettingsToggle?.focus();
  }
});
window.addEventListener('resize', MaweSettingsPanels.positionMergeJoinSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionMergeJoinSettingsPanel, true);
window.addEventListener('resize', MaweSettingsPanels.positionSplitTrimSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionSplitTrimSettingsPanel, true);
window.addEventListener('resize', MaweSettingsPanels.positionCueListSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionCueListSettingsPanel, true);
window.addEventListener('resize', MaweSettingsPanels.positionWaveformSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionWaveformSettingsPanel, true);
window.addEventListener('resize', MaweSettingsPanels.positionCueEditorSettingsPanel);
window.addEventListener('scroll', MaweSettingsPanels.positionCueEditorSettingsPanel, true);
MaweDom.cueListSettings?.closest('.cue-list-toolbar')?.addEventListener(
  'scroll', MaweSettingsPanels.positionCueListSettingsPanel,
);
MaweDom.waveformSettings?.closest('.waveform-toolbar')?.addEventListener(
  'scroll', MaweSettingsPanels.positionWaveformSettingsPanel,
);
MaweDom.cueEditorSettings?.closest('.cue-editor-toolbar')?.addEventListener(
  'scroll', MaweSettingsPanels.positionCueEditorSettingsPanel,
);
// 帮助浮窗：与拼合字幕共用 createFloatingPanel（拖动、位置持久化、Esc 关闭）

// 帮助是非模态浮窗；鼠标点击后的按钮焦点由统一的快捷键焦点处理释放。
MaweDom.helpCloseButton?.addEventListener('click', () => MaweHelpPanel.helpFloatingPanel.close());
MaweDom.helpOpenWaveformSettingsButtons.forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    MaweSettingsPanels.setWaveformSettingsPanelOpen(true);
    MaweDom.waveformSettingsToggle?.focus();
  });
});
// 帮助中的「全局设置」入口：打开设置窗口并定位到「视频预览」分区。

MaweDom.exportOpenSubtitleColorSettingsButton?.addEventListener('click', (event) => {
  event.preventDefault();
  MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-subtitle-color');
});
MaweDom.splitMultiSubtitleSettingsLink?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  MaweDom.multiSubtitleSettingsToggle?.click();
  MaweDom.multiSubtitleSettingsToggle?.focus();
});
MaweDom.helpOpenMediaSettingsButtons.forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-subtitle-preview');
  });
});
// 帮助中的「⚙️全局设置」入口：定位到「通用操作」分区（波形操作/按键/空隙设置所在）。
helpOpenEditorSettingsButtons.forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-general');
  });
});
MaweDom.helpOpenGapRemovePanelButton?.addEventListener('click', (event) => {
  event.preventDefault();
  MaweGapRemoveUi.openGapRemovePanel();
  MaweDom.gapRemoveManageButton?.focus();
});




MaweDom.helpTabButtons.forEach((button) => {
  button.addEventListener('click', () => MaweHelpPanel.selectHelpTab(button.dataset.helpTab));
  button.addEventListener('keydown', (event) => {
    const availableButtons = MaweHelpPanel.visibleHelpTabButtons();
    const index = availableButtons.indexOf(button);
    if (index < 0) return;
    let nextIndex = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % availableButtons.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + availableButtons.length) % availableButtons.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = availableButtons.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    MaweHelpPanel.selectHelpTab(availableButtons[nextIndex].dataset.helpTab, { focus: true });
  });
});
if (MaweDom.helpTabButtons.length && MaweDom.helpTabPanels.length) {
  MaweHelpPanel.selectHelpTab(MaweDom.helpTabButtons.find((button) => button.getAttribute('aria-selected') === 'true')?.dataset.helpTab || MaweDom.helpTabButtons[0].dataset.helpTab);
}

MaweDom.contextualHelpButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.closest('#gap-remove-panel')) MaweGapRemoveUi.closeGapRemovePanel();
    if (button.closest('#waveform-settings-panel')) MaweSettingsPanels.setWaveformSettingsPanelOpen(false);
    if (button.closest('#editor-settings-panel')) MaweSettingsPanels.setEditorSettingsPanelOpen(false);
    MaweHelpPanel.openHelpAtTab(button.dataset.helpTabTarget);
  });
});
// 浮窗尺寸：仅在用户拖过右下角缩放手柄后持久化；未缩放时保持 CSS 默认宽度/自动高度


if (MaweDom.helpPanel) {
  new ResizeObserver(() => {
    if (!MaweDom.helpPanel.classList.contains('show')) return;
    if (!MaweDom.helpPanel.style.width && !MaweDom.helpPanel.style.height) return;
    clearTimeout(MaweHelpPanel.helpPanelSizeSaveTimer);
    MaweHelpPanel.helpPanelSizeSaveTimer = setTimeout(() => {
      const rect = MaweDom.helpPanel.getBoundingClientRect();
      try {
        localStorage.setItem(MaweDom.HELP_PANEL_SIZE_KEY, JSON.stringify({
          width: Math.round(rect.width), height: Math.round(rect.height),
        }));
      } catch (_) {
        // file:// 隐私模式下 localStorage 可能被拒；缩放本身仍可用。
      }
    }, 250);
  }).observe(MaweDom.helpPanel);
}


// 明暗主题与界面强调色：令牌全部定义在 CSS，
// 这里只负责解析偏好、写 <html> 数据属性、持久化，以及通知波形重绘画布。












MaweTheme.applyEditorAccentColor(MaweSettings.EDITOR_SETTINGS.accentColor, { rerenderWaveform: false });
MaweTheme.applyTheme(MaweSettings.EDITOR_SETTINGS.theme, { rerenderWaveform: false });
MaweDom.editorThemeOptions.forEach((option) => {
  option.addEventListener('click', () => {
    const next = MaweTheme.normalizeEditorTheme(option.dataset.editorTheme);
    MaweSettings.updateEditorSettings({ theme: next });
    MaweTheme.applyTheme(next);
  });
});
MaweDom.editorAccentOptions.forEach((option) => {
  option.addEventListener('click', () => {
    if (MaweTheme.pendingEditorAccentCustomColor !== null) MaweTheme.flushEditorAccentCustomColor();
    const next = MaweSettings.normalizeEditorAccentColor(option.dataset.editorAccent);
    MaweSettings.updateEditorSettings({ accentColor: next });
    MaweTheme.applyEditorAccentColor(next);
  });
});
MaweDom.editorAccentCustomInput?.addEventListener('input', () => {
  const customColor = MaweSettings.normalizeEditorAccentCustomColor(MaweDom.editorAccentCustomInput.value);
  if (MaweDom.editorAccentCustomValue) MaweDom.editorAccentCustomValue.textContent = customColor;
  MaweTheme.scheduleEditorAccentCustomColor(customColor);
});
MaweDom.editorAccentCustomInput?.addEventListener('change', () => {
  MaweTheme.flushEditorAccentCustomColor(MaweDom.editorAccentCustomInput.value);
});


if (MaweTheme.editorSystemThemeMedia?.addEventListener) {
  MaweTheme.editorSystemThemeMedia.addEventListener('change', MaweTheme.refreshEditorSystemTheme);
} else {
  MaweTheme.editorSystemThemeMedia?.addListener?.(MaweTheme.refreshEditorSystemTheme);
}
MaweDom.splitKeySel.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ splitKey: MaweDom.splitKeySel.value });
  MaweSplitMode.refreshSplitKeyHelp();
});
MaweDom.splitUseWordTimestampsToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ splitUseWordTimestamps: MaweDom.splitUseWordTimestampsToggle.checked });
});
MaweDom.multiSubtitleSplitAutoSubmit?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ splitAutoSubmit: MaweDom.multiSubtitleSplitAutoSubmit.checked });
});
if (MaweDom.mergeJoinTextContinuousInput) MaweDom.mergeJoinTextContinuousInput.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ mergeJoinTextContinuous: MaweDom.mergeJoinTextContinuousInput.value });
});
if (MaweDom.mergeJoinTextWordInput) MaweDom.mergeJoinTextWordInput.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ mergeJoinTextWord: MaweDom.mergeJoinTextWordInput.value });
});
// 拆分移除符号：前 5 个高频符号用勾选 chip，其余走「其他符号」自由文本框
// （空格分隔）；两者合并后即时持久化并同步给共享工具层。










MaweSplitTrim.renderSplitTrimSymbolGrid();
MaweSplitTrim.refreshSplitTrimExtraInput();
MaweSplitTrim.splitTrimExtraInput?.addEventListener('change', () => {
  const extras = MULTI_SUBTITLE_UTILS.parseSplitTrimSymbolInput(MaweSplitTrim.splitTrimExtraInput.value);
  MaweSplitTrim.persistSplitTrimSymbols([...MaweSplitTrim.splitTrimPrimaryCheckedSet(), ...extras]);
  MaweSplitTrim.refreshSplitTrimExtraInput();
});
MaweSplitTrim.splitTrimSymbolsReset?.addEventListener('click', () => {
  const defaults = MULTI_SUBTITLE_UTILS.setSplitTrimSymbols(
    [...MULTI_SUBTITLE_UTILS.DEFAULT_SPLIT_TRIM_SYMBOLS],
  );
  MaweSettings.updateEditorSettings({ splitTrimSymbols: defaults });
  MaweSplitTrim.renderSplitTrimSymbolGrid();
  MaweSplitTrim.refreshSplitTrimExtraInput();
});
// 拼合字幕工具窗：参数即时持久化；number 输入 change 时把显示值回钳到合法区间。

MaweDom.autoMergeCloseButton?.addEventListener('click', () => MaweFloatingPanel.autoMergeFloatingPanel.close());
MaweDom.autoMergeRunButton?.addEventListener('click', MaweSegmentOps.autoMergeSegments);
MaweDom.autoMergeGapMsInput?.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ autoMergeGapMs: MaweSettings.clampAutoMergeGapMs(MaweDom.autoMergeGapMsInput.value) });
});
MaweDom.autoMergeGapMsInput?.addEventListener('change', () => {
  MaweDom.autoMergeGapMsInput.value = String(MaweSettings.EDITOR_SETTINGS.autoMergeGapMs);
});
MaweDom.autoMergeSnapDirectionSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({
    autoMergeSnapDirection: MaweDom.autoMergeSnapDirectionSelect.value === 'forward' ? 'forward' : 'backward',
  });
});
MaweDom.autoMergeAbsorbShortToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ autoMergeAbsorbShort: MaweDom.autoMergeAbsorbShortToggle.checked });
  MaweSegmentOps.syncAutoMergeAbsorbFields();
});
MaweDom.autoMergeShortCountInput?.addEventListener('input', () => {
  MaweSettings.updateEditorSettings({ autoMergeShortCount: MaweSettings.clampAutoMergeShortCount(MaweDom.autoMergeShortCountInput.value) });
});
MaweDom.autoMergeShortCountInput?.addEventListener('change', () => {
  MaweDom.autoMergeShortCountInput.value = String(MaweSettings.EDITOR_SETTINGS.autoMergeShortCount);
});
MaweDom.autoMergeAbsorbDirectionSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({
    autoMergeAbsorbDirection: MaweDom.autoMergeAbsorbDirectionSelect.value === 'next' ? 'next' : 'previous',
  });
});
MaweDom.autoMergePanel?.querySelectorAll('input[type="number"]').forEach((input) => {
  input.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    try {
      if (event.deltaY < 0) input.stepUp();
      else input.stepDown();
    } catch (_) {
      return;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });
});

MaweDom.subtitleExtendCloseButton?.addEventListener('click', () => MaweFloatingPanel.subtitleExtendFloatingPanel.close());
MaweDom.subtitleExtendRunButton?.addEventListener('click', MaweSegmentOps.extendSubtitleRanges);
MaweDom.subtitleExtendPanel?.querySelectorAll('input[type="number"]').forEach((input) => {
  input.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    try {
      if (event.deltaY < 0) input.stepUp();
      else input.stepDown();
    } catch (_) {
      return;
    }
  }, { passive: false });
});
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowIndexToggle, 'cueListShowIndex');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowTimeToggle, 'cueListShowTime');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowStickerToggle, 'cueListShowSticker');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListShowCharcountToggle, 'cueListShowCharcount');
MaweDisplaySettings.bindCueListDisplayToggle(MaweDom.cueListAutoScrollOnClickToggle, 'cueListAutoScrollOnClick');
MaweDom.cueListKeepSplitVisibleToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ cueListKeepSplitVisible: MaweDom.cueListKeepSplitVisibleToggle.checked });
  if (!MaweDom.cueListKeepSplitVisibleToggle.checked) MaweCueElements.clearTemporaryVisibleSplitCues();
  MaweSearch.applySearch(MaweDom.searchEl.value);
});
MaweDom.cueListCharcountThresholdInput?.addEventListener('input', () => {
  MaweCueElements.handleCharCountThresholdInput(MaweDom.cueListCharcountThresholdInput);
});
MaweDom.cueListCharcountThresholdInput?.addEventListener('change', () => {
  MaweCueElements.syncCharCountThresholdInputs();
  MaweCueElements.updateTimedTextEditSingleGuide();
});
MaweDom.timedTextEditCharcountThresholdInput?.addEventListener('input', () => {
  MaweCueElements.handleCharCountThresholdInput(MaweDom.timedTextEditCharcountThresholdInput);
});
MaweDom.timedTextEditCharcountThresholdInput?.addEventListener('change', () => {
  MaweCueElements.syncCharCountThresholdInputs();
  MaweCueElements.updateTimedTextEditSingleGuide();
});
MaweDisplaySettings.bindCueEditorDisplayToggle(MaweDom.cueEditorShowNavigationToggle, 'cueEditorShowNavigation');
MaweDisplaySettings.bindCueEditorDisplayToggle(MaweDom.cueEditorShowTimeActionsToggle, 'cueEditorShowTimeActions');
MaweDisplaySettings.bindCueEditorDisplayToggle(MaweDom.cueEditorShowStickerToggle, 'cueEditorShowSticker');
MaweDom.exportStartAtZeroToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportStartAtZero: MaweDom.exportStartAtZeroToggle.checked });
});
MaweDom.selectGroupMembersToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ selectGroupMembers: MaweDom.selectGroupMembersToggle.checked });
});
MaweDom.exportColorUnifiedToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportColorUnified: MaweDom.exportColorUnifiedToggle.checked });
});
MaweDom.exportSpeakerLabelsToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportSpeakerLabels: MaweDom.exportSpeakerLabelsToggle.checked });
});
MaweDom.exportSpeakerNamesAsSuffixToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ exportSpeakerNamesAsSuffix: MaweDom.exportSpeakerNamesAsSuffixToggle.checked });
});
MaweDom.clickBehaviorSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ clickBehavior: MaweSettings.normalizeClickBehavior(MaweDom.clickBehaviorSelect.value) });
  MaweBehaviorHints.refreshClickBehaviorHint();
});
MaweDom.clickTargetSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ clickTarget: MaweSettings.normalizeClickTarget(MaweDom.clickTargetSelect.value) });
});
pauseOnMouseClickToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ pauseOnMouseClick: pauseOnMouseClickToggle.checked });
});
MaweDom.keyboardOperationReferenceSelect?.addEventListener('change', () => {
  const mode = MaweSettings.normalizeKeyboardOperationReferenceMode(MaweDom.keyboardOperationReferenceSelect.value);
  MaweSettings.updateEditorSettings({ keyboardOperationReference: mode });
  MaweBehaviorHints.refreshKeyboardOperationReferenceHint();
});
MaweJklPlayback.jklPlaybackModeSelect?.addEventListener('change', () => {
  const wasReversePlaying = MaweJklPlayback.jklReversePlaying;
  MaweSettings.updateEditorSettings({ jklPlaybackMode: MaweSettings.normalizeJklPlaybackMode(MaweJklPlayback.jklPlaybackModeSelect.value) });
  MaweJklPlayback.stopJklReversePlayback({ render: false });
  MaweJklPlayback.jklPlaybackRate = 1;
  MaweCoreState.player.playbackRate = 1;
  if (wasReversePlaying) MawePlaybackLoop.update();
  MaweMediaPlayback.syncMediaControls();
  MaweJklPlayback.refreshJklPlaybackModeUi();
});
MaweDom.hoverSeekPreviewToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ hoverSeekPreview: MaweDom.hoverSeekPreviewToggle.checked });
});


























MaweDom.mediaSeekStepInput?.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  event.stopPropagation();
  MaweMediaStep.adjustMediaSeekStepInput(event.key === 'ArrowUp' ? 1 : -1);
});
MaweDom.mediaSeekStepInput?.addEventListener('wheel', (event) => {
  if (!event.deltaY) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDom.mediaSeekStepInput.focus({ preventScroll: true });
  MaweMediaStep.adjustMediaSeekStepInput(event.deltaY < 0 ? 1 : -1);
}, { passive: false });
MaweDom.mediaSeekStepInput?.addEventListener('input', () => {
  const raw = MaweDom.mediaSeekStepInput.value.trim();
  if (!raw) return;
  if (MaweTimeline.timelineIsFrameMode()) {
    MaweMediaStep.commitMediaSeekStepInput(raw, { rewriteInput: false });
    return;
  }
  const value = MaweSettings.normalizeNativeMediaSeekStepValue(raw, MaweDom.mediaSeekInputLastValue);
  if (value === null) return;
  MaweMediaStep.commitMediaSeekStepInput(value, { rewriteInput: value !== Number(raw) });
});
MaweDom.mediaSeekStepInput?.addEventListener('change', () => {
  MaweMediaStep.commitMediaSeekStepInput(MaweDom.mediaSeekStepInput.value);
});
MaweDom.cueMoveStepInput?.addEventListener('change', () => {
  const frameMode = MaweTimeline.timelineIsFrameMode();
  const value = frameMode
    ? EDITOR_SETTINGS_UTILS.clampTimelineFrameStep(MaweDom.cueMoveStepInput.value, 1)
    : MaweSettings.clampCueMoveStepMs(MaweDom.cueMoveStepInput.value);
  MaweDom.cueMoveStepInput.value = String(value);
  MaweSettings.updateEditorSettings(frameMode ? { cueMoveStepFrames: value } : { cueMoveStepMs: value });
});
MaweDom.timelineTimebaseSelect?.addEventListener('change', () => {
  MaweTimeline.setTimelineTimebase({ unit: MaweDom.timelineTimebaseSelect.value });
});
MaweDom.timelineFpsInput?.addEventListener('change', () => {
  MaweTimeline.setTimelineTimebase({ fps: MaweDom.timelineFpsInput.value });
});
MaweDom.timelineSnapToFrameToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ timelineSnapToFrame: MaweDom.timelineSnapToFrameToggle.checked });
  MaweCoreState.waveformEditor?.refreshPointerLine?.();
});
MaweDom.timelineTimecodeSeparatorInput?.addEventListener('change', () => {
  const separator = MaweTimeline.normalizeTimelineTimecodeSeparator(MaweDom.timelineTimecodeSeparatorInput.value);
  MaweDom.timelineTimecodeSeparatorInput.value = separator;
  MaweSettings.updateEditorSettings({ timelineTimecodeSeparator: separator });
  MaweTimeline.refreshTimelineSettingsUi();
  MaweCoreState.waveformEditor?.refreshPointerLine?.();
  // 时间码分隔符会影响字幕列表里的时间范围文本；设置变更后立即重建列表，
  // 不必等到下一次字幕编辑操作才看到新格式。
  MaweCuePanel.renderAll({ waveform: 'none' });
});
MaweDom.autoSnapAdjacentCuesToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ autoSnapAdjacentCues: MaweDom.autoSnapAdjacentCuesToggle.checked });
});
// 贴合字幕边界模式：dual（中缝联动，新默认）/ classic（自动吸附开关 + Alt 反转）。
// classic 下保留“自动吸附调整相邻字幕”开关；dual 下该开关只影响键盘微调，
// 鼠标手柄始终独立，联动交给波形上的中缝拖动区，因此隐藏开关行避免误解。

MaweDom.adjacentBoundaryModeSelect?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({
    adjacentBoundaryMode: MaweDom.adjacentBoundaryModeSelect.value === 'classic' ? 'classic' : 'dual',
  });
  MaweTimeline.refreshAdjacentBoundaryModeUi();
  MaweCoreState.waveformEditor?.refreshCueOverlay?.();
});
MaweDom.cueEditorCancelOnEscapeToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ cueEditorCancelOnEscape: MaweDom.cueEditorCancelOnEscapeToggle.checked });
});
MaweDom.ninjaModeToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaMode: MaweDom.ninjaModeToggle.checked });
  MaweNinja.applyNinjaSettings();
});
MaweDom.ninjaSoundToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSound: MaweDom.ninjaSoundToggle.checked });
});
MaweDom.ninjaSlashEffectToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSlashEffect: MaweDom.ninjaSlashEffectToggle.checked });
  MaweNinja.applyNinjaSettings();
});
MaweDom.ninjaSlashLengthInput?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSlashLengthPercent: MaweSettings.clampNinjaSlashLength(MaweDom.ninjaSlashLengthInput.value) });
  MaweDom.ninjaSlashLengthInput.value = String(MaweSettings.EDITOR_SETTINGS.ninjaSlashLengthPercent);
});
MaweDom.ninjaSlashRotateInput?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ ninjaSlashRotateAmplitude: MaweSettings.clampNinjaSlashRotateAmplitude(MaweDom.ninjaSlashRotateInput.value) });
  MaweDom.ninjaSlashRotateInput.value = String(MaweSettings.EDITOR_SETTINGS.ninjaSlashRotateAmplitude);
});
MaweDom.subtitleFontSizeSelect?.addEventListener('change', () => {
  const value = MaweDom.subtitleFontSizeSelect.value;
  MaweHistory.pushPreviewUndo('调整字幕字号', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ font_size: value === 'auto' ? null : Number(value) });
});
subtitleFontFamilyInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整字幕字体', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ font_family: MaweAppearance.subtitleFontFamilyInputToStored(subtitleFontFamilyInput.value) });
  MaweAppearance.syncSubtitleAppearanceControls();
});
assColorStyleSelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整 ASS 颜色字幕样式', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ ass_color_style: assColorStyleSelect.value });
  MawePlaybackLoop.update();
});
MaweColors.subtitleColorPaletteEnabledInput?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ subtitleColorPaletteEnabled: MaweColors.subtitleColorPaletteEnabledInput.checked });
  MaweColors.syncSubtitleColorPaletteControls();
  MaweColors.refreshSubtitleColorPalettePresentation();
  if (!MaweColors.subtitleColorPaletteEnabledInput.checked) MaweHint.flashHint('已恢复内置字幕颜色', 'success');
});


MaweDom.subtitleBackgroundColorInput?.addEventListener('input', () => MaweAppearanceInputs.applySubtitleBackgroundColorInput());
MaweDom.subtitleBackgroundColorInput?.addEventListener('change', () => MaweAppearanceInputs.applySubtitleBackgroundColorInput({ finalize: true }));


MaweDom.subtitleBackgroundAlphaInput?.addEventListener('input', () => MaweAppearanceInputs.applySubtitleBackgroundAlphaInput());
MaweDom.subtitleBackgroundAlphaInput?.addEventListener('change', () => MaweAppearanceInputs.applySubtitleBackgroundAlphaInput({ finalize: true }));
MaweDom.subtitleFontFamilyScanButton?.addEventListener('click', () => {
  void MaweAppearance.scanSubtitleLocalFonts();
});
document.addEventListener('mawe:languagechange', () => {
  MaweAppearance.renderSubtitleFontFamilyStatus();
  MaweAppearance.relabelSubtitleFontFamilyOptions();
});
MaweDom.subtitleColorInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整主字幕颜色', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ color: MaweDom.subtitleColorInput.value });
  MawePlaybackLoop.update();
});
MaweDom.subtitleColorUnderlineInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('切换预览字幕颜色下划线', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ color_underline: MaweDom.subtitleColorUnderlineInput.checked });
  MawePlaybackLoop.update();
});
// 提示中的「ASS 字幕模式」是链接：跳到设置窗口的「字幕样式」tab。
subtitleColorAssModeHintLink?.addEventListener('click', () => {
  MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-subtitle-style');
});
assColorSpeakerExportLink?.addEventListener('click', (event) => {
  event.preventDefault();
  MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-export');
  MaweDom.exportSpeakerLabelsToggle?.focus();
});
MaweDom.subtitleColorStyleSelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整预览字幕颜色样式', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ color_style: MaweDom.subtitleColorStyleSelect.value });
  MawePlaybackLoop.update();
});



Object.entries(MaweDom.subtitleSpeakerLabelInputs).forEach(([color, input]) => {
  input?.addEventListener('input', () => MaweSpeakerLabels.applySpeakerLabelInput(color));
  input?.addEventListener('change', () => MaweSpeakerLabels.applySpeakerLabelInput(color, { finalize: true }));
});

MaweDom.subtitleSpeakerLabelSeparatorInput?.addEventListener('input', () => MaweSpeakerLabels.applySpeakerLabelSeparatorInput());
MaweDom.subtitleSpeakerLabelSeparatorInput?.addEventListener(
  'change',
  () => MaweSpeakerLabels.applySpeakerLabelSeparatorInput({ finalize: true }),
);
MaweDom.subtitleSpeakerMappingEnabledInput?.addEventListener('change', () => {
  const previous = MaweHistory.snapshotPreviewState();
  previous.speakerLabels.mapping_enabled = !MaweDom.subtitleSpeakerMappingEnabledInput.checked;
  MaweHistory.pushPreviewUndo('切换颜色说话人映射', previous);
  const mappingEnabled = MaweDom.subtitleSpeakerMappingEnabledInput.checked;
  MaweSpeakerLabels.setSpeakerLabelSettings({
    ...MaweSpeakerLabels.getSpeakerLabelSettings(),
    mapping_enabled: mappingEnabled,
  });
  if (mappingEnabled) {
    MaweSettings.updateEditorSettings({ exportSpeakerLabels: true });
    if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = true;
  }
  MawePlaybackLoop.update();
});
MaweDom.subtitleSpeakerLabelsEnabledInput?.addEventListener('change', () => {
  const previous = MaweHistory.snapshotPreviewState();
  previous.speakerLabels.enabled = !MaweDom.subtitleSpeakerLabelsEnabledInput.checked;
  MaweHistory.pushPreviewUndo('切换说话人名称预览', previous);
  MaweSpeakerLabels.setSpeakerLabelSettings({
    ...MaweSpeakerLabels.getSpeakerLabelSettings(),
    enabled: MaweDom.subtitleSpeakerLabelsEnabledInput.checked,
  });
  // 显示开关改变时同步 SRT 附加选项；导出开关仍可在全局设置中独立调整。
  const speakerLabelsEnabled = MaweDom.subtitleSpeakerLabelsEnabledInput.checked;
  MaweSettings.updateEditorSettings({ exportSpeakerLabels: speakerLabelsEnabled });
  if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = speakerLabelsEnabled;
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleFontSizeSelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕字号', MaweHistory.snapshotPreviewState());
  const value = MaweDom.extensionSubtitleFontSizeSelect.value;
  MaweAppearance.setExtensionSubtitleAppearance({ font_size: value === 'auto' ? null : Number(value) });
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleFontFamilySelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕字体', MaweHistory.snapshotPreviewState());
  MaweAppearance.setExtensionSubtitleAppearance({ font_family: MaweDom.extensionSubtitleFontFamilySelect.value });
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleColorInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕颜色', MaweHistory.snapshotPreviewState());
  MaweAppearance.setExtensionSubtitleAppearance({ color: MaweDom.extensionSubtitleColorInput.value });
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleBackgroundColorInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕背景色', MaweHistory.snapshotPreviewState());
  MaweAppearance.setExtensionSubtitleAppearance({ background_color: MaweDom.extensionSubtitleBackgroundColorInput.value });
  MawePlaybackLoop.update();
});


MaweDom.extensionSubtitleBackgroundAlphaInput?.addEventListener('input', () => MaweAppearanceInputs.applyExtensionSubtitleBackgroundAlphaInput());
MaweDom.extensionSubtitleBackgroundAlphaInput?.addEventListener('change', () => MaweAppearanceInputs.applyExtensionSubtitleBackgroundAlphaInput({ finalize: true }));
MaweDom.extensionOverlayToggle?.addEventListener('change', () => {
  const previous = MaweHistory.snapshotPreviewState();
  previous.extensionOverlay = !MaweDom.extensionOverlayToggle.checked;
  MaweHistory.pushPreviewUndo('切换副字幕预览', previous);
  MaweSettings.updateEditorSettings({ extensionOverlayEnabled: MaweDom.extensionOverlayToggle.checked });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  MawePlaybackLoop.update();
});


MaweBehaviorHints.refreshClickBehaviorHint();
document.addEventListener('mawe:languagechange', MaweBehaviorHints.refreshClickBehaviorHint);



MaweBehaviorHints.refreshKeyboardOperationReferenceHint();
document.addEventListener('mawe:languagechange', MaweBehaviorHints.refreshKeyboardOperationReferenceHint);



MaweJklPlayback.refreshJklPlaybackModeUi();
document.addEventListener('mawe:languagechange', MaweJklPlayback.refreshJklPlaybackModeUi);

















































// 可拖动非模态工具窗（移除静音空隙 / 拼合字幕共用模式）：
// 负责显示/隐藏、工具栏按钮 active 态、标题栏拖动与位置持久化、窗口缩放回钳、Esc 关闭。






























MaweDom.gapRemoveDragHandle?.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return;
  const rect = MaweDom.gapRemovePanel.getBoundingClientRect();
  MaweCuePanelState.gapRemovePanelDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
  MaweDom.gapRemovePanel.classList.add('dragging');
  MaweDom.gapRemoveDragHandle.setPointerCapture?.(event.pointerId);
  event.preventDefault();
});
MaweDom.gapRemoveDragHandle?.addEventListener('pointermove', (event) => {
  if (!MaweCuePanelState.gapRemovePanelDrag || event.pointerId !== MaweCuePanelState.gapRemovePanelDrag.pointerId) return;
  event.preventDefault();
  MaweGapRemoveUi.setGapRemovePanelPosition(
    event.clientX - MaweCuePanelState.gapRemovePanelDrag.offsetX,
    event.clientY - MaweCuePanelState.gapRemovePanelDrag.offsetY,
  );
});
MaweDom.gapRemoveDragHandle?.addEventListener('pointerup', MaweGapRemoveUi.finishGapRemovePanelDrag);
MaweDom.gapRemoveDragHandle?.addEventListener('pointercancel', MaweGapRemoveUi.finishGapRemovePanelDrag);

MaweDom.gapRemovePanel?.querySelectorAll('input[type="number"]').forEach((input) => {
  input.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    try {
      if (event.deltaY < 0) input.stepUp();
      else input.stepDown();
    } catch (_) {
      return;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });
});

MaweDom.gapRemoveManageButton?.addEventListener('click', MaweGapRemoveUi.toggleGapRemovePanel);
MaweDom.gapRemoveScanButton?.addEventListener('click', MaweGapRemoveUi.scanAndRemoveGaps);
MaweDom.gapRemoveShrinkButton?.addEventListener('click', MaweGapRemoveUi.shrinkExistingGaps);
MaweDom.gapRemoveClearAllButton?.addEventListener('click', MaweGapRemoveUi.clearAllGaps);
MaweDom.gapRemoveCloseButton?.addEventListener('click', MaweGapRemoveUi.closeGapRemovePanel);
MaweDom.gapRemoveOperationMode?.addEventListener('change', () => {
  const state = MaweGapRemoveData.getGapRemoveData(true);
  const nextMode = window.AsrGapRemoveCore.normalizeGapOperationMode(MaweDom.gapRemoveOperationMode.value);
  if (state.operation_mode === nextMode) return;
  MaweHistory.pushGapRemoveUndo('切换空隙操作方式');
  state.operation_mode = nextMode;
  MaweGapRemoveUi.setGapRemoveData(state);
});
MaweDom.gapRemoveAdvancedToggle?.addEventListener('click', () => {
  MaweGapRemoveUi.setGapRemoveAdvancedOpen(!MaweGapRemoveUi.gapRemoveAdvancedIsOpen());
});
MaweDom.gapRemoveDisableToggle?.addEventListener('click', () => {
  MaweGapRemoveUi.setGapRemoveDisableOpen(!MaweGapRemoveUi.gapRemoveDisableIsOpen());
});
MaweDom.gapRemoveDisableCoverage?.addEventListener('change', MaweGapRemoveUi.commitGapRemoveDisableSettings);
MaweDom.gapRemoveDisableRemaining?.addEventListener('change', MaweGapRemoveUi.commitGapRemoveDisableSettings);
MaweDom.gapRemoveDisableButton?.addEventListener('click', MaweGapRemoveUi.disableSubtitlesInRemovedGaps);
MaweDom.gapRemoveHysteresis?.addEventListener('input', MaweGapRemoveUi.updateGapRemoveHysteresisHint);
window.addEventListener('resize', () => {
  if (!MaweGapRemoveUi.gapRemovePanelIsOpen()) return;
  const rect = MaweDom.gapRemovePanel.getBoundingClientRect();
  MaweGapRemoveUi.setGapRemovePanelPosition(rect.left, rect.top, { persist: true });
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweGapRemoveUi.gapRemovePanelIsOpen() || MaweInlineEdit.editingState) return;
  event.preventDefault();
  MaweGapRemoveUi.closeGapRemovePanel();
});
MaweDom.gapRemoveSkipPlayback?.addEventListener('change', () => {
  const state = MaweGapRemoveData.getGapRemoveData(true) || { gaps: [] };
  if (state.skip_playback === MaweDom.gapRemoveSkipPlayback.checked) return;
  MaweHistory.pushGapRemoveUndo('切换空隙跳过播放');
  state.skip_playback = MaweDom.gapRemoveSkipPlayback.checked;
  MaweGapRemoveUi.setGapRemoveData(state);
  if (!state.skip_playback) MaweCuePanelState.gapPreviewRange = null;
});



// 合成表情包文件的 URL（用于 <img src>）
// 优先级:


//   1) sticker.rel + STICKER_ROOT  - 拼出服务器或 file:// URL
//   2) sticker.path  - 兼容老版工程


// 合成表情包文件的操作系统绝对路径（用于导出表情包 OTIO）。



const selectedOverlayIdxs = new Set();
  // 用于 Shift+click 范围选

let lastClickedOverlayIdx = -1;

// 已选计数涵盖主轨/副轨/叠加轨三个选区集。
function updateSelectionCountText() {
  MaweDom.selCountEl.textContent = String(
    MaweSelection.selectedIdxs.size + MaweSelection.selectedExtensionIdxs.size + selectedOverlayIdxs.size,
  );
}
// “仅看超长”开启时，刚拆出的字幕临时绕过字数过滤；使用稳定 ID，避免 splice 后下标错位。

// 右键选择「绑定到主字幕」后的等待状态。使用稳定 ID 而不是数组下标，
// 这样等待期间即使列表重绘，也不会把另一条副字幕误绑定过去。

// 隐藏开关开启时，禁用项视为"不可选"（Shift 范围选 / Ctrl 切换都跳过）












// 联动选中只补充另一轨的选中集合，不切换当前字幕编辑区；编辑区焦点仍由用户最后点击的字幕决定。












// 选中全部字幕（跳过「隐藏禁用项」开启时的禁用条目，与其它选择逻辑一致）。

// 返回与 idx 同属一个表情包/颜色分组的全部字幕下标（含 idx 自身）。
// head 持有 sticker/color，成员持 sticker_ref/color_ref 指向 head。

// 普通单击字幕时的选择逻辑：开启「同时选中分组内项目」且属于分组时选整组，否则只选本行。
















// === 渲染 ===
















function setCurrentCuePanelOverlayIndex(index) {
  MaweCuePanel.setCuePanelTarget('overlay', index);
}


























MaweDom.cuePanelPrev?.addEventListener('click', () => MaweCuePanel.navigateCuePanel(-1));
MaweDom.cuePanelNext?.addEventListener('click', () => MaweCuePanel.navigateCuePanel(1));
MaweDom.cuePanelText?.addEventListener('focus', MaweCuePanel.captureCuePanelTextEditSnapshot);
MaweDom.cuePanelText?.addEventListener('keydown', (event) => {
  // Esc：按当前字幕编辑区设置决定取消还是提交文本编辑。
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (MaweSettings.EDITOR_SETTINGS.cueEditorCancelOnEscape) MaweCuePanel.cancelCuePanelTextEdit();
    else MaweCuePanel.exitCuePanelEdit();
    return;
  }
  const action = MaweCueEvents.getConfiguredEnterAction(event);
  if (!action || action === 'newline') return;
  event.preventDefault();
  event.stopPropagation();
  if (action === 'split') MaweCuePanel.splitCuePanelAtCursor();
  else MaweCuePanel.exitCuePanelEdit();
});
MaweDom.cuePanelText?.addEventListener('input', () => {
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  if (!target) return;
  const cueListAnchor = MaweCueListAnchor.captureCueListRenderAnchor();
  MaweCuePanel.ensureCuePanelUndo(target.kind === 'extension' ? '编辑副字幕' : '编辑当前字幕');
  const seg = target.segment;
  seg.text = MaweDom.cuePanelText.value.replace(/\r\n?/g, '\n');
  seg._dirty = true;
  if (target.kind === 'extension') MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweServerSave.scheduleAutoSaveFlush();
  const splitMode = target.kind === 'extension'
    ? MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(target.track, seg)
    : MaweMultiSubtitleCore.getMainSubtitleSplitMode(seg);
  const metrics = window.AsrEditorUtils.cueMetrics(
    seg.text, seg.start, seg.end, splitMode,
  );
  MaweDom.cuePanelTotalLength.textContent = String(metrics.totalLength);
  MaweDom.cuePanelCharsPerSecond.textContent = metrics.charsPerSecond.toFixed(2);
  const textEl = MaweCuePanel.getCuePanelTextElement(target);
  if (textEl) {
    MaweCueElements.setTextHtml(textEl, seg.text, MaweDom.searchEl.value);
    MaweCueElements.applyCharCount(textEl.closest('.cue')?.querySelector('.charcount'), seg.text, splitMode);
  }
  if (target.kind === 'extension') MaweCoreState.waveformEditor?.refreshExtensionCueLabel(target.index, target.trackId);
  else if (target.kind === 'overlay') MaweCoreState.waveformEditor?.refreshCueOverlay();
  else MaweCoreState.waveformEditor?.refreshCueLabel(target.index);
  MawePlaybackLoop.refreshSubtitlePreview();
  MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
});
MaweDom.cuePanelText?.addEventListener('blur', () => {
  if (MaweCuePanelState.cuePanelCanceling) return;
  MaweCuePanel.commitCuePanelEdit();
});
MaweDom.cuePanelStart?.addEventListener('change', () => MaweCuePanel.commitCuePanelEdit());
MaweDom.cuePanelDuration?.addEventListener('change', () => MaweCuePanel.commitCuePanelEdit());
MaweDom.cuePanelAddSticker?.addEventListener('click', () => {
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  if (target?.kind === 'main') MaweStickerPicker.openStickerPicker([target.index], false);
  else if (target?.kind === 'overlay') MaweStickerPicker.openStickerPicker([target.index], false, { overlay: true });
});
MaweDom.cuePanelSticker?.addEventListener('click', () => {
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  if (target?.kind === 'main') MaweStickerPicker.openStickerPicker([target.index], false);
  else if (target?.kind === 'overlay') MaweStickerPicker.openStickerPicker([target.index], false, { overlay: true });
});
MaweDom.cuePanelSticker?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  if (target?.kind !== 'main') return;
  MaweStickerPicker.removeStickerCascade(target.index);
  MaweCuePanel.renderAll();
  MaweHint.flashHint('已删除当前表情包', 'success');
});
MaweDom.cuePanelSplit?.addEventListener('click', MaweCuePanel.splitCuePanelAtCursor);













// 叠加字幕行选中高亮与选中计数统一同步：叠加轨没有 multi-cue 类，
// 不能走 updateMultiSelectionClasses，这里按 data-overlay-idx 直接同步。
function syncOverlaySelectionClasses() {
  MaweCoreState.container.querySelectorAll('.cue[data-overlay-idx].selected').forEach((el) => {
    if (!selectedOverlayIdxs.has(Number(el.dataset.overlayIdx))) el.classList.remove('selected');
  });
  selectedOverlayIdxs.forEach((index) => {
    MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`)?.classList.add('selected');
  });
  updateSelectionCountText();
}

function selectOverlayCueRow(index, { focusEditor = false } = {}) {
  // 与副字幕 selectOnlyExtension 同一逻辑：点击叠加字幕先清空主轨/副轨
  // 已有选区（clearSelection 同时取消待绑定状态），再单独选中本轨字幕。
  MaweCuePanel.commitCuePanelEdit();
  MaweSelection.clearSelection({ silent: true });
  selectedOverlayIdxs.add(index);
  lastClickedOverlayIdx = index;
  MaweCuePanel.setCuePanelTarget('overlay', index);
  if (focusEditor) MaweCuePanel.focusCuePanelText(index, 'overlay');
  syncOverlaySelectionClasses();
  MaweCoreState.waveformEditor?.updateSelection();
  const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`);
  if (row) MaweCueListAnchor.scrollCueIntoViewIfNeeded(row);
}

function selectOverlayRange(fromIndex, toIndex) {
  const segments = getOverlayTrack()?.segments || [];
  const from = Math.max(0, Math.min(fromIndex, toIndex));
  const to = Math.min(segments.length - 1, Math.max(fromIndex, toIndex));
  selectedOverlayIdxs.clear();
  for (let index = from; index <= to; index += 1) {
    if (MaweSelection.isHiddenDisabled(index, getOverlayTrack())) continue;
    selectedOverlayIdxs.add(index);
  }
  MaweCuePanel.setCuePanelTarget('overlay', toIndex);
  syncOverlaySelectionClasses();
  MaweCoreState.waveformEditor?.updateSelection();
  const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${toIndex}"]`);
  if (row) MaweCueListAnchor.scrollCueIntoViewIfNeeded(row);
}

function toggleOverlaySelection(index) {
  if (MaweSelection.isHiddenDisabled(index, getOverlayTrack())) return;  // 隐藏禁用项不参与选择
  const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`);
  if (selectedOverlayIdxs.has(index)) {
    selectedOverlayIdxs.delete(index);
    row?.classList.remove('selected');
  } else {
    selectedOverlayIdxs.add(index);
    row?.classList.add('selected');
  }
  lastClickedOverlayIdx = index;
  // 与副字幕 Ctrl 多选一致：面板跟随被切换的字幕，便于继续编辑。
  MaweCuePanel.setCuePanelTarget('overlay', index);
  updateSelectionCountText();
  MaweCoreState.waveformEditor?.updateSelection();
}

function buildOverlayCueEl(seg, index) {
  const el = MaweCueElements.buildCueEl(seg, index, { overlayTrack: true });
  el.classList.add('overlay-track-cue');
  el.dataset.overlayIdx = String(index);
  el.removeAttribute('data-idx');
  el.classList.toggle('selected', selectedOverlayIdxs.has(index));
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.shiftKey && lastClickedOverlayIdx >= 0) {
      selectOverlayRange(lastClickedOverlayIdx, index);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      toggleOverlaySelection(index);
      return;
    }
    selectOverlayCueRow(index);
    const segment = getOverlayTrack()?.segments?.[index];
    if (!segment) return;
    const previousSuppress = MawePlaybackLoop.suppressCueListAutoScroll;
    // 与副字幕一致：点击后的 seek 会同步刷新主字幕 active 状态；这次刷新不能把
    // 列表从刚点击的叠加字幕行再次滚到对应的主字幕行。
    const wasPlaying = isPlaybackActive();
    MawePlaybackLoop.suppressCueListAutoScroll = true;
    try {
      MaweCoreState.waveformEditor?.revealTime(segment.start, true);
      if (MaweSettings.EDITOR_SETTINGS.clickBehavior !== 'select-only') {
        MaweTextCleanup.seekFromWaveform(segment.start / 1000, { mouseClick: true });
      }
    } finally {
      MawePlaybackLoop.suppressCueListAutoScroll = previousSuppress;
    }
    if (MaweSettings.EDITOR_SETTINGS.clickBehavior === 'select-and-play' && MaweCoreState.player.paused && !wasPlaying) MaweMediaPlayback.togglePlayback();
    if (MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick) {
      const row = MaweCoreState.container.querySelector(`.cue[data-overlay-idx="${index}"]`);
      if (row) MaweCueListAnchor.scrollCueToCenter(row);
    }
  });
  el.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectOverlayCueRow(index, { focusEditor: true });
  });
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showOverlayContextMenu(event.clientX, event.clientY, index);
  });
  return el;
}













// === 字数 ===





















// === 颜色过滤 ===
// 工程中存在彩色字幕时，在过滤输入框右侧显示 🎨 按钮：
// 点击行（非 checkbox）= 只显示该颜色；勾选 checkbox = 多选；清除 = 全部显示。




 // null = 不过滤；Set<string> = 仅显示这些颜色键




// 双列 / 仅副轨显示模式下，列表行不携带颜色条：按钮隐藏且过滤暂停生效，
// 避免出现“看不到过滤开关但列表被过滤”的死角。只有单列主轨列表参与过滤。




























MaweColorFilter.renderColorFilterMenu();

MaweExportMenus.bindToolbarExportDropdown(
  'color-filter-dropdown', 'color-filter-btn', 'color-filter-menu',
  MaweColorFilter.positionColorFilterMenu,
);

// === 搜索 ===




MaweDom.searchEl.addEventListener('input', () => {
  MaweSearch.refreshSearchClearVisibility();
  clearTimeout(MaweSearch.searchDebounce);
  MaweSearch.searchDebounce = setTimeout(() => MaweSearch.applySearch(MaweDom.searchEl.value), 100);
});
document.getElementById('search-clear')?.addEventListener('click', () => {
  MaweDom.searchEl.value = '';
  MaweSearch.refreshSearchClearVisibility();
  MaweSearch.applySearch('');
  MaweDom.searchEl.focus({ preventScroll: true });
});

// === 编辑 ===























// === 拆分 ===








function fallbackSplitOffset(text, requestedOffset = null) {
  const length = String(text || '').length;
  if (!length) return null;
  if (length <= 1) return 0;
  const requested = Number.isFinite(Number(requestedOffset))
    ? Math.round(Number(requestedOffset)) : Math.floor(length / 2);
  return Math.max(1, Math.min(length - 1, requested));
}

function splitOffsetNearTimeForModal(segment, timeMs, splitMode) {
  const offset = MaweSplitCore.splitOffsetNearTime(segment, timeMs, splitMode);
  if (Number.isInteger(offset)) return offset;
  const start = Number(segment?.start);
  const end = Number(segment?.end);
  const time = Number(timeMs);
  const ratio = Number.isFinite(start) && Number.isFinite(end) && end > start && Number.isFinite(time)
    ? (time - start) / (end - start) : 0.5;
  return fallbackSplitOffset(segment?.text, ratio * String(segment?.text || '').length);
}

function splitOffsetNearTextPositionForModal(text, offset, splitMode) {
  const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(text || '', splitMode);
  const requested = Math.max(0, Math.min(String(text || '').length, Math.round(Number(offset) || 0)));
  if (legalOffsets.length) {
    return legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best
    ), legalOffsets[0]);
  }
  return fallbackSplitOffset(text, requested);
}

















// 拆分对齐的兜底提示（修复③）：文本与词时间戳脱钩、且切分边界明显偏离
// 下刀位置时给出警告，杜绝「字拆对、时拆错」的静默错拆与静默失败。强制
// 拆分（force）会刻意把切点移出词边界，不适用本提示。
function flashSplitAlignmentHint(alignment, { committed = true } = {}) {
  if (!alignment?.broken) return;
  const drift = Number(alignment.driftMs);
  if (!Number.isFinite(drift) || drift <= SPLIT_ALIGNMENT_DRIFT_WARN_MS) return;
  const message = committed
    ? `已拆分，但字幕文本与词时间戳不完全一致，切点与下刀位置相差约 ${Math.round(drift)} ms；如需贴合语音，可先校正文本或检查词时间戳`
    : `未完成拆分：字幕文本与词时间戳不完全一致，切点与下刀位置相差约 ${Math.round(drift)} ms；请调整切点或校正文本后重试`;
  MaweHint.flashHint(window.MAWE_I18N?.translateText?.(message) || message, 'warning');
}

// 拆分失败路径上拿不到 pair，用相同入参重新评估一次对齐质量（纯计算）。
function assessSplitAlignment(segment, offset, cutMs, options = {}) {
  const itemParts = MaweSplitCore.splitItemsAtChar(segment, offset, cutMs, options);
  return {
    ...(itemParts.alignment || { total: 0, aligned: 0, broken: false }),
    driftMs: MULTI_SUBTITLE_UTILS.splitAlignmentDriftMs(itemParts.leftEndMs, itemParts.rightStartMs, cutMs),
  };
}













// 键盘可交互：⌚️ 时间码锚定的主轨和已用 Space/点击锁定的 lane 不响应移动键。




// 左右移动：在当前 lane 的合法断点序列中前进/后退一步。


// 上下移动：按渲染后的视觉行定位。gap 元素样式一致，同一行的 top 相同；
// 行距约等于 line-height（36px），用远小于行距的容差聚类即可。




// 上下移动：目标行上取与当前断点水平距离最近的 gap；单行或越界时返回 null。


// 键盘操作的 lane：优先看真实焦点，失焦（如点到复选框）时回退到上次记录。






// Tab 在主/副 lane 间切换：仅在联动模式且主轨可交互时可用。


// Space 与鼠标点击同语义：锁定当前断点；再按一次解锁以便继续移动。


// 已锁定的 lane 上按移动键：闪烁边缘并提示先解锁再移动。


























// 拆分弹窗状态对应的轨：叠加轨拆分复用副轨弹窗机制，但轨解析走叠加轨。
function splitStateTrack(state) {
  if (state?.kind === 'overlay') return getOverlayTrack();
  return MaweMultiSubtitleCore.getExtensionTrack(state?.trackId);
}

function splitTimingIsValid(segment, cutMs) {
  const start = Number(segment?.start);
  const end = Number(segment?.end);
  const cut = Number(cutMs);
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(cut)
    && end - start >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2
    && cut - start >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
    && end - cut >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS;
}

function duplicateSplitTimingIsValid(state) {
  if (!state) return false;
  if (state.kind === 'main') {
    return splitTimingIsValid(MaweBoot.DATA.segments[state.mainIndex], state.mainCutMs);
  }
  const track = splitStateTrack(state);
  if (state.kind === 'extension' || state.kind === 'overlay') {
    return splitTimingIsValid(
      MaweMultiSubtitleCore.extensionSegmentById(state.extensionId, track),
      state.extensionCutMs,
    );
  }
  const main = MaweBoot.DATA.segments[state.mainIndex];
  const extension = MaweMultiSubtitleCore.extensionSegmentById(state.extensionId, track);
  return splitTimingIsValid(main, state.mainCutMs)
    && splitTimingIsValid(extension, state.extensionCutMs);
}











// 降级路径：副轨无法形成合法拆分时，只拆主轨并解除与副字幕的绑定。




// 叠加轨拆分：复用副轨的独立拆分弹窗机制（单 lane、无主副联动），
// 但组引用（颜色/表情包）按主轨拆分规则在叠加轨数组内维护。
function openOverlaySplitModal(index, timeMs, initial = {}) {
  const track = getOverlayTrack();
  const segment = track?.segments?.[index];
  if (!segment) return false;
  if (segment.end - segment.start < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2) {
    MaweHint.flashHint('叠加字幕总时长不足 200ms，无法拆分', 'warning');
    return false;
  }
  const state = MaweSplitCore.extensionOnlySplitState(index, track, { timeMs, ...initial });
  if (!state) {
    MaweHint.flashHint('这条叠加字幕没有可用的文字边界', 'invalid');
    return false;
  }
  state.kind = 'overlay';
  state.feedbackPoint = state.feedbackPoint
    || MaweCoreState.waveformEditor?.getSplitPointAtTime?.(timeMs, 'extension') || null;
  MaweSplitCore.pendingLinkedSplit = state;
  MaweDom.multiSubtitleSplitModal?.classList.add('show');
  MaweSplitCore.renderLinkedSplitText(state);
  return true;
}

function commitOverlaySplit(
  state,
  {
    force = false,
    duplicateText = false,
    successMessage = '已按选择的断点拆分叠加字幕',
  } = {},
) {
  const track = getOverlayTrack();
  const overlayIndex = track?.segments?.findIndex((segment) => segment.id === state.extensionId) ?? -1;
  const segment = track?.segments?.[overlayIndex];
  if (!track || overlayIndex < 0 || !segment) return false;
  const splitMs = force
    ? MaweSplitCore.forceSplitCutForSegments([segment], state.extensionCutMs)
    : state.extensionCutMs;
  if (!Number.isFinite(splitMs)) {
    MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
    return false;
  }
  const splitAlignmentOptions = {
    preserveCutMs: force || Number.isFinite(state.fixedCutMs),
    forceCut: force,
  };
  const pair = MaweSplitCore.buildSplitPair(
    segment,
    state.offset,
    splitMs,
    segment.id || `overlay-${overlayIndex}`,
    true,
    state.extensionMode,
    { ...splitAlignmentOptions, duplicateText },
  );
  if (!pair) {
    if (!force && !duplicateText) {
      flashSplitAlignmentHint(
        assessSplitAlignment(segment, state.offset, splitMs, splitAlignmentOptions),
        { committed: false },
      );
    }
    return false;
  }
  if (!force && !duplicateText) flashSplitAlignmentHint(pair.alignment, { committed: true });
  MaweHistory.pushUndo(duplicateText ? '拆分叠加字幕并保留原文' : '拆分叠加字幕', { captureView: true });
  MaweSelection.clearSelection({ commitCuePanel: false });
  track.segments.splice(overlayIndex, 1, pair.left, pair.right);
  // 组引用维护与主轨拆分一致：替换下标之后的引用右移一格，
  // 左半继承 head 时右半以 ref 指回它；其余指向旧 head 的引用仍有效。
  for (let index = overlayIndex + 2; index < track.segments.length; index++) {
    const item = track.segments[index];
    if (item.sticker_ref?.headIdx > overlayIndex) item.sticker_ref.headIdx += 1;
    if (item.color_ref?.headIdx > overlayIndex) item.color_ref.headIdx += 1;
  }
  if (pair.left.sticker) pair.right.sticker_ref = { name: pair.left.sticker.name, headIdx: overlayIndex };
  if (pair.left.color) pair.right.color_ref = { name: pair.left.color.name, headIdx: overlayIndex };
  track._dirty = true;
  MaweSplitCore.closeLinkedSplitModal();
  MaweSelection.clearSelection({ commitCuePanel: false });
  MaweCuePanel.renderAll();
  selectedOverlayIdxs.clear();
  selectedOverlayIdxs.add(overlayIndex + 1);
  lastClickedOverlayIdx = overlayIndex + 1;
  MaweCuePanel.setCuePanelTarget('overlay', overlayIndex + 1);
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweSplitCore.flashSplitFeedback({
    index: overlayIndex,
    track: 'overlay',
    splitMs,
    feedbackPoint: null,
    listFeedback: false,
  });
  MaweNinja.triggerNinjaSplitFeedback(MaweNinja.ninjaModalSplitPoint(state, splitMs, 'overlay'));
  if (successMessage) MaweHint.flashHint(successMessage, 'success');
  return true;
}







// 拆分来源可能是字幕列表、当前编辑区或弹窗；只有列表来源有可靠的列表坐标，
// 其它来源统一回退到波形时间位置。波形反馈只创建一个短暂标记，不参与播放帧刷新。




// === 合并 ===
// 把 DATA.segments 中连续下标 sorted 合并为一条，并维护 group 引用与组时间范围。
// 不做参数校验、撤销与渲染，由调用方负责（mergeSegments / autoMergeSegments 共用）。




// 只合并副轨连续字幕。副字幕没有主轨的 group 引用和 items，
// 因此这里保留独立轨的文本/时间合并语义；如果被合并段存在一对一绑定，
// 合并后无法同时指向多个主字幕，旧绑定会被移除并提示用户重新绑定。


// 只合并叠加轨连续字幕。叠加轨的分组（颜色/表情包）引用叠加轨自身段，
// 合并语义与主轨一致：全部成员同组时继承，混合组不继承。
function mergeOverlaySegments(idxs) {
  const track = getOverlayTrack();
  if (!track || !idxs?.length) return false;
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  if (sorted.length < 2) {
    MaweHint.flashHint('请选择至少两个叠加字幕块！', 'invalid');
    return false;
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) {
      MaweHint.flashHint('选中的叠加字幕必须连续', 'invalid');
      return false;
    }
  }
  const segments = sorted.map((index) => track.segments[index]).filter(Boolean);
  if (segments.length !== sorted.length) return false;
  const sourceEl = MaweCoreState.container.querySelector(`.overlay-track-cue[data-overlay-idx="${sorted[0]}"]`);
  const cueListAnchor = MaweCueListAnchor.captureVisibleCueListVisualAnchor(sourceEl);
  const stickerGroup = window.AsrEditorUtils.resolveMergedGroupInheritance(
    track.segments, sorted, 'sticker', 'sticker_ref',
  );
  const colorGroup = window.AsrEditorUtils.resolveMergedGroupInheritance(
    track.segments, sorted, 'color', 'color_ref',
  );
  const merged = {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(
      track.segments,
      `${segments[0].id || track.id}-merged`,
      'overlay',
    ),
    start: segments[0].start,
    end: segments[segments.length - 1].end,
    text: window.AsrEditorUtils.joinSegmentTexts(
      segments,
      MaweMultiSubtitleCore.mergeJoinSeparatorForMode(MaweMultiSubtitleCore.getMainSubtitleSplitMode({ text: segments.map((s) => s.text || '').join('\n') })),
    ),
    items: segments.flatMap((segment) => segment.items || []),
    sticker: stickerGroup.head,
    sticker_ref: stickerGroup.ref,
    color: colorGroup.head,
    color_ref: colorGroup.ref,
    disabled: !!segments[0].disabled,
    _dirty: true,
  };
  if (Array.isArray(merged.items) && merged.items.length === 0) merged.items = null;
  MaweSelection.clearSelection();
  MaweHistory.pushUndo('合并叠加字幕');
  track.segments.splice(sorted[0], sorted.length, merged);
  track._dirty = true;
  MaweCuePanel.renderAll();
  selectedOverlayIdxs.clear();
  selectedOverlayIdxs.add(sorted[0]);
  lastClickedOverlayIdx = sorted[0];
  MaweCuePanel.setCuePanelTarget('overlay', sorted[0]);
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  const el = MaweCoreState.container.querySelector(`.overlay-track-cue[data-overlay-idx="${sorted[0]}"]`);
  if (cueListAnchor) MaweCueListAnchor.restoreCueListVisualAnchor(el, cueListAnchor);
  MaweHint.flashHint(`已合并 ${sorted.length} 条叠加字幕`, 'success');
  return true;
}





// === 拼合字幕 ===
// 把工具窗参数同步到控件；「吸收过短字幕」关闭时禁用短句相关参数。




// 一键处理整段工程：相邻间隔不超过 autoMergeGapMs 时按吸附方向拼接；
// 过短的字幕（中文 < N 字 / 英文 < N 词）按吸收方向并入相邻字幕。


// 「拼合字幕」的自动延展直接修改主轨边界，不能绕过普通时间编辑使用的
// 绑定同步路径。每个 snap 单独记录旧边界，确保连续间隔同时调整时，副字幕
// 仍按对应的 start/end offset 跟随；Alt 独立拖动不会进入这里。


// === 组拆分 helper（删除 / 清除颜色 / 清除表情包 通用）===
// cutSet: Set<number> 包含被"切开"的 idx；这些 idx 的 head/ref 字段都会被清空，
//         同时把它们所在 group 的成员从切点处拆开，切点之后的部分重新组队，
//         首条升级为新 head，后续 ref 指向它。
//   - 删除场景：cutSet = 被物理删除的 idx；切完后由调用方负责 splice
//   - 清除场景：cutSet = 被清除 group 字段的 idx；调用方不删除字幕本身


// === 删除 ===
// 删除一组 idx，并智能维持 head/ref 链（"组拆分"语义）：
//   核心规则：被删的任一 idx 都会把它所属的 group 拆成"前段"和"后段"
//     - 前段（idx < 被删 idx 且原本同组）：保留原 head；head 的 .end 收缩到
//       前段最后一个存活的 ref/head 的 .end
//     - 后段（idx > 被删 idx 且原本同组）：第一个存活 ref 晋升为新 head，
//       后续同组 ref 改指向它
//   当被删的是 head：前段为空，整段后段重组（与之前的"head 晋升"语义吻合）
//   当被删的是 ref：head 仍是 head，但 group 被切成两块——这是用户原话
//     "删除中间的 3 → 4 变 head，5 改 ref→4"




// === 滚动 ===


// 三种滚动共用一个可取消的操作：布局恢复、主动导航、播放跟随。
// scroll 事件本身不表示用户输入，懒布局和浏览器边界限制也会触发它。









document.addEventListener('pointerdown', (event) => {
  MaweCueListAnchor.invalidateCueListVisualAnchorRestore({ preserveLayoutAnchor: true });
  // 直接按在容器空白/滚动条上可能开始拖动；普通行点击仍沿用点击设置。
  const rect = MaweCoreState.container.getBoundingClientRect();
  if (event.target === MaweCoreState.container || (MaweCoreState.container.contains(event.target)
      && event.clientX >= rect.right - 14)) {
    MaweCueListAnchor.cueListScroll.layoutAnchor = null;
    MaweCueListAnchor.setCueListFollowing(false);
  }
}, true);
MaweCoreState.container.addEventListener('wheel', MaweCueListAnchor.interruptCueListFollowing, { passive: true });
MaweCoreState.container.addEventListener('touchstart', MaweCueListAnchor.interruptCueListFollowing, { passive: true });
document.addEventListener('keydown', (event) => {
  MaweCueListAnchor.invalidateCueListVisualAnchorRestore({ preserveLayoutAnchor: true });
}, true);
// 等播放、弹窗及目标控件先处理输入；被消费的空格不再误归为列表滚动。
// 应用自己消费的列表导航在其导航入口交出跟随，其余原生滚动在冒泡时处理。
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState
      || MaweKeyboardTargets.isTextEditingTarget(event) || MaweKeyboardTargets.isNativeKeyboardControl(event) || MaweKeyboardTargets.isPlayerKeyboardTarget(event)) return;
  if (document.querySelector('.modal-mask.show, #ctxmenu.show')
      || event.target?.closest?.('[role="dialog"], [role="menu"]')) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (!(MaweCoreState.container.contains(event.target) || MaweNavPreview.navigationOwner === 'cue-list')) return;
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
    MaweCueListAnchor.interruptCueListFollowing();
  }
});



























MaweCueListAnchor.cueListFollowButton?.addEventListener('click', MaweCueListAnchor.resumeCueListFollowing);

// === seek ===




// 最后一次指针按下所在的编辑区域：cue-list / waveform。
// Enter（原地编辑 vs 聚焦字幕编辑区）据此分发；指针坐标由 cueListPointer /
// lastPointerPos 提供，两者独立更新、互不替代。







// 等待绑定时，点击主/副字幕本身交给各自的选择事件处理；其它空白或
// 非字幕区域视为取消，避免用户进入等待状态后无从退出。
document.addEventListener('pointerdown', (event) => {
  if (!MaweSelection.pendingExtensionBinding) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.cue, .waveform-cue-block, #ctxmenu')) return;
  MaweSelection.cancelPendingExtensionBinding();
}, true);

document.addEventListener('pointerdown', (e) => {
  if (e.target instanceof Element && e.target.closest('.cue')) MaweNavPreview.lastEditRegion = 'cue-list';
  else if (e.target instanceof Element && e.target.closest('#waveform-pane')) MaweNavPreview.lastEditRegion = 'waveform';
}, true);


document.addEventListener('pointerdown', MaweNavPreview.updateNavigationOwner, true);
document.addEventListener('focusin', MaweNavPreview.updateNavigationOwner, true);
document.addEventListener('pointermove', (e) => {
  MaweNavPreview.lastPointerPos = { x: e.clientX, y: e.clientY };
}, true);









// Z/X 只接受一个“逻辑字幕”作为目标：点击主字幕时，绑定副字幕是它的
// 联动对象；点击副字幕时，即使界面同时选中了主字幕，也仍只改副字幕。
// 其它多选或来自不同绑定组的混合选择直接不处理。


// Z：起点定位；X：终点定位。无选中时使用波形指针命中的字幕；有选中时
// 只允许一个逻辑字幕，避免把多选误当成批量边界调整。


document.addEventListener('keydown', (event) => MaweNavPreview.handlePointerBoundaryShortcut(event, 'start'));
document.addEventListener('keydown', (event) => MaweNavPreview.handlePointerBoundaryShortcut(event, 'end'));



// === 单击/双击/Shift/Ctrl ===


// === 全局键盘 ===
  // 'enter' or 'ctrl-enter'



document.addEventListener('keydown', (e) => {
  if (e.target === MaweDom.cuePanelText) return;
  if (!MaweInlineEdit.editingState) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); MaweInlineEdit.finishEdit(false); return; }
  const action = MaweCueEvents.getConfiguredEnterAction(e);
  if (!action || action === 'newline') return;
  e.preventDefault();
  // 拆分会在当前 keydown 事件内打开弹窗；阻止同一 document 上后注册的
  // 弹窗快捷键监听器继续处理这次 Enter，否则它会立刻把新弹窗再次提交。
  e.stopImmediatePropagation();
  if (action === 'split') MaweSplitCore.splitAtCursor();
  else MaweInlineEdit.finishEdit(true);
}, true);

document.addEventListener('keydown', (event) => {
  if (!MaweInlineEdit.extensionEditingState) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    MaweInlineEdit.finishExtensionEdit(false);
    return;
  }
  const action = MaweCueEvents.getConfiguredEnterAction(event);
  if (!action || action === 'newline') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (action === 'save') {
    MaweInlineEdit.finishExtensionEdit(true);
    return;
  }
  const state = MaweInlineEdit.extensionEditingState;
  const offset = MaweInlineEdit.caretOffsetInText(state.textEl);
  const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
  if (!Number.isFinite(offset) || !track?.segments?.[state.index]) {
    MaweHint.flashHint('无法定位副字幕的文字光标', 'warning');
    return;
  }
  MaweInlineEdit.finishExtensionEdit(true);
  MaweSplitCore.openExtensionSplitModal(state.index, null, track, { extensionOffset: offset });
}, true);

// Esc：非字幕文本编辑状态下清除当前字幕选择；输入框和内联编辑继续保留原生/编辑行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (MaweDom.timedTextEditModal.classList.contains('show')) {
    e.preventDefault();
    e.stopPropagation();
    MaweTimedTextEdit.requestCloseTimedTextEdit();
    return;
  }
  if (MaweSelection.pendingExtensionBinding) {
    e.preventDefault();
    e.stopPropagation();
    MaweSelection.cancelPendingExtensionBinding();
    return;
  }
  if (MaweInlineEdit.editingState || (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size === 0)) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (MaweCoreState.waveformEditor?.hasCueDrag?.()) {
    // 拖动中的 Esc 不取消拖动，也不清空选区；拖动仍由 pointerup 正常完成。
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  MaweSelection.clearSelection();
});











function isPlaybackActive() {
  return MaweJklPlayback.jklReversePlaying || !MaweCoreState.player.paused;
}

function pausePlaybackAfterMouseClick() {
  if (!MaweSettings.EDITOR_SETTINGS.pauseOnMouseClick || !isPlaybackActive()) return;
  if (MaweJklPlayback.jklReversePlaying) MaweJklPlayback.stopJklReversePlayback({ render: false });
  MaweCoreState.player.pause();
  MaweMediaPlayback.syncMediaControls();
}















let assPreviewRefreshFrame = 0;
function scheduleAssSubtitlePreviewRefresh() {
  if (MaweSettings.EDITOR_SETTINGS.assMode !== true || assPreviewRefreshFrame) return;
  const refresh = () => {
    assPreviewRefreshFrame = 0;
    if (MaweSettings.EDITOR_SETTINGS.assMode !== true) return;
    MawePlaybackLoop.refreshSubtitlePreview();
  };
  if (typeof requestAnimationFrame === 'function') {
    assPreviewRefreshFrame = requestAnimationFrame(refresh);
  } else {
    assPreviewRefreshFrame = window.setTimeout(refresh, 0);
  }
}













MaweDom.mediaPlayToggle?.addEventListener('click', MaweMediaPlayback.togglePlayback);
MaweDom.mediaStepBack?.addEventListener('click', () => MaweMediaPlayback.seekMediaBy(-MaweTimeline.timelineMediaSeekStepMilliseconds() / 1000));
MaweDom.mediaStepForward?.addEventListener('click', () => MaweMediaPlayback.seekMediaBy(MaweTimeline.timelineMediaSeekStepMilliseconds() / 1000));
MaweDom.mediaSeek?.addEventListener('input', () => {
  if (!MaweMediaPlayback.hasLoadedMedia()) return;
  MaweCoreState.player.currentTime = Number(MaweDom.mediaSeek.value) || 0;
  MawePlaybackLoop.update();
  MaweCueListAnchor.resumeCueListFollowing();
  MaweMediaPlayback.syncMediaControls();
});
MaweDom.mediaVolume?.addEventListener('input', () => {
  MaweCoreState.player.volume = Math.min(1, Math.max(0, Number(MaweDom.mediaVolume.value) || 0));
  MaweMediaPlayback.syncMediaControls();
});
MaweDom.mediaPlaybackRate?.addEventListener('change', () => {
  const selectedRate = Number(MaweDom.mediaPlaybackRate.value) || 1;
  const rate = Math.max(0.0625, Math.abs(selectedRate));
  MaweCoreState.player.playbackRate = rate;
  if (MaweJklPlayback.isJklDirectionMode()) {
    const direction = selectedRate < 0 || MaweJklPlayback.jklPlaybackRate < 0 ? -1 : 1;
    MaweJklPlayback.jklPlaybackRate = direction * rate;
  }
  MaweMediaPlayback.syncMediaControls();
});
MaweDom.mediaFullscreen?.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await MaweDom.playerWrap?.requestFullscreen?.();
  } catch (error) {
    MaweHint.flashHint(`无法切换全屏：${error.message || error}`, 'warning');
  }
  MaweMediaPlayback.syncMediaControls();
});
document.addEventListener('fullscreenchange', MaweMediaPlayback.syncMediaControls);

// ←/→：无选中字幕时复用媒体控制条的跳转时长；选中字幕时改为按设置的
// 微调幅度调整时间。Shift+方向键贴合前后边界；Ctrl(Cmd)+方向键调整左边界，
// Ctrl(Cmd)+Shift+方向键调整右边界。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (MaweInlineEdit.editingState || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  // 拆分弹窗内方向键用于移动 ✂️ 断点，不再 seek 媒体或微调字幕时间。
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  const target = e.target instanceof Element ? e.target : document.activeElement;
  if (target?.closest?.('.geo-box, input, select, textarea')) return;
  if (target?.closest?.('[role="menu"]')) return;
  if (!MaweKeyboardTargets.isPlaybackKeyboardTarget(e) && MaweKeyboardTargets.isNativeKeyboardControl(e)) return;
  if (MaweKeyboardTargets.isPlayerKeyboardTarget(e)) return;
  const commandKey = e.ctrlKey || e.metaKey;
  const direction = e.key === 'ArrowLeft' ? -1 : 1;
  const panelTarget = MaweCuePanel.getCurrentCuePanelTarget();
  const extensionTarget = panelTarget?.kind === 'extension';
  const overlayTarget = panelTarget?.kind === 'overlay';
  const activeTrack = extensionTarget ? 'extension'
    : overlayTarget ? 'overlay' : 'main';
  const selected = extensionTarget ? MaweSelection.selectedExtensionIdxs
    : overlayTarget ? selectedOverlayIdxs : MaweSelection.selectedIdxs;
  if (e.shiftKey && !commandKey) {
    // Shift 是显式的边界贴合命令，不受自动吸附默认值影响；Alt 只反转
    // 普通移动/边界微调的自动联动模式。
    if (selected.size > 0
        && MaweCoreState.waveformEditor?.snapSelectedCueBoundaryByKeyboard?.(direction, activeTrack)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (selected.size > 0 && MaweCoreState.waveformEditor) {
    const deltaTime = direction * MaweTimeline.timelineCueMoveStepValue();
    if (commandKey) {
      if (e.shiftKey) {
        MaweCoreState.waveformEditor.adjustSelectedBoundaryByKeyboard(deltaTime, 'end', e.altKey, activeTrack);
      } else {
        MaweCoreState.waveformEditor.adjustSelectedBoundaryByKeyboard(deltaTime, 'start', e.altKey, activeTrack);
      }
    } else {
      MaweCoreState.waveformEditor.adjustSelectedByKeyboard(deltaTime, e.altKey, activeTrack);
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (commandKey || e.altKey) return;
  if (!MaweMediaPlayback.hasLoadedMedia()) return;
  e.preventDefault();
  e.stopPropagation();
  MaweMediaPlayback.seekMediaBy(direction * MaweTimeline.timelineMediaSeekStepMilliseconds() / 1000);
}, true);





// Home/End：字幕列表最近拥有导航时选择当前轨道首尾；波形、播放器或尚未
// 确定区域时跳转媒体首尾。文本输入、普通按钮和模态窗口保留原生行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Home' && e.key !== 'End') return;
  if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  if (!MaweKeyboardTargets.isPlaybackKeyboardTarget(e) && MaweKeyboardTargets.isNativeKeyboardControl(e)) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (MaweDom.replaceModal.classList.contains('show') || MaweDom.stickerModal.classList.contains('show')
      || MaweDom.stickerPreviewModal.classList.contains('show') || MaweDom.projectMediaModal.classList.contains('show')
      || MaweDom.multiSubtitleSplitModal?.classList.contains('show')
      || MaweDom.multiSubtitleImportModal?.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || MaweDom.ctxmenu.classList.contains('show')) return;
  if (MaweNavPreview.navigationOwner === 'cue-list' && MaweCueListAnchor.navigateCueListBoundary(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const duration = Number(MaweCoreState.player?.duration);
  if (!MaweMediaPlayback.hasLoadedMedia() || !Number.isFinite(duration) || duration <= 0) return;
  e.preventDefault();
  e.stopPropagation();
  MaweMediaPlayback.seekMediaTo(e.key === 'Home' ? 0 : duration);
}, true);





















// 多重字幕下，上/下只切换当前操作轨道；优先使用绑定关系，没有绑定时
// 选择时间范围重叠最多、否则距离最近的另一轨字幕，不改变播放头位置。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (MaweKeyboardTargets.isNativeKeyboardControl(e) || MaweKeyboardTargets.isPlayerKeyboardTarget(e)) return;
  if (MaweDom.replaceModal.classList.contains('show') || MaweDom.stickerModal.classList.contains('show')
      || MaweDom.stickerPreviewModal.classList.contains('show') || MaweDom.projectMediaModal.classList.contains('show')
      || MaweDom.multiSubtitleSplitModal?.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || MaweDom.ctxmenu.classList.contains('show')) return;
  if (!MaweKeyboardTargets.switchMultiSubtitleTrack(e.key === 'ArrowUp' ? -1 : 1)) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// 鼠标点击按钮后不保留按钮焦点，否则下一次空格会触发按钮自身的 click。
// 键盘触发的 click detail 为 0，保留焦点以维持原生键盘可访问性。
document.addEventListener('click', (event) => {
  if (event.detail === 0) return;
  const target = event.target instanceof Element ? event.target : null;
  target?.closest('button')?.blur();
}, true);



// 空格播放/暂停。捕获阶段先于原生媒体控件处理，避免控件获得焦点后执行默认行为。

document.addEventListener('keydown', (e) => {
  if (!MaweKeyboardTargets.isSpaceKey(e)) return;
  if (MaweInlineEdit.editingState || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  // 拆分弹窗内空格用于确认/取消断点，交给弹窗自己的键盘处理。
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (!MaweKeyboardTargets.isPlaybackKeyboardTarget(e) && MaweKeyboardTargets.isNativeKeyboardControl(e)) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  MaweShortcuts.interceptedSpace = true;
  if (e.repeat) return;
  MaweMediaPlayback.togglePlayback();
}, true);

document.addEventListener('keyup', (e) => {
  if (!MaweKeyboardTargets.isSpaceKey(e) || !MaweShortcuts.interceptedSpace) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  MaweShortcuts.interceptedSpace = false;
}, true);
window.addEventListener('blur', () => { MaweShortcuts.interceptedSpace = false; });

// J/K/L 播放控制的两种模式：旧模式是慢速/重置/倍速；新模式是倒放/停止/1×播放。
// HTML5 playbackRate 多数浏览器钳在 [0.0625, 16]，反向播放由时间轴驱动。





document.addEventListener('keydown', (e) => {
  if (e.key !== 'j' && e.key !== 'J' && e.key !== 'k' && e.key !== 'K' && e.key !== 'l' && e.key !== 'L') return;
  if (MaweInlineEdit.editingState) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  // Ctrl/Alt/Meta 别误触发（让浏览器自己处理 Ctrl+L 等）
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  const k = e.key.toLowerCase();
  if (MaweJklPlayback.isJklDirectionMode()) {
    if (k === 'k') {
      const wasPlaying = MaweJklPlayback.jklReversePlaying || !MaweCoreState.player.paused;
      if (!wasPlaying) {
        MaweJklPlayback.jklPlaybackRate = 1;
        MaweCoreState.player.playbackRate = 1;
        if (MaweJklPlayback.playJklForward()) MaweHint.flashHint('正放: 1×');
        return;
      }
      MaweJklPlayback.stopJklReversePlayback({ render: false });
      MaweJklPlayback.jklPlaybackRate = 1;
      MaweCoreState.player.playbackRate = 1;
      MaweCoreState.player.pause();
      MawePlaybackLoop.update();
      MaweCoreState.waveformEditor?.updatePlayback();
      MaweMediaPlayback.syncMediaControls();
      MaweHint.flashHint('已停止');
      return;
    }
    if (!MaweMediaPlayback.hasLoadedMedia()) {
      MaweHint.flashHint('请先加载媒体，然后才能预览', 'invalid');
      return;
    }
    MaweJklPlayback.jklPlaybackRate = MaweJklPlayback.nextJklDirectionRate(MaweJklPlayback.jklPlaybackRate, k === 'j' ? -1 : 1);
    if (MaweJklPlayback.jklPlaybackRate < 0) MaweJklPlayback.startJklReversePlayback();
    else MaweJklPlayback.playJklForward();
    MaweHint.flashHint(`${MaweJklPlayback.jklPlaybackRate < 0 ? '倒放' : '正放'}: ${MaweShortcuts.fmtRate(MaweJklPlayback.jklPlaybackRate)}`);
    return;
  }
  let r = MaweCoreState.player.playbackRate;
  if (k === 'k') r = 1;
  else if (k === 'j') r = Math.max(MaweShortcuts.PLAYBACK_RATE_MIN, r * 0.5);
  else if (k === 'l') r = Math.min(MaweShortcuts.PLAYBACK_RATE_MAX, r * 2);
  MaweCoreState.player.playbackRate = r;
  MaweMediaPlayback.syncMediaControls();
  MaweHint.flashHint(`倍速: ${MaweShortcuts.fmtRate(r)}`);
});

// A/D（或 W/S）：跳转到上一条/下一条字幕的句首并单选。W/S 与 A/D 等价，对应上下方向。
// Shift+A/D（或 Shift+W/S）：保留当前选择，并向前/后追加选择一条字幕。
// 播放中以播放头所在字幕为基准；播放头处于空隙时，按方向选择其前方/后方字幕。
// 暂停时仍以当前选中字幕为基准。跳转本身不改变播放状态。
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key !== 'a' && key !== 'd' && key !== 'w' && key !== 's') return;
  if (MaweInlineEdit.editingState) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.metaKey) return;
  const direction = (key === 'a' || key === 'w') ? -1 : 1;
  const panelTarget = MaweCuePanel.getCurrentCuePanelTarget();
  const extensionTarget = panelTarget?.kind === 'extension';
  const extensionTrack = extensionTarget ? panelTarget.track : null;
  const segments = extensionTarget ? extensionTrack.segments : MaweBoot.DATA.segments;
  const wasPlaying = !MaweCoreState.player.paused;
  const heldCueKey = (!e.shiftKey || key === 'a' || key === 'd')
    && MaweCoreState.waveformEditor?.handleHeldCueKey?.(
      direction,
      direction * MaweTimeline.timelineCueMoveStepValue(),
      { shiftKey: e.shiftKey, altKey: e.altKey, snap: key === 'a' || key === 'd' },
    );
  if (heldCueKey) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.altKey) return;
  const navigationIndex = wasPlaying
    ? -1
    : (extensionTarget ? panelTarget?.index ?? -1 : MaweCuePanelState.currentCuePanelIdx);
  let next = e.shiftKey
    ? window.AsrEditorUtils.findCueSelectionExtensionTarget(
      segments,
      extensionTarget ? MaweSelection.selectedExtensionIdxs : MaweSelection.selectedIdxs,
      navigationIndex,
      Math.round(MaweCoreState.player.currentTime * 1000),
      direction,
      MaweDom.hideDisabled,
    )
    : window.AsrEditorUtils.findCueNavigationTarget(
      segments,
      navigationIndex,
      Math.round(MaweCoreState.player.currentTime * 1000),
      direction,
      MaweDom.hideDisabled,
    );
  if (next < 0) {
    const eligible = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => segment && (!MaweDom.hideDisabled || !segment.disabled));
    next = direction < 0
      ? (eligible[0]?.index ?? -1)
      : (eligible[eligible.length - 1]?.index ?? -1);
  }
  if (next < 0) return;

  e.preventDefault();
  e.stopPropagation();
  if (extensionTarget) {
    if (e.shiftKey) MaweSelection.addExtensionToSelection(next, extensionTrack);
    else MaweSelection.selectOnlyExtension(next);
    MaweSelection.lastClickedExtensionIdx = next;
  } else {
    if (e.shiftKey) MaweSelection.addToSelection(next);
    else MaweSelection.selectOnly(next);
    MaweSelection.lastClickedIdx = next;
  }
  const cue = MaweCoreState.container.querySelector(
    extensionTarget
      ? `.multi-dual-cue[data-ext-idx="${next}"], .multi-extension-cue[data-ext-idx="${next}"]`
      : `.cue[data-idx="${next}"], .multi-dual-cue[data-main-idx="${next}"]`,
  );
  if (cue) MaweCueListAnchor.scrollCueToCenter(cue);
  MaweCoreState.waveformEditor?.revealTime(segments[next].start, true);
  MaweTextCleanup.seekFromWaveform(segments[next].start / 1000);
  if (wasPlaying && MaweCoreState.player.paused) {
    const promise = MaweCoreState.player.play();
    if (promise && promise.catch) promise.catch(() => {});
  }
});



// Ctrl(Cmd)+Shift+A/D：把当前主/副字幕与前一条/后一条直接粘合。
// 不改变 Ctrl(Cmd)+A/D 的全选与清除选择语义。
document.addEventListener('keydown', (e) => {
  if (!['a', 'A', 'd', 'D'].includes(e.key)) return;
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.repeat) return;
  if (MaweInlineEdit.editingState || e.target === MaweDom.cuePanelText) return;
  const active = document.activeElement;
  if (active && (
    active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
      || active.tagName === 'SELECT' || active.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show') || MaweDom.stickerModal.classList.contains('show')
      || MaweDom.stickerPreviewModal.classList.contains('show') || MaweDom.projectMediaModal.classList.contains('show')
      || document.getElementById('sticker-root-modal').classList.contains('show')
      || MaweDom.ctxmenu.classList.contains('show')) return;
  e.preventDefault();
  e.stopPropagation();
  MaweMergeAdjacent.mergeAdjacentSubtitle(e.key.toLowerCase() === 'a' ? -1 : 1);
});

// Ctrl(Cmd)+A：选中所有字幕。仅在「非编辑字幕」状态下生效；
// 焦点在输入框/文本域/可编辑元素或内联编辑态时，保留浏览器原生的「全选文本」行为。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'a' && e.key !== 'A') return;
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey || e.shiftKey) return;
  if (MaweInlineEdit.editingState) return;
  if (e.target === MaweDom.cuePanelText) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  e.preventDefault();
  MaweSelection.selectAll();
});

// Ctrl(Cmd)+D：取消选中（清空当前字幕选择）。浏览器默认是「添加书签」，这里接管；
// 与 Ctrl(Cmd)+A 同样仅在非编辑字幕状态下生效。ESC 清除选中的行为保持不变。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'd' && e.key !== 'D') return;
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.altKey || e.shiftKey) return;
  if (MaweInlineEdit.editingState) return;
  if (e.target === MaweDom.cuePanelText) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size === 0) return;
  e.preventDefault();
  MaweSelection.clearSelection();
});

// T：给选中字幕分配表情包。单选直接分配本条，多选统一分配（与右键菜单一致）。
document.addEventListener('keydown', (e) => {
  if (e.key !== 't' && e.key !== 'T') return;
  if (MaweInlineEdit.editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (MaweSelection.selectedIdxs.size === 0 && selectedOverlayIdxs.size === 0) return;
  e.preventDefault();
  if (selectedOverlayIdxs.size > 0) {
    const overlayIdxs = [...selectedOverlayIdxs].sort((x, y) => x - y);
    MaweStickerPicker.openStickerPicker(overlayIdxs, overlayIdxs.length > 1, { overlay: true });
    return;
  }
  const idxs = [...MaweSelection.selectedIdxs].sort((x, y) => x - y);
  MaweStickerPicker.openStickerPicker(idxs, idxs.length > 1);
});

// 数字键 1~5：给选中字幕标记对应颜色（红黄蓝绿紫）；0：清除颜色。
document.addEventListener('keydown', (e) => {
  if (!/^[0-5]$/.test(e.key)) return;
  if (MaweInlineEdit.editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (MaweSelection.selectedIdxs.size === 0 && selectedOverlayIdxs.size === 0) return;
  e.preventDefault();
  if (selectedOverlayIdxs.size > 0) {
    const overlayIdxs = [...selectedOverlayIdxs].sort((x, y) => x - y);
    if (e.key === '0') {
      clearOverlayColorOnTargets(overlayIdxs);
      return;
    }
    const overlayColor = MaweColors.COLOR_PALETTE[Number(e.key) - 1];
    if (overlayColor) assignOverlayColor(overlayIdxs, overlayColor.name);
    return;
  }
  const idxs = [...MaweSelection.selectedIdxs].sort((x, y) => x - y);
  if (e.key === '0') {
    MaweStickerPicker.clearColorOnTargets(idxs);
    return;
  }
  const color = MaweColors.COLOR_PALETTE[Number(e.key) - 1];
  if (color) MaweStickerPicker.assignColor(idxs, color.name);
});

// Enter：聚焦最后点击的主/副字幕对应的字幕编辑区，并把光标置于末尾。
// 绑定字幕同时选中时仍以最后点击的一侧为准；内联编辑态、已聚焦编辑区或模态打开时不触发。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState) return;  // 内联编辑态的 Enter 交给 split/commit 处理
  if (e.target === MaweDom.cuePanelText) return;  // 已在字幕编辑区
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;  // 仅响应裸 Enter
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.tagName === 'BUTTON'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (!MaweCuePanel.getCurrentCuePanelTarget()) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('请先选中字幕');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  MaweCuePanel.focusCuePanelText();
});

// C：合并连续选中的字幕块。少于两条时只提示，不改动工程。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'c' && e.key !== 'C') return;
  if (MaweInlineEdit.editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  const currentTarget = MaweCuePanel.getCurrentCuePanelTarget();
  if (
    selectedOverlayIdxs.size > 1
    && (currentTarget?.kind === 'overlay' || (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size === 0))
  ) {
    mergeOverlayCues([...selectedOverlayIdxs]);
    return;
  }
  if (
    MaweSelection.selectedExtensionIdxs.size > 0
    && (currentTarget?.kind === 'extension' || MaweSelection.selectedIdxs.size === 0)
  ) {
    MaweSegmentOps.mergeExtensionSegments(
      [...MaweSelection.selectedExtensionIdxs],
      currentTarget?.kind === 'extension' ? currentTarget.track : MaweMultiSubtitleCore.getActiveExtensionTrack(),
    );
    return;
  }
  MaweSegmentOps.mergeSegments([...MaweSelection.selectedIdxs]);
});


// Ctrl(Cmd)+Z 撤销；Ctrl(Cmd)+Shift+Z 或 Ctrl(Cmd)+Y 重做
document.addEventListener('keydown', (e) => {
  const isZ = e.key === 'z' || e.key === 'Z';
  const isY = e.key === 'y' || e.key === 'Y';
  if (!isZ && !isY) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const isRedo = isY || e.shiftKey;
  // 编辑文本时让浏览器自己处理 input 内的撤销/重做
  if (MaweHistory.historyGuarded()) return;
  e.preventDefault();
  if (isRedo) MaweHistory.performRedo();
  else MaweHistory.performUndo();
});

// Delete 键删除选中的字幕（最小命令面，供回归测试与键盘操作）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  // 编辑文本时让浏览器自己处理
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  // modal 打开时不触发
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size > 0) {
    e.preventDefault();
    e.stopPropagation();
    MaweSegmentOps.deleteExtensionSegments([...MaweSelection.selectedExtensionIdxs]);
    return;
  }
  if (MaweSelection.selectedIdxs.size === 0 && MaweSelection.selectedExtensionIdxs.size === 0 && selectedOverlayIdxs.size > 0) {
    e.preventDefault();
    e.stopPropagation();
    deleteOverlayCues([...selectedOverlayIdxs]);
    return;
  }
  if (MaweSelection.selectedIdxs.size === 0) return;
  e.preventDefault();
  e.stopPropagation();
  MaweSegmentOps.deleteSegments([...MaweSelection.selectedIdxs]);
});

// 波形工具切换：V=选择（默认），R=剃刀，Esc=切回选择。与 J/K/L 一样只在
// 非输入/非模态/非编辑态下触发，避免抢占文本编辑与弹窗按键。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'v' && e.key !== 'V' && e.key !== 'r' && e.key !== 'R' && e.key !== 'Escape') return;
  if (!MaweCoreState.waveformEditor) return;
  // Escape：上下文菜单/弹窗/编辑态各自先处理；只有波形工具在 razor 时才切回。
  if (e.key === 'Escape') {
    if (MaweInlineEdit.editingState) return;
    if (MaweDom.ctxmenu.classList.contains('show')) return;
    if (MaweDom.replaceModal.classList.contains('show')) return;
    if (MaweDom.stickerModal.classList.contains('show')) return;
    if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
    if (MaweDom.projectMediaModal.classList.contains('show')) return;
    if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
    if (MaweCoreState.waveformEditor.cancelCueDrag()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (MaweCoreState.waveformEditor.getTool() !== 'razor') return;
    e.preventDefault();
    MaweCoreState.waveformEditor.setTool('select');
    return;
  }
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweInlineEdit.editingState) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const tool = (e.key === 'v' || e.key === 'V') ? 'select' : 'razor';
  if (MaweCoreState.waveformEditor.getTool() === tool) return;
  e.preventDefault();
  MaweCoreState.waveformEditor.setTool(tool);
});

// F：跳转并播放选中字幕（多选跳到第一条）。任意单击行为下都生效；
// 文本编辑、弹窗和修饰键状态下不抢占输入。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'f' && e.key !== 'F') return;
  if (MaweInlineEdit.editingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const target = MaweCuePanel.getCurrentCuePanelTarget();
  const extensionTarget = target?.kind === 'extension';
  const selected = extensionTarget ? MaweSelection.selectedExtensionIdxs : MaweSelection.selectedIdxs;
  const segments = extensionTarget ? target.track.segments : MaweBoot.DATA.segments;
  if (!selected.size) return;
  const first = Math.min(...selected);
  const segment = segments[first];
  if (!segment) return;
  MaweTextCleanup.seekFromWaveform(segment.start / 1000);
  if (MaweCoreState.player.paused) MaweMediaPlayback.togglePlayback();
});



// I/O：跳到当前字幕的开头/结尾并保持暂停。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'i' && e.key !== 'I' && e.key !== 'o' && e.key !== 'O') return;
  if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState || e.repeat || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (MaweDom.multiSubtitleImportModal?.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const boundary = e.key.toLowerCase() === 'i' ? 'start' : 'end';
  if (!MaweNavPreview.seekCurrentCueBoundary(boundary)) return;
  e.preventDefault();
  e.stopPropagation();
});

// N：仅在鼠标位于波形行时，从指针音频位置创建字幕；创建后单选新字幕，
// 切换当前字幕面板并聚焦面板文本框。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'n' && e.key !== 'N') return;
  if (MaweInlineEdit.editingState || e.repeat || MaweKeyboardTargets.isTextEditingTarget(e)) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const reference = MaweNavPreview.keyboardOperationReference();
  if (!reference) {
    MaweHint.flashHint('无有效的快捷键时间基准', 'invalid');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  MaweNavPreview.lastEditRegion = 'waveform';
  if (reference.track === 'extension' && MaweMultiSubtitleCore.multiSubtitleVisible()) {
    MaweAddCue.addExtensionAtWaveformTime(reference.timeMs, MaweNavPreview.lastPointerPos?.x || 0, MaweNavPreview.lastPointerPos?.y || 0, MaweMultiSubtitleCore.getExtensionTrack(reference.trackId));
  } else {
    MaweAddCue.addCueAtWaveformTime(reference.timeMs, MaweNavPreview.lastPointerPos?.x || 0, MaweNavPreview.lastPointerPos?.y || 0);
  }
});

// G：绑定当前单选的副字幕。若同时选中一条主字幕则直接绑定，否则沿用
// 右键「绑定到主字幕」的自动匹配/等待选择流程。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'g' && e.key !== 'G') return;
  if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (MaweSelection.selectedExtensionIdxs.size !== 1) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('请先选中一条副字幕');
    return;
  }
  if (MaweSelection.selectedIdxs.size > 1) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('绑定最多需要一条主字幕');
    return;
  }
  const extensionIndex = [...MaweSelection.selectedExtensionIdxs][0];
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const extension = track?.segments?.[extensionIndex];
  const binding = MaweMultiSubtitleCore.bindingForExtensionIndex(extensionIndex, track);
  if (!extension) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('当前副字幕不存在');
    return;
  }
  if (e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    if (!binding) {
      MaweHint.flashHint('当前副字幕没有绑定关系', 'invalid');
      return;
    }
    MaweBindingAlign.unbindSelectedSubtitlePair();
    return;
  }
  if (e.shiftKey) return;
  if (binding) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('当前副字幕已绑定，请先解绑后再绑定');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (MaweSelection.selectedIdxs.size === 1) {
    MaweBindingAlign.bindSelectedSubtitlePair();
  } else {
    MaweBindingAlign.beginPendingExtensionBinding(extensionIndex, track);
  }
});

// H：把当前选中的副字幕批量对齐到各自绑定的主字幕时间轴。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'h' && e.key !== 'H') return;
  if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState || e.repeat) return;
  const a = document.activeElement;
  if (a && (
    a.tagName === 'INPUT'
    || a.tagName === 'TEXTAREA'
    || a.tagName === 'SELECT'
    || a.isContentEditable
  )) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (!MaweMultiSubtitleCore.multiSubtitleVisible()) return;
  if (!MaweSelection.selectedExtensionIdxs.size) {
    e.preventDefault();
    e.stopPropagation();
    MaweShortcuts.showShortcutBlocked('请先选中至少一条副字幕');
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  MaweBindingAlign.alignSelectedExtensionSubtitleRanges();
});

// B：按当前键盘时间基准与指针所在区域分发——
// 1) 鼠标悬停在已单选的字幕列表行上：按指针对应的文字位置拆分；
// 2) 鼠标位于波形上：按指针的音频位置拆分（与波形右键「按音频位置拆分」一致）；
// 3) 其它位置：按当前键盘时间基准拆分。
// 文本编辑、弹窗和修饰键状态下不抢占输入。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'b' && e.key !== 'B') return;
  if (e.repeat) return;
  const forceMainEdit = MaweInlineEdit.editingState?.forceSplitArmed === true;
  if (MaweInlineEdit.extensionEditingState && !forceMainEdit) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const state = MaweInlineEdit.extensionEditingState;
    const offset = MaweInlineEdit.caretOffsetInText(state.textEl);
    const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
    if (!Number.isFinite(offset) || !track?.segments?.[state.index]) {
      MaweHint.flashHint('无法定位副字幕的文字光标', 'warning');
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    // 先在编辑 DOM 消失前记录列表内光标位置，弹窗提交后的刀光留在原位。
    const editFeedbackPoint = MaweNinja.ninjaSplitPointFromRange(
      null, state.textEl, offset, String(state.textEl.innerText || '').length,
    );
    MaweInlineEdit.finishExtensionEdit(true);
    MaweSplitCore.openExtensionSplitModal(state.index, null, track, {
      extensionOffset: offset,
      feedbackPoint: editFeedbackPoint,
      ninjaFromList: true,
    });
    return;
  }
  if (MaweInlineEdit.editingState && !forceMainEdit) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'
    || (a.isContentEditable && !forceMainEdit))) return;
  if (MaweDom.replaceModal.classList.contains('show')) return;
  if (MaweDom.stickerModal.classList.contains('show')) return;
  if (MaweDom.stickerPreviewModal.classList.contains('show')) return;
  if (MaweDom.projectMediaModal.classList.contains('show')) return;
  if (document.getElementById('sticker-root-modal').classList.contains('show')) return;
  if (MaweDom.ctxmenu.classList.contains('show')) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (forceMainEdit) {
    e.preventDefault();
    e.stopImmediatePropagation();
    MaweSplitCore.splitAtCursor();
    return;
  }
  const splitAt = (idx, x, y, timeMs) => {
    e.preventDefault();
    // B 打开弹窗后，事件仍会继续传播到后面注册的弹窗快捷键监听器；
    // 立即停止同一事件，避免“按 B 打开”被误当成“按 B 确认”。
    e.stopImmediatePropagation();
    MaweSplitContext.splitFromContextMenu(idx, x, y, timeMs);
  };
  // 多重字幕下，只有副字幕是当前编辑焦点时，B 才直接打开副字幕拆分流程。
  // 绑定关系会让点击主字幕时同时选中副字幕；不能仅凭 selectedExtensionIdxs
  // 判断当前轨道，否则主字幕 active 时会被误判成副字幕单独拆分。
  const activeCuePanel = MaweCuePanel.getCurrentCuePanelTarget();
  const operationReference = MaweNavPreview.keyboardOperationReference();
  const pointerMainIndex = operationReference
    ? MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweBoot.DATA.segments) : -1;
  const activeExtensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const pointerExtensionIndex = operationReference?.track === 'extension'
    ? MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweMultiSubtitleCore.getExtensionTrack(operationReference.trackId)?.segments) : -1;
  if (MaweSelection.selectedExtensionIdxs.size === 1) {
    const context = MaweNavPreview.hoveredSelectedCueContext();
    if (context?.kind === 'extension' && context.track?.segments?.[context.idx]) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const initial = Number.isFinite(context.offset)
        ? {
          extensionOffset: context.offset,
          feedbackPoint: context.caretRect ? MaweNinja.ninjaSplitPointFromRect(context.caretRect) : null,
          ninjaFromList: true,
        } : {};
      MaweSplitCore.openExtensionSplitModal(context.idx, null, context.track, initial);
      return;
    }
  }
  // 波形区点击副字幕后，绑定关系可能同时选中主字幕；但只要当前面板和
  // 波形指针都明确落在这条单选副字幕上，B 就应拆分副字幕，而不是被重叠
  // 的主字幕时间范围抢走目标。主字幕面板仍不会进入这个例外分支。
  const waveformExtensionIsActive = MaweMultiSubtitleCore.multiSubtitleVisible()
    && activeCuePanel?.kind === 'extension'
    && MaweSelection.selectedExtensionIdxs.size === 1
    && MaweSelection.selectedExtensionIdxs.has(activeCuePanel.index)
    && operationReference?.track === 'extension'
    && pointerExtensionIndex === activeCuePanel.index;
  const extensionIsActive = MaweMultiSubtitleCore.multiSubtitleVisible()
    && activeCuePanel?.kind === 'extension'
    && MaweSelection.selectedExtensionIdxs.size === 1
    && MaweSelection.selectedExtensionIdxs.has(activeCuePanel.index)
    && (!operationReference || pointerMainIndex < 0 || waveformExtensionIsActive);
  if (extensionIsActive) {
    const extensionIndex = [...MaweSelection.selectedExtensionIdxs][0];
    const track = activeExtensionTrack;
    const extension = track?.segments?.[extensionIndex];
    if (!extension) return;
    let timeMs = null;
    const pointerElement = MaweNavPreview.lastPointerPos
      ? document.elementFromPoint(MaweNavPreview.lastPointerPos.x, MaweNavPreview.lastPointerPos.y)
      : null;
    if (MaweSettings.EDITOR_SETTINGS.keyboardOperationReference === 'pointer'
        && MaweNavPreview.lastPointerPos && (pointerElement?.closest('#waveform-pane') || MaweNavPreview.lastEditRegion === 'waveform')) {
      const pointerTimeMs = MaweCoreState.waveformEditor?.timeMsAtPoint?.(MaweNavPreview.lastPointerPos.x, MaweNavPreview.lastPointerPos.y);
      if (Number.isFinite(pointerTimeMs) && pointerTimeMs > extension.start && pointerTimeMs < extension.end) {
        timeMs = pointerTimeMs;
      }
    }
    e.preventDefault();
    // 同上：首次 B 只负责打开副字幕拆分弹窗。
    e.stopImmediatePropagation();
    MaweSplitCore.openExtensionSplitModal(
      extensionIndex,
      MaweSettings.EDITOR_SETTINGS.keyboardOperationReference === 'playhead'
        ? operationReference?.timeMs ?? null : timeMs,
      track,
    );
    return;
  }
  // 1) 字幕列表：需要单选 + 悬停提供文字位置
  if (MaweSelection.selectedIdxs.size === 1) {
    const context = MaweNavPreview.hoveredSelectedCueContext();
    if (context && MaweBoot.DATA.segments[context.idx]) {
      splitAt(context.idx, context.x, context.y, null);
      return;
    }
  }
  // 2) 波形：指针音频位置
  if (operationReference?.source === 'pointer' || operationReference?.track === 'extension') {
    const idx = MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweBoot.DATA.segments);
    if (idx >= 0) {
      splitAt(idx, 0, 0, operationReference.timeMs);
      return;
    }
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const extensionIndex = MaweMultiSubtitleCore.multiSubtitleVisible() && operationReference.track === 'extension'
      ? MaweContextMenus.findWaveformCueAtTime(operationReference.timeMs, MaweMultiSubtitleCore.getExtensionTrack(operationReference.trackId)?.segments) : -1;
    if (extensionIndex >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      MaweSplitCore.openExtensionSplitModal(extensionIndex, operationReference.timeMs, MaweMultiSubtitleCore.getExtensionTrack(operationReference.trackId));
      return;
    }
    MaweHint.flashHint('指针位置没有可拆分字幕', 'invalid');
    return;
  }
  // 3) 播放头位置
  const timeMs = operationReference?.timeMs ?? Math.round(MaweCoreState.player.currentTime * 1000);
  const idx = MaweBoot.DATA.segments.findIndex((segment) => timeMs > segment.start && timeMs < segment.end);
  if (idx >= 0) {
    splitAt(idx, 0, 0, timeMs);
    return;
  }
  const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const extensionIndex = MaweMultiSubtitleCore.multiSubtitleVisible()
    ? MaweContextMenus.findWaveformCueAtTime(timeMs, extensionTrack?.segments) : -1;
  if (extensionIndex >= 0) {
    e.preventDefault();
    e.stopImmediatePropagation();
    MaweSplitCore.openExtensionSplitModal(extensionIndex, timeMs, extensionTrack);
    return;
  }
  MaweHint.flashHint('播放头位置没有可拆分字幕', 'invalid');
});

// 点击输入框外 -> 完成内联编辑。使用 pointerdown 捕获阶段，确保字幕行、
// 波形或其它控件的 pointerdown 处理/重绘发生前，当前文字已经写回 DATA。
// 双列时编辑行的容器同时包含主/副两列，因此只判断当前 contenteditable。
document.addEventListener('pointerdown', (e) => {
  const target = e.target instanceof Node ? e.target : null;
  if (MaweInlineEdit.editingState && (!target || !MaweInlineEdit.editingState.textEl.contains(target))) MaweInlineEdit.finishEdit(true);
  if (MaweInlineEdit.extensionEditingState && (
    !target || !MaweInlineEdit.extensionEditingState.textEl.contains(target)
  )) MaweInlineEdit.finishExtensionEdit(true);
}, true);

// === 字幕预览几何（preview.subtitle）===
// 归一化 {x,y,width,height} 存于 DATA.preview.subtitle。纯钳制/归一化逻辑在
// AsrEditorUtils（已单测）；这里只负责 DOM 应用、指针/键盘手势、每手势一条撤销、脏标记。


// 启动早期生成的自定义字体选项先用原始名称占位；共享工具层就绪后立即统一本地化。
MaweAppearance.relabelSubtitleFontFamilyOptions();




















// 字体 combobox：文本输入 + 可筛选下拉列表，交互对齐 Launcher「模型」输入框。
// getEntries() 返回 [{ value, label }]；选项点击或 Enter 写入 label 并派发 change，
// 由既有映射（subtitleFontFamilyInputToStored / assStyleForm change 委托）落库。
// 上下方向键在高亮项间移动（含首尾回绕前的边界钳制），输入仍可保留自定义值。
// 下拉面板打开时 portal 到 body 并按输入框矩形 fixed 定位：不参与设置面板的
// 滚动区（不撑高容器、不被面板边缘裁剪），宽度锁定与输入框同宽，贴底时上翻。
// 实例惰性创建：启动早期（relabelSubtitleFontFamilyOptions 于模块求值时被调用）
// 也可能触发重建，惰性创建避免引用后置声明造成暂时性死区。
function createFontFamilyCombobox({ input, toggle, options, getEntries }) {
  if (!input || !options) return { refresh() {}, setOpen() {} };
  let open = false;
  let entries = [];
  let activeIndex = -1;
  let blurTimer = 0;
  let reposition = null;
  const picker = options.parentElement;
  function optionId(index) {
    return options.id ? `${options.id}-option-${index}` : `font-combobox-option-${index}`;
  }
  function positionPanel() {
    const rect = input.getBoundingClientRect();
    const margin = 8;
    const viewportHeight = window.innerHeight;
    const cap = Math.max(120, Math.min(280, Math.round(viewportHeight * 0.4)));
    const spaceBelow = viewportHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openUp = spaceBelow < Math.min(cap, 140) && spaceAbove > spaceBelow;
    options.style.left = `${Math.round(rect.left)}px`;
    options.style.width = `${Math.round(rect.width)}px`;
    if (openUp) {
      options.style.top = 'auto';
      options.style.bottom = `${Math.round(viewportHeight - rect.top + 2)}px`;
      options.style.maxHeight = `${Math.max(120, Math.min(cap, spaceAbove))}px`;
    } else {
      options.style.bottom = 'auto';
      options.style.top = `${Math.round(rect.bottom + 2)}px`;
      options.style.maxHeight = `${Math.max(120, Math.min(cap, spaceBelow))}px`;
    }
  }
  function attachReposition() {
    reposition = () => positionPanel();
    window.addEventListener('resize', reposition);
    // capture 捕获任意祖先（设置面板体、模态框等）的滚动，浮层跟随输入框。
    document.addEventListener('scroll', reposition, true);
  }
  function detachReposition() {
    if (!reposition) return;
    window.removeEventListener('resize', reposition);
    document.removeEventListener('scroll', reposition, true);
    reposition = null;
  }
  function setActive(index, { scroll = false } = {}) {
    activeIndex = entries.length ? Math.max(0, Math.min(index, entries.length - 1)) : -1;
    Array.from(options.children).forEach((child, childIndex) => {
      child.classList?.toggle('active', childIndex === activeIndex);
    });
    if (activeIndex >= 0) {
      input.setAttribute('aria-activedescendant', optionId(activeIndex));
      if (scroll) options.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }
  function activeIndexOfValue() {
    const current = input.value.trim().toLocaleLowerCase();
    return entries.findIndex((entry) => entry.label.toLocaleLowerCase() === current);
  }
  function render(query = '') {
    entries = window.AsrEditorUtils.filterFontFamilyOptions(
      window.AsrEditorUtils.mergeFontFamilyOptions(getEntries()),
      query,
    );
    options.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('span');
      empty.className = 'font-combobox-empty';
      empty.textContent = '无匹配字体';
      options.append(empty);
    }
    entries.forEach((entry, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.id = optionId(index);
      option.className = 'font-combobox-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(entry.label === input.value.trim()));
      option.textContent = entry.label;
      option.addEventListener('click', () => selectEntry(index));
      options.append(option);
    });
    setActive(activeIndexOfValue());
  }
  function selectEntry(index) {
    const entry = entries[index];
    if (!entry) return;
    input.value = entry.label;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setOpen(false);
    input.focus();
  }
  function setOpen(next, query = '') {
    open = Boolean(next);
    input.setAttribute('aria-expanded', String(open));
    if (open) {
      render(query);
      // portal 到 body 脱离设置面板的滚动/裁剪上下文，先定位再显示避免闪跳。
      if (options.parentElement !== document.body) document.body.appendChild(options);
      positionPanel();
      attachReposition();
      options.hidden = false;
    } else {
      entries = [];
      setActive(-1);
      detachReposition();
      options.hidden = true;
      // 关闭后归还到 picker 内，保持模板 DOM 结构整洁。
      if (picker && options.parentElement !== picker) picker.appendChild(options);
      input.removeAttribute('aria-activedescendant');
    }
  }
  function moveActive(step) {
    if (!open) setOpen(true, input.value);
    if (!entries.length) return;
    setActive(activeIndex < 0 ? (step > 0 ? 0 : entries.length - 1) : activeIndex + step, { scroll: true });
  }
  function cancelPendingClose() {
    if (blurTimer) {
      window.clearTimeout(blurTimer);
      blurTimer = 0;
    }
  }
  // 失焦延迟关闭：选项与箭头 mousedown preventDefault 不夺焦点，.blur 只在真正
  // 离开组件（点击外部 / Tab）时触发；延迟窗口内重获焦点则取消关闭。
  input.addEventListener('focus', () => {
    cancelPendingClose();
    setOpen(true);
  });
  input.addEventListener('blur', () => {
    cancelPendingClose();
    blurTimer = window.setTimeout(() => {
      blurTimer = 0;
      if (open) setOpen(false);
    }, 120);
  });
  // 容器整体拦截 mousedown，点击面板空白处也不夺走输入框焦点。
  options.addEventListener('mousedown', (event) => event.preventDefault());
  input.addEventListener('input', () => setOpen(true, input.value));
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      if (activeIndex >= 0) selectEntry(activeIndex);
      else setOpen(false);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  });
  if (toggle) {
    toggle.addEventListener('mousedown', (event) => event.preventDefault());
    toggle.addEventListener('click', () => {
      cancelPendingClose();
      setOpen(!open, input.value);
    });
  }
  return {
    refresh() {
      if (open) render(input.value);
    },
    setOpen,
  };
}
function subtitleFontFamilyComboboxEntries() {
  const entries = window.AsrEditorUtils.SUBTITLE_FONT_FAMILY_PRESETS.map((preset) => {
    const label = MaweAppearance.subtitleFontFamilyPresetLabel(preset);
    return { value: label, label };
  });
  MaweAppearance.subtitleLocalFontFamilies.forEach((family) => {
    const label = MaweAppearance.subtitleFontFamilyDisplayName(family);
    entries.push({ value: label, label });
  });
  return entries;
}
function assFontNameComboboxEntries() {
  const entries = ASS_BUILTIN_FONT_SUGGESTIONS.map((name) => ({ value: name, label: name }));
  MaweAppearance.subtitleLocalFontFamilies.forEach((family) => {
    entries.push({ value: family, label: family });
  });
  return entries;
}
function getSubtitleFontFamilyCombobox() {
  if (!subtitleFontFamilyCombobox) {
    subtitleFontFamilyCombobox = createFontFamilyCombobox({
      input: subtitleFontFamilyInput,
      toggle: subtitleFontFamilyToggle,
      options: subtitleFontFamilyOptions,
      getEntries: subtitleFontFamilyComboboxEntries,
    });
  }
  return subtitleFontFamilyCombobox;
}
function getAssFontNameCombobox() {
  if (!assFontNameCombobox) {
    const assStyleFontNameInput = document.getElementById('ass-style-font-name');
    // 占位符跟随按操作系统选择的 ASS 默认字体，不再固定 Arial。
    if (assStyleFontNameInput) {
      const assDefaultFontName = window.AsrEditorUtils.ASS_DEFAULT_ASS_STYLE?.fontName;
      if (assDefaultFontName) assStyleFontNameInput.placeholder = assDefaultFontName;
    }
    assFontNameCombobox = createFontFamilyCombobox({
      input: assStyleFontNameInput,
      toggle: assStyleFontToggle,
      options: assStyleFontOptions,
      getEntries: assFontNameComboboxEntries,
    });
  }
  return assFontNameCombobox;
}
function rebuildSubtitleFontFamilyOptions() {
  getSubtitleFontFamilyCombobox().refresh();
}
function rebuildAssFontNameOptions() {
  getAssFontNameCombobox().refresh();
}



function normalizeAssColorStyleValue(value) {
  return typeof value === 'string' && ASS_COLOR_STYLE_VALUES.includes(value)
    ? value : null;
}


















MaweColors.subtitleColorPaletteNames.forEach((name) => {
  const colorInput = MaweColors.subtitleColorPaletteColorInputs[name];
  const hexInput = MaweColors.subtitleColorPaletteHexInputs[name];
  colorInput?.addEventListener('change', () => {
    MaweColors.setSubtitleColorPaletteValue(name, colorInput.value);
  });
  hexInput?.addEventListener('input', () => {
    if (/^#[0-9a-f]{6}$/iu.test(hexInput.value.trim())) {
      MaweColors.setSubtitleColorPaletteValue(name, hexInput.value);
    }
  });
  hexInput?.addEventListener('change', () => {
    MaweColors.setSubtitleColorPaletteValue(name, hexInput.value);
  });
});

MaweColors.subtitleColorPaletteResetButton?.addEventListener('click', () => {
  MaweSettings.updateEditorSettings({ subtitleColorPalette: { ...MaweColors.COLOR_PALETTE_DEFAULTS } });
  MaweColors.syncSubtitleColorPaletteControls();
  MaweColors.refreshSubtitleColorPalettePresentation();
  MaweHint.flashHint('已恢复内置字幕颜色', 'success');
});












MaweAppearance.initializeSubtitleFontFamilyScanner();


// 写回 DATA.preview.subtitle 并刷新 DOM。markDirty=false 用于初次加载，不弄脏工程。


// === 表情包预览几何（preview.sticker）===
// 与字幕预览同一套归一化/钳制逻辑，仅默认值不同（右上角小图）。

// 写回 DATA.preview.sticker 并刷新 DOM。markDirty=false 用于初次加载，不弄脏工程。


// 只有当对应预览开关开启时才允许几何编辑（关闭时字幕盒完全隐藏、表情包盒不拦截指针）。


// --- 指针拖动 / 缩放（Pointer Events），字幕预览与表情包预览共用 ---
  // { pointerId, handle, target, startX, startY, startGeo, rect }









MawePreviewGeometry.bindPreviewBoxPointerEvents(MaweDom.overlayEl, 'subtitle');

// --- 键盘操作（聚焦时），字幕预览与表情包预览共用 ---
// 方向键移动 1%；Shift 加速到 10%；Alt+方向缩放；Enter 切换 editable；Esc 失焦。

MaweDom.overlayEl.addEventListener('keydown', (event) => MawePreviewGeometry.handlePreviewBoxKeydown(event, 'subtitle'));

// 点击预览框（字幕/表情包）以外的地方：失焦并退出控制点编辑态，调整框随之隐藏。
// 捕获阶段监听，避免其他组件 pointerdown 的 stopPropagation 跳过失焦。
document.addEventListener('pointerdown', (event) => {
  if (MawePreviewGeometry.previewGesture) return;
  [MaweDom.overlayEl, MaweStickerOverlay.stickerOverlayLayer].forEach((el) => {
    if (el.contains(event.target)) return;
    el.classList.remove('editable');
    if (document.activeElement === el) el.blur();
  });
}, true);

// 播放器缩放时几何以百分比表达，天然自适应；ResizeObserver 仅在盒子越界后回钳。
if (typeof ResizeObserver === 'function') {
  const previewResizeObserver = new ResizeObserver(() => {
    MawePreviewGeometry.applyPreviewGeometryToDom(MaweAppearance.getPreviewGeometry());
    scheduleAssSubtitlePreviewRefresh();
  });
  previewResizeObserver.observe(MaweDom.playerStage);
}

// === 当前行高亮 + overlay ===

// 列表点击关闭自动滚动时，避免这次 seek 的同步 active 更新再次滚动列表；
// 播放指针拖动期间也暂时保持列表位置，避免连续 seek 触发滚动布局。
















function assPreviewAlignment(value) {
  const alignment = Math.min(9, Math.max(1, Math.round(Number(value) || 2)));
  const column = (alignment - 1) % 3;
  const row = Math.floor((alignment - 1) / 3);
  return {
    x: column / 2,
    y: row === 0 ? 1 : row === 1 ? 0.5 : 0,
    alignItems: column === 0 ? 'flex-start' : column === 1 ? 'center' : 'flex-end',
    justifyContent: row === 0 ? 'flex-end' : row === 1 ? 'center' : 'flex-start',
    textAlign: column === 0 ? 'left' : column === 1 ? 'center' : 'right',
  };
}

function assPreviewMetrics() {
  const resolution = MaweExportSrt.currentAssVideoResolution()
    || { width: 1920, height: 1080 };
  const rect = MaweDom.playerStage?.getBoundingClientRect?.();
  const stageWidth = Math.max(1, Number(rect?.width) || Number(MaweDom.playerStage?.clientWidth) || resolution.width);
  const stageHeight = Math.max(1, Number(rect?.height) || Number(MaweDom.playerStage?.clientHeight) || resolution.height);
  return {
    resolution,
    stageWidth,
    stageHeight,
    scaleX: stageWidth / resolution.width,
    scaleY: stageHeight / resolution.height,
  };
}

function assPreviewStyleVariant(style, segment, segments, appearance) {
  // ASS 预览的颜色映射只跟随 ass_color_style；color_underline 只控制 CSS 预览。
  const colorName = segment
    ? MULTI_SUBTITLE_UTILS.effectiveColorName(segment, segments) : null;
  const paletteValue = MaweColors.COLOR_BY_NAME[colorName]?.value || '';
  if (!paletteValue || typeof window.AsrEditorUtils.assStyleVariant !== 'function') return style;
  return window.AsrEditorUtils.assStyleVariant(
    style,
    paletteValue,
    appearance.ass_color_style || DEFAULT_ASS_COLOR_STYLE,
  );
}

function assPreviewAnimatedStyle(style, profile, animationState) {
  if (animationState.transformProgress === null) return style;
  const tags = profile?.animations?.t?.tags || '';
  return window.AsrEditorUtils.assPreviewStyleAt(style, tags, animationState.transformProgress);
}

function assPreviewFontSize(style, metrics) {
  // Style-library font sizes use the same 1080p reference as ASS export.
  // Export scales the value to PlayResY; applying the inverse stage scale here
  // keeps a 4K source visually consistent with its exported ASS rendering.
  return Math.max(1, Number(style.fontSize) || 18)
    * metrics.stageHeight / ASS_PREVIEW_REFERENCE_HEIGHT;
}

function applyAssPreviewElement(element, style, animationState, metrics, alignment, margins, anchorTranslate = '') {
  if (!element) return;
  const scaleX = metrics.scaleX;
  const scaleY = metrics.scaleY;
  const fontSize = assPreviewFontSize(style, metrics);
  const opacity = Math.max(0, Math.min(1,
    Number(animationState.opacity) * (1 - Math.max(0, Math.min(255, Number(style.alpha) || 0)) / 255),
  ));
  const outline = Math.max(0, Number(style.outline) || 0) * scaleY;
  const shadow = Math.max(0, Number(style.shadow) || 0) * scaleY;
  const spacing = (Number(style.spacing) || 0) * scaleY;
  const borderBox = Number(style.borderStyle) === 3;
  const transform = [];
  // 锚定元素（叠加轨/副字幕）的居中平移作为前缀并入，替代 CSS 类里的
  // translateX(-50%)（此处写 transform 会整体覆盖类内变换）。
  if (anchorTranslate) transform.push(anchorTranslate);
  const move = style.__assMove;
  if (move) {
    element.style.position = 'absolute';
    element.style.left = `${move.x * metrics.scaleX}px`;
    element.style.top = `${move.y * metrics.scaleY}px`;
    transform.push(`translate(${-alignment.x * 100}%, ${-alignment.y * 100}%)`);
  } else {
    element.style.position = '';
    element.style.left = '';
    element.style.top = '';
  }
  transform.push(`scale(${Math.max(0, Number(style.scaleX) || 100) / 100}, ${Math.max(0, Number(style.scaleY) || 100) / 100})`);
  if (Number(style.rotationX) || Number(style.rotationY)) transform.push('perspective(600px)');
  if (Number(style.rotationX)) transform.push(`rotateX(${Number(style.rotationX)}deg)`);
  if (Number(style.rotationY)) transform.push(`rotateY(${Number(style.rotationY)}deg)`);
  if (Number(style.angle)) transform.push(`rotateZ(${Number(style.angle)}deg)`);
  element.style.fontFamily = MaweAppearance.subtitleFontFamilyCss(style.fontName);
  element.style.fontSize = `${fontSize}px`;
  element.style.fontWeight = style.bold ? '700' : '400';
  element.style.fontStyle = style.italic ? 'italic' : 'normal';
  element.style.textDecorationLine = [style.underline ? 'underline' : '', style.strikeOut ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
  element.style.textDecorationColor = style.primaryColor;
  element.style.textUnderlineOffset = style.underline ? '0.16em' : '';
  element.style.color = style.primaryColor;
  element.style.webkitTextStroke = outline > 0 ? `${outline}px ${style.outlineColor}` : '';
  element.style.paintOrder = outline > 0 ? 'stroke fill' : '';
  element.style.filter = !borderBox && shadow > 0
    ? `drop-shadow(${shadow}px ${shadow}px 0 ${style.backColor})` : '';
  element.style.letterSpacing = `${spacing}px`;
  element.style.lineHeight = 'normal';
  // ASS 预览采用 no-wrap 策略：只保留字幕文本中的显式换行，
  // 不因为播放器容器边界重新插入自动换行。
  element.style.whiteSpace = 'pre';
  element.style.wordBreak = 'normal';
  element.style.maxWidth = 'none';
  element.style.padding = borderBox
    ? `${Math.max(1, 4 * scaleY)}px ${Math.max(1, 8 * scaleX)}px`
    : `${Math.max(1, scaleY)}px ${Math.max(1, 2 * scaleX)}px`;
  element.style.backgroundColor = borderBox ? style.backColor : 'transparent';
  element.style.borderRadius = '0';
  element.style.opacity = String(opacity);
  element.style.transformOrigin = `${alignment.x * 100}% ${alignment.y * 100}%`;
  element.style.transform = transform.join(' ') || 'none';
}

function applyAssPreviewSpeakerLabel(element, style, metrics) {
  if (!element) return;
  const scaleY = metrics.scaleY;
  const fontSize = assPreviewFontSize(style, metrics);
  const outline = Math.max(0, Number(style.outline) || 0) * scaleY;
  const shadow = Math.max(0, Number(style.shadow) || 0) * scaleY;
  const spacing = (Number(style.spacing) || 0) * scaleY;
  element.style.fontFamily = MaweAppearance.subtitleFontFamilyCss(style.fontName);
  element.style.fontSize = `${fontSize}px`;
  element.style.fontWeight = style.bold ? '700' : '400';
  element.style.fontStyle = style.italic ? 'italic' : 'normal';
  element.style.textDecorationLine = [style.underline ? 'underline' : '', style.strikeOut ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
  element.style.textDecorationColor = style.primaryColor;
  element.style.textUnderlineOffset = style.underline ? '0.16em' : '';
  element.style.webkitTextStroke = outline > 0 ? `${outline}px ${style.outlineColor}` : '';
  element.style.paintOrder = outline > 0 ? 'stroke fill' : '';
  element.style.filter = shadow > 0
    ? `drop-shadow(${shadow}px ${shadow}px 0 ${style.backColor})` : '';
  element.style.letterSpacing = `${spacing}px`;
  element.style.lineHeight = 'normal';
}

function clearAssPreviewSpeakerLabelStyle(element) {
  if (!element) return;
  [
    'font-size', 'font-family', 'font-weight', 'font-style', 'text-decoration-line',
    'text-decoration-color', 'text-underline-offset', 'color', '-webkit-text-stroke',
    'paint-order', 'filter', 'letter-spacing', 'line-height',
  ].forEach((property) => element.style.removeProperty(property));
}

function restoreCssSubtitlePreviewElement(element, appearance, fallbackSize, fallbackColor) {
  if (!element) return;
  [
    'font-size', 'font-family', 'font-weight', 'font-style', 'text-decoration-line',
    'text-decoration-color', 'text-underline-offset', 'color', ' -webkit-text-stroke',
    '-webkit-text-stroke', 'paint-order', 'filter', 'letter-spacing', 'line-height',
    'max-width', 'word-break', 'padding', 'background-color', 'border-radius', 'opacity', 'position',
    'left', 'right', 'top', 'bottom', 'white-space', 'text-align', 'transform-origin', 'transform',
  ].forEach((property) => element.style.removeProperty(property.trim()));
  element.style.setProperty(
    '--subtitle-preview-font-size',
    `${appearance.font_size || fallbackSize}px`,
  );
  element.style.fontFamily = MaweAppearance.subtitleFontFamilyCss(appearance.font_family);
  const hasCustomBackground = Object.prototype.hasOwnProperty.call(appearance, 'background_color')
    || Object.prototype.hasOwnProperty.call(appearance, 'background_alpha');
  element.style.backgroundColor = hasCustomBackground ? MaweAppearance.subtitleBackgroundCss(appearance) : '';
  element.style.color = appearance.color || fallbackColor;
}

function restoreCssSubtitlePreview() {
  MaweDom.overlayEl.removeAttribute('data-ass-mode');
  MaweDom.overlayEl.classList.remove('ass-preview-active');
  delete MaweDom.overlayTextEl.dataset.colorUnderline;
  delete MaweDom.overlayTextEl.dataset.colorText;
  delete MaweDom.overlayTextEl.dataset.colorStroke;
  delete MaweDom.overlayMainSpeakerLabelEl.dataset.color;
  ['align-items', 'justify-content', 'text-align', 'padding', 'box-sizing'].forEach((property) => {
    MaweDom.overlayEl.style.removeProperty(property);
  });
  MawePreviewGeometry.applyPreviewGeometryToDom(MaweAppearance.getPreviewGeometry());
  restoreCssSubtitlePreviewElement(
    MaweDom.overlayTextEl,
    MaweAppearance.getSubtitleAppearance(),
    MaweSettings.SUBTITLE_DEFAULT_FONT_SIZE,
    MaweSettings.DEFAULT_SUBTITLE_COLOR,
  );
  restoreCssSubtitlePreviewElement(
    MaweDom.overlayExtensionTextEl,
    MaweAppearance.getExtensionSubtitleAppearance(),
    MaweSettings.EXTENSION_SUBTITLE_DEFAULT_FONT_SIZE,
    MaweSettings.DEFAULT_EXTENSION_SUBTITLE_COLOR,
  );
  clearAssPreviewSpeakerLabelStyle(MaweDom.overlayMainSpeakerLabelEl);
  restoreAssOverlayTrackPreview();
}

function applyAssSubtitlePreview({ tMs, segment, extension, overlay, overlaySegments, mainColorName, speakerLabelVisible }) {
  const library = window.AsrEditorUtils.normalizeAssStyleLibrary(ASS_STYLE_LIBRARY);
  const profile = window.AsrEditorUtils.assProfileForId(
    library,
    library.assignments?.assExportProfileId || 'ass',
  );
  const baseStyle = window.AsrEditorUtils.assStyleForId(library, profile.styleId);
  const metrics = assPreviewMetrics();
  const alignment = assPreviewAlignment(baseStyle.alignment);
  const margins = {
    left: Math.max(0, Number(baseStyle.marginL) || 0) * metrics.scaleX,
    right: Math.max(0, Number(baseStyle.marginR) || 0) * metrics.scaleX,
    vertical: Math.max(0, Number(baseStyle.marginV) || 0) * metrics.scaleY,
  };
  const appearance = MaweAppearance.getSubtitleAppearance();
  const extensionSegments = activeExtensionSegments();
  const mainStyle = assPreviewStyleVariant(baseStyle, segment, MaweBoot.DATA.segments, appearance);
  // 副字幕使用样式库「副字幕样式」槽位的独立样式（副字幕不支持颜色分组，
  // 不做调色板变体），对齐与边距完全由该样式决定。
  const extensionStyleBase = window.AsrEditorUtils.assStyleForId(
    library, library.assignments?.assExtensionStyleId || 'ass-extension',
  );
  const extensionAlignment = assPreviewAlignment(extensionStyleBase.alignment);
  const extensionMargins = {
    left: Math.max(0, Number(extensionStyleBase.marginL) || 0) * metrics.scaleX,
    right: Math.max(0, Number(extensionStyleBase.marginR) || 0) * metrics.scaleX,
    vertical: Math.max(0, Number(extensionStyleBase.marginV) || 0) * metrics.scaleY,
  };
  // 叠加轨导出引用颜色样式名（无颜色时回落）；预览按同一映射
  // 应用 ass_color_style 的调色板变体，保持与导出一致。
  const overlayTrackStyle = assPreviewStyleVariant(
    baseStyle,
    overlay,
    overlaySegments || [],
    appearance,
  );
  const mainDuration = Math.max(1, Number(segment?.end) - Number(segment?.start) || 1);
  const extensionDuration = Math.max(1, Number(extension?.end) - Number(extension?.start) || 1);
  const mainAnimation = window.AsrEditorUtils.assPreviewAnimationState(
    profile,
    Math.max(0, Number(tMs) - Number(segment?.start || 0)),
    mainDuration,
    {
      playResX: metrics.resolution.width,
      playResY: metrics.resolution.height,
      stageWidth: metrics.stageWidth,
      stageHeight: metrics.stageHeight,
    },
  );
  const extensionAnimation = window.AsrEditorUtils.assPreviewAnimationState(
    profile,
    Math.max(0, Number(tMs) - Number(extension?.start || 0)),
    extensionDuration,
    {
      playResX: metrics.resolution.width,
      playResY: metrics.resolution.height,
      stageWidth: metrics.stageWidth,
      stageHeight: metrics.stageHeight,
    },
  );
  // 叠加轨不跟随 \move（绝对 PlayRes 坐标只属于主字幕）；fad/fade/t 与
  // 位置无关，预览与导出保持一致。
  const overlayDuration = Math.max(1, Number(overlay?.end) - Number(overlay?.start) || 1);
  const overlayAnimation = window.AsrEditorUtils.assPreviewAnimationState(
    profile,
    Math.max(0, Number(tMs) - Number(overlay?.start || 0)),
    overlayDuration,
    {
      playResX: metrics.resolution.width,
      playResY: metrics.resolution.height,
      stageWidth: metrics.stageWidth,
      stageHeight: metrics.stageHeight,
    },
  );
  const animationGroup = profile.animations || {};
  const withMove = (style, state) => ({
    ...assPreviewAnimatedStyle(style, profile, state),
    __assMove: animationGroup.move?.enabled ? { x: state.moveX, y: state.moveY } : null,
  });
  const animatedMainStyle = withMove(mainStyle, mainAnimation);
  // 副字幕与叠加轨不跟随 \move（绝对 PlayRes 坐标只属于主字幕）；
  // fad/fade/t 与位置无关，预览与导出保持一致。
  const animatedExtensionStyle = assPreviewAnimatedStyle(extensionStyleBase, profile, extensionAnimation);
  const animatedOverlayTrackStyle = assPreviewAnimatedStyle(overlayTrackStyle, profile, overlayAnimation);
  // 叠加轨锚定 = 下方最近一层的边距 + 1.2 × 该层字号（与导出的固化
  // 公式一致）：有副字幕时叠在副字幕上方，否则叠在主字幕上方。偏移按
  // 动画前的基础字号计算——导出侧 MarginV 固化在样式里，\t(\fs) 只改
  // 变字形大小，不改变锚定边距。
  const extensionTrackActive = extensionSegments
    .some((cue) => cue && cue.disabled !== true);
  const mainPreviewFontSize = assPreviewFontSize(baseStyle, metrics);
  const extensionPreviewFontSize = assPreviewFontSize(extensionStyleBase, metrics);
  const overlayOffsetPx = extensionTrackActive
    ? extensionMargins.vertical + 1.2 * extensionPreviewFontSize
    : margins.vertical + 1.2 * mainPreviewFontSize;

  MaweDom.overlayEl.dataset.assMode = 'true';
  MaweDom.overlayEl.classList.add('ass-preview-active');
  // ASS 的坐标系覆盖整个 PlayRes 画布；旧版 CSS 预览保存的自定义字幕盒
  // 只在 CSS 模式下生效，否则会把 Alignment / Margin 的语义再次套一层。
  MaweDom.overlayEl.style.left = '0';
  MaweDom.overlayEl.style.top = '0';
  MaweDom.overlayEl.style.right = 'auto';
  MaweDom.overlayEl.style.bottom = 'auto';
  MaweDom.overlayEl.style.width = '100%';
  MaweDom.overlayEl.style.height = '100%';
  MaweDom.overlayEl.style.alignItems = alignment.alignItems;
  MaweDom.overlayEl.style.justifyContent = alignment.justifyContent;
  MaweDom.overlayEl.style.textAlign = alignment.textAlign;
  MaweDom.overlayEl.style.boxSizing = 'border-box';
  MaweDom.overlayEl.style.padding = `${margins.vertical}px ${margins.right}px ${margins.vertical}px ${margins.left}px`;
  applyAssPreviewElement(MaweDom.overlayTextEl, animatedMainStyle, mainAnimation, metrics, alignment, margins);
  applyAssAnchoredPreviewElement(
    MaweDom.overlayExtensionTextEl, animatedExtensionStyle, extensionAnimation, metrics,
    extensionAlignment, extensionMargins, extensionMargins.vertical,
  );

  if (speakerLabelVisible) {
    applyAssPreviewSpeakerLabel(MaweDom.overlayMainSpeakerLabelEl, animatedMainStyle, metrics);
    // 与导出 assEventText 一致：text / speaker 模式标签跟随调色板颜色，其余保持基础色。
    const paletteColor = MaweColors.COLOR_BY_NAME[mainColorName]?.value;
    const assColorStyle = appearance.ass_color_style || DEFAULT_ASS_COLOR_STYLE;
    const labelColor = assColorStyle === 'text' || assColorStyle === 'speaker'
      ? paletteColor || animatedMainStyle.primaryColor
      : animatedMainStyle.primaryColor;
    MaweDom.overlayMainSpeakerLabelEl.style.color = labelColor;
    MaweDom.overlayMainSpeakerLabelEl.style.webkitTextStroke = animatedMainStyle.outline > 0
      ? `${animatedMainStyle.outline * metrics.scaleY}px ${animatedMainStyle.outlineColor}` : '';
    MaweDom.overlayMainSpeakerLabelEl.style.paintOrder = animatedMainStyle.outline > 0 ? 'stroke fill' : '';
    MaweDom.overlayMainSpeakerLabelEl.style.textDecorationColor = labelColor;
  } else {
    clearAssPreviewSpeakerLabelStyle(MaweDom.overlayMainSpeakerLabelEl);
  }
  // 链在副字幕上方时，叠加元素沿用副字幕样式的对齐与边距（与导出侧
  // Overlay 样式继承锚定层坐标系保持一致）。
  applyAssAnchoredPreviewElement(
    overlayTrackTextEl, animatedOverlayTrackStyle, overlayAnimation, metrics,
    extensionTrackActive ? extensionAlignment : alignment,
    extensionTrackActive ? extensionMargins : margins,
    overlayOffsetPx,
  );
}

// 锚定渲染：副字幕/叠加轨不参与容器的 flex 布局（CSS 模式下叠加文字
// 悬浮在预览框上沿之外，而 ASS 模式 overlayEl 已铺满整个舞台，那套
// 定位会把文字推出画面），改为按各自样式的对齐与边距绝对定位。垂直
// 偏移由调用方给出，替代样式的 marginV：副字幕直接用自己的边距，叠加
// 轨用链式锚定结果。中列/中行以 50% + 锚定平移居中，锚定平移作为前缀
// 并入 applyAssPreviewElement 的 scale/rotate 变换。
function applyAssAnchoredPreviewElement(element, style, animationState, metrics, alignment, margins, verticalOffsetPx) {
  if (!element) return;
  const anchorTranslate = `translate(${alignment.x === 0.5 ? '-50%' : '0%'}, ${alignment.y === 0.5 ? '-50%' : '0%'})`;
  applyAssPreviewElement(element, style, animationState, metrics, alignment, margins, anchorTranslate);
  // 定位须在 applyAssPreviewElement 之后写入：其无 \move 分支会清空
  // position/left/top，先写会被抹掉。
  element.style.position = 'absolute';
  if (alignment.x === 0.5) {
    element.style.left = '50%';
    element.style.right = 'auto';
  } else if (alignment.x === 1) {
    element.style.left = 'auto';
    element.style.right = `${Math.max(0, Math.round(margins.right))}px`;
  } else {
    element.style.left = `${Math.max(0, Math.round(margins.left))}px`;
    element.style.right = 'auto';
  }
  if (alignment.y === 0.5) {
    element.style.top = '50%';
    element.style.bottom = 'auto';
  } else if (alignment.y === 0) {
    // ASS 7-9 顶行：锚定边距从画面顶部算起。
    element.style.top = `${Math.max(0, Math.ceil(verticalOffsetPx))}px`;
    element.style.bottom = 'auto';
  } else {
    // ASS 1-3 底行：锚定边距从画面底部算起。
    element.style.top = 'auto';
    element.style.bottom = `${Math.max(0, Math.ceil(verticalOffsetPx))}px`;
  }
  element.style.whiteSpace = 'pre';
  element.style.wordBreak = 'normal';
  element.style.textAlign = alignment.textAlign;
}

function restoreAssOverlayTrackPreview() {
  if (!overlayTrackTextEl) return;
  [
    'position', 'left', 'right', 'top', 'bottom', 'white-space', 'word-break', 'text-align',
    'font-size', 'font-family', 'font-weight', 'font-style', 'text-decoration-line',
    'text-decoration-color', 'text-underline-offset', 'color', '-webkit-text-stroke',
    'paint-order', 'text-shadow', 'letter-spacing', 'line-height',
    'max-width', 'padding', 'background-color', 'border-radius', 'opacity',
    'transform-origin', 'transform',
  ].forEach((property) => overlayTrackTextEl.style.removeProperty(property));
  delete overlayTrackTextEl.dataset.colorUnderline;
  delete overlayTrackTextEl.dataset.colorText;
  delete overlayTrackTextEl.dataset.colorStroke;
}





// 列表重绘或属性批量变更后的 update() 只刷新时间码与激活态，不触发播放跟随滚动。
// renderAll 刚重建列表时，content-visibility 让视口外的行仍处于估算占位
// 高度，updateActiveCue 量到的瞬态几何会把「活动行不在视口」误判成真，
// 再用被污染的 offsetTop 算出错误目标平滑滚走（页面放大倍率越高、真实
// 行高与估算差异越大越容易触发）。这些操作是否滚动、滚到哪里都应由
// 调用方显式决定（例如拆分按来源保持原位或居中新右半段）。

// === 表情包预览（视频画面内）===
// 层位置/尺寸由 preview.sticker 几何驱动（默认右上角）；点击后可拖动/缩放，与字幕预览同一套交互。

MaweStickerOverlay.stickerOverlayLayer.id = 'sticker-overlay-layer';
MaweStickerOverlay.stickerOverlayLayer.className = 'geo-box';
MaweStickerOverlay.stickerOverlayLayer.tabIndex = 0;
MaweStickerOverlay.stickerOverlayLayer.setAttribute('role', 'group');
MaweStickerOverlay.stickerOverlayLayer.setAttribute('aria-label', '表情包预览位置。可拖动调整；方向键移动，按住 Shift 加速，按住 Alt 配合方向键调整大小，Enter 显示控制点，Esc 退出。');

MaweStickerOverlay.stickerOverlayContent.className = 'sticker-overlay-content';
MaweStickerOverlay.stickerOverlayLayer.appendChild(MaweStickerOverlay.stickerOverlayContent);
['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((h) => {
  const handle = document.createElement('span');
  handle.className = 'overlay-handle';
  handle.dataset.handle = h;
  MaweStickerOverlay.stickerOverlayLayer.appendChild(handle);
});
MaweDom.playerStage.appendChild(MaweStickerOverlay.stickerOverlayLayer);
MawePreviewGeometry.bindPreviewBoxPointerEvents(MaweStickerOverlay.stickerOverlayLayer, 'sticker');
MaweStickerOverlay.stickerOverlayLayer.addEventListener('keydown', (event) => MawePreviewGeometry.handlePreviewBoxKeydown(event, 'sticker'));











let activeStickerHasOverlay = false;







MaweDom.stickerOverlayToggle?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ stickerOverlayEnabled: MaweDom.stickerOverlayToggle.checked });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  MawePlaybackLoop.update();
});

// 初次应用（不弄脏工程）：字幕与表情包预览几何。必须在 stickerOverlayLayer 创建之后执行（TDZ）。
MawePreviewGeometry.setPreviewGeometry(MaweAppearance.getPreviewGeometry(), { markDirty: false });
MawePreviewGeometry.setStickerGeometry(MawePreviewGeometry.getStickerGeometry(), { markDirty: false });
MawePreviewGeometry.refreshPreviewGeometryEditable();

MaweMediaPlayback.bindPlayerEvents(MaweCoreState.player);
MaweDom.overlayToggle.addEventListener('change', () => {
  // change 触发时 checked 已是新值；其它预览样式和副字幕开关仍从当前快照保留。
  const previous = MaweHistory.snapshotPreviewState();
  previous.overlay = !MaweDom.overlayToggle.checked;
  MaweHistory.pushPreviewUndo('切换字幕预览', previous);
  MaweSettings.updateEditorSettings({ overlayEnabled: MaweDom.overlayToggle.checked });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  if (!MaweDom.overlayToggle.checked) MaweDom.overlayEl.classList.add('hidden');
  else MawePlaybackLoop.update();
});

// === 下载 ===
// 程序内开关（不暴露 GUI）：导出 SRT 时保留禁用项的时间轴序号但内容替换为空白




// 合并导出池：主轨 + 叠加轨按 start 归并。叠加段的 color_ref 指向叠加轨
// 自身数组，不能在合并后的大数组里按下标解析，因此同时返回归属集合，
// 由 colorContextResolver 提供每条段的颜色/说话人解析上下文。
function mergedExportSegments() {
  const overlaySegments = overlayTrackVisible() ? (getOverlayTrack()?.segments || []) : [];
  if (!overlaySegments.length) {
    return { segments: MaweBoot.DATA.segments, overlaySet: new Set(), overlaySegments };
  }
  return {
    segments: MULTI_SUBTITLE_UTILS.mergeMainAndOverlaySegments(MaweBoot.DATA.segments, overlaySegments),
    overlaySet: new Set(overlaySegments),
    overlaySegments,
  };
}

function exportColorContextResolver(overlaySet, overlaySegments) {
  return (segment) => (overlaySet.has(segment) ? overlaySegments : MaweBoot.DATA.segments);
}































const CANONICAL_PROJECT_FIELDS = new Set([
  'schema', 'media', 'language', 'language_source', 'split_mode', 'timestamp_granularity',
  'model', 'sticker_root', 'timebase', 'segments', 'multi_subtitle', 'overlay_track', 'waveform',
  'media_metadata', 'media_time_reference', 'spectral', 'waveform_reapeaks', 'loudness',
  'gap_remove', 'script_alignment', 'workspace', 'preview',
]);
let projectExtensionFields = Object.fromEntries(
  Object.entries(MaweBoot.DATA).filter(([key]) => !CANONICAL_PROJECT_FIELDS.has(key)),
);



// 保存/导出前的最后一道时间码兜底。波形拖动会把词时间码按像素取整，
// 极短词可能因此出现 1ms 的前后重叠；打开工程时的修复不足以覆盖这种
// “打开后编辑、随后保存”的路径。主轨和所有副字幕轨统一使用同一规则。
















































// 叠加字幕独立轨道：每段一个 Gap 承载 Marker（OTIO 没有文本轨原语，
// 与主轨字幕的 clip 标记同构但互不混写；颜色按叠加轨自身数组解析）。
// 标记时间沿用主轨标记的绝对媒体坐标约定。
function buildOverlaySubtitleOtioTrack(overlaySegments, intervals, sourceStartFrame) {
  const children = intervals.map((interval, index) => ({
    OTIO_SCHEMA: 'Gap.1',
    metadata: { moy: { asr_track: 'overlay', interval_index: index } },
    name: '',
    source_range: MaweExportTimeline.otioTimeRange(
      0,
      Math.max(1, MaweExportTimeline.msToOtioFrames(interval.end) - MaweExportTimeline.msToOtioFrames(interval.start)),
    ),
    effects: [],
    markers: MaweExportTimeline.buildGapRemovedSubtitleMarkers(interval, sourceStartFrame, overlaySegments, overlaySegments),
    enabled: true,
    color: null,
    })).filter((gap) => gap.markers.length > 0 || gap.source_range.duration.value > 1);
  return {
    OTIO_SCHEMA: 'Track.1',
    metadata: { moy: { asr_track: 'overlay' } },
    name: '叠加字幕',
    source_range: null,
    effects: [],
    markers: [],
    enabled: true,
    color: null,
    children,
    kind: 'Video',
  };
}











// 收集表情包条目；当传入 removed gaps 时，把每条表情包的时间映射到去空隙后的时间线，
// 并跳过完全落在空隙内、映射后时长归零的条目。removed 为空数组时退化为原始时间线。
// 表情包必须有真实磁盘路径（服务器 OTIO/OTIOZ 均按 sticker_rel 读盘）。


// 把表情包条目构建为一条可放进任意时间线 Stack 的单层视频轨（Gap 填充 + 图片 Clip）。
// stickers 会被就地排序；时间重叠时返回 { error }，由调用方决定中止还是跳过。
// 主轨与叠加轨各建一条轨，轨道名由调用方传入。






// OTIOZ 打包：前端把 timeline 交给服务器，服务器读盘打包 zip（content.otio + version.txt + media/*）。
// 需要 server-editor 模式 + 已绑定工程 + 已校验的表情包根目录（与便携文件夹导出同源）。









// 表情包导出的两种交付格式：
//   .otio（original 模式，引用 file:// 路径）始终可用
//   .otioz（服务器打包 zip）需要 server-editor + 已绑定工程文件，否则灰显并说明原因




// 灰显按钮的点击拦截：给出原因指引而非静默失败。




// === 标题区：媒体名点击复制 / 工程文件名点击复制 ===





// 浏览器「新建工程 / 另存为」选择的文件由页面持有 FileSystemFileHandle 持续写回；
// Server 绑定的工程仍由服务器按真实路径原子保存，且优先级高于句柄。





















let projectBackupTimer = null;
function syncProjectBackupControls() {
  const available = MaweServerSave.serverProjectSavingEnabled() && !MaweServerSave.projectFileHandle;
  const enabled = document.getElementById('project-backup-enabled');
  const minutes = document.getElementById('project-backup-minutes');
  const limit = document.getElementById('project-backup-limit');
  enabled.checked = MaweSettings.EDITOR_SETTINGS.projectBackupEnabled;
  enabled.disabled = !available;
  document.getElementById('project-backup-open').disabled = !available;
  minutes.value = MaweSettings.EDITOR_SETTINGS.projectBackupMinutes;
  limit.value = MaweSettings.EDITOR_SETTINGS.projectBackupLimit;
  minutes.disabled = limit.disabled = !available || !enabled.checked;
  document.getElementById('project-backup-unavailable').hidden = available;
  if (projectBackupTimer !== null) window.clearInterval(projectBackupTimer);
  projectBackupTimer = null;
  if (available && enabled.checked) {
    projectBackupTimer = window.setInterval(() => {
      void MaweProjectSave.saveProjectToServer({ silent: true, backupOnly: true });
    }, MaweSettings.EDITOR_SETTINGS.projectBackupMinutes * 60000);
  }
}
for (const [id, key, fallback, max] of [
  ['project-backup-enabled', 'projectBackupEnabled', true, 0],
  ['project-backup-minutes', 'projectBackupMinutes', 5, 1440],
  ['project-backup-limit', 'projectBackupLimit', 20, 1000],
]) {
  document.getElementById(id)?.addEventListener('change', (event) => {
    const value = max ? Math.min(max, Math.max(1, Math.round(Number(event.target.value) || fallback))) : event.target.checked;
    MaweSettings.updateEditorSettings({ [key]: value });
    syncProjectBackupControls();
  });
}

document.getElementById('project-backup-open')?.addEventListener('click', async () => {
  if (!MaweServerSave.serverProjectSavingEnabled() || MaweServerSave.projectFileHandle) return;
  try {
    const response = await fetch(new URL('/api/project/backups/open', window.location.href), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || response.status);
  } catch (error) {
    MaweHint.flashHint(`打开备份文件夹失败：${error.message || error}`, 'warning');
  }
});









// 文字编辑先写入页面内存，避免每个按键都请求服务器；失焦后短暂防抖保存，
// 这样点击其它字幕或刷新页面时不会因为 30 秒定时保存尚未到点而丢失刚完成的修改。




// 浏览器文件选择器拿不到工程的真实路径，但 MAW 工程记录的媒体是绝对路径。
// 把工程名与内容交给服务器，由它定位同目录同名工程并接管：
// 成功后整页刷新，由服务器渲染出自动加载媒体且可直接保存的状态。
// 任何失败都静默回退为「手动选择媒体」的便携流程。










// === 工作区库：服务器版可把工作区（窗口布局 + 显示状态）保存到本机设置，跨工程复用 ===












// 覆盖可能只存导航状态（后端自动创建），没有布局数据；只有含 navigation
// 以外字段的覆盖才能作为布局来源，否则退回内置默认布局。






















// 应用一次下拉选择：saved:* 从本机库恢复；内置 id 优先用本机覆盖版，否则用默认定义。
// 工作区 = 窗口布局 + 显示状态，切换时同时恢复该工作区保存的显示开关。






function projectSaveFingerprint() {
  return JSON.stringify([MaweBoot.DATA.segments, MaweBoot.DATA.multi_subtitle, MaweBoot.DATA.gap_remove,
    MaweBoot.DATA.preview, MaweBoot.DATA.media_metadata, MaweHistory.gapRemoveDirty, MaweAppearance.previewGeometryDirty, MaweServerSave.projectImportDirty]);
}



// 保存正在输入的文字，但不结束行内编辑、不替换节点、不移动光标。
function flushInlineEditsForSave() {
  const state = MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState;
  if (!state) {
    // Start/duration changes are committed by their own input handlers.  Only
    // flush the panel here when text input has actually opened a pending undo
    // edit; otherwise stale display values can rewrite externally changed
    // timing and schedule a second save.
    if (!MaweDom.cuePanel?.contains(document.activeElement) && MaweCuePanelState.cuePanelUndoPushed) {
      MaweCuePanel.commitCuePanelEdit();
    }
    return;
  }
  const extension = Boolean(MaweInlineEdit.extensionEditingState);
  const index = extension ? state.index : state.idx;
  const track = extension ? MaweMultiSubtitleCore.getExtensionTrack(state.trackId) : null;
  const segment = extension ? track?.segments[index] : MaweBoot.DATA.segments[index];
  const text = state.textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
  if (!segment || text === segment.text) return;
  MaweHistory.pushUndo(extension ? '编辑副字幕' : '编辑文本');
  segment.text = text;
  segment._dirty = true;
  state.original = text;
  state.el.classList.add('dirty');
  if (extension) {
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweCoreState.waveformEditor?.refreshExtensionCueLabel(index, state.trackId);
  } else MaweCoreState.waveformEditor?.refreshCueLabel(index);
  MaweInlineEdit.syncCuePanelAfterInlineEdit(extension ? 'extension' : 'main', index, state.trackId);
}





// 把当前工程写回页面持有的浏览器文件句柄（新建工程 / 另存为选定的目标）。


// 统一保存入口：句柄目标优先（最近一次新建/另存为选定的文件），否则写回服务器绑定工程。


// 另存为：打开系统文件浏览对话框把工程文件保存到用户选择的位置。
// 与「导出工程」的区别：保存成功后当前工程名跟随新文件（标题、导出默认名随之更新），
// 且后续 Ctrl(Cmd)+S / 自动保存都写回这个新选定的文件。



if (MaweProjectSave.mediaNameEl && !MaweProjectSave.mediaNameEl.classList.contains('empty')) {
  MaweProjectSave.mediaNameEl.addEventListener('click', () => {
    const name = MaweProjectSave.mediaNameEl.textContent.trim();
    if (name) MaweExportTimeline.copyText(name, `已复制媒体名：${name}`);
  });
}


if (MaweProjectSave.jsonNameEl && !MaweProjectSave.jsonNameEl.classList.contains('empty')) {
  MaweProjectSave.jsonNameEl.addEventListener('click', () => {
    const name = MaweProjectSave.jsonNameEl.textContent.trim();
    if (name) MaweExportTimeline.copyText(name, `已复制：${name}`);
  });
}









document.getElementById('download-fcp7-export')?.addEventListener('click', MaweDynamicExports.openFcp7ExportModal);
MaweDom.fcp7ExportNativeText?.addEventListener('change', () => {
  // 「导出字幕轨」只在写入原生文本时参与计划构建，未勾选时禁用以免造成可用的假象。
  MaweDom.fcp7ExportSubtitleTracks.disabled = !MaweDom.fcp7ExportNativeText.checked;
});
MaweDom.fcp7ExportCancel?.addEventListener('click', MaweDynamicExports.closeFcp7ExportModal);
MaweDom.fcp7ExportConfirm?.addEventListener('click', () => { void MaweDynamicExports.exportFcp7Xml(); });
MaweDom.fcp7ExportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.fcp7ExportModal) MaweDynamicExports.closeFcp7ExportModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.fcp7ExportModal.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDynamicExports.closeFcp7ExportModal();
}, true);









const DYNAMIC_EXPORT_CUSTOM_SIZE_LIMITS = { min: 16, max: 7680 };

// 打开弹窗时让「合成尺寸」自动匹配工程媒体元数据（schema §1.1 的成对宽高）；
// 命中预设选项就选中，否则落到自定义并预填媒体尺寸；没有元数据时保持现状。
function applyMediaSizeToResolutionModal(select, customRow, widthInput, heightInput) {
  if (!select) return;
  const size = window.AsrEditorUtils?.exportVideoSize?.(MaweBoot.DATA) || null;
  if (size && widthInput && heightInput) {
    widthInput.value = size.width;
    heightInput.value = size.height;
  }
  const preset = size ? `${size.width}x${size.height}` : '';
  if (preset && select.querySelector(`option[value="${preset}"]`)) {
    select.value = preset;
  } else if (size) {
    select.value = 'custom';
  }
  if (customRow) customRow.hidden = select.value !== 'custom';
}

function dynamicExportCanvasSize(select, widthInput, heightInput) {
  if (select?.value !== 'custom') {
    const match = /^(\d+)x(\d+)$/u.exec(select?.value || '');
    if (!match) return { width: 1920, height: 1080 };
    return { width: Number(match[1]), height: Number(match[2]) };
  }
  const limits = DYNAMIC_EXPORT_CUSTOM_SIZE_LIMITS;
  const width = Number(widthInput?.value);
  const height = Number(heightInput?.value);
  if (!Number.isInteger(width) || width < limits.min || width > limits.max
    || !Number.isInteger(height) || height < limits.min || height > limits.max) {
    throw new Error(MaweProjectSave.translatedEditorText(
      '自定义合成尺寸需要 16–7680 之间的整数宽高',
    ));
  }
  return { width, height };
}

function bindResolutionCustomSizeToggle(select, customRow) {
  select?.addEventListener('change', () => {
    if (customRow) customRow.hidden = select.value !== 'custom';
  });
}







document.getElementById('download-lottie')?.addEventListener('click', MaweDynamicExports.openLottieExportModal);
bindResolutionCustomSizeToggle(MaweDom.lottieExportResolution, lottieExportCustomSize);
MaweDom.lottieExportCancel?.addEventListener('click', MaweDynamicExports.closeLottieExportModal);
MaweDom.lottieExportConfirm?.addEventListener('click', () => { void MaweDynamicExports.exportLottieDynamicCaptions(); });
MaweDom.lottieExportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.lottieExportModal) MaweDynamicExports.closeLottieExportModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.lottieExportModal?.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDynamicExports.closeLottieExportModal();
}, true);















document.getElementById('download-ograf')?.addEventListener('click', MaweDynamicExports.openOgrafExportModal);
bindResolutionCustomSizeToggle(MaweDom.ografExportResolution, ografExportCustomSize);
MaweDom.ografExportCancel?.addEventListener('click', MaweDynamicExports.closeOgrafExportModal);
MaweDom.ografExportConfirm?.addEventListener('click', () => { void MaweDynamicExports.exportOgrafDynamicCaptions(); });
MaweDom.ografExportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.ografExportModal) MaweDynamicExports.closeOgrafExportModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.ografExportModal?.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDynamicExports.closeOgrafExportModal();
}, true);

MaweDom.downloadMultiSrtButton?.addEventListener('click', async () => {
  if (MaweInlineEdit.extensionEditingState) MaweInlineEdit.finishExtensionEdit(true);
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  if (!track) return;
  await MaweExportTimeline.downloadFile(MaweExportSrt.buildExtensionSrt(track), `${MaweBoot.FILENAME_BASE}_extension.srt`, 'text/plain', {
    desc: '副字幕 SRT 文件', types: { 'text/plain': ['.srt'] },
  });
});
document.getElementById('download-full-srt')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(MaweExportSrt.buildSrt(), `${MaweBoot.FILENAME_BASE}.srt`, 'text/plain', {
    desc: '完整 SRT 字幕文件', types: { 'text/plain': ['.srt'] }
  });
});
document.getElementById('download-full-ass')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(MaweExportSrt.buildAss(), `${MaweBoot.FILENAME_BASE}.ass`, 'text/plain', {
    desc: '完整 ASS 字幕文件', types: { 'text/plain': ['.ass'] }
  });
});
document.getElementById('download-color-srt')?.addEventListener('click', () => MaweExportSrt.downloadColorSrts(false));
document.getElementById('download-plain-text')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(window.AsrEditorUtils.buildPlainTextPayload(MaweBoot.DATA.segments), `${MaweBoot.FILENAME_BASE}.txt`, 'text/plain', {
    desc: '纯文本字幕文件', types: { 'text/plain': ['.txt'] }
  });
});
document.getElementById('download-json')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  await MaweExportTimeline.downloadFile(MaweJsonRepair.buildJson(), `${MaweBoot.FILENAME_BASE}.mosp`, 'application/json', {
    desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] }
  });
});
MaweDom.saveProjectButton?.addEventListener('click', () => MaweProjectSave.saveCurrentProject());
MaweDom.saveProjectAsButton?.addEventListener('click', () => MaweProjectSave.saveProjectAsToFile());
// Project-level save shortcuts intentionally override the browser page-save
// command. finishEdit() inside saveProjectToServer commits an active text edit.
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  if (event.shiftKey) {
    void MaweProjectSave.saveProjectAsToFile();
  } else {
    void MaweProjectSave.saveCurrentProject();
  }
});
document.getElementById('download-resolve-json')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportTimeline.buildResolveJson();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_resolve.json`, 'application/json', {
      desc: 'Resolve JSON', types: { 'application/json': ['.json'] }
    });
  }
});





MaweStickerOtioExport.stickerOtioExportMode?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ stickerOtioExportMode: MaweStickerOtioExport.stickerOtioExportMode.value });
});



document.getElementById('download-sticker-otio')?.addEventListener('click', () => {
  if (MaweExportTimeline.stickerExportBlocked('download-sticker-otio')) return;
  MaweStickerOtioExport.exportStickerOtio(
    'stickers', MaweExportTimeline.buildStickerOtio, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otio`, 'OTIO 工程文件'
  );
});
document.getElementById('download-gap-removed-srt')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportSrt.buildGapRemovedSrt();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.srt`, 'text/plain', {
      desc: '去空隙字幕 SRT', types: { 'text/plain': ['.srt'] }
    });
  }
});
document.getElementById('download-gap-removed-color-srt')?.addEventListener('click', () => MaweExportSrt.downloadColorSrts(true));
document.getElementById('download-gap-removed-ass')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportSrt.buildGapRemovedAss();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.ass`, 'text/plain', {
      desc: '去空隙带样式 ASS 字幕', types: { 'text/plain': ['.ass'] }
    });
  }
});
document.getElementById('download-otio')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportTimeline.buildSourceOtio();
  if (!payload) return;
  await MaweExportTimeline.downloadFile(payload, MaweBoot.FILENAME_BASE + '.otio', 'application/vnd.opentimelineio+json', {
    desc: 'OTIO 工程', types: { 'application/vnd.opentimelineio+json': ['.otio'] }
  });
  if (MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    await MaweExportTimeline.downloadFile(MaweExportSrt.buildSrt(), `${MaweBoot.FILENAME_BASE}.srt`, 'text/plain', {
      desc: '完整 SRT 字幕文件', types: { 'text/plain': ['.srt'] }
    });
  }
});
document.getElementById('download-otioz')?.addEventListener('click', async () => {
  const saved = await MaweExportTimeline.exportTimelineOtioz(
    'source',
    MaweExportTimeline.buildSourceOtio,
    MaweBoot.FILENAME_BASE + '.otioz',
    'OTIOZ 打包工程',
  );
  if (saved && MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    await MaweExportTimeline.downloadFile(MaweExportSrt.buildSrt(), `${MaweBoot.FILENAME_BASE}.srt`, 'text/plain', {
      desc: '完整 SRT 字幕文件', types: { 'text/plain': ['.srt'] }
    });
  }
});
document.getElementById('download-gap-removed-otio')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportTimeline.buildGapRemovedOtio();
  if (!payload) return;
  await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.otio`, 'application/vnd.opentimelineio+json', {
    desc: '去空隙 OTIO 工程', types: { 'application/vnd.opentimelineio+json': ['.otio'] }
  });
  if (MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    const srtPayload = MaweExportSrt.buildGapRemovedSrt();
    if (srtPayload) {
      await MaweExportTimeline.downloadFile(srtPayload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.srt`, 'text/plain', {
        desc: '去空隙字幕 SRT', types: { 'text/plain': ['.srt'] }
      });
    }
  }
});
document.getElementById('download-gap-removed-otioz')?.addEventListener('click', async () => {
  const saved = await MaweExportTimeline.exportTimelineOtioz(
    'gap-removed',
    MaweExportTimeline.buildGapRemovedOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.otioz`,
    '去空隙时间线 OTIOZ 打包工程',
  );
  if (saved && MaweSettings.EDITOR_SETTINGS.otioExportIncludeSrt) {
    const srtPayload = MaweExportSrt.buildGapRemovedSrt();
    if (srtPayload) {
      await MaweExportTimeline.downloadFile(srtPayload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.srt`, 'text/plain', {
        desc: '去空隙字幕 SRT', types: { 'text/plain': ['.srt'] }
      });
    }
  }
});
document.getElementById('download-gap-removed-ffconcat')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportSrt.buildGapRemovedFfconcat();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.ffconcat`, 'text/plain', {
      desc: 'FFconcat 剪辑计划', types: { 'text/plain': ['.ffconcat'] }
    });
  }
});
document.getElementById('download-gap-removed-regions-json')?.addEventListener('click', async () => {
  if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
  const payload = MaweExportSrt.buildGapRemovedRegionsJson();
  if (payload) {
    await MaweExportTimeline.downloadFile(payload, `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}.keep-regions.json`, 'application/json', {
      desc: '去空隙保留区域 JSON', types: { 'application/json': ['.json'] }
    });
  }
});
document.getElementById('download-gap-removed-sticker-otio')?.addEventListener('click', async () => {
  if (MaweExportTimeline.stickerExportBlocked('download-gap-removed-sticker-otio')) return;
  await MaweStickerOtioExport.exportStickerOtio(
    'gap-removed-stickers', MaweExportTimeline.buildGapRemovedStickerOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}-${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otio`, '去空隙表情包 OTIO 工程'
  );
});
document.getElementById('download-gap-removed-sticker-otioz')?.addEventListener('click', async () => {
  if (MaweExportTimeline.stickerExportBlocked('download-gap-removed-sticker-otioz')) return;
  const removed = MaweGapRemoveData.getRemovedGapRanges();
  if (!removed.length) {
    const msg = '没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除';
    MaweHint.flashHint(window.MAWE_I18N?.translateText?.(msg) || msg);
    return;
  }
  await MaweExportTimeline.exportStickerOtoz(
    'gap-removed-stickers', MaweExportTimeline.buildGapRemovedStickerOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('gap-removed') || 'gap-removed'}-${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otioz`, '去空隙表情包 OTIOZ 打包工程'
  );
});
document.getElementById('download-sticker-otioz')?.addEventListener('click', async () => {
  if (MaweExportTimeline.stickerExportBlocked('download-sticker-otioz')) return;
  await MaweExportTimeline.exportStickerOtoz(
    'stickers', MaweExportTimeline.buildStickerOtio,
    `${MaweBoot.FILENAME_BASE}_${window.MAWE_I18N?.exportTag?.('stickers') || 'stickers'}.otioz`, '表情包 OTIOZ 打包工程'
  );
});

// 时间线 OTIO / OTIOZ 导出选项：两个 OTIO 子菜单（原始 / 去空隙）共享同一份设置，
// 任一处勾选立即持久化并同步另一处；导出时由 buildSourceOtio / buildGapRemovedOtio 读取。





MaweExportTimeline.otioExportOptionInputs.forEach((input) => {
  input.addEventListener('change', () => {
    const key = MaweExportTimeline.OTIO_EXPORT_OPTION_KEYS[input.dataset.otioExportOption];
    if (!key) return;
    MaweSettings.updateEditorSettings({ [key]: input.checked });
    MaweExportTimeline.syncOtioExportOptionInputs();
    // 鼠标点击切换后立即交还焦点：焦点留在子菜单内的复选框上会让悬停关闭
    // 逻辑（wrapper.contains(document.activeElement)）一直误判指针仍在菜单内，
    // 导致二级菜单不再自动收起。键盘切换（:focus-visible）保持焦点不受影响。
    if (!input.matches(':focus-visible')) input.blur();
  });
});
MaweExportTimeline.syncOtioExportOptionInputs();

// 初始按服务器模式刷新表情包 OTIOZ 导出按钮的可用性
MaweExportTimeline.updateStickerExportButtons();
MaweExportTimeline.updateTimelineOtiozExportButtons();
MaweDynamicExports.updateLottieExportButton();
MaweDynamicExports.updateOgrafExportButton();

// === 工具栏导出下拉菜单 ===




MaweExportMenus.bindToolbarExportDropdown('subtitle-export-dropdown', 'subtitle-export-btn', 'subtitle-export-menu');
MaweExportMenus.bindToolbarExportDropdown('gap-removed-export-dropdown', 'gap-removed-export-btn', 'gap-removed-export-menu');
MaweExportMenus.bindToolbarExportDropdown('extra-export-dropdown', 'extra-export-btn', 'extra-export-menu');
MaweExportMenus.bindToolbarExportDropdown('open-project-dropdown', 'open-project-menu-btn', 'open-project-menu');
MaweExportMenus.bindToolbarExportDropdown('save-project-dropdown', 'save-project-menu-btn', 'save-project-menu');
MaweExportMenus.bindToolbarExportDropdown('workspace-transfer-dropdown', 'workspace-transfer-btn', 'workspace-transfer-menu');
MaweExportMenus.bindToolbarExportDropdown('multi-subtitle-settings-dropdown', 'multi-subtitle-settings-toggle', 'multi-subtitle-settings-menu');

MaweExportMenus.bindToolbarExportDropdown(
  'batch-operations-dropdown', 'batch-operations-btn', 'batch-operations-menu',
  MaweExportMenus.positionBatchOperationsMenu,
);

// === 打开工程 ===



  // 跟踪 blob URL，便于切换时 revoke 防泄漏






MaweDom.projectMediaSelectButton.addEventListener('click', () => {
  MaweProjectMediaInputs.closeProjectMediaModal(false);
  MaweProjectMediaInputs.loadMediaFileInput.value = '';
  MaweProjectMediaInputs.loadMediaFileInput.click();
});

MaweDom.projectMediaLaterButton.addEventListener('click', () => {
  MaweProjectMediaInputs.closeProjectMediaModal(true);
  MaweHint.flashHint('可稍后点击“加载媒体”选择关联媒体', 'invalid');
});

MaweDom.projectMediaModal.addEventListener('click', (event) => {
  if (event.target === MaweDom.projectMediaModal) MaweDom.projectMediaLaterButton.click();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.projectMediaModal.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweDom.projectMediaLaterButton.click();
}, true);











// 新建工程：浏览器原生保存对话框选择位置，页面持有句柄持续写回。
// 不再经过服务器 helper；服务器绑定的旧工程在创建成功后解除保存，避免串写。


// 浏览器自行管理的工程（句柄或下载创建）不能再写回服务器绑定的旧工程文件，
// 便携表情包 OTIO 也随之退回引用原始素材（服务器已不跟踪当前工程）。
















































document.getElementById('new-project')?.addEventListener('click', async () => {
  if (MaweServerSave.hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定新建工程？将丢失未保存内容。')) return;
  await MaweProjectLoad.createProjectCheckpoint(MaweProjectLoad.buildBlankProject(), MaweProjectLoad.suggestedProjectName());
});

document.getElementById('open-project')?.addEventListener('click', () => {
  if (MaweServerSave.hasUnsavedProjectChanges()) {
    if (!confirm('当前有未保存的改动，是否确定打开新工程？将丢失未保存内容。')) return;
  }
  MaweProjectMediaInputs.openProjectFileInput.value = '';
  MaweProjectMediaInputs.openProjectFileInput.click();
});

MaweProjectMediaInputs.openProjectFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !MaweDragDrop.isJsonFile(file)) {
    MaweHint.flashHint('请选择一个 .mosp 或 .json 工程文件。', 'invalid');
    return;
  }
  await MaweMultiImport.openProjectFile(file);
});

// === 加载媒体 ===
// 通过浏览器文件选择器选本地媒体（视频/音频），用 blob URL 替换播放器源。
// 如果媒体类型与当前播放器标签不一致（video<->audio），会原地替换整个 <video>/<audio> 元素。
document.getElementById('load-media')?.addEventListener('click', () => {
  MaweProjectMediaInputs.pendingProjectMediaSelection = null;
  MaweProjectMediaInputs.loadMediaFileInput.value = '';
  MaweProjectMediaInputs.loadMediaFileInput.click();
});
document.getElementById('load-srt')?.addEventListener('click', () => {
  MaweMultiSubtitleCore.pendingSrtImportAsExtension = false;
  if (MaweServerSave.hasUnsavedProjectChanges()
      && !confirm('当前有未保存的改动，是否确定加载字幕？将替换当前字幕。')) return;
  MaweProjectMediaInputs.loadSrtFileInput.value = '';
  MaweProjectMediaInputs.loadSrtFileInput.click();
});

MaweProjectMediaInputs.loadSrtFileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  const importAsExtension = MaweMultiSubtitleCore.pendingSrtImportAsExtension;
  MaweMultiSubtitleCore.pendingSrtImportAsExtension = false;
  if (!file) return;
  if (importAsExtension) {
    try {
      const segments = await MaweLoadingProgress.parseSubtitleImportFile(file);
      await MaweMultiImport.showMultiSubtitleImportChoice(file, segments);
    } catch (error) {
      MaweHint.flashHint(`导入字幕失败：${error.message || error}`, 'warning');
    }
    return;
  }
  await MaweMultiImport.openSrtFile(file);
});

MaweDom.multiSubtitleImportResultCancel?.addEventListener('click', MaweMultiImport.closeMultiSubtitleImportModal);
MaweDom.multiSubtitleImportExtension?.addEventListener('click', MaweMultiImport.prepareMultiSubtitleImport);
MaweDom.multiSubtitleImportReplace?.addEventListener('click', () => {
  const pending = MaweMultiImport.pendingMultiImport;
  if (!pending) return;
  if (pending.projectImport) {
    pending.choice = 'open-project';
    pending.match = null;
    MaweDom.multiSubtitleImportReplace?.setAttribute('aria-pressed', 'true');
    MaweDom.multiSubtitleImportExtension?.setAttribute('aria-pressed', 'false');
    MaweMultiImport.renderProjectImportPreview(pending);
    if (MaweDom.multiSubtitleImportResultConfirm) MaweDom.multiSubtitleImportResultConfirm.disabled = false;
    return;
  }
  if (pending.existingTrackId) {
    MaweMultiImport.prepareMultiSubtitleImport();
    return;
  }
  pending.choice = 'replace-main';
  pending.match = null;
  if (MaweDom.multiSubtitleImportReplace) MaweDom.multiSubtitleImportReplace.setAttribute('aria-pressed', 'true');
  if (MaweDom.multiSubtitleImportExtension) MaweDom.multiSubtitleImportExtension.setAttribute('aria-pressed', 'false');
  MaweMultiImport.renderMainImportPreview(pending);
  if (MaweDom.multiSubtitleImportResultConfirm) MaweDom.multiSubtitleImportResultConfirm.disabled = false;
});
MaweDom.multiSubtitleImportResultConfirm?.addEventListener('click', async () => {
  const pending = MaweMultiImport.pendingMultiImport;
  if (!pending?.choice) return;
  if (pending.choice === 'open-project') {
    const { projectFile, projectMediaFile } = pending;
    MaweMultiImport.closeMultiSubtitleImportModal();
    const opened = await MaweMultiImport.openProjectFile(projectFile, { suppressMediaPrompt: Boolean(projectMediaFile) });
    if (opened && projectMediaFile) await MaweMediaLoad.loadMediaFile(projectMediaFile);
    return;
  }
  if (pending.choice === 'replace-main') {
    const { segments, file } = pending;
    MaweMultiImport.closeMultiSubtitleImportModal();
    MaweProjectLoad.replaceMainTrack(segments, file.name, { overlaySegments: segments.overlaySegments || [] });
    return;
  }
  MaweMultiImport.commitMultiSubtitleImport();
});
MaweDom.multiSubtitleImportModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.multiSubtitleImportModal) MaweMultiImport.closeMultiSubtitleImportModal();
});
MaweDom.multiSubtitleSplitCancel?.addEventListener('click', MaweSplitCore.closeLinkedSplitModal);
multiSubtitleSplitDuplicate?.addEventListener('click', () => MaweSplitCore.confirmLinkedSplit({ duplicateText: true }));
MaweDom.multiSubtitleSplitConfirm?.addEventListener('click', MaweSplitCore.confirmLinkedSplit);
MaweDom.multiSubtitleSplitModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.multiSubtitleSplitModal) MaweSplitCore.closeLinkedSplitModal();
});
// 鼠标点击 lane 会自然聚焦；这里同步 keyboardLane，供失焦后的 WASD 回退使用。
MaweDom.multiSubtitleSplitMainText?.addEventListener('focus', () => {
  if (MaweSplitCore.pendingLinkedSplit) MaweSplitCore.pendingLinkedSplit.keyboardLane = 'main';
});
MaweDom.multiSubtitleSplitText?.addEventListener('focus', () => {
  if (MaweSplitCore.pendingLinkedSplit) MaweSplitCore.pendingLinkedSplit.keyboardLane = 'extension';
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !MaweDom.multiSubtitleImportModal?.classList.contains('show')) return;
  event.preventDefault();
  event.stopPropagation();
  MaweMultiImport.closeMultiSubtitleImportModal();
}, true);
// 拆分弹窗的键盘流：Tab 切换主/副 lane，WASD 或方向键移动 ✂️，
// Space 确认/取消确认断点；捕获阶段拦截，避免触发全局的选字幕与播放快捷键。
document.addEventListener('keydown', (event) => {
  if (!MaweDom.multiSubtitleSplitModal?.classList.contains('show')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    MaweSplitCore.closeLinkedSplitModal();
    return;
  }
  const state = MaweSplitCore.pendingLinkedSplit;
  if (!state) return;
  // 焦点在弹窗内原生控件（复选框/按钮）上时保留其自身键盘行为。
  const target = event.target instanceof Element ? event.target : null;
  const onNativeControl = Boolean(
    target?.closest('button, input, select, textarea, a, [contenteditable]'),
  );
  if (event.key === 'Tab' && !onNativeControl) {
    const current = MaweSplitCore.splitKeyboardActiveLane(state);
    const nextLane = MaweSplitCore.splitKeyboardSwitchLane(state, current);
    if (!nextLane || nextLane === current) return;
    event.preventDefault();
    event.stopPropagation();
    MaweSplitCore.focusSplitLane(state, nextLane);
    return;
  }
  if (!event.repeat
      && (event.key === 'Enter' || event.key === 'b' || event.key === 'B')
      && !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) {
    event.preventDefault();
    event.stopPropagation();
    MaweSplitCore.confirmLinkedSplit();
    return;
  }
  if (MaweKeyboardTargets.isSpaceKey(event)) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (onNativeControl || event.repeat) return;
    const lane = MaweSplitCore.splitKeyboardActiveLane(state);
    if (!lane || !MaweSplitCore.splitLaneVisible(lane)) return;
    event.preventDefault();
    event.stopPropagation();
    MaweSplitCore.toggleSplitLaneKeyboardLock(state, lane);
    return;
  }
  const key = event.key.toLowerCase();
  const horizontal = key === 'a' || event.key === 'ArrowLeft' ? -1
    : key === 'd' || event.key === 'ArrowRight' ? 1 : 0;
  const vertical = key === 'w' || event.key === 'ArrowUp' ? -1
    : key === 's' || event.key === 'ArrowDown' ? 1 : 0;
  if (!horizontal && !vertical) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const lane = MaweSplitCore.splitKeyboardActiveLane(state);
  if (!lane) return;
  if (!MaweSplitCore.splitLaneKeyboardInteractive(state, lane)) {
    // ⌚️ 时间码锚定的主轨静默忽略；Space/点击锁定的 lane 闪烁边缘并提示先解锁。
    if (!event.repeat && MaweSplitCore.splitLaneLocked(state, lane)) MaweSplitCore.flashSplitLaneBlockedFeedback(lane);
    return;
  }
  const nextOffset = vertical
    ? MaweSplitCore.verticalSplitLaneOffset(state, lane, vertical)
    : MaweSplitCore.stepSplitLaneOffset(state, lane, horizontal);
  if (!Number.isFinite(nextOffset)) return;
  event.preventDefault();
  event.stopPropagation();
  MaweSplitCore.updateLinkedSplitPreview(nextOffset, lane);
}, true);









MaweProjectMediaInputs.loadMediaFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!MaweProjectMediaInputs.pendingProjectMediaSelection && !await MaweProjectLoad.ensureProjectCheckpointForImport(file)) return;
  MaweProjectMediaInputs.pendingProjectMediaSelection = null;
  const imported = await MaweMediaLoad.loadMediaFile(file);
  if (imported) {
    MaweServerSave.projectImportDirty = true;
    if (MaweServerSave.projectSaveTargetEnabled()) await MaweProjectSave.saveCurrentProject({ silent: true });
  }
});

MaweProjectMediaInputs.loadMediaFileInput.addEventListener('cancel', () => {
  MaweProjectMediaInputs.pendingProjectMediaSelection = null;
});

// === 表情包根目录配置 ===












document.getElementById('sticker-root-confirm')?.addEventListener('click', () => {
  const newRoot = MaweStickerRoot.stickerRootInput.value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  MaweBoot.STICKER_ROOT = newRoot;
  MaweExportTimeline.updateStickerExportButtons();
  MaweStickerRoot.stickerRootModal.classList.remove('show');
  MaweStickerRoot.stickerRootReturnFocus?.focus();
  MaweStickerRoot.stickerRootReturnFocus = null;
  // 重新渲染所有 cue 让 sticker URL 用新根目录拼接
  MaweCuePanel.renderAll();
  MaweHint.flashHint(newRoot ? `根目录已更新` : '已清空根目录', 'success');
});



if (!MaweStickerRoot.stickerRootServerEnabled) {
  MaweStickerRoot.stickerRootInput.disabled = true;
  MaweStickerRoot.stickerRootRead.disabled = true;
}

document.getElementById('sticker-root-btn')?.addEventListener('click', () => {
  MaweStickerRoot.stickerRootInput.value = MaweBoot.STICKER_ROOT || '';
  MaweStickerRoot.setStickerRootStatus(MaweStickerRoot.stickerRootServerEnabled
    ? (MaweBoot.STICKER_ROOT
      ? `当前路径已读取 ${Number(MaweBoot.SERVER_CONFIG.initialStickerCount) || MaweBoot.STICKERS.length} 张图片。可输入 Windows、macOS 或 Linux 绝对路径。`
      : '请输入绝对路径，例如 C:\\Media\\Stickers、/Users/name/Stickers 或 /home/name/Stickers。')
    : '仅 Server 编辑器可以读取和验证表情包绝对路径。');
  MaweStickerRoot.setStickerRootModalOpen(true);
});

document.getElementById('sticker-root-cancel')?.addEventListener('click', () => MaweStickerRoot.setStickerRootModalOpen(false));
MaweStickerRoot.stickerRootModal?.addEventListener('click', (event) => {
  if (event.target === MaweStickerRoot.stickerRootModal) MaweStickerRoot.setStickerRootModalOpen(false);
});
MaweStickerRoot.stickerRootModal?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    MaweStickerRoot.setStickerRootModalOpen(false);
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...MaweStickerRoot.stickerRootModal.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

MaweStickerRoot.stickerRootRead.addEventListener('click', async () => {
  if (!MaweStickerRoot.stickerRootServerEnabled || MaweStickerRoot.stickerRootRead.disabled) return;
  const path = MaweStickerRoot.stickerRootInput.value.trim();
  MaweStickerRoot.stickerRootHintCard?.remove();
  MaweStickerRoot.stickerRootHintCard = null;
  MaweStickerRoot.stickerRootRead.disabled = true;
  MaweStickerRoot.stickerRootInput.disabled = true;
  MaweStickerRoot.setStickerRootStatus('正在读取并验证表情包目录…');
  try {
    const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.stickerRootUrl, window.location.href), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken: MaweBoot.SERVER_CONFIG.requestToken, path }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `服务器返回 ${response.status}`);
    MaweBoot.STICKERS.splice(0, MaweBoot.STICKERS.length, ...result.stickers);
    MaweBoot.STICKER_ROOT = result.root;
    MaweBoot.SERVER_CONFIG.initialStickerCount = result.count;
    MaweStickerRoot.stickerRootInput.value = result.root;
    MaweStickerOverlay.stickerAssetRevision += 1;
    MaweServerSave.projectImportDirty = true;
    MaweCuePanel.renderAll();
    MaweStickerRoot.setStickerRootStatus(`路径有效，已读取 ${result.count} 张图片。`);
    MaweStickerRoot.flashStickerRootHint(`表情包根目录已更新，读取 ${result.count} 张图片`, 'success');
  } catch (error) {
    MaweStickerRoot.setStickerRootStatus(`读取失败：${error.message || error}。当前有效根目录和表情包保持不变。`);
    MaweStickerRoot.flashStickerRootHint(`表情包根目录读取失败：${error.message || error}`, 'warning');
  } finally {
    MaweStickerRoot.stickerRootRead.disabled = false;
    MaweStickerRoot.stickerRootInput.disabled = false;
    MaweStickerRoot.stickerRootInput.focus();
  }
});

// === 批量替换 ===










// null = 全部；[idxs] = 仅这些行















[MaweFindReplace.findInput, MaweFindReplace.replaceInput].forEach(el => el.addEventListener('input', MaweFindReplace.updatePreview));
[MaweFindReplace.caseSensitiveCb, MaweFindReplace.useRegexCb].forEach(el => el.addEventListener('change', MaweFindReplace.updatePreview));
MaweFindReplace.replaceSelectedOnlyCb?.addEventListener('change', () => {
  MaweFindReplace.replaceScope = MaweFindReplace.replaceSelectedOnlyCb.checked ? [...MaweFindReplace.replaceSelectionSnapshot] : null;
  MaweFindReplace.refreshScopeInfo();
  MaweFindReplace.updatePreview();
});



document.getElementById('replace-btn')?.addEventListener('click', () => MaweFindReplace.openReplaceModal(null));
document.getElementById('replace-cancel')?.addEventListener('click', () => MaweDom.replaceModal.classList.remove('show'));
MaweDom.replaceModal.addEventListener('click', (e) => { if (e.target === MaweDom.replaceModal) MaweDom.replaceModal.classList.remove('show'); });
document.getElementById('replace-confirm')?.addEventListener('click', () => {
  const re = MaweFindReplace.buildReplaceRegex();
  if (!re || re.error) return;
  const repl = MaweFindReplace.replaceInput.value;
  // 先 dry-run 确认是否真的会改动，避免空操作压栈
  let willChange = 0;
  MaweFindReplace.getReplaceTargets().forEach(s => {
    re.lastIndex = 0;
    if (s.text.replace(re, repl) !== s.text) willChange++;
  });
  if (willChange === 0) {
    MaweDom.replaceModal.classList.remove('show');
    MaweHint.flashHint('没有匹配的内容', 'invalid');
    return;
  }
  MaweHistory.pushUndo('批量替换');
  let changedRows = 0;
  MaweFindReplace.getReplaceTargets().forEach(s => {
    re.lastIndex = 0;
    const newText = s.text.replace(re, repl);
    if (newText !== s.text) { s.text = newText; s._dirty = true; changedRows++; }
  });
  MaweDom.replaceModal.classList.remove('show');
  MaweCuePanel.renderAll();
  MaweHint.flashHint(`已修改 ${changedRows} 行`, 'success');
});

// === 文本处理 ===










































MaweTextProcess.textProcessButton?.addEventListener('click', MaweTextProcess.openTextProcessModal);
MaweTextProcess.textProcessSelectedOnlyCb?.addEventListener('change', () => {
  MaweTextProcess.textProcessScope = MaweTextProcess.textProcessSelectedOnlyCb.checked
    ? [...MaweTextProcess.textProcessSelectionSnapshot] : null;
  MaweTextProcess.refreshTextProcessScopeInfo();
  MaweTextProcess.renderTextProcessPreview();
});
[MaweTextProcess.textProcessTrim, MaweTextProcess.textProcessCapitalize, MaweTextProcess.textProcessPrefix,
  MaweTextProcess.textProcessSuffix, MaweTextProcess.textProcessStripMarkdown].forEach((input) => {
  input?.addEventListener('change', () => {
    MaweTextProcess.refreshTextProcessInputState();
    MaweTextProcess.renderTextProcessPreview();
  });
});
[MaweTextProcess.textProcessPrefixInput, MaweTextProcess.textProcessSuffixInput].forEach((input) => {
  input?.addEventListener('input', MaweTextProcess.renderTextProcessPreview);
});
document.getElementById('text-process-cancel')?.addEventListener('click', MaweTextProcess.closeTextProcessModal);
MaweDom.textProcessModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.textProcessModal) MaweTextProcess.closeTextProcessModal();
});
MaweTextProcess.textProcessConfirm?.addEventListener('click', () => {
  const options = MaweTextProcess.getTextProcessOptions();
  const result = {
    rows: MaweTextProcess.buildTextProcessPreview(MaweTextProcess.textProcessTargets(), options),
  };
  result.changedCount = result.rows.filter((row) => row.changed).length;
  if (!result.changedCount) {
    MaweHint.flashHint('当前文本处理对于选中的字幕没有任何影响，未作改动', 'invalid');
    return;
  }
  let mainDraftTexts = null;
  const extensionDrafts = new Map();
  result.rows.filter((row) => row.changed).forEach((row) => {
    if (row.kind === 'extension') {
      const track = MaweMultiSubtitleCore.getExtensionTrack(row.trackId);
      if (!track) return;
      const draft = extensionDrafts.get(track.id) || {
        track,
        texts: track.segments.map((segment) => String(segment?.text || '')),
      };
      draft.texts[row.index] = row.after;
      extensionDrafts.set(track.id, draft);
      return;
    }
    if (!mainDraftTexts) {
      mainDraftTexts = MaweBoot.DATA.segments.map((segment) => String(segment?.text || ''));
    }
    mainDraftTexts[row.index] = row.after;
  });
  const nextMainSegments = mainDraftTexts
    ? window.AsrEditorUtils.applyTimedTextEdit(MaweBoot.DATA.segments, mainDraftTexts)
    : null;
  const nextExtensionSegments = [];
  for (const draft of extensionDrafts.values()) {
    const nextSegments = window.AsrEditorUtils.applyTimedTextEdit(draft.track.segments, draft.texts);
    if (!nextSegments) {
      MaweHint.flashHint('无法应用文本处理：字幕行结构发生了变化', 'warning');
      return;
    }
    nextExtensionSegments.push({ track: draft.track, segments: nextSegments });
  }
  if (mainDraftTexts && !nextMainSegments) {
    MaweHint.flashHint('无法应用文本处理：字幕行结构发生了变化', 'warning');
    return;
  }
  MaweHistory.pushUndo('文本处理');
  if (nextMainSegments) {
    MaweBoot.DATA.segments.splice(0, MaweBoot.DATA.segments.length, ...nextMainSegments);
    MaweMultiSubtitleCore.markMainSegmentsDirty(MaweBoot.DATA.segments);
  }
  nextExtensionSegments.forEach(({ track, segments }) => {
    track.segments.splice(0, track.segments.length, ...segments);
    track.segments.forEach((segment) => { segment._dirty = true; });
  });
  if (nextExtensionSegments.length) MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweMultiSubtitleCore.syncBindingOffsets();
  MaweServerSave.scheduleAutoSaveFlush();
  MaweTextProcess.closeTextProcessModal();
  MaweCuePanel.renderAll({ waveform: 'overlay' });
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweHistory.updateUndoRedoButtons();
  MaweHint.flashHint(`已应用文本处理：${result.changedCount} 条字幕`, 'success');
});

// === 纯文本编辑（支持调整字幕行结构的 MVP） ===
































































MaweDom.timedTextEditButton?.addEventListener('click', MaweTimedTextEdit.openTimedTextEdit);
MaweDom.timedTextEditRows?.addEventListener('input', (event) => {
  const textarea = event.target.closest?.('textarea[data-index]');
  if (!textarea || !MaweDom.timedTextEditDraft) return;
  const index = Number(textarea.dataset.index);
  if (!Number.isInteger(index) || index < 0 || index >= MaweDom.timedTextEditDraft.texts.length) return;
  const replacementLines = textarea.value.replace(/\r\n?/g, '\n').split('\n');
  MaweDom.timedTextEditDraft.texts.splice(index, 1, ...replacementLines);
  MaweDom.timedTextEditDraft.texts = MaweTimedTextEdit.normalizeTimedTextEditDraftLines(MaweDom.timedTextEditDraft.texts);
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  MaweDom.timedTextEditDraft.singleLineError = '';
  MaweTimedTextEdit.renderTimedTextEditView();
  MaweTimedTextEdit.scheduleTimedTextEditReport();
});
MaweDom.timedTextEditSingleTextarea?.addEventListener('input', () => {
  if (!MaweDom.timedTextEditDraft) return;
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditSingleTextarea.value.replace(/\r\n?/g, '\n');
  MaweDom.timedTextEditDraft.texts = MaweTimedTextEdit.normalizeTimedTextEditDraftLines(
    MaweDom.timedTextEditDraft.singleText.split('\n'),
  );
  MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  MaweDom.timedTextEditDraft.singleLineError = '';
  MaweTimedTextEdit.scheduleTimedTextEditReport();
});
MaweDom.timedTextEditView?.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-view]');
  if (!button || button.disabled || !MaweDom.timedTextEditDraft) return;
  // 视图切换可能紧跟在浏览器原生输入事件之前；以 textarea 当前值为准，
  // 避免“整体编辑”切到“逐行编辑”时回填旧草稿，导致修改前/修改后相同。
  MaweTimedTextEdit.syncTimedTextEditDraftFromDom();
  const nextView = button.dataset.view === 'single' ? 'single' : 'rows';
  if (nextView === 'single' && !MaweTimedTextEdit.timedTextEditCanUseSingleView()) {
    MaweHint.flashHint('当前字幕包含换行，暂不能切换到整体编辑视图', 'invalid');
    return;
  }
  MaweDom.timedTextEditDraft.view = nextView;
  if (nextView === 'single') MaweDom.timedTextEditDraft.singleText = MaweDom.timedTextEditDraft.texts.join('\n');
  else MaweTimedTextEdit.renderTimedTextEditRows();
  MaweTimedTextEdit.renderTimedTextEditView();
  MaweTimedTextEdit.flushTimedTextEditReport();
  setTimeout(() => (nextView === 'single'
    ? MaweDom.timedTextEditSingleTextarea : MaweDom.timedTextEditRows.querySelector('textarea'))?.focus(), 0);
});
MaweDom.timedTextEditShowAll?.addEventListener('click', () => {
  if (!MaweDom.timedTextEditDraft) return;
  MaweDom.timedTextEditDraft.filter = null;
  MaweTimedTextEdit.flushTimedTextEditReport();
});
MaweDom.timedTextEditShowDisabledToggle?.addEventListener('change', () => {
  if (!MaweDom.timedTextEditDraft) return;
  const nextShowDisabled = MaweDom.timedTextEditShowDisabledToggle.checked;
  if (nextShowDisabled === MaweDom.timedTextEditDraft.showDisabled) return;
  if (MaweTimedTextEdit.timedTextEditHasUnappliedChanges()
      && !window.confirm('切换显示范围会丢弃当前未应用的文本修改，是否继续？')) {
    MaweDom.timedTextEditShowDisabledToggle.checked = MaweDom.timedTextEditDraft.showDisabled;
    return;
  }
  MaweTimedTextEdit.loadTimedTextEditTrack(MaweDom.timedTextEditDraft.kind, { showDisabled: nextShowDisabled });
});
MaweDom.timedTextEditTrack?.addEventListener('change', () => {
  if (!MaweDom.timedTextEditDraft) return;
  if (MaweTimedTextEdit.timedTextEditHasUnappliedChanges()) {
    const confirmed = window.confirm('切换轨道会丢弃当前未应用的文本修改，是否继续？');
    if (!confirmed) {
      MaweDom.timedTextEditTrack.value = MaweDom.timedTextEditDraft.kind;
      return;
    }
  }
  MaweTimedTextEdit.loadTimedTextEditTrack(MaweDom.timedTextEditTrack.value, {
    showDisabled: MaweDom.timedTextEditDraft.showDisabled === true,
  });
});
MaweDom.timedTextEditClose?.addEventListener('click', MaweTimedTextEdit.requestCloseTimedTextEdit);
MaweDom.timedTextEditCancel?.addEventListener('click', MaweTimedTextEdit.requestCloseTimedTextEdit);
MaweDom.timedTextEditModal?.addEventListener('click', (event) => {
  if (event.target === MaweDom.timedTextEditModal) MaweTimedTextEdit.requestCloseTimedTextEdit();
});
MaweDom.timedTextEditApply?.addEventListener('click', () => {
  const draft = MaweDom.timedTextEditDraft;
  if (!draft) return;
  MaweTimedTextEdit.syncTimedTextEditDraftFromDom();
  MaweTimedTextEdit.flushTimedTextEditReport();
  if (!draft.report?.valid) return;
  if (!draft.report.stats.changedSegments) {
    MaweHint.flashHint('当前没有文本修改，未作改动', 'invalid');
    return;
  }
  const targetSegments = MaweTimedTextEdit.timedTextEditSegments(draft.kind);
  const snapshotSegments = Array.isArray(draft.allSourceSegments)
    ? draft.allSourceSegments : draft.sourceSegments;
  const currentMatchesSnapshot = targetSegments.length === snapshotSegments.length
    && targetSegments.every((segment, index) => {
      const source = snapshotSegments[index];
      return segment?.id === source?.id
        && Number(segment?.start) === Number(source?.start)
        && Number(segment?.end) === Number(source?.end)
        && String(segment?.text || '') === String(source?.text || '')
        && Boolean(segment?.disabled) === Boolean(source?.disabled);
    });
  if (!currentMatchesSnapshot) {
    MaweHint.flashHint('字幕在编辑窗口打开后发生了变化，请关闭窗口并重新打开', 'warning');
    MaweTimedTextEdit.closeTimedTextEdit();
    return;
  }
  const nextSegments = window.AsrEditorUtils.applyTimedTextEdit(
    draft.sourceSegments,
    draft.texts,
  );
  if (!nextSegments) {
    MaweHint.flashHint('无法应用文本修改：字幕行结构发生了变化', 'warning');
    return;
  }
  MaweHistory.pushUndo('纯文本编辑');
  const dirtyFlags = window.AsrEditorUtils.timedTextEditDirtyFlags(
    draft.sourceSegments,
    nextSegments,
    draft.report,
  );
  nextSegments.forEach((segment, index) => {
    if (dirtyFlags[index]) segment._dirty = true;
    else delete segment._dirty;
  });
  const removedCount = MaweTimedTextEdit.applyTimedTextEditSegments(
    draft.kind,
    draft.sourceSegments,
    targetSegments,
    nextSegments,
    draft.report,
    draft.texts,
    draft.sourceSegmentIndexes,
  );
  if (draft.kind === 'extension') MaweMultiSubtitleCore.markMultiSubtitleStateDirty();
  MaweMultiSubtitleCore.syncBindingOffsets();
  // 纯文本编辑应用后暂不主动触发自动保存，让 dirty 标记短暂保留，
  // 便于用户确认哪些字幕确实发生了变化；已有的自动保存计时器仍照常执行。
  const changedCount = draft.report.stats.changedSegments;
  const lostCount = draft.report.stats.lostMappedCues;
  const estimatedCount = draft.report.stats.estimatedTimingCues || 0;
  MaweTimedTextEdit.closeTimedTextEdit();
  MaweCuePanel.renderAll({ waveform: 'overlay' });
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  MaweHistory.updateUndoRedoButtons();
  MaweHint.flashHint(
    `已应用纯文本编辑：${changedCount} 条字幕${removedCount ? `，移除 ${removedCount} 条空字幕行` : ''}${lostCount ? `，${lostCount} 条字词时间码已清除` : ''}${estimatedCount ? `，${estimatedCount} 条时间范围为自动估算` : ''}`,
    'success',
  );
});

// === 表情包 ===
  // 'single' | 'multi'
     // 要分配的 segment indexes
let stickerTargetTrack = 'main'; // 'main' | 'overlay'：分配目标所在轨









document.getElementById('sticker-filter')?.addEventListener('input', (e) => {
  MaweStickerPicker.renderStickerGrid(e.target.value);
});
document.getElementById('sticker-cancel')?.addEventListener('click', () => MaweDom.stickerModal.classList.remove('show'));
document.getElementById('sticker-clear')?.addEventListener('click', MaweStickerPicker.clearStickerOnTargets);
MaweDom.stickerModal?.addEventListener('click', (e) => { if (e.target === MaweDom.stickerModal) MaweDom.stickerModal.classList.remove('show'); });

// 表情包预览 modal

let previewTrack = 'main';
function stickerSegmentsForTrack(track) {
  return track === 'overlay' ? (getOverlayTrack()?.segments || []) : MaweBoot.DATA.segments;
}

document.getElementById('sticker-preview-close')?.addEventListener('click', () => MaweDom.stickerPreviewModal.classList.remove('show'));
MaweDom.stickerPreviewModal?.addEventListener('click', (e) => { if (e.target === MaweDom.stickerPreviewModal) MaweDom.stickerPreviewModal.classList.remove('show'); });
document.getElementById('sticker-preview-delete')?.addEventListener('click', () => {
  if (MaweStickerPicker.previewIdx < 0) return;
  // 如果删除的是 head，要把所有引用它的 sticker_ref 也清掉
  MaweStickerPicker.removeStickerCascade(MaweStickerPicker.previewIdx, { overlay: previewTrack === 'overlay' });
  MaweDom.stickerPreviewModal.classList.remove('show');
  MaweCuePanel.renderAll();
  MaweHint.flashHint('已删除', 'success');
});

// 删除表情包时级联清理引用：
// - 如果 idx 是 head，清掉所有 headIdx===idx 的 sticker_ref
// - 如果 idx 是 ref，仅清自己（不影响 head）

document.getElementById('sticker-preview-replace')?.addEventListener('click', () => {
  if (MaweStickerPicker.previewIdx < 0) return;
  MaweDom.stickerPreviewModal.classList.remove('show');
  MaweStickerPicker.openStickerPicker([MaweStickerPicker.previewIdx], false, { overlay: previewTrack === 'overlay' });
});

// 拓展表情包时间到多选范围
// 选中范围内可以包含 sticker（head）或 sticker_ref（引用），都视作"已有表情包"


// === 标记颜色 ===
// 数据结构与表情包同构：head 持完整 color，后续条持 color_ref（仅 name + headIdx）
// 单选 → 设为 head；多选 → 第一条为 head，时间跨整个范围，后续为 ref
function colorGroupHeadIndex(idx) {
  const segment = MaweBoot.DATA.segments[idx];
  if (!segment) return -1;

  const refHeadIdx = Number(segment.color_ref?.headIdx);
  if (segment.color_ref
      && Number.isInteger(refHeadIdx)
      && refHeadIdx >= 0
      && refHeadIdx < MaweBoot.DATA.segments.length
      && refHeadIdx !== idx
      && MaweBoot.DATA.segments[refHeadIdx]?.color) {
    return refHeadIdx;
  }

  if (!segment.color) return -1;
  return MaweBoot.DATA.segments.some((candidate, candidateIdx) => (
    candidateIdx !== idx
    && candidate?.color_ref
    && Number(candidate.color_ref.headIdx) === idx
  )) ? idx : -1;
}

function detachColorFromGroup(idx) {
  const segment = MaweBoot.DATA.segments[idx];
  const headIdx = colorGroupHeadIndex(idx);
  const groupColor = headIdx >= 0 ? MaweBoot.DATA.segments[headIdx]?.color : null;
  if (!segment || !groupColor) return false;

  // 先复制颜色；拆分组时原 head 的时间范围可能会被收缩。
  const detachedColor = {
    ...groupColor,
    start: segment.start,
    end: segment.end,
  };
  MaweHistory.pushUndo('从颜色组中脱离');
  MaweSegmentOps.splitGroupsAtCutPoints(new Set([idx]), 'color', 'color_ref');
  segment.color = detachedColor;
  segment.color_ref = null;
  MaweColorFilter.refreshColorAssignmentUi();
  MaweHint.flashHint('已从颜色组中脱离', 'success');
  return true;
}



// === 叠加轨的颜色标记 ===
// 叠加段的颜色组只引用叠加轨自身段；这里按「单段自持 head」分配，
// 不产生跨轨引用，也不走主轨的组拆分逻辑。
function assignOverlayColor(idxs, colorName) {
  const overlay = getOverlayTrack();
  const def = MaweColors.COLOR_BY_NAME[colorName];
  if (!overlay || !def) return;
  const targets = [...new Set(idxs)].filter((index) => Number.isInteger(index) && overlay.segments[index]);
  if (!targets.length) return;
  MaweHistory.pushUndo('标记颜色');
  targets.forEach((index) => {
    const segment = overlay.segments[index];
    segment.color = { name: colorName, value: def.value, start: segment.start, end: segment.end };
    segment.color_ref = null;
    segment._dirty = true;
  });
  overlay._dirty = true;
  MaweColorFilter.refreshColorAssignmentUi();
  MaweServerSave.scheduleAutoSaveFlush();
  MaweHint.flashHint(targets.length === 1
    ? `已将字幕设为「${def.label}色」`
    : `已将 ${targets.length} 条字幕设为「${def.label}色」`, 'success');
}

// C 键批量合并：复用 Ctrl/Cmd+Shift+A / D 的 mergeOverlaySegments，共享
// 「下标连续」校验与颜色/表情包组继承语义。旧实现只延长首段自带的标记、
// 且仅按时间连续校验：混合组会丢标记，跳过中间段的合并会留下被新段覆盖
// 的旧段，保存后违反相邻段 end <= next.start 的契约导致工程无法再打开。
function mergeOverlayCues(idxs) {
  detachCuePanelFromTrackEdits();
  if (!mergeOverlaySegments(idxs)) return;
  MaweServerSave.scheduleAutoSaveFlush();
}

function clearOverlayColorOnTargets(idxs) {
  const overlay = getOverlayTrack();
  if (!overlay) return;
  const targets = [...new Set(idxs)].filter((index) => Number.isInteger(index) && overlay.segments[index]);
  if (!targets.length) return;
  MaweHistory.pushUndo('清除颜色');
  targets.forEach((index) => {
    const segment = overlay.segments[index];
    if (!segment) return;
    segment.color = null;
    segment.color_ref = null;
    segment._dirty = true;
  });
  overlay._dirty = true;
  MaweColorFilter.refreshColorAssignmentUi();
  MaweServerSave.scheduleAutoSaveFlush();
  MaweHint.flashHint('已清除颜色', 'success');
}

function clearOverlaySticker(index) {
  const overlay = getOverlayTrack();
  const segment = overlay?.segments?.[index];
  if (!segment || (!segment.sticker && !segment.sticker_ref)) return;
  segment.sticker = null;
  segment.sticker_ref = null;
  segment._dirty = true;
  overlay._dirty = true;
  MaweCuePanel.renderAll({ waveform: 'full' });
  MaweServerSave.scheduleAutoSaveFlush();
  MaweHint.flashHint('已删除', 'success');
}

// 删除颜色（级联清理）：
//   - idx 是 head: 清自己 + 所有 headIdx===idx 的 ref
//   - idx 是 ref: 仅清自己




// === 禁用/启用 ===
// 统一切换语义：目标全部禁用 → 全部启用；否则全部禁用
// 单条时即"切换这一条的状态"（Alt+点击 / 右键菜单均走这里）


// === 从波形空白处新增字幕 ===




// 叠加轨创建入口：与主轨不同，允许与主字幕时间重叠（这正是叠加轨的用途）；
// 只要求不与叠加轨自身已有段重叠，范围夹进相邻叠加段之间。
function addOverlayRangeFromWaveform(requestedStart, requestedEnd, clickX, clickY) {
  const overlay = getOverlayTrack();
  if (!overlay || !Array.isArray(overlay.segments)) {
    MaweHint.flashHint('当前没有可用的叠加字幕轨', 'invalid');
    return;
  }
  const duration = MaweCoreState.waveformEditor?.durationMs || (Number.isFinite(MaweCoreState.player.duration) ? MaweCoreState.player.duration * 1000 : 0);
  if (!duration) { MaweHint.flashHint('媒体时长尚未加载', 'invalid'); return; }
  requestedStart = MaweTimeline.timelineFrameAlignedMilliseconds(requestedStart);
  requestedEnd = MaweTimeline.timelineFrameAlignedMilliseconds(requestedEnd);
  const start = Math.min(requestedStart, requestedEnd);
  const end = Math.max(requestedStart, requestedEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  if (overlay.segments.some((segment) => start < Number(segment?.end) && end > Number(segment?.start))) {
    MaweHint.flashHint('拖动范围包含已有叠加字幕，无法新增叠加字幕', 'warning');
    return;
  }
  const insertAt = overlay.segments.findIndex((segment) => Number(segment.start) > start);
  const index = insertAt < 0 ? overlay.segments.length : insertAt;
  const previousEnd = index > 0 ? Number(overlay.segments[index - 1].end) : 0;
  const nextStart = index < overlay.segments.length ? Number(overlay.segments[index].start) : duration;
  const safeStart = Math.max(previousEnd, Math.min(duration, Math.round(start / 10) * 10));
  const safeEnd = Math.min(nextStart, Math.max(safeStart, Math.round(end / 10) * 10));
  if (safeEnd - safeStart < 100) {
    MaweHint.flashHint('该空白区域不足 100ms，无法新增叠加字幕', 'warning');
    return;
  }
  MaweCuePanel.commitCuePanelEdit();
  MaweHistory.pushUndo('新增叠加字幕');
  overlay.segments.splice(index, 0, {
    id: MULTI_SUBTITLE_UTILS.uniqueStableSegmentId(overlay.segments, `overlay-${index + 1}`, 'overlay'),
    start: safeStart,
    end: safeEnd,
    text: '',
    items: [],
    _dirty: true,
  });
  overlay._dirty = true;
  MaweSelection.clearSelection({ silent: true });
  MaweCuePanel.renderAll({ preserveCueListScroll: false });
  selectOverlayCueRow(index);
  setTimeout(() => MaweCuePanel.focusCuePanelText(index, 'overlay'), 0);
  MaweCoreState.waveformEditor?.revealTime(safeStart, true);
  MaweServerSave.scheduleAutoSaveFlush();
  MaweHint.flashHint(`已新增第 ${index + 1} 条叠加字幕`, 'success');
}

// 右键菜单 / 后续菜单入口：在指针时间点创建一条默认时长的叠加字幕，
// 范围夹进叠加轨相邻段之间（主轨是否占用不参与判断）。
function addOverlayAtWaveformTime(timeMs, clickX, clickY) {
  const overlay = getOverlayTrack();
  if (!overlay || !Array.isArray(overlay.segments)) {
    MaweHint.flashHint('当前没有可用的叠加字幕轨', 'invalid');
    return;
  }
  const duration = MaweCoreState.waveformEditor?.durationMs || (Number.isFinite(MaweCoreState.player.duration) ? MaweCoreState.player.duration * 1000 : 0);
  if (!duration) { MaweHint.flashHint('媒体时长尚未加载', 'invalid'); return; }
  timeMs = MaweTimeline.timelineFrameAlignedMilliseconds(timeMs);
  if (MaweContextMenus.findWaveformCueAtTime(timeMs, overlay.segments) >= 0) {
    MaweHint.flashHint('当前位置已有叠加字幕', 'invalid');
    return;
  }
  const insertAt = overlay.segments.findIndex((segment) => Number(segment.start) > timeMs);
  const index = insertAt < 0 ? overlay.segments.length : insertAt;
  const previousEnd = index > 0 ? Number(overlay.segments[index - 1].end) : 0;
  const nextStart = index < overlay.segments.length ? Number(overlay.segments[index].start) : duration;
  const gap = nextStart - previousEnd;
  if (gap < 100) {
    MaweHint.flashHint('这里没有足够的空白区域', 'warning');
    return;
  }
  const start = Math.max(previousEnd, Math.min(Math.round(timeMs / 10) * 10, nextStart - 100));
  const end = Math.min(nextStart, start + 1000);
  const adjustedStart = end - start >= 100 ? start : Math.max(previousEnd, nextStart - 1000);
  if (end - adjustedStart < 100) {
    MaweHint.flashHint('这里没有足够的空白区域', 'warning');
    return;
  }
  addOverlayRangeFromWaveform(adjustedStart, end, clickX, clickY);
}











// Alt 主字幕拖动中的副字幕挤压是临时预览：同一次拖动把主字幕拉回去时，
// 副字幕轨也必须从拖动开始时的完整快照恢复，而不能只恢复当前绑定的跟随字幕。










// 右键波形背景：添加空隙、创建字幕，或按右键对应的音频位置拆分命中的字幕。


// === 右键菜单 ===



// 叠加字幕块的右键菜单：转为主字幕 / 删除。叠加轨不参与拆分合并与绑定。
function showOverlayContextMenu(x, y, index) {
  const overlay = getOverlayTrack();
  const segment = overlay?.segments?.[index];
  if (!segment) return;
  // 主轨同时间段已有字幕时，转回去会产生主轨重叠，置灰禁用；
  // 只把该条叠加段的时间范围与主轨比对，相邻贴合（端点相接）不算占用。
  const mainOccupied = MaweBoot.DATA.segments.some((main) =>
    Number(main?.start) < Number(segment?.end) && Number(main?.end) > Number(segment?.start));
  MaweDom.ctxmenu.innerHTML = '';
  const addItem = (label, fn, opts = {}) => {
    const it = document.createElement('div');
    it.className = 'item' + (opts.danger ? ' danger' : '') + (opts.disabled ? ' disabled' : '');
    const lbl = document.createElement('span');
    lbl.textContent = label;
    it.appendChild(lbl);
    // 与其他菜单的 addItem 一致：禁用项只置灰，不绑定点击行为。
    if (!opts.disabled) {
      it.addEventListener('click', () => { MaweDom.ctxmenu.classList.remove('show'); fn(); });
    }
    MaweDom.ctxmenu.appendChild(it);
  };
  const addSep = () => {
    const sep = document.createElement('div');
    sep.className = 'sep';
    MaweDom.ctxmenu.appendChild(sep);
  };
  addItem('编辑文本', () => {
    MaweCuePanel.setCuePanelTarget('overlay', index);
    MaweCuePanel.focusCuePanelText(index, 'overlay');
  });
  if (MaweSettings.EDITOR_SETTINGS.clickBehavior === 'select-only') {
    addItem('跳转并播放', () => {
      MaweTextCleanup.seekFromWaveform(segment.start / 1000);
      if (MaweCoreState.player.paused) MaweMediaPlayback.togglePlayback();
    });
  }
  addItem('拆分此叠加字幕', () => openOverlaySplitModal(index, null));
  addItem('转为主字幕', () => convertOverlayCueToMain(index), { disabled: mainOccupied });
  addSep();
  // 组 2：外观（表情包与颜色），交互与主字幕菜单对齐（1~5 快捷键同源）。
  addItem('分配表情包…', () => MaweStickerPicker.openStickerPicker([index], false, { overlay: true }));
  if (segment.sticker || segment.sticker_ref) {
    addItem('删除表情包', () => clearOverlaySticker(index));
  }
  const colorRow = document.createElement('div');
  colorRow.className = 'item';
  colorRow.style.cssText = 'cursor:default;display:block;';
  colorRow.addEventListener('click', (e) => e.stopPropagation());
  const colorHead = document.createElement('div');
  colorHead.style.cssText = 'display:flex;align-items:center;';
  const colorLabel = document.createElement('span');
  colorLabel.textContent = '标记颜色';
  colorHead.appendChild(colorLabel);
  const colorRangeHint = document.createElement('kbd');
  colorRangeHint.textContent = '1~5';
  colorRangeHint.style.marginLeft = 'auto';
  colorHead.appendChild(colorRangeHint);
  colorRow.appendChild(colorHead);
  const swatches = document.createElement('div');
  swatches.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
  MaweColors.COLOR_PALETTE.forEach((c, colorIndex) => {
    const swatch = document.createElement('span');
    swatch.title = `${c.label}色（按 ${colorIndex + 1}）`;
    swatch.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c.value};border:1px solid rgba(255,255,255,.25);cursor:pointer;display:inline-block;box-sizing:border-box;flex:0 0 auto;`;
    swatch.addEventListener('mouseenter', () => swatch.style.transform = 'scale(1.15)');
    swatch.addEventListener('mouseleave', () => swatch.style.transform = '');
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      MaweDom.ctxmenu.classList.remove('show');
      assignOverlayColor([index], c.name);
    });
    swatches.appendChild(swatch);
  });
  colorRow.appendChild(swatches);
  MaweDom.ctxmenu.appendChild(colorRow);
  if (segment.color || segment.color_ref) {
    addItem('清除颜色', () => clearOverlayColorOnTargets([index]), { danger: true });
  }
  addSep();
  // 组 3：状态与删除（Alt+点击波形块亦可切换，此处为菜单入口）
  addItem(
    segment.disabled ? '启用此条' : '禁用此条',
    () => MaweStickerPicker.toggleDisabled([index], 'overlay'),
  );
  addSep();
  addItem('删除此叠加字幕', () => deleteOverlayCues([index]), { danger: true });
  MaweDom.ctxmenu.classList.add('show');
  const rect = MaweDom.ctxmenu.getBoundingClientRect();
  let nx = x, ny = y;
  if (x + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) ny = window.innerHeight - rect.height - 4;
  MaweDom.ctxmenu.style.left = nx + 'px';
  MaweDom.ctxmenu.style.top = ny + 'px';
}






// 使用捕获阶段的 pointerdown：波形空白区自己的 pointerdown 可能阻止后续
// click 事件，不能再依赖 mouseup 后才触发的 document.click 来关闭菜单。
document.addEventListener('pointerdown', MaweContextMenus.closeContextMenuOnOutsidePointerDown, true);
// 保留键盘触发 click 的关闭路径；真实鼠标/触控操作已经在 pointerdown 阶段关闭。
document.addEventListener('click', (e) => {
  if (e.detail === 0) MaweContextMenus.closeContextMenuOnOutsidePointerDown(e);
});
document.addEventListener('contextmenu', (e) => {
  // 非 cue 上的右键关闭菜单
  if (!e.target.closest('.cue') && !e.target.closest('.waveform-cue-block')) {
    MaweDom.ctxmenu.classList.remove('show');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && MaweDom.ctxmenu.classList.contains('show')) {
    MaweDom.ctxmenu.classList.remove('show');
  }
});

// === Hint ===
// 右上角提示卡片堆栈：样式在 editor.css（#hint-stack / .hint-card）。
// 最多同时显示 3 条，新提示追加在下方。


  // 与 editor.css 的 hint-fade-out 时长一致





// 振幅到达上下限时由波形模块派发的事件：rAF 节流后仍可能每帧触发，冷却避免提示闪烁


document.addEventListener('asr:waveform-scale-limit', (event) => {
  const { atMin, atMax } = event.detail || {};
  const msg = atMin ? '已经到达最小振幅' : atMax ? '已经达到最大振幅' : '';
  if (!msg) return;
  const now = Date.now();
  if (msg === MaweHint.lastScaleLimitMsg && now - MaweHint.lastScaleLimitAt < 1200) return;
  MaweHint.lastScaleLimitMsg = msg;
  MaweHint.lastScaleLimitAt = now;
  MaweHint.flashHint(msg);
});

document.addEventListener('asr:waveform-loudness-unavailable', () => {
  MaweHint.flashHint('当前媒体没有响度缓存，无法按响度适配', 'warning');
});

// === cleanPunctuation ===












// 原地切换工程（打开本地 .mosp / 新建空白 / 导入）会让 DATA 换成一个新工程，
// 但服务器的 /api/waveform 仍描述它自己绑定的旧工程。每次 applyCanonicalProject
// 递增该纪元；在途的延迟加载响应据此作废并终止轮询，旧工程的
// spectral / 波形 / 响度载荷绝不会套到新工程的波形上。




// 重试必须绑定发起时的工程纪元：排期期间原地切换了工程，这次重试就该取消。
// 否则新纪元的调用会原样接受旧工程的服务器载荷。
function scheduleDeferredReapeaksRetry(delayMs, epoch) {
  window.setTimeout(() => {
    if (epoch === MaweWaveformInit.deferredReapeaksEpoch) void MaweWaveformInit.loadDeferredReapeaks();
  }, delayMs);
}

// Server-editor 页面可能在本地服务退出后继续留在浏览器中。定期复用
// startup-status 这个轻量 JSON 接口：断联时保留页面里的编辑内容，并显示
// 持久横幅；服务恢复后自动清掉横幅，不刷新页面，避免覆盖未保存的改动。


















document.addEventListener('visibilitychange', () => {
  if (!document.hidden) MaweServerConnection.scheduleServerConnectionCheck(0);
});
window.addEventListener('online', () => MaweServerConnection.scheduleServerConnectionCheck(0));







// === Drag & Drop：拖入视频/音频/JSON/SRT 自动加载 ===




  // dragenter/leave 计数，避免子元素进出导致遮罩闪烁
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  MaweDragDrop.dragCounter++;
  if (MaweDragDrop.dragCounter === 1) MaweDragDrop.dragOverlay.classList.add('show');
});
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer) return;
  MaweDragDrop.dragCounter--;
  if (MaweDragDrop.dragCounter <= 0) { MaweDragDrop.dragCounter = 0; MaweDragDrop.dragOverlay.classList.remove('show'); }
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  MaweDragDrop.dragCounter = 0;
  MaweDragDrop.dragOverlay.classList.remove('show');
  void MaweDragDrop.handleDroppedFiles(Array.from(e.dataTransfer.files));
});

// === 启动 ===
// 兜底：工程可能带有上游写入的 0 长/倒挂段、词时间码（旧版工具或异常识别结果），
// 加载时统一拉齐到至少 100ms，避免拆分后看不见字幕块、工程无法保存。
MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: MaweBoot.DATA.timebase?.unit === 'frames' });
const repairedGroupReferenceCount = window.AsrEditorUtils.repairGroupReferenceIndices(MaweBoot.DATA.segments);
const repairedTimingCount = MaweJsonRepair.normalizeProjectTimings(MaweBoot.DATA);
MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
MaweBoot.maweDebug('boot:begin', {
  server: Boolean(MaweBoot.SERVER_CONFIG),
  segments: Array.isArray(MaweBoot.DATA.segments) ? MaweBoot.DATA.segments.length : null,
  media: MaweBoot.DATA.media || '',
  recentProjects: MaweBoot.SERVER_CONFIG?.recentProjects?.length || 0,
});
MaweTextCleanup.cleanPunctuation();
MaweServerSave.configureServerSaveControls();
MaweServerSave.configureServerAutoSave();
MaweServerSave.configureRecentProjects();
MaweServerSave.configureServerProjectSettings();
MaweWaveformInit.initWaveformEditor();
MaweWorkspaces.configureServerWorkspaceLibrary();
MaweWorkspaces.configureWorkspaceTransfer();
MaweDom.totalCountEl.textContent = MaweBoot.DATA.segments.length;
// 新手引导通过这个窄桥接访问编辑器核心状态；引导本身在 editor-onboarding.js 中按需初始化。
window.MAWE_EDITOR_BRIDGE = Object.freeze({
  get data() { return MaweBoot.DATA; },
  get selectedIdxs() { return MaweSelection.selectedIdxs; },
  get currentCuePanelIdx() { return MaweCuePanelState.currentCuePanelIdx; },
  get container() { return MaweCoreState.container; },
  get projectMediaModal() { return MaweDom.projectMediaModal; },
  selectOnly: MaweSelection.selectOnly,
  performUndo: MaweHistory.performUndo,
  flashHint: MaweHint.flashHint,
  scrollCueToCenter: MaweCueListAnchor.scrollCueToCenter,
  setEditorSettingsPanelOpen: MaweSettingsPanels.setEditorSettingsPanelOpen,
  modKeyLabel: MaweDisplaySettings.modKeyLabel,
  splitKeyLabel: MaweDisplaySettings.splitKeyLabel,
  openHelp: () => MaweHelpPanel.helpFloatingPanel.open(),
  openHelpAtTab: MaweHelpPanel.openHelpAtTab,
  closeHelp: () => MaweHelpPanel.helpFloatingPanel.close(),
});
window.MAWE?.register('editor-bridge', () => window.MAWE_EDITOR_BRIDGE);
MaweCuePanel.renderAll({ waveform: 'full' });
MaweBoot.maweDebug('boot:complete', {
  renderedSegments: MaweCoreState.container?.querySelectorAll?.('.cue-row')?.length || 0,
  recentProjectsVisible: MaweDom.recentProjectsEl ? !MaweDom.recentProjectsEl.hidden : false,
  mediaName: MaweProjectSave.mediaNameEl?.textContent || '',
  placeholderVisible: MaweDom.playerEmpty ? !MaweDom.playerEmpty.hidden : null,
});
MaweGapRemoveUi.updateGapRemoveUi();
if (repairedTimingCount > 0) {
  MaweHint.flashHint(`已自动修复 ${repairedTimingCount} 处异常时间码（保底 100ms）`, 'warning');
} else if (repairedGroupReferenceCount > 0) {
  MaweHint.flashHint(`已自动修复 ${repairedGroupReferenceCount} 处分组引用`, 'warning');
}
void MaweServerConnection.loadServerStartup();
MaweServerConnection.startServerConnectionMonitor();
if (MaweBoot.SERVER_CONFIG?.startupStatus !== 'loading') void MaweWaveformInit.loadDeferredReapeaks();

document.getElementById('filter-over')?.addEventListener('click', (e) => {
  e.currentTarget.classList.toggle('active');
  if (!e.currentTarget.classList.contains('active')) {
    MaweCueElements.clearTemporaryVisibleSplitCues();
  }
  MaweSearch.applySearch(MaweDom.searchEl.value);
});

// 「隐藏禁用项」开关：开启后禁用项 display:none，并从选中集移除
MaweDom.hideDisabledToggle?.addEventListener('change', () => {
  const cueListAnchor = MaweCueListAnchor.captureCueListRenderAnchor();
  MaweDom.hideDisabled = MaweDom.hideDisabledToggle.checked;
  MaweSettings.updateEditorSettings({ cueListHideDisabled: MaweDom.hideDisabled });
  MaweCoreState.container.classList.toggle('hide-disabled', MaweDom.hideDisabled);
  if (MaweDom.hideDisabled) {
    // 清理选中集中的禁用项（隐藏了但还留在选中集会造成状态不一致）
    [...MaweSelection.selectedIdxs].forEach(i => {
      if (MaweBoot.DATA.segments[i]?.disabled) {
        MaweSelection.selectedIdxs.delete(i);
        const el = MaweCoreState.container.querySelector(`.cue[data-idx="${i}"]`);
        if (el) el.classList.remove('selected');
      }
    });
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    [...MaweSelection.selectedExtensionIdxs].forEach((index) => {
      if (extensionTrack?.segments[index]?.disabled) MaweSelection.selectedExtensionIdxs.delete(index);
    });
    MaweSelection.updateMultiSelectionClasses();
    updateSelectionCountText();
    if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateSelection();
  }
  if (MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.updateDisabledVisibility();
  MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
});

// 离开提示
window.addEventListener('beforeunload', (e) => {
  if (MaweServerSave.hasUnsavedProjectChanges()) { e.preventDefault(); e.returnValue = ''; }
});

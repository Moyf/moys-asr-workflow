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
















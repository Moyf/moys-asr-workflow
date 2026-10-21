






function getOverlayTrack() {
  return window.AsrEditorUtils.getOverlayTrack(MaweBoot.DATA);
}

function overlayTrackVisible() {
  const track = getOverlayTrack();
  return track?.enabled === true && Array.isArray(track.segments) && track.segments.length > 0;
}

// === 主轨 ↔ 叠加轨 段落迁移 ===
// 两条轨道互不绑定；迁移保持目标轨按 start 升序（同 start 插到既有段之后），
// 返回段在目标轨中的新下标，失败返回 -1。数组操作委托给 editor-utils 纯函数。
function moveSegmentToOverlayTrack(index) {
  const segment = window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index];
  const overlay = window.AsrEditorUtils.ensureOverlayTrack(MaweBoot.DATA);
  if (!segment || !overlay || !Array.isArray(overlay.segments)) return -1;
  const newIndex = MULTI_SUBTITLE_UTILS.moveSegmentBetweenTracks(window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, overlay.segments, index);
  if (newIndex < 0) return -1;
  overlay.enabled = true;
  overlay._dirty = true;
  segment._dirty = true;
  MaweState.markProjectDirty();
  return newIndex;
}

function moveOverlaySegmentToMainTrack(index) {
  const overlay = getOverlayTrack();
  const segment = overlay?.segments?.[index];
  if (!segment || !Array.isArray(window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments)) return -1;
  const newIndex = MULTI_SUBTITLE_UTILS.moveSegmentBetweenTracks(overlay.segments, window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, index);
  if (newIndex < 0) return -1;
  overlay._dirty = true;
  segment._dirty = true;
  MaweState.markProjectDirty();
  return newIndex;
}

function shiftMainGroupRefsAfterMove(movedIndexes) {
  // Moving keeps stable group membership and only detaches bilingual relations.
  const movedIds = [...movedIndexes].map((index) => window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index]?.id).filter(Boolean);
  if (movedIds.length) {
    MaweMultiSubtitleCore.removeBindingsForSegmentIds(movedIds, []);
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
  }
}

function shiftMainGroupRefsAfterInsert() {}
function resetOverlayGroupRefs() {}

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
  return window.AsrEditorUtils.getSubtitleGroupValue(MaweBoot.DATA, segment, 'color');
}
function applyCueColorSnapshot(segment) { return Boolean(segment?.color_group_id); }
function captureCueStickerSnapshot(segments, index) {
  return window.AsrEditorUtils.getSubtitleGroupValue(MaweBoot.DATA, segments[index], 'sticker');
}
function applyCueStickerSnapshot(segment) { return Boolean(segment?.sticker_group_id); }

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
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)
    .sort((a, b) => a - b);
  if (!targets.length) return 0;
  detachCuePanelFromTrackEdits();
  const mutate = (command) => {
    // 迁移前快照颜色与表情包：splitGroupsAtCutPoints 会把切点的
    // color/color_ref/sticker/sticker_ref 清空，迁移后按快照物化回段上。
    const colorSnapshots = new Map(targets.map((index) => [index, {
      segment: window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index],
      color: captureCueColorSnapshot(window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index]),
      sticker: captureCueStickerSnapshot(window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, index),
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
      command.commit({ cueList: true, waveform: 'full' });
      MaweViewUpdates.invalidate({ save: true });
      MaweHint.flashHint(`已转为叠加字幕 ${converted} 条`, 'success');
    }
    return converted;
  };
  return pushHistory ? MaweCommands.run(label, mutate) : mutate({ commit: options => MaweViewUpdates.invalidate(options) });
}

// 拖动逃逸入口：单条迁移，不推送历史（拖动开始时已推）、不渲染（拖动中由
// 波形自刷新，列表在 onCommitEdit 的 renderAll 里更新）。返回新叠加轨下标。
// 迁移后主轨下标整体前移：同步主轨选中集与 Shift 锚点，避免选中状态落到
// 后面的字幕上；被迁移字幕保持选中（转入叠加轨选中集与字幕面板）。
function convertMainCueToOverlayForDrag(index) {
  if (!Number.isInteger(index) || index < 0 || index >= window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length) return -1;
  const panelWasHere = MaweCuePanelState.currentCuePanelKind === 'main' && MaweCuePanelState.currentCuePanelIdx === index;
  detachCuePanelDuringDrag();
  const segment = window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index];
  const colorSnapshot = captureCueColorSnapshot(segment);
  const stickerSnapshot = captureCueStickerSnapshot(window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, index);
  shiftMainGroupRefsAfterMove([index]);
  const newIndex = moveSegmentToOverlayTrack(index);
  if (newIndex < 0) return -1;
  applyCueColorSnapshot(segment, colorSnapshot);
  applyCueStickerSnapshot(segment, stickerSnapshot);
  const { wasSelected, nextAnchor } = MaweState.selection.removeAndShift('main', index);
  MaweSelection.lastClickedIdx = nextAnchor;
  updateSelectionCountText();
  if (panelWasHere) MaweCuePanel.setCuePanelTarget('overlay', newIndex);
  if (wasSelected) {
    MaweState.selection.add('overlay', newIndex);
    MaweState.selection.overlayAnchor = newIndex;
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
  resetOverlayGroupRefs(index);
  const newIndex = moveOverlaySegmentToMainTrack(index);
  if (newIndex < 0) return -1;
  applyCueColorSnapshot(segment, colorSnapshot);
  applyCueStickerSnapshot(segment, stickerSnapshot);
  shiftMainGroupRefsAfterInsert(newIndex);
  const { wasSelected, nextAnchor } = MaweState.selection.removeAndShift('overlay', index);
  MaweState.selection.overlayAnchor = nextAnchor;
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
  return MaweCommands.run('叠加字幕转为主字幕', (command) => {
    const segment = overlay.segments[index];
    const colorSnapshot = captureCueColorSnapshot(segment);
    const stickerSnapshot = captureCueStickerSnapshot(overlay.segments, index);
    // 与拖动入口一致：剩余组员先提升新 head，迁移段物化自持颜色/表情。
    resetOverlayGroupRefs(index);
    const newIndex = moveOverlaySegmentToMainTrack(index);
    if (newIndex < 0) return false;
    applyCueColorSnapshot(segment, colorSnapshot);
    applyCueStickerSnapshot(segment, stickerSnapshot);
    shiftMainGroupRefsAfterInsert(newIndex);
    MaweState.selection.removeAndShift('overlay', index);
    command.commit({ cueList: true, waveform: 'full' });

    MaweHint.flashHint('已转为主字幕', 'success');
    return true;
  });
}

function deleteOverlayCues(indices) {
  const overlay = getOverlayTrack();
  const sorted = [...new Set(Array.isArray(indices) ? indices : [])]
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < (overlay?.segments?.length || 0))
    .sort((a, b) => a - b);
  if (!sorted.length) return;
  detachCuePanelFromTrackEdits();
  return MaweCommands.run(`删除 ${sorted.length} 条叠加字幕`, (command) => {
    const removed = new Set(sorted);
    MaweSegmentOps.splitGroupsAtCutPoints(removed, 'color', 'color_ref', overlay.segments);
    MaweSegmentOps.splitGroupsAtCutPoints(removed, 'sticker', 'sticker_ref', overlay.segments);
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      resetOverlayGroupRefs(sorted[index]);
      overlay.segments.splice(sorted[index], 1);
    }
    MaweState.selection.clear('overlay');
    MaweState.selection.overlayAnchor = -1;
    overlay._dirty = true;
    command.commit({ cueList: true, waveform: 'full' });

    MaweHint.flashHint(`已删除 ${sorted.length} 条叠加字幕`, 'success');
  });
}







// 多重字幕关闭时轨道数据仍保留在工程里，但副字幕不参与 ASS 预览与导出；
// 与 multiSubtitleVisible() 的开合语义保持一致。
function activeExtensionSegments() {
  if (MaweMultiSubtitleCore.getActiveExtensionTrack()?.enabled !== true) return [];
  return MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || [];
}










// 合并多条字幕时按「字符型/单词型」取对应连接符：中文直接拼接，西文默认空格。


















































// 主字幕驱动副字幕时，目标范围优先；其它副字幕会被裁剪到目标范围之外，
// 完全被覆盖或无法保留最短时长的字幕会被删除。主字幕时间始终不反向改变。










MaweMultiSubtitleCore.normalizeMultiSubtitleState();

















// 原生 number 输入框以 min=10、step=100 计算大于 100 的向下步进时，
// 会把 200 算成 110。把这个浏览器步进结果还原为用户看到的 100ms 档位，
// 同时保留 100ms 向下 90ms、向上 200ms 的边界行为。

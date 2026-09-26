
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

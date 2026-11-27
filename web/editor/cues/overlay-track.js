import { MaweBoot } from '../boot/editor-boot.js';
import { MawePlaybackLoop } from '../media/editor-playback-loop.js';
import { MaweCommands } from '../state/editor-commands.js';
import { MaweCoreState } from '../state/editor-core-state.js';
import { MaweCuePanelState } from '../state/editor-cue-panel-state.js';
import { MaweMultiSubtitleCore } from '../state/editor-multi-subtitle-core.js';
import { MaweSettings } from '../state/editor-settings.js';
import { MaweState } from '../state/editor-state.js';
import { MaweViewUpdates } from '../state/editor-view-updates.js';
import { MaweColors } from '../styles/editor-colors.js';
import { MaweSpeakerLabels } from '../styles/editor-speaker-labels.js';
import { MaweAssManagerWiring } from '../styles/editor-wiring-ass-manager.js';
import { MaweContextMenus } from '../ui/editor-context-menus.js';
import { MaweHint } from '../ui/editor-hint.js';
import { MaweColorFilter } from './editor-color-filter.js';
import { MaweCueListAnchor } from './editor-cue-list-anchor.js';
import { commitCuePanelEdit, renderCurrentCuePanel, setCuePanelTarget, renderAll, focusCuePanelText } from './editor-cue-panel.js';
import { MaweSegmentOps } from './editor-segment-ops.js';
import { MaweSelection } from './editor-selection.js';
import { MaweTimeline } from './editor-timeline.js';
import { selectOverlayCueRow, updateSelectionCountText } from './editor-overlay-cue-selection.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';
// 叠加轨查询、迁移和编辑。运行时通过当前页面门面读取工程状态。
// === 轨道查询 ===

function getOverlayTrack() {
  return AsrEditorUtils.getOverlayTrack(MaweBoot.DATA);
}

function overlayTrackVisible() {
  const track = getOverlayTrack();
  return track?.enabled === true && Array.isArray(track.segments) && track.segments.length > 0;
}

// 多重字幕关闭时轨道数据仍保留在工程里，但副字幕不参与 ASS 预览与导出；
// 与 multiSubtitleVisible() 的开合语义保持一致。
function activeExtensionSegments() {
  if (MaweMultiSubtitleCore.getActiveExtensionTrack()?.enabled !== true) return [];
  return MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments || [];
}

// === 表情包分配/预览的目标轨状态 ===
// 原 overlay-actions 的顶层 let；跨模块读写经访问器对象保持原语义。
/** @type {'main' | 'overlay'} */
let stickerTargetTrack = 'main';
/** @type {'main' | 'overlay'} */
let previewTrack = 'main';

/** @type {{stickerTargetTrack: 'main' | 'overlay', previewTrack: 'main' | 'overlay'}} */
export const overlaySticker = Object.freeze({
  get stickerTargetTrack() { return stickerTargetTrack; },
  set stickerTargetTrack(value) { stickerTargetTrack = value; },
  get previewTrack() { return previewTrack; },
  set previewTrack(value) { previewTrack = value; },
});

function stickerSegmentsForTrack(track) {
  return track === 'overlay' ? (getOverlayTrack()?.segments || []) : AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
}

// === 主轨 ↔ 叠加轨 段落迁移 ===
// 两条轨道互不绑定；迁移保持目标轨按 start 升序（同 start 插到既有段之后），
// 返回段在目标轨中的新下标，失败返回 -1。数组操作委托给 editor-utils 纯函数。
function moveSegmentToOverlayTrack(index) {
  const segment = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index];
  const overlay = AsrEditorUtils.ensureOverlayTrack(MaweBoot.DATA);
  if (!segment || !overlay || !Array.isArray(overlay.segments)) return -1;
  MaweAssManagerWiring?.initializeProjectStyles?.();
  const newIndex = AsrEditorUtils.moveSegmentBetweenTracks(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, overlay.segments, index);
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
  if (!segment || !Array.isArray(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments)) return -1;
  const newIndex = AsrEditorUtils.moveSegmentBetweenTracks(overlay.segments, AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, index);
  if (newIndex < 0) return -1;
  overlay._dirty = true;
  segment._dirty = true;
  MaweState.markProjectDirty();
  return newIndex;
}

function shiftMainGroupRefsAfterMove(movedIndexes) {
  // Moving keeps stable group membership and only detaches bilingual relations.
  const movedIds = [...movedIndexes].map((index) => AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index]?.id).filter(Boolean);
  if (movedIds.length) {
    MaweMultiSubtitleCore.removeBindingsForSegmentIds(movedIds, []);
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
  }
}

// 回轨方向：主轨在 insertAt 处插入一段后，其后所有 *_ref.headIdx 需 +1，
// 否则组引用会指到错误的段（保存校验报 "must point to a color head"）。
function shiftMainGroupRefsAfterInsert(_index) {}

function resetOverlayGroupRefs(_index) {}

function detachCuePanelFromTrackEdits() {
  commitCuePanelEdit();
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState();
}

// === 迁移字幕的颜色继承 ===
// 稳定组成员沿用原 ID；以下快照仅为没有稳定组 ID 的旧内存数据兜底。
// 主轨 ↔ 叠加轨互转时颜色标记跟着走：head 保留原色值，ref 物化为自持
// head（start/end 取段自身范围，与 syncTimelineGroupRanges 对无组员 head 的
// 语义一致）。叠加轨的 color_ref 只引用叠加轨自身段，因此迁移后的颜色
// 一律以「单段 head」形式存在，不产生跨轨引用。
function captureCueColorSnapshot(segment) {
  return AsrEditorUtils.getSubtitleGroupValue(MaweBoot.DATA, segment, 'color');
}

function applyCueColorSnapshot(segment, _snapshot) { return Boolean(segment?.color_group_id); }

// 表情包继承：与颜色同理。ref 迁移时需要 head 的完整素材数据（文件名、
// 尺寸等），因此快照按所在轨数组解析并深拷贝；应用时物化为自持 head，
// 时间范围改写为段自身范围，避免跨轨引用。
function captureCueStickerSnapshot(segments, index) {
  return AsrEditorUtils.getSubtitleGroupValue(MaweBoot.DATA, segments[index], 'sticker');
}

function applyCueStickerSnapshot(segment, _snapshot) { return Boolean(segment?.sticker_group_id); }

// 拖动换轨入口专用的面板分离：不走 commitCuePanelEdit——它会把段钳回
// 主轨非重叠区间（previousEnd/nextStart 夹逼），与 Shift+拖动「故意重叠」
// 的换轨意图冲突；文字编辑已在 input 事件实时写入段，这里只清空面板。
function detachCuePanelDuringDrag() {
  MaweCuePanelState.currentCuePanelIdx = -1;
  MaweCuePanelState.currentCuePanelKind = 'main';
  MaweCuePanelState.currentCuePanelTrackId = null;
  MaweCuePanelState.resetCuePanelEditState();
  renderCurrentCuePanel();
}

// 菜单入口：把选中的主轨字幕转为叠加字幕。返回成功迁移的数量。
function convertMainCuesToOverlay(idxs, { label = '转为叠加字幕', pushHistory = true, silent = false } = {}) {
  const targets = [...new Set(Array.isArray(idxs) ? idxs : [])]
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length)
    .sort((a, b) => a - b);
  if (!targets.length) return 0;
  detachCuePanelFromTrackEdits();
  const mutate = (command) => {
    // 迁移前快照颜色与表情包：splitGroupsAtCutPoints 会把切点的
    // color/color_ref/sticker/sticker_ref 清空，迁移后按快照物化回段上。
    const colorSnapshots = new Map(targets.map((index) => [index, {
      segment: AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index],
      color: captureCueColorSnapshot(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index]),
      sticker: captureCueStickerSnapshot(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, index),
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
  if (!Number.isInteger(index) || index < 0 || index >= AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length) return -1;
  const panelWasHere = MaweCuePanelState.currentCuePanelKind === 'main' && MaweCuePanelState.currentCuePanelIdx === index;
  detachCuePanelDuringDrag();
  const segment = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index];
  const colorSnapshot = captureCueColorSnapshot(segment);
  const stickerSnapshot = captureCueStickerSnapshot(AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, index);
  shiftMainGroupRefsAfterMove([index]);
  const newIndex = moveSegmentToOverlayTrack(index);
  if (newIndex < 0) return -1;
  applyCueColorSnapshot(segment, colorSnapshot);
  applyCueStickerSnapshot(segment, stickerSnapshot);
  const { wasSelected, nextAnchor } = MaweState.selection.removeAndShift('main', index);
  MaweSelection.lastClickedIdx = nextAnchor;
  updateSelectionCountText();
  if (panelWasHere) setCuePanelTarget('overlay', newIndex);
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
  if (panelWasHere) setCuePanelTarget('main', newIndex);
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

// === 叠加轨的颜色标记 ===
// 叠加段的颜色组只引用叠加轨自身段；这里按「单段自持 head」分配，
// 不产生跨轨引用，也不走主轨的组拆分逻辑。
function assignOverlayColor(idxs, colorName) {
  if (MaweSpeakerLabels?.assignFromColorShortcut(getOverlayTrack(), idxs, colorName)) return;
  const overlay = getOverlayTrack();
  const def = MaweColors.COLOR_BY_NAME[colorName];
  if (!overlay || !def) return;
  const targets = [...new Set(idxs)].filter((index) => Number.isInteger(index) && overlay.segments[index]);
  if (!targets.length) return;
  return MaweCommands.run('标记颜色', () => {
    targets.forEach((index) => {
      const segment = overlay.segments[index];
      AsrEditorUtils.assignSubtitleGroup(MaweBoot.DATA, overlay.segments, [index], 'color', { name: colorName, value: def.value });
      segment._dirty = true;
    });
    overlay._dirty = true;
    MaweColorFilter.refreshColorAssignmentUi();

    MaweHint.flashHint(targets.length === 1
      ? `已将字幕设为「${def.label}色」`
      : `已将 ${targets.length} 条字幕设为「${def.label}色」`, 'success');
  });
}

// === 主轨颜色组（右键「移出颜色组」的数据面） ===
// 数据结构与表情包同构：head 持完整 color，后续条持 color_ref（仅 name + headIdx）
function colorGroupHeadIndex(idx) {
  const segments = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
  const id = segments[idx]?.color_group_id;
  if (!id) return -1;
  const members = segments.map((cue, index) => cue.color_group_id === id ? index : -1).filter(index => index >= 0);
  return members.length > 1 ? members[0] : -1;
}

function detachColorFromGroup(idx) {
  const segment = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[idx];
  const headIdx = colorGroupHeadIndex(idx);
  const groupColor = headIdx >= 0 ? AsrEditorUtils.getSubtitleGroupValue(MaweBoot.DATA, segment, 'color') : null;
  if (!segment || !groupColor) return false;

  // 显式退出会在该字幕处切开主轨的颜色组；普通删除与换轨仍保留组归属。
  const detachedColor = {
    ...groupColor,
    start: segment.start,
    end: segment.end,
  };
  return MaweCommands.run('移出颜色组', () => {
    const segments = AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
    const groupId = segment.color_group_id;
    const tail = segments.flatMap((cue, index) => index > idx && cue.color_group_id === groupId ? [index] : []);
    const metadata = tail.map(index => segments[index].color_group_metadata);
    if (tail.length) {
      AsrEditorUtils.assignSubtitleGroup(MaweBoot.DATA, segments, tail, 'color', detachedColor);
      tail.forEach((index, offset) => {
        if (metadata[offset] !== undefined) segments[index].color_group_metadata = metadata[offset];
      });
    }
    MaweSegmentOps.splitGroupsAtCutPoints(new Set([idx]), 'color', 'color_ref');
    AsrEditorUtils.assignSubtitleGroup(MaweBoot.DATA, segments, [idx], 'color', detachedColor);
    MaweColorFilter.refreshColorAssignmentUi();
    MaweHint.flashHint('已移出颜色组', 'success');
    return true;
  });
}

function clearOverlayColorOnTargets(idxs) {
  if (MaweSpeakerLabels?.assignFromColorShortcut(getOverlayTrack(), idxs, null)) return;
  const overlay = getOverlayTrack();
  if (!overlay) return;
  const targets = [...new Set(idxs)].filter((index) => Number.isInteger(index) && overlay.segments[index]);
  if (!targets.length) return;
  return MaweCommands.run('清除颜色', () => {
    targets.forEach((index) => {
      const segment = overlay.segments[index];
      if (!segment) return;
      AsrEditorUtils.clearSubtitleGroupMembers(MaweBoot.DATA, overlay.segments, [index], 'color');
      segment._dirty = true;
    });
    overlay._dirty = true;
    MaweColorFilter.refreshColorAssignmentUi();

    MaweHint.flashHint('已清除颜色', 'success');
  });
}

function clearOverlaySticker(index) {
  const overlay = getOverlayTrack();
  const segment = overlay?.segments?.[index];
  if (!segment || !segment.sticker_group_id) return;
  AsrEditorUtils.clearSubtitleGroupMembers(MaweBoot.DATA, overlay.segments, [index], 'sticker');
  segment._dirty = true;
  overlay._dirty = true;
  MaweState.markProjectDirty();
  renderAll({ waveform: 'full' });
  MaweViewUpdates.invalidate({ save: true });
  MaweHint.flashHint('已删除', 'success');
}

// === 叠加轨合并 ===

// C 键批量合并：复用 Ctrl/Cmd+Shift+A / D 的 mergeOverlaySegments，共享
// 「下标连续」校验与颜色/表情包组继承语义。旧实现只延长首段自带的标记、
// 且仅按时间连续校验：混合组会丢标记，跳过中间段的合并会留下被新段覆盖
// 的旧段，保存后违反相邻段 end <= next.start 的契约导致工程无法再打开。
function mergeOverlayCues(idxs) {
  if (!mergeOverlaySegments(idxs, { detachPanel: true })) return;
  MaweViewUpdates.invalidate({ save: true });
}

// 只合并叠加轨连续字幕。颜色同组继承、跨组同色新建组；表情包仅同组继承。
function mergeOverlaySegments(idxs, { detachPanel = false } = {}) {
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
  if (!AsrEditorUtils.canMergeSpeakerSegments(segments)) {
    MaweHint.flashHint('不同说话人的字幕不能合并，请先统一归属', 'invalid');
    return false;
  }
  if (detachPanel) detachCuePanelFromTrackEdits();
  const sourceEl = MaweCoreState.container.querySelector(`.overlay-track-cue[data-overlay-idx="${sorted[0]}"]`);
  const cueListAnchor = MaweCueListAnchor.captureVisibleCueListVisualAnchor(sourceEl);
  const stickerGroup = AsrEditorUtils.resolveMergedGroupInheritance(
    track.segments, sorted, 'sticker', 'sticker_ref',
  );
  // 颜色按规范组值判断；跨组同色在命令事务内创建独立组。
  const colorGroup = AsrEditorUtils.resolveMergedColorInheritance(track.segments, sorted, MaweBoot.DATA);
  // 组未被整组继承时按切点拆组（合并前下标），避免 head 被并走后留下悬空引用；
  // 拆组是对 track.segments 的变更，必须放在 MaweCommands.run 内保证可撤销。
  const mergeSet = new Set(sorted);
  const overlayJoin = AsrEditorUtils.joinSegmentTextsMassFold(
    segments,
    MaweMultiSubtitleCore.mergeJoinSeparatorForMode(MaweMultiSubtitleCore.getMainSubtitleSplitMode({ text: segments.map((s) => s.text || '').join('\n') })),
    MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule,
  );
  const merged = {
    ...AsrEditorUtils.cloneJsonValue(segments[0]),
    color_group_id: colorGroup.groupId || undefined,
    sticker_group_id: segments.every(s => s.sticker_group_id === segments[0].sticker_group_id) ? segments[0].sticker_group_id : undefined,
    id: segments[0].id,
    start: segments[0].start,
    end: segments[segments.length - 1].end,
    text: overlayJoin.text,
    items: overlayJoin.items,
    disabled: !!segments[0].disabled,
    _dirty: true,
  };
  if (!merged.color_group_id) delete merged.color_group_id;
  if (!merged.sticker_group_id) delete merged.sticker_group_id;
  if (!colorGroup.groupInherited) delete merged.color_group_metadata;
  // 说话人身份独立于颜色；只有来源段的身份全部一致且非 null/undefined 时才继承。
  const speaker = segments[0].speaker;
  if (speaker == null || segments.some(segment => segment.speaker !== speaker)) delete merged.speaker;
  // 逐句缩放/定位与主字幕合并同规则：取最左句的完整覆盖（独立副本）。
  if (segments[0].assOverride) {
    merged.assOverride = AsrEditorUtils.normalizeAssOverride(segments[0].assOverride);
  }
  if (segments[0].assStyle) merged.assStyle = JSON.parse(JSON.stringify(segments[0].assStyle));
  if (Array.isArray(merged.items) && merged.items.length === 0) merged.items = null;
  MaweSelection.clearSelection();
  return MaweCommands.run('合并叠加字幕', (command) => {
    if (!stickerGroup.groupId) {
      MaweSegmentOps.splitGroupsAtCutPoints(mergeSet, 'sticker', 'sticker_ref', track.segments);
    }
    if (!colorGroup.groupInherited) {
      MaweSegmentOps.splitGroupsAtCutPoints(mergeSet, 'color', 'color_ref', track.segments);
    }
    track.segments.splice(sorted[0], sorted.length, merged);
    if (colorGroup.value) {
      AsrEditorUtils.assignSubtitleGroup(MaweBoot.DATA, track.segments, [sorted[0]], 'color', colorGroup.value);
    }
    track._dirty = true;
    command.commit({ cueList: true });
    MaweState.selection.clear('overlay');
    MaweState.selection.add('overlay', sorted[0]);
    MaweState.selection.overlayAnchor = sorted[0];
    setCuePanelTarget('overlay', sorted[0]);
    MaweViewUpdates.invalidate({ preview: 'update' });
    const el = MaweCoreState.container.querySelector(`.overlay-track-cue[data-overlay-idx="${sorted[0]}"]`);
    if (cueListAnchor) MaweCueListAnchor.restoreCueListVisualAnchor(el, cueListAnchor);
    MaweHint.flashHint(`已合并 ${sorted.length} 条叠加字幕`, 'success');
    return true;
  });
}

// === 从波形空白处新增叠加字幕 ===

// 叠加轨创建入口：与主轨不同，允许与主字幕时间重叠（这正是叠加轨的用途）；
// 只要求不与叠加轨自身已有段重叠，范围夹进相邻叠加段之间。
function addOverlayRangeFromWaveform(requestedStart, requestedEnd, clickX, clickY) {
  let overlay = getOverlayTrack() || { segments: [] };
  if (!Array.isArray(overlay.segments)) {
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
  commitCuePanelEdit();
  return MaweCommands.run('新增叠加字幕', (command) => {
    overlay = AsrEditorUtils.ensureOverlayTrack(MaweBoot.DATA);
    MaweAssManagerWiring?.initializeProjectStyles?.();
    overlay.segments.splice(index, 0, {
      id: AsrEditorUtils.uniqueStableSegmentId(
        AsrEditorUtils.subtitleGroupTracks(MaweBoot.DATA).flatMap(t => t.segments), `overlay-${index + 1}`, 'overlay'),
      start: safeStart,
      end: safeEnd,
      text: '',
      items: [],
      _dirty: true,
    });
    // 叠加轨组引用是数组下标：插入点及其后的 head 右移一位。
    AsrEditorUtils.shiftGroupReferenceIndices(overlay.segments, index, 1);
    overlay._dirty = true;
    MaweSelection.clearSelection({ silent: true });
    command.commit({ cueList: true, preserveCueListScroll: false });
    selectOverlayCueRow(index);
    // 与主/副字幕一致：新建后在字幕块上方弹出快速编辑气泡直接输入；
    // 气泡打不开时回退聚焦下方字幕面板文本框。
    if (MaweCoreState.waveformEditor?.openCueQuickEditAtIndex) {
      MaweCoreState.waveformEditor.openCueQuickEditAtIndex(
        'overlay', index, () => focusCuePanelText(index, 'overlay'));
    } else {
      focusCuePanelText(index, 'overlay');
    }
    MaweCoreState.waveformEditor?.revealTime(safeStart, true);

    MaweHint.flashHint(`已新增第 ${index + 1} 条叠加字幕`, 'success');
  });
}

// 右键菜单 / 后续菜单入口：在指针时间点创建一条默认时长的叠加字幕，
// 范围夹进叠加轨相邻段之间（主轨是否占用不参与判断）。
function addOverlayAtWaveformTime(timeMs, clickX, clickY) {
  let overlay = getOverlayTrack() || { segments: [] };
  if (!Array.isArray(overlay.segments)) {
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

// 公共 API：消费方静态 import 本对象以外的具名导出；这里集中 re-export
// （e2e 数据层直调入口）。
export {
  getOverlayTrack,
  overlayTrackVisible,
  activeExtensionSegments,
  stickerSegmentsForTrack,
  moveSegmentToOverlayTrack,
  moveOverlaySegmentToMainTrack,
  shiftMainGroupRefsAfterMove,
  shiftMainGroupRefsAfterInsert,
  resetOverlayGroupRefs,
  detachCuePanelFromTrackEdits,
  convertMainCuesToOverlay,
  convertMainCueToOverlayForDrag,
  convertOverlayCueToMainForDrag,
  convertOverlayCueToMain,
  deleteOverlayCues,
  assignOverlayColor,
  colorGroupHeadIndex,
  detachColorFromGroup,
  clearOverlayColorOnTargets,
  clearOverlaySticker,
  mergeOverlayCues,
  mergeOverlaySegments,
  addOverlayRangeFromWaveform,
  addOverlayAtWaveformTime,
};

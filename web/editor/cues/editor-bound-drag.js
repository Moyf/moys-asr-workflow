import { remapPanelItems } from './editor-cue-panel.js';

// 绑定拖拽：主副字幕联动调整的范围解析与快照恢复。
// ESM init 模块：initMaweBoundDrag 在原清单位次执行原 IIFE 体（挂
// window.MaweBoundDrag 冻结门面——classic 侧出接口）；底部具名导出经门面
// 在调用时转发，兄弟模块可静态 import。
export function initMaweBoundDrag() {
(function initMaweBoundDrag(global) {
  'use strict';



  function getBoundDragTarget(index, sourceSegments) {
    const source = sourceSegments[index];
    if (!source) return null;
    const binding = MaweMultiSubtitleCore.bindingForMainIndex(index);
    if (!binding) return null;
    const target = MaweMultiSubtitleCore.extensionSegmentById(binding.extension_segment_ids?.[0], MaweMultiSubtitleCore.getExtensionTrack(binding.track_id));
    return target ? { target, binding } : null;
  }



  function ensureBoundDragOriginal(drag, index, target) {
    if (!drag.boundOriginals) drag.boundOriginals = new Map();
    if (!drag.boundOriginals.has(index)) {
      drag.boundOriginals.set(index, {
        target,
        start: target.start,
        end: target.end,
        start_frame: target.start_frame,
        end_frame: target.end_frame,
        items: Array.isArray(target.items)
          ? target.items.map((item) => ({ ...item })) : target.items,
      });
    }
    return drag.boundOriginals.get(index);
  }



  function snapshotBoundDragTrack(track) {
    return {
      track,
      segments: (track?.segments || []).map((segment) => ({
        segment,
        start: segment.start,
        end: segment.end,
        start_frame: segment.start_frame,
        end_frame: segment.end_frame,
        items: Array.isArray(segment.items)
          ? segment.items.map((item) => ({ ...item })) : segment.items,
      })),
      dirty: track?._dirty,
      selection: MaweMultiSubtitleCore.extensionTrackSelectionSnapshot(track),
    };
  }



  // Alt 主字幕拖动中的副字幕挤压是临时预览：同一次拖动把主字幕拉回去时，
  // 副字幕轨也必须从拖动开始时的完整快照恢复，而不能只恢复当前绑定的跟随字幕。
  function ensureBoundDragTimelineOriginals(drag) {
    if (drag?.track !== 'main' || drag.boundDragTimelineOriginals) return;
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    drag.boundDragTimelineOriginals = {
      tracks: (multi.tracks || []).map((track) => snapshotBoundDragTrack(track)),
      bindings: JSON.parse(JSON.stringify(multi.bindings || [])),
    };
  }



  function restoreBoundDragTimelineOriginals(drag) {
    const snapshot = drag?.boundDragTimelineOriginals;
    if (!snapshot) return;
    snapshot.tracks.forEach(({ track, segments, dirty, selection }) => {
      if (!track) return;
      track.segments = segments.map((entry) => {
        entry.segment.start = entry.start;
        entry.segment.end = entry.end;
        if (entry.start_frame === undefined) delete entry.segment.start_frame;
        else entry.segment.start_frame = entry.start_frame;
        if (entry.end_frame === undefined) delete entry.segment.end_frame;
        else entry.segment.end_frame = entry.end_frame;
        entry.segment.items = Array.isArray(entry.items)
          ? entry.items.map((item) => ({ ...item })) : entry.items;
        return entry.segment;
      });
      track._dirty = track._dirty || dirty;
      if (drag.selectedMoveSegments) MaweMultiSubtitleCore.restoreExtensionTrackSelection(track, selection);
    });
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    multi.bindings = JSON.parse(JSON.stringify(snapshot.bindings));
    MaweMultiSubtitleCore.syncBindingOffsets();
  }



  function getBoundDragEdge(drag, index) {
    if (drag.kind === 'move') return { mode: 'move', edge: null };
    if (drag.kind === 'resize-left') return { mode: 'edge', edge: 'start' };
    if (drag.kind === 'resize-right') return { mode: 'edge', edge: 'end' };
    if (drag.kind === 'resize-boundary') {
      return { mode: 'edge', edge: index === drag.index ? 'end' : 'start' };
    }
    if (drag.kind === 'resize-boundary-independent') {
      return { mode: 'edge', edge: drag.edge };
    }
    return null;
  }



  function syncBoundCueDrag(drag) {
    // 副字幕拖动只调整副字幕自身；绑定关系保留，但新的时间范围通过
    // binding offset 记录，不再反向改动主字幕或被主字幕轨道边界限制。
    // 主字幕即使因为“自动吸附调整相邻字幕”关闭而走
    // resize-boundary-independent，也仍需带着绑定副字幕一起调整。
    if (!drag || drag.track !== 'main' || !MaweMultiSubtitleCore.multiSubtitleVisible()) return;
    if (!drag.selectedMoveSegments) prepareBoundCueDrag(drag);
    const sourceSegments = MaweBoot.DATA.segments;
    if (!drag.boundOriginals) drag.boundOriginals = new Map();

    const boundEntries = drag.indices.map((index) => ({
      index,
      bound: getBoundDragTarget(index, sourceSegments),
      sourceOriginal: drag.originals.get(index),
    })).filter((entry) => entry.bound && entry.sourceOriginal
      && !drag.selectedMoveSegments?.has(entry.bound.target));
    const movedFollowerSegments = new Set([
      ...boundEntries.map((entry) => entry.bound.target),
      ...(drag.selectedMoveSegments || []),
    ]);
    boundEntries.forEach(({ index, bound, sourceOriginal }) => {
      const { target, binding } = bound;
      const targetOriginal = ensureBoundDragOriginal(drag, index, target);
      const source = sourceSegments[index];
      const sourceOriginalStart = Number(sourceOriginal.startMs ?? sourceOriginal.start);
      const sourceOriginalEnd = Number(sourceOriginal.endMs ?? sourceOriginal.end);
      let nextStart = targetOriginal.start;
      let nextEnd = targetOriginal.end;
      if (drag.kind === 'move') {
        const delta = source.start - sourceOriginalStart;
        nextStart = targetOriginal.start + delta;
        nextEnd = targetOriginal.end + delta;
      } else if (drag.kind === 'resize-left') {
        nextStart = targetOriginal.start + (source.start - sourceOriginalStart);
      } else if (drag.kind === 'resize-right') {
        nextEnd = targetOriginal.end + (source.end - sourceOriginalEnd);
      } else if (drag.kind === 'resize-boundary') {
        if (index === drag.index) nextEnd = targetOriginal.end + (source.end - sourceOriginalEnd);
        else nextStart = targetOriginal.start + (source.start - sourceOriginalStart);
      } else if (drag.kind === 'resize-boundary-independent') {
        if (drag.edge === 'start') nextStart = targetOriginal.start + (source.start - sourceOriginalStart);
        else nextEnd = targetOriginal.end + (source.end - sourceOriginalEnd);
      }
      if (nextEnd <= nextStart) nextEnd = nextStart + MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS;

      const targetTrack = MaweMultiSubtitleCore.getExtensionTrack(binding.track_id);
      const dragEdge = getBoundDragEdge(drag, index);
      const resolved = MaweMultiSubtitleCore.resolveExtensionFollowerRange(
        target,
        nextStart,
        nextEnd,
        dragEdge?.mode === 'edge' ? dragEdge.edge : dragEdge?.mode,
        targetTrack,
        movedFollowerSegments,
        { sortSegments: false },
      );
      if (resolved.squeezedCount > 0 || resolved.removedCount > 0) {
        const details = [];
        if (resolved.squeezedCount) details.push(`挤压 ${resolved.squeezedCount} 条副字幕`);
        if (resolved.removedCount) details.push(`删除 ${resolved.removedCount} 条副字幕`);
        MaweMultiSubtitleCore.notifyBoundSyncWarning(
          drag,
          `副字幕发生冲突，已${details.join('，')}${resolved.unboundCount ? '并解除绑定' : ''}`,
        );
      }
      target.start = resolved.start;
      target.end = resolved.end;
      target.items = remapPanelItems(
        targetOriginal.items,
        targetOriginal.start,
        targetOriginal.end,
        target.start,
        target.end,
      );
      target._dirty = true;
    });
    // 绑定拖动在命令提交前逐帧写入；事件让指示器与拖动预览同步变脏。
    MaweState.markProjectDirty();
    MaweMultiSubtitleCore.syncBindingOffsets();
  }

  function prepareBoundCueDrag(drag) {
    if (drag?.track !== 'main' || !MaweMultiSubtitleCore.multiSubtitleVisible()) return;
    // 显式选中的副字幕由组合拖动自身更新；没有隐式跟随字幕时，
    // 无需每帧恢复整个副轨。已有预览快照仍须恢复，保证反向拖回可逆。
    if (drag.selectedMoveSegments && !drag.boundDragTimelineOriginals
        && !drag.indices.some((index) => {
          const bound = getBoundDragTarget(index, MaweBoot.DATA.segments);
          return bound && !drag.selectedMoveSegments.has(bound.target);
        })) return;
    ensureBoundDragTimelineOriginals(drag);
    if (drag.allowSqueeze || drag.selectedMoveSegments) restoreBoundDragTimelineOriginals(drag);
    // 多轨预览会先写入选中副字幕及被挤压邻居；提前保存未选中的绑定
    // 跟随字幕，避免在同步绑定时把已经调整过的时间当成拖动起点。
    if (drag.selectedMoveSegments) {
      drag.indices.forEach((index) => {
        const bound = getBoundDragTarget(index, MaweBoot.DATA.segments);
        if (bound && !drag.selectedMoveSegments.has(bound.target)) ensureBoundDragOriginal(drag, index, bound.target);
      });
    }
  }

  global.MaweBoundDrag = Object.freeze({
    getBoundDragTarget,
    ensureBoundDragOriginal,
    snapshotBoundDragTrack,
    ensureBoundDragTimelineOriginals,
    restoreBoundDragTimelineOriginals,
    getBoundDragEdge,
    syncBoundCueDrag,
    prepareBoundCueDrag
  });
})(typeof window !== 'undefined' ? window : globalThis);
}

export function getBoundDragTarget(...args) { return window.MaweBoundDrag.getBoundDragTarget(...args); }
export function ensureBoundDragOriginal(...args) { return window.MaweBoundDrag.ensureBoundDragOriginal(...args); }
export function snapshotBoundDragTrack(...args) { return window.MaweBoundDrag.snapshotBoundDragTrack(...args); }
export function ensureBoundDragTimelineOriginals(...args) { return window.MaweBoundDrag.ensureBoundDragTimelineOriginals(...args); }
export function restoreBoundDragTimelineOriginals(...args) { return window.MaweBoundDrag.restoreBoundDragTimelineOriginals(...args); }
export function getBoundDragEdge(...args) { return window.MaweBoundDrag.getBoundDragEdge(...args); }
export function syncBoundCueDrag(...args) { return window.MaweBoundDrag.syncBoundCueDrag(...args); }
export function prepareBoundCueDrag(...args) { return window.MaweBoundDrag.prepareBoundCueDrag(...args); }

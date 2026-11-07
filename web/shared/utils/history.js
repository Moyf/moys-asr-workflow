// history: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';
  const { cloneJsonValue } = dependencies;


  const HISTORY_RECORD_DEFAULT_LABELS = Object.freeze({
    segments: '编辑', layout: '调整工作区', gap_remove: '空隙移除', preview: '预览', markers: '标记',
  });

  function buildSegmentsHistorySnapshot(project) {
    return cloneJsonValue({ tracks: project.tracks, bindings: project.bindings,
      bilingual: project.bilingual, subtitle_groups: project.subtitle_groups,
      ...Object.fromEntries(['speakers', 'annotation_mode', 'palette_size', 'speaker_shortcuts']
        .filter(field => Object.hasOwn(project, field)).map(field => [field, project[field]])) });
  }

  function restoreSegmentsHistorySnapshot(project, snapshot) {
    const restored = cloneJsonValue(snapshot);
    const existing = new Map(project.tracks.map(track => [track.id, track]));
    const tracks = restored.tracks.map(value => {
      const track = existing.get(value.id);
      if (!track) return value;
      const segments = track.segments;
      for (const key of Object.keys(track)) delete track[key];
      Object.assign(track, value);
      segments.splice(0, segments.length, ...value.segments);
      track.segments = segments;
      return track;
    });
    project.tracks.splice(0, project.tracks.length, ...tracks);
    for (const field of ['bindings', 'bilingual', 'subtitle_groups']) project[field] = restored[field];
    for (const field of ['speakers', 'annotation_mode', 'palette_size', 'speaker_shortcuts']) {
      if (Object.hasOwn(restored, field)) project[field] = restored[field];
      else delete project[field];
    }
    return project;
  }

  // options.clone = false 时直接附加调用方传入的 payload：
  // 供编辑器 captureSegmentsRecord 使用（其快照已是深克隆），避免长工程
  // 在一次记录里做两遍 O(工程体积) 的 JSON 序列化。
  function buildHistoryRecord(kind, label, payload, view = null, { clone = true } = {}) {
    const recordKind = Object.prototype.hasOwnProperty.call(HISTORY_RECORD_DEFAULT_LABELS, kind)
      ? kind : 'segments';
    const record = { kind: recordKind, label: label || HISTORY_RECORD_DEFAULT_LABELS[recordKind] };
    if (recordKind === 'segments') {
      record.segs = clone ? cloneJsonValue(payload) : payload;
      if (view) record.view = cloneJsonValue(view);
    } else if (recordKind === 'layout') record.layout = payload || null;
    else if (recordKind === 'gap_remove') {
      record.gapRemove = cloneJsonValue(payload?.gapRemove ?? null);
      record.gapRemoveDirty = payload?.gapRemoveDirty === true;
    } else if (recordKind === 'markers') {
      record.markers = cloneJsonValue(Array.isArray(payload) ? payload : []);
    } else record.preview = cloneJsonValue(payload);
    return record;
  }


  // 统一撤销/重做栈：管理两个不透明记录数组。
  // - push(record)：压入 undo 栈，清空 redo 栈，按 limit 裁剪。
  // - popUndo(currentSnapshot)：从 undo 弹出一条记录，把当前快照压入 redo，
  //   返回被弹出的记录供调用方应用。空栈返回 null。
  // - popRedo(currentSnapshot)：对称地从 redo 弹出，把当前快照压入 undo。
  // 调用方负责按记录的 kind 生成 currentSnapshot 与应用记录。
  function createHistoryStack(limit = 100) {
    const max = Math.max(1, Math.round(Number(limit) || 100));
    const undo = [];
    const redo = [];
    const trim = () => { while (undo.length > max) undo.shift(); };
    return {
      undoLength: () => undo.length,
      redoLength: () => redo.length,
      canUndo: () => undo.length > 0,
      canRedo: () => redo.length > 0,
      peekUndo: () => undo[undo.length - 1] || null,
      peekRedo: () => redo[redo.length - 1] || null,
      push: (record) => {
        undo.push(record);
        trim();
        redo.length = 0;
      },
      popUndo: (currentSnapshot) => {
        if (!undo.length) return null;
        const record = undo.pop();
        redo.push(currentSnapshot);
        return record;
      },
      popRedo: (currentSnapshot) => {
        if (!redo.length) return null;
        const record = redo.pop();
        undo.push(currentSnapshot);
        trim();
        return record;
      },
      clear: () => { undo.length = 0; redo.length = 0; },
      clearRedo: () => { redo.length = 0; },
    };
  }

  return Object.freeze({ buildHistoryRecord, buildSegmentsHistorySnapshot, restoreSegmentsHistorySnapshot, createHistoryStack });
}

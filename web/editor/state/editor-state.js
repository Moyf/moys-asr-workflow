// 工程身份、选择集、偏好与瞬态运行态的唯一持有者。
// project 是原始模板对象，不存在第二份字幕源。
// ESM 模块：createEditorState 为纯工厂具名导出（测试直调、按项目实例化），
// initMaweState 在原清单位次以 window.MaweBoot.DATA 组装单例并挂
// window.MaweState（register/resolve 注册表随之退役）。
export function createEditorState(project) {
  'use strict';

  const sets = { main: new Set(), extension: new Set(), overlay: new Set() };
  const anchors = { main: -1, extension: -1, overlay: -1 };
  const views = Object.fromEntries(Object.entries(sets).map(([kind, set]) => [kind, Object.freeze({
    get size() { return set.size; },
    has: index => set.has(index),
    values: () => set.values(),
    keys: () => set.keys(),
    entries: () => set.entries(),
    forEach(callback, receiver) {
      set.forEach(index => callback.call(receiver, index, index, views[kind]));
    },
    [Symbol.iterator]: () => set.values(),
  })]));
  function trackSet(kind) {
    if (!Object.hasOwn(sets, kind)) throw new TypeError('Unknown selection track: ' + kind);
    return sets[kind];
  }
  const selection = Object.freeze({
    get mainAnchor() { return anchors.main; },
    set mainAnchor(index) { anchors.main = index; },
    get extensionAnchor() { return anchors.extension; },
    set extensionAnchor(index) { anchors.extension = index; },
    get overlayAnchor() { return anchors.overlay; },
    set overlayAnchor(index) { anchors.overlay = index; },
    indices(kind) { trackSet(kind); return views[kind]; },
    add(kind, index) {
      const set = trackSet(kind);
      if (Number.isInteger(index) && index >= 0) set.add(index);
    },
    remove: (kind, index) => trackSet(kind).delete(index),
    clear: kind => trackSet(kind).clear(),
    replace(kind, indices) {
      const set = trackSet(kind);
      const next = [...indices].filter(index => Number.isInteger(index) && index >= 0);
      set.clear();
      next.forEach(index => set.add(index));
    },
    removeAndShift(kind, removedIndex) {
      const set = trackSet(kind);
      const anchor = anchors[kind];
      if (!Number.isInteger(removedIndex) || removedIndex < 0) return { wasSelected: false, nextAnchor: anchor };
      const wasSelected = set.has(removedIndex);
      const next = [...set].filter(index => index !== removedIndex)
        .map(index => index > removedIndex ? index - 1 : index);
      set.clear();
      next.forEach(index => set.add(index));
      anchors[kind] = anchor === removedIndex ? -1 : anchor > removedIndex ? anchor - 1 : anchor;
      return { wasSelected, nextAnchor: anchors[kind] };
    },
    anchor(kind) { trackSet(kind); return anchors[kind]; },
    setAnchor(kind, index) {
      trackSet(kind);
      anchors[kind] = Number.isInteger(index) && index >= 0 ? index : -1;
    },
    reset() {
      for (const kind of Object.keys(sets)) { sets[kind].clear(); anchors[kind] = -1; }
    },
  });

  const preferences = Object.seal({ editor: {} });
  const runtime = Object.seal({
    player: null, waveformEditor: null, playbackFrameId: 0, playbackFramePlayer: null,
    waveformLoadedFromProject: false,
  });
  const panel = Object.seal({
    gapPreviewRange: null, gapRemovePanelDrag: null,
    currentCuePanelIdx: -1, currentCuePanelKind: 'main', currentCuePanelTrackId: null,
    cuePanelUndoPushed: false, cuePanelUndoRecord: null,
    cuePanelTextEditSnapshot: null, cuePanelCanceling: false,
  });
  const editing = Object.seal({ editingState: null, extensionEditingState: null });

  // 工程脏态事件层：散落的脏标记写入收口为 markProjectDirty()，以递增的
  // projectDirtyEpoch 通知订阅者。消费者（未保存指示器）经 onProjectDirtyChange
  // 即时刷新；轮询兜底只允许比较 epoch（O(1)），指纹等 O(N) 判定只能出现在
  // 本事件路径驱动的回调里。
  let projectDirtyEpoch = 0;
  const projectDirtyListeners = new Set();
  function markProjectDirty() {
    projectDirtyEpoch += 1;
    for (const listener of [...projectDirtyListeners]) {
      try { listener(projectDirtyEpoch); } catch (error) { window.console?.error?.('editor-state: project dirty listener failed', error); }
    }
  }
  function getProjectDirtyEpoch() { return projectDirtyEpoch; }
  function onProjectDirtyChange(listener) {
    if (typeof listener !== 'function') return () => {};
    if (projectDirtyListeners.has(listener)) return () => projectDirtyListeners.delete(listener);
    projectDirtyListeners.add(listener);
    return () => projectDirtyListeners.delete(listener);
  }

  // changes 脏标志保持保存簿记语义不变，仅包装为访问器：写入 true 时触发
  // markProjectDirty()（写入 false 不触发）。命令发布（projectImportDirty）、
  // 外观/标记等代理 setter、撤销恢复的 Object.assign 因此都汇入同一事件。
  const changesFlags = { projectImportDirty: false, gapRemoveDirty: false, previewGeometryDirty: false, markersDirty: false,
    timedTextEditViewDirty: false, audioProcessingDirty: false };
  // 显式访问器（defineProperties 的动态键 TS 推断不出）：写入 true 触发 markProjectDirty()。
  const changes = {
    get audioProcessingDirty() { return changesFlags.audioProcessingDirty; },
    set audioProcessingDirty(value) { changesFlags.audioProcessingDirty = Boolean(value); if (changesFlags.audioProcessingDirty) markProjectDirty(); },
    get projectImportDirty() { return changesFlags.projectImportDirty; },
    set projectImportDirty(value) { changesFlags.projectImportDirty = Boolean(value); if (changesFlags.projectImportDirty) markProjectDirty(); },
    get gapRemoveDirty() { return changesFlags.gapRemoveDirty; },
    set gapRemoveDirty(value) { changesFlags.gapRemoveDirty = Boolean(value); if (changesFlags.gapRemoveDirty) markProjectDirty(); },
    get previewGeometryDirty() { return changesFlags.previewGeometryDirty; },
    set previewGeometryDirty(value) { changesFlags.previewGeometryDirty = Boolean(value); if (changesFlags.previewGeometryDirty) markProjectDirty(); },
    get markersDirty() { return changesFlags.markersDirty; },
    set markersDirty(value) { changesFlags.markersDirty = Boolean(value); if (changesFlags.markersDirty) markProjectDirty(); },
    get timedTextEditViewDirty() { return changesFlags.timedTextEditViewDirty; },
    set timedTextEditViewDirty(value) { changesFlags.timedTextEditViewDirty = Boolean(value); if (changesFlags.timedTextEditViewDirty) markProjectDirty(); },
  };
  Object.freeze(changes);

  // Compare only subtitle truth, never DOM, playback or rebuildable waveform caches.
  function segmentsFingerprint() {
    return JSON.stringify({ segments: project.segments, multi_subtitle: project.multi_subtitle,
      overlay_track: project.overlay_track }, (key, value) => key === '_dirty' ? undefined : value);
  }
  let savedSegments = null;
  function noteSavedSegments(fingerprint = segmentsFingerprint()) { savedSegments = fingerprint; }
  function clearSubtitleDirtyFlags() {
    (project.segments || []).forEach(segment => { delete segment._dirty; });
    for (const track of [project.multi_subtitle, project.overlay_track, ...(project.multi_subtitle?.tracks || [])]) {
      if (!track) continue;
      delete track._dirty;
      (track.segments || []).forEach(segment => { delete segment._dirty; });
    }
  }
  function markSaved() {
    clearSubtitleDirtyFlags();
    for (const key of Object.keys(changes)) changes[key] = false;
  }
  function reconcileSegmentsDirty() {
    if (savedSegments === null) return;
    changes.projectImportDirty = segmentsFingerprint() !== savedSegments;
    if (!changes.projectImportDirty) clearSubtitleDirtyFlags();
  }

  function hasProjectChanges(pendingText = false) {
    const dirty = track => Boolean(track?._dirty) || (track?.segments || []).some(segment => segment._dirty);
    return Boolean(pendingText || changes.projectImportDirty || changes.gapRemoveDirty || changes.previewGeometryDirty
      || changes.markersDirty || changes.timedTextEditViewDirty || changes.audioProcessingDirty
      || (project.segments || []).some(segment => segment._dirty)
      || dirty(project.overlay_track) || dirty(project.multi_subtitle)
      || (project.multi_subtitle?.tracks || []).some(dirty));
  }

  let projectLoadGeneration = 0;
  let projectLoadPending = false;
  const projectLoadObservers = new Set();
  function observeProjectLoad(callback) {
    projectLoadObservers.add(callback);
    return () => projectLoadObservers.delete(callback);
  }
  function beginProjectLoad() {
    projectLoadPending = true;
    projectLoadGeneration += 1;
    for (const callback of [...projectLoadObservers]) callback();
    return projectLoadGeneration;
  }
  function finishProjectLoad(generation) {
    if (generation === projectLoadGeneration) projectLoadPending = false;
  }
  function waitForProjectLoad(promise, generation) {
    return new Promise((resolve, reject) => {
      const unobserve = observeProjectLoad(() => { unobserve(); resolve(null); });
      Promise.resolve(promise).then(resolve, reject).finally(unobserve);
      if (generation !== projectLoadGeneration) { unobserve(); resolve(null); }
    });
  }

  return Object.freeze({ project, selection, preferences, runtime, panel, editing, changes, hasProjectChanges,
    beginProjectLoad, finishProjectLoad, observeProjectLoad, waitForProjectLoad,
    get projectLoadGeneration() { return projectLoadGeneration; },
    get projectLoadPending() { return projectLoadPending; },
    segmentsFingerprint, noteSavedSegments, markSaved, reconcileSegmentsDirty,
    markProjectDirty, getProjectDirtyEpoch, onProjectDirtyChange });
}

export function initMaweState() {
  'use strict';
  // 注册表 resolve 时代的返回值即 any；与原装配语义一致，经局部
  // 中转赋窗口单例，类型断言由 editor-globals.d.ts 的接口描述承担。
  const state = /** @type {any} */ (createEditorState(window.MaweBoot.DATA));
  window.MaweState = state;
}

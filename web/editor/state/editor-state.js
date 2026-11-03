// 工程身份、选择集、偏好与瞬态运行态的唯一持有者。
// project 是原始模板对象，不存在第二份字幕源。
// ESM 模块：createEditorState 为纯工厂具名导出（测试直调、按项目实例化），
// initMaweState 在原清单位次以 window.MaweBoot.DATA 组装单例并挂
// window.MaweState（register/resolve 注册表随之退役）。
export function createEditorState(project) {
  'use strict';

  // Cue references are the selection source of truth. Legacy index views are
  // resolved against the current project each time, including after a splice.
  const refs = new Map();
  const anchors = { main: null, extension: null, overlay: null };
  let currentRef = null;
  const key = ref => JSON.stringify([ref.track_id, ref.segment_id]);
  const copy = ref => ref ? { track_id: ref.track_id, segment_id: ref.segment_id } : null;
  function trackForKind(kind) {
    const role = { main: 'main', extension: 'secondary', overlay: 'overlay' }[kind];
    if (!role) throw new TypeError('Unknown selection track: ' + kind);
    const tracks = project.tracks || [];
    return (role === 'secondary' && tracks.find(track => track.role === role && track.id === project.bilingual?.active_track_id))
      || tracks.find(track => track.role === role) || null;
  }
  function findTrack(id) { return (project.tracks || []).find(track => track.id === id) || null; }
  function resolve(ref) {
    const track = ref && findTrack(ref.track_id);
    const index = track?.segments?.findIndex(segment => segment?.id === ref.segment_id) ?? -1;
    return index < 0 ? null : { track, index };
  }
  function refAt(kind, index) {
    const track = trackForKind(kind);
    const segment = Number.isInteger(index) && index >= 0 ? track?.segments?.[index] : null;
    return track?.id != null && segment?.id != null ? { track_id: track.id, segment_id: segment.id } : null;
  }
  function validRefs() {
    const ids = new Map((project.tracks || []).map(track =>
      [track.id, new Set((track.segments || []).map(segment => segment?.id))]));
    return [...refs.values()].filter(ref => ids.get(ref.track_id)?.has(ref.segment_id));
  }
  function putRef(ref, { activate = true } = {}) {
    const stable = copy(ref);
    refs.set(key(stable), stable);
    if (activate) currentRef = stable;
  }
  function addRef(ref, options) { if (ref && resolve(ref)) putRef(ref, options); }
  function removeRef(ref) {
    if (!ref) return false;
    const removed = refs.delete(key(ref));
    if (currentRef && key(currentRef) === key(ref)) currentRef = null;
    return removed;
  }
  function current() {
    if (currentRef && refs.has(key(currentRef)) && resolve(currentRef)) return currentRef;
    const valid = validRefs();
    return valid[valid.length - 1] || null;
  }
  function indexValues(kind) {
    const track = trackForKind(kind);
    if (!track) return [];
    // Preserve selection insertion order, rather than track order.
    const indexById = new Map((track.segments || []).map((segment, index) => [segment?.id, index]));
    return [...refs.values()].filter(ref => ref.track_id === track.id && indexById.has(ref.segment_id))
      .map(ref => indexById.get(ref.segment_id));
  }
  const views = {};
  for (const kind of ['main', 'extension', 'overlay']) {
    views[kind] = Object.freeze({
      get size() { return indexValues(kind).length; },
      has(index) { const ref = refAt(kind, index); return !!ref && refs.has(key(ref)); },
      values() { return indexValues(kind).values(); },
      keys() { return indexValues(kind).values(); },
      entries() { return indexValues(kind).map(index => [index, index]).values(); },
      forEach(callback, receiver) { for (const index of indexValues(kind)) callback.call(receiver, index, index, views[kind]); },
      [Symbol.iterator]() { return indexValues(kind).values(); },
    });
  }
  function anchor(kind) {
    trackForKind(kind);
    const found = resolve(anchors[kind]);
    return found && found.track.id === trackForKind(kind)?.id ? found.index : -1;
  }
  function setAnchor(kind, index) { anchors[kind] = refAt(kind, index); }
  const selection = Object.freeze({
    get mainAnchor() { return anchor('main'); },
    set mainAnchor(index) { setAnchor('main', index); },
    get extensionAnchor() { return anchor('extension'); },
    set extensionAnchor(index) { setAnchor('extension', index); },
    get overlayAnchor() { return anchor('overlay'); },
    set overlayAnchor(index) { setAnchor('overlay', index); },
    indices(kind) { trackForKind(kind); return views[kind]; },
    add(kind, index, options) { const ref = refAt(kind, index); if (ref) putRef(ref, options); },
    addRef,
    activateRef(ref) { if (ref && refs.has(key(ref)) && resolve(ref)) currentRef = copy(ref); },
    remove(kind, index) { return removeRef(refAt(kind, index)); },
    removeRef,
    clear(kind) {
      const track = trackForKind(kind);
      if (track) for (const ref of refs.values()) if (ref.track_id === track.id) removeRef(ref);
    },
    replace(kind, indices) {
      const next = [...indices].map(index => refAt(kind, index)).filter(Boolean);
      this.clear(kind);
      next.forEach(ref => putRef(ref));
    },
    replaceRefs(next, active = null) {
      refs.clear(); currentRef = null;
      const ids = new Map((project.tracks || []).map(track =>
        [track.id, new Set((track.segments || []).map(segment => segment?.id))]));
      for (const ref of next || []) if (ids.get(ref?.track_id)?.has(ref.segment_id)) putRef(ref, { activate: false });
      if (active && refs.has(key(active)) && resolve(active)) currentRef = copy(active);
      else currentRef = current();
    },
    getSelectedCueRefs() { return validRefs().map(copy); },
    getCurrentCueRef() { return copy(current()); },
    getCurrentTrack() { return findTrack(current()?.track_id) || trackForKind('main'); },
    snapshot() { return { refs: validRefs().map(copy), current: copy(current()),
      anchors: Object.fromEntries(Object.entries(anchors).map(([kind, ref]) => [kind, resolve(ref) ? copy(ref) : null])) }; },
    restore(snapshot) {
      this.replaceRefs(snapshot?.refs || [], snapshot?.current);
      for (const kind of Object.keys(anchors)) anchors[kind] = resolve(snapshot?.anchors?.[kind]) ? copy(snapshot.anchors[kind]) : null;
    },
    // Existing transfer callers invoke this after the source splice. Removed
    // refs are then unresolved; remaining refs already point at their new index.
    removeAndShift(kind, removedIndex) {
      const track = trackForKind(kind);
      if (!Number.isInteger(removedIndex) || removedIndex < 0) return { wasSelected: false, nextAnchor: anchor(kind) };
      let wasSelected = false;
      if (track) for (const ref of [...refs.values()]) {
        if (ref.track_id === track.id && !resolve(ref)) { wasSelected = true; removeRef(ref); }
      }
      if (anchors[kind] && !resolve(anchors[kind])) anchors[kind] = null;
      return { wasSelected, nextAnchor: anchor(kind) };
    },
    anchor, setAnchor,
    reset() { refs.clear(); currentRef = null; for (const kind of Object.keys(anchors)) anchors[kind] = null; },
  });

  const preferences = Object.seal({ editor: {} });
  const runtime = Object.seal({
    player: null, waveformEditor: null, playbackFrameId: 0, playbackFramePlayer: null,
    waveformLoadedFromProject: false,
  });
  let panelKind = 'main', panelTrackId = null, panelRef = null;
  const panel = Object.seal({
    gapPreviewRange: null, gapRemovePanelDrag: null,
    get currentCuePanelIdx() { return resolve(panelRef)?.index ?? -1; },
    set currentCuePanelIdx(index) {
      const track = panelKind === 'extension' && panelTrackId ? findTrack(panelTrackId) : trackForKind(panelKind);
      const segment = Number.isInteger(index) && index >= 0 ? track?.segments?.[index] : null;
      panelRef = segment?.id != null ? { track_id: track.id, segment_id: segment.id } : null;
    },
    get currentCuePanelKind() { return panelKind; },
    set currentCuePanelKind(value) { panelKind = value; },
    get currentCuePanelTrackId() { return panelTrackId; },
    set currentCuePanelTrackId(value) { panelTrackId = value; },
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
    get timedTextEditViewDirty() { return changesFlags.timedTextEditViewDirty; },
    set timedTextEditViewDirty(value) { changesFlags.timedTextEditViewDirty = Boolean(value); if (changesFlags.timedTextEditViewDirty) markProjectDirty(); },
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
  };
  Object.freeze(changes);

  // The serializer owns persistence. Readers must not repair or mutate the project.
  // The fallback also keeps this state owner usable before editor wiring is ready.
  let snapshotReader = () => project;
  let projectEpoch = 0;
  let importNeedsSave = false;
  function persistenceSnapshot(value) {
    const fields = { ...value };
    for (const key of ['waveform', 'spectral', 'waveform_reapeaks', 'loudness']) delete fields[key];
    const out = JSON.parse(JSON.stringify(fields));
    delete out._dirty;
    const clear = track => {
      if (!track) return;
      delete track._dirty;
      for (const segment of track.segments || []) delete segment._dirty;
    };
    for (const track of out.tracks || []) clear(track);
    return out;
  }
  function projectFingerprint(value = snapshotReader()) {
    // Sort object keys, not arrays: reordered extension keys are not an edit.
    return JSON.stringify(persistenceSnapshot(value), (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  }
  function setSnapshotReader(reader) { snapshotReader = reader; }
  let savedProject = projectFingerprint();
  function noteSavedSegments(fingerprint = projectFingerprint()) { savedProject = fingerprint; }
  function subtitleTracks() {
    return (project.tracks || []).map(track => [track.id, track]);
  }
  function clearSubtitleDirtyFlags() {
    delete project._dirty;
    for (const [, track] of subtitleTracks()) {
      if (!track) continue;
      delete track._dirty;
      for (const segment of track.segments || []) delete segment._dirty;
    }
  }
  const sessionHighlights = new Map();
  function rememberSessionHighlights() {
    for (const [kind, track] of subtitleTracks()) {
      if (!sessionHighlights.has(kind)) sessionHighlights.set(kind, new Set());
      for (const segment of track?.segments || []) {
        if (segment._dirty && segment.id != null) sessionHighlights.get(kind).add(segment.id);
      }
    }
  }
  function restoreSessionHighlights() {
    for (const [kind, track] of subtitleTracks()) {
      for (const segment of track?.segments || []) {
        if (sessionHighlights.get(kind)?.has(segment.id)) segment._dirty = true;
      }
    }
  }
  function markSaved() {
    importNeedsSave = false;
    for (const key of Object.keys(changes)) changes[key] = false;
  }
  function beginProjectSession() {
    projectEpoch += 1;
    selection.reset();
    panelRef = null; panelKind = 'main'; panelTrackId = null;
    sessionHighlights.clear();
    clearSubtitleDirtyFlags();
    markSaved();
  }
  function establishProjectCheckpoint({ repaired = false } = {}) {
    noteSavedSegments();
    importNeedsSave = repaired;
  }
  function reconcileSegmentsDirty() {
    changes.projectImportDirty = hasProjectChanges();
  }
  function hasProjectChanges(pendingText = false) {
    return Boolean(pendingText || importNeedsSave || projectFingerprint() !== savedProject);
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
    projectFingerprint, persistenceSnapshot, setSnapshotReader, beginProjectSession, establishProjectCheckpoint,
    rememberSessionHighlights, restoreSessionHighlights, get projectEpoch() { return projectEpoch; },
    // Kept as narrow compatibility aliases for existing command/history callers.
    segmentsFingerprint: projectFingerprint, noteSavedSegments, markSaved, reconcileSegmentsDirty,
    beginProjectLoad, finishProjectLoad, observeProjectLoad, waitForProjectLoad,
    get projectLoadGeneration() { return projectLoadGeneration; },
    get projectLoadPending() { return projectLoadPending; },
    markProjectDirty, getProjectDirtyEpoch, onProjectDirtyChange });
}

export function initMaweState() {
  'use strict';
  // 注册表 resolve 时代的返回值即 any；与原装配语义一致，经局部
  // 中转赋窗口单例，类型断言由 editor-globals.d.ts 的接口描述承担。
  const state = /** @type {any} */ (createEditorState(window.MaweBoot.DATA));
  window.MaweState = state;
}

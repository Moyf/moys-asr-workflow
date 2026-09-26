// One owner for project identity, selection, preferences and transient UI state.
// The project is the original template object; no second subtitle source exists.
window.MAWE.register('editor-state', function createEditorState(project) {
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
  const changes = Object.seal({ projectImportDirty: false, gapRemoveDirty: false, previewGeometryDirty: false });

  function hasProjectChanges(pendingText = false) {
    const dirty = track => Boolean(track?._dirty) || (track?.segments || []).some(segment => segment._dirty);
    return Boolean(pendingText || changes.projectImportDirty || changes.gapRemoveDirty || changes.previewGeometryDirty
      || (project.segments || []).some(segment => segment._dirty)
      || dirty(project.overlay_track) || dirty(project.multi_subtitle)
      || (project.multi_subtitle?.tracks || []).some(dirty));
  }

  return Object.freeze({ project, selection, preferences, runtime, panel, editing, changes, hasProjectChanges });
});
window.MaweState = window.MAWE.resolve('editor-state', window.MaweBoot.DATA);

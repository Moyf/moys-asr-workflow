// Stage a snapshot; publish history only after a real, successful mutation.
window.MAWE.register('editor-commands', function createEditorCommands(dependencies) {
  'use strict';
  const { capture, hasChanges, publish, restore, refresh } = dependencies;
  function begin(label, options = {}) {
    const snapshot = capture(label, options);
    let finished = false;
    return Object.freeze({
      commit(invalidation = {}) {
        if (finished) return false;
        if (!hasChanges(snapshot)) {
          restore(snapshot, { dirtyOnly: true });
          finished = true;
          return false;
        }
        publish(snapshot);
        finished = true;
        refresh(invalidation);
        return true;
      },
      cancel() {
        if (finished) return false;
        finished = true;
        restore(snapshot, { dirtyOnly: !hasChanges(snapshot) });
        return true;
      },
      // Used when the caller has already restored a narrower text-edit snapshot.
      discard() { finished = true; },
    });
  }
  function run(label, mutate, options = {}) {
    const command = begin(label, options);
    try {
      const result = mutate(command);
      if (result && typeof result.then === 'function') throw new TypeError('Editor mutations must be synchronous');
      command.commit(options.invalidate);
      return result;
    } catch (error) {
      command.cancel();
      throw error;
    }
  }
  return Object.freeze({ begin, run });
});

(function composeEditorCommands() {
  'use strict';
  const fingerprint = value => JSON.stringify(value, (key, item) => key === '_dirty' ? undefined : item);
  const projectSegments = () => ({
    segments: MaweState.project.segments,
    multi_subtitle: MaweState.project.multi_subtitle,
    overlay_track: MaweState.project.overlay_track,
  });
  function restoreDirtyFlags(current, previous) {
    if (!current || typeof current !== 'object') return;
    if (previous && Object.hasOwn(previous, '_dirty')) current._dirty = previous._dirty;
    else delete current._dirty;
    for (const key of Object.keys(current)) {
      if (key !== '_dirty') restoreDirtyFlags(current[key], previous?.[key]);
    }
  }
  window.MaweCommands = window.MAWE.resolve('editor-commands', {
    capture(label, options) {
      MaweCueListAnchor.rememberCueListMutation();
      const record = MaweHistory.captureSegmentsRecord(label, options);
      return { record, fingerprint: fingerprint(record.segs), selection: MaweHistory.snapshotEditorSelection() };
    },
    hasChanges: snapshot => fingerprint(projectSegments()) !== snapshot.fingerprint,
    publish(snapshot) {
      MaweHistory.commitRecord(snapshot.record);
      MaweState.changes.projectImportDirty = true;
    },
    restore(snapshot, { dirtyOnly }) {
      if (dirtyOnly) restoreDirtyFlags(projectSegments(), snapshot.record.segs);
      else MaweHistory.applyHistoryRecord({ ...snapshot.record, view: snapshot.selection });
      Object.assign(MaweState.changes, snapshot.record.projectChanges);
    },
    refresh: invalidation => MaweViewUpdates.invalidate({ save: true, ...invalidation }),
  });
})();

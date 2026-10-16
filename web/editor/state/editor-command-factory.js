// Pure transaction coordinator. The editor adapter lives in editor-commands.js.
export function createEditorCommands(dependencies) {
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
}

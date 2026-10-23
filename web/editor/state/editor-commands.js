// 命令事务：暂存快照，只有真实成功变更后才发布历史。
// ESM 模块：createEditorCommands 为纯工厂具名导出（测试直调），
// initMaweCommands 在原清单位次组装依赖并挂 window.MaweCommands
//（register/resolve 注册表随之退役，G16 后窗口出接口同样退役）。
export function createEditorCommands(dependencies) {
  'use strict';
  const { capture, hasChanges, publish, restore, refresh } = dependencies;
  const beforeBeginListeners = new Set();
  function onBeforeBegin(listener) {
    if (typeof listener !== 'function') throw new TypeError('Command before-begin listener must be a function');
    beforeBeginListeners.add(listener);
    return () => beforeBeginListeners.delete(listener);
  }
  function begin(label, options = {}) {
    for (const listener of beforeBeginListeners) listener(label, options);
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
  return Object.freeze({ begin, run, onBeforeBegin });
}

export function initMaweCommands() {
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
  window.MaweCommands = createEditorCommands({
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
      // 恢复（命令取消/无实效提交/面板撤销）会把脏标志拨回快照状态，可能变脏
      // 也可能变清洁；事件只表示「脏态可能已变」，指示器回调按当前状态整体重算。
      MaweState.markProjectDirty();
    },
    refresh: invalidation => MaweViewUpdates.invalidate({ save: true, ...invalidation }),
  });
}

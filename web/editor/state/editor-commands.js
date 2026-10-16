
// Stage a snapshot; publish history only after a real, successful mutation.

import { createEditorCommands } from './editor-command-factory.js';
export { createEditorCommands };

import { MaweHistory } from "./editor-history.js";

import { MaweViewUpdates } from "./editor-view-updates.js";
import { MaweCueListAnchor } from "../cues/editor-cue-list-anchor.js";
import { getMaweState } from './editor-state.js';
// compose：resolve 参数对象依赖的本地函数（fingerprint 等）。

  const fingerprint = value => JSON.stringify(value, (key, item) => key === '_dirty' ? undefined : item);
  const projectSegments = () => ({
    segments: getMaweState().project.segments,
    multi_subtitle: getMaweState().project.multi_subtitle,
    overlay_track: getMaweState().project.overlay_track,
  });
  function restoreDirtyFlags(current, previous) {
    if (!current || typeof current !== 'object') return;
    if (previous && Object.hasOwn(previous, '_dirty')) current._dirty = previous._dirty;
    else delete current._dirty;
    for (const key of Object.keys(current)) {
      if (key !== '_dirty') restoreDirtyFlags(current[key], previous?.[key]);
    }
  }
export const MaweCommands = createEditorCommands({
    capture(label, options) {
      MaweCueListAnchor.rememberCueListMutation();
      const record = MaweHistory.captureSegmentsRecord(label, options);
      return { record, fingerprint: fingerprint(record.segs), selection: MaweHistory.snapshotEditorSelection() };
    },
    hasChanges: snapshot => fingerprint(projectSegments()) !== snapshot.fingerprint,
    publish(snapshot) {
      MaweHistory.commitRecord(snapshot.record);
      getMaweState().changes.projectImportDirty = true;
    },
    restore(snapshot, { dirtyOnly }) {
      if (dirtyOnly) restoreDirtyFlags(projectSegments(), snapshot.record.segs);
      else MaweHistory.applyHistoryRecord({ ...snapshot.record, view: snapshot.selection });
      Object.assign(getMaweState().changes, snapshot.record.projectChanges);
    },
    refresh: invalidation => MaweViewUpdates.invalidate({ save: true, ...invalidation }),
  });
if (typeof window !== 'undefined') window.MaweCommands = MaweCommands;

// Playback repeatedly reads mutable project records. Keep only the current
// gap input and its cue projections, checking values rather than object IDs.
function captureValue(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return { array: true, values: value.map(captureValue) };
  const fields = Object.create(null);
  let size = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    fields[key] = captureValue(value[key]);
    size += 1;
  }
  return { array: false, fields, size };
}

function matchesValue(value, snapshot) {
  if (!value || typeof value !== 'object') return Object.is(value, snapshot);
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (Array.isArray(value)) {
    if (snapshot.array !== true || value.length !== snapshot.values.length) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!matchesValue(value[index], snapshot.values[index])) return false;
    }
    return true;
  }
  if (snapshot.array !== false) return false;
  let size = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (!Object.hasOwn(snapshot.fields, key) || !matchesValue(value[key], snapshot.fields[key])) return false;
    size += 1;
  }
  return size === snapshot.size;
}

function captureCue(cue) {
  return { fields: { ...cue }, items: captureValue(cue.items) };
}

function matchesCue(cue, snapshot) {
  if (!snapshot || !matchesValue(cue.items, snapshot.items)) return false;
  let size = 0;
  for (const key in cue) {
    if (!Object.hasOwn(cue, key)) continue;
    if (!Object.hasOwn(snapshot.fields, key) || !Object.is(cue[key], snapshot.fields[key])) return false;
    size += 1;
  }
  // Capture the field count once, not an Object.keys allocation every frame.
  return size === snapshot.size;
}

function cueSnapshot(cue) {
  const snapshot = captureCue(cue);
  snapshot.size = Object.keys(snapshot.fields).length;
  return snapshot;
}

export function createCleanupProjectionCache({ createRetainedProjector, createExportProjector }) {
  let enabled = true;
  let gapReference;
  let provenanceSnapshot;
  let gapsSnapshot;
  let retainedProjector;
  let exportProjector;
  let retainedCues = new WeakMap();
  let exportCues = new WeakMap();
  let exportSource = null;
  let exportResult = null;
  let exportIdentities = [];

  function reset(gapRemove) {
    gapReference = gapRemove;
    provenanceSnapshot = undefined;
    gapsSnapshot = undefined;
    retainedProjector = null;
    exportProjector = null;
    retainedCues = new WeakMap();
    exportCues = new WeakMap();
    exportSource = null;
    exportResult = null;
    exportIdentities = [];
  }

  function hasCleanup(gapRemove) {
    const ranges = gapRemove?.provenance?.sources?.ai_cleanup;
    if (Array.isArray(ranges) && ranges.length) return true;
    if (gapReference !== gapRemove || retainedProjector || exportProjector) reset(gapRemove);
    return false;
  }

  function syncGap(gapRemove) {
    if (gapReference === gapRemove
        && matchesValue(gapRemove?.provenance, provenanceSnapshot)
        && matchesValue(gapRemove?.gaps, gapsSnapshot)) return;
    reset(gapRemove);
    provenanceSnapshot = captureValue(gapRemove?.provenance);
    gapsSnapshot = captureValue(gapRemove?.gaps);
  }

  function projectCue(cue, cache, projector) {
    if (!cue || typeof cue !== 'object') return cue;
    const previous = cache.get(cue);
    if (previous && matchesCue(cue, previous.snapshot)) return previous.result;
    const result = projector([cue])[0];
    cache.set(cue, { snapshot: cueSnapshot(cue), result });
    return result;
  }

  function retainedCue(cue, gapRemove) {
    if (!hasCleanup(gapRemove)) return cue;
    if (gapReference !== gapRemove) reset(gapRemove);
    // Read scope IDs on every call so in-place additions/moves can make a cue
    // relevant, without inspecting the full gap input for unrelated cues.
    if (!gapRemove.provenance.sources.ai_cleanup.some((range) => range?.cleanup_scope
        && cue?.id === range.cleanup_scope.segment_id)) return cue;
    if (!enabled) return createRetainedProjector(gapRemove)([cue])[0];
    syncGap(gapRemove);
    if (!retainedProjector) retainedProjector = createRetainedProjector(gapRemove);
    return projectCue(cue, retainedCues, retainedProjector);
  }

  function exportSegments(segments, gapRemove) {
    const source = Array.isArray(segments) ? segments : [];
    if (!enabled) return createExportProjector(gapRemove)(source);
    if (!hasCleanup(gapRemove)) return source;
    syncGap(gapRemove);
    if (!exportProjector) exportProjector = createExportProjector(gapRemove);
    if (exportSource === source && exportIdentities.length === source.length && exportResult) {
      let unchanged = true;
      for (let index = 0; index < source.length; index += 1) {
        const cue = source[index];
        if ((index in source) !== (index in exportIdentities) || exportIdentities[index] !== cue
            || (cue && typeof cue === 'object' && !matchesCue(cue, exportCues.get(cue)?.snapshot))) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return exportResult;
    }
    exportSource = source;
    exportIdentities = source.slice();
    exportResult = source.flatMap((cue) => [projectCue(cue, exportCues, exportProjector)]);
    return exportResult;
  }

  function setEnabled(value) {
    const next = value !== false;
    if (next !== enabled) { reset(undefined); enabled = next; }
  }
  return Object.freeze({ retainedCue, exportSegments, setEnabled, isEnabled: () => enabled });
}

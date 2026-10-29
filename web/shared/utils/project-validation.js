// Project import/validation facade. The canonical model owns format rules;
// repair remains an explicit, observable input-boundary operation.
(function (global) {
  'use strict';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  function validateProject(input) {
    try {
      const imported = global.AsrEditorUtils.importProject(input);
      return { ok: true, errors: [], project: imported.project, preview: null };
    } catch (error) {
      if (!Array.isArray(error.errors)) throw error;
      return { ok: false, errors: error.errors, project: null, preview: null };
    }
  }

  function changes(before, after, path = '$') {
    if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) => {
      const child = `${path}.${key}`;
      if (!Object.hasOwn(before, key)) return [{ path: child, kind: 'add', after: after[key] }];
      if (!Object.hasOwn(after, key)) return [{ path: child, kind: 'remove', before: before[key] }];
      return changes(before[key], after[key], child);
    });
    if (Array.isArray(before) && Array.isArray(after) && before.length === after.length)
      return before.flatMap((value, i) => changes(value, after[i], `${path}[${i}]`));
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, kind: 'replace', before, after }];
  }
  function repairTimings(project) {
    const collections = Array.isArray(project.tracks) ? project.tracks.map(track => track?.segments)
      : [project.segments, project.overlay_track?.segments, ...(project.multi_subtitle?.tracks || []).map(track => track?.segments)];
    for (const list of collections) {
      if (!Array.isArray(list)) continue;
      let previous = 0;
      for (const segment of list) {
        segment.start = Math.max(segment.start, previous);
        let itemEnd = segment.start;
        for (const item of segment.items || []) {
          const zero = item.end === item.start;
          item.start = Math.max(item.start, itemEnd);
          if (item.end < item.start || (!zero && item.end === item.start)) item.end = item.start + 100;
          itemEnd = item.end;
        }
        if (segment.items?.length) segment.end = Math.max(segment.end, itemEnd);
        if (segment.end <= segment.start) segment.end = segment.start + 100;
        previous = segment.end;
      }
    }
  }

  function hasNumericTimings(project) {
    if (!object(project)) return false;
    const collections = Array.isArray(project.tracks) ? project.tracks.map(track => track?.segments)
      : [project.segments, project.overlay_track?.segments, ...(Array.isArray(project.multi_subtitle?.tracks) ? project.multi_subtitle.tracks.map(track => track?.segments) : [])];
    return collections.every(list => !Array.isArray(list) || list.every(segment => object(segment)
      && Number.isSafeInteger(segment.start) && Number.isSafeInteger(segment.end)
      && (segment.items == null || (Array.isArray(segment.items) && segment.items.every(item => object(item)
        && Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end))))));
  }

  function prepareProject(input, { repair = true } = {}) {
    let result = validateProject(input);
    const timing = new Set(['must be non-negative', 'must be non-negative integer milliseconds', 'must be greater than start in integer milliseconds', 'must be greater than start', 'must be >= previous segment end', 'must be within segment bounds', 'must be within segment bounds and >= start', 'must be >= previous item end', 'must be within segment bounds and >= previous item end']);
    if (!result.ok && repair && hasNumericTimings(input) && result.errors.every((e) => /\.(start|end)$/.test(e.path) && timing.has(e.message))) {
      const candidate = clone(input);
      repairTimings(candidate);
      result = validateProject(candidate);
    }
    return { ...result, changes: result.ok ? changes(input, result.project) : [] };
  }

  global.MaweProjectValidation = Object.freeze({ validateProject, prepareProject, changes });
})(typeof window !== 'undefined' ? window : globalThis);

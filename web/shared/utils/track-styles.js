// Project snapshots use the same normalized style records as the ASS library.
export function createUtilsModule(dependencies) {
  'use strict';
  const { normalizeAssStyle, ASS_DEFAULT_ASS_STYLE } = dependencies;

  const clone = value => JSON.parse(JSON.stringify(value));
  const normalized = style => normalizeAssStyle(style, ASS_DEFAULT_ASS_STYLE, style?.id || 'ass');
  const comparable = style => {
    const { id, builtin, ...parameters } = normalized(style);
    return JSON.stringify(parameters);
  };
  const snapshotFor = (project, track) => (project.styles || []).find(style => style.id === track?.style?.style_id) || null;
  const libraryMatch = (snapshot, library) => {
    if (!snapshot) return null;
    const matches = (library?.styles || []).filter(style => comparable(style) === comparable(snapshot));
    return matches.length === 1 ? matches[0] : null;
  };
  const nextId = styles => {
    const ids = new Set(styles.map(style => style.id));
    let n = 1;
    while (ids.has(`project-style-${n}`)) n += 1;
    return `project-style-${n}`;
  };
  const discardUnused = (project, styleId) => {
    if (styleId && !(project.tracks || []).some(track => track.style?.style_id === styleId)) {
      project.styles = project.styles.filter(style => style.id !== styleId);
    }
  };

  function resolveTrackStyle(project, track, library) {
    const snapshot = snapshotFor(project, track);
    if (!snapshot) return { style: null, status: 'unassigned', libraryStyle: null };
    const libraryStyle = track.style.forked ? null : libraryMatch(snapshot, library);
    return { style: clone(snapshot), status: libraryStyle ? 'linked' : 'forked', libraryStyle };
  }

  function applyTrackStyle(project, track, libraryStyle) {
    if (!track || !libraryStyle) return false;
    const styles = project.styles || (project.styles = []);
    const oldId = track.style?.style_id;
    const id = nextId(styles);
    styles.push({ ...normalized(libraryStyle), id, builtin: false });
    track.style = { ...track.style, style_id: id, forked: false };
    discardUnused(project, oldId);
    return true;
  }

  // Editing a track never changes a snapshot used by another track.
  function updateTrackStyle(project, track, patch) {
    const previous = snapshotFor(project, track);
    if (!previous) return false;
    const styles = project.styles;
    const id = nextId(styles);
    const updated = normalized({ ...previous, ...patch, id });
    if (comparable(updated) === comparable(previous)) return false;
    styles.push({ ...previous, ...updated, id, builtin: false });
    track.style = { ...track.style, style_id: id, forked: true };
    discardUnused(project, previous.id);
    return true;
  }

  function forkTrackStyle(project, track) {
    if (!snapshotFor(project, track) || track.style.forked) return false;
    track.style = { ...track.style, forked: true };
    return true;
  }

  // Compare against the old library first: an intentional library edit should
  // update linked snapshots, whereas an already-divergent snapshot must survive.
  function updateLinkedTrackStyles(project, oldLibrary, newLibrary) {
    let changed = false;
    for (const track of project.tracks || []) {
      const resolved = resolveTrackStyle(project, track, oldLibrary);
      if (resolved.status !== 'linked') continue;
      const replacement = (newLibrary?.styles || []).find(style => style.id === resolved.libraryStyle.id);
      if (!replacement) { track.style = { ...track.style, forked: true }; changed = true; continue; }
      if (comparable(replacement) === comparable(resolved.style)) continue;
      const styles = project.styles;
      const id = nextId(styles);
      styles.push({ ...resolved.style, ...normalized(replacement), id, builtin: false });
      track.style = { ...track.style, style_id: id, forked: false };
      discardUnused(project, resolved.style.id);
      changed = true;
    }
    return changed;
  }

  // Returns a new library; callers decide how to persist it. A conflicting
  // name is explicit so a project cannot silently overwrite a library preset.
  function saveTrackStyleToLibrary(project, track, library, { replace = false } = {}) {
    const snapshot = snapshotFor(project, track);
    if (!snapshot) return { ok: false, reason: 'unassigned', library };
    const next = clone(library);
    const matches = (next.styles || []).filter(style => style.name === snapshot.name);
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', library };
    if (matches.length && comparable(matches[0]) !== comparable(snapshot) && !replace)
      return { ok: false, reason: 'conflict', library };
    if (!matches.length && next.styles.length >= 64) return { ok: false, reason: 'full', library };
    const id = matches[0]?.id || nextId(next.styles);
    const saved = { ...normalized(snapshot), id, builtin: matches[0]?.builtin || false };
    if (matches.length) next.styles[next.styles.indexOf(matches[0])] = saved;
    else next.styles.push(saved);
    track.style = { ...track.style, forked: false };
    return { ok: true, library: next, style: saved };
  }

  return Object.freeze({ resolveTrackStyle, applyTrackStyle, updateTrackStyle, forkTrackStyle,
    updateLinkedTrackStyles, saveTrackStyleToLibrary });
}

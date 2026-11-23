// Cue entries preserve the complete source definition, including vendor fields.
// library_id is present only when the user explicitly chose to follow a preset.
function contentKey(value) {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export function cueStyleWriter(project) {
  const entries = project.cue_styles || [];
  const ids = new Set(entries.map(entry => entry.id));
  const byContent = new Map(entries.map(({ id, ...definition }) => [contentKey(definition), id]));
  let sequence = 1;
  return definition => {
    const key = contentKey(definition);
    if (byContent.has(key)) return byContent.get(key);
    let id;
    do { id = 'cue-style-' + sequence++; } while (ids.has(id));
    ids.add(id);
    entries.push({ id, ...JSON.parse(JSON.stringify(definition)) });
    project.cue_styles = entries;
    byContent.set(key, id);
    return id;
  };
}

export function migrateCueStyles(project) {
  let store;
  for (const track of project.tracks) for (const cue of track.segments) {
    if (!Object.hasOwn(cue, 'assStyle')) continue;
    store ||= cueStyleWriter(project);
    cue.cue_style_id = store({ style: cue.assStyle });
    delete cue.assStyle;
  }
}

// Compact a detached save projection after formerly different entries converge.
export function compactCueStyles(project) {
  if (!project.cue_styles) return;
  const usage = cueStyleUsage(project);
  const byContent = new Map();
  const remap = new Map();
  project.cue_styles = project.cue_styles.filter(entry => {
    if (!usage.has(entry.id)) return false;
    const { id, ...definition } = entry;
    const key = contentKey(definition);
    if (byContent.has(key)) {
      remap.set(id, byContent.get(key));
      return false;
    }
    byContent.set(key, id);
    return true;
  });
  if (remap.size) for (const track of project.tracks) for (const cue of track.segments) {
    if (remap.has(cue.cue_style_id)) cue.cue_style_id = remap.get(cue.cue_style_id);
  }
  if (!project.cue_styles.length) delete project.cue_styles;
}

export function cueStyleUsage(project) {
  const counts = new Map();
  for (const track of project.tracks || []) for (const cue of track.segments) {
    if (cue.cue_style_id) counts.set(cue.cue_style_id, 1 + (counts.get(cue.cue_style_id) || 0));
  }
  return counts;
}

// On a local edit, touch only presets changed by that edit. An explicit refresh
// omits previous and adopts the available library values for all linked cues.
export function cueStyleUpdates(project, library, previous) {
  const byId = new Map(library.styles.map(style => [style.id, style]));
  const old = new Map(previous?.styles.map(style => [style.id, style]));
  const usage = cueStyleUsage(project);
  const updates = [];
  for (const entry of project.cue_styles || []) {
    if (!usage.has(entry.id)) continue;
    const style = byId.get(entry.library_id);
    if (!style || (previous && contentKey(old.get(entry.library_id)) === contentKey(style))) continue;
    if (contentKey(entry.style) !== contentKey(style)) updates.push({ entry, style });
  }
  return updates;
}

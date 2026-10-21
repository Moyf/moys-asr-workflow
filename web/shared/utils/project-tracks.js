// The only project-level subtitle model. Legacy containers are accepted solely
// by importProject; consumers receive track entities from one canonical tree.
export const PROJECT_TRACKS_SCHEMA = 'moy.asr.project.v3';
const LEGACY_SCHEMAS = new Set(['moy.asr.project.v1', 'moy.asr.project.v2']);
const ROLES = new Set(['main', 'extension', 'overlay']);
const SOURCE_FIELDS = ['language', 'language_source', 'split_mode', 'timestamp_granularity',
  'model', 'preserve_punctuation', 'source_name'];
const OLD_FIELDS = ['segments', 'overlay_track', 'multi_subtitle', ...SOURCE_FIELDS];
const CACHE_FIELDS = ['waveform', 'spectral', 'waveform_reapeaks', 'loudness'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const id = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 160
  ? value.trim() : null;
const integer = value => Number.isSafeInteger(value);

export class ProjectTracksError extends Error {
  constructor(errors) {
    super(errors.map(error => `${error.path}: ${error.message}`).join('; '));
    this.name = 'ProjectTracksError';
    this.errors = errors;
  }
}

function fail(path, message) { throw new ProjectTracksError([{ path, message }]); }
function unique(base, reserved, used = new Set()) {
  base = base.slice(0, 150);
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate) || used.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}
export function getTrack(project, trackId) {
  return projectTracks(project).find(track => track?.id === trackId) || null;
}
export function getTracksByRole(project, role) {
  return projectTracks(project).filter(track => track?.role === role);
}
export function getMainTrack(project) { return getTracksByRole(project, 'main')[0] || null; }
export function getExtensionTrack(project, trackId = project?.bilingual?.active_track_id) {
  return trackId ? getTracksByRole(project, 'extension').find(track => track.id === trackId) || null
    : getTracksByRole(project, 'extension')[0] || null;
}
export function getOverlayTrack(project) { return getTracksByRole(project, 'overlay')[0] || null; }
export function projectTracks(project) { return Array.isArray(project?.tracks) ? project.tracks : []; }
export function* iterSegments(project) {
  for (const track of projectTracks(project)) for (const segment of track.segments) yield segment;
}

function validateSegments(segments, path, errors, globalIds, { legacy = false } = {}) {
  const add = (field, message) => errors.push({ path: field, message });
  if (!Array.isArray(segments)) { add(path, 'must be an array'); return; }
  const localIds = new Set();
  let previousEnd = null;
  segments.forEach((segment, index) => {
    const field = `${path}[${index}]`;
    if (!object(segment)) { add(field, 'must be an object'); return; }
    if (!legacy || own(segment, 'id')) {
      const cueId = id(segment.id);
      if (!cueId || (!legacy && segment.id !== cueId)) add(`${field}.id`, 'must be a valid canonical cue ID');
      else if (localIds.has(cueId) || (!legacy && globalIds.has(cueId))) add(`${field}.id`, 'must be unique');
      else { localIds.add(cueId); globalIds.add(cueId); }
    }
    if (!integer(segment.start) || segment.start < 0) add(`${field}.start`, 'must be non-negative integer milliseconds');
    if (!integer(segment.end) || segment.end <= segment.start) add(`${field}.end`, 'must be greater than start in integer milliseconds');
    if (integer(segment.start) && previousEnd !== null && segment.start < previousEnd) add(`${field}.start`, 'must be >= previous segment end');
    if (integer(segment.end)) previousEnd = segment.end;
    if (typeof segment.text !== 'string') add(`${field}.text`, 'must be a string');
    if (own(segment, 'disabled') && typeof segment.disabled !== 'boolean') add(`${field}.disabled`, 'must be a boolean');
    if (own(segment, 'speaker') && typeof segment.speaker !== 'string') add(`${field}.speaker`, 'must be a string');
    if (own(segment, 'start_frame') !== own(segment, 'end_frame')) add(`${field}.start_frame`, 'start_frame and end_frame must appear together');
    for (const frame of ['start_frame', 'end_frame']) if (own(segment, frame) && (!integer(segment[frame]) || segment[frame] < 0)) add(`${field}.${frame}`, 'must be a non-negative integer');
    if (own(segment, 'start_frame') && own(segment, 'end_frame') && segment.end_frame <= segment.start_frame) add(`${field}.end_frame`, 'must be greater than start_frame');
    if (own(segment, 'assOverride')) {
      const override = segment.assOverride;
      if (!object(override)) add(`${field}.assOverride`, 'must be an object');
      else {
        for (const key of Object.keys(override)) if (!['pos', 'scale'].includes(key)) add(`${field}.assOverride.${key}`, 'unsupported ASS override');
        if (own(override, 'scale') && (typeof override.scale !== 'number' || !Number.isFinite(override.scale) || override.scale < 0.1 || override.scale > 5)) add(`${field}.assOverride.scale`, 'must be a finite number from 0.1 to 5');
        if (own(override, 'pos') && (!object(override.pos) || typeof override.pos.x !== 'number' || typeof override.pos.y !== 'number' || !Number.isFinite(override.pos.x) || !Number.isFinite(override.pos.y))) add(`${field}.assOverride.pos`, 'must contain finite numeric x/y');
      }
    }
    if (own(segment, 'items')) {
      if (!Array.isArray(segment.items)) { add(`${field}.items`, 'must be an array'); return; }
      let itemEnd = segment.start;
      segment.items.forEach((item, itemIndex) => {
        const itemPath = `${field}.items[${itemIndex}]`;
        if (!object(item)) { add(itemPath, 'must be an object'); return; }
        if (!integer(item.start) || item.start < segment.start || item.start < itemEnd) add(`${itemPath}.start`, 'must be within segment bounds and >= previous item end');
        // Zero-duration punctuation is valid; enclosing cues always have duration.
        if (!integer(item.end) || item.end < item.start || item.end > segment.end) add(`${itemPath}.end`, 'must be within segment bounds and >= start');
        if (typeof item.text !== 'string') add(`${itemPath}.text`, 'must be a string');
        if (integer(item.end)) itemEnd = item.end;
      });
    }
  });
}

function validateGroups(project, errors) {
  const table = project.subtitle_groups;
  if (!object(table)) { errors.push({ path: '$.subtitle_groups', message: 'must be an object' }); return; }
  if (own(table, 'next_id') && (!integer(table.next_id) || table.next_id < 1)) errors.push({ path: '$.subtitle_groups.next_id', message: 'must be a positive safe integer' });
  for (const kind of ['color', 'sticker']) {
    const groups = table[kind];
    const ids = new Set();
    if (!Array.isArray(groups)) { errors.push({ path: `$.subtitle_groups.${kind}`, message: 'must be an array' }); continue; }
    groups.forEach((group, index) => {
      const path = `$.subtitle_groups.${kind}[${index}]`;
      if (!object(group)) { errors.push({ path, message: 'must be an object' }); return; }
      if (!id(group.id) || group.id !== id(group.id) || ids.has(id(group.id))) errors.push({ path: `${path}.id`, message: 'must be a unique canonical group ID' });
      else ids.add(id(group.id));
      if (!object(group.value) || typeof group.value.name !== 'string') errors.push({ path: `${path}.value`, message: 'must contain a name' });
      else if (own(group.value, 'start') || own(group.value, 'end')) errors.push({ path: `${path}.value`, message: 'group range is derived from members' });
    });
    projectTracks(project).forEach((track, trackIndex) => {
      (Array.isArray(track?.segments) ? track.segments : []).forEach((segment, index) => {
        if (!object(segment)) return;
        const path = `$.tracks[${trackIndex}].segments[${index}]`;
        if (own(segment, `${kind}_group_id`) && !ids.has(segment[`${kind}_group_id`])) errors.push({ path: `${path}.${kind}_group_id`, message: 'must reference an existing group' });
        if (own(segment, kind) || own(segment, `${kind}_ref`)) errors.push({ path: `${path}.${kind}`, message: 'legacy group fields are not allowed' });
      });
    });
  }
}

export function validateTracksProject(project) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!object(project)) return { ok: false, errors: [{ path: '$', message: 'must be an object' }], project: null };
  if (project.schema !== PROJECT_TRACKS_SCHEMA) add('$.schema', `must be ${PROJECT_TRACKS_SCHEMA}`);
  for (const field of OLD_FIELDS) if (own(project, field)) add(`$.${field}`, 'legacy project field is not allowed');
  const tracks = project.tracks;
  const trackIds = new Set();
  const cueIds = new Set();
  if (!Array.isArray(tracks)) add('$.tracks', 'must be an array');
  else tracks.forEach((track, index) => {
    const path = `$.tracks[${index}]`;
    if (!object(track)) { add(path, 'must be an object'); return; }
    if (!id(track.id) || track.id !== id(track.id) || trackIds.has(track.id)) add(`${path}.id`, 'must be a unique canonical track ID');
    else trackIds.add(track.id);
    if (!ROLES.has(track.role)) add(`${path}.role`, 'must be main, extension or overlay');
    if (typeof track.name !== 'string') add(`${path}.name`, 'must be a string');
    if (typeof track.enabled !== 'boolean' || (track.role === 'main' && track.enabled !== true)) add(`${path}.enabled`, track.role === 'main' ? 'main track must be enabled' : 'must be a boolean');
    for (const field of SOURCE_FIELDS.filter(field => field !== 'preserve_punctuation')) if (own(track, field) && typeof track[field] !== 'string') add(`${path}.${field}`, 'must be a string');
    for (const field of ['split_mode', 'split_mode_override']) if (own(track, field) && !['continuous', 'word'].includes(track[field])) add(`${path}.${field}`, 'must be continuous or word');
    if (own(track, 'preserve_punctuation') && typeof track.preserve_punctuation !== 'boolean') add(`${path}.preserve_punctuation`, 'must be a boolean');
    if (own(track, 'metadata') && !object(track.metadata)) add(`${path}.metadata`, 'must be an object');
    validateSegments(track.segments, `${path}.segments`, errors, cueIds);
  });
  if (getTracksByRole(project, 'main').length !== 1) add('$.tracks', 'must contain exactly one main track');
  if (getTracksByRole(project, 'overlay').length > 1) add('$.tracks', 'must contain at most one overlay track');
  const bilingual = project.bilingual;
  if (!object(bilingual)) add('$.bilingual', 'must be an object');
  else {
    if (!['main', 'extension', 'both'].includes(bilingual.display_mode)) add('$.bilingual.display_mode', 'must be main, extension or both');
    if (own(bilingual, 'enabled')) add('$.bilingual.enabled', 'enabled belongs to each track');
    if (own(bilingual, 'active_track_id') && !getTracksByRole(project, 'extension').some(track => track.id === bilingual.active_track_id)) add('$.bilingual.active_track_id', 'must reference an extension track');
    if (getTracksByRole(project, 'extension').length && !own(bilingual, 'active_track_id')) add('$.bilingual.active_track_id', 'must reference an extension track');
  }
  const bindings = project.bindings;
  const bindingIds = new Set();
  const sources = new Set();
  const targets = new Set();
  if (!Array.isArray(bindings)) add('$.bindings', 'must be an array');
  else bindings.forEach((binding, index) => {
    const path = `$.bindings[${index}]`;
    if (!object(binding)) { add(path, 'must be an object'); return; }
    if (!id(binding.id) || binding.id !== id(binding.id) || bindingIds.has(binding.id)) add(`${path}.id`, 'must be a unique canonical binding ID');
    else bindingIds.add(binding.id);
    const source = getTrack(project, binding.source_track_id);
    const target = getTrack(project, binding.target_track_id);
    if (!source || source.role !== 'main') add(`${path}.source_track_id`, 'must reference the main track');
    if (!target || target.role !== 'extension') add(`${path}.target_track_id`, 'must reference an extension track');
    const endpoints = [];
    for (const [side, track] of [['source', source], ['target', target]]) {
      const ids = binding[`${side}_segment_ids`];
      if (!Array.isArray(ids) || ids.length !== 1) { add(`${path}.${side}_segment_ids`, 'must contain exactly one cue ID'); endpoints.push(null); continue; }
      const segment = Array.isArray(track?.segments) ? track.segments.find(cue => cue?.id === ids[0]) : null;
      if (!segment) add(`${path}.${side}_segment_ids`, 'must reference an existing cue in the endpoint track');
      endpoints.push(segment);
    }
    const sourceKey = `${binding.target_track_id}:${binding.source_segment_ids?.[0]}`;
    const targetKey = `${binding.target_track_id}:${binding.target_segment_ids?.[0]}`;
    if (sources.has(sourceKey)) add(`${path}.source_segment_ids`, 'source cue is already bound to this target track');
    if (targets.has(targetKey)) add(`${path}.target_segment_ids`, 'target cue is already bound');
    sources.add(sourceKey); targets.add(targetKey);
    for (const [field, endpoint] of [['start_offset_ms', 'start'], ['end_offset_ms', 'end']]) {
      if (!integer(binding[field])) add(`${path}.${field}`, 'must be integer milliseconds');
      else if (endpoints[0] && endpoints[1] && binding[field] !== endpoints[1][endpoint] - endpoints[0][endpoint]) add(`${path}.${field}`, 'must equal endpoint timing difference');
    }
  });
  validateGroups(project, errors);
  return { ok: !errors.length, errors, project: errors.length ? null : project };
}

function changesBetween(before, after, path = '$') {
  if (object(before) && object(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => {
      const child = `${path}.${key}`;
      if (!own(before, key)) return [{ path: child, kind: 'add', after: after[key] }];
      if (!own(after, key)) return [{ path: child, kind: 'remove', before: before[key] }];
      return changesBetween(before[key], after[key], child);
    });
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) return before.flatMap((value, index) => changesBetween(value, after[index], `${path}[${index}]`));
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, kind: 'replace', before, after }];
}

function migrateLegacy(raw) {
  const project = clone(raw);
  for (const field of ['tracks', 'bindings', 'bilingual']) if (own(project, field)) fail(`$.${field}`, 'conflicts with legacy project structure');
  if (!Array.isArray(project.segments)) fail('$.segments', 'must be an array');
  const multi = project.multi_subtitle ?? {};
  if (!object(multi)) fail('$.multi_subtitle', 'must be an object');
  if (own(multi, 'schema') && multi.schema !== 'moy.asr.multi_subtitle.v1') fail('$.multi_subtitle.schema', 'unsupported multi-subtitle schema');
  if (own(multi, 'enabled') && typeof multi.enabled !== 'boolean') fail('$.multi_subtitle.enabled', 'must be a boolean');
  if (own(multi, 'display_mode') && !['main', 'extension', 'both'].includes(multi.display_mode)) fail('$.multi_subtitle.display_mode', 'must be main, extension or both');
  if (own(multi, 'main_split_mode') && !['continuous', 'word'].includes(multi.main_split_mode)) fail('$.multi_subtitle.main_split_mode', 'must be continuous or word');
  const extensions = multi.tracks ?? [];
  if (!Array.isArray(extensions)) fail('$.multi_subtitle.tracks', 'must be an array');
  const reservedTracks = new Set();
  extensions.forEach((track, index) => {
    if (!object(track)) fail(`$.multi_subtitle.tracks[${index}]`, 'must be an object');
    if (own(track, 'role') && track.role !== 'extension') fail(`$.multi_subtitle.tracks[${index}].role`, 'must be extension');
    if (own(track, 'id')) {
      const trackId = id(track.id);
      if (!trackId || reservedTracks.has(trackId)) fail(`$.multi_subtitle.tracks[${index}].id`, 'must be a unique track ID');
      reservedTracks.add(trackId);
    }
  });
  const usedTracks = new Set();
  const mainId = unique('main', reservedTracks, usedTracks); usedTracks.add(mainId);
  const main = { id: mainId, role: 'main', name: '主字幕', enabled: true, segments: project.segments };
  for (const field of SOURCE_FIELDS) if (own(project, field)) main[field] = project[field];
  if (own(multi, 'main_split_mode')) main.split_mode_override = multi.main_split_mode;
  const tracks = [main];
  if (own(project, 'overlay_track')) {
    const overlay = project.overlay_track;
    if (!object(overlay)) fail('$.overlay_track', 'must be an object');
    for (const field of ['id', 'role']) if (own(overlay, field)) fail(`$.overlay_track.${field}`, 'conflicts with canonical track field');
    const overlayId = unique('overlay', reservedTracks, usedTracks); usedTracks.add(overlayId);
    tracks.push({ ...overlay, id: overlayId, role: 'overlay', name: overlay.name ?? '叠加字幕', enabled: overlay.enabled ?? false, segments: overlay.segments ?? [] });
  }
  extensions.forEach((track, index) => {
    const trackId = id(track.id) || unique(`extension-${index + 1}`, reservedTracks, usedTracks);
    usedTracks.add(trackId);
    tracks.push({ ...track, id: trackId, role: 'extension', name: track.name ?? '副字幕', enabled: multi.enabled ?? false, segments: track.segments ?? [] });
  });
  const errors = [];
  const globalIds = new Set();
  tracks.forEach((track, index) => validateSegments(track.segments, `$.tracks[${index}].segments`, errors, globalIds, { legacy: raw.schema !== 'moy.asr.project.v2' }));
  if (errors.length) throw new ProjectTracksError(errors);
  const reservedCues = new Set(tracks.flatMap(track => track.segments.map(segment => id(segment.id))).filter(Boolean));
  const usedCues = new Set();
  const mappings = new Map();
  for (const track of tracks) {
    const mapping = new Map(); mappings.set(track.id, mapping);
    track.segments.forEach((segment, index) => {
      const oldId = id(segment.id);
      const nextId = oldId && !usedCues.has(oldId) ? oldId : unique(`${track.id}-cue-${index + 1}`, reservedCues, usedCues);
      if (oldId) mapping.set(oldId, nextId);
      segment.id = nextId; usedCues.add(nextId);
    });
  }
  if (raw.schema !== 'moy.asr.project.v2') {
    if (own(project, 'subtitle_groups')) fail('$.subtitle_groups', 'conflicts with legacy group fields');
    project.subtitle_groups = { next_id: 1, color: [], sticker: [] };
    for (const track of tracks) for (const kind of ['color', 'sticker']) {
      const heads = new Map();
      track.segments.forEach((segment, index) => {
        const value = segment[kind];
        if (value == null) return;
        if (!object(value) || typeof value.name !== 'string') fail(`$.tracks.${track.id}.segments[${index}].${kind}`, 'must contain a name');
        const groupId = unique(`${kind}-${track.id}-${index + 1}`, new Set(project.subtitle_groups[kind].map(group => group.id)));
        const attributes = clone(value); delete attributes.start; delete attributes.end;
        project.subtitle_groups[kind].push({ id: groupId, value: attributes }); heads.set(index, groupId);
      });
      track.segments.forEach((segment, index) => {
        const path = `$.tracks.${track.id}.segments[${index}]`;
        if (own(segment, `${kind}_group_id`)) fail(`${path}.${kind}_group_id`, 'conflicts with legacy group fields');
        const ref = segment[`${kind}_ref`];
        if (ref != null && (!object(ref) || segment[kind] != null || !integer(ref.headIdx) || ref.headIdx >= index || !heads.has(ref.headIdx))) fail(`${path}.${kind}_ref`, 'must reference a preceding group head');
        const groupId = ref != null ? heads.get(ref.headIdx) : heads.get(index);
        if (groupId) segment[`${kind}_group_id`] = groupId;
        if (ref != null) {
          const metadata = Object.fromEntries(Object.entries(ref).filter(([key]) => !['headIdx', 'name'].includes(key)));
          if (Object.keys(metadata).length) {
            if (own(segment, `${kind}_group_metadata`)) fail(`${path}.${kind}_group_metadata`, 'migration metadata conflict');
            segment[`${kind}_group_metadata`] = metadata;
          }
        }
        delete segment[kind]; delete segment[`${kind}_ref`];
      });
    }
  }
  const bilingual = Object.fromEntries(Object.entries(multi).filter(([key]) => !['schema', 'enabled', 'tracks', 'bindings', 'main_split_mode'].includes(key)));
  bilingual.display_mode ??= 'both';
  const extensionTracks = tracks.filter(track => track.role === 'extension');
  if (!own(bilingual, 'active_track_id') && extensionTracks.length) bilingual.active_track_id = extensionTracks[0].id;
  const oldBindings = multi.bindings ?? [];
  if (!Array.isArray(oldBindings)) fail('$.multi_subtitle.bindings', 'must be an array');
  const bindingIds = new Set(oldBindings.map(binding => id(binding?.id)).filter(Boolean));
  const usedBindings = new Set();
  const bindings = oldBindings.map((binding, index) => {
    const path = `$.multi_subtitle.bindings[${index}]`;
    if (!object(binding)) fail(path, 'must be an object');
    for (const field of ['source_track_id', 'target_track_id', 'source_segment_ids', 'target_segment_ids']) if (own(binding, field)) fail(`${path}.${field}`, 'conflicts with canonical binding field');
    let bindingId = id(binding.id);
    if (own(binding, 'id') && (!bindingId || usedBindings.has(bindingId))) fail(`${path}.id`, 'must be a unique binding ID');
    if (!bindingId) bindingId = unique(`binding-${index + 1}`, bindingIds, usedBindings);
    usedBindings.add(bindingId);
    const targetId = binding.track_id ?? (extensionTracks.length === 1 ? extensionTracks[0].id : null);
    const target = extensionTracks.find(track => track.id === targetId);
    if (!target) fail(`${path}.track_id`, 'must reference an extension track');
    const endpoints = (plural, singular, trackId) => {
      const values = binding[plural] ?? (own(binding, singular) ? [binding[singular]] : []);
      if (!Array.isArray(values)) fail(`${path}.${plural}`, 'must be an array');
      return values.map(value => mappings.get(trackId)?.get(id(value)) ?? value);
    };
    const sourceIds = endpoints('main_segment_ids', 'main_segment_id', main.id);
    const targetIds = endpoints('extension_segment_ids', 'extension_segment_id', target.id);
    const sourceCue = main.segments.find(segment => segment.id === sourceIds[0]);
    const targetCue = target.segments.find(segment => segment.id === targetIds[0]);
    const out = { ...binding, id: bindingId, source_track_id: main.id, target_track_id: target.id,
      source_segment_ids: sourceIds, target_segment_ids: targetIds,
      start_offset_ms: binding.start_offset_ms ?? (targetCue?.start - sourceCue?.start),
      end_offset_ms: binding.end_offset_ms ?? (targetCue?.end - sourceCue?.end) };
    for (const key of ['track_id', 'main_segment_ids', 'main_segment_id', 'extension_segment_ids', 'extension_segment_id']) delete out[key];
    return out;
  });
  for (const field of OLD_FIELDS) delete project[field];
  Object.assign(project, { schema: PROJECT_TRACKS_SCHEMA, tracks, bilingual, bindings });
  return project;
}

export function importProject(raw) {
  if (!object(raw)) fail('$', 'must be an object');
  if (own(raw, 'schema') && raw.schema !== PROJECT_TRACKS_SCHEMA && !LEGACY_SCHEMAS.has(raw.schema)) fail('$.schema', 'unsupported project schema');
  const project = raw.schema === PROJECT_TRACKS_SCHEMA ? clone(raw) : migrateLegacy(raw);
  const result = validateTracksProject(project);
  if (!result.ok) throw new ProjectTracksError(result.errors);
  return { project, changes: changesBetween(raw, project) };
}
export function migrateProjectTracks(raw) { return importProject(raw).project; }
export function snapshotProjectContent(project) {
  const snapshot = clone(project);
  for (const field of CACHE_FIELDS) delete snapshot[field];
  for (const segment of iterSegments(snapshot)) delete segment._dirty;
  return snapshot;
}
export function selectSubtitleTracks(project, { subtitleTracks = 'main', includeOverlay = true } = {}) {
  const main = getMainTrack(project);
  const overlay = getOverlayTrack(project);
  const extension = getExtensionTrack(project);
  const selections = {
    main: [main, ...(includeOverlay ? [overlay] : [])], overlay: [overlay], extension: [extension],
    main_and_extension: [main, ...(includeOverlay ? [overlay] : []), extension], all: [main, overlay, extension],
  };
  if (!own(selections, subtitleTracks)) throw new Error('Unknown subtitle track selection');
  return selections[subtitleTracks].filter(track => track?.enabled === true);
}
export function createUtilsModule() {
  return Object.freeze({ PROJECT_TRACKS_SCHEMA, ProjectTracksError, importProject, migrateProjectTracks,
    validateTracksProject, getTrack, getTracksByRole, getMainTrack, getExtensionTrack, getOverlayTrack,
    projectTracks, iterSegments, snapshotProjectContent, selectSubtitleTracks });
}

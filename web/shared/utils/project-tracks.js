// The only project-level subtitle model. Legacy containers are accepted solely
// by importProject; consumers receive track entities from one canonical tree.
export function createUtilsModule() {
  const PROJECT_TRACKS_SCHEMA = 'moy.asr.project.v3';
  const GROUP_SCHEMAS = new Set(['moy.asr.project.v1.5', 'moy.asr.project.v2']);
  const LEGACY_SCHEMAS = new Set(['moy.asr.project.v1', ...GROUP_SCHEMAS]);
  const ROLES = new Set(['main', 'extension', 'overlay']);
  const SOURCE_FIELDS = ['language', 'language_source', 'split_mode', 'timestamp_granularity',
    'model', 'preserve_punctuation', 'source_name'];
  const OLD_FIELDS = ['segments', 'overlay_track', 'multi_subtitle', ...SOURCE_FIELDS];
  const CACHE_FIELDS = ['waveform', 'spectral', 'waveform_reapeaks', 'loudness'];
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const id = value => typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= 160
    ? value.trim() : null;
  const integer = value => Number.isSafeInteger(value);

  class ProjectTracksError extends Error {
    constructor(errors) {
      super(errors.map(error => `${error.path}: ${error.message}`).join('; '));
      this.name = 'ProjectTracksError';
      this.errors = errors;
    }
  }

  function fail(path, message) { throw new ProjectTracksError([{ path, message }]); }
  function unique(base, reserved, used = new Set()) {
    base = Array.from(base).slice(0, 150).join('');
    let candidate = base;
    let suffix = 2;
    while (reserved.has(candidate) || used.has(candidate)) candidate = `${base}-${suffix++}`;
    return candidate;
  }
  function getTrack(project, trackId) {
    return projectTracks(project).find(track => track?.id === trackId) || null;
  }
  function getTracksByRole(project, role) {
    return projectTracks(project).filter(track => track?.role === role);
  }
  function getMainTrack(project) { return getTracksByRole(project, 'main')[0] || null; }
  function getExtensionTrack(project, trackId = project?.bilingual?.active_track_id) {
    return trackId ? getTracksByRole(project, 'extension').find(track => track.id === trackId) || null
      : getTracksByRole(project, 'extension')[0] || null;
  }
  function getOverlayTrack(project) { return getTracksByRole(project, 'overlay')[0] || null; }
  function projectTracks(project) { return Array.isArray(project?.tracks) ? project.tracks : []; }
  function* iterSegments(project) {
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
      if (own(segment, 'speaker') && (typeof segment.speaker !== 'string' || !segment.speaker.trim())) add(`${field}.speaker`, 'must be a non-empty string');
      if (own(segment, 'start_frame') !== own(segment, 'end_frame')) add(`${field}.start_frame`, 'start_frame and end_frame must appear together');
      for (const frame of ['start_frame', 'end_frame']) if (own(segment, frame) && (!integer(segment[frame]) || segment[frame] < 0)) add(`${field}.${frame}`, 'must be a non-negative integer');
      if (own(segment, 'start_frame') && own(segment, 'end_frame') && segment.end_frame <= segment.start_frame) add(`${field}.end_frame`, 'must be greater than start_frame');
      if (own(segment, 'assOverride')) {
        const override = segment.assOverride;
        if (!object(override)) add(`${field}.assOverride`, 'must be an object');
        else {
          if (own(override, 'an')) add(`${field}.assOverride.an`, 'unsupported ASS alignment override');
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
          if (own(item, 'start_frame') !== own(item, 'end_frame')) add(`${itemPath}.start_frame`, 'start_frame and end_frame must appear together');
          for (const frame of ['start_frame', 'end_frame']) if (own(item, frame) && (!integer(item[frame]) || item[frame] < 0)) add(`${itemPath}.${frame}`, 'must be a non-negative integer');
          if (own(item, 'start_frame') && own(item, 'end_frame') && item.end_frame <= item.start_frame) add(`${itemPath}.end_frame`, 'must be greater than start_frame');
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

  // Existing project-level metadata rules stay at the same boundary as tracks.
  // These checks mirror project.py/project_preview.py and never normalize data.
  function validateProjectMetadata(project, errors) {
    const number = value => typeof value === 'number' && Number.isFinite(value);
    const string = value => typeof value === 'string';
    const bool = value => typeof value === 'boolean';
    const add = (path, message) => errors.push({ path, message });
    const optional = (value, path, key, check, message) => {
      if (own(value, key) && !check(value[key])) add(`${path}.${key}`, message);
    };
    const fps = (value, path) => {
      if (!number(value)) add(path, 'must be a finite number');
      else if (value < 1 || value > 240) add(path, 'must be between 1 and 240');
    };
    if (own(project, 'timed_text_edit_view') && !['rows', 'single'].includes(project.timed_text_edit_view)) add('$.timed_text_edit_view', 'must be rows or single');
    if (own(project, 'timebase')) {
      const value = project.timebase;
      if (!object(value)) add('$.timebase', 'must be an object');
      else {
        if (!['milliseconds', 'frames'].includes(value.unit)) add('$.timebase.unit', 'must be milliseconds or frames');
        fps(value.fps, '$.timebase.fps');
        optional(value, '$.timebase', 'fps_source', source => ['auto', 'user'].includes(source), 'must be auto or user');
      }
    }
    if (own(project, 'media_metadata')) {
      const value = project.media_metadata; const path = '$.media_metadata';
      if (!object(value)) add(path, 'must be an object');
      else {
        if (own(value, 'video_width') !== own(value, 'video_height')) add(`${path}.${own(value, 'video_width') ? 'video_height' : 'video_width'}`, 'video dimensions must be provided together');
        for (const field of ['video_width', 'video_height']) optional(value, path, field, item => Number.isInteger(item) && item > 0, 'must be a positive integer');
        if (own(value, 'video_fps')) fps(value.video_fps, `${path}.video_fps`);
        optional(value, path, 'video_fps_ratio', item => string(item) && !!item.trim(), 'must be a non-empty string');
        optional(value, path, 'selected_audio_track', item => Number.isInteger(item) && item >= 0, 'must be a non-negative integer');
        if (own(value, 'audio_tracks')) {
          if (!Array.isArray(value.audio_tracks)) add(`${path}.audio_tracks`, 'must be an array');
          else value.audio_tracks.forEach((track, index) => {
            const target = `${path}.audio_tracks[${index}]`;
            if (!object(track)) { add(target, 'must be an object'); return; }
            if (!Number.isInteger(track.stream_index) || track.stream_index < 0) add(`${target}.stream_index`, 'must be a non-negative integer');
            if (track.audio_index != null && (!Number.isInteger(track.audio_index) || track.audio_index < 0)) add(`${target}.audio_index`, 'must be a non-negative integer');
            for (const field of ['codec', 'language', 'title']) optional(track, target, field, string, 'must be a string');
            for (const field of ['channels', 'sample_rate']) if (track[field] != null && (!Number.isInteger(track[field]) || track[field] <= 0)) add(`${target}.${field}`, 'must be a positive integer or null');
            optional(track, target, 'default', bool, 'must be a boolean');
          });
        }
      }
    }
    const preview = project.preview;
    if (preview == null) return;
    if (!object(preview)) { add('$.preview', 'must be an object or null'); return; }
    optional(preview, '$.preview', 'ass_mode', bool, 'must be a boolean');
    const label = (value, max) => string(value) && Array.from(value).length <= max && !/[\x00-\x1f\x7f]/u.test(value);
    for (const key of ['subtitle', 'extension_subtitle']) {
      const style = preview[key]; const path = `$.preview.${key}`;
      if (style == null) continue;
      if (!object(style)) { add(path, 'must be an object or null'); continue; }
      if (key === 'subtitle') {
        const fields = ['x', 'y', 'width', 'height'];
        for (const field of fields) if (!number(style[field]) || style[field] < 0 || style[field] > 1) add(`${path}.${field}`, 'must be a number in [0, 1]');
        if (fields.every(field => number(style[field]) && style[field] >= 0 && style[field] <= 1)) {
          if (style.x + style.width > 1) add(path, 'x + width must be <= 1');
          if (style.y + style.height > 1) add(path, 'y + height must be <= 1');
        }
        const labels = style.speaker_labels; const target = `${path}.speaker_labels`;
        if (labels != null) {
          if (!object(labels)) add(target, 'must be an object or null');
          else {
            for (const field of ['mapping_enabled', 'enabled', 'export_enabled']) optional(labels, target, field, bool, 'must be a boolean');
            optional(labels, target, 'separator', value => label(value, 16), 'must be a string up to 16 characters without control characters');
            if (labels.names != null) {
              if (!object(labels.names)) add(`${target}.names`, 'must be an object or null');
              else for (const color of ['yellow', 'green', 'red', 'purple', 'blue']) optional(labels.names, `${target}.names`, color, value => label(value, 64), 'must be a string up to 64 characters without control characters');
            }
          }
        }
      }
      optional(style, path, 'font_size', value => number(value) && value >= 12 && value <= 96, 'must be a number in [12, 96]');
      optional(style, path, 'background_alpha', value => number(value) && value >= 0 && value <= 1, 'must be a number in [0, 1]');
      optional(style, path, 'font_family', value => string(value) && !!value && value === value.trim() && label(value, 128), 'must be a valid font family name');
      for (const field of ['background_color', 'color']) optional(style, path, field, value => string(value) && /^#[0-9a-f]{6}$/i.test(value), 'must be a six-digit hexadecimal color');
      optional(style, path, 'color_style', value => ['underline', 'text', 'shadow', 'stroke'].includes(value), 'must be underline, text, shadow or stroke');
      optional(style, path, 'ass_color_style', value => ['text', 'speaker', 'stroke', 'none'].includes(value), 'must be text, speaker, stroke or none');
    }
  }

  function validateTrackMetadata(track, path, errors) {
    const add = (field, message) => errors.push({ path: `${path}.${field}`, message });
    for (const field of SOURCE_FIELDS.filter(field => field !== 'preserve_punctuation')) if (own(track, field) && typeof track[field] !== 'string') add(field, 'must be a string');
    for (const field of ['split_mode', 'split_mode_override']) if (own(track, field) && !['continuous', 'word'].includes(track[field])) add(field, 'must be continuous or word');
    if (own(track, 'language_source') && !['detected', 'hint', 'inferred', 'unknown'].includes(track.language_source)) add('language_source', 'unsupported language source');
    if (own(track, 'timestamp_granularity') && !['char', 'word', 'segment', 'unknown'].includes(track.timestamp_granularity)) add('timestamp_granularity', 'unsupported timestamp granularity');
    if (own(track, 'preserve_punctuation') && typeof track.preserve_punctuation !== 'boolean') add('preserve_punctuation', 'must be a boolean');
    if (own(track, 'metadata') && !object(track.metadata)) add('metadata', 'must be an object');
  }

  function validateTracksProject(project) {
    const errors = [];
    const add = (path, message) => errors.push({ path, message });
    if (!object(project)) return { ok: false, errors: [{ path: '$', message: 'must be an object' }], project: null };
    if (project.schema !== PROJECT_TRACKS_SCHEMA) add('$.schema', `must be ${PROJECT_TRACKS_SCHEMA}`);
    validateProjectMetadata(project, errors);
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
      validateTrackMetadata(track, path, errors);
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
      const sourceKey = JSON.stringify([binding.target_track_id, binding.source_segment_ids?.[0]]);
      const targetKey = JSON.stringify([binding.target_track_id, binding.target_segment_ids?.[0]]);
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

  // Legacy writers could omit IDs while referring to the old per-track
  // normalizer's deterministic IDs. These aliases exist only during import.
  function legacyNormalizedIds(values, prefix) {
    const reserved = new Set(values.filter(value => own(value, 'id')).map(value => id(value.id)));
    const used = new Set();
    return values.map((value, index) => {
      let identifier = id(value.id);
      if (!own(value, 'id')) {
        const base = `${prefix}-${String(index + 1).padStart(3, '0')}`;
        identifier = base;
        let suffix = 2;
        while (used.has(identifier) || (identifier !== base && reserved.has(identifier))) identifier = `${base}-${suffix++}`;
        if (reserved.has(identifier)) {
          identifier = `${base}-generated`;
          suffix = 2;
          while (used.has(identifier) || reserved.has(identifier)) identifier = `${base}-generated-${suffix++}`;
        }
      }
      used.add(identifier);
      return identifier;
    });
  }

  function validateLegacyGroups(track, errors) {
    if (!Array.isArray(track.segments)) return;
    const add = (path, message) => errors.push({ path, message });
    for (const kind of ['color', 'sticker']) track.segments.forEach((segment, index) => {
      if (!object(segment)) return;
      const path = `$.tracks.${track.id}.segments[${index}]`;
      if (own(segment, `${kind}_group_id`)) add(`${path}.${kind}_group_id`, 'conflicts with legacy group fields');
      const value = segment[kind];
      if (value != null) {
        if (!object(value) || typeof value.name !== 'string') add(`${path}.${kind}`, 'must contain a name');
        else if (!value.name.trim()) add(`${path}.${kind}.name`, 'must be a non-empty string');
        if (object(value)) {
          for (const edge of ['start', 'end']) if (own(value, edge) && !integer(value[edge])) add(`${path}.${kind}.${edge}`, 'must be integer milliseconds');
          if (integer(value.start) && integer(value.end) && value.end < value.start) add(`${path}.${kind}.end`, 'must be >= start');
        }
      }
      const ref = segment[`${kind}_ref`];
      if (ref == null) return;
      const head = object(ref) && integer(ref.headIdx) && ref.headIdx >= 0 && ref.headIdx < index
        ? track.segments[ref.headIdx]?.[kind] : null;
      if (!object(ref) || value != null || !object(head)) add(`${path}.${kind}_ref`, 'must reference a preceding group head');
      else if (typeof ref.name === 'string' && ref.name !== head.name) add(`${path}.${kind}_ref.name`, 'must match referenced head name');
    });
  }

  function migrateLegacy(raw) {
    const project = clone(raw);
    for (const field of ['tracks', 'bindings', 'bilingual']) if (own(project, field)) fail(`$.${field}`, 'conflicts with legacy project structure');
    if (!Array.isArray(project.segments)) fail('$.segments', 'must be an array');
    const multi = project.multi_subtitle ?? {};
    if (!object(multi)) fail('$.multi_subtitle', 'must be an object');
    if (multi.schema != null && multi.schema !== 'moy.asr.multi_subtitle.v1') fail('$.multi_subtitle.schema', 'unsupported multi-subtitle schema');
    if (multi.enabled != null && typeof multi.enabled !== 'boolean') fail('$.multi_subtitle.enabled', 'must be a boolean');
    if (multi.display_mode != null && !['main', 'extension', 'both'].includes(multi.display_mode)) fail('$.multi_subtitle.display_mode', 'must be main, extension or both');
    if (multi.main_split_mode != null && !['continuous', 'word'].includes(multi.main_split_mode)) fail('$.multi_subtitle.main_split_mode', 'must be continuous or word');
    const extensions = multi.tracks ?? [];
    if (!Array.isArray(extensions)) fail('$.multi_subtitle.tracks', 'must be an array');
    const reservedTracks = new Set();
    extensions.forEach((track, index) => {
      if (!object(track)) fail(`$.multi_subtitle.tracks[${index}]`, 'must be an object');
      if (track.role != null && track.role !== 'extension') fail(`$.multi_subtitle.tracks[${index}].role`, 'must be extension');
      if (own(track, 'enabled') && track.enabled !== (multi.enabled ?? false)) fail(`$.multi_subtitle.tracks[${index}].enabled`, 'migration metadata conflict');
      for (const field of ['name', 'language', 'source_name']) if (own(track, field) && typeof track[field] !== 'string') fail(`$.multi_subtitle.tracks[${index}].${field}`, 'must be a string');
      if (own(track, 'id')) {
        const trackId = id(track.id);
        if (!trackId || reservedTracks.has(trackId)) fail(`$.multi_subtitle.tracks[${index}].id`, 'must be a unique track ID');
        reservedTracks.add(trackId);
      }
    });
    const oldExtensionIds = legacyNormalizedIds(extensions, 'extension');
    const trackAliases = new Map();
    const oldTrackIds = new Map();
    const usedTracks = new Set();
    const mainId = unique('main', reservedTracks, usedTracks); usedTracks.add(mainId);
    const main = { id: mainId, role: 'main', name: '主字幕', enabled: true, segments: project.segments };
    for (const field of SOURCE_FIELDS) if (own(project, field)) main[field] = project[field];
    if (multi.main_split_mode != null) main.split_mode_override = multi.main_split_mode;
    const tracks = [main];
    if (project.overlay_track != null) {
      const overlay = project.overlay_track;
      if (!object(overlay)) fail('$.overlay_track', 'must be an object');
      for (const field of ['id', 'role']) if (own(overlay, field)) fail(`$.overlay_track.${field}`, 'conflicts with canonical track field');
      const overlayId = unique('overlay', reservedTracks, usedTracks); usedTracks.add(overlayId);
      tracks.push({ ...overlay, id: overlayId, role: 'overlay', name: own(overlay, 'name') ? overlay.name : '叠加字幕', enabled: overlay.enabled ?? false, segments: overlay.segments ?? [] });
    }
    extensions.forEach((track, index) => {
      const trackId = id(track.id) || unique(`extension-${index + 1}`, reservedTracks, usedTracks);
      usedTracks.add(trackId);
      trackAliases.set(oldExtensionIds[index], trackId);
      oldTrackIds.set(trackId, oldExtensionIds[index]);
      tracks.push({ ...track, id: trackId, role: 'extension', name: own(track, 'name') ? track.name : '副字幕', enabled: multi.enabled ?? false, split_mode: track.split_mode ?? 'word', segments: track.segments ?? [] });
    });
    const errors = [];
    const globalIds = new Set();
    if (GROUP_SCHEMAS.has(raw.schema)) {
      const ids = new Set();
      tracks.forEach((track, index) => (Array.isArray(track.segments) ? track.segments : []).forEach((segment, cueIndex) => {
        if (!object(segment)) return;
        const cueId = id(segment.id);
        if (!cueId || ids.has(cueId)) fail(`$.tracks[${index}].segments[${cueIndex}].id`, 'v2 requires unique project-wide cue IDs');
        ids.add(cueId); segment.id = cueId;
      }));
    }
    validateProjectMetadata(project, errors);
    tracks.forEach((track, index) => {
      validateTrackMetadata(track, `$.tracks[${index}]`, errors);
      validateSegments(track.segments, `$.tracks[${index}].segments`, errors, globalIds, { legacy: true });
      if (!GROUP_SCHEMAS.has(raw.schema)) validateLegacyGroups(track, errors);
    });
    if (multi.bindings != null && !Array.isArray(multi.bindings)) errors.push({ path: '$.multi_subtitle.bindings', message: 'must be an array' });
    (Array.isArray(multi.bindings) ? multi.bindings : []).forEach((binding, index) => {
      const path = `$.multi_subtitle.bindings[${index}]`;
      if (!object(binding)) { errors.push({ path, message: 'must be an object' }); return; }
      for (const field of ['main_segment_ids', 'extension_segment_ids']) {
        const values = binding[field] ?? (own(binding, field.slice(0, -1)) ? [binding[field.slice(0, -1)]] : null);
        if (!Array.isArray(values) || values.length !== 1) errors.push({ path: `${path}.${field}`, message: 'must contain exactly one stable ID' });
      }
    });
    if (errors.length) throw new ProjectTracksError(errors.map(error => {
      // Legacy ASS diagnostics retain their public input paths. Canonical
      // validation continues to identify tracks directly.
      if (!error.path.includes('.assOverride')) return error;
      const match = /^\$\.tracks\[(\d+)\]/u.exec(error.path);
      if (!match) return error;
      const trackIndex = Number(match[1]);
      const track = tracks[trackIndex];
      const inputPath = track.role === 'main' ? '$' : track.role === 'overlay' ? '$.overlay_track'
        : `$.multi_subtitle.tracks[${trackIndex - tracks.filter(entry => entry.role !== 'extension').length}]`;
      return { ...error, path: inputPath + error.path.slice(match[0].length) };
    }));
    for (const track of tracks) for (const segment of track.segments) {
      const override = segment.assOverride;
      if (!object(override)) continue;
      if (own(override, 'scale')) {
        override.scale = Number(override.scale.toFixed(2));
        if (override.scale === 1) delete override.scale;
      }
      if (!Object.keys(override).length) delete segment.assOverride;
    }
    const reservedCues = new Set(tracks.flatMap(track => track.segments.map(segment => id(segment.id))).filter(Boolean));
    const usedCues = new Set();
    const mappings = new Map();
    for (const track of tracks) {
      const mapping = new Map(); mappings.set(track.id, mapping);
      const prefix = track.role === 'extension' ? `${oldTrackIds.get(track.id)}-segment` : track.role;
      const oldIds = legacyNormalizedIds(track.segments, prefix);
      track.segments.forEach((segment, index) => {
        const oldId = id(segment.id);
        const nextId = oldId && !usedCues.has(oldId) ? oldId : unique(`${track.id}-cue-${index + 1}`, reservedCues, usedCues);
        mapping.set(oldIds[index], nextId);
        segment.id = nextId; usedCues.add(nextId);
      });
    }
    if (!GROUP_SCHEMAS.has(raw.schema)) {
      if (own(project, 'subtitle_groups')) fail('$.subtitle_groups', 'conflicts with legacy group fields');
      project.subtitle_groups = { next_id: 1, color: [], sticker: [] };
      for (const track of tracks) for (const kind of ['color', 'sticker']) {
        const heads = new Map();
        track.segments.forEach((segment, index) => {
          const value = segment[kind];
          if (value == null) return;
          if (!object(value) || typeof value.name !== 'string') fail(`$.tracks.${track.id}.segments[${index}].${kind}`, 'must contain a name');
          if (!value.name.trim()) fail(`$.tracks.${track.id}.segments[${index}].${kind}.name`, 'must be a non-empty string');
          for (const edge of ['start', 'end']) if (own(value, edge) && !integer(value[edge])) fail(`$.tracks.${track.id}.segments[${index}].${kind}.${edge}`, 'must be integer milliseconds');
          if (integer(value.start) && integer(value.end) && value.end < value.start) fail(`$.tracks.${track.id}.segments[${index}].${kind}.end`, 'must be >= start');
          const groupId = unique(`${kind}-${track.id}-${index + 1}`, new Set(project.subtitle_groups[kind].map(group => group.id)));
          const attributes = clone(value); delete attributes.start; delete attributes.end;
          project.subtitle_groups[kind].push({ id: groupId, value: attributes }); heads.set(index, groupId);
        });
        track.segments.forEach((segment, index) => {
          const path = `$.tracks.${track.id}.segments[${index}]`;
          if (own(segment, `${kind}_group_id`)) fail(`${path}.${kind}_group_id`, 'conflicts with legacy group fields');
          const ref = segment[`${kind}_ref`];
          if (ref != null && (!object(ref) || segment[kind] != null || !integer(ref.headIdx) || ref.headIdx >= index || !heads.has(ref.headIdx))) fail(`${path}.${kind}_ref`, 'must reference a preceding group head');
          if (ref != null && typeof ref.name === 'string'
              && ref.name !== project.subtitle_groups[kind].find(group => group.id === heads.get(ref.headIdx)).value.name) fail(`${path}.${kind}_ref.name`, 'must match referenced head name');
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
    else if (typeof bilingual.active_track_id === 'string') bilingual.active_track_id = trackAliases.get(bilingual.active_track_id.trim()) ?? bilingual.active_track_id;
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
      const oldTargetId = id(binding.track_id);
      const targetId = binding.track_id == null ? (extensionTracks.length === 1 ? extensionTracks[0].id : null) : (trackAliases.get(oldTargetId) ?? oldTargetId);
      const target = extensionTracks.find(track => track.id === targetId);
      if (!target) fail(`${path}.track_id`, 'must reference an extension track');
      const endpoints = (plural, singular, trackId) => {
        if (binding[plural] != null && own(binding, singular) && (!Array.isArray(binding[plural]) || binding[plural].length !== 1 || id(binding[plural][0]) !== id(binding[singular]))) fail(`${path}.${singular}`, 'conflicts with plural endpoint');
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

  function importProject(raw) {
    if (!object(raw)) fail('$', 'must be an object');
    if (own(raw, 'schema') && raw.schema !== PROJECT_TRACKS_SCHEMA && !LEGACY_SCHEMAS.has(raw.schema)) fail('$.schema', 'unsupported project schema');
    const project = raw.schema === PROJECT_TRACKS_SCHEMA ? clone(raw) : migrateLegacy(raw);
    const result = validateTracksProject(project);
    if (!result.ok) throw new ProjectTracksError(result.errors);
    return { project, changes: changesBetween(raw, project) };
  }
  function migrateProjectTracks(raw) { return importProject(raw).project; }
  // Producers create v3 directly; only this constructor and legacy import may
  // generate omitted cue identities. Strict reads/saves never generate them.
  function makeProject(segments, { mainFields = {}, projectFields = {} } = {}) {
    if (!object(mainFields)) fail('$.tracks[0]', 'main fields must be an object');
    if (!object(projectFields)) fail('$', 'project fields must be an object');
    if (!Array.isArray(segments)) fail('$.tracks[0].segments', 'must be an array');
    for (const field of ['schema', 'tracks']) if (own(projectFields, field)) fail(`$.${field}`, 'is owned by the project factory');
    if (own(mainFields, 'segments')) fail('$.tracks[0].segments', 'pass segments to the project factory directly');
    const project = clone(projectFields); const main = clone(mainFields);
    for (const [field, value] of Object.entries({ id: 'main', name: '主字幕', role: 'main', enabled: true })) if (!own(main, field)) main[field] = value;
    main.segments = clone(segments);
    const reserved = new Set();
    main.segments.forEach((segment, index) => {
      const path = `$.tracks[0].segments[${index}]`;
      if (!object(segment)) fail(path, 'must be an object');
      if (own(segment, 'id')) {
        const cueId = id(segment.id);
        if (!cueId || cueId !== segment.id || reserved.has(cueId)) fail(`${path}.id`, 'must be a unique canonical cue ID');
        reserved.add(cueId);
      }
    });
    main.segments.forEach((segment, index) => {
      if (!own(segment, 'id')) { segment.id = unique(`${main.id}-cue-${index + 1}`, reserved); reserved.add(segment.id); }
    });
    Object.assign(project, { schema: PROJECT_TRACKS_SCHEMA, tracks: [main] });
    for (const [field, value] of Object.entries({ bindings: [], bilingual: { display_mode: 'both' }, subtitle_groups: { next_id: 1, color: [], sticker: [] } })) if (!own(project, field)) project[field] = value;
    const result = validateTracksProject(project);
    if (!result.ok) throw new ProjectTracksError(result.errors);
    return project;
  }
  function snapshotProjectContent(project) {
    const snapshot = clone(project);
    for (const field of CACHE_FIELDS) delete snapshot[field];
    delete snapshot._dirty;
    for (const track of projectTracks(snapshot)) delete track._dirty;
    for (const segment of iterSegments(snapshot)) {
      delete segment._dirty;
      if (segment.items === null) delete segment.items;
    }
    return snapshot;
  }
  function selectSubtitleTracks(project, { subtitleTracks = 'main', includeOverlay = true } = {}) {
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
  return Object.freeze({ PROJECT_TRACKS_SCHEMA, ProjectTracksError, importProject, migrateProjectTracks, makeProject,
    validateTracksProject, getTrack, getTracksByRole, getMainTrack, getExtensionTrack, getOverlayTrack,
    projectTracks, iterSegments, snapshotProjectContent, selectSubtitleTracks });
}

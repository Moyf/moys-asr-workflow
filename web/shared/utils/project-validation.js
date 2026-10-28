// Legacy project boundary. Keep acceptance/defaults aligned with maw/project.py
// through tests/fixtures/project-boundary.json; never normalize before validation.
(function (global) {
  'use strict';
  const SCHEMA = 'moy.asr.project.v1';
  const GROUP_SCHEMA = 'moy.asr.project.v1.5';
  const MULTI = 'moy.asr.multi_subtitle.v1';
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const integer = Number.isInteger;
  const number = (v) => typeof v === 'number' && Number.isFinite(v);
  const id = (v) => typeof v === 'string' && v.trim().length > 0 && Array.from(v.trim()).length <= 160;
  const clone = (v) => JSON.parse(JSON.stringify(v));

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

function validateSubtitleGroups(project, report = (_path, _message) => {}) {
  const errors = [];
  const error = (path, message) => {
    errors.push({ path, message });
    report(path, message);
  };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validId = value => typeof value === 'string'
    && value.trim().length > 0 && Array.from(value).length <= 160;
  const table = project?.subtitle_groups;
  if (!object(table)) {
    error('$.subtitle_groups', 'must be an object');
    return errors;
  }
  if (Object.hasOwn(table, 'next_id')
      && (!Number.isSafeInteger(table.next_id) || table.next_id < 1)) {
    error('$.subtitle_groups.next_id', 'must be a positive safe integer');
  }

  const tracks = [['$.segments', project?.segments]];
  if (object(project?.overlay_track)) {
    tracks.push(['$.overlay_track.segments', project.overlay_track.segments]);
  }
  const multi = project?.multi_subtitle;
  if (object(multi) && Array.isArray(multi.tracks)) {
    multi.tracks.forEach((track, index) => {
      if (object(track)) tracks.push([`$.multi_subtitle.tracks[${index}].segments`, track.segments]);
    });
  }
  const lists = tracks.filter(([, segments]) => Array.isArray(segments));
  const cueIds = new Set();
  for (const [path, segments] of lists) {
    segments.forEach((segment, index) => {
      if (!object(segment)) return; // Existing segment validator reports this.
      const identifier = segment.id;
      // Per-track normalization trims IDs after this check.
      const canonical = typeof identifier === 'string' ? identifier.trim() : identifier;
      if (!validId(identifier) || cueIds.has(canonical)) {
        error(`${path}[${index}].id`, 'must be a unique project-wide cue ID');
      } else {
        cueIds.add(canonical);
      }
    });
  }

  for (const kind of ['color', 'sticker']) {
    const groups = table[kind];
    if (!Array.isArray(groups)) {
      error(`$.subtitle_groups.${kind}`, 'must be an array');
      continue; // Mirrors the Python validator: skip this kind's cue checks.
    }
    const groupIds = new Set();
    groups.forEach((group, index) => {
      const path = `$.subtitle_groups.${kind}[${index}]`;
      if (!object(group)) {
        error(path, 'must be an object');
        return;
      }
      const identifier = group.id;
      if (!validId(identifier) || groupIds.has(identifier)) {
        error(`${path}.id`, 'must be a unique non-empty group ID');
      } else {
        groupIds.add(identifier);
      }
      const value = group.value;
      if (!object(value) || typeof value.name !== 'string') {
        error(`${path}.value`, 'must contain a name');
      } else if (Object.hasOwn(value, 'start') || Object.hasOwn(value, 'end')) {
        error(`${path}.value`, 'group range is derived from members');
      }
    });
    for (const [path, segments] of lists) {
      segments.forEach((segment, index) => {
        if (!object(segment)) return;
        const field = `${kind}_group_id`;
        if (Object.hasOwn(segment, field)
            && (typeof segment[field] !== 'string' || !groupIds.has(segment[field]))) {
          error(`${path}[${index}].${field}`, 'must reference an existing group');
        }
        if (Object.hasOwn(segment, kind) || Object.hasOwn(segment, `${kind}_ref`)) {
          error(`${path}[${index}].${kind}`, 'legacy group fields are not allowed in v1.5');
        }
      });
    }
  }
  return errors;
}


  function validateProject(input) {
    const errors = [];
    const error = (path, message) => errors.push({ path, message });
    const optional = (value, path, key, check, message) => {
      if (Object.hasOwn(value, key) && !check(value[key])) error(`${path}.${key}`, message);
    };
    const bool = (v) => typeof v === 'boolean';
    const string = (v) => typeof v === 'string';
    function ids(values, prefix, path) {
      const reserved = new Set(values.filter(object).map((v) => v.id).filter(id).map((v) => v.trim()));
      const used = new Set();
      values.forEach((v, i) => {
        if (!object(v)) return;
        if (!Object.hasOwn(v, 'id')) {
          const base = `${prefix}-${String(i + 1).padStart(3, '0')}`;
          let candidate = base, suffix = 2;
          while (used.has(candidate) || (reserved.has(candidate) && candidate !== base)) candidate = `${base}-${suffix++}`;
          if (reserved.has(candidate)) {
            candidate = `${base}-generated`; suffix = 2;
            while (used.has(candidate) || reserved.has(candidate)) candidate = `${base}-generated-${suffix++}`;
          }
          v.id = candidate;
        } else if (!id(v.id)) {
          error(`${path}[${i}].id`, 'must be a non-empty string of at most 160 characters'); return;
        } else v.id = v.id.trim();
        if (used.has(v.id)) error(`${path}[${i}].id`, 'must be unique within its collection');
        used.add(v.id);
      });
    }
    function frames(v, path) {
      const a = Object.hasOwn(v, 'start_frame'), b = Object.hasOwn(v, 'end_frame');
      if (!a && !b) return;
      if (a !== b) { error(path, 'start_frame and end_frame must be provided together'); return; }
      for (const key of ['start_frame', 'end_frame']) {
        if (!integer(v[key])) error(`${path}.${key}`, 'must be a non-negative integer');
        else if (v[key] < 0) error(`${path}.${key}`, 'must be non-negative');
      }
      if (integer(v.start_frame) && integer(v.end_frame) && v.end_frame <= v.start_frame)
        error(`${path}.end_frame`, 'must be greater than start_frame');
    }
    function refs(values, path, headKey) {
      values.forEach((v, i) => {
        if (!object(v)) return;
        const head = v[headKey], ref = v[`${headKey}_ref`], p = `${path}[${i}].${headKey}`;
        if (head != null && !object(head)) error(p, 'must be an object or null');
        else if (object(head)) {
          optional(head, p, 'name', (s) => string(s) && !!s.trim(), 'must be a non-empty string');
          for (const key of ['start', 'end']) optional(head, p, key, integer, 'must be integer milliseconds');
          if (integer(head.start) && integer(head.end) && head.end < head.start) error(`${p}.end`, 'must be >= start');
        }
        if (ref == null) return;
        const r = `${p}_ref`;
        if (!object(ref)) { error(r, 'must be an object or null'); return; }
        if (head != null) error(r, 'cannot be set on a head segment');
        if (!integer(ref.headIdx)) { error(`${r}.headIdx`, 'must be an integer segment index'); return; }
        if (ref.headIdx < 0 || ref.headIdx >= i) { error(`${r}.headIdx`, 'must point to an earlier head segment'); return; }
        const target = values[ref.headIdx]?.[headKey];
        if (!object(target)) { error(`${r}.headIdx`, `must point to a ${headKey} head`); return; }
        if (string(target.name) && string(ref.name) && target.name !== ref.name) error(`${r}.name`, 'must match referenced head name');
      });
    }
    function segments(values, prefix, path, extension = false) {
      ids(values, prefix, path);
      let previous = null;
      values.forEach((v, i) => {
        const p = `${path}[${i}]`;
        if (!object(v)) { error(p, 'must be an object'); return; }
        for (const key of ['start', 'end']) if (!integer(v[key])) error(`${p}.${key}`, 'must be integer milliseconds');
        if (integer(v.start) && v.start < 0) error(`${p}.start`, 'must be non-negative');
        if (integer(v.start) && integer(v.end)) {
          if (v.end <= v.start) error(`${p}.end`, 'must be greater than start');
          if (previous !== null && v.start < previous) error(`${p}.start`, 'must be >= previous segment end');
          if (v.end > v.start) previous = v.end;
        }
        if (!string(v.text)) error(`${p}.text`, 'must be a string');
        frames(v, p);
        if (!extension) optional(v, p, 'speaker', (s) => string(s) && !!s.trim(), 'must be a non-empty string');
        if (Object.hasOwn(v, 'assOverride')) {
          const o = v.assOverride, q = `${p}.assOverride`;
          if (!object(o)) error(q, 'must be an object');
          else {
            if (Object.hasOwn(o, 'an')) error(`${q}.an`, 'not supported; use global style alignment');
            if (Object.hasOwn(o, 'pos')) {
              if (!object(o.pos)) error(`${q}.pos`, 'must be an object with finite numeric x/y');
              else for (const axis of ['x', 'y']) if (!number(o.pos[axis])) error(`${q}.pos.${axis}`, 'must be a finite number');
              v.assOverride = { pos: object(o.pos) ? { x: o.pos.x, y: o.pos.y } : o.pos };
            } else delete v.assOverride;
          }
        }
        if (!Object.hasOwn(v, 'items')) return;
        if (!Array.isArray(v.items)) { error(`${p}.items`, 'must be an array'); return; }
        let itemEnd = null;
        v.items.forEach((item, j) => {
          const q = `${p}.items[${j}]`;
          if (!object(item)) { error(q, 'must be an object'); return; }
          frames(item, q);
          if (!string(item.text)) error(`${q}.text`, 'must be a string');
          for (const key of ['start', 'end']) if (!integer(item[key])) error(`${q}.${key}`, 'must be integer milliseconds');
          if (!integer(item.start) || !integer(item.end)) return;
          if (integer(v.start) && integer(v.end)) {
            if (item.start < v.start || item.start > v.end) error(`${q}.start`, 'must be within segment bounds');
            if (item.end < item.start || item.end > v.end) error(`${q}.end`, 'must be within segment bounds and >= start');
            if (itemEnd !== null && item.start < itemEnd) error(`${q}.start`, 'must be >= previous item end');
          }
          if (item.end >= item.start) itemEnd = item.end;
        });
      });
      refs(values, path, 'color');
      if (!extension) refs(values, path, 'sticker');
    }
    function arrayDefault(v, key, path) {
      if (v[key] == null) v[key] = [];
      else if (!Array.isArray(v[key])) { error(`${path}.${key}`, 'must be an array'); v[key] = []; }
      return v[key];
    }
    function defaultValue(v, key, value, path, check, message) {
      if (v[key] == null) v[key] = value;
      else if (!check(v[key])) error(`${path}.${key}`, message);
    }
    function multi(project) {
      if (project.multi_subtitle == null) return;
      const m = project.multi_subtitle, p = '$.multi_subtitle';
      if (!object(m)) { error(p, 'must be an object'); return; }
      defaultValue(m, 'schema', MULTI, p, (v) => v === MULTI, `must be ${MULTI}`);
      defaultValue(m, 'enabled', false, p, bool, 'must be a boolean');
      defaultValue(m, 'display_mode', 'both', p, (v) => ['main', 'extension', 'both'].includes(v), 'must be one of main, extension, both');
      if (m.main_split_mode != null && !['continuous', 'word'].includes(m.main_split_mode)) error(`${p}.main_split_mode`, 'must be continuous or word');
      const tracks = arrayDefault(m, 'tracks', p);
      ids(tracks, 'extension', `${p}.tracks`);
      const byId = new Map();
      tracks.forEach((track, i) => {
        const q = `${p}.tracks[${i}]`;
        if (!object(track)) { error(q, 'must be an object'); return; }
        defaultValue(track, 'role', 'extension', q, (v) => v === 'extension', 'must be extension');
        defaultValue(track, 'split_mode', 'word', q, (v) => ['continuous', 'word'].includes(v), 'must be continuous or word');
        for (const key of ['name', 'language', 'source_name']) optional(track, q, key, string, 'must be a string');
        segments(arrayDefault(track, 'segments', q), `${track.id || 'extension'}-segment`, `${q}.segments`, true);
        if (string(track.id)) byId.set(track.id, track);
      });
      const bindings = arrayDefault(m, 'bindings', p);
      ids(bindings, 'binding', `${p}.bindings`);
      const usedMain = new Set(), usedExtension = new Set();
      bindings.forEach((binding, i) => {
        const q = `${p}.bindings[${i}]`;
        if (!object(binding)) { error(q, 'must be an object'); return; }
        if (binding.track_id == null && byId.size === 1) binding.track_id = [...byId.keys()][0];
        if (!id(binding.track_id)) { error(`${q}.track_id`, 'must reference an extension track'); return; }
        binding.track_id = binding.track_id.trim();
        const track = byId.get(binding.track_id);
        if (!track) { error(`${q}.track_id`, 'must reference an existing extension track'); return; }
        const selected = [];
        for (const role of ['main', 'extension']) {
          const key = `${role}_segment_ids`, legacy = `${role}_segment_id`;
          if (binding[key] == null && Object.hasOwn(binding, legacy)) binding[key] = [binding[legacy]];
          if (!Array.isArray(binding[key])) { error(`${q}.${key}`, 'must be an array with exactly one ID in the MVP'); selected.push(null); }
          else if (binding[key].length !== 1 || !id(binding[key][0])) { error(`${q}.${key}`, 'must contain exactly one stable ID in the MVP'); selected.push(null); }
          else { binding[key][0] = binding[key][0].trim(); selected.push(binding[key][0]); }
        }
        const [mainId, extensionId] = selected;
        if (mainId == null || extensionId == null) return;
        const main = project.segments.find((s) => s?.id === mainId), ext = track.segments.find((s) => s?.id === extensionId);
        if (!main) { error(`${q}.main_segment_ids[0]`, 'must reference an existing main segment'); return; }
        if (!ext) { error(`${q}.extension_segment_ids[0]`, 'must reference an existing extension segment'); return; }
        const extKey = JSON.stringify([binding.track_id, extensionId]);
        if (usedMain.has(mainId)) error(`${q}.main_segment_ids[0]`, 'must be one-to-one in the MVP');
        if (usedExtension.has(extKey)) error(`${q}.extension_segment_ids[0]`, 'must be one-to-one in the MVP');
        usedMain.add(mainId); usedExtension.add(extKey);
        if (![main.start, main.end, ext.start, ext.end].every(integer)) return;
        for (const edge of ['start', 'end']) {
          const key = `${edge}_offset_ms`, expected = ext[edge] - main[edge];
          if (binding[key] == null) binding[key] = expected;
          else if (!integer(binding[key])) error(`${q}.${key}`, 'must be integer milliseconds');
          else if (binding[key] !== expected) error(`${q}.${key}`, 'must equal the segment time offset');
        }
      });
    }
    function metadata(v) {
      const p = '$.media_metadata';
      if (!object(v)) { error(p, 'must be an object'); return; }
      const width = Object.hasOwn(v, 'video_width'), height = Object.hasOwn(v, 'video_height');
      if (width !== height) error(`${p}.${width ? 'video_height' : 'video_width'}`, 'must be provided together with the other video dimension');
      for (const key of ['video_width', 'video_height']) optional(v, p, key, (n) => integer(n) && n > 0, 'must be a positive integer');
      if (Object.hasOwn(v, 'video_fps')) fps(v.video_fps, `${p}.video_fps`);
      optional(v, p, 'video_fps_ratio', (s) => string(s) && !!s.trim(), 'must be a non-empty string');
      optional(v, p, 'selected_audio_track', (n) => integer(n) && n >= 0, 'must be a non-negative integer');
      if (!Object.hasOwn(v, 'audio_tracks')) return;
      if (!Array.isArray(v.audio_tracks)) { error(`${p}.audio_tracks`, 'must be an array'); return; }
      v.audio_tracks.forEach((track, i) => {
        const q = `${p}.audio_tracks[${i}]`;
        if (!object(track)) { error(q, 'must be an object'); return; }
        if (!integer(track.stream_index) || track.stream_index < 0) error(`${q}.stream_index`, 'must be a non-negative integer');
        if (track.audio_index != null && (!integer(track.audio_index) || track.audio_index < 0)) error(`${q}.audio_index`, 'must be a non-negative integer');
        for (const key of ['codec', 'language', 'title']) optional(track, q, key, string, 'must be a string');
        for (const key of ['channels', 'sample_rate']) if (track[key] != null && (!integer(track[key]) || track[key] <= 0)) error(`${q}.${key}`, 'must be a positive integer or null');
        optional(track, q, 'default', bool, 'must be a boolean');
      });
    }
    function fps(v, p) {
      if (!number(v)) error(p, 'must be a finite number');
      else if (v < 1 || v > 240) error(p, 'must be between 1 and 240');
    }
    function preview(v) {
      const p = '$.preview';
      if (v == null) return;
      if (!object(v)) { error(p, 'must be an object or null'); return; }
      optional(v, p, 'ass_mode', bool, 'must be a boolean');
      for (const key of ['subtitle', 'extension_subtitle']) {
        const style = v[key], q = `${p}.${key}`;
        if (style == null) continue;
        if (!object(style)) { error(q, 'must be an object or null'); continue; }
        if (key === 'subtitle') {
          for (const field of ['x', 'y', 'width', 'height']) {
            if (!number(style[field])) error(`${q}.${field}`, 'must be a number in [0, 1]');
            else if (style[field] < 0 || style[field] > 1) error(`${q}.${field}`, 'must be in [0, 1]');
          }
          if (['x', 'y', 'width', 'height'].every((field) => number(style[field]) && style[field] >= 0 && style[field] <= 1)) {
            if (style.x + style.width > 1) error(q, 'x + width must be <= 1');
            if (style.y + style.height > 1) error(q, 'y + height must be <= 1');
          }
          const labels = style.speaker_labels, r = `${q}.speaker_labels`;
          const label = (s, max) => string(s) && Array.from(s).length <= max && !/[\x00-\x1f\x7f]/u.test(s);
          if (labels != null) {
            if (!object(labels)) error(r, 'must be an object or null');
            else {
              for (const field of ['mapping_enabled', 'enabled', 'export_enabled']) optional(labels, r, field, bool, 'must be a boolean');
              optional(labels, r, 'separator', (s) => label(s, 16), 'must be a string up to 16 characters without control characters');
              if (labels.names != null) {
                if (!object(labels.names)) error(`${r}.names`, 'must be an object or null');
                else for (const color of ['yellow', 'green', 'red', 'purple', 'blue']) optional(labels.names, `${r}.names`, color, (s) => label(s, 64), 'must be a string up to 64 characters without control characters');
              }
            }
          }
        }
        optional(style, q, 'font_size', (n) => number(n) && n >= 12 && n <= 96, 'must be a number in [12, 96]');
        optional(style, q, 'background_alpha', (n) => number(n) && n >= 0 && n <= 1, 'must be a number in [0, 1]');
        optional(style, q, 'font_family', (s) => string(s) && !!s && s === s.trim() && Array.from(s).length <= 128 && !/[\x00-\x1f\x7f]/u.test(s), 'must be a built-in key or a non-empty font family name up to 128 characters');
        optional(style, q, 'background_color', (s) => string(s) && /^#[0-9a-f]{6}$/i.test(s), 'must be a 6-digit hexadecimal color such as #000000');
        optional(style, q, 'color', (s) => string(s) && /^#[0-9a-f]{6}$/i.test(s), 'must be a six-digit hexadecimal color');
        optional(style, q, 'color_style', (s) => ['underline', 'text', 'shadow', 'stroke'].includes(s), 'must be one of underline, text, shadow, or stroke');
        optional(style, q, 'ass_color_style', (s) => ['text', 'speaker', 'stroke', 'none'].includes(s), 'must be one of text, speaker, stroke, or none');
      }
    }
    if (!object(input)) return { ok: false, errors: [{ path: '$', message: 'must be an object' }], project: null, preview: null };
    const project = clone(input);
    const schema = project.schema;
    if (Object.hasOwn(project, 'schema') && schema !== SCHEMA && schema !== GROUP_SCHEMA) error('$.schema', `must be ${SCHEMA} or ${GROUP_SCHEMA}`);
    project.schema = schema === GROUP_SCHEMA ? GROUP_SCHEMA : SCHEMA;
    optional(project, '$', 'preserve_punctuation', bool, 'must be a boolean');
    if (Object.hasOwn(project, 'timebase')) {
      if (!object(project.timebase)) error('$.timebase', 'must be an object');
      else {
        if (!['milliseconds', 'frames'].includes(project.timebase.unit)) error('$.timebase.unit', 'must be milliseconds or frames');
        fps(project.timebase.fps, '$.timebase.fps');
        optional(project.timebase, '$.timebase', 'fps_source', (v) => v === 'auto' || v === 'user', 'must be auto or user');
      }
    }
    if (Object.hasOwn(project, 'media_metadata')) metadata(project.media_metadata);
    if (!Array.isArray(project.segments)) error('$.segments', 'must be an array');
    else {
      if (schema === GROUP_SCHEMA) validateSubtitleGroups(project, error);
      segments(project.segments, 'main', '$.segments');
      for (const field of ['language', 'language_source', 'split_mode', 'timestamp_granularity', 'timed_text_edit_view']) optional(project, '$', field, string, 'must be a string');
      /** @type {[string, string[], string][]} */
      const metadataEnums = [
        ['language_source', ['detected', 'hint', 'inferred', 'unknown'], 'must be detected, hint, inferred, or unknown'],
        ['split_mode', ['continuous', 'word'], 'must be continuous or word'],
        ['timestamp_granularity', ['char', 'word', 'segment', 'unknown'], 'must be char, word, segment, or unknown'],
      ];
      for (const [key, values, message] of metadataEnums) if (string(project[key]) && !values.includes(project[key])) error(`$.${key}`, message);
      if (Object.hasOwn(project, 'timed_text_edit_view') && !['rows', 'single'].includes(project.timed_text_edit_view)) {
        error('$.timed_text_edit_view', 'must be rows or single');
      }
      const overlay = project.overlay_track;
      if (overlay != null) {
        if (!object(overlay)) error('$.overlay_track', 'must be an object');
        else {
          defaultValue(overlay, 'enabled', false, '$.overlay_track', bool, 'must be a boolean');
          segments(arrayDefault(overlay, 'segments', '$.overlay_track'), 'overlay', '$.overlay_track.segments');
        }
      }
      multi(project);
      preview(project.preview);
    }
    return { ok: errors.length === 0, errors, project: errors.length ? null : project, preview: null };
  }

  function repairTimings(project) {
    const collections = [project.segments, project.overlay_track?.segments, ...(project.multi_subtitle?.tracks || []).map((t) => t?.segments)];
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

  function prepareProject(input, { repair = true } = {}) {
    let result = validateProject(input);
    const timing = new Set(['must be non-negative', 'must be greater than start', 'must be >= previous segment end', 'must be within segment bounds', 'must be within segment bounds and >= start', 'must be >= previous item end']);
    if (!result.ok && repair && result.errors.every((e) => /\.(start|end)$/.test(e.path) && timing.has(e.message))) {
      const candidate = clone(input);
      repairTimings(candidate);
      result = validateProject(candidate);
    }
    return { ...result, changes: result.ok ? changes(input, result.project) : [] };
  }

  global.MaweProjectValidation = Object.freeze({ validateProject, prepareProject, changes });
})(typeof window !== 'undefined' ? window : globalThis);

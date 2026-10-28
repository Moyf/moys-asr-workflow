// Canonical groups own attributes; cues own membership. Legacy fields are views only.
export function createUtilsModule({ cloneJsonValue, stableId, ensureStableSegmentIds }) {
  const GROUP_PROJECT_SCHEMA = 'moy.asr.project.v1.5';
  const kinds = ['color', 'sticker'];
  function subtitleGroupTracks(project) {
    return [{ key: 'main', enabled: true, segments: project.segments || [] },
      { key: 'overlay', enabled: project.overlay_track?.enabled === true, segments: project.overlay_track?.segments || [] },
      ...(project.multi_subtitle?.tracks || []).map((track, index) => ({
        key: `extension-${index + 1}`, enabled: project.multi_subtitle.enabled === true,
        trackId: stableId(track.id) || `extension-${index + 1}`, segments: track.segments || [],
      }))];
  }
  function migrateSubtitleGroups(project, { fromFile = false } = {}) {
    const tracks = subtitleGroupTracks(project);
    const extensions = tracks.filter(track => track.trackId);
    const bindingTrackId = binding => {
      const id = stableId(binding.track_id);
      if (id && extensions.filter(track => track.trackId === id).length === 1) return id;
      if (binding.track_id == null && extensions.length === 1) return extensions[0].trackId;
      throw new Error('multi_subtitle.bindings.track_id: ambiguous binding or missing extension track');
    };
    // Validate before changing cue identities or choosing a default binding track.
    for (const binding of project.multi_subtitle?.bindings || []) bindingTrackId(binding);
    if (project.schema === GROUP_PROJECT_SCHEMA && !project.subtitle_groups) {
      throw new Error('subtitle_groups: v1.5 projects require a group table');
    }
    if (fromFile && project.schema === GROUP_PROJECT_SCHEMA) {
      for (const track of subtitleGroupTracks(project)) for (const [index, cue] of track.segments.entries()) {
        for (const kind of kinds) if (Object.hasOwn(cue, kind) || Object.hasOwn(cue, `${kind}_ref`)) {
          throw new Error(`${track.key}[${index}].${kind}: legacy group fields are not allowed in v1.5`);
        }
      }
    }
    if (project.subtitle_groups) {
      const table = project.subtitle_groups;
      const cues = subtitleGroupTracks(project).flatMap(t => t.segments);
      const cueIds = new Set();
      if (table.next_id !== undefined && (!Number.isSafeInteger(table.next_id) || table.next_id < 1)) {
        throw new Error('subtitle_groups.next_id: must be a positive safe integer');
      }
      for (const cue of cues) {
        if (typeof cue.id !== 'string' || !stableId(cue.id) || cueIds.has(cue.id)) throw new Error('subtitle_groups: cue IDs must be unique project-wide');
        cueIds.add(cue.id);
      }
      for (const kind of kinds) {
        if (!Array.isArray(table[kind])) throw new Error(`subtitle_groups.${kind}: must be an array`);
        const ids = new Set();
        for (const group of table[kind]) {
          if (typeof group?.id !== 'string' || !stableId(group.id) || ids.has(group.id)) throw new Error(`subtitle_groups.${kind}: duplicate or missing ID`);
          if (!group.value || typeof group.value.name !== 'string' || 'start' in group.value || 'end' in group.value) {
            throw new Error(`subtitle_groups.${kind}.${group.id}: invalid attributes or independent range`);
          }
          ids.add(group.id);
        }
        for (const cue of cues) {
          if (cue[`${kind}_group_id`] != null && !ids.has(cue[`${kind}_group_id`])) {
            throw new Error(`${cue.id}.${kind}_group_id: missing group`);
          }
        }
      }
      return table;
    }
    const bindingIds = (binding, field) => Array.isArray(binding[field]) ? binding[field]
      : binding[field.slice(0, -1)] ? [binding[field.slice(0, -1)]] : [];
    const groups = { color: [], sticker: [] };
    // Resolve before filtering, sorting or changing any identities.
    const memberships = [];
    for (const track of tracks) for (const kind of kinds) {
      const heads = new Map();
      track.segments.forEach((segment, index) => {
        if (!segment || typeof segment !== 'object') throw new Error(`${track.key}[${index}]: invalid cue`);
        if (segment[kind]) {
          const id = `${kind}-${track.key}-${index + 1}`;
          const value = cloneJsonValue(segment[kind]);
          delete value.start; delete value.end;
          groups[kind].push({ id, value }); heads.set(index, id);
        }
      });
      track.segments.forEach((segment, index) => {
        const ref = segment[`${kind}_ref`];
        if (ref && (segment[kind] || !Number.isInteger(ref.headIdx) || !heads.has(ref.headIdx)
          || ref.headIdx >= index)) throw new Error(`${track.key}[${index}].${kind}_ref: invalid legacy headIdx`);
        const id = ref ? heads.get(ref.headIdx) : heads.get(index);
        if (id) memberships.push([segment, `${kind}_group_id`, id]);
        if (ref) {
          const extra = Object.fromEntries(Object.entries(ref).filter(([key]) => key !== 'headIdx' && key !== 'name'));
          if (Object.keys(extra).length) {
            const field = `${kind}_group_metadata`;
            if (segment[field] !== undefined) throw new Error(`${track.key}[${index}].${field}: migration metadata conflict`);
            memberships.push([segment, field, cloneJsonValue(extra)]);
          }
        }
      });
    }
    const reports = [];
    for (const track of tracks) {
      const rawIds = track.segments.map(segment => segment.id);
      const originalIds = track.segments.map(s => stableId(s.id));
      const duplicates = new Set(originalIds.filter((id, index) => id && originalIds.indexOf(id) !== index));
      for (const binding of project.multi_subtitle?.bindings || []) {
        const ids = track.key === 'main' ? bindingIds(binding, 'main_segment_ids')
          : bindingTrackId(binding) === track.trackId ? bindingIds(binding, 'extension_segment_ids') : [];
        if ((ids || []).some(id => duplicates.has(stableId(id)))) throw new Error(`${track.key}: ambiguous binding cue ID`);
      }
      ensureStableSegmentIds(track.segments, track.key === 'main' ? 'main' : track.key === 'overlay' ? 'overlay' : `${track.trackId || track.key}-segment`);
      track.segments.forEach((segment, index) => {
        if (rawIds[index] !== segment.id) reports.push({ track: track.key, index, from: rawIds[index] ?? '', to: segment.id });
      });
    }
    // Reserve IDs across all tracks. Binding endpoints are track-scoped in v1.
    const reserved = new Set(tracks.flatMap(t => t.segments.map(s => stableId(s.id))).filter(Boolean));
    const used = new Set();
    for (const track of tracks) {
      const mapping = new Map();
      const counts = new Map();
      track.segments.forEach(s => counts.set(stableId(s.id), (counts.get(stableId(s.id)) || 0) + 1));
      track.segments.forEach((segment, index) => {
        const old = stableId(segment.id);
        let id = old;
        if (!id || used.has(id)) {
          const base = `${track.key}-cue-${index + 1}`;
          id = base; let suffix = 2;
          while (used.has(id) || reserved.has(id)) id = `${base}-${suffix++}`;
          reports.push({ track: track.key, index, from: old, to: id });
        }
        used.add(id); segment.id = id;
        if (old && counts.get(old) === 1) mapping.set(old, id);
      });
      for (const binding of project.multi_subtitle?.bindings || []) {
        const field = track.key === 'main' ? 'main_segment_ids'
          : track.trackId === bindingTrackId(binding) ? 'extension_segment_ids' : null;
        if (!field) continue;
        binding[field] = bindingIds(binding, field).map(rawId => {
          const id = stableId(rawId);
          if (counts.get(id) > 1) throw new Error(`${track.key}: ambiguous binding cue ID ${id}`);
          return mapping.get(id) || id;
        });
      }
    }
    for (const [segment, field, id] of memberships) segment[field] = id;
    project.subtitle_groups = groups;
    if (reports.length) project.subtitle_group_migration = { remapped_ids: reports };
    return groups;
  }
  function subtitleGroupRanges(project, kind = 'sticker', { activeTracksOnly = false } = {}) {
    const groups = project.subtitle_groups?.[kind] || [];
    // Stored membership survives track switches. Presentation uses only enabled
    // tracks, while editing/serialization still sees every member and group.
    const tracks = subtitleGroupTracks(project).filter(track => !activeTracksOnly || track.enabled);
    return groups.flatMap(group => {
      const members = tracks.flatMap(track => track.segments.filter(s => s[`${kind}_group_id`] === group.id)
        .map(segment => ({ segment, track: track.key })));
      if (!members.length) return [];
      return [{ id: group.id, source: group.value, members,
        start: Math.min(...members.map(m => m.segment.start)),
        end: Math.max(...members.map(m => m.segment.end)),
        enabled: members.some(m => !m.segment.disabled),
        hasOverlay: members.some(m => m.track === 'overlay' && !m.segment.disabled),
        track: members.some(m => m.track !== 'overlay') ? 'main' : 'overlay' }];
    });
  }
  function refreshSubtitleGroupViews(project) {
    if (!project.subtitle_groups) return;
    const tracks = subtitleGroupTracks(project);
    for (const kind of kinds) {
      const ranges = subtitleGroupRanges(project, kind);
      const activeIds = new Set(ranges.map(r => r.id));
      project.subtitle_groups[kind] = (project.subtitle_groups[kind] || []).filter(g => activeIds.has(g.id));
      for (const track of tracks) {
        for (const segment of track.segments) {
          delete segment[kind]; delete segment[`${kind}_ref`];
        }
        for (const range of ranges) {
          const indexes = track.segments.map((s, index) => s[`${kind}_group_id`] === range.id ? index : -1).filter(i => i >= 0);
          if (!indexes.length) continue;
          const head = indexes.find(i => !track.segments[i].disabled) ?? indexes[0];
          track.segments[head][kind] = { ...cloneJsonValue(range.source), start: range.start, end: range.end };
          for (const index of indexes) if (index !== head) {
            track.segments[index][`${kind}_ref`] = { name: range.source.name, headIdx: head };
          }
        }
      }
    }
  }
  function assignSubtitleGroup(project, segments, indexes, kind, value, existingId = null, { replaceHead = false } = {}) {
    migrateSubtitleGroups(project);
    const groups = project.subtitle_groups[kind];
    let id = existingId;
    // A picker action on the displayed head replaces the group's attributes.
    // A member-only or explicit new assignment still creates a separate group.
    const head = indexes.length === 1 ? segments[indexes[0]] : null;
    if (!id && replaceHead && head?.[kind] && head[`${kind}_group_id`]) {
      const group = groups.find(group => group.id === head[`${kind}_group_id`]);
      if (group) {
        const attributes = cloneJsonValue(value);
        delete attributes.start; delete attributes.end;
        group.value = attributes;
        id = group.id;
      }
    }
    if (id && !groups.some(group => group.id === id)) throw new Error(`subtitle_groups.${kind}: missing group ${id}`);
    if (!id) {
      const used = new Set(groups.map(g => g.id));
      let next = 1;
      // The monotonic counter is persisted and restored with history.
      next = Math.max(next, Number(project.subtitle_groups.next_id) || 1);
      while (used.has(`${kind}-${next}`)) next++;
      if (next >= Number.MAX_SAFE_INTEGER) throw new Error('subtitle_groups.next_id: exhausted');
      id = `${kind}-${next}`; project.subtitle_groups.next_id = next + 1;
      const attributes = cloneJsonValue(value);
      delete attributes.start; delete attributes.end;
      groups.push({ id, value: attributes });
    }
    for (const index of indexes) if (segments[index]) segments[index][`${kind}_group_id`] = id;
    refreshSubtitleGroupViews(project);
    return id;
  }
  function clearSubtitleGroupMembers(project, segments, indexes, kind) {
    for (const index of indexes) if (segments[index]) delete segments[index][`${kind}_group_id`];
    refreshSubtitleGroupViews(project);
  }
  function serializeSubtitleGroups(project) {
    if (!project.subtitle_groups) return project;
    project.schema = GROUP_PROJECT_SCHEMA;
    for (const track of subtitleGroupTracks(project)) for (const segment of track.segments) {
      for (const kind of kinds) { delete segment[kind]; delete segment[`${kind}_ref`]; }
    }
    return project;
  }
  return Object.freeze({ GROUP_PROJECT_SCHEMA, subtitleGroupTracks, migrateSubtitleGroups,
    subtitleGroupRanges, refreshSubtitleGroupViews, assignSubtitleGroup, clearSubtitleGroupMembers,
    serializeSubtitleGroups });
}

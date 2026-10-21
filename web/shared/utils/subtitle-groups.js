// Groups own attributes; canonical cues own only stable group memberships.
// Detached materialization is an adapter for renderers, never another DATA tree.
export function createUtilsModule({ cloneJsonValue }) {
  const KINDS = new Set(['color', 'sticker']);
  function requireKind(kind) { if (!KINDS.has(kind)) throw new TypeError('Unknown subtitle group kind'); }
  function subtitleGroupTracks(project) {
    return (project.tracks || []).map(track => ({ ...track, key: track.role, trackId: track.id }));
  }
  function migrateSubtitleGroups(project) {
    if (project?.schema !== 'moy.asr.project.v3' || !project.subtitle_groups) throw new TypeError('Import project before using subtitle groups');
    return project.subtitle_groups;
  }
  function getSubtitleGroupValue(project, segment, kind = 'color') {
    requireKind(kind);
    return project.subtitle_groups?.[kind]?.find(group => group.id === segment?.[`${kind}_group_id`])?.value || null;
  }
  function subtitleGroupRanges(project, kind = 'sticker', { activeTracksOnly = false, trackIds = null, includeDisabled = true } = {}) {
    requireKind(kind);
    const selectedIds = trackIds === null ? null : new Set(trackIds);
    const tracks = (project.tracks || []).filter(track => (!selectedIds || selectedIds.has(track.id))
      && (!activeTracksOnly || (track.enabled && (track.role !== 'extension' || track.id === project.bilingual?.active_track_id))));
    return (project.subtitle_groups?.[kind] || []).flatMap(group => {
      const members = tracks.flatMap(track => track.segments.filter(segment => segment[`${kind}_group_id`] === group.id
        && (includeDisabled || segment.disabled !== true))
        .map(segment => ({ segment, track: track.role, trackId: track.id })));
      if (!members.length) return [];
      return [{ id: group.id, source: group.value, members,
        start: Math.min(...members.map(member => member.segment.start)),
        end: Math.max(...members.map(member => member.segment.end)),
        enabled: members.some(member => !member.segment.disabled),
        hasOverlay: members.some(member => member.track === 'overlay' && !member.segment.disabled),
        track: members.some(member => member.track !== 'overlay') ? 'main' : 'overlay' }];
    });
  }
  // Historical callers refresh after edits. The canonical model needs no
  // per-cue attribute views and retains even temporarily unreferenced groups.
  function refreshSubtitleGroupViews(project) { migrateSubtitleGroups(project); return project; }
  function assignSubtitleGroup(project, segments, indexes, kind, value, existingId = null, { replaceHead = false } = {}) {
    requireKind(kind); migrateSubtitleGroups(project);
    const groups = project.subtitle_groups[kind];
    if (!value || typeof value !== 'object' || typeof value.name !== 'string') throw new TypeError('Subtitle group value requires a name');
    const attributes = cloneJsonValue(value); delete attributes.start; delete attributes.end;
    let groupId = existingId;
    if (!groupId && replaceHead && indexes.length === 1) groupId = segments[indexes[0]]?.[`${kind}_group_id`] || null;
    const existing = groupId ? groups.find(group => group.id === groupId) : null;
    if (groupId && !existing) throw new Error(`subtitle_groups.${kind}: missing group ${groupId}`);
    if (existing && replaceHead) existing.value = attributes;
    if (!groupId) {
      const used = new Set(groups.map(group => group.id));
      let next = project.subtitle_groups.next_id ?? 1;
      if (!Number.isSafeInteger(next) || next < 1) throw new TypeError('subtitle_groups.next_id must be a positive safe integer');
      while (used.has(`${kind}-${next}`)) next++;
      if (!Number.isSafeInteger(next + 1)) throw new Error('subtitle_groups.next_id: exhausted');
      groupId = `${kind}-${next}`; project.subtitle_groups.next_id = next + 1;
      groups.push({ id: groupId, value: attributes });
    }
    for (const index of indexes) if (segments[index]) {
      segments[index][`${kind}_group_id`] = groupId;
      delete segments[index][`${kind}_group_metadata`];
    }
    return groupId;
  }
  function clearSubtitleGroupMembers(project, segments, indexes, kind) {
    requireKind(kind); migrateSubtitleGroups(project);
    for (const index of indexes) if (segments[index]) {
      delete segments[index][`${kind}_group_id`]; delete segments[index][`${kind}_group_metadata`];
    }
    return project;
  }
  function materializeTrackSegments(project, trackId, options = {}) {
    const track = project.tracks?.find(candidate => candidate.id === trackId);
    if (!track) return [];
    const segments = cloneJsonValue(track.segments);
    for (const kind of KINDS) {
      const ranges = new Map(subtitleGroupRanges(project, kind, options).map(range => [range.id, range]));
      const heads = new Map();
      segments.forEach((segment, index) => {
        const groupId = segment[`${kind}_group_id`];
        if (!groupId) return;
        const range = ranges.get(groupId);
        if (!range) {
          if (!getSubtitleGroupValue(project, segment, kind)) throw new Error(`${segment.id}.${kind}_group_id: missing group`);
          return;
        }
        if (!heads.has(groupId)) {
          heads.set(groupId, index);
          segment[kind] = { ...cloneJsonValue(range.source), start: range.start, end: range.end };
        } else segment[`${kind}_ref`] = { ...cloneJsonValue(segment[`${kind}_group_metadata`] || {}), name: range.source.name, headIdx: heads.get(groupId) };
      });
    }
    return segments;
  }
  function serializeSubtitleGroups(project) {
    migrateSubtitleGroups(project);
    for (const track of project.tracks) for (const segment of track.segments) for (const kind of KINDS) {
      if (Object.hasOwn(segment, kind) || Object.hasOwn(segment, `${kind}_ref`)) throw new TypeError('Canonical project contains legacy group views');
    }
    return project;
  }
  return Object.freeze({ subtitleGroupTracks, migrateSubtitleGroups, getSubtitleGroupValue, subtitleGroupRanges,
    refreshSubtitleGroupViews, assignSubtitleGroup, clearSubtitleGroupMembers, materializeTrackSegments, serializeSubtitleGroups });
}

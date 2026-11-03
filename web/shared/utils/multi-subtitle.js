// Bilingual editing operations over the canonical project.tracks tree.
export function createUtilsModule(dependencies) {
  'use strict';
  const { cloneJsonValue, stableId } = dependencies;
  const MULTI_SUBTITLE_TOLERANCE_MS = 300;
  const MULTI_SUBTITLE_DISPLAY_MODES = new Set(['main', 'extension', 'both']);
  const MULTI_SUBTITLE_SPLIT_MODES = new Set(['continuous', 'word']);
  const tracks = project => Array.isArray(project?.tracks) ? project.tracks : [];
  const mainTrack = project => tracks(project).find(track => track.role === 'main') || null;
  const extensionTrack = (project, trackId = project?.bilingual?.active_track_id) => tracks(project)
    .find(track => track.role === 'secondary' && (!trackId || track.id === trackId)) || null;
  const cue = (project, trackId, cueId) => tracks(project).find(track => track.id === trackId)
    ?.segments.find(segment => segment.id === cueId) || null;

  function normalizeMultiSubtitleProject(project) {
    if (project?.schema !== 'moy.asr.project.v2' || !Array.isArray(project.tracks)
        || !Array.isArray(project.bindings) || !project.bilingual) {
      throw new TypeError('Bilingual editing requires a canonical tracks project');
    }
    return rebuildBindingOffsets(project);
  }
  function ensureRoleTrack(project, role, options) {
    const existing = role === 'overlay' ? tracks(project).find(track => track.role === role)
      : extensionTrack(project, options.id || project.bilingual?.active_track_id);
    if (existing) return existing;
    const used = new Set(tracks(project).map(track => track.id));
    const base = Array.from(stableId(options.id) || (role === 'overlay' ? 'overlay' : 'extension-1')).slice(0, 150).join('');
    let trackId = base; let suffix = 2;
    while (used.has(trackId)) trackId = `${base}-${suffix++}`;
    const track = { ...cloneJsonValue(options), id: trackId, role,
      name: options.name ?? (role === 'overlay' ? '叠加字幕' : '副字幕'),
      enabled: options.enabled ?? false, segments: cloneJsonValue(options.segments || []) };
    project.tracks.push(track);
    if (role === 'secondary' && !project.bilingual.active_track_id) project.bilingual.active_track_id = trackId;
    return track;
  }
  function ensureExtensionTrack(project, options = {}) { return ensureRoleTrack(project, 'secondary', options); }
  function ensureOverlayTrack(project, options = {}) { return ensureRoleTrack(project, 'overlay', options); }
  function mergeMainAndOverlaySegments(mainSegments, overlaySegments) {
    return [
      ...(Array.isArray(mainSegments) ? mainSegments : []).map((segment, index) => ({ segment, order: 0, index })),
      ...(Array.isArray(overlaySegments) ? overlaySegments : []).map((segment, index) => ({ segment, order: 1, index })),
    ].sort((a, b) => Number(a.segment?.start) - Number(b.segment?.start)
      || a.order - b.order || a.index - b.index).map(entry => entry.segment);
  }
  function moveSegmentBetweenTracks(sourceSegments, targetSegments, index) {
    if (!Array.isArray(sourceSegments) || !Array.isArray(targetSegments)
        || !Number.isInteger(index) || index < 0 || index >= sourceSegments.length) return -1;
    const segment = sourceSegments[index];
    if (!segment || typeof segment !== 'object') return -1;
    sourceSegments.splice(index, 1);
    const next = targetSegments.findIndex(candidate => Number(candidate.start) > Number(segment.start));
    const insertAt = next < 0 ? targetSegments.length : next;
    targetSegments.splice(insertAt, 0, segment);
    return insertAt;
  }
  function bindingForSegment(project, segmentId, side = 'either', trackId = null) {
    const cueId = stableId(segmentId);
    if (!cueId) return null;
    return (project?.bindings || []).find(binding => {
      if (trackId && binding.target?.track_id !== trackId) return false;
      const source = binding.source?.segment_id === cueId;
      const target = binding.target?.segment_id === cueId;
      return ['main', 'source'].includes(side) ? source : ['extension', 'target'].includes(side) ? target : source || target;
    }) || null;
  }
  function buildSubtitleBinding(mainSegment, extensionSegment, targetTrackId, bindingId = null, sourceTrackId, existingBindings = []) {
    if (!stableId(sourceTrackId) || !stableId(targetTrackId)) throw new TypeError('Binding requires explicit source and target track IDs');
    const used = new Set(existingBindings.map(binding => binding.id));
    const explicitId = stableId(bindingId);
    if (explicitId && used.has(explicitId)) throw new TypeError('Binding ID already exists');
    const base = explicitId || Array.from(`binding-${stableId(mainSegment.id)}-${stableId(extensionSegment.id)}`).slice(0, 150).join('');
    let identifier = base;
    for (let suffix = 2; used.has(identifier); suffix++) identifier = `${base}-${suffix}`;
    return {
      id: identifier,
      source: { track_id: sourceTrackId, segment_id: mainSegment.id },
      target: { track_id: targetTrackId, segment_id: extensionSegment.id },
      start_offset_ms: Math.round(Number(extensionSegment.start) - Number(mainSegment.start)),
      end_offset_ms: Math.round(Number(extensionSegment.end) - Number(mainSegment.end)),
    };
  }
  function rebuildBindingOffsets(project) {
    for (const binding of project?.bindings || []) {
      const source = cue(project, binding.source?.track_id, binding.source?.segment_id);
      const target = cue(project, binding.target?.track_id, binding.target?.segment_id);
      if (!source || !target) continue;
      binding.start_offset_ms = target.start - source.start;
      binding.end_offset_ms = target.end - source.end;
    }
    return project;
  }
  function removeSubtitleBindings(project, predicate) {
    const removed = [];
    if (!Array.isArray(project?.bindings)) return removed;
    project.bindings = project.bindings.filter(binding => {
      if (!predicate(binding)) return true;
      removed.push(binding); return false;
    });
    return removed;
  }
  function removeBindingsForSegments(project, segmentIds, side = 'either', trackId = null) {
    const ids = new Set(segmentIds);
    return removeSubtitleBindings(project, binding => {
      if (trackId && binding.target?.track_id !== trackId) return false;
      const source = ids.has(binding.source?.segment_id);
      const target = ids.has(binding.target?.segment_id);
      return ['main', 'source'].includes(side) ? source : ['extension', 'target'].includes(side) ? target : source || target;
    });
  }
  // Exchange roles only when every relation to another language has a proven
  // new source. Reject before any mutation if a binding cannot be retained.
  function swapMainAndExtensionSubtitle(project, trackId = project?.bilingual?.active_track_id) {
    const main = mainTrack(project); const promoted = extensionTrack(project, trackId);
    if (!main || !promoted || !Array.isArray(project.bindings)) return { swapped: false, reason: 'missing-track' };
    if (!main.segments.length || !promoted.segments.length) return { swapped: false, reason: 'empty-track' };
    const mapping = new Map();
    for (const binding of project.bindings) if (binding.source?.track_id === main.id && binding.target?.track_id === promoted.id)
      mapping.set(binding.source.segment_id, binding.target.segment_id);
    let unmappedBindingCount = 0; let remappedBindingCount = 0;
    const bindings = project.bindings.flatMap(binding => {
      const copy = cloneJsonValue(binding);
      if (binding.target?.track_id === promoted.id && binding.source?.track_id === main.id) {
        copy.source = cloneJsonValue(binding.target); copy.target = cloneJsonValue(binding.source);
      } else if (binding.source?.track_id === main.id) {
        const next = mapping.get(binding.source.segment_id);
        if (!next) { unmappedBindingCount++; return []; }
        copy.source.track_id = promoted.id; copy.source.segment_id = next; remappedBindingCount++;
      }
      return [copy];
    });
    if (unmappedBindingCount) return { swapped: false, reason: 'unmapped-bindings', unmappedBindingCount };
    const oldEnabled = promoted.enabled;
    main.role = 'secondary'; main.enabled = oldEnabled;
    promoted.role = 'main'; promoted.enabled = true;
    project.bindings = bindings; project.bilingual.active_track_id = main.id;
    rebuildBindingOffsets(project);
    return { swapped: true, trackId: main.id, mainTrackId: promoted.id,
      mainCount: promoted.segments.length, extensionCount: main.segments.length,
      bindingCount: bindings.length, removedBindingCount: 0, remappedBindingCount, mappedColorCount: 0 };
  }
  function matchSubtitleSegments(mainSegments, extensionSegments, toleranceMs = MULTI_SUBTITLE_TOLERANCE_MS) {
    const main = Array.isArray(mainSegments) ? mainSegments : [];
    const extension = Array.isArray(extensionSegments) ? extensionSegments : [];
    const tolerance = Math.max(0, Math.round(Number(toleranceMs) || MULTI_SUBTITLE_TOLERANCE_MS));
    const candidates = []; const byExtension = extension.map(() => []); const byMain = main.map(() => []);
    extension.forEach((target, extensionIndex) => main.forEach((source, mainIndex) => {
      const startDiff = Math.abs(Number(target?.start) - Number(source?.start));
      const endDiff = Math.abs(Number(target?.end) - Number(source?.end));
      if (Number(target?.start) > Number(source?.end) || Number(target?.end) < Number(source?.start)
          || startDiff > tolerance || endDiff > tolerance) return;
      const candidate = { mainIndex, extensionIndex, startDiff, endDiff, cost: startDiff + endDiff };
      candidates.push(candidate); byExtension[extensionIndex].push(candidate); byMain[mainIndex].push(candidate);
    }));
    candidates.sort((a, b) => a.cost - b.cost || a.startDiff - b.startDiff || a.extensionIndex - b.extensionIndex || a.mainIndex - b.mainIndex);
    const usedMain = new Set(); const usedExtension = new Set(); const matches = [];
    candidates.forEach(candidate => {
      if (usedMain.has(candidate.mainIndex) || usedExtension.has(candidate.extensionIndex)) return;
      usedMain.add(candidate.mainIndex); usedExtension.add(candidate.extensionIndex); matches.push(candidate);
    });
    return { matches, unmatchedMain: main.map((_, index) => index).filter(index => !usedMain.has(index)),
      unmatchedExtension: extension.map((_, index) => index).filter(index => !usedExtension.has(index)), candidates,
      conflicts: Math.max(byExtension.filter(values => values.length > 1).length, byMain.filter(values => values.length > 1).length), tolerance_ms: tolerance };
  }
  function buildMultiDisplayRows(mainSegments, extensionSegments, bindings = []) {
    const extensionById = new Map(extensionSegments.map((segment, index) => [segment.id, index]));
    const mapping = new Map(); const bound = new Set();
    for (const binding of bindings) {
      const sourceId = binding.source?.segment_id; const index = extensionById.get(binding.target?.segment_id);
      if (!Number.isInteger(index) || mapping.has(sourceId)) continue;
      mapping.set(sourceId, index); bound.add(index);
    }
    const rows = []; let cursor = 0;
    mainSegments.forEach((segment, mainIndex) => {
      while (cursor < extensionSegments.length && !bound.has(cursor) && extensionSegments[cursor].start <= segment.start) rows.push({ mainIndex: null, extensionIndex: cursor++ });
      rows.push({ mainIndex, extensionIndex: mapping.get(segment.id) ?? null });
    });
    while (cursor < extensionSegments.length) { if (!bound.has(cursor)) rows.push({ mainIndex: null, extensionIndex: cursor }); cursor++; }
    return rows;
  }
  function resolveMergedGroupInheritance(segments, indexes, kind) {
    const field = `${kind}_group_id`; const groupId = indexes.length ? segments[indexes[0]]?.[field] : null;
    return { groupId: groupId && indexes.every(index => segments[index]?.[field] === groupId) ? groupId : null,
      head: null, ref: null, headIdx: null };
  }
  return Object.freeze({ MULTI_SUBTITLE_DISPLAY_MODES, MULTI_SUBTITLE_SPLIT_MODES, MULTI_SUBTITLE_TOLERANCE_MS,
    bindingForSegment, buildMultiDisplayRows, buildSubtitleBinding, matchSubtitleSegments, mergeMainAndOverlaySegments,
    moveSegmentBetweenTracks, normalizeMultiSubtitleProject, rebuildBindingOffsets, removeSubtitleBindings,
    removeBindingsForSegments, resolveMergedGroupInheritance, swapMainAndExtensionSubtitle, ensureExtensionTrack, ensureOverlayTrack });
}

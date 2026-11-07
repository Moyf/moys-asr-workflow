export function unsupportedVariant(track) {
  return track?.role === 'overlay' && (track.variant ?? 'plain') !== 'plain';
}

export function isTrackEnabled(track, surface) {
  if (surface !== 'preview' && surface !== 'export') throw new Error('Unknown track surface');
  return Boolean(track && track.enabled === true && !unsupportedVariant(track)
    && (surface === 'preview' ? track.preview_visible !== false : track.export?.enabled !== false));
}

export function selectTracks(project, mode = 'main', surface = 'export', { includeOverlay = true } = {}) {
  const tracks = Array.isArray(project?.tracks) ? project.tracks : [];
  const main = tracks.find(track => track?.role === 'main');
  const overlay = tracks.find(track => track?.role === 'overlay');
  const secondary = project?.bilingual?.active_track_id
    ? tracks.find(track => track?.role === 'secondary' && track.id === project.bilingual.active_track_id)
    : tracks.find(track => track?.role === 'secondary');
  const selections = {
    main: [main, ...(includeOverlay ? [overlay] : [])], overlay: [overlay], extension: [secondary],
    main_and_extension: [main, ...(includeOverlay ? [overlay] : []), secondary], all: [main, overlay, secondary],
  };
  if (!Object.hasOwn(selections, mode)) throw new Error('Unknown subtitle track selection');
  return selections[mode].filter(track => isTrackEnabled(track, surface));
}

// Reject an unsupported selected overlay before filtering, so export cannot silently omit it.
export function assertExportable(project, mode = 'main', { includeOverlay = true } = {}) {
  const includesOverlay = mode === 'overlay' || mode === 'all'
    || (includeOverlay && (mode === 'main' || mode === 'main_and_extension'));
  const track = includesOverlay && project?.tracks?.find(item => item?.role === 'overlay');
  if (track?.enabled === true && track.export?.enabled !== false && unsupportedVariant(track)) {
    throw new Error(`不支持导出叠加轨“${track.name || track.id}”的类型“${track.variant}”；请关闭该轨或其导出开关`);
  }
}

export const TrackPolicy = Object.freeze({ isTrackEnabled, selectTracks, unsupportedVariant, assertExportable });

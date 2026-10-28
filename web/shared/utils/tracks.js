// v1 read protocol only. The project and its arrays remain the sole data tree.
// The assembler registers this factory; module evaluation has no side effects.
export function createTrackModule() {
  const MAIN_TRACK_ID = 'main';
  const OVERLAY_TRACK_ID = 'overlay';
  const secondaryTrackId = legacyId => `secondary:${legacyId}`;

  /** @typedef {{id: string, start?: number, end?: number, [key: string]: unknown}} Segment */
  /** @typedef {{segments?: Segment[], enabled?: boolean, id?: string, multi_subtitle?: {enabled?: boolean, tracks?: LegacySource[]}, overlay_track?: LegacySource}} LegacySource */
  /** @typedef {{track_id: string, segment_id: string}} CueRef */

  // Freeze only the descriptor. Never freeze, normalize, copy or annotate cues.
  function view(id, role, source, enabled, legacyId = null) {
    return Object.freeze({ id, role, legacyId, source,
      get segments() { return source.segments; },
      get enabled() { return enabled(); },
    });
  }

  class LegacyProjectAdapter {
    /** @param {LegacySource | (() => LegacySource)} project */
    constructor(project) {
      this._getProject = typeof project === 'function' ? project : () => project;
      Object.freeze(this);
    }

    get project() { return this._getProject(); }

    tracks() {
      const project = this.project;
      if (!project) return [];
      const tracks = [];
      if (Array.isArray(project.segments)) tracks.push(view(MAIN_TRACK_ID, 'main', project, () => true));
      const multi = project.multi_subtitle;
      for (const source of multi?.tracks || []) {
        if (typeof source?.id === 'string' && Array.isArray(source.segments)) {
          tracks.push(view(secondaryTrackId(source.id), 'secondary', source, () => multi.enabled === true, source.id));
        }
      }
      const overlay = project.overlay_track;
      if (Array.isArray(overlay?.segments)) tracks.push(view(OVERLAY_TRACK_ID, 'overlay', overlay, () => overlay.enabled === true));
      return tracks;
    }

    // Ambiguous track/cue IDs fail closed; IDs are never repaired on a read.
    getTrack(trackId) {
      const matches = this.tracks().filter(track => track.id === trackId);
      return matches.length === 1 ? matches[0] : null;
    }

    getSegments(trackId) { return this.getTrack(trackId)?.segments ?? null; }

    /** @param {CueRef} ref */
    resolve(ref) {
      if (!ref || typeof ref.track_id !== 'string' || typeof ref.segment_id !== 'string' || !ref.segment_id) return null;
      const track = this.getTrack(ref.track_id);
      if (!track) return null;
      let index = -1;
      for (let i = 0; i < track.segments.length; i += 1) {
        if (track.segments[i]?.id !== ref.segment_id) continue;
        if (index !== -1) return null;
        index = i;
      }
      return index < 0 ? null : Object.freeze({ track, index, segment: track.segments[index] });
    }

    // Old accessors return the original legacy container, not a TrackView.
    getLegacyExtensionTrack(trackId = null) {
      return (this.project?.multi_subtitle?.tracks || []).find(track => !trackId || track.id === trackId) || null;
    }

    getLegacyOverlayTrack() { return this.project?.overlay_track; }
  }

  return Object.freeze({ LegacyProjectAdapter, MAIN_TRACK_ID, OVERLAY_TRACK_ID, secondaryTrackId });
}

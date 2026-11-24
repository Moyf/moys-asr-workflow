// FCPXML titles-only frame plan. Only `ir` crosses the serialization boundary.
export function createUtilsModule(dependencies) {
  const {
    EXPORT_FRAME_PROFILES, buildGapRemovedIntervals, exportVideoSize, freezeExportValue,
    gapRemoveCore, projectExportCues, readExportGaps, resolveExportFrameProfile,
  } = dependencies;
  const tracks = ['main', 'extension', 'overlay'];
  const maxDurationMs = 7 * 24 * 60 * 60 * 1000;
  const maxLane = 128;

  function compressedClock(durationMs, gaps) {
    let outputDurationMs = 0;
    const intervals = buildGapRemovedIntervals(durationMs, gaps).map(({ start, end }) => {
      const outputStart = outputDurationMs;
      outputDurationMs += end - start;
      return { start, end, outputStart };
    });
    function mapTime(ms) {
      // Find the first kept interval ending after this point. In a removed
      // interval, both sides map to the same output cut boundary.
      let low = 0, high = intervals.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (intervals[middle].end <= ms) low = middle + 1;
        else high = middle;
      }
      const interval = intervals[low];
      return interval ? interval.outputStart + Math.max(0, ms - interval.start) : outputDurationMs;
    }
    return { mapTime, outputDurationMs };
  }

  function buildFcpxmlTitlePlan(project, options = {}) {
    if (!project || typeof project !== 'object') throw new Error('invalid FCPXML project');
    const mode = options.timelineMode ?? 'source';
    if (mode !== 'source' && mode !== 'gap_removed') throw new Error('unsupported FCPXML timeline');
    const fps = String(options.fps ?? 30);
    if (!Object.hasOwn(EXPORT_FRAME_PROFILES, fps)) throw new Error('unsupported FCPXML FPS');
    const profile = resolveExportFrameProfile(fps);
    const name = options.baseName ?? 'MAW Titles';
    if (typeof name !== 'string' || !name.trim()) throw new Error('invalid FCPXML project name');
    const size = exportVideoSize(project) ?? { width: 1920, height: 1080 };
    const width = options.width ?? size.width;
    const height = options.height ?? size.height;
    if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192)) {
      throw new Error('invalid FCPXML dimensions');
    }
    const requestedTracks = options.tracks ?? tracks;
    if (!Array.isArray(requestedTracks) || !requestedTracks.length
        || requestedTracks.some((track) => !tracks.includes(track))
        || new Set(requestedTracks).size !== requestedTracks.length) {
      throw new Error('invalid FCPXML tracks');
    }
    const selectedTracks = tracks.filter((track) => requestedTracks.includes(track));
    const warnings = [];
    const rawGaps = readExportGaps(project.gaps !== undefined ? project.gaps : project.gap_remove?.gaps);
    const gaps = project.gaps === undefined && project.gap_remove?.provenance
      ? gapRemoveCore.normalizeGapRemoveData(project.gap_remove).gaps : rawGaps;
    const projected = projectExportCues(project, options, warnings, null, options.extensionTrackId ?? null).cues;
    const cues = tracks.flatMap((track) => projected[track]).filter((cue) => cue.text.trim());
    let sourceDurationMs = options.durationMs ?? project.waveform?.duration_ms ?? project.duration_ms
      ?? project.media?.durationMs ?? project.media?.duration_ms;
    if (sourceDurationMs == null) {
      sourceDurationMs = cues.reduce((tail, cue) => Math.max(tail, cue.sourceEndMs), 0);
      sourceDurationMs = gaps.reduce((tail, gap) => gap.removed === false ? tail : Math.max(tail, gap.end), sourceDurationMs);
      warnings.push({ code: 'inferred_source_duration' });
    }
    if (!Number.isInteger(sourceDurationMs) || sourceDurationMs < 0 || sourceDurationMs > maxDurationMs) {
      throw new Error('invalid FCPXML duration');
    }
    if (mode === 'gap_removed' && !gaps.some((gap) => gap.removed !== false && gap.start < sourceDurationMs)) {
      warnings.push({ code: 'no_removed_gaps' });
    }
    const { mapTime, outputDurationMs } = mode === 'source'
      ? { mapTime: (ms) => ms, outputDurationMs: sourceDurationMs }
      : compressedClock(sourceDurationMs, gaps);
    // The duration limit keeps all integer products below MAX_SAFE_INTEGER.
    const frames = (ms, round) => round(ms * profile.numerator / (1000 * profile.denominator));
    const durationFrames = frames(outputDurationMs, Math.ceil);
    const titles = [];
    let nextLane = 1;
    for (const track of selectedTracks) {
      const pending = [];
      for (const cue of cues) {
        if (cue.track !== track) continue;
        const { sourceStartMs, sourceEndMs, text, index } = cue;
        const startMs = mapTime(Math.min(sourceStartMs, sourceDurationMs));
        const endMs = mapTime(Math.min(sourceEndMs, sourceDurationMs));
        // Discard collapsed cues before floor/ceil can turn them into a frame.
        if (endMs <= startMs) {
          warnings.push({ code: 'fully_removed_cue', track, index });
          continue;
        }
        if (sourceEndMs > sourceDurationMs) warnings.push({ code: 'clamped_cue_to_duration', track, index });
        pending.push({ startFrame: frames(startMs, Math.floor), endFrame: frames(endMs, Math.ceil), text, index });
      }
      pending.sort((a, b) => a.startFrame - b.startFrame || a.index - b.index);
      const laneEnds = [];
      for (const { startFrame, endFrame, text } of pending) {
        let slot = laneEnds.findIndex((end) => end <= startFrame);
        if (slot === -1) slot = laneEnds.length;
        const lane = nextLane + slot;
        if (lane > maxLane) throw new Error('too many overlapping FCPXML titles');
        laneEnds[slot] = endFrame;
        titles.push({ startFrame, endFrame, lane, text });
      }
      nextLane += laneEnds.length;
    }
    if (!titles.length) throw new Error('no exportable FCPXML titles');
    titles.sort((a, b) => a.startFrame - b.startFrame || a.lane - b.lane);
    return freezeExportValue({
      ir: { version: '1.13', name, fps, width, height, durationFrames, titles },
      mode, sourceDurationMs, outputDurationMs, selectedTracks, warnings,
    });
  }

  return Object.freeze({ buildFcpxmlTitlePlan });
}

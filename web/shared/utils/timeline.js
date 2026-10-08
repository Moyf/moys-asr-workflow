// timeline: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-timeline', function createUtilsModule(dependencies) {
  'use strict';
  const { clampInteger, escapeSplitTrimPatternSource } = dependencies;


  // 字幕编辑的时间基准。工程仍以整数毫秒保存兼容字段；帧字段是按工程
  // FPS 计算的平行时间轴，用于需要逐帧定位的编辑操作。
  const TIMELINE_TIMEBASE_UNITS = Object.freeze(['milliseconds', 'frames']);

  const DEFAULT_TIMELINE_FPS = 30;

  const DEFAULT_TIMELINE_TIMECODE_SEPARATOR = ':';

  const MIN_TIMELINE_FPS = 1;

  const MAX_TIMELINE_FPS = 240;


  function normalizeTimelineFps(value, fallback = DEFAULT_TIMELINE_FPS) {
    const fallbackValue = Number.isFinite(Number(fallback))
      ? Number(fallback) : DEFAULT_TIMELINE_FPS;
    const numeric = Number(value);
    const safe = Number.isFinite(numeric) ? numeric : fallbackValue;
    return Math.min(
      MAX_TIMELINE_FPS,
      Math.max(MIN_TIMELINE_FPS, Math.round(safe * 1000) / 1000),
    );
  }


  function normalizeTimelineTimecodeSeparator(value, fallback = DEFAULT_TIMELINE_TIMECODE_SEPARATOR) {
    const fallbackCandidate = Array.from(String(fallback ?? '').trim())[0] || '';
    const safeFallback = fallbackCandidate && !/[\p{Letter}\p{Number}\s]/u.test(fallbackCandidate)
      ? fallbackCandidate : DEFAULT_TIMELINE_TIMECODE_SEPARATOR;
    const candidate = Array.from(String(value ?? '').trim())[0] || '';
    return candidate && !/[\p{Letter}\p{Number}\s]/u.test(candidate) ? candidate : safeFallback;
  }


  function normalizeTimelineTimebase(value, fallback = {}) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const fallbackRaw = fallback && typeof fallback === 'object' ? fallback : {};
    const fallbackUnit = TIMELINE_TIMEBASE_UNITS.includes(fallbackRaw.unit)
      ? fallbackRaw.unit : 'milliseconds';
    return {
      unit: TIMELINE_TIMEBASE_UNITS.includes(raw.unit) ? raw.unit : fallbackUnit,
      fps: normalizeTimelineFps(raw.fps, fallbackRaw.fps ?? DEFAULT_TIMELINE_FPS),
    };
  }


  function normalizeMediaMetadata(value) {
    if (value == null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const hasVideoWidth = value.video_width !== undefined;
    const hasVideoHeight = value.video_height !== undefined;
    const hasVideoDimensions = hasVideoWidth || hasVideoHeight;
    if (hasVideoWidth !== hasVideoHeight) return null;
    if (hasVideoDimensions
        && (!Number.isInteger(value.video_width) || value.video_width <= 0
          || !Number.isInteger(value.video_height) || value.video_height <= 0)) return null;
    const hasFps = value.video_fps !== undefined;
    const fps = value.video_fps;
    if (hasFps && (typeof fps !== 'number' || !Number.isFinite(fps)
        || fps < MIN_TIMELINE_FPS || fps > MAX_TIMELINE_FPS)) return null;
    if (value.video_fps_ratio !== undefined
        && (!hasFps || typeof value.video_fps_ratio !== 'string' || !value.video_fps_ratio.trim())) return null;
    const hasAudioTracks = value.audio_tracks !== undefined;
    if (hasAudioTracks && !Array.isArray(value.audio_tracks)) return null;
    const hasSelectedAudioTrack = value.selected_audio_track !== undefined;
    if (hasSelectedAudioTrack
        && (!Number.isInteger(value.selected_audio_track) || value.selected_audio_track < 0)) return null;
    if (!hasFps && !hasAudioTracks && !hasSelectedAudioTrack && !hasVideoDimensions) return null;
    const metadata = {};
    if (hasVideoDimensions) {
      metadata.video_width = value.video_width;
      metadata.video_height = value.video_height;
    }
    if (hasFps) metadata.video_fps = normalizeTimelineFps(fps);
    if (typeof value.video_fps_ratio === 'string') {
      metadata.video_fps_ratio = value.video_fps_ratio.trim();
    }
    if (hasAudioTracks) {
      const audioTracks = value.audio_tracks.map((track, index) => {
        if (!track || typeof track !== 'object' || Array.isArray(track)) return null;
        const streamIndex = track.stream_index;
        if (!Number.isInteger(streamIndex) || streamIndex < 0) return null;
        const audioIndex = track.audio_index === undefined ? index : track.audio_index;
        if (!Number.isInteger(audioIndex) || audioIndex < 0) return null;
        const normalized = { audio_index: audioIndex, stream_index: streamIndex };
        for (const field of ['codec', 'language', 'title']) {
          if (track[field] !== undefined && typeof track[field] !== 'string') return null;
          if (typeof track[field] === 'string') normalized[field] = track[field].trim();
        }
        for (const field of ['channels', 'sample_rate']) {
          if (track[field] !== undefined && track[field] !== null
              && (!Number.isInteger(track[field]) || track[field] <= 0)) return null;
          normalized[field] = track[field] ?? null;
        }
        if (track.default !== undefined && typeof track.default !== 'boolean') return null;
        normalized.default = track.default === true;
        return normalized;
      });
      if (audioTracks.some((track) => track === null)) return null;
      metadata.audio_tracks = audioTracks;
    }
    if (hasSelectedAudioTrack) metadata.selected_audio_track = value.selected_audio_track;
    return metadata;
  }


  function frameNumberFromMilliseconds(value, fps = DEFAULT_TIMELINE_FPS) {
    const numeric = Number(value);
    const rate = normalizeTimelineFps(fps);
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric * rate / 1000)) : 0;
  }


  function millisecondsFromFrameNumber(value, fps = DEFAULT_TIMELINE_FPS) {
    const frame = Number(value);
    const rate = normalizeTimelineFps(fps);
    return Number.isFinite(frame) ? Math.max(0, Math.round(frame * 1000 / rate)) : 0;
  }


  function nominalTimecodeFps(fps = DEFAULT_TIMELINE_FPS) {
    return Math.max(1, Math.round(normalizeTimelineFps(fps)));
  }


  function formatFrameTimecode(
    value,
    fps = DEFAULT_TIMELINE_FPS,
    separator = DEFAULT_TIMELINE_TIMECODE_SEPARATOR,
  ) {
    const nominalFps = nominalTimecodeFps(fps);
    const totalFrames = Math.max(0, Math.round(Number(value) || 0));
    const frame = totalFrames % nominalFps;
    const totalSeconds = Math.floor(totalFrames / nominalFps);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const pad = (number, width) => String(number).padStart(width, '0');
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${
      normalizeTimelineTimecodeSeparator(separator)
    }${pad(frame, 2)}`;
  }


  function formatTimelineTimecode(
    valueMs,
    fps = DEFAULT_TIMELINE_FPS,
    separator = DEFAULT_TIMELINE_TIMECODE_SEPARATOR,
  ) {
    return formatFrameTimecode(frameNumberFromMilliseconds(valueMs, fps), fps, separator);
  }


  function parseFrameTimecode(
    value,
    fps = DEFAULT_TIMELINE_FPS,
    separator = DEFAULT_TIMELINE_TIMECODE_SEPARATOR,
  ) {
    const raw = String(value || '').trim();
    const frameSeparator = normalizeTimelineTimecodeSeparator(separator);
    const escapedSeparator = escapeSplitTrimPatternSource(frameSeparator);
    const match = new RegExp(
      '^(\\d+):(\\d{2}):(\\d{2})\\s*(?:' + escapedSeparator
        + '|;|,|/)\\s*(\\d{1,3})\\s*F?$',
      'iu',
    ).exec(raw);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const frame = Number(match[4]);
    const nominalFps = nominalTimecodeFps(fps);
    if (minutes >= 60 || seconds >= 60 || frame >= nominalFps) return null;
    return (((hours * 60 + minutes) * 60) + seconds) * nominalFps + frame;
  }


  function clampTimelineFrameStep(value, fallback = 1) {
    return clampInteger(value, fallback, 1, 240);
  }

  return Object.freeze({ DEFAULT_TIMELINE_FPS, DEFAULT_TIMELINE_TIMECODE_SEPARATOR, MAX_TIMELINE_FPS, MIN_TIMELINE_FPS, TIMELINE_TIMEBASE_UNITS, clampTimelineFrameStep, formatFrameTimecode, formatTimelineTimecode, frameNumberFromMilliseconds, millisecondsFromFrameNumber, normalizeMediaMetadata, normalizeTimelineFps, normalizeTimelineTimebase, normalizeTimelineTimecodeSeparator, parseFrameTimecode });
});

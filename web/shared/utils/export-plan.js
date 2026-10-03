// export-plan: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-export-plan', function createUtilsModule(dependencies) {
  'use strict';
  const { assDefaultFontFamily, buildGapRemovedIntervals, mapGapRemovedTime } = dependencies;


  const EXPORT_FRAME_PROFILES = Object.freeze({
    24: Object.freeze({ name: '24', numerator: 24, denominator: 1, fps: 24 }),
    25: Object.freeze({ name: '25', numerator: 25, denominator: 1, fps: 25 }),
    30: Object.freeze({ name: '30', numerator: 30, denominator: 1, fps: 30 }),
    '30000/1001': Object.freeze({ name: '30000/1001', numerator: 30000, denominator: 1001, fps: 30000 / 1001 }),
    50: Object.freeze({ name: '50', numerator: 50, denominator: 1, fps: 50 }),
    60: Object.freeze({ name: '60', numerator: 60, denominator: 1, fps: 60 }),
    '60000/1001': Object.freeze({ name: '60000/1001', numerator: 60000, denominator: 1001, fps: 60000 / 1001 }),
  });


  function resolveExportFrameProfile(fps, dropFrame = false) {
    if (typeof dropFrame !== 'boolean') throw new Error('drop-frame option must be boolean');
    const key = String(fps);
    const profile = EXPORT_FRAME_PROFILES[key];
    if (!profile) throw new Error(`unsupported export FPS: ${key}`);
    if (dropFrame) throw new Error(`drop-frame export is unsupported for ${key}`);
    return profile;
  }


  function exportMsToFrames(ms, fps, rounding = 'floor') {
    const profile = typeof fps === 'object' && fps?.numerator
      ? fps : resolveExportFrameProfile(fps, false);
    const value = Math.max(0, Number(ms)) * profile.numerator / (1000 * profile.denominator);
    if (!Number.isFinite(value)) throw new Error('invalid export time');
    if (rounding === 'ceil') return Math.max(1, Math.ceil(value));
    if (rounding !== 'floor') throw new Error(`unsupported frame rounding: ${rounding}`);
    return Math.max(0, Math.floor(value));
  }


  function mapExportTime(policy, sourceMs) {
    const source = Math.max(0, Math.round(Number(sourceMs) || 0));
    const mapped = policy.mode === 'source' ? source : mapGapRemovedTime(source, policy.gaps);
    return Math.min(policy.outputDurationMs ?? policy.sourceDurationMs, mapped);
  }


  function exportPolicyMsToFrames(policy, ms, rounding = 'floor') {
    return exportMsToFrames(ms, policy.profile, rounding);
  }


  const EXPORT_SUBTITLE_TRACKS = Object.freeze(['main', 'extension', 'overlay', 'both', 'main_and_extension', 'all']);

  const EXPORT_INVALID_NAME_CHARS = /[\\/<>:"|?*\u0000-\u001f]/g;

  const EXPORT_NAME_EXTENSIONS = new Set([
    '.mosp', '.json', '.srt', '.txt', '.ass', '.vtt', '.xml', '.ffconcat', '.otio', '.otioz',
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.m4v',
    '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.opus',
  ]);

  const EXPORT_OPTION_KEYS = Object.freeze([
    'timelineMode', 'mode', 'fps', 'dropFrame', 'nativeTextObjects', 'subtitleTracks', 'baseName',
  ]);


  function normalizeExportOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('export options must be an object');
    }
    Object.keys(options).sort().forEach((key) => {
      if (!EXPORT_OPTION_KEYS.includes(key)) throw new Error(`unknown export option: ${key}`);
    });
    const timelineMode = options.timelineMode ?? options.mode ?? 'gap_removed';
    if (timelineMode !== 'source' && timelineMode !== 'gap_removed') {
      throw new Error(`unsupported export mode: ${timelineMode}`);
    }
    const fps = String(options.fps ?? 30);
    resolveExportFrameProfile(fps, options.dropFrame === true);
    if (options.dropFrame !== undefined && typeof options.dropFrame !== 'boolean') {
      throw new Error('drop-frame option must be boolean');
    }
    const subtitleTracks = options.subtitleTracks ?? 'main';
    if (!EXPORT_SUBTITLE_TRACKS.includes(subtitleTracks)) {
      throw new Error(`unsupported subtitle tracks: ${subtitleTracks}`);
    }
    const nativeTextObjects = options.nativeTextObjects ?? false;
    if (typeof nativeTextObjects !== 'boolean') throw new Error('native text option must be boolean');
    const dropFrame = options.dropFrame ?? false;
    const baseName = String(options.baseName ?? 'maw-export').trim();
    if (!baseName || baseName === '.' || baseName === '..' || /[\u0000-\u001f]/.test(baseName)) {
      throw new Error('invalid export base name');
    }
    return Object.freeze({
      timelineMode, fps, dropFrame, nativeTextObjects,
      subtitleTracks: subtitleTracks === 'both' ? 'main_and_extension' : subtitleTracks, baseName,
    });
  }


  function sanitizeExportName(value) {
    const source = String(value ?? '');
    const lastDot = source.lastIndexOf('.');
    const extension = lastDot >= 0 ? source.slice(lastDot).toLowerCase() : '';
    const name = EXPORT_NAME_EXTENSIONS.has(extension) ? source.slice(0, lastDot) : source;
    const sanitized = name
      .replace(/[\\/]+/g, '_')
      .replace(/^[.]+/, '_')
      .replace(/\.\.(?=_|$)/g, '_')
      .replace(EXPORT_INVALID_NAME_CHARS, '_')
      .replace(/[. ]+$/, '')
      .trim();
    if (!sanitized || sanitized === '.' || sanitized === '..') throw new Error('invalid export base name');
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(sanitized)) return `_${sanitized}_`;
    return sanitized;
  }


  function buildExportNames(baseName) {
    const safeBaseName = sanitizeExportName(baseName);
    return Object.freeze({
      baseName: safeBaseName,
      files: Object.freeze({
        project: `${safeBaseName}.xml`,
        subtitles: `${safeBaseName}.srt`,
      }),
    });
  }


  function escapeExportXml(value) {
    const text = String(value ?? '');
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) {
        throw new Error('XML 1.0 forbidden control character');
      }
    }
    return text.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    }[character]));
  }


  function exportPathToFileUrl(value, { encodeDriveColon = false } = {}) {
    const source = String(value ?? '').trim();
    if (!source) throw new Error('missing export path');
    if (/^file:\/\//i.test(source)) {
      const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(source);
      if (!match) throw new Error('invalid file URL');
      const authority = match[1];
      const pathValue = match[2] || '';
      const driveUrlMatch = /^\/([A-Za-z]):\/(.*)$/.exec(pathValue);
      if (authority.toLowerCase() === 'localhost' && driveUrlMatch) {
        const encodedPath = driveUrlMatch[2].split('/').map((part) => encodeURIComponent(part)).join('/');
        const drive = encodeDriveColon ? `${driveUrlMatch[1]}%3A` : `${driveUrlMatch[1]}:`;
        return `file://localhost/${drive}/${encodedPath}`;
      }
      if (!authority && driveUrlMatch) {
        const encodedDrivePath = driveUrlMatch[2].split('/').map((part) => encodeURIComponent(part)).join('/');
        return `file://localhost/${driveUrlMatch[1]}:/${encodedDrivePath}`;
      }
      if (authority && !pathValue || authority && !/^\/[^/]+(?:\/|$)/.test(pathValue)) {
        throw new Error('UNC file URL must include a share');
      }
      const encodedPath = pathValue.split('/').map((part) => encodeURIComponent(part)).join('/');
      return `file://${authority}${encodedPath}`;
    }
    const normalized = source.replace(/\\/g, '/');
    const uncMatch = /^\/\/([^/]+)(\/.*)?$/.exec(normalized);
    if (uncMatch) {
      const uncPath = uncMatch[2] || '';
      if (!/^\/[^/]+(?:\/|$)/.test(uncPath)) throw new Error('UNC path must include a share');
      const encodedUncPath = uncPath.split('/').map((part) => encodeURIComponent(part)).join('/');
      return `file://${uncMatch[1]}${encodedUncPath}`;
    }
    const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalized);
    if (driveMatch) {
      const encodedDriveParts = driveMatch[2].split('/').map((part) => encodeURIComponent(part)).join('/');
      const drive = encodeDriveColon ? `${driveMatch[1]}%3A` : `${driveMatch[1]}:`;
      return `file://localhost/${drive}/${encodedDriveParts}`;
    }
    const withLeadingSlash = normalized;
    const rooted = withLeadingSlash.startsWith('/') ? withLeadingSlash : `/${withLeadingSlash}`;
    const encoded = rooted.split('/').map((part, index) => (
      index === 0 && part === '' ? '' : encodeURIComponent(part).replace(/^([A-Za-z])%3A$/, '$1:')
    )).join('/');
    return `file://${encoded}`;
  }


  function freezeExportValue(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    Object.values(value).forEach((child) => freezeExportValue(child, seen));
    return Object.freeze(value);
  }


  // schema §1.1：media_metadata.video_width / video_height 必须成对出现且为正整数。
  function exportVideoSize(project) {
    const width = Number(project?.media_metadata?.video_width);
    const height = Number(project?.media_metadata?.video_height);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return null;
    return { width, height };
  }


  function buildProjectExportPlan(project, options = {}) {
    if (!project || typeof project !== 'object') throw new Error('invalid export project');
    const media = project.media && typeof project.media === 'object' ? project.media : null;
    const mediaPath = String((typeof project.media === 'string' ? project.media : '')
      || media?.path || media?.mediaPath || '').trim();
    const durationValue = options.durationMs ?? project.waveform?.duration_ms ?? project.duration_ms
      ?? media?.durationMs ?? media?.duration_ms;
    const durationMs = durationValue;
    if (!mediaPath) throw new Error('missing export media path');
    if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error('missing export media duration');
    const requestedMode = options.timelineMode ?? options.mode ?? 'gap_removed';
    if (requestedMode !== 'source' && requestedMode !== 'gap_removed') {
      throw new Error(`unsupported export mode: ${requestedMode}`);
    }
    const mode = requestedMode;
    if (options.dropFrame !== undefined && typeof options.dropFrame !== 'boolean') {
      throw new Error('drop-frame option must be boolean');
    }
    const rawGaps = project.gaps !== undefined ? project.gaps : project.gap_remove?.gaps;
    if (rawGaps != null && !Array.isArray(rawGaps)) throw new Error('invalid export gaps');
    const malformedGap = (gap) => {
      const start = gap?.start;
      const end = gap?.end;
      return !Number.isInteger(start) || start < 0
        || !Number.isInteger(end) || end < 0 || end <= start;
    };
    if (Array.isArray(rawGaps) && rawGaps.some(malformedGap)) {
      throw new Error('invalid export gap interval');
    }
    const gaps = Array.isArray(rawGaps)
      ? rawGaps.map((gap) => ({
        start: Math.max(0, Math.round(Number(gap.start))),
        end: Math.max(0, Math.round(Number(gap.end))),
        removed: gap.removed !== false,
      }))
      : [];
    const keptIntervals = mode === 'source'
      ? [{ start: 0, end: durationMs }]
      : buildGapRemovedIntervals(durationMs, gaps);
    const outputDurationMs = keptIntervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    if (outputDurationMs <= 0) throw new Error('export has no kept media');
    const frameProfile = resolveExportFrameProfile(options.fps ?? 30, options.dropFrame === true);
    const mapSourceToOutput = (sourceMs) => mode === 'source'
      ? Math.max(0, Math.min(durationMs, Math.round(Number(sourceMs) || 0)))
      : mapGapRemovedTime(sourceMs, gaps);
    const warnings = [];
    if (mode === 'gap_removed' && !gaps.some((gap) => gap.removed)) warnings.push({ code: 'no_removed_gaps' });
    const projectSegments = Array.isArray(project.segments) ? project.segments : [];
    // schema §1.5：叠加轨 enabled=false 时保留数据但不显示也不导出。
    const projectOverlaySegments = project.overlay_track?.enabled === true
      && Array.isArray(project.overlay_track.segments)
      ? project.overlay_track.segments : [];
    const schemaExtension = Array.isArray(project.multi_subtitle?.tracks)
      ? project.multi_subtitle.tracks.flatMap((track) => Array.isArray(track?.segments) ? track.segments : [])
      : [];
    const projectExtension = project.multi_subtitle?.enabled === true
      ? schemaExtension
      : (project.multi_subtitle == null && Array.isArray(project.extensionSegments)
        ? project.extensionSegments : []);
    const projectCues = (segments, track) => segments.map((segment, index) => {
      if (!segment || segment.disabled) return null;
      const rawStart = Math.round(Number(segment.start));
      const rawEnd = Math.round(Number(segment.end));
      const start = Math.min(durationMs, Math.max(0, rawStart));
      const end = Math.min(durationMs, Math.max(start, rawEnd));
      if (!Number.isInteger(segment?.start) || segment.start < 0
        || !Number.isInteger(segment?.end) || segment.end < 0 || segment.end <= segment.start) {
        warnings.push({ code: 'invalid_cue', track, index });
        return null;
      }
      const mappedStart = mapSourceToOutput(start);
      const mappedEnd = mapSourceToOutput(end);
      if (mappedEnd <= mappedStart) {
        warnings.push({ code: 'fully_removed_cue', track, index });
        return null;
      }
      if (rawStart !== start || rawEnd !== end) warnings.push({ code: 'clamped_cue_to_duration', track, index });
      return {
        id: String(segment.id || `${track}-${index}`), track, index,
        text: String(segment.text || ''), sourceStartMs: start, sourceEndMs: end,
        startMs: mappedStart, endMs: mappedEnd,
      };
    }).filter(Boolean);
    const cues = {
      main: projectCues(projectSegments, 'main'),
      extension: projectCues(projectExtension, 'extension'),
      overlay: projectCues(projectOverlaySegments, 'overlay'),
    };
    const stickers = [];
    const stickerHeads = new Set();
    const stickerRoot = String(project.sticker_root || project.stickerRoot || '').trim().replace(/[\\/]$/, '');
    const resolveStickerPath = (sticker) => {
      const rawPath = String(sticker?.rel || sticker?.filename || sticker?.path || sticker?.url || '').trim();
      if (!rawPath || !stickerRoot || /^[A-Za-z]:[\\/]/.test(rawPath)
        || rawPath.startsWith('/') || rawPath.startsWith('file://')) return rawPath;
      return `${stickerRoot}/${rawPath.replace(/^[\\/]+/, '')}`;
    };
    // 收集一条轨的表情包：ref 在所在轨数组内解析 head（叠加轨的 ref 只引用
    // 叠加轨自身段）。track 用于区分主轨 stickers 与叠加轨 overlayStickers。
    const collectStickers = (segments, track, output) => {
      const heads = new Set();
      segments.forEach((segment, index) => {
        const reference = segment?.sticker_ref;
        const source = segment?.sticker || (reference && segments[reference.headIdx]?.sticker);
        if (reference && Number.isInteger(reference.headIdx)) {
          const head = segments[reference.headIdx];
          if (!head?.sticker || head.disabled || reference.headIdx === index) {
            warnings.push({ code: 'dangling_sticker_reference', track, index, headIdx: reference.headIdx });
            return;
          } else {
            const headName = String(head.sticker.name || head.sticker.filename || '').replace(/\.[^.]+$/, '');
            if (reference.name && headName && reference.name !== headName) {
              warnings.push({ code: 'stale_sticker_reference', track, index, headIdx: reference.headIdx });
            }
          }
        }
        if (!source || segment.disabled || (segment.sticker && heads.has(index))) return;
        if (segment.sticker) heads.add(index);
        const timing = segment.sticker || segment;
        const stickerStart = Number(timing.start);
        const stickerEnd = Number(timing.end);
        const rawStart = Math.round(Number.isFinite(stickerStart) ? stickerStart : Number(segment.start) || 0);
        const rawEnd = Math.round(Number.isFinite(stickerEnd) ? stickerEnd : Number(segment.end) || 0);
        const start = Math.min(durationMs, Math.max(0, rawStart));
        const end = Math.min(durationMs, Math.max(start, rawEnd));
        if (end <= start || mapSourceToOutput(end) <= mapSourceToOutput(start)) {
          warnings.push({ code: 'fully_removed_sticker', track, index });
          return;
        }
        const resolvedStickerPath = resolveStickerPath(source);
        if (!resolvedStickerPath) {
          warnings.push({ code: 'missing_sticker_path', track, index });
          return;
        }
        if (rawStart !== start || rawEnd !== end) warnings.push({ code: 'clamped_sticker_to_duration', track, index });
        output.push({
          headIndex: index, track, name: String(source.name || ''),
          path: resolvedStickerPath, width: Number.isInteger(source.width) ? source.width : 720,
          height: Number.isInteger(source.height) ? source.height : 480,
          sourceStartMs: start, sourceEndMs: end,
          startMs: mapSourceToOutput(start), endMs: mapSourceToOutput(end),
        });
      });
    };
    collectStickers(projectSegments, 'main', stickers);
    const overlayStickers = [];
    collectStickers(projectOverlaySegments, 'overlay', overlayStickers);
    if (cues.main.length === 0 && cues.extension.length === 0 && cues.overlay.length === 0) {
      warnings.push({ code: 'no_enabled_cues' });
    }
    warnings.sort((left, right) => left.code.localeCompare(right.code) || (left.index ?? 0) - (right.index ?? 0));
    const plan = {
      media: {
        path: mediaPath,
        type: String(media?.type || 'video'),
        durationMs,
        // 源视频尺寸（schema §1.1 media_metadata），供 FCP7 序列 format 声明；
        // 旧工程缺失时为 null，序列 format 回退 1920x1080 而不是 DV NTSC 默认。
        width: exportVideoSize(project)?.width ?? null,
        height: exportVideoSize(project)?.height ?? null,
      },
      mode, sourceDurationMs: durationMs, keptIntervals, outputDurationMs,
      mapping: { mode, sourceDurationMs: durationMs, outputDurationMs, gaps },
      framePolicy: { profile: frameProfile, rounding: ['floor', 'ceil'], dropFrame: false },
      cues, stickers, overlayStickers, warnings, frameProfile,
      subtitleFontFamily: premiereFontFamily(project.preview?.subtitle?.font_family),
    };
    Object.defineProperties(plan, {
      mapSourceToOutput: { value: (sourceMs) => mapExportTime(plan.mapping, sourceMs), enumerable: false },
      frameForMs: { value: (ms, rounding = 'floor') => exportMsToFrames(ms, frameProfile, rounding), enumerable: false },
    });
    return freezeExportValue(plan);
  }


  function assertExportPlan(plan) {
    if (!plan || typeof plan !== 'object') throw new Error('invalid export plan');
    if (!plan.media || !String(plan.media.path || '').trim()) throw new Error('missing export media path');
    if (!Number.isInteger(plan.sourceDurationMs) || plan.sourceDurationMs <= 0) {
      throw new Error('missing export media duration');
    }
    if (!plan.frameProfile || !Number.isInteger(plan.frameProfile.numerator)
      || !Number.isInteger(plan.frameProfile.denominator)) {
      throw new Error('missing export frame profile');
    }
    if (!Number.isInteger(plan.outputDurationMs) || plan.outputDurationMs <= 0) {
      throw new Error('invalid export plan duration');
    }
    if (!Array.isArray(plan.keptIntervals) || !plan.keptIntervals.length
      || plan.keptIntervals.some((interval) => !Number.isInteger(interval?.start)
        || !Number.isInteger(interval?.end) || interval.end <= interval.start)) {
      throw new Error('empty export interval');
    }
    const outputDuration = plan.outputDurationMs;
    const cueLists = [plan.cues?.main, plan.cues?.extension, plan.cues?.overlay].filter(Array.isArray);
    if (cueLists.flat().some((cue) => cue.startMs < 0 || cue.endMs > outputDuration || cue.endMs <= cue.startMs)) {
      throw new Error('export cue outside output duration');
    }
    // 主轨与叠加轨的表情包导出计划共用同一条时间校验，非法计划不允许过校验关。
    const stickerLists = [plan.stickers, plan.overlayStickers].filter(Array.isArray);
    if (stickerLists.flat().some((sticker) => (
      sticker.startMs < 0 || sticker.endMs > outputDuration || sticker.endMs <= sticker.startMs
    ))) throw new Error('export sticker outside output duration');
    return plan;
  }


  function exportPlanFrame(plan, ms, rounding) {
    return exportMsToFrames(ms, plan.frameProfile, rounding);
  }


  function formatSrtTime(ms) {
    const value = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(value / 3600000);
    const minutes = Math.floor((value % 3600000) / 60000);
    const seconds = Math.floor((value % 60000) / 1000);
    const milliseconds = value % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
  }


  function selectedSubtitleTracks(plan, subtitleTracks) {
    const selected = subtitleTracks === 'main_and_extension' || subtitleTracks === 'both'
      ? ['main', 'extension']
      : subtitleTracks === 'all'
        ? ['main', 'extension', 'overlay']
        : subtitleTracks === 'overlay'
          ? ['overlay']
          : subtitleTracks === 'extension' ? ['extension'] : ['main'];
    return selected.flatMap((track) => Array.isArray(plan.cues?.[track]) ? plan.cues[track] : []);
  }


  function serializeMappedSrt(plan, options = {}) {
    const exportPlan = assertExportPlan(plan);
    if (options.subtitleTracks !== undefined && !EXPORT_SUBTITLE_TRACKS.includes(options.subtitleTracks)) {
      throw new Error(`unsupported subtitle tracks: ${options.subtitleTracks}`);
    }
    const tracks = selectedSubtitleTracks(exportPlan, options.subtitleTracks || 'main');
    return `${tracks.map((cue, index) => {
      const start = Math.max(0, Math.round(Number(cue.startMs) || 0));
      const end = Math.max(start + 1, Math.round(Number(cue.endMs) || 0));
      return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${String(cue.text || '')}\n`;
    }).join('\n')}`;
  }


  function premiereFontFamily(value) {
    const key = String(value ?? '').trim();
    // 未选择字体（default）时不能给中文字幕配 Arial——按平台落到系统 CJK 字体，
    // 与 ASS 导出的默认字体策略一致；sans 预设的预览栈本身以 Arial 开头。
    return ({
      default: assDefaultFontFamily(),
      yahei: 'Microsoft YaHei',
      hei: 'SimHei',
      song: 'FangSong',
      sans: 'Arial',
    })[key] || key || assDefaultFontFamily();
  }

  return Object.freeze({ EXPORT_FRAME_PROFILES, EXPORT_SUBTITLE_TRACKS, assertExportPlan, buildExportNames, buildProjectExportPlan, escapeExportXml, exportMsToFrames, exportPathToFileUrl, exportPlanFrame, exportPolicyMsToFrames, exportVideoSize, freezeExportValue, mapExportTime, normalizeExportOptions, resolveExportFrameProfile, sanitizeExportName, selectedSubtitleTracks, serializeMappedSrt });
});

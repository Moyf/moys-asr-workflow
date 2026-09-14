// 时间线导出：工作区 JSON、Resolve/OTIO/otioz 与下载拷贝工具。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweExportTimeline 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweExportTimeline(global) {
  'use strict';



  function buildWorkspaceJson() {
    const workspace = buildCurrentWorkspaceData();
    return JSON.stringify(workspace || {}, null, 2);
  }



  function buildCurrentWorkspaceData() {
    const workspace = MaweCoreState.waveformEditor?.getLayoutData?.() || MaweBoot.DATA.workspace;
    if (!workspace) return workspace;
    const selectedPreset = MaweWorkspaces.currentServerWorkspaceName
      ? `saved:${MaweWorkspaces.currentServerWorkspaceName}`
      : MaweWorkspaces.currentBuiltinWorkspaceName || MaweWorkspaces.workspacePresetSelect?.value || workspace.preset;
    return { ...workspace, selectedPreset, editorDisplay: MaweDisplaySettings.getEditorDisplaySettings() };
  }



  function buildResolveJson() {
    const segments = MaweBoot.DATA.segments.map((seg, idx) => {
      const headIdx = seg.sticker_ref?.headIdx;
      const head = Number.isInteger(headIdx) ? MaweBoot.DATA.segments[headIdx] : null;
      const validStickerRef = !seg.sticker_ref || (head && !head.disabled && headIdx < idx);
      const headSticker = !seg.disabled && validStickerRef ? seg.sticker || head?.sticker : null;
      const sticker = headSticker ? { ...headSticker, start: seg.start, end: seg.end } : null;
      if (sticker) {
        const absPath = MaweSelection.stickerAbsPath(sticker);
        if (absPath) sticker.abs_path = absPath;
      }
      const colorName = seg.color?.name || seg.color_ref?.name || null;
      return {
        idx,
        start_ms: seg.start,
        end_ms: seg.end,
        text: seg.text || '',
        color: seg.color || null,
        color_ref: seg.color_ref || null,
        resolve_color: colorName,
        sticker,
        sticker_ref: validStickerRef ? seg.sticker_ref || null : null,
      };
    });
    const colorCount = segments.filter(s => s.resolve_color).length;
    const stickerCount = segments.filter(s => s.sticker).length;
    if (!colorCount && !stickerCount) {
      MaweHint.flashHint('没有颜色或表情包配置，无法导出 Resolve JSON', 'invalid');
      return null;
    }
    return JSON.stringify({
      schema: 'moy.asr_subtitle_editor.resolve.v1',
      source: 'moys-asr-workflow',
      filename_base: MaweBoot.FILENAME_BASE,
      media: MaweBoot.DATA.media || '',
      sticker_root: MaweBoot.STICKER_ROOT || '',
      color_palette: MaweColors.COLOR_PALETTE,
      segments,
    }, null, 2);
  }


  const OTIO_STICKER_FPS = 60;



  function otioTime(frames, fps = OTIO_STICKER_FPS) {
    return {
      OTIO_SCHEMA: 'RationalTime.1',
      rate: fps,
      value: Number(frames),
    };
  }



  function otioTimeRange(startFrames, durationFrames, fps = OTIO_STICKER_FPS) {
    return {
      OTIO_SCHEMA: 'TimeRange.1',
      duration: otioTime(durationFrames, fps),
      start_time: otioTime(startFrames, fps),
    };
  }



  function msToOtioFrames(ms, fps = OTIO_STICKER_FPS) {
    return Math.round(ms / 1000 * fps);
  }



  function mediaStartOtioFrames() {
    const reference = MaweBoot.DATA.media_time_reference;
    const sampleRate = Number(reference?.sample_rate);
    const samples = Number(reference?.time_reference_samples);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0
        || !Number.isFinite(samples) || samples < 0) {
      return 0;
    }
    return samples / sampleRate * OTIO_STICKER_FPS;
  }



  const OTIO_MARKER_COLORS = Object.freeze({
    yellow: 'YELLOW',
    green: 'GREEN',
    red: 'RED',
    purple: 'PURPLE',
    blue: 'BLUE',
  });


  const OTIO_DEFAULT_MARKER_COLOR = 'WHITE';



  function buildGapRemovedSubtitleMarkers(interval, sourceStartFrame = 0) {
    const intervalStartMs = Math.max(0, Math.round(Number(interval?.start) || 0));
    const intervalEndMs = Math.max(
      intervalStartMs,
      Math.round(Number(interval?.end) || 0),
    );
    const clipStartFrame = msToOtioFrames(intervalStartMs);
    const clipEndFrame = msToOtioFrames(intervalEndMs);
    if (clipEndFrame <= clipStartFrame) return [];

    return MaweBoot.DATA.segments.flatMap((segment) => {
      if (!segment || segment.disabled) return [];
      const segmentStartMs = Number(segment.start);
      const segmentEndMs = Number(segment.end);
      if (!Number.isFinite(segmentStartMs) || !Number.isFinite(segmentEndMs)
          || segmentEndMs <= segmentStartMs) {
        return [];
      }
      const startMs = Math.max(intervalStartMs, segmentStartMs);
      const endMs = Math.min(intervalEndMs, segmentEndMs);
      if (endMs <= startMs) return [];

      const markerStartFrame = sourceStartFrame + msToOtioFrames(startMs);
      const markerEndFrame = sourceStartFrame + msToOtioFrames(endMs);
      if (markerEndFrame <= markerStartFrame) return [];

      const colorName = window.AsrEditorUtils.effectiveColorName(segment, MaweBoot.DATA.segments);
      return [{
        OTIO_SCHEMA: 'Marker.2',
        metadata: {},
        name: String(segment.text || ''),
        color: OTIO_MARKER_COLORS[colorName] || OTIO_DEFAULT_MARKER_COLOR,
        marked_range: otioTimeRange(
          markerStartFrame,
          markerEndFrame - markerStartFrame,
        ),
      }];
    });
  }



  function stickerTargetUrl(absPath) {
    let value = String(absPath || '').trim();
    if (!value) return '';
    if (value.startsWith('file://')) {
      value = value.replace(/^file:\/+/, '');
      if (/^[A-Za-z]:/.test(value)) return `file:///${value.replace(/\\/g, '/')}`;
      return `file:///${value.replace(/^\/+/, '').replace(/\\/g, '/')}`;
    }
    value = value.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(value)) return `file:///${value}`;
    return `file:///${value.replace(/^\/+/, '')}`;
  }



  function mediaTargetUrl() {
    const media = String(MaweBoot.DATA.media || '').trim();
    if (/^file:\/\//i.test(media) || /^[A-Za-z]:[\\/]/.test(media) || media.startsWith('/')) {
      return stickerTargetUrl(media);
    }
    const current = String(MaweCoreState.player?.currentSrc || '').trim();
    if (/^file:\/\//i.test(current)) return current;
    return '';
  }



  function buildTimelineMediaClip(
    interval, index, kind, targetUrl, sourceStartFrame, sourceDurationFrames,
    {
      includeSubtitleMarkers = false,
      gapRemoved = false,
      audioTrack = null,
      audioTrackIndex = 0,
      clipName = '',
    } = {},
  ) {
    const startFrame = msToOtioFrames(interval.start);
    const endFrame = msToOtioFrames(interval.end);
    const durationFrames = Math.max(1, endFrame - startFrame);
    const audioMetadata = otioAudioTrackMetadata(audioTrack, audioTrackIndex);
    const clipMetadata = {
      ...(gapRemoved ? {
        moy: {
          gap_remove_source_start_ms: interval.start,
          gap_remove_source_end_ms: interval.end,
          gap_remove_sequence_index: index,
          ...(audioMetadata.moy || {}),
        },
      } : audioMetadata),
      ...resolveOtioClipMetadata(kind, audioTrack, audioTrackIndex, index + 1),
    };
    return {
      OTIO_SCHEMA: 'Clip.2',
      metadata: clipMetadata,
      name: clipName || `${kind} ${index + 1}`,
      source_range: otioTimeRange(sourceStartFrame + startFrame, durationFrames),
      effects: [],
      markers: includeSubtitleMarkers
        ? buildGapRemovedSubtitleMarkers(interval, sourceStartFrame)
        : [],
      enabled: true,
      color: null,
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: 'ExternalReference.1',
          metadata: audioMetadata,
          name: clipName,
          available_range: otioTimeRange(sourceStartFrame, sourceDurationFrames),
          available_image_bounds: null,
          target_url: targetUrl,
        },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
    };
  }



  function buildTimelineOtio({
    gapRemoved = false,
    includeStickers = false,
    includeSubtitleMarkers = true,
  } = {}) {
    const removed = gapRemoved ? MaweGapRemoveData.getRemovedGapRanges() : [];
    if (gapRemoved && !removed.length) {
      MaweHint.flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
      return null;
    }
    const durationMs = MaweCoreState.waveformEditor?.durationMs || Math.round(Number(MaweCoreState.player?.duration) * 1000) || 0;
    if (!durationMs) {
      MaweHint.flashHint('媒体时长尚不可用；请先加载媒体后再导出 OTIO', 'invalid');
      return null;
    }
    const targetUrl = mediaTargetUrl();
    if (!targetUrl) {
      MaweHint.flashHint('无法获得媒体绝对路径；请用 edit.py / server-editor 打开工程后再导出 OTIO', 'invalid');
      return null;
    }
    const intervals = gapRemoved
      ? window.AsrEditorUtils.buildGapRemovedIntervals(durationMs, removed)
      : [{ start: 0, end: durationMs }];
    if (!intervals.length) {
      MaweHint.flashHint(
        gapRemoved ? '移除静音空隙后没有剩余媒体，无法导出 OTIO' : '媒体时长不可用，无法导出 OTIO',
        'warning',
      );
      return null;
    }
    const sourceDurationFrames = Math.max(1, msToOtioFrames(durationMs));
    const sourceStartFrame = mediaStartOtioFrames();
    const mediaMetadata = MaweTimeline.normalizeMediaMetadata(MaweBoot.DATA.media_metadata);
    const audioMetadata = Array.isArray(mediaMetadata?.audio_tracks)
      ? mediaMetadata.audio_tracks : null;
    const clipName = otioMediaName(targetUrl);
    const audioEntries = audioMetadata === null
      ? [{ audioTrack: null, index: 0 }]
      : audioMetadata.map((audioTrack, index) => ({ audioTrack, index }));
    const audioSpecs = audioEntries.length || MaweCoreState.player?.tagName !== 'AUDIO'
      ? audioEntries.map(({ audioTrack, index }) => ({
        name: otioAudioTrackName(audioTrack, index, audioEntries.length),
        kind: 'Audio',
        audioTrack,
        audioTrackIndex: index,
      }))
      : [{ name: '音频', kind: 'Audio', audioTrack: null, audioTrackIndex: 0 }];
    const trackSpecs = MaweCoreState.player?.tagName === 'AUDIO'
      ? audioSpecs
      : [{ name: '视频', kind: 'Video', audioTrack: null, audioTrackIndex: 0 }, ...audioSpecs];
    const tracks = trackSpecs.map((track, trackIndex) => ({
      OTIO_SCHEMA: 'Track.1',
      metadata: {
        ...otioAudioTrackMetadata(track.audioTrack, track.audioTrackIndex),
        ...resolveOtioTrackMetadata(track.kind, track.audioTrack),
      },
      name: track.name,
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      color: null,
      children: intervals.map((interval, index) => buildTimelineMediaClip(
        interval,
        index,
        track.kind,
        targetUrl,
        sourceStartFrame,
        sourceDurationFrames,
        {
          includeSubtitleMarkers: includeSubtitleMarkers && (
            track.kind === 'Video'
            || (track.kind === 'Audio' && MaweCoreState.player?.tagName === 'AUDIO' && trackIndex === 0)
          ),
          gapRemoved,
          audioTrack: track.audioTrack,
          audioTrackIndex: track.audioTrackIndex,
          clipName,
        },
      )),
      kind: track.kind,
    }));
    // 勾选「时间线包含表情包」时，把表情包作为叠加视频轨合并进同一个 OTIO 时间线；
    // 没有表情包时静默跳过，仅保留时间线本体。
    if (includeStickers) {
      const collected = collectStickerOtioEntries(removed);
      if (collected.error) {
        MaweHint.flashHint(collected.error, 'warning');
        return null;
      }
      if (collected.entries.length) {
        const stickerTrack = buildStickerOtioTrack(collected.entries);
        if (stickerTrack.error) {
          MaweHint.flashHint(stickerTrack.error, 'warning');
          return null;
        }
        tracks.push(stickerTrack.track);
      }
    }
    const metadata = {
      moy: {
        source_media: targetUrl,
        ...(audioMetadata !== null ? {
          audio_tracks: audioMetadata.map((audioTrack, index) => ({
            ...otioAudioTrackMetadata(audioTrack, index).moy,
          })),
        } : {}),
        ...(gapRemoved ? {
          gap_remove_schema: MaweSettings.GAP_REMOVE_SCHEMA,
          removed_gaps_ms: removed,
        } : {}),
      },
      Resolve_OTIO: {
        'Resolve OTIO Meta Version': '1.0',
      },
    };
    return JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      metadata,
      name: gapRemoved ? `${MaweBoot.FILENAME_BASE}_去空隙` : MaweBoot.FILENAME_BASE,
      global_start_time: otioTime(0),
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        metadata: {},
        name: 'tracks',
        source_range: null,
        effects: [],
        markers: [],
        enabled: true,
        color: null,
        children: tracks,
      },
    }, null, 4);
  }



  function buildSourceOtio() {
    return buildTimelineOtio({
      gapRemoved: false,
      includeStickers: MaweSettings.EDITOR_SETTINGS.otioExportIncludeStickers,
      includeSubtitleMarkers: MaweSettings.EDITOR_SETTINGS.otioExportIncludeMarkers,
    });
  }



  function buildGapRemovedOtio() {
    return buildTimelineOtio({
      gapRemoved: true,
      includeStickers: MaweSettings.EDITOR_SETTINGS.otioExportIncludeStickers,
      includeSubtitleMarkers: MaweSettings.EDITOR_SETTINGS.otioExportIncludeMarkers,
    });
  }



  function stickerOtioName(sticker, absPath) {
    if (sticker?.name) return sticker.name;
    if (sticker?.filename) return sticker.filename.replace(/\.[^.]+$/, '');
    return String(absPath || 'sticker').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  }



  function buildStickerOtio() {
    // 传空数组而非 null：函数体内用 removed.length 判断是否走去空隙映射分支，
    // 空数组 .length===0（falsy）正确退化为原始时间线，且避免 null.length 崩溃。
    const collected = collectStickerOtioEntries([]);
    if (collected.error) {
      MaweHint.flashHint(collected.error, 'warning');
      return null;
    }
    if (!collected.entries.length) {
      MaweHint.flashHint('没有任何表情包，无法导出 OTIO', 'invalid');
      return null;
    }
    const result = buildStickerOtioTimeline(collected.entries, `${MaweBoot.FILENAME_BASE}_表情包`);
    if (result.error) {
      MaweHint.flashHint(result.error, 'warning');
      return null;
    }
    return result.json;
  }



  // 收集表情包条目；当传入 removed gaps 时，把每条表情包的时间映射到去空隙后的时间线，
  // 并跳过完全落在空隙内、映射后时长归零的条目。removed 为空数组时退化为原始时间线。
  // 表情包必须有真实磁盘路径（服务器 OTIO/OTIOZ 均按 sticker_rel 读盘）。
  function collectStickerOtioEntries(removed) {
    const entries = [];
    for (let idx = 0; idx < MaweBoot.DATA.segments.length; idx++) {
      const seg = MaweBoot.DATA.segments[idx];
      if (seg.disabled) continue;
      const headIdx = seg.sticker_ref?.headIdx;
      const head = Number.isInteger(headIdx) ? MaweBoot.DATA.segments[headIdx] : null;
      if (seg.sticker_ref && (!head || head.disabled || headIdx >= idx)) continue;
      const sticker = seg.sticker || head?.sticker;
      if (!sticker) continue;
      const absPath = MaweSelection.stickerAbsPath(sticker);
      if (!absPath) {
        return { error: '表情包缺少真实磁盘路径；请先设置实际表情包根目录后再导出 OTIO' };
      }
      const origStart = seg.sticker?.start != null ? seg.sticker.start : seg.start;
      const origEnd = seg.sticker?.end != null ? seg.sticker.end : seg.end;
      if (origEnd <= origStart) continue;
      const startMs = removed.length
        ? window.AsrEditorUtils.mapGapRemovedTime(origStart, removed)
        : origStart;
      const endMs = removed.length
        ? window.AsrEditorUtils.mapGapRemovedTime(origEnd, removed)
        : origEnd;
      // 映射后归零说明整张表情包都在被移除的空隙内，丢弃
      if (endMs <= startMs) continue;
      entries.push({
        idx,
        startMs,
        endMs,
        absPath,
        sticker_rel: sticker.rel || '',
        name: stickerOtioName(sticker, absPath),
      });
    }
    return { entries };
  }



  function buildStickerOtioTimeline(stickers, timelineName) {
    const result = buildStickerOtioTrack(stickers);
    if (result.error) return result;
    return {
      json: JSON.stringify({
        OTIO_SCHEMA: 'Timeline.1',
        metadata: {},
        name: timelineName,
        global_start_time: otioTime(0),
        tracks: {
          OTIO_SCHEMA: 'Stack.1',
          metadata: {},
          name: 'tracks',
          source_range: null,
          effects: [],
          markers: [],
          enabled: true,
          color: null,
          children: [result.track],
        },
      }, null, 4),
    };
  }



  function buildGapRemovedStickerOtio() {
    const removed = MaweGapRemoveData.getRemovedGapRanges();
    if (!removed.length) {
      MaweHint.flashHint('没有已移除的静音空隙；请先使用「移除静音空隙」扫描并移除', 'invalid');
      return null;
    }
    const collected = collectStickerOtioEntries(removed);
    if (collected.error) {
      MaweHint.flashHint(collected.error, 'warning');
      return null;
    }
    if (!collected.entries.length) {
      MaweHint.flashHint('没有落在保留区间内的表情包，无法导出去空隙表情包 OTIO', 'invalid');
      return null;
    }
    const result = buildStickerOtioTimeline(collected.entries, `${MaweBoot.FILENAME_BASE}_去空隙表情包`);
    if (result.error) {
      MaweHint.flashHint(result.error, 'warning');
      return null;
    }
    return result.json;
  }



  // OTIOZ 打包：前端把 timeline 交给服务器，服务器读盘打包 zip（content.otio + version.txt + media/*）。
  // 需要 server-editor 模式 + 已绑定工程 + 已校验的表情包根目录（与便携文件夹导出同源）。
  async function exportStickerOtoz(kind, buildTimeline, filename, description) {
    const tr = (s) => window.MAWE_I18N?.translateText?.(s) || s;
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    const payload = buildTimeline();
    if (!payload) return;
    if (!MaweBoot.SERVER_CONFIG?.canOtozStickerExport || !MaweBoot.SERVER_CONFIG?.otiozStickerExportUrl) {
      MaweHint.flashHint(tr('当前工程无法导出表情包 OTIOZ（需要以 server-editor 打开并绑定工程文件）'), 'warning');
      return;
    }
    MaweHint.flashHint(tr('正在生成表情包 OTIOZ 打包工程…'));
    try {
      const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.otiozStickerExportUrl, window.location.href), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestToken: MaweBoot.SERVER_CONFIG.requestToken,
          kind,
          timeline: JSON.parse(payload),
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `服务器返回 ${response.status}`);
      }
      const blob = await response.blob();
      MaweHint.flashHint(tr('OTIOZ 已生成，图片已打包进 zip'), 'success');
      await downloadFile(blob, filename, 'application/zip', {
        desc: description, types: { 'application/zip': ['.otioz'] }
      });
    } catch (error) {
      MaweHint.flashHint(`表情包 OTIOZ 导出失败：${error.message || error}`, 'warning');
    }
  }



  async function exportTimelineOtioz(kind, buildTimeline, filename, description) {
    const tr = (s) => window.MAWE_I18N?.translateText?.(s) || s;
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    const payload = buildTimeline();
    if (!payload) return false;
    if (!MaweBoot.SERVER_CONFIG?.canOtozTimelineExport || !MaweBoot.SERVER_CONFIG?.otiozTimelineExportUrl) {
      MaweHint.flashHint(tr('当前工程无法导出时间线 OTIOZ（需要以 server-editor 打开并绑定工程文件）'), 'warning');
      return false;
    }
    MaweHint.flashHint(tr('正在生成时间线 OTIOZ 打包工程…'));
    try {
      const response = await fetch(new URL(MaweBoot.SERVER_CONFIG.otiozTimelineExportUrl, window.location.href), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestToken: MaweBoot.SERVER_CONFIG.requestToken,
          kind,
          timeline: JSON.parse(payload),
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `服务器返回 ${response.status}`);
      }
      const blob = await response.blob();
      MaweHint.flashHint(tr('时间线 OTIOZ 已生成，媒体已打包进 zip'), 'success');
      return Boolean(await downloadFile(blob, filename, 'application/zip', {
        desc: description, types: { 'application/zip': ['.otioz'] },
      }));
    } catch (error) {
      MaweHint.flashHint(`${tr('时间线 OTIOZ 导出失败')}：${error.message || error}`, 'warning');
      return false;
    }
  }



  const TIMELINE_OTIOZ_BUTTONS = ['download-otioz', 'download-gap-removed-otioz'];



  function updateTimelineOtiozExportButtons() {
    const available = Boolean(
      MaweBoot.SERVER_CONFIG?.canOtozTimelineExport && MaweBoot.SERVER_CONFIG?.otiozTimelineExportUrl,
    );
    TIMELINE_OTIOZ_BUTTONS.forEach((id) => {
      const button = document.getElementById(id);
      if (!button) return;
      if (!button.dataset.originalTitle) button.dataset.originalTitle = button.title;
      button.classList.toggle('sticker-disabled', !available);
      button.setAttribute('aria-disabled', available ? 'false' : 'true');
      button.title = available
        ? button.dataset.originalTitle
        : MaweProjectSave.translatedEditorText('服务器打包模式不可用：请以 server-editor 打开并绑定工程文件后再导出 OTIOZ');
    });
  }



  // 表情包导出的两种交付格式：
  //   .otio（original 模式，引用 file:// 路径）始终可用
  //   .otioz（服务器打包 zip）需要 server-editor + 已绑定工程文件，否则灰显并说明原因
  const STICKER_OTIOZ_BUTTONS = ['download-sticker-otioz', 'download-gap-removed-sticker-otioz'];



  function updateStickerExportButtons() {
    const serverOk = !!(MaweBoot.SERVER_CONFIG?.canOtozStickerExport && MaweBoot.SERVER_CONFIG?.otiozStickerExportUrl);
    // title 只写中文原文，i18n 的 translateAttributes 会按当前语言翻译（避免双真源）
    const apply = (ids, disabled, reason) => {
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (!el.dataset.originalTitle) el.dataset.originalTitle = el.title;
        el.classList.toggle('sticker-disabled', disabled);
        el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        el.title = disabled ? reason : el.dataset.originalTitle;
      });
    };
    apply(
      STICKER_OTIOZ_BUTTONS, !serverOk,
      '服务器打包模式不可用：请以 server-editor 打开并绑定工程文件后再导出 OTIOZ',
    );
  }



  // 灰显按钮的点击拦截：给出原因指引而非静默失败。
  function stickerExportBlocked(id) {
    const el = document.getElementById(id);
    if (el && el.classList.contains('sticker-disabled')) {
      const msg = `当前模式不可用：${el.title || '请使用另一种导出格式'}`;
      MaweHint.flashHint(window.MAWE_I18N?.translateText?.(msg) || msg);
      return true;
    }
    return false;
  }



  async function downloadFile(content, filename, mime, accept, { usePicker = true, detailed = false } = {}) {
    const isSrt = filename.toLowerCase().endsWith('.srt');
    const fileContent = isSrt
      ? new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode(String(content))])
      : content;
    // 优先尝试 File System Access API（弹出保存路径选择对话框）
    if (usePicker && window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: accept ? [{ description: accept.desc, accept: accept.types }] : undefined,
        });
        const w = await handle.createWritable();
        await w.write(new Blob([fileContent], { type: mime + ';charset=utf-8' }));
        await w.close();
        return detailed ? { status: 'saved' } : true;
      } catch (e) {
        // 用户取消保存对话框 — 静默退出，不回退
        if (e && e.name === 'AbortError') return detailed ? { status: 'cancelled' } : false;
        if (detailed) return { status: 'failed' };
        // 其他错误（如安全限制、unsupported 文件类型）：回退到 anchor 下载
      }
    }
    // 兜底：传统 anchor 下载（不弹路径选择）
    const blob = new Blob([fileContent], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return detailed ? { status: 'dispatched' } : true;
  }



  // === 标题区：媒体名点击复制 / 工程文件名点击复制 ===
  function copyText(text, hint) {
    navigator.clipboard.writeText(text).then(
      () => MaweHint.flashHint(hint || `已复制：${text}`, 'success'),
      () => { /* 降级：exec */ document.execCommand('copy'); MaweHint.flashHint(hint || `已复制：${text}`, 'success'); }
    );
  }



  function otioAudioTrackMetadata(audioTrack, fallbackIndex = 0) {
    if (!audioTrack || !Number.isInteger(audioTrack.stream_index) || audioTrack.stream_index < 0) {
      return {};
    }
    const audioIndex = otioAudioTrackIndex(audioTrack, fallbackIndex);
    const metadata = {
      audio_track_index: audioIndex,
      audio_stream_index: audioTrack.stream_index,
    };
    for (const field of ['codec', 'language', 'title']) {
      if (audioTrack[field]) metadata[field] = audioTrack[field];
    }
    if (Number.isInteger(audioTrack.channels) && audioTrack.channels > 0) {
      metadata.channels = audioTrack.channels;
    }
    if (Number.isInteger(audioTrack.sample_rate) && audioTrack.sample_rate > 0) {
      metadata.sample_rate = audioTrack.sample_rate;
    }
    if (audioTrack.default === true) metadata.default = true;
    return { moy: metadata };
  }



  function otioAudioTrackIndex(audioTrack, fallbackIndex = 0) {
    return Number.isInteger(audioTrack?.audio_index) && audioTrack.audio_index >= 0
      ? audioTrack.audio_index : fallbackIndex;
  }



  function otioAudioTrackName(audioTrack, index, total) {
    if (total <= 1) return '音频';
    const details = [audioTrack?.title, audioTrack?.language]
      .filter((value, detailIndex, values) => value && values.indexOf(value) === detailIndex)
      .join(' · ');
    return `音频 ${index + 1}${details ? ` · ${details}` : ''}`;
  }



  function otioMediaName(targetUrl) {
    const raw = String(targetUrl || '').split(/[?#]/, 1)[0].replace(/[\\/]+$/, '');
    const candidate = raw.split(/[\\/]/).pop() || '';
    if (!candidate) return '';
    try {
      return decodeURIComponent(candidate);
    } catch {
      return candidate;
    }
  }



  function resolveOtioAudioType(audioTrack) {
    if (audioTrack?.channels === 1) return 'Mono';
    if (audioTrack?.channels === 2) return 'Stereo';
    return null;
  }



  function resolveOtioTrackMetadata(kind, audioTrack) {
    if (kind === 'Video') {
      return { Resolve_OTIO: { Locked: false } };
    }
    const audioType = resolveOtioAudioType(audioTrack);
    return {
      Resolve_OTIO: {
        ...(audioType ? { 'Audio Type': audioType } : {}),
        Locked: false,
        SoloOn: false,
      },
    };
  }



  function resolveOtioClipMetadata(kind, audioTrack, audioTrackIndex, linkGroupId = 1) {
    const resolveMetadata = { 'Link Group ID': linkGroupId };
    if (kind === 'Audio') {
      const sourceTrackId = otioAudioTrackIndex(audioTrack, audioTrackIndex);
      const channels = Number.isInteger(audioTrack?.channels) && audioTrack.channels > 0
        ? audioTrack.channels : 0;
      if (channels > 0) {
        resolveMetadata.Channels = Array.from({ length: channels }, (_, sourceChannelId) => ({
          'Source Channel ID': sourceChannelId,
          'Source Track ID': sourceTrackId,
        }));
      }
    }
    return { Resolve_OTIO: resolveMetadata };
  }



  // 把表情包条目构建为一条可放进任意时间线 Stack 的单层视频轨（Gap 填充 + 图片 Clip）。
  // stickers 会被就地排序；时间重叠时返回 { error }，由调用方决定中止还是跳过。
  function buildStickerOtioTrack(stickers) {
    stickers.sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs) || (a.idx - b.idx));
    const children = [];
    let cursor = 0;
    for (const sticker of stickers) {
      const startFrame = MaweExportTimeline.msToOtioFrames(sticker.startMs);
      const endFrame = MaweExportTimeline.msToOtioFrames(sticker.endMs);
      const durationFrames = Math.max(1, endFrame - startFrame);
      if (startFrame < cursor) {
        return { error: `表情包时间重叠，无法导出单轨 OTIO：${sticker.name}` };
      }
      if (startFrame > cursor) {
        children.push({
          OTIO_SCHEMA: 'Gap.1',
          metadata: {},
          name: '',
          source_range: MaweExportTimeline.otioTimeRange(0, startFrame - cursor),
          effects: [],
          markers: [],
          enabled: true,
          color: null,
        });
      }
      children.push({
        OTIO_SCHEMA: 'Clip.2',
        metadata: {
          moy: {
            asr_segment_index: sticker.idx,
            start_ms: Math.round(sticker.startMs),
            end_ms: Math.round(sticker.endMs),
            sticker_rel: sticker.sticker_rel,
          },
        },
        name: sticker.name,
        source_range: MaweExportTimeline.otioTimeRange(0, durationFrames),
        effects: [],
        markers: [],
        enabled: true,
        color: null,
        media_references: {
          DEFAULT_MEDIA: {
            OTIO_SCHEMA: 'ExternalReference.1',
            metadata: {},
            name: '',
            available_range: null,
            available_image_bounds: null,
            target_url: sticker.targetUrl || MaweExportTimeline.stickerTargetUrl(sticker.absPath),
          },
        },
        active_media_reference_key: 'DEFAULT_MEDIA',
      });
      cursor = startFrame + durationFrames;
    }
    return {
      track: {
        OTIO_SCHEMA: 'Track.1',
        metadata: {},
        name: '表情包',
        source_range: null,
        effects: [],
        markers: [],
        enabled: true,
        color: null,
        children,
        kind: 'Video',
      },
    };
  }



  // 时间线 OTIO / OTIOZ 导出选项：两个 OTIO 子菜单（原始 / 去空隙）共享同一份设置，
  // 任一处勾选立即持久化并同步另一处；导出时由 buildSourceOtio / buildGapRemovedOtio 读取。
  const OTIO_EXPORT_OPTION_KEYS = {
    srt: 'otioExportIncludeSrt',
    stickers: 'otioExportIncludeStickers',
    markers: 'otioExportIncludeMarkers',
  };


  const otioExportOptionInputs = [
    ...document.querySelectorAll('input[data-otio-export-option]'),
  ];



  function syncOtioExportOptionInputs() {
    otioExportOptionInputs.forEach((input) => {
      const key = OTIO_EXPORT_OPTION_KEYS[input.dataset.otioExportOption];
      if (key) input.checked = Boolean(MaweSettings.EDITOR_SETTINGS[key]);
    });
  }

  global.MaweExportTimeline = Object.freeze({
    otioAudioTrackMetadata,
    otioAudioTrackIndex,
    otioAudioTrackName,
    otioMediaName,
    resolveOtioAudioType,
    resolveOtioTrackMetadata,
    resolveOtioClipMetadata,
    buildStickerOtioTrack,
    OTIO_EXPORT_OPTION_KEYS,
    otioExportOptionInputs,
    syncOtioExportOptionInputs,
    buildWorkspaceJson,
    buildCurrentWorkspaceData,
    buildResolveJson,
    OTIO_STICKER_FPS,
    otioTime,
    otioTimeRange,
    msToOtioFrames,
    mediaStartOtioFrames,
    OTIO_MARKER_COLORS,
    OTIO_DEFAULT_MARKER_COLOR,
    buildGapRemovedSubtitleMarkers,
    stickerTargetUrl,
    mediaTargetUrl,
    buildTimelineMediaClip,
    buildTimelineOtio,
    buildSourceOtio,
    buildGapRemovedOtio,
    stickerOtioName,
    buildStickerOtio,
    collectStickerOtioEntries,
    buildStickerOtioTimeline,
    buildGapRemovedStickerOtio,
    exportStickerOtoz,
    exportTimelineOtioz,
    TIMELINE_OTIOZ_BUTTONS,
    updateTimelineOtiozExportButtons,
    STICKER_OTIOZ_BUTTONS,
    updateStickerExportButtons,
    stickerExportBlocked,
    downloadFile,
    copyText
  });
})(typeof window !== 'undefined' ? window : globalThis);

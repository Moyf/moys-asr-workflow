// 工程 JSON 构建、时间码修复与分组重建。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweJsonRepair 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweJsonRepair(global) {
  'use strict';



  function buildJson() {
    syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
    const repairedTimingCount = repairCurrentProjectTimings();
    if (repairedTimingCount > 0) {
      MaweHint.flashHint(`已自动修复 ${repairedTimingCount} 处异常时间码（保底 100ms）`, 'warning');
    }
    syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
    const out = {
      schema: window.AsrEditorUtils.PROJECT_SCHEMA,
      ...projectExtensionFields,
      media: MaweBoot.DATA.media || '',
      language: MaweBoot.DATA.language || '',
      model: MaweBoot.DATA.model || '',
      sticker_root: MaweBoot.STICKER_ROOT || '',
      timebase: { ...projectTimebase() },
      segments: MaweBoot.DATA.segments.map(s => {
        const o = {
          id: s.id,
          start: s.start, end: s.end, text: s.text,
          start_frame: s.start_frame, end_frame: s.end_frame,
          items: s.items || [],
          sticker: s.sticker || null,
          sticker_ref: s.sticker_ref || null,
          color: s.color || null,
          color_ref: s.color_ref || null,
        };
        // 持久化"已改动"标记，便于二次打开时仍能识别脏行 / 离开提醒等
        if (s._dirty) o._dirty = true;
        // 持久化"禁用"标记（未禁用的不写字段，加载时默认 undefined=falsy 兼容旧工程）
        if (s.disabled) o.disabled = true;
        return o;
      }),
    };
    if (typeof MaweBoot.DATA.language_source === 'string') out.language_source = MaweBoot.DATA.language_source;
    if (typeof MaweBoot.DATA.split_mode === 'string') out.split_mode = MaweBoot.DATA.split_mode;
    if (typeof MaweBoot.DATA.timestamp_granularity === 'string') {
      out.timestamp_granularity = MaweBoot.DATA.timestamp_granularity;
    }
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    out.multi_subtitle = {
      schema: multi.schema || window.AsrEditorUtils.MULTI_SUBTITLE_SCHEMA,
      enabled: multi.enabled === true,
      display_mode: multi.display_mode || 'both',
      main_split_mode: MaweMultiSubtitleCore.isConfiguredSubtitleSplitMode(multi.main_split_mode)
        ? multi.main_split_mode : MaweMultiSubtitleCore.getMainSubtitleSplitMode(MaweBoot.DATA.segments[0]),
      tracks: (multi.tracks || []).map((track) => ({
        id: track.id,
        role: 'extension',
        name: track.name || '副字幕',
        language: track.language || '',
        split_mode: track.split_mode || 'word',
        source_name: track.source_name || '',
        segments: (track.segments || []).map((segment) => {
          const outSegment = {
            id: segment.id,
            start: segment.start,
            end: segment.end,
            start_frame: segment.start_frame,
            end_frame: segment.end_frame,
            text: segment.text || '',
          };
          if (Array.isArray(segment.items)) outSegment.items = segment.items;
          if (segment.color != null) outSegment.color = segment.color;
          if (segment.color_ref != null) outSegment.color_ref = segment.color_ref;
          if (segment._dirty) outSegment._dirty = true;
          if (segment.disabled) outSegment.disabled = true;
          return outSegment;
        }),
      })),
      bindings: (multi.bindings || []).map((binding) => ({
        id: binding.id,
        track_id: binding.track_id,
        main_segment_ids: [...(binding.main_segment_ids || [])],
        extension_segment_ids: [...(binding.extension_segment_ids || [])],
        start_offset_ms: binding.start_offset_ms || 0,
        end_offset_ms: binding.end_offset_ms || 0,
      })),
    };
    // 波形缓存（含响度统计）不再写进工程：运行态 DATA 保留 payload 供本页渲染，落盘
    // 真源在媒体旁的 .quapeaks / .mopeaks（后端落盘边界也会再剥一次兜底）。
    // 旧工程里的内联缓存经 CANONICAL_PROJECT_FIELDS 进 DATA，不会混进扩展字段。
    const mediaMetadata = normalizeMediaMetadata(MaweBoot.DATA.media_metadata);
    if (mediaMetadata) out.media_metadata = mediaMetadata;
    if (MaweBoot.DATA.gap_remove) out.gap_remove = MaweGapRemoveData.normalizedGapRemoveData(MaweBoot.DATA.gap_remove);
    if (MaweBoot.DATA.script_alignment) out.script_alignment = MaweBoot.DATA.script_alignment;
    const workspace = MaweExportTimeline.buildCurrentWorkspaceData();
    if (workspace) out.workspace = workspace;
    // 预览几何：始终写入归一化后的当前几何，便于跨机/重开保持位置。
    const preview = {
      subtitle: {
        ...MaweAppearance.getPreviewGeometry(),
        ...MaweAppearance.getSubtitleAppearance(),
        speaker_labels: getSpeakerLabelSettings(),
      },
    };
    if (MaweMultiSubtitleCore.getActiveExtensionTrack() || MaweBoot.DATA.preview?.extension_subtitle) {
      preview.extension_subtitle = { ...MaweAppearance.getStoredExtensionSubtitleAppearance() };
    }
    out.preview = preview;
    return JSON.stringify(out, null, 2);
  }



  // 保存/导出前的最后一道时间码兜底。波形拖动会把词时间码按像素取整，
  // 极短词可能因此出现 1ms 的前后重叠；打开工程时的修复不足以覆盖这种
  // “打开后编辑、随后保存”的路径。主轨和所有副字幕轨统一使用同一规则。
  function normalizeProjectTimings(project, { repairSegmentRanges = true } = {}) {
    if (!project || typeof project !== 'object') return 0;
    const normalize = repairSegmentRanges
      ? window.AsrEditorUtils.normalizeSegmentTimings
      : window.AsrEditorUtils.normalizeItemTimingRanges;
    let fixed = normalize(project.segments);
    const tracks = project.multi_subtitle?.tracks;
    if (Array.isArray(tracks)) {
      tracks.forEach((track) => {
        fixed += normalize(track?.segments);
      });
    }
    return fixed;
  }



  function timingRepairSignature(segment) {
    return JSON.stringify({
      start: segment?.start,
      end: segment?.end,
      items: Array.isArray(segment?.items)
        ? segment.items.map((item) => ({ text: item?.text, start: item?.start, end: item?.end }))
        : null,
    });
  }



  function repairTimingGroup(segments) {
    const source = Array.isArray(segments) ? segments : [];
    const before = source.map((segment) => timingRepairSignature(segment));
    const fixed = window.AsrEditorUtils.normalizeItemTimingRanges(source);
    const changed = source.filter((segment, index) => (
      timingRepairSignature(segment) !== before[index]
    ));
    return { fixed, changed };
  }



  function repairCurrentProjectTimings() {
    const main = repairTimingGroup(MaweBoot.DATA.segments);
    const extension = (MaweMultiSubtitleCore.getMultiSubtitleState().tracks || []).reduce((result, track) => {
      const repaired = repairTimingGroup(track?.segments);
      result.fixed += repaired.fixed;
      result.changed.push(...repaired.changed);
      return result;
    }, { fixed: 0, changed: [] });
    const fixed = main.fixed + extension.fixed;
    if (fixed > 0) {
      MaweMultiSubtitleCore.markMainSegmentsDirty(main.changed);
      extension.changed.forEach((segment) => { segment._dirty = true; });
      if (main.changed.length || extension.changed.length) MaweMultiSubtitleCore.markMultiSubtitleStateDirty();
      MaweMultiSubtitleCore.syncBindingOffsets();
    }
    return fixed;
  }

  global.MaweJsonRepair = Object.freeze({
    buildJson,
    normalizeProjectTimings,
    timingRepairSignature,
    repairTimingGroup,
    repairCurrentProjectTimings
  });
})(typeof window !== 'undefined' ? window : globalThis);

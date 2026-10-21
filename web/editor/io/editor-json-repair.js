// 工程 JSON 构建、时间码修复与分组重建。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweJsonRepair 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweJsonRepair(global) {
  'use strict';



  function buildJson({ forFileExport = false } = {}) {
    MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
    const repairedTimingCount = repairCurrentProjectTimings();
    if (repairedTimingCount > 0) {
      MaweHint.flashHint(`已自动修复 ${repairedTimingCount} 处异常时间码（保底 100ms）`, 'warning');
    }
    MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
    const out = projectSnapshot();
    if (forFileExport && !MaweProjectMediaInputs.currentMediaBlobUrl
        && MaweBoot.SERVER_CONFIG?.autoLoadedMediaPath) {
      out.media = MaweBoot.SERVER_CONFIG.autoLoadedMediaPath;
    }
    const validation = window.AsrEditorUtils.validateTracksProject(out);
    if (!validation.ok) throw new window.AsrEditorUtils.ProjectTracksError(validation.errors);
    return JSON.stringify(out, null, 2);
  }

  // One pure projection drives both save and content checkpoints. Preserve all
  // source metadata and extension fields on every role; runtime views stay out.
  function projectSnapshot() {
    const out = window.AsrEditorUtils.snapshotProjectContent(MaweBoot.DATA);
    // Use the same effective project gain in saved bytes and content checkpoints.
    // The reader is pure; retain extension fields beside the known gain settings.
    out.audio_processing = {
      ...out.audio_processing,
      ...(window.MaweAudioProcessing?.settings()
        || { gain_db: 0, target_lufs: -14, peak_ceiling_dbtp: -1 }),
    };
    const markers = window.AsrEditorUtils.markersToProjectField(MaweBoot.DATA.markers);
    if (markers) out.markers = markers;
    else delete out.markers;
    if (MaweBoot.DATA.gap_remove) out.gap_remove = MaweGapRemoveData.normalizedGapRemoveData(MaweBoot.DATA.gap_remove);
    const workspace = MaweExportTimeline.buildCurrentWorkspaceData();
    if (workspace) out.workspace = workspace;
    const preview = {
      ...out.preview,
      ass_mode: MaweSettings.EDITOR_SETTINGS.assMode === true,
      sticker: { ...MawePreviewGeometry.getStickerGeometry() },
      subtitle: {
        ...out.preview?.subtitle,
        ...MaweAppearance.getPreviewGeometry(), ...MaweAppearance.getSubtitleAppearance(),
        speaker_labels: MaweSpeakerLabels.getSpeakerLabelSettings(),
      },
    };
    if (window.AsrEditorUtils.getTracksByRole(MaweBoot.DATA, 'extension').length
        || out.preview?.extension_subtitle) {
      preview.extension_subtitle = { ...MaweAppearance.getStoredExtensionSubtitleAppearance() };
    }
    out.preview = preview;
    return MaweState.persistenceSnapshot(out);
  }

  function captureCleanupNormalization(segments, project) {
    const gapRemove = project?.gap_remove;
    const ranges = gapRemove?.provenance?.sources?.ai_cleanup;
    const verify = window.AsrGapRemoveCore?.getCleanupScopeItems;
    if (!Array.isArray(segments) || !Array.isArray(ranges) || typeof verify !== 'function') return [];
    // A stale index may accidentally become valid after a neutral item merges.
    // Remove that authority before changing any items; keep the audio range.
    for (const range of ranges) {
      if (!range?.cleanup_scope) continue;
      const segment = segments.find((item) => item?.id === range.cleanup_scope.segment_id);
      if (!segment || !verify(segment, range).length) delete range.cleanup_scope;
    }
    return segments.flatMap((segment) => {
      const scopes = ranges.filter((range) => verify(segment, range).length);
      return scopes.length ? [{ segment, scopes, project, start: segment.start, end: segment.end,
        items: segment.items.map((item) => ({ ...item })) }] : [];
    });
  }

  function reviewCleanupNormalization(snapshots) {
    if (!snapshots.length) return;
    const project = snapshots[0].project;
    const scopes = snapshots.flatMap((before) => before.scopes);
    const gap = project.gap_remove;
    const core = window.AsrGapRemoveCore;
    const provenance = core.replaceGapRemoveProvenanceSource(gap.provenance, 'ai_cleanup',
      gap.provenance.sources.ai_cleanup.filter((range) => !scopes.includes(range)), gap.gaps);
    project.gap_remove = { ...gap, provenance, gaps: core.gapRangesFromProvenance(provenance) };
    const utils = window.AsrEditorUtils;
    const markers = utils.normalizeMarkers(project.markers);
    const reason = '局部删除的字词映射在时间规整后无法安全核验';
    for (const range of scopes) {
      let marker = markers.find((item) => item.start === range.start && item.end === range.end
        && /^\[AI\] 删除：/.test(item.note || ''));
      if (!marker) {
        marker = { id: utils.nextMarkerId(markers), start: range.start, end: range.end,
          name: range.cleanup_scope.text.slice(0, 120), color: '#f5a623', note: '' };
        markers.push(marker);
      }
      marker.review = { status: 'pending', reason };
      marker.note = `[AI] 复核：${reason}`;
    }
    project.markers = Array.isArray(project.markers) ? markers
      : { ...(project.markers || {}), schema: 'moy.asr.markers.v1', items: markers };
  }

  function migrateCleanupNormalization(snapshots) {
    let restoredAnchors = 0;
    const failed = [];
    for (const before of snapshots) {
      const { segment, scopes, items } = before;
      const current = segment.items;
      if (!Array.isArray(current) || segment.start !== before.start || segment.end !== before.end) {
        failed.push(before); continue;
      }
      if (current.length === items.length && current.every((item, index) => item.text === items[index].text
          && item.start === items[index].start && item.end === items[index].end)) continue;
      // Reconstruct only the existing neutral merge, anchored to unique real
      // timed roots. No word search, interpolation or new time boundary.
      const groups = [];
      let leading = [];
      items.forEach((item, index) => {
        if (Array.from(item.text).every((token) => /[\s\p{P}\p{S}\u200D\uFE0E\uFE0F\u20E3]/u.test(token))) {
          if (groups.length) groups.at(-1).indices.push(index);
          else leading.push(index);
        } else {
          groups.push({ root: index, indices: [...leading, index] });
          leading = [];
        }
      });
      if (groups.length !== current.length || leading.length || !groups.every((group, index) => (
        current[index].start === items[group.root].start && current[index].end === items[group.root].end
        && current[index].text === group.indices.map((itemIndex) => items[itemIndex].text).join('')
      ))) { failed.push(before); continue; }
      const mapped = groups.flatMap((group, index) => {
        const protectedRoot = scopes.some(({ cleanup_scope: scope }) => (
          group.root >= scope.item_start && group.root < scope.item_end
          && group.indices.some((itemIndex) => (itemIndex < scope.item_start || itemIndex >= scope.item_end)
            && !/^[，。\s]+$/.test(items[itemIndex].text))
        ));
        if (!protectedRoot) return [{ item: { ...current[index] }, indices: group.indices }];
        // Keep unselected symbols as their own original timed anchors. Safe
        // punctuation can still merge, including a final full stop after emoji.
        const anchors = [];
        const pending = [];
        for (const itemIndex of group.indices) {
          const item = items[itemIndex];
          if (/^[，。\s]+$/.test(item.text)) {
            if (anchors.length) {
              anchors.at(-1).item.text += item.text;
              anchors.at(-1).indices.push(itemIndex);
            } else pending.push(itemIndex);
          } else {
            anchors.push({ item: { ...item, text: pending.map((i) => items[i].text).join('') + item.text },
              indices: [...pending, itemIndex] });
            pending.length = 0;
          }
        }
        return anchors;
      });
      const candidateItems = mapped.map(({ item }) => item);
      const candidates = [];
      for (const range of scopes) {
        const scope = range.cleanup_scope;
        const selected = mapped.map((group, index) => ({ group, index }))
          .filter(({ group }) => group.indices.some((itemIndex) => itemIndex >= scope.item_start && itemIndex < scope.item_end));
        if (!selected.length || selected.some(({ group }, index) => (
          selected[index].index !== selected[0].index + index
          || group.indices.some((itemIndex) => (itemIndex < scope.item_start || itemIndex >= scope.item_end)
            && !/^[，。\s]+$/.test(items[itemIndex].text))
        ))) break;
        const first = selected[0].index, last = selected.at(-1).index;
        // Restore only already authorized endpoints lost when selected neutral
        // items merged into a root. Never expand over an unselected timed word.
        if (range.start > candidateItems[first].start || range.end < candidateItems[last].end) break;
        candidateItems[first].start = range.start;
        candidateItems[last].end = range.end;
        candidates.push({ range, scope: { ...scope, item_start: first, item_end: last + 1,
          text: candidateItems.slice(first, last + 1).map((item) => item.text).join('') } });
      }
      const candidateSegment = { ...segment, items: candidateItems };
      if (candidates.length !== scopes.length || !candidates.every(({ range, scope }) => (
        window.AsrGapRemoveCore.getCleanupScopeItems(candidateSegment, { ...range, cleanup_scope: scope }).length
      ))) { failed.push(before); continue; }
      segment.items = candidateItems;
      restoredAnchors += candidateItems.length - current.length;
      for (const { range, scope } of candidates) range.cleanup_scope = scope;
    }
    // Keep snapshot references live until every successful cue has committed.
    // Source replacement clones ranges, so rebuild once after all migrations.
    reviewCleanupNormalization(failed);
    return restoredAnchors;
  }

  // 保存/导出前的最后一道时间码兜底。波形拖动会把词时间码按像素取整，
  // 极短词可能因此出现 1ms 的前后重叠；打开工程时的修复不足以覆盖这种
  // “打开后编辑、随后保存”的路径。主轨和所有副字幕轨统一使用同一规则。
  function normalizeProjectTimings(project, { repairSegmentRanges = true } = {}) {
  if (!project || typeof project !== 'object') return 0;
  const normalize = repairSegmentRanges
    ? window.AsrEditorUtils.normalizeSegmentTimings
    : window.AsrEditorUtils.normalizeItemTimingRanges;
  const cleanup = captureCleanupNormalization(window.AsrEditorUtils.getMainTrack(project).segments, project);
  let fixed = 0;
  for (const track of project.tracks || []) fixed += normalize(track.segments);
  fixed = Math.max(0, fixed - migrateCleanupNormalization(cleanup));
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
    const cleanup = captureCleanupNormalization(source, source === window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments ? MaweBoot.DATA : null);
    const fixed = Math.max(0, window.AsrEditorUtils.normalizeItemTimingRanges(source)
      - migrateCleanupNormalization(cleanup));
    const changed = source.filter((segment, index) => (
      timingRepairSignature(segment) !== before[index]
    ));
    return { fixed, changed };
  }



  function repairCurrentProjectTimings() {
  const main = repairTimingGroup(window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments);
  const extension = window.AsrEditorUtils.getTracksByRole(MaweBoot.DATA, 'extension').reduce((result, track) => {
    const repaired = repairTimingGroup(track?.segments);
    result.fixed += repaired.fixed;
    result.changed.push(...repaired.changed);
    return result;
  }, { fixed: 0, changed: [] });
  const overlay = repairTimingGroup(getOverlayTrack()?.segments);
  const fixed = main.fixed + extension.fixed + overlay.fixed;
  if (fixed > 0) {
    MaweMultiSubtitleCore.markMainSegmentsDirty(main.changed);
    extension.changed.forEach((segment) => { segment._dirty = true; });
    overlay.changed.forEach((segment) => { segment._dirty = true; });
    if (overlay.changed.length) getOverlayTrack()._dirty = true;
    if (main.changed.length || extension.changed.length) MaweMultiSubtitleCore.markMultiSubtitleStateDirty();
    MaweMultiSubtitleCore.syncBindingOffsets();
    // buildJson 在每次保存/导出前修复时间码；若随后保存失败，修复必须保持
    // 未保存状态可见（覆盖仅叠加轨修复、不经过上方漏斗的情况）。
    MaweState.markProjectDirty();
  }
  return fixed;
}

  global.MaweJsonRepair = Object.freeze({
    buildJson,
    projectSnapshot,
    normalizeProjectTimings,
    timingRepairSignature,
    repairTimingGroup,
    repairCurrentProjectTimings
  });
})(typeof window !== 'undefined' ? window : globalThis);

// multi-subtitle: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-multi-subtitle', function createUtilsModule(dependencies) {
  'use strict';
  const { cloneJsonValue, detectSubtitleSplitMode, ensureStableSegmentIds, stableId } = dependencies;


  // === 多重字幕（双语字幕）===
  // 这组 helper 刻意不依赖 DOM，便携 HTML、localhost 编辑器和 Node 测试共用同一套
  // 数据/匹配/近似拆分规则。主轨仍然是顶层 segments；副轨的 items 不参与拆分。
  const MULTI_SUBTITLE_SCHEMA = 'moy.asr.multi_subtitle.v1';

  const MULTI_SUBTITLE_TOLERANCE_MS = 300;

  const MULTI_SUBTITLE_DISPLAY_MODES = new Set(['main', 'extension', 'both']);

  const MULTI_SUBTITLE_SPLIT_MODES = new Set(['continuous', 'word']);


  function normalizeOverlayTrack(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const rawSegments = Array.isArray(source.segments) ? source.segments : [];
    const segments = rawSegments
      .filter((segment) => segment && typeof segment === 'object')
      .map((segment) => {
        const copy = { ...segment };
        if (Array.isArray(copy.items)) copy.items = copy.items.map((item) => ({ ...item }));
        else delete copy.items;
        return copy;
      });
    ensureStableSegmentIds(segments, 'overlay');
    return { enabled: source.enabled === true, segments };
  }


  function mergeMainAndOverlaySegments(mainSegments, overlaySegments) {
    const main = Array.isArray(mainSegments) ? mainSegments : [];
    const overlay = Array.isArray(overlaySegments) ? overlaySegments : [];
    return [
      ...main.map((segment, index) => ({ segment, trackOrder: 0, index })),
      ...overlay.map((segment, index) => ({ segment, trackOrder: 1, index })),
    ].sort((left, right) => (
      Number(left.segment?.start) - Number(right.segment?.start)
      || left.trackOrder - right.trackOrder
      || left.index - right.index
    )).map(({ segment }) => segment);
  }


  // === 叠加字幕轨的段落迁移 ===
  // 主轨与叠加轨是两条互不绑定的时间轴；把段落从一条轨移到另一条轨时保持
  // 目标轨按 start 升序（同 start 时插到既有段之后），返回段在新轨中的下标。
  // 原地修改传入数组——编辑器以 DATA.segments / DATA.overlay_track 为真源。
  function insertSegmentByStart(trackSegments, segment) {
    const list = Array.isArray(trackSegments) ? trackSegments : [];
    const start = Number(segment?.start);
    let insertAt = list.length;
    for (let index = 0; index < list.length; index += 1) {
      if (Number(list[index]?.start) > start) {
        insertAt = index;
        break;
      }
    }
    list.splice(insertAt, 0, segment);
    return insertAt;
  }


  function moveSegmentBetweenTracks(sourceSegments, targetSegments, index) {
    const source = Array.isArray(sourceSegments) ? sourceSegments : [];
    const target = Array.isArray(targetSegments) ? targetSegments : [];
    if (!Number.isInteger(index) || index < 0 || index >= source.length) return -1;
    const segment = source[index];
    if (!segment || typeof segment !== 'object') return -1;
    source.splice(index, 1);
    return insertSegmentByStart(target, segment);
  }


  function normalizeMultiSubtitle(value, mainSegments = []) {
    const source = value && typeof value === 'object' ? value : {};
    const rawTracks = Array.isArray(source.tracks) ? source.tracks : [];
    const tracks = rawTracks.map((rawTrack, trackIndex) => {
      const track = rawTrack && typeof rawTrack === 'object' ? rawTrack : {};
      const id = stableId(track.id) || `extension-${trackIndex + 1}`;
      const rawSegments = Array.isArray(track.segments) ? track.segments : [];
      const segments = rawSegments
        .filter((segment) => segment && typeof segment === 'object')
        .map((segment) => {
          const copy = { ...segment };
          // Extension SRT has no items, while an imported mosp/project or a
          // swapped-down main track may carry optional word timestamps. Keep
          // them when present so a later swap can restore the main track.
          if (Array.isArray(copy.items)) {
            copy.items = copy.items.map((item) => ({ ...item }));
          } else {
            delete copy.items;
          }
          return copy;
        });
      ensureStableSegmentIds(segments, `${id}-segment`);
      return {
        id,
        role: 'extension',
        name: typeof track.name === 'string' && track.name.trim() ? track.name : '副字幕',
        language: typeof track.language === 'string' ? track.language : '',
        source_name: typeof track.source_name === 'string' ? track.source_name : '',
        split_mode: MULTI_SUBTITLE_SPLIT_MODES.has(track.split_mode)
          ? track.split_mode : detectSubtitleSplitMode(segments.map((s) => s.text).join('\n'), track.language),
        segments,
      };
    });
    const mainIds = new Set((Array.isArray(mainSegments) ? mainSegments : [])
      .map((segment) => stableId(segment?.id)).filter(Boolean));
    const extensionIds = new Map(tracks.map((track) => [track.id, new Set(track.segments.map((s) => s.id))]));
    const bindings = Array.isArray(source.bindings) ? source.bindings : [];
    const normalizedBindings = bindings.map((rawBinding, index) => {
      const binding = rawBinding && typeof rawBinding === 'object' ? rawBinding : {};
      const trackId = stableId(binding.track_id) || tracks[0]?.id || 'extension-1';
      const trackIds = extensionIds.get(trackId) || new Set();
      const mainSegmentIds = (Array.isArray(binding.main_segment_ids)
        ? binding.main_segment_ids : binding.main_segment_id ? [binding.main_segment_id] : [])
        .map(stableId).filter((id) => mainIds.has(id));
      const extensionSegmentIds = (Array.isArray(binding.extension_segment_ids)
        ? binding.extension_segment_ids : binding.extension_segment_id ? [binding.extension_segment_id] : [])
        .map(stableId).filter((id) => trackIds.has(id));
      if (!mainSegmentIds.length || !extensionSegmentIds.length) return null;
      return {
        id: stableId(binding.id) || `binding-${String(index + 1).padStart(3, '0')}`,
        track_id: trackId,
        main_segment_ids: [...new Set(mainSegmentIds)],
        extension_segment_ids: [...new Set(extensionSegmentIds)],
        start_offset_ms: Number.isFinite(Number(binding.start_offset_ms))
          ? Math.round(Number(binding.start_offset_ms)) : 0,
        end_offset_ms: Number.isFinite(Number(binding.end_offset_ms))
          ? Math.round(Number(binding.end_offset_ms)) : 0,
      };
    }).filter(Boolean);
    const dedupedBindings = [];
    const seenMain = new Set();
    const seenExtension = new Set();
    normalizedBindings.forEach((binding) => {
      // MVP editing is one-to-one. Keep the first valid relation when a malformed
      // imported project contains duplicate endpoints, while retaining arrays for
      // a future one-to-many binding model.
      const mainKey = binding.main_segment_ids.join('|');
      const extensionKey = `${binding.track_id}:${binding.extension_segment_ids.join('|')}`;
      if (seenMain.has(mainKey) || seenExtension.has(extensionKey)) return;
      seenMain.add(mainKey);
      seenExtension.add(extensionKey);
      dedupedBindings.push(binding);
    });
    const normalized = {
      schema: MULTI_SUBTITLE_SCHEMA,
      enabled: source.enabled === true,
      display_mode: MULTI_SUBTITLE_DISPLAY_MODES.has(source.display_mode)
        ? source.display_mode : 'both',
      main_split_mode: MULTI_SUBTITLE_SPLIT_MODES.has(source.main_split_mode)
        ? source.main_split_mode
        : detectSubtitleSplitMode((Array.isArray(mainSegments) ? mainSegments : [])
          .map((segment) => segment?.text || '').join('\n')),
      tracks,
      bindings: dedupedBindings,
    };
    rebuildBindingOffsets(normalized, mainSegments);
    return normalized;
  }


  function normalizeMultiSubtitleProject(project) {
    if (!project || typeof project !== 'object') return project;
    ensureStableSegmentIds(project.segments, 'main');
    project.overlay_track = normalizeOverlayTrack(project.overlay_track);
    project.multi_subtitle = normalizeMultiSubtitle(project.multi_subtitle, project.segments);
    return project;
  }


  function bindingForSegment(multiSubtitle, segmentId, side = 'either', trackId = null) {
    const id = stableId(segmentId);
    if (!id || !multiSubtitle) return null;
    return (Array.isArray(multiSubtitle.bindings) ? multiSubtitle.bindings : []).find((binding) => {
      if (trackId && binding.track_id !== trackId) return false;
      const inMain = binding.main_segment_ids?.includes(id);
      const inExtension = binding.extension_segment_ids?.includes(id);
      return side === 'main' ? inMain : side === 'extension' ? inExtension : inMain || inExtension;
    }) || null;
  }


  function buildSubtitleBinding(mainSegment, extensionSegment, trackId, id = null) {
    const main = mainSegment || {};
    const extension = extensionSegment || {};
    return {
      id: stableId(id) || `binding-${stableId(main.id) || 'main'}-${stableId(extension.id) || 'extension'}`,
      track_id: stableId(trackId) || 'extension-1',
      main_segment_ids: stableId(main.id) ? [main.id] : [],
      extension_segment_ids: stableId(extension.id) ? [extension.id] : [],
      start_offset_ms: Math.round(Number(extension.start) - Number(main.start)) || 0,
      end_offset_ms: Math.round(Number(extension.end) - Number(main.end)) || 0,
    };
  }


  function rebuildBindingOffsets(multiSubtitle, mainSegments) {
    if (!multiSubtitle) return multiSubtitle;
    const mainById = new Map((Array.isArray(mainSegments) ? mainSegments : [])
      .map((segment) => [stableId(segment?.id), segment]));
    const trackById = new Map((multiSubtitle.tracks || []).map((track) => [track.id, track]));
    (multiSubtitle.bindings || []).forEach((binding) => {
      const main = mainById.get(binding.main_segment_ids?.[0]);
      const track = trackById.get(binding.track_id);
      const extension = track?.segments?.find((segment) => segment.id === binding.extension_segment_ids?.[0]);
      if (!main || !extension) return;
      binding.start_offset_ms = Math.round(Number(extension.start) - Number(main.start));
      binding.end_offset_ms = Math.round(Number(extension.end) - Number(main.end));
    });
    return multiSubtitle;
  }


  function copySubtitleColorFields(source, target) {
    if (!source || !target) return;
    if (source.color != null) target.color = cloneJsonValue(source.color);
    if (source.color_ref != null) target.color_ref = cloneJsonValue(source.color_ref);
  }


  // 把 sourceSegments 中按绑定关系找到的颜色组写入 targetSegments。
  // target 的 headIdx 不能直接复用 source 下标：交换后两条字幕的数组长度和顺序
  // 可能不同，因此每个目标颜色组都在目标数组中重新选择最早的一条作为 head。
  function mapBoundSubtitleColors(sourceSegments, targetSegments, sourceToTarget) {
    if (!Array.isArray(sourceSegments) || !Array.isArray(targetSegments)
        || !(sourceToTarget instanceof Map)) return 0;
    const groups = new Map();
    sourceSegments.forEach((segment, sourceIndex) => {
      const sourceHeadIndex = segment?.color
        ? sourceIndex
        : Number.isInteger(segment?.color_ref?.headIdx) ? segment.color_ref.headIdx : null;
      const sourceHead = Number.isInteger(sourceHeadIndex)
        ? sourceSegments[sourceHeadIndex]?.color
        : null;
      const targetIndex = sourceToTarget.get(sourceIndex);
      if (!sourceHead || typeof sourceHead !== 'object'
          || !Number.isInteger(targetIndex) || !targetSegments[targetIndex]) return;
      const group = groups.get(sourceHeadIndex) || {
        sourceHead,
        targetIndexes: [],
      };
      group.targetIndexes.push(targetIndex);
      groups.set(sourceHeadIndex, group);
    });

    let mappedCount = 0;
    groups.forEach(({ sourceHead, targetIndexes }) => {
      const uniqueTargetIndexes = [...new Set(targetIndexes)].sort((left, right) => left - right);
      if (!uniqueTargetIndexes.length) return;
      const targetHeadIndex = uniqueTargetIndexes[0];
      const targetLastIndex = uniqueTargetIndexes[uniqueTargetIndexes.length - 1];
      const mappedHead = cloneJsonValue(sourceHead) || {};
      if (Number.isFinite(Number(targetSegments[targetHeadIndex]?.start))) {
        mappedHead.start = targetSegments[targetHeadIndex].start;
      }
      if (Number.isFinite(Number(targetSegments[targetLastIndex]?.end))) {
        mappedHead.end = targetSegments[targetLastIndex].end;
      }
      uniqueTargetIndexes.forEach((targetIndex, memberIndex) => {
        const target = targetSegments[targetIndex];
        target.color = null;
        target.color_ref = null;
        if (memberIndex === 0) {
          target.color = mappedHead;
        } else {
          target.color_ref = { name: mappedHead.name, headIdx: targetHeadIndex };
        }
        mappedCount++;
      });
    });
    return mappedCount;
  }


  // 交换主轨与当前唯一副轨。副轨保留可选的 items 和颜色信息，
  // 绑定关系按端点整体交换，并在新主轨写入后重新计算 offset。
  function swapMainAndExtensionSubtitle(project, trackId = null) {
    if (!project || typeof project !== 'object' || !Array.isArray(project.segments)) {
      return { swapped: false, reason: 'invalid-project' };
    }
    ensureStableSegmentIds(project.segments, 'main');
    const multi = normalizeMultiSubtitle(project.multi_subtitle, project.segments);
    project.multi_subtitle = multi;
    const tracks = Array.isArray(multi.tracks) ? multi.tracks : [];
    if (tracks.length !== 1) return { swapped: false, reason: 'unsupported-track-count' };
    const track = tracks.find((candidate) => !trackId || candidate.id === trackId);
    if (!track || !Array.isArray(track.segments)) return { swapped: false, reason: 'missing-track' };
    if (!project.segments.length || !track.segments.length) return { swapped: false, reason: 'empty-track' };

    const oldMain = cloneJsonValue(project.segments) || [];
    const oldExtension = cloneJsonValue(track.segments) || [];
    const oldMainSplitMode = multi.main_split_mode;
    const oldExtensionSplitMode = track.split_mode;
    const nextMain = oldExtension.map((segment) => ({ ...segment }));
    const oldMainIndexById = new Map(oldMain.map((segment, index) => [stableId(segment?.id), index]));
    const oldExtensionIndexById = new Map(
      oldExtension.map((segment, index) => [stableId(segment?.id), index]),
    );
    const mainToExtensionIndex = new Map();
    (multi.bindings || []).forEach((binding) => {
      if (binding.track_id !== track.id) return;
      const sourceIds = Array.isArray(binding.main_segment_ids)
        ? binding.main_segment_ids : [];
      const targetIds = Array.isArray(binding.extension_segment_ids)
        ? binding.extension_segment_ids : [];
      const pairCount = Math.min(sourceIds.length, targetIds.length);
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
        const sourceIndex = oldMainIndexById.get(stableId(sourceIds[pairIndex]));
        const targetIndex = oldExtensionIndexById.get(stableId(targetIds[pairIndex]));
        if (Number.isInteger(sourceIndex) && Number.isInteger(targetIndex)
            && !mainToExtensionIndex.has(sourceIndex)) {
          mainToExtensionIndex.set(sourceIndex, targetIndex);
        }
      }
    });
    const mappedColorCount = mapBoundSubtitleColors(
      oldMain,
      nextMain,
      mainToExtensionIndex,
    );
    const nextExtension = oldMain.map((segment) => {
      const copy = {
        id: stableId(segment.id),
        start: segment.start,
        end: segment.end,
        text: typeof segment.text === 'string' ? segment.text : '',
      };
      if (Array.isArray(segment.items)) {
        copy.items = segment.items.map((item) => ({ ...item }));
      }
      copySubtitleColorFields(segment, copy);
      if (segment._dirty) copy._dirty = true;
      return copy;
    });

    project.segments.length = 0;
    nextMain.forEach((segment) => project.segments.push(segment));
    track.segments = nextExtension;
    multi.main_split_mode = oldExtensionSplitMode;
    track.split_mode = oldMainSplitMode;

    let bindingCount = 0;
    (multi.bindings || []).forEach((binding) => {
      if (binding.track_id !== track.id) return;
      const mainIds = binding.main_segment_ids;
      binding.main_segment_ids = [...(binding.extension_segment_ids || [])];
      binding.extension_segment_ids = [...(mainIds || [])];
      bindingCount++;
    });
    rebuildBindingOffsets(multi, project.segments);
    return {
      swapped: true,
      trackId: track.id,
      mainCount: project.segments.length,
      extensionCount: track.segments.length,
      bindingCount,
      mappedColorCount,
    };
  }


  function removeSubtitleBindings(multiSubtitle, predicate) {
    if (!multiSubtitle || !Array.isArray(multiSubtitle.bindings)) return [];
    const removed = [];
    multiSubtitle.bindings = multiSubtitle.bindings.filter((binding) => {
      if (!predicate(binding)) return true;
      removed.push(binding);
      return false;
    });
    return removed;
  }


  function matchSubtitleSegments(mainSegments, extensionSegments, toleranceMs = MULTI_SUBTITLE_TOLERANCE_MS) {
    const main = Array.isArray(mainSegments) ? mainSegments : [];
    const extension = Array.isArray(extensionSegments) ? extensionSegments : [];
    const tolerance = Math.max(0, Math.round(Number(toleranceMs) || MULTI_SUBTITLE_TOLERANCE_MS));
    const candidates = [];
    const byExtension = extension.map(() => []);
    const byMain = main.map(() => []);
    extension.forEach((candidateExtension, extensionIndex) => {
      main.forEach((candidateMain, mainIndex) => {
        const startDiff = Math.abs(Number(candidateExtension?.start) - Number(candidateMain?.start));
        const endDiff = Math.abs(Number(candidateExtension?.end) - Number(candidateMain?.end));
        const overlaps = Number(candidateExtension?.start) <= Number(candidateMain?.end)
          && Number(candidateExtension?.end) >= Number(candidateMain?.start);
        if (!overlaps || startDiff > tolerance || endDiff > tolerance) return;
        const candidate = { mainIndex, extensionIndex, startDiff, endDiff, cost: startDiff + endDiff };
        candidates.push(candidate);
        byExtension[extensionIndex].push(candidate);
        byMain[mainIndex].push(candidate);
      });
    });
    candidates.sort((left, right) => left.cost - right.cost || left.startDiff - right.startDiff
      || left.extensionIndex - right.extensionIndex || left.mainIndex - right.mainIndex);
    const usedMain = new Set();
    const usedExtension = new Set();
    const matches = [];
    candidates.forEach((candidate) => {
      if (usedMain.has(candidate.mainIndex) || usedExtension.has(candidate.extensionIndex)) return;
      usedMain.add(candidate.mainIndex);
      usedExtension.add(candidate.extensionIndex);
      matches.push(candidate);
    });
    const conflictExtensions = byExtension.filter((items) => items.length > 1).length;
    const conflictMains = byMain.filter((items) => items.length > 1).length;
    return {
      matches,
      unmatchedMain: main.map((_, index) => index).filter((index) => !usedMain.has(index)),
      unmatchedExtension: extension.map((_, index) => index).filter((index) => !usedExtension.has(index)),
      candidates,
      conflicts: Math.max(conflictExtensions, conflictMains),
      tolerance_ms: tolerance,
    };
  }


  function buildMultiDisplayRows(mainSegments, extensionSegments, bindings = []) {
    const main = Array.isArray(mainSegments) ? mainSegments : [];
    const extension = Array.isArray(extensionSegments) ? extensionSegments : [];
    const extensionById = new Map(extension.map((segment, index) => [stableId(segment?.id), index]));
    const mainToExtension = new Map();
    const extensionBound = new Set();
    bindings.forEach((binding) => {
      const mainId = binding.main_segment_ids?.[0];
      const extensionId = binding.extension_segment_ids?.[0];
      const extensionIndex = extensionById.get(extensionId);
      if (!Number.isInteger(extensionIndex) || mainToExtension.has(mainId)) return;
      mainToExtension.set(mainId, extensionIndex);
      extensionBound.add(extensionIndex);
    });
    const rows = [];
    let extensionCursor = 0;
    main.forEach((segment, mainIndex) => {
      while (extensionCursor < extension.length && !extensionBound.has(extensionCursor)
          && Number(extension[extensionCursor]?.start) <= Number(segment?.start)) {
        rows.push({ mainIndex: null, extensionIndex: extensionCursor++ });
      }
      rows.push({ mainIndex, extensionIndex: mainToExtension.get(segment.id) ?? null });
    });
    while (extensionCursor < extension.length) {
      if (!extensionBound.has(extensionCursor)) rows.push({ mainIndex: null, extensionIndex: extensionCursor });
      extensionCursor++;
    }
    return rows;
  }


  // 合并选区只有在每条字幕都指向同一个有效 group head 时才继承该 group。
  // 若选区包含 head，新字幕继续作为 head；若选区只是同组 refs，则继续指向原 head。
  function resolveMergedGroupInheritance(segments, indexes, headField, refField) {
    if (!Array.isArray(segments) || !Array.isArray(indexes) || !indexes.length) {
      return { head: null, ref: null, headIdx: null };
    }
    const headIndexes = indexes.map((index) => {
      const segment = segments[index];
      if (!segment) return null;
      if (segment[headField]) return index;
      const headIdx = segment[refField]?.headIdx;
      return Number.isInteger(headIdx) && segments[headIdx]?.[headField] ? headIdx : null;
    });
    const commonHeadIdx = headIndexes[0];
    if (
      !Number.isInteger(commonHeadIdx)
      || headIndexes.some((headIdx) => headIdx !== commonHeadIdx)
    ) {
      return { head: null, ref: null, headIdx: null };
    }

    const head = segments[commonHeadIdx][headField];
    if (indexes.includes(commonHeadIdx)) {
      return {
        head: cloneJsonValue(head),
        ref: null,
        headIdx: commonHeadIdx,
      };
    }

    const sourceRef = indexes
      .map((index) => segments[index]?.[refField])
      .find((ref) => ref && ref.headIdx === commonHeadIdx);
    const inheritedRef = cloneJsonValue(sourceRef) || {};
    inheritedRef.headIdx = commonHeadIdx;
    if (!inheritedRef.name && head?.name) inheritedRef.name = head.name;
    return {
      head: null,
      ref: inheritedRef,
      headIdx: commonHeadIdx,
    };
  }

  return Object.freeze({ MULTI_SUBTITLE_DISPLAY_MODES, MULTI_SUBTITLE_SCHEMA, MULTI_SUBTITLE_SPLIT_MODES, MULTI_SUBTITLE_TOLERANCE_MS, bindingForSegment, buildMultiDisplayRows, buildSubtitleBinding, matchSubtitleSegments, mergeMainAndOverlaySegments, moveSegmentBetweenTracks, normalizeMultiSubtitle, normalizeMultiSubtitleProject, normalizeOverlayTrack, rebuildBindingOffsets, removeSubtitleBindings, resolveMergedGroupInheritance, swapMainAndExtensionSubtitle });
});

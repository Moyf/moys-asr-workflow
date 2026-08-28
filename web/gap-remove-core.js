// Shared gap-remove data and playback helpers used by MAWE and the alignment UI.
// Keep this module free of DOM, media elements, editor history, and rendering.
(function initAsrGapRemoveCore(global) {
  'use strict';

  const GAP_REMOVE_SCHEMA = 'moy.asr.gap_remove.v1';
  const GAP_PROVENANCE_SCHEMA = 'moy.asr.gap_provenance.v1';
  const GAP_PROVENANCE_SOURCES = Object.freeze([
    'script_alignment',
    'audio_gate',
    'manual',
    'legacy',
  ]);
  const GAP_PROVENANCE_SOURCE_SET = new Set(GAP_PROVENANCE_SOURCES);
  const GAP_REMOVE_OPERATION_MODES = Object.freeze([
    'none',
    'boundary_drag',
    'middle_drag',
    'boundary_and_middle',
  ]);
  const GAP_REMOVE_OPERATION_MODE_SET = new Set(GAP_REMOVE_OPERATION_MODES);
  const DEFAULT_GAP_REMOVE_OPERATION_MODE = 'boundary_drag';
  const GAP_REMOVE_MANUAL_OPERATION_BOUNDARY_RESIZE = 'boundary_resize';
  const GAP_REMOVE_MANUAL_OPERATION_MOVE = 'move';
  const GAP_REMOVE_BOUNDARY_EDGES = Object.freeze(['start', 'end']);
  const GAP_REMOVE_DISABLE_COVERAGE_DEFAULT = 80;
  const GAP_REMOVE_DISABLE_REMAINING_DEFAULT_MS = 300;
  const GAP_REMOVE_DISABLE_REMAINING_MAX_MS = 60000;
  const GAP_DISPLAY_PROJECTION_CACHE = new WeakMap();

  function cloneJsonValue(value) {
    return value == null ? null : JSON.parse(JSON.stringify(value));
  }

  function clampInteger(value, fallback, minimum, maximum) {
    const rounded = Math.round(Number(value));
    return Math.min(maximum, Math.max(minimum, Number.isFinite(rounded) ? rounded : fallback));
  }

  function clampGapRemoveDisableCoverage(value) {
    const numeric = typeof value === 'string' && !value.trim() ? NaN : Number(value);
    return Math.min(100, Math.max(0, Number.isFinite(numeric)
      ? numeric : GAP_REMOVE_DISABLE_COVERAGE_DEFAULT));
  }

  function clampGapRemoveDisableRemaining(value) {
    const numeric = typeof value === 'string' && !value.trim() ? NaN : value;
    return clampInteger(
      numeric,
      GAP_REMOVE_DISABLE_REMAINING_DEFAULT_MS,
      0,
      GAP_REMOVE_DISABLE_REMAINING_MAX_MS,
    );
  }

  function normalizeGapOperationMode(value) {
    return typeof value === 'string' && GAP_REMOVE_OPERATION_MODE_SET.has(value)
      ? value : DEFAULT_GAP_REMOVE_OPERATION_MODE;
  }

  function gapOperationAllowsBoundary(mode) {
    return mode === 'boundary_drag' || mode === 'boundary_and_middle';
  }

  function gapOperationAllowsMiddle(mode) {
    return mode === 'middle_drag' || mode === 'boundary_and_middle';
  }

  function gapKey(gap) {
    return `${Math.round(Number(gap.start))}:${Math.round(Number(gap.end))}`;
  }

  function normalizeGapRemoveGaps(gaps) {
    if (!Array.isArray(gaps)) return [];
    const seen = new Set();
    return gaps
      .map((gap) => ({
        start: Math.max(0, Math.round(Number(gap?.start))),
        end: Math.max(0, Math.round(Number(gap?.end))),
        removed: gap?.removed !== false,
      }))
      .filter((gap) => Number.isFinite(gap.start) && Number.isFinite(gap.end) && gap.end > gap.start)
      .sort((left, right) => left.start - right.start || left.end - right.end)
      .filter((gap) => {
        const key = gapKey(gap);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function provenanceId(value, source, index, used) {
    const requested = typeof value === 'string' ? value.trim().slice(0, 160) : '';
    const base = requested || `${source}-${String(index + 1).padStart(3, '0')}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    return id;
  }

  function normalizeGapRangeList(value) {
    return (Array.isArray(value) ? value : [value])
      .map((range) => ({
        start: Math.max(0, Math.round(Number(range?.start))),
        end: Math.max(0, Math.round(Number(range?.end))),
      }))
      .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end)
        && range.end > range.start)
      .sort((left, right) => left.start - right.start || left.end - right.end)
      .reduce((result, range) => {
        const previous = result[result.length - 1];
        if (previous && range.start <= previous.end) {
          previous.end = Math.max(previous.end, range.end);
        } else {
          result.push(range);
        }
        return result;
      }, []);
  }

  // A boundary adjustment can remember portions of other visible Gaps that it
  // covered. They are cleared before this adjustment reapplies the dragged
  // Gap, so moving the boundary back never reveals an old covered Gap.
  function gapBoundaryClearedRanges(item) {
    return normalizeGapRangeList(item?.cleared_ranges);
  }

  function isBoundaryResizeRecord(item) {
    return item?.source === 'manual'
      && item?.operation === GAP_REMOVE_MANUAL_OPERATION_BOUNDARY_RESIZE
      && GAP_REMOVE_BOUNDARY_EDGES.includes(item?.edge)
      && Number.isFinite(Number(item?.base))
      && Number.isFinite(Number(item?.boundary))
       && (
         Math.round(Number(item.base)) !== Math.round(Number(item.boundary))
         || gapBoundaryClearedRanges(item).length > 0
       );
  }

  // A move can retain more than one destination piece after another Gap covers
  // only part of it. Keeping those pieces with the original move is important:
  // its base must stay cleared even if its visible destination is fully covered.
  // Older projects store one `target_start` / `target_end` pair; new split
  // records use `target_ranges` only when one pair is no longer sufficient.
  function gapMoveTargetRanges(item) {
    const rawTargets = Array.isArray(item?.target_ranges)
      ? item.target_ranges
      : [{ start: item?.target_start, end: item?.target_end }];
    const ranges = rawTargets
      .map((range) => ({
        start: Math.max(0, Math.round(Number(range?.start))),
        end: Math.max(0, Math.round(Number(range?.end))),
      }))
      .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end)
        && range.end > range.start)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    return ranges.reduce((result, range) => {
      const previous = result[result.length - 1];
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        result.push(range);
      }
      return result;
    }, []);
  }

  function hasGapMoveTargetRanges(item) {
    const ranges = gapMoveTargetRanges(item);
    if (Array.isArray(item?.target_ranges)) {
      return item.target_ranges.length === 0 || ranges.length > 0;
    }
    return ranges.length > 0;
  }

  function createGapMoveRecord({
    id,
    removed,
    baseStart,
    baseEnd,
    targetRanges,
  }) {
    const targets = gapMoveTargetRanges({ target_ranges: targetRanges });
    const bounds = [{ start: baseStart, end: baseEnd }, ...targets];
    const record = {
      id,
      source: 'manual',
      start: Math.min(...bounds.map((range) => range.start)),
      end: Math.max(...bounds.map((range) => range.end)),
      removed: removed !== false,
      operation: GAP_REMOVE_MANUAL_OPERATION_MOVE,
      base_start: baseStart,
      base_end: baseEnd,
    };
    if (targets.length === 1) {
      record.target_start = targets[0].start;
      record.target_end = targets[0].end;
    } else {
      record.target_ranges = targets;
    }
    return record;
  }

  function isGapMoveRecord(item) {
    return item?.source === 'manual'
      && item?.operation === GAP_REMOVE_MANUAL_OPERATION_MOVE
      && Number.isFinite(Number(item?.base_start))
      && Number.isFinite(Number(item?.base_end))
      && Number(item.base_end) > Number(item.base_start)
      && hasGapMoveTargetRanges(item);
  }

  function normalizeProvenanceRange(item, source, index, used) {
    if (!item || typeof item !== 'object' || !GAP_PROVENANCE_SOURCE_SET.has(source)) return null;
    const start = Math.max(0, Math.round(Number(item.start)));
    const end = Math.max(0, Math.round(Number(item.end)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const result = {
      id: provenanceId(item.id, source, index, used),
      source,
      start,
      end,
    };
    if (source === 'manual' || source === 'legacy') result.removed = item.removed !== false;
    else result.removed = true;
    if (source === 'manual' && item.operation === GAP_REMOVE_MANUAL_OPERATION_BOUNDARY_RESIZE) {
      const edge = item.edge;
      const base = Math.max(0, Math.round(Number(item.base)));
      const boundary = Math.max(0, Math.round(Number(item.boundary)));
      const clearedRanges = gapBoundaryClearedRanges(item);
      if (GAP_REMOVE_BOUNDARY_EDGES.includes(edge)
          && Number.isFinite(base) && Number.isFinite(boundary)
          && (base !== boundary || clearedRanges.length)) {
        result.operation = GAP_REMOVE_MANUAL_OPERATION_BOUNDARY_RESIZE;
        result.edge = edge;
        result.base = base;
        result.boundary = boundary;
        if (clearedRanges.length) result.cleared_ranges = clearedRanges;
        result.start = Math.min(base, boundary, ...clearedRanges.map((range) => range.start));
        result.end = Math.max(base, boundary, ...clearedRanges.map((range) => range.end));
      }
    }
    if (source === 'manual' && item.operation === GAP_REMOVE_MANUAL_OPERATION_MOVE) {
      const baseStart = Math.max(0, Math.round(Number(item.base_start)));
      const baseEnd = Math.max(0, Math.round(Number(item.base_end)));
      const targets = gapMoveTargetRanges(item);
      const hasTargets = hasGapMoveTargetRanges(item);
      const returnedToBase = targets.length === 1
        && targets[0].start === baseStart && targets[0].end === baseEnd;
      if (Number.isFinite(baseStart) && Number.isFinite(baseEnd)
          && baseEnd > baseStart && hasTargets && !returnedToBase) {
        result.operation = GAP_REMOVE_MANUAL_OPERATION_MOVE;
        result.base_start = baseStart;
        result.base_end = baseEnd;
        result.start = Math.min(baseStart, ...targets.map((range) => range.start));
        result.end = Math.max(baseEnd, ...targets.map((range) => range.end));
        if (targets.length === 1) {
          result.target_start = targets[0].start;
          result.target_end = targets[0].end;
        } else {
          result.target_ranges = targets;
        }
      }
    }
    return result;
  }

  function normalizeProvenanceRangeList(value, source, {sort = false} = {}) {
    if (!Array.isArray(value)) return [];
    const used = new Set();
    const result = value
      .map((item, index) => normalizeProvenanceRange(item, source, index, used))
      .filter(Boolean);
    if (sort) result.sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
    return result;
  }

  function normalizeGapRemoveProvenance(value, fallbackGaps = []) {
    const hasValue = value && typeof value === 'object';
    const source = hasValue ? value : {};
    const rawSources = source.sources && typeof source.sources === 'object' ? source.sources : {};
    // Before provenance existed, the editor's gap list was produced by the
    // audio gate. Migrate those enabled ranges into that replaceable source.
    // A legacy `removed:false` range is the only state that cannot be an
    // audio-gate record, so retain it as a manual restoration instead.
    const legacy = normalizeProvenanceRangeList(
      hasValue ? source.legacy : normalizeGapRemoveGaps(fallbackGaps),
      'legacy',
    );
    const legacyAudioGaps = legacy.filter((item) => item.removed !== false);
    const legacyManualOverrides = legacy.filter((item) => item.removed === false);
    return {
      schema: GAP_PROVENANCE_SCHEMA,
      sources: {
        script_alignment: normalizeProvenanceRangeList(rawSources.script_alignment, 'script_alignment', {sort: true}),
        audio_gate: normalizeProvenanceRangeList(
          [...(Array.isArray(rawSources.audio_gate) ? rawSources.audio_gate : []), ...legacyAudioGaps],
          'audio_gate',
          {sort: true},
        ),
      },
      manual_overrides: normalizeProvenanceRangeList(
        [...legacyManualOverrides, ...(Array.isArray(source.manual_overrides) ? source.manual_overrides : [])],
        'manual',
      ),
      legacy: [],
    };
  }

  function applyGapStateRange(gaps, startMs, endMs, removed, preserveUncovered = false) {
    const source = coalesceGapRemoveGaps(gaps);
    const start = Math.max(0, Math.round(Math.min(Number(startMs), Number(endMs))));
    const end = Math.max(0, Math.round(Math.max(Number(startMs), Number(endMs))));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return source;
    const next = [];
    source.forEach((gap) => {
      if (gap.end <= start || gap.start >= end) {
        next.push({ ...gap });
        return;
      }
      if (gap.start < start) next.push({ ...gap, end: start });
      if (!removed && !preserveUncovered) {
        next.push({
          start: Math.max(gap.start, start),
          end: Math.min(gap.end, end),
          removed: false,
        });
      }
      if (gap.end > end) next.push({ ...gap, start: end });
    });
    if (removed || preserveUncovered) next.push({ start, end, removed });
    return coalesceGapRemoveGaps(next);
  }

  // Remove a range from the current gap projection without adding a visible
  // `removed:false` restoration layer. Boundary resizing uses this operation
  // when an enabled gap is shortened, so the gap remains one whole object.
  function clearGapStateRange(gaps, startMs, endMs, state = null) {
    const source = coalesceGapRemoveGaps(gaps);
    const start = Math.max(0, Math.round(Math.min(Number(startMs), Number(endMs))));
    const end = Math.max(0, Math.round(Math.max(Number(startMs), Number(endMs))));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return source;
    const next = [];
    source.forEach((gap) => {
      if (gap.end <= start || gap.start >= end) {
        next.push({ ...gap });
        return;
      }
      if (state !== null && gap.removed !== state) {
        next.push({ ...gap });
        return;
      }
      if (gap.start < start) next.push({ ...gap, end: start });
      if (gap.end > end) next.push({ ...gap, start: end });
    });
    return coalesceGapRemoveGaps(next);
  }

  function applyGapMoveRecord(gaps, record) {
    if (!isGapMoveRecord(record)) return gaps;
    const removed = record.removed !== false;
    let result = clearGapStateRange(
      gaps,
      record.base_start,
      record.base_end,
      removed,
    );
    gapMoveTargetRanges(record).forEach((target) => {
      result = applyGapStateRange(
        result,
        target.start,
        target.end,
        removed,
        !removed,
      );
    });
    return result;
  }

  function applyBoundaryResizeRecord(gaps, record) {
    if (!isBoundaryResizeRecord(record)) return gaps;
    const base = Math.round(Number(record.base));
    const boundary = Math.round(Number(record.boundary));
    const removed = record.removed !== false;
    let result = gaps;
    gapBoundaryClearedRanges(record).forEach((range) => {
      result = clearGapStateRange(result, range.start, range.end);
    });
    if (record.edge === 'start') {
      if (boundary > base) {
        // A smaller restored Gap is not an instruction to activate the
        // vacated edge. Remove that visible range just as an enabled Gap
        // shrink does, so no new orange Gap appears beside it.
        return clearGapStateRange(result, base, boundary);
      }
      return removed
        ? applyGapStateRange(result, boundary, base, true)
        : applyGapStateRange(result, boundary, base, false, true);
    }
    if (boundary < base) {
      return clearGapStateRange(result, boundary, base);
    }
    return removed
      ? applyGapStateRange(result, base, boundary, true)
      : applyGapStateRange(result, base, boundary, false, true);
  }

  function gapRangesFromProvenance(value, fallbackGaps = []) {
    const provenance = normalizeGapRemoveProvenance(value, fallbackGaps);
    let result = [];
    provenance.sources.script_alignment.forEach((gap) => {
      result = applyGapStateRange(result, gap.start, gap.end, true);
    });
    provenance.sources.audio_gate.forEach((gap) => {
      result = applyGapStateRange(result, gap.start, gap.end, true);
    });
    provenance.legacy.forEach((gap) => {
      result = applyGapStateRange(result, gap.start, gap.end, gap.removed, gap.removed === false);
    });
    provenance.manual_overrides.forEach((gap) => {
      result = isBoundaryResizeRecord(gap)
        ? applyBoundaryResizeRecord(result, gap)
        : isGapMoveRecord(gap)
          ? applyGapMoveRecord(result, gap)
        : applyGapStateRange(result, gap.start, gap.end, gap.removed, gap.removed === false);
    });
    return coalesceGapRemoveGaps(result);
  }

  function decorateGapRemoveGaps(gaps, value) {
    const finalGaps = normalizeGapRemoveGaps(gaps);
    const provenance = normalizeGapRemoveProvenance(value, finalGaps);
    const records = [
      ...provenance.sources.script_alignment,
      ...provenance.sources.audio_gate,
      ...provenance.manual_overrides.filter((record) => (
        !isBoundaryResizeRecord(record) && !isGapMoveRecord(record)
      )),
      ...provenance.legacy,
    ];
    const boundaryRecords = provenance.manual_overrides.filter(isBoundaryResizeRecord);
    const moveRecords = provenance.manual_overrides.filter(isGapMoveRecord);
    return finalGaps.flatMap((gap) => {
      const boundaries = new Set([gap.start, gap.end]);
      records.forEach((record) => {
        if (record.end > gap.start && record.start < gap.end) {
          boundaries.add(Math.max(gap.start, record.start));
          boundaries.add(Math.min(gap.end, record.end));
        }
      });
      const points = [...boundaries].sort((left, right) => left - right);
      const slices = [];
      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index];
        const end = points[index + 1];
        if (end <= start) continue;
        const origins = GAP_PROVENANCE_SOURCES.filter((source) => {
          if (source === 'manual' && boundaryRecords.some((record) => (
            record.boundary === start || record.boundary === end
          ))) return true;
          if (source === 'manual' && moveRecords.some((record) => (
            gapMoveTargetRanges(record).some((target) => (
              target.start < end && target.end > start
            ))
          ))) return true;
          return records.some((record) => (
            record.source === source && record.start < end && record.end > start
          ));
        });
        const baseOrigins = origins.filter((source) => source !== 'manual');
        slices.push({
          ...gap,
          start,
          end,
          source: baseOrigins.length === 1
            ? baseOrigins[0]
            : baseOrigins.length ? null : origins.includes('manual') ? 'manual' : null,
          origins,
        });
      }
      return slices;
    });
  }

  function replaceGapRemoveProvenanceSource(value, source, ranges, fallbackGaps = []) {
    const next = normalizeGapRemoveProvenance(value, fallbackGaps);
    if (source === 'script_alignment' || source === 'audio_gate') {
      next.sources[source] = normalizeProvenanceRangeList(ranges, source, {sort: true});
    }
    return next;
  }

  function appendGapRemoveManualOverrides(value, overrides, fallbackGaps = []) {
    const next = normalizeGapRemoveProvenance(value, fallbackGaps);
    const additions = Array.isArray(overrides) ? overrides : [overrides];
    const used = new Set(next.manual_overrides.map((item) => item.id));
    additions.forEach((item, index) => {
      const normalized = normalizeProvenanceRange(item, 'manual', next.manual_overrides.length + index, used);
      if (normalized) next.manual_overrides.push(normalized);
    });
    return next;
  }

  function coalesceGapRemoveGaps(gaps) {
    const result = [];
    normalizeGapRemoveGaps(gaps).forEach((gap) => {
      const previous = result[result.length - 1];
      if (!previous) {
        result.push({ ...gap });
        return;
      }
      if (gap.start <= previous.end && gap.removed === previous.removed) {
        previous.end = Math.max(previous.end, gap.end);
        return;
      }
      const start = Math.max(gap.start, previous.end);
      if (gap.end > start) result.push({ ...gap, start });
    });
    return result;
  }

  function gapRemoveDisplayOrigins(gap) {
    const normalizeOrigin = (source) => source === 'legacy' ? 'audio_gate' : source;
    const origins = Array.isArray(gap?.origins)
      ? gap.origins.map(normalizeOrigin).filter((source) => GAP_PROVENANCE_SOURCE_SET.has(source))
      : [];
    const source = normalizeOrigin(gap?.source);
    if (!origins.length && GAP_PROVENANCE_SOURCE_SET.has(source)) origins.push(source);
    return GAP_PROVENANCE_SOURCES.filter((item) => item !== 'legacy' && origins.includes(item));
  }

  function gapRemoveDisplaySource(origins) {
    const automaticOrigins = origins.filter((source) => source !== 'manual');
    if (automaticOrigins.length === 1) return automaticOrigins[0];
    if (!automaticOrigins.length && origins.includes('manual')) return 'manual';
    return null;
  }

  // This is a presentation category, not a persisted provenance source. It
  // lets both UIs give protected ranges a small visual cue without exposing
  // the internal source layers as separate gap blocks.
  function getGapRemoveDisplayType(gap) {
    const origins = gapRemoveDisplayOrigins(gap);
    const has = (source) => origins.includes(source);
    const hasAudio = has('audio_gate');
    const hasScript = has('script_alignment');
    const hasManual = has('manual');
    const automaticOriginCount = [hasAudio, hasScript].filter(Boolean).length;
    if (automaticOriginCount > 1) return hasManual ? 'multi_source_manual' : 'multi_source';
    if (hasScript) return hasManual ? 'script_alignment_manual' : 'script_alignment';
    if (hasAudio) return hasManual ? 'audio_gate_manual' : 'audio_gate';
    if (hasManual) return 'manual';
    return 'unknown';
  }

  function isGapRemoveDisplayProtected(gap) {
    const origins = gapRemoveDisplayOrigins(gap);
    return origins.length > 0 && origins.some((source) => source !== 'audio_gate');
  }

  function removeGapRemoveProvenanceRange(value, startMs, endMs, fallbackGaps = []) {
    const provenance = normalizeGapRemoveProvenance(value, fallbackGaps);
    const start = Math.max(0, Math.round(Math.min(Number(startMs), Number(endMs))));
    const end = Math.max(0, Math.round(Math.max(Number(startMs), Number(endMs))));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return provenance;

    const baseRangesToClear = provenance.manual_overrides.flatMap((record) => (
      isGapMoveRecord(record) && gapMoveTargetRanges(record).some((target) => (
        target.start < end && target.end > start
      ))
        ? [{start: record.base_start, end: record.base_end}]
        : []
    ));
    const clearRanges = [{start, end}, ...baseRangesToClear];
    const removeFrom = (ranges, source, sort) => normalizeProvenanceRangeList(
      ranges.flatMap((range) => {
        if (isGapMoveRecord(range) && gapMoveTargetRanges(range).some((target) => (
          target.start < end && target.end > start
        ))) return [];
        return clearRanges.reduce((remaining, clearRange) => remaining.flatMap((piece) => {
          if (piece.end <= clearRange.start || piece.start >= clearRange.end) return [{...piece}];
          const pieces = [];
          if (piece.start < clearRange.start) pieces.push({...piece, end: clearRange.start});
          if (piece.end > clearRange.end) pieces.push({...piece, start: clearRange.end});
          return pieces;
        }), [{...range}]);
      }),
      source,
      {sort},
    );

    return {
      schema: GAP_PROVENANCE_SCHEMA,
      sources: {
        script_alignment: removeFrom(provenance.sources.script_alignment, 'script_alignment', true),
        audio_gate: removeFrom(provenance.sources.audio_gate, 'audio_gate', true),
      },
      manual_overrides: removeFrom(provenance.manual_overrides, 'manual', false),
      legacy: removeFrom(provenance.legacy, 'legacy', false),
    };
  }

  // Boundary expansion is destructive only to the Gap portions it reaches.
  // Static source records can be cut immediately. Stateful manual controls
  // (move/boundary records) stay intact here; the boundary record's own
  // cleared_ranges is replayed last and prevents their old visual result from
  // resurfacing when the user later drags back.
  function clearStaticGapRemoveProvenanceRanges(value, ranges, fallbackGaps = []) {
    const provenance = normalizeGapRemoveProvenance(value, fallbackGaps);
    const clearedRanges = normalizeGapRangeList(ranges);
    if (!clearedRanges.length) return provenance;
    const removeFrom = (items, source, sort) => normalizeProvenanceRangeList(
      items.flatMap((item) => subtractGapAbsorbRanges(item, clearedRanges)),
      source,
      {sort},
    );
    return {
      schema: GAP_PROVENANCE_SCHEMA,
      sources: {
        script_alignment: removeFrom(provenance.sources.script_alignment, 'script_alignment', true),
        audio_gate: removeFrom(provenance.sources.audio_gate, 'audio_gate', true),
      },
      manual_overrides: normalizeProvenanceRangeList(
        provenance.manual_overrides.flatMap((item) => (
          isGapMoveRecord(item) || isBoundaryResizeRecord(item)
            ? [{ ...item }]
            : subtractGapAbsorbRanges(item, clearedRanges)
        )),
        'manual',
      ),
      legacy: removeFrom(provenance.legacy, 'legacy', false),
    };
  }

  function normalizeGapAbsorbRanges(ranges) {
    return normalizeGapRangeList(ranges);
  }

  function subtractGapAbsorbRanges(item, ranges) {
    return ranges.reduce((pieces, range) => pieces.flatMap((piece) => {
      if (piece.end <= range.start || piece.start >= range.end) return [piece];
      const remaining = [];
      if (piece.start < range.start) remaining.push({ ...piece, end: range.start });
      if (piece.end > range.end) remaining.push({ ...piece, start: range.end });
      return remaining;
    }), [{ ...item }]);
  }

  // A moved visible Gap owns any other Gap it covers at the destination. Do
  // not consume the current visible range itself: that is the move record's
  // base object, and it must remain available when the user drags back.
  // A previously moved Gap is different from an ordinary source record: only
  // its current target pieces are covered. Deleting the whole move record
  // would resurrect its cleared base elsewhere on the timeline.
  function absorbGapRemoveProvenanceRanges(
    value,
    ranges,
    preserveIds = [],
    fallbackGaps = [],
    targetRemoved = true,
  ) {
    const provenance = normalizeGapRemoveProvenance(value, fallbackGaps);
    const absorbRanges = normalizeGapAbsorbRanges(ranges);
    if (!absorbRanges.length) return provenance;
    const preserved = new Set(preserveIds);
    const targetState = targetRemoved !== false;
    const overlapsAbsorbedRange = (item) => absorbRanges.some((range) => (
      item.end > range.start && item.start < range.end
    ));
    const cropOrAbsorb = (item) => {
      if (!overlapsAbsorbedRange(item)) return [{ ...item }];
      // Equal-state gaps would otherwise coalesce with the moved target and
      // make it visibly longer. Treat those as fully absorbed; for an
      // inactive/restored Gap the differing-state overlap is only clipped.
      if ((item.removed !== false) === targetState) return [];
      return subtractGapAbsorbRanges(item, absorbRanges);
    };
    const removeFrom = (items, source, sort) => normalizeProvenanceRangeList(
      items.flatMap(cropOrAbsorb),
      source,
      {sort},
    );
    const manual = provenance.manual_overrides.flatMap((item) => {
      if (preserved.has(item.id)) {
        return [{ ...item }];
      }
      if (isGapMoveRecord(item)) {
        const targets = gapMoveTargetRanges(item);
        if (!targets.some(overlapsAbsorbedRange)) {
          return [{ ...item }];
        }
        const remainingTargets = (item.removed !== false) === targetState
          ? targets.filter((target) => !overlapsAbsorbedRange(target))
          : targets.flatMap((target) => subtractGapAbsorbRanges(target, absorbRanges));
        return [createGapMoveRecord({
          id: item.id,
          removed: item.removed,
          baseStart: item.base_start,
          baseEnd: item.base_end,
          targetRanges: remainingTargets,
        })];
      }
      if (!overlapsAbsorbedRange(item)) {
        return [{ ...item }];
      }
      // A boundary operation has no independent destination range to crop.
      // Keep it in place; the later move record wins within the target range.
      if (isBoundaryResizeRecord(item)) return [{ ...item }];
      return cropOrAbsorb(item);
    });
    return {
      schema: GAP_PROVENANCE_SCHEMA,
      sources: {
        script_alignment: removeFrom(provenance.sources.script_alignment, 'script_alignment', true),
        audio_gate: removeFrom(provenance.sources.audio_gate, 'audio_gate', true),
      },
      manual_overrides: normalizeProvenanceRangeList(manual, 'manual'),
      legacy: removeFrom(provenance.legacy, 'legacy', false),
    };
  }

  // The display projection keeps both final states as one visible layer:
  // `removed:true` is an enabled gap, while `removed:false` is a visible but
  // ineffective manual restoration. Source records remain internal.
  function getGapRemoveDisplayGaps(gaps) {
    if (!Array.isArray(gaps)) return [];
    const cached = GAP_DISPLAY_PROJECTION_CACHE.get(gaps);
    if (cached) return cached;
    const normalized = gaps
      .map((gap) => {
        const start = Math.max(0, Math.round(Number(gap?.start)));
        const end = Math.max(0, Math.round(Number(gap?.end)));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        const result = {start, end, removed: gap?.removed !== false};
        const origins = gapRemoveDisplayOrigins(gap);
        if (origins.length) {
          result.source = gapRemoveDisplaySource(origins);
          result.origins = origins;
        }
        return result;
      })
      .filter(Boolean)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    const boundaries = [...new Set(normalized.flatMap((gap) => [gap.start, gap.end]))]
      .sort((left, right) => left - right);
    const result = [];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      if (end <= start) continue;
      const covering = normalized.filter((gap) => gap.start < end && gap.end > start);
      if (!covering.length) continue;
      const removed = !covering.some((gap) => gap.removed === false);
      const origins = GAP_PROVENANCE_SOURCES.filter((source) => covering.some((gap) => (
        gapRemoveDisplayOrigins(gap).includes(source)
      )));
      const next = {start, end, removed};
      if (origins.length) {
        next.source = gapRemoveDisplaySource(origins);
        next.origins = origins;
      }
      const previous = result[result.length - 1];
      if (previous && previous.end === start && previous.removed === removed) {
        previous.end = end;
        const combinedOrigins = GAP_PROVENANCE_SOURCES.filter((source) => (
          gapRemoveDisplayOrigins(previous).includes(source)
          || origins.includes(source)
        ));
        if (combinedOrigins.length) {
          previous.source = gapRemoveDisplaySource(combinedOrigins);
          previous.origins = combinedOrigins;
        }
      } else {
        result.push(next);
      }
    }
    GAP_DISPLAY_PROJECTION_CACHE.set(gaps, result);
    return result;
  }

  function normalizeGapRemoveData(value) {
    const source = value && typeof value === 'object' ? value : {};
    const rawGaps = normalizeGapRemoveGaps(source.gaps);
    const hasProvenance = Boolean(source.provenance && typeof source.provenance === 'object');
    const provenance = normalizeGapRemoveProvenance(source.provenance, rawGaps);
    const computedGaps = hasProvenance ? gapRangesFromProvenance(provenance) : rawGaps;
    const gaps = cloneJsonValue(decorateGapRemoveGaps(computedGaps, provenance)) || [];
    return {
      schema: GAP_REMOVE_SCHEMA,
      // Older gap lists came from the same audio-gate workflow but did not
      // carry a provenance layer. Normalize them into the current detector so
      // their display, shrinking, clearing, and rescanning stay consistent.
      detector: 'audio_gate',
      minimum_ms: clampInteger(source.minimum_ms, 500, 100, 60000),
      threshold_db: Math.min(0, Math.max(-96, Number.isFinite(Number(source.threshold_db)) ? Number(source.threshold_db) : -24)),
      hysteresis_db: Math.min(30, Math.max(0, Number.isFinite(Number(source.hysteresis_db)) ? Number(source.hysteresis_db) : 2)),
      lead_in_ms: clampInteger(source.lead_in_ms, 40, 0, 2000),
      lead_out_ms: clampInteger(source.lead_out_ms, 80, 0, 2000),
      skip_playback: source.skip_playback !== false,
      manual_corrections: source.manual_corrections === true || provenance.manual_overrides.length > 0,
      operation_mode: normalizeGapOperationMode(source.operation_mode),
      disable_coverage_percent: clampGapRemoveDisableCoverage(source.disable_coverage_percent),
      disable_remaining_ms: clampGapRemoveDisableRemaining(source.disable_remaining_ms),
      gaps,
      provenance,
    };
  }

  function applyGapRemoveRange(gaps, startMs, endMs, removed) {
    const source = coalesceGapRemoveGaps(gaps);
    const start = Math.max(0, Math.round(Math.min(Number(startMs), Number(endMs))));
    const end = Math.max(0, Math.round(Math.max(Number(startMs), Number(endMs))));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return source;

    const next = [];
    source.forEach((gap) => {
      if (gap.end <= start || gap.start >= end) {
        next.push({ ...gap });
        return;
      }
      if (gap.start < start) next.push({ ...gap, end: start });
      if (!removed) {
        next.push({
          start: Math.max(gap.start, start),
          end: Math.min(gap.end, end),
          removed: false,
        });
      }
      if (gap.end > end) next.push({ ...gap, start: end });
    });
    if (removed) next.push({ start, end, removed: true });
    return coalesceGapRemoveGaps(next);
  }

  function shrinkGapRemoveGaps(gaps, leadInMs, leadOutMs) {
    const source = coalesceGapRemoveGaps(gaps);
    const leadIn = clampInteger(leadInMs, 40, 0, 2000);
    const leadOut = clampInteger(leadOutMs, 80, 0, 2000);
    return coalesceGapRemoveGaps(source
      .map((gap) => ({
        ...gap,
        start: gap.start + leadIn,
        end: gap.end - leadOut,
      }))
      .filter((gap) => gap.end > gap.start));
  }

  // 将一个已有区段作为整体平移或复制到目标位置。与人工“范围移除”不同，
  // 这里保留区段的 removed 状态，因此恢复区段也可以被整体拖动/复制。
  function overlayGapRemoveRange(gaps, startMs, endMs, removed) {
    const source = coalesceGapRemoveGaps(gaps);
    const start = Math.max(0, Math.round(Math.min(Number(startMs), Number(endMs))));
    const end = Math.max(0, Math.round(Math.max(Number(startMs), Number(endMs))));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return source;
    const next = [];
    source.forEach((gap) => {
      if (gap.end <= start || gap.start >= end) {
        next.push({ ...gap });
        return;
      }
      if (gap.start < start) next.push({ ...gap, end: start });
      if (gap.end > end) next.push({ ...gap, start: end });
    });
    next.push({ start, end, removed: removed !== false });
    return coalesceGapRemoveGaps(next);
  }

  function translateGapRemoveRange(gaps, index, deltaMs, durationMs, copy) {
    const source = coalesceGapRemoveGaps(gaps);
    const gapIndex = Math.round(Number(index));
    const delta = Math.round(Number(deltaMs));
    if (!Number.isFinite(gapIndex) || !Number.isFinite(delta)
        || gapIndex < 0 || gapIndex >= source.length) return source;
    const original = source[gapIndex];
    const durationValue = Number(durationMs);
    const hasDuration = Number.isFinite(durationValue) && durationValue > 0;
    const duration = hasDuration ? Math.round(durationValue) : Infinity;
    const length = Math.min(original.end - original.start, duration);
    if (!Number.isFinite(length) || length <= 0) return source;
    const maxStart = Math.max(0, duration - length);
    const start = Math.min(maxStart, Math.max(0, original.start + delta));
    const end = start + length;
    if (start === original.start && end === original.end) return source;
    const remaining = copy ? source : source.filter((_, sourceIndex) => sourceIndex !== gapIndex);
    return overlayGapRemoveRange(remaining, start, end, original.removed);
  }

  function moveGapRemoveRange(gaps, index, deltaMs, durationMs) {
    return translateGapRemoveRange(gaps, index, deltaMs, durationMs, false);
  }

  function copyGapRemoveRange(gaps, index, deltaMs, durationMs) {
    return translateGapRemoveRange(gaps, index, deltaMs, durationMs, true);
  }

  function gapBoundaryTarget(gap, edge, valueMs, minimumMs = 10) {
    if (!gap || !GAP_REMOVE_BOUNDARY_EDGES.includes(edge)) return null;
    const value = Math.round(Number(valueMs));
    const minimum = Math.max(1, Math.round(Number(minimumMs) || 10));
    if (!Number.isFinite(value)) return null;
    if (edge === 'start') {
      return {
        ...gap,
        start: Math.min(gap.end - minimum, Math.max(0, value)),
      };
    }
    return {
      ...gap,
      end: Math.max(gap.start + minimum, value),
    };
  }

  function gapBoundaryExpansionRange(original, target, edge) {
    if (!original || !target || !GAP_REMOVE_BOUNDARY_EDGES.includes(edge)) return null;
    if (edge === 'start' && target.start < original.start) {
      return {start: target.start, end: original.start};
    }
    if (edge === 'end' && target.end > original.end) {
      return {start: original.end, end: target.end};
    }
    return null;
  }

  // Full coverage clears that whole visible Gap. Partial coverage only clears
  // the intersecting part, so the untouched side keeps its original state.
  function gapBoundaryCoveredRanges(gaps, index, original, target, edge) {
    const expansion = gapBoundaryExpansionRange(original, target, edge);
    if (!expansion) return [];
    return normalizeGapRangeList(gaps.flatMap((gap, gapIndex) => {
      if (gapIndex === index || gap.end <= expansion.start || gap.start >= expansion.end) return [];
      if (expansion.start <= gap.start && expansion.end >= gap.end) {
        return [{start: gap.start, end: gap.end}];
      }
      return [{
        start: Math.max(gap.start, expansion.start),
        end: Math.min(gap.end, expansion.end),
      }];
    }));
  }

  function resizeGapRemoveBoundary(gaps, index, edge, valueMs, minimumMs = 10) {
    const source = coalesceGapRemoveGaps(gaps);
    const gapIndex = Math.round(Number(index));
    if (!Number.isFinite(gapIndex)
        || gapIndex < 0 || gapIndex >= source.length || !['start', 'end'].includes(edge)) {
      return source;
    }
    const original = source[gapIndex];
    const target = gapBoundaryTarget(original, edge, valueMs, minimumMs);
    if (!target || (target.start === original.start && target.end === original.end)) return source;
    // The dragged edge owns its target range. It must not turn a shared
    // boundary into a coupled resize of the neighboring Gap.
    return overlayGapRemoveRange(
      source.filter((_, sourceIndex) => sourceIndex !== gapIndex),
      target.start,
      target.end,
      target.removed,
    );
  }

  function resizedGapAtBoundary(gaps, index, edge, nextGaps) {
    const original = gaps[index];
    if (!original) return null;
    const anchor = edge === 'start' ? original.end - 1 : original.start + 1;
    return nextGaps.find((gap) => (
      gap.removed === original.removed && gap.start <= anchor && gap.end > anchor
    )) || null;
  }

  function boundaryResizeChange(original, target, edge) {
    if (!original || !target || !GAP_REMOVE_BOUNDARY_EDGES.includes(edge)) return null;
    const boundary = Math.round(Number(target[edge]));
    const current = Math.round(Number(original[edge]));
    if (!Number.isFinite(boundary) || boundary === current) return null;
    return { original, edge, boundary };
  }

  function findBoundaryResizeRecordIndex(provenance, original, edge, usedChanges = []) {
    const current = Math.round(Number(original?.[edge]));
    for (let index = provenance.manual_overrides.length - 1; index >= 0; index -= 1) {
      const record = provenance.manual_overrides[index];
      if (!isBoundaryResizeRecord(record) || record.edge !== edge
          || record.removed !== (original.removed !== false)
          || record.boundary !== current) continue;
      if (usedChanges.some((used) => used.recordId && used.recordId === record.id)) continue;
      return index;
    }
    return -1;
  }

  function upsertBoundaryResizeRecord(provenance, change, usedChanges = []) {
    const { original, edge, boundary, clearedRanges = [] } = change;
    const current = Math.round(Number(original[edge]));
    const candidateIndex = findBoundaryResizeRecordIndex(provenance, original, edge, usedChanges);
    const candidate = candidateIndex >= 0 ? provenance.manual_overrides[candidateIndex] : null;
    const base = candidate ? Math.round(Number(candidate.base)) : current;
    const nextClearedRanges = normalizeGapRangeList([
      ...gapBoundaryClearedRanges(candidate),
      ...clearedRanges,
    ]);
    const next = provenance.manual_overrides.filter((_, index) => index !== candidateIndex);
    if (boundary !== base || nextClearedRanges.length) {
      next.push({
        id: candidate?.id,
        source: 'manual',
        start: Math.min(base, boundary, ...nextClearedRanges.map((range) => range.start)),
        end: Math.max(base, boundary, ...nextClearedRanges.map((range) => range.end)),
        removed: original.removed !== false,
        operation: GAP_REMOVE_MANUAL_OPERATION_BOUNDARY_RESIZE,
        edge,
        base,
        boundary,
        ...(nextClearedRanges.length ? {cleared_ranges: nextClearedRanges} : {}),
      });
    }
    const normalized = normalizeGapRemoveProvenance({
      ...provenance,
      manual_overrides: next,
    });
    return {
      provenance: normalized,
      recordId: candidate?.id || normalized.manual_overrides[normalized.manual_overrides.length - 1]?.id,
    };
  }

  function gapRemoveRangesEqual(left, right) {
    const a = normalizeGapRemoveGaps(left);
    const b = normalizeGapRemoveGaps(right);
    return a.length === b.length && a.every((gap, index) => {
      const other = b[index];
      return other && gap.start === other.start && gap.end === other.end
        && gap.removed === other.removed;
    });
  }

  function movedGapAtTarget(gaps, original, start, end) {
    const sameState = (gap) => gap && gap.removed === original.removed;
    return gaps.find((gap) => sameState(gap) && gap.start <= start && gap.end >= end)
      || gaps.find((gap) => {
        const anchor = start + Math.max(1, end - start) / 2;
        return sameState(gap) && gap.start <= anchor && gap.end > anchor;
      })
      || null;
  }

  function upsertGapMoveRecord(provenance, change, absorbRanges = []) {
    const { original, target } = change;
    const removed = original.removed !== false;
    let candidateIndex = -1;
    let candidateTargetIndex = -1;
    for (let index = provenance.manual_overrides.length - 1; index >= 0; index -= 1) {
      const record = provenance.manual_overrides[index];
      if (!isGapMoveRecord(record) || record.removed !== removed) continue;
      const targetIndex = gapMoveTargetRanges(record).findIndex((range) => (
        range.start === original.start && range.end === original.end
      ));
      if (targetIndex < 0) continue;
      candidateIndex = index;
      candidateTargetIndex = targetIndex;
      break;
    }
    const candidate = candidateIndex >= 0 ? provenance.manual_overrides[candidateIndex] : null;
    const baseStart = candidate ? Math.round(Number(candidate.base_start)) : original.start;
    const baseEnd = candidate ? Math.round(Number(candidate.base_end)) : original.end;
    const candidateTargets = candidate ? gapMoveTargetRanges(candidate) : [];
    const nextTargets = candidate
      ? candidateTargets.map((range, index) => (
        index === candidateTargetIndex ? { start: target.start, end: target.end } : range
      ))
      : [{ start: target.start, end: target.end }];
    const targetReturnsToBase = target.start === baseStart && target.end === baseEnd;
    const removeRecord = targetReturnsToBase && (!candidate || candidateTargets.length === 1);
    const absorbed = removeRecord
      ? provenance
      : absorbGapRemoveProvenanceRanges(
        provenance,
        absorbRanges,
        candidate ? [candidate.id] : [],
        [],
        removed,
      );
    const next = absorbed.manual_overrides.filter((item) => (
      !candidate || item.id !== candidate.id
    ));
    if (!removeRecord) {
      next.push(createGapMoveRecord({
        id: candidate?.id,
        removed,
        baseStart,
        baseEnd,
        targetRanges: nextTargets,
      }));
    }
    const normalized = normalizeGapRemoveProvenance({
      ...absorbed,
      manual_overrides: next,
    });
    return {
      provenance: normalized,
      recordId: candidate?.id || normalized.manual_overrides[normalized.manual_overrides.length - 1]?.id,
    };
  }

  // Move one final visible Gap as a whole. The move is a single internal
  // operation: remove only the selected state from its base range and apply
  // that same state at the target. Repeating the move updates the operation,
  // so it never grows a chain of restoration masks.
  function moveGapRemoveProvenance(
    value,
    gaps,
    index,
    deltaMs,
    durationMs,
    fallbackGaps = [],
  ) {
    const visible = getGapRemoveDisplayGaps(gaps);
    const gapIndex = Math.round(Number(index));
    const provenance = normalizeGapRemoveProvenance(value, fallbackGaps);
    if (!Number.isFinite(gapIndex) || gapIndex < 0 || gapIndex >= visible.length) {
      return { changed: false, provenance, gaps: gapRangesFromProvenance(provenance) };
    }
    const original = visible[gapIndex];
    const delta = Math.round(Number(deltaMs));
    const durationValue = Number(durationMs);
    if (!Number.isFinite(delta)) {
      return { changed: false, provenance, gaps: gapRangesFromProvenance(provenance) };
    }
    const length = original.end - original.start;
    const duration = Number.isFinite(durationValue) && durationValue > 0
      ? Math.round(durationValue) : Infinity;
    const maxStart = Math.max(0, duration - length);
    const targetStart = Math.min(
      maxStart,
      Math.max(0, original.start + delta),
    );
    const targetEnd = targetStart + length;
    if (targetStart === original.start && targetEnd === original.end) {
      return { changed: false, provenance, gaps: gapRangesFromProvenance(provenance) };
    }
    // Keep the dragged block's geometry exact. `moveGapRemoveRange()` is a
    // useful visual overlay helper, but it coalesces adjacent ranges; using
    // that merged result as the persisted target makes an active Gap pull an
    // adjacent inactive Gap along with it.
    const target = { ...original, start: targetStart, end: targetEnd };
    const absorbRanges = subtractGapAbsorbRanges(
      target,
      [{ start: original.start, end: original.end }],
    ).map((range) => ({ start: range.start, end: range.end }));
    const recordResult = upsertGapMoveRecord(
      provenance,
      { original, target },
      absorbRanges,
    );
    return {
      changed: true,
      provenance: recordResult.provenance,
      gaps: gapRangesFromProvenance(recordResult.provenance),
      original,
      target,
    };
  }

  // Resize the final visible Gap as one object. The persisted boundary
  // operation is updated in place (and moved to the end of the manual action
  // order), so repeated drags never append a stack of restoration masks.
  function resizeGapRemoveProvenanceBoundary(
    value,
    gaps,
    index,
    edge,
    valueMs,
    fallbackGaps = [],
  ) {
    const visible = getGapRemoveDisplayGaps(gaps);
    const gapIndex = Math.round(Number(index));
    const provenance = normalizeGapRemoveProvenance(value, fallbackGaps);
    if (!Number.isFinite(gapIndex) || gapIndex < 0 || gapIndex >= visible.length
        || !GAP_REMOVE_BOUNDARY_EDGES.includes(edge)) {
      return { changed: false, provenance, gaps: gapRangesFromProvenance(provenance) };
    }
    const original = visible[gapIndex];
    const target = gapBoundaryTarget(original, edge, valueMs);
    if (!target || (target.start === original.start && target.end === original.end)) {
      return { changed: false, provenance, gaps: gapRangesFromProvenance(provenance) };
    }
    const clearedRanges = gapBoundaryCoveredRanges(visible, gapIndex, original, target, edge);
    const cleanedProvenance = clearStaticGapRemoveProvenanceRanges(
      provenance,
      clearedRanges,
      fallbackGaps,
    );
    const recordResult = upsertBoundaryResizeRecord(cleanedProvenance, {
      original,
      edge,
      boundary: target[edge],
      clearedRanges,
    });
    return {
      changed: true,
      provenance: recordResult.provenance,
      gaps: gapRangesFromProvenance(recordResult.provenance),
      original,
      target,
    };
  }

  function waveformPeakDb(peaks, index) {
    const low = Number(peaks[index * 2]);
    const high = Number(peaks[index * 2 + 1]);
    const magnitude = Math.min(127, Math.max(Math.abs(low), Math.abs(high)));
    return magnitude > 0 ? 20 * Math.log10(magnitude / 127) : -Infinity;
  }

  function detectAudioGapRemoveGaps(waveform, options = {}) {
    const peaks = waveform?.peaks;
    const peaksPerSecond = Number(waveform?.peaks_per_second);
    const durationMs = Math.max(0, Math.round(Number(waveform?.duration_ms) || 0));
    if (!peaks || !Number.isFinite(peaksPerSecond) || peaksPerSecond <= 0 || !durationMs) return [];

    const minimumMs = Math.max(0, Math.round(Number(options.minimumMs) || 0));
    const thresholdDb = Math.min(0, Math.max(-96, Number(options.thresholdDb)));
    const openThresholdDb = Number.isFinite(thresholdDb) ? thresholdDb : -24;
    const hysteresisDb = Math.min(30, Math.max(0, Number(options.hysteresisDb) || 0));
    const closeThresholdDb = openThresholdDb - hysteresisDb;
    // 前/后端预留：在每段空隙两侧各保留若干毫秒静音不纳入移除，避免剪掉空隙后两句贴得太急。
    const leadInMs = Math.max(0, Math.round(Number(options.leadInMs) || 0));
    const leadOutMs = Math.max(0, Math.round(Number(options.leadOutMs) || 0));
    const sampleCount = Math.min(
      Math.floor(peaks.length / 2),
      Math.max(0, Math.ceil((durationMs / 1000) * peaksPerSecond)),
    );
    const timeAt = (index) => Math.min(durationMs, Math.round((index * 1000) / peaksPerSecond));
    const rawGaps = [];
    let gateOpen = false;
    let foundAudio = false;
    let silenceStart = null;

    for (let index = 0; index < sampleCount; index++) {
      const levelDb = waveformPeakDb(peaks, index);
      if (gateOpen) {
        if (levelDb < closeThresholdDb) {
          gateOpen = false;
          silenceStart = timeAt(index);
        }
        continue;
      }
      if (levelDb < openThresholdDb) continue;
      if (foundAudio && silenceStart != null) {
        const end = timeAt(index);
        if (end > silenceStart) {
          // 应用前/后端预留后再决定是否纳入移除区间
          const gapStart = Math.min(durationMs, silenceStart + leadInMs);
          const gapEnd = end - leadOutMs;
          if (gapEnd > gapStart) rawGaps.push({ start: gapStart, end: gapEnd, removed: true });
        }
      }
      foundAudio = true;
      gateOpen = true;
      silenceStart = null;
    }
    return rawGaps.filter((gap) => gap.end - gap.start >= minimumMs);
  }

  function getRemovedGapRanges(gaps) {
    const merged = [];
    normalizeGapRemoveGaps(gaps).filter((gap) => gap.removed).forEach((gap) => {
      const previous = merged[merged.length - 1];
      if (previous && gap.start <= previous.end) {
        previous.end = Math.max(previous.end, gap.end);
      } else {
        merged.push({ start: gap.start, end: gap.end });
      }
    });
    return merged;
  }

  function findGapRemoveDisableMatches(segments, gaps, options = {}) {
    const coverageThreshold = clampGapRemoveDisableCoverage(options.coveragePercent);
    const remainingThreshold = clampGapRemoveDisableRemaining(options.remainingMs);
    const removedRanges = getRemovedGapRanges(gaps);
    const source = Array.isArray(segments) ? segments : [];
    const matches = [];
    source.forEach((segment, index) => {
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      const durationMs = end - start;
      if (!Number.isFinite(start) || !Number.isFinite(end) || durationMs <= 0) return;
      const coveredMs = removedRanges.reduce((total, range) => {
        const overlap = Math.min(end, range.end) - Math.max(start, range.start);
        return total + Math.max(0, overlap);
      }, 0);
      const remainingMs = Math.max(0, durationMs - coveredMs);
      const coveragePercent = (coveredMs / durationMs) * 100;
      if (coveragePercent + Number.EPSILON < coverageThreshold || remainingMs > remainingThreshold) return;
      matches.push({ index, durationMs, coveredMs, remainingMs, coveragePercent });
    });
    return matches;
  }

  // Callers keep gap arrays canonical between renders, so this lookup stays a
  // cheap linear scan on the small number of manually visible ranges.
  function findGapRemoveAtTime(gaps, timeMs, removedOnly = false) {
    const time = Number(timeMs);
    if (!Number.isFinite(time) || !Array.isArray(gaps)) return null;
    return gaps.find((gap) => (
      (!removedOnly || gap?.removed !== false)
      && time >= Number(gap?.start)
      && time < Number(gap?.end)
    )) || null;
  }

  function isGapPreviewActive(gap, timeMs, previewRange) {
    if (!gap || !previewRange) return false;
    const time = Number(timeMs);
    return Number.isFinite(time)
      && time >= Number(previewRange.start)
      && time < Number(previewRange.end)
      && Number(gap.start) === Number(previewRange.start)
      && Number(gap.end) === Number(previewRange.end);
  }

  // Return the removed range that playback should skip, or null when playback
  // is paused, when the user explicitly previewed this range, or when skipping
  // is disabled. Keeping the paused check here prevents a seek from being
  // immediately undone before the user has a chance to audition the gap.
  function getGapPlaybackSkip(gaps, timeMs, {
    skipPlayback = false,
    isPlaying = false,
    previewRange = null,
  } = {}) {
    if (skipPlayback !== true || isPlaying !== true) return null;
    const gap = findGapRemoveAtTime(gaps, timeMs, true);
    return gap && !isGapPreviewActive(gap, timeMs, previewRange) ? gap : null;
  }

  function mapGapRemovedTime(sourceMs, gaps) {
    const source = Math.max(0, Math.round(Number(sourceMs) || 0));
    let removedBefore = 0;
    for (const gap of getRemovedGapRanges(gaps)) {
      if (source <= gap.start) break;
      if (source < gap.end) return Math.max(0, gap.start - removedBefore);
      removedBefore += gap.end - gap.start;
    }
    return Math.max(0, source - removedBefore);
  }

  function buildGapRemovedIntervals(durationMs, gaps) {
    const duration = Math.max(0, Math.round(Number(durationMs) || 0));
    const intervals = [];
    let cursor = 0;
    getRemovedGapRanges(gaps).forEach((gap) => {
      const start = Math.min(duration, Math.max(cursor, gap.start));
      const end = Math.min(duration, Math.max(start, gap.end));
      if (start > cursor) intervals.push({ start: cursor, end: start });
      cursor = Math.max(cursor, end);
    });
    if (cursor < duration) intervals.push({ start: cursor, end: duration });
    return intervals;
  }

  global.AsrGapRemoveCore = Object.freeze({
    GAP_REMOVE_SCHEMA,
    GAP_PROVENANCE_SCHEMA,
    GAP_PROVENANCE_SOURCES,
    GAP_REMOVE_OPERATION_MODES,
    DEFAULT_GAP_REMOVE_OPERATION_MODE,
    GAP_REMOVE_MANUAL_OPERATION_BOUNDARY_RESIZE,
    GAP_REMOVE_MANUAL_OPERATION_MOVE,
    GAP_REMOVE_DISABLE_COVERAGE_DEFAULT,
    GAP_REMOVE_DISABLE_REMAINING_DEFAULT_MS,
    GAP_REMOVE_DISABLE_REMAINING_MAX_MS,
    clampGapRemoveDisableCoverage,
    clampGapRemoveDisableRemaining,
    normalizeGapOperationMode,
    gapOperationAllowsBoundary,
    gapOperationAllowsMiddle,
    normalizeGapRemoveData,
    normalizeGapRemoveGaps,
    normalizeGapRemoveProvenance,
    gapRangesFromProvenance,
    decorateGapRemoveGaps,
    replaceGapRemoveProvenanceSource,
    appendGapRemoveManualOverrides,
    coalesceGapRemoveGaps,
    getGapRemoveDisplayType,
    isGapRemoveDisplayProtected,
    removeGapRemoveProvenanceRange,
    getGapRemoveDisplayGaps,
    applyGapRemoveRange,
    shrinkGapRemoveGaps,
    overlayGapRemoveRange,
    translateGapRemoveRange,
    moveGapRemoveRange,
    copyGapRemoveRange,
    moveGapRemoveProvenance,
    resizeGapRemoveBoundary,
    resizeGapRemoveProvenanceBoundary,
    detectAudioGapRemoveGaps,
    getRemovedGapRanges,
    findGapRemoveDisableMatches,
    findGapRemoveAtTime,
    isGapPreviewActive,
    getGapPlaybackSkip,
    mapGapRemovedTime,
    buildGapRemovedIntervals,
  });
})(typeof window !== 'undefined' ? window : globalThis);

// gap-remove: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-gap-remove', function createUtilsModule(dependencies) {
  'use strict';


  const GAP_REMOVE_CORE = window.AsrGapRemoveCore;

  if (!GAP_REMOVE_CORE) throw new Error('AsrGapRemoveCore must load before AsrEditorUtils');

  const GAP_REMOVE_SCHEMA = GAP_REMOVE_CORE.GAP_REMOVE_SCHEMA;

  const GAP_REMOVE_DISABLE_COVERAGE_DEFAULT = GAP_REMOVE_CORE.GAP_REMOVE_DISABLE_COVERAGE_DEFAULT;

  const GAP_REMOVE_DISABLE_REMAINING_DEFAULT_MS = GAP_REMOVE_CORE.GAP_REMOVE_DISABLE_REMAINING_DEFAULT_MS;

  const GAP_REMOVE_DISABLE_REMAINING_MAX_MS = GAP_REMOVE_CORE.GAP_REMOVE_DISABLE_REMAINING_MAX_MS;

  const clampGapRemoveDisableCoverage = GAP_REMOVE_CORE.clampGapRemoveDisableCoverage;

  const clampGapRemoveDisableRemaining = GAP_REMOVE_CORE.clampGapRemoveDisableRemaining;

  const normalizeGapRemoveData = GAP_REMOVE_CORE.normalizeGapRemoveData;

  const normalizeGapRemoveGaps = GAP_REMOVE_CORE.normalizeGapRemoveGaps;

  const normalizeGapRemoveProvenance = GAP_REMOVE_CORE.normalizeGapRemoveProvenance;

  const gapRangesFromProvenance = GAP_REMOVE_CORE.gapRangesFromProvenance;

  const decorateGapRemoveGaps = GAP_REMOVE_CORE.decorateGapRemoveGaps;

  const getGapRemoveDisplayType = GAP_REMOVE_CORE.getGapRemoveDisplayType;

  const isGapRemoveDisplayProtected = GAP_REMOVE_CORE.isGapRemoveDisplayProtected;

  const removeGapRemoveProvenanceRange = GAP_REMOVE_CORE.removeGapRemoveProvenanceRange;

  const getGapRemoveDisplayGaps = GAP_REMOVE_CORE.getGapRemoveDisplayGaps;

  const replaceGapRemoveProvenanceSource = GAP_REMOVE_CORE.replaceGapRemoveProvenanceSource;

  const appendGapRemoveManualOverrides = GAP_REMOVE_CORE.appendGapRemoveManualOverrides;

  const applyGapRemoveRange = GAP_REMOVE_CORE.applyGapRemoveRange;

  const shrinkGapRemoveGaps = GAP_REMOVE_CORE.shrinkGapRemoveGaps;

  const moveGapRemoveRange = GAP_REMOVE_CORE.moveGapRemoveRange;

  const copyGapRemoveRange = GAP_REMOVE_CORE.copyGapRemoveRange;

  const moveGapRemoveProvenance = GAP_REMOVE_CORE.moveGapRemoveProvenance;

  const resizeGapRemoveBoundary = GAP_REMOVE_CORE.resizeGapRemoveBoundary;

  const detectAudioGapRemoveGaps = GAP_REMOVE_CORE.detectAudioGapRemoveGaps;

  const getRemovedGapRanges = GAP_REMOVE_CORE.getRemovedGapRanges;

  const findGapRemoveDisableMatches = GAP_REMOVE_CORE.findGapRemoveDisableMatches;

  const mapGapRemovedTime = GAP_REMOVE_CORE.mapGapRemovedTime;

  const buildGapRemovedIntervals = GAP_REMOVE_CORE.buildGapRemovedIntervals;


  // Dynamic-caption exporters need the same compressed timeline as SRT/OTIO,
  // while preserving the source segment objects for the editor. Items that are
  // wholly inside a removed gap remain as zero-width mapped ranges so their
  // text-to-item correspondence is not lost; the builders already ignore
  // zero-duration highlight ranges when appropriate.
  function buildGapRemovedDynamicSegments(segments, gaps) {
    const source = Array.isArray(segments) ? segments : [];
    return source.flatMap((segment) => {
      if (!segment || typeof segment !== 'object') return [];
      const start = Number(segment.start);
      const end = Number(segment.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
      const mappedStart = mapGapRemovedTime(start, gaps);
      const mappedEnd = mapGapRemovedTime(end, gaps);
      if (mappedEnd <= mappedStart) return [];
      const mapped = { ...segment, start: mappedStart, end: mappedEnd };
      if (Array.isArray(segment.items)) {
        mapped.items = segment.items.map((item) => {
          if (!item || typeof item !== 'object') return item;
          const itemStart = Number(item.start);
          const itemEnd = Number(item.end);
          if (!Number.isFinite(itemStart) || !Number.isFinite(itemEnd)) return { ...item };
          return {
            ...item,
            start: mapGapRemovedTime(itemStart, gaps),
            end: mapGapRemovedTime(itemEnd, gaps),
          };
        });
      }
      return [mapped];
    });
  }


  // 「填充区间空隙」：以一个时间点为锚点，取左右两侧最近的「已激活」空隙作为
  // 边界，返回需要完全填充为单一空隙的区间。未激活空隙不作为边界，落在区间
  // 内时会被直接吞掉；锚点落在已激活空隙内时返回该空隙本身；锚点位于所有
  // 已激活空隙之前/之后时，边界向时间轴开头/结尾（durationMs）拓展。
  function resolveGapFillRange(gaps, pointMs, durationMs = 0) {
    const normalized = normalizeGapRemoveGaps(gaps).filter((gap) => gap.removed !== false);
    if (!normalized.length) return null;
    const point = Number(pointMs);
    if (!Number.isFinite(point)) return null;
    const containing = normalized.find((gap) => gap.start <= point && gap.end >= point);
    if (containing) return { start: containing.start, end: containing.end };
    const previous = [...normalized].reverse().find((gap) => gap.end <= point) || null;
    const next = normalized.find((gap) => gap.start >= point) || null;
    const duration = Math.max(0, Math.round(Number(durationMs) || 0));
    if (!next && duration <= 0) return null;
    const start = previous ? previous.start : 0;
    const end = next ? next.end : duration;
    if (end <= start) return null;
    return { start, end };
  }

  return Object.freeze({ GAP_REMOVE_DISABLE_COVERAGE_DEFAULT, GAP_REMOVE_DISABLE_REMAINING_DEFAULT_MS, GAP_REMOVE_DISABLE_REMAINING_MAX_MS, appendGapRemoveManualOverrides, applyGapRemoveRange, buildGapRemovedDynamicSegments, buildGapRemovedIntervals, clampGapRemoveDisableCoverage, clampGapRemoveDisableRemaining, copyGapRemoveRange, decorateGapRemoveGaps, detectAudioGapRemoveGaps, findGapRemoveDisableMatches, gapRangesFromProvenance, getGapRemoveDisplayGaps, getGapRemoveDisplayType, getRemovedGapRanges, isGapRemoveDisplayProtected, mapGapRemovedTime, moveGapRemoveProvenance, moveGapRemoveRange, normalizeGapRemoveData, normalizeGapRemoveGaps, normalizeGapRemoveProvenance, removeGapRemoveProvenanceRange, replaceGapRemoveProvenanceSource, resizeGapRemoveBoundary, resolveGapFillRange, shrinkGapRemoveGaps });
});

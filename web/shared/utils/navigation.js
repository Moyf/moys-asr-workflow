// navigation: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-navigation', function createUtilsModule(dependencies) {
  'use strict';


  const KEYBOARD_OPERATION_REFERENCE_MODES = new Set(['pointer', 'playhead']);


  function normalizeKeyboardOperationReferenceMode(value) {
    return KEYBOARD_OPERATION_REFERENCE_MODES.has(value) ? value : 'pointer';
  }


  function resolveKeyboardOperationReference(mode, { pointer = null, playheadTarget = null } = {}) {
    const resolvedMode = normalizeKeyboardOperationReferenceMode(mode);
    if (resolvedMode === 'pointer') {
      if (!pointer || !Number.isFinite(Number(pointer.timeMs))) return null;
      const track = pointer.track === 'extension' ? 'extension' : 'main';
      return {
        timeMs: Math.round(Number(pointer.timeMs)),
        track,
        trackId: track === 'extension' && typeof pointer.trackId === 'string'
          ? pointer.trackId : null,
        source: 'pointer',
      };
    }
    const timeMs = Number(playheadTarget?.timeMs);
    if (!Number.isFinite(timeMs)) return null;
    const track = playheadTarget?.kind === 'extension' ? 'extension' : 'main';
    return {
      timeMs: Math.round(timeMs),
      track,
      trackId: track === 'extension' && typeof playheadTarget.trackId === 'string'
        ? playheadTarget.trackId : null,
      source: 'playhead',
    };
  }


  function findAdjacentCueIndex(segments, currentIndex, direction, skipDisabled = false) {
    for (let index = currentIndex + direction; index >= 0 && index < segments.length; index += direction) {
      if (!skipDisabled || !segments[index]?.disabled) return index;
    }
    return -1;
  }


  function findCueNavigationTarget(segments, currentIndex, timeMs, direction, skipDisabled = false) {
    if (!Array.isArray(segments) || !segments.length || (direction !== -1 && direction !== 1)) return -1;
    if (Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < segments.length) {
      return findAdjacentCueIndex(segments, currentIndex, direction, skipDisabled);
    }

    const time = Number(timeMs);
    if (!Number.isFinite(time)) return -1;
    const activeIndex = segments.findIndex((segment, index) => (
      segment && Number(segment.start) <= time && (
        Number(segment.end) > time
        || index === segments.length - 1
        || Number(segments[index + 1]?.start) > time
      )
    ));
    if (activeIndex >= 0) {
      return findAdjacentCueIndex(segments, activeIndex, direction, skipDisabled);
    }

    if (direction < 0) {
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        if (Number(segments[index]?.start) >= time) continue;
        if (!skipDisabled || !segments[index]?.disabled) return index;
      }
      return -1;
    }
    for (let index = 0; index < segments.length; index += 1) {
      if (Number(segments[index]?.start) <= time) continue;
      if (!skipDisabled || !segments[index]?.disabled) return index;
    }
    return -1;
  }


  function findCueSelectionExtensionTarget(
    segments,
    selectedIndexes,
    currentIndex,
    timeMs,
    direction,
    skipDisabled = false,
  ) {
    if (!Array.isArray(segments) || !segments.length || (direction !== -1 && direction !== 1)) return -1;
    const selected = Array.from(selectedIndexes || [])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < segments.length);
    if (!selected.length) {
      return findCueNavigationTarget(
        segments,
        currentIndex,
        timeMs,
        direction,
        skipDisabled,
      );
    }
    const edge = direction < 0 ? Math.min(...selected) : Math.max(...selected);
    return findAdjacentCueIndex(segments, edge, direction, skipDisabled);
  }

  function normalizeKeyboardOperationReferenceMode(value) {
    return value === 'playhead' ? 'playhead' : 'pointer';
  }

  return Object.freeze({ findAdjacentCueIndex, findCueNavigationTarget, findCueSelectionExtensionTarget, normalizeKeyboardOperationReferenceMode, resolveKeyboardOperationReference });
});

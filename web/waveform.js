// Framework-neutral waveform runtime. Browser/Tauri-specific file access is
// isolated behind setPayload/processFile and callbacks supplied by editor.js.
(function () {
  'use strict';

  const SETTINGS_KEY = 'moy.asr.waveform.settings.v1';
  const SCHEMA = 'moy.asr.waveform.v1';
  const ENCODING = 'i8-minmax-base64';
  const LAYOUT_SCHEMA = 'moy.asr.editor.layout.v1';
  const LAYOUT_PRESETS = ['classic', 'wave-right', 'wave-bottom', 'free'];
  const MODULE_IDS = ['player', 'panel', 'cues', 'wave'];
  const MODULE_LABELS = { player: '视频', panel: '当前字幕', cues: '字幕列表', wave: '波形' };
  const DEFAULT_FREE_ORDER = ['player', 'panel', 'cues', 'wave'];
  const LAYOUT_DIRECTIONS = ['left', 'right', 'top', 'bottom'];
  const MODULE_EDGE_DROP_RATIO = 0.24;
  const ROOT_EDGE_DROP_RATIO = 0.055;
  const ROOT_EDGE_DROP_MIN_PX = 24;
  const ROOT_EDGE_DROP_MAX_PX = 48;
  const ZOOM_PRESETS = [5, 10, 20, 30, 60];
  const ROW_PRESETS = [5, 10, 20, 30];
  const ROW_HEIGHT = 96;
  const ROW_GAP = 10;
  const MIN_CUE_MS = 100;
  const MIN_WAVEFORM_SCALE = 0.25;
  const MAX_WAVEFORM_SCALE = 6;
  const SNAP_MS = 80;
  const ROUND_MS = 10;
  const BROWSER_DECODE_LIMIT = 512 * 1024 * 1024;
  const BROWSER_PCM_ESTIMATE_LIMIT = 768 * 1024 * 1024;
  const DEFAULT_LAYOUT_ROWS = [42, 18, 40];
  const PREVIOUS_DEFAULT_LAYOUT_ROWS = [42, 27, 31];
  const DEFAULT_SETTINGS = {
    mode: 'multi',
    layout: 'wave-right',
    visibleSeconds: 20,
    secondsPerRow: 10,
    side: 'left',
    splitPercent: 60,
    layoutColumnPercent: 58,
    layoutRows: [...DEFAULT_LAYOUT_ROWS],
    freeOrder: [...DEFAULT_FREE_ORDER],
    layoutTree: null,
    layoutEditing: false,
    waveformScale: 1,
    disabledDisplay: 'dim',
  };
  const PALETTE = {
    red: '#e74c3c',
    yellow: '#f1c40f',
    blue: '#168cff',
    green: '#2ecc71',
    purple: '#9b59b6',
  };

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  function roundMs(value) {
    return Math.round(value / ROUND_MS) * ROUND_MS;
  }

  function formatCompact(ms) {
    const safe = Math.max(0, Math.round(ms));
    const hours = Math.floor(safe / 3600000);
    const minutes = Math.floor((safe % 3600000) / 60000);
    const seconds = Math.floor((safe % 60000) / 1000);
    const millis = safe % 1000;
    const hh = hours ? `${String(hours).padStart(2, '0')}:` : '';
    return `${hh}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  function normalizeFreeOrder(value) {
    return Array.isArray(value) && value.length === MODULE_IDS.length
      && value.every((id) => MODULE_IDS.includes(id))
      && new Set(value).size === MODULE_IDS.length
      ? [...value] : [...DEFAULT_FREE_ORDER];
  }

  function moduleLayoutNode(id) {
    return { type: 'module', id };
  }

  function splitLayoutNode(direction, ratio, first, second) {
    return {
      type: 'split',
      direction: direction === 'column' ? 'column' : 'row',
      ratio: clamp(Number(ratio) || 50, 20, 80),
      children: [first, second],
    };
  }

  function legacyOrderToLayoutTree(order, columnPercent = 58, rows = DEFAULT_LAYOUT_ROWS) {
    const ids = normalizeFreeOrder(order);
    const [top, middle, bottom] = normalizeLayoutRows(rows);
    const left = splitLayoutNode(
      'column',
      top,
      moduleLayoutNode(ids[0]),
      splitLayoutNode('column', middle / Math.max(1, middle + bottom), moduleLayoutNode(ids[1]), moduleLayoutNode(ids[2])),
    );
    return splitLayoutNode('row', columnPercent, left, moduleLayoutNode(ids[3]));
  }

  function cloneLayoutTree(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'module') return moduleLayoutNode(node.id);
    return splitLayoutNode(
      node.direction,
      node.ratio,
      cloneLayoutTree(node.children?.[0]),
      cloneLayoutTree(node.children?.[1]),
    );
  }

  function collectLayoutModules(node, result = []) {
    if (!node) return result;
    if (node.type === 'module') {
      result.push(node.id);
      return result;
    }
    collectLayoutModules(node.children?.[0], result);
    collectLayoutModules(node.children?.[1], result);
    return result;
  }

  function normalizeLayoutTree(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.type === 'module' && MODULE_IDS.includes(value.id)) return moduleLayoutNode(value.id);
    if (value.type !== 'split' || !Array.isArray(value.children) || value.children.length !== 2) return null;
    const first = normalizeLayoutTree(value.children[0]);
    const second = normalizeLayoutTree(value.children[1]);
    if (!first || !second) return null;
    return splitLayoutNode(value.direction, value.ratio, first, second);
  }

  function isCompleteLayoutTree(tree) {
    const modules = collectLayoutModules(tree);
    return modules.length === MODULE_IDS.length
      && modules.every((id) => MODULE_IDS.includes(id))
      && new Set(modules).size === MODULE_IDS.length;
  }

  function replaceLayoutModule(tree, moduleId, replacement) {
    if (!tree) return null;
    if (tree.type === 'module') return tree.id === moduleId ? replacement : tree;
    return splitLayoutNode(
      tree.direction,
      tree.ratio,
      replaceLayoutModule(tree.children[0], moduleId, replacement),
      replaceLayoutModule(tree.children[1], moduleId, replacement),
    );
  }

  function removeLayoutModule(tree, moduleId) {
    if (!tree) return null;
    if (tree.type === 'module') return tree.id === moduleId ? null : tree;
    const first = removeLayoutModule(tree.children[0], moduleId);
    const second = removeLayoutModule(tree.children[1], moduleId);
    if (!first) return second;
    if (!second) return first;
    return splitLayoutNode(tree.direction, tree.ratio, first, second);
  }

  function swapLayoutTreeModules(tree, sourceId, targetId) {
    if (!isCompleteLayoutTree(tree) || sourceId === targetId) return cloneLayoutTree(tree);
    const marked = replaceLayoutModule(tree, sourceId, moduleLayoutNode('__swap__'));
    const targetSwapped = replaceLayoutModule(marked, targetId, moduleLayoutNode(sourceId));
    return replaceLayoutModule(targetSwapped, '__swap__', moduleLayoutNode(targetId));
  }

  function insertLayoutModuleAtEdge(tree, sourceId, targetId, direction) {
    if (!isCompleteLayoutTree(tree) || sourceId === targetId || !LAYOUT_DIRECTIONS.includes(direction)) {
      return cloneLayoutTree(tree);
    }
    const withoutSource = removeLayoutModule(cloneLayoutTree(tree), sourceId);
    if (!withoutSource) return cloneLayoutTree(tree);
    const source = moduleLayoutNode(sourceId);
    const target = moduleLayoutNode(targetId);
    const splitDirection = direction === 'left' || direction === 'right' ? 'row' : 'column';
    const replacement = direction === 'left' || direction === 'top'
      ? splitLayoutNode(splitDirection, 50, source, target)
      : splitLayoutNode(splitDirection, 50, target, source);
    return replaceLayoutModule(withoutSource, targetId, replacement);
  }

  function insertLayoutModuleAtRootEdge(tree, sourceId, direction) {
    if (!isCompleteLayoutTree(tree) || !LAYOUT_DIRECTIONS.includes(direction)) {
      return cloneLayoutTree(tree);
    }
    const withoutSource = removeLayoutModule(cloneLayoutTree(tree), sourceId);
    if (!withoutSource) return cloneLayoutTree(tree);
    const source = moduleLayoutNode(sourceId);
    const splitDirection = direction === 'left' || direction === 'right' ? 'row' : 'column';
    return direction === 'left' || direction === 'top'
      ? splitLayoutNode(splitDirection, 50, source, withoutSource)
      : splitLayoutNode(splitDirection, 50, withoutSource, source);
  }

  function layoutDropIntent(rect, clientX, clientY) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return { mode: 'swap' };
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((clientY - rect.top) / rect.height, 0, 1);
    const distances = { left: x, right: 1 - x, top: y, bottom: 1 - y };
    const nearest = Object.entries(distances).sort((a, b) => a[1] - b[1])[0];
    return nearest[1] <= MODULE_EDGE_DROP_RATIO
      ? { mode: 'insert', direction: nearest[0] }
      : { mode: 'swap' };
  }

  function layoutRootEdgeSize(rect, direction) {
    const length = direction === 'left' || direction === 'right' ? rect.width : rect.height;
    return clamp(length * ROOT_EDGE_DROP_RATIO, ROOT_EDGE_DROP_MIN_PX, ROOT_EDGE_DROP_MAX_PX);
  }

  function layoutRootDropIntent(rect, clientX, clientY) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const x = clamp(clientX - rect.left, 0, rect.width);
    const y = clamp(clientY - rect.top, 0, rect.height);
    const candidates = [
      ['left', x],
      ['right', rect.width - x],
      ['top', y],
      ['bottom', rect.height - y],
    ].map(([direction, distance]) => ({
      direction,
      distance,
      size: layoutRootEdgeSize(rect, direction),
    })).filter((candidate) => candidate.distance <= candidate.size);
    if (!candidates.length) return null;
    candidates.sort((a, b) => (a.distance / a.size) - (b.distance / b.size));
    return { mode: 'root-insert', direction: candidates[0].direction };
  }

  function layoutDropPreviewRect(rect, intent) {
    const edge = intent?.mode === 'insert' || intent?.mode === 'root-insert'
      ? intent.direction : null;
    const edgeSize = intent?.mode === 'root-insert'
      ? layoutRootEdgeSize(rect, edge)
      : edge === 'left' || edge === 'right'
        ? rect.width * MODULE_EDGE_DROP_RATIO
        : edge === 'top' || edge === 'bottom'
          ? rect.height * MODULE_EDGE_DROP_RATIO
          : 0;
    const width = edge === 'left' || edge === 'right' ? edgeSize : rect.width;
    const height = edge === 'top' || edge === 'bottom' ? edgeSize : rect.height;
    return {
      left: edge === 'right' ? rect.left + rect.width - width : rect.left,
      top: edge === 'bottom' ? rect.top + rect.height - height : rect.top,
      width,
      height,
    };
  }

  function directionLabel(direction) {
    return { left: '左侧', right: '右侧', top: '上方', bottom: '下方' }[direction] || '';
  }

  function normalizeLayoutRows(value) {
    const rows = Array.isArray(value) && value.length === 3
      ? value.map(Number) : [...DEFAULT_LAYOUT_ROWS];
    const top = clamp(Number.isFinite(rows[0]) ? rows[0] : 42, 12, 76);
    const maxMiddle = Math.max(6, 88 - top);
    const middle = clamp(Number.isFinite(rows[1]) ? rows[1] : DEFAULT_LAYOUT_ROWS[1], 6, maxMiddle);
    const bottom = Math.max(12, 100 - top - middle);
    return [top, middle, bottom];
  }

  function isPreviousDefaultLayoutRows(rows) {
    return rows.length === PREVIOUS_DEFAULT_LAYOUT_ROWS.length
      && rows.every((value, index) => value === PREVIOUS_DEFAULT_LAYOUT_ROWS[index]);
  }

  function normalizeLayoutData(value) {
    const source = value && typeof value === 'object' ? value : {};
    const preset = LAYOUT_PRESETS.includes(source.preset) ? source.preset : DEFAULT_SETTINGS.layout;
    const normalizedRows = normalizeLayoutRows(source.rows);
    // 仅迁移精确命中的旧默认值；用户手动调整过的比例保持原样。
    const rows = preset === 'wave-right' && isPreviousDefaultLayoutRows(normalizedRows)
      ? [...DEFAULT_LAYOUT_ROWS] : normalizedRows;
    const columnPercent = clamp(Number(source.columnPercent) || DEFAULT_SETTINGS.layoutColumnPercent, 30, 75);
    const splitPercent = clamp(Number(source.splitPercent) || DEFAULT_SETTINGS.splitPercent, 35, 75);
    const legacyOrder = normalizeFreeOrder(source.freeOrder || source.dockOrder);
    const candidateTree = normalizeLayoutTree(source.tree || source.layoutTree);
    const tree = isCompleteLayoutTree(candidateTree)
      ? candidateTree
      : legacyOrderToLayoutTree(legacyOrder, columnPercent, rows);
    return {
      schema: LAYOUT_SCHEMA,
      preset,
      splitPercent,
      columnPercent,
      rows,
      freeOrder: collectLayoutModules(tree),
      tree,
    };
  }

  function swapFreeLayoutOrder(order, sourceId, targetId) {
    const next = normalizeFreeOrder(order);
    const sourceIndex = next.indexOf(sourceId);
    const targetIndex = next.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return next;
    [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
    return next;
  }

  function readSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      const legacyLayout = parsed.layout || (
        parsed.mode === 'grid-right' ? 'wave-right' :
          parsed.mode === 'grid-bottom' ? 'wave-bottom' :
            parsed.mode === 'dock' ? 'free' : DEFAULT_SETTINGS.layout
      );
      const legacyMode = ['hidden', 'basic', 'multi'].includes(parsed.mode)
        ? parsed.mode
        : ['grid-right', 'grid-bottom', 'dock'].includes(parsed.mode)
          ? 'multi'
          : DEFAULT_SETTINGS.mode;
      const layoutData = normalizeLayoutData({
        preset: legacyLayout,
        splitPercent: parsed.splitPercent,
        columnPercent: parsed.layoutColumnPercent,
        rows: parsed.layoutRows || [parsed.layoutRowPercent, PREVIOUS_DEFAULT_LAYOUT_ROWS[1], PREVIOUS_DEFAULT_LAYOUT_ROWS[2]],
        freeOrder: parsed.freeOrder || parsed.dockOrder,
        tree: parsed.layoutTree || parsed.tree,
      });
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        mode: legacyMode,
        layout: layoutData.preset,
        visibleSeconds: ZOOM_PRESETS.includes(Number(parsed.visibleSeconds))
          ? Number(parsed.visibleSeconds) : DEFAULT_SETTINGS.visibleSeconds,
        secondsPerRow: ROW_PRESETS.includes(Number(parsed.secondsPerRow))
          ? Number(parsed.secondsPerRow) : DEFAULT_SETTINGS.secondsPerRow,
        side: parsed.side === 'right' ? 'right' : 'left',
        splitPercent: layoutData.splitPercent,
        layoutColumnPercent: layoutData.columnPercent,
        layoutRows: layoutData.rows,
        freeOrder: layoutData.freeOrder,
        layoutTree: layoutData.tree,
        layoutEditing: false,
        waveformScale: clampWaveformScale(Number(parsed.waveformScale) || DEFAULT_SETTINGS.waveformScale),
        disabledDisplay: parsed.disabledDisplay === 'hidden' ? 'hidden' : 'dim',
      };
    } catch (_) {
      return {
        ...DEFAULT_SETTINGS,
        layoutTree: legacyOrderToLayoutTree(DEFAULT_FREE_ORDER, DEFAULT_SETTINGS.layoutColumnPercent, DEFAULT_SETTINGS.layoutRows),
      };
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {
      // file:// privacy modes may reject localStorage; the editor still works.
    }
  }

  function decodePayload(payload) {
    if (!payload || payload.schema !== SCHEMA || payload.encoding !== ENCODING) return null;
    if (!Number.isInteger(payload.peak_count) || payload.peak_count <= 0) return null;
    if (!Number.isFinite(payload.peaks_per_second) || payload.peaks_per_second <= 0) return null;
    if (typeof payload.data !== 'string') return null;
    try {
      const binary = atob(payload.data);
      if (binary.length !== payload.peak_count * 2) return null;
      const unsigned = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) unsigned[i] = binary.charCodeAt(i);
      return new Int8Array(unsigned.buffer);
    } catch (_) {
      return null;
    }
  }

  function bytesToBase64(bytes) {
    const chunkSize = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
    }
    return btoa(parts.join(''));
  }

  function sourceForFile(file) {
    return {
      name: file.name,
      size: file.size,
      modified_ms: file.lastModified,
    };
  }

  function sameSource(a, b) {
    return !!a && !!b && a.name === b.name && a.size === b.size && a.modified_ms === b.modified_ms;
  }

  function clampWaveformScale(value) {
    const numeric = Number(value);
    return clamp(Number.isFinite(numeric) ? numeric : 1, MIN_WAVEFORM_SCALE, MAX_WAVEFORM_SCALE);
  }

  function waveformScaleAfterStep(value, direction) {
    const current = clampWaveformScale(value);
    // 低于 1 时用 0.25 细步（0.25 / 0.5 / 0.75），否则 0.5
    const step = current < 1 ? 0.25 : 0.5;
    return Number(clampWaveformScale(current + Number(direction) * step).toFixed(2));
  }

  function waveformAmplitude(height, scale) {
    return Math.max(0, Number(height) * 0.36 * clampWaveformScale(scale));
  }

  function sampleInterpolatedPeak(peaks, position, peakCount, target = [0, 0]) {
    if (!peaks || peakCount <= 0) {
      target[0] = 0;
      target[1] = 0;
      return target;
    }
    const clampedPosition = clamp(Number(position) || 0, 0, peakCount - 1);
    const left = Math.floor(clampedPosition);
    const right = Math.min(peakCount - 1, left + 1);
    const mix = clampedPosition - left;
    target[0] = peaks[left * 2] + (peaks[right * 2] - peaks[left * 2]) * mix;
    target[1] = peaks[left * 2 + 1] + (peaks[right * 2 + 1] - peaks[left * 2 + 1]) * mix;
    return target;
  }

  function colorForSegment(segment) {
    if (segment.color?.name && PALETTE[segment.color.name]) return PALETTE[segment.color.name];
    if (segment.color_ref?.name && PALETTE[segment.color_ref.name]) return PALETTE[segment.color_ref.name];
    if (segment.color?.value) return segment.color.value;
    return '#66727d';
  }

  function applySharedBoundary(segments, leftIndex, boundary, minDuration = MIN_CUE_MS) {
    const left = segments[leftIndex];
    const right = segments[leftIndex + 1];
    if (!left || !right) return segments;
    const lower = left.start + minDuration;
    const upper = right.end - minDuration;
    const nextBoundary = clamp(roundMs(boundary), lower, upper);
    const oldLeftEnd = left.end;
    const oldRightStart = right.start;
    left.end = nextBoundary;
    right.start = nextBoundary;
    left.items = remapItems(left.items, left.start, oldLeftEnd, left.start, nextBoundary);
    right.items = remapItems(right.items, oldRightStart, right.end, nextBoundary, right.end);
    return segments;
  }

  // Alt-drag a shared resize handle moves ONLY the hit side, leaving the
  // neighboring segment's opposite edge untouched. This is the independent
  // counterpart to applySharedBoundary, which moves both sides linked.
  // edge === 'end' moves segments[leftIndex].end; 'start' moves
  // segments[leftIndex + 1].start. The moved edge is clamped to keep at
  // least minDuration inside its own segment and not cross its other edge.
  function applyIndependentEdge(segments, leftIndex, edge, valueMs, minDuration = MIN_CUE_MS) {
    const left = segments[leftIndex];
    const right = segments[leftIndex + 1];
    if (!left || !right || (edge !== 'end' && edge !== 'start')) return segments;
    const value = roundMs(valueMs);
    if (edge === 'end') {
      const lower = left.start + minDuration;
      const upper = Number.isFinite(left.end) ? left.end : Infinity;
      // 不越过右侧段的起始，避免产生负时长或重叠；但不强制拉动邻居。
      const ceiling = Number.isFinite(right.start) ? right.start : upper;
      const next = clamp(value, lower, Math.min(upper, ceiling));
      const oldEnd = left.end;
      left.end = next;
      left.items = remapItems(left.items, left.start, oldEnd, left.start, next);
    } else {
      const upper = right.end - minDuration;
      const floor = Number.isFinite(right.start) ? right.start : 0;
      const base = Number.isFinite(left.end) ? left.end : floor;
      const next = clamp(value, Math.max(floor, base), upper);
      const oldStart = right.start;
      right.start = next;
      right.items = remapItems(right.items, oldStart, right.end, next, right.end);
    }
    return segments;
  }

  // Safe split point selection for the razor tool. Given a segment and a
  // pointer time, prefer the nearest item boundary (midpoint between adjacent
  // items' end/start); otherwise fall back to the integer millisecond nearest
  // the pointer. Refuse any split within minEdge of either segment edge so a
  // razor click never produces a sub-100ms sliver. Returns { left, right,
  // splitMs } with cloned items allocated by time, or null when refused.
  function splitSegmentAtTime(segment, timeMs, minEdge = MIN_CUE_MS) {
    if (!segment) return null;
    const start = Math.round(Number(segment.start));
    const end = Math.round(Number(segment.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < minEdge * 2) return null;
    const target = Number.isFinite(Number(timeMs)) ? Number(timeMs) : (start + end) / 2;

    const items = Array.isArray(segment.items) ? segment.items : [];
    // Collect candidate item-boundary times (midpoint between adjacent items).
    const boundaries = [];
    for (let i = 1; i < items.length; i++) {
      const prevEnd = Number(items[i - 1].end);
      const nextStart = Number(items[i].start);
      if (Number.isFinite(prevEnd) && Number.isFinite(nextStart)) {
        boundaries.push(Math.round((prevEnd + nextStart) / 2));
      }
    }
    let splitMs;
    if (boundaries.length) {
      splitMs = boundaries.reduce((best, value) => (
        Math.abs(value - target) <= Math.abs(best - target) ? value : best
      ), boundaries[0]);
    } else {
      splitMs = Math.round(target);
    }
    splitMs = clamp(splitMs, start + minEdge, end - minEdge);
    if (splitMs <= start + minEdge - 1 || splitMs >= end - minEdge + 1) return null;

    const leftItems = [];
    const rightItems = [];
    for (const item of items) {
      const itemStart = Number(item.start);
      const itemEnd = Number(item.end);
      // An item straddling the split snaps to the side whose start is closer.
      if (Number.isFinite(itemEnd) && itemEnd <= splitMs) {
        leftItems.push({ ...item });
      } else if (Number.isFinite(itemStart) && itemStart >= splitMs) {
        rightItems.push({ ...item });
      } else if (Number.isFinite(itemStart) && Number.isFinite(itemEnd)) {
        if (splitMs - itemStart <= itemEnd - splitMs) {
          leftItems.push({ ...item });
        } else {
          rightItems.push({ ...item });
        }
      } else {
        leftItems.push({ ...item });
      }
    }

    const clone = (base) => ({ ...base });
    const left = clone(segment);
    const right = clone(segment);
    left.start = start;
    left.end = splitMs;
    right.start = splitMs;
    right.end = end;
    left.items = leftItems.length ? leftItems : null;
    right.items = rightItems.length ? rightItems : null;
    left._dirty = true;
    right._dirty = true;
    return { left, right, splitMs };
  }

  function normalizeNewCueRange(start, end, duration, previousEnd = 0, nextStart = duration, minDuration = MIN_CUE_MS) {
    const lower = clamp(roundMs(previousEnd), 0, Math.max(0, duration));
    const upper = clamp(roundMs(nextStart), lower, Math.max(lower, duration));
    const nextStartMs = clamp(roundMs(start), lower, upper);
    const nextEndMs = clamp(roundMs(end), lower, upper);
    if (nextEndMs - nextStartMs < minDuration) return null;
    return { start: nextStartMs, end: nextEndMs };
  }

  function remapItems(items, oldStart, oldEnd, newStart, newEnd) {
    if (!Array.isArray(items) || !items.length) return items;
    const oldDuration = Math.max(1, oldEnd - oldStart);
    const newDuration = Math.max(1, newEnd - newStart);
    return items.map((item) => ({
      ...item,
      start: roundMs(newStart + ((item.start - oldStart) / oldDuration) * newDuration),
      end: roundMs(newStart + ((item.end - oldStart) / oldDuration) * newDuration),
    }));
  }

  class WaveformEditor {
    constructor(options) {
      this.options = options;
      this.settings = readSettings();
      this.payload = null;
      this.peaks = null;
      this.player = null;
      this.mediaAvailable = false;
      this.basicWindowStartMs = 0;
      this.manualFollowUntil = 0;
      this.multiRange = [-1, -1];
      this.activeIndex = -1;
      this.drag = null;
      this.gapRangeDrag = null;
      this.gapBoundaryDrag = null;
      this.suppressGapClickUntil = 0;
      this.autoScrolling = false;
      this.resizeFrame = 0;
      // Shift+滚轮调振幅的 rAF 节流：一帧内的滚动累加方向后只触发一次
      this.pendingScaleDirection = 0;
      this.scaleRafScheduled = false;
      // 波形交互工具：'select'（默认，保留 Ctrl/Shift/分组多选与拖动）或
      // 'razor'（左键点击字幕块即在指针位置安全拆分）。Alt 行为不随工具变化。
      this.tool = 'select';

      this.workspace = document.getElementById('editor-workspace');
      this.panel = document.getElementById('current-cue-panel');
      this.playerWrap = this.workspace.querySelector('.player-wrap');
      this.cues = document.getElementById('cues-container');
      this.pane = document.getElementById('waveform-pane');
      this.scroll = document.getElementById('waveform-scroll');
      this.content = document.getElementById('waveform-content');
      this.empty = document.getElementById('waveform-empty');
      this.status = document.getElementById('waveform-status');
      this.divider = document.getElementById('workspace-divider');
      this.secondaryDivider = document.getElementById('workspace-divider-secondary');
      this.windowLabel = document.getElementById('waveform-window-label');
      this.waveformScaleLabel = document.getElementById('waveform-scale-label');
      this.waveformScaleDownButton = document.getElementById('waveform-scale-down');
      this.waveformScaleUpButton = document.getElementById('waveform-scale-up');
      this.secondsPerRowSelect = document.getElementById('waveform-seconds-per-row');
      this.sideSelect = document.getElementById('waveform-side');
      this.disabledDisplaySelect = document.getElementById('waveform-disabled-display');
      this.layoutPresetSelect = document.getElementById('layout-preset');
      this.layoutEditToggle = document.getElementById('layout-edit-toggle');
      this.layoutResetButton = document.getElementById('layout-reset');
      this.layoutPreview = document.getElementById('layout-drop-preview');
      this.layoutResizers = {
        column: document.getElementById('layout-resizer-v'),
        rowTop: document.getElementById('layout-resizer-h1'),
        rowMiddle: document.getElementById('layout-resizer-h2'),
      };

      this._onPlayerTime = () => this.updatePlayback();
      this._onResize = () => this.scheduleRender();
      this.bindControls();
      this.bindDockHandles();
      this.applyLayout();

      if (window.ResizeObserver) {
        this.resizeObserver = new ResizeObserver(this._onResize);
        this.resizeObserver.observe(this.pane);
      } else {
        window.addEventListener('resize', this._onResize);
      }
    }

    bindControls() {
      document.querySelectorAll('[data-waveform-mode]').forEach((button) => {
        button.addEventListener('click', () => this.setMode(button.dataset.waveformMode));
      });
      document.querySelectorAll('[data-waveform-tool]').forEach((button) => {
        button.addEventListener('click', () => this.setTool(button.dataset.waveformTool));
      });
      // 初始工具按钮高亮（默认 select）
      document.querySelectorAll('[data-waveform-tool]').forEach((button) => {
        button.classList.toggle('active', button.dataset.waveformTool === this.tool);
      });
      this.pane?.classList.toggle('tool-select', this.tool === 'select');
      this.pane?.classList.toggle('tool-razor', this.tool === 'razor');
      document.getElementById('waveform-zoom-in').addEventListener('click', () => this.changeZoom(-1));
      document.getElementById('waveform-zoom-out').addEventListener('click', () => this.changeZoom(1));
      this.waveformScaleDownButton?.addEventListener('click', () => this.changeWaveformScale(-1));
      this.waveformScaleUpButton?.addEventListener('click', () => this.changeWaveformScale(1));
      this.pane.addEventListener('pointerdown', () => this.focusWaveform());
      this.secondsPerRowSelect.addEventListener('change', () => {
        this.settings.secondsPerRow = Number(this.secondsPerRowSelect.value);
        saveSettings(this.settings);
        this.multiRange = [-1, -1];
        this.render();
      });
      this.sideSelect?.addEventListener('change', () => {
        this.settings.side = this.sideSelect.value === 'right' ? 'right' : 'left';
        saveSettings(this.settings);
        this.applyLayout();
        this.scheduleRender();
      });
      this.disabledDisplaySelect?.addEventListener('change', () => {
        this.settings.disabledDisplay = this.disabledDisplaySelect.value === 'hidden' ? 'hidden' : 'dim';
        saveSettings(this.settings);
        this.renderSegments();
      });
      this.layoutPresetSelect?.addEventListener('change', () => this.setLayout(this.layoutPresetSelect.value));
      this.layoutEditToggle?.addEventListener('click', () => this.toggleLayoutEditMode());
      this.layoutResetButton?.addEventListener('click', () => this.resetLayout());
      this.scroll.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
      this.scroll.addEventListener('scroll', (event) => {
        if (!this.isMultiMode()) return;
        if (event.isTrusted && !this.autoScrolling) this.manualFollowUntil = Date.now() + 3000;
        this.renderMultiVisible();
      });
      this.bindDivider();
      this.bindLayoutResizers();
    }

    bindDivider() {
      const bind = (divider, axis) => {
        if (!divider) return;
        let dividerDrag = null;
        divider.addEventListener('pointerdown', (event) => {
          if (!this.isMultiMode() || this.settings.layout !== 'classic') return;
          event.preventDefault();
          dividerDrag = { pointerId: event.pointerId, snapshot: this.getLayoutHistorySnapshot(), changed: false };
          divider.classList.add('dragging');
          divider.setPointerCapture(event.pointerId);
        });
        divider.addEventListener('pointermove', (event) => {
          if (!dividerDrag || dividerDrag.pointerId !== event.pointerId) return;
          const rect = this.workspace.getBoundingClientRect();
          const percent = axis === 'x'
            ? ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100
            : ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100;
          const nextSplitPercent = clamp(
            this.settings.side === 'right' ? 100 - percent : percent,
            35,
            75,
          );
          if (nextSplitPercent === this.settings.splitPercent) return;
          if (!dividerDrag.changed) {
            this.recordLayoutUndo('调整波形与字幕区域尺寸', dividerDrag.snapshot);
            dividerDrag.changed = true;
          }
          this.settings.splitPercent = nextSplitPercent;
          this.workspace.style.setProperty('--waveform-split', `${this.settings.splitPercent}%`);
          this.scheduleRender();
        });
        const finish = (event) => {
          if (!dividerDrag || dividerDrag.pointerId !== event.pointerId) return;
          dividerDrag = null;
          divider.classList.remove('dragging');
          try { divider.releasePointerCapture(event.pointerId); } catch (_) {}
          saveSettings(this.settings);
        };
        divider.addEventListener('pointerup', finish);
        divider.addEventListener('pointercancel', finish);
      };
      bind(this.divider, 'x');
    }

    bindLayoutResizers() {
      Object.entries(this.layoutResizers).forEach(([kind, resizer]) => {
        if (!resizer) return;
        let drag = null;
        resizer.addEventListener('pointerdown', (event) => {
          if (!this.isPresetResizableLayout()) return;
          event.preventDefault();
          drag = { pointerId: event.pointerId, snapshot: this.getLayoutHistorySnapshot(), changed: false };
          resizer.classList.add('dragging');
          resizer.setPointerCapture?.(event.pointerId);
        });
        resizer.addEventListener('pointermove', (event) => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          const rect = this.workspace.getBoundingClientRect();
          const previousColumn = this.settings.layoutColumnPercent;
          const previousRows = [...this.settings.layoutRows];
          if (kind === 'column') {
            this.settings.layoutColumnPercent = clamp(
              ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100,
              30,
              75,
            );
          } else {
            const percent = ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100;
            const rows = [...this.settings.layoutRows];
            if (kind === 'rowTop') {
              rows[0] = clamp(percent, 12, 76);
              rows[1] = Math.min(rows[1], 88 - rows[0]);
            } else {
              rows[1] = clamp(percent - rows[0], 6, 82);
            }
            this.settings.layoutRows = normalizeLayoutRows(rows);
          }
          const hasChanged = previousColumn !== this.settings.layoutColumnPercent
            || previousRows.some((value, index) => value !== this.settings.layoutRows[index]);
          if (!hasChanged) return;
          if (!drag.changed) {
            this.recordLayoutUndo('调整布局区域尺寸', drag.snapshot);
            drag.changed = true;
          }
          this.applyLayoutVariables();
          this.scheduleRender();
        });
        const finish = (event) => {
          if (!drag || drag.pointerId !== event.pointerId) return;
          drag = null;
          resizer.classList.remove('dragging');
          try { resizer.releasePointerCapture?.(event.pointerId); } catch (_) {}
          saveSettings(this.settings);
        };
        resizer.addEventListener('pointerup', finish);
        resizer.addEventListener('pointercancel', finish);
      });
    }

    applyLayoutVariables() {
      const [top, middle, bottom] = normalizeLayoutRows(this.settings.layoutRows);
      this.settings.layoutRows = [top, middle, bottom];
      this.workspace.style.setProperty('--waveform-split', `${this.settings.splitPercent}%`);
      this.workspace.style.setProperty('--layout-column', `${this.settings.layoutColumnPercent}%`);
      this.workspace.style.setProperty('--layout-row-top', `${top}%`);
      this.workspace.style.setProperty('--layout-row-middle', `${middle}%`);
      this.workspace.style.setProperty('--layout-row-bottom', `${bottom}%`);
    }

    applyLayout() {
      this.workspace.classList.remove(
        'waveform-hidden', 'waveform-basic', 'waveform-multi',
        'layout-classic', 'layout-wave-right', 'layout-wave-bottom', 'layout-free',
        'waveform-right', 'layout-editing',
      );
      this.workspace.classList.add(`waveform-${this.settings.mode}`);
      this.workspace.classList.add(`layout-${this.settings.layout}`);
      if (this.settings.layout === 'classic' && this.settings.side === 'right') {
        this.workspace.classList.add('waveform-right');
      }
      if (this.settings.layoutEditing) this.workspace.classList.add('layout-editing');
      this.applyLayoutVariables();
      this.applyFreeLayoutTree();
      document.querySelectorAll('[data-waveform-mode]').forEach((button) => {
        button.classList.toggle('active', button.dataset.waveformMode === this.settings.mode);
      });
      this.windowLabel.textContent = `${this.settings.visibleSeconds} 秒`;
      if (this.waveformScaleLabel) this.waveformScaleLabel.textContent = `×${parseFloat(this.settings.waveformScale.toFixed(2))}`;
      this.secondsPerRowSelect.value = String(this.settings.secondsPerRow);
      if (this.sideSelect) this.sideSelect.value = this.settings.side;
      if (this.disabledDisplaySelect) this.disabledDisplaySelect.value = this.settings.disabledDisplay;
      if (this.layoutPresetSelect) this.layoutPresetSelect.value = this.settings.layout;
      if (this.layoutEditToggle) {
        this.layoutEditToggle.textContent = this.settings.layoutEditing ? '完成布局' : '编辑布局';
        this.layoutEditToggle.classList.toggle('active', !!this.settings.layoutEditing);
      }
      if (this.layoutResetButton) this.layoutResetButton.hidden = !this.settings.layoutEditing;
      this.updateAdvancedSettingsAvailability();
    }

    updateAdvancedSettingsAvailability() {
      const basicMode = this.settings.mode === 'basic';
      const multiMode = this.settings.mode === 'multi';
      const waveformVisible = this.settings.mode !== 'hidden';
      document.getElementById('waveform-zoom-in').disabled = !basicMode;
      document.getElementById('waveform-zoom-out').disabled = !basicMode;
      this.secondsPerRowSelect.disabled = !multiMode;
      if (this.waveformScaleDownButton) this.waveformScaleDownButton.disabled = !waveformVisible;
      if (this.waveformScaleUpButton) this.waveformScaleUpButton.disabled = !waveformVisible;
      // 「显示窗口」仅基础模式有意义；「每行长度」仅多行模式有意义；隐藏波形时两项都收起。
      const windowSetting = document.getElementById('waveform-window-setting');
      const secondsPerRowSetting = document.getElementById('waveform-seconds-per-row-setting');
      if (windowSetting) windowSetting.hidden = !basicMode;
      if (secondsPerRowSetting) secondsPerRowSetting.hidden = !multiMode;
    }

    setMode(mode) {
      if (!['hidden', 'basic', 'multi'].includes(mode) || mode === this.settings.mode) return;
      this.settings.mode = mode;
      saveSettings(this.settings);
      this.applyLayout();
      if (mode === 'basic') this.centerBasicOnCurrentTime();
      if (this.isMultiMode()) this.multiRange = [-1, -1];
      this.render();
    }

    // 工具切换：'select' 为默认选择工具，保留全部 Ctrl/Shift/分组多选与
    // 拖动行为；'razor' 让左键点击字幕块在指针位置安全拆分。切回 select
    // 不会清除已有选中，便于拆分后立即继续操作。
    setTool(tool) {
      if (tool !== 'select' && tool !== 'razor') return;
      if (this.tool === tool) return;
      this.tool = tool;
      this.pane?.classList.toggle('tool-razor', tool === 'razor');
      this.pane?.classList.toggle('tool-select', tool === 'select');
      document.querySelectorAll('[data-waveform-tool]').forEach((button) => {
        button.classList.toggle('active', button.dataset.waveformTool === tool);
      });
      this.setStatus(tool === 'razor' ? '剃刀工具：点击字幕块在指针位置拆分' : '选择工具');
    }

    getTool() {
      return this.tool;
    }

    setLayout(layout) {
      if (!LAYOUT_PRESETS.includes(layout)) return;
      this.settings.layout = layout;
      this.settings.layoutEditing = layout === 'free';
      saveSettings(this.settings);
      this.applyLayout();
      this.render();
    }

    toggleLayoutEditMode() {
      if (this.settings.layout !== 'free') {
        this.settings.layout = 'free';
        this.settings.layoutEditing = true;
      } else {
        this.settings.layoutEditing = !this.settings.layoutEditing;
      }
      saveSettings(this.settings);
      this.applyLayout();
      this.render();
    }

    isMultiMode() {
      return this.settings.mode === 'multi';
    }

    isDockLayout() {
      return this.settings.layout === 'free' && this.settings.layoutEditing;
    }

    isFreeLayout() {
      return this.settings.layout === 'free';
    }

    isPresetResizableLayout() {
      return this.settings.layout === 'wave-right' || this.settings.layout === 'wave-bottom';
    }

    bindDockHandles() {
      const modules = [
        ['player', this.playerWrap],
        ['panel', this.panel],
        ['cues', this.cues],
        ['wave', this.pane],
      ];
      modules.forEach(([id, element]) => {
        if (!element) return;
        element.dataset.dockModule = id;
        let handle = element.querySelector(':scope > .dock-handle');
        if (!handle) {
          handle = document.createElement('div');
          handle.className = 'dock-handle';
          handle.textContent = `⋮⋮ ${MODULE_LABELS[id]}`;
          element.prepend(handle);
        }
        handle.draggable = true;
        handle.addEventListener('dragstart', (event) => {
          if (!this.isDockLayout()) {
            event.preventDefault();
            this.setStatus('请先进入「编辑布局」模式', 'busy');
            return;
          }
          event.dataTransfer?.setData('text/plain', id);
          event.dataTransfer?.setDragImage(handle, 16, 10);
          this.layoutDragSource = id;
          this.workspace.classList.add('layout-dragging');
          element.classList.add('layout-drag-source');
        });
        handle.addEventListener('dragend', () => {
          this.layoutDragSource = null;
          element.classList.remove('layout-drag-source');
          this.clearLayoutDropPreview();
          this.workspace.classList.remove('layout-dragging');
        });
        element.addEventListener('dragover', (event) => {
          if (!this.isDockLayout() || !this.layoutDragSource) return;
          if (layoutRootDropIntent(this.workspace.getBoundingClientRect(), event.clientX, event.clientY)) return;
          if (this.layoutDragSource === id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const intent = layoutDropIntent(element.getBoundingClientRect(), event.clientX, event.clientY);
          this.layoutDropIntent = { ...intent, targetId: id, sourceId: this.layoutDragSource };
          this.showLayoutDropPreview(element, id, this.layoutDragSource, intent);
        });
        element.addEventListener('drop', (event) => {
          if (!this.isDockLayout()) return;
          const source = this.layoutDragSource || event.dataTransfer?.getData('text/plain');
          if (layoutRootDropIntent(this.workspace.getBoundingClientRect(), event.clientX, event.clientY)) return;
          event.preventDefault();
          if (!source || source === id) return;
          const intent = this.layoutDropIntent?.targetId === id
            ? this.layoutDropIntent
            : { ...layoutDropIntent(element.getBoundingClientRect(), event.clientX, event.clientY), targetId: id, sourceId: source };
          this.applyLayoutDrop(source, id, intent);
          this.clearLayoutDropPreview();
        });
      });
      this.bindWorkspaceDockTarget();
    }

    bindWorkspaceDockTarget() {
      this.workspace.addEventListener('dragover', (event) => {
        if (!this.isDockLayout() || !this.layoutDragSource || event.defaultPrevented) return;
        const intent = layoutRootDropIntent(this.workspace.getBoundingClientRect(), event.clientX, event.clientY);
        if (!intent) {
          this.clearLayoutDropPreview();
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        this.layoutDropIntent = { ...intent, sourceId: this.layoutDragSource };
        this.showLayoutDropPreview(this.workspace, null, this.layoutDragSource, intent);
      });
      this.workspace.addEventListener('drop', (event) => {
        if (!this.isDockLayout() || event.defaultPrevented) return;
        const source = this.layoutDragSource || event.dataTransfer?.getData('text/plain');
        if (!source) return;
        const storedIntent = this.layoutDropIntent?.mode === 'root-insert'
          && this.layoutDropIntent.sourceId === source
          ? this.layoutDropIntent : null;
        const intent = storedIntent
          || layoutRootDropIntent(this.workspace.getBoundingClientRect(), event.clientX, event.clientY);
        if (!intent) return;
        event.preventDefault();
        this.applyLayoutDrop(source, null, intent);
        this.clearLayoutDropPreview();
      });
    }

    applyLayoutDrop(sourceId, targetId, intent) {
      const tree = this.settings.layoutTree || legacyOrderToLayoutTree(this.settings.freeOrder);
      const nextTree = intent.mode === 'root-insert'
        ? insertLayoutModuleAtRootEdge(tree, sourceId, intent.direction)
        : intent.mode === 'insert'
          ? insertLayoutModuleAtEdge(tree, sourceId, targetId, intent.direction)
          : swapLayoutTreeModules(tree, sourceId, targetId);
      if (!isCompleteLayoutTree(nextTree)) return;
      this.recordLayoutUndo(
        intent.mode === 'root-insert'
          ? '停靠到窗口边缘'
          : intent.mode === 'insert' ? '插入布局模块' : '交换布局模块',
        this.getLayoutHistorySnapshot(),
      );
      this.settings.layoutTree = nextTree;
      this.settings.freeOrder = collectLayoutModules(nextTree);
      saveSettings(this.settings);
      this.applyLayout();
      if (intent.mode === 'root-insert') {
        this.setStatus(`已将「${MODULE_LABELS[sourceId]}」停靠到窗口${directionLabel(intent.direction)}`);
      } else if (intent.mode === 'insert') {
        this.setStatus(`已将「${MODULE_LABELS[sourceId]}」插入到「${MODULE_LABELS[targetId]}」${directionLabel(intent.direction)}`);
      } else {
        this.setStatus(`已交换「${MODULE_LABELS[sourceId]}」与「${MODULE_LABELS[targetId]}」`);
      }
    }

    showLayoutDropPreview(element, id, sourceId, intent) {
      if (!this.layoutPreview || !element) return;
      const workspaceRect = this.workspace.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const previewRect = layoutDropPreviewRect(rect, intent);
      this.layoutPreview.style.left = `${previewRect.left - workspaceRect.left}px`;
      this.layoutPreview.style.top = `${previewRect.top - workspaceRect.top}px`;
      this.layoutPreview.style.width = `${previewRect.width}px`;
      this.layoutPreview.style.height = `${previewRect.height}px`;
      this.layoutPreview.classList.toggle(
        'layout-insert-preview',
        intent.mode === 'insert' || intent.mode === 'root-insert',
      );
      this.layoutPreview.classList.toggle('layout-root-insert-preview', intent.mode === 'root-insert');
      this.layoutPreview.textContent = intent.mode === 'root-insert'
        ? `窗口${directionLabel(intent.direction)}：${MODULE_LABELS[sourceId]}`
        : intent.mode === 'insert'
          ? `新位置：${MODULE_LABELS[sourceId]} ${directionLabel(intent.direction)}`
          : `新位置：与${MODULE_LABELS[id]}对换`;
      this.layoutPreview.classList.add('show');
      this.workspace.querySelectorAll('.layout-drop-target').forEach((target) => {
        target.classList.remove('layout-drop-target');
      });
      if (intent.mode !== 'root-insert') element.classList.add('layout-drop-target');
    }

    clearLayoutDropPreview() {
      this.layoutPreview?.classList.remove('show');
      this.layoutPreview?.classList.remove('layout-insert-preview');
      this.layoutPreview?.classList.remove('layout-root-insert-preview');
      this.layoutDropIntent = null;
      this.workspace?.querySelectorAll('.layout-drop-target').forEach((target) => {
        target.classList.remove('layout-drop-target');
      });
    }

    ensureFreeLayoutRoot() {
      if (this.freeLayoutRoot?.isConnected) return this.freeLayoutRoot;
      this.freeLayoutRoot = document.createElement('div');
      this.freeLayoutRoot.className = 'free-layout-root';
      this.workspace.insertBefore(this.freeLayoutRoot, this.layoutPreview || null);
      return this.freeLayoutRoot;
    }

    restoreDirectLayoutModules() {
      const elements = {
        player: this.playerWrap,
        panel: this.panel,
        cues: this.cues,
        wave: this.pane,
      };
      if (!this.freeLayoutRoot?.isConnected) return;
      Object.values(elements).forEach((element) => {
        if (element) {
          element.style.gridArea = '';
          this.workspace.insertBefore(element, this.freeLayoutRoot);
        }
      });
      this.freeLayoutRoot.remove();
      this.freeLayoutRoot = null;
      this.renderedFreeLayoutTree = null;
    }

    createFreeLayoutNode(node) {
      const elements = {
        player: this.playerWrap,
        panel: this.panel,
        cues: this.cues,
        wave: this.pane,
      };
      if (node.type === 'module') {
        const slot = document.createElement('div');
        slot.className = 'layout-child layout-module-slot';
        slot.dataset.layoutModule = node.id;
        if (elements[node.id]) slot.appendChild(elements[node.id]);
        return slot;
      }
      const split = document.createElement('div');
      split.className = `layout-split layout-split-${node.direction}`;
      split.dataset.layoutDirection = node.direction;
      const first = document.createElement('div');
      first.className = 'layout-child';
      const second = document.createElement('div');
      second.className = 'layout-child';
      const divider = document.createElement('div');
      divider.className = `layout-split-divider layout-split-divider-${node.direction}`;
      divider.title = node.direction === 'row' ? '拖动调整左右区域比例' : '拖动调整上下区域比例';
      first.appendChild(this.createFreeLayoutNode(node.children[0]));
      second.appendChild(this.createFreeLayoutNode(node.children[1]));
      split.append(first, divider, second);
      this.applyFreeSplitRatio(first, node.ratio);
      this.bindFreeLayoutDivider(divider, split, first, node);
      return split;
    }

    applyFreeSplitRatio(first, ratio) {
      first.style.flex = `0 0 calc(${clamp(Number(ratio) || 50, 20, 80)}% - 3.5px)`;
    }

    bindFreeLayoutDivider(divider, split, first, node) {
      let drag = null;
      divider.addEventListener('pointerdown', (event) => {
        if (!this.isFreeLayout()) return;
        event.preventDefault();
        drag = { pointerId: event.pointerId, snapshot: this.getLayoutHistorySnapshot(), changed: false };
        divider.classList.add('dragging');
        divider.setPointerCapture?.(event.pointerId);
      });
      divider.addEventListener('pointermove', (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const rect = split.getBoundingClientRect();
        const position = node.direction === 'row'
          ? ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100
          : ((event.clientY - rect.top) / Math.max(1, rect.height)) * 100;
        const nextRatio = clamp(position, 20, 80);
        if (nextRatio === node.ratio) return;
        if (!drag.changed) {
          this.recordLayoutUndo('调整自定义布局尺寸', drag.snapshot);
          drag.changed = true;
        }
        node.ratio = nextRatio;
        this.applyFreeSplitRatio(first, node.ratio);
      });
      const finish = (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        drag = null;
        divider.classList.remove('dragging');
        try { divider.releasePointerCapture?.(event.pointerId); } catch (_) {}
        saveSettings(this.settings);
      };
      divider.addEventListener('pointerup', finish);
      divider.addEventListener('pointercancel', finish);
    }

    applyFreeLayoutTree() {
      if (this.settings.layout !== 'free') {
        this.restoreDirectLayoutModules();
        return;
      }
      const root = this.ensureFreeLayoutRoot();
      const tree = isCompleteLayoutTree(this.settings.layoutTree)
        ? this.settings.layoutTree
        : legacyOrderToLayoutTree(this.settings.freeOrder, this.settings.layoutColumnPercent, this.settings.layoutRows);
      this.settings.layoutTree = tree;
      if (this.renderedFreeLayoutTree === tree && root.childElementCount) return;
      root.replaceChildren();
      root.appendChild(this.createFreeLayoutNode(tree));
      this.renderedFreeLayoutTree = tree;
    }

    getLayoutData() {
      return {
        schema: LAYOUT_SCHEMA,
        preset: this.settings.layout,
        splitPercent: this.settings.splitPercent,
        columnPercent: this.settings.layoutColumnPercent,
        rows: [...this.settings.layoutRows],
        freeOrder: collectLayoutModules(this.settings.layoutTree),
        tree: cloneLayoutTree(this.settings.layoutTree),
      };
    }

    getLayoutHistorySnapshot() {
      return {
        layout: this.getLayoutData(),
        layoutEditing: !!this.settings.layoutEditing,
      };
    }

    recordLayoutUndo(label, snapshot = this.getLayoutHistorySnapshot()) {
      this.options.onLayoutUndo?.(label, snapshot);
    }

    restoreLayoutHistorySnapshot(snapshot) {
      if (!snapshot || !snapshot.layout) return false;
      const layout = normalizeLayoutData(snapshot.layout);
      this.settings.layout = layout.preset;
      this.settings.splitPercent = layout.splitPercent;
      this.settings.layoutColumnPercent = layout.columnPercent;
      this.settings.layoutRows = layout.rows;
      this.settings.freeOrder = layout.freeOrder;
      this.settings.layoutTree = layout.tree;
      this.settings.layoutEditing = layout.preset === 'free' && !!snapshot.layoutEditing;
      saveSettings(this.settings);
      this.applyLayout();
      this.render();
      return true;
    }

    resetLayout() {
      this.recordLayoutUndo('重置布局');
      this.settings.layout = DEFAULT_SETTINGS.layout;
      this.settings.splitPercent = DEFAULT_SETTINGS.splitPercent;
      this.settings.layoutColumnPercent = DEFAULT_SETTINGS.layoutColumnPercent;
      this.settings.layoutRows = [...DEFAULT_SETTINGS.layoutRows];
      this.settings.freeOrder = [...DEFAULT_FREE_ORDER];
      this.settings.layoutTree = legacyOrderToLayoutTree(
        DEFAULT_FREE_ORDER,
        DEFAULT_SETTINGS.layoutColumnPercent,
        DEFAULT_SETTINGS.layoutRows,
      );
      this.settings.layoutEditing = false;
      saveSettings(this.settings);
      this.applyLayout();
      this.render();
      this.setStatus('已恢复默认布局');
    }

    setLayoutData(value) {
      const layout = normalizeLayoutData(value);
      this.settings.layout = layout.preset;
      this.settings.splitPercent = layout.splitPercent;
      this.settings.layoutColumnPercent = layout.columnPercent;
      this.settings.layoutRows = layout.rows;
      this.settings.freeOrder = layout.freeOrder;
      this.settings.layoutTree = layout.tree;
      this.settings.layoutEditing = false;
      saveSettings(this.settings);
      this.applyLayout();
      this.render();
    }

    focusWaveform() {
      this.pane.focus({ preventScroll: true });
    }

    changeWaveformScale(direction) {
      const current = this.settings.waveformScale;
      const next = waveformScaleAfterStep(current, direction);
      if (next === current) {
        // 已到边界：减不下去/加不上去，通知编辑器给出提示
        document.dispatchEvent(new CustomEvent('asr:waveform-scale-limit', {
          detail: { atMin: direction < 0, atMax: direction > 0 },
        }));
        return;
      }
      this.settings.waveformScale = next;
      saveSettings(this.settings);
      this.applyLayout();
      this.renderSegments();
    }

    scheduleWheelScaleChange() {
      if (this.scaleRafScheduled) return;
      this.scaleRafScheduled = true;
      requestAnimationFrame(() => {
        this.scaleRafScheduled = false;
        if (this.pendingScaleDirection === 0) return;
        // 一帧内的滚动合并为单次方向；触摸板惯性抖动产生的正反向会互相抵消
        const direction = this.pendingScaleDirection > 0 ? 1 : -1;
        this.pendingScaleDirection = 0;
        this.changeWaveformScale(direction);
      });
    }

    updateDisabledVisibility() {
      this.renderSegments();
    }

    revealTime(timeMs, center = true) {
      if (this.settings.mode === 'hidden' || !this.payload) return;
      if (this.settings.mode === 'basic') {
        const windowMs = this.settings.visibleSeconds * 1000;
        const maxStart = Math.max(0, this.durationMs - windowMs);
        this.basicWindowStartMs = center
          ? clamp(timeMs - windowMs / 2, 0, maxStart)
          : clamp(this.basicWindowStartMs, 0, maxStart);
        this.manualFollowUntil = Date.now() + 3000;
        this.renderBasic();
        return;
      }
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowIndex = clamp(Math.floor(timeMs / rowDurationMs), 0, Math.max(0, Math.ceil(this.durationMs / rowDurationMs) - 1));
      const stride = ROW_HEIGHT + ROW_GAP;
      const target = center
        ? rowIndex * stride - Math.max(0, (this.scroll.clientHeight - ROW_HEIGHT) * 0.45)
        : rowIndex * stride;
      this.autoScrolling = true;
      this.scroll.scrollTop = Math.max(0, target);
      this.manualFollowUntil = Date.now() + 3000;
      requestAnimationFrame(() => {
        this.autoScrolling = false;
        this.renderMultiVisible(true);
      });
    }

    changeZoom(direction) {
      const current = ZOOM_PRESETS.indexOf(this.settings.visibleSeconds);
      const next = clamp(current + direction, 0, ZOOM_PRESETS.length - 1);
      if (next === current) return;
      this.settings.visibleSeconds = ZOOM_PRESETS[next];
      saveSettings(this.settings);
      this.windowLabel.textContent = `${this.settings.visibleSeconds} 秒`;
      this.centerBasicOnCurrentTime();
      if (this.settings.mode === 'basic') this.renderBasic();
    }

    setStatus(message, kind = '') {
      this.status.textContent = message;
      this.status.classList.toggle('error', kind === 'error');
      this.status.classList.toggle('busy', kind === 'busy');
    }

    attachPlayer(player) {
      if (this.player) {
        this.player.removeEventListener('timeupdate', this._onPlayerTime);
        this.player.removeEventListener('seeked', this._onPlayerTime);
        this.player.removeEventListener('loadedmetadata', this._onPlayerTime);
      }
      this.player = player;
      if (this.player) {
        this.player.addEventListener('timeupdate', this._onPlayerTime);
        this.player.addEventListener('seeked', this._onPlayerTime);
        this.player.addEventListener('loadedmetadata', this._onPlayerTime);
      }
      this.updatePlayback();
    }

    setMediaAvailable(available) {
      const next = Boolean(available);
      if (next === this.mediaAvailable) return;
      this.mediaAvailable = next;
      this.pane.classList.toggle('waveform-media-unavailable', !next);
      if (!this.payload) return;
      this.setStatus(next
        ? `${formatCompact(this.payload.duration_ms)} · ${this.payload.peak_count.toLocaleString()} peaks`
        : `${formatCompact(this.payload.duration_ms)} · 缓存波形（未加载媒体）`);
      this.render();
    }

    setPayload(payload) {
      const decoded = decodePayload(payload);
      if (!decoded) {
        this.payload = null;
        this.peaks = null;
        this.setStatus('等待波形数据');
        this.empty.textContent = '加载媒体后显示波形';
        this.empty.classList.remove('hidden');
        this.render();
        return false;
      }
      this.payload = payload;
      this.peaks = decoded;
      this.empty.classList.add('hidden');
      this.setStatus(this.mediaAvailable
        ? `${formatCompact(payload.duration_ms)} · ${payload.peak_count.toLocaleString()} peaks`
        : `${formatCompact(payload.duration_ms)} · 缓存波形（未加载媒体）`);
      this.centerBasicOnCurrentTime();
      this.multiRange = [-1, -1];
      this.render();
      return true;
    }

    getGapRemoveDetectionData() {
      if (!this.payload || !this.peaks) return null;
      return {
        peaks: this.peaks,
        peaks_per_second: this.payload.peaks_per_second,
        duration_ms: this.payload.duration_ms,
      };
    }

    async processFile(file) {
      const signature = sourceForFile(file);
      if (this.payload && sameSource(this.payload.source, signature)) {
        this.setStatus(`使用缓存 · ${this.payload.peak_count.toLocaleString()} peaks`);
        return this.payload;
      }
      this.options.onPayload(null);
      this.setPayload(null);
      if (file.size > BROWSER_DECODE_LIMIT) {
        const message = '媒体过大，浏览器不会整段解码；请用 edit.py 预生成波形';
        this.setStatus(message, 'error');
        throw new Error(message);
      }
      const durationSeconds = await this.waitForPlayerDuration();
      const estimatedPcmBytes = durationSeconds * 48000 * 2 * 4;
      if (durationSeconds > 0 && estimatedPcmBytes > BROWSER_PCM_ESTIMATE_LIMIT) {
        const message = '音轨较长，浏览器整段解码可能耗尽内存；请用 edit.py 预生成波形';
        this.setStatus(message, 'error');
        throw new Error(message);
      }
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        const message = '当前浏览器不支持 Web Audio；请用 edit.py 预生成波形';
        this.setStatus(message, 'error');
        throw new Error(message);
      }

      this.setStatus(`正在分析波形：${file.name}`, 'busy');
      let context = null;
      try {
        context = new AudioContextClass();
        const bytes = await file.arrayBuffer();
        const buffer = await context.decodeAudioData(bytes);
        const peaksPerSecond = 100;
        const channels = Array.from(
          { length: buffer.numberOfChannels },
          (_, index) => buffer.getChannelData(index),
        );
        const bucketSamples = Math.max(1, Math.round(buffer.sampleRate / peaksPerSecond));
        const peakCount = Math.ceil(buffer.length / bucketSamples);
        const encoded = new Uint8Array(peakCount * 2);
        for (let peakIndex = 0; peakIndex < peakCount; peakIndex++) {
          const start = peakIndex * bucketSamples;
          const end = Math.min(buffer.length, start + bucketSamples);
          const stride = Math.max(1, Math.ceil((end - start) / 96));
          let low = 1;
          let high = -1;
          for (let sample = start; sample < end; sample += stride) {
            for (const channel of channels) {
              const value = channel[sample];
              if (value < low) low = value;
              if (value > high) high = value;
            }
          }
          const lowSigned = clamp(Math.round(low * 127), -127, 127);
          const highSigned = clamp(Math.round(high * 127), -127, 127);
          encoded[peakIndex * 2] = lowSigned & 0xFF;
          encoded[peakIndex * 2 + 1] = highSigned & 0xFF;
          if (peakIndex > 0 && peakIndex % 20000 === 0) {
            this.setStatus(`正在分析波形：${Math.round((peakIndex / peakCount) * 100)}%`, 'busy');
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
        }
        const payload = {
          schema: SCHEMA,
          encoding: ENCODING,
          peaks_per_second: peaksPerSecond,
          peak_count: peakCount,
          duration_ms: Math.round(buffer.duration * 1000),
          data: bytesToBase64(encoded),
          source: signature,
        };
        this.options.onPayload(payload);
        this.setPayload(payload);
        return payload;
      } catch (error) {
        const message = `浏览器无法解析音轨：${error.message || error}；请用 edit.py 预生成波形`;
        this.setStatus(message, 'error');
        throw new Error(message);
      } finally {
        if (context) {
          try { await context.close(); } catch (_) {}
        }
      }
    }

    async waitForPlayerDuration() {
      const player = this.player;
      if (!player) return 0;
      if (Number.isFinite(player.duration) && player.duration > 0) {
        return player.duration;
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          player.removeEventListener('loadedmetadata', finish);
          resolve(Number.isFinite(player.duration) ? player.duration : 0);
        };
        const timer = setTimeout(finish, 3000);
        player.addEventListener('loadedmetadata', finish, { once: true });
      });
    }

    get durationMs() {
      if (this.payload) return this.payload.duration_ms;
      if (this.player && Number.isFinite(this.player.duration)) return Math.round(this.player.duration * 1000);
      return 0;
    }

    currentTimeMs() {
      return this.player && Number.isFinite(this.player.currentTime)
        ? Math.round(this.player.currentTime * 1000) : 0;
    }

    centerBasicOnCurrentTime() {
      const windowMs = this.settings.visibleSeconds * 1000;
      const maxStart = Math.max(0, this.durationMs - windowMs);
      this.basicWindowStartMs = clamp(this.currentTimeMs() - windowMs / 2, 0, maxStart);
    }

    scheduleRender() {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = requestAnimationFrame(() => this.render());
    }

    render() {
      this.applyLayout();
      if (this.settings.mode === 'hidden') return;
      if (!this.payload || !this.peaks) {
        this.content.replaceChildren();
        this.empty.classList.remove('hidden');
        return;
      }
      this.empty.classList.add('hidden');
      if (this.settings.mode === 'basic') this.renderBasic();
      else this.renderMulti();
    }

    renderSegments() {
      if (this.settings.mode === 'hidden' || !this.payload) return;
      if (this.settings.mode === 'basic') this.renderBasic();
      else this.renderMultiVisible(true);
    }

    renderBasic() {
      if (!this.payload) return;
      const windowMs = this.settings.visibleSeconds * 1000;
      const maxStart = Math.max(0, this.durationMs - windowMs);
      this.basicWindowStartMs = clamp(this.basicWindowStartMs, 0, maxStart);
      const endMs = Math.min(this.durationMs, this.basicWindowStartMs + windowMs);
      this.content.replaceChildren();
      this.content.style.height = '100%';
      const row = this.createRow(this.basicWindowStartMs, endMs, -1, true);
      this.content.appendChild(row);
      this.drawRow(row);
      this.updatePlayback(false);
    }

    renderMulti() {
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowCount = Math.max(1, Math.ceil(this.durationMs / rowDurationMs));
      this.content.style.height = `${rowCount * (ROW_HEIGHT + ROW_GAP) - ROW_GAP}px`;
      this.multiRange = [-1, -1];
      this.renderMultiVisible(true);
    }

    renderMultiVisible(force = false) {
      if (!this.isMultiMode() || !this.payload) return;
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowCount = Math.max(1, Math.ceil(this.durationMs / rowDurationMs));
      const stride = ROW_HEIGHT + ROW_GAP;
      const first = clamp(Math.floor(this.scroll.scrollTop / stride) - 2, 0, rowCount - 1);
      const last = clamp(Math.ceil((this.scroll.scrollTop + this.scroll.clientHeight) / stride) + 2, 0, rowCount - 1);
      if (!force && first === this.multiRange[0] && last === this.multiRange[1]) {
        this.updatePlayback(false);
        return;
      }
      this.multiRange = [first, last];
      this.content.replaceChildren();
      this.content.style.height = `${rowCount * stride - ROW_GAP}px`;
      for (let index = first; index <= last; index++) {
        const startMs = index * rowDurationMs;
        const endMs = Math.min(this.durationMs, startMs + rowDurationMs);
        const row = this.createRow(startMs, endMs, index, false);
        row.style.top = `${index * stride}px`;
        row.style.height = `${ROW_HEIGHT}px`;
        this.content.appendChild(row);
        this.drawRow(row);
      }
      this.updatePlayback(false);
    }

    createRow(startMs, endMs, rowIndex, basic) {
      const row = document.createElement('div');
      row.className = 'waveform-row';
      row.dataset.startMs = String(startMs);
      row.dataset.endMs = String(endMs);
      row.dataset.rowIndex = String(rowIndex);
      if (basic) row.dataset.basic = 'true';

      const canvas = document.createElement('canvas');
      row.appendChild(canvas);

      const time = document.createElement('div');
      time.className = 'waveform-row-time';
      time.textContent = `${formatCompact(startMs)} → ${formatCompact(endMs)}`;
      row.appendChild(time);

      const playhead = document.createElement('div');
      playhead.className = 'waveform-playhead';
      playhead.hidden = true;
      row.appendChild(playhead);

      const gaps = this.options.getGapRemoveGaps?.() || [];
      const gapOperationMode = this.options.getGapOperationMode?.() || 'middle_drag';
      gaps.forEach((gap, index) => {
        if (!gap || gap.end <= startMs || gap.start >= endMs) return;
        const block = document.createElement('div');
        block.className = 'waveform-gap-block';
        block.dataset.gapIndex = String(index);
        block.classList.toggle('restored', gap.removed === false);
        block.classList.toggle('boundary-editable', gapOperationMode === 'boundary_drag');
        const stateTitle = gap.removed === false
          ? '已保留空隙；左键跳转播放头，Alt+左键移除'
          : '已移除静音空隙；左键跳转播放头，Alt+左键恢复';
        block.title = gapOperationMode === 'boundary_drag'
          ? `${stateTitle}；拖动左右边界可人工调整范围`
          : gapOperationMode === 'middle_drag'
            ? `${stateTitle}；中键拖动增加静音，Alt+中键拖动恢复声音`
            : stateTitle;
        const label = document.createElement('span');
        label.className = 'waveform-gap-label';
        label.textContent = gap.removed === false ? '已恢复' : '已移除';
        block.appendChild(label);
        if (gapOperationMode === 'boundary_drag') {
          if (gap.start >= startMs) {
            const leftHandle = document.createElement('span');
            leftHandle.className = 'waveform-gap-handle left';
            block.appendChild(leftHandle);
          }
          if (gap.end <= endMs) {
            const rightHandle = document.createElement('span');
            rightHandle.className = 'waveform-gap-handle right';
            block.appendChild(rightHandle);
          }
        }
        this.layoutGapBlock(block, gap, startMs, endMs);
        block.addEventListener('pointerdown', (event) => {
          const handle = event.target.closest('.waveform-gap-handle');
          if (!handle || event.altKey) return;
          this.beginGapBoundaryDrag(
            event,
            index,
            row,
            handle.classList.contains('left') ? 'start' : 'end',
          );
        });
        block.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (Date.now() < this.suppressGapClickUntil) return;
          if (event.altKey) {
            this.options.toggleGapRemoved?.(index);
            return;
          }
          const timeMs = this.timeFromPointer(event, row);
          this.options.previewGapAt?.(index, timeMs);
          this.options.seek(timeMs / 1000);
          this.updatePlayback();
        });
        block.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        block.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        row.appendChild(block);
      });

      const segments = this.options.getSegments();
      const selected = this.options.getSelection();
      const now = this.currentTimeMs();
      segments.forEach((segment, index) => {
        if (segment.end <= startMs || segment.start >= endMs) return;
        if (segment.disabled && (this.options.getHideDisabled?.() || this.settings.disabledDisplay === 'hidden')) return;
        const block = document.createElement('div');
        block.className = 'waveform-cue-block';
        block.dataset.idx = String(index);
        block.style.setProperty('--cue-color', colorForSegment(segment));
        if (selected.has(index)) block.classList.add('selected');
        if (segment.disabled) block.classList.add('disabled');
        if (!segment.disabled && now >= segment.start && now <= segment.end) block.classList.add('active');

        const label = document.createElement('span');
        label.className = 'waveform-cue-label';
        label.textContent = segment.text.replace(/\s+/g, ' ');
        block.appendChild(label);
        if (segment.start >= startMs) {
          const leftHandle = document.createElement('span');
          leftHandle.className = 'waveform-cue-handle left';
          block.appendChild(leftHandle);
        }
        if (segment.end <= endMs) {
          const rightHandle = document.createElement('span');
          rightHandle.className = 'waveform-cue-handle right';
          block.appendChild(rightHandle);
        }
        this.layoutBlock(block, segment, startMs, endMs);
        block.addEventListener('pointerdown', (event) => this.beginCueDrag(event, index, row));
        block.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const timeMs = this.timeFromPointer(event, row);
          this.options.showContextMenu?.(event.clientX, event.clientY, index, timeMs);
        });
        block.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.options.togglePlayback();
        });
        row.appendChild(block);
      });

      row.addEventListener('pointerdown', (event) => {
        if (event.button === 1 && gapOperationMode === 'middle_drag') {
          this.beginGapRangeDrag(event, row);
          return;
        }
        if (event.button !== 0 || event.target.closest('.waveform-cue-block, .waveform-gap-block')) return;
        event.preventDefault();
        // 普通左键点击空白波形：清除字幕选中并跳转播放头
        this.options.clearSelection?.();
        this.seekFromPointer(event, row);
      });
      row.addEventListener('auxclick', (event) => {
        if (event.button === 1 && gapOperationMode === 'middle_drag') event.preventDefault();
      });
      row.addEventListener('dblclick', (event) => {
        if (event.target.closest('.waveform-cue-block, .waveform-gap-block')) return;
        event.preventDefault();
        this.options.togglePlayback();
      });
      row.addEventListener('contextmenu', (event) => {
        if (event.target.closest('.waveform-cue-block, .waveform-gap-block')) return;
        event.preventDefault();
        event.stopPropagation();
        const time = this.timeFromPointer(event, row);
        this.options.showBlankWaveformMenu?.(time, event.clientX, event.clientY);
      });
      return row;
    }

    layoutBlock(block, segment, startMs, endMs) {
      const duration = Math.max(1, endMs - startMs);
      const visibleStart = Math.max(startMs, segment.start);
      const visibleEnd = Math.min(endMs, segment.end);
      const left = ((visibleStart - startMs) / duration) * 100;
      const width = Math.max(0.25, ((visibleEnd - visibleStart) / duration) * 100);
      block.style.left = `${left}%`;
      block.style.width = `${width}%`;
      block.hidden = visibleEnd <= visibleStart;
    }

    layoutGapBlock(block, gap, startMs, endMs) {
      const duration = Math.max(1, endMs - startMs);
      const visibleStart = Math.max(startMs, gap.start);
      const visibleEnd = Math.min(endMs, gap.end);
      const left = ((visibleStart - startMs) / duration) * 100;
      const width = Math.max(0.25, ((visibleEnd - visibleStart) / duration) * 100);
      block.style.left = `${left}%`;
      block.style.width = `${width}%`;
      block.hidden = visibleEnd <= visibleStart;
    }

    refreshCueBlocks() {
      const segments = this.options.getSegments();
      this.content.querySelectorAll('.waveform-cue-block').forEach((block) => {
        const segment = segments[Number(block.dataset.idx)];
        const row = block.closest('.waveform-row');
        if (!segment || !row) return;
        this.layoutBlock(block, segment, Number(row.dataset.startMs), Number(row.dataset.endMs));
        block.classList.toggle('selected', this.options.getSelection().has(Number(block.dataset.idx)));
      });
      this.positionPlayheads();
    }

    updateSelection() {
      const selected = this.options.getSelection();
      this.content.querySelectorAll('.waveform-cue-block').forEach((block) => {
        block.classList.toggle('selected', selected.has(Number(block.dataset.idx)));
      });
    }

    drawRow(row) {
      const canvas = row.querySelector('canvas');
      const rect = row.getBoundingClientRect();
      if (!canvas || rect.width <= 0 || rect.height <= 0 || !this.peaks) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#1d252d';
      ctx.fillRect(0, 0, width, height);

      const startMs = Number(row.dataset.startMs);
      const endMs = Number(row.dataset.endMs);
      const rangeMs = Math.max(1, endMs - startMs);
      const tickSeconds = rangeMs <= 10000 ? 1 : rangeMs <= 30000 ? 2 : 5;
      const firstTick = Math.ceil(startMs / (tickSeconds * 1000)) * tickSeconds * 1000;
      ctx.strokeStyle = '#2d3944';
      ctx.lineWidth = 1;
      for (let tick = firstTick; tick < endMs; tick += tickSeconds * 1000) {
        const x = ((tick - startMs) / rangeMs) * width;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
      }
      ctx.strokeStyle = '#3b4b59';
      ctx.beginPath();
      ctx.moveTo(0, height * 0.46);
      ctx.lineTo(width, height * 0.46);
      ctx.stroke();

      const peaksPerSecond = this.payload.peaks_per_second;
      const useInterpolation = this.settings.mode === 'basic'
        && this.settings.visibleSeconds === ZOOM_PRESETS[0]
        && (rangeMs / 1000) * peaksPerSecond < width;
      const interpolatedPeak = [0, 0];
      const center = height * 0.46;
      const amplitude = waveformAmplitude(height, this.settings.waveformScale);
      const minWaveY = 2;
      const maxWaveY = Math.max(minWaveY, height - 2);
      ctx.strokeStyle = this.mediaAvailable ? '#65b89a' : '#83909a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const xStartMs = startMs + (x / width) * rangeMs;
        const xEndMs = startMs + ((x + 1) / width) * rangeMs;
        let low;
        let high;
        if (useInterpolation) {
          const centerMs = (xStartMs + xEndMs) / 2;
          const peakPosition = (centerMs / 1000) * peaksPerSecond - 0.5;
          sampleInterpolatedPeak(
            this.peaks,
            peakPosition,
            this.payload.peak_count,
            interpolatedPeak,
          );
          [low, high] = interpolatedPeak;
        } else {
          const firstPeak = clamp(Math.floor((xStartMs / 1000) * peaksPerSecond), 0, this.payload.peak_count - 1);
          const lastPeak = clamp(Math.ceil((xEndMs / 1000) * peaksPerSecond), firstPeak + 1, this.payload.peak_count);
          low = 127;
          high = -127;
          for (let peak = firstPeak; peak < lastPeak; peak++) {
            low = Math.min(low, this.peaks[peak * 2]);
            high = Math.max(high, this.peaks[peak * 2 + 1]);
          }
        }
        ctx.moveTo(x + 0.5, clamp(center - (high / 127) * amplitude, minWaveY, maxWaveY));
        ctx.lineTo(x + 0.5, clamp(center - (low / 127) * amplitude, minWaveY, maxWaveY));
      }
      ctx.stroke();
    }

    seekFromPointer(event, row) {
      this.options.seek(this.timeFromPointer(event, row) / 1000);
      this.updatePlayback();
    }

    timeFromPointer(event, row) {
      const rect = row.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const startMs = Number(row.dataset.startMs);
      const endMs = Number(row.dataset.endMs);
      return startMs + ratio * (endMs - startMs);
    }

    handleWheel(event) {
      if (event.shiftKey && this.settings.mode !== 'hidden') {
        event.preventDefault();
        // 用 rAF 合并高频滚轮：一帧内累加方向，避免每次 wheel 都重渲染导致卡顿
        this.pendingScaleDirection += event.deltaY > 0 ? -1 : 1;
        this.scheduleWheelScaleChange();
        return;
      }
      if (this.settings.mode === 'basic') {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          this.changeZoom(event.deltaY > 0 ? 1 : -1);
          return;
        }
        const windowMs = this.settings.visibleSeconds * 1000;
        const maxStart = Math.max(0, this.durationMs - windowMs);
        const delta = Math.sign(event.deltaY || event.deltaX) * windowMs * 0.12;
        this.basicWindowStartMs = clamp(this.basicWindowStartMs + delta, 0, maxStart);
        this.manualFollowUntil = Date.now() + 3000;
        this.renderBasic();
        return;
      }
      if (this.isMultiMode() && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        const current = ROW_PRESETS.indexOf(this.settings.secondsPerRow);
        const next = clamp(current + (event.deltaY > 0 ? 1 : -1), 0, ROW_PRESETS.length - 1);
        if (next !== current) {
          this.settings.secondsPerRow = ROW_PRESETS[next];
          this.secondsPerRowSelect.value = String(this.settings.secondsPerRow);
          saveSettings(this.settings);
          this.renderMulti();
        }
      }
    }

    beginCueDrag(event, index, row) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      // 剃刀工具：无修饰键左键点击字幕块（非手柄）时，在指针位置安全拆分。
      // 修饰键（Alt/Ctrl/Cmd/Shift）仍走原行为，便于拆分后立即多选/禁用。
      const targetHandle = event.target.closest('.waveform-cue-handle');
      if (this.tool === 'razor' && !targetHandle
          && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const timeMs = this.timeFromPointer(event, row);
        this.options.splitCueAtTime?.(index, timeMs);
        return;
      }
      // Alt 行为分裂：命中共享边界手柄时拆开为单侧独立拖动；否则保持
      // Alt+点击字幕块切换禁用的既有行为。
      if (event.altKey && targetHandle) {
        const sharedLeft = targetHandle.classList.contains('left')
          && index > 0 && this.isSharedBoundary(event, index - 1, index, row);
        const sharedRight = targetHandle.classList.contains('right')
          && index + 1 < this.options.getSegments().length
          && this.isSharedBoundary(event, index, index + 1, row);
        if (sharedLeft || sharedRight) {
          return this.beginIndependentEdgeDrag(event, index, row, targetHandle);
        }
      }
      if (event.altKey) {
        this.options.toggleDisabled?.([index]);
        return;
      }
      // Ctrl/Cmd+click toggles selection without starting a drag
      if (event.ctrlKey || event.metaKey) {
        this.options.toggleCueSelection?.(index);
        return;
      }
      // Shift+click selects a range from lastClickedIdx to index
      if (event.shiftKey) {
        this.options.selectCueRange?.(index);
        return;
      }
      let boundaryIndex = index;
      const kind = targetHandle?.classList.contains('left')
        ? (index > 0 && this.isSharedBoundary(event, index - 1, index, row)
          ? (boundaryIndex = index - 1, 'resize-boundary') : 'resize-left')
        : targetHandle?.classList.contains('right')
          ? (index + 1 < this.options.getSegments().length && this.isSharedBoundary(event, index, index + 1, row)
            ? 'resize-boundary' : 'resize-right')
          : 'move';
      const selected = this.options.getSelection();
      if (!selected.has(index)) this.options.selectCue(index);
      const liveSelection = this.options.getSelection();
      const indices = kind === 'move' && liveSelection.has(index)
        ? [...liveSelection].sort((a, b) => a - b) : [index];
      const segments = this.options.getSegments();
      const dragIndices = kind === 'resize-boundary' ? [boundaryIndex, boundaryIndex + 1] : indices;
      const originals = new Map(dragIndices.map((idx) => [idx, {
        start: segments[idx].start,
        end: segments[idx].end,
        items: Array.isArray(segments[idx].items)
          ? segments[idx].items.map((item) => ({ ...item })) : segments[idx].items,
      }]));
      const rect = row.getBoundingClientRect();
      this.drag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        rangeMs: Number(row.dataset.endMs) - Number(row.dataset.startMs),
        rowWidth: Math.max(1, rect.width),
        kind,
        index: kind === 'resize-boundary' ? boundaryIndex : index,
        indices: dragIndices,
        row,
        originals,
        started: false,
        changed: false,
      };
      event.currentTarget.classList.add('dragging');
      window.addEventListener('pointermove', this._dragMove = (moveEvent) => this.moveCueDrag(moveEvent));
      window.addEventListener('pointerup', this._dragEnd = (upEvent) => this.endCueDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._dragEnd, { once: true });
    }

    isSharedBoundary(event, leftIndex, rightIndex, row) {
      const segments = this.options.getSegments();
      const left = segments[leftIndex];
      const right = segments[rightIndex];
      if (!left || !right || Math.abs(left.end - right.start) > SNAP_MS) return false;
      const pointerMs = this.timeFromPointer(event, row);
      return Math.abs(pointerMs - left.end) <= SNAP_MS || Math.abs(pointerMs - right.start) <= SNAP_MS;
    }

    // Alt-drag 命中共享边界手柄：只拖动被命中一侧，邻居的相反边保持不动。
    // 默认（非 Alt）拖动共享边界会把两侧一起联动；本方法是该联动的独立拆开版本。
    beginIndependentEdgeDrag(event, index, row, targetHandle) {
      const segments = this.options.getSegments();
      const isLeftHandle = targetHandle.classList.contains('left');
      // left 手柄命中 index-1|index 共享边界 → 移动 index 段的 start；
      // right 手柄命中 index|index+1 共享边界 → 移动 index 段的 end。
      const movedIndex = isLeftHandle ? index : index;
      const edge = isLeftHandle ? 'start' : 'end';
      const dragIndex = isLeftHandle ? index - 1 : index; // 左侧段索引，用于 applyIndependentEdge
      const originals = new Map([[movedIndex, {
        start: segments[movedIndex].start,
        end: segments[movedIndex].end,
        items: Array.isArray(segments[movedIndex].items)
          ? segments[movedIndex].items.map((item) => ({ ...item })) : segments[movedIndex].items,
      }]]);
      const rect = row.getBoundingClientRect();
      this.drag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        rangeMs: Number(row.dataset.endMs) - Number(row.dataset.startMs),
        rowWidth: Math.max(1, rect.width),
        kind: 'resize-boundary-independent',
        index: movedIndex,
        edge,
        dragIndex,
        indices: [movedIndex],
        row,
        originals,
        started: false,
        changed: false,
      };
      event.currentTarget.classList.add('dragging');
      window.addEventListener('pointermove', this._dragMove = (moveEvent) => this.moveCueDrag(moveEvent));
      window.addEventListener('pointerup', this._dragEnd = (upEvent) => this.endCueDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._dragEnd, { once: true });
    }

    applyIndependentBoundaryDrag(drag, rawDelta) {
      const segments = this.options.getSegments();
      const original = drag.originals.get(drag.index);
      if (!original) return;
      const base = drag.edge === 'start' ? original.start : original.end;
      const value = base + rawDelta;
      applyIndependentEdge(segments, drag.dragIndex, drag.edge, value, MIN_CUE_MS);
      const seg = segments[drag.index];
      this.setStatus(`${drag.edge === 'start' ? '起点' : '终点'} ${formatCompact(drag.edge === 'start' ? seg.start : seg.end)}`);
    }

    beginGapBoundaryDrag(event, index, row, edge) {
      if (event.button !== 0 || this.options.getGapOperationMode?.() !== 'boundary_drag') return;
      event.preventDefault();
      event.stopPropagation();
      const gaps = this.options.getGapRemoveGaps?.() || [];
      this.gapBoundaryDrag = {
        pointerId: event.pointerId,
        index,
        edge,
        row,
        originalGaps: gaps.map((gap) => ({ ...gap })),
        nextGaps: gaps.map((gap) => ({ ...gap })),
        captureTarget: event.currentTarget,
        changed: false,
      };
      event.currentTarget.classList.add('dragging');
      event.currentTarget.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', this._gapBoundaryMove = (moveEvent) => this.moveGapBoundaryDrag(moveEvent));
      window.addEventListener('pointerup', this._gapBoundaryEnd = (upEvent) => this.endGapBoundaryDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._gapBoundaryEnd, { once: true });
    }

    refreshGapBlocks(gaps) {
      this.content.querySelectorAll('.waveform-gap-block').forEach((block) => {
        const gap = gaps[Number(block.dataset.gapIndex)];
        const row = block.closest('.waveform-row');
        if (!gap || !row) {
          block.hidden = true;
          return;
        }
        this.layoutGapBlock(block, gap, Number(row.dataset.startMs), Number(row.dataset.endMs));
      });
    }

    previewGapBoundaryDrag(drag) {
      this.refreshGapBlocks(drag.originalGaps);
      const original = drag.originalGaps[drag.index];
      if (!original) return;
      const anchor = drag.edge === 'start' ? original.end - 1 : original.start + 1;
      const target = drag.nextGaps.find((gap) => (
        gap.removed === original.removed && gap.start <= anchor && gap.end > anchor
      ));
      if (!target) return;
      this.content.querySelectorAll(`.waveform-gap-block[data-gap-index="${drag.index}"]`).forEach((block) => {
        const row = block.closest('.waveform-row');
        if (row) this.layoutGapBlock(block, target, Number(row.dataset.startMs), Number(row.dataset.endMs));
      });
      const adjacentIndex = drag.edge === 'start' ? drag.index - 1 : drag.index + 1;
      const adjacentOriginal = drag.originalGaps[adjacentIndex];
      const shared = adjacentOriginal && (
        drag.edge === 'start'
          ? adjacentOriginal.end === original.start
          : adjacentOriginal.start === original.end
      );
      if (!shared) return;
      const adjacentAnchor = drag.edge === 'start' ? adjacentOriginal.start + 1 : adjacentOriginal.end - 1;
      const adjacentTarget = drag.nextGaps.find((gap) => (
        gap.removed === adjacentOriginal.removed
        && gap.start <= adjacentAnchor && gap.end > adjacentAnchor
      ));
      if (!adjacentTarget) return;
      this.content.querySelectorAll(`.waveform-gap-block[data-gap-index="${adjacentIndex}"]`).forEach((block) => {
        const row = block.closest('.waveform-row');
        if (row) this.layoutGapBlock(block, adjacentTarget, Number(row.dataset.startMs), Number(row.dataset.endMs));
      });
    }

    moveGapBoundaryDrag(event) {
      const drag = this.gapBoundaryDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const valueMs = roundMs(this.timeFromPointer(event, drag.row));
      drag.nextGaps = window.AsrEditorUtils.resizeGapRemoveBoundary(
        drag.originalGaps,
        drag.index,
        drag.edge,
        valueMs,
      );
      drag.changed = JSON.stringify(drag.nextGaps) !== JSON.stringify(drag.originalGaps);
      drag.valueMs = valueMs;
      this.previewGapBoundaryDrag(drag);
    }

    endGapBoundaryDrag(event) {
      const drag = this.gapBoundaryDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      window.removeEventListener('pointermove', this._gapBoundaryMove);
      window.removeEventListener('pointerup', this._gapBoundaryEnd);
      window.removeEventListener('pointercancel', this._gapBoundaryEnd);
      try { drag.captureTarget.releasePointerCapture?.(event.pointerId); } catch (_) {}
      this.content.querySelectorAll('.waveform-gap-block.dragging').forEach((block) => block.classList.remove('dragging'));
      this.gapBoundaryDrag = null;
      if (event.type === 'pointercancel' || !drag.changed) {
        this.refreshGapBlocks(drag.originalGaps);
        return;
      }
      this.suppressGapClickUntil = Date.now() + 250;
      this.options.resizeGapBoundary?.(drag.index, drag.edge, drag.valueMs);
    }

    beginGapRangeDrag(event, row) {
      event.preventDefault();
      event.stopPropagation();
      const preview = document.createElement('div');
      const removed = !event.altKey;
      preview.className = `waveform-gap-range-preview ${removed ? 'remove' : 'restore'}`;
      const label = document.createElement('span');
      label.textContent = removed ? '增加静音' : '恢复声音';
      preview.appendChild(label);
      row.appendChild(preview);
      this.gapRangeDrag = {
        pointerId: event.pointerId,
        row,
        startMs: this.timeFromPointer(event, row),
        endMs: this.timeFromPointer(event, row),
        removed,
        preview,
      };
      this.layoutGapRangePreview(this.gapRangeDrag);
      row.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', this._gapRangeMove = (moveEvent) => this.moveGapRangeDrag(moveEvent));
      window.addEventListener('pointerup', this._gapRangeEnd = (upEvent) => this.endGapRangeDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._gapRangeEnd, { once: true });
    }

    layoutGapRangePreview(drag) {
      const rowStart = Number(drag.row.dataset.startMs);
      const rowEnd = Number(drag.row.dataset.endMs);
      const duration = Math.max(1, rowEnd - rowStart);
      const start = Math.min(drag.startMs, drag.endMs);
      const end = Math.max(drag.startMs, drag.endMs);
      drag.preview.style.left = `${((start - rowStart) / duration) * 100}%`;
      drag.preview.style.width = `${Math.max(0.25, ((end - start) / duration) * 100)}%`;
    }

    moveGapRangeDrag(event) {
      const drag = this.gapRangeDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      drag.endMs = this.timeFromPointer(event, drag.row);
      this.layoutGapRangePreview(drag);
    }

    endGapRangeDrag(event) {
      const drag = this.gapRangeDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      window.removeEventListener('pointermove', this._gapRangeMove);
      window.removeEventListener('pointerup', this._gapRangeEnd);
      window.removeEventListener('pointercancel', this._gapRangeEnd);
      try { drag.row.releasePointerCapture?.(event.pointerId); } catch (_) {}
      drag.preview.remove();
      this.gapRangeDrag = null;
      if (event.type === 'pointercancel') return;
      const start = roundMs(Math.min(drag.startMs, drag.endMs));
      const end = roundMs(Math.max(drag.startMs, drag.endMs));
      if (end - start < ROUND_MS) return;
      this.options.applyGapRange?.(start, end, drag.removed);
    }

    moveCueDrag(event) {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const deltaMs = ((event.clientX - drag.startClientX) / drag.rowWidth) * drag.rangeMs;
      if (!drag.started && Math.abs(deltaMs) < 2) return;
      if (!drag.started) {
        drag.started = true;
        const label = drag.kind === 'move' ? '移动字幕时间'
          : drag.kind === 'resize-boundary-independent' ? '独立调整字幕边界'
          : '调整字幕边界';
        this.options.onBeginEdit(label);
      }
      if (drag.kind === 'move') this.applyMoveDrag(drag, deltaMs, event.altKey);
      else if (drag.kind === 'resize-boundary') this.applyBoundaryDrag(drag, deltaMs, event.altKey);
      else if (drag.kind === 'resize-boundary-independent') this.applyIndependentBoundaryDrag(drag, deltaMs);
      else this.applyResizeDrag(drag, deltaMs, event.altKey);
      drag.changed = true;
      this.refreshCueBlocks();
    }

    applyMoveDrag(drag, rawDelta, disableSnap) {
      const segments = this.options.getSegments();
      const moved = new Set(drag.indices);
      let minDelta = -Infinity;
      let maxDelta = Infinity;
      for (const idx of drag.indices) {
        const original = drag.originals.get(idx);
        minDelta = Math.max(minDelta, -original.start);
        maxDelta = Math.min(maxDelta, this.durationMs - original.end);
        if (idx > 0 && !moved.has(idx - 1)) minDelta = Math.max(minDelta, segments[idx - 1].end - original.start);
        if (idx + 1 < segments.length && !moved.has(idx + 1)) {
          maxDelta = Math.min(maxDelta, segments[idx + 1].start - original.end);
        }
      }
      let delta = rawDelta;
      if (!disableSnap) {
        const candidates = [];
        const playhead = this.currentTimeMs();
        for (const idx of drag.indices) {
          const original = drag.originals.get(idx);
          candidates.push(playhead - original.start, playhead - original.end);
          if (idx > 0 && !moved.has(idx - 1)) candidates.push(segments[idx - 1].end - original.start);
          if (idx + 1 < segments.length && !moved.has(idx + 1)) {
            candidates.push(segments[idx + 1].start - original.end);
          }
        }
        const nearest = candidates.reduce((best, value) => (
          Math.abs(value - delta) < Math.abs(best - delta) ? value : best
        ), Infinity);
        if (Number.isFinite(nearest) && Math.abs(nearest - delta) <= SNAP_MS) delta = nearest;
      }
      delta = clamp(roundMs(delta), minDelta, maxDelta);
      for (const idx of drag.indices) {
        const original = drag.originals.get(idx);
        const segment = segments[idx];
        segment.start = original.start + delta;
        segment.end = original.end + delta;
        if (Array.isArray(original.items)) {
          segment.items = original.items.map((item) => ({
            ...item,
            start: item.start + delta,
            end: item.end + delta,
          }));
        }
      }
      this.setStatus(`移动 ${drag.indices.length} 条 · ${delta >= 0 ? '+' : ''}${delta} ms`);
    }

    applyResizeDrag(drag, rawDelta, disableSnap) {
      const segments = this.options.getSegments();
      const segment = segments[drag.index];
      const original = drag.originals.get(drag.index);
      let newStart = original.start;
      let newEnd = original.end;
      if (drag.kind === 'resize-left') {
        const lower = drag.index > 0 ? segments[drag.index - 1].end : 0;
        const upper = original.end - MIN_CUE_MS;
        newStart = original.start + rawDelta;
        if (!disableSnap) {
          const targets = [lower, this.currentTimeMs()];
          const nearest = targets.reduce((best, value) => (
            Math.abs(value - newStart) < Math.abs(best - newStart) ? value : best
          ), Infinity);
          if (Number.isFinite(nearest) && Math.abs(nearest - newStart) <= SNAP_MS) newStart = nearest;
        }
        newStart = clamp(roundMs(newStart), lower, upper);
      } else {
        const lower = original.start + MIN_CUE_MS;
        const upper = drag.index + 1 < segments.length ? segments[drag.index + 1].start : this.durationMs;
        newEnd = original.end + rawDelta;
        if (!disableSnap) {
          const targets = [upper, this.currentTimeMs()];
          const nearest = targets.reduce((best, value) => (
            Math.abs(value - newEnd) < Math.abs(best - newEnd) ? value : best
          ), Infinity);
          if (Number.isFinite(nearest) && Math.abs(nearest - newEnd) <= SNAP_MS) newEnd = nearest;
        }
        newEnd = clamp(roundMs(newEnd), lower, upper);
      }
      segment.start = newStart;
      segment.end = newEnd;
      segment.items = remapItems(original.items, original.start, original.end, newStart, newEnd);
      this.setStatus(`${formatCompact(newStart)} → ${formatCompact(newEnd)}`);
    }

    applyBoundaryDrag(drag, rawDelta, disableSnap) {
      const segments = this.options.getSegments();
      const left = drag.originals.get(drag.index);
      const right = drag.originals.get(drag.index + 1);
      if (!left || !right) return;
      let boundary = left.end + rawDelta;
      const lower = left.start + MIN_CUE_MS;
      const upper = right.end - MIN_CUE_MS;
      if (!disableSnap) {
        const candidates = [this.currentTimeMs()];
        if (drag.index > 0) candidates.push(segments[drag.index - 1].end);
        if (drag.index + 2 < segments.length) candidates.push(segments[drag.index + 2].start);
        const nearest = candidates.reduce((best, value) => (
          Math.abs(value - boundary) < Math.abs(best - boundary) ? value : best
        ), Infinity);
        if (Number.isFinite(nearest) && Math.abs(nearest - boundary) <= SNAP_MS) boundary = nearest;
      }
      boundary = clamp(roundMs(boundary), lower, upper);
      const leftSegment = segments[drag.index];
      const rightSegment = segments[drag.index + 1];
      leftSegment.end = boundary;
      rightSegment.start = boundary;
      leftSegment.items = remapItems(left.items, left.start, left.end, left.start, boundary);
      rightSegment.items = remapItems(right.items, right.start, right.end, boundary, right.end);
      this.setStatus(`共享边界 ${formatCompact(boundary)}`);
    }

    endCueDrag(event) {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      window.removeEventListener('pointermove', this._dragMove);
      window.removeEventListener('pointerup', this._dragEnd);
      window.removeEventListener('pointercancel', this._dragEnd);
      this.content.querySelectorAll('.waveform-cue-block.dragging').forEach((block) => block.classList.remove('dragging'));
      this.drag = null;
      if (!drag.changed) {
        // select-only 模式下点击字幕块只选中不跳转；select-and-seek 跳到点击位置
        if (this.options.getClickBehavior?.() !== 'select-only') this.seekFromPointer(event, drag.row);
        return;
      }
      drag.indices.forEach((idx) => { this.options.getSegments()[idx]._dirty = true; });
      this.options.onCommitEdit(drag.indices, drag.kind);
      this.renderSegments();
    }

    updatePlayback(allowFollow = true) {
      if (!this.payload || this.settings.mode === 'hidden') return;
      const now = this.currentTimeMs();
      const segments = this.options.getSegments();
      const activeIndex = segments.findIndex((segment) => !segment.disabled && now >= segment.start && now <= segment.end);
      if (activeIndex !== this.activeIndex) {
        this.activeIndex = activeIndex;
        this.content.querySelectorAll('.waveform-cue-block').forEach((block) => {
          block.classList.toggle('active', Number(block.dataset.idx) === activeIndex);
        });
      }

      if (allowFollow && this.settings.mode === 'basic') {
        const windowMs = this.settings.visibleSeconds * 1000;
        const relative = (now - this.basicWindowStartMs) / Math.max(1, windowMs);
        if (now < this.basicWindowStartMs || now > this.basicWindowStartMs + windowMs ||
            (this.player && !this.player.paused && Date.now() > this.manualFollowUntil && (relative < 0.2 || relative > 0.8))) {
          this.centerBasicOnCurrentTime();
          this.renderBasic();
          return;
        }
      }

      if (allowFollow && this.isMultiMode() && this.player && !this.player.paused && Date.now() > this.manualFollowUntil) {
        const rowIndex = Math.floor(now / (this.settings.secondsPerRow * 1000));
        if (rowIndex < this.multiRange[0] || rowIndex > this.multiRange[1]) {
          this.autoScrolling = true;
          this.scroll.scrollTop = Math.max(0, rowIndex * (ROW_HEIGHT + ROW_GAP) - this.scroll.clientHeight * 0.35);
          requestAnimationFrame(() => { this.autoScrolling = false; });
          this.renderMultiVisible(true);
        }
      }
      this.positionPlayheads();
    }

    positionPlayheads() {
      const now = this.currentTimeMs();
      this.content.querySelectorAll('.waveform-row').forEach((row) => {
        const startMs = Number(row.dataset.startMs);
        const endMs = Number(row.dataset.endMs);
        const playhead = row.querySelector('.waveform-playhead');
        if (!playhead) return;
        const visible = now >= startMs && now <= endMs;
        playhead.hidden = !visible;
        if (visible) playhead.style.left = `${((now - startMs) / Math.max(1, endMs - startMs)) * 100}%`;
      });
    }
  }

  window.AsrWaveform = {
    create(options) {
      return new WaveformEditor(options);
    },
    testing: {
      decodePayload,
      remapItems,
      roundMs,
      sourceForFile,
      applySharedBoundary,
      applyIndependentEdge,
      splitSegmentAtTime,
      normalizeNewCueRange,
      clampWaveformScale,
      waveformScaleAfterStep,
      waveformAmplitude,
      sampleInterpolatedPeak,
      normalizeLayoutData,
      swapFreeLayoutOrder,
      normalizeLayoutTree,
      collectLayoutModules,
      swapLayoutTreeModules,
      insertLayoutModuleAtEdge,
      insertLayoutModuleAtRootEdge,
      layoutDropIntent,
      layoutRootDropIntent,
      layoutDropPreviewRect,
    },
  };
})();

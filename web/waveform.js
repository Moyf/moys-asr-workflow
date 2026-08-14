// Framework-neutral waveform runtime. Browser/Tauri-specific file access is
// isolated behind setPayload/processFile and callbacks supplied by editor.js.
(function () {
  'use strict';

  const SETTINGS_KEY = 'moy.asr.waveform.settings.v1';
  const SCHEMA = 'moy.asr.waveform.v1';
  const ENCODING = 'i8-minmax-base64';
  const SPECTRAL_SCHEMA = 'moy.asr.spectral.v1';
  const SPECTRAL_ENCODING = 'u16-freq-density-base64';
  const WORKSPACE_SCHEMA = 'moy.asr.editor.workspace.v1';
  // 渲染器预设：classic / wave-right 由专属 CSS 网格渲染；custom 由 layoutTree 渲染
  // （大荧幕布局与用户保存的自定义工作区都以树渲染）。
  const RENDERER_PRESETS = ['classic', 'wave-right', 'custom'];
  // 内置工作区 id：下拉框可选项；custom 预设都由各自的布局树渲染。
  const BUILTIN_WORKSPACE_IDS = ['classic', 'wave-right', 'three-fold', 'cinema'];
  const MODULE_IDS = ['player', 'panel', 'cues', 'wave'];
  const MODULE_LABELS = { player: '视频', panel: '当前字幕', cues: '字幕列表', wave: '波形' };
  const DEFAULT_MODULE_ORDER = ['player', 'panel', 'cues', 'wave'];
  const DEFAULT_RIGHT_LAYOUT_TREE = {
    type: 'split', direction: 'row', ratio: 30,
    children: [
      {
        type: 'split', direction: 'column', ratio: 42,
        children: [
          { type: 'module', id: 'player' },
          {
            type: 'split', direction: 'column', ratio: 20,
            children: [{ type: 'module', id: 'panel' }, { type: 'module', id: 'cues' }],
          },
        ],
      },
      { type: 'module', id: 'wave' },
    ],
  };
  // 大荧幕布局：左上大视频区、右上当前字幕/字幕列表、底部整行波形；以 custom 渲染器渲染。
  const CINEMA_SCREEN_LAYOUT_TREE = {
    type: 'split', direction: 'column', ratio: 72.711956653046,
    children: [
      {
        type: 'split', direction: 'row', ratio: 55.207499921561244,
        children: [
          { type: 'module', id: 'player' },
          {
            type: 'split', direction: 'column', ratio: 20,
            children: [{ type: 'module', id: 'panel' }, { type: 'module', id: 'cues' }],
          },
        ],
      },
      { type: 'module', id: 'wave' },
    ],
  };
  // 字幕列表编辑（内置 classic 工作区）：左侧上「视频|当前字幕」、下多行波形，右侧整列字幕列表。
  const SUBTITLE_LIST_EDIT_LAYOUT_TREE = {
    type: 'split', direction: 'row', ratio: 55,
    children: [
      {
        type: 'split', direction: 'column', ratio: 43,
        children: [
          {
            type: 'split', direction: 'row', ratio: 63,
            children: [{ type: 'module', id: 'player' }, { type: 'module', id: 'panel' }],
          },
          { type: 'module', id: 'wave' },
        ],
      },
      { type: 'module', id: 'cues' },
    ],
  };
  // 三折叠布局：左侧上下为当前字幕/视频，右侧上下为字幕列表/波形。
  const THREE_FOLD_LAYOUT_TREE = {
    type: 'split', direction: 'row', ratio: 28.32664152704568,
    children: [
      {
        type: 'split', direction: 'column', ratio: 29.702416354679702,
        children: [{ type: 'module', id: 'panel' }, { type: 'module', id: 'player' }],
      },
      {
        type: 'split', direction: 'row', ratio: 34.57890198332854,
        children: [{ type: 'module', id: 'cues' }, { type: 'module', id: 'wave' }],
      },
    ],
  };
  const CLASSIC_LAYOUT_EDIT_TREE = {
    type: 'split', direction: 'column', ratio: 38,
    children: [
      { type: 'module', id: 'player' },
      {
        type: 'split', direction: 'column', ratio: 24,
        children: [
          { type: 'module', id: 'panel' },
          {
            type: 'split', direction: 'row', ratio: 50,
            children: [{ type: 'module', id: 'wave' }, { type: 'module', id: 'cues' }],
          },
        ],
      },
    ],
  };
  const LAYOUT_DIRECTIONS = ['left', 'right', 'top', 'bottom'];
  const MODULE_EDGE_DROP_RATIO = 0.24;
  const ROOT_EDGE_DROP_RATIO = 0.055;
  const ROOT_EDGE_DROP_MIN_PX = 24;
  const ROOT_EDGE_DROP_MAX_PX = 48;
  const ZOOM_PRESETS = [5, 10, 20, 30, 60];
  const ROW_PRESETS = [5, 10, 20, 30];
  const ROW_HEIGHT_PRESETS = [64, 80, 96, 120, 144, 168];
  const ROW_GAP = 10;
  const SPLIT_FLASH_DURATION_MS = 720;
  // 多行波形保留视口前后几行，字幕快捷键跨行时可以直接复用已绘制的行。
  // 行本身仍按可视区增量创建，不会把整段长媒体一次性放进 DOM。
  const MULTI_ROW_BUFFER = 4;
  const MIN_CUE_MS = 100;
  const MIN_WAVEFORM_SCALE = 0.25;
  const MAX_WAVEFORM_SCALE = 6;
  const SNAP_MS = 80;
  const ROUND_MS = 10;
  const BROWSER_DECODE_LIMIT = 512 * 1024 * 1024;
  const BROWSER_PCM_ESTIMATE_LIMIT = 768 * 1024 * 1024;
  // 右侧整列波形布局：当前字幕编辑区略收紧，把空间让给字幕列表。
  const DEFAULT_LAYOUT_ROWS = [42, 16, 42];
  const DEFAULT_SETTINGS = {
    mode: 'multi',
    layout: 'wave-right',
    visibleSeconds: 20,
    secondsPerRow: 10,
    rowHeight: 120,
    side: 'left',
    splitPercent: 60,
    layoutColumnPercent: 30,
    layoutRows: [...DEFAULT_LAYOUT_ROWS],
    layoutTree: DEFAULT_RIGHT_LAYOUT_TREE,
    layoutEditing: false,
    waveformScale: 1,
    disabledDisplay: 'dim',
    showGroupBadges: true,
    dragPlayhead: true,
    spectralColor: false,
  };
  // 内置工作区默认的列表/编辑区显示开关：列表默认显示表情包列。
  const DEFAULT_EDITOR_DISPLAY = {
    cueListShowIndex: true, cueListShowTime: true, cueListShowSticker: true, cueListShowCharcount: true,
    cueEditorShowNavigation: false, cueEditorShowTimeActions: false, cueEditorShowSticker: false,
  };
  const SUBTITLE_LIST_EDITOR_DISPLAY = {
    ...DEFAULT_EDITOR_DISPLAY,
    cueEditorShowNavigation: true, cueEditorShowTimeActions: true, cueEditorShowSticker: true,
  };
  const CINEMA_SCREEN_EDITOR_DISPLAY = {
    ...DEFAULT_EDITOR_DISPLAY,
    cueEditorShowTimeActions: true,
  };
  const THREE_FOLD_EDITOR_DISPLAY = {
    ...DEFAULT_EDITOR_DISPLAY,
    cueListShowTime: false,
    cueEditorShowNavigation: true, cueEditorShowTimeActions: true, cueEditorShowSticker: true,
  };
  const BUILTIN_WORKSPACES = {
    // 字幕列表编辑（界面显示名）：聚焦右侧整列字幕列表，以 custom 渲染器渲染。
    classic: {
      preset: 'custom', waveformMode: 'multi', splitPercent: 60, columnPercent: 36,
      rows: [42, 18, 40], tree: SUBTITLE_LIST_EDIT_LAYOUT_TREE,
      editorDisplay: SUBTITLE_LIST_EDITOR_DISPLAY,
    },
    'wave-right': {
      preset: 'wave-right', waveformMode: 'multi', splitPercent: 60, columnPercent: 30,
      rows: [42, 16, 42], tree: DEFAULT_RIGHT_LAYOUT_TREE,
      editorDisplay: DEFAULT_EDITOR_DISPLAY,
    },
    'three-fold': {
      preset: 'custom', waveformMode: 'multi',
      waveformSettings: {
        visibleSeconds: 20, secondsPerRow: 10, rowHeight: 120, waveformScale: 4,
        side: 'left', disabledDisplay: 'dim', showGroupBadges: true, dragPlayhead: true,
      },
      splitPercent: 60, columnPercent: 30, rows: [42, 16, 42], tree: THREE_FOLD_LAYOUT_TREE,
      editorDisplay: THREE_FOLD_EDITOR_DISPLAY,
    },
    // 大荧幕布局：左上大视频区、右上当前字幕/字幕列表、底部整行单行波形；以 custom 渲染器渲染。
    cinema: {
      preset: 'custom', waveformMode: 'basic',
      waveformSettings: {
        visibleSeconds: 20, secondsPerRow: 10, rowHeight: 120, waveformScale: 5.5,
        side: 'left', disabledDisplay: 'dim', showGroupBadges: true, dragPlayhead: true,
      },
      splitPercent: 60, columnPercent: 36, rows: [42, 18, 40], tree: CINEMA_SCREEN_LAYOUT_TREE,
      editorDisplay: CINEMA_SCREEN_EDITOR_DISPLAY,
    },
  };
  const PALETTE = {
    yellow: '#f1c40f',
    green: '#2ecc71',
    red: '#e74c3c',
    purple: '#9b59b6',
    blue: '#168cff',
  };

  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  // 组序号徽章：颜色与表情包分组彼此独立，因此同一条字幕可同时拥有两枚徽章。
  // 颜色组大小 <2 时不显示；表情包即使只有单条也显示 🦊 作为非视觉化标记。
  function computeGroupBadges(segments) {
    const badges = new Map();
    const apply = (type, headField, refField) => {
      // 每个波形行都会使用同一份徽章数据；按 head 建索引，避免每个 head
      // 再扫描整个字幕数组，长工程或多行缓存下可从 O(N²) 降到 O(N)。
      const membersByHead = new Map();
      segments.forEach((seg, headIdx) => {
        if (seg[headField]) membersByHead.set(headIdx, [headIdx]);
      });
      segments.forEach((seg, idx) => {
        const headIdx = seg[refField]?.headIdx;
        const members = membersByHead.get(headIdx);
        if (members && headIdx !== idx) members.push(idx);
      });
      membersByHead.forEach((members) => {
        if (type === 'color' && members.length < 2) return;
        members.forEach((idx, i) => {
          const cueBadges = badges.get(idx) || [];
          cueBadges.push({ type, ordinal: i + 1, total: members.length });
          badges.set(idx, cueBadges);
        });
      });
    };
    apply('color', 'color', 'color_ref');
    apply('sticker', 'sticker', 'sticker_ref');
    return badges;
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

  function normalizeModuleOrder(value) {
    return Array.isArray(value) && value.length === MODULE_IDS.length
      && value.every((id) => MODULE_IDS.includes(id))
      && new Set(value).size === MODULE_IDS.length
      ? [...value] : [...DEFAULT_MODULE_ORDER];
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

  function normalizeLayoutData(value) {
    const source = value && typeof value === 'object' ? value : {};
    const preset = RENDERER_PRESETS.includes(source.preset) ? source.preset : DEFAULT_SETTINGS.layout;
    const rows = normalizeLayoutRows(source.rows);
    const columnPercent = clamp(Number(source.columnPercent) || DEFAULT_SETTINGS.layoutColumnPercent, 30, 75);
    const splitPercent = clamp(Number(source.splitPercent) || DEFAULT_SETTINGS.splitPercent, 35, 75);
    const waveformMode = ['basic', 'multi'].includes(source.waveformMode) ? source.waveformMode : null;
    const rawWaveformSettings = source.waveformSettings;
    const waveformSettings = rawWaveformSettings && typeof rawWaveformSettings === 'object' ? {
      ...(ZOOM_PRESETS.includes(Number(rawWaveformSettings.visibleSeconds))
        ? { visibleSeconds: Number(rawWaveformSettings.visibleSeconds) } : {}),
      ...(ROW_PRESETS.includes(Number(rawWaveformSettings.secondsPerRow))
        ? { secondsPerRow: Number(rawWaveformSettings.secondsPerRow) } : {}),
      ...(ROW_HEIGHT_PRESETS.includes(Number(rawWaveformSettings.rowHeight))
        ? { rowHeight: Number(rawWaveformSettings.rowHeight) } : {}),
      ...(Number.isFinite(Number(rawWaveformSettings.waveformScale))
        ? { waveformScale: clampWaveformScale(Number(rawWaveformSettings.waveformScale)) } : {}),
      ...(rawWaveformSettings.side === 'left' || rawWaveformSettings.side === 'right'
        ? { side: rawWaveformSettings.side } : {}),
      ...(rawWaveformSettings.disabledDisplay === 'hidden' || rawWaveformSettings.disabledDisplay === 'dim'
        ? { disabledDisplay: rawWaveformSettings.disabledDisplay } : {}),
      ...(typeof rawWaveformSettings.showGroupBadges === 'boolean'
        ? { showGroupBadges: rawWaveformSettings.showGroupBadges } : {}),
      ...(typeof rawWaveformSettings.dragPlayhead === 'boolean'
        ? { dragPlayhead: rawWaveformSettings.dragPlayhead } : {}),
    } : null;
    const candidateTree = normalizeLayoutTree(source.tree);
    const tree = isCompleteLayoutTree(candidateTree)
      ? candidateTree
      : cloneLayoutTree(preset === 'classic' ? CLASSIC_LAYOUT_EDIT_TREE : DEFAULT_RIGHT_LAYOUT_TREE);
    return {
      schema: WORKSPACE_SCHEMA,
      preset,
      waveformMode,
      waveformSettings,
      splitPercent,
      columnPercent,
      rows,
      tree,
    };
  }

  function swapLayoutModuleOrder(order, sourceId, targetId) {
    const next = normalizeModuleOrder(order);
    const sourceIndex = next.indexOf(sourceId);
    const targetIndex = next.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return next;
    [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
    return next;
  }

  function readSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      const layoutData = normalizeLayoutData({
        preset: parsed.layout,
        splitPercent: parsed.splitPercent,
        columnPercent: parsed.layoutColumnPercent,
        rows: parsed.layoutRows,
        tree: parsed.layoutTree,
      });
      return {
        ...DEFAULT_SETTINGS,
        mode: ['basic', 'multi'].includes(parsed.mode) ? parsed.mode : DEFAULT_SETTINGS.mode,
        layout: layoutData.preset,
        visibleSeconds: ZOOM_PRESETS.includes(Number(parsed.visibleSeconds))
          ? Number(parsed.visibleSeconds) : DEFAULT_SETTINGS.visibleSeconds,
        secondsPerRow: ROW_PRESETS.includes(Number(parsed.secondsPerRow))
          ? Number(parsed.secondsPerRow) : DEFAULT_SETTINGS.secondsPerRow,
        rowHeight: ROW_HEIGHT_PRESETS.includes(Number(parsed.rowHeight))
          ? Number(parsed.rowHeight) : DEFAULT_SETTINGS.rowHeight,
        side: parsed.side === 'right' ? 'right' : 'left',
        splitPercent: layoutData.splitPercent,
        layoutColumnPercent: layoutData.columnPercent,
        layoutRows: layoutData.rows,
        layoutTree: layoutData.tree,
        layoutEditing: false,
        waveformScale: clampWaveformScale(Number(parsed.waveformScale) || DEFAULT_SETTINGS.waveformScale),
        disabledDisplay: parsed.disabledDisplay === 'hidden' ? 'hidden' : 'dim',
        showGroupBadges: parsed.showGroupBadges !== false,
        dragPlayhead: parsed.dragPlayhead !== false,
        spectralColor: parsed.spectralColor === true,
      };
    } catch (_) {
      return {
        ...DEFAULT_SETTINGS,
        layoutTree: cloneLayoutTree(DEFAULT_RIGHT_LAYOUT_TREE),
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

  // Decode a moy.asr.spectral.v1 payload into {freq, density, sample_rate,
  // division, densityMax}, or null when the payload is absent / unknown.
  // Each spectral sample is 4 bytes: freq u16 LE, density u16 LE.
  function decodeSpectralPayload(payload) {
    if (!payload || payload.schema !== SPECTRAL_SCHEMA || payload.encoding !== SPECTRAL_ENCODING) {
      return null;
    }
    if (!Number.isInteger(payload.peak_count) || payload.peak_count <= 0) return null;
    if (!Number.isInteger(payload.sample_rate) || payload.sample_rate <= 0) return null;
    if (!Number.isInteger(payload.division) || payload.division <= 0) return null;
    if (typeof payload.data !== 'string') return null;
    let binary;
    try {
      binary = atob(payload.data);
    } catch (_) {
      return null;
    }
    if (binary.length !== payload.peak_count * 4) return null;
    const freq = new Uint16Array(payload.peak_count);
    const density = new Uint16Array(payload.peak_count);
    let densityMax = 1;
    for (let i = 0; i < payload.peak_count; i++) {
      const offset = i * 4;
      freq[i] = binary.charCodeAt(offset) | (binary.charCodeAt(offset + 1) << 8);
      const d = binary.charCodeAt(offset + 2) | (binary.charCodeAt(offset + 3) << 8);
      density[i] = d;
      if (d > densityMax) densityMax = d;
    }
    return {
      freq,
      density,
      densityMax,
      sample_rate: payload.sample_rate,
      division: payload.division,
    };
  }

  // REAPER spectral coloring from the raw 15-bit freq_field (0-32767) and the
  // 14-bit density (0=noise, 16383=perfect tone). Low→high frequency sweeps
  // red→pink/green→orange/yellow; saturation & lightness rise with tonality.
  function freqColor(freq, density, densityMax) {
    let hue;
    if (freq < 300) {
      hue = (freq / 300) * 30; // red (0°) to brown (30°)
    } else if (freq < 1000) {
      hue = 300 + ((freq - 300) / 700) * 180; // pink (300°) to green (120°)
      if (hue >= 360) hue -= 360;
    } else if (freq < 3000) {
      hue = 120 - ((freq - 1000) / 2000) * 90; // green (120°) to orange (30°)
    } else {
      hue = 30 + Math.min((freq - 3000) / 5000, 1) * 30; // orange (30°) to yellow (60°)
    }
    const d = clamp(density / Math.max(1, densityMax), 0, 1);
    const sat = 0.3 + 0.7 * d;
    const light = 0.4 + 0.4 * d;
    return `hsl(${hue.toFixed(1)}, ${(sat * 100).toFixed(1)}%, ${(light * 100).toFixed(1)}%)`;
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

  function wheelScrollDelta(event) {
    const deltaY = Number(event?.deltaY) || 0;
    const deltaX = Number(event?.deltaX) || 0;
    // macOS may remap Shift+wheel's vertical movement to deltaX.
    return deltaY || deltaX;
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

  function snapshotTiming(segment) {
    return {
      start: Number(segment.start),
      end: Number(segment.end),
      items: Array.isArray(segment.items)
        ? segment.items.map((item) => ({ ...item })) : segment.items,
    };
  }

  function isAttached(left, right) {
    return !!left && !!right && Number(left.end) === Number(right.start);
  }

  function normalizedIndices(segments, indices) {
    return [...new Set(Array.from(indices || [])
      .map((idx) => Number(idx))
      .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < segments.length))]
      .sort((a, b) => a - b);
  }

  // Keyboard movement is a small, discrete counterpart to moving a waveform
  // block. When the selected range is attached to a neighboring cue, the
  // shared boundary follows the moved range: moving away expands the neighbor
  // and moving toward it compresses the neighbor. Alt keeps both neighbors
  // untouched, while the normal no-overlap and minimum-duration limits still
  // apply.
  function planMoveStep(segments, indices, deltaMs, durationMs, {
    sticky = true,
    minDuration = MIN_CUE_MS,
  } = {}) {
    const selectedIndices = normalizedIndices(segments, indices);
    if (!selectedIndices.length) {
      return { changed: false, appliedDelta: 0, indices: [], affectedIndices: [] };
    }
    const selected = new Set(selectedIndices);
    const originals = new Map(selectedIndices.map((idx) => [idx, snapshotTiming(segments[idx])]));
    const attachments = [];
    const attachmentOriginals = new Map();
    const previousAttachments = [];
    const previousAttachmentOriginals = new Map();
    let minDelta = -Infinity;
    let maxDelta = Infinity;
    const timelineDuration = Number(durationMs);

    for (const idx of selectedIndices) {
      const original = originals.get(idx);
      minDelta = Math.max(minDelta, -original.start);
      if (Number.isFinite(timelineDuration) && timelineDuration > 0) {
        maxDelta = Math.min(maxDelta, timelineDuration - original.end);
      }
      const previous = segments[idx - 1];
      if (previous && !selected.has(idx - 1)) {
        if (sticky && isAttached(previous, segments[idx])) {
          const previousOriginal = snapshotTiming(previous);
          previousAttachments.push({ index: idx, previousIndex: idx - 1 });
          previousAttachmentOriginals.set(idx - 1, previousOriginal);
          minDelta = Math.max(minDelta, previousOriginal.start + minDuration - original.start);
        } else {
          minDelta = Math.max(minDelta, Number(previous.end) - original.start);
        }
      }
      const next = segments[idx + 1];
      if (!next || selected.has(idx + 1)) continue;
      if (sticky && isAttached(segments[idx], next)) {
        const nextOriginal = snapshotTiming(next);
        attachments.push({ index: idx, nextIndex: idx + 1 });
        attachmentOriginals.set(idx + 1, nextOriginal);
        // The next cue's start follows the selected cue's end, so its end
        // and minimum duration limit how far the shared boundary can move.
        maxDelta = Math.min(maxDelta, nextOriginal.end - minDuration - original.end);
      } else {
        // An unlinked following cue stays fixed and may not be overlapped.
        maxDelta = Math.min(maxDelta, Number(next.start) - original.end);
      }
    }

    const requested = Number(deltaMs);
    const rounded = Number.isFinite(requested) ? roundMs(requested) : 0;
    const appliedDelta = clamp(rounded, minDelta, maxDelta);
    const affectedIndices = [...selectedIndices];
    attachments.forEach(({ nextIndex }) => affectedIndices.push(nextIndex));
    previousAttachments.forEach(({ previousIndex }) => affectedIndices.push(previousIndex));
    return {
      changed: appliedDelta !== 0,
      appliedDelta,
      indices: selectedIndices,
      affectedIndices: [...new Set(affectedIndices)].sort((a, b) => a - b),
      originals,
      attachments,
      attachmentOriginals,
      previousAttachments,
      previousAttachmentOriginals,
    };
  }

  function applyMoveStep(segments, indices, deltaMs, durationMs, options = {}) {
    const plan = planMoveStep(segments, indices, deltaMs, durationMs, options);
    if (!plan.changed) return plan;
    const delta = plan.appliedDelta;
    plan.indices.forEach((idx) => {
      const original = plan.originals.get(idx);
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
    });
    plan.attachments.forEach(({ nextIndex }) => {
      const original = plan.attachmentOriginals.get(nextIndex);
      const segment = segments[nextIndex];
      segment.start = original.start + delta;
      segment.items = remapItems(original.items, original.start, original.end, segment.start, segment.end);
    });
    plan.previousAttachments.forEach(({ previousIndex }) => {
      const original = plan.previousAttachmentOriginals.get(previousIndex);
      const segment = segments[previousIndex];
      segment.end = original.end + delta;
      segment.items = remapItems(original.items, original.start, original.end, segment.start, segment.end);
    });
    return plan;
  }

  function planBoundaryStep(segments, index, edge, deltaMs, durationMs, {
    sticky = true,
    minDuration = MIN_CUE_MS,
  } = {}) {
    const target = segments[index];
    if (!target || (edge !== 'start' && edge !== 'end')) {
      return { changed: false, appliedDelta: 0, indices: [], affectedIndices: [] };
    }
    const previous = segments[index - 1];
    const next = segments[index + 1];
    const linkedNeighbor = edge === 'start'
      ? (sticky && isAttached(previous, target) ? previous : null)
      : (sticky && isAttached(target, next) ? next : null);
    const current = edge === 'start' ? Number(target.start) : Number(target.end);
    const requested = Number(deltaMs);
    const rounded = Number.isFinite(requested) ? roundMs(requested) : 0;
    let lower;
    let upper;
    if (edge === 'start') {
      lower = linkedNeighbor ? Number(previous.start) + minDuration : Number(previous?.end ?? 0);
      upper = Number(target.end) - minDuration;
    } else {
      lower = Number(target.start) + minDuration;
      upper = linkedNeighbor
        ? Number(next.end) - minDuration
        : Number(next?.start ?? durationMs);
      if (!Number.isFinite(upper) || upper <= 0) upper = Infinity;
    }
    const appliedDelta = clamp(current + rounded, lower, upper) - current;
    const affectedIndices = linkedNeighbor
      ? [index, edge === 'start' ? index - 1 : index + 1].sort((a, b) => a - b)
      : [index];
    const snapshots = new Map(affectedIndices.map((idx) => [idx, snapshotTiming(segments[idx])]));
    return {
      changed: appliedDelta !== 0,
      appliedDelta,
      index,
      edge,
      linked: !!linkedNeighbor,
      neighborIndex: linkedNeighbor ? (edge === 'start' ? index - 1 : index + 1) : -1,
      affectedIndices,
      snapshots,
    };
  }

  function applyBoundaryStep(segments, index, edge, deltaMs, durationMs, options = {}) {
    const plan = planBoundaryStep(segments, index, edge, deltaMs, durationMs, options);
    if (!plan.changed) return plan;
    const target = segments[plan.index];
    const oldTarget = plan.snapshots.get(plan.index);
    const value = (plan.edge === 'start' ? oldTarget.start : oldTarget.end) + plan.appliedDelta;
    if (plan.edge === 'start') {
      target.start = value;
      target.items = remapItems(oldTarget.items, oldTarget.start, oldTarget.end, target.start, target.end);
      if (plan.linked) {
        const previous = segments[plan.neighborIndex];
        const oldPrevious = plan.snapshots.get(plan.neighborIndex);
        previous.end = value;
        previous.items = remapItems(oldPrevious.items, oldPrevious.start, oldPrevious.end, previous.start, previous.end);
      }
    } else {
      target.end = value;
      target.items = remapItems(oldTarget.items, oldTarget.start, oldTarget.end, target.start, target.end);
      if (plan.linked) {
        const next = segments[plan.neighborIndex];
        const oldNext = plan.snapshots.get(plan.neighborIndex);
        next.start = value;
        next.items = remapItems(oldNext.items, oldNext.start, oldNext.end, next.start, next.end);
      }
    }
    return plan;
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
        // 跨越切点的 item 归入更近的一侧，并把时间钳到该侧边界内，
        // 避免 item 越出所属段导致保存校验失败。
        if (splitMs - itemStart <= itemEnd - splitMs) {
          leftItems.push({ ...item, end: Math.min(itemEnd, splitMs) });
        } else {
          rightItems.push({ ...item, start: Math.max(itemStart, splitMs) });
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
    return items.map((item) => {
      // 等比缩放后钳回段内，并保证 end > start（防止取整后出现 0 长词块）。
      const mappedStart = roundMs(newStart + ((item.start - oldStart) / oldDuration) * newDuration);
      const mappedEnd = roundMs(newStart + ((item.end - oldStart) / oldDuration) * newDuration);
      let start = Math.min(Math.max(mappedStart, newStart), newEnd);
      const end = Math.min(Math.max(mappedEnd, start + 1), newEnd);
      if (end <= start) start = Math.max(newStart, end - 1);
      return { ...item, start, end };
    });
  }

  // 与字幕列表保持一致：相邻字幕共用边界时，边界属于后一条；间隙和最后一条
  // 的结束时刻仍沿用当前字幕作为播放头对应项。
  function isActiveCueAtTime(segments, index, timeMs, skipDisabled = true) {
    const segment = segments[index];
    if (!segment || (skipDisabled && segment.disabled) || timeMs < Number(segment.start)) return false;
    let next = null;
    for (let nextIndex = index + 1; nextIndex < segments.length; nextIndex += 1) {
      if (!skipDisabled || !segments[nextIndex]?.disabled) {
        next = segments[nextIndex];
        break;
      }
    }
    return timeMs < Number(segment.end) || !next || Number(next.start) > timeMs;
  }

  function findActiveCueIndex(segments, timeMs, skipDisabled = true) {
    return segments.findIndex((_, index) => isActiveCueAtTime(segments, index, timeMs, skipDisabled));
  }

  class WaveformEditor {
    constructor(options) {
      this.options = options;
      this.settings = readSettings();
      this.payload = null;
      this.peaks = null;
      this.spectral = null;
      this.reapeaksPayload = null;
      this.reapeaksPeaks = null;
      this.player = null;
      this.mediaAvailable = false;
      this.basicWindowStartMs = 0;
      this.manualFollowUntil = 0;
      this.multiRange = [-1, -1];
      this.activeIndex = -1;
      this.drag = null;
      this.createCueDrag = null;
      this.gapRangeDrag = null;
      this.gapBoundaryDrag = null;
      this.suppressGapClickUntil = 0;
      this.autoScrolling = false;
      this.resizeFrame = 0;
      // 字幕快捷键会在很短时间内连续请求定位；复用滚动事件已有的
      // rAF 合并，避免每个按键都强制重建可视行和 Canvas。
      this.multiVisibleFrame = 0;
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
      this.rowHeightSelect = document.getElementById('waveform-row-height');
      this.showGroupBadgesToggle = document.getElementById('waveform-show-group-badges');
      this.dragPlayheadToggle = document.getElementById('waveform-drag-playhead');
      this.spectralColorToggle = document.getElementById('waveform-spectral-color');
      this.sideSelect = document.getElementById('waveform-side');
      this.disabledDisplaySelect = document.getElementById('waveform-disabled-display');
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
      this.rowHeightSelect?.addEventListener('change', () => {
        this.settings.rowHeight = Number(this.rowHeightSelect.value);
        saveSettings(this.settings);
        this.render();
      });
      this.showGroupBadgesToggle?.addEventListener('change', () => {
        this.settings.showGroupBadges = this.showGroupBadgesToggle.checked;
        saveSettings(this.settings);
        this.render();
      });
      if (this.dragPlayheadToggle) this.dragPlayheadToggle.checked = this.settings.dragPlayhead === true;
      this.dragPlayheadToggle?.addEventListener('change', () => {
        this.settings.dragPlayhead = this.dragPlayheadToggle.checked;
        saveSettings(this.settings);
      });
      if (this.spectralColorToggle) this.spectralColorToggle.checked = this.settings.spectralColor === true;
      this.spectralColorToggle?.addEventListener('change', () => {
        this.settings.spectralColor = this.spectralColorToggle.checked;
        saveSettings(this.settings);
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
        this.refreshCueOverlay();
      });
      this.layoutEditToggle?.addEventListener('click', () => this.toggleLayoutEditMode());
      this.layoutResetButton?.addEventListener('click', () => this.resetLayout());
      this.scroll.addEventListener('wheel', (event) => this.handleWheel(event), { passive: false });
      this.scroll.addEventListener('scroll', (event) => {
        if (!this.isMultiMode()) return;
        if (event.isTrusted && !this.autoScrolling) this.manualFollowUntil = Date.now() + 3000;
        this.scheduleMultiVisible();
      });
      this.bindDivider();
      this.bindLayoutResizers();
    }

    showPointerLine(event, row, marker) {
      if (!row || !marker) return;
      const rect = row.getBoundingClientRect();
      const left = clamp(event.clientX - rect.left, 0, rect.width);
      marker.style.left = `${left}px`;
      marker.hidden = false;
    }

    hidePointerLine(marker) {
      if (marker) marker.hidden = true;
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
          this.layoutDragging = true;
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
          const changed = dividerDrag.changed;
          dividerDrag = null;
          divider.classList.remove('dragging');
          try { divider.releasePointerCapture(event.pointerId); } catch (_) {}
          this.layoutDragging = false;
          // 松手后按最终尺寸做一次清晰重绘
          if (changed) this.scheduleRender();
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
          this.layoutDragging = true;
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
          const changed = drag.changed;
          drag = null;
          resizer.classList.remove('dragging');
          try { resizer.releasePointerCapture?.(event.pointerId); } catch (_) {}
          this.layoutDragging = false;
          // 松手后按最终尺寸做一次清晰重绘
          if (changed) this.scheduleRender();
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
        'waveform-basic', 'waveform-multi',
        'layout-classic', 'layout-wave-right', 'layout-custom',
        'waveform-right', 'layout-editing',
      );
      this.workspace.classList.add(`waveform-${this.settings.mode}`);
      this.workspace.classList.add(`layout-${this.settings.layout}`);
      if (this.settings.layout === 'classic' && this.settings.side === 'right') {
        this.workspace.classList.add('waveform-right');
      }
      if (this.settings.layoutEditing) this.workspace.classList.add('layout-editing');
      this.applyLayoutVariables();
      this.applyCustomLayoutTree();
      document.querySelectorAll('[data-waveform-mode]').forEach((button) => {
        button.classList.toggle('active', button.dataset.waveformMode === this.settings.mode);
      });
      this.windowLabel.textContent = `${this.settings.visibleSeconds} 秒`;
      if (this.waveformScaleLabel) this.waveformScaleLabel.textContent = `×${parseFloat(this.settings.waveformScale.toFixed(2))}`;
      this.secondsPerRowSelect.value = String(this.settings.secondsPerRow);
      if (this.rowHeightSelect) this.rowHeightSelect.value = String(this.settings.rowHeight);
      if (this.sideSelect) this.sideSelect.value = this.settings.side;
      if (this.disabledDisplaySelect) this.disabledDisplaySelect.value = this.settings.disabledDisplay;
      if (this.showGroupBadgesToggle) this.showGroupBadgesToggle.checked = this.settings.showGroupBadges !== false;
      if (this.dragPlayheadToggle) this.dragPlayheadToggle.checked = this.settings.dragPlayhead === true;
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
      document.getElementById('waveform-zoom-in').disabled = !basicMode;
      document.getElementById('waveform-zoom-out').disabled = !basicMode;
      this.secondsPerRowSelect.disabled = !multiMode;
      if (this.rowHeightSelect) this.rowHeightSelect.disabled = !multiMode;
      // 「显示窗口」仅基础模式有意义；「每行长度」「每行高度」仅多行模式有意义。
      const windowSetting = document.getElementById('waveform-window-setting');
      const secondsPerRowSetting = document.getElementById('waveform-seconds-per-row-setting');
      const rowHeightSetting = document.getElementById('waveform-row-height-setting');
      if (windowSetting) windowSetting.hidden = !basicMode;
      if (secondsPerRowSetting) secondsPerRowSetting.hidden = !multiMode;
      if (rowHeightSetting) rowHeightSetting.hidden = !multiMode;
    }

    setMode(mode) {
      if (!['basic', 'multi'].includes(mode) || mode === this.settings.mode) return;
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
      this.setStatus(tool === 'razor' ? '分割工具：点击字幕块在指针位置拆分' : '选择工具');
    }

    getTool() {
      return this.tool;
    }

    // 切换到内置工作区：应用其渲染器、波形模式与完整布局树。
    setLayout(workspaceId) {
      const builtin = BUILTIN_WORKSPACES[workspaceId];
      if (!builtin) return;
      const normalized = normalizeLayoutData(builtin);
      this.settings.layout = normalized.preset;
      if (normalized.waveformMode) this.settings.mode = normalized.waveformMode;
      if (normalized.waveformSettings) Object.assign(this.settings, normalized.waveformSettings);
      this.settings.splitPercent = normalized.splitPercent;
      this.settings.layoutColumnPercent = normalized.columnPercent;
      this.settings.layoutRows = normalized.rows;
      this.settings.layoutTree = normalized.tree;
      this.settings.layoutEditing = false;
      saveSettings(this.settings);
      this.applyLayout();
      this.render();
    }

    toggleLayoutEditMode() {
      if (this.settings.layout !== 'custom') {
        this.settings.layout = 'custom';
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

    getRowHeight() {
      return this.settings.rowHeight;
    }

    getMaxRowHeight() {
      return ROW_HEIGHT_PRESETS[ROW_HEIGHT_PRESETS.length - 1];
    }

    setRowHeight(value) {
      const next = Number(value);
      if (!ROW_HEIGHT_PRESETS.includes(next)) return false;
      if (this.settings.rowHeight === next) return true;
      this.settings.rowHeight = next;
      if (this.rowHeightSelect) this.rowHeightSelect.value = String(next);
      this.multiRange = [-1, -1];
      saveSettings(this.settings);
      this.render();
      return true;
    }

    isCustomLayout() {
      return this.settings.layout === 'custom' && this.settings.layoutEditing;
    }

    isPresetResizableLayout() {
      return this.settings.layout === 'wave-right';
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
          if (!this.isCustomLayout()) {
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
          if (!this.isCustomLayout() || !this.layoutDragSource) return;
          if (layoutRootDropIntent(this.workspace.getBoundingClientRect(), event.clientX, event.clientY)) return;
          if (this.layoutDragSource === id) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const intent = layoutDropIntent(element.getBoundingClientRect(), event.clientX, event.clientY);
          this.layoutDropIntent = { ...intent, targetId: id, sourceId: this.layoutDragSource };
          this.showLayoutDropPreview(element, id, this.layoutDragSource, intent);
        });
        element.addEventListener('drop', (event) => {
          if (!this.isCustomLayout()) return;
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
        if (!this.isCustomLayout() || !this.layoutDragSource || event.defaultPrevented) return;
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
        if (!this.isCustomLayout() || event.defaultPrevented) return;
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
      const tree = isCompleteLayoutTree(this.settings.layoutTree)
        ? this.settings.layoutTree
        : cloneLayoutTree(DEFAULT_RIGHT_LAYOUT_TREE);
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

    ensureCustomLayoutRoot() {
      if (this.customLayoutRoot?.isConnected) return this.customLayoutRoot;
      this.customLayoutRoot = document.createElement('div');
      this.customLayoutRoot.className = 'free-layout-root';
      this.workspace.insertBefore(this.customLayoutRoot, this.layoutPreview || null);
      return this.customLayoutRoot;
    }

    restoreDirectLayoutModules() {
      const elements = {
        player: this.playerWrap,
        panel: this.panel,
        cues: this.cues,
        wave: this.pane,
      };
      if (!this.customLayoutRoot?.isConnected) return;
      Object.values(elements).forEach((element) => {
        if (element) {
          element.style.gridArea = '';
          this.workspace.insertBefore(element, this.customLayoutRoot);
        }
      });
      this.customLayoutRoot.remove();
      this.customLayoutRoot = null;
      this.renderedCustomLayoutTree = null;
    }

    createCustomLayoutNode(node) {
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
      first.appendChild(this.createCustomLayoutNode(node.children[0]));
      second.appendChild(this.createCustomLayoutNode(node.children[1]));
      split.append(first, divider, second);
      this.applyCustomSplitRatio(first, node.ratio);
      this.bindCustomLayoutDivider(divider, split, first, node);
      return split;
    }

    applyCustomSplitRatio(first, ratio) {
      first.style.flex = `0 0 calc(${clamp(Number(ratio) || 50, 20, 80)}% - 3.5px)`;
    }

    bindCustomLayoutDivider(divider, split, first, node) {
      let drag = null;
      divider.addEventListener('pointerdown', (event) => {
        if (this.settings.layout !== 'custom') return;
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
        this.applyCustomSplitRatio(first, node.ratio);
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

    applyCustomLayoutTree() {
      if (this.settings.layout !== 'custom') {
        this.restoreDirectLayoutModules();
        return;
      }
      const root = this.ensureCustomLayoutRoot();
      const tree = isCompleteLayoutTree(this.settings.layoutTree)
        ? this.settings.layoutTree
        : cloneLayoutTree(DEFAULT_RIGHT_LAYOUT_TREE);
      this.settings.layoutTree = tree;
      if (this.renderedCustomLayoutTree === tree && root.childElementCount) return;
      root.replaceChildren();
      root.appendChild(this.createCustomLayoutNode(tree));
      this.renderedCustomLayoutTree = tree;
    }

    getLayoutData() {
      return {
        schema: WORKSPACE_SCHEMA,
        preset: this.settings.layout,
        waveformMode: this.settings.mode,
        waveformSettings: {
          visibleSeconds: this.settings.visibleSeconds,
          secondsPerRow: this.settings.secondsPerRow,
          rowHeight: this.settings.rowHeight,
          waveformScale: this.settings.waveformScale,
          side: this.settings.side,
          disabledDisplay: this.settings.disabledDisplay,
          showGroupBadges: this.settings.showGroupBadges !== false,
          dragPlayhead: this.settings.dragPlayhead === true,
        },
        splitPercent: this.settings.splitPercent,
        columnPercent: this.settings.layoutColumnPercent,
        rows: [...this.settings.layoutRows],
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
      if (layout.waveformMode) this.settings.mode = layout.waveformMode;
      if (layout.waveformSettings) Object.assign(this.settings, layout.waveformSettings);
      this.settings.splitPercent = layout.splitPercent;
      this.settings.layoutColumnPercent = layout.columnPercent;
      this.settings.layoutRows = layout.rows;
      this.settings.layoutTree = layout.tree;
      this.settings.layoutEditing = layout.preset === 'custom' && !!snapshot.layoutEditing;
      saveSettings(this.settings);
      this.applyLayout();
      this.render();
      return true;
    }

    resetLayout() {
      this.recordLayoutUndo('重置工作区');
      this.setLayout(DEFAULT_SETTINGS.layout);
      this.setStatus('已恢复默认工作区');
    }

    setLayoutData(value) {
      const layout = normalizeLayoutData(value);
      this.settings.layout = layout.preset;
      if (layout.waveformMode) this.settings.mode = layout.waveformMode;
      if (layout.waveformSettings) Object.assign(this.settings, layout.waveformSettings);
      this.settings.splitPercent = layout.splitPercent;
      this.settings.layoutColumnPercent = layout.columnPercent;
      this.settings.layoutRows = layout.rows;
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
      this.refreshCueOverlay();
    }

    revealTime(timeMs, center = true) {
      if (!this.payload) return;
      if (this.settings.mode === 'basic') {
        const windowMs = this.settings.visibleSeconds * 1000;
        const maxStart = Math.max(0, this.durationMs - windowMs);
        const currentStart = clamp(this.basicWindowStartMs, 0, maxStart);
        const relative = (timeMs - currentStart) / Math.max(1, windowMs);
        const needsScroll = relative < 0.2 || relative > 0.8;
        this.basicWindowStartMs = center && needsScroll
          ? clamp(timeMs - windowMs / 2, 0, maxStart)
          : currentStart;
        this.manualFollowUntil = Date.now() + 3000;
        this.renderBasic();
        return;
      }
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowIndex = clamp(Math.floor(timeMs / rowDurationMs), 0, Math.max(0, Math.ceil(this.durationMs / rowDurationMs) - 1));
      const stride = this.settings.rowHeight + ROW_GAP;
      const currentScrollTop = this.scroll.scrollTop;
      const rowTop = rowIndex * stride - currentScrollTop;
      const comfortInset = Math.min(120, Math.max(48, this.scroll.clientHeight * 0.2));
      const rowInComfortZone = (
        rowTop >= comfortInset
        && rowTop + this.settings.rowHeight <= this.scroll.clientHeight - comfortInset
      );
      const scrollTop = center && rowInComfortZone
        ? currentScrollTop
        : (center
          ? rowIndex * stride - Math.max(0, (this.scroll.clientHeight - this.settings.rowHeight) * 0.45)
          : rowIndex * stride);
      const nextScrollTop = Math.max(0, scrollTop);
      this.autoScrolling = Math.abs(nextScrollTop - currentScrollTop) > 0.5;
      if (this.autoScrolling) {
        this.scroll.scrollTo({ top: nextScrollTop, behavior: 'smooth' });
      }
      this.manualFollowUntil = Date.now() + 3000;
      // 目标仍在当前可视行内时，字幕跳转只需要移动播放头；不要因为
      // revealTime() 被调用就重建整组波形 DOM/Canvas。跨行时由滚动事件
      // 或这里的合并任务增量补齐可视行。
      if (rowIndex < this.multiRange[0] || rowIndex > this.multiRange[1] || this.autoScrolling) {
        this.scheduleMultiVisible();
      }
      if (this.autoScrolling) requestAnimationFrame(() => { this.autoScrolling = false; });
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

    getPayload() {
      return this.payload;
    }

    setSpectralPayload(payload) {
      this.spectral = decodeSpectralPayload(payload);
      this.render();
      return this.spectral != null;
    }

    setReapeaksWaveform(payload) {
      this.reapeaksPeaks = decodePayload(payload);
      this.reapeaksPayload = this.reapeaksPeaks ? payload : null;
      this.render();
      return this.reapeaksPayload != null;
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

    scheduleMultiVisible() {
      // 滚动事件一帧内可能触发多次；合并到每帧最多一次可视区渲染
      if (this.multiVisibleFrame) return;
      this.multiVisibleFrame = requestAnimationFrame(() => {
        this.multiVisibleFrame = 0;
        this.renderMultiVisible();
      });
    }

    scheduleBasicRender() {
      // 高频滚轮逐事件全绘单行波形会卡顿；合并到每帧最多一次
      if (this.basicRenderFrame) return;
      this.basicRenderFrame = requestAnimationFrame(() => {
        this.basicRenderFrame = 0;
        this.renderBasic();
      });
    }

    scheduleRefreshCueBlocks() {
      // 高回报率指针设备一帧内触发多次 pointermove；合并到每帧最多一次块重排
      if (this.cueRefreshFrame) return;
      this.cueRefreshFrame = requestAnimationFrame(() => {
        this.cueRefreshFrame = 0;
        this.refreshCueBlocks();
      });
    }

    // 画布颜色取自 CSS 令牌，以便跟随暗/亮主题。每次 render() 前刷新缓存。
    _readWaveColors() {
      const styles = getComputedStyle(document.documentElement);
      const get = (name, fallback) => {
        const value = styles.getPropertyValue(name).trim();
        return value || fallback;
      };
      this._waveColors = {
        rowBg: get('--wave-row-bg', '#1d252d'),
        rowBorder: get('--wave-row-border', '#2d3944'),
        rowTick: get('--wave-row-tick', '#3b4b59'),
        peak: get('--wave-peak', '#65b89a'),
        peakDim: get('--wave-peak-dim', '#83909a'),
      };
    }

    _getWaveColors() {
      if (!this._waveColors) this._readWaveColors();
      return this._waveColors;
    }

    render() {
      // 主题切换后令牌值变化：每次全量渲染前刷新画布颜色缓存，供 drawRow 读取。
      this._readWaveColors();
      this.applyLayout();
      if (!this.payload || !this.peaks) {
        this.content.replaceChildren();
        this.empty.classList.remove('hidden');
        return;
      }
      this.empty.classList.add('hidden');
      if (this.layoutDragging) {
        // 布局拖拽中：不做全量重建（每帧 14 个 canvas 重绘会卡顿），
        // 只把已有位图按新尺寸拉伸；松手后由 finish 里的 scheduleRender 恢复清晰
        this.stretchWaveformCanvases();
        return;
      }
      if (this.settings.mode === 'basic') this.renderBasic();
      else this.renderMulti();
    }

    stretchWaveformCanvases() {
      // 字幕块/空隙块/播放头均为百分比定位，会随行宽自动跟随；
      // 只有 canvas 位图需要按新尺寸临时拉伸
      this.content.querySelectorAll('.waveform-row canvas').forEach((canvas) => {
        canvas.style.width = '100%';
        canvas.style.height = '100%';
      });
    }

    renderSegments() {
      if (!this.payload) return;
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
      const groupBadges = computeGroupBadges(this.options.getSegments('main'));
      const row = this.createRow(this.basicWindowStartMs, endMs, -1, true, groupBadges);
      this.content.appendChild(row);
      this.drawRow(row);
      this.updatePlayback(false);
    }

    renderMulti() {
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowCount = Math.max(1, Math.ceil(this.durationMs / rowDurationMs));
      this.content.style.height = `${rowCount * (this.settings.rowHeight + ROW_GAP) - ROW_GAP}px`;
      this.multiRange = [-1, -1];
      this.renderMultiVisible(true);
    }

    renderMultiVisible(force = false) {
      if (!this.isMultiMode() || !this.payload) return;
      const rowDurationMs = this.settings.secondsPerRow * 1000;
      const rowCount = Math.max(1, Math.ceil(this.durationMs / rowDurationMs));
      const stride = this.settings.rowHeight + ROW_GAP;
      const first = clamp(Math.floor(this.scroll.scrollTop / stride) - MULTI_ROW_BUFFER, 0, rowCount - 1);
      const last = clamp(Math.ceil((this.scroll.scrollTop + this.scroll.clientHeight) / stride) + MULTI_ROW_BUFFER, 0, rowCount - 1);
      if (!force && first === this.multiRange[0] && last === this.multiRange[1]) {
        this.updatePlayback(false);
        return;
      }
      this.multiRange = [first, last];
      this.content.style.height = `${rowCount * stride - ROW_GAP}px`;
      const groupBadges = computeGroupBadges(this.options.getSegments('main'));
      if (force) {
        // 全量重建：先完成所有 DOM 变更再统一绘制，避免逐行强制同步布局
        this.content.replaceChildren();
        const rows = [];
        for (let index = first; index <= last; index++) {
          rows.push(this.content.appendChild(this.createMultiRow(index, rowDurationMs, groupBadges)));
        }
        for (const row of rows) this.drawRow(row);
        this.updatePlayback(false);
        return;
      }
      // 增量更新：只移除滚出可视范围的行、只绘制新进入的行；
      // 仍在范围内的行保留原 canvas 不重绘，消除滚动时的整体重建卡顿
      const wanted = new Set();
      for (let index = first; index <= last; index++) wanted.add(String(index));
      const existing = new Set();
      this.content.querySelectorAll('.waveform-row').forEach((row) => {
        if (wanted.has(row.dataset.rowIndex)) existing.add(row.dataset.rowIndex);
        else row.remove();
      });
      const created = [];
      for (let index = first; index <= last; index++) {
        if (existing.has(String(index))) continue;
        created.push(this.content.appendChild(this.createMultiRow(index, rowDurationMs, groupBadges)));
      }
      for (const row of created) this.drawRow(row);
      this.updatePlayback(false);
    }

    createMultiRow(index, rowDurationMs, groupBadges = null) {
      const startMs = index * rowDurationMs;
      const endMs = Math.min(this.durationMs, startMs + rowDurationMs);
      const row = this.createRow(startMs, endMs, index, false, groupBadges);
      row.style.top = `${index * (this.settings.rowHeight + ROW_GAP)}px`;
      row.style.height = `${this.settings.rowHeight}px`;
      return row;
    }

    createRow(startMs, endMs, rowIndex, basic, groupBadges = null) {
      const row = document.createElement('div');
      row.className = 'waveform-row';
      const multiLane = this.options.multiSubtitleVisible?.() === true;
      if (multiLane) {
        row.classList.add('multi-subtitle-row');
        if (this.options.showTrackBadges?.() === true) row.classList.add('show-track-badges');
      }
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

      const pointerLine = document.createElement('div');
      pointerLine.className = 'waveform-pointer-line';
      pointerLine.hidden = true;
      pointerLine.setAttribute('aria-hidden', 'true');
      row.appendChild(pointerLine);

      const splitFlash = document.createElement('div');
      splitFlash.className = 'waveform-split-flash';
      splitFlash.hidden = true;
      row.appendChild(splitFlash);

      this.appendGapBlocks(row, startMs, endMs);
      this.appendCueBlocks(row, startMs, endMs, groupBadges || computeGroupBadges(this.options.getSegments('main')));

      const gapOperationMode = this.options.getGapOperationMode?.() || 'boundary_drag';
      row.addEventListener('pointerdown', (event) => {
        if (event.button === 1 && gapOperationMode === 'middle_drag') {
          this.beginGapRangeDrag(event, row);
          return;
        }
        // Ctrl(Cmd)+左键拖动空白处：按拖动范围创建一条指定时长字幕。
        // 命中字幕块或静音空隙时保留各自已有的选择/边界操作。
        if (
          event.button === 0 &&
          (event.ctrlKey || event.metaKey) &&
          !event.shiftKey &&
          !event.altKey &&
          !event.target.closest('.waveform-cue-block, .waveform-gap-block')
        ) {
          const track = this.trackAtPoint(event.clientX, event.clientY, row);
          if (this.isCueTimeOccupied(this.timeFromPointer(event, row), track)) {
            event.preventDefault();
            event.stopPropagation();
            this.options.onCueCreateRejected?.('occupied');
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          this.beginCreateCueDrag(event, row, track);
          return;
        }
        // Shift+左键在空白处拖动：框选字幕块（追加进现有多选），
        // 不进入下方的清除选中/seek/播放头拖拽路径
        if (
          event.button === 0 &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.target.closest('.waveform-cue-block, .waveform-gap-block') &&
          !this.isCustomLayout()
        ) {
          event.preventDefault();
          this.beginMarqueeDrag(event);
          return;
        }
        if (event.button !== 0 || event.target.closest('.waveform-cue-block, .waveform-gap-block')) return;
        event.preventDefault();
        // 清除选中会提交当前字幕面板编辑，而提交可能同步重建虚拟行。
        // 在调用外部回调前保存坐标，后续 seek 不依赖可能已脱离 DOM 的 row。
        const geometry = this.captureRowGeometry(row);
        // 普通左键点击空白波形：清除字幕选中并跳转播放头
        this.options.clearSelection?.();
        // 「允许拖动指针」开启时，继续按住左键拖动则指针跟随鼠标位置
        if (this.settings.dragPlayhead) this.beginPlayheadDrag(event, row, geometry);
        this.seekFromPointer(event, row, false, geometry);
      });
      row.addEventListener('pointerenter', (event) => this.showPointerLine(event, row, pointerLine));
      row.addEventListener('pointermove', (event) => this.showPointerLine(event, row, pointerLine));
      row.addEventListener('pointerleave', () => this.hidePointerLine(pointerLine));
      row.addEventListener('auxclick', (event) => {
        if (event.button === 1 && gapOperationMode === 'middle_drag') event.preventDefault();
      });
      row.addEventListener('dblclick', (event) => {
        if (event.target.closest('.waveform-cue-block, .waveform-gap-block')) return;
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        this.options.togglePlayback();
      });
      row.addEventListener('contextmenu', (event) => {
        if (event.target.closest('.waveform-cue-block, .waveform-gap-block')) return;
        event.preventDefault();
        event.stopPropagation();
        const time = this.timeFromPointer(event, row);
        const track = this.trackAtPoint(event.clientX, event.clientY, row);
        this.options.showBlankWaveformMenu?.(time, event.clientX, event.clientY, track);
      });
      return row;
    }

    appendGapBlocks(row, startMs, endMs) {
      const gaps = this.options.getGapRemoveGaps?.() || [];
      const gapOperationMode = this.options.getGapOperationMode?.() || 'boundary_drag';
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
          this.options.showGapContextMenu?.(event.clientX, event.clientY, index);
        });
        row.appendChild(block);
      });
    }

    appendCueBlocks(row, startMs, endMs, groupBadges = null) {
      const multiLane = this.options.multiSubtitleVisible?.() === true;
      const segments = this.options.getSegments('main');
      const selected = this.options.getSelection('main');
      const bindingMarkerTargets = this.options.getBindingMarkerTargets?.() || {};
      const mainBindingMarkers = bindingMarkerTargets.main;
      const now = this.currentTimeMs();
      const activeMainIndex = findActiveCueIndex(segments, now);
      const badgesByIndex = groupBadges || computeGroupBadges(segments);
      segments.forEach((segment, index) => {
        if (segment.end <= startMs || segment.start >= endMs) return;
        if (segment.disabled && (this.options.getHideDisabled?.() || this.settings.disabledDisplay === 'hidden')) return;
        const block = document.createElement('div');
        block.className = 'waveform-cue-block';
        block.dataset.idx = String(index);
        block.dataset.start = String(segment.start);
        block.dataset.end = String(segment.end);
        block.style.setProperty('--cue-color', colorForSegment(segment));
        if (selected.has(index)) block.classList.add('selected');
        if (segment.disabled) block.classList.add('disabled');
        if (index === activeMainIndex) block.classList.add('active');

        const label = document.createElement('span');
        label.className = 'waveform-cue-label';
        label.textContent = segment.text.replace(/\s+/g, ' ');
        block.appendChild(label);
        this.setBindingMarker(block, mainBindingMarkers?.has?.(index) === true);
        // 短块内文字会被截断，悬浮 title 给出完整字幕文本
        block.title = label.textContent;
        const badges = this.settings.showGroupBadges !== false ? badgesByIndex.get(index) : null;
        if (badges?.length) {
          // 徽章挂在行上、块上方（不遮挡块内文字）；短字幕也保留最小显示空间，
          // 让分组提示可以正常出现。
          const badgeDuration = Math.max(1, endMs - startMs);
          const badgeVisibleStart = Math.max(startMs, segment.start);
          const badgeVisibleEnd = Math.min(endMs, segment.end);
          // 行创建时还未挂载（clientWidth=0），用容器宽度估算块像素宽（行宽=容器宽）
          const blockWidthPx = ((badgeVisibleEnd - badgeVisibleStart) / badgeDuration) * this.content.clientWidth;
          if (blockWidthPx >= 24) badges.forEach((badge, badgeIndex) => {
            const badgeEl = document.createElement('span');
            badgeEl.className = `waveform-cue-badge ${badge.type}`;
            badgeEl.textContent = badge.type === 'sticker' && badge.total === 1
              ? '🦊'
              : `${badge.type === 'color' ? '🎨' : '🦊'} ${badge.ordinal}/${badge.total}`;
            badgeEl.style.left = `${((badgeVisibleStart - startMs) / badgeDuration) * 100}%`;
            badgeEl.style.setProperty('--badge-stack-index', String(badgeIndex));
            row.appendChild(badgeEl);
          });
        }
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
        block.dataset.track = 'main';
        block.addEventListener('pointerdown', (event) => this.beginCueDrag(event, index, row, 'main'));
        block.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const timeMs = this.timeFromPointer(event, row);
          this.options.showContextMenu?.(event.clientX, event.clientY, index, timeMs);
        });
        block.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.ctrlKey || event.metaKey) return;
          this.options.activateCue?.(index);
        });
        row.appendChild(block);
      });

      if (!multiLane) return;
      const extensionSegments = this.options.getExtensionSegments?.() || [];
      const extensionSelected = this.options.getExtensionSelection?.() || new Set();
      const extensionBindingMarkers = bindingMarkerTargets.extension;
      const activeExtensionIndex = findActiveCueIndex(extensionSegments, now);
      extensionSegments.forEach((segment, index) => {
        if (segment.end <= startMs || segment.start >= endMs) return;
        if (segment.disabled && (this.options.getHideDisabled?.() || this.settings.disabledDisplay === 'hidden')) return;
        const block = document.createElement('div');
          block.className = 'waveform-cue-block';
          block.dataset.track = 'extension';
          block.dataset.extIdx = String(index);
          block.dataset.start = String(segment.start);
          block.dataset.end = String(segment.end);
          block.style.setProperty('--cue-color', '#7a9fc5');
        if (extensionSelected.has(index)) block.classList.add('selected');
        if (segment.disabled) block.classList.add('disabled');
        if (index === activeExtensionIndex) block.classList.add('active');
        const label = document.createElement('span');
        label.className = 'waveform-cue-label';
        label.textContent = String(segment.text || '').replace(/\s+/g, ' ');
        block.title = label.textContent;
        block.appendChild(label);
        this.setBindingMarker(block, extensionBindingMarkers?.has?.(index) === true);
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
        block.addEventListener('pointerdown', (event) => this.beginCueDrag(event, index, row, 'extension'));
        block.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const timeMs = this.timeFromPointer(event, row);
          this.options.showExtensionContextMenu?.(event.clientX, event.clientY, index, timeMs);
        });
        block.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.ctrlKey || event.metaKey) return;
          this.options.activateExtensionCue?.(index);
        });
        row.appendChild(block);
      });
    }

    setBindingMarker(block, visible) {
      block.classList.toggle('has-binding-marker', visible);
      const marker = block.querySelector('.waveform-binding-marker');
      if (!visible) {
        marker?.remove();
        return;
      }
      if (marker) return;
      const next = document.createElement('span');
      next.className = 'waveform-binding-marker';
      next.textContent = '🔗';
      next.title = '已绑定字幕';
      next.setAttribute('aria-label', '已绑定字幕');
      block.appendChild(next);
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

    refreshGapOverlay() {
      if (!this.payload) return;
      this.content.querySelectorAll('.waveform-row').forEach((row) => {
        row.querySelectorAll('.waveform-gap-block').forEach((element) => element.remove());
        this.appendGapBlocks(row, Number(row.dataset.startMs), Number(row.dataset.endMs));
      });
      this.positionPlayheads();
    }

    refreshCueOverlay() {
      if (!this.payload) return;
      const rows = [...this.content.querySelectorAll('.waveform-row')];
      if (!rows.length) return;
      const groupBadges = computeGroupBadges(this.options.getSegments('main'));
      rows.forEach((row) => {
        // 绑定、解绑和字幕时间变化只影响覆盖层；保留已有行与 Canvas，
        // 避免重新采样/绘制波形导致操作出现一帧卡顿。
        row.querySelectorAll('.waveform-cue-block, .waveform-cue-badge')
          .forEach((element) => element.remove());
        this.appendCueBlocks(
          row,
          Number(row.dataset.startMs),
          Number(row.dataset.endMs),
          groupBadges,
        );
      });
      this.updatePlayback(false);
    }

    refreshCueBlocks() {
      const segments = this.options.getSegments('main');
      const extensionSegments = this.options.getExtensionSegments?.() || [];
      this.content.querySelectorAll('.waveform-cue-block').forEach((block) => {
        const isExtension = block.dataset.track === 'extension';
        const segment = isExtension
          ? extensionSegments[Number(block.dataset.extIdx)]
          : segments[Number(block.dataset.idx)];
        const row = block.closest('.waveform-row');
        if (!segment || !row) return;
        this.layoutBlock(block, segment, Number(row.dataset.startMs), Number(row.dataset.endMs));
        block.classList.toggle('selected', isExtension
          ? this.options.getExtensionSelection?.().has(Number(block.dataset.extIdx))
          : this.options.getSelection('main').has(Number(block.dataset.idx)));
        const bindingMarkerTargets = this.options.getBindingMarkerTargets?.() || {};
        this.setBindingMarker(block, isExtension
          ? bindingMarkerTargets.extension?.has?.(Number(block.dataset.extIdx)) === true
          : bindingMarkerTargets.main?.has?.(Number(block.dataset.idx)) === true);
      });
      this.positionPlayheads();
    }

    refreshCueLabel(index) {
      const segment = this.options.getSegments('main')[index];
      if (!segment) return;
      this.content.querySelectorAll(`.waveform-cue-block[data-track="main"][data-idx="${index}"] .waveform-cue-label`)
        .forEach((label) => { label.textContent = segment.text.replace(/\s+/g, ' '); });
    }

    refreshExtensionCueLabel(index, trackId = null) {
      const segment = this.options.getExtensionSegments?.(trackId)?.[index];
      if (!segment) return;
      this.content.querySelectorAll(`.waveform-cue-block[data-track="extension"][data-ext-idx="${index}"] .waveform-cue-label`)
        .forEach((label) => { label.textContent = String(segment.text || '').replace(/\s+/g, ' '); });
    }

    updateSelection() {
      const selected = this.options.getSelection('main');
      const extensionSelected = this.options.getExtensionSelection?.() || new Set();
      const bindingMarkerTargets = this.options.getBindingMarkerTargets?.() || {};
      this.content.querySelectorAll('.waveform-cue-block').forEach((block) => {
        const isExtension = block.dataset.track === 'extension';
        const index = Number(isExtension ? block.dataset.extIdx : block.dataset.idx);
        block.classList.toggle('selected', isExtension
          ? extensionSelected.has(index)
          : selected.has(index));
        this.setBindingMarker(block, isExtension
          ? bindingMarkerTargets.extension?.has?.(index) === true
          : bindingMarkerTargets.main?.has?.(index) === true);
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
      const colors = this._getWaveColors();
      ctx.fillStyle = colors.rowBg;
      ctx.fillRect(0, 0, width, height);

      const startMs = Number(row.dataset.startMs);
      const endMs = Number(row.dataset.endMs);
      const rangeMs = Math.max(1, endMs - startMs);
      const tickSeconds = rangeMs <= 10000 ? 1 : rangeMs <= 30000 ? 2 : 5;
      const firstTick = Math.ceil(startMs / (tickSeconds * 1000)) * tickSeconds * 1000;
      ctx.strokeStyle = colors.rowBorder;
      ctx.lineWidth = 1;
      for (let tick = firstTick; tick < endMs; tick += tickSeconds * 1000) {
        const x = ((tick - startMs) / rangeMs) * width;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
        ctx.stroke();
      }
      ctx.strokeStyle = colors.rowTick;
      ctx.beginPath();
      ctx.moveTo(0, height * 0.46);
      ctx.lineTo(width, height * 0.46);
      ctx.stroke();

      // 波形形状来源：默认使用 .ReaPeaks 的最细 wave 层；没有时回退到自研缓存。
      const shapeSource = this.options.getWaveShapeSource?.() || 'self';
      const useReapeaksShape = shapeSource === 'reapeaks' && this.reapeaksPayload && this.reapeaksPeaks;
      const activePeaks = useReapeaksShape ? this.reapeaksPeaks : this.peaks;
      const activePps = useReapeaksShape ? this.reapeaksPayload.peaks_per_second : this.payload.peaks_per_second;
      const activeCount = useReapeaksShape ? this.reapeaksPayload.peak_count : this.payload.peak_count;
      const peaksPerSecond = activePps;
      const useInterpolation = this.settings.mode === 'basic'
        && this.settings.visibleSeconds === ZOOM_PRESETS[0]
        && (rangeMs / 1000) * peaksPerSecond < width;
      const interpolatedPeak = [0, 0];
      const center = height * 0.46;
      const amplitude = waveformAmplitude(height, this.settings.waveformScale);
      const minWaveY = 2;
      const maxWaveY = Math.max(minWaveY, height - 2);
      const spectral = this.settings.spectralColor === true ? this.spectral : null;
      const defaultColor = this.mediaAvailable ? colors.peak : colors.peakDim;
      const spectralRate = spectral ? spectral.sample_rate / spectral.division : 0;
      ctx.lineWidth = 1;
      // 有频谱缓存时逐像素按主频染色（颜色只填充在波形包络内）；
      // 否则沿用单次批量描边，避免无频谱时的逐像素绘制开销。
      let pathOpen = false;
      for (let x = 0; x < width; x++) {
        const xStartMs = startMs + (x / width) * rangeMs;
        const xEndMs = startMs + ((x + 1) / width) * rangeMs;
        let low;
        let high;
        if (useInterpolation) {
          const centerMs = (xStartMs + xEndMs) / 2;
          const peakPosition = (centerMs / 1000) * peaksPerSecond - 0.5;
          sampleInterpolatedPeak(
            activePeaks,
            peakPosition,
            activeCount,
            interpolatedPeak,
          );
          [low, high] = interpolatedPeak;
        } else {
          const firstPeak = clamp(Math.floor((xStartMs / 1000) * peaksPerSecond), 0, activeCount - 1);
          const lastPeak = clamp(Math.ceil((xEndMs / 1000) * peaksPerSecond), firstPeak + 1, activeCount);
          low = 127;
          high = -127;
          for (let peak = firstPeak; peak < lastPeak; peak++) {
            low = Math.min(low, activePeaks[peak * 2]);
            high = Math.max(high, activePeaks[peak * 2 + 1]);
          }
        }
        const yTop = clamp(center - (high / 127) * amplitude, minWaveY, maxWaveY);
        const yBot = clamp(center - (low / 127) * amplitude, minWaveY, maxWaveY);
        if (spectral) {
          const centerMs = xStartMs + rangeMs / width / 2;
          const specIndex = Math.floor((centerMs / 1000) * spectralRate);
          let color = defaultColor;
          if (specIndex >= 0 && specIndex < spectral.freq.length) {
            const freq = spectral.freq[specIndex];
            if (freq > 0) {
              color = freqColor(freq, spectral.density[specIndex], spectral.densityMax);
            }
          }
          ctx.fillStyle = color;
          ctx.fillRect(x + 0.5, yTop, 1, Math.max(1, yBot - yTop));
        } else {
          if (!pathOpen) {
            ctx.beginPath();
            ctx.strokeStyle = defaultColor;
            pathOpen = true;
          }
          ctx.moveTo(x + 0.5, yTop);
          ctx.lineTo(x + 0.5, yBot);
        }
      }
      if (!spectral && pathOpen) ctx.stroke();
    }

    seekFromPointer(event, row, playAfterSeek = false, geometry = null) {
      this.options.seek(this.timeFromPointer(event, row, geometry) / 1000);
      this.updatePlayback();
      if (playAfterSeek && this.player?.paused) this.options.togglePlayback?.();
    }

    seekFromCue(event, row, index, playAfterSeek = false, geometry = null, track = 'main') {
      const segment = this.options.getSegments(track)[index];
      const timeMs = this.options.getClickTarget?.() === 'pointer'
        ? this.timeFromPointer(event, row, geometry)
        : Number(segment?.start);
      if (!Number.isFinite(timeMs)) return;
      this.options.seek(timeMs / 1000);
      this.updatePlayback();
      if (playAfterSeek && this.player?.paused) this.options.togglePlayback?.();
    }

    // Ctrl(Cmd)+左键拖动空白波形：显示字幕块虚影，松开后交给编辑器
    // 创建字幕。时间映射固定使用按下时的行几何，避免虚拟行重建或拖出行边界
    // 后把终点错误地映射到另一行。
    beginCreateCueDrag(event, row, track = 'main') {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.focusWaveform();
      const geometry = this.captureRowGeometry(row);
      const startMs = this.timeFromPointer(event, row, geometry);
      if (this.isCueTimeOccupied(startMs, track)) {
        this.options.onCueCreateRejected?.('occupied');
        return;
      }
      const drag = {
        pointerId: event.pointerId,
        row,
        geometry,
        startMs,
        currentMs: startMs,
        startClientX: event.clientX,
        startClientY: event.clientY,
        lastEvent: event,
        preview: null,
        frame: 0,
        finish: null,
      };
      this.createCueDrag = drag;

      const updatePosition = (nextEvent) => {
        if (!nextEvent) return;
        drag.lastEvent = nextEvent;
        const requestedMs = this.timeFromPointer(nextEvent, row, geometry);
        // 起点在空白时，拖入已有字幕只把终点挡在字幕边界，
        // 保留之前的“边界阻挡后仍可创建”行为。
        drag.currentMs = this.clampCreateCueTime(drag.startMs, requestedMs, track);
      };
      const updatePreview = () => {
        drag.frame = 0;
        if (this.createCueDrag !== drag) return;
        const start = Math.min(drag.startMs, drag.currentMs);
        const end = Math.max(drag.startMs, drag.currentMs);
        if (!drag.preview) {
          drag.preview = document.createElement('div');
          drag.preview.className = 'waveform-cue-block waveform-create-preview';
          drag.preview.dataset.track = track;
          if (track === 'extension') drag.preview.style.setProperty('--cue-color', '#7a9fc5');
          const label = document.createElement('span');
          label.className = 'waveform-cue-label';
          drag.preview.appendChild(label);
          row.appendChild(drag.preview);
        }
        const duration = Math.max(1, geometry.endMs - geometry.startMs);
        drag.preview.style.left = `${clamp(((start - geometry.startMs) / duration) * 100, 0, 100)}%`;
        drag.preview.style.width = `${Math.max(0.25, clamp(((end - start) / duration) * 100, 0, 100))}%`;
        drag.preview.firstElementChild.textContent = `${formatCompact(roundMs(start))} → ${formatCompact(roundMs(end))} · ${formatCompact(roundMs(end - start))}`;
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (drag.frame) {
          cancelAnimationFrame(drag.frame);
          drag.frame = 0;
        }
        try { row.releasePointerCapture?.(drag.pointerId); } catch (_) {}
        drag.preview?.remove();
        drag.preview = null;
      };
      const finish = (commit, finalEvent = null) => {
        if (this.createCueDrag !== drag) return;
        if (finalEvent) updatePosition(finalEvent);
        const start = roundMs(Math.min(drag.startMs, drag.currentMs));
        const end = roundMs(Math.max(drag.startMs, drag.currentMs));
        cleanup();
        this.createCueDrag = null;
        if (!commit) return;
        if (end - start < MIN_CUE_MS) {
          this.options.onCueCreateRejected?.('too-short', start, end);
          return;
        }
        this.options.addCueRange?.(start, end, drag.startClientX, drag.startClientY, track);
      };
      drag.finish = finish;
      try { row.setPointerCapture?.(drag.pointerId); } catch (_) {}

      const onMove = (moveEvent) => {
        if (this.createCueDrag !== drag) return;
        if (!(moveEvent.buttons & 1)) {
          finish(true, moveEvent);
          return;
        }
        updatePosition(moveEvent);
        if (!drag.frame) drag.frame = requestAnimationFrame(updatePreview);
      };
      const onUp = (upEvent) => finish(true, upEvent);
      const onCancel = () => finish(false);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    }

    captureRowGeometry(row) {
      const rect = row.getBoundingClientRect();
      return {
        left: rect.left,
        width: Math.max(1, rect.width),
        startMs: Number(row.dataset.startMs),
        endMs: Number(row.dataset.endMs),
      };
    }

    trackAtPoint(clientX, clientY, row = null) {
      const hit = document.elementFromPoint(clientX, clientY);
      const hitRow = row || hit?.closest?.('.waveform-row');
      if (!hitRow || !this.pane?.contains(hitRow)) return 'main';
      const block = hit?.closest?.('.waveform-cue-block');
      if (block?.dataset.track === 'extension') return 'extension';
      if (!hitRow.classList.contains('multi-subtitle-row')) return 'main';
      const rowRect = hitRow.getBoundingClientRect();
      const rowStyle = getComputedStyle(hitRow);
      const parsePx = (value, fallback) => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      const bottomInset = parsePx(rowStyle.getPropertyValue('--multi-subtitle-bottom-inset'), 7);
      const visibleCue = hitRow.querySelector(
        '.waveform-cue-block[data-track="main"], .waveform-cue-block[data-track="extension"]',
      );
      const visibleCueHeight = visibleCue?.getBoundingClientRect().height || 0;
      const markerStyle = getComputedStyle(hitRow, '::after');
      const markerHeight = parsePx(markerStyle.height, 15);
      const markerBottom = parsePx(markerStyle.bottom, NaN);
      const markerLaneHeight = Number.isFinite(markerBottom)
        ? 2 * (markerBottom - bottomInset) + markerHeight : 0;
      const laneHeight = visibleCueHeight > 0
        ? visibleCueHeight
        : markerLaneHeight > 0
          ? markerLaneHeight
          : Math.min(35, Math.max(0, (rowRect.height - bottomInset * 2) / 2));
      const extensionTop = rowRect.height - bottomInset - laneHeight;
      return clientY - rowRect.top >= extensionTop ? 'extension' : 'main';
    }

    isCueTimeOccupied(timeMs, track = 'main') {
      const time = Number(timeMs);
      if (!Number.isFinite(time)) return false;
      const segments = this.options.getSegments?.(track) || [];
      return segments.some((segment) => {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        return Number.isFinite(start) && Number.isFinite(end)
          && start < time && time < end;
      });
    }

    // 创建字幕的拖动不能跨过已有字幕；沿拖动方向把当前端点夹到遇到的
    // 第一个字幕边界。这样预览和最终提交使用同一组无重叠时间范围。
    clampCreateCueTime(anchorMs, requestedMs, track = 'main') {
      if (!Number.isFinite(anchorMs) || !Number.isFinite(requestedMs) || anchorMs === requestedMs) {
        return requestedMs;
      }
      const segments = this.options.getSegments?.(track) || [];
      if (segments.some((segment) => {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        return Number.isFinite(start) && Number.isFinite(end)
          && start < anchorMs && anchorMs < end;
      })) return anchorMs;
      const movingRight = requestedMs > anchorMs;
      let boundary = movingRight ? Infinity : -Infinity;
      for (const segment of segments) {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        if (movingRight) {
          if (start >= anchorMs && start <= requestedMs) boundary = Math.min(boundary, start);
        } else if (end <= anchorMs && end >= requestedMs) {
          boundary = Math.max(boundary, end);
        }
      }
      return Number.isFinite(boundary) ? boundary : requestedMs;
    }

    beginBlockedCueCreateDrag(event, index, track = 'main') {
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let finished = false;
      let moved = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        try { target.releasePointerCapture?.(pointerId); } catch (_) {}
      };
      const onMove = (moveEvent) => {
        if (finished || moveEvent.pointerId !== pointerId) return;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (dx * dx + dy * dy < 16) return;
        moved = true;
        cleanup();
        this.options.onCueCreateRejected?.('occupied');
      };
      const onUp = () => {
        if (finished) return;
        cleanup();
        if (!moved) {
          if (track === 'extension') this.options.toggleExtensionSelection?.(index);
          else this.options.toggleCueSelection?.(index);
        }
      };
      const onCancel = () => cleanup();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      try { target.setPointerCapture?.(pointerId); } catch (_) {}
    }

    timeFromPointer(event, row, geometry = null) {
      const rect = geometry || row.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const startMs = geometry?.startMs ?? Number(row.dataset.startMs);
      const endMs = geometry?.endMs ?? Number(row.dataset.endMs);
      return startMs + ratio * (endMs - startMs);
    }

    // 在波形指针拆分成功后短暂显示黄色定位光条，帮助用户确认实际操作位置。
    // 光条只覆盖波形行，不参与鼠标命中，也不影响红色播放头。
    flashSplitAtTime(timeMs) {
      if (!Number.isFinite(timeMs)) return false;
      const rows = [...this.content.querySelectorAll('.waveform-row')];
      const row = rows.find((candidate) => {
        const startMs = Number(candidate.dataset.startMs);
        const endMs = Number(candidate.dataset.endMs);
        return timeMs >= startMs && timeMs <= endMs;
      });
      if (!row) return false;

      const startMs = Number(row.dataset.startMs);
      const endMs = Number(row.dataset.endMs);
      const marker = row.querySelector('.waveform-split-flash');
      if (!marker) return false;
      if (marker._hideTimer) window.clearTimeout(marker._hideTimer);
      marker.hidden = false;
      marker.style.left = `${((timeMs - startMs) / Math.max(1, endMs - startMs)) * 100}%`;
      marker.classList.remove('is-active');
      // 强制重新计算布局，让连续两次 B 也能重启动画。
      void marker.offsetWidth;
      marker.classList.add('is-active');
      marker._hideTimer = window.setTimeout(() => {
        marker.classList.remove('is-active');
        marker.hidden = true;
        marker._hideTimer = 0;
      }, SPLIT_FLASH_DURATION_MS);
      return true;
    }

    // 返回波形字幕切点的屏幕坐标，供全屏反馈动画把中心落在实际切分位置。
    getSplitPointAtTime(timeMs, track = 'main') {
      if (!Number.isFinite(timeMs)) return null;
      const rows = [...this.content.querySelectorAll('.waveform-row')];
      const row = rows.find((candidate) => {
        const startMs = Number(candidate.dataset.startMs);
        const endMs = Number(candidate.dataset.endMs);
        return timeMs >= startMs && timeMs <= endMs;
      });
      if (!row) return null;
      const rowStart = Number(row.dataset.startMs);
      const rowEnd = Number(row.dataset.endMs);
      const rowRect = row.getBoundingClientRect();
      const ratio = clamp((timeMs - rowStart) / Math.max(1, rowEnd - rowStart), 0, 1);
      const selector = `.waveform-cue-block[data-track="${track === 'extension' ? 'extension' : 'main'}"]`;
      const block = [...row.querySelectorAll(selector)].find((candidate) => {
        const startMs = Number(candidate.dataset.start);
        const endMs = Number(candidate.dataset.end);
        return timeMs >= startMs && timeMs <= endMs;
      });
      const blockRect = block?.getBoundingClientRect?.();
      return {
        clientX: rowRect.left + rowRect.width * ratio,
        clientY: blockRect ? blockRect.top + blockRect.height / 2 : rowRect.top + rowRect.height / 2,
      };
    }

    // 屏幕坐标 -> 波形时间：命中某个波形行时返回该行内的时间（毫秒），否则返回 null。
    // 供键盘快捷键（如 B 按指针音频位置拆分）在不构造指针事件的情况下复用行内映射。
    timeMsAtPoint(clientX, clientY) {
      const hit = document.elementFromPoint(clientX, clientY);
      const row = hit?.closest?.('.waveform-row');
      if (!row || !this.pane?.contains(row)) return null;
      const timeMs = this.timeFromPointer({ clientX }, row);
      return Number.isFinite(timeMs) ? timeMs : null;
    }

    // 「允许拖动指针」：在波形空白区域按住左键拖动时，播放指针实时跟随鼠标
    // 所在位置。高回报率指针事件用 rAF 合并，每帧最多 seek 一次；松开时以
    // 最终位置再 seek 一次保证落点精确。指针捕获让拖出行范围时按行边界钳制。
    beginPlayheadDrag(event, row, geometry = null) {
      geometry = geometry || this.captureRowGeometry(row);
      try { row.setPointerCapture?.(event.pointerId); } catch (_) {}
      let frame = 0;
      let lastEvent = null;
      let moved = false;
      const startX = event.clientX;
      const startY = event.clientY;
      const flush = () => {
        frame = 0;
        if (lastEvent) this.seekFromPointer(lastEvent, row, false, geometry);
        lastEvent = null;
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        lastEvent = null;
      };
      const onMove = (moveEvent) => {
        if (!(moveEvent.buttons & 1)) { cleanup(); return; }
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >= 3) moved = true;
        lastEvent = moveEvent;
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const onUp = (upEvent) => {
        cleanup();
        if (moved) this.seekFromPointer(upEvent, row, false, geometry);
      };
      const onCancel = () => cleanup();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
      window.addEventListener('pointercancel', onCancel, { once: true });
    }

    // Shift+左键框选：在波形空白处按下并拖动，画出选框，松开后把与选框相交的
    // 字幕块追加进当前多选（与 Shift 范围选同为追加语义）。选框挂在
    // #waveform-content 内、与行同坐标系，滚动时自动跟随；多行虚拟化重建
    // 会清掉覆盖层与块上的预览类，因此每帧重新挂载、重新命中。位移低于
    // 阈值的 Shift+点击视为空操作，不触发空白区既有的清除选中/seek。
    beginMarqueeDrag(event) {
      const content = this.content;
      const startRect = content.getBoundingClientRect();
      const start = { x: event.clientX - startRect.left, y: event.clientY - startRect.top };
      let lastEvent = event;
      let overlay = null;
      let frame = 0;
      let drawing = false;
      let hits = { main: new Set(), extension: new Set() };

      const clearPreview = () => {
        content.querySelectorAll('.waveform-cue-block.marquee-preview').forEach((block) => {
          block.classList.remove('marquee-preview');
        });
      };
      const removeOverlay = () => {
        if (overlay) overlay.remove();
        overlay = null;
      };
      const update = () => {
        frame = 0;
        const rect = content.getBoundingClientRect();
        const current = { x: lastEvent.clientX - rect.left, y: lastEvent.clientY - rect.top };
        if (!drawing) {
          if (Math.hypot(current.x - start.x, current.y - start.y) < 4) return;
          drawing = true;
        }
        if (!overlay || !overlay.isConnected) {
          overlay = document.createElement('div');
          overlay.className = 'waveform-marquee';
          content.appendChild(overlay);
        }
        const left = Math.min(start.x, current.x);
        const top = Math.min(start.y, current.y);
        overlay.style.left = `${left}px`;
        overlay.style.top = `${top}px`;
        overlay.style.width = `${Math.abs(current.x - start.x)}px`;
        overlay.style.height = `${Math.abs(current.y - start.y)}px`;
        const marqueeRect = overlay.getBoundingClientRect();
        const next = { main: new Set(), extension: new Set() };
        content.querySelectorAll('.waveform-cue-block[data-track="main"], .waveform-cue-block[data-track="extension"]').forEach((block) => {
          const blockRect = block.getBoundingClientRect();
          const hit =
            !block.hidden &&
            blockRect.right > marqueeRect.left &&
            blockRect.left < marqueeRect.right &&
            blockRect.bottom > marqueeRect.top &&
            blockRect.top < marqueeRect.bottom;
          block.classList.toggle('marquee-preview', hit);
          if (!hit) return;
          const track = block.dataset.track === 'extension' ? 'extension' : 'main';
          const rawIndex = track === 'extension' ? block.dataset.extIdx : block.dataset.idx;
          const index = Number(rawIndex);
          if (Number.isInteger(index)) next[track].add(index);
        });
        hits = next;
      };
      const finish = (commit) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        // 以指针最终位置补一次命中计算，避免快速松开时结果落后一帧
        if (commit) update();
        clearPreview();
        removeOverlay();
        if (commit && drawing) {
          if (hits.main.size > 0) {
            this.options.addCueSelection?.([...hits.main].sort((a, b) => a - b));
          }
          if (hits.extension.size > 0) {
            this.options.addExtensionSelection?.([...hits.extension].sort((a, b) => a - b));
          }
        }
      };
      const onMove = (moveEvent) => {
        if (!(moveEvent.buttons & 1)) {
          finish(true);
          return;
        }
        lastEvent = moveEvent;
        if (!frame) frame = requestAnimationFrame(update);
      };
      const onUp = (upEvent) => {
        lastEvent = upEvent;
        finish(true);
      };
      const onCancel = () => finish(false);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    }

    handleWheel(event) {
      const scrollDelta = wheelScrollDelta(event);
      if (!scrollDelta) return;
      if (this.isMultiMode() && (event.ctrlKey || event.metaKey) && event.shiftKey) {
        // Ctrl(Cmd)+Shift+滚轮：仅多行模式下循环调整行高预设，向上滚放大，不改变时间映射
        event.preventDefault();
        const current = ROW_HEIGHT_PRESETS.indexOf(this.settings.rowHeight);
        const next = clamp(current + (scrollDelta > 0 ? -1 : 1), 0, ROW_HEIGHT_PRESETS.length - 1);
        if (next !== current) {
          this.settings.rowHeight = ROW_HEIGHT_PRESETS[next];
      if (this.rowHeightSelect) this.rowHeightSelect.value = String(this.settings.rowHeight);
      if (this.showGroupBadgesToggle) this.showGroupBadgesToggle.checked = this.settings.showGroupBadges !== false;
          saveSettings(this.settings);
          this.renderMulti();
        }
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        // 用 rAF 合并高频滚轮：一帧内累加方向，避免每次 wheel 都重渲染导致卡顿
        this.pendingScaleDirection += scrollDelta > 0 ? -1 : 1;
        this.scheduleWheelScaleChange();
        return;
      }
      if (this.settings.mode === 'basic') {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          this.changeZoom(scrollDelta > 0 ? 1 : -1);
          return;
        }
        const windowMs = this.settings.visibleSeconds * 1000;
        const maxStart = Math.max(0, this.durationMs - windowMs);
        const delta = Math.sign(scrollDelta) * windowMs * 0.12;
        this.basicWindowStartMs = clamp(this.basicWindowStartMs + delta, 0, maxStart);
        this.manualFollowUntil = Date.now() + 3000;
        this.scheduleBasicRender();
        return;
      }
      if (this.isMultiMode() && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        const current = ROW_PRESETS.indexOf(this.settings.secondsPerRow);
        const next = clamp(current + (scrollDelta > 0 ? 1 : -1), 0, ROW_PRESETS.length - 1);
        if (next !== current) {
          this.settings.secondsPerRow = ROW_PRESETS[next];
          this.secondsPerRowSelect.value = String(this.settings.secondsPerRow);
          saveSettings(this.settings);
          this.renderMulti();
        }
      }
    }

    beginCueDrag(event, index, row, track = 'main') {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      // 字幕块会阻止 pointerdown 冒泡到 pane；主动接管焦点，确保按住
      // 字幕块/边界后，左手 A/D 不会仍被设置输入框等控件拦截。
      this.focusWaveform();
      // Ctrl(Cmd)+点击字幕仍保留多选；只有真正移动形成拖动时才视为
      // “在已有字幕上创建”，并直接拒绝，不启动普通字幕拖动或创建预览。
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        return this.beginBlockedCueCreateDrag(event, index, track);
      }
      // 剃刀工具：无修饰键左键点击字幕块（非手柄）时，在指针位置安全拆分。
      // 修饰键（Alt/Ctrl(Cmd)/Shift）仍走原行为，便于拆分后立即多选/禁用。
      const targetHandle = event.target.closest('.waveform-cue-handle');
      if (track === 'main' && this.tool === 'razor' && !targetHandle
          && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const timeMs = this.timeFromPointer(event, row);
        this.options.splitCueAtTime?.(index, timeMs);
        return;
      }
      // Alt 行为分裂：命中共享边界手柄时拆开为单侧独立拖动；否则保持
      // Alt+点击字幕块切换禁用的既有行为。
      if (event.altKey && targetHandle) {
        const sharedLeft = targetHandle.classList.contains('left')
          && index > 0 && this.isSharedBoundary(event, index - 1, index, row, track);
        const sharedRight = targetHandle.classList.contains('right')
          && index + 1 < this.options.getSegments(track).length
          && this.isSharedBoundary(event, index, index + 1, row, track);
        if (sharedLeft || sharedRight) {
          return this.beginIndependentEdgeDrag(event, index, row, targetHandle, track);
        }
      }
      // Ctrl(Cmd)+click toggles selection without starting a drag
      if (event.ctrlKey || event.metaKey) {
        if (track === 'extension') this.options.toggleExtensionSelection?.(index);
        else this.options.toggleCueSelection?.(index);
        return;
      }
      // Shift+click selects a range from lastClickedIdx to index
      if (event.shiftKey) {
        if (track === 'extension') this.options.selectExtensionRange?.(index);
        else this.options.selectCueRange?.(index);
        return;
      }
      let boundaryIndex = index;
      const kind = targetHandle?.classList.contains('left')
        ? (index > 0 && this.isSharedBoundary(event, index - 1, index, row, track)
          ? (boundaryIndex = index - 1, 'resize-boundary') : 'resize-left')
        : targetHandle?.classList.contains('right')
          ? (index + 1 < this.options.getSegments(track).length && this.isSharedBoundary(event, index, index + 1, row, track)
            ? 'resize-boundary' : 'resize-right')
          : 'move';
      // 选中字幕会更新列表、面板以及波形块状态；其中任一步都可能触发
      // 虚拟行重建。先保存按下瞬间的几何数据，避免 pointerup 使用已脱离
      // DOM 的旧行并把比例钳到该行末尾（也就是下一行开头）。
      const geometry = this.captureRowGeometry(row);
      const selected = this.options.getSelection(track);
      if (!selected.has(index)) {
        if (track === 'extension') this.options.selectExtensionCue?.(index);
        else this.options.selectCue(index);
      } else if (track === 'extension') {
        this.options.activateExtensionCue?.(index);
      } else {
        this.options.activateCue?.(index);
      }
      const liveSelection = this.options.getSelection(track);
      const indices = kind === 'move' && liveSelection.has(index)
        ? [...liveSelection].sort((a, b) => a - b) : [index];
      const segments = this.options.getSegments(track);
      const dragIndices = kind === 'resize-boundary' ? [boundaryIndex, boundaryIndex + 1] : indices;
      const originals = new Map(dragIndices.map((idx) => [idx, {
        start: segments[idx].start,
        end: segments[idx].end,
        items: Array.isArray(segments[idx].items)
          ? segments[idx].items.map((item) => ({ ...item })) : segments[idx].items,
      }]));
      const cancelIndices = new Set(dragIndices);
      if (kind === 'move') {
        dragIndices.forEach((idx) => {
          if (segments[idx - 1] && isAttached(segments[idx - 1], segments[idx])) cancelIndices.add(idx - 1);
          if (segments[idx + 1] && isAttached(segments[idx], segments[idx + 1])) cancelIndices.add(idx + 1);
        });
      }
      const allOriginals = kind === 'move'
        ? new Map(segments.map((segment, idx) => [idx, snapshotTiming(segment)]))
        : null;
      const cancelOriginals = new Map([...cancelIndices].map((idx) => [idx, snapshotTiming(segments[idx])]));
      if (allOriginals) {
        allOriginals.forEach((original, idx) => cancelOriginals.set(idx, original));
      }
      this.drag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        currentClientX: event.clientX,
        rangeMs: geometry.endMs - geometry.startMs,
        rowWidth: geometry.width,
        geometry,
        kind,
        track,
        index: kind === 'resize-boundary' ? boundaryIndex : index,
        indices: dragIndices,
        row,
        originals,
        cancelOriginals,
        commitIndices: new Set(dragIndices),
        started: false,
        changed: false,
        // Alt+副字幕拖动临时解除主副联动；Alt+主字幕拖动仍带着绑定的
        // 副字幕一起走，但允许先挤压主轨相邻字幕。
        independent: Boolean(event.altKey && track === 'extension'),
        allowSqueeze: false,
        squeezeOriginals: allOriginals,
        altToggleDisabledOnClick: Boolean(
          event.altKey && !targetHandle
            && !event.shiftKey && !event.ctrlKey && !event.metaKey,
        ),
        seekedOnPointerDown: false,
      };
      event.currentTarget.classList.add('dragging');
      this.pane.classList.add('cue-drag-active');
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch (_) {}
      window.addEventListener('pointermove', this._dragMove = (moveEvent) => this.moveCueDrag(moveEvent));
      window.addEventListener('pointerup', this._dragEnd = (upEvent) => this.endCueDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._dragEnd, { once: true });

      // 普通字幕块点击的跳转与波形空白区保持一致：在按下时立即移动播放头。
      // 只有普通 move 点击进入此路径；修饰键和边界手柄仍只执行选择/拖动操作。
      const clickBehavior = this.options.getClickBehavior?.();
      if (kind === 'move' && clickBehavior !== 'select-only' && !event.altKey) {
        this.seekFromCue(event, row, index, clickBehavior === 'select-and-play', geometry, track);
        this.drag.seekedOnPointerDown = true;
      }
    }

    isSharedBoundary(event, leftIndex, rightIndex, row, track = 'main') {
      const segments = this.options.getSegments(track);
      const left = segments[leftIndex];
      const right = segments[rightIndex];
      if (!left || !right || Math.abs(left.end - right.start) > SNAP_MS) return false;
      const pointerMs = this.timeFromPointer(event, row);
      return Math.abs(pointerMs - left.end) <= SNAP_MS || Math.abs(pointerMs - right.start) <= SNAP_MS;
    }

    // Alt-drag 命中共享边界手柄：只拖动被命中一侧，邻居的相反边保持不动。
    // 默认（非 Alt）拖动共享边界会把两侧一起联动；本方法是该联动的独立拆开版本。
    beginIndependentEdgeDrag(event, index, row, targetHandle, track = 'main') {
      const segments = this.options.getSegments(track);
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
      const geometry = this.captureRowGeometry(row);
      this.drag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        currentClientX: event.clientX,
        rangeMs: geometry.endMs - geometry.startMs,
        rowWidth: geometry.width,
        geometry,
        kind: 'resize-boundary-independent',
        track,
        index: movedIndex,
        edge,
        dragIndex,
        indices: [movedIndex],
        row,
        originals,
        cancelOriginals: new Map([[movedIndex, snapshotTiming(segments[movedIndex])]]),
        commitIndices: new Set([movedIndex]),
        started: false,
        changed: false,
        independent: true,
      };
      event.currentTarget.classList.add('dragging');
      this.pane.classList.add('cue-drag-active');
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch (_) {}
      window.addEventListener('pointermove', this._dragMove = (moveEvent) => this.moveCueDrag(moveEvent));
      window.addEventListener('pointerup', this._dragEnd = (upEvent) => this.endCueDrag(upEvent), { once: true });
      window.addEventListener('pointercancel', this._dragEnd, { once: true });
    }

    cueDragDurationMs() {
      return Number(this.durationMs) > 0 ? Number(this.durationMs) : Infinity;
    }

    captureCueDragOriginals(drag) {
      const segments = this.options.getSegments(drag.track || 'main');
      drag.originals = new Map(drag.indices.map((idx) => [idx, snapshotTiming(segments[idx])]));
    }

    adjustSelectedByKeyboard(deltaMs, altKey = false, track = 'main') {
      const segments = this.options.getSegments(track);
      const indices = normalizedIndices(segments, this.options.getSelection?.(track));
      if (!indices.length) return false;
      const plan = planMoveStep(
        segments,
        indices,
        deltaMs,
        this.cueDragDurationMs(),
        { sticky: !altKey },
      );
      if (!plan.changed) return false;
      this.options.onBeginEdit?.('移动字幕时间');
      const result = applyMoveStep(
        segments,
        indices,
        deltaMs,
        this.cueDragDurationMs(),
        { sticky: !altKey },
      );
      result.affectedIndices.forEach((idx) => { segments[idx]._dirty = true; });
      this.options.onCommitEdit?.(result.indices, 'move', track);
      this.refreshCueOverlay();
      return true;
    }

    adjustSelectedBoundaryByKeyboard(deltaMs, edge, altKey = false, track = 'main') {
      const segments = this.options.getSegments(track);
      const indices = normalizedIndices(segments, this.options.getSelection?.(track));
      if (!indices.length || (edge !== 'start' && edge !== 'end')) return false;
      const index = edge === 'start' ? indices[0] : indices[indices.length - 1];
      const options = { sticky: !altKey };
      const plan = planBoundaryStep(segments, index, edge, deltaMs, this.cueDragDurationMs(), options);
      if (!plan.changed) return false;
      this.options.onBeginEdit?.(`${edge === 'start' ? '调整字幕起点' : '调整字幕终点'}`);
      const result = applyBoundaryStep(
        segments,
        index,
        edge,
        deltaMs,
        this.cueDragDurationMs(),
        options,
      );
      result.affectedIndices.forEach((idx) => { segments[idx]._dirty = true; });
      this.options.onCommitEdit?.(
        result.affectedIndices,
        result.linked ? 'resize-boundary' : 'resize-boundary-independent',
        track,
      );
      this.refreshCueOverlay();
      return true;
    }

    snapSelectedCueBoundaryByKeyboard(direction, track = 'main') {
      const segments = this.options.getSegments(track);
      const indices = normalizedIndices(segments, this.options.getSelection?.(track));
      if (!indices.length || (direction !== -1 && direction !== 1)) return false;

      const index = direction < 0 ? indices[0] : indices[indices.length - 1];
      const neighborIndex = direction < 0 ? index - 1 : index + 1;
      const segment = segments[index];
      const neighbor = segments[neighborIndex];
      // 与按住字幕块时的 Shift+A/D 一样，边界不存在或无法贴合时也消费按键，
      // 避免 Shift+方向键继续触发浏览器默认行为。
      if (!segment || !neighbor) return true;

      const edge = direction < 0 ? 'start' : 'end';
      const current = Number(segment[edge]);
      const target = roundMs(direction < 0 ? neighbor.end : neighbor.start);
      const lower = edge === 'start' ? 0 : Number(segment.start) + MIN_CUE_MS;
      const upper = edge === 'start'
        ? Number(segment.end) - MIN_CUE_MS
        : this.cueDragDurationMs();
      if (!Number.isFinite(current) || !Number.isFinite(target)
          || target < lower || target > upper || target === current) return true;

      const result = applyBoundaryStep(
        segments,
        index,
        edge,
        target - current,
        this.cueDragDurationMs(),
        { sticky: false },
      );
      if (!result.changed) return true;
      this.options.onBeginEdit?.('贴近字幕边界');
      result.affectedIndices.forEach((idx) => { segments[idx]._dirty = true; });
      this.options.onCommitEdit?.(result.affectedIndices, 'resize-boundary-independent', track);
      this.refreshCueOverlay();
      return true;
    }

    adjustActiveCueDragBy(deltaMs, altKey = false) {
      const drag = this.drag;
      if (!drag) return false;
      const segments = this.options.getSegments(drag.track || 'main');
      const durationMs = this.cueDragDurationMs();
      let plan;
      let apply;
      if (drag.kind === 'move') {
        const options = { sticky: !altKey };
        plan = planMoveStep(segments, drag.indices, deltaMs, durationMs, options);
        apply = () => applyMoveStep(segments, drag.indices, deltaMs, durationMs, options);
      } else {
        const edge = drag.kind === 'resize-left' || drag.kind === 'resize-boundary-independent'
          ? 'start' : 'end';
        const options = {
          sticky: drag.kind !== 'resize-boundary-independent' && !altKey,
        };
        plan = planBoundaryStep(segments, drag.index, edge, deltaMs, durationMs, options);
        apply = () => applyBoundaryStep(segments, drag.index, edge, deltaMs, durationMs, options);
      }
      // A held drag consumes A/D even when the current edge is already at a
      // limit, so the key never falls through to subtitle navigation.
      if (!plan.changed) return true;
      if (!drag.started) {
        drag.started = true;
        const label = drag.kind === 'move' ? '移动字幕时间'
          : drag.kind === 'resize-boundary-independent' ? '独立调整字幕边界'
            : '调整字幕边界';
        this.options.onBeginEdit?.(label);
      }
      const result = apply();
      result.affectedIndices.forEach((idx) => drag.commitIndices.add(idx));
      drag.changed = true;
      this.captureCueDragOriginals(drag);
      drag.startClientX = drag.currentClientX;
      this.scheduleRefreshCueBlocks();
      return true;
    }

    handleHeldCueKey(direction, deltaMs, { shiftKey = false, altKey = false, snap = false } = {}) {
      if (!this.drag) return false;
      if (shiftKey) {
        if (snap && !altKey) this.snapActiveCueBoundaryByKeyboard(direction);
        // 按住字幕块时即使吸附不可用也要消费按键，不能穿透成普通导航。
        return true;
      }
      this.adjustActiveCueDragBy(deltaMs, altKey);
      return true;
    }

    snapActiveCueBoundaryByKeyboard(direction) {
      const drag = this.drag;
      if (!drag || drag.kind !== 'move' || (direction !== -1 && direction !== 1)) return false;
      const segments = this.options.getSegments(drag.track || 'main');
      const indices = normalizedIndices(segments, drag.indices);
      if (!indices.length) return true;

      const index = direction < 0 ? indices[0] : indices[indices.length - 1];
      const neighborIndex = direction < 0 ? index - 1 : index + 1;
      const segment = segments[index];
      const neighbor = segments[neighborIndex];
      // 与普通 A/D 一样，按住字幕块时即使已经到达边界也要消费按键，
      // 避免 Shift+A/D 穿透成“选择前后字幕”。
      if (!segment || !neighbor) return true;

      const edge = direction < 0 ? 'start' : 'end';
      const current = Number(segment[edge]);
      const target = roundMs(direction < 0 ? neighbor.end : neighbor.start);
      const lower = edge === 'start' ? 0 : Number(segment.start) + MIN_CUE_MS;
      const upper = edge === 'start'
        ? Number(segment.end) - MIN_CUE_MS
        : this.cueDragDurationMs();
      if (!Number.isFinite(current) || !Number.isFinite(target)
          || target < lower || target > upper || target === current) return true;

      if (!drag.started) {
        drag.started = true;
        this.options.onBeginEdit?.('贴近字幕边界');
      }
      const original = snapshotTiming(segment);
      segment[edge] = target;
      segment.items = remapItems(
        original.items,
        original.start,
        original.end,
        segment.start,
        segment.end,
      );
      drag.commitIndices.add(index);
      drag.changed = true;
      this.captureCueDragOriginals(drag);
      drag.startClientX = drag.currentClientX;
      this.scheduleRefreshCueBlocks();
      return true;
    }

    cancelCueDrag() {
      if (this.createCueDrag?.finish) {
        this.createCueDrag.finish(false);
        this.setStatus('已取消新增字幕');
        return true;
      }
      const drag = this.drag;
      if (!drag) return false;
      window.removeEventListener('pointermove', this._dragMove);
      window.removeEventListener('pointerup', this._dragEnd);
      window.removeEventListener('pointercancel', this._dragEnd);
      const segments = this.options.getSegments(drag.track || 'main');
      drag.cancelOriginals.forEach((original, idx) => {
        const segment = segments[idx];
        if (!segment) return;
        segment.start = original.start;
        segment.end = original.end;
        segment.items = Array.isArray(original.items)
          ? original.items.map((item) => ({ ...item })) : original.items;
      });
      this.content.querySelectorAll('.waveform-cue-block.dragging')
        .forEach((block) => block.classList.remove('dragging'));
      this.pane.classList.remove('cue-drag-active');
      this.drag = null;
      this.refreshCueOverlay();
      this.setStatus('已取消字幕调整');
      return true;
    }

    applyIndependentBoundaryDrag(drag, rawDelta) {
      const segments = this.options.getSegments(drag.track);
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
      this.scheduleGapPreview(drag);
    }

    scheduleGapPreview(drag) {
      // 与字幕块拖拽同理：合并到每帧最多一次预览重排
      if (this.gapPreviewFrame) return;
      this.gapPreviewFrame = requestAnimationFrame(() => {
        this.gapPreviewFrame = 0;
        if (this.gapBoundaryDrag === drag) this.previewGapBoundaryDrag(drag);
      });
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
      drag.currentClientX = event.clientX;
      const deltaMs = ((event.clientX - drag.startClientX) / drag.rowWidth) * drag.rangeMs;
      if (!drag.started && Math.abs(deltaMs) < 2) return;
      if (!drag.started) {
        drag.started = true;
        const label = drag.kind === 'move' ? '移动字幕时间'
          : drag.kind === 'resize-boundary-independent' ? '独立调整字幕边界'
          : '调整字幕边界';
        this.options.onBeginEdit(label);
      }
      // 一旦在本次拖动中进入 Alt 独立模式，松开 Alt 也不要把已经独立
      // 调整过的字幕重新吸回绑定对象；关系仍保留，下一次普通拖动再联动。
      if (drag.kind === 'move' && event.altKey) drag.allowSqueeze = true;
      if (drag.track === 'extension' && event.altKey) drag.independent = true;
      const disableSnap = drag.independent === true || drag.allowSqueeze === true;
      if (drag.kind === 'move') this.applyMoveDrag(drag, deltaMs, disableSnap, drag.allowSqueeze);
      else if (drag.kind === 'resize-boundary') this.applyBoundaryDrag(drag, deltaMs, drag.independent);
      else if (drag.kind === 'resize-boundary-independent') this.applyIndependentBoundaryDrag(drag, deltaMs);
      else this.applyResizeDrag(drag, deltaMs, drag.independent);
      this.options.syncBoundCueDrag?.(drag);
      drag.changed = true;
      this.scheduleRefreshCueBlocks();
    }

    applyMoveDrag(drag, rawDelta, disableSnap, allowSqueeze = false) {
      const segments = this.options.getSegments(drag.track);
      const moved = new Set(drag.indices);
      const originalFor = (idx) => drag.squeezeOriginals?.get(idx)
        || drag.originals.get(idx) || snapshotTiming(segments[idx]);
      const restoreSegment = (idx, original) => {
        const segment = segments[idx];
        if (!segment || !original) return;
        segment.start = original.start;
        segment.end = original.end;
        segment.items = Array.isArray(original.items)
          ? original.items.map((item) => ({ ...item })) : original.items;
      };
      if (allowSqueeze && drag.squeezeOriginals) {
        drag.squeezeOriginals.forEach((original, idx) => {
          if (!moved.has(idx)) restoreSegment(idx, original);
        });
      }
      let minDelta = -Infinity;
      let maxDelta = Infinity;
      for (const idx of drag.indices) {
        const original = drag.originals.get(idx);
        minDelta = Math.max(minDelta, -original.start);
        maxDelta = Math.min(maxDelta, this.durationMs - original.end);
        if (allowSqueeze) {
          let previousIndex = idx - 1;
          while (previousIndex >= 0 && moved.has(previousIndex)) previousIndex -= 1;
          if (previousIndex >= 0) {
            const previous = originalFor(previousIndex);
            minDelta = Math.max(minDelta, previous.start + MIN_CUE_MS - original.start);
          }
          let nextIndex = idx + 1;
          while (nextIndex < segments.length && moved.has(nextIndex)) nextIndex += 1;
          if (nextIndex < segments.length) {
            const next = originalFor(nextIndex);
            maxDelta = Math.min(maxDelta, next.end - MIN_CUE_MS - original.end);
          }
        } else {
          if (idx > 0 && !moved.has(idx - 1)) minDelta = Math.max(minDelta, segments[idx - 1].end - original.start);
          if (idx + 1 < segments.length && !moved.has(idx + 1)) {
            maxDelta = Math.min(maxDelta, segments[idx + 1].start - original.end);
          }
        }
      }
      let delta = rawDelta;
      if (!disableSnap) {
        const candidates = [];
        const playhead = this.currentTimeMs();
        const crossTrackTargets = this.options.getCrossTrackSnapTargets?.(drag.track) || [];
        for (const idx of drag.indices) {
          const original = drag.originals.get(idx);
          candidates.push(playhead - original.start, playhead - original.end);
          if (idx > 0 && !moved.has(idx - 1)) candidates.push(segments[idx - 1].end - original.start);
          if (idx + 1 < segments.length && !moved.has(idx + 1)) {
            candidates.push(segments[idx + 1].start - original.end);
          }
          crossTrackTargets.forEach((target) => {
            candidates.push(target - original.start, target - original.end);
          });
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
      if (allowSqueeze) {
        for (const idx of drag.indices) {
          const segment = segments[idx];
          let previousIndex = idx - 1;
          while (previousIndex >= 0 && moved.has(previousIndex)) previousIndex -= 1;
          if (previousIndex >= 0) {
            const previous = segments[previousIndex];
            const previousOriginal = originalFor(previousIndex);
            if (previous && previous.end > segment.start) {
              const nextEnd = Math.max(previousOriginal.start + MIN_CUE_MS, segment.start);
              if (nextEnd < previous.end) {
                previous.end = nextEnd;
                previous.items = remapItems(
                  previousOriginal.items,
                  previousOriginal.start,
                  previousOriginal.end,
                  previous.start,
                  previous.end,
                );
                drag.commitIndices.add(previousIndex);
              }
            }
          }
          let nextIndex = idx + 1;
          while (nextIndex < segments.length && moved.has(nextIndex)) nextIndex += 1;
          if (nextIndex < segments.length) {
            const next = segments[nextIndex];
            const nextOriginal = originalFor(nextIndex);
            if (next && segment.end > next.start) {
              const nextStart = Math.min(nextOriginal.end - MIN_CUE_MS, segment.end);
              if (nextStart > next.start) {
                next.start = nextStart;
                next.items = remapItems(
                  nextOriginal.items,
                  nextOriginal.start,
                  nextOriginal.end,
                  next.start,
                  next.end,
                );
                drag.commitIndices.add(nextIndex);
              }
            }
          }
        }
      }
      this.setStatus(`${allowSqueeze ? '挤压移动' : '移动'} ${drag.indices.length} 条 · ${delta >= 0 ? '+' : ''}${delta} ms`);
    }

    applyResizeDrag(drag, rawDelta, disableSnap) {
      const segments = this.options.getSegments(drag.track);
      const segment = segments[drag.index];
      const original = drag.originals.get(drag.index);
      let newStart = original.start;
      let newEnd = original.end;
      if (drag.kind === 'resize-left') {
        const lower = drag.index > 0 ? segments[drag.index - 1].end : 0;
        const upper = original.end - MIN_CUE_MS;
        newStart = original.start + rawDelta;
        if (!disableSnap) {
          const targets = [lower, this.currentTimeMs(), ...(
            this.options.getCrossTrackSnapTargets?.(drag.track) || []
          )];
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
          const targets = [upper, this.currentTimeMs(), ...(
            this.options.getCrossTrackSnapTargets?.(drag.track) || []
          )];
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
      const segments = this.options.getSegments(drag.track);
      const left = drag.originals.get(drag.index);
      const right = drag.originals.get(drag.index + 1);
      if (!left || !right) return;
      let boundary = left.end + rawDelta;
      const lower = left.start + MIN_CUE_MS;
      const upper = right.end - MIN_CUE_MS;
      if (!disableSnap) {
        const candidates = [this.currentTimeMs(), ...(
          this.options.getCrossTrackSnapTargets?.(drag.track) || []
        )];
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
      this.pane.classList.remove('cue-drag-active');
      this.drag = null;
      if (event.type === 'pointercancel') {
        drag.cancelOriginals.forEach((original, idx) => {
          const segment = this.options.getSegments(drag.track || 'main')[idx];
          if (!segment) return;
          segment.start = original.start;
          segment.end = original.end;
          segment.items = Array.isArray(original.items)
            ? original.items.map((item) => ({ ...item })) : original.items;
        });
        this.refreshCueOverlay();
        return;
      }
      if (!drag.changed) {
        if (drag.altToggleDisabledOnClick) {
          this.options.toggleDisabled?.([drag.index], drag.track || 'main');
          return;
        }
        // select-only 只选中；两个跳转模式按设置跳到字幕开头或鼠标位置。
        const clickBehavior = this.options.getClickBehavior?.();
        if (clickBehavior !== 'select-only' && !drag.seekedOnPointerDown) {
          this.seekFromCue(event, drag.row, drag.index, clickBehavior === 'select-and-play', drag.geometry, drag.track);
        }
        return;
      }
      const commitIndices = [...(drag.commitIndices || drag.indices)];
      const segments = this.options.getSegments(drag.track || 'main');
      commitIndices.forEach((idx) => { if (segments[idx]) segments[idx]._dirty = true; });
      this.options.onCommitEdit(commitIndices, drag.kind, drag.track || 'main', drag.independent === true);
      this.refreshCueOverlay();
    }

    updatePlayback(allowFollow = true) {
      if (!this.payload) return;
      const now = this.currentTimeMs();
      const segments = this.options.getSegments('main');
      const activeIndex = findActiveCueIndex(segments, now);
      if (activeIndex !== this.activeIndex) {
        this.activeIndex = activeIndex;
        this.content.querySelectorAll('.waveform-cue-block[data-track="main"]').forEach((block) => {
          block.classList.toggle('active', Number(block.dataset.idx) === activeIndex);
        });
      }
      const extensionSegments = this.options.getExtensionSegments?.() || [];
      const activeExtensionIndex = findActiveCueIndex(extensionSegments, now);
      this.content.querySelectorAll('.waveform-cue-block[data-track="extension"]').forEach((block) => {
        block.classList.toggle('active', Number(block.dataset.extIdx) === activeExtensionIndex);
      });

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
          this.scroll.scrollTo({
            top: Math.max(0, rowIndex * (this.settings.rowHeight + ROW_GAP) - this.scroll.clientHeight * 0.35),
            behavior: 'smooth',
          });
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
    builtinWorkspaceIds: BUILTIN_WORKSPACE_IDS,
    builtinWorkspaces: BUILTIN_WORKSPACES,
    testing: {
      decodePayload,
      decodeSpectralPayload,
      freqColor,
      remapItems,
      roundMs,
      sourceForFile,
      applySharedBoundary,
      applyIndependentEdge,
      applyMoveStep,
      applyBoundaryStep,
      splitSegmentAtTime,
      normalizeNewCueRange,
      clampWaveformScale,
      wheelScrollDelta,
      waveformScaleAfterStep,
      waveformAmplitude,
      sampleInterpolatedPeak,
      normalizeLayoutData,
      swapLayoutModuleOrder,
      normalizeLayoutTree,
      collectLayoutModules,
      swapLayoutTreeModules,
      insertLayoutModuleAtEdge,
      insertLayoutModuleAtRootEdge,
      layoutDropIntent,
      layoutRootDropIntent,
      layoutDropPreviewRect,
      computeGroupBadges,
    },
  };
  if (window.MAWE?.register) {
    window.MAWE.register('waveform', () => window.AsrWaveform);
  }
})();

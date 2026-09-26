// layout: waveform helpers with explicit dependencies.
window.MAWE.register('waveform-layout', function createWaveformModule(dependencies) {
  'use strict';
  const { DEFAULT_LAYOUT_ROWS, ROW_HEIGHT_PRESETS, ROW_PRESETS, WORKSPACE_SCHEMA, ZOOM_PRESETS, clamp, clampWaveformScale } = dependencies;


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
    // 振幅是否仍由响度自动决定。跟着工程走，不进 localStorage：
    // waveformScale 的活跃值存在浏览器全局偏好里，用「等于默认值」或 -1 哨兵
    // 都无法判断「这个工程还没定过振幅」——新工程拿到的是上个工程留下的数字。
    waveformScaleAuto: true,
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
        // 预设自己指定了振幅，就是预设已经替用户做了决定，不能再被响度自动覆盖。
        waveformScaleAuto: false,
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
        waveformScaleAuto: false,
        side: 'left', disabledDisplay: 'dim', showGroupBadges: true, dragPlayhead: true,
      },
      splitPercent: 60, columnPercent: 36, rows: [42, 18, 40], tree: CINEMA_SCREEN_LAYOUT_TREE,
      editorDisplay: CINEMA_SCREEN_EDITOR_DISPLAY,
    },
  };


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
      // 必须显式产出这个键（而不是缺字段时省略）：applyLayoutData 用
      // Object.assign 增量合并，省略会让上一个工程的 false 残留到新工程上。
      // 老工程没写过该字段 → 不等于 false → true，升级后照样吃到自动缩放。
      waveformScaleAuto: rawWaveformSettings.waveformScaleAuto !== false,
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

  return Object.freeze({ BUILTIN_WORKSPACES, BUILTIN_WORKSPACE_IDS, DEFAULT_RIGHT_LAYOUT_TREE, DEFAULT_SETTINGS, MODULE_LABELS, cloneLayoutTree, collectLayoutModules, directionLabel, insertLayoutModuleAtEdge, insertLayoutModuleAtRootEdge, isCompleteLayoutTree, layoutDropIntent, layoutDropPreviewRect, layoutRootDropIntent, normalizeLayoutData, normalizeLayoutRows, normalizeLayoutTree, swapLayoutModuleOrder, swapLayoutTreeModules });
});

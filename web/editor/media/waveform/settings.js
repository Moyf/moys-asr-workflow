// settings: waveform helpers with explicit dependencies.
window.MAWE.register('waveform-settings', function createWaveformModule(dependencies) {
  'use strict';
  const { storage, DEFAULT_RIGHT_LAYOUT_TREE, DEFAULT_SETTINGS, ROW_HEIGHT_PRESETS, ROW_PRESETS, SETTINGS_KEY, ZOOM_PRESETS, clampWaveformScale, cloneLayoutTree, normalizeLayoutData } = dependencies;


  function readSettings() {
    try {
      const parsed = JSON.parse(storage.getItem(SETTINGS_KEY) || '{}');
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
        // 刻意不从 localStorage 读：振幅的活跃值是浏览器全局的，而「这个工程
        // 定过振幅没有」只能跟着工程走。工程 workspace 随后会用 applyLayoutData
        // 覆盖它，这里给出的是「尚无工程决定」的初值。
        waveformScaleAuto: true,
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
      storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {
      // file:// privacy modes may reject localStorage; the editor still works.
    }
  }

  return Object.freeze({ readSettings, saveSettings });
});

// 显示设置：字幕列表/编辑区显示项应用、多重字幕行高联动与平台按键标签。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweDisplaySettings 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
import { getOverlayTrack } from '../cues/overlay-track.js';

export function initMaweDisplaySettings() {
  'use strict';

  // 装配器无参调用；宿主对象固定为当前页面 window。
  // 顶层 DOM 查询/监听随函数体在装配器调用位次执行，时机不变（G07 gate）。
  const global = window;



  function applyCueListDisplaySettings({ preserveCueListScroll = true } = {}) {
  const cueListAnchor = preserveCueListScroll ? MaweCueListAnchor.captureCueListRenderAnchor() : null;
  MaweDom.cueListShowIndexToggle.checked = MaweSettings.EDITOR_SETTINGS.cueListShowIndex;
  MaweDom.cueListShowTimeToggle.checked = MaweSettings.EDITOR_SETTINGS.cueListShowTime;
  MaweDom.cueListShowStickerToggle.checked = MaweSettings.EDITOR_SETTINGS.cueListShowSticker;
  MaweDom.cueListShowCharcountToggle.checked = MaweSettings.EDITOR_SETTINGS.cueListShowCharcount;
  MaweDom.cueListAutoScrollOnClickToggle.checked = MaweSettings.EDITOR_SETTINGS.cueListAutoScrollOnClick;
  MaweDom.cueListKeepSplitVisibleToggle.checked = MaweSettings.EDITOR_SETTINGS.cueListKeepSplitVisible;
  MaweCueElements.syncCharCountThresholdInputs(MaweSettings.EDITOR_SETTINGS.cueListCharcountThreshold);
  MaweDom.hideDisabled = MaweSettings.EDITOR_SETTINGS.cueListHideDisabled;
  MaweDom.hideDisabledToggle.checked = MaweDom.hideDisabled;
  MaweCoreState.container.classList.toggle('hide-disabled', MaweDom.hideDisabled);
  MaweCoreState.container.classList.toggle('hide-cue-index', !MaweSettings.EDITOR_SETTINGS.cueListShowIndex);
  MaweCoreState.container.classList.toggle('hide-cue-time', !MaweSettings.EDITOR_SETTINGS.cueListShowTime);
  // 设置保留用户的显示偏好；当前工程完全没有表情包时，整列仍自动收起，
  // 分配首个表情包时由本函数根据最新数据直接恢复。
  const overlaySegments = getOverlayTrack()?.segments || [];
  const projectHasStickers = window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.some(segment => segment.sticker_group_id)
    || overlaySegments.some(segment => segment.sticker_group_id);
  MaweCoreState.container.classList.toggle('hide-cue-sticker',
    !MaweSettings.EDITOR_SETTINGS.cueListShowSticker || !projectHasStickers,
  );
  MaweCoreState.container.classList.toggle('hide-cue-charcount', !MaweSettings.EDITOR_SETTINGS.cueListShowCharcount);
  MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
}



  let previousMultiSubtitlePreviewEnabled = false;


  let waveformRowHeightBeforeModes = null;
  let secondsPerRowBeforeWordTiming = null;
  const waveformModes = [];


  // 字词码/双语字幕等开关联动会自动改行高或每行长度：多行模式按新几何
  // 重建后，原有像素 scrollTop 不再对准原时间位置。锚点取「正在看的
  // 位置」而不是播放头——播放头在屏外时把播放头 reveal 进画面等于把
  // 视口整个带走（#20 复测结论）。几何写入前捕获视口中心时间，重渲染
  // 完成后把该时间滚回画面内（revealTime 自带舒适区守卫：目标仍在可视
  // 范围内就不滚动）；播放头恰好可见时视口中心≈播放头，效果与旧行为等价。
  // 取时差异：basic 用可视窗口的水平中点（timeMsAtPoint 命中窗口中心的
  // 等价算术，不受吸附与浮窗遮挡影响）；multi 用视口垂直中点命中的可视
  // 行、取该行行内中点时间——还原（revealTime）按行粒度定位，行内精确
  // 位置不影响结果，且不依赖 elementFromPoint（设置浮窗盖住波形中心、
  // 中心点落在行间隙时仍能取到锚点）。
  function captureWaveformViewportCenterTimeMs(editor) {
    if (!editor?.scroll) return null;
    if (!editor.isMultiMode?.()) {
      const windowMs = Number(editor.settings?.visibleSeconds) * 1000;
      if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
      const startMs = Number(editor.basicWindowStartMs);
      return (Number.isFinite(startMs) ? Math.max(0, startMs) : 0) + windowMs / 2;
    }
    const scrollRect = editor.scroll.getBoundingClientRect();
    if (!scrollRect.height) return null;
    const centerY = scrollRect.top + scrollRect.height / 2;
    let centerRowTimeMs = null;
    let nearestDistance = Infinity;
    (editor.content?.querySelectorAll?.('.waveform-row') || []).forEach((row) => {
      const rect = row.getBoundingClientRect();
      if (!rect.height) return;
      const startMs = Number(row.dataset.startMs);
      const endMs = Number(row.dataset.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return;
      // 中心点落在行间隙时取最近一行兜底；同行内水平位置不影响按行还原。
      const distance = centerY < rect.top ? rect.top - centerY
        : centerY > rect.bottom ? centerY - rect.bottom : 0;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        centerRowTimeMs = (startMs + endMs) / 2;
      }
    });
    return centerRowTimeMs;
  }

  function restoreWaveformViewportAfterGeometryChange(editor, anchorTimeMs) {
    if (!editor || !Number.isFinite(anchorTimeMs) || typeof editor.revealTime !== 'function') return;
    // behavior:'auto' 瞬时定位：几何切换刚完成一次全量重建，smooth 滚动
    // 动画会在随后数百毫秒内逐帧增量重建词密可视行，把卡顿再放大一轮；
    // 锚点还原不需要动画，视口直接就位。其他 revealTime 调用方不受影响。
    editor.revealTime(anchorTimeMs, true, { behavior: 'auto' });
  }


  function applyWaveformModeRowHeight({ render = true, minimumHeight = null } = {}) {
    const editor = MaweCoreState.waveformEditor;
    if (!editor) return;
    const heights = [waveformRowHeightBeforeModes, minimumHeight];
    for (const mode of waveformModes) {
      heights.push(mode === 'word' ? MaweSettings.EDITOR_SETTINGS.wordTimingRowHeight
        : MaweSettings.EDITOR_SETTINGS.multiSubtitleRowHeight);
    }
    const height = Math.max(...heights.filter(Number.isFinite));
    const rowHeightBefore = editor.settings.rowHeight;
    // 锚点在 setRowHeight 写入新几何之前捕获（render:false 的调用方由外层
    // 在其统一 render 后自行还原，这里不捕获）。
    const anchorTimeMs = render ? captureWaveformViewportCenterTimeMs(editor) : null;
    if (Number.isFinite(height)) editor.setRowHeight(height, { render });
    // render:false 的调用方（字词码开关联动）在其统一 render 之后再回滚视口；
    // 高度只增不减（预设为下限），真变化才回滚，避免无谓跳动。
    if (render && editor.settings.rowHeight !== rowHeightBefore) {
      restoreWaveformViewportAfterGeometryChange(editor, anchorTimeMs);
    }
  }

  // 预设仅作为高度下限：开启任一模式不缩小现有行高；关闭时重新计算
  // 剩余模式需要的下限，全部关闭后恢复共享的原始行高。
  function syncWaveformModeRowHeight(mode, enabled, { render = true } = {}) {
    const editor = MaweCoreState.waveformEditor;
    if (!editor) return;
    const index = waveformModes.indexOf(mode);
    if (enabled === (index >= 0)) return;
    if (enabled) {
      if (!waveformModes.length) waveformRowHeightBeforeModes = editor.getRowHeight();
      waveformModes.push(mode);
    } else {
      waveformModes.splice(index, 1);
    }
    applyWaveformModeRowHeight({ render, minimumHeight: enabled ? editor.getRowHeight() : null });
    if (!waveformModes.length) waveformRowHeightBeforeModes = null;
  }

  function syncMultiSubtitleWaveformRowHeight(enabled) {
    syncWaveformModeRowHeight('multi', enabled);
  }



  // 每行长度仅受字词模式影响，与两个模式的行高恢复分开处理。
  // 每行长度按「可见范围大小」排序：秒数越小，可见范围越大、波形越大。
  // 字词码适配长度是上限：开启字词模式只放大可见范围（Math.min 收紧秒数），
  // 绝不把秒数抬到用户当前值之上（那会缩小波形）；关闭后恢复原值。
  function syncWordTimingWaveformSettings(enabled) {
    const editor = MaweCoreState.waveformEditor;
    if (!editor) return;
    const wasEnabled = waveformModes.includes('word');
    const secondsPerRowBefore = editor.settings.secondsPerRow;
    const rowHeightBefore = editor.settings.rowHeight;
    // 锚点在第一个几何写入（setSecondsPerRow/setRowHeight）之前捕获。
    const anchorTimeMs = captureWaveformViewportCenterTimeMs(editor);
    if (enabled && !wasEnabled) {
      secondsPerRowBeforeWordTiming = editor.settings.secondsPerRow;
      editor.setSecondsPerRow(Math.min(secondsPerRowBeforeWordTiming,
        MaweSettings.EDITOR_SETTINGS.wordTimingSecondsPerRow), { render: false });
    } else if (!enabled && wasEnabled) {
      editor.setSecondsPerRow(secondsPerRowBeforeWordTiming, { render: false });
      secondsPerRowBeforeWordTiming = null;
    }
    syncWaveformModeRowHeight('word', enabled, { render: false });
    // 两个预设一起落地后只绘制一次。单行模式不使用这些几何预设，
    // 切换字词只需调用方刷新字幕层，保留 Canvas 和当前水平视窗。
    if (enabled !== wasEnabled && editor.isMultiMode()) {
      editor.render();
      // 行高或每行长度确实被预设改变时，重渲染后的像素 scrollTop 不再
      // 对准原时间；把切换前正在看的位置滚回画面内，避免改完设置找不到
      // 原位置（播放头恰好可见时效果与滚回播放头等价）。
      if (editor.settings.secondsPerRow !== secondsPerRowBefore
        || editor.settings.rowHeight !== rowHeightBefore) {
        restoreWaveformViewportAfterGeometryChange(editor, anchorTimeMs);
      }
      return true;
    }
    return false;
  }

  // 字词模式激活时按「基线与预设中较小的秒数」应用每行长度（预设是上限），
  // 供设置面板在字词模式启用中变更适配长度时调用；未启用时不做任何事。
  function applyWordTimingSecondsPerRow() {
    const editor = MaweCoreState.waveformEditor;
    if (!editor || !waveformModes.includes('word')) return false;
    const before = editor.settings.secondsPerRow;
    // 锚点在 setSecondsPerRow 写入新几何之前捕获。
    const anchorTimeMs = captureWaveformViewportCenterTimeMs(editor);
    editor.setSecondsPerRow(Math.min(secondsPerRowBeforeWordTiming,
      MaweSettings.EDITOR_SETTINGS.wordTimingSecondsPerRow));
    // 每行长度变化重建几何后，原像素 scrollTop 不再对准原时间，滚回切换
    // 前正在看的位置；setSecondsPerRow 对同值 no-op，此处以实际变化为准
    // 避免无谓滚动。
    if (editor.settings.secondsPerRow !== before) {
      restoreWaveformViewportAfterGeometryChange(editor, anchorTimeMs);
    }
    return true;
  }



  function updateMultiSubtitleUi() {
  window.MaweProjectSettings?.syncTrackControls();
  // 「允许字幕重叠」开关常驻工具栏；勾选状态跟随用户意图（overlay.enabled），
  // 不要求叠加轨已有字幕，否则空轨道时勾选会被立即弹回。
  if (window.MaweDomPanelsWiring.overlayTrackSeparator) window.MaweDomPanelsWiring.overlayTrackSeparator.hidden = window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length === 0;
  if (window.MaweDomPanelsWiring.overlayTrackToggle) window.MaweDomPanelsWiring.overlayTrackToggle.checked = getOverlayTrack()?.enabled === true;
  const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
  const hasTrack = Boolean(track && Array.isArray(track.segments));
  const enabled = hasTrack && MaweMultiSubtitleCore.getActiveExtensionTrack()?.enabled === true;
  const hasMainSubtitle = window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length > 0;
  const enteringEnabled = enabled && !previousMultiSubtitlePreviewEnabled;
  const leavingEnabled = !enabled && previousMultiSubtitlePreviewEnabled;
  syncMultiSubtitleWaveformRowHeight(enabled, enteringEnabled, leavingEnabled);
  MaweSplitMode.refreshMergeJoinModeHint();
  if (MaweDom.multiSubtitleEmptyHint) {
    MaweSettingsPanels.updateRegionalSettingsAvailability();
    MaweDom.multiSubtitleEmptyHint.hidden = !(enabled && !track.segments.length);
    // 「显示」分组（字幕列表显示 / 自动适配高度 / 轨道徽标）仅在双语开启且副轨有内容时显示。
    if (MaweDom.multiSubtitleDisplaySection) {
      MaweDom.multiSubtitleDisplaySection.hidden = !(enabled && track.segments.length);
    }
  }
  if (MaweDom.multiSubtitleToggle) {
    // 勾选状态跟随「多重字幕编辑模式」开关本身：未导入副轨时同样保持勾选。
    MaweDom.multiSubtitleToggle.checked = MaweMultiSubtitleCore.getActiveExtensionTrack()?.enabled === true;
    // 开启时创建空副轨；导入第二条字幕是可选操作。
    MaweDom.multiSubtitleToggle.disabled = false;
  }
  if (MaweDom.multiSubtitleToggleLabel) {
    MaweDom.multiSubtitleToggleLabel.classList.remove('disabled');
    MaweDom.multiSubtitleToggleLabel.title = MaweMultiSubtitleCore.MULTI_SUBTITLE_TOGGLE_TITLE;
  }
  if (MaweDom.multiSubtitleToggle) MaweDom.multiSubtitleToggle.title = MaweMultiSubtitleCore.MULTI_SUBTITLE_TOGGLE_TITLE;
  if (MaweDom.multiSubtitleDisplayMode) {
    MaweDom.multiSubtitleDisplayMode.value = MaweBoot.DATA.bilingual.display_mode || 'both';
    MaweDom.multiSubtitleDisplayMode.disabled = !enabled;
  }
  if (MaweDom.multiSubtitleMainLanguageMode) {
    MaweDom.multiSubtitleMainLanguageMode.value = MaweMultiSubtitleCore.getMainSubtitleSplitMode(window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[0]);
    MaweDom.multiSubtitleMainLanguageMode.hidden = false;
  }
  if (MaweDom.multiSubtitleExtensionLanguageMode) {
    MaweDom.multiSubtitleExtensionLanguageMode.value = MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, track?.segments?.[0]);
    MaweDom.multiSubtitleExtensionLanguageMode.closest('.multi-subtitle-setting-row').hidden = !enabled;
  }
  if (MaweDom.multiSubtitleExtensionRowHeight) {
    MaweDom.multiSubtitleExtensionRowHeight.value = String(MaweSettings.EDITOR_SETTINGS.multiSubtitleRowHeight);
    MaweDom.multiSubtitleExtensionRowHeight.disabled = !enabled;
  }
  if (MaweDom.wordTimingRowHeight) {
    MaweDom.wordTimingRowHeight.value = String(MaweSettings.EDITOR_SETTINGS.wordTimingRowHeight);
  }
  if (MaweDom.wordTimingSecondsPerRow) {
    MaweDom.wordTimingSecondsPerRow.value = String(MaweSettings.EDITOR_SETTINGS.wordTimingSecondsPerRow);
  }
  // 波形工具栏的「双语 / 重叠」快捷开关：aria 状态与对应工程设置开关保持一致。
  const multiQuickToggle = document.getElementById('multi-subtitle-quick-toggle');
  if (multiQuickToggle) {
    const multiEnabled = MaweMultiSubtitleCore.getActiveExtensionTrack()?.enabled === true;
    multiQuickToggle.classList.toggle('active', multiEnabled);
    multiQuickToggle.setAttribute('aria-pressed', String(multiEnabled));
  }
  const overlayQuickToggle = document.getElementById('overlay-quick-toggle');
  if (overlayQuickToggle) {
    const overlayEnabled = getOverlayTrack()?.enabled === true;
    overlayQuickToggle.classList.toggle('active', overlayEnabled);
    overlayQuickToggle.setAttribute('aria-pressed', String(overlayEnabled));
  }
  if (MaweDom.multiSubtitleCrossTrackSnapToggle) {
    MaweDom.multiSubtitleCrossTrackSnapToggle.checked = MaweSettings.EDITOR_SETTINGS.crossTrackSnap;
    MaweDom.multiSubtitleCrossTrackSnapToggle.disabled = !enabled;
  }
  if (MaweDom.multiSubtitleSelectBoundPairToggle) {
    MaweDom.multiSubtitleSelectBoundPairToggle.checked = MaweSettings.EDITOR_SETTINGS.selectBoundSubtitlePair;
    MaweDom.multiSubtitleSelectBoundPairToggle.disabled = !enabled;
  }
  if (MaweDom.multiSubtitleAutoSyncDurationToggle) {
    MaweDom.multiSubtitleAutoSyncDurationToggle.checked = MaweSettings.EDITOR_SETTINGS.multiSubtitleAutoSyncDuration;
    MaweDom.multiSubtitleAutoSyncDurationToggle.disabled = !enabled;
  }
  if (MaweDom.multiSubtitleShowTrackBadgesToggle) {
    MaweDom.multiSubtitleShowTrackBadgesToggle.checked = MaweSettings.EDITOR_SETTINGS.multiSubtitleShowTrackBadges;
    MaweDom.multiSubtitleShowTrackBadgesToggle.disabled = !enabled;
  }
  if (MaweDom.multiSubtitleSwapButton) {
    const canSwap = enabled
      && window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments.length > 0 && (track?.segments || []).length > 0;
    MaweDom.multiSubtitleSwapButton.disabled = !canSwap;
    MaweDom.multiSubtitleSwapButton.title = canSwap
      ? '交换主字幕和副字幕的文本、时间与绑定关系'
      : '需要已开启双语字幕且主副轨都有字幕';
  }
  if (MaweDom.multiSubtitleWaveformControls) MaweDom.multiSubtitleWaveformControls.hidden = !enabled;
  if (MaweDom.multiSubtitleAlignButton) MaweDom.multiSubtitleAlignButton.hidden = !enabled;
  if (MaweDom.extensionOverlayToggleWrap) MaweDom.extensionOverlayToggleWrap.hidden = !enabled;
  if (MaweDom.extensionSubtitlePreviewTitle) MaweDom.extensionSubtitlePreviewTitle.hidden = !enabled;
  if (MaweDom.extensionSubtitlePreviewSettings) MaweDom.extensionSubtitlePreviewSettings.hidden = !enabled;
  if (MaweDom.extensionOverlayToggle) {
    if (enteringEnabled) MaweSettings.updateEditorSettings({ extensionOverlayEnabled: true });
    MaweDom.extensionOverlayToggle.checked = enabled
      ? (enteringEnabled || MaweSettings.EDITOR_SETTINGS.extensionOverlayEnabled)
      : false;
  }
  previousMultiSubtitlePreviewEnabled = enabled;
  // 「仅看超长」按单轨文本字数筛选；多重字幕开启后主/副两栏合并计数失去筛选意义，
  // 隐藏入口（含前面的分隔线）。若筛选已激活则一并复位，避免残留不可见的过滤状态。
  const filterOverButton = document.getElementById('filter-over');
  if (filterOverButton) {
    filterOverButton.hidden = enabled;
    const filterOverSep = document.getElementById('filter-over-sep');
    if (filterOverSep) filterOverSep.hidden = enabled;
    if (enabled && filterOverButton.classList.contains('active')) {
      filterOverButton.classList.remove('active');
      MaweCueElements.clearTemporaryVisibleSplitCues();
      MaweSearch.applySearch(MaweDom.searchEl.value);
    }
  }
  MaweCoreState.container.classList.toggle('multi-subtitle-enabled', enabled);
  MaweCoreState.container.dataset.multiDisplayMode = enabled ? (MaweBoot.DATA.bilingual.display_mode || 'both') : 'main';
  // 多重字幕开合影响副字幕相关的 ASS 样式入口（设置页副字幕组、样式库
  // 副字幕槽位），同步刷新它们的可见性与选项。
  window.MaweAssManagerWiring.syncAssModeDependentControls();
  window.MaweAssManagerWiring.syncAssStyleManager();
}



  function bindCueListDisplayToggle(toggle, key) {
    toggle.addEventListener('change', () => {
      MaweSettings.updateEditorSettings({ [key]: toggle.checked });
      applyCueListDisplaySettings();
    });
  }



  function applyCueEditorDisplaySettings() {
    MaweDom.cueEditorShowNavigationToggle.checked = MaweSettings.EDITOR_SETTINGS.cueEditorShowNavigation;
    MaweDom.cueEditorShowTimeActionsToggle.checked = MaweSettings.EDITOR_SETTINGS.cueEditorShowTimeActions;
    MaweDom.cueEditorShowStickerToggle.checked = MaweSettings.EDITOR_SETTINGS.cueEditorShowSticker;
    MaweDom.cuePanel.classList.toggle('hide-cue-editor-navigation', !MaweSettings.EDITOR_SETTINGS.cueEditorShowNavigation);
    MaweDom.cuePanel.classList.toggle('hide-cue-editor-time-actions', !MaweSettings.EDITOR_SETTINGS.cueEditorShowTimeActions);
    MaweDom.cuePanel.classList.toggle('hide-cue-editor-sticker', !MaweSettings.EDITOR_SETTINGS.cueEditorShowSticker);
  }



  const EDITOR_DISPLAY_KEYS = [
    'cueListShowIndex', 'cueListShowTime', 'cueListShowSticker', 'cueListShowCharcount',
    'cueEditorShowNavigation', 'cueEditorShowTimeActions', 'cueEditorShowSticker',
  ];



  function getEditorDisplaySettings() {
    return Object.fromEntries(EDITOR_DISPLAY_KEYS.map((key) => [key, MaweSettings.EDITOR_SETTINGS[key]]));
  }



  function applyEditorDisplaySettings(value) {
    if (!value || typeof value !== 'object') return;
    const patch = {};
    EDITOR_DISPLAY_KEYS.forEach((key) => {
      if (typeof value[key] === 'boolean') patch[key] = value[key];
    });
    if (!Object.keys(patch).length) return;
    MaweSettings.updateEditorSettings(patch);
    applyCueListDisplaySettings();
    applyCueEditorDisplaySettings();
  }



  function bindCueEditorDisplayToggle(toggle, key) {
    toggle.addEventListener('change', () => {
      MaweSettings.updateEditorSettings({ [key]: toggle.checked });
      applyCueEditorDisplaySettings();
    });
  }



  // macOS 用 ⌘（Cmd）替代 Ctrl；Win/Linux 仍显示 Ctrl。
  function modKeyLabel() {
    return window.AsrEditorUtils?.isMacPlatform() ? 'Cmd' : 'Ctrl';
  }



  function splitKeyLabel() {
    return MaweDom.splitKeySel.value === 'enter' ? 'Enter' : `${modKeyLabel()}+Enter`;
  }



  function confirmKeyLabel() {
    return MaweDom.splitKeySel.value === 'enter' ? `${modKeyLabel()}+Enter` : 'Enter';
  }



  // 把帮助面板等静态 <kbd data-mod-key> 与「拆分按键」下拉选项文本按平台替换。
  function applyPlatformKeyLabels() {
    if (modKeyLabel() === 'Ctrl') return;
    document.querySelectorAll('[data-mod-key]').forEach((el) => {
      el.textContent = el.textContent.replace(/^Ctrl/, 'Cmd');
    });
    if (MaweDom.splitKeySel) {
      const opt = MaweDom.splitKeySel.querySelector('option[value="ctrl-enter"]');
      if (opt) opt.textContent = 'Cmd+Enter';
    }
  }

  global.MaweDisplaySettings = Object.freeze({
    applyCueListDisplaySettings,
    get previousMultiSubtitlePreviewEnabled() { return previousMultiSubtitlePreviewEnabled; },
    set previousMultiSubtitlePreviewEnabled(v) { previousMultiSubtitlePreviewEnabled = v; },
    applyWaveformModeRowHeight,
    captureWaveformViewportCenterTimeMs,
    restoreWaveformViewportAfterGeometryChange,
    syncMultiSubtitleWaveformRowHeight,
    syncWordTimingWaveformSettings,
    applyWordTimingSecondsPerRow,
    updateMultiSubtitleUi,
    bindCueListDisplayToggle,
    applyCueEditorDisplaySettings,
    EDITOR_DISPLAY_KEYS,
    getEditorDisplaySettings,
    applyEditorDisplaySettings,
    bindCueEditorDisplayToggle,
    modKeyLabel,
    splitKeyLabel,
    confirmKeyLabel,
    applyPlatformKeyLabels
  });
}

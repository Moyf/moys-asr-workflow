// 显示设置：字幕列表/编辑区显示项应用、多重字幕行高联动与平台按键标签。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweDisplaySettings 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweDisplaySettings(global) {
  'use strict';



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
    const projectHasStickers = MaweBoot.DATA.segments.some(segment => segment.sticker || segment.sticker_ref);
    MaweCoreState.container.classList.toggle('hide-cue-sticker',
      !MaweSettings.EDITOR_SETTINGS.cueListShowSticker || !projectHasStickers,
    );
    MaweCoreState.container.classList.toggle('hide-cue-charcount', !MaweSettings.EDITOR_SETTINGS.cueListShowCharcount);
    MaweCueListAnchor.restoreCueListRenderAnchor(cueListAnchor);
  }



  let previousMultiSubtitlePreviewEnabled = false;


  let waveformRowHeightBeforeMultiSubtitle = null;



  function syncMultiSubtitleWaveformRowHeight(enabled, enteringEnabled, leavingEnabled) {
    if (!MaweCoreState.waveformEditor?.getRowHeight || !MaweCoreState.waveformEditor?.setRowHeight) return;
    if (enteringEnabled) {
      waveformRowHeightBeforeMultiSubtitle = MaweCoreState.waveformEditor.getRowHeight();
      MaweCoreState.waveformEditor.setRowHeight(MaweSettings.EDITOR_SETTINGS.multiSubtitleRowHeight);
    } else if (leavingEnabled && Number.isFinite(waveformRowHeightBeforeMultiSubtitle)) {
      const previous = waveformRowHeightBeforeMultiSubtitle;
      waveformRowHeightBeforeMultiSubtitle = null;
      MaweCoreState.waveformEditor.setRowHeight(previous);
    } else if (!enabled) {
      waveformRowHeightBeforeMultiSubtitle = null;
    }
  }



  function updateMultiSubtitleUi() {
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const hasTrack = Boolean(track && Array.isArray(track.segments));
    const enabled = hasTrack && MaweMultiSubtitleCore.getMultiSubtitleState().enabled === true;
    const hasMainSubtitle = MaweBoot.DATA.segments.length > 0;
    const enteringEnabled = enabled && !previousMultiSubtitlePreviewEnabled;
    const leavingEnabled = !enabled && previousMultiSubtitlePreviewEnabled;
    syncMultiSubtitleWaveformRowHeight(enabled, enteringEnabled, leavingEnabled);
    MaweSplitMode.refreshMergeJoinModeHint();
    if (MaweDom.multiSubtitleControls) MaweDom.multiSubtitleControls.hidden = !hasMainSubtitle;
    if (MaweDom.multiSubtitleSettingsDropdown) {
      // 齿轮仅在已导入副轨（真正进入多重字幕编辑）时显示；
      // 已开启但还没有第二条字幕时改在开关右侧显示拖入提示。
      MaweDom.multiSubtitleSettingsDropdown.hidden = !enabled;
      if (MaweDom.multiSubtitleSettingsDropdown.hidden) {
        MaweDom.multiSubtitleSettingsDropdown.classList.remove('open');
        MaweDom.multiSubtitleSettingsDropdown.querySelector('button[aria-expanded]')
          ?.setAttribute('aria-expanded', 'false');
      }
    }
    if (MaweDom.multiSubtitleEmptyHint) {
      // 提示与齿轮互斥：开启但无副轨 → 显示；其余隐藏。
      MaweDom.multiSubtitleEmptyHint.hidden = !(MaweMultiSubtitleCore.getMultiSubtitleState().enabled === true && !enabled);
    }
    if (MaweDom.splitMultiSubtitleSettingsEnabledHint) MaweDom.splitMultiSubtitleSettingsEnabledHint.hidden = !enabled;
    if (MaweDom.splitMultiSubtitleSettingsDisabledHint) MaweDom.splitMultiSubtitleSettingsDisabledHint.hidden = enabled;
    if (MaweDom.multiSubtitleToggle) {
      // 勾选状态跟随「多重字幕编辑模式」开关本身：未导入副轨时同样保持勾选。
      MaweDom.multiSubtitleToggle.checked = MaweMultiSubtitleCore.getMultiSubtitleState().enabled === true;
      // 没有副轨时仍允许点击，由 change 处理器询问是否现在导入第二条字幕。
      MaweDom.multiSubtitleToggle.disabled = false;
    }
    if (MaweDom.multiSubtitleToggleLabel) {
      MaweDom.multiSubtitleToggleLabel.classList.remove('disabled');
      MaweDom.multiSubtitleToggleLabel.title = MaweMultiSubtitleCore.MULTI_SUBTITLE_TOGGLE_TITLE;
    }
    if (MaweDom.multiSubtitleToggle) MaweDom.multiSubtitleToggle.title = MaweMultiSubtitleCore.MULTI_SUBTITLE_TOGGLE_TITLE;
    if (MaweDom.multiSubtitleDisplayMode) {
      MaweDom.multiSubtitleDisplayMode.value = MaweMultiSubtitleCore.getMultiSubtitleState().display_mode || 'both';
      MaweDom.multiSubtitleDisplayMode.hidden = !enabled;
    }
    if (MaweDom.multiSubtitleMainLanguageMode) {
      MaweDom.multiSubtitleMainLanguageMode.value = MaweMultiSubtitleCore.getMainSubtitleSplitMode(MaweBoot.DATA.segments[0]);
      MaweDom.multiSubtitleMainLanguageMode.hidden = !enabled;
    }
    if (MaweDom.multiSubtitleExtensionLanguageMode) {
      MaweDom.multiSubtitleExtensionLanguageMode.value = MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, track?.segments?.[0]);
      MaweDom.multiSubtitleExtensionLanguageMode.hidden = !enabled;
    }
    if (MaweDom.multiSubtitleExtensionRowHeight) {
      MaweDom.multiSubtitleExtensionRowHeight.value = String(MaweSettings.EDITOR_SETTINGS.multiSubtitleRowHeight);
      MaweDom.multiSubtitleExtensionRowHeight.disabled = !enabled;
    }
    if (MaweDom.multiSubtitleExtensionRowHeightSetting) {
      MaweDom.multiSubtitleExtensionRowHeightSetting.hidden = !enabled;
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
      const canSwap = enabled && (MaweMultiSubtitleCore.getMultiSubtitleState().tracks || []).length === 1
        && MaweBoot.DATA.segments.length > 0 && (track?.segments || []).length > 0;
      MaweDom.multiSubtitleSwapButton.classList.toggle('disabled', !canSwap);
      MaweDom.multiSubtitleSwapButton.setAttribute('aria-disabled', canSwap ? 'false' : 'true');
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
    MaweCoreState.container.dataset.multiDisplayMode = enabled ? (MaweMultiSubtitleCore.getMultiSubtitleState().display_mode || 'both') : 'main';
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
    get waveformRowHeightBeforeMultiSubtitle() { return waveformRowHeightBeforeMultiSubtitle; },
    set waveformRowHeightBeforeMultiSubtitle(v) { waveformRowHeightBeforeMultiSubtitle = v; },
    syncMultiSubtitleWaveformRowHeight,
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
})(typeof window !== 'undefined' ? window : globalThis);

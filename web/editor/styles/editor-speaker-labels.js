// 说话人标签：设置应用、控件同步与导出选项。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSpeakerLabels 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweSpeakerLabels(global) {
  'use strict';


  const speakerLabelUndoColors = new Set();


  let speakerLabelSeparatorUndo = false;


  function applySpeakerLabelInput(color, { finalize = false } = {}) {
    const input = MaweDom.subtitleSpeakerLabelInputs[color];
    if (!input) return;
    if (!speakerLabelUndoColors.has(color)) {
      MaweHistory.pushPreviewUndo('重命名说话人', MaweHistory.snapshotPreviewState());
      speakerLabelUndoColors.add(color);
    }
    const current = getSpeakerLabelSettings();
    setSpeakerLabelSettings({
      ...current,
      names: { ...current.names, [color]: input.value },
    });
    if (finalize) {
      speakerLabelUndoColors.delete(color);
      input.value = getSpeakerLabelSettings().names[color] || '';
    }
    MawePlaybackLoop.update();
  }


  function applySpeakerLabelSeparatorInput({ finalize = false } = {}) {
    const input = MaweDom.subtitleSpeakerLabelSeparatorInput;
    if (!input) return;
    if (!speakerLabelSeparatorUndo) {
      MaweHistory.pushPreviewUndo('调整说话人分隔符', MaweHistory.snapshotPreviewState());
      speakerLabelSeparatorUndo = true;
    }
    const current = getSpeakerLabelSettings();
    setSpeakerLabelSettings({ ...current, separator: input.value });
    if (finalize) {
      speakerLabelSeparatorUndo = false;
      input.value = getSpeakerLabelSettings().separator;
    }
    MawePlaybackLoop.update();
  }


  function getSpeakerLabelSettings(value = MaweBoot.DATA.preview?.subtitle?.speaker_labels) {
    // applySubtitleAppearance() runs during the early boot sequence, before the
    // preview-geometry section initializes its later GEO_UTILS alias.
    return window.AsrEditorUtils.normalizeSpeakerLabelSettings(value);
  }


  function syncSpeakerLabelControls(settings = getSpeakerLabelSettings()) {
    const mappingEnabled = settings.mapping_enabled === true;
    if (MaweDom.subtitleSpeakerMappingEnabledInput) {
      MaweDom.subtitleSpeakerMappingEnabledInput.checked = mappingEnabled;
    }
    if (MaweDom.subtitleSpeakerLabelsToggle) {
      MaweDom.subtitleSpeakerLabelsToggle.hidden = !mappingEnabled;
    }
    if (MaweDom.subtitleSpeakerLabelsEnabledInput) {
      MaweDom.subtitleSpeakerLabelsEnabledInput.checked = settings.enabled;
    }
    if (MaweDom.subtitleSpeakerLabelsSettings) {
      MaweDom.subtitleSpeakerLabelsSettings.dataset.mappingEnabled = mappingEnabled ? 'true' : 'false';
      MaweDom.subtitleSpeakerLabelsSettings.dataset.enabled = settings.enabled ? 'true' : 'false';
      MaweDom.subtitleSpeakerLabelsSettings.hidden = !mappingEnabled;
    }
    Object.entries(MaweDom.subtitleSpeakerLabelInputs).forEach(([color, input]) => {
      if (input && document.activeElement !== input) input.value = settings.names[color] || '';
    });
    if (MaweDom.subtitleSpeakerLabelSeparatorInput && document.activeElement !== MaweDom.subtitleSpeakerLabelSeparatorInput) {
      MaweDom.subtitleSpeakerLabelSeparatorInput.value = settings.separator;
    }
    document.querySelectorAll('[data-speaker-label-swatch]').forEach((swatch) => {
      const color = swatch.dataset.speakerLabelSwatch;
      const value = MaweColors.COLOR_BY_NAME[color]?.value;
      if (value) swatch.style.backgroundColor = value;
    });
  }



  function setSpeakerLabelSettings(value, { markDirty = true } = {}) {
    const settings = getSpeakerLabelSettings(value);
    if (!MaweBoot.DATA.preview || typeof MaweBoot.DATA.preview !== 'object') MaweBoot.DATA.preview = {};
    MaweBoot.DATA.preview.subtitle = {
      ...MaweAppearance.getPreviewGeometry(),
      ...MaweAppearance.getSubtitleAppearance(),
      speaker_labels: settings,
    };
    if (markDirty) MaweAppearance.previewGeometryDirty = true;
    MaweAppearance.applySubtitleAppearance(MaweBoot.DATA.preview.subtitle);
    return settings;
  }



  function speakerLabelExportOptions() {
    const settings = getSpeakerLabelSettings();
    return {
      speakerLabelsEnabled: MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels === true
        && settings.mapping_enabled === true,
      speakerLabels: settings.names,
      speakerLabelSeparator: settings.separator,
    };
  }

  global.MaweSpeakerLabels = Object.freeze({
    speakerLabelUndoColors,
    get speakerLabelSeparatorUndo() { return speakerLabelSeparatorUndo; },
    set speakerLabelSeparatorUndo(v) { speakerLabelSeparatorUndo = v; },
    applySpeakerLabelInput,
    applySpeakerLabelSeparatorInput,
    getSpeakerLabelSettings,
    syncSpeakerLabelControls,
    setSpeakerLabelSettings,
    speakerLabelExportOptions
  });
})(typeof window !== 'undefined' ? window : globalThis);

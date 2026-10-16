// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


const speakerLabelUndoColors = new Set();

let speakerLabelSeparatorUndo = false;


import { MawePlaybackLoop } from "../media/editor-playback-loop.js";function applySpeakerLabelInput(color, { finalize = false } = {}) {
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


import { MaweBoot } from "../boot/editor-boot.js";
import { MaweDom } from "../ui/editor-dom.js";
import { MaweAppearance } from "./editor-appearance.js";
import { MaweHistory } from "../state/editor-history.js";
import { MaweColors } from "./editor-colors.js";
import { MaweSettings } from "../state/editor-settings.js";function applySpeakerLabelSeparatorInput({ finalize = false } = {}) {
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

function subtitleExportText(segment, segments) {
  const options = speakerLabelExportOptions();
  const text = String(segment?.text || '');
  return options.speakerLabelsEnabled
    ? window.AsrEditorUtils.formatSpeakerLabelledText(
      text, segment, segments, options.speakerLabels, options.speakerLabelSeparator,
    )
    : text;
}

window.MaweSpeakerLabels = Object.freeze({
  subtitleExportText,
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

export const MaweSpeakerLabels = Object.freeze({
    subtitleExportText,
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
window.MaweSpeakerLabels = MaweSpeakerLabels;

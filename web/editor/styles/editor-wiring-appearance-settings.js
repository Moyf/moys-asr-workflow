
import { MaweAppearanceInputs } from "./editor-appearance-inputs.js";
import { MaweSettingsPanels } from "../ui/editor-settings-panels.js";
import { MawePreviewGeometry } from "../media/editor-preview-geometry.js";
import { MaweSpeakerLabels } from "./editor-speaker-labels.js";
import { MaweAppearance } from "./editor-appearance.js";
import { MaweHistory } from "../state/editor-history.js";
import { MaweHint } from "../ui/editor-hint.js";
import { MaweSettings } from "../state/editor-settings.js";
import { MawePlaybackLoop } from "../media/editor-playback-loop.js";import { subtitleFontFamilyInput, assColorStyleSelect, subtitleColorAssModeHintLink, assColorSpeakerExportLink } from "../ui/editor-wiring-dom-panels.js";

// 真 ESM：wiring 顶层接线（原转换体 phase-1/phase-2 = import 求值）。
'use strict';
import { MaweColors } from "./editor-colors.js";
import { MaweDom } from "../ui/editor-dom.js";
MaweDom.subtitleFontSizeSelect?.addEventListener('change', () => {
  const value = MaweDom.subtitleFontSizeSelect.value;
  MaweHistory.pushPreviewUndo('调整字幕字号', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ font_size: value === 'auto' ? null : Number(value) });
});
subtitleFontFamilyInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整字幕字体', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ font_family: MaweAppearance.subtitleFontFamilyInputToStored(subtitleFontFamilyInput.value) });
  MaweAppearance.syncSubtitleAppearanceControls();
});
assColorStyleSelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整 ASS 颜色字幕样式', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ ass_color_style: assColorStyleSelect.value });
  MawePlaybackLoop.update();
});
MaweColors.subtitleColorPaletteEnabledInput?.addEventListener('change', () => {
  MaweSettings.updateEditorSettings({ subtitleColorPaletteEnabled: MaweColors.subtitleColorPaletteEnabledInput.checked });
  MaweColors.syncSubtitleColorPaletteControls();
  MaweColors.refreshSubtitleColorPalettePresentation();
  if (!MaweColors.subtitleColorPaletteEnabledInput.checked) MaweHint.flashHint('已恢复内置字幕颜色', 'success');
});


MaweDom.subtitleBackgroundColorInput?.addEventListener('input', () => MaweAppearanceInputs.applySubtitleBackgroundColorInput());
MaweDom.subtitleBackgroundColorInput?.addEventListener('change', () => MaweAppearanceInputs.applySubtitleBackgroundColorInput({ finalize: true }));


MaweDom.subtitleBackgroundAlphaInput?.addEventListener('input', () => MaweAppearanceInputs.applySubtitleBackgroundAlphaInput());
MaweDom.subtitleBackgroundAlphaInput?.addEventListener('change', () => MaweAppearanceInputs.applySubtitleBackgroundAlphaInput({ finalize: true }));
MaweDom.subtitleFontFamilyScanButton?.addEventListener('click', () => {
  void MaweAppearance.scanSubtitleLocalFonts();
});
document.addEventListener('mawe:languagechange', () => {
  MaweAppearance.renderSubtitleFontFamilyStatus();
  MaweAppearance.relabelSubtitleFontFamilyOptions();
});
MaweDom.subtitleColorInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整主字幕颜色', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ color: MaweDom.subtitleColorInput.value });
  MawePlaybackLoop.update();
});
MaweDom.subtitleColorUnderlineInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('切换预览字幕颜色下划线', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ color_underline: MaweDom.subtitleColorUnderlineInput.checked });
  MawePlaybackLoop.update();
});
// 提示中的「ASS 字幕模式」是链接：跳到设置窗口的「字幕样式」tab。
subtitleColorAssModeHintLink?.addEventListener('click', () => {
  MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-subtitle-style');
});
assColorSpeakerExportLink?.addEventListener('click', (event) => {
  event.preventDefault();
  MaweSettingsPanels.openEditorSettingsAtTab('editor-settings-tab-project-color');
  MaweDom.exportSpeakerLabelsToggle?.focus();
});
MaweDom.subtitleColorStyleSelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整预览字幕颜色样式', MaweHistory.snapshotPreviewState());
  MaweAppearance.setSubtitleAppearance({ color_style: MaweDom.subtitleColorStyleSelect.value });
  MawePlaybackLoop.update();
});



Object.entries(MaweDom.subtitleSpeakerLabelInputs).forEach(([color, input]) => {
  input?.addEventListener('input', () => MaweSpeakerLabels.applySpeakerLabelInput(color));
  input?.addEventListener('change', () => MaweSpeakerLabels.applySpeakerLabelInput(color, { finalize: true }));
});

MaweDom.subtitleSpeakerLabelSeparatorInput?.addEventListener('input', () => MaweSpeakerLabels.applySpeakerLabelSeparatorInput());
MaweDom.subtitleSpeakerLabelSeparatorInput?.addEventListener(
  'change',
  () => MaweSpeakerLabels.applySpeakerLabelSeparatorInput({ finalize: true }),
);
MaweDom.subtitleSpeakerMappingEnabledInput?.addEventListener('change', () => {
  const previous = MaweHistory.snapshotPreviewState();
  previous.speakerLabels.mapping_enabled = !MaweDom.subtitleSpeakerMappingEnabledInput.checked;
  MaweHistory.pushPreviewUndo('切换颜色说话人映射', previous);
  const mappingEnabled = MaweDom.subtitleSpeakerMappingEnabledInput.checked;
  MaweSpeakerLabels.setSpeakerLabelSettings({
    ...MaweSpeakerLabels.getSpeakerLabelSettings(),
    mapping_enabled: mappingEnabled,
  });
  if (mappingEnabled) {
    MaweSettings.updateEditorSettings({ exportSpeakerLabels: true });
    if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = true;
  }
  MawePlaybackLoop.update();
});
MaweDom.subtitleSpeakerLabelsEnabledInput?.addEventListener('change', () => {
  const previous = MaweHistory.snapshotPreviewState();
  previous.speakerLabels.enabled = !MaweDom.subtitleSpeakerLabelsEnabledInput.checked;
  MaweHistory.pushPreviewUndo('切换说话人名称预览', previous);
  MaweSpeakerLabels.setSpeakerLabelSettings({
    ...MaweSpeakerLabels.getSpeakerLabelSettings(),
    enabled: MaweDom.subtitleSpeakerLabelsEnabledInput.checked,
  });
  // 显示开关改变时同步 SRT 附加选项；导出开关仍可在全局设置中独立调整。
  const speakerLabelsEnabled = MaweDom.subtitleSpeakerLabelsEnabledInput.checked;
  MaweSettings.updateEditorSettings({ exportSpeakerLabels: speakerLabelsEnabled });
  if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = speakerLabelsEnabled;
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleFontSizeSelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕字号', MaweHistory.snapshotPreviewState());
  const value = MaweDom.extensionSubtitleFontSizeSelect.value;
  MaweAppearance.setExtensionSubtitleAppearance({ font_size: value === 'auto' ? null : Number(value) });
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleFontFamilySelect?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕字体', MaweHistory.snapshotPreviewState());
  MaweAppearance.setExtensionSubtitleAppearance({ font_family: MaweDom.extensionSubtitleFontFamilySelect.value });
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleColorInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕颜色', MaweHistory.snapshotPreviewState());
  MaweAppearance.setExtensionSubtitleAppearance({ color: MaweDom.extensionSubtitleColorInput.value });
  MawePlaybackLoop.update();
});
MaweDom.extensionSubtitleBackgroundColorInput?.addEventListener('change', () => {
  MaweHistory.pushPreviewUndo('调整副字幕背景色', MaweHistory.snapshotPreviewState());
  MaweAppearance.setExtensionSubtitleAppearance({ background_color: MaweDom.extensionSubtitleBackgroundColorInput.value });
  MawePlaybackLoop.update();
});


MaweDom.extensionSubtitleBackgroundAlphaInput?.addEventListener('input', () => MaweAppearanceInputs.applyExtensionSubtitleBackgroundAlphaInput());
MaweDom.extensionSubtitleBackgroundAlphaInput?.addEventListener('change', () => MaweAppearanceInputs.applyExtensionSubtitleBackgroundAlphaInput({ finalize: true }));
MaweDom.extensionOverlayToggle?.addEventListener('change', () => {
  const previous = MaweHistory.snapshotPreviewState();
  previous.extensionOverlay = !MaweDom.extensionOverlayToggle.checked;
  MaweHistory.pushPreviewUndo('切换副字幕预览', previous);
  MaweSettings.updateEditorSettings({ extensionOverlayEnabled: MaweDom.extensionOverlayToggle.checked });
  MawePreviewGeometry.refreshPreviewGeometryEditable();
  MawePlaybackLoop.update();
});

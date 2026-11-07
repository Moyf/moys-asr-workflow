// 说话人标签：设置应用、控件同步与导出选项。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSpeakerLabels 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
import { createProjectSpeaker, updateProjectSpeaker, bindProjectSpeakerShortcut, setProjectAnnotationMode, setProjectPaletteSize, assignProjectSpeakerShortcut, SPEAKER_SHORTCUT_COLORS } from '../../shared/utils/speaker-experience.js';

export function initMaweSpeakerLabels() {
(function initMaweSpeakerLabels(global) {
  'use strict';
  const ui = (zh, en) => global.MAWE_I18N?.language === 'en' ? en : zh;


  const speakerLabelUndoColors = new Set();


  let speakerLabelSeparatorUndo = false;


  function applySpeakerLabelInput(color, { finalize = false } = {}) {
    if (MaweBoot.DATA.annotation_mode === 'speaker') {
      MaweHint.flashHint('当前工程使用独立说话人身份，不能通过旧颜色姓名映射改名。', 'warning');
      return false;
    }
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
      MaweDom.subtitleSpeakerMappingEnabledInput.checked = MaweBoot.DATA.annotation_mode === 'speaker';
    }
    if (MaweDom.subtitleSpeakerLabelsToggle) {
      MaweDom.subtitleSpeakerLabelsToggle.hidden = false;
    }
    if (MaweDom.subtitleSpeakerLabelsEnabledInput) {
      MaweDom.subtitleSpeakerLabelsEnabledInput.checked = settings.enabled;
    }
    if (MaweDom.subtitleSpeakerLabelsSettings) {
      MaweDom.subtitleSpeakerLabelsSettings.dataset.mappingEnabled = mappingEnabled ? 'true' : 'false';
      MaweDom.subtitleSpeakerLabelsSettings.dataset.enabled = settings.enabled ? 'true' : 'false';
      MaweDom.subtitleSpeakerLabelsSettings.hidden = false;
      const legacyNames = MaweDom.subtitleSpeakerLabelsSettings.querySelector?.('.subtitle-speaker-label-list');
      if (legacyNames) legacyNames.hidden = true;
      const legacyHint = MaweDom.subtitleSpeakerLabelsSettings.querySelector?.('.editor-settings-hint');
      if (legacyHint) legacyHint.textContent = ui('姓名来自工程中的说话人；预览与导出可分别开关。',
        'Names come from project speakers. Preview and export are controlled separately.');
    }
    Object.entries(MaweDom.subtitleSpeakerLabelInputs).forEach(([color, input]) => {
      if (input) {
        input.disabled = true;
        input.title = ui('请在说话人管理中修改姓名', 'Edit names in the speaker manager');
      }
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
    window.MaweSpeakerManager?.sync?.();
  }



  function setSpeakerLabelSettings(value, { markDirty = true } = {}) {
    const settings = getSpeakerLabelSettings(value);
    if (!MaweBoot.DATA.preview || typeof MaweBoot.DATA.preview !== 'object') MaweBoot.DATA.preview = {};
    MaweBoot.DATA.preview.subtitle = {
      ...MaweBoot.DATA.preview.subtitle,
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
        && (Array.isArray(MaweBoot.DATA.speakers) || settings.mapping_enabled === true),
      speakerLabels: settings.names,
      speakerLabelSeparator: settings.separator,
      speakerProject: MaweBoot.DATA,
    };
  }

  function subtitleExportText(segment, segments) {
    const options = speakerLabelExportOptions();
    // 动态字幕 / Resolve JSON / OTIO 等 subtitleExportText 出口与 SRT/TXT 同
    // 链路剥离：句级 fade/shake + 成对 MASS 符号（ASS 导出不经过这里）。
    const text = window.AsrEditorUtils.srtSentenceText(
      String(segment?.text || ''), MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule,
    );
    return options.speakerLabelsEnabled
      ? window.AsrEditorUtils.formatSpeakerLabelledText(
        text, segment, segments, options.speakerLabels, options.speakerLabelSeparator, options.speakerProject,
      )
      : text;
  }

  function runSpeakerCommand(label, operation) {
    const result = MaweCommands.run(label, operation,
      { captureView: true, invalidate: { cueList: true, waveform: 'full', preview: 'update' } });
    window.MaweColors?.rebuildEditorColorPalette?.();
    window.MaweSpeakerManager?.sync?.();
    return result;
  }

  function assignIdentity(refs, identity) {
    return runSpeakerCommand(identity === null ? '清除说话人' : '分配说话人',
      () => window.AsrEditorUtils.assignProjectSpeaker(MaweBoot.DATA, refs, identity));
  }

  function mergeIdentities(sourceIds, targetId) {
    return runSpeakerCommand('合并说话人身份', () => window.AsrEditorUtils.mergeProjectSpeakers(MaweBoot.DATA, sourceIds, targetId));
  }

  function createIdentity(options) {
    return runSpeakerCommand('新增说话人', () => createProjectSpeaker(MaweBoot.DATA, options));
  }

  function updateIdentity(identity, patch) {
    return runSpeakerCommand('修改说话人', () => updateProjectSpeaker(MaweBoot.DATA, identity, patch));
  }

  function bindShortcut(slot, identity) {
    return runSpeakerCommand('设置说话人快捷键', () => bindProjectSpeakerShortcut(MaweBoot.DATA, slot, identity));
  }

  function setAnnotationMode(mode) {
    return runSpeakerCommand('切换颜色用途', () => setProjectAnnotationMode(MaweBoot.DATA, mode));
  }

  function setPaletteSize(size) {
    return runSpeakerCommand('切换五色或九色', () => setProjectPaletteSize(MaweBoot.DATA, size));
  }

  function assignShortcut(refs, slot) {
    const name = SPEAKER_SHORTCUT_COLORS[slot - 1];
    return runSpeakerCommand('分配说话人', () => assignProjectSpeakerShortcut(MaweBoot.DATA, refs, slot,
      { color: window.MaweColors?.COLOR_BY_NAME?.[name]?.value }));
  }

  function assignFromColorShortcut(track, indices, colorName) {
    if (MaweBoot.DATA.annotation_mode !== 'speaker') return false;
    const refs = [...new Set(indices)].filter(index => track?.segments[index])
      .map(index => ({ track_id: track.id, segment_id: track.segments[index].id }));
    if (!refs.length) return true;
    if (colorName === null) { assignIdentity(refs, null); return true; }
    const slot = SPEAKER_SHORTCUT_COLORS.indexOf(colorName) + 1;
    if (!slot || slot > (MaweBoot.DATA.palette_size === 9 ? 9 : 5)) return true;
    assignShortcut(refs, slot);
    return true;
  }

  global.MaweSpeakerLabels = Object.freeze({
    assignIdentity,
    clearIdentity: refs => assignIdentity(refs, null),
    mergeIdentities,
    createIdentity,
    updateIdentity,
    bindShortcut,
    setAnnotationMode,
    setPaletteSize,
    assignShortcut,
    assignFromColorShortcut,
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
  global.document?.addEventListener?.('mawe:languagechange', () => syncSpeakerLabelControls());
})(typeof window !== 'undefined' ? window : globalThis);
}

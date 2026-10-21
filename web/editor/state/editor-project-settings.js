// Project properties are read from the active project; preferences never override them.
(function initProjectSettings(global) {
  'use strict';
  const settings = MaweSettings.EDITOR_SETTINGS;
  function preview() {
    return MaweBoot.DATA.preview ||= {};
  }
  Object.defineProperties(settings, {
    assMode: {
      enumerable: true, configurable: true,
      get: () => MaweBoot.DATA.preview?.ass_mode === true,
      set: value => { preview().ass_mode = value === true; },
    },
    exportSpeakerLabels: {
      enumerable: true, configurable: true,
      get: () => MaweBoot.DATA.preview?.subtitle?.speaker_labels?.export_enabled === true,
      set: value => {
        const container = preview();
        container.subtitle ||= {};
        container.subtitle.speaker_labels = {
          ...window.AsrEditorUtils.normalizeSpeakerLabelSettings(container.subtitle.speaker_labels),
          export_enabled: value === true,
        };
      },
    },
    mainSplitModeOverride: {
      enumerable: true, configurable: true,
      get: () => {
        const mode = window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).split_mode_override;
        return mode === 'word' || mode === 'continuous' ? mode : null;
      },
      set: value => {
        if (value !== 'word' && value !== 'continuous') return;
        window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).split_mode_override = value;
      },
    },
  });
  function syncControls() {
    if (typeof syncAssModeControl === 'function') syncAssModeControl();
    if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = settings.exportSpeakerLabels;
    MaweSplitMode.refreshMergeJoinModeHint();
    global.MaweStickerRoot?.syncControls?.();
  }
  global.MaweProjectSettings = Object.freeze({ syncControls });
})(window);

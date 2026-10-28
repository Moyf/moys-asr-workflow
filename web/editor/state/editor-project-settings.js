// 工程属性设置：从活动工程读取的 assMode / 导出说话人标签 / 主字幕拆分模式
// 覆盖，只挂到共享偏好对象上的访问器。ESM init 模块：syncControls 为具名
// 导出；window.MaweProjectSettings 冻结对象保留为尚未迁移消费者的出接口。
export function syncControls() {
  // classic 接线域（ass-manager）的函数不经 legacy 提升对本模块可见，
  // 经其既有 window 门面（MaweAssManagerWiring）调用。
  window.MaweAssManagerWiring?.syncAssModeControl?.();
  if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels;
  MaweSplitMode.refreshMergeJoinModeHint();
  window.MaweStickerRoot?.syncControls?.();
}

export function initMaweProjectSettings() {
  'use strict';
  const settings = MaweSettings.EDITOR_SETTINGS;
  const preview = () => {
    return MaweBoot.DATA.preview ||= {};
  };
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
        const mode = MaweBoot.DATA.multi_subtitle?.main_split_mode;
        return mode === 'word' || mode === 'continuous' ? mode : null;
      },
      set: value => {
        if (value !== 'word' && value !== 'continuous') return;
        MaweBoot.DATA.multi_subtitle ||= {};
        MaweBoot.DATA.multi_subtitle.main_split_mode = value;
      },
    },
  });
  window.MaweProjectSettings = Object.freeze({ syncControls });
}

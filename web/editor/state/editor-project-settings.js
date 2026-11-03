// 工程属性设置：从活动工程读取的 assMode / 导出说话人标签 / 主字幕拆分模式
// 覆盖，只挂到共享偏好对象上的访问器。ESM init 模块：syncControls 为具名
// 导出；window.MaweProjectSettings 冻结对象保留为尚未迁移消费者的出接口。
export function syncTrackControls() {
  const tracks = MaweBoot.DATA?.tracks || [];
  for (const row of document.querySelectorAll('.track-visibility-row')) {
    const track = tracks.find(item => item.role === row.dataset.trackRole);
    const enabled = row.querySelector('[data-track-field="enabled"]');
    const preview = row.querySelector('[data-track-field="preview"]');
    const output = row.querySelector('[data-track-field="export"]');
    enabled.checked = track?.enabled === true;
    enabled.disabled = row.dataset.trackRole === 'main';
    preview.checked = Boolean(track && track.preview_visible !== false);
    output.checked = Boolean(track && track.export?.enabled !== false);
    preview.disabled = output.disabled = !track;
    const warning = row.querySelector('.track-variant-warning');
    if (warning) {
      const unsupported = track && window.AsrEditorUtils.TrackPolicy.unsupportedVariant(track);
      warning.hidden = !unsupported;
      warning.textContent = unsupported ? `不支持的叠加轨类型：${track.variant}。数据已保留。` : '';
    }
  }
}

export function syncControls() {
  syncTrackControls();
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
        const mode = window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).split_mode_override;
        return mode === 'word' || mode === 'continuous' ? mode : null;
      },
      set: value => {
        if (value !== 'word' && value !== 'continuous') return;
        window.AsrEditorUtils.getMainTrack(MaweBoot.DATA).split_mode_override = value;
      },
    },
  });
  window.MaweProjectSettings = Object.freeze({ syncControls, syncTrackControls });
}

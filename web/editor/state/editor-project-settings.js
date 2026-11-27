// 工程属性设置：从活动工程读取的 assMode / 导出说话人标签 / 主字幕拆分模式
// 覆盖，由共享偏好对象上的访问器读写。
import { MaweBoot } from '../boot/editor-boot.js';
import { refreshMergeJoinModeHint } from '../cues/editor-split-mode.js';
import { MaweStickerRoot } from '../io/editor-sticker-root.js';
import { MaweAssManagerWiring } from '../styles/editor-wiring-ass-manager.js';
import { MaweDom } from '../ui/editor-dom.js';
import { MaweSettings } from './editor-settings.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';
export let syncControls;
export let syncTrackControls;

function updateTrackControls() {
  const tracks = MaweBoot.DATA?.tracks || [];
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.track-visibility-row'))) {
    const track = tracks.find(item => item.role === row.dataset.trackRole);
    const enabled = /** @type {HTMLInputElement} */ (row.querySelector('[data-track-field="enabled"]'));
    const preview = /** @type {HTMLInputElement} */ (row.querySelector('[data-track-field="preview"]'));
    const output = /** @type {HTMLInputElement} */ (row.querySelector('[data-track-field="export"]'));
    enabled.checked = track?.enabled === true;
    enabled.disabled = row.dataset.trackRole === 'main';
    preview.checked = Boolean(track && track.preview_visible !== false);
    output.checked = Boolean(track && track.export?.enabled !== false);
    preview.disabled = output.disabled = !track;
    const warning = /** @type {HTMLElement} */ (row.querySelector('.track-variant-warning'));
    if (warning) {
      const unsupported = track && AsrEditorUtils.TrackPolicy.unsupportedVariant(track);
      warning.hidden = !unsupported;
      warning.textContent = unsupported ? `不支持的叠加轨类型：${track.variant}。数据已保留。` : '';
    }
  }
}

function updateControls() {
  updateTrackControls();
  MaweAssManagerWiring?.syncAssModeControl?.();
  if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = MaweSettings.EDITOR_SETTINGS.exportSpeakerLabels;
  refreshMergeJoinModeHint();
  MaweStickerRoot?.syncControls?.();
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
          ...AsrEditorUtils.normalizeSpeakerLabelSettings(container.subtitle.speaker_labels),
          export_enabled: value === true,
        };
      },
    },
    mainSplitModeOverride: {
      enumerable: true, configurable: true,
      get: () => {
        const mode = AsrEditorUtils.getMainTrack(MaweBoot.DATA).split_mode_override;
        return mode === 'word' || mode === 'continuous' ? mode : null;
      },
      set: value => {
        if (value !== 'word' && value !== 'continuous') return;
        AsrEditorUtils.getMainTrack(MaweBoot.DATA).split_mode_override = value;
      },
    },
  });
  syncControls = updateControls;
  syncTrackControls = updateTrackControls;


}

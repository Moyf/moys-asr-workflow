import { syncAssModeControl } from "../styles/editor-wiring-ass-manager.js";

import { MaweBoot } from "../boot/editor-boot.js";
import { MaweDom } from "../ui/editor-dom.js";
import { MaweSettings } from "./editor-settings.js";
import { MaweSplitMode } from "../cues/editor-split-mode.js";
// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';

// 安装时机：模块顶层立即读 MaweSettings（其门面由 deferred 转换体
// 在 phase-2 发布），import 期该门面尚不存在——所有立即读都收敛到
// install()，首次访问 window.MaweProjectSettings 时执行。
let installed = false;
function install() {
  if (installed) return MaweProjectSettings;
  installed = true;
  // Project properties are read from the active project; preferences never override them.
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
  return MaweProjectSettings;
}

function syncControls() {
  if (typeof syncAssModeControl === 'function') syncAssModeControl();
  if (MaweDom.exportSpeakerLabelsToggle) MaweDom.exportSpeakerLabelsToggle.checked = /** @type {{ exportSpeakerLabels?: boolean }} */ (install()).exportSpeakerLabels;
  MaweSplitMode.refreshMergeJoinModeHint();
  window.MaweStickerRoot?.syncControls?.();
}

export const MaweProjectSettings = Object.freeze({ syncControls });

Object.defineProperty(window, 'MaweProjectSettings', {
  configurable: true,
  get: () => install(),
});

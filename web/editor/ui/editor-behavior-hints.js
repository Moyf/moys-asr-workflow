// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


const CLICK_BEHAVIOR_HINTS = {
  zh: {
    'select-and-seek': '暂停时只跳转，不自动播放；播放中跳转后继续播放。',
    'select-only': '只选中，不改变播放位置；可用 F 或右键菜单跳转并播放。',
    'select-and-play': '跳转到字幕起点，并在暂停时自动开始播放。',
  },
  en: {
    'select-and-seek': 'When paused, seek without starting playback; while playing, keep playing after seeking.',
    'select-only': 'Select only without changing the playhead; use F or the context menu to seek and play.',
    'select-and-play': 'Seek to the subtitle start and start playback when paused.',
  },
};


import { MaweDom } from "./editor-dom.js";
import { MaweSettings } from "../state/editor-settings.js";function refreshClickBehaviorHint() {
  const hint = document.getElementById('click-behavior-hint');
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  if (hint) {
    hint.textContent = CLICK_BEHAVIOR_HINTS[language][MaweSettings.EDITOR_SETTINGS.clickBehavior];
    hint.hidden = false;
  }
  if (MaweDom.clickTargetField) {
    MaweDom.clickTargetField.hidden = MaweSettings.EDITOR_SETTINGS.clickBehavior === 'select-only';
  }
}

const KEYBOARD_OPERATION_REFERENCE_HINTS = {
  zh: {
    pointer: 'B/Z/X/N 使用鼠标所在波形位置；波形外不执行时间操作。',
    playhead: 'B/Z/X/N 使用当前播放头位置；无当前字幕目标时使用主轨。',
  },
  en: {
    pointer: 'B/Z/X/N use the mouse position in the waveform; outside it, timing actions do nothing.',
    playhead: 'B/Z/X/N use the current playhead; when no cue target is active, they use the main track.',
  },
};

function refreshKeyboardOperationReferenceHint() {
  const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
  const mode = MaweSettings.normalizeKeyboardOperationReferenceMode(MaweSettings.EDITOR_SETTINGS.keyboardOperationReference);
  if (MaweDom.keyboardOperationReferenceSelect) MaweDom.keyboardOperationReferenceSelect.value = mode;
  if (MaweDom.keyboardOperationReferenceHint) {
    MaweDom.keyboardOperationReferenceHint.textContent = KEYBOARD_OPERATION_REFERENCE_HINTS[language][mode];
  }
}

window.MaweBehaviorHints = Object.freeze({
  CLICK_BEHAVIOR_HINTS,
  refreshClickBehaviorHint,
  KEYBOARD_OPERATION_REFERENCE_HINTS,
  refreshKeyboardOperationReferenceHint
});

export const MaweBehaviorHints = Object.freeze({
    CLICK_BEHAVIOR_HINTS,
    refreshClickBehaviorHint,
    KEYBOARD_OPERATION_REFERENCE_HINTS,
    refreshKeyboardOperationReferenceHint
  });
window.MaweBehaviorHints = MaweBehaviorHints;

// 外观输入：主/副字幕背景色与不透明度输入应用。
// 由 split-cluster codemod 自 editor.js 拆出。
import { MaweHistory } from '../state/editor-history.js';
import { MaweDom } from '../ui/editor-dom.js';
import { setSubtitleAppearance, setExtensionSubtitleAppearance } from './editor-appearance.js';
export let MaweAppearanceInputs;

export function initMaweAppearanceInputs() {
(function initMaweAppearanceInputsFacade(global) {
  'use strict';


  let subtitleBackgroundColorUndoPushed = false;


  function applySubtitleBackgroundColorInput({ finalize = false } = {}) {
    if (!MaweDom.subtitleBackgroundColorInput) return;
    if (!subtitleBackgroundColorUndoPushed) {
      MaweHistory.pushPreviewUndo('调整字幕背景色', MaweHistory.snapshotPreviewState());
      subtitleBackgroundColorUndoPushed = true;
    }
    setSubtitleAppearance({ background_color: MaweDom.subtitleBackgroundColorInput.value });
    if (finalize) subtitleBackgroundColorUndoPushed = false;
  }


  let subtitleBackgroundAlphaUndoPushed = false;


  function applySubtitleBackgroundAlphaInput({ finalize = false } = {}) {
    if (!MaweDom.subtitleBackgroundAlphaInput) return;
    if (!subtitleBackgroundAlphaUndoPushed) {
      MaweHistory.pushPreviewUndo('调整字幕背景不透明度', MaweHistory.snapshotPreviewState());
      subtitleBackgroundAlphaUndoPushed = true;
    }
    const alpha = Number(MaweDom.subtitleBackgroundAlphaInput.value);
    if (MaweDom.subtitleBackgroundAlphaValue && Number.isFinite(alpha)) {
      MaweDom.subtitleBackgroundAlphaValue.textContent = `${Math.round(alpha * 100)}%`;
    }
    setSubtitleAppearance({ background_alpha: alpha });
    if (finalize) subtitleBackgroundAlphaUndoPushed = false;
  }


  let extensionSubtitleBackgroundAlphaUndoPushed = false;


  function applyExtensionSubtitleBackgroundAlphaInput({ finalize = false } = {}) {
    if (!MaweDom.extensionSubtitleBackgroundAlphaInput) return;
    if (!extensionSubtitleBackgroundAlphaUndoPushed) {
      MaweHistory.pushPreviewUndo('调整副字幕背景不透明度', MaweHistory.snapshotPreviewState());
      extensionSubtitleBackgroundAlphaUndoPushed = true;
    }
    const alpha = Number(MaweDom.extensionSubtitleBackgroundAlphaInput.value);
    if (MaweDom.extensionSubtitleBackgroundAlphaValue && Number.isFinite(alpha)) {
      MaweDom.extensionSubtitleBackgroundAlphaValue.textContent = `${Math.round(alpha * 100)}%`;
    }
    setExtensionSubtitleAppearance({ background_alpha: alpha });
    if (finalize) extensionSubtitleBackgroundAlphaUndoPushed = false;
  }

  MaweAppearanceInputs = Object.freeze({
    get subtitleBackgroundColorUndoPushed() { return subtitleBackgroundColorUndoPushed; },
    set subtitleBackgroundColorUndoPushed(v) { subtitleBackgroundColorUndoPushed = v; },
    applySubtitleBackgroundColorInput,
    get subtitleBackgroundAlphaUndoPushed() { return subtitleBackgroundAlphaUndoPushed; },
    set subtitleBackgroundAlphaUndoPushed(v) { subtitleBackgroundAlphaUndoPushed = v; },
    applySubtitleBackgroundAlphaInput,
    get extensionSubtitleBackgroundAlphaUndoPushed() { return extensionSubtitleBackgroundAlphaUndoPushed; },
    set extensionSubtitleBackgroundAlphaUndoPushed(v) { extensionSubtitleBackgroundAlphaUndoPushed = v; },
    applyExtensionSubtitleBackgroundAlphaInput
  });

})(typeof window !== 'undefined' ? window : globalThis);
}

// 外观输入：主/副字幕背景色与不透明度输入应用。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweAppearanceInputs 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweAppearanceInputs(global) {
  'use strict';


  let subtitleBackgroundColorUndoPushed = false;


  function applySubtitleBackgroundColorInput({ finalize = false } = {}) {
    if (!MaweDom.subtitleBackgroundColorInput) return;
    if (!subtitleBackgroundColorUndoPushed) {
      MaweHistory.pushPreviewUndo('调整字幕背景色', MaweHistory.snapshotPreviewState());
      subtitleBackgroundColorUndoPushed = true;
    }
    MaweAppearance.setSubtitleAppearance({ background_color: MaweDom.subtitleBackgroundColorInput.value });
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
    MaweAppearance.setSubtitleAppearance({ background_alpha: alpha });
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
    MaweAppearance.setExtensionSubtitleAppearance({ background_alpha: alpha });
    if (finalize) extensionSubtitleBackgroundAlphaUndoPushed = false;
  }

  global.MaweAppearanceInputs = Object.freeze({
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

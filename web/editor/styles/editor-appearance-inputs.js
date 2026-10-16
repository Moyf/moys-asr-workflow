// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


let subtitleBackgroundColorUndoPushed = false;


import { MaweDom } from "../ui/editor-dom.js";

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


import { MaweAppearance } from "./editor-appearance.js";
import { MaweHistory } from "../state/editor-history.js";

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

window.MaweAppearanceInputs = Object.freeze({
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

export const MaweAppearanceInputs = Object.freeze({
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
window.MaweAppearanceInputs = MaweAppearanceInputs;

// 真 ESM：模块顶层定义与发布（原转换体 phase-2 语义 = import 求值）。
// window.<Name> 与导出的 <Name> 是同一对象；消费者逐簇改 import 后移除 window 发布。
'use strict';


// 拆分移除符号：前 5 个高频符号用勾选 chip，其余走「其他符号」自由文本框
// （空格分隔）；两者合并后即时持久化并同步给共享工具层。
const splitTrimSymbolGrid = document.getElementById('split-trim-symbol-grid');

const splitTrimSymbolsReset = document.getElementById('split-trim-symbols-reset');

const splitTrimExtraInput = document.getElementById('split-trim-extra-symbols');


import { MaweSettings } from "../state/editor-settings.js";function currentSplitTrimPrimaryChars() {
  return window.AsrEditorUtils.SPLIT_TRIM_PRIMARY_SYMBOLS.map((option) => option.ch);
}

function splitTrimPrimaryCheckedSet() {
  const primaries = new Set(currentSplitTrimPrimaryChars());
  return new Set(MaweSettings.EDITOR_SETTINGS.splitTrimSymbols.filter((ch) => primaries.has(ch)));
}

function splitTrimExtraSymbols() {
  const primaries = new Set(currentSplitTrimPrimaryChars());
  return MaweSettings.EDITOR_SETTINGS.splitTrimSymbols.filter((ch) => !primaries.has(ch));
}

function updateSplitTrimSymbolsResetVisibility() {
  const defaults = window.AsrEditorUtils.DEFAULT_SPLIT_TRIM_SYMBOLS;
  const current = MaweSettings.EDITOR_SETTINGS.splitTrimSymbols;
  splitTrimSymbolsReset?.toggleAttribute(
    'hidden',
    current.length === defaults.length && defaults.every((ch) => current.includes(ch)),
  );
}

function persistSplitTrimSymbols(nextSymbols) {
  // 归一化去重并保持顺序：先按传入顺序，chip 前置、文本框追加在后。
  const normalized = window.AsrEditorUtils.normalizeSplitTrimSymbols(nextSymbols);
  MaweSettings.updateEditorSettings({ splitTrimSymbols: normalized });
  window.AsrEditorUtils.setSplitTrimSymbols(normalized);
  updateSplitTrimSymbolsResetVisibility();
}

function renderSplitTrimSymbolGrid() {
  if (!splitTrimSymbolGrid) return;
  const checked = splitTrimPrimaryCheckedSet();
  splitTrimSymbolGrid.replaceChildren();
  window.AsrEditorUtils.SPLIT_TRIM_PRIMARY_SYMBOLS.forEach((option) => {
    const label = document.createElement('label');
    label.title = option.name;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked.has(option.ch);
    input.value = option.ch;
    input.addEventListener('change', () => {
      const next = new Set(splitTrimPrimaryCheckedSet());
      if (input.checked) next.add(option.ch);
      else next.delete(option.ch);
      persistSplitTrimSymbols([...next, ...splitTrimExtraSymbols()]);
      refreshSplitTrimExtraInput();
    });
    const chip = document.createElement('span');
    chip.textContent = option.ch;
    label.append(input, chip);
    splitTrimSymbolGrid.appendChild(label);
  });
  updateSplitTrimSymbolsResetVisibility();
}

function refreshSplitTrimExtraInput() {
  if (splitTrimExtraInput && document.activeElement !== splitTrimExtraInput) {
    splitTrimExtraInput.value = splitTrimExtraSymbols().join(' ');
  }
}

window.MaweSplitTrim = Object.freeze({
  splitTrimSymbolGrid,
  splitTrimSymbolsReset,
  splitTrimExtraInput,
  currentSplitTrimPrimaryChars,
  splitTrimPrimaryCheckedSet,
  splitTrimExtraSymbols,
  updateSplitTrimSymbolsResetVisibility,
  persistSplitTrimSymbols,
  renderSplitTrimSymbolGrid,
  refreshSplitTrimExtraInput
});

export const MaweSplitTrim = Object.freeze({
    splitTrimSymbolGrid,
    splitTrimSymbolsReset,
    splitTrimExtraInput,
    currentSplitTrimPrimaryChars,
    splitTrimPrimaryCheckedSet,
    splitTrimExtraSymbols,
    updateSplitTrimSymbolsResetVisibility,
    persistSplitTrimSymbols,
    renderSplitTrimSymbolGrid,
    refreshSplitTrimExtraInput
  });
window.MaweSplitTrim = MaweSplitTrim;

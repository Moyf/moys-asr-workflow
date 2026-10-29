// 拆分修剪符号表：修剪字符配置、持久化与网格 UI。
// ESM init 模块：initMaweSplitTrim 在原清单位次执行原 IIFE 体（挂
// window.MaweSplitTrim 冻结门面——classic 侧出接口）；底部具名导出经门面
// 在调用时转发，兄弟模块可静态 import。
export function initMaweSplitTrim() {
(function initMaweSplitTrim(global) {
  'use strict';


  // 拆分移除符号：前 5 个高频符号用勾选 chip，其余走「其他符号」自由文本框
  // （空格分隔）；两者合并后即时持久化并同步给共享工具层。
  const splitTrimSymbolGrid = document.getElementById('split-trim-symbol-grid');


  const splitTrimSymbolsReset = document.getElementById('split-trim-symbols-reset');


  const splitTrimExtraInput = document.getElementById('split-trim-extra-symbols');


  function currentSplitTrimPrimaryChars() {
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

  global.MaweSplitTrim = Object.freeze({
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
})(typeof window !== 'undefined' ? window : globalThis);
}

export function splitTrimSymbolGrid(...args) { return window.MaweSplitTrim.splitTrimSymbolGrid(...args); }
export function splitTrimSymbolsReset(...args) { return window.MaweSplitTrim.splitTrimSymbolsReset(...args); }
export function splitTrimExtraInput(...args) { return window.MaweSplitTrim.splitTrimExtraInput(...args); }
export function currentSplitTrimPrimaryChars(...args) { return window.MaweSplitTrim.currentSplitTrimPrimaryChars(...args); }
export function splitTrimPrimaryCheckedSet(...args) { return window.MaweSplitTrim.splitTrimPrimaryCheckedSet(...args); }
export function splitTrimExtraSymbols(...args) { return window.MaweSplitTrim.splitTrimExtraSymbols(...args); }
export function updateSplitTrimSymbolsResetVisibility(...args) { return window.MaweSplitTrim.updateSplitTrimSymbolsResetVisibility(...args); }
export function persistSplitTrimSymbols(...args) { return window.MaweSplitTrim.persistSplitTrimSymbols(...args); }
export function renderSplitTrimSymbolGrid(...args) { return window.MaweSplitTrim.renderSplitTrimSymbolGrid(...args); }
export function refreshSplitTrimExtraInput(...args) { return window.MaweSplitTrim.refreshSplitTrimExtraInput(...args); }

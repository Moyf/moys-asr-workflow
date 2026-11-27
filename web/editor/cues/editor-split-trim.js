// 拆分修剪符号表：修剪字符配置、持久化与网格 UI。
import { MaweSettings } from '../state/editor-settings.js';
import { AsrEditorUtils } from '../../shared/editor-utils.js';
let MaweSplitTrim;
export let splitTrimSymbolsReset;
export let splitTrimExtraInput;
export function initMaweSplitTrim() {
  // 拆分移除符号：前 5 个高频符号用勾选 chip，其余走「其他符号」自由文本框
  // （空格分隔）；两者合并后即时持久化并同步给共享工具层。
  const splitTrimSymbolGrid = document.getElementById('split-trim-symbol-grid');


  splitTrimSymbolsReset = document.getElementById('split-trim-symbols-reset');


  splitTrimExtraInput = /** @type {HTMLInputElement} */ (document.getElementById('split-trim-extra-symbols'));


  function currentSplitTrimPrimaryChars() {
    return AsrEditorUtils.SPLIT_TRIM_PRIMARY_SYMBOLS.map((option) => option.ch);
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
    const defaults = AsrEditorUtils.DEFAULT_SPLIT_TRIM_SYMBOLS;
    const current = MaweSettings.EDITOR_SETTINGS.splitTrimSymbols;
    splitTrimSymbolsReset?.toggleAttribute(
      'hidden',
      current.length === defaults.length && defaults.every((ch) => current.includes(ch)),
    );
  }


  function persistSplitTrimSymbols(nextSymbols) {
    // 归一化去重并保持顺序：先按传入顺序，chip 前置、文本框追加在后。
    const normalized = AsrEditorUtils.normalizeSplitTrimSymbols(nextSymbols);
    MaweSettings.updateEditorSettings({ splitTrimSymbols: normalized });
    AsrEditorUtils.setSplitTrimSymbols(normalized);
    updateSplitTrimSymbolsResetVisibility();
  }


  function renderSplitTrimSymbolGrid() {
    if (!splitTrimSymbolGrid) return;
    const checked = splitTrimPrimaryCheckedSet();
    splitTrimSymbolGrid.replaceChildren();
    AsrEditorUtils.SPLIT_TRIM_PRIMARY_SYMBOLS.forEach((option) => {
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

  MaweSplitTrim = Object.freeze({
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
}

export function splitTrimSymbolGrid(...args) { return MaweSplitTrim.splitTrimSymbolGrid(...args); }
export function currentSplitTrimPrimaryChars(...args) { return MaweSplitTrim.currentSplitTrimPrimaryChars(...args); }
export function splitTrimPrimaryCheckedSet(...args) { return MaweSplitTrim.splitTrimPrimaryCheckedSet(...args); }
export function splitTrimExtraSymbols(...args) { return MaweSplitTrim.splitTrimExtraSymbols(...args); }
export function updateSplitTrimSymbolsResetVisibility(...args) { return MaweSplitTrim.updateSplitTrimSymbolsResetVisibility(...args); }
export function persistSplitTrimSymbols(...args) { return MaweSplitTrim.persistSplitTrimSymbols(...args); }
export function renderSplitTrimSymbolGrid(...args) { return MaweSplitTrim.renderSplitTrimSymbolGrid(...args); }
export function refreshSplitTrimExtraInput(...args) { return MaweSplitTrim.refreshSplitTrimExtraInput(...args); }

// 查找替换：目标收集、正则构建、预览与范围控制。
// ESM init 模块：initMaweFindReplace 在原清单位次执行原 IIFE 体（挂
// window.MaweFindReplace 冻结门面——classic 侧出接口）；底部具名导出经门面
// 在调用时转发，兄弟模块可静态 import。
export function initMaweFindReplace() {
(function initMaweFindReplace(global) {
  'use strict';



  // === 批量替换 ===
  const findInput = document.getElementById('find-input');


  const replaceInput = document.getElementById('replace-input');


  const caseSensitiveCb = document.getElementById('case-sensitive');


  const useRegexCb = document.getElementById('use-regex');


  const replacePreview = document.getElementById('replace-preview');


  const replaceScopeInfo = document.getElementById('replace-scope-info');


  const replaceModalTitle = document.getElementById('replace-modal-title');


  const replaceSelectedOnlyCb = document.getElementById('replace-selected-only');


  const replaceSelectedOnlyHint = document.getElementById('replace-selected-only-hint');



  // null = 全部；[idxs] = 仅这些行
  let replaceScope = null;


  let replaceSelectionSnapshot = [];



  function normalizeBatchSelection(indexes) {
    const candidates = Array.isArray(indexes) ? indexes : [...MaweSelection.selectedIdxs];
    return [...new Set(candidates
      .filter((index) => Number.isInteger(index) && index >= 0 && index < MaweBoot.DATA.segments.length))]
      .sort((a, b) => a - b);
  }



  function getReplaceTargetIndexes() {
    return replaceScope && replaceScope.length
      ? [...replaceScope]
      : MaweBoot.DATA.segments.map((_, index) => index);
  }



  function updatePreview() {
    const find = findInput.value;
    replacePreview.replaceChildren();
    if (!find) {
      replacePreview.textContent = '输入查找内容查看预览';
      replacePreview.style.color = '#888';
      return;
    }
    const result = window.AsrEditorUtils.buildReplacementPreview(
      MaweBoot.DATA.segments,
      getReplaceTargetIndexes(),
      find,
      replaceInput.value,
      { caseSensitive: caseSensitiveCb.checked, useRegex: useRegexCb.checked },
    );
    if (result.error) {
      replacePreview.textContent = `正则错误: ${result.error}`;
      replacePreview.style.color = '#ffaaaa';
      return;
    }
    replacePreview.style.color = result.matchCount ? '#9ed4a4' : '#888';
    const summary = document.createElement('div');
    summary.className = 'replace-preview-summary';
    summary.textContent = result.matchCount
      ? `将在 ${result.lineCount} 行中替换 ${result.matchCount} 处匹配（展开查看前后文本）`
      : '没有匹配';
    replacePreview.appendChild(summary);
    result.rows.forEach((row) => {
      const details = document.createElement('details');
      details.className = 'replace-preview-row';
      const title = document.createElement('summary');
      title.textContent = `第 ${row.index + 1} 条 · ${row.matchCount} 处`;
      details.appendChild(title);
      const before = document.createElement('div');
      before.className = 'replace-preview-before';
      before.textContent = `替换前：${row.before}`;
      const after = document.createElement('div');
      after.className = 'replace-preview-after';
      after.textContent = `替换后：${row.after}`;
      details.append(before, after);
      replacePreview.appendChild(details);
    });
  }



  function refreshScopeInfo() {
    if (replaceScope && replaceScope.length) {
      replaceModalTitle.textContent = `批量替换（仅 ${replaceScope.length} 条选中）`;
      replaceScopeInfo.textContent = `当前范围：仅选中的 ${replaceScope.length} 条字幕`;
      replaceScopeInfo.style.color = '#d4a04a';
    } else {
      replaceModalTitle.textContent = '批量替换';
      replaceScopeInfo.textContent = `当前范围：全部 ${MaweBoot.DATA.segments.length} 条字幕`;
      replaceScopeInfo.style.color = '#888';
    }
  }



  function refreshReplaceSelectionControl() {
    if (!replaceSelectedOnlyCb) return;
    const available = replaceSelectionSnapshot.length > 0;
    replaceSelectedOnlyCb.disabled = !available;
    if (!available) replaceSelectedOnlyCb.checked = false;
    if (replaceSelectedOnlyHint) replaceSelectedOnlyHint.hidden = available;
    replaceScope = replaceSelectedOnlyCb.checked ? [...replaceSelectionSnapshot] : null;
    refreshScopeInfo();
  }



  function openReplaceModal(scope) {
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    replaceSelectionSnapshot = normalizeBatchSelection(
      Array.isArray(scope) && scope.length ? scope : [...MaweSelection.selectedIdxs],
    );
    replaceSelectedOnlyCb.checked = replaceSelectionSnapshot.length > 0;
    refreshReplaceSelectionControl();
    refreshScopeInfo();
    MaweDom.replaceModal.classList.add('show');
    setTimeout(() => findInput.focus(), 50);
    updatePreview();
  }

  global.MaweFindReplace = Object.freeze({
    findInput,
    replaceInput,
    caseSensitiveCb,
    useRegexCb,
    replacePreview,
    replaceScopeInfo,
    replaceModalTitle,
    replaceSelectedOnlyCb,
    replaceSelectedOnlyHint,
    get replaceScope() { return replaceScope; },
    set replaceScope(v) { replaceScope = v; },
    get replaceSelectionSnapshot() { return replaceSelectionSnapshot; },
    set replaceSelectionSnapshot(v) { replaceSelectionSnapshot = v; },
    normalizeBatchSelection,
    getReplaceTargetIndexes,
    updatePreview,
    refreshScopeInfo,
    refreshReplaceSelectionControl,
    openReplaceModal
  });
})(typeof window !== 'undefined' ? window : globalThis);
}

export function findInput(...args) { return window.MaweFindReplace.findInput(...args); }
export function replaceInput(...args) { return window.MaweFindReplace.replaceInput(...args); }
export function caseSensitiveCb(...args) { return window.MaweFindReplace.caseSensitiveCb(...args); }
export function useRegexCb(...args) { return window.MaweFindReplace.useRegexCb(...args); }
export function replacePreview(...args) { return window.MaweFindReplace.replacePreview(...args); }
export function replaceScopeInfo(...args) { return window.MaweFindReplace.replaceScopeInfo(...args); }
export function replaceModalTitle(...args) { return window.MaweFindReplace.replaceModalTitle(...args); }
export function replaceSelectedOnlyCb(...args) { return window.MaweFindReplace.replaceSelectedOnlyCb(...args); }
export function replaceSelectedOnlyHint(...args) { return window.MaweFindReplace.replaceSelectedOnlyHint(...args); }
export function normalizeBatchSelection(...args) { return window.MaweFindReplace.normalizeBatchSelection(...args); }
export function getReplaceTargetIndexes(...args) { return window.MaweFindReplace.getReplaceTargetIndexes(...args); }
export function updatePreview(...args) { return window.MaweFindReplace.updatePreview(...args); }
export function refreshScopeInfo(...args) { return window.MaweFindReplace.refreshScopeInfo(...args); }
export function refreshReplaceSelectionControl(...args) { return window.MaweFindReplace.refreshReplaceSelectionControl(...args); }
export function openReplaceModal(...args) { return window.MaweFindReplace.openReplaceModal(...args); }

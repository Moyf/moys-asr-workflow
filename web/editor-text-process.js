// 文本处理：处理项选择、预览与确认应用。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweTextProcess 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweTextProcess(global) {
  'use strict';



  // === 文本处理 ===
  const textProcessButton = document.getElementById('text-process-btn');


  const textProcessSelectedOnlyCb = document.getElementById('text-process-selected-only');


  const textProcessSelectedOnlyHint = document.getElementById('text-process-selected-only-hint');


  const textProcessScopeInfo = document.getElementById('text-process-scope-info');


  const textProcessPreview = document.getElementById('text-process-preview');


  const textProcessConfirm = document.getElementById('text-process-confirm');


  const textProcessTrim = document.getElementById('text-process-trim');


  const textProcessCapitalize = document.getElementById('text-process-capitalize');


  const textProcessPrefix = document.getElementById('text-process-prefix');


  const textProcessPrefixInput = document.getElementById('text-process-prefix-input');


  const textProcessSuffix = document.getElementById('text-process-suffix');


  const textProcessSuffixInput = document.getElementById('text-process-suffix-input');


  const textProcessStripMarkdown = document.getElementById('text-process-strip-markdown');


  let textProcessSelectionSnapshot = [];


  let textProcessScope = null;



  function textProcessSelectionTargets() {
    const targets = [...selectedIdxs]
      .sort((a, b) => a - b)
      .map((index) => ({ kind: 'main', index }));
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    if (extensionTrack) {
      [...selectedExtensionIdxs]
        .sort((a, b) => a - b)
        .forEach((index) => targets.push({
          kind: 'extension',
          index,
          trackId: extensionTrack.id,
        }));
    }
    return targets;
  }



  function textProcessAllTargets() {
    return MaweBoot.DATA.segments.map((_, index) => ({ kind: 'main', index }));
  }



  function textProcessTargetSegments(target) {
    return target?.kind === 'extension'
      ? MaweMultiSubtitleCore.getExtensionTrack(target.trackId)?.segments || []
      : MaweBoot.DATA.segments;
  }



  function textProcessTargetLabel(target) {
    return `${target?.kind === 'extension' ? '副字幕' : '主字幕'}第 ${(target?.index ?? 0) + 1} 条`;
  }



  function textProcessTargets() {
    return textProcessScope && textProcessScope.length
      ? textProcessScope
      : textProcessAllTargets();
  }



  function buildTextProcessPreview(targets, options) {
    return (Array.isArray(targets) ? targets : []).flatMap((target) => {
      const segments = textProcessTargetSegments(target);
      const segment = segments[target.index];
      if (!segment) return [];
      const before = String(segment.text == null ? '' : segment.text);
      const after = window.AsrEditorUtils.applyTextProcessing(before, options);
      return [{ ...target, before, after, changed: before !== after }];
    });
  }



  function getTextProcessOptions() {
    return {
      trim: textProcessTrim.checked,
      capitalize: textProcessCapitalize.checked,
      addPrefix: textProcessPrefix.checked,
      prefix: textProcessPrefixInput.value,
      addSuffix: textProcessSuffix.checked,
      suffix: textProcessSuffixInput.value,
      stripMarkdown: textProcessStripMarkdown.checked,
    };
  }



  function refreshTextProcessScopeInfo() {
    const selected = textProcessScope && textProcessScope.length;
    textProcessScopeInfo.textContent = selected
      ? `范围：仅选中的 ${textProcessScope.length} 条字幕`
      : `范围：全部 ${MaweBoot.DATA.segments.length} 条字幕`;
    textProcessScopeInfo.classList.toggle('selected', Boolean(selected));
  }



  function refreshTextProcessSelectionControl() {
    const available = textProcessSelectionSnapshot.length > 0;
    textProcessSelectedOnlyCb.disabled = !available;
    if (!available) textProcessSelectedOnlyCb.checked = false;
    if (textProcessSelectedOnlyHint) textProcessSelectedOnlyHint.hidden = available;
    textProcessScope = textProcessSelectedOnlyCb.checked
      ? [...textProcessSelectionSnapshot] : null;
    refreshTextProcessScopeInfo();
  }



  function renderTextProcessPreview() {
    const options = getTextProcessOptions();
    const hasOperation = textProcessTrim.checked || textProcessCapitalize.checked
      || textProcessPrefix.checked || textProcessSuffix.checked || textProcessStripMarkdown.checked;
    const targets = textProcessTargets();
    textProcessPreview.replaceChildren();
    if (!hasOperation) {
      textProcessPreview.textContent = '请选择至少一项文本处理操作';
      textProcessPreview.style.color = '';
      textProcessConfirm.disabled = true;
      return;
    }
    const rows = buildTextProcessPreview(targets, options);
    const result = {
      targetCount: rows.length,
      changedCount: rows.filter((row) => row.changed).length,
      rows,
    };
    textProcessPreview.style.color = result.changedCount ? '' : 'var(--text-muted)';
    const summary = document.createElement('div');
    summary.className = 'replace-preview-summary';
    summary.textContent = result.changedCount
      ? `将处理 ${result.targetCount} 条字幕，预计修改 ${result.changedCount} 条（展开查看前后文本）`
      : `选定的 ${result.targetCount} 条字幕不会发生变化`;
    textProcessPreview.appendChild(summary);
    result.rows.filter((row) => row.changed).forEach((row) => {
      const details = document.createElement('details');
      details.className = 'replace-preview-row';
      const title = document.createElement('summary');
      title.textContent = textProcessTargetLabel(row);
      details.appendChild(title);
      const before = document.createElement('div');
      before.className = 'replace-preview-before';
      before.textContent = `处理前：${row.before}`;
      const after = document.createElement('div');
      after.className = 'replace-preview-after';
      after.textContent = `处理后：${row.after}`;
      details.append(before, after);
      textProcessPreview.appendChild(details);
    });
    textProcessConfirm.disabled = false;
  }



  function refreshTextProcessInputState() {
    textProcessPrefixInput.disabled = !textProcessPrefix.checked;
    textProcessSuffixInput.disabled = !textProcessSuffix.checked;
  }



  function closeTextProcessModal() {
    MaweDom.textProcessModal.classList.remove('show');
  }



  function openTextProcessModal() {
    if (!MaweBoot.DATA.segments.length && !MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments?.length) {
      MaweHint.flashHint('当前没有可处理的字幕', 'invalid');
      return;
    }
    if (editingState) finishEdit(true);
    textProcessSelectionSnapshot = textProcessSelectionTargets();
    textProcessSelectedOnlyCb.checked = textProcessSelectionSnapshot.length > 0;
    refreshTextProcessSelectionControl();
    [textProcessTrim, textProcessCapitalize, textProcessPrefix,
      textProcessSuffix, textProcessStripMarkdown].forEach((input) => { input.checked = false; });
    textProcessPrefixInput.value = '';
    textProcessSuffixInput.value = '';
    refreshTextProcessInputState();
    MaweDom.textProcessModal.classList.add('show');
    renderTextProcessPreview();
    setTimeout(() => textProcessTrim.focus(), 50);
  }

  global.MaweTextProcess = Object.freeze({
    textProcessButton,
    textProcessSelectedOnlyCb,
    textProcessSelectedOnlyHint,
    textProcessScopeInfo,
    textProcessPreview,
    textProcessConfirm,
    textProcessTrim,
    textProcessCapitalize,
    textProcessPrefix,
    textProcessPrefixInput,
    textProcessSuffix,
    textProcessSuffixInput,
    textProcessStripMarkdown,
    get textProcessSelectionSnapshot() { return textProcessSelectionSnapshot; },
    set textProcessSelectionSnapshot(v) { textProcessSelectionSnapshot = v; },
    get textProcessScope() { return textProcessScope; },
    set textProcessScope(v) { textProcessScope = v; },
    textProcessSelectionTargets,
    textProcessAllTargets,
    textProcessTargetSegments,
    textProcessTargetLabel,
    textProcessTargets,
    buildTextProcessPreview,
    getTextProcessOptions,
    refreshTextProcessScopeInfo,
    refreshTextProcessSelectionControl,
    renderTextProcessPreview,
    refreshTextProcessInputState,
    closeTextProcessModal,
    openTextProcessModal
  });
})(typeof window !== 'undefined' ? window : globalThis);

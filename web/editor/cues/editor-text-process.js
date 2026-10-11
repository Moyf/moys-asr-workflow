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


  const wrapCharsModal = document.getElementById('wrap-chars-modal');


  const wrapCharsLeftInput = document.getElementById('wrap-chars-left');


  const wrapCharsRightInput = document.getElementById('wrap-chars-right');


  let wrapCharsScope = [];
  let textProcessWrapPreset = null;


  let textProcessSelectionSnapshot = [];


  let textProcessScope = null;



  function textProcessSelectionTargets() {
    const targets = [...MaweSelection.selectedIdxs]
      .sort((a, b) => a - b)
      .map((index) => ({ kind: 'main', index }));
    const extensionTrack = MaweMultiSubtitleCore.getActiveExtensionTrack();
    if (extensionTrack) {
      [...MaweSelection.selectedExtensionIdxs]
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
      skipWrapped: Boolean(textProcessWrapPreset
        && textProcessWrapPreset.left === textProcessPrefixInput.value
        && textProcessWrapPreset.right === textProcessSuffixInput.value),
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


  // 「左右添加字符」：在主字幕文本两端插入字符（支持多选批量）。插入一律双符号形式；
  // 已用同一对符号包裹的条目跳过，不重复包裹。
  // warnWordTimings=false 时不再提示字词时间码失配：右键快捷包裹属于刻意
  // 加装饰符号，字词时间码必然对不上，警告只会造成困扰。
  function applyWrapChars(scope, left, right, label = '左右添加字符', { warnWordTimings = true } = {}) {
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    const indexes = [...new Set((Array.isArray(scope) ? scope : [])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < MaweBoot.DATA.segments.length))]
      .sort((a, b) => a - b);
    if (!indexes.length) return;
    const { wrapCharsAroundText } = window.AsrEditorUtils;
    const previews = indexes.map((index) => ({
      index,
      ...wrapCharsAroundText(MaweBoot.DATA.segments[index]?.text, left, right),
    }));
    const skipped = previews.filter((row) => row.skipped).length;
    if (!previews.some((row) => row.changed)) {
      MaweHint.flashHint(skipped ? '选中字幕已包裹相同符号，未重复添加' : '没有可添加字符的字幕', 'invalid');
      return;
    }
    return MaweCommands.run(label, (command) => {
      let changed = 0, staleWordTimings = 0;
      previews.forEach((row) => {
        if (!row.changed) return;
        const segment = MaweBoot.DATA.segments[row.index];
        const previousText = segment.text;
        segment.text = row.text;
        segment._dirty = true;
        changed += 1;
        if (window.AsrEditorUtils.planWordTimingTextSync(segment, previousText)?.warn) staleWordTimings += 1;
      });
      command.commit({ cueList: true, waveform: 'overlay', preview: 'update' });
      MaweHistory.updateUndoRedoButtons();
      MaweHint.flashHint(
        skipped ? `已为 ${changed} 条字幕添加字符；${skipped} 条已包裹相同符号，已跳过` : `已为 ${changed} 条字幕添加字符`,
        'success',
      );
      if (warnWordTimings && staleWordTimings) {
        MaweHint.flashHint(`${staleWordTimings} 条字幕的字词时间码文字未随字符添加更新，请按需检查`, 'warning');
      }
    });
  }


  function openWrapCharsModal(scope) {
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    wrapCharsScope = (Array.isArray(scope) ? scope : [...MaweSelection.selectedIdxs])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < MaweBoot.DATA.segments.length);
    if (!wrapCharsScope.length) {
      MaweHint.flashHint('请先选择要处理的字幕', 'invalid');
      return;
    }
    if (wrapCharsLeftInput) wrapCharsLeftInput.value = '';
    if (wrapCharsRightInput) wrapCharsRightInput.value = '';
    wrapCharsModal?.classList.add('show');
    setTimeout(() => wrapCharsLeftInput?.focus(), 50);
  }


  function closeWrapCharsModal() {
    wrapCharsModal?.classList.remove('show');
  }



  function openTextProcessModal() {
    textProcessWrapPreset = null;
    if (!MaweBoot.DATA.segments.length && !MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments?.length) {
      MaweHint.flashHint('当前没有可处理的字幕', 'invalid');
      return;
    }
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
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
    openTextProcessModal,
    set textProcessWrapPreset(value) { textProcessWrapPreset = value; },
    wrapCharsModal,
    wrapCharsLeftInput,
    wrapCharsRightInput,
    get wrapCharsScope() { return wrapCharsScope; },
    set wrapCharsScope(v) { wrapCharsScope = v; },
    applyWrapChars,
    openWrapCharsModal,
    closeWrapCharsModal
  });
})(typeof window !== 'undefined' ? window : globalThis);

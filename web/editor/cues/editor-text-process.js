import { projectOverride, update, refresh, validateImport, setProjectOverride } from './editor-text-presets.js';
// Ordered subtitle processing, including the existing right-click wrapper.
// Ordered subtitle processing, including the existing right-click wrapper. ESM init 模块：initMaweTextProcess 在原清单位次执行原 IIFE 体（挂

// window.MaweTextProcess 冻结门面——classic 侧出接口）；底部具名导出经门面在调用时转发，
// 兄弟模块可静态 import。
export function initMaweTextProcess() {
(function initMaweTextProcess(global) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const modal = $('text-process-modal');
  const preview = $('text-process-preview');
  const apply = $('text-process-confirm');
  const selectedOnly = $('text-process-selected-only');
  const scopeInfo = $('text-process-scope-info');
  const stepList = $('text-preset-rules');
  const stepType = $('text-process-step-type');
  const presetSelect = $('text-preset-select');
  const storageStatus = $('text-preset-status');
  const presetDefault = $('text-preset-default');
  const presetFileMenu = $('text-preset-file-menu');
  const projectMenu = $('text-process-project-menu');
  const importFile = $('text-preset-import');
  const importDialog = $('text-preset-import-dialog');
  const importStatus = $('text-preset-import-status');
  const importPreview = $('text-preset-import-preview');
  const importTitle = $('text-preset-import-title');
  const importWarning = $('text-preset-import-warning');
  const importConfirm = $('text-preset-import-confirm');
  const importCancel = $('text-preset-import-cancel');
  const projectStatus = $('text-process-project-status');
  const maxSteps = 110;
  const wrapPresets = global.AsrEditorUtils.WRAP_CHAR_PRESETS;
  const emptyPreview = '在左侧添加处理步骤，即可查看字幕改动。';
  const stepLabels = Object.fromEntries([...stepType.options].map(({ value, text }) => [value, text]));
  const translate = (value) => global.MAWE_I18N?.translateText(value) ?? value;

  const wrapCharsModal = $('wrap-chars-modal');
  const wrapCharsLeftInput = $('wrap-chars-left');
  const wrapCharsRightInput = $('wrap-chars-right');
  let wrapCharsScope = [];

  let steps = [];
  let prefilledStep;
  let selectedPreset = '';
  let selection = [];
  let previewController = null;
  let previewTimer;
  let result = null;
  let session = 0;
  let reading = false;
  let writing = false;
  let expanded = false;
  let showUnchanged = false;
  let importRequest;
  let pendingImport;
  const openRows = new Map();

  function button(text, click) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = text;
    node.addEventListener('click', click);
    return node;
  }

  function input(label, value, onInput, type = 'text', placeholder = label) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const field = document.createElement('input');
    field.type = type;
    field.setAttribute('aria-label', label);
    if (type === 'checkbox') field.checked = value;
    else {
      field.placeholder = placeholder;
      field.value = value;
      field.autocomplete = 'off';
    }
    field.addEventListener('input', () => {
      onInput(type === 'checkbox' ? field.checked : field.value);
      refreshActions();
      schedulePreview();
    });
    wrapper.append(field);
    return wrapper;
  }

  function renderWrappers(host, step, assMode) {
    function addGroup(title, presets) {
      const group = document.createElement('div');
      group.className = 'text-process-wrap-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', title);
      const caption = document.createElement('span');
      caption.className = 'text-process-wrap-group-title';
      caption.textContent = title;
      const buttons = document.createElement('div');
      buttons.className = 'text-process-wrap-preset-buttons';
      for (const preset of presets) {
        const active = step.wraps.some(({ id }) => id === preset.id);
        const toggle = button(preset.label, () => {
          if (active) step.wraps = step.wraps.filter(({ id }) => id !== preset.id);
          else step.wraps.push(preset.id === 'custom' ? { id: 'custom', left: '', right: '' } : { id: preset.id });
          host.replaceChildren();
          renderWrappers(host, step, assMode);
          if (!active && preset.id === 'custom') host.querySelector('input')?.focus();
          else host.querySelector('[data-wrap-preset-id="' + preset.id + '"]')?.focus();
          refreshActions();
          schedulePreview();
        });
        toggle.dataset.wrapPresetId = preset.id;
        toggle.setAttribute('aria-pressed', String(active));
        buttons.append(toggle);
      }
      group.append(caption, buttons);
      host.append(group);
      return group;
    }

    const plain = addGroup('普通字符', [...wrapPresets.filter(({ ass }) => !ass), { id: 'custom', label: '自定义' }]);
    for (const custom of step.wraps.filter(({ id }) => id === 'custom')) {
      const fields = document.createElement('div');
      fields.className = 'processing-controls';
      fields.append(input('左侧添加', custom.left, (value) => { custom.left = value; }),
        input('右侧添加', custom.right, (value) => { custom.right = value; }));
      plain.append(fields);
    }
    if (assMode) {
      addGroup('MASS 特殊样式', wrapPresets.filter(({ ass, sentenceLevel }) => ass && !sentenceLevel));
      addGroup('MASS 整句动画', wrapPresets.filter(({ sentenceLevel }) => sentenceLevel));
    } else {
      const hint = document.createElement('p');
      hint.className = 'modal-hint';
      hint.textContent = '如需使用特殊文本样式（MASS），请先启用 ASS 字幕样式。';
      host.append(hint);
    }
  }

  function renderSteps() {
    stepList.replaceChildren();
    steps.forEach((step, index) => {
      const row = document.createElement('li');
      row.className = 'text-preset-rule';
      row.dataset.stepIndex = String(index);
      const header = document.createElement('div');
      header.className = 'processing-controls';
      const label = document.createElement('strong');
      label.textContent = translate(stepLabels[step.type] || '未知步骤');
      const move = (offset) => {
        const next = index + offset;
        [steps[next], steps[index]] = [steps[index], steps[next]];
        renderSteps();
        stepList.children[next]?.querySelector('button:not(:disabled)')?.focus();
      };
      const iconButton = (symbol, name, click) => {
        const control = button(symbol, click);
        control.classList.add('processing-step-icon');
        control.setAttribute('aria-label', translate(name));
        control.title = translate(name);
        return control;
      };
      const up = iconButton('↑', '上移', () => move(-1));
      const down = iconButton('↓', '下移', () => move(1));
      up.disabled = index === 0;
      down.disabled = index === steps.length - 1;
      const enabled = input('启用', step.enabled !== false, (value) => { step.enabled = value; }, 'checkbox');
      header.append(label, enabled, up, down, iconButton('×', '删除步骤', () => {
        steps.splice(index, 1);
        renderSteps();
        (stepList.children[index]?.querySelector('button:not(:disabled)') || $('text-preset-add-rule')).focus();
      }));
      row.append(header);
      const fields = document.createElement('div');
      if (step.type === 'replace') {
        fields.className = 'processing-controls processing-replace-fields';
        fields.append(input('查找', step.find, (value) => { step.find = value; }, 'text', '查找文本'),
          input('替换为', step.replacement, (value) => { step.replacement = value; }, 'text', '替换为（留空即删除）'));
        const options = document.createElement('div');
        options.className = 'processing-controls processing-replace-options';
        options.setAttribute('role', 'group');
        options.setAttribute('aria-label', '选项');
        const optionLabel = document.createElement('span');
        optionLabel.className = 'text-process-control-label';
        optionLabel.textContent = '选项';
        options.append(optionLabel,
          input('区分大小写', step.caseSensitive, (value) => { step.caseSensitive = value; }, 'checkbox'),
          input('正则', step.regex, (value) => { step.regex = value; }, 'checkbox'));
        row.append(fields, options);
      } else if (step.type === 'wrap') {
        fields.className = 'processing-wrap-fields';
        renderWrappers(fields, step, MaweSettings.EDITOR_SETTINGS.assMode);
        row.append(fields);
      }
      stepList.append(row);
    });
    refreshActions();
    schedulePreview();
  }

  class IncompleteStepError extends Error {}

  function prepareStep(step, assMode = true) {
    if (step.type === 'replace') {
      if (!step.find) throw new IncompleteStepError('请输入查找内容');
      const compiled = global.AsrEditorUtils.compileTextSearchPattern(step.find,
        { useRegex: step.regex, caseSensitive: step.caseSensitive });
      if (compiled.error) throw new Error('正则表达式无效 ' + compiled.error);
      return compiled.regex;
    }
    if (step.type === 'wrap') {
      const pairs = step.wraps.map((wrap) => {
        if (wrap.id === 'custom') return wrap;
        const preset = wrapPresets.find(({ id }) => id === wrap.id);
        return preset && { ...preset, ...wrap };
      });
      if (pairs.some((pair) => !pair)) throw new Error('未知步骤');
      if (pairs.some((pair) => pair.ass) && !assMode) throw new Error('该预设包含 ASS 特殊文本样式，请先开启 ASS 模式');
      if (!pairs.length || pairs.some(({ left, right }) => !left && !right)) throw new IncompleteStepError('请选择包裹字符或填写自定义字符');
      return { addWrapChars: true, wrapPairs: pairs, skipWrapped: true };
    }
    if (!Object.hasOwn(stepLabels, step.type)) throw new Error('未知步骤');
    return { [step.type]: true };
  }

  function refreshActions() {
    const { defaultPresetId, presets } = window.MaweProcessing.library;
    const saved = presets.some(({ id }) => id === selectedPreset);
    const available = !reading && !writing;
    const valid = steps.length > 0 && !hasUntouchedPrefill();
    presetSelect.disabled = !available;
    importCancel.disabled = writing;
    $('text-preset-export-current').disabled = !available || !saved;
    for (const id of ['text-preset-export-library', 'text-preset-import-button', 'text-preset-import']) $(id).disabled = !available;
    $('text-preset-add-rule').disabled = steps.length >= maxSteps;
    $('text-preset-save-as').disabled = !available || !valid || presets.length >= 100;
    $('text-preset-save').disabled = !available || !saved || !valid;
    $('text-preset-rename').disabled = !available || !saved;
    $('text-preset-delete').disabled = !available || !saved;
    presetDefault.disabled = !available || !saved;
    presetDefault.textContent = saved && selectedPreset === defaultPresetId ? '取消默认' : '设为默认';
    $('text-process-project-save').disabled = !valid;
    const override = projectOverride('text');
    $('text-process-project-reset').disabled = !available || override === undefined;
    $('text-process-project-empty').disabled = Array.isArray(override) && !override.length;
    projectStatus.textContent = override === undefined ? '工程内继承默认预设'
      : override.length ? '已保存当前工程默认处理' : '工程内默认留空';
  }

  function renderPresets() {
    const { presets, defaultPresetId } = window.MaweProcessing.library;
    presetSelect.replaceChildren(new Option('自定义步骤', ''));
    for (const { id, name } of presets) {
      const option = new Option(name + (id === defaultPresetId ? ' ★' : ''), id);
      option.dataset.markerProjectContent = '';
      presetSelect.add(option);
    }
    if (!presets.some(({ id }) => id === selectedPreset)) selectedPreset = '';
    presetSelect.value = selectedPreset;
    refreshActions();
  }

  function setPresetScope(scope) {
    const hasSelection = selection.length > 0;
    selectedOnly.checked = scope === undefined ? hasSelection : scope === 'selected';
    selectedOnly.disabled = !hasSelection && !selectedOnly.checked;
  }

  function loadDefault({ preserveScope = false } = {}) {
    const { presets, defaultPresetId } = window.MaweProcessing.library;
    const preset = presets.find(({ id }) => id === defaultPresetId);
    const project = projectOverride('text');
    selectedPreset = project === undefined ? preset?.id || '' : '';
    steps = structuredClone(project ?? preset?.steps ?? []);
    if (!preserveScope) setPresetScope(project === undefined ? preset?.scope : undefined);
    if (!selectedPreset) prefillEmptySteps();
    renderPresets();
    renderSteps();
  }

  function showStorageStatus(text, state) {
    storageStatus.textContent = text;
    storageStatus.dataset.state = state;
  }

  function showStorageReady() {
    if (window.MaweProcessing.portable) showStorageStatus('仅保存在当前浏览器（便携模式）', 'local');
    else showStorageStatus('已与用户级配置同步', 'success');
  }

  async function saveLibrary(change, newSelection = selectedPreset) {
    const current = session;
    writing = true;
    showStorageStatus(window.MaweProcessing.portable ? '正在保存到当前浏览器…' : '正在保存用户级预设库…', 'pending');
    refreshActions();
    const status = await update(change);
    writing = false;
    if (!modal.classList.contains('show')) return status;
    if (status === 'saved') {
      if (current === session) selectedPreset = newSelection;
      showStorageReady();
    } else if (status === 'conflict') {
      showStorageStatus('预设库已被其他页面修改，请重新打开', 'warning');
    } else {
      const reason = status instanceof Error ? status.message : '无法保存用户配置';
      showStorageStatus('保存失败：' + reason, 'error');
    }
    renderPresets();
    return status;
  }

  function captureTargets(mainIndexes) {
    const main = MaweBoot.DATA.segments;
    const track = mainIndexes ? null : MaweMultiSubtitleCore.getActiveExtensionTrack();
    return [
      ...[...(mainIndexes ?? MaweSelection.selectedIdxs)].sort((a, b) => a - b)
        .map((index) => ({ id: main[index]?.id })),
      ...[...MaweSelection.selectedExtensionIdxs].sort((a, b) => a - b)
        .filter(() => track).map((index) => ({ id: track.segments[index]?.id, trackId: track.id })),
    ].filter(({ id }) => id);
  }

  function currentRows() {
    const main = MaweBoot.DATA.segments;
    const rows = (segments, trackId) => segments.map((segment, index) => ({
      segment, index, trackId, before: String(segment.text ?? ''),
    }));
    const mainRows = rows(main);
    const targetRows = selectedOnly.checked ? [
      ...mainRows,
      ...[...new Set(selection.map(({ trackId }) => trackId).filter(Boolean))].flatMap((id) =>
        rows(MaweMultiSubtitleCore.getExtensionTrack(id)?.segments || [], id)),
    ] : mainRows;
    if (!selectedOnly.checked) return targetRows;
    const selectedIds = new Set(selection.map(({ id, trackId }) => JSON.stringify([trackId, id])));
    return targetRows.filter(({ segment, trackId }) => selectedIds.has(JSON.stringify([trackId, segment.id])));
  }

  // Feed replacements to the worker in small batches so a
  // pathological regex can be terminated without cancelling healthy long projects.
  function replaceBatch(texts, source, flags, replacement, useRegex, expand) {
    const regex = new RegExp(source, flags);
    return texts.map((text) => {
      let result = '';
      let cursor = 0;
      const limit = Math.max(262144, text.length);
      for (const match of text.matchAll(regex)) {
        const start = match.index;
        const end = start + match[0].length;
        const value = useRegex ? expand(replacement, {
          start, end, text: match[0], captures: match.slice(1), groups: match.groups,
        }, text) : replacement;
        if (result.length + start - cursor + value.length > limit) throw new Error('替换结果过长');
        result += text.slice(cursor, start) + value;
        cursor = end;
      }
      if (result.length + text.length - cursor > limit) throw new Error('替换结果过长');
      return result + text.slice(cursor);
    });
  }

  function makeRegexWorker() {
    // The existing substitution helper is pure and self-contained. Embedding
    // both functions in a Blob also supports the standalone file:// editor.
    const source = 'const run = ' + replaceBatch.toString()
      + ';const expand = ' + global.AsrEditorUtils.expandTextSearchReplacement.toString()
      + ';self.onmessage = ({data}) => { try { self.postMessage({texts: run(...data, expand)}); }'
      + 'catch (error) { self.postMessage({error: error.message}); } };';
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { return new Worker(url); } finally { URL.revokeObjectURL(url); }
  }

  function regexRequest(worker, args, signal) {
    return new Promise((resolve, reject) => {
      const finish = (error, texts) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        worker.onmessage = null;
        worker.onerror = null;
        if (error) reject(error);
        else resolve(texts);
      };
      const cancel = () => finish(signal.reason);
      const timer = setTimeout(() => finish(new Error('规则运行超时，请简化正则表达式')), 1500);
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.texts);
      worker.onerror = () => finish(new Error('无法启动正则预览'));
      try { worker.postMessage(args); } catch (error) { finish(error); }
    });
  }

  async function processRows(rows, recipe, signal) {
    let texts = rows.map(({ before }) => before);
    let worker;
    const { assMode, assSpecialSymbolRule } = MaweSettings.EDITOR_SETTINGS;
    try {
      for (const [index, step] of recipe.entries()) {
        try {
          signal.throwIfAborted();
          if (step.enabled === false) continue;
          const operation = prepareStep(step, assMode);
          if (step.type !== 'replace') {
            texts = texts.map((value) => global.AsrEditorUtils.applyTextProcessing(value,
              { ...operation, assSpecialSymbolRule }));
          } else {
            worker ||= makeRegexWorker();
            const next = [];
            for (let start = 0; start < texts.length; start += 64) {
              signal.throwIfAborted();
              next.push(...await regexRequest(worker, [
                texts.slice(start, start + 64), operation.source, operation.flags, step.replacement, step.regex,
              ], signal));
            }
            texts = next;
          }
        } catch (error) {
          if (!signal.aborted) {
            stepList.children[index]?.setAttribute('aria-invalid', 'true');
            const prefix = error instanceof IncompleteStepError ? '左侧步骤不完整' : '左侧步骤无法执行';
            const label = stepLabels[step.type] || '未知步骤';
            throw new Error(prefix + '： [' + (index + 1) + '. ' + label + '] （' + error.message + '）');
          }
          throw error;
        }
      }
      return rows.map((row, index) => ({ ...row, after: texts[index] }));
    } finally {
      worker?.terminate();
    }
  }

  function showResult(rows) {
    const changed = rows.filter(({ before, after }) => before !== after);
    const header = document.createElement('div');
    header.className = 'replace-preview-summary text-process-preview-summary';
    const summary = document.createElement('span');
    summary.textContent = changed.length
      ? '将处理 ' + rows.length + ' 条字幕，预计修改 ' + changed.length + ' 条'
      : '选定的 ' + rows.length + ' 条字幕不会发生变化';
    const controls = document.createElement('div');
    controls.className = 'text-process-preview-actions';
    header.append(summary, controls);
    preview.replaceChildren(header);
    if (changed.length < rows.length) {
      const filter = button(showUnchanged ? '仅看有变化的字幕' : '查看全部字幕', () => {
        showUnchanged = !showUnchanged;
        showResult(rows);
        preview.querySelector('.text-process-preview-filter')?.focus();
      });
      filter.className = 'text-process-preview-filter';
      filter.setAttribute('aria-pressed', String(showUnchanged));
      controls.append(filter);
    }
    const details = (showUnchanged ? rows : changed).map((row) => {
      const node = document.createElement('details');
      node.className = 'replace-preview-row';
      const key = JSON.stringify([row.trackId, row.segment.id]);
      node.open = openRows.get(key) ?? expanded;
      const title = document.createElement('summary');
      title.textContent = (row.trackId ? '副字幕' : '主字幕') + '第 ' + (row.index + 1) + ' 条';
      const snippet = document.createElement('span');
      snippet.className = 'text-process-result-snippet';
      snippet.textContent = row.after || '（空字幕）';
      if (row.after) snippet.dataset.markerProjectContent = '';
      title.append(snippet);
      const before = document.createElement('div');
      const after = document.createElement('div');
      before.className = 'replace-preview-before';
      after.className = 'replace-preview-after';
      const appendText = (parent, label, value) => {
        const content = document.createElement('span');
        content.dataset.markerProjectContent = '';
        content.textContent = value;
        parent.append(document.createTextNode(label), content);
      };
      appendText(before, '处理前：', row.before);
      appendText(after, '处理后：', row.after);
      node.append(title, before, after);
      node.addEventListener('toggle', () => {
        if (!node.isConnected) return;
        openRows.set(key, node.open);
        syncExpandLabel();
      });
      return node;
    });
    const toggle = button('', () => {
      expanded = !details.every((node) => node.open);
      details.forEach((node) => { node.open = expanded; });
      syncExpandLabel();
    });
    toggle.className = 'text-process-preview-toggle';
    function syncExpandLabel() {
      toggle.textContent = details.every((node) => node.open) ? '全部收缩' : '全部展开';
    }
    if (details.length) controls.append(toggle);
    syncExpandLabel();
    for (const node of details) preview.append(node);
    apply.disabled = reading || changed.length === 0;
  }

  function cancelPreview() {
    clearTimeout(previewTimer);
    previewController?.abort();
    previewController = null;
    result = null;
    apply.disabled = true;
  }

  function schedulePreview() {
    cancelPreview();
    if (!modal.classList.contains('show')) return;
    preview.classList.remove('text-process-preview-error');
    stepList.querySelectorAll('[aria-invalid]').forEach((node) => node.removeAttribute('aria-invalid'));
    const rows = currentRows();
    scopeInfo.textContent = selectedOnly.checked ? '当前范围：仅选中的 ' + rows.length + ' 条字幕'
      : '当前范围：全部 ' + rows.length + ' 条字幕';
    scopeInfo.classList.toggle('selected', selectedOnly.checked);
    const missingSelection = selectedOnly.checked && !rows.length;
    $('text-process-selected-only-hint').hidden = !selectedOnly.disabled && !missingSelection;
    if (missingSelection) {
      preview.textContent = '需要先选中至少1条字幕才可启用';
      return;
    }
    const hasSteps = !hasUntouchedPrefill() && steps.some((step) => step.enabled !== false);
    preview.textContent = hasSteps ? '正在生成预览…' : emptyPreview;
    if (!hasSteps) return;
    const controller = new AbortController();
    previewController = controller;
    const recipe = structuredClone(steps);
    previewTimer = setTimeout(async () => {
      try {
        const rowsAfter = await processRows(rows, recipe, controller.signal);
        if (controller.signal.aborted) return;
        result = rowsAfter;
        showResult(rowsAfter);
      } catch (error) {
        if (controller.signal.aborted) return;
        preview.classList.add('text-process-preview-error');
        preview.textContent = error.message;
      }
    }, 120);
  }

  function closeTextProcessModal({ restoreFocus = true } = {}) {
    if (!modal.classList.contains('show')) return;
    session++;
    closeImport();
    presetFileMenu.open = false;
    projectMenu.open = false;
    modal.classList.remove('show');
    cancelPreview();
    if (restoreFocus) $('text-process-btn')?.focus();
  }

  function createStep(type) {
    if (type === 'replace') return { type, find: '', replacement: '', regex: false, caseSensitive: false };
    return type === 'wrap' ? { type, wraps: [] } : { type };
  }

  // 空步骤时预填一步「替换文本」，降低首次使用的上手成本。工程覆盖「显式留空」
  // （空数组）时不预填；只在本函数被调用（打开弹窗/切换预设）时补一次，
  // 用户删除后不强制回填。
  function prefillEmptySteps() {
    if (steps.length || projectOverride('text')?.length === 0) return;
    prefilledStep = createStep('replace');
    steps = [prefilledStep];
  }

  function hasUntouchedPrefill() {
    return steps.length === 1 && steps[0] === prefilledStep && !prefilledStep.find
      && !prefilledStep.replacement && !prefilledStep.regex && !prefilledStep.caseSensitive
      && prefilledStep.enabled === undefined;
  }

  async function openTextProcessModal({ replaceSelection } = {}) {
    if (!MaweBoot.DATA.segments.length && !MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments?.length) {
      MaweHint.flashHint('当前没有可处理的字幕', 'invalid');
      return;
    }
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    MaweCuePanel.commitCuePanelEdit();
    const current = ++session;
    selection = captureTargets(replaceSelection);
    openRows.clear();
    expanded = false;
    showUnchanged = false;
    reading = true;
    modal.classList.add('show');
    if (!writing) showStorageStatus('正在加载…', 'pending');
    if (replaceSelection) {
      selectedPreset = '';
      steps = [createStep('replace')];
      stepType.value = 'replace';
      setPresetScope('selected');
      renderPresets();
      renderSteps();
      stepList.querySelector('.processing-replace-fields input')?.focus();
    } else {
      loadDefault();
      $('text-preset-add-rule').focus();
    }
    const fingerprint = () => JSON.stringify([steps, selectedPreset]);
    const initial = fingerprint();
    const initialScope = selectedOnly.checked;
    const ok = await refresh();
    if (session !== current) return;
    reading = false;
    if (!writing) {
      if (ok) showStorageReady();
      else showStorageStatus('无法读取用户配置', 'error');
    }
    if (!replaceSelection && fingerprint() === initial) loadDefault({ preserveScope: selectedOnly.checked !== initialScope });
    else {
      renderPresets();
      schedulePreview();
    }
  }

  function confirm() {
    if (reading || !result) return;
    const current = currentRows();
    if (current.length !== result.length || current.some(({ segment, before }, index) =>
      segment !== result[index].segment || before !== result[index].before)) {
      schedulePreview();
      return;
    }
    const changes = result.filter(({ before, after }) => before !== after);
    if (!changes.length) return;
    const mappings = changes.map(({ segment, before, after }) =>
      global.AsrEditorUtils.reconcileTimedTextItems(before, segment.items, after));
    closeTextProcessModal();
    MaweCommands.run('文本处理', (command) => {
      let affected = 0;
      let extensionChanged = false;
      for (const [index, { segment, trackId, after }] of changes.entries()) {
        const mapping = mappings[index];
        segment.text = after;
        segment._dirty = true;
        if (!after || mapping.status === 'lost') delete segment.items;
        else if (mapping.items) segment.items = mapping.items;
        if (mapping.status === 'lost' || mapping.affectedItems > 0) affected++;
        if (trackId) extensionChanged = true;
      }
      if (extensionChanged) MaweMultiSubtitleCore.markMultiSubtitleDirty();
      command.commit({ cueList: true, waveform: 'overlay', preview: 'update' });
      MaweHistory.updateUndoRedoButtons();
      MaweHint.flashHint(affected
        ? '已应用文本处理：' + changes.length + ' 条字幕，' + affected + ' 条字词时间码未能完整保留'
        : '已应用文本处理：' + changes.length + ' 条字幕', affected ? 'warning' : 'success');
    });
  }

  $('text-process-btn').addEventListener('click', () => openTextProcessModal());
  $('text-process-cancel').addEventListener('click', () => closeTextProcessModal());
  modal.addEventListener('click', (event) => {
    for (const menu of [presetFileMenu, projectMenu]) {
      if (!menu.contains(event.target)) menu.open = false;
    }
    if (event.target === modal) closeTextProcessModal();
  });
  document.addEventListener('keydown', (event) => {
    if (!modal.classList.contains('show') || event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (importDialog.open) {
      if (!writing) closeImport({ restoreFocus: true });
      return;
    }
    const menu = [presetFileMenu, projectMenu].find(({ open }) => open);
    if (menu) dismissMenu(menu);
    else closeTextProcessModal();
  }, true);
  selectedOnly.addEventListener('change', schedulePreview);
  apply.addEventListener('click', confirm);
  $('text-preset-add-rule').addEventListener('click', () => {
    // 第一次添加其他步骤时，让它接替尚未编辑的预填项。
    const existing = hasUntouchedPrefill() ? [] : steps;
    steps = [...existing, createStep(stepType.value)];
    renderSteps();
    const row = stepList.lastElementChild;
    (row?.querySelector('input[type="text"], .text-process-wrap-preset-buttons button') || row?.querySelector('input'))?.focus();
  });
  presetSelect.addEventListener('change', () => {
    selectedPreset = presetSelect.value;
    const preset = window.MaweProcessing.library.presets.find(({ id }) => id === selectedPreset);
    steps = structuredClone(preset?.steps || []);
    if (preset) setPresetScope(preset.scope);
    else prefillEmptySteps();
    renderSteps();
  });
  const currentScope = () => selectedOnly.checked ? 'selected' : 'all';
  $('text-preset-save-as').addEventListener('click', () => {
    const name = global.prompt('预设名称')?.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    const recipe = structuredClone(steps);
    const scope = currentScope();
    void saveLibrary((draft) => { draft.presets.push({ id, name, scope, steps: recipe }); }, id);
  });
  $('text-preset-save').addEventListener('click', () => {
    const id = selectedPreset;
    const recipe = structuredClone(steps);
    const scope = currentScope();
    void saveLibrary((draft) => Object.assign(draft.presets.find((preset) => preset.id === id), { steps: recipe, scope }));
  });
  $('text-preset-rename').addEventListener('click', () => {
    const id = selectedPreset;
    const current = window.MaweProcessing.library.presets.find((preset) => preset.id === id);
    const name = global.prompt('预设名称', current.name)?.trim();
    if (name) void saveLibrary((draft) => { draft.presets.find((preset) => preset.id === id).name = name; });
  });
  $('text-preset-delete').addEventListener('click', () => {
    const id = selectedPreset;
    if (!global.confirm('删除这个预设？')) return;
    void saveLibrary((draft) => {
      draft.presets = draft.presets.filter((preset) => preset.id !== id);
      if (draft.defaultPresetId === id) draft.defaultPresetId = null;
    }, '');
  });
  function dismissMenu(menu) {
    menu.open = false;
    menu.querySelector('summary').focus();
  }

  // 导入单条预设时生成不与现有预设重名的名称（「原名 (2)」「原名 (3)」…）。
  function uniquePresetName(name) {
    const names = new Set(window.MaweProcessing.library.presets.map(({ name }) => name));
    if (!names.has(name)) return name;
    for (let index = 2; ; index++) {
      const candidate = name + ' (' + index + ')';
      if (!names.has(candidate)) return candidate;
    }
  }

  function closeImport({ restoreFocus = false } = {}) {
    importRequest = undefined;
    pendingImport = undefined;
    if (!importDialog.open) return;
    importDialog.close();
    if (restoreFocus) presetFileMenu.querySelector('summary').focus();
  }

  function renderImport({ kind, presets, defaultPresetId, preset }) {
    const rows = kind === 'single' ? [preset] : presets;
    const list = document.createElement('ul');
    for (const row of rows) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.dataset.markerProjectContent = '';
      title.textContent = row.name + (kind === 'library' && row.id === defaultPresetId ? ' ★' : '');
      const scope = document.createElement('small');
      scope.className = 'text-preset-import-scope';
      scope.textContent = row.scope === 'selected' ? '仅处理选中字幕' : '全部字幕';
      item.append(title, scope);
      if (row.steps.length) {
        const recipe = document.createElement('ol');
        for (const step of row.steps) {
          const line = document.createElement('li');
          line.append(document.createTextNode(stepLabels[step.type]));
          if (step.enabled === false) line.append(' · ', translate('已停用'));
          if (step.type === 'replace' || step.type === 'wrap') {
            const values = document.createElement('code');
            values.dataset.markerProjectContent = '';
            values.textContent = step.type === 'replace'
              ? JSON.stringify(step.find) + ' → ' + JSON.stringify(step.replacement)
              : step.wraps.map(({ id, left, right }) => {
                const preset = wrapPresets.find((preset) => preset.id === id);
                const pair = JSON.stringify(left ?? preset?.left) + ' … ' + JSON.stringify(right ?? preset?.right);
                if (id === 'custom') return pair;
                const label = translate(preset.label);
                return left === undefined && right === undefined ? label : label + ' ' + pair;
              }).join(' → ');
            if (values.textContent) line.append('　', values);
            if (step.regex) line.append(' · ', translate('正则'));
            if (step.caseSensitive) line.append(' · ', translate('区分大小写'));
          }
          recipe.append(line);
        }
        item.append(recipe);
      } else {
        const empty = document.createElement('p');
        empty.textContent = '无处理步骤';
        item.append(empty);
      }
      list.append(item);
    }
    if (kind === 'single' || rows.length) importPreview.replaceChildren(list);
    else importPreview.textContent = '此文件不含预设。确认后会清空现有预设库。';
  }

  // 导出优先走系统的「另存为」对话框（可选路径和文件名）；环境不支持或失败时
  // 回退为普通 blob 下载。AbortError 是用户在对话框里点了取消，静默返回。
  async function exportPresetFile(suggestedName, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    if (MaweHost.files.hasSavePicker()) {
      try {
        const handle = await MaweHost.files.pickSaveFile({
          suggestedName,
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        });
        await MaweHost.files.writeBlob(handle, () => blob);
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }
    MaweHost.files.downloadBlob(blob, suggestedName);
  }

  $('text-preset-export-current').addEventListener('click', async () => {
    dismissMenu(presetFileMenu);
    const preset = window.MaweProcessing.library.presets.find(({ id }) => id === selectedPreset);
    if (!preset) return;
    await exportPresetFile(preset.name + '.json', preset);
  });
  $('text-preset-export-library').addEventListener('click', async () => {
    dismissMenu(presetFileMenu);
    const { schema, presets, defaultPresetId } = window.MaweProcessing.library;
    await exportPresetFile('处理预设库.json', { schema, presets, defaultPresetId });
  });
  $('text-preset-import-button').addEventListener('click', () => {
    dismissMenu(presetFileMenu);
    importFile.click();
  });
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (!file || reading || writing || !modal.classList.contains('show')) return;
    const request = importRequest = Symbol();
    pendingImport = undefined;
    importPreview.replaceChildren();
    importPreview.hidden = true;
    importTitle.textContent = translate('导入处理预设');
    importWarning.hidden = true;
    importConfirm.hidden = true;
    importConfirm.disabled = true;
    importStatus.textContent = '正在核验预设文件…';
    importDialog.showModal();
    try {
      if (file.size > 1024 * 1024) throw new Error('文件过大');
      const text = await file.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new Error('文件不是有效的 JSON'); }
      const imported = validateImport(parsed);
      if (request !== importRequest) return;
      const single = imported.kind === 'single';
      importTitle.textContent = translate(single ? '导入单条处理预设' : '导入处理预设');
      importWarning.textContent = translate(single
        ? '确认后会作为新预设加入当前预设库，不会改动现有预设和默认设置。'
        : '确认后会替换现有预设库和默认预设设置。');
      importConfirm.textContent = translate(single ? '加入预设库' : '确认替换预设库');
      renderImport(imported);
      pendingImport = imported;
      importStatus.textContent = '';
      importPreview.hidden = false;
      importWarning.hidden = false;
      importConfirm.hidden = false;
      importConfirm.disabled = false;
    } catch (error) {
      if (request === importRequest) importStatus.textContent = '导入失败：' + error.message;
    }
  });
  importCancel.addEventListener('click', () => closeImport({ restoreFocus: true }));
  importDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!writing) closeImport({ restoreFocus: true });
  });
  importConfirm.addEventListener('click', async () => {
    if (!pendingImport || writing) return;
    const request = importRequest;
    importConfirm.disabled = true;
    importStatus.textContent = '正在保存预设库…';
    let status;
    if (pendingImport.kind === 'single') {
      const preset = {
        ...structuredClone(pendingImport.preset),
        id: crypto.randomUUID(),
        name: uniquePresetName(pendingImport.preset.name),
      };
      // Append without changing which preset the current form edits.
      status = await saveLibrary((draft) => { draft.presets.push(preset); });
    } else {
      const { presets, defaultPresetId } = pendingImport;
      status = await saveLibrary((draft) => Object.assign(draft, { presets, defaultPresetId }), '');
    }
    if (request !== importRequest) return;
    if (status === 'saved') closeImport({ restoreFocus: true });
    else {
      importStatus.textContent = storageStatus.textContent;
      importConfirm.disabled = status === 'conflict';
    }
  });
  presetDefault.addEventListener('click', () => {
    const id = selectedPreset;
    void saveLibrary((draft) => { draft.defaultPresetId = draft.defaultPresetId === id ? null : id; });
  });
  $('text-process-project-save').addEventListener('click', () => {
    dismissMenu(projectMenu);
    try {
      setProjectOverride('text', steps);
      refreshActions();
    } catch (error) {
      projectStatus.textContent = '保存失败：' + error.message;
    }
  });
  $('text-process-project-empty').addEventListener('click', () => {
    dismissMenu(projectMenu);
    setProjectOverride('text', []);
    loadDefault();
  });
  $('text-process-project-reset').addEventListener('click', () => {
    dismissMenu(projectMenu);
    setProjectOverride('text', undefined);
    loadDefault();
  });
  MaweState.observeProjectLoad(() => closeTextProcessModal({ restoreFocus: false }));
  MaweState.onProjectDirtyChange(() => {
    if (modal.classList.contains('show')) schedulePreview();
  });
  $('ass-mode-toggle')?.addEventListener('change', () => {
    if (modal.classList.contains('show')) renderSteps();
  });
  document.addEventListener('mawe:languagechange', () => {
    if (modal.classList.contains('show')) renderSteps();
  });

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
      ...wrapCharsAroundText(MaweBoot.DATA.segments[index]?.text, left, right,
        MaweSettings.EDITOR_SETTINGS.assSpecialSymbolRule),
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
    setTimeout(() => {
      if (wrapCharsModal?.classList.contains('show') && !wrapCharsModal.contains(document.activeElement)) {
        wrapCharsLeftInput?.focus();
      }
    }, 50);
  }


  function closeWrapCharsModal() {
    wrapCharsModal?.classList.remove('show');
  }

  global.MaweTextProcess = Object.freeze({
    wrapCharsModal, wrapCharsLeftInput, wrapCharsRightInput,
    get wrapCharsScope() { return wrapCharsScope; },
    openTextProcessModal, applyWrapChars, openWrapCharsModal, closeWrapCharsModal,
  });
})(window);
}

export function wrapCharsModal(...args) { return window.MaweTextProcess.wrapCharsModal(...args); }
export function wrapCharsLeftInput(...args) { return window.MaweTextProcess.wrapCharsLeftInput(...args); }
export function wrapCharsRightInput(...args) { return window.MaweTextProcess.wrapCharsRightInput(...args); }
export function openTextProcessModal(...args) { return window.MaweTextProcess.openTextProcessModal(...args); }
export function applyWrapChars(...args) { return window.MaweTextProcess.applyWrapChars(...args); }
export function openWrapCharsModal(...args) { return window.MaweTextProcess.openWrapCharsModal(...args); }
export function closeWrapCharsModal(...args) { return window.MaweTextProcess.closeWrapCharsModal(...args); }

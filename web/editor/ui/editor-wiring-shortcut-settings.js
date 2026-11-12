// Record physical keys before any command handler sees them.
export function initMaweShortcutSettingsWiring() {
(function wireShortcutSettings() {
  'use strict';
  const list = document.getElementById('shortcuts-list');
  const status = document.getElementById('shortcuts-status');
  if (!list || !status) return;
  let recording = null;
  let searching = false;
  let keyFilter = null;
  const filter = document.getElementById('shortcuts-filter');
  const keySearch = document.getElementById('shortcuts-key-search');
  const translate = text => window.MAWE_I18N.translateText(text);
  const savedWarnings = MaweShortcuts.takeSavedBindingWarnings();
  if (savedWarnings.length) {
    const template = translate('已忽略无效的已保存快捷键设置：{label}（{chord}）：{reason}；其余有效自定义快捷键已保留。');
    const notice = savedWarnings.map(warning => template
      .replaceAll('{label}', translate(warning.label))
      .replaceAll('{chord}', warning.chord)
      .replaceAll('{reason}', translate(warning.reason))).join('\n');
    MaweHint.flashHint(notice, 'warning', { durationMs: 8000 });
  }
  const groups = [
    ['playback', '播放控制'], ['navigation', '导航与选择'], ['timing', '时间微调'],
    ['editing', '字幕编辑'], ['bilingual', '主副字幕'], ['appearance', '颜色与表情包'], ['project', '工程保存'],
  ];
  const openGroups = new Set(groups.map(([id]) => id));
  let renderedFiltering = false;
  function groupFor(entry) {
    if (['play', 'reverse', 'stop', 'forward'].includes(entry.id)) return 'playback';
    if (/^(nav-|extend-|track-)/.test(entry.id) || ['home', 'end', 'select-all', 'deselect', 'preview', 'cue-start', 'cue-end'].includes(entry.id)) return 'navigation';
    if (/^(seek-|snap-|start-|end-|independent-|trim-)/.test(entry.id)) return 'timing';
    if (['bind', 'unbind', 'align'].includes(entry.id)) return 'bilingual';
    if (entry.id === 'sticker' || entry.id.startsWith('color-')) return 'appearance';
    if (['save', 'save-as'].includes(entry.id)) return 'project';
    return 'editing';
  }

  function message(text, error = false) {
    status.textContent = translate(text);
    status.classList.toggle('shortcut-settings-error', error);
    if (error) MaweHint.flashHint(status.textContent, 'warning', { durationMs: 4000 });
  }
  function cancel() {
    recording = null;
    searching = false;
    keySearch.setAttribute('aria-pressed', 'false');
    keySearch.textContent = translate('按键检索');
    render();
  }
  function change(id, value) {
    try {
      MaweShortcuts.setBinding(id, value);
      MaweSplitMode.refreshSplitKeyHelp();
      recording = null;
      render();
      message('快捷键已保存');
    } catch (error) {
      const messageText = error.message || '';
      const reservedPrefix = '快捷键派生组合与系统或浏览器保留功能冲突：';
      const genericReservedPrefix = '快捷键组合与系统或浏览器保留功能冲突：';
      const duplicatePrefix = '拆分快捷键派生组合发生冲突，无法区分三种拆分操作：';
      const altDuplicatePrefix = '键盘快捷键的 Alt 派生组合冲突，无法保留原修饰键语义：';
      const reservedDetail = messageText.startsWith(reservedPrefix) ? messageText.slice(reservedPrefix.length).split('；') : null;
      const genericReservedDetail = messageText.startsWith(genericReservedPrefix) ? messageText.slice(genericReservedPrefix.length).split('；') : null;
      message(messageText.startsWith('快捷键冲突：')
        ? translate('快捷键冲突：') + translate(messageText.slice(6))
        : reservedDetail
          ? translate(reservedPrefix) + reservedDetail[0] + ' — ' + translate(reservedDetail.slice(1).join('；'))
          : genericReservedDetail
            ? translate(genericReservedPrefix) + genericReservedDetail[0] + ' — ' + translate(genericReservedDetail.slice(1).join('；'))
          : messageText.startsWith(duplicatePrefix)
            ? translate(duplicatePrefix) + messageText.slice(duplicatePrefix.length)
          : messageText.startsWith(altDuplicatePrefix)
            ? translate(altDuplicatePrefix) + messageText.slice(altDuplicatePrefix.length)
          : translate(messageText === '该按键不可用或由浏览器 / 系统保留'
            ? messageText : '无法保存快捷键，请检查浏览器存储权限'), true);
    }
  }
  function filterActive() { return keyFilter !== null || filter.value.trim() !== ''; }
  function matches(entry) {
    const values = MaweShortcuts.effectiveBindings(entry).map(binding => binding.chord);
    if (keyFilter !== null) return values.includes(keyFilter);
    const query = filter.value.trim().toLocaleLowerCase();
    return !query || [entry.label, translate(entry.label), ...values.map(MaweShortcuts.displayChord)]
      .some(value => value.toLocaleLowerCase().includes(query));
  }
  function render() {
    const focused = document.activeElement;
    const focusId = focused?.dataset.shortcutId;
    const focusKind = focused?.dataset.shortcutControl;
    // Native details toggle events are queued; snapshot the current DOM before
    // filtering so a just-clicked group is retained even before toggle fires.
    if (!renderedFiltering) {
      for (const section of list.querySelectorAll('.shortcut-settings-group')) {
        if (section.open) openGroups.add(section.dataset.shortcutGroup);
        else openGroups.delete(section.dataset.shortcutGroup);
      }
    }
    renderedFiltering = filterActive();
    list.replaceChildren();
    for (const [groupId, groupLabel] of groups) {
      const entries = MaweShortcuts.commands.filter(entry => groupFor(entry) === groupId && matches(entry));
      if (!entries.length) continue;
      const section = document.createElement('details');
      section.className = 'shortcut-settings-group';
      section.dataset.shortcutGroup = groupId;
      section.open = filterActive() || openGroups.has(groupId);
      const summary = document.createElement('summary');
      summary.textContent = translate(groupLabel);
      const count = document.createElement('span');
      count.className = 'shortcut-settings-count';
      count.textContent = String(entries.length);
      summary.append(count);
      const body = document.createElement('div');
      body.className = 'shortcut-settings-group-body';
      section.append(summary, body);
      list.append(section);
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'shortcut-settings-row';
        const current = MaweShortcuts.bindings(entry);
        const customized = current.length !== entry.defaults.length
          || current.some(value => !entry.defaults.includes(value));
        row.classList.toggle('is-customized', customized);
        const label = document.createElement('span');
        label.className = 'shortcut-settings-label';
        label.textContent = translate(entry.label);
        if (customized) {
          const badge = document.createElement('span');
          badge.className = 'shortcut-settings-customized';
          badge.textContent = translate('已自定义');
          label.append(badge);
        }
        const controls = document.createElement('div');
        controls.className = 'shortcut-settings-controls';
        for (const [kind, title, action] of [
          ['key', MaweShortcuts.bindings(entry).map(MaweShortcuts.displayChord).join(' / ') || translate('未分配'), () => {
            recording = entry.id;
            render();
            list.querySelector(`[data-shortcut-id="${entry.id}"][data-shortcut-control="key"]`).focus();
            message('请按下新快捷键，Esc 取消');
          }],
          ['clear', translate('清除'), () => change(entry.id, '')],
          ...(customized ? [['reset', translate('恢复默认'), () => change(entry.id, null)]] : []),
        ]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.shortcutId = entry.id;
          button.dataset.shortcutControl = kind;
          button.textContent = recording === entry.id && kind === 'key' ? translate('请按键…') : title;
          button.setAttribute('aria-label', translate(entry.label) + ' — ' + button.textContent);
          if (kind === 'key') {
            button.className = 'shortcut-settings-key';
            button.setAttribute('aria-pressed', String(recording === entry.id));
            button.title = translate('默认：') + entry.defaults.map(MaweShortcuts.displayChord).join(' / ');
          }
          button.addEventListener('click', action);
          controls.append(button);
        }
        row.append(label, controls);
        body.append(row);
      }
    }
    if (!list.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'editor-settings-hint';
      empty.textContent = translate('没有匹配的快捷键');
      list.append(empty);
    }
    if (focusId) list.querySelector(`[data-shortcut-id="${focusId}"][data-shortcut-control="${focusKind}"]`)?.focus();
  }
  document.addEventListener('keydown', event => {
    if (searching) {
      if (event.target !== keySearch) { cancel(); return; }
      if (event.key === 'Tab') { cancel(); message('已取消录入'); return; }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { cancel(); message('已取消录入'); return; }
      if (event.isComposing || event.repeat) return;
      const value = MaweShortcuts.chord(event);
      if (!value) return;
      keyFilter = value;
      filter.value = MaweShortcuts.displayChord(value);
      cancel();
      message('已按当前绑定过滤');
      return;
    }
    if (!recording) return;
    const button = event.target.closest?.('[data-shortcut-control="key"]');
    if (!button || button.dataset.shortcutId !== recording) { cancel(); return; }
    if (event.key === 'Tab') { cancel(); message('已取消录入'); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { cancel(); message('已取消录入'); return; }
    if (event.isComposing || event.repeat) return;
    const value = MaweShortcuts.chord(event);
    if (!value) return;
    change(recording, value);
  }, true);
  document.addEventListener('pointerdown', event => {
    if ((recording && event.target.dataset?.shortcutId !== recording)
        || (searching && event.target !== keySearch)) cancel();
  }, true);
  filter.addEventListener('input', () => { keyFilter = null; cancel(); message(''); });
  keySearch.addEventListener('click', () => {
    if (searching) { cancel(); message('已取消录入'); return; }
    cancel();
    searching = true;
    keySearch.setAttribute('aria-pressed', 'true');
    keySearch.textContent = translate('请按键…');
    keySearch.focus();
    message('按下要检索的快捷键，Esc 取消');
  });
  document.getElementById('shortcuts-filter-clear').addEventListener('click', () => {
    keyFilter = null;
    filter.value = '';
    cancel();
    message('');
    filter.focus();
  });
  document.getElementById('shortcuts-reset').addEventListener('click', () => {
    try {
      MaweShortcuts.resetBindings();
      MaweSplitMode.refreshSplitKeyHelp();
      cancel();
      message('已恢复默认快捷键');
    } catch (_) { message('无法保存快捷键，请检查浏览器存储权限', true); }
  });
  document.getElementById('help-custom-shortcuts').addEventListener('click', () => {
    MaweSettingsPanels.editorSettingsFloatingPanel.open();
    MaweSettingsPanels.setEditorSettingsActiveTab(document.getElementById('editor-settings-tab-shortcuts'));
  });
  document.addEventListener('mawe:languagechange', () => { cancel(); message(''); });
  render();
})();
}

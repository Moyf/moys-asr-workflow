import { SPEAKER_SHORTCUT_COLORS } from '../../shared/utils/speaker-experience.js';

export function initMaweSpeakerManager() {
  const ui = (zh, en) => window.MAWE_I18N?.language === 'en' ? en : zh;
  const colorsZh = ['黄', '绿', '红', '紫', '蓝', '橙', '青', '紫红', '灰'];
  let controls, panel, list, empty, toggle, extended, newName, newColor, slotList;
  const rows = new Map();
  const slots = new Map();

  function element(tag, className = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  function text(tag, zh, en, className = '') {
    const node = element(tag, className);
    node.dataset.speakerI18nZh = zh;
    node.dataset.speakerI18nEn = en;
    node.textContent = ui(zh, en);
    return node;
  }
  function button(zh, en, action) {
    const node = text('button', zh, en);
    node.type = 'button';
    node.addEventListener('click', () => perform(action));
    return node;
  }
  function field(zh, en, input) {
    const label = element('label');
    label.append(text('span', zh, en), input);
    return label;
  }
  function perform(action) {
    try { return action(); }
    catch (error) {
      MaweHint.flashHint(error?.message || String(error), 'warning');
      sync();
      return false;
    }
  }
  function option(value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }
  function personLabel(speaker, index) {
    const position = MaweBoot.DATA.speakers.findIndex(entry => entry.id === speaker.id);
    return `${(position >= 0 ? position : index) + 1} · ${speaker.name || ui('未命名', 'Unnamed')}`;
  }
  function fillPeople(select, people, placeholder, selected) {
    const signature = JSON.stringify([people.map(s => [s.id, s.name]), placeholder, window.MAWE_I18N?.language]);
    if (select.dataset.options !== signature) {
      const previous = select.value;
      select.replaceChildren(option('', placeholder), ...people.map((speaker, index) => option(speaker.id, personLabel(speaker, index))));
      select.dataset.options = signature;
      select.value = previous;
    }
    if (selected !== undefined) select.value = selected;
  }
  function makeRow(speaker) {
    const row = element('div', 'speaker-manager-row');
    row.dataset.speakerId = speaker.id;
    const name = element('input'); name.type = 'text'; name.maxLength = 64; name.autocomplete = 'off';
    name.dataset.speakerField = 'name';
    name.addEventListener('change', () => perform(() => MaweSpeakerLabels.updateIdentity(speaker.id, { name: name.value })));
    const color = element('input'); color.type = 'color'; color.dataset.speakerField = 'color';
    color.addEventListener('change', () => perform(() => MaweSpeakerLabels.updateIdentity(speaker.id, { color: color.value })));
    const mergeTarget = element('select'); mergeTarget.dataset.speakerField = 'merge-target';
    const mergeButton = button('合并身份', 'Merge identities', () => {
      if (!mergeTarget.value) return false;
      return MaweSpeakerLabels.mergeIdentities([speaker.id], mergeTarget.value);
    });
    const count = element('small', 'editor-settings-hint');
    const actions = element('div', 'speaker-manager-actions');
    actions.append(field('合并到', 'Merge into', mergeTarget), mergeButton);
    row.append(field('姓名', 'Name', name), field('显示颜色', 'Display color', color), count, actions);
    list.append(row);
    const record = { row, name, color, mergeTarget, mergeButton, count };
    rows.set(speaker.id, record);
    return record;
  }
  function mount() {
    if (panel) return true;
    const original = document.getElementById('subtitle-speaker-mapping-enabled');
    const owner = original?.closest('label');
    if (!owner) return false;
    const separator = document.getElementById('subtitle-speaker-label-separator')?.closest('label');
    const oldList = separator?.closest('.subtitle-speaker-label-list');
    if (separator && oldList) oldList.after(separator);
    original.setAttribute('aria-label', ui('用颜色分配说话人', 'Use colors to assign speakers'));
    for (const child of [...owner.childNodes]) if (child.nodeType === Node.TEXT_NODE) child.remove();
    owner.append(text('span', '用颜色分配说话人', 'Use colors to assign speakers'));
    owner.title = ui('开启后，色块和数字键分配说话人；关闭后用于普通颜色标记。',
      'Color buttons and number keys assign speakers when enabled, or ordinary color marks when disabled.');
    controls = element('div', 'speaker-project-controls'); controls.id = 'speaker-project-controls';
    extended = element('input'); extended.type = 'checkbox'; extended.id = 'speaker-palette-extended';
    extended.addEventListener('change', () => perform(() => MaweSpeakerLabels.setPaletteSize(extended.checked ? 9 : 5)));
    toggle = button('管理说话人', 'Manage speakers', () => panel.hidden ? open() : close());
    toggle.id = 'speaker-manager-toggle'; toggle.setAttribute('aria-controls', 'speaker-manager');
    controls.append(field('扩展为 9 色', 'Expand to 9 colors', extended), toggle);
    owner.after(controls);
    panel = element('section', 'speaker-manager'); panel.id = 'speaker-manager'; panel.hidden = true;
    panel.setAttribute('aria-labelledby', 'speaker-manager-title');
    const heading = text('strong', '说话人管理', 'Speaker management'); heading.id = 'speaker-manager-title';
    const add = element('div', 'speaker-manager-add');
    newName = element('input'); newName.type = 'text'; newName.maxLength = 64; newName.id = 'speaker-new-name';
    newColor = element('input'); newColor.type = 'color'; newColor.id = 'speaker-new-color'; newColor.value = '#f9ca1f';
    const create = button('新增说话人', 'Add speaker', () => {
      const created = MaweSpeakerLabels.createIdentity({ ...(newName.value ? { name: newName.value } : {}), color: newColor.value });
      newName.value = '';
      rows.get(created.id)?.name.focus();
      return created;
    });
    create.id = 'speaker-add';
    add.append(field('姓名', 'Name', newName), field('显示颜色', 'Display color', newColor), create);
    empty = text('small', '尚无说话人。可新增，或选择字幕后按数字键创建。',
      'No speakers yet. Add one here, or select subtitles and press a number key.', 'editor-settings-hint');
    list = element('div', 'speaker-manager-list'); list.id = 'speaker-manager-list';
    slotList = element('div', 'speaker-manager-slots'); slotList.id = 'speaker-manager-slots';
    for (let slot = 1; slot <= 9; slot++) {
      const select = element('select'); select.dataset.speakerShortcut = String(slot);
      select.addEventListener('change', () => perform(() => MaweSpeakerLabels.bindShortcut(slot, select.value || null)));
      const label = element('label'); const title = element('span'); label.append(title, select); slotList.append(label);
      slots.set(slot, { label, title, select });
    }
    panel.append(heading, add, empty, list, text('strong', '快捷槽位', 'Number-key shortcuts'), slotList,
      text('small', '同名或同色仍是不同的人。合并身份会统一各轨归属与快捷槽位，可撤销。',
        'Matching names or colors do not merge people. Merging identities updates every track and shortcut and can be undone.', 'editor-settings-hint'));
    controls.after(panel);
    return true;
  }
  function sync() {
    if (!mount()) return;
    const project = MaweBoot.DATA;
    const people = project.speakers || [];
    extended.checked = project.palette_size === 9;
    extended.setAttribute('aria-label', ui('扩展为 9 色', 'Expand to 9 colors'));
    const mode = document.getElementById('subtitle-speaker-mapping-enabled');
    mode.checked = project.annotation_mode === 'speaker';
    mode.setAttribute('aria-label', ui('用颜色分配说话人', 'Use colors to assign speakers'));
    mode.closest('label').title = ui('开启后，色块和数字键分配说话人；关闭后用于普通颜色标记。',
      'Color buttons and number keys assign speakers when enabled, or ordinary color marks when disabled.');
    newName.placeholder = ui('留空自动命名', 'Leave blank for an automatic name');
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    const known = new Set(people.map(s => s.id));
    for (const [id, record] of rows) if (!known.has(id)) { record.row.remove(); rows.delete(id); }
    empty.hidden = people.length > 0;
    people.forEach((speaker, index) => {
      const record = rows.get(speaker.id) || makeRow(speaker);
      if (list.children[index] !== record.row) list.insertBefore(record.row, list.children[index] || null);
      if (document.activeElement !== record.name) record.name.value = speaker.name;
      if (document.activeElement !== record.color) record.color.value = speaker.color;
      record.name.setAttribute('aria-label', ui(`说话人 ${index + 1} 姓名`, `Speaker ${index + 1} name`));
      record.color.setAttribute('aria-label', ui(`说话人 ${index + 1} 显示颜色`, `Speaker ${index + 1} display color`));
      const count = project.tracks.reduce((sum, track) => sum + track.segments.filter(cue => cue.speaker === speaker.id).length, 0);
      record.count.textContent = ui(`归属字幕：${count} 条`, `Assigned subtitles: ${count}`);
      fillPeople(record.mergeTarget, people.filter(other => other.id !== speaker.id), ui('选择目标说话人', 'Choose a target speaker'));
      record.mergeTarget.setAttribute('aria-label', ui(`将说话人 ${index + 1} 合并到`, `Merge speaker ${index + 1} into`));
      record.mergeButton.disabled = people.length < 2;
      record.mergeButton.title = ui(`将这 ${count} 条字幕和快捷槽位改归目标说话人`, `Reassign these ${count} subtitles and shortcuts to the target speaker`);
    });
    for (const [slot, record] of slots) {
      const saved = project.speaker_shortcuts?.[String(slot)] || '';
      const folded = slot > (project.palette_size === 9 ? 9 : 5);
      record.label.hidden = folded && !saved;
      record.title.textContent = `${slot} · ${ui(colorsZh[slot - 1], SPEAKER_SHORTCUT_COLORS[slot - 1])}${folded ? ui('（已收起）', ' (collapsed)') : ''}`;
      fillPeople(record.select, people, ui('空槽：首次使用时创建', 'Empty: create on first use'), saved);
      record.select.setAttribute('aria-label', ui(`快捷键 ${slot} 说话人`, `Speaker for shortcut ${slot}`));
    }
    const settings = document.getElementById('subtitle-speaker-settings');
    settings.querySelectorAll('[data-speaker-i18n-zh]').forEach(node => {
      node.textContent = ui(node.dataset.speakerI18nZh, node.dataset.speakerI18nEn);
    });
  }
  function open() {
    sync();
    if (!panel) return false;
    window.MaweSettingsPanels?.openEditorSettingsAtTab?.('editor-settings-tab-project-color', { focus: false });
    panel.hidden = false; toggle.setAttribute('aria-expanded', 'true'); newName.focus();
    return true;
  }
  function close() {
    if (!panel) return;
    panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus();
  }
  window.MaweSpeakerManager = Object.freeze({ sync, open, close });
  document.addEventListener('mawe:languagechange', sync);
  sync();
}

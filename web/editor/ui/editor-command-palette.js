import { registerBuiltinCommands } from './editor-command-defs.js';

const RECENTS_KEY = 'mawe-command-palette-recents';
const RECENTS_LIMIT = 8;
const SUGGESTIONS = ['file.open', 'file.save', 'settings.global', 'help.shortcuts'];

export function createCommandRegistry({ storage, translate = text => text, reportError = console.error } = {}) {
  const normalize = value => value.normalize('NFKC').toLowerCase().trim();

  function score(text, term) {
    if (text === term) return 400;
    if (text.startsWith(term)) return 300;
    if (text.includes(term)) return 200;
    let offset = 0;
    let start = -1;
    for (const char of term) {
      const match = text.indexOf(char, offset);
      if (match < 0) return 0;
      if (start < 0) start = match;
      offset = match + char.length;
    }
    return 100 - Math.min(99, offset - start - term.length);
  }

  const commands = new Map();
  const providers = new Set();
  let recents = [];
  try {
    const saved = JSON.parse(storage?.getItem(RECENTS_KEY) ?? '[]');
    if (Array.isArray(saved)) recents = [...new Set(saved.filter(id => typeof id === 'string'))].slice(0, RECENTS_LIMIT);
  } catch { /* Unavailable or corrupt storage must not disable the palette. */ }

  function validate(def) {
    if (!def || typeof def.id !== 'string' || !/^[\w-]+(?:\.[\w-]+)+$/.test(def.id)
        || typeof def.title !== 'string' || !def.title.trim()
        || typeof def.category !== 'string' || !def.category.trim()
        || typeof def.run !== 'function' || (def.when != null && typeof def.when !== 'function')
        || (def.shortcut != null && typeof def.shortcut !== 'string')
        || (def.keywords != null && (!Array.isArray(def.keywords) || def.keywords.some(k => typeof k !== 'string')))) {
      throw new TypeError('Invalid command definition');
    }
    return Object.freeze({ ...def, keywords: Object.freeze([...(def.keywords ?? [])]) });
  }

  function register(def) {
    const command = validate(def);
    if (commands.has(command.id)) throw new Error(`Duplicate command: ${command.id}`);
    commands.set(command.id, command);
    return () => commands.get(command.id) === command && unregister(command.id);
  }

  function unregister(id) { return commands.delete(id); }

  function registerProvider(provider) {
    if (typeof provider !== 'function') throw new TypeError('Expected a command provider');
    providers.add(provider);
    return () => providers.delete(provider);
  }

  function available(command) {
    try { return command.when?.() !== false; }
    catch (error) { reportError(error); return false; }
  }

  function list(query = '') {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    const all = new Map(commands);
    for (const provider of providers) {
      try {
        for (const def of provider() ?? []) {
          const command = validate(def);
          if (!all.has(command.id)) all.set(command.id, command);
        }
      } catch (error) { reportError(error); }
    }
    const results = [];
    for (const command of all.values()) {
      if (!available(command)) continue;
      const { title, category, shortcut, keywords } = command;
      const titles = [title, translate(title)].map(normalize);
      const aliases = [category, translate(category), command.id, ...keywords,
        ...(shortcut ? [shortcut, shortcut.replace('Ctrl', 'Cmd')] : [])].map(normalize);
      let rank = 0;
      for (const term of terms) {
        const match = Math.max(...titles.map(text => score(text, term) * 2), ...aliases.map(text => score(text, term)));
        if (!match) { rank = 0; break; }
        rank += match;
      }
      const recent = recents.indexOf(command.id);
      const suggestion = SUGGESTIONS.indexOf(command.id);
      if (!terms.length || rank) results.push({ command, rank, recent, suggestion });
    }
    const priority = index => index < 0 ? Infinity : index;
    return results.sort((a, b) => terms.length ? b.rank - a.rank :
      (priority(a.recent) - priority(b.recent) || priority(a.suggestion) - priority(b.suggestion)));
  }

  function markUsed(id) {
    recents = [id, ...recents.filter(recent => recent !== id)].slice(0, RECENTS_LIMIT);
    try { storage?.setItem(RECENTS_KEY, JSON.stringify(recents)); }
    catch { /* Keep the in-memory history. */ }
  }

  return Object.freeze({ register, unregister, registerProvider, list, available, markUsed });
}

export function initMaweCommandPalette(fileActions) {
  const button = document.getElementById('command-palette-open');
  const dialog = document.getElementById('command-palette');
  if (!button || !dialog?.showModal) return;
  const input = document.getElementById('command-palette-query');
  const list = document.getElementById('command-palette-results');
  const empty = document.getElementById('command-palette-empty');
  const translate = (text, language) => window.MAWE_I18N?.translateText(text, language) ?? text;
  let storage;
  try { storage = window.localStorage; } catch { /* Storage is optional. */ }
  const registry = createCommandRegistry({ storage, translate: text => translate(text, 'en') });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const modifierLabel = shortcut => mac ? shortcut.replace('Ctrl', 'Cmd') : shortcut;
  let previousFocus, rows = [], active = -1;
  const hasBlockingDialog = () => !!document.querySelector('dialog[open], .modal-mask.show');

  function select(index, scroll = true) {
    if (!rows.length) return;
    list.children[active]?.setAttribute('aria-selected', 'false');
    active = Math.max(0, Math.min(rows.length - 1, index));
    const option = list.children[active];
    option.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', option.id);
    if (scroll) option.scrollIntoView({ block: 'nearest' });
  }

  function render(keepSelection = false) {
    const previous = keepSelection ? rows[active]?.command.id : null;
    const query = input.value.trim();
    rows = registry.list(query);
    active = -1;
    input.removeAttribute('aria-activedescendant');
    const fragment = document.createDocumentFragment();
    rows.forEach(({ command, recent }, index) => {
      const option = document.createElement('li');
      option.id = `command-palette-option-${index}`;
      option.dataset.index = index;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      const label = document.createElement('span');
      const category = document.createElement('span');
      category.className = 'command-palette-category';
      category.textContent = `${translate(command.category)}: `;
      label.append(category, translate(command.title));
      option.append(label);
      if (!query && recent >= 0) {
        const badge = document.createElement('small');
        badge.textContent = translate('最近使用');
        option.append(badge);
      }
      if (command.shortcut) {
        const badge = document.createElement('kbd');
        badge.textContent = modifierLabel(command.shortcut);
        option.append(badge);
      }
      fragment.append(option);
    });
    list.replaceChildren(fragment);
    empty.hidden = rows.length !== 0;
    input.setAttribute('aria-expanded', String(rows.length !== 0));
    list.scrollTop = 0;
    const index = rows.findIndex(row => row.command.id === previous);
    select(index, index > 0);
  }

  function open(focusTarget = document.activeElement) {
    if (dialog.open) return;
    // Don't layer commands that can replace an in-flight edit over a blocking editor dialog.
    if (hasBlockingDialog()) return;
    previousFocus = focusTarget;
    input.value = '';
    render();
    dialog.showModal();
    input.focus({ preventScroll: true });
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }

  async function execute(index) {
    const id = rows[index]?.command.id;
    if (!dialog.open || !id) return;
    // A provider or a registration may have changed since the last render.
    const command = registry.list().find(row => row.command.id === id)?.command;
    if (!command) { render(); return; }
    close();
    try {
      // Invoke before awaiting to preserve native picker/fullscreen user activation.
      if (await command.run() !== false) registry.markUsed(command.id);
    } catch (error) {
      window.MaweHint.flashHint(translate('无法执行命令'), 'warning', { error });
    }
  }

  button.querySelector('kbd').textContent = modifierLabel('Ctrl+K');
  button.addEventListener('click', () => open(button));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  input.addEventListener('input', () => render());
  list.addEventListener('mousedown', event => { if (event.target.closest('[role="option"]')) event.preventDefault(); });
  list.addEventListener('click', event => {
    const option = event.target.closest('[data-index]');
    if (option) void execute(Number(option.dataset.index));
  });
  document.addEventListener('mawe:languagechange', () => { if (dialog.open) render(true); });

  // Window capture runs before document-level bindings, including global save and Escape.
  window.addEventListener('keydown', event => {
    const composing = event.isComposing || event.keyCode === 229;
    const toggle = !composing && (event.ctrlKey || event.metaKey) && !event.altKey
      && !event.shiftKey && event.key.toLowerCase() === 'k';
    if (!dialog.open && !toggle) return;
    if (toggle) {
      if (!dialog.open && hasBlockingDialog()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) { if (dialog.open) close(); else open(); }
      return;
    }
    event.stopImmediatePropagation();
    if (composing) return;
    const key = event.key;
    if (key === 'Escape') { event.preventDefault(); close(); return; }
    // Don't fall back to the browser's Save Page command when editor save is isolated.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key.toLowerCase() === 's') event.preventDefault();
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) void execute(active);
    } else if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      select(key === 'Home' ? 0 : key === 'End' ? rows.length - 1 : active + (key === 'ArrowDown' ? 1 : -1));
    }
  }, true);
  window.addEventListener('keyup', event => { if (dialog.open) event.stopImmediatePropagation(); }, true);

  registerBuiltinCommands(registry, window, document, fileActions);
  window.MaweCommandPalette = Object.freeze({ ...registry, open, close });
}

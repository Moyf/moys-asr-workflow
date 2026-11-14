import { getAssStyleLibrary, getAssStyleTransferState, persistAssStyleLibrary, importAssStyleLibrary, reloadAssStyleLibrary, readAssStyleLibraryBackup, waitForAssStyleLibraryLoad } from './editor-wiring-ass-storage.js';

// File transfer is intentionally separate from project snapshots and subtitle export.
export function createAssStyleTransfer(utils) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const idPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
  const builtins = new Set(['default', 'ass', 'ass-extension']);
  const schema = 'moy.asr.ass_styles.transfer.v1';
  const comparable = item => {
    const { id, builtin, name, ...fields } = item;
    return JSON.stringify(fields);
  };
  function validate(input) {
    const wrapped = input?.schema === schema;
    if (wrapped && (input.version !== 1 || input.kind !== 'library')) throw new Error('不支持此样式库文件版本');
    const raw = wrapped ? input.library : input;
    if (!raw || raw.schema !== 'moy.asr.ass_styles.v1' || ![1, 2].includes(raw.version)) {
      throw new Error('不是受支持的 MAW 样式库文件或版本');
    }
    for (const key of Object.keys(raw)) if (!['schema', 'version', 'styles', 'assProfiles', 'assignments'].includes(key)) {
      throw new Error(`不支持样式库字段 ${key}`);
    }
    if (!Array.isArray(raw.styles) || !Array.isArray(raw.assProfiles) || !raw.assignments
      || raw.styles.length > 65 || raw.assProfiles.length > 64) throw new Error('样式库格式无效，或样式超过 65 个、方案超过 64 个');
    const sets = [];
    for (const entries of [raw.styles, raw.assProfiles]) {
      const ids = new Set();
      for (const item of entries) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !idPattern.test(item.id || '') || ids.has(item.id)) {
          throw new Error('样式或方案 ID 无效或重复');
        }
        ids.add(item.id);
      }
      sets.push(ids);
    }
    for (const profile of raw.assProfiles) if (!sets[0].has(profile.styleId)) throw new Error(`方案「${profile.name || profile.id}」引用的样式不存在`);
    for (const [key, ids] of [['srtBurnStyleId', sets[0]], ['assExportProfileId', sets[1]], ['assExtensionStyleId', sets[0]]]) {
      if (raw.version === 1 && key === 'assExtensionStyleId' && !(key in raw.assignments)) continue;
      if (!ids.has(raw.assignments[key])) throw new Error(`默认设置 ${key} 引用的条目不存在`);
    }
    const normalized = utils.normalizeAssStyleLibrary(raw);
    const changes = [];
    const compare = (value, result, path) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${path} 格式无效`);
        if (raw.version === 2) for (const key of Object.keys(result)) {
          if (!(key in value)) {
            // The pop group was introduced without a version bump; existing v2
            // libraries legitimately lack it and acquire its disabled defaults.
            if (key === 'pop' && /^assProfiles\.[^.]+\.animations$/u.test(path)) {
              changes.push(`${path}.pop 使用默认值`);
              continue;
            }
            // These MASS fields were added after v2 had already shipped.
            if (['commentColor', 'commentStyle', 'commentScale', 'outlineOpacity', 'backOpacity'].includes(key) && /^styles\.[^.]+$/u.test(path)) {
              changes.push(`${path}.${key} 使用默认值`);
              continue;
            }
            throw new Error(`${path}.${key} 缺失`);
          }
        }
        for (const key of Object.keys(value)) {
          if (!(key in result)) throw new Error(`不支持字段 ${path}.${key}`);
          compare(value[key], result[key], `${path}.${key}`);
        }
      } else if (JSON.stringify(value) !== JSON.stringify(result)) {
        const knownMigration = (path === 'styles.default.name' && value === 'SRT 默认')
          || (path === 'styles.ass.name' && value === 'ASS')
          || (path === 'assProfiles.ass.name' && value === 'ASS')
          || (path === 'styles.ass-extension.primaryColor' && value === '#ffd34d');
        if (raw.version === 1 || knownMigration) changes.push(path);
        else throw new Error(`${path} 的值无效或无法原样导入`);
      }
    };
    if (raw.version === 2 && (normalized.styles.length !== raw.styles.length || normalized.assProfiles.length !== raw.assProfiles.length)) {
      throw new Error('样式库缺少内置条目');
    }
    for (const [key, items] of [['styles', raw.styles], ['assProfiles', raw.assProfiles]]) {
      for (const item of items) compare(item, normalized[key].find(entry => entry.id === item.id), `${key}.${item.id}`);
    }
    compare(raw.assignments, normalized.assignments, 'assignments');
    return { library: normalized, warnings: [
      ...(raw.version === 1 ? ['旧版本样式库会按当前规则补充和迁移字段。'] : []),
      ...changes.map(path => `已迁移：${path}`),
    ] };
  }
  function nextId(source, entries, kind) {
    const existing = new Set(entries.map(item => item.id));
    let hash = 2166136261;
    for (const char of JSON.stringify(source)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    const base = `import-${kind}-${(hash >>> 0).toString(36)}`;
    let id = base, index = 2;
    while (existing.has(id)) id = `${base}-${index++}`;
    return id;
  }
  function uniqueName(name, entries) {
    const names = new Set(entries.map(item => item.name));
    if (!names.has(name)) return name;
    let index = 1, candidate;
    do { candidate = `${name.slice(0, 68)} (导入${index === 1 ? '' : ` ${index}`})`; index += 1; } while (names.has(candidate));
    return candidate;
  }
  function merge(current, incoming) {
    const result = clone(current), styleMap = new Map(), added = [], reused = [];
    for (const source of incoming.styles) {
      const match = result.styles.find(item => comparable(item) === comparable(source) &&
        (item.name === source.name || item.name.startsWith(`${source.name.slice(0, 68)} (导入`)));
      if (match) { styleMap.set(source.id, match.id); reused.push(`样式：${source.name}`); continue; }
      const idTaken = result.styles.some(item => item.id === source.id);
      const id = builtins.has(source.id) || idTaken ? nextId(source, result.styles, 'style') : source.id;
      const name = uniqueName(source.name, result.styles);
      result.styles.push({ ...clone(source), id, name, builtin: false });
      styleMap.set(source.id, id); added.push(`样式：${name}`);
    }
    for (const source of incoming.assProfiles) {
      const mapped = { ...clone(source), styleId: styleMap.get(source.styleId) };
      const match = result.assProfiles.find(item => comparable(item) === comparable(mapped) &&
        (item.name === source.name || item.name.startsWith(`${source.name.slice(0, 68)} (导入`)));
      if (match) { reused.push(`方案：${source.name}`); continue; }
      const id = source.id === 'ass' || result.assProfiles.some(item => item.id === source.id)
        ? nextId(mapped, result.assProfiles, 'profile') : source.id;
      const name = uniqueName(source.name, result.assProfiles);
      result.assProfiles.push({ ...mapped, id, name, builtin: false });
      added.push(`方案：${name}`);
    }
    if (result.styles.length > 65 || result.assProfiles.length > 64) throw new Error('合并后样式超过 65 个或方案超过 64 个，请先清理当前库');
    if (new Blob([JSON.stringify(result)]).size > 500 * 1024) throw new Error('合并后的样式库过大');
    return { library: result, added, reused };
  }
  return { schema, validate, merge };
}

export function initAssStyleTransfer() {
  const MaweAssTransfer = createAssStyleTransfer(window.AsrEditorUtils);
  const dialog = document.getElementById('ass-style-import-dialog');
  const input = document.getElementById('ass-style-import-file');
  const preview = document.getElementById('ass-style-import-preview');
  const summaryText = document.getElementById('ass-style-import-summary');
  const confirmButton = document.getElementById('ass-style-import-confirm');
  const cancelButton = document.getElementById('ass-style-import-cancel');
  const modeControls = [...dialog.querySelectorAll('input[name="ass-style-import-mode"]')];
  let imported = null, baseRevision = 0, proposed = null;
  let importing = false;
  const english = () => window.MAWE_I18N?.language === 'en';
  const message = text => MaweHint.flashHint(text, 'warning');
  const mode = () => dialog.querySelector('input[name="ass-style-import-mode"]:checked')?.value || 'merge';
  function render() {
    try {
      proposed = mode() === 'merge' ? MaweAssTransfer.merge(getAssStyleLibrary(), imported.library) : { library: imported.library };
      const source = imported.library;
      const englishItem = item => item.replace(/^样式：/u, 'Style: ').replace(/^方案：/u, 'Profile: ');
      const slotNames = library => {
        const a = library.assignments;
        const name = (items, id) => items.find(item => item.id === id)?.name || id;
        return english()
          ? `SRT: ${name(library.styles, a.srtBurnStyleId)}; ASS: ${name(library.assProfiles, a.assExportProfileId)}; Secondary: ${name(library.styles, a.assExtensionStyleId)}`
          : `SRT：${name(library.styles, a.srtBurnStyleId)}；ASS：${name(library.assProfiles, a.assExportProfileId)}；副字幕：${name(library.styles, a.assExtensionStyleId)}`;
      };
      const summary = english() ? (mode() === 'merge'
        ? [`Add ${proposed.added.length}, reuse ${proposed.reused.length}; current defaults stay unchanged.`, ...proposed.added.map(x => `＋ ${englishItem(x)}`), ...proposed.reused.map(x => `＝ ${englishItem(x)}`)]
        : [`Replace all ${getAssStyleLibrary().styles.length} current styles, ${getAssStyleLibrary().assProfiles.length} profiles and defaults.`,
          `Current defaults: ${slotNames(getAssStyleLibrary())}`, `Restored defaults: ${slotNames(source)}`,
          ...getAssStyleLibrary().styles.map(x => `Current style: ${x.name}`), ...getAssStyleLibrary().assProfiles.map(x => `Current profile: ${x.name}`),
          `Restore ${source.styles.length} styles and ${source.assProfiles.length} profiles.`,
          ...source.styles.map(x => `Style: ${x.name}`), ...source.assProfiles.map(x => `Profile: ${x.name}`)]) : (mode() === 'merge'
        ? [`新增 ${proposed.added.length} 项，复用 ${proposed.reused.length} 项；保留当前默认设置。`, ...proposed.added.map(x => `＋ ${x}`), ...proposed.reused.map(x => `＝ ${x}`)]
        : [`将替换当前全部 ${getAssStyleLibrary().styles.length} 个样式、${getAssStyleLibrary().assProfiles.length} 个方案及全部默认设置。`,
          `当前默认：${slotNames(getAssStyleLibrary())}`, `恢复后默认：${slotNames(source)}`,
          ...getAssStyleLibrary().styles.map(x => `当前样式：${x.name}`), ...getAssStyleLibrary().assProfiles.map(x => `当前方案：${x.name}`),
          `恢复 ${source.styles.length} 个样式、${source.assProfiles.length} 个方案。`,
          ...source.styles.map(x => `样式：${x.name}`), ...source.assProfiles.map(x => `方案：${x.name}`)]);
      const fonts = [...new Set(source.styles.map(style => style.fontName))].join('、');
      const unchanged = JSON.stringify(proposed.library) === JSON.stringify(getAssStyleLibrary());
      summaryText.textContent = summary[0];
      preview.textContent = [...summary.slice(1), ...imported.warnings,
        english() ? `Fonts not checked; verify on the destination: ${fonts}` : `字体未检查，请在目标电脑确认：${fonts}`,
        unchanged ? (english() ? 'The library is unchanged; the previous backup is retained.' : '当前内容无需更改，保留之前的恢复副本。')
          : (english() ? 'A backup of the current library will be kept.' : '导入前的库会保存为恢复副本。')].join('\n');
      confirmButton.disabled = unchanged;
    } catch (error) { proposed = null; summaryText.textContent = ''; preview.textContent = error.message; confirmButton.disabled = true; }
  }
  document.getElementById('ass-style-export-library')?.addEventListener('click', async () => {
    await waitForAssStyleLibraryLoad();
    const payload = { schema: MaweAssTransfer.schema, version: 1, kind: 'library', library: window.AsrEditorUtils.normalizeAssStyleLibrary(getAssStyleLibrary()) };
    try { await MaweExportTimeline.downloadFile(JSON.stringify(payload, null, 2), 'MAW-ASS样式库.json', 'application/json',
      { desc: 'MAW ASS 样式库', types: { 'application/json': ['.json'] } }); }
    catch (error) { message(`导出失败：${error.message || error}`); }
  });
  document.getElementById('ass-style-import-library')?.addEventListener('click', () => { input.value = ''; input.click(); });
  async function openImport(value, selectedMode = 'merge') {
    await waitForAssStyleLibraryLoad();
    if (getAssStyleTransferState().dirty) {
      await persistAssStyleLibrary();
      if (getAssStyleTransferState().dirty) throw new Error('当前修改尚未保存，请先解决保存问题');
    }
    imported = MaweAssTransfer.validate(value);
    baseRevision = getAssStyleTransferState().revision;
    dialog.querySelector(`input[value="${selectedMode}"]`).checked = true;
    render(); dialog.showModal();
  }
  input?.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 512 * 1024) throw new Error('文件超过 512 KB');
      await openImport(JSON.parse(await file.text()));
    } catch (error) { message(`无法导入：${error.message || error}`); }
  });
  document.getElementById('ass-style-restore-backup')?.addEventListener('click', async () => {
    document.querySelector('.ass-style-more-actions')?.removeAttribute('open');
    try {
      const backup = await readAssStyleLibraryBackup();
      await openImport(backup, 'restore');
    } catch (error) { message(`无法恢复：${error.message || error}`); }
  });
  modeControls.forEach(el => el.addEventListener('change', render));
  dialog.addEventListener('cancel', event => { if (importing) event.preventDefault(); });
  cancelButton?.addEventListener('click', () => { if (!importing) dialog.close(); });
  confirmButton?.addEventListener('click', async () => {
    if (importing) return;
    if (!proposed || baseRevision !== getAssStyleTransferState().revision || getAssStyleTransferState().dirty) { message('样式库已改变，请重新导入并预览'); dialog.close(); return; }
    importing = true;
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    modeControls.forEach(control => { control.disabled = true; });
    try {
      await importAssStyleLibrary(proposed.library, baseRevision);
      dialog.close();
    } catch (error) { preview.textContent = `导入失败：${error.message || error}\n\n${preview.textContent}`; }
    finally {
      importing = false;
      confirmButton.disabled = false;
      cancelButton.disabled = false;
      modeControls.forEach(control => { control.disabled = false; });
    }
  });
  document.getElementById('ass-style-reload-library')?.addEventListener('click', async () => {
    document.querySelector('.ass-style-more-actions')?.removeAttribute('open');
    if (getAssStyleTransferState().dirty && !confirm('重新加载会放弃当前未保存的修改。可以先导出样式库作为备份。继续吗？')) return;
    await reloadAssStyleLibrary();
  });
}

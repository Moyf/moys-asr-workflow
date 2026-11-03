// Personal text-processing presets; project content is never stored here.
(function initTextPresets(global) {
  'use strict';
  const schema = 'moy.asr.text_processing_presets.v1';
  const key = 'moy.asr.text_processing_presets.v1';
  const byId = (id) => document.getElementById(id);
  const select = byId('text-preset-select');
  const list = byId('text-preset-rules');
  const status = byId('text-preset-status');
  let library = { schema, presets: [] };
  let rules = [];
  let loaded = false;
  let busy = false;
  let loadRevision = 0;
  let worker = null;
  let cancelWorker = null;

  function refreshLibraryControls() {
    select.disabled = busy || !loaded;
    ['text-preset-save', 'text-preset-save-as', 'text-preset-delete', 'text-preset-export', 'text-preset-import']
      .forEach((id) => { byId(id).disabled = busy || !loaded; });
  }

  function textPresetWorker() {
    self.onmessage = ({ data }) => {
      try {
        const compiled = data.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.enabled).map(({ rule, index }) => {
          if (!rule.find) throw new Error(`第 ${index + 1} 条规则的查找内容为空`);
          const pattern = rule.regex ? rule.find : rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          try { return { regex: new RegExp(pattern, `gu${rule.caseSensitive ? '' : 'i'}`), rule }; }
          catch (error) { throw new Error(`第 ${index + 1} 条规则：${error.message}`); }
        });
        self.postMessage({ texts: data.texts.map((text) => compiled.reduce((value, item) =>
          value.replace(item.regex, item.rule.regex ? item.rule.replace : () => item.rule.replace), text)) });
      } catch (error) { self.postMessage({ error: error.message }); }
    };
  }

  // User-supplied regular expressions run off the UI thread. A pathological
  // pattern must not freeze the editor or partially modify the project.
  function runRules(texts, currentRules) {
    if (cancelWorker) cancelWorker();
    if (!currentRules.some((rule) => rule.enabled)) return Promise.resolve(texts);
    return new Promise((resolve, reject) => {
      const source = `(${textPresetWorker.toString()})();`;
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      let timer;
      const finish = (error, value) => {
        clearTimeout(timer); worker?.terminate(); worker = null; cancelWorker = null; URL.revokeObjectURL(url);
        if (error) reject(error); else resolve(value);
      };
      try {
        worker = new Worker(url);
        cancelWorker = () => finish(new Error('预览已更新'));
        timer = setTimeout(() => finish(new Error('规则运行超时，请简化正则表达式')), 2000);
        worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.texts);
        worker.onerror = () => finish(new Error('无法运行替换规则'));
        worker.postMessage({ texts, rules: currentRules });
      } catch (error) { finish(error); }
    });
  }

  function validate(value) {
    if (!value || value.schema !== schema || !Array.isArray(value.presets) || value.presets.length > 100) throw new Error('预设库格式无效');
    const ids = new Set();
    value.presets.forEach((preset) => {
      if (!preset || typeof preset.id !== 'string' || !preset.id || preset.id.length > 160 || ids.has(preset.id)
          || typeof preset.name !== 'string' || !preset.name.trim() || preset.name.length > 160 || !['all', 'selected'].includes(preset.scope)
          || !preset.operations || typeof preset.operations !== 'object' || Array.isArray(preset.operations)
          || !Array.isArray(preset.rules) || preset.rules.length > 100) throw new Error('预设格式无效');
      ids.add(preset.id);
      const ops = preset.operations;
      if (['trim', 'capitalize', 'convertChineseNumbers', 'stripMarkdown'].some((field) => field in ops && typeof ops[field] !== 'boolean')
          || ['left', 'right'].some((field) => field in ops && typeof ops[field] !== 'string')
          || ('wraps' in ops && (!Array.isArray(ops.wraps) || ops.wraps.length > 100 || ops.wraps.some((wrap) => !wrap || typeof wrap !== 'object' || Array.isArray(wrap)
            || ['id', 'left', 'right'].some((field) => typeof wrap[field] !== 'string')
            || (wrap.id !== 'custom' && !window.AsrEditorUtils.WRAP_CHAR_PRESETS.some((entry) => entry.id === wrap.id)))))) throw new Error('预设操作格式无效');
      preset.rules.forEach((rule) => {
        if (!rule || typeof rule.find !== 'string' || typeof rule.replace !== 'string'
          || ['enabled', 'regex', 'caseSensitive'].some((field) => typeof rule[field] !== 'boolean')) throw new Error('替换规则格式无效');
      });
    });
    return JSON.parse(JSON.stringify(value));
  }

  function renderSelect(current = '') {
    select.replaceChildren(new Option('自定义', ''));
    library.presets.forEach((preset) => {
      const option = new Option(preset.name, preset.id);
      option.dataset.markerProjectContent = '';
      select.add(option);
    });
    select.value = current;
  }

  function renderRules() {
    list.replaceChildren();
    rules.forEach((rule, index) => {
      const row = document.createElement('div');
      row.className = 'text-preset-rule';
      const makeInput = (type, value, label, change) => {
        const input = document.createElement('input'); input.type = type;
        input.setAttribute('aria-label', label);
        if (type === 'checkbox') input.checked = value; else { input.value = value; input.placeholder = label; }
        input.addEventListener(type === 'checkbox' ? 'change' : 'input', () => { change(type === 'checkbox' ? input.checked : input.value); MaweTextProcess.renderTextProcessPreview(); });
        return input;
      };
      const makeCheck = (field, label) => {
        const wrapper = document.createElement('label');
        wrapper.append(makeInput('checkbox', rule[field], label, value => { rule[field] = value; }), document.createTextNode(label));
        return wrapper;
      };
      const button = (label, action) => {
        const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
        el.addEventListener('click', () => { action(); renderRules(); MaweTextProcess.renderTextProcessPreview(); }); return el;
      };
      row.append(makeCheck('enabled', '启用'), makeInput('text', rule.find, `规则 ${index + 1} 查找`, value => { rule.find = value; }),
        makeInput('text', rule.replace, `规则 ${index + 1} 替换为`, value => { rule.replace = value; }),
        makeCheck('regex', '正则'), makeCheck('caseSensitive', '区分大小写'),
        button('上移', () => { if (index > 0) [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]]; }),
        button('下移', () => { if (index + 1 < rules.length) [rules[index + 1], rules[index]] = [rules[index], rules[index + 1]]; }),
        button('删除', () => rules.splice(index, 1)));
      list.append(row);
    });
  }

  function snapshot(id, name) {
    return { id, name, scope: MaweTextProcess.textProcessSelectedOnlyCb.checked ? 'selected' : 'all', rules: JSON.parse(JSON.stringify(rules)), operations: {
      trim: MaweTextProcess.textProcessTrim.checked, capitalize: MaweTextProcess.textProcessCapitalize.checked,
      convertChineseNumbers: MaweTextProcess.textProcessConvertNumbers.checked, stripMarkdown: MaweTextProcess.textProcessStripMarkdown.checked,
      wraps: MaweTextProcess.textProcessWrapPresets, left: MaweTextProcess.textProcessPrefixInput.value, right: MaweTextProcess.textProcessSuffixInput.value,
    } };
  }

  function applyPreset(preset) {
    MaweTextProcess.invalidatePreview();
    const ops = preset.operations;
    if (!MaweSettings.EDITOR_SETTINGS.assMode && (ops.wraps || []).some((wrap) =>
      window.AsrEditorUtils.WRAP_CHAR_PRESETS.some((entry) => entry.id === wrap.id && entry.ass))) {
      select.value = '';
      status.textContent = '该预设包含 ASS 特殊文本样式，请先开启 ASS 模式';
      MaweTextProcess.renderTextProcessPreview();
      return;
    }
    status.textContent = '';
    rules = JSON.parse(JSON.stringify(preset.rules));
    MaweTextProcess.textProcessTrim.checked = ops.trim === true;
    MaweTextProcess.textProcessCapitalize.checked = ops.capitalize === true;
    MaweTextProcess.textProcessConvertNumbers.checked = ops.convertChineseNumbers === true;
    MaweTextProcess.textProcessStripMarkdown.checked = ops.stripMarkdown === true;
    MaweTextProcess.textProcessWrapPresets = (ops.wraps || []).map((wrap) => {
      const builtin = window.AsrEditorUtils.WRAP_CHAR_PRESETS.find((entry) => entry.id === wrap.id);
      return { ...wrap, ass: builtin?.ass === true, sentenceLevel: builtin?.sentenceLevel === true };
    });
    MaweTextProcess.textProcessPrefixInput.value = typeof ops.left === 'string' ? ops.left : '';
    MaweTextProcess.textProcessSuffixInput.value = typeof ops.right === 'string' ? ops.right : '';
    MaweTextProcess.textProcessSelectedOnlyCb.checked = preset.scope === 'selected';
    if (preset.scope === 'selected') MaweTextProcess.textProcessSelectedOnlyCb.disabled = false;
    MaweTextProcess.textProcessScope = preset.scope === 'selected' ? [...MaweTextProcess.textProcessSelectionSnapshot] : null;
    MaweTextProcess.refreshTextProcessScopeInfo(); MaweTextProcess.refreshTextProcessInputState();
    renderRules(); MaweTextProcess.renderTextProcessPreview();
  }

  async function persist(next, selected) {
    if (!loaded || busy) return;
    busy = true;
    refreshLibraryControls();
    const expected = JSON.parse(JSON.stringify(library));
    const openedAt = loadRevision;
    try {
      next = validate(next);
      const url = MaweBoot.SERVER_CONFIG?.textProcessingPresetsUrl;
      if (url) {
        const response = await fetch(new URL(url, location.href), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...next, expected, requestToken: MaweBoot.SERVER_CONFIG.requestToken || '' }) });
        if (response.status === 409) throw new Error('预设库已被其他页面修改，请重新打开');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        next = validate(await response.json());
      } else {
        const write = () => {
          const raw = localStorage.getItem(key);
          const current = validate(raw ? JSON.parse(raw) : { schema, presets: [] });
          if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('预设库已被其他页面修改，请重新打开');
          localStorage.setItem(key, JSON.stringify(next));
        };
        if (navigator.locks?.request) await navigator.locks.request(key, write);
        else write();
      }
      const selectedAfterSave = openedAt === loadRevision ? selected : '';
      loadRevision += 1; library = next; loaded = true;
      renderSelect(selectedAfterSave); status.textContent = '预设库已保存';
    } catch (error) { status.textContent = `保存失败：${error.message}`; }
    finally { busy = false; refreshLibraryControls(); }
  }

  async function onOpen() {
    const revision = ++loadRevision;
    rules = []; renderRules(); loaded = false; renderSelect(); refreshLibraryControls(); status.textContent = '正在加载预设库…';
    try {
      const url = MaweBoot.SERVER_CONFIG?.textProcessingPresetsUrl;
      if (url) {
        const response = await fetch(new URL(url, location.href), { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = validate(await response.json());
        if (revision !== loadRevision) return;
        library = result;
      } else library = validate(JSON.parse(localStorage.getItem(key) || JSON.stringify({ schema, presets: [] })));
      if (revision !== loadRevision) return;
      loaded = true; refreshLibraryControls(); renderSelect(); status.textContent = '';
    } catch (error) { if (revision === loadRevision) status.textContent = `加载失败，无法保存：${error.message}`; }
  }

  select.addEventListener('change', () => { if (!loaded || busy) return; const preset = library.presets.find((item) => item.id === select.value); if (preset) applyPreset(preset); });
  byId('text-preset-add-rule').addEventListener('click', () => { rules.push({ enabled: true, find: '', replace: '', regex: false, caseSensitive: false }); renderRules(); MaweTextProcess.renderTextProcessPreview(); });
  byId('text-preset-add-fillers').addEventListener('click', () => {
    byId('text-preset-fillers').value.split(/\r?\n/).filter(Boolean).forEach((find) => rules.push({ enabled: true, find, replace: '', regex: false, caseSensitive: false }));
    byId('text-preset-fillers').value = ''; renderRules(); MaweTextProcess.renderTextProcessPreview();
  });
  function save(asNew) {
    if (!loaded) return;
    const existing = !asNew && library.presets.find((item) => item.id === select.value);
    const name = existing?.name || global.prompt('预设名称');
    if (!name?.trim()) return;
    const id = existing?.id || global.crypto.randomUUID();
    const next = JSON.parse(JSON.stringify(library));
    const index = next.presets.findIndex((item) => item.id === id);
    if (index < 0) next.presets.push(snapshot(id, name.trim())); else next.presets[index] = snapshot(id, name.trim());
    void persist(next, id);
  }
  byId('text-preset-save').addEventListener('click', () => save(false));
  byId('text-preset-save-as').addEventListener('click', () => save(true));
  byId('text-preset-delete').addEventListener('click', () => {
    const selected = select.value;
    if (selected && global.confirm('删除这个预设？')) void persist({ ...library, presets: library.presets.filter((item) => item.id !== selected) }, '');
  });
  byId('text-preset-export').addEventListener('click', () => {
    if (!loaded) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(library, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'text-processing-presets.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  byId('text-preset-import').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || !loaded || !global.confirm('导入会替换当前预设库，是否继续？')) return;
    try { if (file.size > 512 * 1024) throw new Error('文件过大'); await persist(validate(JSON.parse(await file.text())), ''); }
    catch (error) { status.textContent = `导入失败：${error.message}`; }
  });
  global.MaweTextPresets = Object.freeze({ rules: () => rules, onOpen, runRules });
})(window);

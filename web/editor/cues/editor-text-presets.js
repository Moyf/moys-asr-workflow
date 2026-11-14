// User library I/O and per-project values shared by the two processing tools.
// User library I/O and per-project values shared by the two processing tools. ESM init 模块：initMaweTextPresets 在原清单位次执行原 IIFE 体（挂

// window.MaweProcessing 冻结门面——classic 侧出接口）；底部具名导出经门面在调用时转发，
// 兄弟模块可静态 import。
export function initMaweTextPresets() {
(function initProcessing(global) {
  'use strict';
  const schema = 'moy.asr.text_processing_presets.v2';
  const key = 'moy.asr.text_processing_presets.v1';
  const joinDefaults = Object.freeze({
    gapMs: 200, snapDirection: 'backward', absorbShort: true,
    shortCount: 3, absorbDirection: 'previous',
  });
  const emptyLibrary = () => ({ schema, revision: 0, presets: [], defaultPresetId: null });
  const endpoint = () => MaweBoot.SERVER_CONFIG?.textProcessingPresetsUrl;
  let library = emptyLibrary();
  let readRequest = null;
  let pendingWrite = false;

  const simpleSteps = ['stripMarkdown', 'trim', 'capitalize', 'convertChineseNumbers'];
  const text = (value, max = 512 * 1024) => typeof value === 'string' && value.length <= max;
  const flag = (value) => typeof value === 'boolean';
  const wrapIds = new Set(['custom', ...global.AsrEditorUtils.WRAP_CHAR_PRESETS.map(({ id }) => id)]);

  function normalizeSteps(steps) {
    if (!Array.isArray(steps) || steps.length > 110) throw new Error('预设操作格式无效');
    return steps.map((step) => {
      if (!step || !flag(step.enabled ?? true)) throw new Error('预设操作格式无效');
      const base = { type: step.type, enabled: step.enabled ?? true };
      if (simpleSteps.includes(step.type)) return base;
      if (step.type === 'replace' && text(step.find) && text(step.replacement)
          && flag(step.regex) && flag(step.caseSensitive)) {
        return { ...base, find: step.find, replacement: step.replacement, regex: step.regex, caseSensitive: step.caseSensitive };
      }
      if (step.type === 'wrap' && Array.isArray(step.wraps) && step.wraps.length <= 100) {
        const wraps = step.wraps.map((wrap) => {
          if (!wrapIds.has(wrap?.id)
              || ('left' in wrap && !text(wrap.left)) || ('right' in wrap && !text(wrap.right))) {
            throw new Error('预设操作格式无效');
          }
          return wrap.id === 'custom' || 'left' in wrap || 'right' in wrap
            ? { id: wrap.id, left: wrap.left ?? '', right: wrap.right ?? '' } : { id: wrap.id };
        });
        return { ...base, wraps };
      }
      throw new Error('预设操作格式无效');
    });
  }

  function legacySteps(preset) {
    const ops = preset.operations;
    if (!ops || typeof ops !== 'object' || Array.isArray(ops)
        || !Array.isArray(preset.rules) || preset.rules.length > 100
        || simpleSteps.some((kind) => kind in ops && !flag(ops[kind]))
        || ['left', 'right'].some((key) => key in ops && !text(ops[key]))
        || ('wraps' in ops && (!Array.isArray(ops.wraps) || ops.wraps.some((pair) =>
          !pair || typeof pair.id !== 'string' || !text(pair.left) || !text(pair.right))))) throw new Error('预设操作格式无效');
    const steps = preset.rules.map((rule) => {
      if (!flag(rule?.enabled)) throw new Error('替换规则格式无效');
      return { ...rule, type: 'replace', replacement: rule.replace };
    });
    for (const type of simpleSteps) if (ops[type]) steps.push({ type });
    const wraps = (ops.wraps || []).map((pair) =>
      pair.id === 'custom' ? { ...pair, left: ops.left ?? '', right: ops.right ?? '' }
        : wrapIds.has(pair.id) ? pair : { ...pair, id: 'custom' })
      .filter(({ left, right }) => left || right);
    if (wraps.length) steps.push({ type: 'wrap', wraps });
    return steps;
  }

  function validate(value) {
    const revision = value?.revision ?? 0;
    if (![schema, key].includes(value?.schema) || !Number.isSafeInteger(revision) || revision < 0
        || !Array.isArray(value.presets) || value.presets.length > 100) throw new Error('预设库格式无效');
    const ids = new Set();
    const presets = value.presets.map((preset) => {
      if (!text(preset?.id, 160) || !preset.id || ids.has(preset.id) || !text(preset.name, 160)
          || !preset.name.trim() || !['all', 'selected'].includes(preset.scope)) throw new Error('预设格式无效');
      ids.add(preset.id);
      return { id: preset.id, name: preset.name.trim(), scope: preset.scope,
        steps: normalizeSteps('steps' in preset ? preset.steps : legacySteps(preset)) };
    });
    const defaultPresetId = value.defaultPresetId ?? null;
    if (defaultPresetId !== null && !ids.has(defaultPresetId)) throw new Error('预设库格式无效');
    if ('join' in value && !validJoin(value.join)) throw new Error('预设库格式无效');
    return { schema, revision, presets, defaultPresetId, ...('join' in value ? { join: value.join } : {}) };
  }

  function validJoin(value) {
    return value && Number.isInteger(value.gapMs) && value.gapMs >= 0 && value.gapMs <= 10000
      && Number.isInteger(value.shortCount) && value.shortCount >= 1 && value.shortCount <= 20
      && flag(value.absorbShort) && ['backward', 'forward'].includes(value.snapDirection)
      && ['previous', 'next'].includes(value.absorbDirection);
  }

  function readLocal() {
    const raw = MaweHost.storage.getItem(key);
    return raw ? validate(JSON.parse(raw)) : emptyLibrary();
  }

  function validateForSave(value) {
    const normalized = validate(value);
    if (new Blob([JSON.stringify(normalized, null, 2)]).size + 1 > 1024 * 1024) throw new Error('文件过大');
    return normalized;
  }

  function validateImport(value) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !Array.isArray(value.presets)) {
      // 单条预设文件：形如 { name, steps }（scope 可缺省为 'all'）。
      if (!text(value.name, 160) || !value.name.trim() || !('steps' in value)) throw new Error('预设格式无效');
      const scope = value.scope === undefined ? 'all' : value.scope;
      if (!['all', 'selected'].includes(scope)) throw new Error('预设格式无效');
      return { kind: 'single', preset: { name: value.name.trim(), scope, steps: normalizeSteps(value.steps) } };
    }
    const { presets, defaultPresetId } = validate(value);
    return { kind: 'library', ...validateForSave({ ...library, presets, defaultPresetId }) };
  }

  async function persist(next) {
    next = validateForSave(next);
    if (endpoint()) {
      const response = await fetch(endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...next, requestToken: MaweBoot.SERVER_CONFIG.requestToken }),
      });
      if (response.status === 409) {
        const payload = await response.json().catch(() => null);
        if (payload?.current) library = validate(payload.current);
        return 'conflict';
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      library = validate(await response.json());
    } else {
      const write = () => {
        const current = readLocal();
        if (current.revision !== next.revision) {
          library = current;
          return 'conflict';
        }
        const saved = { ...next, revision: next.revision + 1 };
        MaweHost.storage.setItem(key, JSON.stringify(saved));
        library = saved;
        return 'saved';
      };
      return navigator.locks?.request ? navigator.locks.request(key, write) : write();
    }
    return 'saved';
  }

  function legacyJoin() {
    try {
      const old = JSON.parse(MaweHost.storage.getItem(MaweSettings.EDITOR_SETTINGS_KEY) || '{}');
      if (!Object.keys(old).some((name) => name.startsWith('autoMerge'))) return null;
      const settings = window.AsrEditorUtils.normalizeEditorSettings(old);
      const join = {
        gapMs: settings.autoMergeGapMs, snapDirection: settings.autoMergeSnapDirection,
        absorbShort: settings.autoMergeAbsorbShort, shortCount: settings.autoMergeShortCount,
        absorbDirection: settings.autoMergeAbsorbDirection,
      };
      return Object.keys(joinDefaults).some((name) => join[name] !== joinDefaults[name]) ? join : null;
    } catch {
      return null;
    }
  }

  async function refresh() {
    if (readRequest) return readRequest;
    if (pendingWrite) return true;
    readRequest = (async () => {
      try {
        if (endpoint()) {
          const response = await fetch(endpoint(), { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          library = validate(await response.json());
        } else {
          library = readLocal();
        }
        const legacy = !library.join && legacyJoin();
        if (legacy) await persist({ ...library, join: legacy });
        return true;
      } catch {
        return false;
      }
    })();
    try {
      return await readRequest;
    } finally {
      readRequest = null;
    }
  }

  async function update(change) {
    if (pendingWrite) return 'busy';
    pendingWrite = true;
    try {
      if (readRequest && !await readRequest) return 'error';
      const next = structuredClone(library);
      change(next);
      return await persist(next);
    } catch (error) {
      return error;
    } finally {
      pendingWrite = false;
    }
  }

  function projectOverride(kind) {
    const value = MaweBoot.DATA.processing_overrides?.[kind];
    if (kind === 'text') {
      if (value === undefined) return undefined;
      try { return normalizeSteps(value); } catch { return undefined; }
    }
    return validJoin(value) ? value : undefined;
  }

  function setProjectOverride(kind, value) {
    const next = { ...MaweBoot.DATA.processing_overrides };
    if (value === undefined) delete next[kind];
    else if (kind === 'text') next.text = normalizeSteps(value);
    else if (validJoin(value)) next.join = structuredClone(value);
    else throw new Error('拼合参数无效');
    if (JSON.stringify(next) === JSON.stringify(MaweBoot.DATA.processing_overrides || {})) return;
    MaweBoot.DATA.processing_overrides = Object.keys(next).length ? next : undefined;
    MaweState.changes.processingOverridesDirty = true;
  }

  global.MaweProcessing = Object.freeze({
    refresh, update, validateImport, projectOverride, setProjectOverride,
    get library() { return library; },
    get portable() { return !endpoint(); },
    get effectiveJoin() { return projectOverride('join') || library.join || legacyJoin() || joinDefaults; },
  });
})(window);
}

export function refresh(...args) { return window.MaweProcessing.refresh(...args); }
export function update(...args) { return window.MaweProcessing.update(...args); }
export function validateImport(...args) { return window.MaweProcessing.validateImport(...args); }
export function projectOverride(...args) { return window.MaweProcessing.projectOverride(...args); }
export function setProjectOverride(...args) { return window.MaweProcessing.setProjectOverride(...args); }

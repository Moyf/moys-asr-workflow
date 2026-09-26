// data: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-data', function createUtilsModule(dependencies) {
  'use strict';

  const PROJECT_SCHEMA = 'moy.asr.project.v1';


  function supportsProjectSchema(project) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) return false;
    return project.schema === undefined || project.schema === PROJECT_SCHEMA;
  }


  function countTextUnits(text) {
    const normalized = String(text || '').replace(/\r\n?/g, '').replace(/\n/g, '');
    let total = 0;
    for (const ch of normalized) total += ch.codePointAt(0) < 256 ? 0.5 : 1;
    return total;
  }


  function cloneJsonValue(value) {
    return value == null ? null : JSON.parse(JSON.stringify(value));
  }


  function clampInteger(value, fallback, minimum, maximum) {
    const rounded = Math.round(Number(value));
    return Math.min(maximum, Math.max(minimum, Number.isFinite(rounded) ? rounded : fallback));
  }


  function stableId(value) {
    const id = String(value == null ? '' : value).trim();
    return id && id.length <= 160 ? id : '';
  }


  function ensureStableSegmentIds(segments, prefix = 'segment') {
    const source = Array.isArray(segments) ? segments : [];
    // Reserve every valid explicit ID first. This keeps the browser's repair
    // result identical to maw.project._normalize_stable_ids when a generated
    // ID would otherwise collide with a later explicit one.
    const reserved = new Set(source
      .map((segment) => stableId(segment?.id))
      .filter(Boolean));
    const used = new Set();
    let changed = 0;
    source.forEach((segment, index) => {
      if (!segment || typeof segment !== 'object') return;
      let id = stableId(segment.id);
      if (!id || used.has(id)) {
        const base = `${prefix}-${String(index + 1).padStart(3, '0')}`;
        id = base;
        let suffix = 2;
        while (used.has(id) || (id !== base && reserved.has(id))) {
          id = `${base}-${suffix++}`;
        }
        if (reserved.has(id)) {
          id = `${base}-generated`;
          suffix = 2;
          while (used.has(id) || reserved.has(id)) {
            id = `${base}-generated-${suffix++}`;
          }
        }
        segment.id = id;
        changed++;
      } else if (segment.id !== id) {
        segment.id = id;
        changed++;
      }
      used.add(id);
    });
    return changed;
  }


  function uniqueStableSegmentId(segments, baseId, fallbackPrefix = 'segment') {
    const used = new Set((Array.isArray(segments) ? segments : [])
      .map((segment) => stableId(segment?.id)).filter(Boolean));
    const base = stableId(baseId) || `${fallbackPrefix}-new`;
    if (!used.has(base)) return base;
    let suffix = 2;
    let candidate = `${base}-${suffix}`;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    return candidate;
  }


  function detectSubtitleSplitMode(text, language = '') {
    const value = `${String(language || '')} ${String(text || '')}`;
    return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(value)
      ? 'continuous' : 'word';
  }


  function effectiveColorName(segment, segments) {
    const direct = segment?.color?.name;
    if (typeof direct === 'string' && direct) return direct;
    const reference = segment?.color_ref;
    const headName = Number.isInteger(reference?.headIdx)
      ? segments?.[reference.headIdx]?.color?.name
      : null;
    if (typeof headName === 'string' && headName) return headName;
    return typeof reference?.name === 'string' && reference.name ? reference.name : null;
  }


  function cloneJsonValue(value) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  return Object.freeze({ PROJECT_SCHEMA, clampInteger, cloneJsonValue, countTextUnits, detectSubtitleSplitMode, effectiveColorName, ensureStableSegmentIds, stableId, supportsProjectSchema, uniqueStableSegmentId });
});

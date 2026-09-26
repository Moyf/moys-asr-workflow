// fonts: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-fonts', function createUtilsModule(dependencies) {
  'use strict';


  const SUBTITLE_FONT_FAMILY_DISPLAY_NAMES_ZH = Object.freeze({
    'Microsoft YaHei': '微软雅黑',
    'Microsoft YaHei UI': '微软雅黑',
    SimHei: '黑体',
    SimSun: '宋体',
    NSimSun: '新宋体',
    FangSong: '仿宋',
    KaiTi: '楷体',
    'PingFang SC': '苹方',
    'Heiti SC': '黑体-简',
    'Songti SC': '宋体-简',
    'Kaiti SC': '楷体-简',
    'Source Han Sans SC': '思源黑体',
    'Source Han Serif SC': '思源宋体',
    'Noto Sans CJK SC': 'Noto Sans CJK 简体中文',
    'Noto Serif CJK SC': 'Noto Serif CJK 简体中文',
  });


  function subtitleFontFamilyDisplayName(family, language) {
    if (language !== 'zh' || typeof family !== 'string') return family;
    return SUBTITLE_FONT_FAMILY_DISPLAY_NAMES_ZH[family] || family;
  }


  // 字体输入框（datalist 搜索）与存储值之间的双向映射。
  // 预设内置字体以 key 存储；本机字体以真实字体族名存储——datalist 展示的
  // 本地化别名（如「微软雅黑」）提交时必须还原，否则浏览器无法解析该名称。
  const SUBTITLE_FONT_FAMILY_PRESETS = Object.freeze([
    { key: 'default', label: '默认无衬线' },
    { key: 'yahei', label: '微软雅黑 / 苹方' },
    { key: 'hei', label: '黑体' },
    { key: 'song', label: '宋体' },
    { key: 'sans', label: 'Arial / Segoe UI' },
  ]);


  function subtitleFontFamilyStoredToInput(family, {
    presets = SUBTITLE_FONT_FAMILY_PRESETS,
    presetLabel = (preset) => preset.label,
    familyDisplay = (candidate) => candidate,
  } = {}) {
    const key = family || 'default';
    const preset = presets.find((item) => item.key === key);
    if (preset) return presetLabel(preset);
    return familyDisplay(key);
  }


  function subtitleFontFamilyInputToStored(text, {
    presets = SUBTITLE_FONT_FAMILY_PRESETS,
    presetLabel = (preset) => preset.label,
    localFamilies = [],
    familyDisplay = (candidate) => candidate,
  } = {}) {
    const value = String(text || '').trim();
    if (!value) return 'default';
    const preset = presets.find((item) => (
      item.label === value || item.key === value || presetLabel(item) === value
    ));
    if (preset) return preset.key;
    const family = (Array.isArray(localFamilies) ? localFamilies : []).find((candidate) => (
      candidate === value || familyDisplay(candidate) === value
    ));
    return family || value;
  }


  // combobox 下拉选项：按显示名合并预设与本机字体并去重。
  // 预设与扫描结果经常重叠（如 Arial / Microsoft YaHei），去重时保留先出现的项。
  function mergeFontFamilyOptions(entries) {
    const seen = new Set();
    const result = [];
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const value = typeof entry?.value === 'string' ? entry.value.trim() : '';
      if (!value) return;
      const label = typeof entry?.label === 'string' && entry.label.trim()
        ? entry.label.trim() : value;
      const key = label.toLocaleLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ value, label });
    });
    return result;
  }


  // 过滤字体下拉选项：开头匹配（前缀）排在包含匹配之前，两组各自保持原有相对顺序。
  function filterFontFamilyOptions(entries, query) {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    const source = Array.isArray(entries) ? entries : [];
    if (!normalized) return source;
    const startsWith = [];
    const contains = [];
    source.forEach((entry) => {
      const label = String(entry?.label || '').toLocaleLowerCase();
      if (label.startsWith(normalized)) startsWith.push(entry);
      else if (label.includes(normalized)) contains.push(entry);
    });
    return startsWith.concat(contains);
  }

  return Object.freeze({ SUBTITLE_FONT_FAMILY_PRESETS, filterFontFamilyOptions, mergeFontFamilyOptions, subtitleFontFamilyDisplayName, subtitleFontFamilyInputToStored, subtitleFontFamilyStoredToInput });
});

// speakers: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-speakers', function createUtilsModule(dependencies) {
  'use strict';
  const { effectiveColorName } = dependencies;


  const SPEAKER_LABEL_COLORS = Object.freeze([
    'yellow', 'green', 'red', 'purple', 'blue',
  ]);

  const DEFAULT_SPEAKER_LABELS = Object.freeze({
    yellow: 'SP1',
    green: 'SP2',
    red: 'SP3',
    purple: 'SP4',
    blue: 'SP5',
  });

  const SPEAKER_LABEL_MAX_LENGTH = 64;

  const DEFAULT_SPEAKER_LABEL_SEPARATOR = '：';

  const SPEAKER_LABEL_SEPARATOR_MAX_LENGTH = 16;


  function normalizeSpeakerLabel(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const normalized = value
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return normalized.length <= SPEAKER_LABEL_MAX_LENGTH ? normalized : fallback;
  }


  function normalizeSpeakerLabels(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(SPEAKER_LABEL_COLORS.map((color) => [
      color,
      Object.prototype.hasOwnProperty.call(source, color)
        ? normalizeSpeakerLabel(source[color], DEFAULT_SPEAKER_LABELS[color])
        : DEFAULT_SPEAKER_LABELS[color],
    ]));
  }


  function normalizeSpeakerLabelSeparator(value) {
    if (typeof value !== 'string') return DEFAULT_SPEAKER_LABEL_SEPARATOR;
    const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '');
    return normalized.length <= SPEAKER_LABEL_SEPARATOR_MAX_LENGTH
      ? normalized
      : DEFAULT_SPEAKER_LABEL_SEPARATOR;
  }


  function normalizeSpeakerLabelSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const hasMappingEnabled = Object.prototype.hasOwnProperty.call(source, 'mapping_enabled');
    const hasEnabled = Object.prototype.hasOwnProperty.call(source, 'enabled');
    return {
      // 旧工程没有独立的映射开关时，沿用原来的 enabled 语义，避免升级后
      // 已配置的说话人名称突然失效；新工程的预览名称默认开启，显式 false 仍保留。
      mapping_enabled: hasMappingEnabled ? source.mapping_enabled === true : source.enabled === true,
      enabled: hasEnabled ? source.enabled === true : true,
      separator: normalizeSpeakerLabelSeparator(source.separator),
      names: normalizeSpeakerLabels(source.names),
    };
  }


  function speakerLabelForSegment(segment, segments, labels) {
    const colorName = effectiveColorName(segment, segments);
    if (!colorName) return '';
    return normalizeSpeakerLabels(labels)[colorName] || '';
  }


  function formatSpeakerLabelledText(
    text,
    segment,
    segments,
    labels,
    separator = DEFAULT_SPEAKER_LABEL_SEPARATOR,
  ) {
    const content = String(text ?? '');
    const label = speakerLabelForSegment(segment, segments, labels);
    return label ? `${label}${normalizeSpeakerLabelSeparator(separator)}${content}` : content;
  }

  return Object.freeze({ DEFAULT_SPEAKER_LABELS, DEFAULT_SPEAKER_LABEL_SEPARATOR, SPEAKER_LABEL_COLORS, SPEAKER_LABEL_MAX_LENGTH, SPEAKER_LABEL_SEPARATOR_MAX_LENGTH, formatSpeakerLabelledText, normalizeSpeakerLabel, normalizeSpeakerLabelSeparator, normalizeSpeakerLabelSettings, normalizeSpeakerLabels, speakerLabelForSegment });
});

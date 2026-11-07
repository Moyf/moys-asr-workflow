// speakers: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';
  const { effectiveColorName, getProject, resolveProjectSpeaker, getSubtitleGroupValue } = dependencies;


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
      ...source,
      // 旧工程没有独立的映射开关时，沿用原来的 enabled 语义，避免升级后
      // 已配置的说话人名称突然失效；新工程的预览名称默认开启，显式 false 仍保留。
      mapping_enabled: hasMappingEnabled ? source.mapping_enabled === true : source.enabled === true,
      enabled: hasEnabled ? source.enabled === true : true,
      export_enabled: source.export_enabled === true,
      separator: normalizeSpeakerLabelSeparator(source.separator),
      names: { ...(source.names && typeof source.names === 'object' && !Array.isArray(source.names) ? source.names : {}),
        ...normalizeSpeakerLabels(source.names) },
    };
  }


  const DISPLAY_COLORS = ['#f9ca1f', '#66bb6a', '#f07f6f', '#bf89e6', '#61a7fa', '#f2a65a', '#49c5c1', '#d675b9', '#969fab'];
  const DISPLAY_COLOR_NAMES = [...SPEAKER_LABEL_COLORS, 'orange', 'cyan', 'magenta', 'gray'];

  function effectiveSegmentColor(project, segment, segments) {
    if (!segment) return null;
    if (project?.annotation_mode === 'speaker') {
      const value = resolveProjectSpeaker(project, segment)?.color?.toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(value || '')) return null;
      return { name: DISPLAY_COLOR_NAMES[DISPLAY_COLORS.indexOf(value)] || null, value };
    }
    const name = effectiveColorName(segment, segments, project);
    if (!name) return null;
    const group = project ? getSubtitleGroupValue?.(project, segment, 'color') : null;
    const direct = segment.color || segments?.[segment.color_ref?.headIdx]?.color;
    const injected = typeof window !== 'undefined' ? window.ASR_EDITOR_PALETTE : null;
    const configured = typeof window !== 'undefined' ? window.MaweColors?.COLOR_BY_NAME?.[name]?.value : null;
    const fallback = DISPLAY_COLORS[DISPLAY_COLOR_NAMES.indexOf(name)];
    const value = configured || injected?.find(entry => entry.name === name)?.value || group?.value || direct?.value || fallback;
    return /^#[0-9a-f]{6}$/i.test(value || '') ? { name, value: value.toLowerCase() } : null;
  }

  function speakerLabelForSegment(segment, segments, labels, project = getProject?.()) {
    if (Array.isArray(project?.speakers)) return resolveProjectSpeaker(project, segment)?.name || '';
    const colorName = effectiveColorName(segment, segments, project);
    if (!colorName) return '';
    return normalizeSpeakerLabels(labels)[colorName] || '';
  }


  function formatSpeakerLabelledText(
    text,
    segment,
    segments,
    labels,
    separator = DEFAULT_SPEAKER_LABEL_SEPARATOR,
    project = getProject?.(),
  ) {
    const content = String(text ?? '');
    const label = speakerLabelForSegment(segment, segments, labels, project);
    return label ? `${label}${normalizeSpeakerLabelSeparator(separator)}${content}` : content;
  }

  return Object.freeze({ DEFAULT_SPEAKER_LABELS, DEFAULT_SPEAKER_LABEL_SEPARATOR, SPEAKER_LABEL_COLORS, SPEAKER_LABEL_MAX_LENGTH, SPEAKER_LABEL_SEPARATOR_MAX_LENGTH, effectiveSegmentColor, formatSpeakerLabelledText, normalizeSpeakerLabel, normalizeSpeakerLabelSeparator, normalizeSpeakerLabelSettings, normalizeSpeakerLabels, speakerLabelForSegment });
}

// labels: waveform helpers with explicit dependencies.
window.MAWE.register('waveform-labels', function createWaveformModule(dependencies) {
  'use strict';


  function localizedWaveformMessage(zh, en) {
    return window.MAWE_I18N?.language === 'en' ? en : zh;
  }


  const GAP_REMOVE_DISPLAY_LABELS = Object.freeze({
    zh: Object.freeze({
      audio_gate: '静音空隙（自动生成）',
      audio_gate_manual: '静音空隙（自动生成+手动调整）',
      manual: '跳过空隙（手动创建）',
      script_alignment: '台本对齐自动移除',
      script_alignment_manual: '台本对齐自动移除（手动调整）',
      multi_source: '自动移除（多来源）',
      multi_source_manual: '自动移除（多来源+手动调整）',
      unknown: '空隙',
    }),
    en: Object.freeze({
      audio_gate: 'Silence gap (auto-generated)',
      audio_gate_manual: 'Silence gap (auto-generated + manually adjusted)',
      manual: 'Skip gap (manually created)',
      script_alignment: 'Script alignment auto-removal',
      script_alignment_manual: 'Script alignment auto-removal (manually adjusted)',
      multi_source: 'Auto-removal (multiple sources)',
      multi_source_manual: 'Auto-removal (multiple sources + manually adjusted)',
      unknown: 'Gap',
    }),
  });


  function gapRemoveDisplayLabel(gap) {
    const type = window.AsrGapRemoveCore?.getGapRemoveDisplayType?.(gap) || 'unknown';
    const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
    return GAP_REMOVE_DISPLAY_LABELS[language][type] || GAP_REMOVE_DISPLAY_LABELS[language].unknown;
  }


  function gapOperationAllowsBoundary(mode) {
    return window.AsrGapRemoveCore.gapOperationAllowsBoundary(mode);
  }


  function gapOperationAllowsMiddle(mode) {
    return window.AsrGapRemoveCore.gapOperationAllowsMiddle(mode);
  }

  return Object.freeze({ gapOperationAllowsBoundary, gapOperationAllowsMiddle, gapRemoveDisplayLabel, localizedWaveformMessage });
});

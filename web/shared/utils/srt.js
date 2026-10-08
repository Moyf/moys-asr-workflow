// srt: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';
  const { DEFAULT_SPEAKER_LABEL_SEPARATOR, effectiveColorName, formatSpeakerLabelledText, normalizeSpeakerLabelSeparator, normalizeSpeakerLabels, stripSentenceFadeMarkers } = dependencies;


  function getSrtExportFirstIndex(segments, alignFirstEnabled = false) {
    if (!alignFirstEnabled || !Array.isArray(segments)) return -1;
    return segments.findIndex((segment) => (
      segment && !segment.disabled && Number.isFinite(Number(segment.start))
    ));
  }


  // 保留这个数值 helper 供已有调用方使用；SRT 导出本身不应把它从所有时间码中扣除。
  function getSrtExportOffset(segments, alignFirstEnabled = false) {
    const firstIndex = getSrtExportFirstIndex(segments, alignFirstEnabled);
    if (firstIndex < 0) return 0;
    return Math.max(0, Math.round(Number(segments[firstIndex].start)));
  }


  // 在字幕数组中插入新段后，所有指向插入点及其后方 head 的引用都右移。
  // headIdx 是数组下标，不随 Array.splice 自动更新；调用方必须在插入后立即调用。
  function shiftGroupReferenceIndices(segments, insertionIndex, delta = 1) {
    if (!Array.isArray(segments)) return 0;
    const pivot = Number(insertionIndex);
    const shift = Number(delta);
    if (!Number.isInteger(pivot) || !Number.isInteger(shift) || shift === 0) return 0;
    let changed = 0;
    segments.forEach((segment) => {
      ['sticker_ref', 'color_ref'].forEach((field) => {
        const reference = segment?.[field];
        if (!reference || !Number.isInteger(reference.headIdx) || reference.headIdx < pivot) return;
        reference.headIdx += shift;
        changed++;
      });
    });
    return changed;
  }


  // 兼容旧工程中因插入字幕导致的错位引用：引用自身保留了 head 的名称，
  // 可用它在当前条目之前寻找最近的同名 head。合法引用不做任何改动。
  function repairGroupReferenceIndices(segments) {
    if (!Array.isArray(segments)) return 0;
    const groups = [
      { head: 'sticker', reference: 'sticker_ref' },
      { head: 'color', reference: 'color_ref' },
    ];
    let repaired = 0;
    segments.forEach((segment, index) => {
      groups.forEach(({ head, reference }) => {
        const ref = segment?.[reference];
        if (!ref || !Number.isInteger(ref.headIdx)) return;
        const currentHead = segments[ref.headIdx]?.[head];
        if (currentHead && (!ref.name || currentHead.name === ref.name)) return;
        if (typeof ref.name !== 'string' || !ref.name) return;
        for (let candidate = index - 1; candidate >= 0; candidate--) {
          if (segments[candidate]?.[head]?.name !== ref.name) continue;
          if (ref.headIdx !== candidate) {
            ref.headIdx = candidate;
            repaired++;
          }
          break;
        }
      });
    });
    return repaired;
  }


  // 从字幕数组移除/迁出下标 index 的段后同步选择状态：该下标移出选中集，
  // 其后的选中项与 Shift 范围锚点前移一位，避免选中状态落到后面的字幕上。
  // selection 是会被原地修改的 Set；返回 { wasSelected, nextAnchor }。
  function shiftSelectionAfterRemoval(selection, anchorIndex, removedIndex) {
    // 用 Object.prototype.toString 判断 Set，兼容 vm 等跨 realm 环境。
    if (Object.prototype.toString.call(selection) !== '[object Set]' || !Number.isInteger(removedIndex)) {
      return { wasSelected: false, nextAnchor: Number.isInteger(anchorIndex) ? anchorIndex : -1 };
    }
    const wasSelected = selection.has(removedIndex);
    selection.delete(removedIndex);
    [...selection].forEach((idx) => {
      if (idx > removedIndex) {
        selection.delete(idx);
        selection.add(idx - 1);
      }
    });
    const anchor = Number.isInteger(anchorIndex) ? anchorIndex : -1;
    const nextAnchor = anchor === removedIndex ? -1
      : anchor > removedIndex ? anchor - 1 : anchor;
    return { wasSelected, nextAnchor };
  }


  function buildSrtPayload(segments, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    const colorName = typeof options.colorName === 'string' ? options.colorName : null;
    const timeOffset = Math.max(0, Math.round(Number(options.timeOffset)) || 0);
    const mapTime = typeof options.mapTime === 'function'
      ? options.mapTime
      : (timeMs) => Math.max(0, Math.round(Number(timeMs) || 0) - timeOffset);
    const formatTime = typeof options.formatTime === 'function'
      ? options.formatTime
      : (timeMs) => String(timeMs);
    const alignFirstStart = options.alignFirstStart === true;
    const firstEnabledIndex = Number.isInteger(options.firstEnabledIndex)
      ? options.firstEnabledIndex
      : getSrtExportFirstIndex(source, alignFirstStart);
    const keepDisabledPlaceholder = options.keepDisabledPlaceholder === true && !colorName;
    const speakerLabels = options.speakerLabelsEnabled === true
      ? normalizeSpeakerLabels(options.speakerLabels)
      : null;
    const speakerLabelSeparator = options.speakerLabelsEnabled === true
      ? normalizeSpeakerLabelSeparator(options.speakerLabelSeparator)
      : DEFAULT_SPEAKER_LABEL_SEPARATOR;
    const parts = [];
    let outputIndex = 0;
    // 颜色/说话人解析上下文：合并导出（主轨 + 叠加轨）时，叠加段的
    // color_ref 指向叠加轨自身数组，不能在合并后的大数组里按下标解析。
    const colorContextResolver = typeof options.colorContextResolver === 'function'
      ? options.colorContextResolver : () => source;
    source.forEach((segment, sourceIndex) => {
      if (!segment) return;
      const disabled = segment.disabled === true;
      if (disabled && !keepDisabledPlaceholder) return;
      const colorContext = colorContextResolver(segment) || source;
      if (!disabled && colorName) {
        const effectiveName = effectiveColorName(segment, colorContext);
        const matches = colorName === 'default' ? !effectiveName : effectiveName === colorName;
        if (!matches) return;
      }
      const mappedStart = Math.max(0, Math.round(Number(mapTime(segment.start)) || 0));
      const start = alignFirstStart && !disabled && sourceIndex === firstEnabledIndex ? 0 : mappedStart;
      const mappedEnd = Math.max(0, Math.round(Number(mapTime(segment.end)) || 0));
      const end = options.ensurePositiveDuration ? Math.max(start + 1, mappedEnd) : mappedEnd;
      outputIndex += 1;
      parts.push(String(outputIndex));
      parts.push(`${formatTime(start)} --> ${formatTime(end)}`);
      const cueText = String(segment.text ?? '');
      parts.push(disabled ? '' : speakerLabels
        ? formatSpeakerLabelledText(
          stripSentenceFadeMarkers(cueText, options.assSpecialSymbolRule), segment, colorContext, speakerLabels, speakerLabelSeparator,
        )
        : stripSentenceFadeMarkers(cueText, options.assSpecialSymbolRule));
      parts.push('');
    });
    return parts.join('\n');
  }


  // Preserve both tracks' timing; active main text appears above secondary text.
  function buildBilingualSrtPayload(mainSegments, secondarySegments, options = {}) {
    const main = Array.isArray(mainSegments) ? mainSegments : [];
    const secondary = Array.isArray(secondarySegments) ? secondarySegments : [];
    const labels = options.speakerLabelsEnabled === true ? normalizeSpeakerLabels(options.speakerLabels) : null;
    const separator = normalizeSpeakerLabelSeparator(options.speakerLabelSeparator);
    const firstMain = getSrtExportFirstIndex(main, options.alignFirstStart === true);
    const events = new Map();
    const addEvent = (time, record, entering) => {
      if (!events.has(time)) events.set(time, []);
      events.get(time).push({ record, entering });
    };
    [main, secondary].forEach((source, track) => source.forEach((segment, index) => {
      if (!segment || segment.disabled === true) return;
      const rawStart = Number(segment.start);
      const rawEnd = Number(segment.end);
      if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return;
      const start = track === 0 && index === firstMain ? 0 : Math.max(0, Math.round(rawStart));
      const end = Math.max(0, Math.round(rawEnd));
      if (end <= start) return;
      const context = track === 0 && typeof options.colorContextResolver === 'function'
        ? options.colorContextResolver(segment) || source : source;
      const strippedText = stripSentenceFadeMarkers(String(segment.text ?? ''), options.assSpecialSymbolRule);
      const text = String(labels ? formatSpeakerLabelledText(strippedText, segment, context, labels, separator)
        : strippedText).replace(/\r\n?/g, '\n');
      if (!text.trim()) return;
      const record = { track, index, text };
      addEvent(start, record, true);
      addEvent(end, record, false);
    }));
    const times = [...events.keys()].sort((a, b) => a - b);
    const active = [new Set(), new Set()];
    const merged = [];
    times.forEach((start, index) => {
      for (const { record, entering } of events.get(start)) {
        if (entering) active[record.track].add(record);
        else active[record.track].delete(record);
      }
      const end = times[index + 1];
      if (end === undefined) return;
      const text = active.flatMap((records) => [...records].sort((a, b) => a.index - b.index)
        .map((record) => record.text)).join('\n');
      if (!text) return;
      const previous = merged[merged.length - 1];
      if (previous && previous.end === start && previous.text === text) previous.end = end;
      else merged.push({ start, end, text });
    });
    // 每条原字幕已按规则清理；合并后再次解析会剥掉被禁用或剩余的字面符号。
    return buildSrtPayload(merged, { formatTime: options.formatTime, assSpecialSymbolRule: 'none' });
  }

  function buildPlainTextPayload(segments, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    return source
      .filter((segment) => segment && !segment.disabled)
      .map((segment) => {
        const text = String(segment.text || '').replace(/\r\n?/g, '\n');
        return options.speakerLabelsEnabled === true
          ? formatSpeakerLabelledText(text, segment, source, options.speakerLabels, options.speakerLabelSeparator)
          : text;
      })
      .join('\n');
  }


  function fileBasename(value) {
    return String(value || '').trim().split(/[\\/]/).pop() || '';
  }

  return Object.freeze({ buildBilingualSrtPayload, buildPlainTextPayload, buildSrtPayload, fileBasename, getSrtExportFirstIndex, getSrtExportOffset, repairGroupReferenceIndices, shiftGroupReferenceIndices, shiftSelectionAfterRemoval });
}

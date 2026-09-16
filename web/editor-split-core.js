// 拆分核心：拆分点计算、字词时间码回退与拆分会话状态。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSplitCore 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweSplitCore(global) {
  'use strict';



  // === 拆分 ===
  let pendingLinkedSplit = null;



  function splitTimeForTextOffset(segment, offset) {
    const timing = splitItemsAtChar(segment, offset);
    if (Number.isFinite(timing.splitMs)) return timing.splitMs;
    const text = String(segment?.text || '');
    const safeOffset = Math.max(0, Math.min(text.length, Number(offset) || 0));
    return Number(segment?.start)
      + ((Number(segment?.end) - Number(segment?.start)) * safeOffset) / Math.max(1, text.length);
  }



  function shouldUseMainSplitTimestamps(segment) {
    return MaweSettings.EDITOR_SETTINGS.splitUseWordTimestamps
      && window.AsrEditorUtils.hasUsableSplitTimestamps(segment);
  }



  function notifyMainSplitTimestampFallback(segment) {
    if (!MaweSettings.EDITOR_SETTINGS.splitUseWordTimestamps
        || window.AsrEditorUtils.hasUsableSplitTimestamps(segment)) return;
    const message = '已勾选“主字幕自动使用时间码拆分”，但当前主字幕没有可用的字词时间码，本次设置不生效，已改用拆分面板。';
    MaweHint.flashHint(window.MAWE_I18N?.translateText?.(message) || message, 'warning');
  }



  function splitOffsetNearTime(segment, timeMs, splitMode) {
    const legalOffsets = window.AsrEditorUtils.subtitleSplitOffsets(segment?.text || '', splitMode);
    if (!legalOffsets.length) return null;
    const timestampOffset = window.AsrEditorUtils.hasUsableSplitTimestamps(segment)
      ? window.AsrEditorUtils.splitCharOffsetAtTime(segment, timeMs)
      : null;
    if (Number.isInteger(timestampOffset)) {
      return legalOffsets.reduce((best, candidate) => (
        Math.abs(candidate - timestampOffset) < Math.abs(best - timestampOffset) ? candidate : best
      ), legalOffsets[0]);
    }
    return window.AsrEditorUtils.nearestSubtitleSplitOffset(
      segment.text, timeMs, segment.start, segment.end, splitMode,
    );
  }



  function splitOffsetNearTextPosition(text, offset, splitMode) {
    const legalOffsets = window.AsrEditorUtils.subtitleSplitOffsets(text || '', splitMode);
    if (!legalOffsets.length) return null;
    const requested = Math.max(0, Math.min(String(text || '').length, Math.round(Number(offset) || 0)));
    return legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - requested) < Math.abs(best - requested) ? candidate : best
    ), legalOffsets[0]);
  }



  function cleanSplitItems(items, side) {
    const source = Array.isArray(items) ? items : [];
    return source
      .map((item) => ({ ...item, text: String(item?.text || '') }))
      .map((item, index, list) => ({
        ...item,
        text: side === 'left' && index === list.length - 1
          ? window.AsrEditorUtils.applySplitEdgeTrim(item.text, 'end')
          : side === 'right' && index === 0
            ? window.AsrEditorUtils.applySplitEdgeTrim(item.text, 'start')
            : item.text,
      }))
      .filter((item) => item.text && Number.isFinite(item.start)
        && Number.isFinite(item.end) && item.end > item.start);
  }



  function forceSplitCutForSegments(segments, requestedCutMs) {
    const ranges = (Array.isArray(segments) ? segments : [segments])
      .map((segment) => ({
        start: Number(segment?.start),
        end: Number(segment?.end),
      }))
      .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end));
    if (!ranges.length || ranges.some((range) => range.end - range.start < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2)) {
      return null;
    }
    const lower = Math.max(...ranges.map((range) => range.start + MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS));
    const upper = Math.min(...ranges.map((range) => range.end - MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS));
    if (lower > upper) return null;
    const requested = Number(requestedCutMs);
    const cut = Number.isFinite(requested) ? Math.round(requested) : lower;
    return Math.min(upper, Math.max(lower, cut));
  }



  function forcedSplitRetryHint() {
    return '当前切点会产生不足 100ms 的一侧；请再次按 B 或 Enter 强制拆分，切点将调整为两侧各至少 100ms';
  }



  function armForcedSplit(state) {
    if (!state) return false;
    if (!Number.isFinite(state.forceCutMs)) {
      MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
      return false;
    }
    if (state.forceSplitArmed) return true;
    state.forceSplitArmed = true;
    MaweHint.flashHint(forcedSplitRetryHint(), 'warning');
    return false;
  }



  function splitItemsAtChar(
    segment,
    cursorChar,
    requestedCutMs = null,
    { preserveCutMs = false, forceCut = false } = {},
  ) {
    const text = String(segment?.text || '');
    const safeOffset = Math.max(0, Math.min(text.length, Math.round(Number(cursorChar) || 0)));
    const segmentStart = Number(segment?.start);
    const segmentEnd = Number(segment?.end);
    const safeSegmentStart = Number.isFinite(segmentStart) ? segmentStart : 0;
    const safeSegmentEnd = Number.isFinite(segmentEnd) && segmentEnd >= safeSegmentStart
      ? segmentEnd : safeSegmentStart;
    const items = Array.isArray(segment?.items) ? segment.items : [];
    const hasItems = items.some((item) => String(item?.text || ''));

    // 用原文查找 item 文本，处理 item 不包含词间空格的常见工程格式。
    // 如果上游 item 文本无法和字幕原文对齐，则退回旧的顺序长度映射，
    // 但后面的时间钳制和副本分组仍然保持一致。
    let searchFrom = 0;
    let aligned = true;
    const records = [];
    for (const item of items) {
      const itemText = String(item?.text || '');
      if (!itemText) continue;
      const textStart = text.indexOf(itemText, searchFrom);
      if (textStart < 0) {
        aligned = false;
        break;
      }
      records.push({ item, textStart, textEnd: textStart + itemText.length, itemText });
      searchFrom = textStart + itemText.length;
    }
    if (!aligned) {
      records.length = 0;
      let textStart = 0;
      for (const item of items) {
        const itemText = String(item?.text || '');
        if (!itemText) continue;
        records.push({ item, textStart, textEnd: textStart + itemText.length, itemText });
        textStart += itemText.length;
      }
    }

    const timeRangeFor = (item) => {
      const rawStart = Number(item?.start);
      const rawEnd = Number(item?.end);
      const start = Math.max(
        safeSegmentStart,
        Number.isFinite(rawStart) ? rawStart : safeSegmentStart,
      );
      const end = Math.min(
        safeSegmentEnd,
        Number.isFinite(rawEnd) ? rawEnd : safeSegmentEnd,
      );
      if (end > start) return { start, end };
      // item 时间完全落在段范围之外（上游工程的病态时间码）：钳制后区间
      // 倒置。丢弃会让词文本从 items 里消失，这里压到越界最近一侧的
      // 最小可表达区间，保留词数据；分配循环仍按文本对齐决定归属侧。
      return Number.isFinite(rawStart) && rawStart >= safeSegmentEnd
        ? { start: Math.max(safeSegmentStart, safeSegmentEnd - 1), end: safeSegmentEnd }
        : { start: safeSegmentStart, end: Math.min(safeSegmentEnd, safeSegmentStart + 1) };
    };
    const previous = [...records].reverse().find((record) => record.textEnd <= safeOffset);
    const next = records.find((record) => record.textStart >= safeOffset);
    const inside = records.find((record) => (
      safeOffset > record.textStart && safeOffset < record.textEnd
    ));
    const requested = Number(requestedCutMs);
    let splitMs = Number.isFinite(requested) ? Math.round(requested) : null;
    // 切点两侧相邻 item 的实际时间区间；else 分支填充，供下方非对称边界使用。
    let previousRange = null;
    let nextRange = null;

    if (inside) {
      const range = timeRangeFor(inside.item);
      const fraction = (safeOffset - inside.textStart) / Math.max(1, inside.textEnd - inside.textStart);
      const interpolated = Math.round(range.start + (range.end - range.start) * fraction);
      if (!preserveCutMs || !Number.isFinite(splitMs)
          || (!forceCut && (splitMs < range.start || splitMs > range.end))) {
        splitMs = interpolated;
      }
    } else {
      if (!records.length && Number.isFinite(splitMs)) {
        splitMs = Math.round(splitMs);
      }
      // 文字切点在 item 边界或词间空白时，吸附到相邻 item 的真实边界：
      // 优先跟随左侧词尾，这会把“模型”后的手工切点从 26526 吸附到
      // “模型”的 end 26680，避免左字幕范围先于完整 item 结束。
      // （连续 item 上两侧相等；有静音空隙时由下方非对称边界接管。）
      previousRange = previous ? timeRangeFor(previous.item) : null;
      nextRange = next ? timeRangeFor(next.item) : null;
      if (records.length && (!preserveCutMs || !Number.isFinite(splitMs))) {
        splitMs = previousRange?.end ?? nextRange?.start ?? null;
      }
    }

    if (!Number.isFinite(splitMs)) {
      const ratio = safeOffset / Math.max(1, text.length);
      splitMs = Math.round(safeSegmentStart + (safeSegmentEnd - safeSegmentStart) * ratio);
    }
    splitMs = Math.max(safeSegmentStart, Math.min(safeSegmentEnd, Math.round(splitMs)));

    // 非对称拆分边界：切点两词之间存在真实静音空隙（如本地 ASR 的
    // “型、”6160-6480 与下一词 6720 起）时，左段停在自家最后一个词的
    // end，右段从自家第一个词的 start 开始，保留真实空隙，而不是把一侧
    // 硬拉过静音。仅在两侧候选都有效且严格正序（timeRangeFor 对病态时间
    // 的钳制可能倒挂）时启用；缺词或缺时间码时落回单一共享切点。
    let leftEndMs = splitMs;
    let rightStartMs = splitMs;
    const prevEdgeMs = previousRange?.end ?? null;
    const nextEdgeMs = nextRange?.start ?? null;
    if (Number.isFinite(prevEdgeMs) && Number.isFinite(nextEdgeMs)
        && nextEdgeMs - prevEdgeMs > 0) {
      leftEndMs = prevEdgeMs;
      rightStartMs = nextEdgeMs;
    }

    const leftItems = [];
    const rightItems = [];
    for (const record of records) {
      const range = timeRangeFor(record.item);
      if (range.end <= range.start) continue;
      const { itemText, textStart, textEnd } = record;
      if (inside === record) {
        const localOffset = Math.max(0, Math.min(itemText.length, safeOffset - textStart));
        const leftText = itemText.slice(0, localOffset);
        const rightText = itemText.slice(localOffset);
        const itemSplitMs = preserveCutMs
          && (forceCut || (splitMs >= range.start && splitMs <= range.end))
          ? splitMs
          : Math.round(range.start + (range.end - range.start)
            * localOffset / Math.max(1, itemText.length));
        if (leftText && rightText && itemSplitMs > range.start && itemSplitMs < range.end) {
          leftItems.push({ ...record.item, text: leftText, start: range.start, end: itemSplitMs });
          rightItems.push({ ...record.item, text: rightText, start: itemSplitMs, end: range.end });
        } else if (leftText && rightText) {
          // 取整后不足以给两侧各留出一个毫秒时，保留完整 item 到更接近
          // 光标的一侧，避免为了制造 0 长 item 而丢失词文本。
          const keepLeft = splitMs >= range.end || localOffset >= itemText.length / 2;
          if (keepLeft) {
            leftItems.push({ ...record.item, text: itemText, start: range.start, end: range.end });
          } else {
            rightItems.push({ ...record.item, text: itemText, start: range.start, end: range.end });
          }
        } else if (leftText && itemSplitMs > range.start) {
          leftItems.push({ ...record.item, text: leftText, start: range.start, end: itemSplitMs });
        } else if (rightText && range.end > itemSplitMs) {
          rightItems.push({ ...record.item, text: rightText, start: itemSplitMs, end: range.end });
        }
        continue;
      }
      if (textEnd <= safeOffset) {
        const end = Math.min(range.end, leftEndMs);
        if (end > range.start) leftItems.push({ ...record.item, start: range.start, end });
      } else if (textStart >= safeOffset) {
        const start = Math.max(range.start, rightStartMs);
        if (range.end > start) rightItems.push({ ...record.item, start, end: range.end });
      } else if (splitMs >= range.start && splitMs <= range.end) {
        // 退回顺序映射或异常 item 文本对齐时，仍不得让 item 穿过字幕边界。
        const end = Math.min(range.end, leftEndMs);
        if (end > range.start) leftItems.push({ ...record.item, start: range.start, end });
      }
    }
    // 病态时间码被钳制到段尾/段头时，可能与相邻 item 挤占同一毫秒槽。
    // 从后往前把前一项的 end 压到后一项的 start，保证 items 递增不重叠；
    // 压到 0 长度的极端病态保留原样，交由保存前的校验暴露问题。
    for (const items of [leftItems, rightItems]) {
      for (let i = items.length - 1; i > 0; i--) {
        if (items[i - 1].end > items[i].start && items[i - 1].start < items[i].start) {
          items[i - 1].end = items[i].start;
        }
      }
    }
    return { leftItems, rightItems, splitMs, leftEndMs, rightStartMs, hasItems };
  }



  function buildSplitPair(
    segment,
    offset,
    cutMs,
    idBase,
    includeItems = true,
    splitMode = null,
    { preserveCutMs = false, forceCut = false } = {},
  ) {
    const text = String(segment?.text || '');
    const mode = window.AsrEditorUtils.MULTI_SUBTITLE_SPLIT_MODES.has(splitMode)
      ? splitMode : window.AsrEditorUtils.detectSubtitleSplitMode(text);
    const parts = window.AsrEditorUtils.splitSubtitleText(text, offset, mode);
    if (!parts) return null;
    const itemParts = splitItemsAtChar(
      includeItems ? segment : { ...segment, items: [] },
      parts.offset,
      cutMs,
      { preserveCutMs, forceCut },
    );
    const leftItems = cleanSplitItems(itemParts.leftItems, 'left');
    const rightItems = cleanSplitItems(itemParts.rightItems, 'right');
    const splitMs = Number.isFinite(itemParts.splitMs) ? itemParts.splitMs : Math.round(cutMs);
    // 左右两段可各自贴合自家词边界（词间有静音空隙时非对称）。
    const leftEnd = Number.isFinite(itemParts.leftEndMs) ? itemParts.leftEndMs : splitMs;
    const rightStart = Number.isFinite(itemParts.rightStartMs) ? itemParts.rightStartMs : splitMs;
    const segmentStart = Number(segment?.start);
    const segmentEnd = Number(segment?.end);
    if (!Number.isFinite(splitMs)
        || !Number.isFinite(segmentStart)
        || !Number.isFinite(segmentEnd)
        || segmentEnd - segmentStart < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2
        || leftEnd - segmentStart < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
        || segmentEnd - rightStart < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
        || rightStart < leftEnd) return null;
    const left = {
      ...segment,
      id: window.AsrEditorUtils.uniqueStableSegmentId([segment], `${idBase}-a`, 'segment'),
      start: segment.start,
      end: leftEnd,
      text: parts.left,
      items: leftItems.length ? leftItems : null,
      _dirty: true,
    };
    const right = {
      ...segment,
      id: window.AsrEditorUtils.uniqueStableSegmentId([segment, left], `${idBase}-b`, 'segment'),
      start: rightStart,
      end: segment.end,
      text: parts.right,
      items: rightItems.length ? rightItems : null,
      _dirty: true,
    };
    if (segment.sticker) {
      right.sticker = null;
      right.sticker_ref = { name: segment.sticker.name, headIdx: 0 };
    }
    if (segment.color) {
      right.color = null;
      right.color_ref = { name: segment.color.name, headIdx: 0 };
    }
    return { left, right, parts, splitMs };
  }



   function linkedSplitState(mainIndex, initial = {}) {
    const main = MaweBoot.DATA.segments[mainIndex];
    const binding = MaweMultiSubtitleCore.bindingForMainIndex(mainIndex);
    const track = binding ? MaweMultiSubtitleCore.getExtensionTrack(binding.track_id) : null;
    const extension = binding ? MaweMultiSubtitleCore.extensionSegmentById(binding.extension_segment_ids?.[0], track) : null;
    if (!main || !binding || !track || !extension) return null;
    // 联动拆分要求主副两侧在共同切点的两边各保留最小时长。副字幕总时长不足、
    // 或两段重叠区间放不下合法切点时，不再直接拒绝：弹窗内会走「只拆主字幕并
    // 解除绑定」的降级路径（仅在主字幕自身可拆时启用）；只有主字幕总时长不足
    // （降级也无从谈起）才提前给出原因。
    const linkedMinSpanMs = MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2;
    if (main.end - main.start < linkedMinSpanMs) {
      MaweHint.flashHint('主字幕总时长不足 200ms，无法联动拆分', 'warning');
      return null;
    }
    const mainMode = MaweMultiSubtitleCore.getMainSubtitleSplitMode(main);
    const extensionMode = MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, extension);
    const hasMainWordTimestamps = window.AsrEditorUtils.hasUsableSplitTimestamps(main);
    const initialTime = Number.isFinite(initial.timeMs)
      ? initial.timeMs
      : splitTimeForTextOffset(main, initial.mainOffset ?? Math.floor(String(main.text || '').length / 2));
    const useMainWordTimestamps = shouldUseMainSplitTimestamps(main);
    // 关闭自动时间码拆分后，波形入口传入的时间仍是绝对切点；没有波形指针时，
    // 有可用时间码就把初始断点定位到最近的字词边界，但之后仍允许用户自由调整。
    const fixedCutMs = !useMainWordTimestamps && Number.isFinite(initial.timeMs)
      ? Math.round(initial.timeMs) : null;
    // 字幕列表传入的是用户实际指向的文字位置；即使工程有字词时间码，
    // 也不能再用时间反推一次文字位置，否则「就是｜这颗」可能漂移成「就是这｜颗」。
    // 没有列表文字位置时（例如波形/播放头入口）才按时间寻找最近合法断点。
    const hasInitialTextPosition = Number.isFinite(initial.mainOffset);
    const initialMainOffset = hasInitialTextPosition
      ? splitOffsetNearTextPosition(main.text, initial.mainOffset, mainMode)
      : splitOffsetNearTime(main, initialTime, mainMode);
    const initialMainCutMs = fixedCutMs ?? (hasMainWordTimestamps
      ? splitTimeForTextOffset(main, initialMainOffset)
      : splitCutTime(main, initialMainOffset, false));
    const initialOffset = window.AsrEditorUtils.nearestSubtitleSplitOffset(
      extension.text, initialMainCutMs, extension.start, extension.end, extensionMode,
    );
    return {
      kind: 'linked',
      mainIndex,
      mainId: main.id,
      extensionId: extension.id,
      trackId: track.id,
      mainMode,
      mainInteractive: !useMainWordTimestamps,
      mainTimestampLocked: useMainWordTimestamps,
      mainOffset: initialMainOffset,
      mainCutMs: initialMainCutMs,
      offset: initialOffset,
      // 联动拆分只有一个绝对切点；副轨的 offset 只负责选择文字边界。
      cutMs: initialMainCutMs,
      extensionCutMs: initialMainCutMs,
      extensionMode,
      fixedCutMs,
      feedbackPoint: initial.feedbackPoint || null,
      // 列表/编辑区唤起的弹窗提交后，刀光保留在列表原位置而不是波形切点。
      ninjaFromList: initial.ninjaFromList === true,
      cutSource: fixedCutMs != null
        ? 'pointer'
        : useMainWordTimestamps
          ? 'word-timestamps'
          : hasMainWordTimestamps ? 'word-timestamps-default' : 'text-estimate',
      initialLane: hasInitialTextPosition ? 'main' : null,
      locked: false,
    };
  }



  function mainWaveformSplitState(mainIndex, initial = {}) {
    const main = MaweBoot.DATA.segments[mainIndex];
    if (!main) return null;
    const mainMode = MaweMultiSubtitleCore.getMainSubtitleSplitMode(main);
    const hasMainWordTimestamps = window.AsrEditorUtils.hasUsableSplitTimestamps(main);
    const initialTime = Number.isFinite(initial.timeMs)
      ? initial.timeMs
      : splitTimeForTextOffset(main, initial.mainOffset ?? Math.floor(String(main.text || '').length / 2));
    const fixedCutMs = Number.isFinite(initial.timeMs) ? Math.round(initial.timeMs) : null;
    const initialOffset = splitOffsetNearTime(main, initialTime, mainMode);
    if (initialOffset == null) return null;
    return {
      kind: 'main',
      mainIndex,
      mainId: main.id,
      offset: initialOffset,
      mainOffset: initialOffset,
      mainCutMs: fixedCutMs ?? (hasMainWordTimestamps
        ? splitTimeForTextOffset(main, initialOffset)
        : splitCutTime(main, initialOffset, false)),
      feedbackPoint: initial.feedbackPoint || null,
      mainMode,
      fixedCutMs,
      cutSource: fixedCutMs != null
        ? 'pointer'
        : hasMainWordTimestamps ? 'word-timestamps-default' : 'text-estimate',
      locked: false,
    };
  }



  function extensionOnlySplitState(extensionIndex, track, initial = {}) {
    const extension = track?.segments?.[extensionIndex];
    if (!extension || !track) return null;
    // 副字幕独立拆分同样要求总时长能容纳两侧各 100ms；不足时提交必然失败，
    // 直接提示原因，不再打开只会静默失败的弹窗。
    if (extension.end - extension.start < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS * 2) {
      MaweHint.flashHint('副字幕总时长不足 200ms，无法拆分', 'warning');
      return null;
    }
    const extensionMode = MaweMultiSubtitleCore.getExtensionSubtitleSplitMode(track, extension);
    const hasInitialTextPosition = Number.isFinite(initial.extensionOffset);
    const initialTime = Number.isFinite(initial.timeMs)
      ? initial.timeMs
      : splitTimeForTextOffset(extension, initial.extensionOffset ?? Math.floor(String(extension.text || '').length / 2));
    const fixedCutMs = Number.isFinite(initial.timeMs) ? Math.round(initial.timeMs) : null;
    const initialOffset = hasInitialTextPosition
      ? splitOffsetNearTextPosition(extension.text, initial.extensionOffset, extensionMode)
      : window.AsrEditorUtils.nearestSubtitleSplitOffset(
        extension.text, initialTime, extension.start, extension.end, extensionMode,
      );
    if (!Number.isInteger(initialOffset)) return null;
    return {
      kind: 'extension',
      mainIndex: -1,
      extensionIndex,
      extensionId: extension.id,
      trackId: track.id,
      offset: initialOffset,
      extensionCutMs: fixedCutMs ?? splitTimeForTextOffset(extension, initialOffset),
      feedbackPoint: initial.feedbackPoint || null,
      // 列表/编辑区唤起的弹窗提交后，刀光保留在列表原位置而不是波形切点。
      ninjaFromList: initial.ninjaFromList === true,
      extensionMode,
      fixedCutMs,
      cutSource: fixedCutMs != null ? 'pointer' : 'text-estimate',
      locked: false,
    };
  }



  function splitLaneElements(lane) {
    return lane === 'main'
      ? { laneEl: MaweDom.multiSubtitleSplitMainLane, textEl: MaweDom.multiSubtitleSplitMainText }
      : { laneEl: MaweDom.multiSubtitleSplitExtensionLane, textEl: MaweDom.multiSubtitleSplitText };
  }



  function splitLaneLocked(state, lane) {
    return state?.lockedLanes?.[lane] === true;
  }



  function splitLaneUsesMainTimestamp(state, lane) {
    return lane === 'main' && state?.kind === 'linked' && state.mainTimestampLocked === true;
  }



  // 键盘可交互：⌚️ 时间码锚定的主轨和已用 Space/点击锁定的 lane 不响应移动键。
  function splitLaneKeyboardInteractive(state, lane) {
    return !splitLaneUsesMainTimestamp(state, lane) && !splitLaneLocked(state, lane);
  }



  function splitLaneSegment(state, lane) {
    if (lane === 'main') return state?.mainIndex >= 0 ? MaweBoot.DATA.segments[state.mainIndex] : null;
    return MaweMultiSubtitleCore.extensionSegmentById(state?.extensionId, MaweMultiSubtitleCore.getExtensionTrack(state?.trackId));
  }



  // 左右移动：在当前 lane 的合法断点序列中前进/后退一步。
  function stepSplitLaneOffset(state, lane, direction) {
    const segment = splitLaneSegment(state, lane);
    const mode = lane === 'main' ? state?.mainMode : state?.extensionMode;
    const current = lane === 'main' ? state?.mainOffset : state?.offset;
    const offsets = window.AsrEditorUtils.subtitleSplitOffsets(segment?.text || '', mode);
    if (!offsets.length) return null;
    if (direction < 0) {
      for (let index = offsets.length - 1; index >= 0; index -= 1) {
        if (offsets[index] < current) return offsets[index];
      }
      return null;
    }
    return offsets.find((offset) => offset > current) ?? null;
  }



  // 上下移动：按渲染后的视觉行定位。gap 元素样式一致，同一行的 top 相同；
  // 行距约等于 line-height（36px），用远小于行距的容差聚类即可。
  const SPLIT_LANE_LINE_TOLERANCE_PX = 10;



  function splitLaneGapLines(textEl) {
    return Array.from(textEl.querySelectorAll('.multi-subtitle-split-gap'))
      .map((gap) => {
        const rect = gap.getBoundingClientRect();
        return { gap, midX: rect.left + rect.width / 2, midY: rect.top + rect.height / 2 };
      })
      .sort((left, right) => left.midY - right.midY || left.midX - right.midX)
      .reduce((lines, entry) => {
        const current = lines[lines.length - 1];
        if (current && Math.abs(entry.midY - current.midY) <= SPLIT_LANE_LINE_TOLERANCE_PX) {
          current.entries.push(entry);
          return lines;
        }
        lines.push({ midY: entry.midY, entries: [entry] });
        return lines;
      }, []);
  }



  // 上下移动：目标行上取与当前断点水平距离最近的 gap；单行或越界时返回 null。
  function verticalSplitLaneOffset(state, lane, direction) {
    const { textEl } = splitLaneElements(lane);
    if (!textEl) return null;
    const lines = splitLaneGapLines(textEl);
    if (lines.length < 2) return null;
    const currentOffset = lane === 'main' ? state?.mainOffset : state?.offset;
    let anchor = lines.flatMap((line) => line.entries)
      .find((entry) => Number(entry.gap.dataset.offset) === currentOffset);
    if (!anchor) {
      // 当前断点没有 gap 元素（如文字开头）时退回字符锚点，用行中点估算所在行。
      const charRect = Array.from(textEl.querySelectorAll('.multi-subtitle-split-char'))
        .find((char) => Number(char.dataset.offset) === currentOffset)
        ?.getBoundingClientRect();
      if (!charRect) return null;
      const anchorMidY = charRect.top + charRect.height / 2;
      const nearestLine = lines.reduce((best, line) => (
        Math.abs(line.midY - anchorMidY) < Math.abs(best.midY - anchorMidY) ? line : best
      ), lines[0]);
      const target = lines[lines.indexOf(nearestLine) + direction];
      if (!target) return null;
      const anchorMidX = charRect.left + charRect.width / 2;
      const picked = target.entries.reduce((best, entry) => (
        Math.abs(entry.midX - anchorMidX) < Math.abs(best.midX - anchorMidX) ? entry : best
      ), target.entries[0]);
      return picked ? Number(picked.gap.dataset.offset) : null;
    }
    const target = lines[lines.findIndex(
      (line) => line.entries.includes(anchor),
    ) + direction];
    if (!target) return null;
    const picked = target.entries.reduce((best, entry) => (
      Math.abs(entry.midX - anchor.midX) < Math.abs(best.midX - anchor.midX) ? entry : best
    ), target.entries[0]);
    return picked ? Number(picked.gap.dataset.offset) : null;
  }



  // 键盘操作的 lane：优先看真实焦点，失焦（如点到复选框）时回退到上次记录。
  function splitKeyboardActiveLane(state) {
    if (document.activeElement === MaweDom.multiSubtitleSplitMainText) return 'main';
    if (document.activeElement === MaweDom.multiSubtitleSplitText) return 'extension';
    return state?.keyboardLane || null;
  }



  function splitLaneVisible(lane) {
    const { laneEl } = splitLaneElements(lane);
    return Boolean(laneEl && !laneEl.hidden);
  }



  function focusSplitLane(state, lane) {
    const { textEl } = splitLaneElements(lane);
    if (!textEl || !splitLaneVisible(lane)) return false;
    textEl.focus({ preventScroll: true });
    if (state) state.keyboardLane = lane;
    return true;
  }



  // Tab 在主/副 lane 间切换：仅在联动模式且主轨可交互时可用。
  function splitKeyboardSwitchLane(state, current) {
    if (state?.kind !== 'linked') return null;
    if (splitLaneUsesMainTimestamp(state, 'main')) return null;
    if (current === 'main') return 'extension';
    if (current === 'extension') return 'main';
    return 'main';
  }



  // Space 与鼠标点击同语义：锁定当前断点；再按一次解锁以便继续移动。
  function toggleSplitLaneKeyboardLock(state, lane) {
    if (state !== pendingLinkedSplit || !state.lockedLanes) return;
    if (splitLaneUsesMainTimestamp(state, lane)) return;
    state.lockedLanes[lane] = !splitLaneLocked(state, lane);
    updateLinkedSplitLockVisual();
    if (!splitLaneLocked(state, lane)) return;
    const submitted = maybeAutoSubmitLinkedSplit(state);
    // 键盘锁定后自动聚焦下一条未锁定的 lane（若有），WASD/空格 可连续操作；
    // 自动提交已接管或弹窗已关闭（提交成功）时不再移动焦点。
    if (submitted || state !== pendingLinkedSplit) return;
    const nextLane = splitKeyboardSwitchLane(state, lane);
    if (nextLane && !splitLaneLocked(state, nextLane)) focusSplitLane(state, nextLane);
  }



  // 已锁定的 lane 上按移动键：闪烁边缘并提示先解锁再移动。
  function flashSplitLaneBlockedFeedback(lane) {
    const { textEl } = splitLaneElements(lane);
    if (textEl) {
      textEl.classList.remove('lane-move-blocked');
      void textEl.offsetWidth; // 强制重排，让动画可以重新触发
      textEl.classList.add('lane-move-blocked');
      textEl.addEventListener('animationend', () => {
        textEl.classList.remove('lane-move-blocked');
      }, { once: true });
    }
    MaweHint.flashHint('请先按空格解除锁定，然后再进行移动', 'invalid');
  }



  function syncLinkedSplitTime(state, activeLane, main, extension) {
    if (state?.kind !== 'linked' || !main || !extension) return;

    // 默认的主轨字词时间码是固定锚点；关闭该设置后，未锁定的当前 lane
    // 才能推动共享切点。另一条 lane 的文字 offset 随共享时间吸附到最近合法边界。
    const absoluteFixed = Number.isFinite(state.fixedCutMs);
    const mainFixed = !state.mainInteractive || splitLaneLocked(state, 'main');
    const extensionFixed = splitLaneLocked(state, 'extension');
    let cutMs = state.cutMs;
    if (absoluteFixed) {
      cutMs = state.fixedCutMs;
    } else if (mainFixed) {
      cutMs = state.mainCutMs;
    } else if (extensionFixed) {
      cutMs = state.extensionCutMs;
    } else {
      const source = activeLane === 'main' ? main : extension;
      const sourceOffset = activeLane === 'main' ? state.mainOffset : state.offset;
      cutMs = activeLane === 'main'
        && window.AsrEditorUtils.hasUsableSplitTimestamps(main)
        ? splitTimeForTextOffset(main, sourceOffset)
        : splitCutTime(source, sourceOffset, false);
    }
    if (!Number.isFinite(cutMs)) return;

    const sharedCutMs = Math.round(cutMs);
    state.cutMs = sharedCutMs;
    state.mainCutMs = sharedCutMs;
    state.extensionCutMs = sharedCutMs;

    if (!absoluteFixed && activeLane === 'main' && !extensionFixed) {
      const extensionOffset = window.AsrEditorUtils.nearestSubtitleSplitOffset(
        extension.text, sharedCutMs, extension.start, extension.end, state.extensionMode,
      );
      if (Number.isInteger(extensionOffset)) state.offset = extensionOffset;
    } else if (!absoluteFixed && activeLane === 'extension' && !mainFixed) {
      const mainOffset = window.AsrEditorUtils.nearestSubtitleSplitOffset(
        main.text, sharedCutMs, main.start, main.end, state.mainMode,
      );
      if (Number.isInteger(mainOffset)) state.mainOffset = mainOffset;
    }
  }



  function splitCutTime(segment, offset, useWordTimestamps = false) {
    if (useWordTimestamps) return Math.round(splitTimeForTextOffset(segment, offset));
    const textLength = Math.max(1, String(segment?.text || '').length);
    return Math.round(Number(segment?.start || 0)
      + ((Number(segment?.end || 0) - Number(segment?.start || 0)) * Number(offset || 0)) / textLength);
  }



  function setSplitPreviewLine(label, parts) {
    const row = document.createElement('div');
    row.className = 'multi-subtitle-split-preview-line';
    const labelEl = document.createElement('span');
    labelEl.className = 'multi-subtitle-split-preview-label';
    labelEl.textContent = `${label}：`;
    const left = document.createElement('span');
    left.className = 'multi-subtitle-split-preview-left';
    left.textContent = parts.left;
    const separator = document.createElement('span');
    separator.className = 'multi-subtitle-split-preview-separator';
    separator.textContent = ' / ';
    const right = document.createElement('span');
    right.className = 'multi-subtitle-split-preview-right';
    right.textContent = parts.right;
    row.append(labelEl, left, separator, right);
    MaweDom.multiSubtitleSplitPreview.appendChild(row);
  }



  function updateSplitLaneVisual(state, lane) {
    const { textEl } = splitLaneElements(lane);
    if (!textEl) return;
    const offset = lane === 'main' ? state?.mainOffset : state?.offset;
    const timestampLocked = splitLaneUsesMainTimestamp(state, lane);
    textEl.classList.toggle('timestamp-locked', timestampLocked);
    textEl.querySelectorAll('.multi-subtitle-split-char').forEach((character) => {
      const charOffset = Number(character.dataset.offset || 0);
      character.classList.toggle('split-left', charOffset <= offset);
      character.classList.toggle('split-right', charOffset > offset);
    });
    textEl.querySelectorAll('.multi-subtitle-split-gap').forEach((gap) => {
      gap.classList.toggle('active', Number(gap.dataset.offset) === offset);
      gap.classList.toggle('timestamp-locked', timestampLocked);
    });
  }



  function renderSplitLane(state, lane) {
    const { laneEl, textEl } = splitLaneElements(lane);
    if (!laneEl || !textEl) return;
    const main = MaweBoot.DATA.segments[state?.mainIndex];
    const track = MaweMultiSubtitleCore.getExtensionTrack(state?.trackId);
    const extension = MaweMultiSubtitleCore.extensionSegmentById(state?.extensionId, track);
    const isMain = lane === 'main';
    const displaySegment = isMain ? main : extension;
    const displayMode = isMain ? state?.mainMode : state?.extensionMode;
    const timestampLocked = splitLaneUsesMainTimestamp(state, lane);
    const heading = laneEl.querySelector('h4');
    if (heading) {
      const headingText = timestampLocked
        ? '⌚️ 主字幕按时间码会拆在这里'
        : isMain ? '主字幕拆分' : '副字幕拆分';
      heading.textContent = window.MAWE_I18N?.translateText?.(headingText) || headingText;
    }
    laneEl.classList.toggle('timestamp-locked-lane', timestampLocked);
    const visible = Boolean(displaySegment) && (isMain
      ? state?.kind === 'main' || state?.mainInteractive || timestampLocked
      : state?.kind !== 'main');
    laneEl.hidden = !visible;
    if (!visible) return;
    textEl.replaceChildren();
    textEl.classList.toggle('timestamp-locked', timestampLocked);
    const legalOffsets = new Set(window.AsrEditorUtils.subtitleSplitOffsets(displaySegment.text, displayMode));
    const characters = Array.from(displaySegment.text || '');
    let offset = 0;
    const appendCharacter = (character, characterOffset) => {
      const characterSpan = document.createElement('span');
      characterSpan.className = 'multi-subtitle-split-char';
      characterSpan.dataset.offset = String(characterOffset);
      characterSpan.textContent = character;
      textEl.appendChild(characterSpan);
    };
    const appendGap = (splitOffset, whitespace = '', extraClass = '') => {
      const gap = document.createElement('span');
      gap.className = 'multi-subtitle-split-gap';
      if (extraClass) gap.classList.add(extraClass);
      gap.dataset.offset = String(splitOffset);
      if (timestampLocked) {
        gap.setAttribute('aria-disabled', 'true');
      } else {
        gap.setAttribute('role', 'button');
        gap.setAttribute('aria-label', `在第 ${splitOffset} 个字符后拆分`);
      }
      // 保留原始空白；只有当前选中的断点通过 CSS 将这个空白替换成剪刀。
      gap.textContent = whitespace;
      textEl.appendChild(gap);
    };
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index];
      if (/\s/u.test(character)) {
        let runEnd = index;
        let runOffset = offset + character.length;
        while (runEnd + 1 < characters.length && /\s/u.test(characters[runEnd + 1])) {
          runEnd += 1;
          runOffset += characters[runEnd].length;
        }
        if (legalOffsets.has(runOffset)) {
          appendGap(runOffset, characters.slice(index, runEnd + 1).join(''));
        }
        else {
          for (let whitespaceIndex = index; whitespaceIndex <= runEnd; whitespaceIndex += 1) {
            offset += characters[whitespaceIndex].length;
            appendCharacter(characters[whitespaceIndex], offset);
          }
        }
        if (legalOffsets.has(runOffset)) offset = runOffset;
        else offset = runOffset;
        index = runEnd;
        continue;
      }
      if (displayMode === 'word' && window.AsrEditorUtils.isWordSplitConnector(character)) {
        let runEnd = index;
        let runOffset = offset + character.length;
        while (
          runEnd + 1 < characters.length
          && window.AsrEditorUtils.isWordSplitConnector(characters[runEnd + 1])
        ) {
          runEnd += 1;
            runOffset += characters[runEnd].length;
        }
        if (!legalOffsets.has(offset) && !legalOffsets.has(runOffset)) {
          for (let connectorIndex = index; connectorIndex <= runEnd; connectorIndex += 1) {
            offset += characters[connectorIndex].length;
            appendCharacter(characters[connectorIndex], offset);
          }
        } else {
          // 符号本身是独立 token；前一个普通字符后的 gap 已由上方逻辑插入，
          // 这里保留符号，并在符号之后插入另一个零宽断点。
          for (let connectorIndex = index; connectorIndex <= runEnd; connectorIndex += 1) {
            offset += characters[connectorIndex].length;
            appendCharacter(characters[connectorIndex], offset);
          }
          if (legalOffsets.has(runOffset)) appendGap(runOffset, '', 'connector-gap');
        }
        offset = runOffset;
        index = runEnd;
        continue;
      }
      offset += character.length;
      appendCharacter(character, offset);
      if (legalOffsets.has(offset)) {
        const nextCharacter = characters[index + 1];
        const connectorGap = displayMode === 'word'
          && window.AsrEditorUtils.isWordSplitConnector(nextCharacter);
        appendGap(offset, '', connectorGap ? 'connector-gap' : '');
      }
    }
    if (timestampLocked) {
      textEl.setAttribute('aria-label', '主字幕按时间码拆分位置，不可交互');
      textEl.setAttribute('aria-readonly', 'true');
      textEl.setAttribute('aria-disabled', 'true');
      textEl.setAttribute('tabindex', '-1');
      textEl.title = '主字幕按时间码拆分于此处，不可交互';
      textEl.onmousemove = null;
      textEl.onclick = null;
    } else {
      textEl.removeAttribute('aria-readonly');
      textEl.removeAttribute('aria-disabled');
      textEl.setAttribute('tabindex', '0');
      textEl.setAttribute('aria-label', isMain ? '选择主字幕拆分点' : '选择副字幕断点');
      textEl.title = '鼠标移动选择拆分点，左键点击锁定；也可用 WASD/方向键移动，空格确认或取消';
      textEl.onmousemove = (event) => {
        if (splitLaneLocked(pendingLinkedSplit, lane)) return;
        const target = event.target;
        const gap = target?.closest?.('.multi-subtitle-split-gap');
        if (gap && textEl.contains(gap)) {
          updateLinkedSplitPreview(Number(gap.dataset.offset), lane);
          return;
        }
        const rawOffset = MaweInlineEdit.caretCharFromPoint(textEl, event.clientX, event.clientY);
        if (rawOffset != null) updateLinkedSplitPreview(rawOffset, lane);
      };
      textEl.onclick = (event) => {
        const current = pendingLinkedSplit;
        if (!current) return;
        if (splitLaneLocked(current, lane)) {
          current.lockedLanes[lane] = false;
          updateLinkedSplitLockVisual();
          return;
        }
        const target = event.target;
        const gap = target?.closest?.('.multi-subtitle-split-gap');
        const rawOffset = gap && textEl.contains(gap)
          ? Number(gap.dataset.offset)
          : MaweInlineEdit.caretCharFromPoint(textEl, event.clientX, event.clientY);
        if (rawOffset != null) updateLinkedSplitPreview(rawOffset, lane);
        current.lockedLanes[lane] = true;
        updateLinkedSplitLockVisual();
        maybeAutoSubmitLinkedSplit(current);
      };
    }
    updateSplitLaneVisual(state, lane);
  }



  function renderLinkedSplitText(state) {
  if (!state) return;
  state.lockedLanes = { main: false, extension: false };
  if (MaweDom.multiSubtitleSplitTimestampHint) {
    MaweDom.multiSubtitleSplitTimestampHint.hidden = state.mainTimestampLocked !== true;
  }
  if (MaweDom.multiSubtitleSplitTitle) {
    MaweDom.multiSubtitleSplitTitle.textContent = state.kind === 'main'
      ? '选择主字幕拆分点'
      : state.kind === 'extension'
        ? '选择副字幕拆分点'
        : state.kind === 'overlay'
          ? '选择叠加字幕拆分点'
          : state.mainInteractive
            ? '分别选择主字幕和副字幕拆分点'
            : '主字幕按时间码定位，选择副字幕拆分点';
  }
  renderSplitLane(state, 'main');
  renderSplitLane(state, 'extension');
  const initialLane = state.initialLane || (state.kind === 'main'
    ? 'main'
    : state.kind === 'extension'
      ? 'extension'
      : state.mainInteractive ? 'main' : 'extension');
  updateLinkedSplitPreview(
    state.kind === 'main' ? state.mainOffset
      : state.kind === 'extension' ? state.offset : state.mainOffset,
    initialLane,
  );
  // 弹窗打开即聚焦初始 lane，让 WASD/方向键/Space 直接可用；
  // ⌚️ 时间码锚定的主轨不可交互，回落到副轨。
  state.keyboardLane = splitLaneUsesMainTimestamp(state, initialLane) ? 'extension' : initialLane;
  focusSplitLane(state, state.keyboardLane);
}



  function updateLinkedSplitLockVisual() {
    const state = pendingLinkedSplit;
    const mainLocked = splitLaneLocked(state, 'main');
    const extensionLocked = splitLaneLocked(state, 'extension');
    MaweDom.multiSubtitleSplitMainText?.classList.toggle('locked', mainLocked);
    MaweDom.multiSubtitleSplitText?.classList.toggle('locked', extensionLocked);
    [
      ['main', MaweDom.multiSubtitleSplitMainText],
      ['extension', MaweDom.multiSubtitleSplitText],
    ].forEach(([lane, textEl]) => {
      if (!textEl) return;
      const timestampLocked = splitLaneUsesMainTimestamp(state, lane);
      textEl.classList.toggle('locked', !timestampLocked && splitLaneLocked(state, lane));
      textEl.title = timestampLocked
        ? '主字幕按时间码拆分于此处，不可交互'
        : splitLaneLocked(state, lane)
          ? '拆分点已锁定，点击或按空格解锁'
          : '鼠标移动选择拆分点，左键点击锁定；也可用 WASD/方向键移动，空格确认或取消';
      textEl.querySelectorAll('.multi-subtitle-split-gap').forEach((gap) => {
        gap.classList.toggle(
          'locked',
          !timestampLocked && splitLaneLocked(state, lane) && gap.classList.contains('active'),
        );
      });
    });
    MaweDom.multiSubtitleSplitPreview?.classList.toggle('locked', mainLocked || extensionLocked);
  }



  function isSplitAutoSubmitEnabled() {
    return MaweDom.multiSubtitleSplitAutoSubmit
      ? MaweDom.multiSubtitleSplitAutoSubmit.checked
      : MaweSettings.EDITOR_SETTINGS.splitAutoSubmit;
  }



  function splitAutoSubmitReady(state) {
  if (!state?.valid) return false;
  if (state.kind === 'main') return splitLaneLocked(state, 'main');
  if (state.kind === 'extension' || state.kind === 'overlay') {
    return splitLaneLocked(state, 'extension');
  }
  // 字词时间码已固定主轨切点时，主轨没有可交互的确认步骤。
  const mainReady = !state.mainInteractive || splitLaneLocked(state, 'main');
  return mainReady && splitLaneLocked(state, 'extension');
}



  function maybeAutoSubmitLinkedSplit(state) {
    if (state !== pendingLinkedSplit || !isSplitAutoSubmitEnabled() || !splitAutoSubmitReady(state)) {
      return false;
    }
    confirmLinkedSplit();
    return true;
  }



  function splitCutSourceHint(state) {
    if (state?.cutSource === 'pointer') return '当前切分位置固定为波形指针位置';
    if (state?.cutSource === 'word-timestamps') return '当前切分位置由字词时间码推定';
    if (state?.cutSource === 'word-timestamps-default') return '默认位置参考主字幕字词时间码，可继续调整';
    return '';
  }



  function renderSplitMeta(text, state) {
    if (!MaweDom.multiSubtitleSplitMeta) return;
    MaweDom.multiSubtitleSplitMeta.replaceChildren();
    MaweDom.multiSubtitleSplitMeta.appendChild(document.createTextNode(text));
    const hint = splitCutSourceHint(state);
    if (!hint) return;
    const hintEl = document.createElement('span');
    hintEl.className = 'multi-subtitle-split-cut-hint';
    const translatedHint = window.MAWE_I18N?.translateText?.(hint) || hint;
    hintEl.textContent = `（${translatedHint}）`;
    MaweDom.multiSubtitleSplitMeta.appendChild(hintEl);
  }



  function updateLinkedSplitPreview(offset, lane = 'extension') {
  const state = pendingLinkedSplit;
  if (!state) return false;
  const track = splitStateTrack(state);
  const main = state.mainIndex >= 0 ? MaweBoot.DATA.segments[state.mainIndex] : null;
  const extension = MaweMultiSubtitleCore.extensionSegmentById(state.extensionId, track);
  const mainOnly = state.kind === 'main';
  const extensionOnly = state.kind === 'extension' || state.kind === 'overlay';
  if ((!mainOnly && !extensionOnly && !main) || (!mainOnly && !extension)) return false;

  if (lane === 'main' && main) {
    const requestedOffset = Math.max(0, Math.min(String(main.text || '').length, Math.round(Number(offset) || 0)));
    const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(main.text, state.mainMode);
    if (!legalOffsets.length) return false;
    state.mainOffset = legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - requestedOffset) < Math.abs(best - requestedOffset) ? candidate : best
    ), legalOffsets[0]);
    const mainHasWordTimestamps = MULTI_SUBTITLE_UTILS.hasUsableSplitTimestamps(main);
    state.mainCutMs = Number.isFinite(state.fixedCutMs)
      ? state.fixedCutMs
      : mainHasWordTimestamps
        ? splitTimeForTextOffset(main, state.mainOffset)
        : splitCutTime(main, state.mainOffset, false);
  } else if (extension) {
    const requestedOffset = Math.max(
      0,
      Math.min(String(extension.text || '').length, Math.round(Number(offset) || 0)),
    );
    const legalOffsets = MULTI_SUBTITLE_UTILS.subtitleSplitOffsets(extension.text, state.extensionMode);
    if (!legalOffsets.length) return false;
    state.offset = legalOffsets.reduce((best, candidate) => (
      Math.abs(candidate - requestedOffset) < Math.abs(best - requestedOffset) ? candidate : best
    ), legalOffsets[0]);
    state.extensionCutMs = Number.isFinite(state.fixedCutMs)
      ? state.fixedCutMs : splitCutTime(extension, state.offset, false);
  }

  if (state.kind === 'linked') syncLinkedSplitTime(state, lane, main, extension);

  const mainMode = state.mainMode || (main && MaweMultiSubtitleCore.getMainSubtitleSplitMode(main));
  const mainParts = main
    ? MULTI_SUBTITLE_UTILS.splitSubtitleText(main.text, state.mainOffset, mainMode)
    : null;
  const extensionParts = extension
    ? MULTI_SUBTITLE_UTILS.splitSubtitleText(extension.text, state.offset, state.extensionMode)
    : null;
  const mainTextValid = !main || Boolean(mainParts);
  const extensionTextValid = !extension || Boolean(extensionParts);
  const mainTimingValid = !main || Boolean(mainParts
    && state.mainCutMs - main.start >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
    && main.end - state.mainCutMs >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS);
  const extensionTimingValid = !extension || Boolean(extensionParts
    && state.extensionCutMs - extension.start >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
    && extension.end - state.extensionCutMs >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS);
  const mainValid = mainTextValid && mainTimingValid;
  const extensionValid = extensionTextValid && extensionTimingValid;
  const valid = mainValid && extensionValid;
  const textValid = mainTextValid && extensionTextValid;
  const forceSegments = [main, extension].filter(Boolean);
  state.cutMs = extensionOnly ? state.extensionCutMs : state.mainCutMs;
  state.textValid = textValid;
  state.timingValid = mainTimingValid && extensionTimingValid;
  state.mainTimingValid = Boolean(mainTimingValid);
  state.forceCutMs = textValid
    ? forceSplitCutForSegments(forceSegments, state.cutMs)
    : null;
  state.forceEligible = textValid && !state.timingValid && Number.isFinite(state.forceCutMs);
  // 联动模式下，副轨无法形成合法拆分（文本断点非法，或最短 100ms 钳制也救不回来）、
  // 而主轨自身仍可拆时，允许降级为「只拆主轨并解除绑定」，避免主轨被副轨阻塞。
  state.mainOnlyFallbackEligible = false;
  if (state.kind === 'linked' && main && extension && mainTextValid && !valid && !state.forceEligible) {
    const mainRescuable = mainTimingValid
      || Number.isFinite(forceSplitCutForSegments([main], state.mainCutMs));
    const extensionRescuable = extensionTextValid && (extensionTimingValid
      || Number.isFinite(forceSplitCutForSegments([extension], state.extensionCutMs)));
    state.mainOnlyFallbackEligible = mainRescuable && !extensionRescuable;
  }
  if (valid) state.forceSplitArmed = false;
  state.valid = valid;
  updateSplitLaneVisual(state, 'main');
  updateSplitLaneVisual(state, 'extension');
  if (MaweDom.multiSubtitleSplitMeta) {
    if (mainOnly) {
      renderSplitMeta(`主轨：${MaweMultiSubtitleCore.splitModeLabel(state.mainMode)} · 切点 ${MaweCueElements.fmtShort(state.mainCutMs)} · 字符位置 ${state.mainOffset ?? '—'}`, state);
    } else if (extensionOnly) {
      renderSplitMeta(`副轨：${MaweMultiSubtitleCore.splitModeLabel(state.extensionMode)} · 切点 ${MaweCueElements.fmtShort(state.extensionCutMs)}`, state);
    } else {
      const mainLabel = state.mainTimestampLocked
        ? `⌚️主轨时间码锚点 ${MaweCueElements.fmtShort(state.mainCutMs)}`
        : state.mainInteractive
          ? `主轨文字断点 ${state.mainOffset ?? '—'}`
          : `主轨字词锚点 ${MaweCueElements.fmtShort(state.mainCutMs)}`;
      renderSplitMeta(`${mainLabel} · 副轨文字断点 ${state.offset ?? '—'} · 共用绝对切点 ${MaweCueElements.fmtShort(state.cutMs)}`, state);
    }
  }
  if (MaweDom.multiSubtitleSplitPreview) {
    MaweDom.multiSubtitleSplitPreview.replaceChildren();
    if (mainParts && !extensionOnly) setSplitPreviewLine('主', mainParts);
    if (extensionParts && !mainOnly) setSplitPreviewLine('副', extensionParts);
    if (!mainValid || !extensionValid) {
      const error = document.createElement('div');
      error.textContent = '当前断点无法形成两段合法文本';
      MaweDom.multiSubtitleSplitPreview.appendChild(error);
    }
  }
  if (MaweDom.multiSubtitleSplitError) {
    MaweDom.multiSubtitleSplitError.textContent = valid ? '' : (state.mainOnlyFallbackEligible
      ? '副字幕无法在当前切点形成合法拆分；确认后只拆分主字幕，并解除与副字幕的绑定。'
      : extensionOnly
        ? '副字幕切点必须为两侧各留至少 100ms。'
        : '主字幕和副字幕切点都必须为两侧各留至少 100ms。');
  }
  if (MaweDom.multiSubtitleSplitConfirm) {
    MaweDom.multiSubtitleSplitConfirm.disabled = !valid && !state.mainOnlyFallbackEligible;
  }
  updateLinkedSplitLockVisual();
  return valid;
}



  function closeLinkedSplitModal() {
    MaweDom.multiSubtitleSplitModal?.classList.remove('show');
    [MaweDom.multiSubtitleSplitMainText, MaweDom.multiSubtitleSplitText].forEach((textEl) => {
      textEl?.classList.remove('locked');
      textEl?.removeAttribute('title');
    });
    MaweDom.multiSubtitleSplitPreview?.classList.remove('locked');
    pendingLinkedSplit = null;
  }



  function openMainWaveformSplitModal(mainIndex, timeMs) {
    const state = mainWaveformSplitState(mainIndex, { timeMs });
    if (!state) {
      MaweHint.flashHint('这条字幕没有可用的文字边界', 'invalid');
      return false;
    }
    state.feedbackPoint = MaweCoreState.waveformEditor?.getSplitPointAtTime?.(timeMs, 'main') || null;
    pendingLinkedSplit = state;
    MaweDom.multiSubtitleSplitModal?.classList.add('show');
    renderLinkedSplitText(state);
    return true;
  }



  function openExtensionSplitModal(
    extensionIndex,
    timeMs,
    track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
    initial = {},
  ) {
    const state = extensionOnlySplitState(extensionIndex, track, { timeMs, ...initial });
    if (!state) {
      MaweHint.flashHint('这条副字幕没有可用的文字边界', 'invalid');
      return false;
    }
    state.feedbackPoint = state.feedbackPoint
      || MaweCoreState.waveformEditor?.getSplitPointAtTime?.(timeMs, 'extension') || null;
    pendingLinkedSplit = state;
    MaweDom.multiSubtitleSplitModal?.classList.add('show');
    renderLinkedSplitText(state);
    return true;
  }



  function commitMainWaveformSplit(state, { force = false, successMessage = '已按选择的断点拆分主字幕' } = {}) {
    // 波形入口可能是在当前字幕面板仍有未提交编辑时触发；先完成面板编辑，
    // 再为“拆分”建立快照，确保一次撤销能回到拆分前的完整字幕状态。
    MaweCuePanel.commitCuePanelEdit();
    const mainIndex = state.mainIndex;
    const main = MaweBoot.DATA.segments[mainIndex];
    if (!main) return false;
    const splitMs = force
      ? forceSplitCutForSegments([main], state.cutMs)
      : state.cutMs;
    if (!Number.isFinite(splitMs)) {
      MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
      return false;
    }
    const pair = buildSplitPair(
      main,
      state.mainOffset,
      splitMs,
      main.id || `main-${mainIndex}`,
      true,
      state.mainMode,
      {
        preserveCutMs: force || Number.isFinite(state.fixedCutMs),
        forceCut: force,
      },
    );
    if (!pair) return false;
    const oldMainId = main.id;
    MaweHistory.pushUndo('拆分字幕', { captureView: true });
    MaweSelection.clearSelection({ commitCuePanel: false });
    MaweMultiSubtitleCore.removeBindingsForSegmentIds([oldMainId], []);
    MaweBoot.DATA.segments.splice(mainIndex, 1, pair.left, pair.right);
    for (let index = mainIndex + 2; index < MaweBoot.DATA.segments.length; index++) {
      const segment = MaweBoot.DATA.segments[index];
      if (segment.sticker_ref?.headIdx > mainIndex) segment.sticker_ref.headIdx += 1;
      if (segment.color_ref?.headIdx > mainIndex) segment.color_ref.headIdx += 1;
    }
    if (pair.left.sticker) pair.right.sticker_ref = { name: pair.left.sticker.name, headIdx: mainIndex };
    if (pair.left.color) pair.right.color_ref = { name: pair.left.color.name, headIdx: mainIndex };
    MaweMultiSubtitleCore.markMainSegmentsDirty([pair.left, pair.right]);
    MaweCueElements.rememberTemporaryVisibleSplitCues({ mainSegments: [pair.left, pair.right] });
    closeLinkedSplitModal();
    MaweCuePanel.renderAll();
    MaweSelection.selectOnly(mainIndex + 1);
    MaweSelection.lastClickedIdx = mainIndex + 1;
    MawePlaybackLoop.updateWithoutCueListAutoScroll();
    flashSplitFeedback({
      index: mainIndex,
      track: 'main',
      splitMs,
      feedbackPoint: null,
      listFeedback: false,
    });

    // 弹窗提交的刀光位置由唤起来源决定：列表唤起留在列表，其余落在波形最终切点。
    MaweNinja.triggerNinjaSplitFeedback(MaweNinja.ninjaModalSplitPoint(state, splitMs, 'main'));
    if (successMessage) MaweHint.flashHint(successMessage, 'success');
    return true;
  }



  // 降级路径：副轨无法形成合法拆分时，只拆主轨并解除与副字幕的绑定。
  function commitLinkedSplitMainOnly(state) {
    const main = MaweBoot.DATA.segments[state.mainIndex];
    if (!main) return false;
    let force = false;
    if (!state.mainTimingValid) {
      const mainForceCutMs = forceSplitCutForSegments([main], state.mainCutMs);
      if (!Number.isFinite(mainForceCutMs)) {
        MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
        return false;
      }
      if (!state.forceSplitArmed) {
        state.forceSplitArmed = true;
        MaweHint.flashHint(forcedSplitRetryHint(), 'warning');
        return false;
      }
      force = true;
      state.cutMs = mainForceCutMs;
      state.mainCutMs = mainForceCutMs;
    }
    const committed = commitMainWaveformSplit(state, { force, successMessage: null });
    if (!committed) return false;
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweHint.flashHint('由于副字幕无法在当前切点形成合法拆分，为了拆分主字幕，已解除绑定', 'warning');
    return true;
  }



  function commitExtensionSplit(state, { force = false } = {}) {
    const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
    const extensionIndex = track?.segments?.findIndex((segment) => segment.id === state.extensionId) ?? -1;
    const extension = track?.segments?.[extensionIndex];
    if (!track || extensionIndex < 0 || !extension) return false;
    const splitMs = force
      ? forceSplitCutForSegments([extension], state.extensionCutMs)
      : state.extensionCutMs;
    if (!Number.isFinite(splitMs)) {
      MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
      return false;
    }
    const pair = buildSplitPair(
      extension,
      state.offset,
      splitMs,
      extension.id || `${track.id}-segment-${extensionIndex}`,
      true,
      state.extensionMode,
      {
        preserveCutMs: force || Number.isFinite(state.fixedCutMs),
        forceCut: force,
      },
    );
    if (!pair) return false;

    const oldExtensionId = extension.id;
    const wasBound = Boolean(MaweMultiSubtitleCore.bindingForExtensionIndex(extensionIndex, track));
    MaweHistory.pushUndo('拆分副字幕', { captureView: true });
    // 一对一绑定无法让一个主段同时指向拆出的两条副轨段；独立拆分后
    // 保留两条副字幕，但解除旧关系，等待用户按需要重新绑定。
    MaweMultiSubtitleCore.removeBindingsForSegmentIds([], [oldExtensionId]);
    track.segments.splice(extensionIndex, 1, pair.left, pair.right);
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweCueElements.rememberTemporaryVisibleSplitCues({
      extensionSegments: [pair.left, pair.right],
      extensionTrackId: track.id,
    });
    closeLinkedSplitModal();
    MaweSelection.clearSelection({ commitCuePanel: false });
    MaweCuePanel.renderAll();
    MaweSelection.selectOnlyExtension(extensionIndex + 1);
    MaweSelection.lastClickedExtensionIdx = extensionIndex + 1;
    MawePlaybackLoop.updateWithoutCueListAutoScroll();
    flashSplitFeedback({
      index: extensionIndex,
      track: 'extension',
      splitMs,
      feedbackPoint: null,
      listFeedback: false,
    });
    // 弹窗提交的刀光位置由唤起来源决定：列表唤起留在列表，其余落在波形最终切点。
    MaweNinja.triggerNinjaSplitFeedback(MaweNinja.ninjaModalSplitPoint(state, splitMs, 'extension'));
    MaweHint.flashHint(
      wasBound
        ? '已独立拆分副字幕并解除原绑定'
        : '已按选择的断点拆分副字幕',
      'success',
    );
    return true;
  }



  function confirmLinkedSplit() {
  const state = pendingLinkedSplit;
  if (!state) return;
  const previewLane = state.kind === 'main' ? 'main' : 'extension';
  const previewOffset = state.kind === 'main' ? state.mainOffset : state.offset;
  const previewValid = updateLinkedSplitPreview(previewOffset, previewLane);
  let force = false;
  if (!previewValid) {
    // 副轨救不回来而主轨可拆：降级为只拆主轨并解除绑定，主轨不被副轨阻塞。
    if (state.kind === 'linked' && state.mainOnlyFallbackEligible) {
      commitLinkedSplitMainOnly(state);
      return;
    }
    if (!state.textValid) {
      MaweHint.flashHint('当前断点无法把主副字幕文本各拆成两段', 'warning');
      return;
    }
    if (!state.forceEligible) {
      MaweHint.flashHint('字幕总时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
      return;
    }
    if (!state.forceSplitArmed) {
      armForcedSplit(state);
      return;
    }
    force = true;
    state.cutMs = state.forceCutMs;
    state.mainCutMs = state.forceCutMs;
    state.extensionCutMs = state.forceCutMs;
  }
  if (state.kind === 'main') {
    commitMainWaveformSplit(state, { force });
    return;
  }
  if (state.kind === 'extension') {
    commitExtensionSplit(state, { force });
    return;
  }
  if (state.kind === 'overlay') {
    commitOverlaySplit(state, { force });
    return;
  }
  const track = MaweMultiSubtitleCore.getExtensionTrack(state.trackId);
  const mainIndex = state.mainIndex;
  const extensionIndex = track?.segments?.findIndex((segment) => segment.id === state.extensionId) ?? -1;
  const main = MaweBoot.DATA.segments[mainIndex];
  const extension = track?.segments?.[extensionIndex];
  const sharedCutMs = Number(state.cutMs);
  if (!Number.isFinite(sharedCutMs)
      || sharedCutMs !== Number(state.mainCutMs)
      || sharedCutMs !== Number(state.extensionCutMs)) {
    MaweHint.flashHint('主字幕和副字幕必须使用同一个绝对切点', 'warning');
    return;
  }
  const mainPair = buildSplitPair(
    main,
    state.mainOffset,
    sharedCutMs,
    main.id || `main-${mainIndex}`,
    true,
    state.mainMode,
    { preserveCutMs: true, forceCut: force },
  );
  const extensionPair = buildSplitPair(
    extension,
    state.offset,
    sharedCutMs,
    extension.id || `extension-${extensionIndex}`,
    true,
    state.extensionMode,
    { preserveCutMs: true, forceCut: force },
  );
  if (!mainPair || !extensionPair || extensionIndex < 0) {
    // 前置时长检查已拦截常见不可拆场景；这里兜底提示，避免弹窗内按键完全无反应。
    MaweHint.flashHint('当前切点无法同时拆分主副字幕，请调整断点位置', 'warning');
    return;
  }
  const oldMainId = main.id;
  const oldExtensionId = extension.id;
  MaweHistory.pushUndo('联动拆分字幕', { captureView: true });
  MaweMultiSubtitleCore.removeBindingsForSegmentIds([oldMainId], [oldExtensionId]);
  MaweBoot.DATA.segments.splice(mainIndex, 1, mainPair.left, mainPair.right);
  if (track) track.segments.splice(extensionIndex, 1, extensionPair.left, extensionPair.right);
  // 主轨数组增加了一项，沿用原有表情包/颜色 headIdx 维护规则。
  for (let index = mainIndex + 2; index < MaweBoot.DATA.segments.length; index++) {
    const segment = MaweBoot.DATA.segments[index];
    if (segment.sticker_ref?.headIdx > mainIndex) segment.sticker_ref.headIdx += 1;
    if (segment.color_ref?.headIdx > mainIndex) segment.color_ref.headIdx += 1;
  }
  if (mainPair.left.sticker) mainPair.right.sticker_ref.headIdx = mainIndex;
  if (mainPair.left.color) mainPair.right.color_ref.headIdx = mainIndex;
  const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
  multi.bindings.push(
    MULTI_SUBTITLE_UTILS.buildSubtitleBinding(mainPair.left, extensionPair.left, track.id),
    MULTI_SUBTITLE_UTILS.buildSubtitleBinding(mainPair.right, extensionPair.right, track.id),
  );
  multi.enabled = true;
  MaweMultiSubtitleCore.markMainSegmentsDirty([mainPair.left, mainPair.right]);
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweCueElements.rememberTemporaryVisibleSplitCues({
    mainSegments: [mainPair.left, mainPair.right],
    extensionSegments: [extensionPair.left, extensionPair.right],
    extensionTrackId: track.id,
  });
  closeLinkedSplitModal();
  MaweSelection.clearSelection({ commitCuePanel: false });
  MaweCuePanel.renderAll();
  MaweSelection.selectOnly(mainIndex);
  MaweSelection.lastClickedIdx = mainIndex;
  MawePlaybackLoop.updateWithoutCueListAutoScroll();
  flashSplitFeedback({
    index: mainIndex,
    track: 'main',
    splitMs: sharedCutMs,
    feedbackPoint: null,
    listFeedback: false,
  });
  flashSplitFeedback({
    index: extensionIndex,
    track: 'extension',
    splitMs: sharedCutMs,
    feedbackPoint: null,
    listFeedback: false,
  });
  // 联动拆分刀光位置由唤起来源决定：列表唤起留在列表，其余落在主轨波形切点。
  MaweNinja.triggerNinjaSplitFeedback(MaweNinja.ninjaModalSplitPoint(state, sharedCutMs, 'main'));
  MaweHint.flashHint('已按同一绝对时间切点联动拆分', 'success');
}



  function splitAtCursor(
    feedbackPoint = null,
    { listFeedback = true, cueListAnchor: suppliedCueListAnchor = null } = {},
  ) {
    if (!MaweInlineEdit.editingState) return false;
    const force = MaweInlineEdit.editingState.forceSplitArmed === true;
    const { el, idx, textEl } = MaweInlineEdit.editingState;
    const sel = window.getSelection();
    if (!sel.rangeCount) {
      MaweInlineEdit.finishEdit(false);
      return false;
    }
    const range = sel.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(textEl);
    preRange.setEnd(range.startContainer, range.startOffset);
    const cursorOffset = preRange.toString().length;
    const fullText = textEl.innerText.replace(/\r\n?/g, '\n');
    const ninjaFeedbackPoint = feedbackPoint || MaweNinja.ninjaSplitPointFromRange(
      range, textEl, cursorOffset, fullText.length,
    );
    const seg = MaweBoot.DATA.segments[idx];

    if (MaweMultiSubtitleCore.multiSubtitleVisible() && MaweMultiSubtitleCore.bindingForMainIndex(idx)) {
      MaweInlineEdit.finishEdit(false);
      pendingLinkedSplit = linkedSplitState(idx, {
        mainOffset: cursorOffset,
        feedbackPoint: ninjaFeedbackPoint,
        ninjaFromList: true,
      });
      if (!pendingLinkedSplit) return;
      MaweDom.multiSubtitleSplitModal?.classList.add('show');
      renderLinkedSplitText(pendingLinkedSplit);
      return;
    }

    if (cursorOffset <= 0 || cursorOffset >= fullText.length) {
      MaweInlineEdit.finishEdit(false);
      MaweHint.flashHint('光标必须在词与词之间才能拆分', 'invalid');
      return false;
    }

    let leftText = window.AsrEditorUtils.applySplitEdgeTrim(fullText.slice(0, cursorOffset), 'end');
    let rightText = window.AsrEditorUtils.applySplitEdgeTrim(fullText.slice(cursorOffset), 'start');
    if (!leftText || !rightText) {
      MaweInlineEdit.finishEdit(false);
      MaweHint.flashHint('拆分后任一段为空，已取消', 'warning');
      return false;
    }

    // 原字幕总时长不足 200ms 时，无法在原时间范围内让两侧都达到 100ms；
    // 这和“切点靠边、可通过再次按键强制钳制”的情况不同。
    if (seg.end - seg.start < 200) {
      MaweInlineEdit.finishEdit(false);
      MaweHint.flashHint('字幕时长不足 200ms，无法拆分', 'warning');
      return false;
    }

    let itemSplit = splitItemsAtChar(seg, cursorOffset);
    let splitMs = itemSplit.splitMs;
    if (!itemSplit.hasItems || !Number.isFinite(splitMs)) {
      const ratio = cursorOffset / fullText.length;
      const t = seg.start + (seg.end - seg.start) * ratio;
      // 无词级时间码时按光标位置拆分；第一次按键仍保留原始切点，
      // 只有第二次强制拆分才把它钳制到两侧各 100ms 的安全范围。
      splitMs = Math.round(t);
    }
    // 左右两段的结算边界：默认跟随共享切点；词级 items 提供非对称切分
    // （左段停在自家最后一词的 end，右段起自首词的 start）时分别取用。
    // 缺词或缺时间码时两者都保持 splitMs，与旧行为一致。
    let leftEnd = splitMs;
    let rightStart = splitMs;
    const resolveSplitBounds = () => {
      let leftEndMs = Number.isFinite(splitMs) ? splitMs : null;
      let rightStartMs = leftEndMs;
      if (itemSplit && itemSplit.hasItems && Number.isFinite(splitMs)
          && Number.isFinite(itemSplit.leftEndMs)) {
        leftEndMs = itemSplit.leftEndMs;
        rightStartMs = Number.isFinite(itemSplit.rightStartMs)
          ? itemSplit.rightStartMs : leftEndMs;
      }
      leftEnd = leftEndMs ?? NaN;
      rightStart = rightStartMs ?? NaN;
    };
    resolveSplitBounds();
    const timingValid = Number.isFinite(leftEnd) && Number.isFinite(rightStart)
      && leftEnd - seg.start >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS
      && seg.end - rightStart >= MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS;
    if (!timingValid && !force) {
      MaweInlineEdit.editingState.forceSplitArmed = true;
      MaweHint.flashHint(forcedSplitRetryHint(), 'warning');
      return false;
    }
    if (force) {
      const forcedCut = forceSplitCutForSegments([seg], splitMs);
      if (!Number.isFinite(forcedCut)) {
        MaweInlineEdit.finishEdit(false);
        MaweHint.flashHint('字幕时长不足 200ms，无法让拆分后的两侧都达到 100ms', 'warning');
        return false;
      }
      splitMs = forcedCut;
      itemSplit = splitItemsAtChar(
        seg,
        cursorOffset,
        splitMs,
        { preserveCutMs: true, forceCut: true },
      );
      resolveSplitBounds();
      if (Number.isFinite(forcedCut)) {
        // 强制拆分承诺两侧各 >= 100ms：当自然词边界使某一侧过短
        // （如最后一个词紧贴字幕末尾）时，该侧退回用户确认的强制切点，
        // 另一侧保留非对称自然边界。
        if (!Number.isFinite(leftEnd) || leftEnd - seg.start < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS) {
          leftEnd = forcedCut;
        }
        if (!Number.isFinite(rightStart) || seg.end - rightStart < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS) {
          rightStart = forcedCut;
        }
        if (rightStart < leftEnd) rightStart = leftEnd;
      }
    }
    // 字幕列表手工拆分允许用户指定任意字符位置，但时间码必须落在实际 item
    // 的安全范围内；当切点在 item 内时，splitItemsAtChar 已为两侧生成 item 副本。
    // 左右边界已在上文（含强制重试的降级调和）结算完毕，这里直接消费。
    const leftItemsClean = cleanSplitItems(itemSplit.leftItems, 'left');
    const rightItemsClean = cleanSplitItems(itemSplit.rightItems, 'right');

    const leftSeg = {
      id: window.AsrEditorUtils.uniqueStableSegmentId([seg], `${seg.id || `main-${idx}`}-a`, 'main'),
      start: seg.start, end: leftEnd, text: leftText,
      items: leftItemsClean.length ? leftItemsClean : null,
      sticker: seg.sticker || null,
      sticker_ref: seg.sticker_ref || null,
      color: seg.color || null,
      color_ref: seg.color_ref || null,
      disabled: !!seg.disabled,  // 拆分后两段都继承原禁用状态
      _dirty: true,
    };
    const rightSeg = {
      id: window.AsrEditorUtils.uniqueStableSegmentId([seg], `${seg.id || `main-${idx}`}-b`, 'main'),
      start: rightStart, end: seg.end, text: rightText,
      items: rightItemsClean.length ? rightItemsClean : null,
      sticker: null,
      // 如果原 seg 是被引用的 head，右段也成为同一表情包的延续 → 给 ref
      // 如果原 seg 自己是 ref，右段也保持 ref
      sticker_ref: seg.sticker
        ? { name: seg.sticker.name, headIdx: idx }  /* 暂用 idx，下面会修正 */
        : (seg.sticker_ref ? { ...seg.sticker_ref } : null),
      // color 同理：原 seg 是 head → 右段降级为 ref；原 seg 是 ref → 复制 ref
      color: null,
      color_ref: seg.color
        ? { name: seg.color.name, headIdx: idx }
        : (seg.color_ref ? { ...seg.color_ref } : null),
      disabled: !!seg.disabled,  // 拆分后两段都继承原禁用状态
      _dirty: true,
    };

    // renderAll() 会重建整张字幕列表。content-visibility 会在重建后先用估算
    // 行高占位，再为视口附近的行回填真实高度；只保存 scrollTop 无法阻止
    // 当前字幕被累计行高误差顶走。列表来源的拆分因此保存原行的屏幕位置，
    // 重绘后再用左半段恢复这个视觉锚点。
    const cueListAnchor = listFeedback
      ? suppliedCueListAnchor || MaweCueListAnchor.captureCueListVisualAnchor(el)
      : null;

    textEl.removeAttribute('contenteditable');
    el.classList.remove('editing');
    MaweInlineEdit.editingState = null;

    // 拆分会改变 idx；先在任何写入前保存完整快照，再静默清选中，等列表
    // 和波形块覆盖层一次性更新后再选中后半段。这样撤销会恢复原 item 时间。
    MaweHistory.pushUndo('拆分字幕', { captureView: true });
    MaweSelection.clearSelection({ silent: true });
    // 关闭多字幕模式时，绑定关系仍保存在工程中；拆分主轨后旧 ID 不再存在，
    // 只移除这条关系，保留隐藏的副字幕供用户重新绑定。
    MaweMultiSubtitleCore.removeBindingsForSegmentIds([seg.id], []);
    MaweBoot.DATA.segments.splice(idx, 1, leftSeg, rightSeg);

    // 修正所有 *_ref.headIdx：在 idx 之后的引用都右移 1
    // 但 leftSeg 在 idx 位置仍是 head（如果它有 sticker/color），rightSeg 的 ref.headIdx=idx 正好对应 leftSeg
    for (let i = idx + 2; i < MaweBoot.DATA.segments.length; i++) {
      const sref = MaweBoot.DATA.segments[i].sticker_ref;
      if (sref && sref.headIdx > idx) sref.headIdx += 1;
      const cref = MaweBoot.DATA.segments[i].color_ref;
      if (cref && cref.headIdx > idx) cref.headIdx += 1;
    }

    MaweCueElements.rememberTemporaryVisibleSplitCues({ mainSegments: [leftSeg, rightSeg] });
    MaweCuePanel.renderAll({ cueListAnchor });
    MaweSelection.selectOnly(idx + 1);
    // 拆分后后半段是新的视觉选中项，也必须成为 Shift+点击的范围锚点。
    MaweSelection.lastClickedIdx = idx + 1;
    // 列表来源（B 键悬停等）沿用列表光标坐标；编辑区 Ctrl+Enter 等其余来源
    // 统一回退到波形区实际切点位置，波形上找不到时才用编辑区文字坐标。
    MaweNinja.triggerNinjaSplitFeedback(
      (listFeedback ? (feedbackPoint || ninjaFeedbackPoint) : null)
        || MaweCoreState.waveformEditor?.getSplitPointAtTime?.(splitMs, 'main')
        || ninjaFeedbackPoint,
    );
    MawePlaybackLoop.updateWithoutCueListAutoScroll();
    flashSplitFeedback({
      index: idx,
      track: 'main',
      splitMs,
      feedbackPoint: listFeedback ? (feedbackPoint || ninjaFeedbackPoint) : null,
      listFeedback,
    });
    return true;
  }



  function flashCueSplitAt(idx, clientX, track = 'main') {
    if (!Number.isFinite(clientX)) return false;
    const cue = track === 'extension'
      ? MaweCoreState.container.querySelector(
        `.multi-cue-column.extension[data-ext-idx="${idx}"], .cue[data-ext-idx="${idx}"]`,
      )
      : MaweCoreState.container.querySelector(
        `.multi-cue-column.main[data-main-idx="${idx}"], .cue[data-idx="${idx}"]`,
      );
    if (!cue) return false;
    const rect = cue.getBoundingClientRect();
    const marker = document.createElement('span');
    marker.className = 'cue-split-flash';
    // .cue 的绝对定位子元素以 padding box 为坐标原点；rect.left 是 border box，
    // 还要扣掉左边的 3px 状态边框，否则光条会向右压进字形。
    marker.style.left = `${Math.max(0, Math.min(rect.width, clientX - rect.left - cue.clientLeft))}px`;
    cue.appendChild(marker);
    // 先触发布局，再加动画类，确保连续拆分时每个光条都能独立播放。
    void marker.offsetWidth;
    marker.classList.add('is-active');
    let removed = false;
    let timer = 0;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      if (timer) window.clearTimeout(timer);
      marker.remove();
    };
    marker.addEventListener('animationend', cleanup, { once: true });
    timer = window.setTimeout(cleanup, 800);
    return true;
  }



  // 拆分来源可能是字幕列表、当前编辑区或弹窗；只有列表来源有可靠的列表坐标，
  // 其它来源统一回退到波形时间位置。波形反馈只创建一个短暂标记，不参与播放帧刷新。
  function flashSplitFeedback({ index, track = 'main', splitMs, feedbackPoint = null, listFeedback = false } = {}) {
    const timeMs = Number(splitMs);
    const hasListMarker = listFeedback
      && Number.isFinite(feedbackPoint?.clientX)
      && flashCueSplitAt(index, feedbackPoint.clientX, track);
    if (!hasListMarker && Number.isFinite(timeMs)) {
      MaweCoreState.waveformEditor?.flashSplitAtTime?.(timeMs, track);
    }
  }

  global.MaweSplitCore = Object.freeze({
    get pendingLinkedSplit() { return pendingLinkedSplit; },
    set pendingLinkedSplit(v) { pendingLinkedSplit = v; },
    splitTimeForTextOffset,
    shouldUseMainSplitTimestamps,
    notifyMainSplitTimestampFallback,
    splitOffsetNearTime,
    splitOffsetNearTextPosition,
    cleanSplitItems,
    forceSplitCutForSegments,
    forcedSplitRetryHint,
    armForcedSplit,
    splitItemsAtChar,
    buildSplitPair,
    linkedSplitState,
    mainWaveformSplitState,
    extensionOnlySplitState,
    splitLaneElements,
    splitLaneLocked,
    splitLaneUsesMainTimestamp,
    splitLaneKeyboardInteractive,
    splitLaneSegment,
    stepSplitLaneOffset,
    SPLIT_LANE_LINE_TOLERANCE_PX,
    splitLaneGapLines,
    verticalSplitLaneOffset,
    splitKeyboardActiveLane,
    splitLaneVisible,
    focusSplitLane,
    splitKeyboardSwitchLane,
    toggleSplitLaneKeyboardLock,
    flashSplitLaneBlockedFeedback,
    syncLinkedSplitTime,
    splitCutTime,
    setSplitPreviewLine,
    updateSplitLaneVisual,
    renderSplitLane,
    renderLinkedSplitText,
    updateLinkedSplitLockVisual,
    isSplitAutoSubmitEnabled,
    splitAutoSubmitReady,
    maybeAutoSubmitLinkedSplit,
    splitCutSourceHint,
    renderSplitMeta,
    updateLinkedSplitPreview,
    closeLinkedSplitModal,
    openMainWaveformSplitModal,
    openExtensionSplitModal,
    commitMainWaveformSplit,
    commitLinkedSplitMainOnly,
    commitExtensionSplit,
    confirmLinkedSplit,
    splitAtCursor,
    flashCueSplitAt,
    flashSplitFeedback
  });
})(typeof window !== 'undefined' ? window : globalThis);

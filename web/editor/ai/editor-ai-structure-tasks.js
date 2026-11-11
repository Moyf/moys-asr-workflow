// AI 结构任务（M3）：智能合并 / 时间码→字词 / 拆句建议。
// 共同约束：LLM 只产生「内容建议」；一切字幕结构变更（合并、拆分、items 写入）
// 都在前端走既有编辑命令完成，可撤销。任务提交时记录字幕快照（文本+时间范围），
// 回写前逐条核对，任务期间被人工编辑过的条目跳过，绝不静默覆盖人工编辑。
(function initMaweAiStructureTasks(global) {
  'use strict';



  const SPLIT_MARKER = '\u23AA'; // ⎪ U+23AA，与后端 ai-suggest-split 预设提示词约定一致
  const STRUCT_TASK_LABELS = Object.freeze({
    'ai-smart-merge': 'AI 智能合并',
    'ai-suggest-split': 'AI 拆分建议',
    'ai-timecode-items': '时间码→字词',
  });



  // 升序去重的合法下标；结构任务统一按此顺序处理。
  function normalizeTargets(targets = []) {
    const segments = global.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
    return [...new Set(targets)]
      .filter((index) => Number.isInteger(index) && index >= 0 && index < segments.length)
      .sort((a, b) => a - b);
  }



  function collectCues(targets, { withTime = false } = {}) {
    const cues = [];
    for (const index of normalizeTargets(targets)) {
      const segment = global.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments[index];
      const text = String(segment?.text ?? '');
      if (!text.trim()) continue;
      let id = String(segment?.id ?? '').trim();
      if (!id) id = `idx-${index}`;
      const cue = { id, segmentId: segment.id || null, segment, index, text };
      if (withTime) {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        cue.start = start;
        cue.end = end;
        cue.itemsSnapshot = JSON.stringify(segment.items ?? null);
      }
      cues.push(cue);
    }
    return cues;
  }



  function beginStructureTask(kind, payload, onResult) {
    const context = MaweAiTextTasks.captureTaskContext();
    let presented = false;
    const presentResult = (result) => {
      if (!MaweAiTextTasks.taskContextCurrent(context)) return false;
      onResult(result, context);
      presented = true;
      return true;
    };
    return MaweAiTasks.begin(kind, payload, STRUCT_TASK_LABELS[kind] || 'AI 结构任务', {
      beforeComplete: (_isCurrent, result) => presentResult(result),
    }).then((result) => {
      if (!presented && !presentResult(result)) throw new Error('工程或媒体已切换，已丢弃本次 AI 结果');
    });
  }

  function locateCue(cue) {
    const segments = global.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
    const index = cue.segmentId
      ? segments.findIndex((segment) => segment?.id === cue.segmentId)
      : segments.indexOf(cue.segment);
    return index < 0 ? null : { index, segment: segments[index] };
  }

  function splitBindingSnapshot(cue) {
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    const mainTrack = global.AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    const bindings = (multi.bindings || []).filter((binding) => binding?.source?.track_id === mainTrack.id
      && binding?.source?.segment_id === cue.segmentId);
    const targets = bindings.map((binding) => {
      const track = (MaweBoot.DATA.tracks || []).find((item) => item.id === binding.target?.track_id);
      const segment = track?.segments?.find((item) => item.id === binding.target?.segment_id);
      const peers = (multi.bindings || []).filter((item) => item?.target?.track_id === binding.target?.track_id
        && item?.target?.segment_id === binding.target?.segment_id).map((item) => item.source);
      return { source: binding.source, target: binding.target, peers,
        segment: segment && { id: segment.id, text: segment.text, start: segment.start, end: segment.end, items: segment.items } };
    });
    return JSON.stringify(targets);
  }

  function splitBindingState(cue) {
    const current = locateCue(cue);
    if (!current) return 'changed';
    const main = global.AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    const bindings = MaweMultiSubtitleCore.getMultiSubtitleState().bindings || [];
    const matches = bindings.filter((binding) => binding?.source?.track_id === main.id
      && binding?.source?.segment_id === cue.segmentId);
    if (!matches.length) return 'unbound';
    const target = matches[0].target;
    const shared = bindings.filter((binding) => binding?.target?.track_id === target?.track_id
      && binding?.target?.segment_id === target?.segment_id).length > 1;
    const active = MaweMultiSubtitleCore.multiSubtitleVisible?.()
      && MaweMultiSubtitleCore.bindingForMainIndex?.(current.index);
    return matches.length === 1 && !shared && active?.id === matches[0].id && MaweDom.multiSubtitleSplitModal
      ? 'linked' : 'unsupported';
  }

  function presentStructure(kind, cues, result, context) {
    const byId = new Map(cues.map((cue) => [cue.id, cue]));
    const isTiming = kind === 'ai-timecode-items';
    const isSplit = kind === 'ai-suggest-split';
    const values = isTiming ? result?.items || {} : result?.texts || {};
    const describeItems = (items) => Array.isArray(items)
      ? items.map((item) => `${item.text} (${item.start}–${item.end} ms)`).join('  ') : '';
    const rows = cues.map((cue) => ({
      id: cue.id, index: cue.index, start: cue.start, end: cue.end,
      source: cue.text, before: isTiming ? describeItems(JSON.parse(cue.itemsSnapshot)) : cue.text,
      after: isTiming ? describeItems(values[cue.id]) : String(values[cue.id] || ''), checked: true,
    }));
    const refresh = (currentRows) => currentRows.map((row) => {
      const cue = byId.get(row.id);
      const segment = MaweAiTextTasks.taskContextCurrent(context) ? locateCue(cue)?.segment : null;
      let reason = '';
      if (!MaweAiTextTasks.taskContextCurrent(context)) reason = '工程或媒体已切换';
      else if (!segment || segment.text !== cue.text) reason = '原字幕已修改或删除';
      else if (cue.itemsSnapshot !== undefined && (Number(segment.start) !== cue.start || Number(segment.end) !== cue.end
        || JSON.stringify(segment.items ?? null) !== cue.itemsSnapshot)) reason = '字幕时间或字词已修改';
      else if (isSplit && splitBindingSnapshot(cue) !== cue.bindingSnapshot) reason = '副字幕或绑定已修改';
      else if (isSplit && splitBindingState(cue) === 'unsupported') reason = '此绑定暂不能联动拆分';
      else if (!row.after.trim()) reason = '模型未返回有效结果';
      else if (isSplit && parseSplitMarker(cue.text, row.after) == null) reason = '拆分断点不可用';
      else if (!isTiming && !isSplit && row.before === row.after) reason = '没有变化';
      const conflict = Boolean(reason);
      if (!conflict && isSplit && splitBindingState(cue) === 'linked') reason = '需逐条联动拆分';
      return { ...row, reason, conflict };
    });
    const apply = async (selectedRows) => {
      if (!await MaweAiTextTasks.waitForTaskApply(context)) return [];
      const valid = refresh(selectedRows).filter((row) => !row.conflict);
      const chosen = valid.map((row) => byId.get(row.id));
      if (!chosen.length) return [];
      if (isTiming) return applyTimecodeItems(chosen, { ...result, items: Object.fromEntries(chosen.map((cue) => [cue.id, values[cue.id]])) });
      if (isSplit) {
        const unbound = chosen.filter((cue) => splitBindingState(cue) === 'unbound');
        const selected = unbound.length ? unbound : chosen.slice(0, 1);
        return applySplitSuggestions(selected, Object.fromEntries(valid.map((row) => [row.id, row.after])), (id, index) => {
          const row = valid.find((item) => item.id === id);
          const cue = byId.get(id);
          return Boolean(row && cue && locateCue(cue)?.index === index && !refresh([row])[0].conflict);
        });
      }
      return applyMergedPolish(chosen[0], { texts: { [chosen[0].id]: valid[0].after } });
    };
    const label = kind === 'ai-smart-merge' ? '已合并字幕 · AI 润色建议' : STRUCT_TASK_LABELS[kind];
    if (!global.MaweAiPreview?.present({ label, rows, refresh, apply })) throw new Error('无法保存 AI 建议，请先处理已有结果');
  }



  // === 智能合并：先同步合并（既有命令），再用 LLM 修顺合并缝 ===

  function runSmartMerge(targets = []) {
    if (!MaweAiSettings.serverAvailable()) {
      MaweHint.flashHint('AI 功能仅在本地服务器版编辑器可用（当前通过 file:// 打开）', 'invalid');
      return;
    }
    if (MaweAiTasks.active || global.MaweAiPreview?.hasPending()) {
      MaweHint.flashHint('已有 AI 任务进行中，请等它完成或取消后再试', 'invalid');
      return;
    }
    const indexes = normalizeTargets(targets);
    if (indexes.length < 2) {
      MaweHint.flashHint('请至少选择两条字幕进行合并', 'invalid');
      return;
    }
    const parts = collectCues(indexes).map((cue) => cue.text);
    if (parts.length < 2) {
      MaweHint.flashHint('选中的字幕缺少可合并的文本', 'invalid');
      return;
    }
    const segments = global.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments;
    const segmentsBefore = segments.length;
    // 同步合并命令：不连续时内部已提示并直接返回。
    MaweSegmentOps.mergeSegments(indexes);
    const mergedSegment = segments[indexes[0]];
    const shrank = segments.length === segmentsBefore - (indexes.length - 1);
    if (!shrank || !mergedSegment?.id) {
      // 合并未发生（选择不连续等）；mergeSegments 已给出提示。
      return;
    }
    const snapshot = { id: mergedSegment.id, segmentId: mergedSegment.id, index: indexes[0], text: String(mergedSegment.text ?? ''),
      start: Number(mergedSegment.start), end: Number(mergedSegment.end), itemsSnapshot: JSON.stringify(mergedSegment.items ?? null) };
    const lang = MaweAiTextTasks.detectTaskLang([{ text: snapshot.text }]);
    beginStructureTask('ai-smart-merge', {
      mergedId: snapshot.id,
      mergedText: snapshot.text,
      parts,
      lang,
    }, (result, context) => presentStructure('ai-smart-merge', [snapshot], result, context))
      .catch((error) => MaweHint.flashHint(error.message || 'AI 任务失败', 'invalid'));
  }



  function applyMergedPolish(snapshot, result) {
    const polished = typeof result?.texts?.[snapshot.id] === 'string'
      ? result.texts[snapshot.id] : '';
    const segment = locateCue(snapshot)?.segment;
    if (!polished.trim() || !segment || segment.id !== snapshot.id || segment.text !== snapshot.text) {
      const reason = !polished.trim() ? '模型未返回结果' : '字幕已被修改';
      MaweHint.flashHint(`合并已完成；AI 润色未应用（${reason}，可撤销合并）`, 'warning');
      return [];
    }
    if (segment.text === polished) {
      MaweHint.flashHint('合并完成，文本已符合目标', 'success');
      return [];
    }
    MaweCommands.run('AI 智能合并', (command) => {
      const previousText = segment.text;
      segment.text = polished;
      segment._dirty = true;
      const timing = global.AsrEditorUtils.planWordTimingTextSync(segment, previousText);
      if (timing?.items) segment.items = timing.items;
      command.commit({ cueList: true, waveform: 'overlay', preview: 'update' });
      MaweHistory.updateUndoRedoButtons();
      MaweHint.flashHint('已应用 AI 合并润色', 'success');
      if (timing?.warn) {
        MaweHint.flashHint('合并字幕的字词时间码文字未随文本更新，请按需检查', 'warning');
      }
    });
    return [snapshot.id];
  }



  // === 拆分建议：LLM 只给「⎪」断点，结构操作走 split 核心 API ===

  function runSuggestSplit(targets = []) {
    if (!MaweAiSettings.serverAvailable()) {
      MaweHint.flashHint('AI 功能仅在本地服务器版编辑器可用（当前通过 file:// 打开）', 'invalid');
      return;
    }
    const cues = collectCues(targets, { withTime: true });
    if (!cues.length) {
      MaweHint.flashHint('选中字幕没有可处理的文本', 'invalid');
      return;
    }
    const lang = MaweAiTextTasks.detectTaskLang(cues);
    cues.forEach((cue) => { cue.bindingSnapshot = splitBindingSnapshot(cue); });
    beginStructureTask('ai-suggest-split', {
      cues: cues.map(({ id, text }) => ({ id, text })),
      lang,
    }, (result, context) => presentStructure('ai-suggest-split', cues, result, context))
      .catch((error) => MaweHint.flashHint(error.message || 'AI 任务失败', 'invalid'));
  }



  // 标记文本必须与原文逐字符一致（去掉恰好一个 ⎪ 后），否则视为不可靠。
  function parseSplitMarker(originalText, markedText) {
    const text = String(markedText ?? '');
    const first = text.indexOf(SPLIT_MARKER);
    if (first < 0 || text.indexOf(SPLIT_MARKER, first + 1) >= 0) return null;
    if (first <= 0 || first >= originalText.length) return null;
    if (text.slice(0, first) + text.slice(first + SPLIT_MARKER.length) !== originalText) return null;
    // 单词型拆分核心把连续空白后的偏移作为断点；模型也常把标记放在空白前。
    let offset = first;
    while (offset < originalText.length && /\s/u.test(originalText[offset])) offset += 1;
    return offset < originalText.length ? offset : null;
  }



  function applySplitSuggestions(cues, texts, validateBeforeCommit = () => true) {
    const rows = [];
    const notes = [];
    let stale = 0;
    let missing = 0;
    let invalid = 0;
    for (const cue of cues) {
      const marked = typeof texts[cue.id] === 'string' ? texts[cue.id] : '';
      if (!marked) { missing += 1; continue; }
      const current = locateCue(cue);
      const segment = current?.segment;
      if (!segment || segment.text !== cue.text) { stale += 1; continue; }
      const offset = parseSplitMarker(cue.text, marked);
      if (offset == null) { invalid += 1; continue; }
      rows.push({ id: cue.id, index: current.index, segment, offset });
    }
    const mainTrack = global.AsrEditorUtils.getMainTrack(MaweBoot.DATA);
    const bindings = MaweMultiSubtitleCore.getMultiSubtitleState().bindings || [];
    const bindingsFor = (row) => bindings.filter((binding) => binding?.source?.track_id === mainTrack.id
      && binding?.source?.segment_id === row.segment.id);
    if (rows.length === 1) {
      const row = rows[0];
      const matches = bindingsFor(row);
      const target = matches[0]?.target;
      const sharedTarget = target && bindings.filter((binding) => binding?.target?.track_id === target.track_id
        && binding?.target?.segment_id === target.segment_id).length > 1;
      const activeBinding = MaweMultiSubtitleCore.multiSubtitleVisible?.()
        && MaweMultiSubtitleCore.bindingForMainIndex?.(row.index);
      if (matches.length === 1 && !sharedTarget && activeBinding?.id === matches[0].id
        && MaweDom.multiSubtitleSplitModal) {
        if (MaweSplitCore.pendingLinkedSplit || MaweDom.multiSubtitleSplitModal.classList.contains('show')) {
          MaweHint.flashHint('请先关闭当前拆分窗口，再重试 AI 拆分建议', 'warning');
          return [];
        }
        const state = MaweSplitCore.linkedSplitState(row.index, { mainOffset: row.offset });
        if (state) {
          MaweSplitCore.pendingLinkedSplit = state;
          const previewToken = global.MaweAiPreview?.token?.();
          state.onAiSplitCommitted = () => global.MaweAiPreview?.consume([row.id], previewToken);
          state.onAiBeforeCommit = () => previewToken === global.MaweAiPreview?.token?.()
            && validateBeforeCommit(row.id, state.mainIndex);
          global.MaweAiPreview?.close();
          MaweDom.multiSubtitleSplitModal.classList.add('show');
          MaweSplitCore.renderLinkedSplitText(state);
          return [];
        }
      }
    }
    // 预构建拆分对（纯读操作）：时长不足等非法切点在命令外剔除。
    const pairs = [];
    let bound = 0;
    for (const row of rows) {
      if (bindingsFor(row).length) { bound += 1; continue; }
      const splitMs = MaweSplitCore.splitTimeForTextOffset(row.segment, row.offset);
      const pair = MaweSplitCore.buildSplitPair(
        row.segment,
        row.offset,
        splitMs,
        row.segment.id || `main-${row.index}`,
        true,
        null,
        {},
      );
      if (pair) pairs.push({ id: row.id, index: row.index, segment: row.segment, pair });
      else invalid += 1;
    }
    if (!pairs.length) {
      if (stale) notes.push(`${stale} 条在任务期间被修改，已跳过`);
      if (missing) notes.push(`${missing} 条模型未返回`);
      if (invalid) notes.push(`${invalid} 条断点不可用`);
      if (bound) notes.push(`${bound} 条已绑定副字幕，请逐条联动拆分`);
      MaweHint.flashHint(`AI 拆分建议${skipHintSuffix(notes)}`, 'invalid');
      return [];
    }
    MaweCommands.run('AI 拆分字幕', (command) => {
      MaweSelection.clearSelection({ commitCuePanel: false });
      const touched = [];
      // 从后往前拆：先处理大下标，避免插入段导致前面的下标位移。
      for (const row of [...pairs].sort((a, b) => b.index - a.index)) {
        MaweSplitCore.replaceSegmentWithSplit(global.AsrEditorUtils.getMainTrack(MaweBoot.DATA).segments, row.index, row.pair);
        touched.push(row.pair.left, row.pair.right);
      }
      MaweMultiSubtitleCore.markMainSegmentsDirty(touched);
      command.commit({ cueList: true });
      MaweSelection.selectOnly(pairs[0].index);
      MaweSelection.lastClickedIdx = pairs[0].index;
      MaweViewUpdates.invalidate({ preview: 'update' });
      if (stale) notes.push(`${stale} 条期间被修改已跳过`);
      if (missing) notes.push(`${missing} 条模型未返回`);
      if (invalid) notes.push(`${invalid} 条断点不可用`);
      if (bound) notes.push(`${bound} 条已绑定副字幕，请逐条联动拆分`);
      MaweHint.flashHint(
        `已按 AI 建议拆分 ${pairs.length} 条字幕${notes.length ? `（${notes.join('；')}）` : ''}`,
        'success',
      );
    });
    return pairs.map(({ id }) => id);
  }



  // === 时间码→字词：本地对齐模型经后端 runner 生成 items，按 id 回写 ===

  function runTimecodeItems(targets = []) {
    if (!MaweAiSettings.serverAvailable()) {
      MaweHint.flashHint('AI 功能仅在本地服务器版编辑器可用（当前通过 file:// 打开）', 'invalid');
      return;
    }
    const config = MaweBoot.SERVER_CONFIG || {};
    if (!config.sourceMediaId || global.MaweProjectMediaInputs?.currentMediaBlobUrl) {
      MaweHint.flashHint('当前编辑器没有绑定媒体，无法做时间码对齐', 'invalid');
      return;
    }
    const cues = collectCues(targets, { withTime: true });
    if (!cues.length) {
      MaweHint.flashHint('选中字幕缺少有效的文本与时间范围', 'invalid');
      return;
    }
    beginStructureTask('ai-timecode-items', {
      cues: cues.map(({ id, text, start, end }) => ({ id, text, start, end })),
      lang: global.AsrEditorUtils.getMainTrack(MaweBoot.DATA).language || '',
      bindingGeneration: typeof config.bindingGeneration === 'number' ? config.bindingGeneration : null,
      sourceMediaId: config.sourceMediaId ?? null,
    }, (result, context) => presentStructure('ai-timecode-items', cues, result, context))
      .catch((error) => MaweHint.flashHint(error.message || 'AI 任务失败', 'invalid'));
  }



  function applyTimecodeItems(cues, result) {
    const itemsById = result?.items && typeof result.items === 'object' ? result.items : {};
    const rows = [];
    const notes = [];
    let stale = 0;
    let missing = 0;
    for (const cue of cues) {
      const items = Array.isArray(itemsById[cue.id]) ? itemsById[cue.id] : null;
      if (!items || !items.length) { missing += 1; continue; }
      const segment = locateCue(cue)?.segment;
      // 文本或时间在任务期间变过的条目跳过：items 按提交时的范围生成。
      if (!segment || segment.text !== cue.text
        || Number(segment.start) !== cue.start || Number(segment.end) !== cue.end
        || JSON.stringify(segment.items ?? null) !== cue.itemsSnapshot) {
        stale += 1;
        continue;
      }
      rows.push({ id: cue.id, segment, items });
    }
    if (!rows.length) {
      if (stale) notes.push(`${stale} 条在任务期间被修改，已跳过`);
      if (missing) notes.push(`${missing} 条对齐失败`);
      MaweHint.flashHint(`时间码→字词${skipHintSuffix(notes)}`, 'invalid');
      return [];
    }
    const timedCount = rows.filter(({ segment }) => segment.items?.length).length;
    if (timedCount) {
      const message = global.MAWE_I18N?.translateText?.('将替换 {count} 条字幕已有的字词时间码。是否继续？')
        || '将替换 {count} 条字幕已有的字词时间码。是否继续？';
      if (!global.confirm(message.replace('{count}', String(timedCount)))) {
        MaweHint.flashHint('已取消应用 AI 字词时间码', 'warning');
        return [];
      }
    }
    MaweCommands.run('时间码→字词', (command) => {
      rows.forEach(({ segment, items }) => {
        segment.items = items.map((item) => ({
          text: String(item.text),
          start: Number(item.start),
          end: Number(item.end),
        }));
        segment._dirty = true;
      });
      command.commit({ cueList: true, waveform: 'overlay' });
      MaweHistory.updateUndoRedoButtons();
      if (stale) notes.push(`${stale} 条期间被修改已跳过`);
      if (missing) notes.push(`${missing} 条对齐失败`);
      MaweHint.flashHint(
        `已为 ${rows.length} 条字幕写入字词时间码${notes.length ? `（${notes.join('；')}）` : ''}`,
        'success',
      );
    });
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    if (warnings.length) {
      console.warn('[ai] 时间码对齐告警：', warnings.join('；'));
    }
    return rows.map(({ id }) => id);
  }



  function skipHintSuffix(notes) {
    return notes.length ? `：${notes.join('；')}` : '：没有需要处理的字幕';
  }



  global.MaweAiStructureTasks = Object.freeze({
    runSmartMerge,
    runSuggestSplit,
    runTimecodeItems,
    collectCues,
  });
})(typeof window !== 'undefined' ? window : globalThis);

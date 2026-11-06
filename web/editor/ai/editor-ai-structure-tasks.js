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
    return [...new Set(targets)]
      .filter((index) => Number.isInteger(index) && index >= 0 && index < MaweBoot.DATA.segments.length)
      .sort((a, b) => a - b);
  }



  function collectCues(targets, { withTime = false } = {}) {
    const cues = [];
    for (const index of normalizeTargets(targets)) {
      const segment = MaweBoot.DATA.segments[index];
      const text = String(segment?.text ?? '').trim();
      if (!text) continue;
      let id = String(segment?.id ?? '').trim();
      if (!id) id = `idx-${index}`;
      const cue = { id, index, text };
      if (withTime) {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        cue.start = start;
        cue.end = end;
      }
      cues.push(cue);
    }
    return cues;
  }



  function beginStructureTask(kind, payload) {
    return MaweAiTasks.begin(kind, payload, STRUCT_TASK_LABELS[kind] || 'AI 结构任务');
  }



  // === 智能合并：先同步合并（既有命令），再用 LLM 修顺合并缝 ===

  function runSmartMerge(targets = []) {
    if (!MaweAiSettings.serverAvailable()) {
      MaweHint.flashHint('AI 功能仅在本地服务器版编辑器可用（当前通过 file:// 打开）', 'invalid');
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
    const segmentsBefore = MaweBoot.DATA.segments.length;
    const firstIdBefore = MaweBoot.DATA.segments[indexes[0]]?.id ?? null;
    // 同步合并命令：不连续时内部已提示并直接返回，这里靠段数与首段 id 判别。
    MaweSegmentOps.mergeSegments(indexes);
    const mergedSegment = MaweBoot.DATA.segments[indexes[0]];
    const shrank = MaweBoot.DATA.segments.length === segmentsBefore - (indexes.length - 1);
    if (!shrank || !mergedSegment?.id || mergedSegment.id === firstIdBefore) {
      // 合并未发生（选择不连续等）；mergeSegments 已给出提示。
      return;
    }
    const snapshot = { id: mergedSegment.id, index: indexes[0], text: String(mergedSegment.text ?? '') };
    const lang = MaweAiTextTasks.detectTaskLang([{ text: snapshot.text }]);
    beginStructureTask('ai-smart-merge', {
      mergedId: snapshot.id,
      mergedText: snapshot.text,
      parts,
      lang,
    }).then(
      (result) => applyMergedPolish(snapshot, result),
      (error) => MaweHint.flashHint(error.message || 'AI 任务失败', 'invalid'),
    );
  }



  function applyMergedPolish(snapshot, result) {
    const polished = typeof result?.texts?.[snapshot.id] === 'string'
      ? result.texts[snapshot.id].trim() : '';
    const segment = MaweBoot.DATA.segments[snapshot.index];
    if (!polished || !segment || segment.id !== snapshot.id || segment.text !== snapshot.text) {
      const reason = !polished ? '模型未返回结果' : '字幕已被修改';
      MaweHint.flashHint(`合并已完成；AI 润色未应用（${reason}，可撤销合并）`, 'warning');
      return;
    }
    if (segment.text === polished) {
      MaweHint.flashHint('合并完成，文本已符合目标', 'success');
      return;
    }
    MaweCommands.run('AI 智能合并', (command) => {
      const previousText = segment.text;
      segment.text = polished;
      segment._dirty = true;
      const staleWordTimings = window.AsrEditorUtils.planWordTimingTextSync(segment, previousText)?.warn ? 1 : 0;
      command.commit({ cueList: true, waveform: 'overlay', preview: 'update' });
      MaweHistory.updateUndoRedoButtons();
      MaweHint.flashHint('已应用 AI 合并润色', 'success');
      if (staleWordTimings) {
        MaweHint.flashHint('合并字幕的字词时间码文字未随文本更新，请按需检查', 'warning');
      }
    });
  }



  // === 拆分建议：LLM 只给「⎪」断点，结构操作走 split 核心 API ===

  function runSuggestSplit(targets = []) {
    if (!MaweAiSettings.serverAvailable()) {
      MaweHint.flashHint('AI 功能仅在本地服务器版编辑器可用（当前通过 file:// 打开）', 'invalid');
      return;
    }
    const cues = collectCues(targets);
    if (!cues.length) {
      MaweHint.flashHint('选中字幕没有可处理的文本', 'invalid');
      return;
    }
    const lang = MaweAiTextTasks.detectTaskLang(cues);
    beginStructureTask('ai-suggest-split', {
      cues: cues.map(({ id, text }) => ({ id, text })),
      lang,
    }).then(
      (result) => applySplitSuggestions(cues, result?.texts && typeof result.texts === 'object' ? result.texts : {}),
      (error) => MaweHint.flashHint(error.message || 'AI 任务失败', 'invalid'),
    );
  }



  // 标记文本必须与原文逐字符一致（去掉恰好一个 ⎪ 后），否则视为不可靠。
  function parseSplitMarker(originalText, markedText) {
    const text = String(markedText ?? '');
    const first = text.indexOf(SPLIT_MARKER);
    if (first < 0 || text.indexOf(SPLIT_MARKER, first + 1) >= 0) return null;
    if (first <= 0 || first >= originalText.length) return null;
    if (text.slice(0, first) + text.slice(first + SPLIT_MARKER.length) !== originalText) return null;
    return first;
  }



  function applySplitSuggestions(cues, texts) {
    const rows = [];
    const notes = [];
    let stale = 0;
    let missing = 0;
    let invalid = 0;
    for (const cue of cues) {
      const marked = typeof texts[cue.id] === 'string' ? texts[cue.id] : '';
      if (!marked) { missing += 1; continue; }
      const segment = MaweBoot.DATA.segments[cue.index];
      if (!segment || segment.text !== cue.text) { stale += 1; continue; }
      const offset = parseSplitMarker(cue.text, marked);
      if (offset == null) { invalid += 1; continue; }
      rows.push({ index: cue.index, segment, offset });
    }
    // 预构建拆分对（纯读操作）：时长不足等非法切点在命令外剔除。
    const pairs = [];
    for (const row of rows) {
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
      if (pair) pairs.push({ index: row.index, segment: row.segment, pair });
      else invalid += 1;
    }
    if (!pairs.length) {
      if (stale) notes.push(`${stale} 条在任务期间被修改，已跳过`);
      if (missing) notes.push(`${missing} 条模型未返回`);
      if (invalid) notes.push(`${invalid} 条断点不可用`);
      MaweHint.flashHint(`AI 拆分建议${skipHintSuffix(notes)}`, 'invalid');
      return;
    }
    MaweCommands.run('AI 拆分字幕', (command) => {
      MaweSelection.clearSelection({ commitCuePanel: false });
      const touched = [];
      // 从后往前拆：先处理大下标，避免插入段导致前面的下标位移。
      for (const row of [...pairs].sort((a, b) => b.index - a.index)) {
        const oldMainId = row.segment.id;
        if (oldMainId) MaweMultiSubtitleCore.removeBindingsForSegmentIds([oldMainId], []);
        MaweSplitCore.replaceSegmentWithSplit(MaweBoot.DATA.segments, row.index, row.pair);
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
      MaweHint.flashHint(
        `已按 AI 建议拆分 ${pairs.length} 条字幕${notes.length ? `（${notes.join('；')}）` : ''}`,
        'success',
      );
    });
  }



  // === 时间码→字词：本地对齐模型经后端 runner 生成 items，按 id 回写 ===

  function runTimecodeItems(targets = []) {
    if (!MaweAiSettings.serverAvailable()) {
      MaweHint.flashHint('AI 功能仅在本地服务器版编辑器可用（当前通过 file:// 打开）', 'invalid');
      return;
    }
    const config = MaweBoot.SERVER_CONFIG || {};
    if (!config.sourceMediaId) {
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
      bindingGeneration: typeof config.bindingGeneration === 'number' ? config.bindingGeneration : null,
      sourceMediaId: config.sourceMediaId ?? null,
    }).then(
      (result) => applyTimecodeItems(cues, result),
      (error) => MaweHint.flashHint(error.message || 'AI 任务失败', 'invalid'),
    );
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
      const segment = MaweBoot.DATA.segments[cue.index];
      // 文本或时间在任务期间变过的条目跳过：items 按提交时的范围生成。
      if (!segment || segment.text !== cue.text
        || Number(segment.start) !== cue.start || Number(segment.end) !== cue.end) {
        stale += 1;
        continue;
      }
      rows.push({ segment, items });
    }
    if (!rows.length) {
      if (stale) notes.push(`${stale} 条在任务期间被修改，已跳过`);
      if (missing) notes.push(`${missing} 条对齐失败`);
      MaweHint.flashHint(`时间码→字词${skipHintSuffix(notes)}`, 'invalid');
      return;
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

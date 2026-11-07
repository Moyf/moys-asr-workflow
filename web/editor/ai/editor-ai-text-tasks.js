// AI 文本任务（M2）：加粗关键词 / 翻译为副字幕 / Emoji 点缀。
// 任务经 MaweAiTasks.begin 提交到后端 runner（maw.editor_ai.run_ai_text_task，
// 与 Launcher 工具箱共用 complete_subtitle_groups 的 JSON 协议）；完成后在前端
// 回写：主字幕文本与副字幕结构变更都走 MaweCommands.run，可撤销。任务提交时
// 附带字幕文本快照，回写前逐条核对，任务期间被人工编辑过的条目跳过。
// 自定义提示词保存在本机浏览器（localStorage），留空使用后端内置预设。
(function initMaweAiTextTasks(global) {
  'use strict';



  const PROMPTS_STORAGE_KEY = 'moy.asr.editor.ai.prompts.v1';
  const TEXT_TASK_KINDS = Object.freeze(['ai-bold', 'ai-translate', 'ai-emoji']);
  const TEXT_TASK_LABELS = Object.freeze({
    'ai-bold': 'AI 加粗关键词',
    'ai-translate': 'AI 翻译为副字幕',
    'ai-emoji': 'AI Emoji 点缀',
  });
  // 中日韩字符占比达到该阈值时按中文提示词处理，否则按英文。
  const CJK_RATIO_THRESHOLD = 0.3;
  const CJK_CHAR_PATTERN = /[\u4e00-\u9fff\u3040-\u30ff\u30a0-\u30ff\uac00-\ud7af]/;



  let customPrompts = readCustomPrompts();



  const element = (id) => document.getElementById(id);



  function readCustomPrompts() {
    const prompts = {};
    for (const kind of TEXT_TASK_KINDS) prompts[kind] = '';
    try {
      const saved = JSON.parse(MaweHost.storage.getItem(PROMPTS_STORAGE_KEY) || '{}');
      for (const kind of TEXT_TASK_KINDS) {
        if (typeof saved[kind] === 'string') prompts[kind] = saved[kind];
      }
    } catch (_) {
      // file:// 隐私模式可能拒绝 localStorage；自定义提示词退回内置预设。
    }
    return prompts;
  }


  function saveCustomPrompts() {
    try {
      MaweHost.storage.setItem(PROMPTS_STORAGE_KEY, JSON.stringify(customPrompts));
    } catch (_) {
      // 保存失败时本次页面仍可用自定义值。
    }
  }



  // === 提示词设置模态 ===

  function fillPromptsModal() {
    const map = {
      'ai-bold': 'ai-prompt-bold',
      'ai-translate': 'ai-prompt-translate',
      'ai-emoji': 'ai-prompt-emoji',
    };
    for (const [kind, inputId] of Object.entries(map)) {
      const input = element(inputId);
      if (input) input.value = customPrompts[kind] || '';
    }
  }


  function openPromptsModal() {
    fillPromptsModal();
    element('ai-prompts-modal')?.classList.add('show');
    setTimeout(() => element('ai-prompt-bold')?.focus(), 50);
  }


  function closePromptsModal() {
    element('ai-prompts-modal')?.classList.remove('show');
  }


  function savePromptsFromModal() {
    const map = {
      'ai-bold': 'ai-prompt-bold',
      'ai-translate': 'ai-prompt-translate',
      'ai-emoji': 'ai-prompt-emoji',
    };
    for (const [kind, inputId] of Object.entries(map)) {
      customPrompts[kind] = String(element(inputId)?.value || '').trim();
    }
    saveCustomPrompts();
    closePromptsModal();
    MaweHint.flashHint('AI 提示词已保存到本机浏览器', 'success');
  }


  function resetPromptsFromModal() {
    for (const kind of TEXT_TASK_KINDS) customPrompts[kind] = '';
    saveCustomPrompts();
    fillPromptsModal();
    MaweHint.flashHint('已恢复内置预设提示词', 'success');
  }


  function wirePromptsModal() {
    element('ai-prompts-cancel')?.addEventListener('click', closePromptsModal);
    element('ai-prompts-save')?.addEventListener('click', savePromptsFromModal);
    element('ai-prompts-reset')?.addEventListener('click', resetPromptsFromModal);
  }


  wirePromptsModal();



  // === 任务构建 ===

  // 收集选中字幕的文本快照；无 id 的段用任务内一致的合成 id。
  // extensionTrack 传入时（翻译任务）同时快照单绑定副字幕的 id+文本（#5）。
  function collectTaskCues(targets = [], extensionTrack = null) {
    const cues = [];
    const seen = new Set();
    for (const target of targets) {
      if (!Number.isInteger(target) || target < 0 || target >= MaweBoot.DATA.segments.length) continue;
      const segment = MaweBoot.DATA.segments[target];
      const text = String(segment?.text ?? '').trim();
      if (!text) continue;
      let id = String(segment?.id ?? '').trim();
      if (!id) id = `idx-${target}`;
      if (seen.has(id)) continue;
      seen.add(id);
      cues.push({ id, index: target, text, extension: snapshotBoundExtension(segment, extensionTrack) });
    }
    return cues;
  }


  function detectTaskLang(cues) {
    let cjk = 0;
    let total = 0;
    for (const cue of cues) {
      for (const char of cue.text) {
        if (/\s/.test(char)) continue;
        total += 1;
        if (CJK_CHAR_PATTERN.test(char)) cjk += 1;
      }
    }
    return total > 0 && cjk / total >= CJK_RATIO_THRESHOLD ? 'zh' : 'en';
  }



  // === 主字幕文本回写（加粗 / Emoji）===

  function applyMainTextResults(kind, cues, texts) {
    const label = TEXT_TASK_LABELS[kind] || 'AI 文本任务';
    const rows = [];
    let stale = 0;
    let missing = 0;
    let unchanged = 0;
    for (const cue of cues) {
      const newText = typeof texts[cue.id] === 'string' ? texts[cue.id].trim() : '';
      if (!newText) { missing += 1; continue; }
      const segment = locateTaskSegment(cue);
      if (!segment) { stale += 1; continue; }
      if (segment.text === newText) { unchanged += 1; continue; }
      rows.push({ segment, text: newText });
    }
    if (!rows.length) {
      const parts = [];
      if (unchanged) parts.push(`${unchanged} 条已符合目标`);
      if (stale) parts.push(`${stale} 条在任务期间被修改，已跳过`);
      if (missing) parts.push(`${missing} 条模型未返回结果`);
      MaweHint.flashHint(parts.length ? `${label}：${parts.join('；')}` : `${label}：没有需要更新的字幕`, 'invalid');
      return;
    }
    MaweCommands.run(label, (command) => {
      let staleWordTimings = 0;
      rows.forEach(({ segment, text }) => {
        const previousText = segment.text;
        segment.text = text;
        segment._dirty = true;
        if (window.AsrEditorUtils.planWordTimingTextSync(segment, previousText)?.warn) staleWordTimings += 1;
      });
      command.commit({ cueList: true, waveform: 'overlay', preview: 'update' });
      MaweHistory.updateUndoRedoButtons();
      const notes = [];
      if (stale) notes.push(`${stale} 条期间被修改已跳过`);
      if (missing) notes.push(`${missing} 条模型未返回`);
      if (unchanged) notes.push(`${unchanged} 条已符合目标`);
      MaweHint.flashHint(
        `${label}已更新 ${rows.length} 条字幕${notes.length ? `（${notes.join('；')}）` : ''}`,
        'success',
      );
      if (staleWordTimings) {
        MaweHint.flashHint(`${staleWordTimings} 条字幕的字词时间码文字未随文本更新，请按需检查`, 'warning');
      }
    });
  }



  // === 副字幕回写（翻译）===

  function ensureMultiSubtitleReady() {
    // v2 的双语开关就是活动副轨的 enabled（没有 bilingual.enabled 字段）：
    // 确保有轨并启用，建轨与 active_track_id 由 utils 负责，脏标记交给命令提交。
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    const track = MaweMultiSubtitleCore.ensureEmptyExtensionTrack(multi);
    track.enabled = true;
    multi._dirty = true;
    return track;
  }


  // v2 绑定没有 extension_segment_ids 字段：主→副一条绑定，同源多条即 1→N 分组。
  function bindingsForMainSegment(multi, segmentId, trackId) {
    return (multi.bindings || []).filter((binding) =>
      binding?.source?.segment_id === segmentId
      && (!trackId || binding?.target?.track_id === trackId));
  }


  // 提交时快照单绑定副字幕的 id+文本，回写前核对，人工改过的不覆盖（#5）。
  function snapshotBoundExtension(segment, track) {
    if (!track) return null;
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    const bindings = bindingsForMainSegment(multi, segment.id, track.id);
    if (bindings.length !== 1) return null;
    const bound = track.segments.find((item) => item?.id === bindings[0].target?.segment_id);
    return bound ? { id: bound.id, text: bound.text } : null;
  }


  // 按稳定 id 定位主字幕并核对文本指纹；无 id 的旧段按下标+指纹兜底。
  // 删除、切工程或文本被改都返回 null，由调用方按 stale 跳过（#4）。
  function locateTaskSegment(cue) {
    const id = String(cue.id || '');
    const segments = MaweBoot.DATA.segments;
    if (id && !id.startsWith('idx-')) {
      const byId = segments.find((segment) => segment?.id === id);
      return byId && byId.text === cue.text ? byId : null;
    }
    const byIndex = segments[cue.index];
    return byIndex && byIndex.text === cue.text ? byIndex : null;
  }


  // 回写前重新判定绑定状态：unbound → 新建；grouped → 跳过；
  // changed → 快照对不上（副字幕被人工改过或绑定变动），跳过。
  function resolveBoundExtension(cue, segment, track) {
    if (!track) return { state: 'unbound' };
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    const bindings = bindingsForMainSegment(multi, segment.id, track.id);
    if (bindings.length > 1) return { state: 'grouped' };
    if (bindings.length === 0) return cue.extension ? { state: 'changed' } : { state: 'unbound' };
    const bound = track.segments.find((item) => item?.id === bindings[0].target?.segment_id) || null;
    if (!bound) return cue.extension ? { state: 'changed' } : { state: 'unbound' };
    const snapshot = cue.extension;
    if (!snapshot || snapshot.id !== bound.id || snapshot.text !== bound.text) return { state: 'changed' };
    return { state: 'bound', bound };
  }


  function insertExtensionSegment(track, segment) {
    const insertAt = track.segments.findIndex((item) => Number(item?.start) > segment.start);
    const index = insertAt < 0 ? track.segments.length : insertAt;
    track.segments.splice(index, 0, segment);
    return index;
  }


  function applyTranslationResults(cues, texts) {
    const label = TEXT_TASK_LABELS['ai-translate'];
    // v2 的双语开关 = 活动副轨的 enabled；未开启也继续处理：
    // create 行在命令内经 ensureMultiSubtitleReady 建轨并启用（#2）。
    const wasEnabled = MaweMultiSubtitleCore.getActiveExtensionTrack()?.enabled === true;
    const track = MaweMultiSubtitleCore.getActiveExtensionTrack();
    const rows = [];
    let stale = 0;
    let missing = 0;
    let unchanged = 0;
    let skippedGrouped = 0;
    let staleExtension = 0;
    for (const cue of cues) {
      const newText = typeof texts[cue.id] === 'string' ? texts[cue.id].trim() : '';
      if (!newText) { missing += 1; continue; }
      const segment = locateTaskSegment(cue);
      if (!segment) { stale += 1; continue; }
      const verdict = resolveBoundExtension(cue, segment, track);
      if (verdict.state === 'grouped') { skippedGrouped += 1; continue; }
      if (verdict.state === 'changed') { staleExtension += 1; continue; }
      if (verdict.state === 'bound') {
        if (verdict.bound.text === newText) { unchanged += 1; continue; }
        rows.push({ kind: 'update', main: segment, extension: verdict.bound, text: newText });
      } else {
        rows.push({ kind: 'create', main: segment, text: newText });
      }
    }
    if (!rows.length) {
      const parts = [];
      if (unchanged) parts.push(`${unchanged} 条副字幕已是该译文`);
      if (stale) parts.push(`${stale} 条在任务期间被修改，已跳过`);
      if (staleExtension) parts.push(`${staleExtension} 条副字幕在任务期间被修改，已跳过`);
      if (missing) parts.push(`${missing} 条模型未返回结果`);
      if (skippedGrouped) parts.push(`${skippedGrouped} 条绑定多条副字幕，已跳过`);
      MaweHint.flashHint(parts.length ? `${label}：${parts.join('；')}` : `${label}：没有需要更新的字幕`, 'invalid');
      return;
    }
    MaweCommands.run(label, (command) => {
      const targetTrack = MaweMultiSubtitleCore.getActiveExtensionTrack()
        || ensureMultiSubtitleReady();
      let updated = 0;
      let created = 0;
      const createdMains = [];
      for (const row of rows) {
        if (row.kind === 'update') {
          row.extension.text = row.text;
          row.extension._dirty = true;
          updated += 1;
          continue;
        }
        if (!targetTrack) continue;
        // 逐条插入后 track.segments 已包含此前新建的段，
        // uniqueStableSegmentId 会自动避开已占用的 id。
        const extension = {
          id: window.AsrEditorUtils.uniqueStableSegmentId(
            targetTrack.segments,
            `${targetTrack.id}-segment-${targetTrack.segments.length + 1}`,
            'extension',
          ),
          start: row.main.start,
          end: row.main.end,
          text: row.text,
          _dirty: true,
        };
        insertExtensionSegment(targetTrack, extension);
        MaweMultiSubtitleCore.addSubtitleBinding(row.main, extension, targetTrack);
        createdMains.push(row.main);
        created += 1;
      }
      if (createdMains.length) MaweMultiSubtitleCore.markMainSegmentsDirty(createdMains);
      MaweMultiSubtitleCore.markMultiSubtitleDirty();
      // 未开启双语时本次同时开启了副轨：波形需要整轨重建。
      command.commit({ cueList: true, waveform: wasEnabled ? 'overlay' : 'full' });
      MaweHistory.updateUndoRedoButtons();
      const parts = [];
      if (updated) parts.push(`更新 ${updated} 条`);
      if (created) parts.push(`新建 ${created} 条`);
      const notes = [];
      if (stale) notes.push(`${stale} 条期间被修改已跳过`);
      if (staleExtension) notes.push(`${staleExtension} 条副字幕在任务期间被修改，已跳过`);
      if (missing) notes.push(`${missing} 条模型未返回`);
      if (unchanged) notes.push(`${unchanged} 条已是该译文`);
      if (skippedGrouped) notes.push(`${skippedGrouped} 条绑定多条副字幕，已跳过`);
      MaweHint.flashHint(
        `${label}：${parts.join('、') || '无变更'}${notes.length ? `（${notes.join('；')}）` : ''}`
        + (wasEnabled ? '' : '；已自动开启双语字幕'),
        'success',
      );
    });
  }



  // === 任务入口 ===

  function runTextTask(kind, targets = []) {
    if (!MaweAiSettings.serverAvailable()) {
      MaweHint.flashHint('AI 功能仅在本地服务器版编辑器可用（当前通过 file:// 打开）', 'invalid');
      return;
    }
    // 翻译任务同时快照单绑定副字幕，供回写前核对人工改动（#5）。
    const extensionTrack = kind === 'ai-translate' ? MaweMultiSubtitleCore.getActiveExtensionTrack() : null;
    const cues = collectTaskCues(targets, extensionTrack);
    if (!cues.length) {
      MaweHint.flashHint('选中字幕没有可处理的文本', 'invalid');
      return;
    }
    const payload = {
      cues: cues.map(({ id, text }) => ({ id, text })),
      lang: detectTaskLang(cues),
      customPrompt: customPrompts[kind] || null,
    };
    const label = TEXT_TASK_LABELS[kind] || 'AI 文本任务';
    // 提交时记录工程/媒体绑定：完成时不一致说明上下文已切换，结果整体丢弃（#4）。
    const taskContext = {
      bindingGeneration: MaweBoot.SERVER_CONFIG?.bindingGeneration ?? null,
      sourceMediaId: MaweBoot.SERVER_CONFIG?.sourceMediaId ?? null,
    };
    MaweAiTasks.begin(kind, payload, label).then(
      (result) => {
        const config = MaweBoot.SERVER_CONFIG || {};
        if ((config.bindingGeneration ?? null) !== taskContext.bindingGeneration
          || (config.sourceMediaId ?? null) !== taskContext.sourceMediaId) {
          MaweHint.flashHint('工程或媒体已切换，已丢弃本次 AI 结果', 'warning');
          return;
        }
        const texts = result && typeof result.texts === 'object' && result.texts ? result.texts : {};
        if (kind === 'ai-translate') applyTranslationResults(cues, texts);
        else applyMainTextResults(kind, cues, texts);
      },
      (error) => MaweHint.flashHint(error.message || 'AI 任务失败', 'invalid'),
    );
  }



  global.MaweAiTextTasks = Object.freeze({
    runTextTask,
    openPromptsModal,
    collectTaskCues,
    detectTaskLang,
    get customPrompts() { return { ...customPrompts }; },
  });
})(typeof window !== 'undefined' ? window : globalThis);

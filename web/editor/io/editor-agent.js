(function initAgentReview() {
  'use strict';
  const core = window.MAWE.resolve('agent-core', { applyTimedTextEdit: window.AsrEditorUtils.applyTimedTextEdit });
  const dialog = document.getElementById('agent-review');
  const report = document.getElementById('agent-review-report');
  const applyButton = document.getElementById('agent-review-apply');
  const fileInput = document.getElementById('agent-proposal-file');
  let pending = null;
  function snapshot({ prepare = false } = {}) {
    if (prepare) MaweProjectSave.flushInlineEditsForSave();
    else if (MaweProjectSave.inlineEditHasUncommittedText()) throw new Error('请完成正在编辑的文字后重新审阅提案');
    // Review must not repair or otherwise mutate the project before the user applies.
    return JSON.parse(MaweJsonRepair.buildJson({ repair: prepare }));
  }
  function errorMessage(error) { MaweHint.flashHint(error.message || 'Agent 提案处理失败', 'invalid'); }
  document.getElementById('agent-export').addEventListener('click', async () => {
    try {
      const project = snapshot({ prepare: true });
      const indices = [...MaweState.selection.indices('main')].sort((a, b) => a - b);
      const selected = indices.map(i => project.segments[i]).filter(Boolean);
      const data = { schema: 'moy.asr.agent.snapshot.v1', project, context: {
        selected_ids: selected.map(s => s.id), selected_indices: indices,
        selected_range: selected.length ? [Math.min(...selected.map(s => s.start)), Math.max(...selected.map(s => s.end))] : null,
        selection_kind: 'main_subtitle_envelope',
      } };
      await MaweExportTimeline.downloadFile(JSON.stringify(data, null, 2), 'project.agent-snapshot.json', 'application/json', undefined, { usePicker: false });
    } catch (error) { errorMessage(error); }
  });
  document.getElementById('agent-import').addEventListener('click', () => fileInput.click());
  document.getElementById('agent-review-cancel').addEventListener('click', () => { pending = null; dialog.close(); });
  dialog.addEventListener('cancel', () => { pending = null; });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error('提案超过 64 MiB');
      const proposal = JSON.parse(await file.text());
      const plan = core.plan(snapshot(), proposal);
      pending = proposal;
      report.replaceChildren();
      const reason = document.createElement('p');
      reason.dataset.agentProjectContent = '';
      reason.textContent = proposal.reason;
      report.append(reason);
      for (const row of plan.rows) {
        const section = document.createElement('section');
        for (const [label, segments] of [['修改前', row.before], ['修改后', row.after]]) {
          const heading = document.createElement('strong');
          heading.textContent = label;
          const text = document.createElement('pre');
          text.dataset.agentProjectContent = '';
          text.style.whiteSpace = 'pre-wrap';
          text.style.overflowWrap = 'anywhere';
          text.style.marginTop = '8px';
          const english = window.MAWE_I18N?.language === 'en';
          text.textContent = segments.map(s => `[${s.start}, ${s.end}) ${s.text}\n${english ? 'Word timings' : '字词'}：${s.items?.length || 0}；${english ? 'Speaker' : '说话人'}：${s.speaker || (english ? 'Unspecified' : '未指定')}`).join('\n\n') || (english ? '(No subtitles)' : '（无字幕）');
          section.append(heading, text);
        }
        report.append(section);
      }
      applyButton.disabled = !plan.changed;
      dialog.showModal();
    } catch (error) { pending = null; errorMessage(error); }
  });
  applyButton.addEventListener('click', () => {
    try {
      const plan = core.plan(snapshot(), pending); // recheck after review, including unsaved edits
      if (!plan.changed) return;
      MaweCommands.run('应用 Agent 提案', () => {
        const changed = new Set(plan.changedIds);
        const live = new Map(MaweBoot.DATA.segments.map(s => [s.id, s]));
        const next = plan.segments.map(s => {
          const existing = live.get(s.id);
          if (!existing) return s;
          if (!changed.has(s.id)) return existing;
          // The snapshot is a persistence projection: keep live-only metadata intact.
          if (pending.operation.type === 'text') return { ...existing, text: s.text, items: s.items || [] };
          return s;
        });
        MaweBoot.DATA.segments.splice(0, MaweBoot.DATA.segments.length, ...next);
        MaweMultiSubtitleCore.markMainSegmentsDirty(MaweBoot.DATA.segments.filter(s => changed.has(s.id)));
        MaweMultiSubtitleCore.syncBindingOffsets();
        MaweTimeline.syncProjectTimebaseAndBindingOffsets(MaweBoot.DATA, { preferFrames: false });
        MaweState.selection.reset();
      }, { invalidate: { cueList: true, waveform: 'full', preview: 'update' } });
      MaweHistory.updateUndoRedoButtons();
      pending = null;
      dialog.close();
      MaweHint.flashHint('已应用 Agent 提案，可撤销；按当前工程保存设置持久化', 'success');
    } catch (error) { errorMessage(error); }
  });
})();

// Keep Phase 1 on the same paths as the editor's existing controls.
export function registerBuiltinCommands(palette, editor, doc) {
  const byId = id => () => doc.getElementById(id);
  const usable = el => !!el && !el.matches(':disabled, [aria-disabled="true"], [hidden]');
  const click = (id, when) => control(byId(id), when);
  function control(get, when = () => true) {
    return { when: () => usable(get()) && when(), run: () => get().click() };
  }
  const seekable = () => editor.MaweCoreState.player?.duration > 0
    && Number.isFinite(editor.MaweCoreState.player.duration);
  const waveform = () => editor.MaweCoreState.waveformEditor;
  const hasWaveform = () => !!waveform();
  const canSaveAs = () => !editor.MaweState.projectLoadPending && !editor.MaweServerSave.projectSaveInFlight
    && !editor.MaweServerSave.projectCheckpointInFlight;
  const canSave = () => canSaveAs() && (editor.MaweServerSave.requiresMigrationSaveAs
    || editor.MaweServerSave.projectSaveTargetEnabled());
  const settings = tab => () => editor.MaweSettingsPanels.openEditorSettingsAtTab(`editor-settings-tab-${tab}`);
  const add = (category, rows) => {
    for (const [id, title, action, shortcut, keywords = []] of rows) {
      palette.register({ id, category, title, shortcut, keywords,
        ...(typeof action === 'function' ? { run: action } : action) });
    }
  };

  add('文件与工程', [
    ['file.new', '新建工程', click('new-project')],
    ['file.open', '打开工程', click('open-project')],
    ['file.save', '保存工程', { when: canSave, run: () => editor.MaweProjectSave.saveCurrentProject() }, 'Ctrl+S'],
    ['file.save-as', '另存为', { when: canSaveAs, run: () => editor.MaweProjectSave.saveProjectAsToFile() }, 'Ctrl+Shift+S'],
    ['file.import-media', '导入媒体', click('load-media')],
    ['file.import-subtitles', '导入字幕', click('load-srt'), null, ['SRT']],
    ['file.import-lyrics', '导入歌词', click('load-lrc'), null, ['LRC']],
    ['file.export', '导出工程', { when: () => usable(byId('download-json')()), run: () => editor.MaweProjectSave.exportProjectToFile() }, null, ['JSON', 'MOSP']],
  ]);
  add('播放与导航', [
    ['playback.toggle', '播放/暂停', click('media-play-toggle', seekable), 'Space'],
    ['playback.back', '后退', click('media-step-back', seekable)],
    ['playback.forward', '前进', click('media-step-forward', seekable)],
    ['playback.start', '跳到开头', { when: seekable, run: () => editor.MaweMediaPlayback.seekMediaTo(0) }],
    ['playback.end', '跳到结尾', { when: seekable, run: () => editor.MaweMediaPlayback.seekMediaTo(editor.MaweCoreState.player.duration) }],
    ['playback.fullscreen', '全屏', click('media-fullscreen')],
  ]);
  add('视图与工具', [
    ['view.select-tool', '选择工具', { when: hasWaveform, run: () => waveform().setTool('select') }, 'V'],
    ['view.razor-tool', '分割工具', { when: hasWaveform, run: () => waveform().setTool('razor') }, 'R', ['razor', '剃刀']],
    ['view.multiline-waveform', '多行波形', control(() => doc.querySelector('[data-waveform-mode="multi"]'))],
    ['view.single-line-waveform', '单行波形', control(() => doc.querySelector('[data-waveform-mode="basic"]'))],
    ['view.bilingual', '双语字幕', click('multi-subtitle-quick-toggle')],
    ['view.overlap', '重叠字幕', click('overlay-quick-toggle')],
    ['view.word-timing', '字词时间码', click('word-timing-quick-toggle'), 'Q'],
    ['view.marker-editing', '标记编辑', click('markers-quick-toggle'), 'M'],
    ['view.follow-playback', '列表跟随播放', click('cue-list-follow')],
    ['view.edit-layout', '编辑布局', click('layout-edit-toggle')],
    ['view.choose-workspace', '选择工作区', { when: () => usable(byId('workspace-preset')()), run: () => {
      const select = byId('workspace-preset')();
      select.focus();
      // Some hosts don't expose a picker API; focusing still allows arrow-key selection.
      try { select.showPicker?.(); } catch { /* Native picker unavailable. */ }
    } }],
  ]);
  add('工具面板', [
    ['panel.gaps', '静音空隙', click('gap-remove-manage')],
    ['panel.markers', '标记与区段', click('markers-manage')],
    ['panel.merge', '拼合字幕', click('auto-merge-manage')],
    ['panel.extend', '延长字幕', click('subtitle-extend-manage')],
    ['panel.volume', '工程音量', click('audio-processing-toggle')],
    ['panel.plain-text', '纯文本编辑', click('timed-text-edit-btn')],
    ['panel.text-process', '字幕处理', click('text-process-btn')],
  ]);
  add('设置与帮助', [
    ['settings.project', '工程设置', click('project-settings-toggle')],
    ['settings.global', '全局设置', click('editor-settings-toggle')],
    ['settings.split-merge', '拆分与合并', settings('split-merge')],
    ['settings.preview', '播放预览', settings('subtitle-preview')],
    ['help.open', '帮助', click('help-toggle')],
    ['help.shortcuts', '快捷操作', () => editor.MaweHelpPanel.openHelpAtTab('shortcuts')],
    ['help.onboarding', '快速上手', click('help-onboarding')],
    ['settings.edit', '编辑设置', click('cue-editor-settings-toggle')],
  ]);
}

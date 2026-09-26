// 拆分模式：快捷键提示、合并/接续模式 UI 与主字幕拆分类型绑定。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweSplitMode 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweSplitMode(global) {
  'use strict';



  function refreshSplitKeyHelp() {
    const label = MaweDisplaySettings.splitKeyLabel();
    if (MaweDom.helpSplitKey) MaweDom.helpSplitKey.textContent = label;
    if (MaweDom.cuePanelSplitKey) MaweDom.cuePanelSplitKey.textContent = label;
    if (MaweDom.cueEditorSplitKey) MaweDom.cueEditorSplitKey.textContent = label;
    if (MaweDom.cueEditorConfirmKey) MaweDom.cueEditorConfirmKey.textContent = MaweDisplaySettings.confirmKeyLabel();
  }


  // 「合并字幕时插入字符」旁的提示：显示当前主字幕拆分类型（自动检测或已指定），
  // 并提供一键切换。手动指定的类型存入 EDITOR_SETTINGS.mainSplitModeOverride
  // （本地偏好，多重字幕开关无关），同时同步 multi_subtitle.main_split_mode，
  // 与多重字幕菜单的「主字幕语言类型」互为镜像。
  const mergeJoinModeHint = document.getElementById('merge-join-mode-hint');


  const mergeJoinModeText = document.getElementById('merge-join-mode-text');


  const mergeJoinModeSwitch = document.getElementById('merge-join-mode-switch');


  function isConfiguredMainSplitModeOverride(value) {
    return value === 'word' || value === 'continuous';
  }


  function refreshMergeJoinModeHint() {
    if (!mergeJoinModeHint || !mergeJoinModeText || !mergeJoinModeSwitch) return;
    const text = MaweBoot.DATA.segments.map((item) => item?.text || '').join('\n');
    if (!text) {
      mergeJoinModeHint.hidden = true;
      return;
    }
    const detected = window.AsrEditorUtils.detectSubtitleSplitMode(text);
    const override = MaweSettings.EDITOR_SETTINGS.mainSplitModeOverride;
    const hasPinned = isConfiguredMainSplitModeOverride(override);
    mergeJoinModeHint.hidden = false;
    // 提示不区分「自动检测」与「手动指定」：统一展示当前生效类型；
    // 用户觉得不对就自己点按钮换。
    const effective = hasPinned ? override : detected;
    const other = effective === 'continuous' ? 'word' : 'continuous';
    mergeJoinModeText.textContent = `当前字幕为「${MaweMultiSubtitleCore.splitModeLabel(effective)}」${MaweMultiSubtitleCore.splitModeExample(effective)}`;
    // 按钮 title 给出目标类型的语言说明，帮助用户选择。
    mergeJoinModeSwitch.textContent = `切换为${MaweMultiSubtitleCore.splitModeLabel(other)}`;
    mergeJoinModeSwitch.title = other === 'word'
      ? '单词型：英语等西文语言，按空格分隔多个单词'
      : '字符型：中文、日文等按字符拆分的语言';
    mergeJoinModeSwitch.dataset.targetMode = other;
  }


  function setMainSubtitleSplitModeBinding(mode) {
    const next = MaweMultiSubtitleCore.isConfiguredSubtitleSplitMode(mode) ? mode : null;
    if (!next || next === MaweSettings.EDITOR_SETTINGS.mainSplitModeOverride) return;
    return MaweCommands.run('切换主字幕语言类型', (command) => {
      // 本地偏好立即生效；工程内的 main_split_mode 同步写入，
      // 保证多重字幕菜单与保存后的工程文件读到同一类型。
      MaweSettings.updateEditorSettings({ mainSplitModeOverride: next });
      MaweMultiSubtitleCore.getMultiSubtitleState().main_split_mode = next;
      MaweMultiSubtitleCore.markMultiSubtitleDirty();
      // renderAll → updateMultiSubtitleUi 会回写多重字幕下拉框并刷新本提示。
      command.commit({ cueList: true, waveform: 'none' });
    });
  }

  global.MaweSplitMode = Object.freeze({
    refreshSplitKeyHelp,
    mergeJoinModeHint,
    mergeJoinModeText,
    mergeJoinModeSwitch,
    isConfiguredMainSplitModeOverride,
    refreshMergeJoinModeHint,
    setMainSubtitleSplitModeBinding
  });
})(typeof window !== 'undefined' ? window : globalThis);

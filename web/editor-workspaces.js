// 工作区：内置与服务器工作区选择、导航持久化与库管理。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweWorkspaces 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweWorkspaces(global) {
  'use strict';



  // === 工作区库：服务器版可把工作区（窗口布局 + 显示状态）保存到本机设置，跨工程复用 ===
  const BUILTIN_WORKSPACE_IDS = window.AsrWaveform?.builtinWorkspaceIds || ['classic', 'wave-right', 'three-fold', 'cinema'];


  let currentServerWorkspaceName = '';


  let currentBuiltinWorkspaceName = '';


  const workspacePresetSelect = document.getElementById('workspace-preset');


  const saveWorkspaceButton = document.getElementById('workspace-save');


  const saveWorkspaceAsButton = document.getElementById('workspace-save-as');


  const deleteWorkspaceButton = document.getElementById('workspace-delete');



  function getSavedServerWorkspaces() {
    return MaweBoot.SERVER_CONFIG?.savedWorkspaces && typeof MaweBoot.SERVER_CONFIG.savedWorkspaces === 'object'
      ? MaweBoot.SERVER_CONFIG.savedWorkspaces : {};
  }



  function getSavedPresetWorkspaces() {
    return MaweBoot.SERVER_CONFIG?.presetWorkspaces && typeof MaweBoot.SERVER_CONFIG.presetWorkspaces === 'object'
      ? MaweBoot.SERVER_CONFIG.presetWorkspaces : {};
  }



  // 覆盖可能只存导航状态（后端自动创建），没有布局数据；只有含 navigation
  // 以外字段的覆盖才能作为布局来源，否则退回内置默认布局。
  function presetWorkspaceHasLayout(workspace) {
    return Boolean(workspace) && Object.keys(workspace).some((key) => key !== 'navigation');
  }



  function currentWorkspaceDisplayName() {
    const selected = workspacePresetSelect?.selectedOptions?.[0];
    return selected?.textContent?.trim() || currentServerWorkspaceName || currentBuiltinWorkspaceName || '当前工作区';
  }



  function refreshWorkspaceSelect() {
    if (!workspacePresetSelect) return;
    const workspaces = getSavedServerWorkspaces();
    workspacePresetSelect.querySelector('optgroup[data-saved-workspaces]')?.remove();
    const names = Object.keys(workspaces).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    if (names.length) {
      const group = document.createElement('optgroup');
      group.label = '已保存工作区';
      group.dataset.savedWorkspaces = 'true';
      names.forEach((name) => group.append(new Option(name, `saved:${name}`)));
      workspacePresetSelect.append(group);
    }
    if (currentServerWorkspaceName && workspaces[currentServerWorkspaceName]) {
      workspacePresetSelect.value = `saved:${currentServerWorkspaceName}`;
    }
  }



  function syncWorkspaceControls() {
    const hasServerLibrary = Boolean(MaweBoot.SERVER_CONFIG?.settingsUrl && MaweCoreState.waveformEditor);
    const isEditing = MaweCoreState.waveformEditor?.isCustomLayout?.() === true;
    const hasCustomWorkspace = Boolean(currentServerWorkspaceName && getSavedServerWorkspaces()[currentServerWorkspaceName]);
    const hasBuiltinWorkspace = Boolean(currentBuiltinWorkspaceName);
    if (saveWorkspaceButton) saveWorkspaceButton.hidden = !hasServerLibrary || !isEditing || (!hasCustomWorkspace && !hasBuiltinWorkspace);
    if (saveWorkspaceAsButton) saveWorkspaceAsButton.hidden = !hasServerLibrary || !isEditing;
    if (deleteWorkspaceButton) deleteWorkspaceButton.hidden = !hasServerLibrary || !isEditing || !hasCustomWorkspace;
  }



  function restoreWorkspaceSelection() {
    const selectedPreset = MaweBoot.DATA.workspace?.selectedPreset;
    if (typeof selectedPreset !== 'string' || !workspacePresetSelect) return;
    if (selectedPreset.startsWith('saved:')) {
      const name = selectedPreset.slice('saved:'.length);
      if (getSavedServerWorkspaces()[name]) {
        currentServerWorkspaceName = name;
        currentBuiltinWorkspaceName = '';
        refreshWorkspaceSelect();
      }
      return;
    }
    if (BUILTIN_WORKSPACE_IDS.includes(selectedPreset)) {
      currentServerWorkspaceName = '';
      currentBuiltinWorkspaceName = selectedPreset;
      workspacePresetSelect.value = selectedPreset;
    }
  }



  async function updateServerWorkspaceSettings(payload) {
    const response = await fetch(MaweBoot.SERVER_CONFIG.settingsUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `服务器返回 ${response.status}`);
    MaweBoot.SERVER_CONFIG.savedWorkspaces = result.savedWorkspaces || {};
    MaweBoot.SERVER_CONFIG.presetWorkspaces = result.presetWorkspaces || {};
    MaweBoot.SERVER_CONFIG.activeWorkspaceName = result.activeWorkspaceName || '';
    MaweBoot.SERVER_CONFIG.autoOpenLastProject = result.autoOpenLastProject !== false;
    return result;
  }



  function currentWorkspaceNavigation() {
    const snapshot = MaweCoreState.waveformEditor?.getNavigationSnapshot?.();
    const cueListScrollTop = Math.max(0, Math.round(Number(MaweCoreState.container?.scrollTop) || 0));
    return {
      ...(snapshot || {}),
      cueListScrollTop,
    };
  }



  async function saveWorkspaceNavigation(target) {
    if (!target || !MaweBoot.SERVER_CONFIG?.settingsUrl || !MaweCoreState.waveformEditor) return;
    const navigation = currentWorkspaceNavigation();
    try {
      const result = await updateServerWorkspaceSettings({
        updateWorkspaceNavigation: { ...target, navigation },
      });
      MaweBoot.SERVER_CONFIG.savedWorkspaces = result.savedWorkspaces || {};
      MaweBoot.SERVER_CONFIG.presetWorkspaces = result.presetWorkspaces || {};
    } catch (error) {
      MaweHint.flashHint(`记住工作区导航失败：${error.message || error}`, 'warning');
    }
  }



  function restoreWorkspaceNavigation(workspace) {
    MaweCoreState.waveformEditor?.restoreNavigation?.(workspace?.navigation);
  }



  async function saveCurrentWorkspace({ saveAs }) {
    if (!MaweCoreState.waveformEditor || !MaweBoot.SERVER_CONFIG?.settingsUrl) return;
    let name = currentServerWorkspaceName;
    if (saveAs) {
      name = prompt('请输入工作区名称：', '我的工作区')?.trim() || '';
      if (!name) return;
    }
    if (!name && !currentBuiltinWorkspaceName) return;
    const displayName = saveAs ? name : currentWorkspaceDisplayName();
    const button = saveAs ? saveWorkspaceAsButton : saveWorkspaceButton;
    if (button) button.disabled = true;
    try {
      const workspace = MaweExportTimeline.buildCurrentWorkspaceData();
      if (saveAs) {
        await updateServerWorkspaceSettings({ saveWorkspace: { name, workspace, overwrite: false } });
        MaweBoot.SERVER_CONFIG.savedWorkspaces = { ...getSavedServerWorkspaces(), [name]: workspace };
        currentServerWorkspaceName = name;
        currentBuiltinWorkspaceName = '';
      } else if (currentServerWorkspaceName) {
        await updateServerWorkspaceSettings({ saveWorkspace: { name, workspace, overwrite: true } });
        MaweBoot.SERVER_CONFIG.savedWorkspaces = { ...getSavedServerWorkspaces(), [name]: workspace };
      } else {
        await updateServerWorkspaceSettings({ savePresetWorkspace: { preset: currentBuiltinWorkspaceName, workspace } });
        MaweBoot.SERVER_CONFIG.presetWorkspaces = { ...getSavedPresetWorkspaces(), [currentBuiltinWorkspaceName]: workspace };
      }
      refreshWorkspaceSelect();
      syncWorkspaceControls();
      MaweHint.flashHint(saveAs ? `已另存工作区：${displayName}` : `已保存工作区：${displayName}`, 'success');
    } catch (error) {
      MaweHint.flashHint(`保存工作区失败：${error.message || error}`, 'warning');
    } finally {
      if (button) button.disabled = false;
    }
  }



  async function deleteCurrentServerWorkspace() {
    const name = currentServerWorkspaceName;
    if (!name || !MaweBoot.SERVER_CONFIG?.settingsUrl || !confirm(`确定删除工作区「${name}」吗？`)) return;
    deleteWorkspaceButton.disabled = true;
    try {
      await updateServerWorkspaceSettings({ deleteWorkspaceName: name });
      currentServerWorkspaceName = '';
      refreshWorkspaceSelect();
      syncWorkspaceControls();
      MaweHint.flashHint(`已删除工作区：${name}`, 'success');
    } catch (error) {
      MaweHint.flashHint(`删除工作区失败：${error.message || error}`, 'warning');
    } finally {
      deleteWorkspaceButton.disabled = false;
    }
  }



  // 应用一次下拉选择：saved:* 从本机库恢复；内置 id 优先用本机覆盖版，否则用默认定义。
  // 工作区 = 窗口布局 + 显示状态，切换时同时恢复该工作区保存的显示开关。
  async function applyWorkspaceSelection(preset) {
    const previousTarget = currentServerWorkspaceName
      ? { name: currentServerWorkspaceName }
      : currentBuiltinWorkspaceName ? { preset: currentBuiltinWorkspaceName } : null;
    if (previousTarget && (preset !== `saved:${currentServerWorkspaceName}`
        && preset !== currentBuiltinWorkspaceName)) {
      await saveWorkspaceNavigation(previousTarget);
    }
    if (preset.startsWith('saved:')) {
      const name = preset.slice('saved:'.length);
      const workspace = getSavedServerWorkspaces()[name];
      if (!workspace) return;
      MaweCoreState.waveformEditor.setLayoutData({ ...workspace, selectedPreset: `saved:${name}` });
      MaweDisplaySettings.applyEditorDisplaySettings(workspace.editorDisplay);
      restoreWorkspaceNavigation(workspace);
      currentServerWorkspaceName = name;
      currentBuiltinWorkspaceName = '';
      refreshWorkspaceSelect();
      syncWorkspaceControls();
      void updateServerWorkspaceSettings({ activeWorkspaceName: name }).catch((error) => {
        MaweHint.flashHint(`记住工作区失败：${error.message || error}`, 'warning');
      });
      MaweHint.flashHint(`已应用工作区：${name}`, 'success');
      return;
    }
    if (!BUILTIN_WORKSPACE_IDS.includes(preset)) return;
    currentServerWorkspaceName = '';
    currentBuiltinWorkspaceName = preset;
    const savedPreset = getSavedPresetWorkspaces()[preset];
    const layoutPreset = presetWorkspaceHasLayout(savedPreset) ? savedPreset : null;
    if (layoutPreset) MaweCoreState.waveformEditor.setLayoutData(layoutPreset);
    else MaweCoreState.waveformEditor.setLayout(preset);
    MaweDisplaySettings.applyEditorDisplaySettings(
      savedPreset?.editorDisplay || window.AsrWaveform?.builtinWorkspaces?.[preset]?.editorDisplay,
    );
    workspacePresetSelect.value = preset;
    restoreWorkspaceNavigation(savedPreset);
    refreshWorkspaceSelect();
    syncWorkspaceControls();
    void updateServerWorkspaceSettings({ activeWorkspaceName: '' }).catch((error) => {
      MaweHint.flashHint(`记住工作区失败：${error.message || error}`, 'warning');
    });
  }



  function configureServerWorkspaceLibrary() {
    if (!MaweBoot.SERVER_CONFIG?.settingsUrl || !MaweCoreState.waveformEditor) return;
    const savedSelection = MaweBoot.DATA.workspace?.selectedPreset;
    currentServerWorkspaceName = typeof savedSelection === 'string' && savedSelection.startsWith('saved:')
      && getSavedServerWorkspaces()[savedSelection.slice('saved:'.length)]
      ? savedSelection.slice('saved:'.length)
      : !savedSelection && getSavedServerWorkspaces()[MaweBoot.SERVER_CONFIG.activeWorkspaceName]
        ? MaweBoot.SERVER_CONFIG.activeWorkspaceName : '';
    const initialPreset = typeof savedSelection === 'string' && !savedSelection.startsWith('saved:')
      ? savedSelection : MaweBoot.DATA.workspace?.preset;
    currentBuiltinWorkspaceName = currentServerWorkspaceName ? ''
      : BUILTIN_WORKSPACE_IDS.includes(initialPreset) ? initialPreset : 'wave-right';
    if (!savedSelection && currentBuiltinWorkspaceName && presetWorkspaceHasLayout(getSavedPresetWorkspaces()[currentBuiltinWorkspaceName])) {
      MaweCoreState.waveformEditor.setLayoutData(getSavedPresetWorkspaces()[currentBuiltinWorkspaceName]);
      if (workspacePresetSelect) workspacePresetSelect.value = currentBuiltinWorkspaceName;
    }
    refreshWorkspaceSelect();
    restoreWorkspaceSelection();
    if (workspacePresetSelect?.dataset.listenersBound !== 'true') {
      workspacePresetSelect?.addEventListener('change', () => applyWorkspaceSelection(workspacePresetSelect.value));
      document.getElementById('layout-edit-toggle')?.addEventListener('click', () => {
        // 拖放编辑只改窗口排列，不改变下拉框当前选中的工作区名称。
        if (currentServerWorkspaceName) refreshWorkspaceSelect();
        else if (currentBuiltinWorkspaceName && workspacePresetSelect) workspacePresetSelect.value = currentBuiltinWorkspaceName;
        syncWorkspaceControls();
      });
      document.getElementById('layout-reset')?.addEventListener('click', () => {
        const preset = currentBuiltinWorkspaceName;
        if (preset) {
          MaweCoreState.waveformEditor.setLayout(preset);
          void updateServerWorkspaceSettings({ resetPresetWorkspace: preset }).then(() => {
            MaweHint.flashHint(`已恢复「${preset}」默认工作区`, 'success');
          }).catch((error) => {
            MaweHint.flashHint(`重置工作区失败：${error.message || error}`, 'warning');
          });
        }
        syncWorkspaceControls();
      });
      saveWorkspaceButton?.addEventListener('click', () => { void saveCurrentWorkspace({ saveAs: false }); });
      saveWorkspaceAsButton?.addEventListener('click', () => { void saveCurrentWorkspace({ saveAs: true }); });
      deleteWorkspaceButton?.addEventListener('click', () => { void deleteCurrentServerWorkspace(); });
      workspacePresetSelect.dataset.listenersBound = 'true';
     }
     const initialWorkspace = currentServerWorkspaceName
       ? getSavedServerWorkspaces()[currentServerWorkspaceName]
       : getSavedPresetWorkspaces()[currentBuiltinWorkspaceName];
     restoreWorkspaceNavigation(initialWorkspace || MaweBoot.DATA.workspace);
     syncWorkspaceControls();
  }



  function configureWorkspaceTransfer() {
    if (!MaweCoreState.waveformEditor) return;
    // 「工作区配置 ▾」在服务器版与单文件版都可用，便于以文件显式备份/迁移工作区。
    const transferDropdown = document.getElementById('workspace-transfer-dropdown');
    const exportButton = document.getElementById('workspace-export');
    const importButton = document.getElementById('workspace-import');
    const importFile = document.getElementById('workspace-import-file');
    if (transferDropdown) transferDropdown.hidden = false;
    exportButton?.addEventListener('click', async () => {
      await MaweExportTimeline.downloadFile(MaweExportTimeline.buildWorkspaceJson(), `${MaweBoot.FILENAME_BASE}.workspace.json`, 'application/json', {
        desc: '编辑器工作区文件', types: { 'application/json': ['.workspace.json', '.json'] },
      });
    });
    importButton?.addEventListener('click', () => {
      if (!importFile) return;
      importFile.value = '';
      importFile.click();
    });
    importFile?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const workspace = data.workspace || data;
        MaweHistory.pushLayoutUndo('导入工作区', MaweCoreState.waveformEditor.getLayoutHistorySnapshot?.());
        MaweCoreState.waveformEditor.setLayoutData(workspace);
        MaweDisplaySettings.applyEditorDisplaySettings(workspace?.editorDisplay);
        MaweBoot.DATA.workspace = MaweCoreState.waveformEditor.getLayoutData();
        MaweHint.flashHint(`已导入工作区：${file.name}`, 'success');
      } catch (error) {
        MaweHint.flashHint(`工作区导入失败：${error.message || error}`, 'warning');
      }
    });
    if (MaweBoot.SERVER_CONFIG?.settingsUrl) return;  // 服务器版的下拉选择由工作区库接管
    // 单文件编辑器不承诺 file:// 间的浏览器存储；内置工作区与显式文件迁移最可靠。
    let selectedWorkspaceId = workspacePresetSelect?.value || 'wave-right';
    workspacePresetSelect?.addEventListener('change', () => {
      selectedWorkspaceId = workspacePresetSelect.value;
      if (BUILTIN_WORKSPACE_IDS.includes(selectedWorkspaceId)) {
        MaweCoreState.waveformEditor.setLayout(selectedWorkspaceId);
        MaweDisplaySettings.applyEditorDisplaySettings(window.AsrWaveform?.builtinWorkspaces?.[selectedWorkspaceId]?.editorDisplay);
      }
    });
    document.getElementById('layout-edit-toggle')?.addEventListener('click', () => {
      // 拖放编辑只改窗口排列，不改变下拉框当前选中的工作区名称。
      if (workspacePresetSelect) workspacePresetSelect.value = selectedWorkspaceId;
    });
  }

  global.MaweWorkspaces = Object.freeze({
    BUILTIN_WORKSPACE_IDS,
    get currentServerWorkspaceName() { return currentServerWorkspaceName; },
    set currentServerWorkspaceName(v) { currentServerWorkspaceName = v; },
    get currentBuiltinWorkspaceName() { return currentBuiltinWorkspaceName; },
    set currentBuiltinWorkspaceName(v) { currentBuiltinWorkspaceName = v; },
    workspacePresetSelect,
    saveWorkspaceButton,
    saveWorkspaceAsButton,
    deleteWorkspaceButton,
    getSavedServerWorkspaces,
    getSavedPresetWorkspaces,
    presetWorkspaceHasLayout,
    currentWorkspaceDisplayName,
    refreshWorkspaceSelect,
    syncWorkspaceControls,
    restoreWorkspaceSelection,
    updateServerWorkspaceSettings,
    currentWorkspaceNavigation,
    saveWorkspaceNavigation,
    restoreWorkspaceNavigation,
    saveCurrentWorkspace,
    deleteCurrentServerWorkspace,
    applyWorkspaceSelection,
    configureServerWorkspaceLibrary,
    configureWorkspaceTransfer
  });
})(typeof window !== 'undefined' ? window : globalThis);

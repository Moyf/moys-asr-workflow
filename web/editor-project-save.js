// 工程保存：服务器、文件句柄、另存为路径与脏标记清理。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweProjectSave 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweProjectSave(global) {
  'use strict';



  function markProjectSaved(filename, backupName, { silent = false } = {}) {
    MaweBoot.DATA.segments.forEach((segment) => { delete segment._dirty; });
    const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
    delete multi._dirty;
    (multi.tracks || []).forEach((track) => track.segments.forEach((segment) => { delete segment._dirty; }));
    MaweHistory.gapRemoveDirty = false;
    MaweAppearance.previewGeometryDirty = false;
    MaweServerSave.projectImportDirty = false;
    MaweBoot.FILENAME_BASE = filename.replace(/\.(json|mosp)$/i, '');
    const jsonEl = document.getElementById('json-name');
    if (jsonEl) {
      jsonEl.textContent = filename;
      jsonEl.title = `点击复制工程文件名：${filename}`;
      jsonEl.classList.remove('empty');
    }
    renderAll();
    if (!silent) MaweHint.flashHint('保存成功！', 'success');
  }



  async function saveProjectToServer({ silent = false, backupOnly = false } = {}) {
    if (backupOnly && (MaweServerSave.projectFileHandle || !MaweSettings.EDITOR_SETTINGS.projectBackupEnabled)) return false;
    if (!MaweServerSave.serverProjectSavingEnabled()) {
      if (!silent) MaweHint.flashHint('当前服务器未绑定工程；请先导出 .mosp，再重新打开该文件', 'invalid');
      return false;
    }
    if (MaweServerSave.projectSaveInFlight || MaweServerSave.projectCheckpointInFlight) return false;
    if (editingState) finishEdit(true);
    if (extensionEditingState) finishExtensionEdit(true);
    commitCuePanelEdit();
    const projectJson = buildJson();
    MaweServerSave.projectSaveInFlight = true;
    try {
      const saveUrl = new URL(MaweBoot.SERVER_CONFIG.saveUrl, window.location.href);
      const response = await fetch(saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: JSON.parse(projectJson), filename: null,
          backupOnly,
          backupLimit: MaweSettings.EDITOR_SETTINGS.projectBackupEnabled && (backupOnly || !silent)
            ? MaweSettings.EDITOR_SETTINGS.projectBackupLimit : null,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `服务器返回 ${response.status}`);
      }
      if (!backupOnly) markProjectSaved(result.filename, result.backup, { silent });
      return true;
    } catch (error) {
      const detail = error?.message || error;
      MaweServerSave.showProjectSaveError(detail);
      // A stale browser tab can outlive the localhost process (the browser reports
      // ERR_CONNECTION_REFUSED). Offer a real file save so Ctrl+S never strands
      // completed edits, while making clear that the bound JSON was not overwritten.
      if (!silent && error instanceof TypeError
          && confirm('无法连接本地编辑器服务器。是否改为导出工程文件，以免丢失改动？')) {
        const saved = await MaweExportTimeline.downloadFile(projectJson, `${MaweBoot.FILENAME_BASE}.mosp`, 'application/json', {
          desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] }
        });
        if (saved) MaweHint.flashHint('服务器未连接；工程已导出为 .mosp，请重新打开该文件后继续', 'success');
      }
      return false;
    } finally {
      MaweServerSave.projectSaveInFlight = false;
    }
  }



  // 把当前工程写回页面持有的浏览器文件句柄（新建工程 / 另存为选定的目标）。
  async function saveProjectToHandle({ silent = false } = {}) {
    if (!MaweServerSave.projectFileHandle) return false;
    if (MaweServerSave.projectSaveInFlight || MaweServerSave.projectCheckpointInFlight) return false;
    if (editingState) finishEdit(true);
    if (extensionEditingState) finishExtensionEdit(true);
    commitCuePanelEdit();
    const projectJson = buildJson();
    MaweServerSave.projectSaveInFlight = true;
    try {
      const writable = await MaweServerSave.projectFileHandle.createWritable();
      await writable.write(new Blob([projectJson], { type: 'application/json;charset=utf-8' }));
      await writable.close();
      markProjectSaved(MaweServerSave.projectFileHandle.name, null, { silent });
      return true;
    } catch (error) {
      MaweHint.flashHint(`保存失败：${error?.message || error}`, 'warning');
      return false;
    } finally {
      MaweServerSave.projectSaveInFlight = false;
    }
  }



  // 统一保存入口：句柄目标优先（最近一次新建/另存为选定的文件），否则写回服务器绑定工程。
  async function saveCurrentProject({ silent = false } = {}) {
    if (MaweServerSave.projectFileHandle) return saveProjectToHandle({ silent });
    return saveProjectToServer({ silent });
  }



  // 另存为：打开系统文件浏览对话框把工程文件保存到用户选择的位置。
  // 与「导出工程」的区别：保存成功后当前工程名跟随新文件（标题、导出默认名随之更新），
  // 且后续 Ctrl(Cmd)+S / 自动保存都写回这个新选定的文件。
  async function saveProjectAsToFile() {
    if (editingState) finishEdit(true);
    if (extensionEditingState) finishExtensionEdit(true);
    commitCuePanelEdit();
    const suggested = `${MaweBoot.FILENAME_BASE}.mosp`;
    // 无原生保存对话框的浏览器：退化为普通下载（文件名不可考，标题保持不变）。
    if (!window.showSaveFilePicker) {
      await MaweExportTimeline.downloadFile(buildJson(), suggested, 'application/json', {
        desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] }
      });
      return;
    }
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'MOSE 工程文件', accept: { 'application/json': ['.mosp', '.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([buildJson()], { type: 'application/json;charset=utf-8' }));
      await writable.close();
      MaweServerSave.projectFileHandle = handle;
      markProjectSaved(handle.name, null);
      MaweServerSave.configureServerSaveControls();
      MaweServerSave.scheduleAutoSave();
    } catch (error) {
      if (error && error.name === 'AbortError') return;  // 用户取消保存对话框
      MaweHint.flashHint(`保存失败：${error?.message || error}`, 'warning');
    }
  }



  const mediaNameEl = document.getElementById('media-name');



  const jsonNameEl = document.getElementById('json-name');



  function translatedEditorText(text) {
    return window.MAWE_I18N?.translateText?.(text) || text;
  }

  global.MaweProjectSave = Object.freeze({
    markProjectSaved,
    saveProjectToServer,
    saveProjectToHandle,
    saveCurrentProject,
    saveProjectAsToFile,
    mediaNameEl,
    jsonNameEl,
    translatedEditorText
  });
})(typeof window !== 'undefined' ? window : globalThis);

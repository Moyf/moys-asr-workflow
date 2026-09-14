// 工程保存：服务器、文件句柄、另存为路径与脏标记清理。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweProjectSave 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweProjectSave(global) {
  'use strict';



function projectSaveFingerprint() {
return JSON.stringify([MaweBoot.DATA.segments, MaweBoot.DATA.multi_subtitle, MaweBoot.DATA.gap_remove,
MaweBoot.DATA.preview, MaweHistory.gapRemoveDirty, MaweAppearance.previewGeometryDirty, MaweServerSave.projectImportDirty]);
}

function inlineEditHasUncommittedText() {
const state = editingState || extensionEditingState;
if (!state) return false;
const segment = editingState ? MaweBoot.DATA.segments[state.idx]
: MaweMultiSubtitleCore.getExtensionTrack(state.trackId)?.segments[state.index];
return Boolean(segment && state.textEl.innerText.replace(/\r\n?/g, '\n').trimEnd() !== segment.text);
}

// 保存正在输入的文字，但不结束行内编辑、不替换节点、不移动光标。
function flushInlineEditsForSave() {
const state = editingState || extensionEditingState;
if (!state) {
if (!MaweDom.cuePanel?.contains(document.activeElement)) commitCuePanelEdit();
return;
}
const extension = Boolean(extensionEditingState);
const index = extension ? state.index : state.idx;
const track = extension ? MaweMultiSubtitleCore.getExtensionTrack(state.trackId) : null;
const segment = extension ? track?.segments[index] : MaweBoot.DATA.segments[index];
const text = state.textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
if (!segment || text === segment.text) return;
MaweHistory.pushUndo(extension ? '编辑副字幕' : '编辑文本');
segment.text = text;
segment._dirty = true;
state.original = text;
state.el.classList.add('dirty');
if (extension) {
MaweMultiSubtitleCore.markMultiSubtitleDirty();
MaweCoreState.waveformEditor?.refreshExtensionCueLabel(index, state.trackId);
} else MaweCoreState.waveformEditor?.refreshCueLabel(index);
syncCuePanelAfterInlineEdit(extension ? 'extension' : 'main', index, state.trackId);
}

function markProjectSaved(filename, backupName, { silent = false, fingerprint = null } = {}) {
// 请求在途时的新编辑继续保持脏状态，失败请求从不进入这里。
const unchanged = !inlineEditHasUncommittedText()
&& (fingerprint === null || fingerprint === projectSaveFingerprint());
const multi = MaweMultiSubtitleCore.getMultiSubtitleState();
if (unchanged) {
MaweBoot.DATA.segments.forEach((segment) => { delete segment._dirty; });
delete multi._dirty;
(multi.tracks || []).forEach((track) => track.segments.forEach((segment) => { delete segment._dirty; }));
MaweHistory.gapRemoveDirty = false;
MaweAppearance.previewGeometryDirty = false;
MaweServerSave.projectImportDirty = false;
MaweCoreState.container.querySelectorAll('.dirty').forEach(element => element.classList.remove('dirty'));
}
PROJECT_NAME = filename.replace(/\.(json|mosp)$/i, '');
MaweBoot.FILENAME_BASE = PROJECT_NAME;
const jsonEl = document.getElementById('json-name');
if (jsonEl) {
jsonEl.textContent = filename;
jsonEl.title = `点击复制工程文件名：${filename}`;
jsonEl.classList.remove('empty');
}
if (!silent) MaweHint.flashHint('保存成功！', 'success');
}



  async function saveProjectToServer({ silent = false, backupOnly = false } = {}) {
    if (backupOnly && (MaweServerSave.projectFileHandle || !MaweSettings.EDITOR_SETTINGS.projectBackupEnabled)) return false;
    if (!MaweServerSave.serverProjectSavingEnabled()) {
      if (!silent) MaweHint.flashHint('当前服务器未绑定工程；请先导出 .mosp，再重新打开该文件', 'invalid');
      return false;
    }
if (MaweServerSave.projectSaveInFlight || MaweServerSave.projectCheckpointInFlight) return false;
flushInlineEditsForSave();
const projectJson = MaweJsonRepair.buildJson();
const fingerprint = projectSaveFingerprint();
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
      if (!backupOnly) markProjectSaved(result.filename, result.backup, { silent, fingerprint });
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
flushInlineEditsForSave();
const projectJson = MaweJsonRepair.buildJson();
const fingerprint = projectSaveFingerprint();
MaweServerSave.projectSaveInFlight = true;
try {
const writable = await MaweServerSave.projectFileHandle.createWritable();
await writable.write(new Blob([projectJson], { type: 'application/json;charset=utf-8' }));
await writable.close();
markProjectSaved(MaweServerSave.projectFileHandle.name, null, { silent, fingerprint });
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
      await MaweExportTimeline.downloadFile(MaweJsonRepair.buildJson(), suggested, 'application/json', {
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
      await writable.write(new Blob([MaweJsonRepair.buildJson()], { type: 'application/json;charset=utf-8' }));
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
inlineEditHasUncommittedText,
mediaNameEl,
jsonNameEl,
translatedEditorText
});
})(typeof window !== 'undefined' ? window : globalThis);

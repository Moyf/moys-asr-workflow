// 工程保存：服务器、文件句柄、另存为路径与脏标记清理。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweProjectSave 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweProjectSave(global) {
  'use strict';



  function projectSaveFingerprint() {
    return JSON.stringify([MaweBoot.DATA.segments, MaweBoot.DATA.multi_subtitle, MaweBoot.DATA.overlay_track, MaweBoot.DATA.gap_remove,
      MaweBoot.DATA.markers, MaweBoot.DATA.timed_text_edit_view === 'single' ? 'single' : 'rows',
      MaweBoot.DATA.preview, MaweBoot.DATA.media_metadata, MaweBoot.DATA.audio_processing, MaweHistory.gapRemoveDirty, MaweAppearance.previewGeometryDirty, MaweServerSave.projectImportDirty]);
  }

function inlineEditHasUncommittedText() {
const state = MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState;
if (!state) return false;
const segment = MaweInlineEdit.editingState ? MaweBoot.DATA.segments[state.idx]
: MaweMultiSubtitleCore.getExtensionTrack(state.trackId)?.segments[state.index];
return Boolean(segment && state.textEl.innerText.replace(/\r\n?/g, '\n').trimEnd() !== segment.text);
}

// 保存正在输入的文字，但不结束行内编辑、不替换节点、不移动光标。
function flushInlineEditsForSave() {
const state = MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState;
if (!state) {
if (!MaweDom.cuePanel?.contains(document.activeElement)) MaweCuePanel.commitCuePanelEdit();
else {
// Live panel text is already in the project, but timed labels are deferred until
// commit. Sync them before replacing the snapshot, while keeping the caret intact.
const target = MaweCuePanel.getCurrentCuePanelTarget();
const snapshot = MaweCuePanelState.cuePanelTextEditSnapshot;
if (target?.kind === 'main' && snapshot?.kind === target.kind
    && snapshot.index === target.index && snapshot.trackId === target.trackId
    && target.segment.text !== snapshot.text) {
MaweWordTiming.syncTextChange(target.segment, snapshot.text);
MaweViewUpdates.invalidate({ waveform: 'overlay', preview: 'update' });
}
// Finalize the current transaction; subsequent typing begins a new one.
MaweCuePanelState.resetCuePanelEditState();
MaweCuePanel.captureCuePanelTextEditSnapshot();
}
return;
}
const extension = Boolean(MaweInlineEdit.extensionEditingState);
const index = extension ? state.index : state.idx;
const track = extension ? MaweMultiSubtitleCore.getExtensionTrack(state.trackId) : null;
const segment = extension ? track?.segments[index] : MaweBoot.DATA.segments[index];
const text = state.textEl.innerText.replace(/\r\n?/g, '\n').trimEnd();
if (!segment || text === segment.text) return;
return MaweCommands.run(extension ? '编辑副字幕' : '编辑文本', () => {
  segment.text = text;
  segment._dirty = true;
  state.original = text;
  state.el.classList.add('dirty');
  if (extension) {
  MaweMultiSubtitleCore.markMultiSubtitleDirty();
  MaweCoreState.waveformEditor?.refreshExtensionCueLabel(index, state.trackId);
  } else MaweCoreState.waveformEditor?.refreshCueLabel(index);
  MaweInlineEdit.syncCuePanelAfterInlineEdit(extension ? 'extension' : 'main', index, state.trackId);
});
}

function markProjectSaved(filename, backupName, { silent = false, fingerprint = null, contentFingerprint } = {}) {
// 请求在途时的新编辑继续保持脏状态，失败请求从不进入这里。
const unchanged = !inlineEditHasUncommittedText()
&& (fingerprint === null || fingerprint === projectSaveFingerprint());
MaweState.noteSavedSegments(contentFingerprint);
if (unchanged) {
MaweState.markSaved();
MaweCoreState.container.querySelectorAll('.dirty').forEach(element => element.classList.remove('dirty'));
}
MaweBoot.PROJECT_NAME = filename.replace(/\.(json|mosp)$/i, '');
MaweBoot.FILENAME_BASE = MaweBoot.PROJECT_NAME;
const jsonEl = document.getElementById('json-name');
if (jsonEl) {
jsonEl.textContent = filename;
jsonEl.title = `点击复制工程文件名：${filename}`;
jsonEl.classList.remove('empty');
}
updateProjectDirtyIndicator();
if (!silent) MaweHint.flashHint('保存成功！', 'success');
}

// 工程「未保存」指示：右上角文件名前加琥珀色圆点（CSS ::before，不进 textContent，
// 不影响点击复制），title 提示有未保存的修改。#json-name 在 i18n 的属性跳过名单里，
// title 需在此处按当前语言手动翻译；调用方为 markProjectDirty 事件回调（即时）、
// 保存完成的直接刷新与 O(1) 轮询兜底（见文件底部），回调内部按当前工程状态整体重算。
function updateProjectDirtyIndicator() {
const jsonEl = document.getElementById('json-name');
if (!jsonEl || jsonEl.classList.contains('empty')) return;
const dirty = Boolean(MaweServerSave?.hasUnsavedProjectChanges?.());
jsonEl.classList.toggle('dirty', dirty);
const filename = String(jsonEl.textContent || '').trim();
if (!filename) return;
const text = dirty ? `有未保存的修改；点击复制工程文件名：${filename}` : `点击复制工程文件名：${filename}`;
jsonEl.title = window.MAWE_I18N?.translateText?.(text) || text;
}



  async function saveProjectToServer({ silent = false, backupOnly = false } = {}) {
    const epoch = MaweProjectLoad.projectBindingEpoch;
    const generation = MaweState.projectLoadGeneration;
    const current = () => epoch === MaweProjectLoad.projectBindingEpoch && generation === MaweState.projectLoadGeneration;
    if (MaweState.projectLoadPending) return false;
    if (backupOnly && (MaweServerSave.projectFileHandle || !MaweSettings.EDITOR_SETTINGS.projectBackupEnabled)) return false;
    if (!MaweServerSave.serverProjectSavingEnabled()) {
      if (!silent) MaweHint.flashHint('当前服务器未绑定工程；请先导出 .mosp，再重新打开该文件', 'invalid');
      return false;
    }
if (MaweServerSave.projectSaveInFlight || MaweServerSave.projectCheckpointInFlight) return false;
flushInlineEditsForSave();
const projectJson = MaweJsonRepair.buildJson();
const fingerprint = projectSaveFingerprint();
const contentFingerprint = MaweState.segmentsFingerprint();
MaweServerSave.projectSaveInFlight = true;
try {
const saveUrl = MaweBoot.SERVER_CONFIG.saveUrl;
      const response = await MaweHost.server.fetch(saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: JSON.parse(projectJson), filename: null,
          bindingGeneration: MaweBoot.SERVER_CONFIG.bindingGeneration,
          sourceMediaId: MaweBoot.SERVER_CONFIG.sourceMediaId,
          backupOnly,
          backupLimit: MaweSettings.EDITOR_SETTINGS.projectBackupEnabled && (backupOnly || !silent)
            ? MaweSettings.EDITOR_SETTINGS.projectBackupLimit : null,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `服务器返回 ${response.status}`);
      }
      if (!current()) return false;
      if (!backupOnly) markProjectSaved(result.filename, result.backup, { silent, fingerprint, contentFingerprint });
      return true;
    } catch (error) {
      if (!current()) return false;
      const detail = error?.message || error;
      MaweServerSave.showProjectSaveError(detail);
      // A stale browser tab can outlive the localhost process (the browser reports
      // ERR_CONNECTION_REFUSED). Offer a real file save so Ctrl+S never strands
      // completed edits, while making clear that the bound JSON was not overwritten.
      if (!silent && error instanceof TypeError
          && confirm('无法连接本地编辑器服务器。是否改为导出工程文件，以免丢失改动？')) {
        const saved = await MaweExportTimeline.downloadFile(MaweJsonRepair.buildJson({ forFileExport: true }), `${MaweBoot.FILENAME_BASE}.mosp`, 'application/json', {
          desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] }
        });
        if (saved && current()) MaweHint.flashHint('服务器未连接；工程已导出为 .mosp，请重新打开该文件后继续', 'success');
      }
      return false;
    } finally {
      MaweServerSave.projectSaveInFlight = false;
    }
  }



  // 把当前工程写回页面持有的浏览器文件句柄（新建工程 / 另存为选定的目标）。
  async function saveProjectToHandle({ silent = false } = {}) {
    const epoch = MaweProjectLoad.projectBindingEpoch;
    const generation = MaweState.projectLoadGeneration;
    const current = () => epoch === MaweProjectLoad.projectBindingEpoch && generation === MaweState.projectLoadGeneration;
    if (MaweState.projectLoadPending) return false;
    if (!MaweServerSave.projectFileHandle) return false;
if (MaweServerSave.projectSaveInFlight || MaweServerSave.projectCheckpointInFlight) return false;
flushInlineEditsForSave();
const projectJson = MaweJsonRepair.buildJson({ forFileExport: true });
const fingerprint = projectSaveFingerprint();
const contentFingerprint = MaweState.segmentsFingerprint();
MaweServerSave.projectSaveInFlight = true;
try {
const handle = MaweServerSave.projectFileHandle;
await MaweHost.files.writeBlob(handle, () => new Blob([projectJson], { type: 'application/json;charset=utf-8' }));
if (!current() || handle !== MaweServerSave.projectFileHandle) return false;
markProjectSaved(handle.name, null, { silent, fingerprint, contentFingerprint });
      return true;
    } catch (error) {
      if (!current()) return false;
      MaweHint.flashHint(`保存失败：${error?.message || error}`, 'warning');
      return false;
    } finally {
      MaweServerSave.projectSaveInFlight = false;
    }
  }



  // 统一保存入口：句柄目标优先（最近一次新建/另存为选定的文件），否则写回服务器绑定工程。
  async function saveCurrentProject({ silent = false } = {}) {
    if (MaweState.projectLoadPending) return false;
    // A pointer preview is not committed subtitle truth. Timed autosave waits;
    // an explicit save first finishes this one history transaction.
    if (global.MaweAssCuePosition?.dragging) {
      if (silent) return false;
      global.MaweAssCuePosition.commitDrag();
    }
    if (MaweServerSave.projectFileHandle) return saveProjectToHandle({ silent });
    return saveProjectToServer({ silent });
  }



  // 另存为：打开系统文件浏览对话框把工程文件保存到用户选择的位置。
  // 与「导出工程」的区别：保存成功后当前工程名跟随新文件（标题、导出默认名随之更新），
  // 且后续 Ctrl(Cmd)+S / 自动保存都写回这个新选定的文件。
  async function saveProjectAsToFile() {
    const epoch = MaweProjectLoad.projectBindingEpoch;
    const generation = MaweState.projectLoadGeneration;
    const current = () => epoch === MaweProjectLoad.projectBindingEpoch && generation === MaweState.projectLoadGeneration;
    if (MaweState.projectLoadPending) return false;
    if (MaweInlineEdit.editingState) MaweInlineEdit.finishEdit(true);
    if (MaweInlineEdit.extensionEditingState) MaweInlineEdit.finishExtensionEdit(true);
    MaweCuePanel.commitCuePanelEdit();
    const suggested = `${MaweBoot.FILENAME_BASE}.mosp`;
    // 无原生保存对话框的浏览器：退化为普通下载（文件名不可考，标题保持不变）。
    if (!MaweHost.files.hasSavePicker()) {
      await MaweExportTimeline.downloadFile(MaweJsonRepair.buildJson({ forFileExport: true }), suggested, 'application/json', {
        desc: 'MOSE 工程文件', types: { 'application/json': ['.mosp', '.json'] }
      });
      return;
    }
    try {
      const handle = await MaweHost.files.pickSaveFile({
        suggestedName: suggested,
        types: [{ description: 'MOSE 工程文件', accept: { 'application/json': ['.mosp', '.json'] } }],
      });
      if (!current()) return false;
      let fingerprint, contentFingerprint;
      await MaweHost.files.writeBlob(handle, () => {
        if (!current()) throw new DOMException('工程已切换', 'AbortError');
        flushInlineEditsForSave();
        const projectJson = MaweJsonRepair.buildJson({ forFileExport: true });
        fingerprint = projectSaveFingerprint();
        contentFingerprint = MaweState.segmentsFingerprint();
        return new Blob([projectJson], { type: 'application/json;charset=utf-8' });
      });
      if (!current()) return false;
      MaweServerSave.projectFileHandle = handle;
      markProjectSaved(handle.name, null, { fingerprint, contentFingerprint });
      MaweServerSave.configureServerSaveControls();
      MaweServerSave.scheduleAutoSave();
    } catch (error) {
      if (!current()) return false;
      if (error && error.name === 'AbortError') return;  // 用户取消保存对话框
      MaweHint.flashHint(`保存失败：${error?.message || error}`, 'warning');
    }
  }



  const mediaNameEl = document.getElementById('media-name');



  const jsonNameEl = document.getElementById('json-name');



  function translatedEditorText(text) {
    return window.MAWE_I18N?.translateText?.(text) || text;
  }

  // 脏态指示：事件驱动 + O(1) 轮询兜底 + 语言切换重译标题。dirty 事件由
  // editor-state 的 markProjectDirty() 触发（changes 标志与各编辑路径收口），
  // 保存完成走 markProjectSaved 的直接刷新（清洁态即时）。轮询只比较
  // projectDirtyEpoch（O(1) 自愈），绝不在此做 hasProjectChanges 的 O(N) 扫描；
  // 指纹等重判定只允许出现在事件回调驱动的 updateProjectDirtyIndicator 里。
  // 仅浏览器页面环境启动（vm 单测环境无定时器/document 事件全局，恢复/保存
  // 流程测试不依赖；编辑器页面常驻，无需清除）。
  if (typeof window !== 'undefined' && typeof MaweState?.onProjectDirtyChange === 'function') {
    MaweState.onProjectDirtyChange(() => updateProjectDirtyIndicator());
  }
  if (typeof window !== 'undefined' && typeof window.setInterval === 'function'
      && typeof MaweState?.getProjectDirtyEpoch === 'function') {
    let lastSeenDirtyEpoch = MaweState.getProjectDirtyEpoch();
    window.setInterval(() => {
      const epoch = MaweState.getProjectDirtyEpoch();
      if (epoch === lastSeenDirtyEpoch) return;
      lastSeenDirtyEpoch = epoch;
      updateProjectDirtyIndicator();
    }, 1000);
    document.addEventListener('mawe:languagechange', updateProjectDirtyIndicator);
  }

global.MaweProjectSave = Object.freeze({
markProjectSaved,
saveProjectToServer,
saveProjectToHandle,
saveCurrentProject,
saveProjectAsToFile,
inlineEditHasUncommittedText,
updateProjectDirtyIndicator,
mediaNameEl,
jsonNameEl,
translatedEditorText
});
})(typeof window !== 'undefined' ? window : globalThis);

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const projectOpenListeners = new Set();
const projectStatusListeners = new Set();
const closeRequestListeners = new Set();
const exportResultListeners = new Set();

contextBridge.exposeInMainWorld('MOSEDesktop', Object.freeze({
  available: true,
  chooseFile: (kind, language) => ipcRenderer.invoke('mose:choose-file', kind, language),
  chooseDirectory: (language) => ipcRenderer.invoke('mose:choose-directory', language),
  registerFile(file, kind = 'any') {
    let filePath = '';
    try {
      filePath = webUtils.getPathForFile(file);
    } catch {
      // Synthetic/virtual Files intentionally remain content-only imports.
    }
    if (!filePath) {
      return Promise.resolve({
        status: 'error',
        error: { code: 'NO_NATIVE_PATH', message: '此文件没有可用的本机路径' },
      });
    }
    return ipcRenderer.invoke('mose:register-file', filePath, kind);
  },
  command: (name, payload) => ipcRenderer.invoke('mose:desktop-command', name, payload),
  chooseCloseAction: (requestId, hasUnsavedChanges, language) => ipcRenderer.invoke(
    'mose:choose-close-action', requestId, hasUnsavedChanges === true, language,
  ),
  chooseProjectSwitchAction: (hasUnsavedChanges, language) => ipcRenderer.invoke(
    'mose:choose-switch-action', hasUnsavedChanges === true, language,
  ),
  chooseExternalChangeAction: (hasUnsavedChanges, language) => ipcRenderer.invoke(
    'mose:choose-external-change-action', hasUnsavedChanges === true, language,
  ),
  confirmExternalReload: (hasUnsavedChanges, language) => ipcRenderer.invoke(
    'mose:confirm-external-reload', hasUnsavedChanges === true, language,
  ),
  confirmClose: (requestId, accepted) => ipcRenderer.invoke(
    'mose:confirm-close', requestId, accepted === true,
  ),
  state: () => ipcRenderer.invoke('mose:state'),
  onProjectOpen(listener) {
    if (typeof listener !== 'function') return () => {};
    projectOpenListeners.add(listener);
    return () => projectOpenListeners.delete(listener);
  },
  onProjectStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    projectStatusListeners.add(listener);
    return () => projectStatusListeners.delete(listener);
  },
  onCloseRequest(listener) {
    if (typeof listener !== 'function') return () => {};
    closeRequestListeners.add(listener);
    return () => closeRequestListeners.delete(listener);
  },
  onExportResult(listener) {
    if (typeof listener !== 'function') return () => {};
    exportResultListeners.add(listener);
    return () => exportResultListeners.delete(listener);
  },
}));

ipcRenderer.on('mose-open-project', (_event, file) => {
  for (const listener of projectOpenListeners) listener({ status: 'ok', file });
});

ipcRenderer.on('mose-project-status', (_event, status) => {
  for (const listener of projectStatusListeners) listener(status);
});

ipcRenderer.on('mose-close-request', (_event, request) => {
  for (const listener of closeRequestListeners) listener(request);
});

ipcRenderer.on('mose-export-result', (_event, result) => {
  for (const listener of exportResultListeners) listener(result);
});

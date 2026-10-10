'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function forwardProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath) return;
  window.postMessage({ source: 'mose-desktop', type: 'open-project', path: projectPath }, window.location.origin);
}

function preferenceOperation(operation, key, value) {
  const result = ipcRenderer.sendSync('mose:storage', { operation, key, value });
  if (!result?.ok) throw new Error(result?.error || '桌面偏好不可用。');
  return result.value;
}

contextBridge.exposeInMainWorld('MOSEDesktop', Object.freeze({
  available: true,
  storage: Object.freeze({
    getItem: (key) => preferenceOperation('get', key),
    setItem: (key, value) => preferenceOperation('set', key, String(value)),
  }),
  chooseProject: () => ipcRenderer.invoke('mose:choose-project'),
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  chooseMedia: () => ipcRenderer.invoke('mose:choose-media'),
  chooseDirectory: () => ipcRenderer.invoke('mose:choose-directory'),
  saveProjectAs: (payload) => ipcRenderer.invoke('mose:save-project-as', payload),
  loadMedia: (payload) => ipcRenderer.invoke('mose:load-media', payload),
  commitMedia: (ticket) => ipcRenderer.invoke('mose:commit-media', ticket),
  revealProject: () => ipcRenderer.invoke('mose:reveal-project'),
  state: () => ipcRenderer.invoke('mose:state'),
}));

ipcRenderer.on('mose-open-project', (_event, projectPath) => forwardProjectPath(projectPath));

ipcRenderer.on('mose-command', (_event, id) => {
  window.postMessage({ source: 'mose-desktop', type: 'command', id }, window.location.origin);
});

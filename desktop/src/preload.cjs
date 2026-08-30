'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function forwardProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath) return;
  window.postMessage({ source: 'mose-desktop', type: 'open-project', path: projectPath }, window.location.origin);
}

contextBridge.exposeInMainWorld('MOSEDesktop', Object.freeze({
  available: true,
  chooseProject: () => ipcRenderer.invoke('mose:choose-project'),
  state: () => ipcRenderer.invoke('mose:state'),
}));

ipcRenderer.on('mose-open-project', (_event, projectPath) => forwardProjectPath(projectPath));

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('#open-project') : null;
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void ipcRenderer.invoke('mose:choose-project').then(forwardProjectPath);
  }, true);
});

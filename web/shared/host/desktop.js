// Electron-only file/path capabilities. The browser host remains a harmless
// unavailable stub, so normal Server and portable HTML never depend on MOSE.
export function createDesktop(dependencies) {
  'use strict';
  const bridge = dependencies?.bridge;
  const unavailable = () => ({
    status: 'error',
    error: { code: 'DESKTOP_UNAVAILABLE', message: '此功能仅在 MOSE 桌面版可用' },
  });
  return Object.freeze({
    available: () => Boolean(bridge?.available),
    chooseFile: (kind, language) => bridge?.available ? bridge.chooseFile(kind, language) : Promise.resolve(unavailable()),
    chooseDirectory: (language) => bridge?.available ? bridge.chooseDirectory(language) : Promise.resolve(unavailable()),
    registerFile: (file, kind) => bridge?.available
      ? bridge.registerFile(file, kind) : Promise.resolve(unavailable()),
    command: (name, payload) => bridge?.available
      ? bridge.command(name, payload) : Promise.resolve(unavailable()),
    chooseCloseAction: (requestId, hasUnsavedChanges, language) => bridge?.available
      ? bridge.chooseCloseAction(requestId, hasUnsavedChanges, language) : Promise.resolve({ status: 'cancelled' }),
    chooseProjectSwitchAction: (hasUnsavedChanges, language) => bridge?.available
      ? bridge.chooseProjectSwitchAction(hasUnsavedChanges, language) : Promise.resolve({ status: 'cancelled' }),
    chooseExternalChangeAction: (hasUnsavedChanges, language) => bridge?.available
      ? bridge.chooseExternalChangeAction(hasUnsavedChanges, language) : Promise.resolve({ status: 'cancelled' }),
    confirmExternalReload: (hasUnsavedChanges, language) => bridge?.available
      ? bridge.confirmExternalReload(hasUnsavedChanges, language) : Promise.resolve({ status: 'cancelled' }),
    confirmClose: (requestId, accepted) => bridge?.available
      ? bridge.confirmClose(requestId, accepted) : Promise.resolve({ status: 'cancelled' }),
    onProjectOpen: (listener) => bridge?.available
      ? bridge.onProjectOpen(listener) : (() => {}),
    onProjectStatus: (listener) => bridge?.available
      ? bridge.onProjectStatus(listener) : (() => {}),
    onCloseRequest: (listener) => bridge?.available
      ? bridge.onCloseRequest(listener) : (() => {}),
    onExportResult: (listener) => bridge?.available
      ? bridge.onExportResult(listener) : (() => {}),
  });
}
